package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.Month;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.temporal.TemporalAdjusters;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 🧪 미국 증시(NYSE·NASDAQ) 거래일 달력 — 모의 매매 장부의 '세션 날짜'와 13F 공시 기한.
 *
 * <p>장부의 날짜는 전부 <b>뉴욕 시각 기준 세션 날짜</b>입니다. 서버 TZ(UTC)나 한국 날짜로 세면 한국 아침(=뉴욕 전날 저녁)에
 * 들어온 종가가 '다음 날' 봉으로 읽혀, 주문의 기준 거래일 판정(체결 룩어헤드 방지)이 하루씩 어긋납니다.
 *
 * <p><b>휴장일 규칙은 화면({@code frontend/src/lib/marketCalendar.ts}의 {@code usMarketHolidays})과 같습니다.</b>
 * 화면 시계는 "열렸나"를, 장부는 "체결·만료·재진입 금지가 며칠 지났나"를 이 규칙으로 셉니다. 둘이 다르면 화면은
 * 개장이라는데 장부는 휴장으로 세는 날이 생깁니다. 규칙(고정 날짜는 토→금·일→월):
 * 신정 · 마틴 루터 킹 데이(1월 셋째 월) · 대통령의 날(2월 셋째 월) · 성금요일 · 메모리얼 데이(5월 마지막 월) ·
 * 준틴스(6-19) · 독립기념일(7-4) · 노동절(9월 첫째 월) · 추수감사절(11월 넷째 목) · 크리스마스(12-25).
 *
 * <p>규칙으로 계산하므로 아래는 <b>담지 못합니다</b>(한계):
 * <ul>
 *   <li>임시 휴장 — 2025-01-09 카터 전 대통령 애도일, 2018-12-05 부시 전 대통령 애도일, 2012-10-29·30 허리케인 샌디.
 *       그날은 거래일로 셉니다(그날 봉이 없으니 체결은 일어나지 않지만, 만료·재진입 금지 일수가 하루 짧아집니다).</li>
 *   <li>준틴스는 NYSE가 2022년부터 쉬었지만 화면 규칙을 따라 모든 해에 휴장으로 셉니다(2021년 이전 6-19가 거래일이던 해에
 *       하루 차이). 장부는 2026-10 이후만 다루므로 영향이 없습니다.</li>
 * </ul>
 * NYSE가 공지한 2025~2027 휴장일·조기 폐장일과 대조했습니다(nyse.com/markets/hours-calendars, 2026-10-24 확인).
 *
 * <p>13F 공시 기한은 증시가 아니라 <b>SEC 영업일</b>(연방 공휴일 제외)로 셉니다 — 성금요일은 SEC가 열고, 컬럼버스 데이·
 * 재향군인의 날은 증시가 엽니다. 두 달력을 섞으면 기한이 하루 틀립니다.
 */
public final class UsMarketCalendar {

    private UsMarketCalendar() {
    }

    /** 미국 동부 시간대. 서머타임(EDT↔EST) 전환은 이 시간대 규칙이 처리합니다. */
    public static final ZoneId NEW_YORK = ZoneId.of("America/New_York");

    /**
     * 이 달력을 {@link TradingCalendar}로 — 시장 중립 코드(장부·통계·복기 등)가 받는 미국 달력(2단계 명세 §9 A1). 모든 메서드가 아래
     * 같은 이름의 정적 함수를 그대로 부르므로(인터페이스의 기본 메서드도 쓰지 않음) 미국 숫자는 정적 함수와 같습니다. 13F 공시 기한·
     * 재선정일·SEC 영업일은 미국 전용이라 인터페이스에 없고 정적 함수로만 씁니다.
     */
    public static final TradingCalendar CALENDAR = new Adapter();

    /** 정규장 시작(동부 시각). */
    private static final LocalTime OPEN = LocalTime.of(9, 30);
    /** 정규장 마감(동부 시각). */
    private static final LocalTime REGULAR_CLOSE = LocalTime.of(16, 0);
    /** 조기 폐장일의 마감(동부 시각). */
    private static final LocalTime EARLY_CLOSE = LocalTime.of(13, 0);
    /** 13F는 분기 말 뒤 45일 안에 공시합니다(SEC Rule 13f-1). */
    private static final int THIRTEEN_F_DAYS = 45;

