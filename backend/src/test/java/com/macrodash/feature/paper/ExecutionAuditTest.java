package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.ExecutionAuditFixtures.Bars;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.EARLY_CLOSE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.FRI_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.FRI_EDT;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_EST;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.TUE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.WED_BEFORE_THANKSGIVING;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.WED_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.claudeOrder;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.observationFill;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.staleBar;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 실행 감사의 판정({@link ExecutionAudit}) — 명세 2026-10-30 §8의 ⑤~⑧ 갈래마다, 사다리 R1·R2(대체 없음), 목표 시각의 서머타임 전환 주,
 * 조기 폐장일, 종가는 확정 뒤에만, 지연은 달력으로 다시 셈, 메뉴 시각 = V17 CHECK·수집기 MENU. 외부 호출·DB 없음.
 */
class ExecutionAuditTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;

    private static Order buy(String timing, LocalDate asOf, Instant createdAt) {
        Order o = claudeOrder("AAPL", PaperBooks.BUY, timing, "PENDING", asOf, createdAt);
        return new Order(7, o.bookCode(), o.decisionId(), o.ticker(), o.side(), o.qty(), o.targetWeightPct(),
                o.sellFraction(), o.timing(), o.source(), o.status(), o.rejectReason(), o.reason(), o.asOfTradingDate(),
                o.createdAt(), o.expiresOn(), o.filledAt());
    }

    /** 월요일 세션을 보고 화요일 아침에 낸 계좌1식 주문(목표 세션 E = 화요일). */
    private static final Order MON_ORDER = buy(ExecutionAudit.NEXT_OBSERVATION, MON, MON_DECIDED);

    @ParameterizedTest(name = "{0} 다음 세션 {1}: {2} = {3}")
    @CsvSource({
            "2026-10-26, 2026-10-27, NEXT_OPEN, 2026-10-27T13:30:00Z",   // EDT(UTC−4)
            "2026-10-26, 2026-10-27, AT_1500, 2026-10-27T19:00:00Z",
            "2026-10-30, 2026-11-02, NEXT_OPEN, 2026-11-02T14:30:00Z",   // 11-01 서머타임 끝 → EST(UTC−5)
            "2026-10-30, 2026-11-02, AT_1000, 2026-11-02T15:00:00Z",
            "2026-10-30, 2026-11-02, NEXT_CLOSE, 2026-11-02T21:00:00Z",
            "2027-03-12, 2027-03-15, NEXT_OPEN, 2027-03-15T13:30:00Z",   // 2027-03-14 서머타임 시작 → EDT
            "2026-11-25, 2026-11-27, NEXT_CLOSE, 2026-11-27T18:00:00Z",  // 추수감사절(11-26) 휴장 뒤 조기 폐장 13:00 EST
    })
    @DisplayName("목표 세션 E = 기준 거래일 다음 거래일, 기준 시각 T는 E 날짜의 뉴욕 시각(고정 UTC 오프셋 없음 — 서머타임 전환 주 둘·조기 폐장)")
    void targetSessionAndTime(LocalDate asOf, LocalDate session, String timing, Instant target) {
        Order order = buy(timing, asOf, MON_DECIDED);
        assertThat(ExecutionAudit.targetSession(order, US)).isEqualTo(session);
        assertThat(ExecutionAudit.targetAt(timing, session, US)).isEqualTo(target);
        assertThat(ExecutionAudit.targetAt(ExecutionAudit.NEXT_OBSERVATION, session, US))
                .as("계좌1식 기준에는 정해진 시각이 없음").isNull();
    }

    @Test
    @DisplayName("R1 = T 봉 시가(거래량 > 0), R2 = T 봉이 거래 없음·없으면 T+1~T+4분 첫 거래 봉 시가, 창 안 거래가 없으면 null(대체 R2b·R3 없음)")
    void ladderR1R2Only() {
        Bars bars = new Bars(et(TUE, 15, 55))
                .bar("AAPL", TUE, et(TUE, 9, 30), 100.0, 1200.0)
                .bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 0.0)
                .bar("AAPL", TUE, et(TUE, 10, 1), 101.5, null)        // 거래량을 모름 — 거래로 보지 않음
                .bar("AAPL", TUE, et(TUE, 10, 2), 101.7, 300.0)
                .bar("AAPL", TUE, et(TUE, 11, 0), 102.0, 0.0)
                .bar("AAPL", TUE, et(TUE, 11, 4), 102.4, 0.0)
                .bar("AAPL", TUE, et(TUE, 11, 5), 102.5, 900.0)       // 창 밖(T+5분) — R2b는 반사실에 쓰지 않음
                .bar("AAPL", TUE, et(TUE, 15, 50), 105.0, 10.0);

        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, bars.payload(), US))
                .isEqualTo(new Price(100.0, et(TUE, 9, 30), ExecutionAudit.RUNG_AT));
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1000", TUE, bars.payload(), US))
                .isEqualTo(new Price(101.7, et(TUE, 10, 2), ExecutionAudit.RUNG_NEXT));
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1100", TUE, bars.payload(), US)).as("창 안 거래 없음").isNull();
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1200", TUE, bars.payload(), US)).as("창 비었음").isNull();
    }

    @Test
    @DisplayName("⑤ T ≤ 주문 생성 + 60초인 시각과 T 앞에 시작한 봉은 쓰지 않음")
    void refusesBarsBeforeCreationPlusSixtySeconds() {
        Bars bars = new Bars(et(TUE, 10, 55))
                .bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 100.0)
                .barIn("10:00", "AAPL", TUE, et(TUE, 9, 59), 99.0, 100.0)   // 창에 잘못 든 T 앞 봉
                .bar("AAPL", TUE, et(TUE, 10, 30), 103.0, 100.0);
        Order late = buy("AT_1000", MON, et(TUE, 9, 59).plusSeconds(10));     // T − 생성 = 50초
        Order inTime = buy("AT_1000", MON, et(TUE, 9, 58).plusSeconds(59));   // T − 생성 = 61초

        assertThat(ExecutionAudit.fromBars(late, "AT_1000", TUE, bars.payload(), US)).isNull();
        assertThat(ExecutionAudit.fromBars(late, "NEXT_OPEN", TUE, bars.payload(), US)).as("생성 전 시각").isNull();
        assertThat(ExecutionAudit.fromBars(inTime, "AT_1000", TUE, bars.payload(), US))
                .as("T 앞 봉(09:59)은 건너뛰고 T 봉").isEqualTo(new Price(101.0, et(TUE, 10, 0), ExecutionAudit.RUNG_AT));
    }

    @Test
    @DisplayName("⑥ E가 아닌 세션의 봉은 보지 않음 — 저장본에 앞 세션만 있으면 null")
    void refusesOtherSessions() {
        Bars bars = new Bars(et(TUE, 10, 55))
                .bar("AAPL", MON, et(MON, 9, 30), 98.0, 100.0)
                .bar("AAPL", MON, et(MON, 15, 59), 99.0, 100.0);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, bars.payload(), US)).isNull();
    }

    @Test
    @DisplayName("⑦ 완성된 봉만 — 그 뒤 봉이 없고 E 마감 + 15분 전에 받았으면 null, 그 뒤 봉이 있거나 마감 + 15분 뒤에 받았으면 그 봉")
    void refusesBarsThatMayStillBeForming() {
        Bars forming = new Bars(et(TUE, 10, 0).plusSeconds(40)).bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 50.0);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1000", TUE, forming.payload(), US)).isNull();

        Bars next = new Bars(et(TUE, 10, 1).plusSeconds(40)).bar("AAPL", TUE, et(TUE, 10, 0), 101.0, 50.0)
                .bar("AAPL", TUE, et(TUE, 10, 1), 101.2, 20.0);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1000", TUE, next.payload(), US)).isNotNull();

        Bars closeTooEarly = new Bars(et(TUE, 16, 10)).bar("AAPL", TUE, et(TUE, 15, 0), 104.0, 50.0);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1500", TUE, closeTooEarly.payload(), US))
                .as("마감 + 10분 — 아직 마지막 봉일 수 있음").isNull();
        Bars afterClose = new Bars(et(TUE, 16, 20)).bar("AAPL", TUE, et(TUE, 15, 0), 104.0, 50.0);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "AT_1500", TUE, afterClose.payload(), US))
                .isEqualTo(new Price(104.0, et(TUE, 15, 0), ExecutionAudit.RUNG_AT));
    }

    @Test
    @DisplayName("⑧ 이어받은 종목·주문 전에 받은 세션·거래량 0뿐인 창은 null(0으로 채우지 않음)")
    void refusesStaleTickersAndPreOrderFetches() {
        Bars stale = new Bars(et(TUE, 10, 55)).bar("AAPL", TUE, et(TUE, 9, 30), 100.0, 10.0)
                .bar("AAPL", TUE, et(TUE, 10, 50), 101.0, 10.0).stale("AAPL");
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, stale.payload(), US)).isNull();

        Bars before = new Bars(et(TUE, 10, 55)).bar("AAPL", TUE, et(TUE, 9, 30), 100.0, 10.0)
                .bar("AAPL", TUE, et(TUE, 10, 50), 101.0, 10.0).sessionFetchedAt("AAPL", TUE, MON_DECIDED);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, before.payload(), US)).as("주문 시각에 받은 세션")
                .isNull();

        Bars noTrade = new Bars(et(TUE, 16, 30));
        for (int minute = 0; minute < 5; minute++) {
            noTrade.bar("AAPL", TUE, et(TUE, 9, 30 + minute), 100.0, 0.0);
        }
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, noTrade.payload(), US)).as("거래 정지·무거래").isNull();
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, null, US)).as("저장본 없음").isNull();
        Bars otherContract = new Bars(et(TUE, 10, 55)).bar("AAPL", TUE, et(TUE, 9, 30), 100.0, 10.0)
                .bar("AAPL", TUE, et(TUE, 10, 50), 101.0, 10.0);
        ((tools.jackson.databind.node.ObjectNode) otherContract.payload()).put("contract", 2);
        assertThat(ExecutionAudit.fromBars(MON_ORDER, "NEXT_OPEN", TUE, otherContract.payload(), US))
                .as("모르는 저장본 판").isNull();
    }

    @Test
    @DisplayName("서머타임 전환 주(E = 2026-11-02 EST): 고정 EDT 오프셋으로 셈한 13:30Z 봉은 09:30 ET 창이 아님 — 14:30Z 봉만 시가")
    void dstWeekUsesNewYorkSessionTime() {
        Order order = buy("NEXT_OPEN", FRI_EDT, FRI_DECIDED);
        Bars wrong = new Bars(et(MON_EST, 10, 55)).barIn("09:30", "AAPL", MON_EST, Instant.parse("2026-11-02T13:30:00Z"),
                99.0, 100.0).bar("AAPL", MON_EST, et(MON_EST, 10, 50), 101.0, 100.0);
        assertThat(ExecutionAudit.fromBars(order, "NEXT_OPEN", MON_EST, wrong.payload(), US)).isNull();

        Bars right = new Bars(et(MON_EST, 10, 55)).bar("AAPL", MON_EST, Instant.parse("2026-11-02T14:30:00Z"), 100.0, 100.0)
                .bar("AAPL", MON_EST, et(MON_EST, 10, 50), 101.0, 100.0);
        assertThat(ExecutionAudit.fromBars(order, "NEXT_OPEN", MON_EST, right.payload(), US))
                .isEqualTo(new Price(100.0, Instant.parse("2026-11-02T14:30:00Z"), ExecutionAudit.RUNG_AT));
    }

    @Test
    @DisplayName("조기 폐장일(2026-11-27 13:00 EST): 13:00 뒤 시각(AT_1300~AT_1500)은 봉이 있어도 null, 12:00은 그대로, 종가는 13:00 + 15분 뒤에만")
    void earlyCloseDay() {
        Order order = buy("NEXT_CLOSE", WED_BEFORE_THANKSGIVING, WED_DECIDED);
        Bars bars = new Bars(et(EARLY_CLOSE, 13, 30)).bar("AAPL", EARLY_CLOSE, et(EARLY_CLOSE, 12, 0), 200.0, 10.0)
                .bar("AAPL", EARLY_CLOSE, et(EARLY_CLOSE, 12, 1), 200.5, 10.0)
                .bar("AAPL", EARLY_CLOSE, et(EARLY_CLOSE, 13, 0), 201.0, 10.0)   // 장 마감 뒤 줄(있을 수 없지만 있어도)
                .bar("AAPL", EARLY_CLOSE, et(EARLY_CLOSE, 13, 1), 201.0, 10.0);
        assertThat(ExecutionAudit.fromBars(order, "AT_1200", EARLY_CLOSE, bars.payload(), US)).isNotNull();
        for (String timing : List.of("AT_1300", "AT_1400", "AT_1500")) {
            assertThat(ExecutionAudit.fromBars(order, timing, EARLY_CLOSE, bars.payload(), US)).as(timing).isNull();
        }
        assertThat(ExecutionAudit.fromQuotes(order, EARLY_CLOSE,
                quotes(et(EARLY_CLOSE, 13, 10), bar("AAPL", WED_BEFORE_THANKSGIVING, 199, EARLY_CLOSE, 202)), US))
                .as("마감 + 10분").isNull();
        assertThat(ExecutionAudit.fromQuotes(order, EARLY_CLOSE,
                quotes(et(EARLY_CLOSE, 13, 20), bar("AAPL", WED_BEFORE_THANKSGIVING, 199, EARLY_CLOSE, 202)), US))
                .isEqualTo(new Price(202.0, et(EARLY_CLOSE, 13, 0), ExecutionAudit.RUNG_CLOSE));
    }

    @Test
    @DisplayName("NEXT_CLOSE는 관측치가 E 확정 종가일 때만 — 마감 + 15분 전·이어 쓴 봉·E가 아닌 봉(다음 세션이 열림)·주문 전 수집은 null")
    void nextCloseOnlyAfterCloseAvailable() {
        assertThat(ExecutionAudit.fromQuotes(MON_ORDER, TUE, quotes(et(TUE, 16, 10), bar("AAPL", MON, 99, TUE, 101)), US))
                .isNull();
        assertThat(ExecutionAudit.fromQuotes(MON_ORDER, TUE, quotes(et(TUE, 16, 20), bar("AAPL", MON, 99, TUE, 101)), US))
                .isEqualTo(new Price(101.0, et(TUE, 16, 0), ExecutionAudit.RUNG_CLOSE));
        assertThat(ExecutionAudit.fromQuotes(MON_ORDER, TUE, quotes(et(TUE, 16, 20), staleBar("AAPL", MON, 99, TUE, 101)),
                US)).isNull();
        LocalDate wed = LocalDate.of(2026, 10, 28);
        assertThat(ExecutionAudit.fromQuotes(MON_ORDER, TUE, quotes(et(wed, 10, 5),
                bar("AAPL", MON, 99, TUE, 101, wed, 103)), US)).as("다음 세션 봉 — 조정 이력에서 꺼내지 않음").isNull();
        assertThat(ExecutionAudit.fromQuotes(buy("NEXT_CLOSE", MON, et(TUE, 16, 30)), TUE,
                quotes(et(TUE, 16, 20), bar("AAPL", MON, 99, TUE, 101)), US)).as("주문 전에 수집").isNull();
        assertThat(ExecutionAudit.fromQuotes(MON_ORDER, TUE, null, US)).isNull();
    }

    @Test
    @DisplayName("NEXT_OBSERVATION은 계좌1식으로 실제 체결된 원가격(슬리피지 전)과 그 관측치 수집 시각 — 다른 시점의 주문·사후 체결·체결 없음은 null")
    void nextObservationFromTheActualFill() {
        var fill = observationFill(7, "AAPL", PaperBooks.BUY, 10, 100.0, et(TUE, 9, 58), TUE);
        assertThat(ExecutionAudit.fromFill(MON_ORDER, fill))
                .isEqualTo(new Price(100.0, et(TUE, 9, 58), ExecutionAudit.RUNG_OBSERVATION));
        assertThat(ExecutionAudit.fromFill(buy("NEXT_CLOSE", MON, MON_DECIDED), fill)).isNull();
        assertThat(ExecutionAudit.fromFill(MON_ORDER, null)).isNull();
        var backfill = new com.macrodash.store.PaperStore.Fill(0, 7, PaperBooks.CLAUDE, "AAPL", "BUY", 10, 100.05, 100.0, 5,
                1000.5, et(TUE, 9, 58), TUE, PaperBooks.SOURCE_HISTORY, true, null);
        assertThat(ExecutionAudit.fromFill(MON_ORDER, backfill)).isNull();
    }

    @Test
    @DisplayName("지연 = 그 세션을 받은 시각 − (SPY 마지막 봉 시작 + 60초), 정규장 안에서만 — 조기 폐장일 13:00 뒤·장 밖·이어받은 SPY는 null, 보통 날 13:05는 셈(수집기는 모름), 음수 그대로")
    void lagIsRecountedWithTheCalendar() {
        Bars normal = new Bars(et(TUE, 13, 5)).bar("SPY", TUE, et(TUE, 12, 59), 500.0, 10.0);
        assertThat(ExecutionAudit.lagSeconds(normal.payload(), US)).isEqualTo(300);

        Bars early = new Bars(et(EARLY_CLOSE, 13, 30)).bar("SPY", EARLY_CLOSE, et(EARLY_CLOSE, 12, 59), 500.0, 10.0);
        assertThat(ExecutionAudit.lagSeconds(early.payload(), US)).as("조기 폐장 뒤 — 장이 닫힌 시간").isNull();

        Bars afterHours = new Bars(et(TUE, 16, 20)).bar("SPY", TUE, et(TUE, 15, 59), 500.0, 10.0);
        assertThat(ExecutionAudit.lagSeconds(afterHours.payload(), US)).isNull();

        Bars forming = new Bars(et(TUE, 10, 0).plusSeconds(30)).bar("SPY", TUE, et(TUE, 10, 0), 500.0, 10.0);
        assertThat(ExecutionAudit.lagSeconds(forming.payload(), US)).as("진행 중인 봉까지 받음 — 음수 그대로").isEqualTo(-30);

        Bars stale = new Bars(et(TUE, 13, 5)).bar("SPY", TUE, et(TUE, 12, 59), 500.0, 10.0).stale("SPY");
        assertThat(ExecutionAudit.lagSeconds(stale.payload(), US)).isNull();
        assertThat(ExecutionAudit.lagSeconds(null, US)).isNull();

        Bars older = new Bars(et(TUE, 13, 5)).bar("SPY", TUE, et(TUE, 12, 0), 500.0, 10.0)
                .sessionFetchedAt("SPY", TUE, et(TUE, 12, 1).plusSeconds(20));
        assertThat(ExecutionAudit.lagSeconds(older.payload(), US)).as("합쳐 둔 세션은 그 세션을 받은 시각으로").isEqualTo(20);
    }

    @Test
    @DisplayName("반사실 묶음은 계좌1식 + 메뉴 여덟을 늘 같은 순서로 — 못 구한 시점은 null")
    void counterfactualsCoverEveryTiming() {
        Map<String, Price> all = ExecutionAudit.counterfactuals(MON_ORDER, null, null, null, US);
        assertThat(all.keySet()).containsExactly("NEXT_OBSERVATION", "NEXT_OPEN", "AT_1000", "AT_1100", "AT_1200",
                "AT_1300", "AT_1400", "AT_1500", "NEXT_CLOSE");
        assertThat(all.values()).containsOnlyNulls();
        assertThat(ExecutionAudit.auditedBooks()).as("미국 Claude 계좌 — 지금은 계좌1 하나").containsExactly(PaperBooks.CLAUDE);
    }

    // ------------------------------------------------------------------ 메뉴 대조(V17 CHECK · 수집기 MENU)
    private static final Path V17 = Path.of("../db/migrations/V17__paper_timed_fills_and_exec.sql");
    private static final Path COLLECTOR_BARS = Path.of("../collector/app/tasks/paper_bars.py");

    @Test
    @DisplayName("메뉴 시점 이름은 V17 timing CHECK와, 기준 시각은 수집기 paper_bars.MENU와 같다(ADR 0022 결정 6 — 백엔드 상수 = 수집기 목록)")
    void menuMatchesTheMigrationAndTheCollector() throws IOException {
        assumeTrue(Files.exists(V17) && Files.exists(COLLECTOR_BARS), "V17·수집기 파일을 찾을 수 없습니다");
        String check = Files.readString(V17);
        List<String> timed = new ArrayList<>();
        Matcher m = Pattern.compile("'(AT_\\d{4})'").matcher(check);
        while (m.find()) {
            if (!timed.contains(m.group(1))) {
                timed.add(m.group(1));
            }
        }
        assertThat(check).contains("'NEXT_OPEN'");
        List<String> menu = new ArrayList<>(ExecutionAudit.MENU.keySet());
        assertThat(menu.subList(1, menu.size())).containsExactlyElementsOf(timed);

        String collector = Files.readString(COLLECTOR_BARS);
        int start = collector.indexOf("MENU = {");
        String block = collector.substring(start, collector.indexOf("}", start));
        Map<String, LocalTime> parsed = new LinkedHashMap<>();
        Matcher entry = Pattern.compile("\"([A-Z_0-9]+)\": time\\((\\d+), (\\d+)\\)").matcher(block);
        while (entry.find()) {
            parsed.put(entry.group(1), LocalTime.of(Integer.parseInt(entry.group(2)), Integer.parseInt(entry.group(3))));
        }
        assertThat(parsed).containsExactlyEntriesOf(ExecutionAudit.MENU);
        assertThat(collector).contains("WINDOW = timedelta(minutes=5)").contains("CONTRACT = " + ExecutionAudit.BARS_CONTRACT)
                .contains("REFERENCE = \"" + ExecutionAudit.REFERENCE + "\"");
    }
}
