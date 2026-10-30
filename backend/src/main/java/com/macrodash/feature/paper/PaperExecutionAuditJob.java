package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
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
import java.util.Optional;

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
 * 칸을 남긴 체결)이 생기면 그 체결 행으로 한 번 셉니다({@link ExecutionAudit#lateResolved} — 대체 칸이거나 장부 반영이 T + 71분 뒤). 그 밖의 주문은
 * null입니다.
 *
 * <p>저장본(1분봉·관측치)은 {@link StoreReader#quietly}로만 읽습니다 — 정기 작업이 수집기를 깨우지 않게(ADR 0008). 작업 기록
 * ({@code paper_job_runs}, 이름 {@value #JOB})은 무엇이든 새로 썼을 때(감사 행·새 사슬 고리)와 오류일 때만 남깁니다(5분마다 쌓이면 다른 작업 기록을 밀어냄) — 실행 시간은
 * 그 기록의 시작·끝 시각으로 잽니다(명세 §14-1 — 길면 리스크 점검 뒤에 붙이는 판으로). 예외는 삼키고 로그만 남깁니다(스케줄러로 던지지 않음).
 *
 * <p><b>계좌2 주문의 계좌1식 기준</b>(NEXT_OBSERVATION, 명세 §14-1·ADR 0022 결정 4 — M1의 P_cf): 체결 조건 ①②④를 통과한 <b>첫</b> {@code paper.quotes}
 * 저장본의 그 종목 종가입니다({@link ExecutionAudit#fromObservation}). 저장본은 최신 한 건만 남으므로(V1 snapshots) 이 작업은 자기가 본 저장본이
 * 빠짐없이 이어졌음을 증명할 때만 적고, 증명하지 못하면 null로 둡니다 — 뒤 저장본의 값으로 채우지 않습니다. 증명은 <b>관측치 사슬</b>입니다:
 * <ol>
 *   <li>새 관측치 저장본(수집 시각 c)을 처음 본 실행은 사슬 고리 {@code quotesChain = {collectedAt: c, previous: p, adjacent, runsBetween}}을 작업 기록에
 *       남깁니다(p = 그 전에 기록한 가장 늦은 고리의 수집 시각 — 저장된 기록이라 재기동·서버 정지 뒤에도 이어짐).</li>
 *   <li>{@code adjacent}는 p와 c 사이에 다른 저장이 없었다는 증명입니다 — 수집기 실행 기록({@code collector_task_runs})에서 관측치 태스크
 *       ({@code paper_quotes})의 실행 가운데 시작이 (p, c) 사이인 것이 정확히 하나(c를 쓴 실행)면 참. 근거: 이 저장본은 그 태스크만 쓰고, 같은 태스크는
 *       겹쳐 돌지 않으며(앞 실행이 도는 중이면 새로 시작하지 않고 그 사실을 한 줄로 기록 — 그 줄도 셈), 저장은 그 실행이 시작한 뒤에 하므로 p 뒤의
 *       저장마다 (p, c) 안에서 시작한 실행이 하나씩 있습니다. 둘 이상이면 거짓(놓친 저장본이 있을 수 있음). 0이면 c를 쓴 실행의 기록이 아직 없는
 *       것이라(기록은 저장 뒤에 남음) 고리를 남기지 않고 다음 실행에서 다시 셉니다(그동안 이 기준은 적지 않음).</li>
 *   <li>주문(생성 시각 C)의 지금 저장본이 첫째라는 것: 지금 고리에서 {@code previous}를 따라 C 이하인 고리에 닿을 때까지 모든 고리가 {@code adjacent}
 *       — 그러면 C 뒤의 모든 저장본을 이 작업이 차례로 봤고, 그때마다 그 주문을 ①②④로 보았는데 값이 없었으니 통과하지 못했던 것입니다. 고리가 하나라도
 *       거짓이거나 빠졌으면(처음 고리·기록 200건 밖으로 밀림·서버가 꺼진 사이 저장이 둘 이상) 그 주문은 끝까지 null입니다.</li>
 * </ol>
 * 남는 가정은 두 가지입니다 — 수집기 실행 기록이 빠지지 않음(기록 쓰기가 실패하면 수집기는 로그만 남김), 백엔드·수집기·DB 시계가 같음(같은 호스트).
 *
 * <p>사슬은 <b>계좌2 행이 있고 설정 {@code claude2.enabled}가 켜졌거나 계좌2가 이미 출발했을 때만</b> 셉니다({@link #chainWanted}) — 계좌2 주문은 출발
 * (INITIAL — 켠 뒤에만 생김)부터라 사슬이 그 앞에서 시작하면 증명은 그대로이고, 배포만으로는(계좌2 행이 없거나 꺼진 채 시작 전) 작업 기록이 늘지 않습니다
 * (ADR 0022 — 배포로 바뀌는 것 없음). 사슬 계산이 실패하면 그 실행은 계좌2 기준을 보지 않고({@code chain = null}) 감사는 그대로 하며, 기록에
 * {@code chainError}를 남깁니다 — 계좌2 전용 증명이 계좌1 측정을 막지 않게. 켠 뒤 첫 감사 전에 출발 주문이 생기면 그 주문 뒤 첫 저장본이 처음 고리라
 * 증명되지 않으므로, 계좌2 출발(정기·수동)은 그 출발이 읽은 관측치의 고리가 기록된 뒤에만 냅니다({@link #chainNotReady} — 결정 작업이 봄, 리뷰 F2 ⓑ).
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

    /** 작업 기록 상세의 관측치 사슬 고리 칸(클래스 설명). */
    static final String CHAIN = "quotesChain";
    /** 사슬 고리를 찾는 작업 기록 수 — 기록은 작업마다 최근 200건만 남습니다(PaperStore). */
    private static final int CHAIN_RECORDS = 200;

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final StoreRepository repository;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    PaperExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, StoreRepository repository,
                           PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, repository, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperExecutionAuditJob(PaperStore store, StoreReader reader, PaperMarketData marketData, StoreRepository repository,
                           PaperConfig config, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.repository = repository;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 관측치 사슬의 고리 하나(클래스 설명) — 저장본 수집 시각, 그 전에 기록한 고리의 수집 시각(없으면 null), 둘 사이에 다른 저장이 없었음이 증명됐나,
     * 그 사이 시작한 관측치 태스크 실행 수(모르면 null).
     */
    record ChainLink(Instant collectedAt, Instant previous, boolean adjacent, Integer runsBetween) {

        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("collectedAt", collectedAt.toString());
            out.put("previous", previous == null ? null : previous.toString());
            out.put("adjacent", adjacent);
            out.put("runsBetween", runsBetween);
            return out;
        }
    }

    /**
     * 그 주문의 지금 관측치가 ①②④를 통과하는 첫 저장본일 수 있음이 증명됐나(클래스 설명 3) — 지금 고리부터 {@code previous}를 따라 주문 생성 시각
     * 이하의 고리에 닿을 때까지 모두 {@code adjacent}. 고리가 빠졌거나 처음 고리(previous 없음)에 닿으면 거짓.
     *
     * @param links 수집 시각 → 고리(이번 실행의 새 고리 포함)
     */
    static boolean chainProven(Instant created, Instant current, Map<Instant, ChainLink> links) {
        if (created == null || current == null) {
            return false;
        }
        Instant at = current;
        while (at.isAfter(created)) {
            ChainLink link = links.get(at);
            if (link == null || !link.adjacent() || link.previous() == null) {
                return false;
            }
            at = link.previous();
        }
        return true;
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
        LinkState link = null;
        String chainError = null;
        Outcome outcome;
        try {
            // 수집 태스크 이름을 넘기지 않고(null) quietly 안에서 읽습니다 — 오래된 저장본이어도 수집을 요청하지 않음.
            bars = reader.quietly(() -> reader.read(Datasets.SNAP_PAPER_BARS_US, Datasets.MAX_AGE_BARS_US, null))
                    .orElse(null);
            quotes = reader.quietly(() -> marketData.quotes(UsPaperMarket.INSTANCE)).orElse(null);
            // 관측치 사슬(계좌2 기준의 증명) — 계좌2가 켜졌거나 출발했을 때만, 실패해도 감사는 그대로(클래스 설명).
            Map<Instant, ChainLink> chain = null;
            if (quotes != null) {
                try {
                    if (chainWanted()) {
                        Map<Instant, ChainLink> links = chainLinks(store);
                        link = link(quotes.collectedAt(), links);
                        if (link != null && link.isNew()) {
                            links.put(link.collectedAt(), link.link());
                        }
                        // 고리를 아직 셀 수 없으면(c를 쓴 실행의 기록 전) 이번에는 계좌2 기준을 보지 않습니다(link == null).
                        chain = link == null ? null : links;
                    }
                } catch (RuntimeException e) {
                    link = null;
                    chainError = e.getClass().getSimpleName() + " " + e.getMessage();
                    log.warn("모의 매매 실행 감사 — 관측치 사슬을 세지 못해 이번에는 계좌2 기준을 보지 않습니다: {}", chainError);
                }
            }
            JsonNode payload = bars == null ? null : bars.payload();
            Quotes observed = quotes;
            Map<Instant, ChainLink> proven = chain;
            outcome = store.atomically(() -> audit(started, payload, observed, calendar, proven));
        } catch (RuntimeException e) {
            outcome = new Outcome(0, 0, 0, null, e.getClass().getSimpleName() + " " + e.getMessage());
            link = null;
        }
        boolean newLink = link != null && link.isNew();
        if (outcome.rowsWritten() > 0 || outcome.error() != null || newLink || chainError != null) {
            record(started, outcome, bars, quotes, calendar, newLink ? link.link() : null, chainError);
        }
        return outcome;
    }

    /**
     * 관측치 사슬을 셀 때인가(클래스 설명) — 계좌2 행이 있고 시작 전이 아니거나(출발함·일시정지 — 남은 주문의 기준을 이어 봄), 시작 전이면 지금 설정의
     * {@code claude2.enabled}가 켜졌을 때. 설정 행이 없으면 기본값(꺼짐)입니다.
     */
    private boolean chainWanted() {
        Optional<Book> book = store.book(PaperBooks.CLAUDE2);
        if (book.isEmpty()) {
            return false;
        }
        if (!PaperBooks.NOT_STARTED.equals(book.get().status())) {
            return true;
        }
        return Claude2Settings.from(store.settings().map(PaperStore.SettingsRow::body).orElse(null)).enabled();
    }

    /** 이번 실행의 고리 — 새 고리면 {@code isNew}(작업 기록에 남김), 이미 기록한 저장본이면 그 고리. */
    private record LinkState(ChainLink link, boolean isNew) {

        Instant collectedAt() {
            return link.collectedAt();
        }
    }

    /**
     * 지금 저장본(수집 시각 c)의 고리(클래스 설명 1·2) — 이미 기록한 저장본이면 그 고리, 아니면 그 전에 기록한 가장 늦은 고리 p와의 사이를 수집기 실행 기록으로
     * 셈. 셀 수 없으면(p와 c 사이에 시작한 실행 기록이 아직 0 — c를 쓴 실행의 기록 전) null.
     */
    private LinkState link(Instant collectedAt, Map<Instant, ChainLink> links) {
        if (collectedAt == null) {
            return null;
        }
        ChainLink known = links.get(collectedAt);
        if (known != null) {
            return new LinkState(known, false);
        }
        Instant previous = links.keySet().stream().filter(at -> at.isBefore(collectedAt)).max(Instant::compareTo)
                .orElse(null);
        if (previous == null) {
            return new LinkState(new ChainLink(collectedAt, null, false, null), true);   // 처음 고리 — 그 앞을 모름
        }
        int runs = repository.countTaskRunsStarted(UsPaperMarket.INSTANCE.quotesTask(), previous, collectedAt);
        if (runs == 0) {
            return null;
        }
        return new LinkState(new ChainLink(collectedAt, previous, runs == 1, runs), true);
    }

    /**
     * 계좌2 출발(INITIAL — 정기·수동)을 낼 수 있게 관측치 사슬이 준비됐나(리뷰 F2 ⓑ, 명세 §4-1·§5-4) — 그 출발이 읽은 관측치 저장본(수집 시각
     * c ≤ 지금)의 고리가 작업 기록에 있으면 null, 없으면 기다릴 사유. 고리가 있으면 출발 주문(생성 &gt; c) 뒤의 저장본마다 이 작업이 그 고리에서 이어 붙이므로
     * 출발 주문의 계좌1식 기준(M1 P_cf)을 증명할 수 있습니다(클래스 설명 3). 없으면 — 켠 뒤 첫 감사(5분 주기) 전이거나 새 저장본을 이 작업이 아직 보지
     * 못함 — 그 사이 생긴 출발 주문의 첫 통과 저장본이 처음 고리이거나 처음 고리 뒤라 출발 묶음의 기준이 끝까지 null입니다. 더 이른 저장본의 고리로는
     * 갈음하지 않습니다 — 그 뒤 사슬을 세지 않은 사이(계좌2를 켰다 끔)가 있으면 다음 고리가 이어지지 않습니다.
     *
     * @param collectedAt 출발이 읽은 관측치 저장본의 수집 시각(없으면 null — 고리가 있을 수 없음)
     */
    static String chainNotReady(PaperStore store, Instant collectedAt, Instant now) {
        if (collectedAt != null && !collectedAt.isAfter(now) && chainLinks(store).containsKey(collectedAt)) {
            return null;
        }
        return "관측치 사슬 준비 중 — 실행 감사(5분마다)가 지금 관측치"
                + (collectedAt == null ? "" : "(수집 " + Kst.stamp(collectedAt) + ")")
                + "의 사슬 고리를 아직 남기지 않았습니다(켠 뒤 첫 감사 전·새 관측치 직후). 출발 주문의 계좌1식 기준(M1)을 증명하려면 주문 전에 "
                + "그 고리가 있어야 합니다";
    }

    /** 기록한 사슬 고리(작업 기록 최근 {@value #CHAIN_RECORDS}건의 {@value #CHAIN} 칸) — 수집 시각 → 고리, 같은 저장본이 둘이면 먼저 기록한 것. */
    static Map<Instant, ChainLink> chainLinks(PaperStore store) {
        Map<Instant, ChainLink> out = new HashMap<>();
        List<PaperStore.JobRun> runs = store.recentJobRuns(JOB, CHAIN_RECORDS);
        for (int i = runs.size() - 1; i >= 0; i--) {   // 오래된 기록부터 — 먼저 기록한 고리가 남게
            JsonNode chain = runs.get(i).detail() == null ? null : runs.get(i).detail().get(CHAIN);
            Instant at = chain == null ? null : instant(chain.path("collectedAt").asString(null));
            if (at == null || out.containsKey(at)) {
                continue;
            }
            JsonNode runsBetween = chain.get("runsBetween");
            out.put(at, new ChainLink(at, instant(chain.path("previous").asString(null)),
                    chain.path("adjacent").asBoolean(false),
                    runsBetween == null || !runsBetween.isNumber() ? null : runsBetween.intValue()));
        }
        return out;
    }

    private static Instant instant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(text);
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    /**
     * 대상 계좌마다 주문을 보고 감사 행을 합칩니다(한 트랜잭션 안).
     *
     * @param chain 관측치 사슬(이번 고리 포함) — 이번 실행에 계좌2 기준을 볼 수 없으면 null
     */
    private Outcome audit(Instant now, JsonNode barsPayload, Quotes quotes, TradingCalendar calendar,
                          Map<Instant, ChainLink> chain) {
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
                // 계좌2 주문의 계좌1식 기준 — 지금 관측치가 첫 통과 저장본일 수 있음을 사슬로 증명했을 때만(클래스 설명).
                boolean first = chain != null && quotes != null
                        && chainProven(order.createdAt(), quotes.collectedAt(), chain);
                Map<String, Price> prices = ExecutionAudit.counterfactuals(order, fill == null ? null : fill.fill(),
                        barsPayload, quotes, calendar, first);
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
                        ExecutionAudit.targetAt(order, session, calendar), cf, orderLag, late, null);
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

    private void record(Instant started, Outcome outcome, Snapshot bars, Quotes quotes, TradingCalendar calendar,
                        ChainLink link, String chainError) {
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
        if (link != null) {
            detail.put(CHAIN, link.view());   // 새로 본 관측치 저장본의 고리(클래스 설명 — 다음 실행·재기동 뒤에도 이 기록으로 이음)
        }
        if (chainError != null) {
            detail.put("chainError", chainError);   // 사슬을 세지 못함 — 이번 실행은 계좌2 기준을 보지 않음(감사 결과는 그대로)
        }
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
