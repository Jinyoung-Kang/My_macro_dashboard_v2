package com.macrodash.feature.security;

import com.macrodash.feature.security.Verdict.TrackerStatus;

import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 판정 입력 — 운영 환경의 버전 목록 한 벌(ADR 0046 결정 1·2, 표 {@code env_inventory}·{@code env_components}·{@code env_pending_updates}·
 * {@code env_changelog_cves})과 배포판 보안 추적기에 물어 본 결과(표 {@code distro_cve_status}, V42 — ADR 0046 덧붙임 2026-11-21).
 * 버전 목록이 아예 없으면 판정에 {@code null}을 넘깁니다(제품이 맞는 공지는 모두 확인 필요 {@code NO_INVENTORY}).
 *
 * @param sections   구역 이름 → 상태. 구역 이름은 {@link ProductAliases}의 {@code SECTION_*}(구성 요소의 {@code source}와 같은 값)
 * @param components 구성 요소
 * @param pending    서버의 apt 보류 목록(호스트 구역에 딸림)
 * @param changelog  서버 배포판 패키지 변경 기록의 CVE 번호(호스트 구역에 딸림 — ADR 0046 덧붙임 2026-11-21). 열쇠는 dpkg 원본 패키지 이름·
 *                   설치 버전, 실행 중인 커널은 {@code kernel}·{@code uname -r}
 * @param os         구역 이름 → 그 구역의 /etc/os-release(버전 목록 입력의 {@code os} 줄, 없으면 그 구역이 빠짐)
 * @param tracker    배포판 보안 추적기에 물어 본 결과(배포판·스위트·원본 패키지·CVE → 상태)
 */
