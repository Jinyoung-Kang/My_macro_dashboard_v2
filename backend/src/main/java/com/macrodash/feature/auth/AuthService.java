package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import com.macrodash.store.AuditLogStore;
import com.macrodash.store.SessionStore;
import com.macrodash.store.UserStore;
import com.macrodash.support.CurrentUser;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/**
 * 계정 로그인과 DB 세션(ADR 0010).
 *
 * <p>예전에는 비밀번호 하나({@code APP_PASSWORD})와 서명 토큰(JWT)이었습니다. 로그아웃한 토큰을 막는 목록이
 * 메모리에 있어 재시작하면 사라졌고, 사용자가 한 명뿐이라 등급·권한을 나눌 수 없었습니다.
 *
 * <ul>
 *   <li>비밀번호는 Argon2id 해시만 둡니다. 없는 이메일도 가짜 해시와 비교해 응답 시간으로 계정 존재를 드러내지 않습니다.</li>
 *   <li>쿠키에는 32바이트 무작위 토큰, DB에는 그 SHA-256만 둡니다. DB가 새어도 쿠키를 만들 수 없습니다.</li>
 *   <li>처음 기동할 때 계정이 없으면 {@code OWNER_EMAIL}·{@code APP_PASSWORD}로 운영자 계정을 만듭니다 —
 *       지금까지의 사용 흐름이 이어집니다. 둘 중 하나라도 없으면 만들지 않고 무엇을 넣을지 로그로 알립니다.</li>
 *   <li>로컬 무로그인 모드(ADR 0016)가 켜져 있으면 이 맥에서 온 쿠키 없는 요청을 첫 운영자로 엽니다({@link #resolve}).</li>
 * </ul>
 */
@Service
public class AuthService {

    private static final Logger log = LoggerFactory.getLogger(AuthService.class);
    /**
     * 세션 쿠키 이름. 같은 맥에서 Local_macro_dashboard_v3(쿠키 {@code macro_session})와 My_macro_dashboard_v1({@code my_macro_session})이
     * 함께 돌고, 브라우저 쿠키는 포트를 가리지 않아(localhost:3000·:3001·:3002가 같은 쿠키를 봄) 이름이 같으면 한쪽 로그인이 다른 쪽 세션을
     * 덮어씁니다 — 그래서 따로 둡니다.
     */
    public static final String COOKIE_NAME = "my_macro_v2_session";

    /** 저장소·문서에 적혀 있던 옛 기본 비밀번호. 누구나 아는 값이라 운영자 계정에 쓰지 않습니다. */
    static final String PUBLIC_DEFAULT_PASSWORD = "admin1234@";
    /** 마지막 사용 시각 갱신 간격 — 요청마다 쓰지 않습니다. */
    static final Duration TOUCH_GAP = Duration.ofMinutes(5);
    static final int MAX_USER_AGENT = 120;
    /**
     * 주소 한 개만(로컬 64자 · 도메인 255자). 메일 문법에서 따옴표 없이는 못 쓰는 문자(꺾쇠·괄호·대괄호·쉼표·세미콜론·콜론·
     * 따옴표·역슬래시)를 받지 않습니다 — {@code x<a@b.com>}을 받으면 메일 라이브러리가 표시 이름 + 꺾쇠 안 주소로 읽어
     * 다른 주소로 보냈습니다(QA-026, 한 메일함으로 계정을 여럿 만들 수 있었음).
     */
    private static final Pattern EMAIL = Pattern.compile(
            "^[^@\\s<>()\\[\\]\\\\,;:\"]{1,64}@[^@\\s<>()\\[\\]\\\\,;:\"]{1,255}$");

    private final AppProperties properties;
    private final UserStore users;
    private final SessionStore sessions;
    private final AuditLogStore audit;
    private final PasswordHasher hasher;
    private final SecureRandom random = new SecureRandom();
    /** 데모 열람(ADR 0013). 토큰이 짧으면 여기서 예외 → 기동이 멈춥니다. */
    private final DemoViewer demo;
    /** 로그인 실패 중 감사 기록에 남길 표본(QA-125). 메모리에만 있습니다. */
    private final LoginFailureAudit loginAudit;
    /** 로컬 무로그인 모드(ADR 0016). 켜져도 되는 설정인지는 {@link LocalNoLogin}이 기동 때 확인합니다. */
    private final boolean localNoLogin;

