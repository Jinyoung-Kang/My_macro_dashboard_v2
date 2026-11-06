package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ClaudeBookService.ClaudeSettings;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Attempt;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
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
import java.util.ArrayList;
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
 * 장중 판단 정기 작업(미국 — 자유 시점 판, ADR 0027 결정 3·4, 명세 docs/specs/2026-11-05-free-fill-timing.md §7) — 60초마다 미국 Claude 계좌 둘
 * ({@code claude}·{@code claude2})의 PLANNED 장중 판단 계획 행({@code paper_intraday_plans} — 계좌·세션·순번)을 보고, 확인 시각 T(그 세션 날짜의 뉴욕
 * 시각) + {@value PaperCheckpointJob#WINDOW_START_MINUTES}분 ~ + {@value PaperCheckpointJob#WINDOW_END_MINUTES}분 창에서 <b>한 번</b> Claude를
 * 부릅니다(재시도 없음 — 놓치면 나중에 대신 부르지 않음). 끈 판의 장중 확인 작업({@link PaperCheckpointJob} — {@code paper_checkpoints}, 계좌2만)과
 * 같은 규칙이고 다른 것만 적습니다. 두 작업은 서로의 표를 보지 않습니다.
 *
 * <ul>
 *   <li><b>행</b>: 계좌·세션·순번마다 한 행이고 세션마다 계좌별 최대 {@value RuleBookService#INTRADAY_MAX}번입니다. 응답 결정의 종류는
 *       {@code INTRADAY_<순번>}(기준 거래일 = 그 세션 결정의 d — UNIQUE가 순번마다 한 번을 강제).</li>
 *   <li><b>판</b>: 계획 행을 쓴 결정이 자유 시점 판이므로 그 계좌의 자유 시점 판 파이프라인({@link ClaudeBookService#freeTimingPipeline})으로 부릅니다 —
 *       결정 뒤에 스위치를 꺼도 그 세션의 남은 판단은 그 판으로 부릅니다(대기 주문이 그 판의 것). 멈추려면 세션당 횟수 설정
 *       ({@value FreeTimingSettings#US_INTRADAY_MAX})을 0으로 두거나(계좌2는 {@code claude2.enabled}를 끔) 계좌를 일시정지합니다 — 그 행은 창이
 *       끝난 뒤 SKIPPED {@code INTRADAY_OFF}.</li>
 *   <li><b>문턱</b>: 예약 행은 정기 문턱(하루 상한까지), 운영자가 당긴 행({@code manual})은 수동 문턱(상한 − 정기 작업 몫 예약). 계좌2는 결정 주기
 *       소상한({@code claude2.maxCallsPerCycle} — 결정·재시도·장중 판단 합)도 봅니다. 계좌1은 소상한이 없습니다.</li>
 *   <li><b>응답</b>: KEEP·REPLACE는 장중 확인과 같습니다(예상 상태로 검증, 기준 시각이 남은 대기 주문만 대신함). 주문 시점은
 *       {@link FreeTiming#INTRADAY_TIMINGS}(장중 시장가·그날 남은 지정 시각·그날 종가). 응답의 {@code nextCheckpoint}는 다음 순번의 계획 행을 넣거나
 *       바꿉니다({@link IntradayPlanner#next} — 순번을 다 썼거나 규칙에 맞지 않으면 버리고 사유를 남김, 계좌가 운용 중이 아니면 쓰지 않음).</li>
 * </ul>
 *
 * <p>자기 잠금으로 겹치지 않고, 결정 작업·장중 확인 작업의 잠금을 쓰지 않습니다. 작업 기록({@code paper_job_runs}, 이름 {@value #JOB})은 행 상태를 바꾼
 * 주기와 오류만 남깁니다. 예외는 로그로만(스케줄러로 던지지 않음). {@code dashboard.paper.enabled=false}면 아무것도 읽거나 쓰지 않습니다.
 */
@Service
public class PaperIntradayJob {

    /** 작업 기록의 이름(paper_job_runs.job). */
    static final String JOB = "intraday";
    /** 이 작업이 보는 계좌 — 미국 Claude 계좌 둘. */
    static final List<String> BOOKS = List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2);

    static final String INTRADAY_OFF = "INTRADAY_OFF — 세션당 장중 판단 횟수 설정이 0이거나 그 계좌가 꺼져 있음";
    static final String OUT_OF_RANGE = "OUT_OF_RANGE — 확인 시각이 그 세션의 받는 범위(개장 10분 뒤 ~ 마감 30분 전) 밖";
    static final String NO_PIPELINE = "NO_PIPELINE — 그 계좌의 자유 시점 판 파이프라인이 없음";
    static final String CYCLE_CAP = "CYCLE_CAP — 계좌2 소상한(claude2.maxCallsPerCycle)에 닿음";

    private static final Logger log = LoggerFactory.getLogger(PaperIntradayJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PacketBuilder packets;
    private final ClaudeBookService claude;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final IntradayPlanner planner;
    private final TradingCalendar calendar = UsPaperMarket.INSTANCE.calendar();
    private final ReentrantLock running = new ReentrantLock();
    /** 창 안에서 자료를 기다린 행 → 그 사유(창 끝의 EXPIRED 사유). 재기동하면 비어 WINDOW_MISSED로 남습니다. */
    private final Map<String, String> waiting = new HashMap<>();
    /** 응답을 받았는데 결정 행을 남기지 못한 행 — 다시 부르지 않습니다. 재기동하면 비어 있습니다. */
    private final Set<String> called = new HashSet<>();

    @Autowired
    PaperIntradayJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PacketBuilder packets,
                     ClaudeBookService claude, PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, packets, claude, ledger, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperIntradayJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PacketBuilder packets,
                     ClaudeBookService claude, PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.packets = packets;
        this.claude = claude;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.planner = new IntradayPlanner(store);
    }

    /**
     * 한 주기의 결과.
     *
     * @param planned 본 PLANNED 행 수
     * @param changes 상태를 바꾼 행('계좌 세션 #순번' → 'STATUS 사유' — 부른 행은 'DONE 결정 #id')
     * @param error   실패 사유 — 없으면 null
     */
    record Outcome(int planned, Map<String, String> changes, String error) {

        Outcome {
            changes = Map.copyOf(changes);
        }
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 앞 주기가 도는 중이면 건너뜁니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.intraday-initial-delay-ms:175000}",
            fixedDelayString = "${dashboard.paper.intraday-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            Outcome outcome = run();
            if (outcome != null && outcome.error() != null) {
                log.warn("장중 판단 작업 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            }
        } catch (RuntimeException e) {
            log.warn("장중 판단 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 주기 — 테스트가 부릅니다(정기 실행과 같은 일, 꺼짐 확인만 없음). 앞 주기가 도는 중이면 null. */
    Outcome run() {
        if (!running.tryLock()) {
            return null;
        }
        try {
            return cycle();
        } finally {
            running.unlock();
        }
    }

    private Outcome cycle() {
        if (!store.ready()) {
            return new Outcome(0, Map.of(), null);
        }
        Instant started = clock.instant();
        List<IntradayPlan> planned = store.plannedIntradayPlans(BOOKS);
        if (planned.isEmpty()) {
            waiting.clear();
            called.clear();
            return new Outcome(0, Map.of(), null);
        }
        SettingsRow row = store.settings().orElse(null);
        Map<String, String> changes = new LinkedHashMap<>();
        String error = null;
        for (IntradayPlan p : planned) {
            try {
                String change = handle(p, row);
                if (change != null) {
                    changes.put(key(p), change);
                    waiting.remove(key(p));
                    called.remove(key(p));
                }
            } catch (RuntimeException e) {
                error = key(p) + ": " + e;
                log.warn("장중 판단 {} 처리 실패 — 다음 주기에 다시 봅니다: {}", key(p), e.toString());
                if (!called.contains(key(p))) {
                    String cause = e.toString();
                    waiting.put(key(p), PaperCheckpointJob.JOB_ERROR + ": " + (cause.length() > PaperCheckpointJob.JOB_ERROR_CAUSE_CHARS
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
                log.warn("장중 판단 작업 기록 실패: {}", e.toString());
            }
        }
        return new Outcome(planned.size(), changes, error);
    }

    /** 행의 열쇠 — '계좌 세션 #순번'(메모리·작업 기록). */
    static String key(IntradayPlan p) {
        return p.bookCode() + " " + p.sessionDate() + " #" + p.slot();
    }

    /** 행 하나(클래스 설명) — 바꾼 상태 문구, 기다리면 null. */
    private String handle(IntradayPlan p, SettingsRow row) {
        Instant now = clock.instant();
        String code = p.bookCode();
        LocalDate session = p.sessionDate();
        Checkpoint c = p.asCheckpoint();
        Instant at = CheckpointPacket.targetAt(c, calendar);
        LocalDate nyToday = now.atZone(calendar.zone()).toLocalDate();
        boolean stale = session.isBefore(nyToday);
        boolean windowOver = stale || now.isAfter(at.plus(PaperCheckpointJob.WINDOW_END));
        int max = row == null ? 0 : FreeTimingSettings.from(row.body()).intradayMax(code);
        Claude2Settings book2 = Claude2Settings.from(row == null ? null : row.body());
        if (row == null || max <= 0 || (PaperBooks.CLAUDE2.equals(code) && !book2.enabled())) {
            return windowOver ? mark(p, PaperBooks.CHECKPOINT_SKIPPED, INTRADAY_OFF) : null;
        }
        if (stale) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.STALE_SESSION);
        }
        if (now.isBefore(at.plus(PaperCheckpointJob.WINDOW_START))) {
            return null;
        }
        if (windowOver) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, waiting.getOrDefault(key(p), PaperCheckpointJob.WINDOW_MISSED));
        }
        Book book = store.book(code).orElse(null);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, "BOOK_NOT_ACTIVE — 계좌 " + code + "가 운용 중이 아님");
        }
        if (!calendar.isTradingDay(session)) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
        }
        if (!IntradayRequest.window(session, calendar, false).accepts(at)) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, OUT_OF_RANGE);
        }
        ClaudeDecisionPipeline pipeline = claude.freeTimingPipeline(code);
        if (pipeline == null) {
            return mark(p, PaperBooks.CHECKPOINT_SKIPPED, NO_PIPELINE);
        }
        Decision source = store.decision(p.sourceDecisionId()).orElse(null);
        if (source == null) {
            return null;   // 그 세션의 결정을 지우면 행도 함께 지워짐(V23 CASCADE) — 그사이의 경합
        }
        LocalDate asOf = source.asOfTradingDate();
        String kind = RuleBookService.intradayKind(p.slot());
        Optional<Decision> decided = store.decisionFor(code, asOf, kind);
        if (decided.isPresent()) {
            // 순번마다 한 번 — 이미 부른 판단 결정이 있으면 다시 부르지 않고 그 결정으로 끝냄.
            store.markIntradayPlan(code, session, p.slot(), PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                    PaperCheckpointJob.doneReason(decided.get()), decided.get().id(), null, decided.get().decidedAt());
            return PaperBooks.CHECKPOINT_DONE + " 결정 #" + decided.get().id() + "(이미 부름)";
        }
        if (called.contains(key(p))) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALLED_NOT_RECORDED);
        }

        boolean minute = ExecutionSection.FEED_MINUTE.equals(p.feed());
        Optional<Snapshot> watch = minute ? reader.quietly(() -> marketData.watchUs()) : Optional.empty();
        Optional<Quotes> quotes = reader.quietly(marketData::quotes);
        Integer lag = null;
        if (minute) {
            Snapshot snapshot = watch.filter(s -> PaperCheckpointJob.freshWatch(s, c, p.slot(), at, now)).orElse(null);
            if (snapshot == null) {
                waiting.put(key(p), PaperCheckpointJob.NO_WATCH_SNAPSHOT);
                return null;
            }
            JsonNode spy = snapshot.payload().path("tickers").path(CheckpointPacket.REFERENCE);
            if (spy.isObject() && !session.toString().equals(Json.asText(spy, "session"))
                    && !snapshot.collectedAt().isBefore(calendar.openInstant(session).plus(PaperCheckpointJob.SESSION_EVIDENCE_AFTER_OPEN))) {
                return mark(p, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
            }
            JsonNode measured = snapshot.payload().get("lagSeconds");
            lag = measured != null && measured.isNumber() ? measured.asInt() : null;
        } else {
            Bar spy = quotes.map(q -> q.bars().get(CheckpointPacket.REFERENCE)).orElse(null);
            if (spy == null || !session.equals(spy.date()) || quotes.get().collectedAt().isAfter(now)) {
                waiting.put(key(p), PaperCheckpointJob.NO_FRESH_QUOTES);
                return null;
            }
        }

        if (pipeline.profile().callCapKey() != null) {
            int cycle = ClaudeBookService.claude2CallsInCycle(store, asOf);
            if (cycle >= book2.maxCallsPerCycle()) {
                return mark(p, PaperBooks.CHECKPOINT_EXPIRED, CYCLE_CAP + "(" + book2.maxCallsPerCycle() + "회, 결정 주기 " + asOf
                        + " — 지금 " + cycle + "회)");
            }
        }
        ClaudeSettings claudeSettings = ClaudeSettings.from(row.body());
        LocalDate today = Kst.today(clock);
        boolean scheduled = !p.manual();
        if (pipeline.callsLeft(today, claudeSettings, scheduled) <= 0) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }

        JsonNode macro = packets.macroSection(asOf, row);
        // 예상 상태의 T 가격 — 1분봉 저장본(장부와 같은 판정). 조용히 읽음(수집 유발 없음).
        Optional<Snapshot> bars = reader.quietly(() -> marketData.barsUs());
        Instant calledAt = clock.instant();
        CheckpointPacket.Free free = new CheckpointPacket.Free(code, p.slot(), max, p.manual());
        Attempt attempt = pipeline.attemptCheckpoint(version -> CheckpointPacket.build(new CheckpointPacket.Inputs(c, asOf,
                source, store.state(code).orElse(null), store.positions(code), pendingOrders(code), todayFills(code, session),
                watch, quotes, macro, version, row.version(), store.recentIntradayLags(code, ExecutionSection.FEED_MINUTE,
                        ExecutionSection.RECENT_LAG_SESSIONS), calendar, clock.instant(), bars, free), mapper),
                row, claudeSettings, today, scheduled);
        if (attempt == null) {
            return mark(p, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }
        Integer lagSeconds = lag;
        long id;
        try {
            id = ledger.exclusively(() -> store.atomically(() -> write(pipeline, p, c, asOf, kind, max, row, claudeSettings,
                    attempt, lagSeconds, calledAt, quotes, watch, bars)));
        } catch (RuntimeException e) {
            // 과금된 응답 — 쓰기가 되돌려져도 다시 부르지 않음(재시도 없음). 실패 결정 행을 따로 남기고 행을 DONE으로.
            called.add(key(p));
            pipeline.recordAfterResponse(asOf, kind, row, claudeSettings, false, attempt, null, e, request(p, lagSeconds));
            try {
                store.decisionFor(code, asOf, kind).ifPresent(d -> store.markIntradayPlan(code, session, p.slot(),
                        PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, PaperCheckpointJob.doneReason(d), d.id(),
                        lagSeconds, calledAt));
            } catch (RuntimeException again) {
                e.addSuppressed(again);   // 다음 주기가 그 결정 행으로(또는 메모리의 '부름'으로) 끝냄
            }
            throw e;
        }
        log.info("Claude {} 장중 판단 {} #{} {} {}: {} — 결정 {}", code, session, p.slot(), CheckpointPacket.clock(p.atLocal()), p.feed(),
                attempt.succeeded() ? Json.asText(attempt.parsed(), "action") : attempt.status(), id);
        return PaperBooks.CHECKPOINT_DONE + " 결정 #" + id;
    }

    private List<PaperStore.Order> pendingOrders(String code) {
        return store.ordersByStatus(code, PaperBooks.ORDER_PENDING).stream()
                .filter(o -> PacketBuilder.SOURCE_CLAUDE.equals(o.source())).toList();
    }

    /** 그 계좌의 그 세션 체결(최근 순 50건 안). */
    private List<PaperStore.Fill> todayFills(String code, LocalDate session) {
        List<PaperStore.Fill> out = new ArrayList<>();
        for (PaperStore.Fill f : store.recentFills(code, 50)) {
            if (session.equals(f.observationDate())) {
                out.add(f);
            }
        }
        return out;
    }

    /**
     * 판단 결정 행과 계획 행 DONE(장부 잠금 안 한 트랜잭션) — {@link PaperCheckpointJob}의 쓰기와 같은 규칙(KEEP은 아무것도 바꾸지 않음, REPLACE는
     * 예상 상태로 새 주문을 검증하고 기준 시각이 지금보다 뒤인 대기 주문만 대신한 뒤 통과 주문을 대기로 넣음, 호출하는 사이 운용 중이 아니게 됐으면
     * 적용하지 않음)에 다음 판단 예약({@code nextCheckpoint})을 더한 것. 같은 d의 그 순번 결정이 그사이 생겼으면 그 행으로.
     */
    private long write(ClaudeDecisionPipeline pipeline, IntradayPlan p, Checkpoint c, LocalDate asOf, String kind, int max,
                       SettingsRow row, ClaudeSettings claudeSettings, Attempt attempt, Integer lag, Instant calledAt,
                       Optional<Quotes> quotes, Optional<Snapshot> watch, Optional<Snapshot> bars) {
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
            ExpectedState.State expected = ExpectedState.of(store.state(code).orElse(null), store.positions(code), pending,
                    p.sessionDate(), now, PaperCheckpointJob.before(bars, now), PaperCheckpointJob.before(watch, now),
                    quotes.orElse(null), calendar);
            Book current = store.book(code).orElse(null);
            boolean replace = "REPLACE".equals(Json.asText(attempt.parsed(), "action"));
            boolean active = current != null && PaperBooks.ACTIVE.equals(current.status());
            Set<String> universe = new TreeSet<>(ClaudeDecisionPipeline.observedUniverse(quotes));
            expected.positions().forEach(position -> universe.add(position.ticker()));
            store.positions(code).forEach(position -> universe.add(position.ticker()));
            String notApplied = null;
            if (replace && active) {
                replies = pipeline.checkpointReplies();
                try {
                    plan = replies.plan(asOf, kind, false, attempt, expected.view(), row, claudeSettings, quotes, universe, Map.of(),
                            PaperCheckpointJob.dueDiscretionary(store, expected, pending, asOf));
                } catch (RuntimeException e) {
                    // 과금된 응답 — 검증할 수 없어도(예: 예상 순자산 0) 결정 행과 DONE을 남겨 다시 부르지 않음(재시도 없음).
                    notApplied = "검증할 수 없어 적용하지 않음: " + e.getMessage();
                    log.warn("장중 판단 {} REPLACE 검증 실패 — 적용하지 않음: {}", key(p), e.toString());
                }
            }
            if (plan != null) {
                response = plan.response();
                status = plan.status();
                // 형식 검사를 통과했으면 주문이 모두 거절돼도 기준 시각이 지금보다 뒤인 대기 주문만 대신함.
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
            response.set("expectedState", mapper.valueToTree(expected.toMap(calendar)));
            // 다음 판단 예약(nextCheckpoint) — 계좌가 운용 중일 때만. 순번을 다 썼거나 규칙에 맞지 않으면 버리고 사유를 남김.
            if (active) {
                next = planner.next(pipeline.profile(), attempt.parsed(), p.sessionDate(), p.slot(), calendar, universe, max, now,
                        mapper);
                if (next != null) {
                    response.set("intradayPlan", next.view(mapper, "atEt"));
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
            log.warn("장중 판단 {} 행이 그사이 PLANNED가 아니게 됨 — 결정 {}은 남김", key(p), id);
        }
        if (next != null && inserted.isPresent()) {
            // 다음 순번 행 — 그 세션의 결정(source)은 그대로, 예약한 판단은 이 응답 결정.
            planner.write(next, p.sourceDecisionId(), id);
        }
        return id;
    }

    /** 판단 결정 응답의 {@code checkpoint} 칸 — 그 계획(세션·순번·시각·피드·그 세션의 결정·수동 여부)과 감시 저장본 지연. */
    private ObjectNode request(IntradayPlan p, Integer lag) {
        ObjectNode request = mapper.createObjectNode();
        request.put("session", p.sessionDate().toString());
        request.put("slot", p.slot());
        request.put("atEt", CheckpointPacket.clock(p.atLocal()));
        request.put("feed", p.feed());
        request.put("sourceDecisionId", p.sourceDecisionId());
        request.put("manual", p.manual());
        request.put("lagSeconds", lag);
        return request;
    }

    /** 상태만 바꿈(부르지 않음) — 바꾼 상태 문구. 그사이 PLANNED가 아니면 null. */
    private String mark(IntradayPlan p, String status, String reason) {
        int marked = store.markIntradayPlan(p.bookCode(), p.sessionDate(), p.slot(), PaperBooks.CHECKPOINT_PLANNED, status, reason,
                null, null, null);
        if (marked == 0) {
            return null;
        }
        log.info("장중 판단 {} {} — {}", key(p), status, reason);
        return status + " " + reason;
    }
}
