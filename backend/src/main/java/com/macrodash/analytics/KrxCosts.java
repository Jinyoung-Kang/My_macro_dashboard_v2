package com.macrodash.analytics;

import com.macrodash.analytics.PaperLedger.Side;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/**
 * 🧪 한국 증시(KRX 유가증권·코스닥·ETF) 체결 비용 — 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-3·K5·K31, §5 '비용이 손계산과 같다'.
 *
 * <pre>
 *  체결 금액   = 수량 × 체결가          (체결가 = 관측가 그대로 — 슬리피지·호가 반올림을 얹지 않음, K31)
 *  수수료      = 체결 금액 × commissionBp   (매수·매도 각각, 최소 수수료 없음 — 가정)
 *  슬리피지    = 체결 금액 × slippageBp     (가격이 아니라 비용 칸 slippage_cost, K31)
 *  증권거래세  = 체결 금액 × (코스피 5bp · 코스닥 20bp · ETF 0)   (매도만)
 *  농어촌특별세 = 체결 금액 × (코스피 15bp, 그 밖 0)               (매도만)
 *  비용마다 따로 원 미만 절사(가정)
 *  현금 흐름   = 매수 −(금액 + 수수료 + 슬리피지) · 매도 +(금액 − 수수료 − 슬리피지 − 거래세 − 농특세)
 * </pre>
 *
 * <p><b>슬리피지를 체결가에 얹지 않는 이유</b>(K31): 초안의 '관측가 × (1 ± bp)를 불리한 쪽 호가로 반올림'은 [확인, Decimal 재계산]
 * 매수 실효 비용이 가격대에 따라 5~25bp로 뛰었습니다(20,000원에서 한 호가 50원 = 25bp). KRX 단일가 체결가는 늘 호가 위에 있고
 * 단일가에는 스프레드가 없어([추정]) 한 호가를 더 얹으면 비용을 이중으로 셉니다. 그래서 체결가는 관측가 그대로이고 슬리피지는 수수료처럼
 * 금액으로 따로 뺍니다 — 실효 비용 bp는 가격대와 상관없이 설정값(원 미만 절사 차이뿐)입니다. 미국 책은 같은 5bp를 체결가에 얹습니다
 * ({@link PaperLedger#fillPrice}) — 기록 위치만 다릅니다.
 *
 * <p><b>호가표</b>는 관측가 점검(호가에 안 맞으면 부르는 쪽이 경고를 남기고 값은 그대로 씀)과 화면 표시에만 씁니다. 체결가를 호가로
 * 고치지 않으므로 매수 가능 수량({@link #affordableQty})도 받은 가격 그대로 셉니다.
 *
 * <p>세율은 [확인] 증권거래세법 시행령 제5조(대통령령 제36001호, 2026-01-01 시행 — 코스피 1만분의 5, 코스닥 1만분의 20)·
 * 농어촌특별세법 제5조①5와 그 시행령 제5조①(유가증권시장만 1만분의 15)이고, ETF는 과세 대상 '주권'이 아니라 0입니다([추정] +
 * [2차] 증권사 안내 '미징수'). 수수료 1.5bp·원 미만 절사는 가정입니다(화면에 적음, §6).
 *
 * <p>순수 계산입니다(이 패키지는 {@code java.*}만). 요율은 부르는 쪽이 설정 {@code kr.*}(C1)에서 읽어 {@link Rates}로 넘깁니다 —
 * 확정 조정({@link #confirm})은 지금 설정이 아니라 <b>그 체결 때의 판</b>을 넘겨야 수수료 요율 변경이 확정 차이에 섞이지 않습니다.
 * 금액은 십진수로만 셉니다 — double로 곱하면 19,980,000(49,950원 × 400주) × 0.00015가 2,996.99…가 되어 절사한 수수료가 2,997이
 * 아니라 2,996이 됩니다.
 */
public final class KrxCosts {

    private KrxCosts() {
    }

    /** 1bp = 0.01%. */
    private static final BigDecimal BP = BigDecimal.valueOf(10_000);
    /** 실효 비용 bp의 소수 자릿수(화면 표시용 계산값). */
    private static final int EFFECTIVE_BP_SCALE = 4;

