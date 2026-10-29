package com.macrodash.analytics;

import com.macrodash.analytics.OrderValidator.Context;
import com.macrodash.analytics.OrderValidator.Limits;
import com.macrodash.analytics.OrderValidator.Market;
import com.macrodash.analytics.OrderValidator.Money;
import com.macrodash.analytics.OrderValidator.Proposed;
import com.macrodash.analytics.OrderValidator.Verdict;
import com.macrodash.analytics.OrderValidator.WholeShares;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import static com.macrodash.analytics.OrderValidator.BELOW_ONE_SHARE;
import static com.macrodash.analytics.OrderValidator.BUY;
import static com.macrodash.analytics.OrderValidator.BUY_BELOW_ONE_SHARE;
import static com.macrodash.analytics.OrderValidator.DUPLICATE_TICKER;
import static com.macrodash.analytics.OrderValidator.LOCKED_OUT;
import static com.macrodash.analytics.OrderValidator.MALFORMED;
import static com.macrodash.analytics.OrderValidator.MAX_POSITIONS;
import static com.macrodash.analytics.OrderValidator.MIN_HOLD;
import static com.macrodash.analytics.OrderValidator.MIN_NOTIONAL;
import static com.macrodash.analytics.OrderValidator.MONTHLY_CAP;
import static com.macrodash.analytics.OrderValidator.NEXT_CLOSE;
import static com.macrodash.analytics.OrderValidator.NEXT_OBSERVATION;
import static com.macrodash.analytics.OrderValidator.NOT_HELD;
import static com.macrodash.analytics.OrderValidator.NO_PRICE;
import static com.macrodash.analytics.OrderValidator.OUT_OF_UNIVERSE;
import static com.macrodash.analytics.OrderValidator.OVER_ALLOCATED;
import static com.macrodash.analytics.OrderValidator.SELL;
import static com.macrodash.analytics.OrderValidator.STALE_INPUT;
import static com.macrodash.analytics.OrderValidator.UNFILLABLE;
import static com.macrodash.analytics.OrderValidator.WEIGHT_CAP;
import static com.macrodash.analytics.OrderValidator.buyIncrementPct;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.entry;

/**
 * 검증기의 시점 순위(계좌2 명세 §10-5·§15, 1-3) — 매도는 순위가 같거나 늦은 매수에만 현금(OVER_ALLOCATED)·종목 자리(MAX_POSITIONS)를 만들고,
 * 두 검사는 마지막 순위 뒤 → 그 매수의 순위부터 매수가 있는 순위마다 봅니다.
 *
 * <ul>
 *   <li><b>동치</b>: 순위를 따로 주지 않은 시장(두 갈래 — 이른 시점 0·나머지 1)은 순위 전 구현과 판정·사유·근거 문구가 글자까지 같습니다. 순위 전
 *       구현은 이 시험 안에 기준으로 그대로 둡니다({@link TwoBranchReference} — 옮겨 온 그대로, 시장의 시점 판정만 이 시험의 함수로). 무작위 주문 묶음
 *       (씨앗 고정 — 같은 묶음이 매번 돎)을 미국·시험용 한국풍·한 시점·세 시점(이른 시점 + 늦은 둘) 시장과 순위 값만 벌린 미국 시장에서 견줍니다.</li>
 *   <li><b>순위 규칙</b>: 시험용 네 시점 시장({@link #TIMED} — 시가 0·10:00 1·12:00 3·15:00 6·종가 7)으로 시가 매도가 10:00 매수의 현금을 만들고,
 *       종가 매도는 15:00 매수의 현금을 못 만들고, 종목 자리도 순위마다 세며, 늦은 순위에 받은 매수가 있으면 그 순위에서도 100%를 보는지.</li>
 * </ul>
 */
class OrderValidatorRanksTest {

    private static final String NEXT_OPEN = "NEXT_OPEN";
    private static final String AT_1000 = "AT_1000";
    private static final String AT_1200 = "AT_1200";
    private static final String AT_1500 = "AT_1500";
    private static final Money WON = new Money("", "원", 0);

    /** 시험용 한국풍 시장(OrderValidatorMarketTest와 같은 값): 이른 시점 NEXT_OPEN, 늦은 시점 NEXT_CLOSE, 원. */
    private static final Market KR_LIKE = new Market(List.of(NEXT_OPEN, NEXT_CLOSE), NEXT_OPEN,
            Map.of(NEXT_OPEN, "다음 거래일 시가", NEXT_CLOSE, "확정 종가"), WON);
    /** 시험용 한 시점 시장. */
    private static final Market OPEN_ONLY = new Market(List.of(NEXT_OPEN), NEXT_OPEN, Map.of(NEXT_OPEN, "다음 거래일 시가"),
            WON);
    /** 시험용 세 시점 시장 — 순위를 주지 않아 두 갈래(이른 시점 0, 늦은 둘 1). */
    private static final Market THREE = new Market(List.of(NEXT_OPEN, AT_1000, NEXT_CLOSE), NEXT_OPEN,
            Map.of(NEXT_OPEN, "시가", AT_1000, "10:00", NEXT_CLOSE, "종가"), Money.USD);
    /** 시험용 시각 지정 시장 — 순위 시가 0 < 10:00 1 < 12:00 3 < 15:00 6 < 종가 7(계좌2 명세 §10-5의 순위 자리, 사이는 비워 둠). */
    private static final Market TIMED = new Market(List.of(NEXT_OPEN, AT_1000, AT_1200, AT_1500, NEXT_CLOSE), NEXT_OPEN,
            Map.of(NEXT_OPEN, "시가", AT_1000, "10:00", AT_1200, "12:00", AT_1500, "15:00", NEXT_CLOSE, "종가"), Money.USD,
            Map.of(NEXT_OPEN, 0, AT_1000, 1, AT_1200, 3, AT_1500, 6, NEXT_CLOSE, 7));

