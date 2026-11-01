package com.macrodash.analytics;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;
import java.util.Objects;

/**
 * 모의 매매 장부의 체결·평가 계산(설계 §3-1).
 *
 * <p>여기는 숫자만 다룹니다. 어떤 주문을 언제 체결할지(룩어헤드 방지 조건), 가격을 모르는 보유를 무엇으로 평가할지는
 * {@code PaperLedgerService}의 책임입니다.
 *
 * <p><b>수량 내림은 십진수로 합니다.</b> {@code 0.3 / 0.1}은 double로 2.9999999999999996이라 내림하면 2주가 됩니다.
 * 장부의 금액·가격은 DB에 NUMERIC(십진수)으로 저장되므로, 화면에 보이는 숫자로 손계산한 수량과 같아야 합니다. 그래서
 * 금액·가격을 {@link BigDecimal#valueOf(double)}(가장 짧은 십진 표기)로 바꿔 나눈 뒤 내립니다.
 *
 * <p>NaN·무한대는 계산 실수의 흔적이라 받지 않습니다(IllegalArgumentException) — 조용히 0주·0달러로 바꾸면 장부가
 * '현금만 있는 책'처럼 보입니다.
 */
public final class PaperLedger {

    private PaperLedger() {
    }

    public enum Side { BUY, SELL }

    /** 1bp = 0.01%. */
    private static final double BP = 10_000.0;

    /**
     * 슬리피지를 얹은 체결가: BUY는 raw×(1+bp/1e4), SELL은 raw×(1−bp/1e4). 늘 우리에게 불리한 쪽으로 얹습니다(D9).
     * 반올림하지 않습니다 — 저장 열(NUMERIC(18,6))이 자릅니다.
     *
     * @param raw        관측 가격
     * @param slippageBp 0 이상 10,000 미만
     * @throws IllegalArgumentException raw ≤ 0·NaN, slippageBp가 범위 밖
     */
    public static double fillPrice(double raw, Side side, double slippageBp) {
        Objects.requireNonNull(side, "side");
        if (!(raw > 0) || Double.isInfinite(raw)) {
            throw new IllegalArgumentException("관측 가격은 0보다 커야 합니다: " + raw);
        }
        // 음수 bp는 '유리한 체결'이 되고, 10,000bp 이상이면 매도 체결가가 0 이하가 됩니다 — 설정 실수이므로 막습니다.
        if (!(slippageBp >= 0) || slippageBp >= BP) {
            throw new IllegalArgumentException("슬리피지(bp)는 0 이상 10000 미만이어야 합니다: " + slippageBp);
        }
        double factor = slippageBp / BP;
        return side == Side.BUY ? raw * (1.0 + factor) : raw * (1.0 - factor);
    }

    /**
     * 목표 금액으로 살 수 있는 정수 주식 수(내림, 십진수 기준). 예: 100,000달러 ÷ 500.25 = 199.9 → 199주.
     *
     * @return 금액·가격이 0 이하면 0(살 것 없음)
     * @throws IllegalArgumentException 금액·가격이 NaN·무한대
     */
    public static int buyQty(double targetAmount, double price) {
        requireFinite(targetAmount, "목표 금액");
        requireFinite(price, "가격");
        if (targetAmount <= 0 || price <= 0) {
            return 0;
        }
        return BigDecimal.valueOf(targetAmount)
                .divide(BigDecimal.valueOf(price), 0, RoundingMode.FLOOR)
                .intValueExact();
    }

    /**
     * 매도 수량(설계 §3-1): sellFraction이 null이면 전량, {@code floor(held × f)}가 1 미만이면 전량, held를 넘지 않음.
     *
     * <p>"1 미만이면 전량"은 3주 중 20%(0.6주)처럼 내림하면 0주가 되는 주문이 영원히 체결되지 않는 것을 막는 규칙입니다.
     *
     * @param held         보유 수량. 0 이하면 팔 것이 없어 0
     * @param sellFraction 0 초과(1 이상은 전량). null = 전량
     * @throws IllegalArgumentException sellFraction이 0 이하·NaN — '1 미만이면 전량' 규칙 때문에 0을 그대로 받으면 '안 팖'이
     *                                  '전량 매도'로 뒤집힙니다. 검증기가 거르는 값이라 여기 오면 버그입니다
     */
    public static int sellQty(int held, Double sellFraction) {
        if (held <= 0) {
            return 0;
        }
        if (sellFraction == null) {
            return held;
        }
        if (!(sellFraction > 0) || sellFraction.isInfinite()) {
            throw new IllegalArgumentException("매도 비율은 0보다 커야 합니다: " + sellFraction);
        }
        if (sellFraction >= 1.0) {
            return held;
        }
        int qty = BigDecimal.valueOf(held)
                .multiply(BigDecimal.valueOf(sellFraction))
                .setScale(0, RoundingMode.FLOOR)
                .intValueExact();
        return qty < 1 ? held : Math.min(qty, held);
    }