    /** 주식 호가단위 가격대 하한(원) — 이 값 이상이면 다음 호가. 코스피·코스닥 공통. */
    private static final long[] STOCK_BAND_FLOORS = {2_000, 5_000, 20_000, 50_000, 200_000, 500_000};
    /** 가격대별 주식 호가단위(원) — {@link #STOCK_BAND_FLOORS}보다 하나 많음(첫 값은 2,000원 미만). */
    private static final long[] STOCK_TICKS = {1, 5, 10, 50, 100, 500, 1_000};
    /** ETF 호가가 1원에서 5원으로 바뀌는 가격(원). */
    private static final long ETF_BAND_FLOOR = 2_000;

    /**
     * 비용 계산의 종목 구분 — 세율과 호가표가 이것으로 갈립니다.
     *
     * <p>시장은 금융위 시세의 {@code mrktCtg}(수집기 {@code market}), ETF는 설정 목록({@code kr.cashLikeTickers}·벤치마크 종목)으로
     * 정합니다({@link #classify}). 코넥스·K-OTC·시장을 모르는 종목은 여기 없습니다 — 부르는 쪽이 주문을 보류합니다.
     */
    public enum Instrument {
        /** 유가증권시장 주권 — 매도 거래세 + 농특세, 주식 호가표. */
        KOSPI,
        /** 코스닥시장 주권 — 매도 거래세(농특세 없음), 주식 호가표. */
        KOSDAQ,
        /** 국내 상장 ETF(수익증권) — 매도 세금 {@link TaxRates#etfBp()}(기본 0), ETF 호가표. */
        ETF
    }

    /**
     * 종목 구분.
     *
     * @param market 금융위 시세의 시장 구분({@code KOSPI}·{@code KOSDAQ}·{@code KONEX}, 앞뒤 공백 무시). ETF면 보지 않습니다
     * @param etf    설정의 ETF 목록에 든 종목인지 — 참이면 시장 구분과 상관없이 ETF(ETF는 주식시세 API에 없음)
     * @return 코넥스·빈 값·모르는 값이면 empty(주문 보류 — 세율·호가를 짐작하지 않음)
     */
    public static Optional<Instrument> classify(String market, boolean etf) {
        if (etf) {
            return Optional.of(Instrument.ETF);
        }
        if (market == null) {
            return Optional.empty();
        }
        return switch (market.strip()) {
            case "KOSPI" -> Optional.of(Instrument.KOSPI);
            case "KOSDAQ" -> Optional.of(Instrument.KOSDAQ);
            default -> Optional.empty();
        };
    }

    /**
     * 매도 세율(bp)과 그 시행일 — 설정 {@code kr.tax.*}(§4-3). 세목마다 따로 두어 한 세목만 바뀌는 개정에 맞춥니다.
     *
     * @param effectiveFrom 이 세율의 시행일({@code kr.tax.effectiveFrom}). 이보다 이른 매도는 세율을 모름({@link #fill})
     * @param kospiSttBp    코스피 증권거래세({@code kr.tax.kospi.sttBp})
     * @param kospiRuralBp  코스피 농어촌특별세({@code kr.tax.kospi.ruralBp})
     * @param kosdaqSttBp   코스닥 증권거래세({@code kr.tax.kosdaq.sttBp}) — 코스닥에는 농특세가 없음(농특세법 시행령 제5조①)
     * @param etfBp         ETF 매도 세금({@code kr.tax.etfBp}) — 농특세 없음
     * @throws IllegalArgumentException null, 세율이 0 미만·10,000bp 이상
     */
    public record TaxRates(LocalDate effectiveFrom, BigDecimal kospiSttBp, BigDecimal kospiRuralBp,
                           BigDecimal kosdaqSttBp, BigDecimal etfBp) {

        /** 2026-01-01 시행 세율 — 코스피 5bp + 15bp, 코스닥 20bp, ETF 0(클래스 설명의 법령). {@code kr.tax.*}의 기본값. */
        public static final TaxRates KRX_2026 = new TaxRates(LocalDate.of(2026, 1, 1),
                BigDecimal.valueOf(5), BigDecimal.valueOf(15), BigDecimal.valueOf(20), BigDecimal.ZERO);

        public TaxRates {
            Objects.requireNonNull(effectiveFrom, "세율 시행일이 없습니다");
            requireBp(kospiSttBp, "코스피 증권거래세");
            requireBp(kospiRuralBp, "코스피 농어촌특별세");
            requireBp(kosdaqSttBp, "코스닥 증권거래세");
            requireBp(etfBp, "ETF 매도 세금");
        }
    }

