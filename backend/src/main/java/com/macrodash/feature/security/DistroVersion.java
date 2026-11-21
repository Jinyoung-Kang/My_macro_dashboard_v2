package com.macrodash.feature.security;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * 배포판 패키지 판의 순서(ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기') — 설치 판과 추적기가 적은 고친 판을 견줄 때 씁니다. 순수 계산입니다.
 *
 * <ul>
 *   <li><b>dpkg</b>(Debian·Ubuntu, Debian Policy 5.6.12): {@code [에포크:]상류[-개정]}. 에포크는 숫자로, 상류·개정은 dpkg의 {@code verrevcmp}
 *       그대로(숫자 아닌 부분은 글자 순 — {@code ~}는 끝보다도 앞, 글자는 기호보다 앞 / 숫자 부분은 수로). 해석은 dpkg {@code parseversion}의
 *       오류와 경고를 모두 실패로 봅니다(상태 파일을 읽을 때와 같은 엄격함 — 상류가 숫자로 시작하지 않거나 허용 밖 글자가 있으면 실패).</li>
 *   <li><b>apk</b>(Alpine, apk-tools 3 {@code version.c}): {@code 숫자{.숫자}…{글자}{_접미사{숫자}}…{~해시}{-r숫자}}. 접미사 순서는
 *       {@code _alpha < _beta < _pre < _rc < (없음) < _cvs < _svn < _git < _hg < _p}. 0으로 시작하는 둘째 이후 마디는 글자 순으로 견줍니다.</li>
 * </ul>
 * 해석하지 못하면 예외가 아니라 빈 {@link Optional}입니다(모르는 것을 안전으로 두지 않음 — 판정은 '모름'으로 둡니다).
 */
public final class DistroVersion {

    /** 판 규칙. */
    public enum Scheme {
        /** Debian·Ubuntu 패키지. */
        DPKG,
        /** Alpine 패키지. */
        APK;

        /** os-release ID → 판 규칙(ubuntu·debian → dpkg, alpine → apk). 그 밖은 빈 값. */
        public static Optional<Scheme> forDistro(String distro) {
            if (distro == null) {
                return Optional.empty();
            }
            return switch (distro) {
                case "ubuntu", "debian" -> Optional.of(DPKG);
                case "alpine" -> Optional.of(APK);
                default -> Optional.empty();
            };
        }
    }

    private DistroVersion() {
    }

    /** {@code a}와 {@code b}를 견줍니다 — -1·0·1. 둘 중 하나라도 해석하지 못하면 빈 값. */
    public static Optional<Integer> compare(Scheme scheme, String a, String b) {
        if (scheme == null) {
            return Optional.empty();
        }
        return switch (scheme) {
            case DPKG -> {
                Optional<Dpkg> x = parseDpkg(a);
                Optional<Dpkg> y = parseDpkg(b);
                yield x.isPresent() && y.isPresent() ? Optional.of(Integer.signum(compareDpkg(x.get(), y.get()))) : Optional.empty();
            }
            case APK -> validApk(a) && validApk(b) ? Optional.of(compareApk(a.strip(), b.strip())) : Optional.empty();
        };
    }

    // ---- dpkg ---------------------------------------------------------------------------------------------------

    /**
     * 해석한 dpkg 판.
     *
     * @param epoch    에포크(없으면 0)
     * @param upstream 상류 판(에포크·개정을 뗀 것)
     * @param revision 데비안 개정(없으면 빈 글 — dpkg에서 {@code 0}과 같음)
     */
    public record Dpkg(long epoch, String upstream, String revision) {
    }

    /** dpkg 판을 해석합니다(dpkg {@code parseversion} — 오류·경고 모두 실패). */
    public static Optional<Dpkg> parseDpkg(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        String s = raw.strip();
        if (s.isEmpty() || s.chars().anyMatch(ch -> ch == ' ' || ch == '\t')) {
            return Optional.empty();
        }
        long epoch = 0;
        int colon = s.indexOf(':');
        if (colon >= 0) {
            String head = s.substring(0, colon);
            if (head.isEmpty() || head.length() > 10 || !head.chars().allMatch(DistroVersion::isDigit)) {
                return Optional.empty();
            }
            epoch = Long.parseLong(head);
            if (epoch > Integer.MAX_VALUE || colon + 1 >= s.length()) {
                return Optional.empty();
            }
            s = s.substring(colon + 1);
        }
        String upstream = s;
        String revision = "";
        int hyphen = s.lastIndexOf('-');
        if (hyphen >= 0) {
            upstream = s.substring(0, hyphen);
            revision = s.substring(hyphen + 1);
            if (revision.isEmpty()) {
                return Optional.empty();
            }
        }
        if (upstream.isEmpty() || !isDigit(upstream.charAt(0))) {
            return Optional.empty();
        }
        for (int i = 0; i < upstream.length(); i++) {
            char c = upstream.charAt(i);
            if (!isDigit(c) && !isAlpha(c) && ".-+~:".indexOf(c) < 0) {
                return Optional.empty();
            }
        }
        for (int i = 0; i < revision.length(); i++) {
            char c = revision.charAt(i);
            if (!isDigit(c) && !isAlpha(c) && ".+~".indexOf(c) < 0) {
                return Optional.empty();
            }
        }
        return Optional.of(new Dpkg(epoch, upstream, revision));
    }

    /** dpkg {@code dpkg_version_compare} — 에포크, 상류, 개정 순(부호만 뜻이 있음). */
    static int compareDpkg(Dpkg a, Dpkg b) {
        if (a.epoch() != b.epoch()) {
            return a.epoch() > b.epoch() ? 1 : -1;
        }
        int rc = verrevcmp(a.upstream(), b.upstream());
        if (rc != 0) {
            return rc;
        }
        return verrevcmp(a.revision(), b.revision());
    }

    /** dpkg {@code order} — 숫자·끝은 0, 글자는 그 글자, {@code ~}는 -1, 그 밖의 기호는 글자 + 256. */
    private static int order(int c) {
        if (isDigit(c)) {
            return 0;
        } else if (isAlpha(c)) {
            return c;
        } else if (c == '~') {
            return -1;
        } else if (c != 0) {
            return c + 256;
        }
        return 0;
    }

    /** dpkg {@code verrevcmp} 그대로(글자 끝은 0으로 읽음). */
    static int verrevcmp(String a, String b) {
        int i = 0;
        int j = 0;
        while (i < a.length() || j < b.length()) {
            int firstDiff = 0;
            while ((i < a.length() && !isDigit(a.charAt(i))) || (j < b.length() && !isDigit(b.charAt(j)))) {
                int ac = order(charAt(a, i));
                int bc = order(charAt(b, j));
                if (ac != bc) {
                    return ac - bc;
                }
                i++;
                j++;
            }
            while (i < a.length() && a.charAt(i) == '0') {
                i++;
            }
            while (j < b.length() && b.charAt(j) == '0') {
                j++;
            }
            while (i < a.length() && j < b.length() && isDigit(a.charAt(i)) && isDigit(b.charAt(j))) {
                if (firstDiff == 0) {
                    firstDiff = a.charAt(i) - b.charAt(j);
                }
                i++;
                j++;
            }
            if (i < a.length() && isDigit(a.charAt(i))) {
                return 1;
            }
            if (j < b.length() && isDigit(b.charAt(j))) {
                return -1;
            }
            if (firstDiff != 0) {
                return firstDiff;
            }
        }
        return 0;
    }

    /**
     * PPA 판이면 그 상류 판 — 데비안 개정(마지막 {@code -} 뒤)에 {@code ppa}가 있으면 에포크·개정을 뗀 상류 판
     * ({@code 1:9.56.1-0ppa1~ubuntu99.04.1} → {@code 9.56.1}). 상류를 그대로 담은 개인 저장소 판이라 공지의 상류 번호와 견줄 수 있습니다.
     * PPA가 아니거나(배포판 판) 해석하지 못하면 빈 값.
     */
    public static Optional<String> ppaUpstream(String raw) {
        return parseDpkg(raw).filter(v -> v.revision().toLowerCase(Locale.ROOT).contains("ppa")).map(Dpkg::upstream);
    }

    // ---- apk ----------------------------------------------------------------------------------------------------

    /** apk-tools 3의 토큰 종류 — 순서가 곧 비교에 쓰는 크기입니다. */
    private static final int INITIAL_DIGIT = 0;
    private static final int DIGIT = 1;
    private static final int LETTER = 2;
    private static final int SUFFIX = 3;
    private static final int SUFFIX_NO = 4;
    private static final int COMMIT_HASH = 5;
    private static final int REVISION_NO = 6;
    private static final int END = 7;
    private static final int INVALID = 8;

    /** 접미사 값 — 출시 전(alpha·beta·pre·rc)은 '없음'(5)보다 작고, 출시 뒤(cvs·svn·git·hg·p)는 큽니다. */
    private static final int SUFFIX_NONE = 5;
    private static final Map<String, Integer> SUFFIXES = Map.of("alpha", 1, "beta", 2, "pre", 3, "rc", 4,
            "cvs", 6, "svn", 7, "git", 8, "hg", 9, "p", 10);
    /** 숫자 마디 상한(자리) — 넘으면 해석 실패(long 넘침 방지). */
    private static final int MAX_DIGITS = 18;

    /** apk 토큰을 하나씩 읽는 상태(apk-tools {@code struct token_state}). */
    private static final class ApkTokens {
        private final String s;
        private int pos;
        int token;
        int suffix;
        long number;
        String value = "";

        ApkTokens(String s) {
            this.s = s;
            this.token = INITIAL_DIGIT;
            parseDigits();
        }

        private void parseDigits() {
            int start = pos;
            while (pos < s.length() && isDigit(s.charAt(pos))) {
                pos++;
            }
            value = s.substring(start, pos);
            if (value.isEmpty() || value.length() > MAX_DIGITS) {
                token = INVALID;
                return;
            }
            number = Long.parseLong(value);
        }

        /** apk-tools {@code token_next}. */
        void next() {
            if (pos >= s.length()) {
                token = END;
                return;
            }
            char c = s.charAt(pos);
            if (c >= 'a' && c <= 'z') {
                if (token > DIGIT) {
                    token = INVALID;
                    return;
                }
                value = String.valueOf(c);
                token = LETTER;
                pos++;
            } else if (c == '.' || isDigit(c)) {
                if (c == '.') {
                    if (token > DIGIT) {
                        token = INVALID;
                        return;
                    }
                    pos++;
                }
                if (token == INITIAL_DIGIT || token == DIGIT) {
                    token = DIGIT;
                } else if (token == SUFFIX) {
                    token = SUFFIX_NO;
                } else {
                    token = INVALID;
                    return;
                }
                parseDigits();
            } else if (c == '_') {
                if (token > SUFFIX_NO) {
                    token = INVALID;
                    return;
                }
                pos++;
                int start = pos;
                while (pos < s.length() && s.charAt(pos) >= 'a' && s.charAt(pos) <= 'z') {
                    pos++;
                }
                value = s.substring(start, pos);
                Integer v = SUFFIXES.get(value);
                if (v == null) {
                    token = INVALID;
                    return;
                }
                suffix = v;
                token = SUFFIX;
            } else if (c == '~') {
                if (token >= COMMIT_HASH) {
                    token = INVALID;
                    return;
                }
                pos++;
                int start = pos;
                while (pos < s.length() && isHex(s.charAt(pos))) {
                    pos++;
                }
                value = s.substring(start, pos);
                token = value.isEmpty() ? INVALID : COMMIT_HASH;
            } else if (c == '-') {
                if (token >= REVISION_NO || pos + 1 >= s.length() || s.charAt(pos + 1) != 'r') {
                    token = INVALID;
                    return;
                }
                pos += 2;
                token = REVISION_NO;
                parseDigits();
            } else {
                token = INVALID;
            }
        }
    }

    /** apk 판의 모양이 맞는지(apk-tools {@code apk_version_validate}). */
    public static boolean validApk(String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        ApkTokens t = new ApkTokens(raw.strip());
        while (t.token < END) {
            t.next();
        }
        return t.token == END;
    }

    /** apk-tools {@code token_cmp} — 0으로 시작하는 마디·해시는 글자 순, 그 밖은 수·글자·접미사 값. */
    private static int tokenCmp(ApkTokens a, ApkTokens b) {
        long x;
        long y;
        switch (a.token) {
            case DIGIT -> {
                if (a.value.startsWith("0") || b.value.startsWith("0")) {
                    return Integer.signum(a.value.compareTo(b.value));
                }
                x = a.number;
                y = b.number;
            }
            case INITIAL_DIGIT, SUFFIX_NO, REVISION_NO -> {
                x = a.number;
                y = b.number;
            }
            case LETTER -> {
                x = a.value.charAt(0);
                y = b.value.charAt(0);
            }
            case SUFFIX -> {
                x = a.suffix;
                y = b.suffix;
            }
            default -> {
                return Integer.signum(a.value.compareTo(b.value));
            }
        }
        return Long.compare(x, y);
    }

    /** apk-tools {@code apk_version_compare}(fuzzy 없음) — 모양이 맞는 두 판만 넘깁니다. */
    static int compareApk(String a, String b) {
        ApkTokens ta = new ApkTokens(a);
        ApkTokens tb = new ApkTokens(b);
        while (ta.token == tb.token && ta.token < END) {
            int r = tokenCmp(ta, tb);
            if (r != 0) {
                return r;
            }
            ta.next();
            tb.next();
        }
        if (ta.token == tb.token) {
            return 0;
        }
        // 앞 마디가 모두 같음 — 끝나지 않은 쪽이 크다. 단 출시 전 접미사가 이어지면 작다.
        if (ta.token == SUFFIX && ta.suffix < SUFFIX_NONE) {
            return -1;
        }
        if (tb.token == SUFFIX && tb.suffix < SUFFIX_NONE) {
            return 1;
        }
        if (ta.token > tb.token) {
            return -1;
        }
        if (tb.token > ta.token) {
            return 1;
        }
        return 0;
    }

    // ---- 글자 ----------------------------------------------------------------------------------------------------

    private static char charAt(String s, int i) {
        return i < s.length() ? s.charAt(i) : 0;
    }

    private static boolean isDigit(int c) {
        return c >= '0' && c <= '9';
    }

    private static boolean isAlpha(int c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    private static boolean isHex(char c) {
        return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }
}
