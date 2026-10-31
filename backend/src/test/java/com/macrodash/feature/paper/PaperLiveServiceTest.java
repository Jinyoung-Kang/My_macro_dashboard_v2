package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
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

    // ------------------------------------------------------------------ 재료
    private static Book book(String code, String status) {
        return new Book(code, "CLAUDE", code, 100_000, PaperFixtures.FRI, status, Instant.parse("2026-10-23T00:00:00Z"),
                Book.MARKET_US, "USD");
    }
}
