package com.macrodash.feature.security;

import com.macrodash.feature.security.EnvInventory.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 별칭 표(ADR 0046 결정 6) — 이 스택의 구성 요소(버전 목록의 {@code ecosystem}·{@code name}) ↔ 보호나라 공지의 제품명. 순수 자료입니다.
 *
 * <p>제품명은 대소문자를 가리지 않는 정규식으로 맞춥니다. 표 행의 제품명은 제외 정규식이 어디에든 맞으면 그 별칭이 아니고(이름 겹침 —
 * PostgreSQL↔pgAdmin, Next.js↔Nextcloud, Java↔JavaScript 등), 제목·본문은 제외 정규식에 맞는 구절을 지운 뒤 찾습니다. 단어 경계 {@code \b}는
 * 영문·숫자만 글자로 보므로 {@code PostgreSQL에서}처럼 한국어가 바로 붙어도 맞습니다.
 *
 * <p>구성 요소는 종류({@code ecosystem})가 같고 이름 정규식이 {@code name}이나 원본 패키지({@code sourcePackage})에 통째로 맞으면 그 별칭입니다
 * (dpkg·apk는 원본 패키지 {@code openssl}로 {@code libssl…}까지 묶음, pypi는 PEP 503 정규화 뒤 비교).
 *
 * <p>별칭에 적은 구역({@code sections})은 그 구성 요소가 나올 수 있는 곳입니다. 그 구역을 모으지 못했으면(실패·건너뜀·없음) 그 제품은
 * 확인 필요({@code NO_INVENTORY})이고, 모두 모았는데 구성 요소가 없으면 설치돼 있지 않은 것(무관)으로 봅니다. 그래서 버전 목록 스크립트가
 * 모으지 않는 제품은 이 표에 넣지 않습니다(넣으면 '없음 = 무관'이 틀린 답이 됨).
 */
public final class ProductAliases {

    /** 구역 이름 — 버전 목록의 구역({@code env_inventory}의 구역 상태 키)이자 구성 요소의 {@code source}. */
    public static final String SECTION_HOST = "host";
    public static final String SECTION_POSTGRES = "postgres";
    public static final String SECTION_BACKEND = "backend";
    public static final String SECTION_FRONTEND = "frontend";
    public static final String SECTION_COLLECTOR = "collector";
    public static final String SECTION_BROWSER = "browser";
    public static final String SECTION_CADDY = "caddy";
    /** 모든 구역 — OS 라이브러리처럼 어디에나 있을 수 있는 배포판 패키지에 씁니다. */
    public static final List<String> ALL_SECTIONS = List.of(SECTION_HOST, SECTION_POSTGRES, SECTION_BACKEND, SECTION_FRONTEND,
            SECTION_COLLECTOR, SECTION_BROWSER, SECTION_CADDY);

    /** 구성 요소 종류 — 단일 프로그램 버전(서버·런타임·도구). 이름: postgres·jdk·node·python·chrome·caddy·docker·compose·tailscale·kernel. */
    public static final String ECO_RUNTIME = "runtime";
    /** Debian·Ubuntu 패키지(호스트·collector·browser). */
    public static final String ECO_DPKG = "dpkg";
    /** Alpine 패키지(postgres·backend·frontend·caddy). */
    public static final String ECO_APK = "apk";
    /** 백엔드 jar({@code BOOT-INF/lib/이름-버전.jar}의 이름). */
    public static final String ECO_MAVEN = "maven";
    /** 프런트 {@code node_modules} 패키지(범위 이름은 {@code @범위/이름}). */
    public static final String ECO_NPM = "npm";
    /** 수집기 Python 배포 패키지. */
    public static final String ECO_PYPI = "pypi";

    /** 판정 방식. */
    public enum Kind {
        /** 상류 버전 번호 그대로 — 공지의 버전 표와 비교합니다. */
        UPSTREAM,
        /** 배포판 패키지(옛 번호에 패치를 넣음) — 버전 표와 비교하지 않고 서버의 apt 보류(보안) 목록으로 판정합니다. */
        DISTRO
    }

    /** 같은 계열의 범위 — 패치됨은 설치 버전과 같은 계열의 행이 있을 때만입니다. */
    public enum Family {
        /** 한 줄기(모든 행이 같은 계열). */
        SINGLE(0),
        /** 앞 1마디가 계열({@code 16.x}). */
        MAJOR(1),
        /** 앞 2마디가 계열({@code 3.11.x}). */
        MINOR(2);

