package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 장중 판단 패킷({@link KrCheckpointPacket}의 자유 시점 판 칸 — ADR 0027 결정 3)의 남은 시점: 장중 시장가는 끈 판 장중 확인과 같은 규칙
 * ({@link KrTimedLadder#closedTimings}), 분 단위 지정 시각은 그 세션의 받는 범위(09:10~15:14 KST — 개장 10분 뒤부터 종가 단일가 시작 5분 전 앞까지, ADR 0050)
 * 안에서 지금 + 60초 뒤의 분부터. 그날 종가는 받지 않습니다. 패킷 조립은
 * 작업 시험({@code KrStartTest})이 봅니다.
 *
 * <p>세션 E = 2026-12-02(수), 기준 거래일 d = 12-01.
 */
class KrIntradayPacketTest {

    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final LocalDate D = LocalDate.of(2026, 12, 1);
    private static final LocalDate E = LocalDate.of(2026, 12, 2);

    private static Instant kst(String time) {
        return Instant.parse("2026-12-02T" + time + ":00+09:00");
    }

    @Test
    @DisplayName("남은 지정 시각: 장중에는 지금 + 60초 뒤의 다음 분 ~ 15:14, 개장 전·개장 직후에는 09:10부터, 종가 단일가 시작 5분 전(15:15)부터는 없음")
    void remainingMinutes() {
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("09:14"))).containsExactly(kst("09:16"), kst("15:14"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("08:30"))).as("개장 전 — 첫 분은 개장 10분 뒤").containsExactly(kst("09:10"),
                kst("15:14"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("09:02"))).as("09:04는 받는 범위 앞 — 09:10부터").containsExactly(kst("09:10"),
                kst("15:14"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("15:12"))).as("15:12 + 60초 → 15:14").containsExactly(kst("15:14"), kst("15:14"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("15:13"))).as("15:15부터는 받지 않음(ADR 0050)").isNull();
        assertThat(KrCheckpointPacket.freeMinutes(LocalDate.of(2026, 12, 5), KR, kst("10:00"))).as("토요일").isNull();
    }

    @Test
    @DisplayName("패킷 1_basis.atMinute의 첫 분은 검증(FreeTiming.validation)이 받고 그 1분 앞은 LATE_FOR_TIMING — 장중 시장가 기준 분은 그보다 1분 앞(ADR 0044)")
    void freeMinutesFirstIsAcceptedByTheValidator() {
        List<String> timings = FreeTiming.INTRADAY_TIMINGS;
        Map<String, String> names = new java.util.LinkedHashMap<>();
        Map<String, Integer> ranks = new java.util.LinkedHashMap<>();
        timings.forEach(t -> {
            names.put(t, t);
            ranks.put(t, ranks.size());
        });
        com.macrodash.analytics.OrderValidator.Market base = new com.macrodash.analytics.OrderValidator.Market(timings, timings.get(0),
                names, KrPaperMarket.INSTANCE.money(), ranks);
        for (Instant now : List.of(kst("09:14"), Instant.parse("2026-12-02T10:31:20+09:00"), Instant.parse("2026-12-02T11:59:59.999999+09:00"),
                Instant.parse("2026-12-02T13:10:42+09:00"), Instant.parse("2026-12-02T15:11:30+09:00"))) {
            Instant[] minutes = KrCheckpointPacket.freeMinutes(E, KR, now);
            java.time.LocalTime first = minutes[0].atZone(KrxCalendar.SEOUL).toLocalTime();
            java.time.LocalTime before = first.minusMinutes(1);
            com.macrodash.analytics.OrderValidator.Market market = FreeTiming.validation(base, List.of(before, first), E, now, KR, true, true);
            assertThat(market.closed()).as(now + " 첫 분 " + first).doesNotContainKey(FreeTiming.key(first));
            assertThat(market.closed().get(FreeTiming.key(before)).reason()).as(now + " 그 1분 앞")
                    .isEqualTo(com.macrodash.analytics.OrderValidator.LATE_FOR_TIMING);
            assertThat(ExecutionAudit.marketTarget(now)).as("장중 시장가 기준 분은 첫 분보다 1분 앞").isEqualTo(minutes[0].minusSeconds(60));
        }
    }

    @Test
    @DisplayName("남은 시점: 장중에는 장중 시장가·지정 시각 둘(그날 종가는 받지 않음 — ADR 0050), 개장 10분 전에는 장중 시장가 없음, 15:13부터는 지정 시각이 닫히고 "
            + "종가 단일가 시간(기준 분 15:20)부터는 장중 시장가도 닫힘, 휴장일에는 없음")
    void remainingTimings() {
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("09:14"))).containsExactly("MARKET", "AT_MINUTE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("14:55"))).containsExactly("MARKET", "AT_MINUTE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("15:13"))).as("지정 시각은 15:14까지라 남은 분 없음 — 장중 시장가만")
                .containsExactly("MARKET");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("15:19"))).as("기준 분 15:20 — 종가 단일가 시간").isEmpty();
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, LocalDate.of(2026, 12, 5), KR, kst("10:00"))).isEmpty();
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("09:05"))).as("기준 분 09:06 — 개장 10분 뒤(09:10) 앞이라 시장가 없음")
                .containsExactly("AT_MINUTE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, Instant.parse("2026-12-02T09:09:30+09:00"))).as("기준 분 09:10부터")
                .containsExactly("MARKET", "AT_MINUTE");
    }
}