    private static final List<String> POOL = List.of("AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ",
            "XLK", "XLE", "SHY");
    private static final Set<String> ETFS = Set.of("XLK", "XLE", "SHY");
    private static final Set<String> CASH_LIKE = Set.of("SHY");
    private static final KrxCosts.Rates KR_RATES = new KrxCosts.Rates(new BigDecimal("1.5"), BigDecimal.valueOf(5),
            KrxCosts.TaxRates.KRX_2026);
    private static final Limits DEFAULT = new Limits(10, 20, 20, 500, 20, 5);

    // ------------------------------------------------------------------ 동치
    /** 무작위 묶음 하나(문맥·한도·주문). */
    private record Batch(List<Proposed> orders, Context ctx, Limits limits) {
    }

    @Test
    @DisplayName("동치: 두 갈래 시장(미국·한국풍·한 시점·세 시점, 순위 값만 벌린 미국)의 무작위 주문 묶음 판정 = 순위 전 구현(사유·근거 문구까지)")
    void randomBatchesMatchTheTwoBranchImplementation() {
        Market usSpread = Market.US.withRanks(Map.of(NEXT_OBSERVATION, 2, NEXT_CLOSE, 9));
        assertThat(usSpread).as("순위 값만 다른 시장은 다른 값").isNotEqualTo(Market.US);
        Map<String, Integer> seen = new TreeMap<>();
        record Case(Market market, Market reference, boolean krFields, long seed) {
        }
        List<Case> cases = List.of(new Case(Market.US, Market.US, false, 1L), new Case(KR_LIKE, KR_LIKE, true, 2L),
                new Case(OPEN_ONLY, OPEN_ONLY, true, 3L), new Case(THREE, THREE, false, 4L),
                new Case(usSpread, Market.US, false, 5L));
        for (Case c : cases) {
            Random random = new Random(c.seed());
            for (int i = 0; i < 20_000; i++) {
                Batch batch = batch(random, c.market(), c.krFields());
                List<Verdict> expected = TwoBranchReference.validate(batch.orders(), batch.ctx(), batch.limits(),
                        c.reference());
                List<Verdict> actual = OrderValidator.validate(batch.orders(), batch.ctx(), batch.limits(), c.market());
                int index = i;
                assertThat(actual).as(() -> c.market().timings() + " 묶음 " + index + ": " + batch).isEqualTo(expected);
                for (Verdict v : actual) {
                    // 이른 시점 매수의 시점 거절(늦은 매도가 자리를 만들지 못함)은 따로 셉니다 — 문구가 다른 갈래.
                    seen.merge(v.accepted() ? (BUY.equals(v.order().side()) ? "BUY" : "SELL")
                            : v.rejectReason() + (v.detail().contains("매수인데") ? " 시점" : ""), 1, Integer::sum);
                }
            }
        }
        // 묶음이 2단계 갈래를 실제로 지나가는지(빈 곳만 견주지 않게) — 이른 시점 쪽 거절 문구까지.
        assertThat(seen).containsKeys("BUY", "SELL", STALE_INPUT, MALFORMED, DUPLICATE_TICKER, OUT_OF_UNIVERSE,
                NOT_HELD, LOCKED_OUT, NO_PRICE, MIN_HOLD, BELOW_ONE_SHARE, WEIGHT_CAP, MIN_NOTIONAL, MONTHLY_CAP,
                MAX_POSITIONS, OVER_ALLOCATED, UNFILLABLE, BUY_BELOW_ONE_SHARE);
        for (String branch : List.of(OVER_ALLOCATED, MAX_POSITIONS, OVER_ALLOCATED + " 시점", MAX_POSITIONS + " 시점")) {
            assertThat(seen.getOrDefault(branch, 0)).as(branch + " " + seen).isGreaterThan(100);
        }
    }

