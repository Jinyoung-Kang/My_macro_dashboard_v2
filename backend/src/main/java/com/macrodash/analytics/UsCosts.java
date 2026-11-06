package com.macrodash.analytics;

import com.macrodash.analytics.PaperLedger.Side;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Objects;

/**
 * 미국 증시 체결 비용 — 토스 매매 수수료와 매도 제비용(SEC fee·FINRA TAF). ADR 0030, 명세 2026-11-06-us-costs-backfill.md §1.
 *
 * <pre>
 *  체결가     = 관측가 × (1 ± 슬리피지)        (가격 정의는 그대로 — {@link PaperLedger#fillPrice}, 저장 열 자리 6)
 *  체결 금액  = 수량 × 체결가                  (소수 4자리 반올림 — 장부의 paper_fills.gross와 같은 식)
 *  수수료     = 체결 금액 × commissionBp ÷ 10,000   센트 반올림(HALF_UP) — 매수·매도 모두
 *  SEC fee    = 체결 금액 × secPerMillion ÷ 1,000,000 센트 올림 — 매도만
 *  FINRA TAF  = min(수량 × tafPerShare, tafMaxPerTrade) 센트 올림 — 매도만, 체결가가 tafPerShare보다 작으면 0(FINRA 규칙)
 *  제비용     = SEC fee + TAF  ({@code paper_fills.tax})
 *  현금 흐름  = 매수 −(금액 + 수수료) · 매도 +(금액 − 수수료 − 제비용)
 * </pre>
 *
 * <p>요율은 부르는 쪽이 설정(미국 최상위 {@code commissionBp}·{@code regFees.*} — 체결 때 유효한 설정 판)에서 읽어 {@link Rates}로 넘깁니다.
 * 금액은 십진수로만 셉니다 — double로 곱하면 반올림 경계에서 1센트가 갈립니다(한국 {@link KrxCosts}와 같은 까닭).
 *
 * <p>순수 계산입니다(이 패키지는 {@code java.*}만).
 */
public final class UsCosts {

    private UsCosts() {
    }

    /** 1bp = 0.01%. */
    private static final BigDecimal BP = BigDecimal.valueOf(10_000);
    private static final BigDecimal MILLION = BigDecimal.valueOf(1_000_000);
    /** 비용 칸의 자리(센트). */
    public static final int CENT_SCALE = 2;
    /** 체결 금액의 자리 — {@code paper_fills.gross} NUMERIC(18,4)와 장부의 {@code gross}. */
    public static final int GROSS_SCALE = 4;

    /**
     * 한 체결에 쓰는 요율 — 설정 {@code commissionBp}·{@code regFees.secPerMillion}·{@code regFees.tafPerShare}·{@code regFees.tafMaxPerTrade}의 한 판.
     *
     * @param commissionBp   매매 수수료(bp, 매수·매도 각각)
     * @param secPerMillion  SEC Section 31 fee(매도 금액 $1,000,000당 달러)
     * @param tafPerShare    FINRA Trading Activity Fee(매도 1주당 달러)
     * @param tafMaxPerTrade TAF 1건 상한(달러)
     * @throws IllegalArgumentException null·음수·수수료 10,000bp 이상
     */
    public record Rates(BigDecimal commissionBp, BigDecimal secPerMillion, BigDecimal tafPerShare,
                        BigDecimal tafMaxPerTrade) {

        /** 비용 없음 — 이 묶음 전 미국 체결(슬리피지만 체결가에)과 같은 현금 흐름. */
        public static final Rates ZERO = new Rates(BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);

        public Rates {
            requireNonNegative(commissionBp, "수수료");
            if (commissionBp.compareTo(BP) >= 0) {
                throw new IllegalArgumentException("수수료(bp)는 10000 미만이어야 합니다: " + commissionBp);
            }
            requireNonNegative(secPerMillion, "SEC fee");
            requireNonNegative(tafPerShare, "FINRA TAF");
            requireNonNegative(tafMaxPerTrade, "FINRA TAF 상한");
        }

        /** 비용이 하나도 생기지 않는 판인가(수수료·SEC 0이고, TAF 단가나 상한이 0 — 상한 0이면 TAF도 0). */
        public boolean zero() {
            return commissionBp.signum() == 0 && secPerMillion.signum() == 0
                    && (tafPerShare.signum() == 0 || tafMaxPerTrade.signum() == 0);
        }
    }

    /**
     * 체결 한 건의 금액과 비용 칸. 저장 열과의 대응: {@code paper_fills.gross} = {@link #gross}, {@code fee} = {@link #commission},
     * {@code tax} = {@link #tax()}(SEC fee + TAF), {@code slippage_cost} = 0(슬리피지는 체결가에).
     */
    public record Costs(Side side, int qty, BigDecimal price, BigDecimal gross, BigDecimal commission, BigDecimal secFee,
                        BigDecimal taf) {

        public Costs {
            Objects.requireNonNull(side, "side");
            requireQty(qty);
            requirePositive(price, "체결가");
            requireNonNegative(gross, "체결 금액");
            requireNonNegative(commission, "수수료");
            requireNonNegative(secFee, "SEC fee");
            requireNonNegative(taf, "FINRA TAF");
            if (side == Side.BUY && (secFee.signum() != 0 || taf.signum() != 0)) {
                throw new IllegalArgumentException("매수에는 매도 제비용이 없습니다: SEC " + secFee + ", TAF " + taf);
            }
        }

        /** 매도 제비용 = SEC fee + TAF({@code paper_fills.tax}). */
        public BigDecimal tax() {
            return secFee.add(taf);
        }

        /** 현금 흐름(매수 음수, 매도 양수 — 아주 작은 매도는 제비용이 금액보다 커 음수일 수 있음). */
        public BigDecimal cashFlow() {
            return side == Side.BUY ? gross.add(commission).negate() : gross.subtract(commission).subtract(tax());
        }

        /** 비용 합(수수료 + 제비용)을 현금에서 뺀 값 — 늘 0 이하(소급 조정 행의 {@code cash_delta}). */
        public BigDecimal costDelta() {
            return commission.add(tax()).negate();
        }
    }

