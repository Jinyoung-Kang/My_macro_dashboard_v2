package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.SplitDetector;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 🧪 관측치 하나를 그 시장 책들의 장부에 적용합니다(명세 L3~L9, 설계 §3-1) — 체결·트레일링 스탑·분할·평가·순자산.
 *
 * <p><b>시장마다 따로입니다</b>(2단계 명세 §9 A5). 관측치 처리·미확정 순자산 줄·'새 관측치가 있나'·오류 기억은 받은 시장
 * ({@link PaperMarket})의 책({@code paper_books.market})만 보고, 세션 날짜·확정 종가 판정·분할 기준 이력·체결 가격 출처·스탑 뒤
 * 재진입 금지 거래일도 그 시장 묶음에서 가져옵니다. 다른 시장 책은 읽지도 쓰지도 않습니다 — 그러지 않으면 미국 관측치가 한국 책의 멱등 키
 * ({@code lastProcessedCollectedAt})를 미국 수집 시각으로 밀어 한국 관측치가 '이미 처리함'으로 버려집니다. 시장을 받지 않는 옛
 * 시그니처는 미국 책만 처리합니다(결정 작업이 시장 문맥으로 옮겨 가는 A6 전까지 그대로 부름). 사후 체결({@link #backfill})은 미국
 * 책만 받습니다(한국은 출발일 사후 체결이 없음, 명세 K28). <b>설정과 달력은 실행 문맥에서</b>(C1a) — 슬리피지·트레일링 스탑·재진입 금지
 * 거래일·현금성 종목은 그 실행({@link MarketRun})이 읽은 설정 행으로, 세션·확정 판정은 그 실행의 달력 한 벌로 셉니다. 장부가 설정을
 * 따로 읽지 않습니다. 설정 키는 아직 설정 루트(미국)의 키입니다 — 시장별 접두어 읽기는 다음 커밋(C1a).
 *
 * <p><b>책마다 한 트랜잭션입니다</b>({@link PaperStore#atomically}). 한 책에서 오류가 나면 그 책만 되돌리고 다른 책은 계속합니다.
 * 그 책은 상태(멱등 키)가 바뀌지 않아 그대로 두면 정기 작업이 같은 저장본으로 5분마다 다시 돌며 같은 오류를 기록합니다(입력이
 * 같으면 대개 같은 예외 — 작업 기록 200건이 오류로 밀림). 그래서 실패한 (책, 수집 시각)을 메모리에 기억해 <b>같은 관측치로는
 * 다시 시도하지 않고</b>, 새 관측치(수집기가 1시간마다 저장)가 오면 다시 시도합니다. 수동 실행은 기억을 지우고 한 번 더
 * 시도합니다({@link #forgetFailures}). 기억은 재기동하면 사라집니다 — 그때 한 번 더 시도하는 것은 괜찮습니다.
 *
 * <p><b>멱등</b>: 저장본 수집 시각이 그 책의 {@code lastProcessedCollectedAt} 이하이면 건너뜁니다. 같은 저장본을 두 번 넣어도
 * 체결·스탑·순자산은 한 번입니다. 같은 JVM 안에서 정기 작업과 수동 실행이 겹치지 않게 {@link #exclusively}로 줄을 세웁니다
 * (둘이 같은 상태를 동시에 읽으면 스탑 매도가 두 번 들어갑니다). 백엔드는 한 프로세스라 JVM 안의 잠금으로 충분합니다.
 *
 * <p><b>처리 순서</b>(책 하나, 설계 §3-1):
 * <ol>
 *   <li>만료(기준 거래일 + 3거래일이 지난 대기 주문)·지난 재진입 금지 정리 — 체결보다 먼저(만료된 주문이 오늘 봉으로 체결되지 않게)</li>
 *   <li>분할 감지·가격 갱신 — <b>체결·스탑보다 먼저</b>. 그러지 않으면 2:1 분할 뒤 반값이 된 관측가가 분할 전 최고가와 비교돼
 *       가짜 스탑이 나고, 매도 수량도 분할 전 수량으로 계산됩니다.</li>
 *   <li>대기 매도 체결</li>
 *   <li>최고가 갱신 → 트레일링 스탑 — 그 관측치로 즉시 전량 매도 + 재진입 금지</li>
 *   <li>대기 매수 체결 — <b>스탑 뒤</b>. 이번 관측치에서 스탑에 걸린 종목의 대기 매수는 방금 건 재진입 금지로 취소됩니다
 *       (매수가 먼저면 사자마자 같은 관측치의 스탑으로 다시 팔려 슬리피지만 두 번 냅니다). 매도·스탑으로 생긴 현금은 쓸 수 있습니다.</li>
 *   <li>평가 → 그 세션의 마감 뒤 관측치면 그 거래일 순자산 → 상태(멱등 키) 저장</li>
 * </ol>
 * 일시정지(PAUSED) 책은 2·4의 최고가 갱신·6만(가격·분할·최고가는 따라가되 사고팔지 않음), 시작 전(NOT_STARTED) 책은 6의 상태만
 * (현금뿐이라 순자산 기록은 남기지 않음 — 시작하지 않은 책의 곡선이 평평하게 그려지지 않게).
 *
 * <p><b>순자산 줄</b>: 관측 시각의 세션(시장 달력의 {@code currentOrLastSession})이 다수 티커의 봉 날짜와 같고 그 봉이 확정
 * 종가일 때만 그 거래일 줄을 씁니다 — 다음 날 개장 직후에는 새 봉의 과반이 아직 전날 날짜라, 이 조건이 없으면 장중가와 그날
 * 체결이 섞인 평가가 전날 확정 줄을 덮습니다(주말·휴장일·개장 전 재저장은 세션이 그대로라 다시 씀). 확정 표시
 * ({@code prices_final})는 <b>책마다</b> 정합니다: 수량이 있는 보유가 모두 그 세션의 확정 봉(이어 쓴 봉 아님, 분할 확인됨)으로
 * 평가됐을 때만 true, 하나라도 마지막으로 본 값(장중 값일 수 있음)으로 평가했으면 false — 확정 줄은 미확정 값으로 덮이지
 * 않으므로({@link PaperStore#upsertNav}) 나중에 온전한 확정 관측치가 그 줄을 바로잡습니다.
 *
 * <p><b>체결 조건</b>(룩어헤드 방지, 설계 §3-1): ① 관측치 수집 시각 &gt; 주문 생성 시각, ② 봉 날짜 &gt; 주문의 기준 거래일 — 주말·휴장일에
 * 수집기가 직전 종가를 매시간 다시 저장하므로 ①만으로는 결정이 이미 본 종가로 체결됩니다, ③ {@code NEXT_CLOSE}면 확정 종가
 * (미국: 마감 + 15분 뒤 수집 — 시장 묶음의 {@code isFinal}), ④ 이어 쓴({@code isStale}) 봉은 다음 관측치를 기다립니다.
 *
 * <p><b>분할 감지 기준(fill_ref_date·fill_ref_close)</b>: 늘 <b>확정 종가</b> 하나를 기준으로 둡니다. 장중에 체결하면 그 봉(지연 시세)이
 * 아니라 직전 거래일 종가를 기준으로 삼습니다 — 장중 체결가와 그날 종가가 10% 넘게 벌어지면 '8:7 분할' 같은 가짜 분할로 읽히기
 * 때문입니다. 확정 종가 관측치가 오면 기준을 그날로 옮기고(분할이 없음을 확인한 뒤), 배당 조정으로 기준일 값이 조금 바뀌면 그 값을
 * 따라갑니다 — 차이가 몇 년 쌓여 3%를 넘으면 엉뚱한 비율로 감지되기 때문입니다. 그래서 기준일은 대개 며칠 안이고, 기준일 종가는
 * 먼저 같은 저장본의 3개월 일봉에서, 없으면 10년 이력에서 찾습니다(관측치와 같은 저장본을 먼저 봐야, 분할이 시세에는 반영됐는데
 * 12시간 주기의 이력에는 아직 안 된 틈에 가짜 스탑이 나지 않음). 둘 다 없으면 분할 여부를 모르니 그 보유는 '가격 없음'으로 두고
 * 가격·최고가를 바꾸지 않습니다(스탑도 보지 않음).
 *
 * <p>가격을 모르는 보유(봉이 없거나 이어 쓴 봉)는 마지막으로 본 가격으로, 그것도 없으면 평단으로 평가하고 '가격 없음'
 * ({@code priceStale})으로 표시합니다. 0으로 평가하지 않습니다.
 */
@Service
public class PaperLedgerService {

    private static final Logger log = LoggerFactory.getLogger(PaperLedgerService.class);

    /** split_note에 남기는 최대 길이 — 분할이 여러 번 쌓여도 행이 끝없이 길어지지 않게(앞의 기록부터 남김). */
    static final int SPLIT_NOTE_MAX = 500;

    /**
     * 처리 한 번의 결과.
     *
     * @param booksProcessed 이번 관측치를 적용한 책(멱등으로 건너뛴 책은 빠짐)
     * @param skippedReason  아무 책도 처리하지 않았을 때 그 이유(처리했으면 null)
     * @param notes          체결하지 못하고 취소한 주문·현금 부족으로 줄인 매수·분할처럼 사람이 알아야 할 일("책: 내용")
     * @param errors         오류로 되돌린 책("책: 오류") — 그 책은 같은 관측치로는 다시 시도하지 않고 새 관측치에서 다시 시도합니다
     */
    public record Outcome(int filled, int stopped, int expired, int splits, List<String> booksProcessed,
                          String skippedReason, List<String> notes, List<String> errors) {

        public Outcome {
            booksProcessed = List.copyOf(booksProcessed);
            notes = List.copyOf(notes);
            errors = List.copyOf(errors);
        }

        static Outcome skipped(String reason) {
            return new Outcome(0, 0, 0, 0, List.of(), reason, List.of(), List.of());
        }

        static Outcome failed(String error) {
            return new Outcome(0, 0, 0, 0, List.of(), null, List.of(), List.of(error));
        }
    }

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final ObjectMapper mapper;
    /** 장부를 바꾸는 일(관측치 처리·초기화·리셋·일시정지)을 한 줄로 세웁니다(클래스 설명). 시장이 여럿이어도 잠금은 하나입니다. */
    private final ReentrantLock lock = new ReentrantLock();
    /**
     * (시장, 책) → 처리하다 오류가 난 관측치의 수집 시각. 같은 관측치로 다시 시도하지 않으려고 기억합니다(클래스 설명). 시장마다
     * 관측치 저장본이 다르므로 기억도 시장마다 따로 봅니다 — 한 시장의 실패가 다른 시장 관측치를 막거나 지워지지 않게.
     */
    private final Map<FailureKey, Instant> failedObservations = new ConcurrentHashMap<>();

    private record FailureKey(String market, String book) {
    }

    /** 설정은 실행이 읽은 행으로 받습니다({@link MarketRun#settings}) — 장부가 따로 읽지 않습니다. */
    public PaperLedgerService(PaperStore store, PaperMarketData marketData, ObjectMapper mapper) {
        this.store = store;
        this.marketData = marketData;
        this.mapper = mapper;
    }

    /** 장부를 바꾸는 다른 일(관리 서비스)도 이 잠금 안에서 합니다. */
    <T> T exclusively(Supplier<T> work) {
        lock.lock();
        try {
            return work.get();
        } finally {
            lock.unlock();
        }
    }

    /** 미국 책에 아직 적용하지 않은 관측치인가 — {@link #hasNewObservation(PaperMarket, Quotes)}의 미국 판. */
    public boolean hasNewObservation(Quotes quotes) {
        return hasNewObservation(UsPaperMarket.INSTANCE, quotes);
    }

    /**
     * 이 관측치를 아직 적용하지 않은 그 시장 책이 하나라도 있나(정기 작업이 '할 일 없음'을 기록하지 않으려고 먼저 봄). 이 관측치에서
     * 이미 오류가 난 책은 세지 않습니다 — 같은 관측치로 다시 시도하지 않습니다(클래스 설명). 다른 시장 책은 보지 않습니다.
     */
    boolean hasNewObservation(PaperMarket market, Quotes quotes) {
        if (!store.ready()) {
            return false;
        }
        for (Book book : store.books(market.code())) {
            Optional<BookState> state = store.state(book.code());
            if (state.isPresent() && isNew(quotes, state.get()) && !failedOn(market, book.code(), quotes)) {
                return true;
            }
        }
        return false;
    }

    /** 이 관측치에서 오류가 나 다시 시도하지 않고 있는 미국 책 — {@link #failedBooks(PaperMarket, Quotes)}의 미국 판. */
    public List<String> failedBooks(Quotes quotes) {
        return failedBooks(UsPaperMarket.INSTANCE, quotes);
    }

    /** 이 관측치에서 오류가 나 다시 시도하지 않고 있는 그 시장 책, 정의 순. */
    List<String> failedBooks(PaperMarket market, Quotes quotes) {
        return failedObservations.keySet().stream().filter(key -> key.market().equals(market.code()))
                .map(FailureKey::book).filter(code -> failedOn(market, code, quotes)).sorted(market.bookOrder())
                .toList();
    }

    /** 모든 시장의 오류 난 관측치 기억을 지웁니다 — 초기화·리셋 뒤 같은 관측치로 다시 처리해도 되게. */
    public void forgetFailures() {
        failedObservations.clear();
    }

    /** 그 시장의 오류 난 관측치 기억만 지웁니다 — 수동 실행이 같은 관측치로 한 번 더 시도하게(다른 시장의 기억은 그대로). */
    void forgetFailures(PaperMarket market) {
        failedObservations.keySet().removeIf(key -> key.market().equals(market.code()));
    }

    private boolean failedOn(PaperMarket market, String code, Quotes quotes) {
        return quotes.collectedAt().equals(failedObservations.get(new FailureKey(market.code(), code)));
    }

    private static boolean isNew(Quotes quotes, BookState state) {
        Instant last = state.lastProcessedCollectedAt();
        return last == null || quotes.collectedAt().isAfter(last);
    }

    /** 미국 관측치 하나를 미국 책에 적용합니다 — {@link #process(PaperMarket, Quotes)}의 미국 판. */
    public Outcome process(Quotes quotes) {
        return process(UsPaperMarket.INSTANCE, quotes);
    }

    /**
     * 그 시장의 관측치 하나를 그 시장 책 모두에 적용합니다(클래스 설명). 다른 시장 책은 건드리지 않습니다. 실행({@link MarketRun})을 받으면
     * 그 실행의 달력·설정 행으로, 시장 묶음을 받으면(미국 판·시험) 고정 달력과 지금 설정 행으로 실행을 그 자리에서 엽니다
     * ({@link MarketRun#of}).
     */
    Outcome process(PaperMarket market, Quotes quotes) {
        MarketRun run = MarketRun.of(market, store);
        return exclusively(() -> processLocked(run, quotes));
    }

    private Outcome processLocked(MarketRun market, Quotes quotes) {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다(V8·V9 적용 전)");
        }
        List<Book> books = new ArrayList<>(store.books(market.code()));
        if (books.isEmpty()) {
            return Outcome.skipped("초기화 전입니다 — 계좌가 없습니다");
        }
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        // 그 실행이 읽은 설정 행(클래스 설명의 설정).
        PaperSettings current = market.settings();
        if (market.settingsRow().isPresent() && !current.fallbacks().isEmpty()) {
            log.warn("모의 매매 설정 v{}의 키 {}가 없거나 범위 밖이라 기본값으로 읽습니다", market.settingsVersion(),
                    current.fallbacks());
        }

        int filled = 0;
        int stopped = 0;
        int expired = 0;
        int splits = 0;
        List<String> processed = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        List<String> heldBack = new ArrayList<>();
        for (Book book : books) {
            FailureKey key = new FailureKey(market.code(), book.code());
            if (failedOn(market, book.code(), quotes)) {
                heldBack.add(book.code());   // 이 관측치에서 이미 오류가 남 — 새 관측치까지 기다림(클래스 설명)
                continue;
            }
            try {
                BookRun run = store.atomically(() -> processBook(market, book, quotes, current));
                failedObservations.remove(key);
                if (run == null) {
                    continue;
                }
                processed.add(book.code());
                filled += run.filled;
                stopped += run.stopped;
                expired += run.expired;
                splits += run.splits;
                run.notes.forEach(note -> notes.add(book.code() + ": " + note));
            } catch (RuntimeException e) {
                // 같은 관측치로는 다시 시도하지 않으니 이 경고는 관측치마다 한 번입니다.
                failedObservations.put(key, quotes.collectedAt());
                log.warn("모의 매매 장부 처리 실패({}, 관측치 {}) — 이 책만 되돌렸고, 같은 관측치로는 다시 시도하지 않고 "
                        + "새 관측치에서 다시 시도합니다: {}", book.code(), Kst.stamp(quotes.collectedAt()), e.toString());
                errors.add(book.code() + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }
        String skipped = null;
        if (processed.isEmpty() && errors.isEmpty()) {
            skipped = heldBack.isEmpty()
                    ? "이미 처리한 관측치입니다(수집 " + Kst.stamp(quotes.collectedAt()) + ")"
                    : heldBackReason(quotes, heldBack);
        }
        return new Outcome(filled, stopped, expired, splits, processed, skipped, notes, errors);
    }

    /** 오류가 난 책만 남은 관측치의 사유 문구(정기 작업도 같은 문구를 씀). */
    static String heldBackReason(Quotes quotes, List<String> books) {
        return "수집 " + Kst.stamp(quotes.collectedAt()) + " 관측치에서 오류가 난 계좌(" + String.join(", ", books)
                + ")는 같은 관측치로 다시 시도하지 않습니다 — 새 관측치에서 다시 시도합니다(수동 실행은 한 번 더 시도)";
    }

    /** 책 하나(트랜잭션 안). 이미 처리한 관측치면 null. */
    private BookRun processBook(PaperMarket market, Book book, Quotes quotes, PaperSettings current) {
        Optional<BookState> stateRow = store.state(book.code());
        if (stateRow.isEmpty()) {
            throw new IllegalStateException("계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요");
        }
        BookState state = stateRow.get();
        if (!isNew(quotes, state)) {
            return null;
        }
        BookRun run = new BookRun(market, book, quotes, current, state.cash());

        // 1. 만료·재진입 금지 정리
        run.expired = store.expireOrders(book.code(), run.session);
        store.deleteLockoutsBefore(book.code(), run.session);
        for (Lockout lockout : store.lockouts(book.code())) {
            run.lockouts.put(lockout.ticker(), lockout.untilTradingDate());
        }
        for (Position position : store.positions(book.code())) {
            run.holdings.put(position.ticker(), new Holding(position));
        }

        boolean active = PaperBooks.ACTIVE.equals(book.status());
        boolean started = active || PaperBooks.PAUSED.equals(book.status());
        List<Order> pending = active ? store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING) : List.of();
        if (started) {
            refreshHoldings(run);                                   // 2. 분할·가격
        }
        fill(run, pending, PaperBooks.SELL);                        // 3. 매도
        if (started) {
            raiseWatermarks(run);                                   // 4. 최고가 → 스탑
        }
        if (active && !PaperBooks.KIND_BENCHMARK.equals(book.kind())) {
            checkStops(run);
        }
        fill(run, pending, PaperBooks.BUY);                         // 5. 매수(방금 건 재진입 금지를 봄)
        settle(run, state, started);                                // 6. 평가·순자산·상태
        return run;
    }

    // ------------------------------------------------------------------ 2. 분할·가격
    private void refreshHoldings(BookRun run) {
        // 기준일 종가를 같은 저장본(3개월)에서 못 찾은 보유만 10년 이력에서 한 번에 찾습니다.
        Map<String, LocalDate> needHistory = new TreeMap<>();
        for (Holding holding : run.holdings.values()) {
            Bar bar = run.bar(holding.ticker);
            if (bar != null && !bar.stale() && bar.recent().valueOn(holding.fillRefDate) == null) {
                needHistory.put(holding.ticker, holding.fillRefDate);
            }
        }
        Map<String, DailySeries> history = Map.of();
        if (!needHistory.isEmpty()) {
            LocalDate from = Collections.min(needHistory.values());
            LocalDate to = Collections.max(needHistory.values());
            history = marketData.history(run.market, needHistory.keySet(), from, to);
        }
        for (Holding holding : new ArrayList<>(run.holdings.values())) {
            refresh(run, holding, history.get(holding.ticker));
        }
    }

    private void refresh(BookRun run, Holding holding, DailySeries history) {
        holding.verified = false;
        Bar bar = run.bar(holding.ticker);
        if (bar == null || bar.stale()) {
            holding.priceStale = true;   // 이번 관측치에 새 값이 없음 — 마지막 가격으로 평가, 스탑은 보지 않음
            return;
        }
        Double refNow = bar.recent().valueOn(holding.fillRefDate);
        if (refNow == null && history != null) {
            refNow = history.valueOn(holding.fillRefDate);
        }
        if (refNow == null) {
            holding.priceStale = true;
            run.note(holding.ticker + " 분할 확인 기준일(" + holding.fillRefDate
                    + ") 종가가 시세·이력에 없어 가격을 갱신하지 않았습니다");
            return;
        }
        Optional<SplitDetector.Ratio> split = SplitDetector.detect(holding.fillRefClose, refNow);
        if (split.isPresent()) {
            applySplit(run, holding, split.get(), refNow, bar.date());
            if (holding.qty == 0) {
                return;
            }
        } else {
            holding.fillRefClose = refNow;   // 배당 조정으로 조금 바뀐 기준값을 따라감(클래스 설명)
        }
        holding.lastPrice = bar.close();
        holding.lastPriceAt = run.at;
        holding.priceStale = false;
        if (run.market.isFinal(bar.date(), run.at) && bar.date().isAfter(holding.fillRefDate)) {
            holding.fillRefDate = bar.date();
            holding.fillRefClose = bar.close();
        }
        holding.verified = true;
    }

    private void applySplit(BookRun run, Holding holding, SplitDetector.Ratio ratio, double refNow, LocalDate seenOn) {
        int before = holding.qty;
        double avgBefore = holding.avgCost;
        holding.qty = SplitDetector.adjustQty(holding.qty, ratio);
        holding.avgCost = SplitDetector.adjustPrice(holding.avgCost, ratio);
        holding.highWatermark = SplitDetector.adjustPrice(holding.highWatermark, ratio);
        if (holding.lastPrice != null) {
            holding.lastPrice = SplitDetector.adjustPrice(holding.lastPrice, ratio);
        }
        holding.fillRefClose = refNow;
        String note = "%s %s 분할 감지 — %d주 → %d주, 평단 %.2f → %.2f".formatted(
                seenOn, ratio.label(), before, holding.qty, avgBefore, holding.avgCost);
        holding.splitNote = appendNote(holding.splitNote, note);
        run.splits++;
        run.note(holding.ticker + " " + note);
        if (holding.qty == 0) {
            // 병합으로 1주 미만이 됨 — 단주 현금 정산은 생략합니다(SplitDetector.adjustQty). 0주 보유는 둘 수 없어 지웁니다.
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
            run.note(holding.ticker + " 분할 뒤 0주가 되어 보유를 지웠습니다(단주 현금 정산 생략)");
        }
    }

    // ------------------------------------------------------------------ 3·5. 체결
    /**
     * 대기 주문 중 그쪽(매도·매수)만, 만든 순서대로. 매도는 스탑 앞, 매수는 스탑 뒤(클래스 설명의 처리 순서).
     *
     * <p>매수는 현금성(설정 {@code cashLikeTickers}, 기본 SHY)이 아닌 것을 먼저, 현금성 매수를 마지막에 체결합니다. 규칙 책은
     * 종목 매수와 함께 "남는 현금은 SHY에" 주문을 내는데, 그 주문은 남는 현금을 어림한 값이라 체결 시점 가격이 조금만 달라도
     * 종목 매수와 현금을 다툽니다 — SHY가 먼저 체결되면 신호 종목이 현금 부족으로 줄어듭니다(설계 §4-2: SHY는 남는 현금).
     */
    private void fill(BookRun run, List<Order> pending, String side) {
        if (PaperBooks.SELL.equals(side)) {
            for (Order order : pending) {
                if (PaperBooks.SELL.equals(order.side())) {
                    fillSell(run, order);
                }
            }
            return;
        }
        for (boolean cashLikePass : new boolean[]{false, true}) {
            for (Order order : pending) {
                if (PaperBooks.BUY.equals(order.side()) && run.settings.cashLike(order.ticker()) == cashLikePass) {
                    fillBuy(run, order);
                }
            }
        }
    }

    /** 이 주문을 이 관측치로 체결할 수 있으면 그 봉, 아니면 null(클래스 설명의 체결 조건 — 확정 종가 판정은 그 시장 묶음). */
    static Bar fillableBar(PaperMarket market, Order order, Quotes quotes) {
        if (order.createdAt() == null || !quotes.collectedAt().isAfter(order.createdAt())) {
            return null;                                   // ① 주문 뒤에 수집한 관측치만
        }
        Bar bar = quotes.bars().get(order.ticker());
        if (bar == null || bar.stale()) {
            return null;                                   // ④ 새 값이 없음 — 다음 관측치
        }
        if (order.asOfTradingDate() == null || !bar.date().isAfter(order.asOfTradingDate())) {
            return null;                                   // ② 결정이 이미 본 봉(주말 재저장)
        }
        if (PaperBooks.NEXT_CLOSE.equals(order.timing()) && !market.isFinal(bar.date(), quotes.collectedAt())) {
            return null;                                   // ③ 확정 종가 전
        }
        return bar;
    }

    private void fillSell(BookRun run, Order order) {
        Bar bar = fillableBar(run.market, order, run.quotes);
        if (bar == null) {
            return;
        }
        Holding holding = run.holdings.get(order.ticker());
        if (holding == null) {
            cancel(run, order, "체결 시점에 보유가 없습니다");
            return;
        }
        if (!holding.verified) {
            return;   // 분할 여부를 확인하지 못한 보유 — 수량을 믿을 수 없어 다음 관측치를 기다립니다
        }
        int qty;
        if (order.qty() != null) {
            if (order.qty() <= 0) {
                cancel(run, order, "매도 수량이 0 이하입니다");
                return;
            }
            qty = Math.min(order.qty(), holding.qty);
        } else {
            Double fraction = order.sellFraction();
            if (fraction != null && (!(fraction > 0) || fraction.isInfinite())) {
                cancel(run, order, "매도 비율이 0 이하입니다");
                return;
            }
            qty = PaperLedger.sellQty(holding.qty, fraction);
        }
        double price = price6(PaperLedger.fillPrice(bar.close(), PaperLedger.Side.SELL, run.settings.slippageBp()));
        double gross = gross(qty, price);
        recordFill(run, order.id(), order.ticker(), PaperBooks.SELL, qty, price, bar, gross);
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash + gross);
        holding.qty -= qty;
        if (holding.qty == 0) {
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
        }
        run.filled++;
    }

    private void fillBuy(BookRun run, Order order) {
        Bar bar = fillableBar(run.market, order, run.quotes);
        if (bar == null) {
            return;
        }
        Holding holding = run.holdings.get(order.ticker());
        if (holding != null && !holding.verified) {
            return;   // 분할 여부를 확인하지 못한 보유에 더 사지 않습니다(평단이 섞임) — 다음 관측치
        }
        // 이번 관측치의 스탑이 건 재진입 금지도 여기서 걸립니다(매수가 스탑 뒤라서 — 클래스 설명).
        LocalDate until = run.lockouts.get(order.ticker());
        if (TrailingStop.lockedOut(until, bar.date())) {
            cancel(run, order, "재진입 금지 중입니다(" + until + "까지, 트레일링 스탑)");
            return;
        }
        double price = price6(PaperLedger.fillPrice(bar.close(), PaperLedger.Side.BUY, run.settings.slippageBp()));
        int wanted;
        if (order.qty() != null) {
            wanted = order.qty();
        } else if (order.targetWeightPct() != null && Double.isFinite(order.targetWeightPct())) {
            // 목표 금액 = 목표 비중 × 체결 시점 순자산(같은 관측치의 매도·앞선 매수를 반영한 값).
            wanted = PaperLedger.buyQty(order.targetWeightPct() / 100.0 * run.nav(), price);
        } else {
            cancel(run, order, "매수 크기(수량·목표 비중)가 없습니다");
            return;
        }
        if (wanted <= 0) {
            cancel(run, order, "목표 금액으로 1주도 살 수 없습니다");
            return;
        }
        int affordable = PaperLedger.buyQty(run.cash, price);
        int qty = Math.min(wanted, affordable);
        if (qty <= 0) {
            cancel(run, order, "현금이 모자라 1주도 살 수 없습니다(현금 " + money(run.cash) + ")");
            return;
        }
        double gross = gross(qty, price);
        recordFill(run, order.id(), order.ticker(), PaperBooks.BUY, qty, price, bar, gross);
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash - gross);
        if (holding == null) {
            Reference reference = referenceFor(run.market, bar, run.at);
            holding = new Holding(order.ticker(), qty, price, bar.date(), run.at, price, run.at, bar.close(), run.at,
                    reference.date(), reference.close());
            holding.verified = true;
            run.holdings.put(holding.ticker, holding);
        } else {
            holding.avgCost = PaperLedger.averageCost(holding.qty, holding.avgCost, qty, price);
            holding.qty += qty;
            holding.lastPrice = bar.close();
            holding.lastPriceAt = run.at;
            raiseWatermark(holding, price, run.at);
        }
        if (qty < wanted) {
            // 현금이 모자라 요청보다 적게 산 사실을 그 주문의 근거에 남깁니다(설계 §3-1) — 실행 기록(notes)은 200건만 남지만
            // 주문은 장부와 함께 남으므로, 나중에 '왜 목표 비중보다 적게 샀나'를 주문 표에서 바로 봅니다.
            ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy()
                    : mapper.createObjectNode();
            reason.put("cashLimited", true);
            reason.put("requestedQty", wanted);
            reason.put("filledQty", qty);
            store.updateOrderReason(order.id(), reason);
            run.note("주문 " + order.id() + " " + order.ticker() + " 현금 부족으로 " + wanted + "주 중 " + qty
                    + "주만 매수(cashLimited)");
        }
        run.filled++;
    }

    /** 새 보유의 분할 감지 기준 — 확정 종가 하나(클래스 설명). 장중 체결이면 직전 거래일 종가, 그것도 없으면 그 봉. */
    static Reference referenceFor(PaperMarket market, Bar bar, Instant collectedAt) {
        if (market.isFinal(bar.date(), collectedAt)) {
            return new Reference(bar.date(), bar.close());
        }
        LocalDate previous = bar.recent().floorDate(bar.date().minusDays(1));
        if (previous != null) {
            return new Reference(previous, bar.recent().valueOn(previous));
        }
        return new Reference(bar.date(), bar.close());
    }

    record Reference(LocalDate date, double close) {
    }

    private void cancel(BookRun run, Order order, String reason) {
        store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, reason);
        run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 취소 — " + reason);
    }

    // ------------------------------------------------------------------ 4. 최고가·트레일링 스탑
    /** 이번 가격을 믿을 수 있는 보유(분할 확인됨)의 최고가를 관측가로 올립니다. 일시정지 책도 따라갑니다. */
    private void raiseWatermarks(BookRun run) {
        for (Holding holding : run.holdings.values()) {
            if (holding.verified) {
                raiseWatermark(holding, run.bar(holding.ticker).close(), run.at);
            }
        }
    }

    private void checkStops(BookRun run) {
        double stopPct = run.settings.trailingStopPct();
        for (Holding holding : new ArrayList<>(run.holdings.values())) {
            if (!holding.verified || run.settings.cashLike(holding.ticker)) {
                continue;   // 이번 가격을 믿을 수 없거나(가격 없음) 현금성(SHY) — 스탑을 보지 않음
            }
            Bar bar = run.bar(holding.ticker);
            if (!TrailingStop.triggered(holding.highWatermark, bar.close(), stopPct)) {
                continue;
            }
            double stopPrice = TrailingStop.stopPrice(holding.highWatermark, stopPct);
            int qty = holding.qty;
            double price = price6(PaperLedger.fillPrice(bar.close(), PaperLedger.Side.SELL, run.settings.slippageBp()));
            double gross = gross(qty, price);
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("trigger", "TRAILING_STOP");
            reason.put("stopPct", stopPct);
            reason.put("highWatermark", PaperLedger.round4(holding.highWatermark));
            reason.put("stopPrice", PaperLedger.round4(stopPrice));
            reason.put("observedPrice", bar.close());
            reason.put("barDate", bar.date().toString());
            // 스탑은 관측치가 만든 주문이라 생성·체결 시각 모두 그 관측치의 수집 시각입니다(IMMEDIATE).
            long orderId = store.insertOrder(new Order(0, run.book.code(), null, holding.ticker, PaperBooks.SELL, qty,
                    null, null, PaperBooks.IMMEDIATE, PaperBooks.SOURCE_STOP, PaperBooks.ORDER_FILLED, null,
                    mapper.valueToTree(reason), bar.date(), run.at, null, run.at));
            recordFill(run, orderId, holding.ticker, PaperBooks.SELL, qty, price, bar, gross);
            run.cash = PaperLedger.round4(run.cash + gross);
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);

            LocalDate until = TrailingStop.lockoutUntil(run.market.calendar(), bar.date(),
                    run.settings.lockoutTradingDays());
            store.upsertLockout(new Lockout(run.book.code(), holding.ticker, until,
                    "트레일링 스탑 −%s%%: 최고가 %s → 관측가 %s (%s)".formatted(trim(stopPct),
                            money(holding.highWatermark), money(bar.close()), bar.date())));
            run.lockouts.put(holding.ticker, until);
            run.stopped++;
        }
    }

    // ------------------------------------------------------------------ 5. 평가·저장
    private void settle(BookRun run, BookState state, boolean started) {
        String code = run.book.code();
        PaperLedger.Valuation valuation = run.valuation();
        for (String ticker : run.removed) {
            if (!run.holdings.containsKey(ticker)) {
                store.deletePosition(code, ticker);
            }
        }
        for (Holding holding : run.holdings.values()) {
            store.upsertPosition(holding.toPosition(code));
        }
        LocalDate navDate = state.lastNavTradingDate();
        LocalDate barDate = run.quotes.modalBarDate();
        // 그 세션의 마감 뒤 관측치일 때만 그 거래일(다수 티커의 봉 날짜) 순자산을 남깁니다(L9, 클래스 설명의 '순자산 줄').
        // 관측 시각의 세션이 봉 날짜와 달라졌으면(다음 날 개장 뒤) 지난 줄을 다시 쓰지 않습니다. 출발일 전 날짜도 남기지 않습니다.
        boolean sessionClose = barDate != null && barDate.equals(run.session)
                && run.market.isFinal(barDate, run.at)
                && (run.book.startedOn() == null || !barDate.isBefore(run.book.startedOn()));
        if (started && sessionClose) {
            store.upsertNav(new NavRow(code, barDate, PaperLedger.round4(valuation.nav()), PaperLedger.round4(run.cash),
                    PaperLedger.round4(valuation.equityValue()), PaperLedger.round4(valuation.exposurePct()),
                    allFinal(run, barDate)));
            navDate = navDate == null || barDate.isAfter(navDate) ? barDate : navDate;
        }
        store.upsertState(new BookState(code, PaperLedger.round4(run.cash), PaperLedger.round4(valuation.nav()),
                PaperLedger.round4(valuation.equityValue()), PaperLedger.round4(valuation.exposurePct()), run.at, run.at,
                navDate, null));
    }

    /**
     * 이 책의 보유가 모두 그 세션의 확정 봉으로 평가됐나 — 이번 관측치의 새 봉(이어 쓴 봉 아님)이고 분할을 확인했고 봉 날짜가
     * 그 세션. 하나라도 마지막으로 본 값으로 평가했으면 false(클래스 설명). 보유가 없으면(현금뿐) true.
     */
    private static boolean allFinal(BookRun run, LocalDate session) {
        for (Holding holding : run.holdings.values()) {
            Bar bar = run.bar(holding.ticker);
            if (!holding.verified || bar == null || bar.stale() || !session.equals(bar.date())
                    || !run.market.isFinal(bar.date(), run.at)) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------ 결정 작업이 채우는 순자산 줄
    /** 미국 책의 미확정 순자산 줄 — {@link #settleNav(PaperMarket, LocalDate, boolean)}의 미국 판(결정 작업이 부름). */
    public List<String> settleNav(LocalDate tradingDate, boolean pricesFinal) {
        return settleNav(UsPaperMarket.INSTANCE, tradingDate, pricesFinal);
    }

    /**
     * 결정 작업이 확정 종가를 끝내 받지 못한 채 마감 기한(설정 {@code decisionDeadlineKst}, 기본 12:00 KST)을 넘겨 진행할 때,
     * 그 거래일 순자산 줄이 없는 책에 지금 상태(마지막 관측치의 평가)를 <b>미확정</b>({@code prices_final = false}) 줄로 남깁니다
     * (설계 §6-2). 확정 줄은 관측치 처리만 씁니다 — 보유마다 그 세션의 확정 봉으로 평가됐는지를 보는 곳이 거기라서
     * ({@link #process}의 '순자산 줄'), {@code pricesFinal}이 true면 아무것도 하지 않습니다. 미확정 줄은 나중의 확정 관측치가
     * 덮습니다({@link PaperStore#upsertNav}). 이미 그날 줄이 있으면(확정이든 아니든) 건드리지 않습니다. 시작한(운용·일시정지)
     * 책만, 출발일 전 날짜는 쓰지 않습니다. 그 시장 책만 봅니다 — 다른 시장 책에는 줄을 쓰지 않습니다(거래일 d는 그 시장의 세션).
     *
     * @return 줄을 새로 쓴 책(정의 순)
     */
    List<String> settleNav(PaperMarket market, LocalDate tradingDate, boolean pricesFinal) {
        if (pricesFinal) {
            return List.of();
        }
        return exclusively(() -> {
            if (!store.ready()) {
                return List.of();
            }
            List<Book> books = new ArrayList<>(store.books(market.code()));
            books.sort(Comparator.comparing(Book::code, market.bookOrder()));
            List<String> written = new ArrayList<>();
            for (Book book : books) {
                boolean started = PaperBooks.ACTIVE.equals(book.status()) || PaperBooks.PAUSED.equals(book.status());
                if (!started || book.startedOn() == null || tradingDate.isBefore(book.startedOn())) {
                    continue;
                }
                Optional<BookState> state = store.state(book.code());
                boolean exists = store.navSeries(book.code()).stream()
                        .anyMatch(row -> row.tradingDate().equals(tradingDate));
                if (state.isEmpty() || exists) {
                    continue;
                }
                BookState s = state.get();
                store.atomically(() -> {
                    store.upsertNav(new NavRow(book.code(), tradingDate, s.nav(), s.cash(), s.equityValue(),
                            s.exposurePct(), false));
                    LocalDate navDate = s.lastNavTradingDate() == null || tradingDate.isAfter(s.lastNavTradingDate())
                            ? tradingDate : s.lastNavTradingDate();
                    store.upsertState(new BookState(s.bookCode(), s.cash(), s.nav(), s.equityValue(), s.exposurePct(),
                            s.lastObservedAt(), s.lastProcessedCollectedAt(), navDate, null));
                    return null;
                });
                written.add(book.code());
            }
            return written;
        });
    }

    // ------------------------------------------------------------------ 사후 체결(BACKFILL)
    /**
     * 사후 체결 주문 한 줄.
     *
     * @param targetWeightPct 매수: 기준 순자산({@link BackfillRequest#baseNav}) 대비 살 금액(%). 매도에는 쓰지 않음
     * @param sellFraction    매도: 보유 중 팔 비율. null이면 전량
     * @param reason          주문 근거 JSON — 주문 행에 그대로 남습니다
     */
    public record BackfillLeg(String ticker, String side, Double targetWeightPct, Double sellFraction,
                              JsonNode reason) {
    }

    /**
     * 사후 체결 요청.
     *
     * @param tradingDate 체결 거래일(출발일). 그날 종가로, 관측 시각은 그날 마감(16:00 ET)
     * @param source      주문 출처(BENCHMARK·RULE …, paper_orders.source)
     * @param decisionId  그 주문을 낸 결정(벤치마크는 null)
     * @param cash        체결 전 현금
     * @param baseNav     매수 금액의 기준 순자산. 다리마다 바뀌는 순자산이 아니라 체결 전 값입니다 — 슬리피지만큼 순자산이 줄어
     *                    뒤 다리일수록 덜 사는 일이 없게(벤치마크 60/40이 처음 정한 비중대로)
     * @param closes      종목 → 그날 종가와 출처(얼린 출발일 종가 — {@link PaperAdminService#startClose})
     * @param settings    슬리피지·현금성 종목
     */
    public record BackfillRequest(Book book, LocalDate tradingDate, String source, Long decisionId, double cash,
                                  double baseNav, List<BackfillLeg> legs,
                                  Map<String, PaperMarketData.SourcedClose> closes, PaperSettings settings) {
    }

    /**
     * 사후 체결 결과.
     *
     * @param fills   낸 체결(체결 순서 — 매도 → 매수 → 현금성 매수)
     * @param skipped 체결하지 못한 다리: 티커 → 사유(종가 없음·1주도 살 수 없음·보유 없음). 주문 행은 남기지 않습니다
     */
    public record BackfillResult(List<Fill> fills, List<Map.Entry<String, String>> skipped, double cash,
                                 PaperLedger.Valuation valuation) {
    }

    /**
     * 주문 목록을 그 거래일 종가로 한 번에 체결합니다(사후 체결, 명세 L2) — 벤치마크 초기화와 규칙 책 "시작"이 함께 씁니다.
     * 미국 책만 받습니다(거래일·마감 시각은 미국 달력 — 한국은 출발일 사후 체결이 없음, 명세 K28). 다른 시장 책이면 아무것도 쓰지
     * 않고 {@link IllegalArgumentException}.
     *
     * <p>순서는 관측치 처리와 같습니다: 매도 → 현금성이 아닌 매수 → 현금성 매수({@link #fill}의 이유). 체결가는 종가에 슬리피지,
     * 매수 수량은 {@code baseNav × 목표 비중}을 체결가로 나눠 내림(현금보다 많이 사지 않음 — 줄였으면 근거에 {@code cashLimited}).
     * 주문은 출처 그대로 {@code BACKFILL}·{@code FILLED}로 남기고(생성 = 그날 마감 1초 전, 기준 거래일 = 그 전 거래일 — 기록에서
     * 주문이 관측치보다 앞서 보이게), 체결은 {@code is_backfill = true}·관측 시각 = 그날 마감·가격 출처 = 종가의 출처입니다.
     *
     * <p>끝나면 그 종가로 평가해 그 거래일 순자산 줄(확정)·상태(멱등 키 = 그날 마감 — 그 전 저장본이 나중에 처리되며 장부를
     * 되돌리지 않게)를 쓰고 책을 운용(ACTIVE)·출발일 = 그 거래일로 바꿉니다. 한 트랜잭션이고, 바깥 트랜잭션이 있으면 합류합니다 —
     * 다리 하나라도 못 사면 되돌려야 하는 쪽(벤치마크)은 바깥에서 {@code skipped}를 보고 예외를 던지면 됩니다.
     */
    public BackfillResult backfill(BackfillRequest request) {
        PaperMarket us = UsPaperMarket.INSTANCE;
        if (!us.code().equals(request.book().market())) {
            throw new IllegalArgumentException("사후 체결은 미국 책만 합니다 — " + request.book().code() + "은 "
                    + request.book().market() + " 책입니다(한국은 출발일 사후 체결이 없음, 명세 K28)");
        }
        return store.atomically(() -> backfillLocked(us, request));
    }

    private BackfillResult backfillLocked(PaperMarket market, BackfillRequest r) {
        String code = r.book().code();
        LocalDate day = r.tradingDate();
        Instant close = market.calendar().closeInstant(day);
        double bp = r.settings().slippageBp();
        Map<String, Position> held = new TreeMap<>();
        store.positions(code).forEach(p -> held.put(p.ticker(), p));
        double cash = r.cash();
        List<Fill> fills = new ArrayList<>();
        List<Map.Entry<String, String>> skipped = new ArrayList<>();
        for (BackfillLeg leg : backfillOrder(r.legs(), r.settings())) {
            String ticker = leg.ticker();
            PaperMarketData.SourcedClose raw = r.closes().get(ticker);
            if (raw == null) {
                skipped.add(Map.entry(ticker, day + " " + ticker + " 종가가 없습니다"));
                continue;
            }
            if (PaperBooks.SELL.equals(leg.side())) {
                Position position = held.get(ticker);
                if (position == null) {
                    skipped.add(Map.entry(ticker, "체결 시점에 보유가 없습니다"));
                    continue;
                }
                int qty = PaperLedger.sellQty(position.qty(), leg.sellFraction());
                double price = price6(PaperLedger.fillPrice(raw.close(), PaperLedger.Side.SELL, bp));
                double gross = gross(qty, price);
                fills.add(backfillFill(market, r, leg, leg.reason(), qty, price, raw, gross, close));
                cash = PaperLedger.round4(cash + gross);
                int left = position.qty() - qty;
                if (left == 0) {
                    held.remove(ticker);
                    store.deletePosition(code, ticker);
                } else {
                    Position kept = new Position(code, ticker, left, position.avgCost(), position.openedOn(),
                            position.openedAt(), position.highWatermark(), position.watermarkAt(),
                            PaperLedger.round4(raw.close()), close, false, position.fillRefDate(),
                            position.fillRefClose(), position.splitNote());
                    held.put(ticker, kept);
                    store.upsertPosition(kept);
                }
                continue;
            }
            double price = price6(PaperLedger.fillPrice(raw.close(), PaperLedger.Side.BUY, bp));
            double weight = leg.targetWeightPct() == null ? 0 : leg.targetWeightPct();
            int wanted = PaperLedger.buyQty(r.baseNav() * weight / 100.0, price);
            if (wanted <= 0) {
                skipped.add(Map.entry(ticker, ticker + " 종가(" + raw.close() + ")로는 1주도 살 수 없습니다"));
                continue;
            }
            int qty = Math.min(wanted, PaperLedger.buyQty(cash, price));
            if (qty <= 0) {
                skipped.add(Map.entry(ticker, "현금이 모자라 1주도 살 수 없습니다(현금 " + money(cash) + ")"));
                continue;
            }
            JsonNode reason = leg.reason();
            if (qty < wanted) {
                ObjectNode limited = reason instanceof ObjectNode existing ? existing.deepCopy()
                        : mapper.createObjectNode();
                limited.put("cashLimited", true);
                limited.put("requestedQty", wanted);
                limited.put("filledQty", qty);
                reason = limited;
            }
            double gross = gross(qty, price);
            fills.add(backfillFill(market, r, leg, reason, qty, price, raw, gross, close));
            cash = PaperLedger.round4(cash - gross);
            Position before = held.get(ticker);
            Position after = before == null
                    ? new Position(code, ticker, qty, PaperLedger.round4(price), day, close, PaperLedger.round4(price),
                    close, PaperLedger.round4(raw.close()), close, false, day, raw.close(), null)
                    : new Position(code, ticker, before.qty() + qty,
                    PaperLedger.round4(PaperLedger.averageCost(before.qty(), before.avgCost(), qty, price)),
                    before.openedOn(), before.openedAt(),
                    PaperLedger.round4(TrailingStop.raiseWatermark(before.highWatermark(), price)), close,
                    PaperLedger.round4(raw.close()), close, false, before.fillRefDate(), before.fillRefClose(),
                    before.splitNote());
            held.put(ticker, after);
            store.upsertPosition(after);
        }

        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position position : held.values()) {
            PaperMarketData.SourcedClose raw = r.closes().get(position.ticker());
            qty.put(position.ticker(), position.qty());
            price.put(position.ticker(), raw != null ? raw.close()
                    : position.lastPrice() != null ? position.lastPrice() : position.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(cash, qty, price);
        double nav = PaperLedger.round4(valuation.nav());
        double equity = PaperLedger.round4(valuation.equityValue());
        double exposure = PaperLedger.round4(valuation.exposurePct());
        store.upsertNav(new NavRow(code, day, nav, cash, equity, exposure, true));
        store.upsertState(new BookState(code, cash, nav, equity, exposure, close, close, day, null));
        store.updateBookStatus(code, PaperBooks.ACTIVE);
        store.updateBookStartedOn(code, day);
        return new BackfillResult(fills, skipped, cash, valuation);
    }

    /** 사후 체결 순서: 매도 → 현금성이 아닌 매수 → 현금성 매수. 같은 묶음 안은 받은 순서. */
    private static List<BackfillLeg> backfillOrder(List<BackfillLeg> legs, PaperSettings settings) {
        List<BackfillLeg> out = new ArrayList<>();
        legs.stream().filter(leg -> PaperBooks.SELL.equals(leg.side())).forEach(out::add);
        legs.stream().filter(leg -> !PaperBooks.SELL.equals(leg.side()) && !settings.cashLike(leg.ticker()))
                .forEach(out::add);
        legs.stream().filter(leg -> !PaperBooks.SELL.equals(leg.side()) && settings.cashLike(leg.ticker()))
                .forEach(out::add);
        return out;
    }

    private Fill backfillFill(PaperMarket market, BackfillRequest r, BackfillLeg leg, JsonNode reason, int qty,
                              double price, PaperMarketData.SourcedClose raw, double gross, Instant close) {
        String code = r.book().code();
        String side = PaperBooks.SELL.equals(leg.side()) ? PaperBooks.SELL : PaperBooks.BUY;
        long orderId = store.insertOrder(new Order(0, code, r.decisionId(), leg.ticker(), side, null,
                PaperBooks.SELL.equals(side) ? null : leg.targetWeightPct(),
                PaperBooks.SELL.equals(side) ? leg.sellFraction() : null, PaperBooks.BACKFILL, r.source(),
                PaperBooks.ORDER_FILLED, null, reason, market.calendar().previousTradingDay(r.tradingDate()),
                close.minusSeconds(1), null, close));
        Fill fill = new Fill(0, orderId, code, leg.ticker(), side, qty, price, raw.close(), r.settings().slippageBp(),
                gross, close, r.tradingDate(), raw.source(), true, null);
        long fillId = store.insertFill(fill);
        return new Fill(fillId, orderId, code, leg.ticker(), side, qty, price, raw.close(), r.settings().slippageBp(),
                gross, close, r.tradingDate(), raw.source(), true, null);
    }

    private void recordFill(BookRun run, long orderId, String ticker, String side, int qty, double price, Bar bar,
                            double gross) {
        store.insertFill(new Fill(0, orderId, run.book.code(), ticker, side, qty, price, bar.close(),
                run.settings.slippageBp(), gross, run.at, bar.date(), run.market.quotesDataset(), false, null));
    }

    private static void raiseWatermark(Holding holding, double price, Instant at) {
        double raised = TrailingStop.raiseWatermark(holding.highWatermark, price);
        if (raised > holding.highWatermark) {
            holding.highWatermark = raised;
            holding.watermarkAt = at;
        }
    }

    // ------------------------------------------------------------------ 숫자
    /** 체결가를 저장 열(NUMERIC(18,6))과 같은 자리로 — 그래야 체결 금액 = 수량 × 화면의 체결가가 맞습니다. */
    static double price6(double price) {
        return BigDecimal.valueOf(price).setScale(6, RoundingMode.HALF_UP).doubleValue();
    }

    /** 체결 금액 = 수량 × 체결가, 소수 4자리(십진수). */
    static double gross(int qty, double price) {
        return BigDecimal.valueOf(price).multiply(BigDecimal.valueOf(qty)).setScale(4, RoundingMode.HALF_UP)
                .doubleValue();
    }

    private static String money(double value) {
        return BigDecimal.valueOf(value).setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private static String trim(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    private static String appendNote(String existing, String note) {
        String joined = existing == null || existing.isBlank() ? note : existing + " · " + note;
        return joined.length() <= SPLIT_NOTE_MAX ? joined : joined.substring(joined.length() - SPLIT_NOTE_MAX);
    }

    // ------------------------------------------------------------------ 작업 상태
    /** 책 하나를 처리하는 동안의 작업 상태(트랜잭션 안에서만 삶). */
    private static final class BookRun {
        /** 그 책의 시장 — 세션 날짜·확정 종가 판정·분할 기준 이력·체결 가격 출처. */
        final PaperMarket market;
        final Book book;
        final Quotes quotes;
        final PaperSettings settings;
        final Instant at;
        /** 관측 시각의 세션 날짜(시장 달력 — 장중·마감 뒤면 그날, 개장 전·주말이면 직전 거래일). */
        final LocalDate session;
        double cash;
        final Map<String, Holding> holdings = new TreeMap<>();
        final Set<String> removed = new LinkedHashSet<>();
        final Map<String, LocalDate> lockouts = new HashMap<>();
        final List<String> notes = new ArrayList<>();
        int filled;
        int stopped;
        int expired;
        int splits;

        BookRun(PaperMarket market, Book book, Quotes quotes, PaperSettings settings, double cash) {
            this.market = market;
            this.book = book;
            this.quotes = quotes;
            this.settings = settings;
            this.at = quotes.collectedAt();
            this.session = market.calendar().currentOrLastSession(at);
            this.cash = cash;
        }

        Bar bar(String ticker) {
            return quotes.bars().get(ticker);
        }

        void note(String text) {
            notes.add(text);
        }

        PaperLedger.Valuation valuation() {
            Map<String, Integer> qty = new HashMap<>();
            Map<String, Double> price = new HashMap<>();
            for (Holding holding : holdings.values()) {
                qty.put(holding.ticker, holding.qty);
                price.put(holding.ticker, holding.valuationPrice());
            }
            return PaperLedger.value(cash, qty, price);
        }

        double nav() {
            return valuation().nav();
        }
    }

    /** 보유 한 건의 작업 사본. 끝에 {@link #toPosition}으로 저장합니다. */
    private static final class Holding {
        final String ticker;
        int qty;
        double avgCost;
        final LocalDate openedOn;
        final Instant openedAt;
        double highWatermark;
        Instant watermarkAt;
        Double lastPrice;
        Instant lastPriceAt;
        boolean priceStale;
        LocalDate fillRefDate;
        double fillRefClose;
        String splitNote;
        /** 이번 관측치의 가격을 믿을 수 있나(새 봉이 있고 분할 여부를 확인함) — 체결·스탑의 전제. */
        boolean verified;

        Holding(Position p) {
            this.ticker = p.ticker();
            this.qty = p.qty();
            this.avgCost = p.avgCost();
            this.openedOn = p.openedOn();
            this.openedAt = p.openedAt();
            this.highWatermark = p.highWatermark();
            this.watermarkAt = p.watermarkAt();
            this.lastPrice = p.lastPrice();
            this.lastPriceAt = p.lastPriceAt();
            this.priceStale = p.priceStale();
            this.fillRefDate = p.fillRefDate();
            this.fillRefClose = p.fillRefClose();
            this.splitNote = p.splitNote();
        }

        Holding(String ticker, int qty, double avgCost, LocalDate openedOn, Instant openedAt, double highWatermark,
                Instant watermarkAt, double lastPrice, Instant lastPriceAt, LocalDate fillRefDate, double fillRefClose) {
            this.ticker = ticker;
            this.qty = qty;
            this.avgCost = avgCost;
            this.openedOn = openedOn;
            this.openedAt = openedAt;
            this.highWatermark = highWatermark;
            this.watermarkAt = watermarkAt;
            this.lastPrice = lastPrice;
            this.lastPriceAt = lastPriceAt;
            this.fillRefDate = fillRefDate;
            this.fillRefClose = fillRefClose;
        }

        /** 평가 가격: 마지막으로 본 가격, 한 번도 못 봤으면 평단(가격 없음 배지와 함께). */
        double valuationPrice() {
            return lastPrice != null ? lastPrice : avgCost;
        }

        Position toPosition(String code) {
            return new Position(code, ticker, qty, PaperLedger.round4(avgCost), openedOn, openedAt,
                    PaperLedger.round4(highWatermark), watermarkAt, lastPrice == null ? null : PaperLedger.round4(lastPrice),
                    lastPriceAt, priceStale, fillRefDate, fillRefClose, splitNote);
        }
    }
}
