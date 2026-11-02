package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 모의 매매 텔레그램 알림 작업(사용자 요청 2026-11-02) — 60초마다 새 체결(한 건마다 한 통)·새 결정(결정마다 요약 한 통 — 그 결정이 낸 새 주문 포함)·
 * 결정 없이 생긴 주문(스탑 매도 등 한 통)을 일어난 순서대로 보냅니다. 글은 {@link PaperNotifications}, 보내기는 {@link PaperTelegram}.
 *
 * <ul>
 *   <li><b>켜짐</b>: {@code dashboard.paper.enabled}(서버)이고 텔레그램 값이 둘 다 있을 때만 돕니다(로컬·QA는 값이 없어 돌지 않음). 설정
 *       {@code notify.telegram}(기본 켬)을 끄면 보내지 않고 읽은 자리만 앞으로 옮깁니다 — 다시 켤 때 지난 일이 몰려 오지 않게.</li>
 *   <li><b>어디까지 보냈나</b>: 작업 기록({@code paper_job_runs}, 이름 {@value #JOB})의 상세 {@code cursor}(체결 번호·결정 없는 주문 번호·결정 시각과 번호).
 *       기록이 없으면(처음 켬) 지금 자리에서 시작하고 지난 일은 보내지 않습니다. 결정은 재시도가 같은 행의 결정 시각을 새로 쓰므로 재시도 결과도 한 통 더
 *       갑니다. 셋 모두 일어난 지 {@value #SETTLE_SECONDS}초 지난 것만 봅니다(트랜잭션이 늦게 끝나는 쓰기를 건너뛰지 않게, 결정 요약이 그 체결보다 늦지 않게).</li>
 *   <li><b>실패</b>: 한 통이 실패하면 그 주기를 멈추고 거기까지만 자리를 옮깁니다 — 다음 주기에 그 통부터 다시(체결·결정에는 영향 없음). 장부 잠금·트랜잭션
 *       밖에서 보냅니다.</li>
 *   <li><b>속도</b>: 한 주기 최대 {@value #MAX_PER_CYCLE}통, 통 사이 {@value #SPACING_MS}ms(같은 대화방 초당 한 통 권장). 남은 것은 다음 주기.</li>
 * </ul>
 */
@Service
public class PaperNotifyJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 보낸 자리(cursor)를 이 기록에 남깁니다. */
    static final String JOB = "notify.telegram";
    /** 끄는 설정 키(두 책 공통 — 기본 켬). */
    static final String SETTING = "notify.telegram";
    static final boolean DEFAULT_ON = true;
    static final int MAX_PER_CYCLE = 20;
    static final long SPACING_MS = 1_100;
    static final long SETTLE_SECONDS = 60;

    private static final Logger log = LoggerFactory.getLogger(PaperNotifyJob.class);

    /** 쉬기 — 시험이 바꿔 끼웁니다. */
    @FunctionalInterface
    interface Sleeper {
        void sleep(long millis) throws InterruptedException;
    }

    /** 보낸 자리 — 체결 번호, 결정 없는 주문 번호, 결정 시각·번호. */
    record Cursor(long fillId, long orderId, Instant decidedAt, long decisionId) {
    }

    /** 한 주기의 결과 — 보낸 통 수, 실패 사유(없으면 null), 끈 설정으로 건너뛴 통 수. */
    record Outcome(int sent, String error, int muted) {
    }

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperTelegram telegram;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final Sleeper sleeper;
    private final String linkBase;
    private final ReentrantLock running = new ReentrantLock();

    @Autowired
    PaperNotifyJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperTelegram telegram,
                   PaperConfig config, ObjectMapper mapper, @Value("${dashboard.paper.telegram-link-base:}") String linkBase) {
        this(store, reader, marketData, telegram, config, mapper, Clock.systemUTC(), Thread::sleep, linkBase);
    }

    /** 테스트용 — 시계·쉬기를 바꿔 끼웁니다. */
    PaperNotifyJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperTelegram telegram,
                   PaperConfig config, ObjectMapper mapper, Clock clock, Sleeper sleeper, String linkBase) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.telegram = telegram;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.sleeper = sleeper;
        this.linkBase = linkBase;
    }

    /** 정기 실행 — 서버(정기 작업 켜짐)이고 텔레그램 값이 있을 때만. 예외는 로그로만. */
    @Scheduled(initialDelayString = "${dashboard.paper.notify-initial-delay-ms:200000}",
            fixedDelayString = "${dashboard.paper.notify-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled() || !telegram.configured()) {
            return;
        }
        try {
            Outcome outcome = run();
            if (outcome != null && outcome.error() != null) {
                log.warn("텔레그램 알림 실패 — 다음 주기에 그 통부터 다시: {}", outcome.error());
            }
        } catch (RuntimeException e) {
            log.warn("텔레그램 알림 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 설정 {@value #SETTING}이 켜져 있나(키가 없거나 불리언이 아니면 기본 켬). */
    static boolean on(JsonNode body) {
        JsonNode value = body == null ? null : PaperSettingsService.valueAt(body, SETTING);
        return value != null && value.isBoolean() ? value.booleanValue() : DEFAULT_ON;
    }

    /** 한 주기 — 테스트가 부릅니다. 앞 주기가 도는 중이면 null. */
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

    /** 보낼 일 하나 — 일어난 시각(순서)과 글을 만드는 법, 보낸 뒤 옮길 자리. */
    private record Event(Instant at, int rank, long id, Kind kind, Fill fill, Decision decision, Order order) {
    }

    private enum Kind { DECISION, ORDER, FILL }

    private Outcome cycle() {
        if (!store.ready()) {
            return new Outcome(0, null, 0);
        }
        Instant started = clock.instant();
        Cursor cursor = loadCursor().orElse(null);
        if (cursor == null) {
            // 처음 켬 — 지금 자리에서 시작(지난 체결·결정을 한꺼번에 보내지 않음).
            Cursor fresh = new Cursor(store.maxFillId(), store.maxOrderId(), started, Long.MAX_VALUE);
            record(started, "OK", fresh, 0, 0, null, "처음 켬 — 지금 자리에서 시작");
            return new Outcome(0, null, 0);
        }
        // 셋 모두 일어난 지 SETTLE이 지난 것만(트랜잭션이 늦게 끝나는 쓰기를 건너뛰지 않게, 결정 요약이 그 출발 체결보다 늦게 가지 않게). 체결·주문은 번호
        // 순이라 그 시각에 닿으면 거기서 멈춥니다(뒤 번호를 먼저 보내 자리가 앞서 가지 않게).
        Instant settled = started.minusSeconds(SETTLE_SECONDS);
        List<Event> events = new ArrayList<>();
        for (Decision d : store.decisionsAfter(cursor.decidedAt(), cursor.decisionId(), settled, MAX_PER_CYCLE)) {
            events.add(new Event(d.decidedAt(), 0, d.id(), Kind.DECISION, null, d, null));
        }
        for (Order o : store.ordersWithoutDecisionAfter(cursor.orderId(), MAX_PER_CYCLE)) {
            if (o.createdAt() != null && !o.createdAt().isBefore(settled)) {
                break;
            }
            events.add(new Event(o.createdAt(), 1, o.id(), Kind.ORDER, null, null, o));
        }
        for (Fill f : store.fillsAfter(cursor.fillId(), MAX_PER_CYCLE)) {
            if (f.createdAt() != null && !f.createdAt().isBefore(settled)) {
                break;
            }
            events.add(new Event(f.createdAt(), 2, f.id(), Kind.FILL, f, null, null));
        }
        if (events.isEmpty()) {
            return new Outcome(0, null, 0);
        }
        events.sort(Comparator.comparing((Event e) -> e.at() == null ? Instant.EPOCH : e.at()).thenComparingInt(Event::rank)
                .thenComparingLong(Event::id));
        SettingsRow row = store.settings().orElse(null);
        boolean on = on(row == null ? null : row.body());
        Map<String, Optional<Book>> books = new HashMap<>();
        Map<String, String> names = null;
        Cursor at = cursor;
        int sent = 0;
        int muted = 0;
        String error = null;
        for (Event e : events.subList(0, Math.min(events.size(), MAX_PER_CYCLE))) {
            String code = e.kind() == Kind.FILL ? e.fill().bookCode() : e.kind() == Kind.ORDER ? e.order().bookCode()
                    : e.decision().bookCode();
            Book book = books.computeIfAbsent(code, store::book).orElse(null);
            if (on) {
                if (names == null && book != null && Book.MARKET_KR.equals(book.market())) {
                    Map<String, String> read = reader.quietly(marketData::krNames);
                    names = read == null ? Map.of() : read;
                }
                String text = switch (e.kind()) {
                    case FILL -> PaperNotifications.fill(e.fill(), book, store.order(e.fill().orderId()).orElse(null), names,
                            linkBase);
                    case ORDER -> PaperNotifications.order(e.order(), book, names, linkBase);
                    case DECISION -> PaperNotifications.decision(e.decision(), book, store.ordersByDecision(e.decision().id()), names,
                            linkBase);
                };
                if (sent > 0) {
                    try {
                        sleeper.sleep(SPACING_MS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        error = "쉬는 중 끊김";
                        break;
                    }
                }
                error = telegram.send(text);
                if (error != null) {
                    break;
                }
                sent++;
            } else {
                muted++;
            }
            at = switch (e.kind()) {
                case FILL -> new Cursor(e.id(), at.orderId(), at.decidedAt(), at.decisionId());
                case ORDER -> new Cursor(at.fillId(), e.id(), at.decidedAt(), at.decisionId());
                case DECISION -> new Cursor(at.fillId(), at.orderId(), e.at(), e.id());
            };
        }
        record(started, error == null ? "OK" : "ERROR", at, sent, muted, error, null);
        if (sent > 0 || muted > 0) {
            log.info("텔레그램 알림 {}통{}{}", sent, muted > 0 ? " · 설정이 꺼져 건너뜀 " + muted : "", error == null ? "" : " · 실패: " + error);
        }
        return new Outcome(sent, error, muted);
    }

    /** 가장 최근 기록의 보낸 자리(없거나 읽을 수 없으면 empty). */
    private Optional<Cursor> loadCursor() {
        for (JobRun run : store.recentJobRuns(JOB, 5)) {
            if (!JOB.equals(run.job())) {
                continue;
            }
            JsonNode c = run.detail() == null ? null : run.detail().get("cursor");
            if (c != null && c.isObject() && c.path("fillId").isNumber() && c.path("orderId").isNumber()
                    && c.path("decisionId").isNumber() && Json.asText(c, "decidedAt") != null) {
                try {
                    return Optional.of(new Cursor(c.path("fillId").asLong(), c.path("orderId").asLong(),
                            Instant.parse(Json.asText(c, "decidedAt")), c.path("decisionId").asLong()));
                } catch (RuntimeException e) {
                    return Optional.empty();
                }
            }
        }
        return Optional.empty();
    }

    private void record(Instant started, String outcome, Cursor cursor, int sent, int muted, String error, String note) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("fillId", cursor.fillId());
        c.put("orderId", cursor.orderId());
        c.put("decidedAt", cursor.decidedAt().toString());
        c.put("decisionId", cursor.decisionId());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("cursor", c);
        detail.put("sent", sent);
        detail.put("muted", muted);
        detail.put("error", error);
        if (note != null) {
            detail.put("note", note);
        }
        try {
            store.recordJobRun(JOB, started, clock.instant(), outcome, mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            log.warn("텔레그램 알림 작업 기록 실패(보낸 자리를 남기지 못함 — 다음 주기에 같은 통이 다시 갈 수 있음): {}", e.toString());
        }
    }
}
