package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Review;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 주간 복기 작업(2단계 명세 §4-9 '토 22:30'·K19, E3) — 실제 한국 묶음({@link KrPaperMarket}, 공휴일 저장본으로 그 실행이 만든
 * {@link KrxCalendar})으로 부르는 조건을 봅니다: 토요일 22:30 KST(코드 상수), 금요일 잠정 종가 순자산 줄로 엶, 놓친 토요일은 다음 기동
 * 첫 주기, 금요일 휴장이면 목요일. 복기 자체({@link ReviewService})는 가짜(mock)로 두고 불렸는지만 봅니다.
 *
 * <p>시각: 기준 주 2026-11-02(월)~11-06(금), 그 주 복기 = 토 11-07 22:30 KST = 13:30Z. 한국 출발일 10-29, 네 계좌 운용 중(10-30 출발).
 */
class KrReviewJobTest {

    private static final PaperMarket KR = KrPaperMarket.INSTANCE;
    private static final LocalDate WE = LocalDate.of(2026, 11, 6);
    private static final LocalDate STARTED = LocalDate.of(2026, 10, 30);
    private static final Instant OPENS = kst("2026-11-07T22:30");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private ReviewService reviews;

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        reviews = mock(ReviewService.class);
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, STARTED, PaperBooks.ACTIVE,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
    }

    private PaperReviewJob job(Instant now) {
        return job(Clock.fixed(now, ZoneOffset.UTC));
    }

    private PaperReviewJob job(Clock clock) {
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, LocalDate.of(2026, 10, 29),
                PaperConfig.DEFAULT_KR_INITIAL_CASH);
        return new PaperReviewJob(store, reader, marketData, reviews, config, MAPPER, clock,
                List.of(UsPaperMarket.INSTANCE, KR));
    }

    /** 장부가 그 세션 마감 뒤 관측치로 남긴 한국 Claude 계좌의 잠정 순자산 줄(금융위 확정 전 — prices_final=false). */
    private void provisionalNav(LocalDate day) {
        store.upsertNav(new NavRow(PaperBooks.KR_CLAUDE, day, 101_000_000, 0, 101_000_000, 0, false));
    }

    private static Review krRow(LocalDate week) {
        return new Review(week, 4, MAPPER.createObjectNode(), null, null, null, null, null, Review.OK, null, null, 0, 0,
                null, Book.MARKET_KR);
    }

    private void answers(LocalDate week) {
        when(reviews.review(market(KR), eq(week), anyBoolean()))
                .thenReturn(new ReviewService.Outcome(ReviewService.Kind.CALLED, krRow(week), null));
    }

    /** 다음 세션(11-09 월) 밤 관측치 — 다수 봉 날짜가 월요일(관측치 저장본이 기준 주를 지나감). */
    private static Optional<PaperMarketData.Quotes> mondayQuotes() {
        LocalDate monday = LocalDate.of(2026, 11, 9);
        KrFixtures.Payload payload = new KrFixtures.Payload(monday);
        Instant fetched = kst("2026-11-09T21:58");
        payload.code("005930", fetched).bar(WE, 50_000, 50_500, 10_000).bar(monday, 50_600, 51_000, 12_000);
        payload.etf("069500", fetched).bar(WE, 95_000, 95_100, 30_000).bar(monday, 95_200, 95_400, 31_000);
        return KR.parse(payload.snapshot(kst("2026-11-09T22:00")));
    }

    @Test
    @DisplayName("한국 복기는 토요일 22:30 KST(코드 상수 — 설정 아님, K38)에 열리고 금요일 잠정 종가 순자산 줄(금융위 확정 전)로 부른다 — 미국 복기 시각 토 09:00은 한국에 해당 없음, 관측치 저장본은 보지 않음, 작업 기록 kr.review")
    void opensSaturdayTenThirtyKstOnTheProvisionalFridayRow() {
        provisionalNav(WE);
        answers(WE);
        assertThat(KR.reviewOpening(WE)).as("기준 주 토요일 22:30 KST").isEqualTo(OPENS);
        assertThat(KrPaperMarket.REVIEW_OPENS_ON).isEqualTo(java.time.DayOfWeek.SATURDAY);
        assertThat(KrPaperMarket.REVIEW_OPENS_AT).isEqualTo(java.time.LocalTime.of(22, 30));

        PaperReviewJob.Result morning = job(kst("2026-11-07T09:00")).run(KR);
        assertThat(morning.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(morning.weekEnding()).as("그 실행의 한국 달력으로 센 기준 주").isEqualTo(WE);
        PaperReviewJob.Result early = job(OPENS.minusSeconds(1)).run(KR);
        assertThat(early.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(early.message()).contains("2026-11-07 22:30 KST");
        verify(reviews, never()).review(any(), any(), anyBoolean());

        PaperReviewJob.Result result = job(OPENS).run(KR);

        assertThat(result.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(result.weekEnding()).isEqualTo(WE);
        verify(reviews, times(1)).review(market(KR), eq(WE), eq(true));
        verify(marketData, never()).quotes(any(PaperMarket.class));
        assertThat(store.jobRuns).singleElement().satisfies(run -> {
            assertThat(run.job()).isEqualTo("kr.review");
            assertThat(run.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
            assertThat(run.detail().path("weekEnding").asString()).isEqualTo("2026-11-06");
        });
    }

    @Test
    @DisplayName("Claude 계좌의 금요일 순자산 줄이 아직 없으면(장부가 금요일 밤 관측치를 아직 반영하지 않음) 기다림 — 잠정 줄이 생기면 부름(금융위 확정은 기다리지 않음)")
    void waitsOnlyForTheFridayRow() {
        answers(WE);
        provisionalNav(LocalDate.of(2026, 11, 5));   // 목요일 줄만

        PaperReviewJob.Result waiting = job(OPENS).run(KR);
        assertThat(waiting.outcome()).isEqualTo(PaperReviewJob.WAITING_FINAL_CLOSE);
        assertThat(waiting.message()).contains("2026-11-06 잠정 종가 순자산 줄이 아직 없습니다")
                .contains("금융위 확정을 기다리지 않음");
        verify(reviews, never()).review(any(), any(), anyBoolean());

        provisionalNav(WE);
        assertThat(job(OPENS.plusSeconds(1_800)).run(KR).outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        verify(reviews, times(1)).review(market(KR), eq(WE), eq(true));
    }

    @Test
    @DisplayName("놓친 토요일(서버 꺼짐)은 다음 기동 첫 주기에 그 주를 복기 — 일요일 밤 기동, 월요일 밤 관측치가 다음 세션으로 넘어간 뒤에도(잠정 줄 그대로), 다음 금요일 장 마감(15:30) 뒤에는 새 주를 기다림")
    void missedSaturdayRunsOnTheNextBootsFirstCycle() {
        provisionalNav(WE);
        answers(WE);

        // 일요일 21:55 기동 + 첫 주기 지연 180초 — 새 작업 인스턴스(재기동)의 정기 실행 한 번.
        job(kst("2026-11-08T21:58")).scheduledRun();
        assertThat(store.jobRuns).extracting(PaperStore.JobRun::job).containsExactly("kr.review");
        verify(reviews, times(1)).review(market(KR), eq(WE), eq(true));

        // 그 실행이 실패해 행이 없었다고 치고(가짜 복기 — 행을 쓰지 않음), 월요일 밤 기동: 관측치 저장본은 월요일 판(그 주를 지나감)이고
        // 금요일 줄은 여전히 잠정(ETF 확정 전) — 그래도 그 주를 복기합니다(미국 식으로 관측치를 보면 주를 넘길 때까지 기다림).
        when(marketData.quotes(market(KR))).thenReturn(mondayQuotes());
        PaperReviewJob.Result monday = job(kst("2026-11-09T22:01")).run(KR);
        assertThat(monday.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(monday.weekEnding()).isEqualTo(WE);

        // 그 주 행이 생긴 뒤(복기가 남김)에는 다음 금요일 마감 전까지 '이미 복기함', 그 뒤에는 새 주를 기다림.
        assertThat(store.insertReviewIfAbsent(krRow(WE))).isTrue();
        PaperReviewJob.Result thursday = job(kst("2026-11-12T23:00")).run(KR);
        assertThat(thursday.outcome()).isEqualTo(PaperReviewJob.ALREADY_REVIEWED);
        assertThat(thursday.weekEnding()).as("다음 금요일 마감 전까지는 그 주").isEqualTo(WE);
        assertThat(job(kst("2026-11-13T15:29")).run(KR).weekEnding()).as("15:30 마감 전에는 아직 지난 주")
                .isEqualTo(WE);

        PaperReviewJob.Result nextFriday = job(kst("2026-11-13T15:31")).run(KR);
        assertThat(nextFriday.outcome()).as("다음 주 금요일 장 마감 뒤에는 새 주 — 지난 주는 다시 보지 않음")
                .isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(nextFriday.weekEnding()).isEqualTo(LocalDate.of(2026, 11, 13));
        verify(reviews, times(2)).review(market(KR), eq(WE), eq(true));
    }

    @Test
    @DisplayName("금요일이 한국 휴장이면 목요일이 기준일 — 2026-10-09(한글날, 금) 주는 10-08, 복기는 그래도 토요일 22:30 KST")
    void hangulDayFridayUsesThursday() {
        LocalDate thursday = LocalDate.of(2026, 10, 8);
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, LocalDate.of(2026, 9, 25),
                    PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
        provisionalNav(thursday);
        answers(thursday);

        PaperReviewJob.Result early = job(kst("2026-10-09T12:00")).run(KR);
        assertThat(early.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(early.weekEnding()).isEqualTo(thursday);

        PaperReviewJob.Result result = job(kst("2026-10-10T22:30")).run(KR);
        assertThat(result.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(result.weekEnding()).isEqualTo(thursday);
        verify(reviews).review(market(KR), eq(thursday), eq(true));
    }

    @Test
    @DisplayName("미국 판정은 그대로 — 미국 Claude 계좌의 금요일 줄이 미확정이고 관측치가 그날 확정 종가가 아니면 기다림(확정 조정 시장만 잠정 줄로 엶)")
    void usStillWaitsForTheFinalClose() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌", 100_000,
                PaperFixtures.FRI, PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE));
        LocalDate usWeek = LocalDate.of(2026, 10, 30);
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, usWeek, 101_000, 0, 101_000, 0, false));
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.empty());
        PaperReviewJob job = job(Instant.parse("2026-10-31T00:00:00Z"));

        assertThat(job.finalCloseIn(UsPaperMarket.INSTANCE, usWeek)).isFalse();
        PaperReviewJob.Result us = job.run();
        assertThat(us.outcome()).isEqualTo(PaperReviewJob.WAITING_FINAL_CLOSE);
        assertThat(us.message()).isEqualTo(usWeek + " 확정 종가가 아직 없습니다 — 장부의 확정 순자산 줄이나, 마감 뒤 수집한 관측치를 "
                + "장부가 반영해 그날 순자산 줄을 남긴 뒤 복기합니다(장중 값으로 금요일 수익률을 만들지 않게)");
        assertThat(UsPaperMarket.INSTANCE.confirmsFills()).isFalse();
        assertThat(KR.confirmsFills()).isTrue();
    }
    @Test
    @DisplayName("POST /api/paper/reviews/run?market=KR(F1b) — 컨트롤러가 한국 수동 복기를 불러 {ok, market:KR, outcome, review}(토요일 시각 조건 없이), 한 건의 retryable은 그 실행 한국 달력의 최근 복기 주로(미국 달력 판이 아님), 모르는 시장 값은 부르기 전에 400")
    void manualKrReviewRoute() {
        provisionalNav(WE);
        answers(WE);
        java.util.Map<String, Object> view = java.util.Map.of("weekEnding", WE.toString());
        when(reviews.reviewView(any(Review.class), eq(WE))).thenReturn(view);
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, LocalDate.of(2026, 10, 29),
                PaperConfig.DEFAULT_KR_INITIAL_CASH);
        PaperReviewController route = new PaperReviewController(reviews, job(kst("2026-11-07T12:00")),
                new PaperMarkets(store, reader), config);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> route.run("kr"))
                .isInstanceOf(com.macrodash.support.InvalidRequestException.class).hasMessageContaining("US · KR");
        verify(reviews, never()).review(any(), any(), anyBoolean());

        java.util.Map<String, Object> out = route.run("KR");

        assertThat(out.keySet()).containsExactly("ok", "market", "outcome", "review");
        assertThat(out).containsEntry("ok", true).containsEntry("market", "KR")
                .containsEntry("outcome", PaperReviewJob.REVIEWED).containsEntry("review", view);
        verify(reviews, times(1)).review(market(KR), eq(WE), eq(false));
        verify(reviews).reviewView(any(Review.class), eq(WE));
        verify(reviews, never()).reviewView(any(Review.class));
        assertThat(store.jobRuns).singleElement().satisfies(run -> assertThat(run.job()).isEqualTo("kr.review"));
    }
}
