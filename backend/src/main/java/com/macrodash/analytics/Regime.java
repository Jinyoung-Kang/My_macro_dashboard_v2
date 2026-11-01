package com.macrodash.analytics;

import java.util.ArrayList;
import java.util.List;

/**
 * 시장 국면(Regime) 판정 — 성장·신용 축 × 유동성 축.
 *
 * <p><b>왜 2축 4국면인가</b> — 단일 지표로 "지금은 침체다"라고 말하면 틀릴 때
 * 왜 틀렸는지 알 수 없습니다. 여기서는 축을 둘로 나눕니다.
 * <ul>
 *   <li><b>성장·신용</b> — 장단기 금리차(10Y-3M), 금융상황지수(NFCI),
 *       하이일드 스프레드. 실물·신용 쪽이 조이고 있는가.</li>
 *   <li><b>유동성</b> — 연준 순유동성의 4주 방향. 돈이 들어오는가 나가는가.</li>
 * </ul>
 * 두 축의 조합이 곧 국면입니다. 각 축이 어떤 신호로 그렇게 판정됐는지 함께
 * 돌려주므로, 결론에 동의하지 않더라도 <b>근거는 그대로 확인</b>할 수 있습니다.
 *
 * <p>이 프로젝트의 규칙: 입력이 하나라도 없으면 <b>판정하지 않습니다</b>
 * ({@code UNKNOWN}). 빠진 값을 0으로 메우면 "중립"이라는 틀린 판정이 됩니다.
 *
 * <p>주의: 임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.
 */
public final class Regime {

    private Regime() {
    }

    /**
     * 판정 규칙의 판. 임계치·축 구성을 바꾸면 올립니다 — 라이브 기록(regime_log)이 어느 규칙으로
     * 낸 판정인지 남겨, 규칙이 바뀐 날을 성과 집계에서 구분할 수 있게 합니다.
     */
    public static final String RULE_VERSION = "v1";

    /** 하이일드 스프레드 경보 임계치(%p). README의 해석 기준표와 같은 값입니다. */
    public static final double HY_ALERT = 7.0;
    /** 하이일드 스프레드 주의 임계치(%p). */
    public static final double HY_WATCH = 5.0;

    /** 판정에 쓰인 신호 하나. */
    public record Signal(String id, String label, Double value, String unit,
                         String state, String reading, boolean healthy) {
    }

    /** 국면 판정 결과. */
    public record Verdict(String code, String label, String summary,
                          String growthAxis, String liquidityAxis,
                          List<Signal> signals, List<String> missing) {

        public boolean known() {
            return !"UNKNOWN".equals(code);
        }
    }

