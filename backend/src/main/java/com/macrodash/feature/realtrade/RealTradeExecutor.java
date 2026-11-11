package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.BrokerOrder;
import com.macrodash.collector.CollectorTradeClient.CancelResult;
import com.macrodash.collector.CollectorTradeClient.OrderResult;
import com.macrodash.collector.CollectorTradeClient.Outcome;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.NewOrder;
import com.macrodash.store.RealTradeStore.OrderRow;
import com.macrodash.store.RealTradeStore.OutcomeWrite;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.function.Supplier;

/**
 * 실제 주문 한 건의 일(ADR 0028 결정 5 — 명세 docs/specs/2026-11-06-real-trade-mirror.md §1 잠금·§4 멱등·결과·장애 복구) — SENDING 행 쓰기, 전송, 결과 기록,
 * 같은 키 재전송, 목록 대조, 상태 추적, 취소, 이상 멈춤. 부르는 곳은 정기 작업({@link RealTradeJob}) 한 스레드뿐이라 같은 시각에 두 전송이 겹치지 않습니다.
 *
 * <ul>
 *   <li><b>SENDING은 잠금 안에서</b>: 설정 행을 잡은 트랜잭션({@link RealTradeStore#lockConfig}) 안에서 '상태 LIVE·버전·따라 하는 책과 세대가 계획 때와
 *       같음(매수면 매수 멈춤이 아님)'을 확인하고 SENDING 행을 씁니다. 장중 따라 하기는 그 바깥을 모의 장부 잠금의 선점({@link PaperMirrorService#claim})으로
 *       한 겹 더 감쌉니다(잠금 순서: 모의 장부 → 설정 행 — 화면 API는 설정 행만 잡으므로 교착이 없음). 토스로 보내는 일은 두 잠금 밖입니다.</li>
 *   <li><b>결과</b>(명세 §4 표): ACCEPTED는 주문 번호를 행에(그 번호가 이미 다른 행에 있으면 이상 멈춤), REJECTED·NOT_SENT는 그 시도 종료, UNKNOWN은 같은
 *       키·저장한 바이트로만 {@value #RESEND_MINUTES}분까지 다시 보내고(재전송의 거절·안 보냄은 첫 전송의 주문 존재를 부정하지 못하므로 UNKNOWN 그대로),
 *       그 뒤 목록 대조로 후보가 정확히 하나일 때만 묶습니다 — 아니면 이상 멈춤({@code unknown-order}). 422 {@code idempotency-key-conflict}는 즉시 이상 멈춤.</li>
 *   <li><b>추적</b>: 매 주기 토스 미체결 목록 한 번 + 거기서 빠진 이 기능 주문만 하나씩. 종료 상태(FILLED·CANCELED·REJECTED·REPLACED)면 종료로 기록하고,
 *       모르는 상태 코드는 종료로 보지 않고 이상 멈춤({@code unknown-broker-status}). 미체결 목록에 없는 PARTIAL_FILLED(토스는 끝난 주문 묶음에도 이
 *       상태를 씀)는 그 주문의 세션이 지났거나 정규장 끝 + {@link #PARTIAL_END_GRACE}가 지났거나 취소 시각이 있으면 끝난 주문입니다.</li>
 *   <li><b>취소</b>: 끝난 거절({@link #FINAL_CANCEL_CODES})만 다시 보내지 않고, 지나가는 거절·안 보냄·결과 모름·받았는데 원 주문이 살아 있음은 마지막
 *       시도부터 {@link #CANCEL_RETRY_SPACING}마다 {@value #MAX_CANCEL_TRIES}번까지(횟수는 행에 — 재시작해도 이어 셈). 다 쓰고도 원 주문이 살아 있으면
 *       {@code CANCEL_GAVE_UP} 이벤트(알림, 건수만)로 사람이 앱에서 취소하게 합니다.</li>
 *   <li><b>로그</b>: 행 번호·결과·사유 코드만 — 토스 주문 번호·클라이언트 키·요청 본문·종목·수량은 남기지 않습니다.</li>
 * </ul>
 */
@Component
class RealTradeExecutor {

    private static final Logger log = LoggerFactory.getLogger(RealTradeExecutor.class);

