package com.macrodash.analytics;

import com.macrodash.analytics.PaperStats.Stats;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * 성과 통계. 기대값은 손으로 닫힌 식을 세운 값입니다 — 예: 매일 +10%·−10%를 번갈아 20일이면 누적 = 0.99^10 − 1.
 */
class PaperStatsTest {

    private static final double TOL = 1e-9;

    /** 2026-10-23부터 연속 거래일 n개. */
    private static List<LocalDate> tradingDates(int n) {
        List<LocalDate> out = new ArrayList<>();
        LocalDate day = LocalDate.of(2026, 10, 23);
        for (int i = 0; i < n; i++) {
            out.add(day);
            day = UsMarketCalendar.nextTradingDay(day);
        }
        return out;
    }

    /** start에서 시작해 홀수 날 +up, 짝수 날 −down을 번갈아(1일째 +). */
    private static List<Double> alternating(int points, double start, double up, double down) {
        List<Double> out = new ArrayList<>();
        double value = start;
        out.add(value);
        for (int i = 1; i < points; i++) {
            value *= i % 2 == 1 ? 1.0 + up : 1.0 - down;
            out.add(value);
        }
        return out;
    }

    @Test
    @DisplayName("표본 20 미만이면 누적만 — 나머지는 0이 아니라 null")
    void shortSampleOnlyCumulative() {
        Stats s = PaperStats.compute(tradingDates(5), List.of(100.0, 101.0, 102.0, 101.0, 103.0), null);

        assertThat(s.cumReturnPct()).isCloseTo(3.0, within(TOL));
        assertThat(s.sampleDays()).isEqualTo(4);
        assertThat(s.cagrPct()).isNull();
        assertThat(s.volPct()).isNull();
        assertThat(s.mddPct()).isNull();
        assertThat(s.sharpe()).isNull();
        assertThat(s.excessPct()).isNull();
        assertThat(s.beta()).isNull();
    }

    @Test
    @DisplayName("경계: 거래일 19일은 누적만, 20일부터 전부")
    void sampleBoundary() {
        Stats nineteen = PaperStats.compute(tradingDates(20), alternating(20, 100, 0.1, 0.1), null);
        Stats twenty = PaperStats.compute(tradingDates(21), alternating(21, 100, 0.1, 0.1), null);

        assertThat(nineteen.sampleDays()).isEqualTo(19);
        assertThat(nineteen.volPct()).isNull();
        assertThat(twenty.sampleDays()).isEqualTo(20);
        assertThat(twenty.volPct()).isNotNull();
    }

    @Test
    @DisplayName("점이 없거나 하나면 누적도 null(관측된 수익률이 없음), 표본 0")
    void emptyOrSinglePoint() {
        Stats empty = PaperStats.compute(List.of(), List.of(), List.of());
        Stats single = PaperStats.compute(tradingDates(1), List.of(100_000.0), null);

        assertThat(empty.cumReturnPct()).isNull();
        assertThat(empty.sampleDays()).isZero();
        assertThat(single.cumReturnPct()).isNull();
        assertThat(single.sampleDays()).isZero();
    }

    @Test
    @DisplayName("+10%·−10% 번갈아 20일: 누적·CAGR·변동성·MDD·샤프를 닫힌 식과 대조")
    void alternatingTenPercent() {
        Stats s = PaperStats.compute(tradingDates(21), alternating(21, 100, 0.1, 0.1), null);

        // 누적 = (1.1 × 0.9)^10 − 1 = 0.99^10 − 1 ≈ −9.5618%
        assertThat(s.cumReturnPct()).isCloseTo((Math.pow(0.99, 10) - 1) * 100, within(TOL));
        // CAGR = (0.99^10)^(252/20) − 1 = 0.99^126 − 1 ≈ −71.8%
        assertThat(s.cagrPct()).isCloseTo((Math.pow(0.99, 126) - 1) * 100, within(TOL));
        // 평균 0, Σ(±0.1)² = 0.2, 표본 표준편차 = √(0.2/19) = 0.1 × √(20/19) → × √252 × 100 ≈ 162.87%
        assertThat(s.volPct()).isCloseTo(0.1 * Math.sqrt(20.0 / 19.0) * Math.sqrt(252) * 100, within(1e-6));
        // 평균 수익률 0 → 샤프 0
        assertThat(s.sharpe()).isCloseTo(0.0, within(1e-9));
        // 고점은 1일째 110, 마지막 날 100 × 0.99^10이 가장 깊음 → 0.99^10 / 1.1 − 1 ≈ −17.78%
        assertThat(s.mddPct()).isCloseTo((Math.pow(0.99, 10) / 1.1 - 1) * 100, within(TOL));
        assertThat(s.excessPct()).isNull();
        assertThat(s.beta()).isNull();
        assertThat(s.sampleDays()).isEqualTo(20);
    }

