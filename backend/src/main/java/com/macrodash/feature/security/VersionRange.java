package com.macrodash.feature.security;

import com.macrodash.feature.security.VersionOrder.Version;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
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
 * 알 수 없는 조각({@code 8u511b33}·{@code R34 이상 R36 이하}·제품명이 섞인 글·괄호 설명)이 하나라도 있으면 칸 전체가 해석 실패입니다
 * (빈 {@link Optional} — 판정은 확인 필요 {@code PARSE_FAILED}).
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
    private static final Pattern BETWEEN = Pattern.compile(V + "\\s*(이상|초과)\\s*" + V + "\\s*(미만|이하)");
    private static final Pattern TILDE = Pattern.compile(V + "\\s*[~∼～]\\s*" + V);
    private static final Pattern UPPER = Pattern.compile(V + "\\s*(미만|이하|이전|및\\s*이전|및\\s*이하)");
    private static final Pattern LOWER = Pattern.compile(V + "\\s*(이상|초과|이후|및\\s*이후|및\\s*이상)");
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

    /** '영향받는 버전' 칸을 읽습니다. 알 수 없는 조각이 하나라도 있으면 빈 값. */
    public static Optional<VersionRange> parse(String cell) {
        List<String> pieces = pieces(cell);
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
        List<String> pieces = pieces(cell);
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

    private static List<String> pieces(String cell) {
        if (cell == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String raw : SPLIT.split(normalize(cell))) {
            String piece = TRAILING_WORD.matcher(raw.strip()).replaceFirst("").strip();
            if (!piece.isEmpty()) {
                out.add(piece);
            }
        }
        return out;
    }

    private static Optional<Interval> interval(String piece) {
        Matcher m = BETWEEN.matcher(piece);
        if (m.matches()) {
            return bounded(version(m.group(1)), "이상".equals(m.group(2)), version(m.group(3)), "이하".equals(m.group(4)));
        }
        m = TILDE.matcher(piece);
        if (m.matches()) {
            return bounded(version(m.group(1)), true, version(m.group(2)), true);
        }
        m = UPPER.matcher(piece);
        if (m.matches()) {
            boolean inclusive = !("미만".equals(m.group(2)) || "이전".equals(m.group(2)));
            return Optional.of(new Interval(null, false, version(m.group(1)), inclusive));
        }
        m = LOWER.matcher(piece);
        if (m.matches()) {
            boolean inclusive = !("초과".equals(m.group(2)) || "이후".equals(m.group(2)));
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
