package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 거래일 달력(2단계 명세 §4-4·K16·K35, §5 '한국 거래일 달력'). KRX 공식 휴장일 목록(실제 응답 — {@link KrxFixtures})과 견주고,
 * 연말휴장일 대체·5-1·임시휴장·모르는 해(fail-closed)를 봅니다.
 */
class KrxCalendarTest {

    /** 2025년 천문연 공휴일 — 화면 내장 표({@code marketCalendar.ts} KR_PUBLIC_HOLIDAYS, 천문연 실제 응답에서 뽑은 값). 5-1이 없는 해. */
    private static final List<LocalDate> KASI_2025 = dates("2025-01-01", "2025-01-27", "2025-01-28", "2025-01-29",
            "2025-01-30", "2025-03-01", "2025-03-03", "2025-05-05", "2025-05-06", "2025-06-03", "2025-06-06",
            "2025-08-15", "2025-10-03", "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09",
            "2025-12-25");
    /** 2028년 천문연 공휴일 — 같은 화면 내장 표. 12-31이 일요일인 해. */
    private static final List<LocalDate> KASI_2028 = dates("2028-01-01", "2028-01-26", "2028-01-27", "2028-01-28",
            "2028-03-01", "2028-04-12", "2028-05-01", "2028-05-02", "2028-05-05", "2028-06-06", "2028-07-17",
            "2028-08-15", "2028-10-02", "2028-10-03", "2028-10-04", "2028-10-05", "2028-10-09", "2028-12-25");

    private static KrxCalendar calendar(Map<Integer, List<LocalDate>> holidays, LocalDate... extra) {
        return new KrxCalendar(holidays, List.of(extra));
    }

    private static KrxCalendar kasi2026And2027() {
        return calendar(Map.of(2026, KrxFixtures.kasiHolidays(2026), 2027, KrxFixtures.kasiHolidays(2027)));
    }

    @Test
    @DisplayName("천문연 2026·2027 + 연말휴장일 규칙 = KRX 공식 휴장일 목록(2026 17일·2027 16일, 차집합 없음)")
    void matchesKrxOfficialList() {
        KrxCalendar cal = kasi2026And2027();
        for (int year : new int[]{2026, 2027}) {
            Set<LocalDate> krx = KrxFixtures.krxClosures(year).keySet();
            assertThat(KrxFixtures.weekdayClosures(cal, year)).as(year + "년 평일 휴장일").containsExactlyElementsOf(krx);
        }
        assertThat(KrxFixtures.krxClosures(2026)).hasSize(17);
        assertThat(KrxFixtures.krxClosures(2027)).hasSize(16);
        assertThat(cal.yearEndClosure(2026)).isEqualTo(LocalDate.of(2026, 12, 31));
        assertThat(cal.yearEndClosure(2027)).isEqualTo(LocalDate.of(2027, 12, 31));
    }

    @Test
    @DisplayName("KRX 실례 2022·2023 — 12-31이 토·일이면 직전 금요일(2022-12-30·2023-12-29), 2026년 전 5-1(2023-05-01 월)도 휴장")
    void yearEndSubstitutionOnKrxRecords() {
        // 2022·2023은 천문연 응답을 받지 않았습니다 — KRX 목록에서 KRX 고유 휴장일(연말휴장일·근로자의날)을 빼 공휴일 입력으로 쓰고,
        // 달력이 그 둘을 규칙으로 되살려 목록 전체와 같아지는지 봅니다(공휴일 부분은 입력 그대로라 이 시험의 대상이 아님).
        for (int year : new int[]{2022, 2023}) {
            Map<LocalDate, String> krx = KrxFixtures.krxClosures(year);
            List<LocalDate> publicHolidays = krx.entrySet().stream()
                    .filter(e -> !e.getValue().equals("연말휴장일") && !e.getValue().equals("근로자의날"))
                    .map(Map.Entry::getKey).toList();
            KrxCalendar cal = calendar(Map.of(year, publicHolidays));
            assertThat(KrxFixtures.weekdayClosures(cal, year)).as(year + "년 평일 휴장일")
                    .containsExactlyElementsOf(krx.keySet());
        }
        assertThat(KrxFixtures.krxClosures(2022)).containsEntry(LocalDate.of(2022, 12, 30), "연말휴장일")
                .doesNotContainKey(LocalDate.of(2022, 5, 1));   // 2022-05-01은 일요일 — 대체하지 않음
        assertThat(KrxFixtures.krxClosures(2023)).containsEntry(LocalDate.of(2023, 12, 29), "연말휴장일")
                .containsEntry(LocalDate.of(2023, 5, 1), "근로자의날");
    }

