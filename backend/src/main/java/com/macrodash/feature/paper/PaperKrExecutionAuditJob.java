package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.store.PaperStore.SettingsRow;
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
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * 한국 실행 감사 정기 작업(한국 Claude 계좌2 단계 2c — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §6·§11) — 5분마다 한국 Claude 계좌1·2의 결정
 * 주문마다 "시가·매시·종가로 체결했다면의 원가격"(반사실)을 {@code paper_order_exec}에 적습니다. 판정은 {@link KrExecutionAudit}이고, 이 작업은
 * 저장본을 읽어 넘기고 결과를 합쳐 쓰기만 합니다. 미국 작업({@link PaperExecutionAuditJob})을 시장 일반화하지 않고 따로 둔 까닭은 미국 실험의 관측치
 * 사슬·Yahoo 조건을 건드리지 않으려는 것입니다(한국 장중 확인 작업과 같은 까닭 — 명세 §10).
 *
 * <p><b>측정만 합니다.</b> 장부 잠금을 잡지 않고, 장부 표(주문·체결)는 읽기만 하며 쓰는 표는 실행 감사 표와 작업 기록뿐입니다. 쓰기는 한 실행에 한
 * 트랜잭션({@link PaperStore#atomically})입니다.
 *
 * <p><b>대상</b>: 한국 Claude 계좌({@link KrExecutionAudit#auditedBooks})의 결정 주문 가운데 목표 세션 E가 오늘(서울 날짜)에서 {@value #WINDOW_DAYS}일
 * 안쪽이거나 뒤인 것 — 수집기 범위(최근 8일 주문, 세션 최근 8)와 같은 폭입니다. 그보다 오래된 주문은 다시 보지 않습니다. 달력이 E의 해를 모르면 그
 * 주문만 건너뜁니다(기록에 수).
 *
 * <p><b>한 번 쓴 값은 고치지 않습니다</b>(저장 쪽 {@link PaperStore#mergeOrderExec}) — 못 구한 시점은 null로 두었다가 다음 저장본에서 다시 봅니다.
 * 늦게 풂({@code late_resolved})은 한국 계좌2 주문에 체결이 생기면 그 체결 행으로 한 번 셉니다({@link KrExecutionAudit#lateResolved} — 기한은 그 실행
 * 설정 판의 E 밤 한국 결정 기한). 지연({@code lag_seconds})은 늘 null입니다.
 *
 * <p>저장본(1분봉·관측치)은 {@link StoreReader#quietly}로만 읽습니다(수집을 깨우지 않게 — ADR 0008). 작업 기록({@code paper_job_runs}, 이름
 * {@value #JOB} — 한국 접두어라 한국 상태 응답의 작업 목록에 보임)은 무엇이든 새로 썼을 때와 오류일 때만 남깁니다. 예외는 삼키고 로그만 남깁니다.
 * {@code dashboard.paper.enabled=false}(로컬 — {@code PAPER_ENABLED=false})면 아무것도 읽거나 쓰지 않습니다.
 */
@Service
public class PaperKrExecutionAuditJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 한국 접두어({@link KrPaperMarket#jobPrefix} {@code kr.}). */
    static final String JOB = KrPaperMarket.INSTANCE.jobName("exec-audit");
    /** 감사하는 목표 세션의 폭 — 오늘(서울 날짜) − 이 일수 이후의 세션(수집기 {@code KR_AUDIT_RECENT_DAYS}와 같은 값). */
    static final int WINDOW_DAYS = 8;
    /** 기준 거래일을 DB에서 고를 때 더 보는 여유(기준 거래일 → 다음 거래일은 연휴에도 이 안). */
    private static final int AS_OF_SLACK_DAYS = 7;

    private static final Logger log = LoggerFactory.getLogger(PaperKrExecutionAuditJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 실행 열기 — 한국 달력은 실행마다 공휴일 저장본으로 만듭니다(그 주기의 설정 행과 함께). */
    private final PaperMarkets markets;

    @Autowired
    PaperKrExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperConfig config,
                             ObjectMapper mapper) {
        this(store, reader, marketData, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperKrExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperConfig config,
                             ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = new PaperMarkets(store, reader);
    }

    /**
     * 한 실행의 결과.
     *
     * @param orders        본 주문 수(대상 계좌 모두)
     * @param rowsWritten   새로 넣었거나 채운 감사 행 수
     * @param valuesFilled  새로 채운 반사실 시점 수
     * @param calendarGaps  달력이 E의 해를 몰라 건너뛴 주문 수
     * @param skippedReason 돌지 않은 사유(테이블 없음) — 돌았으면 null
     * @param error         실패 사유 — 없으면 null
     */
    record Outcome(int orders, int rowsWritten, int valuesFilled, int calendarGaps, String skippedReason, String error) {

        static Outcome skipped(String reason) {
            return new Outcome(0, 0, 0, 0, reason, null);
        }
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.kr-exec-audit-initial-delay-ms:165000}",
            fixedDelayString = "${dashboard.paper.kr-exec-audit-interval-ms:300000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            Outcome outcome = run();
            if (outcome.error() != null) {
                log.warn("한국 실행 감사 실패 — 다음 주기에 다시 봅니다: {}", outcome.error());
            } else if (outcome.rowsWritten() > 0) {
                log.info("한국 실행 감사: 주문 {} · 행 {} · 반사실 {}", outcome.orders(), outcome.rowsWritten(), outcome.valuesFilled());
            }
        } catch (RuntimeException e) {
            log.warn("한국 실행 감사 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 번 실행 — 테스트가 부릅니다(정기 실행과 같은 일, 꺼짐 확인만 없음). */
    Outcome run() {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다 — make up 후 다시 보세요");
        }
        Instant started = clock.instant();
        Outcome outcome;
        try {
            MarketRun run = markets.open(KrPaperMarket.INSTANCE);
            TradingCalendar calendar = run.calendar();
            JsonNode body = run.settingsRow().map(SettingsRow::body).orElse(null);
            // 수집 태스크 이름을 넘기지 않거나 quietly 안에서 읽습니다 — 오래된 저장본이어도 수집을 요청하지 않음.
            Map<String, Map<LocalDate, Timed>> timed = reader.quietly(marketData::krTimed);
            Map<String, Boolean> nxt = nxt(reader.quietly(() -> marketData.quotes(KrPaperMarket.INSTANCE)).orElse(null));
            Function<LocalDate, Instant> deadline = day -> KrPaperMarket.decisionWindow(run, body, day).deadline();
            outcome = store.atomically(() -> audit(started, timed, nxt, calendar, deadline));
        } catch (RuntimeException e) {
            outcome = new Outcome(0, 0, 0, 0, null, e.getClass().getSimpleName() + " " + e.getMessage());
        }
        if (outcome.rowsWritten() > 0 || outcome.error() != null) {
            record(started, outcome);
        }
        return outcome;
    }

    /** 지금 관측치의 종목마다 NXT 종목인가(토스 종목 칸 — 모르면 표에 없음). 종가 반사실의 마감 봉 라벨을 고릅니다. */
    private static Map<String, Boolean> nxt(Quotes quotes) {
        Map<String, Boolean> out = new HashMap<>();
        if (quotes == null) {
            return out;
        }
        for (Bar bar : quotes.bars().values()) {
            if (bar.kr() != null && bar.kr().nxtSupported() != null) {
                out.put(bar.ticker(), bar.kr().nxtSupported());
            }
        }
        return out;
    }

    /** 대상 계좌마다 주문을 보고 감사 행을 합칩니다(한 트랜잭션 안). */
    private Outcome audit(Instant now, Map<String, Map<LocalDate, Timed>> timed, Map<String, Boolean> nxt,
                          TradingCalendar calendar, Function<LocalDate, Instant> deadline) {
        LocalDate today = now.atZone(calendar.zone()).toLocalDate();
        LocalDate fromSession = today.minusDays(WINDOW_DAYS);
        int orders = 0;
        int rows = 0;
        int values = 0;
        int gaps = 0;
        for (String code : KrExecutionAudit.auditedBooks()) {
            if (store.book(code).isEmpty()) {
                continue;
            }
            List<Order> audited = new ArrayList<>();
            Map<Long, LocalDate> sessions = new HashMap<>();
            for (Order order : store.executionOrders(code, fromSession.minusDays(AS_OF_SLACK_DAYS))) {
                LocalDate session;
                try {
                    session = KrExecutionAudit.targetSession(order, calendar);
                } catch (CalendarUnavailableException e) {
                    gaps++;                                // 달력이 그 해를 모름 — 그 주문만 건너뜀
                    continue;
                }
                if (session != null && !session.isBefore(fromSession)) {
                    audited.add(order);
                    sessions.put(order.id(), session);
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
                LocalDate session = sessions.get(order.id());
                Timed entry = timed.getOrDefault(order.ticker(), Map.of()).get(session);
                Map<String, Price> prices;
                Boolean late;
                try {
                    prices = KrExecutionAudit.counterfactuals(order, entry, nxt.get(order.ticker()), calendar);
                    late = KrExecutionAudit.lateResolved(order, fills.get(order.id()),
                            KrExecutionAudit.choosesTiming(code) ? deadline.apply(session) : null);
                } catch (CalendarUnavailableException e) {
                    gaps++;
                    continue;
                }
                OrderExec before = existing.get(order.id());
                int fresh = 0;
                ObjectNode cf = JsonNodeFactory.instance.objectNode();
                for (Map.Entry<String, Price> e : prices.entrySet()) {
                    Price price = e.getValue();
                    cf.set(e.getKey(), price == null ? JsonNodeFactory.instance.nullNode() : price.toJson());
                    if (price != null && !filled(before, e.getKey())) {
                        fresh++;
                    }
                }
                if (before != null && fresh == 0 && (late == null || before.lateResolved() != null)) {
                    continue;                              // 새로 채울 값이 없음 — 쓰지 않음
                }
                OrderExec row = new OrderExec(order.id(), code, order.timing(),
                        KrExecutionAudit.targetAt(order, session, calendar), cf, null, late, null);
                if (store.mergeOrderExec(row)) {
                    rows++;
                    values += fresh;
                }
            }
        }
        return new Outcome(orders, rows, values, gaps, null, null);
    }

    /** 그 행의 그 시점에 이미 값이 들었나(null·없음이 아님). */
    private static boolean filled(OrderExec row, String timing) {
        if (row == null) {
            return false;
        }
        JsonNode value = row.cf().get(timing);
        return value != null && !value.isNull();
    }

    private void record(Instant started, Outcome outcome) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("books", KrExecutionAudit.auditedBooks());
        detail.put("orders", outcome.orders());
        detail.put("rowsWritten", outcome.rowsWritten());
        detail.put("valuesFilled", outcome.valuesFilled());
        detail.put("calendarGaps", outcome.calendarGaps());
        if (outcome.error() != null) {
            detail.put("error", outcome.error());
        }
        try {
            store.recordJobRun(JOB, started, clock.instant(), outcome.error() == null ? "OK" : "ERROR", mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            // 기록 실패가 감사 결과(이미 커밋됨)를 오류로 바꾸지 않게 로그만 남깁니다.
            log.warn("한국 실행 감사 작업 기록을 남기지 못했습니다: {}", e.toString());
        }
    }
}