    @Autowired
    public AuthService(AppProperties properties, UserStore users, SessionStore sessions, AuditLogStore audit,
                       PasswordHasher hasher) {
        this(properties, users, sessions, audit, hasher, Clock.systemUTC());
    }

    /** {@code clock}은 로그인 실패 표본의 시간 — 테스트가 한 시간 묶음을 기다리지 않게 바꿔 끼웁니다. */
    AuthService(AppProperties properties, UserStore users, SessionStore sessions, AuditLogStore audit,
                PasswordHasher hasher, Clock clock) {
        this.properties = properties;
        this.users = users;
        this.sessions = sessions;
        this.audit = audit;
        this.hasher = hasher;
        this.loginAudit = new LoginFailureAudit(clock);
        this.demo = DemoViewer.from(properties.getDemoViewerToken());
        this.localNoLogin = properties.isLocalNoLogin();
        if (demo.enabled()) {
            log.info("데모 열람이 켜져 있습니다(DASHBOARD_DEMO_VIEWER_TOKEN) — 앞단 프록시가 붙인 {} 헤더의 요청은 "
                    + "로그인 없이 읽기 전용으로 엽니다(ADR 0013).", DemoViewer.HEADER);
        }
    }

    /** 로그인 성공 — 쿠키에 넣을 토큰과 사용자. */
    public record Issued(String token, CurrentUser user) {
    }

    // ------------------------------------------------------------------ 운영자 계정 만들기
    /** 계정이 하나라도 있음을 확인했는가 — 확인한 뒤에는 정기 재시도를 하지 않습니다. */
    private volatile boolean ownerChecked;

    @EventListener(ApplicationReadyEvent.class)
    public void bootstrapOnStartup() {
        retryOwner();
    }

    /**
     * 기동 때 계정 테이블이 아직 없었으면(백엔드가 스키마 적용보다 먼저 뜬 경우) 1분마다 다시 확인합니다.
     * 첫 로그인 때도 확인하므로 로그인은 되지만, 운영자 계정이 언제 생기는지 로그로 바로 보이게 합니다.
     */
    @Scheduled(initialDelayString = "${dashboard.scheduler.owner-retry-ms:60000}",
            fixedDelayString = "${dashboard.scheduler.owner-retry-ms:60000}")
    public void retryOwner() {
        if (ownerChecked) {
            return;
        }
        try {
            ownerChecked = ensureOwner();
        } catch (RuntimeException e) {
            log.warn("운영자 계정 확인 실패 — 1분 뒤 다시 시도합니다: {}", e.toString());
        }
    }

    /**
     * 감사 기록 보존 기한(사용자 결정 2026-10-11) — 계정 사고를 되짚기에 충분합니다. 인증 없이 늘릴 수 있는 로그인 실패는
     * 표본만 남겨(QA-125, {@link LoginFailureAudit}) 1년치도 용량 부담이 없습니다.
     */
    static final Duration AUDIT_KEEP = Duration.ofDays(365);

