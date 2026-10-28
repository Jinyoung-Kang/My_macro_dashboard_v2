package com.macrodash.analytics;

import com.macrodash.analytics.ReviewFacts.BookNav;
import com.macrodash.analytics.ReviewFacts.BookReturn;
import com.macrodash.analytics.ReviewFacts.Comparison;
import com.macrodash.analytics.ReviewFacts.Decision;
import com.macrodash.analytics.ReviewFacts.DecisionFacts;
import com.macrodash.analytics.ReviewFacts.Entry;
import com.macrodash.analytics.ReviewFacts.EntryOpen;
import com.macrodash.analytics.ReviewFacts.Evidence;
import com.macrodash.analytics.ReviewFacts.Facts;
import com.macrodash.analytics.ReviewFacts.Fill;
import com.macrodash.analytics.ReviewFacts.FullSell;
import com.macrodash.analytics.ReviewFacts.Inputs;
import com.macrodash.analytics.ReviewFacts.InvalidationCheck;
import com.macrodash.analytics.ReviewFacts.NavPoint;
import com.macrodash.analytics.ReviewFacts.Order;
import com.macrodash.analytics.ReviewFacts.OrderFacts;
import com.macrodash.analytics.ReviewFacts.StopFill;
import com.macrodash.analytics.ReviewFacts.Window;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;

/**
 * 주간 복기 입력 사실 — 값은 모두 손으로 계산한 것과 대조합니다(명세 §3-3 "체결가·금요일 종가로 손계산과 같다").
 */
class ReviewFactsTest {

    private static final LocalDate WE = LocalDate.of(2026, 10, 30);   // 금요일
    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    private static LocalDate d(String text) {
        return LocalDate.parse(text);
    }

