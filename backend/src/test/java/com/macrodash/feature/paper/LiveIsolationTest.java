package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import tools.jackson.databind.JsonNode;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 장중 값의 고립(명세 docs/specs/2026-10-31-paper-live-overview.md §6·§7) — 지금 값은 표시 전용이라 장부·결정·패킷·장중 확인·복기·통계가 읽으면 안
 * 됩니다(진행 중인 실험 조건).
 *
 * <ul>
 *   <li>소스 검사: 장중 데이터셋({@code SNAP_PAPER_LIVE_*}·{@code paper.live.*})·장중 수집 태스크 이름·떼어 낸 평가 계산({@link LiveValuation})·장중
 *       평가 서비스·개요 조립({@link PaperOverviewService})을 참조할 수 있는 main 소스는 허용 목록뿐 — 허용은 평가 계산·{@code /live}·개요 조립 셋과
 *       그 경로의 컨트롤러, 데이터셋 이름 정의({@code Datasets})입니다. {@link PaperQueryService} 전체를 허용하지 않습니다(BookSummary는 /positions·
 *       /nav·결정 응답도 씀).</li>
 *   <li>통계 입력: 장중 저장본이 있든 없든(값이 크게 달라도) 개요의 통계·순자산 곡선·노출 추이·장부 칸(한국은 노출 맞춘 참고선 K40까지)이 같고,
 *       장부 표(순자산 줄)에 아무것도 쓰지 않습니다. 미국·한국 둘 다 — 개요 조립 안에서 한 시장 갈래에만 생긴 누수도 잡습니다.</li>
 * </ul>
 */
class LiveIsolationTest {

    private static final Path MAIN = Path.of("src", "main", "java", "com", "macrodash");
    private static final String PAPER = "feature/paper/";

    /** 참조 글자 → 그 글자를 담을 수 있는 main 소스(com/macrodash 아래 상대 경로). */
    private static final Map<String, Set<String>> ALLOWED = allowed();

    private static Map<String, Set<String>> allowed() {
        Set<String> live = Set.of(PAPER + "LiveValuation.java", PAPER + "PaperLiveService.java",
                PAPER + "PaperOverviewService.java");
        Map<String, Set<String>> out = new LinkedHashMap<>();
        out.put("SNAP_PAPER_LIVE_", union(live, Set.of("store/Datasets.java")));
        out.put("paper.live.", union(live, Set.of("store/Datasets.java")));
        // 정보 수집의 출처 표는 수집기 태스크 이름을 화면 이름표로만 가집니다(태스크 목록 대조 시험 — ADR 0036). 장중 값을 읽지 않습니다.
        out.put("paper_live_", union(live, Set.of("feature/info/InfoSources.java")));
        out.put("LiveValuation", live);
        out.put("PaperLiveService", union(live, Set.of(PAPER + "PaperLiveController.java")));
        out.put("PaperOverviewService", union(live, Set.of(PAPER + "PaperOverviewController.java")));
        return out;
    }

    private static Set<String> union(Set<String> a, Set<String> b) {
        Set<String> out = new TreeSet<>(a);
        out.addAll(b);
        return out;
    }

