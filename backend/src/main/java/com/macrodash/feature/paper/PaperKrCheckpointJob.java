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
 * 한국 Claude 계좌2 장중 확인 정기 작업(단계 2b — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §5·§10) — 60초마다 한국 계좌2의 PLANNED 장중 확인 행을
 * 보고, 확인 시각 T(그 세션 날짜의 서울 시각) + {@value PaperCheckpointJob#WINDOW_START_MINUTES}분 ~ + {@value PaperCheckpointJob#WINDOW_END_MINUTES}분
 * 창에서 <b>한 번</b> Claude를 부릅니다(재시도 없음). 미국 {@link PaperCheckpointJob}과 같은 상태 기계이고(사유 글자도 같음), 다른 것은 한국 자료
 * (감시 저장본 {@code paper.watch.kr}·밤 관측치)·한국 패킷({@link KrCheckpointPacket})·예상 상태({@link KrExpectedState})·스위치({@code kr.claude2.checkpoints})와,
 * 한국에는 결정 주기 소상한이 없다는 것(계좌2 하루 최대 2회 — 밤 결정 1 + 확인 1이 구조로 정해짐)입니다. 미국 실험의 작업을 건드리지 않으려고 따로 둡니다.
 *
 * <ul>
 *   <li><b>꺼짐</b>: {@code dashboard.paper.enabled=false}면 아무것도 읽거나 쓰지 않습니다(로컬 v2). 설정 {@code kr.claude2.checkpoints}가 꺼져 있으면 부르지 않고,
 *       PLANNED 행은 창이 끝난 뒤 SKIPPED {@code CHECKPOINTS_OFF}.</li>
 *   <li><b>놓침</b>(EXPIRED): 지난 세션 {@code STALE_SESSION}, 창이 끝남 {@code WINDOW_MISSED}(창 안에서 감시 저장본을 기다렸으면 {@code NO_WATCH_SNAPSHOT},
 *       부르기 전 작업 오류가 이어졌으면 {@code JOB_ERROR}), 하루 상한 {@code CALL_CAP}, 부른 뒤 기록하지 못함 {@code CALLED_NOT_RECORDED}.</li>
 *   <li><b>건너뜀</b>(SKIPPED): 계좌가 운용 중이 아님 {@code BOOK_NOT_ACTIVE}, 그 세션이 휴장 {@code NO_SESSION_BARS}, T가 마감 − 30분 뒤 {@code LATE_CHECKPOINT}.</li>
 *   <li><b>자료</b>: 그 확인(계좌·세션·시각)의 감시 저장본이고 T 뒤·지금 앞에 받은 것. 기준 종목의 그날 봉이 없으면(임시 휴장) SKIPPED. 저장본은
 *       {@link StoreReader#quietly}로만 읽습니다.</li>
 *   <li><b>쓰기</b>(장부 잠금 안 한 트랜잭션): 결정 행 kind CHECKPOINT(기준 거래일 = 밤 결정의 d)와 그 행의 DONE. KEEP은 NO_TRADE, REPLACE는 예상 상태로 새 주문을
 *       검증하고 기준 시각이 지금보다 뒤인 대기 주문만 대신한 뒤 통과 주문을 넣습니다. 응답 뒤 쓰기가 실패하면 실패 결정 행(AFTER_RESPONSE)으로 남겨 다시
 *       부르지 않습니다(미국과 같은 장치).</li>
 * </ul>
 */
@Service
public class PaperKrCheckpointJob {

    /** 작업 기록의 이름(paper_job_runs.job). */
    static final String JOB = "checkpoint_kr";
    /** 스위치가 꺼진 계획의 사유(미국 {@link PaperCheckpointJob#CHECKPOINTS_OFF}의 한국 키 판). */
    static final String CHECKPOINTS_OFF = "CHECKPOINTS_OFF — 설정 " + Claude2Settings.KR_CHECKPOINTS + "가 꺼져 있음";

    private static final Logger log = LoggerFactory.getLogger(PaperKrCheckpointJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final ClaudeBookService claude;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 실행 열기 — 한국 달력은 실행마다 공휴일 저장본으로 만듭니다(그 주기의 설정 행과 함께). */
    private final PaperMarkets markets;
    private final ReentrantLock running = new ReentrantLock();
    /** 창 안에서 기다린 행 → 그 사유(창 끝의 EXPIRED 사유). */
    private final Map<String, String> waiting = new HashMap<>();
    /** 응답을 받았는데 결정 행을 남기지 못한 행 — 다시 부르지 않습니다. */
    private final Set<String> called = new HashSet<>();

    @Autowired
    PaperKrCheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
                         PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, claude, ledger, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperKrCheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, ClaudeBookService claude,
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
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.kr-checkpoint-initial-delay-ms:175000}",
            fixedDelayString = "${dashboard.paper.kr-checkpoint-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            PaperCheckpointJob.Outcome outcome = run();
            if (outcome != null && outcome.error() != null) {
                log.warn("한국 장중 확인 작업 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            }
        } catch (RuntimeException e) {
            log.warn("한국 장중 확인 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 주기 — 테스트가 부릅니다. 앞 주기가 도는 중이면 null. */
    PaperCheckpointJob.Outcome run() {
        if (!running.tryLock()) {
            return null;
        }
        try {
            return cycle();
        } finally {
            running.unlock();
        }
    }

    private PaperCheckpointJob.Outcome cycle() {
        if (!store.ready()) {
            return new PaperCheckpointJob.Outcome(0, Map.of(), null);
        }
        Instant started = clock.instant();
        List<Checkpoint> planned = store.plannedCheckpoints(PaperBooks.KR_CLAUDE2);
        if (planned.isEmpty()) {
            waiting.clear();
            called.clear();
            return new PaperCheckpointJob.Outcome(0, Map.of(), null);
        }
        MarketRun run = markets.open(KrPaperMarket.INSTANCE);
        SettingsRow row = run.settingsRow().orElse(null);
        Map<String, String> changes = new LinkedHashMap<>();
        String error = null;
        for (Checkpoint c : planned) {
            try {
                String change = handle(c, row, run);
                if (change != null) {
                    changes.put(c.sessionDate().toString(), change);
                    waiting.remove(key(c));
                    called.remove(key(c));
                }
            } catch (RuntimeException e) {
                error = c.sessionDate() + ": " + e;
                log.warn("한국 장중 확인 {} 처리 실패 — 다음 주기에 다시 봅니다: {}", c.sessionDate(), e.toString());
                if (!called.contains(key(c))) {
                    String cause = e.toString();
                    waiting.put(key(c), PaperCheckpointJob.JOB_ERROR + ": " + (cause.length() > PaperCheckpointJob.JOB_ERROR_CAUSE_CHARS
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
                log.warn("한국 장중 확인 작업 기록 실패: {}", e.toString());
            }
        }
        return new PaperCheckpointJob.Outcome(planned.size(), changes, error);
    }

    private static String key(Checkpoint c) {
        return c.bookCode() + "|" + c.sessionDate();
    }

    /** 행 하나 — 바꾼 상태 문구, 기다리면 null. */
    private String handle(Checkpoint c, SettingsRow row, MarketRun run) {
        Instant now = clock.instant();
        LocalDate session = c.sessionDate();
        TradingCalendar calendar = run.calendar();
        Instant at = KrCheckpointRequest.targetAt(session, c.atLocal());
        boolean stale = session.isBefore(now.atZone(KrxCalendar.SEOUL).toLocalDate());
        boolean windowOver = stale || now.isAfter(at.plus(PaperCheckpointJob.WINDOW_END));
        if (row == null || !Claude2Settings.krCheckpoints(row.body())) {
            return windowOver ? mark(c, PaperBooks.CHECKPOINT_SKIPPED, CHECKPOINTS_OFF) : null;
        }
        if (stale) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.STALE_SESSION);
        }
        if (now.isBefore(at.plus(PaperCheckpointJob.WINDOW_START))) {
            return null;
        }
        if (windowOver) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, waiting.getOrDefault(key(c), PaperCheckpointJob.WINDOW_MISSED));
        }
        Book book = store.book(PaperBooks.KR_CLAUDE2).orElse(null);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.BOOK_NOT_ACTIVE);
        }
        if (!calendar.isTradingDay(session)) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
        }
        if (at.isAfter(calendar.closeInstant(session).minus(KrCheckpointRequest.BEFORE_CLOSE))) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.LATE_CHECKPOINT);
        }
        Decision source = store.decision(c.sourceDecisionId()).orElse(null);
        if (source == null) {
            return null;   // 요청 결정을 지우면 행도 함께 지워짐(V18 CASCADE) — 그사이의 경합
        }
        LocalDate asOf = source.asOfTradingDate();
        Optional<Decision> decided = store.decisionFor(PaperBooks.KR_CLAUDE2, asOf, RuleBookService.CHECKPOINT);
        if (decided.isPresent()) {
            store.markCheckpoint(PaperBooks.KR_CLAUDE2, session, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                    doneReason(decided.get()), decided.get().id(), null, decided.get().decidedAt());
            return PaperBooks.CHECKPOINT_DONE + " 결정 #" + decided.get().id() + "(이미 부름)";
        }
        if (called.contains(key(c))) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALLED_NOT_RECORDED);
        }

        Snapshot snapshot = reader.quietly(() -> marketData.watchKr()).filter(s -> freshWatch(s, c, at, now)).orElse(null);
        if (snapshot == null) {
            waiting.put(key(c), PaperCheckpointJob.NO_WATCH_SNAPSHOT);
            return null;
        }
        JsonNode reference = snapshot.payload().path("tickers").path(Json.asText(snapshot.payload(), "reference"));
        if (reference.isObject() && !session.toString().equals(Json.asText(reference, "session"))) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, PaperCheckpointJob.NO_SESSION_BARS);
        }
        JsonNode measured = snapshot.payload().get("lagSeconds");
        Integer lag = measured != null && measured.isNumber() ? measured.asInt() : null;
        Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(KrPaperMarket.INSTANCE));

        ClaudeSettings claudeSettings = ClaudeSettings.from(row.body());
        LocalDate today = Kst.today(clock);
        ClaudeDecisionPipeline pipeline = claude.krClaude2Pipeline(run);
        if (pipeline.callsLeft(today, claudeSettings, true) <= 0) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }
        Optional<Snapshot> watch = Optional.of(snapshot);
        Instant calledAt = clock.instant();
        Attempt attempt = pipeline.attemptCheckpoint(version -> KrCheckpointPacket.build(new KrCheckpointPacket.Inputs(c, asOf,
                source, store.state(PaperBooks.KR_CLAUDE2).orElse(null), store.positions(PaperBooks.KR_CLAUDE2), pendingOrders(),
                watch, quotes, version, row.version(), calendar, clock.instant()), mapper), row, claudeSettings, today);
        if (attempt == null) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, PaperCheckpointJob.CALL_CAP);
        }
        long id;
        try {
            id = ledger.exclusively(() -> store.atomically(() -> write(pipeline, c, asOf, row, claudeSettings, attempt, lag,
                    calledAt, snapshot.payload(), quotes, calendar)));
        } catch (RuntimeException e) {
            // 과금된 응답 — 쓰기가 되돌려져도 다시 부르지 않음. 실패 결정 행을 따로 남기고 행을 DONE으로.
            called.add(key(c));
            pipeline.recordAfterResponse(asOf, RuleBookService.CHECKPOINT, row, claudeSettings, false, attempt, null, e,
                    checkpointRequest(c, lag));
            try {
                store.decisionFor(PaperBooks.KR_CLAUDE2, asOf, RuleBookService.CHECKPOINT).ifPresent(d -> store.markCheckpoint(
                        PaperBooks.KR_CLAUDE2, session, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                        doneReason(d), d.id(), lag, calledAt));
            } catch (RuntimeException again) {
                e.addSuppressed(again);
            }
            throw e;
        }
        log.info("한국 Claude 계좌2 장중 확인 {} {} KST: {} — 결정 {}", session, KrTimedLadder.label(c.atLocal()),
                attempt.succeeded() ? Json.asText(attempt.parsed(), "action") : attempt.status(), id);
        return PaperBooks.CHECKPOINT_DONE + " 결정 #" + id;
    }

    /** 그 확인의 감시 저장본인가 — 계좌·세션·시각이 같고, T 뒤·지금 앞에 받았음. */
    private static boolean freshWatch(Snapshot s, Checkpoint c, Instant at, Instant now) {
        JsonNode cp = s.payload() == null ? null : s.payload().get("checkpoint");
        return cp != null && s.collectedAt() != null && !s.collectedAt().isBefore(at) && !s.collectedAt().isAfter(now)
                && c.bookCode().equals(Json.asText(cp, "book"))
                && c.sessionDate().toString().equals(Json.asText(cp, "sessionDate"))
                && KrTimedLadder.label(c.atLocal()).equals(Json.asText(cp, KrCheckpointRequest.AT_FIELD));
    }

    private List<PaperStore.Order> pendingOrders() {
        return store.ordersByStatus(PaperBooks.KR_CLAUDE2, PaperBooks.ORDER_PENDING).stream()
                .filter(o -> PacketBuilder.SOURCE_CLAUDE.equals(o.source())).toList();
    }

    /** 확인 결정 행과 장중 확인 행 DONE(장부 잠금 안 한 트랜잭션) — 미국 {@link PaperCheckpointJob}의 쓰기와 같은 규칙(클래스 설명). */
    private long write(ClaudeDecisionPipeline pipeline, Checkpoint c, LocalDate asOf, SettingsRow row,
                       ClaudeSettings claudeSettings, Attempt attempt, Integer lag, Instant calledAt, JsonNode watch,
                       Optional<Quotes> quotes, TradingCalendar calendar) {
        ObjectNode response;
        String status;
        String error = null;
        ClaudeDecisionPipeline replies = null;
        ClaudeDecisionPipeline.Plan plan = null;
        if (attempt.succeeded()) {
            Instant now = clock.instant();
            List<PaperStore.Order> pending = pendingOrders();
            ExpectedState.State expected = KrExpectedState.of(store.state(PaperBooks.KR_CLAUDE2).orElse(null),
                    store.positions(PaperBooks.KR_CLAUDE2), pending, c.sessionDate(), now, watch, quotes.orElse(null), calendar);
            Book current = store.book(PaperBooks.KR_CLAUDE2).orElse(null);
            boolean replace = "REPLACE".equals(Json.asText(attempt.parsed(), "action"));
            boolean active = current != null && PaperBooks.ACTIVE.equals(current.status());
            String notApplied = null;
            if (replace && active) {
                replies = pipeline.checkpointReplies();
                Set<String> universe = new TreeSet<>(ClaudeDecisionPipeline.observedUniverse(quotes));
                expected.positions().forEach(p -> universe.add(p.ticker()));
                try {
                    plan = replies.plan(asOf, RuleBookService.CHECKPOINT, false, attempt, expected.view(), row, claudeSettings,
                            quotes, universe, Map.of(), dueDiscretionary(expected, pending, asOf));
                } catch (RuntimeException e) {
                    notApplied = "검증할 수 없어 적용하지 않음: " + e.getMessage();
                    log.warn("한국 장중 확인 {} REPLACE 검증 실패 — 적용하지 않음: {}", c.sessionDate(), e.toString());
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
                    response.put("appliedNote", "Claude를 부르는 사이에 계좌2가 운용 중이 아니게 돼(상태 "
                            + (current == null ? "없음" : current.status()) + ") 대기 주문·새 주문을 바꾸지 않음");
                } else if (replace) {
                    response.put("applied", false);
                    response.put("appliedNote", notApplied + " — 대기 주문·새 주문을 바꾸지 않음");
                }
            }
            Map<String, Object> expectedView = expected.toMap(calendar);
            expectedView.put("note", KrExpectedState.NOTE);
            response.set("expectedState", mapper.valueToTree(expectedView));
        } else {
            response = mapper.createObjectNode();
            status = attempt.status();
            error = attempt.error();
            response.put("summary", ClaudeDecisionPipeline.statusLabel(attempt.status()) + " — 장중 확인 재시도 없음(밤 주문 그대로)");
            ObjectNode failure = response.putObject("failure");
            failure.put("status", attempt.status());
            failure.put("errorKind", attempt.result().errorKind());
            failure.put("message", attempt.error());
            failure.put("charged", attempt.result().charged());
            failure.set("violations", mapper.valueToTree(attempt.violations()));
        }
        response.put("book", PaperBooks.KR_CLAUDE2);
        response.put("kind", RuleBookService.CHECKPOINT);
        response.put("asOfTradingDate", asOf.toString());
        response.set("checkpoint", checkpointRequest(c, lag));
        response.put("retry", false);
        response.set("framework", mapper.valueToTree(FrameworkService.decisionView(attempt.frame())));
        Decision decision = pipeline.decisionRow(0, asOf, RuleBookService.CHECKPOINT, status, row, claudeSettings, attempt,
                null, response, error, false, 0);
        Optional<Long> inserted = store.insertDecisionIfAbsent(decision);
        long id = inserted.orElseGet(() -> store.decisionFor(PaperBooks.KR_CLAUDE2, asOf,
                RuleBookService.CHECKPOINT).map(Decision::id).orElseThrow());
        if (plan != null && inserted.isPresent()) {
            replies.insertOrders(id, asOf, plan, PaperBooks.ORDER_PENDING);
        }
        int marked = store.markCheckpoint(PaperBooks.KR_CLAUDE2, c.sessionDate(), PaperBooks.CHECKPOINT_PLANNED,
                PaperBooks.CHECKPOINT_DONE, attempt.succeeded() ? null : attempt.status() + " — 재시도 없음", id, lag, calledAt);
        if (marked == 0) {
            log.warn("한국 장중 확인 {} 행이 그사이 PLANNED가 아니게 됨 — 결정 {}은 남김", c.sessionDate(), id);
        }
        return id;
    }

    /** 확인 결정 응답의 {@code checkpoint} 칸 — 그 요청(세션·시각·피드·밤 결정)과 감시 저장본 지연. */
    private ObjectNode checkpointRequest(Checkpoint c, Integer lag) {
        ObjectNode request = mapper.createObjectNode();
        request.put("session", c.sessionDate().toString());
        request.put(KrCheckpointRequest.AT_FIELD, KrTimedLadder.label(c.atLocal()));
        request.put("feed", c.feed());
        request.put("sourceDecisionId", c.sourceDecisionId());
        request.put("lagSeconds", lag);
        return request;
    }

    /**
     * 이달 재량 주문 수에 더 셀 대기 주문 수 — 예상 상태가 기준 시각이 지나 체결로 본 주문과 가격을 몰라 빼 둔 주문 가운데 월 수의 규칙
     * ({@link KrPacketBuilder#monthlyDiscretionaryOrders} — 출처 CLAUDE·기준일이 그 달·출발 결정 INITIAL이 아님)에 드는 것(미국 작업과 같은 까닭).
     */
    private int dueDiscretionary(ExpectedState.State expected, List<PaperStore.Order> pending, LocalDate asOf) {
        Set<Long> due = new HashSet<>(expected.unpriced());
        expected.assumed().forEach(a -> due.add(a.orderId()));
        java.time.YearMonth month = java.time.YearMonth.from(asOf);
        int count = 0;
        for (PaperStore.Order o : pending) {
            if (!due.contains(o.id()) || o.asOfTradingDate() == null || o.asOfTradingDate().isAfter(asOf)
                    || !java.time.YearMonth.from(o.asOfTradingDate()).equals(month)) {
                continue;
            }
            boolean initial = o.decisionId() != null && store.decision(o.decisionId())
                    .map(d -> RuleBookService.INITIAL.equals(d.kind())).orElse(false);
            if (!initial) {
                count++;
            }
        }
        return count;
    }

    /** 이미 있는 확인 결정으로 행을 DONE으로 둘 때의 사유(미국 작업과 같음). */
    private static String doneReason(Decision d) {
        JsonNode failure = d.response() == null ? null : d.response().get("failure");
        if (failure == null || !failure.isObject()) {
            return null;
        }
        return "AFTER_RESPONSE".equals(Json.asText(failure, "stage")) ? PaperCheckpointJob.AFTER_RESPONSE
                : d.status() + " — 재시도 없음";
    }

    /** 상태만 바꿈(부르지 않음) — 바꾼 상태 문구. 그사이 PLANNED가 아니면 null. */
    private String mark(Checkpoint c, String status, String reason) {
        int marked = store.markCheckpoint(c.bookCode(), c.sessionDate(), PaperBooks.CHECKPOINT_PLANNED, status, reason, null,
                null, null);
        if (marked == 0) {
            return null;
        }
        log.info("한국 장중 확인 {} {} — {}", c.sessionDate(), status, reason);
        return status + " " + reason;
    }
}
