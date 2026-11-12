package com.macrodash.analytics;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 결정이 남긴 조건의 평가(ADR 0038) — Claude 결정이 "이 값이 이 수준을 넘으면(밑돌면) 이렇게 한다"고 적은 조건을 다음 결정·장중 판단의 패킷에
 * 돌려줄 때, <b>코드가</b> 지금 값으로 충족 여부를 매깁니다. 조건을 글로만 적으면 다음 패킷에서 잘려 나가거나(요약 300자) 모델이 스스로 적은
 * 수준을 지나치고도 알아채지 못했습니다(2026-11-11 미국 결정의 '10년물 5.1% 초과' 조건 — 다음 세션 장중 판단이 5.101%를 보고도 다루지 않음).
 *
 * <p>평가는 숫자 비교 하나입니다 — 조건의 이름({@code metric})을 패킷의 값 표(이름 → 값, 대소문자 무시)에서 찾아 {@link #ABOVE}면 값 &gt; 수준,
 * {@link #BELOW}면 값 &lt; 수준. 이름이 표에 없거나 수준이 숫자가 아니면 {@link #UNEVALUABLE}이고 이유를 남깁니다(없는 값을 지어내지 않음 — 그
 * 조건은 모델이 직접 확인). 조건은 판단할 계기일 뿐 주문을 내지 않습니다 — 이 클래스는 장부·검증기를 건드리지 않습니다.
 */
public final class CarriedConditions {

    private CarriedConditions() {
    }

    public static final String ABOVE = "ABOVE";
    public static final String BELOW = "BELOW";
    public static final String MET = "충족";
    public static final String NOT_MET = "미충족";
    public static final String UNEVALUABLE = "평가 불가";

    /** 결정이 적은 조건 한 줄 — 이름·방향·수준·충족되면 할 일. */
    public record Condition(String metric, String op, Double level, String then) {
    }

    /** 평가한 조건 — 지금 값(없으면 null)·상태·평가하지 못한 이유(평가했으면 null). */
    public record Evaluated(Condition condition, Double current, String status, String reason) {
    }

    /** 값 표의 열쇠 — 앞뒤 공백을 떼고 소문자로(티커·매크로 이름을 같은 표에서 찾게). null이면 null. */
    public static String key(String name) {
        return name == null ? null : name.strip().toLowerCase(Locale.ROOT);
    }

    /** 이름 → 값 표를 열쇠({@link #key}) 기준으로 다시 만듭니다. 값이 null이거나 유한하지 않은 항목은 뺍니다. 같은 열쇠는 먼저 넣은 값. */
    public static Map<String, Double> index(Map<String, Double> values) {
        Map<String, Double> out = new LinkedHashMap<>();
        if (values != null) {
            values.forEach((name, value) -> {
                String key = key(name);
                if (key != null && !key.isEmpty() && value != null && Double.isFinite(value)) {
                    out.putIfAbsent(key, value);
                }
            });
        }
        return out;
    }

    /**
     * 조건 하나를 지금 값으로 평가합니다.
     *
     * @param indexed {@link #index}로 만든 값 표
     */
    public static Evaluated evaluate(Condition c, Map<String, Double> indexed) {
        if (c == null) {
            return new Evaluated(null, null, UNEVALUABLE, "조건 없음");
        }
        String key = key(c.metric());
        Double current = key == null ? null : indexed.get(key);
        if (key == null || key.isEmpty()) {
            return new Evaluated(c, null, UNEVALUABLE, "이름(metric) 없음");
        }
        if (c.level() == null || !Double.isFinite(c.level())) {
            return new Evaluated(c, current, UNEVALUABLE, "수준(level)이 숫자가 아님");
        }
        if (!ABOVE.equals(c.op()) && !BELOW.equals(c.op())) {
            return new Evaluated(c, current, UNEVALUABLE, "방향(op)이 ABOVE·BELOW가 아님");
        }
        if (current == null) {
            return new Evaluated(c, null, UNEVALUABLE, "이 패킷에 그 이름의 값이 없음 — 직접 확인");
        }
        boolean met = ABOVE.equals(c.op()) ? current > c.level() : current < c.level();
        return new Evaluated(c, current, met ? MET : NOT_MET, null);
    }

    /** 조건 목록을 적힌 순서대로 평가합니다. */
    public static List<Evaluated> evaluate(List<Condition> conditions, Map<String, Double> indexed) {
        List<Evaluated> out = new ArrayList<>();
        if (conditions != null) {
            for (Condition c : conditions) {
                out.add(evaluate(c, indexed));
            }
        }
        return out;
    }
}
