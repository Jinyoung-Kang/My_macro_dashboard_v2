package com.macrodash.feature.security;

import java.time.Instant;
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

    /** 확인 필요 사유 아홉(ADR 0046 결정 6, {@link #DISTRO_OPEN}은 덧붙임 2026-11-21 '배포판 보안 추적기'). 순서가 API의 사유 순서입니다. */
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
        VENDOR_DIFFERS,
        /**
         * 배포판 패키지의 CVE 가운데 배포판 보안 추적기에 아직 고치지 않음(open)으로 적힌 것이 있음 — 고친 판이 나오지 않았거나 배포판이 미룸
         * (뒤처진 CVE가 없고 영향 없음·덮임만으로 가려지지 않을 때).
         */
        DISTRO_OPEN
    }

    /** 판정 근거의 종류(확인 필요 사유와 따로 — ADR 0046 덧붙임 2026-11-21). 근거가 버전 표·apt 보류 목록이면 {@code null}입니다. */
    public enum Basis {
        /** 서버 배포판 패키지의 변경 기록(changelog.Debian.gz)에 공지 표의 그 제품 행 CVE가 모두 있음 — 배포판 패키지의 패치됨 근거. */
        CHANGELOG,
        /**
         * 배포판 보안 추적기(Ubuntu·Debian·Alpine)를 하나라도 썼음 — 패치됨(설치 판 ≥ 고친 판이거나 영향 없음, 나머지는 변경 기록), 해당(고친 판이
         * 나왔는데 설치 판이 낮음), 무관(모든 CVE가 영향 없음)의 근거.
         */
        TRACKER
    }

    /** 배포판 보안 추적기의 CVE 하나의 상태 — API 값은 {@link #code()}(fixed·not_affected·open·unknown·none). */
    public enum TrackerStatus {
        /** 그 스위트에 고친 판이 있음(고친 판을 함께 적음). */
        FIXED,
        /** 영향 없음(그 스위트에 패키지가 없음 포함). */
        NOT_AFFECTED,
        /** 아직 고치지 않음. */
        OPEN,
        /** 추적기에 그 패키지·스위트의 기록이 없음. */
        UNKNOWN,
        /** 아직 묻지 않음(물어볼 것에 올렸고 수집기가 다음 실행에서 물음). */
        NONE;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** 표 {@code distro_cve_status.status} 값을 읽습니다. 모르는 값은 {@link #UNKNOWN}(모르는 것을 안전으로 두지 않음). */
        public static TrackerStatus fromDb(String value) {
            if (value != null) {
                for (TrackerStatus s : values()) {
                    if (s != NONE && s.code().equals(value.strip())) {
                        return s;
                    }
                }
            }
            return UNKNOWN;
        }
    }

    /**
     * 배포판 추적기 근거 — 배포판 패키지 근거 한 줄에서 변경 기록으로 덮이지 않은 CVE마다 추적기 상태.
     *
     * @param distro 배포판(ubuntu·debian·alpine — 그 구역의 os-release ID)
     * @param suite  스위트(Ubuntu·Debian은 코드명, Alpine은 {@code v} + 앞 두 마디)
     * @param pkg    물은 원본 패키지(dpkg {@code source:Package}·apk {@code o:}, 실행 중인 커널은 {@code linux})
     * @param cves   CVE마다 상태(공지 표의 그 제품 행 순서)
     */
    public record Tracker(String distro, String suite, String pkg, List<TrackerCve> cves) {

        public Tracker {
            cves = List.copyOf(cves);
        }
    }

    /**
     * 추적기 근거의 CVE 하나.
     *
     * @param cve          CVE 번호
     * @param status       상태({@link TrackerStatus#NONE}이면 아직 묻지 않음)
     * @param fixedVersion 고친 판(fixed일 때만, 그 밖은 {@code null})
     * @param checkedAt    추적기에 물은 시각(묻지 않았으면 {@code null})
     * @param verdict      이 구성 요소에서 이 CVE의 판정 — 설치 판 ≥ 고친 판이면 패치됨, 낮으면 해당, 영향 없음이면 무관, 그 밖(열림·모름·묻지 않음·판 비교
     *                     실패)은 확인 필요. 표 행마다의 판정(화면의 '이 행 판정')에 씁니다.
     */
    public record TrackerCve(String cve, TrackerStatus status, String fixedVersion, Instant checkedAt, Status verdict) {
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
     * @param basis            판정 근거의 종류(변경 기록이면 {@link Basis#CHANGELOG}, 추적기를 썼으면 {@link Basis#TRACKER}, 그 밖이면 {@code null})
     * @param tracker          배포판 추적기 근거 — 추적기를 쓸 수 있는 배포판 패키지 근거(그 구역의 os를 알고 배포판이 ubuntu·debian·alpine)에서
     *                         변경 기록으로 덮이지 않은 CVE가 있을 때만, 그 밖은 {@code null}
     */
    public record Match(String aliasId, Integer rowIndex, String cve, String rowProduct, String source, String component,
                        String installedVersion, Status status, Reason reason, boolean otherFamily, Basis basis, Tracker tracker) {

        /** 추적기 근거가 없는 근거 줄. */
        public Match(String aliasId, Integer rowIndex, String cve, String rowProduct, String source, String component,
                     String installedVersion, Status status, Reason reason, boolean otherFamily, Basis basis) {
            this(aliasId, rowIndex, cve, rowProduct, source, component, installedVersion, status, reason, otherFamily, basis, null);
        }
    }
}
