package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

class TrailingStopTest {

    @Test
    @DisplayName("최고가는 올라가기만 한다")
    void watermarkOnlyRises() {
        assertThat(TrailingStop.raiseWatermark(100.0, 105.0)).isEqualTo(105.0);
        assertThat(TrailingStop.raiseWatermark(100.0, 95.0)).isEqualTo(100.0);
        assertThatThrownBy(() -> TrailingStop.raiseWatermark(100.0, Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("스탑가 = 최고가 × (1 − 8%), 스탑가와 같으면 발동")
    void stopPriceAndTrigger() {
        assertThat(TrailingStop.stopPrice(100.0, 8)).isCloseTo(92.0, within(1e-9));
        assertThat(TrailingStop.stopPrice(250.0, 8)).isCloseTo(230.0, within(1e-9));

        assertThat(TrailingStop.triggered(100.0, 92.0, 8)).isTrue();
        assertThat(TrailingStop.triggered(100.0, 92.01, 8)).isFalse();
        assertThat(TrailingStop.triggered(100.0, 80.0, 8)).isTrue();
    }

    @Test
    @DisplayName("진입 100 → 110 고점 → 101.3은 버팀, 101.2(= 110 × 0.92)에서 발동")
    void followsTheHigh() {
        double watermark = 100.0;   // 체결가
        watermark = TrailingStop.raiseWatermark(watermark, 110.0);
        // 처음 기준(100 × 0.92 = 92)이 아니라 올라간 최고가 기준
        assertThat(TrailingStop.stopPrice(watermark, 8)).isCloseTo(101.2, within(1e-9));

        watermark = TrailingStop.raiseWatermark(watermark, 101.3);
        assertThat(watermark).isEqualTo(110.0);
        assertThat(TrailingStop.triggered(watermark, 101.3, 8)).isFalse();
        assertThat(TrailingStop.triggered(watermark, 101.2, 8)).isTrue();
    }

    @Test
    @DisplayName("스탑 비율이 0 이하·100 이상이면 거절")
    void rejectsBadPercent() {
        assertThatThrownBy(() -> TrailingStop.stopPrice(100.0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TrailingStop.stopPrice(100.0, -8)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TrailingStop.triggered(100.0, 50.0, 100)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("재진입 금지: 관측일 + 20거래일까지(포함), 휴장일은 세지 않음")
    void lockout() {
        LocalDate until = TrailingStop.lockoutUntil(LocalDate.of(2026, 10, 23), 20);
        assertThat(until).isEqualTo(LocalDate.of(2026, 11, 20));

        assertThat(TrailingStop.lockedOut(until, LocalDate.of(2026, 10, 23))).isTrue();
        assertThat(TrailingStop.lockedOut(until, LocalDate.of(2026, 11, 20))).isTrue();    // 마지막 날 포함
        assertThat(TrailingStop.lockedOut(until, LocalDate.of(2026, 11, 23))).isFalse();   // 다음 거래일부터 매수 가능
        assertThat(TrailingStop.lockedOut(null, LocalDate.of(2026, 11, 1))).isFalse();

        // 추수감사절(11-26)을 건너뜀: 11-23(1) 24(2) 25(3) 27(4) 30(5)
        assertThat(TrailingStop.lockoutUntil(LocalDate.of(2026, 11, 20), 5)).isEqualTo(LocalDate.of(2026, 11, 30));
    }

    @Test
    @DisplayName("달력을 받는 판 — 미국 달력이면 옛 시그니처와 같고, 다른 달력이면 그 달력의 거래일로 센다")
    void lockoutWithCalendar() {
        LocalDate observed = LocalDate.of(2026, 11, 20);
        assertThat(TrailingStop.lockoutUntil(UsMarketCalendar.CALENDAR, observed, 5))
                .isEqualTo(TrailingStop.lockoutUntil(observed, 5))
                .isEqualTo(LocalDate.of(2026, 11, 30));
        // 휴장일 없는 시험 달력: 11-23(1) 24(2) 25(3) 26(4 — 미국 추수감사절도 셈) 27(5)
        assertThat(TrailingStop.lockoutUntil(WeekdaysCalendar.INSTANCE, observed, 5))
                .isEqualTo(LocalDate.of(2026, 11, 27));
        assertThatThrownBy(() -> TrailingStop.lockoutUntil(null, observed, 5))
                .isInstanceOf(NullPointerException.class);
    }
}
