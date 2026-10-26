package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * 시험용 달력 — 주말만 쉬고 휴장일이 없는 서울 시각 09:00~15:30 장. 실제 시장이 아닙니다(한국 달력은 공휴일을 받는 별도 클래스).
 *
 * <p>달력을 받는 분석 함수가 정말 받은 달력으로 세는지 보려고 씁니다 — 미국 휴장일(추수감사절 2026-11-26·준틴스 06-19·독립기념일
 * 대체 07-03)에 이 달력은 거래일이라 결과가 미국과 갈립니다.
 */
final class WeekdaysCalendar implements TradingCalendar {

    static final WeekdaysCalendar INSTANCE = new WeekdaysCalendar();

    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

    private WeekdaysCalendar() {
    }

    @Override
    public ZoneId zone() {
        return SEOUL;
    }

    @Override
    public boolean isHoliday(LocalDate d) {
        return false;
    }

    @Override
    public boolean isTradingDay(LocalDate d) {
        DayOfWeek w = d.getDayOfWeek();
        return w != DayOfWeek.SATURDAY && w != DayOfWeek.SUNDAY;
    }

    @Override
    public boolean isEarlyClose(LocalDate d) {
        return false;
    }

    @Override
    public Instant openInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, LocalTime.of(9, 0), SEOUL).toInstant();
    }

    @Override
    public Instant closeInstant(LocalDate tradingDate) {
        return ZonedDateTime.of(tradingDate, LocalTime.of(15, 30), SEOUL).toInstant();
    }
}
