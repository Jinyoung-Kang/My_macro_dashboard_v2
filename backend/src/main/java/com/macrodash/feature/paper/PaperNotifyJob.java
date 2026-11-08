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
import java.util.function.Function;
import java.util.function.ToLongFunction;

/**
 * 모의 매매 텔레그램 알림 작업(사용자 요청 2026-11-02) — 60초마다 새 결정(결정마다 요약 한 통 — 그 결정이 낸 새 주문 포함)·새 체결·결정 없이 생긴
 * 주문(스탑 매도 등)을 일어난 순서대로 보냅니다. 글은 {@link PaperNotifications}, 보내기는 {@link PaperTelegram}.
 *
 * <ul>
 *   <li><b>묶음</b>(사용자 요청 2026-11-07 — 체결마다 한 통이 헷갈림): 체결과 결정 없는 주문은 한 계좌가 한 트랜잭션에서 쓴 행을 한 통으로 묶습니다.
 *       묶음 = 번호 순으로 이어진 행 가운데 책이 같고 만든 시각({@code created_at} — 체결은 늘 DB {@code now()}, 즉 트랜잭션 시작 시각이라 한 장부 처리의
 *       체결이 같은 값, 결정 없는 주문은 한 처리가 같은 감지 시각을 넣음)이 묶음 첫 행과 {@value #BATCH_TOLERANCE_SECONDS}초 안인 것. 한국은 보통 밤마다
 *       계좌당 한 통, 미국은 관측치 처리마다 계좌당 한 통입니다. 결정은 그대로 결정마다 한 통.</li>
 *   <li><b>켜짐</b>: {@code dashboard.paper.enabled}(서버)이고 텔레그램 값이 둘 다 있을 때만 돕니다(로컬·QA는 값이 없어 돌지 않음). 설정
 *       {@code notify.telegram}(기본 켬)을 끄면 보내지 않고 읽은 자리만 앞으로 옮깁니다 — 다시 켤 때 지난 일이 몰려 오지 않게.</li>
 *   <li><b>시장별 봇</b>(사용자 요청 2026-11-08): 미국 계좌 알림은 미국 봇, 한국 계좌 알림은 한국 봇으로 보내고({@link PaperTelegram.Channel}) 보낸 자리도 시장마다
 *       따로 둡니다 — 한 봇이 실패해도 다른 시장 알림은 계속 나갑니다.</li>
 *   <li><b>어디까지 보냈나</b>: 작업 기록({@code paper_job_runs}, 이름 {@value #JOB})의 상세 {@code cursors}(시장별 체결 번호·결정 없는 주문 번호·결정 시각과 번호 —
 *       그 전 기록의 {@code cursor} 하나는 두 시장이 함께 이어받습니다).
 *       자리는 묶음 단위로만 옮깁니다(묶음의 마지막 번호 — 묶음의 일부만 보내지 않음). 기록이 없으면(처음 켬) 지금 자리에서 시작하고 지난 일은 보내지
 *       않습니다. 결정은 재시도가 같은 행의 결정 시각을 새로 쓰므로 재시도 결과도 한 통 더 갑니다. 셋 모두 일어난 지 {@value #SETTLE_SECONDS}초 지난 것만
 *       봅니다(트랜잭션이 늦게 끝나는 쓰기를 건너뛰지 않게, 결정 요약이 그 체결보다 늦지 않게 — 한 트랜잭션의 행은 함께 보이므로 지난 묶음은 다 찬 묶음).
 *       체결·주문은 {@value #FETCH_LIMIT}행까지 읽고, 끝 묶음이 그 너머로 이어질 수 있으면(읽은 행이 꽉 참) 다음 주기로 미룹니다 — 묶음 하나가 그보다
 *       크면 거기서 나눠 보냅니다.</li>
 *   <li><b>실패</b>: 한 통이 실패하면 그 주기에 그 시장 알림을 멈추고 그 묶음 앞까지만 자리를 옮깁니다 — 다음 주기에 그 묶음부터 다시(체결·결정에는 영향 없음). 장부
 *       잠금·트랜잭션 밖에서 보냅니다.</li>
 *   <li><b>속도</b>: 한 주기 시장마다 최대 {@value #MAX_PER_CYCLE}통(묶음·결정 수 — 긴 묶음을 보내는 쪽이 나눈 조각은 한 통으로 셈), 통 사이 {@value #SPACING_MS}ms
 *       (같은 대화방 초당 한 통 권장). 남은 것은 다음 주기.</li>
 * </ul>
 */
