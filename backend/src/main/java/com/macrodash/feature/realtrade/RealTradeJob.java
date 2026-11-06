package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.Limits;
import com.macrodash.collector.CollectorTradeClient.Preflight;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.collector.CollectorTradeClient.Status;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.DueOrder;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.WeightAfter;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeExecutor.Result;
import com.macrodash.feature.realtrade.RealTradeExecutor.Send;
import com.macrodash.feature.realtrade.RealTradeExecutor.Sent;
import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Day;
import com.macrodash.feature.realtrade.RealTradePlanner.Order;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Position;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;
import com.macrodash.feature.realtrade.RealTradePlanner.Window;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Batch;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.Event;
import com.macrodash.store.RealTradeStore.OrderRow;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.BiFunction;

/**
 * 실제 매매 정기 작업(ADR 0028 — 명세 docs/specs/2026-11-06-real-trade-mirror.md §3·§7.3·§7.4) — <b>전용 단일 스레드</b>에서 {@code dashboard.realtrade.interval-ms}
 * (10초)마다 한 주기를 돕니다. 공유 정기 작업 풀(Claude 호출 등이 잡을 수 있음)과 따로라 창을 놓치지 않고, 전송이 한 스레드뿐이라 두 전송이 겹치지 않습니다.
 * 스프링 TaskScheduler 빈을 하나 더 두면 기본 스케줄러가 물러나 모든 정기 작업이 그 빈으로 옮겨 가므로, 이 작업만의 실행기를 직접 둡니다.
 * 백엔드 스위치({@code dashboard.realtrade.enabled}, 기본 꺼짐)나 스케줄러({@code dashboard.scheduler.enabled})가 꺼져 있으면 아무것도 하지 않습니다.
 *
 * <p>한 주기(명세 §7.3)
 * <ol>
 *   <li>남은 SENDING 정리 → 진행 중 주문 추적(상태와 무관하게 늘) → 결과 모름 재전송·대조(대조는 꺼짐에서도).</li>
 *   <li>끄는 중(STOPPING)·멈춤(HALTED)이면 이 기능의 미체결 취소만, 정리가 끝나면(그 주기의 대조가 토스 목록을 읽었을 때만) STOPPING → OFF. 꺼짐(OFF)에서도
 *       대조로 늦게 묶인 이 기능의 토스 주문은 취소.</li>
 *   <li>켜짐(LIVE)이 아니면 끝. 따라 하는 책이 운용 중이 아니거나 세대가 다르면 이상 멈춤. 옛 책·세대의 미체결은 취소.</li>
 *   <li>수집기 스위치(꺼졌다고 분명히 답하면 이상 멈춤, 읽지 못하면 그 주기만 건너뜀)·토큰 경합·같은 오류 반복 확인 → 오늘 토스 장 운영 정보·쉬는 날
 *       판정(그날 첫 창 3분 전에 한 번) → 창 3분 전 토큰 예열.</li>
 *   <li>창마다 새 사전 조회(매도 가능 수량은 팔 종목만 — 시가 맞추기류는 두 단계) + 오늘 주문 목록(수집기 하루 한도의 남은 몫) → 손실 한도(넘으면 매수만
 *       멈춤) → 계획({@link RealTradePlanner}) → 선점·SENDING·전송·결과({@link RealTradeExecutor}). 보내기 직전마다 지금 시각으로 그 창이 아직 열려 있는지
 *       다시 보고, 닫혔으면 보내지 않고 놓침으로 둡니다(RT3-MON-4). 창이 끝나면 창 요약 이벤트(접수·체결·놓침·건너뜀·막힘·미룸).</li>
 *   <li>알림 대기 이벤트를 텔레그램으로(건수·상태·사유 코드만 — {@link RealTradeNotices}). 못 보내면 다음 주기에 다시.</li>
 * </ol>
 *
 * <p>로그에는 상태·사유 코드·건수만 남깁니다(종목·수량·금액·토스 주문 번호 없음). 예상 못 한 예외·오류(Error 포함)는 클래스 이름만 남기고 다음 주기에
 * 다시 봅니다 — 던지면 전용 스케줄러가 뒤 주기를 모두 건너뛰어 끄기 뒤 취소·추적이 조용히 멈춥니다. 마지막으로 주기를 끝낸 시각과 정기 작업을 시작한
 * 시각은 상태 API가 보여 줍니다(시작 뒤 한 번도 주기를 끝내지 못해도 화면이 멈춤을 알아채게).
 */
@Component
class RealTradeJob {

    private static final Logger log = LoggerFactory.getLogger(RealTradeJob.class);

    static final String MARKET = RealTradeStore.MARKET_KR;
    /** 창 시작 이만큼 전에 토큰 예열·그날 쉬는 판정. */
    static final Duration WARMUP_LEAD = Duration.ofMinutes(3);
    static final Duration WARMUP_SPACING = Duration.ofMinutes(5);
    /** 사전 조회를 다시 하는 최소 간격(시가 맞추기 재시도·마무리) — 토스 호출 한도를 아낌. */
    static final Duration RETRY_SPACING = Duration.ofSeconds(30);
    static final Duration CALENDAR_RETRY = Duration.ofSeconds(60);
    /** 그날 토스 장 운영 정보를 받기 시작하는 시각(KST). */
    static final LocalTime CALENDAR_FROM = LocalTime.of(7, 30);
    /** 종가 요약은 정규장 끝 + 이만큼 뒤(종가 단일가 체결을 본 뒤). */
    static final Duration CLOSE_SUMMARY_DELAY = Duration.ofMinutes(3);
    static final long INITIAL_DELAY_MS = 15_000;
    static final long SHUTDOWN_WAIT_SECONDS = 60;
    static final int NOTIFY_PER_CYCLE = 5;
    static final int REPEATED_ERROR_LIMIT = 3;
    /** 상한가를 모르는 매수 행의 잡는 금액 — 기준가 × 1.3(국내 가격 제한 폭 30%). */
    static final BigDecimal UPPER_FALLBACK = new BigDecimal("1.3");

    static final String HALT_TURNOVER = "turnover";
    static final String HALT_BOOK_CHANGED = "book-changed";
    static final String HALT_BOOK_NOT_ACTIVE = "book-not-active";
    static final String HALT_TOKEN = "token-contention";
    static final String HALT_REPEATED = "repeated-error";
    /**
     * 켜짐인데 수집기가 매매 스위치가 꺼졌다고 분명히 답함(OPS-3 — 비상 끄기 3단계 등). 멈춰 두면 수집기 스위치를 다시 켜도 멈춤 해제(확인 글자 + 비밀번호)를
     * 거쳐야 주문이 나갑니다. 상태를 읽지 못한 것(연결 실패·시간 초과·수집기 안의 예외)과 한도 해석 실패는 멈추지 않고 그 주기만 건너뜁니다.
     */
    static final String HALT_COLLECTOR_DISABLED = "collector-disabled";
    /** 수집기의 창 밖 안 보냄 사유(토스로 나가지 않음). */
    static final String CODE_OUTSIDE_WINDOW = "outside-window";
    /**
     * 시가 맞추기는 창 끝 − 이만큼 뒤에 시작한 시도에서 OPG를 보내지 않습니다(RT3-MON-4 — 사전 조회 두 단계와 미체결·오늘 목록 읽기가 수집기 OPG 마감 전에
     * 끝나지 않을 수 있음). 그날 묶음이 없으면 묶음은 만들어(회전율 검사 포함) 시가 뒤 마무리가 시장가 DAY로 메우게 하고, 묶음이 있으면 재시도를 하지 않습니다.
     */
    static final Duration SYNC_LATE_START = Duration.ofSeconds(60);
    /** 모의 주문 상태 — 취소됨(모의 장부의 글자와 같음). */
    static final String PAPER_CANCELLED = "CANCELLED";

    /**
     * '같은 오류 3회'에 세지 않는 사유(명세 §7.3 — 종목 단위 건너뜀·429, 수집기 한도 거절, 수집기 창 밖 안 보냄, 그리고 이 기능이 붙인 기록 코드). 한도
     * 거절(1건·하루 건수·하루 매수)은 계획이 미리 줄이지만(하루 한도 — {@link RealTradePlanner#dailyUsage}, 매도 가격 여유) 사전 조회와 전송 사이의 가격·주문
     * 변화로 남을 수 있고, 창 밖 안 보냄({@value #CODE_OUTSIDE_WINDOW} — 토스로 나가지 않음)은 늦게 끝난 계획·전송의 시각 탓이라(RT3-MON-4 — 보내기 직전
     * 창 검사가 막지만 백엔드와 수집기의 창 끝 사이 여유가 30초뿐), 그것으로 이상 멈춤(이미 접수된 주문까지 취소)을 하지 않습니다.
     */
    static final Set<String> REPEAT_EXEMPT = Set.of("rate-limited", "opposite-pending-order-exists", "over-order-limit",
            "over-daily-orders", "over-daily-buy", CODE_OUTSIDE_WINDOW,
            RealTradeExecutor.CODE_INTERRUPTED, RealTradeExecutor.CODE_RECONCILED, RealTradeExecutor.CODE_OPERATOR_RESOLVED);
    /** 새 키(시도 2)로 다시 보내도 되는 거절·안 보냄 사유(지나가는 장애) — 같은 결과가 나올 것이 뻔한 한도·창·형식 거절은 다시 보내지 않습니다. */
    static final Set<String> RETRYABLE = Set.of("rate-limited", "collector-unreachable", "token-failed", "timeout",
            "calendar-unavailable", "account-unavailable", "price-unavailable", "count-unavailable", "connect-timeout", "connect-failed");
    /** 다음 주기에 다시 볼 건너뜀(미룸·이 기능 주문 진행 중·잔량 모름). 하루 매수 금액은 시가 주문이 상한가보다 낮게 체결되면 다시 생깁니다. */
    static final Set<String> TRANSIENT_SKIPS = Set.of(RealTradePlanner.SKIP_DEFERRED_CASH, RealTradePlanner.SKIP_DAILY_CAP,
            RealTradePlanner.SKIP_OWN, RealTradePlanner.SKIP_PENDING_UNKNOWN);
    /** 미룸으로 세는 건너뜀(창 요약의 '미룸'·장중 놓침 판정). */
    static final Set<String> DEFERRED_SKIPS = Set.of(RealTradePlanner.SKIP_DEFERRED_CASH, RealTradePlanner.SKIP_DAILY_CAP);
    /**
     * 한도로 그날 다 못 맞춰 남은 몫이 있다는 건너뜀 — 켠 뒤 묶음에 있으면 sync_pending을 이어 줍니다(명세 §3.1·§12.2). 이어 준 묶음의 회전율 예외는
     * 목표 변화량 조건이 붙습니다({@link #createBatchAndSend}).
     */
    static final Set<String> LEFTOVER_SKIPS = Set.of(RealTradePlanner.SKIP_CAPPED, RealTradePlanner.SKIP_DEFERRED_CASH,
            RealTradePlanner.SKIP_DAILY_CAP);
    /** sync_pending을 켠 일(켜기·책을 바꾼 설정 바꾸기·이상 멈춤 해제) 뒤 sync_pending을 이어 줄 수 있는 시가 맞추기 묶음 수(이 묶음 포함). */
    static final int SYNC_PENDING_MAX_BATCHES = 3;
    /** 묶음 수를 셀 때 거슬러 보는 묶음 번호 수(묶음은 거래일마다 하나). */
    static final int BATCH_SCAN_LIMIT = 40;
    /** sync_pending을 켠 일을 찾을 때 보는 최근 이벤트 수. */
    static final int EVENT_SCAN_LIMIT = 200;
    /** 그날 묶음이 지금 켜짐보다 먼저 만든 것(옛 책·옛 켜짐) — 그날 시가 재시도·마무리를 하지 않음. */
    static final String SKIP_BATCH_STALE = "batch-stale";
    /** 알림을 보내는 종목 건너뜀(명세 §2·§3.2). */
    static final Set<String> NOTIFY_SKIPS = Set.of(RealTradePlanner.SKIP_OPPOSITE, "timing-unsupported");

