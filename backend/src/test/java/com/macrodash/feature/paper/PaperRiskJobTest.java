package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 리스크 점검 정기 작업 — 꺼짐·할 일 없음·일했을 때의 기록.
 */
class PaperRiskJobTest {

    /** 정기·수동 실행이 미국 시장으로 저장본을 읽습니다(2단계 명세 §9 A5 — 시장마다 관측치를 읽음). */
    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    private FakePaperStore store;
    private PaperMarketData marketData;
    private StoreReader reader;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        reader = PaperFixtures.quietReader();
    }

    private PaperRiskJob job(boolean enabled) {
        return job(enabled, new PaperLedgerService(store, marketData, PaperFixtures.settings(store),
                PaperFixtures.MAPPER));
    }

    private PaperRiskJob job(boolean enabled, PaperLedgerService ledger) {
        return new PaperRiskJob(store, reader, marketData, ledger, new PaperConfig(enabled, FRI, 100_000),
                PaperFixtures.MAPPER, Clock.fixed(MON_FINAL.plusSeconds(30), ZoneOffset.UTC));
    }

    @Test
    @DisplayName("꺼져 있으면 정기 실행은 저장본도 읽지 않는다")
    void disabledDoesNothing() {
        job(false).scheduledRun();

        verify(marketData, never()).quotes();
        verify(marketData, never()).quotes(any());
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("저장본이 없거나 새 관측치가 없으면 기록을 남기지 않고 이유만 돌려준다")
    void nothingToDoLeavesNoRecord() {
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        when(marketData.quotes(US)).thenReturn(Optional.empty());
        assertThat(job(true).runNow().skippedReason()).contains("paper.quotes");

        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, MON_FINAL);
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(MON_FINAL, bar("SPY", FRI, 500, MON, 501))));
        assertThat(job(true).runNow().skippedReason()).contains("새 관측치가 없습니다");

        assertThat(store.jobRuns).isEmpty();
        verify(reader, org.mockito.Mockito.atLeastOnce()).quietly(any());
    }

    @Test
    @DisplayName("새 관측치를 처리하면 장중 봉 확인용 요약(수집 시각·봉 날짜·확정 여부)과 결과를 남긴다 — 수동 실행은 꺼져 있어도 돈다")
    void recordsWorkWithObservationSummary() {
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("SPY", FRI, 500, MON, 501),
                bar("QQQ", FRI, 400, MON, 401))));

        Outcome outcome = job(false).runNow();

        assertThat(outcome.booksProcessed()).containsExactly(PaperBooks.CLAUDE);
        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("risk");
            assertThat(run.outcome()).isEqualTo("OK");
            assertThat(run.detail().path("barDate").asString()).isEqualTo("2026-10-26");
            assertThat(run.detail().path("session").asString()).isEqualTo("2026-10-26");
            assertThat(run.detail().path("finalClose").asBoolean(true)).as("장중 봉").isFalse();
            assertThat(run.detail().path("tickers").asInt()).isEqualTo(2);
            assertThat(run.detail().path("manual").asBoolean()).isTrue();
            assertThat(run.detail().path("collectedAtKst").asString()).isEqualTo("2026-10-27 00:00 KST");
        });

        // 같은 저장본을 다시 돌려도 기록이 늘지 않음(멱등)
        job(true).scheduledRun();
        assertThat(store.jobRuns).hasSize(1);
    }

    @Test
    @DisplayName("처리 중 예외는 오류로 기록하고 삼킨다(정기 실행이 멈추지 않음)")
    void errorsAreRecorded() {
        activeBook(store, PaperBooks.RULES, PaperBooks.KIND_RULES, 100_000, null);
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "claude", 100_000, FRI,
                PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE));   // 상태 행이 없는 책 — 처리 중 예외
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("SPY", FRI, 500, MON, 501))));

        job(true).scheduledRun();

        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.outcome()).isEqualTo("ERROR");
            assertThat(run.detail().path("errors").toString()).contains("claude").contains("상태");
            assertThat(run.detail().path("booksProcessed").toString()).contains("rules");
        });
    }

    @Test
    @DisplayName("오류가 난 관측치는 정기 실행이 다시 돌리지도 기록하지도 않는다 — 새 관측치에서 다시, 수동 실행은 한 번 더")
    void failingObservationIsRecordedOnce() {
        // claude 책의 상태 저장이 늘 실패 — 멱등 키가 그대로라 기억이 없으면 같은 저장본이 5분마다 '새 관측치'로 보입니다.
        store = new FakePaperStore() {
            @Override
            public void upsertState(com.macrodash.store.PaperStore.BookState s) {
                if (s.bookCode().equals(PaperBooks.CLAUDE) && s.lastProcessedCollectedAt() != null) {
                    throw new IllegalStateException("디스크 가득 참");
                }
                super.upsertState(s);
            }
        };
        activeBook(store, PaperBooks.RULES, PaperBooks.KIND_RULES, 100_000, null);
        activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(MON_INTRADAY, bar("SPY", FRI, 500, MON, 501))));
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.settings(store),
                PaperFixtures.MAPPER);
        PaperRiskJob job = job(true, ledger);

        job.scheduledRun();
        job.scheduledRun();   // 5분 뒤 — 같은 저장본
        job.scheduledRun();
        assertThat(store.jobRuns).as("ERROR 한 줄만").singleElement()
                .satisfies(run -> assertThat(run.outcome()).isEqualTo("ERROR"));
        Outcome held = job.run(false);
        assertThat(held.skippedReason()).contains("claude").contains("새 관측치에서 다시 시도");

        assertThat(job.runNow().errors()).as("수동 실행은 같은 관측치로 한 번 더").singleElement().asString()
                .startsWith("claude: ");
        assertThat(store.jobRuns).hasSize(2);
        job.scheduledRun();
        assertThat(store.jobRuns).hasSize(2);

        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(MON_FINAL, bar("SPY", FRI, 500, MON, 502))));
        job.scheduledRun();   // 새 관측치 — 다시 시도(여전히 실패하면 그 관측치에서 한 번 기록)
        assertThat(store.jobRuns).hasSize(3);
        assertThat(store.jobRuns.get(2).detail().path("booksProcessed").toString()).contains("rules");
    }
}