        private final int depth;

        Family(int depth) {
            this.depth = depth;
        }

        /** 계열을 정하는 앞 마디 수(SINGLE은 0). */
        public int depth() {
            return depth;
        }
    }

    /**
     * 공지 제품명 하나.
     *
     * @param pattern 대소문자를 가리지 않는 정규식(찾기)
     * @param vendor  이 이름이 가리키는 제조사. {@code null}이면 제조사를 따지지 않음(상류 공통 — OpenJDK 등)
     */
    public record ProductName(Pattern pattern, String vendor) {
    }

    /**
     * 구성 요소 열쇠.
     *
     * @param ecosystem 종류({@code ECO_*})
     * @param name      이름·원본 패키지에 통째로 맞출 정규식(대소문자 무시)
     */
    public record ComponentKey(String ecosystem, Pattern name) {

        public boolean matches(Component c) {
            if (!ecosystem.equals(c.ecosystem())) {
                return false;
            }
            if (name.matcher(normalizeName(ecosystem, c.name())).matches()) {
                return true;
            }
            return c.sourcePackageName().map(src -> name.matcher(normalizeName(ecosystem, src)).matches()).orElse(false);
        }
    }

    /**
     * 별칭 하나 = 이 스택이 쓰는 제품 하나.
     *
     * @param id                고정 id(알림 기록·화면 거르기에 씀)
     * @param label             화면·알림의 제품 이름
     * @param kind              판정 방식
     * @param family            계열 범위(DISTRO는 쓰지 않음)
     * @param vendor            이 스택에 깔린 것의 제조사({@code null}이면 따지지 않음). 공지 제품명의 제조사와 다르면 {@code VENDOR_DIFFERS}
     * @param sections          구성 요소가 나올 수 있는 구역
     * @param components        구성 요소 열쇠
     * @param names             공지 제품명(앞에서부터 처음 맞는 것이 그 행의 제조사를 정함)
     * @param exclude           이름 겹침 제외(없으면 {@code null})
     * @param textMatch         표가 없는 공지·표에 없는 제품을 제목·본문에서 찾을지(흔한 낱말이라 잘못 맞기 쉬우면 {@code false})
     * @param versionComparable 설치 버전을 공지의 번호와 견줄 수 있는지({@code false}면 표에 맞아도 늘 확인 필요 {@code NAME_MATCH} —
     *                          예: runc는 containerd.io 패키지에 들어 있어 그 패키지 버전이 runc 버전이 아님)
     */
    public record Alias(String id, String label, Kind kind, Family family, String vendor, List<String> sections,
                        List<ComponentKey> components, List<ProductName> names, Pattern exclude, boolean textMatch,
                        boolean versionComparable) {

        public Alias {
            sections = List.copyOf(sections);
            components = List.copyOf(components);
            names = List.copyOf(names);
        }

        /** 표 행의 제품명이 이 별칭인지 — 맞으면 처음 맞은 이름(제조사 판정용). 제외 정규식이 어디에든 맞으면 아님. */
        public Optional<ProductName> matchProduct(String product) {
            if (product == null || product.isBlank()) {
                return Optional.empty();
            }
            String text = normalizeText(product);
            if (exclude != null && exclude.matcher(text).find()) {
                return Optional.empty();
            }
            for (ProductName n : names) {
                if (n.pattern().matcher(text).find()) {
                    return Optional.of(n);
                }
            }
            return Optional.empty();
        }

        /** 제목·본문에 이 별칭이 나오는지 — 제외 구절을 지운 뒤 찾습니다. {@code textMatch}가 꺼져 있으면 늘 아님. */
        public boolean mentionedIn(String text) {
            if (!textMatch || text == null || text.isBlank()) {
                return false;
            }
            String haystack = normalizeText(text);
            if (exclude != null) {
                haystack = exclude.matcher(haystack).replaceAll(" ");
            }
            for (ProductName n : names) {
                if (n.pattern().matcher(haystack).find()) {
                    return true;
                }
            }
            return false;
        }

        public boolean matchesComponent(Component c) {
            for (ComponentKey key : components) {
                if (key.matches(c)) {
                    return true;
                }
            }
            return false;
        }

        /** 공지 제품명의 제조사가 이 스택에 깔린 것과 다른지(둘 다 적혀 있을 때만). */
        public boolean vendorDiffers(ProductName name) {
            return vendor != null && name.vendor() != null && !vendor.equals(name.vendor());
        }
    }