    static final String MARKET = RealTradeStore.MARKET_KR;
    static final long RESEND_MINUTES = 7;
    /** 같은 키 재전송은 첫 전송부터 이 안에서만(수집기도 같은 창으로 거절 — 토스 멱등 10분보다 짧게). */
    static final Duration RESEND_WINDOW = Duration.ofMinutes(RESEND_MINUTES);
    /** 재전송 사이 최소 간격. */
    static final Duration RESEND_SPACING = Duration.ofSeconds(20);
    /** 한 행의 전송 횟수 상한(첫 전송 포함). */
    static final int MAX_SENDS = 12;
    /** 대조의 시각 범위 앞쪽 여유(명세 §4 — first_sent_at − 5초). */
    static final Duration RECONCILE_EARLY = Duration.ofSeconds(5);
    static final long RECONCILE_LATE_SECONDS = 30;
    /**
     * 대조의 시각 범위 뒤쪽 여유(QA-343) — 수집기는 {@code 첫 전송 + 7분} 직전에 받은 같은 키 재전송을 통과시키고, 그 POST는 토큰 발급·속도 조절을
     * 기다린 뒤(주문 한 건 예산 {@code ORDER_BUDGET_SECONDS} 20초 안) 창 끝을 넘겨 출발할 수 있습니다. 그 재전송이 처음으로 주문을 만들고 응답만
     * 잃으면 주문 시각이 창 끝 뒤라, 범위를 창 끝에서 자르면 후보 0개로 이상 멈춤이 되고 그 주문은 추적되지 않은 채 체결됩니다. 수집기 예산과 시계
     * 차이(쉬는 날 판정 5초)를 덮게 둡니다 — {@code RealTradeExecutorDbTest}의 대조 시험이 수집기 상수와 비교합니다.
     */
    static final Duration RECONCILE_LATE = Duration.ofSeconds(RECONCILE_LATE_SECONDS);
    static final long RECONCILE_GRACE_SECONDS = 45;
    /** 대조는 재전송 창이 끝나고 이만큼 더 기다린 뒤에(마지막 재전송이 목록에 오를 시간 — 뒤쪽 여유 {@link #RECONCILE_LATE}보다 길게). */
    static final Duration RECONCILE_GRACE = Duration.ofSeconds(RECONCILE_GRACE_SECONDS);
    /** 취소 재시도 간격(마지막 시도부터)과 상한(첫 취소 포함). */
    static final Duration CANCEL_RETRY_SPACING = Duration.ofSeconds(30);
    static final int MAX_CANCEL_TRIES = 5;
    /**
     * 다시 보내지 않는 취소 거절 — 원 주문이 이미 끝났거나(409 already-*) 취소할 수 없거나(cancel-restricted) 주문이 없음(404). 이 밖의 거절(429
     * rate-limited·409 already-processing·401 계열·order-hours-closed 등)은 지나가는 실패라 다시 보냅니다(RT-CONTRACT-1).
     */
    static final Set<String> FINAL_CANCEL_CODES = Set.of("already-filled", "already-canceled", "already-rejected", "already-modified",
            "cancel-restricted", "order-not-found", "http-404");
    /** 미체결 목록에 없는 오늘 PARTIAL_FILLED를 끝난 주문으로 보는 때 — 정규장 끝 + 이만큼(목록 반영이 늦는 접수 직후와 가리려고 장중에는 기다림). */
    static final Duration PARTIAL_END_GRACE = Duration.ofMinutes(5);

    static final String CODE_INTERRUPTED = "interrupted";
    static final String CODE_RECONCILED = "reconciled";
    static final String CODE_OPERATOR_RESOLVED = "operator-resolved";
    static final String CODE_IDEMPOTENCY_CONFLICT = "idempotency-key-conflict";

    static final String HALT_UNKNOWN_ORDER = "unknown-order";
    static final String HALT_IDEMPOTENCY = "idempotency-conflict";
    static final String HALT_UNKNOWN_STATUS = "unknown-broker-status";
    static final String HALT_CLOSE_AUCTION = "close-auction-mismatch";

    /** 토스 주문 상태(스펙 OrderStatus) — 종료와 살아 있음. 이 둘 밖은 모르는 상태입니다. */
    static final Set<String> TERMINAL = Set.of("FILLED", "CANCELED", "REJECTED", "REPLACED");
    static final Set<String> ALIVE = Set.of("PENDING", "PENDING_CANCEL", "PENDING_REPLACE", "PARTIAL_FILLED", "CANCEL_REJECTED",
            "REPLACE_REJECTED");

    /** 보낼 주문 하나(계획 + 시도 번호). 장중 따라 하기는 모의 주문 번호·뿌리가, 시가 맞추기·마무리는 묶음 번호가 있어야 합니다. */
    record Send(LocalDate session, String purpose, Long batchId, Long paperOrderId, Long paperRootOrderId, String symbol, String side,
                int quantity, String timeInForce, BigDecimal refPrice, int attempt) {

        @Override
        public String toString() {
            return "Send[session=" + session + ", purpose=" + purpose + ", side=" + side + ", timeInForce=" + timeInForce + ", attempt="
                    + attempt + "]";
        }
    }

