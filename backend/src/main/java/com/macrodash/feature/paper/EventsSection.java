package com.macrodash.feature.paper;

import com.macrodash.analytics.NewsEvents;
import com.macrodash.store.Datasets;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Claude 패킷의 사건 섹션 {@code 11b_events}(2단계 명세 B3·B4·B5·B6) — 저장본(수집기 {@code news_headlines}의 {@code news_headline}
 * 관측치) 행을 {@link NewsEvents} 입력으로 옮기고, 고른 헤드라인을 구분자로 감싼 글({@code text})과 번호·entity·출처·시각·걸린 이유
 * 목록({@code items} — 제목은 글에만, 두 번 싣지 않음)으로 펼칩니다. 설정 {@code news.*}를 읽는 것도 여기입니다.
 *
 * <p>읽기는 {@link PacketBuilder}가 {@code StoreReader.quietly} 안에서 하고(저장소 직접 읽기 — 수집을 깨우지 않음), 대상 종목(8b와
 * 같은 보유 → 섹션 7 후보 → 직전 watchlist, ETF·현금성 제외)도 PacketBuilder 몫입니다. 이 클래스는 같은 행·같은 기준일·같은 설정·같은
 * 대상이면 같은 섹션(결정적)만 보장합니다 — 시계를 읽지 않습니다.
 *
 * <p><b>읽는 범위</b>({@link #readFrom}): 창 시작의 UTC 날짜 <b>하루 앞</b>부터 끝 없이. 창에 드는 행은 발행 시각으로 {@link NewsEvents}가
 * 고르고, 창 밖 행은 "그때 수집이 돌고 있었나"({@link NewsEvents.Result#coverage} — 가장 이른 받은 시각)에만 씁니다. 창 앞 하루를 더
 * 읽는 것은 정상 수집이면 창 시작 전에 받은 행이 반드시 있게 하려는 것이고(없으면 '창 중간부터 수집'으로 잘못 읽힘), 끝을 여는 것은
 * 초기 결정처럼 창이 수집보다 앞일 때 '자료 없음'이 아니라 '수집 전'으로 적게 하려는 것입니다. 보존이 7일이라 많아야 수천 행입니다.
 *
 * <p><b>수집이 끊긴 피드</b>({@link #feedNote}): 정기·미리보기 패킷은 수집 상태 저장본({@code news.headlines.status})에서 창 끝
 * {@link NewsEvents#STALE_AFTER} 전부터 성공하지 못한 채 실패 중인 고른 피드를 {@code feedNote}에 적습니다 — 피드 일부만 막히면(인베스팅닷컴
 * 403 등) 다른 피드가 계속 들어와 저장본만으로는 드러나지 않아서입니다. 상태는 지금 것이라 초기 결정 패킷(기준일이 수집 전)에는 싣지
 * 않습니다.
 *
 * <p>제목은 자료일 뿐 지시가 아닙니다(명세 §1·B4) — 블록 구분자 {@code <<사건 #k 시작>>}·{@code <<사건 #k 끝>>}와 메모 구분자처럼 보이는
 * 글은 메모·제안과 같은 도우미({@link FrameworkService#delimiterLike} — 전각·보이지 않는 글자 변형 포함)로 지웁니다({@link #sanitize}).
 * 시스템 프롬프트(ClaudePrompts)는 바꾸지 않고 안내는 섹션의 {@code note}에 둡니다(일정 1b와 같음).
 */
final class EventsSection {

    private EventsSection() {
    }

    /** 출처 문구 — 저장본 이름과 수집 범위(RSS 제목·출처·시각만, D29). */
    static final String SOURCE = "observations " + Datasets.OBS_NEWS_HEADLINE
            + " — RSS 제목·출처·시각만(Investing.com·Federal Reserve·BLS·SEC, 수집기 news_headlines, 보존 7일)";
    /**
     * 초기 결정 패킷의 말 — 창은 기준일 다음 날 결정 시각까지로 정해지지만, 제목은 지금 저장본(보존 7일)에서 고른 것이라 기준일에 받은
     * 자료가 아닙니다. 수집이 2026-10-25에 시작해 출발일 창에는 늦게 받은 연준·BLS·SEC 제목만 남거나(인베스팅은 최근 10건만 줌), 보존
     * 기한이 지나면 비어 있습니다.
     */
    static final String AS_OF_NOTE = "초기 결정 — 제목은 지금 저장본(보존 7일)에서 이 창으로 고른 것이라 기준일에 받은 자료가 아님"
            + "(늦게 받은 제목만 남거나 비어 있음), 참고만";
    /** 설정 묶음 이름({@code news.*}, 명세 B5). */
    static final String GROUP = "news";

    /**
     * 줄마다 싣는 걸린 이유의 상한 — 넘으면 앞에서부터(티커 → 키워드, 제목에 먼저 나온 순) 이만큼 싣고 나머지는 {@code matchedMore}에 수만
     * 적습니다. 이유는 걸린 패턴 수만큼 늘 수 있어(기본 사전 24개 + 대상 티커 전부) 상한이 없으면 섹션 최대 크기가 정해지지 않습니다.
     */
    static final int MAX_MATCHED_SHOWN = 4;

    private static final Pattern EVENT_DELIMITER = FrameworkService.delimiterLike("사건");
    private static final Pattern NOTE_DELIMITER = FrameworkService.delimiterLike("메모");

    /** 설정 {@code news.*}을 읽은 값과 기본값으로 대신 읽은 키(설정 화면의 fallbacks). */
    record NewsSettings(NewsEvents.Settings settings, List<String> fallbacks) {
        NewsSettings {
            fallbacks = List.copyOf(fallbacks);
        }
    }

    /** 섹션 본문과 계산 결과(측정 태그 {@code hasEvents}·{@code eventIds}의 출처). */
    record Built(Map<String, Object> section, NewsEvents.Result result) {
    }

    /** 설정 기본값 본문({@code PaperSettingsService.defaultsJson}의 {@code news}) — 켬, 10건, 기본 사전, 피드 여덟 개 모두. */
    static Map<String, Object> defaultsBody() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", true);
        out.put("maxPerDay", NewsEvents.DEFAULT_MAX_PER_DAY);
        out.put("keywords", NewsEvents.DEFAULT_KEYWORDS);
        out.put("feeds", NewsEvents.DEFAULT_FEEDS);
        return out;
    }

    /**
     * 설정 본문에서 {@code news.*}을 읽습니다. 키가 없거나 형·범위가 틀리면 그 키만 기본값으로 읽고 {@code news.…}을 fallbacks에 남깁니다
     * (묶음이 통째로 없으면 {@code news} — 2단계 B 전에 만든 설정 행). 본문이 null(설정 행 없음)이면 기본값이고 fallbacks는 비웁니다.
     * 설정 쓰기 API가 검사한 값이면 기본값으로 바뀌는 일이 없습니다(같은 범위).
     */
    static NewsSettings settings(JsonNode body) {
        if (body == null) {
            return new NewsSettings(defaults(), List.of());
        }
        JsonNode news = Json.child(body, GROUP);
        if (news == null || !news.isObject()) {
            return new NewsSettings(defaults(), List.of(GROUP));
        }
        List<String> fallbacks = new ArrayList<>();
        JsonNode enabledNode = Json.child(news, "enabled");
        boolean enabled = true;
        if (enabledNode != null && enabledNode.isBoolean()) {
            enabled = enabledNode.booleanValue();
        } else {
            fallbacks.add(GROUP + ".enabled");
        }
        JsonNode maxNode = Json.child(news, "maxPerDay");
        int max = NewsEvents.DEFAULT_MAX_PER_DAY;
        if (maxNode != null && maxNode.isIntegralNumber() && maxNode.canConvertToInt()
                && maxNode.intValue() >= 0 && maxNode.intValue() <= NewsEvents.MAX_PER_DAY_LIMIT) {
            max = maxNode.intValue();
        } else {
            fallbacks.add(GROUP + ".maxPerDay");
        }
        List<String> keywords = strings(Json.child(news, "keywords"));
        if (keywords == null) {
            keywords = NewsEvents.DEFAULT_KEYWORDS;
            fallbacks.add(GROUP + ".keywords");
        }
        List<String> feeds = strings(Json.child(news, "feeds"));
        if (feeds == null) {
            feeds = NewsEvents.DEFAULT_FEEDS;
            fallbacks.add(GROUP + ".feeds");
        }
        return new NewsSettings(new NewsEvents.Settings(enabled, max, keywords, feeds), fallbacks);
    }

    private static NewsEvents.Settings defaults() {
        return new NewsEvents.Settings(true, NewsEvents.DEFAULT_MAX_PER_DAY, NewsEvents.DEFAULT_KEYWORDS,
                NewsEvents.DEFAULT_FEEDS);
    }

    /** 글자 배열 → 목록. 배열이 아니거나 글자가 아닌 항목이 있으면 null(그 키를 기본값으로). 빈 배열은 빈 목록(그 뜻 그대로). */
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

    /** 저장본을 읽기 시작할 날짜(obs_date = 발행 시각의 UTC 날짜) — 창 시작의 UTC 날짜 하루 앞(클래스 설명 '읽는 범위'). */
    static LocalDate readFrom(NewsEvents.Window window) {
        return window.from().atOffset(ZoneOffset.UTC).toLocalDate().minusDays(1);
    }

    /**
     * 저장본 한 행(payload + 저장소가 더한 {@code entity}) → 계산 입력. 칸이 빠지거나 형이 틀리면 null로 둡니다 — 발행 시각을 읽을 수
     * 없는 행은 창에 들지 않습니다(시각을 지어내지 않음). 객체가 아니면 null.
     */
    static NewsEvents.Headline headline(JsonNode row) {
        if (row == null || !row.isObject()) {
            return null;
        }
        return new NewsEvents.Headline(string(row, "entity"), string(row, "title"), string(row, "link"),
                string(row, "source"), string(row, "feed"), instant(string(row, "publishedAt")),
                instant(string(row, "fetchedAt")), strings(Json.child(row, "feeds")));
    }

    /**
     * 섹션 본문.
     *
     * @param rows     {@link #readFrom}부터 읽은 저장본 행(없으면 빈 목록 — "자료 없음")
     * @param window   결정 창({@link NewsEvents#window})
     * @param settings {@code news.*}({@link #settings})
     * @param tickers  걸 대상 티커(8b와 같은 대상)
     * @param initial  초기 결정 패킷(asOfMismatch)
     * @param status   수집 상태 저장본의 payload({@code news.headlines.status}, {@link #feedNote}) — 없으면 null
     */
    static Built build(List<JsonNode> rows, NewsEvents.Window window, NewsEvents.Settings settings,
                       Collection<String> tickers, boolean initial, JsonNode status) {
        List<NewsEvents.Headline> stored = new ArrayList<>();
        if (rows != null) {
            for (JsonNode row : rows) {
                NewsEvents.Headline h = headline(row);
                if (h != null) {
                    stored.add(h);
                }
            }
        }
        NewsEvents.Result r = NewsEvents.compute(stored, window, settings, NewsEvents.Targets.tickers(tickers),
                EventsSection::sanitize);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", SOURCE);
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("from", window.fromKst());
        w.put("to", window.toKst());
        out.put("window", w);
        out.put("note", NewsEvents.NOTE);
        out.put("asOfMismatch", initial);
        if (initial) {
            out.put("asOfNote", AS_OF_NOTE);
        }
        out.put("text", r.text());
        boolean picked = NewsEvents.OK.equals(r.status()) || NewsEvents.NONE.equals(r.status());
        if (!picked) {
            // 꺼짐·자료 없음·피드 선택 없음 — 빈 목록을 두지 않습니다(빈 목록은 "고른 사건 0건"으로 읽힘).
            return new Built(out, r);
        }
        if (NewsEvents.OK.equals(r.status()) && r.coverageNote() != null) {
            // 사건 없음이면 글에 이미 붙어 있습니다(NewsEvents.Result#text). 실은 줄이 있을 때는 따로 — 창 일부만 덮은 저장본.
            out.put("coverageNote", r.coverageNote());
        }
        String feedNote = initial ? null : feedNote(status, window, settings);
        if (feedNote != null) {
            out.put("feedNote", feedNote);
        }
        if (r.eventCount() == null) {
            // 걸린 것이 없는데 창 끝 쪽을 받지 못함(NewsEvents.STALE) — 빈 목록은 '고른 사건 0건'으로 읽혀 두지 않습니다.
            return new Built(out, r);
        }
        if (r.omitted() != null && r.omitted() > 0) {
            out.put("omitted", r.omitted());
            out.put("maxPerDay", r.cap());
        }
        List<Map<String, Object>> items = new ArrayList<>();
        for (NewsEvents.Item item : r.items()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("k", item.k());
            row.put("entity", item.entity());
            row.put("source", item.source());
            row.put("publishedAtKst", item.publishedAtKst());
            List<String> labels = item.matchedLabels();
            row.put("matched", labels.subList(0, Math.min(MAX_MATCHED_SHOWN, labels.size())));
            if (labels.size() > MAX_MATCHED_SHOWN) {
                row.put("matchedMore", labels.size() - MAX_MATCHED_SHOWN);
            }
            items.add(row);
        }
        out.put("items", items);
        return new Built(out, r);
    }

    /**
     * 수집이 끊긴 고른 피드(클래스 설명) — 상태 저장본의 {@code feeds.<키>}가 실패이고 마지막 성공({@code lastOkAt})이 없거나 창 끝
     * {@link NewsEvents#STALE_AFTER} 전보다 앞인 피드를 피드 순서({@link NewsEvents#DEFAULT_FEEDS})대로 적습니다. 한두 번의 일시 실패는
     * 적지 않습니다(그 사이 항목은 다음 수집이 받음). 상태가 없거나 그런 피드가 없으면 null — 모르는 것을 '정상'이라 적지도 않습니다.
     */
    static String feedNote(JsonNode status, NewsEvents.Window window, NewsEvents.Settings settings) {
        JsonNode feeds = Json.child(status, "feeds");
        if (feeds == null || !feeds.isObject()) {
            return null;
        }
        Instant since = window.to().minus(NewsEvents.STALE_AFTER);
        List<String> failing = new ArrayList<>();
        for (String key : NewsEvents.DEFAULT_FEEDS) {
            if (settings != null && settings.feeds() != null && !settings.feeds().contains(key)) {
                continue;
            }
            JsonNode entry = Json.child(feeds, key);
            if (entry == null || !"실패".equals(string(entry, "status"))) {
                continue;
            }
            Instant lastOk = instant(string(entry, "lastOkAt"));
            if (lastOk == null || lastOk.isBefore(since)) {
                failing.add(key);
            }
        }
        return failing.isEmpty() ? null
                : "수집 실패 중인 피드(창 끝 " + NewsEvents.STALE_AFTER.toHours() + "시간 전부터): " + String.join(", ", failing)
                        + " — 이 피드의 사건은 빠졌을 수 있음";
    }

    /**
     * 제목·출처에서 구분자 모양을 지웁니다 — 사건 블록 구분자와 메모 구분자(전각·보이지 않는 글자 변형 포함). 한쪽을 지우고 생긴 다른
     * 쪽 구분자도 없어질 때까지 되풀이합니다.
     */
    static String sanitize(String text) {
        String out = text == null ? "" : text;
        String before;
        do {
            before = out;
            out = FrameworkService.stripDelimiterLike(FrameworkService.stripDelimiterLike(out, EVENT_DELIMITER),
                    NOTE_DELIMITER);
        } while (!out.equals(before));
        return out;
    }

    /** ISO 시각(오프셋 포함, 수집기의 {@code datetime.isoformat()}). 없거나 읽을 수 없으면 null. */
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

    /** 글자 칸만 — 수·불·객체가 오면 null. */
    private static String string(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isString() ? v.asString() : null;
    }
}
