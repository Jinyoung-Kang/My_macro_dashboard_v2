package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.CarriedConditions;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.BriefingStore;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.DecisionSummary;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 마감 브리핑 작업(ADR 0039) — 시장마다 정규장 마감 + N분({@link Briefing.Settings})에 그 세션의 브리핑을 한 번 만들어 텔레그램으로 보냅니다.
 *
 * <p>한 세션의 일: ① 사실을 장부·매크로 카드 저장본에서 만들고({@link Briefing#facts} — 수집을 깨우지 않음) ② Claude를 한 번 불러 해석·의견을 받고
 * (시스템 = {@link Briefing#PROMPT} + 지금 프레임 판의 렌더링, 하루 호출 상한에 세고 정기 결정 몫의 예약은 쓰지 않음 — 상한·호출 실패·형식 오류면 사실만) ③ 글을 만들어 행을 남긴 뒤
 * ({@code paper_briefings} — 시장·세션마다 한 행이라 다시 부르지 않음) ④ 그 시장 봇으로 보냅니다. 보내기가 실패하면 행은 남고 보낸 시각이 비어,
 * 다음 주기에 같은 글을 다시 보냅니다(Claude는 다시 부르지 않음).
 *
 * <p>보낼 창은 예정 시각부터 {@link #WINDOW}까지입니다 — 그보다 늦으면(서버가 오래 꺼져 있었음) 지난 세션의 브리핑을 뒤늦게 보내지 않습니다.
 * 모의 매매의 입력으로 쓰지 않습니다 — 이 작업은 장부·주문·결정 패킷을 읽기만 하고 아무것도 바꾸지 않습니다. 실제 계좌 자료는 읽지 않습니다.
 */
@Component
public class PaperBriefingJob {

    private static final Logger log = LoggerFactory.getLogger(PaperBriefingJob.class);

    static final String JOB = "briefing";
    /** 예정 시각을 이만큼 넘기면 그 세션의 브리핑을 만들지 않습니다. */
    static final Duration WINDOW = Duration.ofHours(3);
    /** 그 세션의 체결·스탑 주문을 찾을 때 읽는 최근 행 수. */
    static final int LEDGER_SCAN = 300;
    static final int DECISION_SCAN = 40;
    static final int ERROR_CHARS = 300;

    static final String OFF = "OFF";
    static final String NOT_READY = "NOT_READY";
    static final String DORMANT = "DORMANT";
    static final String NO_CALENDAR = "NO_CALENDAR";
    static final String TOO_EARLY = "TOO_EARLY";
    static final String TOO_LATE = "TOO_LATE";
    static final String ALREADY_SENT = "ALREADY_SENT";
    static final String SENT = "SENT";
    static final String SEND_FAILED = "SEND_FAILED";
    static final String BUSY = "BUSY";

    /** 한 번 실행의 결과 — 무엇을 했는지와 그 세션·사유. */
    record Result(String outcome, LocalDate session, String message) {
    }

    private final PaperStore store;
    private final BriefingStore briefings;
    private final StoreReader reader;
    private final PaperMarkets markets;
    private final FrameworkService framework;
    private final PaperApiCalls calls;
    private final AiService ai;
    private final PaperTelegram telegram;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final int timeoutSeconds;
    private final Clock clock;
    private final StructuredSchema schema;
    private final ReentrantLock running = new ReentrantLock();

    @Autowired
    PaperBriefingJob(PaperStore store, BriefingStore briefings, StoreReader reader, PaperMarkets markets, FrameworkService framework,
                     PaperApiCalls calls, AiService ai, PaperTelegram telegram, PaperConfig config, ObjectMapper mapper,
                     @Value("${dashboard.paper.claude-timeout-seconds:300}") int timeoutSeconds) {
        this(store, briefings, reader, markets, framework, calls, ai, telegram, config, mapper, timeoutSeconds, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperBriefingJob(PaperStore store, BriefingStore briefings, StoreReader reader, PaperMarkets markets, FrameworkService framework,
                     PaperApiCalls calls, AiService ai, PaperTelegram telegram, PaperConfig config, ObjectMapper mapper,
                     int timeoutSeconds, Clock clock) {
        this.store = store;
        this.briefings = briefings;
        this.reader = reader;
        this.markets = markets;
        this.framework = framework;
        this.calls = calls;
        this.ai = ai;
        this.telegram = telegram;
        this.config = config;
        this.mapper = mapper;
        this.timeoutSeconds = Math.max(1, timeoutSeconds);
        this.clock = clock;
        // 스키마 파일이 깨졌으면 기동하지 않습니다 — 첫 브리핑 시각에야 알게 되지 않게.
        this.schema = StructuredSchema.load(Briefing.SCHEMA_RESOURCE);
    }

    /** 정기 실행 — 시장마다 차례로. 꺼져 있으면 아무것도 하지 않습니다. 예외는 삼키고 로그만(한 시장의 예외가 다음 시장을 막지 않음). */
    @Scheduled(initialDelayString = "${dashboard.paper.briefing-initial-delay-ms:150000}",
            fixedDelayString = "${dashboard.paper.briefing-interval-ms:60000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        for (PaperMarket market : markets.all()) {
            try {
                Result result = run(market);
                if (SENT.equals(result.outcome()) || SEND_FAILED.equals(result.outcome())) {
                    log.info("마감 브리핑 {} {}: {} {}", market.code(), result.session(), result.outcome(),
                            result.message() == null ? "" : result.message());
                }
            } catch (RuntimeException e) {
                log.warn("마감 브리핑 작업 실패({}) — 다음 주기에 다시 봅니다: {}", market.code(), e.toString());
            }
        }
    }

    /** 그 시장의 한 번 실행(클래스 설명). 다른 실행이 돌고 있으면 기다리지 않고 {@value #BUSY}. */
    Result run(PaperMarket requested) {
        if (!running.tryLock()) {
            return new Result(BUSY, null, "다른 브리핑 실행이 돌고 있습니다");
        }
        try {
            return runLocked(requested, clock.instant());
        } finally {
            running.unlock();
        }
    }

    private Result runLocked(PaperMarket requested, Instant now) {
        if (!store.ready() || !briefings.ready()) {
            return new Result(NOT_READY, null, null);
        }
        if (requested.dormantReason(config, () -> store.books(requested.code())) != null) {
            return new Result(DORMANT, null, null);
        }
        MarketRun market = markets.open(requested);
        boolean korea = !Book.MARKET_US.equals(market.code());
        Briefing.Settings settings = Briefing.Settings.from(market.settingsBody(), korea);
        if (!settings.enabled()) {
            return new Result(OFF, null, null);
        }
        TradingCalendar calendar;
        LocalDate session;
        Instant close;
        LocalDate previous;
        try {
            market.requireCalendarWindow(now);
            calendar = market.calendar();
            session = calendar.lastCompletedSession(now);
            close = calendar.closeInstant(session);
            previous = calendar.previousTradingDay(session);
        } catch (CalendarUnavailableException e) {
            return new Result(NO_CALENDAR, null, e.getMessage());
        }
        Instant due = close.plus(Duration.ofMinutes(settings.afterCloseMinutes()));
        if (now.isBefore(due)) {
            return new Result(TOO_EARLY, session, null);
        }
        if (now.isAfter(due.plus(WINDOW))) {
            return new Result(TOO_LATE, session, null);
        }
        Optional<BriefingStore.Row> existing = briefings.find(market.code(), session);
        if (existing.isPresent()) {
            if (existing.get().sentAt() != null) {
                return new Result(ALREADY_SENT, session, null);
            }
            return send(market, session, existing.get().message(), korea, now, existing.get().status());
        }
        List<Book> books = store.books(market.code());
        if (books.isEmpty()) {
            return new Result(DORMANT, session, null);
        }
        Instant started = now;
        Map<String, Object> facts = Briefing.facts(market.code(), session, previous, close, now, macro(), bookData(books, session, previous),
                korea);
        JsonNode factsNode = mapper.valueToTree(facts);
        String factsText = mapper.writer().without(SerializationFeature.INDENT_OUTPUT).writeValueAsString(factsNode);
        Opinion opinion = opinion(market, factsText);
        String message = Briefing.message(factsNode, opinion.response(), opinion.error());
        BriefingStore.Row row = new BriefingStore.Row(market.code(), session, opinion.response() == null ? BriefingStore.FACTS_ONLY
                : BriefingStore.OK, factsNode, opinion.response(), message, opinion.model(), opinion.usage(), opinion.error(), null, null);
        if (!briefings.insertIfAbsent(row)) {
            return new Result(ALREADY_SENT, session, "그사이 다른 실행이 이 세션의 브리핑을 남겼습니다");
        }
        Result result = send(market, session, message, korea, clock.instant(), row.status());
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("session", session.toString());
        detail.put("status", row.status());
        detail.put("sent", SENT.equals(result.outcome()));
        detail.put("error", opinion.error());
        store.recordJobRun(market.jobName(JOB), started, clock.instant(), result.outcome(), mapper.valueToTree(detail));
        return result;
    }

    /** 글을 그 시장 봇으로 보내고 성공하면 보낸 시각을 적습니다. */
    private Result send(MarketRun market, LocalDate session, String message, boolean korea, Instant now, String status) {
        String error = telegram.send(korea ? PaperTelegram.Channel.KR : PaperTelegram.Channel.US, message);
        if (error != null) {
            return new Result(SEND_FAILED, session, error);
        }
        briefings.markSent(market.code(), session, now);
        return new Result(SENT, session, status);
    }

    /** Claude의 의견 — 받지 못했으면 응답이 null이고 그 까닭. */
    private record Opinion(JsonNode response, String error, String model, JsonNode usage) {
    }

    /** Claude 호출 한 번(클래스 설명 ②) — 상한·호출 실패·형식 오류는 예외가 아니라 '사실만'으로 돌려줍니다. */
    private Opinion opinion(MarketRun market, String factsText) {
        JsonNode body = market.settingsBody();
        ClaudeBookService.ClaudeSettings claude = ClaudeBookService.ClaudeSettings.intraday(body);
        LocalDate today = Kst.today(clock);
        // 정기 결정 몫으로 남겨 둔 예약은 쓰지 않습니다(장중 판단과 같은 한도) — 브리핑이 결정의 호출을 밀어내지 않게.
        if (calls.reserve(today, claude.callLimit(false)).isEmpty()) {
            return new Opinion(null, "하루 호출 상한에 닿아 Claude를 부르지 않았습니다", null, null);
        }
        AiService.StructuredResult result;
        try {
            FrameworkService.Frame frame = framework.current();
            String system = Briefing.PROMPT + FrameworkService.render(market, frame.body(), frame.version(), body);
            result = ai.structured(claude.model(), system, Briefing.userMessage(factsText), schema.forApi(), claude.effort(),
                    timeoutSeconds);
        } catch (RuntimeException e) {
            calls.release(today);
            return new Opinion(null, clip("호출을 보내지 못했습니다: " + e.getMessage()), claude.model(), null);
        }
        calls.record(today, claude.model(), result);
        Map<String, Object> usage = new LinkedHashMap<>();
        usage.put("model", claude.model());
        usage.put("effort", claude.effort());
        usage.put("inputTokens", result.inputTokens());
        usage.put("outputTokens", result.outputTokens());
        usage.put("latencyMs", result.latencyMs());
        usage.put("stopReason", result.stopReason());
        JsonNode usageNode = mapper.valueToTree(usage);
        if (!result.ok()) {
            return new Opinion(null, clip("[" + (result.errorKind() == null ? "UNKNOWN" : result.errorKind()) + "] " + result.error()),
                    claude.model(), usageNode);
        }
        JsonNode parsed;
        try {
            parsed = mapper.readTree(result.text());
        } catch (RuntimeException e) {
            return new Opinion(null, "응답 형식 오류 — JSON으로 읽지 못했습니다", claude.model(), usageNode);
        }
        List<String> violations = schema.validate(parsed);
        if (!violations.isEmpty()) {
            return new Opinion(null, clip("응답 형식 오류 — " + violations.get(0)), claude.model(), usageNode);
        }
        return new Opinion(parsed, null, claude.model(), usageNode);
    }

    /** 매크로 카드 저장본의 항목 전부(없으면 빈 목록) — 저장본만 읽습니다(수집을 깨우지 않음). */
    private List<JsonNode> macro() {
        List<JsonNode> out = new ArrayList<>();
        JsonNode payload = reader.readStored(Datasets.SNAP_MACRO_COLLECTED).map(Snapshot::payload).orElse(null);
        for (JsonNode category : Json.array(payload, "categories")) {
            out.addAll(Json.array(category, "items"));
        }
        return out;
    }

    /** 계좌마다의 재료 — 장부를 읽기만 합니다. */
    private List<Briefing.BookData> bookData(List<Book> books, LocalDate session, LocalDate previous) {
        List<Briefing.BookData> out = new ArrayList<>();
        for (Book book : books) {
            String code = book.code();
            List<Fill> fills = store.recentFills(code, LEDGER_SCAN).stream()
                    .filter(f -> session.equals(f.observationDate())).sorted(Comparator.comparingLong(Fill::id)).toList();
            List<Long> stops = store.recentOrders(code, LEDGER_SCAN).stream().filter(o -> PaperBooks.SOURCE_STOP.equals(o.source()))
                    .map(Order::id).toList();
            List<DecisionSummary> decisions = store.decisions(code, DECISION_SCAN).stream()
                    .filter(d -> previous.equals(d.asOfTradingDate())).sorted(Comparator.comparingLong(DecisionSummary::id)).toList();
            out.add(new Briefing.BookData(book, store.state(code).orElse(null), store.navSeries(code), store.positions(code), fills,
                    stops, store.ordersByStatus(code, PaperBooks.ORDER_PENDING), decisions, conditions(code, decisions)));
        }
        return out;
    }

    /** 그 세션을 목표로 한 결정 가운데 판단이 남은 가장 늦은 정기·수동 결정이 남긴 조건(없으면 빈 목록). */
    private List<CarriedConditions.Condition> conditions(String code, List<DecisionSummary> decisions) {
        for (int i = decisions.size() - 1; i >= 0; i--) {
            DecisionSummary d = decisions.get(i);
            if (!PacketBuilder.priorDecisionKind(code, d.kind())) {
                continue;
            }
            JsonNode response = store.decision(d.id()).map(Decision::response).orElse(null);
            if (response != null && response.isObject() && response.has("schemaVersion")) {
                return Continuity.conditions(response);
            }
        }
        return List.of();
    }

    private static String clip(String text) {
        return Continuity.clip(text, ERROR_CHARS);
    }
}
