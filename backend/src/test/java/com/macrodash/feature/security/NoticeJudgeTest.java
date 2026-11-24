package com.macrodash.feature.security;

import com.macrodash.feature.security.EnvInventory.Component;
import com.macrodash.feature.security.EnvInventory.OsRelease;
import com.macrodash.feature.security.EnvInventory.Pending;
import com.macrodash.feature.security.EnvInventory.SectionStatus;
import com.macrodash.feature.security.EnvInventory.TrackerEntry;
import com.macrodash.feature.security.EnvInventory.TrackerKey;
import com.macrodash.feature.security.SecurityNotice.Row;
import com.macrodash.feature.security.SecurityNotice.Template;
import com.macrodash.feature.security.Verdict.Basis;
import com.macrodash.feature.security.Verdict.Match;
import com.macrodash.feature.security.Verdict.ProductVerdict;
import com.macrodash.feature.security.Verdict.Reason;
import com.macrodash.feature.security.Verdict.Status;
import com.macrodash.feature.security.Verdict.TrackerCve;
import com.macrodash.feature.security.Verdict.TrackerStatus;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 공지 판정(ADR 0046 결정 6·9) — 네 판정·여덟 사유·최댓값·계열 규칙·※·제조사·배포판·버전 목록 없음.
 * 버전·패키지 이름은 모두 가짜(운영 서버의 실제 버전 목록과 무관)이고, 공지 표 행도 합성입니다.
 */
class NoticeJudgeTest {

    // ---- 가짜 입력 만들기 ----

    private static Component comp(String source, String ecosystem, String name, String version) {
        return new Component(source, ecosystem, name, version, null);
    }

    private static Component pkg(String source, String ecosystem, String name, String version, String sourcePackage) {
        return new Component(source, ecosystem, name, version, sourcePackage);
    }

    /** 일곱 구역을 모두 모은 버전 목록. */
    private static EnvInventory inventory(List<Pending> pending, Component... components) {
        Map<String, SectionStatus> sections = new LinkedHashMap<>();
        for (String s : ProductAliases.ALL_SECTIONS) {
            sections.put(s, SectionStatus.OK);
        }
        return new EnvInventory(sections, Arrays.asList(components), pending);
    }

    private static EnvInventory inventory(Component... components) {
        return inventory(List.of(), components);
    }

    private static EnvInventory withSection(EnvInventory inv, String section, SectionStatus status) {
        Map<String, SectionStatus> sections = new LinkedHashMap<>(inv.sections());
        sections.put(section, status);
        return new EnvInventory(sections, inv.components(), inv.pending(), inv.changelog(), inv.os(), inv.tracker());
    }

    /** 변경 기록 한 벌을 더한 버전 목록(ADR 0046 덧붙임 2026-11-21) — 패키지·버전 하나에 CVE 여럿. */
    private static EnvInventory withChangelog(EnvInventory inv, String pkg, String version, String... cves) {
        Map<EnvInventory.PackageVersion, Set<String>> changelog = new LinkedHashMap<>(inv.changelog());
        changelog.put(new EnvInventory.PackageVersion(pkg, version), Set.of(cves));
        return new EnvInventory(inv.sections(), inv.components(), inv.pending(), changelog, inv.os(), inv.tracker());
    }

    /** 구역의 os-release를 더한 버전 목록(배포판 보안 추적기 — 가짜 코드명·판). */
    private static EnvInventory withOs(EnvInventory inv, String section, String id, String versionId, String codename) {
        Map<String, OsRelease> os = new LinkedHashMap<>(inv.os());
        os.put(section, new OsRelease(id, versionId, codename));
        return new EnvInventory(inv.sections(), inv.components(), inv.pending(), inv.changelog(), os, inv.tracker());
    }

    static final Instant CHECKED = Instant.parse("2026-11-21T06:00:00Z");

    /** 추적기 결과 한 행을 더한 버전 목록. */
    private static EnvInventory withTracker(EnvInventory inv, String distro, String suite, String pkg, String cve, TrackerStatus status,
                                            String fixedVersion) {
        Map<TrackerKey, TrackerEntry> tracker = new LinkedHashMap<>(inv.tracker());
        tracker.put(new TrackerKey(distro, suite, pkg, cve), new TrackerEntry(status, fixedVersion, CHECKED));
        return new EnvInventory(inv.sections(), inv.components(), inv.pending(), inv.changelog(), inv.os(), tracker);
    }

    private static SecurityNotice tableNotice(String... notes) {
        return new SecurityNotice(1L, "가짜 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(notes), "가짜 개요");
    }

    private static List<Row> rows(String... cells) {
        // cells: 제품|영향|해결 — 여러 줄
        List<Row> out = new ArrayList<>();
        for (int i = 0; i < cells.length; i++) {
            String[] c = cells[i].split("\\|", -1);
            out.add(new Row(i, "CVE-2099-" + (1000 + i), c[0], c[1], c[2]));
        }
        return out;
    }

    private static final Component PG = comp("postgres", "runtime", "postgres", "16.42");

    private static Verdict judge(List<Row> rows, EnvInventory inv) {
        return NoticeJudge.judge(tableNotice(), rows, inv);
    }

    private static ProductVerdict product(Verdict v, String aliasId) {
        return v.products().stream().filter(p -> p.aliasId().equals(aliasId)).findFirst().orElseThrow();
    }

    // ---- 네 판정 ----

    @Nested
    @DisplayName("네 판정")
    class FourStatuses {

        private final List<Row> pgRows = rows(
                "PostgreSQL|17 이상 17.30 미만|17.30 이상",
                "PostgreSQL|16 이상 16.50 미만|16.50 이상",
                "PostgreSQL|15 이상 15.70 미만|15.70 이상");

        @Test
        @DisplayName("QA-1000 해당 — 한 칸에 줄마다 적힌 구간(수집기가 줄 경계를 \\n으로 남김)도 읽음, 공백으로 합쳐진 옛 저장본은 형식 못 읽음")
        void affectedByLineSeparatedRanges() {
            Verdict v = judge(rows("PostgreSQL|16.0 이상 16.50 미만\n17.0 이상 17.30 미만|16.50\n17.30"), inventory(PG));
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(v.reasons()).isEmpty();

            Verdict joined = judge(rows("PostgreSQL|16.0 이상 16.50 미만 17.0 이상 17.30 미만|16.50 17.30"), inventory(PG));
            assertThat(joined.status()).isEqualTo(Status.CHECK);
            assertThat(joined.reasons()).containsExactly(Reason.PARSE_FAILED);
        }

        @Test
        @Disabled("QA-999 — 수정 커밋에서 표시를 뗀다")
        @DisplayName("QA-999 해당 — 한 칸에 이 스택의 제품과 이름이 겹치는 다른 제품이 함께 적힌 행도 버전을 견줌(행이 통째로 빠지지 않음)")
        void affectedInMultiProductCell() {
            Component docker = comp("host", "runtime", "docker", "97.0.1");
            Verdict v = judge(rows("Docker Engine, Docker Desktop|97 이상 98 미만|98.0.0"), inventory(docker));
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(v.products()).extracting(ProductVerdict::aliasId).containsExactly("docker");

            Verdict lines = judge(rows("Docker Desktop\nDocker Engine|97 이상 98 미만|98.0.0"), inventory(docker));
            assertThat(lines.status()).isEqualTo(Status.AFFECTED);

            Verdict patched = judge(rows("Docker Engine 및 Docker Desktop|96 이상 97 미만|97.0.0"), inventory(docker));
            assertThat(patched.status()).isEqualTo(Status.PATCHED);

            // 그대로 — 다른 제품만 적힌 행은 무관.
            assertThat(judge(rows("Docker Desktop, Docker Hub|97 이상 98 미만|98.0.0"), inventory(docker)).status()).isEqualTo(Status.UNRELATED);
        }

        @Test
        @DisplayName("해당 — 설치 버전이 영향 구간 안. 다른 계열 행은 근거로만 남고 판정에 쓰지 않음")
        void affected() {
            Verdict v = judge(pgRows, inventory(PG));
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(v.reasons()).isEmpty();
            assertThat(v.products()).extracting(ProductVerdict::aliasId).containsExactly("postgresql");
            assertThat(v.matches()).extracting(Match::otherFamily).containsExactly(true, false, true);
            Match hit = v.matches().get(1);
            assertThat(hit.status()).isEqualTo(Status.AFFECTED);
            assertThat(hit.rowIndex()).isEqualTo(1);
            assertThat(hit.cve()).isEqualTo("CVE-2099-1001");
            assertThat(hit.installedVersion()).isEqualTo("16.42");
        }

        @Test
        @DisplayName("패치됨 — 같은 계열의 행이 있고 설치 버전이 해결 버전 이상")
        void patched() {
            Verdict v = judge(pgRows, inventory(comp("postgres", "runtime", "postgres", "16.55")));
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(v.reasons()).isEmpty();
        }

        @Test
        @DisplayName("확인 필요 — 같은 계열의 행이 없음(16.x·17.x 행만 있는데 18.x)")
        void checkOutOfTable() {
            Verdict v = judge(rows("PostgreSQL|17 이상 17.30 미만|17.30 이상", "PostgreSQL|16 이상 16.50 미만|16.50 이상"),
                    inventory(comp("postgres", "runtime", "postgres", "18.2")));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.OUT_OF_TABLE);
            Match last = v.matches().get(v.matches().size() - 1);
            assertThat(last.rowIndex()).isNull();
            assertThat(last.reason()).isEqualTo(Reason.OUT_OF_TABLE);
        }

        @Test
        @DisplayName("무관 — 쓰지 않는 제품의 공지(PHP·NGINX)는 제품 목록도 비어 있음")
        void unrelated() {
            Verdict v = judge(rows("PHP 8.2|8.2.36 미만|8.2.36 이상", "NGINX Open Source|1.9.5 이상 1.30.6 이하|1.30.7"),
                    inventory(PG));
            assertThat(v.status()).isEqualTo(Status.UNRELATED);
            assertThat(v.products()).isEmpty();
            assertThat(v.matches()).isEmpty();
        }

        @Test
        @DisplayName("무관 — 별칭은 맞지만 그 구역을 모두 모았는데 구성 요소가 없음(설치 안 됨)")
        void notInstalled() {
            Verdict v = judge(rows("Caddy|2.0 이상 2.99 미만|2.99 이상"), inventory(PG));
            assertThat(v.status()).isEqualTo(Status.UNRELATED);
            assertThat(product(v, "caddy").status()).isEqualTo(Status.UNRELATED);
        }
    }

