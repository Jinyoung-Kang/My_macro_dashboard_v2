package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 장중 평가(GET /api/paper/live) — 정규장에만 수집 요청. 계산은 {@link LiveValuationTest}.
 *
 * <p>2026-10-30(금)은 미국 서머타임(동부 = UTC−4)이라 정규장이 13:30~20:00 UTC, 다음 거래일 11-02(월)은 서머타임이 끝나 14:30 UTC 개장.
 */
class PaperLiveServiceTest {

    @Test
    @DisplayName("정규장에만 live 읽기(오래되면 수집 요청 — refreshRequested), 장 밖에서는 저장본만 읽고 요청하지 않음")
    void triggersOnlyDuringRegularSession() throws Exception {
        FakePaperStore store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        store.insertBookIfAbsent(book("claude", "ACTIVE"));
        StoreReader reader = PaperFixtures.quietReader();
        Snapshot old = new Snapshot(Datasets.SNAP_PAPER_LIVE_US, MAPPER.readTree("""
                {"source": "Yahoo(yfinance) 1분봉", "tickers": {}, "missing": ["AAA"], "error": null}"""),
                "json", "ok", null, Instant.parse("2026-10-30T14:00:00Z"));
        when(reader.read(eq(Datasets.SNAP_PAPER_LIVE_US), anyLong(), eq("paper_live_us"))).thenReturn(Optional.of(old));
        when(reader.readStored(Datasets.SNAP_PAPER_LIVE_US)).thenReturn(Optional.of(old));
        PaperMarketData marketData = new PaperMarketData(reader, mock(StoreRepository.class),
                Clock.fixed(Instant.parse("2026-10-30T15:00:00Z"), ZoneOffset.UTC));
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, null, PaperConfig.DEFAULT_KR_INITIAL_CASH);

        PaperLiveService regular = new PaperLiveService(store, reader, marketData, new PaperMarkets(store, reader), config,
                Clock.fixed(Instant.parse("2026-10-30T15:00:00Z"), ZoneOffset.UTC));
        Map<String, Object> out = regular.live(null);
        assertThat(out).containsEntry("market", "US").containsEntry("isEstimated", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> quotes = (Map<String, Object>) out.get("quotes");
        assertThat(quotes).containsEntry("refreshRequested", true).containsEntry("source", "Yahoo(yfinance) 1분봉");
        verify(reader).read(eq(Datasets.SNAP_PAPER_LIVE_US), eq(Datasets.MAX_AGE_LIVE), eq("paper_live_us"));

        StoreReader closedReader = PaperFixtures.quietReader();
        when(closedReader.readStored(Datasets.SNAP_PAPER_LIVE_US)).thenReturn(Optional.of(old));
        PaperLiveService saturday = new PaperLiveService(store, closedReader, marketData,
                new PaperMarkets(store, closedReader), config, Clock.fixed(Instant.parse("2026-10-31T15:00:00Z"), ZoneOffset.UTC));
        @SuppressWarnings("unchecked")
        Map<String, Object> session = (Map<String, Object>) saturday.live("US").get("session");
        assertThat(session).containsEntry("phase", LiveValuation.CLOSED);
        verify(closedReader, never()).read(eq(Datasets.SNAP_PAPER_LIVE_US), anyLong(), anyString());
    }

    @Test
    @DisplayName("계좌 줄에 평가액·노출·직전 줄의 확정 여부·시각이 지난 대기 주문 수 — 장부 한 벌(ledgers)과 그 시장 달력으로")
    void bookRowCarriesLedgerFields() throws Exception {
        FakePaperStore store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        LocalDate thu = LocalDate.of(2026, 10, 29);
        store.insertBookIfAbsent(book("claude2", "ACTIVE"));
        Instant observed = Instant.parse("2026-10-30T14:05:00Z");   // 장부 상태의 마지막 관측(금요일 장중 시간별 관측치)
        store.upsertState(new BookState("claude2", 50_000, 100_000, 50_000, 50.0, observed, observed, thu, null));
        PaperFixtures.position(store, "claude2", "AAA", 100, 500, 500, 500.0, thu, 500);
        store.upsertNav(new NavRow("claude2", thu, 99_000, 99_000, 0, 0, false));
        // 기준 거래일 목요일 → 금요일 10:00 ET 시각 지정 매수(지남)·15:00 ET(아직)
        PaperFixtures.pending(store, "claude2", "BBB", PaperBooks.BUY, null, 10.0, null, PaperBooks.AT_1000, thu,
                Instant.parse("2026-10-30T01:00:00Z"));
        PaperFixtures.pending(store, "claude2", "CCC", PaperBooks.BUY, null, 10.0, null, PaperBooks.AT_1500, thu,
                Instant.parse("2026-10-30T01:00:00Z"));
        StoreReader reader = PaperFixtures.quietReader();
        Snapshot snapshot = new Snapshot(Datasets.SNAP_PAPER_LIVE_US, MAPPER.readTree("""
                {"source": "Yahoo(yfinance) 1분봉", "tickers": {"AAA": {"price": 510, "at": "2026-10-30T14:58:00+00:00"}},
                 "missing": [], "error": null}"""), "json", "ok", null, Instant.parse("2026-10-30T14:59:30Z"));
        when(reader.read(eq(Datasets.SNAP_PAPER_LIVE_US), anyLong(), eq("paper_live_us"))).thenReturn(Optional.of(snapshot));
        Clock clock = Clock.fixed(Instant.parse("2026-10-30T15:00:00Z"), ZoneOffset.UTC);
        PaperLiveService live = new PaperLiveService(store, reader, new PaperMarketData(reader, mock(StoreRepository.class),
                clock), new PaperMarkets(store, reader), PaperFixtures.config(), clock);

        @SuppressWarnings("unchecked")
        Map<String, Object> row = ((List<Map<String, Object>>) live.live("US").get("books")).get(0);
        // 50,000 + 100 × 510(장중 14:58 봉이 장부 관측(10-23 마감 뒤)보다 늦음) = 101,000
        assertThat(row).containsEntry("code", "claude2").containsEntry("nav", 101_000.0).containsEntry("equityValue", 51_000.0)
                .containsEntry("exposurePct", 50.5).containsEntry("previousTradingDate", "2026-10-29")
                .containsEntry("previousNavFinal", false).containsEntry("pendingOrders", 1);
    }

    // ------------------------------------------------------------------ 재료
    private static Book book(String code, String status) {
        return new Book(code, "CLAUDE", code, 100_000, PaperFixtures.FRI, status, Instant.parse("2026-10-23T00:00:00Z"),
                Book.MARKET_US, "USD");
    }
}
