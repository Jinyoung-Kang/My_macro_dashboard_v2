package com.macrodash.feature.security;

import com.macrodash.feature.security.DistroVersion.Scheme;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 배포판 판 비교 — dpkg(Debian Policy 5.6.12 · dpkg verrevcmp)와 apk(apk-tools 3 version.c). 판은 규칙을 보이려는 예시이고 운영 서버의
 * 설치 판과 무관합니다.
 */
class DistroVersionTest {

    private static int dpkg(String a, String b) {
        return DistroVersion.compare(Scheme.DPKG, a, b).orElseThrow();
    }

    private static int apk(String a, String b) {
        return DistroVersion.compare(Scheme.APK, a, b).orElseThrow();
    }

    @ParameterizedTest(name = "{0} < {1}")
    @CsvSource(delimiter = '|', value = {
            // ~는 끝보다도 앞(출시 전)
            "1.0~rc1|1.0",
            "1.0~rc1|1.0~rc2",
            "1.0~~|1.0~",
            "1.0~|1.0",
            "1.0|1.0a",
            "1.0a|1.0+",
            "1.0|1.0.1",
            // 숫자 마디는 수로
            "1.9|1.10",
            "2.8.4|2.8.4ubuntu0.1",
            "9.9.9-1|9.9.9-1ubuntu1",
            "1.1.0-2|1.1.0-2+deb13u1",
            "1.1.0-2+deb13u1|1.1.0-2+deb13u2",
            "6.8.0-149.149|6.8.0-151.151",
            "9.9.9-0ubuntu0.24.04.9|9.9.9-0ubuntu0.24.04.10",
            // 에포크가 먼저
            "9.9-1|1:0.1-1",
            "1:9.9-1|2:0.1-1",
            // 개정이 없으면 0과 같음 — 1.0 < 1.0-1
            "1.0|1.0-1",
            // 상류에 '-'가 있으면 마지막 '-' 뒤만 개정
            "1.0-beta-1|1.0-beta-2",
            "1:9.6p1-3ubuntu13.4|1:9.6p1-3ubuntu13.5"})
    @DisplayName("dpkg — 앞이 작다")
    void dpkgLess(String smaller, String larger) {
        assertThat(dpkg(smaller, larger)).isEqualTo(-1);
        assertThat(dpkg(larger, smaller)).isEqualTo(1);
    }