    /**
     * 매수 뒤 평단 = (기존 수량×기존 평단 + 추가 수량×체결가) / 합계 수량. 반올림하지 않습니다(저장 직전에 {@link #round4}).
     *
     * @param qty    기존 수량(0이면 새 보유 → 체결가가 평단)
     * @param addQty 이번 체결 수량
     * @throws IllegalArgumentException 수량이 음수이거나 합계가 0
     */
    public static double averageCost(int qty, double avgCost, int addQty, double price) {
        if (qty < 0 || addQty < 0 || (long) qty + addQty == 0) {
            throw new IllegalArgumentException("수량이 맞지 않습니다: 기존 " + qty + ", 추가 " + addQty);
        }
        if (addQty == 0) {
            return avgCost;
        }
        if (qty == 0) {
            return price;
        }
        return ((double) qty * avgCost + (double) addQty * price) / ((long) qty + addQty);
    }

    /** 평가 결과. 금액은 반올림하지 않은 값입니다(저장 직전에 {@link #round4}). */
    public record Valuation(double cash, double equityValue, double nav, double exposurePct) {
    }

    /**
     * 평가: equity = Σ 수량×가격, nav = 현금 + equity, 노출 = equity / nav × 100.
     *
     * <p>합은 십진수로 더합니다 — double로 더하면 맵 순회 순서에 따라 끝자리가 달라져, 같은 장부의 순자산이 실행마다
     * 0.0001달러씩 다르게 저장될 수 있습니다.
     *
     * @param qty   티커 → 보유 수량. 수량 0인 항목은 건너뜁니다(가격이 없어도 됨)
     * @param price 티커 → 평가 가격. 서비스가 관측가(없으면 마지막 관측가·평단)를 골라 넣습니다 — 여기서는 받은 값만 씁니다
     * @return nav ≤ 0이면 노출 0
     * @throws IllegalArgumentException 보유(수량 &gt; 0) 티커의 가격이 없거나, 수량이 음수·null이거나, 값이 NaN·무한대·음수
     */
    public static Valuation value(double cash, Map<String, Integer> qty, Map<String, Double> price) {
        requireFinite(cash, "현금");
        BigDecimal equity = BigDecimal.ZERO;
        for (Map.Entry<String, Integer> holding : qty.entrySet()) {
            Integer shares = holding.getValue();
            if (shares == null || shares < 0) {
                throw new IllegalArgumentException("보유 수량이 맞지 않습니다: " + holding.getKey() + "=" + shares);
            }
            if (shares == 0) {
                continue;
            }
            Double p = price.get(holding.getKey());
            if (p == null) {
                throw new IllegalArgumentException("평가 가격이 없는 보유: " + holding.getKey());
            }
            requireFinite(p, "가격(" + holding.getKey() + ")");
            if (p < 0) {
                throw new IllegalArgumentException("가격이 음수입니다: " + holding.getKey() + "=" + p);
            }
            equity = equity.add(BigDecimal.valueOf(shares).multiply(BigDecimal.valueOf(p)));
        }
        double equityValue = equity.doubleValue();
        double nav = equity.add(BigDecimal.valueOf(cash)).doubleValue();
        double exposure = nav > 0 ? equityValue / nav * 100.0 : 0.0;
        return new Valuation(cash, equityValue, nav, exposure);
    }

    /**
     * 금액을 소수 4자리로 반올림(NUMERIC(18,4)에 맞춤, 0.5는 0에서 먼 쪽 — PostgreSQL NUMERIC과 같음).
     *
     * <p>{@code Math.round(v × 1e4) / 1e4}를 쓰지 않습니다. 0.00145 × 1e4가 double로 14.499999…라 0.0014가 됩니다.
     *
     * @throws IllegalArgumentException NaN·무한대
     */
    public static double round4(double v) {
        requireFinite(v, "금액");
        return BigDecimal.valueOf(v).setScale(4, RoundingMode.HALF_UP).doubleValue();
    }

    private static void requireFinite(double v, String what) {
        if (!Double.isFinite(v)) {
            throw new IllegalArgumentException(what + "이(가) 숫자가 아닙니다: " + v);
        }
    }
}