    /** 해마다 한 번만 계산합니다 — 10년 이력에서 거래일을 셀 때 같은 해를 수천 번 묻기 때문입니다. */
    private static final Map<Integer, Set<LocalDate>> MARKET_HOLIDAYS = new ConcurrentHashMap<>();
    private static final Map<Integer, Set<LocalDate>> FEDERAL_HOLIDAYS = new ConcurrentHashMap<>();

    /**
     * NYSE 정규장 휴장일인지. 주말은 휴장일이 아닙니다(휴장일 목록은 평일만 담음) — 거래일 판정은 {@link #isTradingDay}.
     */
    public static boolean isHoliday(LocalDate d) {
        return MARKET_HOLIDAYS.computeIfAbsent(d.getYear(), UsMarketCalendar::marketHolidays).contains(d);
    }

    /** 평일이고 휴장일이 아니면 거래일. */
    public static boolean isTradingDay(LocalDate d) {
        return !isWeekend(d) && !isHoliday(d);
    }

    /** d 다음(엄격히 뒤) 거래일. d가 거래일이어도 d는 돌려주지 않습니다. */
    public static LocalDate nextTradingDay(LocalDate d) {
        LocalDate next = d.plusDays(1);
        while (!isTradingDay(next)) {
            next = next.plusDays(1);
        }
        return next;
    }

    /** d 전(엄격히 앞) 거래일. */
    public static LocalDate previousTradingDay(LocalDate d) {
        LocalDate previous = d.minusDays(1);
        while (!isTradingDay(previous)) {
            previous = previous.minusDays(1);
        }
        return previous;
    }

    /**
     * d에서 n거래일 뒤. d <b>다음</b> 거래일을 1로 셉니다 — 주문 만료(기준 거래일 + 3거래일)·재진입 금지(관측일 + 20거래일)가
     * "그날은 빼고 n거래일"이라는 뜻이기 때문입니다.
     *
     * @param n 0 이상. 0이면 d를 그대로(d가 휴장일이어도) 돌려줍니다
     * @throws IllegalArgumentException n이 음수
     */
    public static LocalDate addTradingDays(LocalDate d, int n) {
        if (n < 0) {
            throw new IllegalArgumentException("거래일 수는 0 이상이어야 합니다: " + n);
        }
        LocalDate out = d;
        for (int i = 0; i < n; i++) {
            out = nextTradingDay(out);
        }
        return out;
    }

    /**
     * (from, to] 구간의 거래일 수 — from은 빼고 to는 넣습니다. {@code tradingDaysBetween(d, addTradingDays(d, n)) == n}.
     *
     * @return from ≥ to면 0
     */
    public static int tradingDaysBetween(LocalDate from, LocalDate to) {
        if (!from.isBefore(to)) {
            return 0;
        }
        int count = 0;
        for (LocalDate d = from.plusDays(1); !d.isAfter(to); d = d.plusDays(1)) {
            if (isTradingDay(d)) {
                count++;
            }
        }
        return count;
    }

    /**
     * 그 거래일의 마감 시각(동부): 16:00, 조기 폐장일이면 13:00. 휴장일·주말을 넣으면 16:00을 돌려줍니다(의미 없는 값 —
     * 호출부가 거래일인지 먼저 확인).
     */
    public static LocalTime closeTime(LocalDate tradingDate) {
        return isEarlyClose(tradingDate) ? EARLY_CLOSE : REGULAR_CLOSE;
    }

    /**
     * 13:00 조기 폐장일인지: 독립기념일 전날(7-3), 추수감사절 다음 날, 크리스마스 이브(12-24) — 그날이 거래일일 때만.
     *
     * <p>7-3·12-24가 그 자체로 대체 휴장일(7-4·12-25가 토요일)인 해에는 조기 폐장이 없고, 그 전날로 옮겨 가지도 않습니다
     * (2026-07-02·2027-12-23은 정규 마감 — NYSE 공지와 일치).
     */
    public static boolean isEarlyClose(LocalDate d) {
        if (!isTradingDay(d)) {
            return false;
        }
        if (d.getMonth() == Month.JULY && d.getDayOfMonth() == 3) {
            return true;
        }
        if (d.getMonth() == Month.DECEMBER && d.getDayOfMonth() == 24) {
            return true;
        }
        return d.equals(thanksgiving(d.getYear()).plusDays(1));
    }

