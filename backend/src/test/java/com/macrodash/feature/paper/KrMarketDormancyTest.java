package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 서버 안전(C1c — 이 코드는 4단계 교체로 서버에 갑니다): 운영 목록에 한국 묶음이 들어가도 <b>출발일이 비었거나 한국 계좌가 없으면 한국 일이
 * 하나도 돌지 않는다</b> — 정기 리스크 점검·결정·복기가 한국 실행을 열지 않아(공휴일·관측치 저장본을 읽지 않음) 작업 기록도 남기지 않고,
 * 수동 실행은 그 사유로 거절합니다. 미국 정기 실행은 그대로 돕니다.
 */
class KrMarketDormancyTest {

    /** 한국 결정 시각 뒤(2026-11-30 월 22:40 KST) — 쉬지 않는 시장이면 한국 결정 작업이 일할 시각. */
    private static final Instant NIGHT = Instant.parse("2026-11-30T13:40:00Z");
    private static final LocalDate S = LocalDate.of(2026, 11, 30);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = new PaperMarketData(reader, mock(com.macrodash.store.StoreRepository.class));
    }

    private static PaperConfig krConfig(LocalDate start) {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    private void runAll(PaperConfig config) {
        Clock clock = Clock.fixed(NIGHT, ZoneOffset.UTC);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        // 시계 생성자 = 운영 목록(미국 → 한국).
        new PaperRiskJob(store, reader, marketData, ledger, config, PaperFixtures.MAPPER, clock).scheduledRun();
        new PaperDecisionJob(store, reader, marketData, ledger, mock(PaperSelectionService.class),
                mock(RuleBookService.class), mock(ClaudeBookService.class), PaperFixtures.settings(store), config,
                PaperFixtures.MAPPER, clock).scheduledRun();
        new PaperReviewJob(store, reader, marketData, mock(ReviewService.class), config, PaperFixtures.MAPPER, clock)
                .scheduledRun();
    }

    private void verifyNoKrRead() {
        verify(reader, never()).read(eq(Datasets.SNAP_KR_HOLIDAYS), anyLong(), nullable(String.class));
        verify(reader, never()).read(eq(Datasets.SNAP_KR_PAPER_QUOTES), anyLong(), nullable(String.class));
        assertThat(store.jobRuns).extracting(r -> r.job()).noneMatch(job -> job.startsWith("kr."));
    }

    @Test
    @DisplayName("출발일이 비었으면(PAPER_KR_START_DATE 미정) 정기 작업 셋이 한국 실행을 열지 않는다 — 저장본 읽기·작업 기록 없음")
    void noStartDateMeansNothingKoreanRuns() {
        PaperConfig config = PaperFixtures.config();
        assertThat(config.krStartConfigured()).isFalse();
        // 한국 계좌가 있어도(손으로 만든 행) 출발일이 없으면 쉽니다.
        krBooks();

        runAll(config);

        verifyNoKrRead();
        assertThat(KrPaperMarket.INSTANCE.dormantReason(config, () -> store.books("KR")))
                .isEqualTo(PaperConfig.KR_START_MISSING);
    }

    @Test
    @DisplayName("출발일이 비어도 이미 출발한(운용·일시정지) 한국 계좌가 있으면 쉬지 않는다 — 배포 설정 한 줄이 빠져 대기 주문·확정 조정·순자산 줄이 소리 없이 멈추지 않게(출발·초기화만 막힘)")
    void startedBooksKeepRunningWithoutTheStartDate() {
        PaperConfig config = PaperFixtures.config();
        krBooks();
        store.updateBookStatus(PaperBooks.KR_BENCH_K200, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_BENCH_K200, S);

        assertThat(KrPaperMarket.INSTANCE.dormantReason(config, () -> store.books("KR"))).isNull();
        store.updateBookStatus(PaperBooks.KR_BENCH_K200, PaperBooks.PAUSED);
        assertThat(KrPaperMarket.INSTANCE.dormantReason(config, () -> store.books("KR"))).as("일시정지도 출발한 장부").isNull();
        store.updateBookStatus(PaperBooks.KR_BENCH_K200, PaperBooks.ACTIVE);

        runAll(config);

        verify(reader, org.mockito.Mockito.atLeastOnce())
                .read(eq(Datasets.SNAP_KR_HOLIDAYS), anyLong(), nullable(String.class));
        verify(reader, org.mockito.Mockito.atLeastOnce())
                .read(eq(Datasets.SNAP_KR_PAPER_QUOTES), anyLong(), nullable(String.class));
        Clock clock = Clock.fixed(NIGHT, ZoneOffset.UTC);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        PaperRiskJob risk = new PaperRiskJob(store, reader, marketData, ledger, config, PaperFixtures.MAPPER, clock);
        assertThat(risk.runNow(KrPaperMarket.INSTANCE).skippedReason()).as("쉼이 아니라 그 실행의 사유(저장본 없음)")
                .isNotEqualTo(PaperConfig.KR_START_MISSING).contains("paper.kr.quotes");
    }

    @Test
    @DisplayName("출발일이 있어도 한국 계좌가 없으면(한국 초기화 전) 한국 정기 작업이 돌지 않는다 — 미국 계좌만 있는 서버의 지금 모양")
    void noKoreanBooksMeansNothingKoreanRuns() {
        PaperFixtures.activeBook(store, PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, 100_000, null);

        runAll(krConfig(S));

        verifyNoKrRead();
        assertThat(KrPaperMarket.INSTANCE.dormantReason(krConfig(S), java.util.List::of))
                .isEqualTo(KrPaperMarket.NOT_INITIALIZED);
    }

    @Test
    @DisplayName("수동 실행도 같은 사유로 거절 — 결정(한국 Claude 계좌)·복기는 400, 리스크 점검은 건너뜀 사유")
    void manualRunsAreRefusedWhileDormant() {
        PaperConfig config = PaperFixtures.config();
        Clock clock = Clock.fixed(NIGHT, ZoneOffset.UTC);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        PaperDecisionJob decision = new PaperDecisionJob(store, reader, marketData, ledger,
                mock(PaperSelectionService.class), mock(RuleBookService.class), mock(ClaudeBookService.class),
                PaperFixtures.settings(store), config, PaperFixtures.MAPPER, clock);
        PaperReviewJob review = new PaperReviewJob(store, reader, marketData, mock(ReviewService.class), config,
                PaperFixtures.MAPPER, clock);
        PaperRiskJob risk = new PaperRiskJob(store, reader, marketData, ledger, config, PaperFixtures.MAPPER, clock);

        assertThatThrownBy(() -> decision.runNow(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessage(PaperConfig.KR_START_MISSING);
        assertThatThrownBy(() -> review.runNow(KrPaperMarket.INSTANCE))
                .isInstanceOf(InvalidRequestException.class).hasMessage(PaperConfig.KR_START_MISSING);
        assertThat(risk.runNow(KrPaperMarket.INSTANCE).skippedReason()).isEqualTo(PaperConfig.KR_START_MISSING);
        // 화면 경로 응답(POST /api/paper/run/risk?market=KR, F1) — 예외가 아니라 ok:false와 쉬는 사유, 실행은 열지 않음.
        java.util.Map<String, Object> view = risk.runNowView(KrPaperMarket.INSTANCE);
        assertThat(view).containsEntry("ok", false).containsEntry("market", "KR")
                .containsEntry("dormantReason", PaperConfig.KR_START_MISSING);
        assertThat(((PaperLedgerService.Outcome) view.get("outcome")).skippedReason())
                .isEqualTo(PaperConfig.KR_START_MISSING);
        assertThat(decision.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperDecisionJob.DORMANT);
        assertThat(review.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperReviewJob.DORMANT);
        verifyNoKrRead();
    }

    @Test
    @DisplayName("출발일과 한국 계좌가 갖춰지면 한국 실행을 연다 — 그 실행이 공휴일 저장본을 조용히 읽어 달력을 만듦(대조)")
    void readyMarketOpensItsRun() {
        krBooks();

        runAll(krConfig(S));

        verify(reader, org.mockito.Mockito.atLeastOnce())
                .read(eq(Datasets.SNAP_KR_HOLIDAYS), anyLong(), nullable(String.class));
    }

    /** 한국 네 계좌(현금만, 시작 전). */
    private void krBooks() {
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, null, PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
            store.states.put(d.code(), new BookState(d.code(), 100_000_000, 100_000_000, 0, 0, null, null, null, null));
        }
        assertThat(BigDecimal.valueOf(100_000_000)).isEqualTo(PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }
}
