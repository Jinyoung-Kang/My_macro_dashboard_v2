package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.FillConfirmation;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 수용 기준 1 — 벤치마크 두 계좌(2단계 명세 §5 '출발'·K28·K29, 결정 d13 — C3 끝 점검): 한국 초기화 → S 22:30 출발 결정(정기 결정 작업) → S+1 밤
 * 시가 체결(토스 1분봉 {@code TOSS_1M_OPEN}, 리스크 점검) → S+2 밤 금융위 확정 조정(새 관측치 없이 — 리스크 점검) → 순자산이 출발가(금융위 S+1 시가)
 * 대비 ETF 가격 변화와 비용 오차 안에서 같음. 출발 주문은 봉 날짜 ≤ S로 체결되지 않습니다(S 밤 다시 쓴 저장본). 외부 호출 없음 — 가짜 시세
 * 저장본(관측치·공휴일·금융위 메타)과 가짜 관측치 표(증권상품시세)로 돌고, 시각은 움직이는 시계입니다.
 *
 * <p>시각표: S = 2026-11-30(월), S+1 = 12-01(화), S+2 = 12-02(수), S+3 = 12-03(목). 금융위 D 값은 D+1 밤 slow 첫머리(21:58), 토스 관측치는 그 뒤(22:01).
 */
class KrBenchmarkLifecycleTest {

    private static final LocalDate PREV = LocalDate.of(2026, 11, 27);
    private static final LocalDate S = LocalDate.of(2026, 11, 30);
    private static final LocalDate S1 = LocalDate.of(2026, 12, 1);
    private static final LocalDate S2 = LocalDate.of(2026, 12, 2);
    private static final String K200 = PaperBooks.KR_BENCH_K200;
    private static final String MIX = PaperBooks.KR_BENCH_MIX;
    private static final double START_CASH = 100_000_000;

