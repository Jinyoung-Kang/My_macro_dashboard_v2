package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 거래일 달력 인터페이스와 미국 어댑터(2단계 명세 §9 A1). 미국 숫자가 바뀌지 않았다는 근거라 2015~2030 <b>모든 날</b>을 정적 함수와
 * 대조합니다 — 하나라도 다르면 실패 메시지에 처음 몇 건을 보입니다.
 *
 * <p>두 갈래를 봅니다: ① {@link UsMarketCalendar#CALENDAR}가 정적 함수와 같은지(지금 미국 경로) ② 인터페이스의 기본 메서드를 미국
 * 규칙 위에 올렸을 때도 같은지(한국 달력이 물려받을 식 — 거래일 판정·개장/마감만 미국에서 빌리고 나머지는 기본 메서드로 셈).
 */
class TradingCalendarTest {

    private static final LocalDate FROM = LocalDate.of(2015, 1, 1);
    private static final LocalDate UNTIL = LocalDate.of(2030, 12, 31);
    private static final int[] ADD = {0, 1, 3, 20};
    private static final int[] SPAN = {-1, 0, 1, 2, 7, 30, 400};

    /** 거래일 판정·개장/마감·시간대만 미국 어댑터에서 빌리고 나머지는 인터페이스 기본 메서드로 세는 달력. */
    private static final TradingCalendar DEFAULTS_ON_US = new TradingCalendar() {
        @Override
        public ZoneId zone() {
            return UsMarketCalendar.CALENDAR.zone();
        }

        @Override
        public boolean isHoliday(LocalDate d) {
            return UsMarketCalendar.CALENDAR.isHoliday(d);
        }

        @Override
        public boolean isTradingDay(LocalDate d) {
            return UsMarketCalendar.CALENDAR.isTradingDay(d);
        }

        @Override
        public boolean isEarlyClose(LocalDate d) {
            return UsMarketCalendar.CALENDAR.isEarlyClose(d);
        }

        @Override
        public Instant openInstant(LocalDate tradingDate) {
            return UsMarketCalendar.CALENDAR.openInstant(tradingDate);
        }

        @Override
        public Instant closeInstant(LocalDate tradingDate) {
            return UsMarketCalendar.CALENDAR.closeInstant(tradingDate);
        }
    };

    /** 다른 값을 모아 둡니다(수십만 번의 단언 대신 끝에 한 번 — 실패하면 처음 20건). */
    private static final class Mismatches {
        private final List<String> found = new ArrayList<>();
        private int count;

        void check(String what, Object expected, Object actual) {
            if (!Objects.equals(expected, actual)) {
                count++;
                if (found.size() < 20) {
                    found.add(what + ": 정적 " + expected + " ≠ 달력 " + actual);
                }
            }
        }

        void assertNone(String label) {
            assertThat(found).as("%s — 다른 값 %d건", label, count).isEmpty();
        }
    }

    /** 날짜 함수(판정·다음·직전·n거래일 뒤·구간 거래일 수·마감 순간)를 모든 날에서 정적 함수와 대조합니다. */
    private static void compareDates(TradingCalendar calendar, Mismatches m) {
        for (LocalDate day = FROM; !day.isAfter(UNTIL); day = day.plusDays(1)) {
            m.check("isHoliday " + day, UsMarketCalendar.isHoliday(day), calendar.isHoliday(day));
            m.check("isTradingDay " + day, UsMarketCalendar.isTradingDay(day), calendar.isTradingDay(day));
            m.check("isEarlyClose " + day, UsMarketCalendar.isEarlyClose(day), calendar.isEarlyClose(day));
            m.check("closeInstant " + day, UsMarketCalendar.closeInstant(day), calendar.closeInstant(day));
            m.check("nextTradingDay " + day, UsMarketCalendar.nextTradingDay(day), calendar.nextTradingDay(day));
            m.check("previousTradingDay " + day, UsMarketCalendar.previousTradingDay(day),
                    calendar.previousTradingDay(day));
            for (int n : ADD) {
                m.check("addTradingDays " + day + " + " + n, UsMarketCalendar.addTradingDays(day, n),
                        calendar.addTradingDays(day, n));
            }
            for (int span : SPAN) {
                LocalDate to = day.plusDays(span);
                m.check("tradingDaysBetween " + day + " → " + to, UsMarketCalendar.tradingDaysBetween(day, to),
                        calendar.tradingDaysBetween(day, to));
            }
        }
    }

    /**
     * 최근 세션 두 함수를 모든 날의 정각(UTC 매시)과 개장·마감 순간 앞뒤 1초에서 대조합니다 — 서머타임 전환·조기 폐장·휴장일 경계가
     * 모두 이 안에 듭니다.
     */
    private static void compareSessions(TradingCalendar calendar, Mismatches m) {
        for (LocalDate day = FROM; !day.isAfter(UNTIL); day = day.plusDays(1)) {
            List<Instant> moments = new ArrayList<>();
            Instant midnight = day.atStartOfDay().toInstant(ZoneOffset.UTC);
            for (int hour = 0; hour < 24; hour++) {
                moments.add(midnight.plus(Duration.ofHours(hour)));
            }
            Instant open = ZonedDateTime.of(day, LocalTime.of(9, 30), UsMarketCalendar.NEW_YORK).toInstant();
            Instant close = UsMarketCalendar.closeInstant(day);
            for (Instant edge : List.of(open, close)) {
                moments.add(edge.minusSeconds(1));
                moments.add(edge);
                moments.add(edge.plusSeconds(1));
            }
            for (Instant now : moments) {
                m.check("lastCompletedSession " + now, UsMarketCalendar.lastCompletedSession(now),
                        calendar.lastCompletedSession(now));
                m.check("currentOrLastSession " + now, UsMarketCalendar.currentOrLastSession(now),
                        calendar.currentOrLastSession(now));
            }
        }
    }

    @Test
    @DisplayName("미국 어댑터 = 정적 함수 — 2015~2030 모든 날의 판정·다음·직전·n거래일 뒤·구간 거래일 수·마감 순간")
    void adapterMatchesStaticDates() {
        Mismatches m = new Mismatches();
        compareDates(UsMarketCalendar.CALENDAR, m);
        m.assertNone("어댑터 날짜 함수");
    }

    @Test
    @DisplayName("미국 어댑터 = 정적 함수 — 2015~2030 매시·개장/마감 앞뒤 1초의 최근 세션")
    void adapterMatchesStaticSessions() {
        Mismatches m = new Mismatches();
        compareSessions(UsMarketCalendar.CALENDAR, m);
        m.assertNone("어댑터 세션 함수");
    }

    @Test
    @DisplayName("기본 메서드를 미국 규칙에 올려도 정적 함수와 같다 — 2015~2030 모든 날·매시")
    void defaultMethodsMatchStaticFunctions() {
        Mismatches m = new Mismatches();
        compareDates(DEFAULTS_ON_US, m);
        compareSessions(DEFAULTS_ON_US, m);
        m.assertNone("기본 메서드");
    }

    @Test
    @DisplayName("개장 순간 = 뉴욕 09:30 — EDT 13:30Z, EST 14:30Z, 2015~2030 모든 날")
    void openInstantIsNineThirtyNewYork() {
        assertThat(UsMarketCalendar.CALENDAR.openInstant(LocalDate.of(2026, 10, 30)))
                .isEqualTo(Instant.parse("2026-10-30T13:30:00Z"));
        assertThat(UsMarketCalendar.CALENDAR.openInstant(LocalDate.of(2026, 11, 2)))
                .isEqualTo(Instant.parse("2026-11-02T14:30:00Z"));
        Mismatches m = new Mismatches();
        for (LocalDate day = FROM; !day.isAfter(UNTIL); day = day.plusDays(1)) {
            m.check("openInstant " + day,
                    ZonedDateTime.of(day, LocalTime.of(9, 30), UsMarketCalendar.NEW_YORK).toInstant(),
                    UsMarketCalendar.CALENDAR.openInstant(day));
        }
        m.assertNone("개장 순간");
    }

    /** 시험용 — 서울 시간대, from~until(양 끝 포함) 휴장, 그 밖의 평일은 거래일. until이 null이면 from부터 끝까지 휴장. */
    private static TradingCalendar closedFrom(LocalDate from, LocalDate until) {
        return new TradingCalendar() {
            @Override
            public ZoneId zone() {
                return ZoneId.of("Asia/Seoul");
            }

            @Override
            public boolean isHoliday(LocalDate d) {
                return d.getDayOfWeek().getValue() <= 5 && !isTradingDay(d);
            }

            @Override
            public boolean isTradingDay(LocalDate d) {
                boolean closed = !d.isBefore(from) && (until == null || !d.isAfter(until));
                return !closed && d.getDayOfWeek().getValue() <= 5;
            }

            @Override
            public boolean isEarlyClose(LocalDate d) {
                return false;
            }

            @Override
            public Instant openInstant(LocalDate tradingDate) {
                return ZonedDateTime.of(tradingDate, LocalTime.of(9, 0), zone()).toInstant();
            }

            @Override
            public Instant closeInstant(LocalDate tradingDate) {
                return ZonedDateTime.of(tradingDate, LocalTime.of(15, 30), zone()).toInstant();
            }
        };
    }

    @Test
    @DisplayName("기본 메서드는 끝없이 돌지 않는다 — 모르는 날을 휴장으로 답하는 달력은 31일 넘게 거래일이 없으면 IllegalStateException, 31일 휴장까지는 건너뜀")
    void defaultMethodsAreBounded() {
        LocalDate start = LocalDate.of(2028, 1, 1);   // 토요일 — 이날부터 영영 휴장(목록 없는 해를 휴장으로 답한 구현)
        TradingCalendar forever = closedFrom(start, null);
        Duration limit = Duration.ofSeconds(5);
        org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(limit, () -> {
            assertThatThrownBy(() -> forever.nextTradingDay(LocalDate.of(2027, 12, 31)))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("2027-12-31 뒤 31일 안에 거래일이 없습니다");
            assertThatThrownBy(() -> forever.addTradingDays(LocalDate.of(2027, 12, 30), 3))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> forever.lastCompletedSession(Instant.parse("2028-03-01T00:00:00Z")))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("앞 31일 안에 거래일이 없습니다");
        });
        assertThat(forever.nextTradingDay(LocalDate.of(2027, 12, 30))).as("모르는 해 전 날은 그대로").isEqualTo(
                LocalDate.of(2027, 12, 31));

        // 휴장이 딱 31일(1-1 ~ 1-31)이고 2-1(화)부터 다시 열면 건너뜀 — 경계는 넘지 않음
        TradingCalendar longClosure = closedFrom(LocalDate.of(2030, 1, 1), LocalDate.of(2030, 1, 31));
        assertThat(longClosure.nextTradingDay(LocalDate.of(2029, 12, 31))).isEqualTo(LocalDate.of(2030, 2, 1));
        assertThat(longClosure.previousTradingDay(LocalDate.of(2030, 2, 1))).isEqualTo(LocalDate.of(2029, 12, 31));
    }

    @Test
    @DisplayName("시간대는 뉴욕, 음수 거래일 수는 정적 함수와 같은 말로 거절(어댑터·기본 메서드 모두)")
    void zoneAndNegativeDays() {
        assertThat(UsMarketCalendar.CALENDAR.zone()).isEqualTo(UsMarketCalendar.NEW_YORK);
        assertThat(UsMarketCalendar.CALENDAR).hasToString("UsMarketCalendar.CALENDAR");
        LocalDate day = LocalDate.of(2026, 10, 23);
        assertThatThrownBy(() -> UsMarketCalendar.CALENDAR.addTradingDays(day, -1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("거래일 수는 0 이상이어야 합니다: -1");
        assertThatThrownBy(() -> DEFAULTS_ON_US.addTradingDays(day, -1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("거래일 수는 0 이상이어야 합니다: -1");
    }
}
