package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 배포 설정({@code dashboard.paper.*}) — 미국 출발일·초기 현금 검사는 그대로이고, 한국 출발일({@code kr.start-date})은 기본값 없이
 * 비워 둘 수 있으며 기동 때는 형식만, 한국 초기 현금({@code kr.initial-cash})은 정수 원 1억 기본(2단계 명세 §4-13·K38, C1b).
 */
class PaperConfigTest {

    /** 스프링이 부르는 생성자(문자열 그대로) — 미국 값은 application.yml 기본값. */
    private static PaperConfig spring(String krStart, String krCash) {
        return new PaperConfig(true, "2026-10-23", 100_000, krStart, krCash);
    }

    @Test
    @DisplayName("한국 출발일이 비면(기본) 미국 기동은 그대로 — 한국은 미정(초기화·출발 막힘), 초기 현금 1억 원")
    void emptyKrStartKeepsUsBoot() {
        PaperConfig config = spring("", "100000000");
        assertThat(config.enabled()).isTrue();
        assertThat(config.startDate()).isEqualTo(LocalDate.of(2026, 10, 23));
        assertThat(config.initialCash()).isEqualTo(100_000);
        assertThat(config.krStartDate()).isNull();
        assertThat(config.krStartConfigured()).isFalse();
        assertThat(config.krInitialCash()).isEqualByComparingTo("100000000");
        assertThat(spring("   ", "100000000").krStartDate()).as("공백만 = 비어 있음").isNull();
        assertThat(spring(null, "100000000").krStartDate()).isNull();
        assertThat(PaperConfig.KR_START_MISSING).contains("PAPER_KR_START_DATE");

        // 미국 값만 받는 판(시험·예전 호출) = 한국 미정·1억 원.
        assertThat(new PaperConfig(true, LocalDate.of(2026, 10, 23), 100_000)).isEqualTo(
                new PaperConfig(true, LocalDate.of(2026, 10, 23), 100_000, null, PaperConfig.DEFAULT_KR_INITIAL_CASH));
        assertThat(PaperConfig.DEFAULT_KR_INITIAL_CASH).isEqualByComparingTo(BigDecimal.valueOf(100_000_000));
    }

    @Test
    @DisplayName("한국 출발일은 기동 때 형식만 — 휴장일(일요일)도 기동은 함(거래일 검사는 한국 초기화·출발 때 KrxCalendar), 형식이 틀리면 기동하지 않음")
    void krStartChecksFormatOnly() {
        PaperConfig config = spring(" 2026-11-29 ", "100000000");
        assertThat(config.krStartDate()).isEqualTo(LocalDate.of(2026, 11, 29));
        assertThat(config.krStartConfigured()).isTrue();
        for (String bad : new String[]{"2026/11/30", "2026-11-31", "20261130", "다음 주"}) {
            assertThatThrownBy(() -> spring(bad, "100000000")).as(bad).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("dashboard.paper.kr.start-date").hasMessageContaining("PAPER_KR_START_DATE");
        }
    }

    @Test
    @DisplayName("미국 출발일의 미국 거래일 검사는 미국 키에만 그대로 — 한국 값과 상관없이")
    void usTradingDayCheckStaysOnTheUsKey() {
        assertThatThrownBy(() -> new PaperConfig(true, "2026-10-24", 100_000, "2026-11-30", "100000000"))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("미국 증시 거래일");
        assertThatThrownBy(() -> new PaperConfig(true, "2026-10-23", 0, "", "100000000"))
                .hasMessageContaining("dashboard.paper.initial-cash");
    }

    @Test
    @DisplayName("한국 초기 현금 — 0보다 큰 정수 원(소수 0은 받음), 장부 금액 열의 정수 자리(10^14) 미만, 형식이 틀리면 기동하지 않음")
    void krInitialCash() {
        assertThat(spring("", "100000000.00").krInitialCash()).isEqualByComparingTo("100000000");
        assertThat(spring("", "1").krInitialCash()).isEqualByComparingTo("1");
        assertThat(spring("", "99999999999999").krInitialCash()).isEqualByComparingTo("99999999999999");
        for (String bad : new String[]{"0", "-1", "100000000.5", "100000000000000", "1e14"}) {
            assertThatThrownBy(() -> spring("", bad)).as(bad).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("dashboard.paper.kr.initial-cash는 0보다 크고");
        }
        assertThatThrownBy(() -> spring("", "1억")).hasMessageContaining("dashboard.paper.kr.initial-cash 형식");
        assertThatThrownBy(() -> new PaperConfig(true, LocalDate.of(2026, 10, 23), 100_000, null, null))
                .isInstanceOf(NullPointerException.class);
    }
}
