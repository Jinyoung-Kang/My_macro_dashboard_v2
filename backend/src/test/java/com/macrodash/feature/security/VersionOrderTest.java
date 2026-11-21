package com.macrodash.feature.security;

import com.macrodash.feature.security.VersionOrder.Version;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

/** 버전 순서(ADR 0046 결정 6) — 마디별 숫자 비교, 통과하는 모양은 v?숫자(.숫자){0,5}와 Java의 +빌드뿐. 값은 모두 가짜. */
class VersionOrderTest {

    private static Version v(String raw) {
        return VersionOrder.parse(raw).orElseThrow();
    }

    @ParameterizedTest
    @ValueSource(strings = {"1", "16.4", "1.2.3", "1.2.3.4.5.6", "v24.1.0", "21.0.5+11", "21.0.5+11-LTS", " 3.4.5 ", "0.0.1",
            "170.0.9999.12"})
    @DisplayName("통과하는 모양 — 숫자 마디 1~6개, 앞의 v, 끝의 Java 빌드 꼬리, 앞뒤 공백")
    void accepts(String raw) {
        assertThat(VersionOrder.parse(raw)).isPresent();
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"1.2.3.4.5.6.7", "1.2.3-rc1", "9.1p1", "1:9.1p1-1ubuntu0.9", "2.0.5-0ubuntu1.3", "3.5.1-r0",
            "8u511b33", "33.4.0-jre", "1.2.3+abc", "1.2.3+build", "V1.2", "1..2", ".1", "1.2.", "1.2 3", "Google Chrome 1.2.3",
            "v", "x.1", "1.2.x", "1234567890123456789", "1.2+3+4", "1.2,3"})
    @DisplayName("그 밖의 접미사·배포판 버전(에포크·-ubuntu·-r0)·빌드 문자열은 해석 실패(빈 값 — 예외 없음)")
    void rejects(String raw) {
        assertThat(VersionOrder.parse(raw)).isEmpty();
    }

    @Test
    @DisplayName("마디별 숫자 비교 — 글자 순서가 아님(1.10 > 1.9, 10.0 > 2.0), 앞자리 0은 숫자로")
    void numericOrder() {
        assertThat(v("1.10")).isGreaterThan(v("1.9"));
        assertThat(v("10.0")).isGreaterThan(v("2.0"));
        assertThat(v("1.0.0.1")).isGreaterThan(v("1.0"));
        assertThat(v("01.002").sameAs(v("1.2"))).isTrue();
        assertThat(VersionOrder.compare(v("2.3.4"), v("2.3.5"))).isNegative();
    }

    @Test
    @DisplayName("짧은 쪽은 0으로 채움(16 = 16.0 = 16.0.0), 빌드 꼬리와 v는 비교에 쓰지 않음")
    void paddingAndBuild() {
        assertThat(v("16").sameAs(v("16.0.0"))).isTrue();
        assertThat(v("16").compareTo(v("16.0.1"))).isNegative();
        assertThat(v("21.0.5+11-LTS").sameAs(v("21.0.5"))).isTrue();
        assertThat(v("v24.1.0").sameAs(v("24.1"))).isTrue();
        assertThat(v("21.0.5+11").toString()).isEqualTo("21.0.5");
    }

    @Test
    @DisplayName("계열의 시작과 끝 — 앞 n마디(모자라면 0)와 그 마지막을 하나 올린 것")
    void prefixes() {
        assertThat(v("16.4.2").prefix(1)).hasToString("16");
        assertThat(v("16.4.2").nextPrefix(1)).hasToString("17");
        assertThat(v("3.11.9").prefix(2)).hasToString("3.11");
        assertThat(v("3.11.9").nextPrefix(2)).hasToString("3.12");
        assertThat(v("7").prefix(2)).hasToString("7.0");
        assertThat(v("7").nextPrefix(2)).hasToString("7.1");
    }
}
