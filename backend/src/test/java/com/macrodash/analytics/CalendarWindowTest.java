package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 일정 섹션 1b_calendar의 창과 줄 고르기. 거시 일정 날짜는 2026-10-25 단계 0에서 FRED·연준 일정표로 확인한 값(명세 §10)이고,
 * 창 끝은 NYSE 휴장일(추수감사절 2026-11-26)을 넣어 손으로 센 거래일입니다.
 */
class CalendarWindowTest {

    private static final String FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
    private static final String YF = "yfinance quoteSummary calendarEvents";

    private static LocalDate d(String iso) {
        return LocalDate.parse(iso);
    }

    private static CalendarWindow.MacroEvent fomc(String date, boolean sep) {
        return new CalendarWindow.MacroEvent("FOMC 회의", d(date), CalendarWindow.FOMC, null, FOMC_URL, sep, null);
    }

    private static CalendarWindow.MacroEvent release(String name, int id, String date) {
        return new CalendarWindow.MacroEvent(name, d(date), CalendarWindow.RELEASE, id, "FRED release " + id, null,
                false);
    }

    private static CalendarWindow.Earnings earnings(String ticker, String date, String session, Boolean estimated) {
        return new CalendarWindow.Earnings(ticker, date == null ? null : d(date), null, session, estimated, YF, false);
    }

    /** 단계 0의 2026 하반기 일정(FOMC 상수 일부 + FRED 네 릴리스). */
    private static List<CalendarWindow.MacroEvent> stepZeroMacro() {
        List<CalendarWindow.MacroEvent> out = new ArrayList<>();
        out.add(fomc("2026-10-28", false));
        out.add(fomc("2026-12-09", true));
        out.add(fomc("2027-01-27", false));
        out.add(release("GDP", 53, "2026-10-29"));
        out.add(release("PCE", 54, "2026-10-29"));
        out.add(release("고용", 50, "2026-11-06"));
        out.add(release("CPI", 10, "2026-11-10"));
        out.add(release("GDP", 53, "2026-11-25"));
        out.add(release("PCE", 54, "2026-11-25"));
        out.add(release("고용", 50, "2026-12-04"));
        out.add(release("CPI", 10, "2026-12-10"));
        out.add(release("GDP", 53, "2026-12-23"));
        out.add(release("PCE", 54, "2026-12-23"));
        return out;
    }

    private static Map<String, LocalDate> lastKnown(String cpi, String pce, String jobs, String gdp) {
        Map<String, LocalDate> out = new LinkedHashMap<>();
        out.put("CPI", cpi == null ? null : d(cpi));
        out.put("PCE", pce == null ? null : d(pce));
        out.put("고용", jobs == null ? null : d(jobs));
        out.put("GDP", gdp == null ? null : d(gdp));
        return out;
    }

    private static CalendarWindow.Stored stored(List<CalendarWindow.MacroEvent> macro, String fredStatus,
                                                Map<String, LocalDate> lastKnown, List<CalendarWindow.Earnings> items) {
        Map<String, CalendarWindow.Earnings> byTicker = new LinkedHashMap<>();
        items.forEach(e -> byTicker.put(e.ticker(), e));
        return new CalendarWindow.Stored(macro, fredStatus, lastKnown, null, FOMC_URL, "2026-10-25", d("2027-12-08"),
                byTicker, byTicker.size(), 400, null);
    }

    /** 단계 0 일정을 {@code from}~{@code to}(수집기 macro.horizon)에 수집한 저장본 — 거시 일정은 그 범위 안만. */
    private static CalendarWindow.Stored collectedOver(String from, String to) {
        CalendarWindow.Window horizon = new CalendarWindow.Window(d(from), d(to));
        List<CalendarWindow.MacroEvent> inside = stepZeroMacro().stream().filter(e -> horizon.contains(e.date())).toList();
        return new CalendarWindow.Stored(inside, "ok", lastKnown("2026-12-10", "2026-12-23", "2026-12-04",
                "2026-12-23"), null, FOMC_URL, "2026-10-25", d("2027-12-08"), Map.of(), 0, 400, horizon);
    }

