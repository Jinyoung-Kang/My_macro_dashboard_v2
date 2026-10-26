package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 교차 검증 판정 규칙 회귀 테스트.
 *
 * <p>가장 중요한 성질: <b>"확인 못 함"을 "일치"로 위장하지 않는다.</b>
 * 키가 없거나 수집이 실패해 비교를 못 한 것을 일치로 표시하면 검증 자체가
 * 거짓말이 됩니다.
 */
class VerificationTest {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    @Test
    @DisplayName("허용 오차 안이면 일치")
    void matchesWithinTolerance() {
        Verification.Result result = Verification.compare(
                "선물 종가",
                List.of(
                        new Verification.Reading("KRX", true, 1088.30, ""),
                        new Verification.Reading("KIS", true, 1088.35, "")),
                Verification.TOLERANCE_PRICE_PCT, null);

        assertThat(result.verdict()).isEqualTo(Verification.MATCH);
        assertThat(result.label()).isEqualTo("일치");
    }

    @Test
    @DisplayName("허용 오차를 넘으면 불일치")
    void mismatchOutsideTolerance() {
        Verification.Result result = Verification.compare(
                "선물 종가",
                List.of(
                        new Verification.Reading("KRX", true, 1088.30, ""),
                        new Verification.Reading("KIS", true, 1100.00, "")),
                Verification.TOLERANCE_PRICE_PCT, null);

        assertThat(result.verdict()).isEqualTo(Verification.MISMATCH);
        assertThat(result.note()).contains("서로 다른 값");
    }

    @Test
    @DisplayName("비교할 값이 하나뿐이고 실패도 없으면 '확인 못 함' (일치가 아님)")
    void singleReadingIsSkippedNotMatch() {
        Verification.Result result = Verification.compare(
                "선물 종가",
                List.of(new Verification.Reading("KRX", true, 1088.30, "")),
                Verification.TOLERANCE_PRICE_PCT, "KIS 키가 없습니다.");

        assertThat(result.verdict()).isEqualTo(Verification.SKIPPED);
        assertThat(result.verdict()).isNotEqualTo(Verification.MATCH);
        assertThat(result.note()).isEqualTo("KIS 키가 없습니다.");
    }

    @Test
    @DisplayName("한쪽이 수집 실패면 '수집 실패' (일치가 아님)")
    void failedReadingIsError() {
        Verification.Result result = Verification.compare(
                "선물 종가",
                List.of(
                        new Verification.Reading("KRX", true, 1088.30, ""),
                        Verification.Reading.failed("KIS", "토큰 발급 실패")),
                Verification.TOLERANCE_PRICE_PCT, null);

        assertThat(result.verdict()).isEqualTo(Verification.ERROR);
        assertThat(result.label()).isEqualTo("수집 실패");
    }

    @Test
    @DisplayName("장중에는 시세 대조를 하지 않는다 (KRX=확정 종가, KIS=현재가)")
    void priceComparisonIsGatedDuringSession() {
        ZonedDateTime duringSession = ZonedDateTime.of(
                LocalDateTime.of(2026, 9, 11, 11, 0), KST);

        Verification.Gate gate = Verification.settledGate(duringSession);

        assertThat(gate.allowed()).isFalse();
        assertThat(gate.reason()).contains("장중");
    }

    @Test
    @DisplayName("평일 공휴일은 장중이 아니다 — KRX 확정치가 있으므로 대조한다")
    void holidayIsSettled() {
        ZonedDateTime holidayMorning = ZonedDateTime.of(
                LocalDateTime.of(2026, 1, 1, 11, 0), KST);   // 목요일, 신정

        assertThat(Verification.settledGate(holidayMorning, false).allowed())
                .as("공휴일을 모르면 장중으로 봄").isFalse();
        Verification.Gate gate = Verification.settledGate(holidayMorning, true);
        assertThat(gate.allowed()).isTrue();
        assertThat(gate.reason()).contains("공휴일");
    }

    @Test
    @DisplayName("장 마감 후에는 시세 대조가 가능하다")
    void priceComparisonAllowedAfterClose() {
        ZonedDateTime afterClose = ZonedDateTime.of(
                LocalDateTime.of(2026, 9, 11, 17, 0), KST);

        assertThat(Verification.settledGate(afterClose).allowed()).isTrue();
    }

    @Test
    @DisplayName("주말은 확정 데이터라 대조 가능")
    void weekendIsSettled() {
        ZonedDateTime saturday = ZonedDateTime.of(
                LocalDateTime.of(2026, 9, 12, 10, 0), KST);

        assertThat(Verification.settledGate(saturday).allowed()).isTrue();
    }

