package com.macrodash;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 패키지 의존 규칙 — 바깥(HTTP·설정)에서 안쪽(비즈니스 규칙)으로만 향하게.
 *
 * <pre>
 *   web ─► feature/&lt;기능&gt; ─► read ─► store
 *                │            └──► collector
 *                ├──► analytics (java.*만)
 *                └──► support
 * </pre>
 *
 * <p>설정 값({@code config.AppProperties})은 기능·read·collector·web이 읽고, config는 우리 패키지를 쓰지 않습니다.
 *
 * <p>소스의 {@code import}와 본문에 적힌 전체 이름({@code com.macrodash.x.Y})을 읽어 검사합니다
 * (새 라이브러리 없이). 규칙을 어기면 어느 파일이 무엇을 가져다 쓰는지 목록으로 알려 줍니다.
 * 규칙과 이유는 docs/adr/0001-feature-modules-and-dependency-rules.md에 있습니다.
 */
class ArchitectureRulesTest {

    private static final Path MAIN = Path.of("src/main/java/com/macrodash");
    private static final Pattern IMPORT = Pattern.compile("^import\\s+(?:static\\s+)?([\\w.]+(?:\\.\\*)?);", Pattern.MULTILINE);
    private static final Pattern INLINE = Pattern.compile("\\bcom\\.macrodash(?:\\.[a-z]\\w*)+\\.[A-Z]\\w*");
    private static final Pattern PACKAGE = Pattern.compile("^package\\s+([\\w.]+);", Pattern.MULTILINE);

    /** 파일 → (패키지, 참조한 이름들) */
    private static final Map<Path, Source> SOURCES = new TreeMap<>();
    /** 파일 → 주석을 뺀 본문 */
    private static final Map<Path, String> CODE = new TreeMap<>();

    record Source(String pkg, String simpleName, Set<String> refs) {
        boolean isController() {
            return simpleName.endsWith("Controller");
        }
    }