    /** 보낸 결과 — 행을 쓰지 못했으면(선점·잠금 확인 실패·같은 키) {@code NOT_INSERTED}. */
    enum Result { NOT_INSERTED, ACCEPTED, REJECTED, UNKNOWN, NOT_SENT }

    record Sent(Result result, Long rowId, String code) {
    }

    private final RealTradeStore store;
    private final CollectorTradeClient client;
    private final PaperMirrorService paper;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 끄는 중(종료 훅) — 새 SENDING·재전송을 만들지 않습니다. */
    private volatile boolean closing;

    @Autowired
    RealTradeExecutor(RealTradeStore store, CollectorTradeClient client, PaperMirrorService paper, ObjectMapper mapper) {
        this(store, client, paper, mapper, Clock.systemUTC());
    }

    /** 시험용 — 시계를 정합니다. */
    RealTradeExecutor(RealTradeStore store, CollectorTradeClient client, PaperMirrorService paper, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.client = client;
        this.paper = paper;
        this.mapper = mapper;
        this.clock = clock;
    }

    /** 종료 훅 — 이 뒤로는 새 SENDING·재전송이 없습니다(진행 중인 전송은 기록까지 끝남). */
    void close() {
        closing = true;
    }

    boolean closing() {
        return closing;
    }

    // ------------------------------------------------------------------ 보내기
    /**
     * 주문 하나를 보냅니다 — 잠금 안에서 SENDING 행을 쓰고(계획 때의 설정 {@code planned}와 상태·버전·책·세대가 같을 때만), 잠금 밖에서 수집기로 보내고,
     * 결과를 씁니다. 장중 따라 하기는 모의 장부 선점 안에서 행을 씁니다(장중 교체가 먼저 취소했으면 행 없음).
     */
    Sent send(Send s, Config planned) {
        Objects.requireNonNull(planned, "planned");
        if (closing) {
            return new Sent(Result.NOT_INSERTED, null, "closing");
        }
        Instant now = clock.instant();
        Instant firstSentAt = now.truncatedTo(ChronoUnit.MILLIS);
        String key = UUID.randomUUID().toString();
        String body = CollectorTradeClient.orderBody(key, s.symbol(), s.side(), s.timeInForce(), s.quantity(), firstSentAt);
        NewOrder row = new NewOrder(MARKET, s.session(), s.purpose(), s.batchId(), planned.sourceBook(), planned.bookGeneration(),
                s.paperOrderId(), s.paperRootOrderId(), s.symbol(), s.side(), s.quantity(), s.timeInForce(), s.refPrice(), s.attempt(),
                key, body, firstSentAt);
        Supplier<Long> insert = () -> store.lockConfig(MARKET, current -> admissible(current, planned, s.side())
                ? store.insertSending(row).orElse(null) : null);
        Long id;
        if (RealTradeStore.PURPOSE_MIRROR.equals(s.purpose())) {
            id = paper.claim(planned.sourceBook(), s.paperOrderId(), now, insert).orElse(null);
        } else {
            id = insert.get();
        }
        if (id == null) {
            return new Sent(Result.NOT_INSERTED, null, "not-admitted");
        }
        store.recordSend(id, clock.instant());
        OrderResult result = client.placeOrder(body);
        return firstResult(id, result);
    }

    /** SENDING을 쓸 수 있는가(명세 §1 잠금) — 상태 LIVE, 버전·책·세대가 계획 때와 같음, 매수면 매수 멈춤이 아님, 끄는 중이 아님. */
    private boolean admissible(Config current, Config planned, String side) {
        return !closing && RealTradeStore.STATE_LIVE.equals(current.state()) && current.version() == planned.version()
                && Objects.equals(current.sourceBook(), planned.sourceBook())
                && Objects.equals(current.bookGeneration(), planned.bookGeneration())
                && !(RealTradePlanner.BUY.equals(side) && current.buysPaused());
    }

    private Sent firstResult(long id, OrderResult result) {
        String code = result.code();
        switch (result.outcome()) {
            case ACCEPTED -> {
                OutcomeWrite write = store.recordOutcome(id, RealTradeStore.OUTCOME_ACCEPTED, code, result.orderId());
                if (write == OutcomeWrite.TOSS_ID_IN_USE) {
                    halt(HALT_UNKNOWN_ORDER, Map.of("row", id, "cause", "order-id-in-use"));
                }
                log.info("실제 주문 접수 — 행 {}", id);
                return new Sent(Result.ACCEPTED, id, code);
            }
            case REJECTED -> {
                store.recordOutcome(id, RealTradeStore.OUTCOME_REJECTED, code, null);
                log.warn("실제 주문 거절 — 행 {} ({})", id, code);
                return new Sent(Result.REJECTED, id, code);
            }
            case NOT_SENT -> {
                store.recordOutcome(id, RealTradeStore.OUTCOME_NOT_SENT, code, null);
                log.warn("실제 주문 안 보냄 — 행 {} ({})", id, code);
                return new Sent(Result.NOT_SENT, id, code);
            }
            default -> {
                store.recordOutcome(id, RealTradeStore.OUTCOME_UNKNOWN, code, null);
                log.warn("실제 주문 결과 모름 — 행 {} ({}) — 같은 키로 다시 보내고 대조", id, code);
                if (CODE_IDEMPOTENCY_CONFLICT.equals(code)) {
                    halt(HALT_IDEMPOTENCY, Map.of("row", id));
                }
                return new Sent(Result.UNKNOWN, id, code);
            }
        }
    }

