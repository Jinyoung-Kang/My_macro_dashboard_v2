package com.macrodash.feature.realtrade;

import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Order;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Position;
import com.macrodash.feature.realtrade.RealTradePlanner.Quote;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

/**
 * ISA 계좌 지시의 순수 계산(ADR 0029 — 명세 docs/specs/2026-11-06-isa-manual-account.md §2) — 실제 매매와 같은 '목표 보유 맞추기'
 * ({@link RealTradePlanner#sync} 그대로, 범위·보낼 종목 제한·1건 상한·하루 한도 없음). DB·시계를 모릅니다.
 *
 * <ul>
 *   <li>기준가 = 규칙 계좌 시가 목표의 평가 가격, 책에 없는 ISA 보유는 마지막 가격. ISA 평가액 = 잔고 현금 + Σ보유 × 기준가 — 보유 하나라도 기준가를 모르면
 *       지시를 만들지 않습니다(empty — 모르면 지시하지 않음). 잔고 현금이 음수여도 만들지 않습니다(empty — QA-381, ADR 0034 결정 5 개정: 음수만큼 평가액이 줄어 책에
 *       있는 종목까지 매도 지시가 나오고, 평가액이 0 이하이면 전 종목 전량 매도가 됨 — 잔고 숫자가 틀렸을 때 실제 돈의 매도 지시를 내지 않음).</li>
 *   <li>목표 수량 = floor(비중 × 평가액 ÷ 기준가). 차이가 1주 이상이고 평가액의 1% 이상인 종목만(책에 없는 보유는 1% 조건 없이 전량 매도).</li>
 *   <li>현금 확인: 매도 먼저 — 매수 합(수량 × 기준가 × {@value #BUY_BUFFER_TEXT})이 '잔고 현금 + 같은 지시의 매도 대금(수량 × 기준가)'을 넘으면 뒤 순서
 *       매수부터 줄이고 1주도 안 되면 뺍니다({@code deferred-cash}). 순서는 매도 → 매수, 현금성은 매수 마지막.</li>
 * </ul>
 */
final class ManualAccountPlanner {

    private ManualAccountPlanner() {
    }

    static final String BUY_BUFFER_TEXT = "1.02";
    /** 매수 현금 확인의 가격 여유 — 시가가 기준가(밤 종가)보다 조금 높아도 현금이 모자라지 않게. */
    static final BigDecimal BUY_BUFFER = new BigDecimal(BUY_BUFFER_TEXT);

    /** 지시 하나(실제 매매 계획의 주문과 같은 칸 + 목표 비중). */
    record Draft(String symbol, String side, int quantity, BigDecimal refPrice, BigDecimal weightPct, BigDecimal held,
                 BigDecimal targetQuantity) {
    }

    /** 계산 결과 — 지시(매도 → 매수 순)·건너뛴 종목·평가액·현금(잔고)·기준가를 모르는 보유. */
    record Result(List<Draft> drafts, List<Skip> skipped, BigDecimal equity, BigDecimal cash) {

        Result {
            drafts = List.copyOf(drafts);
            skipped = List.copyOf(skipped);
        }
    }

    /**
     * 지시를 계산합니다. 보유 중 기준가를 모르는 종목이 있으면 empty(그 종목은 {@code missing}에 담깁니다). 현금이 음수여도 empty이고 그때 {@code missing}은
     * 건드리지 않습니다 — 호출하는 쪽이 현금을 먼저 보고 사유를 가립니다({@link ManualAccountJob#WAIT_CASH}).
     *
     * @param cash      잔고 현금
     * @param held      종목 → 보유 수량(0이 아닌 것만)
     * @param weightPct 규칙 계좌 시가 목표 비중(종목 → %)
     * @param bookPrice 규칙 계좌 시가 목표의 평가 가격
     * @param lastPrice 마지막 가격(책에 없는 ISA 보유의 기준가)
     * @param cashLike  현금성 종목(매수 마지막)
     * @param missing   기준가를 모르는 보유를 담을 목록(호출하는 쪽이 사유로 씀)
     */
    static Optional<Result> plan(BigDecimal cash, Map<String, BigDecimal> held, Map<String, Double> weightPct, Map<String, Double> bookPrice,
                                 Map<String, BigDecimal> lastPrice, Set<String> cashLike, List<String> missing) {
        if (cash.signum() < 0) {
            return Optional.empty();   // QA-381 — 음수 현금으로 줄어든(또는 0 이하인) 평가액에 맞춰 팔라고 하지 않음
        }
        Map<String, BigDecimal> ref = new HashMap<>();
        bookPrice.forEach((symbol, price) -> {
            if (price != null && Double.isFinite(price) && price > 0) {
                ref.put(symbol, BigDecimal.valueOf(price));
            }
        });
        BigDecimal equity = cash;
        Map<String, Position> positions = new LinkedHashMap<>();
        for (Map.Entry<String, BigDecimal> e : new TreeMap<>(held).entrySet()) {
            if (e.getValue() == null || e.getValue().signum() <= 0) {
                continue;
            }
            BigDecimal price = ref.get(e.getKey());
            if (price == null) {
                BigDecimal last = lastPrice.get(e.getKey());
                if (last != null && last.signum() > 0) {
                    price = last;
                    ref.put(e.getKey(), last);
                }
            }
            if (price == null) {
                missing.add(e.getKey());
                continue;
            }
            equity = equity.add(e.getValue().multiply(price));
            positions.put(e.getKey(), new Position(e.getKey(), null, e.getValue(), price));
        }
        if (!missing.isEmpty()) {
            return Optional.empty();
        }
        Map<String, Quote> quotes = new HashMap<>();
        ref.forEach((symbol, price) -> quotes.put(symbol, new Quote(price, price.multiply(BUY_BUFFER))));
        Rules rules = new Rules(null, cashLike, false, false);

        // 1차: 잔고 현금만으로 — 매도 수량은 현금과 상관없으므로 여기서 정해집니다.
        Plan first = RealTradePlanner.sync(weightPct, equity, new Account(cash, positions, quotes, Map.of(), Map.of()), Set.of(),
                BigDecimal.ZERO, rules, true);
        BigDecimal proceeds = BigDecimal.ZERO;
        for (Order o : first.orders()) {
            if (RealTradePlanner.SELL.equals(o.side())) {
                proceeds = proceeds.add(o.estAmount());
            }
        }
        // 2차: 같은 지시의 매도 대금을 더한 현금으로 매수를 다시 배정(뒤 순서 매수부터 줄어듦).
        Plan plan = RealTradePlanner.sync(weightPct, equity, new Account(cash.add(proceeds), positions, quotes, Map.of(), Map.of()),
                Set.of(), BigDecimal.ZERO, rules, true);
        List<Draft> drafts = new ArrayList<>();
        for (Order o : plan.orders()) {
            Double w = weightPct.get(o.symbol());
            BigDecimal weight = w == null ? BigDecimal.ZERO : BigDecimal.valueOf(w).setScale(4, RoundingMode.HALF_UP);
            BigDecimal heldQty = held.getOrDefault(o.symbol(), BigDecimal.ZERO);
            BigDecimal target = w == null ? BigDecimal.ZERO : RealTradePlanner.targetQuantity(w, equity, o.refPrice());
            drafts.add(new Draft(o.symbol(), o.side(), o.quantity(), o.refPrice(), weight, heldQty, target));
        }
        return Optional.of(new Result(drafts, plan.skipped(), equity, cash));
    }
}
