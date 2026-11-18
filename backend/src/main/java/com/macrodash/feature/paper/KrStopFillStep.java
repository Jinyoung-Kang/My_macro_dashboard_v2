package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
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
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 한국 장중 감시 STOP 체결의 장중 단계(ADR 0045) — 장중 스탑 감시 작업({@link PaperStopWatchJob})이 20초마다 한국 판정 뒤에 부릅니다. 판정 쪽 조기 반환(이미 본
 * 저장본·판정할 새 격자 없음·판정 창 밖)과 상관없이 주기마다 돌고, 판정 쪽 예외가 이 단계를 막지 않습니다.
 *
 * <ul>
 *   <li><b>밤 뒤 대조</b>(시각과 상관없이): 근거 {@code intradayFill}(SHADOW)이 있고 아직 대조하지 않은 주문을 밤 장부가 닫았으면(체결·만료·취소) 밤 체결의
 *       관측가·출처·수량·관측일·설정 판과 견준 칸 {@code intradayFill.check}를 남깁니다({@link KrIntradayFill#check}). 장중에 적었을 것이 밤과 다르면(체결하지
 *       않음 {@value KrIntradayFill#NIGHT_NOT_FILLED} 포함) 운영 알림(건수·사유 코드 — 작업 기록 {@code alerts}와 경고 로그)입니다.</li>
 *   <li><b>평가</b>(유효 스위치 {@link KrStopFill#effective}가 SHADOW·ON이고 세션 S의 [첫 판정 격자, 마감) 동안): 대상 STOP({@link KrIntradayFill#candidate})
 *       가운데 G5 시각({@link KrIntradayFill#gateAt})이 지난 것만. 대상이 없으면 저장본을 읽지 않습니다. 감시 저장본으로 R1({@link KrIntradayFill#r1})을 고르고
 *       G2 장부 밀림({@link PaperMirrorService#ledgerCaughtUp} 그대로)·G3 시간 순서·G4 기업행위·체결 조건({@link KrFills#termsFor})을 모두 판정해 근거
 *       {@code intradayFill}을 그 주문에 한 번 남깁니다(SHADOW — 장부 그대로). R1이 아님이 굳었거나(라벨 T+1 봉이 완성됐는데 거래가 없음) 마감 1분 전까지 갖춰지지 않으면 {@value KrIntradayFill#NO_R1}으로 남깁니다.
 *       ON 장부 기록은 이 단계의 다음 판이 맡습니다(지금은 평가하지 않음).</li>
 *   <li><b>잠금</b>: 저장본·금융위 시장 구분·확정 시세·장부 밀림 판정은 장부 잠금({@link PaperLedgerService#exclusively}) 밖에서 읽고 셉니다. 잠금 안에서는
 *       책마다 한 트랜잭션으로 그 주문이 아직 대기이고 근거가 비었으며 보유 수량이 그대로인지만 다시 읽어, 바뀌었으면 버리고 아니면 씁니다 — 실제 매매의 선점이
 *       같은 잠금을 기다리므로 잠금을 쥔 시간을 줄이고 작업 기록에 남깁니다({@code lockMillis}).</li>
 *   <li><b>작업 기록</b>: {@code kr.}{@value #JOB} — 근거를 남겼거나 대조했거나 알림·오류가 있을 때만(20초마다 쌓이지 않음).</li>
 * </ul>
 *
 * <p>테이블은 백엔드 표({@code paper_orders} 근거)만 쓰고, 수집기 저장본·금융위 표는 {@link StoreReader#quietly}로 읽기만 합니다(ADR 0008). 날짜는 그 실행
 * 달력의 서울 날짜입니다({@code LocalDate.now()}를 쓰지 않음).
 */
final class KrStopFillStep {

    /** 작업 기록 이름 — 시장 접두어를 붙여 씁니다(한국 {@code kr.stopwatch.fill}). */
    static final String JOB = PaperStopWatchJob.JOB + ".fill";
    /** 대조할 주문을 찾는 기간(달력일, 주문을 만든 날부터) — 밤 처리가 며칠 밀려도 닫힌 뒤 대조하게. */
    static final int CHECK_DAYS = 14;
    /** 마감 이만큼 전부터는 R1을 못 찾은 대상을 {@value KrIntradayFill#NO_R1}으로 남김(SHADOW 통계 — 그 STOP은 밤이 맡음). */
    static final Duration GIVE_UP_BEFORE_CLOSE = Duration.ofMinutes(1);

    private static final Logger log = LoggerFactory.getLogger(KrStopFillStep.class);

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final PaperMarkets markets;
    private final PaperMirrorService mirror;

    /**
     * 한 주기의 결과.
     *
     * @param skipped   평가하지 않은 사유(스위치 꺼짐·창 밖·대상 없음 …) — 평가했으면 null
     * @param recorded  이번에 근거를 남긴 주문
     * @param checks    이번에 밤 결과와 견준 주문
     * @param alerts    운영 알림(건수·사유 코드)
     * @param lockMillis 장부 잠금을 쥔 시간(밀리초 — 잠금을 쓰지 않았으면 null)
     */
    record Outcome(String skipped, List<Map<String, Object>> recorded, List<Map<String, Object>> checks, List<String> alerts,
                   Long lockMillis, String error) {
    }

    KrStopFillStep(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger, PaperConfig config,
                   ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = markets;
        this.mirror = new PaperMirrorService(store, reader, marketData, markets, ledger, clock);
    }

    /** 한 주기(클래스 설명) — 한국 시장 묶음만 받습니다. 예외는 결과의 {@code error}로(기록에 실패하면 로그만). */
    Outcome run(PaperMarket definition) {
        if (!store.ready()) {
            return skip("모의 매매 테이블이 아직 없습니다");
        }
        if (definition.dormantReason(config, () -> store.books(definition.code())) != null) {
            return skip("그 시장이 정기 작업을 쉼");
        }
        Instant started = clock.instant();
        List<Map<String, Object>> recorded = new ArrayList<>();
        List<Map<String, Object>> checks = new ArrayList<>();
        List<String> alerts = new ArrayList<>();
        long[] lockMillis = {-1};
        String skipped = null;
        String error = null;
        String mode = null;
        try {
            checkAfterNight(definition, started, checks, alerts, lockMillis);
            // 스위치를 먼저 봅니다 — 유효 값 OFF(기본)면 실행(달력·공휴일 저장본)을 열지 않습니다(20초마다 하루 종일 도는 단계).
            KrStopFill fill = KrStopFill.effective(store.settings().map(PaperStore.SettingsRow::body).orElse(null));
            mode = fill.name();
            if (fill.evaluates()) {
                MarketRun run = markets.open(definition);
                KrStopFill current = KrStopFill.effective(run.settingsBody());
                mode = current.name();
                skipped = current.evaluates() ? evaluate(run, current, started, recorded, lockMillis)
                        : "스위치 꺼짐(" + KrStopFill.KEY + " 유효 값 OFF)";
            } else {
                skipped = "스위치 꺼짐(" + KrStopFill.KEY + " 유효 값 OFF)";
            }
        } catch (CalendarUnavailableException e) {
            skipped = CalendarGaps.NO_CALENDAR + " — " + e.getMessage();
        } catch (RuntimeException e) {
            error = e.toString();
        }
        Long held = lockMillis[0] < 0 ? null : lockMillis[0];
        Outcome outcome = new Outcome(skipped, List.copyOf(recorded), List.copyOf(checks), List.copyOf(alerts), held, error);
        if (!recorded.isEmpty() || !checks.isEmpty() || !alerts.isEmpty() || error != null) {
            if (!alerts.isEmpty()) {
                log.warn("한국 장중 스탑 체결 대조 운영 알림: {}", alerts);
            }
            record(definition, mode, started, outcome);
        }
        return outcome;
    }

    private static Outcome skip(String reason) {
        return new Outcome(reason, List.of(), List.of(), List.of(), null, null);
    }

    // ------------------------------------------------------------------ 평가
    /** 대상을 모아 잠금 밖에서 판정하고, 잠금 안에서 다시 확인해 근거를 씁니다. 평가하지 않았으면 그 사유, 했으면 null. */
    private String evaluate(MarketRun run, KrStopFill fill, Instant now, List<Map<String, Object>> recorded, long[] lockMillis) {
        TradingCalendar calendar = run.calendar();
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        if (!calendar.isTradingDay(session)) {
            return "거래일 아님";
        }
        Instant close = calendar.closeInstant(session);
        if (now.isBefore(StopWatch.firstJudgedGrid(calendar, session)) || !now.isBefore(close)) {
            return "기록 창 밖";
        }
        if (fill.records()) {
            return "ON 장부 기록은 이 판에 없음 — 평가하지 않음(밤 장부가 체결)";
        }
        boolean giveUp = !now.isBefore(close.minus(GIVE_UP_BEFORE_CLOSE));
        Map<String, List<Order>> pendingByBook = new LinkedHashMap<>();
        Map<String, List<Order>> due = new LinkedHashMap<>();
        for (Book book : store.books(run.code())) {
            if (!PaperBooks.ACTIVE.equals(book.status()) || PaperBooks.KIND_BENCHMARK.equals(book.kind())) {
                continue;
            }
            List<Order> pending = store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING);
            List<Order> mine = new ArrayList<>();
            for (Order o : pending) {
                if (KrIntradayFill.candidate(o, session, calendar) && !hasRecord(o)
                        && !now.isBefore(KrIntradayFill.gateAt(calendar, session, KrTimedLadder.targetOn(o, session, calendar)))) {
                    mine.add(o);
                }
            }
            if (!mine.isEmpty()) {
                pendingByBook.put(book.code(), pending);
                due.put(book.code(), mine);
            }
        }
        if (due.isEmpty()) {
            return "기록할 대상 없음";
        }
        JsonNode payload = reader.quietly(() -> marketData.stopWatch(true)).map(Snapshot::payload).orElse(null);
        // R1을 먼저 셉니다(저장본만) — 갖춰진 대상이 없으면 금융위·확정 시세·장부 밀림을 읽지 않습니다(R1을 기다리는 몇 분 동안 20초마다 읽지 않게).
        Map<String, Map<Long, KrIntradayFill.R1>> ready = new LinkedHashMap<>();
        for (Map.Entry<String, List<Order>> entry : due.entrySet()) {
            Map<Long, KrIntradayFill.R1> mine = new LinkedHashMap<>();
            for (Order o : entry.getValue()) {
                KrIntradayFill.R1 r1 = KrIntradayFill.r1(o, Json.child(Json.child(payload, "tickers"), o.ticker()), session, calendar);
                if (r1.found() || r1.decided() || giveUp) {
                    mine.put(o.id(), r1);   // 갖춰짐 — R1이거나 R1이 아님이 굳었거나 마감 1분 전(그 밖은 다음 저장본을 기다림)
                }
            }
            if (!mine.isEmpty()) {
                ready.put(entry.getKey(), mine);
            }
        }
        if (ready.isEmpty()) {
            return "R1 자료를 기다림";
        }
        PaperSettings settings = run.settings();
        LocalDate previous = calendar.previousTradingDay(session);
        Set<String> codes = new TreeSet<>();
        due.forEach((book, list) -> list.forEach(o -> {
            if (ready.getOrDefault(book, Map.of()).containsKey(o.id())) {
                codes.add(o.ticker());
            }
        }));
        Map<String, String> read = reader.quietly(() -> marketData.fscMarkets(codes));
        Map<String, String> fscMarkets = read == null ? Map.of() : read;
        Map<String, List<Evaluation>> evaluations = new LinkedHashMap<>();
        for (Map.Entry<String, List<Order>> entry : due.entrySet()) {
            String code = entry.getKey();
            Map<Long, KrIntradayFill.R1> mineReady = ready.get(code);
            if (mineReady == null) {
                continue;
            }
            Map<String, Position> positions = new TreeMap<>();
            store.positions(code).forEach(p -> positions.put(p.ticker(), p));
            Set<String> holds = new TreeSet<>();
            store.corpActionHolds(code).forEach(h -> holds.add(h.ticker()));
            Map<String, Long> refVolumes = store.fillRefVolumes(code);
            List<Order> mineOrders = entry.getValue().stream().filter(o -> mineReady.containsKey(o.id())).toList();
            LocalDate from = null;
            for (Order o : mineOrders) {
                Position p = positions.get(o.ticker());
                if (p != null && p.fillRefDate() != null && (from == null || p.fillRefDate().isBefore(from))) {
                    from = p.fillRefDate();
                }
            }
            LocalDate since = from;
            Set<String> mine = new TreeSet<>();
            mineOrders.forEach(o -> mine.add(o.ticker()));
            KrConfirmed confirmed = reader.quietly(() -> run.confirmedPrices(marketData, mine, settings, since));
            boolean caughtUp = mirror.ledgerCaughtUp(code, session);
            List<Evaluation> out = new ArrayList<>();
            for (Order o : mineOrders) {
                JsonNode watched = Json.child(Json.child(payload, "tickers"), o.ticker());
                out.add(evaluateOne(run, o, mineReady.get(o.id()), positions.get(o.ticker()), refVolumes.get(o.ticker()), holds.contains(o.ticker()), watched,
                        confirmed == null ? KrConfirmed.Series.UNKNOWN : confirmed.of(o.ticker()), pendingByBook.get(code), fscMarkets,
                        session, previous, caughtUp, fill, now));
            }
            if (!out.isEmpty()) {
                evaluations.put(code, out);
            }
        }
        long lockStarted = System.nanoTime();
        ledger.exclusively(() -> {
            long acquired = System.nanoTime();
            for (Map.Entry<String, List<Evaluation>> entry : evaluations.entrySet()) {
                store.atomically(() -> {
                    Map<String, Integer> qty = new HashMap<>();
                    store.positions(entry.getKey()).forEach(p -> qty.put(p.ticker(), p.qty()));
                    for (Evaluation e : entry.getValue()) {
                        Order current = store.order(e.order().id()).orElse(null);
                        Integer held = qty.get(e.order().ticker());
                        if (current == null || !PaperBooks.ORDER_PENDING.equals(current.status()) || hasRecord(current)
                                || !java.util.Objects.equals(held, e.heldQty())) {
                            continue;   // 그사이 밤 처리·취소·다른 기록 — 버림(다음 주기에 다시 봄)
                        }
                        store.updateOrderReason(current.id(), withRecord(current, e.record()));
                        recorded.add(summary(entry.getKey(), current, e.record()));
                    }
                    return null;
                });
            }
            lockMillis[0] = Math.max(lockMillis[0], 0) + Duration.ofNanos(System.nanoTime() - acquired).toMillis();
            return null;
        });
        log.debug("한국 장중 스탑 체결 평가 — 잠금 대기 포함 {}ms", Duration.ofNanos(System.nanoTime() - lockStarted).toMillis());
        return null;
    }

    /** 대상 하나의 판정 — 근거 칸과 그때의 보유 수량(잠금 안에서 그대로인지 다시 봄). */
    private record Evaluation(Order order, Map<String, Object> record, Integer heldQty) {
    }

    private Evaluation evaluateOne(MarketRun run, Order order, KrIntradayFill.R1 r1, Position position, Long refVolume, boolean corpHold,
                                   JsonNode watched, KrConfirmed.Series fsc, List<Order> pending, Map<String, String> fscMarkets,
                                   LocalDate session, LocalDate previous, boolean caughtUp, KrStopFill fill, Instant now) {
        TradingCalendar calendar = run.calendar();
        PaperSettings settings = run.settings();
        Instant target = KrTimedLadder.targetOn(order, session, calendar);
        List<String> reasons = new ArrayList<>();
        if (!r1.found()) {
            reasons.add(KrIntradayFill.NO_R1);
        }
        if (!caughtUp) {
            reasons.add(KrIntradayFill.LEDGER_BEHIND);
        }
        reasons.addAll(KrIntradayFill.orderGate(order, pending, session));
        boolean held = position != null && position.qty() > 0;
        if (!held) {
            reasons.add(KrIntradayFill.NO_POSITION);
        } else {
            reasons.addAll(KrIntradayFill.corpGate(position, refVolume, corpHold, watched, fsc, session, previous,
                    KrPaperMarket.etf(order.ticker(), settings)));
        }
        FillTerms.Costs costs = null;
        Integer qty = held ? PaperLedger.sellQty(position.qty(), null) : null;
        if (r1.found()) {
            String market = fscMarkets.get(order.ticker());
            FillTerms terms = KrFills.termsFor(PaperLedger.Side.SELL, order.ticker(), r1.choice(), market, settings,
                    KrPaperMarket.BENCHMARK_TICKERS);
            if (terms.holdReason() != null) {
                reasons.add(market == null && !KrPaperMarket.etf(order.ticker(), settings) ? KrIntradayFill.NO_FSC_MARKET
                        : KrIntradayFill.HOLD);
            } else if (qty != null && qty > 0) {
                costs = terms.costs(qty);
            }
        }
        Map<String, Object> record = new LinkedHashMap<>();
        record.put(KrIntradayFill.MODE, fill.name());
        record.put(KrIntradayFill.EVALUATED_AT, now.toString());
        record.put(KrIntradayFill.OUTCOME, reasons.isEmpty() ? KrIntradayFill.RECORD : KrIntradayFill.DEFER);
        record.put(KrIntradayFill.REASONS, reasons);
        record.put(KrIntradayFill.SNAPSHOT_FETCHED_AT, r1.fetchedAt() == null ? null : r1.fetchedAt().toString());
        record.put(KrIntradayFill.TARGET_AT, target == null ? null : target.toString());
        record.put(KrIntradayFill.BAR_LABEL, r1.barLabel());
        record.put(KrIntradayFill.RAW_PRICE, r1.found() ? r1.choice().price() : null);
        record.put(KrIntradayFill.VOLUME, r1.volume());
        record.put(KrIntradayFill.PRICE_SOURCE, r1.found() ? r1.choice().source() : null);
        record.put(KrIntradayFill.QTY, qty);
        record.put(KrIntradayFill.CASH_DELTA, costs == null ? null : costs.cashDelta());
        record.put(KrIntradayFill.FEE, costs == null ? null : costs.fee());
        record.put(KrIntradayFill.TAX, costs == null ? null : costs.tax());
        record.put(KrIntradayFill.SLIPPAGE_COST, costs == null ? null : costs.slippageCost());
        record.put(KrIntradayFill.SETTINGS_VERSION, run.settingsVersion());
        record.put(KrIntradayFill.GATE_AT, target == null ? null : KrIntradayFill.gateAt(calendar, session, target).toString());
        if (!r1.found() && r1.reason() != null) {
            record.put("note", r1.reason());
        }
        return new Evaluation(order, record, held ? position.qty() : null);
    }

    // ------------------------------------------------------------------ 밤 뒤 대조
    /** 밤 장부가 닫은 SHADOW 근거 주문을 밤 결과와 견줍니다(클래스 설명). */
    private void checkAfterNight(PaperMarket definition, Instant now, List<Map<String, Object>> checks, List<String> alerts,
                                 long[] lockMillis) {
        Map<String, List<Order>> byBook = new LinkedHashMap<>();
        for (Book book : store.books(definition.code())) {
            List<Order> due = store.intradayFillsToCheck(book.code(), CHECK_DAYS).stream()
                    .filter(o -> KrStopFill.SHADOW.name().equals(Json.asText(Json.child(o.reason(), KrIntradayFill.FIELD), KrIntradayFill.MODE)))
                    .toList();
            if (!due.isEmpty()) {
                byBook.put(book.code(), due);
            }
        }
        if (byBook.isEmpty()) {
            return;
        }
        Map<Long, Map<String, Object>> results = new LinkedHashMap<>();
        Map<String, Integer> mismatches = new TreeMap<>();
        for (Map.Entry<String, List<Order>> entry : byBook.entrySet()) {
            Map<Long, Fill> fills = new HashMap<>();
            store.fillsForOrders(entry.getValue().stream().map(Order::id).toList()).forEach(f -> fills.put(f.fill().orderId(), f.fill()));
            for (Order order : entry.getValue()) {
                Fill fill = fills.get(order.id());
                Integer version = fill == null || fill.createdAt() == null ? null
                        : store.settingsInForceAt(fill.createdAt()).map(PaperStore.SettingsRow::version).orElse(null);
                JsonNode record = Json.child(order.reason(), KrIntradayFill.FIELD);
                Map<String, Object> check = KrIntradayFill.check(record, order, fill, version, now);
                results.put(order.id(), check);
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("book", entry.getKey());
                row.put("orderId", order.id());
                row.put("ticker", order.ticker());
                row.put("match", check.get("match"));
                row.put(KrIntradayFill.REASONS, check.get(KrIntradayFill.REASONS));
                checks.add(row);
                if (Boolean.FALSE.equals(check.get("match"))) {
                    for (Object code : (List<?>) check.get(KrIntradayFill.REASONS)) {
                        mismatches.merge(String.valueOf(code), 1, Integer::sum);
                    }
                }
            }
        }
        ledger.exclusively(() -> {
            long acquired = System.nanoTime();
            store.atomically(() -> {
                for (Map.Entry<Long, Map<String, Object>> entry : results.entrySet()) {
                    Order current = store.order(entry.getKey()).orElse(null);
                    JsonNode record = current == null ? null : Json.child(current.reason(), KrIntradayFill.FIELD);
                    if (record == null || record.has(KrIntradayFill.CHECK) || PaperBooks.ORDER_PENDING.equals(current.status())) {
                        continue;
                    }
                    ObjectNode reason = (ObjectNode) current.reason().deepCopy();
                    ((ObjectNode) reason.get(KrIntradayFill.FIELD)).set(KrIntradayFill.CHECK, mapper.valueToTree(entry.getValue()));
                    store.updateOrderReason(current.id(), reason);
                }
                return null;
            });
            lockMillis[0] = Math.max(lockMillis[0], 0) + Duration.ofNanos(System.nanoTime() - acquired).toMillis();
            return null;
        });
        long mismatched = checks.stream().filter(c -> Boolean.FALSE.equals(c.get("match"))).count();
        if (mismatched > 0) {
            alerts.add("장중 체결 대조 불일치 " + mismatched + "건 — 사유 " + mismatches);
        }
    }

    // ------------------------------------------------------------------ 보조
    private static boolean hasRecord(Order order) {
        return order.reason() != null && order.reason().has(KrIntradayFill.FIELD);
    }

    private ObjectNode withRecord(Order order, Map<String, Object> record) {
        ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy() : mapper.createObjectNode();
        reason.set(KrIntradayFill.FIELD, mapper.valueToTree(record));
        return reason;
    }

    private static Map<String, Object> summary(String book, Order order, Map<String, Object> record) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("book", book);
        out.put("orderId", order.id());
        out.put("ticker", order.ticker());
        out.put(KrIntradayFill.OUTCOME, record.get(KrIntradayFill.OUTCOME));
        out.put(KrIntradayFill.REASONS, record.get(KrIntradayFill.REASONS));
        out.put(KrIntradayFill.BAR_LABEL, record.get(KrIntradayFill.BAR_LABEL));
        out.put(KrIntradayFill.RAW_PRICE, record.get(KrIntradayFill.RAW_PRICE));
        return out;
    }

    private void record(PaperMarket definition, String mode, Instant started, Outcome outcome) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("market", definition.code());
        detail.put("mode", mode);
        detail.put("recorded", outcome.recorded());
        detail.put("checks", outcome.checks());
        detail.put("alerts", outcome.alerts());
        detail.put("lockMillis", outcome.lockMillis());
        detail.put("skipped", outcome.skipped());
        detail.put("error", outcome.error());
        try {
            store.recordJobRun(definition.jobName(JOB), started, clock.instant(), outcome.error() == null ? "OK" : "ERROR",
                    mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            log.warn("한국 장중 스탑 체결 작업 기록 실패({}): {}", Kst.stamp(started), e.toString());
        }
    }
}
