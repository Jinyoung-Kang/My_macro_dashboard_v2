package com.macrodash.feature.security;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 버전 번호의 순서(ADR 0046 결정 6) — 마디별 숫자 비교만 합니다. 순수 계산입니다(저장소를 모름).
 *
 * <p>통과하는 모양은 {@code v?숫자(.숫자){0,5}}(마디 1~6개)와, 그 뒤에 붙는 Java의 빌드 꼬리 {@code +숫자}(·{@code -LTS})뿐입니다.
 * 빌드 꼬리는 비교에 쓰지 않습니다({@code 21.0.1+12} = {@code 21.0.1}). 그 밖의 접미사({@code -rc1}·{@code p1}·{@code _513}·{@code -jre})와
 * 배포판 버전(에포크 {@code 1:}·{@code -0ubuntu…}·{@code -r0})은 해석 실패입니다 — 배포판 패키지는 버전 비교가 아니라 apt 보류 목록으로 판정합니다.
 * 실패는 예외가 아니라 빈 {@link Optional}로 돌려줍니다.
 *
 * <p>짧은 쪽은 0으로 채워 비교합니다({@code 16} = {@code 16.0} = {@code 16.0.0}).
 */
public final class VersionOrder {

    /** 마디 수 상한(6) — Oracle의 {@code 21.0.1.0.3}(다섯 마디)까지 들어갑니다. */
    static final int MAX_PARTS = 6;

    private static final Pattern SHAPE = Pattern.compile(
            "v?(\\d{1,18}(?:\\.\\d{1,18}){0," + (MAX_PARTS - 1) + "})(?:\\+\\d{1,9}(?:-LTS)?)?");

    private VersionOrder() {
    }

    /** 해석한 버전 — 적힌 마디 그대로 둡니다(표시용). 같음·순서는 {@link #compareTo}(0으로 채운 비교)로 봅니다. */
    public record Version(List<Long> parts) implements Comparable<Version> {

        public Version {
            if (parts == null || parts.isEmpty() || parts.size() > MAX_PARTS) {
                throw new IllegalArgumentException("버전 마디는 1~" + MAX_PARTS + "개");
            }
            for (Long part : parts) {
                if (part == null || part < 0) {
                    throw new IllegalArgumentException("버전 마디는 0 이상의 숫자");
                }
            }
            parts = List.copyOf(parts);
        }

        public static Version of(long... parts) {
            List<Long> list = new ArrayList<>(parts.length);
            for (long part : parts) {
                list.add(part);
            }
            return new Version(list);
        }

        long part(int index) {
            return index < parts.size() ? parts.get(index) : 0L;
        }

        @Override
        public int compareTo(Version other) {
            int length = Math.max(parts.size(), other.parts.size());
            for (int i = 0; i < length; i++) {
                int cmp = Long.compare(part(i), other.part(i));
                if (cmp != 0) {
                    return cmp;
                }
            }
            return 0;
        }

        /** 0으로 채워 같은지 — {@code 16}과 {@code 16.0}은 같습니다(레코드 {@code equals}와 다름). */
        public boolean sameAs(Version other) {
            return compareTo(other) == 0;
        }

        /** 앞 {@code depth}마디(모자라면 0) — 계열의 시작. 예: {@code 16.4}의 앞 1마디는 {@code 16}. */
        public Version prefix(int depth) {
            List<Long> out = new ArrayList<>(depth);
            for (int i = 0; i < depth; i++) {
                out.add(part(i));
            }
            return new Version(out);
        }

        /** 앞 {@code depth}마디의 마지막을 하나 올린 것 — 계열의 끝(포함하지 않음). 예: {@code 16.4}의 1마디 다음은 {@code 17}. */
        public Version nextPrefix(int depth) {
            List<Long> out = new ArrayList<>(prefix(depth).parts());
            out.set(depth - 1, out.get(depth - 1) + 1);
            return new Version(out);
        }

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < parts.size(); i++) {
                if (i > 0) {
                    sb.append('.');
                }
                sb.append(parts.get(i));
            }
            return sb.toString();
        }
    }

    /** 버전 글을 해석합니다. 앞뒤 공백은 지우고, 모양이 맞지 않으면 빈 값입니다. */
    public static Optional<Version> parse(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        Matcher m = SHAPE.matcher(raw.strip());
        if (!m.matches()) {
            return Optional.empty();
        }
        String[] pieces = m.group(1).split("\\.");
        List<Long> parts = new ArrayList<>(pieces.length);
        for (String piece : pieces) {
            parts.add(Long.parseLong(piece));
        }
        return Optional.of(new Version(parts));
    }

    /** 0으로 채운 마디별 비교. */
    public static int compare(Version a, Version b) {
        return a.compareTo(b);
    }
}
