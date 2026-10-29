package com.macrodash.web;

import com.macrodash.feature.auth.AccessPolicy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 백엔드가 여는 경로 목록 (ARC-04).
 *
 * <p>컨트롤러를 나누거나 옮길 때 경로가 빠지거나 바뀌면 화면이 조용히 404를 받습니다.
 * 이 테스트는 (1) 경로 전체를 고정 목록과 비교하고, (2) docs/API.md의 백엔드 표와도
 * 맞춰 봅니다. (3) QA 점검 스크립트가 읽는 scripts/qa/routes.json도 대조합니다(QA-110).
 * 경로를 일부러 추가·삭제했다면 세 곳을 함께 고치면 됩니다.
 */
class RouteInventoryTest {

    private static final Path API_DOC = Path.of("../docs/API.md");
    private static final Path QA_ROUTES = Path.of("../scripts/qa/routes.json");

    /** 화면이 부르는 경로 전체. 컨트롤러를 옮겨도 이 목록은 바뀌지 않아야 합니다. */
    private static final Set<String> EXPECTED = new TreeSet<>(List.of(
            "GET /api/health",
            // 인증
            "POST /api/auth/login", "GET /api/auth/session", "POST /api/auth/logout",
            "POST /api/auth/logout-all", "GET /api/auth/sessions", "POST /api/auth/password",
            "POST /api/auth/signup", "POST /api/auth/verify", "POST /api/auth/reset/request",
            "POST /api/auth/reset/confirm", "POST /api/auth/delete",
            // 👥 사용자 관리(운영자)
            "GET /api/admin/users", "POST /api/admin/users", "POST /api/admin/users/{id}", "GET /api/admin/audit",
            // 🔔 알림
            "GET /api/alerts/rules", "POST /api/alerts/rules", "POST /api/alerts/rules/{id}",
            "DELETE /api/alerts/rules/{id}", "GET /api/alerts/inbox", "GET /api/alerts/unread-count",
            "POST /api/alerts/inbox/read",
            // 📊 매크로 · 순유동성 · 로테이션
            "GET /api/macro/overview", "GET /api/macro/risk", "GET /api/macro/advanced",
            "GET /api/macro/usdkrw", "GET /api/macro/fx", "GET /api/macro/fx/options",
            "GET /api/macro/scraped", "GET /api/macro/spread", "GET /api/macro/fred/{seriesId}",
            "GET /api/macro/ticker", "GET /api/liquidity",
            "GET /api/sector/rotation", "GET /api/sector/momentum",
            // 📑 13F · 🧬 기관 스타일
            "GET /api/sec13f/institutions", "GET /api/sec13f/portfolio",
            "GET /api/sec13f/consensus", "GET /api/sec13f/new-buys",
            "GET /api/guru/profiles", "GET /api/guru/similarity",
            "GET /api/guru/holders", "GET /api/guru/risk",
            // 🩺 스코어카드
            "GET /api/stock/universe", "GET /api/stock/scorecard",
            // 🏛️ COT · 🇰🇷 파생 · 📡 레이더
            "GET /api/cot/assets", "GET /api/cot/overview", "GET /api/cot/asset", "GET /api/cot/extremes",
            "GET /api/krx/futures", "GET /api/krx/investor-trend", "GET /api/krx/intraday",
            "GET /api/krx/oi-trend", "GET /api/krx/spot-futures",
            "GET /api/radar/options", "GET /api/radar/ranking", "GET /api/radar/consensus",
            "GET /api/radar/history", "GET /api/radar/diagnostics",
            // 🏦 투자자별 매매 · 🇰🇷 공공 API
            "GET /api/kr/investor-flows", "GET /api/kr/stock-flows",
            "GET /api/calendar/kr-holidays", "GET /api/kr/fundamentals", "GET /api/kr/market-totals",
            // 🗄️ 상태 · 검증 · 원본
            "GET /api/status", "GET /api/status/issues", "GET /api/status/tasks",
            "GET /api/status/history", "POST /api/status/refresh", "POST /api/status/run/{taskName}",
            "GET /api/status/public-apis", "POST /api/verification", "GET /api/snapshot/text",
            // 🔗 상관 · 🧭 국면
            "GET /api/analytics/series", "GET /api/analytics/correlation", "GET /api/analytics/regime",
            "GET /api/analytics/regime/log", "GET /api/analytics/regime/track-record",
            // 🤖 AI · 🔌 토스
            "GET /api/ai/engines", "GET /api/ai/report-types",
            "POST /api/ai/report", "POST /api/ai/test",
            "GET /api/ai/toss/diagnostics", "GET /api/ai/toss/exchange-rate", "GET /api/ai/toss/indices",
            // 🧪 모의 매매(운영자 전용)
            "GET /api/paper/overview", "GET /api/paper/live", "GET /api/paper/status", "GET /api/paper/books/{code}/positions",
            "GET /api/paper/books/{code}/orders", "GET /api/paper/books/{code}/fills",
            "GET /api/paper/books/{code}/nav", "GET /api/paper/books/{code}/execution", "POST /api/paper/init",
            "POST /api/paper/books/{code}/status",
            "POST /api/paper/books/{code}/reset", "POST /api/paper/run/risk", "GET /api/paper/track-record",
            "POST /api/paper/run/rerank", "GET /api/paper/decisions", "GET /api/paper/decisions/{id}",
            "POST /api/paper/run/decision", "POST /api/paper/run/initial-decision", "GET /api/paper/settings",
            "POST /api/paper/settings", "GET /api/paper/settings/history",
            "GET /api/paper/framework", "GET /api/paper/framework/versions/{version}", "POST /api/paper/framework",
            "GET /api/paper/framework/proposals", "POST /api/paper/framework/proposals",
            "POST /api/paper/framework/proposals/{id}/approve", "POST /api/paper/framework/proposals/{id}/reject",
            "GET /api/paper/notes", "POST /api/paper/notes", "DELETE /api/paper/notes/{id}",
            "GET /api/paper/reviews", "GET /api/paper/reviews/{weekEnding}", "POST /api/paper/reviews/run"));

