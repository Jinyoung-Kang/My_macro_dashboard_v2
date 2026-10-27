package com.macrodash.analytics;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 규칙 계좌의 금융업 코드 표(2단계 명세 §4-6 'D2a', 사용자 결정 2026-10-28 u1) — 표 내용이 출처(DART 기업개황 {@code induty_code},
 * 2026-10-28 조회)와 교차 확인(로컬 DART 저장본의 '유동자산' 계정 없는 19곳)에서 벗어나지 않게 지킵니다.
 */
class KrFinancialSectorTest {

    /** 2026-10-28 로컬 v2 DART 저장본({@code kr.dart_fundamentals}, 131곳)에서 '유동자산' 계정이 없는 19곳 — 모두 표 안이어야 함. */
    static final List<String> NO_CURRENT_ASSETS = List.of("000810", "005830", "005940", "006800", "016360", "024110",
            "029780", "032830", "039490", "055550", "071050", "086790", "105560", "138040", "138930", "139130", "175330",
            "316140", "323410");

    /** DART가 64992(지주회사)로 주는 비금융 지주 11곳(조회 범위 안) — 표 밖이어야 함. */
    static final List<String> NON_FINANCIAL_HOLDINGS = List.of("001040", "003550", "006260", "008930", "009540", "010060",
            "034730", "078930", "180640", "267250", "402340");

    @Test
    @DisplayName("표 26곳 — 코드 6자리, 산업분류는 대분류 K(64·65·66)의 다섯 자리, 64992는 금융지주 9곳뿐")
    void tableShape() {
        Map<String, KrFinancialSector.Company> table = KrFinancialSector.table();
        assertThat(table).hasSize(26);
        assertThat(table.keySet()).allSatisfy(code -> assertThat(code).matches("\\d{6}"));
        assertThat(table.values()).allSatisfy(c -> {
            assertThat(c.ksic()).matches("6[456]\\d{3}");
            assertThat(c.name()).isNotBlank();
        });
        assertThat(table.entrySet().stream().filter(e -> e.getValue().ksic().equals("64992")).map(Map.Entry::getKey)
                .collect(Collectors.toList()))
                .containsExactly("055550", "071050", "086790", "105560", "138040", "138930", "139130", "175330", "316140");
        assertThat(KrFinancialSector.VERSION).isEqualTo("dart-ksic-K/2026-10-28");
    }

    @Test
    @DisplayName("교차 확인 — '유동자산' 계정 없는 19곳은 모두 표 안, 비금융 지주(64992) 11곳은 모두 표 밖")
    void crossCheck() {
        assertThat(NO_CURRENT_ASSETS).allSatisfy(code -> assertThat(KrFinancialSector.contains(code)).as(code).isTrue());
        assertThat(NON_FINANCIAL_HOLDINGS).allSatisfy(code -> assertThat(KrFinancialSector.contains(code)).as(code).isFalse());
        assertThat(KrFinancialSector.contains(null)).isFalse();
        assertThat(KrFinancialSector.get("377300")).hasValueSatisfying(c -> {
            assertThat(c.name()).isEqualTo("카카오페이");
            assertThat(c.ksic()).as("유동자산 계정이 있지만 대분류 K — 표 안").isEqualTo("66199");
        });
    }
}
