package com.macrodash.feature.paper;

import com.macrodash.analytics.KrNewsEvents;
import com.macrodash.analytics.NewsEvents;
import com.macrodash.store.Datasets;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 🧪 한국 Claude 패킷의 사건 섹션 {@code 11b_events}(2단계 명세 §4-11·K21, E1a) — 저장본({@code kr_news_headline}) 행을 {@link KrNewsEvents} 입력으로
 * 옮기고, 고른 헤드라인을 구분자로 감싼 글({@code text})과 번호·entity·출처·알 수 있는 시각·걸린 이유 목록({@code items})으로 펼칩니다(미국
 * {@link EventsSection}과 같은 모양). 설정 {@code kr.news.*}를 읽는 것도 여기입니다.
 *
 * <p><b>피드</b>: 기본은 넷 모두({@link PaperSettingsService#KR_NEWS_FEEDS}) — 연합뉴스 마켓+({@code yna_market})도 사용자 결정(2026-10-27, G12 —
 * 빼자는 권장을 뒤집음)으로 기본에 둡니다. 채널의 '무단 전재-재배포, AI 학습 및 활용 금지' 문구상 제목을 패킷 입력으로 쓰는 것이 'AI 활용'일 수
 * 있다는 위험은 남고[추정], 빼기는 설정 {@code kr.news.feeds}에서 지우는 저장 한 번입니다. 저장은 제목·링크·시각만(본문 없음, 로컬 7일).
 *
 * <p><b>읽는 범위</b>: 창 시작의 KST 날짜 하루 앞부터 끝 없이(obs_date = 발행 KST 날짜 — B9). 창 밖 행은 수집 범위 판정에만 씁니다(미국 {@link EventsSection#readFrom}와
 * 같은 까닭). 수집 상태({@code kr.news.headlines.status})의 실패 중인 피드는 {@code feedNote}에 적습니다(미국 {@link EventsSection#feedNote}와 같은 규칙,
 * 피드 키는 한국 넷). 제목·출처의 구분자 모양은 미국과 같은 함수({@link EventsSection#sanitize})로 지웁니다.
 */
final class KrEventsSection {

    private KrEventsSection() {
    }

    static final String SOURCE = "observations " + Datasets.OBS_KR_NEWS_HEADLINE
            + " — RSS 제목·출처·시각만(한국은행·재정경제부·국가데이터처·연합뉴스 마켓+, 수집기 kr_news_headlines, 보존 7일)";
    /** 설정 묶음({@code kr.news.*}). */
    static final String GROUP = "news";
    /** 창·시각 표기의 말 — 알 수 있는 시각(날짜만 주는 피드는 그 날짜 다음 자정과 처음 받은 시각 중 이른 것). */
    static final String TIME_NOTE = "시각 = 알 수 있는 시각(KST — 시각이 있는 피드는 발행 시각, 날짜만 주는 재정경제부는 날짜만 적음)";

    /** 설정 {@code kr.news.*}을 읽은 값과 기본값으로 대신 읽은 키. */
    record NewsSettings(KrNewsEvents.Settings settings, Map<String, List<String>> aliases, List<String> fallbacks) {
        NewsSettings {
            fallbacks = List.copyOf(fallbacks);
        }
    }

    /** 섹션 본문과 계산 결과(측정 태그 {@code hasEvents}·{@code eventIds}의 출처). */
    record Built(Map<String, Object> section, KrNewsEvents.Result result) {
    }

    /**
     * 그 실행의 한국 설정 묶음({@code kr} 아래 {@code news})에서 읽습니다 — 키가 없거나 형이 틀리면 그 키만 기본값({@code kr.news.…}을 fallbacks에),
     * 묶음이 없으면 모두 기본값({@code kr.news}). 본문이 null이면 기본값(fallbacks 없음).
     */
    static NewsSettings settings(JsonNode body) {
        if (body == null) {
            return new NewsSettings(defaults(), Map.of(), List.of());
        }
        JsonNode news = Json.child(Json.child(body, "kr"), GROUP);
        if (news == null || !news.isObject()) {
            return new NewsSettings(defaults(), Map.of(), List.of("kr." + GROUP));
        }
        List<String> fallbacks = new ArrayList<>();
        JsonNode enabledNode = Json.child(news, "enabled");
        boolean enabled = true;
        if (enabledNode != null && enabledNode.isBoolean()) {
            enabled = enabledNode.booleanValue();
        } else {
            fallbacks.add("kr.news.enabled");
        }
        JsonNode maxNode = Json.child(news, "maxPerDay");
        int max = PaperSettingsService.KR_NEWS_MAX_PER_DAY;
        if (maxNode != null && maxNode.isIntegralNumber() && maxNode.canConvertToInt()
                && maxNode.intValue() >= 0 && maxNode.intValue() <= NewsEvents.MAX_PER_DAY_LIMIT) {
            max = maxNode.intValue();
        } else {
            fallbacks.add("kr.news.maxPerDay");
        }
        List<String> keywords = strings(Json.child(news, "keywords"));
        if (keywords == null) {
            keywords = PaperSettingsService.KR_NEWS_KEYWORDS;
            fallbacks.add("kr.news.keywords");
        }
        List<String> feeds = strings(Json.child(news, "feeds"));
        if (feeds == null) {
            feeds = PaperSettingsService.KR_NEWS_FEEDS;
            fallbacks.add("kr.news.feeds");
        }
        Map<String, List<String>> aliases = new LinkedHashMap<>();
        JsonNode aliasNode = Json.child(news, "aliases");
        boolean aliasesOk = aliasNode != null && aliasNode.isObject();
        if (aliasesOk) {
            for (Map.Entry<String, JsonNode> entry : aliasNode.properties()) {
                List<String> names = strings(entry.getValue());
                if (names == null) {
                    aliasesOk = false;
                    break;
                }
                aliases.put(entry.getKey(), names);
            }
        }
        if (!aliasesOk) {
            aliases.clear();
            fallbacks.add("kr.news.aliases");
        }
        return new NewsSettings(new KrNewsEvents.Settings(enabled, max, keywords, feeds), aliases, fallbacks);
    }

    private static KrNewsEvents.Settings defaults() {
        return new KrNewsEvents.Settings(true, PaperSettingsService.KR_NEWS_MAX_PER_DAY, PaperSettingsService.KR_NEWS_KEYWORDS,
                PaperSettingsService.KR_NEWS_FEEDS);
    }

    private static List<String> strings(JsonNode node) {
        if (node == null || !node.isArray()) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (JsonNode item : node) {
            if (!item.isString()) {
                return null;
            }
            out.add(item.asString(""));
        }
        return out;
    }

    /** 저장본을 읽기 시작할 날짜(obs_date = 발행 KST 날짜) — 창 시작의 KST 날짜 하루 앞. */
    static LocalDate readFrom(NewsEvents.Window window) {
        return window.from().atZone(NewsEvents.KST).toLocalDate().minusDays(1);
    }

    /** 저장본 한 행 → 계산 입력. 칸이 빠지거나 형이 틀리면 null(시각을 지어내지 않음). 객체가 아니면 null. */
    static KrNewsEvents.Headline headline(JsonNode row) {
        if (row == null || !row.isObject()) {
            return null;
        }
        return new KrNewsEvents.Headline(text(row, "entity"), text(row, "title"), text(row, "link"), text(row, "source"),
                text(row, "feed"), strings(Json.child(row, "feeds")), Json.parseDate(text(row, "publishedDate")),
                text(row, "timePrecision"), instant(text(row, "knownAt")), instant(text(row, "fetchedAt")));
    }

    /**
     * 섹션 본문.
     *
     * @param rows     {@link #readFrom}부터 읽은 저장본 행
     * @param window   (직전 KR 거래일 결정 순간, 기준 세션 결정 순간]
     * @param readAt   읽은 순간(이 뒤에 받은 행은 넣지 않음)
     * @param news     {@code kr.news.*}({@link #settings})
     * @param names    걸 대상 — 코드 → 이름들(금융위·DART 이름 + 별칭)
     * @param status   수집 상태 저장본 payload(없으면 null)
     */
    static Built build(List<JsonNode> rows, NewsEvents.Window window, Instant readAt, NewsSettings news,
                       Map<String, ? extends Collection<String>> names, JsonNode status) {
        List<KrNewsEvents.Headline> stored = new ArrayList<>();
        if (rows != null) {
            for (JsonNode row : rows) {
                KrNewsEvents.Headline h = headline(row);
                if (h != null) {
                    stored.add(h);
                }
            }
        }
        KrNewsEvents.Result r = KrNewsEvents.compute(stored, window, readAt, news.settings(), new KrNewsEvents.Targets(names),
                EventsSection::sanitize);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", SOURCE);
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("from", window.fromKst());
        w.put("to", window.toKst());
        out.put("window", w);
        out.put("note", KrNewsEvents.NOTE);
        out.put("timeNote", TIME_NOTE);
        out.put("text", r.text());
        boolean picked = KrNewsEvents.OK.equals(r.status()) || KrNewsEvents.NONE.equals(r.status());
        if (!picked) {
            return new Built(out, r);
        }
        if (KrNewsEvents.OK.equals(r.status()) && r.coverageNote() != null) {
            out.put("coverageNote", r.coverageNote());
        }
        String feedNote = feedNote(status, window, news.settings());
        if (feedNote != null) {
            out.put("feedNote", feedNote);
        }
        if (r.eventCount() == null) {
            return new Built(out, r);
        }
        if (r.omitted() != null && r.omitted() > 0) {
            out.put("omitted", r.omitted());
            out.put("maxPerDay", r.cap());
        }
        List<Map<String, Object>> items = new ArrayList<>();
        for (KrNewsEvents.Item item : r.items()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("k", item.k());
            row.put("entity", item.entity());
            row.put("source", item.source());
            if (item.dateOnly()) {
                row.put("publishedDate", item.publishedDateText());
            } else {
                row.put("knownAtKst", item.knownAtKst());
            }
            List<String> labels = item.matchedLabels();
            row.put("matched", labels.subList(0, Math.min(EventsSection.MAX_MATCHED_SHOWN, labels.size())));
            if (labels.size() > EventsSection.MAX_MATCHED_SHOWN) {
                row.put("matchedMore", labels.size() - EventsSection.MAX_MATCHED_SHOWN);
            }
            items.add(row);
        }
        out.put("items", items);
        return new Built(out, r);
    }

    /** 수집이 끊긴 고른 피드 — 미국 {@link EventsSection#feedNote}와 같은 규칙, 피드 순서는 {@link PaperSettingsService#KR_NEWS_FEEDS}. */
    static String feedNote(JsonNode status, NewsEvents.Window window, KrNewsEvents.Settings settings) {
        JsonNode feeds = Json.child(status, "feeds");
        if (feeds == null || !feeds.isObject()) {
            return null;
        }
        Instant since = window.to().minus(NewsEvents.STALE_AFTER);
        List<String> failing = new ArrayList<>();
        for (String key : PaperSettingsService.KR_NEWS_FEEDS) {
            if (settings != null && settings.feeds() != null && !settings.feeds().contains(key)) {
                continue;
            }
            JsonNode entry = Json.child(feeds, key);
            if (entry == null || !"실패".equals(text(entry, "status"))) {
                continue;
            }
            Instant lastOk = instant(text(entry, "lastOkAt"));
            if (lastOk == null || lastOk.isBefore(since)) {
                failing.add(key);
            }
        }
        return failing.isEmpty() ? null
                : "수집 실패 중인 피드(창 끝 " + NewsEvents.STALE_AFTER.toHours() + "시간 전부터): " + String.join(", ", failing)
                        + " — 이 피드의 사건은 빠졌을 수 있음";
    }

    private static Instant instant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text.strip()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isString() ? v.asString() : null;
    }
}
