package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 미국 1b_calendar 컨센서스 층(v2 2단계 명세 §4-12·K22, E1b) — 대응표, 그 날 한 줄일 때만 붙임(같은 이름 두 줄은 가를 수 없음), 수집 범위 밖·
 * 받지 못한 날·이름 없음의 사유, 결정 순간 전에 받은 날의 발표치만, 이어받은 날·단위 어긋남 주의. 줄 이름·값은 2026-10-28 로컬 저장본
 * {@code calendar.us_consensus}(읽기 전용)에서 옮긴 Nasdaq 미국 행입니다.
 */
class CalendarConsensusTest {

    private static final LocalDate FOMC_DAY = LocalDate.of(2026, 10, 28);
    private static final LocalDate GDP_DAY = LocalDate.of(2026, 10, 29);
    private static final LocalDate JOBS_DAY = LocalDate.of(2026, 11, 6);
    private static final LocalDate CPI_DAY = LocalDate.of(2026, 11, 10);
    /** 동부 10-28 08:57 수집(KST 21:57 — 서버 창 첫 slow). */
    private static final Instant FETCHED = Instant.parse("2026-10-28T12:57:51Z");
    /** 10-27 기준 미국 결정 순간(10-28 07:30 KST). */
    private static final Instant DECISION = Instant.parse("2026-10-27T22:30:00Z");
    private static final CalendarWindow.Window HORIZON = new CalendarWindow.Window(FOMC_DAY, LocalDate.of(2026, 11, 15));

    private static CalendarConsensus.Line line(String name, Double forecast, Double previous, String unit) {
        return new CalendarConsensus.Line(name, forecast, previous, null, unit, false);
    }

    private static CalendarWindow.Row fomc(LocalDate date) {
        return new CalendarWindow.Row(date, CalendarWindow.FOMC, "FOMC 성명", null, null, "fed", null, null);
    }

    private static CalendarWindow.Row release(LocalDate date, int id) {
        return new CalendarWindow.Row(date, CalendarWindow.RELEASE, "release " + id, null, null, "fred", null, id);
    }

    /** 저장본의 날 넷(10-28 FOMC·10-29 GDP·PCE·11-06 고용 전날 값만·11-10 CPI 전월비·전년비). */
    private static CalendarConsensus.Stored stored() {
        Map<LocalDate, CalendarConsensus.Day> days = new LinkedHashMap<>();
        days.put(FOMC_DAY, new CalendarConsensus.Day(List.of(
                line("FOMC Statement", null, null, null),
                line("Fed Interest Rate Decision", 4.0, 4.0, "%"),
                line("FOMC Press Conference", null, null, null)), FETCHED, false));
        days.put(GDP_DAY, new CalendarConsensus.Day(List.of(
                line("Core PCE Price Index", 0.3, 0.2, "%"),
                line("Core PCE Price Index", 3.1, 3.0, "%"),
                line("GDP", 3.2, 2.2, "%"),
                line("GDP Price Index", 3.5, 6.1, "%"),
                line("PCE price index", 0.5, 0.3, "%"),
                line("PCE Price index", null, 3.4, "%")), FETCHED, false));
        days.put(JOBS_DAY, new CalendarConsensus.Day(List.of(
                line("Nonfarm Payrolls", null, 29.0, "K"),
                line("Unemployment Rate", null, 4.2, "%")), FETCHED, false));
        days.put(CPI_DAY, new CalendarConsensus.Day(List.of(
                line("Core CPI", null, 2.6, "%"),
                line("Core CPI", null, 0.3, "%"),
                line("CPI", null, 0.6, "%"),
                line("CPI", null, 3.7, "%")), FETCHED, false));
        return new CalendarConsensus.Stored(days, HORIZON);
    }