@Service
public class PaperNotifyJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 보낸 자리(cursor)를 이 기록에 남깁니다. */
    static final String JOB = "notify.telegram";
    /** 끄는 설정 키(두 책 공통 — 기본 켬). */
    static final String SETTING = "notify.telegram";
    static final boolean DEFAULT_ON = true;
    /** 보낸 자리를 따로 두는 시장. */
    private static final List<String> MARKETS = List.of(Book.MARKET_US, Book.MARKET_KR);
    /** 한 주기에 시장마다 보내는 통 수 상한(결정·묶음 수). */
    static final int MAX_PER_CYCLE = 20;
    /** 한 주기에 읽는 체결·결정 없는 주문 행 수 — 묶음을 다 채워 읽게 통 수 상한보다 넉넉히. */
    static final int FETCH_LIMIT = 500;
    /** 한 묶음으로 보는 만든 시각의 차(묶음 첫 행 기준, 초) — 한 트랜잭션의 행은 같은 값이고, 시각을 넣는 길의 작은 어긋남만 받습니다. */
    static final long BATCH_TOLERANCE_SECONDS = 2;
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

    /** 보낼 일 하나 — 일어난 시각(순서)과 글을 만드는 법, 보낸 뒤 옮길 자리({@code id} — 결정 번호, 묶음은 마지막 행 번호). */
    private record Event(String market, Instant at, int rank, long id, Kind kind, String bookCode, Decision decision, List<Order> orders,
                         List<Fill> fills) {
    }

    private enum Kind { DECISION, ORDER, FILL }

    /** 한 묶음 — 같은 책·같은 트랜잭션의 이어진 행(번호 순). */
    record Batch<T>(String bookCode, Instant at, List<T> rows, long lastId) {
    }

    /**
     * 번호 순 행을 묶음으로 — 다 찬 묶음만 돌려줍니다. 일어난 지 {@code settled}가 안 된 첫 행에서 멈추고(뒤 번호를 먼저 보내 자리가 앞서 가지 않게),
     * 그 행이 끝 묶음에 들어갈 행이거나 읽은 행이 {@code limit}로 꽉 차 끝 묶음이 더 이어질 수 있으면 끝 묶음을 다음 주기로 미룹니다(꽉 찬 읽기가 묶음
     * 하나뿐이면 그대로 — 멈춰 서지 않게).
     */
    static <T> List<Batch<T>> batches(List<T> rows, int limit, Instant settled, Function<T, String> bookOf, Function<T, Instant> atOf,
                                      ToLongFunction<T> idOf) {
        List<Batch<T>> out = new ArrayList<>();
        List<T> current = null;
        T cut = null;
        for (T row : rows) {
            Instant at = atOf.apply(row);
            if (at != null && !at.isBefore(settled)) {
                cut = row;
                break;
            }
            if (current == null || !sameBatch(current.get(0), row, bookOf, atOf)) {
                if (current != null) {
                    out.add(batch(current, bookOf, atOf, idOf));
                }
                current = new ArrayList<>();
            }
            current.add(row);
        }
        if (current == null) {
            return out;
        }
        boolean more = cut != null ? sameBatch(current.get(0), cut, bookOf, atOf) : rows.size() >= limit && !out.isEmpty();
        if (!more) {
            out.add(batch(current, bookOf, atOf, idOf));
        }
        return out;
    }

    private static <T> boolean sameBatch(T first, T row, Function<T, String> bookOf, Function<T, Instant> atOf) {
        Instant a = atOf.apply(first);
        Instant b = atOf.apply(row);
        return a != null && b != null && java.util.Objects.equals(bookOf.apply(first), bookOf.apply(row))
                && Duration.between(a, b).abs().compareTo(Duration.ofSeconds(BATCH_TOLERANCE_SECONDS)) <= 0;
    }

    private static <T> Batch<T> batch(List<T> rows, Function<T, String> bookOf, Function<T, Instant> atOf, ToLongFunction<T> idOf) {
        return new Batch<>(bookOf.apply(rows.get(0)), atOf.apply(rows.get(0)), List.copyOf(rows), idOf.applyAsLong(rows.get(rows.size() - 1)));
    }

    private Outcome cycle() {
        if (!store.ready()) {
            return new Outcome(0, null, 0);
        }
        Instant started = clock.instant();
        Map<String, Cursor> cursors = loadCursors().orElse(null);
        if (cursors == null) {
            // 처음 켬 — 지금 자리에서 시작(지난 체결·결정을 한꺼번에 보내지 않음).
            Cursor fresh = new Cursor(store.maxFillId(), store.maxOrderId(), started, Long.MAX_VALUE);
            record(started, "OK", bothMarkets(fresh), 0, 0, null, "처음 켬 — 지금 자리에서 시작");
            return new Outcome(0, null, 0);
        }
        // 셋 모두 일어난 지 SETTLE이 지난 것만(트랜잭션이 늦게 끝나는 쓰기를 건너뛰지 않게, 결정 요약이 그 출발 체결보다 늦게 가지 않게). 체결·주문은
        // 번호 순이라 그 시각에 닿으면 거기서 멈추고(뒤 번호를 먼저 보내 자리가 앞서 가지 않게), 계좌·트랜잭션 묶음으로 한 통씩.
        Instant settled = started.minusSeconds(SETTLE_SECONDS);
        List<List<Event>> markets = new ArrayList<>();
        for (String market : MARKETS) {
            markets.add(eventsOf(market, cursors.get(market), settled));
        }
        List<Event> events = merge(markets, MAX_PER_CYCLE * MARKETS.size());
        if (events.isEmpty()) {
            return new Outcome(0, null, 0);
        }
        SettingsRow row = store.settings().orElse(null);
        boolean on = on(row == null ? null : row.body());
        Map<String, Optional<Book>> books = new HashMap<>();
        Map<String, String> names = null;
        Map<String, Cursor> at = new LinkedHashMap<>(cursors);
        Map<String, String> failures = new LinkedHashMap<>();
        int sent = 0;
        int muted = 0;
        for (Event e : events) {
            if (failures.containsKey(e.market())) {
                continue;
            }
            Book book = books.computeIfAbsent(e.bookCode(), store::book).orElse(null);
            if (on) {
                if (names == null && book != null && Book.MARKET_KR.equals(book.market())) {
                    Map<String, String> read = reader.quietly(marketData::krNames);
                    names = read == null ? Map.of() : read;
                }
                String text = switch (e.kind()) {
                    case FILL -> PaperNotifications.fills(e.fills(), book, ordersOf(e.fills()), names, linkBase);
                    case ORDER -> PaperNotifications.orders(e.orders(), book, names, linkBase);
                    case DECISION -> PaperNotifications.decision(e.decision(), book, store.ordersByDecision(e.decision().id()), names,
                            linkBase);
                };
                if (sent > 0) {
                    try {
                        sleeper.sleep(SPACING_MS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        failures.put(e.market(), "쉬는 중 끊김");
                        break;
                    }
                }
                String failure = telegram.send(channelOf(e.market()), text);
                if (failure != null) {
                    failures.put(e.market(), failure);
                    continue;
                }
                sent++;
            } else {
                muted++;
            }
            Cursor before = at.get(e.market());
            at.put(e.market(), switch (e.kind()) {
                case FILL -> new Cursor(e.id(), before.orderId(), before.decidedAt(), before.decisionId());
                case ORDER -> new Cursor(before.fillId(), e.id(), before.decidedAt(), before.decisionId());
                case DECISION -> new Cursor(before.fillId(), before.orderId(), e.at(), e.id());
            });
        }
        String error = failures.isEmpty() ? null : failures.entrySet().stream().map(f -> f.getKey() + ": " + f.getValue())
                .collect(java.util.stream.Collectors.joining(" · "));
        record(started, error == null ? "OK" : "ERROR", at, sent, muted, error, null);
        if (sent > 0 || muted > 0) {
            log.info("텔레그램 알림 {}통{}{}", sent, muted > 0 ? " · 설정이 꺼져 건너뜀 " + muted : "", error == null ? "" : " · 실패: " + error);
        }
        return new Outcome(sent, error, muted);
    }

    /** 한 시장의 보낼 일 — 결정·결정 없는 주문·체결 묶음을 일어난 순서로 {@value #MAX_PER_CYCLE}개까지. */
    private List<Event> eventsOf(String market, Cursor cursor, Instant settled) {
        List<Event> decisions = new ArrayList<>();
        for (Decision d : store.decisionsAfter(market, cursor.decidedAt(), cursor.decisionId(), settled, MAX_PER_CYCLE)) {
            decisions.add(new Event(market, d.decidedAt(), 0, d.id(), Kind.DECISION, d.bookCode(), d, null, null));
        }
        List<Event> orders = new ArrayList<>();
        for (Batch<Order> b : batches(store.ordersWithoutDecisionAfter(market, cursor.orderId(), FETCH_LIMIT), FETCH_LIMIT, settled,
                Order::bookCode, Order::createdAt, Order::id)) {
            orders.add(new Event(market, b.at(), 1, b.lastId(), Kind.ORDER, b.bookCode(), null, b.rows(), null));
        }
        List<Event> fills = new ArrayList<>();
        for (Batch<Fill> b : batches(store.fillsAfter(market, cursor.fillId(), FETCH_LIMIT), FETCH_LIMIT, settled, Fill::bookCode,
                Fill::createdAt, Fill::id)) {
            fills.add(new Event(market, b.at(), 2, b.lastId(), Kind.FILL, b.bookCode(), null, null, b.rows()));
        }
        return merge(List.of(decisions, orders, fills), MAX_PER_CYCLE);
    }

    private static PaperTelegram.Channel channelOf(String market) {
        return Book.MARKET_KR.equals(market) ? PaperTelegram.Channel.KR : PaperTelegram.Channel.US;
    }

    private static Map<String, Cursor> bothMarkets(Cursor cursor) {
        Map<String, Cursor> out = new LinkedHashMap<>();
        MARKETS.forEach(market -> out.put(market, cursor));
        return out;
    }

    /**
     * 종류별 줄(결정 — 결정 시각·번호 순, 묶음 — 번호 순)을 일어난 시각 순으로 섞습니다 — 매번 머리들 가운데 가장 이른 것(같은 시각이면 결정 → 주문 → 체결)을
     * 꺼내, 한 종류 안의 순서는 그대로입니다(자리가 뒤로 가거나 앞 묶음을 건너뛰지 않게). {@code max}개까지.
     */
    private static List<Event> merge(List<List<Event>> lanes, int max) {
        Comparator<Event> order = Comparator.comparing((Event e) -> e.at() == null ? Instant.EPOCH : e.at()).thenComparingInt(Event::rank)
                .thenComparingLong(Event::id);
        int[] heads = new int[lanes.size()];
        List<Event> out = new ArrayList<>();
        while (out.size() < max) {
            int pick = -1;
            for (int i = 0; i < lanes.size(); i++) {
                if (heads[i] < lanes.get(i).size()
                        && (pick < 0 || order.compare(lanes.get(i).get(heads[i]), lanes.get(pick).get(heads[pick])) < 0)) {
                    pick = i;
                }
            }
            if (pick < 0) {
                break;
            }
            out.add(lanes.get(pick).get(heads[pick]++));
        }
        return out;
    }

    /** 묶음 체결의 주문(시점·출처를 적으려고) — 주문 번호 → 주문, 없는 주문은 빠짐. */
    private Map<Long, Order> ordersOf(List<Fill> fills) {
        Map<Long, Order> out = new HashMap<>();
        for (Fill f : fills) {
            store.order(f.orderId()).ifPresent(o -> out.put(o.id(), o));
        }
        return out;
    }

    /** 가장 최근 기록의 시장별 보낸 자리(없거나 읽을 수 없으면 empty) — 시장을 나누기 전 기록의 자리 하나는 두 시장이 함께 이어받습니다. */
    private Optional<Map<String, Cursor>> loadCursors() {
        for (JobRun run : store.recentJobRuns(JOB, 5)) {
            if (!JOB.equals(run.job()) || run.detail() == null) {
                continue;
            }
            Map<String, Cursor> split = new LinkedHashMap<>();
            for (String market : MARKETS) {
                Cursor cursor = cursorOf(run.detail().path("cursors").get(market));
                if (cursor != null) {
                    split.put(market, cursor);
                }
            }
            if (split.size() == MARKETS.size()) {
                return Optional.of(split);
            }
            Cursor shared = cursorOf(run.detail().get("cursor"));
            if (shared != null) {
                return Optional.of(bothMarkets(shared));
            }
        }
        return Optional.empty();
    }

    /** 기록의 자리 한 칸 — 없거나 읽을 수 없으면 null. */
    private static Cursor cursorOf(JsonNode c) {
        if (c == null || !c.isObject() || !c.path("fillId").isNumber() || !c.path("orderId").isNumber()
                || !c.path("decisionId").isNumber() || Json.asText(c, "decidedAt") == null) {
            return null;
        }
        try {
            return new Cursor(c.path("fillId").asLong(), c.path("orderId").asLong(), Instant.parse(Json.asText(c, "decidedAt")),
                    c.path("decisionId").asLong());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private void record(Instant started, String outcome, Map<String, Cursor> cursors, int sent, int muted, String error, String note) {
        Map<String, Object> byMarket = new LinkedHashMap<>();
        cursors.forEach((market, cursor) -> {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("fillId", cursor.fillId());
            c.put("orderId", cursor.orderId());
            c.put("decidedAt", cursor.decidedAt().toString());
            c.put("decisionId", cursor.decisionId());
            byMarket.put(market, c);
        });
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("cursors", byMarket);
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