    // ------------------------------------------------------------------ 장애 복구
    /**
     * 남은 SENDING 행을 결과 모름(UNKNOWN, {@value #CODE_INTERRUPTED})으로 — 전송은 이 실행기 한 스레드에서만 끝까지 하므로, 주기 시작에 SENDING이면 지난
     * 실행(재시작·중단)이 보냈는지 모르는 행입니다. 그 뒤로는 같은 키 재전송·대조가 정합니다.
     */
    int markOrphans() {
        int n = 0;
        for (OrderRow row : store.unfinishedOrders(MARKET)) {
            if (RealTradeStore.OUTCOME_SENDING.equals(row.sendOutcome())
                    && store.recordOutcome(row.id(), RealTradeStore.OUTCOME_UNKNOWN, CODE_INTERRUPTED, null) == OutcomeWrite.WRITTEN) {
                n++;
            }
        }
        if (n > 0) {
            log.warn("보냈는지 모르는 실제 주문 {}건을 결과 모름으로 — 같은 키로 다시 보내고 대조", n);
        }
        return n;
    }

    /**
     * 결과 모름(UNKNOWN) 행 처리(명세 §4) — 첫 전송 + {@value #RESEND_MINUTES}분 안이면 같은 키·저장한 바이트로 다시 보내고, 그 뒤({@link #RECONCILE_GRACE}
     * 여유)에는 보내지 않고 대조합니다. 대조가 정확히 하나가 아니면 켜짐이면 이상 멈춤입니다.
     *
     * <p>재전송은 행마다 보내기 직전에 설정 행을 잡고 '지금도 켜짐이고 버전이 {@code planned}와 같음'을 확인한 뒤에만 합니다(SENDING과 같은 잠금 —
     * RT-BE-4). 그래서 주기 처음에 읽은 켜짐이 아니라 지금의 상태로 정해지고, 그사이 끄기·이상 멈춤이 커밋됐으면 보내지 않습니다. 이 루프 안에서 이상
     * 멈춤이 걸리면(대조 실패·같은 번호·멱등 충돌) 남은 행은 다시 보내지 않습니다.
     *
     * @param planned 부르는 쪽이 읽은 설정(켜짐이 아니거나 null이면 재전송 없이 대조만 — 대조 실패로 멈추지도 않음)
     * @return 대조로 정하지 못한(재전송 창이 끝난) 행 수와, 대조할 행이 있었는데 토스 목록을 읽지 못했는가
     */
    Resolution resolveUnknown(Instant now, Config planned) {
        List<OrderRow> unknown = store.unfinishedOrders(MARKET).stream()
                .filter(row -> RealTradeStore.OUTCOME_UNKNOWN.equals(row.sendOutcome())).toList();
        if (unknown.isEmpty()) {
            return new Resolution(0, false);
        }
        boolean live = planned != null && RealTradeStore.STATE_LIVE.equals(planned.state());
        Lists lists = new Lists();
        int unresolved = 0;
        boolean halted = false;
        for (OrderRow row : unknown) {
            Instant first = row.firstSentAt();
            if (now.isBefore(first.plus(RESEND_WINDOW))) {
                if (live && !halted && !closing && row.sendCount() < MAX_SENDS
                        && (row.lastSentAt() == null || !now.isBefore(row.lastSentAt().plus(RESEND_SPACING)))) {
                    halted = resend(row, planned);
                }
                continue;
            }
            if (now.isBefore(first.plus(RESEND_WINDOW).plus(RECONCILE_GRACE))) {
                continue;
            }
            Reconciled result = reconcile(row, lists, live);
            if (result != Reconciled.BOUND) {
                unresolved++;
            }
            halted |= result == Reconciled.HALTED;
        }
        return new Resolution(unresolved, lists.failed());
    }