    @Test
    @DisplayName("QA-111: KRX 연말 휴장일(평일인 12-31)은 장중이 아니다 — 확정 대조는 되고 장중 가집계 대조는 안 된다")
    void yearEndClosureIsNotASession() {
        ZonedDateTime yearEnd = ZonedDateTime.of(LocalDateTime.of(2026, 12, 31, 11, 0), KST);   // 목요일

        Verification.Gate settled = Verification.settledGate(yearEnd);
        assertThat(settled.allowed()).isTrue();
        assertThat(settled.reason()).contains("휴장");
        assertThat(Verification.intradayGate(yearEnd).allowed()).isFalse();
        // 주말인 12-31은 그냥 주말입니다.
        assertThat(Verification.settledGate(ZonedDateTime.of(LocalDateTime.of(2028, 12, 31, 11, 0), KST)).reason())
                .contains("주말");
    }

    @Test
    @DisplayName("QA-143: 12-31이 주말이면 직전 금요일이 연말휴장일 — 2028-12-29(금) 장중은 확정 대조가 되고 장중 가집계 대조는 안 된다")
    void yearEndClosureMovesBeforeWeekend() {
        ZonedDateTime closure = ZonedDateTime.of(LocalDateTime.of(2028, 12, 29, 11, 0), KST);   // 12-31이 일요일

        Verification.Gate settled = Verification.settledGate(closure);
        assertThat(settled.allowed()).isTrue();
        assertThat(settled.reason()).contains("휴장");
        assertThat(Verification.intradayGate(closure).allowed()).isFalse();
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2028, 12, 29))).isTrue();
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2028, 12, 28))).isFalse();
        assertThat(Verification.intradayGate(ZonedDateTime.of(LocalDateTime.of(2028, 12, 28, 11, 0), KST)).allowed())
                .as("그 전날은 정규장").isTrue();
        // KRX 휴장일 목록의 실례(2022-12-30 — 12-31 토, 2023-12-29 — 12-31 일).
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2022, 12, 30))).isTrue();
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2023, 12, 29))).isTrue();
    }

    @Test
    @DisplayName("QA-143: 공휴일 목록을 받으면 대체 조건은 주말·공휴일 — 12-31(월)이 공휴일이면 12-28(금)이 연말휴장일(가상의 2029)")
    void yearEndClosureSkipsHolidaysWithList() {
        ZonedDateTime friday = ZonedDateTime.of(LocalDateTime.of(2029, 12, 28, 11, 0), KST);
        java.util.Set<LocalDate> holidays = java.util.Set.of(LocalDate.of(2029, 12, 25), LocalDate.of(2029, 12, 31));

        assertThat(Verification.settledGate(friday, holidays).reason()).contains("연말 휴장");
        assertThat(Verification.intradayGate(friday, holidays).allowed()).isFalse();
        assertThat(Verification.settledGate(ZonedDateTime.of(LocalDateTime.of(2029, 12, 31, 11, 0), KST), holidays)
                .reason()).as("12-31 자신은 공휴일").contains("공휴일");
        assertThat(Verification.intradayGate(friday, java.util.Set.of()).allowed()).as("목록이 없으면 정규장").isTrue();
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2029, 12, 28), holidays)).isTrue();
        assertThat(Verification.isKrxYearEndClosure(LocalDate.of(2029, 12, 31), java.util.Set.of())).isTrue();
    }

    @Test
    @DisplayName("수급 대조는 시간 조건이 정반대 — 정규장에만 가능")
    void rankingComparisonRequiresRegularSession() {
        ZonedDateTime duringSession = ZonedDateTime.of(
                LocalDateTime.of(2026, 9, 11, 11, 0), KST);
        ZonedDateTime afterClose = ZonedDateTime.of(
                LocalDateTime.of(2026, 9, 11, 17, 0), KST);

        assertThat(Verification.intradayGate(duringSession).allowed()).isTrue();
        assertThat(Verification.intradayGate(afterClose).allowed()).isFalse();
        assertThat(Verification.intradayGate(afterClose).reason()).contains("장중 전용");
    }

    @Test
    @DisplayName("리포트 요약은 판정별 건수를 섞지 않는다")
    void reportCountsEachVerdictSeparately() {
        Verification.Report report = Verification.Report.of("2026-09-11T17:00:00+09:00", List.of(
                Verification.compare("A", List.of(
                        new Verification.Reading("x", true, 1.0, ""),
                        new Verification.Reading("y", true, 1.0, "")), 0.5, null),
                Verification.compare("B", List.of(
                        new Verification.Reading("x", true, 1.0, ""),
                        new Verification.Reading("y", true, 2.0, "")), 0.5, null),
                Verification.skipped("C", "장중입니다"),
                Verification.compare("D", List.of(
                        Verification.Reading.failed("x", "실패"),
                        new Verification.Reading("y", true, 1.0, "")), 0.5, null)));

        assertThat(report.matchCount()).isEqualTo(1);
        assertThat(report.mismatchCount()).isEqualTo(1);
        assertThat(report.skippedCount()).isEqualTo(1);
        assertThat(report.errorCount()).isEqualTo(1);
        assertThat(report.headline()).isEqualTo("일치 1 · 불일치 1 · 수집 실패 1 · 확인 못 함 1");
    }

    // =========================================================================
    // 기준일 게이트 — 다른 날의 값을 비교하고 "불일치"라고 말하면 안 됩니다.
    // =========================================================================
    // 실제로 화면에 떴던 오보고입니다.
    //   KOSPI200 선물 종가 — KRX 1,039.80 (기준일 2026-09-15) vs KIS 1,061.15
    //   → "불일치 · 차이 2.053%"
    // KRX 확정치가 하루 늦게 올라오는 동안 KIS는 최신값을 줍니다. 즉 갈라진 게
    // 아니라 서로 다른 날을 본 것입니다. 이걸 불일치로 세면 KRX가 밀리는 날마다
    // 매번 거짓 경보가 울리고, 진짜 불일치가 묻힙니다.

    @Test
    @DisplayName("기준일이 다르면 불일치가 아니라 '확인 못 함'")
    void differentAsOfDatesAreNotMismatch() {
        Verification.Result result = Verification.compare(
                "KOSPI200 현물 지수",
                List.of(
                        Verification.Reading.dated("KRX Open API", 1042.46, "", "2026-09-15"),
                        Verification.Reading.dated("yfinance ^KS200", 1053.30, "", "2026-09-16")),
                Verification.TOLERANCE_PRICE_PCT, null, "2026-09-16");

        assertThat(result.verdict()).isEqualTo(Verification.SKIPPED);
        assertThat(result.label()).isEqualTo("확인 못 함");
        assertThat(result.note()).contains("기준일이 서로 다릅니다");
    }

    @Test
    @DisplayName("기준일을 아는 값이 최신 거래일보다 오래되면 '확인 못 함'")
    void staleReadingAgainstLatestSourceIsNotMismatch() {
        // KIS는 기준일을 주지 않습니다(현재가). KRX 저장본만 09-15이고
        // 이번 검증의 최신 거래일은 09-16 → 비교 자체가 성립하지 않습니다.
        Verification.Result result = Verification.compare(
                "KOSPI200 선물 종가",
                List.of(
                        Verification.Reading.dated("KRX (화면이 쓰는 값)", 1039.80, "", "2026-09-15"),
                        new Verification.Reading("KIS Open API", true, 1061.15, "")),
                Verification.TOLERANCE_PRICE_PCT, null, "2026-09-16");

        assertThat(result.verdict()).isEqualTo(Verification.SKIPPED);
        assertThat(result.note()).contains("2026-09-15").contains("2026-09-16");
        assertThat(result.note()).contains("make collect");
    }

    @Test
    @DisplayName("기준일이 같으면 평소대로 판정한다 — 게이트가 검증을 무력화하면 안 됨")
    void sameAsOfStillJudgesNormally() {
        Verification.Result match = Verification.compare(
                "KOSPI200 선물 종가",
                List.of(
                        Verification.Reading.dated("KRX", 1088.30, "", "2026-09-16"),
                        Verification.Reading.dated("KIS", 1088.35, "", "2026-09-16")),
                Verification.TOLERANCE_PRICE_PCT, null, "2026-09-16");
        assertThat(match.verdict()).isEqualTo(Verification.MATCH);

        Verification.Result mismatch = Verification.compare(
                "KOSPI200 선물 종가",
                List.of(
                        Verification.Reading.dated("KRX", 1000.00, "", "2026-09-16"),
                        Verification.Reading.dated("KIS", 1100.00, "", "2026-09-16")),
                Verification.TOLERANCE_PRICE_PCT, null, "2026-09-16");
        assertThat(mismatch.verdict())
                .as("진짜 갈라진 값은 여전히 불일치여야 합니다")
                .isEqualTo(Verification.MISMATCH);
    }

    @Test
    @DisplayName("기준일을 아무도 모르면 종전대로 판정한다")
    void noAsOfKeepsOldBehaviour() {
        Verification.Result result = Verification.compare(
                "선물 종가",
                List.of(
                        new Verification.Reading("KRX", true, 1000.00, ""),
                        new Verification.Reading("KIS", true, 1100.00, "")),
                Verification.TOLERANCE_PRICE_PCT, null, "2026-09-16");

        assertThat(result.verdict()).isEqualTo(Verification.MISMATCH);
    }

}