    private final List<Alias> aliases;

    private ProductAliases(List<Alias> aliases) {
        this.aliases = List.copyOf(aliases);
    }

    public static ProductAliases of(List<Alias> aliases) {
        Set<String> ids = new LinkedHashSet<>();
        for (Alias alias : aliases) {
            if (!ids.add(alias.id())) {
                throw new IllegalArgumentException("별칭 id 겹침: " + alias.id());
            }
        }
        return new ProductAliases(aliases);
    }

    public List<Alias> aliases() {
        return aliases;
    }

    public Optional<Alias> byId(String id) {
        return aliases.stream().filter(a -> a.id().equals(id)).findFirst();
    }

    /** 표 행의 제품명에 맞는 별칭들(별칭 표 순서). */
    public List<Alias> forProduct(String product) {
        List<Alias> out = new ArrayList<>();
        for (Alias alias : aliases) {
            if (alias.matchProduct(product).isPresent()) {
                out.add(alias);
            }
        }
        return out;
    }

    static String normalizeText(String text) {
        return text.replace(' ', ' ').replaceAll("\\s+", " ").strip();
    }

    /** pypi는 PEP 503 정규화(소문자, {@code -_.} 묶음 → {@code -}), 그 밖은 소문자. */
    static String normalizeName(String ecosystem, String name) {
        String lower = name.strip().toLowerCase(Locale.ROOT);
        return ECO_PYPI.equals(ecosystem) ? lower.replaceAll("[-_.]+", "-") : lower;
    }

    private static final int FLAGS = Pattern.CASE_INSENSITIVE;

    // ---- 처음 별칭 표 ---------------------------------------------------------------------------------------

