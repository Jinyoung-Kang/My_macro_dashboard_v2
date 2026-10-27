package com.macrodash.analytics;

import com.macrodash.analytics.KrReselection.Cycle;
import com.macrodash.analytics.KrReselection.Mode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 규칙 계좌의 재선정일과 따라잡기(2단계 명세 §4-6·K10·K33, §5 '재선정일 게이트 실패 → 다음 KR 결정일에 r′ 자료로 선정').
 * 달력은 천문연 2026·2027 실제 응답 + 연말휴장 규칙({@link KrxFixtures} — KRX 공식 휴장일 목록과 일치함은 {@code KrxCalendarTest}).
 * 기대 날짜는 KRX 휴장일 목록(2026 17일·2027 16일)을 보고 손으로 셌습니다 — 휴장이 끼는 달은 줄마다 이유를 적었습니다.
 */
class KrReselectionTest {

    private static final KrxCalendar CAL = new KrxCalendar(
            Map.of(2026, KrxFixtures.kasiHolidays(2026), 2027, KrxFixtures.kasiHolidays(2027)), List.of());

    private static LocalDate d(String iso) {
        return LocalDate.parse(iso);
    }

    private static List<LocalDate> dates(String... iso) {
        List<LocalDate> out = new ArrayList<>();
        for (String s : iso) {
            out.add(d(s));
        }
        return out;
    }

    // ---- 예정 재선정일 -------------------------------------------------------------------------------------------

    @Test
    @DisplayName("MONTHLY_FIRST = 그 달 첫 KR 거래일 — 신정·삼일절 대체·근로자의날·주말을 건너뜀(2026·2027 열두 달)")
    void monthlyFirstIsFirstTradingDay() {
        assertThat(KrReselection.scheduledBetween(CAL, Mode.MONTHLY_FIRST, d("2026-01-01"), d("2026-12-31")))
                .containsExactlyElementsOf(dates(
                        "2026-01-02",   // 01-01 신정
                        "2026-02-02",   // 02-01 일요일
                        "2026-03-03",   // 03-01 일요일, 03-02 삼일절 대체휴일
                        "2026-04-01",
                        "2026-05-04",   // 05-01 근로자의날(금), 05-02·03 주말
                        "2026-06-01",
                        "2026-07-01",
                        "2026-08-03",   // 08-01 토요일
                        "2026-09-01",
                        "2026-10-01",
                        "2026-11-02",   // 11-01 일요일
                        "2026-12-01"));
        assertThat(KrReselection.scheduledBetween(CAL, Mode.MONTHLY_FIRST, d("2027-01-01"), d("2027-12-31")))
                .containsExactlyElementsOf(dates(
                        "2027-01-04",   // 01-01 신정(금), 01-02·03 주말
                        "2027-02-01",
                        "2027-03-02",   // 03-01 삼일절(월)
                        "2027-04-01",
                        "2027-05-04",   // 05-01·02 주말, 05-03 노동절 대체휴일
                        "2027-06-01",
                        "2027-07-01",
                        "2027-08-02",   // 08-01 일요일
                        "2027-09-01",
                        "2027-10-01",
                        "2027-11-01",
                        "2027-12-01"));
    }

