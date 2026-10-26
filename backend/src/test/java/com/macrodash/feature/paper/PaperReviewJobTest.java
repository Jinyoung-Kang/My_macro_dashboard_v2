package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Review;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
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
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 주간 복기 작업({@link PaperReviewJob})의 부르는 조건 — 토요일 09:00 KST, 금요일 휴장(목요일 기준일), 확정 종가 기다림, 계좌 상태, 이미 있는
 * 행, 놓친 토요일, 수동 실행. 복기 자체({@link ReviewService})는 가짜(mock)로 두고 불렸는지만 봅니다.
 *
 * <p>시각: 2026-10-30(금) 마감 = 20:00Z(EDT) = KST 토 05:00, 그 주 복기 = KST 토 09:00 = 2026-10-31T00:00Z.
 */
class PaperReviewJobTest {

    /** 정기·수동 실행이 미국 시장으로 저장본을 읽고 복기를 부릅니다(2단계 명세 §9 A6 — 시장마다 복기 작업이 돎). */
    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    private static final LocalDate WE = LocalDate.of(2026, 10, 30);
    private static final Instant OPENS = Instant.parse("2026-10-31T00:00:00Z");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private ReviewService reviews;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(US)).thenReturn(Optional.empty());
        reviews = mock(ReviewService.class);
        claudeBook(PaperBooks.ACTIVE, PaperFixtures.FRI);
    }

    private PaperReviewJob job(Instant now) {
        return job(now, PaperFixtures.config());
    }

    private PaperReviewJob job(Instant now, PaperConfig config) {
        return new PaperReviewJob(store, reader, marketData, reviews, config, MAPPER, Clock.fixed(now, ZoneOffset.UTC));
    }

    private void claudeBook(String status, LocalDate startedOn) {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌", 100_000,
                startedOn, status, PaperFixtures.FRI_CLOSE));
    }

    private void finalNav(LocalDate day, boolean pricesFinal) {
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, day, 101_000, 0, 101_000, 0, pricesFinal));
    }

    private static Review row(LocalDate week, String status, int retryCount) {
        return new Review(week, 4, MAPPER.createObjectNode(), null, null, null, null, null, status,
                Review.API_ERROR.equals(status) ? "[HTTP] 500" : null, null, 0, retryCount, null);
    }

    private void answers(LocalDate week) {
        when(reviews.review(US, week)).thenReturn(new ReviewService.Outcome(ReviewService.Kind.CALLED,
                row(week, Review.OK, 0), null));
    }

    @Test
    @DisplayName("토요일 09:00 KST 전에는 부르지 않고(TOO_EARLY), 09:00부터 그 주 복기를 한 번 부르며 작업 기록을 남긴다")
    void saturdayNineKst() {
        finalNav(WE, true);
        answers(WE);

        assertThat(job(OPENS.minusSeconds(60)).run().outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(job(Instant.parse("2026-10-30T21:00:00Z")).run().outcome()).as("금요일 마감 뒤(KST 토 06:00)도 아직")
                .isEqualTo(PaperReviewJob.TOO_EARLY);
        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());

        PaperReviewJob.Result result = job(OPENS).run();

        assertThat(result.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(result.weekEnding()).isEqualTo(WE);
        verify(reviews, times(1)).review(US, WE);
        assertThat(store.jobRuns).hasSize(1);
        assertThat(store.jobRuns.get(0).job()).isEqualTo("review");
        assertThat(store.jobRuns.get(0).outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(store.jobRuns.get(0).detail().path("weekEnding").asString()).isEqualTo("2026-10-30");
    }

    @Test
    @DisplayName("금요일이 휴장이면 목요일이 기준일 — 성금요일 2027-03-26 주는 03-25, 복기는 그래도 토요일 09:00 KST")
    void holidayFridayUsesThursday() {
        LocalDate thursday = LocalDate.of(2027, 3, 25);
        finalNav(thursday, true);
        answers(thursday);

        PaperReviewJob.Result early = job(Instant.parse("2027-03-26T12:00:00Z")).run();
        assertThat(early.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(early.weekEnding()).isEqualTo(thursday);

        PaperReviewJob.Result result = job(Instant.parse("2027-03-27T00:00:00Z")).run();
        assertThat(result.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(result.weekEnding()).isEqualTo(thursday);
        verify(reviews).review(US, thursday);
    }

    @Test
    @DisplayName("기준일 확정 종가가 없으면 기다림(WAITING_FINAL_CLOSE) — 미확정 순자산 줄도 아님, 마감 뒤 수집한 관측치나 확정 줄이 오면 부름")
    void waitsForFinalClose() {
        answers(WE);
        finalNav(WE, false);

        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.WAITING_FINAL_CLOSE);
        // 마감 10분 뒤 수집한 관측치 — 아직 확정 종가가 아님.
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(Instant.parse("2026-10-30T20:10:00Z"),
                bar("AAA", LocalDate.of(2026, 10, 29), 99, WE, 100))));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.WAITING_FINAL_CLOSE);
        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());

        // 마감 20분 뒤 수집한 관측치 — 확정 종가.
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(Instant.parse("2026-10-30T20:20:00Z"),
                bar("AAA", LocalDate.of(2026, 10, 29), 99, WE, 100))));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        verify(reviews).review(US, WE);
    }

    @Test
    @DisplayName("확정 관측치가 들어왔어도 장부가 아직 반영하지 않았으면(그날 순자산 줄 없음) 기다림 — 줄이 생기면(확정이 아니어도) 부름(D-COST-3)")
    void finalQuotesWaitUntilLedgerWroteTheRow() {
        answers(WE);
        // 토 10:00 KST에 켜진 맥 — 수집기가 확정 관측치를 막 저장했고, 리스크 작업은 아직 그것을 처리하지 않음.
        Instant now = Instant.parse("2026-10-31T01:03:00Z");
        when(marketData.quotes(US)).thenReturn(Optional.of(quotes(Instant.parse("2026-10-31T01:02:30Z"),
                bar("AAA", LocalDate.of(2026, 10, 29), 99, WE, 100))));

        PaperReviewJob.Result waiting = job(now).run();

        assertThat(waiting.outcome()).isEqualTo(PaperReviewJob.WAITING_FINAL_CLOSE);
        assertThat(waiting.message()).contains("장부가 반영");
        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());

        // 장부가 반영 — 보유 하나가 이어 쓴 봉이면 그날 줄은 확정이 아닌 채로 남습니다.
        finalNav(WE, false);
        assertThat(job(now).run().outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        verify(reviews).review(US, WE);
    }

    @Test
    @DisplayName("Claude 계좌가 운용 중이 아니면 아무것도 하지 않음 — 일시정지·시작 전·없음·출발한 주(초기 결정뿐)")
    void inactiveAccountDoesNothing() {
        finalNav(WE, true);
        claudeBook(PaperBooks.PAUSED, PaperFixtures.FRI);
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.NOT_ACTIVE);
        claudeBook(PaperBooks.NOT_STARTED, null);
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.NOT_ACTIVE);
        claudeBook(PaperBooks.ACTIVE, WE);
        PaperReviewJob.Result startWeek = job(OPENS).run();
        assertThat(startWeek.outcome()).isEqualTo(PaperReviewJob.NOT_ACTIVE);
        assertThat(startWeek.message()).contains("출발한 주");
        store.books.remove(PaperBooks.CLAUDE);
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.NOT_ACTIVE);

        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());
        assertThat(store.jobRuns).as("기록 안 함").isEmpty();
    }

    @Test
    @DisplayName("그 주의 행이 이미 있으면 부르지 않음 — 다시 부를 API 오류(재시도 0)만 부름")
    void existingRowStopsUnlessRetryable() {
        finalNav(WE, true);
        answers(WE);
        store.reviews.put(WE, row(WE, Review.OK, 0));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.ALREADY_REVIEWED);
        store.reviews.put(WE, row(WE, Review.API_ERROR, 1));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.ALREADY_REVIEWED);
        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());

        store.reviews.put(WE, row(WE, Review.API_ERROR, 0));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        verify(reviews).review(US, WE);
    }

    @Test
    @DisplayName("놓친 토요일(맥이 꺼짐)은 다음 금요일 마감 전까지 그 주로 다시 잡고, 다음 주 마감 뒤에는 새 주를 기다림")
    void missedSaturdayRunsUntilNextFridayClose() {
        finalNav(WE, true);
        answers(WE);

        PaperReviewJob.Result wednesday = job(Instant.parse("2026-11-04T03:00:00Z")).run();
        assertThat(wednesday.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(wednesday.weekEnding()).isEqualTo(WE);

        PaperReviewJob.Result nextWeek = job(Instant.parse("2026-11-06T21:30:00Z")).run();   // 11-06(금) 마감 뒤(EST)
        assertThat(nextWeek.weekEnding()).isEqualTo(LocalDate.of(2026, 11, 6));
        assertThat(nextWeek.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        verify(reviews, times(1)).review(any(), any());
    }

    @Test
    @DisplayName("창 안에 결정이 없어 건너뜀(SKIPPED)도 작업 기록, 하루 상한(CAP_REACHED)은 기록 없이 다음 주기에")
    void skippedAndCapOutcomes() {
        finalNav(WE, true);
        when(reviews.review(US, WE)).thenReturn(new ReviewService.Outcome(ReviewService.Kind.CAP_REACHED, null, "상한"));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.CAP_REACHED);
        assertThat(store.jobRuns).isEmpty();

        when(reviews.review(US, WE)).thenReturn(new ReviewService.Outcome(ReviewService.Kind.SKIPPED,
                row(WE, Review.SKIPPED, 0), ReviewService.NO_DECISIONS));
        assertThat(job(OPENS).run().outcome()).isEqualTo(PaperReviewJob.SKIPPED);
        assertThat(store.jobRuns).extracting(r -> r.outcome()).containsExactly(PaperReviewJob.SKIPPED);
    }

    @Test
    @DisplayName("같은 주에 오류가 3번 나면 정기 실행은 그 주를 포기(GAVE_UP), 수동 실행은 다시 시도")
    void givesUpAfterThreeErrorsButManualRetries() {
        finalNav(WE, true);
        when(reviews.review(US, WE)).thenThrow(new IllegalStateException("자료 오류"));
        PaperReviewJob job = job(OPENS);
        for (int i = 0; i < 3; i++) {
            assertThat(job.run().outcome()).isEqualTo(PaperReviewJob.ERROR);
        }
        assertThat(job.run().outcome()).isEqualTo(PaperReviewJob.GAVE_UP);
        assertThat(store.jobRuns).extracting(r -> r.outcome()).containsOnly(PaperReviewJob.ERROR).hasSize(3);

        assertThatThrownBy(job::runNow).isInstanceOf(IllegalStateException.class).hasMessageContaining("자료 오류");
        verify(reviews, times(4)).review(US, WE);
    }

    @Test
    @DisplayName("수동 실행은 토요일 시각 조건만 뺌 — 금요일 마감 뒤 확정 종가면 부르고, 계좌·종가 조건은 400")
    void manualRunSkipsOnlyTheSaturdayTime() {
        answers(WE);
        Instant saturdayEarly = Instant.parse("2026-10-30T22:00:00Z");   // KST 토 07:00
        assertThatThrownBy(() -> job(saturdayEarly).runNow()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("확정 종가");
        finalNav(WE, true);

        Map<String, Object> out = job(saturdayEarly).runNow();

        assertThat(out).containsEntry("ok", true).containsEntry("outcome", PaperReviewJob.REVIEWED);
        verify(reviews).review(US, WE);
        assertThat(store.jobRuns.get(0).detail().path("manual").asBoolean()).isTrue();

        claudeBook(PaperBooks.PAUSED, PaperFixtures.FRI);
        assertThatThrownBy(() -> job(saturdayEarly).runNow()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("일시정지");
        store.ready = false;
        assertThat(job(saturdayEarly).runNow()).containsEntry("available", false).containsEntry("ok", false);
    }

    @Test
    @DisplayName("dashboard.paper.enabled=false면 정기 실행은 아무것도 하지 않음")
    void disabledDoesNothing() {
        finalNav(WE, true);
        answers(WE);
        job(OPENS, new PaperConfig(false, PaperFixtures.FRI, 100_000)).scheduledRun();
        verify(reviews, never()).review(any());
        verify(reviews, never()).review(any(), any());
        job(OPENS).scheduledRun();
        verify(reviews).review(US, WE);
    }

    // ------------------------------------------------------------------ 시장 격리(2단계 명세 §9 A6)
    @Test
    @DisplayName("시장 격리(A6): 다른 시장의 복기 작업은 그 시장 달력의 복기 주·여는 시각(시장별 요일·시각) 전이면 TOO_EARLY, 그 뒤엔 복기 행 기본키가 주 하나인 동안(B1 전) 그 주의 행을 읽기 전에 오류로 남김(기록 이름 kr.review, 그 시장 오류 횟수) — 미국 복기는 그대로")
    void otherMarketReviewWaitsForMarketKey() {
        PaperMarket kr = TestKrMarket.INSTANCE;
        finalNav(WE, true);
        store.reviews.put(WE, row(WE, Review.OK, 0));   // 같은 주의 미국 행
        // OPENS = 토 09:00 KST — 미국은 열렸고, 시험용 한국 시장(토 22:30 KST)은 아직
        PaperReviewJob early = new PaperReviewJob(store, reader, marketData, reviews, PaperFixtures.config(), MAPPER,
                Clock.fixed(OPENS, ZoneOffset.UTC), List.of(US, kr));
        PaperReviewJob.Result tooEarly = early.run(kr);
        assertThat(tooEarly.outcome()).isEqualTo(PaperReviewJob.TOO_EARLY);
        assertThat(tooEarly.weekEnding()).as("시험용 한국 달력의 주 마지막 거래일").isEqualTo(WE);
        assertThat(tooEarly.message()).contains("22:30");
        assertThat(kr.reviewOpening(WE)).isEqualTo(Instant.parse("2026-10-31T13:30:00Z"));

        Instant krOpen = Instant.parse("2026-10-31T14:00:00Z");   // 토 23:00 KST
        PaperReviewJob job = new PaperReviewJob(store, reader, marketData, reviews, PaperFixtures.config(), MAPPER,
                Clock.fixed(krOpen, ZoneOffset.UTC), List.of(US, kr));
        job.scheduledRun();

        assertThat(store.jobRuns).extracting(PaperStore.JobRun::job).as("미국은 이미 복기함(기록 없음), 한국은 오류")
                .containsExactly("kr.review");
        assertThat(store.jobRuns.get(0).outcome()).isEqualTo(PaperReviewJob.ERROR);
        assertThat(store.jobRuns.get(0).detail().path("weekEnding").asString()).isEqualTo("2026-10-30");
        assertThat(store.jobRuns.get(0).detail().path("error").asString()).contains("B1");
        assertThat(job.run(kr).outcome()).isEqualTo(PaperReviewJob.ERROR);
        assertThat(store.jobRuns.get(1).detail().path("attempt").asInt()).as("그 시장·그 주의 오류 횟수").isEqualTo(2);
        assertThat(job.run().outcome()).as("미국은 그 시장 오류와 상관없음").isEqualTo(PaperReviewJob.ALREADY_REVIEWED);
        verify(reviews, never()).review(any(), any());
        assertThat(store.reviews).containsOnlyKeys(WE);
    }
}
