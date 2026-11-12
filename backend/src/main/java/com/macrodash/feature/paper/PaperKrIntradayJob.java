package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ClaudeBookService.ClaudeSettings;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Attempt;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 한국 장중 판단 정기 작업(자유 시점 판 — ADR 0027 결정 3·4, 명세 docs/specs/2026-11-05-free-fill-timing.md §7) — 60초마다 한국 Claude 계좌 둘
 * ({@code kr_claude}·{@code kr_claude2})의 PLANNED 장중 판단 계획 행({@code paper_intraday_plans} — 계좌·세션·순번)을 보고, 확인 시각 T(그 세션 날짜의
 * 서울 시각) + {@value PaperCheckpointJob#WINDOW_START_MINUTES}분 ~ + {@value PaperCheckpointJob#WINDOW_END_MINUTES}분 창에서 T 뒤에 받은 그 계획의
 * 감시 저장본({@code paper.watch.kr} — 신원 목록에 자기 행이 있는 것)이 있을 때 <b>한 번</b> Claude를 부릅니다(재시도 없음). 끈 판의 한국 장중 확인
 * 작업({@link PaperKrCheckpointJob} — {@code paper_checkpoints}, 계좌2만)과 같은 규칙이고, 다른 것은 미국 장중 판단 작업({@link PaperIntradayJob})과
 * 같습니다 — 계좌·순번마다 한 행, 응답 결정 종류 {@code INTRADAY_<순번>}, 그 계좌의 자유 시점 판 파이프라인, 예약 행은 정기 문턱·당긴 행은 수동 문턱,
 * 응답 시점 셋({@link FreeTiming#INTRADAY_TIMINGS})과 다음 판단 예약({@code nextCheckpoint}). 한국에는 결정 주기 소상한이 없습니다(하루 상한만).
 *
 * <p>보장 1회(ADR 0031 결정 4 — 설정 {@value IntradayPolicy#KR_MIN} ≥ 1일 때만)는 미국과 같은 규칙({@link IntradayScheduler#guarantee})이고 보장 시각은
 * 개장 + 150분(보통 날 11:30 KST, 수능일 12:30 KST), 피드는 감시 1분봉입니다.
 *
 * <p>REPLACE 검증의 신선도는 그 세션 결정의 순간으로 셉니다(입력 동결 — 한국 장중 확인 작업과 같은 까닭, QA-172). 멈추려면 세션당 횟수 설정
 * ({@value FreeTimingSettings#KR_INTRADAY_MAX})을 0으로 두거나 계좌를 일시정지합니다. 자기 잠금으로 겹치지 않고, 작업 기록 이름은 {@link #JOB}입니다.
 */
@Service
public class PaperKrIntradayJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 'kr.intraday'. */
    static final String JOB = KrPaperMarket.INSTANCE.jobName(PaperIntradayJob.JOB);
    /** 이 작업이 보는 계좌 — 한국 Claude 계좌 둘. */
    static final List<String> BOOKS = List.of(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2);

    private static final Logger log = LoggerFactory.getLogger(PaperKrIntradayJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final ClaudeBookService claude;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final PaperMarkets markets;
    private final IntradayPlanner planner;
    private final IntradayScheduler scheduler;
    private final ReentrantLock running = new ReentrantLock();
    private final Map<String, String> waiting = new HashMap<>();
    private final Set<String> called = new HashSet<>();

    @Autowired
    PaperKrIntradayJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
                       PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, claude, ledger, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperKrIntradayJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
                       PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.claude = claude;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = new PaperMarkets(store, reader);
        this.planner = new IntradayPlanner(store);
        this.scheduler = new IntradayScheduler(store, ledger, mapper);
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.kr-intraday-initial-delay-ms:185000}",
            fixedDelayString = "${dashboard.paper.kr-intraday-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            PaperIntradayJob.Outcome outcome = run();
            if (outcome != null && outcome.error() != null) {
                log.warn("한국 장중 판단 작업 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            }
        } catch (RuntimeException e) {
            log.warn("한국 장중 판단 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 주기 — 테스트가 부릅니다. 앞 주기가 도는 중이면 null. */
    PaperIntradayJob.Outcome run() {
        if (!running.tryLock()) {
            return null;
        }
        try {
            return cycle();
        } finally {
            running.unlock();
        }
    }

    private PaperIntradayJob.Outcome cycle() {
        if (!store.ready()) {
            return new PaperIntradayJob.Outcome(0, Map.of(), null);
        }
        Instant started = clock.instant();
        Map<String, String> changes = new LinkedHashMap<>();
        String error = null;
        MarketRun run = null;
        // 보장 1회(ADR 0031 결정 4 — 설정 kr.intradayMinPerSession ≥ 1일 때만, 기본 꺼짐)·사건(결정 7 — kr.intradayEvents가 켜져 있고 한국 장중
        // 스탑 감시가 SHADOW·ON일 때만, 기본 꺼짐): 그때만 실행(달력 — 수능일 개장 변경 포함)을 엶.
        SettingsRow current = store.settings().orElse(null);
        boolean guaranteeOn = current != null && IntradayScheduler.guaranteeWanted(BOOKS, current.body());
        boolean eventsOn = current != null && IntradayScheduler.eventsWanted(BOOKS, current.body(), true);
        if (guaranteeOn || eventsOn) {
            MarketRun opened = null;
            try {
                opened = markets.open(KrPaperMarket.INSTANCE);
                run = opened;
            } catch (RuntimeException e) {
                error = "실행 열기: " + e;
                log.warn("한국 장중 판단 실행 열기 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
            }
            MarketRun ready = opened;
            if (ready != null && guaranteeOn) {
                try {
                    changes.putAll(scheduler.guarantee(BOOKS, ready.settingsRow().orElse(null), ready.calendar(), true, started,
                            (code, source) -> guaranteeBlocked(code, ready)));
                } catch (RuntimeException e) {
                    error = "보장 판단: " + e;
                    log.warn("한국 장중 판단 보장 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
                }
            }
            if (ready != null && eventsOn) {
                try {
                    changes.putAll(scheduler.events(BOOKS, ready.settingsRow().orElse(null), ready.calendar(), true, started,
                            (code, source) -> guaranteeBlocked(code, ready), eventSource(ready)));
                } catch (RuntimeException e) {
                    error = "사건 판단: " + e;
                    log.warn("한국 장중 판단 사건 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
                }
            }
        }
        List<IntradayPlan> planned = store.plannedIntradayPlans(BOOKS);
        if (planned.isEmpty()) {
            waiting.clear();
            called.clear();
        } else if (run == null) {
            run = markets.open(KrPaperMarket.INSTANCE);
        }
        SettingsRow row = run == null ? null : run.settingsRow().orElse(null);
        for (IntradayPlan p : planned) {
            String key = PaperIntradayJob.key(p);
            try {
                String change = handle(p, row, run);
                if (change != null) {
                    changes.put(key, change);
                    waiting.remove(key);
                    called.remove(key);
                }
            } catch (RuntimeException e) {
                error = key + ": " + e;
                log.warn("한국 장중 판단 {} 처리 실패 — 다음 주기에 다시 봅니다: {}", key, e.toString());
                if (!called.contains(key)) {
                    String cause = e.toString();
                    waiting.put(key, PaperCheckpointJob.JOB_ERROR + ": " + (cause.length() > PaperCheckpointJob.JOB_ERROR_CAUSE_CHARS
                            ? cause.substring(0, PaperCheckpointJob.JOB_ERROR_CAUSE_CHARS) + "…" : cause));
                }
            }
        }
        if (!changes.isEmpty() || error != null) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("changes", changes);
            detail.put("error", error);
            try {
                store.recordJobRun(JOB, started, clock.instant(), error == null ? "OK" : "ERROR", mapper.valueToTree(detail));
            } catch (RuntimeException e) {
                log.warn("한국 장중 판단 작업 기록 실패: {}", e.toString());
            }
        }
        return new PaperIntradayJob.Outcome(planned.size(), changes, error);
    }

    /**
     * 보장 행을 넣지 않을 까닭({@link IntradayScheduler.Gate}) — 자유 시점 판 파이프라인 없음, 하루 정기 문턱(한국에는 결정 주기 소상한이 없음). 넣어도
     * 되면 null.
     */
    private String guaranteeBlocked(String code, MarketRun run) {
        ClaudeDecisionPipeline pipeline = claude.freeTimingPipeline(code, run);
        if (pipeline == null) {
            return PaperIntradayJob.NO_PIPELINE;
        }
        SettingsRow row = run.settingsRow().orElse(null);
        if (row == null) {
            return PaperIntradayJob.INTRADAY_OFF;
        }
        if (pipeline.callsLeft(Kst.today(clock), ClaudeSettings.intraday(row.body()), true) <= 0) {
            return PaperCheckpointJob.CALL_CAP;
        }
        return null;
    }

    /**
     * 사건 판정의 입력({@link IntradayScheduler.EventSource}) — 한국 장중 스탑 감시 저장본(조용히 읽음), 보유(현금성·미처리 기업행위 보유 빼고, 장중 스탑
     * 감시와 같은 유효 최고가 — {@link PaperStopWatchJob#krWatermark}), 그 실행 설정의 스탑 비율.
     */
    private IntradayScheduler.EventSource eventSource(MarketRun run) {
        return new IntradayScheduler.EventSource() {
            @Override
            public Optional<Snapshot> monitor() {
                return reader.quietly(() -> marketData.stopWatch(true));
            }

            @Override
            public List<IntradayScheduler.Held> held(String code, LocalDate session) {
                List<PaperStore.Position> positions = store.positions(code);
                if (positions.isEmpty()) {
                    return List.of();
                }
                PaperSettings settings = run.settings();
                Set<String> holds = new HashSet<>();
                store.corpActionHolds(code).forEach(hold -> holds.add(hold.ticker()));
                Set<String> codes = new java.util.TreeSet<>();
                LocalDate from = null;
                for (PaperStore.Position p : positions) {
                    codes.add(p.ticker());
                    if (p.fillRefDate() != null && (from == null || p.fillRefDate().isBefore(from))) {
                        from = p.fillRefDate();
                    }
                }
                LocalDate since = from;
                KrConfirmed confirmed = reader.quietly(() -> run.confirmedPrices(marketData, codes, settings, since));
                return IntradayScheduler.held(positions, settings, holds, run.calendar().previousTradingDay(session),
                        p -> PaperStopWatchJob.krWatermark(p, confirmed.of(p.ticker()), session));
            }

            @Override
            public double stopPct() {
                return run.settings().trailingStopPct();
            }
        };
    }

    /** 행 하나 — 바꾼 상태 문구, 기다리면 null. */
    private String handle(IntradayPlan p, SettingsRow row, MarketRun run) {
        Instant now = clock.instant();
        String code = p.bookCode();
        String key = PaperIntradayJob.key(p);
        LocalDate session = p.sessionDate();
        Checkpoint c = p.asCheckpoint();
        TradingCalendar calendar = run.calendar();
        Instant at = KrCheckpointRequest.targetAt(session, p.atLocal());
        boolean stale = session.isBefore(now.atZone(KrxCalendar.SEOUL).toLocalDate());
        boolean windowOver = stale || now.isAfter(at.plus(PaperCheckpointJob.WINDOW_END));
        int max = row == null ? 0 : FreeTimingSettings.from(row.body()).intradayMax(code);
        if (row == null || max <= 0) {
            return windowOver ? mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperIntradayJob.INTRADAY_OFF) : null;
        }
        if (stale) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.STALE_SESSION);
        }
        if (now.isBefore(at.plus(PaperCheckpointJob.WINDOW_START))) {
            return null;
        }
        if (windowOver) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, waiting.getOrDefault(key, PaperCheckpointJob.WINDOW_MISSED));
        }
        Book book = store.book(code).orElse(null);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, "BOOK_NOT_ACTIVE — 계좌 " + code + "가 운용 중이 아님");
        }
        if (!calendar.isTradingDay(session)) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
        }
        if (!IntradayRequest.window(session, calendar, true).accepts(at)) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperIntradayJob.OUT_OF_RANGE);
        }
        ClaudeDecisionPipeline pipeline = claude.freeTimingPipeline(code, run);
        if (pipeline == null) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperIntradayJob.NO_PIPELINE);
        }
        Decision source = store.decision(p.sourceDecisionId()).orElse(null);
        if (source == null) {
            return null;   // 그 세션의 결정을 지우면 행도 함께 지워짐(V23 CASCADE) — 그사이의 경합
        }
        LocalDate asOf = source.asOfTradingDate();
        String kind = RuleBookService.intradayKind(p.slot());
        Optional<Decision> decided = store.decisionFor(code, asOf, kind);
        if (decided.isPresent()) {
            store.markIntradayPlan(code, session, p.slot(), PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                    PaperCheckpointJob.doneReason(decided.get()), decided.get().id(), null, decided.get().decidedAt());
            return PaperBooks.CHECKPOINT_DONE + " 결정 #" + decided.get().id() + "(이미 부름)";
        }
        if (called.contains(key)) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALLED_NOT_RECORDED);
        }

        Snapshot snapshot = reader.quietly(() -> marketData.watchKr())
                .filter(s -> PaperKrCheckpointJob.freshWatch(s, c, p.slot(), at, now)).orElse(null);
        if (snapshot == null) {
            waiting.put(key, PaperCheckpointJob.NO_WATCH_SNAPSHOT);
            return null;
        }
        JsonNode reference = snapshot.payload().path("tickers").path(Json.asText(snapshot.payload(), "reference"));
        if (reference.isObject() && !session.toString().equals(Json.asText(reference, "session"))) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
        }
        JsonNode measured = snapshot.payload().get("lagSeconds");
        Integer lag = measured != null && measured.isNumber() ? measured.asInt() : null;
        Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(KrPaperMarket.INSTANCE));

        // 장중 판단만의 effort(intradayEffort — 두 책 공통, 없으면 effort, ADR 0031 결정 6).
        ClaudeSettings claudeSettings = ClaudeSettings.intraday(row.body());
        LocalDate today = Kst.today(clock);
        boolean scheduled = !p.manual();
        if (pipeline.callsLeft(today, claudeSettings, scheduled) <= 0) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }
        Optional<Snapshot> watch = Optional.of(snapshot);
        Instant calledAt = clock.instant();
        // 호출 이유(출처·사건)와 이 판단의 다음 예약이 대신할 남은 예약·그대로 남는 뒤 예약(ADR 0031, QA-309), 장중 스탑 감시 ON 표시(ADR 0032)
        // — 켠 판 패킷만.
        List<IntradayPlan> rows = store.intradayPlans(code, session);
        KrCheckpointPacket.Free free = new KrCheckpointPacket.Free(code, p.slot(), max, p.manual(), p.origin(), p.trigger(),
                CheckpointPacket.Reserved.after(rows, p.slot()), CheckpointPacket.Reserved.later(rows, p.slot()),
                StopWatchMode.of(row.body(), true).orders());
        // 판단 이어받기(ADR 0038) — 한국 스위치를 켠 설정 행이면 밤 결정의 조건, 보유 종목의 진입 논거, 밤 결정 뒤의 사건 뉴스를 싣습니다(끄면 null —
        // 예전 패킷 그대로).
        Continuity.Intraday extra = Continuity.on(row.body(), true) ? continuity(code, c, source, row.body(), calledAt) : null;
        Attempt attempt = pipeline.attemptCheckpoint(version -> KrCheckpointPacket.build(new KrCheckpointPacket.Inputs(c, asOf,
                source, store.state(code).orElse(null), store.positions(code), pendingOrders(code), watch, quotes, version,
                row.version(), calendar, clock.instant(), free), mapper, extra), row, claudeSettings, today, scheduled);
        if (attempt == null) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }
        Long id;
        try {
            id = ledger.exclusively(() -> store.atomically(() -> write(pipeline, p, asOf, kind, max, row, claudeSettings, attempt,
                    lag, calledAt, snapshot.payload(), quotes, calendar, source.decidedAt())));
        } catch (RuntimeException e) {
            // 과금된 응답 — 쓰기가 되돌려져도 다시 부르지 않음. 실패 결정 행을 따로 남기고 행을 DONE으로.
            called.add(key);
            pipeline.recordAfterResponse(asOf, kind, row, claudeSettings, false, attempt, null, e, request(p, lag));
            try {
                store.decisionFor(code, asOf, kind).ifPresent(d -> store.markIntradayPlan(code, session, p.slot(),
                        PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, PaperCheckpointJob.doneReason(d), d.id(), lag,
                        calledAt));
            } catch (RuntimeException again) {
                e.addSuppressed(again);
            }
            throw e;
        }
        if (id == null) {
            log.warn("한국 장중 판단 {}: 호출하는 사이 계좌가 초기화돼 결정 행을 남기지 않음(과금된 호출은 사용량 기록에만)", key);
            return PaperCheckpointJob.RESET_DURING_CALL;
        }
        log.info("한국 Claude {} 장중 판단 {} #{} {} KST: {} — 결정 {}", code, session, p.slot(), KrTimedLadder.label(p.atLocal()),
                attempt.succeeded() ? Json.asText(attempt.parsed(), "action") : attempt.status(), id);
        return PaperBooks.CHECKPOINT_DONE + " 결정 #" + id;
    }

    private List<PaperStore.Order> pendingOrders(String code) {
        return store.ordersByStatus(code, PaperBooks.ORDER_PENDING).stream()
                .filter(o -> PacketBuilder.SOURCE_CLAUDE.equals(o.source())).toList();
    }

    /**
     * 판단 결정 행과 계획 행 DONE(장부 잠금 안 한 트랜잭션) — 한국 장중 확인 작업의 쓰기와 같은 규칙에 다음 판단 예약({@code nextCheckpoint})을 더한 것
     * (미국 {@link PaperIntradayJob}과 같음). REPLACE 검증의 신선도는 그 세션 결정의 순간({@code sourceDecidedAt})으로 셉니다.
     */
    private Long write(ClaudeDecisionPipeline pipeline, IntradayPlan p, LocalDate asOf, String kind, int max, SettingsRow row,
                       ClaudeSettings claudeSettings, Attempt attempt, Integer lag, Instant calledAt, JsonNode watch,
                       Optional<Quotes> quotes, TradingCalendar calendar, Instant sourceDecidedAt) {
        if (store.decision(p.sourceDecisionId()).isEmpty()) {
            // 호출하는 사이 계좌가 초기화됨(그 세션의 결정이 지워짐 — 초기화 뒤 다시 출발해도 옛 결정은 없음) — 비운 계좌에 리셋 전 결정 행·주문을
            // 넣지 않습니다(QA-286). 과금된 호출은 사용량 기록에만 남습니다.
            return null;
        }
        String code = p.bookCode();
        ObjectNode response;
        String status;
        String error = null;
        ClaudeDecisionPipeline replies = null;
        ClaudeDecisionPipeline.Plan plan = null;
        IntradayPlanner.Plan next = null;
        if (attempt.succeeded()) {
            Instant now = clock.instant();
            List<PaperStore.Order> pending = pendingOrders(code);
            ExpectedState.State expected = KrExpectedState.of(store.state(code).orElse(null), store.positions(code), pending,
                    p.sessionDate(), now, watch, quotes.orElse(null), calendar);
            Book current = store.book(code).orElse(null);
            boolean replace = "REPLACE".equals(Json.asText(attempt.parsed(), "action"));
            boolean active = current != null && PaperBooks.ACTIVE.equals(current.status());
            Set<String> universe = new TreeSet<>(ClaudeDecisionPipeline.observedUniverse(quotes));
            expected.positions().forEach(position -> universe.add(position.ticker()));
            String notApplied = null;
            if (replace && active) {
                replies = pipeline.checkpointReplies();
                try {
                    plan = replies.plan(asOf, kind, false, attempt, expected.view(), row, claudeSettings, quotes, universe, Map.of(),
                            PaperCheckpointJob.dueDiscretionary(store, expected, pending, asOf), sourceDecidedAt);
                } catch (RuntimeException e) {
                    notApplied = "검증할 수 없어 적용하지 않음: " + e.getMessage();
                    log.warn("한국 장중 판단 {} REPLACE 검증 실패 — 적용하지 않음: {}", PaperIntradayJob.key(p), e.toString());
                }
            }
            if (plan != null) {
                response = plan.response();
                status = plan.status();
                List<Long> superseded = replies.supersedePendingAfter(now);
                response.set("supersededOrders", mapper.valueToTree(superseded));
                response.put("applied", true);
            } else {
                response = (ObjectNode) attempt.parsed().deepCopy();
                status = ClaudeBookService.STATUS_NO_TRADE;
                if (replace && !active) {
                    status = ClaudeBookService.STATUS_SKIPPED;
                    response.put("applied", false);
                    response.put("pausedDuringCall", true);
                    response.put("appliedNote", "Claude를 부르는 사이에 계좌가 운용 중이 아니게 돼(상태 "
                            + (current == null ? "없음" : current.status()) + ") 대기 주문·새 주문을 바꾸지 않음");
                } else if (replace) {
                    response.put("applied", false);
                    response.put("appliedNote", notApplied + " — 대기 주문·새 주문을 바꾸지 않음");
                }
            }
            Map<String, Object> expectedView = expected.toMap(calendar);
            expectedView.put("note", KrExpectedState.NOTE);
            response.set("expectedState", mapper.valueToTree(expectedView));
            if (active) {
                next = planner.next(pipeline.profile(), attempt.parsed(), p.sessionDate(), p.slot(), calendar, universe, max, now,
                        mapper);
                if (next != null) {
                    response.set("intradayPlan", next.view(mapper, KrCheckpointRequest.AT_FIELD));
                }
            }
        } else {
            response = mapper.createObjectNode();
            status = attempt.status();
            error = attempt.error();
            response.put("summary", ClaudeDecisionPipeline.statusLabel(attempt.status()) + " — 장중 판단 재시도 없음(대기 주문 그대로)");
            ObjectNode failure = response.putObject("failure");
            failure.put("status", attempt.status());
            failure.put("errorKind", attempt.result().errorKind());
            failure.put("message", attempt.error());
            failure.put("charged", attempt.result().charged());
            failure.set("violations", mapper.valueToTree(attempt.violations()));
        }
        response.put("book", code);
        response.put("kind", kind);
        response.put("asOfTradingDate", asOf.toString());
        response.set("checkpoint", request(p, lag));
        response.put("retry", false);
        response.set("framework", mapper.valueToTree(FrameworkService.decisionView(attempt.frame())));
        Decision decision = pipeline.decisionRow(0, asOf, kind, status, row, claudeSettings, attempt, null, response, error, false, 0);
        Optional<Long> inserted = store.insertDecisionIfAbsent(decision);
        long id = inserted.orElseGet(() -> store.decisionFor(code, asOf, kind).map(Decision::id).orElseThrow());
        if (plan != null && inserted.isPresent()) {
            replies.insertOrders(id, asOf, plan, PaperBooks.ORDER_PENDING);
        }
        int marked = store.markIntradayPlan(code, p.sessionDate(), p.slot(), PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                attempt.succeeded() ? null : attempt.status() + " — 재시도 없음", id, lag, calledAt);
        if (marked == 0) {
            log.warn("한국 장중 판단 {} 행이 그사이 PLANNED가 아니게 됨 — 결정 {}은 남김", PaperIntradayJob.key(p), id);
        }
        if (next != null && inserted.isPresent()) {
            planner.write(next, p.sourceDecisionId(), id);
        }
        return id;
    }

    /** 판단 결정 응답의 {@code checkpoint} 칸 — 그 계획(세션·순번·시각·피드·그 세션의 결정·수동 여부·출처·사건)과 감시 저장본 지연(미국과 같음). */
    private ObjectNode request(IntradayPlan p, Integer lag) {
        ObjectNode request = mapper.createObjectNode();
        request.put("session", p.sessionDate().toString());
        request.put("slot", p.slot());
        request.put(KrCheckpointRequest.AT_FIELD, KrTimedLadder.label(p.atLocal()));
        request.put("feed", p.feed());
        request.put("sourceDecisionId", p.sourceDecisionId());
        request.put("manual", p.manual());
        request.put("lagSeconds", lag);
        request.put("origin", p.origin());
        if (p.trigger() != null) {
            request.set("trigger", p.trigger());
        }
        return request;
    }

    /**
     * 그 장중 판단의 이어받기 재료(ADR 0038) — 보유 종목의 진입 논거와, 밤 결정 뒤부터 지금까지의 사건 뉴스(대상 = 보유 + 감시 종목, 이름은 밤 결정
     * 패킷의 종목명). 뉴스 읽기가 실패하면 뉴스 없이 갑니다(판단을 막지 않음 — 그 섹션이 없을 뿐).
     */
    private Continuity.Intraday continuity(String code, Checkpoint c, Decision source, JsonNode body, Instant now) {
        java.util.Set<String> tickers = new java.util.LinkedHashSet<>();
        store.positions(code).forEach(p -> tickers.add(p.ticker()));
        Map<String, Continuity.Entry> entries = Continuity.entries(store, code, List.copyOf(tickers));
        if (c.watch() != null) {
            tickers.addAll(c.watch());
        }
        Map<String, Object> events = null;
        try {
            JsonNode nightPacket = source == null ? null
                    : source.packet() != null ? source.packet() : PacketBuilder.readSent(source.packetText(), mapper);
            events = claude.krIntradayEvents(body, source == null ? null : source.decidedAt(), now,
                    Continuity.krNames(nightPacket, tickers));
        } catch (RuntimeException e) {
            log.warn("한국 장중 판단 패킷의 사건 뉴스를 읽지 못했습니다 — 뉴스 없이 부릅니다: {}", e.toString());
        }
        return new Continuity.Intraday(entries, events);
    }

    /** 상태만 바꿈(부르지 않음) — 바꾼 상태 문구. 그사이 PLANNED가 아니면 null. */
    private String mark(IntradayPlan p, String status, String reason) {
        int marked = store.markIntradayPlan(p.bookCode(), p.sessionDate(), p.slot(), PaperBooks.CHECKPOINT_PLANNED, status, reason,
                null, null, null);
        if (marked == 0) {
            return null;
        }
        log.info("한국 장중 판단 {} {} — {}", PaperIntradayJob.key(p), status, reason);
        return status + " " + reason;
    }
}
