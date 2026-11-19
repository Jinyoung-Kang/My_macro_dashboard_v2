package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static com.macrodash.feature.paper.KrIntradayFillTest.entry;
import static com.macrodash.feature.paper.KrIntradayFillTest.kst;
import static com.macrodash.feature.paper.KrIntradayFillTest.minutes;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 장중 감시 STOP 체결의 장중 기록(ADR 0045 ON — {@link KrStopFillStep})을 실제 저장소(macrodash_test)와 실제 밤 장부({@link PaperLedgerService})로 봅니다.
 * 두 세계를 같은 입력으로 돌립니다 — ON 세계는 'S 09:15:20 장중 단계 → S 13시대 금융위 D(= P) 도착·리스크 점검의 확정 조정 → S 밤 처리 → 사후 점검', 밤 일괄
 * 세계는 'S 13시대 금융위 P 도착·확정 조정 → S 밤 처리'.
 *
 * <ul>
 *   <li><b>동치</b>: 밤 처리 뒤 현금·보유·체결(번호·관측 시각·쓴 시각 빼고)·주문 상태와 근거({@code intradayFill}·{@code confirmedHighWatermark} 빼고)·재진입 금지·
 *       순자산 줄·상태(쓴 시각 빼고)가 같음. 뒤 시각 규칙 매수(13:00)는 두 세계 모두 스탑 대금을 본 순자산으로 같은 수량.</li>
 *   <li><b>D12 (가)</b>: P 줄을 장중 기록 뒤에 확정해도 밤 일괄 세계의 P 줄과 같음(판 종목의 금융위 P 행이 있으면 확정, 없으면 잠정).</li>
 *   <li><b>동치가 깨지는 경우</b>(ADR 0045 동치의 전제): S 밤 관측치에 그 종목이 없음(밤만 체결하지 않음), S 밤 기업행위 판정이 그 종목을 '없음'이 아니게 봄 —
 *       ON 세계는 이미 팔았고 사후 점검이 {@value KrIntradayFill#NIGHT_NOT_FILLED}로 남김. S+1 시가 목표는 두 세계가 다름(범위 표시 — 실제 계좌가 따라 하는
 *       목표가 갈림, ADR 0033 덧붙임의 조건).</li>
 *   <li><b>멱등</b>: 같은 주기를 두 번 돌려도 체결 하나, 밤이 그 주문을 다시 체결하지 않음.</li>
 * </ul>
 *
 * <p>책은 시험 접두어 {@value #BOOK}만 쓰고(설정 행·책 목록을 이 책으로 좁힌 저장소 — 시험 DB의 다른 책·설정은 건드리지 않음), 시작·끝에 지웁니다.
 */
class KrIntradayStopFillDbTest {

    private static final String BOOK = "t_kr_fill";
    private static final KrPaperMarket KR = KrPaperMarket.INSTANCE;
    private static final LocalDate S = KrIntradayFillTest.S;          // 2026-11-17(화)
    private static final LocalDate P = KrIntradayFillTest.PREV;       // 2026-11-16(월)
    private static final LocalDate P1 = LocalDate.of(2026, 11, 13);   // P 전 거래일
    private static final LocalDate P2 = LocalDate.of(2026, 11, 12);
    private static final String A = "005930";
    private static final String B = "000660";
    private static final String C = "035420";

    /**
     * S 밤 쪽 장면 — 그대로, 판 종목이 밤 관측치에 없음·이어받음, 기업행위 신호, 기록과 밤 사이 일시정지(운영자 — 대기 주문 취소·장중 기록 STOP에 pausedAt),
     * 기록과 밤 사이 비용 키 저장(kr.commissionBp — 밤은 새 판으로 체결 조건을 셈).
     */
    private enum Night { SAME, A_MISSING, A_CORP_SIGNAL, A_STALE, PAUSED, COST_SAVED }

    private JdbcTemplate jdbc;
    private PaperStore store;
    private SettingsRow settings;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperCheckpointJobTest.MovableClock clock;
    private PaperLedgerService ledger;
    private KrStopFillStep step;
    /** 금융위 P 행이 들어왔나(S 13시대 — 그 전에는 최신 기준일 P−1). */
    private boolean fscP;
    private boolean fscForA = true;
    private boolean splitSignalA;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        assumeTrue(new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)).ready(), "테스트 DB에 모의 매매 표가 없습니다 — make db-test");
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        if (jdbc != null) {
            jdbc.update("DELETE FROM paper_books WHERE code = ?", BOOK);
        }
    }

    /** 설정 행을 이 시험 값({@link #settings} — 그때그때 읽음, 기록과 밤 사이 저장 장면)으로, 책 목록을 시험 책으로 좁힌 실제 저장소(나머지 읽기·쓰기는 실제 SQL). */
    private PaperStore scoped() {
        return new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)) {
            @Override
            public Optional<SettingsRow> settings() {
                return Optional.of(settings);
            }

            @Override
            public Optional<SettingsRow> settingsInForceAt(Instant at) {
                return Optional.of(settings);
            }

            @Override
            public List<Book> books(String market) {
                return super.books(market).stream().filter(b -> BOOK.equals(b.code())).toList();
            }

            @Override
            public List<Order> intradayFillsToCheck(String code, int days) {
                return super.intradayFillsToCheck(code, 100_000);   // 고정 날짜(2026-11) 시험이 DB 시각과 상관없이 돌게 — 조건 SQL은 그대로
            }
        };
    }

    private SettingsRow settingsRow(String fill) {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(new FakePaperStore()).defaultsJson();
        ((ObjectNode) body.get("kr").get("stopWatch")).put("mode", "ON").put("fill", fill);
        return new SettingsRow(7, body, kst("2026-11-10T16:00"));
    }

    private MarketRun run() {
        return new MarketRun(KR, KR.openCalendar(KrFixtures.inputs(settings.body(), KrFixtures.holidays(2026, 2027))), settings);
    }

    private static KrConfirmed.Day fscDay(LocalDate date, double close, long listed) {
        return new KrConfirmed.Day(date, BigDecimal.valueOf(close), 1_000L, listed, BigDecimal.valueOf(close), "KOSPI");
    }

    /** 금융위 확정 시세 — P−2·P−1(그리고 P가 들어왔으면 P) 행, 상장주식수 1,000,000(A 상장주식수 신호면 P에 1,500,000). */
    private KrConfirmed confirmed() {
        Map<String, KrConfirmed.Series> out = new TreeMap<>();
        for (Object[] row : new Object[][]{{A, 70_000.0}, {B, 140_000.0}, {C, 50_000.0}}) {
            String ticker = (String) row[0];
            double close = (Double) row[1];
            java.util.NavigableMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
            days.put(P2, fscDay(P2, close, 1_000_000));
            days.put(P1, fscDay(P1, close, 1_000_000));
            if (fscP && (fscForA || !A.equals(ticker))) {
                days.put(P, fscDay(P, close, A.equals(ticker) && splitSignalA ? 1_500_000 : 1_000_000));
            }
            out.put(ticker, new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, fscP ? P : P1, days));
        }
        return new KrConfirmed(out);
    }

    private ObjectNode watchEntry(String from, String to, double base, Instant fetched) {
        return entry(S, fetched, minutes(from, to, base), List.of());
    }

    /** 한 세계를 S 밤 처리까지 돌림(클래스 설명) — 장중 기록이면 S 09:15:20 단계, 그 뒤 금융위 P 도착·확정 조정, S 밤 처리(그리고 사후 점검). */
    private World world(boolean intraday, Night night) {
        return world(intraday ? "ON" : "OFF", night, false, false);
    }

    /**
     * {@link #world(boolean, Night)}의 본체 — 기록 스위치 {@code fill}(OFF는 밤 일괄, SHADOW는 S 09:15:20 단계가 근거만·S 밤 뒤 대조, ON은 장중 기록·사후 점검),
     * {@code twoStops}면 B의 감시 STOP을 같은 분(T 09:11)에 더 두고, {@code holdB}면 장중 단계 전에 B에 미처리 기업행위 표시를 겁니다(그 STOP은 두 세계 모두 밤에 보류).
     */
    private World world(String fill, Night night, boolean twoStops, boolean holdB) {
        boolean intraday = !"OFF".equals(fill);
        boolean on = "ON".equals(fill);
        cleanUp();
        settings = settingsRow(fill);
        store = scoped();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        fscP = false;
        splitSignalA = night == Night.A_CORP_SIGNAL;
        when(marketData.fscMarkets(any())).thenReturn(Map.of(A, "KOSPI", B, "KOSPI", C, "KOSPI"));
        when(marketData.krConfirmed(any(), any(), any())).thenAnswer(invocation -> confirmed());
        when(marketData.quotes(any())).thenReturn(Optional.empty());
        when(marketData.watchKr()).thenReturn(Optional.empty());
        ObjectNode entryA = watchEntry("09:00", "09:15", 69_000, kst("2026-11-17T09:15:20"));
        ObjectNode entryB = watchEntry("09:00", "09:15", 139_000, kst("2026-11-17T09:15:20"));
        ObjectNode entryC = watchEntry("12:50", "13:10", 50_100, kst("2026-11-17T13:10:20"));
        ObjectNode tickers = MAPPER.createObjectNode();
        tickers.set(A, entryA);
        if (twoStops) {
            tickers.set(B, entryB);
        }
        ObjectNode payload = MAPPER.createObjectNode().put("fetchedAt", kst("2026-11-17T09:15:20").toString()).put("mode", "ON");
        payload.set("tickers", tickers);
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                kst("2026-11-17T09:15:21"))));
        Map<String, Map<LocalDate, KrQuotes.Timed>> timed = new TreeMap<>();
        timed.put(A, Map.of(S, KrIntradayFill.timed(entryA, LocalTime.of(9, 11))));
        if (twoStops) {
            timed.put(B, Map.of(S, KrIntradayFill.timed(entryB, LocalTime.of(9, 11))));
        }
        timed.put(C, Map.of(S, KrIntradayFill.timed(entryC, LocalTime.of(13, 0))));
        when(marketData.krTimed()).thenReturn(timed);
        clock = new PaperCheckpointJobTest.MovableClock(kst("2026-11-17T09:15:20"));
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        step = new KrStopFillStep(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER, clock,
                new PaperMarkets(store, reader, List.of(KR)));

        store.insertBookIfAbsent(new Book(BOOK, PaperBooks.KIND_RULES, "시험 한국 책", 10_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE,
                null, Book.MARKET_KR, Book.CURRENCY_KRW));
        hold(A, 10, 70_000);
        hold(B, 5, 140_000);
        hold(C, 20, 50_000);
        double equity = 10 * 70_000 + 5 * 140_000 + 20 * 50_000;
        store.upsertState(new BookState(BOOK, 5_000_000, 5_000_000 + equity, equity, equity / (5_000_000 + equity) * 100,
                kst("2026-11-16T20:40"), kst("2026-11-16T20:40"), P, null));
        store.upsertNav(new NavRow(BOOK, P, 5_000_000 + equity, 5_000_000, equity, com.macrodash.analytics.PaperLedger.round4(equity / (5_000_000 + equity) * 100),
                false));
        ObjectNode reason = MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE).put("stopPct", 8).put("highWatermark", 75_000)
                .put("stopPrice", 69_000);
        long stop = store.insertOrder(new Order(0, BOOK, null, A, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, reason, P, kst("2026-11-17T09:10:42"), S, null));
        long stopB = !twoStops ? 0 : store.insertOrder(new Order(0, BOOK, null, B, PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, reason.deepCopy().put("highWatermark", 150_000).put("stopPrice", 138_000), P,
                kst("2026-11-17T09:10:50"), S, null));
        store.insertOrder(new Order(0, BOOK, null, C, PaperBooks.BUY, null, 25.0, null, PaperBooks.AT_MINUTE, RuleBookService.SOURCE_RULE,
                PaperBooks.ORDER_PENDING, null, null, P, kst("2026-11-16T22:40"), S.plusDays(5), null, LocalTime.of(13, 0)));
        if (holdB) {
            store.holdForCorpAction(BOOK, B, "2026-11-16 기업행위 확인 필요 — 시험");
        }

        World out = new World();
        if (intraday) {
            KrStopFillStep.Outcome first = step.run(KR);
            assertThat(first.error()).isNull();
            int expected = on && holdB ? 1 : twoStops ? 2 : 1;   // ON은 장부에 적은 주문만, SHADOW는 근거를 남긴 주문 모두
            assertThat(first.recorded()).as(fill + " 장중 단계").hasSize(expected).anySatisfy(r -> assertThat(r.get("orderId")).isEqualTo(stop));
            out.first = first;
            clock.now = kst("2026-11-17T09:15:40");
            assertThat(step.run(KR).recorded()).as("멱등 — 두 번째 주기는 쓰지 않음").isEmpty();
            assertThat(store.recentFills(BOOK, 10)).as("체결 — ON은 적은 수만큼, SHADOW는 없음").hasSize(on ? expected : 0);
        }
        if (night == Night.PAUSED) {
            // 기록 뒤 그 밤 전에 운영자가 책을 일시정지 — 대기 주문 취소, 장중 기록 STOP에 pausedAt(PaperAdminService.setStatus 그대로).
            clock.now = kst("2026-11-17T11:00");
            new PaperAdminService(store, marketData, reader, new PaperSettingsService(store, MAPPER), ledger, PaperFixtures.config(), MAPPER, clock)
                    .setStatus(BOOK, PaperBooks.PAUSED);
        }
        if (night == Night.COST_SAVED) {
            // 기록과 밤 사이에 비용 키 저장(설정 v8 — kr.commissionBp 1.5 → 3) — 밤은 새 판으로 체결 조건을 셈(ADR 0045 알려진 차이(경제적)).
            ObjectNode body = (ObjectNode) settings.body().deepCopy();
            ((ObjectNode) body.get("kr")).put("commissionBp", 3.0);
            settings = new SettingsRow(8, body, kst("2026-11-17T11:00"));
        }
        // S 13시대 — 금융위 P 도착, 리스크 점검의 확정 조정.
        fscP = true;
        ledger.confirm(run());
        out.pLine = navOn(P);

        // S 밤 처리.
        KrFixtures.Payload quotes = new KrFixtures.Payload(S);
        if (night != Night.A_MISSING) {
            KrFixtures.Entry a = quotes.code(A, kst("2026-11-17T20:30")).bar(P, 70_000, 70_000, 900_000).bar(S, 69_500, 68_800, 800_000)
                    .minute("OK", "09:01", 69_500, 30_000);
            if (night == Night.A_STALE) {
                a.stale();
            }
        }
        quotes.code(B, kst("2026-11-17T20:30")).bar(P, 140_000, 140_000, 900_000).bar(S, 141_000, 141_500, 800_000).minute("OK", "09:01", 141_000, 30_000);
        quotes.code(C, kst("2026-11-17T20:30")).bar(P, 50_000, 50_000, 900_000).bar(S, 50_050, 50_300, 800_000).minute("OK", "09:01", 50_050, 30_000);
        PaperMarketData.Quotes observed = KrQuotes.parse(quotes.snapshot(kst("2026-11-17T20:35"))).orElseThrow();
        PaperLedgerService.Outcome processed = ledger.process(run(), observed);
        assertThat(processed.errors()).isEmpty();
        when(marketData.quotes(any())).thenReturn(Optional.of(observed));
        if (intraday) {
            clock.now = kst("2026-11-17T20:40");
            out.postCheck = step.run(KR);
        }
        out.stopId = stop;
        out.stopBId = stopB;
        out.capture(store, jdbc);
        out.next = new PaperMirrorService(store, reader, marketData, new PaperMarkets(store, reader, List.of(KR)), ledger,
                java.time.Clock.fixed(kst("2026-11-18T08:30"), java.time.ZoneOffset.UTC)).openTargets(BOOK, S.plusDays(1));
        return out;
    }

    private void hold(String ticker, int qty, double price) {
        store.upsertPosition(new Position(BOOK, ticker, qty, price * 0.9, LocalDate.of(2026, 11, 2), kst("2026-11-02T09:10"), price,
                kst("2026-11-16T20:40"), price, kst("2026-11-16T20:40"), false, P, price, null));
        store.updateFillRefVolume(BOOK, ticker, 900_000L);
    }

    private NavRow navOn(LocalDate day) {
        return store.navSeries(BOOK).stream().filter(r -> r.tradingDate().equals(day)).findFirst().orElse(null);
    }

    /** 한 세계의 밤 처리 뒤 장부(비교할 칸만). */
    private static final class World {
        BookState state;
        List<Position> positions;
        List<List<Object>> fills;
        Map<String, List<Object>> orders;
        List<Lockout> lockouts;
        List<NavRow> navs;
        NavRow pLine;
        KrStopFillStep.Outcome postCheck;
        Optional<PaperMirrorService.OpenTargets> next;
        long stopId;
        long stopBId;
        JsonNode stopRecord;
        JsonNode stopBRecord;
        KrStopFillStep.Outcome first;
        Map<String, Long> refVolumes;
        List<PaperStore.CorpActionHold> holds;
        long confirmations;

        void capture(PaperStore store, JdbcTemplate jdbc) {
            BookState s = store.state(BOOK).orElseThrow();
            state = new BookState(s.bookCode(), s.cash(), s.nav(), s.equityValue(), s.exposurePct(), s.lastObservedAt(), s.lastProcessedCollectedAt(),
                    s.lastNavTradingDate(), null);
            positions = store.positions(BOOK);
            fills = new ArrayList<>();
            List<Fill> raw = new ArrayList<>(store.recentFills(BOOK, 50));
            raw.sort(Comparator.comparing(Fill::ticker).thenComparing(Fill::side));
            for (Fill f : raw) {
                fills.add(List.of(f.ticker(), f.side(), f.qty(), f.price(), f.rawPrice(), f.slippageBp(), f.gross(), f.observationDate(),
                        f.priceSource(), f.fee().stripTrailingZeros(), f.tax().stripTrailingZeros(), f.slippageCost().stripTrailingZeros()));
            }
            orders = new TreeMap<>();
            for (Order o : store.recentOrders(BOOK, 50)) {
                ObjectNode reason = o.reason() instanceof ObjectNode r ? r.deepCopy() : MAPPER.createObjectNode();
                if (o.id() == stopId) {
                    stopRecord = reason.get(KrIntradayFill.FIELD);
                } else if (o.id() == stopBId) {
                    stopBRecord = reason.get(KrIntradayFill.FIELD);
                }
                reason.remove(KrIntradayFill.FIELD);
                reason.remove(PaperLedgerService.STOP_CONFIRMED_WATERMARK);
                List<Object> row = new ArrayList<>();
                row.add(o.status());
                row.add(String.valueOf(o.rejectReason()));
                row.add(reason);
                orders.put(o.ticker() + "|" + o.side() + "|" + o.timing() + "|" + o.source(), row);
            }
            lockouts = store.lockouts(BOOK);
            navs = store.navSeries(BOOK);
            refVolumes = new TreeMap<>(store.fillRefVolumes(BOOK));
            holds = store.corpActionHolds(BOOK);
            confirmations = jdbc.queryForObject("SELECT count(*) FROM paper_fill_confirmations WHERE book_code = ?", Long.class, BOOK);
        }
    }

    @Test
    @DisplayName("동치 — 장중 단계(ON) → 금융위 P·확정 조정 → S 밤 처리의 결과가 밤 일괄과 같음(현금·보유·체결·주문 상태·근거·재진입 금지·순자산 줄·상태), "
            + "P 줄은 두 세계 모두 확정, 뒤 시각 규칙 매수는 같은 수량, 사후 점검은 일치")
    void intradayThenNightEqualsNightOnly() {
        World off = world(false, Night.SAME);
        World on = world(true, Night.SAME);

        assertThat(off.fills).as("밤 일괄 — STOP 매도와 규칙 매수").hasSize(2);
        assertThat(on.fills).isEqualTo(off.fills);
        assertThat(on.positions).isEqualTo(off.positions);
        assertThat(on.state).isEqualTo(off.state);
        assertThat(on.orders).isEqualTo(off.orders);
        assertThat(on.lockouts).isEqualTo(off.lockouts);
        assertThat(on.navs).isEqualTo(off.navs);
        assertThat(off.pLine.pricesFinal()).as("금융위 P 행 — 확정").isTrue();
        assertThat(on.pLine).as("D12 (가) — 장중 기록 뒤에도 같은 P 줄").isEqualTo(off.pLine);
        assertThat(on.stopRecord.path(KrIntradayFill.MODE).asString()).isEqualTo("ON");
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean()).as("사후 점검 — 밤 일괄과 같음").isTrue();
        assertThat(on.stopRecord.path(KrIntradayFill.POST_CHECK).path("kind").asString()).isEqualTo("NONE");
        assertThat(on.postCheck.alerts()).isEmpty();
        assertThat(on.next).isEqualTo(off.next);
        assertThat(on.refVolumes).as("보유 레코드 밖 — since 봉 거래량").isEqualTo(off.refVolumes);
        assertThat(on.holds).as("보유 레코드 밖 — 미처리 기업행위 표시").isEqualTo(off.holds);
        assertThat(on.confirmations).as("확정 조정 행 수").isEqualTo(off.confirmations);
    }

    @Test
    @DisplayName("동치 — 같은 분(T 09:11)의 다른 종목 STOP 둘을 한 트랜잭션에 적어도 S 밤 처리 뒤 밤 일괄과 같음(체결 셋·보유·현금·순자산 줄·보유 레코드 밖 칸), "
            + "두 기록의 직전·직후 현금이 같은 한 기록")
    void twoStopsInOneTransactionEqualNightOnly() {
        World off = world("OFF", Night.SAME, true, false);
        World on = world("ON", Night.SAME, true, false);

        assertThat(off.fills).as("밤 일괄 — STOP 매도 둘과 규칙 매수").hasSize(3);
        assertThat(on.fills).isEqualTo(off.fills);
        assertThat(on.positions).isEqualTo(off.positions);
        assertThat(on.state).isEqualTo(off.state);
        assertThat(on.orders).isEqualTo(off.orders);
        assertThat(on.lockouts).isEqualTo(off.lockouts);
        assertThat(on.navs).isEqualTo(off.navs);
        assertThat(on.refVolumes).isEqualTo(off.refVolumes);
        assertThat(on.confirmations).isEqualTo(off.confirmations);
        assertThat(on.stopBRecord.path(KrIntradayFill.CASH_BEFORE).asDouble()).isEqualTo(on.stopRecord.path(KrIntradayFill.CASH_BEFORE).asDouble());
        assertThat(on.stopBRecord.path(KrIntradayFill.CASH_AFTER).asDouble()).isEqualTo(on.stopRecord.path(KrIntradayFill.CASH_AFTER).asDouble());
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean()).isTrue();
        assertThat(on.stopBRecord.path(KrIntradayFill.CHECK).path("match").asBoolean()).isTrue();
        assertThat(on.postCheck.alerts()).isEmpty();
    }

    @Test
    @DisplayName("동치 — 같은 분의 STOP 둘 가운데 하나(B)만 미처리 기업행위 표시(G4 CORP_HOLD)로 밤에 맡기면 A만 장중에 적고, S 밤 처리 뒤 밤 일괄과 같음"
            + "(B는 두 세계 모두 밤이 보류 — 보유·표시 그대로)")
    void oneOfTwoStopsDeferredEqualsNightOnly() {
        World off = world("OFF", Night.SAME, true, true);
        World on = world("ON", Night.SAME, true, true);

        assertThat(on.first.deferred()).singleElement().satisfies(d -> assertThat(d.get(KrIntradayFill.REASONS))
                .isEqualTo(List.of(KrIntradayFill.CORP_HOLD)));
        assertThat(off.positions).extracting(Position::ticker).contains(B).doesNotContain(A);
        assertThat(on.fills).isEqualTo(off.fills);
        assertThat(on.positions).isEqualTo(off.positions);
        assertThat(on.state).isEqualTo(off.state);
        assertThat(on.orders).isEqualTo(off.orders);
        assertThat(on.lockouts).isEqualTo(off.lockouts);
        assertThat(on.navs).isEqualTo(off.navs);
        assertThat(on.refVolumes).isEqualTo(off.refVolumes);
        assertThat(on.holds).isEqualTo(off.holds).extracting(PaperStore.CorpActionHold::ticker).containsExactly(B);
        assertThat(on.stopBRecord).as("ON은 미룬 판정을 근거에 쓰지 않음").isNull();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("D12 (가) — 판 종목의 금융위 P 행이 없으면 장중 기록 세계의 P 줄도 잠정이고 밤 일괄 세계의 P 줄과 같음")
    void d12ProvisionalWithoutTheRow() {
        fscForA = false;
        World off = world(false, Night.SAME);
        World on = world(true, Night.SAME);

        assertThat(off.pLine.pricesFinal()).isFalse();
        assertThat(on.pLine).isEqualTo(off.pLine);
    }

    @Test
    @DisplayName("동치가 깨지는 경우 ① — S 밤 관측치에 판 종목이 없으면 밤 일괄은 체결하지 않고(보유 남음) ON은 이미 팜: 사후 점검이 NIGHT_NOT_FILLED·운영 알림, "
            + "S+1 시가 목표가 두 세계에서 다름(범위 표시 — 실제 계좌가 따르는 목표가 갈림)")
    void nightWithoutTheTickerBreaksEquivalence() {
        World off = world(false, Night.A_MISSING);
        World on = world(true, Night.A_MISSING);

        assertThat(off.positions).extracting(Position::ticker).contains(A);
        assertThat(on.positions).extracting(Position::ticker).doesNotContain(A);
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(on.postCheck.alerts()).singleElement().satisfies(text -> assertThat(text).contains("NIGHT_NOT_FILLED=1"));
        assertThat(off.next.orElseThrow().weightPct()).containsKey(A);
        assertThat(on.next.orElseThrow().weightPct()).doesNotContainKey(A);
    }

    @Test
    @DisplayName("동치가 깨지는 경우 ⑤ — S 밤 기업행위 판정(금융위 P 상장주식수 +50%)이 판 종목을 '없음'이 아니게 보면 밤 일괄은 그 STOP을 보류: "
            + "ON 사후 점검이 postCheck(판정 종류)와 NIGHT_NOT_FILLED·CORP_ACTION을 남김")
    void nightCorporateActionBreaksEquivalence() {
        World off = world(false, Night.A_CORP_SIGNAL);
        World on = world(true, Night.A_CORP_SIGNAL);

        assertThat(off.positions).extracting(Position::ticker).as("밤 일괄 — 보류로 팔지 않음").contains(A);
        assertThat(on.stopRecord.path(KrIntradayFill.POST_CHECK).path("kind").asString()).isNotEqualTo("NONE");
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED, KrIntradayFill.CORP_ACTION);
        assertThat(on.postCheck.alerts()).hasSize(1);
    }

    @Test
    @DisplayName("동치가 깨지는 경우 ① 이어받음 — S 밤 관측치의 판 종목 항목이 이어받은 값이면 밤 일괄은 체결하지 않고(보유 남음) ON은 이미 팜: 사후 점검이 "
            + "NIGHT_NOT_FILLED·운영 알림")
    void nightStaleTickerBreaksEquivalence() {
        World off = world(false, Night.A_STALE);
        World on = world(true, Night.A_STALE);

        assertThat(off.positions).extracting(Position::ticker).contains(A);
        assertThat(on.positions).extracting(Position::ticker).doesNotContain(A);
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("note").asString()).contains("이어받은");
        assertThat(on.postCheck.alerts()).singleElement().satisfies(text -> assertThat(text).contains("NIGHT_NOT_FILLED=1"));
    }

    @Test
    @DisplayName("동치가 깨지는 경우 ④ 일시정지 — 기록과 S 밤 사이에 운영자가 책을 일시정지하면 밤 일괄은 그 STOP을 취소(보유 남음)하고 ON은 이미 팜: "
            + "ON 사후 점검은 pausedAt으로 NIGHT_NOT_FILLED·운영 알림, SHADOW 대조도 NIGHT_NOT_FILLED")
    void pauseBetweenRecordAndNightBreaksEquivalence() {
        World off = world(false, Night.PAUSED);
        World on = world(true, Night.PAUSED);
        World shadow = world("SHADOW", Night.PAUSED, false, false);

        assertThat(off.positions).extracting(Position::ticker).contains(A);
        assertThat(on.positions).extracting(Position::ticker).doesNotContain(A);
        assertThat(on.stopRecord.path(KrIntradayFill.PAUSED_AT).isMissingNode()).as("일시정지 트랜잭션이 남김").isFalse();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("note").asString()).contains("일시정지");
        assertThat(on.postCheck.alerts()).singleElement().satisfies(text -> assertThat(text).contains("NIGHT_NOT_FILLED=1"));
        assertThat(shadow.positions).isEqualTo(off.positions);
        assertThat(shadow.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(shadow.stopRecord.path(KrIntradayFill.CHECK).path("nightStatus").asString()).isEqualTo(PaperBooks.ORDER_CANCELLED);
    }

    @Test
    @DisplayName("알려진 차이(경제적) — 기록과 S 밤 사이에 비용 키(kr.commissionBp)를 저장하면 체결가·수량은 같고 수수료·현금이 갈림: ON 사후 점검과 SHADOW 대조가 "
            + "COST_MISMATCH(불일치)·SETTINGS_CHANGED, ON은 운영 알림")
    void costSaveBetweenRecordAndNightIsCaught() {
        World off = world(false, Night.COST_SAVED);
        World on = world(true, Night.COST_SAVED);
        World shadow = world("SHADOW", Night.COST_SAVED, false, false);

        assertThat(on.fills).as("비용 칸이 갈림").isNotEqualTo(off.fills);
        assertThat(on.fills.get(0).subList(0, 9)).as("A 매도 — 종목·방향·수량·가격·체결일·출처는 같음").isEqualTo(off.fills.get(0).subList(0, 9));
        assertThat(on.state.cash()).isNotEqualTo(off.state.cash());
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(on.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.COST_MISMATCH, KrIntradayFill.SETTINGS_CHANGED);
        assertThat(on.postCheck.alerts()).singleElement().satisfies(text -> assertThat(text).contains("COST_MISMATCH=1"));
        assertThat(shadow.fills).as("SHADOW는 장부 그대로 — 밤 일괄과 같음").isEqualTo(off.fills);
        assertThat(shadow.stopRecord.path(KrIntradayFill.CHECK).path("match").asBoolean(true)).isFalse();
        assertThat(shadow.stopRecord.path(KrIntradayFill.CHECK).path(KrIntradayFill.REASONS)).extracting(JsonNode::asString)
                .containsExactly(KrIntradayFill.COST_MISMATCH, KrIntradayFill.SETTINGS_CHANGED);
        assertThat(shadow.postCheck.alerts()).singleElement().satisfies(text -> assertThat(text).contains("COST_MISMATCH=1"));
    }

    @Test
    @DisplayName("멱등·예외 — 대기일 때만 바꾸는 갱신이 0행이면 그 책 기록 전체를 되돌려 대기 그대로(체결 행·보유·현금·근거 무변경), 밤이 같은 값으로 체결")
    void rollsBackWhenTheOrderIsNoLongerPending() {
        settings = settingsRow("ON");
        PaperStore real = scoped();
        store = new PaperStore(jdbc, MAPPER, new SchemaCheck(jdbc)) {
            @Override
            public Optional<SettingsRow> settings() {
                return real.settings();
            }

            @Override
            public List<Book> books(String market) {
                return real.books(market);
            }

            @Override
            public boolean markOrderFilledIfPending(long id, Instant filledAt) {
                return false;   // 그사이 다른 쓰기가 체결·취소함
            }
        };
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        when(marketData.fscMarkets(any())).thenReturn(Map.of(A, "KOSPI"));
        when(marketData.krConfirmed(any(), any(), any())).thenAnswer(invocation -> confirmed());
        when(marketData.quotes(any())).thenReturn(Optional.empty());
        ObjectNode tickers = MAPPER.createObjectNode();
        tickers.set(A, watchEntry("09:00", "09:15", 69_000, kst("2026-11-17T09:15:20")));
        ObjectNode payload = MAPPER.createObjectNode().put("fetchedAt", kst("2026-11-17T09:15:20").toString()).put("mode", "ON");
        payload.set("tickers", tickers);
        when(marketData.stopWatch(true)).thenReturn(Optional.of(new Snapshot(Datasets.SNAP_PAPER_STOPWATCH_KR, payload, "json", "ok", null,
                kst("2026-11-17T09:15:21"))));
        clock = new PaperCheckpointJobTest.MovableClock(kst("2026-11-17T09:15:20"));
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        step = new KrStopFillStep(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER, clock, new PaperMarkets(store, reader, List.of(KR)));
        store.insertBookIfAbsent(new Book(BOOK, PaperBooks.KIND_RULES, "시험 한국 책", 10_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE,
                null, Book.MARKET_KR, Book.CURRENCY_KRW));
        hold(A, 10, 70_000);
        store.upsertState(new BookState(BOOK, 5_000_000, 5_700_000, 700_000, 12.2807, kst("2026-11-16T20:40"), kst("2026-11-16T20:40"), P, null));
        ObjectNode reason = MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE).put("stopPct", 8).put("highWatermark", 75_000)
                .put("stopPrice", 69_000);
        long stop = store.insertOrder(new Order(0, BOOK, null, A, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, reason, P, kst("2026-11-17T09:10:42"), S, null));
        BookState before = store.state(BOOK).orElseThrow();

        KrStopFillStep.Outcome outcome = step.run(KR);

        assertThat(outcome.error()).contains("장중 기록 되돌림");
        assertThat(outcome.recorded()).isEmpty();
        assertThat(store.recentFills(BOOK, 10)).isEmpty();
        assertThat(store.order(stop).orElseThrow().status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.order(stop).orElseThrow().reason().has(KrIntradayFill.FIELD)).isFalse();
        assertThat(store.positions(BOOK)).extracting(Position::ticker).containsExactly(A);
        assertThat(store.state(BOOK).orElseThrow().cash()).isEqualTo(before.cash());
        assertThat(store.lockouts(BOOK)).isEmpty();
    }
}