    @Test
    @DisplayName("컨트롤러가 여는 경로가 고정 목록과 정확히 같다")
    void routesMatchInventory() throws ClassNotFoundException {
        assertThat(declaredRoutes()).containsExactlyElementsOf(EXPECTED);
    }

    @Test
    @DisplayName("docs/API.md의 백엔드 표가 실제 경로와 같다 (헬스체크 제외)")
    void apiDocumentMatchesRoutes() throws IOException, ClassNotFoundException {
        assumeTrue(Files.exists(API_DOC), "docs/API.md를 찾을 수 없습니다");
        Set<String> actual = declaredRoutes();
        actual.remove("GET /api/health");
        assertThat(documentedRoutes(Files.readString(API_DOC))).containsExactlyElementsOf(actual);
    }

    /**
     * QA 인증 점검(auth-probe.sh)과 퍼저(fuzz-api.py)가 읽는 경로 목록. 예전에는 대조하는 곳이 없어 ADR 0010·0011로
     * 늘어난 관리·알림·계정 경로 21개가 빠졌고, '쿠키 없이 모든 경로 → 401' 점검이 그 경로를 보내지도 않았습니다.
     */
    @Test
    @DisplayName("scripts/qa/routes.json이 모든 경로를 담고, 그 공개 목록이 접근 정책의 공개 경로와 같다")
    void qaRouteListMatchesRoutes() throws IOException, ClassNotFoundException {
        assumeTrue(Files.exists(QA_ROUTES), "scripts/qa/routes.json을 찾을 수 없습니다");
        JsonNode spec = new ObjectMapper().readTree(Files.readString(QA_ROUTES));
        Set<String> publicRoutes = new TreeSet<>();
        spec.get("public").forEach(node -> publicRoutes.add(node.asString()));
        List<String> probed = new ArrayList<>();
        spec.get("routes").forEach(node -> probed.add(node.get("m").asString() + " " + node.get("p").asString()));

        assertThat(publicRoutes).as("routes.json의 public = AccessPolicy의 PUBLIC").containsExactlyInAnyOrderElementsOf(
                AccessPolicy.routes().entrySet().stream().filter(e -> e.getValue() == AccessPolicy.Access.PUBLIC)
                        .map(Map.Entry::getKey).toList());
        assertThat(probed).as("routes에 같은 경로가 두 번").doesNotHaveDuplicates();
        assertThat(probed).as("공개 경로는 public에만(로그인 필요 경로만 401을 기대)").doesNotContainAnyElementsOf(publicRoutes);
        Set<String> listed = new TreeSet<>(probed);
        listed.addAll(publicRoutes);
        assertThat(listed).containsExactlyElementsOf(declaredRoutes());
    }