    /**
     * 한 체결에 쓰는 요율 — 설정 {@code kr.commissionBp}·{@code kr.slippageBp}·{@code kr.tax.*}의 한 판.
     *
     * @param commissionBp 수수료(매수·매도 각각, 유관기관 제비용 포함으로 봄 — 가정)
     * @param slippageBp   슬리피지(비용 칸, K31)
     * @throws IllegalArgumentException null, 요율이 0 미만·10,000bp 이상
     */
    public record Rates(BigDecimal commissionBp, BigDecimal slippageBp, TaxRates tax) {
        public Rates {
            requireBp(commissionBp, "수수료");
            requireBp(slippageBp, "슬리피지");
            Objects.requireNonNull(tax, "세율이 없습니다");
        }
    }

    /**
     * 체결 한 건의 금액과 비용 칸. 비용은 원 단위 정수(원 미만 절사), 체결 금액은 수량 × 체결가 그대로입니다.
     *
     * <p>저장 열과의 대응: {@code paper_fills.price} = {@link #price}(관측가), {@code fee} = {@link #commission},
     * {@code tax} = {@link #tax()}(거래세 + 농특세), {@code slippage_cost} = {@link #slippage}.
     *
     * @throws IllegalArgumentException null, 수량 1 미만, 가격·금액 0 이하, 금액 ≠ 수량 × 체결가, 비용 음수, 매수에 세금
     */
    public record Costs(Side side, Instrument instrument, LocalDate tradeDate, int qty, BigDecimal price,
                        BigDecimal notional, BigDecimal commission, BigDecimal transactionTax, BigDecimal ruralTax,
                        BigDecimal slippage) {

        public Costs {
            Objects.requireNonNull(side, "side");
            Objects.requireNonNull(instrument, "instrument");
            Objects.requireNonNull(tradeDate, "체결일이 없습니다");
            requireQty(qty);
            requirePrice(price);
            requirePrice(notional);
            if (notional.compareTo(price.multiply(BigDecimal.valueOf(qty))) != 0) {
                throw new IllegalArgumentException("체결 금액이 수량 × 체결가와 다릅니다: " + notional + " ≠ " + qty + " × " + price);
            }
            requireCost(commission, "수수료");
            requireCost(transactionTax, "증권거래세");
            requireCost(ruralTax, "농어촌특별세");
            requireCost(slippage, "슬리피지");
            if (side == Side.BUY && (transactionTax.signum() != 0 || ruralTax.signum() != 0)) {
                throw new IllegalArgumentException("매수에는 세금이 없습니다: 거래세 " + transactionTax + ", 농특세 " + ruralTax);
            }
        }

        /** 세금 합 = 증권거래세 + 농어촌특별세({@code paper_fills.tax}). */
        public BigDecimal tax() {
            return transactionTax.add(ruralTax);
        }

        /** 비용 합 = 수수료 + 세금 + 슬리피지. */
        public BigDecimal total() {
            return commission.add(tax()).add(slippage);
        }

        /** 현금 흐름(매수 음수, 매도 양수) — {@link KrxCosts#cashFlow}. */
        public BigDecimal cashFlow() {
            return KrxCosts.cashFlow(side, notional, commission, tax(), slippage);
        }

        /**
         * 실효 비용 bp = 비용 합 ÷ 체결 금액 × 10,000(소수 4자리, 반올림) — 화면이 체결마다 보이는 계산값. 가격대와 상관없이 설정 요율의 합에서
         * 원 미만 절사만큼만 낮습니다.
         */
        public BigDecimal effectiveBp() {
            return total().multiply(BP).divide(notional, EFFECTIVE_BP_SCALE, RoundingMode.HALF_UP);
        }
    }

