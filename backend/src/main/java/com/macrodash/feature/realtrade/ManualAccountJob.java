package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.DecisionState;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.ManualAccountLedger.Entry;
import com.macrodash.feature.realtrade.ManualAccountLedger.State;
import com.macrodash.feature.realtrade.ManualAccountPlanner.Draft;
import com.macrodash.feature.realtrade.ManualAccountPlanner.Result;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Account;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.LedgerValues;
import com.macrodash.store.ManualAccountStore.NewInstruction;
import com.macrodash.store.ManualAccountStore.NewStopInstruction;
import com.macrodash.store.ManualAccountStore.StopInstruction;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * ISA 계좌 정기 작업(ADR 0029 — 명세 docs/specs/2026-11-06-isa-manual-account.md §2·§3·§4) — <b>전용 단일 스레드</b>에서
 * {@code dashboard.manual.interval-ms}(10분)마다 한 주기를 돕니다. 스프링 TaskScheduler 빈을 하나 더 두면 기본 스케줄러가 물러나 모든 정기 작업이 그 빈으로
 * 옮겨 가므로({@link RealTradeJob}과 같은 이유) 이 작업만의 실행기를 직접 둡니다. 모의 매매 정기 작업 스위치({@code dashboard.paper.enabled})나 스케줄러
 * ({@code dashboard.scheduler.enabled})가 꺼져 있으면 아무것도 하지 않습니다 — 모의 매매 상태가 있는 서버 한 곳에서만 돕니다. 실제 매매 스위치
 * ({@code REAL_TRADE_ENABLED})와는 상관없습니다(증권사 호출이 없음).
 *
 * <p>한 주기
 * <ol>
 *   <li><b>자동 기록</b>(§3): 개장이 지난 세션의 PLANNED 지시를 그 세션 시가({@link PaperMirrorService#openPrices} — 모의 장부와 같은 사다리)로 장부에
 *       적습니다. 시각 맞추기 날의 지시(근거 {@value #DETAIL_TARGET_AT} — ADR 0033 초안 결정 7)는 그 시각이 지난 뒤 그 시각의 1분봉 사다리
 *       ({@link PaperMirrorService#pricesAt} — 규칙 계좌 체결과 같은 값)로, 장부 시각도 그 시각으로 적고, 그 시각의 1분봉 창이 아예 없는 종목은 그 세션
 *       시가로 어림해 적습니다({@value #AUTO_OPEN_FALLBACK}). 그 밖은 아래와 같습니다 — 장부에
 *       적습니다(AUTO, 수수료·세금 0 → RECORDED). 사용자가 먼저 그 지시에 묶어 넣은 행이 있으면 적지 않고 RECORDED. 시가를 아직 못 구한 종목은 PLANNED로
 *       남고, 그런 매도 시가를 기다리는 동안 그 세션 매수도 기다립니다(매도 대금 없이 매수를 적지 않게). 그 세션에 거래가 없어(거래량 0·정지) 시가가 다시
 *       오지 않을 종목({@link PaperMirrorService#openUnfillable})은 기다리지 않고 SKIPPED(autoNote {@code halted} — 매수를 막지 않음), 지시를 만든 뒤 그
 *       세션이 거래일이 아니게 되면(늦은 휴장 지정) 그 세션 PLANNED 지시를 모두 SKIPPED(autoNote {@code not-trading}). 장부가 음수가 되지 않게 매도는
 *       보유까지·매수는 현금까지로 줄여 적고(메모), 1주도 안 되면 SKIPPED.</li>
 *   <li><b>못 만듦</b>: 마지막으로 개장한 세션에 지시가 없으면(시작 뒤 세션만) 그 세션을 UNAVAILABLE로 남깁니다.</li>
 *   <li><b>지시 만들기</b>(§2): 다음 세션 E(개장 전)의 지시가 아직 없고, 앞 세션 지시가 모두 적혔고, 규칙 계좌의 D(E 전 거래일) 정기 결정이 최종
 *       (OK·NO_TRADE·SKIPPED 또는 기한 지남)이고, 규칙 계좌 장부가 D까지 반영했고({@link PaperMirrorService#ledgerCaughtUp}), 시가 목표가 완전할 때
 *       ({@link OpenTargets#complete}) {@link ManualAccountPlanner}로 계산해 세션 행과 지시 행을 한 트랜잭션으로 씁니다. 지시가 없으면 NONE(알리지 않음).
 *       규칙 계좌가 개장 10분 뒤 지정 시각으로 체결하는 날({@link PaperMirrorService#dailySyncAt} — ADR 0033 초안 결정 7)은 그 시각까지의 모의 주문을
 *       반영한 목표({@link PaperMirrorService#targetsAt})로 '그 시각 이후 시장가' 지시를 만듭니다. 그 목표에 들지 않는 시가 밖 시점 대기 주문(STOP 매도
 *       제외 — 스탑 지시가 따로 맡음)이 있으면 목표가 그 결정을 담지 못하므로 만들지 않습니다(사유 {@code timed-orders} — 개장 뒤 못 만듦). 장부 고침이 이미 알린 지시를 지운 세션
 *       ({@link ManualAccountService} — 그 세션 08:00 전)을 다시 만들면 '다시 계산'으로 표시합니다.</li>
 *   <li><b>알림</b>(§4): 밤 — 지시를 만든 뒤 E 08:00(그 전에 개장하면 개장)까지, 아침 — E 08:00 뒤 E 마감 전까지 PLANNED 지시를 한 통씩. 텔레그램이
 *       설정되지 않았거나 실패하면 다음 주기에 다시. 글은 종목 코드·이름·수량만({@link ManualAccountNotices}). 다시 계산한 지시는 제목에 '(다시 계산)',
 *       다시 계산했더니 지시가 없으면(NONE) 그 세션 개장 전까지 '할 매매가 없음' 한 통.</li>
 * </ol>
 *
 * <p><b>장중 스탑 지시</b>(ADR 0033 초안 결정 7 — V28 {@code manual_stop_instructions}): {@code dashboard.manual.stop-interval-ms}(30초)마다 — 위 네
 * 단계는 그중 {@code interval-ms}(10분)이 지난 주기에만 — 규칙 계좌의 오늘 STOP 매도 대기 주문({@link PaperMirrorService#dueOrders} — 장중 감시·밤 대체,
 * 지금 + 5분 안의 것)마다 그 주문이 그날 지시 목표에 반영된 것(세션 기록 {@value #DETAIL_COVERED_STOPS})이 아니면 스탑 지시 하나(모의 주문 하나에 하나 —
 * UNIQUE)를 씁니다. 수량은 ISA 장부 보유 + 그날 아직 적지 않은 지시 증감 가운데 지시 시각이 지난 것의 정수 부분이고, 1주도 없으면 쓰지 않습니다. 알리지
 * 않은 스탑 지시는 바로 한 통으로 알리고(종목 코드·이름·수량만 — 종가 STOP은 '종가 단일가 시장가' 글, ADR 0029 결정 4의 예외 안), 그 세션 마감까지 못
 * 알리면 SKIPPED(not-notified — 적지 않음, 다음 날 지시가 '책에 없는 보유'로 팖). 알린 스탑 지시는 그 모의 주문과 같은 1분봉 사다리 값
 * ({@link PaperMirrorService#orderLadderPrice})으로 그 주문 기준 시각에 자동 기록하고(그 세션 앞 지시가 모두 적힌 뒤), 1분봉 창이 아예 없으면 그 세션
 * 종가로 어림합니다. 알린 스탑 지시가 적히기 전에는 다음 세션 지시를 만들지 않습니다(같은 종목을 '책에 없는 보유'로 다시 팔라고 하지 않게).
 *
 * <p>로그에는 세션·건수·사유 코드만 남깁니다(종목·수량·금액 없음). 예상 못 한 예외·오류는 클래스 이름만 남기고 다음 주기에 다시 봅니다(던지면 전용
 * 스케줄러가 뒤 주기를 모두 건너뜀).
 */
@Component
class ManualAccountJob {

    private static final Logger log = LoggerFactory.getLogger(ManualAccountJob.class);

    static final String CODE = ManualAccountService.CODE;
    static final String SOURCE_BOOK = ManualAccountService.SOURCE_BOOK;
    static final long INITIAL_DELAY_MS = 60_000;
    static final long SHUTDOWN_WAIT_SECONDS = 30;
    /** 아침 알림 시각(KST). */
    static final LocalTime MORNING = LocalTime.of(8, 0);
    /** 규칙 계좌 결정이 최종인 상태(기한이 지나도 최종). */
    static final Set<String> FINAL_STATUSES = Set.of("OK", "NO_TRADE", "SKIPPED");
    /** 자동 기록이 건너뛴 사유(지시 근거의 autoNote). */
    static final String AUTO_HALTED = PaperMirrorService.OPEN_HALTED;
    static final String AUTO_NOT_TRADING = "not-trading";
    /** 자동 기록 메모 — 지시 시각의 1분봉 창이 아예 없어(그 시각 규칙 계좌 주문이 없던 종목) 그 세션 시가로 어림해 적음(ADR 0033 초안 결정 7). */
    static final String AUTO_OPEN_FALLBACK = "open-fallback";
    /**
     * 지시 근거·세션 계산 기록의 키 — 그 지시를 낼 시각(시각 맞추기 날 — 따라 하는 책의 일일 맞추기 시각, ISO). 없으면 예전 시가 지시(시가 사다리
     * 자동 기록). 세션 기록에는 그 지시 목표에 반영한 시각 지정 STOP 주문 번호({@value #DETAIL_COVERED_STOPS} — 스탑 지시를 따로 내지 않음)도 남깁니다.
     */
    static final String DETAIL_TARGET_AT = "targetAt";
    static final String DETAIL_COVERED_STOPS = "coveredStopOrderIds";
    /** 스탑 지시를 만들 모의 STOP 주문 — 따라 할 시각이 지금 + 이 안(종가 STOP은 종가 단일가 시작 5분 전부터 알림). */
    static final Duration STOP_LOOKAHEAD = Duration.ofMinutes(5);
    /** 스탑 지시를 적지 않고 건너뛴 사유(근거의 autoNote) — 그 세션 마감까지 알리지 못함. */
    static final String AUTO_NOT_NOTIFIED = "not-notified";
    /** 스탑 지시 자동 기록 메모 — 그 주문 기준 시각의 1분봉 창이 없어 그 세션 종가로 어림. */
    static final String AUTO_CLOSE_FALLBACK = "close-fallback";
    /** 스탑 지시를 찾는 KST 시각 범위(정규장 — 장 시간 변경일 10:00~16:30 포함, 그 안에서 그날 달력의 개장~마감만). */
    static final LocalTime STOP_SCAN_FROM = LocalTime.of(8, 30);
    static final LocalTime STOP_SCAN_UNTIL = LocalTime.of(17, 0);
    /** 스탑 지시가 받는 모의 주문 시점(V28 CHECK — 시가 STOP은 다음 시가 지시에 들어감). */
    static final Set<String> STOP_TIMINGS = Set.of("MARKET", "AT_MINUTE", "NEXT_CLOSE");
    /** 세션 계산 기록(detail)의 '다시 계산' 표시와 '할 매매 없음' 알림 시각 키. */
    static final String DETAIL_RECALCULATED = "recalculated";
    static final String DETAIL_RECALC_NOTICE_AT = "recalcNoticeAt";
    /** 모의 책 상태 — 시작 전(따라 하지 않음). */
    static final String BOOK_NOT_STARTED = "NOT_STARTED";

    // ------------------------------------------------------------------ 지시를 아직 만들지 않은 사유(화면 메모·못 만듦 기록)
    static final String WAIT_CALENDAR = "calendar-unknown";
    static final String WAIT_BOOK = "book-not-started";
    static final String WAIT_DECISION = "decision-pending";
    static final String WAIT_LEDGER = "ledger-behind";
    static final String WAIT_TARGETS = "targets-unavailable";
    static final String WAIT_PRICE = "price-missing";
    static final String WAIT_RECORD = "record-pending";
    static final String WAIT_UNKNOWN = "not-planned";
    static final String WAIT_TIMED = "timed-orders";

    private static final Map<String, String> REASON_LABEL = Map.of(
            WAIT_CALENDAR, "달력을 모름",
            WAIT_BOOK, "규칙 계좌가 시작 전",
            WAIT_DECISION, "규칙 계좌 결정 대기",
            WAIT_LEDGER, "규칙 계좌 장부 반영 대기",
            WAIT_TARGETS, "규칙 계좌 시가 목표를 아직 계산할 수 없음(가격 모름·불완전)",
            WAIT_PRICE, "ISA 보유 종목의 가격을 모름",
            WAIT_RECORD, "앞 세션 지시의 체결 기록 대기",
            WAIT_UNKNOWN, "개장 전에 지시를 만들지 못함",
            WAIT_TIMED, "규칙 계좌가 지시 시각 밖 시점(분 지정·종가 등)으로 주문함 — ISA는 시가·개장 10분 뒤 시각만 지시");

    /** 다음 세션 지시를 아직 만들지 않은 사유(화면용 — 저장하지 않음). */
    record Waiting(LocalDate session, String reason, Instant at) {
    }

    private final ManualAccountStore store;
    private final PaperMirrorService paper;
    private final PaperTelegram telegram;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final boolean paperEnabled;
    private final boolean schedulerEnabled;
    private final long intervalMs;
    private final long stopIntervalMs;
    private final ReentrantLock running = new ReentrantLock();

    private ScheduledExecutorService scheduler;
    private volatile Waiting waiting;
    private volatile Instant lastCycleAt;
    /** 위 네 단계(자동 기록·못 만듦·지시·알림)를 마지막으로 돈 시각 — 스탑 주기 사이에는 {@code interval-ms}가 지났을 때만. */
    private Instant lastFullAt;

    @Autowired
    ManualAccountJob(ManualAccountStore store, PaperMirrorService paper, PaperTelegram telegram, ObjectMapper mapper,
                     @Value("${dashboard.paper.enabled:true}") boolean paperEnabled,
                     @Value("${dashboard.scheduler.enabled:true}") boolean schedulerEnabled,
                     @Value("${dashboard.manual.interval-ms:600000}") long intervalMs,
                     @Value("${dashboard.manual.stop-interval-ms:30000}") long stopIntervalMs) {
        this(store, paper, telegram, mapper, Clock.systemUTC(), paperEnabled, schedulerEnabled, intervalMs, stopIntervalMs);
    }

    /** 시험용 — 시계를 정합니다(스탑 주기 30초). */
    ManualAccountJob(ManualAccountStore store, PaperMirrorService paper, PaperTelegram telegram, ObjectMapper mapper, Clock clock,
                     boolean paperEnabled, boolean schedulerEnabled, long intervalMs) {
        this(store, paper, telegram, mapper, clock, paperEnabled, schedulerEnabled, intervalMs, 30_000);
    }

    /** 시험용 — 시계와 스탑 주기를 정합니다. */
    ManualAccountJob(ManualAccountStore store, PaperMirrorService paper, PaperTelegram telegram, ObjectMapper mapper, Clock clock,
                     boolean paperEnabled, boolean schedulerEnabled, long intervalMs, long stopIntervalMs) {
        this.store = store;
        this.paper = paper;
        this.telegram = telegram;
        this.mapper = mapper;
        this.clock = clock;
        this.paperEnabled = paperEnabled;
        this.schedulerEnabled = schedulerEnabled;
        this.intervalMs = Math.max(10_000, intervalMs);
        this.stopIntervalMs = Math.max(5_000, Math.min(stopIntervalMs, this.intervalMs));
    }

    /** 정기 작업이 도는 서버인가(모의 매매 정기 작업·스케줄러가 모두 켜짐). */
    boolean enabled() {
        return paperEnabled && schedulerEnabled;
    }

    /** 다음 세션 지시를 아직 만들지 않은 사유(없거나 꺼져 있으면 null). */
    Waiting waiting() {
        return enabled() ? waiting : null;
    }

    /** 마지막으로 주기를 (예외 없이) 끝낸 시각 — 꺼져 있거나 아직 없으면 null. */
    Instant lastCycleAt() {
        return enabled() ? lastCycleAt : null;
    }

    static String reasonLabel(String code) {
        return REASON_LABEL.getOrDefault(code, code == null ? "알 수 없음" : code);
    }

    // ------------------------------------------------------------------ 생명주기
    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        if (!enabled()) {
            log.info("ISA 계좌 정기 작업 꺼짐 — 모의 매매 정기 작업(dashboard.paper.enabled)={} · 스케줄러={}", paperEnabled, schedulerEnabled);
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "manual-account");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.scheduleWithFixedDelay(this::tick, INITIAL_DELAY_MS, stopIntervalMs, TimeUnit.MILLISECONDS);
        log.info("ISA 계좌 정기 작업 켜짐 — 스탑 지시 {}ms·나머지 {}ms마다(전용 단일 스레드)", stopIntervalMs, intervalMs);
    }

    @PreDestroy
    public void stop() {
        ScheduledExecutorService current = scheduler;
        if (current == null) {
            return;
        }
        current.shutdown();
        try {
            if (!current.awaitTermination(SHUTDOWN_WAIT_SECONDS, TimeUnit.SECONDS)) {
                log.warn("ISA 계좌 정기 작업이 {}초 안에 끝나지 않음", SHUTDOWN_WAIT_SECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** 스케줄러가 부르는 한 번 — 무엇을 던져도 잡고 이어 갑니다. {@code interval-ms}가 지났으면 한 주기 전체, 아니면 스탑 지시만. */
    void tick() {
        try {
            Instant now = clock.instant();
            if (lastFullAt == null || !now.isBefore(lastFullAt.plusMillis(intervalMs))) {
                cycle(now);
                lastFullAt = now;
            } else {
                stopCycle(now);
            }
            lastCycleAt = clock.instant();
        } catch (RuntimeException e) {
            log.warn("ISA 계좌 정기 작업 실패 — 다음 주기에 다시: {}", e.getClass().getSimpleName());
        } catch (Throwable e) {   // Error도 — 다시 던지면 scheduleWithFixedDelay가 뒤 주기를 모두 건너뜀
            log.error("ISA 계좌 정기 작업 오류 — 다음 주기에 다시: {}", e.getClass().getSimpleName());
        }
    }

    // ------------------------------------------------------------------ 한 주기
    /** 한 주기(클래스 설명) — 시험이 시각을 정해 부릅니다. 앞 주기가 도는 중이면 건너뜁니다. */
    void cycle(Instant now) {
        if (!store.ready() || !running.tryLock()) {
            return;
        }
        try {
            Account account = store.account(CODE).orElse(null);
            if (account == null || !account.active()) {
                waiting = null;
                return;
            }
            autoRecord(now);
            stopRecord(now);
            markUnavailable(account, now);
            plan(now);
            notifyPending(now);
            stopScan(account, now);
            stopNotify(now);
        } finally {
            running.unlock();
        }
    }

    /** 스탑 지시만(30초 주기 — 클래스 설명) — 앞 주기가 도는 중이면 건너뜁니다. */
    void stopCycle(Instant now) {
        if (!store.ready() || !running.tryLock()) {
            return;
        }
        try {
            Account account = store.account(CODE).orElse(null);
            if (account == null || !account.active()) {
                return;
            }
            stopScan(account, now);
            stopNotify(now);
        } finally {
            running.unlock();
        }
    }

    // ------------------------------------------------------------------ 장중 스탑 지시(ADR 0033 초안 결정 7)
    /**
     * 오늘 규칙 계좌 STOP 매도 대기 주문마다 스탑 지시 하나(클래스 설명) — 거래일 정규장(개장 ~ 마감) 안이고 계좌가 그 전에 시작했을 때만. 그날 지시 목표에
     * 반영한 STOP(세션 기록 {@value #DETAIL_COVERED_STOPS})은 지시가 이미 팔게 하므로 쓰지 않습니다. 만든 지시 수.
     */
    int stopScan(Account account, Instant now) {
        LocalTime clockTime = now.atZone(Kst.ZONE).toLocalTime();
        if (clockTime.isBefore(STOP_SCAN_FROM) || clockTime.isAfter(STOP_SCAN_UNTIL)) {
            return 0;   // 정규장(장 시간 변경일 포함) 밖 — 30초마다 모의 달력을 열지 않게
        }
        LocalDate today = now.atZone(Kst.ZONE).toLocalDate();
        SessionHours hours = ManualAccountCalendar.hours(paper, today);
        if (hours == null || !hours.tradingDay() || hours.open() == null || hours.close() == null || now.isBefore(hours.open())
                || now.isAfter(hours.close()) || account.startedAt() == null || now.isBefore(account.startedAt())) {
            return 0;
        }
        List<PaperMirrorService.DueOrder> stops = paper.dueOrders(SOURCE_BOOK, today, now.plus(STOP_LOOKAHEAD)).stream()
                .filter(PaperMirrorService.DueOrder::stop).filter(o -> o.supported() && o.target() != null && o.ticker() != null
                        && STOP_TIMINGS.contains(o.timing())).toList();
        if (stops.isEmpty()) {
            return 0;
        }
        Set<Long> covered = new java.util.HashSet<>();
        store.session(CODE, today).map(ManualAccountStore.SessionRow::detail).map(d -> d.path(DETAIL_COVERED_STOPS))
                .ifPresent(ids -> ids.forEach(id -> covered.add(id.asLong())));
        int made = 0;
        for (PaperMirrorService.DueOrder o : stops) {
            if (covered.contains(o.orderId()) || store.stopInstructionForOrder(CODE, o.orderId()).isPresent()) {
                continue;
            }
            Boolean wrote = store.lockAccount(CODE, acc -> {
                if (acc == null || !acc.active() || store.stopInstructionForOrder(CODE, o.orderId()).isPresent()) {
                    return false;
                }
                int quantity = stopQuantity(today, o.ticker(), now);
                if (quantity < 1) {
                    return false;
                }
                Map<String, Object> reason = new LinkedHashMap<>();
                reason.put("paperOrderId", o.orderId());
                reason.put("trigger", "TRAILING_STOP");
                reason.put("mirrorAt", o.mirrorAt() == null ? null : o.mirrorAt().toString());
                boolean inserted = store.insertStopInstruction(CODE, new NewStopInstruction(today, o.orderId(), o.ticker(), quantity, o.timing(),
                        o.target(), mapper.valueToTree(reason))).isPresent();
                if (inserted) {
                    store.bumpVersion(CODE);
                }
                return inserted;
            });
            if (Boolean.TRUE.equals(wrote)) {
                made++;
            }
        }
        if (made > 0) {
            log.info("ISA 계좌 스탑 지시 — 세션 {} · {}건", today, made);
        }
        return made;
    }

    /** 잠금 안 — 그 종목의 ISA 장부 보유 + 그날 아직 적지 않은 지시 가운데 지시 시각(없으면 개장)이 지난 것의 증감, 정수 부분. */
    private int stopQuantity(LocalDate session, String symbol, Instant now) {
        State state = ManualAccountLedger.replay(store.ledger(CODE).stream().map(Entry::of).toList());
        BigDecimal held = state.holdings().containsKey(symbol) ? state.holdings().get(symbol).quantity() : BigDecimal.ZERO;
        SessionHours hours = ManualAccountCalendar.hours(paper, session);
        for (Instruction i : store.instructions(CODE, session)) {
            if (!i.planned() || !symbol.equals(i.symbol()) || !store.ledgerForInstruction(i.id()).isEmpty()) {
                continue;
            }
            Instant at = targetAt(i) != null ? targetAt(i) : hours == null ? null : hours.open();
            if (at == null || at.isAfter(now)) {
                continue;
            }
            BigDecimal delta = BigDecimal.valueOf(i.quantity());
            held = ManualAccountStore.SIDE_SELL.equals(i.side()) ? held.subtract(delta) : held.add(delta);
        }
        BigDecimal whole = held.setScale(0, RoundingMode.FLOOR);
        return whole.signum() <= 0 ? 0 : whole.min(BigDecimal.valueOf(Integer.MAX_VALUE)).intValue();
    }

    /**
     * 알리지 않은 스탑 지시를 세션마다 한 통으로 바로 알립니다(종목 코드·이름·수량만 — {@link ManualAccountNotices#stop}). 그 세션 마감이 지나도록 알리지
     * 못한 지시는 SKIPPED({@value #AUTO_NOT_NOTIFIED} — 적지 않음). 텔레그램이 설정되지 않았거나 실패하면 다음 주기에 다시.
     */
    void stopNotify(Instant now) {
        Map<LocalDate, List<StopInstruction>> bySession = new TreeMap<>();
        for (StopInstruction s : store.plannedStopInstructions(CODE)) {
            if (s.notifiedAt() == null) {
                bySession.computeIfAbsent(s.session(), k -> new ArrayList<>()).add(s);
            }
        }
        for (Map.Entry<LocalDate, List<StopInstruction>> e : bySession.entrySet()) {
            SessionHours hours = ManualAccountCalendar.hours(paper, e.getKey());
            if (hours == null || hours.close() == null || !now.isBefore(hours.close())) {
                int skipped = store.lockAccount(CODE, acc -> {
                    int n = 0;
                    for (StopInstruction s : e.getValue()) {
                        if (store.updateStopInstructionStatus(s.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                                Map.of("skippedBy", "AUTO", "autoNote", AUTO_NOT_NOTIFIED))) {
                            n++;
                        }
                    }
                    if (n > 0) {
                        store.bumpVersion(CODE);
                    }
                    return n;
                });
                if (skipped > 0) {
                    log.warn("ISA 계좌 스탑 지시 — 세션 {} 마감까지 알리지 못해 건너뜀 · {}건", e.getKey(), skipped);
                }
                continue;
            }
            if (!telegram.configured()) {
                continue;
            }
            Set<String> symbols = new TreeSet<>();
            e.getValue().forEach(s -> symbols.add(s.symbol()));
            Map<String, String> names = new HashMap<>(paper.names(symbols));
            if (!sendText(ManualAccountNotices.stop(e.getKey(), ManualAccountNotices.wallClock(hours.open()),
                    ManualAccountNotices.wallClock(hours.close()), e.getValue(), names))) {
                return;
            }
            store.markStopNotified(e.getValue().stream().map(StopInstruction::id).toList(), now);
        }
    }

    /**
     * 알린 스탑 지시의 자동 기록(클래스 설명) — 그 모의 주문과 같은 1분봉 사다리 값으로 그 주문 기준 시각에, 그 세션의 그 시각 이하 지시가 모두 적힌 뒤.
     * 사용자가 먼저 묶은 행이 있으면 RECORDED(USER), 그날 1분봉이 없거나 T 뒤 거래가 없으면 SKIPPED(halted), 1분봉 창이 아예 없으면 밤 관측치에 그 세션이
     * 들어온 뒤 그 종가로 어림({@value #AUTO_CLOSE_FALLBACK}). 바꾼 지시 수.
     */
    int stopRecord(Instant now) {
        int changed = 0;
        for (StopInstruction s : store.plannedStopInstructions(CODE)) {
            if (s.notifiedAt() == null || now.isBefore(s.targetAt())) {
                continue;
            }
            boolean dailyWaiting = store.instructions(CODE, s.session()).stream().anyMatch(i -> i.planned()
                    && !Optional.ofNullable(targetAt(i)).orElse(Instant.MIN).isAfter(s.targetAt()));
            if (dailyWaiting) {
                continue;   // 그 세션 앞 지시가 먼저 적혀야 보유가 맞음
            }
            Optional<PaperMirrorService.LadderPrice> ladder = paper.orderLadderPrice(SOURCE_BOOK, s.paperOrderId());
            BigDecimal price = ladder.map(PaperMirrorService.LadderPrice::price).orElse(null);
            boolean unfillable = ladder.map(PaperMirrorService.LadderPrice::unfillable).orElse(false);
            boolean fallback = false;
            if (price == null && ladder.map(PaperMirrorService.LadderPrice::noWindow).orElse(false)
                    && paper.openPrices(s.session(), Set.of(s.symbol())).containsKey(s.symbol())) {
                price = paper.lastPrices(Set.of(s.symbol())).get(s.symbol());   // 밤 관측치에 그 세션이 들어옴 — 그 종가로 어림
                fallback = price != null;
            }
            if (price == null && !unfillable) {
                continue;
            }
            BigDecimal chosen = price;
            boolean closeFallback = fallback;
            Integer done = store.lockAccount(CODE, acc -> acc == null || !acc.active() ? 0 : recordStop(s.id(), chosen, closeFallback));
            changed += done == null ? 0 : done;
        }
        if (changed > 0) {
            store.bumpVersion(CODE);
            log.info("ISA 계좌 스탑 지시 자동 기록 — {}건", changed);
        }
        return changed;
    }

    /** 잠금 안 — 스탑 지시 하나를 다시 읽어 적거나(보유까지로 줄임) 건너뜁니다. 바꿨으면 1. */
    private int recordStop(long id, BigDecimal price, boolean closeFallback) {
        StopInstruction s = store.stopInstruction(id).filter(StopInstruction::planned).orElse(null);
        if (s == null) {
            return 0;
        }
        if (!store.ledgerForStopInstruction(id).isEmpty()) {
            return store.updateStopInstructionStatus(id, ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED,
                    Map.of("recordedBy", "USER")) ? 1 : 0;
        }
        if (price == null || price.signum() <= 0) {
            return store.updateStopInstructionStatus(id, ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                    Map.of("skippedBy", "AUTO", "autoNote", AUTO_HALTED)) ? 1 : 0;
        }
        List<Entry> entries = store.ledger(CODE).stream().map(Entry::of).toList();
        BigDecimal wanted = BigDecimal.valueOf(s.quantity());
        BigDecimal max = ManualAccountLedger.minHoldingFrom(entries, s.symbol(), s.targetAt(), ManualAccountStore.KIND_SELL)
                .setScale(0, RoundingMode.FLOOR);
        BigDecimal quantity = wanted.min(max.max(BigDecimal.ZERO));
        if (quantity.signum() <= 0) {
            return store.updateStopInstructionStatus(id, ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                    Map.of("skippedBy", "AUTO", "autoNote", "no-holding")) ? 1 : 0;
        }
        boolean reduced = quantity.compareTo(wanted) < 0;
        String clock = ManualAccountNotices.hhmm(s.targetAt().atZone(Kst.ZONE).toLocalTime());
        String note = (closeFallback ? "스탑 지시대로 자동 기록 — " + clock + " 1분봉이 없어 그 세션 종가로 어림(수수료·세금 0 어림)"
                : "스탑 지시대로 자동 기록(규칙 계좌 스탑과 같은 " + clock + " 1분봉 값, 수수료·세금 0 어림)")
                + (reduced ? " — 보유가 모자라 " + quantity.toPlainString() + "주로 줄임" : "");
        store.insertLedger(CODE, new LedgerValues(s.targetAt(), ManualAccountStore.KIND_SELL, s.symbol(), quantity, price, null,
                BigDecimal.ZERO, BigDecimal.ZERO, null, ManualAccountStore.SOURCE_AUTO, note, id));
        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("recordedBy", "AUTO");
        if (reduced) {
            patch.put("autoNote", "reduced-holding");
        } else if (closeFallback) {
            patch.put("autoNote", AUTO_CLOSE_FALLBACK);
        }
        return store.updateStopInstructionStatus(id, ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED, patch) ? 1 : 0;
    }

    // ------------------------------------------------------------------ 자동 기록(§3)
    void autoRecord(Instant now) {
        Map<LocalDate, List<Instruction>> bySession = new TreeMap<>();
        for (Instruction i : store.plannedInstructions(CODE)) {
            bySession.computeIfAbsent(i.session(), s -> new ArrayList<>()).add(i);
        }
        for (Map.Entry<LocalDate, List<Instruction>> e : bySession.entrySet()) {
            Optional<SessionHours> day = paper.sessionHours(e.getKey());
            if (day.isPresent() && !day.get().tradingDay()) {
                // 지시를 만든 뒤 그 세션이 거래일이 아니게 됨(늦은 휴장 지정) — 그 시가는 오지 않음
                int skipped = store.lockAccount(CODE, acc -> acc == null || !acc.active() ? 0 : skipAll(e.getKey(), AUTO_NOT_TRADING));
                if (skipped > 0) {
                    log.warn("ISA 계좌 지시 건너뜀 — 세션 {}이 거래일이 아님 · {}건", e.getKey(), skipped);
                }
                continue;
            }
            SessionHours hours = day.orElse(null);
            if (hours == null || hours.open() == null || now.isBefore(hours.open())) {
                continue;
            }
            Set<String> symbols = new TreeSet<>();
            e.getValue().forEach(i -> symbols.add(i.symbol()));
            Instant target = targetAt(e.getValue());
            if (target != null && now.isBefore(target)) {
                continue;   // 시각 맞추기 지시 — 그 시각 전에는 적지 않음
            }
            Map<String, BigDecimal> prices;
            Map<String, String> unfillable;
            Set<String> fallback = new TreeSet<>();
            if (target == null) {
                prices = paper.openPrices(e.getKey(), symbols);
                unfillable = paper.openUnfillable(e.getKey(), symbols);
            } else {
                prices = new TreeMap<>();
                unfillable = new TreeMap<>();
                timedPrices(e.getKey(), target, symbols, prices, unfillable, fallback);
            }
            Instant at = target != null ? target : hours.open();
            int written = store.lockAccount(CODE, acc -> acc == null || !acc.active() ? 0
                    : record(e.getKey(), at, prices, unfillable, fallback, target != null));
            if (written > 0) {
                log.info("ISA 계좌 자동 기록 — 세션 {} · {}건", e.getKey(), written);
            }
        }
    }

    /** 그 세션 지시들의 시각 맞추기 시각(근거 {@value #DETAIL_TARGET_AT}, 가장 이른 것) — 없으면 null(예전 시가 지시). */
    static Instant targetAt(List<Instruction> instructions) {
        Instant out = null;
        for (Instruction i : instructions) {
            Instant at = targetAt(i);
            if (at != null && (out == null || at.isBefore(out))) {
                out = at;
            }
        }
        return out;
    }

    /** 지시 하나의 시각 맞추기 시각(근거 {@value #DETAIL_TARGET_AT}) — 없거나 읽지 못하면 null. */
    static Instant targetAt(Instruction instruction) {
        String text = instruction.reason() == null ? null : instruction.reason().path(DETAIL_TARGET_AT).asString(null);
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * 시각 맞추기 지시의 자동 기록 가격(ADR 0033 초안 결정 7) — 그 시각의 1분봉 사다리({@link PaperMirrorService#pricesAt}), 그날 1분봉이 없거나 T 뒤
     * 거래가 없으면 다시 오지 않음(halted), 그 시각의 창이 아예 없는 종목(그 시각 규칙 계좌 주문이 없던 종목 — 수집기가 받지 않음)은 밤 관측치의 그
     * 세션 시가로 어림(그 세션 시가도 다시 오지 않으면 halted). 그 밖은 기다림(결과에 없음).
     */
    private void timedPrices(LocalDate session, Instant target, Set<String> symbols, Map<String, BigDecimal> prices,
                             Map<String, String> unfillable, Set<String> fallback) {
        Map<String, PaperMirrorService.LadderPrice> ladder = paper.pricesAt(session, target.atZone(Kst.ZONE).toLocalTime(), symbols);
        Set<String> noWindow = new TreeSet<>();
        ladder.forEach((symbol, price) -> {
            if (price.price() != null && price.price().signum() > 0) {
                prices.put(symbol, price.price());
            } else if (price.unfillable()) {
                unfillable.put(symbol, AUTO_HALTED);
            } else if (price.noWindow()) {
                noWindow.add(symbol);
            }
        });
        if (noWindow.isEmpty()) {
            return;
        }
        Map<String, BigDecimal> opens = paper.openPrices(session, noWindow);
        Map<String, String> openUnfillable = paper.openUnfillable(session, noWindow);
        for (String symbol : noWindow) {
            BigDecimal open = opens.get(symbol);
            if (open != null && open.signum() > 0) {
                prices.put(symbol, open);
                fallback.add(symbol);
            } else if (openUnfillable.containsKey(symbol)) {
                unfillable.put(symbol, openUnfillable.get(symbol));
            }
        }
    }

    /** 잠금 안 — 그 세션의 묶인 행 없는 PLANNED 지시를 모두 SKIPPED로(장부에 쓰지 않음). 묶인 행이 있으면 RECORDED(사용자 입력 우선). 바꾼 지시 수. */
    private int skipAll(LocalDate session, String autoNote) {
        int changed = 0;
        for (Instruction i : store.instructions(CODE, session)) {
            if (!i.planned()) {
                continue;
            }
            boolean linked = !store.ledgerForInstruction(i.id()).isEmpty();
            if (store.updateInstructionStatus(i.id(), linked ? ManualAccountStore.STATUS_RECORDED : ManualAccountStore.STATUS_SKIPPED,
                    ManualAccountStore.STATUS_PLANNED, linked ? Map.of("recordedBy", "USER") : Map.of("skippedBy", "AUTO", "autoNote", autoNote))) {
                changed++;
            }
        }
        if (changed > 0) {
            store.bumpVersion(CODE);
        }
        return changed;
    }

    /**
     * 잠금 안 — 그 세션의 PLANNED 지시를 다시 읽어 가격이 있는 것만 적고, 가격이 다시 오지 않을 종목은 SKIPPED로 둡니다(클래스 설명 1). {@code open}은
     * 장부 시각(시가 지시는 개장, 시각 맞추기 지시는 그 시각), {@code fallback}은 시각 맞추기 지시인데 시가로 어림한 종목, {@code timed}는 시각 맞추기
     * 지시인가(메모 글). 바꾼 지시 수.
     */
    private int record(LocalDate session, Instant open, Map<String, BigDecimal> opens, Map<String, String> unfillable, Set<String> fallback,
                       boolean timed) {
        List<Instruction> planned = store.instructions(CODE, session).stream().filter(Instruction::planned).toList();
        List<Entry> entries = new ArrayList<>(store.ledger(CODE).stream().map(Entry::of).toList());
        int changed = 0;
        boolean sellWaiting = false;
        for (Instruction i : planned) {
            // 매수는 시가를 '기다리는' 매도에만 묶임 — 시가가 다시 오지 않을 매도(정지)는 건너뛰므로 매수를 막지 않음
            if (ManualAccountStore.SIDE_SELL.equals(i.side()) && !opens.containsKey(i.symbol()) && !unfillable.containsKey(i.symbol())
                    && store.ledgerForInstruction(i.id()).isEmpty()) {
                sellWaiting = true;
            }
        }
        for (Instruction i : planned) {
            if (!store.ledgerForInstruction(i.id()).isEmpty()) {
                // 사용자가 먼저 그 지시에 묶어 넣음 — 자동 기록보다 우선
                if (store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED,
                        Map.of("recordedBy", "USER"))) {
                    changed++;
                }
                continue;
            }
            BigDecimal price = opens.get(i.symbol());
            boolean sell = ManualAccountStore.SIDE_SELL.equals(i.side());
            if ((price == null || price.signum() <= 0) && unfillable.containsKey(i.symbol())) {
                store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                        Map.of("skippedBy", "AUTO", "autoNote", unfillable.get(i.symbol())));
                changed++;
                continue;
            }
            if (price == null || price.signum() <= 0 || (!sell && sellWaiting)) {
                continue;
            }
            BigDecimal wanted = BigDecimal.valueOf(i.quantity());
            BigDecimal max = sell
                    ? ManualAccountLedger.minHoldingFrom(entries, i.symbol(), open, ManualAccountStore.KIND_SELL).setScale(0, RoundingMode.FLOOR)
                    : affordable(ManualAccountLedger.minCashFrom(entries, open, ManualAccountStore.KIND_BUY), price);
            BigDecimal quantity = wanted.min(max.max(BigDecimal.ZERO));
            if (quantity.signum() <= 0) {
                store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                        Map.of("skippedBy", "AUTO", "autoNote", sell ? "no-holding" : "no-cash"));
                changed++;
                continue;
            }
            boolean reduced = quantity.compareTo(wanted) < 0;
            boolean openFallback = fallback.contains(i.symbol());
            String clock = ManualAccountNotices.hhmm(open.atZone(Kst.ZONE).toLocalTime());
            String note = (!timed ? "지시대로 자동 기록(규칙 계좌와 같은 시가, 수수료·세금 0 어림)"
                    : openFallback ? "지시대로 자동 기록 — " + clock + " 1분봉이 없어 그 세션 시가로 어림(수수료·세금 0 어림)"
                    : "지시대로 자동 기록(규칙 계좌와 같은 " + clock + " 1분봉 값, 수수료·세금 0 어림)")
                    + (reduced ? " — " + (sell ? "보유" : "현금") + "가 모자라 " + quantity.toPlainString() + "주로 줄임" : "");
            LedgerValues v = new LedgerValues(open, i.side(), i.symbol(), quantity, price, null, BigDecimal.ZERO, BigDecimal.ZERO, i.id(),
                    ManualAccountStore.SOURCE_AUTO, note);
            long id = store.insertLedger(CODE, v);
            entries.add(new Entry(id, v.at(), v.kind(), v.symbol(), v.quantity(), v.price(), null, BigDecimal.ZERO, BigDecimal.ZERO));
            Map<String, Object> patch = new LinkedHashMap<>();
            patch.put("recordedBy", "AUTO");
            if (reduced) {
                patch.put("autoNote", sell ? "reduced-holding" : "reduced-cash");
            } else if (openFallback) {
                patch.put("autoNote", AUTO_OPEN_FALLBACK);
            }
            store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED, patch);
            changed++;
        }
        if (changed > 0) {
            store.bumpVersion(CODE);
        }
        return changed;
    }

    private static BigDecimal affordable(BigDecimal cash, BigDecimal price) {
        return cash.signum() <= 0 ? BigDecimal.ZERO : cash.divide(price, 0, RoundingMode.FLOOR);
    }

    // ------------------------------------------------------------------ 못 만듦
    void markUnavailable(Account account, Instant now) {
        SessionHours last = ManualAccountCalendar.lastOpened(paper, now);
        if (last == null || account.startedAt() == null || !account.startedAt().isBefore(last.open())) {
            return;
        }
        if (store.session(CODE, last.date()).isPresent()) {
            return;
        }
        Waiting w = waiting;
        String reason = w != null && last.date().equals(w.session()) ? w.reason() : WAIT_UNKNOWN;
        ObjectNode detail = mapper.createObjectNode();
        detail.put("reason", reason);
        detail.putArray("notes").add(last.date() + " 시가 전에 지시를 만들지 못했습니다 — " + reasonLabel(reason));
        if (store.insertSession(CODE, last.date(), ManualAccountStore.SESSION_UNAVAILABLE, null, detail)) {
            log.warn("ISA 계좌 지시 못 만듦 — 세션 {} · 사유 {}", last.date(), reason);
        }
    }

    // ------------------------------------------------------------------ 지시 만들기(§2)
    void plan(Instant now) {
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        if (next == null) {
            waitFor(null, WAIT_CALENDAR, now);
            return;
        }
        LocalDate session = next.date();
        if (store.session(CODE, session).isPresent()) {
            waiting = null;
            return;
        }
        LocalDate decisionDate = ManualAccountCalendar.previousTradingDay(paper, session);
        if (decisionDate == null) {
            waitFor(session, WAIT_CALENDAR, now);
            return;
        }
        if (store.plannedBefore(CODE, session) || store.plannedStopInstructions(CODE).stream()
                .anyMatch(s -> s.notifiedAt() != null && s.session().isBefore(session))) {
            waitFor(session, WAIT_RECORD, now);   // 알린 스탑 지시도 적혀야 함 — 같은 종목을 '책에 없는 보유'로 다시 팔라고 하지 않게
            return;
        }
        Optional<BookInfo> book = paper.book(SOURCE_BOOK);
        if (book.isEmpty() || BOOK_NOT_STARTED.equals(book.get().status()) || !"KR".equals(book.get().market())) {
            waitFor(session, WAIT_BOOK, now);
            return;
        }
        DecisionState decision = paper.decisionState(SOURCE_BOOK, decisionDate).orElse(null);
        if (decision == null) {
            waitFor(session, WAIT_BOOK, now);
            return;
        }
        boolean finalDecision = (decision.status() != null && FINAL_STATUSES.contains(decision.status()))
                || (decision.deadline() != null && !now.isBefore(decision.deadline()));
        if (!finalDecision) {
            waitFor(session, WAIT_DECISION, now);
            return;
        }
        if (!paper.ledgerCaughtUp(SOURCE_BOOK, session)) {
            waitFor(session, WAIT_LEDGER, now);
            return;
        }
        Instant until = next.close() != null ? next.close() : Instant.MAX;
        // 시각 맞추기 날(ADR 0033 초안 결정 7) — 규칙 계좌가 개장 10분 뒤 지정 시각으로 체결하면 그 시각까지의 모의 주문을 반영한 목표로 '그 시각 이후
        // 시장가' 지시. 아니면 예전 시가 목표.
        Instant syncAt = paper.dailySyncAt(SOURCE_BOOK, session).orElse(null);
        OpenTargets targets = (syncAt != null ? paper.targetsAt(SOURCE_BOOK, session, syncAt) : paper.openTargets(SOURCE_BOOK, session))
                .orElse(null);
        Set<Long> covered = new java.util.HashSet<>();
        if (targets != null) {
            covered.addAll(targets.absorbedOrderIds());
            covered.addAll(targets.stopOrderIds());
        }
        boolean timed = paper.dueOrders(SOURCE_BOOK, session, until).stream().anyMatch(o -> !o.stop() && !covered.contains(o.orderId()));
        if (timed) {
            // 그 결정의 주문이 지시 시각 밖 시점에 체결됨 — 목표가 그 결정을 담지 못함. STOP 매도는 스탑 지시가 따로 맡음(ADR 0033 초안 결정 7).
            waitFor(session, WAIT_TIMED, now);
            return;
        }
        if (targets == null || !targets.complete()) {
            waitFor(session, WAIT_TARGETS, now);
            return;
        }
        Set<String> cashLike = new TreeSet<>(paper.cashLikeTickers());
        String outcome = store.lockAccount(CODE, acc -> {
            if (acc == null || !acc.active() || store.session(CODE, session).isPresent()) {
                return "skip";
            }
            State state = ManualAccountLedger.replay(store.ledger(CODE).stream().map(Entry::of).toList());
            Map<String, BigDecimal> held = new TreeMap<>();
            state.holdings().forEach((symbol, h) -> {
                if (h.quantity().signum() > 0) {
                    held.put(symbol, h.quantity());
                }
            });
            Set<String> outside = new TreeSet<>(held.keySet());
            outside.removeAll(targets.price().keySet());
            Map<String, BigDecimal> last = outside.isEmpty() ? Map.of() : paper.lastPrices(outside);
            List<String> missing = new ArrayList<>();
            Optional<Result> result = ManualAccountPlanner.plan(state.cash(), held, targets.weightPct(), targets.price(), last, cashLike,
                    missing);
            if (result.isEmpty()) {
                return WAIT_PRICE;
            }
            write(session, decision, result.get(), session.equals(acc.recalcSession()), syncAt, targets.stopOrderIds());
            return result.get().drafts().isEmpty() ? ManualAccountStore.SESSION_NONE : ManualAccountStore.SESSION_PLANNED;
        });
        if (WAIT_PRICE.equals(outcome)) {
            waitFor(session, WAIT_PRICE, now);
            return;
        }
        waiting = null;
        if (!"skip".equals(outcome)) {
            log.info("ISA 계좌 지시 — 세션 {} · {}", session, outcome);
        }
    }

    /**
     * 잠금 안 — 세션 행과 지시 행을 씁니다. {@code recalculated}면 장부 고침이 지운 세션을 다시 만든 것(표시를 남기고 계좌의 표시를 지움). {@code syncAt}이
     * 있으면 시각 맞추기 지시(세션 기록·지시 근거에 {@value #DETAIL_TARGET_AT}, 목표에 반영한 STOP 주문 번호 {@value #DETAIL_COVERED_STOPS}).
     */
    private void write(LocalDate session, DecisionState decision, Result result, boolean recalculated, Instant syncAt,
                       List<Long> coveredStops) {
        ObjectNode detail = mapper.createObjectNode();
        if (recalculated) {
            detail.put(DETAIL_RECALCULATED, true);
        }
        if (syncAt != null) {
            detail.put(DETAIL_TARGET_AT, syncAt.toString());
            ArrayNode covered = detail.putArray(DETAIL_COVERED_STOPS);
            coveredStops.forEach(covered::add);
        }
        detail.put("decisionDate", decision.date().toString());
        if (decision.decisionId() != null) {
            detail.put("decisionId", decision.decisionId());
        }
        detail.put("decisionStatus", decision.status());
        detail.put("equity", result.equity());
        detail.put("cash", result.cash());
        ArrayNode skipped = detail.putArray("skipped");
        Map<String, Integer> reasons = new TreeMap<>();
        for (Skip s : result.skipped()) {
            ObjectNode one = skipped.addObject();
            one.put("symbol", s.symbol());
            one.put("reason", s.reason());
            reasons.merge(s.reason(), 1, Integer::sum);
        }
        ArrayNode notes = detail.putArray("notes");
        reasons.forEach((reason, count) -> notes.add(skipNote(reason, count)));
        String state = result.drafts().isEmpty() ? ManualAccountStore.SESSION_NONE : ManualAccountStore.SESSION_PLANNED;
        if (!store.insertSession(CODE, session, state, decision.decisionId(), detail)) {
            return;
        }
        for (Draft d : result.drafts()) {
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("decisionId", decision.decisionId());
            reason.put("decisionDate", decision.date().toString());
            reason.put("targetWeightPct", d.weightPct());
            reason.put("targetQuantity", d.targetQuantity());
            reason.put("held", d.held());
            reason.put("equity", result.equity());
            if (recalculated) {
                reason.put(DETAIL_RECALCULATED, true);
            }
            if (syncAt != null) {
                reason.put(DETAIL_TARGET_AT, syncAt.toString());
            }
            store.insertInstruction(CODE, new NewInstruction(session, d.symbol(), d.side(), d.quantity(), d.refPrice(), d.weightPct(),
                    mapper.valueToTree(reason)));
        }
        if (recalculated) {
            store.setRecalcSession(CODE, null);
        }
        store.bumpVersion(CODE);
    }

    private static String skipNote(String reason, int count) {
        return switch (reason) {
            case RealTradePlanner.SKIP_DEFERRED_CASH -> "현금이 모자라 매수를 줄이거나 뺀 종목 " + count + "개";
            case RealTradePlanner.SKIP_PRICE -> "가격을 몰라 뺀 종목 " + count + "개";
            case RealTradePlanner.SKIP_FRACTION -> "소수점 보유가 남은 종목 " + count + "개(정수 주만 지시)";
            default -> "건너뛴 종목 " + count + "개(" + reason + ")";
        };
    }

    private void waitFor(LocalDate session, String reason, Instant now) {
        waiting = new Waiting(session, reason, now);
    }

    // ------------------------------------------------------------------ 알림(§4)
    void notifyPending(Instant now) {
        if (!telegram.configured()) {
            return;
        }
        if (!notifyRecalculatedNone(now)) {
            return;
        }
        Map<LocalDate, List<Instruction>> bySession = new TreeMap<>();
        for (Instruction i : store.plannedInstructions(CODE)) {
            bySession.computeIfAbsent(i.session(), s -> new ArrayList<>()).add(i);
        }
        for (Map.Entry<LocalDate, List<Instruction>> e : bySession.entrySet()) {
            LocalDate session = e.getKey();
            SessionHours hours = ManualAccountCalendar.hours(paper, session);
            if (hours == null || hours.open() == null || hours.close() == null) {
                continue;
            }
            Instant morning = session.atTime(MORNING).atZone(Kst.ZONE).toInstant();
            Instant nightEnd = morning.isBefore(hours.open()) ? morning : hours.open();
            List<Instruction> night = e.getValue().stream().filter(i -> i.notifiedNightAt() == null).toList();
            List<Instruction> dawn = e.getValue().stream().filter(i -> i.notifiedMorningAt() == null).toList();
            boolean recalculated = e.getValue().stream().anyMatch(ManualAccountJob::recalculated);
            if (now.isBefore(nightEnd) && !night.isEmpty()) {
                if (!send(session, hours.open(), night, recalculated)) {
                    return;
                }
                store.markNotifiedNight(night.stream().map(Instruction::id).toList(), now);
            } else if (!now.isBefore(morning) && now.isBefore(hours.close()) && !dawn.isEmpty()) {
                if (!send(session, hours.open(), dawn, recalculated)) {
                    return;
                }
                store.markNotifiedMorning(dawn.stream().map(Instruction::id).toList(), now);
            }
        }
    }

    /**
     * 다시 계산했더니 지시가 없는(NONE) 다음 세션이면 개장 전까지 '할 매매가 없음' 한 통(앞서 보낸 지시를 내지 않게). 보냈거나 보낼 것이 없으면 true,
     * 보내기에 실패하면 false(다음 주기에 다시).
     */
    private boolean notifyRecalculatedNone(Instant now) {
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        if (next == null) {
            return true;
        }
        ManualAccountStore.SessionRow row = store.session(CODE, next.date()).orElse(null);
        if (row == null || !ManualAccountStore.SESSION_NONE.equals(row.state()) || row.detail() == null
                || !row.detail().path(DETAIL_RECALCULATED).asBoolean(false) || row.detail().has(DETAIL_RECALC_NOTICE_AT)) {
            return true;
        }
        if (!sendText(ManualAccountNotices.noTrades(next.date()))) {
            return false;
        }
        store.patchSessionDetail(CODE, next.date(), Map.of(DETAIL_RECALC_NOTICE_AT, now.toString()));
        return true;
    }

    private static boolean recalculated(Instruction i) {
        return i.reason() != null && i.reason().path(DETAIL_RECALCULATED).asBoolean(false);
    }

    private boolean send(LocalDate session, Instant open, List<Instruction> items, boolean recalculated) {
        Set<String> symbols = new TreeSet<>();
        items.forEach(i -> symbols.add(i.symbol()));
        Map<String, String> names = new HashMap<>(paper.names(symbols));
        Instant target = targetAt(items);
        return sendText(ManualAccountNotices.text(session, ManualAccountNotices.wallClock(open), ManualAccountNotices.wallClock(target), items,
                names, recalculated));
    }

    private boolean sendText(String text) {
        String error = telegram.send(text);
        if (error != null) {
            log.warn("ISA 계좌 알림 실패 — 다음 주기에 다시");
            return false;
        }
        return true;
    }
}
