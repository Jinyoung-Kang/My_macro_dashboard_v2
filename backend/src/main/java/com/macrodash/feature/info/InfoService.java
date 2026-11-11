package com.macrodash.feature.info;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorClient;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.FetchStateStore;
import com.macrodash.store.InfoStore;
import com.macrodash.store.InfoStore.Item;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * 정보 수집 화면(사이드바 '정보 수집', ADR 0035·0036) — 수집기가 받아 둔 글·저장본·출처 판정을 <b>읽기만</b> 합니다.
 *
 * <p>스냅샷은 {@link StoreReader#readStored}로만 읽습니다 — 화면 조회가 수집을 요청하면 그 출처의 비주기 일정과 하루 예산을 건너뜁니다(ADR 0026).
 * 출처마다의 마지막 실행은 수집기 상태 응답({@code /status}의 taskSummary)에서, 작동 방식의 실제 값은 수집기 {@code /info/mechanism}에서
 * 받습니다(둘 다 외부를 부르지 않는 응답). 목록은 쪽으로 나눠 내립니다.
 */
@Service
public class InfoService {

    static final int DEFAULT_SIZE = 10;
    static final int MAX_SIZE = 50;
    private static final Pattern ID = Pattern.compile("[0-9a-f]{24}");
    private static final List<String> ITEM_KINDS = List.of(InfoSources.BLOG, InfoSources.WAEDGE, InfoSources.WIRE);
    /** 번역 요청으로 직접 보내는 글(사건 뉴스 요약)의 길이 상한 — 수집기의 요약 상한(2,000자)에 여유를 둔 값. */
    static final int TRANSLATE_TEXT_MAX = 8_000;
    private static final List<String> HEADLINE_SETS = List.of("us", "kr");
    private static final List<String> KRX_MARKETS = List.of("KOSPI", "KOSDAQ");
    private static final List<String> KRX_INVESTORS = List.of("외국인", "기관", "개인", "연기금", "금융투자", "투신");
    private static final List<String> TRADE_TYPES = List.of("순매수", "순매도");
    private static final Map<String, String> TAB_LABELS = Map.of(
            InfoSources.TAB_NEWS, "뉴스·글", InfoSources.TAB_KR, "국내 시장·수급", InfoSources.TAB_GLOBAL, "해외 시장·거시",
            InfoSources.TAB_FILINGS, "기관·공시·재무", InfoSources.TAB_PAPER, "모의매매 입력", InfoSources.TAB_OPS, "운영");

    private final InfoStore store;
    private final FetchStateStore fetchState;
    private final StoreReader reader;
    private final StoreRepository repository;
    private final CollectorClient collector;
    private final InfoTranslator translator;
    private final Clock clock;

    @Autowired
    public InfoService(InfoStore store, FetchStateStore fetchState, StoreReader reader, StoreRepository repository,
                       CollectorClient collector, InfoTranslator translator) {
        this(store, fetchState, reader, repository, collector, translator, Clock.systemUTC());
    }

    InfoService(InfoStore store, FetchStateStore fetchState, StoreReader reader, StoreRepository repository,
                CollectorClient collector, InfoTranslator translator, Clock clock) {
        this.store = store;
        this.fetchState = fetchState;
        this.reader = reader;
        this.repository = repository;
        this.collector = collector;
        this.translator = translator;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ 글
    /**
     * 글 목록(최근부터, 본문 없이, 쪽으로).
     *
     * @param kind   blog·waedge·wire(비면 글 전부 — 블로그·waedge. 속보는 wire로만)
     * @param source 출처 키 하나(비면 종류 전체)
     * @param page   1부터
     */
    public Map<String, Object> items(String kind, String source, String query, Integer page, Integer size) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!store.ready()) {
            out.put("available", false);
            out.put("items", List.of());
            return out;
        }
        List<String> sources = new ArrayList<>();
        if (source != null && !source.isBlank()) {
            sources.add(source.strip());
        } else if (kind != null && !kind.isBlank()) {
            if (!ITEM_KINDS.contains(kind)) {
                throw new InvalidRequestException("kind는 " + ITEM_KINDS + " 가운데 하나입니다");
            }
            sources.addAll(InfoSources.keysOf(kind));
            if (InfoSources.WAEDGE.equals(kind)) {
                sources.remove("waedge.blogs");       // 한국어 제목만 있는 원문 블로그 글은 블로그 쪽에
            } else if (InfoSources.BLOG.equals(kind)) {
                sources.add("waedge.blogs");
            }
        } else {
            // 종류를 고르지 않으면 글(블로그·waedge)만 — 하루 수백 줄인 속보가 '최근 글'을 덮지 않게. 속보는 kind=wire로 따로 봅니다.
            sources.addAll(InfoSources.keysOf(InfoSources.BLOG));
            sources.addAll(InfoSources.keysOf(InfoSources.WAEDGE));
        }
        Paging paging = Paging.of(page, size);
        InfoStore.Page<Item> rows = store.items(sources, query, paging.offset(), paging.size());
        out.put("available", true);
        out.put("items", rows.rows().stream().map(item -> itemJson(item, false)).toList());
        paging.put(out, rows.total());
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

    /**
     * 사건 뉴스 RSS 제목(미국·한국 — 수집기 news_headlines·kr_news_headlines, 모의매매 Claude 패킷 11b_events의 재료)을 최근부터, 쪽으로.
     *
     * @param set us·kr(비면 둘 다)
     */
    public Map<String, Object> headlines(String set, String feed, String query, Integer page, Integer size) {
        List<String> datasets;
        if (set == null || set.isBlank()) {
            datasets = List.of(Datasets.OBS_NEWS_HEADLINE, Datasets.OBS_KR_NEWS_HEADLINE);
        } else if (HEADLINE_SETS.contains(set)) {
            datasets = List.of("us".equals(set) ? Datasets.OBS_NEWS_HEADLINE : Datasets.OBS_KR_NEWS_HEADLINE);
        } else {
            throw new InvalidRequestException("set은 " + HEADLINE_SETS + " 가운데 하나입니다");
        }
        Paging paging = Paging.of(page, size);
        InfoStore.Page<InfoStore.Headline> rows = store.headlines(datasets, feed, query, paging.offset(), paging.size());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("items", rows.rows().stream().map(row -> {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("set", Datasets.OBS_KR_NEWS_HEADLINE.equals(row.dataset()) ? "kr" : "us");
            line.put("title", row.title());
            line.put("summary", row.summary());
            line.put("link", row.link());
            line.put("source", row.source());
            line.put("feed", row.feed());
            line.put("publishedAt", row.publishedAt() == null ? null : Kst.stamp(row.publishedAt()));
            line.put("fetchedAt", row.fetchedAt());
            return line;
        }).toList());
        paging.put(out, rows.total());
        return out;
    }

    // ------------------------------------------------------------------ 번역
    /**
     * 글 하나를 한국어로(ADR 0037) — 화면의 번역 단추가 부릅니다. 수집 글이면 {@code itemId}만 보내고(서버가 저장된 본문 — 없으면 요약 — 을 읽음),
     * 사건 뉴스처럼 글 표에 없는 것은 {@code title}·{@code text}를 보냅니다. 번역은 저장되어 다시 눌러도 모델을 부르지 않습니다.
     * 수집은 일으키지 않습니다(없는 본문을 받으러 가지 않음).
     *
     * @return {@code {ok, titleKo, textKo, alreadyKorean, cached, truncated, model, error}} — 번역할 본문이 없으면 textKo는 null,
     *         model은 이번에 번역한 모델(저장본만으로 끝났으면 null)
     */
    public Map<String, Object> translate(String itemId, String title, String text) {
        String sourceTitle = title == null ? null : title.strip();
        String sourceText = text == null ? null : text.strip();
        if (itemId != null && !itemId.isBlank()) {
            if (!ID.matcher(itemId).matches()) {
                throw new InvalidRequestException("글 id 형식이 아닙니다");
            }
            Optional<Item> item = store.ready() ? store.item(itemId) : Optional.empty();
            if (item.isEmpty()) {
                throw new InvalidRequestException("그 글이 없습니다");
            }
            sourceTitle = item.get().titleKo() == null ? item.get().title() : null;
            sourceText = item.get().body() != null && !item.get().body().isBlank() ? item.get().body() : item.get().summary();
        } else {
            if ((sourceTitle == null || sourceTitle.isEmpty()) && (sourceText == null || sourceText.isEmpty())) {
                throw new InvalidRequestException("itemId 또는 title·text가 필요합니다");
            }
            if (sourceTitle != null && sourceTitle.length() > InfoTranslator.TITLE_MAX_CHARS) {
                throw new InvalidRequestException("title은 " + InfoTranslator.TITLE_MAX_CHARS + "자까지입니다");
            }
            if (sourceText != null && sourceText.length() > TRANSLATE_TEXT_MAX) {
                throw new InvalidRequestException("text는 " + TRANSLATE_TEXT_MAX + "자까지입니다");
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        String error = null;
        String titleKo = null;
        String usedModel = null;
        if (sourceTitle != null && InfoTranslator.needsTranslation(sourceTitle)) {
            InfoTranslator.Titles titles = translator.titles(List.of(sourceTitle));
            titleKo = titles.translated().get(sourceTitle);
            error = titleKo == null ? titles.error() : null;
            usedModel = titles.model();
        }
        InfoTranslator.Body body = sourceText == null || sourceText.isBlank() ? null : translator.body(sourceText);
        if (body != null && !body.ok()) {
            error = body.error();
        }
        out.put("ok", error == null);
        out.put("titleKo", titleKo);
        out.put("textKo", body == null ? null : body.textKo());
        out.put("alreadyKorean", body != null && body.alreadyKorean());
        out.put("cached", body == null || body.cached());
        out.put("truncated", body != null && body.truncated());
        // 이번에 실제로 번역한 모델(Gemini, 또는 넘어간 Claude). 저장본만으로 끝났으면 null.
        out.put("model", body != null && body.model() != null ? body.model() : usedModel);
        out.put("error", error);
        return out;
    }

    // ------------------------------------------------------------------ 출처 상태
    /** 출처별 상태(판정·글 수·끊김)와 지금 끊긴 출처 목록 — 모든 화면의 안내 띠가 씁니다. */
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
        Map<String, InfoStore.SourceState> states = states();
        List<SourceIncidents.Incident> incidents = SourceIncidents.build(List.copyOf(states.values()), now);
        out.put("available", true);
        out.put("recorded", !states.isEmpty());
        out.put("incidents", incidents.stream().map(InfoService::incidentJson).toList());
        return out;
    }

    /**
     * 모든 출처의 한눈 보기 — 탭(큰 분류)마다 출처 카드(접근 방식·기관·링크·화면)와 마지막 실행(수집기 실행 기록), polite 출처는 판정·다음
     * 실행·끊김을 더합니다. 수집기에 닿지 못하면 마지막 실행 칸은 비고 {@code collectorReachable: false}.
     */
    public Map<String, Object> catalog() {
        Instant now = clock.instant();
        Map<String, JsonNode> runs = new LinkedHashMap<>();
        Optional<JsonNode> status = collector.status();
        status.map(node -> node.get("taskSummary")).filter(JsonNode::isArray)
                .ifPresent(list -> list.forEach(row -> runs.put(row.path("task").asText(""), row)));
        Map<String, InfoStore.SourceState> states = store.ready() ? states() : Map.of();
        Map<String, Instant> schedule = fetchState.ready() ? fetchState.schedule() : Map.of();
        Map<String, InfoStore.SourceCount> counts = store.ready()
                ? store.counts().stream().collect(Collectors.toMap(InfoStore.SourceCount::source, Function.identity()))
                : Map.of();
        Map<String, SourceIncidents.Incident> incidents = SourceIncidents.build(List.copyOf(states.values()), now).stream()
                .collect(Collectors.toMap(SourceIncidents.Incident::task, Function.identity(), (a, b) -> a));

        List<Map<String, Object>> rows = new ArrayList<>();
        for (InfoSources.Source source : InfoSources.ALL) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("task", source.task());
            row.put("key", source.key());
            row.put("label", source.label());
            row.put("tab", source.tab());
            row.put("kind", source.kind());
            row.put("siteUrl", source.siteUrl().isEmpty() ? null : source.siteUrl());
            row.put("origin", source.origin());
            row.put("access", source.access());
            row.put("screen", source.screen());
            JsonNode run = runs.get(source.task());
            row.put("speed", run == null ? null : run.path("speed").asText(null));
            row.put("lastStatus", run == null ? null : run.path("status").asText(null));
            row.put("lastRunAt", run == null ? null : kstText(run.path("startedAt").asText(null)));
            row.put("lastDetail", run == null ? null : run.path("detail").asText(null));
            InfoStore.SourceState state = states.get(source.task());
            row.put("politeStatus", state == null ? null : state.status());
            row.put("streak", state == null ? null : state.streak());
            row.put("lastOkAt", state == null || state.lastOkAt() == null ? null : Kst.stamp(state.lastOkAt()));
            Instant due = schedule.get(source.task());
            row.put("nextDueAt", due == null ? null : Kst.stamp(due));
            InfoStore.SourceCount count = counts.get(source.key());
            row.put("items", count == null ? null : count.items());
            SourceIncidents.Incident incident = incidents.get(source.task());
            row.put("incident", incident == null ? null : incidentJson(incident));
            row.put("tone", tone(source, run, state, incident));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkedAt", Kst.stamp(now));
        out.put("collectorReachable", status.isPresent());
        out.put("tabs", InfoSources.TABS.stream().map(tab -> {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("key", tab);
            entry.put("label", TAB_LABELS.get(tab));
            Map<String, Long> tones = rows.stream().filter(row -> tab.equals(row.get("tab")))
                    .collect(Collectors.groupingBy(row -> String.valueOf(row.get("tone")), LinkedHashMap::new, Collectors.counting()));
            entry.put("tones", tones);
            entry.put("sources", tones.values().stream().mapToLong(Long::longValue).sum());
            return entry;
        }).toList());
        out.put("sources", rows);
        out.put("incidents", incidents.values().stream().map(InfoService::incidentJson).toList());
        return out;
    }

    /**
     * 카드의 색 — 끊김 사건이면 위험(차단·형식 바뀜) 또는 주의, 수집기 실행 기록이 실패·거부면 위험, 수집 결과 없음·일부면 주의, 성공이면 정상,
     * 기록이 없으면(보류·로컬에서 돌지 않는 polite·처음) 회색.
     */
    static String tone(InfoSources.Source source, JsonNode run, InfoStore.SourceState state, SourceIncidents.Incident incident) {
        if (InfoSources.DEFERRED.equals(source.access())) {
            return "neutral";
        }
        if (incident != null) {
            return "blocked".equals(incident.kind()) || "format".equals(incident.kind()) ? "danger" : "warn";
        }
        if (state != null) {
            return "ok".equals(state.status()) ? "ok" : "warn";
        }
        String status = run == null ? null : run.path("status").asText(null);
        if (status == null) {
            return "neutral";
        }
        return switch (status) {
            case "ok" -> "ok";
            case "fail", "rejected", "interrupted" -> "danger";
            default -> "warn";
        };
    }

    // ------------------------------------------------------------------ 메커니즘
    /**
     * 작동 방식 — 수집기 코드의 실제 값(스위치·계층·물러남·예산·간격·본문 규칙)에 표의 지금 상태(호스트별 마지막 통과 계층·오늘 쓴 예산·닫힘,
     * 다음 실행 시각)와 끊김 알림 기준을 더합니다. 수집기에 닿지 못하면 {@code collector: null}.
     */
    public Map<String, Object> mechanism() {
        Instant now = clock.instant();
        LocalDate today = Kst.today();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkedAt", Kst.stamp(now));
        out.put("collector", collector.infoMechanism().orElse(null));
        List<Map<String, Object>> hosts = new ArrayList<>();
        if (fetchState.ready()) {
            for (FetchStateStore.HostState host : fetchState.hosts()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("host", host.host());
                row.put("lastGoodTier", host.lastGoodTier());
                row.put("failLevel", host.failLevel());
                row.put("blockedUntil", host.blockedUntil() == null || host.blockedUntil().isBefore(now) ? null : Kst.stamp(host.blockedUntil()));
                row.put("blockedReason", host.blockedReason());
                row.put("givenUp", host.givenUp());
                row.put("usedToday", today.equals(host.budgetDay()) ? host.budgetUsed() : 0);
                hosts.add(row);
            }
        }
        out.put("hostStates", hosts);
        Map<String, Object> schedule = new LinkedHashMap<>();
        if (fetchState.ready()) {
            fetchState.schedule().forEach((task, due) -> schedule.put(task, Kst.stamp(due)));
        }
        out.put("schedule", schedule);
        Map<String, Object> alerts = new LinkedHashMap<>();
        alerts.put("formatStreak", SourceIncidents.FORMAT_STREAK);
        alerts.put("failedStreak", SourceIncidents.FAILED_STREAK);
        alerts.put("intervalMinutes", 5);
        out.put("alerts", alerts);
        out.put("deferred", List.of(Map.of("task", InfoSources.SAVETICKER, "label", InfoSources.label(InfoSources.SAVETICKER),
                "reason", "운영 서버 IP를 Cloudflare가 대역째 차단(확인 화면이 아닌 차단 화면, 실제 브라우저로도 같음) — 개인 IP·프록시를 쓰지 "
                        + "않는 규칙이라 보류. 대신 이 사이트가 원출처로 밝힌 Financial Juice의 속보 RSS를 받습니다(ADR 0037). "
                        + "계정 이름 SAVETICKER_ID·SAVETICKER_PW")));
        out.put("translation", translator.status());
        return out;
    }

    // ------------------------------------------------------------------ 저장본
    /** 네이버 투자자별 매매동향·매매상위 저장본(수집기가 만든 모양 그대로 — 없는 값은 null). */
    public Map<String, Object> flows() {
        return snapshot(Datasets.SNAP_INFO_NAVER_FLOWS, "trend", "rankings", "failed", "sourceUrls", "unit");
    }

    /** waedge 거장 견해 저장본. */
    public Map<String, Object> gurus() {
        return snapshot(Datasets.SNAP_INFO_WAEDGE_GURUS, "gurus", "counts", "asOf", "sourceUrl");
    }

    /**
     * KRX 정보데이터시스템(로그인) — 기준일의 시장 합계·외국인 보유·공매도(스냅샷)와, 고른 (시장, 투자주체, 방향)의 순매수 상위(관측치).
     */
    public Map<String, Object> krx(String market, String investor, String tradeType) {
        String m = market == null || market.isBlank() ? "KOSPI" : market;
        String inv = investor == null || investor.isBlank() ? "외국인" : investor;
        String dir = tradeType == null || tradeType.isBlank() ? "순매수" : tradeType;
        if (!KRX_MARKETS.contains(m) || !KRX_INVESTORS.contains(inv) || !TRADE_TYPES.contains(dir)) {
            throw new InvalidRequestException("market·investor·tradeType이 허용 값이 아닙니다");
        }
        Map<String, Object> out = snapshot(Datasets.SNAP_INFO_KRX_DAILY, "asOf", "sourceUrl", "totals", "foreign", "shortTrades",
                "shortBalances", "rankings", "failed");
        List<String> dates = repository.listObservationDates(Datasets.OBS_KRX_INVESTOR_RANK,
                Map.of("market", m, "investor", inv, "tradeType", dir));
        String day = dates.isEmpty() ? null : dates.get(dates.size() - 1);
        List<JsonNode> rows = day == null ? List.of()
                : repository.readObservations(Datasets.OBS_KRX_INVESTOR_RANK, LocalDate.parse(day), null,
                        Map.of("market", m, "investor", inv, "tradeType", dir));
        List<JsonNode> sorted = new ArrayList<>(rows);
        sorted.sort((a, b) -> Integer.compare(a.path("rank").asInt(Integer.MAX_VALUE), b.path("rank").asInt(Integer.MAX_VALUE)));
        Map<String, Object> ranking = new LinkedHashMap<>();
        ranking.put("market", m);
        ranking.put("investor", inv);
        ranking.put("tradeType", dir);
        ranking.put("date", day);
        ranking.put("rows", sorted);
        out.put("ranking", ranking);
        out.put("markets", KRX_MARKETS);
        out.put("investors", KRX_INVESTORS);
        return out;
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

    // ------------------------------------------------------------------ 공통
    private Map<String, InfoStore.SourceState> states() {
        return store.states().stream()
                .collect(Collectors.toMap(InfoStore.SourceState::task, Function.identity(), (a, b) -> a, LinkedHashMap::new));
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

    /** 수집기가 준 ISO 시각을 KST 글로 — 읽지 못하면 그대로. */
    private static String kstText(String iso) {
        if (iso == null || iso.isBlank()) {
            return null;
        }
        try {
            return Kst.stamp(java.time.OffsetDateTime.parse(iso).toInstant());
        } catch (java.time.format.DateTimeParseException e) {
            return iso;
        }
    }

    /** 쪽 나누기 — page는 1부터, size는 1~{@value #MAX_SIZE}(기본 {@value #DEFAULT_SIZE}). */
    record Paging(int page, int size) {
        static Paging of(Integer page, Integer size) {
            int s = size == null ? DEFAULT_SIZE : Math.max(1, Math.min(size, MAX_SIZE));
            int p = page == null ? 1 : Math.max(1, Math.min(page, 10_000));
            return new Paging(p, s);
        }

        int offset() {
            return (page - 1) * size;
        }

        void put(Map<String, Object> out, int total) {
            out.put("page", page);
            out.put("size", size);
            out.put("total", total);
            out.put("pages", Math.max(1, (total + size - 1) / size));
        }
    }
}