    /** 1년 지난 감사 기록 정리. 세션 정리와 같은 주기, 실패하면 다음 주기에 다시 합니다. */
    @Scheduled(initialDelayString = "${dashboard.scheduler.auth-purge-initial-delay-ms:300000}",
            fixedDelayString = "${dashboard.scheduler.auth-purge-interval-ms:21600000}")
    public void purgeOldAuditLog() {
        if (!users.ready()) {
            return;
        }
        try {
            int removed = audit.purgeOlderThan(Instant.now().minus(AUDIT_KEEP));
            if (removed > 0) {
                log.info("1년 지난 감사 기록 {}건 정리", removed);
            }
        } catch (RuntimeException e) {
            log.warn("감사 기록 정리 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
        }
    }

    /** 로그인 실패 요약 행의 action — 한 시간 상한을 넘겨 개수만 센 없는 계정·메일 인증 전 계정 실패(QA-125). */
    static final String LOGIN_FAILURE_SUPPRESSED = "login.failure.suppressed";

    /**
     * 끝난 시간에 상한을 넘겨 개수만 센 없는 계정·메일 인증 전 계정 로그인 실패를 요약 한 줄로 남깁니다(QA-125). 쓰지 못하면 개수를 메모리에
     * 돌려놓고 다음 주기에 다시 합니다.
     */
    @Scheduled(initialDelayString = "${dashboard.scheduler.login-audit-flush-ms:300000}",
            fixedDelayString = "${dashboard.scheduler.login-audit-flush-ms:300000}")
    public void flushLoginFailureSummary() {
        writeSuppressed(false);
    }

    /**
     * 종료할 때는 아직 끝나지 않은 시간의 넘친 개수도 씁니다 — 재시작으로 잃지 않게. 빈을 정리할 때 쓰므로 웹 서버·스케줄러가
     * 멈춘 뒤이고, DB 연결 풀은 이 빈이 쓰는 저장소보다 늦게 닫혀 아직 살아 있습니다. 예전의 종료 이벤트(ContextClosedEvent)는
     * 웹 서버가 멈추기 전에 발행돼, 종료 중 마무리된 요청의 넘친 개수를 잃었습니다(QA-125).
     */
    @PreDestroy
    public void flushLoginFailureSummaryOnShutdown() {
        writeSuppressed(true);
    }

    private void writeSuppressed(boolean includeOpen) {
        try {
            if (!users.ready()) {
                return;
            }
        } catch (RuntimeException e) {
            log.warn("로그인 실패 요약을 쓰지 못했습니다 — 다음 주기에 다시 시도합니다: {}", e.toString());
            return;
        }
        loginAudit.takeSuppressed(includeOpen).ifPresent(summary -> {
            try {
                audit.append(null, LOGIN_FAILURE_SUPPRESSED, summary.detail());
            } catch (RuntimeException e) {
                loginAudit.putBack(summary);
                log.warn("로그인 실패 요약을 쓰지 못했습니다 — 다음 주기에 다시 시도합니다: {}", e.toString());
            }
        });
    }

    /** 만료·해지 뒤 이만큼 지난 세션은 지웁니다(로그인 기기 목록에도 보이지 않는 행). */
    static final Duration SESSION_KEEP_AFTER_END = Duration.ofDays(30);

    /**
     * 끝난 세션 정리(QA-027) — 예전에는 정리 함수만 있고 부르는 곳이 없어 로그인할 때마다 한 행씩 끝없이 쌓였습니다.
     * 실패하면(스키마 적용 전·DB 장애) 다음 주기에 다시 합니다.
     */
    @Scheduled(initialDelayString = "${dashboard.scheduler.auth-purge-initial-delay-ms:300000}",
            fixedDelayString = "${dashboard.scheduler.auth-purge-interval-ms:21600000}")
    public void purgeEndedSessions() {
        if (!users.ready()) {
            return;
        }
        try {
            int removed = sessions.purgeOlderThan(SESSION_KEEP_AFTER_END);
            if (removed > 0) {
                log.info("끝난 세션 {}건 정리", removed);
            }
        } catch (RuntimeException e) {
            log.warn("세션 정리 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
        }
    }

    /**
     * 계정이 하나도 없으면 운영자 계정을 만듭니다. 테이블이 아직 없거나(수집기가 V4 적용 전) 설정이 모자라면
     * 만들지 않습니다.
     *
     * @return 계정이 하나 이상 있으면 true
     */
    synchronized boolean ensureOwner() {
        if (!users.ready()) {
            log.warn("계정 테이블(V4)이 아직 없습니다. 수집기가 기동하며 스키마를 적용하면 로그인할 수 있습니다.");
            return false;
        }
        if (users.count() > 0) {
            return true;
        }
        String email = normalizeEmail(properties.getOwnerEmail());
        String password = properties.getPassword();
        if (email == null || password == null || password.isBlank() || PUBLIC_DEFAULT_PASSWORD.equals(password)) {
            log.warn("운영자 계정이 없습니다. .env에 OWNER_EMAIL(로그인 아이디로 쓸 이메일)과 APP_PASSWORD를 넣고 "
                    + "make up 하세요 — 그 전에는 로그인할 수 없습니다. (make setup이 APP_PASSWORD를 만들어 줍니다)");
            return false;
        }
        try {
            long id = users.insert(email, hasher.hash(password), "OWNER", "PRO", true);
            audit.append(id, "owner.created", Map.of("from", "APP_PASSWORD"));
            log.info("운영자 계정을 만들었습니다(OWNER_EMAIL). 이후 비밀번호는 화면에서 바꾸고, APP_PASSWORD는 더 읽지 않습니다.");
        } catch (DuplicateKeyException e) {
            // 두 인스턴스가 동시에 만들려 한 경우 — 이미 있으면 됩니다.
        }
        return true;
    }

    // ------------------------------------------------------------------ 로그인·세션
    /**
     * 이메일·비밀번호 확인.
     *
     * @return 맞으면 사용자 번호, 아니면 비어 있음. 없는 이메일도 같은 시간이 걸립니다.
     */
    public Optional<UserStore.User> verify(String email, String password) {
        if (!ensureOwner()) {
            hasher.matchesDummy(password);
            return Optional.empty();
        }
        String normalized = normalizeEmail(email);
        Optional<UserStore.User> user = normalized == null ? Optional.empty() : users.findByEmail(normalized);
        if (user.isEmpty()) {
            hasher.matchesDummy(password);
            return Optional.empty();
        }
        return hasher.matches(password, user.get().passwordHash()) ? user : Optional.empty();
    }

    /** 확인된 사용자에게 새 세션을 엽니다. 성공 기록에는 그 직전의 연속 실패 수가 붙습니다(QA-125, 있을 때만). */
    public Issued openSession(UserStore.User user, String userAgent) {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        UUID sessionId = sessions.create(user.id(), hash(token), Instant.now().plusSeconds(sessionSeconds()),
                trimAgent(userAgent));
        audit.append(user.id(), "login.success", priorFailures(loginAudit.closeWindow(user.id())));
        return new Issued(token, new CurrentUser(user.id(), user.email(), user.role(), user.tier(), sessionId));
    }

    /**
     * 로그인 결과. 비밀번호가 맞아도 메일 인증 전이면 세션을 열지 않습니다({@code unverified}).
     * 비밀번호가 틀리면 둘 다 비어 있습니다 — 인증 여부는 비밀번호를 아는 사람에게만 알려 줍니다.
     * 인증 전 계정의 맞는 비밀번호는 감사 기록에 따로 남기지 않습니다. 계정마다 실패를 세지 않으므로(QA-125) 붙일 직전 실패 수가
     * 없고, 실패 수 없이 매번 남기면 자기 인증 전 계정으로 틀림·맞음을 번갈아 보내 행을 끝없이 늘릴 수 있습니다.
     */
    public record LoginResult(Issued issued, boolean unverified) {
    }

    public LoginResult login(String email, String password, String userAgent) {
        Optional<UserStore.User> user = verify(email, password);
        if (user.isEmpty()) {
            return new LoginResult(null, false);
        }
        if (user.get().emailVerifiedAt() == null) {
            return new LoginResult(null, true);
        }
        return new LoginResult(openSession(user.get(), userAgent), false);
    }

    /**
     * 로그인 실패를 감사 기록에 남깁니다 — 실패마다가 아니라 표본만(QA-125, 규칙은 {@link LoginFailureAudit}).
     * 메일 인증을 마친 계정은 사용자 번호와 그 묶음의 실패 수({@code failures}), 없는 계정은 이메일(형식이 맞을 때)을 남깁니다.
     * 메일 인증 전 계정은 가입으로 누구나 만들 수 있어 계정마다 세지 않고 없는 계정과 같은 한 시간 몫에 넣습니다 — 사용자 번호와
     * {@code unverified}만 남기고 이메일은 넣지 않습니다(탈퇴하면 번호만 비워져 이메일이 남지 않게). 비밀번호·접속 주소는 남기지 않습니다.
     */
    public void recordFailure(String email) {
        if (!users.ready()) {
            return;
        }
        String normalized = normalizeEmail(email);
        UserStore.User user = normalized == null ? null : users.findByEmail(normalized).orElse(null);
        if (user != null && user.emailVerifiedAt() != null) {
            Map<String, Object> detail = loginAudit.knownFailure(user.id());
            if (detail != null) {
                audit.append(user.id(), "login.failure", detail);
            }
            return;
        }
        Map<String, Object> detail = loginAudit.unknownFailure(user == null ? normalized : null);
        if (detail == null) {
            return;
        }
        if (user != null) {
            detail.put("unverified", true);
        }
        audit.append(user == null ? null : user.id(), "login.failure", detail);
    }

    /** 성공 기록 detail — 직전 연속 실패가 있었을 때만 {@code priorFailures}. */
    private static Map<String, Object> priorFailures(int prior) {
        Map<String, Object> detail = new LinkedHashMap<>();
        if (prior > 0) {
            detail.put("priorFailures", prior);
        }
        return detail;
    }

    /** 쿠키 토큰 → 사용자. 해지·만료·없는 토큰이면 비어 있음. */
    public Optional<CurrentUser> authenticate(String token) {
        if (token == null || token.isBlank() || token.length() > 100 || !users.ready()) {
            return Optional.empty();
        }
        return sessions.findActive(hash(token)).map(active -> {
            if (active.lastSeenAt() == null || active.lastSeenAt().isBefore(Instant.now().minus(TOUCH_GAP))) {
                sessions.touch(active.sessionId(), TOUCH_GAP);
            }
            return new CurrentUser(active.userId(), active.email(), active.role(), active.tier(), active.sessionId());
        });
    }

    /**
     * 요청의 사용자 — 세션 쿠키가 먼저, 다음이 데모 열람 헤더(ADR 0013), 마지막이 로컬 무로그인 운영자(ADR 0016)입니다.
     *
     * @param demoHeader   {@link DemoViewer#HEADER} 값(없으면 null). 기능이 꺼져 있으면 보지 않습니다.
     * @param localRequest 이 맥에서 앞단 없이 바로 온 요청인가({@link LocalNoLogin#isLocalRequest}). 로컬 무로그인이
     *                     꺼져 있으면 보지 않습니다.
     */
    public Optional<CurrentUser> resolve(String token, String demoHeader, boolean localRequest) {
        Optional<CurrentUser> session = authenticate(token);
        if (session.isPresent()) {
            return session;
        }
        if (demo.matches(demoHeader)) {
            return Optional.of(DemoViewer.user());
        }
        if (localNoLogin && localRequest) {
            return localOwner();
        }
        return Optional.empty();
    }

    /** 로컬 무로그인 모드가 켜져 있는가(ADR 0016). */
    public boolean localNoLogin() {
        return localNoLogin;
    }

    /**
     * 로컬 무로그인 운영자 — 첫 운영자 계정에 세션 없이({@code sessionId} null) 엽니다. 요청마다 읽으므로 역할·등급
     * 변경이 다음 요청에 바로 반영됩니다. 세션·감사 기록은 만들지 않습니다(요청마다 행이 쌓이지 않게).
     *
     * <p>운영자가 없으면 기동 때와 같은 확인({@link #retryOwner})을 한 번 하고 다시 봅니다 — 백엔드가 스키마 적용보다
     * 먼저 떠 아직 계정을 못 만든 경우. 그래도 없으면 비어 있음(평소처럼 401, 화면은 계정 설정 안내).
     */
    private Optional<CurrentUser> localOwner() {
        Optional<UserStore.User> owner = firstOwner();
        if (owner.isEmpty() && claimLocalOwnerRetry()) {
            retryOwner();
            owner = firstOwner();
        }
        return owner.map(user -> new CurrentUser(user.id(), user.email(), user.role(), user.tier(), null, false));
    }

    /** 요청 경로에서 운영자 계정 만들기를 다시 확인한 시각(나노초, 아직 없으면 MIN_VALUE). */
    private final AtomicLong lastLocalOwnerRetry = new AtomicLong(Long.MIN_VALUE);

    /**
     * 요청 경로의 재확인은 1분에 한 번만(정기 재확인과 같은 간격) — 운영자가 없는 동안 화면이 세션을 5초마다 다시 묻는데,
     * 그때마다 {@link #ensureOwner}의 잠금과 경고 한 줄이 쌓이지 않게 합니다.
     */
    private boolean claimLocalOwnerRetry() {
        long now = System.nanoTime();
        long last = lastLocalOwnerRetry.get();
        boolean due = last == Long.MIN_VALUE || now - last >= LOCAL_OWNER_RETRY_NANOS;
        return due && lastLocalOwnerRetry.compareAndSet(last, now);
    }

    private static final long LOCAL_OWNER_RETRY_NANOS = TimeUnit.MINUTES.toNanos(1);

    private Optional<UserStore.User> firstOwner() {
        return users.ready() ? users.firstOwner() : Optional.empty();
    }

    /** 이 헤더 값이 데모 열람 토큰인가(기능이 꺼져 있으면 늘 false). 세션은 보지 않습니다. */
    public boolean isDemoViewer(String demoHeader) {
        return demo.matches(demoHeader);
    }

    public void logout(String token) {
        authenticate(token).ifPresent(user -> sessions.revoke(user.sessionId()));
    }

    /** 이 사용자의 다른 기기 세션을 모두 끊습니다(지금 세션은 남김). */
    public int logoutOthers(CurrentUser user) {
        int count = sessions.revokeAllForUser(user.id(), user.sessionId());
        audit.append(user.id(), "logout.others", Map.of("sessions", count));
        return count;
    }

    public List<Map<String, Object>> sessionsOf(CurrentUser user) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (SessionStore.Listed listed : sessions.activeForUser(user.id())) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", listed.sessionId().toString());
            row.put("current", listed.sessionId().equals(user.sessionId()));
            row.put("createdAt", String.valueOf(listed.createdAt()));
            row.put("lastSeenAt", String.valueOf(listed.lastSeenAt()));
            row.put("expiresAt", String.valueOf(listed.expiresAt()));
            row.put("userAgent", listed.userAgent());
            out.add(row);
        }
        return out;
    }

