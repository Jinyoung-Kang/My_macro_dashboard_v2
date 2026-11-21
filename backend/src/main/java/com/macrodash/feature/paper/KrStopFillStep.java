package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
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
 *       관측가·출처·수량·관측일·비용·설정 판과 견준 칸 {@code intradayFill.check}를 남깁니다({@link KrIntradayFill#check}). 장중에 적었을 것이 밤과 다르면(체결하지
 *       않음 {@value KrIntradayFill#NIGHT_NOT_FILLED} 포함) 운영 알림(건수·사유 코드 — 작업 기록 {@code alerts}와 경고 로그)입니다.</li>
 *   <li><b>평가</b>(유효 스위치 {@link KrStopFill#effective}가 SHADOW·ON이고 세션 S의 [첫 판정 격자, 마감) 동안): 대상 STOP({@link KrIntradayFill#candidate})
 *       가운데 G5 시각({@link KrIntradayFill#gateAt})이 지난 것만. 대상이 없으면 저장본을 읽지 않습니다. 감시 저장본으로 R1({@link KrIntradayFill#r1})을 고르고
 *       G2 장부 밀림({@link PaperMirrorService#ledgerCaughtUp} 그대로)·G3 시간 순서·G4 기업행위·체결 조건({@link KrFills#termsFor})을 모두 판정해 근거
 *       {@code intradayFill}을 그 주문에 한 번 남깁니다(SHADOW — 장부 그대로). R1이 아님이 굳었거나(라벨 T+1 봉이 완성됐는데 거래가 없음) 마감 1분 전까지 갖춰지지 않으면 {@value KrIntradayFill#NO_R1}으로 남깁니다.
 *       ON이면 관문을 모두 지난 R1 체결을 그 책 한 트랜잭션에 기준 시각 순으로 장부에 적습니다({@link #writeOn} — 체결 행·대기일 때만 체결로 바꾸는
 *       갱신·보유 삭제·재진입 금지·밤과 같은 판정 근거 칸·상태 현금과 평가 네 칸, 마지막 관측·처리 시각과 순자산 줄은 그대로). 미룬 STOP은 대기 그대로라 그날
 *       밤 장부가 지금처럼 체결하고, 미룬 사유는 작업 기록에만 처음 한 번 남깁니다(같은 저장본으로는 다시 판정하지 않음 — 다음 감시 저장본에서 다시).</li>
 *   <li><b>사후 점검</b>(ON — {@link #postCheckOn}): 장중 기록 STOP 세션의 밤 처리 뒤 첫 주기에, 밤 일괄이었다면 그 STOP을 체결했을지를 같은 함수로 다시
 *       봅니다(그 밤 관측치의 체결 봉 고르기·체결 조건, 기업행위 판정, 기록 뒤 일시정지, 그 세션 자료를 처리하지 않고 넘어감). 결과는 근거
 *       {@code intradayFill.check}(기업행위면 {@code postCheck}도)에 남기고, 다르면 운영 알림(건수·사유 코드)입니다 — 되돌리지는 않습니다.</li>
 *   <li><b>잠금</b>: 저장본·금융위 시장 구분·확정 시세·장부 밀림 판정은 장부 잠금({@link PaperLedgerService#exclusively}) 밖에서 읽고 셉니다. 잠금 안에서는
 *       책마다 한 트랜잭션으로 그 주문이 아직 대기이고 근거가 비었으며 보유 수량이 그대로인지만 다시 읽어, 바뀌었으면 버리고 아니면 씁니다(ON은 그 책의 대기 주문
 *       번호와 마지막 처리 저장본도 — 저장본은 그 책 판정 입력보다 먼저 읽은 값이라 잠금 밖 판정 중에 끼어든 밤 장부 처리도 버림) — 실제 매매의 선점이
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
    /** ON — 주문 번호 → 미룬 저장본 시각과 사유('저장본|사유' — 같은 저장본으로는 다시 판정하지 않고, 사유는 바뀔 때만 작업 기록에). 재기동하면 비어 한 번 더 남김. */
    private final Map<Long, String> onDeferred = new java.util.concurrent.ConcurrentHashMap<>();
    /** ON 사후 점검 — 밤 사다리가 기다림이던 주문(다음 세션 관측치가 오면 '밤이 체결하지 않음'으로 셈). */
    private final Set<Long> nightWaiting = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * 한 주기의 결과.
     *
     * @param skipped   평가하지 않은 사유(스위치 꺼짐·창 밖·대상 없음 …) — 평가했으면 null
     * @param recorded  이번에 근거를 남긴 주문(ON이면 장부에 적은 주문)
     * @param deferred  ON — 이번에 처음(또는 사유가 바뀌어) 밤에 맡긴 주문과 사유
     * @param checks    이번에 밤 결과와 견준 주문
     * @param alerts    운영 알림(건수·사유 코드)
     * @param lockMillis 장부 잠금을 쥔 시간(밀리초 — 잠금을 쓰지 않았으면 null)
     */
    record Outcome(String skipped, List<Map<String, Object>> recorded, List<Map<String, Object>> deferred, List<Map<String, Object>> checks,
                   List<String> alerts, Long lockMillis, String error) {
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
        List<Map<String, Object>> deferred = new ArrayList<>();
        List<String> bookErrors = new ArrayList<>();
        List<Map<String, Object>> checks = new ArrayList<>();
        List<String> alerts = new ArrayList<>();
        long[] lockMillis = {-1};
        String skipped = null;
        String error = null;
        String mode = null;
        try {
            // 대조할 주문은 책마다 한 번만 읽어 SHADOW 대조와 ON 사후 점검이 나눠 씁니다(20초마다 도는 읽기).
            Map<String, List<Order>> toCheck = new LinkedHashMap<>();
            for (Book book : store.books(definition.code())) {
                List<Order> due = store.intradayFillsToCheck(book.code(), CHECK_DAYS);
                if (!due.isEmpty()) {
                    toCheck.put(book.code(), due);
                }
            }
            checkAfterNight(toCheck, started, checks, alerts, lockMillis);
            postCheckOn(definition, toCheck, started, checks, alerts, lockMillis);
            // 스위치를 먼저 봅니다 — 유효 값 OFF(기본)면 실행(달력·공휴일 저장본)을 열지 않습니다(20초마다 하루 종일 도는 단계).
            KrStopFill fill = KrStopFill.effective(store.settings().map(PaperStore.SettingsRow::body).orElse(null));
            mode = fill.name();
            if (fill.evaluates()) {
                MarketRun run = markets.open(definition);
                KrStopFill current = KrStopFill.effective(run.settingsBody());
                mode = current.name();
                skipped = current.evaluates() ? evaluate(run, current, started, recorded, deferred, bookErrors, lockMillis)
                        : "스위치 꺼짐(" + KrStopFill.KEY + " 유효 값 OFF)";
            } else {
                skipped = "스위치 꺼짐(" + KrStopFill.KEY + " 유효 값 OFF)";
            }
        } catch (CalendarUnavailableException e) {
            skipped = CalendarGaps.NO_CALENDAR + " — " + e.getMessage();
        } catch (RuntimeException e) {
            error = e.toString();
        }
        if (error == null && !bookErrors.isEmpty()) {
            error = String.join("; ", bookErrors);   // 그 책만 되돌림(대기 그대로 — 밤 장부가 맡음), 다른 책의 기록은 그대로
        }
        Long held = lockMillis[0] < 0 ? null : lockMillis[0];
        Outcome outcome = new Outcome(skipped, List.copyOf(recorded), List.copyOf(deferred), List.copyOf(checks), List.copyOf(alerts), held,
                error);
        if (!recorded.isEmpty() || !deferred.isEmpty() || !checks.isEmpty() || !alerts.isEmpty() || error != null) {
            if (!alerts.isEmpty()) {
                log.warn("한국 장중 스탑 체결 대조 운영 알림: {}", alerts);
            }
            record(definition, mode, started, outcome);
        }
        return outcome;
    }

    private static Outcome skip(String reason) {
        return new Outcome(reason, List.of(), List.of(), List.of(), List.of(), null, null);
    }

    // ------------------------------------------------------------------ 평가
    /** 대상을 모아 잠금 밖에서 판정하고, 잠금 안에서 다시 확인해 근거를 씁니다. 평가하지 않았으면 그 사유, 했으면 null. */
    private String evaluate(MarketRun run, KrStopFill fill, Instant now, List<Map<String, Object>> recorded, List<Map<String, Object>> deferred,
                            List<String> bookErrors, long[] lockMillis) {
        TradingCalendar calendar = run.calendar();
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        if (!calendar.isTradingDay(session)) {
            return "거래일 아님";
        }
        Instant close = calendar.closeInstant(session);
        if (now.isBefore(StopWatch.firstJudgedGrid(calendar, session)) || !now.isBefore(close)) {
            return "기록 창 밖";
        }
        boolean giveUp = !fill.records() && !now.isBefore(close.minus(GIVE_UP_BEFORE_CLOSE));
        Map<String, List<Order>> pendingByBook = new LinkedHashMap<>();
        Map<String, List<Order>> due = new LinkedHashMap<>();
        Map<String, Instant> processedAt = new HashMap<>();
        for (Book book : store.books(run.code())) {
            if (!PaperBooks.ACTIVE.equals(book.status()) || PaperBooks.KIND_BENCHMARK.equals(book.kind())) {
                continue;
            }
            // 마지막 처리 저장본을 그 책의 판정 입력(대기 주문·보유·기업행위 표시·since 거래량·확정 시세·장부 밀림)보다 먼저 읽습니다 — 그 뒤 잠금 밖에서 밤 장부
            // 처리가 끼면 잠금 안 다시 확인(writeOn)이 이 값과 달라 그 책 기록을 버림(QA-790 — 늦게 읽으면 처리 뒤 값이라 오래된 판정이 통과).
            BookState seenState = store.state(book.code()).orElse(null);
            processedAt.put(book.code(), seenState == null ? null : seenState.lastProcessedCollectedAt());
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
        String payloadAt = Json.asText(payload, "fetchedAt");
        // R1을 먼저 셉니다(저장본만) — 갖춰진 대상이 없으면 금융위·확정 시세·장부 밀림을 읽지 않습니다(R1을 기다리는 몇 분 동안 20초마다 읽지 않게).
        Map<String, Map<Long, KrIntradayFill.R1>> ready = new LinkedHashMap<>();
        for (Map.Entry<String, List<Order>> entry : due.entrySet()) {
            Map<Long, KrIntradayFill.R1> mine = new LinkedHashMap<>();
            for (Order o : entry.getValue()) {
                KrIntradayFill.R1 r1 = KrIntradayFill.r1(o, Json.child(Json.child(payload, "tickers"), o.ticker()), session, calendar);
                if (fill.records()) {
                    // ON — R1일 때만 판정(같은 저장본으로 이미 미룬 주문은 다음 저장본에서 다시), R1이 아님이 굳었으면 밤에 맡김(대기 그대로).
                    String deferredAt = onDeferred.get(o.id());
                    if (r1.found() && (deferredAt == null || payloadAt == null || !deferredAt.startsWith(payloadAt + "|"))) {
                        mine.put(o.id(), r1);
                    } else if (!r1.found() && r1.decided()) {
                        noteDeferred(deferred, entry.getKey(), o, List.of(KrIntradayFill.NO_R1), payloadAt);
                    }
                } else if (r1.found() || r1.decided() || giveUp) {
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
        Map<String, Seen> seen = new LinkedHashMap<>();
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
                seen.put(code, new Seen(ids(pendingByBook.get(code)), processedAt.get(code)));
            }
        }
        long lockStarted = System.nanoTime();
        ledger.exclusively(() -> {
            long acquired = System.nanoTime();
            for (Map.Entry<String, List<Evaluation>> entry : evaluations.entrySet()) {
                if (fill.records()) {
                    List<Map<String, Object>> written = new ArrayList<>();
                    try {
                        store.atomically(() -> {
                            writeOn(run, entry.getKey(), entry.getValue(), seen.get(entry.getKey()), session, now, written, deferred, payloadAt);
                            return null;
                        });
                        recorded.addAll(written);
                    } catch (RuntimeException e) {
                        bookErrors.add(entry.getKey() + " 장중 기록 되돌림(대기 그대로 — 밤 장부가 맡음): " + e);
                    }
                    continue;
                }
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

    /**
     * 대상 하나의 판정 — 근거 칸과 그때의 보유 수량(잠금 안에서 그대로인지 다시 봄), ON 기록에 쓰는 체결 조건·보유·체결 관측 시각(감시 항목 수집 시각)·since
     * 봉 거래량.
     */
    private record Evaluation(Order order, Map<String, Object> record, Integer heldQty, FillTerms terms, Position position, Instant at,
                              Long refVolume) {

        boolean passed() {
            return KrIntradayFill.RECORD.equals(record.get(KrIntradayFill.OUTCOME));
        }

        @SuppressWarnings("unchecked")
        List<String> reasons() {
            return (List<String>) record.get(KrIntradayFill.REASONS);
        }
    }

    /**
     * 판정 때 본 그 책의 대기 주문 번호와 마지막 처리 저장본(판정 입력보다 먼저 읽은 값 — QA-790) — 잠금 안에서 바뀌었으면 그 책의 ON 기록을 버림(다음 주기에
     * 다시 판정).
     */
    private record Seen(Set<Long> pending, Instant processedAt) {
    }

    private static Set<Long> ids(List<Order> orders) {
        Set<Long> out = new TreeSet<>();
        if (orders != null) {
            orders.forEach(o -> out.add(o.id()));
        }
        return out;
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
        FillTerms usable = null;
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
                usable = terms;
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
        return new Evaluation(order, record, held ? position.qty() : null, usable, held ? position : null, r1.fetchedAt(), refVolume);
    }

    // ------------------------------------------------------------------ ON 장부 기록
    /**
     * ON — 그 책 한 트랜잭션(부르는 쪽이 장부 잠금과 {@link PaperStore#atomically} 안에서): 판정 때 본 대기 주문·마지막 처리 저장본이 그대로일 때만, 관문을 지난
     * STOP을 기준 시각 순(같으면 번호 순 — 밤 {@code processAuction}의 장중 시각 순과 같음)으로 적습니다. 주문마다 밤 {@code auctionSell}과 같은 칸: 체결 행
     * (관측 시각 = 감시 항목을 받은 시각, 관측일 = 그 세션, 출처 R1), 대기일 때만 체결로 바꿈(아니면 예외 — 이 책 기록 전체를 되돌림), 보유 삭제(전량),
     * 재진입 금지(체결한 날부터 — 밤 {@code stopLockout}과 같은 값·글), 근거(밤 {@code annotate}와 같은 판정 근거 칸·호가 경고 + {@code intradayFill} — 기록 시각·
     * 기록 직전 보유 사본·직전·직후 상태 현금). 현금은 밤처럼 체결마다 소수 넷째 자리로 더하고, 남은 보유를 마지막 평가 가격(없으면 평단)으로 셈한 순자산·평가액·
     * 노출과 함께 네 칸만 고칩니다({@link PaperStore#updateStateValuation}).
     */
    private void writeOn(MarketRun run, String code, List<Evaluation> evaluations, Seen seen, LocalDate session, Instant now,
                         List<Map<String, Object>> written, List<Map<String, Object>> deferred, String payloadAt) {
        for (Evaluation e : evaluations) {
            if (!e.passed()) {
                noteDeferred(deferred, code, e.order(), e.reasons(), payloadAt);
            }
        }
        BookState state = store.state(code).orElse(null);
        if (state == null || seen == null || !java.util.Objects.equals(state.lastProcessedCollectedAt(), seen.processedAt())
                || !ids(store.ordersByStatus(code, PaperBooks.ORDER_PENDING)).equals(seen.pending())) {
            return;   // 그사이 밤 처리·새 주문·취소 — 버림(다음 주기에 다시 판정)
        }
        Map<String, Position> held = new TreeMap<>();
        store.positions(code).forEach(p -> held.put(p.ticker(), p));
        List<Evaluation> passed = new ArrayList<>(evaluations.stream().filter(Evaluation::passed).toList());
        passed.sort(java.util.Comparator.comparing((Evaluation e) -> PaperLedgerService.intradayTime(e.order()),
                java.util.Comparator.nullsLast(java.util.Comparator.naturalOrder())).thenComparingLong(e -> e.order().id()));
        TradingCalendar calendar = run.calendar();
        PaperSettings settings = run.settings();
        double cashBefore = state.cash();
        double cash = cashBefore;
        List<Object[]> done = new ArrayList<>();
        for (Evaluation e : passed) {
            Order current = store.order(e.order().id()).orElse(null);
            Position position = held.get(e.order().ticker());
            if (current == null || hasRecord(current) || e.terms() == null || e.at() == null || position == null
                    || !java.util.Objects.equals(position.qty(), e.heldQty())) {
                continue;
            }
            int qty = PaperLedger.sellQty(position.qty(), null);
            FillTerms terms = e.terms();
            FillTerms.Costs costs = terms.costs(qty);
            store.insertFill(new Fill(0, current.id(), code, current.ticker(), PaperBooks.SELL, qty, terms.price(), terms.rawPrice(),
                    terms.slippageBp(), costs.gross(), e.at(), session, terms.priceSource(), false, null, costs.fee(), costs.tax(),
                    costs.slippageCost()));
            if (!store.markOrderFilledIfPending(current.id(), e.at())) {
                throw new IllegalStateException("주문 " + current.id() + "이 대기가 아님(그사이 체결·취소) — 이 책 장중 기록을 되돌림");
            }
            store.deletePosition(code, current.ticker());
            held.remove(current.ticker());
            store.upsertLockout(new PaperStore.Lockout(code, current.ticker(),
                    com.macrodash.analytics.TrailingStop.lockoutUntil(calendar, session, settings.lockoutTradingDays()),
                    PaperLedgerService.stopLockoutText(current, session, terms.price())));
            cash = PaperLedger.round4(cash + costs.cashDelta());
            done.add(new Object[]{current, e, position});
        }
        if (done.isEmpty()) {
            return;
        }
        double cashAfter = cash;
        for (Object[] row : done) {
            Order current = (Order) row[0];
            Evaluation e = (Evaluation) row[1];
            Map<String, Object> record = new LinkedHashMap<>(e.record());
            record.put(KrIntradayFill.RECORDED_AT, now.toString());
            record.put(KrIntradayFill.BEFORE, KrIntradayFill.before((Position) row[2]));
            record.put(KrIntradayFill.FILL_REF_VOLUME, e.refVolume());
            record.put(KrIntradayFill.CASH_BEFORE, cashBefore);
            record.put(KrIntradayFill.CASH_AFTER, cashAfter);
            ObjectNode reason = current.reason() instanceof ObjectNode existing ? existing.deepCopy() : mapper.createObjectNode();
            PaperLedgerService.intradayStopFields().forEach((key, value) -> reason.set(key, mapper.valueToTree(value)));
            if (!e.terms().warnings().isEmpty()) {
                e.terms().warnings().forEach(reason.putArray("fillWarnings")::add);
            }
            reason.set(KrIntradayFill.FIELD, mapper.valueToTree(record));
            store.updateOrderReason(current.id(), reason);
            written.add(summary(code, current, record));
            onDeferred.remove(current.id());
        }
        Map<String, Integer> qty = new TreeMap<>();
        Map<String, Double> price = new TreeMap<>();
        for (Position p : held.values()) {
            qty.put(p.ticker(), p.qty());
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(cashAfter, qty, price);
        store.updateStateValuation(code, cashAfter, PaperLedger.round4(valuation.nav()), PaperLedger.round4(valuation.equityValue()),
                PaperLedger.round4(valuation.exposurePct()));
    }

    /** ON — 밤에 맡긴 주문의 사유를 작업 기록에 처음 한 번(사유가 바뀌면 다시) 남기고, 같은 저장본으로는 다시 판정하지 않게 기억합니다. */
    private void noteDeferred(List<Map<String, Object>> deferred, String code, Order order, List<String> reasons, String payloadAt) {
        String joined = String.join(",", reasons);
        String previous = onDeferred.put(order.id(), (payloadAt == null ? "" : payloadAt) + "|" + joined);
        if (previous == null || !previous.endsWith("|" + joined)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("book", code);
            row.put("orderId", order.id());
            row.put("ticker", order.ticker());
            row.put(KrIntradayFill.REASONS, reasons);
            deferred.add(row);
        }
    }

    // ------------------------------------------------------------------ 밤 뒤 대조
    /** 밤 장부가 닫은 SHADOW 근거 주문을 밤 결과와 견줍니다(클래스 설명). */
    private void checkAfterNight(Map<String, List<Order>> toCheck, Instant now, List<Map<String, Object>> checks, List<String> alerts,
                                 long[] lockMillis) {
        Map<String, List<Order>> byBook = new LinkedHashMap<>();
        toCheck.forEach((code, orders) -> {
            List<Order> due = orders.stream()
                    .filter(o -> KrStopFill.SHADOW.name().equals(Json.asText(Json.child(o.reason(), KrIntradayFill.FIELD), KrIntradayFill.MODE)))
                    .toList();
            if (!due.isEmpty()) {
                byBook.put(code, due);
            }
        });
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

    // ------------------------------------------------------------------ ON 사후 점검
    /** 사후 점검 한 건의 결과 — 대조 칸({@value KrIntradayFill#CHECK})과 기업행위 판정 칸({@value KrIntradayFill#POST_CHECK} — 판정하지 못했으면 null). */
    private record NightView(Map<String, Object> check, Map<String, Object> postCheck) {
    }

    /**
     * ON 장중 기록 STOP의 사후 점검(클래스 설명) — 그 STOP 세션의 밤 처리가 끝난 책(마지막 처리 저장본의 세션 ≥ 그 세션)의 아직 점검하지 않은 기록마다 한 번.
     * 밤 사다리가 기다림이면 남기지 않고 다음 주기에 다시 봅니다(다음 세션 관측치가 오면 '밤이 체결하지 않음').
     */
    private void postCheckOn(PaperMarket definition, Map<String, List<Order>> toCheck, Instant now, List<Map<String, Object>> checks,
                             List<String> alerts, long[] lockMillis) {
        Map<String, List<Order>> byBook = new LinkedHashMap<>();
        for (Map.Entry<String, List<Order>> book : toCheck.entrySet()) {
            List<Order> due = book.getValue().stream()
                    .filter(o -> PaperBooks.ORDER_FILLED.equals(o.status())
                            && KrStopFill.ON.name().equals(Json.asText(Json.child(o.reason(), KrIntradayFill.FIELD), KrIntradayFill.MODE)))
                    .toList();
            BookState state = due.isEmpty() ? null : store.state(book.getKey()).orElse(null);
            if (state == null || state.lastProcessedCollectedAt() == null) {
                continue;
            }
            // 값싼 앞 거름 — 그 세션 밤 관측치는 장중 체결(감시 항목을 받은 시각)보다 뒤에 받으므로 마지막 처리 저장본이 그보다 앞이면 아직 밤 전(달력을 열지 않음).
            List<Order> after = due.stream().filter(o -> o.filledAt() == null || state.lastProcessedCollectedAt().isAfter(o.filledAt())).toList();
            if (!after.isEmpty()) {
                byBook.put(book.getKey(), after);
            }
        }
        if (byBook.isEmpty()) {
            return;
        }
        MarketRun run = markets.open(definition);
        TradingCalendar calendar = run.calendar();
        PaperMarketData.Quotes quotes = reader.quietly(() -> marketData.quotes(run).map(q -> run.withListings(q, marketData))).orElse(null);
        LocalDate quotesSession = quotes == null ? null : KrPaperMarket.targetSession(quotes.collectedAt(), calendar);
        Map<Long, NightView> results = new LinkedHashMap<>();
        Map<String, Integer> codes = new TreeMap<>();
        for (Map.Entry<String, List<Order>> entry : byBook.entrySet()) {
            String code = entry.getKey();
            BookState state = store.state(code).orElse(null);
            if (state == null) {
                continue;
            }
            LocalDate processed = KrPaperMarket.targetSession(state.lastProcessedCollectedAt(), calendar);
            for (Order order : entry.getValue()) {
                LocalDate session = order.expiresOn();
                if (session == null || processed.isBefore(session)) {
                    continue;   // 그 세션 밤 처리 전
                }
                NightView view = night(run, quotes, quotesSession, code, order, session, processed, now);
                if (view == null) {
                    continue;   // 밤 사다리가 기다림 — 다음 주기
                }
                results.put(order.id(), view);
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("book", code);
                row.put("orderId", order.id());
                row.put("ticker", order.ticker());
                row.put("mode", KrStopFill.ON.name());
                row.put("match", view.check().get("match"));
                row.put(KrIntradayFill.REASONS, view.check().get(KrIntradayFill.REASONS));
                checks.add(row);
                if (!Boolean.TRUE.equals(view.check().get("match"))) {
                    for (Object reason : (List<?>) view.check().get(KrIntradayFill.REASONS)) {
                        codes.merge(String.valueOf(reason), 1, Integer::sum);
                    }
                }
            }
        }
        if (results.isEmpty()) {
            return;
        }
        ledger.exclusively(() -> {
            long acquired = System.nanoTime();
            store.atomically(() -> {
                for (Map.Entry<Long, NightView> entry : results.entrySet()) {
                    Order current = store.order(entry.getKey()).orElse(null);
                    JsonNode record = current == null ? null : Json.child(current.reason(), KrIntradayFill.FIELD);
                    if (record == null || record.has(KrIntradayFill.CHECK)) {
                        continue;
                    }
                    ObjectNode reason = (ObjectNode) current.reason().deepCopy();
                    ObjectNode fill = (ObjectNode) reason.get(KrIntradayFill.FIELD);
                    fill.set(KrIntradayFill.CHECK, mapper.valueToTree(entry.getValue().check()));
                    if (entry.getValue().postCheck() != null) {
                        fill.set(KrIntradayFill.POST_CHECK, mapper.valueToTree(entry.getValue().postCheck()));
                    }
                    store.updateOrderReason(current.id(), reason);
                }
                return null;
            });
            lockMillis[0] = Math.max(lockMillis[0], 0) + Duration.ofNanos(System.nanoTime() - acquired).toMillis();
            return null;
        });
        long differed = results.values().stream().filter(v -> !Boolean.TRUE.equals(v.check().get("match"))).count();
        if (differed > 0) {
            alerts.add("장중 기록 STOP 사후 점검 — 밤 일괄과 다름·확인 못 함 " + differed + "건 — 사유 " + codes);
        }
    }

    /**
     * 그 장중 기록 STOP을 밤 일괄이 어떻게 했을지(ON 사후 점검 한 건) — 기다림이면 null. 밤과 같은 함수: 체결 봉 고르기({@link MarketRun#fillBar} — 그 밤
     * 관측치·시각 지정 1분봉), 체결 조건({@link MarketRun#fill}), 기업행위 판정({@link KrIntradayFill#nightCorporate}).
     */
    private NightView night(MarketRun run, PaperMarketData.Quotes quotes, LocalDate quotesSession, String code, Order order, LocalDate session,
                            LocalDate processed, Instant now) {
        JsonNode record = Json.child(order.reason(), KrIntradayFill.FIELD);
        List<String> reasons = new ArrayList<>();
        String note = null;
        boolean unchecked = false;
        Map<String, Object> postCheck = null;
        Double nightRaw = null;
        String nightSource = null;
        LocalDate nightDate = null;
        if (record.hasNonNull(KrIntradayFill.PAUSED_AT)) {
            reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
            note = "기록 뒤 그 밤 전에 책을 일시정지 — 밤 일괄이면 그 STOP은 취소";
        } else if (processed.isAfter(session) && store.navRow(code, session).isEmpty()) {
            reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
            note = session + " 자료의 순자산 줄 없이 다음 세션으로 넘어감 — 밤 일괄이면 다음 세션 처리 첫 단계에서 만료";
        } else if (quotes == null || !session.equals(quotesSession)) {
            if (nightWaiting.remove(order.id())) {
                reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
                note = "그 세션 밤 체결 사다리가 기다리는 동안 다음 세션 관측치가 옴 — 밤 일괄이면 만료";
            } else {
                unchecked = true;
                reasons.add(KrIntradayFill.NIGHT_UNCHECKED);
                note = "그 세션 밤 관측치가 이미 지남(관측치 세션 " + quotesSession + ") — 다시 셀 수 없음";
            }
        } else {
            Position before = KrIntradayFill.position(code, order.ticker(), record.get(KrIntradayFill.BEFORE));
            PaperMarketData.Bar bar = quotes.bars().get(order.ticker());
            if (before == null) {
                unchecked = true;
                reasons.add(KrIntradayFill.NIGHT_UNCHECKED);
                note = "기록 직전 보유 사본이 없음";
            } else if (bar == null || bar.stale()) {
                reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
                note = "그 밤 관측치에 그 종목이 없거나 이어받은 항목 — 밤 일괄이면 체결하지 않음";
            } else {
                PaperSettings settings = run.settings();
                LocalDate from = before.fillRefDate();
                KrConfirmed confirmed = from == null ? null
                        : reader.quietly(() -> run.confirmedPrices(marketData, Set.of(order.ticker()), settings, from));
                Double refVolume = Json.asDouble(record, KrIntradayFill.FILL_REF_VOLUME);
                com.macrodash.analytics.KrxCorporateActions.Assessment assessment = KrIntradayFill.nightCorporate(bar,
                        quotes.absent().contains(order.ticker()), session, before, refVolume == null ? null : refVolume.longValue(),
                        confirmed == null ? KrConfirmed.Series.UNKNOWN : confirmed.of(order.ticker()), KrPaperMarket.etf(order.ticker(), settings));
                if (assessment != null) {
                    postCheck = new LinkedHashMap<>();
                    postCheck.put("checkedAt", now.toString());
                    postCheck.put("kind", assessment.kind().name());
                    postCheck.put("details", assessment.details());
                }
                if (assessment != null && assessment.holdOrders()) {
                    reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
                    reasons.add(KrIntradayFill.CORP_ACTION);
                    note = "밤 일괄이면 기업행위 판정(" + assessment.kind().name() + ")이 그 STOP을 보류";
                } else {
                    PaperMarket.FillChoice choice = run.fillBar(order, bar, quotes.collectedAt(), run.calendar(), run.settingsBody());
                    if (choice.bar() == null) {
                        if (!choice.unfillable() && choice.waitReason() != null) {
                            nightWaiting.add(order.id());
                            return null;
                        }
                        reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
                        note = choice.waitReason() == null ? "그 밤 관측치로 고를 체결 봉 없음" : choice.waitReason();
                    } else {
                        FillTerms terms = run.fill(order, choice.bar(), settings, run.calendar());
                        if (terms.holdReason() != null) {
                            reasons.add(KrIntradayFill.NIGHT_NOT_FILLED);
                            note = "밤 체결 조건 보류 — " + terms.holdReason();
                        } else {
                            nightRaw = terms.rawPrice();
                            nightSource = terms.priceSource();
                            nightDate = choice.bar().date();
                            reasons.addAll(KrIntradayFill.compare(record, terms.rawPrice(), terms.priceSource(), nightDate, before.qty(),
                                    terms.costs(PaperLedger.sellQty(before.qty(), null))));
                        }
                    }
                }
            }
        }
        nightWaiting.remove(order.id());
        Boolean match = unchecked ? null : reasons.isEmpty();
        Double version = Json.asDouble(record, KrIntradayFill.SETTINGS_VERSION);
        if (version != null && run.settingsVersion() != null && version.intValue() != run.settingsVersion()) {
            reasons.add(KrIntradayFill.SETTINGS_CHANGED);
        }
        Map<String, Object> check = new LinkedHashMap<>();
        check.put("checkedAt", now.toString());
        check.put("nightRawPrice", nightRaw);
        check.put("nightSource", nightSource);
        check.put("nightDate", nightDate == null ? null : nightDate.toString());
        check.put("nightSettingsVersion", run.settingsVersion());
        check.put("match", match);
        check.put(KrIntradayFill.REASONS, reasons);
        check.put("note", note);
        return new NightView(check, postCheck);
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
        detail.put("deferred", outcome.deferred());
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
