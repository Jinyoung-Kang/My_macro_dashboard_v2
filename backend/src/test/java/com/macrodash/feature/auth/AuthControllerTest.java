package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import com.macrodash.store.UserStore;
import com.macrodash.support.CurrentUser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class AuthControllerTest {

    private final AuthTestDatabase db = new AuthTestDatabase("authctl");
    private final AppProperties properties = new AppProperties();
    private final AuthController controller;
    private final AccountService accounts;

    AuthControllerTest() {
        db.user("owner", "right-password-1", "OWNER", "PRO");
        // 느린 차선의 대기를 실제로 기다리지 않습니다(동작은 LoginThrottleTest가 고정).
        AccountMail mail = org.mockito.Mockito.mock(AccountMail.class);
        accounts = new AccountService(db.users, db.sessions,
                new com.macrodash.store.EmailTokenStore(db.jdbc), db.audit, db.hasher, mail);
        controller = new AuthController(db.service(properties), accounts,
                new LoginThrottle(java.time.Clock.systemUTC(), millis -> { }), properties);
    }

    @AfterEach
    void cleanUp() {
        db.cleanUp();
    }

    private ResponseEntity<Map<String, Object>> login(String email, String password, String ip) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(ip);
        return controller.login(new AuthController.LoginRequest(email, password), request);
    }

    private String token(ResponseEntity<Map<String, Object>> response) {
        String cookie = response.getHeaders().getFirst(HttpHeaders.SET_COOKIE);
        return cookie.split(";")[0].split("=", 2)[1];
    }

    @Test
    @DisplayName("세션 쿠키는 my_macro_v2_session(v3의 macro_session·v1의 my_macro_session과 다름) · HttpOnly + SameSite=Strict, 응답에 사용자(이메일·역할·등급)")
    void cookieAttributes() {
        ResponseEntity<Map<String, Object>> response = login(db.email("owner"), "right-password-1", "10.0.0.1");

        String cookie = response.getHeaders().getFirst(HttpHeaders.SET_COOKIE);
        assertThat(cookie).as("같은 localhost의 v3(macro_session)·v1(my_macro_session)과 섞이지 않는 이름").startsWith("my_macro_v2_session=");
        assertThat(cookie).contains("HttpOnly").contains("SameSite=Strict").doesNotContain("Secure");
        assertThat(response.getBody()).containsEntry("ok", true);
        assertThat(String.valueOf(((Map<?, ?>) response.getBody().get("user")).get("role"))).isEqualTo("OWNER");
    }

    @Test
    @DisplayName("연속 실패하면 429 + Retry-After, 그래도 맞는 비밀번호는 통과한다")
    void bruteForceIsThrottledButOwnerStillGetsIn() {
        String email = db.email("owner");
        for (int i = 0; i < 5; i++) {   // 무료 시도 5회 (LoginThrottle.FREE_ATTEMPTS)
            assertThat(login(email, "wrong", "10.0.0.2").getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        }
        ResponseEntity<Map<String, Object>> slowed = login(email, "wrong", "10.0.0.2");
        assertThat(slowed.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(slowed.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("30");

        assertThat(login(email, "right-password-1", "10.0.0.2").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(login(email, "right-password-1", "10.0.0.3").getStatusCode())
                .as("다른 주소는 영향 없음").isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("QA-125 없는 이메일을 바꿔 가며 실패해도 감사 기록은 한 시간 상한(30건)까지만 쌓인다")
    void loginFailureAuditIsBoundedUnderEmailRotation() {
        // 이메일이 다르면 지연 키(주소|이메일)도 달라 모두 무료 시도 — 로그인 없이 실패마다 한 행이 1년 동안 남았습니다.
        for (int i = 0; i < LoginFailureAudit.UNKNOWN_PER_WINDOW + 10; i++) {
            assertThat(login(db.email("nobody" + i), "wrong-password", "10.0.2.1").getStatusCode())
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
        }

        Integer rows = db.jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE action = 'login.failure' "
                + "AND detail->>'email' LIKE ?", Integer.class, db.prefix + "-nobody%");
        assertThat(rows).as("없는 계정 실패 기록 — 상한까지는 이메일과 함께 남김")
                .isEqualTo(LoginFailureAudit.UNKNOWN_PER_WINDOW);
    }

    @Test
    @DisplayName("QA-125 같은 계정 대입은 주소를 바꿔도 한 묶음으로 세어 1·5·8번째 실패만 남고, 성공 기록에 그동안의 실패 수가 남는다")
    void bruteForceAcrossAddressesIsOneWindowAndSuccessShowsPriorFailures() {
        String email = db.email("owner");
        long ownerId = db.users.findByEmail(email).orElseThrow().id();
        for (String ip : List.of("10.0.1.1", "10.0.1.2", "10.0.1.3")) {
            for (int i = 0; i < 3; i++) {   // 주소마다 3번 — 무료 시도(5) 안이라 모두 바로 401
                assertThat(login(email, "wrong", ip).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
            }
        }

        assertThat(db.jdbc.queryForList("SELECT detail->>'failures' FROM audit_log WHERE user_id = ? "
                + "AND action = 'login.failure' ORDER BY id", String.class, ownerId))
                .as("남은 실패 기록의 실패 수").containsExactly("1", "5", "8");
        assertThat(login(email, "right-password-1", "10.0.1.4").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(db.jdbc.queryForObject("SELECT detail->>'priorFailures' FROM audit_log WHERE user_id = ? "
                + "AND action = 'login.success' ORDER BY id DESC LIMIT 1", String.class, ownerId))
                .as("성공 직전 실패 수(모든 주소 합)").isEqualTo("9");
    }

    @Test
    @DisplayName("QA-024 비밀번호 변경·탈퇴의 '지금 비밀번호' 확인도 연속 실패하면 느려지고 429 — 훔친 세션으로 대입하지 못하게")
    void reauthenticationIsThrottled() {
        long memberId = db.user("member", "member-password-1", "MEMBER", "FREE");
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("10.0.0.9");
        request.setAttribute(CurrentUser.ATTRIBUTE,
                new CurrentUser(memberId, db.email("member"), "MEMBER", "FREE", null, false));

        for (int i = 0; i < 5; i++) {   // 무료 시도 5회 (LoginThrottle.FREE_ATTEMPTS)
            assertThat(controller.changePassword(new AuthController.PasswordRequest("wrong", "new-password-12345"), request)
                    .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        }
        assertThat(controller.changePassword(new AuthController.PasswordRequest("wrong", "new-password-12345"), request)
                .getStatusCode()).as("비밀번호 변경").isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(controller.deleteAccount(new AuthController.DeleteRequest("wrong"), request).getStatusCode())
                .as("탈퇴도 같은 사용자 기록").isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(controller.changePassword(new AuthController.PasswordRequest("member-password-1", "new-password-12345"),
                request).getStatusCode()).as("맞는 비밀번호는 그래도 통과").isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("QA-068 비밀번호 재확인은 로그인과 느린 차선을 나눠 쓴다 — 로그인 대입 중에도 재확인이 '처리 중' 429를 받지 않는다")
    void reauthenticationHasItsOwnSlowLane() throws Exception {
        long memberId = db.user("member", "member-password-1", "MEMBER", "FREE");
        CountDownLatch inSlowLane = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Thread[] loginThread = new Thread[1];
        LoginThrottle throttle = new LoginThrottle(java.time.Clock.systemUTC(), millis -> {
            if (Thread.currentThread() == loginThread[0]) {   // 로그인 쪽 느린 시도만 차선을 붙잡고 기다린다
                inSlowLane.countDown();
                release.await(5, TimeUnit.SECONDS);
            }
        });
        AuthController separate = new AuthController(db.service(properties), accounts, throttle, properties);
        MockHttpServletRequest loginRequest = new MockHttpServletRequest();
        loginRequest.setRemoteAddr("10.0.0.7");
        for (int i = 0; i < 5; i++) {
            separate.login(new AuthController.LoginRequest(db.email("owner"), "wrong"), loginRequest);
        }
        loginThread[0] = new Thread(() ->
                separate.login(new AuthController.LoginRequest(db.email("owner"), "wrong"), loginRequest));
        loginThread[0].start();
        assertThat(inSlowLane.await(5, TimeUnit.SECONDS)).isTrue();
        try {
            MockHttpServletRequest request = new MockHttpServletRequest();
            request.setAttribute(CurrentUser.ATTRIBUTE,
                    new CurrentUser(memberId, db.email("member"), "MEMBER", "FREE", null, false));
            for (int i = 0; i < 5; i++) {
                separate.changePassword(new AuthController.PasswordRequest("wrong", "new-password-12345"), request);
            }
            ResponseEntity<Map<String, Object>> slowed =
                    separate.changePassword(new AuthController.PasswordRequest("wrong", "new-password-12345"), request);

            assertThat(String.valueOf(slowed.getBody().get("message"))).doesNotContain("다른 확인 요청");
        } finally {
            release.countDown();
            loginThread[0].join(5000);
        }
    }

    @Test
    @DisplayName("QA-068 비밀번호 변경·탈퇴는 지금 비밀번호를 한 번만 확인한다(Argon2 16MB를 요청마다 한 번 더 돌리지 않게)")
    void currentPasswordIsVerifiedOnce() {
        long memberId = db.user("member", "member-password-1", "MEMBER", "FREE");
        AtomicInteger checks = new AtomicInteger();
        PasswordEncoder argon = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();
        PasswordHasher counting = new PasswordHasher(new PasswordEncoder() {
            @Override
            public String encode(CharSequence raw) {
                return argon.encode(raw);
            }

            @Override
            public boolean matches(CharSequence raw, String encoded) {
                checks.incrementAndGet();
                return argon.matches(raw, encoded);
            }
        });
        AccountMail mail = org.mockito.Mockito.mock(AccountMail.class);
        AuthController counted = new AuthController(
                new AuthService(properties, db.users, db.sessions, db.audit, counting),
                new AccountService(db.users, db.sessions, new com.macrodash.store.EmailTokenStore(db.jdbc), db.audit,
                        counting, mail),
                new LoginThrottle(java.time.Clock.systemUTC(), millis -> { }), properties);
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setAttribute(CurrentUser.ATTRIBUTE,
                new CurrentUser(memberId, db.email("member"), "MEMBER", "FREE", null, false));

        assertThat(counted.deleteAccount(new AuthController.DeleteRequest("wrong"), request).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(checks.get()).as("탈퇴: 지금 비밀번호 확인 한 번").isEqualTo(1);

        checks.set(0);
        assertThat(counted.changePassword(new AuthController.PasswordRequest("member-password-1", "new-password-12345"),
                request).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(checks.get()).as("변경: 지금 비밀번호 한 번 + 새 비밀번호가 같은지 한 번").isEqualTo(2);
    }

    @Test
    @DisplayName("세션 확인은 로그인돼 있을 때만 사용자·읽기 모드를 함께 준다")
    void sessionCarriesUserOnlyWhenAuthenticated() {
        properties.setReadMode("store_only");
        assertThat(controller.session(new MockHttpServletRequest()))
                .containsEntry("authenticated", false)
                .doesNotContainKey("readMode").doesNotContainKey("user");

        MockHttpServletRequest signedIn = new MockHttpServletRequest();
        signedIn.setCookies(new jakarta.servlet.http.Cookie(AuthService.COOKIE_NAME,
                token(login(db.email("owner"), "right-password-1", "10.0.0.9"))));
        Map<String, Object> session = controller.session(signedIn);
        assertThat(session).containsEntry("authenticated", true).containsEntry("readMode", "store_only");
        assertThat(String.valueOf(((Map<?, ?>) session.get("user")).get("email"))).isEqualTo(db.email("owner"));
    }

    @Test
    @DisplayName("데모 열람(ADR 0013): 세션 없이 맞는 헤더면 authenticated + user.demo(일반 회원·유료, 이메일 없음), 세션이 있으면 세션")
    void sessionReportsDemoViewer() {
        AppProperties demoProperties = new AppProperties();
        demoProperties.setReadMode("store_only");
        demoProperties.setDemoViewerToken(DemoViewerTest.TOKEN);
        AuthController demo = new AuthController(db.service(demoProperties), accounts,
                new LoginThrottle(java.time.Clock.systemUTC(), millis -> { }), demoProperties);

        MockHttpServletRequest visitor = new MockHttpServletRequest();
        visitor.addHeader(DemoViewer.HEADER, DemoViewerTest.TOKEN);
        Map<String, Object> session = demo.session(visitor);
        assertThat(session).containsEntry("authenticated", true).containsEntry("readMode", "store_only");
        Map<?, ?> user = (Map<?, ?>) session.get("user");
        assertThat(user.get("demo")).isEqualTo(true);
        assertThat(user.get("role")).isEqualTo("MEMBER");
        assertThat(user.get("tier")).isEqualTo("PRO");
        assertThat(user.containsKey("email")).as("이메일 칸은 있되 값이 없음(자리표시 이메일을 만들지 않음)").isTrue();
        assertThat(user.get("email")).isNull();

        MockHttpServletRequest wrong = new MockHttpServletRequest();
        wrong.addHeader(DemoViewer.HEADER, "not-the-token");
        assertThat(demo.session(wrong)).containsEntry("authenticated", false).doesNotContainKey("user");
        MockHttpServletRequest offHeader = new MockHttpServletRequest();
        offHeader.addHeader(DemoViewer.HEADER, DemoViewerTest.TOKEN);
        assertThat(controller.session(offHeader)).as("기능이 꺼진 컨트롤러는 헤더를 보지 않음")
                .containsEntry("authenticated", false);

        MockHttpServletRequest owner = new MockHttpServletRequest();
        owner.addHeader(DemoViewer.HEADER, DemoViewerTest.TOKEN);
        owner.setCookies(new jakarta.servlet.http.Cookie(AuthService.COOKIE_NAME,
                token(login(db.email("owner"), "right-password-1", "10.0.0.10"))));
        Map<?, ?> ownerUser = (Map<?, ?>) demo.session(owner).get("user");
        assertThat(ownerUser.get("demo")).as("세션이 이김").isEqualTo(false);
        assertThat(ownerUser.get("role")).isEqualTo("OWNER");
        assertThat(ownerUser.get("email")).isEqualTo(db.email("owner"));
    }

    private AuthController controller(AuthService auth, AppProperties props) {
        return new AuthController(auth, accounts, new LoginThrottle(java.time.Clock.systemUTC(), millis -> { }), props);
    }

    private static AppProperties localNoLogin() {
        AppProperties props = new AppProperties();
        props.setLocalNoLogin(true);
        return props;
    }

    @Test
    @DisplayName("로그인 모드(기본): noLogin·ownerMissing은 false로 늘 있고, 로그인한 사용자의 user.local은 false")
    void sessionReportsLoginMode() {
        assertThat(controller.session(new MockHttpServletRequest()))
                .containsEntry("authenticated", false).containsEntry("noLogin", false).containsEntry("ownerMissing", false);

        ResponseEntity<Map<String, Object>> login = login(db.email("owner"), "right-password-1", "10.0.0.12");
        assertThat(((Map<?, ?>) login.getBody().get("user")).get("local")).as("로그인 응답의 사용자").isEqualTo(false);
        MockHttpServletRequest signedIn = new MockHttpServletRequest();
        signedIn.setCookies(new jakarta.servlet.http.Cookie(AuthService.COOKIE_NAME, token(login)));
        Map<String, Object> session = controller.session(signedIn);
        assertThat(session).containsEntry("noLogin", false).containsEntry("ownerMissing", false);
        assertThat(((Map<?, ?>) session.get("user")).get("local")).isEqualTo(false);
    }

    @Test
    @DisplayName("로컬 무로그인(ADR 0016): 이 맥 요청은 쿠키 없이 첫 운영자(user.local), 쿠키가 있으면 그 계정, 이 맥이 아니면 로그인 필요")
    void sessionReportsLocalNoLogin() {
        AppProperties props = localNoLogin();
        props.setReadMode("store_only");
        AuthController on = controller(db.service(props), props);
        UserStore.User first = db.users.firstOwner().orElseThrow();   // 이 테스트가 만든 운영자보다 먼저인 운영자일 수 있음

        Map<String, Object> session = on.session(new MockHttpServletRequest());   // Host: localhost
        assertThat(session).containsEntry("authenticated", true).containsEntry("noLogin", true)
                .containsEntry("ownerMissing", false).containsEntry("readMode", "store_only");
        Map<?, ?> user = (Map<?, ?>) session.get("user");
        assertThat(user.get("local")).isEqualTo(true);
        assertThat(user.get("demo")).isEqualTo(false);
        assertThat(user.get("role")).isEqualTo("OWNER");
        assertThat(user.get("email")).isEqualTo(first.email());

        MockHttpServletRequest signedIn = new MockHttpServletRequest();
        signedIn.setCookies(new jakarta.servlet.http.Cookie(AuthService.COOKIE_NAME,
                token(login(db.email("owner"), "right-password-1", "10.0.0.13"))));
        Map<?, ?> cookieUser = (Map<?, ?>) on.session(signedIn).get("user");
        assertThat(cookieUser.get("local")).as("쿠키 세션이 먼저").isEqualTo(false);
        assertThat(cookieUser.get("email")).isEqualTo(db.email("owner"));

        MockHttpServletRequest lan = new MockHttpServletRequest();
        lan.setServerName("192.168.0.10");
        MockHttpServletRequest forwarded = new MockHttpServletRequest();
        forwarded.addHeader("X-Forwarded-For", "203.0.113.5");
        for (MockHttpServletRequest away : List.of(lan, forwarded)) {
            assertThat(on.session(away)).containsEntry("authenticated", false).containsEntry("noLogin", true)
                    .containsEntry("ownerMissing", false).doesNotContainKey("user");
        }
    }

    @Test
    @DisplayName("로컬 무로그인인데 운영자 계정이 없으면 이 맥 요청에만 ownerMissing — 화면은 로그인 대신 계정 설정 안내")
    void sessionReportsMissingOwner() {
        UserStore users = org.mockito.Mockito.mock(UserStore.class);
        org.mockito.Mockito.when(users.ready()).thenReturn(true);
        org.mockito.Mockito.when(users.count()).thenReturn(0L);
        org.mockito.Mockito.when(users.firstOwner()).thenReturn(java.util.Optional.empty());
        AppProperties props = localNoLogin();
        AuthController on = controller(new AuthService(props, users,
                org.mockito.Mockito.mock(com.macrodash.store.SessionStore.class),
                org.mockito.Mockito.mock(com.macrodash.store.AuditLogStore.class), db.hasher), props);

        assertThat(on.session(new MockHttpServletRequest())).containsEntry("authenticated", false)
                .containsEntry("noLogin", true).containsEntry("ownerMissing", true).doesNotContainKey("user");
        MockHttpServletRequest lan = new MockHttpServletRequest();
        lan.setServerName("192.168.0.10");
        assertThat(on.session(lan)).as("이 맥이 아니면 그냥 로그인 필요").containsEntry("ownerMissing", false);
    }

    @Test
    @DisplayName("비밀번호 변경: 규칙에 어긋나면 400, 맞으면 200")
    void changePassword() {
        String token = token(login(db.email("owner"), "right-password-1", "10.0.0.5"));
        AuthService auth = db.service(properties);
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setAttribute(CurrentUser.ATTRIBUTE, auth.authenticate(token).orElseThrow());

        assertThat(controller.changePassword(new AuthController.PasswordRequest("right-password-1", "short"), request)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(controller.changePassword(
                new AuthController.PasswordRequest("right-password-1", "a much longer passphrase"), request)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("본문 없는 로그인 요청은 500이 아니라 401")
    void missingBodyIs401() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("10.0.0.4");
        assertThat(controller.login(null, request).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }
}