    /**
     * 확정 조정 금액(K29) — {@code paper_fill_confirmations} 한 행.
     *
     * @param confirmed 확정가로 다시 계산한 체결(가격 = {@code confirmed_price}, 비용 칸 = {@code fee}·{@code tax}·{@code slippage_cost})
     * @param cashDelta 확정 기준 현금 흐름 − 잠정 기준 현금 흐름({@code cash_delta}, 음수 가능)
     */
    public record Confirmation(Costs confirmed, BigDecimal cashDelta) {
        public Confirmation {
            Objects.requireNonNull(confirmed, "confirmed");
            Objects.requireNonNull(cashDelta, "cashDelta");
        }
    }

    /**
     * 체결 한 건의 비용(클래스 설명의 식). 예: 코스피 매도 10주 72,000원 → 금액 720,000, 수수료 108, 슬리피지 360, 거래세 360,
     * 농특세 1,080, 현금 +718,092.
     *
     * @param price 체결가 = 관측가 그대로(호가에 안 맞아도 고치지 않음 — 점검은 {@link #onTick})
     * @throws IllegalArgumentException 수량 1 미만, 가격 0 이하, 매도인데 체결일이 세율 시행일보다 이름(세율을 모름 — 짐작하지 않음)
     */
    public static Costs fill(Side side, Instrument instrument, LocalDate tradeDate, int qty, BigDecimal price,
                             Rates rates) {
        Objects.requireNonNull(side, "side");
        Objects.requireNonNull(instrument, "instrument");
        Objects.requireNonNull(tradeDate, "체결일이 없습니다");
        Objects.requireNonNull(rates, "요율이 없습니다");
        requireQty(qty);
        requirePrice(price);
        BigDecimal notional = price.multiply(BigDecimal.valueOf(qty));
        BigDecimal commission = wonFloor(notional, rates.commissionBp());
        BigDecimal slippage = wonFloor(notional, rates.slippageBp());
        BigDecimal transactionTax = BigDecimal.ZERO;
        BigDecimal ruralTax = BigDecimal.ZERO;
        if (side == Side.SELL) {
            TaxRates tax = rates.tax();
            if (tradeDate.isBefore(tax.effectiveFrom())) {
                throw new IllegalArgumentException("세율 모름 — 매도 체결일 " + tradeDate + "이(가) 세율 시행일 "
                        + tax.effectiveFrom() + "보다 이릅니다(그 전 세율은 설정에 없음)");
            }
            switch (instrument) {
                case KOSPI -> {
                    transactionTax = wonFloor(notional, tax.kospiSttBp());
                    ruralTax = wonFloor(notional, tax.kospiRuralBp());
                }
                case KOSDAQ -> transactionTax = wonFloor(notional, tax.kosdaqSttBp());
                case ETF -> transactionTax = wonFloor(notional, tax.etfBp());
            }
        }
        return new Costs(side, instrument, tradeDate, qty, price, notional, commission, transactionTax, ruralTax,
                slippage);
    }

    /**
     * 현금 흐름 — 매수 −(금액 + 수수료 + 슬리피지), 매도 +(금액 − 수수료 − 세금 − 슬리피지). 저장된 체결 행의 칸({@code price × qty}·
     * {@code fee}·{@code tax}·{@code slippage_cost})으로 잠정 기준 현금 흐름을 다시 셀 때도 씁니다.
     *
     * @throws IllegalArgumentException null, 금액 0 이하, 비용 음수, 매수에 세금
     */
    public static BigDecimal cashFlow(Side side, BigDecimal notional, BigDecimal fee, BigDecimal tax,
                                      BigDecimal slippageCost) {
        Objects.requireNonNull(side, "side");
        requirePrice(notional);
        requireCost(fee, "수수료");
        requireCost(tax, "세금");
        requireCost(slippageCost, "슬리피지");
        if (side == Side.BUY) {
            if (tax.signum() != 0) {
                throw new IllegalArgumentException("매수에는 세금이 없습니다: " + tax);
            }
            return notional.add(fee).add(slippageCost).negate();
        }
        return notional.subtract(fee).subtract(tax).subtract(slippageCost);
    }

