package com.macrodash.feature.realtrade;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * ISA 계좌 잔고의 순수 계산(ADR 0034) — 현금·보유·매입 금액을 '확인'과 되돌림에 맞춰 옮기고, 총 잔고에서 현금을 다시 셉니다. DB·시계를 모릅니다(시험이 사례로 고정).
 * 금액은 십진수로만 셉니다(원 미만 비용 절사는 {@code analytics.KrxCosts} — 부르는 쪽이 비용을 넘김).
 *
 * <ul>
 *   <li>매수: 현금 −(금액 + 수수료), 매입 금액 +금액, 수량 +.</li>
 *   <li>매도: 현금 +(금액 − 수수료 − 세금), 보유까지만 팔고, 매입 금액은 판 수량 비율만큼 줄입니다(전량 매도면 0). 실현 손익 = 금액 − 줄어든 매입 금액 − 수수료 − 세금.</li>
 *   <li>되돌림은 위를 정확히 거꾸로 합니다 — 그사이 보유를 고쳤어도 수량이 0 이하가 되면 그 행을 없애고, 매입 금액은 0 아래로 내려가지 않습니다.</li>
 *   <li>현금 = 총평가금액 − Σ(수량 × 가격). 음수면 그대로 돌려줍니다(막지 않고 화면에 경고).</li>
 *   <li>금액은 소수 둘째 자리까지(수량·가격 곱이 더 길어져도 반올림 — DB NUMERIC(20,2)).</li>
 * </ul>
 */
final class ManualAccountBalance {

    private ManualAccountBalance() {
    }

    /** 종목 코드 모양(DB CHECK와 같음). */
    static final Pattern KR_SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");
    private static final BigDecimal HUNDRED = new BigDecimal("100");
    /** 평균 매입가 표시 자릿수. */
    private static final int AVG_SCALE = 4;

    /** 반영 뒤의 잔고 — 현금·그 종목 수량(0이면 행을 없앰)·매입 금액·이번에 옮긴 매입 금액·실현 손익(매수 null). */
    record Applied(BigDecimal cash, BigDecimal quantity, BigDecimal purchaseAmount, BigDecimal costBasis, BigDecimal realizedPnl) {

        boolean empty() {
            return quantity.signum() <= 0;
        }
    }

    /** 체결 금액(수량 × 가격, 소수 둘째 자리). */
    static BigDecimal amount(BigDecimal quantity, BigDecimal price) {
        return money(quantity.multiply(price));
    }

    static BigDecimal money(BigDecimal value) {
        return value.setScale(2, RoundingMode.HALF_UP);
    }

    /** 매수 반영(클래스 설명) — {@code amount}는 체결 금액(총액 — 사용자가 적은 값이나 수량 × 가격). */
    static Applied buy(BigDecimal cash, BigDecimal heldQuantity, BigDecimal heldPurchase, BigDecimal quantity, BigDecimal amount, BigDecimal fee) {
        return new Applied(money(cash.subtract(amount).subtract(nz(fee))), nz(heldQuantity).add(quantity), money(nz(heldPurchase).add(amount)), amount, null);
    }

    /** 매도 반영(클래스 설명) — {@code quantity}는 보유 이하여야 합니다(부르는 쪽이 보유까지로 줄임). */
    static Applied sell(BigDecimal cash, BigDecimal heldQuantity, BigDecimal heldPurchase, BigDecimal quantity, BigDecimal amount, BigDecimal fee,
                        BigDecimal tax) {
        if (quantity.compareTo(heldQuantity) > 0) {
            throw new IllegalArgumentException("보유보다 많이 팔 수 없습니다");
        }
        BigDecimal after = heldQuantity.subtract(quantity);
        BigDecimal costBasis = after.signum() == 0 ? money(heldPurchase) : money(heldPurchase.multiply(quantity).divide(heldQuantity, 8, RoundingMode.HALF_UP));
        BigDecimal purchase = money(heldPurchase.subtract(costBasis).max(BigDecimal.ZERO));
        BigDecimal realized = money(amount.subtract(costBasis).subtract(nz(fee)).subtract(nz(tax)));
        return new Applied(money(cash.add(amount).subtract(nz(fee)).subtract(nz(tax))), after, purchase, costBasis, realized);
    }

