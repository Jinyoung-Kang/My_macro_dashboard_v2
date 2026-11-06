package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * 모의 한국 책을 밖(실제 계좌가 그 책을 따라 하는 기능 — ADR 0028 결정 8, 명세 docs/specs/2026-11-06-real-trade-mirror.md §3.1~3.3·§7.1)에 보이는 유일한
 * 공개 창 — 읽기와 선점만 합니다. 방향은 모의 → 밖 한쪽뿐이라 이 서비스는 밖의 타입을 모르고(공개 메서드 인자는 원시 값과 {@link Supplier}), 장부를
 * 바꾸는 저장소 메서드를 부르지 않습니다. 모의 책·프롬프트·패킷·고정본은 이 서비스가 있어도 그대로입니다.
 *
 * <ul>
 *   <li><b>읽기 문맥</b>: 부를 때마다 한국 시장 실행을 하나 엽니다({@link PaperMarkets#open} — 설정 행 하나와 조용히 읽은 공휴일 저장본으로 만든 달력 한 벌).
 *       관측치·감시 저장본은 {@link StoreReader#quietly}로만 읽습니다(수집을 깨우지 않음). 달력이 모르는 날이면 그 계산을 하지 않습니다(빈 값·거짓).</li>
 *   <li><b>시가 목표</b>({@link #openTargets}): 책의 보유 + 그 세션 시가에 체결될 모든 대기 주문(출처를 거르지 않음 — Claude·규칙·스탑·출발)을 마지막
 *       가격으로 {@link ExpectedState#simulate}한 비중. 그 주문들은 시가 맞추기가 흡수합니다.</li>
 *   <li><b>장중 주문</b>({@link #dueOrders}·{@link #weightAfter}): 그 세션의 시각 지정 대기 주문과, 그 주문 기준 시각까지의 모든 대기 주문(시가 포함)을
 *       {@link KrExpectedState}와 같은 가격 고르기로 체결했다고 본 뒤의 그 종목 비중.</li>
 *   <li><b>선점</b>({@link #claim}): 장부 잠금({@link PaperLedgerService#exclusively}) 안에서 그 주문이 아직 대기이고 따라 할 시각이 지났는지 다시 보고 받은
 *       일을 부릅니다. 장중 교체({@code ClaudeDecisionPipeline#supersedePendingAfter})도 같은 잠금 안에서 '기준 시각이 지금보다 뒤'인 주문만 취소하므로,
 *       선점한 주문(기준 시각이 지남)을 취소하지 않습니다 — 종가 주문은 아래 '따라 할 시각'의 예외가 있습니다.</li>
 * </ul>
 *
 * <p><b>따라 할 시각</b>({@link DueOrder#mirrorAt}): 매시·장중 시장가·분 단위 지정 시각은 기준 시각 T 그대로. 종가({@code NEXT_CLOSE})는 T가 마감이라 그 전에
 * 종가 단일가에 넣어야 하므로 모의 달력의 종가 단일가 시작(마감 − {@link KrTimedLadder#CLOSING_AUCTION})입니다 — 이 시각과 마감 사이에 끝난 장중 교체는
 * (그 주문의 T가 아직 뒤라) 선점한 종가 주문을 취소할 수 있습니다. 그런 어긋남은 다음 시가 맞추기가 목표로 되돌립니다.
 */
@Service
public class PaperMirrorService {

    /** 실제 계좌가 따라 할 수 있는 책(명세 §0 — 한국 규칙 계좌·Claude 계좌1·Claude 계좌2). */
    public static final List<String> FOLLOWABLE = List.of(PaperBooks.KR_RULES, PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2);

    // ------------------------------------------------------------------ 레코드
    /**
     * 책 하나. {@code status}는 NOT_STARTED·ACTIVE·PAUSED, {@code market}은 KR·US. {@code generation}은 출발일과 만든 시각을 이은 글
     * ('출발일|만든 시각', 출발 전이면 출발일 자리 '-') — 리셋(출발일이 비워짐)·재출발(출발일이 바뀜)을 알아채는 값입니다.
     */
    public record BookInfo(String code, String label, String kind, String market, String status, LocalDate startedOn,
                           Instant createdAt, String generation) {

        public boolean active() {
            return PaperBooks.ACTIVE.equals(status);
        }
    }

    /** 모의 한국 달력의 그날 — 거래일이면 정규장 개장·마감 순간(장 시간 변경일 설정 반영), 아니면 둘 다 null. */
    public record SessionHours(LocalDate date, boolean tradingDay, Instant open, Instant close) {
    }

    /**
     * 시가 맞추기의 목표(명세 §3.1). {@code weightPct}는 종목 → 예상 비중(%, 예상 순자산 대비 — 보유가 있는 종목만), {@code price}는 그 평가 가격,
     * {@code nav}·{@code cash}는 예상 순자산·현금. {@code absorbedOrderIds}는 그 세션 시가에 체결될 대기 주문 전부(가격을 몰라 체결로 보지 못한 것 포함 —
     * 장중 따라 하기로 따로 하지 않음), {@code unpricedOrderIds}는 그중 가격을 몰라 계산에 넣지 못한 주문 — 비어 있지 않으면 목표가 불완전합니다
     * ({@link #complete}).
     */
    public record OpenTargets(String book, LocalDate session, Map<String, Double> weightPct, Map<String, Double> price, double nav,
                              double cash, List<Long> absorbedOrderIds, List<Long> unpricedOrderIds) {

        public OpenTargets {
            weightPct = Map.copyOf(weightPct);
            price = Map.copyOf(price);
            absorbedOrderIds = List.copyOf(absorbedOrderIds);
            unpricedOrderIds = List.copyOf(unpricedOrderIds);
        }

        /** 흡수한 주문을 모두 계산에 넣었는가. */
        public boolean complete() {
            return unpricedOrderIds.isEmpty();
        }
    }

    /**
     * 그 세션의 시가 밖 대기 주문 하나(명세 §3.2). {@code rootOrderId}는 {@code reason.reissuedFrom} 사슬의 첫 주문(다시 낸 적 없으면 자기 번호),
     * {@code target}은 모의 기준 시각 T, {@code mirrorAt}은 따라 할 시각(클래스 설명 — 종가는 종가 단일가 시작). 따라 할 수 있는 시점(매시·장중 시장가·분 단위
     * 지정 시각·종가)이 아니거나 시각을 모르면 {@code supported=false}이고 {@code target}·{@code mirrorAt}이 null일 수 있습니다(보내지 않고 건너뜀).
     * 수량·목표 비중·매도 비율은 모의 주문 그대로(하나만 차 있음).
     */
    public record DueOrder(long orderId, long rootOrderId, String ticker, String side, String timing, String source, Instant target,
                           Instant mirrorAt, boolean supported, Double targetWeightPct, Double sellFraction, Integer qty) {
    }

    /**
     * 그 주문 뒤 그 종목의 예상 비중(명세 §3.2 — w*). {@code weightPct}는 예상 순자산 대비 %(보유가 없으면 0), {@code applied}는 그 주문 자체를 체결로
     * 보았는가(가격을 모르거나 1주도 못 사면 거짓 — 그때의 비중은 그 주문 전 값), {@code assumedOrderIds}는 체결로 본 주문, {@code unpricedOrderIds}는 기준
     * 시각이 지났지만 가격을 몰라 넣지 못한 주문.
     */
    public record WeightAfter(long orderId, String ticker, String side, double weightPct, double nav, boolean applied,
                              List<Long> assumedOrderIds, List<Long> unpricedOrderIds) {

        public WeightAfter {
            assumedOrderIds = List.copyOf(assumedOrderIds);
            unpricedOrderIds = List.copyOf(unpricedOrderIds);
        }
    }

    /** 다시 낸 주문 사슬을 거슬러 오르는 최대 단계(그 이상은 고리로 보고 멈춤). */
    static final int MAX_REISSUE_DEPTH = 32;

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperMarkets markets;
    private final PaperLedgerService ledger;
    private final Clock clock;

    @Autowired
    PaperMirrorService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperMarkets markets,
                       PaperLedgerService ledger) {
        this(store, reader, marketData, markets, ledger, Clock.systemUTC());
    }

    /** 시험용 — 시계(선점이 받은 시각을 지금과 대조)를 정합니다. */
    PaperMirrorService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperMarkets markets,
                       PaperLedgerService ledger, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.markets = markets;
        this.ledger = ledger;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ 책·달력
    /** 책 하나(시장을 가리지 않음 — 받는 쪽이 {@link BookInfo#market}을 봄). 표가 없거나 없는 책이면 empty. */
    public Optional<BookInfo> book(String code) {
        if (code == null || !store.ready()) {
            return Optional.empty();
        }
        return store.book(code).map(PaperMirrorService::info);
    }

    /** 모의 한국 달력의 그날(클래스 설명의 읽기 문맥). 달력이 모르는 날(공휴일 목록이 없는 해 등)이면 empty. */
    public Optional<SessionHours> sessionHours(LocalDate date) {
        Objects.requireNonNull(date, "date");
        try {
            TradingCalendar calendar = run().calendar();
            if (!calendar.isTradingDay(date)) {
                return Optional.of(new SessionHours(date, false, null, null));
            }
            return Optional.of(new SessionHours(date, true, calendar.openInstant(date), calendar.closeInstant(date)));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    /**
     * 그 책의 모의 장부가 세션 {@code session} 전 거래일(P)까지 반영했는가(명세 §3 '쉬는 경우') — 장부가 P의 관측치(또는 그 뒤)를 처리했고, 한국 결정 게이트
     * ①과 같은 판정({@link KrDecisionGates#ledger} — P 기준)으로 기준일 &lt; P인 대기 주문 중 장부가 아직 일하는 것(1분봉을 기다리는 P 이전의 시각 지정
     * 주문 등)이 없을 때만 참입니다. 장부가 그 관측치로 체결할 수 없는 주문(거래정지·기업행위·그날 보류 표시)은 기다리지 않습니다. 그런 대기가 남아 있으면
     * 시가 목표(그 세션 시가 주문만 봄)가 나중에 장부에 들어올 체결을 빠뜨리므로 그날은 쉽니다. 한국 책이 아니거나 상태가 없거나 달력이 모르면 거짓.
     */
    public boolean ledgerCaughtUp(String code, LocalDate session) {
        Objects.requireNonNull(session, "session");
        if (krBook(code) == null) {
            return false;
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            BookState state = store.state(code).orElse(null);
            if (state == null || state.lastProcessedCollectedAt() == null) {
                return false;
            }
            LocalDate previous = calendar.previousTradingDay(session);
            if (calendar.currentOrLastSession(state.lastProcessedCollectedAt()).isBefore(previous)) {
                return false;
            }
            Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(run));
            Map<Long, String> holds = ledger.orderHolds(run, code, state.lastProcessedCollectedAt());
            KrDecisionGates.Inputs inputs = new KrDecisionGates.Inputs(previous, null, quotes, null, null, null);
            return !KrDecisionGates.ledger(store, code, previous, inputs, holds).blocks();
        } catch (CalendarUnavailableException e) {
            return false;
        }
    }

    /** 모의 한국 설정의 현금성 종목({@code kr.cashLikeTickers}, 기본 153130) — 실제 매매 한 창 안 순서(매도 처음·매수 마지막, 명세 §3)에 씁니다. */
    public List<String> cashLikeTickers() {
        return List.copyOf(run().settings().cashLikeTickers());
    }

    // ------------------------------------------------------------------ 목표
    /**
     * 시가 맞추기의 목표(명세 §3.1, {@link OpenTargets}) — 장부 상태·보유 + 목표 세션이 {@code session}이고 그 세션 시가에 체결될 대기 주문(시가 주문 —
     * 출처를 거르지 않음, 그 세션 개장 뒤에 만든 주문은 장부도 다음 시가에 체결하므로 뺌, 만료된 것도 뺌)을 마지막 가격(밤 관측치의 종가 → 보유의 마지막
     * 평가 가격)으로 체결했다고 본 장부. 순서는 장부 시가 체결과 같이 매도 먼저, 매수는 현금성(설정 {@code kr.cashLikeTickers})을 마지막에.
     * 한국 책이 아니거나 상태가 없거나 거래일이 아니거나 달력이 모르거나 예상 순자산이 0 이하이면 empty — 빈 목표로 '모두 팔기'를 계산하지 않게.
     */
    public Optional<OpenTargets> openTargets(String code, LocalDate session) {
        Objects.requireNonNull(session, "session");
        if (krBook(code) == null) {
            return Optional.empty();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            if (!calendar.isTradingDay(session)) {
                return Optional.empty();
            }
            BookState state = store.state(code).orElse(null);
            if (state == null) {
                return Optional.empty();
            }
            List<Order> pending = store.ordersByStatus(code, PaperBooks.ORDER_PENDING);
            Quotes quotes = reader.quietly(() -> marketData.quotes(run)).orElse(null);
            Map<Long, Instant> targets = new HashMap<>();
            List<Order> due = openOrders(pending, session, run, targets);
            Map<String, Position> held = new TreeMap<>();
            Map<String, Double> price = new HashMap<>();
            ledgerPositions(store.positions(code), held, price);
            ExpectedState.State expected = ExpectedState.simulate(state.cash(), held, price, new ArrayList<>(due), targets, session,
                    calendar.openInstant(session), lastPrice(quotes));
            if (!(expected.nav() > 0)) {
                return Optional.empty();
            }
            Map<String, Double> weights = new TreeMap<>();
            for (Position p : expected.positions()) {
                Double at = expected.price().get(p.ticker());
                if (p.qty() > 0 && at != null) {
                    weights.put(p.ticker(), p.qty() * at / expected.nav() * 100);
                }
            }
            return Optional.of(new OpenTargets(code, session, weights, expected.price(), expected.nav(), expected.cash(),
                    due.stream().map(Order::id).sorted().toList(), expected.unpriced()));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    /**
     * 목표 세션이 {@code session}인 시가 밖 대기 주문 가운데 따라 할 시각({@link DueOrder#mirrorAt})이 {@code now} 이하인 것, 따라 할 수 없는 시점의 주문은
     * 시각과 상관없이 모두(받는 쪽이 건너뜀으로 남김) — 따라 할 시각 순, 같은 시각은 매도 먼저·번호 순. 한국 책이 아니거나 달력이 모르면 빈 목록.
     * 시가 주문은 시가 맞추기가 흡수하므로 넣지 않습니다.
     */
    public List<DueOrder> dueOrders(String code, LocalDate session, Instant now) {
        Objects.requireNonNull(session, "session");
        Objects.requireNonNull(now, "now");
        if (krBook(code) == null) {
            return List.of();
        }
        try {
            TradingCalendar calendar = run().calendar();
            List<Order> pending = store.ordersByStatus(code, PaperBooks.ORDER_PENDING);
            Map<Long, Order> byId = new HashMap<>();
            pending.forEach(o -> byId.put(o.id(), o));
            List<DueOrder> out = new ArrayList<>();
            for (Order o : pending) {
                if (PaperBooks.NEXT_OPEN.equals(o.timing()) || !session.equals(ExecutionAudit.targetSession(o, calendar))) {
                    continue;
                }
                Instant mirrorAt = mirrorAt(o, session, calendar);
                boolean supported = mirrorAt != null;
                if (supported && mirrorAt.isAfter(now)) {
                    continue;
                }
                out.add(new DueOrder(o.id(), root(code, o, byId), o.ticker(), o.side(), o.timing(), o.source(),
                        KrExpectedState.targetAt(o, session, calendar), mirrorAt, supported, o.targetWeightPct(), o.sellFraction(),
                        o.qty()));
            }
            out.sort(Comparator.comparing(DueOrder::mirrorAt, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparingInt(d -> PaperBooks.SELL.equals(d.side()) ? 0 : 1).thenComparingLong(DueOrder::orderId));
            return List.copyOf(out);
        } catch (CalendarUnavailableException e) {
            return List.of();
        }
    }

    /**
     * 그 주문 뒤 그 종목의 예상 비중(명세 §3.2, {@link WeightAfter}) — 장부 상태·보유 + 그 주문의 목표 세션 E의 시가 주문({@link #openTargets}와 같은 대상) +
     * E의 시각 지정 대기 주문 가운데 기준 시각이 그 주문의 기준 시각 T 이하인 것(그 주문 포함, 출처를 거르지 않음)을 {@link KrExpectedState}와 같은 가격
     * 고르기({@link KrExpectedState#pricer} — 감시 저장본({@code now} 전에 받은 것) → 밤 관측치 → 보유의 마지막 평가 가격)로 체결했다고 본 장부.
     * 그 주문이 이 책의 대기 주문이 아니거나 기준 시각을 모르거나 상태가 없거나 예상 순자산이 0 이하이면 empty.
     */
    public Optional<WeightAfter> weightAfter(String code, long orderId, Instant now) {
        Objects.requireNonNull(now, "now");
        if (krBook(code) == null) {
            return Optional.empty();
        }
        Order order = store.order(orderId).filter(o -> code.equals(o.bookCode())).orElse(null);
        if (order == null || !PaperBooks.ORDER_PENDING.equals(order.status())) {
            return Optional.empty();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            LocalDate session = ExecutionAudit.targetSession(order, calendar);
            Instant cutoff = session == null ? null : KrExpectedState.targetAt(order, session, calendar);
            BookState state = store.state(code).orElse(null);
            if (cutoff == null || state == null) {
                return Optional.empty();
            }
            List<Order> pending = store.ordersByStatus(code, PaperBooks.ORDER_PENDING);
            Map<Long, Instant> targets = new HashMap<>();
            List<Order> due = openOrders(pending, session, run, targets);
            for (Order o : pending) {
                if (PaperBooks.NEXT_OPEN.equals(o.timing()) || !session.equals(ExecutionAudit.targetSession(o, calendar))) {
                    continue;
                }
                Instant target = KrExpectedState.targetAt(o, session, calendar);
                if (target != null && !target.isAfter(cutoff)) {
                    due.add(o);
                    targets.put(o.id(), target);
                }
            }
            JsonNode watch = reader.quietly(marketData::watchKr)
                    .filter(s -> s.collectedAt() != null && !s.collectedAt().isAfter(now)).map(Snapshot::payload).orElse(null);
            Quotes quotes = reader.quietly(() -> marketData.quotes(run)).orElse(null);
            Map<String, Position> held = new TreeMap<>();
            Map<String, Double> price = new HashMap<>();
            ledgerPositions(store.positions(code), held, price);
            ExpectedState.State expected = ExpectedState.simulate(state.cash(), held, price, due, targets, session, now,
                    KrExpectedState.pricer(now, watch, quotes));
            if (!(expected.nav() > 0)) {
                return Optional.empty();
            }
            double weight = 0;
            for (Position p : expected.positions()) {
                Double at = expected.price().get(p.ticker());
                if (p.ticker().equals(order.ticker()) && at != null) {
                    weight = p.qty() * at / expected.nav() * 100;
                }
            }
            List<Long> assumed = expected.assumed().stream().map(ExpectedState.Assumed::orderId).toList();
            return Optional.of(new WeightAfter(orderId, order.ticker(), order.side(), weight, expected.nav(), assumed.contains(orderId),
                    assumed, expected.unpriced()));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    // ------------------------------------------------------------------ 주문 하나
    /** 그 책 주문의 상태(PENDING·FILLED·CANCELLED·EXPIRED·REJECTED 등). 그 책의 주문이 아니면 empty. */
    public Optional<String> orderStatus(String code, long orderId) {
        if (code == null || !store.ready()) {
            return Optional.empty();
        }
        return store.order(orderId).filter(o -> code.equals(o.bookCode())).map(Order::status);
    }

    /**
     * 그 주문의 뿌리 — {@code reason.reissuedFrom}(다시 낸 주문의 원래 번호)을 거슬러 오른 첫 주문 번호. 다시 낸 적이 없으면 자기 번호. 사슬 중간의 주문이
     * 없으면(지워짐) 마지막으로 가리킨 번호에서 멈추고, 다른 책의 주문을 가리키거나 고리이면 거기서 멈춥니다. 그 책의 주문이 아니면 empty.
     */
    public Optional<Long> rootOf(String code, long orderId) {
        if (code == null || !store.ready()) {
            return Optional.empty();
        }
        return store.order(orderId).filter(o -> code.equals(o.bookCode())).map(o -> root(code, o, Map.of()));
    }

    /**
     * 선점(명세 §3.3) — 장부 잠금 안에서 그 주문을 다시 읽어, 이 책의 대기(PENDING) 주문이고 책이 운용 중이며 목표 세션이 {@code now}의 한국 날짜이고 따라 할
     * 시각({@link DueOrder#mirrorAt})이 {@code now}와 이 서비스의 지금 시각 모두 이하일 때만 {@code insert}를 부르고 그 결과를 돌려줍니다. 아니면 부르지 않고
     * empty — 장중 교체가 먼저 취소했으면 대기가 아니라 empty입니다. 시가 주문은 선점하지 않습니다(시가 맞추기가 흡수). {@code insert}는 잠금 안에서 돌므로
     * 네트워크 호출을 하지 마세요(DB 쓰기만). {@code insert}가 던진 예외는 그대로 나가고 잠금은 풀립니다. null을 돌려주면 empty입니다.
     */
    public <T> Optional<T> claim(String code, long orderId, Instant now, Supplier<T> insert) {
        Objects.requireNonNull(now, "now");
        Objects.requireNonNull(insert, "insert");
        if (code == null || !store.ready()) {
            return Optional.empty();
        }
        TradingCalendar calendar = run().calendar();
        return ledger.exclusively(() -> {
            Order order = store.order(orderId).filter(o -> code.equals(o.bookCode())).orElse(null);
            if (order == null || !PaperBooks.ORDER_PENDING.equals(order.status())) {
                return Optional.empty();
            }
            Book book = store.book(code).orElse(null);
            if (book == null || !Book.MARKET_KR.equals(book.market()) || !PaperBooks.ACTIVE.equals(book.status())) {
                return Optional.empty();
            }
            Instant mirrorAt;
            try {
                LocalDate session = ExecutionAudit.targetSession(order, calendar);
                if (session == null || !session.equals(now.atZone(KrxCalendar.SEOUL).toLocalDate())) {
                    return Optional.empty();
                }
                mirrorAt = mirrorAt(order, session, calendar);
            } catch (CalendarUnavailableException e) {
                return Optional.empty();
            }
            if (mirrorAt == null || mirrorAt.isAfter(now) || mirrorAt.isAfter(clock.instant())) {
                return Optional.empty();
            }
            return Optional.ofNullable(insert.get());
        });
    }

    // ------------------------------------------------------------------ 보조
    private MarketRun run() {
        return markets.open(KrPaperMarket.INSTANCE);
    }

    /** 표가 있고 그 코드가 한국 책이면 그 책, 아니면 null. */
    private Book krBook(String code) {
        if (code == null || !store.ready()) {
            return null;
        }
        return store.book(code).filter(b -> Book.MARKET_KR.equals(b.market())).orElse(null);
    }

    private static BookInfo info(Book book) {
        return new BookInfo(book.code(), book.label(), book.kind(), book.market(), book.status(), book.startedOn(), book.createdAt(),
                generation(book));
    }

    /** 책의 세대 글({@link BookInfo#generation}). */
    static String generation(Book book) {
        return (book.startedOn() == null ? "-" : book.startedOn().toString()) + "|" + book.createdAt();
    }

    /**
     * 목표 세션이 {@code session}이고 그 세션 시가에 장부가 체결할 대기 주문({@link #openTargets} 설명) — 기준 시각을 {@code targets}에 넣습니다. 현금성 매수는
     * 시가보다 1나노초 뒤로 두어 {@link ExpectedState#simulate}의 순서(시각 → 매도 먼저 → 번호)에서 다른 매수 뒤에 오게 합니다(장부 시가 체결의 현금성 마지막
     * 규칙 — 매도는 현금을 늘리기만 하므로 순서가 결과를 바꾸지 않음).
     */
    private static List<Order> openOrders(List<Order> pending, LocalDate session, MarketRun run, Map<Long, Instant> targets) {
        TradingCalendar calendar = run.calendar();
        Instant open = calendar.openInstant(session);
        List<Order> out = new ArrayList<>();
        for (Order o : pending) {
            if (!PaperBooks.ORDER_PENDING.equals(o.status()) || !PaperBooks.NEXT_OPEN.equals(o.timing())
                    || !session.equals(ExecutionAudit.targetSession(o, calendar))
                    || (o.expiresOn() != null && o.expiresOn().isBefore(session))
                    || !KrFills.opensAfterOrder(o, session, calendar)) {
                continue;
            }
            out.add(o);
            boolean cashLikeBuy = PaperBooks.BUY.equals(o.side()) && run.settings().cashLike(o.ticker());
            targets.put(o.id(), cashLikeBuy ? open.plusNanos(1) : open);
        }
        return out;
    }

    /** 따라 할 시각(클래스 설명) — 종가는 종가 단일가 시작, 매시·장중 시장가·분 단위 지정 시각은 기준 시각, 시가·모르는 시점·시각 없음은 null. */
    private static Instant mirrorAt(Order order, LocalDate session, TradingCalendar calendar) {
        if (PaperBooks.NEXT_CLOSE.equals(order.timing())) {
            return calendar.closeInstant(session).minus(KrTimedLadder.CLOSING_AUCTION);
        }
        if (!KrTimedLadder.timed(order.timing())) {
            return null;
        }
        return KrTimedLadder.targetOn(order, session, calendar);
    }

    /** 장부 보유 → 종목별 보유·평가 가격(마지막 평가 가격, 없으면 평단 — {@link KrExpectedState#of}와 같은 규칙). */
    private static void ledgerPositions(List<Position> positions, Map<String, Position> held, Map<String, Double> price) {
        for (Position p : positions) {
            held.put(p.ticker(), p);
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
    }

    /** 마지막 가격 — 밤 관측치의 그 종목 종가, 없으면 보유의 마지막 평가 가격(없으면 평단). 모두 없으면 null(체결로 보지 않음). */
    private static ExpectedState.Pricer lastPrice(Quotes quotes) {
        return (o, target, position) -> {
            Bar bar = quotes == null ? null : quotes.bars().get(o.ticker());
            if (bar != null && Double.isFinite(bar.close()) && bar.close() > 0) {
                return new ExpectedState.Priced(bar.close(), ExpectedState.PRICE_LAST);
            }
            if (position != null) {
                double last = position.lastPrice() != null ? position.lastPrice() : position.avgCost();
                if (Double.isFinite(last) && last > 0) {
                    return new ExpectedState.Priced(last, ExpectedState.PRICE_LAST);
                }
            }
            return null;
        };
    }

    /** 뿌리 번호({@link #rootOf} 설명). {@code known}에 있는 주문은 다시 읽지 않습니다. */
    private long root(String code, Order order, Map<Long, Order> known) {
        Order current = order;
        Set<Long> seen = new HashSet<>();
        seen.add(current.id());
        for (int depth = 0; depth < MAX_REISSUE_DEPTH; depth++) {
            Long from = reissuedFrom(current);
            if (from == null || !seen.add(from)) {
                return current.id();
            }
            Order previous = known.containsKey(from) ? known.get(from) : store.order(from).orElse(null);
            if (previous == null) {
                return from;   // 원래 주문이 지워짐 — 가리킨 번호가 가장 이른 아는 뿌리
            }
            if (!code.equals(previous.bookCode())) {
                return current.id();
            }
            current = previous;
        }
        return current.id();
    }

    private static Long reissuedFrom(Order order) {
        JsonNode reason = order.reason();
        JsonNode from = reason == null ? null : reason.get(UsTimedFills.REISSUED_FROM);
        return from != null && from.isIntegralNumber() && from.canConvertToLong() ? from.asLong() : null;
    }
}
