package com.macrodash.analytics;

import com.macrodash.analytics.CarriedConditions.Condition;
import com.macrodash.analytics.CarriedConditions.Evaluated;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** 결정이 남긴 조건의 평가(ADR 0038) — 숫자 비교 하나, 값이 없으면 평가 불가(지어내지 않음). */
class CarriedConditionsTest {

    private static Map<String, Double> values() {
        Map<String, Double> raw = new LinkedHashMap<>();
        raw.put("us10y", 5.101);
        raw.put("AAPL", 230.0);
        raw.put("kospiForeignNet5", -11495.0);
        raw.put("blank", null);
        raw.put("nan", Double.NaN);
        raw.put("US10Y", 9.9);   // 같은 열쇠는 먼저 넣은 값
        return CarriedConditions.index(raw);
    }

    @Test
    @DisplayName("초과·미만은 경계를 포함하지 않는다 — 10년물 5.101%는 '5.1% 초과' 충족, '5.101% 초과'는 미충족")
    void strictComparison() {
        Map<String, Double> values = values();
        assertThat(CarriedConditions.evaluate(new Condition("us10y", "ABOVE", 5.1, "노출 축소 검토"), values))
                .extracting(Evaluated::status, Evaluated::current, Evaluated::reason)
                .containsExactly(CarriedConditions.MET, 5.101, null);
        assertThat(CarriedConditions.evaluate(new Condition("us10y", "ABOVE", 5.101, "x"), values).status())
                .isEqualTo(CarriedConditions.NOT_MET);
        assertThat(CarriedConditions.evaluate(new Condition("us10y", "BELOW", 4.75, "노출 확대 검토"), values).status())
                .isEqualTo(CarriedConditions.NOT_MET);
        assertThat(CarriedConditions.evaluate(new Condition("kospiForeignNet5", "BELOW", 0.0, "관망 유지"), values).status())
                .isEqualTo(CarriedConditions.MET);
    }

    @Test
    @DisplayName("이름은 대소문자·앞뒤 공백을 가리지 않고 찾는다(티커·매크로 이름이 한 표)")
    void namesAreCaseInsensitive() {
        Map<String, Double> values = values();
        assertThat(values).containsOnlyKeys("us10y", "aapl", "kospiforeignnet5");
        assertThat(CarriedConditions.evaluate(new Condition(" aapl ", "BELOW", 240.0, "매도"), values).status())
                .isEqualTo(CarriedConditions.MET);
        assertThat(CarriedConditions.evaluate(new Condition("US10Y", "ABOVE", 5.0, "x"), values).current()).isEqualTo(5.101);
    }

    @Test
    @DisplayName("값이 없거나 모양이 틀린 조건은 평가 불가와 이유 — 충족·미충족으로 지어내지 않는다")
    void unevaluable() {
        Map<String, Double> values = values();
        assertThat(CarriedConditions.evaluate(new Condition("cpi", "ABOVE", 3.0, "x"), values))
                .extracting(Evaluated::status, Evaluated::current, Evaluated::reason)
                .containsExactly(CarriedConditions.UNEVALUABLE, null, "이 패킷에 그 이름의 값이 없음 — 직접 확인");
        assertThat(CarriedConditions.evaluate(new Condition("us10y", "ABOVE", null, "x"), values).reason())
                .isEqualTo("수준(level)이 숫자가 아님");
        assertThat(CarriedConditions.evaluate(new Condition("us10y", "CROSS", 5.0, "x"), values).reason())
                .isEqualTo("방향(op)이 ABOVE·BELOW가 아님");
        assertThat(CarriedConditions.evaluate(new Condition(" ", "ABOVE", 5.0, "x"), values).reason())
                .isEqualTo("이름(metric) 없음");
        assertThat(CarriedConditions.evaluate(new Condition(null, "ABOVE", 5.0, "x"), values).status())
                .isEqualTo(CarriedConditions.UNEVALUABLE);
        assertThat(CarriedConditions.evaluate((Condition) null, values).status()).isEqualTo(CarriedConditions.UNEVALUABLE);
        assertThat(CarriedConditions.evaluate(new Condition("blank", "ABOVE", 1.0, "x"), values).status())
                .as("값이 null·NaN인 이름은 표에 없음").isEqualTo(CarriedConditions.UNEVALUABLE);
    }

    @Test
    @DisplayName("목록은 적힌 순서 그대로 평가한다(null 목록은 빈 결과)")
    void listKeepsOrder() {
        List<Evaluated> out = CarriedConditions.evaluate(Arrays.asList(new Condition("aapl", "ABOVE", 200.0, "a"),
                new Condition("cpi", "ABOVE", 3.0, "b"), new Condition("us10y", "BELOW", 5.0, "c")), values());
        assertThat(out).extracting(Evaluated::status).containsExactly(CarriedConditions.MET, CarriedConditions.UNEVALUABLE,
                CarriedConditions.NOT_MET);
        assertThat(CarriedConditions.evaluate((List<Condition>) null, values())).isEmpty();
    }
}