    @Test
    @DisplayName("MDD: 100 → 120 → 90(−25%) → 130 → 104(−20%) → 이후 보합 → −25%")
    void maxDrawdown() {
        List<Double> nav = new ArrayList<>(List.of(100.0, 120.0, 90.0, 130.0, 104.0));
        while (nav.size() < 21) {
            nav.add(104.0);
        }

        Stats s = PaperStats.compute(tradingDates(21), nav, null);

        assertThat(s.mddPct()).isCloseTo(-25.0, within(TOL));
        assertThat(s.cumReturnPct()).isCloseTo(4.0, within(TOL));
        assertThat(s.cagrPct()).isCloseTo((Math.pow(1.04, 252.0 / 20) - 1) * 100, within(TOL));
    }

    @Test
    @DisplayName("매일 같은 수익률이면 변동성 0, 샤프는 null(0으로 나누지 않음), MDD 0")
    void constantGrowth() {
        List<Double> nav = new ArrayList<>();
        double value = 100.0;
        for (int i = 0; i < 21; i++) {
            nav.add(value);
            value *= 1.01;
        }

        Stats s = PaperStats.compute(tradingDates(21), nav, null);

        assertThat(s.cumReturnPct()).isCloseTo((Math.pow(1.01, 20) - 1) * 100, within(TOL));   // ≈ 22.019%
        assertThat(s.volPct()).isEqualTo(0.0);
        assertThat(s.sharpe()).isNull();
        assertThat(s.mddPct()).isEqualTo(0.0);
    }

    @Test
    @DisplayName("벤치마크: 책 수익률이 매일 정확히 2배면 베타 2, 초과 = 누적 − 벤치마크 누적")
    void betaAndExcess() {
        List<Double> book = alternating(21, 100, 0.10, 0.10);
        List<Double> bench = alternating(21, 100, 0.05, 0.05);

        Stats s = PaperStats.compute(tradingDates(21), book, bench);

        assertThat(s.beta()).isCloseTo(2.0, within(1e-9));
        // (0.99^10 − 1) − ((1.05 × 0.95)^10 − 1) = 0.99^10 − 0.9975^10 ≈ −7.09%p
        assertThat(s.excessPct()).isCloseTo((Math.pow(0.99, 10) - Math.pow(0.9975, 10)) * 100, within(TOL));
    }

    @Test
    @DisplayName("벤치마크가 빈 날은 그날이 낀 수익률 쌍만 빠진다 — 쌍이 20개 이상 남으면 베타 그대로")
    void benchmarkGapDropsPairs() {
        List<Double> book = alternating(24, 100, 0.10, 0.10);
        List<Double> bench = new ArrayList<>(alternating(24, 100, 0.05, 0.05));
        bench.set(10, null);   // 9→10, 10→11 두 쌍이 빠져 23 − 2 = 21쌍

        Stats s = PaperStats.compute(tradingDates(24), book, bench);

        assertThat(s.beta()).isCloseTo(2.0, within(1e-9));
        // 끝점(0일·23일)은 둘 다 있으므로 초과는 전체 구간: 23일째 책 110 × 0.99^11, 벤치마크 105 × 0.9975^11
        assertThat(s.excessPct()).isCloseTo(
                (1.1 * Math.pow(0.99, 11) - 1.05 * Math.pow(0.9975, 11)) * 100, within(TOL));
    }

