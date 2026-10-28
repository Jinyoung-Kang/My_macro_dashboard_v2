package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 노출 맞춘 참고선(2단계 명세 §3·K40) 손계산 — ref_t = ref_{t−1} × (1 + x·r069500 + (1 − x)·r153130), x = 앞 날 규칙 계좌 주식 비중, 출발일은 0%,
 * 빈 비중·종가는 그날부터 멈춤(사유), 금융위가 아직 내지 않은 날은 그날 값 없음(멈춤 아님).
 */
class KrExposureReferenceTest {

    private static final LocalDate S = LocalDate.of(2026, 10, 29);
    private static final LocalDate D1 = LocalDate.of(2026, 10, 30);
    private static final LocalDate D2 = LocalDate.of(2026, 11, 2);
    private static final LocalDate D3 = LocalDate.of(2026, 11, 3);
    private static final List<LocalDate> DATES = List.of(S, D1, D2, D3);
    private static final BigDecimal NAV = BigDecimal.valueOf(100_000_000);

    /** 069500: 100,000 → 101,000(+1%) → 99,990(−1%) → 100,990. */
    private static final Map<LocalDate, BigDecimal> STOCK = Map.of(S, dec(100_000), D1, dec(101_000), D2, dec(99_990), D3, dec(100_990));
    /** 153130: 100,000 → 100,100(+0.1%) → 100,200 → 100,300. */
    private static final Map<LocalDate, BigDecimal> BOND = Map.of(S, dec(100_000), D1, dec(100_100), D2, dec(100_200), D3, dec(100_300));

    private static BigDecimal dec(long value) {
        return BigDecimal.valueOf(value);
    }

    @Test
    @DisplayName("손계산 3거래일: 출발일 1억(비중 0% → 다음 날은 153130만), 60%면 섞음, 마지막 날 금융위 미공개면 그날만 null(멈춤 아님)")
    void handComputedThreeDays() {
        KrExposureReference.Result result = KrExposureReference.compute(DATES, S, NAV, Map.of(D1, dec(60)), STOCK, BOND, D2);

        // D1: 1억 × (1 + 0 × 1% + 1 × 0.1%) = 100,100,000
        // D2: 100,100,000 × (1 + 0.6 × (−1%) + 0.4 × (100/100,100)) = 99,499,400 + 40,000 = 99,539,400
        assertThat(result.values()).containsExactly(100_000_000L, 100_100_000L, 99_539_400L, null);
        assertThat(result.stockWeightPct()).containsExactly(null, new BigDecimal("0.00"), new BigDecimal("60.00"), null);
        assertThat(result.asOfDate()).isEqualTo(D2);
        assertThat(result.stoppedReason()).as("D3은 금융위 공개 전 — 멈춤이 아님").isNull();
    }

    @Test
    @DisplayName("비중 0%는 153130만, 100%는 069500만 따라감")
    void edgesFollowOneEtf() {
        KrExposureReference.Result bondOnly = KrExposureReference.compute(DATES, S, NAV, Map.of(D1, dec(0), D2, dec(0)), STOCK, BOND, D3);
        assertThat(bondOnly.values()).containsExactly(100_000_000L, 100_100_000L, 100_200_000L, 100_300_000L);

        KrExposureReference.Result stockOnly = KrExposureReference.compute(List.of(S, D1, D2), S, NAV,
                Map.of(S, dec(100), D1, dec(100)), STOCK, BOND, D3);
        assertThat(stockOnly.values()).as("출발일 S는 현금만 — 결정 행의 비중과 상관없이 0%").containsExactly(100_000_000L,
                100_100_000L, 99_099_000L);
    }

    @Test
    @DisplayName("앞 날 비중을 모르면 그날부터 끝까지 null + 사유(이어 쓰지 않음)")
    void missingWeightStopsTheLine() {
        KrExposureReference.Result result = KrExposureReference.compute(DATES, S, NAV, Map.of(D2, dec(50)), STOCK, BOND, D3);

        assertThat(result.values()).containsExactly(100_000_000L, 100_100_000L, null, null);
        assertThat(result.asOfDate()).isEqualTo(D1);
        assertThat(result.stoppedReason()).startsWith("2026-10-30 규칙 계좌 주식 비중을 모릅니다");
    }

    @Test
    @DisplayName("금융위가 낸 범위 안에서 종가가 빠지면 그날부터 null + 사유, 출발일 순자산 줄이 없으면 전부 null + 사유")
    void missingCloseOrStartStopsTheLine() {
        Map<LocalDate, BigDecimal> bond = Map.of(S, dec(100_000), D2, dec(100_200), D3, dec(100_300));
        KrExposureReference.Result gap = KrExposureReference.compute(DATES, S, NAV, Map.of(D1, dec(60), D2, dec(60)), STOCK, bond, D3);
        assertThat(gap.values()).containsExactly(100_000_000L, null, null, null);
        assertThat(gap.stoppedReason()).startsWith("2026-10-30 금융위 ETF 확정 종가(153130)");
        assertThat(gap.asOfDate()).isEqualTo(S);

        KrExposureReference.Result noBase = KrExposureReference.compute(List.of(D1, D2), S, NAV, Map.of(), STOCK, BOND, D3);
        assertThat(noBase.values()).containsExactly(null, null);
        assertThat(noBase.stoppedReason()).contains("출발일(2026-10-29)의 순자산 줄이 없어");
        assertThat(KrExposureReference.compute(DATES, S, null, Map.of(), STOCK, BOND, D3).values())
                .isEqualTo(Arrays.asList(null, null, null, null));
    }

    @Test
    @DisplayName("금융위가 아무 날도 받지 않았으면 출발일 값만(멈춤 아님), 0~100% 밖 비중은 멈춤")
    void nothingPublishedAndOutOfRangeWeight() {
        KrExposureReference.Result none = KrExposureReference.compute(DATES, S, NAV, Map.of(D1, dec(60)), Map.of(), Map.of(), null);
        assertThat(none.values()).containsExactly(100_000_000L, null, null, null);
        assertThat(none.stoppedReason()).isNull();

        KrExposureReference.Result over = KrExposureReference.compute(DATES, S, NAV, Map.of(D1, dec(101)), STOCK, BOND, D3);
        assertThat(over.values()).containsExactly(100_000_000L, 100_100_000L, null, null);
        assertThat(over.stoppedReason()).contains("0~100% 밖");
    }
}
