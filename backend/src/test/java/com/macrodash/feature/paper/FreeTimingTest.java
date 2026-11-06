package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.ExecutionAuditFixtures.EARLY_CLOSE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.MON_DECIDED;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.TUE;
import static com.macrodash.feature.paper.ExecutionAuditFixtures.et;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 자유 시점 판의 분 단위 지정 시각({@link FreeTiming} — ADR 0027 결정 1·8, ADR 0031): 응답의 시각 읽기, 그 세션에서 받는 범위(정규장 안 — 미국 개장 + 10분 ~
 * 마감 5분 전 앞, 한국 개장 + 10분 ~ 종가 단일가 앞, 조기 폐장·장 시간 변경일은 그날의 개장·마감), 그 결정만의 검증 표(열쇠 AT_MINUTE@HH:MM — 순위는 기준
 * 시각 순, 범위 밖·지난 시각·시각 없음은 닫힘, 켠 판 결정의 받는 시점에 시가 없음). 검증기의 계산은 건드리지 않습니다.
 */
class FreeTimingTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate KR_E = LocalDate.of(2026, 11, 3);
    /** 2026-11-19 수능일(10:00~16:30)과 2027-01-04 첫 거래일(10:00~15:30) — 설정 kr.calendar.openTimeOverrides의 모양. */
    private static final LocalDate KR_EXAM = LocalDate.of(2026, 11, 19);
    private static final LocalDate KR_NEW_YEAR = LocalDate.of(2027, 1, 4);
    private static final TradingCalendar KR_SHIFTED = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
            Map.of(KR_EXAM, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30)),
                    KR_NEW_YEAR, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(15, 30))));

    private static OrderValidator.Market base(List<String> timings, OrderValidator.Money money) {
        Map<String, String> names = new LinkedHashMap<>();
        Map<String, Integer> ranks = new LinkedHashMap<>();
        for (String timing : timings) {
            names.put(timing, switch (timing) {
                case PaperBooks.NEXT_OPEN -> "다음 세션 시가";
                case PaperBooks.NEXT_CLOSE -> "확정 종가";
                case PaperBooks.MARKET -> "장중 시장가";
                default -> "지정 시각";
            });
            ranks.put(timing, ranks.size());
        }
        return new OrderValidator.Market(timings, timings.get(0), names, money, ranks);
    }

    @Test
    @DisplayName("시각 글자: 'HH:MM'(24시간)만 읽고 그 밖은 null — 없는 시각을 지어내지 않음. 열쇠는 AT_MINUTE@HH:MM, 주문 행에서는 AT_MINUTE + 시각으로 되돌림")
    void clockTextAndKeys() {
        assertThat(FreeTiming.parse("10:47")).isEqualTo(LocalTime.of(10, 47));
        assertThat(FreeTiming.parse("09:05")).isEqualTo(LocalTime.of(9, 5));
        assertThat(FreeTiming.parse("23:59")).isEqualTo(LocalTime.of(23, 59));
        for (String bad : new String[]{null, "", "9:05", "10:47:00", "24:00", "10:60", "10.47", " 10:47", "AT_1000", "１０:４７"}) {
            assertThat(FreeTiming.parse(bad)).as("'" + bad + "'").isNull();
        }
        assertThat(FreeTiming.CLOCK_PATTERN).isEqualTo("^([01][0-9]|2[0-3]):[0-5][0-9]$");

        String key = FreeTiming.key(LocalTime.of(9, 5));
        assertThat(key).isEqualTo("AT_MINUTE@09:05");
        assertThat(FreeTiming.keyed(key)).isTrue();
        assertThat(FreeTiming.keyed(PaperBooks.AT_MINUTE)).isFalse();
        assertThat(FreeTiming.keyed(null)).isFalse();
        assertThat(FreeTiming.timeOf(key)).isEqualTo(LocalTime.of(9, 5));
        assertThat(FreeTiming.timeOf(PaperBooks.NEXT_OPEN)).isNull();
        assertThat(FreeTiming.orderTiming(key)).isEqualTo(PaperBooks.AT_MINUTE);
        assertThat(FreeTiming.orderTiming(PaperBooks.NEXT_CLOSE)).isEqualTo(PaperBooks.NEXT_CLOSE);

        assertThat(FreeTiming.proposedTiming(PaperBooks.AT_MINUTE, "10:47")).isEqualTo("AT_MINUTE@10:47");
        assertThat(FreeTiming.proposedTiming(PaperBooks.AT_MINUTE, null)).as("시각 없음 — 닫힌 시점 AT_MINUTE 그대로").isEqualTo(PaperBooks.AT_MINUTE);
        assertThat(FreeTiming.proposedTiming(PaperBooks.AT_MINUTE, "10시 47분")).isEqualTo(PaperBooks.AT_MINUTE);
        assertThat(FreeTiming.proposedTiming(PaperBooks.NEXT_OPEN, "10:47")).as("다른 시점의 atLocal은 보지 않음").isEqualTo(PaperBooks.NEXT_OPEN);
        assertThat(FreeTiming.proposedTiming("LIMIT", "10:47")).as("모르는 시점은 그대로 — 검증기가 거절").isEqualTo("LIMIT");
    }

    @Test
    @DisplayName("받는 범위: 미국 09:40~15:54 ET(조기 폐장일 09:40~12:54), 한국 09:10~15:19 KST(수능일 10:10~16:19, 2027-01-04 10:10~15:19) — 개장 뒤 "
            + "10분은 받지 않고, 장 끝 여유는 장중 시장가·종가 단일가와 같은 값")
    void windowIsInsideTheRegularSession() {
        FreeTiming.Window us = FreeTiming.window(TUE, US, false);
        assertThat(us.first()).isEqualTo(et(TUE, 9, 40));
        assertThat(us.last()).isEqualTo(et(TUE, 15, 54));
        assertThat(us.accepts(et(TUE, 9, 30))).as("개장 순간(개장 경매)은 받지 않음").isFalse();
        assertThat(us.accepts(et(TUE, 9, 39))).as("개장 뒤 10분 안").isFalse();
        assertThat(us.accepts(et(TUE, 9, 40))).isTrue();
        assertThat(us.accepts(et(TUE, 15, 54))).isTrue();
        assertThat(us.accepts(et(TUE, 15, 55))).as("마감 5분 전부터는 받지 않음 — 장중 시장가와 같은 끝").isFalse();
        assertThat(us.accepts(null)).isFalse();
        assertThat(FreeTiming.tail(false)).isEqualTo(UsTimedFills.MARKET_BEFORE_CLOSE);

        FreeTiming.Window early = FreeTiming.window(EARLY_CLOSE, US, false);
        assertThat(early.first()).as("조기 폐장일도 개장 09:30 + 10분").isEqualTo(et(EARLY_CLOSE, 9, 40));
        assertThat(early.last()).as("조기 폐장 13:00 ET").isEqualTo(et(EARLY_CLOSE, 12, 54));

        FreeTiming.Window kr = FreeTiming.window(KR_E, KR, true);
        assertThat(kr.first()).isEqualTo(Instant.parse("2026-11-03T00:10:00Z"));   // 09:10 KST
        assertThat(kr.last()).isEqualTo(Instant.parse("2026-11-03T06:19:00Z"));    // 15:19 KST
        assertThat(kr.accepts(Instant.parse("2026-11-03T00:09:00Z"))).as("09:09 KST — 개장 뒤 10분 안").isFalse();
        FreeTiming.Window exam = FreeTiming.window(KR_EXAM, KR_SHIFTED, true);
        assertThat(exam.first()).as("수능일 10:00 개장 + 10분").isEqualTo(Instant.parse("2026-11-19T01:10:00Z"));
        assertThat(exam.last()).as("16:30 마감 − 종가 단일가 10분 − 1분").isEqualTo(Instant.parse("2026-11-19T07:19:00Z"));
        FreeTiming.Window newYear = FreeTiming.window(KR_NEW_YEAR, KR_SHIFTED, true);
        assertThat(newYear.first()).as("2027-01-04 10:00 개장 + 10분").isEqualTo(Instant.parse("2027-01-04T01:10:00Z"));
        assertThat(newYear.last()).as("15:30 마감 그대로").isEqualTo(Instant.parse("2027-01-04T06:19:00Z"));
        assertThat(FreeTiming.tail(true)).isEqualTo(KrTimedLadder.CLOSING_AUCTION);
        assertThat(FreeTiming.at(KR_E, LocalTime.of(10, 47), KR)).isEqualTo(Instant.parse("2026-11-03T01:47:00Z"));
    }

    @Test
    @DisplayName("아침 결정의 검증 표(판 ft-2): 받는 시점은 지정 시각·종가 둘(시가 없음) — 지정 시각들(시각 순) < 종가, 범위 밖(개장 뒤 10분 안 09:39 포함)·시각 없는 "
            + "AT_MINUTE는 닫힘(MALFORMED)이고 맨 뒤 순위, 이름은 '다음 세션 HH:MM ET'")
    void decisionTableOrdersByTargetTime() {
        assertThat(FreeTiming.DECISION_TIMINGS).containsExactly(PaperBooks.AT_MINUTE, PaperBooks.NEXT_CLOSE);
        OrderValidator.Market market = FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, OrderValidator.Money.USD),
                List.of(LocalTime.of(14, 5), LocalTime.of(9, 40), LocalTime.of(10, 47), LocalTime.of(10, 47), LocalTime.of(15, 55),
                        LocalTime.of(9, 39), LocalTime.of(3, 0)), TUE, MON_DECIDED, US, false, false);

        assertThat(market.timings()).containsExactly("AT_MINUTE@09:40", "AT_MINUTE@10:47", "AT_MINUTE@14:05", "NEXT_CLOSE",
                "AT_MINUTE@03:00", "AT_MINUTE@09:39", "AT_MINUTE@15:55", "AT_MINUTE");
        assertThat(market.earlyTiming()).as("가장 이른 받는 열쇠").isEqualTo("AT_MINUTE@09:40");
        assertThat(market.ranks()).containsEntry("AT_MINUTE@09:40", 0).containsEntry("AT_MINUTE@10:47", 1)
                .containsEntry("AT_MINUTE@14:05", 2).containsEntry("NEXT_CLOSE", 3).containsEntry("AT_MINUTE@03:00", 4)
                .containsEntry("AT_MINUTE@09:39", 4).containsEntry("AT_MINUTE@15:55", 4).containsEntry("AT_MINUTE", 4);
        assertThat(market.timingNames()).containsEntry("AT_MINUTE@10:47", "다음 세션 10:47 ET").doesNotContainKey(PaperBooks.NEXT_OPEN);
        assertThat(market.closed()).containsOnlyKeys("AT_MINUTE@03:00", "AT_MINUTE@09:39", "AT_MINUTE@15:55", "AT_MINUTE");
        assertThat(market.closed().get("AT_MINUTE@15:55").reason()).isEqualTo(OrderValidator.MALFORMED);
        assertThat(market.closed().get("AT_MINUTE@15:55").detail()).contains("2026-10-27 지정 시각 15:55 ET").contains("09:40~15:54 ET");
        assertThat(market.closed().get("AT_MINUTE@09:39").reason()).as("개장 뒤 10분 안").isEqualTo(OrderValidator.MALFORMED);
        assertThat(market.closed().get("AT_MINUTE@09:39").detail()).contains("09:40~15:54 ET");
        assertThat(market.closed().get("AT_MINUTE").detail()).isEqualTo(FreeTiming.MISSING_TIME);
        assertThat(market.timings()).as("켠 판 결정은 시가를 받지 않음 — 검증기가 MALFORMED").doesNotContain(PaperBooks.NEXT_OPEN);

        OrderValidator.Market none = FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, OrderValidator.Money.USD), List.of(), TUE,
                MON_DECIDED, US, false, false);
        assertThat(none.timings()).as("지정 시각 주문이 없어도 표는 만들어짐").containsExactly("NEXT_CLOSE", "AT_MINUTE");
        assertThat(none.closed()).containsOnlyKeys("AT_MINUTE");
    }

    @Test
    @DisplayName("프로필의 닫힌 시점은 그대로 이어받음 — E 장중의 늦은 수동 결정에서 닫힌 종가(마감 뒤라고 가정한 표)와 지난 지정 시각, 조기 폐장일은 09:40~12:54")
    void lateAndEarlyCloseAreClosed() {
        Instant late = et(TUE, 10, 46).plusSeconds(10);
        OrderValidator.Market base = base(FreeTiming.DECISION_TIMINGS, OrderValidator.Money.USD).withClosed(Map.of(PaperBooks.NEXT_CLOSE,
                new OrderValidator.Closed(OrderValidator.LATE_FOR_TIMING, "기준 시각이 지남")));
        OrderValidator.Market market = FreeTiming.validation(base, List.of(LocalTime.of(10, 47), LocalTime.of(10, 48), LocalTime.of(9, 45)),
                TUE, late, US, false, false);
        assertThat(market.closed()).containsOnlyKeys("NEXT_CLOSE", "AT_MINUTE@09:45", "AT_MINUTE@10:47", "AT_MINUTE");
        assertThat(market.closed().get("AT_MINUTE@10:47").reason()).as("T = 생성 + 50초 — ⑤").isEqualTo(OrderValidator.LATE_FOR_TIMING);
        assertThat(market.closed().get("AT_MINUTE@09:45").reason()).isEqualTo(OrderValidator.LATE_FOR_TIMING);
        assertThat(market.ranks()).containsEntry("AT_MINUTE@10:48", 0).containsEntry("NEXT_CLOSE", 1);

        OrderValidator.Market early = FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, OrderValidator.Money.USD),
                List.of(LocalTime.of(12, 54), LocalTime.of(12, 55), LocalTime.of(14, 0)), EARLY_CLOSE,
                Instant.parse("2026-11-25T22:31:00Z"), US, false, false);
        assertThat(early.closed()).containsOnlyKeys("AT_MINUTE@12:55", "AT_MINUTE@14:00", "AT_MINUTE");
        assertThat(early.closed().get("AT_MINUTE@14:00").detail()).contains("09:40~12:54 ET");
    }

    @Test
    @DisplayName("장중 판단의 검증 표: 장중 시장가가 가장 이르거나 같은 순위(가장 이른 받는 지정 시각 = 시장가의 기준 분), 이름은 '이 세션 HH:MM ET', 한국은 '오늘 HH:MM KST'")
    void intradayTableStartsAtTheMarketMinute() {
        Instant now = et(TUE, 10, 31).plusSeconds(20);                    // 장중 시장가의 기준 분 10:33
        OrderValidator.Market market = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, OrderValidator.Money.USD),
                List.of(LocalTime.of(10, 32), LocalTime.of(10, 33), LocalTime.of(13, 0)), TUE, now, US, false, true);
        assertThat(market.earlyTiming()).isEqualTo(PaperBooks.MARKET);
        assertThat(market.ranks()).containsEntry(PaperBooks.MARKET, 0).containsEntry("AT_MINUTE@10:33", 0)
                .containsEntry("AT_MINUTE@13:00", 1).containsEntry(PaperBooks.NEXT_CLOSE, 2);
        assertThat(market.closed().get("AT_MINUTE@10:32").reason()).as("10:32 ≤ 지금 + 60초(10:32:20)").isEqualTo(OrderValidator.LATE_FOR_TIMING);
        assertThat(market.timingNames()).containsEntry("AT_MINUTE@13:00", "이 세션 13:00 ET");

        OrderValidator.Market kr = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, KrPaperMarket.INSTANCE.money()),
                List.of(LocalTime.of(15, 19), LocalTime.of(15, 20)), KR_E, Instant.parse("2026-11-03T02:00:00Z"), KR, true, true);
        assertThat(kr.timingNames()).containsEntry("AT_MINUTE@15:19", "오늘 15:19 KST");
        assertThat(kr.closed()).containsOnlyKeys("AT_MINUTE@15:20", "AT_MINUTE");
        assertThat(kr.closed().get("AT_MINUTE@15:20").detail()).contains("09:10~15:19 KST");
        OrderValidator.Market night = FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, KrPaperMarket.INSTANCE.money()),
                List.of(LocalTime.of(9, 10), LocalTime.of(9, 9)), KR_E, Instant.parse("2026-11-02T13:30:00Z"), KR, true, false);
        assertThat(night.timingNames()).containsEntry("AT_MINUTE@09:10", "다음 거래일 09:10 KST");
        assertThat(night.closed()).containsOnlyKeys("AT_MINUTE@09:09", "AT_MINUTE");
        assertThat(night.closed().get("AT_MINUTE@09:09").detail()).contains("09:10~15:19 KST");
        // 장 시간 변경일(수능일 10:00 개장)은 그날 개장 기준 — 09:10은 범위 밖, 10:10부터, 16:19까지.
        OrderValidator.Market exam = FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, KrPaperMarket.INSTANCE.money()),
                List.of(LocalTime.of(9, 10), LocalTime.of(10, 9), LocalTime.of(10, 10), LocalTime.of(16, 19), LocalTime.of(16, 20)), KR_EXAM,
                Instant.parse("2026-11-18T13:30:00Z"), KR_SHIFTED, true, false);
        assertThat(exam.closed()).containsOnlyKeys("AT_MINUTE@09:10", "AT_MINUTE@10:09", "AT_MINUTE@16:20", "AT_MINUTE");
        assertThat(exam.closed().get("AT_MINUTE@09:10").detail()).contains("10:10~16:19 KST");
    }

    @Test
    @DisplayName("장중 시장가의 개장 10분 하한(ADR 0031): 기준 분이 그 세션 첫 분(미국 09:40 ET·한국 09:10 KST, 수능일 10:10) 앞이면 MALFORMED, 첫 분부터 받음. "
            + "프로필 표가 이미 닫은 사유(정규장 밖)는 그대로")
    void intradayMarketHasTheOpenOffsetFloor() {
        OrderValidator.Market early = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, OrderValidator.Money.USD), List.of(), TUE,
                et(TUE, 9, 35).plusSeconds(20), US, false, true);
        assertThat(early.closed()).containsKey(PaperBooks.MARKET);
        assertThat(early.closed().get(PaperBooks.MARKET).reason()).isEqualTo(OrderValidator.MALFORMED);
        assertThat(early.closed().get(PaperBooks.MARKET).detail()).contains("개장 10분 뒤(09:40 ET)").contains("09:37 ET");
        OrderValidator.Market first = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, OrderValidator.Money.USD), List.of(), TUE,
                et(TUE, 9, 38).plusSeconds(30), US, false, true);
        assertThat(first.closed()).as("기준 분 09:40 — 첫 분부터 받음").doesNotContainKey(PaperBooks.MARKET);

        OrderValidator.Market preClosed = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, OrderValidator.Money.USD)
                        .withClosed(Map.of(PaperBooks.MARKET, new OrderValidator.Closed(OrderValidator.MALFORMED, "정규장 밖"))), List.of(), TUE,
                et(TUE, 9, 0), US, false, true);
        assertThat(preClosed.closed().get(PaperBooks.MARKET).detail()).as("이미 닫힌 사유 그대로").isEqualTo("정규장 밖");

        OrderValidator.Market kr = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, KrPaperMarket.INSTANCE.money()), List.of(), KR_E,
                Instant.parse("2026-11-03T00:05:00Z"), KR, true, true);
        assertThat(kr.closed().get(PaperBooks.MARKET).detail()).contains("개장 10분 뒤(09:10 KST)").contains("09:07 KST");
        assertThat(FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, KrPaperMarket.INSTANCE.money()), List.of(), KR_E,
                Instant.parse("2026-11-03T00:08:30Z"), KR, true, true).closed()).doesNotContainKey(PaperBooks.MARKET);
        OrderValidator.Market exam = FreeTiming.validation(base(FreeTiming.INTRADAY_TIMINGS, KrPaperMarket.INSTANCE.money()), List.of(),
                KR_EXAM, Instant.parse("2026-11-19T01:05:00Z"), KR_SHIFTED, true, true);
        assertThat(exam.closed().get(PaperBooks.MARKET).detail()).as("수능일 10:00 개장 — 10:07 기준 분은 10:10 앞").contains("10:10 KST");
        assertThat(FreeTiming.validation(base(FreeTiming.DECISION_TIMINGS, OrderValidator.Money.USD), List.of(), TUE, MON_DECIDED, US, false,
                false).closed()).as("결정 표에는 장중 시장가가 없음").doesNotContainKey(PaperBooks.MARKET);
    }

    @Test
    @DisplayName("자유 시점 판의 표가 아니면(AT_MINUTE 없음) 막음 — 끈 판 표에 열쇠를 섞지 않음")
    void rejectsTablesWithoutAtMinute() {
        OrderValidator.Market off = base(List.of(PaperBooks.NEXT_OPEN, PaperBooks.NEXT_CLOSE), OrderValidator.Money.USD);
        assertThatThrownBy(() -> FreeTiming.validation(off, List.of(LocalTime.of(10, 0)), TUE, MON_DECIDED, US, false, false))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("AT_MINUTE 없음");
    }
}