    /** 무작위 묶음 — 보유·비중(가끔 0·음수·NaN·합 100 초과)·보유일·수량·유니버스·재진입 금지·가격 없음·한국 칸·한도·주문(가끔 모양이 틀림). */
    private static Batch batch(Random r, Market market, boolean krFields) {
        double nav = r.nextBoolean() ? 100_000 : 20_000 + r.nextInt(900_000);
        Map<String, Double> weights = new LinkedHashMap<>();
        for (String ticker : POOL) {
            if (r.nextInt(100) < 40) {
                int odd = r.nextInt(40);
                weights.put(ticker, odd == 0 ? 0.0 : odd == 1 ? -1.0 : odd == 2 ? Double.NaN
                        : r.nextInt(4) == 0 ? r.nextDouble() * 3 : r.nextDouble() * 35);
            }
        }
        double sum = weights.values().stream().filter(w -> w > 0).mapToDouble(Double::doubleValue).sum();
        // 3분의 1은 거의 다 찬 장부(90~99%) — 늦은 매도·이른 매수의 시점 거절이 나오게. 나머지는 99%를 넘으면 대개 99%로(가끔 넘친 채로).
        boolean full = r.nextInt(3) == 0;
        if (sum > 0 && (full || sum > 99 && r.nextInt(5) != 0)) {
            double target = full ? 90 + r.nextDouble() * 9 : 99;
            double scale = target / sum;
            weights.replaceAll((ticker, w) -> w > 0 ? w * scale : w);
            sum = target;
        }
        Map<String, Integer> days = new HashMap<>();
        Map<String, Integer> qty = new HashMap<>();
        for (String ticker : weights.keySet()) {
            if (r.nextInt(5) != 0) {
                days.put(ticker, r.nextInt(12));
            }
            if (r.nextInt(6) != 0) {
                qty.put(ticker, 1 + r.nextInt(r.nextBoolean() ? 3 : 2_000));
            }
        }
        Set<String> universe = new LinkedHashSet<>();
        Set<String> locked = new LinkedHashSet<>();
        Set<String> noPrice = new LinkedHashSet<>();
        Map<String, String> unfillable = new HashMap<>();
        for (String ticker : POOL) {
            if (r.nextInt(10) != 0) {
                universe.add(ticker);
            }
            if (r.nextInt(10) == 0) {
                locked.add(ticker);
            }
            if (r.nextInt(14) == 0) {
                noPrice.add(ticker);
            }
            if (krFields && r.nextInt(weights.containsKey(ticker) ? 7 : 20) == 0) {
                unfillable.put(ticker, "기준 거래일 거래정지");
            }
        }
        WholeShares wholeShares = null;
        if (krFields && r.nextBoolean()) {
            Map<String, BigDecimal> prices = new HashMap<>();
            for (String ticker : POOL) {
                if (r.nextInt(8) != 0) {
                    prices.put(ticker, BigDecimal.valueOf(1_000 + r.nextInt(r.nextBoolean() ? 9_000 : 2_000_000)));
                }
            }
            wholeShares = new WholeShares(prices, KR_RATES);
        }
        Context ctx = new Context(nav, nav * (1 - sum / 100.0), weights, days, universe, ETFS, CASH_LIKE, locked, noPrice,
                r.nextInt(4) == 0 ? r.nextInt(23) : r.nextInt(5), r.nextInt(60) == 0, qty, krFields ? unfillable : null,
                wholeShares);
        Limits limits = r.nextInt(4) == 0 ? DEFAULT : new Limits(8 + r.nextInt(33), 10 + r.nextInt(40), 1 + r.nextInt(8),
                r.nextInt(4) == 0 ? 0 : 100 + r.nextInt(3_000), r.nextInt(4) == 0 ? r.nextInt(25) : 20, r.nextInt(4));
        List<String> heldTickers = new ArrayList<>(weights.keySet());

        List<Proposed> orders = new ArrayList<>();
        int count = r.nextInt(10);
        for (int i = 0; i < count; i++) {
            if (r.nextInt(40) == 0) {
                orders.add(null);
                continue;
            }
            String side = r.nextInt(40) == 0 ? "HOLD" : r.nextBoolean() ? BUY : SELL;
            // 매도는 대개 보유 종목(보유 없음 거절만 쌓이지 않게), 가끔 티커 없음·유니버스 밖.
            String ticker = r.nextInt(40) == 0 ? (r.nextBoolean() ? null : "ZZZ")
                    : SELL.equals(side) && !heldTickers.isEmpty() && r.nextInt(5) != 0
                    ? heldTickers.get(r.nextInt(heldTickers.size())) : POOL.get(r.nextInt(POOL.size()));
            String timing = r.nextInt(40) == 0 ? (r.nextBoolean() ? null : "IMMEDIATE")
                    : market.timings().get(r.nextInt(market.timings().size()));
            Double target;
            Double fraction;
            if (BUY.equals(side)) {
                int odd = r.nextInt(40);
                target = odd == 0 ? null : odd == 1 ? Double.NaN : odd == 2 ? 150.0
                        : Math.round(r.nextDouble() * 3_000) / 100.0;
                fraction = r.nextInt(10) == 0 ? 0.5 : null;
            } else {
                target = r.nextInt(12) == 0 ? (r.nextBoolean() ? 0.0 : 5.0) : null;
                int odd = r.nextInt(24);
                double[] usual = {1.0, 0.5, 0.25, 0.1, 0.01, r.nextDouble()};
                fraction = r.nextInt(3) == 0 ? null : odd == 0 ? 1.5 : odd == 1 ? 0.0 : usual[r.nextInt(usual.length)];
            }
            orders.add(new Proposed(ticker, side, target, fraction, timing));
        }
        return new Batch(orders, ctx, limits);
    }

    // ------------------------------------------------------------------ 순위 규칙
    private static Proposed buy(String ticker, double targetWeightPct, String timing) {
        return new Proposed(ticker, BUY, targetWeightPct, null, timing);
    }

    private static Proposed sell(String ticker, String timing) {
        return new Proposed(ticker, SELL, null, null, timing);
    }

    /** 보유(티커 → 비중 %, 보유 30거래일)만 다른 문맥 — 순자산 10만, 유니버스 POOL, SHY 현금성. */
    private static Context held(Map<String, Double> weights) {
        double sum = weights.values().stream().mapToDouble(Double::doubleValue).sum();
        Map<String, Integer> days = new HashMap<>();
        weights.keySet().forEach(ticker -> days.put(ticker, 30));
        return new Context(100_000, 100_000 * (1 - sum / 100.0), weights, days, new LinkedHashSet<>(POOL), ETFS,
                CASH_LIKE, null, null, 0, false);
    }