    @Test
    @DisplayName("연말휴장일 대체 세 번째 — 2028-12-31(일) → 2028-12-29(금) 휴장, 12-28(목) 개장")
    void yearEnd2028() {
        KrxCalendar cal = calendar(Map.of(2028, KASI_2028));
        assertThat(cal.yearEndClosure(2028)).isEqualTo(LocalDate.of(2028, 12, 29));
        assertThat(cal.isTradingDay(LocalDate.of(2028, 12, 29))).isFalse();
        assertThat(cal.isHoliday(LocalDate.of(2028, 12, 29))).isTrue();
        assertThat(cal.isTradingDay(LocalDate.of(2028, 12, 28))).isTrue();
        assertThat(cal.isHoliday(LocalDate.of(2028, 12, 31))).as("주말은 휴장일 목록에 넣지 않음(인터페이스 약속)").isFalse();
        assertThat(cal.isTradingDay(LocalDate.of(2028, 12, 31))).isFalse();
    }

    @Test
    @DisplayName("대체 조건은 주말·공휴일·임시휴장 — 12-31(월)이 공휴일이면 12-28(금), 임시휴장이 12-31·대체일에 걸리면 그 앞으로")
    void yearEndSkipsHolidaysAndExtraClosures() {
        // 가상의 2029: 12-31(월)이 임시공휴일인 해(실례 없음 — 명세 §4-4 'B5a·B5b에서 정한 것').
        KrxCalendar holiday = calendar(Map.of(2029, dates("2029-01-01", "2029-12-25", "2029-12-31")));
        assertThat(holiday.yearEndClosure(2029)).isEqualTo(LocalDate.of(2029, 12, 28));
        assertThat(holiday.isTradingDay(LocalDate.of(2029, 12, 27))).isTrue();

        // 설정 임시휴장(kr.calendar.extraClosures)도 휴장이고, 대체일 계산에서 휴장으로 셉니다(명세 §4-4 B5에서 정한 것).
        KrxCalendar extra = calendar(Map.of(2026, KrxFixtures.kasiHolidays(2026)), LocalDate.of(2026, 12, 31),
                LocalDate.of(2026, 11, 19));
        assertThat(extra.isTradingDay(LocalDate.of(2026, 11, 19))).isFalse();
        assertThat(extra.isHoliday(LocalDate.of(2026, 11, 19))).isTrue();
        assertThat(extra.yearEndClosure(2026)).as("12-31이 임시휴장이면 직전 매매거래일(12-30 수)")
                .isEqualTo(LocalDate.of(2026, 12, 30));
        assertThat(extra.isTradingDay(LocalDate.of(2026, 12, 29))).isTrue();

        assertThat(KrxCalendar.yearEndClosure(2028, Set.of())).as("공휴일 없이도 주말 대체는 규칙만으로")
                .isEqualTo(LocalDate.of(2028, 12, 29));
        assertThat(KrxCalendar.yearEndClosure(2033, null)).isEqualTo(LocalDate.of(2033, 12, 30));
        assertThat(KrxCalendar.yearEndClosure(2034, Set.of())).isEqualTo(LocalDate.of(2034, 12, 29));
    }

