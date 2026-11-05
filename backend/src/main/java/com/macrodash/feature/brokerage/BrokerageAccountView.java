package com.macrodash.feature.brokerage;

import java.math.BigDecimal;
import java.util.List;

/**
 * {@code GET /api/brokerage/account?market=KR|US}의 응답(명세 docs/specs/2026-11-05-toss-account-readonly.md §4).
 *
 * <p>칸을 하나씩 정해 둔 record입니다 — 수집기 JSON을 통째로 옮기지 않으므로 수집기·토스가 새 칸(계좌번호 등)을 내도 화면까지 가지
 * 않습니다. 숫자는 JSON number 또는 null(모르는 값을 0으로 채우지 않음), 시각은 {@code Kst.DISPLAY} 형식입니다.
 *
 * @param available         {@code state == OK}
 * @param message           state별 고정 문구(수집기·토스 문구를 옮기지 않음). OK이고 새 값이면 null
 * @param staleReason       이전 값을 보일 때 그 갱신이 실패한 사유
 * @param upstreamCode      토스 오류 코드({@code ^[a-z0-9-]{1,40}$}일 때만)
 * @param unclassifiedCount 수집기 값 + 이 쪽의 통화·시장이 맞지 않아 뺀 항목
 */
public record BrokerageAccountView(
        boolean available,
        State state,
        String message,
        String market,
        String currency,
        String accountLabel,
        Integer accountCount,
        String fetchedAtKst,
        String staleSinceKst,
        Long ageSeconds,
        boolean isStale,
        State staleReason,
        String upstreamCode,
        BigDecimal buyingPower,
        Summary summary,
        List<HoldingRow> holdings,
        List<OrderRow> openOrders,
        List<OrderRow> closedOrders,
        String closedFromDate,
        boolean closedTruncated,
        int unclassifiedCount) {

    /** 화면이 갈래를 나누는 상태(명세 §4 대응 표). */
    public enum State {
        OK, DISABLED, NOT_CONFIGURED, COLLECTOR_UNREACHABLE, IP_NOT_ALLOWED, AUTH_FAILED, RATE_LIMITED, NO_ACCOUNT,
        REFRESHING, UPSTREAM_ERROR
    }

    /**
     * 그 통화의 보유 요약. 두 Pct는 대시보드 계산(같은 통화의 손익 × 100 / 매입금액) — 토스 요약의 비율(원화 환산 합산)은 옮기지 않고,
     * 일간 수익률은 계산하지 않습니다.
     */
    public record Summary(
            BigDecimal purchaseAmount,
            BigDecimal marketValue,
            BigDecimal marketValueAfterCost,
            BigDecimal profitLoss,
            BigDecimal profitLossAfterCost,
            BigDecimal dailyProfitLoss,
            BigDecimal profitLossPct,
            BigDecimal profitLossPctAfterCost) {
    }

    /** 보유 종목 한 줄. {@code *Pct}는 토스 비율(소수, 0.1077) × 100. */
    public record HoldingRow(
            String symbol,
            String name,
            String marketCountry,
            String currency,
            BigDecimal quantity,
            BigDecimal lastPrice,
            BigDecimal averagePurchasePrice,
            BigDecimal purchaseAmount,
            BigDecimal marketValue,
            BigDecimal marketValueAfterCost,
            BigDecimal profitLoss,
            BigDecimal profitLossAfterCost,
            BigDecimal profitLossPct,
            BigDecimal profitLossPctAfterCost,
            BigDecimal dailyProfitLoss,
            BigDecimal dailyProfitLossPct) {
    }

    /** 주문 한 줄. enum 칸(방향·유형·상태 등)은 토스 원문, 주문 번호는 싣지 않습니다. */
    public record OrderRow(
            String symbol,
            String name,
            String side,
            String orderType,
            String timeInForce,
            String status,
            String currency,
            BigDecimal price,
            BigDecimal quantity,
            BigDecimal orderAmount,
            String orderedAtKst,
            String canceledAtKst,
            BigDecimal filledQuantity,
            BigDecimal averageFilledPrice,
            BigDecimal filledAmount,
            BigDecimal commission,
            BigDecimal tax,
            String filledAtKst,
            String settlementDate) {
    }
}
