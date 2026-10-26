package com.macrodash.analytics;

import com.macrodash.analytics.OrderValidator.Context;
import com.macrodash.analytics.OrderValidator.Limits;
import com.macrodash.analytics.OrderValidator.Market;
import com.macrodash.analytics.OrderValidator.Money;
import com.macrodash.analytics.OrderValidator.Proposed;
import com.macrodash.analytics.OrderValidator.Verdict;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 검증기의 시장 몫(2단계 명세 §9 A7) — 받는 체결 시점·이른 시점·근거 문구의 시점 이름과 금액 표기를 주입받습니다. 미국 값
 * ({@link Market#US})은 이 묶음 전 상수·문구 그대로라 시장을 받지 않는 검사와 판정이 글자까지 같고({@code OrderValidatorTest}는
 * 그대로 — 고정본 {@code order-validator-us.txt} 포함), 다른 시장 값이면 계산은 같고 이름·표기만 그 시장 것입니다.
 *
 * <p>여기의 한국풍 시장({@link #KR_LIKE})은 <b>시험용</b>입니다 — 주입이 되는지만 보며, 실제 한국 시점·금액 표기는 C1·E2에서 정합니다.
 */
class OrderValidatorMarketTest {

    private static final String NEXT_OPEN = "NEXT_OPEN";
    /** 시험용 한국풍 시장: 이른 시점 NEXT_OPEN, 늦은 시점 NEXT_CLOSE, 원(소수 없음). */
    private static final Market KR_LIKE = new Market(List.of(NEXT_OPEN, OrderValidator.NEXT_CLOSE), NEXT_OPEN,
            Map.of(NEXT_OPEN, "다음 거래일 시가", OrderValidator.NEXT_CLOSE, "확정 종가"), new Money("", "원", 0));
    /** 시험용 한 시점 시장(종가 시점을 두지 않는 경우). */
    private static final Market OPEN_ONLY = new Market(List.of(NEXT_OPEN), NEXT_OPEN, Map.of(NEXT_OPEN, "다음 거래일 시가"),
            new Money("", "원", 0));

    private static final double NAV = 100_000;
    private static final Limits DEFAULT = new Limits(10, 20, 20, 500, 20, 5);
    private static final Set<String> ETFS = Set.of("XLK", "XLE", "SHY");
    private static final Set<String> STOCKS = Set.of("AAPL", "MSFT", "NVDA", "META", "AMZN", "GOOGL");

    // ------------------------------------------------------------------ 만들기
    private static Proposed buy(String ticker, double targetWeightPct, String timing) {
        return new Proposed(ticker, OrderValidator.BUY, targetWeightPct, null, timing);
    }

    private static Proposed sell(String ticker, Double sellFraction, String timing) {
        return new Proposed(ticker, OrderValidator.SELL, null, sellFraction, timing);
    }

    /** 장부 상태 — 기본은 현금 100%, 보유 없음, SHY만 현금성. */
    private static final class Book {
        final double nav;
        double cash;
        final Map<String, Double> weights = new LinkedHashMap<>();
        final Map<String, Integer> days = new LinkedHashMap<>();
        final Set<String> universe = new LinkedHashSet<>();

        Book(double nav) {
            this.nav = nav;
            this.cash = nav;
            universe.addAll(STOCKS);
            universe.addAll(ETFS);
        }

        Book() {
            this(NAV);
        }

        Book hold(String ticker, double weightPct) {
            weights.put(ticker, weightPct);
            days.put(ticker, 30);
            cash -= weightPct / 100.0 * nav;
            return this;
        }

        Context context() {
            return new Context(nav, cash, weights, days, universe, ETFS, Set.of("SHY"), Set.of(), Set.of(), 0, false,
                    null);
        }
    }

    /** 20종목(각 4.5%)을 든 장부 — 종목 수 상한(20)이 시점마다 갈리는 장면. */
    private static Book full() {
        Book book = new Book();
        for (int i = 1; i <= 20; i++) {
            String ticker = String.format(Locale.ROOT, "T%02d", i);
            book.universe.add(ticker);
            book.hold(ticker, 4.5);
        }
        book.universe.addAll(List.of("NEW", "NEW2"));
        return book;
    }

    /** 대표 장면(미국 시점 이름) — 시점이 판정을 가르는 곳(MALFORMED·이른 시점 종목 수·이른 시점 100%)과 금액 문구. */
    private static List<Scene> scenes() {
        String obs = OrderValidator.NEXT_OBSERVATION;
        String close = OrderValidator.NEXT_CLOSE;
        return List.of(
                new Scene("모양·금액", new Book().hold("AAPL", 5).hold("MSFT", 5),
                        List.of(buy("NVDA", 0.4, obs), buy("META", 5, obs), buy("AMZN", 3, close),
                                new Proposed("GOOGL", OrderValidator.BUY, 5.0, null, "IMMEDIATE"),
                                new Proposed("XLK", OrderValidator.BUY, 5.0, null, null), sell("AAPL", null, close),
                                sell("MSFT", 0.5, obs))),
                new Scene("종목 수 — 이른 시점", full(),
                        List.of(sell("T01", null, close), buy("NEW", 5, obs), buy("NEW2", 2, close))),
                new Scene("100% — 이른 시점", new Book().hold("AAPL", 20).hold("MSFT", 40).hold("XLK", 38),
                        List.of(sell("AAPL", null, close), buy("NVDA", 2, obs), buy("GOOGL", 1, obs),
                                buy("META", 5, close), buy("AMZN", 5, close))));
    }

    private record Scene(String name, Book book, List<Proposed> orders) {
    }

    /** 장면의 미국 시점 이름을 다른 시장 이름으로(이른 시점 → 이른 시점). */
    private static List<Proposed> renamed(List<Proposed> orders, String early) {
        List<Proposed> out = new ArrayList<>();
        for (Proposed o : orders) {
            String timing = OrderValidator.NEXT_OBSERVATION.equals(o.timing()) ? early : o.timing();
            out.add(new Proposed(o.ticker(), o.side(), o.targetWeightPct(), o.sellFraction(), timing));
        }
        return out;
    }

    // ------------------------------------------------------------------ 미국 값
    @Test
    @DisplayName("미국 값 = 이 묶음 전 상수 — 시점 NEXT_OBSERVATION·NEXT_CLOSE(이른 시점 NEXT_OBSERVATION), 이름 다음 관측치·확정 종가, 달러")
    void usValues() {
        Market us = Market.US;
        assertThat(us.timings()).containsExactly(OrderValidator.NEXT_OBSERVATION, OrderValidator.NEXT_CLOSE)
                .containsExactly("NEXT_OBSERVATION", "NEXT_CLOSE");
        assertThat(us.earlyTiming()).isEqualTo("NEXT_OBSERVATION");
        assertThat(us.timingNames()).containsExactly(Map.entry("NEXT_OBSERVATION", "다음 관측치"),
                Map.entry("NEXT_CLOSE", "확정 종가"));
        assertThat(us.money()).isEqualTo(Money.USD).isEqualTo(new Money("$", "", 2));
        assertThat(us.label(us.earlyTiming())).isEqualTo("다음 관측치(NEXT_OBSERVATION)");
        assertThat(us.lateLabel()).isEqualTo("확정 종가(NEXT_CLOSE)");
        assertThat(us.accepts("NEXT_OBSERVATION")).isTrue();
        assertThat(us.accepts("NEXT_CLOSE")).isTrue();
        assertThat(us.accepts("NEXT_OPEN")).isFalse();
        assertThat(us.accepts("IMMEDIATE")).as("장부 전용 시점(스탑)은 Claude가 고를 수 없음").isFalse();
        assertThat(us.accepts(null)).isFalse();
    }

    @Test
    @DisplayName("달러 표기 = 이 묶음 전 문구의 \"$%,.2f\"·\"$%,.0f\" 글자 그대로(0·음수·반올림 경계·큰 수)")
    void usdMatchesOldFormat() {
        double[] amounts = {0, -0.0, 0.004, 0.005, 0.5, 1.5, 2.5, 399.99999999999994, 400, 499.99999999999994, 500,
                1_234.5, 2_000, 99_999.995, 1e9 + 0.125, -1_234.567};
        for (double amount : amounts) {
            assertThat(Money.USD.exact(amount)).as("exact " + amount)
                    .isEqualTo(String.format(Locale.ROOT, "$%,.2f", amount));
            assertThat(Money.USD.rounded(amount)).as("rounded " + amount)
                    .isEqualTo(String.format(Locale.ROOT, "$%,.0f", amount));
        }
        assertThat(Money.USD.exact(1_234.5)).isEqualTo("$1,234.50");
        assertThat(Money.USD.rounded(2_000)).isEqualTo("$2,000");
        assertThat(new Money("", "원", 0).exact(500_000)).isEqualTo("500,000원");
        assertThat(new Money("", "원", 0).rounded(4_999_999.5)).isEqualTo("5,000,000원");
    }

    @Test
    @DisplayName("시장을 받지 않는 검사 = 미국 값(Market.US)·같은 값으로 새로 만든 시장의 검사 — 판정·사유·근거 문구가 글자까지 같음")
    void defaultIsUs() {
        Market sameAsUs = new Market(new ArrayList<>(List.of("NEXT_OBSERVATION", "NEXT_CLOSE")), "NEXT_OBSERVATION",
                new HashMap<>(Map.of("NEXT_CLOSE", "확정 종가", "NEXT_OBSERVATION", "다음 관측치")), new Money("$", "", 2));
        assertThat(sameAsUs).isEqualTo(Market.US);
        for (Scene scene : scenes()) {
            List<Verdict> legacy = OrderValidator.validate(scene.orders(), scene.book().context(), DEFAULT);
            assertThat(OrderValidator.validate(scene.orders(), scene.book().context(), DEFAULT, Market.US))
                    .as(scene.name()).isEqualTo(legacy);
            assertThat(OrderValidator.validate(scene.orders(), scene.book().context(), DEFAULT, sameAsUs))
                    .as(scene.name()).isEqualTo(legacy);
        }
        // 장면이 시점·금액 문구를 실제로 지나가는지(주입이 빈 곳을 보지 않게).
        List<Verdict> shape = OrderValidator.validate(scenes().get(0).orders(), scenes().get(0).book().context(),
                DEFAULT);
        assertThat(shape.get(0).detail()).isEqualTo("매수 증가분 약 $400.00 < 최소 $500.00(현재 0.00% → 목표 0.40%)");
        assertThat(shape.get(1).detail()).isEqualTo("현재 0.00% → 목표 5.00%(+5.00%p, 약 $5,000)");
        assertThat(shape.get(3).detail()).isEqualTo("timing은 NEXT_OBSERVATION 또는 NEXT_CLOSE여야 함: IMMEDIATE");
        assertThat(shape.get(4).detail()).isEqualTo("timing은 NEXT_OBSERVATION 또는 NEXT_CLOSE여야 함: null");
        List<Verdict> positions = OrderValidator.validate(scenes().get(1).orders(), scenes().get(1).book().context(),
                DEFAULT);
        assertThat(positions.get(2).rejectReason()).as("늦은 시점 신규 매수는 늦은 매도가 비운 자리를 씀").isNull();
        assertThat(positions.get(1).detail()).isEqualTo("다음 관측치(NEXT_OBSERVATION) 매수인데 확정 종가(NEXT_CLOSE) 전량 매도 "
                + "1종목은 그 뒤에 체결돼 자리를 비우지 못함 — 그 시점 종목 수 21 > 상한 20(현금성 제외)");
        List<Verdict> allocated = OrderValidator.validate(scenes().get(2).orders(), scenes().get(2).book().context(),
                DEFAULT);
        assertThat(allocated.get(2).detail()).startsWith("다음 관측치(NEXT_OBSERVATION) 매수인데 확정 종가(NEXT_CLOSE) 매도 "
                + "20.00%p는 그 뒤에 체결돼 자리를 만들지 못함 — 그 시점 남는 보유 98.00% + 앞서 받은 다음 관측치 매수 2.00%p");
    }

    // ------------------------------------------------------------------ 다른 시장
    @Test
    @DisplayName("받는 시점은 그 시장 것 — 시험용 한국풍 시장은 NEXT_OBSERVATION을 MALFORMED, 미국은 NEXT_OPEN을 MALFORMED, 시점 없음은 둘 다 MALFORMED")
    void timingsAreTheMarkets() {
        Book book = new Book();
        List<Proposed> orders = List.of(buy("AAPL", 5, OrderValidator.NEXT_OBSERVATION), buy("MSFT", 5, NEXT_OPEN),
                buy("NVDA", 5, OrderValidator.NEXT_CLOSE), new Proposed("META", OrderValidator.BUY, 5.0, null, null));

        List<Verdict> kr = OrderValidator.validate(orders, book.context(), DEFAULT, KR_LIKE);
        assertThat(kr).extracting(Verdict::rejectReason)
                .containsExactly(OrderValidator.MALFORMED, null, null, OrderValidator.MALFORMED);
        assertThat(kr.get(0).detail()).isEqualTo("timing은 NEXT_OPEN 또는 NEXT_CLOSE여야 함: NEXT_OBSERVATION");

        List<Verdict> us = OrderValidator.validate(orders, book.context(), DEFAULT, Market.US);
        assertThat(us).extracting(Verdict::rejectReason)
                .containsExactly(null, OrderValidator.MALFORMED, null, OrderValidator.MALFORMED);
        assertThat(us.get(1).detail()).isEqualTo("timing은 NEXT_OBSERVATION 또는 NEXT_CLOSE여야 함: NEXT_OPEN");

        List<Verdict> openOnly = OrderValidator.validate(orders, book.context(), DEFAULT, OPEN_ONLY);
        assertThat(openOnly).extracting(Verdict::rejectReason)
                .containsExactly(OrderValidator.MALFORMED, null, OrderValidator.MALFORMED, OrderValidator.MALFORMED);
        assertThat(openOnly.get(2).detail()).isEqualTo("timing은 NEXT_OPEN여야 함: NEXT_CLOSE");
    }

    @Test
    @DisplayName("계산은 시장 중립 — 미국 장면의 이른 시점을 그 시장의 이른 시점으로 바꾸면 통과·거절 사유·매수 증가분이 미국과 같음")
    void sameArithmeticUnderAnotherMarket() {
        for (Scene scene : scenes()) {
            Context ctx = scene.book().context();
            List<Verdict> us = OrderValidator.validate(scene.orders(), ctx, DEFAULT);
            List<Verdict> kr = OrderValidator.validate(renamed(scene.orders(), NEXT_OPEN), ctx, DEFAULT, KR_LIKE);
            assertThat(kr).as(scene.name()).hasSameSizeAs(us);
            for (int i = 0; i < us.size(); i++) {
                assertThat(kr.get(i).accepted()).as(scene.name() + " " + i).isEqualTo(us.get(i).accepted());
                assertThat(kr.get(i).rejectReason()).as(scene.name() + " " + i).isEqualTo(us.get(i).rejectReason());
                if (us.get(i).accepted() && OrderValidator.BUY.equals(us.get(i).order().side())) {
                    assertThat(OrderValidator.buyIncrementPct(kr.get(i).order(), ctx))
                            .isEqualTo(OrderValidator.buyIncrementPct(us.get(i).order(), ctx));
                }
            }
        }
    }

    @Test
    @DisplayName("근거 문구의 시점 이름·금액은 그 시장 것 — 이른 시점 종목 수·100% 문구에 NEXT_OPEN·'다음 거래일 시가', 금액은 원, '$'·NEXT_OBSERVATION·'다음 관측치' 없음")
    void detailsUseTheMarketsNames() {
        List<Verdict> positions = OrderValidator.validate(renamed(scenes().get(1).orders(), NEXT_OPEN),
                scenes().get(1).book().context(), DEFAULT, KR_LIKE);
        assertThat(positions.get(1).rejectReason()).isEqualTo(OrderValidator.MAX_POSITIONS);
        assertThat(positions.get(1).detail()).isEqualTo("다음 거래일 시가(NEXT_OPEN) 매수인데 확정 종가(NEXT_CLOSE) 전량 매도 "
                + "1종목은 그 뒤에 체결돼 자리를 비우지 못함 — 그 시점 종목 수 21 > 상한 20(현금성 제외)");

        List<Verdict> allocated = OrderValidator.validate(renamed(scenes().get(2).orders(), NEXT_OPEN),
                scenes().get(2).book().context(), DEFAULT, KR_LIKE);
        assertThat(allocated.get(2).rejectReason()).isEqualTo(OrderValidator.OVER_ALLOCATED);
        assertThat(allocated.get(2).detail()).isEqualTo("다음 거래일 시가(NEXT_OPEN) 매수인데 확정 종가(NEXT_CLOSE) 매도 "
                + "20.00%p는 그 뒤에 체결돼 자리를 만들지 못함 — 그 시점 남는 보유 98.00% + 앞서 받은 다음 거래일 시가 매수 "
                + "2.00%p + 이 주문 1.00%p = 101.00% > 100% (현재 현금 2.00%)");

        // 원 장부(순자산 1억, 최소 50만 원).
        Limits won = new Limits(10, 20, 20, 500_000, 20, 5);
        Book krw = new Book(100_000_000).hold("AAPL", 5);
        List<Verdict> money = OrderValidator.validate(List.of(buy("MSFT", 0.4, NEXT_OPEN), buy("NVDA", 5, NEXT_OPEN),
                buy("AAPL", 7.5, OrderValidator.NEXT_CLOSE)), krw.context(), won, KR_LIKE);
        assertThat(money.get(0).detail()).isEqualTo("매수 증가분 약 400,000원 < 최소 500,000원(현재 0.00% → 목표 0.40%)");
        assertThat(money.get(1).detail()).isEqualTo("현재 0.00% → 목표 5.00%(+5.00%p, 약 5,000,000원)");
        assertThat(money.get(2).detail()).isEqualTo("현재 5.00% → 목표 7.50%(+2.50%p, 약 2,500,000원)");

        List<Verdict> all = new ArrayList<>(positions);
        all.addAll(allocated);
        all.addAll(money);
        for (Verdict v : all) {
            assertThat(v.detail()).as(v.toString()).doesNotContain("$").doesNotContain("NEXT_OBSERVATION")
                    .doesNotContain("다음 관측치");
        }
    }

    @Test
    @DisplayName("한 시점 시장 — 이른 시점뿐이면 그 시점 매도가 같은 시점 매수의 자리를 만듦(늦은 시점 문구가 나올 일이 없음)")
    void singleTimingMarket() {
        Book book = full();
        List<Verdict> verdicts = OrderValidator.validate(List.of(sell("T01", null, NEXT_OPEN), buy("NEW", 3, NEXT_OPEN),
                buy("NEW2", 2, NEXT_OPEN)), book.context(), DEFAULT, OPEN_ONLY);
        assertThat(verdicts).extracting(Verdict::rejectReason)
                .containsExactly(null, null, OrderValidator.MAX_POSITIONS);
        assertThat(verdicts.get(2).detail()).isEqualTo("매수 뒤 종목 수 21 > 상한 20(현금성 제외)");
        assertThat(OPEN_ONLY.lateLabel()).isEmpty();
    }

    // ------------------------------------------------------------------ 잘못된 입력
    @Test
    @DisplayName("시장 값 검사 — 시점 없음·빈 시점·겹침·이른 시점이 목록 밖·이름 없음·금액 표기 없음은 만들 때 거절, 시장 없는 검사도 거절")
    void rejectsBadMarkets() {
        Money won = new Money("", "원", 0);
        Map<String, String> names = Map.of(NEXT_OPEN, "시가", "NEXT_CLOSE", "종가");
        assertThatThrownBy(() -> new Market(null, NEXT_OPEN, names, won)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(), NEXT_OPEN, names, won)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(Arrays.asList(NEXT_OPEN, null), NEXT_OPEN, names, won))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN, " "), NEXT_OPEN, names, won))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN, NEXT_OPEN), NEXT_OPEN, names, won))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("겹치는");
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN), "NEXT_CLOSE", names, won))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("이른 시점");
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN), null, names, won))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN, "NEXT_CLOSE"), NEXT_OPEN, Map.of(NEXT_OPEN, "시가"), won))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("NEXT_CLOSE");
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN), NEXT_OPEN, Map.of(NEXT_OPEN, " "), won))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN), NEXT_OPEN, null, won))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Market(List.of(NEXT_OPEN), NEXT_OPEN, names, null))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> new Money(null, "", 2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Money("$", null, 2)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Money("$", "", -1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Money("$", "", 7)).isInstanceOf(IllegalArgumentException.class);

        Context ctx = new Book().context();
        assertThatThrownBy(() -> OrderValidator.validate(List.of(), ctx, DEFAULT, null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("시장 값은 복사해 둠 — 만든 뒤 넘긴 목록·맵을 고쳐도 바뀌지 않고, 이름은 받는 시점만 받는 순서로")
    void copiesInputs() {
        List<String> timings = new ArrayList<>(List.of(NEXT_OPEN, "NEXT_CLOSE"));
        Map<String, String> names = new HashMap<>(Map.of("NEXT_CLOSE", "종가", NEXT_OPEN, "시가", "EXTRA", "버림"));
        Market market = new Market(timings, NEXT_OPEN, names, new Money("", "원", 0));
        timings.add("LATER");
        names.put(NEXT_OPEN, "바뀐 이름");
        assertThat(market.timings()).containsExactly(NEXT_OPEN, "NEXT_CLOSE");
        assertThat(market.timingNames()).containsExactly(Map.entry(NEXT_OPEN, "시가"), Map.entry("NEXT_CLOSE", "종가"));
        assertThatThrownBy(() -> market.timings().add("X")).isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> market.timingNames().put("X", "Y")).isInstanceOf(UnsupportedOperationException.class);
    }
}
