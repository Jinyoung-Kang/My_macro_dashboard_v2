package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.Month;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.SortedSet;
import java.util.TreeSet;
import java.util.stream.Collectors;

/**
 * 🧪 한국 증시(KRX 유가증권·코스닥 정규장) 거래일 달력 — 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-4·K16·K35.
 *
 * <pre>
 *  휴장 = 주말 ∪ 천문연 공휴일(isHoliday=Y) ∪ 연말휴장일 ∪ 설정 임시휴장(kr.calendar.extraClosures) ∪ (2026년 전이면 5-1)
 *  연말휴장일 = 12-31부터 거슬러 올라가 주말도, 공휴일 목록에도, 임시휴장에도 없는 첫 날
 * </pre>
 *
 * <p>[확인] 이 식이 KRX 공식 휴장일 목록(open.krx.co.kr, 2026-10-26 조회)과 2026년 17일·2027년 16일 모두 일치하고, 연말휴장일
 * 대체의 KRX 실례는 2022-12-30(12-31 토)·2023-12-29(12-31 일)입니다(다음은 2028-12-29). 5-1(근로자의 날)은 2026년부터
 * 천문연 목록에 '노동절'로 들어오고, 그 전 해에는 공휴일이 아니어도 KRX가 쉬었으므로 따로 더합니다(주말이면 대체하지 않음 —
 * 2022-05-01 일요일은 KRX 목록에 없음). 수집기 {@code krcalendar.year_end_closure}·화면 {@code krYearEndClosure}와 같은
 * 연말휴장 식이고, 그 둘에 없는 임시휴장도 대체일 계산에서 휴장으로 셉니다(명세 §4-4 'B5에서 정한 것').
 *
 * <p><b>모르는 해</b>(K35 fail-closed): 공휴일 목록을 받은 해만 압니다. 목록이 없는 해(또는 빈 목록 — 신정이 늘 들어 있어 빈 목록은
 * '아직 발표 전')의 평일을 물으면 {@link CalendarUnavailableException}을 던집니다 — 짐작한 휴장·거래일은 만료·재진입 금지·통계
 * 표본을 조용히 바꿉니다. 주말은 목록 없이도 휴장이라 던지지 않습니다. 다음·직전 거래일·n거래일 뒤·구간 거래일 수(인터페이스 기본
 * 메서드)도 모르는 해의 평일에 닿으면 같은 예외로 멈춥니다.
 *
 * <p>순수 클래스입니다(이 패키지는 {@code java.*}만 — DB·설정을 읽지 않음). 공휴일은 수집기 {@code kr_holidays} 저장본에서,
 * 임시휴장은 설정 {@code kr.calendar.extraClosures}에서 부르는 쪽이 읽어 넘깁니다(그 연결은 C1). 장 시간 변경(수능일·신년
 * 10:00 개장)은 거래일을 바꾸지 않아 여기 두지 않습니다 — {@code kr.calendar.openTimeOverrides}는 1분봉 시가 봉 고르기(C2)의 몫.
 * 개장·마감 순간은 정규장 09:00·15:30(서울)이고 조기 폐장은 없습니다.
 */
public final class KrxCalendar implements TradingCalendar {

    /** 서울 시간대(서머타임 없음). */
    public static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    /** 정규장 시작(서울). */
    static final LocalTime OPEN = LocalTime.of(9, 0);
    /** 정규장 마감(서울) — 15:20~15:30 종가 단일가 뒤. */
    static final LocalTime CLOSE = LocalTime.of(15, 30);
    /** 5-1이 천문연 공휴일 목록(노동절)에 들어오기 시작한 해 — 그 전 해는 KRX 고유 휴장일로 더합니다. */
    static final int LABOR_DAY_LISTED_FROM = 2026;

    /** 해 → 그해 천문연 공휴일(빈 목록인 해는 넣지 않음 — 모르는 해). */
    private final Map<Integer, Set<LocalDate>> holidays;
    /** 설정 임시휴장(해와 상관없이 — 모르는 해의 날이면 그해는 여전히 모름). */
    private final Set<LocalDate> extraClosures;
    /** 해 → 연말휴장일(아는 해만, 만들 때 한 번 계산). */
    private final Map<Integer, LocalDate> yearEnd;

