package com.macrodash.analytics;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Locale;

/**
 * 정규장 안 장중 창의 단일 출처 — 개장 뒤 장중 체결이 시작되는 간격({@link #OPEN_OFFSET})과 장 끝 여유(미국 장중 시장가를 받는 끝
 * {@link #US_MARKET_TAIL}, 한국 종가 단일가 {@link #KR_CLOSING_AUCTION}). 모의 매매의 분 단위 지정 시각(ADR 0027 결정 1)·규칙 계좌의 체결 시각
 * 설정 범위·화면 설정 설명이 이 값을 읽고, 다른 기능(실제 매매·장중 스탑 감시)도 같은 값을 보도록 {@code analytics}에 둡니다(그 기능들이 쓸 수 있는 패키지).
 *
 * <p>창은 그 세션의 달력으로 셉니다 — 조기 폐장·장 시간 변경일(수능일 등)은 그날의 개장·마감에서 같은 간격입니다({@link #first}·{@link #end}).
 * 보통 날의 현지 시각({@link #regularFirst}·{@link #regularLast})은 저장할 때의 범위 검사와 설명 글에만 씁니다. 상태가 없는 계산이고 {@code java.*}만 씁니다.
 */
public final class SessionWindows {

    private SessionWindows() {
    }

    /** 개장 뒤 이만큼 지나야 장중 체결 시각을 받습니다 — 그 세션의 첫 분은 개장 + 이 값(개장 순간은 시가 단일가의 몫). */
    public static final Duration OPEN_OFFSET = Duration.ofMinutes(1);
    /** 미국 장중 시장가·지정 시각을 받는 끝 — 마감 이만큼 전부터는 받지 않습니다(보통 날 15:55 ET·조기 폐장일 12:55 ET). */
    public static final Duration US_MARKET_TAIL = Duration.ofMinutes(5);
    /** 한국 종가 단일가 시간 — 정규장 마감 이만큼 전부터(보통 날 15:20~15:30 KST). 장중 지정 시각은 그 앞까지입니다. */
    public static final Duration KR_CLOSING_AUCTION = Duration.ofMinutes(10);

    /** 그 시장의 장 끝 여유 — 미국 {@link #US_MARKET_TAIL}, 한국 {@link #KR_CLOSING_AUCTION}. */
    public static Duration tail(boolean korea) {
        return korea ? KR_CLOSING_AUCTION : US_MARKET_TAIL;
    }

    /** 그 세션의 장중 첫 분 — 그날 개장 + {@link #OPEN_OFFSET}(조기 폐장·장 시간 변경일도 그날 개장 기준). */
    public static Instant first(TradingCalendar calendar, LocalDate session) {
        return calendar.openInstant(session).plus(OPEN_OFFSET);
    }

    /** 그 세션에서 이 순간부터는 장중 시각을 받지 않음 — 그날 마감 − 장 끝 여유({@link #tail}). */
    public static Instant end(TradingCalendar calendar, LocalDate session, boolean korea) {
        return calendar.closeInstant(session).minus(tail(korea));
    }

    /** 그 세션 장중 첫 분의 현지 시각(그 시장 시간대). */
    public static LocalTime firstLocal(TradingCalendar calendar, LocalDate session) {
        return first(calendar, session).atZone(calendar.zone()).toLocalTime();
    }

    /** 보통 날(정규 개장)의 장중 첫 분 — 미국 09:30 ET, 한국 09:00 KST에 {@link #OPEN_OFFSET}을 더한 현지 시각. */
    public static LocalTime regularFirst(boolean korea) {
        return (korea ? KrxCalendar.OPEN : UsMarketCalendar.OPEN).plus(OPEN_OFFSET);
    }

    /** 보통 날(정규 마감)의 장중 마지막 분 — 마감 − 장 끝 여유 − 1분(미국 15:54 ET, 한국 15:19 KST). */
    public static LocalTime regularLast(boolean korea) {
        return (korea ? KrxCalendar.CLOSE : UsMarketCalendar.REGULAR_CLOSE).minus(tail(korea)).minusMinutes(1);
    }

    /** 보통 날의 장중 범위 글 — 'HH:MM~HH:MM'(양 끝 포함, ASCII 숫자 — JVM 로캘과 무관). */
    public static String regularRange(boolean korea) {
        return clock(regularFirst(korea)) + "~" + clock(regularLast(korea));
    }

    private static String clock(LocalTime at) {
        return String.format(Locale.ROOT, "%02d:%02d", at.getHour(), at.getMinute());
    }
}
