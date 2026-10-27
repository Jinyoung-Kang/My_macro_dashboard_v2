package com.macrodash.analytics;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * 🧪 한국 규칙 계좌({@code kr_rules}) 수급 규칙의 순수 계산 — 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-6·K7, §4-5 'B8 구현에서 정한 것'.
 *
 * <pre>
 *  창       = 결정의 기준 KR 세션 D와 그 앞 19거래일(KRX 달력 — 20거래일, 휴장일 기록은 보지 않음)
 *  수급     = 창의 외국인·기관 순매수(주) 합. 창의 한 날이라도 기록(외국인·기관 둘 다)이 없으면 null('자료 부족')
 *  후보     = U 중 외국인 합 > 0 ∧ 기관 합 > 0 ∧ (minStreakDays > 0이면 동시 순매수 연속일 ≥ minStreakDays)
 *             ∧ 재무 통과 ∧ 거래정지·재진입 금지 아님
 *  점수     = (외국인 합 + 기관 합) ÷ 상장주식수(금융위, U 행) × 100
 *  재무     = ROE > 0(모두) ∧ (매출액 계정이 있으면 부채비율 ≤ debtRatioMaxPct) — 매출액 계정이 없는 회사(금융업)는 부채비율을 보지 않음.
 *             DART 보고서 접수일(rceptNo 앞 8자리) ≤ D만 씀
 *  매수     = 점수 순 상위 maxNames(동점은 U 순위·코드 순)
 *  비중     EQUAL  종목마다 min(100 ÷ maxNames, 종목 상한)
 *           SCORE  예산 = 고른 수 × 100 ÷ maxNames를 점수에 비례해 나눈 뒤 종목 상한으로 자름
 *  남는 비중 = 100 − 종목 비중 합 → 153130(현금성)
 *  매도     = 매일: 20일 외국인·기관 합이 둘 다 < 0 · 재선정한 날(따라잡기 포함): 후보 밖
 *  남는 현금 = 재선정한 날은 여유 0.5%p를 넘는 만큼, 그 밖의 날은 kr.rules.parkCashThresholdPct를 넘을 때 153130에
 * </pre>
 *
 * <p><b>왜 이렇게</b>: 동조 가산을 따로 두지 않는 것은 '둘 다 양수'가 곧 동조라서입니다(K7). 후보가 maxNames보다 적으면 그만큼만 사고
 * 남는 비중은 153130에 둡니다 — 그래서 결과는 종목 신호와 주식 노출이 섞인 값이고 화면에 주식 비중을 함께 보입니다(§3·K40).
 * 점수 비례(SCORE)도 예산을 '고른 수 × 한 자리'로 두어 두 배분 방식의 주식 노출이 같고(나누는 방식만 다름), 상한에 잘린 몫은 다른
 * 종목으로 돌리지 않고 153130에 남깁니다(미국 규칙 책 {@link Signal13F#allocate}의 '예산 없음'과 같은 뜻). 종목 상한은
 * {@code kr.maxWeightStockPct}입니다. U는 보통주뿐이고 153130은 현금성(상한 제외)이라 ETF 상한은 규칙 계좌에 쓰일 자리가 없습니다.
 *
 * <p><b>자료가 모자라면 만들지 않습니다</b>: 창이 덜 찬 종목은 합·연속일·점수가 null이고 후보가 아닙니다. 재무가 없거나(DART 없음),
 * 시점을 확인하지 못했거나(접수일 모름·접수일이 기준일 뒤 — 저장본은 회사마다 마지막 보고서 하나라 이전 판으로 대신하지 않음, B8),
 * ROE·부채비율을 셀 수 없으면 '자료 없음'과 그 세부 사유로 뺍니다. 자본총계 ≤ 0(자본잠식)은 셀 수 없는 것이 아니라 재무가 나쁜
 * 것이라 '재무 미달 — 자본잠식'입니다. 사유는 해당하는 것을 모두 정해진 순서로 남깁니다(결정 행 동결 K26·화면 '자료 없음' 사유).
 *
 * <p>순수 클래스입니다(이 패키지는 {@code java.*}만 — 저장본·설정을 읽지 않음). 부르는 쪽(한국 규칙 계좌 결정)이 그 실행에서 한 번 읽은
 * 유니버스·수급·재무·재진입 금지·거래정지를 {@link Input}으로, 그 실행의 설정 판({@code kr.*})을 {@link Params}로 넘깁니다. 재선정일과
 * 따라잡기는 {@link KrReselection}입니다.
 */
public final class KrRules {

    /** 누적 수급 창(KR 거래일 수, K7). */
    public static final int FLOW_DAYS = 20;
    /** 짧은 누적 창(동결·화면용 — 후보 판정에는 쓰지 않음, §4-5 '입력 동결'). */
    public static final int SHORT_FLOW_DAYS = 5;
    /** 남는 비중을 두는 현금성 ETF(K2·§4-6 — 단기채 153130). */
    public static final String PARKING_CODE = "153130";
    /**
     * 남는 현금을 153130에 둘 때 현금으로 남기는 여유(순자산 %p) — 미국 규칙 책({@code RuleBookService.CASH_BUFFER_PCT})과 같은 값.
     * 결정 때 어림한 금액과 체결 때 가격·비용·정수 주 절사가 조금 달라도 153130 매수가 종목 매수의 현금을 다투지 않게. 1억 원이면
     * 50만 원 = {@code kr.minOrderNotional} 기본값.
     */
    public static final double CASH_BUFFER_PCT = 0.5;

    /** '자료 없음' 세부 사유(§4-6 'DART·ROE 없음은 자료 없음으로 빼고 사유를 보인다', B8 접수일 규칙). */
    public static final String NO_DART = "DART 없음";
    public static final String RECEIPT_UNKNOWN = "접수일 모름";
    public static final String RECEIPT_AFTER_BASE = "접수일이 기준일 뒤";
    public static final String NO_ROE = "ROE 없음";
    public static final String NO_DEBT_RATIO = "부채비율 없음";
    public static final String NO_LISTED_SHARES = "상장주식수 없음";
    /** '재무 미달' 세부 사유. */
    public static final String ROE_NOT_POSITIVE = "ROE 0 이하";
    public static final String DEBT_RATIO_OVER = "부채비율 상한 초과";
    public static final String CAPITAL_IMPAIRED = "자본잠식";

    private static final DateTimeFormatter BASIC = DateTimeFormatter.BASIC_ISO_DATE;
    /** 비중 합이 100을 아주 조금 넘는 부동소수 잔차(100 ÷ 15 × 15)를 0으로 보는 한계. */
    private static final double WEIGHT_EPSILON = 1e-9;

    private KrRules() {
    }

    // ------------------------------------------------------------------ 입력

    /** 배분 방식(설정 {@code kr.rules.weighting}의 값 이름 그대로). */
    public enum Weighting {
        /** 동일비중(기본). */
        EQUAL,
        /** 점수 비례. */
        SCORE
    }

    /**
     * 그 실행의 설정 판에서 읽은 규칙 값({@code kr.*} — 부르는 쪽이 키가 없거나 틀린 값을 기본값으로 읽어 넘김).
     *
     * @param maxNames             매수 종목 수 상한({@code kr.rulesMaxNames}, 기본 15)
     * @param weighting            배분 방식({@code kr.rules.weighting}, 기본 EQUAL)
     * @param minStreakDays        후보가 될 동시 순매수 연속일({@code kr.rules.minStreakDays}, 기본 0 = 끔, 0~{@value #FLOW_DAYS})
     * @param debtRatioMaxPct      비금융 부채비율 상한(%, {@code kr.rules.debtRatioMaxPct}, 기본 200 — 가정)
     * @param maxWeightStockPct    종목당 비중 상한(%, {@code kr.maxWeightStockPct}, 기본 10)
     * @param parkCashThresholdPct 재선정일이 아닌 날 남는 현금을 153130에 두는 기준(순자산 %, {@code kr.rules.parkCashThresholdPct}, 기본 2)
     * @param reselection          재선정 주기({@code kr.rules.reselection}, 기본 MONTHLY_FIRST)
     */
    public record Params(int maxNames, Weighting weighting, int minStreakDays, double debtRatioMaxPct,
                         double maxWeightStockPct, double parkCashThresholdPct, KrReselection.Mode reselection) {

        public Params {
            if (maxNames < 1 || maxNames > 100) {
                throw new IllegalArgumentException("매수 종목 수 상한은 1~100이어야 합니다: " + maxNames);
            }
            Objects.requireNonNull(weighting, "weighting");
            if (minStreakDays < 0 || minStreakDays > FLOW_DAYS) {
                throw new IllegalArgumentException("연속 순매수 최소 일수는 0~" + FLOW_DAYS + "이어야 합니다: " + minStreakDays);
            }
            if (!Double.isFinite(debtRatioMaxPct) || debtRatioMaxPct < 0) {
                throw new IllegalArgumentException("부채비율 상한(%)은 0 이상이어야 합니다: " + debtRatioMaxPct);
            }
            if (!(maxWeightStockPct > 0) || maxWeightStockPct > 100) {
                throw new IllegalArgumentException("종목당 비중 상한(%)은 0 초과 100 이하여야 합니다: " + maxWeightStockPct);
            }
            if (!Double.isFinite(parkCashThresholdPct) || parkCashThresholdPct < 0 || parkCashThresholdPct > 100) {
                throw new IllegalArgumentException("남는 현금 기준(%)은 0~100이어야 합니다: " + parkCashThresholdPct);
            }
            Objects.requireNonNull(reselection, "reselection");
        }
    }

    /**
     * 유니버스 U의 한 종목 — 수집기 {@code kr_paper_universe} 행 그대로(금융위 기준일 B의 값).
     *
     * @param listedShares 상장주식수(금융위). 없거나 0 이하면 점수를 셀 수 없음('자료 없음')
     * @param marketCap    시가총액(원, 동결·화면용 — 계산에 쓰지 않음)
     */
    public record Member(String code, String name, int rank, BigDecimal marketCap, Long listedShares) {

        public Member {
            Objects.requireNonNull(code, "code");
        }
    }

    /**
     * 한 종목·한 날의 투자자별 순매수(토스 {@code kr_paper_flow} — 주).
     *
     * @param foreignNet     외국인 순매수(주). 없으면 null
     * @param institutionNet 기관 순매수(주). 없으면 null
     * @param updatedAt      토스 {@code updatedAt}(그 기록의 판 — 원문 그대로, 동결 K26)
     */
    public record FlowDay(LocalDate date, Long foreignNet, Long institutionNet, String updatedAt) {

        boolean complete() {
            return foreignNet != null && institutionNet != null;
        }
    }

    /**
     * 한 회사의 DART 재무(저장본 {@code kr.dart_fundamentals}의 마지막 보고서 하나 — 사업보고서 주요계정).
     *
     * @param bsnsYear          사업연도(동결용)
     * @param rceptNo           접수번호(14자리, 앞 8자리 = 접수일 — 동결용·시점 규칙)
     * @param roePct            ROE(%, 당기순이익 ÷ 기말 자본총계 × 100 — {@link KrFundamentals}). 셀 수 없으면 null
     * @param debtRatioPct      부채비율(%, 부채총계 ÷ 자본총계 × 100). 셀 수 없으면 null
     * @param hasRevenueAccount 매출액 계정이 있음 — 있으면 부채비율 상한을 봄(없는 회사 = 금융업으로 보고 보지 않음)
     * @param capitalImpaired   자본총계 ≤ 0(자본잠식)
     */
    public record Financials(String bsnsYear, String rceptNo, Double roePct, Double debtRatioPct,
                             boolean hasRevenueAccount, boolean capitalImpaired) {

        public Financials {
            roePct = finite(roePct);
            debtRatioPct = finite(debtRatioPct);
        }

        /**
         * 계정표에서 — ROE·부채비율·자본잠식은 {@link KrFundamentals#metrics}(화면 레이더 재무와 같은 정의), 매출액 계정은 당기 금액이 있을 때.
         */
        public static Financials fromAccounts(String bsnsYear, String rceptNo, Map<String, KrFundamentals.Amounts> accounts) {
            Map<String, KrFundamentals.Amounts> table = accounts == null ? Map.of() : accounts;
            Map<String, Object> metrics = KrFundamentals.metrics(table);
            KrFundamentals.Amounts revenue = table.get(KrFundamentals.REVENUE);
            return new Financials(bsnsYear, rceptNo, (Double) metrics.get("roe"), (Double) metrics.get("debtRatio"),
                    revenue != null && revenue.current() != null, Boolean.TRUE.equals(metrics.get("capitalImpaired")));
        }

        /** 접수일 — 접수번호가 14자리 숫자이고 앞 8자리가 날짜일 때만(아니면 null = '접수일 모름', B8). */
        public LocalDate receiptDate() {
            if (rceptNo == null || !rceptNo.matches("\\d{14}")) {
                return null;
            }
            try {
                return LocalDate.parse(rceptNo.substring(0, 8), BASIC);
            } catch (DateTimeParseException e) {
                return null;
            }
        }

        private static Double finite(Double value) {
            return value == null || !Double.isFinite(value) ? null : value;
        }
    }

    /**
     * 한 결정(선정)의 입력 — 그 실행이 한 번 읽은 저장본(K26 동결과 같은 읽기).
     *
     * @param session      기준 KR 세션 D(재선정 따라잡기면 r′ = selectionAsOf) — 수급 창의 끝·DART 접수일의 기준일
     * @param universeDate U를 만든 금융위 기준일 B(< D)
     * @param universe     U(순위 순 — 순서는 결과 순서일 뿐 판정에 쓰지 않음)
     * @param flows        코드 → 그 종목의 일별 순매수(U 밖 보유 종목도 넣을 수 있음 — {@link #flows} 참고)
     * @param financials   코드 → DART 재무(없는 회사는 키가 없음)
     * @param lockedOut    재진입 금지 중인 코드(스탑 뒤 kr.lockoutTradingDays)
     * @param suspended    D에 거래정지인 코드
     */
    public record Input(LocalDate session, LocalDate universeDate, List<Member> universe,
                        Map<String, List<FlowDay>> flows, Map<String, Financials> financials,
                        Set<String> lockedOut, Set<String> suspended) {

        public Input {
            Objects.requireNonNull(session, "session");
            Objects.requireNonNull(universeDate, "universeDate");
            if (!universeDate.isBefore(session)) {
                throw new IllegalArgumentException("U의 금융위 기준일(" + universeDate + ")은 기준 세션(" + session
                        + ")보다 앞이어야 합니다(§4-5 U(D)는 기준일 < D)");
            }
            universe = List.copyOf(Objects.requireNonNull(universe, "universe"));
            flows = flows == null ? Map.of() : Collections.unmodifiableMap(new HashMap<>(flows));
            financials = financials == null ? Map.of() : Collections.unmodifiableMap(new HashMap<>(financials));
            lockedOut = lockedOut == null ? Set.of() : Set.copyOf(lockedOut);
            suspended = suspended == null ? Set.of() : Set.copyOf(suspended);
        }
    }

    // ------------------------------------------------------------------ 수급 창

    /**
     * 한 종목의 수급 창 요약(K7·K26 동결).
     *
     * @param windowStart      창의 첫 날(D 앞 19번째 KR 거래일)
     * @param windowEnd        창의 끝 = D
     * @param daysAvailable    창 안에서 외국인·기관 기록이 모두 있는 날 수(0~20)
     * @param foreignNet20     창의 외국인 순매수 합(주). 창이 덜 차면 null
     * @param institutionNet20 창의 기관 순매수 합(주). 창이 덜 차면 null
     * @param foreignNet5      마지막 5거래일 외국인 합(그 5일이 다 있을 때만)
     * @param institutionNet5  마지막 5거래일 기관 합
     * @param streakDays       D부터 거슬러 외국인·기관이 함께 순매수한 연속일(창 안, 0~20). 창이 덜 차면 null
     * @param sessionUpdatedAt D 기록의 토스 {@code updatedAt}(그 판 — 20:2x 저녁판인지 D+1 06:50판인지). D 기록이 없으면 null
     */
    public record FlowSummary(LocalDate windowStart, LocalDate windowEnd, int daysAvailable, Long foreignNet20,
                              Long institutionNet20, Long foreignNet5, Long institutionNet5, Integer streakDays,
                              String sessionUpdatedAt) {

        /** 창 20거래일이 다 찼나. */
        public boolean complete() {
            return foreignNet20 != null && institutionNet20 != null;
        }

        /** 둘 다 순매수(> 0) — 후보 조건. */
        public boolean bothPositive() {
            return complete() && foreignNet20 > 0 && institutionNet20 > 0;
        }

        /** 둘 다 순매도(< 0) — 매일 매도 신호. */
        public boolean bothNegative() {
            return complete() && foreignNet20 < 0 && institutionNet20 < 0;
        }
    }

    /**
     * D로 끝나는 20거래일 창의 수급 요약. 창 밖 날짜(휴장일·주말·창 앞)의 기록은 보지 않습니다. 같은 날 기록이 둘이면 입력 오류입니다.
     *
     * @param days 그 종목의 일별 기록(순서 상관없음). null이면 없음
     * @throws IllegalArgumentException     D가 KR 거래일이 아니거나 같은 날 기록이 둘
     * @throws CalendarUnavailableException 달력이 창의 해를 모름
     */
    public static FlowSummary flows(TradingCalendar calendar, LocalDate session, List<FlowDay> days) {
        requireTradingDay(calendar, session);
        List<LocalDate> window = new ArrayList<>(FLOW_DAYS);   // 최근 → 과거
        window.add(session);
        while (window.size() < FLOW_DAYS) {
            window.add(calendar.previousTradingDay(window.get(window.size() - 1)));
        }
        Map<LocalDate, FlowDay> byDate = new HashMap<>();
        if (days != null) {
            for (FlowDay day : days) {
                if (day == null || day.date() == null) {
                    continue;
                }
                if (byDate.put(day.date(), day) != null) {
                    throw new IllegalArgumentException(day.date() + " 수급 기록이 둘입니다");
                }
            }
        }
        int available = 0;
        long foreign = 0;
        long institution = 0;
        for (LocalDate day : window) {
            FlowDay record = byDate.get(day);
            if (record != null && record.complete()) {
                available++;
                foreign = Math.addExact(foreign, record.foreignNet());
                institution = Math.addExact(institution, record.institutionNet());
            }
        }
        boolean full = available == FLOW_DAYS;
        Long foreign5 = null;
        Long institution5 = null;
        if (window.subList(0, SHORT_FLOW_DAYS).stream().allMatch(day -> byDate.get(day) != null
                && byDate.get(day).complete())) {
            long f = 0;
            long i = 0;
            for (LocalDate day : window.subList(0, SHORT_FLOW_DAYS)) {
                f = Math.addExact(f, byDate.get(day).foreignNet());
                i = Math.addExact(i, byDate.get(day).institutionNet());
            }
            foreign5 = f;
            institution5 = i;
        }
        Integer streak = null;
        if (full) {
            int run = 0;
            for (LocalDate day : window) {
                FlowDay record = byDate.get(day);
                if (record.foreignNet() > 0 && record.institutionNet() > 0) {
                    run++;
                } else {
                    break;
                }
            }
            streak = run;
        }
        FlowDay last = byDate.get(session);
        return new FlowSummary(window.get(FLOW_DAYS - 1), session, available, full ? foreign : null,
                full ? institution : null, foreign5, institution5, streak, last == null ? null : last.updatedAt());
    }

    // ------------------------------------------------------------------ 후보

    /** 후보에서 빠지는 사유(남기는 순서 그대로). */
    public enum Reason {
        SUSPENDED("거래정지"),
        LOCKED_OUT("재진입 금지"),
        FLOWS_INSUFFICIENT("자료 부족"),
        FLOWS_NOT_BOTH_POSITIVE("수급 미달"),
        STREAK_SHORT("연속 순매수 미달"),
        NO_DATA("자료 없음"),
        FINANCIAL("재무 미달");

        private final String label;

        Reason(String label) {
            this.label = label;
        }

        /** 화면·기록의 이름. */
        public String label() {
            return label;
        }
    }

    /**
     * 빠진 사유 하나.
     *
     * @param sub    세부 사유(자료 없음·재무 미달은 위 상수, 나머지는 {@link Reason#label})
     * @param detail 숫자를 넣은 문장(사람이 읽는 것)
     */
    public record Exclusion(Reason reason, String sub, String detail) {
    }

    /**
     * U 한 종목의 판정.
     *
     * @param financials  그 회사의 DART 재무(없으면 null)
     * @param receiptDate 그 보고서의 접수일(모르면 null)
     * @param score       점수 — 창이 다 차고 상장주식수가 있으면 후보가 아니어도 셈(동결·화면). 아니면 null
     * @param exclusions  빠진 사유(비어 있으면 후보)
     */
    public record Evaluation(Member member, FlowSummary flows, Financials financials, LocalDate receiptDate, Double score,
                             List<Exclusion> exclusions) {

        public Evaluation {
            exclusions = List.copyOf(exclusions);
        }

        public String code() {
            return member.code();
        }

        public boolean candidate() {
            return exclusions.isEmpty();
        }

        /** 그 사유로 빠졌나. */
        public boolean excludedBy(Reason reason) {
            return exclusions.stream().anyMatch(e -> e.reason() == reason);
        }
    }

    /**
     * U 종목마다 판정(U 순서 그대로). 클래스 설명의 후보 조건과 사유.
     *
     * @throws IllegalArgumentException     U에 같은 코드가 둘, D가 거래일이 아님
     * @throws CalendarUnavailableException 달력이 창의 해를 모름
     */
    public static List<Evaluation> evaluate(TradingCalendar calendar, Input input, Params params) {
        Objects.requireNonNull(input, "input");
        Objects.requireNonNull(params, "params");
        LocalDate session = input.session();
        Set<String> seen = new HashSet<>();
        List<Evaluation> out = new ArrayList<>();
        for (Member member : input.universe()) {
            String code = member.code();
            if (!seen.add(code)) {
                throw new IllegalArgumentException("U에 같은 코드가 둘입니다: " + code);
            }
            FlowSummary flows = flows(calendar, session, input.flows().get(code));
            List<Exclusion> exclusions = new ArrayList<>();
            if (input.suspended().contains(code)) {
                exclusions.add(new Exclusion(Reason.SUSPENDED, Reason.SUSPENDED.label(), session + " 거래정지 — 체결할 수 없음"));
            }
            if (input.lockedOut().contains(code)) {
                exclusions.add(new Exclusion(Reason.LOCKED_OUT, Reason.LOCKED_OUT.label(), "스탑 뒤 재진입 금지 기간"));
            }
            if (!flows.complete()) {
                exclusions.add(new Exclusion(Reason.FLOWS_INSUFFICIENT, Reason.FLOWS_INSUFFICIENT.label(),
                        String.format(Locale.ROOT, "수급 %d거래일 중 %d일만 있음(%s~%s)", FLOW_DAYS, flows.daysAvailable(),
                                flows.windowStart(), flows.windowEnd())));
            } else {
                if (!flows.bothPositive()) {
                    exclusions.add(new Exclusion(Reason.FLOWS_NOT_BOTH_POSITIVE, Reason.FLOWS_NOT_BOTH_POSITIVE.label(),
                            String.format(Locale.ROOT, "%d거래일 외국인 %s주 · 기관 %s주 — 둘 다 순매수여야 함", FLOW_DAYS,
                                    signed(flows.foreignNet20()), signed(flows.institutionNet20()))));
                }
                if (params.minStreakDays() > 0 && flows.streakDays() < params.minStreakDays()) {
                    exclusions.add(new Exclusion(Reason.STREAK_SHORT, Reason.STREAK_SHORT.label(),
                            String.format(Locale.ROOT, "외국인·기관 동시 순매수 연속 %d일 < %d일", flows.streakDays(),
                                    params.minStreakDays())));
                }
            }
            Double score = null;
            if (member.listedShares() == null || member.listedShares() <= 0) {
                exclusions.add(new Exclusion(Reason.NO_DATA, NO_LISTED_SHARES, NO_LISTED_SHARES + "(금융위, U 기준일 "
                        + input.universeDate() + ")"));
            } else if (flows.complete()) {
                score = (double) (flows.foreignNet20() + flows.institutionNet20()) / member.listedShares() * 100.0;
            }
            Financials financials = input.financials().get(code);
            LocalDate receipt = financials == null ? null : financials.receiptDate();
            financialExclusions(financials, receipt, session, params, exclusions);
            out.add(new Evaluation(member, flows, financials, receipt, score, exclusions));
        }
        return out;
    }

    /** 재무 필터(클래스 설명) — 사유를 {@code out}에 더합니다. */
    private static void financialExclusions(Financials financials, LocalDate receipt, LocalDate session, Params params,
                                            List<Exclusion> out) {
        if (financials == null) {
            out.add(new Exclusion(Reason.NO_DATA, NO_DART, NO_DART + "(DART 주요계정 저장본에 그 회사가 없음)"));
            return;
        }
        if (receipt == null) {
            out.add(new Exclusion(Reason.NO_DATA, RECEIPT_UNKNOWN, RECEIPT_UNKNOWN + "(접수번호 " + financials.rceptNo()
                    + " — 14자리 숫자가 아님)"));
            return;
        }
        if (receipt.isAfter(session)) {
            out.add(new Exclusion(Reason.NO_DATA, RECEIPT_AFTER_BASE, RECEIPT_AFTER_BASE + "(접수 " + receipt + " > 기준 "
                    + session + " — 저장본에 이전 보고서 없음)"));
            return;
        }
        if (financials.capitalImpaired()) {
            out.add(new Exclusion(Reason.FINANCIAL, CAPITAL_IMPAIRED, CAPITAL_IMPAIRED + "(자본총계 0 이하 — "
                    + financials.bsnsYear() + " 사업보고서)"));
            return;
        }
        Double roe = financials.roePct();
        if (roe == null) {
            out.add(new Exclusion(Reason.NO_DATA, NO_ROE, NO_ROE + "(당기순이익·자본총계 계정을 셀 수 없음)"));
        } else if (!(roe > 0)) {
            out.add(new Exclusion(Reason.FINANCIAL, ROE_NOT_POSITIVE,
                    String.format(Locale.ROOT, "ROE %.2f%% — 0보다 커야 함", roe)));
        }
        if (financials.hasRevenueAccount()) {
            Double debt = financials.debtRatioPct();
            if (debt == null) {
                out.add(new Exclusion(Reason.NO_DATA, NO_DEBT_RATIO, NO_DEBT_RATIO + "(부채총계·자본총계 계정을 셀 수 없음)"));
            } else if (debt > params.debtRatioMaxPct()) {
                out.add(new Exclusion(Reason.FINANCIAL, DEBT_RATIO_OVER, String.format(Locale.ROOT,
                        "부채비율 %.1f%% > 상한 %s%%(매출액 계정이 있는 비금융)", debt, plain(params.debtRatioMaxPct()))));
            }
        }
    }

    // ------------------------------------------------------------------ 배분

    /**
     * 매수 종목 하나의 목표.
     *
     * @param rankInPlan 점수 순위(1부터)
     * @param weightPct  목표 비중(순자산 %, 반올림 전)
     */
    public record Target(String code, int rankInPlan, double score, double weightPct) {
    }

    /**
     * 한 선정의 결과(K26 동결 — 부르는 쪽이 결정 행 JSONB로 옮김).
     *
     * @param evaluations      U 종목마다 판정(U 순서)
     * @param candidates       후보(점수 순 — 동점은 U 순위·코드 순)
     * @param targets          매수 종목(후보 앞쪽 최대 maxNames)과 목표 비중
     * @param stockWeightPct   종목 목표 비중 합
     * @param parkingWeightPct 남는 비중(153130 목표) = 100 − 종목 합
     */
    public record Selection(LocalDate session, LocalDate universeDate, Params params, List<Evaluation> evaluations,
                            List<Evaluation> candidates, List<Target> targets, double stockWeightPct,
                            double parkingWeightPct) {

        public Selection {
            evaluations = List.copyOf(evaluations);
            candidates = List.copyOf(candidates);
            targets = List.copyOf(targets);
        }

        /** 후보 코드(점수 순). 재선정일 매도 신호 '후보 밖'의 기준. */
        public Set<String> candidateCodes() {
            Set<String> out = new LinkedHashSet<>();
            candidates.forEach(e -> out.add(e.code()));
            return Collections.unmodifiableSet(out);
        }

        /** 후보이지만 상위 maxNames 밖이라 사지 않는 종목(점수 순). */
        public List<Evaluation> notChosen() {
            return candidates.subList(targets.size(), candidates.size());
        }

        /** 사유마다 그 사유로 빠진 종목 수(한 종목이 여러 사유면 각각 셈). 없는 사유는 넣지 않음. */
        public Map<Reason, Integer> exclusionCounts() {
            Map<Reason, Integer> out = new EnumMap<>(Reason.class);
            for (Evaluation evaluation : evaluations) {
                evaluation.exclusions().stream().map(Exclusion::reason).distinct()
                        .forEach(reason -> out.merge(reason, 1, Integer::sum));
            }
            return out;
        }
    }

    /** 후보 정렬 — 점수 내림차순, 동점은 U 순위(시총 순)·코드 순. */
    static final Comparator<Evaluation> BY_SCORE = Comparator
            .comparing((Evaluation e) -> e.score(), Comparator.reverseOrder())
            .thenComparingInt(e -> e.member().rank())
            .thenComparing(Evaluation::code);

    /**
     * 선정 — 판정({@link #evaluate}) → 후보 정렬 → 상위 maxNames와 목표 비중(클래스 설명). 재선정일·따라잡기·출발이 같은 계산입니다(§4-6).
     *
     * @throws IllegalArgumentException     {@link #evaluate}와 같음
     * @throws CalendarUnavailableException 달력이 창의 해를 모름
     */
    public static Selection select(TradingCalendar calendar, Input input, Params params) {
        List<Evaluation> evaluations = evaluate(calendar, input, params);
        List<Evaluation> candidates = evaluations.stream().filter(Evaluation::candidate).sorted(BY_SCORE).toList();
        List<Evaluation> chosen = candidates.subList(0, Math.min(params.maxNames(), candidates.size()));
        double slot = 100.0 / params.maxNames();
        double scoreSum = chosen.stream().mapToDouble(Evaluation::score).sum();
        double budget = chosen.size() * slot;
        List<Target> targets = new ArrayList<>();
        double stock = 0;
        int rank = 0;
        for (Evaluation evaluation : chosen) {
            double weight = params.weighting() == Weighting.EQUAL
                    ? slot
                    : budget * evaluation.score() / scoreSum;   // 후보 점수는 늘 > 0(둘 다 순매수·상장주식수 > 0)
            weight = Math.min(weight, params.maxWeightStockPct());
            targets.add(new Target(evaluation.code(), ++rank, evaluation.score(), weight));
            stock += weight;
        }
        double parking = 100.0 - stock;
        if (parking < WEIGHT_EPSILON) {
            parking = 0;
        }
        return new Selection(input.session(), input.universeDate(), params, evaluations, candidates, targets, stock,
                parking);
    }

    // ------------------------------------------------------------------ 매도 신호·남는 현금

    /** 보유 종목의 매도 신호(§4-6 '매도 신호(매일)' — 트레일링 스탑은 장부가 따로 봄). */
    public enum SellReason {
        /** 20일 외국인·기관 순매수 합이 둘 다 < 0 — 매일 봄. */
        FLOWS_BOTH_NEGATIVE("20일 외국인·기관 둘 다 순매도"),
        /** 재선정(따라잡기 포함)한 날에 후보 밖. */
        OUT_OF_CANDIDATES("재선정 — 후보 밖");

        private final String label;

        SellReason(String label) {
            this.label = label;
        }

        public String label() {
            return label;
        }
    }

    /**
     * 보유 한 종목의 매도 판정(K26 동결 — 매도 근거의 수급 창도 함께).
     *
     * @param reasons 매도 사유(비어 있으면 그대로 보유). 창이 덜 찬 종목은 매일 신호를 볼 수 없어 사유가 없음(재선정일에는 후보가
     *                아니므로 '후보 밖')
     */
    public record HoldingCheck(String code, FlowSummary flows, List<SellReason> reasons) {

        public HoldingCheck {
            reasons = List.copyOf(reasons);
        }

        public boolean sell() {
            return !reasons.isEmpty();
        }
    }

    /**
     * 보유 종목마다 매도 판정(코드 순). 현금성 종목과 153130은 보지 않습니다(남는 현금 자리 — 신호가 아님). U 밖 보유도 수급이
     * 있으면 매일 신호를 봅니다(수집 범위의 끈적 목록 — §4-5).
     *
     * @param candidateCodes 그날 재선정했으면 그 선정의 후보 코드({@link Selection#candidateCodes}), 재선정일이 아니면 null.
     *                       후보이지만 상위 maxNames 밖인 보유는 팔지 않습니다 — 매도 조건은 '후보 밖'이고 상위 N은 매수 자리입니다
     *                       (미국 규칙 책도 보유를 신호로만 팖)
     * @param cashLike       현금성 코드({@code kr.cashLikeTickers}). null이면 없음
     * @throws IllegalArgumentException     D가 거래일이 아님
     * @throws CalendarUnavailableException 달력이 창의 해를 모름
     */
    public static List<HoldingCheck> holdingChecks(TradingCalendar calendar, LocalDate session, Collection<String> holdings,
                                                   Map<String, List<FlowDay>> flows, Set<String> candidateCodes,
                                                   Set<String> cashLike) {
        Map<String, List<FlowDay>> byCode = flows == null ? Map.of() : flows;
        Set<String> skip = cashLike == null ? Set.of() : cashLike;
        List<HoldingCheck> out = new ArrayList<>();
        for (String code : new TreeSet<>(holdings == null ? List.<String>of() : holdings)) {
            if (code == null || PARKING_CODE.equals(code) || skip.contains(code)) {
                continue;
            }
            FlowSummary summary = flows(calendar, session, byCode.get(code));
            List<SellReason> reasons = new ArrayList<>();
            if (summary.bothNegative()) {
                reasons.add(SellReason.FLOWS_BOTH_NEGATIVE);
            }
            if (candidateCodes != null && !candidateCodes.contains(code)) {
                reasons.add(SellReason.OUT_OF_CANDIDATES);
            }
            out.add(new HoldingCheck(code, summary, reasons));
        }
        return out;
    }

    /**
     * 남는 현금을 153130에 두는 폭(순자산 %p) — 미국 규칙 책의 남는 현금 규칙과 같은 모양(R3, {@code parkIdleCash}). 어림한 남는 현금
     * (현금 + 대기·이번 매도 대금 − 대기·이번 매수 금액)이 기준을 넘으면 {@value #CASH_BUFFER_PCT}%p를 현금으로 남기고 나머지를 둡니다.
     * 재선정일(따라잡기·출발 포함)은 기준 없이 여유만 — 남는 비중을 모두 153130에 두는 날입니다. 그 밖의 날은
     * max({@code kr.rules.parkCashThresholdPct}, 여유) — 매도 대금 몇십만 원마다 153130을 사고팔아 비용을 날마다 내지 않게.
     *
     * @param spareCashPct 어림한 남는 현금(순자산 %)
     * @return 153130 매수 폭(%p, 0이면 사지 않음)
     * @throws IllegalArgumentException 남는 현금이 유한한 수가 아니거나 기준이 0~100 밖
     */
    public static double parkingIncrementPct(double spareCashPct, boolean selectionDay, double thresholdPct) {
        if (!Double.isFinite(spareCashPct)) {
            throw new IllegalArgumentException("남는 현금(%)이 유한한 수가 아닙니다: " + spareCashPct);
        }
        if (!Double.isFinite(thresholdPct) || thresholdPct < 0 || thresholdPct > 100) {
            throw new IllegalArgumentException("남는 현금 기준(%)은 0~100이어야 합니다: " + thresholdPct);
        }
        double trigger = selectionDay ? CASH_BUFFER_PCT : Math.max(thresholdPct, CASH_BUFFER_PCT);
        return spareCashPct > trigger ? spareCashPct - CASH_BUFFER_PCT : 0.0;
    }

    // ------------------------------------------------------------------ 조각

    private static void requireTradingDay(TradingCalendar calendar, LocalDate session) {
        Objects.requireNonNull(calendar, "calendar");
        Objects.requireNonNull(session, "session");
        if (!calendar.isTradingDay(session)) {
            throw new IllegalArgumentException(session + "는 KR 거래일이 아닙니다 — 규칙 계좌 결정은 거래일에만 냅니다");
        }
    }

    /** 부호를 붙인 정수(천 단위 쉼표). */
    private static String signed(long value) {
        return String.format(Locale.ROOT, "%+,d", value);
    }

    /** 정수면 정수로, 아니면 그대로(상한 200 → "200"). */
    private static String plain(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }
}
