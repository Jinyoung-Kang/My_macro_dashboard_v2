package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Close1m;
import com.macrodash.feature.paper.KrQuotes.Day;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.Datasets;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 Claude 계좌2의 매시·종가 체결 사다리({@link KrTimedLadder} — 단계 2a, 명세 2026-11-02-kr-claude2-stage2 §2·§9)와 1분봉 저장본 읽기
 * ({@link KrQuotes#parseTimed}): 매시는 T 봉 → 창 안 첫 거래 봉 → 마감 전 T 뒤 첫 거래 봉 → 없으면 기다림, 종가는 마감 단일가 봉(NXT 15:31·그 밖 15:30)만 —
 * 일봉 종가로 채우지 않음, 1분봉이 없거나 실패면 기다리고 NO_BARS면 체결하지 않음, 모르는 계약 판은 빈 표.
 */
class KrTimedLadderTest {

    private static final LocalDate E = LocalDate.of(2026, 11, 3);
    private static final TradingCalendar CALENDAR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    private static final Instant NIGHT = kst("2026-11-03T23:25");
    private static final Instant DEADLINE = kst("2026-11-04T01:00");

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    private static Bar1m bar(String label, long open, long volume) {
        return new Bar1m(label, BigDecimal.valueOf(open), volume);
    }

    private static Timed ok(Map<String, List<Bar1m>> windows, Map<String, Bar1m> firstAfter, Map<String, Close1m> closes) {
        return new Timed(KrQuotes.TIMED_OK, null, kst("2026-11-03T23:21"), windows, firstAfter, closes);
    }

    private static Quote quote(Boolean nxt, Timed timed) {
        Day day = new Day(E, BigDecimal.valueOf(70_000), BigDecimal.valueOf(71_000), 1_000L, KrQuotes.SOURCE_INTEGRATED, null, null);
        Quote quote = new Quote("005930", NIGHT, "STOCK", nxt, false, List.of(day), "KOSPI", null);
        return timed == null ? quote : quote.withTimed(Map.of(E, timed));
    }

    @Test
    @DisplayName("장중 시장가(MARKET, 단계 2b) — 기준 분 = (생성 + 60초)를 분으로 내린 뒤 + 1분의 창, 창이 저장본에 없으면 기다림, 기준 분이 목표 세션이 아니면 체결하지 않음")
    void marketMinute() {
        Instant created = Instant.parse("2026-11-03T01:31:20Z");                 // 10:31:20 KST → 기준 분 10:33
        Quote quote = quote(true, ok(Map.of("10:33", List.of(bar("10:34", 71_034, 0), bar("10:35", 71_035, 300))), Map.of(), Map.of()));
        KrTimedLadder.Result market = KrTimedLadder.price(PaperBooks.MARKET, created, quote, E, NIGHT, CALENDAR, DEADLINE);
        assertThat(market.choice().price()).isEqualByComparingTo("71035");
        assertThat(market.choice().source()).isEqualTo(KrTimedLadder.SOURCE_NEXT);
        assertThat(KrTimedLadder.price(PaperBooks.MARKET, Instant.parse("2026-11-03T01:40:00Z"), quote, E, NIGHT, CALENDAR, DEADLINE)
                .reason()).contains("10:42 창이 없음").contains("기다림");
        assertThat(KrTimedLadder.price(PaperBooks.MARKET, Instant.parse("2026-11-02T01:31:20Z"), quote, E, NIGHT, CALENDAR, DEADLINE)
                .reason()).contains("목표 세션이 아님");
        assertThat(KrTimedLadder.price(PaperBooks.MARKET, null, quote, E, NIGHT, CALENDAR, DEADLINE).reason()).contains("생성 시각 모름");
        assertThat(KrTimedLadder.targetOn(PaperBooks.AT_1400, null, E, CALENDAR)).isEqualTo(Instant.parse("2026-11-03T05:00:00Z"));
        assertThat(KrTimedLadder.targetOn(PaperBooks.NEXT_OPEN, created, E, CALENDAR)).isNull();
    }

    @Test
    @DisplayName("분 단위 지정 시각(AT_MINUTE, ADR 0027) — 그날 주문 시각의 창: T 봉(라벨 T+1분) 시가 → 창 안 첫 거래 봉 → 그날 T 뒤 첫 거래 봉(대체), 창이 저장본에 "
            + "없으면 기다림, 시각이 없거나 그날 개장 전·마감 뒤면 체결하지 않음(만료까지)")
    void atMinuteLadder() {
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>();
        windows.put("10:47", List.of(bar("10:48", 71_048, 300), bar("10:49", 71_049, 300)));
        windows.put("13:05", List.of(bar("13:06", 71_306, 0), bar("13:08", 71_308, 40)));
        windows.put("14:10", List.of());
        Quote quote = quote(true, ok(windows, Map.of("14:10", bar("14:31", 71_431, 90)), Map.of()));

        KrTimedLadder.Result exact = atMinute(LocalTime.of(10, 47), quote);
        assertThat(exact.choice().price()).isEqualByComparingTo("71048");
        assertThat(exact.choice().source()).isEqualTo(KrTimedLadder.SOURCE_AT);
        assertThat(exact.choice().note()).isNull();
        KrTimedLadder.Result next = atMinute(LocalTime.of(13, 5), quote);
        assertThat(next.choice().price()).isEqualByComparingTo("71308");
        assertThat(next.choice().source()).isEqualTo(KrTimedLadder.SOURCE_NEXT);
        KrTimedLadder.Result late = atMinute(LocalTime.of(14, 10), quote);
        assertThat(late.choice().price()).isEqualByComparingTo("71431");
        assertThat(late.choice().source()).isEqualTo(KrTimedLadder.SOURCE_LATE);

        KrTimedLadder.Result missing = atMinute(LocalTime.of(11, 11), quote);
        assertThat(missing.choice()).isNull();
        assertThat(missing.reason()).contains("AT_MINUTE(11:11)").contains("11:11 창이 없음").contains("기다림");
        assertThat(missing.unfillable()).as("수집기가 그 창을 아직 받지 않음 — 기다림").isFalse();
        for (LocalTime bad : new LocalTime[]{null, LocalTime.of(8, 59), LocalTime.of(15, 30), LocalTime.of(18, 0)}) {
            KrTimedLadder.Result none = atMinute(bad, quote);
            assertThat(none.choice()).as("시각 " + bad).isNull();
            assertThat(none.unfillable()).as("시각 " + bad + " — 그 세션에는 그 분이 없음").isTrue();
            assertThat(none.reason()).contains("체결하지 않음(만료까지)");
        }
        assertThat(atMinute(null, quote).reason()).contains("지정 시각이 없음");
        assertThat(atMinute(LocalTime.of(8, 59), quote).reason()).contains("08:59").contains("개장(09:00) 전");

        assertThat(KrTimedLadder.timed(PaperBooks.AT_MINUTE)).isTrue();
        assertThat(KrFills.fills(PaperBooks.AT_MINUTE)).isTrue();
        assertThat(KrTimedLadder.hourly(PaperBooks.AT_MINUTE)).as("매시 표에는 없음 — 시각은 주문이 가짐").isNull();
        assertThat(KrTimedLadder.targetOn(PaperBooks.AT_MINUTE, null, LocalTime.of(10, 47), E, CALENDAR))
                .isEqualTo(Instant.parse("2026-11-03T01:47:00Z"));
        assertThat(KrTimedLadder.targetOn(PaperBooks.AT_MINUTE, null, null, E, CALENDAR)).isNull();
        assertThat(KrTimedLadder.targetOn(PaperBooks.AT_1400, null, LocalTime.of(10, 47), E, CALENDAR))
                .as("매시 시점은 이름이 시각을 정함 — 지정 시각 칸을 보지 않음").isEqualTo(Instant.parse("2026-11-03T05:00:00Z"));
    }

    private static KrTimedLadder.Result atMinute(LocalTime at, Quote quote) {
        return KrTimedLadder.price(PaperBooks.AT_MINUTE, null, at, quote, E, NIGHT, CALENDAR, DEADLINE);
    }

    @Test
    @DisplayName("장중 시장가(MARKET) 닫힘(단계 2b) — 지금 만들 주문의 기준 분이 정규장 안·종가 단일가 전이면 열림, 15:20 이후·다른 날이면 MALFORMED")
    void closedMarket() {
        LocalDate asOf = LocalDate.of(2026, 11, 2);
        List<String> menu = List.of(PaperBooks.MARKET, PaperBooks.AT_1400, PaperBooks.NEXT_CLOSE);
        assertThat(KrTimedLadder.closedTimings(menu, asOf, kst("2026-11-03T11:03"), CALENDAR)).isEmpty();
        Map<String, com.macrodash.analytics.OrderValidator.Closed> late = KrTimedLadder.closedTimings(menu, asOf,
                kst("2026-11-03T15:18:30"), CALENDAR);
        assertThat(late).containsOnlyKeys(PaperBooks.MARKET, PaperBooks.AT_1400);
        assertThat(late.get(PaperBooks.MARKET).reason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
        assertThat(late.get(PaperBooks.MARKET).detail()).contains("15:20").contains("종가 단일가");
        assertThat(KrTimedLadder.closedTimings(List.of(PaperBooks.MARKET), asOf, kst("2026-11-02T22:40"), CALENDAR))
                .as("밤 — 기준 분이 목표 세션이 아님").containsOnlyKeys(PaperBooks.MARKET);
    }

    private static KrTimedLadder.Result price(String timing, Quote quote) {
        return KrTimedLadder.price(timing, null, quote, E, NIGHT, CALENDAR, DEADLINE);
    }

    @Test
    @DisplayName("매시: T 봉(라벨 hh:01) 시가 → T 봉 거래 없으면 창 안 첫 거래 봉(사유) → 창 안도 없으면 마감 전 T 뒤 첫 거래 봉(대체) → 없으면 기다림")
    void hourlyLadder() {
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>();
        windows.put("10:00", List.of(bar("10:01", 71_000, 500)));
        windows.put("11:00", List.of(bar("11:01", 71_100, 0), bar("11:02", 71_150, 20)));
        windows.put("12:00", List.of(bar("12:01", 71_200, 0)));
        windows.put("13:00", List.of());
        Map<String, Bar1m> after = new LinkedHashMap<>();
        after.put("12:00", bar("12:09", 71_300, 5));
        after.put("13:00", bar("15:40", 71_900, 9));     // 장 마감 뒤(시간외) — 정규장 거래가 아님
        Quote quote = quote(true, ok(windows, after, Map.of()));

        KrTimedLadder.Result at = price(PaperBooks.AT_1000, quote);
        assertThat(at.choice().price()).isEqualByComparingTo("71000");
        assertThat(at.choice().source()).isEqualTo(KrTimedLadder.SOURCE_AT);
        assertThat(at.choice().note()).isNull();

        KrTimedLadder.Result next = price(PaperBooks.AT_1100, quote);
        assertThat(next.choice().price()).isEqualByComparingTo("71150");
        assertThat(next.choice().source()).isEqualTo(KrTimedLadder.SOURCE_NEXT);
        assertThat(next.choice().note()).contains("11:02");

        KrTimedLadder.Result late = price(PaperBooks.AT_1200, quote);
        assertThat(late.choice().source()).isEqualTo(KrTimedLadder.SOURCE_LATE);
        assertThat(late.choice().price()).isEqualByComparingTo("71300");

        KrTimedLadder.Result none = price(PaperBooks.AT_1300, quote);
        assertThat(none.choice()).isNull();
        assertThat(none.reason()).contains("정규장 거래 없음");
    }

    @Test
    @DisplayName("종가: 마감 단일가 봉 — NXT 종목은 15:31, 그 밖은 15:30, NXT 여부를 모르거나 마감 봉이 없거나 이른 저장본이면 기다림(일봉 종가로 채우지 않음)")
    void closeLadder() {
        Map<String, Close1m> closes = Map.of("15:30", new Close1m(BigDecimal.valueOf(71_400), 900L),
                "15:31", new Close1m(BigDecimal.valueOf(71_500), 1_200L));
        assertThat(price(PaperBooks.NEXT_CLOSE, quote(true, ok(Map.of(), Map.of(), closes))).choice().price())
                .isEqualByComparingTo("71500");
        KrTimedLadder.Result krxOnly = price(PaperBooks.NEXT_CLOSE, quote(false, ok(Map.of(), Map.of(), closes)));
        assertThat(krxOnly.choice().price()).isEqualByComparingTo("71400");
        assertThat(krxOnly.choice().source()).isEqualTo(KrTimedLadder.SOURCE_CLOSE);

        assertThat(price(PaperBooks.NEXT_CLOSE, quote(null, ok(Map.of(), Map.of(), closes))).reason()).contains("NXT 여부를 몰라");
        assertThat(price(PaperBooks.NEXT_CLOSE, quote(true, ok(Map.of(), Map.of(), Map.of()))).reason())
                .contains("토스 일봉 종가로 채우지 않음");
        Timed early = new Timed(KrQuotes.TIMED_OK, null, kst("2026-11-03T15:35"), Map.of(), Map.of(), closes);
        assertThat(price(PaperBooks.NEXT_CLOSE, quote(true, early)).reason()).contains("마감 + 10분 전");
    }

    @Test
    @DisplayName("1분봉이 없거나 실패면 기다리고, 그날 봉 없음(NO_BARS)이면 체결하지 않음")
    void missingOrFailed() {
        assertThat(price(PaperBooks.AT_1000, quote(true, null)).reason()).contains("아직 받지 않음");
        Timed failed = new Timed(KrQuotes.TIMED_FAILED, "HTTP 500", NIGHT, Map.of(), Map.of(), Map.of());
        assertThat(price(PaperBooks.AT_1000, quote(true, failed)).reason()).contains("FAILED(HTTP 500)").contains("기다림");
        Timed none = new Timed(KrQuotes.TIMED_NO_BARS, null, NIGHT, Map.of(), Map.of(), Map.of());
        assertThat(price(PaperBooks.AT_1000, quote(true, none)).reason()).contains("체결하지 않음");
    }

    @Test
    @DisplayName("저장본 읽기: 세션 → 종목 → 창(라벨 순)·창 뒤 첫 거래 봉(null 허용)·마감 봉, 모르는 계약 판·모양이면 빈 표")
    void parseTimed() {
        ObjectNode payload = MAPPER.createObjectNode().put("contract", 1);
        ObjectNode entry = payload.putObject("sessions").putObject(E.toString()).putObject("005930")
                .put("status", "OK").put("fetchedAt", "2026-11-03T14:21:00+00:00");
        entry.putObject("windows").putArray("10:00").add(MAPPER.createObjectNode().put("label", "10:02").put("open", 71_010).put("volume", 3))
                .add(MAPPER.createObjectNode().put("label", "10:01").put("open", 71_000).put("volume", 0));
        ObjectNode after = entry.putObject("firstAfter");
        after.set("10:00", MAPPER.createObjectNode().put("label", "10:02").put("open", 71_010).put("volume", 3));
        after.putNull("11:00");
        entry.putObject("closes").set("15:31", MAPPER.createObjectNode().put("close", 71_500).put("volume", 1_200));

        Map<String, Map<LocalDate, Timed>> parsed = KrQuotes.parseTimed(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_TIMED, payload, NIGHT));

        Timed timed = parsed.get("005930").get(E);
        assertThat(timed.status()).isEqualTo(KrQuotes.TIMED_OK);
        assertThat(timed.fetchedAt()).isEqualTo(Instant.parse("2026-11-03T14:21:00Z"));
        assertThat(timed.windows().get("10:00")).extracting(Bar1m::label).containsExactly("10:01", "10:02");
        assertThat(timed.firstAfter()).containsKey("11:00");
        assertThat(timed.firstAfter().get("11:00")).isNull();
        assertThat(timed.closes().get("15:31").close()).isEqualByComparingTo("71500");

        payload.put("contract", 2);
        assertThat(KrQuotes.parseTimed(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_TIMED, payload, NIGHT))).isEmpty();
        assertThat(KrQuotes.parseTimed(null)).isEmpty();
    }

    @Test
    @DisplayName("닫힌 매시 시점: 보통 날 밤 결정은 없음, 장 시간 변경일(11:00~15:05 가정)은 개장 전 AT_1000·종가 단일가에 걸리는 AT_1500 MALFORMED, "
            + "기준 시각이 지금 + 60초 이전이면 LATE_FOR_TIMING, 시가·종가는 닫지 않음, 매시 시점이 없는 계좌는 달력을 보지 않음")
    void closedTimings() {
        LocalDate asOf = LocalDate.of(2026, 11, 2);
        assertThat(KrTimedLadder.closedTimings(PaperBooks.KR_CLAUDE2_TIMINGS, asOf, kst("2026-11-02T22:40"), CALENDAR)).isEmpty();

        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(E, new KrxCalendar.Hours(LocalTime.of(11, 0), LocalTime.of(15, 5))));
        Map<String, com.macrodash.analytics.OrderValidator.Closed> closed =
                KrTimedLadder.closedTimings(PaperBooks.KR_CLAUDE2_TIMINGS, asOf, kst("2026-11-02T22:40"), shifted);
        assertThat(closed).containsOnlyKeys(PaperBooks.AT_1000, PaperBooks.AT_1500);
        assertThat(closed.get(PaperBooks.AT_1000).reason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
        assertThat(closed.get(PaperBooks.AT_1500).detail()).contains("11:00~15:05").contains("종가 단일가");

        Map<String, com.macrodash.analytics.OrderValidator.Closed> late =
                KrTimedLadder.closedTimings(PaperBooks.KR_CLAUDE2_TIMINGS, asOf, kst("2026-11-03T10:59:30"), CALENDAR);
        assertThat(late).containsOnlyKeys(PaperBooks.AT_1000, PaperBooks.AT_1100);
        assertThat(late.values()).extracting(com.macrodash.analytics.OrderValidator.Closed::reason)
                .containsOnly(com.macrodash.analytics.OrderValidator.LATE_FOR_TIMING);

        assertThat(KrTimedLadder.closedTimings(List.of(PaperBooks.NEXT_OPEN), asOf, kst("2026-11-03T10:59:30"), null))
                .as("계좌1(NEXT_OPEN뿐)은 달력을 보지 않고 빈 표").isEmpty();
    }

    @Test
    @DisplayName("매시 시점의 기준 시각은 수집기 KR_TIMED_HOURS와 같은 10:00~15:00, 그 밖은 null")
    void hourlyTimes() {
        assertThat(KrTimedLadder.HOURLY.values()).containsExactlyInAnyOrder(LocalTime.of(10, 0), LocalTime.of(11, 0),
                LocalTime.of(12, 0), LocalTime.of(13, 0), LocalTime.of(14, 0), LocalTime.of(15, 0));
        assertThat(KrTimedLadder.hourly(PaperBooks.NEXT_OPEN)).isNull();
    }
}
