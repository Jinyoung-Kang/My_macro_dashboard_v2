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
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
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
import com.macrodash.store.RealTradeStore.Valuation;
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
import java.util.LinkedHashSet;
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
 *   <li>남은 SENDING 정리 → 진행 중 주문 추적(상태와 무관하게 늘) → 결과 모름 재전송·대조(대조는 꺼짐에서도 — 꺼짐·이상 멈춤에서는 지난 세션 행을
 *       조회하지 않고 당일 행은 간격을 둠, QA-380).</li>
 *   <li>끄는 중(STOPPING)·멈춤(HALTED)이면 이 기능의 미체결 취소만, 정리가 끝나면(그 주기의 대조가 토스 목록을 읽었을 때만) STOPPING → OFF. 꺼짐(OFF)에서도
 *       대조로 늦게 묶인 이 기능의 토스 주문은 취소.</li>
 *   <li>켜짐(LIVE)이 아니면 끝. 따라 하는 책이 운용 중이 아니거나 세대가 다르면 이상 멈춤. 옛 책·세대의 미체결은 취소.</li>
 *   <li>수집기 스위치(꺼졌다고 분명히 답하면 이상 멈춤, 읽지 못하면 그 주기만 건너뜀)·토큰 경합·같은 오류 반복 확인 → 오늘 토스 장 운영 정보·쉬는 날
 *       판정(그날 첫 창과 정규장 시작 + 10분 가운데 이른 쪽의 3분 전에 한 번 — QA-377) → 창 3분 전 토큰 예열. 따라 하는 책이 그 세션에 개장 10분 뒤 지정 시각으로 체결하면
 *       ({@link PaperMirrorService#dailySyncAt}) 시가 단일가 맞추기 창 없이 그 시각부터 3분의 시각 맞추기 창(시장가 DAY 묶음 — ADR 0033 결정 1)을
 *       둡니다. 그 창의 목표는 그 시각까지의 모의 주문을 반영하고({@link PaperMirrorService#targetsAt}), 기준 시각이 맞추기 시각 이하인 주문은 장중 따라
 *       하기가 따로 보내지 않습니다(묶음 몫).</li>
 *   <li>창마다 새 사전 조회(매도 가능 수량은 팔 종목만 — 시가 맞추기류는 두 단계) + 오늘 주문 목록(수집기 하루 한도의 남은 몫) → 손실 한도(넘으면 매수만
 *       멈춤) → 계획({@link RealTradePlanner}) → 선점·SENDING·전송·결과({@link RealTradeExecutor}). 보내기 직전마다 지금 시각으로 그 창이 아직 열려 있는지
 *       다시 보고, 닫혔으면 보내지 않고 놓침으로 둡니다(RT3-MON-4). 창이 끝나면 창 요약 이벤트(접수·체결·놓침·건너뜀·막힘·미룸).</li>
 *   <li>마지막 운용 평가액(2026-11-08 — {@link #refreshValuation}): 창 안 사전 조회가 남긴 값을 V29 표에 저장하고(재기동 뒤 다시 읽음), 마지막 거래일
 *       마감 뒤 값이 없으면 창 밖에서 읽기 전용 사전 조회로 한 번 읽습니다(상태와 무관 — 휴장일·토스 점검 동안에도 화면이 마지막 값을 보이게). 주문·손실
 *       판정은 이 값을 쓰지 않습니다.</li>
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
    /** 마감 뒤 운용 평가액 읽기({@link #refreshValuation}) — 거래일 마감 + 이만큼 뒤의 값이 그날 마감 값입니다. */
    static final Duration VALUATION_AFTER_CLOSE = Duration.ofMinutes(10);
    /** 마감 뒤 읽기가 실패하면(토스 점검·수집기 꺼짐 등) 이만큼 뒤 다시. */
    static final Duration VALUATION_RETRY = Duration.ofMinutes(15);
    /** 거래일 개장 이만큼 전부터 마감 뒤까지는 마감 뒤 읽기를 하지 않음(창 안 사전 조회가 맡음 — 토스 호출을 늘리지 않게). */
    static final Duration VALUATION_QUIET_BEFORE_OPEN = Duration.ofMinutes(30);
    /** 마지막 거래일 마감을 찾아 거슬러 보는 날 수(연휴). */
    static final int VALUATION_LOOKBACK_DAYS = 14;
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
    /** 토스의 접수 불가 거절 — 서킷브레이커처럼 시장 전체가 멈춘 때 올 수 있음(무엇이 오는지는 스펙에 없음). */
    static final String CODE_MARKET_CLOSED = "order-hours-closed";
    /** 토스의 종목 주문 제한 거절 — VI·거래정지 등. */
    static final String CODE_STOCK_RESTRICTED = "stock-restricted";
    /** 토스의 호가 유형 거절 — 단일가 구간의 시장가 등. */
    static final String CODE_ORDER_TYPE_NOT_ALLOWED = "order-type-not-allowed";
    /** 접수 불가 거절 뒤 시각 맞추기 전체를 쉬는 시간(거절 한 번이 시도 하나를 쓰므로 자주 묻지 않음). */
    static final Duration MARKET_REFUSED_HOLD = Duration.ofMinutes(10);
    /** 종목 제한 거절 뒤 그 종목을 쉬는 시간(VI 2분 남짓 + 여유). */
    static final Duration SYMBOL_REFUSED_HOLD = Duration.ofMinutes(3);
    /** VI 종목을 처음 본 뒤 기다리는 상한 — 넘으면 보냄(KRX VI 단일가는 호가를 받으므로 체결은 됨, VI 표시가 안 풀려도 그날을 잃지 않게). */
    static final Duration VI_WAIT_LIMIT = Duration.ofMinutes(6);
    /** 대기 사유 코드(알림). */
    static final String RESTRICTED_CIRCUIT = "circuit-breaker";
    static final String RESTRICTED_VI = "vi-active";
    static final String RESTRICTED_REFUSED = "order-refused";

    /**
     * 주문을 낼 준비가 안 된 채 개장이 가까워짐(QA-342) — 토스 장 운영 정보를 끝내 받지 못함·수집기 매매 상태를 읽지 못함. 멈춤이 아니고(받는 대로 이어 감)
     * 하루 한 번 알림 이벤트({@link RealTradeNotices#EVENT_UNAVAILABLE})만 남깁니다. 예전에는 경고 로그뿐이라 그날 맞추기·스탑 매도가 통째로 빠져도
     * 텔레그램·화면 이벤트가 없었습니다.
     */
    static final String UNAVAILABLE_CALENDAR = "calendar-unavailable";
    static final String UNAVAILABLE_STATUS = "status-unavailable";

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
            "over-daily-orders", "over-daily-buy", CODE_OUTSIDE_WINDOW, CODE_MARKET_CLOSED, CODE_STOCK_RESTRICTED,
            CODE_ORDER_TYPE_NOT_ALLOWED,
            RealTradeExecutor.CODE_INTERRUPTED, RealTradeExecutor.CODE_RECONCILED, RealTradeExecutor.CODE_OPERATOR_RESOLVED);
    /** 새 키(시도 2)로 다시 보내도 되는 거절·안 보냄 사유(지나가는 장애) — 같은 결과가 나올 것이 뻔한 한도·창·형식 거절은 다시 보내지 않습니다. */
    static final Set<String> RETRYABLE = Set.of("rate-limited", "collector-unreachable", "token-failed", "timeout",
            "calendar-unavailable", "account-unavailable", "price-unavailable", "count-unavailable", "connect-timeout", "connect-failed",
            CODE_MARKET_CLOSED, CODE_STOCK_RESTRICTED, CODE_ORDER_TYPE_NOT_ALLOWED);
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
    /** 저장하지 않은 새 사전 조회가 있음 — 주기 끝에 주문 흐름·트랜잭션 밖에서 V29 표에 씀({@link #persistValuation}). */
    private volatile boolean valuationDirty;
    /** 저장된 마지막 운용 평가액을 한 번 읽어 봄(작업 스레드만). */
    private boolean valuationLoaded;
    /** 마감 뒤 읽기를 마지막으로 시도한 시각(작업 스레드만). */
    private Instant valuationTriedAt;
    private volatile Instant lastCycleAt;
    /** 정기 작업을 시작한 시각(화면용 — 주기를 한 번도 끝내지 못해도 멈춤 판정의 기준이 되게, RT2-FE-2). */
    private volatile Instant startedAt;

    /** 오늘(KST) — 쉬는 사유(정해지기 전이면 null)와 창. */
    record TodayView(LocalDate date, String skipReason, List<Window> windows) {
    }

    /**
     * 마지막으로 토스에서 새로 읽은 값(화면용). {@code equity}는 안전 상한을 적용한 E, {@code total}은 손실 판정의 '지금 값'(상한 없는
     * 총액 — 정기 작업은 토스 미체결 매수(이 기능의 주문, 그리고 QA-379부터 앱 주문의 하한)가 잡은 금액을 되돌린 값, 모르면 null). 금액 셋과 시각은 V29
     * 표에도 남고(2026-11-08), 재기동 뒤 그 표에서
     * 되살린 값은 {@code holdings}가 비어 있습니다(보유는 저장하지 않음).
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
        valuationDirty = true;
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
                // 못한 결과 모름 행이 꺼진 뒤 대조로 늦게 묶인 것(RT3-BE-1, 정상이면 꺼짐에 그런 행은 없음). 대조 목록을 못 읽은 주기와, 꺼짐·이상 멈춤으로
                // 읽고 시작해 조회를 아낀 행이 있던 주기(QA-380 — 도중에 끄기가 커밋된 경우)에는 OFF로 넘기지 않음.
                boolean stopping = RealTradeStore.STATE_STOPPING.equals(cfg.state());
                if (stopping || RealTradeStore.STATE_HALTED.equals(cfg.state()) || executor.openBrokerOrders() > 0) {
                    executor.cancelOpen(now, row -> true);
                }
                if (stopping && !resolution.listsFailed() && resolution.spared() == 0 && executor.cleanupDone(now)) {
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
                // 수집기 상태를 읽지 못함·한도 해석 실패 — 주문 없음(멈춤 아님, 화면은 '확인 안 됨'). 개장이 가깝도록 이어지면 하루 한 번 알림(QA-342)
                noteUnavailable(d, now, UNAVAILABLE_STATUS);
                return;
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
                noteUnavailable(d, now, UNAVAILABLE_CALENDAR);   // 재시도는 계속(60초마다) — 개장이 가깝도록 못 받으면 하루 한 번 알림(QA-342)
                return;
            }
            decide(d, now, cfg);
            if (d.skipReason != null) {
                recordSkip(d);
                if (RealTradePlanner.SKIP_LEDGER.equals(d.skipReason) && d.windows != null) {
                    // 장부 밀림으로 쉬는 날에도 스탑 매도만(ADR 0033 결정 2) — 매도는 실제 보유까지만이라 위험을 줄이는 쪽이고, 1분봉 수집 실패가
                    // 손절을 하루 미루지 않게. 묶음·장중 따라 하기는 하지 않습니다. 휴장·장 시간 불일치·시계 어긋남·달력 날짜 불일치는 아무것도 하지 않음.
                    Cycle c = new Cycle(now, d, cfg, status.value().limits(), paper.cashLikeTickers());
                    List<DueOrder> stops = paper.dueOrders(cfg.sourceBook(), today, now.plus(WARMUP_LEAD)).stream().filter(DueOrder::stop)
                            .toList();
                    warmup(c, stops);
                    if (live(c)) {
                        runMirror(c, stops);
                    }
                }
                return;
            }
            if (d.decidedFor == null || d.windows == null) {
                return;   // 아직 그날 처음 주문이 나갈 수 있는 시각(첫 창·정규장 시작 + 10분 가운데 이른 쪽)의 3분 전이 아님
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
                valuation(now);
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
     * 새로 읽은 계좌 — 계획 입력, E, 이 기능의 미종료 주문 종목, 같은 창에서 이미 잡은 매수의 상한가 합, 손실 판정용 평가액(토스 미체결 매수가 잡은
     * 금액을 되돌린 값 — 이 기능의 주문과 앱 주문의 하한(QA-379), 상한 없는 {@code lossTotal}, 안전 상한 적용 {@code lossEquity}), 수집기 하루 한도의 오늘
     * 남은 건수·매수 금액.
     */
    private record Fresh(Account account, BigDecimal equity, Set<String> blocked, BigDecimal reserved, BigDecimal lossTotal,
                         BigDecimal lossEquity, DailyRoom daily) {

        /** 이번 계획에서 더 뺄 종목(매매 제한)을 더한 값. */
        Fresh alsoBlocked(Set<String> more) {
            if (more.isEmpty()) {
                return this;
            }
            Set<String> all = new HashSet<>(blocked);
            all.addAll(more);
            return new Fresh(account, equity, all, reserved, lossTotal, lossEquity, daily);
        }
    }

    /** 수집기 하루 한도의 오늘 남은 몫(명세 §5.2 — 한도 − 오늘 쓴 몫, 0 아래는 0). */
    record DailyRoom(int orders, BigDecimal buyKrw) {
    }

    /**
     * 사전 조회와 그것으로 낸 계획. {@code restricted}는 이번 계획에서 매매 제한(VI·거절 대기)으로 뺀 종목, {@code ownBlocked}는 그것을 더하기 전의
     * 이 기능 미종료 주문 종목({@link Fresh#blocked}) — 묶음의 회전율이 기다리는 전량 매도 대상을 셀 때 씁니다({@link #withWaitingLiquidations}).
     */
    private record Planned(Fresh fresh, Plan plan, Set<String> restricted, Set<String> ownBlocked) {
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
        /** 그날 창을 굳힌 책과 세대(QA-377 — 쉬는 판정과 따로: 첫 창 3분 전에 굳히고, 그 전까지는 주기마다 맞추기 시각을 다시 셈. 책·세대가 바뀌면 다시). */
        String windowsFor;
        String skipReason;
        boolean skipRecorded;
        /** 창 → 사유 → 건너뛴 대상(종목 또는 모의 주문 뿌리) — 같은 대상은 한 번만 셈. */
        final Map<String, Map<String, Set<String>>> skipped = new HashMap<>();
        final Map<String, Set<String>> missed = new HashMap<>();
        final Set<Long> handledRoots = new HashSet<>();
        /** 놓침을 스탑 매도 알림에 이미 센 스탑 뿌리(같은 놓침을 주기마다 다시 세지 않게). */
        final Set<Long> stopMissCounted = new HashSet<>();
        /** 그날 이미 알린 '준비 안 됨' 사유(QA-342 — 하루 한 번, 다시 띄우면 그날 이벤트에서 되살림). */
        final Set<String> unavailableNoticed = new HashSet<>();
        /** 모의 달력의 그날 장 시간(준비 안 됨 알림의 기준 — 달력이 답한 뒤로는 다시 묻지 않음). */
        SessionHours paperHours;
        final Set<String> summarized = new HashSet<>();
        Instant lastSyncTry;
        Instant lastFollowupTry;
        Instant lastWarmup;
        boolean followupDone;
        /** 낡았다고 판정한 그날 묶음 번호(한 번 낡으면 그날 계속 낡음). */
        Long staleBatch;
        /** 매매 제한 대기(시각 맞추기만, 메모리) — 지금까지 본 서킷브레이커 단계, 시장 전체를 보내지 않는 끝, VI를 처음 본 시각, 거절로 쉬는 종목의 끝, 알린 사유. */
        int circuitStage;
        Instant marketHoldUntil;
        final Map<String, Instant> viSince = new HashMap<>();
        final Map<String, Instant> symbolHoldUntil = new HashMap<>();
        final Set<String> restrictionNoticed = new HashSet<>();

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
        // 그날 스탑 매도 알림에 이미 센 뿌리(놓침·막힘)를 되살립니다(QA-321) — 다시 띄운 작업이 같은 놓침을 또 알리지 않게. 이벤트가 많은 날에도 빠지지 않게
        // 최근 몇 건이 아니라 그날 그 종류를 읽습니다.
        for (Event e : store.eventsSince(MARKET, RealTradeNotices.EVENT_STOP_SELL, today.atStartOfDay(Kst.ZONE).toInstant())) {
            JsonNode detail = e.detail();
            if (detail != null && today.toString().equals(detail.path("date").asString(""))) {
                detail.path(STOP_ROOTS).forEach(root -> fresh.stopMissCounted.add(root.asLong()));
            }
        }
        for (Event e : store.eventsSince(MARKET, RealTradeNotices.EVENT_UNAVAILABLE, today.atStartOfDay(Kst.ZONE).toInstant())) {
            JsonNode detail = e.detail();
            if (detail != null && today.toString().equals(detail.path("date").asString(""))) {
                fresh.unavailableNoticed.add(detail.path("reason").asString(""));
            }
        }
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
        d.windows = RealTradePlanner.windows(d.date, reply.value().today(), syncAt(store.configOrOff(MARKET).sourceBook(), d.date));
        publish(d);
        return true;
    }

    /**
     * 따라 하는 책의 그날 일일 맞추기 시각(ADR 0033 결정 1 — {@link PaperMirrorService#dailySyncAt}). 있으면 그날은 시가 단일가 맞추기 대신 그 시각
     * 시장가 맞추기({@value RealTradePlanner#WINDOW_SYNC_AT}), 없으면(책이 없거나 시가 체결 책·전환일) 예전 시가 맞추기입니다.
     */
    private Instant syncAt(String book, LocalDate date) {
        return book == null ? null : paper.dailySyncAt(book, date).orElse(null);
    }

    /**
     * 그날 창 굳히기와 쉬는 날 판정(명세 §3) — 따라 하는 책·세대가 바뀌면 둘 다 다시.
     * <ul>
     *   <li><b>창 굳히기</b>: 그날 첫 창 3분 전까지는 주기마다 맞추기 시각을 다시 세어 창을 고치고, 그 뒤로는 굳힙니다(예전 그대로).</li>
     *   <li><b>쉬는 날 판정</b>: 그날 처음 주문이 나갈 수 있는 시각({@link Day#firstAction} — 첫 창의 시작과 스탑 매도의 하한인 정규장 시작 + 10분 가운데
     *       이른 쪽)의 3분 전에(휴장이면 바로) 한 번. 예전에는 첫 창 3분 전이라, 맞추기 시각이 개장 10분 뒤보다 늦은 날(규칙 계좌의 지정 시각이 09:10이 아닌
     *       설정)에는 그때까지 스탑 매도가 돌지 않았습니다(QA-377). 맞추기 시각이 개장 10분 뒤(운영 값 09:10·장 시간 변경일 첫 분)이거나 시가 맞추기 날이면
     *       두 시각이 같아 예전과 같은 주기에 판정합니다.</li>
     * </ul>
     */
    private void decide(DayState d, Instant now, Config cfg) {
        String key = cfg.sourceBook() + "|" + cfg.bookGeneration();
        if (!key.equals(d.windowsFor) && d.calendar != null && d.calendar.today() != null) {
            // 책·세대가 바뀌면 그 책의 맞추기 시각으로 창을 다시 셈(시가 맞추기 ↔ 시각 맞추기)
            d.windows = RealTradePlanner.windows(d.date, d.calendar.today(), syncAt(cfg.sourceBook(), d.date));
            publish(d);
            if (d.windows == null || !now.isBefore(d.windows.firstStart().minus(WARMUP_LEAD))) {
                d.windowsFor = key;   // 휴장(창 없음)이면 다시 셀 것이 없음
            }
        }
        if (key.equals(d.decidedFor)) {
            return;
        }
        if (d.windows != null && now.isBefore(d.windows.firstAction().minus(WARMUP_LEAD))) {
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
        // 휴장은 평소 일이라 알리지 않음 — 단 모의 달력이 거래일인데 토스만 휴장이라 답한 날은 알림(QA-342, 모의 책은 그날 주문을 내는데 실제 계좌만 쉼)
        boolean closed = RealTradePlanner.SKIP_MARKET_CLOSED.equals(d.skipReason);
        boolean paperOpen = closed && paperHours(d) != null && d.paperHours.tradingDay();
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("reason", d.skipReason);
        detail.put("date", d.date.toString());
        if (paperOpen) {
            detail.put(RealTradeNotices.DETAIL_PAPER_OPEN, true);
        }
        store.addEvent(MARKET, RealTradeStore.EVENT_SKIP_DAY, null, detail, !closed || paperOpen);
    }

    /** 모의 달력의 그날 장 시간 — 달력이 모르는 날이면 null(다음에 다시 물음). */
    private SessionHours paperHours(DayState d) {
        if (d.paperHours == null) {
            d.paperHours = paper.sessionHours(d.date).orElse(null);
        }
        return d.paperHours;
    }

    /**
     * 켜짐인데 주문을 낼 준비가 안 된 주기(QA-342) — 모의 달력이 거래일이고 지금이 그날 [개장 − {@link #WARMUP_LEAD}, 마감) 안이면 사유마다 하루 한 번
     * 알림 이벤트를 남깁니다(사유 코드와 날짜만). 휴장일·개장 한참 전·마감 뒤에는 낼 주문이 없으므로 알리지 않습니다. 동작(재시도·주문 없음)은 그대로입니다.
     */
    private void noteUnavailable(DayState d, Instant now, String reason) {
        if (d.unavailableNoticed.contains(reason)) {
            return;
        }
        SessionHours hours = paperHours(d);
        if (hours == null || !hours.tradingDay() || now.isBefore(hours.open().minus(WARMUP_LEAD)) || !now.isBefore(hours.close())) {
            return;
        }
        d.unavailableNoticed.add(reason);
        store.addEvent(MARKET, RealTradeNotices.EVENT_UNAVAILABLE, null, Map.of("reason", reason, "date", d.date.toString()), true);
        log.warn("실제 매매 준비 안 됨 — 개장이 가까운데 {} (받는 대로 이어 감)", reason);
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
     * 회전율이 60%를 넘으면 보내지 않고 이상 멈춤 — 회전율은 대기 STOP 종목의 매도와 그 대금으로 사는 현금성 매수(스탑 대금까지)를 빼고 셉니다
     * ({@link RealTradePlanner#withoutStops}, QA-302 — 보내는 주문에는 그대로 있음), 예외는 {@link #turnoverHalt}(켜기·방식 바꾸기·멈춤 해제 뒤 첫
     * 묶음, 그리고 남은 몫으로 이어 준 묶음 중 목표가 앞 묶음과 거의 같은 것). 묶음을 만들면서(같은 트랜잭션) {@code sync_pending}을 끕니다 — 단 1건
     * 상한·현금·하루 한도로 그날 다 못 맞춘 남은 몫({@link #LEFTOVER_SKIPS})이 있으면, sync_pending을 켠 일 뒤 {@value #SYNC_PENDING_MAX_BATCHES}번째 묶음까지는 켜 둡니다(켜기 창에서 확인한
     * 같은 재조정의 남은 몫이 다음 날 회전율 멈춤이 되지 않게 — 그 뒤로는 끔).
     *
     * @param send false면 묶음만 만들고 보내지 않음(계획한 주문은 놓침 — 창 끝이 가까워 시작한 시가 맞추기, 시가 뒤 마무리가 메움)
     */
    private void createBatchAndSend(Cycle c, String purpose, String timeInForce, String window, boolean send) {
        // 시각 맞추기 날(ADR 0033 결정 1)은 그 시각까지의 모의 주문을 반영한 목표(시각 지정 STOP은 흡수하지 않음 — 스탑 매도 경로가 따로 팖)
        Instant syncAt = c.day.windows.syncAt();
        Optional<OpenTargets> found = syncAt != null ? paper.targetsAt(c.cfg.sourceBook(), c.today, syncAt)
                : paper.openTargets(c.cfg.sourceBook(), c.today);
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
        // 회전율에는 매매 제한으로 기다리는 전량 매도 대상의 몫도 셈(QA-376 — 풀리면 그날 나감). 그런 종목이 없으면 plan 그대로.
        Plan turnover = withWaitingLiquidations(c, planned0, weightPct);
        if (turnover.turnoverExceeded()) {
            // 대기 STOP 종목의 매도와 그 대금으로 사는 현금성 매수(스탑 대금까지)는 회전율 멈춤에 세지 않음(ADR 0033 결정 3, QA-302) — 스탑이
            // 멈춤을 걸면 같은 주기의 스탑 매도 경로까지 서서 손절이 사라짐. 보낼 주문은 그대로(묶음도 스탑 종목을 목표 0으로 팖 — 겹쳐도 더 팔 수 없음).
            Set<String> stops = paper.pendingStopSymbols(c.cfg.sourceBook(), c.today);
            Plan counted = RealTradePlanner.withoutStops(turnover, weightPct, f.account(), f.blocked(), rules(c, f), true, stops,
                    stopProceeds(c, stops));
            if (counted.turnoverExceeded()) {
                Map<String, Object> halt = turnoverHalt(c.cfg, start, counted, weightPct, stops, c.cashLike);
                if (halt != null) {
                    executor.halt(HALT_TURNOVER, halt);
                    return;
                }
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
                    RealTradeStore.BATCH_SYNC, planned.sourceBook(), mapper.valueToTree(batchTargets(weightPct, f.account())),
                    targets.absorbedOrderIds(), f.equity()));
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
     * 묶음에 남기는 목표(QA-376) — 책의 목표 비중에, 묶음을 만들 때 실제 계좌에 있던 '책의 목표에 없는 정수 보유'(전량 매도 대상 — 책이 들지 않는 종목,
     * 책이 그 시각까지 전량 매도하는 종목, 목표 세션이 지난 대기 STOP 종목)를 <b>비중 0</b>으로 더합니다. 모의 공개 창의 목표 비중에는 수량 0인 종목이
     * 없으므로({@link PaperMirrorService.OpenTargets#weightPct}) 0은 이 표시로만 생깁니다. 그날의 마무리·재시도는 이 종목을 범위에 넣어
     * ({@link #liquidations}), 묶음을 만들 때 주문 행을 쓰지 못한 전량 매도(VI 대기·접수 불가 거절 뒤 순서·창 끝이 가까워 묶음만 만든 날·하루 한도 미룸)를
     * 같은 날 창 안에서 다시 봅니다. 예전에는 범위가 '목표 종목 ∪ 주문 행의 종목'이라 그런 종목이 다음 거래일 맞추기까지 남았습니다. 묶음 뒤에 생긴 보유는
     * 넣지 않습니다(그날 장중 따라 하기로 산 종목을 팔지 않게 — 다음 맞추기 몫 그대로).
     */
    static Map<String, Double> batchTargets(Map<String, Double> weightPct, Account account) {
        Map<String, Double> out = new TreeMap<>(weightPct);
        account.positions().forEach((symbol, p) -> {
            if (!out.containsKey(symbol) && RealTradePlanner.krSymbol(symbol) && p.quantity() != null
                    && p.quantity().compareTo(BigDecimal.ONE) >= 0) {
                out.put(symbol, 0.0);
            }
        });
        return out;
    }

    /**
     * 계획 밖의 스탑 대금(QA-302 — {@link RealTradePlanner#withoutStops}) — 이 기능의 오늘 행 가운데 대기 STOP 종목의 매도로 토스가 접수한 것의 금액(진행
     * 중이면 수량, 끝났으면 체결 수량 × 기준가). 묶음보다 먼저 스탑 매도 경로가 판 몫(묶음 생성이 늦어진 시각 맞추기 날)은 계획의 회전율에 없지만 그 대금이
     * 현금성 매수가 되므로 여기서 셉니다. 결과 모름(토스 주문 번호 없음) 행은 세지 않습니다.
     */
    private BigDecimal stopProceeds(Cycle c, Set<String> stops) {
        BigDecimal sum = BigDecimal.ZERO;
        if (stops.isEmpty()) {
            return sum;
        }
        for (OrderRow row : store.ordersOn(MARKET, c.today)) {
            if (!RealTradePlanner.SELL.equals(row.side()) || !stops.contains(row.symbol()) || row.tossOrderId() == null
                    || row.refPrice() == null) {
                continue;
            }
            BigDecimal quantity = row.terminal() ? Objects.requireNonNullElse(row.filledQuantity(), BigDecimal.ZERO)
                    : BigDecimal.valueOf(row.quantity());
            sum = sum.add(quantity.multiply(row.refPrice()));
        }
        return sum;
    }

    /**
     * 회전율이 한도를 넘은 묶음을 멈출지(명세 §3.1·§12.2, RT2-1) — 멈추면 HALT 이벤트에 실을 값, 보내도 되면 null. 묶음을 만들기 전에(잠금 밖) 셉니다.
     * {@code plan}의 회전율은 스탑 몫을 뺀 값({@link RealTradePlanner#withoutStops})이고, 목표 변화량도 같은 기준으로 셉니다(QA-302).
     * <ul>
     *   <li>{@code sync_pending}이 아니면 멈춤.</li>
     *   <li>sync_pending을 켠 마지막 일 뒤 첫 묶음(그 뒤에 만든 묶음이 아직 없음 — 켜기 창에서 확인한 재조정)이면 보냄. 그 일을 최근 이벤트에서 못 찾으면
     *       앞 묶음이 하나도 없을 때만 첫 묶음으로 봅니다.</li>
     *   <li>남은 몫 때문에 sync_pending이 이어진 2·3번째 묶음은 목표 변화량(바로 앞 묶음 목표와의 Σ|w_now − w_prev|, 합집합 종목 — 없는 종목은 0%)이
     *       회전율 한도 이하일 때만 보냄 — 같은 목표의 남은 몫(변화량 ≈ 0)은 통과하고, 새 재조정이나 엉망인 목표는 {@code targetDriftPct}와 함께 멈춤.</li>
     * </ul>
     */
    private Map<String, Object> turnoverHalt(Config cfg, Optional<Instant> start, Plan plan, Map<String, Double> weightPct, Set<String> stops,
                                             Set<String> cashLike) {
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
        Optional<BigDecimal> drift = targetDrift(weights(previous.get()), weightPct, stops, cashLike);
        if (drift.isPresent() && drift.get().compareTo(RealTradePlanner.TURNOVER_LIMIT_PCT) <= 0) {
            log.info("남은 몫 묶음 — 회전율 {}%지만 목표 변화량 {}%라 회전율 예외 유지", plan.turnoverPct(), drift.get());
            return null;
        }
        detail.put("targetDriftPct", drift.orElse(null));
        return detail;
    }

    /** 목표 변화량(%p) — Σ|지금 − 앞| (합집합 종목, 없는 종목은 0%). 유한하지 않은 비중이 있으면 empty(멈춤으로 셈). */
    static Optional<BigDecimal> targetDrift(Map<String, Double> previous, Map<String, Double> now) {
        return targetDrift(previous, now, Set.of(), Set.of());
    }

    /**
     * 스탑 몫을 뺀 목표 변화량(%p, QA-302 — {@link RealTradePlanner#withoutStops}와 같은 기준) — Σ|지금 − 앞|에서 대기 STOP 종목이 줄어든 몫과, 현금성
     * 종목이 늘어난 몫 가운데 그 줄어든 몫까지를 뺀 값. 스탑이 없으면 {@link #targetDrift(Map, Map)}와 같습니다.
     */
    static Optional<BigDecimal> targetDrift(Map<String, Double> previous, Map<String, Double> now, Set<String> stops, Set<String> cashLike) {
        Set<String> symbols = new TreeSet<>(previous.keySet());
        symbols.addAll(now.keySet());
        double sum = 0;
        double stopDrop = 0;
        double cashRise = 0;
        for (String symbol : symbols) {
            double before = previous.get(symbol) == null ? 0 : previous.get(symbol);
            double after = now.get(symbol) == null ? 0 : now.get(symbol);
            sum += Math.abs(after - before);
            if (stops.contains(symbol) && after < before) {
                stopDrop += before - after;
            } else if (cashLike.contains(symbol) && after > before) {
                cashRise += after - before;
            }
        }
        double drift = sum - stopDrop - Math.min(cashRise, stopDrop);
        return Double.isFinite(drift) ? Optional.of(BigDecimal.valueOf(drift).setScale(2, RoundingMode.HALF_UP)) : Optional.empty();
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
        Set<String> restricted = Set.of();
        Set<String> ownBlocked = f.blocked();
        if (timedSync(c, purpose)) {
            restricted = restrictedSymbols(c, symbols, f);
            if (restricted == null) {
                return null;   // 시장 전체 대기 — 묶음도 만들지 않고 다음 주기에 다시 봄
            }
            f = f.alsoBlocked(restricted);
        }
        Set<String> sell = RealTradePlanner.sellSymbols(plan.apply(f, rules(c, f).withRequireSellable(false)));
        if (!sell.isEmpty()) {
            f = fresh(c, symbols, purpose, sell);
            if (f == null || !lossCheck(c, f)) {
                return null;
            }
            ownBlocked = f.blocked();
            f = f.alsoBlocked(restricted);
        }
        return new Planned(f, plan.apply(f, rules(c, f)), Set.copyOf(restricted), Set.copyOf(ownBlocked));
    }

    /**
     * 회전율 판정용 계획(QA-376) — {@code plan}의 회전율 금액에, 매매 제한(VI·종목 거절 대기)으로 지금은 빠졌지만 풀리면 그날 창 안에서 나갈
     * <b>전량 매도 대상</b>(책의 목표에 없는 정수 보유 — {@link #batchTargets})의 몫을 더한 계획을 돌려줍니다. 예전에는 그 종목이 그날 다시 보이지 않아
     * 셀 필요가 없었지만, 이제 묶음 뒤에 팔리므로 세지 않으면 엉망인 목표('모두 팔기')가 VI와 겹친 날 그 몫이 회전율 멈춤을 비켜 갑니다. 대기 STOP 종목은
     * 뺍니다(스탑 매도는 회전율에 세지 않음 — QA-302). 책의 종목이 매매 제한으로 빠진 몫은 예전 그대로 세지 않습니다(2026-11-09 결정의 동작). 주문·건너뜀은
     * 바꾸지 않습니다.
     */
    private Plan withWaitingLiquidations(Cycle c, Planned planned, Map<String, Double> weightPct) {
        Fresh f = planned.fresh();
        Plan plan = planned.plan();
        Set<String> waiting = new TreeSet<>();
        for (String symbol : planned.restricted()) {
            if (!weightPct.containsKey(symbol) && !planned.ownBlocked().contains(symbol)
                    && f.account().held(symbol).compareTo(BigDecimal.ONE) >= 0) {
                waiting.add(symbol);
            }
        }
        if (waiting.isEmpty()) {
            return plan;
        }
        waiting.removeAll(paper.pendingStopSymbols(c.cfg.sourceBook(), c.today));
        if (waiting.isEmpty()) {
            return plan;
        }
        BigDecimal extra = RealTradePlanner.sync(weightPct, plan.equity(), f.account(), planned.ownBlocked(), BigDecimal.ZERO, rules(c, f),
                true, waiting, null).turnoverAmount();
        return new Plan(plan.orders(), plan.skipped(), plan.turnoverAmount().add(extra), plan.equity());
    }

    // ------------------------------------------------------------------ 매매 제한 대기(시각 맞추기)
    /** 시각 맞추기 창의 주문인가 — 매매 제한 대기는 이 경로에만 있습니다(시가 맞추기·장중 따라 하기·스탑 매도는 그대로). */
    private static boolean timedSync(Cycle c, String purpose) {
        return RealTradeStore.PURPOSE_SYNC_FOLLOWUP.equals(purpose) && c.day.windows.syncAt() != null;
    }

    /**
     * 지금 보내지 말아야 할 종목(VI 진행 중·거절로 쉬는 중) — 시장 전체를 쉬어야 하면 null. 조회를 못 하면 제한이 없는 것으로 보고 보냅니다(이 검사가 평소 주문을
     * 막지 않게 — 거절되면 {@link #onTimedRefused}가 대기). 모의 장부도 제한 뒤 첫 체결가로 체결하므로 풀린 뒤 시장가가 같은 때입니다.
     */
    private Set<String> restrictedSymbols(Cycle c, Collection<String> symbols, Fresh f) {
        DayState d = c.day;
        Reply<CollectorTradeClient.Restrictions> reply = client.restrictions(restrictionQuery(symbols, f.account().positions().keySet()));
        Set<String> viNow = Set.of();
        if (reply.ok()) {
            int stage = RealTradePlanner.circuitStage(reply.value().indexChangePct());
            if (stage > d.circuitStage) {
                d.circuitStage = stage;
                // 3단계는 그날 장 종료 — 창 끝까지 보내지 않음
                d.marketHoldUntil = stage >= 3 ? d.windows.regularEnd() : c.now.plus(RealTradePlanner.CIRCUIT_HOLD);
                markRestricted(c, RESTRICTED_CIRCUIT, RealTradePlanner.RESTRICTED_MARKET_SYNC_LENGTH);
            }
            viNow = reply.value().viActive();
        } else {
            log.warn("매매 제한 조회 실패 — 제한 없이 진행 ({})", reply.reason());
        }
        if (d.marketHoldUntil != null && c.now.isBefore(d.marketHoldUntil)) {
            return null;
        }
        Set<String> out = new TreeSet<>();
        for (String symbol : viNow) {
            if (c.now.isBefore(d.viSince.computeIfAbsent(symbol, k -> c.now).plus(VI_WAIT_LIMIT))) {
                out.add(symbol);
            }
        }
        if (!out.isEmpty()) {
            markRestricted(c, RESTRICTED_VI, RealTradePlanner.RESTRICTED_SYMBOL_SYNC_LENGTH);
        }
        d.symbolHoldUntil.forEach((symbol, until) -> {
            if (c.now.isBefore(until)) {
                out.add(symbol);
            }
        });
        return out;
    }

    /** 매매 제한 조회 한 번에 물을 수 있는 종목 수 — 수집기 {@code RESTRICTION_MAX_SYMBOLS}와 같게(넘으면 수집기가 요청을 거절). */
    static final int RESTRICTION_MAX_SYMBOLS = 60;

    /**
     * 매매 제한 조회에 넣을 종목(QA-351) — 국내 종목 코드 모양인 것만, 주문 대상({@code symbols} — 책 목표·묶음 범위)을 먼저 넣고 보유를 더해
     * {@value #RESTRICTION_MAX_SYMBOLS}개까지. 예전에는 보유 전부를 그대로 물어, 코드 모양이 틀린 보유가 하나라도 있거나 60개를 넘으면 조회가 통째로
     * 실패하고('제한 없이 진행') VI·서킷브레이커 대기가 그날 동작하지 않았습니다. 잘려 나간 보유는 제한을 모르는 채 보냅니다(거절되면 대기).
     */
    static Set<String> restrictionQuery(Collection<String> symbols, Collection<String> held) {
        Set<String> ask = new LinkedHashSet<>();
        for (Collection<String> group : List.of(new TreeSet<>(symbols), new TreeSet<>(held))) {
            for (String symbol : group) {
                if (ask.size() < RESTRICTION_MAX_SYMBOLS && RealTradePlanner.krSymbol(symbol)) {
                    ask.add(symbol);
                }
            }
        }
        return ask;
    }

    /** 시각 맞추기 창을 늘리고 사유마다 하루 한 번 알립니다. */
    private void markRestricted(Cycle c, String reason, Duration length) {
        DayState d = c.day;
        d.windows = d.windows.withTimedSyncUntil(d.windows.followup().start().plus(length));
        publish(d);
        if (d.restrictionNoticed.add(reason)) {
            log.warn("시각 맞추기 매매 제한 대기 — {}", reason);
            store.addEvent(MARKET, RealTradeNotices.EVENT_RESTRICTED, null, Map.of("reason", reason, "date", d.date.toString()), true);
        }
    }

    /**
     * 시각 맞추기 주문이 거절됐을 때 — 접수 불가(시장 전체로 봄)면 쉬고 true(남은 주문을 보내지 않음), 종목 제한이면 그 종목만 쉼. 토스가 서킷브레이커·VI에
     * 무엇을 답하는지는 스펙에 없어, 조회로 못 잡은 경우의 받침입니다.
     */
    private boolean onTimedRefused(Cycle c, String symbol, String code) {
        DayState d = c.day;
        if (CODE_MARKET_CLOSED.equals(code)) {
            d.marketHoldUntil = c.now.plus(MARKET_REFUSED_HOLD);
            markRestricted(c, RESTRICTED_REFUSED, RealTradePlanner.RESTRICTED_MARKET_SYNC_LENGTH);
            return true;
        }
        if (CODE_STOCK_RESTRICTED.equals(code) || CODE_ORDER_TYPE_NOT_ALLOWED.equals(code)) {
            d.symbolHoldUntil.put(symbol, c.now.plus(SYMBOL_REFUSED_HOLD));
            markRestricted(c, RESTRICTED_REFUSED, RealTradePlanner.RESTRICTED_SYMBOL_SYNC_LENGTH);
        }
        return false;
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
     * <p>범위는 묶음의 종목(목표 종목 ∪ 묶음을 만들 때의 전량 매도 대상 — {@link #batchTargets}, QA-376 ∪ 그 묶음이 주문한 종목)뿐이고, 그날 장중 따라
     * 하기가 손댄 종목(오늘 MIRROR 행이 있거나 흡수되지 않은 장중 대기 주문의
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
        scope.addAll(liquidations(batch));   // 묶음을 만들 때의 전량 매도 대상 — 주문 행이 없어도 그날 범위(QA-376)
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
            if (o.buy() && pendingStop(c, o.symbol())) {
                c.day.skip(window, RealTradePlanner.SKIP_PENDING_STOP, o.symbol());   // 보내기 직전에 다시 읽은 대기 STOP 종목(ADR 0033 결정 4)
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
            if (sent.result() == Result.REJECTED && timedSync(c, purpose) && onTimedRefused(c, o.symbol(), sent.code())) {
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
     *
     * <p><b>스탑 매도</b>({@link DueOrder#stop} — ADR 0033 결정 2·3): 그 주문 뒤 비중을 셈하지 않고(가격을 몰라도 손절이 사라지지 않게) 목표 0으로
     * 정수 보유 전량을 그때 다시 읽은 매도 가능 수량·1건 상한까지 팝니다. 창은 {@link RealTradePlanner#stopWindow}(개장 10분 전에는 팔지 않음), 묶음이
     * 흡수했다고 적혀 있어도 따로 봅니다(묶음이 사전 조회 실패 등으로 만들어지지 못해도 손절이 나가게 — 두 길 모두 목표 0이라 겹쳐도 더 팔 수 없음). 묶음의
     * 회전율 멈춤은 스탑 몫(대기 STOP 종목의 매도와 그 대금의 현금성 매수)을 세지 않으므로 스탑이 멈춤을 걸어 이 경로를 세우지 않습니다(QA-302). 다른
     * 사유의 이상 멈춤(스탑이 아닌 몫의 회전율 초과·토큰 경합 등)은 멈춤 해제까지 이 경로도 멈춥니다(HALTED는 아무것도 보내지 않음). 시도 1이 체결로
     * 끝났는데 새 계획에 아직 1주 이상 팔 것이 남으면(1건 상한) 시도 2를 새로 읽은 수량으로 냅니다(뿌리당 최대 2 — DB 그대로). 매수 멈춤과 상관없습니다.
     * 주기마다 보냄·막힘·놓침이 있으면 스탑 매도 이벤트(건수만 — 알림)를 남깁니다 — 놓침은 창이 끝나도록 행이 없는 뿌리(하루 한도로 미룬 채 끝난 것
     * 포함 — 창 요약은 그것을 미룸으로만 셈), 막힘은 토스 거절·안 보냄과, 팔 보유가 있는데 구조적 건너뜀(매도 가능 수량 0 등)으로 그날 닫은 뿌리입니다
     * (놓침과 구조적 막힘은 뿌리마다 한 번 — QA-303).
     *
     * <p>매수를 보내기 직전에는 따라 하는 책의 오늘 대기 STOP 종목을 다시 읽어 그 종목 매수를 보내지 않습니다(ADR 0033 결정 4).
     */
    private void runMirror(Cycle c, List<DueOrder> upcoming) {
        StopTally tally = new StopTally();
        mirrorOrders(c, upcoming, tally);
        if (tally.sent + tally.blocked + tally.missed > 0) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("sent", tally.sent);
            detail.put("blocked", tally.blocked);
            detail.put("missed", tally.missed);
            detail.put("date", c.today.toString());
            if (!tally.roots.isEmpty()) {
                detail.put(STOP_ROOTS, List.copyOf(tally.roots));   // 이번에 놓침·막힘으로 센 모의 주문 뿌리 번호(다시 띄운 뒤 되살림 — 알림 글은 건수만)
            }
            store.addEvent(MARKET, RealTradeNotices.EVENT_STOP_SELL, null, detail, true);
            log.info("실제 매매 스탑 매도 — 보냄 {} · 막힘 {} · 놓침 {}", tally.sent, tally.blocked, tally.missed);
        }
    }

    /** 스탑 매도 이벤트 근거의 칸 — 그 주기에 놓침·막힘으로 센 모의 주문 뿌리 번호(QA-321, {@link #dayFor}가 되살림). */
    static final String STOP_ROOTS = "roots";

    /** 한 주기의 스탑 매도 건수(알림 — 종목·수량 없음)와 놓침·막힘으로 센 뿌리. */
    private static final class StopTally {
        int sent;
        int blocked;
        int missed;
        final Set<Long> roots = new TreeSet<>();
    }

    /** 창이 끝난 스탑 뿌리를 볼 때 한 주기에 한 번만 읽는 실제 계좌 보유(QA-321). */
    private static final class EndedStops {
        boolean read;
        Account account;
    }

    private void mirrorOrders(Cycle c, List<DueOrder> upcoming, StopTally tally) {
        Day w = c.day.windows;
        // 종가 단일가 시각이 없는 날(장중·종가 창이 모두 없음)에도 아래를 돕니다 — 창이 없는 주문은 보내지 않고 놓침으로 셉니다(QA-342). 예전에는
        // 여기서 돌아가 그날 따라 하지 못한 스탑·장중 주문이 알림에도 요약에도 잡히지 않았습니다.
        Set<Long> absorbed = store.batch(MARKET, c.today, RealTradeStore.BATCH_SYNC).map(b -> Set.copyOf(b.absorbedOrderIds()))
                .orElse(Set.of());
        Instant syncAt = w.syncAt();
        List<Due> due = new ArrayList<>();
        EndedStops ended = new EndedStops();
        for (DueOrder o : upcoming) {
            boolean stop = o.stop();
            if ((!stop && absorbed.contains(o.orderId())) || (o.supported() && (o.mirrorAt() == null || o.mirrorAt().isAfter(c.now)))) {
                continue;
            }
            if (syncAt != null && !stop && o.target() != null && !o.target().isAfter(syncAt)) {
                // 시각 맞추기 날의 묶음 몫(ADR 0033 결정 1) — 기준 시각이 맞추기 시각 이하인 주문은 묶음이 흡수했든 아니든 따라 하지 않음(묶음 생성이
                // 늦어진 주기에 하나씩 따라 하고 다음 주기 묶음이 또 맞추는 이중 경로를 막음). 묶음을 놓치면 함께 놓침 — 다음 날 맞추기가 메움. 스탑은 예외.
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
            Window win = stop ? RealTradePlanner.stopWindow(w, o.mirrorAt(), close) : RealTradePlanner.mirrorWindow(w, o.mirrorAt(), close);
            Map<String, Set<String>> windowSkips = c.day.skipped.getOrDefault(window, Map.of());
            boolean deferred = DEFERRED_SKIPS.stream().anyMatch(reason -> windowSkips.getOrDefault(reason, Set.of()).contains("root:" + root));
            if (win == null || c.now.isAfter(win.end())) {
                if (rows.isEmpty() && !c.day.handledRoots.contains(root)) {
                    if (stop && !c.day.stopMissCounted.contains(root) && stopAlreadyFlat(c, o, upcoming, ended)) {
                        c.day.handledRoots.add(root);   // 팔 보유가 없음 — 묶음이 팔았거나 처음부터 없음(다시 띄운 뒤에도 놓침이 아님, QA-321)
                        continue;
                    }
                    if (!deferred) {
                        c.day.miss(window, "root:" + root);   // 미룬 뿌리는 창 요약이 '미룸'으로 셈(두 번 세지 않음)
                    }
                    if (stop && c.day.stopMissCounted.add(root)) {
                        tally.missed++;   // 스탑은 미룬 채(하루 한도) 창이 끝나도 놓침으로 알림(QA-303)
                        tally.roots.add(root);
                    }
                }
                continue;
            }
            if (c.now.isBefore(win.start()) || c.day.handledRoots.contains(root)) {
                continue;
            }
            int attempt = stop ? stopAttempt(rows) : nextAttempt(rows, null, RealTradeStore.PURPOSE_MIRROR, true);
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
            boolean stop = o.stop();
            Plan plan;
            if (stop) {
                // 스탑 — 비중을 셈하지 않고 목표 0(정수 보유 전량, 매도 가능 수량·1건 상한까지)
                plan = RealTradePlanner.mirror(o.ticker(), RealTradePlanner.SELL, 0.0, f.equity(), f.account(), blocked, reserved,
                        rules(c, f).withDaily(ordersLeft, buyLeft));
            } else {
                Optional<WeightAfter> weight = paper.weightAfter(c.cfg.sourceBook(), o.orderId(), c.now);
                if (weight.isEmpty() || weight.get().unpricedOrderIds().contains(o.orderId())) {
                    recordSkips(c, x.window(), List.of(new Skip(o.ticker(), null, RealTradePlanner.SKIP_WEIGHT)), key);
                    c.day.handledRoots.add(root);
                    continue;
                }
                plan = RealTradePlanner.mirror(o.ticker(), o.side(), weight.get().weightPct(), f.equity(), f.account(), blocked, reserved,
                        rules(c, f).withDaily(ordersLeft, buyLeft));
            }
            recordSkips(c, x.window(), plan.skipped(), key);
            if (plan.orders().isEmpty()) {
                if (plan.skipped().stream().noneMatch(s -> TRANSIENT_SKIPS.contains(s.reason()))) {
                    c.day.handledRoots.add(root);   // 이미 맞음·구조적 건너뜀 — 그날 다시 보지 않음
                    if (stop && stopBlocked(plan, f.account(), o.ticker()) && c.day.stopMissCounted.add(root)) {
                        tally.blocked++;   // 팔 보유가 있는데 구조적 건너뜀으로 그날 닫은 스탑은 막힘으로 알림(QA-303)
                        tally.roots.add(root);
                    }
                }
                continue;
            }
            Order planned = plan.orders().getFirst();
            int quantity = stop || x.attempt() != 2 ? planned.quantity()
                    : Math.min(planned.quantity(), remaining(x.rows(), null, RealTradeStore.PURPOSE_MIRROR));
            if (quantity < 1) {
                c.day.handledRoots.add(root);
                continue;
            }
            if (planned.buy() && pendingStop(c, planned.symbol())) {
                // 보내기 직전에 다시 읽은 대기 STOP 종목(ADR 0033 결정 4) — 그날 그 종목은 다시 사지 않음
                recordSkips(c, x.window(), List.of(new Skip(planned.symbol(), null, RealTradePlanner.SKIP_PENDING_STOP)), key);
                c.day.handledRoots.add(root);
                continue;
            }
            if (clock.instant().isAfter(x.win().end())) {   // 앞 주문의 전송이 길어져 이 주문의 창이 닫힘 — 보내지 않고 놓침(RT3-MON-4)
                log.warn("장중 따라 하기 창이 보내기 전에 닫힘 — 놓침으로");
                c.day.miss(x.window(), key);
                if (stop && c.day.stopMissCounted.add(root)) {
                    tally.missed++;
                    tally.roots.add(root);
                }
                continue;
            }
            Sent sent = executor.send(new Send(c.today, RealTradeStore.PURPOSE_MIRROR, null, o.orderId(), root, planned.symbol(),
                    planned.side(), quantity, "DAY", planned.refPrice(), x.attempt()), c.cfg);
            if (stop) {
                if (sent.result() == Result.ACCEPTED || sent.result() == Result.UNKNOWN) {
                    tally.sent++;
                } else if (sent.result() != Result.NOT_INSERTED) {
                    tally.blocked++;
                }
            }
            if (!live(c)) {
                return;
            }
            switch (sent.result()) {
                case NOT_INSERTED -> c.day.handledRoots.add(root);   // 선점 실패(장중 교체가 먼저 취소·대기 아님) 또는 같은 키
                case ACCEPTED, UNKNOWN -> {
                    if (!stop) {
                        c.day.handledRoots.add(root);   // 스탑은 끝난 뒤 남은 보유를 시도 2로 팔 수 있게 다시 봄(진행 중이면 이 기능 주문 진행 중으로 건너뜀)
                    }
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

    /**
     * 주문 없이 그날 닫은 스탑을 막힘으로 셀지(QA-303) — 정수 보유가 1주 이상인데 소수 부분이 아닌 건너뜀(가격 모름·매도 가능 수량 0·모름·1건 상한·반대
     * 방향 미체결 등)으로 닫았을 때. 보유가 없거나(이미 팔림) 건너뜀 없이 빈 계획(이미 맞음)은 세지 않습니다.
     */
    private static boolean stopBlocked(Plan plan, Account account, String symbol) {
        return symbol != null && account.held(symbol).compareTo(BigDecimal.ONE) >= 0
                && plan.skipped().stream().anyMatch(s -> !RealTradePlanner.SKIP_FRACTION.equals(s.reason()));
    }

    /**
     * 창이 끝나도록 이 기능의 MIRROR 행이 없는 스탑 뿌리를 놓침으로 세기 전에(QA-321) — 실제 계좌에 그 종목 정수 보유가 없으면(1주 미만) 팔 것이 없어 이미
     * 맞음입니다(그날 시각 맞추기 묶음이 목표 0으로 팔았거나 처음부터 들지 않음). 그 판단은 메모리({@code handledRoots})에만 있어 백엔드를 다시 띄우면 사라져,
     * 예전에는 다시 띄운 첫 주기가 묶음이 이미 판 스탑을 놓침으로 알렸습니다. 계좌는 그 주기에 한 번만 읽고(창이 끝난 스탑 종목만 — 매도 가능 수량은 묻지
     * 않음), 읽지 못하면 오늘 그 종목 매도 행이 그 스탑 기준 시각 뒤에 체결됐는지로 봅니다. 보유가 남았으면(하루 한도로 미룬 채 끝남 등) 예전처럼 놓침입니다.
     */
    private boolean stopAlreadyFlat(Cycle c, DueOrder o, List<DueOrder> upcoming, EndedStops ended) {
        if (o.ticker() == null) {
            return false;
        }
        if (!ended.read) {
            ended.read = true;
            Set<String> symbols = new TreeSet<>();
            upcoming.stream().filter(DueOrder::stop).map(DueOrder::ticker).filter(Objects::nonNull).forEach(symbols::add);
            Reply<Preflight> reply = client.preflight(symbols, Set.of());
            ended.account = reply.ok() ? RealTradePlanner.account(reply.value(), List.of()) : null;
        }
        if (ended.account != null) {
            return ended.account.held(o.ticker()).compareTo(BigDecimal.ONE) < 0;
        }
        Instant from = o.target();
        return store.ordersOn(MARKET, c.today).stream().anyMatch(row -> RealTradePlanner.SELL.equals(row.side())
                && o.ticker().equals(row.symbol()) && row.filledQuantity() != null && row.filledQuantity().signum() > 0
                && (from == null || row.createdAt() == null || !row.createdAt().isBefore(from)));
    }

    /** 따라 하는 책의 오늘 대기 STOP 종목인가 — 보내기 직전마다 다시 읽음(ADR 0033 결정 4). */
    private boolean pendingStop(Cycle c, String symbol) {
        return symbol != null && paper.pendingStopSymbols(c.cfg.sourceBook(), c.today).contains(symbol);
    }

    /**
     * 스탑 매도의 다음 시도 번호 — {@link #nextAttempt}(지나가는 장애의 거절·안 보냄, 덜 체결)에 더해, 시도 1이 체결로 끝났으면 2(새 계획에 아직 팔 것이
     * 남을 때만 보냄 — 1건 상한으로 잘린 손절의 나머지). 뿌리당 최대 2(DB CHECK 그대로).
     */
    static int stopAttempt(List<OrderRow> rows) {
        int attempt = nextAttempt(rows, null, RealTradeStore.PURPOSE_MIRROR, true);
        if (attempt != 0) {
            return attempt;
        }
        List<OrderRow> mine = rows.stream().filter(r -> RealTradeStore.PURPOSE_MIRROR.equals(r.purpose()))
                .sorted((a, b) -> Integer.compare(a.attempt(), b.attempt())).toList();
        OrderRow last = mine.isEmpty() ? null : mine.getLast();
        boolean filled = last != null && last.terminal() && last.attempt() == 1 && last.filledQuantity() != null
                && last.filledQuantity().signum() > 0;
        return filled ? 2 : 0;
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
     * 되돌림: 토스가 미체결 매수에 매수 가능 금액을 잡아도 손실로 보지 않게. 이 기능의 행으로 세지 않은 토스 미체결 매수(앱 주문 등)가 잡은 금액도
     * 하한만큼 되돌림 — QA-379, {@link #heldByOtherOpenBuys}), 수집기 하루 한도의 오늘 남은 몫을 함께 돌려줍니다. 하나라도 못 읽으면 null(보내지 않음).
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
        Map<String, CollectorTradeClient.Quote> fetched = new HashMap<>();
        Optional<DailyRoom> daily = dailyRoom(c.limits, account, open.value(), today.value(), fetched);
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
        Optional<BigDecimal> held = heldByUnfinishedBuys(account, unfinished);
        if (held.isEmpty()) {
            log.warn("미체결 매수의 상한가·기준가를 모름 — 이번 주기는 보내지 않음");
            return null;
        }
        // 이 기능의 행으로 세지 않은 토스 미체결 매수(앱 주문 등)가 잡은 금액도 되돌림(QA-379 — 기준 총액 U0는 미체결 매수 전체를 되돌린 값)
        BigDecimal lossTotal = total.get().add(held.get()).add(heldByOtherOpenBuys(reply.value(), fetched, open.value(), unfinished));
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
        return dailyRoom(limits, account, open, today, null);
    }

    /**
     * {@link #dailyRoom(Limits, Account, List, List)}의 본체 — {@code fetched}가 있으면 진행 중 매수의 상한가를 알려고 한 번 더 물은 시세를 거기에 담습니다
     * (손실 판정이 같은 종목의 상·하한가를 다시 묻지 않게 — QA-379, {@link #heldByOtherOpenBuys}). 계산은 같습니다.
     */
    private Optional<DailyRoom> dailyRoom(Limits limits, Account account, List<CollectorTradeClient.BrokerOrder> open,
                                          List<CollectorTradeClient.BrokerOrder> today, Map<String, CollectorTradeClient.Quote> fetched) {
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
            if (fetched != null) {
                fetched.putAll(extra.value().quotes());
            }
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

    /**
     * 손실 판정용 '지금 총액'에 되돌릴 금액 — 이 기능의 미종료 매수 가운데 토스가 접수한 것의 남은 수량 × 상한가(모르면 기준가). 토스가 미체결 매수에
     * 매수 가능 금액을 잡아도 손실로 보지 않게({@link #fresh}). 하나라도 단가를 모르면 empty.
     */
    private static Optional<BigDecimal> heldByUnfinishedBuys(Account account, List<OrderRow> unfinished) {
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
                return Optional.empty();
            }
            held = held.add(remaining.multiply(unit));
        }
        return Optional.of(held);
    }

    /**
     * 손실 판정용 '지금 총액'에 되돌릴 금액 가운데 이 기능의 행으로 세지 않은 몫(QA-379) — 토스 미체결 목록의 매수 중 주문 번호가 이 기능의 미종료 행에
     * 없는 것(앱 주문, 주문 번호를 아직 묶지 못한 이 기능의 결과 모름 주문)이 잡은 금액의 하한({@link RealTradePlanner#otherOpenBuyHoldFloor} — 시장가는
     * 상한가, 그 밖은 하한가). 이 기능의 미종료 행은 {@link #heldByUnfinishedBuys}가 따로 세므로 주문 번호로 빼 두 번 되돌리지 않습니다. 단가는 이번 사전
     * 조회의 시세와, 하루 한도를 세며 한 번 더 물은 시세({@code fetched})에서만 봅니다 — 토스 호출을 더하지 않고, 모르는 종목은 되돌리지 않습니다(그 주문만
     * 예전처럼 손실 쪽으로 보임). 못 되돌려도 주기를 막지 않습니다(스탑 매도까지 서지 않게).
     */
    private static BigDecimal heldByOtherOpenBuys(Preflight preflight, Map<String, CollectorTradeClient.Quote> fetched,
                                                  List<CollectorTradeClient.BrokerOrder> open, List<OrderRow> unfinished) {
        Set<String> counted = new HashSet<>();
        for (OrderRow row : unfinished) {
            if (row.tossOrderId() != null) {
                counted.add(row.tossOrderId());
            }
        }
        Map<String, CollectorTradeClient.Quote> quotes = new HashMap<>(fetched);
        quotes.putAll(preflight.quotes());
        return RealTradePlanner.otherOpenBuyHoldFloor(open, counted,
                symbol -> quotes.get(symbol) == null ? null : quotes.get(symbol).upperLimitPrice(),
                symbol -> quotes.get(symbol) == null ? null : quotes.get(symbol).lowerLimitPrice());
    }

    // ------------------------------------------------------------------ 마지막 운용 평가액(2026-11-08)
    /**
     * 마지막 운용 평가액(클래스 설명) — 저장된 값을 처음 한 번 되살리고({@link #lastPreflight}가 비었을 때만 — 보유는 저장하지 않아 빈 목록), 마지막 거래일
     * 마감 뒤 값이 없으면 읽고({@link #refreshValuation}), 새 값을 저장합니다({@link #persistValuation}). 주기 끝(잠금 안, 주문 흐름·트랜잭션 밖)에서
     * 부르며 무엇이 실패해도 주기를 깨지 않습니다 — 화면용이고 주문·손실 판정은 이 값을 쓰지 않습니다. V29 표가 없으면(백엔드만 먼저 띄운 배포) 아무것도
     * 하지 않습니다(예전처럼 메모리만).
     */
    private void valuation(Instant now) {
        try {
            if (!store.valuationReady()) {
                return;
            }
            if (!valuationLoaded) {
                valuationLoaded = true;
                if (lastPreflight == null) {
                    store.valuation(MARKET).ifPresent(v -> lastPreflight = new PreflightView(v.fetchedAt(), v.equity(), v.total(),
                            v.cashBuyingPower(), List.of()));
                }
            }
            refreshValuation(now);
            persistValuation();
        } catch (RuntimeException e) {
            log.warn("운용 평가액 저장·마감 뒤 읽기 실패 — 다음 주기에 다시: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * 마감 뒤 읽기 — 마지막 거래일(모의 한국 달력) 마감 + {@link #VALUATION_AFTER_CLOSE} 뒤에 읽은 값이 없고, 지금이 거래일 장중(개장 −
     * {@link #VALUATION_QUIET_BEFORE_OPEN} ~ 마감 + {@link #VALUATION_AFTER_CLOSE})이 아니면 {@link #VALUATION_RETRY}마다 한 번 읽기 전용 사전 조회를
     * 합니다(매도 가능 수량 없음 — 주문 없음, 상태와 무관 — 꺼짐에서도). 그래서 휴장일에는 마지막 거래일 마감 뒤 값이 보입니다. 끄는 중·이상 멈춤이면
     * 하지 않습니다(그때 토스 호출을 늘리지 않게). 실패(토스 점검·수집기 매매 스위치 꺼짐 등)는 로그 한 줄뿐 — 멈춤·알림·이벤트가 없고 마지막 값은 그대로.
     */
    private void refreshValuation(Instant now) {
        Instant mark = lastCloseMark(now);
        if (mark == null || quietForValuation(now)) {
            return;
        }
        PreflightView current = lastPreflight;
        if (current != null && current.fetchedAt() != null && !current.fetchedAt().isBefore(mark)) {
            return;
        }
        if (valuationTriedAt != null && now.isBefore(valuationTriedAt.plus(VALUATION_RETRY))) {
            return;
        }
        Config cfg = store.configOrOff(MARKET);
        if (RealTradeStore.STATE_STOPPING.equals(cfg.state()) || RealTradeStore.STATE_HALTED.equals(cfg.state())) {
            return;
        }
        valuationTriedAt = now;
        Reply<Status> status = client.status();
        if (!status.ok() || !status.value().enabled() || status.value().limits() == null || status.value().tokenContention()) {
            log.info("마감 뒤 운용 평가액 읽기 건너뜀 — 수집기 매매 상태가 켜짐으로 확인되지 않음, {}분 뒤 다시", VALUATION_RETRY.toMinutes());
            return;
        }
        List<OrderRow> unfinished = store.unfinishedOrders(MARKET);
        Set<String> ask = new TreeSet<>();
        unfinished.stream().filter(row -> RealTradePlanner.BUY.equals(row.side())).forEach(row -> ask.add(row.symbol()));
        Reply<Preflight> reply = client.preflight(ask, List.of());
        if (!reply.ok()) {
            log.info("마감 뒤 운용 평가액 읽기 실패 — {}분 뒤 다시 ({})", VALUATION_RETRY.toMinutes(), reply.reason());
            return;
        }
        Account account = RealTradePlanner.account(reply.value(), List.of());
        Optional<BigDecimal> total = RealTradePlanner.equity(account, null);
        Optional<BigDecimal> equity = RealTradePlanner.equity(account, BigDecimal.valueOf(status.value().limits().maxEquityKrw()));
        if (total.isEmpty() || equity.isEmpty()) {
            log.info("마감 뒤 운용 평가액을 정하지 못함(보유 가격 모름) — {}분 뒤 다시", VALUATION_RETRY.toMinutes());
            return;
        }
        BigDecimal lossTotal = heldByUnfinishedBuys(account, unfinished).map(total.get()::add).orElse(null);
        notePreflight(reply.value(), account, equity.get(), lossTotal, now);
        log.info("마감 뒤 운용 평가액을 읽음");
    }

    /** 새 사전 조회를 V29 표에 씁니다 — 표시를 먼저 내려 그사이 새로 온 사전 조회는 다음 주기에 다시 씀. 실패하면 다음 주기에 다시. */
    private void persistValuation() {
        if (!valuationDirty) {
            return;
        }
        valuationDirty = false;
        PreflightView view = lastPreflight;
        if (view == null || view.fetchedAt() == null || view.equity() == null) {
            return;
        }
        try {
            store.saveValuation(new Valuation(MARKET, view.fetchedAt(), view.equity(), view.total(), view.cashBuyingPower()));
        } catch (RuntimeException e) {
            valuationDirty = true;
            throw e;
        }
    }

    /**
     * 마지막 거래일 마감 + {@link #VALUATION_AFTER_CLOSE} 가운데 {@code now} 이전의 가장 늦은 것(모의 한국 달력 — 오늘부터 {@link #VALUATION_LOOKBACK_DAYS}일
     * 거슬러). 달력이 모르는 날을 만나면 null(마감 뒤 읽기를 하지 않음).
     */
    Instant lastCloseMark(Instant now) {
        LocalDate day = LocalDate.ofInstant(now, Kst.ZONE);
        for (int i = 0; i <= VALUATION_LOOKBACK_DAYS; i++, day = day.minusDays(1)) {
            Optional<SessionHours> hours = paper.sessionHours(day);
            if (hours.isEmpty()) {
                return null;
            }
            SessionHours h = hours.get();
            if (h.tradingDay() && h.close() != null) {
                Instant mark = h.close().plus(VALUATION_AFTER_CLOSE);
                if (!mark.isAfter(now)) {
                    return mark;
                }
            }
        }
        return null;
    }

    /** 거래일 장중(개장 − {@link #VALUATION_QUIET_BEFORE_OPEN} ~ 마감 + {@link #VALUATION_AFTER_CLOSE}) — 마감 뒤 읽기를 하지 않음. 달력이 모르면 장중으로 봄. */
    boolean quietForValuation(Instant now) {
        Optional<SessionHours> today = paper.sessionHours(LocalDate.ofInstant(now, Kst.ZONE));
        if (today.isEmpty()) {
            return true;
        }
        SessionHours h = today.get();
        return h.tradingDay() && h.open() != null && h.close() != null && !now.isBefore(h.open().minus(VALUATION_QUIET_BEFORE_OPEN))
                && now.isBefore(h.close().plus(VALUATION_AFTER_CLOSE));
    }

    private Rules rules(Cycle c, Fresh f) {
        return new Rules(BigDecimal.valueOf(c.limits.maxOrderKrw()), c.cashLike, c.cfg.buysPaused(), true, f.daily().orders(),
                f.daily().buyKrw());
    }

    /**
     * 손실 한도(명세 §7.3) — 기준 총액(켤 때의 상한 없는 총액 U0) − 지금 상한 없는 총액({@link Fresh#lossTotal} — 토스 미체결 매수(이 기능의 주문과
     * 앱 주문)가 잡은 금액을 되돌린 값, QA-379) ≥ 기준 평가액(E0, 안전 상한 적용) × 한도%면 매수 멈춤({@code buys_paused})을 켜고 알립니다(매도는 계속). 총액이 상한보다 커도 운용분의
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

    /**
     * 묶음의 목표 비중(종목 → %). 비중 0으로 남긴 전량 매도 대상({@link #batchTargets})은 넣지 않습니다 — {@link RealTradePlanner#sync}는 비중 값이 있는
     * 종목을 '책의 종목'으로 보고 1% 문턱을 걸므로, 0을 넣으면 작은 '책에 없는 보유'가 팔리지 않습니다. 그 종목은 범위({@link #liquidations})로만 씁니다.
     */
    static Map<String, Double> weights(Batch batch) {
        Map<String, Double> out = new TreeMap<>();
        JsonNode targets = batch.targets();
        if (targets != null && targets.isObject()) {
            for (Map.Entry<String, JsonNode> e : targets.properties()) {
                if (e.getValue().isNumber() && e.getValue().asDouble() != 0.0) {
                    out.put(e.getKey(), e.getValue().asDouble());
                }
            }
        }
        return out;
    }

    /** 묶음을 만들 때의 전량 매도 대상(QA-376 — {@link #batchTargets}가 비중 0으로 남긴 종목). 그 표시 전에 만든 묶음은 빈 집합입니다. */
    static Set<String> liquidations(Batch batch) {
        Set<String> out = new TreeSet<>();
        JsonNode targets = batch.targets();
        if (targets != null && targets.isObject()) {
            for (Map.Entry<String, JsonNode> e : targets.properties()) {
                if (e.getValue().isNumber() && e.getValue().asDouble() == 0.0) {
                    out.add(e.getKey());
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
            String window = w.syncAt() != null ? RealTradePlanner.WINDOW_SYNC_AT : RealTradePlanner.WINDOW_SYNC;
            summarize(c, window, mine, List.of(RealTradePlanner.WINDOW_SYNC, RealTradePlanner.WINDOW_FOLLOWUP), batch ? 0 : 1);
        }
        if (w.intraday() != null && c.now.isAfter(w.intraday().end())) {
            List<OrderRow> mine = rows.stream().filter(r -> RealTradeStore.PURPOSE_MIRROR.equals(r.purpose())
                    && !RealTradeExecutor.closingOrder(r, w)).toList();
            summarize(c, RealTradePlanner.WINDOW_MIRROR, mine, List.of(RealTradePlanner.WINDOW_MIRROR), 0);
        }
        if (w.intraday() == null && w.close() == null && c.now.isAfter(w.regularEnd().plus(CLOSE_SUMMARY_DELAY))) {
            // 장중·종가 창이 통째로 없던 날 — 따라 하지 못한 주문(놓침)을 마감 뒤 한 번 알림(QA-342). 이 기능의 장중 주문 행은 없습니다.
            summarize(c, RealTradePlanner.WINDOW_MIRROR, List.of(), List.of(RealTradePlanner.WINDOW_MIRROR, RealTradePlanner.WINDOW_CLOSE), 0);
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
                String error = telegram.send(PaperTelegram.Channel.ACCOUNT, text);
                if (error != null) {
                    log.warn("실제 매매 알림 실패 — 다음 주기에 다시");
                    return;
                }
            }
            store.markNotified(e.id(), now);
        }
    }
}