    @ParameterizedTest(name = "{0} = {1}")
    @CsvSource(delimiter = '|', value = {
            "1.0|1.0",
            "0:1.0|1.0",
            "1.0-0|1.0",
            "1.01|1.1",
            "1.0-1|' 1.0-1 '"})
    @DisplayName("dpkg — 같음(에포크 0·개정 0·앞의 0)")
    void dpkgEqual(String a, String b) {
        assertThat(dpkg(a, b)).isZero();
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"", " ", "a1.0", "1.0 2", "x:1.0", ":1.0", "1:", "1.0-", "1.0_1", "1.0-1_2", "99999999999:1.0", "-1:1.0", "1.0-a/b"})
    @DisplayName("dpkg — 해석 실패(오류·경고 모두)는 빈 값")
    void dpkgInvalid(String raw) {
        assertThat(DistroVersion.parseDpkg(raw)).isEmpty();
        assertThat(DistroVersion.compare(Scheme.DPKG, raw, "1.0")).isEmpty();
        assertThat(DistroVersion.compare(Scheme.DPKG, "1.0", raw)).isEmpty();
    }

    @Test
    @DisplayName("dpkg 해석 — 에포크·상류·개정")
    void dpkgParse() {
        assertThat(DistroVersion.parseDpkg("1:9.56.1-0ppa1~ubuntu99.04.1")).contains(new DistroVersion.Dpkg(1, "9.56.1", "0ppa1~ubuntu99.04.1"));
        assertThat(DistroVersion.parseDpkg("9.9.9")).contains(new DistroVersion.Dpkg(0, "9.9.9", ""));
        assertThat(DistroVersion.parseDpkg("1.0-beta-1")).contains(new DistroVersion.Dpkg(0, "1.0-beta", "1"));
        assertThat(DistroVersion.parseDpkg(null)).isEmpty();
    }

    @Test
    @DisplayName("PPA 판 — 개정에 ppa가 있으면 에포크·개정을 뗀 상류 판, 배포판 판·해석 실패는 빈 값")
    void ppaUpstream() {
        assertThat(DistroVersion.ppaUpstream("1:9.56.1-0ppa1~ubuntu99.04.1")).contains("9.56.1");
        assertThat(DistroVersion.ppaUpstream("9.56.1-1~PPA2")).contains("9.56.1");
        assertThat(DistroVersion.ppaUpstream("1:9.43.0-1ubuntu7.3")).isEmpty();
        assertThat(DistroVersion.ppaUpstream("9.43.0")).isEmpty();
        assertThat(DistroVersion.ppaUpstream("ppa")).isEmpty();
        assertThat(DistroVersion.ppaUpstream(null)).isEmpty();
    }

    @ParameterizedTest(name = "{0} < {1}")
    @CsvSource(delimiter = '|', value = {
            "1.2.1-r0|1.2.1-r1",
            "1.2.1-r9|1.2.1-r10",
            "1.2.1|1.2.1-r0",
            "1.2.1_rc1|1.2.1",
            "1.2.1_alpha|1.2.1_beta",
            "1.2.1_beta2|1.2.1_pre1",
            "1.2.1_pre1|1.2.1_rc1",
            "1.2.1_rc1|1.2.1_rc2",
            "1.2.1|1.2.1_p1",
            "1.2.1_cvs|1.2.1_svn",
            "1.2.1_git20990101|1.2.1_p0",
            "10.3_p1-r2|10.3_p1-r3",
            "10.3-r5|10.3_p1-r2",
            "10.2_p1-r9|10.3_p1-r0",
            "1.2|1.2a",
            "1.2a|1.2b",
            "1.2z|1.3",
            "1.9|1.10",
            "1.0|1.1",
            "1.0|1.0.0",
            "1.01|1.1",
            "1.001|1.01",
            "3.24.3-r0|3.24.10-r0",
            "1.2.1~abc1-r0|1.2.1~abc2-r0",
            "1.2.1-r0|1.2.1~abcdef-r9"})
    @DisplayName("apk — 앞이 작다(접미사 순서·-r 개정·글자·0으로 시작하는 마디·해시는 글자 순이고 해시가 있는 쪽이 큼)")
    void apkLess(String smaller, String larger) {
        assertThat(apk(smaller, larger)).isEqualTo(-1);
        assertThat(apk(larger, smaller)).isEqualTo(1);
    }

    @ParameterizedTest(name = "{0} = {1}")
    @CsvSource(delimiter = '|', value = {"1.2.1-r0|1.2.1-r0", "10.3_p1-r2|10.3_p1-r2", "' 1.2'|'1.2 '"})
    @DisplayName("apk — 같음")
    void apkEqual(String a, String b) {
        assertThat(apk(a, b)).isZero();
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"", "r1", "1.", "1..2", "1.2-1", "1.2-r", "1.2_foo", "1.2a3", "1.2A", "1.2-r1-r2", "1.2~", "1.2~xyz",
            "1.2-r1_p1", "1:1.2", "1.2+3", "1234567890123456789.1"})
    @DisplayName("apk — 모양이 틀리면 빈 값")
    void apkInvalid(String raw) {
        assertThat(DistroVersion.validApk(raw)).isFalse();
        assertThat(DistroVersion.compare(Scheme.APK, raw, "1.0")).isEmpty();
    }

    @Test
    @DisplayName("판 규칙 고르기 — ubuntu·debian은 dpkg, alpine은 apk, 그 밖은 없음 / 규칙이 없으면 비교하지 않음")
    void schemes() {
        assertThat(Scheme.forDistro("ubuntu")).contains(Scheme.DPKG);
        assertThat(Scheme.forDistro("debian")).contains(Scheme.DPKG);
        assertThat(Scheme.forDistro("alpine")).contains(Scheme.APK);
        assertThat(Scheme.forDistro("fedora")).isEmpty();
        assertThat(Scheme.forDistro(null)).isEmpty();
        assertThat(DistroVersion.compare(null, "1.0", "1.0")).isEqualTo(Optional.empty());
        assertThat(DistroVersion.compare(Scheme.DPKG, null, "1.0")).isEmpty();
        assertThat(DistroVersion.compare(Scheme.APK, "1.0", null)).isEmpty();
    }
}
