package com.macrodash.feature.realtrade;

import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Day;
import com.macrodash.feature.realtrade.RealTradePlanner.Order;
import com.macrodash.feature.realtrade.RealTradePlanner.Pending;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Position;
import com.macrodash.feature.realtrade.RealTradePlanner.Quote;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;
import com.macrodash.feature.realtrade.RealTradePlanner.Window;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 실제 매매의 순수 계산({@link RealTradePlanner}, ADR 0028 — 명세 2026-11-06 §2·§3) — 비중 → 수량, 책에 없는 보유 전량 매도, 소수 부분, 반대 방향 건너뜀,
 * 상한가 현금 확인, 1건 상한, 임계값, 회전율, 순서, 창, 쉬는 날(11-19형 장 시간), 이중 매수 없음. 종목·금액은 모두 합성 값입니다.
 */
class RealTradePlannerTest {

    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final LocalDate DAY = LocalDate.of(2026, 11, 6);
    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";
    private static final String CASH_LIKE = "153130";
    private static final BigDecimal E = new BigDecimal("10000000");
    private static final Rules RULES = new Rules(new BigDecimal("99999999"), Set.of(CASH_LIKE), false, true);

    private static Instant kst(String local) {
        return LocalDateTime.parse(local).atZone(SEOUL).toInstant();
    }

    private static BigDecimal d(String value) {
        return new BigDecimal(value);
    }

    /** 계좌 짜기 — 현금, 보유(종목·수량·현재가), 시세(종목·현재가 — 상한가는 현재가 × 1.3), 매도 가능(보유 정수 그대로), 미체결. */
    private static final class Acct {
        BigDecimal cash = E;
        final Map<String, Position> positions = new HashMap<>();
        final Map<String, Quote> quotes = new HashMap<>();
        final Map<String, BigDecimal> sellable = new HashMap<>();
        final Map<String, Pending> pending = new HashMap<>();

        Acct cash(String value) {
            cash = d(value);
            return this;
        }

        Acct hold(String symbol, String qty, String price) {
            positions.put(symbol, new Position(symbol, "합성" + symbol, d(qty), d(price)));
            quote(symbol, price);
            sellable.put(symbol, d(qty).setScale(0, java.math.RoundingMode.FLOOR));
            return this;
        }

        Acct quote(String symbol, String price) {
            quotes.put(symbol, new Quote(d(price), d(price).multiply(d("1.3"))));
            return this;
        }

        Acct sellable(String symbol, String qty) {
            if (qty == null) {
                sellable.remove(symbol);
            } else {
                sellable.put(symbol, d(qty));
            }
            return this;
        }

        Acct pending(String symbol, String buy, String sell) {
            pending.put(symbol, new Pending(d(buy), d(sell), false));
            return this;
        }

        Account build() {
            return new Account(cash, positions, quotes, sellable, pending);
        }
    }

    private static Plan sync(Map<String, Double> weights, Account account) {
        return RealTradePlanner.sync(weights, E, account, Set.of(), BigDecimal.ZERO, RULES, true);
    }

    private static List<String> reasons(Plan plan) {
        return plan.skipped().stream().map(Skip::reason).toList();
    }

    // ------------------------------------------------------------------ 평가액
    @Test
    @DisplayName("운용 평가액 = 매수 가능 금액 + 보유 평가액(소수 보유 포함), 안전 상한을 넘으면 상한까지(나머지는 현금) — 보유 가격을 모르면 정하지 않음")
    void equity() {
        Account account = new Acct().cash("1000000").hold(A, "10.5", "70000").build();
        assertThat(RealTradePlanner.equity(account, null)).contains(d("1735000.0"));
        assertThat(RealTradePlanner.equity(account, d("1500000"))).contains(d("1500000"));

        Account unpriced = new Account(d("1000000"), Map.of(A, new Position(A, null, d("3"), null)), Map.of(), Map.of(), Map.of());
        assertThat(RealTradePlanner.equity(unpriced, null)).isEmpty();
    }

    @Test
    @DisplayName("안전 상한을 넘는 부분은 운용하지 않음 — 목표 수량이 상한 E 기준")
    void equityCapKeepsCash() {
        Account account = new Acct().cash("50000000").quote(A, "10000").build();
        BigDecimal capped = RealTradePlanner.equity(account, d("10000000")).orElseThrow();
        Plan plan = RealTradePlanner.sync(Map.of(A, 50.0), capped, account, Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(plan.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(500));
    }

    // ------------------------------------------------------------------ 비중 → 수량
    @Test
    @DisplayName("목표 수량 = floor(비중 × E ÷ 현재가), 보낼 수량 = 목표 − 보유 − 같은 방향 미체결")
    void weightToQuantity() {
        Plan plan = sync(Map.of(A, 25.0), new Acct().quote(A, "70000").build());
        assertThat(plan.orders()).singleElement().satisfies(o -> {
            assertThat(o.symbol()).isEqualTo(A);
            assertThat(o.side()).isEqualTo("BUY");
            assertThat(o.quantity()).isEqualTo(35);   // 2,500,000 / 70,000 = 35.7
            assertThat(o.refPrice()).isEqualByComparingTo("70000");
            assertThat(o.reserve()).isEqualByComparingTo("3185000");   // 35 × 상한가 91,000
        });

        Plan held = sync(Map.of(A, 25.0), new Acct().hold(A, "20", "70000").build());
        assertThat(held.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(15));

        Plan reduce = sync(Map.of(A, 10.0), new Acct().hold(A, "35", "70000").build());
        assertThat(reduce.orders()).singleElement().satisfies(o -> {
            assertThat(o.side()).isEqualTo("SELL");
            assertThat(o.quantity()).isEqualTo(21);   // 목표 14
        });
    }

    @Test
    @DisplayName("이중 매수 없음 — 같은 방향 미체결(앱 주문·먼저 낸 주문) 만큼 빼고, 이미 맞춘 보유는 0")
    void noDoubleBuy() {
        assertThat(sync(Map.of(A, 25.0), new Acct().quote(A, "70000").pending(A, "35", "0").build()).orders())
                .as("미체결 매수 35주가 이미 목표를 채움").isEmpty();
        assertThat(sync(Map.of(A, 25.0), new Acct().hold(A, "35", "70000").build()).orders()).as("이미 맞춘 보유").isEmpty();
        // 모의가 어제 주문을 체결하지 못하고 오늘 같은 비중으로 다시 사도(목표 비중 그대로) 실제 보유가 이미 목표면 추가 0.
        Account matched = new Acct().cash("7550000").hold(A, "35", "70000").build();
        BigDecimal equity = RealTradePlanner.equity(matched, null).orElseThrow();
        assertThat(RealTradePlanner.sync(Map.of(A, 25.0), equity, matched, Set.of(), BigDecimal.ZERO, RULES, true).orders()).isEmpty();
        assertThat(RealTradePlanner.mirror(A, "BUY", 25.0, equity, matched, Set.of(), BigDecimal.ZERO, RULES).orders())
                .as("장중 재매수 주문도 실제 추가 0").isEmpty();
    }

    @Test
    @DisplayName("책에 없는 보유는 1% 조건 없이 전량 매도, 소수점 보유의 소수 부분은 팔지 않고 표시")
    void notInBookSellsAll() {
        Plan small = sync(Map.of(), new Acct().hold(C, "3", "1000").build());
        assertThat(small.orders()).singleElement().satisfies(o -> {
            assertThat(o.side()).isEqualTo("SELL");
            assertThat(o.quantity()).isEqualTo(3);   // 3,000원 — E의 1%(100,000원) 아래여도 판다
        });

        Plan fractional = sync(Map.of(), new Acct().hold(C, "10.5", "1000").build());
        assertThat(fractional.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(10));
        assertThat(reasons(fractional)).contains(RealTradePlanner.SKIP_FRACTION);

        Plan onlyFraction = sync(Map.of(), new Acct().hold(C, "0.4", "1000").build());
        assertThat(onlyFraction.orders()).isEmpty();
        assertThat(reasons(onlyFraction)).containsExactly(RealTradePlanner.SKIP_FRACTION);
    }

    @Test
    @DisplayName("매도는 매도 가능 수량까지, 모르면(실제 주문) 팔지 않음 — 켜기 창 예상은 정수 보유로 어림")
    void sellableBounds() {
        Plan bounded = sync(Map.of(), new Acct().hold(C, "10", "1000").sellable(C, "4").build());
        assertThat(bounded.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(4));

        Account unknown = new Acct().hold(C, "10", "1000").sellable(C, null).build();
        Plan strict = sync(Map.of(), unknown);
        assertThat(strict.orders()).isEmpty();
        assertThat(reasons(strict)).containsExactly(RealTradePlanner.SKIP_SELLABLE);

        Rules preview = new Rules(RULES.maxOrderKrw(), RULES.cashLike(), false, false);
        Plan estimate = RealTradePlanner.sync(Map.of(), E, unknown, Set.of(), BigDecimal.ZERO, preview, true);
        assertThat(estimate.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(10));
    }

    @Test
    @DisplayName("반대 방향 미체결(앱 주문 포함)이 있는 종목은 건너뜀(사용자 주문을 취소하지 않음), 이 기능의 미종료 주문이 있는 종목은 새 주문 금지")
    void skipsPendingConflicts() {
        Plan opposite = sync(Map.of(A, 25.0), new Acct().quote(A, "70000").pending(A, "0", "5").build());
        assertThat(opposite.orders()).isEmpty();
        assertThat(reasons(opposite)).containsExactly(RealTradePlanner.SKIP_OPPOSITE);

        Plan oppositeSell = sync(Map.of(), new Acct().hold(C, "10", "1000").pending(C, "2", "0").build());
        assertThat(oppositeSell.orders()).isEmpty();
        assertThat(reasons(oppositeSell)).containsExactly(RealTradePlanner.SKIP_OPPOSITE);

        Plan own = RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().quote(A, "70000").build(), Set.of(A), BigDecimal.ZERO, RULES,
                true);
        assertThat(own.orders()).isEmpty();
        assertThat(reasons(own)).containsExactly(RealTradePlanner.SKIP_OWN);
    }