    @Test
    @DisplayName("대응표 — FOMC는 금리 결정, 발표일은 FRED 릴리스 번호로(CPI 10·고용 50·GDP 53·PCE 54), 실적·모르는 번호는 없음")
    void table() {
        assertThat(CalendarConsensus.target(fomc(FOMC_DAY))).isEqualTo("Fed Interest Rate Decision");
        assertThat(CalendarConsensus.RELEASE_NAMES).containsExactly(Map.entry(10, "CPI"), Map.entry(50, "Nonfarm Payrolls"),
                Map.entry(53, "GDP"), Map.entry(54, "Core PCE Price Index"));
        assertThat(CalendarConsensus.target(release(GDP_DAY, 53))).isEqualTo("GDP");
        assertThat(CalendarConsensus.target(release(GDP_DAY, 99))).isNull();
        assertThat(CalendarConsensus.target(new CalendarWindow.Row(GDP_DAY, CalendarWindow.RELEASE, "GDP", null, null,
                "fred", null, null))).as("번호 없는 발표일 줄은 이름으로 짐작하지 않음").isNull();
        assertThat(CalendarConsensus.target(new CalendarWindow.Row(GDP_DAY, CalendarWindow.EARNINGS, "AMZN", "AMC", false,
                "yf", null))).isNull();
    }

    @Test
    @DisplayName("그 날 그 이름이 한 줄이면 붙임 — FOMC 4.00%·GDP 3.2%(예상)·고용(예상 아직 없음 → null, 직전 29K)")
    void uniqueLineAttaches() {
        CalendarConsensus.Match fed = CalendarConsensus.match(stored(), fomc(FOMC_DAY), DECISION);
        assertThat(fed).isEqualTo(new CalendarConsensus.Match("Fed Interest Rate Decision", 4.0, 4.0, null, "%", null));
        assertThat(CalendarConsensus.match(stored(), release(GDP_DAY, 53), DECISION))
                .isEqualTo(new CalendarConsensus.Match("GDP", 3.2, 2.2, null, "%", null));
        assertThat(CalendarConsensus.match(stored(), release(JOBS_DAY, 50), DECISION))
                .isEqualTo(new CalendarConsensus.Match("Nonfarm Payrolls", null, 29.0, null, "K", null));
    }

    @Test
    @DisplayName("같은 이름 두 줄(전월비·전년비 라벨 없음)은 가를 수 없어 붙이지 않음 — CPI·Core PCE, 대소문자만 다른 줄도 같은 이름")
    void duplicatesAreAmbiguous() {
        CalendarConsensus.Match cpi = CalendarConsensus.match(stored(), release(CPI_DAY, 10), DECISION);
        assertThat(cpi.name()).isNull();
        assertThat(cpi.forecast()).isNull();
        assertThat(cpi.previous()).isNull();
        assertThat(cpi.note()).isEqualTo("그 날 Nasdaq 'CPI' 줄 2개(전월비·전년비 같은 라벨 없음) — 어느 값인지 가를 수 없어 붙이지 않음");
        assertThat(CalendarConsensus.match(stored(), release(GDP_DAY, 54), DECISION).note()).contains("'Core PCE Price Index' 줄 2개");
        // 'PCE price index'·'PCE Price index'는 대소문자만 다름 — 같은 이름으로 셉니다(대소문자로 전월비·전년비를 가르지 않음).
        assertThat(CalendarConsensus.normalize("PCE price index")).isEqualTo(CalendarConsensus.normalize(" PCE  Price index "));
    }

    @Test
    @DisplayName("못 붙인 사유 — 수집 범위 밖·그 날 받지 못함·그 이름 없음·대응표 밖, 저장본이 없으면 사유 없이 비움(섹션이 한 번 적음)")
    void reasons() {
        CalendarConsensus.Stored s = stored();
        assertThat(CalendarConsensus.match(s, fomc(LocalDate.of(2026, 12, 9)), DECISION))
                .isEqualTo(new CalendarConsensus.Match(null, null, null, null, null, "컨센서스 수집 범위 밖(2026-10-28~2026-11-15)"));
        assertThat(CalendarConsensus.match(s, release(LocalDate.of(2026, 11, 13), 10), DECISION).note())
                .isEqualTo("그 날 컨센서스를 받지 못함");
        assertThat(CalendarConsensus.match(s, release(FOMC_DAY, 53), DECISION).note()).isEqualTo("그 날 Nasdaq에 'GDP' 줄 없음");
        assertThat(CalendarConsensus.match(s, release(GDP_DAY, 99), DECISION).note())
                .isEqualTo("대응표에 없는 발표 — 컨센서스를 붙이지 않음");
        assertThat(CalendarConsensus.match(null, fomc(FOMC_DAY), DECISION))
                .isEqualTo(new CalendarConsensus.Match(null, null, null, null, null, null));
        // 범위를 모르면 '범위 밖'을 지어내지 않고 그 날이 없다고만 적습니다.
        CalendarConsensus.Stored noHorizon = new CalendarConsensus.Stored(s.days(), null);
        assertThat(CalendarConsensus.match(noHorizon, fomc(LocalDate.of(2026, 12, 9)), DECISION).note())
                .isEqualTo("그 날 컨센서스를 받지 못함");
    }

