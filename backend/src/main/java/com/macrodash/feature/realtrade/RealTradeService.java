package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.Limits;
import com.macrodash.collector.CollectorTradeClient.Preflight;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.collector.CollectorTradeClient.Status;
import com.macrodash.feature.auth.AuthService;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.realtrade.RealTradePlanner.Account;
import com.macrodash.feature.realtrade.RealTradePlanner.Order;
import com.macrodash.feature.realtrade.RealTradePlanner.Plan;
import com.macrodash.feature.realtrade.RealTradePlanner.Position;
import com.macrodash.feature.realtrade.RealTradePlanner.Rules;
import com.macrodash.feature.realtrade.RealTradePlanner.Skip;
import com.macrodash.feature.realtrade.RealTradePlanner.Window;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.Event;
import com.macrodash.store.RealTradeStore.OrderRow;
import com.macrodash.support.CurrentUser;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
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

/**
 * 실제 매매 API(운영자 전용 — ADR 0028, 명세 docs/specs/2026-11-06-real-trade-mirror.md §1·§7.2) — 상태·켜기 창 예상 목록·켜기·끄기·설정 바꾸기·멈춤 해제.
 *
 * <ul>
 *   <li><b>켜기류</b>(enable·update·resume): 확인 글자가 정확히 같아야 하고(서버가 다시 검사) 운영자 비밀번호를 {@link AuthService#verify}로 확인합니다 —
 *       로그인 없는 운영자 모드에서도(화면을 연 기기가 곧 운영자라 사람임을 증명하지 못함). 비밀번호를 연속 {@value #PASSWORD_MAX_FAILURES}번 틀리면
 *       30분 동안 켜기류를 거절합니다({@code password-locked}). 틀림은 {@code PASSWORD_FAILED} 이벤트(알림).</li>
 *   <li><b>끄기</b>: 확인 글자·비밀번호 없이 늘 받습니다(서버 스위치가 꺼져 있어도). 이 기능의 미종료 주문이 있으면 끄는 중(STOPPING — 정기 작업이 취소를
 *       따라가 끝나면 OFF), 없으면 바로 OFF. 끄기가 커밋된 뒤에는 정기 작업이 새 SENDING을 쓰지 못합니다(설정 행 잠금).</li>
 *   <li>미국({@code market=US})은 켜기류에서 400 {@code not-supported}, 버전이 다르면 409 {@code version-conflict}, 확인 글자가 다르면 400
 *       {@code confirm-mismatch}, 비밀번호가 틀리면 403 {@code password-invalid}.</li>
 *   <li>응답에는 토스 주문 번호·클라이언트 키·요청 본문·계좌 값을 싣지 않습니다. 금액·수량은 숫자(DB NUMERIC 그대로), 시각은 ISO 문자열입니다.</li>
 * </ul>
 */
@Service
public class RealTradeService {

    private static final Logger log = LoggerFactory.getLogger(RealTradeService.class);

    static final String CONFIRM_ENABLE = "실제 매매 켜기";
    static final String CONFIRM_UPDATE = "설정 바꾸기";
    static final String CONFIRM_RESUME = "멈춤 해제";
    static final int PASSWORD_MAX_FAILURES = 5;
    static final Duration PASSWORD_LOCK = Duration.ofMinutes(30);
    static final int ORDERS_SHOWN = 50;
    static final int EVENTS_SHOWN = 30;
    static final BigDecimal LOSS_LIMIT_MIN = BigDecimal.ONE;
    static final BigDecimal LOSS_LIMIT_MAX = new BigDecimal("50");
    /** 켜기 창 예상 목록에서 '다음 시가'를 찾는 최대 날 수. */
    static final int NEXT_SESSION_SEARCH_DAYS = 14;
    /** 상태 응답의 {@code serverEnabled.reason} — 수집기 매매 스위치 상태를 읽지 못함({@code collector}는 null — RT3-UI-1). */
    static final String REASON_STATUS_UNREADABLE = "status-unreadable";

    private static final String KR = RealTradeStore.MARKET_KR;
    private static final String US = RealTradeStore.MARKET_US;

    // ------------------------------------------------------------------ 요청 본문(비밀번호는 toString에 싣지 않음)
    public record EnableRequest(String market, String sourceBook, BigDecimal lossLimitPct, String confirm, String password,
                                Integer version) {

        @Override
        public String toString() {
            return "EnableRequest[market=" + market + ", sourceBook=" + sourceBook + ", lossLimitPct=" + lossLimitPct + ", version="
                    + version + "]";
        }
    }

    public record DisableRequest(String market) {
    }

    public record UpdateRequest(String market, String sourceBook, BigDecimal lossLimitPct, Boolean rebaseline, String confirm,
                                String password, Integer version) {

        @Override
        public String toString() {
            return "UpdateRequest[market=" + market + ", sourceBook=" + sourceBook + ", lossLimitPct=" + lossLimitPct + ", rebaseline="
                    + rebaseline + ", version=" + version + "]";
        }
    }

    public record ResumeRequest(String market, String confirm, String password, Integer version) {

        @Override
        public String toString() {
            return "ResumeRequest[market=" + market + ", version=" + version + "]";
        }
    }

    private final RealTradeStore store;
    private final CollectorTradeClient client;
    private final PaperMirrorService paper;
    private final AuthService auth;
    private final RealTradeJob job;
    private final RealTradeExecutor executor;
    private final Clock clock;
    private final boolean enabled;
    /** 비밀번호 확인·실패 기록을 한 줄로(동시에 틀린 요청이 잠금 수를 건너뛰지 않게). */
    private final Object passwordLock = new Object();

