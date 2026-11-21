package com.macrodash.feature.security;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * 판정 입력 — 운영 환경의 버전 목록 한 벌(ADR 0046 결정 1·2, 표 {@code env_inventory}·{@code env_components}·{@code env_pending_updates}).
 * 버전 목록이 아예 없으면 판정에 {@code null}을 넘깁니다(제품이 맞는 공지는 모두 확인 필요 {@code NO_INVENTORY}).
 *
 * @param sections   구역 이름 → 상태. 구역 이름은 {@link ProductAliases}의 {@code SECTION_*}(구성 요소의 {@code source}와 같은 값)
 * @param components 구성 요소
 * @param pending    서버의 apt 보류 목록(호스트 구역에 딸림)
 */
public record EnvInventory(Map<String, SectionStatus> sections, List<Component> components, List<Pending> pending) {

    public EnvInventory {
        sections = sections == null ? Map.of() : Map.copyOf(sections);
        components = components == null ? List.of() : List.copyOf(components);
        pending = pending == null ? List.of() : List.copyOf(pending);
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
