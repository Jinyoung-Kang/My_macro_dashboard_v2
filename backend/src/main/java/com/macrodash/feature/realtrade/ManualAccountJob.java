package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.DecisionState;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.ManualAccountPlanner.Draft;
import com.macrodash.feature.realtrade.ManualAccountPlanner.Result;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Account;
import com.macrodash.store.ManualAccountStore.Balance;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.NewInstruction;
import com.macrodash.store.ManualAccountStore.NewStopInstruction;
import com.macrodash.store.ManualAccountStore.Position;
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
 *   <li><b>만료</b>: 세션 마감이 지난 PLANNED 지시·알린 스탑 지시는 SKIPPED({@value #AUTO_EXPIRED}) — 확인을 누르지 않은 지시는 잔고에 쓰지 않습니다. 지시를 만든 뒤 그 세션이 거래일이
 *       아니게 되면 그 세션 PLANNED 지시는 SKIPPED({@value #AUTO_NOT_TRADING}).</li>
 *   <li><b>못 만듦</b>: 마지막으로 개장한 세션에 지시가 없으면(시작 뒤 세션만) 그 세션을 UNAVAILABLE로 남깁니다.</li>
 *   <li><b>지시 만들기</b>: 다음 세션 E(개장 전)의 지시가 아직 없고, 규칙 계좌의 D(E 전 거래일) 정기 결정이 최종(OK·NO_TRADE·SKIPPED 또는 기한 지남)이고, 규칙 계좌 장부가 D까지
 *       반영했고({@link PaperMirrorService#ledgerCaughtUp}), 시가 목표가 완전할 때({@link OpenTargets#complete}) {@link ManualAccountPlanner}로 계산해 세션 행과 지시 행을 한
 *       트랜잭션으로 씁니다(입력은 지금 잔고 — 현금·보유). 지시가 없으면 NONE(알리지 않음). 규칙 계좌가 개장 10분 뒤 지정 시각으로 체결하는 날({@link PaperMirrorService#dailySyncAt} —
 *       ADR 0033 결정 7)은 그 시각까지의 모의 주문을 반영한 목표로 '그 시각 이후 시장가' 지시를 만듭니다. 그 목표에 들지 않는 시가 밖 시점 대기 주문(STOP 매도 제외 — 스탑 지시가 따로
 *       맡음)이 있으면 만들지 않습니다(사유 {@code timed-orders}). 잔고 현금이 음수이면 만들지 않고 기다립니다(사유 {@value #WAIT_CASH} — QA-381, ADR 0034 결정 5 개정:
 *       음수만큼 줄어든 평가액으로 책 종목을 팔라고 하지 않음. 잔고를 고치면 다음 주기에 만듦, 장중 스탑 지시는 현금과 무관해 그대로).</li>
 *   <li><b>알림</b>: 개장 전 08:00(그 전에 개장하면 개장 때) PLANNED 지시를 한 통. 텔레그램이 설정되지 않았거나 실패하면 다음 주기에 다시. 글은 종목 코드·이름·수량만.
 *       현금이 음수라 지시를 만들지 않은 세션은 같은 08:00부터 개장 전까지 '매매 지시 없음' 글을 세션마다 한 통({@link #notifyCashNegative} — 금액 없음).</li>
 * </ol>
 *
 * <p><b>장 중반·마감 30분 전 확인 알림</b>(ADR 0034 — {@link #reminders}): 30초 주기마다, 그 세션 정규장 절반((개장 + 마감) / 2)과 마감 30분 전에 오늘 PLANNED 지시와 스탑 지시를
 * 종류별 시각 칸으로 각각 한 번 다시 알립니다(없으면 보내지 않음). ISA는 증권사와 연결되지 않아 실제 매매를 볼 수 없으므로 '확인' 버튼이 유일한 신호입니다.
 *
 * <p><b>장중 스탑 지시</b>(ADR 0033 결정 7 — V28 {@code manual_stop_instructions}): {@code dashboard.manual.stop-interval-ms}(30초)마다 규칙 계좌의 오늘 STOP 매도 대기 주문({@link
 * PaperMirrorService#dueOrders} — 장중 감시·밤 대체, 지금 + 5분 안의 것)마다 그 주문이 그날 지시 목표에 반영된 것(세션 기록 {@value #DETAIL_COVERED_STOPS})이 아니면 스탑 지시 하나(모의
 * 주문 하나에 하나 — UNIQUE)를 씁니다. 수량은 잔고 보유 + 그 세션 이하의 미확인 지시(PLANNED) 증감 가운데 지시 시각이 지난 것의 정수 부분이고, 1주도 없으면 쓰지 않습니다. 알리지 않은 스탑
 * 지시는 바로 한 통으로 알리고(종목 코드·이름·수량만 — 종가 STOP은 '종가 단일가 시장가' 글), 그 세션 마감까지 못 알리면 SKIPPED({@value #AUTO_NOT_NOTIFIED}).
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
    /** 지시를 잔고에 쓰지 않고 닫은 사유(근거의 autoNote). */
    static final String AUTO_EXPIRED = "expired";
    static final String AUTO_NOT_TRADING = "not-trading";
    static final String AUTO_NO_HOLDING = "no-holding";
    static final String AUTO_RESTART = "restart";
    /**
     * 지시 근거·세션 계산 기록의 키 — 그 지시를 낼 시각(시각 맞추기 날 — 따라 하는 책의 일일 맞추기 시각, ISO). 없으면 예전 시가 지시. 세션 기록에는 그 지시 목표에 반영한 시각 지정 STOP 주문 번호({@value #DETAIL_COVERED_STOPS} — 스탑 지시를 따로 내지 않음)도 남깁니다.
     */
    static final String DETAIL_TARGET_AT = "targetAt";
    static final String DETAIL_COVERED_STOPS = "coveredStopOrderIds";
    /** 스탑 지시를 만들 모의 STOP 주문 — 따라 할 시각이 지금 + 이 안(종가 STOP은 종가 단일가 시작 5분 전부터 알림). */
    static final Duration STOP_LOOKAHEAD = Duration.ofMinutes(5);
    /** 스탑 지시를 적지 않고 건너뛴 사유(근거의 autoNote) — 그 세션 마감까지 알리지 못함. */
    static final String AUTO_NOT_NOTIFIED = "not-notified";
    /** 스탑 지시를 찾는 KST 시각 범위(정규장 — 장 시간 변경일 10:00~16:30 포함, 그 안에서 그날 달력의 개장~마감만). */
    static final LocalTime STOP_SCAN_FROM = LocalTime.of(8, 30);
    static final LocalTime STOP_SCAN_UNTIL = LocalTime.of(17, 0);
    /** 스탑 지시가 받는 모의 주문 시점(V28 CHECK — 시가 STOP은 다음 시가 지시에 들어감). */
    static final Set<String> STOP_TIMINGS = Set.of("MARKET", "AT_MINUTE", "NEXT_CLOSE");
    /** 모의 책 상태 — 시작 전(따라 하지 않음). */
    static final String BOOK_NOT_STARTED = "NOT_STARTED";

    // ------------------------------------------------------------------ 지시를 아직 만들지 않은 사유(화면 메모·못 만듦 기록)
    static final String WAIT_CALENDAR = "calendar-unknown";
    static final String WAIT_BOOK = "book-not-started";
    static final String WAIT_DECISION = "decision-pending";
    static final String WAIT_LEDGER = "ledger-behind";
    static final String WAIT_TARGETS = "targets-unavailable";
    static final String WAIT_PRICE = "price-missing";
    static final String WAIT_UNKNOWN = "not-planned";
    static final String WAIT_TIMED = "timed-orders";
    /** 잔고 현금이 음수 — 매매 지시를 만들지 않음(QA-381). */
    static final String WAIT_CASH = "cash-negative";

    private static final Map<String, String> REASON_LABEL = Map.of(
            WAIT_CALENDAR, "달력을 모름",
            WAIT_BOOK, "규칙 계좌가 시작 전",
            WAIT_DECISION, "규칙 계좌 결정 대기",
            WAIT_LEDGER, "규칙 계좌 장부 반영 대기",
            WAIT_TARGETS, "규칙 계좌 시가 목표를 아직 계산할 수 없음(가격 모름·불완전)",
            WAIT_PRICE, "ISA 보유 종목의 가격을 모름",
            WAIT_CASH, "ISA 잔고의 현금이 음수라 매매 지시를 만들지 않음(잔고를 고치면 다음 주기부터 만듦)",
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
    /** 위 네 단계(만료·못 만듦·지시·알림)를 마지막으로 돈 시각 — 스탑 주기 사이에는 {@code interval-ms}가 지났을 때만. */
    private Instant lastFullAt;
    /** '현금이 음수라 지시 없음' 글을 보낸 마지막 세션(메모리 — 재기동하면 그 세션에 한 번 더 갈 수 있음, 표에 둘 칸이 없음). */
    private LocalDate cashNoticeSession;

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
    /** 시작한(잔고 행이 있는) ACTIVE 계좌면 그 계좌, 아니면 null. */
    private Account activeStarted() {
        Account account = store.account(CODE).orElse(null);
        if (account == null || !account.active() || store.balance(CODE).isEmpty()) {
            return null;
        }
        return account;
    }

    /** 한 주기(클래스 설명) — 시험이 시각을 정해 부릅니다. 앞 주기가 도는 중이면 건너뜁니다. */
    void cycle(Instant now) {
        if (!store.ready() || !running.tryLock()) {
            return;
        }
        try {
            Account account = activeStarted();
            if (account == null) {
                waiting = null;
                return;
            }
            Balance balance = store.balance(CODE).orElseThrow();
            expire(now);
            markUnavailable(balance, now);
            plan(now);
            notifyPending(now);
            notifyCashNegative(now);
            stopScan(balance, now);
            stopNotify(now);
            reminders(now);
        } finally {
            running.unlock();
        }
    }

    /** 스탑 지시와 장 중반·마감 30분 전 확인 알림만(30초 주기 — 클래스 설명) — 앞 주기가 도는 중이면 건너뜁니다. */
    void stopCycle(Instant now) {
        if (!store.ready() || !running.tryLock()) {
            return;
        }
        try {
            if (activeStarted() == null) {
                return;
            }
            stopScan(store.balance(CODE).orElseThrow(), now);
            stopNotify(now);
            reminders(now);
        } finally {
            running.unlock();
        }
    }

    // ------------------------------------------------------------------ 만료
    /** 세션 마감이 지난 PLANNED 지시·알린 스탑 지시를 SKIPPED로(클래스 설명 1) — 확인을 누르지 않은 지시는 잔고에 쓰지 않습니다. */
    void expire(Instant now) {
        Map<LocalDate, List<Instruction>> bySession = new TreeMap<>();
        for (Instruction i : store.plannedInstructions(CODE)) {
            bySession.computeIfAbsent(i.session(), s -> new ArrayList<>()).add(i);
        }
        for (Map.Entry<LocalDate, List<Instruction>> e : bySession.entrySet()) {
            Optional<SessionHours> day = paper.sessionHours(e.getKey());
            if (day.isEmpty()) {
                continue;
            }
            String note = !day.get().tradingDay() ? AUTO_NOT_TRADING
                    : day.get().close() != null && !now.isBefore(day.get().close()) ? AUTO_EXPIRED : null;
            if (note == null) {
                continue;
            }
            int changed = store.lockAccount(CODE, acc -> {
                int n = 0;
                for (Instruction i : e.getValue()) {
                    if (store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                            Map.of("skippedBy", "AUTO", "autoNote", note))) {
                        n++;
                    }
                }
                if (n > 0) {
                    store.bumpVersion(CODE);
                }
                return n;
            });
            if (changed > 0) {
                log.info("ISA 계좌 지시 닫음 — 세션 {} · {}건 · {}", e.getKey(), changed, note);
            }
        }
        for (StopInstruction s : store.plannedStopInstructions(CODE)) {
            if (s.notifiedAt() == null) {
                continue;   // 알리지 못한 스탑 지시는 stopNotify가 not-notified로 닫음
            }
            SessionHours hours = paper.sessionHours(s.session()).orElse(null);
            if (hours == null || hours.close() == null || now.isBefore(hours.close())) {
                continue;
            }
            store.lockAccount(CODE, acc -> {
                if (store.updateStopInstructionStatus(s.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                        Map.of("skippedBy", "AUTO", "autoNote", AUTO_EXPIRED))) {
                    store.bumpVersion(CODE);
                }
                return null;
            });
        }
    }

    // ------------------------------------------------------------------ 장 중반·마감 30분 전 확인 알림(ADR 0034)
    /** 사용자가 확인(잔고 반영)한 지시인가(근거 {@code recordedBy}). */
    static boolean recordedByUser(Instruction i) {
        return i.reason() != null && "USER".equals(i.reason().path("recordedBy").asString(""));
    }

    /** 마감 전 알림 — 마감 이만큼 전(보통 15:00, 장 시간 변경일은 그날 기준). */
    static final Duration PRECLOSE = Duration.ofMinutes(30);

    /**
     * 장 중반(그 세션 정규장 절반)·마감 30분 전 확인 알림(클래스 설명) — 그날 PLANNED 지시와 알린 스탑 지시 가운데 그 칸의 시각이 아직 없는 것을 한 통으로 보냅니다. 스탑 지시는 그 알림
     * 시각 전에 이미 즉시 알린 것만(방금 즉시 알림을 받은 스탑을 바로 또 알리지 않게). 텔레그램이 설정되지 않았거나 실패하면 다음 주기에 다시, 장 중반 알림은 마감 30분 전까지, 마감 뒤에는 보내지 않습니다.
     */
    void reminders(Instant now) {
        LocalTime clockTime = now.atZone(Kst.ZONE).toLocalTime();
        if (clockTime.isBefore(STOP_SCAN_FROM) || clockTime.isAfter(STOP_SCAN_UNTIL)) {
            return;   // 정규장(장 시간 변경일 포함) 밖 — 30초마다 읽지 않게
        }
        LocalDate today = now.atZone(Kst.ZONE).toLocalDate();
        List<Instruction> daily = store.instructions(CODE, today).stream().filter(Instruction::planned).toList();
        List<StopInstruction> stops = store.stopInstructions(CODE, today).stream().filter(StopInstruction::planned).filter(s -> s.notifiedAt() != null).toList();
        if ((daily.isEmpty() && stops.isEmpty()) || !telegram.configured()) {
            return;
        }
        SessionHours hours = ManualAccountCalendar.hours(paper, today);
        if (hours == null || !hours.tradingDay() || hours.open() == null || hours.close() == null) {
            return;
        }
        Instant midday = hours.open().plus(Duration.between(hours.open(), hours.close()).dividedBy(2));
        Instant preclose = hours.close().minus(PRECLOSE);
        if (now.isBefore(midday) || !now.isBefore(hours.close())) {
            return;
        }
        boolean late = !now.isBefore(preclose);
        Instant slot = late ? preclose : midday;
        List<Instruction> dailyDue = daily.stream().filter(i -> (late ? i.notifiedPrecloseAt() : i.notifiedMiddayAt()) == null).toList();
        List<StopInstruction> stopsDue = stops.stream().filter(s -> (late ? s.notifiedPrecloseAt() : s.notifiedMiddayAt()) == null && s.notifiedAt().isBefore(slot)).toList();
        if (dailyDue.isEmpty() && stopsDue.isEmpty()) {
            return;
        }
        List<ManualAccountNotices.ReminderLine> lines = new ArrayList<>();
        Set<String> symbols = new TreeSet<>();
        dailyDue.forEach(i -> {
            lines.add(new ManualAccountNotices.ReminderLine(i.side(), i.symbol(), i.quantity()));
            symbols.add(i.symbol());
        });
        stopsDue.forEach(s -> {
            lines.add(new ManualAccountNotices.ReminderLine(s.side(), s.symbol(), s.quantity()));
            symbols.add(s.symbol());
        });
        String text = ManualAccountNotices.reminder(today, late, lines, new HashMap<>(paper.names(symbols)));
        if (text == null || !sendText(text)) {
            return;
        }
        List<Long> dailyIds = dailyDue.stream().map(Instruction::id).toList();
        List<Long> stopIds = stopsDue.stream().map(StopInstruction::id).toList();
        if (late) {
            store.markNotifiedPreclose(dailyIds, now);
            store.markStopPreclose(stopIds, now);
        } else {
            store.markNotifiedMidday(dailyIds, now);
            store.markStopMidday(stopIds, now);
        }
        log.info("ISA 계좌 확인 알림 — 세션 {} · {} · {}건", today, late ? "마감 전" : "장 중반", dailyIds.size() + stopIds.size());
    }

    // ------------------------------------------------------------------ 장중 스탑 지시(ADR 0033 결정 7)
    /**
     * 오늘 규칙 계좌 STOP 매도 대기 주문마다 스탑 지시 하나(클래스 설명) — 거래일 정규장(개장 ~ 마감) 안이고 계좌가 그 전에 시작했을 때만. 그날 지시 목표에
     * 반영한 STOP(세션 기록 {@value #DETAIL_COVERED_STOPS})은 지시가 이미 팔게 하므로 쓰지 않습니다. 만든 지시 수.
     */
    int stopScan(Balance balance, Instant now) {
        LocalTime clockTime = now.atZone(Kst.ZONE).toLocalTime();
        if (clockTime.isBefore(STOP_SCAN_FROM) || clockTime.isAfter(STOP_SCAN_UNTIL)) {
            return 0;   // 정규장(장 시간 변경일 포함) 밖 — 30초마다 모의 달력을 열지 않게
        }
        LocalDate today = now.atZone(Kst.ZONE).toLocalDate();
        SessionHours hours = ManualAccountCalendar.hours(paper, today);
        if (hours == null || !hours.tradingDay() || hours.open() == null || hours.close() == null || now.isBefore(hours.open())
                || now.isAfter(hours.close()) || now.isBefore(balance.startedAt())) {
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

    /**
     * 잠금 안 — 그 종목의 잔고 보유 + 그 세션 이하의 미확인 지시(PLANNED) 가운데 지시 시각(없으면 그 지시 세션의 개장)이 지난 것의 증감, 정수 부분(클래스 설명).
     */
    private int stopQuantity(LocalDate session, String symbol, Instant now) {
        BigDecimal held = store.position(CODE, symbol).map(Position::quantity).orElse(BigDecimal.ZERO);
        Map<LocalDate, SessionHours> hoursBySession = new HashMap<>();
        for (Instruction i : store.plannedInstructions(CODE)) {
            if (i.session().isAfter(session) || !symbol.equals(i.symbol())) {
                continue;
            }
            SessionHours hours = hoursBySession.computeIfAbsent(i.session(), d -> ManualAccountCalendar.hours(paper, d));
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

    // ------------------------------------------------------------------ 못 만듦
    void markUnavailable(Balance balance, Instant now) {
        SessionHours last = ManualAccountCalendar.lastOpened(paper, now);
        if (last == null || !balance.startedAt().isBefore(last.open())) {
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
        // 시각 맞추기 날(ADR 0033 결정 7) — 규칙 계좌가 개장 10분 뒤 지정 시각으로 체결하면 그 시각까지의 모의 주문을 반영한 목표로 '그 시각 이후
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
            // 그 결정의 주문이 지시 시각 밖 시점에 체결됨 — 목표가 그 결정을 담지 못함. STOP 매도는 스탑 지시가 따로 맡음(ADR 0033 결정 7).
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
            Balance balance = store.balance(CODE).orElse(null);
            if (balance == null) {
                return "skip";
            }
            if (balance.cash().signum() < 0) {
                // QA-381 — 평가액 = 현금 + 보유라 음수만큼 목표가 줄어 책 종목까지 매도 지시가 나오고, 0 이하이면 전 종목 전량 매도가 됨. 만들지 않고 사유를 남김.
                return WAIT_CASH;
            }
            Map<String, BigDecimal> held = new TreeMap<>();
            store.positions(CODE).forEach(p -> held.put(p.symbol(), p.quantity()));
            Set<String> outside = new TreeSet<>(held.keySet());
            outside.removeAll(targets.price().keySet());
            Map<String, BigDecimal> last = outside.isEmpty() ? Map.of() : paper.lastPrices(outside);
            List<String> missing = new ArrayList<>();
            Optional<Result> result = ManualAccountPlanner.plan(balance.cash(), held, targets.weightPct(), targets.price(), last, cashLike,
                    missing);
            if (result.isEmpty()) {
                return WAIT_PRICE;
            }
            write(session, decision, result.get(), syncAt, targets.stopOrderIds());
            return result.get().drafts().isEmpty() ? ManualAccountStore.SESSION_NONE : ManualAccountStore.SESSION_PLANNED;
        });
        if (WAIT_PRICE.equals(outcome) || WAIT_CASH.equals(outcome)) {
            waitFor(session, outcome, now);
            return;
        }
        waiting = null;
        if (!"skip".equals(outcome)) {
            log.info("ISA 계좌 지시 — 세션 {} · {}", session, outcome);
        }
    }

    /**
     * 잠금 안 — 세션 행과 지시 행을 씁니다. {@code syncAt}이 있으면 시각 맞추기 지시(세션 기록·지시 근거에 {@value #DETAIL_TARGET_AT}, 목표에 반영한 STOP 주문 번호 {@value #DETAIL_COVERED_STOPS}).
     */
    private void write(LocalDate session, DecisionState decision, Result result, Instant syncAt, List<Long> coveredStops) {
        ObjectNode detail = mapper.createObjectNode();
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
            if (syncAt != null) {
                reason.put(DETAIL_TARGET_AT, syncAt.toString());
            }
            store.insertInstruction(CODE, new NewInstruction(session, d.symbol(), d.side(), d.quantity(), d.refPrice(), d.weightPct(),
                    mapper.valueToTree(reason)));
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

    // ------------------------------------------------------------------ 알림
    /** 개장 전 08:00 지시 알림(클래스 설명 4) — PLANNED 지시를 세션마다 한 통. 마감 뒤에는 보내지 않습니다. */
    void notifyPending(Instant now) {
        if (!telegram.configured()) {
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
            List<Instruction> due = e.getValue().stream().filter(i -> i.notifiedMorningAt() == null).toList();
            if (!now.isBefore(morning) && now.isBefore(hours.close()) && !due.isEmpty()) {
                if (!send(session, hours.open(), due)) {
                    return;
                }
                store.markNotifiedMorning(due.stream().map(Instruction::id).toList(), now);
            }
        }
    }

    /**
     * 현금이 음수라 다음 세션 지시를 만들지 않았을 때(이번 주기의 {@link #plan} — 사유 {@value #WAIT_CASH}) 그 세션 08:00부터 개장 전까지 '매매 지시 없음' 글을 세션마다 한 통
     * (QA-381). 알리지 않으면 '오늘은 매매할 것이 없음'(NONE — 알림 없음)과 구분되지 않아 틀린 잔고가 조용히 남습니다. 음수가 며칠 이어지면 거래일마다 한 통입니다.
     * 텔레그램이 설정되지 않았거나 실패하면 다음 주기에 다시. 글에 금액·평가액·종목이 없습니다.
     */
    void notifyCashNegative(Instant now) {
        Waiting w = waiting;
        if (w == null || w.session() == null || !WAIT_CASH.equals(w.reason()) || w.session().equals(cashNoticeSession) || !telegram.configured()) {
            return;
        }
        if (now.isBefore(w.session().atTime(MORNING).atZone(Kst.ZONE).toInstant())) {
            return;
        }
        if (sendText(ManualAccountNotices.cashNegative(w.session()))) {
            cashNoticeSession = w.session();
            log.info("ISA 계좌 지시 없음 알림 — 세션 {} · 사유 {}", w.session(), WAIT_CASH);
        }
    }

    private boolean send(LocalDate session, Instant open, List<Instruction> items) {
        Set<String> symbols = new TreeSet<>();
        items.forEach(i -> symbols.add(i.symbol()));
        Map<String, String> names = new HashMap<>(paper.names(symbols));
        Instant target = targetAt(items);
        return sendText(ManualAccountNotices.text(session, ManualAccountNotices.wallClock(open), ManualAccountNotices.wallClock(target), items, names));
    }

    private boolean sendText(String text) {
        String error = telegram.send(PaperTelegram.Channel.ACCOUNT, text);
        if (error != null) {
            log.warn("ISA 계좌 알림 실패 — 다음 주기에 다시");
            return false;
        }
        return true;
    }
}