    @Test
    @DisplayName("5-1 — 2026년 전에는 공휴일 목록에 없어도 휴장(2025-05-01 목), 2026년부터는 천문연 목록을 따름, 2027-05-03(노동절 대체) 휴장")
    void laborDay() {
        KrxCalendar cal = calendar(Map.of(2025, KASI_2025, 2026, KrxFixtures.kasiHolidays(2026),
                2027, KrxFixtures.kasiHolidays(2027)));
        assertThat(KASI_2025).doesNotContain(LocalDate.of(2025, 5, 1));
        assertThat(cal.isTradingDay(LocalDate.of(2025, 5, 1))).isFalse();
        assertThat(cal.isTradingDay(LocalDate.of(2025, 5, 2))).isTrue();
        assertThat(cal.isTradingDay(LocalDate.of(2026, 5, 1))).isFalse();
        assertThat(cal.isTradingDay(LocalDate.of(2027, 5, 3))).as("2027-05-01(토) 노동절의 대체공휴일").isFalse();
        assertThat(KrxFixtures.krxClosures(2027)).containsEntry(LocalDate.of(2027, 5, 3), "노동절(대체휴일)");
        assertThat(cal.isTradingDay(LocalDate.of(2027, 5, 4))).isTrue();

        // 2026년부터는 5-1을 규칙으로 더하지 않습니다 — 목록에 없으면 거래일(목록이 늘 노동절을 담는다는 [확인] 위에 선 규칙).
        List<LocalDate> without = KrxFixtures.kasiHolidays(2026).stream()
                .filter(d -> !d.equals(LocalDate.of(2026, 5, 1))).toList();
        assertThat(calendar(Map.of(2026, without)).isTradingDay(LocalDate.of(2026, 5, 1))).isTrue();
    }

    @Test
    @DisplayName("모르는 해는 fail-closed — 평일은 CalendarUnavailableException('달력 없음'), 주말은 목록 없이도 휴장, 빈 목록은 모르는 해")
    void unknownYearFailsClosed() {
        KrxCalendar cal = calendar(new HashMap<>(Map.of(2026, KrxFixtures.kasiHolidays(2026), 2027, List.of())));
        assertThat(cal.covers(2026)).isTrue();
        assertThat(cal.covers(2027)).as("빈 목록 = 발표 전").isFalse();
        assertThat(cal.coveredYears()).containsExactly(2026);

        assertThatThrownBy(() -> cal.isTradingDay(LocalDate.of(2027, 1, 4)))
                .isInstanceOfSatisfying(CalendarUnavailableException.class, e -> {
                    assertThat(e.year()).isEqualTo(2027);
                    assertThat(e.getMessage()).startsWith(CalendarUnavailableException.REASON + " — 2027년")
                            .contains("KrxCalendar[아는 해 2026]");
                });
        assertThatThrownBy(() -> cal.isHoliday(LocalDate.of(2025, 12, 31)))
                .isInstanceOf(CalendarUnavailableException.class);
        assertThatThrownBy(() -> cal.yearEndClosure(2027)).isInstanceOf(CalendarUnavailableException.class);
        assertThat(cal.isTradingDay(LocalDate.of(2027, 1, 2))).as("토요일").isFalse();
        assertThat(cal.isHoliday(LocalDate.of(2027, 1, 3))).as("일요일").isFalse();

        // 기본 메서드도 모르는 해의 평일에 닿으면 멈춥니다 — 휴장으로 지나쳐 31일 상한까지 가지 않음.
        assertThat(cal.nextTradingDay(LocalDate.of(2026, 12, 29))).isEqualTo(LocalDate.of(2026, 12, 30));
        assertThatThrownBy(() -> cal.nextTradingDay(LocalDate.of(2026, 12, 30)))
                .as("12-31 연말휴장 → 2027-01-01(금)은 모름").isInstanceOf(CalendarUnavailableException.class);
        assertThat(cal.addTradingDays(LocalDate.of(2026, 12, 24), 3)).as("12-28·29·30").isEqualTo(LocalDate.of(2026, 12, 30));
        assertThatThrownBy(() -> cal.addTradingDays(LocalDate.of(2026, 12, 24), 4))
                .isInstanceOf(CalendarUnavailableException.class);
        assertThatThrownBy(() -> cal.tradingDaysBetween(LocalDate.of(2025, 12, 30), LocalDate.of(2026, 1, 5)))
                .isInstanceOf(CalendarUnavailableException.class);
        assertThatThrownBy(() -> cal.previousTradingDay(LocalDate.of(2026, 1, 2)))
                .as("2026-01-01 신정 → 2025-12-31은 모름").isInstanceOf(CalendarUnavailableException.class);
        Instant firstMonday2027 = ZonedDateTime.of(2027, 1, 4, 16, 0, 0, 0, KrxCalendar.SEOUL).toInstant();
        assertThatThrownBy(() -> cal.lastCompletedSession(firstMonday2027))
                .isInstanceOf(CalendarUnavailableException.class);
    }