    @BeforeAll
    static void readSources() throws IOException {
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                String text = Files.readString(file);
                Matcher pkg = PACKAGE.matcher(text);
                assertThat(pkg.find()).as("package 선언 없음: " + file).isTrue();
                Set<String> refs = new TreeSet<>();
                Matcher imports = IMPORT.matcher(text);
                while (imports.find()) {
                    refs.add(imports.group(1));
                }
                // 주석을 뺀 본문에 적힌 전체 이름도 참조로 봅니다(import 없이 쓰는 경우).
                String code = text.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("//[^\\n]*", "");
                Matcher inline = INLINE.matcher(code);
                while (inline.find()) {
                    refs.add(inline.group());
                }
                String name = file.getFileName().toString().replace(".java", "");
                SOURCES.put(file, new Source(pkg.group(1), name, refs));
                CODE.put(file, code);
            }
        }
        assertThat(SOURCES).as("소스를 찾지 못했습니다(작업 디렉터리가 backend여야 합니다)").isNotEmpty();
    }

    @Test
    @DisplayName("analytics는 java.*만 쓴다 — 스프링·DB·JSON 라이브러리를 모르는 순수 계산")
    void analyticsIsPure() {
        assertThat(violations("com.macrodash.analytics", ref ->
                !ref.startsWith("java.") && !ref.startsWith("com.macrodash.analytics.")))
                .isEmpty();
    }

    /**
     * 기반 패키지가 쓸 수 있는 우리 패키지(ADR 0001의 표). 자기 패키지와 최상위(Kst 등)는 늘 허용합니다.
     */
    private static final Map<String, List<String>> INFRASTRUCTURE_ALLOWED = Map.of(
            "com.macrodash.config", List.of(),
            "com.macrodash.store", List.of(),
            "com.macrodash.collector", List.of("com.macrodash.config."),
            "com.macrodash.support", List.of("com.macrodash.analytics."),
            "com.macrodash.read", List.of("com.macrodash.store.", "com.macrodash.collector.", "com.macrodash.config."));

    @Test
    @DisplayName("store(저장소 접근)는 DB만 다룬다 — 수집기·설정·읽기 정책·기능을 모른다")
    void storeOnlyTalksToDatabase() {
        assertThat(violations("com.macrodash.store", ref -> isOurs(ref)
                && !ref.startsWith("com.macrodash.store.") && !isRootClass(ref)))
                .isEmpty();
    }

    @Test
    @DisplayName("기반 패키지(config·store·collector·support·read)는 ADR 0001 표에 적힌 패키지만 쓴다")
    void infrastructureUsesOnlyWhatTheTableAllows() {
        INFRASTRUCTURE_ALLOWED.forEach((pkg, allowed) -> assertThat(violations(pkg, ref -> isOurs(ref)
                && !ref.startsWith(pkg + ".") && !isRootClass(ref)
                && allowed.stream().noneMatch(ref::startsWith)))
                .as(pkg).isEmpty());
    }

    @Test
    @DisplayName("support·collector·read는 기능(feature)과 HTTP 계층(web)을 모른다")
    void infrastructureDoesNotReachUp() {
        for (String pkg : List.of("com.macrodash.support", "com.macrodash.collector", "com.macrodash.read")) {
            assertThat(violations(pkg, ref -> startsWithAny(ref, "com.macrodash.feature.", "com.macrodash.web.")))
                    .as(pkg).isEmpty();
        }
    }

    /**
     * 컨트롤러가 예외적으로 쓸 수 있는 기반 클래스. 응답 캐시(ComputedCache)는 "같은 저장본이면 같은 응답"이라는
     * HTTP 계층의 관심사라 컨트롤러에 둡니다 — 서비스는 캐시를 모르고 계산만 하므로 테스트가 단순합니다.
     * 데이터 접근(StoreReader·StoreRepository)은 여전히 금지입니다.
     */
    private static final List<String> CONTROLLER_INFRASTRUCTURE = List.of("com.macrodash.read.ComputedCache");

    @Test
    @DisplayName("컨트롤러는 자기 기능의 서비스와 support·config(+응답 캐시)만 쓴다(저장소·수집기·다른 기능 직접 호출 금지)")
    void controllersGoThroughTheirOwnServices() {
        List<String> found = new ArrayList<>();
        SOURCES.forEach((file, source) -> {
            if (!source.pkg().startsWith("com.macrodash.feature.") || !source.isController()) {
                return;
            }
            for (String ref : source.refs()) {
                if (ref.startsWith("com.macrodash.")
                        && !ref.startsWith(source.pkg() + ".")
                        && !startsWithAny(ref, "com.macrodash.support.", "com.macrodash.config.")
                        && !CONTROLLER_INFRASTRUCTURE.contains(ref)) {
                    found.add(source.simpleName() + " → " + ref);
                }
            }
        });
        assertThat(found).isEmpty();
    }

    @Test
    @DisplayName("기능끼리는 서비스만 가져다 쓰고, 다른 기능의 컨트롤러는 쓰지 않는다")
    void featuresShareServicesNotControllers() {
        List<String> found = new ArrayList<>();
        SOURCES.forEach((file, source) -> {
            if (!source.pkg().startsWith("com.macrodash.feature.")) {
                return;
            }
            for (String ref : source.refs()) {
                if (ref.startsWith("com.macrodash.feature.") && !ref.startsWith(source.pkg() + ".")
                        && ref.endsWith("Controller")) {
                    found.add(source.simpleName() + " → " + ref);
                }
            }
        });
        assertThat(found).isEmpty();
    }

    @Test
    @DisplayName("스냅샷은 read.StoreReader로만 읽는다 — 신선도·수집 요청 정책을 우회하지 않는다")
    void snapshotsAreReadOnlyThroughStoreReader() {
        // observations·timeseries는 신선도 정책이 없어 StoreRepository를 바로 써도 됩니다.
        // 스냅샷을 repository.readSnapshot으로 읽으면 "오래됐으면 수집 요청"이 빠집니다(RadarService.options가 그랬음).
        Pattern direct = Pattern.compile("\\.readSnapshots?\\(");
        List<String> found = new ArrayList<>();
        SOURCES.forEach((file, source) -> {
            if (source.pkg().equals("com.macrodash.read") || source.pkg().equals("com.macrodash.store")) {
                return;
            }
            if (direct.matcher(CODE.get(file)).find()) {
                found.add(source.simpleName());
            }
        });
        assertThat(found).isEmpty();
    }

    @Test
    @DisplayName("DB 접근(스프링 JDBC)은 store에서만 한다 — 백엔드가 쓰는 테이블도 마찬가지(ADR 0001·0008)")
    void jdbcOnlyInStore() {
        List<String> found = new ArrayList<>();
        SOURCES.values().forEach(source -> {
            if (source.pkg().equals("com.macrodash.store")) {
                return;
            }
            source.refs().stream().filter(ref -> ref.startsWith("org.springframework.jdbc."))
                    .forEach(ref -> found.add(source.simpleName() + " → " + ref));
        });
        assertThat(found).isEmpty();
    }

    /** 수집기가 쓰는 테이블(ADR 0008). 백엔드는 읽기만 합니다. */
    private static final Pattern WRITES_COLLECTOR_TABLE = Pattern.compile(
            "(?i)(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+(snapshots|timeseries|observations|"
                    + "collector_runs|collector_task_runs|refresh_requests|schema_migrations)\\b");

    @Test
    @DisplayName("백엔드는 수집기 테이블에 쓰지 않는다 — 테이블마다 쓰는 프로세스는 하나(ADR 0008)")
    void backendDoesNotWriteCollectorTables() {
        List<String> found = new ArrayList<>();
        SOURCES.forEach((file, source) -> {
            Matcher matcher = WRITES_COLLECTOR_TABLE.matcher(CODE.get(file));
            while (matcher.find()) {
                found.add(source.simpleName() + ": " + matcher.group());
            }
        });
        assertThat(found).isEmpty();
    }

    private static final String BROKERAGE = "com.macrodash.feature.brokerage";

    /**
     * 실제 계좌(토스증권, ADR 0025)는 다른 기능과 주고받지 않습니다 — 모의 장부·패킷·프롬프트·복기·알림·AI 리포트로 가는 길이 없게. 저장하지
     * 않으므로 store·read도 쓰지 않습니다. 문자열·저장본을 거친 흐름은 이 시험이 못 보므로 저장하지 않는 것이 함께 지키는 조건입니다.
     */
    @Test
    @DisplayName("실제 계좌(feature.brokerage)는 고립 — 다른 패키지가 참조하지 않고, 자기는 자기 패키지·CollectorClient·config·support·Kst만 쓴다")
    void brokerageIsIsolated() {
        assertThat(SOURCES.values()).as("feature.brokerage 패키지가 있음")
                .anyMatch(source -> source.pkg().equals(BROKERAGE));
        List<String> inbound = new ArrayList<>();
        SOURCES.values().forEach(source -> {
            if (source.pkg().equals(BROKERAGE) || source.pkg().startsWith(BROKERAGE + ".")) {
                return;
            }
            source.refs().stream().filter(ref -> ref.startsWith(BROKERAGE + "."))
                    .forEach(ref -> inbound.add(source.simpleName() + " → " + ref));
        });
        assertThat(inbound).as("feature.brokerage를 참조하는 다른 패키지").isEmpty();
        assertThat(violations(BROKERAGE, ref -> isOurs(ref)
                && !ref.startsWith(BROKERAGE + ".")
                && !ref.equals("com.macrodash.collector.CollectorClient")
                && !startsWithAny(ref, "com.macrodash.config.", "com.macrodash.support.")
                && !ref.equals("com.macrodash.Kst") && !ref.startsWith("com.macrodash.Kst.")))
                .as("feature.brokerage가 쓰는 우리 패키지").isEmpty();
    }

    @Test
    @DisplayName("기능 사이 의존에 순환이 없다")
    void noCyclesBetweenFeatures() {
        Map<String, Set<String>> graph = new HashMap<>();
        SOURCES.values().forEach(source -> {
            if (!source.pkg().startsWith("com.macrodash.feature.")) {
                return;
            }
            Set<String> edges = graph.computeIfAbsent(source.pkg(), key -> new TreeSet<>());
            for (String ref : source.refs()) {
                if (ref.startsWith("com.macrodash.feature.")) {
                    String target = packageOf(ref);
                    if (!target.equals(source.pkg())) {
                        edges.add(target);
                    }
                }
            }
        });
        assertThat(graph).as("기능 패키지를 찾지 못했습니다").isNotEmpty();
        for (String start : graph.keySet()) {
            assertThat(cycleFrom(start, graph, new ArrayList<>(), new HashSet<>())).as("순환").isNull();
        }
    }

    /**
     * 기능만 보면 기반 패키지를 거쳐 도는 순환을 놓칩니다 — 설정 값(AppProperties)과 인증 필터 배선(WebConfig)이
     * 한 패키지(config)에 있어 config ↔ feature.auth, config → web → read → collector → config가 돌았습니다
     * (2026-10, jdeps 패키지 그래프로 발견).
     */
    @Test
    @DisplayName("패키지 사이 의존에 순환이 없다 — 기반 패키지(config·web·read·collector 등) 포함")
    void noCyclesBetweenPackages() {
        Map<String, Set<String>> graph = new TreeMap<>();
        SOURCES.values().forEach(source -> {
            Set<String> edges = graph.computeIfAbsent(source.pkg(), key -> new TreeSet<>());
            for (String ref : source.refs()) {
                if (isOurs(ref)) {
                    String target = packageOf(ref);
                    if (!target.equals(source.pkg())) {
                        edges.add(target);
                    }
                }
            }
        });
        List<List<String>> cycles = new ArrayList<>();
        for (String start : graph.keySet()) {
            List<String> cycle = cycleFrom(start, graph, new ArrayList<>(), new HashSet<>());
            if (cycle != null) {
                cycles.add(cycle);
            }
        }
        assertThat(cycles).as("패키지 순환").isEmpty();
    }

    // ------------------------------------------------------------------ 보조

    /** 패키지(하위 포함) 안의 파일 중 {@code bad}에 걸리는 참조 목록. */
    private static List<String> violations(String pkg, java.util.function.Predicate<String> bad) {
        List<String> found = new ArrayList<>();
        SOURCES.values().forEach(source -> {
            if (source.pkg().equals(pkg) || source.pkg().startsWith(pkg + ".")) {
                source.refs().stream().filter(bad).forEach(ref -> found.add(source.simpleName() + " → " + ref));
            }
        });
        return found;
    }

    private static boolean isOurs(String ref) {
        return ref.startsWith("com.macrodash.");
    }

    /** 최상위 패키지의 클래스(com.macrodash.Kst 등). */
    private static boolean isRootClass(String ref) {
        return ref.matches("com\\.macrodash\\.[A-Z]\\w*(\\..*)?");
    }

    /** 참조가 가리키는 패키지: 대문자로 시작하는 조각(클래스) 앞까지, 와일드카드면 .* 앞까지. */
    static String packageOf(String ref) {
        StringBuilder out = new StringBuilder();
        for (String part : ref.split("\\.")) {
            if (part.equals("*") || Character.isUpperCase(part.charAt(0))) {
                break;
            }
            out.append(out.isEmpty() ? "" : ".").append(part);
        }
        return out.toString();
    }

    private static boolean startsWithAny(String ref, String... prefixes) {
        for (String prefix : prefixes) {
            if (ref.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** start에서 출발해 다시 start로 돌아오는 경로가 있으면 그 경로, 없으면 null. */
    private static List<String> cycleFrom(String node, Map<String, Set<String>> graph,
                                          List<String> path, Set<String> seen) {
        path.add(node);
        for (String next : graph.getOrDefault(node, Set.of())) {
            if (next.equals(path.get(0))) {
                List<String> cycle = new ArrayList<>(path);
                cycle.add(next);
                return cycle;
            }
            if (seen.add(next)) {
                List<String> found = cycleFrom(next, graph, path, seen);
                if (found != null) {
                    return found;
                }
            }
        }
        path.remove(path.size() - 1);
        return null;
    }
}