    /**
     * 결과 모름 처리 한 번의 결과 — 대조로 정하지 못한 행 수와, 재전송 창이 끝난 행을 대조하려 했는데 토스 목록(미체결·오늘)을 읽지 못했는가. 목록을 못
     * 읽은 주기에는 끄는 중을 OFF로 넘기지 않습니다(RT3-BE-1 — 결과 모름 행마다 두 목록을 실제로 읽은 대조가 한 번은 있어야 꺼짐).
     */
    record Resolution(int unresolved, boolean listsFailed) {
    }

    /**
     * 같은 키 재전송 — 설정 행을 잡고 지금도 켜짐·같은 버전일 때만 보낸 횟수를 세고(잠금 안), 저장한 본문 바이트 그대로 보냅니다(잠금 밖). 접수면 묶고,
     * 그 밖(거절·안 보냄·모름)은 UNKNOWN 그대로(첫 전송의 결과를 모름).
     *
     * @return 이번에 이상 멈춤을 걸었으면 true(남은 행은 다시 보내지 않음)
     */
    private boolean resend(OrderRow row, Config planned) {
        Instant at = clock.instant();
        Boolean admitted = store.lockConfig(MARKET, current -> {
            if (closing || !RealTradeStore.STATE_LIVE.equals(current.state()) || current.version() != planned.version()) {
                return false;
            }
            store.recordSend(row.id(), at);
            return true;
        });
        if (!Boolean.TRUE.equals(admitted)) {
            log.info("결과 모름 실제 주문 — 행 {}: 지금은 켜짐이 아니거나 설정이 바뀌어 다시 보내지 않음(창이 끝나면 대조)", row.id());
            return false;
        }
        OrderResult result = client.placeOrder(row.requestBody());
        if (result.outcome() == Outcome.ACCEPTED) {
            OutcomeWrite write = store.recordOutcome(row.id(), RealTradeStore.OUTCOME_ACCEPTED, result.code(), result.orderId());
            log.info("실제 주문 재전송으로 접수 확인 — 행 {}", row.id());
            return write == OutcomeWrite.TOSS_ID_IN_USE && halt(HALT_UNKNOWN_ORDER, Map.of("row", row.id(), "cause", "order-id-in-use"));
        }
        log.warn("실제 주문 재전송 — 행 {}: {} ({}) — 결과 모름 그대로", row.id(), result.outcome(), result.code());
        return result.outcome() == Outcome.UNKNOWN && CODE_IDEMPOTENCY_CONFLICT.equals(result.code())
                && halt(HALT_IDEMPOTENCY, Map.of("row", row.id()));
    }

    /** 대조 한 번의 결과 — 묶음, 정하지 못함(목록을 못 읽음 등), 이상 멈춤을 걺. */
    private enum Reconciled { BOUND, UNRESOLVED, HALTED }

    /** 대조에 쓰는 토스 목록(한 주기에 한 번만 읽음). 읽지 못하면 null. */
    private final class Lists {
        private List<BrokerOrder> orders;
        private boolean tried;

        List<BrokerOrder> get() {
            if (!tried) {
                tried = true;
                Reply<List<BrokerOrder>> open = client.openOrders();
                Reply<List<BrokerOrder>> today = client.todayOrders();
                if (open.ok() && today.ok()) {
                    Map<String, BrokerOrder> byId = new LinkedHashMap<>();
                    open.value().forEach(o -> byId.put(o.orderId(), o));
                    today.value().forEach(o -> byId.putIfAbsent(o.orderId(), o));
                    orders = List.copyOf(byId.values());
                } else {
                    log.warn("대조용 토스 주문 목록을 읽지 못함 — 다음 주기에 다시 ({} / {})", open.reason(), today.reason());
                }
            }
            return orders;
        }

        /** 읽으려 했는데 읽지 못함(읽지 않았으면 false). */
        boolean failed() {
            return tried && orders == null;
        }
    }