    @Test
    @DisplayName("발표치는 그 날을 받은 시각이 결정 순간 이하일 때만 — 결정 뒤에 받은 발표치·받은 시각 모름·결정 순간 모름은 싣지 않음")
    void actualOnlyWhenKnownByTheDecision() {
        CalendarConsensus.Line released = new CalendarConsensus.Line("GDP", 3.2, 2.2, 3.0, "%", false);
        CalendarWindow.Row gdp = release(GDP_DAY, 53);
        Instant before = DECISION.minusSeconds(60);
        CalendarConsensus.Stored early = new CalendarConsensus.Stored(Map.of(GDP_DAY,
                new CalendarConsensus.Day(List.of(released), before, false)), HORIZON);
        assertThat(CalendarConsensus.match(early, gdp, DECISION).actual()).isEqualTo(3.0);
        assertThat(CalendarConsensus.match(early, gdp, before).actual()).as("받은 순간 = 결정 순간이면 앎").isEqualTo(3.0);
        CalendarConsensus.Stored late = new CalendarConsensus.Stored(Map.of(GDP_DAY,
                new CalendarConsensus.Day(List.of(released), DECISION.plusSeconds(1), false)), HORIZON);
        CalendarConsensus.Match afterDecision = CalendarConsensus.match(late, gdp, DECISION);
        assertThat(afterDecision.actual()).isNull();
        assertThat(afterDecision.forecast()).as("예상·직전 값은 그대로").isEqualTo(3.2);
        CalendarConsensus.Stored unknown = new CalendarConsensus.Stored(Map.of(GDP_DAY,
                new CalendarConsensus.Day(List.of(released), null, false)), HORIZON);
        assertThat(CalendarConsensus.match(unknown, gdp, DECISION).actual()).isNull();
        assertThat(CalendarConsensus.match(early, gdp, null).actual()).isNull();
    }

    @Test
    @DisplayName("주의 — 이어받은 날은 값을 붙이고 사유, 단위가 서로 다른 줄은 이름만 붙이고 숫자 없음")
    void staleDayAndUnitMismatch() {
        CalendarConsensus.Stored stale = new CalendarConsensus.Stored(Map.of(FOMC_DAY, new CalendarConsensus.Day(List.of(
                line("Fed Interest Rate Decision", 4.0, 4.0, "%")), FETCHED, true)), HORIZON);
        assertThat(CalendarConsensus.match(stale, fomc(FOMC_DAY), DECISION))
                .isEqualTo(new CalendarConsensus.Match("Fed Interest Rate Decision", 4.0, 4.0, null, "%",
                        "그 날 이번 수집이 실패해 직전 수집본의 값"));
        CalendarConsensus.Stored mismatch = new CalendarConsensus.Stored(Map.of(GDP_DAY, new CalendarConsensus.Day(List.of(
                new CalendarConsensus.Line("GDP", 3.2, 2.2, null, "%", true)), FETCHED, true)), HORIZON);
        assertThat(CalendarConsensus.match(mismatch, release(GDP_DAY, 53), DECISION))
                .isEqualTo(new CalendarConsensus.Match("GDP", null, null, null, null,
                        "그 날 이번 수집이 실패해 직전 수집본의 값 · Nasdaq 값의 단위가 서로 달라 숫자를 싣지 않음"));
    }
}