    @Test
    @DisplayName("첫날 벤치마크가 없으면 초과는 둘 다 있는 첫날부터, 쌍이 20개 미만이면 베타 null")
    void benchmarkMissingFirstDay() {
        List<Double> book = alternating(21, 100, 0.10, 0.10);
        List<Double> bench = new ArrayList<>(alternating(21, 100, 0.05, 0.05));
        bench.set(0, null);   // 0→1 쌍이 빠져 19쌍

        Stats s = PaperStats.compute(tradingDates(21), book, bench);

        assertThat(s.beta()).isNull();
        // 1일째(책 110, 벤치마크 105) → 20일째(100 × 0.99^10, 100 × 0.9975^10)
        assertThat(s.excessPct()).isCloseTo(
                (Math.pow(0.99, 10) / 1.1 - Math.pow(0.9975, 10) / 1.05) * 100, within(TOL));
        // 책 자신의 통계는 벤치마크와 상관없이 전체 구간
        assertThat(s.cumReturnPct()).isCloseTo((Math.pow(0.99, 10) - 1) * 100, within(TOL));
    }

    @Test
    @DisplayName("벤치마크 값이 하나뿐이면 초과 null, 벤치마크가 움직이지 않으면 베타 null")
    void degenerateBenchmark() {
        List<Double> book = alternating(21, 100, 0.10, 0.10);
        List<Double> onlyOne = new ArrayList<>(Arrays.asList(new Double[21]));
        onlyOne.set(5, 100.0);
        List<Double> flat = new ArrayList<>();
        for (int i = 0; i < 21; i++) {
            flat.add(100.0);
        }

        assertThat(PaperStats.compute(tradingDates(21), book, onlyOne).excessPct()).isNull();
        assertThat(PaperStats.compute(tradingDates(21), book, onlyOne).beta()).isNull();
        assertThat(PaperStats.compute(tradingDates(21), book, flat).beta()).isNull();
    }

    @Test
    @DisplayName("기록이 빠진 날이 있으면 표본·CAGR은 거래일로 센다 — 거래일 60일에 기록 42개, +5%면 CAGR은 252/60 지수")
    void missingDaysCountTradingDays() {
        List<LocalDate> all = tradingDates(61);   // 첫 기록부터 거래일 60일
        List<LocalDate> dates = new ArrayList<>();
        for (int i = 0; i < all.size(); i++) {
            if (i == 0 || i == 60 || i % 3 != 0) {   // 맥 절전 등으로 19개가 빠짐
                dates.add(all.get(i));
            }
        }
        List<Double> nav = new ArrayList<>();
        for (int i = 0; i < dates.size(); i++) {
            nav.add(i == dates.size() - 1 ? 105.0 : 100.0 + i * 0.01);
        }
        assertThat(dates).hasSize(42);

        Stats s = PaperStats.compute(dates, nav, null);

        assertThat(s.sampleDays()).as("기록 수 − 1(41)이 아니라 거래일 60").isEqualTo(60);
        assertThat(s.cumReturnPct()).isCloseTo(5.0, within(TOL));
        // 기록 수로 셌다면 1.05^(252/41) − 1 ≈ 35%로 부풉니다.
        assertThat(s.cagrPct()).isCloseTo((Math.pow(1.05, 252.0 / 60) - 1) * 100, within(TOL));
    }

    @Test
    @DisplayName("변동성·샤프·베타는 하루 간격 쌍만 — 리셋 뒤처럼 몇 달 빈 첫 구간의 수익률은 빠진다")
    void gapReturnsAreExcludedFromVolatility() {
        // 출발일 줄 하나 → 30거래일 비고 → 그 뒤 연속 23개(하루 간격 쌍 22개). 빈 구간의 +20%를 하루치로 세면 변동성이 부풂.
        List<LocalDate> all = tradingDates(53);
        List<LocalDate> dates = new ArrayList<>();
        dates.add(all.get(0));
        dates.addAll(all.subList(30, 53));
        List<Double> nav = new ArrayList<>();
        nav.add(100.0);
        nav.addAll(alternating(23, 120, 0.01, 0.01));
        List<Double> bench = new ArrayList<>();
        bench.add(100.0);
        bench.addAll(alternating(23, 90, 0.005, 0.005));

        Stats s = PaperStats.compute(dates, nav, bench);

        assertThat(s.sampleDays()).isEqualTo(52);
        // 쌍 22개: +1%·−1%가 11번씩 → 평균 0, Σ(±0.01)² = 22 × 1e-4, 표본 표준편차 = 0.01 × √(22/21)
        assertThat(s.volPct()).isCloseTo(0.01 * Math.sqrt(22.0 / 21.0) * Math.sqrt(252) * 100, within(1e-6));
        assertThat(s.sharpe()).isCloseTo(0.0, within(1e-9));
        assertThat(s.beta()).as("빈 구간 쌍(+20% 대 −10%)이 들어가면 2가 아님").isCloseTo(2.0, within(1e-9));
        assertThat(s.cagrPct()).isNotNull();
        assertThat(s.mddPct()).isNotNull();
    }

