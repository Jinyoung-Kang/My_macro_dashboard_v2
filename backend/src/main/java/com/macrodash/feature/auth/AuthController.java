package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/**
 * 로그인 · 세션 확인 · 로그아웃 · 세션 목록 · 비밀번호 변경 (계정·DB 세션, ADR 0010).
 *
 * <p>세션 쿠키 속성
 * <ul>
 *   <li>HttpOnly — 스크립트가 읽을 수 없습니다(XSS로 토큰이 새지 않음).</li>
 *   <li>SameSite=Strict — 다른 사이트에서 시작된 요청에는 쿠키가 실리지 않습니다(CSRF 방어).
 *       화면(:3000)과 API(:8080)는 포트만 다르고 같은 사이트라 정상 동작합니다.</li>
 *   <li>Secure — dashboard.cookie-secure=true일 때만(HTTPS 전용 운영).</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService authService;
    private final AccountService accounts;
    private final LoginThrottle throttle;
    /** 비밀번호 재확인(변경·탈퇴)의 지연 — 로그인과 같은 규칙, 따로 쓰는 느린 차선(QA-068). */
    private final LoginThrottle reauthThrottle;
    private final AppProperties properties;
    /** Tailscale 신원 자동 로그인(ADR 0023) — 세션 응답이 필터와 같은 판정을 합니다. */
    private final TailnetLogin tailnetLogin;

    public AuthController(AuthService authService, AccountService accounts, LoginThrottle throttle,
                          AppProperties properties) {
        this.authService = authService;
        this.accounts = accounts;
        this.throttle = throttle;
        this.reauthThrottle = throttle.separateLane();
        this.properties = properties;
        this.tailnetLogin = new TailnetLogin(properties.getTailnetOwnerLogin(), properties.getFrontendOrigin());
    }

    public record LoginRequest(String email, String password) {
    }

    public record PasswordRequest(String current, String next) {
    }

    public record SignupRequest(String email, String password, Boolean agreed) {
    }

    public record TokenRequest(String token, String password) {
    }

    public record EmailRequest(String email) {
    }

    public record DeleteRequest(String password) {
    }

    /**
     * 이메일·비밀번호를 확인하고 세션 쿠키를 내려 줍니다.
     *
     * <p>연속 실패는 {@link LoginThrottle}이 (접속 주소, 이메일)마다 느리게 처리합니다 — 잠금이 아니라 지연이라
     * 맞는 비밀번호는 그래도 통과합니다. 없는 이메일과 틀린 비밀번호는 같은 응답입니다(계정 존재를 드러내지 않음).
     *
     * @return 200 성공 · 401 이메일 또는 비밀번호 틀림 · 429 연속 실패(Retry-After) 또는 다른 느린 시도가 진행 중
     */
    @PostMapping("/login")
    public ResponseEntity<Map<String, Object>> login(@RequestBody(required = false) LoginRequest request,
                                                     HttpServletRequest http) {
        String email = request == null ? null : request.email();
        String password = request == null ? null : request.password();
        String key = http.getRemoteAddr() + "|" + (email == null ? "" : email.trim().toLowerCase(Locale.ROOT));
        AtomicReference<AuthService.LoginResult> result = new AtomicReference<>();
        String userAgent = http.getHeader(HttpHeaders.USER_AGENT);
        LoginThrottle.Outcome outcome = throttle.attempt(key, () -> {
            result.set(authService.login(email, password, userAgent));
            return result.get().issued() != null || result.get().unverified();
        });

        if (outcome.busy()) {
            return tooMany(outcome.retryAfter(), "다른 로그인 시도를 처리하는 중입니다. 잠시 후 다시 시도하세요.");
        }
        if (!outcome.accepted()) {
            authService.recordFailure(email);
            if (!outcome.retryAfter().isZero()) {
                long seconds = seconds(outcome.retryAfter());
                return tooMany(outcome.retryAfter(),
                        "로그인 실패가 반복됐습니다. " + seconds + "초 뒤에 다시 시도하세요.");
            }
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("ok", false, "message", "이메일 또는 비밀번호가 올바르지 않습니다."));
        }

        if (result.get().unverified()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("ok", false, "error", "unverified",
                    "message", "메일 인증을 마친 뒤 로그인하세요. 받은 메일함(스팸함 포함)의 링크를 여세요."));
        }
        AuthService.Issued issued = result.get().issued();
        ResponseCookie cookie = sessionCookie(issued.token(), authService.sessionSeconds());
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie.toString())
                .body(Map.of("ok", true, "user", userMap(issued.user())));
    }

    /**
     * 세션 확인 — 로그인돼 있으면 사용자(이메일·역할·등급)와 읽기 모드를 줍니다. 화면은 이 값으로 메뉴를 고릅니다.
     * 막는 것은 백엔드(경로별 접근 정책)이고, 화면은 보여 줄지만 정합니다.
     *
     * <p>세션이 없어도 데모 열람 헤더가 맞으면(ADR 0013) {@code authenticated: true}와 {@code user.demo: true}
     * (일반 회원·유료 등급, 이메일 없음)를 줍니다. 화면은 이 값으로 로그아웃·계정 메뉴와 쓰기 버튼을 숨깁니다.
     *
     * <p>로컬 무로그인 모드(ADR 0016)면 {@code noLogin: true}이고, 이 맥에서 온 쿠키 없는 요청은 첫 운영자로
     * {@code user.local: true}가 됩니다. 운영자 계정이 없으면 {@code ownerMissing: true}(화면은 계정 설정 안내).
     * 화면은 {@code noLogin}이 정확히 true일 때만 로그인 화면을 건너뜁니다 — 없거나 false면 로그인 모드(AWS·옛 백엔드).
     *
     * <p>Tailscale 신원 자동 로그인(ADR 0023)으로 온 요청도 {@code noLogin: true}이고 운영자는 {@code user.tailnet: true}(화면은 로그아웃 대신
     * 'Tailscale · 로그인 없음')입니다.
     */
    @GetMapping("/session")
    public Map<String, Object> session(HttpServletRequest request) {
        boolean tailnet = tailnetLogin.matches(request);
        boolean noLogin = authService.localNoLogin() || tailnet;
        boolean local = (authService.localNoLogin() && LocalNoLogin.isLocalRequest(request)) || tailnet;
        Optional<CurrentUser> user = authService.resolve(readToken(request), request.getHeader(DemoViewer.HEADER),
                authService.localNoLogin() && LocalNoLogin.isLocalRequest(request), tailnet);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("authenticated", user.isPresent());
        // 로그인 화면이 가입·재설정 링크를 보여 줄지 정합니다(메일 발송이 설정됐을 때만).
        out.put("mailAvailable", accounts.mailConfigured());
        out.put("noLogin", noLogin);
        // 이 맥에서 왔는데 사용자가 없음 = 유효한 쿠키도, 운영자 계정도 없음(데모 헤더가 붙은 요청은 이 맥 요청이 아님).
        out.put("ownerMissing", local && user.isEmpty());
        user.ifPresent(current -> {
            out.put("readMode", properties.resolvedReadMode().name().toLowerCase(Locale.ROOT));
            out.put("user", userMap(current, tailnet));
        });
        return out;
    }

    /** 로그아웃 — 쿠키를 지우고, 그 세션도 서버에서 끊습니다(쿠키 값이 남아 있어도 못 씀, 재시작 후에도). */
    @PostMapping("/logout")
    public ResponseEntity<Map<String, Object>> logout(HttpServletRequest request) {
        authService.logout(readToken(request));
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, sessionCookie("", 0).toString())
                .body(Map.of("ok", true));
    }

    /** 다른 기기에서 모두 로그아웃(지금 기기는 남김). */
    @PostMapping("/logout-all")
    public Map<String, Object> logoutOthers(HttpServletRequest request) {
        int count = authService.logoutOthers(CurrentUser.of(request));
        return Map.of("ok", true, "revoked", count);
    }

    /** 내 로그인 세션 목록(기기·마지막 사용 시각). */
    @GetMapping("/sessions")
    public Map<String, Object> sessions(HttpServletRequest request) {
        return Map.of("sessions", authService.sessionsOf(CurrentUser.of(request)));
    }

    /** 비밀번호 변경 — 지금 비밀번호 확인, 규칙 검사, 다른 기기 세션은 끊음. */
    @PostMapping("/password")
    public ResponseEntity<Map<String, Object>> changePassword(@RequestBody(required = false) PasswordRequest body,
                                                              HttpServletRequest request) {
        if (body == null) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", "요청 본문이 없습니다."));
        }
        CurrentUser user = CurrentUser.of(request);
        AtomicReference<String> problem = new AtomicReference<>();
        ResponseEntity<Map<String, Object>> slowed = reauthenticate(user, () -> {
            problem.set(authService.changePassword(user, body.current(), body.next()));
            return !AuthService.WRONG_CURRENT.equals(problem.get());
        });
        if (slowed != null) {
            return slowed;
        }
        if (problem.get() != null) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", problem.get()));
        }
        return ResponseEntity.ok(Map.of("ok", true, "message", "비밀번호를 바꿨습니다. 다른 기기의 로그인은 끊었습니다."));
    }

    /** 가입 — 이메일이 이미 있어도 같은 응답(그 주소의 주인에게만 안내 메일). */
    @PostMapping("/signup")
    public ResponseEntity<Map<String, Object>> signup(@RequestBody(required = false) SignupRequest body,
                                                      HttpServletRequest http) {
        return respond(body == null ? AccountService.Result.bad("요청 본문이 없습니다.")
                : accounts.signup(body.email(), body.password(), Boolean.TRUE.equals(body.agreed()),
                        http.getRemoteAddr()));
    }

    /** 메일 인증 링크(화면 /verify가 토큰을 넘김). */
    @PostMapping("/verify")
    public ResponseEntity<Map<String, Object>> verify(@RequestBody(required = false) TokenRequest body) {
        return respond(accounts.verify(body == null ? null : body.token()));
    }

    /** 비밀번호 재설정 메일 요청 — 가입 여부와 무관하게 같은 응답. */
    @PostMapping("/reset/request")
    public ResponseEntity<Map<String, Object>> requestReset(@RequestBody(required = false) EmailRequest body,
                                                            HttpServletRequest http) {
        return respond(accounts.requestReset(body == null ? null : body.email(), http.getRemoteAddr()));
    }

    /** 재설정 링크 + 새 비밀번호 — 성공하면 모든 기기 로그아웃. */
    @PostMapping("/reset/confirm")
    public ResponseEntity<Map<String, Object>> confirmReset(@RequestBody(required = false) TokenRequest body) {
        return respond(body == null ? AccountService.Result.bad("요청 본문이 없습니다.")
                : accounts.confirmReset(body.token(), body.password()));
    }

    /** 계정 삭제 — 비밀번호 재확인, 개인정보 즉시 삭제, 쿠키도 지움. */
    @PostMapping("/delete")
    public ResponseEntity<Map<String, Object>> deleteAccount(@RequestBody(required = false) DeleteRequest body,
                                                             HttpServletRequest http) {
        CurrentUser user = CurrentUser.of(http);
        AtomicReference<AccountService.Result> outcome = new AtomicReference<>();
        ResponseEntity<Map<String, Object>> slowed = reauthenticate(user, () -> {
            outcome.set(accounts.deleteAccount(user, body == null ? null : body.password()));
            return !AccountService.WRONG_PASSWORD.equals(outcome.get().message());
        });
        if (slowed != null) {
            return slowed;
        }
        AccountService.Result result = outcome.get();
        ResponseEntity<Map<String, Object>> response = respond(result);
        if (result.status() != 200) {
            return response;
        }
        return ResponseEntity.ok().header(HttpHeaders.SET_COOKIE, sessionCookie("", 0).toString()).body(response.getBody());
    }

    /**
     * 지금 비밀번호 재확인에도 로그인과 같은 지연을 겁니다(사용자 번호마다, QA-024). 세션을 훔친 사람이 비밀번호 변경·탈퇴로
     * 지금 비밀번호를 제한 없이 대입하지 못하게 합니다. 지연에 걸리면 429 응답, 아니면 null.
     *
     * <p>{@code verifyAndAct}가 서비스 작업 자체입니다 — 비밀번호 확인은 서비스 안에서 한 번만 하고(Argon2 16MB를 요청마다
     * 두 번 돌리지 않게, QA-068), 지금 비밀번호가 틀렸을 때만 false를 돌려줘 실패로 기록합니다.
     */
    private ResponseEntity<Map<String, Object>> reauthenticate(CurrentUser user, BooleanSupplier verifyAndAct) {
        LoginThrottle.Outcome outcome = reauthThrottle.attempt("reauth|" + user.id(), verifyAndAct);
        if (outcome.busy()) {
            return tooMany(outcome.retryAfter(), "다른 확인 요청을 처리하는 중입니다. 잠시 후 다시 시도하세요.");
        }
        if (!outcome.accepted() && !outcome.retryAfter().isZero()) {
            return tooMany(outcome.retryAfter(),
                    "비밀번호 확인 실패가 반복됐습니다. " + seconds(outcome.retryAfter()) + "초 뒤에 다시 시도하세요.");
        }
        return null;
    }

    private static ResponseEntity<Map<String, Object>> respond(AccountService.Result result) {
        return ResponseEntity.status(result.status())
                .body(Map.of("ok", result.status() == 200, "message", result.message()));
    }

    private static Map<String, Object> userMap(CurrentUser user) {
        return userMap(user, false);
    }

    private static Map<String, Object> userMap(CurrentUser user, boolean tailnet) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("email", user.email());
        out.put("role", user.role());
        out.put("tier", user.tier());
        out.put("demo", user.demo());
        out.put("local", user.isLocalOwner());
        out.put("tailnet", tailnet && user.isLocalOwner());
        return out;
    }

    /** 세션 쿠키 한 곳에서만 만듭니다(로그인·로그아웃 속성이 어긋나면 삭제가 안 됩니다). */
    private ResponseCookie sessionCookie(String value, long maxAgeSeconds) {
        return ResponseCookie.from(AuthService.COOKIE_NAME, value)
                .httpOnly(true)
                .secure(properties.isCookieSecure())
                .sameSite("Strict")
                .path("/")
                .maxAge(maxAgeSeconds)
                .build();
    }

    private static long seconds(Duration wait) {
        return Math.max(1, (wait.toMillis() + 999) / 1000);
    }

    private static ResponseEntity<Map<String, Object>> tooMany(Duration wait, String message) {
        long seconds = seconds(wait);
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, String.valueOf(seconds))
                .body(Map.of("ok", false, "retryAfterSeconds", seconds, "message", message));
    }

    /** 세션 쿠키 값을 꺼냅니다. 없으면 null. */
    public static String readToken(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie cookie : cookies) {
            if (AuthService.COOKIE_NAME.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
