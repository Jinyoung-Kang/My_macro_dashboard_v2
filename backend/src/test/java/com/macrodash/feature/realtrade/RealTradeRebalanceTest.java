package com.macrodash.feature.realtrade;

import com.macrodash.feature.paper.RuleBookService;
import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Pending;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Position;
import com.macrodash.feature.realtrade.RealTradePlanner.Quote;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradeRebalance.DailyShort;
import com.macrodash.feature.realtrade.RealTradeRebalance.Inputs;
import com.macrodash.feature.realtrade.RealTradeRebalance.Verdict;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * 재선정 다음 묶음의 회전율 예외 판정({@link RealTradeRebalance}, ADR 0028 덧붙임 2026-11-19 — 계획 3판 3·4·6-1절). 계좌는 모두 합성 값이고(E = 1,000만 원,
 * 모든 종목 가격 1원 — 1% = 10만 주라 정수 주 효과가 0.00001%p 아래), 계획 4절 표의 % 근사 사례를 그대로 셉니다(검산 {@code calc/v4_check.py}의 값과 같게).
 * 경계 시험은 임계값에서 통과·바로 넘으면 멈춤·모르면 멈춤을 봅니다.
 */
class RealTradeRebalanceTest {

    private static final BigDecimal E = new BigDecimal("10000000");
    private static final String CASH = "153130";
    private static final Set<String> CASH_LIKE = Set.of(CASH);
    private static final Rules RULES = new Rules(new BigDecimal("99999999"), CASH_LIKE, false, true, 200, new BigDecimal("999999999"));

    /** 글자 하나 → 합성 종목 코드(A → 000010, B → 000020, ...). 153130은 그대로. */
    private static String s(String letter) {
        return letter.equals(CASH) ? CASH : String.format("%06d", (letter.charAt(0) - 'A' + 1) * 10);
    }

