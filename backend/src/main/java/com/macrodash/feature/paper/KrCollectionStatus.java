package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * 한국 수집 상태 요약(2단계 명세 §9 x4 — 사용자 결정 2026-10-29) — 상태 응답({@code GET /api/paper/status?market=KR})의 {@code collection}.
 * 한국 책이 읽는 수집기 저장본 일곱 묶음(관측치·수급·유니버스·DART·사건 뉴스·거시 일정·금융위 시세)의 수집 시각·세션/기준일·늦음/뒤처짐을
 * 한 곳에서 봅니다 — 미국 상태의 {@code fundamentals}·{@code calendar}·{@code news}·{@code earnings}와 같은 자리입니다(미국 넷은 한국 응답에서 null).
 *
 * <p><b>읽기만</b>: 저장본은 {@link StoreReader#readStored}·{@link StoreReader#readStoredMeta}(큰 키를 뺀 메타 — 관측치 {@code codes}·DART
 * {@code companies}), 관측 레코드는 저장된 최신 기준일({@link PaperMarketData#fscLatest}·{@link PaperMarketData#krUniverseLatest})만 읽습니다 —
 * {@link StoreReader#read}를 부르지 않아 화면을 열어도 수집을 깨우거나 기다리지 않습니다(PRINCIPLES '화면은 수집을 기다리지 않습니다').
 *
 * <p><b>모르는 값은 null</b>(0으로 채우지 않음). 저장본이 없으면 그 묶음은 {@code available:false}이고 나머지 칸은 null입니다.
 *
 * <p><b>늦음</b>({@code stale}): 관측치·수급은 시장 늦음 규칙({@link PaperMarket#quotesLateAt} — 그 세션 다음 수집 예정 + 2시간 5분, 개요의
 * 관측치 요약과 같은 규칙·같은 달력), DART·거시 일정(주간 수집)은 7일({@link Datasets#MAX_AGE_WEEKLY}), 사건 뉴스(매시 수집)는 24시간
 * ({@link Datasets#MAX_AGE_SLOW})을 넘김입니다. 유니버스·금융위 시세는 저장본에 수집 시각 칸이 없어 늦음 대신 기준일 비교(뒤처짐)로 봅니다 —
 * 유니버스 기준일이 금융위 주식시세 최신 기준일보다 이르면 {@code behind}, 증권상품(ETF) 최신 기준일이 주식보다 이르면 {@code etfBehind}.
 * 달력이 그 해를 몰라 늦음을 셀 수 없으면 {@code stale:null} + {@code staleReason}(개요의 관측치 요약과 같음 — 명세 K35).
 */
final class KrCollectionStatus {

    /** 사건 뉴스 저장본이 이보다 오래되면 늦음(매시 수집 — 24시간 = 서버 창이 하루 닫혀 있어도 넘지 않는 폭). */
    static final Duration NEWS_LATE = Duration.ofSeconds(Datasets.MAX_AGE_SLOW);
    /** DART·거시 일정(주간 묶음, 12시간마다) 저장본이 이보다 오래되면 늦음. */
    static final Duration WEEKLY_LATE = Duration.ofSeconds(Datasets.MAX_AGE_WEEKLY);

    private KrCollectionStatus() {
    }

    /**
     * 상태 응답의 {@code collection} — 순서 quotes · flows · universe · dart · news · calendar · fsc.
     *
     * @param market 그 조회가 연 한국 실행(관측치·수급 늦음의 달력 한 벌)
     * @param now    지금(늦음 판정)
     */
    static Map<String, Object> view(StoreReader reader, PaperMarketData data, MarketRun market, Instant now) {
        PaperMarketData.FscLatest fsc = data.fscLatest();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("quotes", quotes(reader, market, now));
        out.put("flows", flows(reader, market, now));
        out.put("universe", universe(data.krUniverseLatest(), fsc.stocks()));
        out.put("dart", dart(reader, now));
        out.put("news", news(reader, now));
        out.put("calendar", calendar(reader, now));
        out.put("fsc", fsc(reader, fsc));
        return out;
    }

    // ------------------------------------------------------------------ 관측치·수급(토스, KR 거래일 20:30 뒤 하루 1회)
    private static Map<String, Object> quotes(StoreReader reader, MarketRun market, Instant now) {
        Optional<Snapshot> found = reader.readStoredMeta(Datasets.SNAP_KR_PAPER_QUOTES, "codes");
        JsonNode payload = payload(found);
        Map<String, Object> out = head("kr_paper_quotes", Datasets.SNAP_KR_PAPER_QUOTES, payload != null);
        Instant collected = payload == null ? null : found.get().collectedAt();
        LocalDate session = payload == null ? null : Json.parseDate(Json.asText(payload, "session"));
        out.put("collectedAtKst", stamp(collected));
        out.put("session", text(session));
        out.put("universeDate", payload == null ? null : text(Json.parseDate(Json.asText(payload, "universeDate"))));
        out.put("scope", payload == null ? null : scopeSize(payload));
        putMarketLateness(out, market, collected, session, now);
        return out;
    }

    /**
     * 수급 상태 저장본 — 종목 항목을 셉니다: {@code ok}(이번에 받은 OK — 이어받지 않음), 그중 세션 기록이 없던 종목 {@code sessionMiss}(토스의 늦은 판 —
     * 규칙 계좌의 '자료 부족'), {@code noRecords}(토스가 답했는데 기록 0건), {@code carried}(받지 못해 직전 항목을 이음 — {@code isStale}),
     * {@code missing}(수집 범위에 있는데 항목이 없음 — 이을 값도 없음).
     */
    private static Map<String, Object> flows(StoreReader reader, MarketRun market, Instant now) {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_KR_PAPER_FLOWS_STATUS);
        JsonNode payload = payload(found);
        Map<String, Object> out = head("kr_paper_flows", Datasets.SNAP_KR_PAPER_FLOWS_STATUS, payload != null);
        Instant collected = payload == null ? null : found.get().collectedAt();
        LocalDate session = payload == null ? null : Json.parseDate(Json.asText(payload, "session"));
        out.put("collectedAtKst", stamp(collected));
        out.put("session", text(session));
        out.put("universeDate", payload == null ? null : text(Json.parseDate(Json.asText(payload, "universeDate"))));
        out.put("scope", payload == null ? null : scopeSize(payload));
        Integer ok = null;
        Integer sessionMiss = null;
        Integer noRecords = null;
        Integer carried = null;
        Integer missing = null;
        JsonNode codes = payload == null ? null : Json.child(payload, "codes");
        if (codes != null && codes.isObject()) {
            int okCount = 0;
            int missCount = 0;
            int emptyCount = 0;
            int carriedCount = 0;
            Set<String> present = new HashSet<>();
            for (Map.Entry<String, JsonNode> entry : codes.properties()) {
                present.add(entry.getKey());
                JsonNode code = entry.getValue();
                if (Json.asBoolean(code, "isStale")) {
                    carriedCount++;
                } else if ("OK".equals(Json.asText(code, "status"))) {
                    okCount++;
                    LocalDate latest = Json.parseDate(Json.asText(code, "latestDate"));
                    if (session != null && (latest == null || !latest.equals(session))) {
                        missCount++;
                    }
                } else if ("NO_RECORDS".equals(Json.asText(code, "status"))) {
                    emptyCount++;
                }
            }
            ok = okCount;
            sessionMiss = session == null ? null : missCount;
            noRecords = emptyCount;
            carried = carriedCount;
            JsonNode scope = Json.child(payload, "scope");
            if (scope != null && scope.isArray()) {
                int absent = 0;
                for (JsonNode code : scope) {
                    if (!present.contains(code.asString(""))) {
                        absent++;
                    }
                }
                missing = absent;
            }
        }
        out.put("ok", ok);
        out.put("sessionMiss", sessionMiss);
        out.put("noRecords", noRecords);
        out.put("carried", carried);
        out.put("missing", missing);
        putMarketLateness(out, market, collected, session, now);
        return out;
    }

    /**
     * 관측치·수급의 늦음 — 개요 관측치 요약과 같은 시장 규칙({@link PaperMarket#quotesLateAt}, 그 실행의 달력). 저장본이 없으면 null, 달력이
     * 그 해를 모르면 null + 사유.
     */
    private static void putMarketLateness(Map<String, Object> out, MarketRun market, Instant collected, LocalDate session,
                                          Instant now) {
        Boolean stale = null;
        String reason = null;
        if (collected != null) {
            try {
                stale = !now.isBefore(market.quotesLateAt(collected, session, market.calendar()));
            } catch (CalendarUnavailableException e) {
                reason = e.getMessage();
            }
        }
        out.put("stale", stale);
        out.put("staleReason", reason);
    }

    // ------------------------------------------------------------------ 유니버스(금융위 최신 기준일 코스피 시총 상위 100 보통주)
    private static Map<String, Object> universe(PaperMarketData.KrUniverseLatest latest, LocalDate fscStocks) {
        Map<String, Object> out = head("kr_paper_universe", Datasets.OBS_KR_PAPER_UNIVERSE, latest != null);
        out.put("baseDate", latest == null ? null : latest.baseDate().toString());
        out.put("size", latest == null ? null : latest.size());
        Boolean behind = latest == null || fscStocks == null ? null : latest.baseDate().isBefore(fscStocks);
        out.put("behind", behind);
        out.put("behindReason", Boolean.TRUE.equals(behind)
                ? "유니버스 기준일 " + latest.baseDate() + "이 금융위 주식시세 최신 기준일 " + fscStocks + "보다 이릅니다 — 다음 slow 주기의 "
                        + "kr_paper_universe가 새 기준일로 계산합니다"
                : null);
        return out;
    }

    // ------------------------------------------------------------------ DART 사업보고서 주요계정(주간)
    private static Map<String, Object> dart(StoreReader reader, Instant now) {
        Optional<Snapshot> found = reader.readStoredMeta(Datasets.SNAP_DART_FUNDAMENTALS, "companies");
        JsonNode payload = payload(found);
        Map<String, Object> out = head("dart_fundamentals", Datasets.SNAP_DART_FUNDAMENTALS, payload != null);
        Instant collected = payload == null ? null : found.get().collectedAt();
        out.put("collectedAtKst", stamp(collected));
        out.put("universe", payload == null ? null : integer(payload, "universe"));
        out.put("krScope", payload == null ? null : integer(payload, "krScope"));
        JsonNode unmapped = payload == null ? null : Json.child(payload, "unmapped");
        out.put("unmapped", unmapped != null && unmapped.isArray() ? unmapped.size() : null);
        out.put("stale", olderThan(collected, WEEKLY_LATE, now));
        return out;
    }

    // ------------------------------------------------------------------ 사건 뉴스 RSS(매시)
    private static Map<String, Object> news(StoreReader reader, Instant now) {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_KR_NEWS_STATUS);
        JsonNode payload = payload(found);
        Map<String, Object> out = head("kr_news_headlines", Datasets.SNAP_KR_NEWS_STATUS, payload != null);
        // 피드를 하나라도 받은 마지막 수집 시각 — 저장본의 generatedAt, 없으면 저장 시각(미국 news와 같은 규칙).
        Instant fetched = payload == null ? null : parseInstant(Json.asText(payload, "generatedAt"));
        if (fetched == null && payload != null) {
            fetched = found.get().collectedAt();
        }
        out.put("lastFetchKst", stamp(fetched));
        out.put("stored7d", payload == null ? null : integer(payload, "stored7d"));
        out.put("feedsOk", payload == null ? null : integer(payload, "feedsOk"));
        out.put("feedsTotal", payload == null ? null : integer(payload, "feedsTotal"));
        List<Map<String, Object>> failed = null;
        if (payload != null) {
            failed = new ArrayList<>();
            for (JsonNode f : Json.array(payload, "failedFeeds")) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("feed", Json.asText(f, "feed"));
                row.put("source", Json.asText(f, "source"));
                row.put("reason", Json.asText(f, "reason"));
                failed.add(row);
            }
        }
        out.put("failedFeeds", failed);
        out.put("stale", olderThan(fetched, NEWS_LATE, now));
        return out;
    }

    // ------------------------------------------------------------------ 거시 일정(금통위 상수·주요 발표 상수, 주간)
    private static Map<String, Object> calendar(StoreReader reader, Instant now) {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_KR_CALENDAR);
        JsonNode payload = payload(found);
        Map<String, Object> out = head("kr_calendar", Datasets.SNAP_KR_CALENDAR, payload != null);
        Instant generated = payload == null ? null : parseInstant(Json.asText(payload, "generatedAt"));
        if (generated == null && payload != null) {
            generated = found.get().collectedAt();
        }
        JsonNode macro = payload == null ? null : Json.child(payload, "macro");
        JsonNode events = macro == null ? null : Json.child(macro, "events");
        JsonNode unconfirmed = macro == null ? null : Json.child(macro, "unconfirmed");
        out.put("generatedAtKst", stamp(generated));
        out.put("macroCount", events != null && events.isArray() ? events.size() : null);
        out.put("unconfirmed", unconfirmed != null && unconfirmed.isArray() ? unconfirmed.size() : null);
        out.put("horizonTo", macro == null ? null : text(Json.parseDate(Json.asText(Json.child(macro, "horizon"), "to"))));
        out.put("stale", olderThan(generated, WEEKLY_LATE, now));
        return out;
    }

    // ------------------------------------------------------------------ 금융위 주식시세·증권상품시세(확정치, 다음 영업일 13시 뒤)
    private static Map<String, Object> fsc(StoreReader reader, PaperMarketData.FscLatest latest) {
        Optional<Snapshot> meta = reader.readStored(Datasets.SNAP_FSC_PRICES_META);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tasks", List.of("fsc_prices", "fsc_etf_prices"));
        out.put("available", latest.stocks() != null || latest.etfs() != null);
        out.put("stocksLatestBasDt", text(latest.stocks()));
        out.put("etfsLatestBasDt", text(latest.etfs()));
        out.put("metaCollectedAtKst", stamp(meta.map(Snapshot::collectedAt).orElse(null)));
        out.put("etfBehind", latest.stocks() == null || latest.etfs() == null ? null : latest.etfs().isBefore(latest.stocks()));
        return out;
    }

    // ------------------------------------------------------------------ 조각
    private static Map<String, Object> head(String task, String dataset, boolean available) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("task", task);
        out.put("dataset", dataset);
        out.put("available", available);
        return out;
    }

    private static JsonNode payload(Optional<Snapshot> found) {
        return found.map(Snapshot::payload).filter(JsonNode::isObject).orElse(null);
    }

    /** 저장본 머리의 수집 범위({@code scope} 배열) 종목 수 — 배열이 아니면 null. */
    private static Integer scopeSize(JsonNode payload) {
        JsonNode scope = Json.child(payload, "scope");
        return scope != null && scope.isArray() ? scope.size() : null;
    }

    /** 정수 칸 — 없거나 정수가 아니면 null(0으로 채우지 않음). */
    private static Integer integer(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isIntegralNumber() && v.canConvertToInt() ? v.intValue() : null;
    }

    /** 그 시각에서 {@code limit}보다 오래 지났나 — 시각을 모르면 null. */
    private static Boolean olderThan(Instant at, Duration limit, Instant now) {
        return at == null ? null : Duration.between(at, now).compareTo(limit) > 0;
    }

    /** ISO 시각(오프셋 포함, 수집기의 {@code datetime.isoformat()}). 없거나 읽을 수 없으면 null. */
    private static Instant parseInstant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text.strip()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String stamp(Instant moment) {
        return moment == null ? null : Kst.stamp(moment);
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