    /**
     * 목록 대조(명세 §4) — 같은 종목·방향·수량·시장가·같은 TIF, 주문 시각 ∈ [첫 전송 − 5초, 첫 전송 + 7분 + 30초], 다른 행에 묶이지 않은 후보가 정확히 하나면 그
     * 번호로 묶습니다. 목록을 못 읽으면 다음 주기(정하지 못한 것으로 셈). 0개·둘 이상이면 켜짐일 때 이상 멈춤.
     */
    private Reconciled reconcile(OrderRow row, Lists lists, boolean live) {
        List<BrokerOrder> orders = lists.get();
        if (orders == null) {
            return Reconciled.UNRESOLVED;
        }
        Set<String> bound = store.boundTossOrderIds(MARKET);
        Instant from = row.firstSentAt().minus(RECONCILE_EARLY);
        Instant to = row.firstSentAt().plus(RESEND_WINDOW).plus(RECONCILE_LATE);
        List<BrokerOrder> candidates = new ArrayList<>();
        for (BrokerOrder o : orders) {
            if (row.symbol().equals(o.symbol()) && row.side().equals(o.side()) && "MARKET".equals(o.orderType())
                    && row.timeInForce().equals(o.timeInForce()) && o.quantity() != null
                    && o.quantity().compareTo(BigDecimal.valueOf(row.quantity())) == 0 && o.orderedAt() != null
                    && !o.orderedAt().isBefore(from) && !o.orderedAt().isAfter(to) && !bound.contains(o.orderId())) {
                candidates.add(o);
            }
        }
        if (candidates.size() == 1) {
            OutcomeWrite write = store.recordOutcome(row.id(), RealTradeStore.OUTCOME_ACCEPTED, CODE_RECONCILED,
                    candidates.getFirst().orderId());
            if (write == OutcomeWrite.WRITTEN) {
                log.info("결과 모름 실제 주문을 토스 목록과 대조해 묶음 — 행 {}", row.id());
                return Reconciled.BOUND;
            }
            if (write == OutcomeWrite.TOSS_ID_IN_USE && live && halt(HALT_UNKNOWN_ORDER, Map.of("row", row.id(), "cause", "order-id-in-use"))) {
                return Reconciled.HALTED;
            }
            return Reconciled.UNRESOLVED;
        }
        log.warn("결과 모름 실제 주문 대조 실패 — 행 {}: 후보 {}개", row.id(), candidates.size());
        if (live && halt(HALT_UNKNOWN_ORDER, Map.of("row", row.id(), "candidates", candidates.size()))) {
            return Reconciled.HALTED;
        }
        return Reconciled.UNRESOLVED;
    }

    /**
     * 사람이 확인한 뒤(켜기·멈춤 해제 — 확인 글자 + 비밀번호) 재전송 창이 끝난 결과 모름 행을 종료로 둡니다({@value #CODE_OPERATOR_RESOLVED}) — 그대로 두면
     * 그 종목이 계속 막히고 대조가 다시 멈추게 합니다. 실제로 주문이 있었다면 보유·미체결 목록에 나타나므로 다음 계산이 그것을 셉니다. 잠금 안에서 부르세요.
     */
    int resolveByOperator(Instant now) {
        int n = 0;
        for (OrderRow row : store.unfinishedOrders(MARKET)) {
            if (RealTradeStore.OUTCOME_UNKNOWN.equals(row.sendOutcome()) && !now.isBefore(row.firstSentAt().plus(RESEND_WINDOW))
                    && store.recordOutcome(row.id(), RealTradeStore.OUTCOME_REJECTED, CODE_OPERATOR_RESOLVED, null)
                    == OutcomeWrite.WRITTEN) {
                n++;
            }
        }
        return n;
    }

    // ------------------------------------------------------------------ 추적
    /**
     * 진행 중 주문 추적(명세 §4) — 토스 주문 번호가 있는 미종료 행만. 미체결 목록 한 번 + 빠진 것만 하나씩. 모르는 상태면 이상 멈춤, 종가 주문(그날 종가 단일가
     * 시작 뒤에 처음 보낸 장중 따라 하기)이 체결로 끝났는데 체결 시각이 정규장 끝 ± 2분 밖이면 이상 멈춤. 미체결 목록에 없는 PARTIAL_FILLED는
     * {@link #partialEnded}일 때 끝난 주문(잔량은 장 마감·취소로 사라짐 — RT-CONTRACT-2).
     *
     * @param day 오늘 창(종가 확인용·오늘 부분 체결이 끝났는지 — 모르면 null)
     */
    void track(Instant now, RealTradePlanner.Day day) {
        List<OrderRow> rows = store.unfinishedOrders(MARKET).stream().filter(row -> row.tossOrderId() != null).toList();
        if (rows.isEmpty()) {
            return;
        }
        Reply<List<BrokerOrder>> open = client.openOrders();
        if (!open.ok()) {
            log.warn("토스 미체결 목록을 읽지 못함 — 다음 주기에 다시 추적 ({})", open.reason());
            return;
        }
        Map<String, BrokerOrder> byId = new HashMap<>();
        open.value().forEach(o -> byId.put(o.orderId(), o));
        for (OrderRow row : rows) {
            BrokerOrder order = byId.get(row.tossOrderId());
            boolean listed = order != null;
            if (order == null) {
                Reply<BrokerOrder> one = client.order(row.tossOrderId());
                if (!one.ok()) {
                    log.warn("실제 주문 상태를 읽지 못함 — 행 {} ({})", row.id(), one.reason());
                    continue;
                }
                order = one.value();
            }
            String status = order.status();
            boolean terminal = TERMINAL.contains(status) || (!listed && partialEnded(row, order, now, day));
            if (terminal && !TERMINAL.contains(status)) {
                log.info("미체결 목록에 없는 부분 체결 — 행 {}: 끝난 주문으로 기록(잔량은 다음 계산이 셈)", row.id());
            }
            store.recordTracking(row.id(), new RealTradeStore.Tracking(status, terminal, order.filledQuantity(),
                    order.averageFilledPrice(), order.filledAmount(), order.commission(), order.tax(), order.filledAt()));
            if (!terminal && !ALIVE.contains(status)) {
                log.warn("모르는 토스 주문 상태 — 행 {} ({})", row.id(), safeCode(status));
                halt(HALT_UNKNOWN_STATUS, Map.of("row", row.id(), "status", safeCode(status)));
                continue;
            }
            if (terminal && closingOrder(row, day) && order.filledQuantity() != null && order.filledQuantity().signum() > 0
                    && !RealTradePlanner.closeFillOk(order.filledAt(), day.regularEnd())) {
                log.warn("종가 따라 하기 체결 시각이 정규장 끝 ± 2분 밖 — 행 {}", row.id());
                halt(HALT_CLOSE_AUCTION, Map.of("row", row.id()));
            }
        }
    }

