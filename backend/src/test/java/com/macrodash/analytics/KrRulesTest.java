package com.macrodash.analytics;

import com.macrodash.analytics.KrRules.Evaluation;
import com.macrodash.analytics.KrRules.Exclusion;
import com.macrodash.analytics.KrRules.Financials;
import com.macrodash.analytics.KrRules.FlowDay;
import com.macrodash.analytics.KrRules.FlowSummary;
import com.macrodash.analytics.KrRules.Input;
import com.macrodash.analytics.KrRules.Member;
import com.macrodash.analytics.KrRules.Params;
import com.macrodash.analytics.KrRules.Reason;
import com.macrodash.analytics.KrRules.Selection;
import com.macrodash.analytics.KrRules.Target;
import com.macrodash.analytics.KrRules.Weighting;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * 한국 규칙 계좌의 후보·점수·재무 필터·비중(2단계 명세 §4-6·K7, §5 '후보·점수 산정이 손계산 고정본과 같다'·'DART·ROE 없는 종목은 후보에서
 * 빠지고 사유가 보인다'·'금융업은 부채비율로 빠지지 않는다'). 손계산 고정본: 기준 세션 D = 2026-10-27(화), U 기준일 B = 2026-10-26.
 *
 * <p>창(20 KR 거래일)은 KRX 휴장일 목록으로 셌습니다 — 2026-09-28(월)~10-27, 10-05(개천절 대체휴일)·10-09(한글날)·주말 빼고:
 * 09-28·29·30, 10-01·02·06·07·08·12·13·14·15·16·19·20·21·22·23·26·27.
 *
 * <pre>
 *  코드     순위 상장주식수   하루 외국인/기관(주)    20일 합(외/기)        점수                     재무                       판정
 *  000010   1   1,000,000    +1,000 / +500          20,000 / 10,000      30,000/1,000,000×100=3.0 ROE 10·부채 50·매출 있음   후보
 *  000020   2   4,000,000    +2,000 / +1,000        40,000 / 20,000      60,000/4,000,000×100=1.5 같음                       후보
 *  000030   3   1,000,000    +3,000 / −100          60,000 / −2,000      5.8                      같음                       수급 미달
 *  000040   4   2,000,000    +500 / +500            10,000 / 10,000      1.0                      금융(매출 없음)·부채 1,200   후보(부채비율 안 봄)
 *  000050   5   1,000,000    +100 / +100            2,000 / 2,000        0.4                      매출 있음·부채 250           재무 미달
 *  000060   6   1,000,000    +100 / +100            —                    0.4                      접수 2026-10-28 > D          자료 없음(접수일이 기준일 뒤)
 *  000070   7   1,000,000    +100 / +100(10-06 없음) 19일만               null                     좋음                       자료 부족
 *  000080   8   1,000,000    +100 / +100            —                    0.4                      DART 없음                  자료 없음
 *  000090   9   1,000,000    +100 / +100            —                    0.4                      ROE −2.5                   재무 미달
 *  000100   10  1,000,000    +100 / +100            —                    0.4                      좋음                       거래정지
 *  000110   11  1,000,000    +100 / +100            —                    0.4                      좋음                       재진입 금지
 *  000120   12  1,000,000    +100 / +100(10-22 기관 −50) 2,000 / 1,850   3,850/1,000,000×100=0.385 좋음                      후보(연속 3일)
 *  000130   13  1,000,000    +100 / +100            —                    0.4                      접수번호 10자리              자료 없음(접수일 모름)
 *  000140   14  null         +100 / +100            —                    null                     좋음                       자료 없음(상장주식수 없음)
 *  000150   15  1,000,000    +100 / +100            —                    0.4                      ROE·부채비율 없음(매출 있음) 자료 없음 둘
 *  000160   16  1,000,000    +100 / +100            —                    0.4                      자본잠식                   재무 미달
 *  000170   17  1,000,000    +100 / +100            —                    0.4                      ROE 0                      재무 미달(ROE는 0보다 커야)
 *  000180   18  1,000,000    +100 / −100            2,000 / −2,000       0.0                      부채 정확히 200(상한 포함)  수급 미달만
 * </pre>
 * 후보 = 000010(3.0) · 000020(1.5) · 000040(1.0) · 000120(0.385).
 */
class KrRulesTest {

    static final KrxCalendar CAL = new KrxCalendar(
            Map.of(2026, KrxFixtures.kasiHolidays(2026), 2027, KrxFixtures.kasiHolidays(2027)), List.of());
    static final LocalDate D = LocalDate.of(2026, 10, 27);
    static final LocalDate B = LocalDate.of(2026, 10, 26);
    /** 손으로 센 창(최근 → 과거). */
    static final List<LocalDate> WINDOW = dates("2026-10-27", "2026-10-26", "2026-10-23", "2026-10-22", "2026-10-21",
            "2026-10-20", "2026-10-19", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12",
            "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-02", "2026-10-01", "2026-09-30", "2026-09-29",
            "2026-09-28");
    static final String EVENING = "2026-10-27T20:21:26.000+09:00";

    /** 기본 규칙 값: 15종목·동일비중·연속일 끔·부채 200·종목 상한 10·남는 현금 기준 2·월 1회. */
    static final Params DEFAULTS = params(15, Weighting.EQUAL, 0, 10);

    static Params params(int maxNames, Weighting weighting, int minStreak, double cap) {
        return new Params(maxNames, weighting, minStreak, 200, cap, 2, KrReselection.Mode.MONTHLY_FIRST);
    }

    static List<LocalDate> dates(String... iso) {
        List<LocalDate> out = new ArrayList<>();
        for (String s : iso) {
            out.add(LocalDate.parse(s));
        }
        return out;
    }

    /** 창 20일 모두 같은 하루 값(D 기록은 저녁판 updatedAt). */
    static List<FlowDay> daily(long foreign, long institution) {
        List<FlowDay> out = new ArrayList<>();
        for (LocalDate day : WINDOW) {
            out.add(new FlowDay(day, foreign, institution, day.equals(D) ? EVENING : day + "T06:50:04.000+09:00"));
        }
        return out;
    }

    static Financials good() {
        return new Financials("2025", "20260310000001", 10.0, 50.0, true, false);
    }

    static Member member(String code, int rank, Long listed) {
        return new Member(code, "종목" + code, rank, BigDecimal.valueOf(1_000_000_000_000L), listed);
    }

    /** 위 표의 U·수급·재무·플래그. */
    static Input fixture() {
        List<Member> universe = new ArrayList<>();
        Map<String, List<FlowDay>> flows = new HashMap<>();
        Map<String, Financials> financials = new HashMap<>();
        String[] codes = {"000010", "000020", "000030", "000040", "000050", "000060", "000070", "000080", "000090",
                "000100", "000110", "000120", "000130", "000140", "000150", "000160", "000170", "000180"};
        for (int i = 0; i < codes.length; i++) {
            String code = codes[i];
            Long listed = switch (code) {
                case "000020" -> Long.valueOf(4_000_000L);
                case "000040" -> Long.valueOf(2_000_000L);
                case "000140" -> null;
                default -> Long.valueOf(1_000_000L);
            };
            universe.add(member(code, i + 1, listed));
            flows.put(code, daily(100, 100));
            financials.put(code, good());
        }
        flows.put("000010", daily(1_000, 500));
        flows.put("000020", daily(2_000, 1_000));
        flows.put("000030", daily(3_000, -100));
        flows.put("000040", daily(500, 500));
        financials.put("000040", new Financials("2025", "20260619000667", 9.0, 1_200.0, false, false));
        financials.put("000050", new Financials("2025", "20260318000001", 8.0, 250.0, true, false));
        financials.put("000060", new Financials("2026", "20261028000001", 8.0, 50.0, true, false));
        List<FlowDay> missingOne = new ArrayList<>(daily(100, 100));
        missingOne.removeIf(f -> f.date().equals(LocalDate.of(2026, 10, 6)));
        missingOne.add(new FlowDay(LocalDate.of(2026, 10, 9), 1_000_000L, 1_000_000L, null));   // 한글날 — 창 밖
        flows.put("000070", missingOne);
        financials.remove("000080");
        financials.put("000090", new Financials("2025", "20260318000002", -2.5, 80.0, true, false));
        List<FlowDay> streak = new ArrayList<>();
        for (FlowDay f : daily(100, 100)) {
            streak.add(f.date().equals(LocalDate.of(2026, 10, 22)) ? new FlowDay(f.date(), 100L, -50L, f.updatedAt()) : f);
        }
        flows.put("000120", streak);
        financials.put("000130", new Financials("2025", "2026031000", 8.0, 50.0, true, false));
        financials.put("000150", new Financials("2025", "20260318000003", null, null, true, false));
        financials.put("000160", new Financials("2025", "20260318000004", null, null, true, true));
        financials.put("000170", new Financials("2025", "20260318000005", 0.0, 50.0, true, false));
        flows.put("000180", daily(100, -100));
        financials.put("000180", new Financials("2025", "20260318000006", 5.0, 200.0, true, false));
        return new Input(D, B, universe, flows, financials, Set.of("000110"), Set.of("000100"));
    }

    static Map<String, Evaluation> byCode(List<Evaluation> evaluations) {
        Map<String, Evaluation> out = new LinkedHashMap<>();
        evaluations.forEach(e -> out.put(e.code(), e));
        return out;
    }

    static List<String> subs(Evaluation e) {
        return e.exclusions().stream().map(Exclusion::sub).toList();
    }

    // ---- 수급 창 ------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("창 = D와 앞 19 KR 거래일(10-05·10-09 휴장 건너뜀) — 20일 합·5일 합·연속일·D 기록의 판")
    void flowWindowSums() {
        FlowSummary s = KrRules.flows(CAL, D, daily(1_000, 500));

        assertThat(s.windowStart()).isEqualTo(LocalDate.of(2026, 9, 28));
        assertThat(s.windowEnd()).isEqualTo(D);
        assertThat(s.daysAvailable()).isEqualTo(20);
        assertThat(s.foreignNet20()).isEqualTo(20_000L);
        assertThat(s.institutionNet20()).isEqualTo(10_000L);
        assertThat(s.foreignNet5()).isEqualTo(5_000L);
        assertThat(s.institutionNet5()).isEqualTo(2_500L);
        assertThat(s.streakDays()).isEqualTo(20);
        assertThat(s.sessionUpdatedAt()).isEqualTo(EVENING);
        assertThat(s.bothPositive()).isTrue();
        assertThat(s.bothNegative()).isFalse();
    }

    @Test
    @DisplayName("창의 한 날이라도 없으면 합·연속일 null('자료 부족' — 0으로 채우지 않음), 휴장일 기록은 세지 않음, D가 없으면 판도 null")
    void incompleteWindowIsNull() {
        FlowSummary s = KrRules.flows(CAL, D, fixture().flows().get("000070"));

        assertThat(s.daysAvailable()).isEqualTo(19);
        assertThat(s.foreignNet20()).isNull();
        assertThat(s.institutionNet20()).isNull();
        assertThat(s.streakDays()).isNull();
        assertThat(s.foreignNet5()).as("마지막 5일(10-21~27)은 다 있음").isEqualTo(500L);
        assertThat(s.complete()).isFalse();

        List<FlowDay> noSession = new ArrayList<>(daily(100, 100));
        noSession.removeIf(f -> f.date().equals(D));
        FlowSummary late = KrRules.flows(CAL, D, noSession);
        assertThat(late.daysAvailable()).isEqualTo(19);
        assertThat(late.sessionUpdatedAt()).isNull();
        assertThat(late.foreignNet5()).isNull();

        List<FlowDay> halfRecord = new ArrayList<>(daily(100, 100));
        halfRecord.set(3, new FlowDay(halfRecord.get(3).date(), 100L, null, null));   // 기관 칸 없음
        assertThat(KrRules.flows(CAL, D, halfRecord).daysAvailable()).isEqualTo(19);

        assertThat(KrRules.flows(CAL, D, null).daysAvailable()).isZero();
    }

    @Test
    @DisplayName("연속일 = D부터 거슬러 둘 다 순매수인 날 — 10-22 기관 −50이면 3일(10-27·26·23)")
    void streakCountsBackFromSession() {
        FlowSummary s = KrRules.flows(CAL, D, fixture().flows().get("000120"));

        assertThat(s.streakDays()).isEqualTo(3);
        assertThat(s.foreignNet20()).isEqualTo(2_000L);
        assertThat(s.institutionNet20()).isEqualTo(1_850L);   // 19 × 100 − 50
    }

    @Test
    @DisplayName("연말을 건너는 창 — 2027-01-05의 창은 2026-12-04부터(12-25·12-31·01-01 휴장)")
    void windowAcrossYearEnd() {
        assertThat(KrRules.flows(CAL, LocalDate.of(2027, 1, 5), List.of()).windowStart())
                .isEqualTo(LocalDate.of(2026, 12, 4));
        KrxCalendar only2027 = new KrxCalendar(Map.of(2027, KrxFixtures.kasiHolidays(2027)), List.of());
        assertThatThrownBy(() -> KrRules.flows(only2027, LocalDate.of(2027, 1, 5), List.of()))
                .as("앞 해 달력이 없으면 짐작하지 않음(K35)").isInstanceOf(CalendarUnavailableException.class);
    }

    @Test
    @DisplayName("입력 오류 — D가 휴장일, 같은 날 기록 둘")
    void flowInputErrors() {
        assertThatThrownBy(() -> KrRules.flows(CAL, LocalDate.of(2026, 10, 9), List.of()))
                .isInstanceOf(IllegalArgumentException.class);
        List<FlowDay> twice = new ArrayList<>(daily(1, 1));
        twice.add(new FlowDay(D, 2L, 2L, null));
        assertThatThrownBy(() -> KrRules.flows(CAL, D, twice)).isInstanceOf(IllegalArgumentException.class);
    }

    // ---- 후보·사유 ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("손계산 고정본 — 후보 넷과 점수, 빠진 종목마다 사유(자료 없음은 세부 사유와 함께)")
    void candidatesScoresAndReasons() {
        Map<String, Evaluation> e = byCode(KrRules.evaluate(CAL, fixture(), DEFAULTS));

        assertThat(e.values().stream().filter(Evaluation::candidate).map(Evaluation::code))
                .containsExactly("000010", "000020", "000040", "000120");
        assertThat(e.get("000010").score()).isCloseTo(3.0, within(1e-12));
        assertThat(e.get("000020").score()).isCloseTo(1.5, within(1e-12));
        assertThat(e.get("000040").score()).isCloseTo(1.0, within(1e-12));
        assertThat(e.get("000120").score()).isCloseTo(0.385, within(1e-12));
        assertThat(e.get("000030").score()).as("후보가 아니어도 점수는 셈(동결)").isCloseTo(5.8, within(1e-12));

        assertThat(subs(e.get("000030"))).containsExactly("수급 미달");
        assertThat(e.get("000030").exclusions().get(0).detail()).contains("+60,000").contains("-2,000");
        assertThat(subs(e.get("000050"))).containsExactly(KrRules.DEBT_RATIO_OVER);
        assertThat(e.get("000050").exclusions().get(0).detail()).contains("250.0%").contains("상한 200%");
        assertThat(subs(e.get("000060"))).containsExactly(KrRules.RECEIPT_AFTER_BASE);
        assertThat(e.get("000060").exclusions().get(0).reason()).isEqualTo(Reason.NO_DATA);
        assertThat(e.get("000060").receiptDate()).isEqualTo(LocalDate.of(2026, 10, 28));
        assertThat(subs(e.get("000070"))).containsExactly("자료 부족");
        assertThat(e.get("000070").score()).isNull();
        assertThat(e.get("000070").exclusions().get(0).detail()).contains("20거래일 중 19일");
        assertThat(subs(e.get("000080"))).containsExactly(KrRules.NO_DART);
        assertThat(subs(e.get("000090"))).containsExactly(KrRules.ROE_NOT_POSITIVE);
        assertThat(e.get("000090").exclusions().get(0).reason()).isEqualTo(Reason.FINANCIAL);
        assertThat(subs(e.get("000100"))).containsExactly("거래정지");
        assertThat(subs(e.get("000110"))).containsExactly("재진입 금지");
        assertThat(subs(e.get("000130"))).containsExactly(KrRules.RECEIPT_UNKNOWN);
        assertThat(subs(e.get("000140"))).containsExactly(KrRules.NO_LISTED_SHARES);
        assertThat(e.get("000140").score()).isNull();
        assertThat(subs(e.get("000150"))).containsExactly(KrRules.NO_ROE, KrRules.NO_DEBT_RATIO);
        assertThat(e.get("000150").exclusions()).allSatisfy(x -> assertThat(x.reason()).isEqualTo(Reason.NO_DATA));
        assertThat(subs(e.get("000160"))).containsExactly(KrRules.CAPITAL_IMPAIRED);
        assertThat(e.get("000160").exclusions().get(0).reason()).isEqualTo(Reason.FINANCIAL);
        assertThat(subs(e.get("000170"))).as("ROE 0은 통과하지 않음(> 0)").containsExactly(KrRules.ROE_NOT_POSITIVE);
        assertThat(subs(e.get("000180"))).as("부채비율 200 = 상한은 통과(≤)").containsExactly("수급 미달");
    }

    @Test
    @DisplayName("금융업(매출액 계정 없음)은 부채비율로 빠지지 않음 — 같은 부채비율 1,200%라도 매출액 계정이 있으면 빠짐")
    void financialsAreNotExcludedByDebtRatio() {
        Map<String, Evaluation> e = byCode(KrRules.evaluate(CAL, fixture(), DEFAULTS));
        assertThat(e.get("000040").candidate()).isTrue();

        Input in = fixture();
        Map<String, Financials> withRevenue = new HashMap<>(in.financials());
        withRevenue.put("000040", new Financials("2025", "20260619000667", 9.0, 1_200.0, true, false));
        Input changed = new Input(D, B, in.universe(), in.flows(), withRevenue, in.lockedOut(), in.suspended());
        assertThat(subs(byCode(KrRules.evaluate(CAL, changed, DEFAULTS)).get("000040")))
                .containsExactly(KrRules.DEBT_RATIO_OVER);
    }

    @Test
    @DisplayName("사유는 해당하는 것을 모두 정해진 순서로 — 거래정지 · 자료 부족 · DART 없음")
    void reasonsInFixedOrder() {
        Member m = member("000990", 1, 1_000_000L);
        Input in = new Input(D, B, List.of(m), Map.of(), Map.of(), Set.of("000990"), Set.of("000990"));

        Evaluation e = KrRules.evaluate(CAL, in, DEFAULTS).get(0);
        assertThat(e.exclusions().stream().map(Exclusion::reason))
                .containsExactly(Reason.SUSPENDED, Reason.LOCKED_OUT, Reason.FLOWS_INSUFFICIENT, Reason.NO_DATA);
        assertThat(e.exclusions().get(3).sub()).isEqualTo(KrRules.NO_DART);
    }

    @Test
    @DisplayName("연속 순매수 조건(minStreakDays) — 0은 끔, 3이면 000120(3일) 통과, 4면 빠짐")
    void minStreakDays() {
        assertThat(byCode(KrRules.evaluate(CAL, fixture(), params(15, Weighting.EQUAL, 3, 10))).get("000120")
                .candidate()).isTrue();
        Evaluation strict = byCode(KrRules.evaluate(CAL, fixture(), params(15, Weighting.EQUAL, 4, 10))).get("000120");
        assertThat(subs(strict)).containsExactly("연속 순매수 미달");
        assertThat(strict.exclusions().get(0).detail()).contains("3일 < 4일");
    }

    // ---- 배분 ---------------------------------------------------------------------------------------------------

    @Test
    @DisplayName("동일비중 15자리 — 후보 4개 × 100/15 = 26.67%, 남는 73.33%는 153130")
    void equalWeightWithFewCandidates() {
        Selection s = KrRules.select(CAL, fixture(), DEFAULTS);

        assertThat(s.targets().stream().map(Target::code)).containsExactly("000010", "000020", "000040", "000120");
        assertThat(s.targets().stream().map(Target::rankInPlan)).containsExactly(1, 2, 3, 4);
        assertThat(s.targets()).allSatisfy(t -> assertThat(t.weightPct()).isCloseTo(100.0 / 15, within(1e-12)));
        assertThat(s.stockWeightPct()).isCloseTo(400.0 / 15, within(1e-9));
        assertThat(s.parkingWeightPct()).isCloseTo(100 - 400.0 / 15, within(1e-9));
        assertThat(s.notChosen()).isEmpty();
        assertThat(s.candidateCodes()).containsExactly("000010", "000020", "000040", "000120");
        assertThat(s.session()).isEqualTo(D);
        assertThat(s.universeDate()).isEqualTo(B);
    }

    @Test
    @DisplayName("상위 2자리 — 동일비중 min(50, 상한 10) = 10%씩, 후보 000040·000120은 상위 밖(사지 않음), 남는 80%")
    void topNamesAndCap() {
        Selection s = KrRules.select(CAL, fixture(), params(2, Weighting.EQUAL, 0, 10));

        assertThat(s.targets().stream().map(Target::code)).containsExactly("000010", "000020");
        assertThat(s.targets()).allSatisfy(t -> assertThat(t.weightPct()).isCloseTo(10.0, within(1e-12)));
        assertThat(s.notChosen().stream().map(Evaluation::code)).containsExactly("000040", "000120");
        assertThat(s.stockWeightPct()).isCloseTo(20.0, within(1e-12));
        assertThat(s.parkingWeightPct()).isCloseTo(80.0, within(1e-12));
    }

    @Test
    @DisplayName("점수 비례 — 예산 3 × 100/15 = 20%를 3.0:1.5:1.0으로(120/11·60/11·40/11), 상한 10이면 첫 종목만 잘리고 남는 몫은 153130")
    void scoreWeighting() {
        Selection uncapped = KrRules.select(CAL, fixture(), params(15, Weighting.SCORE, 4, 100));
        assertThat(uncapped.targets().stream().map(Target::code)).containsExactly("000010", "000020", "000040");
        assertThat(uncapped.targets().get(0).weightPct()).isCloseTo(120.0 / 11, within(1e-12));
        assertThat(uncapped.targets().get(1).weightPct()).isCloseTo(60.0 / 11, within(1e-12));
        assertThat(uncapped.targets().get(2).weightPct()).isCloseTo(40.0 / 11, within(1e-12));
        assertThat(uncapped.stockWeightPct()).as("동일비중과 같은 노출").isCloseTo(20.0, within(1e-9));
        assertThat(uncapped.parkingWeightPct()).isCloseTo(80.0, within(1e-9));

        Selection capped = KrRules.select(CAL, fixture(), params(15, Weighting.SCORE, 4, 10));
        assertThat(capped.targets().get(0).weightPct()).isCloseTo(10.0, within(1e-12));
        assertThat(capped.targets().get(1).weightPct()).isCloseTo(60.0 / 11, within(1e-12));
        assertThat(capped.stockWeightPct()).isCloseTo(210.0 / 11, within(1e-9));
        assertThat(capped.parkingWeightPct()).isCloseTo(890.0 / 11, within(1e-9));
    }

    @Test
    @DisplayName("동점은 U 순위(시총 순) 먼저 — 같은 점수 1.0이면 순위 2가 순위 5보다 앞")
    void tieBreaksByUniverseRank() {
        Member low = member("000500", 5, 1_000_000L);
        Member high = member("000200", 2, 1_000_000L);
        Input in = new Input(D, B, List.of(low, high), Map.of("000500", daily(250, 250), "000200", daily(250, 250)),
                Map.of("000500", good(), "000200", good()), Set.of(), Set.of());

        Selection s = KrRules.select(CAL, in, params(1, Weighting.EQUAL, 0, 10));
        assertThat(s.candidates().stream().map(Evaluation::code)).containsExactly("000200", "000500");
        assertThat(s.targets().stream().map(Target::code)).containsExactly("000200");
    }

    @Test
    @DisplayName("후보가 없으면 종목 0%·153130 100%, 15자리를 다 채우면 남는 비중 0")
    void noCandidatesAndFullBook() {
        Member m = member("000010", 1, 1_000_000L);
        Input none = new Input(D, B, List.of(m), Map.of("000010", daily(-1, -1)), Map.of("000010", good()), Set.of(),
                Set.of());
        Selection empty = KrRules.select(CAL, none, DEFAULTS);
        assertThat(empty.targets()).isEmpty();
        assertThat(empty.stockWeightPct()).isZero();
        assertThat(empty.parkingWeightPct()).isEqualTo(100.0);

        List<Member> universe = new ArrayList<>();
        Map<String, List<FlowDay>> flows = new HashMap<>();
        Map<String, Financials> fin = new HashMap<>();
        for (int i = 1; i <= 16; i++) {
            String code = String.format("%06d", i);
            universe.add(member(code, i, 1_000_000L));
            flows.put(code, daily(i, i));
            fin.put(code, good());
        }
        Selection full = KrRules.select(CAL, new Input(D, B, universe, flows, fin, Set.of(), Set.of()), DEFAULTS);
        assertThat(full.targets()).hasSize(15);
        assertThat(full.targets().get(0).code()).isEqualTo("000016");   // 점수 가장 큼
        assertThat(full.notChosen().stream().map(Evaluation::code)).containsExactly("000001");
        assertThat(full.parkingWeightPct()).isZero();
        assertThat(full.stockWeightPct()).isCloseTo(100.0, within(1e-9));
    }

    @Test
    @DisplayName("사유별 빠진 종목 수 — 화면의 '자료 없음' 사유 집계")
    void exclusionCounts() {
        Map<Reason, Integer> counts = KrRules.select(CAL, fixture(), DEFAULTS).exclusionCounts();

        assertThat(counts).containsEntry(Reason.NO_DATA, 5)          // 000060·080·130·140·150(둘이어도 한 번)
                .containsEntry(Reason.FINANCIAL, 4)                  // 000050·090·160·170
                .containsEntry(Reason.FLOWS_NOT_BOTH_POSITIVE, 2)    // 000030·180
                .containsEntry(Reason.FLOWS_INSUFFICIENT, 1)
                .containsEntry(Reason.SUSPENDED, 1)
                .containsEntry(Reason.LOCKED_OUT, 1)
                .doesNotContainKey(Reason.STREAK_SHORT);
    }

    // ---- 매도 신호·남는 현금 -------------------------------------------------------------------------------------

    /** 보유: 후보 000010·000040, 수급 미달 000030, U 밖 둘 다 순매도 000900, 창 덜 참 000070, 현금성 153130·069500. */
    static Map<String, List<FlowDay>> holdingFlows() {
        Map<String, List<FlowDay>> flows = new HashMap<>(fixture().flows());
        flows.put("000900", daily(-100, -1));
        flows.put("153130", daily(-500, -500));
        flows.put("069500", daily(-500, -500));
        return flows;
    }

    static final List<String> HOLDINGS = List.of("000900", "000010", "000030", "000070", "000040", "153130", "069500");

    @Test
    @DisplayName("매일 매도 신호 = 20일 외국인·기관 둘 다 < 0 — U 밖 보유도 봄, 창이 덜 차면 신호 없음, 153130·현금성은 보지 않음")
    void dailySellSignals() {
        List<KrRules.HoldingCheck> checks = KrRules.holdingChecks(CAL, D, HOLDINGS, holdingFlows(), null,
                Set.of("069500"));

        assertThat(checks.stream().map(KrRules.HoldingCheck::code))
                .containsExactly("000010", "000030", "000040", "000070", "000900");
        Map<String, KrRules.HoldingCheck> by = new LinkedHashMap<>();
        checks.forEach(c -> by.put(c.code(), c));
        assertThat(by.get("000900").reasons()).containsExactly(KrRules.SellReason.FLOWS_BOTH_NEGATIVE);
        assertThat(by.get("000900").flows().foreignNet20()).isEqualTo(-2_000L);
        assertThat(by.get("000900").flows().institutionNet20()).isEqualTo(-20L);
        assertThat(by.get("000030").sell()).as("외국인 +60,000 · 기관 −2,000 — 둘 다 음수는 아님").isFalse();
        assertThat(by.get("000070").sell()).as("창 19일 — 신호를 만들지 않음").isFalse();
        assertThat(by.get("000070").flows().complete()).isFalse();
        assertThat(by.get("000010").sell()).isFalse();
    }

    @Test
    @DisplayName("재선정한 날 매도 = 후보 밖(수급 미달·창 덜 참·U 밖) — 후보인데 상위 maxNames 밖인 보유(000040)는 팔지 않음")
    void selectionDaySellsOutsideCandidates() {
        Selection top2 = KrRules.select(CAL, fixture(), params(2, Weighting.EQUAL, 0, 10));
        assertThat(top2.notChosen().stream().map(Evaluation::code)).contains("000040");

        Map<String, KrRules.HoldingCheck> by = new LinkedHashMap<>();
        KrRules.holdingChecks(CAL, D, HOLDINGS, holdingFlows(), top2.candidateCodes(), Set.of("069500"))
                .forEach(c -> by.put(c.code(), c));
        assertThat(by.get("000010").sell()).isFalse();
        assertThat(by.get("000040").sell()).isFalse();
        assertThat(by.get("000030").reasons()).containsExactly(KrRules.SellReason.OUT_OF_CANDIDATES);
        assertThat(by.get("000070").reasons()).containsExactly(KrRules.SellReason.OUT_OF_CANDIDATES);
        assertThat(by.get("000900").reasons()).containsExactly(KrRules.SellReason.FLOWS_BOTH_NEGATIVE,
                KrRules.SellReason.OUT_OF_CANDIDATES);
        assertThat(by).doesNotContainKeys("153130", "069500");
    }

    @Test
    @DisplayName("남는 현금 → 153130 — 재선정한 날은 여유 0.5%p 넘는 만큼, 그 밖의 날은 기준 2% 넘을 때만(같으면 안 삼)")
    void parkingIncrement() {
        assertThat(KrRules.parkingIncrementPct(80.9, true, 2)).isCloseTo(80.4, within(1e-12));
        assertThat(KrRules.parkingIncrementPct(1.0, true, 2)).as("재선정일은 기준을 보지 않음").isCloseTo(0.5, within(1e-12));
        assertThat(KrRules.parkingIncrementPct(0.5, true, 2)).isZero();
        assertThat(KrRules.parkingIncrementPct(-3.0, true, 2)).as("모자란 현금은 이 함수의 몫이 아님").isZero();

        assertThat(KrRules.parkingIncrementPct(1.9, false, 2)).isZero();
        assertThat(KrRules.parkingIncrementPct(2.0, false, 2)).isZero();
        assertThat(KrRules.parkingIncrementPct(2.5, false, 2)).isCloseTo(2.0, within(1e-12));
        assertThat(KrRules.parkingIncrementPct(0.4, false, 0.2)).as("기준이 여유보다 낮아도 여유는 남김").isZero();
        assertThat(KrRules.parkingIncrementPct(0.6, false, 0)).isCloseTo(0.1, within(1e-12));

        assertThatThrownBy(() -> KrRules.parkingIncrementPct(Double.NaN, false, 2))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> KrRules.parkingIncrementPct(1, false, -1)).isInstanceOf(IllegalArgumentException.class);
    }

    // ---- 재무 입력 ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("계정표에서 재무 — ROE·부채비율은 KrFundamentals 정의, 매출액 계정 유무, 자본잠식")
    void financialsFromAccounts() {
        Map<String, KrFundamentals.Amounts> nonFinancial = Map.of(
                KrFundamentals.NET_INCOME, new KrFundamentals.Amounts(1_000.0, 900.0),
                KrFundamentals.EQUITY, new KrFundamentals.Amounts(10_000.0, 9_000.0),
                KrFundamentals.DEBT, new KrFundamentals.Amounts(5_000.0, 4_000.0),
                KrFundamentals.REVENUE, new KrFundamentals.Amounts(20_000.0, 18_000.0));
        Financials f = Financials.fromAccounts("2025", "20260310002820", nonFinancial);
        assertThat(f.roePct()).isCloseTo(10.0, within(1e-12));
        assertThat(f.debtRatioPct()).isCloseTo(50.0, within(1e-12));
        assertThat(f.hasRevenueAccount()).isTrue();
        assertThat(f.capitalImpaired()).isFalse();
        assertThat(f.receiptDate()).isEqualTo(LocalDate.of(2026, 3, 10));

        Map<String, KrFundamentals.Amounts> bank = new HashMap<>(nonFinancial);
        bank.remove(KrFundamentals.REVENUE);
        assertThat(Financials.fromAccounts("2025", "20260619000667", bank).hasRevenueAccount()).isFalse();

        Map<String, KrFundamentals.Amounts> impaired = new HashMap<>(nonFinancial);
        impaired.put(KrFundamentals.EQUITY, new KrFundamentals.Amounts(-1.0, 1.0));
        Financials bad = Financials.fromAccounts("2025", "20260310002820", impaired);
        assertThat(bad.capitalImpaired()).isTrue();
        assertThat(bad.roePct()).isNull();
        assertThat(bad.debtRatioPct()).isNull();
    }

    @Test
    @DisplayName("접수일 = 접수번호 앞 8자리 — 14자리 숫자가 아니거나 날짜가 아니면 모름(null)")
    void receiptDate() {
        assertThat(new Financials("2025", "20260310002820", 1.0, 1.0, true, false).receiptDate())
                .isEqualTo(LocalDate.of(2026, 3, 10));
        assertThat(new Financials("2025", "2026031000282", 1.0, 1.0, true, false).receiptDate()).isNull();
        assertThat(new Financials("2025", "20261340000001", 1.0, 1.0, true, false).receiptDate()).isNull();
        assertThat(new Financials("2025", null, 1.0, 1.0, true, false).receiptDate()).isNull();
        assertThat(new Financials("2025", "20260310002820", Double.NaN, Double.POSITIVE_INFINITY, true, false).roePct())
                .isNull();
    }

    @Test
    @DisplayName("접수일 = 기준일이면 씀 — 다음 날 기준으로 따라잡기 하면 000060(10-28 접수)도 재무 통과")
    void receiptOnBaseDateIsUsable() {
        Input in = fixture();
        LocalDate next = LocalDate.of(2026, 10, 28);
        Map<String, List<FlowDay>> flows = new HashMap<>();
        flows.put("000060", List.of());
        Input later = new Input(next, D, in.universe(), flows, in.financials(), Set.of(), Set.of());
        Evaluation e = byCode(KrRules.evaluate(CAL, later, DEFAULTS)).get("000060");
        assertThat(e.excludedBy(Reason.NO_DATA)).isFalse();
        assertThat(subs(e)).containsExactly("자료 부족");
    }

    // ---- 입력 검사 ----------------------------------------------------------------------------------------------

    @Test
    @DisplayName("입력·규칙 값 검사 — U 기준일 ≥ D, U 코드 중복, 범위 밖 규칙 값")
    void inputValidation() {
        Member m = member("000010", 1, 1L);
        assertThatThrownBy(() -> new Input(D, D, List.of(m), null, null, null, null))
                .isInstanceOf(IllegalArgumentException.class);
        Input duplicate = new Input(D, B, List.of(m, m), null, null, null, null);
        assertThatThrownBy(() -> KrRules.evaluate(CAL, duplicate, DEFAULTS)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> params(0, Weighting.EQUAL, 0, 10)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> params(15, Weighting.EQUAL, 21, 10)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> params(15, Weighting.EQUAL, 0, 0)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Params(15, Weighting.EQUAL, 0, -1, 10, 2, KrReselection.Mode.MONTHLY_FIRST))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Params(15, Weighting.EQUAL, 0, 200, 10, 2, null))
                .isInstanceOf(NullPointerException.class);
    }
}
