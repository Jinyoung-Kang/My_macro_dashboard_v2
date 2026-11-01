package com.macrodash.analytics;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * OS 프롬프트 문자 그대로의 매크로 게이트 <b>지표</b>(명세 D7, 설계 §3-5) — 무엇도 구속하지 않습니다.
 *
 * <p>사용자의 OS 프롬프트는 주식 노출을 묶는 게이트(10년물 4.80% 1단계, 세 조건 확인 뒤 해제)를 적어 두었습니다.
 * 모의 매매에서는 이것을 규칙으로 집행하지 않고(D7 — 현금 비중은 Claude의 재량),
 * 그날그날 OS 원문대로라면 어느 단계였는지만 계산해 {@code paper_gate_log}·개요 화면·Claude 패킷(참고)에 보입니다.
 * 규칙 책과 검증기는 이 값을 읽지 않습니다.
 *
 * <p>조건(임계치는 설정 {@code gate.*}): G1 10Y &lt; stage1(4.80) · G2 10Y ≤ full(4.75) · G3 브렌트 ≤ 95 · G4 WTI ≤ 90 ·
 * G5 USD/JPY ≥ 155. 단계: L2 = G2·G3·G4가 모두 confirmDays(3) 거래일 이상 연속, L1 = G1이 confirmDays 이상 연속, 아니면 L0.
 *
 * <p>[확인 필요] 프레임 v1 원문에서 G5(USD/JPY ≥ 155)의 뜻 확인 — OS 원문을 확인하기 전이라 G5는 참고 조건으로
 * conditions·streaks에만 보이고 단계에는 쓰지 않습니다.
 */
public final class GateIndicator {

    private GateIndicator() {
    }

    public static final String G1 = "G1";
    public static final String G2 = "G2";
    public static final String G3 = "G3";
    public static final String G4 = "G4";
    public static final String G5 = "G5";

    public static final String L0 = "L0";
    public static final String L1 = "L1";
    public static final String L2 = "L2";
    /** 입력이 하나라도 없는 날. L0(게이트 닫힘)으로 읽히면 '확인된 상태'처럼 보이므로 따로 둡니다. */
    public static final String UNKNOWN = "UNKNOWN";

    /** 그날 입력. 모르는 값은 null(NaN·무한대도 모르는 값으로 봄). 단위: 10Y %, 유가 달러/배럴, 엔/달러. */
    public record Inputs(Double us10y, Double brent, Double wti, Double usdjpy) {
    }

    /**
     * 임계치.
     *
     * @throws IllegalArgumentException confirmDays &lt; 1 — 0이면 조건이 거짓인 날(연속 0)도 '확인'으로 읽힙니다
     */
    public record Thresholds(double us10yStage1, double us10yFull, double brentMax, double wtiMax, double usdjpyMin,
                             int confirmDays) {
        public Thresholds {
            if (confirmDays < 1) {
                throw new IllegalArgumentException("확인 일수는 1 이상이어야 합니다: " + confirmDays);
            }
        }

        /** OS 원문의 값: 4.80, 4.75, 95, 90, 155, 3거래일. */
        public static Thresholds defaults() {
            return new Thresholds(4.80, 4.75, 95, 90, 155, 3);
        }
    }

    /**
     * @param level      L0·L1·L2·UNKNOWN
     * @param conditions G1~G5 → 참·거짓, 입력이 없으면 null
     * @param streaks    G1~G5 → 연속 거래일 수(거짓이면 0), 입력이 없으면 null
     * @param missing    없는 입력 이름(us10y·brent·wti·usdjpy 순)
     */
    public record Result(String level, Map<String, Boolean> conditions, Map<String, Integer> streaks,
                         List<String> missing) {
    }

    /**
     * 그 거래일의 단계. 거래일마다 한 번, 직전 거래일 결과의 streaks를 넘겨 부르세요(같은 날 두 번 부르면 두 번 셉니다).
     *
     * <p>level: 입력이 하나라도 null이면 "UNKNOWN"(L0로 보지 않음) — 단계에 쓰지 않는 USD/JPY가 빠져도 UNKNOWN입니다
     * (계약: 네 입력이 모두 있는 날만 단계를 말함).
     *
     * <p>입력이 없는 조건의 연속은 null로 끊습니다. 모르는 날을 참으로 이어 세면 확인되지 않은 '3일 연속'이 생기고, 거짓(0)으로
     * 적으면 없는 관측을 만든 것이 됩니다. 다음 날은 null을 0으로 보고 1부터 다시 셉니다.
     *
     * @param previousStreaks 직전 거래일의 streaks. null·빠진 키·null 값은 0(첫날)
     */
    public static Result evaluate(Inputs today, Map<String, Integer> previousStreaks, Thresholds t) {
        Objects.requireNonNull(today, "today");
        Objects.requireNonNull(t, "thresholds");
        Double us10y = known(today.us10y());
        Double brent = known(today.brent());
        Double wti = known(today.wti());
        Double usdjpy = known(today.usdjpy());

        List<String> missing = new ArrayList<>();
        if (us10y == null) {
            missing.add("us10y");
        }
        if (brent == null) {
            missing.add("brent");
        }
        if (wti == null) {
            missing.add("wti");
        }
        if (usdjpy == null) {
            missing.add("usdjpy");
        }

        Map<String, Boolean> conditions = new LinkedHashMap<>();
        conditions.put(G1, us10y == null ? null : us10y < t.us10yStage1());
        conditions.put(G2, us10y == null ? null : us10y <= t.us10yFull());
        conditions.put(G3, brent == null ? null : brent <= t.brentMax());
        conditions.put(G4, wti == null ? null : wti <= t.wtiMax());
        conditions.put(G5, usdjpy == null ? null : usdjpy >= t.usdjpyMin());

        Map<String, Integer> streaks = new LinkedHashMap<>();
        for (Map.Entry<String, Boolean> condition : conditions.entrySet()) {
            Boolean holds = condition.getValue();
            Integer streak = holds == null ? null : holds ? previous(previousStreaks, condition.getKey()) + 1 : 0;
            streaks.put(condition.getKey(), streak);
        }

        String level;
        if (!missing.isEmpty()) {
            level = UNKNOWN;
        } else if (confirmed(streaks, G2, t) && confirmed(streaks, G3, t) && confirmed(streaks, G4, t)) {
            level = L2;
        } else if (confirmed(streaks, G1, t)) {
            level = L1;
        } else {
            level = L0;
        }
        // Map.copyOf는 null 값을 받지 않으므로 unmodifiableMap으로 감쌉니다.
        return new Result(level, Collections.unmodifiableMap(conditions), Collections.unmodifiableMap(streaks),
                List.copyOf(missing));
    }

    private static Double known(Double v) {
        return v == null || !Double.isFinite(v) ? null : v;
    }

    private static int previous(Map<String, Integer> previousStreaks, String key) {
        if (previousStreaks == null) {
            return 0;
        }
        Integer value = previousStreaks.get(key);
        return value == null ? 0 : Math.max(0, value);
    }

    private static boolean confirmed(Map<String, Integer> streaks, String key, Thresholds t) {
        Integer streak = streaks.get(key);
        return streak != null && streak >= t.confirmDays();
    }
}