    private static final ProductAliases DEFAULTS = of(List.of(
            // 데이터베이스·런타임(상류 번호)
            alias("postgresql", "PostgreSQL", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_POSTGRES)
                    .component(ECO_RUNTIME, "postgres(?:ql)?")
                    .name("\\bPostgre(?:SQL|s)\\b")
                    .exclude("pgAdmin|JDBC|ODBC|Npgsql|psycopg|PgBouncer|pgpool|PostGIS|EnterpriseDB|\\bEDB\\b").build(),
            alias("pgjdbc", "PostgreSQL JDBC", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "postgresql")
                    .name("PostgreSQL\\s+JDBC|\\bpgJDBC\\b").build(),
            alias("jdk", "Java(JDK)", Kind.UPSTREAM, Family.MAJOR).vendor("Eclipse Adoptium").sections(SECTION_BACKEND)
                    .component(ECO_RUNTIME, "jdk|java|openjdk")
                    // 앞에서부터 처음 맞는 이름이 제조사를 정합니다(구체적인 배포판이 먼저).
                    .name("Oracle\\s+(?:Java|JDK)", "Oracle")
                    .name("\\bCorretto\\b", "Amazon")
                    .name("\\bZulu\\b", "Azul")
                    .name("Microsoft\\s+(?:Build\\s+of\\s+)?OpenJDK", "Microsoft")
                    .name("Red\\s*Hat\\s+(?:build\\s+of\\s+)?OpenJDK", "Red Hat")
                    .name("\\bTemurin\\b", "Eclipse Adoptium")
                    .name("\\bOpenJDK\\b")
                    .name("\\bJava\\s+SE\\b", "Oracle")
                    .name("\\bJDK\\b")
                    .exclude("JavaScript|JavaFX|GraalVM(?:\\s+for\\s+JDK|\\s+Enterprise\\s+Edition)?|Java\\s*Card|JavaMail|Java\\s+Web\\s+Start")
                    .build(),
            alias("node", "Node.js", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_FRONTEND)
                    .component(ECO_RUNTIME, "node(?:js)?")
                    .name("\\bNode\\.?js\\b")
                    // 데이터베이스의 Node.js 드라이버(클라이언트 라이브러리)는 런타임이 아닙니다(QA-977).
                    .exclude("Node-RED|Node\\.?js\\s*(?:Driver|드라이버)").build(),
            alias("python", "Python", Kind.UPSTREAM, Family.MINOR).sections(SECTION_COLLECTOR)
                    .component(ECO_RUNTIME, "python3?")
                    .name("\\bC?Python\\b")
                    .exclude("Python\\s+(?:Requests|urllib3|lxml|패키지|라이브러리|모듈|package|library|module)|python-[\\w.-]+|[\\w.-]+-python\\b")
                    .build(),
            alias("chrome", "Chrome", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_BROWSER)
                    .component(ECO_RUNTIME, "(?:google-)?chrome")
                    .name("(?:Google\\s+)?Chrome\\b")
                    .exclude("Chrome\\s*OS|Chromebook|Chromecast|Chrome\\s+(?:for\\s+)?(?:Android|iOS)").build(),
            alias("caddy", "Caddy", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_CADDY)
                    .component(ECO_RUNTIME, "caddy")
                    .name("\\bCaddy\\b").build(),

            // 서버 도구(호스트)
            alias("docker", "Docker Engine", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_HOST)
                    .component(ECO_RUNTIME, "docker")
                    .name("\\bDocker\\b")
                    .name("\\bMoby\\b")
                    .exclude("Docker\\s+(?:Desktop|Compose|Hub|Scout|Buildx|Build\\s+Cloud)|docker-compose").build(),
            alias("compose", "Docker Compose", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_HOST)
                    .component(ECO_RUNTIME, "compose|docker-compose")
                    .name("Docker\\s+Compose|docker-compose").build(),
            alias("containerd", "containerd", Kind.UPSTREAM, Family.MINOR).sections(SECTION_HOST)
                    .component(ECO_DPKG, "containerd(?:\\.io)?")
                    .name("\\bcontainerd\\b").notComparable().build(),
            alias("runc", "runc", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_HOST)
                    .component(ECO_DPKG, "containerd\\.io")
                    .name("\\brunc\\b").notComparable().build(),
            alias("tailscale", "Tailscale", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_HOST)
                    .component(ECO_RUNTIME, "tailscale")
                    .name("\\bTailscale\\b").build(),

            // 배포판 패키지(apt 보류 목록으로 판정 — 컨테이너 안 apk·dpkg는 보류 목록이 없어 늘 확인 필요)
            alias("linux-kernel", "Linux 커널", Kind.DISTRO, Family.SINGLE).sections(SECTION_HOST)
                    .component(ECO_RUNTIME, "kernel")
                    .component(ECO_DPKG, "linux(?:-signed|-meta)?(?:-hwe(?:-[\\d.]+)?)?")
                    .name("(?:Linux|리눅스)\\s*(?:Kernel|커널)").build(),
            alias("openssh", "OpenSSH", Kind.DISTRO, Family.SINGLE).sections(ALL_SECTIONS)
                    .component(ECO_DPKG, "openssh").component(ECO_APK, "openssh")
                    .name("\\bOpenSSH\\b").build(),
            alias("openssl", "OpenSSL", Kind.DISTRO, Family.SINGLE).sections(ALL_SECTIONS)
                    .component(ECO_DPKG, "openssl").component(ECO_APK, "openssl")
                    .name("\\bOpenSSL\\b")
                    .exclude("pyOpenSSL").build(),
            alias("curl", "curl", Kind.DISTRO, Family.SINGLE).sections(ALL_SECTIONS)
                    .component(ECO_DPKG, "curl").component(ECO_APK, "curl")
                    .name("\\bcurl\\b|\\blibcurl\\b")
                    .exclude("curl_cffi|curl-impersonate").build(),
            alias("glibc", "glibc", Kind.DISTRO, Family.SINGLE).sections(SECTION_HOST, SECTION_COLLECTOR, SECTION_BROWSER)
                    .component(ECO_DPKG, "glibc")
                    .name("\\bglibc\\b|GNU\\s+C\\s+(?:Library|라이브러리)").build(),
            alias("sudo", "sudo", Kind.DISTRO, Family.SINGLE).sections(SECTION_HOST)
                    .component(ECO_DPKG, "sudo")
                    .name("\\bsudo\\b").noText().build(),

            // 백엔드 의존성(jar)
            alias("spring-framework", "Spring Framework", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "spring-(?:core|beans|context|web|webmvc|aop|expression|jdbc|tx)")
                    .name("Spring\\s+Framework|\\bSpring\\s+(?:MVC|WebMVC)\\b").build(),
            alias("spring-boot", "Spring Boot", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "spring-boot(?:-autoconfigure)?")
                    .name("Spring\\s+Boot").build(),
            alias("spring-security", "Spring Security", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "spring-security-(?:core|crypto|web)")
                    .name("Spring\\s+Security").build(),
            alias("tomcat", "Apache Tomcat", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "tomcat-embed-(?:core|el|websocket)")
                    .name("\\bTomcat\\b")
                    .exclude("TomEE").build(),
            alias("jackson", "Jackson", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "jackson-(?:core|databind|annotations)")
                    .name("\\bJackson\\b").noText().build(),
            alias("logback", "Logback", Kind.UPSTREAM, Family.MINOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "logback-(?:core|classic)")
                    .name("\\bLogback\\b").build(),
            alias("bouncycastle", "Bouncy Castle", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "bc(?:prov|pkix|util)-jdk18on")
                    .name("Bouncy\\s*Castle").build(),
            alias("snakeyaml", "SnakeYAML", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_BACKEND)
                    .component(ECO_MAVEN, "snakeyaml")
                    .name("\\bSnakeYAML\\b").build(),

            // 프런트 의존성(npm)
            alias("nextjs", "Next.js", Kind.UPSTREAM, Family.MINOR).sections(SECTION_FRONTEND)
                    .component(ECO_NPM, "next")
                    .name("\\bNext\\.?js\\b")
                    .exclude("Nextcloud|Next\\s+Cloud|NextAuth").build(),
            alias("react", "React", Kind.UPSTREAM, Family.MINOR).sections(SECTION_FRONTEND)
                    .component(ECO_NPM, "react|react-dom")
                    .name("\\bReact\\b")
                    .exclude("React\\s+Native|react-native|React\\s+Router|react-router|Preact|ReactOS").build(),

            // 수집기 의존성(pypi)
            alias("requests", "Requests(Python)", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_COLLECTOR)
                    .component(ECO_PYPI, "requests")
                    .name("^(?:Python\\s+)?Requests\\b|\\bpsf/requests\\b").noText().build(),
            alias("urllib3", "urllib3", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_COLLECTOR)
                    .component(ECO_PYPI, "urllib3")
                    .name("\\burllib3\\b").build(),
            alias("lxml", "lxml", Kind.UPSTREAM, Family.MAJOR).sections(SECTION_COLLECTOR)
                    .component(ECO_PYPI, "lxml")
                    .name("\\blxml\\b").build(),
            alias("fastapi", "FastAPI", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_COLLECTOR)
                    .component(ECO_PYPI, "fastapi")
                    .name("\\bFastAPI\\b").build(),
            alias("starlette", "Starlette", Kind.UPSTREAM, Family.SINGLE).sections(SECTION_COLLECTOR)
                    .component(ECO_PYPI, "starlette")
                    .name("\\bStarlette\\b").build()));