    /**
     * 확정 조정(K29): 같은 체결(매매 방향·종목·체결일·수량)을 확정가로 다시 계산하고 현금 차이를 냅니다. 체결 행은 고치지 않고 이 값을
     * 확정 조정 행으로 남깁니다. 예: 매수 10주 잠정 71,300 → 확정 71,200이면 수수료 106·슬리피지 356 그대로, 현금 +1,000.
     *
     * @param provisional   잠정 체결({@link #fill})
     * @param confirmedPrice 금융위 확정가(시가 체결이면 {@code mkp}, 종가 체결이면 {@code clpr})
     * @param rates         <b>그 체결 때의</b> 요율 판(지금 설정이 아님 — 클래스 설명)
     * @throws IllegalArgumentException 확정가 0 이하
     */
    public static Confirmation confirm(Costs provisional, BigDecimal confirmedPrice, Rates rates) {
        Objects.requireNonNull(provisional, "provisional");
        Costs confirmed = fill(provisional.side(), provisional.instrument(), provisional.tradeDate(),
                provisional.qty(), confirmedPrice, rates);
        return new Confirmation(confirmed, confirmed.cashFlow().subtract(provisional.cashFlow()));
    }

    /**
     * 예산 안에서 살 수 있는 최대 정수 주식 수 — 수수료·슬리피지(원 미만 절사 뒤)까지 포함한 현금 유출이 예산 이하. 예: 예산
     * 1,000,000원·49,950원 → 20주(유출 999,648, 21주는 1,049,631로 초과).
     *
     * <p>가격은 받은 그대로입니다(체결가 = 관측가, 호가로 고치지 않음 — 클래스 설명). 예산은 부르는 쪽이 정합니다(목표 금액과 현금 중 작은 쪽 등).
     *
     * @return 예산 ≤ 0이거나 한 주도 못 사면 0
     * @throws IllegalArgumentException 가격 0 이하, 결과가 int 범위를 넘음
     */
    public static int affordableQty(BigDecimal budget, BigDecimal price, Rates rates) {
        Objects.requireNonNull(budget, "예산이 없습니다");
        Objects.requireNonNull(rates, "요율이 없습니다");
        requirePrice(price);
        if (budget.signum() <= 0) {
            return 0;
        }
        // 절사 전 비용으로 센 한 주당 유출 — 절사한 유출은 이보다 크지 않으므로 이 내림 수량은 늘 예산 안입니다.
        BigDecimal perShare = price.multiply(BigDecimal.ONE.add(
                rates.commissionBp().add(rates.slippageBp()).divide(BP)));
        BigDecimal floor = budget.divide(perShare, 0, RoundingMode.FLOOR);
        if (floor.compareTo(BigDecimal.valueOf(Integer.MAX_VALUE)) >= 0) {
            throw new IllegalArgumentException("살 수 있는 수량이 int 범위를 넘습니다: 예산 " + budget + ", 가격 " + price);
        }
        long qty = floor.longValueExact();
        // 비용 칸마다 1원 미만을 버리므로 한두 주 더 들어갈 수 있습니다(늘어나는 폭은 2원 ÷ 한 주당 유출 + 1주 이하).
        while (buyOutflow(qty + 1, price, rates).compareTo(budget) <= 0) {
            qty++;
        }
        if (qty > Integer.MAX_VALUE) {
            throw new IllegalArgumentException("살 수 있는 수량이 int 범위를 넘습니다: 예산 " + budget + ", 가격 " + price);
        }
        return (int) qty;
    }

    /**
     * 호가단위(원). 주식(코스피·코스닥 공통): 2천 미만 1 · 5천 미만 5 · 2만 미만 10 · 5만 미만 50 · 20만 미만 100 · 50만 미만 500 ·
     * 그 이상 1,000([확인] KRX 영문 매매제도 페이지·증권사 2곳). ETF: 2,000원 미만 1 · 이상 5([2차] 3곳 일치, KRX 원문 미확인).
     *
     * @throws IllegalArgumentException 가격 0 이하
     */
    public static BigDecimal tickSize(Instrument instrument, BigDecimal price) {
        Objects.requireNonNull(instrument, "instrument");
        requirePrice(price);
        if (instrument == Instrument.ETF) {
            return BigDecimal.valueOf(price.compareTo(BigDecimal.valueOf(ETF_BAND_FLOOR)) < 0 ? 1 : 5);
        }
        int band = 0;
        while (band < STOCK_BAND_FLOORS.length && price.compareTo(BigDecimal.valueOf(STOCK_BAND_FLOORS[band])) >= 0) {
            band++;
        }
        return BigDecimal.valueOf(STOCK_TICKS[band]);
    }