    /**
     * 국면 판정.
     *
     * @param curve10y3m 장단기 금리차 10Y-3M (%p) — 음수면 역전
     * @param nfci       시카고 연준 금융상황지수 — 0보다 크면 평균보다 긴축적
     * @param hyOas      하이일드 스프레드 (%p)
     * @param liquidity4w 순유동성 4주 변화 (조 달러) — 양수면 유입
     * @return 국면 코드·라벨·근거 신호. <b>입력이 하나라도 null이면 "판정 불가"</b>이며
     *         {@code missing}에 빠진 지표 이름이 담깁니다 — 빠진 값을 0으로 메우면
     *         "중립"이라는 틀린 판정이 됩니다
     */
    public static Verdict classify(Double curve10y3m, Double nfci, Double hyOas,
                                   Double liquidity4w) {
        List<String> missing = new ArrayList<>();
        if (curve10y3m == null) {
            missing.add("장단기 금리차 (T10Y3M)");
        }
        if (nfci == null) {
            missing.add("금융상황지수 (NFCI)");
        }
        if (hyOas == null) {
            missing.add("하이일드 스프레드 (HY OAS)");
        }
        if (liquidity4w == null) {
            missing.add("연준 순유동성 4주 변화");
        }

        List<Signal> signals = new ArrayList<>();
        if (curve10y3m != null) {
            boolean inverted = curve10y3m < 0;
            signals.add(new Signal("curve", "장단기 금리차 10Y-3M", curve10y3m, "%p",
                    inverted ? "역전" : "정상",
                    inverted
                            ? "단기 금리가 장기보다 높습니다. 역사적으로 1~2년 내 침체가 뒤따른 구간입니다."
                            : "장기 금리가 단기보다 높습니다(정상 구조).",
                    !inverted));
        }
        if (nfci != null) {
            boolean tight = nfci > 0;
            signals.add(new Signal("nfci", "시카고 연준 금융상황지수", nfci, "",
                    tight ? "긴축적" : "완화적",
                    tight
                            ? "0(장기 평균)보다 높습니다 — 자금 조달 여건이 평균보다 빡빡합니다."
                            : "0(장기 평균)보다 낮습니다 — 자금 조달 여건이 평균보다 느슨합니다.",
                    !tight));
        }
        if (hyOas != null) {
            String state = hyOas >= HY_ALERT ? "경색" : hyOas >= HY_WATCH ? "주의" : "정상";
            signals.add(new Signal("hyOas", "하이일드 스프레드", hyOas, "%p", state,
                    hyOas >= HY_ALERT
                            ? "%.1f%%p 이상은 본격적인 신용경색 구간입니다.".formatted(HY_ALERT)
                            : hyOas >= HY_WATCH
                                    ? "정상 범위(3.5~5.0%p)를 벗어났습니다."
                                    : "정상 범위입니다.",
                    hyOas < HY_WATCH));
        }
        if (liquidity4w != null) {
            boolean inflow = liquidity4w > 0;
            signals.add(new Signal("liquidity", "연준 순유동성 4주 변화", liquidity4w, "조 달러",
                    inflow ? "확대" : "축소",
                    inflow
                            ? "최근 4주 동안 시장으로 유동성이 들어왔습니다."
                            : "최근 4주 동안 시장에서 유동성이 빠져나갔습니다.",
                    inflow));
        }

        if (!missing.isEmpty()) {
            return new Verdict("UNKNOWN", "판정 불가",
                    "입력 지표가 빠져 국면을 판정하지 않습니다. 빠진 값을 0으로 메우면 "
                            + "'중립'이라는 틀린 판정이 됩니다.",
                    "판정 불가", "판정 불가", signals, missing);
        }

        // 성장·신용 축: 셋 중 하나라도 나쁘면 '악화'입니다.
        // (셋을 평균 내면 하나의 심각한 신호가 나머지 둘에 희석됩니다.)
        boolean growthHealthy = curve10y3m >= 0 && nfci <= 0 && hyOas < HY_WATCH;
        boolean liquidityInflow = liquidity4w > 0;

        String growthAxis = growthHealthy ? "양호" : "악화";
        String liquidityAxis = liquidityInflow ? "확대" : "축소";

        if (growthHealthy && liquidityInflow) {
            return new Verdict("EXPANSION", "확장 (Expansion)",
                    "성장·신용 신호가 모두 정상이고 유동성도 들어오고 있습니다. "
                            + "위험자산에 우호적인 조합입니다.",
                    growthAxis, liquidityAxis, signals, missing);
        }
        if (growthHealthy) {
            return new Verdict("LATE", "후퇴 경계 (Late cycle)",
                    "실물·신용 지표는 아직 정상이지만 유동성이 빠지고 있습니다. "
                            + "상승이 이어져도 폭이 좁아지기 쉬운 구간입니다.",
                    growthAxis, liquidityAxis, signals, missing);
        }
        if (liquidityInflow) {
            return new Verdict("RECOVERY", "회복 (Recovery)",
                    "실물·신용은 아직 나쁘지만 유동성이 먼저 돌아서고 있습니다. "
                            + "역사적으로 정책 대응이 바닥을 만드는 구간과 겹칩니다.",
                    growthAxis, liquidityAxis, signals, missing);
        }
        return new Verdict("CONTRACTION", "침체 경계 (Contraction)",
                "실물·신용이 조이는 동시에 유동성도 빠지고 있습니다. "
                        + "두 축이 함께 나쁜, 가장 방어적인 구간입니다.",
                growthAxis, liquidityAxis, signals, missing);
    }
}
