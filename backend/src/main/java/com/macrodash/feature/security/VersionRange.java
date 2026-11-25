package com.macrodash.feature.security;

import com.macrodash.feature.security.VersionOrder.Version;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 보호나라 공지 표의 버전 칸(ADR 0046 결정 6) — '영향받는 버전' 칸을 구간들의 합으로, '해결 버전' 칸을 최소 해결 버전 목록으로 읽습니다. 순수 계산입니다.
 *
 * <p>영향받는 버전 칸은 쉼표({@code ,}·{@code 、}·{@code ;})·줄바꿈·{@code 및}으로 나눈 조각마다 아래 하나여야 합니다(조각 끝의 {@code 버전}은 떼고 읽음).
 * <ul>
 *   <li>{@code A 이상 B 미만}·{@code A 이상 B 이하}·{@code A 초과 B 미만}·{@code A 초과 B 이하}, {@code A ~ B}(양끝 포함)</li>
 *   <li>{@code B 미만}·{@code B 이하}·{@code B 이전}(literal '앞' — 포함 안 함)·{@code B 및 이전}·{@code B 및 이하}(포함)</li>
 *   <li>{@code A 이상}·{@code A 초과}·{@code A 이후}(포함 안 함)·{@code A 및 이후}(포함)</li>
 *   <li>{@code 9.0.x}·{@code 9.x}·{@code 9.0.*} — 그 계열 전부({@code [9.0, 9.1)})</li>
 *   <li>단일 버전 {@code 12.2.1} — 그 버전 하나</li>
 *   <li>{@code 모든 버전}·{@code 전체 버전}·{@code 전 버전}·{@code all versions} — 전부(이 조각은 칸에 혼자일 때만)</li>
 * </ul>
 * 아래 끝({@code 이상}·{@code 초과}·{@code 이후}·{@code ~} 앞)에는 출시 전 꼬리({@code -M5}·{@code .M1}·{@code -RC1}·{@code -alpha}·{@code -beta2})가
 * 붙어도 됩니다(QA-976 — Tomcat 공지의 {@code 11.0.0-M1 이상} 꼴). 설치 버전은 출시 버전만 해석되므로 출시 버전끼리 견주면 {@code A-M5 이상}·
 * {@code A-M5 초과}는 모두 {@code A 이상}과 같아, 꼬리를 떼고 아래 끝을 포함으로 읽습니다. 위 끝·단일 버전의 꼬리는 그대로 해석 실패입니다.
 * 알 수 없는 조각({@code 8u511b33}·{@code R34 이상 R36 이하}·제품명이 섞인 글·괄호 설명)이 하나라도 있으면 칸 전체가 해석 실패입니다
 * (빈 {@link Optional} — 판정은 확인 필요 {@code PARSE_FAILED}).
 *
 * <p>줄 경계가 조각 하나를 가른 칸은 이웃 줄과 이어 읽습니다({@link #unwrap} — QA-1000 후속).
 *
 * <p>해결 버전 칸은 조각마다 {@code V} 또는 {@code V 이상}이고, 칸 전체가 {@code -}·{@code 없음}·{@code 미정}·{@code 해당 없음}·{@code N/A}면
 * '해결 버전 없음'({@link Fixed#none()})입니다. 그 밖({@code Oracle 보안 패치 적용}·{@code 8u513 (1.8.0_513-b04)})은 해석 실패입니다.
 */
public record VersionRange(List<Interval> intervals) {

    public VersionRange {
        if (intervals == null || intervals.isEmpty()) {
            throw new IllegalArgumentException("구간이 하나 이상 있어야 합니다");
        }
        intervals = List.copyOf(intervals);
    }

    /**
     * 구간 하나. 아래·위 끝이 {@code null}이면 그쪽으로 열려 있습니다.
     */
    public record Interval(Version lower, boolean lowerInclusive, Version upper, boolean upperInclusive) {

        public Interval {
            if (lower != null && upper != null) {
                int cmp = lower.compareTo(upper);
                if (cmp > 0 || (cmp == 0 && !(lowerInclusive && upperInclusive))) {
                    throw new IllegalArgumentException("빈 구간: " + lower + " ~ " + upper);
                }
            }
        }

        static Interval exactly(Version v) {
            return new Interval(v, true, v, true);
        }

        public boolean contains(Version v) {
            if (lower != null) {
                int cmp = v.compareTo(lower);
                if (cmp < 0 || (cmp == 0 && !lowerInclusive)) {
                    return false;
                }
            }
            if (upper != null) {
                int cmp = v.compareTo(upper);
                return cmp < 0 || (cmp == 0 && upperInclusive);
            }
            return true;
        }

        /** {@code [from, toExclusive)}와 겹치는지. */
        public boolean overlaps(Version from, Version toExclusive) {
            boolean belowEnd = lower == null || lower.compareTo(toExclusive) < 0;
            boolean aboveStart = upper == null || upper.compareTo(from) > 0
                    || (upper.compareTo(from) == 0 && upperInclusive);
            return belowEnd && aboveStart;
        }

        @Override
        public String toString() {
            return (lower == null ? "(-inf" : (lowerInclusive ? "[" : "(") + lower) + ", "
                    + (upper == null ? "+inf)" : upper + (upperInclusive ? "]" : ")"));
        }
    }

    /**
     * 해결 버전 칸. {@code minimums}가 비면 '해결 버전 없음'({@code -} 등)입니다.
     */
    public record Fixed(List<Version> minimums) {

        public Fixed {
            minimums = List.copyOf(minimums);
        }

        public boolean none() {
            return minimums.isEmpty();
        }
    }

    private static final String V = "(v?\\d{1,18}(?:\\.\\d{1,18}){0,5})";
    /** 아래 끝 — 버전 뒤에 출시 전 꼬리(둘째 묶음, 없으면 null)가 붙어도 됨(QA-976). */
    private static final String V_LOWER = V + "([-.](?:M|(?i:rc|alpha|beta))\\d{0,9})?";
    private static final Pattern BETWEEN = Pattern.compile(V_LOWER + "\\s*(이상|초과)\\s*" + V + "\\s*(미만|이하)");
    private static final Pattern TILDE = Pattern.compile(V_LOWER + "\\s*[~∼～]\\s*" + V);
    private static final Pattern UPPER = Pattern.compile(V + "\\s*(미만|이하|이전|및\\s*이전|및\\s*이하)");
    private static final Pattern LOWER = Pattern.compile(V_LOWER + "\\s*(이상|초과|이후|및\\s*이후|및\\s*이상)");
    private static final Pattern WILDCARD = Pattern.compile("v?(\\d{1,18}(?:\\.\\d{1,18}){0,4})\\.[xX*]");
    private static final Pattern SINGLE = Pattern.compile(V);
    /** 조각 끝의 '버전'을 뗀 뒤에 맞춥니다('모든 버전' → '모든'). */
    private static final Pattern ALL = Pattern.compile("모든|전체|전|(?i:all(?:\\s+versions?)?)");
    private static final Pattern FIXED_PIECE = Pattern.compile(V + "(?:\\s*이상)?");
    private static final Pattern FIXED_NONE = Pattern.compile("[-–—]|없음|미정|해당\\s*없음|(?i:n/?a)");

    /** 조각 나누기: 쉼표류·세미콜론·줄바꿈, 그리고 뒤에 이전·이후·이하·이상이 오지 않는 '및'. */
    private static final Pattern SPLIT = Pattern.compile("\\s*(?:[,，、;\\n]|\\s및\\s+(?!이전|이후|이하|이상))\\s*");
    private static final Pattern TRAILING_WORD = Pattern.compile("\\s*버전$");

    /** 전부 들어가는 구간(모든 버전). */
    public static VersionRange all() {
        return new VersionRange(List.of(new Interval(null, false, null, false)));
    }

    public boolean contains(Version v) {
        for (Interval interval : intervals) {
            if (interval.contains(v)) {
                return true;
            }
        }
        return false;
    }

    /** {@code [from, toExclusive)}(한 계열)와 겹치는 구간이 있는지. */
    public boolean overlaps(Version from, Version toExclusive) {
        for (Interval interval : intervals) {
            if (interval.overlaps(from, toExclusive)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 아래 끝이 없는 구간을 위 끝의 계열로 좁힌 것(QA-975) — 공지 표는 계열마다 행을 두므로 {@code 32.9.1 미만}은 32 계열의 행입니다.
     * 그대로 두면 이미 패치된 옛 계열(30.x)까지 품어 해당이 됩니다. 위 끝의 마디가 {@code depth}보다 많고 계열의 시작보다 클 때만
     * {@code [위 끝의 앞 depth마디, 위 끝)}으로 좁히고, 위 끝이 계열의 시작이거나 짧으면({@code 32 미만}·{@code 32.0.0 미만} — 옛 계열 전부를
     * 뜻함) 그대로 둡니다. {@code depth}가 0(SINGLE — 한 줄기)이면 그대로입니다.
     */
    public VersionRange scopedToFamily(int depth) {
        if (depth <= 0) {
            return this;
        }
        List<Interval> out = new ArrayList<>(intervals.size());
        for (Interval interval : intervals) {
            Version upper = interval.upper();
            if (interval.lower() == null && upper != null && upper.parts().size() > depth) {
                Version start = upper.prefix(depth);
                if (upper.compareTo(start) > 0) {
                    out.add(new Interval(start, true, upper, interval.upperInclusive()));
                    continue;
                }
            }
            out.add(interval);
        }
        return new VersionRange(out);
    }

    /** '영향받는 버전' 칸을 읽습니다. 알 수 없는 조각이 하나라도 있으면 빈 값. */
    public static Optional<VersionRange> parse(String cell) {
        List<String> pieces = pieces(cell, VersionRange::readableInterval);
        if (pieces.isEmpty()) {
            return Optional.empty();
        }
        List<Interval> out = new ArrayList<>();
        for (String piece : pieces) {
            if (ALL.matcher(piece).matches()) {
                if (pieces.size() != 1) {
                    return Optional.empty();
                }
                return Optional.of(all());
            }
            Optional<Interval> interval = interval(piece);
            if (interval.isEmpty()) {
                return Optional.empty();
            }
            out.add(interval.get());
        }
        return Optional.of(new VersionRange(out));
    }

    /** '해결 버전' 칸을 읽습니다. 알 수 없는 조각이 하나라도 있으면 빈 값. */
    public static Optional<Fixed> parseFixed(String cell) {
        if (cell == null) {
            return Optional.empty();
        }
        String whole = normalize(cell);
        if (FIXED_NONE.matcher(whole).matches()) {
            return Optional.of(new Fixed(List.of()));
        }
        List<String> pieces = pieces(cell, piece -> FIXED_PIECE.matcher(piece).matches());
        if (pieces.isEmpty()) {
            return Optional.empty();
        }
        List<Version> out = new ArrayList<>();
        for (String piece : pieces) {
            Matcher m = FIXED_PIECE.matcher(piece);
            if (!m.matches()) {
                return Optional.empty();
            }
            Optional<Version> v = VersionOrder.parse(m.group(1));
            if (v.isEmpty()) {
                return Optional.empty();
            }
            out.add(v.get());
        }
        return Optional.of(new Fixed(out));
    }

    private static String normalize(String cell) {
        return cell.replace(' ', ' ').replaceAll("[ \\t\\x0B\\f\\r]+", " ").strip();
    }

    private static List<String> pieces(String cell, Predicate<String> readable) {
        if (cell == null) {
            return List.of();
        }
        return split(unwrap(normalize(cell), readable));
    }

    private static List<String> split(String text) {
        List<String> out = new ArrayList<>();
        for (String raw : SPLIT.split(text)) {
            String piece = TRAILING_WORD.matcher(raw.strip()).replaceFirst("").strip();
            if (!piece.isEmpty()) {
                out.add(piece);
            }
        }
        return out;
    }

    /**
     * 줄 경계가 조각 하나를 가른 칸을 다시 잇습니다(QA-1000 후속) — 수집기가 칸 안의 줄 경계를 남기므로, 구간 하나가 줄바꿈으로 꺾인 칸
     * ({@code 16.0 이상\n16.4 미만}·{@code 3.0.0 ~\n3.0.15}·{@code 16.4\n이상})은 줄마다 나누면 두 구간의 합이 되거나 읽히지 않습니다.
     * 앞 줄과 다음 줄을 빈칸으로 이은 글의 조각이 모두 읽히면 한 줄로 봅니다. 줄마다 온전한 구간·버전은 이으면 읽히지 않으므로
     * ({@code A 이상 B 미만 C 이상 D 미만}·{@code 1.2.3 1.2.4}) 전처럼 따로 남습니다. 둘 다 혼자 읽히면서 이어도 읽히는 것은 아래 끝만 있는 줄 뒤에
     * 위 끝만 있는 줄이 오는 꼴뿐이고(아래 끝이 위 끝보다 크면 이은 글이 읽히지 않아 따로), 그 합집합은 모든 버전이라 한 구간으로 읽는 쪽이 맞습니다.
     */
    private static String unwrap(String text, Predicate<String> readable) {
        if (text.indexOf('\n') < 0) {
            return text;
        }
        StringBuilder out = new StringBuilder();
        String current = null;
        for (String raw : text.split("\n")) {
            String line = raw.strip();
            if (line.isEmpty()) {
                continue;
            }
            if (current == null) {
                current = line;
                continue;
            }
            String joined = current + " " + line;
            if (allReadable(joined, readable)) {
                current = joined;
            } else {
                out.append(current).append('\n');
                current = line;
            }
        }
        return current == null ? "" : out.append(current).toString();
    }

    private static boolean allReadable(String text, Predicate<String> readable) {
        List<String> pieces = split(text);
        if (pieces.isEmpty()) {
            return false;
        }
        for (String piece : pieces) {
            if (!readable.test(piece)) {
                return false;
            }
        }
        return true;
    }

    private static boolean readableInterval(String piece) {
        return ALL.matcher(piece).matches() || interval(piece).isPresent();
    }

    private static Optional<Interval> interval(String piece) {
        Matcher m = BETWEEN.matcher(piece);
        if (m.matches()) {
            boolean lowerInclusive = m.group(2) != null || "이상".equals(m.group(3));
            return bounded(version(m.group(1)), lowerInclusive, version(m.group(4)), "이하".equals(m.group(5)));
        }
        m = TILDE.matcher(piece);
        if (m.matches()) {
            return bounded(version(m.group(1)), true, version(m.group(3)), true);
        }
        m = UPPER.matcher(piece);
        if (m.matches()) {
            boolean inclusive = !("미만".equals(m.group(2)) || "이전".equals(m.group(2)));
            return Optional.of(new Interval(null, false, version(m.group(1)), inclusive));
        }
        m = LOWER.matcher(piece);
        if (m.matches()) {
            boolean inclusive = m.group(2) != null || !("초과".equals(m.group(3)) || "이후".equals(m.group(3)));
            return Optional.of(new Interval(version(m.group(1)), inclusive, null, false));
        }
        m = WILDCARD.matcher(piece);
        if (m.matches()) {
            Version base = version(m.group(1));
            return Optional.of(new Interval(base, true, base.nextPrefix(base.parts().size()), false));
        }
        m = SINGLE.matcher(piece);
        if (m.matches()) {
            return Optional.of(Interval.exactly(version(m.group(1))));
        }
        return Optional.empty();
    }

    /** 양끝이 있는 구간 — 'A 이상 B 미만'에서 A가 B보다 크거나 같아 빈 구간이면 칸을 믿을 수 없으므로 해석 실패. */
    private static Optional<Interval> bounded(Version lower, boolean lowerInclusive, Version upper, boolean upperInclusive) {
        int cmp = lower.compareTo(upper);
        if (cmp > 0 || (cmp == 0 && !(lowerInclusive && upperInclusive))) {
            return Optional.empty();
        }
        return Optional.of(new Interval(lower, lowerInclusive, upper, upperInclusive));
    }

    private static Version version(String text) {
        // 정규식이 이미 모양을 맞췄으므로 비지 않습니다.
        return VersionOrder.parse(text).orElseThrow(() -> new IllegalArgumentException("버전 아님: " + text));
    }
}
