package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.SessionWindows;
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

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
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
 *   <li><b>시각 맞추기</b>(ADR 0033 초안 — {@link #dailySyncAt}·{@link #targetsAt}·{@link #pendingStopSymbols}): 따라 하는 책이 개장 10분 뒤 지정
 *       시각으로 체결하면 실제 매매·ISA가 시가 단일가 대신 그 시각 시장가로 맞추는 시각과 그 시각까지의 목표(시각 지정 STOP은 흡수하지 않음), 매수 전에
 *       뺄 대기 STOP 종목. ISA 자동 기록의 사다리 가격은 {@link #pricesAt}·{@link #orderLadderPrice}.</li>
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
                              double cash, List<Long> absorbedOrderIds, List<Long> unpricedOrderIds, List<Long> stopOrderIds) {

        public OpenTargets {
            weightPct = Map.copyOf(weightPct);
            price = Map.copyOf(price);
            absorbedOrderIds = List.copyOf(absorbedOrderIds);
            unpricedOrderIds = List.copyOf(unpricedOrderIds);
            stopOrderIds = List.copyOf(stopOrderIds);
        }

        /** 시각 지정 STOP을 따로 두지 않는 목표(시가 목표 — {@link #openTargets}). */
        public OpenTargets(String book, LocalDate session, Map<String, Double> weightPct, Map<String, Double> price, double nav,
                           double cash, List<Long> absorbedOrderIds, List<Long> unpricedOrderIds) {
            this(book, session, weightPct, price, nav, cash, absorbedOrderIds, unpricedOrderIds, List.of());
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

        /**
         * 스탑 매도인가 — 출처 STOP의 매도(장중 감시·밤 대체·손으로 넣은 STOP 모두, ADR 0033). 실제 매매는 이 주문의 비중을 셈하지 않고 정수 보유 전량을
         * 팔고(그 뒤 비중 0), 일일 맞추기 묶음이 흡수하지 않습니다(묶음이 실패해도 손절이 나가게 — 통합 검토 R3).
         */
        public boolean stop() {
            return PaperBooks.SOURCE_STOP.equals(source) && PaperBooks.SELL.equals(side);
        }
    }

    /**
     * ISA 계좌 자동 기록의 사다리 가격 하나(ADR 0033 — {@link #pricesAt}·{@link #orderLadderPrice}). {@code price}가 있으면 모의 장부가 같은 주문을
     * 체결할 값(1분봉 사다리 — 원가격), {@code unfillable}이면 그 세션 자료로는 체결하지 않음(그날 1분봉 없음·T 뒤 거래 없음 — 거래 정지 등),
     * {@code noWindow}면 그 세션 1분봉 저장본에 그 종목·시각의 창이 아예 없음(그 시각의 모의 주문이 없던 종목 — 수집기가 받지 않음). 셋 다 아니면 기다림
     * (결과에 넣지 않음).
     */
    public record LadderPrice(BigDecimal price, boolean unfillable, boolean noWindow) {
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

    /**
     * 그 책의 그 거래일 정기 결정(규칙 계좌의 {@code REBALANCE}·{@code SCHEDULED}·{@code INITIAL} — ISA 계좌, ADR 0029 명세 §2)과 그 거래일의 한국 결정
     * 기한(그 실행 설정 판의 {@code kr.decisionDeadlineKst} — 기본 D+1 01:00). 결정 행이 없으면 {@code decisionId}·{@code kind}·{@code status}가 null입니다.
     * 최종(OK·NO_TRADE·SKIPPED 또는 기한 지남)인가는 받는 쪽이 정합니다.
     */
    public record DecisionState(LocalDate date, Long decisionId, String kind, String status, Instant deadline) {
    }

    /** {@link #decisionState}가 찾는 정기 결정 종류(앞이 먼저). */
    private static final List<String> SCHEDULED_KINDS = List.of(RuleBookService.REBALANCE, RuleBookService.SCHEDULED,
            RuleBookService.INITIAL);

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

    // ------------------------------------------------------------------ ISA 계좌 읽기 도우미(ADR 0029 — 읽기만, 장부 쓰기 없음)
    /**
     * 그 책의 그 거래일 정기 결정과 결정 기한({@link DecisionState}). 한국 책이 아니거나 표가 없으면 empty.
     */
    public Optional<DecisionState> decisionState(String code, LocalDate date) {
        Objects.requireNonNull(date, "date");
        if (krBook(code) == null) {
            return Optional.empty();
        }
        MarketRun run = run();
        Instant deadline = KrPaperMarket.decisionWindow(run, run.settingsBody(), date).deadline();
        for (String kind : SCHEDULED_KINDS) {
            Optional<PaperStore.Decision> decision = store.decisionFor(code, date, kind);
            if (decision.isPresent()) {
                return Optional.of(new DecisionState(date, decision.get().id(), decision.get().kind(), decision.get().status(), deadline));
            }
        }
        return Optional.of(new DecisionState(date, null, null, null, deadline));
    }

    /**
     * 세션 {@code session}의 시가 — 모의 장부가 그 세션 관측치로 시가 주문을 체결할 때와 같은 사다리({@link KrFills} — '개장 + 1분' 1분봉 시가(거래량 &gt; 0)
     * → 토스 일봉 시가, 1분봉 FAILED는 결정 기한 뒤 수집본까지 기다림)로 밤 관측치({@code paper.kr.quotes})에서 고른 값. 관측치에 그 세션 봉이 없거나(아직
     * 수집 전·이어받은 항목·거래량 0) 사다리가 기다리는 종목은 결과에 없습니다(짐작하지 않음). 달력이 모르거나 거래일이 아니면 빈 표.
     */
    public Map<String, BigDecimal> openPrices(LocalDate session, Collection<String> tickers) {
        Objects.requireNonNull(session, "session");
        if (tickers == null || tickers.isEmpty() || !store.ready()) {
            return Map.of();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            if (!calendar.isTradingDay(session)) {
                return Map.of();
            }
            LocalDate previous = calendar.previousTradingDay(session);
            Quotes quotes = reader.quietly(() -> marketData.quotes(run)).orElse(null);
            if (quotes == null) {
                return Map.of();
            }
            Map<String, BigDecimal> out = new TreeMap<>();
            for (String ticker : new TreeSet<>(tickers)) {
                Bar bar = ticker == null ? null : quotes.bars().get(ticker);
                if (bar == null || bar.kr() == null) {
                    continue;
                }
                // 장부의 시가 주문과 같은 판정을 받는 가상 주문 — 기준일 P(그 세션 전 거래일), 생성 시각은 관측치보다 앞(조건 ①·⑤를 늘 지남).
                Order probe = new Order(0, null, null, ticker, PaperBooks.BUY, null, null, null, PaperBooks.NEXT_OPEN,
                        RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, previous, Instant.EPOCH, null, null);
                Bar chosen = run.fillBar(probe, bar, quotes.collectedAt(), calendar, run.settingsBody()).bar();
                if (chosen == null || !session.equals(chosen.date()) || chosen.kr() == null || chosen.kr().choice() == null) {
                    continue;
                }
                out.put(ticker, chosen.kr().choice().price());
            }
            return out;
        } catch (CalendarUnavailableException e) {
            return Map.of();
        }
    }

    /** {@link #openUnfillable}의 사유 — 그 세션에 거래가 없어(거래량 0·정지) 시가가 다시 오지 않음. */
    public static final String OPEN_HALTED = "halted";

    /**
     * 세션 {@code session}의 시가가 <b>다시 오지 않을</b> 종목 → 사유({@link #OPEN_HALTED}) — {@link #openPrices}와 짝(ISA 계좌 자동 기록, ADR 0029 명세 §3).
     * 이번에 새로 받은(이어받지 않은) 밤 관측치에서 (가) 그 세션 봉이 거래량 0(정지일)이고 그 수집이 그 세션 밤 결정 기한 뒤이거나 그 세션 뒤의 봉이 이미
     * 있거나, (나) 그 세션 봉이 없거나 관측 봉이 아닌데(거래량 0·모름) 그 세션 뒤의 관측 봉이 이미 있는 종목입니다 — 모의 장부의 체결 봉 고르기
     * ({@link KrFills#choose})는 그런 날을 건너뛰고 다음 관측 봉의 시가로 체결하므로 그 세션 시가는 어느 관측치에서도 나오지 않습니다. 짐작하지 않습니다 —
     * 관측치가 없거나 이어받은 항목이거나 기한 전 수집본의 거래량 0(다음 수집에서 바뀔 수 있음)·물량 모름이면 결과에 없습니다(기다림). 달력이 모르거나
     * 거래일이 아니면 빈 표.
     */
    public Map<String, String> openUnfillable(LocalDate session, Collection<String> tickers) {
        Objects.requireNonNull(session, "session");
        if (tickers == null || tickers.isEmpty() || !store.ready()) {
            return Map.of();
        }
        MarketRun run = run();
        try {
            if (!run.calendar().isTradingDay(session)) {
                return Map.of();
            }
            Quotes quotes = reader.quietly(() -> marketData.quotes(run)).orElse(null);
            if (quotes == null) {
                return Map.of();
            }
            Instant deadline = KrPaperMarket.decisionWindow(run, run.settingsBody(), session).deadline();
            boolean afterDeadline = quotes.collectedAt() != null && deadline != null && !quotes.collectedAt().isBefore(deadline);
            Map<String, String> out = new TreeMap<>();
            for (String ticker : new TreeSet<>(tickers)) {
                Bar bar = ticker == null ? null : quotes.bars().get(ticker);
                if (bar == null || bar.stale() || bar.kr() == null) {
                    continue;
                }
                KrQuotes.Day day = bar.kr().day(session).orElse(null);
                boolean laterBar = bar.kr().days().stream().anyMatch(d -> d.date().isAfter(session));
                boolean laterObserved = bar.kr().days().stream().anyMatch(d -> d.date().isAfter(session) && d.observed());
                boolean halted = day != null && day.volume() != null && day.volume() == 0 && (afterDeadline || laterBar);
                boolean skipped = (day == null || !day.observed()) && laterObserved;
                if (halted || skipped) {
                    out.put(ticker, OPEN_HALTED);
                }
            }
            return out;
        } catch (CalendarUnavailableException e) {
            return Map.of();
        }
    }

    /**
     * 세션 {@code session}의 분 단위 지정 시각 {@code at}(KST) 체결가 — 모의 장부가 그 세션·그 시각의 지정 시각 주문을 체결할 때와 같은 사다리
     * ({@link KrFills} → {@link KrTimedLadder} — 1분봉 창 첫 거래 봉 시가 → 창 뒤 첫 거래 봉 시가)로 밤 관측치와 시각 지정 1분봉 저장본
     * ({@code paper.kr.timed})에서 고른 값(ISA 계좌 일일 맞추기 지시의 자동 기록 — ADR 0033 결정 7). 종목마다 {@link LadderPrice}이고, 기다리는 종목은 결과에
     * 없습니다(짐작하지 않음). 달력이 모르거나 거래일이 아니면 빈 표.
     */
    public Map<String, LadderPrice> pricesAt(LocalDate session, LocalTime at, Collection<String> tickers) {
        Objects.requireNonNull(session, "session");
        Objects.requireNonNull(at, "at");
        if (tickers == null || tickers.isEmpty() || !store.ready()) {
            return Map.of();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            if (!calendar.isTradingDay(session)) {
                return Map.of();
            }
            LocalDate previous = calendar.previousTradingDay(session);
            Quotes quotes = timedQuotes(run);
            if (quotes == null) {
                return Map.of();
            }
            Map<String, LadderPrice> out = new TreeMap<>();
            for (String ticker : new TreeSet<>(tickers)) {
                // 장부의 지정 시각 주문과 같은 판정을 받는 가상 주문 — 기준일 P(그 세션 전 거래일), 생성 시각은 관측치보다 앞(조건 ①·⑤를 늘 지남).
                Order probe = new Order(0, null, null, ticker, PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE,
                        RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, previous, Instant.EPOCH, null, null, at);
                LadderPrice price = ladder(run, quotes, probe, session, calendar);
                if (price != null) {
                    out.put(ticker, price);
                }
            }
            return out;
        } catch (CalendarUnavailableException e) {
            return Map.of();
        }
    }

    /**
     * 그 책 주문 하나의 체결가 — 모의 장부가 그 주문(상태와 상관없이 주문 칸 그대로)을 체결할 사다리 값(ISA 계좌 스탑 지시의 자동 기록 — ADR 0033 결정 7,
     * {@link LadderPrice}). 그 책의 주문이 아니거나 시각 지정 시점이 아니거나 목표 세션·관측치를 모르거나 기다리는 중이면 empty.
     */
    public Optional<LadderPrice> orderLadderPrice(String code, long orderId) {
        if (krBook(code) == null) {
            return Optional.empty();
        }
        Order order = store.order(orderId).filter(o -> code.equals(o.bookCode())).orElse(null);
        if (order == null || !KrTimedLadder.timed(order.timing())) {
            return Optional.empty();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            LocalDate session = ExecutionAudit.targetSession(order, calendar);
            Quotes quotes = session == null ? null : timedQuotes(run);
            if (quotes == null) {
                return Optional.empty();
            }
            return Optional.ofNullable(ladder(run, quotes, order, session, calendar));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    /** 밤 관측치에 시각 지정 1분봉(그리고 금융위 시장 구분)을 붙인 것 — 장부 체결과 같은 입력({@link MarketRun#withListings}). 없으면 null. */
    private Quotes timedQuotes(MarketRun run) {
        return reader.quietly(() -> marketData.quotes(run).map(q -> run.withListings(q, marketData))).orElse(null);
    }

    /** 그 주문의 그 세션 사다리 값({@link LadderPrice}), 기다림이면 null. */
    private static LadderPrice ladder(MarketRun run, Quotes quotes, Order order, LocalDate session, TradingCalendar calendar) {
        Bar bar = order.ticker() == null ? null : quotes.bars().get(order.ticker());
        if (bar == null || bar.kr() == null) {
            return null;
        }
        KrQuotes.Timed timed = bar.kr().timedOn(session);
        if (timed != null && KrQuotes.TIMED_NO_BARS.equals(timed.status())) {
            return new LadderPrice(null, true, false);
        }
        Instant target = KrTimedLadder.targetOn(order, session, calendar);
        String key = target == null || PaperBooks.NEXT_CLOSE.equals(order.timing()) ? null
                : KrTimedLadder.label(target.atZone(KrxCalendar.SEOUL).toLocalTime());
        if (key != null && (timed == null || (KrQuotes.TIMED_OK.equals(timed.status()) && !timed.windows().containsKey(key)))) {
            return new LadderPrice(null, false, true);
        }
        PaperMarket.FillChoice choice = run.fillBar(order, bar, quotes.collectedAt(), calendar, run.settingsBody());
        if (choice.bar() != null) {
            Bar chosen = choice.bar();
            if (!session.equals(chosen.date()) || chosen.kr() == null || chosen.kr().choice() == null) {
                return new LadderPrice(null, true, false);   // 그 세션에 거래가 없어 장부가 다음 관측 봉으로 넘어감 — 그 세션 값은 오지 않음
            }
            return new LadderPrice(chosen.kr().choice().price(), false, false);
        }
        return choice.unfillable() ? new LadderPrice(null, true, false) : null;
    }

    /**
     * 마지막 가격 — 밤 관측치의 그 종목 종가(이어받은 항목이면 그 이어받은 값). 없는 종목은 결과에 없습니다(짐작하지 않음). 한국 감시 1분봉 저장본은
     * 장중 판단 입력 전용이라 여기서 읽지 않습니다(평가는 직전 종가 기준).
     */
    public Map<String, BigDecimal> lastPrices(Collection<String> tickers) {
        if (tickers == null || tickers.isEmpty() || !store.ready()) {
            return Map.of();
        }
        MarketRun run = run();
        Quotes quotes = reader.quietly(() -> marketData.quotes(run)).orElse(null);
        Map<String, BigDecimal> out = new TreeMap<>();
        for (String ticker : new TreeSet<>(tickers)) {
            if (ticker == null) {
                continue;
            }
            Bar bar = quotes == null ? null : quotes.bars().get(ticker);
            if (bar == null) {
                continue;
            }
            BigDecimal exact = bar.kr() == null ? null : bar.kr().last().close();
            if (exact != null && exact.signum() > 0) {
                out.put(ticker, exact);
            } else if (Double.isFinite(bar.close()) && bar.close() > 0) {
                out.put(ticker, BigDecimal.valueOf(bar.close()));
            }
        }
        return out;
    }

    /** 한국 종목 이름(화면 표시용 — {@link PaperMarketData#krNames}: 관측치의 토스 이름 → 금융위 유니버스 이름). 모르는 종목은 결과에 없습니다. */
    public Map<String, String> names(Collection<String> tickers) {
        if (tickers == null || tickers.isEmpty()) {
            return Map.of();
        }
        Map<String, String> all = reader.quietly(marketData::krNames);
        if (all == null || all.isEmpty()) {
            return Map.of();
        }
        Map<String, String> out = new TreeMap<>();
        for (String ticker : tickers) {
            if (ticker != null && all.containsKey(ticker)) {
                out.put(ticker, all.get(ticker));
            }
        }
        return out;
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
        return targets(code, session, null);
    }

    /**
     * 목표 계산의 본체 — 장부 상태·보유 + 그 세션 시가 주문({@link #openOrders}) + {@code cutoff}가 있으면 그 세션의 시각 지정 대기 주문 가운데 기준 시각이
     * {@code cutoff} 이하인 것(장부 체결 조건 ⑤를 지나는 것만 — 현금성 매수는 같은 시각 마지막)을 마지막 가격으로 체결했다고 본 장부. {@code cutoff}가
     * null이면 시가 주문만 봅니다({@link #openTargets} — 시가 맞추기).
     */
    private Optional<OpenTargets> targets(String code, LocalDate session, Instant cutoff) {
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
            if (cutoff != null) {
                due.addAll(timedOrders(pending, session, run, cutoff, targets));
            }
            Map<String, Position> held = new TreeMap<>();
            Map<String, Double> price = new HashMap<>();
            ledgerPositions(store.positions(code), held, price);
            ExpectedState.State expected = ExpectedState.simulate(state.cash(), held, price, new ArrayList<>(due), targets, session,
                    cutoff != null ? cutoff : calendar.openInstant(session), lastPrice(quotes));
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
            // 시각 지정 STOP(장중 감시·밤 대체)은 비중에는 반영하되 흡수하지 않음 — 실제 매매의 스탑 매도 경로가 따로 팖(통합 검토 R3). 시가 STOP은
            // 따로 팔 길(장중 따라 하기 목록)이 없으므로 예전처럼 흡수합니다.
            List<Long> stops = due.stream().filter(o -> !PaperBooks.NEXT_OPEN.equals(o.timing()) && PaperBooks.SOURCE_STOP.equals(o.source())
                    && PaperBooks.SELL.equals(o.side())).map(Order::id).sorted().toList();
            List<Long> absorbed = due.stream().map(Order::id).filter(id -> !stops.contains(id)).sorted().toList();
            return Optional.of(new OpenTargets(code, session, weights, expected.price(), expected.nav(), expected.cash(), absorbed,
                    expected.unpriced(), stops));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    /**
     * 시각 맞추기의 목표(ADR 0033 결정 1·3) — 장부 상태·보유 + 그 세션 시가 주문 + 그 세션의 시각 지정 대기 주문(매시·장중 시장가·분 단위 지정 시각·종가,
     * 출처를 거르지 않음) 가운데 기준 시각이 {@code at} 이하인 것을 마지막 가격으로 체결했다고 본 비중. 같은 시각은 장부와 같이 매도 먼저, 현금성 매수
     * 마지막입니다. 시각 지정 STOP 매도는 비중에 반영하지만 {@link OpenTargets#absorbedOrderIds}에 넣지 않고 {@link OpenTargets#stopOrderIds}에 둡니다
     * (실제 매매의 스탑 매도 경로가 따로 팖 — 묶음이 실패해도 손절이 나가게). {@code at}이 개장이고 시각 지정 주문이 없으면 {@link #openTargets}와 같은
     * 값입니다. 빈 값의 조건은 {@link #openTargets}와 같습니다.
     */
    public Optional<OpenTargets> targetsAt(String code, LocalDate session, Instant at) {
        Objects.requireNonNull(session, "session");
        Objects.requireNonNull(at, "at");
        return targets(code, session, at);
    }

    /**
     * 그 책의 그 세션 일일 맞추기 시각(ADR 0033 결정 1) — 있으면 실제 매매·ISA가 시가 단일가 대신 그 시각 시장가로 맞춥니다. 없으면(empty) 예전 시가
     * 맞추기입니다.
     * <ul>
     *   <li>한국 책이 아니거나 운용 중이 아니거나 거래일이 아니거나 달력이 모르면 empty.</li>
     *   <li>그 세션 시가에 장부가 체결할 결정 주문(출처 STOP이 아닌 시가 주문)이 하나라도 있으면 empty — 예전 판으로 낸 주문이 남은 날(전환일)은 예전
     *       시가 맞추기로 모의·실제·ISA가 같은 때에 맞춥니다.</li>
     *   <li>규칙 계좌: 그 세션의 대기 결정 주문 가운데 분 단위 지정 시각 주문이 있으면 그 가장 이른 기준 시각(실제 주문 먼저 — 통합 검토 R11). 없으면 지금
     *       설정({@code kr.rules.timing})이 {@code AT_MINUTE}일 때 그 결정이 냈을 시각({@link RuleTiming#choose} — 장 시간 변경일은 그날 첫 분),
     *       그 밖의 설정이면 empty.</li>
     *   <li>Claude 계좌: 자유 시점 판({@code kr.claude.freeTiming}·{@code kr.claude2.freeTiming})이 켜져 있으면 그 세션 첫 분(개장 +
     *       {@link SessionWindows#OPEN_OFFSET}), 꺼져 있으면 empty.</li>
     * </ul>
     */
    public Optional<Instant> dailySyncAt(String code, LocalDate session) {
        Objects.requireNonNull(session, "session");
        Book book = krBook(code);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return Optional.empty();
        }
        MarketRun run = run();
        try {
            TradingCalendar calendar = run.calendar();
            if (!calendar.isTradingDay(session)) {
                return Optional.empty();
            }
            Instant first = SessionWindows.first(calendar, session);
            Instant earliest = null;
            for (Order o : store.ordersByStatus(code, PaperBooks.ORDER_PENDING)) {
                if (!PaperBooks.ORDER_PENDING.equals(o.status()) || PaperBooks.SOURCE_STOP.equals(o.source())
                        || !session.equals(ExecutionAudit.targetSession(o, calendar))
                        || (o.expiresOn() != null && o.expiresOn().isBefore(session))) {
                    continue;
                }
                if (PaperBooks.NEXT_OPEN.equals(o.timing())) {
                    if (KrFills.opensAfterOrder(o, session, calendar)) {
                        return Optional.empty();   // 그 세션 시가에 체결될 결정 주문 — 예전 시가 맞추기(전환일)
                    }
                    continue;
                }
                if (PaperBooks.KR_RULES.equals(code) && PaperBooks.AT_MINUTE.equals(o.timing())) {
                    Instant target = KrTimedLadder.targetOn(o, session, calendar);
                    if (target != null && !target.isBefore(first) && (earliest == null || target.isBefore(earliest))) {
                        earliest = target;
                    }
                }
            }
            if (!PaperBooks.KR_RULES.equals(code)) {
                return FreeTimingSettings.from(run.settingsBody()).on(code) ? Optional.of(first) : Optional.empty();
            }
            if (earliest != null) {
                return Optional.of(earliest);
            }
            RuleTiming timing = RuleTiming.kr(run.settingsBody());
            if (!PaperBooks.AT_MINUTE.equals(timing.timing())) {
                return Optional.empty();
            }
            LocalDate asOf = calendar.previousTradingDay(session);
            RuleTiming.Chosen chosen = timing.choose(asOf, calendar.closeInstant(asOf), calendar, true);
            if (!PaperBooks.AT_MINUTE.equals(chosen.timing()) || chosen.at() == null) {
                return Optional.empty();
            }
            return Optional.of(FreeTiming.at(session, chosen.at(), calendar));
        } catch (CalendarUnavailableException e) {
            return Optional.empty();
        }
    }

    /**
     * 그 책의 대기 STOP 매도 가운데 목표 세션이 {@code session}인 것의 종목(ADR 0033 결정 4) — 실제 매매가 매수를 보내기 직전(묶음 재시도·마무리·장중
     * 따라 하기) 이 종목을 뺍니다(방금 판 종목을 재시도가 다시 사지 않게 — 통합 검토 R2). 출처 STOP의 모든 시점(시가·장중 시장가·지정 시각·종가)을
     * 봅니다. 한국 책이 아니거나 달력이 모르면 빈 집합.
     */
    public Set<String> pendingStopSymbols(String code, LocalDate session) {
        Objects.requireNonNull(session, "session");
        if (krBook(code) == null) {
            return Set.of();
        }
        try {
            TradingCalendar calendar = run().calendar();
            Set<String> out = new TreeSet<>();
            for (Order o : store.ordersByStatus(code, PaperBooks.ORDER_PENDING)) {
                if (PaperBooks.ORDER_PENDING.equals(o.status()) && PaperBooks.SOURCE_STOP.equals(o.source())
                        && PaperBooks.SELL.equals(o.side()) && o.ticker() != null
                        && session.equals(ExecutionAudit.targetSession(o, calendar))) {
                    out.add(o.ticker());
                }
            }
            return Set.copyOf(out);
        } catch (CalendarUnavailableException e) {
            return Set.of();
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

    /**
     * 목표 세션이 {@code session}인 시각 지정 대기 주문({@link KrTimedLadder#timed} — 매시·장중 시장가·분 단위 지정 시각·종가) 가운데 기준 시각
     * ({@link KrExpectedState#targetAt})이 {@code cutoff} 이하이고 장부 체결 조건 ⑤({@link KrFills#opensAfterOrder} — 기준 시각이 생성 뒤)를 지나는 것 —
     * 기준 시각을 {@code targets}에 넣습니다. 현금성 매수는 {@link #openOrders}와 같이 같은 시각의 다른 매수 뒤(+1나노초)입니다. 만료된 것은 뺍니다.
     */
    private static List<Order> timedOrders(List<Order> pending, LocalDate session, MarketRun run, Instant cutoff,
                                           Map<Long, Instant> targets) {
        TradingCalendar calendar = run.calendar();
        List<Order> out = new ArrayList<>();
        for (Order o : pending) {
            if (!PaperBooks.ORDER_PENDING.equals(o.status()) || !KrTimedLadder.timed(o.timing())
                    || !session.equals(ExecutionAudit.targetSession(o, calendar))
                    || (o.expiresOn() != null && o.expiresOn().isBefore(session))
                    || !KrFills.opensAfterOrder(o, session, calendar)) {
                continue;
            }
            Instant target = KrExpectedState.targetAt(o, session, calendar);
            if (target == null || target.isAfter(cutoff)) {
                continue;
            }
            out.add(o);
            boolean cashLikeBuy = PaperBooks.BUY.equals(o.side()) && run.settings().cashLike(o.ticker());
            targets.put(o.id(), cashLikeBuy ? target.plusNanos(1) : target);
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