    /**
     * @param holidaysByYear 해 → 그해 천문연 공휴일({@code isHoliday=Y}, 주말에 걸린 날 포함 그대로). 빈 목록·null인 해는 모르는 해로
     *                       둡니다(발표 전 해는 0건이 옴)
     * @param extraClosures  설정의 임시휴장일(null이면 없음)
     * @throws IllegalArgumentException 공휴일의 해가 그 키의 해와 다름(부르는 쪽 오류)
     */
    public KrxCalendar(Map<Integer, ? extends Collection<LocalDate>> holidaysByYear,
                       Collection<LocalDate> extraClosures) {
        Map<Integer, Set<LocalDate>> byYear = new HashMap<>();
        if (holidaysByYear != null) {
            holidaysByYear.forEach((year, days) -> {
                if (year == null || days == null || days.isEmpty()) {
                    return;
                }
                Set<LocalDate> set = new HashSet<>();
                for (LocalDate day : days) {
                    if (day == null || day.getYear() != year) {
                        throw new IllegalArgumentException(year + "년 공휴일 목록에 그해가 아닌 날이 있습니다: " + day);
                    }
                    set.add(day);
                }
                byYear.put(year, Collections.unmodifiableSet(set));
            });
        }
        this.holidays = Collections.unmodifiableMap(byYear);
        Set<LocalDate> extra = new HashSet<>();
        if (extraClosures != null) {
            extraClosures.stream().filter(Objects::nonNull).forEach(extra::add);
        }
        this.extraClosures = Collections.unmodifiableSet(extra);
        Map<Integer, LocalDate> ends = new HashMap<>();
        for (Map.Entry<Integer, Set<LocalDate>> e : byYear.entrySet()) {
            Set<LocalDate> closed = new HashSet<>(e.getValue());
            closed.addAll(this.extraClosures);
            ends.put(e.getKey(), yearEndClosure(e.getKey(), closed));
        }
        this.yearEnd = Collections.unmodifiableMap(ends);
    }

    /**
     * 그해 KRX 연말휴장일 — 12-31부터 거슬러 올라가 주말도 {@code closed}에도 없는 첫 날(직전 매매거래일). 수집기
     * {@code krcalendar.year_end_closure}·화면 {@code krYearEndClosure}와 같은 식입니다. {@code closed}가 비어 있으면 주말
     * 대체만 합니다(운영자 수집 검증의 대조 시간처럼 공휴일 목록 없이도 답해야 하는 곳 — {@link Verification}).
     *
     * @param closed 그해 공휴일(과 임시휴장) — 12-31 규칙으로 더한 날은 넣지 않습니다. null이면 없음
     * @throws IllegalArgumentException 12월에 그런 날이 없음(있을 수 없는 입력)
     */
    public static LocalDate yearEndClosure(int year, Set<LocalDate> closed) {
        for (LocalDate day = LocalDate.of(year, Month.DECEMBER, 31); day.getMonth() == Month.DECEMBER;
             day = day.minusDays(1)) {
            if (!isWeekend(day) && (closed == null || !closed.contains(day))) {
                return day;
            }
        }
        throw new IllegalArgumentException(year + "년 12월에 주말·휴장 아닌 날이 없습니다");
    }

    /** 그해 공휴일 목록을 받았나(아는 해). */
    public boolean covers(int year) {
        return holidays.containsKey(year);
    }

    /** 아는 해, 오름차순. */
    public SortedSet<Integer> coveredYears() {
        return Collections.unmodifiableSortedSet(new TreeSet<>(holidays.keySet()));
    }

    /**
     * 그해 연말휴장일.
     *
     * @throws CalendarUnavailableException 모르는 해
     */
    public LocalDate yearEndClosure(int year) {
        require(year);
        return yearEnd.get(year);
    }

    @Override
    public ZoneId zone() {
        return SEOUL;
    }

    /**
     * 평일 중 휴장일인지 — 천문연 공휴일·연말휴장일·임시휴장·(2026년 전) 5-1. 주말은 false입니다(인터페이스 약속).
     *
     * @throws CalendarUnavailableException 모르는 해의 평일
     */
    @Override
    public boolean isHoliday(LocalDate d) {
        if (isWeekend(d)) {
            return false;
        }
        int year = d.getYear();
        require(year);
        return holidays.get(year).contains(d)
                || d.equals(yearEnd.get(year))
                || extraClosures.contains(d)
                || (year < LABOR_DAY_LISTED_FROM && d.getMonth() == Month.MAY && d.getDayOfMonth() == 1);
    }

    /**
     * 평일이고 휴장일이 아니면 거래일. 주말은 늘 false.
     *
     * @throws CalendarUnavailableException 모르는 해의 평일
     */
    @Override
    public boolean isTradingDay(LocalDate d) {
        return !isWeekend(d) && !isHoliday(d);
    }

    /** KRX 정규장에는 조기 폐장이 없습니다(장 시간 변경은 개장을 늦춤 — 클래스 설명). */
    @Override
    public boolean isEarlyClose(LocalDate d) {
        return false;
    }

    @Override
    public Instant openInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, OPEN, SEOUL).toInstant();
    }

    @Override
    public Instant closeInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, CLOSE, SEOUL).toInstant();
    }

    @Override
    public String toString() {
        SortedSet<Integer> years = coveredYears();
        return "KrxCalendar[아는 해 " + (years.isEmpty() ? "없음" : years.stream().map(String::valueOf)
                .collect(Collectors.joining("·"))) + "]";
    }

    private void require(int year) {
        if (!holidays.containsKey(year)) {
            throw new CalendarUnavailableException(year, toString());
        }
    }

    private static boolean isWeekend(LocalDate d) {
        DayOfWeek w = d.getDayOfWeek();
        return w == DayOfWeek.SATURDAY || w == DayOfWeek.SUNDAY;
    }
}