    /** "YYYY-MM-DD", 값, … 쌍으로 계열. */
    private static DailySeries series(Object... pairs) {
        TreeMap<LocalDate, Double> map = new TreeMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put(d((String) pairs[i]), ((Number) pairs[i + 1]).doubleValue());
        }
        return DailySeries.of(map);
    }

    /** firstRecent 앞 거래일 prior개를 priorValue로 채우고, firstRecent부터 거래일마다 recent 값을 잇습니다. */
    private static DailySeries history(int prior, double priorValue, LocalDate firstRecent, double... recent) {
        TreeMap<LocalDate, Double> map = new TreeMap<>();
        LocalDate day = firstRecent;
        for (int i = 0; i < prior; i++) {
            day = UsMarketCalendar.previousTradingDay(day);
            map.put(day, priorValue);
        }
        day = firstRecent;
        for (double v : recent) {
            map.put(day, v);
            day = UsMarketCalendar.nextTradingDay(day);
        }
        return DailySeries.of(map);
    }

    private static Order buy(long id, String ticker, Fill fill, String invalidation) {
        return new Order(id, ticker, "BUY", 5.0, null, "NEXT_CLOSE", fill == null ? "EXPIRED" : "FILLED", null,
                "논거 " + ticker, invalidation, fill, null);
    }

    private static Order sell(long id, String ticker, Fill fill) {
        return new Order(id, ticker, "SELL", null, 0.5, "NEXT_CLOSE", "FILLED", null, "매도 논거", "재돌파 시", fill,
                null);
    }

    private static Order rejected(long id, String ticker, String side) {
        return new Order(id, ticker, side, "BUY".equals(side) ? 5.0 : null, null, "NEXT_CLOSE", "REJECTED",
                "MONTHLY_CAP", "거절된 논거", null, null, null);
    }

    private static Decision ok(long id, LocalDate asOf, Order... orders) {
        return new Decision(id, "SCHEDULED", asOf, "OK", "NEUTRAL", 60.0, "요약 " + id, "노출 근거 " + id, null, 1,
                List.of(orders));
    }

    private static OrderFacts single(Facts facts) {
        return facts.decisions().get(0).orders().get(0);
    }

    private static Facts buildOne(Decision decision, Map<String, DailySeries> closes, List<StopFill> stops) {
        return ReviewFacts.build(new Inputs(List.of(decision), closes, stops, List.of(), List.of(), 3, "현행"), WE, 4,
                null);
    }

    // ------------------------------------------------------------------ 기준일·시각
    @Test
    @DisplayName("복기 기준일 = ISO 주의 마지막 거래일(보통 금요일, 같은 주 월~일 어느 날이든)")
    void weekEndingIsLastTradingDayOfIsoWeek() {
        assertThat(ReviewFacts.weekEnding(d("2026-10-26"))).isEqualTo(WE);    // 월
        assertThat(ReviewFacts.weekEnding(d("2026-10-28"))).isEqualTo(WE);    // 수
        assertThat(ReviewFacts.weekEnding(WE)).isEqualTo(WE);
        assertThat(ReviewFacts.weekEnding(d("2026-10-31"))).isEqualTo(WE);    // 토
        assertThat(ReviewFacts.weekEnding(d("2026-11-01"))).isEqualTo(WE);    // 일(ISO 주의 끝)
        assertThat(ReviewFacts.weekEnding(d("2026-11-02"))).isEqualTo(d("2026-11-06"));
    }

    @Test
    @DisplayName("금요일이 휴장이면 목요일 — 준틴스·독립기념일 대체·크리스마스·신정·성금요일. 추수감사절 주는 조기 폐장 금요일")
    void holidayFridayFallsBackToThursday() {
        assertThat(ReviewFacts.weekEnding(d("2026-06-17"))).isEqualTo(d("2026-06-18"));   // 06-19 준틴스
        assertThat(ReviewFacts.weekEnding(d("2026-07-01"))).isEqualTo(d("2026-07-02"));   // 07-03 독립기념일 대체
        assertThat(ReviewFacts.weekEnding(d("2026-12-22"))).isEqualTo(d("2026-12-24"));   // 12-25 크리스마스
        assertThat(ReviewFacts.weekEnding(d("2026-12-28"))).isEqualTo(d("2026-12-31"));   // 2027-01-01 신정
        assertThat(ReviewFacts.weekEnding(d("2027-03-22"))).isEqualTo(d("2027-03-25"));   // 03-26 성금요일
        assertThat(ReviewFacts.weekEnding(d("2026-11-23"))).isEqualTo(d("2026-11-27"));   // 목 휴장, 금 조기 폐장
    }

    @Test
    @DisplayName("마감이 끝난 최근 기준일 — 금요일 마감 전까지는 지난주, 마감 뒤엔 이번 주, 휴장 금요일엔 목요일")
    void latestCompletedWeekEnding() {
        // 금 16:00 EDT = 20:00Z. 마감 직후·직전.
        assertThat(ReviewFacts.latestCompletedWeekEnding(Instant.parse("2026-10-30T20:00:00Z"))).isEqualTo(WE);
        assertThat(ReviewFacts.latestCompletedWeekEnding(Instant.parse("2026-10-30T19:59:59Z")))
                .isEqualTo(d("2026-10-23"));
        assertThat(ReviewFacts.latestCompletedWeekEnding(Instant.parse("2026-10-28T12:00:00Z")))
                .isEqualTo(d("2026-10-23"));
        assertThat(ReviewFacts.latestCompletedWeekEnding(Instant.parse("2026-11-01T12:00:00Z"))).isEqualTo(WE);
        // 2026-06-19(금) 휴장 — 그날 낮에는 목요일 세션이 그 주의 기준일
        assertThat(ReviewFacts.latestCompletedWeekEnding(Instant.parse("2026-06-19T15:00:00Z")))
                .isEqualTo(d("2026-06-18"));
    }

    @Test
    @DisplayName("복기는 기준일 주의 토요일 09:00 KST(= 00:00Z)부터 — 목요일 기준일인 주도 토요일")
    void opensSaturdayNineKst() {
        assertThat(ReviewFacts.opensAt(WE, KST)).isEqualTo(Instant.parse("2026-10-31T00:00:00Z"));
        assertThat(ReviewFacts.isDue(Instant.parse("2026-10-30T23:59:59Z"), WE, KST)).isFalse();
        assertThat(ReviewFacts.isDue(Instant.parse("2026-10-31T00:00:00Z"), WE, KST)).isTrue();
        assertThat(ReviewFacts.opensAt(d("2026-06-18"), KST)).isEqualTo(Instant.parse("2026-06-20T00:00:00Z"));
    }

    @Test
    @DisplayName("창 = (기준일 − 4주, 기준일] — 시작일은 빼고 기준일은 넣음. 1주 미만·주 중간 기준일은 거절")
    void windowExcludesStartIncludesEnd() {
        Window w = ReviewFacts.window(WE, 4);
        assertThat(w.after()).isEqualTo(d("2026-10-02"));
        assertThat(w.contains(d("2026-10-02"))).isFalse();
        assertThat(w.contains(d("2026-10-03"))).isTrue();
        assertThat(w.contains(WE)).isTrue();
        assertThat(w.contains(d("2026-10-31"))).isFalse();
        assertThat(ReviewFacts.window(WE, 2).after()).isEqualTo(d("2026-10-16"));
        assertThatThrownBy(() -> ReviewFacts.window(WE, 0)).isInstanceOf(IllegalArgumentException.class);
        Inputs empty = new Inputs(List.of(), Map.of(), List.of(), List.of(), List.of(), 1, "현행");
        assertThatThrownBy(() -> ReviewFacts.build(empty, d("2026-10-29"), 4, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("어림 25,000토큰까지는 4주 그대로, 넘으면 2주로 줄이는 이유")
    void trimmedReason() {
        assertThat(ReviewFacts.trimmedReason(25_000)).isNull();
        assertThat(ReviewFacts.trimmedReason(25_001)).contains("25001토큰").contains("2주");
    }

    // ------------------------------------------------------------------ 주문 사실
    @Test
    @DisplayName("매수: 체결 뒤 수익률 = 금요일 종가 ÷ 체결가 − 1, 최대 낙폭은 체결가를 첫 고점으로, 스탑은 체결 뒤 첫 것")
    void buyReturnDrawdownAndStop() {
        // 195거래일 100 + 10-26..10-30 = 101, 105, 94.5, 99, 110 (점 200개)
        DailySeries aaa = history(195, 100.0, d("2026-10-26"), 101, 105, 94.5, 99, 110);
        Order order = buy(11, "AAA", new Fill(d("2026-10-26"), 100.0), "트레일링 스탑 발동 또는 -8% 하락");
        List<StopFill> stops = List.of(new StopFill("AAA", d("2026-10-22"), 90.0),   // 체결 전 — 무시
                new StopFill("BBB", d("2026-10-27"), 50.0),                           // 다른 종목
                new StopFill("AAA", d("2026-10-28"), 96.6));
        OrderFacts o = single(buildOne(ok(1, d("2026-10-23"), order), Map.of("AAA", aaa), stops));

        assertThat(o.weekEndingClose()).isEqualTo(110.0);
        assertThat(o.returnSinceFillPct()).isEqualTo(10.0);                 // 110 / 100 − 1
        // 고점 100 → 101 → 105, 94.5 / 105 − 1 = −10%
        assertThat(o.maxDrawdownPct()).isEqualTo(-10.0);
        assertThat(o.stop().triggered()).isTrue();
        assertThat(o.stop().date()).isEqualTo(d("2026-10-28"));
        assertThat(o.stop().returnPct()).isEqualTo(-3.4);                   // 96.6 / 100 − 1
        assertThat(o.afterSellPct()).isNull();
        assertThat(o.hypothetical()).isNull();
        // 200점 평균 = (195 × 100 + 509.5) / 200 = 100.0475, 110 / 100.0475 − 1 = 9.9478% → 9.95
        assertThat(o.ma200().average()).isEqualTo(100.0475);
        assertThat(o.ma200().vsPct()).isEqualTo(9.95);
        assertThat(o.ma200().below()).isFalse();
        // 스탑 충족, −8%는 낙폭 −10%로 충족
        assertThat(o.invalidationCheck().result()).isEqualTo(ReviewFacts.MET);
        assertThat(o.invalidationCheck().checks()).extracting(ReviewFacts.Check::pattern, ReviewFacts.Check::met)
                .containsExactly(tuple(ReviewFacts.STOP, true),
                        tuple(ReviewFacts.DRAWDOWN, true));
        assertThat(o.notes()).isEmpty();
    }

    @Test
    @DisplayName("스탑이 없으면 triggered=false, 날짜·가격 null")
    void noStop() {
        DailySeries aaa = series("2026-10-26", 100, "2026-10-30", 104);
        OrderFacts o = single(buildOne(ok(1, d("2026-10-23"), buy(11, "AAA", new Fill(d("2026-10-26"), 100.0), null)),
                Map.of("AAA", aaa), List.of()));
        assertThat(o.stop().triggered()).isFalse();
        assertThat(o.stop().date()).isNull();
        assertThat(o.returnSinceFillPct()).isEqualTo(4.0);
        assertThat(o.maxDrawdownPct()).isEqualTo(0.0);   // 한 번도 고점 밑으로 내려가지 않음
    }

    @Test
    @DisplayName("200일선: 점 199개면 null + 이유, 200개면 평균과 비교(아래면 below)")
    void ma200() {
        List<String> notes = new ArrayList<>();
        DailySeries short199 = history(198, 100.0, WE, 90);
        assertThat(ReviewFacts.ma200(short199, WE, 90.0, notes)).isNull();
        assertThat(notes).singleElement().asString().contains("199일");

        // 199 × 100 + 90 = 19,990 / 200 = 99.95, 90 / 99.95 − 1 = −9.9550% → −9.95
        DailySeries full = history(199, 100.0, WE, 90);
        ReviewFacts.Ma200 ma = ReviewFacts.ma200(full, WE, 90.0, new ArrayList<>());
        assertThat(ma.average()).isEqualTo(99.95);
        assertThat(ma.vsPct()).isEqualTo(-9.95);
        assertThat(ma.below()).isTrue();
    }

    @Test
    @DisplayName("금요일 종가가 없으면 수익률·200일선 null + 이유(마지막 종가 날짜) — 직전 종가로 대신하지 않음")
    void missingWeekEndingClose() {
        DailySeries ddd = series("2026-10-27", 50, "2026-10-28", 45, "2026-10-29", 47.5);
        OrderFacts o = single(buildOne(ok(1, d("2026-10-26"), buy(11, "DDD", new Fill(d("2026-10-27"), 50.0), null)),
                Map.of("DDD", ddd), List.of()));
        assertThat(o.weekEndingClose()).isNull();
        assertThat(o.returnSinceFillPct()).isNull();
        assertThat(o.ma200()).isNull();
        assertThat(o.notes()).anySatisfy(n -> assertThat(n).contains("종가 없음").contains("2026-10-29"));
        // 낙폭은 기준일까지 있는 종가로: 45 / 50 − 1
        assertThat(o.maxDrawdownPct()).isEqualTo(-10.0);

        OrderFacts none = single(buildOne(ok(1, d("2026-10-26"),
                buy(11, "ZZZ", new Fill(d("2026-10-27"), 50.0), "-8% 하락")), Map.of(), List.of()));
        assertThat(none.returnSinceFillPct()).isNull();
        assertThat(none.maxDrawdownPct()).isNull();
        assertThat(none.notes()).anySatisfy(n -> assertThat(n).contains("가격 이력 없음"));
        assertThat(none.invalidationCheck().result()).isEqualTo(ReviewFacts.UNEVALUABLE);
    }

    @Test
    @DisplayName("매도: 판 뒤 변화 = 금요일 종가 ÷ 매도 체결가 − 1, 음수 avoided·양수 missed, 낙폭·스탑은 해당 없음")
    void sellAvoidedAndMissed() {
        Map<String, DailySeries> closes = Map.of(
                "EEE", series("2026-10-27", 50, "2026-10-30", 45),
                "FFF", series("2026-10-27", 40, "2026-10-30", 44));
        Facts facts = buildOne(ok(1, d("2026-10-26"), sell(11, "EEE", new Fill(d("2026-10-27"), 50.0)),
                sell(12, "FFF", new Fill(d("2026-10-27"), 40.0))), closes, List.of());
        OrderFacts eee = facts.decisions().get(0).orders().get(0);
        OrderFacts fff = facts.decisions().get(0).orders().get(1);
        assertThat(eee.afterSellPct()).isEqualTo(-10.0);
        assertThat(eee.afterSellLabel()).isEqualTo(ReviewFacts.AVOIDED);
        assertThat(fff.afterSellPct()).isEqualTo(10.0);
        assertThat(fff.afterSellLabel()).isEqualTo(ReviewFacts.MISSED);
        assertThat(eee.returnSinceFillPct()).isNull();
        assertThat(eee.maxDrawdownPct()).isNull();
        assertThat(eee.stop()).isNull();

        Map<String, Object> map = facts.toMap();
        @SuppressWarnings("unchecked")
        Map<String, Object> order = (Map<String, Object>) ((List<Object>) ((Map<String, Object>)
                ((List<Object>) map.get("decisions")).get(0)).get("orders")).get(0);
        assertThat(order).containsKeys("sellFraction", "afterSellPct", "afterSellLabel")
                .doesNotContainKeys("targetWeightPct", "returnSinceFillPct", "maxDrawdownPct", "stop", "rejectReason");
    }

    @Test
    @DisplayName("거절 주문: 결정 다음 세션 종가 → 금요일 종가의 가정 수익률, 다음 세션이 기준일 뒤면 null + 이유")
    void rejectedHypothetical() {
        Map<String, DailySeries> closes = Map.of(
                "GGG", series("2026-10-27", 80, "2026-10-30", 88),
                "HHH", series("2026-10-27", 50, "2026-10-30", 45));
        Facts facts = buildOne(ok(1, d("2026-10-26"), rejected(11, "GGG", "BUY"), rejected(12, "HHH", "SELL")),
                closes, List.of());
        OrderFacts ggg = facts.decisions().get(0).orders().get(0);
        OrderFacts hhh = facts.decisions().get(0).orders().get(1);
        assertThat(ggg.accepted()).isFalse();
        assertThat(ggg.rejectReason()).isEqualTo("MONTHLY_CAP");
        assertThat(ggg.hypothetical().entryDate()).isEqualTo(d("2026-10-27"));
        assertThat(ggg.hypothetical().entryClose()).isEqualTo(80.0);
        assertThat(ggg.hypothetical().returnPct()).isEqualTo(10.0);           // 88 / 80 − 1
        assertThat(ggg.hypothetical().afterSellLabel()).isNull();
        assertThat(ggg.fill()).isNull();
        assertThat(ggg.returnSinceFillPct()).isNull();
        assertThat(hhh.hypothetical().returnPct()).isEqualTo(-10.0);          // 45 / 50 − 1
        assertThat(hhh.hypothetical().afterSellLabel()).isEqualTo(ReviewFacts.AVOIDED);

        // 금요일 결정 → 다음 세션 11-02는 기준일 뒤
        OrderFacts late = single(buildOne(ok(2, WE, rejected(13, "GGG", "BUY")), closes, List.of()));
        assertThat(late.hypothetical().entryDate()).isEqualTo(d("2026-11-02"));
        assertThat(late.hypothetical().returnPct()).isNull();
        assertThat(late.notes()).anySatisfy(n -> assertThat(n).contains("기준일 뒤"));

        Map<String, Object> map = facts.toMap();
        @SuppressWarnings("unchecked")
        Map<String, Object> order = (Map<String, Object>) ((List<Object>) ((Map<String, Object>)
                ((List<Object>) map.get("decisions")).get(0)).get("orders")).get(0);
        @SuppressWarnings("unchecked")
        Map<String, Object> hypothetical = (Map<String, Object>) order.get("hypothetical");
        assertThat(hypothetical).containsEntry("basis", ReviewFacts.HYPOTHETICAL).containsEntry("returnPct", 10.0);
        assertThat(order).containsEntry("rejectReason", "MONTHLY_CAP").containsEntry("fill", null);
    }

    @Test
    @DisplayName("체결가가 체결일 이력 종가의 2배(2:1 분할 뒤 수정주가) — 체결가 대비 수치 null + 이유, 스탑 여부는 그대로")
    void splitBasisMismatch() {
        DailySeries iii = series("2026-10-26", 100, "2026-10-27", 90, "2026-10-30", 110);
        OrderFacts o = single(buildOne(ok(1, d("2026-10-23"), buy(11, "III", new Fill(d("2026-10-26"), 200.0), "스탑")),
                Map.of("III", iii), List.of(new StopFill("III", d("2026-10-29"), 92.0))));
        assertThat(o.returnSinceFillPct()).isNull();
        assertThat(o.maxDrawdownPct()).isNull();
        assertThat(o.stop().triggered()).isTrue();
        assertThat(o.stop().returnPct()).isNull();
        assertThat(o.notes()).anySatisfy(n -> assertThat(n).contains("분할"));
        assertThat(o.weekEndingClose()).isEqualTo(110.0);
    }

    @Test
    @DisplayName("전량 매도 뒤 다시 산 포지션의 스탑은 앞선 매수의 스탑이 아님 — 발동 안 함 + 이유(D-FACTS-3)")
    void stopAfterFullSellBelongsToLaterPosition() {
        // #11 10-26 체결 → 10-27 전량 매도 → #13 10-28 재매수 → 10-29 스탑(#13의 포지션)
        DailySeries aaa = series("2026-10-26", 100, "2026-10-27", 102, "2026-10-28", 101, "2026-10-29", 93,
                "2026-10-30", 95);
        Order first = buy(11, "AAA", new Fill(d("2026-10-26"), 100.0), "트레일링 스탑 발동 시 논거 폐기");
        Order again = buy(13, "AAA", new Fill(d("2026-10-28"), 101.0), "트레일링 스탑 발동 시 논거 폐기");
        List<StopFill> stops = List.of(new StopFill("AAA", d("2026-10-29"), 92.0));
        Facts facts = ReviewFacts.build(new Inputs(List.of(ok(1, d("2026-10-23"), first), ok(2, d("2026-10-27"), again)),
                Map.of("AAA", aaa), stops, List.of(new FullSell("AAA", d("2026-10-27"))), List.of(), 3, "현행"), WE, 4,
                null);

        OrderFacts sold = facts.decisions().get(0).orders().get(0);
        assertThat(sold.stop().triggered()).isFalse();
        assertThat(sold.stop().date()).isNull();
        assertThat(sold.notes()).anySatisfy(n -> assertThat(n).contains("2026-10-27 전량 매도")
                .contains("이 매수의 스탑으로 보지 않음"));
        assertThat(sold.invalidationCheck().result()).isEqualTo(ReviewFacts.NOT_MET);
        assertThat(sold.returnSinceFillPct()).as("계속 들고 있었다면 — 매도와 무관").isEqualTo(-5.0);
        OrderFacts rebought = facts.decisions().get(1).orders().get(0);
        assertThat(rebought.stop().triggered()).isTrue();
        assertThat(rebought.stop().date()).isEqualTo(d("2026-10-29"));
        assertThat(rebought.invalidationCheck().result()).isEqualTo(ReviewFacts.MET);

        // 매수 체결일과 같은 날의 전량 매도는 그 매수 전(장부는 한 관측치에서 매도를 먼저), 스탑 뒤 매도·다른 종목은 상관없음
        List<FullSell> unrelated = List.of(new FullSell("AAA", d("2026-10-26")), new FullSell("BBB", d("2026-10-27")),
                new FullSell("AAA", d("2026-10-30")));
        Facts kept = ReviewFacts.build(new Inputs(List.of(ok(1, d("2026-10-23"), first)), Map.of("AAA", aaa), stops,
                unrelated, List.of(), 3, "현행"), WE, 4, null);
        assertThat(single(kept).stop().triggered()).isTrue();
        assertThat(single(kept).stop().date()).isEqualTo(d("2026-10-29"));
    }

    @Test
    @DisplayName("기준일 뒤 체결·만료는 기준일 시점의 PENDING — 늦게 돌린 복기도 토요일에 돌린 것과 같은 입력(체결일을 싣지 않음)")
    void fillAfterWeekEndingAndUnfilled() {
        DailySeries jjj = series("2026-10-30", 20, "2026-11-02", 21);
        LocalDate expires = d("2026-11-06");
        // 토요일에 돌렸다면 금요일 결정의 주문은 아직 대기 중입니다.
        Order saturday = new Order(11, "JJJ", "BUY", 5.0, null, "NEXT_CLOSE", "PENDING", null, "논거 JJJ", null, null,
                expires);
        Map<String, Object> onSaturday = buildOne(ok(1, WE, saturday), Map.of("JJJ", jjj), List.of()).toMap();
        // 다음 주 중에 늦게 돌리면 그 주문은 11-02에 체결됐거나, 만료일(= 기준일, 그날 마감까지 유효)이 지나 만료돼 있습니다.
        Order filledLater = new Order(11, "JJJ", "BUY", 5.0, null, "NEXT_CLOSE", "FILLED", null, "논거 JJJ", null,
                new Fill(d("2026-11-02"), 21.0), expires);
        Order expiredLater = new Order(11, "JJJ", "BUY", 5.0, null, "NEXT_CLOSE", "EXPIRED", null, "논거 JJJ", null, null,
                WE);
        for (Order late : List.of(filledLater, expiredLater)) {
            Facts facts = buildOne(ok(1, WE, late), Map.of("JJJ", jjj), List.of());
            OrderFacts o = single(facts);
            assertThat(o.status()).as(late.status()).isEqualTo("PENDING");
            assertThat(o.fill()).isNull();
            assertThat(o.returnSinceFillPct()).isNull();
            assertThat(o.stop()).isNull();
            assertThat(o.notes()).as(late.status()).contains("미체결(PENDING)")
                    .noneSatisfy(n -> assertThat(n).contains("2026-11-02"));
            assertThat(facts.toMap()).as(late.status() + " — 토요일 입력과 같음").isEqualTo(onSaturday);
        }

        // 기준일 전에 만료된 주문은 그대로 EXPIRED
        OrderFacts expired = single(buildOne(ok(1, d("2026-10-26"), buy(12, "JJJ", null, null)),
                Map.of("JJJ", jjj), List.of()));
        assertThat(expired.accepted()).isTrue();
        assertThat(expired.status()).isEqualTo("EXPIRED");
        assertThat(expired.hypothetical()).isNull();
        assertThat(expired.notes()).contains("미체결(EXPIRED)");
        Order expiredBefore = new Order(12, "JJJ", "BUY", 5.0, null, "NEXT_CLOSE", "EXPIRED", null, "논거", null, null,
                d("2026-10-29"));
        assertThat(single(buildOne(ok(1, d("2026-10-26"), expiredBefore), Map.of("JJJ", jjj), List.of())).status())
                .isEqualTo("EXPIRED");
    }

    // ------------------------------------------------------------------ 무효화 조건
    @Test
    @DisplayName("(a) 스탑 언급 → 스탑 발동 여부. nonstop은 스탑이 아님")
    void invalidationStop() {
        Evidence fired = new Evidence(true, null, -3.0, null, false, null);
        Evidence quiet = new Evidence(false, null, -3.0, null, false, null);
        assertThat(ReviewFacts.evaluate("트레일링 스탑이 나면 논거 폐기", fired).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("Exit if the stop is hit", quiet).result()).isEqualTo(ReviewFacts.NOT_MET);
        assertThat(ReviewFacts.evaluate("스톱 발동", quiet).checks()).singleElement()
                .extracting(ReviewFacts.Check::pattern).isEqualTo(ReviewFacts.STOP);
        assertThat(ReviewFacts.evaluate("nonstop rally ends", fired).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        // 하이픈·한글 표기도 같은 낱말 — \b는 하이픈 뒤에도 서서 'non-stop'을 스탑으로 읽었음(D-FACTS-5)
        assertThat(ReviewFacts.evaluate("non-stop rally 꺾이면", fired).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        assertThat(ReviewFacts.evaluate("논스톱 랠리가 끝나면", fired).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        assertThat(ReviewFacts.evaluate("Stop-loss 발동", quiet).result()).isEqualTo(ReviewFacts.NOT_MET);
    }

    @Test
    @DisplayName("(b) 200일선 + 이탈·하회·below → 금요일 종가 < 200일 평균")
    void invalidationMa200() {
        Evidence below = new Evidence(false, null, -1.0, null, true, null);
        Evidence above = new Evidence(false, null, -1.0, null, false, null);
        assertThat(ReviewFacts.evaluate("200일선 하회 시", below).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("200일 이동평균 이탈", above).result()).isEqualTo(ReviewFacts.NOT_MET);
        assertThat(ReviewFacts.evaluate("closes below the 200-day moving average", below).result())
                .isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("200DMA 아래로 마감", below).result()).isEqualTo(ReviewFacts.MET);
        // 방향 말 없이 200일선만 — 읽지 않음
        assertThat(ReviewFacts.evaluate("200일선 위에서 지지", below).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        // 1200일은 200일이 아님
        assertThat(ReviewFacts.evaluate("1200일 하회", below).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
    }

    @Test
    @DisplayName("(b) 방향 말은 200일선 언급 바로 뒤에 붙을 때만 — 50일선·가이던스의 '이탈·하회·아래'를 200일선에 붙이지 않음(D-FACTS-1)")
    void invalidationMa200OnlyAdjacentDirection() {
        Evidence below = new Evidence(false, null, -1.0, null, true, null);
        Evidence above = new Evidence(false, null, -1.0, null, false, null);
        for (String text : List.of("50일선 이탈 시 비중 축소, 200일선은 지지 확인", "200일선 위 유지 중 50일선 하회 2거래일 연속",
                "종가가 50일선 아래로 마감하면(200일선 위라도)", "50일선 하회 또는 200일선 회복 실패",
                "실적 가이던스 하회 또는 200일선 위 지지 실패", "200일선 회복 실패", "50-day below, 200-day holds")) {
            assertThat(ReviewFacts.evaluate(text, below).result()).as(text).isEqualTo(ReviewFacts.UNEVALUABLE);
            assertThat(ReviewFacts.evaluate(text, above).checks()).as(text).isEmpty();
        }
        // 붙어 있으면 읽음 — 사이에 '이동평균선을'이 있어도, 50일선 조건이 앞에 있어도
        assertThat(ReviewFacts.evaluate("200일 이동평균선을 하회하면", below).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("50일선 이탈 또는 200일선 하회", above).result()).isEqualTo(ReviewFacts.NOT_MET);
        assertThat(ReviewFacts.evaluate("200-day moving average below", below).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("trades under its 200DMA", below).result()).isEqualTo(ReviewFacts.MET);
    }

    @Test
    @DisplayName("(c) '-8%'·'−8%'·'8% 이상 하락'·'drops 8%' → 최대 낙폭 ≤ −8%(같으면 충족), %p·범위는 읽지 않음")
    void invalidationDrawdown() {
        Evidence shallow = new Evidence(false, null, -5.0, null, false, null);
        Evidence exact = new Evidence(false, null, -8.0, null, false, null);
        for (String text : List.of("-8% 하락 시", "−8% 도달", "8% 이상 하락하면", "8%하락", "if it drops 8% from entry")) {
            InvalidationCheck c = ReviewFacts.evaluate(text, shallow);
            assertThat(c.result()).as(text).isEqualTo(ReviewFacts.NOT_MET);
            assertThat(c.checks()).as(text).singleElement().satisfies(check -> {
                assertThat(check.pattern()).isEqualTo(ReviewFacts.DRAWDOWN);
                assertThat(check.thresholdPct()).isEqualTo(-8.0);
            });
            assertThat(ReviewFacts.evaluate(text, exact).result()).as(text).isEqualTo(ReviewFacts.MET);
        }
        assertThat(ReviewFacts.evaluate("영업이익률 -2%p 하회", shallow).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        assertThat(ReviewFacts.evaluate("3-8% 범위 조정", shallow).result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        // 하락 폭 둘 — 작은 N부터 조건별로
        InvalidationCheck two = ReviewFacts.evaluate("-5% 경고, -10% 청산", new Evidence(false, null, -7.0, null,
                false, null));
        assertThat(two.checks()).extracting(ReviewFacts.Check::thresholdPct, ReviewFacts.Check::met)
                .containsExactly(tuple(-5.0, true),
                        tuple(-10.0, false));
        assertThat(two.result()).isEqualTo(ReviewFacts.MET);
    }

    @Test
    @DisplayName("(c) 주가가 아닌 수치(가이던스·EPS·매출)·상대 성과(SPY 대비)의 −N%는 낙폭으로 읽지 않음 — 고점·매수가 대비는 읽음(D-FACTS-2)")
    void invalidationDrawdownOnlyPrice() {
        Evidence dip = new Evidence(false, null, -4.0, null, false, null);
        for (String text : List.of("다음 분기 가이던스 -3% 이상 하향", "SPY 대비 -3% 상대 부진", "매출 성장률 -5% 전환",
                "EPS -10% 감소 시", "매출 8% 하락", "-3% 상대 부진", "revenue drops 8%", "underperforms by -5% vs SPY")) {
            InvalidationCheck c = ReviewFacts.evaluate(text, dip);
            assertThat(c.result()).as(text).isEqualTo(ReviewFacts.UNEVALUABLE);
            assertThat(c.checks()).as(text).isEmpty();
        }
        // 가격이 기준인 '대비'·'실적 발표 뒤'와 다른 절의 지표 말은 막지 않음
        assertThat(ReviewFacts.evaluate("고점 대비 -3% 하락", dip).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("매수가 대비 −8%", dip).result()).isEqualTo(ReviewFacts.NOT_MET);
        assertThat(ReviewFacts.evaluate("실적 발표 뒤 -3% 하락 시", dip).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("가이던스 하향 또는 -3% 하락", dip).result()).isEqualTo(ReviewFacts.MET);
        assertThat(ReviewFacts.evaluate("EPS -10% 감소, 또는 주가 -8% 하락", dip).checks())
                .extracting(ReviewFacts.Check::thresholdPct).containsExactly(-8.0);
    }

    @Test
    @DisplayName("읽지 못하는 문장·빈 문장은 평가 불가, 사실이 일부만 있으면 일부 평가 불가")
    void invalidationUnrecognisedAndPartial() {
        Evidence e = new Evidence(false, null, -5.0, null, null, "200일선 없음(notes)");
        InvalidationCheck guidance = ReviewFacts.evaluate("가이던스 하향 또는 경쟁사 점유율 확대", e);
        assertThat(guidance.result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        assertThat(guidance.checks()).isEmpty();
        assertThat(guidance.reason()).contains("코드가 읽는 조건");
        assertThat(ReviewFacts.evaluate("  ", e).reason()).isEqualTo("무효화 조건 없음");
        assertThat(ReviewFacts.evaluate(null, e).result()).isEqualTo(ReviewFacts.UNEVALUABLE);

        InvalidationCheck partial = ReviewFacts.evaluate("200일선 이탈 또는 -8%", e);
        assertThat(partial.result()).isEqualTo(ReviewFacts.PARTIAL);
        assertThat(partial.checks().get(0).met()).isNull();
        assertThat(partial.checks().get(0).reason()).isEqualTo("200일선 없음(notes)");

        Evidence unbought = new Evidence(null, "매수 체결 없음", null, "매수 체결 없음", null, "200일선 없음(notes)");
        InvalidationCheck none = ReviewFacts.evaluate("스탑 또는 -8%", unbought);
        assertThat(none.result()).isEqualTo(ReviewFacts.UNEVALUABLE);
        assertThat(none.checks()).extracting(ReviewFacts.Check::reason).containsOnly("매수 체결 없음");
    }

    // ------------------------------------------------------------------ 계좌 비교
    @Test
    @DisplayName("계좌 비교: 창 시작에 줄이 없는 계좌가 있으면 모두 줄이 있는 첫 날부터, 기록 없는 계좌는 null(0 아님)")
    void comparisonCommonStart() {
        List<BookNav> books = List.of(
                new BookNav("rules", List.of(new NavPoint(d("2026-10-30"), 98_000, true),
                        new NavPoint(d("2026-10-23"), 100_000, true))),
                new BookNav("bench_spy", List.of(new NavPoint(d("2026-10-23"), 100_000, true),
                        new NavPoint(d("2026-10-30"), 101_000, false))),
                new BookNav("bench_mix", List.of()),
                new BookNav("claude", List.of(new NavPoint(d("2026-10-23"), 100_000, true),
                        new NavPoint(d("2026-10-26"), 99_000, true), new NavPoint(d("2026-10-30"), 103_000, true))));
        Comparison c = ReviewFacts.comparison(books, ReviewFacts.window(WE, 4));
        assertThat(c.from()).isEqualTo(d("2026-10-23"));
        assertThat(c.to()).isEqualTo(WE);
        assertThat(c.note()).contains("2026-10-02");
        assertThat(c.books()).extracting(BookReturn::book, BookReturn::returnPct, BookReturn::isEstimated)
                .containsExactly(tuple("rules", -2.0, false),
                        tuple("bench_spy", 1.0, true),
                        tuple("bench_mix", null, null),
                        tuple("claude", 3.0, false));
        assertThat(c.books().get(2).reason()).isEqualTo("순자산 기록 없음");
    }

    @Test
    @DisplayName("계좌 비교: 모두 창 시작 줄이 있으면 그날부터, 창 시작이 휴장이면 직전 거래일, 기준일 줄이 없으면 그 계좌만 null")
    void comparisonBaseAndMissingEnd() {
        LocalDate we = d("2026-07-31");      // after = 07-03(독립기념일 대체 휴장) → 기준 07-02
        List<BookNav> books = List.of(
                new BookNav("rules", List.of(new NavPoint(d("2026-07-02"), 100_000, true),
                        new NavPoint(d("2026-07-15"), 50_000, true), new NavPoint(we, 105_000, true))),
                new BookNav("claude", List.of(new NavPoint(d("2026-07-02"), 100_000, true),
                        new NavPoint(d("2026-07-30"), 104_000, true))));
        Comparison c = ReviewFacts.comparison(books, ReviewFacts.window(we, 4));
        assertThat(c.from()).isEqualTo(d("2026-07-02"));
        assertThat(c.books().get(0).returnPct()).isEqualTo(5.0);
        assertThat(c.books().get(1).returnPct()).isNull();
        assertThat(c.books().get(1).reason()).contains("2026-07-31");
    }

    // ------------------------------------------------------------------ 조립·직렬화
    @Test
    @DisplayName("창 안 OK·NO_TRADE만 사실로(기준일·id 순, 주문 id 순), 나머지 상태는 건수만, NO_TRADE는 짧은 줄")
    void decisionsFilteredOrderedAndShortNoTrade() {
        Decision outside = ok(1, d("2026-10-02"), rejected(1, "X", "BUY"));
        Decision noTrade = new Decision(3, "SCHEDULED", d("2026-10-27"), "NO_TRADE", "RISK_OFF", 40.0, "요약",
                "근거", "관망 — 일정 대기", 2, List.of());
        Decision error = new Decision(4, "SCHEDULED", d("2026-10-27"), "API_ERROR", null, null, null, null, null,
                null, List.of());
        Decision skipped = new Decision(6, "SCHEDULED", WE, "SKIPPED", null, null, null, null, null, null, List.of());
        Decision withOrders = ok(5, d("2026-10-28"), rejected(12, "B", "BUY"), rejected(11, "A", "BUY"));
        Inputs in = new Inputs(List.of(withOrders, skipped, error, noTrade, outside), Map.of(), List.of(),
                List.of(), List.of(), 3, "현행");
        Facts facts = ReviewFacts.build(in, WE, 4, null);

        assertThat(facts.hasDecisions()).isTrue();
        assertThat(facts.decisions()).extracting(DecisionFacts::id).containsExactly(3L, 5L);
        assertThat(facts.decisions().get(1).orders()).extracting(OrderFacts::id).containsExactly(11L, 12L);
        assertThat(facts.omittedDecisions()).containsExactly(Map.entry("API_ERROR", 1), Map.entry("SKIPPED", 1));

        @SuppressWarnings("unchecked")
        Map<String, Object> short3 = (Map<String, Object>) ((List<Object>) facts.toMap().get("decisions")).get(0);
        assertThat(short3.keySet()).containsExactly("id", "kind", "asOf", "status", "stance", "targetExposurePct",
                "noTradeReason", "frameworkVersion");
        assertThat(short3).containsEntry("noTradeReason", "관망 — 일정 대기").containsEntry("targetExposurePct", 40.0);

        Facts onlyErrors = ReviewFacts.build(new Inputs(List.of(error, outside), Map.of(), List.of(), List.of(),
                List.of(), 3, "현행"), WE, 4, null);
        assertThat(onlyErrors.hasDecisions()).isFalse();
        // 2주 창이면 10-16 이전 결정은 빠짐
        Decision early = ok(7, d("2026-10-15"));
        assertThat(ReviewFacts.build(new Inputs(List.of(early, withOrders), Map.of(), List.of(), List.of(), List.of(), 3,
                "현행"), WE, 2, "줄임").decisions()).extracting(DecisionFacts::id).containsExactly(5L);
    }

    @Test
    @DisplayName("낸 주문이 모두 거절된 NO_TRADE는 짧은 줄로 접지 않고 주문(가정 수익률)까지 싣는다")
    void allRejectedNoTradeKeepsOrders() {
        // 10-26(월) 결정 → 가정 체결 10-27 종가 100 → 기준일 10-30 종가 110: +10.00%(가정)
        Decision allRejected = new Decision(8, "SCHEDULED", d("2026-10-26"), "NO_TRADE", "RISK_ON", 70.0, "요약",
                "근거", null, 2, List.of(rejected(21, "AAA", "BUY")));
        Map<String, DailySeries> closes = Map.of("AAA", series("2026-10-26", 98, "2026-10-27", 100,
                "2026-10-28", 104, "2026-10-29", 106, "2026-10-30", 110));
        Facts facts = buildOne(allRejected, closes, List.of());

        assertThat(facts.decisions().get(0).orders()).hasSize(1);
        assertThat(single(facts).hypothetical().returnPct()).isEqualTo(10.0);
        @SuppressWarnings("unchecked")
        Map<String, Object> row = (Map<String, Object>) ((List<Object>) facts.toMap().get("decisions")).get(0);
        assertThat(row.keySet()).containsExactly("id", "kind", "asOf", "status", "stance", "targetExposurePct",
                "summary", "exposureRationale", "frameworkVersion", "orders");
        assertThat(row).containsEntry("status", "NO_TRADE").containsEntry("summary", "요약");
    }

    @Test
    @DisplayName("요약·노출 근거·관망 사유는 300자로 자름(끝 '…' 포함 300자), 논거·무효화 문장은 그대로")
    void clipsLongText() {
        String longKorean = "가".repeat(400);
        Decision decision = new Decision(1, "SCHEDULED", d("2026-10-26"), "OK", "NEUTRAL", 50.0, longKorean,
                "a".repeat(500), null, 1, List.of(new Order(2, "A", "BUY", 5.0, null, "NEXT_CLOSE", "REJECTED", "X",
                "논".repeat(600), "무".repeat(300), null, null)));
        Inputs in = new Inputs(List.of(decision), Map.of(), List.of(), List.of(), List.of(), 1, "현행");
        DecisionFacts f = ReviewFacts.build(in, WE, 4, null).decisions().get(0);
        assertThat(f.summary()).hasSize(300).endsWith("…");
        assertThat(f.exposureRationale()).hasSize(300).endsWith("…");
        assertThat(f.orders().get(0).thesis()).hasSize(600);
        assertThat(f.orders().get(0).invalidation()).hasSize(300);
        assertThat(ReviewFacts.clip("😀😀", 2)).isEqualTo("…");   // 서로게이트 쌍을 가르지 않음
    }

    @Test
    @DisplayName("같은 입력이면 같은 모양 — 키 순서 고정, 입력 순서를 바꿔도 같음")
    void deterministicMap() {
        DailySeries aaa = series("2026-10-26", 100, "2026-10-30", 110);
        Decision a = ok(5, d("2026-10-28"), buy(11, "AAA", new Fill(d("2026-10-26"), 100.0), "스탑"));
        Decision b = ok(4, d("2026-10-27"), rejected(12, "AAA", "BUY"));
        List<StopFill> stops = List.of(new StopFill("AAA", d("2026-10-29"), 95.0),
                new StopFill("AAA", d("2026-10-28"), 96.0));
        List<StopFill> reversedStops = new ArrayList<>(stops);
        Collections.reverse(reversedStops);
        Map<String, DailySeries> closes = new HashMap<>();
        closes.put("AAA", aaa);
        List<BookNav> books = List.of(new BookNav("claude", List.of(new NavPoint(d("2026-10-02"), 1, true),
                new NavPoint(WE, 1.1, true))));
        Map<String, Object> one = ReviewFacts.build(new Inputs(List.of(a, b), closes, stops, List.of(), books, 3, "현행"),
                WE, 4, null).toMap();
        Map<String, Object> two = ReviewFacts.build(new Inputs(List.of(b, a), closes, reversedStops, List.of(), books, 3,
                "현행"), WE, 4, null).toMap();
        assertThat(one).isEqualTo(two);
        assertThat(one.toString()).isEqualTo(two.toString());
        assertThat(one.keySet()).containsExactly("inputVersion", "weekEnding", "window", "trimmedReason", "framework",
                "note", "decisions", "omittedDecisions", "comparison");
        assertThat(one).containsEntry("weekEnding", "2026-10-30");
        // 스탑은 날짜 순으로 첫 것(10-28)
        @SuppressWarnings("unchecked")
        Map<String, Object> filled = (Map<String, Object>) ((List<Object>) ((Map<String, Object>)
                ((List<Object>) one.get("decisions")).get(1)).get("orders")).get(0);
        assertThat(filled.keySet()).containsExactly("id", "ticker", "side", "targetWeightPct", "timing", "status",
                "accepted", "thesis", "invalidation", "fill", "weekEndingClose", "returnSinceFillPct",
                "maxDrawdownPct", "stop", "ma200", "invalidationCheck", "notes");
        assertThat(filled.get("stop")).isEqualTo(Map.of("triggered", true, "date", "2026-10-28", "price", 96.0,
                "returnPct", -4.0));
        assertThat(filled).containsEntry("returnSinceFillPct", 10.0).containsEntry("ma200", null);
    }

    // ------------------------------------------------------------------ 달력을 받는 판(2단계 A2)
    @Test
    @DisplayName("달력을 받는 판 — 기준일·최근 기준일: 미국 달력이면 옛 시그니처와 같고, 다른 달력이면 그 달력의 거래일로")
    void weekEndingWithCalendar() {
        for (LocalDate day = d("2026-01-01"); day.isBefore(d("2028-01-01")); day = day.plusDays(1)) {
            assertThat(ReviewFacts.weekEnding(UsMarketCalendar.CALENDAR, day)).isEqualTo(ReviewFacts.weekEnding(day));
        }
        // 06-19(금)은 미국 준틴스 휴장 — 휴장일 없는 시험 달력에서는 금요일 그대로
        assertThat(ReviewFacts.weekEnding(WeekdaysCalendar.INSTANCE, d("2026-06-17"))).isEqualTo(d("2026-06-19"));
        Instant afterSeoulClose = Instant.parse("2026-06-19T07:00:00Z");     // 16:00 KST, 뉴욕은 03:00
        assertThat(ReviewFacts.latestCompletedWeekEnding(UsMarketCalendar.CALENDAR, afterSeoulClose))
                .isEqualTo(ReviewFacts.latestCompletedWeekEnding(afterSeoulClose))
                .isEqualTo(d("2026-06-18"));
        assertThat(ReviewFacts.latestCompletedWeekEnding(WeekdaysCalendar.INSTANCE, afterSeoulClose))
                .isEqualTo(d("2026-06-19"));
        // 시험 달력 마감(15:30 KST = 06:30Z) 전이면 지난주
        assertThat(ReviewFacts.latestCompletedWeekEnding(WeekdaysCalendar.INSTANCE, Instant.parse("2026-06-19T06:00:00Z")))
                .isEqualTo(d("2026-06-12"));
        assertThatThrownBy(() -> ReviewFacts.weekEnding(null, d("2026-06-17")))
                .isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("달력을 받는 판 — 조립: 미국 달력이면 옛 시그니처와 같은 사실, 다른 달력이면 기준일 검사·가정 진입일을 그 달력으로")
    void buildWithCalendar() {
        // 추수감사절 주: 결정 11-25(수), 기준일 11-27(금 — 두 달력 모두 그 주 마지막 거래일)
        LocalDate we = d("2026-11-27");
        Map<String, DailySeries> closes = new HashMap<>();
        closes.put("GGG", series("2026-11-25", 70, "2026-11-26", 80, "2026-11-27", 88));
        Inputs in = new Inputs(List.of(ok(1, d("2026-11-25"), rejected(11, "GGG", "BUY"))), closes, List.of(),
                List.of(), List.of(), 3, "현행");
        Facts us = ReviewFacts.build(in, we, 4, null);
        assertThat(ReviewFacts.build(UsMarketCalendar.CALENDAR, in, we, 4, null).toMap()).isEqualTo(us.toMap());
        // 미국: 결정 다음 세션 = 11-27(추수감사절을 건너뜀) → 88 / 88 − 1 = 0
        assertThat(single(us).hypothetical().entryDate()).isEqualTo(d("2026-11-27"));
        assertThat(single(us).hypothetical().returnPct()).isEqualTo(0.0);
        // 휴장일 없는 시험 달력: 다음 세션 = 11-26 → 88 / 80 − 1 = +10%
        Facts weekdays = ReviewFacts.build(WeekdaysCalendar.INSTANCE, in, we, 4, null);
        assertThat(single(weekdays).hypothetical().entryDate()).isEqualTo(d("2026-11-26"));
        assertThat(single(weekdays).hypothetical().returnPct()).isEqualTo(10.0);

        // 기준일 검사도 그 달력으로: 06-19(금)는 미국에선 그 주 기준일이 아님(준틴스), 시험 달력에선 맞음
        assertThatThrownBy(() -> ReviewFacts.build(in, d("2026-06-19"), 4, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(ReviewFacts.build(WeekdaysCalendar.INSTANCE, in, d("2026-06-19"), 4, null).weekEnding())
                .isEqualTo(d("2026-06-19"));
    }

    @Test
    @DisplayName("달력을 받는 판 — 계좌 비교 시작일: 창 시작이 미국 휴장일이면 미국은 직전 거래일, 휴장일 없는 시험 달력은 그날")
    void comparisonWithCalendar() {
        LocalDate we = d("2026-07-31");      // after = 07-03(미국 독립기념일 대체 휴장, 금)
        List<BookNav> books = List.of(new BookNav("rules", List.of(new NavPoint(d("2026-07-02"), 100_000, true),
                new NavPoint(d("2026-07-03"), 125_000, true), new NavPoint(we, 100_000, true))));
        Window window = ReviewFacts.window(we, 4);
        Comparison us = ReviewFacts.comparison(books, window);
        assertThat(ReviewFacts.comparison(UsMarketCalendar.CALENDAR, books, window)).isEqualTo(us);
        assertThat(us.from()).isEqualTo(d("2026-07-02"));
        assertThat(us.books().get(0).returnPct()).isEqualTo(0.0);
        Comparison weekdays = ReviewFacts.comparison(WeekdaysCalendar.INSTANCE, books, window);
        assertThat(weekdays.from()).isEqualTo(d("2026-07-03"));
        assertThat(weekdays.books().get(0).returnPct()).isEqualTo(-20.0);
    }

    // ------------------------------------------------------------------ 가정 진입을 시장이 정함(2단계 명세 §9 'E3', 사용자 결정 v5)
    @SuppressWarnings("unchecked")
    private static Map<String, Object> orderMap(Facts facts, int decision, int order) {
        return (Map<String, Object>) ((List<Object>) ((Map<String, Object>) ((List<Object>) facts.toMap().get("decisions"))
                .get(decision)).get("orders")).get(order);
    }

    @Test
    @DisplayName("시가 진입(NEXT_OPEN — 한국): 거절 주문의 가정 진입 = 결정 다음 세션 시가(금융위 확정·토스 잠정 출처 그대로) → 금요일 종가, 손계산과 같다")
    void nextOpenEntryUsesTheNextSessionOpen() {
        Map<String, DailySeries> closes = Map.of(
                "GGG", series("2026-10-27", 82, "2026-10-30", 88),
                "HHH", series("2026-10-27", 51, "2026-10-30", 45));
        Map<String, Map<LocalDate, EntryOpen>> opens = Map.of(
                "GGG", Map.of(d("2026-10-27"), new EntryOpen(80.0, "FSC")),
                "HHH", Map.of(d("2026-10-27"), new EntryOpen(50.0, "TOSS_1M_OPEN")));
        Inputs in = new Inputs(List.of(ok(1, d("2026-10-26"), rejected(11, "GGG", "BUY"), rejected(12, "HHH", "SELL"))),
                closes, List.of(), List.of(), List.of(), 3, "현행", opens);

        Facts facts = ReviewFacts.build(UsMarketCalendar.CALENDAR, Entry.NEXT_OPEN, in, WE, 4, null);

        OrderFacts ggg = facts.decisions().get(0).orders().get(0);
        assertThat(ggg.hypothetical().entryDate()).isEqualTo(d("2026-10-27"));
        assertThat(ggg.hypothetical().entryPrice()).as("그 세션 종가 82가 아니라 시가").isEqualTo(80.0);
        assertThat(ggg.hypothetical().returnPct()).isEqualTo(10.0);            // 88 / 80 − 1
        assertThat(ggg.hypothetical().entrySource()).isEqualTo("FSC");
        assertThat(ggg.hypothetical().isProxy()).isFalse();
        OrderFacts hhh = facts.decisions().get(0).orders().get(1);
        assertThat(hhh.hypothetical().returnPct()).isEqualTo(-10.0);           // 45 / 50 − 1
        assertThat(hhh.hypothetical().afterSellLabel()).isEqualTo(ReviewFacts.AVOIDED);
        assertThat(hhh.hypothetical().entrySource()).isEqualTo("TOSS_1M_OPEN");
        assertThat(ggg.notes()).noneSatisfy(n -> assertThat(n).contains("가정 수익률"));

        Map<String, Object> order = orderMap(facts, 0, 0);
        assertThat((Map<String, Object>) order.get("hypothetical")).containsExactly(
                Map.entry("basis", ReviewFacts.HYPOTHETICAL), Map.entry("entryDate", "2026-10-27"),
                Map.entry("entryPrice", 80.0), Map.entry("entrySource", "FSC"), Map.entry("isProxy", false),
                Map.entry("returnPct", 10.0));
        assertThat((Map<String, Object>) orderMap(facts, 0, 1).get("hypothetical")).containsKeys("afterSellLabel")
                .doesNotContainKey("entryClose");
        assertThat(facts.toMap().get("note")).isEqualTo(ReviewFacts.NEXT_OPEN_NOTE);
    }

    @Test
    @DisplayName("시가 진입: 그 세션 시가가 없으면 그 세션 종가로 근사하고 isProxy=true·이유, 시가·종가 모두 없으면 null, 다음 세션이 기준일 뒤면 null")
    void nextOpenEntryFallsBackToTheCloseAsAProxy() {
        Map<String, DailySeries> closes = Map.of(
                "III", series("2026-10-27", 40, "2026-10-30", 44),
                "KKK", series("2026-10-29", 70, "2026-10-30", 77));
        Inputs in = new Inputs(List.of(ok(1, d("2026-10-26"), rejected(11, "III", "BUY"), rejected(12, "KKK", "BUY")),
                ok(2, WE, rejected(13, "III", "BUY"))), closes, List.of(), List.of(), List.of(), 3, "현행", Map.of());

        Facts facts = ReviewFacts.build(UsMarketCalendar.CALENDAR, Entry.NEXT_OPEN, in, WE, 4, null);

        OrderFacts proxy = facts.decisions().get(0).orders().get(0);
        assertThat(proxy.hypothetical().entryPrice()).isEqualTo(40.0);
        assertThat(proxy.hypothetical().returnPct()).isEqualTo(10.0);          // 44 / 40 − 1(종가 근사)
        assertThat(proxy.hypothetical().isProxy()).isTrue();
        assertThat(proxy.hypothetical().entrySource()).isNull();
        assertThat(proxy.notes()).contains("가정 수익률: 결정 다음 세션(2026-10-27) 시가 없음 — 그 세션 종가로 근사(isProxy)");
        @SuppressWarnings("unchecked")
        Map<String, Object> proxyMap = (Map<String, Object>) orderMap(facts, 0, 0).get("hypothetical");
        assertThat(proxyMap).containsEntry("isProxy", true).containsEntry("entrySource", null)
                .containsEntry("entryPrice", 40.0);

        OrderFacts none = facts.decisions().get(0).orders().get(1);
        assertThat(none.hypothetical().entryPrice()).isNull();
        assertThat(none.hypothetical().returnPct()).isNull();
        assertThat(none.hypothetical().isProxy()).isNull();
        assertThat(none.notes()).contains("가정 수익률: 결정 다음 세션(2026-10-27) 시가·종가 없음");

        OrderFacts late = facts.decisions().get(1).orders().get(0);
        assertThat(late.hypothetical().entryDate()).isEqualTo(d("2026-11-02"));
        assertThat(late.hypothetical().entryPrice()).isNull();
        assertThat(late.notes()).anySatisfy(n -> assertThat(n).contains("기준일 뒤"));
    }

    @Test
    @DisplayName("시가 진입: 시가가 그날 이력 종가와 0.8~1.25 밖이면(분할·병합 뒤 수정주가 의심 — 시가는 원시, 이력은 수정 종가) 수익률을 내지 않음")
    void nextOpenEntryRejectsABasisMismatch() {
        Map<String, DailySeries> closes = Map.of("JJJ", series("2026-10-27", 50, "2026-10-30", 55));
        Inputs in = new Inputs(List.of(ok(1, d("2026-10-26"), rejected(11, "JJJ", "BUY"))), closes, List.of(), List.of(),
                List.of(), 3, "현행", Map.of("JJJ", Map.of(d("2026-10-27"), new EntryOpen(100.0, "FSC"))));

        OrderFacts jjj = single(ReviewFacts.build(UsMarketCalendar.CALENDAR, Entry.NEXT_OPEN, in, WE, 4, null));

        assertThat(jjj.hypothetical().entryPrice()).isEqualTo(100.0);
        assertThat(jjj.hypothetical().returnPct()).isNull();
        assertThat(jjj.notes()).anySatisfy(n -> assertThat(n).contains("시가 100.0 ÷ 그날 이력 종가 50.0 = 2.0")
                .contains("분할·병합"));
        assertThatThrownBy(() -> new EntryOpen(0.0, "FSC")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("종가 진입(NEXT_CLOSE — 미국)은 그대로: 시가 표를 받아도 읽지 않고, 입력 모양(entryClose)·설명(NOTE)이 옛 판과 같다")
    void nextCloseEntryIsUnchanged() {
        Map<String, DailySeries> closes = Map.of("GGG", series("2026-10-27", 80, "2026-10-30", 88));
        Decision decision = ok(1, d("2026-10-26"), rejected(11, "GGG", "BUY"));
        Inputs plain = new Inputs(List.of(decision), closes, List.of(), List.of(), List.of(), 3, "현행");
        Inputs withOpens = new Inputs(List.of(decision), closes, List.of(), List.of(), List.of(), 3, "현행",
                Map.of("GGG", Map.of(d("2026-10-27"), new EntryOpen(70.0, "FSC"))));

        Facts us = ReviewFacts.build(plain, WE, 4, null);
        assertThat(ReviewFacts.build(UsMarketCalendar.CALENDAR, Entry.NEXT_CLOSE, withOpens, WE, 4, null).toMap())
                .isEqualTo(us.toMap());
        assertThat(us.entry()).isEqualTo(Entry.NEXT_CLOSE);
        assertThat(us.toMap().get("note")).isEqualTo(ReviewFacts.NOTE);
        @SuppressWarnings("unchecked")
        Map<String, Object> hypothetical = (Map<String, Object>) orderMap(us, 0, 0).get("hypothetical");
        assertThat(hypothetical).containsExactly(Map.entry("basis", ReviewFacts.HYPOTHETICAL),
                Map.entry("entryDate", "2026-10-27"), Map.entry("entryClose", 80.0), Map.entry("returnPct", 10.0));
        assertThat(single(us).hypothetical().entrySource()).isNull();
        assertThat(single(us).hypothetical().isProxy()).isNull();
    }

    @Test
    @DisplayName("시가 진입 설명(NEXT_OPEN_NOTE): 다음 세션 시가·출처·종가 근사(isProxy)·토스 잠정 종가를 적고, 미국 말(SPY·NEXT_OBSERVATION·종가 진입)은 없음")
    void nextOpenNoteSpeaksTheMarket() {
        assertThat(ReviewFacts.NEXT_OPEN_NOTE).contains("결정 다음 세션 시가(NEXT_OPEN)").contains("isProxy=true")
                .contains("FSC·FSC_ETF는 금융위 확정 시가").contains("토스 잠정 종가").contains("KODEX 200 대비")
                .contains("가격은 원").doesNotContain("SPY").doesNotContain("NEXT_OBSERVATION")
                .doesNotContain("다음 세션 종가에 체결됐다고");
        assertThat(ReviewFacts.NOTE).as("미국 설명은 그대로").contains("결정 다음 세션 종가에 체결됐다고 가정한 값(가정)")
                .contains("SPY 대비");
    }
}
