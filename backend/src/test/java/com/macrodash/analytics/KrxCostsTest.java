package com.macrodash.analytics;

import com.macrodash.analytics.KrxCosts.Confirmation;
import com.macrodash.analytics.KrxCosts.Costs;
import com.macrodash.analytics.KrxCosts.Instrument;
import com.macrodash.analytics.KrxCosts.Rates;
import com.macrodash.analytics.KrxCosts.TaxRates;
import com.macrodash.analytics.PaperLedger.Side;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 체결 비용(2단계 명세 §4-3·K5·K31, §5 '비용이 손계산과 같다'·'확정 조정'). 손계산은 명세 §5의 값(2026-10-27 Decimal 재계산)이고,
 * 조사 노트의 예시 6건(같은 관측가)은 K31 전 '불리한 쪽 호가 반올림'으로 셈한 값이라 K31(체결가 = 관측가) 기준으로 다시 셈한 값을 씁니다.
 */
class KrxCostsTest {

    /** 기본 판: 수수료 1.5bp(가정)·슬리피지 5bp·2026-01-01 시행 세율. */
    private static final Rates RATES = new Rates(new BigDecimal("1.5"), BigDecimal.valueOf(5), TaxRates.KRX_2026);
    private static final LocalDate DAY = LocalDate.of(2026, 11, 3);

    private static BigDecimal won(long v) {
        return BigDecimal.valueOf(v);
    }

    private static Costs fill(Side side, Instrument instrument, int qty, long price) {
        return KrxCosts.fill(side, instrument, DAY, qty, won(price), RATES);
    }

    // ---- §5 손계산 ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("§5 코스피 매수 10주 71,300: 수수료 106·슬리피지 356, 세금 0, 현금 −713,462, 체결가는 관측가 그대로")
    void kospiBuy() {
        Costs c = fill(Side.BUY, Instrument.KOSPI, 10, 71_300);

        assertThat(c.price()).isEqualByComparingTo("71300");
        assertThat(c.notional()).isEqualByComparingTo("713000");
        assertThat(c.commission()).isEqualByComparingTo("106");    // 106.95 → 절사
        assertThat(c.slippage()).isEqualByComparingTo("356");      // 356.5 → 절사
        assertThat(c.tax()).isEqualByComparingTo("0");
        assertThat(c.cashFlow()).isEqualByComparingTo("-713462");
        assertThat(c.effectiveBp()).isEqualByComparingTo("6.4797");
    }

    @Test
    @DisplayName("§5 코스피 매도 10주 72,000: 수수료 108·슬리피지 360·거래세 360·농특세 1,080, 현금 +718,092")
    void kospiSell() {
        Costs c = fill(Side.SELL, Instrument.KOSPI, 10, 72_000);

        assertThat(c.commission()).isEqualByComparingTo("108");
        assertThat(c.slippage()).isEqualByComparingTo("360");
        assertThat(c.transactionTax()).isEqualByComparingTo("360");
        assertThat(c.ruralTax()).isEqualByComparingTo("1080");
        assertThat(c.tax()).isEqualByComparingTo("1440");          // paper_fills.tax = 거래세 + 농특세
        assertThat(c.total()).isEqualByComparingTo("1908");
        assertThat(c.cashFlow()).isEqualByComparingTo("718092");
        assertThat(c.effectiveBp()).isEqualByComparingTo("26.5");
    }

    @Test
    @DisplayName("§5 코스닥 매도 37주 18,450: 수수료 102·슬리피지 341·거래세 1,365·농특세 0, 현금 +680,842")
    void kosdaqSell() {
        Costs c = fill(Side.SELL, Instrument.KOSDAQ, 37, 18_450);

        assertThat(c.notional()).isEqualByComparingTo("682650");
        assertThat(c.commission()).isEqualByComparingTo("102");    // 102.3975
        assertThat(c.slippage()).isEqualByComparingTo("341");      // 341.325
        assertThat(c.transactionTax()).isEqualByComparingTo("1365"); // 20bp: 1,365.3
        assertThat(c.ruralTax()).isEqualByComparingTo("0");        // 코스닥에는 농특세 없음
        assertThat(c.cashFlow()).isEqualByComparingTo("680842");
    }

