package com.macrodash.feature.security;

import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * 판정 입력 — 보호나라 공지 한 건(ADR 0046, 표 {@code security_notices}). 저장소가 읽은 행을 서비스가 이 레코드로 옮깁니다
 * (store는 기능 패키지를 모르므로 — ADR 0001).
 *
 * @param nttId          게시판 글 번호
 * @param title          제목
 * @param template       본문 틀. 상세를 아직 받지 못했으면 {@code null}(제목만으로 판정)
 * @param conditionNotes 표 밖 {@code ※} 문장들(원문 그대로 — 관용 문장 거르기는 판정이 함)
 * @param bodyText       표를 뺀 본문 글자. 상세를 아직 받지 못했으면 {@code null}
 */
public record SecurityNotice(long nttId, String title, Template template, List<String> conditionNotes, String bodyText) {

    public SecurityNotice {
        title = title == null ? "" : title;
        conditionNotes = conditionNotes == null ? List.of() : List.copyOf(conditionNotes);
    }

    /** 본문 틀 — 표 {@code security_notices}의 값은 {@code product_table}·{@code other_table}·{@code no_table}. */
    public enum Template {
        /** {@code 취약점 | 제품명 | 영향받는 버전 | 해결 버전} 표가 있는 제품 공지. */
        PRODUCT_TABLE,
        /** 표는 있지만 제품 버전 표가 아님. */
        OTHER_TABLE,
        /** 표가 없음. */
        NO_TABLE;

        public String dbValue() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** DB 값을 읽습니다. 모르는 값·{@code null}은 빈 값(상세 없음과 같이 다룸). */
        public static Optional<Template> fromDb(String value) {
            if (value == null) {
                return Optional.empty();
            }
            for (Template t : values()) {
                if (t.dbValue().equals(value.strip())) {
                    return Optional.of(t);
                }
            }
            return Optional.empty();
        }
    }

    /**
     * 공지 표 한 행(표 {@code security_notice_rows}) — 칸은 원문 그대로.
     *
     * @param index    표 안의 순서(0부터)
     * @param cve      취약점 칸(없으면 빈 글)
     * @param product  제품명 칸
     * @param affected 영향받는 버전 칸
     * @param fixed    해결 버전 칸
     */
    public record Row(int index, String cve, String product, String affected, String fixed) {

        public Row {
            cve = cve == null ? "" : cve;
            product = product == null ? "" : product;
            affected = affected == null ? "" : affected;
            fixed = fixed == null ? "" : fixed;
        }
    }
}
