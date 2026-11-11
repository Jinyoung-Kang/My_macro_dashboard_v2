package com.macrodash.web;

import com.macrodash.config.AppProperties;
import com.macrodash.feature.auth.AuthService;
import com.macrodash.feature.auth.DemoViewer;
import com.macrodash.feature.auth.PasswordHasher;
import com.macrodash.store.AuditLogStore;
import com.macrodash.store.SessionStore;
import com.macrodash.store.UserStore;
import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionFilterTest {

    private static MockHttpServletRequest request(String servletPath) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", servletPath);
        request.setServletPath(servletPath);
        return request;
    }

    @Test
    @DisplayName("공개 경로는 정확히 일치할 때만 인증을 건너뛴다")
    void publicPathsMatchExactly() {
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/health"))).isTrue();
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/auth/login"))).isTrue();

        // 예전 접두사 비교에서는 아래가 모두 공개로 판정됐습니다.
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/healthx"))).isFalse();
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/health/details"))).isFalse();
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/auth/login/extra"))).isFalse();
        assertThat(WebConfig.SessionFilter.isPublic(request("/api/auth/logout"))).isFalse();
    }

    @Test
    @DisplayName("로그인 본문은 4KB까지만 읽고, 넘으면 파싱 전에 413으로 끝낸다")
    void oversizedLoginIsRejectedBeforeParsing() throws Exception {
        WebConfig.SessionFilter filter = new WebConfig.SessionFilter(null, java.util.List.of("http://*:3000"));

        MockHttpServletRequest huge = new MockHttpServletRequest("POST", "/api/auth/login");
        huge.setServletPath("/api/auth/login");
        huge.setContent(new byte[(int) WebConfig.SessionFilter.MAX_LOGIN_BODY_BYTES + 1]);
        MockHttpServletResponse rejected = new MockHttpServletResponse();
        boolean[] reached = {false};
        filter.doFilter(huge, rejected, (req, res) -> reached[0] = true);
        assertThat(rejected.getStatus()).isEqualTo(413);
        assertThat(reached[0]).as("컨트롤러까지 가지 않음").isFalse();

        // 길이를 밝히지 않은(chunked) 요청도 읽어 보고 같은 상한을 적용합니다.
        MockHttpServletRequest small = new MockHttpServletRequest("POST", "/api/auth/login");
        small.setServletPath("/api/auth/login");
        small.setContent("{\"password\":\"pw\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String[] seen = {null};
        filter.doFilter(small, new MockHttpServletResponse(), (req, res) ->
                seen[0] = new String(req.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
        assertThat(seen[0]).as("상한 안의 본문은 그대로 전달").isEqualTo("{\"password\":\"pw\"}");

        assertThat(WebConfig.SessionFilter.isLoginPost(request("/api/ai/report"))).as("다른 경로는 건드리지 않음").isFalse();
    }

    @Test
    @DisplayName("API 응답에 보안 헤더가 붙는다")
    void securityHeaders() {
        MockHttpServletResponse response = new MockHttpServletResponse();
        WebConfig.SessionFilter.addSecurityHeaders(response);

        assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getHeader("X-Frame-Options")).isEqualTo("DENY");
    }

    @Test
    @DisplayName("다른 출처의 상태 변경 요청은 막고, Origin 없는 요청(스크립트)과 같은 출처·GET은 통과")
    void foreignOriginIsDetected() {
        WebConfig.SessionFilter filter = new WebConfig.SessionFilter(null, java.util.List.of("http://*:3000"));
        MockHttpServletRequest evil = new MockHttpServletRequest("POST", "/api/auth/logout");
        evil.addHeader("Origin", "https://evil.example");
        MockHttpServletRequest lan = new MockHttpServletRequest("POST", "/api/auth/logout");
        lan.addHeader("Origin", "http://192.168.0.10:3000");
        MockHttpServletRequest script = new MockHttpServletRequest("POST", "/api/auth/logout");
        MockHttpServletRequest read = new MockHttpServletRequest("GET", "/api/macro/overview");
        read.addHeader("Origin", "https://evil.example");

        assertThat(filter.foreignOrigin(evil)).isTrue();
        assertThat(filter.foreignOrigin(lan)).isFalse();
        assertThat(filter.foreignOrigin(script)).isFalse();
        assertThat(filter.foreignOrigin(read)).isFalse();
    }

    @Test
    @DisplayName("필터의 공개 경로가 접근 정책 표의 공개 경로와 같다 — 두 곳이 어긋나면 인증 없이 열리는 경로가 생긴다")
    void publicPathsMatchAccessPolicy() {
        java.util.Set<String> fromPolicy = new java.util.TreeSet<>();
        com.macrodash.feature.auth.AccessPolicy.routes().forEach((route, access) -> {
            if (access == com.macrodash.feature.auth.AccessPolicy.Access.PUBLIC) {
                fromPolicy.add(route.split(" ", 2)[1]);
            }
        });
        assertThat(new java.util.TreeSet<>(WebConfig.SessionFilter.PUBLIC_PATHS)).isEqualTo(fromPolicy);
    }

    /**
     * 데모 열람(ADR 0013) — 앞단 프록시가 접근 코드를 확인한 요청에 붙이는 {@code X-Demo-Viewer} 헤더.
     * 세션 저장소는 흉내(쿠키 {@code owner-cookie}·{@code member-cookie}만 유효)이고, 필터·AuthService는 실제 코드입니다.
     */
    @Nested
    @DisplayName("데모 열람")
    class DemoViewerMode {

        static final String TOKEN = "test-demo-viewer-token-0123456789abcdef";
        static final UUID OWNER_SESSION = UUID.randomUUID();
        static final UUID MEMBER_SESSION = UUID.randomUUID();

        /** 필터를 거친 결과 — 상태·본문, 컨트롤러까지 갔는지, 그때의 사용자. */
        record Outcome(int status, String body, boolean reached, CurrentUser user) {
        }

        private WebConfig.SessionFilter filter(String configuredToken) {
            AppProperties properties = new AppProperties();
            properties.setDemoViewerToken(configuredToken);
            UserStore users = mock(UserStore.class);
            when(users.ready()).thenReturn(true);
            SessionStore sessions = mock(SessionStore.class);
            when(sessions.findActive(any())).thenAnswer(invocation -> {
                byte[] hash = invocation.getArgument(0);
                Instant later = Instant.now().plusSeconds(3600);
                if (Arrays.equals(hash, sha256("owner-cookie"))) {
                    return Optional.of(new SessionStore.Active(OWNER_SESSION, 1, "owner@test.local", "OWNER", "PRO",
                            Instant.now(), later));
                }
                if (Arrays.equals(hash, sha256("member-cookie"))) {
                    return Optional.of(new SessionStore.Active(MEMBER_SESSION, 2, "member@test.local", "MEMBER", "FREE",
                            Instant.now(), later));
                }
                return Optional.empty();
            });
            AuthService auth = new AuthService(properties, users, sessions, mock(AuditLogStore.class), new PasswordHasher());
            return new WebConfig.SessionFilter(auth, List.of("http://*:3000"));
        }

        private Outcome send(WebConfig.SessionFilter filter, String method, String path, String header, String cookie)
                throws Exception {
            MockHttpServletRequest request = new MockHttpServletRequest(method, path);
            request.setServletPath(path);
            if (header != null) {
                request.addHeader(DemoViewer.HEADER, header);
            }
            if (cookie != null) {
                request.setCookies(new Cookie(AuthService.COOKIE_NAME, cookie));
            }
            MockHttpServletResponse response = new MockHttpServletResponse();
            CurrentUser[] seen = {null};
            boolean[] reached = {false};
            filter.doFilter(request, response, (req, res) -> {
                reached[0] = true;
                seen[0] = CurrentUser.of((jakarta.servlet.http.HttpServletRequest) req);
            });
            return new Outcome(response.getStatus(), response.getContentAsString(StandardCharsets.UTF_8), reached[0],
                    seen[0]);
        }

        @Test
        @DisplayName("QA-020 로그인했거나 데모인 쓰기 요청도 본문이 4MB(MAX_WRITE_BODY_BYTES)를 넘으면 파싱 전에 413 — 상한 안(프레임 v8 본문 크기 67KB)은 통과")
        void oversizedAuthenticatedWriteIsRejected() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            assertThat(WebConfig.SessionFilter.MAX_WRITE_BODY_BYTES).isEqualTo(4L * 1024 * 1024);
            byte[] huge = new byte[(int) WebConfig.SessionFilter.MAX_WRITE_BODY_BYTES + 1];
            Arrays.fill(huge, (byte) 'A');

            MockHttpServletRequest demo = new MockHttpServletRequest("POST", "/api/ai/report");
            demo.setServletPath("/api/ai/report");
            demo.addHeader(DemoViewer.HEADER, TOKEN);
            demo.setContent(huge);
            MockHttpServletResponse demoResponse = new MockHttpServletResponse();
            boolean[] reached = {false};
            on.doFilter(demo, demoResponse, (req, res) -> reached[0] = true);
            assertThat(demoResponse.getStatus()).isEqualTo(413);
            assertThat(reached[0]).as("데모 방문자의 큰 본문이 컨트롤러까지 가지 않음").isFalse();

            MockHttpServletRequest member = new MockHttpServletRequest("POST", "/api/alerts/rules");
            member.setServletPath("/api/alerts/rules");
            member.setCookies(new Cookie(AuthService.COOKIE_NAME, "member-cookie"));
            member.setContent(huge);
            MockHttpServletResponse memberResponse = new MockHttpServletResponse();
            on.doFilter(member, memberResponse, (req, res) -> reached[0] = true);
            assertThat(memberResponse.getStatus()).isEqualTo(413);
            assertThat(reached[0]).isFalse();

            byte[] frameworkSized = new byte[67 * 1024];
            Arrays.fill(frameworkSized, (byte) 'A');
            MockHttpServletRequest within = new MockHttpServletRequest("POST", "/api/alerts/rules");
            within.setServletPath("/api/alerts/rules");
            within.setCookies(new Cookie(AuthService.COOKIE_NAME, "member-cookie"));
            within.setContent(frameworkSized);
            MockHttpServletResponse withinResponse = new MockHttpServletResponse();
            on.doFilter(within, withinResponse, (req, res) -> reached[0] = true);
            assertThat(withinResponse.getStatus()).as("옛 상한 64KB를 넘지만 4MB 안인 본문은 컨트롤러로 간다").isEqualTo(200);
            assertThat(reached[0]).isTrue();
        }

        @Test
        @DisplayName("QA-023 정규화 전후가 다른 경로(끝의 ..·인코딩된 점·//·;)는 정책 검사 전에 400 — 무료 회원이 운영자 처리기에 닿지 못하게")
        void nonNormalizedPathIsRejected() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            String[][] cases = {
                    // {날것 URI, Tomcat이 정규화한 서블릿 경로}
                    {"/api/status/run/..", "/api/status/"},
                    {"/api/status/run/%2e%2e", "/api/status/"},
                    {"/api/admin//users", "/api/admin/users"},
                    {"/api/admin/users;x=1", "/api/admin/users"},
                    {"/api/status/./run/x", "/api/status/run/x"},
            };
            for (String[] c : cases) {
                MockHttpServletRequest request = new MockHttpServletRequest("POST", c[0]);
                request.setServletPath(c[1]);
                request.setCookies(new Cookie(AuthService.COOKIE_NAME, "member-cookie"));
                MockHttpServletResponse response = new MockHttpServletResponse();
                boolean[] reached = {false};
                on.doFilter(request, response, (req, res) -> reached[0] = true);
                assertThat(response.getStatus()).as(c[0]).isEqualTo(400);
                assertThat(reached[0]).as(c[0]).isFalse();
            }
            Outcome normal = send(on, "GET", "/api/macro/overview", null, "member-cookie");
            assertThat(normal.reached()).as("정상 경로는 그대로").isTrue();
        }

        @Test
        @DisplayName("기능이 꺼져 있으면(기본) 헤더를 보지 않는다 — 같은 값을 보내도 401")
        void headerIgnoredWhenOff() throws Exception {
            WebConfig.SessionFilter off = filter("");
            Outcome outcome = send(off, "GET", "/api/macro/overview", TOKEN, null);
            assertThat(outcome.status()).isEqualTo(401);
            assertThat(outcome.reached()).isFalse();
            assertThat(send(off, "POST", "/api/alerts/rules", TOKEN, null).status())
                    .as("쓰기도 데모 403이 아니라 평소의 401").isEqualTo(401);
        }

        @Test
        @DisplayName("틀린 값·빈 값이면 헤더가 없는 것과 같다 — 401")
        void wrongTokenIsUnauthorized() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            for (String wrong : new String[]{"wrong-token", "", TOKEN.substring(0, 32), TOKEN + " x"}) {
                Outcome outcome = send(on, "GET", "/api/macro/overview", wrong, null);
                assertThat(outcome.status()).as(wrong).isEqualTo(401);
                assertThat(outcome.reached()).isFalse();
            }
            assertThat(send(on, "GET", "/api/macro/overview", null, null).status()).as("헤더 없음").isEqualTo(401);
        }

        @Test
        @DisplayName("맞는 값이면 일반 회원·유료 등급의 데모 사용자로 GET을 통과한다(회원 경로·유료 경로)")
        void rightTokenReadsMemberAndProRoutes() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            for (String path : new String[]{"/api/macro/overview", "/api/alerts/inbox", "/api/kr/stock-flows",
                    "/api/guru/risk", "/api/sec13f/new-buys"}) {
                Outcome outcome = send(on, "GET", path, TOKEN, null);
                assertThat(outcome.reached()).as(path).isTrue();
                assertThat(outcome.user().demo()).isTrue();
                assertThat(outcome.user().id()).isEqualTo(DemoViewer.USER_ID);
                assertThat(outcome.user().role()).isEqualTo("MEMBER");
                assertThat(outcome.user().tier()).isEqualTo("PRO");
            }
        }

        @Test
        @DisplayName("운영자 경로는 데모 사용자에게 403 required=OWNER — 접근 정책 표 그대로")
        void ownerRoutesStayForbidden() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            for (String path : new String[]{"/api/status", "/api/admin/users", "/api/radar/diagnostics"}) {
                Outcome outcome = send(on, "GET", path, TOKEN, null);
                assertThat(outcome.status()).as(path).isEqualTo(403);
                assertThat(outcome.body()).contains("\"required\":\"OWNER\"");
                assertThat(outcome.reached()).isFalse();
            }
        }

        @Test
        @DisplayName("데모 사용자는 GET·OPTIONS 밖(쓰기·HEAD)이 경로와 상관없이 403 demo_read_only — POST /api/ai/report 하나만 예외")
        void writesAreReadOnly() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            String[][] writes = {{"POST", "/api/alerts/rules"}, {"POST", "/api/alerts/rules/1"},
                    {"DELETE", "/api/alerts/rules/1"}, {"POST", "/api/alerts/inbox/read"},
                    {"POST", "/api/auth/logout"}, {"POST", "/api/auth/login"}, {"POST", "/api/auth/signup"},
                    {"PUT", "/api/alerts/rules/1"}, {"PATCH", "/api/alerts/rules/1"}, {"POST", "/api/status/refresh"},
                    // AI 리포트 예외(ADR 0014)는 정확히 POST /api/ai/report만 — 같은 경로의 다른 메서드·비슷한 경로·연결 시험은 그대로
                    {"PUT", "/api/ai/report"}, {"DELETE", "/api/ai/report"}, {"POST", "/api/ai/report/1"},
                    {"POST", "/api/ai/test"}};
            for (String[] write : writes) {
                Outcome outcome = send(on, write[0], write[1], TOKEN, null);
                assertThat(outcome.status()).as(write[0] + " " + write[1]).isEqualTo(403);
                assertThat(outcome.body()).contains("demo_read_only").contains("데모에서는 조회만 가능합니다");
                assertThat(outcome.reached()).isFalse();
            }
            assertThat(send(on, "OPTIONS", "/api/alerts/rules", TOKEN, null).reached())
                    .as("CORS 사전 요청은 통과").isTrue();
            // HEAD는 스프링이 GET 처리기로 돌리는데 정책 표에 HEAD 줄이 없어 운영자 경로가 열립니다 — 데모는 막습니다.
            Outcome head = send(on, "HEAD", "/api/status", TOKEN, null);
            assertThat(head.status()).as("HEAD").isEqualTo(403);
            assertThat(head.reached()).isFalse();
        }

        @Test
        @DisplayName("데모 사용자의 POST /api/ai/report는 데모 사용자로 컨트롤러까지 간다(ADR 0014 — 공용 하루 한도는 서비스가 셈)")
        void aiReportIsTheOnlyDemoWrite() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            Outcome outcome = send(on, "POST", "/api/ai/report", TOKEN, null);
            assertThat(outcome.reached()).isTrue();
            assertThat(outcome.user().demo()).isTrue();
            assertThat(outcome.user().id()).isEqualTo(DemoViewer.USER_ID);

            Outcome head = send(on, "HEAD", "/api/ai/report", TOKEN, null);
            assertThat(head.status()).as("HEAD").isEqualTo(403);
            assertThat(head.reached()).isFalse();
            assertThat(send(off(), "POST", "/api/ai/report", TOKEN, null).status())
                    .as("기능이 꺼져 있으면 평소처럼 401").isEqualTo(401);
        }

        private WebConfig.SessionFilter off() {
            return filter("");
        }

        @Test
        @DisplayName("공개 GET(세션 확인·헬스)은 헤더가 있어도 그대로 통과한다")
        void publicReadsPassThrough() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);
            assertThat(send(on, "GET", "/api/auth/session", TOKEN, null).reached()).isTrue();
            assertThat(send(on, "GET", "/api/health", TOKEN, null).reached()).isTrue();
        }

        @Test
        @DisplayName("유효한 세션 쿠키가 있으면 세션이 이긴다 — 데모로 낮추지도, 쓰기를 막지도 않는다")
        void sessionTakesPrecedence() throws Exception {
            WebConfig.SessionFilter on = filter(TOKEN);

            Outcome owner = send(on, "GET", "/api/status", TOKEN, "owner-cookie");
            assertThat(owner.reached()).as("운영자 세션 + 헤더 → 운영 경로 통과").isTrue();
            assertThat(owner.user().demo()).isFalse();
            assertThat(owner.user().sessionId()).isEqualTo(OWNER_SESSION);

            Outcome member = send(on, "GET", "/api/kr/stock-flows", TOKEN, "member-cookie");
            assertThat(member.status()).as("무료 회원 세션이면 헤더가 있어도 무료 회원 — 유료 경로 403").isEqualTo(403);
            assertThat(member.body()).contains("\"required\":\"PRO\"");

            Outcome write = send(on, "POST", "/api/alerts/rules", TOKEN, "member-cookie");
            assertThat(write.reached()).as("세션이 있으면 쓰기도 평소대로").isTrue();
            assertThat(write.user().demo()).isFalse();

            Outcome expired = send(on, "POST", "/api/alerts/rules", TOKEN, "expired-cookie");
            assertThat(expired.status()).as("만료·해지된 쿠키는 세션이 아님 → 데모 쓰기 403").isEqualTo(403);
            assertThat(expired.body()).contains("demo_read_only");
            assertThat(send(on, "GET", "/api/macro/overview", TOKEN, "expired-cookie").user().demo())
                    .as("만료된 쿠키 + 헤더 GET → 데모 열람").isTrue();
        }
    }

    /**
     * 로컬 무로그인(ADR 0016) — 켜져 있으면 이 맥(Host가 localhost 등)에서 쿠키 없이 온 요청을 첫 운영자로 엽니다.
     * 계정 저장소는 흉내(첫 운영자 7번, 쿠키 {@code member-cookie}만 유효)이고, 필터·AuthService는 실제 코드입니다.
     */
    @Nested
    @DisplayName("Tailscale 신원 자동 로그인(ADR 0023)")
    class TailnetOwnerMode {

        static final long OWNER_ID = 9;
        static final String TAILNET = "https://my-macro-app.example.ts.net";

        record Outcome(int status, String body, boolean reached, CurrentUser user) {
        }

        private WebConfig.SessionFilter filter(String ownerLogin) {
            AppProperties properties = new AppProperties();
            properties.setFrontendOrigin("http://localhost:8201,http://127.0.0.1:8201," + TAILNET);
            properties.setFrontendPort(8201);
            properties.setCookieSecure(true);
            properties.setTailnetOwnerLogin(ownerLogin);
            UserStore users = mock(UserStore.class);
            when(users.ready()).thenReturn(true);
            when(users.firstOwner()).thenReturn(Optional.of(new UserStore.User(OWNER_ID, "owner@test.local", "hash",
                    "OWNER", "PRO", Instant.now(), Instant.now())));
            SessionStore sessions = mock(SessionStore.class);
            when(sessions.findActive(any())).thenAnswer(invocation -> {
                byte[] hash = invocation.getArgument(0);
                if (Arrays.equals(hash, sha256("member-cookie"))) {
                    return Optional.of(new SessionStore.Active(UUID.randomUUID(), 2, "member@test.local", "MEMBER", "FREE",
                            Instant.now(), Instant.now().plusSeconds(3600)));
                }
                return Optional.empty();
            });
            AuthService auth = new AuthService(properties, users, sessions, mock(AuditLogStore.class), new PasswordHasher());
            return new WebConfig.SessionFilter(auth, WebConfig.allowedOriginPatterns(properties), false,
                    new com.macrodash.feature.auth.TailnetLogin(properties));
        }

        /** Serve를 거친 요청처럼 서버 이름은 ts.net, caddy가 붙인 X-Forwarded-For를 둡니다. */
        private Outcome send(WebConfig.SessionFilter filter, String method, String path, String cookie,
                             String... headers) throws Exception {
            return exchange(filter, "my-macro-app.example.ts.net", null, method, path, cookie, headers);
        }

        /**
         * 브라우저·curl이 보낸 Host 그대로 온 요청(QA-383) — 앞단 caddy는 Host를 바꾸지 않고 넘기고 X-Forwarded-Host도 그 값으로 채우므로
         * (Tomcat은 그 값으로 서버 이름을 정함), Host 헤더와 서버 이름을 같은 값으로 둡니다.
         */
        private Outcome sendTo(WebConfig.SessionFilter filter, String host, String method, String path, String cookie,
                               String... headers) throws Exception {
            return exchange(filter, serverNameOf(host), host, method, path, cookie, headers);
        }

        /** {@code 이름[:포트]}·{@code [IPv6][:포트]}에서 이름 부분(서블릿의 serverName 모양). */
        private static String serverNameOf(String host) {
            if (host.startsWith("[")) {
                return host.substring(0, host.indexOf(']') + 1);
            }
            int colon = host.lastIndexOf(':');
            return colon < 0 ? host : host.substring(0, colon);
        }

        private Outcome exchange(WebConfig.SessionFilter filter, String serverName, String hostHeader, String method,
                                 String path, String cookie, String... headers) throws Exception {
            // 스프링의 흉내 요청은 Host 헤더가 있으면 서버 이름을 그 헤더에서 읽습니다. 실제 서버(Tomcat)는 앞단이 넘긴 X-Forwarded-Host로
            // 서버 이름을 따로 정할 수 있어, 두 값이 다른 경우까지 보려고 서버 이름을 고정합니다.
            MockHttpServletRequest request = new MockHttpServletRequest(method, path) {
                @Override
                public String getServerName() {
                    return serverName;
                }
            };
            request.setServletPath(path);
            if (hostHeader != null) {
                request.addHeader("Host", hostHeader);
            }
            request.addHeader("X-Forwarded-For", "172.18.0.1");
            for (int i = 0; i < headers.length; i += 2) {
                request.addHeader(headers[i], headers[i + 1]);
            }
            if (cookie != null) {
                request.setCookies(new Cookie(AuthService.COOKIE_NAME, cookie));
            }
            MockHttpServletResponse response = new MockHttpServletResponse();
            CurrentUser[] seen = {null};
            boolean[] reached = {false};
            filter.doFilter(request, response, (req, res) -> {
                reached[0] = true;
                seen[0] = CurrentUser.of((jakarta.servlet.http.HttpServletRequest) req);
            });
            return new Outcome(response.getStatus(), response.getContentAsString(StandardCharsets.UTF_8), reached[0],
                    seen[0]);
        }

        @Test
        @DisplayName("운영자로 정한 Tailscale 사용자의 쿠키 없는 GET은 첫 운영자로 — 운영자 경로까지, 세션 없음")
        void ownerIdentityIsOwner() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            for (String path : new String[]{"/api/macro/overview", "/api/paper/overview", "/api/status"}) {
                Outcome outcome = send(on, "GET", path, null, "Tailscale-User-Login", "Owner@Example.Invalid");
                assertThat(outcome.reached()).as(path).isTrue();
                assertThat(outcome.user().id()).isEqualTo(OWNER_ID);
                assertThat(outcome.user().isLocalOwner()).isTrue();
            }
        }

        @Test
        @DisplayName("다른 Tailscale 사용자·헤더 없음(비상용 SSH 포워딩)·기능 꺼짐은 401 — 로그인 화면 그대로")
        void othersNeedLogin() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            assertThat(send(on, "GET", "/api/macro/overview", null, "Tailscale-User-Login", "guest@example.invalid").status())
                    .isEqualTo(401);
            assertThat(send(on, "GET", "/api/macro/overview", null).status()).isEqualTo(401);
            WebConfig.SessionFilter off = filter("");
            assertThat(send(off, "GET", "/api/macro/overview", null, "Tailscale-User-Login", "owner@example.invalid").status())
                    .as("설정이 비면 헤더를 보지 않음").isEqualTo(401);
        }

        @Test
        @DisplayName("쓰기는 화면(Tailscale 주소)의 Origin일 때만 — Origin 없음·다른 출처는 403 bad_origin(로컬 무로그인과 같은 검사)")
        void writesNeedTheTailnetOrigin() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            Outcome ok = send(on, "POST", "/api/alerts/rules", null, "Tailscale-User-Login", "owner@example.invalid", "Origin", TAILNET);
            assertThat(ok.reached()).isTrue();
            Outcome foreign = send(on, "POST", "/api/alerts/rules", null, "Tailscale-User-Login", "owner@example.invalid",
                    "Origin", "https://attacker.example");
            assertThat(foreign.status()).isEqualTo(403);
            assertThat(foreign.reached()).isFalse();
            Outcome originLess = send(on, "POST", "/api/alerts/rules", null, "Tailscale-User-Login", "owner@example.invalid");
            assertThat(originLess.status()).isEqualTo(403);
            Outcome crossSiteGet = send(on, "GET", "/api/status", null, "Tailscale-User-Login", "owner@example.invalid",
                    "Sec-Fetch-Site", "cross-site");
            assertThat(crossSiteGet.status()).as("다른 사이트의 링크·이미지로 부른 GET").isEqualTo(403);
        }

        @Test
        @DisplayName("QA-171: 화면 포트의 다른 호스트(http://attacker.example:8201)는 Tailscale 운영자에게 다른 사이트 — 읽기·쓰기 모두 403")
        void wildcardPortOriginIsForeign() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            for (String[] req : new String[][]{{"GET", "/api/paper/overview"}, {"POST", "/api/paper/init"}}) {
                Outcome outcome = send(on, req[0], req[1], null, "Tailscale-User-Login", "owner@example.invalid",
                        "Origin", "http://attacker.example:8201");
                assertThat(outcome.status()).as(req[1]).isEqualTo(403);
                assertThat(outcome.body()).as(req[1]).contains("bad_origin");
                assertThat(outcome.reached()).as(req[1]).isFalse();
            }
        }

        @Test
        @DisplayName("유효한 세션 쿠키가 있으면 세션이 이긴다 — 운영자로 올리지 않음")
        void sessionTakesPrecedence() throws Exception {
            Outcome member = send(filter("owner@example.invalid"), "GET", "/api/macro/overview", "member-cookie",
                    "Tailscale-User-Login", "owner@example.invalid");
            assertThat(member.reached()).isTrue();
            assertThat(member.user().role()).isEqualTo("MEMBER");
        }

        @Test
        @DisplayName("QA-383: 허용 출처 목록에 없는 호스트로 온 요청은 신원 헤더가 맞아도 로그인 없는 요청(401) — 같은 출처 읽기라 Origin 검사는 지나감")
        void identityNeedsAnAllowedHost() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            // 공격자 페이지(http://attacker.example:8201 — 주소가 이 서버의 포워딩 포트로 바뀜)가 자기 출처로 부르는 읽기: Origin 없음, 같은 출처.
            for (String host : new String[]{"attacker.example:8201", "attacker.example", "localhost.attacker.example:8201",
                    "my-macro-app.example.ts.net.attacker.example", "my-macro-app.other.ts.net", "203.0.113.5:8201",
                    "[::1]:8201", "0.0.0.0:8201"}) {
                for (String path : new String[]{"/api/paper/overview", "/api/status", "/api/realtrade/status"}) {
                    Outcome outcome = sendTo(on, host, "GET", path, null, "Tailscale-User-Login", "owner@example.invalid",
                            "Sec-Fetch-Site", "same-origin");
                    assertThat(outcome.status()).as(host + " " + path).isEqualTo(401);
                    assertThat(outcome.reached()).as(host + " " + path).isFalse();
                }
            }
            // Host 헤더와 서버 이름(앞단이 넘긴 X-Forwarded-Host를 Tomcat이 반영한 값) 가운데 하나만 목록 밖이어도 인정하지 않습니다.
            Outcome forgedForward = exchange(on, "localhost", "attacker.example:8201", "GET", "/api/paper/overview", null,
                    "Tailscale-User-Login", "owner@example.invalid");
            assertThat(forgedForward.status()).as("Host는 공격자 이름, 서버 이름만 localhost").isEqualTo(401);
            Outcome forgedHost = exchange(on, "attacker.example", "localhost:8201", "GET", "/api/paper/overview", null,
                    "Tailscale-User-Login", "owner@example.invalid");
            assertThat(forgedHost.status()).as("Host는 localhost, 서버 이름만 공격자 이름").isEqualTo(401);
        }

        @Test
        @DisplayName("QA-383: 허용 출처 목록의 호스트(Tailscale 주소·localhost:8201·127.0.0.1:8201)로 온 신원은 그대로 운영자 — 포트·대소문자·끝의 점은 가리지 않음")
        void allowedHostsKeepTheIdentity() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            for (String host : new String[]{"my-macro-app.example.ts.net", "my-macro-app.example.ts.net:443",
                    "MY-MACRO-APP.Example.TS.net", "my-macro-app.example.ts.net.", "localhost:8201", "127.0.0.1:8201",
                    "localhost", "127.0.0.1", "LOCALHOST:8201"}) {
                Outcome outcome = sendTo(on, host, "GET", "/api/paper/overview", null, "Tailscale-User-Login", "owner@example.invalid");
                assertThat(outcome.reached()).as(host).isTrue();
                assertThat(outcome.user().id()).as(host).isEqualTo(OWNER_ID);
                assertThat(outcome.user().isLocalOwner()).as(host).isTrue();
            }
        }

        @Test
        @DisplayName("QA-383: 비상 끄기 절차의 curl(서버 셸 → 루프백 caddy, Host 127.0.0.1:8201 + Origin http://localhost:8201)은 그대로 운영자 쓰기")
        void emergencyDisableFromTheServerShellStillWorks() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            Outcome disable = sendTo(on, "127.0.0.1:8201", "POST", "/api/realtrade/disable", null,
                    "Tailscale-User-Login", "owner@example.invalid", "Origin", "http://localhost:8201",
                    "Content-Type", "application/json");
            assertThat(disable.reached()).isTrue();
            assertThat(disable.user().id()).isEqualTo(OWNER_ID);
            Outcome read = sendTo(on, "127.0.0.1:8201", "GET", "/api/manual/isa", null, "Tailscale-User-Login", "owner@example.invalid");
            assertThat(read.reached()).as("같은 절의 읽기 curl(Origin 없음)").isTrue();
        }

        @Test
        @DisplayName("QA-383: 목록 밖 호스트여도 세션 쿠키 로그인은 그대로 — 신원만 보지 않을 뿐 요청을 막지 않음")
        void sessionCookieStillWorksOnOtherHosts() throws Exception {
            WebConfig.SessionFilter on = filter("owner@example.invalid");
            Outcome member = sendTo(on, "attacker.example:8201", "GET", "/api/macro/overview", "member-cookie",
                    "Tailscale-User-Login", "owner@example.invalid");
            assertThat(member.reached()).isTrue();
            assertThat(member.user().role()).as("쿠키의 사용자 — 운영자로 올리지 않음").isEqualTo("MEMBER");
            Outcome memberOnOwnerPath = sendTo(on, "attacker.example:8201", "GET", "/api/paper/overview", "member-cookie",
                    "Tailscale-User-Login", "owner@example.invalid");
            assertThat(memberOnOwnerPath.status()).as("운영자 경로는 쿠키 사용자의 역할대로 403").isEqualTo(403);
        }
    }

    @Nested
    @DisplayName("로컬 무로그인")
    class LocalNoLoginMode {

        static final long OWNER_ID = 7;
        static final UUID MEMBER_SESSION = UUID.randomUUID();

        record Outcome(int status, String body, boolean reached, CurrentUser user) {
        }

        /** 마지막으로 만든 필터의 계정 저장소 — 운영자 조회가 일어났는지 확인합니다. */
        private UserStore users;

        private WebConfig.SessionFilter filter(boolean on) {
            AppProperties properties = new AppProperties();
            properties.setLocalNoLogin(on);
            UserStore users = mock(UserStore.class);
            this.users = users;
            when(users.ready()).thenReturn(true);
            when(users.firstOwner()).thenReturn(Optional.of(new UserStore.User(OWNER_ID, "owner@test.local", "hash",
                    "OWNER", "PRO", Instant.now(), Instant.now())));
            SessionStore sessions = mock(SessionStore.class);
            when(sessions.findActive(any())).thenAnswer(invocation -> {
                byte[] hash = invocation.getArgument(0);
                if (Arrays.equals(hash, sha256("member-cookie"))) {
                    return Optional.of(new SessionStore.Active(MEMBER_SESSION, 2, "member@test.local", "MEMBER", "FREE",
                            Instant.now(), Instant.now().plusSeconds(3600)));
                }
                return Optional.empty();
            });
            AuthService auth = new AuthService(properties, users, sessions, mock(AuditLogStore.class), new PasswordHasher());
            return new WebConfig.SessionFilter(auth, WebConfig.allowedOriginPatterns(properties), on);
        }

        /** {@code headers}는 이름·값 쌍("Host"는 서버 이름으로). 서버 이름 기본값은 localhost(MockHttpServletRequest). */
        private Outcome send(WebConfig.SessionFilter filter, String method, String path, String cookie,
                             String... headers) throws Exception {
            MockHttpServletRequest request = new MockHttpServletRequest(method, path);
            request.setServletPath(path);
            for (int i = 0; i < headers.length; i += 2) {
                if ("Host".equals(headers[i])) {
                    request.setServerName(headers[i + 1]);
                } else {
                    request.addHeader(headers[i], headers[i + 1]);
                }
            }
            if (cookie != null) {
                request.setCookies(new Cookie(AuthService.COOKIE_NAME, cookie));
            }
            MockHttpServletResponse response = new MockHttpServletResponse();
            CurrentUser[] seen = {null};
            boolean[] reached = {false};
            filter.doFilter(request, response, (req, res) -> {
                reached[0] = true;
                seen[0] = CurrentUser.of((jakarta.servlet.http.HttpServletRequest) req);
            });
            return new Outcome(response.getStatus(), response.getContentAsString(StandardCharsets.UTF_8), reached[0],
                    seen[0]);
        }

        @Test
        @DisplayName("쿠키 없는 이 맥 GET은 첫 운영자로 컨트롤러까지 간다 — 회원·운영자 경로 모두, 세션 없음")
        void cookieLessLocalGetIsOwner() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String host : new String[]{"localhost", "127.0.0.1", "[::1]"}) {
                for (String path : new String[]{"/api/macro/overview", "/api/admin/users", "/api/status"}) {
                    Outcome outcome = send(on, "GET", path, null, "Host", host);
                    assertThat(outcome.reached()).as(host + " " + path).isTrue();
                    assertThat(outcome.user().id()).isEqualTo(OWNER_ID);
                    assertThat(outcome.user().role()).isEqualTo("OWNER");
                    assertThat(outcome.user().sessionId()).isNull();
                    assertThat(outcome.user().demo()).isFalse();
                    assertThat(outcome.user().isLocalOwner()).isTrue();
                }
            }
            Outcome typed = send(on, "GET", "/api/macro/overview", null, "Sec-Fetch-Site", "none");
            assertThat(typed.reached()).as("주소창에 직접 친 요청").isTrue();
            Outcome sameSite = send(on, "GET", "/api/macro/overview", null, "Sec-Fetch-Site", "same-site",
                    "Origin", "http://localhost:3000");
            assertThat(sameSite.reached()).as("화면(:3000)이 부른 GET").isTrue();
        }

        @Test
        @DisplayName("쓰기는 이 맥의 화면 Origin이 있을 때만 — localhost·127.0.0.1·[::1]의 화면 포트")
        void writesNeedLocalOrigin() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String origin : new String[]{"http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"}) {
                Outcome outcome = send(on, "POST", "/api/alerts/rules", null, "Origin", origin);
                assertThat(outcome.reached()).as(origin).isTrue();
                assertThat(outcome.user().id()).isEqualTo(OWNER_ID);
            }
        }

        @Test
        @DisplayName("Origin 없는 쓰기는 403 bad_origin — 쿠키가 없어 SameSite가 막아 주지 않는다(스크립트·다른 사이트의 폼)")
        void originLessWriteIsRejected() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String method : new String[]{"POST", "PUT", "PATCH", "DELETE"}) {
                Outcome outcome = send(on, method, "/api/alerts/rules/1", null);
                assertThat(outcome.status()).as(method).isEqualTo(403);
                assertThat(outcome.body()).contains("bad_origin");
                assertThat(outcome.reached()).isFalse();
            }
            verify(users, never()).firstOwner();   // 쿠키가 없으면 운영자를 조회하기 전에 끊음
        }

        @Test
        @DisplayName("다른 출처의 Origin은 메서드와 상관없이 403 — LAN 주소의 화면도(무로그인은 이 맥 전용)")
        void foreignOriginIsRejectedForAnyMethod() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String origin : new String[]{"https://evil.example", "http://192.168.0.10:3000", "http://localhost:4000",
                    "null"}) {
                for (String method : new String[]{"GET", "HEAD", "POST", "DELETE"}) {
                    Outcome outcome = send(on, method, "/api/macro/overview", null, "Origin", origin);
                    assertThat(outcome.status()).as(method + " " + origin).isEqualTo(403);
                    assertThat(outcome.body()).contains("bad_origin");
                    assertThat(outcome.reached()).isFalse();
                }
            }
            verify(users, never()).firstOwner();   // 쿠키가 없으면 운영자를 조회하기 전에 끊음
        }

        @Test
        @DisplayName("무효한 쿠키(만료·위조)는 로컬 운영자로 넘어가도 다른 사이트 검사를 그대로 받는다 — 쓰기·다른 출처·cross-site 403")
        void invalidCookieStillGetsCrossSiteChecks() throws Exception {
            // 쿠키가 있으면 운영자 조회 전 차단은 건너뜁니다(유효한 세션일 수 있음). 그 쿠키가 무효라 로컬 운영자로 풀리면
            // 인증 뒤 검사가 유일한 방어입니다 — 이 시험이 없으면 그 줄을 지워도 모든 시험이 통과했습니다(통합 검토 지적).
            WebConfig.SessionFilter on = filter(true);
            Outcome write = send(on, "POST", "/api/alerts/rules", "junk-cookie");
            Outcome foreign = send(on, "GET", "/api/macro/overview", "junk-cookie", "Origin", "https://evil.example");
            Outcome crossSite = send(on, "GET", "/api/status", "junk-cookie", "Sec-Fetch-Site", "cross-site");
            for (Outcome outcome : new Outcome[]{write, foreign, crossSite}) {
                assertThat(outcome.status()).isEqualTo(403);
                assertThat(outcome.body()).contains("bad_origin");
                assertThat(outcome.reached()).isFalse();
            }

            Outcome sameScreen = send(on, "GET", "/api/macro/overview", "junk-cookie", "Origin", "http://localhost:3000");
            assertThat(sameScreen.reached()).as("이 맥 화면에서 온 요청은 무효 쿠키여도 로컬 운영자로").isTrue();
            assertThat(sameScreen.user().isLocalOwner()).isTrue();
        }

        @Test
        @DisplayName("Origin 없이 Sec-Fetch-Site: cross-site인 GET은 403 — 다른 사이트의 링크·이미지가 운영자로 부르지 못하게")
        void crossSiteGetWithoutOriginIsRejected() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            Outcome outcome = send(on, "GET", "/api/status", null, "Sec-Fetch-Site", "cross-site");
            assertThat(outcome.status()).isEqualTo(403);
            assertThat(outcome.body()).contains("bad_origin");
            assertThat(outcome.reached()).isFalse();
            // 쿠키가 없으면 받을 사용자는 로컬 운영자뿐이라, 운영자를 조회하기 전에 끊습니다(되풀이 호출이 DB에 닿지 않게).
            verify(users, never()).firstOwner();
        }

        @Test
        @DisplayName("이 맥이 아닌 Host(LAN IP·다른 이름)는 평소처럼 401")
        void nonLocalHostIsUnauthorized() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String host : new String[]{"192.168.0.10", "evil.example", "localhost.evil.example"}) {
                Outcome outcome = send(on, "GET", "/api/macro/overview", null, "Host", host);
                assertThat(outcome.status()).as(host).isEqualTo(401);
                assertThat(outcome.reached()).isFalse();
            }
        }

        @Test
        @DisplayName("앞단 프록시 헤더(X-Forwarded-For·Forwarded·X-Forwarded-Host)가 있으면 이 맥 요청이 아니다 — 401")
        void forwardedRequestIsUnauthorized() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            for (String header : new String[]{"X-Forwarded-For", "Forwarded", "X-Forwarded-Host"}) {
                Outcome outcome = send(on, "GET", "/api/macro/overview", null, header, "127.0.0.1");
                assertThat(outcome.status()).as(header).isEqualTo(401);
                assertThat(outcome.reached()).isFalse();
            }
        }

        @Test
        @DisplayName("로그인 쿠키로 온 요청은 지금 규칙 그대로 — Origin 없는 쓰기·cross-site 읽기도 통과(SameSite가 지킴)")
        void cookieSessionsKeepTodaysRules() throws Exception {
            WebConfig.SessionFilter on = filter(true);
            Outcome write = send(on, "POST", "/api/alerts/rules", "member-cookie");
            assertThat(write.reached()).isTrue();
            assertThat(write.user().id()).isEqualTo(2);
            assertThat(write.user().sessionId()).isEqualTo(MEMBER_SESSION);
            assertThat(send(on, "GET", "/api/macro/overview", "member-cookie", "Sec-Fetch-Site", "cross-site").reached())
                    .isTrue();
            assertThat(send(on, "GET", "/api/admin/users", "member-cookie").status())
                    .as("쿠키가 회원이면 이 맥에서도 회원 — 운영자 경로 403").isEqualTo(403);
        }

        @Test
        @DisplayName("꺼져 있으면(기본) 이 맥에서 쿠키 없이 와도 401 — 로그인 모드 그대로")
        void offRequiresLogin() throws Exception {
            WebConfig.SessionFilter off = filter(false);
            assertThat(send(off, "GET", "/api/macro/overview", null).status()).isEqualTo(401);
            assertThat(send(off, "POST", "/api/alerts/rules", null, "Origin", "http://localhost:3000").status())
                    .isEqualTo(401);
        }
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