public record EnvInventory(Map<String, SectionStatus> sections, List<Component> components, List<Pending> pending,
                           Map<PackageVersion, Set<String>> changelog, Map<String, OsRelease> os,
                           Map<TrackerKey, TrackerEntry> tracker) {

    public EnvInventory {
        sections = sections == null ? Map.of() : Map.copyOf(sections);
        components = components == null ? List.of() : List.copyOf(components);
        pending = pending == null ? List.of() : List.copyOf(pending);
        Map<PackageVersion, Set<String>> copy = new HashMap<>();
        if (changelog != null) {
            changelog.forEach((key, cves) -> copy.put(key, Set.copyOf(cves)));
        }
        changelog = Map.copyOf(copy);
        os = os == null ? Map.of() : Map.copyOf(os);
        tracker = tracker == null ? Map.of() : Map.copyOf(tracker);
    }

    /** 변경 기록 없이(로컬·QA처럼 호스트 구역이 없는 곳, 시험). */
    public EnvInventory(Map<String, SectionStatus> sections, List<Component> components, List<Pending> pending) {
        this(sections, components, pending, Map.of());
    }

    /** os·추적기 결과 없이(시험). */
    public EnvInventory(Map<String, SectionStatus> sections, List<Component> components, List<Pending> pending,
                        Map<PackageVersion, Set<String>> changelog) {
        this(sections, components, pending, changelog, Map.of(), Map.of());
    }

    /** 그 구역의 os-release(모르면 빈 값). */
    public Optional<OsRelease> osOf(String section) {
        return Optional.ofNullable(section == null ? null : os.get(section));
    }

    /** 추적기에 물어 본 결과(아직 묻지 않았으면 빈 값). */
    public Optional<TrackerEntry> trackerOf(TrackerKey key) {
        return Optional.ofNullable(tracker.get(key));
    }

    /** 그 패키지·버전의 변경 기록에 {@code cve}가 있는지. */
    public boolean changelogHas(String pkg, String version, String cve) {
        Set<String> known = changelog.get(new PackageVersion(pkg, version));
        return known != null && cve != null && known.contains(cve);
    }

    /** 추적기 스위트 모양(V42의 CHECK와 같음). */
    static final Pattern SUITE = Pattern.compile("[a-z0-9][a-z0-9.+-]{0,31}");
    /** 원본 패키지 이름 모양(V42의 CHECK와 같음). */
    static final Pattern PACKAGE = Pattern.compile("[a-z0-9][a-z0-9.+-]{0,99}");
    private static final Pattern ALPINE_RELEASE = Pattern.compile("(\\d{1,4})\\.(\\d{1,4})(?:\\.\\d{1,6})*");

    /**
     * 구역 하나의 /etc/os-release — 버전 목록 입력의 {@code os} 줄(ADR 0046 덧붙임 2026-11-21, {@code env_inventory.sections}의 구역 객체
     * {@code "os": {"id", "versionId", "codename"}}). 없는 값은 {@code null}.
     *
     * @param id        {@code ID}(ubuntu·debian·alpine 등)
     * @param versionId {@code VERSION_ID}(24.04·13·3.24.4 등)
     * @param codename  {@code VERSION_CODENAME}(noble·trixie 등, Alpine은 없음)
     */
    public record OsRelease(String id, String versionId, String codename) {

        /** 추적기를 쓰는 배포판(ubuntu·debian·alpine) — 그 밖은 빈 값. */
        public Optional<String> trackerDistro() {
            return id != null && List.of("ubuntu", "debian", "alpine").contains(id) ? Optional.of(id) : Optional.empty();
        }

        /**
         * 추적기 스위트 — Ubuntu·Debian은 코드명, Alpine은 {@code v} + {@code VERSION_ID} 앞 두 마디({@code 3.24.4} → {@code v3.24}).
         * 모르거나 모양이 틀리면 빈 값(Alpine 개발판의 {@code 3.23.0_alpha…} 꼴도 빈 값).
         */
        public Optional<String> trackerSuite() {
            Optional<String> distro = trackerDistro();
            if (distro.isEmpty()) {
                return Optional.empty();
            }
            String suite = null;
            if ("alpine".equals(distro.get())) {
                Matcher m = versionId == null ? null : ALPINE_RELEASE.matcher(versionId);
                if (m != null && m.matches()) {
                    suite = "v" + Integer.parseInt(m.group(1)) + "." + Integer.parseInt(m.group(2));
                }
            } else {
                suite = codename;
            }
            return suite != null && SUITE.matcher(suite).matches() ? Optional.of(suite) : Optional.empty();
        }
    }

    /** 추적기 결과의 열쇠 — 표 {@code distro_cve_status}·{@code security_tracker_wants}의 기본 키와 같습니다. */
    public record TrackerKey(String distro, String suite, String pkg, String cve) {
    }

    /**
     * 추적기에 물어 본 결과 하나.
     *
     * @param status       fixed·not_affected·open·unknown({@link TrackerStatus#NONE}은 쓰지 않음)
     * @param fixedVersion 고친 판(fixed일 때만)
     * @param checkedAt    물은 시각
     */
    public record TrackerEntry(TrackerStatus status, String fixedVersion, Instant checkedAt) {
    }

    /** 변경 기록의 열쇠 — 원본 패키지(또는 {@code kernel})와 버전. */
    public record PackageVersion(String pkg, String version) {
    }

    /** 그 패키지·버전의 변경 기록에 {@code cves}가 모두 있는지. {@code cves}가 비었거나 그 변경 기록이 없으면 아님. */
    public boolean changelogHasAll(String pkg, String version, Collection<String> cves) {
        if (cves == null || cves.isEmpty()) {
            return false;
        }
        Set<String> known = changelog.get(new PackageVersion(pkg, version));
        return known != null && known.containsAll(cves);
    }

    /** 그 구역을 이번에 제대로 모았는지 — 표에 없는 구역은 모르는 것으로 봅니다. */
    public boolean sectionOk(String section) {
        return sections.get(section) == SectionStatus.OK;
    }

    /** 구역 상태 — 표의 값은 {@code ok}·{@code failed}·{@code skipped}. */
    public enum SectionStatus {
        OK, FAILED, SKIPPED;

        public String dbValue() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** DB 값을 읽습니다. 모르는 값은 {@link #FAILED}(모르는 것을 성공으로 두지 않음). */
        public static SectionStatus fromDb(String value) {
            if (value == null) {
                return FAILED;
            }
            for (SectionStatus s : values()) {
                if (s.dbValue().equals(value.strip())) {
                    return s;
                }
            }
            return FAILED;
        }
    }

    /**
     * 구성 요소 하나.
     *
     * @param source        구역(어디서 모았나 — {@code host}·{@code postgres}·{@code backend} 등)
     * @param ecosystem     종류({@code runtime}·{@code dpkg}·{@code apk}·{@code maven}·{@code npm}·{@code pypi})
     * @param name          이름(dpkg·apk는 바이너리 패키지 이름)
     * @param version       설치 버전(원문 그대로)
     * @param sourcePackage 원본 패키지(dpkg의 {@code source:Package}·apk의 {@code o:}). 없으면 {@code null}
     */
    public record Component(String source, String ecosystem, String name, String version, String sourcePackage) {

        public Component {
            source = source == null ? "" : source;
            ecosystem = ecosystem == null ? "" : ecosystem;
            name = name == null ? "" : name;
            version = version == null ? "" : version;
        }

        public Optional<String> sourcePackageName() {
            return sourcePackage == null || sourcePackage.isBlank() ? Optional.empty() : Optional.of(sourcePackage);
        }
    }

    /**
     * apt 보류 항목 하나.
     *
     * @param pkg              바이너리 패키지 이름
     * @param installedVersion 설치 버전
     * @param candidateVersion 후보 버전
     * @param security         보안 저장소(이름이 {@code -security}로 끝남 — ESM {@code -infra-security}·{@code -apps-security} 포함)에서 온 것인지
     */
    public record Pending(String pkg, String installedVersion, String candidateVersion, boolean security) {
    }
}