    /** "A:11,B:10.7,153130:44" 꼴의 % 맵(글자 → 합성 코드). */
    private static Map<String, Double> w(Object... pairs) {
        Map<String, Double> out = new TreeMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put(s((String) pairs[i]), ((Number) pairs[i + 1]).doubleValue());
        }
        return out;
    }

    private static Map<String, Double> each(String letters, double weight) {
        Map<String, Double> out = new TreeMap<>();
        for (char c : letters.toCharArray()) {
            out.put(s(String.valueOf(c)), weight);
        }
        return out;
    }

    @SafeVarargs
    private static Map<String, Double> merge(Map<String, Double>... maps) {
        Map<String, Double> out = new TreeMap<>();
        for (Map<String, Double> m : maps) {
            out.putAll(m);
        }
        return out;
    }

    private static Map<String, Double> scaled(Map<String, Double> weights, double factor) {
        Map<String, Double> out = new TreeMap<>();
        weights.forEach((k, v) -> out.put(k, v * factor));
        return out;
    }

    /** 글자들(또는 153130 하나)의 종목을 뺀 맵. */
    private static Map<String, Double> without(Map<String, Double> weights, String letters) {
        Map<String, Double> out = new TreeMap<>(weights);
        if (letters.equals(CASH)) {
            out.remove(CASH);
            return out;
        }
        for (char c : letters.toCharArray()) {
            out.remove(s(String.valueOf(c)));
        }
        return out;
    }

    private static Set<String> set(String letters) {
        Set<String> out = new TreeSet<>();
        for (char c : letters.toCharArray()) {
            out.add(s(String.valueOf(c)));
        }
        return out;
    }

    // ------------------------------------------------------------------ 합성 계좌(가격 1원, 상한가 1.3원)
    /** 한 사례 — 앞 묶음·보유(E 대비 %)·지금 목표·스탑·스탑 대금·책 가격·가격 모름·미종료 주문·반대 방향 미체결·하루 한도. */
    private static final class Case {
        Map<String, Double> prev = Map.of();
        Map<String, Double> held = Map.of();
        Map<String, Double> now = Map.of();
        Set<String> stops = Set.of();
        double stopProceedsPct;
        Map<String, Double> bookPrice = new HashMap<>();
        Set<String> unpriced = Set.of();
        Set<String> own = Set.of();
        Set<String> opposite = Set.of();
        /** 현재가는 있지만 상한가를 모르는 종목(수집기 사전 조회의 upperLimitPrice null). */
        Set<String> noUpper = Set.of();
        Integer roomOrders = 200;
        BigDecimal roomBuyKrw = new BigDecimal("999999999");

        Case prev(Map<String, Double> v) {
            prev = v;
            return this;
        }

        Case held(Map<String, Double> v) {
            held = v;
            return this;
        }

        Case now(Map<String, Double> v) {
            now = v;
            return this;
        }

        Case stops(String letters) {
            stops = set(letters);
            return this;
        }

        Case room(Double buyPct, Integer orders) {
            roomBuyKrw = buyPct == null ? null : E.multiply(BigDecimal.valueOf(buyPct)).divide(new BigDecimal("100"), 0, RoundingMode.FLOOR);
            roomOrders = orders;
            return this;
        }

        Account account() {
            Map<String, Position> positions = new LinkedHashMap<>();
            Map<String, Quote> quotes = new HashMap<>();
            Map<String, BigDecimal> sellable = new HashMap<>();
            Map<String, Pending> pending = new HashMap<>();
            BigDecimal invested = BigDecimal.ZERO;
            for (Map.Entry<String, Double> e : held.entrySet()) {
                BigDecimal qty = shares(e.getValue());
                positions.put(e.getKey(), new Position(e.getKey(), "합성", qty, BigDecimal.ONE));
                sellable.put(e.getKey(), qty);
                invested = invested.add(qty);
                if (opposite.contains(e.getKey())) {
                    pending.put(e.getKey(), new Pending(BigDecimal.ZERO, qty, false));   // 앱의 전량 매도 주문 대기
                }
            }
            Set<String> all = new HashSet<>(held.keySet());
            all.addAll(now.keySet());
            all.addAll(prev.keySet());
            for (String symbol : all) {
                if (!unpriced.contains(symbol)) {
                    quotes.put(symbol, new Quote(BigDecimal.ONE, noUpper.contains(symbol) ? null : new BigDecimal("1.3")));
                }
            }
            return new Account(E.subtract(invested), positions, quotes, sellable, pending);
        }

        Inputs inputs() {
            Map<String, Double> book = new HashMap<>();
            now.keySet().forEach(symbol -> book.put(symbol, bookPrice.getOrDefault(symbol, 1.0)));
            return RealTradeRebalance.measure(prev, now, book, stops, CASH_LIKE, account(), E, own, BigDecimal.ZERO,
                    RULES.withDaily(roomOrders, roomBuyKrw), E.multiply(BigDecimal.valueOf(stopProceedsPct)).divide(new BigDecimal("100")),
                    roomOrders, roomBuyKrw);
        }

        Verdict verdict() {
            return RealTradeRebalance.judge(inputs());
        }
    }

    private static BigDecimal shares(double pct) {
        return BigDecimal.valueOf(pct).multiply(E).divide(new BigDecimal("100"), 0, RoundingMode.HALF_UP);
    }

    // 계획 4-1의 공통 자료
    private static final Map<String, Double> PREV1 = merge(w(CASH, 44), each("ABCDE", 11));
    private static final Map<String, Double> HELD1 = w(CASH, 44.0, "A", 11.4, "B", 10.7, "C", 11.2, "D", 10.9, "E", 10.6);
    private static final Map<String, Double> NOW1 = merge(w(CASH, 4), each("ABCDE", 11), each("FGHI", 10));
    private static final Map<String, Double> PREV2 = merge(w(CASH, 1), each("ABCDEFGHIJ", 9.8));
    private static final Map<String, Double> HELD2 = w(CASH, 1.0, "A", 10.1, "B", 9.6, "C", 9.9, "D", 9.5, "E", 10.0, "F", 10.0, "G", 9.4,
            "H", 10.1, "I", 9.6, "J", 9.6);
    private static final Map<String, Double> NOW_N2 = merge(w(CASH, 0.7), each("ABCDEF", 9.8), each("KLMN", 10));

    private static Case case1() {
        return new Case().prev(PREV1).held(HELD1);
    }

    private static Case case2() {
        return new Case().prev(PREV2).held(HELD2);
    }

    private static void pct(BigDecimal actual, double expected) {
        assertThat(actual.doubleValue()).isCloseTo(expected, within(0.011));
    }

    // ------------------------------------------------------------------ 판정 표의 경계(6-1 judgeTableBoundaries)
    private static Inputs base() {
        return new Inputs(bd(80), bd(80), bd(80), bd(0), 0, bd(0), 0, bd(1), bd(10), bd(0), 9, bd(-40), bd(99));
    }

    private static BigDecimal bd(double v) {
        return BigDecimal.valueOf(v);
    }

    private static String check(Inputs in) {
        return RealTradeRebalance.judge(in).check();
    }

    private static Inputs with(Inputs b, String field, Object value) {
        BigDecimal v = value instanceof Number n && !(value instanceof Integer) ? BigDecimal.valueOf(n.doubleValue()) : null;
        Integer i = value instanceof Integer n ? n : null;
        return new Inputs(
                field.equals("T") ? v : b.checkTurnoverPct(), field.equals("B0") ? v : b.crossDriftPct(), field.equals("B") ? v : b.bookDriftPct(),
                field.equals("V") ? v : b.accountDriftPct(), field.equals("U") ? i : b.uncounted(), field.equals("D") ? v : b.dailyShortPct(),
                field.equals("drop") ? i : b.sellsDropped(), field.equals("Q") ? v : b.priceRatio(), field.equals("J") ? v : b.nameJumpPct(),
                field.equals("K") ? v : b.nameCutPct(), field.equals("N") ? i : b.stockNames(), field.equals("R") ? v : b.deriskPct(),
                field.equals("I") ? v : b.investedPct());
    }

    @Test
    @DisplayName("판정 표의 경계 — 임계값은 통과, 바로 넘으면 그 코드, 모르면 value-unknown(같음은 통과)")
    void judgeTableBoundaries() {
        Inputs b = base();
        assertThat(RealTradeRebalance.judge(b).exempt()).isTrue();
        assertThat(check(with(b, "U", 0))).isNull();
        assertThat(check(with(b, "U", 1))).isEqualTo("uncounted");
        assertThat(check(with(b, "D", 20.0))).isNull();
        assertThat(check(with(b, "D", 20.01))).isEqualTo("daily-cap-short");
        assertThat(check(with(b, "drop", 1))).isEqualTo("daily-cap-short");
        assertThat(check(with(b, "V", 20.0))).isNull();
        assertThat(check(with(b, "V", 20.01))).isEqualTo("account-drift");
        assertThat(check(with(b, "Q", 1.5))).isNull();
        assertThat(check(with(b, "Q", 1.51))).isEqualTo("price-mismatch");
        assertThat(check(with(b, "J", 12.0))).isNull();
        assertThat(check(with(b, "J", 12.01))).isEqualTo("name-jump");
        assertThat(check(with(b, "K", 5.0))).isNull();
        assertThat(check(with(b, "K", 5.01))).isEqualTo("name-cut");
        assertThat(check(with(b, "N", 1))).isNull();
        assertThat(check(with(b, "N", 0))).isEqualTo("no-names");
        assertThat(check(with(b, "R", 30.0))).isNull();
        assertThat(check(with(b, "R", 30.01))).isEqualTo("derisk-over");
        assertThat(check(with(b, "I", 90.0))).isNull();
        assertThat(check(with(b, "I", 89.99))).isEqualTo("targets-thin");
        assertThat(check(with(b, "I", 101.0))).isNull();
        assertThat(check(with(b, "I", 101.01))).isEqualTo("targets-over");
        // T = B° + 20은 통과, + 0.01은 멈춤(B° 80.33 + 20 — 이진 소수 덧셈의 어긋남 없이)
        Inputs cross = with(with(b, "B0", 80.33), "T", 100.33);
        assertThat(check(cross)).isNull();
        assertThat(check(with(cross, "T", 100.34))).isEqualTo("over-allowance");
        Inputs cap = with(b, "B0", 140.0);
        assertThat(check(with(cap, "T", 150.0))).isNull();
        assertThat(check(with(cap, "T", 150.01))).isEqualTo("over-cap");
        // 모르는 값 — 칸 하나라도 null이면 멈춤, 음수 개수도 모름
        for (String field : List.of("T", "B0", "B", "V", "U", "D", "drop", "Q", "J", "K", "N", "R", "I")) {
            assertThat(check(with(b, field, null))).as(field).isEqualTo("value-unknown");
        }
        assertThat(check(with(b, "U", -1))).isEqualTo("value-unknown");
        assertThat(check(null)).isEqualTo("value-unknown");
        assertThat(check(Inputs.UNKNOWN)).isEqualTo("value-unknown");
        // 처음 어긋난 코드 — 빠진 종목이 계좌 어긋남보다 먼저
        assertThat(check(with(with(b, "U", 2), "V", 50.0))).isEqualTo("uncounted");
        assertThat(check(with(with(b, "V", 50.0), "T", 200.0))).isEqualTo("account-drift");
    }

    @Test
    @DisplayName("비중에 NaN·무한·음수가 있거나 E가 없으면 측정 전부 모름 → value-unknown")
    void nonFiniteWeightsAreUnknown() {
        for (double bad : new double[]{Double.NaN, Double.POSITIVE_INFINITY, -1.0}) {
            Case nowBad = case1().now(merge(NOW1, w("F", bad)));
            assertThat(nowBad.verdict().check()).as("지금 목표 %s", bad).isEqualTo("value-unknown");
            Case prevBad = case1().now(NOW1).prev(merge(PREV1, w("A", bad)));
            assertThat(prevBad.verdict().check()).as("앞 묶음 %s", bad).isEqualTo("value-unknown");
        }
        Case ok = case1().now(NOW1);
        Inputs zeroE = RealTradeRebalance.measure(PREV1, NOW1, Map.of(), Set.of(), CASH_LIKE, ok.account(), BigDecimal.ZERO, Set.of(),
                BigDecimal.ZERO, RULES, BigDecimal.ZERO, 200, E);
        assertThat(RealTradeRebalance.judge(zeroE).check()).isEqualTo("value-unknown");
        // 책 가격을 모르는 목표 종목, 남은 하루 매수 금액 모름
        Inputs noBookPrice = RealTradeRebalance.measure(PREV1, NOW1, Map.of(), Set.of(), CASH_LIKE, ok.account(), E, Set.of(),
                BigDecimal.ZERO, RULES, BigDecimal.ZERO, 200, E);
        assertThat(noBookPrice.priceRatio()).isNull();
        assertThat(RealTradeRebalance.judge(noBookPrice).check()).isEqualTo("value-unknown");
        assertThat(case1().now(NOW1).room(null, 200).verdict().check()).isEqualTo("value-unknown");
    }

    // ------------------------------------------------------------------ 계획 4-1 — 보냄(10~11% 슬롯)
    @Test
    @DisplayName("계획 4-1 — N1·N2·N3b·N4·N6·E1b·E3c는 열두 확인을 지나 보냄(검산 값과 같게)")
    void numbersFromPlanExempt() {
        Inputs n1 = case1().now(NOW1).inputs();
        assertThat(RealTradeRebalance.judge(n1).exempt()).isTrue();
        pct(n1.checkTurnoverPct(), 80.0);
        pct(n1.crossDriftPct(), 80.0);
        pct(n1.accountDriftPct(), 0);
        pct(n1.nameJumpPct(), 10);
        pct(n1.nameCutPct(), 0);
        assertThat(n1.stockNames()).isEqualTo(9);
        pct(n1.deriskPct(), -40.2);
        pct(n1.investedPct(), 99);
        assertThat(n1.uncounted()).isZero();
        pct(n1.priceRatio(), 1.0);

        Inputs n2 = case2().now(NOW_N2).inputs();
        assertThat(RealTradeRebalance.judge(n2).exempt()).isTrue();
        pct(n2.checkTurnoverPct(), 78.7);
        pct(n2.crossDriftPct(), 79.5);
        assertThat(n2.stockNames()).isEqualTo(10);
        pct(n2.deriskPct(), -1.0);
        pct(n2.investedPct(), 99.5);

        Inputs n3b = case1().now(merge(w(CASH, 15), each("ACDE", 11), each("FGHI", 10))).stops("B").inputs();
        assertThat(RealTradeRebalance.judge(n3b).exempt()).isTrue();
        pct(n3b.checkTurnoverPct(), 69.0);
        assertThat(n3b.stockNames()).isEqualTo(8);
        pct(n3b.investedPct(), 99);

        Case n4 = case2().held(without(HELD2, "J")).now(merge(w(CASH, 10.8), each("ABCDE", 9.8), each("KLMN", 10))).stops("J");
        n4.stopProceedsPct = 9.8;
        Inputs n4i = n4.inputs();
        assertThat(RealTradeRebalance.judge(n4i).exempt()).isTrue();
        pct(n4i.checkTurnoverPct(), 79.1);
        pct(n4i.crossDriftPct(), 89.0);
        pct(n4i.investedPct(), 99.8);

        double nav = 100 - 3.0;
        Inputs n6 = case1().held(merge(HELD1, w("C", 11.2 * 0.7)))
                .now(merge(scaled(NOW1, 100 / nav), w("C", 7.7 * 100 / nav))).inputs();
        assertThat(RealTradeRebalance.judge(n6).exempt()).isTrue();
        pct(n6.checkTurnoverPct(), 81.11);
        pct(n6.crossDriftPct(), 85.54);
        pct(n6.accountDriftPct(), 3.16);
        pct(n6.nameJumpPct(), 10.31);
        pct(n6.nameCutPct(), 3.06);
        pct(n6.investedPct(), 98.66);

        Inputs e1b = new Case().prev(merge(w(CASH, 29), each("ABCDEFG", 10))).held(merge(w(CASH, 28.5), each("CDEFG", 10)))
                .now(merge(w(CASH, 49), each("HIJKL", 10))).stops("AB").inputs();
        assertThat(RealTradeRebalance.judge(e1b).exempt()).isTrue();
        pct(e1b.checkTurnoverPct(), 120.5);
        pct(e1b.crossDriftPct(), 120);
        assertThat(e1b.stockNames()).isEqualTo(5);

        Inputs e3c = new Case().prev(PREV2).held(PREV2).now(merge(w(CASH, 30.4), each("ABCDE", 9.8), w("K", 9.8, "L", 9.8))).inputs();
        assertThat(RealTradeRebalance.judge(e3c).exempt()).isTrue();
        pct(e3c.checkTurnoverPct(), 98.0);
        pct(e3c.deriskPct(), 29.4);
        assertThat(e3c.stockNames()).isEqualTo(7);
    }

    // ------------------------------------------------------------------ 계획 4-2·4-1 — 멈춤(10~11% 슬롯)
    @Test
    @DisplayName("계획 4-2 — 위험 사례는 지금처럼 멈춤, 막는 조건이 검산과 같음")
    void numbersFromPlanHalts() {
        Case u1 = case1().held(merge(w("X", 44), without(HELD1, CASH))).now(NOW1);
        assertThat(u1.verdict().check()).isEqualTo("account-drift");
        pct(u1.inputs().accountDriftPct(), 88.0);
        pct(u1.inputs().checkTurnoverPct(), 88.0);

        Case u2a = case1().held(scaled(without(HELD1, CASH), 100.0 / 56)).now(NOW1);
        assertThat(u2a.verdict().check()).isEqualTo("account-drift");
        pct(u2a.inputs().accountDriftPct(), 86.86);

        Case u2b = case1().held(scaled(HELD1, 100.0 / 150)).now(NOW1);
        assertThat(u2b.verdict().check()).isEqualTo("account-drift");
        pct(u2b.inputs().accountDriftPct(), 33.13);

        assertThat(case1().now(w(CASH, 99)).verdict().check()).as("U3a 후보 0").isEqualTo("no-names");
        Case u3d = case1().now(merge(each("ABCDE", 11), each("FG", 10)));
        assertThat(u3d.verdict().check()).isEqualTo("targets-thin");
        pct(u3d.inputs().investedPct(), 75);

        double navq = 100 - 11 + 110 + 1;
        Case u4a = case1().now(merge(scaled(NOW1, 100 / navq), w("C", 110 * 100 / navq)));
        u4a.bookPrice.put(s("C"), 10.0);
        assertThat(u4a.verdict().check()).isEqualTo("price-mismatch");
        pct(u4a.inputs().priceRatio(), 10.0);

        double navb = 100 - 11 + 55;
        Case u4b = case1().now(merge(scaled(NOW1, 100 / navb), w("C", 55 * 100 / navb)));
        assertThat(u4b.verdict().check()).isEqualTo("name-jump");
        pct(u4b.inputs().nameJumpPct(), 27.19);

        Case n3 = case1().now(merge(w(CASH, 4), each("ACDE", 11), each("FGHI", 10))).stops("B");
        assertThat(n3.verdict().check()).as("N3 결정 뒤 반영된 STOP — 크레딧 없음").isEqualTo("targets-thin");
        pct(n3.inputs().investedPct(), 88);
        Case n5 = case1().now(merge(w(CASH, 4), each("ADE", 11), each("FGHI", 10))).stops("BC");
        assertThat(n5.verdict().check()).isEqualTo("targets-thin");
        pct(n5.inputs().investedPct(), 77);

        Case e2 = new Case().prev(w(CASH, 70, "A", 29)).held(w(CASH, 67, "A", 29)).now(w(CASH, 99));
        assertThat(e2.verdict().check()).isEqualTo("no-names");
        pct(e2.inputs().checkTurnoverPct(), 61.0);

        Case e3 = new Case().prev(PREV2).held(PREV2).now(merge(w(CASH, 40.2), each("ABCDEF", 9.8)));
        assertThat(e3.verdict().check()).isEqualTo("derisk-over");
        pct(e3.inputs().deriskPct(), 39.2);
    }

    // ------------------------------------------------------------------ 계획 4-5 — 3차 검증의 새 사례
    @Test
    @DisplayName("계획 4-5 — S2·S3·S3b·S5·S5b(하루 한도·책 현금 음수·후보 0)")
    void numbersFromPlanThirdReview() {
        Case s2 = case2().now(NOW_N2).room(0.0, 30);
        assertThat(s2.verdict().check()).isEqualTo("daily-cap-short");
        pct(s2.inputs().dailyShortPct(), 52.0);
        assertThat(case2().now(NOW_N2).room(60.0, 30).verdict().exempt()).as("S2' 충분").isTrue();

        Case s3 = case1().now(merge(w(CASH, 4), each("ABCDE", 11), each("FGHI", 14)));
        assertThat(s3.verdict().check()).isEqualTo("name-jump");
        pct(s3.inputs().nameJumpPct(), 14);

        Case s5 = new Case().prev(merge(w(CASH, 59), each("ABCD", 10))).held(merge(w(CASH, 57.0), each("ABCD", 10)))
                .now(w(CASH, 89, "D", 10));
        assertThat(s5.verdict().exempt()).as("S5 후보 0 + 팔 수 없어 남은 D 10 — 설계 범위").isTrue();
        pct(s5.inputs().deriskPct(), 30.0);
        pct(s5.inputs().checkTurnoverPct(), 62.0);
    }

    // ------------------------------------------------------------------ 6-1 개별 시험
    @Test
    @DisplayName("prevKept — 양쪽에서 없는 비스탑 종목만 빠지고, 스탑 종목·실제 보유가 남은 종목은 남음")
    void prevKeptKeepsStopsAndHeld() {
        // A는 100주, C는 0.5주(1주 미만 — 소수점 보유), B·D·F는 보유 없음
        Account account = new Account(E, Map.of(s("A"), new Position(s("A"), "합성", new BigDecimal("100"), BigDecimal.ONE),
                s("C"), new Position(s("C"), "합성", new BigDecimal("0.5"), BigDecimal.ONE)), Map.of(), Map.of(), Map.of());
        Map<String, Double> kept = RealTradeRebalance.prevKept(w("A", 10, "B", 10, "C", 10, "D", 10, "F", 10), w("F", 10),
                set("B"), account);
        assertThat(kept).containsOnlyKeys(s("A"), s("B"), s("F"));
    }

    @Test
    @DisplayName("판정 계획은 매매 제한 종목도 셈 — S1b 판정 156.5(지금 멈춤 판정 146.7), S1d 계좌 어긋남 39.3; own의 종목은 빠지고 U에 셈")
    void judgePlanCountsRestrictedNames() {
        Map<String, Double> now8 = merge(w(CASH, 1, "A", 9.8, "B", 9.8), each("KLMNOPQR", 9.8));
        Case s1b = case2().now(now8);
        Account account = s1b.account();
        Plan judged = RealTradeRebalance.judgePlan(now8, E, account, Set.of(), BigDecimal.ZERO, RULES, Set.of(), BigDecimal.ZERO);
        pct(judged.turnoverPct(), 156.5);
        Plan g0 = RealTradeRebalance.judgePlan(now8, E, account, set("K"), BigDecimal.ZERO, RULES, Set.of(), BigDecimal.ZERO);
        pct(g0.turnoverPct(), 146.7);
        assertThat(s1b.verdict().check()).isEqualTo("over-cap");
        Case s1c = case2().now(now8);
        s1c.own = set("KL");
        assertThat(s1c.verdict().check()).as("이 기능의 미종료 주문(own)이면 빠지고 U").isEqualTo("uncounted");

        Map<String, Double> nowV = merge(w(CASH, 1), each("ABCDEF", 9.8), each("KLMN", 9.8));
        Case s1d = case2().held(merge(without(HELD2, "AB"), w("X", 10.1, "Y", 9.6))).now(nowV);
        assertThat(s1d.verdict().check()).isEqualTo("account-drift");
        pct(s1d.inputs().accountDriftPct(), 39.3);
        pct(s1d.inputs().checkTurnoverPct(), 117.2);
    }

    @Test
    @DisplayName("빠진 종목 — opposite-pending(S7)·price-missing(A5)·own-pending(비스탑)은 셈, 스탑 종목·symbol-unsupported·fractional-part는 안 셈")
    void uncountedSkipReasons() {
        Map<String, Double> nowV = merge(w(CASH, 1), each("ABCDEF", 9.8), each("KLMN", 9.8));
        Case s7 = case2().now(nowV);
        s7.opposite = set("AB");
        assertThat(s7.verdict().check()).isEqualTo("uncounted");
        assertThat(s7.inputs().uncounted()).isEqualTo(2);

        double navF = 112.0;
        Case a5 = case1().now(merge(scaled(NOW1, 100 / navF), w("F", 22 * 100 / navF)));
        a5.unpriced = set("F");
        a5.bookPrice.put(s("F"), 2.2);
        assertThat(a5.verdict().check()).isEqualTo("uncounted");
        assertThat(a5.inputs().uncounted()).isEqualTo(1);
        pct(a5.inputs().priceRatio(), 1.0);   // 실제 가격을 모르는 종목은 Q에서 뺌(U가 멈춤)

        Case own = case1().now(NOW1);
        own.own = set("F");
        assertThat(own.inputs().uncounted()).as("이 기능의 미종료 주문(비스탑)").isEqualTo(1);
        Case ownStop = case1().now(merge(w(CASH, 15), each("ACDE", 11), each("FGHI", 10))).stops("B");
        ownStop.own = set("B");
        assertThat(ownStop.inputs().uncounted()).as("스탑 종목의 own-pending은 셈하지 않음").isZero();

        // 사유별 — 계획에서 직접(스탑 종목 제외, 셈하는 사유 다섯과 셈하지 않는 사유)
        Plan plan = new Plan(List.of(), List.of(
                new RealTradePlanner.Skip("000010", null, RealTradePlanner.SKIP_OPPOSITE),
                new RealTradePlanner.Skip("000020", null, RealTradePlanner.SKIP_PRICE),
                new RealTradePlanner.Skip("000030", null, RealTradePlanner.SKIP_OWN),
                new RealTradePlanner.Skip("000040", null, RealTradePlanner.SKIP_PENDING_UNKNOWN),
                new RealTradePlanner.Skip("000050", null, RealTradePlanner.SKIP_NOT_SELLABLE),
                new RealTradePlanner.Skip("000060", null, RealTradePlanner.SKIP_OWN),
                new RealTradePlanner.Skip("ABC", null, RealTradePlanner.SKIP_SYMBOL),
                new RealTradePlanner.Skip("000070", null, RealTradePlanner.SKIP_FRACTION),
                new RealTradePlanner.Skip("000080", null, RealTradePlanner.SKIP_DEFERRED_CASH),
                new RealTradePlanner.Skip("000090", null, RealTradePlanner.SKIP_CAPPED)), BigDecimal.ZERO, E);
        Plan again = new Plan(List.of(), List.of(new RealTradePlanner.Skip("000010", null, RealTradePlanner.SKIP_OPPOSITE)), BigDecimal.ZERO, E);
        assertThat(RealTradeRebalance.uncounted(plan, again, Set.of("000060"))).as("다섯 사유 — 같은 종목은 한 번").isEqualTo(5);
    }

    @Test
    @DisplayName("하루 한도 — 남은 매수 0 → 매수 상한가 합(S2 52), 40% → 12(S2c), 건수 5 → 종목 매수 셋 밀림 39(S2d), 7 → 13(S2e), 매도가 밀리면 멈춤, 현금은 보지 않음")
    void dailyShortUsesLimitOrder() {
        Case n2 = case2().now(NOW_N2);
        Account account = n2.account();
        DailyShort s2 = RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 30, BigDecimal.ZERO);
        pct(s2.shortPct(), 52.0);
        assertThat(s2.sellsDropped()).isZero();
        pct(RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 30, new BigDecimal("4000000")).shortPct(), 12.0);
        pct(RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 5, E).shortPct(), 39.0);
        pct(RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 7, E).shortPct(), 13.0);
        assertThat(case2().now(NOW_N2).room(40.0, 30).verdict().exempt()).as("S2c 통과").isTrue();
        assertThat(case2().now(NOW_N2).room(100.0, 5).verdict().check()).as("S2d").isEqualTo("daily-cap-short");
        assertThat(case2().now(NOW_N2).room(100.0, 7).verdict().exempt()).as("S2e 통과").isTrue();
        // 매도 넷(G·H·I·J 책 밖 전량)인데 남은 건수 3 — 매도 하나가 밀림
        DailyShort dropped = RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 3, E);
        assertThat(dropped.sellsDropped()).isEqualTo(1);
        assertThat(case2().now(NOW_N2).room(100.0, 3).verdict().check()).isEqualTo("daily-cap-short");
        // 실제 현금이 0이어도(153130 매도 대금이 들어오기 전) 하루 한도가 넉넉하면 못 내는 매수 0
        Case broke = case2().held(merge(HELD2, w(CASH, 6.2))).now(NOW_N2);
        assertThat(broke.account().cash().signum()).isLessThanOrEqualTo(0);
        pct(RealTradeRebalance.dailyShort(NOW_N2, E, broke.account(), Set.of(), CASH_LIKE, 30, E).shortPct(), 0.0);
        // 하루 한도를 모르면 모름
        assertThat(RealTradeRebalance.dailyShort(NOW_N2, E, account, Set.of(), CASH_LIKE, 30, null)).isNull();
    }

    // QA-801 — daily-cap-short는 '못 내는 매수 > 20 또는 밀리는 매도 있음'인데 밀리는 매도 수가 기록 칸·로그 요약에 없어, 남은 하루 건수가 매도 다리보다 적어
    // 걸린 멈춤(못 내는 매수는 20 안)의 까닭이 어디에도 남지 않았다. 수정 전(재현 커밋 3b237f2b에서는 @Disabled): detail에 sellsDropped 없음, 요약에 '밀리는 매도' 없음.
    @Test
    @DisplayName("QA-801: 밀리는 매도로 daily-cap-short면 그 수를 기록 칸(sellsDropped)·로그 요약에 남김 — 못 내는 매수가 20% 안이어도")
    void dailyCapShortRecordsDroppedSells() {
        Inputs dropped = with(with(base(), "D", 13.0), "drop", 4);
        Verdict halt = RealTradeRebalance.judge(dropped);
        assertThat(halt.check()).isEqualTo("daily-cap-short");
        assertThat(halt.detail()).containsEntry("sellsDropped", 4).containsEntry("dailyShortPct", new BigDecimal("13.0"));
        assertThat(RealTradeRebalance.summary(dropped)).contains("하루 한도로 못 내는 매수 13.0%").contains("밀리는 매도 4");
        // 계좌로 센 사례 — N2의 매도 넷(G·H·I·J 책 밖 전량)인데 남은 하루 건수 3
        assertThat(case2().now(NOW_N2).room(100.0, 3).verdict().detail()).containsEntry("rebalanceCheck", "daily-cap-short")
                .containsEntry("sellsDropped", 1);
        // 예외(보냄)에는 넣지 않음(늘 0 — 빠진 종목 수와 같은 규칙), 모르면 '?'
        assertThat(RealTradeRebalance.judge(base()).detail()).doesNotContainKey("sellsDropped");
        assertThat(RealTradeRebalance.summary(Inputs.UNKNOWN)).contains("밀리는 매도 ?");
    }

    // QA-802 — 상한가를 모르는 매수가 하루 건수 한도에 가려 U와 D 모두에서 빠졌다. 판정 계획의 limit()은 하루 건수(ordersLeft <= 0)를 상한가보다 먼저 보아
    // 매도가 남은 건수 1을 쓰면 새 종목 매수 일곱이 deferred-daily-cap(U가 세지 않는 사유)이 되고, 하루 한도 셈의 하루 한도 없는 계획(need)은 그 일곱을
    // price-missing으로 건너뛰어 상한가 금액을 잡지 않아 D 0.00 — 열두 확인을 모두 지나 예외로 153130 매도만 나간다(계획 3-2 'limit()의 상한가 모름 매수도
    // price-missing으로 함께 멈춘다'와 어긋남). 수정 전: check null(예외), uncounted 0, dailyShortPct 0.00.
    @Test
    @org.junit.jupiter.api.Disabled("QA-802 재현 — 수정 전에는 상한가 모름 매수가 하루 건수 한도에 가려 예외로 보냄")
    @DisplayName("QA-802: 상한가 모름 매수가 하루 건수 한도에 가려도 빠진 종목으로 셈 — 기본 슬롯 153130 46.7% → 15종목, 새 종목 일곱 상한가 모름, 남은 건수 1 → uncounted")
    void upperUnknownBuysMaskedByDailyOrdersStillUncounted() {
        Map<String, Double> prev = merge(w(CASH, 46.672), each("ABCDEFGH", 6.666));
        Map<String, Double> now = merge(each("ABCDEFGH", 6.666), each("IJKLMNO", 6.666));

        // 대조 1 — 남은 건수가 넉넉하면 판정 계획의 limit()이 상한가 모름을 price-missing으로 남겨 지금도 U 7(uncounted)
        Case roomy = new Case().prev(prev).held(prev).now(now);
        roomy.noUpper = set("IJKLMNO");
        assertThat(roomy.verdict().check()).isEqualTo("uncounted");
        assertThat(roomy.inputs().uncounted()).isEqualTo(7);
        // 대조 2 — 상한가를 알면 남은 건수 1에서 매수 일곱의 상한가 합이 못 내는 매수(60.66%)라 D가 멈춤
        Case known = new Case().prev(prev).held(prev).now(now).room(100.0, 1);
        assertThat(known.verdict().check()).isEqualTo("daily-cap-short");
        pct(known.inputs().dailyShortPct(), 60.66);

        // 반례 — 상한가 모름 + 남은 건수 1(= 매도 다리 수): 판정 계획에서는 일곱이 deferred-daily-cap, 하루 한도 셈에서는 price-missing
        Case masked = new Case().prev(prev).held(prev).now(now).room(100.0, 1);
        masked.noUpper = set("IJKLMNO");
        Plan judged = RealTradeRebalance.judgePlan(now, E, masked.account(), Set.of(), BigDecimal.ZERO, RULES.withDaily(1, E), Set.of(),
                BigDecimal.ZERO);
        assertThat(judged.skipped()).as("판정 계획 — 하루 건수가 상한가 검사보다 먼저").extracting(RealTradePlanner.Skip::reason)
                .containsOnly(RealTradePlanner.SKIP_DAILY_CAP);
        Inputs in = masked.inputs();
        assertThat(in.uncounted()).as("하루 한도 없는 계획에서 상한가 모름(price-missing)으로 빠진 일곱").isEqualTo(7);
        assertThat(masked.verdict().check()).isEqualTo("uncounted");
        assertThat(masked.verdict().detail()).containsEntry("uncounted", 7);
    }

    @Test
    @DisplayName("계좌 어긋남 = 앞 묶음 목표로 지금 맞출 회전율 — 1주가 목표 금액보다 비싸면 0(4-3), 책 밖 보유 전량, 1% 문턱 아래 빠짐, 스탑 종목 범위 밖")
    void accountDriftIsSyncTurnover() {
        // 4-3: E 300만, 가격 40만 원 종목의 목표 9.8%(29.4만 원) → 목표 0주, 보유 0 → 차이 0
        BigDecimal e = new BigDecimal("3000000");
        Account pricey = new Account(e, Map.of(), Map.of("000010", new Quote(new BigDecimal("400000"), new BigDecimal("520000"))), Map.of(),
                Map.of());
        assertThat(RealTradeRebalance.accountDrift(Map.of("000010", 9.8), e, pricey, Set.of(), RULES, Set.of()).turnoverPct())
                .isEqualByComparingTo("0");
        // 책 밖 보유 X 3% 전량 + A의 0.5%p 어긋남(1% 문턱 아래 — 빠짐) + 스탑 종목 B의 어긋남(범위 밖)
        Case c = new Case().held(w("A", 10.5, "B", 5.0, "X", 3.0, CASH, 81.5));
        Map<String, Double> kept = w("A", 10, "B", 8.5, CASH, 81.5);
        pct(RealTradeRebalance.accountDrift(kept, E, c.account(), Set.of(), RULES, Set.of()).turnoverPct(), 6.5);
        pct(RealTradeRebalance.accountDrift(kept, E, c.account(), Set.of(), RULES, set("B")).turnoverPct(), 3.0);
    }

    @Test
    @DisplayName("가격 배율은 모든 목표 종목 — A1 비중 0.12인 종목의 1/100 책 가격도 Q에 듦, 1/1.5는 경계 통과")
    void priceRatioCountsSmallWeights() {
        double navA = 100 - 11 + 0.11;
        Case a1 = case1().now(merge(scaled(NOW1, 100 / navA), w("C", 0.11 * 100 / navA)));
        a1.bookPrice.put(s("C"), 0.01);
        assertThat(a1.verdict().check()).isEqualTo("price-mismatch");
        pct(a1.inputs().priceRatio(), 100.0);
        Case inverse = case1().now(NOW1);
        inverse.bookPrice.put(s("C"), 1 / 1.5);
        assertThat(inverse.inputs().priceRatio()).isEqualByComparingTo("1.5");
        assertThat(inverse.verdict().exempt()).isTrue();
        Case over = case1().now(NOW1);
        over.bookPrice.put(s("D"), 1.51);
        assertThat(over.verdict().check()).isEqualTo("price-mismatch");
    }

    @Test
    @DisplayName("유지 종목 축소 — A1b 책 수량 1/10은 K 9.78로 멈춤, N6 하한가는 K 3.06으로 통과")
    void nameCutCatchesBookQuantityError() {
        double nav = 100 - 11 + 1.1;
        Case a1b = case1().now(merge(scaled(NOW1, 100 / nav), w("C", 1.1 * 100 / nav)));
        assertThat(a1b.verdict().check()).isEqualTo("name-cut");
        pct(a1b.inputs().nameCutPct(), 9.78);
        double nav6 = 97;
        Case n6 = case1().held(merge(HELD1, w("C", 11.2 * 0.7))).now(merge(scaled(NOW1, 100 / nav6), w("C", 7.7 * 100 / nav6)));
        assertThat(n6.verdict().exempt()).isTrue();
        pct(n6.inputs().nameCutPct(), 3.06);
    }

    @Test
    @DisplayName("새 종목 증가 — A4(20)·A4c(15)·기본 슬롯 이중 체결(13.33) 멈춤, A4d(12)·기본 슬롯 1.8배(12.0) 통과")
    void newNameJumpBoundary() {
        assertThat(case1().now(merge(NOW1, w("F", 20))).verdict().check()).isEqualTo("name-jump");
        assertThat(case1().now(merge(NOW1, w("F", 15))).verdict().check()).isEqualTo("name-jump");
        Case a4d = case1().now(merge(NOW1, w("F", 12)));
        assertThat(a4d.verdict().exempt()).isTrue();
        pct(a4d.inputs().nameJumpPct(), 12);
        pct(a4d.inputs().investedPct(), 101);
        // 기본 15종목 동일비중(6.667%) — 후보 10개·교체 2, 새 종목 하나가 2배 / 1.8배(153130이 그만큼 줆)
        assertThat(slotCase(2, 10, 2.0, List.of()).verdict().check()).isEqualTo("name-jump");
        pct(slotCase(2, 10, 2.0, List.of()).inputs().nameJumpPct(), 13.33);
        Case boundary = slotCase(2, 10, 1.8, List.of());
        assertThat(boundary.verdict().exempt()).isTrue();
        pct(boundary.inputs().nameJumpPct(), 12.0);
    }

    @Test
    @DisplayName("주식 종목 수는 목표 1% 이상만 — U3a·E2·S5b(0.3% 잔여) no-names, S5(10% 남음) 통과")
    void stockNamesIgnoreDust() {
        assertThat(case1().now(w(CASH, 99)).verdict().check()).isEqualTo("no-names");
        assertThat(new Case().prev(w(CASH, 70, "A", 29)).held(w(CASH, 67, "A", 29)).now(w(CASH, 99)).verdict().check()).isEqualTo("no-names");
        Case s5b = new Case().prev(merge(w(CASH, 69), each("ABC", 10))).held(merge(w(CASH, 66.0), each("ABC", 10), w("Z", 0.3)))
                .now(w(CASH, 99.4, "Z", 0.3));
        assertThat(s5b.verdict().check()).isEqualTo("no-names");
        assertThat(s5b.inputs().stockNames()).isZero();
        pct(s5b.inputs().deriskPct(), 30.0);
        Case s5 = new Case().prev(merge(w(CASH, 59), each("ABCD", 10))).held(merge(w(CASH, 57.0), each("ABCD", 10))).now(w(CASH, 89, "D", 10));
        assertThat(s5.inputs().stockNames()).isEqualTo(1);
        assertThat(s5.verdict().exempt()).isTrue();
    }

    @Test
    @DisplayName("주식 종목 수의 1% 거름 경계 — 잔여 종목 목표 1.0%는 N에 듦(보냄), 0.99%는 빠짐(no-names)")
    void stockNamesDustBoundary() {
        assertThat(RealTradeRebalance.stockNames(w("Z", 1.0), Set.of(), CASH_LIKE)).isEqualTo(1);
        assertThat(RealTradeRebalance.stockNames(w("Z", 0.99), Set.of(), CASH_LIKE)).isZero();
        // S5b 모양(후보 0 + 잔여 Z) — Z 목표가 1.0이면 그 종목이 N을 채워 보냄, 0.99면 no-names(나머지 확인은 같음)
        for (double z : new double[]{1.0, 0.99}) {
            Case c = new Case().prev(merge(w(CASH, 69), each("ABC", 10))).held(merge(w(CASH, 66.0), each("ABC", 10), w("Z", z)))
                    .now(w(CASH, 99.7 - z, "Z", z));
            assertThat(c.inputs().stockNames()).as("Z %s", z).isEqualTo(z >= 1.0 ? 1 : 0);
            assertThat(c.verdict().check()).as("Z %s", z).isEqualTo(z >= 1.0 ? null : "no-names");
        }
    }

    @Test
    @DisplayName("대기 STOP 종목은 주식 종목 수·유지 종목 축소·노출 감소에서 빠짐 — 스탑 종목만 남은 '모두 팔기'는 no-names, 스탑 종목의 축소는 K에 안 듦, 보유·목표의 스탑 종목은 R에 안 듦")
    void stopNamesLeftOutOfNameChecks() {
        // (a) 실제 계좌·앞 묶음 153130 32·A 30(대기 STOP — 09:10 목표에 반영 안 됨)·B 28, 지금 목표는 153130 70·A 30(후보 0 — 모두 팔기)
        Map<String, Double> book = w(CASH, 32, "A", 30, "B", 28);
        Case onlyStop = new Case().prev(book).held(book).now(w(CASH, 70, "A", 30)).stops("A");
        Inputs a = onlyStop.inputs();
        assertThat(a.stockNames()).isZero();
        assertThat(onlyStop.verdict().check()).isEqualTo("no-names");
        pct(a.checkTurnoverPct(), 66);
        pct(a.deriskPct(), 28);
        pct(a.investedPct(), 100);
        pct(a.accountDriftPct(), 0);
        assertThat(RealTradeRebalance.judge(with(a, "N", 1)).exempt()).as("스탑 종목이 N을 채우면 예외로 나감 — 막는 것은 N뿐").isTrue();
        assertThat(RealTradeRebalance.stockNames(w(CASH, 70, "A", 30), Set.of(), CASH_LIKE)).isEqualTo(1);

        // (c) 두 목표에 다 있는 스탑 종목 A가 11 → 5.5로 줆(실제 가격 반토막) — K에 들지 않아 보냄(스탑을 셌다면 5.5 > 5로 name-cut)
        assertThat(RealTradeRebalance.nameCut(w("A", 5.5, "B", 11), w("A", 11, "B", 11), set("A"), CASH_LIKE)).isEqualByComparingTo("0.00");
        assertThat(RealTradeRebalance.nameCut(w("A", 5.5, "B", 11), w("A", 11, "B", 11), Set.of(), CASH_LIKE)).isEqualByComparingTo("5.50");
        Case cutStop = case1().held(merge(HELD1, w("A", 5.7))).now(merge(w(CASH, 9.5, "A", 5.5), each("BCDE", 11), each("FGHI", 10))).stops("A");
        assertThat(cutStop.inputs().nameCutPct()).isEqualByComparingTo("0.00");
        assertThat(cutStop.verdict().exempt()).isTrue();

        // R의 보유 쪽 — 보유한 스탑 종목 F(목표 0)는 빼고 셈: E3c 모양(셋 순감 + 하나 교체)에 F가 스탑이면 R 29.4로 보냄(F를 셌다면 39.2로 derisk-over)
        Case heldStop = new Case().prev(PREV2).held(PREV2).now(merge(w(CASH, 40.2), each("ABCDE", 9.8), w("K", 9.8))).stops("F");
        pct(heldStop.inputs().deriskPct(), 29.4);
        assertThat(heldStop.verdict().exempt()).isTrue();
        // R의 목표 쪽 — E3(넷 순감)에 반영 안 된 감시 STOP A가 목표·보유에 다 있으면 양쪽에서 빼 R 39.2로 멈춤(목표 쪽만 셌다면 29.4로 지남)
        Case targetStop = new Case().prev(PREV2).held(PREV2).now(merge(w(CASH, 40.2), each("ABCDEF", 9.8))).stops("A");
        assertThat(targetStop.verdict().check()).isEqualTo("derisk-over");
        pct(targetStop.inputs().deriskPct(), 39.2);
    }

    @Test
    @DisplayName("빠진 종목 수는 계좌 어긋남 계획의 건너뜀도 셈 — 책이 파는 A에 앱의 전량 매도 주문이 걸려 있으면 판정 계획은 A를 다루지 않지만 앞 묶음 목표로는 되사는 쪽(opposite-pending)")
    void uncountedIncludesAccountDriftPlan() {
        Case c = case1().now(merge(w(CASH, 15), each("BCDE", 11), each("FGHI", 10)));
        c.opposite = set("A");
        Inputs in = c.inputs();
        Account account = c.account();
        Plan judged = RealTradeRebalance.judgePlan(c.now, E, account, Set.of(), BigDecimal.ZERO, RULES, Set.of(), BigDecimal.ZERO);
        assertThat(judged.skipped()).as("판정 계획에는 A의 건너뜀 없음").noneMatch(skip -> s("A").equals(skip.symbol()));
        assertThat(in.uncounted()).isEqualTo(1);
        assertThat(c.verdict().check()).isEqualTo("uncounted");
        assertThat(RealTradeRebalance.judge(with(in, "U", 0)).exempt()).as("막는 것은 U뿐").isTrue();
    }

    @Test
    @DisplayName("목표 합에 스탑 크레딧 없음 — N3b·N4·E1b 통과(Σ ≥ 99), A2·A2c·S4·S4b targets-thin, 기본 슬롯 결정 뒤 반영 STOP 하나 통과·둘 멈춤")
    void investedHasNoStopCredit() {
        Case a2 = case1().now(merge(each("ADE", 11), each("FGHI", 10))).stops("BC");
        assertThat(a2.verdict().check()).isEqualTo("targets-thin");
        pct(a2.inputs().investedPct(), 73);
        Case a2c = case1().now(merge(each("ACDE", 11), each("FGH", 10), w("I", 5))).stops("B");
        assertThat(a2c.verdict().check()).isEqualTo("targets-thin");
        pct(a2c.inputs().investedPct(), 79);

        double nav = 4 + 3 * 11 * 0.75 + 22 + 30 + 10;
        Map<String, Double> heldS4 = merge(HELD1, scaled(w("A", 11.4, "B", 10.7, "C", 11.2), 0.75));
        double sum4 = heldS4.values().stream().mapToDouble(Double::doubleValue).sum();
        Case s4 = case1().held(scaled(heldS4, 100 / sum4))
                .now(scaled(merge(w(CASH, 4, "D", 11, "E", 11), each("FGH", 10)), 100 / nav)).stops("ABC");
        assertThat(s4.verdict().check()).isEqualTo("targets-thin");
        pct(s4.inputs().investedPct(), 61.71);

        Map<String, Double> heldS4b = merge(w(CASH, 44.0), each("ABCDE", 11 * 0.88));
        double sum4b = heldS4b.values().stream().mapToDouble(Double::doubleValue).sum();
        Case s4b = case1().held(scaled(heldS4b, 100 / sum4b)).now(merge(each("ABCDE", 11 * 0.88), each("FGHI", 10))).stops("ABCDE");
        assertThat(s4b.verdict().check()).isEqualTo("targets-thin");
        pct(s4b.inputs().investedPct(), 88.4);

        Case one = slotCase(2, 15, null, List.of("A03"));
        assertThat(one.verdict().exempt()).isTrue();
        pct(one.inputs().investedPct(), 93.33);
        Case two = slotCase(2, 15, null, List.of("A03", "A04"));
        assertThat(two.verdict().check()).isEqualTo("targets-thin");
        pct(two.inputs().investedPct(), 86.67);
    }

    @Test
    @DisplayName("목표 합 상한 — S3b(107)·15자리 다 참 + 새 종목 1.5배(103.33) targets-over")
    void investedUpperBound() {
        Case s3b = case1().now(merge(w(CASH, 4), each("ABCDE", 11), each("FGHI", 12)));
        assertThat(s3b.verdict().check()).isEqualTo("targets-over");
        pct(s3b.inputs().investedPct(), 107);
        Case full = slotCase(2, 15, 1.5, List.of());
        assertThat(full.verdict().check()).isEqualTo("targets-over");
        pct(full.inputs().investedPct(), 103.33);
    }

    @Test
    @DisplayName("교차 확인은 스탑 감소만 뺀 B° — E1b는 B 100·B° 120, T 120.5로 통과(B 기준이면 멈춤)")
    void crossCheckUsesStopOnlyDrift() {
        Inputs e1b = new Case().prev(merge(w(CASH, 29), each("ABCDEFG", 10))).held(merge(w(CASH, 28.5), each("CDEFG", 10)))
                .now(merge(w(CASH, 49), each("HIJKL", 10))).stops("AB").inputs();
        pct(e1b.bookDriftPct(), 100);
        pct(e1b.crossDriftPct(), 120);
        pct(e1b.checkTurnoverPct(), 120.5);
        assertThat(RealTradeRebalance.judge(e1b).exempt()).isTrue();
        assertThat(e1b.checkTurnoverPct().compareTo(e1b.bookDriftPct().add(new BigDecimal("20")))).as("B로 셌다면 넘음").isPositive();
        assertThat(RealTradeRebalance.judge(e1b).detail()).containsEntry("allowancePct", new BigDecimal("140.00"));
    }

    @Test
    @DisplayName("기본 15종목 동일비중(6.667%) 11-19형 — 교체 0·2·4 보냄, 교체 5 over-cap(153130 46.7%)")
    void defaultSlotSwaps() {
        for (int k : new int[]{0, 2, 4}) {
            assertThat(slotCase(k, 15, null, List.of()).verdict().exempt()).as("교체 %d", k).isTrue();
        }
        Case five = slotCase(5, 15, null, List.of());
        assertThat(five.verdict().check()).isEqualTo("over-cap");
        pct(five.inputs().checkTurnoverPct(), 160.0);
        pct(slotCase(4, 15, null, List.of()).inputs().checkTurnoverPct(), 146.67);
    }

    @Test
    @DisplayName("기록 칸 — 멈춤이면 rebalanceCheck·숫자·빠진 종목 수, 보냄이면 숫자만, 입구 판정은 코드만(결정 코드는 코드 모양일 때만)")
    void verdictDetail() {
        Verdict exempt = case1().now(NOW1).verdict();
        assertThat(exempt.detail()).doesNotContainKeys("rebalanceCheck", "uncounted")
                .containsKeys("checkTurnoverPct", "bookDriftPct", "accountDriftPct", "dailyShortPct", "priceRatio", "nameJumpPct", "nameCutPct",
                        "stockNames", "deriskPct", "investedPct", "allowancePct");
        Verdict halt = case1().held(merge(w("X", 44), without(HELD1, CASH))).now(NOW1).verdict();
        assertThat(halt.detail()).containsEntry("rebalanceCheck", "account-drift").containsEntry("uncounted", 0);
        assertThat(Verdict.gate("buys-paused").detail()).containsOnlyKeys("rebalanceCheck");
        Verdict noRebalance = new Verdict("no-rebalance", null, RealTradeRebalance.decisionCodes("SCHEDULED", "x; drop"));
        assertThat(noRebalance.detail()).containsOnlyKeys("rebalanceCheck", "decisionKind");
        assertThat(RealTradeRebalance.rebalanceOk("REBALANCE", "OK")).isTrue();
        assertThat(RealTradeRebalance.rebalanceOk("SCHEDULED", "OK")).isFalse();
        assertThat(RealTradeRebalance.rebalanceOk("REBALANCE", "NO_TRADE")).isFalse();
        assertThat(RealTradeRebalance.rebalanceOk(null, null)).isFalse();
        // 관찰 로그 — 모르는 값은 '?'
        assertThat(RealTradeRebalance.summary(Inputs.UNKNOWN)).contains("판정 회전율 ?%").doesNotContain("null");
    }

    @Test
    @DisplayName("모의 쪽 글자와 같음 — 결정 종류 REBALANCE(RuleBookService.REBALANCE); OK·RULES는 주석 출처")
    void literalsMatchPaper() {
        assertThat(RealTradeRebalance.KIND_REBALANCE).isEqualTo(RuleBookService.REBALANCE);
    }

    // ------------------------------------------------------------------ 기본 슬롯 모양(계획 4-4의 % 판 — 가격 1원)
    /**
     * 11-19형: 앞 묶음 8종목 × 6.667% + 153130 46.67%, 실제 보유도 같음. 지금 목표는 유지 종목 {@code 8 − swaps}개 + 빈자리를 새 종목으로 {@code total}자리까지,
     * 남는 몫은 153130. {@code newMult}면 첫 새 종목의 비중을 그 배수로(153130이 그만큼 줆), {@code stopAfter}는 결정 뒤 반영된 STOP(그 종목 목표 0, 스탑).
     */
    private static Case slotCase(int swaps, int total, Double newMult, List<String> stopAfter) {
        double slot = 100.0 / 15;
        List<String> names = List.of("A00", "A01", "A02", "A03", "A04", "A05", "A06", "A07");
        Map<String, String> codes = new HashMap<>();
        for (int i = 0; i < names.size(); i++) {
            codes.put(names.get(i), String.format("%06d", 100 + i));
        }
        Map<String, Double> prev = new TreeMap<>();
        names.forEach(n -> prev.put(codes.get(n), slot));
        prev.put(CASH, 100 - slot * names.size());
        List<String> kept = names.subList(swaps, names.size());
        Map<String, Double> now = new TreeMap<>();
        Set<String> stops = new TreeSet<>();
        for (String n : kept) {
            if (stopAfter.contains(n)) {
                stops.add(codes.get(n));
            } else {
                now.put(codes.get(n), slot);
            }
        }
        int newNames = total - kept.size();
        for (int i = 0; i < newNames; i++) {
            now.put(String.format("%06d", 200 + i), slot);
        }
        if (newMult != null) {
            now.put(String.format("%06d", 200), slot * newMult);
        }
        double park = 100 - now.values().stream().mapToDouble(Double::doubleValue).sum() - slot * stopAfter.size();
        if (park > 0.5) {
            now.put(CASH, park);
        }
        Case c = new Case().prev(prev).held(prev).now(now);
        c.stops = stops;
        return c;
    }
}
