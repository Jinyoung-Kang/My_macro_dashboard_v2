package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.store.Snapshot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 🧪 실행 감사 정기 작업(미국 Claude 계좌2 실험 단계 0 — 명세 docs/specs/2026-10-30-claude-book2-timing-design.md §14-1, ADR 0022) — 5분마다
 * 미국 Claude 계좌의 결정 주문마다 "계좌1식·시가·매시·종가로 체결했다면의 원가격"(반사실)과 1분봉 지연을 {@code paper_order_exec}에 적습니다.
 * 판정은 {@link ExecutionAudit}이고, 이 작업은 저장본을 읽어 넘기고 결과를 합쳐 쓰기만 합니다.
 *
 * <p><b>측정만 합니다.</b> 장부 잠금을 잡지 않고({@code PaperLedgerService}를 모름), 장부 표(주문·체결)는 읽기만 하며 쓰는 표는 실행 감사 표와
 * 작업 기록뿐입니다 — 계좌1의 결정·패킷·체결·스탑은 그대로입니다. 쓰기는 한 실행에 한 트랜잭션({@link PaperStore#atomically})입니다.
 *
 * <p><b>대상</b>: 미국 Claude 계좌({@link ExecutionAudit#auditedBooks} — 계좌1·계좌2)의 결정 주문 가운데 목표 세션 E(기준 거래일 다음 거래일)가
 * 오늘(뉴욕 날짜)에서 {@value #WINDOW_DAYS}일 안쪽이거나 뒤인 것 — 수집기 1분봉 범위('최근 8일 주문', 세션 최근 3)와 같은 폭입니다. 그보다
 * 오래된 주문은 다시 보지 않습니다(저장본은 최신 한 건만 남아 놓친 값은 null로 남음 — §14-1).
 *
 * <p><b>한 번 쓴 값은 고치지 않습니다.</b> 시점마다 값을 처음 구한 저장본의 값이 남고(저장 쪽 {@link PaperStore#mergeOrderExec}), 못 구한 시점은
 * null로 두었다가 다음 저장본에서 다시 봅니다. 지연({@code lag_seconds})은 그 주문의 1분봉 반사실을 처음 적은 저장본의 지연(달력으로 다시 셈 —
 * 정규장 밖이면 null)이고 그때 null이었으면 뒤 저장본의 지연으로 메우지 않습니다. 늦게 풂({@code late_resolved})은 시각 지정 체결(장부 2b·3a가 사다리
 * 칸을 남긴 체결)이 생기면 그 체결 행으로 한 번 셉니다({@link ExecutionAudit#lateResolved} — 대체 칸이거나 장부 반영이 T + 65분 뒤). 그 밖의 주문은
 * null입니다.
 *
 * <p>저장본(1분봉·관측치)은 {@link StoreReader#quietly}로만 읽습니다 — 정기 작업이 수집기를 깨우지 않게(ADR 0008). 작업 기록
 * ({@code paper_job_runs}, 이름 {@value #JOB})은 무엇이든 새로 썼을 때와 오류일 때만 남깁니다(5분마다 쌓이면 다른 작업 기록을 밀어냄) — 실행 시간은
 * 그 기록의 시작·끝 시각으로 잽니다(명세 §14-1 — 길면 리스크 점검 뒤에 붙이는 판으로). 예외는 삼키고 로그만 남깁니다(스케줄러로 던지지 않음).
 *
 * <p>{@code dashboard.paper.enabled=false}(로컬 v2 — {@code PAPER_ENABLED=false})면 아무것도 읽거나 쓰지 않습니다. 수동 실행 경로는 없습니다.
 */
@Service
public class PaperExecutionAuditJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 미국 작업이라 시장 접두어가 없습니다. */
    static final String JOB = "exec-audit";
    /** 감사하는 목표 세션의 폭 — 오늘(뉴욕 날짜) − 이 일수 이후의 세션(수집기 {@code TIMED_RECENT_DAYS}와 같은 값). */
    static final int WINDOW_DAYS = 8;
    /** 기준 거래일을 DB에서 고를 때 더 보는 여유(기준 거래일 → 다음 거래일은 연휴에도 이 안). */
    private static final int AS_OF_SLACK_DAYS = 7;

    private static final Logger log = LoggerFactory.getLogger(PaperExecutionAuditJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    PaperExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperConfig config,
                           ObjectMapper mapper) {
        this(store, reader, marketData, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperConfig config,
                           ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 한 실행의 결과.
     *
     * @param orders        본 주문 수(대상 계좌 모두)
     * @param rowsWritten   새로 넣었거나 채운 감사 행 수
     * @param valuesFilled  새로 채운 반사실 시점 수
     * @param skippedReason 돌지 않은 사유(테이블 없음) — 돌았으면 null
     * @param error         실패 사유 — 없으면 null
     */
    record Outcome(int orders, int rowsWritten, int valuesFilled, String skippedReason, String error) {

        static Outcome skipped(String reason) {
            return new Outcome(0, 0, 0, reason, null);
        }
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.exec-audit-initial-delay-ms:150000}",
            fixedDelayString = "${dashboard.paper.exec-audit-interval-ms:300000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            Outcome outcome = run();
            if (outcome.error() != null) {
                log.warn("모의 매매 실행 감사 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            } else if (outcome.rowsWritten() > 0) {
                log.info("모의 매매 실행 감사: 주문 {} · 행 {} · 반사실 {}", outcome.orders(), outcome.rowsWritten(),
                        outcome.valuesFilled());
            }
        } catch (RuntimeException e) {
            log.warn("모의 매매 실행 감사 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 번 실행 — 테스트가 부릅니다(정기 실행과 같은 일, 꺼짐 확인만 없음). */
    Outcome run() {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다(V17 적용 전) — make up 후 다시 보세요");
        }
        Instant started = clock.instant();
        TradingCalendar calendar = UsPaperMarket.INSTANCE.calendar();   // 미국 시장 묶음의 달력(뉴욕 세션 날짜)
        Snapshot bars = null;
        Quotes quotes = null;
        Outcome outcome;
        try {
            // 수집 태스크 이름을 넘기지 않고(null) quietly 안에서 읽습니다 — 오래된 저장본이어도 수집을 요청하지 않음.
            bars = reader.quietly(() -> reader.read(Datasets.SNAP_PAPER_BARS_US, Datasets.MAX_AGE_BARS_US, null))
                    .orElse(null);
            quotes = reader.quietly(() -> marketData.quotes(UsPaperMarket.INSTANCE)).orElse(null);
            JsonNode payload = bars == null ? null : bars.payload();
            Quotes observed = quotes;
            outcome = store.atomically(() -> audit(started, payload, observed, calendar));
        } catch (RuntimeException e) {
            outcome = new Outcome(0, 0, 0, null, e.getClass().getSimpleName() + " " + e.getMessage());
        }
        if (outcome.rowsWritten() > 0 || outcome.error() != null) {
            record(started, outcome, bars, quotes, calendar);
        }
        return outcome;
    }

    /** 대상 계좌마다 주문을 보고 감사 행을 합칩니다(한 트랜잭션 안). */
    private Outcome audit(Instant now, JsonNode barsPayload, Quotes quotes, TradingCalendar calendar) {
        LocalDate today = now.atZone(calendar.zone()).toLocalDate();
        LocalDate fromSession = today.minusDays(WINDOW_DAYS);
        Integer lag = ExecutionAudit.lagSeconds(barsPayload, calendar);
        int orders = 0;
        int rows = 0;
        int values = 0;
        for (String code : ExecutionAudit.auditedBooks()) {
            if (store.book(code).isEmpty()) {
                continue;
            }
            List<Order> audited = new ArrayList<>();
            for (Order order : store.executionOrders(code, fromSession.minusDays(AS_OF_SLACK_DAYS))) {
                LocalDate session = ExecutionAudit.targetSession(order, calendar);
                if (session != null && !session.isBefore(fromSession)) {
                    audited.add(order);
                }
            }
            if (audited.isEmpty()) {
                continue;
            }
            Map<Long, ExecFill> fills = new HashMap<>();
            for (ExecFill f : store.fillsForOrders(audited.stream().map(Order::id).toList())) {
                fills.put(f.fill().orderId(), f);
            }
            Map<Long, OrderExec> existing = new HashMap<>();
            for (OrderExec row : store.orderExecs(code)) {
                existing.put(row.orderId(), row);
            }
            for (Order order : audited) {
                orders++;
                ExecFill fill = fills.get(order.id());
                Map<String, Price> prices = ExecutionAudit.counterfactuals(order, fill == null ? null : fill.fill(),
                        barsPayload, quotes, calendar);
                Boolean late = ExecutionAudit.lateResolved(order, fill, calendar);
                OrderExec before = existing.get(order.id());
                int fresh = 0;
                boolean fromBars = false;
                ObjectNode cf = JsonNodeFactory.instance.objectNode();
                for (Map.Entry<String, Price> entry : prices.entrySet()) {
                    Price price = entry.getValue();
                    cf.set(entry.getKey(), price == null ? JsonNodeFactory.instance.nullNode() : price.toJson());
                    if (price != null && !filled(before, entry.getKey())) {
                        fresh++;
                        fromBars |= ExecutionAudit.MENU.containsKey(entry.getKey());
                    }
                }
                if (before != null && fresh == 0 && (late == null || before.lateResolved() != null)) {
                    continue;                              // 새로 채울 값이 없음 — 쓰지 않음
                }
                LocalDate session = ExecutionAudit.targetSession(order, calendar);
                // 지연은 그 주문의 1분봉 반사실을 처음 적는 회차의 값만 — 그 회차에 몰랐으면(null) 뒤 회차의 값으로 메우지 않습니다.
                Integer orderLag = fromBars && !menuFilled(before) ? lag : null;
                OrderExec row = new OrderExec(order.id(), code, order.timing(),
                        ExecutionAudit.targetAt(order.timing(), session, calendar), cf, orderLag, late, null);
                if (store.mergeOrderExec(row)) {
                    rows++;
                    values += fresh;
                }
            }
        }
        return new Outcome(orders, rows, values, null, null);
    }

    /** 그 행의 그 시점에 이미 값이 들었나(null·없음이 아님). */
    private static boolean filled(OrderExec row, String timing) {
        if (row == null) {
            return false;
        }
        JsonNode value = row.cf().get(timing);
        return value != null && !value.isNull();
    }

    /** 그 행에 1분봉으로 적은 메뉴 시점이 이미 있나 — 있으면 그 주문의 지연은 그 회차에 정해졌습니다(그때 null이었어도). */
    private static boolean menuFilled(OrderExec row) {
        return ExecutionAudit.MENU.keySet().stream().anyMatch(timing -> filled(row, timing));
    }

    private void record(Instant started, Outcome outcome, Snapshot bars, Quotes quotes, TradingCalendar calendar) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("books", ExecutionAudit.auditedBooks());
        detail.put("orders", outcome.orders());
        detail.put("rowsWritten", outcome.rowsWritten());
        detail.put("valuesFilled", outcome.valuesFilled());
        if (bars != null) {
            detail.put("barsCollectedAtKst", bars.collectedAt() == null ? null : Kst.stamp(bars.collectedAt()));
            Long age = bars.collectedAt() == null ? null
                    : Math.max(0, Duration.between(bars.collectedAt(), started).getSeconds());
            detail.put("barsAgeSeconds", age);
            // 1분봉 저장본이 한 회차 넘게 멈춤(MAX_AGE_BARS_US 70분) — 값은 그대로 쓰되(지난 시각의 봉은 사실) 기록에 남깁니다.
            detail.put("barsStale", age == null ? null : age > Datasets.MAX_AGE_BARS_US);
            detail.put("lagSeconds", ExecutionAudit.lagSeconds(bars.payload(), calendar));
        } else {
            detail.put("barsCollectedAtKst", null);
        }
        detail.put("quotesCollectedAtKst", quotes == null ? null : Kst.stamp(quotes.collectedAt()));
        if (outcome.error() != null) {
            detail.put("error", outcome.error());
        }
        try {
            store.recordJobRun(JOB, started, clock.instant(), outcome.error() == null ? "OK" : "ERROR",
                    mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            // 기록 실패가 감사 결과(이미 커밋됨)를 오류로 바꾸지 않게 로그만 남깁니다.
            log.warn("모의 매매 작업 기록을 남기지 못했습니다: {}", e.toString());
        }
    }
}