    /** 그 거래일 마감 순간. 서머타임이면 20:00Z(조기 17:00Z), 아니면 21:00Z(조기 18:00Z). */
    public static Instant closeInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, closeTime(tradingDate), NEW_YORK).toInstant();
    }

    private static Instant openInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, OPEN, NEW_YORK).toInstant();
    }

    /** now 시점에 마감이 끝난 가장 최근 세션(마감 시각 ≤ now). 마감 그 순간은 '끝남'으로 봅니다. */
    public static LocalDate lastCompletedSession(Instant now) {
        LocalDate today = now.atZone(NEW_YORK).toLocalDate();
        if (isTradingDay(today) && !closeInstant(today).isAfter(now)) {
            return today;
        }
        // 직전 거래일의 마감은 오늘(뉴욕 날짜) 0시보다 앞이므로 한 번 물러서면 충분합니다.
        return previousTradingDay(today);
    }

    /**
     * now가 속한(또는 직전) 세션 날짜 — 장중·장 마감 뒤면 오늘, 장 시작 전·주말·휴장일이면 직전 거래일.
     * now 이전에 시작한(09:30 ET ≤ now) 세션 중 가장 최근입니다.
     */
    public static LocalDate currentOrLastSession(Instant now) {
        LocalDate today = now.atZone(NEW_YORK).toLocalDate();
        if (isTradingDay(today) && !openInstant(today).isAfter(now)) {
            return today;
        }
        return previousTradingDay(today);
    }

    /**
     * 13F 공시 기한: 분기 말 + 45일, 그날이 주말·연방 공휴일이면 다음 <b>SEC 영업일</b>.
     *
     * <p>증시 달력이 아닙니다. 예: 2026-12-31 분기 → 2027-02-14(일) → 02-15(월)는 대통령의 날(연방 공휴일) → 02-16.
     *
     * @param quarterEnd 분기 말(3-31·6-30·9-30·12-31). 다른 날을 넣어도 계산은 하지만 뜻이 없습니다
     */
    public static LocalDate thirteenFDeadline(LocalDate quarterEnd) {
        LocalDate d = quarterEnd.plusDays(THIRTEEN_F_DAYS);
        while (!isSecBusinessDay(d)) {
            d = d.plusDays(1);
        }
        return d;
    }

    /**
     * 그 분기의 재선정일 = 공시 기한 <b>다음</b> 거래일(명세 R5). 기한 당일 밤까지 들어온 공시를 다 본 뒤 하루를 씁니다.
     */
    public static LocalDate reselectionDay(LocalDate quarterEnd) {
        return nextTradingDay(thirteenFDeadline(quarterEnd));
    }

    /** 그 거래일이 어느 분기의 재선정일인지. */
    public static boolean isReselectionDay(LocalDate tradingDate) {
        // 재선정일은 분기를 따라 엄격히 늘어나므로, d가 어떤 분기의 재선정일이면 그 분기가 곧 'd까지 재선정된 최신 분기'입니다.
        return reselectionDay(latestQuarterEndReselectedBy(tradingDate)).equals(tradingDate);
    }

    /**
     * reselectionDay(q) ≤ d인 가장 늦은 분기 말 q — d 시점에 '공시 기한이 지나 재선정이 이미 일어난' 최신 분기.
     * 예: 2026-10-23 → 2026-06-30(9월 분기의 재선정일 2026-11-17 전), 2026-11-17 → 2026-09-30.
     */
    public static LocalDate latestQuarterEndReselectedBy(LocalDate d) {
        LocalDate q = quarterEndOnOrBefore(d);
        while (reselectionDay(q).isAfter(d)) {
            q = previousQuarterEnd(q);
        }
        return q;
    }

    /** SEC 영업일: 평일이고 연방 공휴일이 아닌 날. 13F 기한 계산에만 씁니다. */
    static boolean isSecBusinessDay(LocalDate d) {
        return !isWeekend(d) && !isFederalHoliday(d);
    }

    /**
     * 연방 공휴일(5 U.S.C. 6103, 토→금·일→월 관측). 신정이 토요일이면 전년 12-31이 관측 휴일이라 다음 해 목록도 봅니다.
     */
    static boolean isFederalHoliday(LocalDate d) {
        return FEDERAL_HOLIDAYS.computeIfAbsent(d.getYear(), UsMarketCalendar::federalHolidays).contains(d)
                || FEDERAL_HOLIDAYS.computeIfAbsent(d.getYear() + 1, UsMarketCalendar::federalHolidays).contains(d);
    }

    private static Set<LocalDate> marketHolidays(int year) {
        Set<LocalDate> days = new HashSet<>();
        // 신정이 토요일이면 NYSE는 전년 12-31(금)에 쉬지 않습니다(NYSE Rule 7.2). 화면은 이때 'YYYY-01-00'이라는 없는 날짜를
        // 만들어 아무 날에도 걸리지 않으므로 결과가 같습니다 — 여기서는 명시적으로 넣지 않습니다.
        LocalDate newYear = LocalDate.of(year, 1, 1);
        if (newYear.getDayOfWeek() != DayOfWeek.SATURDAY) {
            days.add(observed(newYear));
        }
        days.add(nthWeekday(year, Month.JANUARY, DayOfWeek.MONDAY, 3));    // 마틴 루터 킹 데이
        days.add(nthWeekday(year, Month.FEBRUARY, DayOfWeek.MONDAY, 3));   // 대통령의 날
        days.add(easterSunday(year).minusDays(2));                         // 성금요일(연방 공휴일 아님)
        days.add(lastWeekday(year, Month.MAY, DayOfWeek.MONDAY));          // 메모리얼 데이
        days.add(observed(LocalDate.of(year, 6, 19)));                     // 준틴스
        days.add(observed(LocalDate.of(year, 7, 4)));                      // 독립기념일
        days.add(nthWeekday(year, Month.SEPTEMBER, DayOfWeek.MONDAY, 1));  // 노동절
        days.add(thanksgiving(year));                                      // 추수감사절
        days.add(observed(LocalDate.of(year, 12, 25)));                    // 크리스마스
        return Set.copyOf(days);
    }

    private static Set<LocalDate> federalHolidays(int year) {
        Set<LocalDate> days = new HashSet<>();
        days.add(observed(LocalDate.of(year, 1, 1)));                      // 신정(토요일이면 전년 12-31)
        days.add(nthWeekday(year, Month.JANUARY, DayOfWeek.MONDAY, 3));
        days.add(nthWeekday(year, Month.FEBRUARY, DayOfWeek.MONDAY, 3));   // 워싱턴 탄생일
        days.add(lastWeekday(year, Month.MAY, DayOfWeek.MONDAY));
        days.add(observed(LocalDate.of(year, 6, 19)));
        days.add(observed(LocalDate.of(year, 7, 4)));
        days.add(nthWeekday(year, Month.SEPTEMBER, DayOfWeek.MONDAY, 1));
        days.add(nthWeekday(year, Month.OCTOBER, DayOfWeek.MONDAY, 2));    // 컬럼버스 데이(증시는 엶)
        days.add(observed(LocalDate.of(year, 11, 11)));                    // 재향군인의 날(증시는 엶)
        days.add(thanksgiving(year));
        days.add(observed(LocalDate.of(year, 12, 25)));
        return Set.copyOf(days);
    }

    /** 고정 날짜 휴일의 관측일: 토요일이면 전날 금요일, 일요일이면 다음 월요일. */
    private static LocalDate observed(LocalDate day) {
        return switch (day.getDayOfWeek()) {
            case SATURDAY -> day.minusDays(1);
            case SUNDAY -> day.plusDays(1);
            default -> day;
        };
    }

    private static LocalDate thanksgiving(int year) {
        return nthWeekday(year, Month.NOVEMBER, DayOfWeek.THURSDAY, 4);
    }

    private static LocalDate nthWeekday(int year, Month month, DayOfWeek weekday, int n) {
        return LocalDate.of(year, month, 1).with(TemporalAdjusters.dayOfWeekInMonth(n, weekday));
    }

    private static LocalDate lastWeekday(int year, Month month, DayOfWeek weekday) {
        return LocalDate.of(year, month, 1).with(TemporalAdjusters.lastInMonth(weekday));
    }

    /** 부활절 일요일(Anonymous Gregorian algorithm) — 화면의 easterSunday와 같은 식입니다. */
    private static LocalDate easterSunday(int year) {
        int a = year % 19;
        int b = year / 100;
        int c = year % 100;
        int d = b / 4;
        int e = b % 4;
        int f = (b + 8) / 25;
        int g = (b - f + 1) / 3;
        int h = (19 * a + b - d - g + 15) % 30;
        int i = c / 4;
        int k = c % 4;
        int l = (32 + 2 * e + 2 * i - h - k) % 7;
        int m = (a + 11 * h + 22 * l) / 451;
        int month = (h + l - 7 * m + 114) / 31;
        int day = ((h + l - 7 * m + 114) % 31) + 1;
        return LocalDate.of(year, month, day);
    }

    private static boolean isWeekend(LocalDate d) {
        DayOfWeek w = d.getDayOfWeek();
        return w == DayOfWeek.SATURDAY || w == DayOfWeek.SUNDAY;
    }

    private static LocalDate quarterEndOnOrBefore(LocalDate d) {
        int quarterEndMonth = ((d.getMonthValue() - 1) / 3) * 3 + 3;
        LocalDate end = LocalDate.of(d.getYear(), quarterEndMonth, 1).with(TemporalAdjusters.lastDayOfMonth());
        return end.isAfter(d) ? previousQuarterEnd(end) : end;
    }

    private static LocalDate previousQuarterEnd(LocalDate quarterEnd) {
        return quarterEnd.minusMonths(3).with(TemporalAdjusters.lastDayOfMonth());
    }

    /**
     * {@link #CALENDAR}의 구현. 안에서 이름만 부르면 같은 이름의 인터페이스 메서드(자기 자신)로 풀려 끝없이 돌므로 모두
     * {@code UsMarketCalendar.}를 붙여 정적 함수를 부릅니다.
     */
    private static final class Adapter implements TradingCalendar {

        @Override
        public ZoneId zone() {
            return NEW_YORK;
        }

        @Override
        public boolean isHoliday(LocalDate d) {
            return UsMarketCalendar.isHoliday(d);
        }

        @Override
        public boolean isTradingDay(LocalDate d) {
            return UsMarketCalendar.isTradingDay(d);
        }

        @Override
        public boolean isEarlyClose(LocalDate d) {
            return UsMarketCalendar.isEarlyClose(d);
        }

        @Override
        public Instant openInstant(LocalDate tradingDate) {
            return UsMarketCalendar.openInstant(tradingDate);
        }

        @Override
        public Instant closeInstant(LocalDate tradingDate) {
            return UsMarketCalendar.closeInstant(tradingDate);
        }

        @Override
        public LocalDate nextTradingDay(LocalDate d) {
            return UsMarketCalendar.nextTradingDay(d);
        }

        @Override
        public LocalDate previousTradingDay(LocalDate d) {
            return UsMarketCalendar.previousTradingDay(d);
        }

        @Override
        public LocalDate addTradingDays(LocalDate d, int n) {
            return UsMarketCalendar.addTradingDays(d, n);
        }

        @Override
        public int tradingDaysBetween(LocalDate from, LocalDate to) {
            return UsMarketCalendar.tradingDaysBetween(from, to);
        }

        @Override
        public LocalDate lastCompletedSession(Instant now) {
            return UsMarketCalendar.lastCompletedSession(now);
        }

        @Override
        public LocalDate currentOrLastSession(Instant now) {
            return UsMarketCalendar.currentOrLastSession(now);
        }

        @Override
        public String toString() {
            return "UsMarketCalendar.CALENDAR";
        }
    }
}