    @Test
    @DisplayName("시점 순위: 시가 매도는 10:00 매수의 현금을 만들고, 종가 매도는 15:00 매수의 현금을 못 만듦(같은 순위 매도는 만듦)")
    void sellFundsOnlyBuysAtTheSameOrLaterRank() {
        Context ctx = held(Map.of("AAA", 95.0));
        Limits limits = new Limits(10, 20, 20, 500, 20, 0);
        assertThat(OrderValidator.validate(List.of(sell("AAA", NEXT_OPEN), buy("BBB", 10, AT_1000)), ctx, limits, TIMED))
                .extracting(Verdict::rejectReason).containsExactly(null, null);
        assertThat(OrderValidator.validate(List.of(sell("AAA", AT_1000), buy("BBB", 10, AT_1000)), ctx, limits, TIMED))
                .as("같은 순위 — 장부가 같은 관측치에서 매도를 먼저 체결").extracting(Verdict::rejectReason)
                .containsExactly(null, null);

        List<Verdict> late = OrderValidator.validate(List.of(sell("AAA", NEXT_CLOSE), buy("BBB", 10, AT_1500)), ctx,
                limits, TIMED);
        assertThat(late).extracting(Verdict::rejectReason).containsExactly(null, OVER_ALLOCATED);
        assertThat(late.get(1).detail()).isEqualTo("15:00(AT_1500) 매수인데 종가(NEXT_CLOSE) 매도 95.00%p는 그 뒤에 체결돼 "
                + "자리를 만들지 못함 — 그 시점 남는 보유 95.00% + 앞서 받은 시가·10:00·12:00·15:00 매수 0.00%p + 이 주문 10.00%p "
                + "= 105.00% > 100% (현재 현금 5.00%)");
        // 15:00 매도는 그 뒤 종가 매수의 현금은 만듦.
        assertThat(OrderValidator.validate(List.of(sell("AAA", AT_1500), buy("BBB", 10, NEXT_CLOSE)), ctx, limits, TIMED))
                .extracting(Verdict::rejectReason).containsExactly(null, null);
        // 12:00 매도는 10:00 매수 앞에 체결되지 않음 — 10:00에 남는 보유 95% + 10%.
        List<Verdict> before = OrderValidator.validate(List.of(sell("AAA", AT_1200), buy("BBB", 10, AT_1000)), ctx,
                limits, TIMED);
        assertThat(before.get(1).rejectReason()).isEqualTo(OVER_ALLOCATED);
        assertThat(before.get(1).detail()).startsWith("10:00(AT_1000) 매수인데 12:00(AT_1200)·15:00(AT_1500)·종가(NEXT_CLOSE) "
                + "매도 95.00%p는 그 뒤에 체결돼 자리를 만들지 못함 — 그 시점 남는 보유 95.00% + 앞서 받은 시가·10:00 매수 0.00%p");
    }

    @Test
    @DisplayName("시점 순위: 종목 자리도 순위마다 — 15:00 전량 매도가 비울 자리를 10:00 신규 매수는 못 쓰고, 종가 신규 매수는 씀")
    void positionsPerRank() {
        Context ctx = held(Map.of("AAA", 40.0, "BBB", 40.0));
        Limits limits = new Limits(10, 20, 2, 500, 20, 0);
        List<Verdict> early = OrderValidator.validate(List.of(sell("AAA", AT_1500), buy("CCC", 5, AT_1000)), ctx, limits,
                TIMED);
        assertThat(early).extracting(Verdict::rejectReason).containsExactly(null, MAX_POSITIONS);
        assertThat(early.get(1).detail()).isEqualTo("10:00(AT_1000) 매수인데 12:00(AT_1200)·15:00(AT_1500)·종가(NEXT_CLOSE) "
                + "전량 매도 1종목은 그 뒤에 체결돼 자리를 비우지 못함 — 그 시점 종목 수 3 > 상한 2(현금성 제외)");
        assertThat(OrderValidator.validate(List.of(sell("AAA", AT_1500), buy("CCC", 5, NEXT_CLOSE)), ctx, limits, TIMED))
                .extracting(Verdict::rejectReason).containsExactly(null, null);
        assertThat(OrderValidator.validate(List.of(sell("AAA", AT_1000), buy("CCC", 5, AT_1200)), ctx, limits, TIMED))
                .extracting(Verdict::rejectReason).containsExactly(null, null);
        // 마지막 순위 뒤에도 넘으면 그 문구(모든 매도 뒤) — 두 갈래와 같은 순서.
        assertThat(OrderValidator.validate(List.of(buy("CCC", 5, NEXT_CLOSE)), ctx, limits, TIMED).get(0).detail())
                .isEqualTo("매수 뒤 종목 수 3 > 상한 2(현금성 제외)");
    }

    @Test
    @DisplayName("시점 순위: 100% 검사는 매수가 있는 순위마다 — 12:00에 받은 매수가 있으면 10:00 매수도 12:00 시점 합을 봄(종가 뒤·10:00은 통과해도)")
    void checksEveryRankWithBuys() {
        // AAA 60%는 종가에, CCC 30%는 10:00에 팜. 먼저 처리되는 12:00 매수 30%(목표 비중 큰 순)가 12:00 합을 90%로 만듦.
        Context ctx = held(Map.of("AAA", 60.0, "CCC", 30.0));
        Limits limits = new Limits(40, 40, 20, 500, 20, 0);
        List<Verdict> verdicts = OrderValidator.validate(List.of(sell("AAA", NEXT_CLOSE), sell("CCC", AT_1000),
                buy("DDD", 30, AT_1200), buy("EEE", 15, AT_1000)), ctx, limits, TIMED);
        assertThat(verdicts).extracting(Verdict::rejectReason).containsExactly(null, null, null, OVER_ALLOCATED);
        assertThat(verdicts.get(3).detail()).isEqualTo("10:00(AT_1000) 매수인데 15:00(AT_1500)·종가(NEXT_CLOSE) 매도 60.00%p는 "
                + "그 뒤에 체결돼 자리를 만들지 못함 — 그 시점 남는 보유 60.00% + 앞서 받은 시가·10:00·12:00 매수 30.00%p + 이 주문 "
                + "15.00%p = 105.00% > 100% (현재 현금 10.00%)");
        // 12:00 매수가 없으면 10:00 시점(60%)과 종가 뒤만 봄 — 같은 10:00 매수가 들어감.
        assertThat(OrderValidator.validate(List.of(sell("AAA", NEXT_CLOSE), sell("CCC", AT_1000), buy("EEE", 15, AT_1000)),
                ctx, limits, TIMED)).extracting(Verdict::rejectReason).containsExactly(null, null, null);
    }

