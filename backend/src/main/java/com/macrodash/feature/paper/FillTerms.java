package com.macrodash.feature.paper;

import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.UsCosts;
import com.macrodash.feature.paper.PaperMarketData.Bar;

import java.math.BigDecimal;
import java.util.Objects;

/**
 * 주문 하나를 봉 하나로 체결하는 시장 몫(결정 d10, C2a) — 체결가·관측가·가격 출처·슬리피지 기록값, 예산으로 살 수 있는 수량, 수량별
 * 체결 금액·비용 칸·현금 변화. 시장 묶음의 {@link PaperMarket#fill}이 만들고, 장부({@code PaperLedgerService})가 이것으로 체결 행·현금·
 * 보유 평단을 씁니다 — 장부는 체결가를 직접 셈하지 않습니다.
 *
 * <p>미국은 슬리피지를 체결가에 얹고({@link SlippageInPrice} — 이 묶음 전 {@code PaperLedger.fillPrice}·{@code PaperLedgerService.price6}·
 * {@code gross} 그대로) 수수료·매도 제비용(SEC fee·FINRA TAF)이 비용 칸입니다(ADR 0030 — {@code UsCosts}, 요율이 0이면 이 묶음 전 현금 흐름
 * 그대로). 한국은 체결가 = 관측가이고 수수료·세금·슬리피지가 비용 칸입니다(K31 — {@code KrxCosts}, C2b).
 */
interface FillTerms {

    /** 체결가 — {@code paper_fills.price}이고 보유 평단·최고가의 기준(평단은 체결가로만 셈, 비용은 비용 칸 — 결정 d14). */
    double price();

    /** 관측가 — {@code paper_fills.raw_price}. */
    double rawPrice();

    /** 가격 출처 — {@code paper_fills.price_source}. */
    String priceSource();

    /** 슬리피지 설정값의 기록 — {@code paper_fills.slippage_bp}. */
    double slippageBp();

    /**
     * 예산으로 살 수 있는 정수 수량(비용 포함 — 비용 칸이 없는 시장은 체결가로 나눠 내림). 예산은 부르는 쪽이 정합니다(목표 금액 또는
     * 현금). 예산이 0 이하면 0.
     */
    int affordableQty(double budget);

    /** 그 수량의 체결 금액·비용 칸·현금 변화. */
    Costs costs(int qty);

    /**
     * 이 관측치로 체결하지 않고 주문을 대기로 두는 사유 — 체결하면 null(기본). 한국은 비용을 셀 수 없을 때(종목 구분 모름 — 코넥스·
     * 시장 모름, 매도 세율 모름 — §4-3) 짐작하지 않고 보류합니다({@link Hold}). 장부는 이 값이 있으면 체결가·수량을 묻지 않습니다.
     */
    default String holdReason() {
        return null;
    }

    /**
     * 체결과 함께 남길 경고(값은 그대로 씀) — 한국: 시가 사다리를 내려감(1분봉 개장 봉 없음 → 토스 일봉 시가, §4-1·결정 d11)·호가 단위에 안
     * 맞는 관측가(§4-3). 장부가 작업 기록과 그 주문의 근거에 남깁니다. 기본은 없음.
     */
    default java.util.List<String> warnings() {
        return java.util.List.of();
    }

    /** 체결하지 않고 보류하는 체결 조건({@link #holdReason}) — 체결가·수량·비용을 물으면 던집니다(장부가 먼저 사유를 봄). */
    record Hold(String reason) implements FillTerms {

        public Hold {
            Objects.requireNonNull(reason, "reason");
        }

        @Override
        public String holdReason() {
            return reason;
        }

        @Override
        public double price() {
            throw held();
        }

        @Override
        public double rawPrice() {
            throw held();
        }

        @Override
        public String priceSource() {
            throw held();
        }

        @Override
        public double slippageBp() {
            throw held();
        }

        @Override
        public int affordableQty(double budget) {
            throw held();
        }

        @Override
        public Costs costs(int qty) {
            throw held();
        }

        private IllegalStateException held() {
            return new IllegalStateException("보류한 체결 조건입니다 — " + reason);
        }
    }

    /**
     * 체결 한 건의 금액.
     *
     * @param gross        체결 금액({@code paper_fills.gross}) = 수량 × 체결가(소수 4자리)
     * @param fee          수수료 칸({@code paper_fills.fee} — 한국 수수료, 미국 매매 수수료)
     * @param tax          세금 칸({@code paper_fills.tax} — 한국 매도세, 미국 매도 제비용 SEC fee + FINRA TAF)
     * @param slippageCost 슬리피지 비용 칸({@code paper_fills.slippage_cost}, 미국 0 — 미국은 체결가에 들어 있음)
     * @param cashDelta    계좌 현금 변화(매수는 음수) — 장부가 반올림해 더함
     */
    record Costs(double gross, BigDecimal fee, BigDecimal tax, BigDecimal slippageCost, double cashDelta) {

        public Costs {
            Objects.requireNonNull(fee, "fee");
            Objects.requireNonNull(tax, "tax");
            Objects.requireNonNull(slippageCost, "slippageCost");
        }

    }