    @Test
    @DisplayName("TWICE_MONTHLY = 첫째·셋째 월요일의 다음 거래일 — 월요일이 거래일이어도 다음 날(2026-11-02 → 11-03), 휴장이 끼면 그 뒤")
    void twiceMonthlyIsTradingDayAfterFirstAndThirdMonday() {
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2026, 11)))
                .containsExactlyElementsOf(dates("2026-11-03", "2026-11-17"));   // 월 11-02·11-16은 거래일 — 그 다음 날
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2026, 10)))
                .containsExactlyElementsOf(dates("2026-10-06", "2026-10-20"));   // 첫째 월 10-05 개천절 대체휴일
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2026, 2)))
                .containsExactlyElementsOf(dates("2026-02-03", "2026-02-19"));   // 셋째 월 02-16~18 설날 → 목요일
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2026, 5)))
                .containsExactlyElementsOf(dates("2026-05-06", "2026-05-19"));   // 첫째 월 05-04는 거래일, 다음 날 05-05 어린이날
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2026, 8)))
                .containsExactlyElementsOf(dates("2026-08-04", "2026-08-18"));   // 셋째 월 08-17 광복절 대체휴일
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2027, 3)))
                .containsExactlyElementsOf(dates("2027-03-02", "2027-03-16"));   // 첫째 월 03-01 삼일절
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2027, 7)))
                .containsExactlyElementsOf(dates("2027-07-06", "2027-07-20"));   // 셋째 월 07-19 제헌절 대체휴일
        assertThat(KrReselection.scheduled(CAL, Mode.TWICE_MONTHLY, YearMonth.of(2027, 12)))
                .containsExactlyElementsOf(dates("2027-12-07", "2027-12-21"));   // 넷째 월 12-27 성탄절 대체휴일은 상관없음
        // 한 해 24날 — 모두 화~목(월요일 다음 거래일이라 월요일이 될 수 없음).
        List<LocalDate> year = KrReselection.scheduledBetween(CAL, Mode.TWICE_MONTHLY, d("2026-01-01"), d("2026-12-31"));
        assertThat(year).hasSize(24).allSatisfy(day -> {
            assertThat(CAL.isTradingDay(day)).isTrue();
            assertThat(day.getDayOfWeek()).isNotEqualTo(java.time.DayOfWeek.MONDAY);
        });
        assertThat(KrReselection.isScheduled(CAL, Mode.TWICE_MONTHLY, d("2026-11-02"))).isFalse();
        assertThat(KrReselection.isScheduled(CAL, Mode.TWICE_MONTHLY, d("2026-11-03"))).isTrue();
        assertThat(KrReselection.isScheduled(CAL, Mode.MONTHLY_FIRST, d("2026-11-02"))).isTrue();
    }

    @Test
    @DisplayName("주기 r(d) = d 이하 가장 늦은 예정일 — 그 달 예정일 전이면 앞 달(연말을 건너 2026-12로)")
    void cycleOf() {
        assertThat(KrReselection.cycleOf(CAL, Mode.MONTHLY_FIRST, d("2026-11-02"))).isEqualTo(d("2026-11-02"));
        assertThat(KrReselection.cycleOf(CAL, Mode.MONTHLY_FIRST, d("2026-11-30"))).isEqualTo(d("2026-11-02"));
        assertThat(KrReselection.cycleOf(CAL, Mode.MONTHLY_FIRST, d("2026-12-30"))).isEqualTo(d("2026-12-01"));
        assertThat(KrReselection.cycleOf(CAL, Mode.MONTHLY_FIRST, d("2027-01-01"))).as("휴장인 날 — 앞 달의 주기")
                .isEqualTo(d("2026-12-01"));
        assertThat(KrReselection.cycleOf(CAL, Mode.MONTHLY_FIRST, d("2027-01-04"))).isEqualTo(d("2027-01-04"));

        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2026-11-02"))).as("첫째 월요일 당일 — 아직 앞 달 셋째")
                .isEqualTo(d("2026-10-20"));
        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2026-11-03"))).isEqualTo(d("2026-11-03"));
        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2026-11-16"))).isEqualTo(d("2026-11-03"));
        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2026-11-17"))).isEqualTo(d("2026-11-17"));
        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2027-01-04"))).as("연초 첫 거래일 — 앞 해 12월 셋째")
                .isEqualTo(d("2026-12-22"));
        assertThat(KrReselection.cycleOf(CAL, Mode.TWICE_MONTHLY, d("2027-01-05"))).isEqualTo(d("2027-01-05"));
    }

    @Test
    @DisplayName("달력이 모르는 해는 짐작하지 않음 — 2026만 아는 달력으로 2027-01 주기를 물으면 달력 없음(K35)")
    void unknownYearFailsClosed() {
        KrxCalendar only2026 = new KrxCalendar(Map.of(2026, KrxFixtures.kasiHolidays(2026)), List.of());

        assertThat(KrReselection.cycleOf(only2026, Mode.MONTHLY_FIRST, d("2026-12-30"))).isEqualTo(d("2026-12-01"));
        assertThatThrownBy(() -> KrReselection.cycleOf(only2026, Mode.MONTHLY_FIRST, d("2027-01-05")))
                .isInstanceOf(CalendarUnavailableException.class);
        assertThatThrownBy(() -> KrReselection.scheduled(only2026, Mode.TWICE_MONTHLY, YearMonth.of(2027, 1)))
                .isInstanceOf(CalendarUnavailableException.class);
    }

    // ---- 따라잡기(K33) -------------------------------------------------------------------------------------------

    @Test
    @DisplayName("K33 따라잡기 — r(11-02) 게이트 실패 → 11-03·11-04에 r′ 자료로 선정(cycleDate 11-02), 11-04 매수 뒤에는 멈춤, 12-01은 새 주기")
    void catchUpSequence() {
        Mode mode = Mode.MONTHLY_FIRST;
        List<LocalDate> buys = new ArrayList<>();

        // 11-02(예정일): 게이트·기한으로 NO_TRADE — 매수 결정 목록에 넣지 않음
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-02"), buys))
                .contains(new Cycle(d("2026-11-02"), d("2026-11-02")));
        // 11-03: 따라잡기 — 입력은 11-03 판, cycleDate는 그대로 r
        Optional<Cycle> nov3 = KrReselection.selectionOn(CAL, mode, d("2026-11-03"), buys);
        assertThat(nov3).contains(new Cycle(d("2026-11-02"), d("2026-11-03")));
        assertThat(nov3.orElseThrow().catchUp()).isTrue();
        // 11-03도 오류(NO_TRADE) — 11-04에 다시
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-04"), buys))
                .contains(new Cycle(d("2026-11-02"), d("2026-11-04")));
        buys.add(d("2026-11-04"));   // 11-04 REBALANCE OK
        // 같은 주기 안에서는 더 하지 않음(그날 자신도 — 이미 낸 결정)
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-04"), buys)).isEmpty();
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-05"), buys)).isEmpty();
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-30"), buys)).isEmpty();
        // 다음 주기는 그 예정일에 — 앞 주기의 매수 결정은 세지 않음
        Optional<Cycle> dec1 = KrReselection.selectionOn(CAL, mode, d("2026-12-01"), buys);
        assertThat(dec1).contains(new Cycle(d("2026-12-01"), d("2026-12-01")));
        assertThat(dec1.orElseThrow().catchUp()).isFalse();
    }

    @Test
    @DisplayName("K33 따라잡기는 다음 주기 전까지만 — 12-01 주기를 끝내 못 사면 12-30까지 매일, 2027-01-04는 새 주기(놓친 주기는 버림)")
    void catchUpStopsAtNextCycleAcrossYearEnd() {
        Mode mode = Mode.MONTHLY_FIRST;
        Set<LocalDate> none = Set.of();

        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-12-24"), none))
                .contains(new Cycle(d("2026-12-01"), d("2026-12-24")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-12-30"), none))
                .contains(new Cycle(d("2026-12-01"), d("2026-12-30")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2027-01-04"), none))
                .contains(new Cycle(d("2027-01-04"), d("2027-01-04")));
        // 연말휴장일 12-31·신정은 결정일이 아님
        assertThatThrownBy(() -> KrReselection.selectionOn(CAL, mode, d("2026-12-31"), none))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrReselection.selectionOn(CAL, mode, d("2027-01-01"), none))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("출발 INITIAL은 그 주기의 매수 결정 — 11-10 출발이면 11-11부터 같은 주기에 다시 선정하지 않고, 주기 전 출발은 r에 선정")
    void initialCountsForItsCycle() {
        Mode mode = Mode.MONTHLY_FIRST;

        Cycle start = KrReselection.initial(CAL, mode, d("2026-11-10"));
        assertThat(start).isEqualTo(new Cycle(d("2026-11-02"), d("2026-11-10")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-11"), List.of(d("2026-11-10")))).isEmpty();

        // 10-28 출발(주기 10-01) → 11-02는 예정대로 재선정
        assertThat(KrReselection.initial(CAL, mode, d("2026-10-28"))).isEqualTo(new Cycle(d("2026-10-01"), d("2026-10-28")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-02"), List.of(d("2026-10-28"))))
                .contains(new Cycle(d("2026-11-02"), d("2026-11-02")));
        // 예정일 당일 출발이면 그 주기 그대로
        assertThat(KrReselection.initial(CAL, mode, d("2026-11-02"))).isEqualTo(new Cycle(d("2026-11-02"), d("2026-11-02")));
        assertThatThrownBy(() -> KrReselection.initial(CAL, mode, d("2026-11-07")))
                .isInstanceOf(IllegalArgumentException.class);   // 토요일
    }

    @Test
    @DisplayName("TWICE_MONTHLY 따라잡기 — 10-06(첫째 월 휴장 다음 날) 실패 → 10-07 r′, 10-08 매수 뒤 10-19까지 없음, 10-20 새 주기")
    void twiceMonthlyCatchUp() {
        Mode mode = Mode.TWICE_MONTHLY;
        List<LocalDate> buys = new ArrayList<>();

        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-10-06"), buys))
                .contains(new Cycle(d("2026-10-06"), d("2026-10-06")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-10-07"), buys))
                .contains(new Cycle(d("2026-10-06"), d("2026-10-07")));
        buys.add(d("2026-10-08"));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-10-12"), buys)).isEmpty();
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-10-19"), buys)).isEmpty();
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-10-20"), buys))
                .contains(new Cycle(d("2026-10-20"), d("2026-10-20")));
    }

    @Test
    @DisplayName("매수 결정 날짜는 r ≤ x ≤ d만 셈 — d 뒤의 결정·null은 보지 않음")
    void onlyDecisionsInsideTheCycleUpToTheSessionCount() {
        Mode mode = Mode.MONTHLY_FIRST;
        List<LocalDate> later = new ArrayList<>();
        later.add(null);
        later.add(d("2026-11-20"));

        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-03"), later))
                .contains(new Cycle(d("2026-11-02"), d("2026-11-03")));
        assertThat(KrReselection.selectionOn(CAL, mode, d("2026-11-03"), null))
                .contains(new Cycle(d("2026-11-02"), d("2026-11-03")));
        assertThatThrownBy(() -> new Cycle(d("2026-11-02"), d("2026-11-01")))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