    private static CalendarWindow.Stored stepZero(List<CalendarWindow.Earnings> items) {
        return stored(stepZeroMacro(), "ok", lastKnown("2026-12-10", "2026-12-23", "2026-12-04", "2026-12-23"), items);
    }

    private static List<String> names(CalendarWindow.Result r) {
        return r.rows().stream().map(row -> row.date() + " " + row.kind() + " " + row.name()).toList();
    }

    @Test
    @DisplayName("창 — 기준일 다음 세션부터 10거래일째까지, 휴장일(추수감사절)은 세지 않음")
    void windowEdges() {
        // 금요일 기준 → 다음 월요일부터. 11-26(목) 추수감사절을 건너뛰어 10번째 세션은 12-07(월).
        CalendarWindow.Window thanksgiving = CalendarWindow.window(d("2026-11-20"));
        assertThat(thanksgiving.from()).isEqualTo(d("2026-11-23"));
        assertThat(thanksgiving.to()).isEqualTo(d("2026-12-07"));
        assertThat(UsMarketCalendar.tradingDaysBetween(d("2026-11-20"), thanksgiving.to()))
                .isEqualTo(CalendarWindow.TRADING_DAYS);

        // 초기 결정 기준일(2026-10-23 금) → 10-26 … 11-06.
        CalendarWindow.Window initial = CalendarWindow.window(d("2026-10-23"));
        assertThat(initial.from()).isEqualTo(d("2026-10-26"));
        assertThat(initial.to()).isEqualTo(d("2026-11-06"));

        // 휴장일 전날 기준 → 다음 세션이 휴장일을 건너뜀(11-25 수 → 11-27 금).
        assertThat(CalendarWindow.window(d("2026-11-25")).from()).isEqualTo(d("2026-11-27"));

        assertThatThrownBy(() -> CalendarWindow.window(null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    @DisplayName("창 밖은 넣지 않음 — 기준일 당일·다음 세션 앞 주말·창 끝 다음 날은 빠지고, 다음 세션·창 끝 날은 들어감")
    void outsideWindowExcluded() {
        List<CalendarWindow.MacroEvent> macro = List.of(
                release("기준일", 1, "2026-11-20"),        // 기준일 당일(장 마감 뒤 결정 — 이미 가격에 들어감)
                release("토요일", 2, "2026-11-21"),        // 기준일 뒤지만 다음 세션 앞
                release("첫 세션", 3, "2026-11-23"),
                release("추수감사절", 4, "2026-11-26"),    // 창 안의 휴장일 — 날짜로는 창 안
                release("창 끝", 5, "2026-12-07"),
                release("창 끝 다음 날", 6, "2026-12-08"),
                fomc("2026-12-09", true));
        CalendarWindow.Result r = CalendarWindow.compute(
                stored(macro, "ok", Map.of(), List.of(
                        earnings("AAA", "2026-11-23", "BMO", false),
                        earnings("BBB", "2026-12-07", "AMC", false),
                        earnings("CCC", "2026-12-08", "AMC", false),   // 창 뒤 — 알려진 일정이라 어느 목록에도 없음
                        earnings("DDD", "2026-11-20", "AMC", false))), // 기준일 당일 — 창 앞(다음 일정 미정)
                d("2026-11-20"), List.of("AAA", "BBB", "CCC", "DDD"));

        assertThat(names(r)).containsExactly(
                "2026-11-23 RELEASE 첫 세션",
                "2026-11-23 EARNINGS AAA",
                "2026-11-26 RELEASE 추수감사절",
                "2026-12-07 RELEASE 창 끝",
                "2026-12-07 EARNINGS BBB");
        assertThat(r.earningsUndetermined()).containsExactly("DDD");
        assertThat(r.earningsMissing()).isEmpty();
        assertThat(r.rows()).allSatisfy(row -> assertThat(r.window().contains(row.date())).isTrue());
    }

    @Test
    @DisplayName("단계 0 일정, 기준일 2026-10-23 — FOMC 10-28 → GDP·PCE 10-29 → 고용 11-06, CPI 11-10은 창 밖")
    void stepZeroInitialWindow() {
        CalendarWindow.Result r = CalendarWindow.compute(stepZero(List.of(
                earnings("AMZN", "2026-10-29", "AMC", false),
                earnings("AMD", "2026-11-03", null, false))), d("2026-10-23"), List.of("AMZN", "AMD"));
        assertThat(names(r)).containsExactly(
                "2026-10-28 FOMC FOMC 회의",
                "2026-10-29 RELEASE GDP",
                "2026-10-29 RELEASE PCE",
                "2026-10-29 EARNINGS AMZN",
                "2026-11-03 EARNINGS AMD",
                "2026-11-06 RELEASE 고용");
        assertThat(r.available()).isTrue();
        assertThat(r.missingReason()).isNull();
        assertThat(r.macroCount()).isEqualTo(4);
        assertThat(r.earningsCount()).isEqualTo(2);
        assertThat(r.unpublishedAfter()).isEmpty();
        assertThat(r.fomcPastConstant()).isFalse();
        // 거시 일정은 장 구분·추정 여부가 없음(공식 일정표) — 0·false가 아니라 null.
        assertThat(r.rows().get(0).session()).isNull();
        assertThat(r.rows().get(0).isEstimated()).isNull();
        assertThat(r.rows().get(0).source()).isEqualTo(FOMC_URL);
        // 발표일 줄은 저장본의 FRED 릴리스 번호를 그대로 들고(컨센서스 층의 열쇠 — E1b), FOMC·실적 줄은 null.
        assertThat(r.rows()).extracting(CalendarWindow.Row::releaseId).containsExactly(null, 53, 54, null, null, 50);
    }

    @Test
    @DisplayName("FRED 키 미설정 — 발표일 없이도 FOMC 상수와 실적일은 그대로 실림")
    void fredKeyMissingKeepsFomc() {
        List<CalendarWindow.MacroEvent> fomcOnly = List.of(fomc("2026-10-28", false), fomc("2026-12-09", true));
        CalendarWindow.Result r = CalendarWindow.compute(
                stored(fomcOnly, "키 미설정", Map.of(), List.of(earnings("AMZN", "2026-10-29", "AMC", false))),
                d("2026-10-23"), List.of("AMZN"));
        assertThat(names(r)).containsExactly("2026-10-28 FOMC FOMC 회의", "2026-10-29 EARNINGS AMZN");
        // 받은 릴리스가 없으면 '미공개' 목록도 비움 — 키 미설정은 fredStatus가 말함.
        assertThat(r.unpublishedAfter()).isEmpty();
    }

    @Test
    @DisplayName("창 끝이 lastKnownDate 뒤면 그 릴리스는 '일정 미공개' — 받은 날짜가 없는 릴리스도")
    void unpublishedAfterLastKnownDate() {
        Map<String, LocalDate> known = lastKnown("2026-12-10", "2026-12-23", null, "2026-12-23");
        // 2026-12-04 기준 → 창 끝 12-18: CPI(12-10)는 지남, PCE·GDP(12-23)는 아님, 고용은 받은 날짜 없음.
        CalendarWindow.Result r = CalendarWindow.compute(stored(stepZeroMacro(), "ok", known, List.of()),
                d("2026-12-04"), List.of());
        assertThat(r.window().to()).isEqualTo(d("2026-12-18"));
        Map<String, LocalDate> expected = new LinkedHashMap<>();
        expected.put("CPI", d("2026-12-10"));
        expected.put("고용", null);
        assertThat(r.unpublishedAfter()).containsExactlyEntriesOf(expected);
        assertThat(names(r)).containsExactly("2026-12-09 FOMC FOMC 회의 (SEP)", "2026-12-10 RELEASE CPI");

        // 창 끝이 lastKnownDate와 같은 날이면 아직 '확인한 범위 안'.
        CalendarWindow.Result edge = CalendarWindow.compute(
                stored(List.of(), "ok", Map.of("CPI", d("2026-12-07")), List.of()), d("2026-11-20"), List.of());
        assertThat(edge.unpublishedAfter()).isEmpty();
    }

    @Test
    @DisplayName("FOMC 상수 끝(2027-12-08)을 창 끝이 넘으면 fomcPastConstant, 끝을 모르면 null")
    void fomcConstantEnd() {
        CalendarWindow.Stored s = stepZero(List.of());
        // 2027 추수감사절은 11-25 — 11-23(화) 기준 창 끝 12-08(상수 끝과 같은 날), 11-24(수) 기준 창 끝 12-09.
        assertThat(CalendarWindow.window(d("2027-11-23")).to()).isEqualTo(d("2027-12-08"));
        assertThat(CalendarWindow.compute(s, d("2027-11-23"), List.of()).fomcPastConstant()).isFalse();
        assertThat(CalendarWindow.window(d("2027-11-24")).to()).isEqualTo(d("2027-12-09"));
        assertThat(CalendarWindow.compute(s, d("2027-11-24"), List.of()).fomcPastConstant()).isTrue();
        CalendarWindow.Stored noConstant = new CalendarWindow.Stored(List.of(), "ok", Map.of(), null, null, null, null,
                Map.of(), null, null, null);
        assertThat(CalendarWindow.compute(noConstant, d("2027-11-26"), List.of()).fomcPastConstant()).isNull();
    }

    @Test
    @DisplayName("창이 저장본의 수집 범위(horizon) 밖이면 outsideHorizon — 그 밖의 거시 일정은 '0건'이 아니라 확인 못 함, 범위를 모르면 null")
    void outsideStoredHorizon() {
        // 2026-10-25에 수집하고 굳은 저장본(10-25~12-09 — 수집기가 계속 실패). 2027-01-15 기준 창에는 01-27 FOMC가 있지만 저장본에
        // 없습니다. 상수 끝(2027-12-08)만 보면 'FOMC ok'로 실려 회의가 말없이 빠졌습니다.
        CalendarWindow.Stored frozen = collectedOver("2026-10-25", "2026-12-09");
        CalendarWindow.Result late = CalendarWindow.compute(frozen, d("2027-01-15"), List.of());
        assertThat(late.window().contains(d("2027-01-27"))).isTrue();
        assertThat(late.rows()).isEmpty();
        assertThat(late.outsideHorizon()).isTrue();
        assertThat(late.fomcPastConstant()).as("상수 끝과는 따로 판단").isFalse();

        // 창 끝이 범위 끝과 같은 날이면 안(11-24 기준 창 끝 12-09 — 11-26 추수감사절), 하루 넘으면 밖.
        assertThat(CalendarWindow.window(d("2026-11-24")).to()).isEqualTo(d("2026-12-09"));
        assertThat(CalendarWindow.compute(frozen, d("2026-11-24"), List.of()).outsideHorizon()).isFalse();
        assertThat(CalendarWindow.compute(frozen, d("2026-11-25"), List.of()).outsideHorizon()).isTrue();
        assertThat(CalendarWindow.compute(frozen, d("2026-10-23"), List.of()).outsideHorizon()).isFalse();

        // 창 앞이 범위 앞보다 이르면(초기 결정 패킷을 수집이 지난 뒤 다시 만듦 — 지난 일정은 저장본에서 빠짐) 밖.
        assertThat(CalendarWindow.compute(collectedOver("2026-11-02", "2026-12-17"), d("2026-10-23"), List.of())
                .outsideHorizon()).isTrue();

        // 범위를 모르면 판단하지 않음, 저장본이 없으면 null.
        assertThat(CalendarWindow.compute(stepZero(List.of()), d("2026-10-23"), List.of()).outsideHorizon()).isNull();
        assertThat(CalendarWindow.compute(null, d("2026-10-23"), List.of()).outsideHorizon()).isNull();
    }

    @Test
    @DisplayName("저장본 없음 — 줄 없이 사유만(지어낸 일정 없음)")
    void missingSnapshot() {
        CalendarWindow.Result r = CalendarWindow.compute(null, d("2026-10-23"), List.of("AMZN"));
        assertThat(r.available()).isFalse();
        assertThat(r.missingReason()).isEqualTo(CalendarWindow.NO_SNAPSHOT);
        assertThat(r.rows()).isEmpty();
        assertThat(r.unpublishedAfter()).isEmpty();
        assertThat(r.fomcPastConstant()).isNull();
        // 저장본이 없으면 종목별 '자료 없음' 목록도 만들지 않음 — 사유 한 줄이 전부를 말함.
        assertThat(r.earningsMissing()).isEmpty();
        assertThat(r.window()).isEqualTo(CalendarWindow.window(d("2026-10-23")));
    }

    @Test
    @DisplayName("실적 줄은 장 구분·추정 여부·출처·isStale을 그대로 옮김, 자료 없음·다음 일정 미정은 따로 적음")
    void earningsPassthroughAndClassification() {
        List<CalendarWindow.Earnings> items = List.of(
                earnings("AMZN", "2026-10-29", "AMC", false),
                earnings("MRK", "2026-10-30", "BMO", false),
                new CalendarWindow.Earnings("PYPL", d("2026-11-04"), null, null, true, YF, true),   // 추정치 + 이어받은 값
                // 수집기의 '다음 일정 미정' — 앞날 일정 없이 지난 날짜(lastDate)만.
                new CalendarWindow.Earnings("GOOGL", null, d("2026-10-20"), null, null, YF, false),
                earnings("META", "2026-10-22", "AMC", false),    // 받을 때는 앞날이었지만 그새 창 앞으로 지남(24시간 캐시)
                // 지난 발표일이 기준일에서는 창 안 — 초기 결정 패킷을 수집 뒤에 다시 만든 경우. 그 발표일로 한 줄.
                new CalendarWindow.Earnings("NFLX", null, d("2026-10-28"), null, null, YF, false),
                earnings("NODATE", null, null, null));           // 받았지만 날짜 없음(실적일 없음·실패) → 자료 없음
        CalendarWindow.Result r = CalendarWindow.compute(stored(List.of(), "ok", Map.of(), items), d("2026-10-23"),
                List.of("pypl", " AMZN ", "MRK", "GOOGL", "META", "NFLX", "NODATE", "UNSEEN", "", "AMZN"));

        assertThat(r.rows()).containsExactly(
                new CalendarWindow.Row(d("2026-10-28"), CalendarWindow.EARNINGS, "NFLX", null, null, YF, false),
                new CalendarWindow.Row(d("2026-10-29"), CalendarWindow.EARNINGS, "AMZN", "AMC", false, YF, false),
                new CalendarWindow.Row(d("2026-10-30"), CalendarWindow.EARNINGS, "MRK", "BMO", false, YF, false),
                new CalendarWindow.Row(d("2026-11-04"), CalendarWindow.EARNINGS, "PYPL", null, true, YF, true));
        assertThat(r.earningsUndetermined()).containsExactly("GOOGL", "META");
        assertThat(r.earningsMissing()).containsExactly("NODATE", "UNSEEN");

        // 대상이 아닌 종목은 저장본에 있어도 싣지 않음.
        CalendarWindow.Result none = CalendarWindow.compute(stored(List.of(), "ok", Map.of(), items), d("2026-10-23"),
                null);
        assertThat(none.rows()).isEmpty();
        assertThat(none.earningsMissing()).isEmpty();
    }

    @Test
    @DisplayName("결정적 순서 — 날짜 → 종류(FOMC·RELEASE·EARNINGS) → 이름, 입력·대상 순서와 무관")
    void deterministicOrder() {
        List<CalendarWindow.Earnings> items = new ArrayList<>(List.of(
                earnings("ZZZ", "2026-10-28", "BMO", false),
                earnings("AAA", "2026-10-28", "AMC", false),
                earnings("AMZN", "2026-10-29", "AMC", false)));
        List<CalendarWindow.MacroEvent> macro = new ArrayList<>(stepZeroMacro());
        macro.add(fomc("2026-10-28", false));   // 같은 일정이 두 번 — 한 줄
        CalendarWindow.Result first = CalendarWindow.compute(stored(macro, "ok", Map.of(), items), d("2026-10-23"),
                List.of("ZZZ", "AAA", "AMZN"));

        Collections.reverse(items);
        Collections.reverse(macro);
        CalendarWindow.Result second = CalendarWindow.compute(stored(macro, "ok", Map.of(), items), d("2026-10-23"),
                List.of("AMZN", "AAA", "ZZZ"));

        assertThat(second).isEqualTo(first);
        assertThat(names(first)).containsExactly(
                "2026-10-28 FOMC FOMC 회의",
                "2026-10-28 EARNINGS AAA",
                "2026-10-28 EARNINGS ZZZ",
                "2026-10-29 RELEASE GDP",
                "2026-10-29 RELEASE PCE",
                "2026-10-29 EARNINGS AMZN",
                "2026-11-06 RELEASE 고용");
    }

    @Test
    @DisplayName("경제전망(SEP) 회의는 이름에 (SEP) — 이름에 이미 있으면 덧붙이지 않음")
    void sepSuffix() {
        List<CalendarWindow.MacroEvent> macro = List.of(
                fomc("2026-12-09", true),
                new CalendarWindow.MacroEvent("FOMC 회의 · SEP", d("2026-12-09"), CalendarWindow.FOMC, null, "x", true,
                        null));
        CalendarWindow.Result r = CalendarWindow.compute(stored(macro, "ok", Map.of(), List.of()), d("2026-12-04"),
                List.of());
        assertThat(r.rows()).extracting(CalendarWindow.Row::name).containsExactly("FOMC 회의 (SEP)", "FOMC 회의 · SEP");
    }

    @Test
    @DisplayName("달력을 받는 판 — 미국 달력이면 옛 시그니처와 같고, 다른 달력이면 창을 그 달력으로 센다")
    void windowWithCalendar() {
        LocalDate asOf = d("2026-11-20");
        // 미국: 11-23 … 추수감사절(11-26)을 건너뛰어 10번째 거래일 12-07
        assertThat(CalendarWindow.window(UsMarketCalendar.CALENDAR, asOf))
                .isEqualTo(CalendarWindow.window(asOf))
                .isEqualTo(new CalendarWindow.Window(d("2026-11-23"), d("2026-12-07")));
        // 휴장일 없는 시험 달력: 11-23 … 12-04
        assertThat(CalendarWindow.window(WeekdaysCalendar.INSTANCE, asOf))
                .isEqualTo(new CalendarWindow.Window(d("2026-11-23"), d("2026-12-04")));

        CalendarWindow.Stored s = stored(stepZeroMacro(), "ok",
                lastKnown("2026-12-10", "2026-12-23", "2026-12-04", "2026-12-23"),
                List.of(earnings("AAA", "2026-12-07", "BMO", false)));
        CalendarWindow.Result us = CalendarWindow.compute(s, asOf, List.of("AAA"));
        assertThat(CalendarWindow.compute(UsMarketCalendar.CALENDAR, s, asOf, List.of("AAA"))).isEqualTo(us);
        assertThat(us.earningsCount()).isEqualTo(1);                 // 12-07은 미국 창 안
        CalendarWindow.Result weekdays = CalendarWindow.compute(WeekdaysCalendar.INSTANCE, s, asOf, List.of("AAA"));
        assertThat(weekdays.window().to()).isEqualTo(d("2026-12-04"));
        assertThat(weekdays.earningsCount()).isZero();               // 창 뒤 — 알려진 일정이라 어느 목록에도 없음
        assertThat(weekdays.earningsMissing()).isEmpty();
        assertThatThrownBy(() -> CalendarWindow.window(null, asOf)).isInstanceOf(NullPointerException.class);
    }
}
