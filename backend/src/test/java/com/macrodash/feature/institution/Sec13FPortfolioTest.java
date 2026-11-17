package com.macrodash.feature.institution;

import com.macrodash.analytics.HoldingsDiff;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 기관 1곳의 포트폴리오 화면(분기 대비 액션 · 비중 추이) — 저장본은 목으로 줍니다.
 */
class Sec13FPortfolioTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String NPS = "0001608046";

    private static Sec13FService service(String cik, String quartersJson) {
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        Snapshot snapshot = new Snapshot(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS),
                MAPPER.readTree("{\"cik\":\"" + cik + "\",\"quarters\":" + quartersJson + "}"),
                "json", "ok", null, Instant.now());
        when(store.read(eq(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS)), anyLong(), anyString()))
                .thenReturn(Optional.of(snapshot));
        return new Sec13FService(store);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, List<Double>> weightSeries(Map<String, Object> portfolio) {
        return (Map<String, List<Double>>) ((Map<String, Object>) portfolio.get("weightHistory")).get("series");
    }

    // ------------------------------------------------------------ QA-084 비중 추이는 회사(이름) 단위 합
    @Test
    @DisplayName("QA-084 비중 추이·히트맵은 이름이 같은 클래스(A·C주)의 비중을 분기마다 합친다 — 한 칸을 버리지 않는다")
    void weightHistorySumsShareClassesOfOneName() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1200,"shares":12,"weight":12.0},
                    {"name":"ALPHABET INC","cusip":"02079K305","class":"CAP STK CL A","value":600,"shares":6,"weight":6.0},
                    {"name":"ALPHABET INC","cusip":"02079K107","class":"CAP STK CL C","value":400,"shares":4,"weight":4.0},
                    {"name":"SMALL CO","cusip":"222222222","class":"COM","value":100,"shares":1,"weight":1.0}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1100,"shares":12,"weight":11.0},
                    {"name":"ALPHABET INC","cusip":"02079K305","class":"CAP STK CL A","value":500,"shares":6,"weight":5.0},
                    {"name":"ALPHABET INC","cusip":"02079K107","class":"CAP STK CL C","value":300,"shares":4,"weight":3.0},
                    {"name":"SMALL CO","cusip":"222222222","class":"COM","value":150,"shares":1,"weight":1.5}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 3));

        assertThat(series.keySet()).as("상위 3개 회사 — ALPHABET이 두 칸을 차지해 SMALL CO가 밀려나면 안 됨")
                .containsExactly("BIG CO", "ALPHABET INC", "SMALL CO");
        assertThat(series.get("ALPHABET INC")).as("과거 → 최신, A주 + C주").containsExactly(8.0, 10.0);
        assertThat(series.get("BIG CO")).containsExactly(11.0, 12.0);
    }

    @Test
    @DisplayName("QA-084 들고 있는데 비중을 모르면 0이 아니라 null — 들고 있지 않은 분기만 0")
    void unknownWeightIsNullNotZero() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1200,"shares":12,"weight":12.0},
                    {"name":"MYSTERY CO","cusip":"333333333","class":"COM","shares":5}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1100,"shares":12,"weight":11.0}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 10));

        assertThat(series.get("MYSTERY CO")).as("2026-03-31 미보유 → 0, 2026-06-30 보유·비중 모름 → null")
                .isEqualTo(Arrays.asList(0.0, null));
    }

    // ------------------------------------------------------------ QA-112 비중 추이도 교집합과 같은 증권 단위
    @Test
    @DisplayName("QA-112 이름이 같은 서로 다른 ETF(ISHARES TR 아래 두 CUSIP)는 두 줄로 남고 각자의 비중을 가진다 — 보유 표와 같은 숫자")
    void differentEtfsUnderOneNameStayTwoLines() {
        // 브리지워터 저장본의 모양: iShares Trust(464287·464288) 아래 서로 다른 ETF가 'ISHARES TR' 한 이름으로 공시됩니다.
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1200,"shares":12,"weight":12.0},
                    {"name":"ISHARES TR","cusip":"464287200","class":"CORE S&P500 ETF","value":900,"shares":9,"weight":9.0},
                    {"name":"ISHARES TR","cusip":"464288588","class":"MBS ETF","value":50,"shares":1,"weight":0.5}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1100,"shares":12,"weight":11.0},
                    {"name":"ISHARES TR","cusip":"464287200","class":"CORE S&P500 ETF","value":800,"shares":9,"weight":8.0},
                    {"name":"ISHARES TR","cusip":"464288588","class":"MBS ETF","value":60,"shares":1,"weight":0.6}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 15));

        assertThat(series.keySet()).as("두 ETF를 한 줄로 더하면(9.0 + 0.5) 어떤 증권과도 맞지 않는 숫자가 된다")
                .containsExactly("BIG CO", "ISHARES TR · CORE S&P500 ETF", "ISHARES TR · MBS ETF");
        assertThat(series.get("ISHARES TR · CORE S&P500 ETF")).as("과거 → 최신").containsExactly(8.0, 9.0);
        assertThat(series.get("ISHARES TR · MBS ETF")).containsExactly(0.6, 0.5);
    }

    @Test
    @DisplayName("QA-112 같은 이름의 보통주와 우선주는 합치지 않고, 클래스 표기로도 갈리지 않으면 CUSIP을 붙여 줄 이름을 가른다")
    void commonAndPreferredStaySeparateAndLabelsStayUnique() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"WELLS FARGO & CO","cusip":"949746101","class":"COM","value":500,"shares":5,"weight":5.0},
                    {"name":"WELLS FARGO & CO","cusip":"949746804","class":"PERP PFD CNV A","value":400,"shares":4,"weight":4.0},
                    {"name":"ISHARES TR","cusip":"464287200","class":"COM","value":300,"shares":3,"weight":3.0},
                    {"name":"ISHARES TR","cusip":"464287655","class":"COM","value":200,"shares":2,"weight":2.0}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 15));

        assertThat(series).as("네 증권이 네 줄 — 이름으로 합치면 두 줄(9.0, 5.0)이 된다").hasSize(4);
        assertThat(series.get("WELLS FARGO & CO · COM")).containsExactly(5.0);
        assertThat(series.get("WELLS FARGO & CO · PERP PFD CNV A")).containsExactly(4.0);
        assertThat(series.get("ISHARES TR · CUSIP 464287200")).as("클래스 표기(COM)가 같아 CUSIP으로 가른다").containsExactly(3.0);
        assertThat(series.get("ISHARES TR · CUSIP 464287655")).containsExactly(2.0);
    }

    // ------------------------------------------------------------ QA-121 8분기에 쌓인 클래스 표기 중 하나가 자유 문구여도 A·C주는 한 줄
    @Test
    @DisplayName("QA-121 한 분기는 클래스를 'ALPHABET INC'(회사 이름), 다른 분기는 'CAPSTKCLA'(공백 없음)로 적어도 8분기 비중 추이의 A·C주는 한 줄")
    void shareClassesStayOneLineWhenSomeQuarterLabelsAreFreeText() {
        // 국민연금 저장본(백업 2026-10-12)의 모양: 2025-12-31은 A·C 모두 class 'ALPHABET INC', 2024-09-30은 'CAPSTKCLA'/'CAPSTKCLC',
        // 나머지 분기는 'CAP STK CL A/C'. 비중 추이는 8분기 항목을 한 집계에 더해 표기가 모두 쌓입니다.
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1200,"shares":12,"weight":12.0},
                    {"name":"ALPHABET INC","cusip":"02079K305","class":"CAP STK CL A","value":600,"shares":6,"weight":6.0},
                    {"name":"ALPHABET INC","cusip":"02079K107","class":"CAP STK CL C","value":400,"shares":4,"weight":4.0},
                    {"name":"SMALL CO","cusip":"222222222","class":"COM","value":100,"shares":1,"weight":1.0}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1100,"shares":12,"weight":11.0},
                    {"name":"ALPHABET INC","cusip":"02079K305","class":"ALPHABET INC","value":500,"shares":6,"weight":5.0},
                    {"name":"ALPHABET INC","cusip":"02079K107","class":"ALPHABET INC","value":300,"shares":4,"weight":3.0},
                    {"name":"SMALL CO","cusip":"222222222","class":"COM","value":150,"shares":1,"weight":1.5}]},
                 {"reportDate":"2025-12-31","holdings":[
                    {"name":"BIG CO","cusip":"111111111","class":"COM","value":1000,"shares":12,"weight":10.0},
                    {"name":"ALPHABETINC","cusip":"02079K305","class":"CAPSTKCLA","value":400,"shares":6,"weight":4.0},
                    {"name":"ALPHABETINC","cusip":"02079K107","class":"CAPSTKCLC","value":200,"shares":4,"weight":2.0},
                    {"name":"SMALL CO","cusip":"222222222","class":"COM","value":200,"shares":1,"weight":2.0}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 3));

        assertThat(series.keySet()).as("A·C주가 두 줄로 갈리면 SMALL CO가 상위 3에서 밀려난다")
                .containsExactly("BIG CO", "ALPHABET INC", "SMALL CO");
        assertThat(series.get("ALPHABET INC")).as("과거 → 최신, 분기마다 A주 + C주").containsExactly(6.0, 8.0, 10.0);
    }

    @Test
    @DisplayName("QA-121 우선주 표기가 한 분기라도 붙은 증권은 같은 발행사의 보통주와 합치지 않는다")
    void preferredLabelInAnyQuarterKeepsTheSecuritySeparate() {
        // 949746804는 최신 분기에 'CL B'로, 앞 분기에 'PERP PFD CNV A'로 공시됐습니다 — 우선주 표기가 하나라도 있으면 합치지 않습니다.
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"WELLS FARGO & CO","cusip":"949746101","class":"COM","value":500,"shares":5,"weight":5.0},
                    {"name":"WELLS FARGO & CO","cusip":"949746804","class":"CL B","value":400,"shares":4,"weight":4.0}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"WELLS FARGO & CO","cusip":"949746101","class":"COM","value":500,"shares":5,"weight":5.5},
                    {"name":"WELLS FARGO & CO","cusip":"949746804","class":"PERP PFD CNV A","value":400,"shares":4,"weight":3.5}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 15));

        assertThat(series).as("보통주와 우선주를 한 줄(9.0)로 더하면 안 됨").hasSize(2);
        assertThat(series.values()).containsExactlyInAnyOrder(List.of(5.5, 5.0), List.of(3.5, 4.0));
    }

    @Test
    @DisplayName("QA-121 펀드·ETF 신탁 이름(ISHARES TR) 아래 증권은 클래스 표기가 보통주 계열이어도 합치지 않는다")
    void fundTrustNamesNeverMergeAcrossQuarters() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"ISHARES TR","cusip":"464287200","class":"COM","value":300,"shares":3,"weight":3.0},
                    {"name":"ISHARES TR","cusip":"464287655","class":"COM","value":200,"shares":2,"weight":2.0}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"ISHARES TR","cusip":"464287200","class":"SHS","value":300,"shares":3,"weight":2.5},
                    {"name":"ISHARES TR","cusip":"464287655","class":"SHS","value":200,"shares":2,"weight":1.5}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 15));

        assertThat(series).as("같은 발행사(464287) 아래 서로 다른 ETF").hasSize(2);
        assertThat(series.get("ISHARES TR · CUSIP 464287200")).containsExactly(2.5, 3.0);
        assertThat(series.get("ISHARES TR · CUSIP 464287655")).containsExactly(1.5, 2.0);
    }

    // ------------------------------------------------------------ QA-122 합친 클래스가 없는 줄은 발행사가 아니라 CUSIP으로 가른다
    @Test
    @DisplayName("QA-122 이름·클래스 표기가 같은 두 보통주 줄(합친 클래스 없음)은 '발행사 …'가 아니라 'CUSIP …'으로 가른다")
    void sameNameSingleClassLinesAreLabelledByCusip() {
        // 발행사 6자리가 다른 두 증권이 같은 공시 이름·같은 클래스 표기로 들어온 경우(재상장 등). 둘 다 합칠 클래스가 없습니다.
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"UNITED CO","cusip":"111111101","class":"COM","value":300,"shares":3,"weight":3.0},
                    {"name":"UNITED CO","cusip":"222222101","class":"COM","value":200,"shares":2,"weight":2.0}]}]
                """);

        Map<String, List<Double>> series = weightSeries(service.portfolio(NPS, 8, 15));

        assertThat(series.keySet()).as("줄 하나가 증권 하나 — 합친 행이 아니므로 그 증권의 CUSIP")
                .containsExactly("UNITED CO · CUSIP 111111101", "UNITED CO · CUSIP 222222101");
    }

    // ------------------------------------------------------------ QA-086 분기 수는 이력 범위일 뿐
    @Test
    @SuppressWarnings("unchecked")
    @DisplayName("QA-086 '최근 1개 분기'를 골라도 저장된 직전 분기와 비교한다 — 분기 수는 목록·히트맵 범위에만")
    void oneQuarterViewStillComparesWithStoredPreviousQuarter() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"APPLE INC","cusip":"037833100","class":"COM","value":1100,"shares":1100,"weight":60.0}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"APPLE INC","cusip":"037833100","class":"COM","value":1000,"shares":1000,"weight":55.6},
                    {"name":"COCA COLA CO","cusip":"191216100","class":"COM","value":800,"shares":500,"weight":44.4}]}]
                """);

        Map<String, Object> portfolio = service.portfolio(NPS, 1, 10);
        List<Map<String, Object>> holdings = (List<Map<String, Object>>) portfolio.get("holdings");

        Map<String, Object> apple = holdings.stream().filter(row -> "APPLE INC".equals(row.get("name"))).findFirst().orElseThrow();
        assertThat(apple.get("action")).isEqualTo(HoldingsDiff.ADDED);
        assertThat((Double) apple.get("weightDiff")).isCloseTo(4.4, within(1e-9));
        assertThat(holdings).extracting(row -> row.get("action")).contains(HoldingsDiff.CLOSED);
        assertThat((List<Object>) portfolio.get("quarters")).as("분기 목록은 고른 1개").hasSize(1);
        assertThat((List<Object>) ((Map<String, Object>) portfolio.get("weightHistory")).get("dates")).hasSize(1);
    }

    // ------------------------------------------------------------ 종목 팝업용 티커
    @Test
    @SuppressWarnings("unchecked")
    @DisplayName("보유 표 줄에는 저장본의 ticker·tickerNote가 실리고(모르면 null), 교집합 줄 모양은 그대로다")
    void portfolioRowsCarryTickerButConsensusRowsDoNot() {
        Sec13FService service = service(NPS, """
                [{"reportDate":"2026-06-30","holdings":[
                    {"name":"APPLE INC","cusip":"037833100","class":"COM","value":1100,"shares":1100,"weight":60.0,"ticker":"AAPL"},
                    {"name":"ISHARES TR","cusip":"464287200","class":"CORE S&P500 ETF","value":700,"shares":7,"weight":40.0,"ticker":null}]},
                 {"reportDate":"2026-03-31","holdings":[
                    {"name":"APPLE INC","cusip":"037833100","class":"COM","value":1000,"shares":1000,"weight":55.6,"ticker":"AAPL"},
                    {"name":"FORD MTR CO","cusip":"345370CZ1","class":"COM","value":800,"weight":44.4,"ticker":null,"tickerNote":"debt"}]}]
                """);

        List<Map<String, Object>> holdings = (List<Map<String, Object>>) service.portfolio(NPS, 8, 10).get("holdings");

        assertThat(holdings).extracting(row -> row.get("name"), row -> row.get("ticker"), row -> row.get("tickerNote"))
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple("APPLE INC", "AAPL", null),
                        org.assertj.core.groups.Tuple.tuple("ISHARES TR", null, null),
                        org.assertj.core.groups.Tuple.tuple("FORD MTR CO", null, "debt"));

        List<Map<String, Object>> consensus = (List<Map<String, Object>>) service.consensus(List.of(NPS), null, 1, 10).get("rows");
        assertThat(consensus).isNotEmpty().allSatisfy(row -> assertThat(row).doesNotContainKeys("ticker", "tickerNote"));
    }
}
