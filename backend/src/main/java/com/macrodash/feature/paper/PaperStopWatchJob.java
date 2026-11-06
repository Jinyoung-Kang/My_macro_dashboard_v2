package com.macrodash.feature.paper;

import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
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

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 모의 장중 스탑 감시 정기 작업(ADR 0032) — 20초마다 그 시장 감시 저장본({@code paper.stopwatch.us}·{@code paper.stopwatch.kr})이 새로 들어왔으면 운용
 * 중인 규칙·Claude 계좌1·2(벤치마크 제외)의 보유마다 {@link StopWatch}로 판정합니다.
 *
 * <p><b>스위치</b>({@link StopWatchMode} — {@code stopWatch.mode}·{@code kr.stopWatch.mode}): OFF면 그 시장은 읽지도 않고, SHADOW면 '걸렸을 것'을 작업
 * 기록({@code paper_job_runs}, 이름 {@value #JOB}·{@code kr.}{@value #JOB})에만 남기며(종목마다 그 세션에 한 번), ON이면 STOP 주문을 냅니다. 기록은
 * 주문을 냈거나·'걸렸을 것'·갭 가드 제외·오류·세션 중 저장본이 늦은 첫 회차일 때만 남깁니다(20초마다 쌓이지 않게).
 *
 * <p><b>판정하는 격자</b>: 지난 회차에 본 마지막 격자 뒤부터 저장본이 받은 시각까지의 격자(첫 판정 격자 = 개장 + 10분 — 개장 10분 전에는 팔지 않음, 끝 =
 * 장 끝 여유 앞). 재기동 직후에는 가장 최근 격자 하나만 봅니다. 한 종목에서 처음 걸린 격자로 주문을 냅니다.
 *
 * <p><b>주문</b>(ON): 매도·수량 없음(체결 때 보유 전량)·출처 {@code STOP}·대기, 결정 없음, 기준 거래일 = 그 세션 전 거래일(목표 세션 = 그 세션), 생성 =
 * 이 작업의 시각, 만료 = 그 세션, 시점은 {@link StopWatch#target}(감지 + 60초 뒤 첫 분 — 보통 장중 시장가, 장 끝 여유 안이면 종가). 근거에
 * {@code stopMode = }{@value #STOP_MODE}·최고가·스탑가·두 격자의 가격과 봉 시각·감시 저장본 시각·감지 시각·기준 시각과 사람이 읽는 한 줄({@code note} —
 * 텔레그램 '근거')을 남깁니다. 체결은 기존 1분봉 사다리가 합니다(미국 다음 관측치, 한국 그날 밤 — 장부). 같은 종목에 대기 STOP이 있거나, 전량 매도
 * 대기 주문의 기준 시각이 이 STOP의 기준 시각 이전이면 내지 않습니다(멱등 — 대기 STOP이 곧 '이미 냄'의 표시라 상태 표가 없음).
 *
 * <p><b>최고가</b>: 장부가 쓴 값만 씁니다(이 작업은 최고가를 쓰지 않음). 한국은 저장된 최고가와, 장부가 최고가를 올리는 같은 규칙의 금융위 확정 종가
 * (그 세션 전날까지 — {@link PaperLedgerService#watermarkFrom}) 가운데 큰 값입니다(금융위 D 값은 D+1 낮에 들어와 밤 장부보다 먼저 볼 수 있음).
 * 현금성·한국 미처리 기업행위 보유·갭 가드에 걸린 종목은 보지 않습니다.
 *
 * <p>장부 잠금({@link PaperLedgerService#exclusively}) 안에서 책마다 한 트랜잭션입니다 — 관측치 처리와 같은 종목을 함께 팔지 않게. Claude 호출을 하지
 * 않아 몇 초 안에 끝납니다. 저장본은 {@link StoreReader#quietly}로만 읽습니다(ADR 0008). {@code dashboard.paper.enabled=false}면 아무것도 하지 않습니다.
 */
@Service
public class PaperStopWatchJob {

    /** 작업 기록의 이름(paper_job_runs.job) — 시장의 작업 기록 접두어를 붙여 씁니다(미국은 그대로, 한국은 kr.). */
    static final String JOB = "stopwatch";
    /** 감시가 낸 STOP 근거의 {@code stopMode}. */
    static final String STOP_MODE = "INTRADAY_WATCH";
    /** 세션 중 저장본이 이만큼 넘게 늦으면 그 세션 첫 한 번 기록합니다(감시가 끊김 — 대체 경로가 지킴). */
    static final Duration LATE = Duration.ofMinutes(15);
    /** 장 마감 뒤에도 이만큼은 마지막 격자의 저장본을 기다립니다. */
    static final Duration AFTER_CLOSE = Duration.ofMinutes(5);

    private static final Logger log = LoggerFactory.getLogger(PaperStopWatchJob.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final PaperMarkets markets;
    private final ReentrantLock running = new ReentrantLock();
    /** 시장 코드 → 이 프로세스가 본 것(재기동하면 비어 가장 최근 격자부터). */
    private final Map<String, MarketState> states = new HashMap<>();

    /** 한 시장의 프로세스 메모리 — 세션이 바뀌면 새로 엽니다. */
    private static final class MarketState {
        LocalDate session;
        Instant lastGrid;
        String lastFetched;
        boolean lateNoted;
        final Set<String> shadowSeen = new HashSet<>();
        final Set<String> guardSeen = new HashSet<>();
    }

    @Autowired
    PaperStopWatchJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                      PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, ledger, config, mapper, Clock.systemUTC(), new PaperMarkets(store, reader));
    }

    /** 테스트용 — 시계와 시장 목록을 바꿉니다. */
    PaperStopWatchJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                      PaperConfig config, ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = markets;
    }

    /**
     * 한 시장 한 주기의 결과.
     *
     * @param skipped   일하지 않은 사유(스위치 꺼짐·창 밖·새 저장본 없음 …) — 일했으면 null
     * @param grids     판정한 격자(이른 순)
     * @param orders    낸 STOP(ON)
     * @param wouldStop 걸렸을 것(SHADOW)
     * @param guards    갭 가드로 그날 감시에서 뺀 종목(처음 본 것만)
     */
    record Outcome(String market, String mode, String skipped, List<Instant> grids, List<Map<String, Object>> orders,
                   List<Map<String, Object>> wouldStop, List<Map<String, Object>> guards, String late, String error) {

        static Outcome skip(String market, String mode, String reason) {
            return new Outcome(market, mode, reason, List.of(), List.of(), List.of(), List.of(), null, null);
        }
    }

    /** 정기 실행 — 꺼져 있으면 아무것도 하지 않습니다. 앞 주기가 도는 중이면 건너뜁니다. 예외는 로그로만 남깁니다. */
    @Scheduled(initialDelayString = "${dashboard.paper.stopwatch-initial-delay-ms:195000}",
            fixedDelayString = "${dashboard.paper.stopwatch-interval-ms:20000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        try {
            for (Outcome outcome : run()) {
                if (outcome.error() != null) {
                    log.warn("장중 스탑 감시({}) 실패 — 다음 주기에 다시 봅니다: {}", outcome.market(), outcome.error());
                } else if (!outcome.orders().isEmpty()) {
                    log.info("장중 스탑 감시({}): STOP {}건 {}", outcome.market(), outcome.orders().size(), outcome.orders());
                }
            }
        } catch (RuntimeException e) {
            log.warn("장중 스탑 감시 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** 한 주기 — 시장마다 차례로(테스트가 부릅니다). 앞 주기가 도는 중이면 빈 목록. */
    List<Outcome> run() {
        if (!running.tryLock()) {
            return List.of();
        }
        try {
            List<Outcome> out = new ArrayList<>();
            for (PaperMarket market : markets.all()) {
                try {
                    out.add(runMarket(market));
                } catch (RuntimeException e) {
                    out.add(new Outcome(market.code(), null, null, List.of(), List.of(), List.of(), List.of(), null, e.toString()));
                }
            }
            return out;
        } finally {
            running.unlock();
        }
    }

    private Outcome runMarket(PaperMarket definition) {
        String code = definition.code();
        if (!store.ready()) {
            return Outcome.skip(code, null, "모의 매매 테이블이 아직 없습니다");
        }
        if (definition.dormantReason(config, () -> store.books(code)) != null) {
            return Outcome.skip(code, null, "그 시장이 정기 작업을 쉼");
        }
        boolean korea = definition.auctionFills();
        SettingsRow row = store.settings().orElse(null);
        StopWatchMode mode = StopWatchMode.of(row == null ? null : row.body(), korea);
        if (!mode.watching()) {
            states.remove(code);
            return Outcome.skip(code, mode.name(), "스위치 꺼짐(" + StopWatchMode.key(korea) + " OFF)");
        }
        MarketRun run = markets.open(definition);
        TradingCalendar calendar = run.calendar();
        Instant now = clock.instant();
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        if (!calendar.isTradingDay(session)) {
            return Outcome.skip(code, mode.name(), "거래일 아님");
        }
        Instant firstGrid = StopWatch.firstJudgedGrid(calendar, session);
        Instant end = StopWatch.gridEnd(calendar, session, korea);
        if (now.isBefore(firstGrid) || now.isAfter(calendar.closeInstant(session).plus(AFTER_CLOSE))) {
            return Outcome.skip(code, mode.name(), "판정 창 밖");
        }
        MarketState state = states.computeIfAbsent(code, k -> new MarketState());
        if (!session.equals(state.session)) {
            state.session = session;
            state.lastGrid = null;
            state.lastFetched = null;
            state.lateNoted = false;
            state.shadowSeen.clear();
            state.guardSeen.clear();
        }
        Instant started = now;
        Optional<Snapshot> found = reader.quietly(() -> marketData.stopWatch(korea));
        Snapshot snapshot = found.orElse(null);
        Instant fetched = snapshot == null ? null : instant(Json.asText(snapshot.payload(), "fetchedAt"));
        boolean fresh = fetched != null && snapshot.collectedAt() != null
                && !snapshot.collectedAt().isBefore(now.minusSeconds(Datasets.MAX_AGE_STOPWATCH))
                && !fetched.isBefore(calendar.openInstant(session));
        if (!fresh) {
            String late = null;
            if (!state.lateNoted && now.isAfter(firstGrid.plus(LATE)) && !now.isAfter(end)) {
                state.lateNoted = true;
                late = "감시 저장본이 " + LATE.toMinutes() + "분 넘게 늦음(" + (snapshot == null ? "없음"
                        : "마지막 " + com.macrodash.Kst.stamp(snapshot.collectedAt())) + ") — 대체 경로(시간별·밤 스탑)가 지킴";
                Outcome outcome = new Outcome(code, mode.name(), null, List.of(), List.of(), List.of(), List.of(), late, null);
                record(definition, started, outcome);
                return outcome;
            }
            return Outcome.skip(code, mode.name(), "새 감시 저장본 없음");
        }
        String fetchedText = fetched.toString();
        if (fetchedText.equals(state.lastFetched)) {
            return Outcome.skip(code, mode.name(), "이미 본 저장본");
        }
        List<Instant> grids = new ArrayList<>();
        for (Instant g : StopWatch.grids(calendar, session, korea)) {
            if (!g.isBefore(firstGrid) && !g.isAfter(fetched) && (state.lastGrid == null || g.isAfter(state.lastGrid))) {
                grids.add(g);
            }
        }
        if (state.lastGrid == null && grids.size() > 1) {
            grids = List.of(grids.get(grids.size() - 1));   // 재기동 직후 — 가장 최근 격자만
        }
        state.lastFetched = fetchedText;
        if (grids.isEmpty()) {
            return Outcome.skip(code, mode.name(), "판정할 새 격자 없음");
        }
        JsonNode payload = snapshot.payload();
        List<Map<String, Object>> orders = new ArrayList<>();
        List<Map<String, Object>> would = new ArrayList<>();
        List<Map<String, Object>> guards = new ArrayList<>();
        List<Instant> judged = grids;
        ledger.exclusively(() -> {
            for (Book book : store.books(code)) {
                if (!PaperBooks.ACTIVE.equals(book.status()) || PaperBooks.KIND_BENCHMARK.equals(book.kind())) {
                    continue;
                }
                store.atomically(() -> {
                    judgeBook(run, book, korea, mode, session, judged, payload, fetched, state, orders, would, guards);
                    return null;
                });
            }
            return null;
        });
        state.lastGrid = grids.get(grids.size() - 1);
        Outcome outcome = new Outcome(code, mode.name(), null, grids, orders, would, guards, null, null);
        if (!orders.isEmpty() || !would.isEmpty() || !guards.isEmpty()) {
            record(definition, started, outcome);
        }
        return outcome;
    }

    /** 책 하나(트랜잭션 안) — 보유마다 판정하고 ON이면 STOP을 냅니다(클래스 설명). */
    private void judgeBook(MarketRun run, Book book, boolean korea, StopWatchMode mode, LocalDate session, List<Instant> grids,
                           JsonNode payload, Instant fetched, MarketState state, List<Map<String, Object>> orders,
                           List<Map<String, Object>> would, List<Map<String, Object>> guards) {
        TradingCalendar calendar = run.calendar();
        PaperSettings settings = run.settings();
        double stopPct = settings.trailingStopPct();
        List<Position> positions = store.positions(book.code());
        if (positions.isEmpty()) {
            return;
        }
        List<Order> pending = store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING);
        Set<String> stopPending = new TreeSet<>();
        for (Order order : pending) {
            if (PaperBooks.SOURCE_STOP.equals(order.source()) && PaperBooks.SELL.equals(order.side())) {
                stopPending.add(order.ticker());
            }
        }
        Set<String> held = new HashSet<>();
        if (korea) {
            store.corpActionHolds(book.code()).forEach(hold -> held.add(hold.ticker()));
        }
        KrConfirmed confirmed = korea ? confirmed(run, positions, settings) : KrConfirmed.NONE;
        LocalDate previous = calendar.previousTradingDay(session);
        for (Position position : positions) {
            String ticker = position.ticker();
            if (position.qty() <= 0 || settings.cashLike(ticker) || held.contains(ticker)) {
                continue;
            }
            JsonNode entry = Json.child(Json.child(payload, "tickers"), ticker);
            if (!StopWatch.usable(entry, session)) {
                continue;
            }
            Double ledgerPrev = previous.equals(position.fillRefDate()) ? position.fillRefClose() : null;
            StopWatch.Guard guard = StopWatch.guard(entry, korea, ledgerPrev);
            if (guard.guarded()) {
                if (state.guardSeen.add(book.code() + "|" + ticker)) {
                    guards.add(row(book, ticker, Map.of("reason", guard.reason())));
                }
                continue;
            }
            if (!guard.known()) {
                continue;
            }
            double watermark = korea ? krWatermark(position, confirmed.of(ticker), session) : position.highWatermark();
            double stopPrice = TrailingStop.stopPrice(watermark, stopPct);
            StopWatch.Evaluation hit = null;
            for (Instant g : grids) {
                StopWatch.Evaluation e = StopWatch.evaluate(entry, g, stopPrice, session, calendar, korea);
                if (e.verdict() == StopWatch.Verdict.TRIGGER) {
                    hit = e;
                    break;
                }
            }
            if (hit == null || stopPending.contains(ticker)) {
                continue;
            }
            Instant now = clock.instant();
            StopWatch.Target target = StopWatch.target(now, session, calendar, korea);
            if (fullSellBefore(pending, ticker, target.at(), calendar, korea)) {
                continue;
            }
            Map<String, Object> reason = reason(stopPct, watermark, position.highWatermark(), stopPrice, hit, fetched, now, target,
                    calendar, korea, session);
            Map<String, Object> view = row(book, ticker, Map.of("stopPrice", PaperLedger.round4(stopPrice),
                    "grid", hit.current().grid().toString(), "prices", List.of(hit.previous().price(), hit.current().price()),
                    "timing", target.timing(), "targetAt", target.at().toString()));
            if (!mode.orders()) {
                if (state.shadowSeen.add(book.code() + "|" + ticker)) {
                    would.add(view);
                }
                continue;
            }
            long id = store.insertOrder(new Order(0, book.code(), null, ticker, PaperBooks.SELL, null, null, null, target.timing(),
                    PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, mapper.valueToTree(reason), previous, now, session, null,
                    target.targetLocal()));
            stopPending.add(ticker);
            Map<String, Object> placed = new LinkedHashMap<>(view);
            placed.put("orderId", id);
            orders.add(placed);
        }
    }

    /** 한국 보유들의 금융위 확정 시세(최고가 보정용) — 가장 이른 since부터. */
    private KrConfirmed confirmed(MarketRun run, List<Position> positions, PaperSettings settings) {
        LocalDate from = null;
        Set<String> codes = new TreeSet<>();
        for (Position position : positions) {
            codes.add(position.ticker());
            if (position.fillRefDate() != null && (from == null || position.fillRefDate().isBefore(from))) {
                from = position.fillRefDate();
            }
        }
        return run.confirmedPrices(marketData, codes, settings, from);
    }

    /**
     * 한국 유효 최고가 — 저장된 최고가와 장부가 최고가를 올리는 규칙의 금융위 확정 종가(그 세션 전날까지) 가운데 큰 값(클래스 설명). 계산만 하고 쓰지
     * 않습니다(최고가를 쓰는 곳은 장부 하나).
     */
    static double krWatermark(Position position, KrConfirmed.Series series, LocalDate session) {
        double watermark = position.highWatermark();
        LocalDate from = PaperLedgerService.watermarkFrom(position.fillRefDate(), position.openedOn(), position.splitNote(),
                series.datasetLatest());
        if (from == null) {
            return watermark;
        }
        for (KrConfirmed.Day day : series.observedFrom(from)) {
            if (day.date().isBefore(session) && day.close() != null) {
                watermark = TrailingStop.raiseWatermark(watermark, day.close().doubleValue());
            }
        }
        return watermark;
    }

    /**
     * 같은 종목의 전량 매도 대기 주문이 이 STOP의 기준 시각 이전에 체결될 차례인가(그 주문의 기준 시각을 알 때만 — 다음 관측치처럼 시각을 모르는 시점은
     * 아님). 그렇다면 STOP을 내지 않습니다(그 주문이 먼저 다 팜).
     */
    static boolean fullSellBefore(List<Order> pending, String ticker, Instant stopAt, TradingCalendar calendar, boolean korea) {
        for (Order order : pending) {
            if (!ticker.equals(order.ticker()) || !PaperBooks.SELL.equals(order.side()) || order.qty() != null
                    || (order.sellFraction() != null && order.sellFraction() < 1.0)) {
                continue;
            }
            LocalDate target = ExecutionAudit.targetSession(order, calendar);
            if (target == null) {
                continue;
            }
            Instant at = korea ? KrTimedLadder.targetOn(order, target, calendar) : ExecutionAudit.targetAt(order, target, calendar);
            if (at == null && PaperBooks.NEXT_OPEN.equals(order.timing())) {
                at = calendar.openInstant(target);
            }
            if (at != null && !at.isAfter(stopAt)) {
                return true;
            }
        }
        return false;
    }

    private Map<String, Object> reason(double stopPct, double watermark, double stored, double stopPrice, StopWatch.Evaluation hit,
                                       Instant fetched, Instant now, StopWatch.Target target, TradingCalendar calendar, boolean korea,
                                       LocalDate session) {
        Map<String, Object> reason = new LinkedHashMap<>();
        reason.put("trigger", "TRAILING_STOP");
        reason.put("stopMode", STOP_MODE);
        reason.put("stopPct", stopPct);
        reason.put("highWatermark", PaperLedger.round4(watermark));
        reason.put("storedHighWatermark", PaperLedger.round4(stored));
        reason.put("stopPrice", PaperLedger.round4(stopPrice));
        reason.put("observedPrice", hit.current().price());
        reason.put("barDate", session.toString());
        List<Map<String, Object>> checks = new ArrayList<>();
        for (StopWatch.Check check : List.of(hit.previous(), hit.current())) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("grid", check.grid().toString());
            item.put("price", check.price());
            item.put("barAt", check.barAt() == null ? null : check.barAt().toString());
            checks.add(item);
        }
        reason.put("checks", checks);
        reason.put("watchFetchedAt", fetched.toString());
        reason.put("detectedAt", now.toString());
        reason.put("targetAt", target.at().toString());
        String zone = korea ? " KST" : " ET";
        String sell = PaperBooks.NEXT_CLOSE.equals(target.timing()) ? "그날 종가 매도"
                : clock(target.at(), calendar) + zone + (PaperBooks.AT_MINUTE.equals(target.timing()) ? " 지정 시각 매도" : " 시장가 매도");
        reason.put("note", "장중 감시 트레일링 스탑 −" + trim(stopPct) + "%: " + clock(hit.previous().grid(), calendar) + " " + trim(hit.previous().price())
                + " · " + clock(hit.current().grid(), calendar) + " " + trim(hit.current().price()) + zone + " 두 번 모두 스탑가 "
                + trim(PaperLedger.round4(stopPrice)) + "(최고가 " + trim(PaperLedger.round4(watermark)) + ") 이하 → " + sell);
        return reason;
    }

    private static Map<String, Object> row(Book book, String ticker, Map<String, Object> extra) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("book", book.code());
        out.put("ticker", ticker);
        out.putAll(extra);
        return out;
    }

    private void record(PaperMarket market, Instant started, Outcome outcome) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("market", outcome.market());
        detail.put("mode", outcome.mode());
        detail.put("grids", outcome.grids().stream().map(Instant::toString).toList());
        detail.put("orders", outcome.orders());
        detail.put("wouldStop", outcome.wouldStop());
        detail.put("guards", outcome.guards());
        detail.put("late", outcome.late());
        try {
            store.recordJobRun(market.jobName(JOB), started, clock.instant(), outcome.error() == null ? "OK" : "ERROR",
                    mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            log.warn("장중 스탑 감시 작업 기록 실패: {}", e.toString());
        }
    }

    private static Instant instant(String text) {
        if (text == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String clock(Instant at, TradingCalendar calendar) {
        LocalTime local = at.atZone(calendar.zone()).toLocalTime();
        return String.format(Locale.ROOT, "%02d:%02d", local.getHour(), local.getMinute());
    }

    private static String trim(double value) {
        return java.math.BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }
}