    /** 매수 되돌림 — 현금 +(금액 + 수수료), 수량 −(0 이하이면 행을 없앰), 매입 금액 −(0 아래로 내려가지 않음). */
    static Applied undoBuy(BigDecimal cash, BigDecimal heldQuantity, BigDecimal heldPurchase, BigDecimal quantity, BigDecimal amount, BigDecimal fee,
                           BigDecimal costBasis) {
        BigDecimal after = nz(heldQuantity).subtract(quantity);
        BigDecimal purchase = after.signum() <= 0 ? BigDecimal.ZERO : money(nz(heldPurchase).subtract(costBasis).max(BigDecimal.ZERO));
        return new Applied(money(cash.add(amount).add(nz(fee))), after, purchase, costBasis, null);
    }

    /** 매도 되돌림 — 현금 −(금액 − 수수료 − 세금), 수량 +, 매입 금액 +. */
    static Applied undoSell(BigDecimal cash, BigDecimal heldQuantity, BigDecimal heldPurchase, BigDecimal quantity, BigDecimal amount, BigDecimal fee,
                            BigDecimal tax, BigDecimal costBasis) {
        return new Applied(money(cash.subtract(amount).add(nz(fee)).add(nz(tax))), nz(heldQuantity).add(quantity), money(nz(heldPurchase).add(costBasis)),
                costBasis, null);
    }

    /** 수량 × 가격 한 묶음(총 잔고에서 현금을 셀 때). */
    record Lot(BigDecimal quantity, BigDecimal price) {
    }

    /** 현금 = 총평가금액 − Σ(수량 × 가격). */
    static BigDecimal cashFromTotal(BigDecimal totalAsset, List<Lot> lots) {
        BigDecimal value = BigDecimal.ZERO;
        for (Lot lot : lots) {
            value = value.add(lot.quantity().multiply(lot.price()));
        }
        return money(totalAsset.subtract(value));
    }

    /** 평균 매입가(매입 금액 ÷ 수량). 수량이 0 이하이면 null. */
    static BigDecimal avgPrice(BigDecimal purchaseAmount, BigDecimal quantity) {
        return quantity == null || quantity.signum() <= 0 ? null : purchaseAmount.divide(quantity, AVG_SCALE, RoundingMode.HALF_UP);
    }

    /** {@code part ÷ whole × 100}(소수 둘째 자리) — 분모가 0 이하이거나 모르면 null. */
    static BigDecimal percent(BigDecimal part, BigDecimal whole) {
        return part == null || whole == null || whole.signum() <= 0 ? null : part.multiply(HUNDRED).divide(whole, 2, RoundingMode.HALF_UP);
    }

    /**
     * 종목 입력 해석(ADR 0034) — 코드 모양이면 코드(대문자로), 아니면 이름표에서 공백을 뺀 정확히 일치 → 하나로 좁혀지는 부분 일치. 없거나 여럿이면 null.
     *
     * @param raw   종목 이름 또는 코드
     * @param names 코드 → 이름(전체 이름표)
     */
    static String resolveSymbol(String raw, Map<String, String> names) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String text = raw.strip();
        String upper = text.toUpperCase(Locale.ROOT);
        if (KR_SYMBOL.matcher(upper).matches()) {
            return upper;
        }
        String wanted = normal(text);
        List<String> exact = new ArrayList<>();
        List<String> partial = new ArrayList<>();
        for (Map.Entry<String, String> e : names.entrySet()) {
            String name = normal(e.getValue());
            if (name.equals(wanted)) {
                exact.add(e.getKey());
            } else if (name.contains(wanted)) {
                partial.add(e.getKey());
            }
        }
        if (exact.size() == 1) {
            return exact.get(0);
        }
        if (exact.isEmpty() && partial.size() == 1) {
            return partial.get(0);
        }
        return null;
    }

    private static String normal(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
    }

    private static BigDecimal nz(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value;
    }
}
