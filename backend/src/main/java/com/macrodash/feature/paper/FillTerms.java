package com.macrodash.feature.paper;

import com.macrodash.analytics.PaperLedger;
import com.macrodash.feature.paper.PaperMarketData.Bar;

import java.math.BigDecimal;
import java.util.Objects;

/**
 * 🧪 주문 하나를 봉 하나로 체결하는 시장 몫(결정 d10, C2a) — 체결가·관측가·가격 출처·슬리피지 기록값, 예산으로 살 수 있는 수량, 수량별
 * 체결 금액·비용 칸·현금 변화. 시장 묶음의 {@link PaperMarket#fill}이 만들고, 장부({@code PaperLedgerService})가 이것으로 체결 행·현금·
 * 보유 평단을 씁니다 — 장부는 체결가를 직접 셈하지 않습니다.
 *
 * <p>미국은 슬리피지를 체결가에 얹고 비용 칸이 없습니다({@link SlippageInPrice} — 이 묶음 전 {@code PaperLedger.fillPrice}·
 * {@code PaperLedgerService.price6}·{@code gross} 그대로, 고정본 바이트 그대로). 한국은 체결가 = 관측가이고 수수료·세금·슬리피지가 비용
 * 칸입니다(K31 — {@code KrxCosts}, C2b).
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
     * 체결 한 건의 금액.
     *
     * @param gross        체결 금액({@code paper_fills.gross}) = 수량 × 체결가(소수 4자리)
     * @param fee          수수료 칸({@code paper_fills.fee}, 미국 0)
     * @param tax          세금 칸({@code paper_fills.tax}, 미국 0)
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
     * 슬리피지를 체결가에 얹는 체결(미국 D9) — 체결가 = 관측 종가 × (1 ± bp)를 저장 열(NUMERIC(18,6)) 자리로, 수량 = 예산 ÷ 체결가 내림,
     * 체결 금액 = 수량 × 체결가(4자리), 비용 칸 없음. 이 묶음 전 장부의 식 그대로입니다.
     *
     * @param side 주문 방향(BUY·SELL — 매도가 아니면 매수 쪽으로 얹음, 장부가 매수·매도를 따로 부르던 것과 같음)
     */
    record SlippageInPrice(String side, double price, double rawPrice, String priceSource, double slippageBp)
            implements FillTerms {

        /**
         * 봉의 종가에 슬리피지를 얹은 체결.
         *
         * @throws IllegalArgumentException 종가 ≤ 0·슬리피지 범위 밖({@link PaperLedger#fillPrice})
         */
        static SlippageInPrice ofClose(String side, Bar bar, double slippageBp, String priceSource) {
            PaperLedger.Side direction = PaperBooks.SELL.equals(side) ? PaperLedger.Side.SELL : PaperLedger.Side.BUY;
            double price = PaperLedgerService.price6(PaperLedger.fillPrice(bar.close(), direction, slippageBp));
            return new SlippageInPrice(side, price, bar.close(), priceSource, slippageBp);
        }

        @Override
        public int affordableQty(double budget) {
            return PaperLedger.buyQty(budget, price);
        }

        @Override
        public Costs costs(int qty) {
            double gross = PaperLedgerService.gross(qty, price);
            return new Costs(gross, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO,
                    PaperBooks.SELL.equals(side) ? gross : -gross);
        }
    }
}