    @Test
    @DisplayName("장중 데이터셋·장중 수집 태스크·평가 계산·개요 조립을 참조하는 main 소스는 허용 목록(평가 계산·/live·개요 조립 셋과 그 컨트롤러, 데이터셋 정의)뿐")
    void liveReferencesStayInTheAllowedClasses() throws IOException {
        Map<String, Set<String>> found = new LinkedHashMap<>();
        ALLOWED.keySet().forEach(token -> found.put(token, new TreeSet<>()));
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String source = Files.readString(file);
                String relative = MAIN.relativize(file).toString().replace('\\', '/');
                ALLOWED.keySet().stream().filter(source::contains).forEach(token -> found.get(token).add(relative));
            }
        }
        assertThat(found.get("SNAP_PAPER_LIVE_")).as("검사가 실제로 소스를 읽음").contains("store/Datasets.java");
        assertThat(found.get("LiveValuation")).contains(PAPER + "PaperOverviewService.java");
        found.forEach((token, files) -> assertThat(files).as(token + "을 참조하는 main 소스").isSubsetOf(ALLOWED.get(token)));
        assertThat(found.get("PaperOverviewService")).as("개요 조립을 부르는 곳은 개요 경로의 컨트롤러뿐")
                .doesNotContain(PAPER + "PaperQueryService.java");
    }

    @Test
    @DisplayName("통계 입력에 장중 점이 들어가지 않음 — 장중 저장본이 있든 없든 통계·순자산 곡선·노출 추이·장부 칸이 같고, 순자산 줄을 쓰지 않음")
    void liveValuesStayOutOfStatistics() {
        Instant now = Instant.parse("2026-10-30T15:00:00Z");   // 10-30(금) 11:00 ET — 미국 정규장
        FakePaperStore store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        LocalDate start = LocalDate.of(2026, 10, 29);
        for (int i = 0; i < 30; i++) {
            start = UsMarketCalendar.CALENDAR.previousTradingDay(start);
        }
        Instant observed = Instant.parse("2026-10-30T14:05:00Z");
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.BENCH_SPY)) {
            store.books.put(code, new Book(code, PaperBooks.CLAUDE.equals(code) ? "CLAUDE" : "BENCHMARK", code, 100_000,
                    start, PaperBooks.ACTIVE, null));
            store.states.put(code, new BookState(code, 10_000, 100_000, 90_000, 90.0, observed, observed,
                    LocalDate.of(2026, 10, 29), null));
            store.upsertPosition(new Position(code, "SPY", 150, 600, start, observed, 600, observed, 600.0, observed, false,
                    start, 600, null));
            LocalDate day = start;
            for (int i = 0; i <= 30; i++) {
                double value = 100_000 + (PaperBooks.CLAUDE.equals(code) ? 37 : 23) * i + (i % 3) * 211;
                store.upsertNav(new NavRow(code, day, value, 10_000, value - 10_000, 90.0, true));
                day = UsMarketCalendar.CALENDAR.nextTradingDay(day);
            }
        }
        List<NavRow> rowsBefore = store.navSeriesAll();

        Map<String, Object> without = overview(store, now, Optional.empty());
        Snapshot crash = new Snapshot(Datasets.SNAP_PAPER_LIVE_US, MAPPER.readTree("""
                {"source": "1분봉", "tickers": {"SPY": {"price": 300, "at": "2026-10-30T14:58:00+00:00"}},
                 "missing": [], "error": null}"""), "json", "ok", null, Instant.parse("2026-10-30T14:59:00Z"));
        Map<String, Object> with = overview(store, now, Optional.of(crash));

        assertThat(PaperOverviewServiceTest.withoutLive(with)).as("장부 응답(통계·곡선·노출 추이·장부 칸)은 장중 값과 무관")
                .isEqualTo(PaperOverviewServiceTest.withoutLive(without));
        @SuppressWarnings("unchecked")
        Map<String, Object> claude = ((List<Map<String, Object>>) with.get("books")).get(0);
        @SuppressWarnings("unchecked")
        Map<String, Object> current = (Map<String, Object>) claude.get("current");
        assertThat(current).as("지금 값만 장중(SPY 300)").containsEntry("stage", "LIVE").containsEntry("nav", 55_000.0);
        assertThat(claude.get("stats")).as("통계는 표본이 충분해 값이 있음").isNotNull();
        assertThat(store.navSeriesAll()).as("순자산 줄에 장중 점을 쓰지 않음").isEqualTo(rowsBefore);
    }

    @Test
    @DisplayName("한국도 같음 — paper.live.kr 저장본이 있든 없든 통계·순자산 곡선·노출 추이·노출 맞춘 참고선(K40)·장부 칸이 같고, 순자산 줄을 쓰지 않음")
    @SuppressWarnings("unchecked")
    void koreaLiveValuesStayOutOfStatistics() {
        Instant now = Instant.parse("2026-10-30T01:00:00Z");   // 10-30(금) 10:00 KST — 한국 정규장
        Instant observed = Instant.parse("2026-10-29T11:35:00Z");   // 목요일 밤 관측치
        LocalDate thu = LocalDate.of(2026, 10, 29);
        LocalDate start = thu;
        for (int i = 0; i < 30; i++) {
            start = KrRulesFixtures.CALENDAR.previousTradingDay(start);
        }
        FakePaperStore store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        List<JsonNode> stockEtf = new ArrayList<>();
        List<JsonNode> bondEtf = new ArrayList<>();
        int index = 0;
        for (LocalDate day = start; !day.isAfter(thu); day = KrRulesFixtures.CALENDAR.nextTradingDay(day), index++) {
            stockEtf.add(etfRow(day, 30_000 + 37L * index + (index % 3) * 90));
            bondEtf.add(etfRow(day, 110_000 + 11L * index));
            // 규칙 계좌의 그날 결정 — 노출 맞춘 참고선의 주식 비중(069500 60%)
            store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.KR_RULES, day, "INITIAL",
                    null, "OK", null, null, 1, day, 60.0, null, null, null,
                    MAPPER.readTree("{\"holdings\":[{\"code\":\"069500\",\"weightPct\":60}]}"), null, null, null, true, 5L, 0));
        }
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, start, PaperBooks.ACTIVE, null,
                    Book.MARKET_KR, Book.CURRENCY_KRW));
            store.states.put(d.code(), new BookState(d.code(), 10_000_000, 100_000_000, 90_000_000, 90.0, observed, observed,
                    thu, null));
            store.upsertPosition(new Position(d.code(), "005930", 1_500, 60_000, start, observed, 60_000, observed, 60_000.0,
                    observed, false, start, 60_000, null));
            int i = 0;
            for (LocalDate day = start; !day.isAfter(thu); day = KrRulesFixtures.CALENDAR.nextTradingDay(day), i++) {
                double value = 100_000_000 + (PaperBooks.KR_CLAUDE.equals(d.code()) ? 37_000 : 23_000) * i + (i % 3) * 211_000;
                store.upsertNav(new NavRow(d.code(), day, value, 10_000_000, value - 10_000_000, 90.0, i < 30));
            }
        }
        StoreRepository repository = mock(StoreRepository.class);
        when(repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE)).thenReturn(thu);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_ETF_PRICE), any(), any()))
                .thenReturn(Map.of("069500", stockEtf, "153130", bondEtf));
        List<NavRow> rowsBefore = store.navSeriesAll();
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);

        Map<String, Object> without = overview(store, krReader(Optional.empty()), repository, now, config, "KR");
        Snapshot crash = new Snapshot(Datasets.SNAP_PAPER_LIVE_KR, MAPPER.readTree("""
                {"source": "1분봉", "tickers": {"005930": {"price": 30000, "at": "2026-10-30T00:59:00+00:00"}},
                 "missing": [], "error": null}"""), "json", "ok", null, Instant.parse("2026-10-30T00:59:30Z"));
        Map<String, Object> with = overview(store, krReader(Optional.of(crash)), repository, now, config, "KR");

        assertThat(MAPPER.writeValueAsString(PaperOverviewServiceTest.withoutLive(with)))
                .as("장부 응답(통계·곡선·노출 추이·K40 참고선·장부 칸)은 장중 값과 무관")
                .isEqualTo(MAPPER.writeValueAsString(PaperOverviewServiceTest.withoutLive(without)));
        Map<String, Object> reference = (Map<String, Object>) with.get("exposureReference");
        assertThat(reference).as("K40 참고선이 값으로 들어 있음(비교가 빈 칸끼리가 아님)").isNotNull()
                .containsEntry("asOfDate", thu.toString()).containsEntry("stoppedReason", null);
        assertThat((List<Object>) reference.get("values")).doesNotContainNull();
        List<Map<String, Object>> books = (List<Map<String, Object>>) with.get("books");
        Map<String, Object> claude = books.stream().filter(b -> PaperBooks.KR_CLAUDE.equals(b.get("code"))).findFirst()
                .orElseThrow();
        assertThat((Map<String, Object>) claude.get("current")).as("지금 값만 장중(005930 30,000원)")
                .containsEntry("stage", "LIVE").containsEntry("nav", 55_000_000.0);
        assertThat(claude.get("stats")).as("통계는 표본이 충분해 값이 있음").isNotNull();
        assertThat(store.navSeriesAll()).as("순자산 줄에 장중 점을 쓰지 않음").isEqualTo(rowsBefore);
    }

    private static StoreReader krReader(Optional<Snapshot> live) {
        StoreReader reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        when(reader.readStored(Datasets.SNAP_PAPER_LIVE_KR)).thenReturn(live);
        return reader;
    }

    private static JsonNode etfRow(LocalDate date, long close) {
        return MAPPER.createObjectNode().put("obsDate", date.toString()).put("close", close).put("volume", 1_000_000L)
                .put("listedUnits", 10_000_000L);
    }

    private static Map<String, Object> overview(FakePaperStore store, Instant now, Optional<Snapshot> live) {
        StoreReader reader = PaperFixtures.quietReader();
        when(reader.readStored(Datasets.SNAP_PAPER_LIVE_US)).thenReturn(live);
        return overview(store, reader, mock(StoreRepository.class), now, PaperFixtures.config(), "US");
    }

    private static Map<String, Object> overview(FakePaperStore store, StoreReader reader, StoreRepository repository,
                                                Instant now, PaperConfig config, String market) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        PaperQueryService query = new PaperQueryService(store, new PaperMarketData(reader, repository, clock), reader,
                PaperFixtures.settings(store), config, clock);
        return new PaperOverviewService(query, store, reader, new PaperMarkets(store, reader), clock).overview(market);
    }
}
