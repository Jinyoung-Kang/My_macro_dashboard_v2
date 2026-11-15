package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 보유 기관 검색(GET /api/guru/holders)과 13F 공시 이름의 잘림(QA-436).
 *
 * <p>13F 공시 이름(nameOfIssuer)은 제출자마다 정해진 폭에서 잘려 들어옵니다 — 같은 종목(같은 CUSIP)이 한 제출자는
 * 'MITSUBISHI UFJ FINANCIAL GRO'(28자), 다른 제출자는 'MITSUBISHI UFJ FINANCIAL G ADR'(앞 26자 + 증권 종류). 정보 검색 보유 탭과
 * 종목 상세는 회사의 영문 이름 전체('MITSUBISHI UFJ FINANCIAL GROUP', 30자)로 찾습니다. 기관·비중·CUSIP은 합성 값입니다.
 */
class GuruServiceTruncatedNamesTest {

    private static final String REPORT_DATE = "2026-06-30";

    /** 합성 기관(CIK 끝자리 {@code n}) 하나의 보유 한 줄. */
    private static GuruService.HoldingRow row(int n, String name, String cusip, double weight) {
        return new GuruService.HoldingRow("합성 자산운용 " + n, "000000000" + n, name, cusip, weight, weight * 1_000.0, REPORT_DATE);
    }

    @SuppressWarnings("unchecked")
    private static List<String> names(Map<String, Object> response) {
        return ((List<Map<String, Object>>) response.get("rows")).stream()
                .map(row -> (String) row.get("name")).toList();
    }

    @Test
    @DisplayName("QA-436 회사의 영문 이름 전체로 찾아도 제출자가 잘라 적은 공시 이름(앞부분이 같은 이름, 끝의 ADR 포함)이 걸린다")
    void truncatedIssuerNamesMatchTheFullName() {
        // QA-436: 일치 규칙이 '공시 이름에 검색어 전체가 들어감' 하나뿐이라, 공시 이름이 검색어보다 짧게 잘리면 같은 종목이어도 걸리지 않았습니다.
        // 수정 전 실패: 'MITSUBISHI UFJ FINANCIAL GROUP'으로 찾으면 0건(available=false, '그 이름을 포함한 보유 종목이 없습니다') — 재현 커밋에서는 @Disabled.
        List<GuruService.HoldingRow> index = List.of(
                row(1, "MITSUBISHI UFJ FINANCIAL G ADR", "000000101", 2.5),
                row(2, "MITSUBISHI UFJ FINANCIAL GRO", "000000101", 1.5),
                row(3, "SYNTHETIC EXAMPLE CORP", "000000202", 9.0));
        GuruService guru = new GuruService(mock(StoreReader.class));

        Map<String, Object> response = guru.holders(index, "MITSUBISHI UFJ FINANCIAL GROUP");

        assertThat(names(response)).as("잘린 공시 이름 두 줄(비중 순)")
                .containsExactly("MITSUBISHI UFJ FINANCIAL G ADR", "MITSUBISHI UFJ FINANCIAL GRO");
        assertThat(response.get("available")).isEqualTo(true);
        assertThat(response.get("totalMatches")).isEqualTo(2);
    }

    @Test
    @DisplayName("QA-436 넓히지 않음 — 폭에 닿지 않은 짧은 이름, 같은 낱말로 시작해 갈라지는 이름, 너무 짧은 앞부분은 검색어가 그것으로 시작해도 걸리지 않는다")
    void doesNotFloodWithOtherNames() {
        List<GuruService.HoldingRow> index = List.of(
                // 온전한 짧은 이름(24자 미만) — 검색어가 이 이름으로 시작해도 다른 종목
                row(1, "ISHARES TR", "000000301", 5.0),
                row(2, "SYNTHETIC EXAMPLE", "000000302", 4.0),
                // 잘린 길이지만 검색어와 갈라지는 이름(같은 낱말 둘로 시작하는 다른 회사)
                row(3, "SYNTHETIC EXAMPLE FINANCIAL SVCS", "000000303", 3.0),
                // 증권 종류 낱말을 떼면 앞부분이 16자 미만
                row(4, "SYNTHETIC SPONSORED ADR NEW SHS", "000000304", 2.0),
                // 줄여 적은 이름은 여전히 걸리지 않음(이름으로 찾는 한계 — 화면이 그렇게 적음)
                row(5, "SYNTHETIC EXAMPLE FINL GROUP INC", "000000305", 1.0));
        GuruService guru = new GuruService(mock(StoreReader.class));

        assertThat(names(guru.holders(index, "ISHARES TR RUSSELL 2000 ETF"))).isEmpty();
        assertThat(names(guru.holders(index, "SYNTHETIC EXAMPLE FINANCIAL GROUP"))).isEmpty();
        // 넷째 줄의 앞 16자('SYNTHETIC SPONSO')로 시작하는 검색어라 앞부분 길이 막음까지 갑니다 — 증권 종류 낱말 넷을 떼면 'SYNTHETIC'(9자)만
        // 남고, 검색어가 그것으로 시작해도 앞부분이 16자 미만이라 걸리지 않습니다(이 막음이 빠지면 이 줄이 걸림).
        assertThat(names(guru.holders(index, "SYNTHETIC SPONSORED HOLDINGS"))).isEmpty();
    }

    @Test
    @DisplayName("QA-436 지금까지의 규칙 그대로 — 이름 일부(대소문자 무시)로 찾으면 잘린 이름도 그 일부를 담고 있으면 걸린다")
    void containsRuleUnchanged() {
        List<GuruService.HoldingRow> index = List.of(
                row(1, "MITSUBISHI UFJ FINANCIAL G ADR", "000000101", 2.5),
                row(2, "MITSUBISHI UFJ FINANCIAL GRO", "000000101", 1.5),
                row(3, "ISHARES TR", "000000301", 5.0));
        GuruService guru = new GuruService(mock(StoreReader.class));

        assertThat(names(guru.holders(index, "mitsubishi"))).containsExactly("MITSUBISHI UFJ FINANCIAL G ADR", "MITSUBISHI UFJ FINANCIAL GRO");
        assertThat(names(guru.holders(index, "ISHARES"))).containsExactly("ISHARES TR");
        // 화면에 보인 잘린 이름 그대로 찾아도 걸리고, 그보다 더 짧게 잘린 같은 종목의 이름도 함께 걸림
        assertThat(names(guru.holders(index, "MITSUBISHI UFJ FINANCIAL GRO")))
                .containsExactly("MITSUBISHI UFJ FINANCIAL G ADR", "MITSUBISHI UFJ FINANCIAL GRO");
    }
}
