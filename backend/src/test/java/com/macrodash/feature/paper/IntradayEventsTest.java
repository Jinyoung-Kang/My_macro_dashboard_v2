package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 장중 판단 사건({@link IntradayScheduler#events} — ADR 0031 결정 7, 단순판 — 통합 검토 R10): 순수 판정({@link IntradayScheduler#detect}의 문턱·
 * 자료 조건, {@link IntradayScheduler#planEvents}의 걸음)과 FakePaperStore 위의 처리(스위치·당김·붙임·새 행·버림·세션에 한 번·문).
 *
 * <p>미국 세션 2026-11-09(월, EST — 개장 14:30Z, 받는 범위 09:40~15:30 ET), 한국 2026-12-02(수).
 */
class IntradayEventsTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate MON = LocalDate.of(2026, 11, 9);
    private static final LocalDate FRI = LocalDate.of(2026, 11, 6);
    private static final LocalDate KR_DAY = LocalDate.of(2026, 12, 2);

    private FakePaperStore store;
    private IntradayScheduler scheduler;
    private String blocked;
    private Snapshot monitor;
    private int monitorReads;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = Instant.parse("2026-11-07T00:00:00Z");
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        body().put(IntradayPolicy.US_EVENTS, true).put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        ((ObjectNode) body().get("stopWatch")).put("mode", "SHADOW");
        ((ObjectNode) body().get("claude")).put("freeTiming", true);
        ((ObjectNode) body().get("claude2")).put("enabled", true).put("freeTiming", true);
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2)) {
            store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, FRI, PaperBooks.ACTIVE, store.dbNow));
        }
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
    }

    private ObjectNode body() {
        return (ObjectNode) store.settings.body();
    }

    private static Instant et(int hour, int minute, int second) {
        return ZonedDateTime.of(MON, LocalTime.of(hour, minute, second), US.zone()).toInstant();
    }

    private static Instant kst(int hour, int minute) {
        return ZonedDateTime.of(KR_DAY, LocalTime.of(hour, minute), KR.zone()).toInstant();
    }

    /** 그 세션의 자유 시점 판 결정 — 사건 행이 붙는 결정. */
    private long freeDecision(String code) {
        String packet = "{\"1_basis\":{\"book\":\"" + code + "\",\"variant\":\"" + PacketBuilder.VARIANT_FREE + "\"}}";
        return store.insertDecisionIfAbsent(new Decision(0, code, FRI, RuleBookService.SCHEDULED, null, "NO_TRADE", "claude-sonnet-5-5",
                0, 1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0, packet)).orElseThrow();
    }

    private static IntradayPlan row(int slot, LocalTime at, String status) {
        IntradayPlan p = IntradayPlan.planned(PaperBooks.CLAUDE, MON, slot, at, "HOURLY", List.of(), "q", "ft-2", false, 1L, null);
        return new IntradayPlan(p.bookCode(), p.sessionDate(), p.slot(), p.atLocal(), p.feed(), p.watch(), p.question(), p.variant(),
                p.manual(), p.sourceDecisionId(), null, null, status, null, null, null, null, null, p.origin(), null);
    }

    /** 미국 감시 저장본 한 종목(contract 1) — 전일 종가(Yahoo)·그날 첫 분 종가·마지막 봉(09:59 ET 시작) 종가. */
    private static ObjectNode usEntry(ObjectNode tickers, String ticker, double prevClose, double first, double last) {
        ObjectNode entry = tickers.putObject(ticker);
        entry.put("session", MON.toString()).put("prevClose", prevClose);
        entry.putObject("day").putObject("first").put("t", "2026-11-09T14:30:00+00:00").put("c", first);
        entry.putArray("bars").addObject().put("t", "2026-11-09T14:59:00+00:00").put("c", last);
        return entry;
    }

    private static Snapshot usSnapshot(Instant fetchedAt, ObjectNode tickers) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1).put("market", "US").put("reference", "SPY").put("fetchedAt", fetchedAt.toString());
        payload.set("tickers", tickers);
        return new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_US, payload, "json", "ok", null, fetchedAt);
    }

    private static Position position(String code, String ticker, double highWatermark) {
        return new Position(code, ticker, 10, 100.0, FRI, Instant.parse("2026-11-06T15:00:00Z"), highWatermark, null, 100.0, null, false,
                null, 0, null);
    }

    private Map<String, String> events(Instant now) {
        return scheduler.events(PaperIntradayJob.BOOKS, store.settings, US, false, now, (code, source) -> blocked,
                new IntradayScheduler.EventSource() {
                    @Override
                    public Optional<Snapshot> monitor() {
                        monitorReads++;
                        return Optional.ofNullable(monitor);
                    }

                    @Override
                    public List<IntradayScheduler.Held> held(String code, LocalDate session) {
                        return IntradayScheduler.held(store.positions(code), PaperSettings.from(store.settings.body(),
                                UsPaperMarket.INSTANCE), List.of(), US.previousTradingDay(session), Position::highWatermark);
                    }

                    @Override
                    public double stopPct() {
                        return 8.0;
                    }
                });
    }

    private List<String> types(List<IntradayScheduler.Event> events) {
        List<String> out = new ArrayList<>();
        events.forEach(e -> out.add(e.key()));
        return out;
    }

    // ------------------------------------------------------------------ 순수 판정
    @Test
    @DisplayName("문턱: 보유 ±4%(3.99% 없음·4.00% 있음 — 위·아래 따로), 지수 SPY ±1.5%(1.49 없음·1.50 있음), 스탑 근접은 스탑가 위 2% 안(스탑가와 같거나 아래·2% 넘음은 없음)")
    void thresholds() {
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 98.5);         // −1.50%
        usEntry(tickers, "AAA", 100.0, 100.0, 104.0);        // +4.00%
        usEntry(tickers, "BBB", 100.0, 100.0, 96.01);        // −3.99%
        usEntry(tickers, "CCC", 95.0, 95.0, 93.8);           // 스탑가 92(최고가 100) 위 1.96%, 전일 대비 −1.26%
        usEntry(tickers, "DDD", 93.0, 93.0, 92.0);           // 스탑가와 같음 — 감시의 몫
        usEntry(tickers, "EEE", 95.0, 95.0, 94.0);           // 스탑가 위 2.17%
        List<IntradayScheduler.Held> held = List.of(new IntradayScheduler.Held("AAA", 100, null),
                new IntradayScheduler.Held("BBB", 100, null), new IntradayScheduler.Held("CCC", 100, null),
                new IntradayScheduler.Held("DDD", 100, null), new IntradayScheduler.Held("EEE", 100, null));
        List<IntradayScheduler.Event> events = IntradayScheduler.detect(usSnapshot(et(10, 0, 20), tickers).payload(), MON, US, false, held,
                8.0);
        assertThat(types(events)).containsExactly("INDEX_MOVE:SPY:DOWN", "HELD_MOVE:AAA:UP", "NEAR_STOP:CCC");
        IntradayScheduler.Event near = events.get(2);
        assertThat(near.stopPrice()).isEqualTo(92.0);
        assertThat(near.distancePct()).isBetween(1.95, 1.97);
        assertThat(events.get(1).changePct()).isBetween(3.999, 4.001);
        JsonNode json = events.get(0).toJson(MAPPER, US, false);
        assertThat(json.toString()).isEqualTo("{\"type\":\"INDEX_MOVE\",\"ticker\":\"SPY\",\"direction\":\"DOWN\",\"prevClose\":100.0,"
                + "\"last\":98.5,\"changePct\":-1.5,\"barEt\":\"09:59\"}");

        ObjectNode small = MAPPER.createObjectNode();
        usEntry(small, "SPY", 100.0, 100.0, 98.51);          // −1.49%
        usEntry(small, "AAA", 100.0, 100.0, 96.0);           // −4.00%
        assertThat(types(IntradayScheduler.detect(usSnapshot(et(10, 0, 20), small).payload(), MON, US, false,
                List.of(new IntradayScheduler.Held("AAA", 200, null)), 8.0))).as("지수 1.49% 없음, 보유 −4.00%(최고가 200 — 스탑과 멂)")
                .containsExactly("HELD_MOVE:AAA:DOWN");
    }

    @Test
    @DisplayName("자료 조건: 다른 세션·이어받은 항목·전일 종가 모름·갭 가드(첫 분 ≤ 전일 × 0.85 — 기업행위 의심)·Yahoo와 장부 전일 종가가 2% 넘게 다르면 사건 없음. "
            + "장부 전일 종가가 있으면 그 값이 기준")
    void dataConditions() {
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 97.0).put("session", "2026-11-06");
        usEntry(tickers, "AAA", 100.0, 100.0, 90.0).put("isStale", true);
        usEntry(tickers, "BBB", 100.0, 80.0, 80.0);          // 첫 분 80 ≤ 100 × 0.85 — 가드
        ObjectNode ccc = usEntry(tickers, "CCC", 100.0, 100.0, 90.0);
        ccc.remove("prevClose");                             // 전일 종가 모름 — 가드 판단 못함
        usEntry(tickers, "DDD", 100.0, 99.0, 95.0);          // 장부 전일 99.0 기준 −4.04%
        usEntry(tickers, "EEE", 103.0, 100.0, 96.0);         // Yahoo 103 ≠ 장부 100(2.9%) — 분할 의심 가드
        List<IntradayScheduler.Held> held = List.of(new IntradayScheduler.Held("AAA", 100, null),
                new IntradayScheduler.Held("BBB", 100, null), new IntradayScheduler.Held("CCC", 100, null),
                new IntradayScheduler.Held("DDD", 200, 99.0), new IntradayScheduler.Held("EEE", 200, 100.0));
        List<IntradayScheduler.Event> events = IntradayScheduler.detect(usSnapshot(et(10, 0, 20), tickers).payload(), MON, US, false, held,
                8.0);
        assertThat(types(events)).containsExactly("HELD_MOVE:DDD:DOWN");
        assertThat(events.get(0).prevClose()).isEqualTo(99.0);

        // 한국: 전일 종가는 토스 일봉 원시 값, 봉 시각은 봉 끝 라벨(barKst), 지수 069500.
        ObjectNode kr = MAPPER.createObjectNode();
        ObjectNode index = kr.putObject("069500");
        index.put("session", KR_DAY.toString());
        index.putObject("prevClose").put("raw", 40_000).put("adjusted", 40_000);
        index.putObject("day").putObject("first").put("label", "09:01").put("o", 40_000);
        index.putArray("bars").addObject().put("label", "10:05").put("o", 39_500).put("h", 39_500).put("l", 39_300).put("c", 39_380)
                .put("v", 1_000);
        List<IntradayScheduler.Event> krEvents = IntradayScheduler.detect(MAPPER.createObjectNode().set("tickers", kr), KR_DAY, KR, true,
                List.of(), 8.0);
        assertThat(types(krEvents)).containsExactly("INDEX_MOVE:069500:DOWN");
        assertThat(krEvents.get(0).toJson(MAPPER, KR, true).get("barKst").asString()).isEqualTo("10:05");
    }

    @Test
    @DisplayName("걸음: 남은 예약이 없으면 지금 + 1분(개장 직후는 받는 범위 시작 09:40, 끝난 판단 + 20분)에 새 행, 남은 예약이 그 시각 뒤면 당김·앞이면 사건만 붙임, "
            + "순번을 다 씀·받는 범위에 남은 시각 없음이면 버림, 창이 끝난 PLANNED가 남아 있으면 기다림")
    void steps() {
        IntradayScheduler.EventPlan first = IntradayScheduler.planEvents(List.of(), MON, US, false, et(9, 36, 20), 3);
        assertThat(first.step()).isEqualTo(IntradayScheduler.EventStep.APPEND);
        assertThat(first.slot()).isEqualTo(1);
        assertThat(first.at()).as("받는 범위 시작").isEqualTo(LocalTime.of(9, 40));
        IntradayScheduler.EventPlan afterDone = IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_DONE)),
                MON, US, false, et(10, 5, 20), 3);
        assertThat(afterDone.step()).isEqualTo(IntradayScheduler.EventStep.APPEND);
        assertThat(afterDone.slot()).isEqualTo(2);
        assertThat(afterDone.at()).as("끝난 판단 + 20분").isEqualTo(LocalTime.of(10, 20));
        IntradayScheduler.EventPlan pull = IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(14, 0), PaperBooks.CHECKPOINT_PLANNED),
                row(2, LocalTime.of(15, 0), PaperBooks.CHECKPOINT_PLANNED)), MON, US, false, et(10, 5, 20), 3);
        assertThat(pull.step()).isEqualTo(IntradayScheduler.EventStep.PULL);
        assertThat(pull.row().slot()).as("가장 이른 예약").isEqualTo(1);
        assertThat(pull.at()).isEqualTo(LocalTime.of(10, 6));
        IntradayScheduler.EventPlan attach = IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(10, 5), PaperBooks.CHECKPOINT_PLANNED)),
                MON, US, false, et(10, 5, 20), 3);
        assertThat(attach.step()).as("곧 부를 예약 — 사건만 붙임").isEqualTo(IntradayScheduler.EventStep.ATTACH);
        assertThat(IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_DONE),
                row(2, LocalTime.of(11, 0), PaperBooks.CHECKPOINT_EXPIRED), row(3, LocalTime.of(12, 0), PaperBooks.CHECKPOINT_SKIPPED)), MON, US,
                false, et(13, 0, 20), 3).reason()).isEqualTo(IntradayScheduler.NO_SLOT);
        assertThat(IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(15, 20), PaperBooks.CHECKPOINT_DONE)), MON, US, false,
                et(15, 25, 0), 3).reason()).as("15:20 + 20분 > 15:30").isEqualTo(IntradayScheduler.NO_TIME);
        assertThat(IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_PLANNED)), MON, US, false,
                et(10, 21, 0), 3).step()).as("창(+20분)이 끝났는데 아직 PLANNED").isEqualTo(IntradayScheduler.EventStep.WAIT);
        assertThat(IntradayScheduler.planEvents(List.of(row(1, LocalTime.of(9, 35), PaperBooks.CHECKPOINT_PLANNED)), MON, US, false,
                et(9, 50, 0), 3).step()).as("받는 범위 밖 예약(배포 전 09:35) — 작업이 닫을 때까지").isEqualTo(IntradayScheduler.EventStep.WAIT);
        assertThat(IntradayScheduler.planEvents(List.of(), KR_DAY, KR, true, kst(14, 45), 3).at()).as("한국 범위 끝 14:50 안")
                .isEqualTo(LocalTime.of(14, 46));
    }

    // ------------------------------------------------------------------ 처리
    @Test
    @DisplayName("스위치: 사건(intradayEvents)이나 장중 스탑 감시(SHADOW·ON)가 꺼져 있으면 저장본도 읽지 않음 — 기본 설정은 늘 꺼짐. 묵은 저장본(10분 넘음)·"
            + "받는 범위 뒤·개장 전이면 아무것도 하지 않음")
    void switchesAndStaleness() {
        freeDecision(PaperBooks.CLAUDE);
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 98.0);
        monitor = usSnapshot(et(10, 0, 20), tickers);
        ((ObjectNode) body().get("stopWatch")).put("mode", "OFF");
        assertThat(events(et(10, 1, 0))).isEmpty();
        ((ObjectNode) body().get("stopWatch")).put("mode", "SHADOW");
        body().put(IntradayPolicy.US_EVENTS, false);
        assertThat(events(et(10, 1, 0))).isEmpty();
        assertThat(monitorReads).as("꺼져 있으면 읽지 않음").isZero();
        assertThat(IntradayScheduler.eventsWanted(PaperIntradayJob.BOOKS, PaperFixtures.settings(store).defaultsJson(), false))
                .as("기본 설정").isFalse();

        body().put(IntradayPolicy.US_EVENTS, true);
        assertThat(events(et(10, 10, 21))).as("저장본 10분 1초 묵음").isEmpty();
        assertThat(events(et(15, 30, 30))).as("받는 범위 뒤").isEmpty();
        assertThat(events(et(9, 29, 0))).as("개장 전").isEmpty();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON)).isEmpty();
    }

    @Test
    @DisplayName("새 행: 남은 예약이 없으면 계좌마다 사건 행(지금 + 1분·출처 EVENT·감시 1분봉·사건 종목 감시·수동 아님·그 세션의 결정·사건 trigger) — 같은 저장본·"
            + "다음 저장본의 같은 사건은 다시 쓰지 않음(세션에 한 번), 새 사건은 그 행에 붙음(곧 부를 행)")
    void appendsOnceThenAttaches() {
        long source = freeDecision(PaperBooks.CLAUDE);
        freeDecision(PaperBooks.CLAUDE2);
        store.upsertPosition(position(PaperBooks.CLAUDE, "AAA", 200));
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 98.4);
        usEntry(tickers, "AAA", 50.0, 50.0, 50.5);
        monitor = usSnapshot(et(10, 0, 20), tickers);

        Map<String, String> changes = events(et(10, 1, 10));
        assertThat(changes).containsEntry("claude 2026-11-09 #1", "PLANNED EVENT 10:02 ET — INDEX_MOVE SPY DOWN -1.60%")
                .containsEntry("claude2 2026-11-09 #1", "PLANNED EVENT 10:02 ET — INDEX_MOVE SPY DOWN -1.60%");
        IntradayPlan made = store.intradayPlans(PaperBooks.CLAUDE, MON).get(0);
        assertThat(made.origin()).isEqualTo(IntradayPlan.ORIGIN_EVENT);
        assertThat(made.feed()).isEqualTo(ExecutionSection.FEED_MINUTE);
        assertThat(made.watch()).containsExactly("SPY");
        assertThat(made.manual()).isFalse();
        assertThat(made.sourceDecisionId()).isEqualTo(source);
        assertThat(made.question()).isEqualTo(IntradayScheduler.EVENT_QUESTION);
        assertThat(made.variant()).isEqualTo(PacketBuilder.FREE_FIXED_RULES_VERSION);
        assertThat(made.trigger().has("originalAt")).isFalse();
        assertThat(made.trigger().get("events").get(0).get("type").asString()).isEqualTo("INDEX_MOVE");

        assertThat(events(et(10, 2, 0))).as("같은 저장본").isEmpty();
        monitor = usSnapshot(et(10, 5, 20), tickers);
        assertThat(events(et(10, 5, 40))).as("다음 저장본의 같은 사건 — 세션에 한 번").isEmpty();

        usEntry(tickers, "AAA", 50.0, 50.0, 47.9);           // −4.2%
        monitor = usSnapshot(et(10, 10, 20), tickers);
        Map<String, String> attached = events(et(10, 10, 40));
        assertThat(attached).containsOnlyKeys("claude 2026-11-09 #1");
        assertThat(attached.get("claude 2026-11-09 #1")).startsWith("EVENT ATTACH 10:02 ET — HELD_MOVE AAA DOWN");
        IntradayPlan merged = store.intradayPlans(PaperBooks.CLAUDE, MON).get(0);
        assertThat(merged.trigger().get("events")).extracting(e -> e.get("ticker").asString()).containsExactly("SPY", "AAA");
        assertThat(merged.atLocal()).isEqualTo(LocalTime.of(10, 2));

        IntradayScheduler fresh = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        scheduler = fresh;
        assertThat(events(et(10, 11, 0))).as("재기동 — 행의 trigger로 셈").isEmpty();
    }

    @Test
    @DisplayName("당김: 가장 이른 남은 예약(14:00 시간별)을 지금 + 1분으로 — 출처 EVENT·원래 시각 14:00·감시 1분봉(사건 종목 더함)·질문과 수동 표시 그대로, 뒤 예약은 "
            + "그대로. 부를 때 막히면(문) 당기지 않고 사건만 붙이고, 새 행은 버림(SUPPRESSED)")
    void pullsTheEarliestReservation() {
        long source = freeDecision(PaperBooks.CLAUDE);
        body().put(IntradayPolicy.US_EVENTS, true);
        ((ObjectNode) body().get("claude2")).put("freeTiming", false);
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, MON, 1, LocalTime.of(14, 0), "HOURLY", List.of(), "오후 확인",
                "ft-2", false, source, null));
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, MON, 2, LocalTime.of(15, 0), "HOURLY", List.of(), "마감 전",
                "ft-2", false, source, null));
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 101.6);
        monitor = usSnapshot(et(10, 0, 20), tickers);

        assertThat(events(et(10, 0, 40))).containsExactly(Map.entry("claude 2026-11-09 #1",
                "EVENT PULL 10:01 ET(원래 14:00) — INDEX_MOVE SPY UP +1.60%"));
        List<IntradayPlan> rows = store.intradayPlans(PaperBooks.CLAUDE, MON);
        assertThat(rows).extracting(p -> p.slot() + " " + p.atLocal() + " " + p.feed() + " " + p.origin() + " " + p.status())
                .containsExactly("1 10:01 MINUTE EVENT PLANNED", "2 15:00 HOURLY RESERVED PLANNED");
        assertThat(rows.get(0).question()).isEqualTo("오후 확인");
        assertThat(rows.get(0).watch()).containsExactly("SPY");
        assertThat(rows.get(0).manual()).isFalse();
        assertThat(rows.get(0).trigger().get("originalAt").asString()).isEqualTo("14:00");

        // 문이 막힘 — 당기지 않고 붙임.
        store.intradayPlans.clear();
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, MON, 1, LocalTime.of(14, 0), "HOURLY", List.of(), "오후 확인",
                "ft-2", false, source, null));
        blocked = PaperCheckpointJob.CALL_CAP;
        Map<String, String> attached = events(et(10, 0, 40));
        assertThat(attached.get("claude 2026-11-09 #1")).startsWith("EVENT ATTACH 14:00 ET(당기지 않음 — CALL_CAP");
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON).get(0).atLocal()).isEqualTo(LocalTime.of(14, 0));
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON).get(0).trigger().get("events")).hasSize(1);

        // 남은 예약이 없고 문이 막힘 — 버림, 같은 사건은 다시 보지 않음.
        store.intradayPlans.clear();
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        assertThat(events(et(10, 0, 40))).containsExactly(Map.entry("claude 2026-11-09 사건",
                "SUPPRESSED " + PaperCheckpointJob.CALL_CAP + ": INDEX_MOVE SPY UP +1.60%"));
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON)).isEmpty();
        blocked = null;
        monitor = usSnapshot(et(10, 5, 20), tickers);
        assertThat(events(et(10, 5, 40))).as("버린 사건도 세션에 한 번").isEmpty();
    }

    @Test
    @DisplayName("버림: 순번을 다 썼으면 SUPPRESSED NO_SLOT, 그 세션의 자유 시점 판 결정이 없으면 새 행을 넣지 않음(NO_DECISION), 계좌가 운용 중이 아니면 버림")
    void suppresses() {
        body().put(FreeTimingSettings.US_INTRADAY_MAX, 1);
        ((ObjectNode) body().get("claude2")).put("freeTiming", false);
        long source = freeDecision(PaperBooks.CLAUDE);
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(PaperBooks.CLAUDE, MON, 1, LocalTime.of(9, 45), "HOURLY", List.of(), "q", "ft-2",
                false, source, null));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, null, null, null);
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 98.0);
        monitor = usSnapshot(et(10, 30, 20), tickers);
        assertThat(events(et(10, 30, 40))).containsExactly(Map.entry("claude 2026-11-09 사건",
                "SUPPRESSED " + IntradayScheduler.NO_SLOT + ": INDEX_MOVE SPY DOWN -2.00%"));

        store.intradayPlans.clear();
        store.decisions.clear();
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        body().put(FreeTimingSettings.US_INTRADAY_MAX, 3);
        assertThat(events(et(10, 30, 40)).get("claude 2026-11-09 사건")).startsWith("SUPPRESSED " + IntradayScheduler.NO_DECISION);

        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        freeDecision(PaperBooks.CLAUDE);
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE, 100_000, FRI,
                PaperBooks.PAUSED, store.dbNow));
        assertThat(events(et(10, 30, 40)).get("claude 2026-11-09 사건")).startsWith("SUPPRESSED " + IntradayScheduler.NOT_ACTIVE);
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON)).isEmpty();
    }

    @Test
    @DisplayName("한국 처리: 한국 달력(받는 범위 09:10~14:50)과 저장본(069500·원시 전일 종가)으로 같은 규칙 — kr.intradayEvents·kr.stopWatch.mode를 봄")
    void koreanEvents() {
        ObjectNode kr = (ObjectNode) body().get("kr");
        kr.put("intradayEvents", true);
        ((ObjectNode) kr.get("stopWatch")).put("mode", "ON");
        ((ObjectNode) kr.get("claude")).put("freeTiming", true);
        store.books.put(PaperBooks.KR_CLAUDE, new Book(PaperBooks.KR_CLAUDE, PaperBooks.KIND_CLAUDE, PaperBooks.KR_CLAUDE, 100_000_000,
                FRI, PaperBooks.ACTIVE, null, Book.MARKET_KR, Book.CURRENCY_KRW));
        String packet = "{\"1_basis\":{\"book\":\"kr_claude\",\"variant\":\"" + PacketBuilder.VARIANT_FREE + "\"}}";
        long source = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, LocalDate.of(2026, 12, 1), RuleBookService.SCHEDULED,
                null, "NO_TRADE", "claude-sonnet-5-5", 0, 1, null, 20.0, null, null, null, null, null, null, List.of(), true, 1L, 0, packet))
                .orElseThrow();
        ObjectNode tickers = MAPPER.createObjectNode();
        ObjectNode index = tickers.putObject("069500");
        index.put("session", KR_DAY.toString());
        index.putObject("prevClose").put("raw", 40_000).put("adjusted", 40_000);
        index.putObject("day").putObject("first").put("label", "09:01").put("o", 40_100);
        index.putArray("bars").addObject().put("label", "10:05").put("c", 40_700).put("v", 500);
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1).put("fetchedAt", kst(10, 5).plusSeconds(20).toString());
        payload.set("tickers", tickers);
        Snapshot snapshot = new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null, kst(10, 5).plusSeconds(20));
        Map<String, String> changes = scheduler.events(PaperKrIntradayJob.BOOKS, store.settings, KR, true, kst(10, 6),
                (code, decision) -> null, new IntradayScheduler.EventSource() {
                    @Override
                    public Optional<Snapshot> monitor() {
                        return Optional.of(snapshot);
                    }

                    @Override
                    public List<IntradayScheduler.Held> held(String code, LocalDate session) {
                        return List.of();
                    }

                    @Override
                    public double stopPct() {
                        return 8.0;
                    }
                });
        assertThat(changes).containsExactly(Map.entry("kr_claude 2026-12-02 #1", "PLANNED EVENT 10:07 KST — INDEX_MOVE 069500 UP +1.75%"));
        IntradayPlan made = store.intradayPlans(PaperBooks.KR_CLAUDE, KR_DAY).get(0);
        assertThat(made.sourceDecisionId()).isEqualTo(source);
        assertThat(made.variant()).isEqualTo(KrPacketBuilder.KR_FREE_FIXED_RULES_VERSION);
        assertThat(made.trigger().get("events").get(0).get("barKst").asString()).isEqualTo("10:05");
    }

    // ------------------------------------------------------------------ 고정 일정 판(ADR 0039)
    @Test
    @DisplayName("고정 일정 판(intradayFixed): 움직임 사건은 하락만 — 상승(+1.6%)은 판단을 부르지 않음. 사건은 고정 판단 몫의 순번을 남겨 두고만 씀 — "
            + "개장 직후에는 한 번(순번 3 − 남은 고정 2), 그 뒤 사건은 NO_SLOT으로 버리고, 첫 고정 판단이 끝난 뒤에는 다시 한 번")
    void fixedScheduleKeepsDownEventsAndReservesSlots() {
        long source = freeDecision(PaperBooks.CLAUDE);
        body().put(IntradayPolicy.US_FIXED, true);
        ((ObjectNode) body().get("claude2")).put("freeTiming", false);
        store.upsertPosition(position(PaperBooks.CLAUDE, "AAA", 200));
        store.upsertPosition(position(PaperBooks.CLAUDE, "BBB", 200));
        ObjectNode tickers = MAPPER.createObjectNode();
        usEntry(tickers, "SPY", 100.0, 100.0, 101.6);
        usEntry(tickers, "AAA", 50.0, 50.0, 52.5);           // +5%
        monitor = usSnapshot(et(9, 50, 20), tickers);
        assertThat(events(et(9, 50, 40))).as("상승 사건은 부르지 않음").isEmpty();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, MON)).isEmpty();

        usEntry(tickers, "SPY", 100.0, 100.0, 98.4);
        monitor = usSnapshot(et(10, 0, 20), tickers);
        assertThat(events(et(10, 1, 10))).containsExactly(Map.entry("claude 2026-11-09 #1",
                "PLANNED EVENT 10:02 ET — INDEX_MOVE SPY DOWN -1.60%"));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 9L, 30, et(10, 3, 0));

        usEntry(tickers, "AAA", 50.0, 50.0, 47.9);           // −4.2%
        monitor = usSnapshot(et(10, 10, 20), tickers);
        Map<String, String> dropped = events(et(10, 10, 40));
        assertThat(dropped).containsOnlyKeys("claude 2026-11-09 사건");
        assertThat(dropped.get("claude 2026-11-09 사건")).as("남은 순번 둘은 고정 판단 몫").startsWith("SUPPRESSED " + IntradayScheduler.NO_SLOT);

        // 사건이 한 번 쓰인 세션: 첫 고정 판단(순번 2)이 끝난 뒤의 사건도 버린다 — 남은 순번 3은 마감 전 고정 판단 몫
        store.upsertPlannedIntradayPlan(IntradayScheduler.fixedRow(PaperBooks.CLAUDE, MON, 2,
                new IntradayScheduler.Fixed(LocalTime.of(10, 31), 0), false, source));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 2, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 10L, 30, et(10, 33, 0));
        usEntry(tickers, "BBB", 50.0, 50.0, 47.0);           // −6%
        monitor = usSnapshot(et(13, 0, 20), tickers);
        assertThat(events(et(13, 0, 40)).get("claude 2026-11-09 사건")).startsWith("SUPPRESSED " + IntradayScheduler.NO_SLOT);
        assertThat(IntradayScheduler.fixedTime(store.intradayPlans(PaperBooks.CLAUDE, MON), MON, US, false, et(15, 20, 10), 3))
                .as("마감 전 고정 판단은 순번 3으로 그대로").isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(15, 21), 1));

        // 오전에 사건이 없던 세션: 첫 고정 판단(순번 1) 뒤의 사건은 순번 2를 쓰고, 마감 전 고정 판단이 순번 3
        store.intradayPlans.clear();
        scheduler = new IntradayScheduler(store, new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER), MAPPER);
        store.upsertPlannedIntradayPlan(IntradayScheduler.fixedRow(PaperBooks.CLAUDE, MON, 1,
                new IntradayScheduler.Fixed(LocalTime.of(10, 31), 0), false, source));
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 10L, 30, et(10, 33, 0));
        monitor = usSnapshot(et(13, 5, 20), tickers);
        Map<String, String> late = events(et(13, 5, 40));
        assertThat(late).containsOnlyKeys("claude 2026-11-09 #2");
        assertThat(late.get("claude 2026-11-09 #2")).startsWith("PLANNED EVENT 13:06 ET — ").contains("HELD_MOVE BBB DOWN -6.00%")
                .doesNotContain(" UP ");
        store.markIntradayPlan(PaperBooks.CLAUDE, MON, 2, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, 11L, 30, et(13, 8, 0));
        assertThat(IntradayScheduler.fixedTime(store.intradayPlans(PaperBooks.CLAUDE, MON), MON, US, false, et(15, 20, 10), 3))
                .isEqualTo(new IntradayScheduler.Fixed(LocalTime.of(15, 21), 1));
    }
}