    /**
     * 호가표를 글로(한국 Claude 패킷 {@code 0_instructions}·{@code 12_hardRules}, E1a — 표를 두 곳에 적지 않게 이 상수에서 만듦):
     * {@code 주식 2,000원 미만 1원 · 2,000원 이상 5원 · … · 500,000원 이상 1,000원 / ETF 2,000원 미만 1원 · 이상 5원}.
     */
    public static String tickTableText() {
        StringBuilder out = new StringBuilder("주식 ");
        for (int band = 0; band < STOCK_TICKS.length; band++) {
            if (band > 0) {
                out.append(" · ");
            }
            out.append(band == 0 ? String.format(Locale.ROOT, "%,d원 미만", STOCK_BAND_FLOORS[0])
                    : String.format(Locale.ROOT, "%,d원 이상", STOCK_BAND_FLOORS[band - 1]));
            out.append(String.format(Locale.ROOT, " %,d원", STOCK_TICKS[band]));
        }
        out.append(String.format(Locale.ROOT, " / ETF %,d원 미만 1원 · 이상 5원", ETF_BAND_FLOOR));
        return out.toString();
    }

    /**
     * 관측가가 호가단위에 맞는지 — 부르는 쪽은 안 맞으면 경고만 남기고 값은 그대로 씁니다(§4-3). 원 미만이 있는 값도 맞지 않습니다.
     *
     * @throws IllegalArgumentException 가격 0 이하
     */
    public static boolean onTick(Instrument instrument, BigDecimal price) {
        return price.remainder(tickSize(instrument, price)).signum() == 0;
    }

    /**
     * 1주를 살 때의 현금 유출 = 가격 + 수수료 + 슬리피지(비용마다 원 미만 절사) — {@link #affordableQty}가 1 이상이 되는 가장 작은 예산.
     * 검증기의 정수 주 매수 문구(OrderValidator {@code BUY_BELOW_ONE_SHARE})가 씁니다. 예: 49,950원 → 49,981(수수료 7·슬리피지 24).
     *
     * @throws IllegalArgumentException 가격 0 이하
     */
    public static BigDecimal oneShareOutflow(BigDecimal price, Rates rates) {
        Objects.requireNonNull(rates, "요율이 없습니다");
        requirePrice(price);
        return buyOutflow(1, price, rates);
    }

    /** 매수 현금 유출 = 금액 + 수수료 + 슬리피지(절사 뒤). */
    private static BigDecimal buyOutflow(long qty, BigDecimal price, Rates rates) {
        BigDecimal notional = price.multiply(BigDecimal.valueOf(qty));
        return notional.add(wonFloor(notional, rates.commissionBp())).add(wonFloor(notional, rates.slippageBp()));
    }

    /** 금액 × bp ÷ 10,000을 원 미만 절사(가정 — 비용은 늘 0 이상이라 내림 = 버림). */
    private static BigDecimal wonFloor(BigDecimal notional, BigDecimal bp) {
        return notional.multiply(bp).divide(BP, 0, RoundingMode.FLOOR);
    }

    private static void requireBp(BigDecimal bp, String what) {
        Objects.requireNonNull(bp, what + " 요율이 없습니다");
        // 음수는 '돈을 받는 비용'이 되고, 10,000bp(100%) 이상이면 비용이 금액을 넘습니다 — 설정 실수이므로 막습니다.
        if (bp.signum() < 0 || bp.compareTo(BP) >= 0) {
            throw new IllegalArgumentException(what + " 요율(bp)은 0 이상 10000 미만이어야 합니다: " + bp);
        }
    }

    private static void requireQty(int qty) {
        if (qty < 1) {
            throw new IllegalArgumentException("수량은 1주 이상이어야 합니다(정수 주): " + qty);
        }
    }

    private static void requirePrice(BigDecimal price) {
        Objects.requireNonNull(price, "가격이 없습니다");
        if (price.signum() <= 0) {
            throw new IllegalArgumentException("가격·금액은 0보다 커야 합니다: " + price);
        }
    }

    private static void requireCost(BigDecimal cost, String what) {
        Objects.requireNonNull(cost, what + "이(가) 없습니다");
        if (cost.signum() < 0) {
            throw new IllegalArgumentException(what + "은(는) 음수일 수 없습니다: " + cost);
        }
    }
}
