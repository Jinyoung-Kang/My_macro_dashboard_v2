package com.macrodash.feature.realtrade;

import com.macrodash.feature.realtrade.ManualAccountPlanner.Draft;
import com.macrodash.feature.realtrade.ManualAccountPlanner.Result;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * ISA 계좌 지시 계산({@link ManualAccountPlanner}, ADR 0029 — 명세 §2): 비중 → 목표 수량, 1주·평가액 1% 임계값, 책에 없는 보유는 전량 매도, 현금 확인
 * (매수 × 기준가 × 1.02 ≤ 장부 현금 + 같은 지시의 매도 대금 — 뒤 순서 매수부터 줄임), 순서(매도 → 매수, 현금성 매수 마지막), 기준가를 모르는 보유면 만들지
 * 않음. 종목·금액은 합성 값입니다.
 */
class ManualAccountPlannerTest {

    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";
    private static final String X = "051910";
    private static final String CASH = "153130";
    private static final Set<String> CASH_LIKE = Set.of(CASH);

    private static Result plan(String cash, Map<String, BigDecimal> held, Map<String, Double> weights, Map<String, Double> prices,
                               Map<String, BigDecimal> last) {
        List<String> missing = new ArrayList<>();
        Optional<Result> result = ManualAccountPlanner.plan(d(cash), held, weights, prices, last, CASH_LIKE, missing);
        assertThat(missing).isEmpty();
        return result.orElseThrow();
    }

    private static List<String> lines(Result r) {
        return r.drafts().stream().map(x -> x.side() + " " + x.symbol() + " " + x.quantity()).toList();
    }

    @Test
    @DisplayName("목표 수량 = floor(비중 × 평가액 ÷ 기준가) − 보유, 평가액 = 장부 현금 + 보유 × 기준가 — 순서는 종목 코드 순 매수, 현금성 매수 마지막")
    void weightsToQuantities() {
        Result r = plan("1000000", Map.of(A, d("10")), Map.of(A, 50.0, B, 30.0, CASH, 15.0),
                Map.of(A, 10_000.0, B, 20_000.0, CASH, 100_000.0), Map.of());

        assertThat(r.equity()).isEqualByComparingTo("1100000");
        // A: floor(550,000 ÷ 10,000) = 55 − 10 = 45, B: floor(330,000 ÷ 20,000) = 16, 현금성: floor(165,000 ÷ 100,000) = 1
        assertThat(lines(r)).containsExactly("BUY " + B + " 16", "BUY " + A + " 45", "BUY " + CASH + " 1");
        Draft a = r.drafts().get(1);
        assertThat(a.refPrice()).isEqualByComparingTo("10000");
        assertThat(a.weightPct()).isEqualByComparingTo("50");
        assertThat(a.targetQuantity()).isEqualByComparingTo("55");
        assertThat(a.held()).isEqualByComparingTo("10");
    }

    @Test
    @DisplayName("차이가 평가액의 1% 미만인 책 종목은 지시하지 않고, 책에 없는 보유는 1% 조건 없이 전량 매도(기준가는 마지막 가격) — 매도가 먼저")
    void thresholdAndOutsideHoldings() {
        Result r = plan("1000000", Map.of(X, d("1")), Map.of(C, 0.5, A, 50.0), Map.of(C, 5_000.0, A, 10_000.0), Map.of(X, d("3000")));

        // 평가액 1,003,000 — C: floor(5,015 ÷ 5,000) = 1주, 5,000원 < 1%(10,030원) → 지시 없음. X는 책에 없음 → 1주(3,000원) 전량 매도
        assertThat(lines(r)).containsExactly("SELL " + X + " 1", "BUY " + A + " 50");
        assertThat(r.drafts().get(0).weightPct()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("현금 확인은 같은 지시의 매도 대금을 더함 — 매도 대금이 없으면 절반만 살 매수도 전부")
    void sellProceedsFundBuys() {
        Result r = plan("100000", Map.of(X, d("5")), Map.of(A, 90.0), Map.of(A, 10_000.0), Map.of(X, d("20000")));

        // 평가액 200,000, A 목표 18주 — 18 × 10,000 × 1.02 = 183,600 ≤ 현금 100,000 + 매도 대금 100,000
        assertThat(lines(r)).containsExactly("SELL " + X + " 5", "BUY " + A + " 18");
    }

    @Test
    @DisplayName("매수 합(× 1.02)이 현금을 넘으면 뒤 순서 매수부터 줄이고, 1주도 안 되면 빼서 deferred-cash로 남김")
    void laterBuysShrinkFirst() {
        Result r = plan("1000000", Map.of(), Map.of(B, 40.0, A, 60.0, CASH, 10.0), Map.of(A, 10_000.0, B, 20_000.0, CASH, 100_000.0),
                Map.of());

        // B(앞) 20주 × 20,400 = 408,000 → A(뒤) 남은 592,000 ÷ 10,200 = 58주(목표 60주), 현금성은 1주도 못 삼
        assertThat(lines(r)).containsExactly("BUY " + B + " 20", "BUY " + A + " 58");
        assertThat(r.skipped()).anySatisfy(s -> {
            assertThat(s.symbol()).isEqualTo(CASH);
            assertThat(s.reason()).isEqualTo(RealTradePlanner.SKIP_DEFERRED_CASH);
        });
    }

    @Test
    @DisplayName("보유 하나라도 기준가를 모르면(책에도 마지막 가격에도 없음) 지시를 만들지 않고 그 종목을 알림")
    void unknownPriceBlocksPlan() {
        List<String> missing = new ArrayList<>();
        Optional<Result> r = ManualAccountPlanner.plan(d("1000000"), Map.of(X, d("2")), Map.of(A, 50.0), Map.of(A, 10_000.0), Map.of(),
                CASH_LIKE, missing);

        assertThat(r).isEmpty();
        assertThat(missing).containsExactly(X);
    }

    @Test
    @DisplayName("이미 목표 비중이면 지시가 없음 — 매도는 보유 정수까지")
    void alreadyOnTarget() {
        Result r = plan("500000", Map.of(A, d("50")), Map.of(A, 50.0), Map.of(A, 10_000.0), Map.of());
        assertThat(r.drafts()).isEmpty();

        Result trim = plan("0", Map.of(A, d("100")), Map.of(A, 50.0), Map.of(A, 10_000.0), Map.of());
        assertThat(lines(trim)).containsExactly("SELL " + A + " 50");
    }
}
