package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import org.junit.jupiter.api.Disabled;
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
    @Disabled("QA-436: 수정 전 실패 — 'MITSUBISHI UFJ FINANCIAL GROUP'으로 찾으면 잘린 공시 이름 두 줄이 걸리지 않아 0건")
    @DisplayName("QA-436 회사의 영문 이름 전체로 찾아도 제출자가 잘라 적은 공시 이름(앞부분이 같은 이름, 끝의 ADR 포함)이 걸린다")
    void truncatedIssuerNamesMatchTheFullName() {
        // QA-436: 일치 규칙이 '공시 이름에 검색어 전체가 들어감' 하나뿐이라, 공시 이름이 검색어보다 짧게 잘리면 같은 종목이어도 걸리지 않았습니다.
        // 수정 전 실패: 'MITSUBISHI UFJ FINANCIAL GROUP'으로 찾으면 0건(available=false, '그 이름을 포함한 보유 종목이 없습니다').
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
}