    /**
     * 미체결 목록에 없는 PARTIAL_FILLED가 끝난 주문인가 — 토스는 끝난 주문 묶음에도 이 상태를 씁니다. 그 주문의 세션이 오늘(KST)보다 앞이거나, 취소 시각이
     * 있거나, 오늘 주문이고 지금이 정규장 끝 + {@link #PARTIAL_END_GRACE} 뒤이면 참. 오늘 장중이면 거짓 — 접수 직후 미체결 목록 반영이 늦을 수 있어 그 종목을
     * 일찍 풀면 같은 주문을 두 번 낼 수 있습니다.
     */
    static boolean partialEnded(OrderRow row, BrokerOrder order, Instant now, RealTradePlanner.Day day) {
        if (!"PARTIAL_FILLED".equals(order.status())) {
            return false;
        }
        if (order.canceledAt() != null || row.session().isBefore(LocalDate.ofInstant(now, Kst.ZONE))) {
            return true;
        }
        return day != null && day.date().equals(row.session()) && day.regularEnd() != null
                && !now.isBefore(day.regularEnd().plus(PARTIAL_END_GRACE));
    }

    /** 그날 종가 단일가 구간에 처음 보낸 장중 따라 하기 행인가(종가 주문은 그 구간에만 보냄 — 명세 §3 표). */
    static boolean closingOrder(OrderRow row, RealTradePlanner.Day day) {
        return day != null && day.closingAuctionStart() != null && RealTradeStore.PURPOSE_MIRROR.equals(row.purpose())
                && day.date().equals(row.session()) && !row.firstSentAt().isBefore(day.closingAuctionStart());
    }

    // ------------------------------------------------------------------ 취소
    /**
     * 이 기능의 미체결 취소(명세 §4) — 토스 주문 번호가 있고 미종료이며 {@code which}에 맞는 행. 원 주문이 취소 중(PENDING_CANCEL)이거나 앞 취소가 끝난
     * 거절({@link #FINAL_CANCEL_CODES})이면 보내지 않고(원 주문 상태는 추적이 따라감), 그 밖에는 마지막 시도부터 {@link #CANCEL_RETRY_SPACING}이 지났을 때
     * {@value #MAX_CANCEL_TRIES}번까지 보냅니다. 다 쓰고 간격이 지나도 원 주문이 살아 있으면 그 행들을 포기로 표시하고 {@code CANCEL_GAVE_UP} 이벤트
     * (알림 — 건수만) 하나를 남깁니다(행마다 한 번).
     *
     * @return 이번에 취소를 보낸 수
     */
    int cancelOpen(Instant now, Predicate<OrderRow> which) {
        int sent = 0;
        List<Long> gaveUp = new ArrayList<>();
        for (OrderRow row : store.unfinishedOrders(MARKET)) {
            if (row.tossOrderId() == null || !which.test(row) || "PENDING_CANCEL".equals(row.brokerStatus()) || finalCancel(row)
                    || (row.cancelLastAt() != null && now.isBefore(row.cancelLastAt().plus(CANCEL_RETRY_SPACING)))) {
                continue;
            }
            if (row.cancelCount() >= MAX_CANCEL_TRIES) {
                if (row.cancelGaveUpAt() == null) {
                    gaveUp.add(row.id());
                }
                continue;
            }
            CancelResult result = client.cancelOrder(row.tossOrderId());
            store.recordCancel(row.id(), clock.instant(),
                    result.outcome().name() + (result.code() == null ? "" : ":" + result.code()));
            log.info("이 기능의 실제 주문 취소 요청 — 행 {}: {} ({})", row.id(), result.outcome(), result.code());
            sent++;
        }
        int marked = store.markCancelGaveUp(gaveUp, clock.instant());
        if (marked > 0) {
            store.addEvent(MARKET, RealTradeNotices.EVENT_CANCEL_GAVE_UP, null, Map.of("count", marked), true);
            log.warn("이 기능의 실제 주문 취소를 {}번까지 보냈는데 {}건이 아직 살아 있음 — 토스증권 앱에서 직접 취소 필요", MAX_CANCEL_TRIES, marked);
        }
        return sent;
    }

