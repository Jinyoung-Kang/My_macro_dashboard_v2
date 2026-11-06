package com.macrodash.analytics;

import com.macrodash.analytics.PaperLedger.Side;
import com.macrodash.analytics.UsCosts.Costs;
import com.macrodash.analytics.UsCosts.Rates;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 미국 체결 비용(ADR 0030, 명세 2026-11-06-us-costs-backfill.md §1·§7) — 수수료 센트 반올림, SEC fee 센트 올림, FINRA TAF 상한·저가 주식 0, 매수 가능
 * 수량. 손계산은 십진수로 한 값입니다.
 */
class UsCostsTest {

    /** 기본 판: 수수료 10bp(토스 미국 0.1%)·SEC $20.60/백만·TAF $0.000195/주·상한 $9.79. */
    private static final Rates RATES = new Rates(BigDecimal.TEN, new BigDecimal("20.6"), new BigDecimal("0.000195"),
            new BigDecimal("9.79"));

    private static BigDecimal d(String value) {
        return new BigDecimal(value);
    }

    @Test
    @DisplayName("매수: 수수료 = 체결 금액 × 10bp 센트 반올림(HALF_UP), 제비용 없음, 현금 −(금액 + 수수료) — 39,919.95 → 39.92")
    void buyCommissionRoundsHalfUp() {
        Costs costs = UsCosts.fill(Side.BUY, 399, d("100.05"), RATES);
        assertThat(costs.gross()).isEqualByComparingTo("39919.95");
        assertThat(costs.commission()).isEqualByComparingTo("39.92");   // 39.91995
        assertThat(costs.tax()).isEqualByComparingTo("0");
        assertThat(costs.cashFlow()).isEqualByComparingTo("-39959.87");
        assertThat(costs.costDelta()).isEqualByComparingTo("-39.92");
        // 반 센트는 올림: 5.005 → 5.01, 5.0049 → 5.00
        assertThat(UsCosts.of(Side.BUY, 1, d("5005"), d("5005"), RATES).commission()).isEqualByComparingTo("5.01");
        assertThat(UsCosts.of(Side.BUY, 1, d("5004.9"), d("5004.9"), RATES).commission()).isEqualByComparingTo("5.00");
    }

    @Test
    @DisplayName("매도: 수수료 반올림 + SEC fee 센트 올림 + TAF 센트 올림 — 9,185.405(100주) → 수수료 9.19, SEC 0.19(0.18922), TAF 0.02(0.0195), 현금 +9,176.005")
    void sellChargesRegulatoryFeesRoundedUp() {
        Costs costs = UsCosts.of(Side.SELL, 100, d("91.85405"), d("9185.405"), RATES);
        assertThat(costs.commission()).isEqualByComparingTo("9.19");
        assertThat(costs.secFee()).isEqualByComparingTo("0.19");
        assertThat(costs.taf()).isEqualByComparingTo("0.02");
        assertThat(costs.tax()).isEqualByComparingTo("0.21");
        assertThat(costs.cashFlow()).isEqualByComparingTo("9176.005");
        // SEC는 아주 작아도 1센트(올림): 금액 10 × 20.6 / 1,000,000 = 0.000206 → 0.01
        assertThat(UsCosts.of(Side.SELL, 1, d("10"), d("10"), RATES).secFee()).isEqualByComparingTo("0.01");
        // 딱 떨어지면 그대로: 1,000,000 × 20.6 / 1,000,000 = 20.60
        assertThat(UsCosts.of(Side.SELL, 1, d("1000000"), d("1000000"), RATES).secFee()).isEqualByComparingTo("20.60");
    }

    @Test
    @DisplayName("FINRA TAF: 1건 상한 $9.79(100,000주 × 0.000195 = 19.5 → 9.79), 체결가가 1주당 요율보다 작으면 0")
    void tafCapAndSubPennyExemption() {
        assertThat(UsCosts.of(Side.SELL, 100_000, d("10"), d("1000000"), RATES).taf()).isEqualByComparingTo("9.79");
        assertThat(UsCosts.of(Side.SELL, 50_000, d("10"), d("500000"), RATES).taf()).as("9.75 — 상한 안")
                .isEqualByComparingTo("9.75");
        assertThat(UsCosts.of(Side.SELL, 1_000, d("0.0001"), d("0.1"), RATES).taf()).as("체결가 $0.0001 < $0.000195")
                .isEqualByComparingTo("0");
        assertThat(UsCosts.of(Side.SELL, 1_000, d("0.000195"), d("0.195"), RATES).taf()).as("같으면 부과")
                .isEqualByComparingTo("0.20");
    }