    // ---- 최댓값 ----

    @Test
    @DisplayName("공지 판정은 제품 판정의 최댓값 — 해당 > 확인 필요 > 패치됨 > 무관, 사유는 그 판정을 받은 제품의 것만")
    void maximum() {
        EnvInventory inv = inventory(comp("postgres", "runtime", "postgres", "16.55"), comp("frontend", "runtime", "node", "v30.1.0"),
                comp("browser", "runtime", "chrome", "500.0.1.2"));
        List<Row> patchedAndAffected = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상", "Node.js|30.0.0 이상 30.2.0 미만|30.2.0 이상");
        Verdict v1 = judge(patchedAndAffected, inv);
        assertThat(v1.status()).isEqualTo(Status.AFFECTED);
        assertThat(product(v1, "postgresql").status()).isEqualTo(Status.PATCHED);
        assertThat(product(v1, "node").status()).isEqualTo(Status.AFFECTED);

        List<Row> patchedAndCheck = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상", "Google Chrome|R1 이전|R2");
        Verdict v2 = judge(patchedAndCheck, inv);
        assertThat(v2.status()).isEqualTo(Status.CHECK);
        assertThat(v2.reasons()).containsExactly(Reason.PARSE_FAILED);

        List<Row> patchedOnly = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상", "PHP 8.4|8.4.28 미만|8.4.28 이상");
        assertThat(judge(patchedOnly, inv).status()).isEqualTo(Status.PATCHED);

        assertThat(Status.max(Status.CHECK, Status.PATCHED)).isEqualTo(Status.CHECK);
        assertThat(Status.max(Status.UNRELATED, Status.AFFECTED)).isEqualTo(Status.AFFECTED);
    }

    // ---- 계열 규칙 ----

    @Nested
    @DisplayName("계열 규칙")
    class Families {

        @Test
        @DisplayName("같은 계열인데 영향 구간 아래(해결 버전 미만) — 패치됨이 아니라 확인 필요 OUT_OF_TABLE")
        void belowRangeInFamily() {
            Verdict v = judge(rows("PostgreSQL|16.20 이상 16.50 미만|16.50 이상"),
                    inventory(comp("postgres", "runtime", "postgres", "16.10")));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.OUT_OF_TABLE);
        }

