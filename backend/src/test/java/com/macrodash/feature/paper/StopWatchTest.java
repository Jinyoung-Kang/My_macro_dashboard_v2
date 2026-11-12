package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 스탑 감시 판정(ADR 0032) — 격자·격자의 가격·두 번 이어짐·갭 가드(R1)·덮음·주문 시점. 모두 순수 함수라 저장본 JSON을 직접 만듭니다.
 *
 * <p>시각: 미국 2026-11-09(월, 표준시 — 09:30 ET = 14:30Z), 조기 폐장 2026-11-27(13:00 ET). 한국 2026-11-09(월), 수능일 2026-11-19(10:00~16:30).
 */
class StopWatchTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final TradingCalendar KR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
            Map.of(LocalDate.of(2026, 11, 19), new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
    private static final LocalDate DAY = LocalDate.of(2026, 11, 9);
    private static final LocalDate EXAM = LocalDate.of(2026, 11, 19);

    private static Instant et(int h, int m) {
        return et(DAY, h, m, 0);
    }

    private static Instant et(LocalDate day, int h, int m, int s) {
        return ZonedDateTime.of(day, LocalTime.of(h, m, s), UsMarketCalendar.NEW_YORK).toInstant();
    }

    private static Instant kst(LocalDate day, int h, int m, int s) {
        return ZonedDateTime.of(day, LocalTime.of(h, m, s), KrxCalendar.SEOUL).toInstant();
    }

    /** 미국 항목 — 그 세션 봉(시작 시각 → 종가), 첫 봉, 전일 종가. */
    static ObjectNode usEntry(LocalDate session, Map<Instant, Double> bars, Double first, Double prevClose) {
        ObjectNode entry = PaperFixtures.MAPPER.createObjectNode();
        entry.put("session", session.toString());
        ArrayNode array = entry.putArray("bars");
        bars.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> {
            ObjectNode bar = array.addObject();
            bar.put("t", e.getKey().toString());
            bar.put("c", e.getValue());
        });
        if (first != null) {
            entry.putObject("day").putObject("first").put("t", et(session, 9, 30, 0).toString()).put("c", first);
        }
        if (prevClose != null) {
            entry.put("prevClose", prevClose);
        } else {
            entry.putNull("prevClose");
        }
        return entry;
    }

    /** 한국 항목 — 그날 봉(라벨 → 종가, 거래량 100), 거래량 0 라벨, 첫 봉 시가, 전일 원시·수정 종가. */
    static ObjectNode krEntry(LocalDate session, Map<String, Double> bars, List<String> quiet, Double first, Double raw,
                              Double adjusted) {
        ObjectNode entry = PaperFixtures.MAPPER.createObjectNode();
        entry.put("session", session.toString());
        ArrayNode array = entry.putArray("bars");
        bars.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> {
            ObjectNode bar = array.addObject();
            bar.put("label", e.getKey());
            bar.put("o", e.getValue());
            bar.put("c", e.getValue());
            bar.put("v", quiet.contains(e.getKey()) ? 0 : 100);
        });
        if (first != null) {
            entry.putObject("day").putObject("first").put("label", "09:01").put("o", first);
        }
        if (raw != null) {
            ObjectNode prev = entry.putObject("prevClose");
            prev.put("date", session.minusDays(3).toString());
            prev.put("raw", raw);
            if (adjusted != null) {
                prev.put("adjusted", adjusted);
            } else {
                prev.putNull("adjusted");
            }
        }
        return entry;
    }

    private static Map<Instant, Double> usMinutes(Instant from, Instant to, double start, double step) {
        Map<Instant, Double> out = new java.util.LinkedHashMap<>();
        double price = start;
        for (Instant at = from; !at.isAfter(to); at = at.plus(Duration.ofMinutes(1))) {
            out.put(at, price);
            price += step;
        }
        return out;
    }

    @Nested
    @DisplayName("격자")
    class Grids {

        @Test
        @DisplayName("미국 보통 날은 09:35~15:55 ET 5분 간격, 조기 폐장일은 12:55 ET까지, 휴장일은 없음")
        void us() {
            List<Instant> grids = StopWatch.grids(US, DAY, false);
            assertThat(grids.get(0)).isEqualTo(et(9, 35));
            assertThat(grids.get(grids.size() - 1)).isEqualTo(et(15, 55));
            assertThat(grids).hasSize(77);
            List<Instant> early = StopWatch.grids(US, LocalDate.of(2026, 11, 27), false);
            assertThat(early.get(early.size() - 1)).isEqualTo(et(LocalDate.of(2026, 11, 27), 12, 55, 0));
            assertThat(StopWatch.grids(US, LocalDate.of(2026, 11, 26), false)).isEmpty();
            assertThat(StopWatch.firstJudgedGrid(US, DAY)).as("앞 격자가 있는 첫 격자 = 개장 10분 뒤").isEqualTo(et(9, 40));
        }

        @Test
        @DisplayName("한국 보통 날은 09:05~15:20(종가 단일가 앞), 수능일은 10:05~16:20")
        void kr() {
            List<Instant> grids = StopWatch.grids(KR, DAY, true);
            assertThat(grids.get(0)).isEqualTo(kst(DAY, 9, 5, 0));
            assertThat(grids.get(grids.size() - 1)).isEqualTo(kst(DAY, 15, 20, 0));
            List<Instant> exam = StopWatch.grids(KR, EXAM, true);
            assertThat(exam.get(0)).isEqualTo(kst(EXAM, 10, 5, 0));
            assertThat(exam.get(exam.size() - 1)).isEqualTo(kst(EXAM, 16, 20, 0));
            assertThat(StopWatch.firstJudgedGrid(KR, EXAM)).isEqualTo(kst(EXAM, 10, 10, 0));
        }

        @Test
        @DisplayName("QA-384 마지막 격자 — 보통 날 15:55 ET·15:20 KST, 조기 폐장일 12:55 ET, 수능일 16:20 KST(모두 격자 끝과 같음), 휴장일은 없음")
        void lastGrid() {
            assertThat(StopWatch.lastGrid(US, DAY, false)).isEqualTo(et(15, 55)).isEqualTo(StopWatch.gridEnd(US, DAY, false));
            LocalDate early = LocalDate.of(2026, 11, 27);
            assertThat(StopWatch.lastGrid(US, early, false)).isEqualTo(et(early, 12, 55, 0)).isEqualTo(StopWatch.gridEnd(US, early, false));
            assertThat(StopWatch.lastGrid(US, LocalDate.of(2026, 11, 26), false)).isNull();
            assertThat(StopWatch.lastGrid(KR, DAY, true)).isEqualTo(kst(DAY, 15, 20, 0)).isEqualTo(StopWatch.gridEnd(KR, DAY, true));
            assertThat(StopWatch.lastGrid(KR, EXAM, true)).isEqualTo(kst(EXAM, 16, 20, 0)).isEqualTo(StopWatch.gridEnd(KR, EXAM, true));
        }
    }

    @Nested
    @DisplayName("격자의 가격과 두 번 이어짐")
    class Evaluate {

        @Test
        @DisplayName("미국은 봉 시작 [G−5, G−1]의 마지막 종가 — 두 격자 모두 스탑가 이하면 걸고(같은 값도), 하나만 아래면 걸지 않음")
        void usTwoChecks() {
            Map<Instant, Double> bars = new java.util.LinkedHashMap<>(usMinutes(et(10, 0), et(10, 14), 100, 0));
            bars.put(et(10, 9), 92.0);       // G=10:10의 가격(10:05~10:09 마지막)
            bars.put(et(10, 14), 91.0);      // G=10:15의 가격
            ObjectNode entry = usEntry(DAY, bars, 100.0, 100.0);
            StopWatch.Evaluation hit = StopWatch.evaluate(entry, et(10, 15), 92.0, DAY, US, false);
            assertThat(hit.verdict()).isEqualTo(StopWatch.Verdict.TRIGGER);
            assertThat(hit.previous().price()).isEqualTo(92.0);
            assertThat(hit.previous().barAt()).isEqualTo(et(10, 9));
            assertThat(hit.current().price()).isEqualTo(91.0);
            assertThat(StopWatch.evaluate(entry, et(10, 15), 91.5, DAY, US, false).verdict())
                    .as("앞 격자 92 > 스탑 91.5").isEqualTo(StopWatch.Verdict.NONE);
            assertThat(StopWatch.evaluate(entry, et(10, 25), 99.0, DAY, US, false).verdict())
                    .as("10:20·10:25 격자에 표본 없음").isEqualTo(StopWatch.Verdict.UNKNOWN);
        }

        @Test
        @DisplayName("한국은 봉 끝 라벨 (G−5, G]의 거래량 > 0 마지막 종가 — 거래량 0 봉은 건너뜀")
        void krLabels() {
            Map<String, Double> bars = new java.util.LinkedHashMap<>();
            for (int m = 1; m <= 15; m++) {
                bars.put(String.format("09:%02d", m), 50_000.0);
            }
            bars.put("09:09", 45_000.0);
            bars.put("09:10", 44_000.0);      // 거래량 0 — G=09:10의 가격은 09:09
            bars.put("09:15", 45_500.0);
            ObjectNode entry = krEntry(DAY, bars, List.of("09:10"), 50_000.0, 50_000.0, 50_000.0);
            StopWatch.Evaluation e = StopWatch.evaluate(entry, kst(DAY, 9, 15, 0), 46_000, DAY, KR, true);
            assertThat(e.previous().price()).isEqualTo(45_000.0);
            assertThat(e.previous().barAt()).isEqualTo(kst(DAY, 9, 9, 0));
            assertThat(e.current().price()).isEqualTo(45_500.0);
            assertThat(e.verdict()).isEqualTo(StopWatch.Verdict.TRIGGER);
            assertThat(StopWatch.evaluate(entry, kst(DAY, 9, 5, 0), 60_000, DAY, KR, true).verdict())
                    .as("첫 격자(09:05)는 앞 격자(09:00)가 없어 걸 수 없음").isEqualTo(StopWatch.Verdict.UNKNOWN);
        }

        @Test
        @DisplayName("다른 세션 항목·이어받은 항목은 가격을 모름")
        void staleOrOtherSession() {
            ObjectNode entry = usEntry(DAY.minusDays(3), usMinutes(et(DAY.minusDays(3), 10, 0, 0), et(DAY.minusDays(3), 10, 14, 0), 50, 0),
                    50.0, 50.0);
            assertThat(StopWatch.evaluate(entry, et(10, 15), 99.0, DAY, US, false).verdict()).isEqualTo(StopWatch.Verdict.UNKNOWN);
            ObjectNode stale = usEntry(DAY, usMinutes(et(10, 0), et(10, 14), 50, 0), 50.0, 50.0);
            stale.put("isStale", true);
            assertThat(StopWatch.evaluate(stale, et(10, 15), 99.0, DAY, US, false).verdict()).isEqualTo(StopWatch.Verdict.UNKNOWN);
        }
    }

    @Nested
    @DisplayName("갭 가드(통합 검토 R1)")
    class Guards {

        @Test
        @DisplayName("한국 0.2주 무상증자형 갭 −17%는 가드 — 첫 봉 시가 ≤ 전일 원시 종가 × 0.85")
        void krBonusIssueGap() {
            ObjectNode entry = krEntry(DAY, Map.of("09:01", 41_500.0), List.of(), 41_500.0, 50_000.0, 50_000.0);
            StopWatch.Guard guard = StopWatch.guard(entry, true, null);
            assertThat(guard.known()).isTrue();
            assertThat(guard.guarded()).isTrue();
            assertThat(guard.reason()).contains("0.85");
            assertThat(StopWatch.guard(krEntry(DAY, Map.of("09:01", 43_000.0), List.of(), 43_000.0, 50_000.0, 50_000.0), true, null)
                    .guarded()).as("−14%는 가드 밖(감시가 판정)").isFalse();
        }

        @Test
        @DisplayName("한국 전일 원시·수정 종가가 다르면(권리락 아침) 가드, 전일 종가가 없으면 장부 값, 그것도 없으면 모름")
        void krAdjustedMismatch() {
            assertThat(StopWatch.guard(krEntry(DAY, Map.of("09:01", 49_000.0), List.of(), 49_000.0, 50_000.0, 48_000.0), true, null)
                    .guarded()).isTrue();
            ObjectNode noClose = krEntry(DAY, Map.of("09:01", 49_000.0), List.of(), 49_000.0, null, null);
            assertThat(StopWatch.guard(noClose, true, null).known()).isFalse();
            assertThat(StopWatch.guard(noClose, true, 50_000.0).clear()).isTrue();
            assertThat(StopWatch.guard(krEntry(DAY, Map.of("09:01", 49_000.0), List.of(), null, 50_000.0, 50_000.0), true, null)
                    .known()).as("첫 봉 모름").isFalse();
        }

        @Test
        @DisplayName("미국 분할형 갭은 장부 전일 종가로 가드, Yahoo 전일 종가와 장부 값이 2% 넘게 다르면 가드")
        void usSplitGap() {
            ObjectNode split = usEntry(DAY, Map.of(et(9, 30), 50.0), 50.0, 50.0);   // 2:1 분할 — Yahoo 전일 종가는 이미 조정
            assertThat(StopWatch.guard(split, false, 100.0).guarded()).isTrue();
            assertThat(StopWatch.guard(usEntry(DAY, Map.of(et(9, 30), 99.0), 99.0, 103.0), false, 100.0).guarded())
                    .as("Yahoo 103 ≠ 장부 100").isTrue();
            assertThat(StopWatch.guard(usEntry(DAY, Map.of(et(9, 30), 99.0), 99.0, 100.5), false, 100.0).clear()).isTrue();
            assertThat(StopWatch.guard(usEntry(DAY, Map.of(et(9, 30), 99.0), 99.0, 100.0), false, null).clear())
                    .as("장부 값이 없으면 Yahoo 값").isTrue();
            assertThat(StopWatch.guard(usEntry(DAY, Map.of(et(9, 30), 99.0), 99.0, null), false, null).known()).isFalse();
        }
    }

    @Nested
    @DisplayName("덮음 — 대체 경로가 건너뛰어도 되는가")
    class Covered {

        /** 감시 ON 때 받은 저장본 — 운영 수집기는 회차마다 최상위 {@code mode}를 적습니다(QA-360: ON일 때만 덮음). */
        private JsonNode payload(String ticker, JsonNode entry) {
            ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
            payload.put("mode", "ON");
            payload.putObject("tickers").set(ticker, entry);
            return payload;
        }

        @Test
        @DisplayName("미국 장중 W는 W−10분 뒤 표본, 마감 뒤 W*는 마지막 격자 15:55의 가격(봉 시작 15:50~15:54)이 있으면 덮음")
        void usWindow() {
            ObjectNode entry = usEntry(DAY, usMinutes(et(9, 30), et(10, 6), 100, 0), 100.0, 100.0);
            JsonNode p = payload("AAA", entry);
            assertThat(StopWatch.covered(p, "AAA", DAY, et(10, 15), US, false, 100.0)).isTrue();
            assertThat(StopWatch.covered(p, "AAA", DAY, et(10, 20), US, false, 100.0)).as("마지막 표본 10:06 끝 10:07 < 10:10").isFalse();
            assertThat(StopWatch.covered(p, "AAA", DAY, et(16, 15), US, false, 100.0)).isFalse();
            JsonNode late = payload("AAA", usEntry(DAY, usMinutes(et(15, 30), et(15, 54), 100, 0), 100.0, 100.0));
            assertThat(StopWatch.covered(late, "AAA", DAY, et(16, 15), US, false, 100.0)).isTrue();
            assertThat(StopWatch.covered(late, "AAA", DAY.plusDays(1), et(16, 15), US, false, 100.0)).as("다른 세션").isFalse();
            assertThat(StopWatch.covered(late, "BBB", DAY, et(16, 15), US, false, 100.0)).as("항목 없음").isFalse();
            assertThat(StopWatch.covered(late, "AAA", DAY, et(16, 15), US, false, 80.0)).as("가드(Yahoo 전일 종가 100 ≠ 장부 80)에 걸리면 덮지 않음")
                    .isFalse();
        }

        @Test
        @DisplayName("한국 밤 판정은 마지막 격자 15:20의 가격(봉 끝 15:15 초과 ~ 15:20 거래 표본)이 있으면 덮음, 이어받은 항목은 아님")
        void krNight() {
            Map<String, Double> bars = new java.util.LinkedHashMap<>();
            bars.put("15:12", 50_000.0);
            bars.put("15:18", 50_000.0);
            ObjectNode entry = krEntry(DAY, bars, List.of(), 50_000.0, 50_000.0, 50_000.0);
            assertThat(StopWatch.covered(payload("005930", entry), "005930", DAY, kst(DAY, 21, 0, 0), KR, true, null)).isTrue();
            ObjectNode quiet = krEntry(DAY, bars, List.of("15:18"), 50_000.0, 50_000.0, 50_000.0);
            assertThat(StopWatch.covered(payload("005930", quiet), "005930", DAY, kst(DAY, 21, 0, 0), KR, true, null))
                    .as("15:18 거래량 0 — 15:20 격자의 거래 표본 없음").isFalse();
            entry.put("isStale", true);
            assertThat(StopWatch.covered(payload("005930", entry), "005930", DAY, kst(DAY, 21, 0, 0), KR, true, null)).isFalse();
            assertThat(StopWatch.covered(null, "005930", DAY, kst(DAY, 21, 0, 0), KR, true, null)).isFalse();
        }

        @Test
        @DisplayName("QA-360 저장본의 mode가 ON일 때만 덮음 — SHADOW 때 받은 저장본(주문을 내지 않은 감시)과 mode가 없는 저장본은 덮지 않음")
        void onlyAnOnSnapshotCovers() {
            ObjectNode on = (ObjectNode) payload("AAA", usEntry(DAY, usMinutes(et(9, 30), et(10, 6), 100, 0), 100.0, 100.0));
            on.put("mode", "ON");
            assertThat(StopWatch.covered(on, "AAA", DAY, et(10, 15), US, false, 100.0)).isTrue();
            on.put("mode", "SHADOW");
            assertThat(StopWatch.covered(on, "AAA", DAY, et(10, 15), US, false, 100.0)).as("SHADOW 때 받은 저장본").isFalse();
            on.put("mode", "OFF");
            assertThat(StopWatch.covered(on, "AAA", DAY, et(10, 15), US, false, 100.0)).isFalse();
            on.remove("mode");
            assertThat(StopWatch.covered(on, "AAA", DAY, et(10, 15), US, false, 100.0)).as("mode 없음 — 보수적으로 덮지 않음").isFalse();
        }

        @Test
        @DisplayName("격자 끝 뒤 판정(미국 16:15·한국 밤)은 마지막 격자(15:55 ET·15:20 KST)의 가격이 있을 때만 덮음 — 마지막 회차를 놓친 날은 덮지 않음(QA-307)")
        void afterTheGridEndNeedsTheLastGrid() {
            JsonNode missed = payload("AAA", usEntry(DAY, usMinutes(et(9, 30), et(15, 49), 100, 0), 100.0, 100.0));
            assertThat(StopWatch.covered(missed, "AAA", DAY, et(15, 50), US, false, 100.0)).as("장중(격자 끝 앞)은 그대로").isTrue();
            assertThat(StopWatch.covered(missed, "AAA", DAY, et(16, 15), US, false, 100.0))
                    .as("15:50:20 저장본(마지막 봉 15:49)뿐 — 15:55 격자 [15:50, 15:54] 봉 없음").isFalse();
            JsonNode judged = payload("AAA", usEntry(DAY, usMinutes(et(9, 30), et(15, 54), 100, 0), 100.0, 100.0));
            assertThat(StopWatch.covered(judged, "AAA", DAY, et(16, 15), US, false, 100.0)).isTrue();

            Map<String, Double> bars = new java.util.LinkedHashMap<>();
            bars.put("15:12", 50_000.0);
            bars.put("15:15", 50_000.0);
            JsonNode krMissed = payload("005930", krEntry(DAY, bars, List.of(), 50_000.0, 50_000.0, 50_000.0));
            assertThat(StopWatch.covered(krMissed, "005930", DAY, kst(DAY, 21, 0, 0), KR, true, null))
                    .as("15:15:20 저장본(마지막 봉 끝 15:15)뿐 — 15:20 격자 (15:15, 15:20] 봉 없음").isFalse();
        }
    }

    @Nested
    @DisplayName("주문 시점 — T = 감지 + 60초 뒤 첫 분")
    class Targets {

        @Test
        @DisplayName("장중 감지는 T = G+2분 시장가, 첫 분 앞이면 그 첫 분 지정 시각, 장 끝 여유 안이면 종가")
        void us() {
            StopWatch.Target mid = StopWatch.target(et(DAY, 10, 15, 25), DAY, US, false);
            assertThat(mid.timing()).isEqualTo(PaperBooks.MARKET);
            assertThat(mid.at()).isEqualTo(et(10, 17));
            StopWatch.Target early = StopWatch.target(et(DAY, 9, 37, 30), DAY, US, false);
            assertThat(early.timing()).isEqualTo(PaperBooks.AT_MINUTE);
            assertThat(early.targetLocal()).isEqualTo(LocalTime.of(9, 40));
            StopWatch.Target close = StopWatch.target(et(DAY, 15, 55, 20), DAY, US, false);
            assertThat(close.timing()).isEqualTo(PaperBooks.NEXT_CLOSE);
            assertThat(StopWatch.target(et(DAY, 15, 52, 20), DAY, US, false).timing()).as("T 15:54").isEqualTo(PaperBooks.MARKET);
        }

        @Test
        @DisplayName("한국은 15:20부터 종가, 수능일 첫 분은 10:10")
        void kr() {
            assertThat(StopWatch.target(kst(DAY, 15, 17, 20), DAY, KR, true).timing()).as("T 15:19").isEqualTo(PaperBooks.MARKET);
            assertThat(StopWatch.target(kst(DAY, 15, 18, 20), DAY, KR, true).timing()).as("T 15:20").isEqualTo(PaperBooks.NEXT_CLOSE);
            StopWatch.Target exam = StopWatch.target(kst(EXAM, 10, 5, 30), EXAM, KR, true);
            assertThat(exam.timing()).isEqualTo(PaperBooks.AT_MINUTE);
            assertThat(exam.targetLocal()).isEqualTo(LocalTime.of(10, 10));
        }
    }
}