    private final RealTradeStore store;
    private final RealTradeExecutor executor;
    private final CollectorTradeClient client;
    private final PaperMirrorService paper;
    private final PaperTelegram telegram;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final boolean enabled;
    private final boolean schedulerEnabled;
    private final long intervalMs;
    private final ReentrantLock running = new ReentrantLock();

    private ScheduledExecutorService scheduler;
    /** 그날 상태(작업 스레드만 씀). */
    private DayState day;
    /** 화면용(상태 API) — 오늘 창과 쉬는 사유, 마지막 사전 조회, 마지막으로 주기를 끝낸 시각. */
    private volatile TodayView todayView;
    private volatile PreflightView lastPreflight;
    private volatile Instant lastCycleAt;
    /** 정기 작업을 시작한 시각(화면용 — 주기를 한 번도 끝내지 못해도 멈춤 판정의 기준이 되게, RT2-FE-2). */
    private volatile Instant startedAt;

    /** 오늘(KST) — 쉬는 사유(정해지기 전이면 null)와 창. */
    record TodayView(LocalDate date, String skipReason, List<Window> windows) {
    }

    /**
     * 마지막으로 토스에서 새로 읽은 값(화면용 — 저장하지 않음). {@code equity}는 안전 상한을 적용한 E, {@code total}은 손실 판정의 '지금 값'(상한 없는
     * 총액 — 정기 작업은 이 기능의 미체결 매수가 잡은 금액을 되돌린 값, 모르면 null).
     */
    record PreflightView(Instant fetchedAt, BigDecimal equity, BigDecimal total, BigDecimal cashBuyingPower, List<Position> holdings) {
    }

    @Autowired
    RealTradeJob(RealTradeStore store, RealTradeExecutor executor, CollectorTradeClient client, PaperMirrorService paper,
                 PaperTelegram telegram, ObjectMapper mapper,
                 @Value("${dashboard.realtrade.enabled:false}") boolean enabled,
                 @Value("${dashboard.scheduler.enabled:true}") boolean schedulerEnabled,
                 @Value("${dashboard.realtrade.interval-ms:10000}") long intervalMs) {
        this(store, executor, client, paper, telegram, mapper, Clock.systemUTC(), enabled, schedulerEnabled, intervalMs);
    }

    /** 시험용 — 시계를 정합니다. */
    RealTradeJob(RealTradeStore store, RealTradeExecutor executor, CollectorTradeClient client, PaperMirrorService paper,
                 PaperTelegram telegram, ObjectMapper mapper, Clock clock, boolean enabled, boolean schedulerEnabled, long intervalMs) {
        this.store = store;
        this.executor = executor;
        this.client = client;
        this.paper = paper;
        this.telegram = telegram;
        this.mapper = mapper;
        this.clock = clock;
        this.enabled = enabled;
        this.schedulerEnabled = schedulerEnabled;
        this.intervalMs = Math.max(1_000, intervalMs);
    }

    boolean enabled() {
        return enabled;
    }

    TodayView todayView() {
        return todayView;
    }

    PreflightView lastPreflight() {
        return lastPreflight;
    }

    /** 사전 조회 결과를 화면용으로 남깁니다(켜기 창 예상 목록도 씀). */
    void notePreflight(Preflight preflight, Account account, BigDecimal equity, BigDecimal total, Instant now) {
        lastPreflight = new PreflightView(preflight.fetchedAt() != null ? preflight.fetchedAt() : now, equity, total,
                preflight.cashBuyingPowerKrw(), List.copyOf(account.positions().values()));
    }

    /** 마지막으로 주기를 (예외 없이) 끝낸 시각 — 정기 작업이 꺼져 있거나(백엔드 스위치·스케줄러) 아직 한 번도 끝내지 않았으면 null. */
    Instant lastCycleAt() {
        return enabled && schedulerEnabled ? lastCycleAt : null;
    }

    /**
     * 정기 작업을 시작한 시각 — 정기 작업이 꺼져 있으면(백엔드 스위치·스케줄러) null. 시작 뒤 주기가 매번 예외로 끝나도 남으므로, 화면은
     * {@code lastCycleAt ?? startedAt}으로 멈춤을 판단합니다(null은 '꺼짐'만 뜻함).
     */
    Instant startedAt() {
        return enabled && schedulerEnabled ? startedAt : null;
    }

