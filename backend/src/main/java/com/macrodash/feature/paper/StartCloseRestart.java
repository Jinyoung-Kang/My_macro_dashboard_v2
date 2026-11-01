package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Params;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 출발일 종가로 다시 출발(사용자 결정 2026-11-02 — 미국 Claude 계좌2·한국 네 계좌를 2026-10-30 종가 체결로 시작). 출발 결정(INITIAL)의 주문이 아직
 * 하나도 체결되지 않은 계좌만 받습니다: 그 대기 주문을 취소하고({@value #CANCEL_REASON}), 같은 주문(종목·비중)을 출발일 S 종가로 사후 체결합니다.
 *
 * <ul>
 *   <li><b>미국</b> — 미국 계좌1·벤치마크의 출발과 같은 사후 체결({@link PaperLedgerService#backfill}: 종가 × 슬리피지, 시간별 관측치 출처
 *       {@link PaperMarketData#sourcedCloseOn}).</li>
 *   <li><b>한국</b> — 금융위 확정 종가(주식시세 {@code fsc_price}·증권상품시세 {@code fsc_etf_price}, 거래량 &gt; 0 행만 — {@link KrConfirmed.Day#observed})로
 *       한국 체결 조건 그대로: 체결가 = 확정 종가, 수수료·슬리피지는 비용 칸({@link KrxCosts}), 수량은 비용 포함 유출이 예산 안. 확정가로 체결하므로
 *       금융위 확정 조정 대상이 아닙니다(사후 체결 행은 확정 조정이 보지 않음 — {@link PaperStore#unconfirmedFills}). 종목 구분을 모르면 짐작하지 않고
 *       거절합니다.</li>
 * </ul>
 *
 * <p>사후 체결은 출발일 S 마감의 순자산 줄(확정)을 다시 쓰고, 계좌의 관측치 처리 기억(마지막 관측·처리 수집 시각)은 앞의 값을 그대로 둡니다 — 그 뒤
 * 이미 처리한 관측치를 다시 처리하지 않고, 다음 관측치가 새 보유를 평가합니다. 하나라도 종가가 없으면 아무것도 쓰지 않습니다(전부 아니면 없음).
 * 한 트랜잭션·장부 잠금 안에서 합니다.
 *
 * <p>룩어헤드에 대해: 출발 결정은 S 마감 뒤의 자료로 내려졌고(미국 계좌2 10-31 16:32 KST, 한국 10-30 22:38 KST) 그 종가로 체결합니다 — 미국 계좌1
 * 출발(사후 체결)과 같은 규칙이며, 한국 명세의 '출발일 사후 체결 없음'(K28)과 계좌2의 '앞으로 체결 출발'(ADR 0022 결정 2)을 이 계좌들에 한해 바꿉니다.
 */
final class StartCloseRestart {

    /** 취소한 출발 주문의 사유 — 체결 시점 실험 M1의 '체결 안 됨'에서 뺍니다({@link ExecutionView}). */
    static final String CANCEL_REASON = "출발일 종가 사후 체결로 다시 출발";
    /** 사후 체결 주문 근거의 표시. */
    static final String REASON_KEY = "restartAtStartClose";

    /**
     * 결과.
     *
     * @param startDate 출발일(체결 거래일)
     * @param cancelled 취소한 출발 주문 번호
     * @param fills     낸 사후 체결(체결 순서)
     * @param skipped   체결하지 못한 다리(종목 → 사유 — 1주도 살 수 없음·현금 모자람)
     */
    record Result(String code, LocalDate startDate, List<Long> cancelled, List<Fill> fills,
                  List<Map.Entry<String, String>> skipped, double cash, double nav) {
    }

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final StoreReader reader;
    private final PaperLedgerService ledger;
    private final ObjectMapper mapper;
    private final PaperMarkets markets;

    StartCloseRestart(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperLedgerService ledger,
                      ObjectMapper mapper, PaperMarkets markets) {
        this.store = store;
        this.marketData = marketData;
        this.reader = reader;
        this.ledger = ledger;
        this.mapper = mapper;
        this.markets = markets;
    }

    /**
     * 계좌 하나를 출발일 종가로 다시 출발시킵니다(클래스 설명).
     *
     * @param confirm 확인 문구 — 계좌 코드 그대로(실수 방지)
     * @throws InvalidRequestException 없는 계좌·확인 문구 다름·운용 중이 아님·이미 체결이 있음·출발 주문이 없거나 출발 결정의 주문이 아님·
     *                                 종가 없음·종목 구분 모름
     */
    Result restart(String code, String confirm) {
        if (!store.ready()) {
            throw new IllegalStateException("모의 매매 테이블이 아직 없습니다");
        }
        Book book = store.book(code).orElseThrow(() -> new InvalidRequestException("없는 계좌입니다: " + Params.echo(code)));
        if (confirm == null || !confirm.equals(code)) {
            throw new InvalidRequestException("출발일 종가로 다시 출발하려면 확인 문구로 계좌 코드(" + code + ")를 그대로 입력하세요.");
        }
        if (!PaperBooks.ACTIVE.equals(book.status()) || book.startedOn() == null) {
            throw new InvalidRequestException(code + "은 운용 중(출발한) 계좌가 아닙니다 — 상태 " + book.status());
        }
        if (!store.recentFills(code, 1).isEmpty()) {
            throw new InvalidRequestException(code + "에는 이미 체결이 있습니다 — 체결 전 출발 주문만 출발일 종가로 바꿉니다");
        }
        LocalDate start = book.startedOn();
        PaperMarket definition = markets.of(book.market()).orElseThrow(() -> new InvalidRequestException(
                code + "의 시장(" + book.market() + ")을 모릅니다"));
        // 그 시장의 실행 문맥 — 달력(한국은 실행마다 만듦)과 지금 설정 판 하나.
        MarketRun market = markets.open(definition);
        List<Order> pending = store.ordersByStatus(code, PaperBooks.ORDER_PENDING);
        Decision decision = startDecision(code, start, pending);
        PaperSettings current = market.settings();
        boolean korea = Book.MARKET_KR.equals(book.market());
        Map<String, PaperMarketData.SourcedClose> usCloses = korea ? Map.of() : usCloses(pending, start);
        Map<String, KrClose> krCloses = korea ? krCloses(market, pending, start, current) : Map.of();
        List<PaperLedgerService.BackfillLeg> legs = new ArrayList<>();
        for (Order order : pending) {
            legs.add(new PaperLedgerService.BackfillLeg(order.ticker(), PaperBooks.BUY, order.targetWeightPct(), null,
                    reason(order, start)));
        }
        return ledger.exclusively(() -> store.atomically(() -> {
            BookState before = store.state(code).orElseThrow(() -> new IllegalStateException(code + " 계좌 상태가 없습니다"));
            List<Long> cancelled = new ArrayList<>();
            for (Order order : pending) {
                store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, CANCEL_REASON);
                cancelled.add(order.id());
            }
            Filled filled = korea
                    ? krBackfill(market, book, start, decision.id(), order(pending).source(), before, legs, krCloses, current)
                    : usBackfill(book, start, decision.id(), order(pending).source(), before, legs, usCloses, current);
            BookState after = store.state(code).orElseThrow();
            // 관측치 처리 기억은 앞의 값 — 출발일 뒤 이미 처리한 관측치를 다시 처리하지 않게(클래스 설명).
            store.upsertState(new BookState(code, after.cash(), after.nav(), after.equityValue(), after.exposurePct(),
                    later(before.lastObservedAt(), after.lastObservedAt()),
                    later(before.lastProcessedCollectedAt(), after.lastProcessedCollectedAt()),
                    laterDate(before.lastNavTradingDate(), after.lastNavTradingDate()), null));
            return new Result(code, start, cancelled, filled.fills(), filled.skipped(), after.cash(), after.nav());
        }));
    }

    private record Filled(List<Fill> fills, List<Map.Entry<String, String>> skipped) {
    }

    /** 대기 주문이 모두 그 계좌의 출발 결정(INITIAL, 기준 거래일 = 출발일)이 낸 매수(목표 비중)인지 보고 그 결정을 돌려줍니다. */
    private Decision startDecision(String code, LocalDate start, List<Order> pending) {
        if (pending.isEmpty()) {
            throw new InvalidRequestException(code + "에 체결 전 출발 주문이 없습니다");
        }
        Long decisionId = pending.get(0).decisionId();
        for (Order order : pending) {
            if (order.decisionId() == null || !order.decisionId().equals(decisionId)
                    || !start.equals(order.asOfTradingDate()) || !PaperBooks.BUY.equals(order.side())
                    || order.targetWeightPct() == null || !(order.targetWeightPct() > 0)) {
                throw new InvalidRequestException(code + "의 대기 주문 " + order.id() + "은 출발 결정의 매수 주문이 아닙니다 — 출발 주문만 있는 "
                        + "계좌를 다시 출발시킵니다");
            }
        }
        Decision decision = store.decision(decisionId).orElseThrow(() -> new InvalidRequestException(
                "출발 결정 " + decisionId + "을 찾지 못했습니다"));
        if (!code.equals(decision.bookCode()) || !RuleBookService.INITIAL.equals(decision.kind())
                || !start.equals(decision.asOfTradingDate())) {
            throw new InvalidRequestException("결정 " + decisionId + "은 " + code + "의 출발(INITIAL, " + start + ") 결정이 아닙니다");
        }
        return decision;
    }

    private static Order order(List<Order> pending) {
        return pending.get(0);
    }

    private JsonNode reason(Order order, LocalDate start) {
        ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy() : mapper.createObjectNode();
        ObjectNode restart = reason.putObject(REASON_KEY);
        restart.put("originalOrderId", order.id());
        restart.put("originalTiming", order.timing());
        restart.put("startDate", start.toString());
        restart.put("note", CANCEL_REASON + "(사용자 결정 2026-11-02)");
        return reason;
    }

    // ------------------------------------------------------------------ 미국
    private Map<String, PaperMarketData.SourcedClose> usCloses(List<Order> pending, LocalDate start) {
        Map<String, PaperMarketData.SourcedClose> out = new LinkedHashMap<>();
        for (Order order : pending) {
            Optional<PaperMarketData.SourcedClose> close = reader.quietly(() -> marketData.sourcedCloseOn(order.ticker(), start));
            if (close == null || close.isEmpty()) {
                throw new InvalidRequestException(start + " " + order.ticker() + " 종가가 없습니다(10년 이력 equity_close·관측치 paper.quotes) — "
                        + "아무것도 바꾸지 않았습니다");
            }
            out.put(order.ticker(), close.get());
        }
        return out;
    }

    private Filled usBackfill(Book book, LocalDate start, long decisionId, String source, BookState before,
                              List<PaperLedgerService.BackfillLeg> legs, Map<String, PaperMarketData.SourcedClose> closes,
                              PaperSettings current) {
        PaperLedgerService.BackfillResult result = ledger.backfill(new PaperLedgerService.BackfillRequest(book, start, source,
                decisionId, before.cash(), before.nav(), legs, closes, current));
        return new Filled(result.fills(), result.skipped());
    }

    // ------------------------------------------------------------------ 한국
    /** 출발일 금융위 확정 종가 한 종목 — 값·출처(FSC·FSC_ETF)·비용 종목 구분. */
    private record KrClose(BigDecimal close, String source, KrxCosts.Instrument instrument) {
    }

    private Map<String, KrClose> krCloses(MarketRun market, List<Order> pending, LocalDate start, PaperSettings current) {
        List<String> codes = pending.stream().map(Order::ticker).distinct().toList();
        KrConfirmed confirmed = reader.quietly(() -> market.confirmedPrices(marketData, codes, current, start));
        if (confirmed == null) {
            throw new InvalidRequestException("금융위 확정 시세를 읽지 못했습니다 — 아무것도 바꾸지 않았습니다");
        }
        Map<String, KrClose> out = new LinkedHashMap<>();
        for (String code : codes) {
            KrConfirmed.Series series = confirmed.of(code);
            Optional<KrConfirmed.Day> day = series.on(start).filter(KrConfirmed.Day::observed);
            if (day.isEmpty()) {
                throw new InvalidRequestException(start + " " + code + " 금융위 확정 종가가 아직 없습니다(거래량 > 0 행 — 금융위는 다음 영업일 "
                        + "13시 뒤 공개, 수집기 fsc_prices·fsc_etf_prices) — 아무것도 바꾸지 않았습니다");
            }
            boolean etf = KrPaperMarket.etf(code, current);
            Optional<KrxCosts.Instrument> instrument = KrxCosts.classify(day.get().market(), etf);
            if (instrument.isEmpty()) {
                throw new InvalidRequestException(code + " 종목 구분을 모릅니다(금융위 시장 구분 '" + day.get().market() + "', ETF 목록 밖) — "
                        + "비용을 짐작하지 않습니다. 아무것도 바꾸지 않았습니다");
            }
            out.put(code, new KrClose(day.get().close(), series.source(), instrument.get()));
        }
        return out;
    }

    /**
     * 한국 사후 체결 — 매수만(출발 주문), 순서는 현금성이 아닌 매수 → 현금성 매수(미국 사후 체결과 같은 순서), 매수 예산 = 체결 전 순자산 × 목표
     * 비중과 남은 현금 중 작은 쪽, 수량 = 비용 포함 유출이 예산 안인 최대 정수 주({@link KrxCosts#affordableQty}).
     */
    private Filled krBackfill(MarketRun market, Book book, LocalDate start, long decisionId, String source,
                              BookState before, List<PaperLedgerService.BackfillLeg> legs, Map<String, KrClose> closes,
                              PaperSettings current) {
        String code = book.code();
        Instant close = market.calendar().closeInstant(start);
        PaperSettings.CostRates costRates = current.costRates();
        if (costRates == null) {
            throw new IllegalStateException("한국 비용 요율이 없는 설정입니다 — 한국 시장 판으로 읽은 설정이어야 합니다");
        }
        KrxCosts.Rates rates = costRates.rates(current.slippageBp());
        double baseNav = before.nav();
        double cash = before.cash();
        List<PaperLedgerService.BackfillLeg> ordered = new ArrayList<>();
        legs.stream().filter(leg -> !current.cashLike(leg.ticker())).forEach(ordered::add);
        legs.stream().filter(leg -> current.cashLike(leg.ticker())).forEach(ordered::add);
        Map<String, Position> held = new LinkedHashMap<>();
        store.positions(code).forEach(p -> held.put(p.ticker(), p));
        List<Fill> fills = new ArrayList<>();
        List<Map.Entry<String, String>> skipped = new ArrayList<>();
        for (PaperLedgerService.BackfillLeg leg : ordered) {
            KrClose price = closes.get(leg.ticker());
            double budget = Math.min(baseNav * leg.targetWeightPct() / 100.0, cash);
            int qty = budget > 0 ? KrxCosts.affordableQty(BigDecimal.valueOf(budget), price.close(), rates) : 0;
            if (qty <= 0) {
                skipped.add(Map.entry(leg.ticker(), leg.ticker() + " 확정 종가(" + price.close().toPlainString()
                        + "원)로는 예산(" + PaperLedgerService.money(budget) + "원) 안에서 1주도 살 수 없습니다"));
                continue;
            }
            KrxCosts.Costs costs = KrxCosts.fill(PaperLedger.Side.BUY, price.instrument(), start, qty, price.close(), rates);
            double gross = costs.notional().doubleValue();
            long orderId = store.insertOrder(new Order(0, code, decisionId, leg.ticker(), PaperBooks.BUY, null,
                    leg.targetWeightPct(), null, PaperBooks.BACKFILL, source, PaperBooks.ORDER_FILLED, null, leg.reason(),
                    market.calendar().previousTradingDay(start), close.minusSeconds(1), null, close));
            Fill fill = new Fill(0, orderId, code, leg.ticker(), PaperBooks.BUY, qty, price.close().doubleValue(),
                    price.close().doubleValue(), current.slippageBp(), gross, close, start, price.source(), true, null,
                    costs.commission(), costs.tax(), costs.slippage());
            long fillId = store.insertFill(fill);
            fills.add(new Fill(fillId, orderId, code, leg.ticker(), PaperBooks.BUY, qty, fill.price(), fill.rawPrice(),
                    fill.slippageBp(), gross, close, start, price.source(), true, null, fill.fee(), fill.tax(),
                    fill.slippageCost()));
            cash = PaperLedger.round4(cash + costs.cashFlow().doubleValue());
            double unit = PaperLedger.round4(price.close().doubleValue());
            Position existing = held.get(leg.ticker());
            Position position = existing == null
                    ? new Position(code, leg.ticker(), qty, unit, start, close, unit, close, unit, close, false, start,
                    price.close().doubleValue(), null)
                    : new Position(code, leg.ticker(), existing.qty() + qty,
                    PaperLedger.round4(PaperLedger.averageCost(existing.qty(), existing.avgCost(), qty, unit)),
                    existing.openedOn(), existing.openedAt(), Math.max(existing.highWatermark(), unit), close, unit, close,
                    false, existing.fillRefDate(), existing.fillRefClose(), existing.splitNote());
            held.put(leg.ticker(), position);
            store.upsertPosition(position);
        }
        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position position : held.values()) {
            KrClose known = closes.get(position.ticker());
            qty.put(position.ticker(), position.qty());
            price.put(position.ticker(), known != null ? known.close().doubleValue()
                    : position.lastPrice() != null ? position.lastPrice() : position.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(cash, qty, price);
        double nav = PaperLedger.round4(valuation.nav());
        double equity = PaperLedger.round4(valuation.equityValue());
        double exposure = PaperLedger.round4(valuation.exposurePct());
        store.upsertNav(new NavRow(code, start, nav, cash, equity, exposure, true));
        store.upsertState(new BookState(code, cash, nav, equity, exposure, close, close, start, null));
        return new Filled(fills, skipped);
    }

    private static Instant later(Instant a, Instant b) {
        if (a == null) {
            return b;
        }
        return b == null || a.isAfter(b) ? a : b;
    }

    private static LocalDate laterDate(LocalDate a, LocalDate b) {
        if (a == null) {
            return b;
        }
        return b == null || a.isAfter(b) ? a : b;
    }
}
