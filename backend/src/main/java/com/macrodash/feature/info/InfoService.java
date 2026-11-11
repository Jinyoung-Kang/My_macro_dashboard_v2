package com.macrodash.feature.info;

import com.macrodash.Kst;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.InfoStore;
import com.macrodash.store.InfoStore.Item;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 정보 수집 화면(모의매매 &gt; 정보 수집, ADR 0035) — 수집기가 받아 둔 글·스냅샷·출처 판정을 <b>읽기만</b> 합니다.
 *
 * <p>스냅샷은 {@link StoreReader#readStored}로만 읽습니다 — 화면 조회가 수집을 요청하면 그 출처의 비주기 일정과 하루 예산을 건너뜁니다(ADR 0026).
 * Claude 결정 패킷은 이 자료를 읽지 않습니다(ADR 0035 결정 9).
 */
@Service
public class InfoService {

    static final int DEFAULT_LIMIT = 40;
    static final int MAX_LIMIT = 100;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{24}");
    private static final List<String> CATEGORIES = List.of(InfoSources.BLOG, InfoSources.WAEDGE);

    private final InfoStore store;
    private final StoreReader reader;
    private final Clock clock;

    @Autowired
    public InfoService(InfoStore store, StoreReader reader) {
        this(store, reader, Clock.systemUTC());
    }

    InfoService(InfoStore store, StoreReader reader, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.clock = clock;
    }

    /**
     * 글 목록(최근부터, 본문 없이).
     *
     * @param category blog·waedge(비면 전부)
     * @param source   출처 키 하나(비면 분류 전체)
     * @param before   다음 쪽 — 앞 쪽의 {@code next} 값(ISO 시각)
     */
    public Map<String, Object> items(String category, String source, String query, String before, Integer limit) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!store.ready()) {
            out.put("available", false);
            out.put("items", List.of());
            return out;
        }
        List<String> sources = new ArrayList<>();
        if (source != null && !source.isBlank()) {
            sources.add(source.strip());
        } else if (category != null && !category.isBlank()) {
            if (!CATEGORIES.contains(category)) {
                throw new InvalidRequestException("category는 " + CATEGORIES + " 가운데 하나입니다");
            }
            sources.addAll(InfoSources.keysOf(category));
            if (InfoSources.WAEDGE.equals(category)) {
                sources.remove("waedge.blogs");       // 한국어 제목만 있는 원문 블로그 글은 블로그 탭에
            } else {
                sources.add("waedge.blogs");
            }
        }
        int size = limit == null ? DEFAULT_LIMIT : Math.max(1, Math.min(limit, MAX_LIMIT));
        Instant cursor = parseInstant(before);
        List<Item> rows = store.items(sources, query, cursor, size);
        out.put("available", true);
        out.put("items", rows.stream().map(item -> itemJson(item, false)).toList());
        Item last = rows.isEmpty() ? null : rows.get(rows.size() - 1);
        out.put("next", rows.size() < size || last == null ? null
                : (last.publishedAt() != null ? last.publishedAt() : last.firstSeenAt()).toString());
        return out;
    }

    /** 글 한 편(본문 포함). 없으면 {@code found: false}. */
    public Map<String, Object> item(String id) {
        if (id == null || !ID.matcher(id).matches()) {
            throw new InvalidRequestException("글 id 형식이 아닙니다");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Item> item = store.ready() ? store.item(id) : Optional.empty();
        out.put("found", item.isPresent());
        item.ifPresent(found -> out.put("item", itemJson(found, true)));
        return out;
    }

    /** 출처별 상태(판정·글 수·끊김)와 지금 끊긴 출처 목록 — 화면 맨 위의 출처 상태와 모든 화면의 안내 띠가 씁니다. */
    public Map<String, Object> sources() {
        Instant now = clock.instant();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkedAt", Kst.stamp(now));
        if (!store.ready()) {
            out.put("available", false);
            out.put("sources", List.of());
            out.put("incidents", List.of());
            return out;
        }
        Map<String, InfoStore.SourceState> states = store.states().stream()
                .collect(Collectors.toMap(InfoStore.SourceState::task, Function.identity(), (a, b) -> a, LinkedHashMap::new));
        Map<String, InfoStore.SourceCount> counts = store.counts().stream()
                .collect(Collectors.toMap(InfoStore.SourceCount::source, Function.identity()));
        List<SourceIncidents.Incident> incidents = SourceIncidents.build(List.copyOf(states.values()), now);
        Map<String, SourceIncidents.Incident> byTask = incidents.stream()
                .collect(Collectors.toMap(SourceIncidents.Incident::task, Function.identity(), (a, b) -> a));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (InfoSources.Source source : InfoSources.ALL) {
            InfoStore.SourceState state = states.get(source.task());
            InfoStore.SourceCount count = counts.get(source.key());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("task", source.task());
            row.put("key", source.key());
            row.put("label", source.label());
            row.put("category", source.category());
            row.put("siteUrl", source.siteUrl());
            row.put("status", state == null ? null : state.status());
            row.put("streak", state == null ? null : state.streak());
            row.put("reason", state == null ? null : state.reason());
            row.put("lastOkAt", state == null || state.lastOkAt() == null ? null : Kst.stamp(state.lastOkAt()));
            row.put("lastRunAt", state == null ? null : Kst.stamp(state.lastRunAt()));
            row.put("items", count == null ? 0 : count.items());
            row.put("latestItemAt", count == null || count.latest() == null ? null : Kst.stamp(count.latest()));
            SourceIncidents.Incident incident = byTask.get(source.task());
            row.put("incident", incident == null ? null : incidentJson(incident));
            rows.add(row);
        }
        out.put("available", true);
        out.put("recorded", !states.isEmpty());
        out.put("sources", rows);
        out.put("incidents", incidents.stream().map(InfoService::incidentJson).toList());
        return out;
    }

    /** 네이버 투자자별 매매동향·매매상위 저장본(수집기가 만든 모양 그대로 — 없는 값은 null). */
    public Map<String, Object> flows() {
        return snapshot(Datasets.SNAP_INFO_NAVER_FLOWS, "trend", "rankings", "failed", "sourceUrls", "unit");
    }

    /** waedge 거장 견해 저장본. */
    public Map<String, Object> gurus() {
        return snapshot(Datasets.SNAP_INFO_WAEDGE_GURUS, "gurus", "counts", "asOf", "sourceUrl");
    }

    private Map<String, Object> snapshot(String name, String... fields) {
        Optional<Snapshot> snapshot = reader.readStored(name);
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode payload = snapshot.map(Snapshot::payload).orElse(null);
        if (payload == null || !payload.isObject()) {
            out.put("available", false);
            return out;
        }
        out.put("available", true);
        snapshot.get().putFreshness(out);
        out.put("source", payload.path("source").asText(null));
        out.put("fetchTier", payload.path("fetchTier").asText(null));
        for (String field : fields) {
            out.put(field, payload.get(field));
        }
        return out;
    }

    static Map<String, Object> incidentJson(SourceIncidents.Incident incident) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("key", incident.key());
        out.put("task", incident.task());
        out.put("label", incident.label());
        out.put("kind", incident.kind());
        out.put("kindLabel", incident.kindLabel());
        out.put("reason", incident.reason());
        out.put("since", incident.since() == null ? null : Kst.stamp(incident.since()));
        return out;
    }

    private static Map<String, Object> itemJson(Item item, boolean withBody) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", item.id());
        out.put("source", item.source());
        out.put("sourceLabel", InfoSources.byKey(item.source()).map(InfoSources.Source::label)
                .orElse(item.meta() != null && item.meta().hasNonNull("waedgeBlog") ? item.meta().get("waedgeBlog").asText() : item.source()));
        out.put("kind", item.kind());
        out.put("url", item.url());
        out.put("title", item.title());
        out.put("titleKo", item.titleKo());
        out.put("author", item.author());
        out.put("publishedAt", item.publishedAt() == null ? null : Kst.stamp(item.publishedAt()));
        out.put("firstSeenAt", Kst.stamp(item.firstSeenAt()));
        out.put("summary", item.summary());
        out.put("bodyStatus", item.bodyStatus());
        out.put("fetchTier", item.fetchTier());
        out.put("category", item.meta() == null ? null : item.meta().path("category").asText(null));
        if (withBody) {
            out.put("body", item.body());
        }
        return out;
    }

    private static Instant parseInstant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw new InvalidRequestException("before는 ISO 시각입니다(앞 쪽 응답의 next)");
        }
    }
}