    // ------------------------------------------------------------------ 생명주기
    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        if (!enabled || !schedulerEnabled) {
            log.info("실제 매매 정기 작업 꺼짐 — REAL_TRADE_ENABLED={} · 스케줄러(dashboard.scheduler.enabled)={}", enabled,
                    schedulerEnabled);
            return;
        }
        startedAt = clock.instant();
        scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "realtrade");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.scheduleWithFixedDelay(this::tick, INITIAL_DELAY_MS, intervalMs, TimeUnit.MILLISECONDS);
        log.info("실제 매매 정기 작업 켜짐 — {}ms마다(전용 단일 스레드)", intervalMs);
    }

    /** 종료 훅 — 새 전송을 막고, 진행 중인 주기(전송과 그 기록)가 끝날 때까지 기다립니다. */
    @PreDestroy
    public void stop() {
        executor.close();
        ScheduledExecutorService current = scheduler;
        if (current == null) {
            return;
        }
        current.shutdown();
        try {
            if (!current.awaitTermination(SHUTDOWN_WAIT_SECONDS, TimeUnit.SECONDS)) {
                log.warn("실제 매매 정기 작업이 {}초 안에 끝나지 않음 — 남은 SENDING은 다음 기동 때 결과 모름으로 정리됩니다", SHUTDOWN_WAIT_SECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** 스케줄러가 부르는 한 번 — 무엇을 던져도 잡고 이어 갑니다(클래스 설명). 예외 없이 끝났을 때만 마지막 주기 시각을 바꿉니다. */
    void tick() {
        try {
            cycle(clock.instant());
            lastCycleAt = clock.instant();
        } catch (RuntimeException e) {
            log.warn("실제 매매 정기 작업 실패 — 다음 주기에 다시: {}", e.getClass().getSimpleName());
        } catch (Throwable e) {   // Error도 — 다시 던지면 scheduleWithFixedDelay가 뒤 주기를 모두 건너뜀(RT-BE-6)
            log.error("실제 매매 정기 작업 오류 — 다음 주기에 다시: {}", e.getClass().getSimpleName());
        }
    }

    // ------------------------------------------------------------------ 한 주기
    /** 한 주기(클래스 설명) — 시험이 시각을 정해 부릅니다. 앞 주기가 도는 중이면 건너뜁니다. */
    void cycle(Instant now) {
        if (!enabled || !store.ready() || !running.tryLock()) {
            return;
        }
        try {
            LocalDate today = LocalDate.ofInstant(now, Kst.ZONE);
            DayState d = dayFor(today);
            executor.markOrphans();
            if (d.calendar == null && !store.unfinishedOrders(MARKET).isEmpty()) {
                ensureCalendar(d, now);   // 종가 체결 시각 확인에 그날 창이 필요(재시작 직후)
            }
            executor.track(now, d.windows);
            // 추적 뒤에 읽음 — 추적이 이상 멈춤을 걸었거나 그사이 끄기가 커밋됐으면 결과 모름을 다시 보내지 않게(RT-BE-4, 실행기가 보내기 직전에도 다시 확인)
            Config cfg = store.configOrOff(MARKET);
            RealTradeExecutor.Resolution resolution = executor.resolveUnknown(now, cfg);
            cfg = store.configOrOff(MARKET);
            if (!live(cfg)) {
                // 끄는 중·멈춤은 이 기능의 미체결 취소를 따라감. 꺼짐(OFF)에서도 토스 주문 번호가 있는 미종료 행이 있으면 취소 — 끄는 중에 대조를 끝내지
                // 못한 결과 모름 행이 꺼진 뒤 대조로 늦게 묶인 것(RT3-BE-1, 정상이면 꺼짐에 그런 행은 없음). 대조 목록을 못 읽은 주기에는 OFF로 넘기지 않음.
                boolean stopping = RealTradeStore.STATE_STOPPING.equals(cfg.state());
                if (stopping || RealTradeStore.STATE_HALTED.equals(cfg.state()) || executor.openBrokerOrders() > 0) {
                    executor.cancelOpen(now, row -> true);
                }
                if (stopping && !resolution.listsFailed() && executor.cleanupDone(now)) {
                    finishStopping();
                }
                return;
            }
            Config following = cfg;
            executor.cancelOpen(now, row -> !Objects.equals(row.sourceBook(), following.sourceBook())
                    || !Objects.equals(row.bookGeneration(), following.bookGeneration()));
            Optional<BookInfo> book = paper.book(cfg.sourceBook());
            if (book.isEmpty() || !book.get().active() || !MARKET.equals(book.get().market())) {
                executor.halt(HALT_BOOK_NOT_ACTIVE, Map.of("sourceBook", String.valueOf(cfg.sourceBook())));
                return;
            }
            if (!book.get().generation().equals(cfg.bookGeneration())) {
                executor.halt(HALT_BOOK_CHANGED, Map.of("sourceBook", cfg.sourceBook()));
                return;
            }
            Reply<Status> status = client.status();
            if (status.ok() && status.value().switchedOff()) {
                // 수집기가 매매 스위치가 꺼졌다고 분명히 답함(비상 끄기 등) — 다시 켤 때 확인 글자 + 비밀번호를 거치게 이상 멈춤(OPS-3)
                executor.halt(HALT_COLLECTOR_DISABLED, Map.of("code", String.valueOf(status.value().reason())));
                return;
            }
            if (!status.ok() || !status.value().enabled() || status.value().limits() == null) {
                return;   // 수집기 상태를 읽지 못함·한도 해석 실패 — 주문 없음(멈춤 아님, 화면은 '확인 안 됨')
            }
            if (status.value().tokenContention()) {
                executor.halt(HALT_TOKEN, Map.of());
                return;
            }
            String repeated = repeatedError(today);
            if (repeated != null) {
                executor.halt(HALT_REPEATED, Map.of("code", repeated));
                return;
            }
            if (!ensureCalendar(d, now)) {
                return;
            }
            decide(d, now, cfg);
            if (d.skipReason != null) {
                recordSkip(d);
                return;
            }
            if (d.decidedFor == null || d.windows == null) {
                return;   // 아직 그날 첫 창 3분 전이 아님
            }
            Cycle c = new Cycle(now, d, cfg, status.value().limits(), paper.cashLikeTickers());
            List<DueOrder> upcoming = paper.dueOrders(cfg.sourceBook(), today, now.plus(WARMUP_LEAD));
            warmup(c, upcoming);
            if (d.windows.sync() != null && d.windows.sync().contains(now)) {
                runSync(c);
            }
            if (live(c) && d.windows.followup().contains(now)) {
                runFollowup(c, upcoming);
            }
            if (live(c)) {
                runMirror(c, upcoming);
            }
            if (live(c)) {
                summaries(c);
            }
        } finally {
            try {
                notifyPending(now);
            } finally {
                running.unlock();
            }
        }
    }

    private static boolean live(Config cfg) {
        return RealTradeStore.STATE_LIVE.equals(cfg.state());
    }

    /** 이 주기에서 계획한 설정이 아직 켜짐인가(멈춤·끄기가 끼어들면 나머지를 하지 않음). */
    private boolean live(Cycle c) {
        Config now = store.configOrOff(MARKET);
        return live(now) && now.version() == c.cfg.version();
    }

    /** 한 주기의 문맥 — 계획 때의 설정({@code cfg}, 이 작업이 스스로 바꾸면 새 값으로), 한도, 현금성 종목. */
    private static final class Cycle {
        final Instant now;
        final LocalDate today;
        final DayState day;
        Config cfg;
        final Limits limits;
        final Set<String> cashLike;

        Cycle(Instant now, DayState day, Config cfg, Limits limits, Collection<String> cashLike) {
            this.now = now;
            this.today = day.date;
            this.day = day;
            this.cfg = cfg;
            this.limits = limits;
            this.cashLike = Set.copyOf(cashLike);
        }
    }

    /**
     * 새로 읽은 계좌 — 계획 입력, E, 이 기능의 미종료 주문 종목, 같은 창에서 이미 잡은 매수의 상한가 합, 손실 판정용 평가액(이 기능의 미체결 매수가 잡은
     * 금액을 되돌린 값 — 상한 없는 {@code lossTotal}, 안전 상한 적용 {@code lossEquity}), 수집기 하루 한도의 오늘 남은 건수·매수 금액.
     */
    private record Fresh(Account account, BigDecimal equity, Set<String> blocked, BigDecimal reserved, BigDecimal lossTotal,
                         BigDecimal lossEquity, DailyRoom daily) {
    }

    /** 수집기 하루 한도의 오늘 남은 몫(명세 §5.2 — 한도 − 오늘 쓴 몫, 0 아래는 0). */
    record DailyRoom(int orders, BigDecimal buyKrw) {
    }

    /** 사전 조회와 그것으로 낸 계획. */
    private record Planned(Fresh fresh, Plan plan) {
    }

    // ------------------------------------------------------------------ 그날
    /** 그날 상태(작업 스레드만). 날짜가 바뀌면 새로 만들고, 그날 이미 남긴 창 요약·쉼 이벤트를 DB에서 읽어 다시 남기지 않습니다. */
    static final class DayState {
        final LocalDate date;
        CollectorTradeClient.Calendar calendar;
        Day windows;
        Instant calendarTriedAt;
        /** 쉬는 판정을 한 책과 세대(바뀌면 다시 판정). */
        String decidedFor;
        String skipReason;
        boolean skipRecorded;
        /** 창 → 사유 → 건너뛴 대상(종목 또는 모의 주문 뿌리) — 같은 대상은 한 번만 셈. */
        final Map<String, Map<String, Set<String>>> skipped = new HashMap<>();
        final Map<String, Set<String>> missed = new HashMap<>();
        final Set<Long> handledRoots = new HashSet<>();
        final Set<String> summarized = new HashSet<>();
        Instant lastSyncTry;
        Instant lastFollowupTry;
        Instant lastWarmup;
        boolean followupDone;
        /** 낡았다고 판정한 그날 묶음 번호(한 번 낡으면 그날 계속 낡음). */
        Long staleBatch;

        DayState(LocalDate date) {
            this.date = date;
        }

        /** 이번에 처음 센 대상이면 true. */
        boolean skip(String window, String reason, String key) {
            return skipped.computeIfAbsent(window, k -> new TreeMap<>()).computeIfAbsent(reason, k -> new TreeSet<>()).add(key);
        }

        void miss(String window, String key) {
            missed.computeIfAbsent(window, k -> new TreeSet<>()).add(key);
        }
    }

    private DayState dayFor(LocalDate today) {
        if (day != null && day.date.equals(today)) {
            return day;
        }
        DayState fresh = new DayState(today);
        for (Event e : store.recentEvents(MARKET, 50)) {
            JsonNode detail = e.detail();
            if (detail == null || !today.toString().equals(detail.path("date").asString(""))) {
                continue;
            }
            if (RealTradeStore.EVENT_WINDOW_SUMMARY.equals(e.kind())) {
                fresh.summarized.add(detail.path("window").asString(""));
            } else if (RealTradeStore.EVENT_SKIP_DAY.equals(e.kind())) {
                fresh.skipRecorded = true;
            }
        }
        day = fresh;
        todayView = new TodayView(today, null, List.of());
        return fresh;
    }

    /** 그날 토스 장 운영 정보(수집기가 날짜마다 캐시) — {@link #CALENDAR_FROM}부터 받고, 실패하면 {@link #CALENDAR_RETRY} 뒤 다시. */
    private boolean ensureCalendar(DayState d, Instant now) {
        if (d.calendar != null) {
            return true;
        }
        if (LocalTime.ofInstant(now, Kst.ZONE).isBefore(CALENDAR_FROM)
                || (d.calendarTriedAt != null && now.isBefore(d.calendarTriedAt.plus(CALENDAR_RETRY)))) {
            return false;
        }
        d.calendarTriedAt = now;
        Reply<CollectorTradeClient.Calendar> reply = client.calendar();
        if (!reply.ok()) {
            log.warn("토스 장 운영 정보를 받지 못함 — {}초 뒤 다시 ({})", CALENDAR_RETRY.toSeconds(), reply.reason());
            return false;
        }
        d.calendar = reply.value();
        d.windows = RealTradePlanner.windows(d.date, reply.value().today());
        publish(d);
        return true;
    }

    /** 쉬는 날 판정(명세 §3) — 그날 첫 창 3분 전에(휴장이면 바로) 한 번, 따라 하는 책·세대가 바뀌면 다시. */
    private void decide(DayState d, Instant now, Config cfg) {
        String key = cfg.sourceBook() + "|" + cfg.bookGeneration();
        if (key.equals(d.decidedFor)) {
            return;
        }
        if (d.windows != null && now.isBefore(d.windows.firstStart().minus(WARMUP_LEAD))) {
            return;
        }
        boolean caughtUp = d.windows != null && paper.ledgerCaughtUp(cfg.sourceBook(), d.date);
        d.skipReason = RealTradePlanner.skipReason(d.date, d.calendar, paper.sessionHours(d.date), caughtUp);
        d.decidedFor = key;
        publish(d);
        log.info("실제 매매 오늘 판정 — {}", d.skipReason == null ? "창 안에서 따라 함" : "쉼(" + d.skipReason + ")");
    }

    private void publish(DayState d) {
        todayView = new TodayView(d.date, d.skipReason, d.windows == null ? List.of() : d.windows.list());
    }

    private void recordSkip(DayState d) {
        if (d.skipRecorded) {
            return;
        }
        d.skipRecorded = true;
        boolean notify = !RealTradePlanner.SKIP_MARKET_CLOSED.equals(d.skipReason);   // 휴장은 평소 일이라 알리지 않음
        store.addEvent(MARKET, RealTradeStore.EVENT_SKIP_DAY, null, Map.of("reason", d.skipReason, "date", d.date.toString()), notify);
    }

    private void warmup(Cycle c, List<DueOrder> upcoming) {
        DayState d = c.day;
        if (d.lastWarmup != null && c.now.isBefore(d.lastWarmup.plus(WARMUP_SPACING))) {
            return;
        }
        boolean near = false;
        for (Window w : new Window[]{d.windows.sync(), d.windows.followup(), d.windows.close()}) {
            if (w != null && !c.now.isBefore(w.start().minus(WARMUP_LEAD)) && c.now.isBefore(w.start())) {
                near = true;
            }
        }
        if (!near) {
            near = upcoming.stream().anyMatch(o -> o.supported() && o.mirrorAt() != null && o.mirrorAt().isAfter(c.now));
        }
        if (!near) {
            return;
        }
        d.lastWarmup = c.now;
        Reply<CollectorTradeClient.Warmup> reply = client.warmup();
        log.info("토스 토큰 예열 — {}", reply.ok() ? (reply.value().tokenRefreshed() ? "재발급" : "그대로") : "실패(" + reply.reason() + ")");
    }

    // ------------------------------------------------------------------ 시가 맞추기
    /**
     * 시가 맞추기 창 안의 한 주기 — 그날 묶음이 없으면 만들고 보내고, 있으면 창 안 재시도. 창 끝 − {@link #SYNC_LATE_START} 뒤에 시작한 시도는 OPG를 보내지
     * 않습니다(묶음이 없으면 묶음만 만들어 마무리가 메우게, 있으면 재시도 없음 — RT3-MON-4).
     */
    private void runSync(Cycle c) {
        boolean late = !c.now.isBefore(c.day.windows.sync().end().minus(SYNC_LATE_START));
        Optional<Batch> existing = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC);
        if (existing.isPresent()) {
            if (!stale(c, existing.get()) && !late) {
                retrySync(c, existing.get());
            }
            return;
        }
        if (throttled(c.day.lastSyncTry, c.now)) {
            return;
        }
        c.day.lastSyncTry = c.now;
        if (late) {
            log.warn("시가 맞추기 창 끝이 가까워 OPG를 보내지 않음 — 묶음만 만들고 시가 뒤 마무리가 메움");
        }
        createBatchAndSend(c, RealTradeStore.PURPOSE_SYNC, "OPG", RealTradePlanner.WINDOW_SYNC, !late);
    }

    /**
     * 그날 시가 맞추기 묶음을 만들고(목표 비중·흡수한 모의 주문·E 고정) 보냅니다. 목표가 없거나 불완전하면 보내지 않습니다(빈 목표로 '모두 팔기'를 하지 않게).
     * 회전율이 60%를 넘으면 보내지 않고 이상 멈춤 — 예외는 {@link #turnoverHalt}(켜기·방식 바꾸기·멈춤 해제 뒤 첫 묶음, 그리고 남은 몫으로 이어 준 묶음 중
     * 목표가 앞 묶음과 거의 같은 것). 묶음을 만들면서(같은 트랜잭션) {@code sync_pending}을 끕니다 — 단 1건 상한·현금·하루 한도로 그날 다 못 맞춘 남은
     * 몫({@link #LEFTOVER_SKIPS})이 있으면, sync_pending을 켠 일 뒤 {@value #SYNC_PENDING_MAX_BATCHES}번째 묶음까지는 켜 둡니다(켜기 창에서 확인한
     * 같은 재조정의 남은 몫이 다음 날 회전율 멈춤이 되지 않게 — 그 뒤로는 끔).
     *
     * @param send false면 묶음만 만들고 보내지 않음(계획한 주문은 놓침 — 창 끝이 가까워 시작한 시가 맞추기, 시가 뒤 마무리가 메움)
     */
    private void createBatchAndSend(Cycle c, String purpose, String timeInForce, String window, boolean send) {
        Optional<OpenTargets> found = paper.openTargets(c.cfg.sourceBook(), c.today);
        if (found.isEmpty()) {
            c.day.skip(window, "targets-unavailable", "*");
            return;
        }
        OpenTargets targets = found.get();
        if (!targets.complete()) {
            c.day.skip(window, "targets-incomplete", "*");
            return;
        }
        Map<String, Double> weightPct = targets.weightPct();
        Planned planned0 = planSync(c, weightPct.keySet(), purpose,
                (f, r) -> RealTradePlanner.sync(weightPct, f.equity(), f.account(), f.blocked(), f.reserved(), r, true));
        if (planned0 == null) {
            return;
        }
        Fresh f = planned0.fresh();
        Plan plan = planned0.plan();
        Optional<Instant> start = c.cfg.syncPending() ? followStart() : Optional.empty();
        if (plan.turnoverExceeded()) {
            Map<String, Object> halt = turnoverHalt(c.cfg, start, plan, weightPct);
            if (halt != null) {
                executor.halt(HALT_TURNOVER, halt);
                return;
            }
        }
        boolean leftover = plan.skipped().stream().anyMatch(s -> LEFTOVER_SKIPS.contains(s.reason()));
        Optional<Instant> since = leftover ? start : Optional.empty();
        Config planned = c.cfg;
        Locked locked = store.lockConfig(MARKET, current -> {
            if (!sameState(current, planned)) {
                return null;
            }
            Batch batch = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC).orElseGet(() -> store.upsertBatch(MARKET, c.today,
                    RealTradeStore.BATCH_SYNC, planned.sourceBook(), mapper.valueToTree(weightPct), targets.absorbedOrderIds(),
                    f.equity()));
            boolean keep = current.syncPending() && since.isPresent() && batchesSince(batch, since.get()) < SYNC_PENDING_MAX_BATCHES;
            if (current.syncPending() && !keep && !store.updateConfig(current.withSyncPending(false), null)) {
                return null;
            }
            return new Locked(batch, store.config(MARKET).orElse(current));
        });
        if (locked == null) {
            return;
        }
        c.cfg = locked.config();
        log.info("시가 맞추기 묶음 — 주문 {}건·건너뜀 {}건·회전율 {}%{}", plan.orders().size(), plan.skipped().size(), plan.turnoverPct(),
                c.cfg.syncPending() ? "(남은 몫 — 회전율 예외 유지)" : "");
        recordSkips(c, window, plan.skipped(), null);
        if (!send) {
            plan.orders().forEach(o -> c.day.miss(window, o.symbol()));
            return;
        }
        sendBatchOrders(c, plan.orders(), locked.batch(), purpose, timeInForce);
    }

    private record Locked(Batch batch, Config config) {
    }

    /**
     * 회전율이 한도를 넘은 묶음을 멈출지(명세 §3.1·§12.2, RT2-1) — 멈추면 HALT 이벤트에 실을 값, 보내도 되면 null. 묶음을 만들기 전에(잠금 밖) 셉니다.
     * <ul>
     *   <li>{@code sync_pending}이 아니면 멈춤.</li>
     *   <li>sync_pending을 켠 마지막 일 뒤 첫 묶음(그 뒤에 만든 묶음이 아직 없음 — 켜기 창에서 확인한 재조정)이면 보냄. 그 일을 최근 이벤트에서 못 찾으면
     *       앞 묶음이 하나도 없을 때만 첫 묶음으로 봅니다.</li>
     *   <li>남은 몫 때문에 sync_pending이 이어진 2·3번째 묶음은 목표 변화량(바로 앞 묶음 목표와의 Σ|w_now − w_prev|, 합집합 종목 — 없는 종목은 0%)이
     *       회전율 한도 이하일 때만 보냄 — 같은 목표의 남은 몫(변화량 ≈ 0)은 통과하고, 새 재조정이나 엉망인 목표는 {@code targetDriftPct}와 함께 멈춤.</li>
     * </ul>
     */
    private Map<String, Object> turnoverHalt(Config cfg, Optional<Instant> start, Plan plan, Map<String, Double> weightPct) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("turnoverPct", plan.turnoverPct());
        if (!cfg.syncPending()) {
            return detail;
        }
        Optional<Batch> previous = store.latestBatch(MARKET, RealTradeStore.BATCH_SYNC);
        if (previous.isEmpty()) {
            return null;
        }
        Instant previousAt = previous.get().createdAt();
        if (start.isPresent() && (previousAt == null || previousAt.isBefore(start.get()))) {
            return null;
        }
        Optional<BigDecimal> drift = targetDrift(weights(previous.get()), weightPct);
        if (drift.isPresent() && drift.get().compareTo(RealTradePlanner.TURNOVER_LIMIT_PCT) <= 0) {
            log.info("남은 몫 묶음 — 회전율 {}%지만 목표 변화량 {}%라 회전율 예외 유지", plan.turnoverPct(), drift.get());
            return null;
        }
        detail.put("targetDriftPct", drift.orElse(null));
        return detail;
    }

    /** 목표 변화량(%p) — Σ|지금 − 앞| (합집합 종목, 없는 종목은 0%). 유한하지 않은 비중이 있으면 empty(멈춤으로 셈). */
    static Optional<BigDecimal> targetDrift(Map<String, Double> previous, Map<String, Double> now) {
        Set<String> symbols = new TreeSet<>(previous.keySet());
        symbols.addAll(now.keySet());
        double sum = 0;
        for (String symbol : symbols) {
            double before = previous.get(symbol) == null ? 0 : previous.get(symbol);
            double after = now.get(symbol) == null ? 0 : now.get(symbol);
            sum += Math.abs(after - before);
        }
        return Double.isFinite(sum) ? Optional.of(BigDecimal.valueOf(sum).setScale(2, RoundingMode.HALF_UP)) : Optional.empty();
    }

    /**
     * 시가 맞추기 창 안의 재시도 — 첫 시도가 지나가는 장애로 거절·안 보냄인 종목만, 새 사전 조회로 다시 계산해 시도 2. 목표 수량은 묶음에 고정한 E로 셉니다
     * (OPG 매수가 매수 가능 금액을 잡아 새로 읽은 E가 낮게 나와도 목표가 줄지 않게). 현금은 재시도 종목에만 배정합니다.
     */
    private void retrySync(Cycle c, Batch batch) {
        List<OrderRow> rows = store.ordersForBatch(batch.id());
        Map<String, Double> weights = weights(batch);
        Set<String> symbols = new TreeSet<>(weights.keySet());
        rows.forEach(row -> symbols.add(row.symbol()));
        Set<String> retry = new TreeSet<>();
        for (String symbol : symbols) {
            if (nextAttempt(rows, symbol, RealTradeStore.PURPOSE_SYNC, false) == 2) {
                retry.add(symbol);
            }
        }
        if (retry.isEmpty() || throttled(c.day.lastSyncTry, c.now)) {
            return;
        }
        c.day.lastSyncTry = c.now;
        Planned planned = planSync(c, symbols, RealTradeStore.PURPOSE_SYNC,
                (f, r) -> RealTradePlanner.sync(weights, batch.equity() != null ? batch.equity() : f.equity(), f.account(), f.blocked(),
                        f.reserved(), r, true, null, retry));
        if (planned == null) {
            return;
        }
        sendBatchOrders(c, planned.plan().orders(), batch, RealTradeStore.PURPOSE_SYNC, "OPG");
    }

    /**
     * 두 단계 사전 조회와 계획(명세 §5.2 — 수집기 사전 조회의 시간 예산). 먼저 매도 가능 수량 없이 읽어 정수 보유로 어림해 계획하고, 매도가 나오면 그 종목만
     * 매도 가능 수량을 물어 다시 읽은 값으로 다시 계획합니다(매도 수량은 매도 가능 수량까지). 손실 한도는 읽을 때마다 봅니다. 못 읽거나 설정이 그사이
     * 바뀌면 null.
     */
    private Planned planSync(Cycle c, Collection<String> symbols, String purpose, BiFunction<Fresh, Rules, Plan> plan) {
        Fresh f = fresh(c, symbols, purpose, Set.of());
        if (f == null || !lossCheck(c, f)) {
            return null;
        }
        Set<String> sell = RealTradePlanner.sellSymbols(plan.apply(f, rules(c, f).withRequireSellable(false)));
        if (!sell.isEmpty()) {
            f = fresh(c, symbols, purpose, sell);
            if (f == null || !lossCheck(c, f)) {
                return null;
            }
        }
        return new Planned(f, plan.apply(f, rules(c, f)));
    }

    /**
     * 그날 묶음이 지금 켜짐보다 먼저 만든 것인가(명세 §7.2 — 방식이 바뀌면 옛 책 따라 하기 즉시 중단) — 묶음의 책이 지금 따라 하는 책과 다르거나, 묶음을
     * sync_pending을 켠 마지막 일(켜기·책을 바꾼 설정 바꾸기·이상 멈춤 해제) 전에 만들었으면 참. 그러면 그날 시가 재시도·마무리를 하지 않고(건너뜀
     * {@value #SKIP_BATCH_STALE}) 다음 시가 맞추기가 맞춥니다. 남은 몫으로 sync_pending을 켜 둔 묶음(같은 켜짐 안)은 낡지 않습니다.
     */
    private boolean stale(Cycle c, Batch batch) {
        if (Objects.equals(c.day.staleBatch, batch.id())) {
            return true;
        }
        boolean stale = !Objects.equals(batch.sourceBook(), c.cfg.sourceBook())
                || followStart().map(since -> batch.createdAt() == null || batch.createdAt().isBefore(since)).orElse(false);
        if (stale) {
            c.day.staleBatch = batch.id();
            c.day.followupDone = true;
            c.day.skip(RealTradePlanner.WINDOW_SYNC, SKIP_BATCH_STALE, "*");
            log.warn("그날 시가 맞추기 묶음이 지금 켜짐보다 먼저 만든 것 — 그날 시가 재시도·마무리를 하지 않음");
        }
        return stale;
    }

    /** sync_pending을 켠 마지막 일(켜기·책을 바꾼 설정 바꾸기·이상 멈춤 해제)의 시각 — 최근 이벤트에 없으면 empty. */
    private Optional<Instant> followStart() {
        for (Event e : store.recentEvents(MARKET, EVENT_SCAN_LIMIT)) {
            if (startsFollowing(e)) {
                return Optional.ofNullable(e.at());
            }
        }
        return Optional.empty();
    }

    /** sync_pending을 켜는 이벤트인가 — 켜기, 책을 바꾼 설정 바꾸기, 이상 멈춤(HALTED)에서의 해제(매수 멈춤만 푼 해제는 아님). */
    static boolean startsFollowing(Event e) {
        JsonNode detail = e.detail();
        if (RealTradeStore.EVENT_ENABLE.equals(e.kind())) {
            return true;
        }
        if (RealTradeStore.EVENT_RESUME.equals(e.kind())) {
            return detail != null && RealTradeStore.STATE_HALTED.equals(detail.path("from").asString(""));
        }
        if (RealTradeStore.EVENT_UPDATE.equals(e.kind()) && detail != null) {
            for (JsonNode change : detail.path("changes")) {
                if ("sourceBook".equals(change.asString(""))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * {@code since} 뒤에 만든 시가 맞추기 묶음 수(이 묶음 포함, 최대 {@value #SYNC_PENDING_MAX_BATCHES}) — 묶음 번호(만든 순서)를 거슬러
     * {@value #BATCH_SCAN_LIMIT}개까지 보고, {@code since}보다 먼저 만든 묶음을 만나면 멈춥니다(빈 번호는 지나감). 묶음은 지우지 않으므로 그 범위 밖에
     * {@code since} 뒤의 묶음은 없습니다.
     */
    private int batchesSince(Batch batch, Instant since) {
        if (batch.createdAt() == null || batch.createdAt().isBefore(since)) {
            return SYNC_PENDING_MAX_BATCHES;
        }
        int count = 1;
        for (long id = batch.id() - 1; id > 0 && id >= batch.id() - BATCH_SCAN_LIMIT; id--) {
            Optional<Batch> earlier = store.batch(id);
            if (earlier.isEmpty() || !MARKET.equals(earlier.get().market())) {
                continue;
            }
            if (earlier.get().createdAt() == null || earlier.get().createdAt().isBefore(since)) {
                return count;
            }
            count++;
            if (count >= SYNC_PENDING_MAX_BATCHES) {
                return count;
            }
        }
        return count;
    }

    // ------------------------------------------------------------------ 시가 뒤 마무리
    /**
     * 시가 뒤 마무리(명세 §3 표) — 묶음의 목표로 새 사전 조회 기준 차이를 시장가 DAY로 메웁니다. 그 종목의 이 기능 주문이 모두 종료 확인되기 전에는 그 종목을
     * 건너뜁니다(OPG 결과를 모르면 대체 주문 없음). 그날 시가 단일가 경로가 없으면 이 창이 묶음을 만듭니다(회전율 한도 적용). 시가 맞추기 창을 놓쳐 묶음이
     * 없으면 하지 않습니다(놓침 — 다음 시가 맞추기가 메움). 낡은 묶음(지금 켜짐보다 먼저 만든 것)이면 하지 않습니다.
     *
     * <p>범위는 묶음의 종목(목표 종목 ∪ 그 묶음이 주문한 종목)뿐이고, 그날 장중 따라 하기가 손댄 종목(오늘 MIRROR 행이 있거나 흡수되지 않은 장중 대기 주문의
     * 따라 할 시각이 지난 종목)은 뺍니다 — 같은 시간대의 장중 따라 하기 결과를 묶음 목표로 되돌리지 않게(장중에 산 종목을 '책에 없는 보유'로 팔거나, 장중에
     * 판 종목을 다시 사지 않음). E는 전체 계좌로 셉니다. 현금은 이번에 보낼 수 있는 종목(그 종목의 마무리 시도가 남은 것)에만 배정합니다.
     */
    private void runFollowup(Cycle c, List<DueOrder> upcoming) {
        Optional<Batch> existing = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC);
        if (existing.isEmpty()) {
            if (c.day.windows.sync() == null && !throttled(c.day.lastFollowupTry, c.now)) {
                c.day.lastFollowupTry = c.now;
                createBatchAndSend(c, RealTradeStore.PURPOSE_SYNC_FOLLOWUP, "DAY", RealTradePlanner.WINDOW_FOLLOWUP, true);
            }
            return;
        }
        if (c.day.followupDone || throttled(c.day.lastFollowupTry, c.now)) {
            return;
        }
        Batch batch = existing.get();
        if (stale(c, batch)) {
            return;
        }
        c.day.lastFollowupTry = c.now;
        Map<String, Double> weights = weights(batch);
        List<OrderRow> rows = store.ordersForBatch(batch.id());
        Set<String> scope = new TreeSet<>(weights.keySet());
        rows.forEach(row -> scope.add(row.symbol()));
        scope.removeAll(mirrorTouched(c, batch, upcoming));
        Set<String> sendable = new TreeSet<>();
        for (String symbol : scope) {
            if (nextAttempt(rows, symbol, RealTradeStore.PURPOSE_SYNC_FOLLOWUP, true) > 0) {
                sendable.add(symbol);
            }
        }
        Planned planned = planSync(c, scope, RealTradeStore.PURPOSE_SYNC_FOLLOWUP,
                (f, r) -> RealTradePlanner.sync(weights, f.equity(), f.account(), f.blocked(), f.reserved(), r, true, scope, sendable));
        if (planned == null) {
            return;
        }
        Plan plan = planned.plan();
        recordSkips(c, RealTradePlanner.WINDOW_FOLLOWUP, plan.skipped(), null);
        int sent = sendBatchOrders(c, plan.orders(), batch, RealTradeStore.PURPOSE_SYNC_FOLLOWUP, "DAY");
        boolean waiting = plan.skipped().stream().anyMatch(s -> TRANSIENT_SKIPS.contains(s.reason()));
        if (sent == 0 && plan.orders().isEmpty() && !waiting) {
            c.day.followupDone = true;
        }
    }

    /**
     * 그날 장중 따라 하기가 손댄 종목 — 오늘 MIRROR 행의 종목(상태 무관)과, 묶음이 흡수하지 않은 따라 하는 책의 장중 대기 주문 가운데 따라 할 수 있고 따라 할
     * 시각이 지난 것의 종목.
     */
    private Set<String> mirrorTouched(Cycle c, Batch batch, List<DueOrder> upcoming) {
        Set<String> out = new TreeSet<>();
        store.ordersOn(MARKET, c.today).stream().filter(row -> RealTradeStore.PURPOSE_MIRROR.equals(row.purpose()))
                .forEach(row -> out.add(row.symbol()));
        Set<Long> absorbed = Set.copyOf(batch.absorbedOrderIds());
        for (DueOrder o : upcoming) {
            if (!absorbed.contains(o.orderId()) && o.supported() && o.mirrorAt() != null && !o.mirrorAt().isAfter(c.now)
                    && o.ticker() != null) {
                out.add(o.ticker());
            }
        }
        return out;
    }

    /**
     * 묶음 주문을 차례로(계획 순서 — 매도 먼저) 보냅니다. 종목·용도마다 시도 1, 앞 시도가 지나가는 장애로 거절·안 보냄이거나(마무리는) 종료에 덜 체결이면
     * 시도 2를 남은 수량만큼. 멈춤·끄기가 끼어들면 나머지를 보내지 않습니다. 보내기 직전마다 지금 시각({@code clock})으로 그 용도의 창(시가 맞추기 —
     * 시가 맞추기 창, 마무리 — 마무리 창)이 아직 열려 있는지 다시 보고, 닫혔으면 그 주문부터 보내지 않고 놓침으로 둡니다(RT3-MON-4 — 앞 주문의 수집기
     * 검사·전송이 길어져 수집기 창 끝을 넘긴 주문이 창 밖 안 보냄으로 쌓이지 않게. 시가 맞추기에서 놓친 종목은 시가 뒤 마무리가 메움).
     *
     * @return 행을 쓴 수
     */
    private int sendBatchOrders(Cycle c, List<Order> orders, Batch batch, String purpose, String timeInForce) {
        boolean partialRetry = !RealTradeStore.PURPOSE_SYNC.equals(purpose);
        boolean sync = RealTradeStore.PURPOSE_SYNC.equals(purpose);
        Window win = sync ? c.day.windows.sync() : c.day.windows.followup();
        String window = sync ? RealTradePlanner.WINDOW_SYNC : RealTradePlanner.WINDOW_FOLLOWUP;
        int written = 0;
        boolean closed = false;
        for (Order o : orders) {
            List<OrderRow> rows = store.ordersForBatch(batch.id());
            int attempt = nextAttempt(rows, o.symbol(), purpose, partialRetry);
            if (attempt == 0) {
                continue;
            }
            int quantity = attempt == 2 ? Math.min(o.quantity(), remaining(rows, o.symbol(), purpose)) : o.quantity();
            if (quantity < 1) {
                continue;
            }
            if (!closed && (win == null || clock.instant().isAfter(win.end()))) {
                closed = true;
                log.warn("{} 창이 보내는 도중에 닫힘 — 남은 주문은 보내지 않고 놓침으로", window);
            }
            if (closed) {
                c.day.miss(window, o.symbol());
                continue;
            }
            Sent sent = executor.send(new Send(c.today, purpose, batch.id(), null, null, o.symbol(), o.side(), quantity, timeInForce,
                    o.refPrice(), attempt), c.cfg);
            if (sent.result() != Result.NOT_INSERTED) {
                written++;
            }
            if (!live(c)) {
                break;
            }
        }
        return written;
    }

    // ------------------------------------------------------------------ 장중 따라 하기
    /** 장중 따라 하기 하나의 대상 — {@code win}은 그 주문의 창(보내기 직전에 다시 봄). */
    private record Due(DueOrder order, String window, Window win, int attempt, List<OrderRow> rows) {
    }

    /**
     * 장중 따라 하기(명세 §3.2) — 따라 할 시각이 지난 모의 대기 주문(시가 맞추기가 흡수한 것 제외)마다 그 창 안에서, 같은 뿌리는 한 번만. 따라 할 수 없는
     * 시점은 건너뜀·알림. 창이 지나도록 행이 없으면 놓침. 보낼 것이 없거나(이미 맞음) 구조적으로 건너뛴 뿌리는 그날 다시 보지 않고, 미룸·이 기능 주문 진행
     * 중은 다음 주기에 다시 봅니다.
     */
    private void runMirror(Cycle c, List<DueOrder> upcoming) {
        Day w = c.day.windows;
        if (w.intraday() == null && w.close() == null) {
            return;
        }
        Set<Long> absorbed = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC).map(b -> Set.copyOf(b.absorbedOrderIds()))
                .orElse(Set.of());
        List<Due> due = new ArrayList<>();
        for (DueOrder o : upcoming) {
            if (absorbed.contains(o.orderId()) || (o.supported() && (o.mirrorAt() == null || o.mirrorAt().isAfter(c.now)))) {
                continue;
            }
            long root = o.rootOrderId();
            if (!o.supported()) {
                if (c.day.skip(RealTradePlanner.WINDOW_MIRROR, "timing-unsupported", "root:" + root)) {
                    store.addEvent(MARKET, RealTradeNotices.EVENT_SKIPPED, null,
                            Map.of("reason", "timing-unsupported", "count", 1, "date", c.today.toString()), true);
                }
                continue;
            }
            boolean close = RealTradePlanner.WINDOW_CLOSE.equals(o.timing());
            String window = close ? RealTradePlanner.WINDOW_CLOSE : RealTradePlanner.WINDOW_MIRROR;
            List<OrderRow> rows = store.ordersForRoot(MARKET, root).stream()
                    .filter(row -> RealTradeStore.PURPOSE_MIRROR.equals(row.purpose())).toList();
            Window win = RealTradePlanner.mirrorWindow(w, o.mirrorAt(), close);
            Map<String, Set<String>> windowSkips = c.day.skipped.getOrDefault(window, Map.of());
            boolean deferred = DEFERRED_SKIPS.stream().anyMatch(reason -> windowSkips.getOrDefault(reason, Set.of()).contains("root:" + root));
            if (win == null || c.now.isAfter(win.end())) {
                if (rows.isEmpty() && !c.day.handledRoots.contains(root) && !deferred) {
                    c.day.miss(window, "root:" + root);
                }
                continue;
            }
            if (c.now.isBefore(win.start()) || c.day.handledRoots.contains(root)) {
                continue;
            }
            int attempt = nextAttempt(rows, null, RealTradeStore.PURPOSE_MIRROR, true);
            if (attempt == 0) {
                if (!rows.isEmpty() && rows.getLast().terminal()) {
                    c.day.handledRoots.add(root);
                }
                continue;
            }
            due.add(new Due(o, window, win, attempt, rows));
        }
        if (due.isEmpty()) {
            return;
        }
        Set<String> symbols = new TreeSet<>();
        Set<String> sell = new TreeSet<>();   // 장중 따라 하기는 원 주문 방향으로만 — 매도 주문의 종목만 매도 가능 수량을 물음
        due.forEach(x -> {
            symbols.add(x.order().ticker());
            if (RealTradePlanner.SELL.equals(x.order().side())) {
                sell.add(x.order().ticker());
            }
        });
        Fresh f = fresh(c, symbols, RealTradeStore.PURPOSE_MIRROR, sell);
        if (f == null || !lossCheck(c, f)) {
            return;
        }
        Set<String> blocked = new HashSet<>(f.blocked());
        BigDecimal reserved = f.reserved();
        int ordersLeft = f.daily().orders();
        BigDecimal buyLeft = f.daily().buyKrw();
        for (Due x : due) {
            DueOrder o = x.order();
            long root = o.rootOrderId();
            String key = "root:" + root;
            Optional<WeightAfter> weight = paper.weightAfter(c.cfg.sourceBook(), o.orderId(), c.now);
            if (weight.isEmpty() || weight.get().unpricedOrderIds().contains(o.orderId())) {
                recordSkips(c, x.window(), List.of(new Skip(o.ticker(), null, RealTradePlanner.SKIP_WEIGHT)), key);
                c.day.handledRoots.add(root);
                continue;
            }
            Plan plan = RealTradePlanner.mirror(o.ticker(), o.side(), weight.get().weightPct(), f.equity(), f.account(), blocked, reserved,
                    rules(c, f).withDaily(ordersLeft, buyLeft));
            recordSkips(c, x.window(), plan.skipped(), key);
            if (plan.orders().isEmpty()) {
                if (plan.skipped().stream().noneMatch(s -> TRANSIENT_SKIPS.contains(s.reason()))) {
                    c.day.handledRoots.add(root);   // 이미 맞음·구조적 건너뜀 — 그날 다시 보지 않음
                }
                continue;
            }
            Order planned = plan.orders().getFirst();
            int quantity = x.attempt() == 2 ? Math.min(planned.quantity(), remaining(x.rows(), null, RealTradeStore.PURPOSE_MIRROR))
                    : planned.quantity();
            if (quantity < 1) {
                c.day.handledRoots.add(root);
                continue;
            }
            if (clock.instant().isAfter(x.win().end())) {   // 앞 주문의 전송이 길어져 이 주문의 창이 닫힘 — 보내지 않고 놓침(RT3-MON-4)
                log.warn("장중 따라 하기 창이 보내기 전에 닫힘 — 놓침으로");
                c.day.miss(x.window(), key);
                continue;
            }
            Sent sent = executor.send(new Send(c.today, RealTradeStore.PURPOSE_MIRROR, null, o.orderId(), root, planned.symbol(),
                    planned.side(), quantity, "DAY", planned.refPrice(), x.attempt()), c.cfg);
            if (!live(c)) {
                return;
            }
            switch (sent.result()) {
                case NOT_INSERTED -> c.day.handledRoots.add(root);   // 선점 실패(장중 교체가 먼저 취소·대기 아님) 또는 같은 키
                case ACCEPTED, UNKNOWN -> {
                    c.day.handledRoots.add(root);
                    blocked.add(planned.symbol());
                    ordersLeft--;
                    if (planned.buy()) {
                        reserved = reserved.add(planned.reserve());
                        buyLeft = buyLeft.subtract(planned.reserve());
                    }
                }
                case REJECTED -> {   // 토스 거절 — 오늘 주문 목록에 남을 수 있어 건수에서 뺌, 시도 2 조건이면 다음 주기
                    blocked.add(planned.symbol());
                    ordersLeft--;
                }
                default -> blocked.add(planned.symbol());   // 안 보냄 — 시도 2 조건이면 다음 주기
            }
        }
    }

    // ------------------------------------------------------------------ 시도 번호
    /**
     * 다음 시도 번호(명세 §4) — 행이 없으면 1, 앞 시도(1)가 종료이고 지나가는 장애로 거절·안 보냄이거나({@code partial}이면) 접수 뒤 종료에 덜 체결이면 2,
     * 그 밖(진행 중·이미 2번·전량 체결·다시 보내도 같은 거절)은 0.
     *
     * @param symbol 묶음 안의 종목(장중 따라 하기는 null — 뿌리의 행 전부)
     */
    static int nextAttempt(List<OrderRow> rows, String symbol, String purpose, boolean partial) {
        List<OrderRow> mine = rows.stream().filter(r -> purpose.equals(r.purpose()) && (symbol == null || symbol.equals(r.symbol())))
                .sorted((a, b) -> Integer.compare(a.attempt(), b.attempt())).toList();
        if (mine.isEmpty()) {
            return 1;
        }
        OrderRow last = mine.getLast();
        if (last.attempt() >= 2 || !last.terminal()) {
            return 0;
        }
        boolean refused = RealTradeStore.OUTCOME_REJECTED.equals(last.sendOutcome()) || RealTradeStore.OUTCOME_NOT_SENT.equals(last.sendOutcome());
        if (refused) {
            return last.outcomeCode() != null && RETRYABLE.contains(last.outcomeCode()) ? 2 : 0;
        }
        if (partial && last.tossOrderId() != null && last.filledQuantity() != null
                && last.filledQuantity().compareTo(BigDecimal.valueOf(last.quantity())) < 0) {
            return 2;
        }
        return 0;
    }

    /** 시도 2가 보낼 수 있는 남은 수량 — 시도 1의 수량 − 체결 수량(거절·안 보냄이면 수량 전부). */
    static int remaining(List<OrderRow> rows, String symbol, String purpose) {
        return rows.stream().filter(r -> purpose.equals(r.purpose()) && (symbol == null || symbol.equals(r.symbol())) && r.attempt() == 1)
                .findFirst().map(r -> {
                    BigDecimal filled = r.filledQuantity() == null ? BigDecimal.ZERO : r.filledQuantity();
                    return Math.max(0, BigDecimal.valueOf(r.quantity()).subtract(filled).setScale(0, RoundingMode.FLOOR).intValue());
                }).orElse(0);
    }

    // ------------------------------------------------------------------ 계좌·한도
    /**
     * 새 사전 조회(캐시 없음) + 토스 미체결 목록 + 오늘 주문 목록 → 계획 입력. 매도 가능 수량은 {@code sell}의 종목만 묻습니다(시가 맞추기류는
     * {@link #planSync}가 두 단계로, 장중 따라 하기는 매도 주문의 종목만 — 수집기 사전 조회의 시간 예산). 같은 창(용도)에서 이미 잡은 매수(아직 종료
     * 아님)의 상한가 합, 손실 판정용 평가액(이 기능의 미종료 매수 가운데 토스가 접수한 것의 남은 수량 × 상한가 — 모르면 기준가 — 를 매수 가능 금액에
     * 되돌림: 토스가 미체결 매수에 매수 가능 금액을 잡아도 손실로 보지 않게), 수집기 하루 한도의 오늘 남은 몫을 함께 돌려줍니다. 하나라도 못 읽으면
     * null(보내지 않음).
     */
    private Fresh fresh(Cycle c, Collection<String> symbols, String purpose, Collection<String> sell) {
        Set<String> ask = new TreeSet<>(symbols);
        List<OrderRow> unfinished = store.unfinishedOrders(MARKET);
        List<OrderRow> reserving = store.ordersOn(MARKET, c.today).stream()
                .filter(row -> purpose.equals(row.purpose()) && RealTradePlanner.BUY.equals(row.side()) && !row.terminal()).toList();
        reserving.forEach(row -> ask.add(row.symbol()));
        unfinished.stream().filter(row -> RealTradePlanner.BUY.equals(row.side())).forEach(row -> ask.add(row.symbol()));
        Reply<Preflight> reply = client.preflight(ask, sell);
        if (!reply.ok()) {
            log.warn("사전 조회 실패 — 이번 주기는 보내지 않음 ({})", reply.reason());
            return null;
        }
        Reply<List<CollectorTradeClient.BrokerOrder>> open = client.openOrders();
        if (!open.ok()) {
            log.warn("토스 미체결 목록을 읽지 못함 — 이번 주기는 보내지 않음 ({})", open.reason());
            return null;
        }
        Reply<List<CollectorTradeClient.BrokerOrder>> today = client.todayOrders();
        if (!today.ok()) {
            log.warn("오늘 주문 목록을 읽지 못함(하루 한도를 셀 수 없음) — 이번 주기는 보내지 않음 ({})", today.reason());
            return null;
        }
        Account account = RealTradePlanner.account(reply.value(), open.value());
        Optional<DailyRoom> daily = dailyRoom(c.limits, account, open.value(), today.value());
        if (daily.isEmpty()) {
            return null;
        }
        BigDecimal cap = BigDecimal.valueOf(c.limits.maxEquityKrw());
        Optional<BigDecimal> total = RealTradePlanner.equity(account, null);
        Optional<BigDecimal> equity = RealTradePlanner.equity(account, cap);
        if (total.isEmpty() || equity.isEmpty()) {
            log.warn("운용 평가액을 정하지 못함(보유 가격 모름) — 이번 주기는 보내지 않음");
            return null;
        }
        BigDecimal reserved = BigDecimal.ZERO;
        for (OrderRow row : reserving) {
            BigDecimal upper = account.upper(row.symbol());
            if (upper == null) {
                upper = row.refPrice() == null ? null : row.refPrice().multiply(UPPER_FALLBACK);
            }
            if (upper == null) {
                log.warn("잡아 둔 매수의 상한가를 모름 — 이번 주기는 보내지 않음");
                return null;
            }
            reserved = reserved.add(upper.multiply(BigDecimal.valueOf(row.quantity())));
        }
        BigDecimal held = BigDecimal.ZERO;
        for (OrderRow row : unfinished) {
            if (!RealTradePlanner.BUY.equals(row.side()) || row.tossOrderId() == null) {
                continue;
            }
            BigDecimal filled = row.filledQuantity() == null ? BigDecimal.ZERO : row.filledQuantity();
            BigDecimal remaining = BigDecimal.valueOf(row.quantity()).subtract(filled);
            if (remaining.signum() <= 0) {
                continue;
            }
            BigDecimal unit = account.upper(row.symbol()) != null ? account.upper(row.symbol()) : row.refPrice();
            if (unit == null) {
                log.warn("미체결 매수의 상한가·기준가를 모름 — 이번 주기는 보내지 않음");
                return null;
            }
            held = held.add(remaining.multiply(unit));
        }
        BigDecimal lossTotal = total.get().add(held);
        Set<String> blocked = new HashSet<>();
        unfinished.forEach(row -> blocked.add(row.symbol()));
        notePreflight(reply.value(), account, equity.get(), lossTotal, c.now);
        return new Fresh(account, equity.get(), blocked, reserved, lossTotal, lossTotal.min(cap), daily.get());
    }

    /**
     * 수집기 하루 한도의 오늘 남은 몫(명세 §5.2) — 오늘 주문 목록으로 수집기와 같은 식({@link RealTradePlanner#dailyUsage})으로 센 쓴 몫을 한도에서 뺍니다.
     * 진행 중 매수의 상한가를 {@code account}가 모르면 그 종목만 한 번 더 사전 조회로 묻습니다. 못 세면 empty(수집기도 그때는 보내지 않음). 켜기 창 예상
     * 목록도 씁니다.
     */
    Optional<DailyRoom> dailyRoom(Limits limits, Account account, List<CollectorTradeClient.BrokerOrder> open,
                                  List<CollectorTradeClient.BrokerOrder> today) {
        Set<String> openIds = new HashSet<>();
        open.forEach(o -> {
            if (o.orderId() != null) {
                openIds.add(o.orderId());
            }
        });
        Map<String, BigDecimal> uppers = new HashMap<>();
        Set<String> missing = new TreeSet<>();
        for (String symbol : RealTradePlanner.dailyUpperSymbols(today, openIds)) {
            BigDecimal upper = account.upper(symbol);
            if (upper != null) {
                uppers.put(symbol, upper);
            } else {
                missing.add(symbol);
            }
        }
        if (!missing.isEmpty()) {
            Reply<Preflight> extra = client.preflight(missing, Set.of());
            if (!extra.ok()) {
                log.warn("진행 중 매수의 상한가를 읽지 못함(하루 한도를 셀 수 없음) — 이번 주기는 보내지 않음 ({})", extra.reason());
                return Optional.empty();
            }
            extra.value().quotes().forEach((symbol, q) -> {
                if (missing.contains(symbol) && q.upperLimitPrice() != null && q.upperLimitPrice().signum() > 0) {
                    uppers.put(symbol, q.upperLimitPrice());
                }
            });
        }
        Optional<RealTradePlanner.DailyUsage> usage = RealTradePlanner.dailyUsage(today, openIds, uppers::get);
        if (usage.isEmpty()) {
            log.warn("오늘 주문의 하루 한도 사용량을 셀 수 없음 — 이번 주기는 보내지 않음");
            return Optional.empty();
        }
        int orders = Math.max(0, limits.maxOrdersPerDay() - usage.get().orders());
        BigDecimal buy = BigDecimal.valueOf(limits.maxBuyKrwPerDay()).subtract(usage.get().buyKrw()).max(BigDecimal.ZERO);
        return Optional.of(new DailyRoom(orders, buy));
    }

    private Rules rules(Cycle c, Fresh f) {
        return new Rules(BigDecimal.valueOf(c.limits.maxOrderKrw()), c.cashLike, c.cfg.buysPaused(), true, f.daily().orders(),
                f.daily().buyKrw());
    }

    /**
     * 손실 한도(명세 §7.3) — 기준 총액(켤 때의 상한 없는 총액 U0) − 지금 상한 없는 총액({@link Fresh#lossTotal} — 이 기능의 미체결 매수가 잡은 금액을
     * 되돌린 값) ≥ 기준 평가액(E0, 안전 상한 적용) × 한도%면 매수 멈춤({@code buys_paused})을 켜고 알립니다(매도는 계속). 총액이 상한보다 커도 운용분의
     * 손실을 잡습니다(RT-BE-3 — 상한을 적용한 E로 재면 상한 밖 현금이 손실을 가림). 기준 총액을 모르는 설정(그 칸 전에 켬)은 예전 식(손실 판정용 E ≤
     * E0 × (1 − 한도%)). 설정이 그사이 바뀌었으면 false(이번 주기의 나머지를 하지 않음).
     */
    private boolean lossCheck(Cycle c, Fresh f) {
        Config cfg = c.cfg;
        if (cfg.buysPaused() || cfg.baselineEquity() == null) {
            return true;
        }
        if (!lossBreached(cfg, f.lossTotal(), f.lossEquity())) {
            return true;
        }
        Config updated = store.lockConfig(MARKET, current -> {
            if (!sameState(current, cfg) || !store.updateConfig(current.withBuysPaused(true), null)) {
                return null;
            }
            store.addEvent(MARKET, RealTradeStore.EVENT_BUYS_PAUSED, null,
                    Map.of("reason", "loss-limit", "lossLimitPct", cfg.lossLimitPct(), "date", c.today.toString()), true);
            return store.config(MARKET).orElse(null);
        });
        if (updated == null) {
            return false;
        }
        log.warn("손실 한도 — 새 매수 멈춤(매도는 계속)");
        c.cfg = updated;
        return true;
    }

    /** 손실 한도에 닿았는가({@link #lossCheck}의 식) — 기준 총액이 있으면 (U0 − U) ≥ E0 × 한도%, 없으면 E ≤ E0 × (1 − 한도%). */
    static boolean lossBreached(Config cfg, BigDecimal total, BigDecimal equity) {
        BigDecimal limit = cfg.baselineEquity().multiply(cfg.lossLimitPct().movePointLeft(2));
        if (cfg.baselineTotal() != null) {
            return cfg.baselineTotal().subtract(total).compareTo(limit) >= 0;
        }
        return equity.compareTo(cfg.baselineEquity().subtract(limit)) <= 0;
    }

    /** 계획 때와 같은 켜짐인가(상태·버전·책·세대). */
    private static boolean sameState(Config current, Config planned) {
        return RealTradeStore.STATE_LIVE.equals(current.state()) && current.version() == planned.version()
                && Objects.equals(current.sourceBook(), planned.sourceBook())
                && Objects.equals(current.bookGeneration(), planned.bookGeneration());
    }

    private static boolean throttled(Instant last, Instant now) {
        return last != null && now.isBefore(last.plus(RETRY_SPACING));
    }

    /** 묶음의 목표 비중(종목 → %). */
    private static Map<String, Double> weights(Batch batch) {
        Map<String, Double> out = new TreeMap<>();
        JsonNode targets = batch.targets();
        if (targets != null && targets.isObject()) {
            for (Map.Entry<String, JsonNode> e : targets.properties()) {
                if (e.getValue().isNumber()) {
                    out.put(e.getKey(), e.getValue().asDouble());
                }
            }
        }
        return out;
    }

    /** 건너뜀을 그날 창 집계에 넣고, 반대 방향 미체결 같은 알림 사유는 처음 볼 때 알림 이벤트로. */
    private void recordSkips(Cycle c, String window, List<Skip> skips, String key) {
        Map<String, Integer> fresh = new TreeMap<>();
        for (Skip s : skips) {
            String target = key != null ? key : String.valueOf(s.symbol());
            if (c.day.skip(window, s.reason(), target) && NOTIFY_SKIPS.contains(s.reason())) {
                fresh.merge(s.reason(), 1, Integer::sum);
            }
        }
        fresh.forEach((reason, n) -> store.addEvent(MARKET, RealTradeNotices.EVENT_SKIPPED, null,
                Map.of("reason", reason, "count", n, "window", window, "date", c.today.toString()), true));
    }

    /**
     * 같은 오류 반복(명세 §7.3) — 마지막 켜기·바꾸기·멈춤 해제 뒤 오늘 행 중 같은 사유 코드(종목 단위 건너뜀·429·기록 코드 제외)의 거절·안 보냄·결과 모름이
     * {@value #REPEATED_ERROR_LIMIT}번 이상이면 그 코드.
     */
    private String repeatedError(LocalDate today) {
        Instant since = null;
        for (Event e : store.recentEvents(MARKET, 50)) {
            if (List.of(RealTradeStore.EVENT_ENABLE, RealTradeStore.EVENT_RESUME, RealTradeStore.EVENT_UPDATE).contains(e.kind())) {
                since = e.at();
                break;
            }
        }
        Map<String, Integer> counts = new TreeMap<>();
        for (OrderRow row : store.ordersOn(MARKET, today)) {
            if (since != null && row.createdAt() != null && row.createdAt().isBefore(since)) {
                continue;
            }
            boolean failed = RealTradeStore.OUTCOME_REJECTED.equals(row.sendOutcome()) || RealTradeStore.OUTCOME_NOT_SENT.equals(row.sendOutcome())
                    || RealTradeStore.OUTCOME_UNKNOWN.equals(row.sendOutcome());
            if (failed && row.outcomeCode() != null && !REPEAT_EXEMPT.contains(row.outcomeCode())) {
                counts.merge(row.outcomeCode(), 1, Integer::sum);
            }
        }
        return counts.entrySet().stream().filter(e -> e.getValue() >= REPEATED_ERROR_LIMIT).map(Map.Entry::getKey).findFirst().orElse(null);
    }

    // ------------------------------------------------------------------ 끄기 마무리
    /**
     * 끄는 중 → OFF. STOPPED 이벤트(알림)에는 끈 뒤(설정 행이 STOPPING이 된 때 — 끄는 중에는 설정 행을 바꾸는 일이 없음) 끝난 이 기능의 주문을 끝난 방식으로
     * 나눈 건수(취소로 끝남 {@code canceled}·체결로 끝남 {@code filled}·그 밖 {@code other} — 토스 거절·장 마감·안 보냄 등)와 확인 필요 건수를 싣습니다
     * (SEC-5 — '정리 끝'으로 결과를 단정하지 않게).
     */
    private void finishStopping() {
        int unresolved = executor.stuckUnknown();
        Map<String, Integer> outcome = new LinkedHashMap<>();
        Boolean done = store.lockConfig(MARKET, current -> {
            if (!RealTradeStore.STATE_STOPPING.equals(current.state())) {
                return false;
            }
            int canceled = 0;
            int filled = 0;
            int other = 0;
            for (OrderRow row : current.updatedAt() == null ? List.<OrderRow>of() : store.endedSince(MARKET, current.updatedAt())) {
                if ("FILLED".equals(row.brokerStatus())) {
                    filled++;
                } else if ("CANCELED".equals(row.brokerStatus())) {
                    canceled++;
                } else {
                    other++;
                }
            }
            if (!store.updateConfig(current.withState(RealTradeStore.STATE_OFF).withHalt(null, null), null)) {
                return false;
            }
            outcome.put("canceled", canceled);
            outcome.put("filled", filled);
            outcome.put("other", other);
            outcome.put("unresolved", unresolved);
            store.addEvent(MARKET, RealTradeNotices.EVENT_STOPPED, null, outcome, true);
            return true;
        });
        if (Boolean.TRUE.equals(done)) {
            log.info("실제 매매 꺼짐 — 끈 뒤 끝난 이 기능의 주문: 취소 {} · 체결 {} · 그 밖 {}(확인 필요 {}건)", outcome.get("canceled"),
                    outcome.get("filled"), outcome.get("other"), unresolved);
        }
    }

    // ------------------------------------------------------------------ 창 요약
    /**
     * 창 요약(명세 §7.3) — 시가 맞추기(마무리 포함)는 마무리 창 끝에, 장중은 장중 창 끝에, 종가는 정규장 끝 + 3분에 한 번. 건수: 접수(토스 주문 번호가 있는
     * 행)·체결(체결 수량 &gt; 0)·놓침·건너뜀(대상 수)·막힘(거절·안 보냄)·미룸. 무엇이든 있으면 알립니다.
     */
    private void summaries(Cycle c) {
        Day w = c.day.windows;
        List<OrderRow> rows = store.ordersOn(MARKET, c.today);
        if (c.now.isAfter(w.followup().end())) {
            boolean batch = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC).isPresent();
            List<OrderRow> mine = rows.stream().filter(r -> RealTradeStore.PURPOSE_SYNC.equals(r.purpose())
                    || RealTradeStore.PURPOSE_SYNC_FOLLOWUP.equals(r.purpose())).toList();
            summarize(c, RealTradePlanner.WINDOW_SYNC, mine, List.of(RealTradePlanner.WINDOW_SYNC, RealTradePlanner.WINDOW_FOLLOWUP),
                    batch ? 0 : 1);
        }
        if (w.intraday() != null && c.now.isAfter(w.intraday().end())) {
            List<OrderRow> mine = rows.stream().filter(r -> RealTradeStore.PURPOSE_MIRROR.equals(r.purpose())
                    && !RealTradeExecutor.closingOrder(r, w)).toList();
            summarize(c, RealTradePlanner.WINDOW_MIRROR, mine, List.of(RealTradePlanner.WINDOW_MIRROR), 0);
        }
        if (w.close() != null && c.now.isAfter(w.regularEnd().plus(CLOSE_SUMMARY_DELAY))
                && !c.day.summarized.contains(RealTradePlanner.WINDOW_CLOSE)) {
            List<OrderRow> mine = rows.stream().filter(r -> RealTradeExecutor.closingOrder(r, w)).toList();
            // 종가 주문은 종가 단일가 시작(따라 할 시각)에 선점하지만 모의 기준 시각은 마감이라, 그 사이 끝난 장중 교체가 모의 주문을 취소할 수 있음
            // (PaperMirrorService 설명) — 실제 주문은 이미 나갔으므로 건너뜀 사유로 남겨 알림(다음 시가 맞추기가 목표로 되돌림).
            for (OrderRow r : mine) {
                String paperStatus = r.paperOrderId() == null ? null : paper.orderStatus(r.sourceBook(), r.paperOrderId()).orElse(null);
                if (PAPER_CANCELLED.equals(paperStatus)) {
                    c.day.skip(RealTradePlanner.WINDOW_CLOSE, "paper-cancelled-after-claim", "root:" + r.paperRootOrderId());
                }
            }
            summarize(c, RealTradePlanner.WINDOW_CLOSE, mine, List.of(RealTradePlanner.WINDOW_CLOSE), 0);
        }
    }

    private void summarize(Cycle c, String window, List<OrderRow> rows, List<String> tallies, int extraMissed) {
        if (!c.day.summarized.add(window)) {
            return;
        }
        int accepted = 0;
        int filled = 0;
        int blocked = 0;
        int unknown = 0;
        for (OrderRow r : rows) {
            if (r.tossOrderId() != null) {
                accepted++;
            }
            if (r.filledQuantity() != null && r.filledQuantity().signum() > 0) {
                filled++;
            }
            if (RealTradeStore.OUTCOME_REJECTED.equals(r.sendOutcome()) || RealTradeStore.OUTCOME_NOT_SENT.equals(r.sendOutcome())) {
                blocked++;
            }
            if (RealTradeStore.OUTCOME_UNKNOWN.equals(r.sendOutcome())) {
                unknown++;
            }
        }
        int skipped = 0;
        int deferred = 0;
        int missed = extraMissed;
        Map<String, Integer> reasons = new TreeMap<>();
        for (String t : tallies) {
            for (Map.Entry<String, Set<String>> e : c.day.skipped.getOrDefault(t, Map.of()).entrySet()) {
                reasons.merge(e.getKey(), e.getValue().size(), Integer::sum);
                if (DEFERRED_SKIPS.contains(e.getKey()) || RealTradePlanner.SKIP_BUYS_PAUSED.equals(e.getKey())) {
                    deferred += e.getValue().size();
                } else if (!RealTradePlanner.SKIP_OWN.equals(e.getKey())) {
                    skipped += e.getValue().size();
                }
            }
            missed += c.day.missed.getOrDefault(t, Set.of()).size();
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("window", window);
        detail.put("date", c.today.toString());
        detail.put("accepted", accepted);
        detail.put("filled", filled);
        detail.put("missed", missed);
        detail.put("skipped", skipped);
        detail.put("blocked", blocked);
        detail.put("deferred", deferred);
        detail.put("unknown", unknown);
        detail.put("reasons", reasons);
        boolean notify = accepted + blocked + missed + skipped + deferred + unknown > 0;
        store.addEvent(MARKET, RealTradeStore.EVENT_WINDOW_SUMMARY, null, detail, notify);
        log.info("실제 매매 창 요약({}) — 접수 {} · 체결 {} · 놓침 {} · 건너뜀 {} · 막힘 {} · 미룸 {}", window, accepted, filled, missed, skipped,
                blocked, deferred);
    }

    // ------------------------------------------------------------------ 알림
    /** 알림 대기 이벤트를 차례로 보냅니다(한 주기 {@value #NOTIFY_PER_CYCLE}통). 실패하면 거기서 멈추고 다음 주기에 그 통부터. */
    void notifyPending(Instant now) {
        if (!telegram.configured()) {
            return;
        }
        for (Event e : store.unnotifiedEvents(NOTIFY_PER_CYCLE)) {
            String text = RealTradeNotices.text(e);
            if (text != null) {
                String error = telegram.send(text);
                if (error != null) {
                    log.warn("실제 매매 알림 실패 — 다음 주기에 다시");
                    return;
                }
            }
            store.markNotified(e.id(), now);
        }
    }
}