    /**
     * 슬리피지를 체결가에 얹는 체결(미국 D9) — 체결가 = 관측 종가 × (1 ± bp)를 저장 열(NUMERIC(18,6)) 자리로, 체결 금액 = 수량 × 체결가(4자리),
     * 비용 칸 = 수수료·매도 제비용({@link UsCosts} — ADR 0030, 그 실행 설정 판의 요율), 수량 = 비용 포함 유출이 예산 안인 최대 정수 주.
     * 요율이 모두 0이면 이 묶음 전 장부의 식(비용 칸 없음, 수량 = 예산 ÷ 체결가 내림) 그대로입니다.
     *
     * @param side  주문 방향(BUY·SELL — 매도가 아니면 매수 쪽으로 얹음, 장부가 매수·매도를 따로 부르던 것과 같음)
     * @param rates 미국 비용 요율(설정 {@code commissionBp}·{@code regFees.*}의 그 실행 판 — {@link PaperSettings#usCosts})
     */
    record SlippageInPrice(String side, double price, double rawPrice, String priceSource, double slippageBp,
                           UsCosts.Rates rates) implements FillTerms {

        public SlippageInPrice {
            Objects.requireNonNull(rates, "미국 비용 요율이 없습니다");
        }

        /**
         * 봉의 종가에 슬리피지를 얹은 체결.
         *
         * @throws IllegalArgumentException 종가 ≤ 0·슬리피지 범위 밖({@link PaperLedger#fillPrice})
         * @throws IllegalStateException    설정에 미국 비용 요율이 없음(미국 시장 판으로 읽지 않은 설정)
         */
        static SlippageInPrice ofClose(String side, Bar bar, PaperSettings settings, String priceSource) {
            return ofRaw(side, bar.close(), settings, priceSource);
        }

        /**
         * 원가격에 슬리피지를 얹은 체결 — 미국 시각 지정 체결(1분봉 봉 시가·관측 종가, {@code UsTimedFills})·사후 체결(출발일 종가)이 씁니다. 식은
         * {@link #ofClose}와 같습니다.
         *
         * @throws IllegalArgumentException 원가격 ≤ 0·슬리피지 범위 밖({@link PaperLedger#fillPrice})
         * @throws IllegalStateException    설정에 미국 비용 요율이 없음(미국 시장 판으로 읽지 않은 설정)
         */
        static SlippageInPrice ofRaw(String side, double raw, PaperSettings settings, String priceSource) {
            PaperSettings.UsCostRates costs = settings.usCosts();
            if (costs == null) {
                throw new IllegalStateException("미국 비용 요율이 없는 설정입니다 — 미국 시장 판으로 읽은 설정을 넘기세요"
                        + "(PaperSettings.from(body, US))");
            }
            return of(side, raw, settings.slippageBp(), priceSource, costs.rates());
        }

        /**
         * 원가격·슬리피지·요율을 직접 받은 체결(식은 {@link #ofRaw}와 같음) — 설정을 거치지 않는 시험용 시장이 요율 0({@link UsCosts.Rates#ZERO})으로 씁니다.
         *
         * @throws IllegalArgumentException 원가격 ≤ 0·슬리피지 범위 밖({@link PaperLedger#fillPrice})
         */
        static SlippageInPrice of(String side, double raw, double slippageBp, String priceSource, UsCosts.Rates rates) {
            PaperLedger.Side direction = PaperBooks.SELL.equals(side) ? PaperLedger.Side.SELL : PaperLedger.Side.BUY;
            double price = PaperLedgerService.price6(PaperLedger.fillPrice(raw, direction, slippageBp));
            return new SlippageInPrice(side, price, raw, priceSource, slippageBp, rates);
        }

        /** 예산으로 살 수 있는 정수 주 — 수수료가 없으면 이 묶음 전 식(예산 ÷ 체결가 내림), 있으면 수수료 포함 유출이 예산 안. */
        @Override
        public int affordableQty(double budget) {
            if (rates.commissionBp().signum() == 0) {
                return PaperLedger.buyQty(budget, price);
            }
            if (!Double.isFinite(budget)) {
                throw new IllegalArgumentException("목표 금액이(가) 숫자가 아닙니다: " + budget);
            }
            return UsCosts.affordableQty(BigDecimal.valueOf(budget), BigDecimal.valueOf(price), rates);
        }

        @Override
        public Costs costs(int qty) {
            double gross = PaperLedgerService.gross(qty, price);
            boolean sell = PaperBooks.SELL.equals(side);
            if (rates.zero()) {
                return new Costs(gross, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, sell ? gross : -gross);
            }
            UsCosts.Costs costs = UsCosts.of(sell ? PaperLedger.Side.SELL : PaperLedger.Side.BUY, qty,
                    BigDecimal.valueOf(price), BigDecimal.valueOf(gross), rates);
            return new Costs(gross, costs.commission(), costs.tax(), BigDecimal.ZERO, costs.cashFlow().doubleValue());
        }
    }
}
