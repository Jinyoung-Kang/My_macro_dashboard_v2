package com.macrodash.analytics;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/**
 * 🧪 거래일 달력 — 모의 매매 장부가 '세션 날짜'로 체결·만료·재진입 금지·통계 표본을 세는 규칙의 시장 중립 모양
 * (2단계 명세 2026-10-26-v2-kr-paper-spec.md §9 A1).
 *
 * <p>구현은 시장마다 하나입니다. 미국은 {@link UsMarketCalendar#CALENDAR}(정적 함수를 그대로 부르는 어댑터)이고, 한국 달력은
 * 공휴일 집합을 받아 만드는 순수 클래스 {@link KrxCalendar}입니다(명세 §4-4 — 이 패키지는 {@code java.*}만 써서 DB를 읽지 못함).
 *
 * <p>구현이 정하는 것은 거래일 판정·개장/마감 순간·시간대뿐이고, 나머지(다음·직전 거래일, n거래일 뒤, 구간 거래일 수, 최근 세션)는
 * 아래 기본 메서드가 {@link #isTradingDay}로 셉니다. 기본 메서드는 {@link UsMarketCalendar}의 같은 이름 정적 함수와 같은 식이고,
 * 미국 규칙에 올려 2015~2030 모든 날에서 결과가 같음을 시험이 확인합니다({@code TradingCalendarTest}).
 *
 * <p>날짜는 전부 {@link #zone} 기준 세션 날짜입니다. 기본 메서드 {@link #lastCompletedSession}·{@link #currentOrLastSession}은
 * 세션의 개장·마감이 그 세션 날짜(현지) 안에 있다고 가정합니다 — 직전 거래일의 마감이 오늘(현지) 0시보다 앞이라 한 번 물러서면 충분.
 *
 * <p><b>모르는 날</b>: 구현은 거래일인지 알 수 없는 날(예: 공휴일 목록이 없는 해 — 명세 K35 fail-closed)을 {@code false}('휴장')로
 * 답해 꾸미지 않습니다 — 추측한 휴장은 만료·재진입 금지·표본을 조용히 바꿉니다. 그런 날은 {@link CalendarUnavailableException}으로
 * 알립니다(B5 — 한국 달력 {@link KrxCalendar}). 아래 기본 메서드도 모르는 날에 닿으면 그 예외로 멈춥니다. 받는 쪽은 정기 작업이면
 * 작업 기록에 '달력 없음'으로 남기고 그 시장 실행을 멈추고, 조회면 그 계산만 null + 사유로 둡니다(명세 K35). 미국 달력은 규칙으로
 * 모든 해를 덮어 모르는 날이 없습니다.
 *
 * <p>기본 메서드의 다음·직전 거래일은 휴장이 {@value #MAX_CLOSED_RUN_DAYS}일 넘게 이어지면 끝없이 돌지 않고
 * {@link IllegalStateException}을 던집니다 — 그만큼 이어지는 휴장은 실제 시장에 없고(가장 긴 연휴도 열흘 남짓), 구현이 모르는 날을
 * 휴장으로 답했다는 뜻이라 스케줄러 스레드를 붙잡지 않게 합니다.
 */
public interface TradingCalendar {

    /** 기본 메서드가 다음·직전 거래일을 찾으며 지나칠 수 있는 연속 휴장 일수(달력일) — 넘으면 구현 오류로 봅니다(위 설명). */
    int MAX_CLOSED_RUN_DAYS = 31;

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

    /**
     * d 다음(엄격히 뒤) 거래일. d가 거래일이어도 d는 돌려주지 않습니다.
     *
     * @throws IllegalStateException d 뒤 {@value #MAX_CLOSED_RUN_DAYS}일 안에 거래일이 없음(구현 오류 — 클래스 설명)
     */
    default LocalDate nextTradingDay(LocalDate d) {
        LocalDate next = d.plusDays(1);
        for (int skipped = 0; !isTradingDay(next); skipped++) {
            if (skipped >= MAX_CLOSED_RUN_DAYS) {
                throw new IllegalStateException(d + " 뒤 " + MAX_CLOSED_RUN_DAYS + "일 안에 거래일이 없습니다 — 달력("
                        + this + ")이 모르는 날을 휴장으로 답하는지 확인하세요");
            }
            next = next.plusDays(1);
        }
        return next;
    }

    /**
     * d 전(엄격히 앞) 거래일.
     *
     * @throws IllegalStateException d 앞 {@value #MAX_CLOSED_RUN_DAYS}일 안에 거래일이 없음(구현 오류 — 클래스 설명)
     */
    default LocalDate previousTradingDay(LocalDate d) {
        LocalDate previous = d.minusDays(1);
        for (int skipped = 0; !isTradingDay(previous); skipped++) {
            if (skipped >= MAX_CLOSED_RUN_DAYS) {
                throw new IllegalStateException(d + " 앞 " + MAX_CLOSED_RUN_DAYS + "일 안에 거래일이 없습니다 — 달력("
                        + this + ")이 모르는 날을 휴장으로 답하는지 확인하세요");
            }
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
