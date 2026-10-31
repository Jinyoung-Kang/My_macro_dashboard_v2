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
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
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
 * 🧪 장중 확인 정기 작업(미국 Claude 계좌2 단계 2 — 계좌2 명세 docs/specs/2026-10-30-claude-book2-timing-design.md §5-2·§5-3·§12, ADR 0022) — 60초마다
 * 계좌2의 PLANNED 장중 확인 행({@code paper_checkpoints})을 보고, 확인 시각 T(그 세션 날짜의 뉴욕 시각) + {@value #WINDOW_START_MINUTES}분 ~ +
 * {@value #WINDOW_END_MINUTES}분 창에서 <b>한 번</b> Claude를 부릅니다(재시도 없음 — 놓치면 나중에 대신 부르지 않음).
 *
 * <ul>
 *   <li><b>꺼짐</b>: {@code dashboard.paper.enabled=false}면 아무것도 읽거나 쓰지 않습니다(로컬 v2 — {@code PaperRiskJob} 선례). 설정
 *       {@code claude2.enabled}·{@code claude2.checkpoints}가 꺼져 있으면 부르지 않고, PLANNED 행은 그 창이 끝난 뒤 SKIPPED {@code CHECKPOINTS_OFF}.</li>
 *   <li><b>놓침</b>(EXPIRED): 지난 세션의 행 {@code STALE_SESSION}, 창이 끝남 {@code WINDOW_MISSED}(서버 꺼짐·늦게 켜짐 — 창 안에서 자료를 기다리던
 *       행은 그 사유 {@code NO_WATCH_SNAPSHOT}·{@code NO_FRESH_QUOTES}, 마지막 주기가 부르기 전 작업 오류로 끝난 행은 {@code JOB_ERROR}), 결정 주기 소상한
 *       {@code CYCLE_CAP}·하루 상한 {@code CALL_CAP}(바로 — 재시도가 없어 기다릴 까닭이 없음), 부른 뒤 결정을 기록하지 못함
 *       {@code CALLED_NOT_RECORDED}.</li>
 *   <li><b>건너뜀</b>(SKIPPED): 계좌2가 운용 중이 아님 {@code BOOK_NOT_ACTIVE}, T가 E 마감 − 30분 뒤 {@code LATE_CHECKPOINT}, E에 세션 봉이 없음
 *       (감시 저장본의 SPY가 E 세션이 아님 — 임시 휴장) {@code NO_SESSION_BARS}.</li>
 *   <li><b>자료</b>: MINUTE는 T 뒤에 받은 그 확인의 감시 저장본({@code paper.watch.us} — 계좌·세션·시각이 같고 {@link Datasets#MAX_AGE_WATCH_US} 안),
 *       HOURLY는 SPY 봉 날짜가 E인 시간별 관측치가 있어야 부릅니다. 저장본은 {@link StoreReader#quietly}로만 읽습니다(수집 유발 금지 — ADR 0008).</li>
 *   <li><b>호출</b>: 장중 확인 패킷({@link CheckpointPacket})을 c2-2 시스템 프롬프트와 {@value CheckpointPacket#SCHEMA_RESOURCE}로 한 번
 *       ({@link ClaudeDecisionPipeline#attemptCheckpoint} — 정기 작업 문턱). 장부 잠금·트랜잭션 밖입니다.</li>
 *   <li><b>쓰기</b>(장부 잠금 안 한 트랜잭션): 결정 행 kind CHECKPOINT(기준 거래일 = 아침 결정의 d — UNIQUE가 세션당 한 번을 강제)와 그 행의 DONE
 *       (확인 결정·감시 저장본 지연·부른 시각). API 오류·형식 오류·거절도 결정 행을 남기고 DONE입니다(재시도 없음 — 결정 작업은 정기·출발 행만 재시도).
 *       응답을 받은 뒤 이 쓰기가 예외로 끝나면(DB 순간 장애 등 — 트랜잭션이 되돌려짐) 과금된 응답을 버리고 다시 부르지 않게, 실패 결정 행(API_ERROR·
 *       {@code failure.stage = AFTER_RESPONSE})을 따로 한 트랜잭션으로 남기고 행을 DONE으로 둡니다({@link ClaudeDecisionPipeline#recordAfterResponse}
 *       — 결정 작업과 같은 장치). 그 기록마저 실패하면 작업 메모리의 '부름'({@link #called})으로 창 안에서 다시 부르지 않고 EXPIRED
 *       {@code CALLED_NOT_RECORDED}로 둡니다(재기동하면 메모리가 비므로 그때만 다시 부를 수 있음 — 하루 상한이 막음).
 *       KEEP은 NO_TRADE + action KEEP. REPLACE는 예상 상태(§10-6)로 새 주문을 검증하고(월 상한은 기준 시각이 지난 대기 재량 주문도 셈), 기준
 *       시각이 지금보다 뒤인 대기 주문만 대신한 뒤(⑩) 통과 주문을 넣습니다({@link #write}).</li>
 * </ul>
 *
 * <p>자기 잠금({@link #running})으로 겹치지 않고, 결정 작업의 잠금을 쓰지 않습니다 — 확인 호출(최대 300초)이 결정 작업과 서로 기다리지 않게.
 * 작업 기록({@code paper_job_runs}, 이름 {@value #JOB})은 행 상태를 바꾼 주기와 오류만 남깁니다. 예외는 로그로만(스케줄러로 던지지 않음).
 * 수동 실행 경로는 없습니다(§5-4).
 */
@Service
public class PaperCheckpointJob {

    /** 작업 기록의 이름(paper_job_runs.job). */
    static final String JOB = "checkpoint";
    /** 호출 창 시작 — T + 이만큼(감시 저장본이 T 뒤 한 회차 쌓일 여유). */
    static final long WINDOW_START_MINUTES = 2;
    /** 호출 창 끝 — T + 이만큼. 지나면 놓침. */
    static final long WINDOW_END_MINUTES = 20;
    static final Duration WINDOW_START = Duration.ofMinutes(WINDOW_START_MINUTES);
    static final Duration WINDOW_END = Duration.ofMinutes(WINDOW_END_MINUTES);
    /** 정규장 개장 뒤 이만큼 지나 받은 저장본에 E 세션 봉이 없으면 임시 휴장으로 봄. */
    static final Duration SESSION_EVIDENCE_AFTER_OPEN = Duration.ofMinutes(5);

    // 사유 코드('CODE — 설명').
    static final String STALE_SESSION = "STALE_SESSION — 지난 세션의 계획(그 세션에 부르지 못함)";
    static final String WINDOW_MISSED = "WINDOW_MISSED — 호출 창(+2~+20분)을 놓침(서버 꺼짐·늦게 켜짐)";
    static final String NO_WATCH_SNAPSHOT = "NO_WATCH_SNAPSHOT — 확인 시각 뒤에 받은 감시 저장본이 창 끝까지 없음";
    static final String NO_FRESH_QUOTES = "NO_FRESH_QUOTES — 그 세션의 시간별 관측치가 창 끝까지 없음";
    static final String CYCLE_CAP = "CYCLE_CAP — 계좌2 소상한(claude2.maxCallsPerCycle)에 닿음";
    static final String CALL_CAP = "CALL_CAP — 하루 호출 상한에 닿음";
    static final String BOOK_NOT_ACTIVE = "BOOK_NOT_ACTIVE — 계좌2가 운용 중이 아님";
    static final String LATE_CHECKPOINT = "LATE_CHECKPOINT — 확인 시각이 그 세션 마감 30분 전보다 늦음";
    static final String NO_SESSION_BARS = "NO_SESSION_BARS — 그 세션의 봉이 없음(임시 휴장)";
    static final String CHECKPOINTS_OFF = "CHECKPOINTS_OFF — 설정 claude2.checkpoints·claude2.enabled가 꺼져 있음";
    static final String JOB_ERROR = "JOB_ERROR — 부르기 전 작업 오류가 창 끝까지 이어짐(서버는 켜져 있었음)";
    /** {@link #JOB_ERROR} 뒤에 붙이는 원인 글자 수 상한. */
    static final int JOB_ERROR_CAUSE_CHARS = 200;
    static final String CALLED_NOT_RECORDED = "CALLED_NOT_RECORDED — 부른 뒤 결정을 기록하지 못함(과금된 응답 — 다시 부르지 않음)";
    /** 응답을 받은 뒤 쓰기가 실패해 실패 결정 행(API_ERROR·AFTER_RESPONSE)으로 끝낸 행의 DONE 사유. */
    static final String AFTER_RESPONSE = "API_ERROR — 응답을 받은 뒤 검증·저장 중 오류(과금된 응답 — 재시도 없음)";

    private static final Logger log = LoggerFactory.getLogger(PaperCheckpointJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PacketBuilder packets;
    private final ClaudeBookService claude;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 미국 시장 묶음의 달력(미국 전용 작업 — 장중 확인은 미국 계좌2만). */
    private final TradingCalendar calendar = UsPaperMarket.INSTANCE.calendar();
    /** 이 작업의 잠금 — 결정 작업의 잠금과 따로입니다(클래스 설명). */
    private final ReentrantLock running = new ReentrantLock();
    /** 창 안에서 자료를 기다린 행 → 그 사유(창 끝의 EXPIRED 사유). 재기동하면 비어 WINDOW_MISSED로 남습니다. */
    private final Map<String, String> waiting = new HashMap<>();
    /** 응답을 받았는데 결정 행을 남기지 못한 행(클래스 설명의 '쓰기') — 다시 부르지 않습니다. 재기동하면 비어 있습니다. */
    private final Set<String> called = new HashSet<>();

    @Autowired
    PaperCheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PacketBuilder packets,
                       ClaudeBookService claude, PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, packets, claude, ledger, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperCheckpointJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PacketBuilder packets,
                       ClaudeBookService claude, PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper,
                       Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.packets = packets;
        this.claude = claude;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 한 주기의 결과.
     *
     * @param planned 본 PLANNED 행 수
     * @param changes 상태를 바꾼 행(세션 → 'STATUS 사유' — 부른 행은 'DONE 결정 #id')
     * @param error   실패 사유 — 없으면 null
     */
    record Outcome(int planned, Map<String, String> changes, String error) {

        Outcome {
            changes = Map.copyOf(changes);
        }
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 앞 주기가 도는 중이면 건너뜁니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.checkpoint-initial-delay-ms:165000}",
            fixedDelayString = "${dashboard.paper.checkpoint-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            Outcome outcome = run();
            if (outcome != null && outcome.error() != null) {
                log.warn("장중 확인 작업 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            }
        } catch (RuntimeException e) {
            log.warn("장중 확인 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
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
        List<Checkpoint> planned = store.plannedCheckpoints(PaperBooks.CLAUDE2);
        if (planned.isEmpty()) {
            waiting.clear();
            called.clear();
            return new Outcome(0, Map.of(), null);
        }
        SettingsRow row = store.settings().orElse(null);
        Claude2Settings book2 = Claude2Settings.from(row == null ? null : row.body());
        Map<String, String> changes = new LinkedHashMap<>();
        String error = null;
        for (Checkpoint c : planned) {
            try {
                String change = handle(c, row, book2);
                if (change != null) {
                    changes.put(c.sessionDate().toString(), change);
                    waiting.remove(key(c));
                    called.remove(key(c));
                }
            } catch (RuntimeException e) {
                error = c.sessionDate() + ": " + e;
                log.warn("장중 확인 {} 처리 실패 — 다음 주기에 다시 봅니다: {}", c.sessionDate(), e.toString());
                if (!called.contains(key(c))) {
                    // 부르기 전 오류 — 창 끝까지 이어지면 '서버 꺼짐'(WINDOW_MISSED)이 아니라 이 사유로 EXPIRED(리뷰 OPS-5).
                    String cause = e.toString();
                    waiting.put(key(c), JOB_ERROR + ": " + (cause.length() > JOB_ERROR_CAUSE_CHARS
                            ? cause.substring(0, JOB_ERROR_CAUSE_CHARS) + "…" : cause));
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
                log.warn("장중 확인 작업 기록 실패: {}", e.toString());
            }
        }
        return new Outcome(planned.size(), changes, error);
    }

    private static String key(Checkpoint c) {
        return c.bookCode() + "|" + c.sessionDate();
    }

    /** 행 하나(클래스 설명) — 바꾼 상태 문구, 기다리면 null. */
    private String handle(Checkpoint c, SettingsRow row, Claude2Settings book2) {
        Instant now = clock.instant();
        LocalDate session = c.sessionDate();
        Instant at = CheckpointPacket.targetAt(c, calendar);
        LocalDate nyToday = now.atZone(calendar.zone()).toLocalDate();
        boolean stale = session.isBefore(nyToday);
        boolean windowOver = stale || now.isAfter(at.plus(WINDOW_END));
        if (row == null || !book2.enabled() || !book2.checkpoints()) {
            return windowOver ? mark(c, PaperBooks.CHECKPOINT_SKIPPED, CHECKPOINTS_OFF) : null;
        }
        if (stale) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, STALE_SESSION);
        }
        if (now.isBefore(at.plus(WINDOW_START))) {
            return null;
        }
        if (windowOver) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, waiting.getOrDefault(key(c), WINDOW_MISSED));
        }
        Book book = store.book(PaperBooks.CLAUDE2).orElse(null);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, BOOK_NOT_ACTIVE);
        }
        if (!calendar.isTradingDay(session)) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, NO_SESSION_BARS);
        }
        if (at.isAfter(calendar.closeInstant(session).minus(ExecutionSection.CHECKPOINT_BEFORE_CLOSE))) {
            return mark(c, PaperBooks.CHECKPOINT_SKIPPED, LATE_CHECKPOINT);
        }
        Decision source = store.decision(c.sourceDecisionId()).orElse(null);
        if (source == null) {
            return null;   // 요청 결정을 지우면 행도 함께 지워짐(V18 CASCADE) — 그사이의 경합
        }
        LocalDate asOf = source.asOfTradingDate();
        Optional<Decision> decided = store.decisionFor(PaperBooks.CLAUDE2, asOf, RuleBookService.CHECKPOINT);
        if (decided.isPresent()) {
            // 세션당 한 번 — 이미 부른 확인 결정이 있으면 다시 부르지 않고 그 결정으로 끝냄.
            store.markCheckpoint(PaperBooks.CLAUDE2, session, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                    doneReason(decided.get()), decided.get().id(), null, decided.get().decidedAt());
            return PaperBooks.CHECKPOINT_DONE + " 결정 #" + decided.get().id() + "(이미 부름)";
        }
        if (called.contains(key(c))) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, CALLED_NOT_RECORDED);   // 부른 뒤 기록 실패 — 다시 부르지 않음
        }

        boolean minute = ExecutionSection.FEED_MINUTE.equals(c.feed());
        Optional<Snapshot> watch = minute ? reader.quietly(() -> marketData.watchUs()) : Optional.empty();
        Optional<Quotes> quotes = reader.quietly(marketData::quotes);
        Integer lag = null;
        if (minute) {
            Snapshot snapshot = watch.filter(s -> freshWatch(s, c, at, now)).orElse(null);
            if (snapshot == null) {
                waiting.put(key(c), NO_WATCH_SNAPSHOT);
                return null;
            }
            JsonNode spy = snapshot.payload().path("tickers").path(CheckpointPacket.REFERENCE);
            if (spy.isObject() && !session.toString().equals(Json.asText(spy, "session"))
                    && !snapshot.collectedAt().isBefore(calendar.openInstant(session).plus(SESSION_EVIDENCE_AFTER_OPEN))) {
                return mark(c, PaperBooks.CHECKPOINT_SKIPPED, NO_SESSION_BARS);
            }
            JsonNode measured = snapshot.payload().get("lagSeconds");
            lag = measured != null && measured.isNumber() ? measured.asInt() : null;
        } else {
            Bar spy = quotes.map(q -> q.bars().get(CheckpointPacket.REFERENCE)).orElse(null);
            if (spy == null || !session.equals(spy.date()) || quotes.get().collectedAt().isAfter(now)) {
                waiting.put(key(c), NO_FRESH_QUOTES);
                return null;
            }
        }

        int cycle = ClaudeBookService.claude2CallsInCycle(store, asOf);
        if (cycle >= book2.maxCallsPerCycle()) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, CYCLE_CAP + "(" + book2.maxCallsPerCycle() + "회, 결정 주기 " + asOf
                    + " — 지금 " + cycle + "회)");
        }
        ClaudeSettings claudeSettings = ClaudeSettings.from(row.body());
        LocalDate today = Kst.today(clock);
        ClaudeDecisionPipeline pipeline = claude.claude2CheckpointPipeline();
        if (pipeline.callsLeft(today, claudeSettings, true) <= 0) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, CALL_CAP);
        }

        JsonNode macro = packets.macroSection(asOf, row);
        Optional<Snapshot> watchFor = watch;
        // 예상 상태(§10-6)의 T 가격 — 1분봉 저장본(장부 2b와 같은 판정). 조용히 읽음(수집 유발 없음).
        Optional<Snapshot> bars = reader.quietly(() -> marketData.barsUs());
        Instant calledAt = clock.instant();
        Attempt attempt = pipeline.attemptCheckpoint(version -> CheckpointPacket.build(new CheckpointPacket.Inputs(c, asOf,
                source, store.state(PaperBooks.CLAUDE2).orElse(null), store.positions(PaperBooks.CLAUDE2),
                pendingOrders(), todayFills(session), watchFor, quotes, macro, version, row.version(),
                store.recentCheckpointLags(PaperBooks.CLAUDE2, ExecutionSection.FEED_MINUTE,
                        ExecutionSection.RECENT_LAG_SESSIONS), calendar, clock.instant(), bars), mapper),
                row, claudeSettings, today);
        if (attempt == null) {
            return mark(c, PaperBooks.CHECKPOINT_EXPIRED, CALL_CAP);
        }
        Integer lagSeconds = lag;
        Feeds feeds = new Feeds(quotes, watch, bars);
        long id;
        try {
            id = ledger.exclusively(() -> store.atomically(() -> write(pipeline, c, asOf, row, claudeSettings, attempt,
                    lagSeconds, calledAt, feeds)));
        } catch (RuntimeException e) {
            // 과금된 응답 — 쓰기가 되돌려져도 다시 부르지 않음(§5-2 재시도 없음, 리뷰 F1·OPS-1). 실패 결정 행을 따로 남기고 행을 DONE으로.
            called.add(key(c));
            pipeline.recordAfterResponse(asOf, RuleBookService.CHECKPOINT, row, claudeSettings, false, attempt, null, e);
            try {
                store.decisionFor(PaperBooks.CLAUDE2, asOf, RuleBookService.CHECKPOINT).ifPresent(d -> store.markCheckpoint(
                        PaperBooks.CLAUDE2, session, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE,
                        doneReason(d), d.id(), lagSeconds, calledAt));
            } catch (RuntimeException again) {
                e.addSuppressed(again);   // 다음 주기가 그 결정 행으로(또는 메모리의 '부름'으로) 끝냄
            }
            throw e;
        }
        log.info("Claude 계좌2 장중 확인 {} {} {}: {} — 결정 {}", session, CheckpointPacket.clock(c.atEt()), c.feed(),
                attempt.succeeded() ? Json.asText(attempt.parsed(), "action") : attempt.status(), id);
        return PaperBooks.CHECKPOINT_DONE + " 결정 #" + id;
    }

    /** 그 확인의 감시 저장본인가 — 계좌·세션·시각이 같고, T 뒤·지금 앞에 받았고, {@link Datasets#MAX_AGE_WATCH_US} 안. */
    private static boolean freshWatch(Snapshot s, Checkpoint c, Instant at, Instant now) {
        JsonNode cp = s.payload() == null ? null : s.payload().get("checkpoint");
        return cp != null && s.collectedAt() != null && !s.collectedAt().isBefore(at) && !s.collectedAt().isAfter(now)
                && Duration.between(s.collectedAt(), now).getSeconds() <= Datasets.MAX_AGE_WATCH_US
                && c.bookCode().equals(Json.asText(cp, "book"))
                && c.sessionDate().toString().equals(Json.asText(cp, "sessionDate"))
                && CheckpointPacket.clock(c.atEt()).equals(Json.asText(cp, "atEt"));
    }

    private List<PaperStore.Order> pendingOrders() {
        return store.ordersByStatus(PaperBooks.CLAUDE2, PaperBooks.ORDER_PENDING).stream()
                .filter(o -> "CLAUDE".equals(o.source())).toList();
    }

    /** 계좌2의 그 세션 체결(최근 순 50건 안). */
    private List<PaperStore.Fill> todayFills(LocalDate session) {
        List<PaperStore.Fill> out = new ArrayList<>();
        for (PaperStore.Fill f : store.recentFills(PaperBooks.CLAUDE2, 50)) {
            if (session.equals(f.observationDate())) {
                out.add(f);
            }
        }
        return out;
    }

    /** 확인 호출 때 읽은 저장본(예상 상태·검증 문맥 — 장부 잠금 안에서 다시 읽지 않음). */
    private record Feeds(Optional<Quotes> quotes, Optional<Snapshot> watch, Optional<Snapshot> bars) {
    }

    /**
     * 확인 결정 행과 장중 확인 행 DONE(장부 잠금 안 한 트랜잭션). 같은 d의 확인 결정이 그사이 생겼으면 그 행으로.
     *
     * <p>응답이 형식 검사를 통과하면 그때의 장부로 예상 상태({@link ExpectedState} — 기준 시각이 지난 대기 주문을 체결로 본 것, §10-6)를 셉니다.
     * KEEP은 아무것도 바꾸지 않습니다(NO_TRADE + action KEEP). REPLACE는(계좌2가 운용 중일 때) 새 주문을 확인 프로필로 검증하고(예상 상태가 검증 문맥 —
     * 지난 AT_*는 LATE_FOR_TIMING, 마감 5분 전 뒤 MARKET은 MALFORMED, 예상 매수 보유는 MIN_HOLD), 주문이 모두 거절돼도 기준 시각이 지금보다 뒤인
     * 대기 주문만 '장중 확인이 대신함'으로 취소한 뒤(⑩) 통과 주문을 대기로 넣습니다(기준 거래일 d, 만료 E). 호출하는 사이 운용 중이 아니게 됐으면
     * 적용하지 않고 SKIPPED로 남깁니다.
     */
    private long write(ClaudeDecisionPipeline pipeline, Checkpoint c, LocalDate asOf, SettingsRow row,
                       ClaudeSettings claudeSettings, Attempt attempt, Integer lag, Instant calledAt, Feeds feeds) {
        ObjectNode response;
        String status;
        String error = null;
        ClaudeDecisionPipeline replies = null;
        ClaudeDecisionPipeline.Plan plan = null;
        if (attempt.succeeded()) {
            Instant now = clock.instant();
            List<PaperStore.Order> pending = pendingOrders();
            ExpectedState.State expected = ExpectedState.of(store.state(PaperBooks.CLAUDE2).orElse(null),
                    store.positions(PaperBooks.CLAUDE2), pending, c.sessionDate(), now,
                    before(feeds.bars(), now), before(feeds.watch(), now), feeds.quotes().orElse(null), calendar);
            Book current = store.book(PaperBooks.CLAUDE2).orElse(null);
            boolean replace = "REPLACE".equals(Json.asText(attempt.parsed(), "action"));
            boolean active = current != null && PaperBooks.ACTIVE.equals(current.status());
            String notApplied = null;
            if (replace && active) {
                replies = pipeline.checkpointReplies();
                Set<String> universe = new TreeSet<>(ClaudeDecisionPipeline.observedUniverse(feeds.quotes()));
                expected.positions().forEach(p -> universe.add(p.ticker()));
                store.positions(PaperBooks.CLAUDE2).forEach(p -> universe.add(p.ticker()));
                try {
                    plan = replies.plan(asOf, RuleBookService.CHECKPOINT, false, attempt, expected.view(), row,
                            claudeSettings, feeds.quotes(), universe, Map.of(), dueDiscretionary(expected, pending, asOf));
                } catch (RuntimeException e) {
                    // 과금된 응답 — 검증할 수 없어도(예: 예상 순자산 0) 결정 행과 DONE을 남겨 다시 부르지 않음(재시도 없음).
                    notApplied = "검증할 수 없어 적용하지 않음: " + e.getMessage();
                    log.warn("장중 확인 {} REPLACE 검증 실패 — 적용하지 않음: {}", c.sessionDate(), e.toString());
                }
            }
            if (plan != null) {
                response = plan.response();
                status = plan.status();
                // ⑩ — 형식 검사를 통과했으면 주문이 모두 거절돼도 기준 시각이 지금보다 뒤인 대기 주문만 대신함.
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
            response.set("expectedState", mapper.valueToTree(expected.toMap(calendar)));
        } else {
            response = mapper.createObjectNode();
            status = attempt.status();
            error = attempt.error();
            response.put("summary", ClaudeDecisionPipeline.statusLabel(attempt.status()) + " — 장중 확인 재시도 없음(아침 주문 그대로)");
            ObjectNode failure = response.putObject("failure");
            failure.put("status", attempt.status());
            failure.put("errorKind", attempt.result().errorKind());
            failure.put("message", attempt.error());
            failure.put("charged", attempt.result().charged());
            failure.set("violations", mapper.valueToTree(attempt.violations()));
        }
        response.put("book", PaperBooks.CLAUDE2);
        response.put("kind", RuleBookService.CHECKPOINT);
        response.put("asOfTradingDate", asOf.toString());
        ObjectNode request = response.putObject("checkpoint");
        request.put("session", c.sessionDate().toString());
        request.put("atEt", CheckpointPacket.clock(c.atEt()));
        request.put("feed", c.feed());
        request.put("sourceDecisionId", c.sourceDecisionId());
        request.put("lagSeconds", lag);
        response.put("retry", false);
        response.set("framework", mapper.valueToTree(FrameworkService.decisionView(attempt.frame())));
        Decision decision = pipeline.decisionRow(0, asOf, RuleBookService.CHECKPOINT, status, row, claudeSettings, attempt,
                null, response, error, false, 0);
        Optional<Long> inserted = store.insertDecisionIfAbsent(decision);
        long id = inserted.orElseGet(() -> store.decisionFor(PaperBooks.CLAUDE2, asOf,
                RuleBookService.CHECKPOINT).map(Decision::id).orElseThrow());
        if (plan != null && inserted.isPresent()) {
            replies.insertOrders(id, asOf, plan, PaperBooks.ORDER_PENDING);
        }
        int marked = store.markCheckpoint(PaperBooks.CLAUDE2, c.sessionDate(), PaperBooks.CHECKPOINT_PLANNED,
                PaperBooks.CHECKPOINT_DONE, attempt.succeeded() ? null : attempt.status() + " — 재시도 없음", id, lag, calledAt);
        if (marked == 0) {
            log.warn("장중 확인 {} 행이 그사이 PLANNED가 아니게 됨 — 결정 {}은 남김", c.sessionDate(), id);
        }
        return id;
    }

    /**
     * 이달 재량 주문 수에 더 셀 대기 주문 수(리뷰 F2) — 예상 상태가 기준 시각이 지나 체결로 본 주문({@code assumed})과 가격을 몰라 빼 둔 주문
     * ({@code unpriced} — 장부가 곧 체결할 수 있어 보수적으로 셈) 가운데 월 수의 규칙({@link KrPacketBuilder#monthlyDiscretionaryOrders(PaperStore,
     * String, LocalDate)} — 출처 CLAUDE·기준일이 그 달이고 기준일 이하·출발 결정 INITIAL의 주문이 아님)에 드는 것. 아직 체결되지 않아 장부의 월 수에는
     * 없습니다. 기준 시각이 아직 오지 않은 대기 주문은 REPLACE가 대신하므로 세지 않습니다(⑩).
     */
    private int dueDiscretionary(ExpectedState.State expected, List<PaperStore.Order> pending, LocalDate asOf) {
        Set<Long> due = new HashSet<>(expected.unpriced());
        expected.assumed().forEach(a -> due.add(a.orderId()));
        YearMonth month = YearMonth.from(asOf);
        int count = 0;
        for (PaperStore.Order o : pending) {
            if (!due.contains(o.id()) || o.asOfTradingDate() == null || o.asOfTradingDate().isAfter(asOf)
                    || !YearMonth.from(o.asOfTradingDate()).equals(month)) {
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

    /**
     * 이미 있는 확인 결정으로 행을 DONE으로 둘 때의 사유 — 응답 뒤 쓰기 실패로 남긴 행이면 {@link #AFTER_RESPONSE}, 그 밖의 실패 응답이면
     * '상태 — 재시도 없음'({@link #write}와 같음), 성공 응답이면 null.
     */
    private static String doneReason(Decision d) {
        JsonNode failure = d.response() == null ? null : d.response().get("failure");
        if (failure == null || !failure.isObject()) {
            return null;
        }
        return "AFTER_RESPONSE".equals(Json.asText(failure, "stage")) ? AFTER_RESPONSE : d.status() + " — 재시도 없음";
    }

    /** 지금 이전에 받은 저장본의 본문(⑨ — 예상 상태는 그 뒤 자료를 쓰지 않음), 아니면 null. */
    private static JsonNode before(Optional<Snapshot> snapshot, Instant now) {
        return snapshot.filter(s -> s.collectedAt() != null && !s.collectedAt().isAfter(now)).map(Snapshot::payload)
                .orElse(null);
    }

    /** 상태만 바꿈(부르지 않음) — 바꾼 상태 문구. 그사이 PLANNED가 아니면 null. */
    private String mark(Checkpoint c, String status, String reason) {
        int marked = store.markCheckpoint(c.bookCode(), c.sessionDate(), PaperBooks.CHECKPOINT_PLANNED, status, reason, null,
                null, null);
        if (marked == 0) {
            return null;
        }
        log.info("장중 확인 {} {} — {}", c.sessionDate(), status, reason);
        return status + " " + reason;
    }
}
