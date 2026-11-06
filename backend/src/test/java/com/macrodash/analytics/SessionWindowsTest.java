package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 창의 단일 출처({@link SessionWindows}) — 개장 뒤 간격·장 끝 여유를 그 세션의 달력으로 셉니다(보통 날·미국 조기 폐장일·한국 장 시간 변경일).
 * 개장 뒤 간격은 사용자 결정(2026-11-06 — ADR 0031)으로 10분이고, 장 끝 여유는 이 상수가 생기기 전 모의 매매 코드의 값과 같습니다(미국 마감 5분 전, 한국
 * 종가 단일가 10분).
 */
class SessionWindowsTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    /** 2026-11-19 수능일 — 개장 10:00·마감 16:30(설정 kr.calendar.openTimeOverrides의 모양). */
    private static final LocalDate KR_SAT_EXAM = LocalDate.of(2026, 11, 19);
    private static final TradingCalendar KR = new KrxCalendar(Map.of(2026, List.of(LocalDate.of(2026, 1, 1))), List.of(),
            Map.of(KR_SAT_EXAM, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
    private static final LocalDate US_TUE = LocalDate.of(2026, 11, 10);
    /** 추수감사절 다음 날 — 미국 조기 폐장(13:00 ET). */
    private static final LocalDate US_EARLY = LocalDate.of(2026, 11, 27);
    private static final LocalDate KR_TUE = LocalDate.of(2026, 11, 10);

    @Test
    @DisplayName("상수 — 개장 뒤 10분(ADR 0031), 미국 장 끝 여유 5분, 한국 종가 단일가 10분")
    void constants() {
        assertThat(SessionWindows.OPEN_OFFSET).isEqualTo(Duration.ofMinutes(10));
        assertThat(SessionWindows.tail(false)).isEqualTo(SessionWindows.US_MARKET_TAIL).isEqualTo(Duration.ofMinutes(5));
        assertThat(SessionWindows.tail(true)).isEqualTo(SessionWindows.KR_CLOSING_AUCTION).isEqualTo(Duration.ofMinutes(10));
    }

    @Test
    @DisplayName("보통 날 — 미국 09:40~15:54 ET, 한국 09:10~15:19 KST(첫 분·끝은 그 세션 달력의 개장·마감에서)")
    void regularDays() {
        assertThat(SessionWindows.first(US, US_TUE)).isEqualTo(Instant.parse("2026-11-10T14:40:00Z"));
        assertThat(SessionWindows.end(US, US_TUE, false)).isEqualTo(Instant.parse("2026-11-10T20:55:00Z"));
        assertThat(SessionWindows.firstLocal(US, US_TUE)).isEqualTo(LocalTime.of(9, 40));
        assertThat(SessionWindows.first(KR, KR_TUE)).isEqualTo(Instant.parse("2026-11-10T00:10:00Z"));
        assertThat(SessionWindows.end(KR, KR_TUE, true)).isEqualTo(Instant.parse("2026-11-10T06:20:00Z"));
        assertThat(SessionWindows.firstLocal(KR, KR_TUE)).isEqualTo(LocalTime.of(9, 10));

        assertThat(SessionWindows.regularFirst(false)).isEqualTo(LocalTime.of(9, 40));
        assertThat(SessionWindows.regularLast(false)).isEqualTo(LocalTime.of(15, 54));
        assertThat(SessionWindows.regularFirst(true)).isEqualTo(LocalTime.of(9, 10));
        assertThat(SessionWindows.regularLast(true)).isEqualTo(LocalTime.of(15, 19));
        assertThat(SessionWindows.regularRange(false)).isEqualTo("09:40~15:54");
        assertThat(SessionWindows.regularRange(true)).isEqualTo("09:10~15:19");
    }

    @Test
    @DisplayName("미국 조기 폐장일은 그날 마감(13:00 ET)에서 5분 전(첫 분은 09:40 그대로), 한국 장 시간 변경일(10:00~16:30)은 그날 개장 + 10분(10:10) ~ 16:20")
    void shortenedAndShiftedDays() {
        assertThat(SessionWindows.first(US, US_EARLY)).isEqualTo(Instant.parse("2026-11-27T14:40:00Z"));
        assertThat(SessionWindows.end(US, US_EARLY, false)).isEqualTo(Instant.parse("2026-11-27T17:55:00Z"));
        assertThat(SessionWindows.firstLocal(KR, KR_SAT_EXAM)).isEqualTo(LocalTime.of(10, 10));
        assertThat(SessionWindows.end(KR, KR_SAT_EXAM, true)).isEqualTo(Instant.parse("2026-11-19T07:20:00Z"));
    }
}