    @Test
    @DisplayName("지난 해 계산은 그해 목록만 있으면 지금이 언제든 같다 — 2025년~(수집기 보존, K35)이면 2029년에도 2026년 거래일을 셈")
    void pastYearsCountFromAnyVantage() {
        KrxCalendar kept = calendar(Map.of(2025, KASI_2025, 2026, KrxFixtures.kasiHolidays(2026),
                2027, KrxFixtures.kasiHolidays(2027), 2028, KASI_2028));
        // 2026-11-02(월) ~ 2026-12-31: 평일 44일 − 12-25·12-31 = 42거래일.
        assertThat(kept.tradingDaysBetween(LocalDate.of(2026, 10, 30), LocalDate.of(2026, 12, 31))).isEqualTo(42);
        assertThat(kept.tradingDaysBetween(LocalDate.of(2025, 12, 30), LocalDate.of(2026, 1, 5))).isEqualTo(2);
        // 지난해만 남기는 옛 보존 규칙(2029년이면 2028년~)이었다면 2026년이 없어 같은 계산이 멈춥니다.
        KrxCalendar oldRetention = calendar(Map.of(2028, KASI_2028));
        assertThatThrownBy(() -> oldRetention.tradingDaysBetween(LocalDate.of(2026, 10, 30), LocalDate.of(2026, 12, 31)))
                .isInstanceOf(CalendarUnavailableException.class);
    }

    @Test
    @DisplayName("세션 — 서울 09:00 개장·15:30 마감, 조기 폐장 없음, 최근 세션은 연말휴장·신정을 건너뜀")
    void sessions() {
        KrxCalendar cal = kasi2026And2027();
        LocalDate mon = LocalDate.of(2026, 10, 26);
        assertThat(cal.zone()).isEqualTo(KrxCalendar.SEOUL);
        assertThat(cal.openInstant(mon)).isEqualTo(Instant.parse("2026-10-26T00:00:00Z"));
        assertThat(cal.closeInstant(mon)).isEqualTo(Instant.parse("2026-10-26T06:30:00Z"));
        assertThat(cal.isEarlyClose(mon)).isFalse();
        Instant yearEndMorning = ZonedDateTime.of(LocalDate.of(2026, 12, 31), LocalTime.of(10, 0), KrxCalendar.SEOUL)
                .toInstant();
        assertThat(cal.currentOrLastSession(yearEndMorning)).isEqualTo(LocalDate.of(2026, 12, 30));
        Instant firstMorning2027 = ZonedDateTime.of(LocalDate.of(2027, 1, 4), LocalTime.of(8, 0), KrxCalendar.SEOUL)
                .toInstant();
        assertThat(cal.lastCompletedSession(firstMorning2027)).isEqualTo(LocalDate.of(2026, 12, 30));
        assertThat(cal.lastCompletedSession(firstMorning2027.plusSeconds(8 * 3600))).isEqualTo(LocalDate.of(2027, 1, 4));
        // 2026년 거래일 수 — 평일 261일 − 평일 휴장 17일.
        long weekdays = Stream.iterate(LocalDate.of(2026, 1, 1), d -> d.getYear() == 2026, d -> d.plusDays(1))
                .filter(d -> d.getDayOfWeek() != DayOfWeek.SATURDAY && d.getDayOfWeek() != DayOfWeek.SUNDAY).count();
        assertThat(weekdays).isEqualTo(261);
        assertThat(cal.tradingDaysBetween(LocalDate.of(2025, 12, 31), LocalDate.of(2026, 12, 31)))
                .as("(2025-12-31, 2026-12-31] — 시작일은 세지 않아 2025년 목록이 없어도 됨").isEqualTo(244);
    }

