package com.macrodash.feature.security;

import com.macrodash.feature.security.EnvInventory.Component;
import com.macrodash.feature.security.ProductAliases.Alias;
import com.macrodash.feature.security.ProductAliases.Family;
import com.macrodash.feature.security.ProductAliases.Kind;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** 별칭 표(ADR 0046 결정 6) — 공지 제품명 ↔ 이 스택의 구성 요소, 이름 겹침 제외, 제조사. 제품명은 짧은 사실 문자열, 버전은 가짜. */
class ProductAliasesTest {

    private static final ProductAliases ALIASES = ProductAliases.defaults();

    private static List<String> ids(String product) {
        return ALIASES.forProduct(product).stream().map(Alias::id).toList();
    }

    private static Alias alias(String id) {
        return ALIASES.byId(id).orElseThrow();
    }

    @ParameterizedTest(name = "{0} -> {1}")
    @CsvSource(delimiter = '|', value = {
            "PostgreSQL|postgresql",
            "PostgreSQL 17|postgresql",
            "PostgreSQL JDBC Driver|pgjdbc",
            "pgJDBC|pgjdbc",
            "Oracle Java SE|jdk",
            "Eclipse Temurin|jdk",
            "OpenJDK|jdk",
            "Node.js|node",
            "Node.js 24|node",
            "Next.js|nextjs",
            "React Server Components|react",
            "Python|python",
            "CPython|python",
            "Google Chrome|chrome",
            "Chrome|chrome",
            "Caddy|caddy",
            "Docker Engine|docker",
            "Docker Compose|compose",
            "containerd|containerd",
            "runc|runc",
            "Tailscale|tailscale",
            "Linux Kernel|linux-kernel",
            "리눅스 커널|linux-kernel",
            "OpenSSH|openssh",
            "Alpine Linux 3.99 (openssh)|openssh",
            "OpenSSL|openssl",
            "curl|curl",
            "libcurl|curl",
            "GNU C Library|glibc",
            "Sudo|sudo",
            "Spring Framework|spring-framework",
            "Spring Boot|spring-boot",
            "Spring Security|spring-security",
            "Apache Tomcat|tomcat",
            "Jackson Databind|jackson",
            "Logback|logback",
            "Bouncy Castle|bouncycastle",
            "SnakeYAML|snakeyaml",
            "Requests|requests",
            "Python Requests|requests",
            "urllib3|urllib3",
            "lxml|lxml",
            "FastAPI|fastapi",
            "Starlette|starlette"})
    @DisplayName("공지 제품명이 이 스택의 별칭 하나에만 맞는다")
    void matchesExactlyOne(String product, String id) {
        assertThat(ids(product)).containsExactly(id);
    }

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', value = {
            "pgAdmin 4",
            "pgAdmin 4 (PostgreSQL)",
            "Nextcloud Server",
            "Next Cloud",
            "NextAuth.js",
            "JavaScript",
            "Oracle JavaFX",
            "Oracle GraalVM for JDK",
            "Oracle GraalVM Enterprise Edition",
            "Java Card",
            "Node-RED",
            "React Native",
            "React Router",
            "Preact",
            "Chrome OS",
            "ChromeOS",
            "Chromebook",
            "Google Chrome for Android",
            "Docker Desktop",
            "Docker Hub",
            "pyOpenSSL",
            "curl_cffi",
            "curl-impersonate",
            "python-multipart",
            "Alpine Linux",
            "Red Hat Enterprise Linux",
            "Apache TomEE",
            "NGINX Open Source",
            "NGINX Plus",
            "PHP 8.2",
            "WebLogic Server",
            "VM VirtualBox",
            "PeopleSoft Enterprise PeopleTools"})
    @DisplayName("이름이 겹치는 다른 제품·쓰지 않는 제품은 어느 별칭에도 맞지 않는다")
    void overlapsExcluded(String product) {
        assertThat(ids(product)).isEmpty();
    }

    @Test
    @DisplayName("QA-977 Node.js 드라이버(데이터베이스 클라이언트)는 Node.js 런타임이 아님 — 표 제품명·본문 언급 모두")
    void nodeDriverIsNotNodeRuntime() {
        assertThat(ids("Node.js Driver")).isEmpty();
        assertThat(ids("MongoDB Node.js Driver")).isEmpty();
        assertThat(ids("Node.js 드라이버")).isEmpty();
        assertThat(alias("node").mentionedIn("o Node.js Driver에서 발생하는 가짜 취약점")).isFalse();
        assertThat(alias("node").mentionedIn("Node.js 런타임의 가짜 취약점")).isTrue();
    }

    @Test
    @DisplayName("QA-978 Windows 전용 제품명(Linux·Ubuntu·Debian이 함께 적히지 않은 것)은 어느 별칭에도 맞지 않음 — 표 제품명·본문 구절 모두")
    void windowsOnlyNames() {
        assertThat(ids("OpenSSH for Windows")).isEmpty();
        assertThat(ids("Microsoft OpenSSH")).isEmpty();
        assertThat(ids("Win32-OpenSSH")).isEmpty();
        assertThat(ids("Windows용 OpenSSH")).isEmpty();
        assertThat(ids("Node.js (Windows)")).isEmpty();
        assertThat(ids("Google Chrome for Windows")).isEmpty();
        // Linux·Ubuntu·Debian이 함께 적힌 행은 그대로 맞음.
        assertThat(ids("Tailscale Full Client (Windows, Linux, macOS)")).containsExactly("tailscale");
        assertThat(ids("Node.js (Windows, Linux)")).containsExactly("node");
        assertThat(ids("OpenSSH (Windows, Ubuntu)")).containsExactly("openssh");
        assertThat(ids("OpenSSH (Windows, 리눅스)")).containsExactly("openssh");

        Alias openssh = alias("openssh");
        assertThat(openssh.mentionedIn("OpenSSH for Windows CVE-2099-0001 Microsoft OpenSSH for Windows 권한 상승 취약성")).isFalse();
        assertThat(openssh.mentionedIn("Win32-OpenSSH 가짜 취약점")).isFalse();
        assertThat(openssh.mentionedIn("Microsoft OpenSSH 가짜 취약점")).isFalse();
        assertThat(openssh.mentionedIn("OpenSSH for Windows와 별개로 OpenSSH 서버의 가짜 취약점")).isTrue();
        // 겹침 제외가 먼저 — 'Docker Desktop for Windows'가 지워진 뒤 'Docker'만 남지 않음.
        assertThat(alias("docker").mentionedIn("Docker Desktop for Windows 가짜 취약점")).isFalse();
    }

    @Test
    @DisplayName("QA-979 APT(표 행만)·Brotli·Git 별칭 — 이름 겹침(한국어 'APT 공격'·GitLab·brotlicffi 등)은 맞지 않음")
    void aptBrotliGit() {
        assertThat(ids("APT")).containsExactly("apt");
        assertThat(ids("APT (Ubuntu)")).containsExactly("apt");
        assertThat(ids("APT(Debian)")).containsExactly("apt");
        assertThat(ids("Brotli")).containsExactly("brotli");
        assertThat(ids("Google Brotli")).containsExactly("brotli");
        assertThat(ids("Git")).containsExactly("git");
        assertThat(ids("Git (Ubuntu)")).containsExactly("git");
        for (String other : List.of("가짜 APT 그룹 도구", "brotlicffi", "brotlipy", "Python Brotli", "python-brotli", "GitLab Community Edition",
                "GitHub Enterprise Server", "Gitea", "Gitee", "GitKraken", "Git LFS", "git-lfs", "libgit2", "Gitblit", "GitOps 도구",
                "TortoiseGit", "Git Credential Manager", "go-git", "Git for Windows")) {
            assertThat(ids(other)).as(other).isEmpty();
        }

        // APT는 본문에서 찾지 않음(한국어 공지의 'APT 공격·APT 그룹'과 겹침).
        assertThat(alias("apt").mentionedIn("APT (Ubuntu) 가짜 취약점")).isFalse();
        assertThat(alias("apt").mentionedIn("가짜 APT 공격 그룹 주의")).isFalse();
        assertThat(alias("brotli").mentionedIn("Brotli 압축 라이브러리의 가짜 취약점")).isTrue();
        assertThat(alias("brotli").mentionedIn("brotlicffi 가짜 취약점")).isFalse();
        assertThat(alias("git").mentionedIn("Git 가짜 취약점")).isTrue();
        assertThat(alias("git").mentionedIn("GitLab과 GitHub 가짜 취약점")).isFalse();
        assertThat(alias("git").mentionedIn("Git LFS 가짜 취약점")).isFalse();

        assertThat(alias("apt").kind()).isEqualTo(Kind.DISTRO);
        assertThat(alias("brotli").kind()).isEqualTo(Kind.DISTRO);
        assertThat(alias("git").kind()).isEqualTo(Kind.UPSTREAM);
        assertThat(alias("git").family()).isEqualTo(Family.MINOR);
        assertThat(alias("apt").sections()).containsExactly("host", "collector", "browser");
        assertThat(alias("brotli").sections()).containsExactlyElementsOf(ProductAliases.ALL_SECTIONS);
        assertThat(alias("git").sections()).containsExactly("host");

        assertThat(alias("apt").matchesComponent(new Component("host", "dpkg", "apt", "9.8.4fake1", "apt"))).isTrue();
        assertThat(alias("apt").matchesComponent(new Component("collector", "dpkg", "libapt-pkg9.9", "9.8.4fake1", "apt"))).isTrue();
        assertThat(alias("apt").matchesComponent(new Component("caddy", "apk", "apt", "9.8.4-r0", null))).isFalse();
        assertThat(alias("brotli").matchesComponent(new Component("collector", "dpkg", "libbrotli1", "9.1.0-2fake1", "brotli"))).isTrue();
        assertThat(alias("brotli").matchesComponent(new Component("caddy", "apk", "brotli-libs", "9.1.0-r0", "brotli"))).isTrue();
        assertThat(alias("brotli").matchesComponent(new Component("collector", "pypi", "brotli", "9.1.0", null))).isFalse();
        assertThat(alias("git").matchesComponent(new Component("host", "dpkg", "git-man", "1:9.56.1-0ppa1~ubuntu99.04.1", "git"))).isTrue();
        assertThat(alias("git").matchesComponent(new Component("host", "dpkg", "libgit2-9.9", "9.9.0-1", "libgit2"))).isFalse();
    }

    @Test
    @DisplayName("Python 패키지 공지는 Python 런타임이 아니라 그 패키지 별칭")
    void pythonPackages() {
        assertThat(ids("Python urllib3")).containsExactly("urllib3");
        assertThat(ids("Python lxml")).containsExactly("lxml");
    }

    @Test
    @DisplayName("제조사 — Oracle Java SE·Corretto는 이 스택(Temurin)과 다름, OpenJDK·Temurin은 같거나 따지지 않음")
    void vendors() {
        Alias jdk = alias("jdk");
        assertThat(jdk.vendorDiffers(jdk.matchProduct("Oracle Java SE").orElseThrow())).isTrue();
        assertThat(jdk.vendorDiffers(jdk.matchProduct("Java SE").orElseThrow())).isTrue();
        assertThat(jdk.vendorDiffers(jdk.matchProduct("Amazon Corretto").orElseThrow())).isTrue();
        assertThat(jdk.vendorDiffers(jdk.matchProduct("Microsoft Build of OpenJDK").orElseThrow())).isTrue();
        assertThat(jdk.vendorDiffers(jdk.matchProduct("Eclipse Temurin").orElseThrow())).isFalse();
        assertThat(jdk.vendorDiffers(jdk.matchProduct("OpenJDK").orElseThrow())).isFalse();
        assertThat(alias("postgresql").vendorDiffers(alias("postgresql").matchProduct("PostgreSQL").orElseThrow())).isFalse();
    }

    @Test
    @DisplayName("제목·본문 찾기 — 한국어가 바로 붙어도 맞고, 겹치는 이름 구절은 지운 뒤 찾음, 흔한 낱말 별칭은 본문에서 찾지 않음")
    void mentions() {
        assertThat(alias("postgresql").mentionedIn("PostgreSQL에서 발생하는 취약점")).isTrue();
        assertThat(alias("postgresql").mentionedIn("pgAdmin에서 발생하는 취약점")).isFalse();
        assertThat(alias("jdk").mentionedIn("JavaScript 엔진 취약점")).isFalse();
        assertThat(alias("jdk").mentionedIn("JavaScript와 Java SE 취약점")).isTrue();
        assertThat(alias("jdk").mentionedIn("Oracle GraalVM for JDK 취약점")).isFalse();
        assertThat(alias("nextjs").mentionedIn("Nextcloud 보안 업데이트")).isFalse();
        assertThat(alias("docker").mentionedIn("Docker Desktop 보안 업데이트")).isFalse();
        assertThat(alias("docker").mentionedIn("Docker 엔진 보안 업데이트")).isTrue();
        assertThat(alias("linux-kernel").mentionedIn("Alpine Linux 보안 업데이트")).isFalse();
        assertThat(alias("sudo").mentionedIn("sudo apt update 명령으로 업데이트")).isFalse();
        assertThat(alias("requests").mentionedIn("HTTP Requests 처리 취약점")).isFalse();
        assertThat(alias("postgresql").mentionedIn(null)).isFalse();
    }

    @Test
    @DisplayName("구성 요소 열쇠 — 종류가 같고 이름·원본 패키지에 통째로 맞음, pypi는 PEP 503 정규화")
    void components() {
        Alias openssl = alias("openssl");
        assertThat(openssl.matchesComponent(new Component("host", "dpkg", "libssl9t64", "9.9.9-0fake1", "openssl"))).isTrue();
        assertThat(openssl.matchesComponent(new Component("caddy", "apk", "libcrypto9", "9.9.9-r0", "openssl"))).isTrue();
        assertThat(openssl.matchesComponent(new Component("collector", "pypi", "pyopenssl", "99.0.0", null))).isFalse();
        assertThat(openssl.matchesComponent(new Component("host", "dpkg", "openssl-provider-legacy", "9.9.9", "openssl-extra")))
                .isFalse();
        assertThat(alias("postgresql").matchesComponent(new Component("postgres", "runtime", "postgres", "99.1", null))).isTrue();
        assertThat(alias("postgresql").matchesComponent(new Component("backend", "maven", "postgresql", "99.1.0", null))).isFalse();
        assertThat(alias("pgjdbc").matchesComponent(new Component("backend", "maven", "postgresql", "99.1.0", null))).isTrue();
        assertThat(alias("requests").matchesComponent(new Component("collector", "pypi", "Requests", "99.0", null))).isTrue();
        assertThat(alias("fastapi").matchesComponent(new Component("collector", "pypi", "FastAPI", "99.0", null))).isTrue();
        assertThat(alias("nextjs").matchesComponent(new Component("frontend", "npm", "next", "99.0.0", null))).isTrue();
        assertThat(alias("nextjs").matchesComponent(new Component("frontend", "npm", "@next/env", "99.0.0", null))).isFalse();
        assertThat(alias("react").matchesComponent(new Component("frontend", "npm", "react-dom", "99.0.0", null))).isTrue();
        assertThat(alias("linux-kernel").matchesComponent(new Component("host", "dpkg", "linux-generic", "9.9", "linux-meta")))
                .isTrue();
    }

    @Test
    @DisplayName("처음 별칭 표 — id가 겹치지 않고, 모두 이름·구성 요소·구역이 있으며, 배포판은 SINGLE, 구역은 정한 일곱 가운데")
    void defaultsWellFormed() {
        Set<String> ids = new HashSet<>();
        for (Alias a : ALIASES.aliases()) {
            assertThat(ids.add(a.id())).as(a.id()).isTrue();
            assertThat(a.names()).as(a.id()).isNotEmpty();
            assertThat(a.components()).as(a.id()).isNotEmpty();
            assertThat(a.sections()).as(a.id()).isNotEmpty();
            assertThat(ProductAliases.ALL_SECTIONS).as(a.id()).containsAll(a.sections());
            if (a.kind() == Kind.DISTRO) {
                assertThat(a.family()).as(a.id()).isEqualTo(Family.SINGLE);
            }
        }
    }

    @Test
    @DisplayName("처음 별칭 표가 이 스택을 덮는다 — postgres·JDK·Node·Next.js·React·Python(과 패키지)·Chrome·Caddy·OpenSSH·OpenSSL·Docker·Tailscale·커널")
    void coversStack() {
        assertThat(ALIASES.aliases()).extracting(Alias::id).contains("postgresql", "jdk", "node", "nextjs", "react", "python",
                "requests", "urllib3", "chrome", "caddy", "openssh", "openssl", "docker", "compose", "tailscale", "linux-kernel",
                "spring-framework", "tomcat");
        Set<String> sections = new HashSet<>();
        ALIASES.aliases().forEach(a -> sections.addAll(a.sections()));
        assertThat(sections).containsExactlyInAnyOrderElementsOf(ProductAliases.ALL_SECTIONS);
    }

    @Test
    @DisplayName("겹치는 id로 표를 만들 수 없다")
    void duplicateIds() {
        Alias a = alias("caddy");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> ProductAliases.of(List.of(a, a)))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