    @Test
    @DisplayName("매수 금액 확인 — 수량 × 상한가 ≤ 매수 가능 금액 − 같은 창에서 이미 잡은 상한가 합, 모자라면 줄이고 1주도 안 되면 미룸")
    void upperLimitCashCheck() {
        Plan reduced = sync(Map.of(A, 25.0), new Acct().cash("1000000").quote(A, "70000").build());
        assertThat(reduced.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(10));   // 1,000,000 / 91,000

        Plan deferred = sync(Map.of(A, 25.0), new Acct().cash("50000").quote(A, "70000").build());
        assertThat(deferred.orders()).isEmpty();
        assertThat(reasons(deferred)).containsExactly(RealTradePlanner.SKIP_DEFERRED_CASH);

        Plan reserved = RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().cash("1000000").quote(A, "70000").build(), Set.of(),
                d("819000"), RULES, true);
        assertThat(reserved.orders()).as("이미 잡은 819,000원을 빼면 1주(91,000원)만").singleElement()
                .satisfies(o -> assertThat(o.quantity()).isEqualTo(1));
    }

    @Test
    @DisplayName("1건 상한을 넘으면 쪼개지 않고 상한까지만(capped) — 매수는 상한가, 매도는 현재가 기준")
    void orderCap() {
        Rules capped = new Rules(d("1000000"), Set.of(), false, true);
        Plan buy = RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().quote(A, "70000").build(), Set.of(), BigDecimal.ZERO, capped, true);
        assertThat(buy.orders()).singleElement().satisfies(o -> {
            assertThat(o.quantity()).isEqualTo(10);   // 1,000,000 / 91,000
            assertThat(o.capped()).isTrue();
        });
        assertThat(reasons(buy)).containsExactly(RealTradePlanner.SKIP_CAPPED);

        Plan sell = RealTradePlanner.sync(Map.of(), E, new Acct().hold(C, "30", "70000").build(), Set.of(), BigDecimal.ZERO, capped, true);
        assertThat(sell.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(13));   // 1,000,000 / (70,000 × 1.03)
    }

    @Test
    @DisplayName("1건 상한에 맞춘 매도는 가격 여유를 둠 — 보내기 직전 현재가가 몇 틱 올라도 수량 × 전송가 ≤ 1건 상한(수집기 over-order-limit 없음)")
    void sellCapPriceMargin() {
        Rules capped = new Rules(d("10000000"), Set.of(), false, true);
        Plan sell = RealTradePlanner.sync(Map.of(), E, new Acct().hold(C, "3000", "5000").build(), Set.of(), BigDecimal.ZERO, capped, true);
        assertThat(sell.orders()).singleElement().satisfies(o -> {
            assertThat(o.capped()).isTrue();
            // 예전 계산 floor(10,000,000 / 5,000) = 2,000주는 한 틱(10원)만 올라도 2,000 × 5,010 = 10,020,000 > 1건 상한
            BigDecimal sentPrice = d("5100");   // 계획가보다 10틱 위
            assertThat(sentPrice.multiply(BigDecimal.valueOf(o.quantity()))).isLessThanOrEqualTo(d("10000000"));
            assertThat(o.quantity()).isEqualTo(1941);   // floor(10,000,000 / 5,150)
        });
    }

    @Test
    @DisplayName("시가 맞추기 임계값 — 차이가 1주 이상이고 E의 1% 이상일 때만(장중 따라 하기는 1% 조건 없음)")
    void syncThreshold() {
        // 목표 35주(25%), 보유 34주 → 1주 70,000원 < E의 1%(100,000원)
        assertThat(sync(Map.of(A, 25.0), new Acct().hold(A, "34", "70000").build()).orders()).isEmpty();
        // 보유 33주 → 2주 140,000원 ≥ 100,000원
        assertThat(sync(Map.of(A, 25.0), new Acct().hold(A, "33", "70000").build()).orders()).singleElement()
                .satisfies(o -> assertThat(o.quantity()).isEqualTo(2));
        // 임계값을 끄면(계산만) 1주도 보냄
        assertThat(RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().hold(A, "34", "70000").build(), Set.of(), BigDecimal.ZERO,
                RULES, false).orders()).hasSize(1);
        // 장중 따라 하기는 1주면 보냄
        assertThat(RealTradePlanner.mirror(A, "BUY", 25.0, E, new Acct().hold(A, "34", "70000").build(), Set.of(), BigDecimal.ZERO,
                RULES).orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(1));
    }

    @Test
    @DisplayName("회전율 — 묶음의 매수 + 매도 금액 합이 E의 60%를 넘으면 초과")
    void turnover() {
        Plan heavy = sync(Map.of(A, 70.0), new Acct().quote(A, "10000").build());
        assertThat(heavy.turnoverPct()).isEqualByComparingTo("70.00");
        assertThat(heavy.turnoverExceeded()).isTrue();

        Plan light = sync(Map.of(A, 50.0), new Acct().quote(A, "10000").build());
        assertThat(light.turnoverPct()).isEqualByComparingTo("50.00");
        assertThat(light.turnoverExceeded()).isFalse();

        Plan swap = sync(Map.of(A, 35.0), new Acct().cash("6500000").hold(C, "350", "10000").quote(A, "10000").build());
        assertThat(swap.turnoverPct()).as("매도 35% + 매수 35%").isEqualByComparingTo("70.00");
        assertThat(swap.turnoverExceeded()).isTrue();
    }

    @Test
    @DisplayName("QA-302: 이상 멈춤용 회전율 — 대기 STOP 종목의 매도와, 그 스탑 매도 금액까지의 현금성 매수를 뺌(주문은 그대로, 스탑이 없으면 같은 계획)")
    void turnoverWithoutStops() {
        Map<String, Double> weights = Map.of(CASH_LIKE, 90.0);
        Account account = new Acct().cash("1000000").hold(A, "100", "50000").hold(B, "200", "20000").quote(CASH_LIKE, "10000").build();
        Plan plan = sync(weights, account);
        assertThat(plan.turnoverPct()).as("A 50% + B 40% + 현금성 90%").isEqualByComparingTo("180.00");

        Plan both = RealTradePlanner.withoutStops(plan, weights, account, Set.of(), RULES, true, Set.of(A, B), null);
        assertThat(both.turnoverPct()).as("스탑 90% + 그 대금의 현금성 90%").isEqualByComparingTo("0.00");
        assertThat(both.turnoverExceeded()).isFalse();
        assertThat(both.orders()).isEqualTo(plan.orders());
        assertThat(both.skipped()).isEqualTo(plan.skipped());

        Plan one = RealTradePlanner.withoutStops(plan, weights, account, Set.of(), RULES, true, Set.of(A), null);
        assertThat(one.turnoverPct()).as("180 − 스탑 50 − 현금성 중 50 — 스탑이 아닌 B와 그 대금의 현금성은 셈").isEqualByComparingTo("80.00");
        assertThat(one.turnoverExceeded()).isTrue();

        assertThat(RealTradePlanner.withoutStops(plan, weights, account, Set.of(), RULES, true, Set.of(), null)).isSameAs(plan);

        // 아직 목표에 남아 사는 쪽인 스탑 종목(그 뒤 시각의 STOP)은 빼지 않음 — A 목표 60%(120주)라 20주 매수, B 매도 40%
        Map<String, Double> later = Map.of(A, 60.0);
        Plan buying = sync(later, account);
        assertThat(RealTradePlanner.withoutStops(buying, later, account, Set.of(), RULES, true, Set.of(A), null).turnoverPct())
                .isEqualByComparingTo(buying.turnoverPct()).isEqualByComparingTo("50.00");

        // 스탑 매도 경로가 묶음보다 먼저 판 스탑 종목(이 기능 주문 진행 중 — blocked)은 계획의 회전율에 없음 — 그 대금(stopProceeds)까지 현금성 매수를 뺌
        Plan blocked = RealTradePlanner.sync(weights, E, account, Set.of(A, B), BigDecimal.ZERO, RULES, true);
        assertThat(blocked.turnoverPct()).as("현금성 90%만").isEqualByComparingTo("90.00");
        assertThat(RealTradePlanner.withoutStops(blocked, weights, account, Set.of(A, B), RULES, true, Set.of(A, B), null).turnoverPct())
                .as("계획 밖 스탑 대금을 모르면 현금성은 그대로").isEqualByComparingTo("90.00");
        assertThat(RealTradePlanner.withoutStops(blocked, weights, account, Set.of(A, B), RULES, true, Set.of(A, B), d("9000000"))
                .turnoverPct()).as("먼저 판 스탑 900만 원까지 현금성 매수를 뺌").isEqualByComparingTo("0.00");
        Plan halfBlocked = RealTradePlanner.sync(weights, E, account, Set.of(A), BigDecimal.ZERO, RULES, true);
        assertThat(RealTradePlanner.withoutStops(halfBlocked, weights, account, Set.of(A), RULES, true, Set.of(A, B), d("5000000"))
                .turnoverPct()).as("130 − 스탑 B 40 − 현금성 중 (B 40 + 먼저 판 A 50)").isEqualByComparingTo("0.00");
        assertThat(RealTradePlanner.withoutStops(halfBlocked, weights, account, Set.of(A), RULES, true, Set.of(B), null).turnoverPct())
                .as("A가 스탑이 아니면 130 − 40 − 40").isEqualByComparingTo("50.00");
    }

    @Test
    @DisplayName("한 창 안 순서 — 매도(현금성 먼저) → 매수(현금성 마지막)")
    void ordering() {
        Account account = new Acct().cash("10000000").hold(C, "10", "1000").hold(CASH_LIKE, "10", "100000").quote(A, "10000")
                .quote(B, "10000").build();
        Plan plan = RealTradePlanner.sync(Map.of(A, 20.0, B, 20.0, CASH_LIKE, 30.0), E, account, Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(plan.orders()).extracting(Order::symbol).containsExactly(C, B, A, CASH_LIKE);
        Plan sells = sync(Map.of(), account);
        assertThat(sells.orders()).extracting(Order::symbol).containsExactly(CASH_LIKE, C);
        assertThat(sells.orders()).allMatch(o -> o.side().equals("SELL"));
    }

    @Test
    @DisplayName("범위(scope) — 범위 밖 보유는 '책에 없는 보유'로 팔지 않고 건너뜀도 남기지 않음, 범위 안 종목만 맞춤")
    void scopeLimitsSymbols() {
        Account account = new Acct().cash("3000000").hold(C, "40", "20000").quote(A, "70000").build();
        Plan all = RealTradePlanner.sync(Map.of(A, 25.0), E, account, Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(all.orders()).extracting(Order::symbol).containsExactly(C, A);
        Plan scoped = RealTradePlanner.sync(Map.of(A, 25.0), E, account, Set.of(), BigDecimal.ZERO, RULES, true, Set.of(A), null);
        assertThat(scoped.orders()).extracting(Order::symbol).containsExactly(A);
        assertThat(scoped.skipped()).isEmpty();
    }

    @Test
    @DisplayName("QA-376 고정: 범위를 전량 매도 대상으로 좁힌 계획의 회전율 금액 = 정수 보유 × 현재가 — 매도 가능 수량을 몰라 주문은 못 내도 세고, "
            + "이 기능 주문 진행 중이면 0. 책 밖 보유는 1% 문턱이 없지만 비중 0을 비중 맵에 넣으면 문턱에 걸린다(묶음의 비중 0 표시는 범위로만)")
    void scopedLiquidationTurnover() {
        // 묶음의 회전율 보완(RealTradeJob.withWaitingLiquidations)이 부르는 모양 — 책 A 10%(목표대로), 책에 없는 C 175주 × 40,000 = 700만
        Account account = new Acct().cash("0").hold(A, "20", "50000").hold(C, "175", "40000").sellable(C, null).build();
        Plan waiting = RealTradePlanner.sync(Map.of(A, 10.0), E, account, Set.of(), BigDecimal.ZERO, RULES, true, Set.of(C), null);
        assertThat(waiting.turnoverAmount()).isEqualByComparingTo("7000000");
        assertThat(waiting.turnoverPct()).isEqualByComparingTo("70.00");
        assertThat(waiting.orders()).as("매도 가능 수량을 묻지 않은 종목 — 주문은 없음").isEmpty();
        assertThat(reasons(waiting)).containsExactly(RealTradePlanner.SKIP_SELLABLE);

        Plan own = RealTradePlanner.sync(Map.of(A, 10.0), E, account, Set.of(C), BigDecimal.ZERO, RULES, true, Set.of(C), null);
        assertThat(own.turnoverAmount()).as("이 기능의 주문이 진행 중인 종목은 세지 않음").isEqualByComparingTo("0");

        // C 1주 = 4만 원 < E의 1%(10만 원)
        Account tiny = new Acct().hold(C, "1", "40000").build();
        Plan outOfBook = RealTradePlanner.sync(Map.of(), E, tiny, Set.of(), BigDecimal.ZERO, RULES, true, Set.of(C), null);
        assertThat(outOfBook.orders()).singleElement().satisfies(o -> {
            assertThat(o.side()).isEqualTo("SELL");
            assertThat(o.quantity()).isEqualTo(1);
        });
        assertThat(outOfBook.turnoverAmount()).isEqualByComparingTo("40000");
        Plan zeroWeight = RealTradePlanner.sync(Map.of(C, 0.0), E, tiny, Set.of(), BigDecimal.ZERO, RULES, true, Set.of(C), null);
        assertThat(zeroWeight.orders()).as("비중 값이 있으면 책의 종목 — 1% 문턱에 걸려 팔리지 않음").isEmpty();
        assertThat(zeroWeight.turnoverAmount()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("보낼 수 있는 종목(sendable)에만 현금 배정 — 시도를 다 쓴 종목이 현금을 먼저 잡아 뒤 순서 매수(현금성)가 미뤄지지 않음")
    void sendableGetsCash() {
        Account account = new Acct().cash("1000000").quote(A, "70000").quote(CASH_LIKE, "100000").build();
        Map<String, Double> weights = Map.of(A, 50.0, CASH_LIKE, 10.0);
        Plan all = RealTradePlanner.sync(weights, E, account, Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(all.orders()).extracting(Order::symbol).containsExactly(A);   // A 10주(910,000원)가 현금을 먼저 잡음
        assertThat(reasons(all)).contains(RealTradePlanner.SKIP_DEFERRED_CASH);

        Plan onlyCash = RealTradePlanner.sync(weights, E, account, Set.of(), BigDecimal.ZERO, RULES, true, null, Set.of(CASH_LIKE));
        assertThat(onlyCash.orders()).singleElement().satisfies(o -> {
            assertThat(o.symbol()).isEqualTo(CASH_LIKE);
            assertThat(o.quantity()).isEqualTo(7);   // 1,000,000 / 상한가 130,000
        });
        assertThat(onlyCash.turnoverAmount()).as("회전율은 거르기 전 값").isEqualByComparingTo(all.turnoverAmount());
    }

    @Test
    @DisplayName("하루 한도 — 남은 건수만큼만(나머지는 deferred-daily-cap), 매수는 상한가 × 수량을 남은 하루 매수 금액 안으로")
    void dailyCaps() {
        Account account = new Acct().cash("10000000").hold(C, "10", "1000").quote(A, "70000").quote(B, "10000").build();
        Map<String, Double> weights = Map.of(A, 20.0, B, 20.0);
        Plan oneLeft = RealTradePlanner.sync(weights, E, account, Set.of(), BigDecimal.ZERO, RULES.withDaily(1, null), true);
        assertThat(oneLeft.orders()).extracting(Order::symbol).containsExactly(C);   // 매도 먼저
        assertThat(oneLeft.skipped()).filteredOn(s -> s.reason().equals(RealTradePlanner.SKIP_DAILY_CAP)).extracting(Skip::symbol)
                .containsExactlyInAnyOrder(A, B);

        Plan budget = RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().quote(A, "70000").build(), Set.of(), BigDecimal.ZERO,
                RULES.withDaily(null, d("1000000")), true);
        assertThat(budget.orders()).singleElement().satisfies(o -> assertThat(o.quantity()).isEqualTo(10));   // 1,000,000 / 91,000
        assertThat(reasons(budget)).containsExactly(RealTradePlanner.SKIP_DAILY_CAP);

        Plan none = RealTradePlanner.sync(Map.of(A, 25.0), E, new Acct().quote(A, "70000").build(), Set.of(), BigDecimal.ZERO,
                RULES.withDaily(null, d("50000")), true);
        assertThat(none.orders()).isEmpty();
        assertThat(reasons(none)).containsExactly(RealTradePlanner.SKIP_DAILY_CAP);

        assertThat(RealTradePlanner.mirror(A, "BUY", 25.0, E, new Acct().quote(A, "70000").build(), Set.of(), BigDecimal.ZERO,
                RULES.withDaily(0, null)).orders()).as("장중 따라 하기도 같음").isEmpty();
    }

    @Test
    @DisplayName("하루 한도 사용량 — 수집기와 같은 식(국내 주문 수, 매도 아닌 주문의 체결 금액 + 진행 중 잔량 × 상한가), 못 읽는 값이 있으면 모름")
    void dailyUsage() {
        List<CollectorTradeClient.BrokerOrder> today = List.of(
                todayOrder("t1", A, "SELL", "5", "5", "70000", null, "KRW"),               // 건수만
                todayOrder("t2", A, "BUY", "10", "10", "70000", null, "KRW"),              // 체결 700,000
                todayOrder("t3", B, "BUY", "10", "4", null, "40000", "KRW"),              // 체결 금액 40,000 + 잔량 6 × 13,000(진행 중)
                todayOrder("t4", C, null, "2", "0", null, null, "KRW"),                   // 방향 모름 → 매수로 셈, 잔량 2 × 1,300(진행 중)
                todayOrder("t5", A, "BUY", "1", "1", "70000", null, "USD"));              // 국내 아님
        Set<String> open = Set.of("t3", "t4");
        Map<String, BigDecimal> uppers = Map.of(B, d("13000"), C, d("1300"));
        assertThat(RealTradePlanner.dailyUpperSymbols(today, open)).containsExactlyInAnyOrder(B, C);
        RealTradePlanner.DailyUsage usage = RealTradePlanner.dailyUsage(today, open, uppers::get).orElseThrow();
        assertThat(usage.orders()).isEqualTo(4);
        assertThat(usage.buyKrw()).isEqualByComparingTo("820600");   // 700,000 + 40,000 + 78,000 + 2,600

        assertThat(RealTradePlanner.dailyUsage(today, open, Map.of(B, d("13000"))::get)).as("진행 중 매수의 상한가 모름").isEmpty();
        assertThat(RealTradePlanner.dailyUsage(List.of(todayOrder("t6", A, "BUY", "3", "3", null, null, "KRW")), Set.of(), s -> null))
                .as("체결 금액을 셀 수 없음").isEmpty();
    }

    @Test
    @DisplayName("QA-413: 하루 한도 사용량 — 상한가를 물을 길이 없는 종목(형식 밖 코드)의 진행 중 매수는 건수와 체결 금액만 세고 '매수 금액 모름'을 켠다(예전: 셈 전체 실패)")
    void dailyUsageWithUnpriceableOpenBuy() {
        String odd = "Q500001";   // 합성 — 국내 종목 코드 모양(6자)이 아님
        List<CollectorTradeClient.BrokerOrder> today = List.of(
                todayOrder("t1", A, "SELL", "5", "5", "70000", null, "KRW"),
                todayOrder("t2", A, "BUY", "10", "10", "70000", null, "KRW"),              // 체결 700,000
                todayOrder("t3", odd, "BUY", "10", "4", null, "40000", "KRW"),            // 체결 금액 40,000 + 잔량 6주(금액 모름, 진행 중)
                todayOrder("t4", B, "BUY", "10", "0", null, "0", "KRW"));                  // 잔량 10 × 13,000(진행 중)
        Set<String> open = Set.of("t3", "t4");
        assertThat(RealTradePlanner.krSymbol(odd)).isFalse();
        assertThat(RealTradePlanner.dailyUpperSymbols(today, open)).containsExactlyInAnyOrder(odd, B);

        assertThat(RealTradePlanner.dailyUsage(today, open, Map.of(B, d("13000"))::get)).as("예전 식 — 그 종목의 상한가가 없으면 셈 전체가 모름").isEmpty();

        RealTradePlanner.DailyUsage usage = RealTradePlanner.dailyUsage(today, open, Map.of(B, d("13000"))::get, Set.of(odd)).orElseThrow();
        assertThat(usage.orders()).as("건수는 그 주문도 그대로 셈").isEqualTo(4);
        assertThat(usage.buyUnknown()).isTrue();
        assertThat(usage.buyKrw()).as("하한 — 그 주문의 잔량 금액이 빠져 있음").isEqualByComparingTo("870000");   // 700,000 + 40,000 + 130,000

        // 형식에 맞는 종목의 상한가를 모르는 것은 지금처럼 셈 전체가 모름(물으면 알 수 있는 값을 어림하지 않음)
        assertThat(RealTradePlanner.dailyUsage(today, open, s -> null, Set.of(odd))).isEmpty();
        // 그 주문이 끝나면(미체결 목록에 없음) 체결 금액으로 정확히 셈
        RealTradePlanner.DailyUsage closed = RealTradePlanner.dailyUsage(today, Set.of("t4"), Map.of(B, d("13000"))::get, Set.of()).orElseThrow();
        assertThat(closed.buyUnknown()).isFalse();
        assertThat(closed.buyKrw()).isEqualByComparingTo("870000");
    }

    @Test
    @DisplayName("RT3-BE-4: 미체결 매수가 잡은 금액 — 토스 미체결 목록(앱 주문 포함)의 국내 매수(방향 모름 포함) 남은 수량 × 상한가, 수량·상한가를 모르면 모름")
    void openBuyHold() {
        List<CollectorTradeClient.BrokerOrder> open = List.of(
                todayOrder("o1", A, "BUY", "10", "4", null, null, "KRW"),                // 남은 6 × 91,000
                todayOrder("o2", B, "SELL", "5", "0", null, null, "KRW"),               // 매도 — 매수 가능 금액을 잡지 않음
                todayOrder("o3", C, null, "2", null, null, null, "KRW"),                // 방향 모름 → 매수로 셈, 체결 수량 없음 → 남은 2 × 1,300
                todayOrder("o4", A, "BUY", "3", "3", null, null, "KRW"),                // 남은 0
                todayOrder("o5", B, "BUY", "1", "0", null, null, "USD"));               // 국내 아님
        Map<String, BigDecimal> uppers = Map.of(A, d("91000"), C, d("1300"));
        assertThat(RealTradePlanner.openBuySymbols(open)).containsExactlyInAnyOrder(A, C);
        assertThat(RealTradePlanner.openBuyHold(open, uppers::get)).hasValueSatisfying(v -> assertThat(v).isEqualByComparingTo("548600"));
        assertThat(RealTradePlanner.openBuyHold(List.of(), s -> null)).hasValueSatisfying(v -> assertThat(v).isEqualByComparingTo("0"));
        assertThat(RealTradePlanner.openBuyHold(open, Map.of(A, d("91000"))::get)).as("상한가 모름").isEmpty();
        CollectorTradeClient.BrokerOrder noQuantity = new CollectorTradeClient.BrokerOrder("o6", A, "BUY", "LIMIT", "DAY", "PENDING", null,
                null, null, null, null, null, Instant.EPOCH, null, null, "KRW");
        assertThat(RealTradePlanner.openBuyHold(List.of(noQuantity), uppers::get)).as("수량 모름").isEmpty();
    }

    @Test
    @DisplayName("QA-379: 손실 판정에 되돌리는 '이 기능 밖' 미체결 매수 — 시장가는 상한가, 지정가는 하한가, 모르는 것·이미 센 주문·매도·외화는 되돌리지 않는다")
    void otherOpenBuyHoldFloor() {
        Map<String, BigDecimal> uppers = Map.of(A, d("91000"), B, d("26000"));
        Map<String, BigDecimal> lowers = Map.of(A, d("49000"), B, d("14000"));
        List<CollectorTradeClient.BrokerOrder> open = List.of(
                typed("m1", A, "BUY", "MARKET", "10", "4", "KRW"),      // 시장가 — 남은 6 × 상한가 91,000 = 546,000
                typed("l1", B, "BUY", "LIMIT", "100", "0", "KRW"),      // 지정가 — 100 × 하한가 14,000 = 1,400,000
                typed("own", A, "BUY", "MARKET", "40", "0", "KRW"),     // 이 기능의 행으로 이미 셈
                typed("s1", B, "SELL", "MARKET", "5", "0", "KRW"),      // 매도 — 매수 가능 금액을 잡지 않음
                typed("u1", A, null, "MARKET", "2", "0", "KRW"),        // 방향 모름 — 되돌리지 않음(기준 U0 쪽 openBuyHold와 반대)
                typed("f1", A, "BUY", "MARKET", "3", "3", "KRW"),       // 남은 0
                typed("x1", B, "BUY", "MARKET", "1", "0", "USD"),       // 국내 아님
                typed("n1", C, "BUY", "MARKET", "7", "0", "KRW"),       // 상한가 모름 — 되돌리지 않음
                typed("t1", B, "BUY", null, "10", "0", "KRW"),          // 유형 모름 — 지정가처럼 하한가 = 140,000
                typed(null, A, "BUY", "MARKET", "9", "0", "KRW"),       // 주문 번호 없음 — 이 기능의 주문인지 알 수 없어 되돌리지 않음
                new CollectorTradeClient.BrokerOrder("q1", A, "BUY", "MARKET", "DAY", "PENDING", null, null, null, null, null, null,
                        Instant.EPOCH, null, null, "KRW"),              // 수량 모름
                new CollectorTradeClient.BrokerOrder("q2", A, "BUY", "MARKET", "DAY", "PENDING", d("5"), null, null, null, null, null,
                        Instant.EPOCH, null, null, "KRW"));             // 체결 수량 모름 — 남은 수량을 크게 잡지 않음

        assertThat(RealTradePlanner.otherOpenBuyHoldFloor(open, Set.of("own"), uppers::get, lowers::get))
                .isEqualByComparingTo("2086000");
        assertThat(RealTradePlanner.otherOpenBuyHoldFloor(open, Set.of("own"), uppers::get, s -> null)).as("하한가를 모르면 지정가는 0")
                .isEqualByComparingTo("546000");
        assertThat(RealTradePlanner.otherOpenBuyHoldFloor(List.of(), Set.of(), uppers::get, lowers::get)).isEqualByComparingTo("0");
        List<CollectorTradeClient.BrokerOrder> pair = List.of(open.get(0), open.get(1));
        assertThat(RealTradePlanner.otherOpenBuyHoldFloor(pair, Set.of(), uppers::get, lowers::get))
                .as("같은 주문이면 기준 쪽(openBuyHold — 전부 상한가, 3,146,000)보다 크지 않음 — 판정값이 기준보다 부풀지 않게")
                .isEqualByComparingTo("1946000")
                .isLessThanOrEqualTo(RealTradePlanner.openBuyHold(pair, uppers::get).orElseThrow());
    }

    private static CollectorTradeClient.BrokerOrder typed(String id, String symbol, String side, String orderType, String qty, String filled,
                                                          String currency) {
        return new CollectorTradeClient.BrokerOrder(id, symbol, side, orderType, "DAY", "PENDING", d(qty), d(filled), null, null, null, null,
                Instant.EPOCH, null, null, currency);
    }

    @Test
    @DisplayName("매도 가능 수량을 물을 종목 — 계획의 매도와 매도 가능 수량을 몰라 건너뛴 종목만")
    void sellSymbolsForSecondRead() {
        Account account = new Acct().cash("10000000").hold(C, "10", "1000").hold(B, "100", "10000").sellable(B, null).quote(A, "70000")
                .build();
        Plan probe = RealTradePlanner.sync(Map.of(A, 25.0), E, account, Set.of(), BigDecimal.ZERO, RULES.withRequireSellable(false), true);
        assertThat(RealTradePlanner.sellSymbols(probe)).containsExactlyInAnyOrder(B, C);
        Plan strict = RealTradePlanner.sync(Map.of(A, 25.0), E, account, Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(RealTradePlanner.sellSymbols(strict)).containsExactlyInAnyOrder(B, C);
        assertThat(strict.orders()).extracting(Order::symbol).containsExactly(C, A);
    }

    private static CollectorTradeClient.BrokerOrder todayOrder(String id, String symbol, String side, String qty, String filled,
                                                               String avgPrice, String filledAmount, String currency) {
        return new CollectorTradeClient.BrokerOrder(id, symbol, side, "MARKET", "DAY", "PENDING", d(qty), filled == null ? null : d(filled),
                avgPrice == null ? null : d(avgPrice), filledAmount == null ? null : d(filledAmount), null, null, Instant.EPOCH, null, null,
                currency);
    }

    @Test
    @DisplayName("손실 한도(매수 멈춤)면 매수만 빼고 매도는 그대로")
    void buysPaused() {
        Rules paused = new Rules(RULES.maxOrderKrw(), RULES.cashLike(), true, true);
        Account account = new Acct().hold(C, "10", "1000").quote(A, "70000").build();
        Plan plan = RealTradePlanner.sync(Map.of(A, 25.0), E, account, Set.of(), BigDecimal.ZERO, paused, true);
        assertThat(plan.orders()).extracting(Order::side).containsExactly("SELL");
        assertThat(reasons(plan)).contains(RealTradePlanner.SKIP_BUYS_PAUSED);
        assertThat(RealTradePlanner.mirror(A, "BUY", 25.0, E, account, Set.of(), BigDecimal.ZERO, paused).orders()).isEmpty();
    }

    // ------------------------------------------------------------------ 장중 따라 하기
    @Test
    @DisplayName("장중 따라 하기는 원 주문 방향으로만 — 매수 주문인데 넘치면 0, 매도 주문 w* = 0이면 정수 보유 전량")
    void mirrorDirection() {
        Account over = new Acct().hold(A, "50", "70000").build();
        assertThat(RealTradePlanner.mirror(A, "BUY", 25.0, E, over, Set.of(), BigDecimal.ZERO, RULES).orders()).as("매수 주문 — 줄이지 않음")
                .isEmpty();
        assertThat(RealTradePlanner.mirror(A, "SELL", 25.0, E, over, Set.of(), BigDecimal.ZERO, RULES).orders()).singleElement()
                .satisfies(o -> {
                    assertThat(o.side()).isEqualTo("SELL");
                    assertThat(o.quantity()).isEqualTo(15);
                });
        Account under = new Acct().hold(A, "10", "70000").build();
        assertThat(RealTradePlanner.mirror(A, "SELL", 25.0, E, under, Set.of(), BigDecimal.ZERO, RULES).orders()).as("매도 주문 — 늘리지 않음")
                .isEmpty();
        Account fractional = new Acct().hold(A, "12.7", "70000").build();
        assertThat(RealTradePlanner.mirror(A, "SELL", 0.0, E, fractional, Set.of(), BigDecimal.ZERO, RULES).orders()).singleElement()
                .satisfies(o -> assertThat(o.quantity()).isEqualTo(12));
    }

    @Test
    @DisplayName("계좌 옮기기 — 미체결 잔량은 수량 − 체결, 방향·수량을 모르는 주문이 있으면 그 종목은 잔량 모름(건너뜀)")
    void accountFromCollector() {
        CollectorTradeClient.Preflight preflight = new CollectorTradeClient.Preflight(Instant.EPOCH, d("1000000"),
                List.of(new CollectorTradeClient.Holding(A, "합성", d("3"), d("70000"))),
                Map.of(A, new CollectorTradeClient.Quote(d("70000"), d("91000"), d("49000"))), Map.of(A, d("3")));
        List<CollectorTradeClient.BrokerOrder> open = List.of(
                broker(A, "BUY", "10", "4"), broker(B, null, "5", null), broker(C, "SELL", null, null));
        Account account = RealTradePlanner.account(preflight, open);
        assertThat(account.pendingOf(A).buy()).isEqualByComparingTo("6");
        assertThat(account.pendingOf(A).unknown()).isFalse();
        assertThat(account.pendingOf(B).unknown()).isTrue();
        assertThat(account.pendingOf(C).unknown()).isTrue();
        Plan unknown = RealTradePlanner.sync(Map.of(B, 10.0), E, new Account(E, Map.of(), Map.of(B, new Quote(d("10000"), d("13000"))),
                Map.of(), Map.of(B, new Pending(BigDecimal.ZERO, BigDecimal.ZERO, true))), Set.of(), BigDecimal.ZERO, RULES, true);
        assertThat(unknown.orders()).isEmpty();
        assertThat(reasons(unknown)).containsExactly(RealTradePlanner.SKIP_PENDING_UNKNOWN);
    }

    private static CollectorTradeClient.BrokerOrder broker(String symbol, String side, String qty, String filled) {
        return new CollectorTradeClient.BrokerOrder("o-" + symbol, symbol, side, "MARKET", "DAY", "PENDING", qty == null ? null : d(qty),
                filled == null ? null : d(filled), null, null, null, null, Instant.EPOCH, null, null, "KRW");
    }

    // ------------------------------------------------------------------ 창
    private static CollectorTradeClient.Session normalSession() {
        return new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), kst("2026-11-06T08:50"), kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), kst("2026-11-06T15:20"), kst("2026-11-06T15:30")));
    }

    @Test
    @DisplayName("그날 창 — 시가 맞추기 08:50:30~08:58:30, 마무리 09:00:30~09:30, 장중 ~15:19:30, 종가 15:20:30~15:28")
    void windows() {
        Day day = RealTradePlanner.windows(DAY, normalSession());
        assertThat(day.sync()).isEqualTo(new Window("SYNC", kst("2026-11-06T08:50:30"), kst("2026-11-06T08:58:30")));
        assertThat(day.followup()).isEqualTo(new Window("SYNC_FOLLOWUP", kst("2026-11-06T09:00:30"), kst("2026-11-06T09:30")));
        assertThat(day.intraday()).isEqualTo(new Window("MIRROR", kst("2026-11-06T09:00:30"), kst("2026-11-06T15:19:30")));
        assertThat(day.close()).isEqualTo(new Window("NEXT_CLOSE", kst("2026-11-06T15:20:30"), kst("2026-11-06T15:28")));
        assertThat(day.list()).hasSize(4);
        assertThat(day.firstStart()).isEqualTo(kst("2026-11-06T08:50:30"));

        assertThat(RealTradePlanner.mirrorWindow(day, kst("2026-11-06T10:00"), false))
                .isEqualTo(new Window("MIRROR", kst("2026-11-06T10:00"), kst("2026-11-06T10:03")));
        assertThat(RealTradePlanner.mirrorWindow(day, kst("2026-11-06T15:18"), false).end()).isEqualTo(kst("2026-11-06T15:19:30"));
        assertThat(RealTradePlanner.mirrorWindow(day, kst("2026-11-06T09:00"), false).start()).as("수집기 DAY 창 시작 전에는 보내지 않음")
                .isEqualTo(kst("2026-11-06T09:00:30"));
        assertThat(RealTradePlanner.mirrorWindow(day, kst("2026-11-06T15:19:45"), false)).as("종가 단일가 직전 — 놓침").isNull();
        assertThat(RealTradePlanner.mirrorWindow(day, kst("2026-11-06T15:20"), true)).isEqualTo(day.close());

        Day noAuctions = RealTradePlanner.windows(DAY, new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), null, kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), null, kst("2026-11-06T15:30"))));
        assertThat(noAuctions.sync()).as("단일가 시각이 없으면 그 경로는 쓰지 않음").isNull();
        assertThat(noAuctions.close()).isNull();
        assertThat(noAuctions.intraday()).isNull();
        assertThat(noAuctions.firstStart()).isEqualTo(kst("2026-11-06T09:00:30"));
        assertThat(RealTradePlanner.windows(DAY, null)).as("휴장").isNull();
    }

    @Test
    @DisplayName("매매 제한 — 지수 등락률의 서킷브레이커 단계, 시각 맞추기 창 늘리기(장중 끝까지, 시가 맞추기 날은 그대로)")
    void circuitStageAndExtendedWindow() {
        assertThat(RealTradePlanner.circuitStage(Map.of())).isZero();
        assertThat(RealTradePlanner.circuitStage(Map.of("KOSPI", new BigDecimal("-7.7")))).isZero();
        assertThat(RealTradePlanner.circuitStage(Map.of("KOSPI", new BigDecimal("-7.8"), "KOSDAQ", new BigDecimal("1")))).isEqualTo(1);
        assertThat(RealTradePlanner.circuitStage(Map.of("KOSPI", new BigDecimal("-3"), "KOSDAQ", new BigDecimal("-15.2")))).isEqualTo(2);
        assertThat(RealTradePlanner.circuitStage(Map.of("KOSDAQ", new BigDecimal("-21")))).isEqualTo(3);

        Day day = RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T09:10"));
        assertThat(day.withTimedSyncUntil(kst("2026-11-06T09:55")).followup())
                .isEqualTo(new Window("SYNC_AT", kst("2026-11-06T09:10"), kst("2026-11-06T09:55")));
        assertThat(day.withTimedSyncUntil(kst("2026-11-06T09:11"))).as("줄이지 않음").isEqualTo(day);
        assertThat(day.withTimedSyncUntil(kst("2026-11-06T16:00")).followup().end()).as("장중 끝에서 자름").isEqualTo(day.intraday().end());
        Day open = RealTradePlanner.windows(DAY, normalSession(), null);
        assertThat(open.withTimedSyncUntil(kst("2026-11-06T16:00"))).as("시가 맞추기 날").isEqualTo(open);
    }

    @Test
    @DisplayName("시각 맞추기 날(ADR 0033) — 시가 맞추기 창 없이 [T, T + 3분] 시장가 창(SYNC_AT), 맞추기 시각이 없으면 지금과 같은 창")
    void timedSyncWindows() {
        assertThat(RealTradePlanner.windows(DAY, normalSession(), null)).as("되돌리기용 시가 맞추기 경로 그대로")
                .isEqualTo(RealTradePlanner.windows(DAY, normalSession()));
        Day day = RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T09:10"));
        assertThat(day.sync()).isNull();
        assertThat(day.followup()).isEqualTo(new Window("SYNC_AT", kst("2026-11-06T09:10"), kst("2026-11-06T09:13")));
        assertThat(day.syncAt()).isEqualTo(kst("2026-11-06T09:10"));
        assertThat(day.firstStart()).as("예열·쉬는 날 판정은 09:07").isEqualTo(kst("2026-11-06T09:10"));
        assertThat(day.intraday()).isEqualTo(RealTradePlanner.windows(DAY, normalSession()).intraday());

        CollectorTradeClient.Session exam = new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T09:00"), kst("2026-11-06T09:50"), kst("2026-11-06T10:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T10:00"), kst("2026-11-06T16:20"), kst("2026-11-06T16:30")));
        assertThat(RealTradePlanner.windows(DAY, exam, kst("2026-11-06T10:10")).followup())
                .as("수능일형 — 그날 첫 분 10:10~10:13").isEqualTo(new Window("SYNC_AT", kst("2026-11-06T10:10"), kst("2026-11-06T10:13")));
        assertThat(RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T15:18:30")).followup().end())
                .as("장중 끝(종가 단일가 − 30초)에서 자름").isEqualTo(kst("2026-11-06T15:19:30"));
        Day late = RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T15:25"));
        assertThat(late.syncAt()).as("장중 끝 뒤 시각이면 시가 맞추기 날로").isNull();
        assertThat(late.sync()).isNotNull();
    }

    @Test
    @DisplayName("QA-377: 쉬는 날 판정의 기준 시각 — 첫 창과 정규장 시작 + 10분 가운데 이른 쪽. 시가 맞추기 날·맞추기 시각이 개장 10분 뒤인 날은 첫 창과 같다(운영 값 불변)")
    void firstActionTime() {
        Day open = RealTradePlanner.windows(DAY, normalSession());
        assertThat(open.firstAction()).as("시가 맞추기 날 — 시가 창 시작 그대로").isEqualTo(open.firstStart()).isEqualTo(kst("2026-11-06T08:50:30"));
        Day timed = RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T09:10"));
        assertThat(timed.firstAction()).as("운영 값 09:10 — 그대로").isEqualTo(timed.firstStart()).isEqualTo(kst("2026-11-06T09:10"));
        CollectorTradeClient.Session exam = new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T09:00"), kst("2026-11-06T09:50"), kst("2026-11-06T10:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T10:00"), kst("2026-11-06T16:20"), kst("2026-11-06T16:30")));
        Day lateOpen = RealTradePlanner.windows(DAY, exam, kst("2026-11-06T10:10"));
        assertThat(lateOpen.firstAction()).as("개장이 늦은 날의 첫 분 10:10 — 그대로").isEqualTo(lateOpen.firstStart());
        Day noAuctions = RealTradePlanner.windows(DAY, new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T08:00"), null, kst("2026-11-06T09:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T09:00"), null, kst("2026-11-06T15:30"))));
        assertThat(noAuctions.firstAction()).as("단일가 시각이 없는 날 — 마무리 창 시작 그대로").isEqualTo(noAuctions.firstStart());

        Day late = RealTradePlanner.windows(DAY, normalSession(), kst("2026-11-06T10:00"));
        assertThat(late.firstStart()).isEqualTo(kst("2026-11-06T10:00"));
        assertThat(late.firstAction()).as("맞추기 10:00 — 스탑 매도의 하한 09:10이 먼저").isEqualTo(kst("2026-11-06T09:10"));
    }

    @Test
    @DisplayName("스탑 매도 창 — [T, T + 3분], 개장 10분 전 T는 개장 + 10분부터(개장 10분 전에는 팔지 않음), 종가 STOP은 종가 창")
    void stopWindow() {
        Day day = RealTradePlanner.windows(DAY, normalSession());
        assertThat(RealTradePlanner.stopWindow(day, kst("2026-11-06T11:32"), false))
                .isEqualTo(new Window("MIRROR", kst("2026-11-06T11:32"), kst("2026-11-06T11:35")));
        assertThat(RealTradePlanner.stopWindow(day, kst("2026-11-06T09:02"), false))
                .isEqualTo(new Window("MIRROR", kst("2026-11-06T09:10"), kst("2026-11-06T09:13")));
        assertThat(RealTradePlanner.stopWindow(day, kst("2026-11-06T15:18"), false).end()).isEqualTo(kst("2026-11-06T15:19:30"));
        assertThat(RealTradePlanner.stopWindow(day, kst("2026-11-06T15:19:45"), false)).isNull();
        assertThat(RealTradePlanner.stopWindow(day, kst("2026-11-06T15:20"), true)).isEqualTo(day.close());
        assertThat(RealTradePlanner.stopWindow(day, null, false)).isNull();
    }

    // ------------------------------------------------------------------ 쉬는 날
    private static CollectorTradeClient.Calendar calendar(CollectorTradeClient.Session session, Double skew) {
        return new CollectorTradeClient.Calendar(DAY, skew, session, DAY.minusDays(1), DAY.plusDays(3));
    }

    private static Optional<SessionHours> paperHours(String open, String close) {
        return Optional.of(new SessionHours(DAY, true, kst("2026-11-06T" + open), kst("2026-11-06T" + close)));
    }

    @Test
    @DisplayName("쉬는 날 — 휴장·토스 날짜 다름·모의 달력 모름·장 시간 다름(11-19 수능형)·시계 5초 넘게 어긋남(모르면 쉼)·장부 밀림")
    void skipDay() {
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), 0.4), paperHours("09:00", "15:30"), true)).isNull();
        assertThat(RealTradePlanner.skipReason(DAY, calendar(null, 0.0), paperHours("09:00", "15:30"), true))
                .isEqualTo(RealTradePlanner.SKIP_MARKET_CLOSED);
        assertThat(RealTradePlanner.skipReason(DAY.plusDays(1), calendar(normalSession(), 0.0), paperHours("09:00", "15:30"), true))
                .isEqualTo(RealTradePlanner.SKIP_CALENDAR_DATE);
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), 0.0), Optional.empty(), true))
                .isEqualTo(RealTradePlanner.SKIP_PAPER_CALENDAR);
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), 0.0),
                Optional.of(new SessionHours(DAY, false, null, null)), true)).isEqualTo(RealTradePlanner.SKIP_HOURS);

        // 11-19형: 토스는 10:00~16:30인데 모의 달력에 장 시간 변경 설정이 없음(09:00~15:30) → 쉼. 설정이 있으면(10:00~16:30) 따라 함.
        CollectorTradeClient.Session exam = new CollectorTradeClient.Session(
                new CollectorTradeClient.PreMarket(kst("2026-11-06T09:00"), kst("2026-11-06T09:50"), kst("2026-11-06T10:00")),
                new CollectorTradeClient.Regular(kst("2026-11-06T10:00"), kst("2026-11-06T16:20"), kst("2026-11-06T16:30")));
        assertThat(RealTradePlanner.skipReason(DAY, calendar(exam, 0.0), paperHours("09:00", "15:30"), true))
                .isEqualTo(RealTradePlanner.SKIP_HOURS);
        assertThat(RealTradePlanner.skipReason(DAY, calendar(exam, 0.0), paperHours("10:00", "16:30"), true)).isNull();
        assertThat(RealTradePlanner.windows(DAY, exam).followup().end()).as("장 시간 변경일 마무리 끝 = 시작 + 30분")
                .isEqualTo(kst("2026-11-06T10:30"));

        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), 5.0), paperHours("09:00", "15:30"), true)).isNull();
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), -5.5), paperHours("09:00", "15:30"), true))
                .isEqualTo(RealTradePlanner.SKIP_CLOCK);
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), null), paperHours("09:00", "15:30"), true))
                .isEqualTo(RealTradePlanner.SKIP_CLOCK_UNKNOWN);
        assertThat(RealTradePlanner.skipReason(DAY, calendar(normalSession(), 0.0), paperHours("09:00", "15:30"), false))
                .isEqualTo(RealTradePlanner.SKIP_LEDGER);
    }

    @Test
    @DisplayName("종가 체결 시각은 정규장 끝 ± 2분 안이어야 함(아니면 close-auction-mismatch)")
    void closeFill() {
        Instant end = kst("2026-11-06T15:30");
        assertThat(RealTradePlanner.closeFillOk(kst("2026-11-06T15:30:01"), end)).isTrue();
        assertThat(RealTradePlanner.closeFillOk(kst("2026-11-06T15:28"), end)).isTrue();
        assertThat(RealTradePlanner.closeFillOk(kst("2026-11-06T15:21"), end)).isFalse();
        assertThat(RealTradePlanner.closeFillOk(null, end)).isFalse();
    }

    @Test
    @DisplayName("국내 코드 모양이 아닌 보유는 주문하지 않음(건너뜀)")
    void unsupportedSymbol() {
        Plan plan = sync(Map.of(), new Acct().hold("Q50001", "3", "1000").build());
        assertThat(plan.orders()).isEmpty();
        assertThat(reasons(plan)).containsExactly(RealTradePlanner.SKIP_SYMBOL);
    }
}