    @Test
    @DisplayName("한 컨트롤러가 서비스를 너무 많이 받지 않는다")
    void controllersStaySmall() throws ClassNotFoundException {
        for (Class<?> controller : controllers()) {
            int dependencies = controller.getConstructors()[0].getParameterCount();
            assertThat(dependencies).as(controller.getSimpleName() + " 생성자 인자 수").isLessThanOrEqualTo(5);
        }
    }

    // ------------------------------------------------------------------ 보조

    /** com.macrodash 아래 @RestController 전부 (스프링이 찾는 방식 그대로 클래스패스에서 찾습니다). */
    static List<Class<?>> controllers() throws ClassNotFoundException {
        var scanner = new ClassPathScanningCandidateComponentProvider(false);
        scanner.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        List<Class<?>> out = new ArrayList<>();
        for (var candidate : scanner.findCandidateComponents("com.macrodash")) {
            out.add(Class.forName(candidate.getBeanClassName()));
        }
        assertThat(out).as("컨트롤러를 하나도 찾지 못했습니다").isNotEmpty();
        return out;
    }

    static Set<String> declaredRoutes() throws ClassNotFoundException {
        Set<String> routes = new TreeSet<>();
        for (Class<?> controller : controllers()) {
            RequestMapping base = AnnotatedElementUtils.findMergedAnnotation(controller, RequestMapping.class);
            String prefix = base == null || base.path().length == 0 ? "" : base.path()[0];
            for (Method method : controller.getDeclaredMethods()) {
                RequestMapping mapping = AnnotatedElementUtils.findMergedAnnotation(method, RequestMapping.class);
                if (mapping == null) {
                    continue;
                }
                String[] paths = mapping.path().length == 0 ? new String[]{""} : mapping.path();
                for (RequestMethod verb : mapping.method()) {
                    for (String path : paths) {
                        String route = verb.name() + " " + prefix + path;
                        assertThat(routes.add(route)).as("같은 경로가 두 번 선언됨: " + route).isTrue();
                    }
                }
            }
        }
        return routes;
    }

    /**
     * API.md 1장(백엔드)의 표에서 "메서드 경로"를 뽑습니다. 두 가지 표 형식을 모두 읽습니다.
     * {@code | POST | `/api/auth/login` |} · {@code | `GET /api/x?a=`, `/api/y` |}
     */
    static Set<String> documentedRoutes(String markdown) {
        int end = markdown.indexOf("\n## 2.");
        String backend = end < 0 ? markdown : markdown.substring(0, end);
        Set<String> routes = new TreeSet<>();
        Pattern split = Pattern.compile("^\\| (GET|POST|PUT|DELETE) \\| `(/api[^`?]*)", Pattern.MULTILINE);
        Matcher m = split.matcher(backend);
        while (m.find()) {
            routes.add(m.group(1) + " " + m.group(2));
        }
        Pattern row = Pattern.compile("^\\| `(GET|POST|PUT|DELETE) ([^|]*)\\|", Pattern.MULTILINE);
        Pattern path = Pattern.compile("`(?:(?:GET|POST|PUT|DELETE) )?(/api[^`?]*)");
        Matcher r = row.matcher(backend);
        while (r.find()) {
            Matcher p = path.matcher("`" + r.group(1) + " " + r.group(2));
            while (p.find()) {
                routes.add(r.group(1) + " " + p.group(1));
            }
        }
        return routes;
    }
}