    /** 지금 비밀번호가 틀렸을 때의 문구 — 컨트롤러가 재확인 실패(지연 기록)와 다른 거절(규칙 위반)을 가르는 데 씀. */
    public static final String WRONG_CURRENT = "지금 비밀번호가 올바르지 않습니다.";

    /**
     * 비밀번호 변경 — 지금 비밀번호를 확인하고, 다른 기기 세션은 모두 끊습니다. 저장·해지·감사 기록은 한 트랜잭션입니다
     * (QA-128 — 중간에 실패하면 비밀번호도 그대로라 '바뀌었는데 다른 세션이 살아 있음'이 생기지 않습니다).
     *
     * @return 문제가 있으면 사람이 읽는 이유, 성공이면 null
     */
    public String changePassword(CurrentUser user, String current, String next) {
        UserStore.User stored = users.findById(user.id()).orElse(null);
        if (stored == null || !hasher.matches(current, stored.passwordHash())) {
            return WRONG_CURRENT;
        }
        String problem = PasswordPolicy.problem(next, stored.email());
        if (problem != null) {
            return problem;
        }
        if (hasher.matches(next, stored.passwordHash())) {
            return "지금과 다른 비밀번호를 쓰세요.";
        }
        String hash = hasher.hash(next);   // 트랜잭션 밖에서 — Argon2 동안 DB 연결을 쥐지 않게
        users.atomically(() -> {
            users.updatePassword(user.id(), hash);
            int others = sessions.revokeAllForUser(user.id(), user.sessionId());
            audit.append(user.id(), "password.changed", Map.of("otherSessionsRevoked", others));
            return others;
        });
        return null;
    }

    public long sessionSeconds() {
        return properties.getSessionMinutes() * 60;
    }

    // ------------------------------------------------------------------ 보조
    /** 이메일을 비교용으로 다듬습니다. 형식이 아니면 null. */
    static String normalizeEmail(String email) {
        if (email == null) {
            return null;
        }
        String trimmed = email.trim().toLowerCase(Locale.ROOT);
        return EMAIL.matcher(trimmed).matches() ? trimmed : null;
    }

    static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 쓸 수 없습니다", e);
        }
    }

    private static String trimAgent(String userAgent) {
        if (userAgent == null) {
            return null;
        }
        return userAgent.length() > MAX_USER_AGENT ? userAgent.substring(0, MAX_USER_AGENT) : userAgent;
    }
}