    @Autowired
    RealTradeService(RealTradeStore store, CollectorTradeClient client, PaperMirrorService paper, AuthService auth, RealTradeJob job,
                     RealTradeExecutor executor, @Value("${dashboard.realtrade.enabled:false}") boolean enabled) {
        this(store, client, paper, auth, job, executor, Clock.systemUTC(), enabled);
    }

    /** 시험용 — 시계를 정합니다. */
    RealTradeService(RealTradeStore store, CollectorTradeClient client, PaperMirrorService paper, AuthService auth, RealTradeJob job,
                     RealTradeExecutor executor, Clock clock, boolean enabled) {
        this.store = store;
        this.client = client;
        this.paper = paper;
        this.auth = auth;
        this.job = job;
        this.executor = executor;
        this.clock = clock;
        this.enabled = enabled;
    }

    // ------------------------------------------------------------------ 상태
    /**
     * {@code GET /api/realtrade/status?market=KR|US}(명세 §7.2). {@code serverEnabled.collector}는 수집기 매매 스위치 — 참·거짓, 읽지 못했으면
     * (연결 실패·시간 초과·수집기 안의 예외) null과 {@code reason} {@value #REASON_STATUS_UNREADABLE}(꺼짐과 구분 — RT3-UI-1).
     * {@code serverTime}은 이 응답을 만든 서버 시각(화면이 정기 작업 멈춤을 브라우저 시계가
     * 아니라 이 값과 견줌), {@code jobStartedAt}은 정기 작업을 시작한 시각(꺼져 있으면 null — 주기를 한 번도 끝내지 못했을 때의 기준),
     * {@code cancelGaveUpOrders}는 취소를 상한까지 보내고 포기한 미종료 행 수, {@code unresolvedOrders}는 결과 모름이고 토스 주문 번호를 모르는 미종료
     * 행 수입니다(둘 다 건수만 — 사람이 토스증권 앱에서 확인할 것, 표 준비 전이면 null).
     */
    public Map<String, Object> status(String market) {
        String m = market(market);
        boolean supported = KR.equals(m);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", store.ready());
        out.put("market", m);
        out.put("supported", supported);
        out.put("serverTime", iso(clock.instant()));
        Reply<Status> status = client.status();
        boolean known = status.ok() && status.value().known();
        Map<String, Object> server = new LinkedHashMap<>();
        server.put("collector", known ? status.value().enabled() : null);   // null = 수집기 상태를 읽지 못함(꺼짐과 다름 — RT3-UI-1)
        server.put("backend", enabled);
        server.put("reason", known ? status.value().reason() : REASON_STATUS_UNREADABLE);
        out.put("serverEnabled", server);
        if (!store.ready()) {
            out.put("message", "실제 매매 표가 아직 없습니다 — 수집기가 마이그레이션(V24)을 적용한 뒤 다시 보세요.");
            for (String key : List.of("state", "sourceBook", "sourceLabel", "lossLimitPct", "baselineEquity", "baselineTotal", "buysPaused",
                    "haltReason", "unfinishedOrders", "cancelGaveUpOrders", "unresolvedOrders", "version", "limits", "today", "jobLastCycleAt",
                    "jobStartedAt", "lastPreflight")) {
                out.put(key, null);
            }
            out.put("orders", List.of());
            out.put("events", List.of());
            out.put("books", supported ? books() : List.of());
            return out;
        }
        Config cfg = store.configOrOff(m);
        out.put("state", cfg.state());
        out.put("sourceBook", cfg.sourceBook());
        out.put("sourceLabel", cfg.sourceBook() == null ? null : paper.book(cfg.sourceBook()).map(BookInfo::label).orElse(null));
        out.put("lossLimitPct", cfg.lossLimitPct());
        out.put("baselineEquity", cfg.baselineEquity());
        out.put("baselineTotal", cfg.baselineTotal());
        out.put("buysPaused", cfg.buysPaused());
        out.put("haltReason", cfg.haltReason());
        out.put("unfinishedOrders", supported ? executor.openBrokerOrders() : 0);
        out.put("cancelGaveUpOrders", supported ? executor.cancelGaveUpOrders() : 0);
        out.put("unresolvedOrders", supported ? executor.stuckUnknown() : 0);
        out.put("version", cfg.version());
        out.put("limits", status.ok() && status.value().limits() != null ? limits(status.value().limits()) : null);
        out.put("today", supported ? today() : null);
        out.put("jobLastCycleAt", iso(job.lastCycleAt()));
        out.put("jobStartedAt", iso(job.startedAt()));
        RealTradeJob.PreflightView preflight = supported ? job.lastPreflight() : null;
        out.put("lastPreflight", preflight == null ? null : preflight(preflight));
        Map<String, String> names = new HashMap<>();
        if (preflight != null) {
            preflight.holdings().forEach(p -> names.put(p.symbol(), p.name()));
        }
        List<Map<String, Object>> orders = new ArrayList<>();
        for (OrderRow row : store.recentOrders(m, ORDERS_SHOWN)) {
            orders.add(order(row, names.get(row.symbol())));
        }
        out.put("orders", orders);
        List<Map<String, Object>> events = new ArrayList<>();
        for (Event e : store.recentEvents(m, EVENTS_SHOWN)) {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("at", iso(e.at()));
            event.put("kind", e.kind());
            event.put("detail", e.detail());
            events.add(event);
        }
        out.put("events", events);
        out.put("books", supported ? books() : List.of());
        return out;
    }

