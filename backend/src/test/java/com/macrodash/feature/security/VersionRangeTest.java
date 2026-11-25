package com.macrodash.feature.security;

import com.macrodash.feature.security.VersionOrder.Version;
import org.junit.jupiter.api.Disabled;
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

    @Test
    @DisplayName("QA-976 아래 끝의 출시 전 표기('A-M5 이상'·'A.M1 이상'·'A-RC1 초과') — 출시 버전끼리 견주면 'A 이상'과 같음")
    void preReleaseLowerBound() {
        VersionRange r = range("31.0.0-M5 이상 31.0.9 미만");
        assertThat(r.contains(v("31.0.0"))).isTrue();
        assertThat(r.contains(v("31.0.8"))).isTrue();
        assertThat(r.contains(v("31.0.9"))).isFalse();
        assertThat(r.contains(v("30.9.9"))).isFalse();
        assertThat(range("29.0.0.M1 이상 29.0.40 미만").contains(v("29.0.39"))).isTrue();
        assertThat(range("29.0.0-RC1 초과 29.0.40 미만").contains(v("29.0.0"))).isTrue();
        assertThat(range("31.0.0-beta2 이상").contains(v("31.0.0"))).isTrue();
        assertThat(range("31.0.0-M5 이상").contains(v("30.9"))).isFalse();
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
            "1.2 (Linux)", "1.2.3-rc1 이하", "1.2.3-M5", "1.0 이상 1.2.3-M5 미만", "1.2.0-M5 이상 1.2.0 미만", "1.2.0-M 5 이상", "1.2 이상 미만", "1.x.x", "x", "버전", ",", "1.0 ~", "1.2/1.3", "1.2 또는 1.3",
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

    @Test
    @DisplayName("QA-975 아래 끝이 없는 구간을 위 끝의 계열로 좁힘 — 위 끝이 계열의 시작이거나 짧으면·아래 끝이 있으면·SINGLE이면 그대로")
    void scopedToFamily() {
        VersionRange major = range("32.9.1 미만").scopedToFamily(1);
        assertThat(major.contains(v("32.5"))).isTrue();
        assertThat(major.contains(v("32"))).isTrue();
        assertThat(major.contains(v("31.99"))).isFalse();
        assertThat(major.contains(v("32.9.1"))).isFalse();
        assertThat(major.overlaps(v("30"), v("31"))).isFalse();
        assertThat(range("45.0.3 이하").scopedToFamily(1).contains(v("45.0.3"))).isTrue();
        assertThat(range("45.0.3 이하").scopedToFamily(1).contains(v("41.0.9"))).isFalse();
        VersionRange minor = range("30.1.50 미만").scopedToFamily(2);
        assertThat(minor.contains(v("30.1.2"))).isTrue();
        assertThat(minor.contains(v("30.0.99"))).isFalse();
        // 옛 계열 전부를 뜻하는 꼴은 그대로입니다.
        assertThat(range("32 미만").scopedToFamily(1).contains(v("30.5"))).isTrue();
        assertThat(range("32.0.0 미만").scopedToFamily(1).contains(v("30.5"))).isTrue();
        assertThat(range("30.1 미만").scopedToFamily(2).contains(v("29.9"))).isTrue();
        // 아래 끝이 있는 구간·SINGLE·나열은 조각마다 같은 규칙입니다.
        assertThat(range("30 이상 32.9.1 미만").scopedToFamily(1).contains(v("31.2"))).isTrue();
        assertThat(range("32.9.1 미만").scopedToFamily(0).contains(v("1.0"))).isTrue();
        VersionRange list = range("30.4.1 미만, 32.9.1 미만").scopedToFamily(1);
        assertThat(list.contains(v("30.2"))).isTrue();
        assertThat(list.contains(v("31.5"))).isFalse();
        assertThat(list.contains(v("32.1"))).isTrue();
    }

    // ---- 줄 경계가 구간 하나를 가른 칸(QA-1000 후속) ----

    @Test
    @DisplayName("QA-1000 후속 — 구간 하나가 줄바꿈으로 꺾인 칸('A 이상\\nB 미만')은 한 구간, 두 구간의 합이 아님")
    @Disabled("QA-1000 후속 — 수정 전에는 실패")
    void wrappedBetweenIsOneInterval() {
        VersionRange r = range("16.0 이상\n16.4 미만");
        assertThat(r.contains(v("16.2"))).isTrue();
        assertThat(r.contains(v("15.0"))).isFalse();
        assertThat(r.contains(v("18.0"))).isFalse();
        // 꺾인 구간과 줄마다 적힌 구간이 섞여도 구간마다 따로
        VersionRange two = range("16.0 이상\n16.4 미만\n17.0 이상 17.2 미만");
        assertThat(two.intervals()).hasSize(2);
        assertThat(two.contains(v("17.1"))).isTrue();
        assertThat(two.contains(v("16.5"))).isFalse();
    }

    @Test
    @DisplayName("QA-1000 후속 — 혼자서는 읽히지 않는 줄('3.0.0 ~' · '이상')은 이웃 줄과 이어 읽음")
    @Disabled("QA-1000 후속 — 수정 전에는 실패")
    void wrappedFragmentJoinsNeighbour() {
        VersionRange tilde = range("3.0.0 ~\n3.0.15");
        assertThat(tilde.contains(v("3.0.7"))).isTrue();
        assertThat(tilde.contains(v("3.0.16"))).isFalse();
        assertThat(range("16.4\n이상").contains(v("16.5"))).isTrue();
        assertThat(VersionRange.parseFixed("16.4\n이상").orElseThrow().minimums()).containsExactly(v("16.4"));
    }

    @Test
    @DisplayName("QA-1000 후속 — 줄마다 온전한 구간·버전은 전처럼 따로(이어 읽지 않음)")
    void wholeLinesStaySeparate() {
        assertThat(range("16.0 이상 16.4 미만\n17.0 이상 17.2 미만").intervals()).hasSize(2);
        assertThat(range("1.2.3\n1.2.4").intervals()).hasSize(2);
        assertThat(range("17.0 이상\n16.4 미만").intervals()).hasSize(2);   // 아래 끝이 위 끝보다 큼 — 한 구간이 될 수 없음
        assertThat(VersionRange.parseFixed("16.4\n17.2").orElseThrow().minimums()).containsExactly(v("16.4"), v("17.2"));
        assertThat(VersionRange.parse("16.0 이상\n알 수 없는 글")).isEmpty();
    }
}