    @Test
    @DisplayName("시점 순위 값: 주지 않으면 두 갈래(이른 시점 0·나머지 1), 받는 시점마다 0 이상·이른 시점이 가장 작아야 하고 남는 항목은 버림, withRanks는 순위만 바꿈")
    void ranksOfTheMarket() {
        assertThat(Market.US.ranks()).containsExactly(entry(NEXT_OBSERVATION, 0), entry(NEXT_CLOSE, 1));
        assertThat(THREE.ranks()).containsExactly(entry(NEXT_OPEN, 0), entry(AT_1000, 1), entry(NEXT_CLOSE, 1));
        assertThat(OPEN_ONLY.ranks()).containsExactly(entry(NEXT_OPEN, 0));
        assertThat(Market.US.withRanks(Map.of(NEXT_OBSERVATION, 0, NEXT_CLOSE, 1))).isEqualTo(Market.US);
        assertThat(Market.US.withRanks(null)).isEqualTo(Market.US);
        Market spread = Market.US.withRanks(Map.of(NEXT_OBSERVATION, 3, NEXT_CLOSE, 8, "EXTRA", 1));
        assertThat(spread.ranks()).containsExactly(entry(NEXT_OBSERVATION, 3), entry(NEXT_CLOSE, 8));
        assertThat(spread.timings()).isEqualTo(Market.US.timings());
        assertThat(spread.timingNames()).isEqualTo(Market.US.timingNames());
        assertThat(spread.money()).isEqualTo(Market.US.money());
        assertThat(TIMED.lateLabel()).isEqualTo("10:00(AT_1000)·12:00(AT_1200)·15:00(AT_1500)·종가(NEXT_CLOSE)");
        assertThat(TIMED.laterLabel(3)).isEqualTo("15:00(AT_1500)·종가(NEXT_CLOSE)");
        assertThat(TIMED.namesUpTo(3)).isEqualTo("시가·10:00·12:00");
        assertThat(TIMED.distinctRanks()).containsExactly(0, 1, 3, 6, 7);
        assertThat(THREE.distinctRanks()).containsExactly(0, 1);

        assertThatThrownBy(() -> Market.US.withRanks(Map.of(NEXT_OBSERVATION, 0)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining(NEXT_CLOSE);
        assertThatThrownBy(() -> Market.US.withRanks(Map.of(NEXT_OBSERVATION, 0, NEXT_CLOSE, -1)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("음수");
        assertThatThrownBy(() -> Market.US.withRanks(Map.of(NEXT_OBSERVATION, 2, NEXT_CLOSE, 1)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("이른 시점");
        // 같은 순위는 같은 때 — 이른 시점과 같은 순위여도 됨(이른 시점보다 이르지만 않으면).
        assertThat(Market.US.withRanks(Map.of(NEXT_OBSERVATION, 0, NEXT_CLOSE, 0)).distinctRanks()).containsExactly(0);
    }

    // ------------------------------------------------------------------ 기준: 순위 전 구현
    /**
     * 순위 전(두 갈래) 검증기 — {@code OrderValidator.validate}와 그 1단계·문구 함수를 순위를 더하기 전 판에서 옮겨 온 그대로입니다. 시장의 시점
     * 판정(받는 시점·이른 시점·시점 표기·늦은 시점 표기)만 이 시험의 함수로 바꿨습니다(새 구현의 시장 함수를 쓰지 않게). 고치지 않습니다 — 이
     * 기준이 바뀌면 동치 시험이 아무것도 지키지 않습니다.
     */
    private static final class TwoBranchReference {

        private static final double WEIGHT_EPSILON = 1e-9;
        private static final double MONEY_EPSILON = 1e-6;

        private TwoBranchReference() {
        }

        private static boolean accepts(Market market, String timing) {
            return timing != null && market.timingNames().containsKey(timing);
        }

        private static boolean isEarly(Market market, String timing) {
            return market.earlyTiming().equals(timing);
        }

        private static String label(Market market, String timing) {
            return market.timingNames().get(timing) + "(" + timing + ")";
        }

        private static String lateLabel(Market market) {
            List<String> labels = new ArrayList<>();
            for (String timing : market.timings()) {
                if (!isEarly(market, timing)) {
                    labels.add(label(market, timing));
                }
            }
            return String.join("·", labels);
        }

        static List<Verdict> validate(List<Proposed> orders, Context ctx, Limits limits, Market market) {
            if (ctx == null) {
                throw new IllegalArgumentException("검사 문맥(장부 상태)이 없습니다");
            }
            if (limits == null) {
                throw new IllegalArgumentException("하드 규칙 한도가 없습니다");
            }
            if (market == null) {
                throw new IllegalArgumentException("검증기의 시장(체결 시점·표기)이 없습니다");
            }
            if (orders == null || orders.isEmpty()) {
                return List.of();
            }
            int n = orders.size();
            Verdict[] out = new Verdict[n];

            // 0) 자료가 오래됐으면 그날 재량 주문 전부(매도 포함).
            if (ctx.inputsStale()) {
                for (int i = 0; i < n; i++) {
                    out[i] = Verdict.reject(orders.get(i), STALE_INPUT,
                            "입력 자료가 오래됨(종목 저장본 24시간 초과 또는 확정 종가 전) — 그날 재량 주문 전부 거절");
                }
                return List.of(out);
            }

            // 1) 주문마다 따로. null로 남은 자리가 2단계 후보입니다.
            Map<String, Integer> firstIndex = new HashMap<>();
            for (int i = 0; i < n; i++) {
                out[i] = checkAlone(orders.get(i), i, firstIndex, ctx, limits, market);
            }

            // 2-a) 매도 — 목록 순으로 월 상한 자리를 먼저 받습니다(클래스 설명).
            int slots = Math.max(0, limits.maxDiscretionaryOrdersPerMonth() - ctx.monthlyOrdersSoFar());
            int used = 0;
            Map<String, Double> soldFraction = new HashMap<>();
            // 이른 시점(미국 NEXT_OBSERVATION)에 체결되는 매도만 — 같은 시점 매수의 자리를 만드는 매도(클래스 설명의 "체결 시점").
            Map<String, Double> earlySoldFraction = new HashMap<>();
            // 받았지만 지금 체결할 수 없어 자리를 만들지 않는 매도(한국 칸 — 거절 문구용): 그 비중(%p)과 전량 매도 종목 수.
            double blockedFreedPct = 0;
            int blockedPositions = 0;
            List<Integer> buys = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                if (out[i] != null) {
                    continue;
                }
                Proposed order = orders.get(i);
                if (BUY.equals(order.side())) {
                    buys.add(i);
                    continue;
                }
                if (used >= slots) {
                    out[i] = Verdict.reject(order, MONTHLY_CAP, monthlyDetail(ctx, limits, used));
                    continue;
                }
                used++;
                double fraction = order.sellFraction() == null ? 1.0 : Math.min(1.0, order.sellFraction());
                if (ctx.unfillable().containsKey(order.ticker())) {
                    // 한국 칸 — 지금 체결할 수 없는 보유의 매도는 받아 대기로 두지만 그 시점에 체결되지 않으므로 같은 시점 매수의 현금·종목
                    // 자리를 만들지 않습니다(클래스 설명의 "한국 칸" — 규칙 계좌가 그 매도 대금을 현금 어림에서 빼는 것과 같은 조건).
                    Double weight = ctx.weightOf(order.ticker());
                    blockedFreedPct += weight == null ? 0.0 : weight * fraction;
                    if (fraction >= 1.0 && !ctx.cashLike().contains(order.ticker())) {
                        blockedPositions++;
                    }
                    out[i] = Verdict.accept(order, sellDetail(weight, fraction) + UNFILLABLE_SELL_NOTE);
                    continue;
                }
                soldFraction.put(order.ticker(), fraction);
                if (isEarly(market, order.timing())) {
                    earlySoldFraction.put(order.ticker(), fraction);
                }
                out[i] = Verdict.accept(order, sellDetail(ctx.weightOf(order.ticker()), fraction));
            }

            // 매도 뒤 남는 보유 비중과 종목 수 — 티커 순으로 더해 맵 순회 순서와 관계없이 같은 합. 둘 다 두 시점으로 봅니다
            // (클래스 설명의 "체결 시점"): 확정 종가 뒤(모든 매도 체결) · 이른 시점(그 시점 매도만 체결).
            double allocated = 0;
            double allocatedEarly = 0;
            int positions = 0;
            int positionsEarly = 0;
            int lateFreed = 0;   // 늦은 시점(미국 NEXT_CLOSE) 전량 매도로만 비는 자리(거절 문구용)
            for (String ticker : heldTickers(ctx)) {
                double weight = ctx.weightOf(ticker);
                double fraction = soldFraction.getOrDefault(ticker, 0.0);
                double earlyFraction = earlySoldFraction.getOrDefault(ticker, 0.0);
                allocated += weight * (1.0 - fraction);
                allocatedEarly += weight * (1.0 - earlyFraction);
                if (!ctx.cashLike().contains(ticker)) {
                    if (fraction < 1.0) {
                        positions++;
                    }
                    if (earlyFraction < 1.0) {
                        positionsEarly++;
                        if (fraction >= 1.0) {
                            lateFreed++;
                        }
                    }
                }
            }
            double residual = allocated;
            double residualEarly = allocatedEarly;
            double cashPct = ctx.cash() / ctx.nav() * 100.0;

            // 2-b) 매수 — 목표 비중 큰 순(C11), 같으면 목록 순.
            buys.sort((a, b) -> {
                int byTarget = Double.compare(orders.get(b).targetWeightPct(), orders.get(a).targetWeightPct());
                return byTarget != 0 ? byTarget : Integer.compare(a, b);
            });
            for (int i : buys) {
                Proposed order = orders.get(i);
                String ticker = order.ticker();
                Double current = ctx.weightOf(ticker);
                double increment = buyIncrementPct(order, ctx);
                boolean newName = current == null && !ctx.cashLike().contains(ticker);
                boolean early = isEarly(market, order.timing());
                if (used >= slots) {
                    out[i] = Verdict.reject(order, MONTHLY_CAP, monthlyDetail(ctx, limits, used));
                } else if (newName && positions + 1 > limits.maxPositions()) {
                    out[i] = Verdict.reject(order, MAX_POSITIONS, String.format(Locale.ROOT,
                            "매수 뒤 종목 수 %d > 상한 %d(현금성 제외)", positions + 1, limits.maxPositions())
                            + blockedPositionsNote(blockedPositions));
                } else if (newName && early && positionsEarly + 1 > limits.maxPositions()) {
                    out[i] = Verdict.reject(order, MAX_POSITIONS, String.format(Locale.ROOT,
                            "%s 매수인데 %s 전량 매도 %d종목은 그 뒤에 체결돼 자리를 "
                                    + "비우지 못함 — 그 시점 종목 수 %d > 상한 %d(현금성 제외)",
                            label(market, market.earlyTiming()), lateLabel(market), lateFreed, positionsEarly + 1,
                            limits.maxPositions()) + blockedPositionsNote(blockedPositions));
                } else if (allocated + increment > 100.0 + WEIGHT_EPSILON) {
                    out[i] = Verdict.reject(order, OVER_ALLOCATED, String.format(Locale.ROOT,
                            "매도 뒤 남는 보유 %.2f%% + 앞서 받은 매수 %.2f%%p + 이 주문 %.2f%%p = %.2f%% > 100%% (현재 현금 %.2f%%)",
                            residual, allocated - residual, increment, allocated + increment, cashPct)
                            + blockedFreedNote(blockedFreedPct));
                } else if (early && allocatedEarly + increment > 100.0 + WEIGHT_EPSILON) {
                    out[i] = Verdict.reject(order, OVER_ALLOCATED, String.format(Locale.ROOT,
                            "%s 매수인데 %s 매도 %.2f%%p는 그 뒤에 체결돼 자리를 만들지 "
                                    + "못함 — 그 시점 남는 보유 %.2f%% + 앞서 받은 %s 매수 %.2f%%p + 이 주문 %.2f%%p = %.2f%% "
                                    + "> 100%% (현재 현금 %.2f%%)",
                            label(market, market.earlyTiming()), lateLabel(market), residualEarly - residual,
                            residualEarly, market.timingNames().get(market.earlyTiming()), allocatedEarly - residualEarly,
                            increment, allocatedEarly + increment, cashPct) + blockedFreedNote(blockedFreedPct));
                } else {
                    used++;
                    allocated += increment;
                    if (early) {
                        allocatedEarly += increment;
                    }
                    if (newName) {
                        positions++;
                        if (early) {
                            positionsEarly++;
                        }
                    }
                    out[i] = Verdict.accept(order, buyDetail(current, order.targetWeightPct(), increment, ctx.nav(),
                            market.money()));
                }
            }
            return List.of(out);
        }

        /** 1단계 — 다른 주문을 보지 않는 검사. 통과면 null. firstIndex에 티커의 첫 자리를 남깁니다. */
        private static Verdict checkAlone(Proposed order, int index, Map<String, Integer> firstIndex, Context ctx,
                                          Limits limits, Market market) {
            if (order == null) {
                return Verdict.reject(null, MALFORMED, "주문이 비어 있음");
            }
            String ticker = order.ticker();
            if (ticker == null || ticker.isBlank()) {
                return Verdict.reject(order, MALFORMED, "티커가 없음");
            }
            // 모양이 틀린 주문도 티커 자리는 잡습니다 — 같은 티커의 뒤 주문이 앞 주문의 판정에 따라 통과·거절이 갈리지 않게.
            Integer earlier = firstIndex.putIfAbsent(ticker, index);
            String malformed = malformed(order, market);
            if (malformed != null) {
                return Verdict.reject(order, MALFORMED, malformed);
            }
            if (earlier != null) {
                return Verdict.reject(order, DUPLICATE_TICKER,
                        "같은 티커의 앞선 주문(" + (earlier + 1) + "번째)이 있음 — 첫 주문만 봄");
            }
            boolean buy = BUY.equals(order.side());
            Double current = ctx.weightOf(ticker);
            if (!ctx.universe().contains(ticker) && (buy || current == null)) {
                return Verdict.reject(order, OUT_OF_UNIVERSE, "유니버스 밖 티커: " + ticker);
            }
            if (buy && ctx.lockedOut().contains(ticker)) {
                return Verdict.reject(order, LOCKED_OUT, "트레일링 스탑 뒤 재진입 금지 중");
            }
            if (!buy && current == null) {
                return Verdict.reject(order, NOT_HELD, "보유하지 않은 종목은 팔 수 없음");
            }
            String unfillable = buy ? ctx.unfillable().get(ticker) : null;
            if (unfillable != null) {
                return Verdict.reject(order, UNFILLABLE, "지금 체결할 수 없는 종목 — " + unfillable
                        + " · 매수만 거절(보유 매도는 받음)");
            }
            if (ctx.noPrice().contains(ticker)) {
                return Verdict.reject(order, NO_PRICE, "가격이 없거나 오래됨 — 체결 가격을 정할 수 없음");
            }
            if (buy && ctx.wholeShares() != null && ctx.wholeShares().price(ticker) == null) {
                return Verdict.reject(order, NO_PRICE, "기준 가격이 없음 — 정수 주로 살 1주 체결 금액을 정할 수 없음");
            }
            boolean cashLike = ctx.cashLike().contains(ticker);
            if (!buy) {
                int minHold = limits.minHoldTradingDaysForSell();
                if (minHold > 0 && !cashLike) {
                    Integer days = ctx.heldTradingDays().get(ticker);
                    if (days == null) {
                        // 모르는 보유일을 '충분함'으로 읽으면 과매매 억제(C9)가 조용히 꺼집니다 — 거절하고 이유를 남깁니다.
                        return Verdict.reject(order, MIN_HOLD, "보유 거래일을 알 수 없음 — 최소 " + minHold + "거래일 확인 불가");
                    }
                    if (days < minHold) {
                        return Verdict.reject(order, MIN_HOLD, "보유 " + days + "거래일 < 최소 " + minHold + "거래일");
                    }
                }
                Double fraction = order.sellFraction();
                Integer held = ctx.heldQty().get(ticker);
                // 장부와 같은 계산(PaperLedger.sellQty) — 1 미만의 비율인데 1주 미만이면 장부가 보유 전체를 팝니다(클래스 설명의 "매도 비율").
                if (fraction != null && fraction < 1.0 && held != null && held > 0
                        && PaperLedger.sellQty(held, fraction) >= held) {
                    return Verdict.reject(order, BELOW_ONE_SHARE, "보유 " + held + "주의 "
                            + BigDecimal.valueOf(fraction).stripTrailingZeros().toPlainString()
                            + "는 1주 미만 — 장부가 전량으로 집행하므로 거절, 전량이면 sellFraction 1");
                }
                return null;
            }
            double target = order.targetWeightPct();
            if (!cashLike) {
                boolean etf = ctx.etfs().contains(ticker);
                double cap = etf ? limits.maxWeightEtfPct() : limits.maxWeightStockPct();
                if (target > cap + WEIGHT_EPSILON) {
                    return Verdict.reject(order, WEIGHT_CAP, String.format(Locale.ROOT, "목표 %.2f%% > %s 상한 %.2f%%",
                            target, etf ? "ETF" : "종목", cap));
                }
            }
            double now = current == null ? 0.0 : current;
            double increment = target - now;
            if (!(increment > WEIGHT_EPSILON)) {
                return Verdict.reject(order, MIN_NOTIONAL, String.format(Locale.ROOT,
                        "목표 비중이 현재 비중 이하 — 살 금액 없음(현재 %.2f%% → 목표 %.2f%%)", now, target));
            }
            double amount = increment / 100.0 * ctx.nav();
            if (amount < limits.minOrderNotional() - MONEY_EPSILON) {
                return Verdict.reject(order, MIN_NOTIONAL, String.format(Locale.ROOT,
                        "매수 증가분 약 %s < 최소 %s(현재 %.2f%% → 목표 %.2f%%)", market.money().exact(amount),
                        market.money().exact(limits.minOrderNotional()), now, target));
            }
            WholeShares shares = ctx.wholeShares();
            if (shares != null) {
                BigDecimal price = shares.price(ticker);
                // 장부가 체결 때 쓰는 것과 같은 함수(PaperLedgerService — 목표 금액으로 살 수 있는 수량, 비용 원 미만 절사)로 셉니다.
                if (KrxCosts.affordableQty(BigDecimal.valueOf(amount), price, shares.rates()) < 1) {
                    return Verdict.reject(order, BUY_BELOW_ONE_SHARE, String.format(Locale.ROOT,
                            "매수 증가분 약 %s < 1주 체결 금액 %s(기준 가격 %s + 수수료·슬리피지) — 정수 주라 1주도 살 수 없음"
                                    + "(현재 %.2f%% → 목표 %.2f%%)", market.money().exact(amount),
                            market.money().exact(KrxCosts.oneShareOutflow(price, shares.rates()).doubleValue()),
                            market.money().exact(price.doubleValue()), now, target));
                }
            }
            return null;
        }

        /** MALFORMED 사유 문구. 모양이 맞으면 null. */
        private static String malformed(Proposed order, Market market) {
            String side = order.side();
            if (!BUY.equals(side) && !SELL.equals(side)) {
                return "side는 BUY 또는 SELL이어야 함: " + side;
            }
            String timing = order.timing();
            if (!accepts(market, timing)) {
                return "timing은 " + String.join(" 또는 ", market.timings()) + "여야 함: " + timing;
            }
            Double target = order.targetWeightPct();
            if (BUY.equals(side)) {
                if (target == null) {
                    return "매수에 targetWeightPct가 없음";
                }
                if (!Double.isFinite(target) || target < 0 || target > 100) {
                    return "targetWeightPct는 0~100이어야 함: " + target;
                }
                return null;
            }
            Double fraction = order.sellFraction();
            if (fraction == null) {
                if (target != null && !(target == 0.0)) {
                    // NaN도 여기로 옵니다(NaN == 0.0은 거짓) — 뜻을 모르는 숫자이므로 같이 거절합니다.
                    return "매도에 sellFraction 없이 targetWeightPct만 있음 — 비율 없는 매도는 장부가 전량으로 집행하므로 거절";
                }
                return null;
            }
            // 0을 받으면 장부의 '1주 미만이면 전량' 규칙과 만나 '안 팖'이 '전량 매도'로 뒤집힙니다(PaperLedger.sellQty).
            if (!Double.isFinite(fraction) || !(fraction > 0) || fraction > 1) {
                return "sellFraction은 0 초과 1 이하여야 함: " + fraction;
            }
            return null;
        }

        /** 보유 티커(티커 순). */
        private static TreeSet<String> heldTickers(Context ctx) {
            TreeSet<String> tickers = new TreeSet<>();
            for (String ticker : ctx.currentWeightPct().keySet()) {
                if (ticker != null && ctx.weightOf(ticker) != null) {
                    tickers.add(ticker);
                }
            }
            return tickers;
        }

        /** 받은 매도의 근거 문구 뒤 — 지금 체결할 수 없는 보유의 매도(한국 칸): 대기로 두고 같은 시점 매수의 자리를 만들지 않음. */
        static final String UNFILLABLE_SELL_NOTE = " — 지금 체결할 수 없어 대기(풀리면 그 뒤 체결) · 이번 매수의 현금·종목 자리를 만들지 않음";

        /** OVER_ALLOCATED 문구 뒤 — 지금 체결할 수 없는 매도가 있었으면 그 비중이 자리를 만들지 못했다고(없으면 빈 글자 — 미국 문구 그대로). */
        private static String blockedFreedNote(double pct) {
            return pct > WEIGHT_EPSILON
                    ? String.format(Locale.ROOT, " · 지금 체결할 수 없는 매도 %.2f%%p는 자리를 만들지 못함", pct) : "";
        }

        /** MAX_POSITIONS 문구 뒤 — 지금 체결할 수 없는 전량 매도가 있었으면 그 종목 수(없으면 빈 글자 — 미국 문구 그대로). */
        private static String blockedPositionsNote(int count) {
            return count > 0 ? " · 지금 체결할 수 없는 전량 매도 " + count + "종목은 자리를 비우지 못함" : "";
        }

        private static String monthlyDetail(Context ctx, Limits limits, int used) {
            return "이달 재량 주문 " + (ctx.monthlyOrdersSoFar() + used) + "건(이번 결정 " + used + "건 포함) — 상한 "
                    + limits.maxDiscretionaryOrdersPerMonth() + "건";
        }

        private static String sellDetail(Double weight, double fraction) {
            String held = weight == null ? "—" : String.format(Locale.ROOT, "%.2f%%", weight);
            if (fraction >= 1.0) {
                return "보유 " + held + " 전량 매도";
            }
            return String.format(Locale.ROOT, "보유 %s 중 %.0f%% 매도", held, fraction * 100.0);
        }

        private static String buyDetail(Double current, double target, double increment, double nav, Money money) {
            return String.format(Locale.ROOT, "현재 %.2f%% → 목표 %.2f%%(+%.2f%%p, 약 %s)",
                    current == null ? 0.0 : current, target, increment, money.rounded(increment / 100.0 * nav));
        }
    }
}
