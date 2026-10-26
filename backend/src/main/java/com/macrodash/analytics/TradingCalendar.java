package com.macrodash.analytics;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * 🧪 거래일 달력 — 모의 매매 장부가 '세션 날짜'로 체결·만료·재진입 금지·통계 표본을 세는 규칙의 시장 중립 모양
 * (2단계 명세 2026-10-26-v2-kr-paper-spec.md §9 A1).
 *
 * <p>구현은 시장마다 하나입니다. 미국은 {@link UsMarketCalendar#CALENDAR}(정적 함수를 그대로 부르는 어댑터)이고, 한국 달력은
 * 공휴일 집합을 받아 만드는 순수 클래스로 따로 둡니다(명세 §4-4 — 이 패키지는 {@code java.*}만 써서 DB를 읽지 못함).
 *
 * <p>구현이 정하는 것은 거래일 판정·개장/마감 순간·시간대뿐이고, 나머지(다음·직전 거래일, n거래일 뒤, 구간 거래일 수, 최근 세션)는
 * 아래 기본 메서드가 {@link #isTradingDay}로 셉니다. 기본 메서드는 {@link UsMarketCalendar}의 같은 이름 정적 함수와 같은 식이고,
 * 미국 규칙에 올려 2015~2030 모든 날에서 결과가 같음을 시험이 확인합니다({@code TradingCalendarTest}).
 *
 * <p>날짜는 전부 {@link #zone} 기준 세션 날짜입니다. 기본 메서드 {@link #lastCompletedSession}·{@link #currentOrLastSession}은
 * 세션의 개장·마감이 그 세션 날짜(현지) 안에 있다고 가정합니다 — 직전 거래일의 마감이 오늘(현지) 0시보다 앞이라 한 번 물러서면 충분.
 */
public interface TradingCalendar {

    /** 세션 날짜를 정하는 시간대(미국은 뉴욕). */
    ZoneId zone();

    /** 평일 중 정규장 휴장일인지. 주말은 false입니다(휴장일 목록은 평일만 담음) — 거래일 판정은 {@link #isTradingDay}. */
    boolean isHoliday(LocalDate d);

    /** 정규장이 열리는 날인지. */
    boolean isTradingDay(LocalDate d);

    /** 조기 폐장일인지(그날이 거래일일 때만 true). */
    boolean isEarlyClose(LocalDate d);

    /** 그 거래일 정규장 시작 순간. 휴장일·주말을 넣었을 때의 값은 의미가 없습니다(호출부가 거래일인지 먼저 확인). */
    Instant openInstant(LocalDate tradingDate);

    /** 그 거래일 정규장 마감 순간(조기 폐장 반영). 휴장일·주말을 넣었을 때의 값은 의미가 없습니다. */
    Instant closeInstant(LocalDate tradingDate);

    /** d 다음(엄격히 뒤) 거래일. d가 거래일이어도 d는 돌려주지 않습니다. */
    default LocalDate nextTradingDay(LocalDate d) {
        LocalDate next = d.plusDays(1);
        while (!isTradingDay(next)) {
            next = next.plusDays(1);
        }
        return next;
    }

    /** d 전(엄격히 앞) 거래일. */
    default LocalDate previousTradingDay(LocalDate d) {
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
    default LocalDate addTradingDays(LocalDate d, int n) {
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
    default int tradingDaysBetween(LocalDate from, LocalDate to) {
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

    /** now 시점에 마감이 끝난 가장 최근 세션(마감 순간 ≤ now). 마감 그 순간은 '끝남'으로 봅니다. */
    default LocalDate lastCompletedSession(Instant now) {
        LocalDate today = now.atZone(zone()).toLocalDate();
        if (isTradingDay(today) && !closeInstant(today).isAfter(now)) {
            return today;
        }
        return previousTradingDay(today);
    }

    /**
     * now가 속한(또는 직전) 세션 날짜 — 장중·장 마감 뒤면 오늘, 장 시작 전·주말·휴장일이면 직전 거래일.
     * now 이전에 시작한(개장 순간 ≤ now) 세션 중 가장 최근입니다.
     */
    default LocalDate currentOrLastSession(Instant now) {
        LocalDate today = now.atZone(zone()).toLocalDate();
        if (isTradingDay(today) && !openInstant(today).isAfter(now)) {
            return today;
        }
        return previousTradingDay(today);
    }
}
