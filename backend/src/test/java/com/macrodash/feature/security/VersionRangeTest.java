package com.macrodash.feature.security;

import com.macrodash.feature.security.VersionOrder.Version;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 버전 칸 해석(ADR 0046 결정 6). '실제 공지 칸'은 보호나라 공지 표의 버전 칸 문자열 모양 그대로(짧은 사실 문자열만 — 본문·제목은 옮기지 않음),
 * 나머지는 표본에 없는 모양을 합성한 것입니다. 알 수 없는 조각이 하나라도 있으면 칸 전체가 실패입니다.
 */
class VersionRangeTest {

    private static Version v(String raw) {
        return VersionOrder.parse(raw).orElseThrow();
    }

    private static VersionRange range(String cell) {
        return VersionRange.parse(cell).orElseThrow(() -> new AssertionError("해석 실패: " + cell));
    }

    // ---- 실제 공지 칸 ----

    @Test
    @DisplayName("실제 공지 칸 'A 이상 B 미만' — 아래 끝 포함, 위 끝 제외")
    void realAtLeastBelow() {
        VersionRange r = range("18 이상 18.7 미만");
        assertThat(r.contains(v("18"))).isTrue();
        assertThat(r.contains(v("18.6.9"))).isTrue();
        assertThat(r.contains(v("18.7"))).isFalse();
        assertThat(r.contains(v("17.99"))).isFalse();
        assertThat(range("8.2.28 이상 8.2.36 미만").contains(v("8.2.27"))).isFalse();
    }

    @Test
    @DisplayName("실제 공지 칸 'A 이상 B 이하' — 양끝 포함")
    void realAtLeastAtMost() {
        VersionRange r = range("1.9.5 이상 1.30.6 이하");
        assertThat(r.contains(v("1.9.5"))).isTrue();
        assertThat(r.contains(v("1.30.6"))).isTrue();
        assertThat(r.contains(v("1.30.7"))).isFalse();
        assertThat(r.contains(v("1.9.4"))).isFalse();
    }