    private FakePaperStore store;
    private StoreReader reader;
    private KrFixtures.MovableClock clock;
    private PaperDecisionJob decisions;
    private PaperRiskJob risk;
    /** 증권상품시세 저장 행(종목 → 기준일 행들, 수집기 normalize_etf 모양)과 그 데이터셋의 최신 기준일. */
    private final Map<String, List<ObjectNode>> etfRows = new HashMap<>();
    private LocalDate etfLatest;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    private static PaperConfig config() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        StoreRepository repository = mock(StoreRepository.class);
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenAnswer(invocation -> etfLatest);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_ETF_PRICE), anyCollection(),
                org.mockito.ArgumentMatchers.any())).thenAnswer(invocation -> {
                    Collection<String> codes = invocation.getArgument(1);
                    LocalDate since = invocation.getArgument(2);
                    Map<String, List<JsonNode>> out = new HashMap<>();
                    for (String code : codes) {
                        List<JsonNode> rows = new ArrayList<>();
                        for (ObjectNode row : etfRows.getOrDefault(code, List.of())) {
                            if (!LocalDate.parse(row.path("obsDate").asString()).isBefore(since)) {
                                rows.add(row.deepCopy());
                            }
                        }
                        if (!rows.isEmpty()) {
                            out.put(code, rows);
                        }
                    }
                    return out;
                });
        PaperMarketData marketData = new PaperMarketData(reader, repository);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        clock = new KrFixtures.MovableClock(kst("2026-11-27T12:00"));
        new PaperAdminService(store, marketData, reader, PaperFixtures.settings(store), ledger, config(),
                PaperFixtures.MAPPER, clock).initKr();
        decisions = new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store), config(),
                PaperFixtures.MAPPER, clock);
        risk = new PaperRiskJob(store, reader, marketData, ledger, config(), PaperFixtures.MAPPER, clock,
                List.of(KrPaperMarket.INSTANCE));
        KrFixtures.stub(reader, Datasets.SNAP_FSC_PRICES_META, KrFixtures.snapshot(Datasets.SNAP_FSC_PRICES_META,
                KrFixtures.fscMeta(PREV), kst("2026-11-30T21:56")));
    }

    // ------------------------------------------------------------------ 도우미
    /** 그 시각으로 시계·DB 시각을 옮깁니다(주문·체결 행의 쓴 시각 = 그 시각). */
    private void at(String kstDateTime) {
        Instant now = kst(kstDateTime);
        clock.set(now);
        store.dbNow = now;
    }

    private Outcome riskAt(String kstDateTime) {
        at(kstDateTime);
        return risk.run(KrPaperMarket.INSTANCE, false);
    }

    /**
     * 그 세션의 관측치 저장본 — ETF 두 종목, 봉 둘(전날 {@code prev}·그날 {@code day}), 그날 1분봉 09:01 시가. 일봉 시가는 일부러 1분봉과 다른 값
     * (사다리 첫 칸이 이김을 보임).
     */
    private void quotes(LocalDate session, LocalDate prev, Instant fetched, Instant collected, double kodexOpen,
                        double kodexClose, double bondOpen, double bondClose) {
        KrFixtures.Payload payload = new KrFixtures.Payload(session);
        payload.etf("069500", fetched).bar(prev, kodexOpen - 600, kodexOpen - 400, 30_000_000)
                .bar(session, kodexOpen + 100, kodexClose, 31_000_000).minute("OK", "09:01", kodexOpen, 380_000);
        payload.etf("153130", fetched).bar(prev, bondOpen - 20, bondOpen - 10, 40_000)
                .bar(session, bondOpen + 10, bondClose, 41_000).minute("OK", "09:01", bondOpen, 2_000);
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, payload.snapshot(collected));
    }

    /** 증권상품시세 하루치(그 기준일까지 받음) — 시가(mkp)·종가·거래량. */
    private void fscEtf(LocalDate day, long kodexOpen, long kodexClose, long bondOpen, long bondClose) {
        etfRows.computeIfAbsent("069500", code -> new ArrayList<>()).add(0, etfRow(day, kodexOpen, kodexClose, 32_000_000));
        etfRows.computeIfAbsent("153130", code -> new ArrayList<>()).add(0, etfRow(day, bondOpen, bondClose, 45_000));
        etfLatest = day;
    }

    private static ObjectNode etfRow(LocalDate day, long open, long close, long volume) {
        ObjectNode row = PaperFixtures.MAPPER.createObjectNode();
        row.put("obsDate", day.toString());
        row.put("open", (double) open);
        row.put("close", (double) close);
        row.put("volume", (double) volume);
        row.put("listedUnits", 120_000_000.0);
        return row;
    }

    private NavRow nav(String book, LocalDate day) {
        return store.navSeries(book).stream().filter(row -> row.tradingDate().equals(day)).findFirst().orElseThrow();
    }

    private List<JobRun> runs(String job) {
        return store.jobRuns.stream().filter(run -> run.job().equals(job)).toList();
    }

    private Position position(String book, String ticker) {
        return store.positions(book).stream().filter(p -> p.ticker().equals(ticker)).findFirst().orElseThrow();
    }

    /** 확정 조정 행들의 비용 합(수수료·세금·슬리피지). */
    private double confirmedCosts(String book) {
        return store.fillConfirmations(book).stream()
                .mapToDouble(c -> c.fee().add(c.tax()).add(c.slippageCost()).doubleValue()).sum();
    }

    @Test
    @DisplayName("수용 기준 1 — 한국 초기화 → S 22:30 출발 → S+1 시가 체결(TOSS_1M_OPEN, S 이하 봉으로는 체결 안 함) → S+2 밤 금융위 확정 조정 → 순자산 = 출발가(금융위 S+1 시가) 대비 ETF 가격 변화 − 비용(그날까지 모두 확정된 줄은 prices_final)")
    void benchmarksFromInitToConfirmedNav() {
        // ---------------------------------------------------------------- S 밤 — 출발
        quotes(S, PREV, kst("2026-11-30T21:57"), kst("2026-11-30T21:58"), 94_000, 94_500, 107_990, 108_000);
        Outcome beforeStart = riskAt("2026-11-30T22:05");
        assertThat(beforeStart.filled()).as("시작 전 계좌 — 주문 없음").isZero();
        at("2026-11-30T22:30");
        assertThat(decisions.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperDecisionJob.STARTED);
        assertThat(store.orders.values()).extracting(Order::bookCode, Order::ticker, Order::timing).containsExactly(
                org.assertj.core.groups.Tuple.tuple(K200, "069500", PaperBooks.NEXT_OPEN),
                org.assertj.core.groups.Tuple.tuple(MIX, "069500", PaperBooks.NEXT_OPEN),
                org.assertj.core.groups.Tuple.tuple(MIX, "153130", PaperBooks.NEXT_OPEN));
        assertThat(nav(K200, S).nav()).isEqualTo(START_CASH);
        assertThat(nav(K200, S).pricesFinal()).as("S 마감 순자산 1억(현금뿐)").isTrue();

        // S 밤 다시 쓴 저장본 — 주문 뒤에 받았지만 봉이 모두 S 이하: 체결하지 않음(K28 '봉 날짜 > S인 시가로만').
        quotes(S, PREV, kst("2026-11-30T23:31"), kst("2026-11-30T23:35"), 94_000, 94_600, 107_990, 108_005);
        Outcome sameNight = riskAt("2026-11-30T23:40");
        assertThat(sameNight.booksProcessed()).contains(K200, MIX);
        assertThat(sameNight.filled()).isZero();
        assertThat(store.fills).as("S 이하 봉으로는 출발 주문을 체결하지 않음").isEmpty();
        assertThat(store.orders.values()).allSatisfy(o -> assertThat(o.status()).isEqualTo(PaperBooks.ORDER_PENDING));

        // ---------------------------------------------------------------- S+1 밤 — 시가 체결(잠정)
        fscEtf(S, 94_100, 94_500, 107_990, 108_000);
        quotes(S1, S, kst("2026-12-01T21:57"), kst("2026-12-01T22:01"), 95_000, 95_400, 108_000, 108_020);
        Outcome opened = riskAt("2026-12-01T22:05");

        assertThat(opened.errors()).isEmpty();
        assertThat(opened.filled()).isEqualTo(3);
        assertThat(store.fills.values()).allSatisfy(f -> {
            assertThat(f.priceSource()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
            assertThat(f.observationDate()).as("출발가 = S+1 시가").isEqualTo(S1);
        });
        Fill kodex = store.fillsOf(K200).get(0);
        assertThat(kodex.qty()).isEqualTo(1_051);
        assertThat(kodex.price()).isEqualTo(95_000);
        assertThat(store.fillsOf(MIX)).extracting(f -> f.ticker() + " " + f.qty()).containsExactly("069500 631", "153130 369");
        assertThat(store.states.get(K200).cash()).isEqualTo(90_102);
        assertThat(store.states.get(MIX).cash()).isEqualTo(138_134);
        assertThat(nav(K200, S1).pricesFinal()).as("토스 잠정가").isFalse();
        assertThat(nav(K200, S1).nav()).isEqualTo(90_102 + 1_051 * 95_400.0);
        List<Fill> provisionalFills = List.copyOf(store.fills.values());

        // ---------------------------------------------------------------- S+2 밤 — 금융위 S+1(관측치보다 먼저) → 확정 조정
        at("2026-12-02T21:58");
        fscEtf(S1, 94_950, 95_380, 108_000, 108_015);
        Outcome confirmed = riskAt("2026-12-02T22:00");

        assertThat(confirmed.errors()).isEmpty();
        assertThat(confirmed.confirmed()).as("새 관측치 없이 체결마다 한 행").isEqualTo(3);
        assertThat(store.fills.values()).as("체결 행은 그대로").containsExactlyElementsOf(provisionalFills);
        // KODEX 200 1,051주: 잠정 95,000(수수료 14,976·슬리피지 49,922) → 확정 94,950(14,968·49,896), 현금 +52,584.
        assertThat(store.fillConfirmations(K200)).singleElement().satisfies(c -> {
            assertThat(c.source()).isEqualTo(FillConfirmation.SOURCE_FSC_ETF);
            assertThat(c.confirmedPrice()).isEqualByComparingTo("94950");
            assertThat(c.fee()).isEqualByComparingTo("14968");
            assertThat(c.slippageCost()).isEqualByComparingTo("49896");
            assertThat(c.cashDelta()).isEqualByComparingTo("52584");
        });
        // 60/40: 069500 631주 확정 94,950(현금 +31,570), 153130 369주는 확정가 = 잠정가라 현금 차이 0인 행(들어오면 언제나 확정).
        assertThat(store.fillConfirmations(MIX)).extracting(c -> c.cashDelta().stripTrailingZeros().toPlainString())
                .containsExactly("31570", "0");
        assertThat(store.states.get(K200).cash()).isEqualTo(90_102 + 52_584);
        assertThat(store.states.get(MIX).cash()).isEqualTo(138_134 + 31_570);
        assertThat(position(K200, "069500").avgCost()).as("평단 = 확정 체결가").isEqualTo(94_950);
        assertThat(position(K200, "069500").highWatermark()).as("max(확정 체결가, 금융위 S+1 종가)").isEqualTo(95_380);
        assertThat(nav(K200, S1).pricesFinal()).as("그날까지 체결 모두 확정·보유 모두 금융위 S+1 종가").isTrue();
        assertThat(nav(K200, S1).nav()).isEqualTo(142_686 + 1_051 * 95_380.0);
        assertThat(nav(MIX, S1).pricesFinal()).isTrue();
        assertThat(nav(MIX, S1).nav()).isEqualTo(169_704 + 631 * 95_380.0 + 369 * 108_015.0);
        assertThat(runs("kr.risk")).last().satisfies(run -> {
            assertThat(run.detail().path("confirmationOnly").asBoolean()).isTrue();
            assertThat(run.detail().path("confirmed").asInt()).isEqualTo(3);
        });

        // S+2 관측치(잠정) → S+3 밤 금융위 S+2 → 그 줄도 확정(새 확정 조정 없이)
        quotes(S2, S1, kst("2026-12-02T22:02"), kst("2026-12-02T22:03"), 95_500, 96_000, 108_020, 108_030);
        Outcome nextNight = riskAt("2026-12-02T22:05");
        assertThat(nextNight.filled()).isZero();
        assertThat(nav(K200, S2).pricesFinal()).isFalse();
        assertThat(nav(K200, S1).pricesFinal()).as("확정 줄은 그대로").isTrue();
        at("2026-12-03T21:58");
        fscEtf(S2, 95_600, 95_990, 108_020, 108_025);
        Outcome nextConfirm = riskAt("2026-12-03T22:00");
        assertThat(nextConfirm.confirmed()).isZero();
        assertThat(nextConfirm.booksProcessed()).as("줄이 확정이 된 계좌").containsExactly(K200, MIX);

        // ---------------------------------------------------------------- 수용 기준 1
        double startPrice = 94_950;   // 출발가 = 금융위 S+1 시가(확정 조정한 체결가)
        double close = 95_990;        // 금융위 S+2 종가
        NavRow k200 = nav(K200, S2);
        assertThat(k200.pricesFinal()).isTrue();
        assertThat(k200.nav()).isEqualTo(142_686 + 1_051 * 95_990.0);
        // 순자산 변화 = 보유 수량 × (확정 종가 − 출발가) − 확정 비용(정확히 — 남는 현금은 움직이지 않음)
        assertThat(k200.nav() - START_CASH).isEqualTo(1_051 * (close - startPrice) - confirmedCosts(K200));
        // 출발가 대비 ETF 가격 변화와의 차이 = 비용 × (종가 ÷ 출발가) + 남는 현금 × 수익률 — 비용 오차 이내
        double ratio = close / startPrice;
        double costError = confirmedCosts(K200) * ratio + k200.cash() * Math.abs(ratio - 1);
        assertThat(Math.abs(k200.nav() - START_CASH * ratio)).isLessThanOrEqualTo(costError + 1e-3);
        assertThat(k200.nav() / START_CASH - 1).as("+1.03% ≈ ETF +1.10% − 비용 6.5bp")
                .isCloseTo(ratio - 1, org.assertj.core.data.Offset.offset(0.001));

        NavRow mix = nav(MIX, S2);
        assertThat(mix.pricesFinal()).isTrue();
        assertThat(mix.nav() - START_CASH).as("60/40 — 두 ETF 각각의 확정 가격 변화 − 확정 비용")
                .isEqualTo(631 * (close - startPrice) + 369 * (108_025.0 - 108_000.0) - confirmedCosts(MIX));
        double blended = 0.6 * ratio + 0.4 * (108_025.0 / 108_000.0);
        assertThat(mix.nav() / START_CASH).as("출발 비중 60/40의 가격 변화와 비용·정수 주 오차 이내")
                .isCloseTo(blended, org.assertj.core.data.Offset.offset(0.001));
        assertThat(store.decisions.values()).as("출발 결정 행은 잠정(금융위 확정 전 가격)")
                .allSatisfy(d -> assertThat(d.pricesFinal()).isFalse());
    }
}
