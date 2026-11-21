package com.macrodash.feature.security;

import java.util.Collection;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 공지 한 건의 판정(ADR 0046 결정 6) — {@link NoticeJudge}가 만듭니다. 저장하지 않고 읽을 때마다 계산합니다(결정 5).
 *
 * @param status         공지 판정 = 제품 판정의 최댓값(해당 &gt; 확인 필요 &gt; 패치됨 &gt; 무관). 맞는 제품이 없으면 무관
 * @param reasons        공지 판정과 같은 판정을 받은 제품들의 사유 합. 확인 필요면 왜 모르는지, 해당이면 {@link Reason#CONDITION_NOTE}가
 *                       '조건 문장 있음' 표시입니다
 * @param products       별칭 표의 제품마다 판정(공지 표의 행이나 본문에 나온 제품만, 별칭 표 순서)
 * @param matches        행·구성 요소 단위 근거(제품 순서 → 구성 요소 → 표 행 순서)
 * @param conditionNotes 판정에 쓴 표 밖 {@code ※} 조건 문장(관용 문장을 뺀 것)
 */
public record Verdict(Status status, Set<Reason> reasons, List<ProductVerdict> products, List<Match> matches,
                      List<String> conditionNotes) {

    public Verdict {
        reasons = reasonSet(reasons);
        products = List.copyOf(products);
        matches = List.copyOf(matches);
        conditionNotes = List.copyOf(conditionNotes);
    }

    static Set<Reason> reasonSet(Collection<Reason> reasons) {
        EnumSet<Reason> set = EnumSet.noneOf(Reason.class);
        if (reasons != null) {
            set.addAll(reasons);
        }
        return Collections.unmodifiableSet(set);
    }

    /** 판정 넷. 순서가 곧 세기(큰 쪽이 앞) — 모르는 것을 패치됨·무관으로 두지 않습니다. */
    public enum Status {
        /** 설치 버전이 영향 구간 안. 배포판 패키지는 apt 보류(보안) 목록에 있을 때만. */
        AFFECTED(3),
        /** 제품은 맞는데 판정할 수 없음 — 사유 코드를 붙입니다. */
        CHECK(2),
        /** 같은 계열의 행이 있고 설치 버전이 해결 버전 이상. */
        PATCHED(1),
        /** 쓰지 않는 제품(또는 그 제품이 설치돼 있지 않음). */
        UNRELATED(0);

        private final int rank;

        Status(int rank) {
            this.rank = rank;
        }

        public int rank() {
            return rank;
        }

        /** API·화면에 쓰는 이름({@code affected}·{@code check}·{@code patched}·{@code unrelated}). */
        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }

        public static Status max(Status a, Status b) {
            return a.rank >= b.rank ? a : b;
        }
    }

    /** 확인 필요 사유 여덟(ADR 0046 결정 6). */
    public enum Reason {
        /** 버전 칸(영향·해결)이나 설치 버전을 해석하지 못함. */
        PARSE_FAILED,
        /** 같은 계열의 행이 없거나, 설치 버전이 영향 구간 밖인데 해결 버전보다 낮음. */
        OUT_OF_TABLE,
        /** 배포판 패키지인데 apt 보류(보안) 목록에 없음 — 패치를 받았는지 모름(컨테이너 안 apk·dpkg는 늘 이것). */
        DISTRO_NO_PENDING,
        /** 버전 목록이 없거나 그 구역을 모으지 못함. */
        NO_INVENTORY,
        /** 표 밖 {@code ※} 조건 문장이 있음(해당이면 '조건 문장 있음' 표시, 패치됨이면 확인 필요로 내림). */
        CONDITION_NOTE,
        /** 버전 표가 없는 공지의 제목·본문에 별칭이 나옴. */
        NO_VERSION_TABLE,
        /** 이름만 맞음 — 표에는 없고 제목·본문에만 나오거나(상세 전 포함), 설치 버전을 공지의 번호와 견줄 수 없는 제품. */
        NAME_MATCH,
        /** 제조사가 다름(Oracle Java SE 공지와 Temurin 등) — 번호가 구간 안이어도 확인 필요. */
        VENDOR_DIFFERS
    }

    /**
     * 제품(별칭) 하나의 판정.
     *
     * @param aliasId 별칭 id({@link ProductAliases.Alias#id()})
     * @param label   화면·알림에 쓰는 제품 이름
     * @param status  이 제품의 판정
     * @param reasons 이 판정의 사유(확인 필요의 사유, 해당이면 '조건 문장 있음')
     */
    public record ProductVerdict(String aliasId, String label, Status status, Set<Reason> reasons) {

        public ProductVerdict {
            reasons = reasonSet(reasons);
        }
    }

    /**
     * 근거 한 줄 — 구성 요소 하나 × 공지 표 행 하나(또는 행 전체).
     *
     * @param aliasId          별칭 id
     * @param rowIndex         공지 표 행 순서. 행 하나에 매이지 않는 근거(배포판 판정·버전 목록 없음·본문 이름 일치·같은 계열 행 없음)는 {@code null}
     * @param cve              그 행의 취약점 칸(행이 없으면 {@code null})
     * @param rowProduct       그 행의 제품명 칸(행이 없으면 {@code null})
     * @param source           구성 요소의 구역(구역을 모으지 못한 근거면 그 구역 이름, 버전 목록이 없으면 {@code null})
     * @param component        구성 요소 이름(없으면 {@code null})
     * @param installedVersion 설치 버전 원문(없으면 {@code null}) — 운영자 화면에만 씁니다. 알림 글·로그에 넣지 않습니다(결정 7)
     * @param status           이 근거의 판정
     * @param reason           확인 필요 사유(그 밖이면 {@code null})
     * @param otherFamily      다른 계열의 행이라 이 구성 요소의 판정에 쓰지 않음(그때 {@code status}는 무관)
     */
    public record Match(String aliasId, Integer rowIndex, String cve, String rowProduct, String source, String component,
                        String installedVersion, Status status, Reason reason, boolean otherFamily) {
    }
}
