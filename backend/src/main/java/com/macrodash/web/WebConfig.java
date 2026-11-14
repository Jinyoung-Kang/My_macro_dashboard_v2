package com.macrodash.web;

import com.macrodash.config.AppProperties;
import com.macrodash.feature.auth.AccessPolicy;
import com.macrodash.feature.auth.AuthService;
import com.macrodash.feature.auth.DemoViewer;
import com.macrodash.feature.auth.LocalNoLogin;
import com.macrodash.feature.auth.TailnetLogin;
import com.macrodash.support.CurrentUser;
import com.macrodash.feature.auth.AuthController;
import jakarta.servlet.FilterChain;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.io.InputStreamReader;
import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * CORS와 인증 필터.
 *
 * <p>인증은 단순합니다 — 로그인·헬스체크를 제외한 모든 {@code /api/**} 요청에
 * 유효한 세션 쿠키가 있어야 하고, 경로마다 필요한 역할·등급을 {@link AccessPolicy}가 정합니다(ADR 0010).
 * 예외는 둘입니다(둘 다 기본은 꺼짐) — AWS 공개 데모의 데모 열람(ADR 0013, {@link DemoViewer})과,
 * 이 맥에서 온 쿠키 없는 요청을 첫 운영자로 여는 로컬 무로그인(ADR 0016, {@link LocalNoLogin}).
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    private final AppProperties properties;

    public WebConfig(AppProperties properties) {
        this.properties = properties;
    }

    /** 화면이 부르는 메서드 — PATCH는 정보 검색의 관심 대상 별칭·알림(단계 6). 로컬·QA는 화면과 API의 포트가 달라 사전 요청(OPTIONS)이 이 목록을 봄. */
    static final String[] CORS_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"};

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        // 쿠키를 주고받아야 하므로 allowCredentials가 필요하고,
        // 그 경우 오리진에 와일드카드를 쓸 수 없습니다.
        registry.addMapping("/api/**")
                // 패턴에는 정확한 origin도 들어갑니다. 로그인 모드에서는 화면 포트의 origin을 호스트와 무관하게
                // 허용합니다 — 휴대폰이 http://192.168.x.x:3000으로 열면 API도 같은 호스트의
                // 백엔드 포트를 부르므로(lib/api.ts) origin이 LAN IP가 됩니다. 쿠키는 SameSite=Strict라
                // 다른 사이트의 요청에는 애초에 실리지 않아, 패턴을 넓혀도 인증이 새지 않습니다.
                // 로컬 무로그인(ADR 0016)은 쿠키 없이 운영자가 되므로 이 맥의 화면 주소만 받습니다.
                .allowedOriginPatterns(allowedOriginPatterns(properties).toArray(String[]::new))
                .allowedMethods(CORS_METHODS)
                .allowCredentials(true)
                .maxAge(3600);
    }

    /**
     * 로그인 모드: FRONTEND_ORIGIN의 명시 목록 + 화면 포트의 모든 호스트(http://*:포트).
     * 로컬 무로그인(ADR 0016): 이 맥의 화면 주소 셋(localhost·127.0.0.1·[::1]의 화면 포트)뿐 — 와일드카드 없음.
     * Tailscale 신원 운영자(ADR 0023): FRONTEND_ORIGIN의 명시 목록뿐 — 와일드카드 없음. 쿠키가 아니라 네트워크가 붙이는 자격이라
     * SameSite가 막아 주지 않아, 와일드카드가 남으면 아무 호스트의 화면 포트 페이지가 운영자로 읽고 씁니다(QA-171).
     * FRONTEND_ORIGIN은 기동 때 이 맥의 http 주소인지만 확인합니다({@link LocalNoLogin}).
     */
    static List<String> allowedOriginPatterns(AppProperties properties) {
        if (properties.isLocalNoLogin()) {
            int port = properties.getFrontendPort();
            return List.of("http://localhost:" + port, "http://127.0.0.1:" + port, "http://[::1]:" + port);
        }
        List<String> patterns = new java.util.ArrayList<>(Arrays.stream(properties.getFrontendOrigin().split(","))
                .map(String::trim)
                .filter(origin -> !origin.isBlank())
                .toList());
        if (properties.getTailnetOwnerLogin() != null && !properties.getTailnetOwnerLogin().isBlank()) {
            return List.copyOf(patterns);
        }
        String anyHost = "http://*:" + properties.getFrontendPort();
        if (!patterns.contains(anyHost)) {
            patterns.add(anyHost);
        }
        return patterns;
    }

    /** {@code localNoLogin}을 받는 것은 기동 검사(웹 배포 설정과 섞였으면 기동 중단)가 필터보다 먼저 돌게 하려는 것이기도 합니다. */
    @Bean
    public FilterRegistrationBean<SessionFilter> sessionFilter(AuthService authService, LocalNoLogin localNoLogin, TailnetLogin tailnetLogin) {
        FilterRegistrationBean<SessionFilter> registration = new FilterRegistrationBean<>();
        registration.setFilter(new SessionFilter(authService, allowedOriginPatterns(properties), localNoLogin.enabled(), tailnetLogin));
        registration.addUrlPatterns("/api/*");
        registration.setOrder(1);
        return registration;
    }

    /**
     * 세션 쿠키 검사 + 보안 응답 헤더.
     *
     * <p>공개 경로는 <b>정확히 일치</b>할 때만 통과시킵니다. 예전에는 접두사로
     * 비교해 {@code /api/healthx}, {@code /api/health/../macro/overview} 같은
     * 요청이 인증 검사를 건너뛰었습니다(지금은 해당 매핑이 없어 404로 끝났지만,
     * 비슷한 이름의 엔드포인트가 생기는 순간 인증 없이 열립니다).
     *
     * <p>경로는 컨테이너가 디코딩·정규화한 {@code servletPath}로 봅니다.
     * {@code getRequestURI()}는 날것이라 {@code ..}·{@code %2e}가 그대로 남습니다.
     */
    public static class SessionFilter extends OncePerRequestFilter {

        /** 로그인 없이 받는 경로 — {@link AccessPolicy}의 공개 경로와 같아야 합니다(SessionFilterTest가 대조). */
        static final Set<String> PUBLIC_PATHS = Set.of(
                "/api/auth/login", "/api/auth/session", "/api/health", "/api/auth/signup", "/api/auth/verify",
                "/api/auth/reset/request", "/api/auth/reset/confirm");

        /**
         * 로그인 본문 상한(바이트). 로그인은 인증 없이 받는 유일한 JSON 입력이라, 크기 제한이
         * 없으면 LAN의 아무나 수 MB짜리 {"password": "AAAA…"}를 보내 힙을 압박할 수 있습니다
         * (Tomcat의 maxPostSize는 JSON에 적용되지 않습니다). 이메일·비밀번호 한 줄에는 4KB면 충분합니다.
         */
        static final long MAX_LOGIN_BODY_BYTES = 4096;

        /**
         * 로그인한(또는 데모 열람) 쓰기 요청의 본문 상한(바이트, QA-020). Jackson 3의 기본 문자열 상한은 1억 자라,
         * 상한이 없으면 데모 방문자가 {@code POST /api/ai/report}에 수천만 자를 보내 파싱만으로 힙을 고갈시킬 수
         * 있었습니다(길이 검사는 파싱 뒤). 처음(2026-10)에는 가장 큰 정상 본문이 AI 추가 지시 2,000자(한글 약 6KB)라 64KB였고,
         * 2026-11-04부터 4MB입니다 — 투자 OS 프레임의 한도를 10배로 올린 뒤(2026-11-03, 규칙 4,000자·엔진당 300개·INSIGHT 메모 500,000자)
         * 프레임 v8의 수동 편집 본문(규칙 128개, 약 67KB)이 64KB에 걸렸고, INSIGHT 메모 상한(한글 500,000자 ≈ 1.5MB, 유니코드 이스케이프면
         * 최대 3MB)을 실을 수 있어야 합니다. 4MB 파싱은 힙을 위협하지 않습니다(JSON 문자열 길이 검사는 그 뒤).
         */
        static final long MAX_WRITE_BODY_BYTES = 4L * 1024 * 1024;

        private final AuthService authService;
        /** 상태를 바꾸는 요청(POST·PUT·DELETE)의 Origin이 이 목록(CORS와 같음)에 맞아야 합니다. */
        private final org.springframework.web.cors.CorsConfiguration origins = new org.springframework.web.cors.CorsConfiguration();
        /** 로컬 무로그인 모드(ADR 0016) — 이 맥에서 온 쿠키 없는 요청을 첫 운영자로 엽니다. */
        private final boolean localNoLogin;
        /** Tailscale 신원 자동 로그인(ADR 0023) — Serve가 붙인 신원이 운영자로 정한 사용자면 쿠키 없는 요청을 첫 운영자로. 없으면 꺼짐. */
        private final TailnetLogin tailnetLogin;

        public SessionFilter(AuthService authService, List<String> allowedOriginPatterns) {
            this(authService, allowedOriginPatterns, false);
        }

        public SessionFilter(AuthService authService, List<String> allowedOriginPatterns, boolean localNoLogin) {
            this(authService, allowedOriginPatterns, localNoLogin, null);
        }

        public SessionFilter(AuthService authService, List<String> allowedOriginPatterns, boolean localNoLogin, TailnetLogin tailnetLogin) {
            this.authService = authService;
            this.origins.setAllowedOriginPatterns(allowedOriginPatterns);
            this.localNoLogin = localNoLogin;
            this.tailnetLogin = tailnetLogin;
        }

        /**
         * 다른 출처에서 온 상태 변경 요청을 막습니다. 세션 쿠키는 SameSite=Strict라 다른 사이트의 요청에 실리지 않지만,
         * 로그인처럼 쿠키 없이 받는 요청과 하위 도메인 배포까지 고려해 한 겹 더 둡니다. Origin이 없는 요청(스크립트·curl)은
         * 브라우저가 아니므로 통과시킵니다 — 브라우저는 다른 출처로 POST할 때 Origin을 반드시 붙입니다.
         */
        boolean foreignOrigin(HttpServletRequest request) {
            String method = request.getMethod();
            if (!("POST".equalsIgnoreCase(method) || "PUT".equalsIgnoreCase(method)
                    || "DELETE".equalsIgnoreCase(method) || "PATCH".equalsIgnoreCase(method))) {
                return false;
            }
            String origin = request.getHeader("Origin");
            return origin != null && origins.checkOrigin(origin) == null;
        }

        /**
         * 로컬 무로그인 운영자(쿠키 없이 연 요청, ADR 0016)에게 다른 사이트의 요청인가. 쿠키가 없으니 SameSite가 지켜 주지
         * 않습니다 — 이 맥의 브라우저로 연 다른 사이트가 localhost의 API를 부르면 그대로 운영자 요청이 됩니다.
         * <ul>
         *   <li>Origin이 있으면 허용 목록(이 맥의 화면 주소)에 맞아야 합니다 — 메서드와 상관없이.</li>
         *   <li>쓰기(POST·PUT·PATCH·DELETE)는 Origin이 꼭 있어야 합니다. 화면은 다른 포트(:3000 → :8080)라 브라우저가 늘
         *       붙이고, 스크립트·curl은 Origin을 붙이거나 로그인 쿠키를 쓰면 됩니다.</li>
         *   <li>Origin 없는 읽기는 {@code Sec-Fetch-Site: cross-site}면 막습니다(다른 사이트의 링크·이미지로 부르는 GET).
         *       주소창에 직접 친 요청({@code none})·같은 사이트는 통과합니다.</li>
         * </ul>
         * 로그인 쿠키로 온 요청과 로그인 모드는 이 검사를 받지 않습니다(평소의 {@link #foreignOrigin}만).
         */
        boolean localOwnerCrossSite(HttpServletRequest request) {
            String origin = request.getHeader("Origin");
            if (origin != null) {
                return origins.checkOrigin(origin) == null;
            }
            if (hasBody(request)) {
                return true;
            }
            return "cross-site".equalsIgnoreCase(request.getHeader("Sec-Fetch-Site"));
        }

        /**
         * 데모 열람이 GET 밖에서 부를 수 있는 단 하나 — AI 리포트 생성(ADR 0014). DB에 쓰지 않고, 사용량은 방문자 전체가
         * 함께 쓰는 메모리의 하루 한도로 셉니다({@code feature.auth.UsageService}). 등급 검사는 접근 정책 표 그대로(유료).
         */
        static final String DEMO_WRITABLE_PATH = "/api/ai/report";

        /**
         * 데모 열람이 할 수 없는 요청인가(ADR 0013) — 데모 열람은 읽기 전용이라 GET·OPTIONS(CORS 사전 요청) 밖은 경로와
         * 상관없이(로그인·가입 같은 공개 경로 포함) 403입니다. 예외는 {@code POST} {@link #DEMO_WRITABLE_PATH} 하나입니다
         * (ADR 0014). 유효한 세션 쿠키가 함께 오면 세션이 이기므로 막지 않습니다.
         * 헤더가 없거나 틀리면(기능이 꺼져 있으면 늘) 아무것도 하지 않습니다 — 평소처럼 401·정책 검사로 갑니다.
         *
         * <p>HEAD도 막습니다 — 화면은 HEAD를 쓰지 않고, 앞단(Caddy)도 같은 규칙입니다. HEAD가 접근 정책 표를 건너뛰던
         * 결함(QA-017)은 {@link AccessPolicy#required}가 HEAD를 GET으로 보게 고쳤고, 이 차단은 그 위의 한 겹입니다.
         */
        boolean demoForbidden(HttpServletRequest request) {
            String method = request.getMethod();
            if ("GET".equalsIgnoreCase(method) || "OPTIONS".equalsIgnoreCase(method)) {
                return false;
            }
            if ("POST".equalsIgnoreCase(method) && DEMO_WRITABLE_PATH.equals(pathOf(request))) {
                return false;
            }
            String header = request.getHeader(DemoViewer.HEADER);
            if (header == null || !authService.isDemoViewer(header)) {
                return false;
            }
            return authService.authenticate(AuthController.readToken(request)).isEmpty();
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request,
                                        HttpServletResponse response,
                                        FilterChain chain) throws ServletException, IOException {
            addSecurityHeaders(response);

            if (nonNormalized(request)) {
                response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write(
                        "{\"error\":\"bad_request\",\"message\":\"요청 경로가 올바르지 않습니다.\"}");
                return;
            }

            if (foreignOrigin(request)) {
                writeBadOrigin(response);
                return;
            }

            if (demoForbidden(request)) {
                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write(
                        "{\"error\":\"demo_read_only\",\"message\":\"데모에서는 조회만 가능합니다.\"}");
                return;
            }

            if (isLoginPost(request)) {
                HttpServletRequest capped = capBody(request, response, MAX_LOGIN_BODY_BYTES);
                if (capped != null) {
                    chain.doFilter(capped, response);
                }
                return;
            }

            if ("OPTIONS".equalsIgnoreCase(request.getMethod()) || isPublic(request)) {
                chain.doFilter(request, response);
                return;
            }

            // 세션이 먼저, 없으면 데모 열람 헤더(ADR 0013 — 기능이 꺼져 있거나 값이 틀리면 헤더는 없는 것과 같음),
            // 그다음 로컬 무로그인 운영자(ADR 0016 — 켜져 있고 이 맥에서 바로 온 요청만).
            String token = AuthController.readToken(request);
            boolean localRequest = localNoLogin && LocalNoLogin.isLocalRequest(request);
            // 그다음 Tailscale 신원 운영자(ADR 0023 — Serve가 붙인 신원이 운영자로 정한 사용자이고, 요청의 호스트가 허용 출처의 호스트일 때만 — QA-383).
            boolean tailnetOwner = tailnetLogin != null && tailnetLogin.matches(request);
            // 쿠키 없는 이 맥·tailnet 운영자 요청이 받을 사용자는 그 운영자뿐이라, 다른 사이트에서 온 것이면 DB를 읽기 전에 끊습니다
            // (다른 사이트가 <img>로 되풀이해 불러도 운영자 조회가 돌지 않게). 쿠키가 있으면 아래에서 판정합니다.
            if ((localRequest || tailnetOwner) && token == null && localOwnerCrossSite(request)) {
                writeBadOrigin(response);
                return;
            }
            Optional<CurrentUser> user = authService.resolve(token, request.getHeader(DemoViewer.HEADER), localRequest, tailnetOwner);
            if (user.isEmpty()) {
                response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write(
                        "{\"error\":\"unauthorized\",\"message\":\"로그인이 필요합니다.\"}");
                return;
            }
            if ((localNoLogin || tailnetOwner) && user.get().isLocalOwner() && localOwnerCrossSite(request)) {
                writeBadOrigin(response);
                return;
            }
            AccessPolicy.Access required = AccessPolicy.required(request.getMethod(), pathOf(request));
            if (!AccessPolicy.allows(required, user.get().role(), user.get().tier())) {
                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.setContentType("application/json;charset=UTF-8");
                String message = required == AccessPolicy.Access.OWNER
                        ? "운영자만 쓸 수 있는 기능입니다." : "유료 등급에서 쓸 수 있는 기능입니다.";
                response.getWriter().write("{\"error\":\"forbidden\",\"required\":\"" + required.name()
                        + "\",\"message\":\"" + message + "\"}");
                return;
            }
            request.setAttribute(CurrentUser.ATTRIBUTE, user.get());
            if (hasBody(request)) {
                HttpServletRequest capped = capBody(request, response, MAX_WRITE_BODY_BYTES);
                if (capped != null) {
                    chain.doFilter(capped, response);
                }
                return;
            }
            chain.doFilter(request, response);
        }

        private static void writeBadOrigin(HttpServletResponse response) throws IOException {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write(
                    "{\"error\":\"bad_origin\",\"message\":\"다른 출처에서 온 요청은 받지 않습니다.\"}");
        }

        /** 본문을 받는 메서드(POST·PUT·PATCH·DELETE). */
        static boolean hasBody(HttpServletRequest request) {
            String method = request.getMethod();
            return "POST".equalsIgnoreCase(method) || "PUT".equalsIgnoreCase(method)
                    || "PATCH".equalsIgnoreCase(method) || "DELETE".equalsIgnoreCase(method);
        }

        /**
         * 본문을 상한까지만 읽어 미리 읽은 본문을 넘기는 요청으로 바꿉니다. Content-Length가 없는(chunked) 요청도
         * 같은 상한을 받습니다. 넘으면 413을 쓰고 null(컨트롤러로 보내지 않음).
         */
        static HttpServletRequest capBody(HttpServletRequest request, HttpServletResponse response, long limit)
                throws IOException {
            byte[] body = request.getContentLengthLong() > limit
                    ? null
                    : request.getInputStream().readNBytes((int) limit + 1);
            if (body == null || body.length > limit) {
                response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
                response.setContentType("application/json;charset=UTF-8");
                response.getWriter().write(
                        "{\"error\":\"too_large\",\"message\":\"요청이 너무 큽니다.\"}");
                return null;
            }
            return new CappedBodyRequest(request, body);
        }

        /**
         * API 응답에 붙이는 헤더.
         *
         * <ul>
         *   <li>nosniff — JSON을 스크립트·HTML로 해석하지 못하게 합니다.</li>
         *   <li>no-store — 로그인해야 보이는 데이터가 브라우저·프록시 캐시에 남지 않게 합니다.</li>
         *   <li>DENY / frame-ancestors 'none' — API 응답을 다른 페이지에 끼워 넣지 못하게 합니다.</li>
         * </ul>
         */
        static void addSecurityHeaders(HttpServletResponse response) {
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("X-Frame-Options", "DENY");
            response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
            response.setHeader("Referrer-Policy", "no-referrer");
        }

        /**
         * 날것 URI가 정규화한 경로와 모양이 다른가(QA-023). 접근 정책은 컨테이너가 정규화한 경로({@code getServletPath})로
         * 찾는데, 스프링은 날것 URI로 처리기를 찾습니다. 그래서 {@code POST /api/status/run/..}은 정책상 표에 없는
         * {@code /api/status/}(로그인만)로 통과하고, 처리기는 운영자용 {@code /api/status/run/{task}}가 됐습니다.
         * 둘이 같은 경로를 보게 하려고 정규화가 필요한 요청은 받지 않습니다 — {@code .}·{@code ..} 조각, 인코딩된
         * 점·슬래시·역슬래시·세미콜론·NUL, 날것 역슬래시·세미콜론, 빈 조각({@code //}). 화면이 만드는 경로에는 없습니다.
         */
        static boolean nonNormalized(HttpServletRequest request) {
            String uri = request.getRequestURI();
            if (uri == null) {
                return false;
            }
            String lower = uri.toLowerCase(Locale.ROOT);
            if (lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") || lower.contains("%3b")
                    || lower.contains("%00") || uri.indexOf('\\') >= 0 || uri.indexOf(';') >= 0 || uri.contains("//")) {
                return true;
            }
            for (String segment : uri.split("/", -1)) {
                if (segment.equals(".") || segment.equals("..")) {
                    return true;
                }
            }
            return false;
        }

        static boolean isPublic(HttpServletRequest request) {
            return PUBLIC_PATHS.contains(pathOf(request));
        }

        /** 본문 상한을 거는 요청 — 로그인 없이 받는 POST(로그인·가입·인증·재설정) 전부. */
        static boolean isLoginPost(HttpServletRequest request) {
            return "POST".equalsIgnoreCase(request.getMethod()) && PUBLIC_PATHS.contains(pathOf(request))
                    && !"/api/auth/session".equals(pathOf(request)) && !"/api/health".equals(pathOf(request));
        }

        /** 상한 안에서 미리 읽어 둔 본문을 컨트롤러에 그대로 넘기는 요청. */
        static final class CappedBodyRequest extends HttpServletRequestWrapper {
            private final byte[] body;

            CappedBodyRequest(HttpServletRequest request, byte[] body) {
                super(request);
                this.body = body;
            }

            @Override
            public ServletInputStream getInputStream() {
                ByteArrayInputStream in = new ByteArrayInputStream(body);
                return new ServletInputStream() {
                    @Override public boolean isFinished() { return in.available() == 0; }
                    @Override public boolean isReady() { return true; }
                    @Override public void setReadListener(ReadListener listener) { }
                    @Override public int read() { return in.read(); }
                };
            }

            @Override
            public BufferedReader getReader() {
                String encoding = getCharacterEncoding();
                Charset charset = encoding == null ? StandardCharsets.UTF_8 : Charset.forName(encoding);
                return new BufferedReader(new InputStreamReader(getInputStream(), charset));
            }

            @Override public int getContentLength() { return body.length; }
            @Override public long getContentLengthLong() { return body.length; }
        }

        private static String pathOf(HttpServletRequest request) {
            String path = request.getServletPath();
            if (request.getPathInfo() != null) {
                path = path + request.getPathInfo();
            }
            return path;
        }
    }
}