    @Test
    @DisplayName("구간은 20거래일을 넘어도 하루 간격 쌍이 20개 미만이면 변동성·샤프·베타는 null, CAGR·MDD는 낸다")
    void tooFewDailyPairs() {
        List<LocalDate> all = tradingDates(31);
        List<LocalDate> dates = List.of(all.get(0), all.get(10), all.get(20), all.get(29), all.get(30));
        List<Double> nav = List.of(100.0, 102.0, 99.0, 103.0, 104.0);

        Stats s = PaperStats.compute(dates, nav, nav);

        assertThat(s.sampleDays()).isEqualTo(30);
        assertThat(s.cagrPct()).isCloseTo((Math.pow(1.04, 252.0 / 30) - 1) * 100, within(TOL));
        assertThat(s.mddPct()).isCloseTo((99.0 / 102.0 - 1) * 100, within(TOL));
        assertThat(s.volPct()).isNull();
        assertThat(s.sharpe()).isNull();
        assertThat(s.beta()).isNull();
        assertThat(s.excessPct()).isCloseTo(0.0, within(TOL));
    }

    @Test
    @DisplayName("입력이 어긋나면 거절: 길이, null·0 이하 순자산, 날짜 순서")
    void rejectsMalformedInput() {
        List<LocalDate> dates = tradingDates(3);
        assertThatThrownBy(() -> PaperStats.compute(dates, List.of(100.0, 101.0), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PaperStats.compute(dates, List.of(100.0, 101.0, 102.0), List.of(100.0)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PaperStats.compute(dates, Arrays.asList(100.0, null, 102.0), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PaperStats.compute(dates, List.of(100.0, 0.0, 102.0), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PaperStats.compute(
                List.of(dates.get(1), dates.get(0), dates.get(2)), List.of(100.0, 101.0, 102.0), null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> PaperStats.compute(
                List.of(dates.get(0), dates.get(0), dates.get(2)), List.of(100.0, 101.0, 102.0), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("달력을 받는 판 — 미국 달력이면 옛 시그니처와 같고, 다른 달력이면 표본·하루 간격 쌍을 그 달력으로 센다")
    void computeWithCalendar() {
        // 10-23부터 미국 거래일 25개 = 11-27까지(11-26 추수감사절을 건너뜀)
        List<LocalDate> dates = tradingDates(25);
        assertThat(dates.get(24)).isEqualTo(LocalDate.of(2026, 11, 27));
        List<Double> nav = alternating(25, 100, 0.01, 0.005);
        List<Double> bench = alternating(25, 100, 0.008, 0.004);
        Stats us = PaperStats.compute(dates, nav, bench);
        assertThat(PaperStats.compute(UsMarketCalendar.CALENDAR, dates, nav, bench)).isEqualTo(us);
        assertThat(us.sampleDays()).isEqualTo(24);
        assertThat(us.volPct()).isNotNull();

        // 휴장일 없는 시험 달력에서는 11-26도 거래일 — 표본 25, 11-25→11-27 쌍은 하루 간격이 아님
        Stats weekdays = PaperStats.compute(WeekdaysCalendar.INSTANCE, dates, nav, bench);
        assertThat(weekdays.sampleDays()).isEqualTo(25);
        assertThat(weekdays.cumReturnPct()).isEqualTo(us.cumReturnPct());
        assertThat(weekdays.cagrPct()).isNotEqualTo(us.cagrPct());
        assertThat(weekdays.volPct()).isNotNull().isNotEqualTo(us.volPct());
        assertThatThrownBy(() -> PaperStats.compute(null, dates, nav, bench))
                .isInstanceOf(NullPointerException.class);
    }
}
