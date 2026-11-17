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

    // =========================================================================
    // 티커·표시(ticker·tickerNote) — 13F 화면의 종목 팝업이 씁니다. 줄을 만든 저장본 보유 노드에서 그대로 옮깁니다.
    // =========================================================================

    private static Map<String, Object> rowNamed(List<Map<String, Object>> rows, String name) {
        return rows.stream().filter(row -> name.equals(row.get("name"))).findFirst().orElseThrow();
    }

    @Test
    @DisplayName("줄마다 수집기가 붙인 ticker·tickerNote를 옮기고, 모르거나 없으면 null — 키는 늘 있다")
    void tickerAndNoteAreCarriedFromTheHoldingNode() {
        JsonNode current = quarter("""
                {"reportDate":"2026-06-30","holdings":[
                  {"name":"BERKSHIRE HATHAWAY INC DEL","cusip":"084670702","class":"CL B NEW","value":900,"shares":9,"weight":45.0,"ticker":"BRK-B"},
                  {"name":"ISHARES TR","cusip":"464287200","class":"CORE S&P500 ETF","value":500,"shares":5,"weight":25.0,"ticker":null},
                  {"name":"FORD MTR CO","cusip":"345370CZ1","class":"COM","value":300,"weight":15.0,"ticker":null,"tickerNote":"debt"},
                  {"name":"WELLS FARGO CO NEW","cusip":"949746804","class":"PERP PFD CNV A","value":200,"shares":2,"weight":10.0,"ticker":null,"tickerNote":"non_common"},
                  {"name":"OLD SNAPSHOT CO","cusip":"111111111","class":"COM","value":100,"shares":1,"weight":5.0}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, null, 10);

        assertThat(rows).allSatisfy(row -> assertThat(row).containsKeys("ticker", "tickerNote"));
        assertThat(rowNamed(rows, "BERKSHIRE HATHAWAY INC DEL")).containsEntry("ticker", "BRK-B").containsEntry("tickerNote", null);
        assertThat(rowNamed(rows, "ISHARES TR")).containsEntry("ticker", null).containsEntry("tickerNote", null);
        assertThat(rowNamed(rows, "FORD MTR CO")).containsEntry("ticker", null).containsEntry("tickerNote", "debt");
        assertThat(rowNamed(rows, "WELLS FARGO CO NEW")).containsEntry("ticker", null).containsEntry("tickerNote", "non_common");
        assertThat(rowNamed(rows, "OLD SNAPSHOT CO")).as("티커를 붙이기 전 옛 저장본 — 키가 없어도 null")
                .containsEntry("ticker", null).containsEntry("tickerNote", null);
    }

    @Test
    @DisplayName("전량 매도 줄의 ticker·tickerNote는 직전 분기 노드의 것 — 이번 분기에 같은 이름이 남아 있어도 섞이지 않는다")
    void closedRowTakesTickerFromThePreviousQuarterNode() {
        JsonNode current = quarter("""
                {"reportDate":"2026-06-30","holdings":[
                  {"name":"APPLE INC","cusip":"037833100","class":"COM","value":5000,"shares":100,"weight":50.0,"ticker":"AAPL"}]}
                """);
        JsonNode previous = quarter("""
                {"reportDate":"2026-03-31","holdings":[
                  {"name":"APPLE INC","cusip":"037833100","class":"COM","value":4000,"shares":90,"weight":40.0,"ticker":"AAPL-OLD"},
                  {"name":"TESLA INC","cusip":"88160R101","class":"COM","value":3000,"shares":80,"weight":30.0,"ticker":"TSLA"},
                  {"name":"FORD MTR CO","cusip":"345370CZ1","class":"COM","value":2000,"weight":20.0,"ticker":null,"tickerNote":"debt"}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 10);

        assertThat(rowNamed(rows, "APPLE INC")).as("이번 분기 줄은 이번 분기 노드").containsEntry("ticker", "AAPL");
        assertThat(rowNamed(rows, "TESLA INC")).containsEntry("action", HoldingsDiff.CLOSED).containsEntry("ticker", "TSLA");
        assertThat(rowNamed(rows, "FORD MTR CO")).containsEntry("action", HoldingsDiff.CLOSED)
                .containsEntry("ticker", null).containsEntry("tickerNote", "debt");
    }

    @Test
    @DisplayName("같은 CUSIP·같은 이름·클래스의 항목이 겹쳐도 이번 분기 줄은 제 노드, 전량 매도 줄은 계산이 쓴 마지막 노드")
    void duplicateKeysPairEachRowWithItsOwnNode() {
        // 수집기 저장본에서는 (이름, CUSIP, 클래스)가 겹치지 않습니다(한 공시 안에서 합침). CUSIP만 같은 줄은 있을 수 있어
        // (같은 증권을 이름 표기 둘로 적은 공시) 이번 분기에는 두 줄이 그대로 남고, 직전 분기는 계산이 CUSIP으로 모아 마지막 항목이 남습니다.
        JsonNode current = quarter("""
                {"reportDate":"2026-06-30","holdings":[
                  {"name":"NVIDIA CORP","cusip":"67066G104","class":"COM","value":600,"shares":6,"weight":30.0,"ticker":"T-FIRST"},
                  {"name":"NVIDIA CORPORATION","cusip":"67066G104","class":"COM","value":500,"shares":5,"weight":25.0,"ticker":"T-SECOND"},
                  {"name":"SAME CO","cusip":"","class":"COM","value":400,"shares":4,"weight":20.0,"ticker":"S-FIRST"},
                  {"name":"SAME CO","cusip":"","class":"COM","value":300,"shares":3,"weight":15.0,"ticker":"S-SECOND"}]}
                """);
        // 직전 분기: CUSIP만 같은 두 항목(이름이 다름)과, 이름·CUSIP·클래스가 모두 같은 두 항목(CUSIP 있음·없음 하나씩) — 뒤의 둘은 줄과 노드를
        // 이름·CUSIP·클래스로 짝지을 때 앞과 뒤가 갈립니다. 계산(HoldingsDiff)은 키마다 마지막 항목을 남기므로 노드도 마지막 항목이어야 합니다.
        JsonNode previous = quarter("""
                {"reportDate":"2026-03-31","holdings":[
                  {"name":"GONE CORP","cusip":"222222222","class":"COM","value":200,"shares":2,"weight":10.0,"ticker":"G-FIRST"},
                  {"name":"GONE CORPORATION","cusip":"222222222","class":"COM","value":100,"shares":1,"weight":5.0,"ticker":"G-LAST"},
                  {"name":"TWIN CO","cusip":"333333333","class":"COM","value":90,"shares":9,"weight":4.5,"ticker":"W-FIRST"},
                  {"name":"TWIN CO","cusip":"333333333","class":"COM","value":80,"shares":8,"weight":4.0,"ticker":"W-LAST","tickerNote":"debt"},
                  {"name":"BLANK CO","cusip":"","class":"COM","value":70,"shares":7,"weight":3.5,"ticker":"B-FIRST","tickerNote":"debt"},
                  {"name":"BLANK CO","cusip":"","class":"COM","value":60,"shares":6,"weight":3.0,"ticker":"B-LAST"}]}
                """);

        List<Map<String, Object>> rows = service.compareQuarters(current, previous, 10);

        assertThat(rows).filteredOn(row -> !HoldingsDiff.CLOSED.equals(row.get("action")))
                .extracting(row -> row.get("value"), row -> row.get("ticker"))
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple(600.0, "T-FIRST"),
                        org.assertj.core.groups.Tuple.tuple(500.0, "T-SECOND"),
                        org.assertj.core.groups.Tuple.tuple(400.0, "S-FIRST"),
                        org.assertj.core.groups.Tuple.tuple(300.0, "S-SECOND"));
        List<Map<String, Object>> closed = rows.stream().filter(row -> HoldingsDiff.CLOSED.equals(row.get("action"))).toList();
        assertThat(closed).as("같은 키의 전량 매도는 한 줄 — 계산이 남긴 마지막 항목의 이름과 티커·표시")
                .extracting(row -> row.get("name"), row -> row.get("ticker"), row -> row.get("tickerNote"))
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple("GONE CORPORATION", "G-LAST", null),
                        org.assertj.core.groups.Tuple.tuple("TWIN CO", "W-LAST", "debt"),
                        org.assertj.core.groups.Tuple.tuple("BLANK CO", "B-LAST", null));
    }
}
