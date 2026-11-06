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
 * 한국 장중 판단 패킷({@link KrCheckpointPacket}의 자유 시점 판 칸 — ADR 0027 결정 3)의 남은 시점: 장중 시장가·종가는 끈 판 장중 확인과 같은 규칙
 * ({@link KrTimedLadder#closedTimings}), 분 단위 지정 시각은 그 세션의 받는 범위(09:10~15:19 KST — 개장 10분 뒤부터) 안에서 지금 + 60초 뒤의 분부터. 패킷 조립은
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
    @DisplayName("남은 지정 시각: 장중에는 지금 + 60초 뒤의 다음 분 ~ 15:19, 개장 전·개장 직후에는 09:10부터, 종가 단일가 시간(15:20)부터는 없음")
    void remainingMinutes() {
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("09:14"))).containsExactly(kst("09:16"), kst("15:19"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("08:30"))).as("개장 전 — 첫 분은 개장 10분 뒤").containsExactly(kst("09:10"),
                kst("15:19"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("09:02"))).as("09:04는 받는 범위 앞 — 09:10부터").containsExactly(kst("09:10"),
                kst("15:19"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("15:17"))).as("15:17 + 60초 → 15:19").containsExactly(kst("15:19"), kst("15:19"));
        assertThat(KrCheckpointPacket.freeMinutes(E, KR, kst("15:18"))).as("15:20은 종가 단일가 시간").isNull();
        assertThat(KrCheckpointPacket.freeMinutes(LocalDate.of(2026, 12, 5), KR, kst("10:00"))).as("토요일").isNull();
    }

    @Test
    @DisplayName("남은 시점: 장중에는 셋 모두, 개장 10분 전에는 장중 시장가 없음, 종가 단일가 시간 직전에는 장중 시장가·지정 시각이 닫히고 종가만, 휴장일에는 없음")
    void remainingTimings() {
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("09:14"))).containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("14:55"))).containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("15:18"))).as("기준 분 15:20 — 종가 단일가 시간")
                .containsExactly("NEXT_CLOSE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, LocalDate.of(2026, 12, 5), KR, kst("10:00"))).isEmpty();
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, kst("09:05"))).as("기준 분 09:07 — 개장 10분 뒤(09:10) 앞이라 시장가 없음")
                .containsExactly("AT_MINUTE", "NEXT_CLOSE");
        assertThat(KrCheckpointPacket.freeRemainingTimings(D, E, KR, Instant.parse("2026-12-02T09:08:30+09:00"))).as("기준 분 09:10부터")
                .containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE");
    }
}
