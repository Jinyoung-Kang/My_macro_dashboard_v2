package com.macrodash.feature.institution;

import com.macrodash.analytics.HoldingsDiff;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 13F 분기 대비 액션 분류 회귀 테스트.
 *
 * <p>화면과 AI 리포트가 같은 분류를 보도록 계산은 서비스 계층에만 둡니다.
 */
class Sec13FServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final Sec13FService service = new Sec13FService(null);

    @Test
    @DisplayName("직전 분기에 없던 종목은 신규 매수")
    void newPosition() {
        assertThat(HoldingsDiff.classify(2.0, 1000.0, 0.0)).contains("신규 매수");
    }

    @Test
    @DisplayName("이번 분기에 사라진 종목은 전량 매도")
    void closedPosition() {
        assertThat(HoldingsDiff.classify(-2.0, 0.0, 1000.0)).contains("전량 매도");
    }

    @Test
    @DisplayName("비중 증감이 임계치를 넘으면 확대/축소")
    void addedAndReduced() {
        assertThat(HoldingsDiff.classify(0.5, 1200.0, 1000.0)).contains("비중 확대");
        assertThat(HoldingsDiff.classify(-0.5, 800.0, 1000.0)).contains("비중 축소");
    }

    @Test
    @DisplayName("미세한 변화는 유지 (반올림 잡음을 매매로 오인하지 않음)")
    void unchangedWithinEpsilon() {
        assertThat(HoldingsDiff.classify(0.01, 1000.0, 1000.0)).contains("유지");
        assertThat(HoldingsDiff.classify(-0.01, 1000.0, 1000.0)).contains("유지");
    }

    @Test
    @DisplayName("직전 분기가 없으면 '비교 데이터 없음' — 신규 매수로 단정하지 않는다")
    void withoutPreviousQuarterActionIsUnknown() {
        JsonNode current = quarter("2026-06-30", List.of(
                holding("APPLE INC", "037833100", 5000.0, 100.0, 50.0)));

        List<Map<String, Object>> rows = service.compareQuarters(current, null, 10);

        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).get("action")).isEqualTo("비교 데이터 없음");
        assertThat(rows.get(0).get("weightDiff")).isNull();
    }

    @Test
    @DisplayName("CUSIP은 문자열로 유지된다 (앞자리 0이 사라지면 안 됨)")
    void cusipStaysString() {
        JsonNode current = quarter("2026-06-30", List.of(
                holding("SOME CORP", "037833100", 1000.0, 10.0, 100.0)));

        List<Map<String, Object>> rows = service.compareQuarters(current, null, 10);

        assertThat(rows.get(0).get("cusip")).isInstanceOf(String.class).isEqualTo("037833100");
    }

    @Test
    @DisplayName("직전 분기에만 있던 종목은 전량 매도 행으로 추가된다")
    void closedPositionsAppearAsRows() {
        JsonNode current = quarter("2026-06-30", List.of(
                holding("APPLE INC", "037833100", 5000.0, 100.0, 50.0)));
        JsonNode previous = quarter("2026-03-31", List.of(
                holding("APPLE INC", "037833100", 4000.0, 90.0, 40.0),
                holding("TESLA INC", "88160R101", 3000.0, 80.0, 30.0)));

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 10);

        Map<String, Object> tesla = rows.stream()
                .filter(row -> "TESLA INC".equals(row.get("name")))
                .findFirst()
                .orElseThrow();

        assertThat(tesla.get("action")).asString().contains("전량 매도");
        assertThat((Double) tesla.get("weight")).isZero();
    }

    @Test
    @DisplayName("보유 종목은 평가액 내림차순으로 정렬된다")
    void sortedByValue() {
        JsonNode current = quarter("2026-06-30", List.of(
                holding("SMALL CO", "111111111", 100.0, 10.0, 1.0),
                holding("BIG CO", "222222222", 9000.0, 20.0, 90.0)));

        List<Map<String, Object>> rows = service.compareQuarters(current, null, 10);

        assertThat(rows.get(0).get("name")).isEqualTo("BIG CO");
    }

    private JsonNode quarter(String reportDate, List<Map<String, Object>> holdings) {
        return mapper.valueToTree(Map.of(
                "filingDate", "2026-08-14",
                "reportDate", reportDate,
                "totalValue", holdings.stream()
                        .mapToDouble(h -> (double) h.get("value")).sum(),
                "holdings", holdings));
    }

    private Map<String, Object> holding(String name, String cusip,
                                        double value, double shares, double weight) {
        return Map.of(
                "name", name, "cusip", cusip, "class", "COM",
                "value", value, "shares", shares, "weight", weight);
    }

    // =========================================================================
    // 13F 공시에는 shares가 빠진 보유 항목이 실제로 있습니다.
    // =========================================================================
    // 예전 코드는 `before == null ? 0.0 : Json.asDouble(before, "shares")` 였습니다.
    // 한쪽이 primitive 0.0이라 삼항식 전체가 double로 승격되고, Double이 자동
    // 언박싱됩니다. shares가 없으면 여기서 NullPointerException → 500.
    // 기관 포트폴리오 화면 전체가 뜨지 않았습니다.

    private JsonNode quarter(String json) {
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    @DisplayName("직전 분기에 shares가 없어도 터지지 않는다")
    void missingSharesDoesNotCrash() {
        JsonNode previous = quarter("""
                {"holdings":[{"name":"APPLE INC","value":500,"weight":50.0}]}
                """);
        JsonNode current = quarter("""
                {"holdings":[{"name":"APPLE INC","value":600,"weight":60.0,"shares":100}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 30);

        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).get("name")).isEqualTo("APPLE INC");
    }

    @Test
    @DisplayName("주식 수를 모르면 '신규 매수'라고 단정하지 않는다")
    void unknownSharesIsNotReportedAsNewPosition() {
        // 직전 분기에 **있었던** 종목입니다. 주식 수만 비어 있을 뿐인데
        // 0으로 메우면 "신규 매수"가 됩니다 — 없는 매매를 지어내는 것입니다.
        JsonNode previous = quarter("""
                {"holdings":[{"name":"APPLE INC","value":500,"weight":50.0}]}
                """);
        JsonNode current = quarter("""
                {"holdings":[{"name":"APPLE INC","value":600,"weight":60.0,"shares":100}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 30);

        assertThat(String.valueOf(rows.get(0).get("action")))
                .doesNotContain("신규 매수")
                .contains("비교 불가");
    }

    @Test
    @DisplayName("직전 분기에 정말 없던 종목은 여전히 신규 매수")
    void trulyNewPositionStillClassified() {
        JsonNode previous = quarter("""
                {"holdings":[{"name":"COCA COLA CO","value":400,"weight":40.0,"shares":50}]}
                """);
        JsonNode current = quarter("""
                {"holdings":[{"name":"APPLE INC","value":600,"weight":60.0,"shares":100}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 30);
        Map<String, Object> apple = rows.stream()
                .filter(r -> "APPLE INC".equals(r.get("name")))
                .findFirst()
                .orElseThrow();

        assertThat(String.valueOf(apple.get("action"))).contains("신규 매수");
    }

    @Test
    @DisplayName("13F 정정 공시로 같은 분기가 두 번 와도 하나만 남는다")
    void duplicateQuartersAreCollapsed() throws Exception {
        // SEC에는 13F-HR/A(정정)가 있어 같은 reportDate가 두 번 나타납니다.
        // 그대로 두면 히트맵에 빈 열이 하나 더 생깁니다(화면에서 실제로 봤습니다).
        var quarters = List.of(
                mapper.readTree("""
                        {"filingDate":"2026-08-20","reportDate":"2026-06-30","holdings":[]}"""),
                mapper.readTree("""
                        {"filingDate":"2026-08-14","reportDate":"2026-06-30","holdings":[]}"""),
                mapper.readTree("""
                        {"filingDate":"2026-05-15","reportDate":"2026-03-31","holdings":[]}"""));

        var deduped = Sec13FService.dedupeByReportDate(quarters);

        assertThat(deduped).hasSize(2);
        // 목록은 최신순이므로 먼저 나온 것(더 최근 제출)을 남깁니다.
        assertThat(deduped.get(0).path("filingDate").asString()).isEqualTo("2026-08-20");
        assertThat(deduped.get(1).path("reportDate").asString()).isEqualTo("2026-03-31");
    }
}