    /**
     * 체결 금액 = 수량 × 체결가(소수 4자리 반올림) — 장부의 {@code PaperLedgerService.gross}와 같은 식.
     *
     * @throws IllegalArgumentException 수량 1 미만, 가격 0 이하
     */
    public static BigDecimal gross(int qty, BigDecimal price) {
        requireQty(qty);
        requirePositive(price, "체결가");
        return price.multiply(BigDecimal.valueOf(qty)).setScale(GROSS_SCALE, RoundingMode.HALF_UP);
    }

    /**
     * 체결 한 건의 비용(클래스 설명의 식) — 체결 금액은 {@link #gross}로 셉니다.
     *
     * @param price 체결가(슬리피지를 얹은 값, 저장 열 자리)
     */
    public static Costs fill(Side side, int qty, BigDecimal price, Rates rates) {
        return of(side, qty, price, gross(qty, price), rates);
    }

    /**
     * 이미 저장된 체결(체결 금액이 정해짐)의 비용 — 과거 체결 소급(명세 §2)이 체결 행의 {@code gross}로 다시 셀 때 씁니다.
     *
     * @param gross 체결 금액(저장된 값 그대로)
     * @throws IllegalArgumentException null, 수량 1 미만, 가격 0 이하, 금액 음수
     */
    public static Costs of(Side side, int qty, BigDecimal price, BigDecimal gross, Rates rates) {
        Objects.requireNonNull(side, "side");
        Objects.requireNonNull(rates, "요율이 없습니다");
        requireQty(qty);
        requirePositive(price, "체결가");
        requireNonNegative(gross, "체결 금액");
        BigDecimal commission = gross.multiply(rates.commissionBp()).divide(BP, CENT_SCALE, RoundingMode.HALF_UP);
        BigDecimal sec = BigDecimal.ZERO.setScale(CENT_SCALE);
        BigDecimal taf = BigDecimal.ZERO.setScale(CENT_SCALE);
        if (side == Side.SELL) {
            sec = gross.multiply(rates.secPerMillion()).divide(MILLION, CENT_SCALE, RoundingMode.CEILING);
            if (price.compareTo(rates.tafPerShare()) >= 0) {
                BigDecimal perTrade = rates.tafPerShare().multiply(BigDecimal.valueOf(qty)).min(rates.tafMaxPerTrade());
                taf = perTrade.setScale(CENT_SCALE, RoundingMode.CEILING);
            }
        }
        return new Costs(side, qty, price, gross, commission, sec, taf);
    }

    /**
     * 예산으로 살 수 있는 정수 주식 수 — floor(예산 ÷ (체결가 × (1 + commissionBp ÷ 10,000)))(명세 §1). 수수료를 센트로 반올림하면 그 수량의
     * 유출(금액 + 수수료)이 예산을 반 센트까지 넘을 수 있어, 넘으면 넘지 않을 때까지 한 주씩 줄입니다(현금이 음수가 되지 않게).
     *
     * @return 예산 ≤ 0이거나 한 주도 못 사면 0
     * @throws IllegalArgumentException 가격 0 이하, 결과가 int 범위를 넘음
     */
    public static int affordableQty(BigDecimal budget, BigDecimal price, Rates rates) {
        Objects.requireNonNull(budget, "예산이 없습니다");
        Objects.requireNonNull(rates, "요율이 없습니다");
        requirePositive(price, "체결가");
        if (budget.signum() <= 0) {
            return 0;
        }
        BigDecimal perShare = price.multiply(BigDecimal.ONE.add(rates.commissionBp().divide(BP)));
        BigDecimal floor = budget.divide(perShare, 0, RoundingMode.FLOOR);
        if (floor.compareTo(BigDecimal.valueOf(Integer.MAX_VALUE)) > 0) {
            throw new IllegalArgumentException("살 수 있는 수량이 int 범위를 넘습니다: 예산 " + budget + ", 가격 " + price);
        }
        int qty = floor.intValueExact();
        while (qty > 0 && fill(Side.BUY, qty, price, rates).cashFlow().negate().compareTo(budget) > 0) {
            qty--;
        }
        return qty;
    }

    private static void requireQty(int qty) {
        if (qty < 1) {
            throw new IllegalArgumentException("수량은 1주 이상이어야 합니다(정수 주): " + qty);
        }
    }

    private static void requirePositive(BigDecimal value, String what) {
        Objects.requireNonNull(value, what + "이(가) 없습니다");
        if (value.signum() <= 0) {
            throw new IllegalArgumentException(what + "은(는) 0보다 커야 합니다: " + value);
        }
    }

    private static void requireNonNegative(BigDecimal value, String what) {
        Objects.requireNonNull(value, what + "이(가) 없습니다");
        if (value.signum() < 0) {
            throw new IllegalArgumentException(what + "은(는) 음수일 수 없습니다: " + value);
        }
    }
}
