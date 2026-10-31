package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 개요 조립(GET /api/paper/overview — {@link PaperOverviewService}) — 장부 응답은 한 글자도 바뀌지 않고 계좌마다 {@code current}·
 * {@code ledgerDay}·{@code lastNavTradingDate}·{@code lastNavFinal}, 최상위 {@code navEstimate}·{@code liveSession}이 덧붙으며, 장중 저장본은 저장본만 읽는다(수집 요청
 * 없음). 미국·한국 모두. 시계는 고정입니다(2026-10-30(금) 11:00 ET = 15:00 UTC, 미국 정규장).
 */
class PaperOverviewServiceTest {

    private static final LocalDate THU = LocalDate.of(2026, 10, 29);
    private static final Instant US_REGULAR = Instant.parse("2026-10-30T15:00:00Z");
    private static final Instant FRI_HOURLY = Instant.parse("2026-10-30T14:05:00Z");
    /** 2026-10-30(금) 10:00 KST — 한국 정규장. */
    private static final Instant KR_REGULAR = Instant.parse("2026-10-30T01:00:00Z");
    private static final Instant KR_THU_NIGHT = Instant.parse("2026-10-29T11:35:00Z");

    private FakePaperStore store;
    private StoreReader reader;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
    }

    private PaperOverviewService service(Instant now, PaperConfig config) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        PaperMarketData marketData = new PaperMarketData(reader, mock(StoreRepository.class), clock);
        PaperQueryService query = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store), config, clock);
        return new PaperOverviewService(query, store, reader, new PaperMarkets(store, reader), clock);
    }

    private PaperQueryService query(Instant now, PaperConfig config) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        return new PaperQueryService(store, new PaperMarketData(reader, mock(StoreRepository.class), clock), reader,
                PaperFixtures.settings(store), config, clock);
    }

    /** 미국: 운용 중인 Claude 계좌(현금 40,000 + AAA 100주, 목요일 줄 확정)와 현금뿐인 계좌2. */
    private void usBooks() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, "CLAUDE", "Claude 계좌", 100_000, THU,
                PaperBooks.ACTIVE, null));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 40_000, 100_000, 60_000, 60.0, FRI_HOURLY,
                FRI_HOURLY, THU, null));
        store.upsertPosition(new com.macrodash.store.PaperStore.Position(PaperBooks.CLAUDE, "AAA", 100, 590, THU, FRI_HOURLY,
                600, FRI_HOURLY, 600.0, FRI_HOURLY, false, THU, 590, null));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, THU, 99_000, 40_000, 59_000, 59.6, true));
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, "CLAUDE", "Claude 계좌2", 100_000, THU,
                PaperBooks.ACTIVE, null));
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, 100_000, 100_000, 0, 0, FRI_HOURLY,
                FRI_HOURLY, THU, null));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE2, THU, 100_000, 100_000, 0, 0, true));
    }

    private void liveSnapshot(String dataset, String ticker, double price, String at) {
        Snapshot snapshot = new Snapshot(dataset, MAPPER.readTree("{\"source\": \"1분봉\", \"tickers\": {\"" + ticker
                + "\": {\"price\": " + price + ", \"at\": \"" + at + "\"}}, \"missing\": [], \"error\": null}"),
                "json", "ok", null, Instant.parse(at).plusSeconds(30));
        when(reader.readStored(dataset)).thenReturn(Optional.of(snapshot));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> books(Map<String, Object> out) {
        return (List<Map<String, Object>>) out.get("books");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> current(Map<String, Object> out, int index) {
        return (Map<String, Object>) books(out).get(index).get("current");
    }

    /** 덧붙인 칸을 뺀 사본 — 장부 응답과 견줍니다. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> withoutLive(Map<String, Object> out) {
        Map<String, Object> copy = new LinkedHashMap<>(out);
        copy.remove("navEstimate");
        copy.remove("liveSession");
        copy.put("books", ((List<Map<String, Object>>) out.get("books")).stream().map(book -> {
            Map<String, Object> b = new LinkedHashMap<>(book);
            b.remove("current");
            b.remove("ledgerDay");
            b.remove("lastNavTradingDate");
            b.remove("lastNavFinal");
            return b;
        }).toList());
        return copy;
    }

    @Test
    @DisplayName("미국 정규장 — 장부 응답은 글자 그대로, 계좌마다 current(장중 추정·현금뿐 중립)·마지막 줄, 오늘 추정 점, 장 상태가 덧붙음")
    void usOverviewAddsCurrent() {
        usBooks();
        liveSnapshot(Datasets.SNAP_PAPER_LIVE_US, "AAA", 610, "2026-10-30T14:58:00Z");

        Map<String, Object> out = service(US_REGULAR, PaperFixtures.config()).overview(null);

        assertThat(MAPPER.writeValueAsString(withoutLive(out)))
                .isEqualTo(MAPPER.writeValueAsString(query(US_REGULAR, PaperFixtures.config()).overview()));
        assertThat(books(out).get(0)).containsEntry("code", PaperBooks.CLAUDE).containsEntry("nav", 100_000.0)
                .as("장부 칸은 그대로, 지금 값은 current에").containsEntry("lastNavTradingDate", "2026-10-29")
                .containsEntry("lastNavFinal", true);
        assertThat(current(out, 0)).containsEntry("stage", "LIVE").containsEntry("nav", 101_000.0)
                .containsEntry("atKst", "2026-10-30 23:58 KST").containsEntry("isEstimated", true)
                .containsEntry("dayChangePct", 2.02);
        assertThat(books(out).get(0).get("ledgerDay")).as("장부 칸의 오늘 변화 — 상태 100,000 ÷ 목요일 줄 99,000(장중 값 아님)")
                .isEqualTo(Map.of("tradingDate", "2026-10-30", "dayChangePct", 1.01, "previousTradingDate", "2026-10-29",
                        "previousNavFinal", true));
        assertThat(List.copyOf(books(out).get(0).keySet()))
                .endsWith("current", "ledgerDay", "lastNavTradingDate", "lastNavFinal");
        assertThat(current(out, 1)).as("현금뿐인 계좌2 — 기준 중립").containsEntry("neutral", true)
                .containsEntry("stage", "LEDGER").containsEntry("nav", 100_000.0);
        assertThat(out.get("navEstimate")).isEqualTo(Map.of("date", "2026-10-30", "atKst", "2026-10-30 23:58 KST",
                "isEstimated", true, "books", Map.of(PaperBooks.CLAUDE, Map.of("nav", 101_000.0, "isEstimated", true),
                        PaperBooks.CLAUDE2, Map.of("nav", 100_000.0, "isEstimated", false))));
        assertThat(out.get("liveSession")).isEqualTo(Map.of("phase", "REGULAR", "sessionDate", "2026-10-30"));
        assertThat(List.copyOf(out.keySet()).subList(out.size() - 2, out.size())).containsExactly("navEstimate", "liveSession");
    }

    @Test
    @DisplayName("장중 저장본은 저장본만 읽음 — 개요 60초 폴링이 수집을 깨우지 않음(live 읽기·수집 태스크 요청 없음)")
    void readsStoredOnly() {
        usBooks();
        liveSnapshot(Datasets.SNAP_PAPER_LIVE_US, "AAA", 610, "2026-10-30T14:58:00Z");

        service(US_REGULAR, PaperFixtures.config()).overview("US");

        verify(reader).readStored(Datasets.SNAP_PAPER_LIVE_US);
        verify(reader, never()).read(eq(Datasets.SNAP_PAPER_LIVE_US), anyLong(), nullable(String.class));
        verify(reader, never()).read(anyString(), anyLong(), eq("paper_live_us"));
    }

    @Test
    @DisplayName("장중 저장본이 없으면 — 장중 값 대신 장부(상태·줄), 오늘 추정 점 없음, 장부 칸 그대로")
    void withoutLiveSnapshot() {
        usBooks();
        Map<String, Object> out = service(US_REGULAR, PaperFixtures.config()).overview("US");

        assertThat(current(out, 0)).containsEntry("stage", "LEDGER").containsEntry("nav", 100_000.0)
                .containsEntry("isEstimated", false);
        assertThat(out).containsEntry("navEstimate", null);
    }

    @Test
    @DisplayName("한국 — 같은 조립: 장중 저장본 paper.live.kr(저장본만), 장부는 목요일 밤 줄(잠정)·시가 체결 대기, 장중가가 있으면 장중 추정")
    void koreaOverview() {
        Book kr = new Book(PaperBooks.KR_CLAUDE, "CLAUDE", "한국 Claude", 100_000_000, THU, PaperBooks.ACTIVE, null,
                Book.MARKET_KR, Book.CURRENCY_KRW);
        store.books.put(kr.code(), kr);
        store.states.put(kr.code(), new BookState(kr.code(), 40_000_000, 100_000_000, 60_000_000, 60.0, KR_THU_NIGHT,
                KR_THU_NIGHT, THU, null));
        store.upsertPosition(new com.macrodash.store.PaperStore.Position(kr.code(), "005930", 1_000, 59_000, THU,
                KR_THU_NIGHT, 60_000, KR_THU_NIGHT, 60_000.0, KR_THU_NIGHT, false, THU, 59_000, null));
        store.upsertNav(new NavRow(kr.code(), THU, 100_000_000, 40_000_000, 60_000_000, 60.0, false));
        PaperFixtures.pending(store, kr.code(), "000660", PaperBooks.BUY, null, 10.0, null, PaperBooks.NEXT_OPEN, THU,
                Instant.parse("2026-10-29T13:40:00Z"));
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, THU, PaperConfig.DEFAULT_KR_INITIAL_CASH);

        Map<String, Object> ledger = service(KR_REGULAR, config).overview("KR");
        assertThat(MAPPER.writeValueAsString(withoutLive(ledger)))
                .isEqualTo(MAPPER.writeValueAsString(query(KR_REGULAR, config).overview("KR")));
        assertThat(current(ledger, 0)).containsEntry("stage", "PROVISIONAL").containsEntry("tradingDate", "2026-10-29")
                .containsEntry("pendingOrders", 1).containsEntry("note", "시가 체결 대기 1건 반영 전 — 그날 밤 관측치에서 체결");

        liveSnapshot(Datasets.SNAP_PAPER_LIVE_KR, "005930", 61_000, "2026-10-30T00:59:00Z");
        Map<String, Object> live = service(KR_REGULAR, config).overview("KR");
        assertThat(current(live, 0)).containsEntry("stage", "LIVE").containsEntry("nav", 101_000_000.0)
                .containsEntry("atKst", "2026-10-30 09:59 KST");
        assertThat(MAPPER.writeValueAsString(withoutLive(live))).as("장중 저장본이 있어도 장부 부분은 그대로")
                .isEqualTo(MAPPER.writeValueAsString(withoutLive(ledger)));
        assertThat(live.get("liveSession")).isEqualTo(Map.of("phase", "REGULAR", "sessionDate", "2026-10-30"));
        verify(reader, never()).read(eq(Datasets.SNAP_PAPER_LIVE_KR), anyLong(), nullable(String.class));
    }

    @Test
    @DisplayName("테이블이 없으면 장부 응답(available:false) 그대로 — 지금 값 칸 없음")
    void notReady() {
        store.ready = false;
        Map<String, Object> out = service(US_REGULAR, PaperFixtures.config()).overview(null);
        assertThat(out).containsEntry("available", false).doesNotContainKeys("navEstimate", "liveSession");
    }
}