    private Map<String, Object> today() {
        RealTradeJob.TodayView view = job.todayView();
        LocalDate date = Kst.today(clock);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("date", date.toString());
        if (view == null || !date.equals(view.date())) {
            out.put("skipReason", null);
            out.put("windows", List.of());
            return out;
        }
        out.put("skipReason", view.skipReason());
        List<Map<String, Object>> windows = new ArrayList<>();
        for (Window w : view.windows()) {
            Map<String, Object> window = new LinkedHashMap<>();
            window.put("kind", w.kind());
            window.put("start", iso(w.start()));
            window.put("end", iso(w.end()));
            windows.add(window);
        }
        out.put("windows", windows);
        return out;
    }

    private static Map<String, Object> preflight(RealTradeJob.PreflightView view) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("fetchedAt", iso(view.fetchedAt()));
        out.put("equity", view.equity());
        out.put("total", view.total());
        out.put("cashBuyingPower", view.cashBuyingPower());
        List<Map<String, Object>> holdings = new ArrayList<>();
        for (Position p : view.holdings()) {
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("symbol", p.symbol());
            h.put("name", p.name());
            h.put("quantity", p.quantity());
            h.put("lastPrice", p.lastPrice());
            holdings.add(h);
        }
        out.put("holdings", holdings);
        return out;
    }

    /** 실제 주문 행 → 화면 한 줄(토스 주문 번호·클라이언트 키·요청 본문 없음). */
    private static Map<String, Object> order(OrderRow row, String name) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("session", row.session().toString());
        out.put("purpose", row.purpose());
        out.put("symbol", row.symbol());
        out.put("name", name);
        out.put("side", row.side());
        out.put("quantity", row.quantity());
        out.put("timeInForce", row.timeInForce());
        out.put("attempt", row.attempt());
        out.put("sendOutcome", row.sendOutcome());
        out.put("brokerStatus", row.brokerStatus());
        out.put("outcomeCode", row.outcomeCode());
        out.put("terminal", row.terminal());
        out.put("filledQuantity", row.filledQuantity());
        out.put("averageFilledPrice", row.averageFilledPrice());
        out.put("filledAmount", row.filledAmount());
        out.put("cancelRequested", row.cancelRequestedAt() != null);
        out.put("firstSentAt", iso(row.firstSentAt()));
        out.put("createdAt", iso(row.createdAt()));
        out.put("filledAt", iso(row.filledAt()));
        return out;
    }

    private List<Map<String, Object>> books() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String code : PaperMirrorService.FOLLOWABLE) {
            Optional<BookInfo> info = paper.book(code);
            Map<String, Object> book = new LinkedHashMap<>();
            book.put("code", code);
            book.put("label", info.map(BookInfo::label).orElse(null));
            book.put("status", info.map(BookInfo::status).orElse(null));
            out.add(book);
        }
        return out;
    }

    private static Map<String, Object> limits(Limits limits) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("maxOrderKrw", limits.maxOrderKrw());
        out.put("maxOrdersPerDay", limits.maxOrdersPerDay());
        out.put("maxBuyKrwPerDay", limits.maxBuyKrwPerDay());
        out.put("maxEquityKrw", limits.maxEquityKrw());
        return out;
    }

    // ------------------------------------------------------------------ 켜기 창 예상 목록
    /**
     * {@code GET /api/realtrade/preview?market=KR&sourceBook=…}(명세 §7.2) — 지금 새로 읽은 계좌와 그 책의 다음 맞추기 목표로 맞추기(§2·§3.1)를
     * 계산한 예상. 다음 맞추기는 그 세션의 일일 맞추기 시각이 있으면(ADR 0033 초안 결정 1 — {@link PaperMirrorService#dailySyncAt}) 그 시각 시장가
     * 맞추기(목표 {@link PaperMirrorService#targetsAt}, 응답 {@code syncAt}), 없으면 시가 맞추기(목표 {@link PaperMirrorService#openTargets},
     * {@code syncAt:null})입니다. 실제 주문은 다음 맞추기 창에서 그때 값으로 다시 계산합니다. 읽지 못하면 {@code ok:false}와 사유.
     *
     * <p>사전 조회는 정기 작업과 같은 두 단계입니다(RT-CONTRACT-5) — 매도 가능 수량 없이 읽어 계획하고, 매도 후보가 나오면 그 종목만 매도 가능 수량을 물어
     * 다시 읽은 값으로 다시 계획합니다(매도는 매도 가능 수량까지 — 수집기 사전 조회가 그 목록에서 실패하면 켜기 전에 드러남). 다음 시가가 오늘이면 수집기
     * 하루 한도의 오늘 남은 몫(정기 작업과 같은 식)도 적용해 넘는 주문은 {@code deferred-daily-cap}으로 건너뜀에 보입니다.
     */
    public Map<String, Object> preview(String market, String sourceBook) {
        requireKr(market);
        String book = followable(sourceBook);
        if (!store.ready()) {
            return previewFailed("not-ready");
        }
        Reply<Status> status = client.status();
        if (!status.ok() || !status.value().enabled() || status.value().limits() == null) {
            return previewFailed(status.ok() ? (status.value().reason() == null ? "collector-disabled" : status.value().reason())
                    : status.reason());
        }
        Limits limits = status.value().limits();
        Instant now = clock.instant();
        LocalDate session = nextSyncSession(book, now);
        if (session == null) {
            return previewFailed("calendar-unknown");
        }
        Optional<Instant> syncAt = paper.dailySyncAt(book, session);
        Optional<OpenTargets> found = syncAt.isPresent() ? paper.targetsAt(book, session, syncAt.get()) : paper.openTargets(book, session);
        if (found.isEmpty()) {
            return previewFailed("targets-unavailable");
        }
        OpenTargets targets = found.get();
        Reply<Preflight> preflight = client.preflight(targets.weightPct().keySet(), Set.of());
        if (!preflight.ok()) {
            return previewFailed(preflight.reason());
        }
        Reply<List<CollectorTradeClient.BrokerOrder>> open = client.openOrders();
        if (!open.ok()) {
            return previewFailed(open.reason());
        }
        Account account = RealTradePlanner.account(preflight.value(), open.value());
        Optional<BigDecimal> uncapped = RealTradePlanner.equity(account, null);
        Optional<BigDecimal> equity = RealTradePlanner.equity(account, BigDecimal.valueOf(limits.maxEquityKrw()));
        if (equity.isEmpty() || uncapped.isEmpty()) {
            return previewFailed(RealTradePlanner.SKIP_PRICE);
        }
        Set<String> blocked = new HashSet<>();
        store.unfinishedOrders(KR).forEach(row -> blocked.add(row.symbol()));
        Rules rules = new Rules(BigDecimal.valueOf(limits.maxOrderKrw()), Set.copyOf(paper.cashLikeTickers()), false, false);
        if (session.equals(LocalDate.ofInstant(now, Kst.ZONE))) {   // 다음 시가가 오늘 — 오늘 쓴 하루 한도를 뺌(다른 날이면 한도 전부)
            Reply<List<CollectorTradeClient.BrokerOrder>> today = client.todayOrders();
            if (!today.ok()) {
                return previewFailed(today.reason());
            }
            Optional<RealTradeJob.DailyRoom> room = job.dailyRoom(limits, account, open.value(), today.value());
            if (room.isEmpty()) {
                return previewFailed("count-unavailable");
            }
            rules = rules.withDaily(room.get().orders(), room.get().buyKrw());
        }
        Plan plan = RealTradePlanner.sync(targets.weightPct(), equity.get(), account, blocked, BigDecimal.ZERO, rules, true);
        Set<String> sell = RealTradePlanner.sellSymbols(plan);
        if (!sell.isEmpty()) {   // 두 번째 단계 — 매도 후보만 매도 가능 수량을 물어 다시 계획(정기 작업과 같이 매도 가능 수량을 모르면 팔지 않음)
            preflight = client.preflight(targets.weightPct().keySet(), sell);
            if (!preflight.ok()) {
                return previewFailed(preflight.reason());
            }
            account = RealTradePlanner.account(preflight.value(), open.value());
            uncapped = RealTradePlanner.equity(account, null);
            equity = RealTradePlanner.equity(account, BigDecimal.valueOf(limits.maxEquityKrw()));
            if (equity.isEmpty() || uncapped.isEmpty()) {
                return previewFailed(RealTradePlanner.SKIP_PRICE);
            }
            plan = RealTradePlanner.sync(targets.weightPct(), equity.get(), account, blocked, BigDecimal.ZERO, rules.withRequireSellable(true),
                    true);
        }
        // 상태의 마지막 사전 조회(lastPreflight)는 쓰지 않음 — 그 '지금 총액'은 정기 작업이 미체결 매수가 잡은 금액을 되돌린 값이라, 되돌림 없는 이
        // 값으로 덮으면 기준 대비 손익·멈춤선이 거짓 손실로 보임(RT3-UI-2). 화면은 이 응답의 equity를 씀.
        List<String> warnings = new ArrayList<>();
        if (!targets.complete()) {
            warnings.add("targets-incomplete");
        }
        if (paper.book(book).map(b -> !b.active()).orElse(true)) {
            warnings.add(RealTradeJob.HALT_BOOK_NOT_ACTIVE);
        }
        if (plan.turnoverExceeded()) {
            warnings.add("turnover-over-60");
        }
        if (uncapped.get().compareTo(equity.get()) > 0) {
            warnings.add("equity-capped");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("sourceBook", book);
        out.put("session", session.toString());
        out.put("syncAt", syncAt.map(RealTradeService::iso).orElse(null));
        out.put("equity", equity.get());
        List<Map<String, Object>> orders = new ArrayList<>();
        for (Order o : plan.orders()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("symbol", o.symbol());
            row.put("name", o.name());
            row.put("side", o.side());
            row.put("quantity", o.quantity());
            row.put("estAmount", o.estAmount());
            orders.add(row);
        }
        out.put("orders", orders);
        List<Map<String, Object>> skipped = new ArrayList<>();
        for (Skip s : plan.skipped()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("symbol", s.symbol());
            row.put("name", s.name());
            row.put("reason", s.reason());
            skipped.add(row);
        }
        out.put("skipped", skipped);
        out.put("turnoverPct", plan.turnoverPct());
        out.put("warnings", warnings);
        return out;
    }

    private static Map<String, Object> previewFailed(String reason) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("reason", reason);
        out.put("equity", null);
        out.put("orders", List.of());
        out.put("skipped", List.of());
        out.put("turnoverPct", null);
        out.put("warnings", List.of());
        return out;
    }

    /**
     * 다음 맞추기 세션 — 오늘 개장 전이거나 오늘의 일일 맞추기 시각(ADR 0033 초안 — 개장 10분 뒤 시각 맞추기) 전이면 오늘, 아니면 모의 한국 달력의 다음
     * 거래일. 달력이 모르면 null.
     */
    private LocalDate nextSyncSession(String book, Instant now) {
        LocalDate date = LocalDate.ofInstant(now, Kst.ZONE);
        for (int i = 0; i <= NEXT_SESSION_SEARCH_DAYS; i++) {
            LocalDate d = date.plusDays(i);
            Optional<SessionHours> hours = paper.sessionHours(d);
            if (hours.isEmpty()) {
                return null;
            }
            if (!hours.get().tradingDay()) {
                continue;
            }
            if (i > 0 || now.isBefore(hours.get().open()) || paper.dailySyncAt(book, d).map(now::isBefore).orElse(false)) {
                return d;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ 켜기
    /**
     * {@code POST /api/realtrade/enable}(명세 §7.2) — OFF → LIVE, sync_pending·기준 평가액·기준 총액(지금 상한 없는 총액 + 그때 토스 미체결 매수가 잡은
     * 금액 — {@link #baseline})·따라 하는 책과 세대.
     */
    public Map<String, Object> enable(CurrentUser user, EnableRequest body) {
        requireOwner(user);
        if (body == null) {
            throw new RealTradeException(400, "invalid-request", "요청 본문이 없습니다.");
        }
        requireKr(body.market());
        Instant now = clock.instant();
        checkPasswordLock(now);
        confirm(body.confirm(), CONFIRM_ENABLE);
        verifyPassword(user, body.password(), now);
        int version = version(body.version());
        BigDecimal lossLimit = lossLimit(body.lossLimitPct() == null ? RealTradeStore.DEFAULT_LOSS_LIMIT_PCT : body.lossLimitPct());
        String book = followable(body.sourceBook());
        BookInfo info = activeBook(book);
        requireReady();
        Limits limits = requireServerEnabled();
        Config current = store.configOrOff(KR);
        if (current.version() != version) {
            throw versionConflict();
        }
        if (!RealTradeStore.STATE_OFF.equals(current.state())) {
            throw new RealTradeException(409, "invalid-state", "꺼져 있을 때만 켤 수 있습니다(지금 " + current.state() + ").");
        }
        Baseline baseline = baseline(limits);
        Config saved = store.lockConfig(KR, locked -> {
            if (locked.version() != version) {
                throw versionConflict();
            }
            if (!RealTradeStore.STATE_OFF.equals(locked.state())) {
                throw new RealTradeException(409, "invalid-state", "꺼져 있을 때만 켤 수 있습니다(지금 " + locked.state() + ").");
            }
            executor.resolveByOperator(now);
            Config next = locked.withState(RealTradeStore.STATE_LIVE).withSource(book, info.generation()).withLossLimitPct(lossLimit)
                    .withBaselineEquity(baseline.equity()).withBaselineTotal(baseline.total()).withBuysPaused(false).withSyncPending(true)
                    .withHalt(null, null);
            if (!store.updateConfig(next, user.id())) {
                throw versionConflict();
            }
            store.addEvent(KR, RealTradeStore.EVENT_ENABLE, user.id(), Map.of("sourceBook", book, "lossLimitPct", lossLimit), true);
            return store.config(KR).orElseThrow();
        });
        log.warn("실제 매매 켜짐 — 따라 하는 책 {}, 손실 한도 {}%", book, lossLimit);
        return action(saved);
    }

    // ------------------------------------------------------------------ 끄기
    /** {@code POST /api/realtrade/disable}(명세 §7.2) — 비밀번호·확인 글자 없이 늘. 미종료 주문이 있으면 STOPPING, 없으면 OFF. */
    public Map<String, Object> disable(CurrentUser user, DisableRequest body) {
        requireOwner(user);
        String m = market(body == null ? null : body.market());
        if (!store.ready()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("state", RealTradeStore.STATE_OFF);
            out.put("version", null);
            return out;
        }
        Config saved = store.lockConfig(m, locked -> {
            String from = locked.state();
            if (RealTradeStore.STATE_OFF.equals(from) || RealTradeStore.STATE_STOPPING.equals(from)) {
                return locked;
            }
            boolean unfinished = !store.unfinishedOrders(m).isEmpty();
            String to = unfinished ? RealTradeStore.STATE_STOPPING : RealTradeStore.STATE_OFF;
            Config next = locked.withState(to).withSyncPending(false);
            if (!unfinished) {
                next = next.withHalt(null, null);
            }
            if (!store.updateConfig(next, user.id())) {
                throw versionConflict();
            }
            store.addEvent(m, RealTradeStore.EVENT_DISABLE, user.id(), Map.of("from", from, "to", to), true);
            return store.config(m).orElseThrow();
        });
        log.warn("실제 매매 끄기({}) — 지금 {}", m, saved.state());
        return action(saved);
    }

    // ------------------------------------------------------------------ 설정 바꾸기
    /**
     * {@code POST /api/realtrade/update}(명세 §7.2) — 켜짐(LIVE)에서 방식·손실 한도·기준 다시 잡기. 방식이 바뀌면 sync_pending을 켜고, 옛 책의 미체결은
     * 정기 작업이 취소합니다(따라 하는 책·세대가 다른 미종료 행). 기준 다시 잡기는 이 기능의 미체결 매수(토스 주문 번호 있음)가 있으면 409
     * {@code invalid-state}로 거절합니다(RT2-3) — 그 매수가 잡은 매수 가능 금액만큼 기준 총액 U0가 낮게 잡히는데, 손실 판정의 지금 값은 그 금액을
     * 되돌려 세므로(명세 §12.5) 손실 한도가 그만큼 늦게 걸림. 사전 조회 전에 한 번, 설정 행 잠금 안에서 한 번 더 봅니다.
     */
    public Map<String, Object> update(CurrentUser user, UpdateRequest body) {
        requireOwner(user);
        if (body == null) {
            throw new RealTradeException(400, "invalid-request", "요청 본문이 없습니다.");
        }
        requireKr(body.market());
        Instant now = clock.instant();
        checkPasswordLock(now);
        confirm(body.confirm(), CONFIRM_UPDATE);
        verifyPassword(user, body.password(), now);
        int version = version(body.version());
        String book = body.sourceBook() == null ? null : followable(body.sourceBook());
        BigDecimal lossLimit = body.lossLimitPct() == null ? null : lossLimit(body.lossLimitPct());
        boolean rebaseline = Boolean.TRUE.equals(body.rebaseline());
        if (book == null && lossLimit == null && !rebaseline) {
            throw new RealTradeException(400, "nothing-to-update", "바꿀 값(방식·손실 한도·기준 다시 잡기)이 없습니다.");
        }
        requireReady();
        Config current = store.configOrOff(KR);
        if (current.version() != version) {
            throw versionConflict();
        }
        if (!RealTradeStore.STATE_LIVE.equals(current.state())) {
            throw new RealTradeException(409, "invalid-state", "켜져 있을 때만 설정을 바꿀 수 있습니다(지금 " + current.state() + ").");
        }
        boolean bookChange = book != null && !book.equals(current.sourceBook());
        BookInfo info = bookChange ? activeBook(book) : null;
        if (rebaseline) {
            requireNoPendingBuy();
        }
        Baseline baseline = rebaseline ? baseline(requireServerEnabled()) : null;
        Config saved = store.lockConfig(KR, locked -> {
            if (locked.version() != version) {
                throw versionConflict();
            }
            if (!RealTradeStore.STATE_LIVE.equals(locked.state())) {
                throw new RealTradeException(409, "invalid-state", "켜져 있을 때만 설정을 바꿀 수 있습니다(지금 " + locked.state() + ").");
            }
            if (rebaseline) {
                requireNoPendingBuy();   // 사전 조회 도중(잠금 밖) 매수가 접수됐을 수 있음
            }
            Config next = locked;
            List<String> changes = new ArrayList<>();
            if (bookChange) {
                next = next.withSource(book, info.generation()).withSyncPending(true);
                changes.add("sourceBook");
            }
            if (lossLimit != null) {
                next = next.withLossLimitPct(lossLimit);
                changes.add("lossLimitPct");
            }
            if (baseline != null) {
                next = next.withBaselineEquity(baseline.equity()).withBaselineTotal(baseline.total());
                changes.add("rebaseline");
            }
            if (!store.updateConfig(next, user.id())) {
                throw versionConflict();
            }
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("changes", changes);
            detail.put("sourceBook", next.sourceBook());
            detail.put("lossLimitPct", next.lossLimitPct());
            store.addEvent(KR, RealTradeStore.EVENT_UPDATE, user.id(), detail, true);
            return store.config(KR).orElseThrow();
        });
        log.warn("실제 매매 설정 바뀜 — 방식 {}, 손실 한도 {}%", saved.sourceBook(), saved.lossLimitPct());
        return action(saved);
    }

    // ------------------------------------------------------------------ 멈춤 해제
    /**
     * {@code POST /api/realtrade/resume}(명세 §7.2) — 이상 멈춤(HALTED) → 켜짐(sync_pending), 또는 켜짐의 매수 멈춤(손실 한도) 해제. 재전송 창이 끝난 결과
     * 모름 행은 사람이 확인한 것으로 보고 종료로 둡니다. 따라 하던 책이 리셋·재출발했으면(세대가 다름) 끄고 다시 켜야 합니다(켜기 창의 예상 목록을 보게).
     */
    public Map<String, Object> resume(CurrentUser user, ResumeRequest body) {
        requireOwner(user);
        if (body == null) {
            throw new RealTradeException(400, "invalid-request", "요청 본문이 없습니다.");
        }
        requireKr(body.market());
        Instant now = clock.instant();
        checkPasswordLock(now);
        confirm(body.confirm(), CONFIRM_RESUME);
        verifyPassword(user, body.password(), now);
        int version = version(body.version());
        requireReady();
        Config current = store.configOrOff(KR);
        if (current.version() != version) {
            throw versionConflict();
        }
        boolean halted = RealTradeStore.STATE_HALTED.equals(current.state());
        boolean buysOnly = RealTradeStore.STATE_LIVE.equals(current.state()) && current.buysPaused();
        if (!halted && !buysOnly) {
            throw new RealTradeException(409, "invalid-state", "이상 멈춤이거나 매수 멈춤일 때만 해제할 수 있습니다(지금 " + current.state() + ").");
        }
        if (halted) {
            requireServerEnabled();
            BookInfo info = activeBook(current.sourceBook());
            if (!info.generation().equals(current.bookGeneration())) {
                throw new RealTradeException(409, RealTradeJob.HALT_BOOK_CHANGED,
                        "따라 하던 책이 리셋·재출발했습니다 — 끄고 다시 켜서 예상 목록을 확인하세요.");
            }
        }
        Config saved = store.lockConfig(KR, locked -> {
            if (locked.version() != version) {
                throw versionConflict();
            }
            Config next;
            if (halted) {
                if (!RealTradeStore.STATE_HALTED.equals(locked.state())) {
                    throw versionConflict();
                }
                executor.resolveByOperator(now);
                next = locked.withState(RealTradeStore.STATE_LIVE).withHalt(null, null).withBuysPaused(false).withSyncPending(true);
            } else {
                next = locked.withBuysPaused(false);
            }
            if (!store.updateConfig(next, user.id())) {
                throw versionConflict();
            }
            store.addEvent(KR, RealTradeStore.EVENT_RESUME, user.id(),
                    Map.of("from", locked.state(), "haltReason", String.valueOf(locked.haltReason()), "buysPausedCleared", locked.buysPaused()),
                    true);
            return store.config(KR).orElseThrow();
        });
        log.warn("실제 매매 멈춤 해제 — 지금 {}", saved.state());
        return action(saved);
    }

    // ------------------------------------------------------------------ 검사
    private static void requireOwner(CurrentUser user) {
        if (user == null || user.demo() || !user.isOwner() || user.email() == null) {
            throw new RealTradeException(403, "forbidden", "운영자만 쓸 수 있습니다.");
        }
    }

    /** 시장 값 — KR·US 그대로(대문자)만. */
    private static String market(String market) {
        if (KR.equals(market) || US.equals(market)) {
            return market;
        }
        throw new RealTradeException(400, "invalid-market", "market는 KR · US 가운데 하나여야 합니다.");
    }

    /** 켜기류는 한국만(명세 §7.2 — 미국은 400 not-supported). */
    private static void requireKr(String market) {
        if (KR.equals(market(market))) {
            return;
        }
        throw new RealTradeException(400, "not-supported", "미국 실제 매매는 준비 중입니다.");
    }

    private static void confirm(String typed, String expected) {
        if (!expected.equals(typed)) {
            throw new RealTradeException(400, "confirm-mismatch", "확인 글자가 다릅니다 — '" + expected + "'를 그대로 입력하세요.");
        }
    }

    private static int version(Integer version) {
        if (version == null || version < 0) {
            throw new RealTradeException(400, "invalid-version", "설정 버전(version)이 필요합니다 — 상태를 다시 읽고 보내세요.");
        }
        return version;
    }

    private static BigDecimal lossLimit(BigDecimal pct) {
        if (pct.compareTo(LOSS_LIMIT_MIN) < 0 || pct.compareTo(LOSS_LIMIT_MAX) > 0 || pct.stripTrailingZeros().scale() > 2) {
            throw new RealTradeException(400, "invalid-loss-limit", "손실 한도는 1~50%, 소수 둘째 자리까지입니다.");
        }
        return pct.setScale(2, RoundingMode.UNNECESSARY);
    }

    private static String followable(String sourceBook) {
        if (sourceBook != null && PaperMirrorService.FOLLOWABLE.contains(sourceBook)) {
            return sourceBook;
        }
        throw new RealTradeException(400, "invalid-source-book", "따라 할 책은 kr_rules · kr_claude · kr_claude2 가운데 하나여야 합니다.");
    }

    /** 운용 중(ACTIVE)인 한국 책. */
    private BookInfo activeBook(String code) {
        Optional<BookInfo> info = paper.book(code);
        if (info.isEmpty() || !info.get().active() || !KR.equals(info.get().market())) {
            throw new RealTradeException(400, RealTradeJob.HALT_BOOK_NOT_ACTIVE, "그 책이 운용 중이 아닙니다 — 모의 책을 출발시킨 뒤 켜세요.");
        }
        return info.get();
    }

    private void requireReady() {
        if (!store.ready()) {
            throw new RealTradeException(409, "not-ready", "실제 매매 표가 아직 없습니다 — 수집기가 마이그레이션(V24)을 적용한 뒤 다시 하세요.");
        }
    }

    /** 서버 두 스위치(명세 §1의 1·2)가 모두 켜져 있어야 함 — 수집기 한도를 돌려줍니다. */
    private Limits requireServerEnabled() {
        Reply<Status> status = enabled ? client.status() : null;
        if (status == null || !status.ok() || !status.value().enabled() || status.value().limits() == null) {
            throw new RealTradeException(409, "server-disabled", "서버 스위치(백엔드 REAL_TRADE_ENABLED·수집기 TOSS_TRADING_ENABLED)가 꺼져 있습니다.");
        }
        return status.value().limits();
    }

    /** 기준 다시 잡기 전 — 이 기능의 미종료 매수 중 토스 주문 번호가 있는 것이 없어야 함(RT2-3, {@link #update}). */
    private void requireNoPendingBuy() {
        boolean pending = store.unfinishedOrders(KR).stream()
                .anyMatch(row -> RealTradePlanner.BUY.equals(row.side()) && row.tossOrderId() != null);
        if (pending) {
            throw new RealTradeException(409, "invalid-state", "이 기능의 미체결 매수가 끝난 뒤 기준을 다시 잡으세요.");
        }
    }

    /** 손실 한도의 기준 — 운용 평가액 E0(안전 상한 적용 — 한도 금액의 분모)와 같은 사전 조회의 상한 없는 총액 U0(손실 판정의 기준, RT-BE-3). */
    private record Baseline(BigDecimal equity, BigDecimal total) {
    }

    /**
     * 지금 새로 읽은 기준(켜기·기준 다시 잡기) — 토스 미체결 목록 + 한 번의 사전 조회로 E0와 U0를 함께. U0는 상한 없는 총액에 그때 미체결 목록의 매수
     * (앱 주문 포함)가 잡은 금액(남은 수량 × 상한가)을 되돌린 값이고(RT3-BE-4 — 손실 판정의 '지금 값'과 같은 정의: 미체결 매수가 매수 가능 금액을 잡아
     * 낮아진 만큼 U0가 낮게 잡히면 그 주문이 끝난 뒤 손실 한도가 그만큼 늦게 걸림), E0는 그 값에 안전 상한을 적용한 값입니다. 미체결 목록을 못 읽거나
     * 미체결 매수의 수량·상한가를 모르면 502 {@code preflight-failed}.
     */
    private Baseline baseline(Limits limits) {
        Reply<List<CollectorTradeClient.BrokerOrder>> open = client.openOrders();
        if (!open.ok()) {
            throw new RealTradeException(502, "preflight-failed", "토스 미체결 목록을 읽지 못했습니다(" + open.reason() + ") — 잠시 뒤 다시 하세요.");
        }
        Reply<Preflight> preflight = client.preflight(RealTradePlanner.openBuySymbols(open.value()), Set.of());
        if (!preflight.ok()) {
            throw new RealTradeException(502, "preflight-failed", "토스 계좌를 새로 읽지 못했습니다(" + preflight.reason() + ") — 잠시 뒤 다시 하세요.");
        }
        Account account = RealTradePlanner.account(preflight.value(), open.value());
        BigDecimal cap = BigDecimal.valueOf(limits.maxEquityKrw());
        Optional<BigDecimal> total = RealTradePlanner.equity(account, null);
        Optional<BigDecimal> equity = RealTradePlanner.equity(account, cap);
        if (equity.isEmpty() || total.isEmpty()) {
            throw new RealTradeException(502, "preflight-failed", "운용 평가액을 정하지 못했습니다(보유 가격을 모름) — 잠시 뒤 다시 하세요.");
        }
        Optional<BigDecimal> held = RealTradePlanner.openBuyHold(open.value(), account::upper);
        if (held.isEmpty()) {
            throw new RealTradeException(502, "preflight-failed", "토스 미체결 매수의 수량·상한가를 모릅니다 — 잠시 뒤 다시 하세요.");
        }
        BigDecimal lossTotal = total.get().add(held.get());
        BigDecimal lossEquity = lossTotal.min(cap);
        if (lossEquity.signum() <= 0) {
            throw new RealTradeException(502, "preflight-failed", "운용 평가액을 정하지 못했습니다(보유 가격을 모름) — 잠시 뒤 다시 하세요.");
        }
        job.notePreflight(preflight.value(), account, equity.get(), lossTotal, clock.instant());
        return new Baseline(lossEquity.setScale(2, RoundingMode.HALF_UP), lossTotal.setScale(2, RoundingMode.HALF_UP));
    }

    /** 비밀번호 잠금(명세 §7.1) — 마지막 성공 뒤 연속 실패가 {@value #PASSWORD_MAX_FAILURES}번 이상이고 마지막 실패가 30분 안이면 거절. */
    private void checkPasswordLock(Instant now) {
        List<Instant> failures = store.passwordFailuresSinceLastSuccess(Instant.EPOCH);
        if (failures.size() >= PASSWORD_MAX_FAILURES && now.isBefore(failures.getFirst().plus(PASSWORD_LOCK))) {
            throw new RealTradeException(403, "password-locked", "비밀번호를 연속 " + PASSWORD_MAX_FAILURES + "번 틀려 30분 동안 켜기류를 받지 않습니다.");
        }
    }

    /** 운영자 비밀번호 확인 — 틀리면 PASSWORD_FAILED 이벤트(연속 횟수·잠금 여부, 알림)와 403. 잠금 확인과 기록을 한 줄로 합니다. */
    private void verifyPassword(CurrentUser user, String password, Instant now) {
        synchronized (passwordLock) {
            checkPasswordLock(now);
            boolean ok = password != null && !password.isEmpty() && auth.verify(user.email(), password).isPresent();
            if (ok) {
                return;
            }
            int consecutive = store.passwordFailuresSinceLastSuccess(Instant.EPOCH).size() + 1;
            boolean locked = consecutive >= PASSWORD_MAX_FAILURES;
            store.addEvent(KR, RealTradeStore.EVENT_PASSWORD_FAILED, user.id(), Map.of("consecutive", consecutive, "locked", locked), true);
            log.warn("실제 매매 켜기류 비밀번호 틀림 — 연속 {}회{}", consecutive, locked ? "(30분 잠금)" : "");
            throw new RealTradeException(403, "password-invalid", "운영자 비밀번호가 올바르지 않습니다.");
        }
    }

    private static RealTradeException versionConflict() {
        return new RealTradeException(409, "version-conflict", "그사이 설정이 바뀌었습니다 — 상태를 다시 읽고 다시 하세요.");
    }

    private static Map<String, Object> action(Config saved) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("state", saved.state());
        out.put("version", saved.version());
        return out;
    }

    private static String iso(Instant at) {
        return at == null ? null : at.toString();
    }
}
