package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * 정기 작업의 '달력 없음'(2단계 명세 §4-4·K35, §9 묶음 A 리뷰 메모 'B5 — 달력이 모르는 날'). 시험용 한국 묶음에 2026년 공휴일만 아는
 * {@link KrxCalendar}를 넣고, 앞 창(직전 세션 ~ 10거래일)이 2027년에 걸치는 12-21(월)에 결정·리스크 점검·복기 작업이 그 시장 실행을
 * 멈추고 작업 기록에 {@value CalendarGaps#NO_CALENDAR}를 하루 한 번 남기는지 봅니다. 미국 묶음은 늘 압니다.
 */
class CalendarGapsTest {

    /** 2026년 천문연 공휴일(isHoliday=Y) — 2026-10-26 실제 응답과 같은 22건(백엔드 시험 자료 kasi-holidays-2026-2027.json). */
    private static final List<LocalDate> KASI_2026 = Stream.of("2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18",
            "2026-03-01", "2026-03-02", "2026-05-01", "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-03",
            "2026-06-06", "2026-07-17", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26",
            "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25").map(LocalDate::parse).toList();
    /** 2027년 목록이 없는 한국 달력의 시험용 한국 묶음. */
    private static final PaperMarket KR = TestKrMarket.withCalendar(new KrxCalendar(Map.of(2026, KASI_2026), List.of()));
    private static final String KR_BOOK = TestKrMarket.CLAUDE_BOOK;
    /** 2026-12-21(월) 21:00 KST — 직전 세션 12-21 + 10거래일이 12-31 연말휴장을 지나 2027-01-01(금)에 닿음. */
    private static final Instant DEC_21_EVENING = Instant.parse("2026-12-21T12:00:00Z");
    /** 2026-12-01(화) 21:00 KST — 앞 창이 2026년 안(12-15까지). */
    private static final Instant DEC_01_EVENING = Instant.parse("2026-12-01T12:00:00Z");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private ClaudeBookService claude;
    private ReviewService reviews;
    private MovableClock clock;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        store.books.put(KR_BOOK, TestKrMarket.book(KR_BOOK, 100_000_000, FRI));
        store.states.put(KR_BOOK, new BookState(KR_BOOK, 100_000_000, 100_000_000, 0, 0, null, null, null, null));
        marketData = mock(PaperMarketData.class);
        claude = mock(ClaudeBookService.class);
        reviews = mock(ReviewService.class);
        clock = new MovableClock(DEC_21_EVENING);
    }

    private PaperLedgerService ledger() {
        return new PaperLedgerService(store, marketData, MAPPER);
    }

    private PaperRiskJob riskJob() {
        return new PaperRiskJob(store, PaperFixtures.quietReader(), marketData, ledger(), PaperFixtures.config(), MAPPER,
                clock, List.of(KR));
    }

    private PaperDecisionJob decisionJob() {
        PaperSettingsService settings = PaperFixtures.settings(store);
        return new PaperDecisionJob(store, PaperFixtures.quietReader(), marketData, ledger(),
                mock(PaperSelectionService.class), mock(RuleBookService.class), claude, settings, PaperFixtures.config(),
                MAPPER, clock, List.of(KR));
    }

    private PaperReviewJob reviewJob() {
        return new PaperReviewJob(store, PaperFixtures.quietReader(), marketData, reviews, PaperFixtures.config(), MAPPER,
                clock, List.of(KR));
    }

    @Test
    @DisplayName("앞 창 확인 — 2027년 목록이 없으면 12-21에는 '달력 없음'(빠진 해 2027), 12-01에는 통과, 미국 묶음은 늘 통과")
    void calendarWindow() {
        assertThatThrownBy(() -> KR.requireCalendarWindow(DEC_21_EVENING))
                .isInstanceOfSatisfying(CalendarUnavailableException.class, e -> assertThat(e.year()).isEqualTo(2027));
        assertThatCode(() -> KR.requireCalendarWindow(DEC_01_EVENING)).doesNotThrowAnyException();
        assertThat(PaperMarket.CALENDAR_WINDOW_TRADING_DAYS).isEqualTo(10);
        assertThatCode(() -> UsPaperMarket.INSTANCE.requireCalendarWindow(Instant.parse("2099-12-28T00:00:00Z")))
                .doesNotThrowAnyException();
    }

    @Test
    @DisplayName("리스크 점검 — 관측치를 읽지 않고 '달력 없음'을 작업 기록에, 정기 실행은 그 시장·KST 날짜·빠진 해마다 한 번, 수동 실행은 누를 때마다")
    void riskJobRecordsOncePerDay() {
        PaperRiskJob job = riskJob();
        job.scheduledRun();
        job.scheduledRun();

        assertThat(store.jobRuns).hasSize(1);
        JobRun run = store.jobRuns.get(0);
        assertThat(run.job()).isEqualTo("kr.risk");
        assertThat(run.outcome()).isEqualTo(CalendarGaps.NO_CALENDAR);
        assertNoCalendarDetail(run.detail());
        assertThat(run.detail().path("manual").asBoolean()).isFalse();
        verify(marketData, never()).quotes(any(PaperMarket.class));

        assertThat(job.runNow(KR).skippedReason()).startsWith(CalendarUnavailableException.REASON);
        assertThat(store.jobRuns).hasSize(2);
        assertThat(store.jobRuns.get(1).detail().path("manual").asBoolean()).isTrue();

        clock.set(DEC_21_EVENING.plusSeconds(24 * 3600));   // 다음 날(12-22) — 아직 2027 목록 없음
        job.scheduledRun();
        assertThat(store.jobRuns).as("날이 바뀌면 한 번 더").hasSize(3);
        job.scheduledRun();
        assertThat(store.jobRuns).hasSize(3);
    }

    @Test
    @DisplayName("결정 작업 — NO_CALENDAR(그날 결정·Claude 호출 없음)를 하루 한 번 기록, 수동 결정은 400('달력 없음')")
    void decisionJobRecordsOncePerDay() {
        PaperDecisionJob job = decisionJob();
        PaperDecisionJob.Result first = job.run(KR);
        assertThat(first.outcome()).isEqualTo(PaperDecisionJob.NO_CALENDAR);
        assertThat(first.tradingDate()).isNull();
        assertThat(first.message()).startsWith(CalendarUnavailableException.REASON + " — 2027년");
        assertThat(job.run(KR).outcome()).isEqualTo(PaperDecisionJob.NO_CALENDAR);
        job.scheduledRun();

        assertThat(store.jobRuns).extracting(JobRun::job, JobRun::outcome).as("세 번 돌아도 기록은 한 줄")
                .containsExactly(org.assertj.core.groups.Tuple.tuple("kr.decision", CalendarGaps.NO_CALENDAR));
        assertNoCalendarDetail(store.jobRuns.get(0).detail());
        verifyNoInteractions(claude);
        verify(marketData, never()).quotes(any(PaperMarket.class));

        assertThatThrownBy(() -> job.runNow(KR, KR_BOOK)).isInstanceOf(InvalidRequestException.class)
                .hasMessageStartingWith(CalendarUnavailableException.REASON);
        verifyNoInteractions(claude);
    }

    @Test
    @DisplayName("결정 작업 — 앞 창이 2026년 안이면 '달력 없음' 없이 평소대로(그 시장 달력의 세션)")
    void decisionJobWithinKnownYear() {
        clock.set(DEC_01_EVENING.minusSeconds(3 * 3600));   // 12-01 18:00 KST — 시험용 결정 시각 22:30 전
        PaperDecisionJob.Result result = decisionJob().run(KR);
        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.TOO_EARLY);
        assertThat(result.tradingDate()).isEqualTo(LocalDate.of(2026, 12, 1));
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("복기 작업 — 정기 실행은 NO_CALENDAR를 하루 한 번 기록(복기 호출 없음), 수동 복기는 400('달력 없음')")
    void reviewJobRecordsOncePerDay() {
        PaperReviewJob job = reviewJob();
        assertThat(job.run(KR).outcome()).isEqualTo(PaperReviewJob.NO_CALENDAR);
        job.scheduledRun();

        assertThat(store.jobRuns).extracting(JobRun::job, JobRun::outcome)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("kr.review", CalendarGaps.NO_CALENDAR));
        assertNoCalendarDetail(store.jobRuns.get(0).detail());
        verifyNoInteractions(reviews);

        assertThatThrownBy(() -> job.runNow(KR)).isInstanceOf(InvalidRequestException.class)
                .hasMessageStartingWith(CalendarUnavailableException.REASON);
        assertThat(store.jobRuns).as("수동 복기는 기록하지 않고 400").hasSize(1);
        verifyNoInteractions(reviews);
    }

    private static void assertNoCalendarDetail(JsonNode detail) {
        assertThat(detail.path("reason").asString()).isEqualTo(CalendarUnavailableException.REASON);
        assertThat(detail.path("year").asInt()).isEqualTo(2027);
        assertThat(detail.path("message").asString()).startsWith("달력 없음 — 2027년").contains("kr_holidays");
    }

    /** 시험 중에 움직이는 시계(같은 작업 인스턴스로 날을 바꿔 보려고). */
    private static final class MovableClock extends Clock {

        private Instant now;

        MovableClock(Instant now) {
            this.now = now;
        }

        void set(Instant next) {
            now = next;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