        @Test
        @DisplayName("MINOR 계열(Next.js) — 15.1·15.2 행만 있으면 15.3은 확인 필요, 15.2는 해결 버전 이상이면 패치됨")
        void minorFamily() {
            List<Row> r = rows("Next.js|15.1.0 이상 15.1.9 미만|15.1.9 이상", "Next.js|15.2.0 이상 15.2.6 미만|15.2.6 이상");
            assertThat(judge(r, inventory(comp("frontend", "npm", "next", "15.3.4"))).reasons()).containsExactly(Reason.OUT_OF_TABLE);
            assertThat(judge(r, inventory(comp("frontend", "npm", "next", "15.2.7"))).status()).isEqualTo(Status.PATCHED);
            assertThat(judge(r, inventory(comp("frontend", "npm", "next", "15.2.1"))).status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("SINGLE 계열(Chrome) — 모든 행이 같은 계열, 해결 버전 이상이면 패치됨")
        void singleFamily() {
            List<Row> r = rows("Google Chrome|500.0.100.5 미만|500.0.100.5 이상");
            assertThat(judge(r, inventory(comp("browser", "runtime", "chrome", "501.0.1.1"))).status()).isEqualTo(Status.PATCHED);
            assertThat(judge(r, inventory(comp("browser", "runtime", "chrome", "500.0.99.9"))).status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("해결 칸이 '-'(해결 버전 없음) — 구간 안이면 해당, 같은 계열 구간 밖이면 확인 필요")
        void noFix() {
            List<Row> r = rows("Caddy|2.50 이상 2.60 이하|-");
            assertThat(judge(r, inventory(comp("caddy", "runtime", "caddy", "2.55.0"))).status()).isEqualTo(Status.AFFECTED);
            Verdict outside = judge(r, inventory(comp("caddy", "runtime", "caddy", "2.70.0")));
            assertThat(outside.status()).isEqualTo(Status.CHECK);
            assertThat(outside.reasons()).containsExactly(Reason.OUT_OF_TABLE);
        }

        @Test
        @DisplayName("QA-975 아래 끝이 없는 행은 위 끝의 계열만 다룸 — 30 계열이 패치됐으면 32 계열의 '32.9.1 미만' 행으로 해당이 되지 않음")
        void openLowerBoundStaysInItsFamily() {
            List<Row> node = rows("Node.js|30.4.1 미만|30.4.1 이상", "Node.js|32.9.1 미만|32.9.1 이상");
            Verdict v = judge(node, inventory(comp("frontend", "runtime", "node", "30.5.0")));
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(v.matches()).extracting(Match::otherFamily).containsExactly(false, true);
            // 같은 계열이면 아래 끝이 없어도 해당입니다.
            assertThat(judge(node, inventory(comp("frontend", "runtime", "node", "32.5.0"))).status()).isEqualTo(Status.AFFECTED);
            assertThat(judge(node, inventory(comp("frontend", "runtime", "node", "30.2.0"))).status()).isEqualTo(Status.AFFECTED);
            // 다른 계열의 열린 행만 있으면 그 계열을 다루는 행이 없는 것 — 확인 필요입니다.
            Verdict onlyOther = judge(rows("Node.js|32.9.1 미만|32.9.1 이상"), inventory(comp("frontend", "runtime", "node", "30.5.0")));
            assertThat(onlyOther.status()).isEqualTo(Status.CHECK);
            assertThat(onlyOther.reasons()).containsExactly(Reason.OUT_OF_TABLE);
        }

        @Test
        @DisplayName("QA-975 JDK — 다른 계열의 'B 이하' 행은 41.x를 해당으로 만들지 않음(41 계열 행의 해결 칸을 못 읽으면 확인 필요)")
        void openLowerBoundJdk() {
            List<Row> jdk = rows("OpenJDK|41.0.9 이하|벤더 보안 업데이트 적용", "OpenJDK|45.0.3 이하|벤더 보안 업데이트 적용",
                    "OpenJDK|47.0.1 이하|벤더 보안 업데이트 적용");
            Verdict v = judge(jdk, inventory(comp("backend", "runtime", "jdk", "41.0.9.1+2-LTS")));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.PARSE_FAILED);
            assertThat(v.matches()).extracting(Match::otherFamily).containsExactly(false, true, true);
            assertThat(judge(jdk, inventory(comp("backend", "runtime", "jdk", "41.0.8+7"))).status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("QA-976 Tomcat 꼴 'A-M5 이상 B 미만' — 해결 버전 이상이면 패치됨, 구간 안이면 해당")
        void milestoneLowerBound() {
            List<Row> tomcat = rows("Apache Tomcat|31.0.0-M5 이상 31.0.9 미만|31.0.9 이상",
                    "Apache Tomcat|30.1.0-M1 이상 30.1.50 미만|30.1.50 이상",
                    "Apache Tomcat|29.0.0.M1 이상 29.0.40 미만|29.0.40 이상");
            assertThat(judge(tomcat, inventory(comp("backend", "maven", "tomcat-embed-core", "31.0.9"))).status())
                    .isEqualTo(Status.PATCHED);
            assertThat(judge(tomcat, inventory(comp("backend", "maven", "tomcat-embed-core", "31.0.8"))).status())
                    .isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("해결 칸 나열 — 같은 계열의 해결 버전과 비교")
        void fixedList() {
            List<Row> r = rows("Node.js|30.0.0 이상 30.4.0 미만, 31.0.0 이상 31.2.0 미만|30.4.0, 31.2.0");
            assertThat(judge(r, inventory(comp("frontend", "runtime", "node", "v30.5.0"))).status()).isEqualTo(Status.PATCHED);
            assertThat(judge(r, inventory(comp("frontend", "runtime", "node", "v31.1.0"))).status()).isEqualTo(Status.AFFECTED);
            assertThat(judge(r, inventory(comp("frontend", "runtime", "node", "v32.0.0"))).reasons())
                    .containsExactly(Reason.OUT_OF_TABLE);
        }
    }

    // ---- 사유 여덟 ----

    @Nested
    @DisplayName("확인 필요 사유")
    class Reasons {

        @Test
        @DisplayName("PARSE_FAILED — 영향 칸을 못 읽음 / 같은 계열 구간 밖인데 해결 칸을 못 읽음 / 설치 버전을 못 읽음")
        void parseFailed() {
            Verdict affectedCell = judge(rows("PostgreSQL|16 이상 R9 미만|16.50 이상"), inventory(PG));
            assertThat(affectedCell.status()).isEqualTo(Status.CHECK);
            assertThat(affectedCell.reasons()).containsExactly(Reason.PARSE_FAILED);

            Verdict fixedCell = judge(rows("PostgreSQL|16.0.1|가짜 보안 패치 적용"), inventory(PG));
            assertThat(fixedCell.reasons()).containsExactly(Reason.PARSE_FAILED);

            Verdict installed = judge(rows("PostgreSQL|16 이상 16.50 미만|16.50 이상"),
                    inventory(comp("postgres", "runtime", "postgres", "16.42-fake")));
            assertThat(installed.reasons()).containsExactly(Reason.PARSE_FAILED);
        }

        @Test
        @DisplayName("해결 칸을 못 읽어도 설치 버전이 영향 구간 안이면 해당")
        void affectedDespiteFixedCell() {
            Verdict v = judge(rows("PostgreSQL|16.42|가짜 보안 패치 적용"), inventory(PG));
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("OUT_OF_TABLE — 위 계열 규칙 시험들")
        void outOfTable() {
            Verdict v = judge(rows("PostgreSQL|15 이상 15.70 미만|15.70 이상"), inventory(PG));
            assertThat(v.reasons()).containsExactly(Reason.OUT_OF_TABLE);
        }

        @Test
        @DisplayName("NO_INVENTORY — 버전 목록이 없음, 그 구역 실패, 호스트 구역 건너뜀(로컬)")
        void noInventory() {
            List<Row> r = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상");
            Verdict none = judge(r, null);
            assertThat(none.status()).isEqualTo(Status.CHECK);
            assertThat(none.reasons()).containsExactly(Reason.NO_INVENTORY);
            assertThat(none.matches()).singleElement().satisfies(m -> {
                assertThat(m.source()).isNull();
                assertThat(m.installedVersion()).isNull();
            });

            Verdict failed = judge(r, withSection(inventory(), "postgres", SectionStatus.FAILED));
            assertThat(failed.reasons()).containsExactly(Reason.NO_INVENTORY);
            assertThat(failed.matches()).singleElement().extracting(Match::source).isEqualTo("postgres");

            Verdict skipped = judge(rows("Tailscale|1.0 이상 1.900 미만|1.900 이상"),
                    withSection(inventory(), "host", SectionStatus.SKIPPED));
            assertThat(skipped.reasons()).containsExactly(Reason.NO_INVENTORY);

            // 구역 상태가 없는 목록에 패치된 구성 요소가 있어도 패치됨으로 두지 않음(그 구역을 다 모았는지 모름).
            Verdict missingKey = judge(r, new EnvInventory(Map.of(),
                    List.of(comp("postgres", "runtime", "postgres", "16.60")), List.of()));
            assertThat(missingKey.status()).isEqualTo(Status.CHECK);
            assertThat(missingKey.reasons()).containsExactly(Reason.NO_INVENTORY);
        }

        @Test
        @DisplayName("NO_INVENTORY — 판정은 가능한 쪽이 해당이면 해당이 이김(모은 구역의 구성 요소는 그대로 판정)")
        void partialInventory() {
            EnvInventory inv = withSection(inventory(PG), "backend", SectionStatus.FAILED);
            Verdict v = judge(rows("PostgreSQL|16 이상 16.50 미만|16.50 이상", "Oracle Java SE|21.0.0 이상 21.0.99 미만|21.0.99"), inv);
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(product(v, "jdk").reasons()).containsExactly(Reason.NO_INVENTORY);
        }

        @Test
        @DisplayName("VENDOR_DIFFERS — Oracle Java SE 공지는 Temurin 번호가 구간 안이어도 확인 필요, OpenJDK·Temurin 행은 번호로 판정")
        void vendorDiffers() {
            EnvInventory inv = inventory(comp("backend", "runtime", "jdk", "21.0.40+7"));
            Verdict oracle = judge(rows("Oracle Java SE|21.0.0 이상 21.0.50 미만|21.0.50"), inv);
            assertThat(oracle.status()).isEqualTo(Status.CHECK);
            assertThat(oracle.reasons()).containsExactly(Reason.VENDOR_DIFFERS);

            Verdict oracleOtherLine = judge(rows("Oracle Java SE|17.0.30|17.0.31"), inv);
            assertThat(oracleOtherLine.reasons()).containsExactly(Reason.VENDOR_DIFFERS);

            assertThat(judge(rows("OpenJDK|21.0.0 이상 21.0.50 미만|21.0.50"), inv).status()).isEqualTo(Status.AFFECTED);
            assertThat(judge(rows("Eclipse Temurin|21.0.0 이상 21.0.30 미만|21.0.30"), inv).status()).isEqualTo(Status.PATCHED);
            assertThat(judge(rows("Oracle JavaFX|21.0.40|21.0.41"), inv).status()).isEqualTo(Status.UNRELATED);
        }

        @Test
        @DisplayName("CONDITION_NOTE — 해당 + ※는 해당 그대로·'조건 문장 있음', 패치됨 + ※는 확인 필요, 무관 + ※는 무관")
        void conditionNote() {
            String note = "※ 영향받는 버전의 이전 버전도 영향이 있을 수 있음(가짜 조건 문장) [1]";
            List<Row> r = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상");

            Verdict affected = NoticeJudge.judge(tableNotice(note), r, inventory(PG));
            assertThat(affected.status()).isEqualTo(Status.AFFECTED);
            assertThat(affected.reasons()).containsExactly(Reason.CONDITION_NOTE);
            assertThat(affected.conditionNotes()).containsExactly("영향받는 버전의 이전 버전도 영향이 있을 수 있음(가짜 조건 문장) [1]");

            Verdict patched = NoticeJudge.judge(tableNotice(note), r, inventory(comp("postgres", "runtime", "postgres", "16.60")));
            assertThat(patched.status()).isEqualTo(Status.CHECK);
            assertThat(patched.reasons()).containsExactly(Reason.CONDITION_NOTE);

            Verdict unrelated = NoticeJudge.judge(tableNotice(note), rows("PHP 8.2|8.2.36 미만|8.2.36 이상"), inventory(PG));
            assertThat(unrelated.status()).isEqualTo(Status.UNRELATED);
            assertThat(unrelated.reasons()).isEmpty();
        }

        @Test
        @DisplayName("CONDITION_NOTE — 관용 문장('하단의 참고 사이트를 확인하여 업데이트 수행')·참고 번호만은 조건이 아님, 한 줄에 둘이면 나눠 봄")
        void boilerplateNotes() {
            List<Row> r = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상");
            EnvInventory inv = inventory(comp("postgres", "runtime", "postgres", "16.60"));
            Verdict v = NoticeJudge.judge(tableNotice("※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]~[25]", "※ [3][4]"), r, inv);
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(v.conditionNotes()).isEmpty();

            List<String> split = NoticeJudge.conditionNotes(List.of(
                    "※ 가짜 배포판은 배포판별 수정 버전 적용 [8] ※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]"));
            assertThat(split).containsExactly("가짜 배포판은 배포판별 수정 버전 적용 [8]");
        }

        @Test
        @DisplayName("NO_VERSION_TABLE — 표가 없는 공지의 제목·본문에 별칭이 나오면 확인 필요(설치돼 있을 때·모를 때)")
        void noVersionTable() {
            SecurityNotice notice = new SecurityNotice(2L, "가짜 보안 점검 안내", Template.NO_TABLE, List.of(),
                    "PostgreSQL에서 쓰는 설정을 점검하라는 가짜 본문");
            Verdict v = NoticeJudge.judge(notice, List.of(), inventory(PG));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.NO_VERSION_TABLE);

            Verdict unknown = NoticeJudge.judge(notice, List.of(), null);
            assertThat(unknown.reasons()).containsExactly(Reason.NO_INVENTORY, Reason.NO_VERSION_TABLE);

            SecurityNotice other = new SecurityNotice(3L, "가짜 안내", Template.OTHER_TABLE, List.of(), "Caddy 설정 안내");
            assertThat(NoticeJudge.judge(other, List.of(), inventory(PG)).status()).isEqualTo(Status.UNRELATED);

            SecurityNotice overlap = new SecurityNotice(4L, "가짜 안내", Template.NO_TABLE, List.of(), "pgAdmin과 Nextcloud 점검");
            assertThat(NoticeJudge.judge(overlap, List.of(), inventory(PG)).status()).isEqualTo(Status.UNRELATED);

            SecurityNotice nothing = new SecurityNotice(5L, "가짜 사고 대응 안내", Template.NO_TABLE, List.of("※ 가짜 신고 안내"),
                    "웹서버 점검");
            assertThat(NoticeJudge.judge(nothing, List.of(), inventory(PG)).status()).isEqualTo(Status.UNRELATED);
        }

        @Test
        @DisplayName("NAME_MATCH — 표에 없는 제품이 본문에만 나옴 / 상세 전 제목만 / 설치 버전을 번호와 견줄 수 없는 제품(runc)")
        void nameMatch() {
            SecurityNotice notice = new SecurityNotice(6L, "가짜 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "Node.js 기반 환경에서도 가짜 영향");
            Verdict bodyOnly = NoticeJudge.judge(notice, rows("PHP 8.2|8.2.36 미만|8.2.36 이상"),
                    inventory(comp("frontend", "runtime", "node", "v30.1.0")));
            assertThat(bodyOnly.status()).isEqualTo(Status.CHECK);
            assertThat(bodyOnly.reasons()).containsExactly(Reason.NAME_MATCH);

            SecurityNotice pending = new SecurityNotice(7L, "Tailscale 가짜 보안 업데이트 권고", null, List.of(), null);
            Verdict titleOnly = NoticeJudge.judge(pending, List.of(), inventory(comp("host", "runtime", "tailscale", "1.500.0")));
            assertThat(titleOnly.reasons()).containsExactly(Reason.NAME_MATCH);

            Verdict runc = judge(rows("runc|1.0.0 이상 1.9.9 미만|1.9.9"),
                    inventory(pkg("host", "dpkg", "containerd.io", "9.9.9-1~fake", null)));
            assertThat(runc.status()).isEqualTo(Status.CHECK);
            assertThat(runc.reasons()).containsExactly(Reason.NAME_MATCH);
        }

        @Test
        @DisplayName("QA-977 데이터베이스의 Node.js 드라이버 공지는 Node.js 런타임과 무관 — 표 제품명·본문 모두")
        void nodeDriverIsNotNodeRuntime() {
            SecurityNotice notice = new SecurityNotice(9L, "가짜 DB 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "o Node.js Driver에서 발생하는 가짜 취약점");
            Verdict v = NoticeJudge.judge(notice, rows("Node.js Driver|7.0.0 이상 9.8.0 미만|9.8.0 이상"),
                    inventory(comp("frontend", "runtime", "node", "v30.1.0")));
            assertThat(v.status()).isEqualTo(Status.UNRELATED);
            assertThat(v.products()).isEmpty();
        }

        @Test
        @DisplayName("QA-978 Windows 전용 제품은 서버 별칭에 맞지 않음 — 표 없는 정기 업데이트 공지의 본문·표 행 모두, Linux가 함께 적힌 행은 맞음")
        void windowsOnlyNames() {
            EnvInventory inv = inventory(pkg("host", "dpkg", "openssh-server", "1:9.9p9-9fake1", "openssh"),
                    comp("host", "runtime", "tailscale", "1.500.0"));
            // 정기 업데이트 공지 꼴(표 없음) — 본문에 '<제품> for Windows <CVE> <제조사> <제품> for Windows <취약점 종류>' 줄이 이어짐(합성 글).
            SecurityNotice monthly = new SecurityNotice(10L, "가짜 제조사 정기 보안 업데이트 권고", Template.NO_TABLE, List.of(),
                    "o 가짜 제조사 정기 업데이트\nOpenSSH for Windows CVE-2099-0001 Microsoft OpenSSH for Windows 권한 상승 취약성\n"
                            + "Win32-OpenSSH CVE-2099-0002 가짜 서비스 거부 취약성");
            Verdict v = NoticeJudge.judge(monthly, List.of(), inv);
            assertThat(v.status()).isEqualTo(Status.UNRELATED);
            assertThat(v.products()).isEmpty();

            Verdict rowsWindows = judge(rows("OpenSSH for Windows|9.0 이상 9.9 미만|9.9", "Windows용 OpenSSH|9.0 이상 9.9 미만|9.9",
                    "Tailscale (Windows)|1.0 이상 1.900 미만|1.900"), inv);
            assertThat(rowsWindows.status()).isEqualTo(Status.UNRELATED);
            assertThat(rowsWindows.products()).isEmpty();

            Verdict withLinux = judge(rows("Tailscale Full Client (Windows, Linux, macOS)|1.0 이상 1.900 미만|1.900"), inv);
            assertThat(withLinux.status()).isEqualTo(Status.AFFECTED);
            assertThat(product(withLinux, "tailscale").status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("QA-980 본문의 참고 주소(URL)는 이름 맞춤에 쓰지 않음 — 커널 공지의 'git.kernel.org/…/vulns.git'이 Git 별칭에 맞지 않음")
        void urlsAreNotMentions() {
            EnvInventory inv = inventory(pkg("host", "dpkg", "git", "1:99.1.0-0ppa1~fake1", "git"));
            SecurityNotice kernel = new SecurityNotice(11L, "가짜 커널 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "o 가짜 커널 취약점 [1]\n□ 참고사이트\n[1] https://git.example.invalid/pub/scm/fake/vulns.git/tree/cve/CVE-2099-0003.json");
            Verdict v = NoticeJudge.judge(kernel, rows("Linux Kernel|9.0 이상 9.9 미만|9.9"), inv);
            assertThat(v.products()).extracting(ProductVerdict::aliasId).doesNotContain("git");

            SecurityNotice plain = new SecurityNotice(12L, "가짜 점검 안내", Template.NO_TABLE, List.of(), "Git 저장소 설정을 점검하라는 가짜 본문");
            assertThat(NoticeJudge.judge(plain, List.of(), inv).products()).extracting(ProductVerdict::aliasId).as("주소 밖의 이름은 그대로 맞음")
                    .contains("git");
        }

        @Test
        @DisplayName("QA-981 낱말 풀이 ※ 문장('약어(풀이) : 설명')은 조건 문장이 아님 — 조건 문장은 그대로 셈")
        void glossaryNotes() {
            List<String> notes = NoticeJudge.conditionNotes(List.of(
                    "※ FPM(Fake Package Manager) : 가짜 응용 프로그램을 설치하고 올리는 가짜 패키지 관리 도구",
                    "※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"));
            assertThat(notes).containsExactly("가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)");

            List<Row> r = rows("PostgreSQL|16 이상 16.50 미만|16.50 이상");
            Verdict v = NoticeJudge.judge(tableNotice("※ PG(Fake Postgres) : 가짜 데이터베이스 설명", "※ 하단의 참고 사이트를 확인하여 업데이트 수행 [1]"),
                    r, inventory(comp("postgres", "runtime", "postgres", "16.60")));
            assertThat(v.status()).isEqualTo(Status.PATCHED);
        }

        @Test
        @DisplayName("이름 맞춤에서 빼는 ※ 문장(덧붙임 2026-11-22) — 영향 없음 문장·Windows 전용 문장, 영향 받음·완화 조치·Linux 병기·제외가 섞이면 그대로")
        void excludedNotes() {
            assertThat(NoticeJudge.excludedNote(" 가짜 glibc 기반 배포판과 가짜 환경은 영향 없음 [2]")).isTrue();
            assertThat(NoticeJudge.excludedNote(" 가짜 2.0 이후 판은 해당되지 않음")).isTrue();
            assertThat(NoticeJudge.excludedNote(" 가짜 2.0 이후 판은 영향을 받지 않음")).isTrue();
            assertThat(NoticeJudge.excludedNote(" 가짜 1.0 이전은 영향 없음, 가짜 2.0은 영향을 받음")).as("영향 받음이 섞임").isFalse();
            assertThat(NoticeJudge.excludedNote(" 가짜 모듈을 비활성화하면 영향 없음")).as("완화 조치").isFalse();
            assertThat(NoticeJudge.excludedNote(" 가짜 예제 폴더는 지우더라도(삭제) 가짜 서비스 동작에는 영향 없음")).as("운영 안내").isFalse();
            assertThat(NoticeJudge.excludedNote(" Windows용 가짜 PHP에서 cURL 압축 풀기를 켠 경우 영향을 받을 수 있음 [3]")).isTrue();
            assertThat(NoticeJudge.excludedNote(" 윈도우 가짜 클라이언트만 해당")).isTrue();
            assertThat(NoticeJudge.excludedNote(" Windows 및 Linux용 가짜 클라이언트에서 cURL을 쓰는 경우 영향")).as("Linux 병기").isFalse();
            assertThat(NoticeJudge.excludedNote(" Windows를 제외한 가짜 플랫폼에서 영향")).as("제외").isFalse();
            assertThat(NoticeJudge.excludedNote(" 가짜 설정을 켠 경우에만 영향")).isFalse();

            EnvInventory inv = inventory(pkg("host", "dpkg", "libc6", "9.39-0fake1", "glibc"), pkg("host", "dpkg", "curl", "9.5.0-2fake1", "curl"));
            SecurityNotice excluded = new SecurityNotice(13L, "가짜 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "o 가짜 제품 개요\n※ 가짜 glibc 기반 배포판은 영향 없음\n※ Windows용 가짜 PHP에서 cURL 압축 풀기를 켠 경우 영향 [3]");
            assertThat(NoticeJudge.judge(excluded, rows("가짜 제품|9.0 이상 9.9 미만|9.9"), inv).products()).isEmpty();

            SecurityNotice sameLine = new SecurityNotice(14L, "가짜 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "※ 가짜 glibc 기반 배포판은 영향 없음 ※ 가짜 curl 압축 풀기를 켠 경우 영향");
            assertThat(NoticeJudge.judge(sameLine, rows("가짜 제품|9.0 이상 9.9 미만|9.9"), inv).products())
                    .extracting(ProductVerdict::aliasId).as("한 줄의 ※ 문장마다 따로 봄").containsExactly("curl");

            SecurityNotice outside = new SecurityNotice(15L, "가짜 제품 보안 업데이트 권고", Template.PRODUCT_TABLE, List.of(),
                    "o 가짜 glibc 취약점 개요 — 가짜 환경은 영향 없음\n※ Windows용 가짜 PHP에서 cURL 압축 풀기를 켠 경우 영향");
            Verdict v = NoticeJudge.judge(outside, rows("가짜 제품|9.0 이상 9.9 미만|9.9"), inv);
            assertThat(v.products()).extracting(ProductVerdict::aliasId).as("※ 밖의 글은 그대로 셈").containsExactly("glibc");
            assertThat(v.reasons()).containsExactly(Reason.NAME_MATCH);
        }
    }

    // ---- 배포판 ----

    @Nested
    @DisplayName("배포판 패키지 — apt 보류(보안) 목록으로 판정")
    class Distro {

        private final Component hostSsl = pkg("host", "dpkg", "libssl9t64", "9.9.9-0fake1.1", "openssl");
        private final Component hostSslBin = pkg("host", "dpkg", "openssl", "9.9.9-0fake1.1", "openssl");
        private final List<Row> sslRows = rows("OpenSSL|9.9.0 이상 9.9.20 미만|9.9.20");

        @Test
        @DisplayName("호스트 패키지가 보안 보류 목록에 있으면 해당(버전 표와 비교하지 않음)")
        void pendingSecurity() {
            EnvInventory inv = inventory(List.of(new Pending("libssl9t64", "9.9.9-0fake1.1", "9.9.9-0fake1.2", true)),
                    hostSsl, hostSslBin);
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(v.matches()).extracting(Match::rowIndex).containsOnlyNulls();
        }

        @Test
        @DisplayName("보안이 아닌 보류·보류 없음은 DISTRO_NO_PENDING — 패치됨으로 두지 않음")
        void noPending() {
            EnvInventory notSecurity = inventory(List.of(new Pending("libssl9t64", "a", "b", false)), hostSsl);
            Verdict v = judge(sslRows, notSecurity);
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(judge(sslRows, inventory(hostSsl)).reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("컨테이너 안 apk·dpkg는 보류 목록이 없어 늘 DISTRO_NO_PENDING(호스트 보류 목록과 이름이 같아도)")
        void containerPackages() {
            Component apk = pkg("caddy", "apk", "libssl9t64", "9.9.9-r0", "openssl");
            EnvInventory inv = inventory(List.of(new Pending("libssl9t64", "a", "b", true)), apk);
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("호스트 구역을 모으지 못했으면 NO_INVENTORY, 컨테이너 쪽은 그대로 DISTRO_NO_PENDING")
        void hostFailed() {
            Component apk = pkg("caddy", "apk", "libcrypto9", "9.9.9-r0", "openssl");
            Verdict v = judge(sslRows, withSection(inventory(apk), "host", SectionStatus.FAILED));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactlyInAnyOrder(Reason.NO_INVENTORY, Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("커널 — 실행 중인 커널 버전은 비교하지 않고, 커널 메타 패키지가 보안 보류면 해당")
        void kernel() {
            Component running = comp("host", "runtime", "kernel", "9.9.0-1-fake");
            Component meta = pkg("host", "dpkg", "linux-generic", "9.9.0.1.1", "linux-meta");
            assertThat(judge(rows("Linux Kernel|9.0 이상 9.9.5 미만|9.9.5"), inventory(running, meta)).reasons())
                    .containsExactly(Reason.DISTRO_NO_PENDING);
            EnvInventory pending = inventory(List.of(new Pending("linux-generic", "a", "b", true)), running, meta);
            assertThat(judge(rows("Linux Kernel|9.0 이상 9.9.5 미만|9.9.5"), pending).status()).isEqualTo(Status.AFFECTED);
        }

        // ---- 변경 기록(ADR 0046 덧붙임 2026-11-21) ----

        private final List<Row> sslTwoCves = List.of(
                new Row(0, "CVE-2099-0001", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"),
                new Row(1, "cve-2099-0002, CVE-2099-0003", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));

        @Test
        @DisplayName("변경 기록 — 그 제품 행의 CVE가 원본·버전의 변경 기록에 모두 있으면 패치됨(근거 CHANGELOG), 하나라도 없으면 확인 필요")
        void changelogPatched() {
            EnvInventory all = withChangelog(inventory(hostSsl, hostSslBin), "openssl", "9.9.9-0fake1.1",
                    "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003", "CVE-2099-0999");
            Verdict v = judge(sslTwoCves, all);
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(v.reasons()).isEmpty();
            assertThat(v.matches()).extracting(Match::basis).containsOnly(Basis.CHANGELOG);
            assertThat(v.matches()).extracting(Match::component).containsExactly("libssl9t64", "openssl");

            EnvInventory partial = withChangelog(inventory(hostSsl), "openssl", "9.9.9-0fake1.1", "CVE-2099-0001", "CVE-2099-0002");
            Verdict missing = judge(sslTwoCves, partial);
            assertThat(missing.status()).isEqualTo(Status.CHECK);
            assertThat(missing.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(missing.matches()).extracting(Match::basis).containsOnlyNulls();

            EnvInventory otherVersion = withChangelog(inventory(hostSsl), "openssl", "9.9.9-0fake1.0",
                    "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            assertThat(judge(sslTwoCves, otherVersion).reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("변경 기록 — 보안 보류가 먼저(해당), CVE를 읽지 못한 행이 있으면·컨테이너 안 패키지면 변경 기록을 쓰지 않음")
        void changelogLimits() {
            EnvInventory pending = withChangelog(inventory(List.of(new Pending("libssl9t64", "a", "b", true)), hostSsl), "openssl",
                    "9.9.9-0fake1.1", "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            assertThat(judge(sslTwoCves, pending).status()).isEqualTo(Status.AFFECTED);

            List<Row> noCve = List.of(new Row(0, "CVE-2099-0001", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"),
                    new Row(1, "-", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
            EnvInventory known = withChangelog(inventory(hostSsl), "openssl", "9.9.9-0fake1.1", "CVE-2099-0001");
            assertThat(judge(noCve, known).reasons()).containsExactly(Reason.DISTRO_NO_PENDING);

            Component apk = pkg("caddy", "apk", "libssl9t64", "9.9.9-0fake1.1", "openssl");
            EnvInventory container = withChangelog(inventory(apk), "openssl", "9.9.9-0fake1.1",
                    "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            assertThat(judge(sslTwoCves, container).reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("변경 기록 — 배포판 근거로 패치됨이면 표 밖 조건 문장이 있어도 패치됨(문장은 그대로 냄, 덧붙임 2026-11-22), "
                + "운영체제 업데이트 안내 문장은 조건이 아님")
        void changelogWithNotes() {
            EnvInventory inv = withChangelog(inventory(hostSsl), "openssl", "9.9.9-0fake1.1",
                    "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            Verdict condition = NoticeJudge.judge(tableNotice("※ 가짜 설정을 켠 경우에만 영향"), sslTwoCves, inv);
            assertThat(condition.status()).isEqualTo(Status.PATCHED);
            assertThat(condition.reasons()).isEmpty();
            assertThat(product(condition, "openssl").reasons()).isEmpty();
            assertThat(condition.conditionNotes()).containsExactly("가짜 설정을 켠 경우에만 영향");
            assertThat(condition.matches()).extracting(Match::basis).containsOnly(Basis.CHANGELOG);

            // 배포판 근거로 모르는 것(변경 기록에 없는 CVE)은 지금처럼 확인 필요 + 조건 문장 있음.
            EnvInventory partial = withChangelog(inventory(hostSsl), "openssl", "9.9.9-0fake1.1", "CVE-2099-0001");
            Verdict unknown = NoticeJudge.judge(tableNotice("※ 가짜 설정을 켠 경우에만 영향"), sslTwoCves, partial);
            assertThat(unknown.status()).isEqualTo(Status.CHECK);
            assertThat(unknown.reasons()).containsExactly(Reason.DISTRO_NO_PENDING, Reason.CONDITION_NOTE);

            Verdict guide = NoticeJudge.judge(tableNotice("※ 보안 업데이트가 공개된 운영체제를 운영하고 있을 경우, 참고 사이트의 내용을 참조하여 "
                    + "보안 조치 또는 업데이트 수행(각 OS별 보안 업데이트 상세 버전은 아래 링크 참고) [2]"), sslTwoCves, inv);
            assertThat(guide.status()).isEqualTo(Status.PATCHED);
            assertThat(guide.conditionNotes()).isEmpty();
        }

        @Test
        @DisplayName("커널 — 실행 중인 커널이 있으면 그 변경 기록(kernel·uname)만 판정, 옛 판·서명·메타 패키지는 보안 보류일 때만 근거")
        void kernelRunningOnly() {
            Component running = comp("host", "runtime", "kernel", "9.9.0-3-fake");
            Component image = pkg("host", "dpkg", "linux-image-9.9.0-3-fake", "9.9.0-3.3", "linux-signed");
            Component modules = pkg("host", "dpkg", "linux-modules-9.9.0-3-fake", "9.9.0-3.3", "linux");
            Component old = pkg("host", "dpkg", "linux-modules-9.9.0-1-fake", "9.9.0-1.1", "linux");
            Component meta = pkg("host", "dpkg", "linux-generic", "9.9.0.3.3", "linux-meta");
            List<Row> kernelRows = List.of(new Row(0, "CVE-2099-7777", "Linux Kernel", "9.0 이상 9.9.5 미만", "9.9.5"));

            EnvInventory patched = withChangelog(inventory(running, image, modules, old, meta), "kernel", "9.9.0-3-fake",
                    "CVE-2099-7777");
            Verdict v = judge(kernelRows, patched);
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(v.matches()).extracting(Match::component).containsExactly("kernel");
            assertThat(v.matches()).extracting(Match::basis).containsExactly(Basis.CHANGELOG);

            Verdict notInLog = judge(kernelRows, withChangelog(inventory(running, image, modules, old, meta), "kernel", "9.9.0-3-fake",
                    "CVE-2099-0001"));
            assertThat(notInLog.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(notInLog.matches()).extracting(Match::component).containsExactly("kernel");

            EnvInventory metaPending = withChangelog(inventory(List.of(new Pending("linux-generic", "a", "b", true)), running, image,
                    modules, old, meta), "kernel", "9.9.0-3-fake", "CVE-2099-7777");
            Verdict affected = judge(kernelRows, metaPending);
            assertThat(affected.status()).isEqualTo(Status.AFFECTED);
            assertThat(affected.matches()).extracting(Match::component).containsExactly("kernel", "linux-generic");

            // 실행 중인 커널 줄이 없으면 패키지마다(예전 방식) — 서명·메타 패키지에는 변경 기록 CVE가 없어 확인 필요가 남음.
            EnvInventory noRunning = withChangelog(inventory(modules, meta), "linux", "9.9.0-3.3", "CVE-2099-7777");
            Verdict perPackage = judge(kernelRows, noRunning);
            assertThat(perPackage.status()).isEqualTo(Status.CHECK);
            assertThat(perPackage.matches()).extracting(Match::status).containsExactly(Status.PATCHED, Status.CHECK);
        }

        @Test
        @DisplayName("QA-979 APT — 'APT (Ubuntu)' 표 행은 배포판 패키지 apt로 판정, 한국어 'APT 공격' 본문은 맞지 않음")
        void aptRows() {
            Component apt = pkg("host", "dpkg", "apt", "9.8.4fake1", "apt");
            Component lib = pkg("host", "dpkg", "libapt-pkg9.9", "9.8.4fake1", "apt");
            List<Row> aptRows = rows("APT (Ubuntu)|9.8.0 이상 9.8.4fakeubuntu0.1 미만|9.8.4fakeubuntu0.1");
            Verdict v = judge(aptRows, inventory(apt, lib));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(product(v, "apt").reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(v.matches()).extracting(Match::component).containsExactly("apt", "libapt-pkg9.9");
            EnvInventory pending = inventory(List.of(new Pending("apt", "a", "b", true)), apt, lib);
            assertThat(judge(aptRows, pending).status()).isEqualTo(Status.AFFECTED);

            SecurityNotice korean = new SecurityNotice(11L, "가짜 APT 공격 주의 권고", Template.NO_TABLE, List.of(),
                    "가짜 APT 공격 그룹이 가짜 악성코드를 유포");
            Verdict k = NoticeJudge.judge(korean, List.of(), inventory(apt, lib));
            assertThat(k.status()).isEqualTo(Status.UNRELATED);
            assertThat(k.products()).isEmpty();
        }

        @Test
        @DisplayName("QA-979 Git — PPA 판은 상류 판으로 공지 표와 견주고(설치 판은 원문 그대로 근거에), 배포판 판은 배포판 경로(보류·변경 기록)")
        void gitPpaAndDistro() {
            List<Row> gitRows = rows("Git|9.56.1 미만|9.56.1", "Git|9.55.0 이상 9.55.4 미만|9.55.4");
            Verdict patched = judge(gitRows, inventory(pkg("host", "dpkg", "git", "1:9.56.1-0ppa1~ubuntu99.04.1", "git")));
            assertThat(patched.status()).isEqualTo(Status.PATCHED);
            assertThat(patched.matches()).extracting(Match::otherFamily).containsExactly(false, true);
            assertThat(patched.matches().get(0).installedVersion()).isEqualTo("1:9.56.1-0ppa1~ubuntu99.04.1");
            assertThat(judge(gitRows, inventory(pkg("host", "dpkg", "git", "1:9.56.0-0ppa1~ubuntu99.04.1", "git"))).status())
                    .isEqualTo(Status.AFFECTED);

            Component distroGit = pkg("host", "dpkg", "git", "1:9.43.0-1fakeubuntu7.3", "git");
            Verdict distro = judge(gitRows, inventory(distroGit));
            assertThat(distro.status()).isEqualTo(Status.CHECK);
            assertThat(distro.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(distro.matches()).extracting(Match::rowIndex).containsOnlyNulls();
            assertThat(judge(gitRows, inventory(List.of(new Pending("git", "a", "b", true)), distroGit)).status())
                    .isEqualTo(Status.AFFECTED);
            assertThat(judge(gitRows, withChangelog(inventory(distroGit), "git", "1:9.43.0-1fakeubuntu7.3", "CVE-2099-1000",
                    "CVE-2099-1001")).status()).isEqualTo(Status.PATCHED);
        }

        @Test
        @DisplayName("조건 문장 예외(덧붙임 2026-11-22) — 같은 Git 별칭이라도 배포판 판(변경 기록)은 패치됨 그대로, PPA 판(상류 번호)은 확인 필요로 내림")
        void conditionNoteNeedsDistroBasis() {
            List<Row> gitRows = rows("Git|9.56.1 미만|9.56.1", "Git|9.55.0 이상 9.55.4 미만|9.55.4");
            SecurityNotice noted = tableNotice("※ 가짜 설정을 켠 경우에만 영향");

            Component distroGit = pkg("host", "dpkg", "git", "1:9.43.0-1fakeubuntu7.3", "git");
            Verdict distro = NoticeJudge.judge(noted, gitRows, withChangelog(inventory(distroGit), "git", "1:9.43.0-1fakeubuntu7.3",
                    "CVE-2099-1000", "CVE-2099-1001"));
            assertThat(distro.status()).isEqualTo(Status.PATCHED);
            assertThat(distro.reasons()).isEmpty();

            Verdict ppa = NoticeJudge.judge(noted, gitRows, inventory(pkg("host", "dpkg", "git", "1:9.56.1-0ppa1~ubuntu99.04.1", "git")));
            assertThat(ppa.status()).isEqualTo(Status.CHECK);
            assertThat(ppa.reasons()).containsExactly(Reason.CONDITION_NOTE);
        }

        @Test
        @DisplayName("QA-979 Brotli — dpkg·apk 원본 brotli를 배포판 패키지로 판정, brotlicffi 행은 무관")
        void brotli() {
            Component deb = pkg("collector", "dpkg", "libbrotli1", "9.1.0-2fake1", "brotli");
            Component alp = pkg("caddy", "apk", "brotli-libs", "9.1.0-r0", "brotli");
            Verdict v = judge(rows("Brotli|9.1.1 미만|9.1.1"), inventory(deb, alp));
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(product(v, "brotli").reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(v.matches()).extracting(Match::component).containsExactly("libbrotli1", "brotli-libs");

            assertThat(judge(rows("brotlicffi|9.0 이상 9.1 미만|9.1"), inventory(deb, alp)).status()).isEqualTo(Status.UNRELATED);
        }

        @Test
        @DisplayName("행의 CVE 읽기 — 한 칸에 여럿·소문자도, 7자리를 넘는 번호는 아님, 하나도 없는 행이 있으면 빈 집합")
        void rowCves() {
            assertThat(NoticeJudge.rowCves(sslTwoCves)).containsExactly("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            assertThat(NoticeJudge.rowCves(List.of(new Row(0, "CVE-2099-12345678", "OpenSSL", "-", "-")))).isEmpty();
            assertThat(NoticeJudge.rowCves(List.of())).isEmpty();
        }
    }

    // ---- 배포판 보안 추적기(ADR 0046 덧붙임 2026-11-21) ----

    @Nested
    @DisplayName("배포판 보안 추적기 — 변경 기록에 없는 CVE를 그 구역 배포판·스위트·원본 패키지의 추적기 결과로")
    class Trackers {

        private static final String SUITE = "fakenoble";
        private final Component hostSsl = pkg("host", "dpkg", "libssl9t64", "9.9.9-0fake1.2", "openssl");
        private final List<Row> sslRows = List.of(
                new Row(0, "CVE-2099-0001", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"),
                new Row(1, "CVE-2099-0002, CVE-2099-0003", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));

        private EnvInventory ubuntuHost(Component... components) {
            return withOs(inventory(components), "host", "ubuntu", "99.04", SUITE);
        }

        private EnvInventory track(EnvInventory inv, String cve, TrackerStatus status, String fixed) {
            return withTracker(inv, "ubuntu", SUITE, "openssl", cve, status, fixed);
        }

        private Match only(Verdict v) {
            return v.matches().stream().filter(m -> m.aliasId().equals("openssl")).findFirst().orElseThrow();
        }

        @Test
        @DisplayName("덮임 — 고친 판 ≤ 설치 판이면 패치됨(근거 TRACKER), 추적기 근거에 CVE마다 상태·고친 판·확인 시각")
        void covered() {
            EnvInventory inv = ubuntuHost(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                inv = track(inv, cve, TrackerStatus.FIXED, "9.9.9-0fake1.1");
            }
            inv = track(inv, "CVE-2099-0003", TrackerStatus.FIXED, "9.9.9-0fake1.2");
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            Match m = only(v);
            assertThat(m.basis()).isEqualTo(Basis.TRACKER);
            assertThat(m.reason()).isNull();
            assertThat(m.tracker().distro()).isEqualTo("ubuntu");
            assertThat(m.tracker().suite()).isEqualTo(SUITE);
            assertThat(m.tracker().pkg()).isEqualTo("openssl");
            assertThat(m.tracker().cves()).extracting(TrackerCve::cve).containsExactly("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            assertThat(m.tracker().cves()).extracting(TrackerCve::status).containsOnly(TrackerStatus.FIXED);
            assertThat(m.tracker().cves().get(2).fixedVersion()).isEqualTo("9.9.9-0fake1.2");
            assertThat(m.tracker().cves().get(0).checkedAt()).isEqualTo(CHECKED);
        }

        @Test
        @DisplayName("조건 문장(덧붙임 2026-11-22) — 추적기·변경 기록으로 패치됨이면 ※ 문장이 있어도 패치됨, 뒤처짐(해당)은 해당 + '조건 문장 있음'")
        void conditionNotes() {
            SecurityNotice noted = tableNotice("※ 일부 제품은 버전 변경 없이 가짜 수정 코드를 백포트하였으므로 제조사별 내역 확인 [4]",
                    "※ 다른 가짜 운영체제용 가짜 제품에서 가짜 기능을 켠 경우 영향 [3]");
            EnvInventory inv = ubuntuHost(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                inv = track(inv, cve, TrackerStatus.FIXED, "9.9.9-0fake1.1");
            }
            Verdict patched = NoticeJudge.judge(noted, sslRows, inv);
            assertThat(patched.status()).isEqualTo(Status.PATCHED);
            assertThat(patched.reasons()).isEmpty();
            assertThat(patched.conditionNotes()).hasSize(2);

            // 컨테이너는 추적기, 호스트는 변경 기록 — 둘 다 배포판 근거라 패치됨.
            Component alp = pkg("caddy", "apk", "libssl9", "9.9.9-r1", "openssl");
            EnvInventory mixed = withChangelog(withOs(ubuntuHost(hostSsl, alp), "caddy", "alpine", "99.1.0", null), "openssl",
                    "9.9.9-0fake1.2", "CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003");
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                mixed = withTracker(mixed, "alpine", "v99.1", "openssl", cve, TrackerStatus.FIXED, "9.9.9-r0");
            }
            Verdict both = NoticeJudge.judge(noted, sslRows, mixed);
            assertThat(both.status()).isEqualTo(Status.PATCHED);
            assertThat(both.matches()).filteredOn(m -> m.aliasId().equals("openssl")).extracting(Match::basis)
                    .containsExactly(Basis.CHANGELOG, Basis.TRACKER);

            Verdict behind = NoticeJudge.judge(noted, sslRows, track(inv, "CVE-2099-0001", TrackerStatus.FIXED, "9.9.9-0fake1.3"));
            assertThat(behind.status()).isEqualTo(Status.AFFECTED);
            assertThat(behind.reasons()).containsExactly(Reason.CONDITION_NOTE);
        }

        @Test
        @DisplayName("뒤처짐 — 고친 판이 나왔는데 설치 판이 낮으면 해당(근거 TRACKER), 열림이 섞여도 해당")
        void behind() {
            EnvInventory inv = track(track(track(ubuntuHost(hostSsl), "CVE-2099-0001", TrackerStatus.FIXED, "9.9.9-0fake1.3"),
                    "CVE-2099-0002", TrackerStatus.OPEN, null), "CVE-2099-0003", TrackerStatus.FIXED, "9.9.9-0fake1.1");
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.AFFECTED);
            assertThat(v.reasons()).isEmpty();
            assertThat(only(v).basis()).isEqualTo(Basis.TRACKER);
            assertThat(only(v).status()).isEqualTo(Status.AFFECTED);
        }

        @Test
        @DisplayName("영향 없음 전부 — 무관(근거 TRACKER), 덮임과 섞이면 패치됨")
        void notAffected() {
            EnvInventory inv = ubuntuHost(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                inv = track(inv, cve, TrackerStatus.NOT_AFFECTED, null);
            }
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.UNRELATED);
            assertThat(product(v, "openssl").status()).isEqualTo(Status.UNRELATED);
            assertThat(only(v).basis()).isEqualTo(Basis.TRACKER);
            assertThat(only(v).tracker().cves()).extracting(TrackerCve::status).containsOnly(TrackerStatus.NOT_AFFECTED);

            Verdict mixed = judge(sslRows, track(inv, "CVE-2099-0002", TrackerStatus.FIXED, "9.9.9-0fake1.0"));
            assertThat(mixed.status()).isEqualTo(Status.PATCHED);
            assertThat(only(mixed).basis()).isEqualTo(Basis.TRACKER);
        }

        @Test
        @DisplayName("열림 — 뒤처짐이 없고 열림이 있으면 확인 필요 DISTRO_OPEN(사유 거르기에도)")
        void open() {
            EnvInventory inv = track(track(track(ubuntuHost(hostSsl), "CVE-2099-0001", TrackerStatus.FIXED, "9.9.9-0fake1.1"),
                    "CVE-2099-0002", TrackerStatus.OPEN, null), "CVE-2099-0003", TrackerStatus.UNKNOWN, null);
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.DISTRO_OPEN);
            assertThat(only(v).basis()).isNull();
            assertThat(only(v).tracker().cves()).extracting(TrackerCve::status)
                    .containsExactly(TrackerStatus.FIXED, TrackerStatus.OPEN, TrackerStatus.UNKNOWN);
            assertThat(only(v).tracker().cves().get(1).fixedVersion()).isNull();
        }

        @Test
        @DisplayName("모름 — 추적기에 기록 없음(unknown)·아직 묻지 않음(none)·고친 판을 견줄 수 없음은 확인 필요 DISTRO_NO_PENDING")
        void unknown() {
            EnvInventory inv = track(track(ubuntuHost(hostSsl), "CVE-2099-0001", TrackerStatus.FIXED, "9.9.9-0fake1.1"),
                    "CVE-2099-0002", TrackerStatus.UNKNOWN, null);
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.CHECK);
            assertThat(v.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(only(v).tracker().cves()).extracting(TrackerCve::status)
                    .containsExactly(TrackerStatus.FIXED, TrackerStatus.UNKNOWN, TrackerStatus.NONE);
            assertThat(only(v).tracker().cves().get(2).checkedAt()).isNull();

            EnvInventory badFixed = ubuntuHost(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                badFixed = track(badFixed, cve, TrackerStatus.FIXED, "판 아님");
            }
            assertThat(judge(sslRows, badFixed).reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
        }

        @Test
        @DisplayName("변경 기록과 섞임 — 변경 기록에 있는 CVE는 덮임(추적기 근거에 넣지 않음), 나머지는 추적기로. 모두 변경 기록이면 CHANGELOG·추적기 근거 없음")
        void mixedWithChangelog() {
            EnvInventory inv = withChangelog(ubuntuHost(hostSsl), "openssl", "9.9.9-0fake1.2", "CVE-2099-0001");
            inv = track(track(inv, "CVE-2099-0002", TrackerStatus.FIXED, "9.9.9-0fake1.1"), "CVE-2099-0003", TrackerStatus.NOT_AFFECTED, null);
            Verdict v = judge(sslRows, inv);
            assertThat(v.status()).isEqualTo(Status.PATCHED);
            assertThat(only(v).basis()).isEqualTo(Basis.TRACKER);
            assertThat(only(v).tracker().cves()).extracting(TrackerCve::cve).containsExactly("CVE-2099-0002", "CVE-2099-0003");

            EnvInventory all = withChangelog(ubuntuHost(hostSsl), "openssl", "9.9.9-0fake1.2", "CVE-2099-0001", "CVE-2099-0002",
                    "CVE-2099-0003");
            Verdict log = judge(sslRows, all);
            assertThat(log.status()).isEqualTo(Status.PATCHED);
            assertThat(only(log).basis()).isEqualTo(Basis.CHANGELOG);
            assertThat(only(log).tracker()).isNull();
        }

        @Test
        @DisplayName("보안 보류로 해당·CVE를 읽지 못한 행이 있으면 추적기를 쓰지 않음(추적기 근거 없음)")
        void pendingAndUnreadableRows() {
            EnvInventory inv = ubuntuHost(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                inv = track(inv, cve, TrackerStatus.NOT_AFFECTED, null);
            }
            EnvInventory pending = new EnvInventory(inv.sections(), inv.components(),
                    List.of(new Pending("libssl9t64", "a", "b", true)), inv.changelog(), inv.os(), inv.tracker());
            Verdict affected = judge(sslRows, pending);
            assertThat(affected.status()).isEqualTo(Status.AFFECTED);
            assertThat(only(affected).tracker()).isNull();
            assertThat(only(affected).basis()).isNull();

            List<Row> unreadable = List.of(sslRows.get(0), new Row(1, "-", "OpenSSL", "9.9.0 이상 9.9.20 미만", "9.9.20"));
            Verdict noCve = judge(unreadable, inv);
            assertThat(noCve.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(only(noCve).tracker()).isNull();
        }

        @Test
        @DisplayName("os 없음·추적기 밖 배포판·코드명 없음 — 추적기를 쓰지 않음(지금과 같이 DISTRO_NO_PENDING, 추적기 근거 없음)")
        void noOs() {
            EnvInventory noOs = inventory(hostSsl);
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                noOs = track(noOs, cve, TrackerStatus.NOT_AFFECTED, null);
            }
            Verdict v = judge(sslRows, noOs);
            assertThat(v.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(only(v).tracker()).isNull();

            assertThat(only(judge(sslRows, withOs(noOs, "host", "fedora", "99", null))).tracker()).isNull();
            assertThat(only(judge(sslRows, withOs(noOs, "host", "ubuntu", "99.04", null))).tracker()).isNull();
            assertThat(only(judge(sslRows, withOs(noOs, "host", "ubuntu", "99.04", "Fake Noble"))).tracker()).isNull();
        }

        @Test
        @DisplayName("실행 중인 커널 — 추적기 패키지 linux, 설치 판은 이름이 -<uname -r>로 끝나고 원본이 linux인 dpkg 패키지의 판")
        void runningKernel() {
            Component running = comp("host", "runtime", "kernel", "9.9.0-3-fake");
            Component image = pkg("host", "dpkg", "linux-image-9.9.0-3-fake", "9.9.0-3.9", "linux-signed");
            Component modules = pkg("host", "dpkg", "linux-modules-9.9.0-3-fake", "9.9.0-3.3", "linux");
            Component old = pkg("host", "dpkg", "linux-modules-9.9.0-1-fake", "9.9.0-1.1", "linux");
            List<Row> kernelRows = List.of(new Row(0, "CVE-2099-7777", "Linux Kernel", "9.0 이상 9.9.5 미만", "9.9.5"));
            EnvInventory inv = ubuntuHost(running, image, old, modules);
            assertThat(NoticeJudge.runningKernelPackage(running, inv)).contains("9.9.0-3.3");

            Verdict patched = judge(kernelRows, withTracker(inv, "ubuntu", SUITE, "linux", "CVE-2099-7777", TrackerStatus.FIXED, "9.9.0-3.3"));
            assertThat(patched.status()).isEqualTo(Status.PATCHED);
            assertThat(patched.matches()).singleElement().satisfies(m -> {
                assertThat(m.component()).isEqualTo("kernel");
                assertThat(m.basis()).isEqualTo(Basis.TRACKER);
                assertThat(m.tracker().pkg()).isEqualTo("linux");
            });
            Verdict behind = judge(kernelRows, withTracker(inv, "ubuntu", SUITE, "linux", "CVE-2099-7777", TrackerStatus.FIXED, "9.9.0-4.4"));
            assertThat(behind.status()).isEqualTo(Status.AFFECTED);

            // 실행 중인 판의 linux 원본 패키지가 없으면 고친 판과 견줄 수 없음 — 모름.
            EnvInventory noModules = ubuntuHost(running, image, old);
            assertThat(NoticeJudge.runningKernelPackage(running, noModules)).isEmpty();
            Verdict unknown = judge(kernelRows, withTracker(noModules, "ubuntu", SUITE, "linux", "CVE-2099-7777", TrackerStatus.FIXED,
                    "9.9.0-3.3"));
            assertThat(unknown.reasons()).containsExactly(Reason.DISTRO_NO_PENDING);
            assertThat(unknown.matches()).singleElement().satisfies(m -> assertThat(m.tracker().cves()).singleElement()
                    .satisfies(c -> assertThat(c.status()).isEqualTo(TrackerStatus.FIXED)));
            // 열림·영향 없음은 설치 판 없이도 씀.
            Verdict open = judge(kernelRows, withTracker(noModules, "ubuntu", SUITE, "linux", "CVE-2099-7777", TrackerStatus.OPEN, null));
            assertThat(open.reasons()).containsExactly(Reason.DISTRO_OPEN);
        }

        @Test
        @DisplayName("Alpine — 스위트는 v + VERSION_ID 앞 두 마디, apk 원본 패키지·apk 판 규칙으로 견줌")
        void alpine() {
            Component apk = pkg("caddy", "apk", "libssl9", "9.9.9-r1", "openssl");
            EnvInventory inv = withOs(inventory(apk), "caddy", "alpine", "3.99.4", null);
            EnvInventory behind = inv;
            EnvInventory patched = inv;
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                behind = withTracker(behind, "alpine", "v3.99", "openssl", cve, TrackerStatus.FIXED, "9.9.9-r2");
                patched = withTracker(patched, "alpine", "v3.99", "openssl", cve, TrackerStatus.FIXED, "9.9.9_rc1-r5");
            }
            assertThat(judge(sslRows, behind).status()).isEqualTo(Status.AFFECTED);
            Verdict p = judge(sslRows, patched);
            assertThat(p.status()).isEqualTo(Status.PATCHED);
            assertThat(only(p).tracker().suite()).isEqualTo("v3.99");

            assertThat(new OsRelease("alpine", "3.99.4", null).trackerSuite()).contains("v3.99");
            assertThat(new OsRelease("alpine", "3.99", null).trackerSuite()).contains("v3.99");
            assertThat(new OsRelease("alpine", "03.099.1", null).trackerSuite()).contains("v3.99");
            assertThat(new OsRelease("alpine", "3.99.0_alpha20990101", null).trackerSuite()).isEmpty();
            assertThat(new OsRelease("alpine", null, null).trackerSuite()).isEmpty();
            assertThat(new OsRelease("debian", "99", "fakeforky").trackerSuite()).contains("fakeforky");
            assertThat(new OsRelease("debian", "99", "fakeforky").trackerDistro()).contains("debian");
            assertThat(new OsRelease("fedora", "99", "x").trackerDistro()).isEmpty();
        }

        @Test
        @DisplayName("컨테이너 dpkg(Debian)도 추적기로 — 종류가 배포판과 맞지 않는 구성 요소(apk 구역에 dpkg 등)는 쓰지 않음")
        void containerDebian() {
            Component deb = pkg("collector", "dpkg", "libssl9", "9.9.9-1~fake13u1", "openssl");
            EnvInventory inv = withOs(inventory(deb), "collector", "debian", "99", "fakeforky");
            for (String cve : List.of("CVE-2099-0001", "CVE-2099-0002", "CVE-2099-0003")) {
                inv = withTracker(inv, "debian", "fakeforky", "openssl", cve, TrackerStatus.FIXED, "9.9.9-1~fake13u1");
            }
            assertThat(judge(sslRows, inv).status()).isEqualTo(Status.PATCHED);

            EnvInventory mismatch = withOs(inv, "collector", "alpine", "3.99.1", null);
            assertThat(only(judge(sslRows, mismatch)).tracker()).isNull();
        }
    }

    // ---- 모르는 것을 안전으로 두지 않음 ----

    @Test
    @DisplayName("모르는 것을 패치됨·무관으로 두지 않는다 — 맞는 제품이 있으면 어떤 깨진 입력이어도 해당 또는 확인 필요")
    void neverSafeWhenUnknown() {
        List<String> brokenCells = List.of("", "-", "R1 이상", "모든 버전, 1.0", "16.x.x", "알 수 없음");
        List<EnvInventory> inventories = new ArrayList<>();
        inventories.add(null);
        inventories.add(inventory(comp("postgres", "runtime", "postgres", "")));
        inventories.add(inventory(comp("postgres", "runtime", "postgres", "16.42-fake")));
        inventories.add(withSection(inventory(PG), "postgres", SectionStatus.FAILED));
        inventories.add(inventory(PG));
        for (String cell : brokenCells) {
            for (EnvInventory inv : inventories) {
                Verdict v = judge(rows("PostgreSQL|" + cell + "|" + cell), inv);
                assertThat(v.status()).as(cell + " / " + inv).isIn(Status.AFFECTED, Status.CHECK);
            }
        }
    }

    @Test
    @DisplayName("행이 비거나 null이어도 예외 없음, 상세 전 공지에 아무 이름도 없으면 무관")
    void emptyInputs() {
        SecurityNotice pending = new SecurityNotice(8L, "가짜 공지", null, null, null);
        assertThat(NoticeJudge.judge(pending, null, null).status()).isEqualTo(Status.UNRELATED);
        assertThat(NoticeJudge.judge(pending, List.of(), inventory()).status()).isEqualTo(Status.UNRELATED);
    }

    @Test
    @DisplayName("본문 틀·구역 상태 DB 값 읽기 — 모르는 구역 상태는 실패로")
    void dbValues() {
        assertThat(Template.fromDb("product_table")).contains(Template.PRODUCT_TABLE);
        assertThat(Template.fromDb("no_table")).contains(Template.NO_TABLE);
        assertThat(Template.fromDb("weird")).isEmpty();
        assertThat(SectionStatus.fromDb("ok")).isEqualTo(SectionStatus.OK);
        assertThat(SectionStatus.fromDb("skipped")).isEqualTo(SectionStatus.SKIPPED);
        assertThat(SectionStatus.fromDb("weird")).isEqualTo(SectionStatus.FAILED);
        assertThat(SectionStatus.fromDb(null)).isEqualTo(SectionStatus.FAILED);
        assertThat(Status.AFFECTED.code()).isEqualTo("affected");
    }
}