    @Test
    @DisplayName("§5 ETF 069500 매수 400주 95,000: 수수료 5,700·슬리피지 19,000, 현금 −38,024,700")
    void etfBuy() {
        Costs c = fill(Side.BUY, Instrument.ETF, 400, 95_000);

        assertThat(c.commission()).isEqualByComparingTo("5700");
        assertThat(c.slippage()).isEqualByComparingTo("19000");
        assertThat(c.tax()).isEqualByComparingTo("0");
        assertThat(c.cashFlow()).isEqualByComparingTo("-38024700");
    }

    @Test
    @DisplayName("§5 ETF 153130 매도 100주 108,000: 수수료 1,620·슬리피지 5,400·세금 0, 현금 +10,792,980")
    void etfSell() {
        Costs c = fill(Side.SELL, Instrument.ETF, 100, 108_000);

        assertThat(c.commission()).isEqualByComparingTo("1620");
        assertThat(c.slippage()).isEqualByComparingTo("5400");
        assertThat(c.transactionTax()).isEqualByComparingTo("0");
        assertThat(c.ruralTax()).isEqualByComparingTo("0");
        assertThat(c.cashFlow()).isEqualByComparingTo("10792980");
    }

    @Test
    @DisplayName("§5 매수 가능 수량: 현금 1,000,000·49,950원 → 20주(유출 999,648), 21주는 1,049,631로 초과")
    void affordableQuantity() {
        int qty = KrxCosts.affordableQty(won(1_000_000), won(49_950), RATES);

        assertThat(qty).isEqualTo(20);
        assertThat(fill(Side.BUY, Instrument.KOSPI, 20, 49_950).cashFlow()).isEqualByComparingTo("-999648");
        assertThat(fill(Side.BUY, Instrument.KOSPI, 21, 49_950).cashFlow()).isEqualByComparingTo("-1049631");
    }

    @Test
    @DisplayName("§5 확정 조정: 매수 10주 잠정 71,300 → 확정 71,200, 수수료 106·슬리피지 356 그대로, 현금 +1,000")
    void confirmBuy() {
        Costs provisional = fill(Side.BUY, Instrument.KOSPI, 10, 71_300);

        Confirmation conf = KrxCosts.confirm(provisional, won(71_200), RATES);

        assertThat(conf.confirmed().price()).isEqualByComparingTo("71200");
        assertThat(conf.confirmed().qty()).isEqualTo(10);
        assertThat(conf.confirmed().commission()).isEqualByComparingTo("106");   // 106.8
        assertThat(conf.confirmed().slippage()).isEqualByComparingTo("356");
        assertThat(conf.confirmed().tax()).isEqualByComparingTo("0");
        assertThat(conf.cashDelta()).isEqualByComparingTo("1000");
    }

    @Test
    @DisplayName("§5 확정 조정: 코스피 매도 10주 잠정 72,000 → 확정 72,100, 농특세 1,081, 현금 +999")
    void confirmSell() {
        Costs provisional = fill(Side.SELL, Instrument.KOSPI, 10, 72_000);

        Confirmation conf = KrxCosts.confirm(provisional, won(72_100), RATES);

        assertThat(conf.confirmed().commission()).isEqualByComparingTo("108");   // 108.15
        assertThat(conf.confirmed().slippage()).isEqualByComparingTo("360");     // 360.5
        assertThat(conf.confirmed().transactionTax()).isEqualByComparingTo("360"); // 360.5
        assertThat(conf.confirmed().ruralTax()).isEqualByComparingTo("1081");    // 1,081.5
        assertThat(conf.confirmed().tax()).isEqualByComparingTo("1441");
        assertThat(conf.confirmed().cashFlow()).isEqualByComparingTo("719091");
        assertThat(conf.cashDelta()).isEqualByComparingTo("999");
    }