    @Test
    @DisplayName("실제 공지 칸 'B 미만'(아래로 열림)과 단일 버전(그 버전 하나 — 마디 다섯도)")
    void realBelowAndSingle() {
        VersionRange below = range("8.2.36 미만");
        assertThat(below.contains(v("0.1"))).isTrue();
        assertThat(below.contains(v("8.2.36"))).isFalse();

        VersionRange single = range("12.2.1.4.0");
        assertThat(single.contains(v("12.2.1.4"))).isTrue();
        assertThat(single.contains(v("12.2.1.4.1"))).isFalse();
        assertThat(range("17.0.21.0.3").contains(v("17.0.21.0.3"))).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"R34 이상 R36 이하", "8u511b33", "8u511b33-perf", "-", "Oracle 보안 패치 적용"})
    @DisplayName("실제 공지 칸 가운데 숫자 버전이 아닌 것은 영향 칸 해석 실패")
    void realAffectedFailures(String cell) {
        assertThat(VersionRange.parse(cell)).isEmpty();
    }

    @Test
    @DisplayName("실제 공지 해결 칸 — 'V 이상'·단일 버전은 최소 해결 버전, '-'는 해결 버전 없음")
    void realFixed() {
        assertThat(VersionRange.parseFixed("18.7 이상").orElseThrow().minimums()).containsExactly(v("18.7"));
        assertThat(VersionRange.parseFixed("8.2.36 이상").orElseThrow().minimums()).containsExactly(v("8.2.36"));
        assertThat(VersionRange.parseFixed("1.30.7").orElseThrow().minimums()).containsExactly(v("1.30.7"));
        assertThat(VersionRange.parseFixed("17.0.21.1").orElseThrow().minimums()).containsExactly(v("17.0.21.1"));
        assertThat(VersionRange.parseFixed("-").orElseThrow().none()).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"Oracle 보안 패치 적용", "8u513 (1.8.0_513-b04)", "8u513-perf (1.8.0_513-perf-b4)", "37.3.0.1 (R37)"})
    @DisplayName("실제 공지 해결 칸 가운데 숫자 버전이 아닌 것은 해석 실패")
    void realFixedFailures(String cell) {
        assertThat(VersionRange.parseFixed(cell)).isEmpty();
    }

    // ---- 합성 모양 ----

    @Test
    @DisplayName("초과·이하·이전·및 이전·이후·및 이후 — '이전'·'이후'는 글자 뜻대로 끝을 포함하지 않음")
    void bounds() {
        VersionRange gtLe = range("1.0 초과 2.0 이하");
        assertThat(gtLe.contains(v("1.0"))).isFalse();
        assertThat(gtLe.contains(v("2.0"))).isTrue();
        assertThat(range("3.1 이하").contains(v("3.1"))).isTrue();
        assertThat(range("3.1 이전").contains(v("3.1"))).isFalse();
        assertThat(range("3.1 이전").contains(v("3.0.9"))).isTrue();
        assertThat(range("3.1 및 이전").contains(v("3.1"))).isTrue();
        assertThat(range("2.0 초과").contains(v("2.0"))).isFalse();
        assertThat(range("2.0 이상").contains(v("2.0"))).isTrue();
        assertThat(range("2.0 이후").contains(v("2.0"))).isFalse();
        assertThat(range("2.0 및 이후").contains(v("2.0"))).isTrue();
        assertThat(range("1.0 ~ 1.5").contains(v("1.5"))).isTrue();
        assertThat(range("1.5 버전").contains(v("1.5"))).isTrue();
        assertThat(range("3.1 이하 버전").contains(v("3.0"))).isTrue();
    }

    @Test
    @DisplayName("9.0.x·9.x·9.0.* — 그 계열 전부")
    void wildcard() {
        VersionRange r = range("9.0.x");
        assertThat(r.contains(v("9.0"))).isTrue();
        assertThat(r.contains(v("9.0.99"))).isTrue();
        assertThat(r.contains(v("9.1"))).isFalse();
        assertThat(range("9.x").contains(v("9.7.1"))).isTrue();
        assertThat(range("9.x").contains(v("10"))).isFalse();
        assertThat(range("9.0.*").contains(v("9.0.3"))).isTrue();
    }

    @Test
    @DisplayName("모든 버전·전체 버전·전 버전·all versions — 전부")
    void all() {
        for (String cell : new String[]{"모든 버전", "전체 버전", "전 버전", "All versions"}) {
            assertThat(range(cell).contains(v("0.0.1"))).as(cell).isTrue();
            assertThat(range(cell).contains(v("999"))).as(cell).isTrue();
        }
    }

    @Test
    @DisplayName("쉼표·및·줄바꿈·세미콜론 나열 — 조각마다 구간, 합에 들면 영향")
    void lists() {
        VersionRange r = range("1.2, 1.4, 2.0.x");
        assertThat(r.intervals()).hasSize(3);
        assertThat(r.contains(v("1.2"))).isTrue();
        assertThat(r.contains(v("1.3"))).isFalse();
        assertThat(r.contains(v("2.0.5"))).isTrue();
        assertThat(range("1.2 및 1.4").contains(v("1.4"))).isTrue();
        assertThat(range("1.2\n1.4 이상 1.6 미만").contains(v("1.5"))).isTrue();
        assertThat(range("1.2; 1.4").contains(v("1.4"))).isTrue();
        assertThat(range("1.2, 1.4,").intervals()).hasSize(2);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"2.0 이상 1.0 미만", "1.0 이상 1.0 미만", "1.0, 8u1", "1.0, 모든 버전", "모든 버전 1.0", "PostgreSQL 16 이상",
            "1.2 (Linux)", "1.2.3-rc1 이하", "1.2 이상 미만", "1.x.x", "x", "버전", ",", "1.0 ~", "1.2/1.3", "1.2 또는 1.3",
            "1.2 이상 2.0 미만 (일부)", "1.2.3.4.5.6.7"})
    @DisplayName("알 수 없는 조각이 하나라도 있으면 칸 전체 실패(빈 구간·제품명 섞임·괄호 설명 포함)")
    void failures(String cell) {
        assertThat(VersionRange.parse(cell)).isEmpty();
    }

    @Test
    @DisplayName("해결 칸 합성 모양 — 나열·없음·미정·N/A, 그 밖은 실패")
    void fixedSynthetic() {
        assertThat(VersionRange.parseFixed("1.2.9, 1.4.2 이상").orElseThrow().minimums()).containsExactly(v("1.2.9"), v("1.4.2"));
        assertThat(VersionRange.parseFixed("없음").orElseThrow().none()).isTrue();
        assertThat(VersionRange.parseFixed("미정").orElseThrow().none()).isTrue();
        assertThat(VersionRange.parseFixed("N/A").orElseThrow().none()).isTrue();
        assertThat(VersionRange.parseFixed("1.2 이하")).isEmpty();
        assertThat(VersionRange.parseFixed("1.2, 최신")).isEmpty();
        assertThat(VersionRange.parseFixed("")).isEmpty();
        assertThat(VersionRange.parseFixed(null)).isEmpty();
    }

    @Test
    @DisplayName("계열과 겹침 — [from, to) 경계 포함 여부를 지킴")
    void overlaps() {
        VersionRange r = range("16 이상 16.50 미만");
        assertThat(r.overlaps(v("16"), v("17"))).isTrue();
        assertThat(r.overlaps(v("17"), v("18"))).isFalse();
        assertThat(r.overlaps(v("15"), v("16"))).isFalse();
        assertThat(range("16 이하").overlaps(v("16"), v("17"))).isTrue();
        assertThat(range("16 미만").overlaps(v("16"), v("17"))).isFalse();
        assertThat(range("8.2.36 미만").overlaps(v("8.3"), v("8.4"))).isFalse();
        assertThat(range("8.2.36 미만").overlaps(v("8.2"), v("8.3"))).isTrue();
        assertThat(VersionRange.all().overlaps(v("1"), v("2"))).isTrue();
    }
}