    @Test
    @DisplayName("장 시간 변경일(결정 d8) — 수능일 2026-11-19 10:00~16:30이면 그날 개장·마감·세션 판정이 그 쌍, 다른 날·쌍 없는 판은 정규장")
    void sessionHoursOverrides() {
        LocalDate suneung = LocalDate.of(2026, 11, 19);
        LocalDate before = LocalDate.of(2026, 11, 18);
        KrxCalendar plain = kasi2026And2027();
        KrxCalendar cal = new KrxCalendar(Map.of(2026, KrxFixtures.kasiHolidays(2026), 2027, KrxFixtures.kasiHolidays(2027)),
                List.of(), Map.of(suneung, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));

        assertThat(cal.isTradingDay(suneung)).as("거래일은 그대로").isTrue();
        assertThat(cal.openInstant(suneung)).isEqualTo(seoul(suneung, 10, 0));
        assertThat(cal.closeInstant(suneung)).isEqualTo(seoul(suneung, 16, 30));
        assertThat(cal.openInstant(before)).as("다른 날은 정규장").isEqualTo(seoul(before, 9, 0));
        assertThat(cal.closeInstant(before)).isEqualTo(seoul(before, 15, 30));
        assertThat(cal.isEarlyClose(suneung)).isFalse();
        assertThat(cal.sessionHours()).containsOnlyKeys(suneung);

        // 그날 16:00은 아직 장중 — 마감이 끝난 최근 세션은 전 거래일. 쌍이 없는 판은 15:30에 끝난 것으로 봅니다.
        assertThat(cal.lastCompletedSession(seoul(suneung, 16, 0))).isEqualTo(before);
        assertThat(cal.lastCompletedSession(seoul(suneung, 16, 30))).as("마감 그 순간은 끝남").isEqualTo(suneung);
        assertThat(plain.lastCompletedSession(seoul(suneung, 16, 0))).isEqualTo(suneung);
        // 09:30은 아직 개장 전 — 지금(또는 직전) 세션은 전 거래일.
        assertThat(cal.currentOrLastSession(seoul(suneung, 9, 30))).isEqualTo(before);
        assertThat(cal.currentOrLastSession(seoul(suneung, 10, 0))).isEqualTo(suneung);
        assertThat(plain.currentOrLastSession(seoul(suneung, 9, 30))).isEqualTo(suneung);

        assertThatThrownBy(() -> new KrxCalendar.Hours(LocalTime.of(16, 30), LocalTime.of(10, 0)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("16:30");
        assertThatThrownBy(() -> new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(10, 0)))
                .isInstanceOf(IllegalArgumentException.class);
        Map<LocalDate, KrxCalendar.Hours> withNull = new HashMap<>();
        withNull.put(suneung, null);
        assertThat(new KrxCalendar(Map.of(2026, KrxFixtures.kasiHolidays(2026)), null, withNull).sessionHours())
                .as("null 값은 버림").isEmpty();
    }

    private static Instant seoul(LocalDate day, int hour, int minute) {
        return ZonedDateTime.of(day, LocalTime.of(hour, minute), KrxCalendar.SEOUL).toInstant();
    }

    @Test
    @DisplayName("입력 점검 — 다른 해의 날이 섞인 목록은 거절, null 목록·null 임시휴장은 없음으로")
    void inputChecks() {
        assertThatThrownBy(() -> new KrxCalendar(Map.of(2026, dates("2026-01-01", "2027-01-01")), List.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("2027-01-01");
        Map<Integer, List<LocalDate>> withNull = new HashMap<>();
        withNull.put(2026, null);
        KrxCalendar none = new KrxCalendar(withNull, null);
        assertThat(none.covers(2026)).isFalse();
        assertThat(none.toString()).isEqualTo("KrxCalendar[아는 해 없음]");
        assertThat(kasi2026And2027().toString()).isEqualTo("KrxCalendar[아는 해 2026·2027]");
    }

    private static List<LocalDate> dates(String... iso) {
        return Stream.of(iso).map(LocalDate::parse).toList();
    }
}
