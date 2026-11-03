package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.TrackRecord13F;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.TrackRecordRow;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 기관 선정 — 후보 목록·q30 저장본·10년 종가로 트랙레코드를 계산해 저장하고, 수집 중·최신 분기 공시 없음(R5)을 자격에서 빼고,
 * 선정을 한 번만 남기는지. 수치 자체(구간 수익률·CAGR)는 {@code TrackRecord13FTest}가 손계산으로 확인하므로, 여기서는 저장본 →
 * 계산 입력으로 옮기는 배관이 같은 값을 내는지 {@link TrackRecord13F#compute}를 직접 부른 값과 대조합니다.
 *
 * <p>날짜: 기준일 2026-10-23(금). 그날 공시 기한이 지난 최신 분기는 2026-06-30(재선정일 2026-08-17 ≤ 10-23, 다음 분기
 * 재선정일 11-17은 뒤). 창은 설정으로 1년(창 시작 2025-10-23)으로 줄여, 분기 공시 다섯 건으로 구간 다섯 개가 됩니다.
 *
 * <p>그룹 B(D27)는 기존 13F 메뉴 12곳의 실제 CIK(Institutions.ALL)이고 창은 기본 2년(창 시작 2024-10-23), 분기 공시 아홉 건
 * ({@link #FILINGS_B})으로 구간 아홉 개입니다. 기본 고정본에는 그룹 B 저장본이 없어(공시 없음) 그룹 A 시험에 끼어들지 않습니다.
 */
class PaperSelectionServiceTest {

    private static final LocalDate AS_OF = LocalDate.of(2026, 10, 23);
    /** 월요일 마감 1시간 뒤(17:00 ET) — 마지막 완료 세션은 2026-10-26. */
    private static final Clock NOW = Clock.fixed(Instant.parse("2026-10-26T21:00:00Z"), ZoneOffset.UTC);
    private static final Instant COLLECTED = Instant.parse("2026-10-24T03:00:00Z");

    private static final String A = "0000000001";   // 완료·최신 분기 공시함 — AAA(오름)
    private static final String B = "0000000002";   // 완료·최신 분기 공시함 — BBB(보합) + 티커 없는 20%
    private static final String C = "0000000003";   // 수집 중(3/30) — 수치는 좋아도 순위에 오르지 않음
    private static final String D = "0000000004";   // 2026-06-30 분기 공시 없음(R5)
    private static final String E = "0000000005";   // q30 저장본 없음

    // 그룹 B(기존 13F 메뉴의 실제 CIK)
    private static final String DUQ = "0001536411";   // q30(ZZZ) + q8(BBB) — q30을 씀, 그룹 A 후보와 겹칠 수 있음
    private static final String FIS = "0000850529";   // q8만(CCC)
    private static final String BRK = "0001067983";   // q8만(AAA)
    private static final String BW = "0001350694";    // q8만(BBB, 보합)
    private static final String VAN = "0000102909";   // q8 — CCC 40% + 티커 없는 60%: 수익률은 높지만 커버리지 미달(인덱스형)
    private static final String SCION = "0001649339"; // q8 — 2026-06-30 분기 공시 없음(R5)

    /** 그룹 B 분기 공시 — 2년 창을 덮는 아홉 분기. */
    private static final List<String[]> FILINGS_B = List.of(
            new String[]{"2024-08-14", "2024-06-30"}, new String[]{"2024-11-14", "2024-09-30"},
            new String[]{"2025-02-14", "2024-12-31"}, new String[]{"2025-05-15", "2025-03-31"},
            new String[]{"2025-08-14", "2025-06-30"}, new String[]{"2025-11-14", "2025-09-30"},
            new String[]{"2026-02-13", "2025-12-31"}, new String[]{"2026-05-15", "2026-03-31"},
            new String[]{"2026-08-14", "2026-06-30"});

    /** 분기 공시일 — 실제 13F 기한 근처(금요일들). */
    private static final List<String[]> FILINGS = List.of(
            new String[]{"2025-08-14", "2025-06-30"}, new String[]{"2025-11-14", "2025-09-30"},
            new String[]{"2026-02-13", "2025-12-31"}, new String[]{"2026-05-15", "2026-03-31"},
            new String[]{"2026-08-14", "2026-06-30"});

    /**
     * 2026-09-30 분기의 재선정일(QA-175) — 공시 기한 11-14(토) → 11-16(월), 다음 거래일 11-17(화). 기한일 EDGAR 마감(22:00 ET)은
     * 11-17 03:00Z입니다. 결정 작업은 그 세션 마감 뒤에 돕니다(16:30 ET = 21:30Z).
     */
    private static final LocalDate R = LocalDate.of(2026, 11, 17);
    private static final Instant BEFORE_CUTOFF = Instant.parse("2026-11-16T20:00:00Z");
    private static final Instant AFTER_CUTOFF = Instant.parse("2026-11-17T12:00:00Z");
    /** FILINGS에 2026-09-30 분기(11-13 공시)를 더한 것. */
    private static final List<String[]> FILINGS_Q3;
    private static final List<String[]> FILINGS_B_Q3;

    static {
        List<String[]> withQ3 = new ArrayList<>(FILINGS);
        withQ3.add(new String[]{"2026-11-13", "2026-09-30"});
        FILINGS_Q3 = List.copyOf(withQ3);
        List<String[]> withQ3B = new ArrayList<>(FILINGS_B);
        withQ3B.add(new String[]{"2026-11-13", "2026-09-30"});
        FILINGS_B_Q3 = List.copyOf(withQ3B);
    }

    private FakePaperStore store;
    private Map<String, Snapshot> snapshots;
    private Map<String, TreeMap<LocalDate, Double>> fullPrices;
    private List<HistoryCall> historyCalls;
    private List<String> loudReads;
    private PaperMarketData marketData;
    private StoreReader reader;
    private PaperSelectionService service;

    private record HistoryCall(TreeSet<String> tickers, LocalDate from, LocalDate to) {
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        snapshots = new HashMap<>();
        historyCalls = new ArrayList<>();
        loudReads = new ArrayList<>();
        fullPrices = new HashMap<>();
        // 기준일 뒤 2개월까지 가격이 있습니다 — 서비스가 기준일 뒤 값을 읽지 않는지 보려고(룩어헤드).
        fullPrices.put("AAA", growth(100, 0.001));
        fullPrices.put("BBB", growth(50, 0.0));
        fullPrices.put("CCC", growth(20, 0.002));
        fullPrices.put("SPY", growth(400, 0.0005));
        fullPrices.put("ZZZ", growth(10, 0.003));

        reader = mock(StoreReader.class);
        ThreadLocal<Integer> quiet = ThreadLocal.withInitial(() -> 0);
        when(reader.quietly(any())).thenAnswer(invocation -> {
            quiet.set(quiet.get() + 1);
            try {
                return ((Supplier<?>) invocation.getArgument(0)).get();
            } finally {
                quiet.set(quiet.get() - 1);
            }
        });
        when(reader.read(anyString(), anyLong(), any())).thenAnswer(invocation -> {
            String name = invocation.getArgument(0);
            if (quiet.get() == 0) {
                loudReads.add(name);   // quietly 밖의 읽기 — 오래된 저장본이면 수집을 깨웁니다
            }
            return Optional.ofNullable(snapshots.get(name));
        });
        // q30은 트리가 아니라 메타·보유 열로 읽습니다(캐시하지 않는 경로) — 같은 고정본에서 DB가 돌려줄 모양을 만듭니다.
        when(reader.readStoredMeta(anyString(), anyString())).thenAnswer(invocation ->
                Optional.ofNullable(snapshots.get((String) invocation.getArgument(0))));
        when(reader.readStoredHoldings(anyString())).thenAnswer(invocation ->
                holdingRows(snapshots.get((String) invocation.getArgument(0))));

        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenAnswer(invocation -> {
            Collection<String> tickers = invocation.getArgument(0);
            LocalDate from = invocation.getArgument(1);
            LocalDate to = invocation.getArgument(2);
            historyCalls.add(new HistoryCall(new TreeSet<>(tickers), from, to));
            // 실제 저장소처럼 범위(포함)로 자르고, 없는 종목은 결과에 없음.
            Map<String, DailySeries> out = new LinkedHashMap<>();
            for (String ticker : tickers) {
                TreeMap<LocalDate, Double> series = fullPrices.get(ticker);
                if (series != null) {
                    out.put(ticker, DailySeries.of(series.subMap(from, true, to, true)));
                }
            }
            return out;
        });

        service = new PaperSelectionService(store, reader, marketData, PaperFixtures.settings(store), MAPPER, NOW);
        settings(1, 1, 2, 0.5, 0.7, "CAGR", null);

        index(A, B, C, D, E);
        q30(A, true, quarters(FILINGS, "AAA", 100.0));
        q30(B, true, quarters(FILINGS, "BBB", 80.0, null, 20.0));
        q30(C, false, quarters(FILINGS.subList(2, 5), "AAA", 100.0));
        q30(D, true, quarters(FILINGS.subList(0, 4), "AAA", 100.0));
    }

    // ------------------------------------------------------------------ 재료
    /** 평일마다 start × (1+daily)^k. 2024-06-03 ~ 2026-12-31. */
    private static TreeMap<LocalDate, Double> growth(double start, double daily) {
        TreeMap<LocalDate, Double> out = new TreeMap<>();
        int k = 0;
        for (LocalDate d = LocalDate.of(2024, 6, 3); !d.isAfter(LocalDate.of(2026, 12, 31)); d = d.plusDays(1)) {
            if (d.getDayOfWeek() != DayOfWeek.SATURDAY && d.getDayOfWeek() != DayOfWeek.SUNDAY) {
                out.put(d, start * Math.pow(1 + daily, k++));
            }
        }
        return out;
    }

    /** 공시마다 같은 보유: 티커·평가액을 번갈아(티커 null = 티커 없는 줄). */
    private static List<Map<String, Object>> quarters(List<String[]> filings, Object... tickerAndValue) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (String[] filing : filings) {
            out.add(quarter(filing[0], filing[1], tickerAndValue));
        }
        return out;
    }

    private static Map<String, Object> quarter(String filingDate, String reportDate, Object... tickerAndValue) {
        List<Map<String, Object>> holdings = new ArrayList<>();
        for (int i = 0; i < tickerAndValue.length; i += 2) {
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("name", "ISSUER " + i);
            h.put("cusip", "00000000" + i);
            h.put("class", "COM");
            h.put("value", tickerAndValue[i + 1]);
            h.put("shares", 1000);
            h.put("ticker", tickerAndValue[i]);
            holdings.add(h);
        }
        Map<String, Object> q = new LinkedHashMap<>();
        q.put("filingDate", filingDate);
        q.put("reportDate", reportDate);
        q.put("totalValue", 100);
        q.put("holdings", holdings);
        return q;
    }

    private void q30(String cik, boolean complete, List<Map<String, Object>> quarters) {
        q30(cik, complete, quarters, COLLECTED);
    }

    /** q30 저장본 — 수집 시각(저장본 collected_at)을 정해서. */
    private void q30(String cik, boolean complete, List<Map<String, Object>> quarters, Instant collectedAt) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("cik", cik);
        payload.put("name", "기관 " + cik);
        payload.put("style", "가치·집중");
        payload.put("predecessors", List.of());
        payload.put("quarters", quarters);
        payload.put("complete", complete);
        payload.put("fetchedThisRun", 0);
        snapshot(Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS), payload, collectedAt);
    }

    /** 기존 메뉴 저장본(q8) — 완료 표시가 없는 모양(task_sec_13f). */
    private void q8(String cik, List<Map<String, Object>> quarters) {
        q8(cik, quarters, COLLECTED);
    }

    private void q8(String cik, List<Map<String, Object>> quarters, Instant collectedAt) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("cik", cik);
        payload.put("error", null);
        payload.put("quarters", quarters);
        snapshot(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), payload, collectedAt);
    }

    /** 그룹 B 고정본 — 클래스 상수 설명대로. 기대 순위(CAGR): DUQ(ZZZ) · FIS(CCC) · BRK(AAA) · BW(BBB). */
    private void groupBFixture() {
        q30(DUQ, true, quarters(FILINGS_B, "ZZZ", 100.0));
        q8(DUQ, quarters(FILINGS_B, "BBB", 100.0));
        q8(FIS, quarters(FILINGS_B, "CCC", 100.0));
        q8(BRK, quarters(FILINGS_B, "AAA", 100.0));
        q8(BW, quarters(FILINGS_B, "BBB", 100.0));
        q8(VAN, quarters(FILINGS_B, "CCC", 40.0, null, 60.0));
        q8(SCION, quarters(FILINGS_B.subList(0, 8), "ZZZ", 100.0));
    }

    private Map<String, TrackRecordRow> rowsB(LocalDate asOf) {
        Map<String, TrackRecordRow> out = new LinkedHashMap<>();
        store.trackRecords(asOf, "B").forEach(r -> out.put(r.cik(), r));
        return out;
    }

    /** 그룹 B 기준(2년 창, 구간 6, 커버리지 0.5·0.7)으로 계산 함수를 직접 부른 값. */
    private TrackRecord13F.Result directB(String cik, List<TrackRecord13F.Filing> filings) {
        LocalDate from = AS_OF.minusYears(2).minusDays(PaperSelectionService.PRICE_MARGIN_DAYS);
        Map<String, DailySeries> prices = new HashMap<>();
        fullPrices.forEach((t, s) -> prices.put(t, DailySeries.of(s.subMap(from, true, AS_OF, true))));
        return TrackRecord13F.compute(cik, filings, prices::get, prices.get("SPY"), AS_OF,
                new TrackRecord13F.Criteria(2, 6, 0.5, 0.7));
    }

    private void index(String... ciks) {
        List<Map<String, Object>> filers = new ArrayList<>();
        for (String cik : ciks) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("cik", cik);
            f.put("name", "기관 " + cik);
            f.put("style", cik.equals(E) ? "매크로" : "가치·집중");
            f.put("predecessors", List.of());
            f.put("storedQuarters", switch (cik) {
                case C -> 3;
                case D -> 4;
                case E -> 0;
                default -> 5;
            });
            f.put("complete", !cik.equals(C) && !cik.equals(E));
            f.put("lastFilingDate", "2026-08-14");
            f.put("lastReportDate", "2026-06-30");
            f.put("updatedAt", "2026-10-24T03:00:00+00:00");
            filers.add(f);
        }
        snapshot(Datasets.SNAP_TRACK_RECORD_INDEX, Map.of("filers", filers, "targetQuarters", 30, "budget", 400));
    }

    private void snapshot(String name, Object payload) {
        snapshot(name, payload, COLLECTED);
    }

    private void snapshot(String name, Object payload, Instant collectedAt) {
        JsonNode json = MAPPER.valueToTree(payload);
        snapshots.put(name, new Snapshot(name, json, "json", "ok", null, collectedAt));
    }

    /** 설정 행(버전 version)의 trackRecord 값을 바꿉니다. 나머지 키는 기본값. */
    private void settings(int version, int windowYears, int minPeriods, double minCoverage, double avgCoverage,
                          String metric, List<String> candidateCiks) {
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        ObjectNode track = (ObjectNode) body.get("trackRecord");
        track.put("windowYears", windowYears);
        track.put("minPeriods", minPeriods);
        track.put("minCoverage", minCoverage);
        track.put("avgCoverage", avgCoverage);
        track.put("metric", metric);
        track.put("topN", 2);
        if (candidateCiks == null) {
            track.putNull("candidateCiks");
        } else {
            track.set("candidateCiks", MAPPER.valueToTree(candidateCiks));
        }
        store.settings = new SettingsRow(version, body, store.dbNow);
        store.settingsHistory.put(version, store.settings);
    }

    private Map<String, TrackRecordRow> rows(LocalDate asOf) {
        Map<String, TrackRecordRow> out = new LinkedHashMap<>();
        store.trackRecords(asOf).forEach(r -> out.put(r.cik(), r));
        return out;
    }

    /** 같은 입력을 계산 함수에 직접 넣은 값 — 가격은 기준일까지만. */
    private TrackRecord13F.Result direct(String cik, List<TrackRecord13F.Filing> filings) {
        LocalDate from = AS_OF.minusYears(1).minusDays(PaperSelectionService.PRICE_MARGIN_DAYS);
        Map<String, DailySeries> prices = new HashMap<>();
        fullPrices.forEach((t, s) -> prices.put(t, DailySeries.of(s.subMap(from, true, AS_OF, true))));
        return TrackRecord13F.compute(cik, filings, prices::get, prices.get("SPY"), AS_OF,
                new TrackRecord13F.Criteria(1, 2, 0.5, 0.7));
    }

    private static List<TrackRecord13F.Filing> filings(List<String[]> filings, Object... tickerAndValue) {
        List<TrackRecord13F.Filing> out = new ArrayList<>();
        for (String[] f : filings) {
            List<TrackRecord13F.Holding13F> holdings = new ArrayList<>();
            for (int i = 0; i < tickerAndValue.length; i += 2) {
                holdings.add(new TrackRecord13F.Holding13F((String) tickerAndValue[i],
                        ((Number) tickerAndValue[i + 1]).doubleValue()));
            }
            out.add(new TrackRecord13F.Filing(LocalDate.parse(f[0]), LocalDate.parse(f[1]), holdings));
        }
        return out;
    }

    // ------------------------------------------------------------------ 계산
    @Test
    @DisplayName("계산: 후보 다섯 곳을 모두 저장하고, 자격 있는 둘만 CAGR 순위 — 값은 계산 함수를 직접 부른 것과 같다")
    void computeStoresAllCandidatesAndRanksEligible() {
        PaperSelectionService.Computation computation = service.compute(AS_OF);

        assertThat(computation.skippedReason()).isNull();
        assertThat(computation.latestQuarter()).isEqualTo(LocalDate.of(2026, 6, 30));
        assertThat(computation.settingsVersion()).isEqualTo(1);
        assertThat(computation.ranked()).extracting(PaperSelectionService.Scored::cik).containsExactly(A, B);

        Map<String, TrackRecordRow> rows = rows(AS_OF);
        assertThat(rows.keySet()).containsExactlyInAnyOrder(A, B, C, D, E);
        TrackRecordRow a = rows.get(A);
        TrackRecord13F.Result expected = direct(A, filings(FILINGS, "AAA", 100.0));
        assertThat(a.rank()).isEqualTo(1);
        assertThat(a.eligible()).isTrue();
        assertThat(a.ineligibleReason()).isNull();
        assertThat(a.periodsUsed()).isEqualTo(5).isEqualTo(expected.periodsUsed());
        assertThat(a.cagrPct()).isCloseTo(expected.cagrPct(), within(1e-12));
        assertThat(a.cumReturnPct()).isCloseTo(expected.cumReturnPct(), within(1e-12));
        assertThat(a.excessVsSpyPct()).isCloseTo(expected.excessVsSpyPct(), within(1e-12));
        assertThat(a.coverageMin()).isEqualTo(1.0);
        assertThat(a.windowYears()).isEqualTo(1);
        assertThat(a.metric()).isEqualTo("CAGR");
        assertThat(a.settingsVersion()).isEqualTo(1);
        assertThat(a.lastFilingDate()).isEqualTo(LocalDate.of(2026, 8, 14));
        assertThat(a.periods()).hasSize(5);
        assertThat(a.periods().get(0).path("start").asString()).as("첫 구간은 창 시작으로 자름").isEqualTo("2025-10-23");
        assertThat(a.periods().get(4).path("end").asString()).isEqualTo("2026-10-23");

        // 티커 없는 20%는 총평가액에 들어가 커버리지 0.8 — 수익률은 커버된 BBB(보합)만으로 재정규화.
        TrackRecordRow b = rows.get(B);
        assertThat(b.rank()).isEqualTo(2);
        assertThat(b.coverageMin()).isCloseTo(0.8, within(1e-12));
        assertThat(b.cagrPct()).isCloseTo(0.0, within(1e-9));
        assertThat(b.cagrPct()).isCloseTo(direct(B, filings(FILINGS, "BBB", 80.0)).cagrPct(), within(1e-9));
    }

    @Test
    @DisplayName("수집 중(complete=false)인 기관은 수치가 좋아도 자격 없음 — 사유 '수집 중(저장 분기 3/30)'")
    void collectingCandidateIsExcluded() {
        service.compute(AS_OF);

        TrackRecordRow c = rows(AS_OF).get(C);
        assertThat(c.eligible()).isFalse();
        assertThat(c.rank()).isNull();
        assertThat(c.ineligibleReason()).startsWith("수집 중(저장 분기 3/30)");
        assertThat(c.cagrPct()).as("수치는 그대로 계산해 보임").isNotNull();
        assertThat(c.cagrPct()).as("B보다 좋아도 순위 밖").isGreaterThan(rows(AS_OF).get(B).cagrPct());

        TrackRecordRow e = rows(AS_OF).get(E);
        assertThat(e.ineligibleReason()).isEqualTo("수집 중(저장 분기 0/30); 공시 없음");
        assertThat(e.cagrPct()).isNull();
        assertThat(e.periodsUsed()).isZero();
    }

    @Test
    @DisplayName("R5: 기준일에 공시 기한이 지난 최신 분기(2026-06-30)를 공시하지 않은 기관은 자격 없음")
    void missingLatestQuarterIsExcluded() {
        PaperSelectionService.Computation computation = service.compute(AS_OF);

        TrackRecordRow d = rows(AS_OF).get(D);
        assertThat(d.eligible()).isFalse();
        assertThat(d.rank()).isNull();
        assertThat(d.ineligibleReason()).isEqualTo("최신 분기(2026-06-30) 공시 없음");
        assertThat(d.cagrPct()).as("AAA를 들어 A만큼 좋지만 순위 밖").isNotNull();
        assertThat(computation.candidates().stream().filter(s -> s.cik().equals(D)).findFirst().orElseThrow()
                .missingLatest()).isTrue();
    }

    @Test
    @DisplayName("기준일로 자르기: 기준일 뒤 공시(티커 포함)·가격을 쓰지 않는다 — 가격은 한 번에, 기준일까지만 읽음")
    void cutsAtAsOf() {
        // A는 기준일 다음 거래일에 새 공시(ZZZ), D는 기준일 뒤에야 2026-06-30 분기를 공시(늦은 공시).
        List<Map<String, Object>> withLate = new ArrayList<>(quarters(FILINGS, "AAA", 100.0));
        withLate.add(quarter("2026-10-26", "2026-09-30", "ZZZ", 100.0));
        q30(A, true, withLate);
        List<Map<String, Object>> lateD = new ArrayList<>(quarters(FILINGS.subList(0, 4), "AAA", 100.0));
        lateD.add(quarter("2026-10-26", "2026-06-30", "AAA", 100.0));
        q30(D, true, lateD);
        // 기준일 뒤 AAA가 10배가 돼도 결과는 같아야 합니다.
        TreeMap<LocalDate, Double> aaa = fullPrices.get("AAA");
        for (LocalDate day : new ArrayList<>(aaa.tailMap(AS_OF, false).keySet())) {
            aaa.put(day, aaa.get(day) * 10);
        }

        service.compute(AS_OF);

        assertThat(historyCalls).as("가격은 한 번에 읽음").hasSize(1);
        HistoryCall call = historyCalls.get(0);
        assertThat(call.to()).isEqualTo(AS_OF);
        assertThat(call.from()).isEqualTo(AS_OF.minusYears(1).minusDays(14));
        assertThat(call.tickers()).containsExactly("AAA", "BBB", "SPY").doesNotContain("ZZZ");

        TrackRecordRow a = rows(AS_OF).get(A);
        assertThat(a.lastFilingDate()).isEqualTo(LocalDate.of(2026, 8, 14));
        assertThat(a.cagrPct()).isCloseTo(direct(A, filings(FILINGS, "AAA", 100.0)).cagrPct(), within(1e-12));
        assertThat(rows(AS_OF).get(D).ineligibleReason()).isEqualTo("최신 분기(2026-06-30) 공시 없음");
    }

    @Test
    @DisplayName("저장본은 모두 quietly로 읽는다 — 버튼·화면이 SEC 수집을 깨우지 않음")
    void readsQuietly() {
        service.compute(AS_OF);
        service.trackRecord(null);
        service.rerank(null);

        assertThat(loudReads).isEmpty();
    }

    @Test
    @DisplayName("후보 목록 저장본이 없으면 아무것도 쓰지 않고 사유만 — 설정 행도 만들지 않음")
    void noIndexWritesNothing() {
        snapshots.remove(Datasets.SNAP_TRACK_RECORD_INDEX);
        store.settings = null;

        PaperSelectionService.Computation computation = service.compute(AS_OF);
        assertThat(computation.skippedReason()).contains("sec.13f.track_record_index");
        assertThat(computation.candidates()).isEmpty();
        assertThat(store.trackRecords).isEmpty();
        assertThat(store.settings).isNull();
        assertThat(historyCalls).isEmpty();

        PaperSelectionService.SelectionOutcome outcome = service.select(AS_OF);
        assertThat(outcome.selection()).isNull();
        assertThat(outcome.skippedReason()).isNotNull();
        assertThat(store.selections).as("모르는 것을 '자격 기관 없음'으로 굳히지 않음").isEmpty();

        Map<String, Object> rerank = service.rerank("2026-10-23");
        assertThat(rerank.get("ok")).isEqualTo(true);
        assertThat(rerank.get("computed")).isEqualTo(0);
        assertThat((String) rerank.get("skippedReason")).contains("sec_13f_track_record");
    }

    @Test
    @DisplayName("설정이 없으면 기본값(후보 27곳·창 7년)으로 설정 행을 만들고 그 버전으로 저장 — 목록 밖 CIK는 계산하지 않음")
    void createsSettingsRowWhenMissing() {
        store.settings = null;
        store.settingsHistory.clear();
        String berkshire = "0001067983";   // 기본 후보 목록(PaperSettingsService.CANDIDATE_CIKS)에 있는 CIK
        index(berkshire, A);
        q30(berkshire, true, quarters(FILINGS, "AAA", 100.0));

        service.compute(AS_OF);

        assertThat(store.settings).isNotNull();
        assertThat(store.settings.version()).isEqualTo(1);
        assertThat(rows(AS_OF).keySet()).as("A는 기본 후보 목록에 없음").containsExactly(berkshire);
        TrackRecordRow row = rows(AS_OF).get(berkshire);
        assertThat(row.windowYears()).isEqualTo(7);
        assertThat(row.settingsVersion()).isEqualTo(1);
        assertThat(row.ineligibleReason()).isEqualTo("구간 5개 < 24");
    }

    @Test
    @DisplayName("설정 candidateCiks가 있으면 그 기관만(10자리로 맞춰 비교), 다시 계산하면 빠진 기관의 옛 행은 지워짐")
    void candidateFilterAndOverwrite() {
        service.compute(AS_OF);
        assertThat(rows(AS_OF)).hasSize(5);

        settings(2, 1, 2, 0.5, 0.7, "CAGR", List.of("2", "0000000001", "  0000000002 ", "abc"));
        service.compute(AS_OF);

        assertThat(rows(AS_OF).keySet()).containsExactlyInAnyOrder(A, B);
        assertThat(rows(AS_OF).get(A).settingsVersion()).isEqualTo(2);
    }

    @Test
    @DisplayName("설정의 순위 기준을 따른다 — SPY 대비 초과로 바꾸면 그 값의 내림차순")
    void metricFromSettings() {
        q30(B, true, quarters(FILINGS, "CCC", 100.0));
        settings(1, 1, 2, 0.5, 0.7, "excess_vs_spy", null);

        service.compute(AS_OF);

        assertThat(rows(AS_OF).get(B).rank()).isEqualTo(1);
        assertThat(rows(AS_OF).get(B).metric()).isEqualTo("EXCESS_VS_SPY");
        assertThat(rows(AS_OF).get(A).rank()).isEqualTo(2);
    }

    @Test
    @DisplayName("설정 값이 틀리면 그 키만 기본값으로 읽고 fallbacks에 남긴다")
    void settingsFallbacks() {
        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode track = body.putObject("trackRecord");
        track.put("windowYears", 0);
        track.put("minPeriods", 3);
        track.put("minCoverage", 1.5);
        track.put("avgCoverage", 0.6);
        track.put("metric", "MOON");
        track.put("topN", 3);
        track.put("candidateCiks", "전부");

        PaperSelectionService.TrackRecordSettings parsed = PaperSelectionService.TrackRecordSettings.from(body);

        assertThat(parsed.criteria()).isEqualTo(new TrackRecord13F.Criteria(7, 3, 0.5, 0.6));
        assertThat(parsed.metric()).isEqualTo(TrackRecord13F.Metric.CAGR);
        assertThat(parsed.topN()).isEqualTo(3);
        assertThat(parsed.candidateCiks()).as("목록이 아니면 전부").isNull();
        assertThat(parsed.fallbacks()).containsExactly("trackRecord.windowYears", "trackRecord.minCoverage",
                "trackRecord.metric", "trackRecord.candidateCiks");
        assertThat(PaperSelectionService.TrackRecordSettings.from(null)).isEqualTo(
                PaperSelectionService.TrackRecordSettings.defaults());
    }

    // ------------------------------------------------------------------ 선정
    @Test
    @DisplayName("선정: 자격 상위 topN을 한 번 남긴다 — 같은 기준일에 다시 부르면 계산하지 않고 그대로")
    void selectOnce() {
        PaperSelectionService.SelectionOutcome first = service.select(AS_OF);

        assertThat(first.created()).isTrue();
        assertThat(first.selection().selectedCiks()).containsExactly(A, B);
        assertThat(first.selection().settingsVersion()).isEqualTo(1);
        JsonNode ranking = first.selection().ranking();
        assertThat(ranking.path("groupA")).hasSize(2);
        assertThat(ranking.path("groupA").get(0).path("cik").asString()).isEqualTo(A);
        assertThat(ranking.path("groupA").get(0).path("selected").asBoolean()).isTrue();
        assertThat(ranking.path("groupB")).as("그룹 B 저장본 없음").isEmpty();
        assertThat(ranking.path("pool")).extracting(m -> m.path("cik").asString()).containsExactly(A, B);
        assertThat(ranking.path("groupWeightA").asDouble()).isEqualTo(0.5);
        assertThat(historyCalls).hasSize(1);

        PaperSelectionService.SelectionOutcome again = service.select(AS_OF);
        assertThat(again.created()).isFalse();
        assertThat(again.computation()).as("이미 선정이 있으면 계산하지 않음").isNull();
        assertThat(again.selection().selectedCiks()).containsExactly(A, B);
        assertThat(historyCalls).hasSize(1);

        assertThat(service.latestSelection()).map(Selection::asOfDate).contains(AS_OF);
        assertThat(service.selectionOn(AS_OF.plusDays(30))).map(Selection::asOfDate).contains(AS_OF);
        assertThat(service.selectionOn(AS_OF.minusDays(1))).isEmpty();
    }

    @Test
    @DisplayName("수동 재계산은 트랙레코드만 덮어쓰고 선정은 바꾸지 않는다(selectedUnchanged)")
    void rerankDoesNotChangeSelection() {
        service.select(AS_OF);
        assertThat(rows(AS_OF).get(A).rank()).isEqualTo(1);

        // 수집이 더 돌아 B의 보유가 바뀐 상황 — 이제 B가 1위.
        q30(B, true, quarters(FILINGS, "CCC", 100.0));
        Map<String, Object> response = service.rerank("2026-10-23");

        assertThat(response.get("ok")).isEqualTo(true);
        assertThat(response.get("asOfDate")).isEqualTo("2026-10-23");
        assertThat(response.get("computed")).isEqualTo(5);
        assertThat(response.get("eligible")).isEqualTo(2);
        assertThat(response.get("collecting")).isEqualTo(2);
        assertThat(response.get("selectedUnchanged")).isEqualTo(true);
        assertThat(rows(AS_OF).get(B).rank()).as("트랙레코드는 새 값").isEqualTo(1);
        assertThat(store.selections.get(AS_OF).selectedCiks()).as("선정은 그대로").containsExactly(A, B);
        assertThat(service.select(AS_OF).selection().selectedCiks()).containsExactly(A, B);
    }

    @Test
    @DisplayName("수동 재계산: 기준일이 없으면 마지막 완료 세션, 끝나지 않은 세션·형식 오류는 400, 겹치면 429")
    void rerankArguments() throws Exception {
        assertThat(service.rerank(null).get("asOfDate")).isEqualTo("2026-10-26");
        assertThat(service.rerank("2026-10-25").get("asOfDate")).as("일요일 — 금요일 세션까지 끝남")
                .isEqualTo("2026-10-25");
        assertThatThrownBy(() -> service.rerank("2026-10-27")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("2026-10-26");
        assertThatThrownBy(() -> service.rerank("2026-13-01")).isInstanceOf(InvalidRequestException.class);

        // 다른 스레드가 계산 중이면 기다리지 않고 429.
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(marketData.history(anyCollection(), any(), any())).thenAnswer(invocation -> {
            inside.countDown();
            release.await(5, TimeUnit.SECONDS);
            return Map.of();
        });
        Thread job = new Thread(() -> service.compute(AS_OF));
        job.start();
        assertThat(inside.await(5, TimeUnit.SECONDS)).isTrue();
        try {
            assertThatThrownBy(() -> service.rerank("2026-10-23")).isInstanceOf(TooManyRequestsException.class);
        } finally {
            release.countDown();
            job.join(5000);
        }
    }

    // ------------------------------------------------------------------ 조회
    @Test
    @DisplayName("조회: 계산 전이면 computed:false와 수집 진행률·지금 설정, 계산 뒤에는 후보·선정·이력")
    @SuppressWarnings("unchecked")
    void trackRecordResponse() {
        Map<String, Object> before = service.trackRecord(null);
        assertThat(before.get("available")).isEqualTo(true);
        assertThat(before.get("computed")).isEqualTo(false);
        assertThat(before.get("asOfDate")).isNull();
        assertThat((List<Object>) before.get("candidates")).isEmpty();
        assertThat(before.get("windowYears")).isEqualTo(1);
        Map<String, Object> collection = (Map<String, Object>) before.get("collection");
        assertThat(collection).containsEntry("filers", 5).containsEntry("completeCount", 3)
                .containsEntry("storedFilings", 17).containsEntry("targetFilings", 150)
                .containsEntry("targetQuarters", 30);
        assertThat((String) collection.get("updatedAtKst")).isNotBlank();
        assertThat((List<String>) before.get("limits")).hasSize(3);

        service.select(AS_OF);
        Map<String, Object> after = service.trackRecord(null);
        assertThat(after.get("computed")).isEqualTo(true);
        assertThat(after.get("asOfDate")).isEqualTo("2026-10-23");
        assertThat(after.get("metric")).isEqualTo("CAGR");
        assertThat((Map<String, Object>) after.get("criteria")).containsEntry("windowYears", 1)
                .containsEntry("minPeriods", 2).containsEntry("minCoverage", 0.5).containsEntry("avgCoverage", 0.7);
        assertThat((List<String>) after.get("selected")).containsExactly(A, B);
        assertThat(after.get("selectedAsOfDate")).isEqualTo("2026-10-23");
        assertThat((List<Map<String, Object>>) after.get("selectionHistory")).hasSize(1);

        List<Map<String, Object>> candidates = (List<Map<String, Object>>) after.get("candidates");
        assertThat(candidates).extracting(c -> c.get("cik")).as("순위 순, 나머지는 수집 목록 순")
                .containsExactly(A, B, C, D, E);
        Map<String, Object> a = candidates.get(0);
        assertThat(a).containsEntry("rank", 1).containsEntry("eligible", true).containsEntry("selected", true)
                .containsEntry("collecting", false).containsEntry("complete", true).containsEntry("storedQuarters", 5)
                .containsEntry("name", "기관 " + A).containsEntry("style", "가치·집중")
                .containsEntry("coverageMin", 1.0).containsEntry("periodsUsed", 5);
        TrackRecord13F.Result expected = direct(A, filings(FILINGS, "AAA", 100.0));
        assertThat((Double) a.get("spyCumReturnPct")).as("초과에서 되돌린 SPY 누적")
                .isCloseTo(expected.spyCumReturnPct(), within(0.006));
        assertThat((Double) a.get("cagrPct")).isCloseTo(expected.cagrPct(), within(0.006));
        List<Map<String, Object>> periods = (List<Map<String, Object>>) a.get("periods");
        assertThat(periods).hasSize(5);
        assertThat(periods.get(0)).containsEntry("start", "2025-10-23").containsEntry("coverage", 1.0)
                .containsEntry("coveredTickers", 1).containsEntry("holdings", 1);

        Map<String, Object> c = candidates.get(2);
        assertThat(c).containsEntry("collecting", true).containsEntry("rank", null).containsEntry("selected", false)
                .containsEntry("complete", false).containsEntry("storedQuarters", 3);
        assertThat(candidates.get(4)).containsEntry("cagrPct", null).containsEntry("spyCumReturnPct", null);

        // 계산한 적 없는 기준일 — computed:false, 그날 유효한 선정은 보임.
        Map<String, Object> other = service.trackRecord("2026-12-01");
        assertThat(other.get("computed")).isEqualTo(false);
        assertThat(other.get("asOfDate")).isEqualTo("2026-12-01");
        assertThat((List<String>) other.get("selected")).containsExactly(A, B);
        assertThatThrownBy(() -> service.trackRecord("12/01/2026")).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("테이블이 없으면 조회는 available:false, 재계산은 ok:false — 500이 아님")
    void notReady() {
        store.ready = false;

        Map<String, Object> get = service.trackRecord(null);
        assertThat(get.get("available")).isEqualTo(false);
        assertThat((String) get.get("message")).contains("make up");
        Map<String, Object> post = service.rerank(null);
        assertThat(post.get("ok")).isEqualTo(false);
        assertThat(post.get("available")).isEqualTo(false);
        assertThat(service.latestSelection()).isEmpty();
        assertThatThrownBy(() -> service.compute(AS_OF)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("개요 응답에 가장 최근 선정의 요지 {asOfDate, groupA, groupB, pool:[{cik,name,groups,weight}]}가 실린다(D27), 없으면 null")
    void overviewCarriesLatestSelection() {
        PaperQueryService query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(),
                PaperFixtures.settings(store), PaperFixtures.config(), NOW);
        when(marketData.quotes()).thenReturn(Optional.empty());
        assertThat(query.overview().get("selection")).isNull();

        groupBFixture();
        service.select(AS_OF);

        Map<String, Object> first = new LinkedHashMap<>();
        first.put("cik", A);
        first.put("name", "기관 " + A);
        first.put("rank", 1);
        Map<String, Object> second = new LinkedHashMap<>();
        second.put("cik", B);
        second.put("name", "기관 " + B);
        second.put("rank", 2);
        @SuppressWarnings("unchecked")
        Map<String, Object> selection = (Map<String, Object>) query.overview().get("selection");
        assertThat(selection.get("asOfDate")).isEqualTo("2026-10-23");
        assertThat(selection.get("groupA")).isEqualTo(List.of(first, second));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> groupB = (List<Map<String, Object>>) selection.get("groupB");
        assertThat(groupB).extracting(r -> r.get("cik")).containsExactly(DUQ, FIS, BRK, BW);
        assertThat(groupB.get(0)).containsEntry("rank", 1).containsEntry("name", "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pool = (List<Map<String, Object>>) selection.get("pool");
        assertThat(pool).extracting(r -> r.get("cik")).containsExactly(A, B, DUQ, FIS, BRK, BW);
        assertThat(pool.get(0)).containsEntry("groups", List.of("A"));
        assertThat((Double) pool.get(2).get("weight")).as("B1 = 0.5 × 4/10").isCloseTo(0.2, within(1e-12));
        assertThat(pool.stream().mapToDouble(r -> (Double) r.get("weight")).sum()).isCloseTo(1.0, within(1e-12));

        // 섞기 전 모양(순위표 배열)의 선정 — 그룹 A만, 순위표에 없는 CIK는 이름·순위를 지어내지 않고 null.
        store.selections.clear();
        store.insertSelectionIfAbsent(new Selection(AS_OF, List.of("0000000099"), MAPPER.createArrayNode(), 1, null));
        Map<String, Object> unknown = new LinkedHashMap<>();
        unknown.put("cik", "0000000099");
        unknown.put("name", null);
        unknown.put("rank", null);
        Map<String, Object> pooled = new LinkedHashMap<>();
        pooled.put("cik", "0000000099");
        pooled.put("name", null);
        pooled.put("groups", List.of("A"));
        pooled.put("weight", 1.0);
        assertThat(query.overview().get("selection")).isEqualTo(Map.of("asOfDate", "2026-10-23",
                "groupA", List.of(unknown), "groupB", List.of(), "pool", List.of(pooled)));
    }

    @Test
    @DisplayName("창 안 공시의 티커만 — 창 시작 전에 끝난 구간의 공시 티커는 읽지 않음")
    void windowTickersSkipsOldFilings() {
        List<TrackRecord13F.Filing> filings = new ArrayList<>(filings(FILINGS, "AAA", 1.0));
        filings.add(0, new TrackRecord13F.Filing(LocalDate.of(2025, 5, 15), LocalDate.of(2025, 3, 31),
                List.of(new TrackRecord13F.Holding13F("OLD", 1.0))));
        filings.add(new TrackRecord13F.Filing(LocalDate.of(2026, 10, 26), null,
                List.of(new TrackRecord13F.Holding13F("LATE", 1.0))));

        assertThat(PaperSelectionService.windowTickers(filings, AS_OF, AS_OF.minusYears(1))).containsExactly("AAA");
        assertThat(PaperSelectionService.normalizeCik("1067983")).isEqualTo("0001067983");
        assertThat(PaperSelectionService.normalizeCik("CIK1")).isNull();
    }

    @Test
    @DisplayName("같은 날 낸 두 공시가 창 시작 경계에 걸려도 계산이 뒤 분기로 만드는 구간의 티커를 읽는다(리뷰 1 결함 1)")
    void windowTickersSameDayFilingsAtWindowStart() {
        // 2019-10-18(금)에 두 분기(AAA 6월 말, BBB 9월 말)를 한꺼번에 내고 다음 공시는 2019-11-14. 7년 창 시작 2019-10-23은
        // 10-18의 다음 거래일(10-21)보다 뒤, 11-14의 다음 거래일(11-15)보다 앞 — 첫 구간 [10-23, 11-15]는 BBB 보유로 계산됩니다.
        // 저장본 순서(보고일 내림차순)대로 넘깁니다.
        LocalDate asOf = LocalDate.of(2026, 10, 23);
        LocalDate windowStart = asOf.minusYears(7);
        List<TrackRecord13F.Filing> filings = List.of(
                new TrackRecord13F.Filing(LocalDate.of(2019, 11, 14), LocalDate.of(2019, 12, 31),
                        List.of(new TrackRecord13F.Holding13F("CCC", 1.0))),
                new TrackRecord13F.Filing(LocalDate.of(2019, 10, 18), LocalDate.of(2019, 9, 30),
                        List.of(new TrackRecord13F.Holding13F("BBB", 1.0))),
                new TrackRecord13F.Filing(LocalDate.of(2019, 10, 18), LocalDate.of(2019, 6, 30),
                        List.of(new TrackRecord13F.Holding13F("AAA", 1.0))));

        assertThat(PaperSelectionService.windowTickers(filings, asOf, windowStart)).contains("BBB", "CCC");

        // 계산 쪽과 대조: 가격을 windowTickers로 고른 종목만 주면, 첫 구간의 커버리지가 1이어야 합니다(빠진 티커 없음).
        Set<String> chosen = PaperSelectionService.windowTickers(filings, asOf, windowStart);
        TreeMap<LocalDate, Double> flat = new TreeMap<>();
        for (LocalDate d = LocalDate.of(2019, 9, 1); !d.isAfter(asOf); d = d.plusDays(1)) {
            if (d.getDayOfWeek() != DayOfWeek.SATURDAY && d.getDayOfWeek() != DayOfWeek.SUNDAY) {
                flat.put(d, 10.0);
            }
        }
        DailySeries series = DailySeries.of(flat);
        TrackRecord13F.Result result = TrackRecord13F.compute("x", filings,
                ticker -> chosen.contains(ticker) ? series : null, series, asOf,
                new TrackRecord13F.Criteria(7, 0, 0.0, 0.0));
        TrackRecord13F.Period firstPeriod = result.periods().get(0);
        assertThat(firstPeriod.reportDate()).isEqualTo(LocalDate.of(2019, 9, 30));
        assertThat(firstPeriod.start()).isEqualTo(windowStart);
        assertThat(firstPeriod.coverage()).as("BBB 가격을 읽었어야 함").isEqualTo(1.0);
    }

    @Test
    @DisplayName("자격 기관 0곳인데 수집 중인 후보가 있으면 선정을 남기지 않는다 — 수집이 끝나면 그 기준일에 선정(리뷰 2 결함 1)")
    void selectWaitsWhileCollecting() {
        // 처음 기동한 뒤 30분기를 채우는 중: 자격이 될 A·B도 아직 수집 중.
        q30(A, false, quarters(FILINGS, "AAA", 100.0));
        q30(B, false, quarters(FILINGS, "BBB", 80.0, null, 20.0));

        PaperSelectionService.SelectionOutcome waiting = service.select(AS_OF);

        assertThat(waiting.selection()).isNull();
        assertThat(waiting.created()).isFalse();
        assertThat(waiting.skippedReason()).startsWith("수집 중 4곳(후보 5곳)");
        assertThat(waiting.computation()).isNotNull();
        assertThat(store.selections).as("빈 선정을 굳히지 않음").isEmpty();
        assertThat(rows(AS_OF)).as("트랙레코드 계산은 저장").hasSize(5);

        // 수집이 끝난 뒤 같은 기준일로 다시 부르면 이번에는 선정합니다.
        q30(A, true, quarters(FILINGS, "AAA", 100.0));
        q30(B, true, quarters(FILINGS, "BBB", 80.0, null, 20.0));
        PaperSelectionService.SelectionOutcome done = service.select(AS_OF);
        assertThat(done.created()).isTrue();
        assertThat(done.selection().selectedCiks()).containsExactly(A, B);
    }

    @Test
    @DisplayName("수집이 다 끝났는데 자격 기관이 0곳이면 빈 선정을 남긴다(알고 있는 '자격 기관 없음')")
    void selectRecordsEmptyWhenKnown() {
        // D(완료, 최신 분기 공시 없음)만 후보 — 수집 중인 후보가 없으니 0곳은 기준 미달입니다.
        settings(1, 1, 2, 0.5, 0.7, "CAGR", List.of(D));

        PaperSelectionService.SelectionOutcome outcome = service.select(AS_OF);

        assertThat(outcome.skippedReason()).isNull();
        assertThat(outcome.created()).isTrue();
        assertThat(outcome.selection().selectedCiks()).isEmpty();
    }

    // ------------------------------------------------------------------ 최신 분기 수집 대기(QA-175)
    /** 그 시각의 시계를 쓰는 서비스 — 결정 작업이 그 세션 마감 뒤에 부르는 것과 같게. */
    private PaperSelectionService serviceAt(Instant now) {
        return new PaperSelectionService(store, reader, marketData, PaperFixtures.settings(store), MAPPER,
                Clock.fixed(now, ZoneOffset.UTC));
    }

    /**
     * 재선정일 R 고정본(그룹 A 셋) — A·B는 기한 마감 뒤에 받은 저장본에 2026-09-30 분기가 있고, D(CCC — 받으면 1위)는
     * 2026-06-30 분기까지만 든 저장본을 dCollectedAt에 받은 것.
     */
    private void reselectionFixture(Instant dCollectedAt) {
        index(A, B, D);
        q30(A, true, quarters(FILINGS_Q3, "AAA", 100.0), AFTER_CUTOFF);
        q30(B, true, quarters(FILINGS_Q3, "BBB", 80.0, null, 20.0), AFTER_CUTOFF);
        q30(D, true, quarters(FILINGS, "CCC", 100.0), dCollectedAt);
    }

    @Test
    @DisplayName("QA-175: 최신 분기가 없는 저장본을 그 분기 기한 EDGAR 마감 전에 받았으면 '수집 대기' — 선정을 남기지 않고, 받은 뒤 다시 선정")
    void selectWaitsWhileLatestQuarterNotCollected() {
        reselectionFixture(BEFORE_CUTOFF);
        PaperSelectionService atR = serviceAt(Instant.parse("2026-11-17T21:30:00Z"));

        PaperSelectionService.SelectionOutcome waiting = atR.select(R);

        assertThat(waiting.selection()).as("모르는 것을 굳히지 않음").isNull();
        assertThat(waiting.created()).isFalse();
        assertThat(waiting.skippedReason()).contains("수집 대기").contains("2026-09-30").contains("기관 " + D);
        assertThat(store.selections).isEmpty();
        TrackRecordRow d = rows(R).get(D);
        assertThat(d.eligible()).isFalse();
        assertThat(d.ineligibleReason()).startsWith("최신 분기(2026-09-30) 수집 대기").doesNotContain("공시 없음");
        assertThat(waiting.computation().candidates().stream().filter(s -> s.cik().equals(D)).findFirst()
                .orElseThrow().missingLatest()).as("R5가 아님").isFalse();

        // 수집기가 마감 뒤에 D의 9월 분기를 받으면 다음 결정 날(따라잡기 — 같은 기준일 R) 선정합니다.
        q30(D, true, quarters(FILINGS_Q3, "CCC", 100.0), Instant.parse("2026-11-18T03:00:00Z"));
        PaperSelectionService.SelectionOutcome done = serviceAt(Instant.parse("2026-11-18T21:30:00Z")).select(R);
        assertThat(done.created()).isTrue();
        assertThat(done.selection().asOfDate()).isEqualTo(R);
        assertThat(done.selection().selectedCiks()).containsExactly(D, A);
    }

    @Test
    @DisplayName("QA-175: 대기 상한(사용자 결정 6) — R 뒤 4거래일까지는 기다리고, 5거래일째(11-24) 결정에서 받지 못한 기관을 '수집 실패로 제외'하고 선정")
    void selectExcludesUncollectedAfterWaitLimit() {
        reselectionFixture(BEFORE_CUTOFF);

        // 11-23(월) = R 뒤 4거래일 — 아직 기다림.
        PaperSelectionService.SelectionOutcome stillWaiting = serviceAt(Instant.parse("2026-11-23T21:30:00Z"))
                .select(R);
        assertThat(stillWaiting.selection()).isNull();
        assertThat(stillWaiting.skippedReason()).contains("수집 대기").contains("2026-11-24");
        assertThat(store.selections).isEmpty();

        // 11-24(화) = R 뒤 5거래일 — 받지 못한 D를 빼고 선정.
        PaperSelectionService.SelectionOutcome selected = serviceAt(Instant.parse("2026-11-24T21:30:00Z"))
                .select(R);
        assertThat(selected.created()).isTrue();
        assertThat(selected.skippedReason()).isNull();
        assertThat(selected.selection().asOfDate()).isEqualTo(R);
        assertThat(selected.selection().selectedCiks()).containsExactly(A, B);
        TrackRecordRow d = rows(R).get(D);
        assertThat(d.eligible()).isFalse();
        assertThat(d.rank()).isNull();
        assertThat(d.ineligibleReason()).startsWith("최신 분기(2026-09-30) 수집 실패로 제외").doesNotContain("공시 없음");
    }

    @Test
    @DisplayName("QA-175 대조: 기한 마감 뒤에 받은 저장본에 최신 분기가 없으면 그대로 R5('최신 분기 공시 없음') — 기다리지 않고 R에 선정")
    void latestQuarterMissingAfterCutoffIsStillR5() {
        reselectionFixture(AFTER_CUTOFF);

        PaperSelectionService.SelectionOutcome outcome = serviceAt(Instant.parse("2026-11-17T21:30:00Z")).select(R);

        assertThat(outcome.created()).isTrue();
        assertThat(outcome.selection().selectedCiks()).containsExactly(A, B);
        assertThat(rows(R).get(D).ineligibleReason()).isEqualTo("최신 분기(2026-09-30) 공시 없음");
        assertThat(outcome.computation().candidates().stream().filter(s -> s.cik().equals(D)).findFirst()
                .orElseThrow().missingLatest()).isTrue();
    }

    // ------------------------------------------------------------------ 그룹 B(D27)
    @Test
    @DisplayName("그룹 B: 기존 메뉴 12곳을 2년 창으로 — q30이 있으면 q30(DUQ), 없으면 q8, 값은 계산 함수를 직접 부른 것과 같고 출처를 남긴다")
    void groupBUsesQ30ElseQ8OverTwoYears() {
        groupBFixture();

        PaperSelectionService.Computation computation = service.compute(AS_OF);

        assertThat(computation.rankedB()).extracting(PaperSelectionService.Scored::cik)
                .containsExactly(DUQ, FIS, BRK, BW);
        Map<String, TrackRecordRow> b = rowsB(AS_OF);
        assertThat(b).as("메뉴 12곳 모두 저장(저장본 없는 곳은 공시 없음)").hasSize(12);
        TrackRecordRow duq = b.get(DUQ);
        assertThat(duq.groupCode()).isEqualTo("B");
        assertThat(duq.dataSource()).as("q30이 있으면 q8(BBB)이 아니라 q30(ZZZ)").isEqualTo("q30");
        assertThat(duq.windowYears()).isEqualTo(2);
        assertThat(duq.rank()).isEqualTo(1);
        assertThat(duq.periodsUsed()).isEqualTo(9);
        assertThat(duq.cagrPct()).isCloseTo(directB(DUQ, filings(FILINGS_B, "ZZZ", 100.0)).cagrPct(), within(1e-12));
        assertThat(duq.periods().get(0).path("start").asString()).as("첫 구간은 2년 창 시작으로 자름")
                .isEqualTo("2024-10-23");
        TrackRecordRow fis = b.get(FIS);
        assertThat(fis.dataSource()).isEqualTo("q8");
        assertThat(fis.cagrPct()).isCloseTo(directB(FIS, filings(FILINGS_B, "CCC", 100.0)).cagrPct(), within(1e-12));
        assertThat(b.get("0001608046").dataSource()).as("국민연금 — 저장본 없음").isNull();
        assertThat(b.get("0001608046").ineligibleReason()).isEqualTo("공시 없음");
        assertThat(b.values()).noneMatch(r -> r.ineligibleReason() != null
                && r.ineligibleReason().startsWith("수집 중"));

        // 그룹마다 가격을 한 번씩 — 그룹 B는 2년 창, 기준일까지만.
        assertThat(historyCalls).hasSize(2);
        HistoryCall callB = historyCalls.get(1);
        assertThat(callB.from()).isEqualTo(AS_OF.minusYears(2).minusDays(14));
        assertThat(callB.to()).isEqualTo(AS_OF);
        assertThat(callB.tickers()).containsExactly("AAA", "BBB", "CCC", "SPY", "ZZZ");
        assertThat(rows(AS_OF)).as("그룹 A 행은 그대로").hasSize(5);
    }

    @Test
    @DisplayName("그룹 B 자격은 그룹 A와 같은 커버리지 기준·R5 — 수익률 높은 인덱스형(커버리지 40%)·최신 분기 미공시(사이언)는 순위 밖")
    void groupBEligibilityUsesCoverageAndR5() {
        groupBFixture();

        service.compute(AS_OF);

        TrackRecordRow van = rowsB(AS_OF).get(VAN);
        assertThat(van.eligible()).isFalse();
        assertThat(van.rank()).isNull();
        assertThat(van.coverageAvg()).isCloseTo(0.4, within(1e-12));
        assertThat(van.ineligibleReason()).contains("커버리지");
        assertThat(van.cagrPct()).as("CCC를 들어 BRK(AAA)보다 높아도 순위 밖")
                .isGreaterThan(rowsB(AS_OF).get(BRK).cagrPct());
        TrackRecordRow scion = rowsB(AS_OF).get(SCION);
        assertThat(scion.ineligibleReason()).isEqualTo("최신 분기(2026-06-30) 공시 없음");
        assertThat(scion.cagrPct()).as("ZZZ — 수치는 그대로 계산").isNotNull();
    }

    @Test
    @DisplayName("그룹 B도 기준일 뒤 공시·가격을 쓰지 않는다 — q8의 늦은 분기(티커 포함)는 읽지 않음")
    void groupBCutsAtAsOf() {
        groupBFixture();
        List<Map<String, Object>> late = new ArrayList<>(quarters(FILINGS_B, "CCC", 100.0));
        late.add(0, quarter("2026-10-26", "2026-09-30", "LATE", 100.0));
        q8(FIS, late);
        TreeMap<LocalDate, Double> ccc = fullPrices.get("CCC");
        for (LocalDate day : new ArrayList<>(ccc.tailMap(AS_OF, false).keySet())) {
            ccc.put(day, ccc.get(day) * 10);
        }

        service.compute(AS_OF);

        TrackRecordRow fis = rowsB(AS_OF).get(FIS);
        assertThat(fis.lastFilingDate()).isEqualTo(LocalDate.of(2026, 8, 14));
        assertThat(fis.cagrPct()).isCloseTo(directB(FIS, filings(FILINGS_B, "CCC", 100.0)).cagrPct(), within(1e-12));
        assertThat(historyCalls.get(1).tickers()).doesNotContain("LATE");
    }

    @Test
    @DisplayName("선정: 신호 풀 = A ∪ B(A 순서 뒤에 B에만 있는 기관) — 두 그룹에 모두 있는 DUQ는 두 가중을 다 받고(0.5333), 합 1")
    void selectionPoolUnionWithOverlap() {
        groupBFixture();
        index(A, B, C, D, E, DUQ);   // DUQ를 그룹 A 후보에도 — 1년 창에서 ZZZ로 1위

        PaperSelectionService.SelectionOutcome outcome = service.select(AS_OF);

        Selection saved = outcome.selection();
        assertThat(saved.selectedCiks()).containsExactly(DUQ, A, FIS, BRK, BW);
        JsonNode ranking = saved.ranking();
        assertThat(ranking.path("groupA")).extracting(r -> r.path("cik").asString()).containsExactly(DUQ, A, B);
        assertThat(ranking.path("groupA").get(2).path("selected").asBoolean()).as("topN 2 밖").isFalse();
        assertThat(ranking.path("groupB")).extracting(r -> r.path("cik").asString())
                .containsExactly(DUQ, FIS, BRK, BW);
        assertThat(ranking.path("groupB").get(1).path("source").asString()).isEqualTo("q8");
        assertThat(ranking.path("groupB").get(0).path("metricValue").asDouble())
                .isEqualTo(ranking.path("groupB").get(0).path("cagrPct").asDouble());
        JsonNode pool = ranking.path("pool");
        // a(r) = (3 − r)/3(A 2곳), b(r) = (5 − r)/10(B 4곳), g = 0.5
        JsonNode duq = pool.get(0);
        assertThat(duq.path("groups").toString()).isEqualTo("[\"A\",\"B\"]");
        assertThat(duq.path("rankA").asInt()).isEqualTo(1);
        assertThat(duq.path("rankB").asInt()).isEqualTo(1);
        assertThat(duq.path("weight").asDouble()).isCloseTo(0.5 * 2 / 3 + 0.5 * 0.4, within(1e-12));
        assertThat(pool.get(1).path("weight").asDouble()).isCloseTo(0.5 / 3, within(1e-12));
        assertThat(pool.get(1).path("rankB").isNull()).isTrue();
        assertThat(pool.get(2).path("weight").asDouble()).isCloseTo(0.15, within(1e-12));
        assertThat(pool.get(4).path("weight").asDouble()).isCloseTo(0.05, within(1e-12));
        double sum = 0;
        for (JsonNode m : pool) {
            sum += m.path("weight").asDouble();
        }
        assertThat(sum).isCloseTo(1.0, within(1e-12));
        assertThat(ranking.path("groupWeightA").asDouble()).isEqualTo(0.5);

        // 규칙 책이 읽는 모양 — 가중은 행 그대로(다시 계산하지 않음).
        PaperSelectionService.SignalPool parsed = PaperSelectionService.signalPool(saved);
        assertThat(parsed.legacy()).isFalse();
        assertThat(parsed.members()).extracting(PaperSelectionService.PoolMember::weight)
                .containsExactly(duq.path("weight").asDouble(), 0.5 / 3, 0.15, 0.1, 0.05);
        assertThat(parsed.selectedA()).extracting(PaperSelectionService.RankedFiler::cik).containsExactly(DUQ, A);
        assertThat(parsed.selectedB()).extracting(PaperSelectionService.RankedFiler::cik)
                .containsExactly(DUQ, FIS, BRK, BW);
    }

    @Test
    @DisplayName("그룹 A가 수집 중으로 비면 그룹 B가 준비돼 있어도 선정을 남기지 않는다 — 그룹 B만으로 선정하지 않음")
    void noGroupBOnlySelectionWhileCollecting() {
        groupBFixture();
        q30(A, false, quarters(FILINGS, "AAA", 100.0));
        q30(B, false, quarters(FILINGS, "BBB", 80.0, null, 20.0));

        PaperSelectionService.SelectionOutcome outcome = service.select(AS_OF);

        assertThat(outcome.selection()).isNull();
        assertThat(outcome.skippedReason()).startsWith("수집 중 4곳(후보 5곳)");
        assertThat(outcome.computation().rankedB()).as("그룹 B는 계산됨").hasSize(4);
        assertThat(store.selections).isEmpty();
    }

    @Test
    @DisplayName("그룹 A가 (수집이 끝난 채로) 0곳이면 신호 풀은 그룹 B만 — 그룹 B가 가중 1을 다 받음(4·3·2·1/10)")
    void groupAEmptyButKnownLeavesGroupBPool() {
        groupBFixture();
        settings(1, 1, 2, 0.5, 0.7, "CAGR", List.of(D));

        Selection saved = service.select(AS_OF).selection();

        assertThat(saved.selectedCiks()).containsExactly(DUQ, FIS, BRK, BW);
        assertThat(PaperSelectionService.signalPool(saved).members())
                .extracting(PaperSelectionService.PoolMember::weight).containsExactly(0.4, 0.3, 0.2, 0.1);
    }

    @Test
    @DisplayName("수동 재계산은 두 그룹을 다시 계산하고 선정은 그대로 — 응답 groupB:{computed, eligible}")
    @SuppressWarnings("unchecked")
    void rerankRecomputesBothGroups() {
        groupBFixture();
        service.select(AS_OF);
        List<String> before = store.selections.get(AS_OF).selectedCiks();
        q8(FIS, quarters(FILINGS_B, "ZZZ", 100.0));   // FIS도 ZZZ — DUQ와 같은 수익률, CIK 순으로 1위

        Map<String, Object> response = service.rerank("2026-10-23");

        assertThat((Map<String, Object>) response.get("groupB")).containsEntry("computed", 12)
                .containsEntry("eligible", 4);
        assertThat(rowsB(AS_OF).get(FIS).rank()).isEqualTo(1);
        assertThat(store.selections.get(AS_OF).selectedCiks()).as("선정은 그대로").isEqualTo(before);
    }

    @Test
    @DisplayName("조회: groupB(창·기준·후보 + 출처·메뉴 설명·선정)와 신호 풀·g — 위쪽 selected는 그룹 A 선정")
    @SuppressWarnings("unchecked")
    void trackRecordResponseHasGroupBAndPool() {
        groupBFixture();
        service.select(AS_OF);

        Map<String, Object> out = service.trackRecord(null);

        assertThat((List<String>) out.get("selected")).containsExactly(A, B);
        Map<String, Object> groupB = (Map<String, Object>) out.get("groupB");
        assertThat(groupB).containsEntry("computed", true).containsEntry("windowYears", 2)
                .containsEntry("minPeriods", 6).containsEntry("metric", "CAGR").containsEntry("topN", 4);
        assertThat((Map<String, Object>) groupB.get("criteria")).containsEntry("windowYears", 2)
                .containsEntry("minPeriods", 6).containsEntry("minCoverage", 0.5).containsEntry("avgCoverage", 0.7);
        assertThat((List<String>) groupB.get("selected")).containsExactly(DUQ, FIS, BRK, BW);
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) groupB.get("candidates");
        assertThat(candidates).hasSize(12);
        assertThat(candidates).extracting(c -> c.get("cik")).as("순위 순, 나머지는 메뉴 순")
                .startsWith(DUQ, FIS, BRK, BW, "0001608046", "0001374170");
        assertThat(candidates.get(0)).containsEntry("source", "q30").containsEntry("selected", true)
                .containsEntry("rank", 1).containsEntry("collecting", false)
                .containsEntry("name", "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)")
                .containsEntry("desc", "스탠리 드러켄밀러, 테크 트렌드 포착형 매크로 운용");
        assertThat(candidates.get(1)).containsEntry("source", "q8").containsEntry("storedQuarters", null)
                .containsEntry("complete", false);
        assertThat(candidates.get(0).get("periods")).asList().hasSize(9);

        List<Map<String, Object>> pool = (List<Map<String, Object>>) out.get("pool");
        assertThat(pool).extracting(m -> m.get("cik")).containsExactly(A, B, DUQ, FIS, BRK, BW);
        assertThat(pool.get(2)).containsEntry("groups", List.of("B")).containsEntry("rankA", null)
                .containsEntry("rankB", 1);
        assertThat(out.get("groupWeightA")).isEqualTo(0.5);
        Map<String, Object> history = ((List<Map<String, Object>>) out.get("selectionHistory")).get(0);
        assertThat((List<String>) history.get("groupA")).containsExactly(A, B);
        assertThat((List<String>) history.get("groupB")).containsExactly(DUQ, FIS, BRK, BW);
        assertThat((List<String>) history.get("selectedCiks")).containsExactly(A, B, DUQ, FIS, BRK, BW);
    }

    @Test
    @DisplayName("QA-175 그룹 B: q30이 최신 분기를 아직 받지 못한 저장본(기한 마감 전)이면 q8이 그 분기를 받았어도 q30 그대로 '수집 대기' — 신호·패킷 6b와 같은 출처")
    void groupBStaleQ30IsPendingEvenWithFreshQ8() {
        reselectionFixture(AFTER_CUTOFF);
        q30(DUQ, true, quarters(FILINGS_B, "ZZZ", 100.0), BEFORE_CUTOFF);
        q8(DUQ, quarters(FILINGS_B_Q3, "ZZZ", 100.0), AFTER_CUTOFF);
        q8(FIS, quarters(FILINGS_B_Q3, "CCC", 100.0), AFTER_CUTOFF);

        PaperSelectionService.Computation computation = serviceAt(Instant.parse("2026-11-17T21:30:00Z")).compute(R);

        TrackRecordRow duq = rowsB(R).get(DUQ);
        assertThat(duq.dataSource()).as("규칙 책 신호·패킷 6b는 q30이 있으면 q30을 읽음").isEqualTo("q30");
        assertThat(duq.ineligibleReason()).startsWith("최신 분기(2026-09-30) 수집 대기").doesNotContain("공시 없음");
        assertThat(computation.groupB().stream().filter(s -> s.cik().equals(DUQ)).findFirst().orElseThrow()
                .pending()).isTrue();
        assertThat(rowsB(R).get(FIS).rank()).isEqualTo(1);
    }

    @Test
    @DisplayName("QA-175 그룹 B: q8만 있는 기관도 최신 분기를 기한 마감 전 저장본으로만 알면 '수집 대기' — 그 기관 때문에도 선정을 미룸")
    void selectWaitsForGroupBLatestQuarter() {
        reselectionFixture(AFTER_CUTOFF);
        q8(BRK, quarters(FILINGS_B_Q3, "AAA", 100.0), AFTER_CUTOFF);
        q8(FIS, quarters(FILINGS_B, "CCC", 100.0), BEFORE_CUTOFF);

        PaperSelectionService.SelectionOutcome outcome = serviceAt(Instant.parse("2026-11-17T21:30:00Z")).select(R);

        assertThat(outcome.selection()).isNull();
        assertThat(outcome.skippedReason()).contains("수집 대기").contains("피셔");
        assertThat(store.selections).isEmpty();
        assertThat(rowsB(R).get(FIS).ineligibleReason()).startsWith("최신 분기(2026-09-30) 수집 대기");
        assertThat(rowsB(R).get(BRK).rank()).isEqualTo(1);
    }

    @Test
    @DisplayName("blend 설정: 범위 밖·없는 키는 그 키만 기본값으로 읽고 blend.… 이름으로 남긴다(D27 전 행은 blend 통째로)")
    void blendSettingsFallbacks() {
        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode blend = body.putObject("blend");
        blend.putObject("groupB").put("topN", 13).put("windowYears", 2).put("minPeriods", 4.5);
        blend.put("groupWeightA", 0.7);
        blend.put("convictionCapPct", 0.5);
        blend.put("allocation", "equal");
        blend.put("minTargetPct", 11);

        PaperSettings.Blend parsed = PaperSettings.Blend.from(body);

        assertThat(parsed.groupBTopN()).isEqualTo(4);
        assertThat(parsed.groupBWindowYears()).isEqualTo(2);
        assertThat(parsed.groupBMinPeriods()).isEqualTo(6);
        assertThat(parsed.groupWeightA()).isEqualTo(0.7);
        assertThat(parsed.convictionCapPct()).isEqualTo(10);
        assertThat(parsed.allocation()).isEqualTo(com.macrodash.analytics.Signal13F.Mode.EQUAL);
        assertThat(parsed.minTargetPct()).isEqualTo(1.0);
        assertThat(parsed.fallbacks()).containsExactly("blend.groupB.topN", "blend.groupB.minPeriods",
                "blend.convictionCapPct", "blend.minTargetPct");

        PaperSettings.Blend old = PaperSettings.Blend.from(MAPPER.createObjectNode().put("minHolders", 2));
        assertThat(old.fallbacks()).containsExactly("blend");
        assertThat(old.allocation()).isEqualTo(com.macrodash.analytics.Signal13F.Mode.CONVICTION);
        assertThat(PaperSettings.Blend.from(PaperFixtures.settings(store).defaultsJson()))
                .isEqualTo(PaperSettings.Blend.defaults());
        assertThat(PaperSettings.from(PaperFixtures.settings(store).defaultsJson()).fallbacks())
                .as("blend 기본값은 장부 경고에 섞지 않음").isEmpty();
    }

    /** 저장본 고정본 → StoreRepository.readQuarterHoldings가 돌려줄 줄(보유 없는 분기도 한 줄). */
    private static List<StoreRepository.HoldingRow> holdingRows(Snapshot snapshot) {
        List<StoreRepository.HoldingRow> rows = new ArrayList<>();
        if (snapshot == null) {
            return rows;
        }
        int index = 0;
        for (JsonNode quarter : snapshot.payload().path("quarters")) {
            String filing = quarter.path("filingDate").isTextual() ? quarter.path("filingDate").asText() : null;
            String report = quarter.path("reportDate").isTextual() ? quarter.path("reportDate").asText() : null;
            String filer = quarter.path("filerCik").isTextual() ? quarter.path("filerCik").asText() : null;
            boolean any = false;
            for (JsonNode holding : quarter.path("holdings")) {
                any = true;
                rows.add(new StoreRepository.HoldingRow(index, filing, report, filer,
                        holding.path("cusip").isTextual() ? holding.path("cusip").asText() : null,
                        holding.path("ticker").isTextual() ? holding.path("ticker").asText() : null,
                        holding.path("value").isNumber() ? holding.path("value").asDouble() : null,
                        holding.path("shares").isNumber() ? holding.path("shares").asDouble() : null));
            }
            if (!any) {
                rows.add(new StoreRepository.HoldingRow(index, filing, report, filer, null, null, null, null));
            }
            index++;
        }
        return rows;
    }
}