    @Test
    @DisplayName("확정 조정: 확정가 = 잠정가면 차이 0, 확정가가 낮은 매도는 현금 음수 차이")
    void confirmNoChangeAndNegative() {
        Costs sell = fill(Side.SELL, Instrument.KOSDAQ, 37, 18_450);

        assertThat(KrxCosts.confirm(sell, won(18_450), RATES).cashDelta()).isEqualByComparingTo("0");
        // 37 × 18,440 = 682,280: 수수료 102·슬리피지 341·거래세 1,364 → +680,473, 잠정 +680,842보다 369 적음
        Confirmation lower = KrxCosts.confirm(sell, won(18_440), RATES);
        assertThat(lower.confirmed().transactionTax()).isEqualByComparingTo("1364");
        assertThat(lower.confirmed().cashFlow()).isEqualByComparingTo("680473");
        assertThat(lower.cashDelta()).isEqualByComparingTo("-369");
    }

    @Test
    @DisplayName("저장된 체결 칸으로 센 현금 흐름 = 계산한 현금 흐름(확정 조정의 잠정 기준)")
    void cashFlowFromStoredColumns() {
        Costs buy = fill(Side.BUY, Instrument.KOSPI, 10, 71_300);
        Costs sell = fill(Side.SELL, Instrument.KOSPI, 10, 72_000);

        assertThat(KrxCosts.cashFlow(Side.BUY, won(713_000), won(106), BigDecimal.ZERO, won(356)))
                .isEqualByComparingTo(buy.cashFlow());
        assertThat(KrxCosts.cashFlow(Side.SELL, won(720_000), won(108), won(1_440), won(360)))
                .isEqualByComparingTo(sell.cashFlow());
        assertThatThrownBy(() -> KrxCosts.cashFlow(Side.BUY, won(713_000), won(106), won(1), won(356)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    // ---- 조사 노트 예시(K31로 다시 셈) ------------------------------------------------------------------------------

    @Test
    @DisplayName("조사 예시 6 — 가격대 경계 49,950원 매수 10주: 체결가 49,950 그대로(옛 안은 50,000으로 올림), 수수료 74·슬리피지 249, 현금 −499,823")
    void bandEdgeBuyFromResearch() {
        Costs c = fill(Side.BUY, Instrument.KOSPI, 10, 49_950);

        assertThat(c.price()).isEqualByComparingTo("49950");
        assertThat(c.commission()).isEqualByComparingTo("74");     // 74.925
        assertThat(c.slippage()).isEqualByComparingTo("249");      // 249.75
        assertThat(c.cashFlow()).isEqualByComparingTo("-499823");  // 옛 안(50,000 체결) −500,075
    }

    // ---- 가격대 경계에서 비용 bp가 뛰지 않음 -------------------------------------------------------------------------

    @Test
    @DisplayName("호가 가격대 경계 앞·위·뒤 모든 가격에서 실효 비용 bp = 설정 합(원 미만 절사만큼만 낮음) — 옛 호가 반올림은 5~25bp로 뛰었음")
    void costBpDoesNotJumpAtBandEdges() {
        // 주식: 각 경계의 한 호가 아래·경계·한 호가 위. ETF: 2,000원 경계와 명세 예시 95,000원.
        long[] stockPrices = {1_999, 2_000, 2_005, 4_995, 5_000, 5_010, 19_990, 20_000, 20_050, 49_950, 50_000, 50_100,
                199_900, 200_000, 200_500, 499_500, 500_000, 501_000};
        long[] etfPrices = {1_999, 2_000, 2_005, 94_995, 95_000, 95_005};
        BigDecimal buyBp = new BigDecimal("6.5");    // 수수료 1.5 + 슬리피지 5
        BigDecimal sellBp = new BigDecimal("26.5");  // + 코스피 5 + 15, 코스닥 20
        List<String> seen = new ArrayList<>();
        for (long p : stockPrices) {
            for (Instrument inst : List.of(Instrument.KOSPI, Instrument.KOSDAQ)) {
                assertCostBp(Side.BUY, inst, p, buyBp, seen);
                assertCostBp(Side.SELL, inst, p, sellBp, seen);
            }
        }
        for (long p : etfPrices) {
            assertCostBp(Side.BUY, Instrument.ETF, p, buyBp, seen);
            assertCostBp(Side.SELL, Instrument.ETF, p, buyBp, seen);   // ETF 매도 세금 0
        }
        assertThat(seen).hasSize(stockPrices.length * 4 + etfPrices.length * 2);
    }

    /** 체결 금액 1,000만 원 이상이 되게 수량을 잡아, 절사로 잃는 몫(비용 칸 4개 × 1원 미만)이 0.004bp 미만이게 합니다. */
    private static void assertCostBp(Side side, Instrument inst, long price, BigDecimal configured, List<String> seen) {
        int qty = (int) Math.ceilDiv(10_000_000L, price);
        Costs c = fill(side, inst, qty, price);

        assertThat(c.price()).as("체결가 = 관측가 %s %s %d", side, inst, price).isEqualByComparingTo(won(price));
        assertThat(c.effectiveBp()).as("실효 bp %s %s %d", side, inst, price)
                .isLessThanOrEqualTo(configured)
                .isGreaterThanOrEqualTo(configured.subtract(new BigDecimal("0.004")));
        seen.add(side + " " + inst + " " + price);
    }

    @Test
    @DisplayName("명세 §4-3의 옛 안이 뛰던 자리(19,990→20,000·20,000→20,050·200,000→200,500·95,000→95,050)도 매수 비용 bp는 같음")
    void formerJumpPointsAreFlat() {
        BigDecimal low = fill(Side.BUY, Instrument.KOSPI, 1_000, 19_990).effectiveBp();
        BigDecimal edge = fill(Side.BUY, Instrument.KOSPI, 1_000, 20_000).effectiveBp();
        BigDecimal big = fill(Side.BUY, Instrument.KOSPI, 100, 200_000).effectiveBp();
        BigDecimal etf = fill(Side.BUY, Instrument.ETF, 400, 95_000).effectiveBp();

        assertThat(List.of(low, edge, big, etf)).allSatisfy(bp ->
                assertThat(bp.subtract(new BigDecimal("6.5")).abs()).isLessThan(new BigDecimal("0.01")));
    }

    // ---- 세금 ------------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("2026 세율 상수 = 코스피 5bp + 농특 15bp, 코스닥 20bp, ETF 0, 시행 2026-01-01")
    void taxRates2026() {
        TaxRates t = TaxRates.KRX_2026;

        assertThat(t.effectiveFrom()).isEqualTo(LocalDate.of(2026, 1, 1));
        assertThat(t.kospiSttBp()).isEqualByComparingTo("5");
        assertThat(t.kospiRuralBp()).isEqualByComparingTo("15");
        assertThat(t.kosdaqSttBp()).isEqualByComparingTo("20");
        assertThat(t.etfBp()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("매수에는 세금이 없고, 매도 세금은 시장별·세목별 설정값을 따름(ETF 설정이 0이 아니면 그 값, 농특세는 코스피만)")
    void taxBySideAndMarket() {
        assertThat(fill(Side.BUY, Instrument.KOSPI, 10, 72_000).tax()).isEqualByComparingTo("0");
        assertThat(fill(Side.BUY, Instrument.KOSDAQ, 10, 72_000).tax()).isEqualByComparingTo("0");

        TaxRates changed = new TaxRates(LocalDate.of(2027, 1, 1), BigDecimal.valueOf(8), BigDecimal.valueOf(15),
                BigDecimal.valueOf(25), BigDecimal.valueOf(10));
        Rates rates = new Rates(new BigDecimal("1.5"), BigDecimal.valueOf(5), changed);
        LocalDate day = LocalDate.of(2027, 1, 4);

        Costs kospi = KrxCosts.fill(Side.SELL, Instrument.KOSPI, day, 10, won(72_000), rates);
        Costs kosdaq = KrxCosts.fill(Side.SELL, Instrument.KOSDAQ, day, 10, won(72_000), rates);
        Costs etf = KrxCosts.fill(Side.SELL, Instrument.ETF, day, 10, won(72_000), rates);
        assertThat(kospi.transactionTax()).isEqualByComparingTo("576");   // 720,000 × 8bp
        assertThat(kospi.ruralTax()).isEqualByComparingTo("1080");
        assertThat(kosdaq.transactionTax()).isEqualByComparingTo("1800"); // 25bp
        assertThat(kosdaq.ruralTax()).isEqualByComparingTo("0");
        assertThat(etf.transactionTax()).isEqualByComparingTo("720");     // 10bp
        assertThat(etf.ruralTax()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("세율 시행일 전 매도는 세율을 모름 — 예외(짐작하지 않음), 같은 날 매수는 세금이 없어 계산됨")
    void sellBeforeEffectiveFromFailsClosed() {
        LocalDate before = LocalDate.of(2025, 12, 30);

        assertThatThrownBy(() -> KrxCosts.fill(Side.SELL, Instrument.KOSPI, before, 10, won(72_000), RATES))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("세율 모름");
        assertThatThrownBy(() -> KrxCosts.fill(Side.SELL, Instrument.ETF, before, 10, won(72_000), RATES))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(KrxCosts.fill(Side.BUY, Instrument.KOSPI, before, 10, won(71_300), RATES).cashFlow())
                .isEqualByComparingTo("-713462");
        // 시행일 당일은 그 세율
        assertThat(KrxCosts.fill(Side.SELL, Instrument.KOSPI, LocalDate.of(2026, 1, 2), 10, won(72_000), RATES)
                .cashFlow()).isEqualByComparingTo("718092");
    }

    // ---- 매수 가능 수량 ------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("매수 가능 수량: 원 미만 절사로 한 주가 더 들어가는 예산 경계(10,001원 × 10주 = 유출 100,075)")
    void affordableQtyUsesTruncatedCosts() {
        // 절사 전 한 주당 유출 10,007.50065원 × 10 = 100,075.0065 > 100,075지만, 절사한 비용 15 + 50으로 유출은 정확히 100,075
        assertThat(fill(Side.BUY, Instrument.KOSPI, 10, 10_001).cashFlow()).isEqualByComparingTo("-100075");
        assertThat(KrxCosts.affordableQty(won(100_075), won(10_001), RATES)).isEqualTo(10);
        assertThat(KrxCosts.affordableQty(won(100_074), won(10_001), RATES)).isEqualTo(9);
        // 1원짜리는 비용이 모두 절사돼 예산만큼
        assertThat(KrxCosts.affordableQty(won(1_000), won(1), RATES)).isEqualTo(1_000);
    }

    @Test
    @DisplayName("매수 가능 수량: 예산 0 이하·한 주 값보다 적으면 0, 결과 수량의 유출은 늘 예산 이하이고 한 주 더면 초과")
    void affordableQtyBounds() {
        assertThat(KrxCosts.affordableQty(BigDecimal.ZERO, won(49_950), RATES)).isZero();
        assertThat(KrxCosts.affordableQty(won(-1), won(49_950), RATES)).isZero();
        assertThat(KrxCosts.affordableQty(won(49_950), won(49_950), RATES)).isZero();   // 수수료·슬리피지 몫이 모자람
        assertThat(KrxCosts.affordableQty(won(49_980), won(49_950), RATES)).isZero();
        assertThat(KrxCosts.affordableQty(won(49_981), won(49_950), RATES)).isEqualTo(1);   // 49,950 + 7 + 24

        for (long budget : new long[]{100_000_000L, 38_024_700L, 38_024_699L, 1_234_567L}) {
            for (long price : new long[]{1_999, 18_450, 49_950, 95_000, 501_000}) {
                int q = KrxCosts.affordableQty(won(budget), won(price), RATES);
                if (q > 0) {
                    assertThat(fill(Side.BUY, Instrument.KOSPI, q, price).cashFlow().negate())
                            .isLessThanOrEqualTo(won(budget));
                }
                assertThat(fill(Side.BUY, Instrument.KOSPI, q + 1, price).cashFlow().negate())
                        .isGreaterThan(won(budget));
            }
        }
        // §5 ETF 예: 400주 유출이 정확히 38,024,700 → 예산이 그만큼이면 400주, 1원 모자라면 399주
        assertThat(KrxCosts.affordableQty(won(38_024_700), won(95_000), RATES)).isEqualTo(400);
        assertThat(KrxCosts.affordableQty(won(38_024_699), won(95_000), RATES)).isEqualTo(399);
    }

    // ---- 호가표 ------------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("주식 호가단위: 2천 미만 1 · 5천 미만 5 · 2만 미만 10 · 5만 미만 50 · 20만 미만 100 · 50만 미만 500 · 이상 1,000")
    void stockTickSize() {
        long[][] cases = {{1, 1}, {1_999, 1}, {2_000, 5}, {4_995, 5}, {5_000, 10}, {19_990, 10}, {20_000, 50},
                {49_950, 50}, {50_000, 100}, {199_900, 100}, {200_000, 500}, {499_500, 500}, {500_000, 1_000},
                {1_500_000, 1_000}};
        for (long[] c : cases) {
            for (Instrument inst : List.of(Instrument.KOSPI, Instrument.KOSDAQ)) {
                assertThat(KrxCosts.tickSize(inst, won(c[0]))).as("%s %d", inst, c[0]).isEqualByComparingTo(won(c[1]));
            }
        }
        // 원 미만이 붙은 값도 그 가격대(1,999.5는 2천 미만)
        assertThat(KrxCosts.tickSize(Instrument.KOSPI, new BigDecimal("1999.5"))).isEqualByComparingTo("1");
    }

    @Test
    @DisplayName("ETF 호가단위: 2,000원 미만 1 · 이상 5")
    void etfTickSize() {
        assertThat(KrxCosts.tickSize(Instrument.ETF, won(1_999))).isEqualByComparingTo("1");
        assertThat(KrxCosts.tickSize(Instrument.ETF, won(2_000))).isEqualByComparingTo("5");
        assertThat(KrxCosts.tickSize(Instrument.ETF, won(95_000))).isEqualByComparingTo("5");
        assertThat(KrxCosts.tickSize(Instrument.ETF, won(600_000))).isEqualByComparingTo("5");
    }

    @Test
    @DisplayName("호가 점검: 호가에 맞는 관측가만 참, 안 맞아도 체결가는 관측가 그대로(경고는 부르는 쪽)")
    void onTickCheck() {
        assertThat(KrxCosts.onTick(Instrument.KOSPI, won(71_300))).isTrue();
        assertThat(KrxCosts.onTick(Instrument.KOSPI, won(71_350))).isFalse();     // 5만~20만 호가 100
        assertThat(KrxCosts.onTick(Instrument.KOSDAQ, won(18_450))).isTrue();
        assertThat(KrxCosts.onTick(Instrument.KOSDAQ, won(18_455))).isFalse();    // 5천~2만 호가 10
        assertThat(KrxCosts.onTick(Instrument.KOSPI, won(500_000))).isTrue();
        assertThat(KrxCosts.onTick(Instrument.KOSPI, won(500_500))).isFalse();    // 50만 이상 호가 1,000
        assertThat(KrxCosts.onTick(Instrument.ETF, won(95_005))).isTrue();
        assertThat(KrxCosts.onTick(Instrument.ETF, won(95_003))).isFalse();
        assertThat(KrxCosts.onTick(Instrument.ETF, won(1_999))).isTrue();
        assertThat(KrxCosts.onTick(Instrument.KOSPI, new BigDecimal("71300.000000"))).isTrue();   // NUMERIC(18,6) 꼴
        assertThat(KrxCosts.onTick(Instrument.KOSPI, new BigDecimal("1500.5"))).isFalse();

        Costs offTick = fill(Side.BUY, Instrument.KOSPI, 10, 71_350);
        assertThat(offTick.price()).isEqualByComparingTo("71350");
        assertThat(offTick.notional()).isEqualByComparingTo("713500");
    }

    // ---- 종목 구분·입력 검사 ----------------------------------------------------------------------------------------

    @Test
    @DisplayName("종목 구분: 설정 ETF 목록이면 ETF, KOSPI·KOSDAQ은 그대로, 코넥스·빈 값·모르는 값은 없음(주문 보류)")
    void classify() {
        assertThat(KrxCosts.classify("KOSPI", false)).contains(Instrument.KOSPI);
        assertThat(KrxCosts.classify(" KOSDAQ ", false)).contains(Instrument.KOSDAQ);
        assertThat(KrxCosts.classify(null, true)).contains(Instrument.ETF);
        assertThat(KrxCosts.classify("KOSPI", true)).contains(Instrument.ETF);
        assertThat(KrxCosts.classify("KONEX", false)).isEmpty();
        assertThat(KrxCosts.classify("", false)).isEmpty();
        assertThat(KrxCosts.classify(null, false)).isEmpty();
        assertThat(KrxCosts.classify("kospi", false)).isEmpty();
    }

    @Test
    @DisplayName("요율 0이면 비용 0, 현금 흐름 = 체결 금액")
    void zeroRates() {
        TaxRates noTax = new TaxRates(LocalDate.of(2026, 1, 1), BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO,
                BigDecimal.ZERO);
        Rates zero = new Rates(BigDecimal.ZERO, BigDecimal.ZERO, noTax);

        Costs c = KrxCosts.fill(Side.SELL, Instrument.KOSPI, DAY, 10, won(72_000), zero);

        assertThat(c.total()).isEqualByComparingTo("0");
        assertThat(c.cashFlow()).isEqualByComparingTo("720000");
        assertThat(c.effectiveBp()).isEqualByComparingTo("0");
        assertThat(KrxCosts.affordableQty(won(720_000), won(72_000), zero)).isEqualTo(10);
    }

    @Test
    @DisplayName("입력 검사: 수량 1 미만·가격 0 이하·요율 음수/10,000bp 이상·null은 거절")
    void rejectsBadInput() {
        assertThatThrownBy(() -> fill(Side.BUY, Instrument.KOSPI, 0, 71_300)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fill(Side.BUY, Instrument.KOSPI, -1, 71_300)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fill(Side.BUY, Instrument.KOSPI, 10, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fill(Side.SELL, Instrument.KOSPI, 10, -5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrxCosts.fill(Side.BUY, Instrument.KOSPI, DAY, 10, null, RATES))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> KrxCosts.fill(Side.BUY, Instrument.KOSPI, null, 10, won(71_300), RATES))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new Rates(BigDecimal.valueOf(-1), BigDecimal.valueOf(5), TaxRates.KRX_2026))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Rates(new BigDecimal("1.5"), BigDecimal.valueOf(10_000), TaxRates.KRX_2026))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Rates(new BigDecimal("1.5"), BigDecimal.valueOf(5), null))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new TaxRates(LocalDate.of(2026, 1, 1), BigDecimal.valueOf(-5), BigDecimal.ZERO,
                BigDecimal.ZERO, BigDecimal.ZERO)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TaxRates(null, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO))
                .isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> KrxCosts.affordableQty(won(1_000_000), BigDecimal.ZERO, RATES))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrxCosts.tickSize(Instrument.ETF, BigDecimal.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrxCosts.confirm(fill(Side.BUY, Instrument.KOSPI, 10, 71_300), BigDecimal.ZERO, RATES))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("체결 레코드는 맞지 않는 칸(금액 ≠ 수량 × 가격, 매수에 세금, 음수 비용)을 받지 않음")
    void costsRecordGuards() {
        BigDecimal z = BigDecimal.ZERO;
        assertThatThrownBy(() -> new Costs(Side.BUY, Instrument.KOSPI, DAY, 10, won(71_300), won(713_001), won(106), z, z,
                won(356))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Costs(Side.BUY, Instrument.KOSPI, DAY, 10, won(71_300), won(713_000), won(106),
                won(1), z, won(356))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Costs(Side.SELL, Instrument.KOSPI, DAY, 10, won(72_000), won(720_000), won(-1), z, z,
                z)).isInstanceOf(IllegalArgumentException.class);
        // 같은 칸으로 손으로 만든 레코드 = 계산 결과(저장본에서 다시 만들 때)
        Costs rebuilt = new Costs(Side.SELL, Instrument.KOSPI, DAY, 10, won(72_000), won(720_000), won(108), won(360),
                won(1_080), won(360));
        assertThat(rebuilt).isEqualTo(fill(Side.SELL, Instrument.KOSPI, 10, 72_000));
    }

    @Test
    @DisplayName("비용은 십진수로 절사 — 49,950원 × 400주의 수수료는 2,997(double 19,980,000 × 0.00015 = 2,996.99…로 1원 어긋남)")
    void decimalNotDouble() {
        assertThat(Math.floor(19_980_000 * (1.5 / 10_000.0))).isEqualTo(2_996.0);   // 이 클래스가 double을 쓰지 않는 이유

        Costs c = fill(Side.BUY, Instrument.KOSPI, 400, 49_950);

        assertThat(c.commission()).isEqualByComparingTo("2997");
        assertThat(c.slippage()).isEqualByComparingTo("9990");
    }
}