    @Test
    @DisplayName("체결 금액 = 수량 × 체결가 소수 4자리 반올림(장부 gross와 같은 식)")
    void grossMatchesTheLedger() {
        assertThat(UsCosts.gross(7, d("123.518517"))).isEqualByComparingTo("864.6296");   // 864.629619
        assertThat(UsCosts.fill(Side.BUY, 7, d("123.518517"), RATES).gross()).isEqualByComparingTo("864.6296");
    }

    @Test
    @DisplayName("매수 가능 수량: floor(예산 ÷ (체결가 × (1 + 수수료율))), 유출이 예산을 넘으면 줄임 — 10,000 / 50.075025 = 199.7 → 199주(유출 9,964.925)")
    void affordableQtyIncludesCommission() {
        assertThat(UsCosts.affordableQty(d("10000"), d("50.025"), RATES)).isEqualTo(199);
        assertThat(UsCosts.fill(Side.BUY, 199, d("50.025"), RATES).cashFlow()).isEqualByComparingTo("-9964.925");
        // 수수료가 없을 때보다 적거나 같음(10,000 / 50.025 = 199.9 → 199, 50.0 / 50.025 → 0)
        assertThat(UsCosts.affordableQty(d("50.07"), d("50.025"), RATES)).as("1주 유출 50.075 > 50.07").isZero();
        assertThat(UsCosts.affordableQty(d("50.08"), d("50.025"), RATES)).isEqualTo(1);
        assertThat(UsCosts.affordableQty(BigDecimal.ZERO, d("10"), RATES)).isZero();
        assertThat(UsCosts.affordableQty(d("-1"), d("10"), RATES)).isZero();
        // 반 센트 반올림이 유출을 예산 위로 밀면 한 주 줄임: 1주 5.005 → 식은 5.0101 / 5.010005 = 1주지만 수수료 0.005005 → 0.01이라
        // 유출 5.015 > 예산 5.0101 → 0주
        assertThat(UsCosts.affordableQty(d("5.0101"), d("5.005"), RATES)).isZero();
        assertThat(UsCosts.affordableQty(d("5.015"), d("5.005"), RATES)).isEqualTo(1);
        // 0bp면 수수료 없는 식과 같음
        assertThat(UsCosts.affordableQty(d("10000"), d("50.025"), Rates.ZERO)).isEqualTo(199);
    }

    @Test
    @DisplayName("요율 0이면 비용 없음 — 이 묶음 전 미국 현금 흐름(매수 −금액, 매도 +금액)")
    void zeroRatesChargeNothing() {
        assertThat(Rates.ZERO.zero()).isTrue();
        assertThat(RATES.zero()).isFalse();
        // TAF 단가가 있어도 상한이 0이면 TAF는 0 — 비용이 생기지 않는 판(리뷰 지적)
        Rates tafCapZero = new Rates(d("0"), d("0"), d("0.000195"), d("0"));
        assertThat(tafCapZero.zero()).isTrue();
        assertThat(UsCosts.of(Side.SELL, 100, d("91.85405"), d("9185.405"), tafCapZero).costDelta())
                .isEqualByComparingTo("0");
        Costs sell = UsCosts.of(Side.SELL, 100, d("91.85405"), d("9185.405"), Rates.ZERO);
        assertThat(sell.tax()).isEqualByComparingTo("0");
        assertThat(sell.cashFlow()).isEqualByComparingTo("9185.405");
        assertThat(UsCosts.of(Side.BUY, 100, d("91.85405"), d("9185.405"), Rates.ZERO).cashFlow())
                .isEqualByComparingTo("-9185.405");
    }

    @Test
    @DisplayName("요율·입력 검사 — 음수·수수료 10,000bp 이상·수량 0·가격 0은 받지 않음")
    void rejectsBadInputs() {
        assertThatThrownBy(() -> new Rates(d("-1"), BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Rates(d("10000"), BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> UsCosts.fill(Side.BUY, 0, d("10"), RATES)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> UsCosts.fill(Side.BUY, 1, BigDecimal.ZERO, RATES))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
