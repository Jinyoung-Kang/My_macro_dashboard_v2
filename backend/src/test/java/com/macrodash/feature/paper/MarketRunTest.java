package com.macrodash.feature.paper;

import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Review;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static com.macrodash.feature.paper.PaperFixtures.pending;
import static com.macrodash.feature.paper.PaperFixtures.position;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 실행 하나의 시장 문맥({@link MarketRun}, 2단계 명세 §9 묶음 A 리뷰 메모 'C1 — 시장 목록과 실행마다 달력 한 벌', C1a) — 시장 목록 빈
 * ({@link PaperMarkets})이 실행을 열 때 설정 행을 한 번 읽고 그 판과 조용히 읽은 저장본으로 달력을 <b>한 번</b> 만들며, 리스크 점검·
 * 복기 작업·조회가 실행 하나에 그 한 벌만 쓰는지를 실행마다 달력을 만드는 시험용 한국 묶음({@link TestKrMarket#perRun} — 고정 달력이
 * 없어 실행 밖에서 달력을 물으면 던짐)으로 봅니다. 결정 작업 한 번(장부·관측치 요약·Claude 결정)이 달력 한 벌·설정 판 하나인 것은 가짜
 * Claude 서버가 있는 {@code ClaudeBookServiceTest}가 봅니다.
 */
class MarketRunTest {

    private static final String KR_BOOK = TestKrMarket.CLAUDE_BOOK;
    /** 10-26(월) 21:00 KST — 시험용 한국 달력으로 그날 세션의 확정 종가 뒤. */
    private static final Instant KR_EVENING = Instant.parse("2026-10-26T12:00:00Z");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    /** 실행을 열 때마다 만든 달력(만든 순서). */
    private List<CountingCalendar> opened;
    /** 실행을 열 때 시장 묶음이 받은 재료. */
    private List<MarketRun.Inputs> inputs;
    private TestKrMarket kr;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        opened = new ArrayList<>();
        inputs = new ArrayList<>();
        kr = TestKrMarket.perRun(CountingCalendar.factory(opened, inputs));
    }

    /** 운용 중인 시험용 한국 책 — 보유 005930(금요일 확정가)·대기 매수 000660(NEXT_CLOSE), 그 시장 관측치(월요일 봉, 서울 21:00 수집). */
    private Quotes krBook() {
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        Instant krFriday = Instant.parse("2026-10-23T13:30:00Z");
        store.states.put(KR_BOOK, new BookState(KR_BOOK, 30_000_000, 100_700_000, 70_700_000, 70.2085, krFriday,
                krFriday, FRI, null));
        position(store, KR_BOOK, "005930", 1_000, 70_000, 72_000, 70_700.0, FRI, 70_700);
        pending(store, KR_BOOK, "000660", "BUY", 10, null, null, PaperBooks.NEXT_CLOSE, FRI, krFriday);
        Quotes quotes = quotes(KR_EVENING, bar("005930", FRI, 70_700, MON, 71_000),
                bar("000660", FRI, 200_000, MON, 201_000));
        when(marketData.quotes(market(kr))).thenReturn(Optional.of(quotes));
        return quotes;
    }

    @Test
    @DisplayName("실행 열기: 설정 행을 한 번 읽고 그 본문과 조용한 저장본 읽기(StoreReader.quietly)로 시장 묶음이 달력을 한 번 만든다 — 연 실행은 그 판을 지키고, 이미 연 실행을 다시 열면 그대로, 설정 행이 없으면 판·본문 null")
    @SuppressWarnings("unchecked")
    void openReadsSettingsOnceAndBuildsOneCalendar() {
        StoreReader quiet = mock(StoreReader.class);
        AtomicBoolean inQuiet = new AtomicBoolean();
        List<Boolean> readsInQuiet = new ArrayList<>();
        when(quiet.quietly(any())).thenAnswer(invocation -> {
            inQuiet.set(true);
            try {
                return ((Supplier<Object>) invocation.getArgument(0)).get();
            } finally {
                inQuiet.set(false);
            }
        });
        Snapshot holidays = new Snapshot(Datasets.SNAP_KR_HOLIDAYS, MAPPER.createObjectNode(), "json", "ok", null,
                KR_EVENING);
        when(quiet.read(anyString(), anyLong(), any())).thenAnswer(invocation -> {
            readsInQuiet.add(inQuiet.get());
            return Optional.of(holidays);
        });
        List<Optional<Snapshot>> readByMarket = new ArrayList<>();
        TestKrMarket reading = TestKrMarket.perRun(in -> {
            readByMarket.add(in.snapshots().read(Datasets.SNAP_KR_HOLIDAYS, Datasets.MAX_AGE_WEEKLY, "kr_holidays"));
            return CountingCalendar.factory(opened, inputs).apply(in);
        });
        PaperMarkets markets = new PaperMarkets(store, quiet, List.of(UsPaperMarket.INSTANCE, reading));

        MarketRun before = markets.open(reading);
        assertThat(before.settingsRow()).as("초기화 전 — 설정 행 없음").isEmpty();
        assertThat(before.settingsVersion()).isNull();
        assertThat(before.settingsBody()).isNull();
        assertThat(inputs.get(0).settingsBody()).isNull();

        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        MarketRun run = markets.open(reading);
        assertThat(opened).as("실행마다 한 벌").hasSize(2);
        assertThat(run.calendar()).isSameAs(opened.get(1));
        assertThat(run.settingsVersion()).isEqualTo(1);
        assertThat(run.settingsBody()).isSameAs(store.settings.body());
        assertThat(inputs.get(1).settingsBody()).as("달력 재료 = 그 실행이 읽은 판의 본문").isSameAs(run.settingsBody());
        assertThat(readByMarket).containsExactly(Optional.of(holidays), Optional.of(holidays));
        assertThat(readsInQuiet).as("저장본은 수집을 깨우지 않는 읽기로만").containsExactly(true, true);
        verify(quiet, never()).read(eq(Datasets.SNAP_PAPER_QUOTES), anyLong(), any());

        store.saveSettings(store.settings.body(), List.of("maxPositions"));
        assertThat(run.settingsVersion()).as("연 뒤 저장한 새 판은 그 실행에 끼지 않음").isEqualTo(1);
        assertThat(markets.open(run)).as("이미 연 실행은 그대로 — 달력을 다시 만들지 않음").isSameAs(run);
        assertThat(MarketRun.of(run, store)).isSameAs(run);
        assertThat(opened).hasSize(2);

        assertThat(run.definition()).isSameAs(reading);
        assertThat(run.code()).isEqualTo("KR");
        assertThat(run.jobName("risk")).isEqualTo("kr.risk");
        assertThat(run.books()).isEqualTo(reading.books());
        assertThat(run.toString()).contains("KR").contains("v1");
        assertThatThrownBy(reading::calendar).as("실행마다 달력을 만드는 묶음은 고정 달력이 없음")
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> MarketRun.of(reading, store)).as("실행 밖의 옛 경로로는 열 수 없음")
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new PaperMarkets(store, quiet, List.of(run)))
                .isInstanceOf(IllegalArgumentException.class);

        MarketRun us = markets.open(UsPaperMarket.INSTANCE);
        assertThat(us.calendar()).as("미국은 고정 달력 그대로").isSameAs(UsMarketCalendar.CALENDAR);
        assertThat(us.definition()).isSameAs(UsPaperMarket.INSTANCE);
        assertThat(us.settingsVersion()).isEqualTo(2);
        assertThat(readsInQuiet).as("미국 달력은 저장본을 읽지 않음").hasSize(2);

        store.ready = false;
        assertThat(markets.open(UsPaperMarket.INSTANCE).settingsRow()).as("테이블이 없으면 행 없이").isEmpty();
    }

    @Test
    @DisplayName("리스크 점검 한 번 = 달력 한 벌 — 그 실행의 달력으로 앞 창 확인·장부(세션·확정 판정·체결·순자산)·관측치 요약을 하고, 다음 실행은 새 한 벌을 연다(실행 밖에서 달력을 물으면 이 시장 묶음은 던짐)")
    void riskRunUsesOneCalendar() {
        krBook();
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        PaperRiskJob job = new PaperRiskJob(store, reader, marketData, ledger, PaperFixtures.config(), MAPPER,
                Clock.fixed(KR_EVENING.plusSeconds(600), ZoneOffset.UTC), List.of(kr));

        Outcome outcome = job.run(kr, false);

        assertThat(outcome.errors()).isEmpty();
        assertThat(outcome.booksProcessed()).containsExactly(KR_BOOK);
        assertThat(outcome.filled()).as("NEXT_CLOSE 매수 — 그 실행 달력의 확정 판정으로 체결").isEqualTo(1);
        assertThat(opened).as("실행 하나에 달력 한 벌").hasSize(1);
        assertThat(opened.get(0).calls()).as("그 한 벌을 실제로 씀").isPositive();
        assertThat(store.navSeries(KR_BOOK)).extracting(NavRow::tradingDate, NavRow::pricesFinal)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(MON, true));
        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("kr.risk");
            assertThat(run.detail().path("session").asString()).isEqualTo(MON.toString());
            assertThat(run.detail().path("finalClose").asBoolean()).isTrue();
        });

        int used = opened.get(0).calls();
        assertThat(job.run(kr, false).skippedReason()).contains("새 관측치가 없습니다");
        assertThat(opened).as("다음 실행은 새 한 벌").hasSize(2);
        assertThat(opened.get(0).calls()).as("앞 실행의 달력은 다시 쓰지 않음").isEqualTo(used);
    }

    @Test
    @DisplayName("조회 한 번 = 달력 한 벌 — 개요·상태·보유·책 요약이 그 시장 실행을 하나씩 열어 통계 표본·확정 판정·보유 거래일을 그 한 벌로 센다")
    @SuppressWarnings("unchecked")
    void queryOpensOneCalendarPerCall() {
        krBook();
        store.upsertNav(new NavRow(KR_BOOK, FRI, 100_000_000, 100_000_000, 0, 0, true));
        store.upsertNav(new NavRow(KR_BOOK, MON, 101_000_000, 30_000_000, 71_000_000, 70.3, true));
        PaperQueryService query = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store),
                PaperFixtures.config(), Clock.fixed(KR_EVENING, ZoneOffset.UTC), List.of(UsPaperMarket.INSTANCE, kr));

        Map<String, Object> overview = query.overview(kr);
        assertThat(opened).hasSize(1);
        Map<String, Object> book = ((List<Map<String, Object>>) overview.get("books")).get(0);
        assertThat(((Map<String, Object>) book.get("stats")).get("sampleDays")).as("금 → 월 1거래일(서울 평일)").isEqualTo(1);
        assertThat(((Map<String, Object>) overview.get("quotes")).get("finalClose")).isEqualTo(true);

        assertThat(query.status(kr).get("initialized")).isEqualTo(true);
        assertThat(opened).hasSize(2);

        List<Map<String, Object>> rows = (List<Map<String, Object>>) query.positions(KR_BOOK).get("positions");
        assertThat(opened).hasSize(3);
        assertThat(rows.get(0).get("holdingTradingDays")).as("금 → 월 1거래일(서울 평일)").isEqualTo(1);

        assertThat(query.bookSummary(KR_BOOK).get("code")).isEqualTo(KR_BOOK);
        assertThat(opened).hasSize(4);
        assertThat(opened).allSatisfy(calendar -> assertThat(calendar.calls()).isPositive());
    }

    @Test
    @DisplayName("복기 작업 한 번 = 달력 한 벌 — 앞 창 확인·복기 주·확정 종가 판정과 복기 서비스가 받는 시장 문맥이 같은 실행(수동 실행도)")
    void reviewRunUsesOneCalendar() {
        LocalDate week = LocalDate.of(2026, 10, 30);
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        store.upsertNav(new NavRow(KR_BOOK, week, 101_000_000, 0, 101_000_000, 0, true));
        ReviewService reviews = mock(ReviewService.class);
        List<PaperMarket> received = new ArrayList<>();
        Review krRow = new Review(week, 4, MAPPER.createObjectNode(), null, null, null, null, null, Review.OK, null,
                null, 0, 0, null, Book.MARKET_KR);
        when(reviews.review(market(kr), eq(week), org.mockito.ArgumentMatchers.anyBoolean())).thenAnswer(invocation -> {
            received.add(invocation.getArgument(0));
            return new ReviewService.Outcome(ReviewService.Kind.CALLED, krRow, null);
        });
        Instant saturdayNight = Instant.parse("2026-10-31T14:00:00Z");   // 토 23:00 KST — 시험용 한국 복기(토 22:30) 뒤
        PaperReviewJob job = new PaperReviewJob(store, reader, marketData, reviews, PaperFixtures.config(), MAPPER,
                Clock.fixed(saturdayNight, ZoneOffset.UTC), List.of(kr));

        assertThat(job.run(kr).outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(opened).hasSize(1);
        assertThat(received).singleElement().satisfies(run -> {
            assertThat(run).isInstanceOf(MarketRun.class);
            assertThat(run.calendar()).as("복기 서비스도 그 실행의 한 벌").isSameAs(opened.get(0));
        });

        assertThat(job.runNow(kr).get("outcome")).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(opened).as("수동 실행도 한 번에 한 벌(주를 정할 때와 복기할 때가 같은 실행)").hasSize(2);
        assertThat(received.get(1).calendar()).isSameAs(opened.get(1));
    }
}
