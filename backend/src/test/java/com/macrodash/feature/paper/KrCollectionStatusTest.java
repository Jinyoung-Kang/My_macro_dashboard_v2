package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 수집 상태 요약(2단계 명세 §9 x4 — 사용자 결정 2026-10-29): 저장본·최신 기준일만 읽고(수집 유발 없음 — {@code read()}를 부르지 않음, 큰 키는
 * 메타로 뺌), 모르는 값은 null(0이 아님), 관측치·수급은 시장 늦음 규칙(다음 수집 예정 + 2시간 5분), DART·일정 7일, 뉴스 24시간, 유니버스·ETF는
 * 기준일 비교(뒤처짐).
 */
class KrCollectionStatusTest {

    /** 금요일 세션 — 다음 수집 예정은 월요일(11-02) 서버 기동(뉴욕 09:20 = 겨울 23:20 KST)이라 늦음은 11-03 01:25부터. */
    private static final LocalDate SESSION = LocalDate.of(2026, 10, 30);
    private static final Instant COLLECTED = kst("2026-10-30T22:05");

    private StoreReader reader;
    private StoreRepository repository;
    private MarketRun run;

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        reader = mock(StoreReader.class);
        repository = mock(StoreRepository.class);
        run = runWith(KrFixtures.holidays(2026, 2027));
    }

    private static MarketRun runWith(Snapshot holidays) {
        KrPaperMarket kr = KrPaperMarket.INSTANCE;
        return new MarketRun(kr, kr.openCalendar(KrFixtures.inputs(null, holidays)), null);
    }

    private Map<String, Object> view(Instant now) {
        return KrCollectionStatus.view(reader, new PaperMarketData(reader, repository), run, now);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> part(Map<String, Object> view, String key) {
        return (Map<String, Object>) view.get(key);
    }

    private static Snapshot snapshot(String name, JsonNode payload, Instant collectedAt) {
        return KrFixtures.snapshot(name, payload, collectedAt);
    }

    private static ObjectNode head(LocalDate session, String... scope) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("session", session.toString());
        payload.put("universeDate", "2026-10-29");
        ArrayNode codes = payload.putArray("scope");
        for (String code : scope) {
            codes.add(code);
        }
        return payload;
    }

    private void stubQuotes(Instant collected, LocalDate session) {
        when(reader.readStoredMeta(Datasets.SNAP_KR_PAPER_QUOTES, "codes"))
                .thenReturn(Optional.of(snapshot(Datasets.SNAP_KR_PAPER_QUOTES, head(session, "069500", "153130", "005930"),
                        collected)));
    }

    @Test
    @DisplayName("저장본이 하나도 없으면 묶음마다 available:false·숫자 null(0이 아님) — 순서 quotes·flows·universe·dart·news·calendar·fsc, read()는 부르지 않음")
    void nothingStoredMeansUnknown() {
        Map<String, Object> view = view(kst("2026-11-02T22:00"));

        assertThat(view.keySet()).containsExactly("quotes", "flows", "universe", "dart", "news", "calendar", "fsc");
        assertThat(part(view, "quotes")).containsEntry("task", "kr_paper_quotes").containsEntry("dataset", "paper.kr.quotes")
                .containsEntry("available", false).containsEntry("collectedAtKst", null).containsEntry("session", null)
                .containsEntry("scope", null).containsEntry("stale", null).containsEntry("staleReason", null);
        assertThat(part(view, "flows")).containsEntry("available", false).containsEntry("ok", null)
                .containsEntry("noRecords", null).containsEntry("carried", null).containsEntry("missing", null)
                .containsEntry("stale", null);
        assertThat(part(view, "universe")).containsEntry("available", false).containsEntry("baseDate", null)
                .containsEntry("size", null).containsEntry("behind", null);
        assertThat(part(view, "dart")).containsEntry("available", false).containsEntry("universe", null)
                .containsEntry("unmapped", null).containsEntry("stale", null);
        assertThat(part(view, "news")).containsEntry("available", false).containsEntry("stored7d", null)
                .containsEntry("failedFeeds", null).containsEntry("stale", null);
        assertThat(part(view, "calendar")).containsEntry("available", false).containsEntry("macroCount", null)
                .containsEntry("stale", null);
        assertThat(part(view, "fsc")).containsEntry("tasks", List.of("fsc_prices", "fsc_etf_prices"))
                .containsEntry("available", false).containsEntry("stocksLatestBasDt", null)
                .containsEntry("etfsLatestBasDt", null).containsEntry("etfBehind", null);
        verify(reader, never()).read(anyString(), anyLong(), nullable(String.class));
    }

    @Test
    @DisplayName("관측치 늦음 경계 — 금요일 세션은 월요일 서버 기동(뉴욕 09:20 = 겨울 23:20 KST) + 2시간 5분(11-03 01:25)부터 늦음, 세션·기준일·범위 수는 머리 칸 그대로(codes는 메타로 뺌)")
    void quotesLatenessFollowsTheMarketRule() {
        stubQuotes(COLLECTED, SESSION);

        Map<String, Object> before = part(view(kst("2026-11-03T01:24")), "quotes");
        assertThat(before).containsEntry("available", true).containsEntry("collectedAtKst", "2026-10-30 22:05 KST")
                .containsEntry("session", "2026-10-30").containsEntry("universeDate", "2026-10-29")
                .containsEntry("scope", 3).containsEntry("stale", false).containsEntry("staleReason", null);
        assertThat(part(view(kst("2026-11-03T01:25")), "quotes")).containsEntry("stale", true);
        verify(reader, never()).readStored(Datasets.SNAP_KR_PAPER_QUOTES);
    }

    @Test
    @DisplayName("달력이 다음 수집일의 해를 모르면 늦음을 짓지 않고 null + 사유(명세 K35)")
    void unknownCalendarYearLeavesLatenessUnknown() {
        run = runWith(KrFixtures.holidays(2026));
        stubQuotes(kst("2026-12-30T22:05"), LocalDate.of(2026, 12, 30));

        Map<String, Object> quotes = part(view(kst("2026-12-31T10:00")), "quotes");
        assertThat(quotes).containsEntry("available", true).containsEntry("stale", null);
        assertThat((String) quotes.get("staleReason")).contains("달력 없음");
    }

    @Test
    @DisplayName("수급 셈 — 이번에 받은 OK(그중 세션 기록 없음)·기록 없음·이어받음(isStale)·범위에 있는데 항목 없음, 늦음은 관측치와 같은 규칙")
    void flowsCountsTheCodes() {
        ObjectNode payload = head(SESSION, "005930", "000660", "373220", "207940", "005380");
        ObjectNode codes = payload.putObject("codes");
        codes.putObject("005930").put("status", "OK").put("latestDate", "2026-10-30");
        codes.putObject("000660").put("status", "OK").put("latestDate", "2026-10-29");
        codes.putObject("373220").put("status", "NO_RECORDS");
        codes.putObject("207940").put("status", "OK").put("latestDate", "2026-10-29").put("isStale", true);
        when(reader.readStored(Datasets.SNAP_KR_PAPER_FLOWS_STATUS))
                .thenReturn(Optional.of(snapshot(Datasets.SNAP_KR_PAPER_FLOWS_STATUS, payload, kst("2026-10-30T22:10"))));

        Map<String, Object> flows = part(view(kst("2026-11-02T22:00")), "flows");
        assertThat(flows).containsEntry("task", "kr_paper_flows").containsEntry("dataset", "kr.paper_flows.status")
                .containsEntry("available", true).containsEntry("session", "2026-10-30").containsEntry("scope", 5)
                .containsEntry("ok", 2).containsEntry("sessionMiss", 1).containsEntry("noRecords", 1)
                .containsEntry("carried", 1).containsEntry("missing", 1).containsEntry("stale", false);
        assertThat(part(view(kst("2026-11-03T01:25")), "flows")).containsEntry("stale", true);
    }

    @Test
    @DisplayName("유니버스·금융위: 수집 시각 칸이 없어 기준일 비교 — U 기준일 < 주식 최신이면 뒤처짐(사유), ETF 최신 < 주식 최신이면 etfBehind")
    void universeAndFscCompareBaseDates() {
        when(repository.latestObservationDate(Datasets.OBS_KR_PAPER_UNIVERSE)).thenReturn(LocalDate.of(2026, 10, 27));
        when(repository.readObservations(eq(Datasets.OBS_KR_PAPER_UNIVERSE), eq(LocalDate.of(2026, 10, 27)), isNull(), isNull()))
                .thenReturn(Collections.nCopies(100, MAPPER.createObjectNode()));
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(LocalDate.of(2026, 10, 28));
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenReturn(LocalDate.of(2026, 10, 27));
        when(reader.readStored(Datasets.SNAP_FSC_PRICES_META)).thenReturn(Optional.of(snapshot(Datasets.SNAP_FSC_PRICES_META,
                KrFixtures.fscMeta(LocalDate.of(2026, 10, 28)), kst("2026-10-29T22:10"))));

        Map<String, Object> view = view(kst("2026-10-29T23:00"));
        assertThat(part(view, "universe")).containsEntry("task", "kr_paper_universe").containsEntry("available", true)
                .containsEntry("baseDate", "2026-10-27").containsEntry("size", 100).containsEntry("behind", true);
        assertThat((String) part(view, "universe").get("behindReason")).contains("2026-10-27").contains("2026-10-28");
        assertThat(part(view, "fsc")).containsEntry("available", true).containsEntry("stocksLatestBasDt", "2026-10-28")
                .containsEntry("etfsLatestBasDt", "2026-10-27").containsEntry("metaCollectedAtKst", "2026-10-29 22:10 KST")
                .containsEntry("etfBehind", true);

        when(repository.latestObservationDate(Datasets.OBS_KR_PAPER_UNIVERSE)).thenReturn(LocalDate.of(2026, 10, 28));
        when(repository.readObservations(eq(Datasets.OBS_KR_PAPER_UNIVERSE), eq(LocalDate.of(2026, 10, 28)), isNull(), isNull()))
                .thenReturn(Collections.nCopies(100, MAPPER.createObjectNode()));
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenReturn(LocalDate.of(2026, 10, 28));
        Map<String, Object> caughtUp = view(kst("2026-10-29T23:00"));
        assertThat(part(caughtUp, "universe")).containsEntry("behind", false).containsEntry("behindReason", null);
        assertThat(part(caughtUp, "fsc")).containsEntry("etfBehind", false);
    }

    @Test
    @DisplayName("DART는 메타만(companies를 뺀 읽기 — 전체 저장본을 읽지 않음): 유니버스·한국 범위·매핑 없음 수, 7일 넘으면 늦음")
    void dartReadsTheMetaOnly() {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("universe", 174).put("krScope", 101);
        payload.putArray("unmapped").add("069500").add("153130").add("005935");
        when(reader.readStoredMeta(Datasets.SNAP_DART_FUNDAMENTALS, "companies"))
                .thenReturn(Optional.of(snapshot(Datasets.SNAP_DART_FUNDAMENTALS, payload, kst("2026-10-22T01:00"))));

        Map<String, Object> fresh = part(view(kst("2026-10-29T01:00")), "dart");
        assertThat(fresh).containsEntry("task", "dart_fundamentals").containsEntry("available", true)
                .containsEntry("collectedAtKst", "2026-10-22 01:00 KST").containsEntry("universe", 174)
                .containsEntry("krScope", 101).containsEntry("unmapped", 3).containsEntry("stale", false);
        assertThat(part(view(kst("2026-10-29T01:01")), "dart")).containsEntry("stale", true);
        verify(reader, never()).readStored(Datasets.SNAP_DART_FUNDAMENTALS);
    }

    @Test
    @DisplayName("사건 뉴스(24시간)·거시 일정(7일): 저장본의 generatedAt 기준, 실패 피드·일정 수·미확인 발표 수·창 끝")
    void newsAndCalendar() {
        ObjectNode news = MAPPER.createObjectNode();
        news.put("generatedAt", "2026-10-28T20:08:11+00:00").put("stored7d", 387).put("feedsOk", 3).put("feedsTotal", 4);
        news.putArray("failedFeeds").addObject().put("feed", "yna_market").put("source", "연합뉴스").put("reason", "HTTP 503");
        when(reader.readStored(Datasets.SNAP_KR_NEWS_STATUS))
                .thenReturn(Optional.of(snapshot(Datasets.SNAP_KR_NEWS_STATUS, news, kst("2026-10-29T05:08"))));
        ObjectNode calendar = MAPPER.createObjectNode();
        calendar.put("generatedAt", "2026-10-28T16:10:17+00:00");
        ObjectNode macro = calendar.putObject("macro");
        macro.putArray("events").addObject().put("date", "2026-11-26").put("kind", "MPB");
        macro.putArray("unconfirmed").add("CPI").add("GDP");
        macro.putObject("horizon").put("from", "2026-10-29").put("to", "2026-12-13");
        when(reader.readStored(Datasets.SNAP_KR_CALENDAR))
                .thenReturn(Optional.of(snapshot(Datasets.SNAP_KR_CALENDAR, calendar, kst("2026-10-29T01:10"))));

        Map<String, Object> view = view(kst("2026-10-30T05:08"));
        assertThat(part(view, "news")).containsEntry("task", "kr_news_headlines").containsEntry("available", true)
                .containsEntry("lastFetchKst", "2026-10-29 05:08 KST").containsEntry("stored7d", 387)
                .containsEntry("feedsOk", 3).containsEntry("feedsTotal", 4).containsEntry("stale", false)
                .containsEntry("failedFeeds", List.of(Map.of("feed", "yna_market", "source", "연합뉴스", "reason", "HTTP 503")));
        assertThat(part(view(kst("2026-10-30T05:09")), "news")).containsEntry("stale", true);
        assertThat(part(view, "calendar")).containsEntry("task", "kr_calendar").containsEntry("available", true)
                .containsEntry("generatedAtKst", "2026-10-29 01:10 KST").containsEntry("macroCount", 1)
                .containsEntry("unconfirmed", 2).containsEntry("horizonTo", "2026-12-13").containsEntry("stale", false);
    }
}