    /** 앞 취소가 끝난 거절인가(원 주문이 이미 끝났거나 취소할 수 없음 — 다시 보내도 같은 거절). */
    static boolean finalCancel(OrderRow row) {
        String outcome = row.cancelOutcome();
        String prefix = Outcome.REJECTED.name() + ":";
        return outcome != null && outcome.startsWith(prefix) && FINAL_CANCEL_CODES.contains(outcome.substring(prefix.length()));
    }

    /** 토스 주문 번호가 있는 미종료 행 수(상태 응답 — 이 기능이 아직 정리하지 못한 토스 주문, 건수만). */
    int openBrokerOrders() {
        return (int) store.unfinishedOrders(MARKET).stream().filter(row -> row.tossOrderId() != null).count();
    }

    /** 취소를 상한까지 보내고 포기한 미종료 행 수(상태 응답 — 사람이 토스증권 앱에서 직접 취소할 것, 건수만 — RT2-FE-3). */
    int cancelGaveUpOrders() {
        return (int) store.unfinishedOrders(MARKET).stream().filter(row -> row.cancelGaveUpAt() != null).count();
    }

    /**
     * 끄기 정리가 끝났는가 — 미종료 행이 없거나, 남은 것이 모두 재전송 창이 끝난 결과 모름 행(토스 주문 번호를 몰라 취소할 수 없음 — 사람이 앱에서 확인)뿐.
     * 시각만 보므로, 정기 작업은 그 주기의 대조가 토스 목록을 읽었을 때만({@link Resolution#listsFailed}가 거짓) 이것으로 끄는 중을 끝냅니다(RT3-BE-1).
     */
    boolean cleanupDone(Instant now) {
        for (OrderRow row : store.unfinishedOrders(MARKET)) {
            boolean stuckUnknown = RealTradeStore.OUTCOME_UNKNOWN.equals(row.sendOutcome()) && row.tossOrderId() == null
                    && !now.isBefore(row.firstSentAt().plus(RESEND_WINDOW).plus(RECONCILE_GRACE));
            if (!stuckUnknown) {
                return false;
            }
        }
        return true;
    }

    /** 끄기 정리 뒤 남은 결과 모름 행 수(사람 확인 필요). */
    int stuckUnknown() {
        return (int) store.unfinishedOrders(MARKET).stream()
                .filter(row -> RealTradeStore.OUTCOME_UNKNOWN.equals(row.sendOutcome()) && row.tossOrderId() == null).count();
    }

    // ------------------------------------------------------------------ 이상 멈춤
    /**
     * 이상 멈춤(명세 §7.3) — 켜짐(LIVE)일 때만 HALTED로 바꾸고 사유와 HALT 이벤트(알림)를 남긴 뒤 이 기능의 미체결을 취소합니다. 이미 켜짐이 아니면 아무것도
     * 하지 않습니다(같은 사유가 이벤트를 쌓지 않게).
     *
     * @return 이번에 멈췄으면 true
     */
    boolean halt(String reason, Map<String, ?> detail) {
        Map<String, Object> full = new LinkedHashMap<>();
        full.put("reason", reason);
        if (detail != null) {
            full.putAll(detail);
        }
        Boolean halted = store.lockConfig(MARKET, current -> {
            if (!RealTradeStore.STATE_LIVE.equals(current.state())) {
                return false;
            }
            boolean updated = store.updateConfig(current.withState(RealTradeStore.STATE_HALTED)
                    .withHalt(reason, mapper.valueToTree(full)), null);
            if (updated) {
                store.addEvent(MARKET, RealTradeStore.EVENT_HALT, null, full, true);
            }
            return updated;
        });
        if (Boolean.TRUE.equals(halted)) {
            log.warn("실제 매매 이상 멈춤 — 사유 {}", reason);
            cancelOpen(clock.instant(), row -> true);
            return true;
        }
        return false;
    }

    /** 로그·이벤트에 싣는 상태 글 — 대문자·밑줄 모양만(아니면 '?'). */
    private static String safeCode(String status) {
        return status != null && status.matches("^[A-Z_]{1,40}$") ? status : "?";
    }
}