    /** 처음 별칭 표 — 이 스택의 구성 요소(ADR 0046 결정 1의 구역들)를 덮습니다. */
    public static ProductAliases defaults() {
        return DEFAULTS;
    }

    private static Builder alias(String id, String label, Kind kind, Family family) {
        return new Builder(id, label, kind, family);
    }

    private static final class Builder {
        private final String id;
        private final String label;
        private final Kind kind;
        private final Family family;
        private String vendor;
        private final List<String> sections = new ArrayList<>();
        private final List<ComponentKey> components = new ArrayList<>();
        private final List<ProductName> names = new ArrayList<>();
        private Pattern exclude;
        private boolean textMatch = true;
        private boolean versionComparable = true;

        Builder(String id, String label, Kind kind, Family family) {
            this.id = id;
            this.label = label;
            this.kind = kind;
            this.family = family;
        }

        Builder vendor(String value) {
            this.vendor = value;
            return this;
        }

        Builder sections(String... values) {
            sections.addAll(List.of(values));
            return this;
        }

        Builder sections(List<String> values) {
            sections.addAll(values);
            return this;
        }

        Builder component(String ecosystem, String nameRegex) {
            components.add(new ComponentKey(ecosystem, Pattern.compile(nameRegex, FLAGS)));
            return this;
        }

        Builder name(String regex) {
            return name(regex, null);
        }

        Builder name(String regex, String nameVendor) {
            names.add(new ProductName(Pattern.compile(regex, FLAGS), nameVendor));
            return this;
        }

        Builder exclude(String regex) {
            this.exclude = Pattern.compile(regex, FLAGS);
            return this;
        }

        Builder noText() {
            this.textMatch = false;
            return this;
        }

        Builder notComparable() {
            this.versionComparable = false;
            return this;
        }

        Alias build() {
            return new Alias(id, label, kind, family, vendor, sections, components, names, exclude, textMatch, versionComparable);
        }
    }
}
