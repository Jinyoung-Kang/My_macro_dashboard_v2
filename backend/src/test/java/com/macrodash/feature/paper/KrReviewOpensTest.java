package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.ReviewFacts.EntryOpen;
import com.macrodash.analytics.TradingCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 복기의 가정 진입 시가({@link KrReviewOpens}, 2단계 명세 §9 'E3', 사용자 결정 v5) — 금융위 확정 시가가 먼저, 아직 없는 날은 토스
 * 관측치의 그날 봉(1분봉 개장 봉 → 일봉 시가, 장부 사다리와 같은 순서), 이어받은 항목·관측 아닌 봉·창 앞 날짜는 쓰지 않음.
 */
class KrReviewOpensTest {

    private static final LocalDate THU = LocalDate.of(2026, 11, 5);
    private static final LocalDate FRI = LocalDate.of(2026, 11, 6);
    private static final LocalDate WED = LocalDate.of(2026, 11, 4);

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    private static TradingCalendar calendar() {
        return KrPaperMarket.INSTANCE.openCalendar(KrFixtures.inputs(null, KrFixtures.holidays(2026, 2027)));
    }

    private static KrConfirmed fsc(String code, LocalDate date, String open) {
        TreeMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
        days.put(date, new KrConfirmed.Day(date, new BigDecimal("1000"), 10L, 100L,
                open == null ? null : new BigDecimal(open), "KOSPI"));
        return new KrConfirmed(Map.of(code, new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, date, days)));
    }

    @Test
    @DisplayName("출처 순서: 금융위 확정 시가(FSC)가 토스보다 먼저, 금융위가 아직 내지 않은 날은 토스 1분봉 개장 봉 시가, 1분봉이 FAILED·없으면 일봉 시가(봉 출처), 거래량 0 봉·창 앞 날짜는 없음")
    void ladder() {
        KrFixtures.Payload payload = new KrFixtures.Payload(FRI);
        Instant fetched = kst("2026-11-06T21:58");
        payload.code("000660", fetched).bar(WED, 175_000, 176_000, 5_000).bar(THU, 179_000, 182_000, 9_000)
                .bar(FRI, 195_000, 198_000, 9_500).minute("OK", "09:01", 194_000, 1_000);
        payload.code("035720", fetched).bar(THU, 39_000, 39_500, 0).bar(FRI, 40_500, 42_000, 21_000)
                .minute("FAILED");
        Optional<PaperMarketData.Quotes> quotes = KrPaperMarket.INSTANCE.parse(payload.snapshot(kst("2026-11-06T22:00")));

        Map<String, Map<LocalDate, EntryOpen>> opens = KrReviewOpens.read(fsc("000660", THU, "180000"), quotes,
                List.of("000660", "035720", "999990"), THU, calendar());

        assertThat(opens).containsOnlyKeys("000660", "035720");
        assertThat(opens.get("000660")).as("창 앞 수요일 봉은 빠짐").containsOnlyKeys(THU, FRI);
        assertThat(opens.get("000660").get(THU)).as("금융위가 토스 179,000보다 먼저")
                .isEqualTo(new EntryOpen(180_000, KrConfirmed.SOURCE_FSC));
        assertThat(opens.get("000660").get(FRI)).isEqualTo(new EntryOpen(194_000, KrQuotes.SOURCE_1M_OPEN));
        assertThat(opens.get("035720")).as("거래량 0 목요일 봉은 관측이 아님").containsOnlyKeys(FRI);
        assertThat(opens.get("035720").get(FRI)).as("1분봉 FAILED — 복기는 기다리지 않고 일봉 시가(통합가)")
                .isEqualTo(new EntryOpen(40_500, KrQuotes.SOURCE_INTEGRATED));
    }

    @Test
    @DisplayName("1분봉 MINUTE_OK여도 개장 라벨 봉의 거래량이 0이면 그 시가를 쓰지 않고 일봉 시가로(장부 사다리와 같은 '거래량 > 0 봉' — 사용자 결정 v5 출처 순서)")
    void zeroVolumeOpeningMinuteFallsBackToTheDailyOpen() {
        KrFixtures.Payload payload = new KrFixtures.Payload(FRI);
        Instant fetched = kst("2026-11-06T21:58");
        payload.code("000660", fetched).bar(THU, 179_000, 182_000, 9_000).bar(FRI, 195_000, 198_000, 9_500)
                .minute("OK", "09:01", 194_000, 0);
        payload.etf("069500", fetched).bar(FRI, 95_200, 95_300, 3_100_000).minute("OK", "09:01", 95_100, 0);
        Optional<PaperMarketData.Quotes> quotes = KrPaperMarket.INSTANCE.parse(payload.snapshot(kst("2026-11-06T22:00")));

        Map<String, Map<LocalDate, EntryOpen>> opens = KrReviewOpens.read(fsc("000660", THU, "180000"), quotes,
                List.of("000660", "069500"), THU, calendar());

        assertThat(opens.get("000660").get(FRI)).as("거래량 0 개장 봉 194,000 대신 일봉 시가(통합가)")
                .isEqualTo(new EntryOpen(195_000, KrQuotes.SOURCE_INTEGRATED));
        assertThat(opens.get("069500").get(FRI)).as("ETF는 일봉 출처 TOSS_DAILY")
                .isEqualTo(new EntryOpen(95_200, KrQuotes.SOURCE_DAILY));
    }

    @Test
    @DisplayName("금융위 행의 시가 칸이 없으면(거래 없던 날) 토스로, 이어받은 항목(isStale — 이번에 받지 못함)은 쓰지 않음, 관측치가 없으면 금융위만")
    void missingFscOpenStaleItemsAndNoQuotes() {
        KrFixtures.Payload payload = new KrFixtures.Payload(FRI);
        Instant fetched = kst("2026-11-06T21:58");
        payload.code("000660", fetched).bar(THU, 179_000, 182_000, 9_000).bar(FRI, 195_000, 198_000, 9_500);
        payload.code("005930", fetched).bar(THU, 51_000, 52_000, 13_000).bar(FRI, 54_000, 55_000, 14_000).stale();
        Optional<PaperMarketData.Quotes> quotes = KrPaperMarket.INSTANCE.parse(payload.snapshot(kst("2026-11-06T22:00")));

        Map<String, Map<LocalDate, EntryOpen>> opens = KrReviewOpens.read(fsc("000660", THU, null), quotes,
                List.of("000660", "005930"), THU, calendar());

        assertThat(opens.get("000660").get(THU)).as("금융위 시가 칸 없음 → 토스 일봉 시가")
                .isEqualTo(new EntryOpen(179_000, KrQuotes.SOURCE_INTEGRATED));
        assertThat(opens).doesNotContainKey("005930");
        assertThat(KrReviewOpens.read(fsc("000660", THU, "180000"), Optional.empty(), List.of("000660"), THU, calendar()))
                .isEqualTo(Map.of("000660", Map.of(THU, new EntryOpen(180_000, KrConfirmed.SOURCE_FSC))));
    }
}
