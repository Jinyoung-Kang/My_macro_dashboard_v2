package com.macrodash.feature.paper;

import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;

/**
 * 시험용 장중 기록 한 트랜잭션(ADR 0045 ON) — 이 판에는 장부에 적는 단계가 없어, 공개 창의 거울 보기 시험이 같은 칸을 저장소 메서드로 씁니다: 체결 행(관측
 * 시각 = 기록 시각, 관측일 = 세션, 출처 R1)·주문 체결(대기일 때만)·보유 삭제(전량)·재진입 금지·근거({@code intradayFill} — mode ON, 기록 시각, 보유 사본,
 * 직전·직후 상태 현금)·상태 네 칸(현금·순자산·평가액·노출 — 마지막 관측·처리 시각은 그대로). 체결 조건은 밤과 같은 {@link KrFills#termsFor}입니다.
 */
final class IntradayRecords {

    private IntradayRecords() {
    }

    /** 주문들(같은 책)을 한 트랜잭션에서 R1 가격({@code prices} — 주문 번호 → 관측가)으로 적습니다. */
    static void record(PaperStore store, String book, Map<Long, Double> prices, Instant at, LocalDate session, TradingCalendar calendar) {
        PaperSettings settings = PaperSettings.defaults(KrPaperMarket.INSTANCE);
        store.atomically(() -> {
            BookState state = store.state(book).orElseThrow();
            double before = state.cash();
            double cash = before;
            Map<String, Position> held = new TreeMap<>();
            store.positions(book).forEach(p -> held.put(p.ticker(), p));
            List<Object[]> written = new ArrayList<>();
            for (Map.Entry<Long, Double> entry : prices.entrySet()) {
                Order order = store.order(entry.getKey()).orElseThrow();
                Position position = held.remove(order.ticker());
                BigDecimal price = BigDecimal.valueOf(entry.getValue());
                FillTerms terms = KrFills.termsFor(PaperLedger.Side.SELL, order.ticker(), new KrQuotes.Choice(session, price,
                        KrTimedLadder.SOURCE_AT, null), "KOSPI", settings, KrPaperMarket.BENCHMARK_TICKERS);
                FillTerms.Costs costs = terms.costs(position.qty());
                store.insertFill(new Fill(0, order.id(), book, order.ticker(), PaperBooks.SELL, position.qty(), terms.price(), terms.rawPrice(),
                        terms.slippageBp(), costs.gross(), at, session, terms.priceSource(), false, null, costs.fee(), costs.tax(),
                        costs.slippageCost()));
                if (!store.markOrderFilledIfPending(order.id(), at)) {
                    throw new IllegalStateException("대기가 아닌 주문: " + order.id());
                }
                store.deletePosition(book, order.ticker());
                store.upsertLockout(new Lockout(book, order.ticker(), TrailingStop.lockoutUntil(calendar, session, settings.lockoutTradingDays()),
                        PaperLedgerService.stopLockoutText(order, session, terms.price())));
                cash += costs.cashDelta();
                written.add(new Object[]{order, position});
            }
            double after = PaperLedger.round4(cash);
            for (Object[] row : written) {
                Order order = (Order) row[0];
                Map<String, Object> fill = new LinkedHashMap<>();
                fill.put(KrIntradayFill.MODE, KrStopFill.ON.name());
                fill.put(KrIntradayFill.RECORDED_AT, at.toString());
                fill.put(KrIntradayFill.BEFORE, KrIntradayFill.before((Position) row[1]));
                fill.put(KrIntradayFill.CASH_BEFORE, before);
                fill.put(KrIntradayFill.CASH_AFTER, after);
                ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy() : MAPPER.createObjectNode();
                reason.set(KrIntradayFill.FIELD, MAPPER.valueToTree(fill));
                store.updateOrderReason(order.id(), reason);
            }
            double equity = 0;
            for (Position p : held.values()) {
                equity += p.qty() * (p.lastPrice() != null ? p.lastPrice() : p.avgCost());
            }
            double nav = after + equity;
            store.updateStateValuation(book, after, PaperLedger.round4(nav), PaperLedger.round4(equity),
                    PaperLedger.round4(nav > 0 ? equity / nav * 100 : 0));
            return null;
        });
    }
}
