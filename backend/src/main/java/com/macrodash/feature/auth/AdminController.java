package com.macrodash.feature.auth;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 사용자 관리(운영자만 — 접근 정책 표가 막음).
 *
 * <pre>
 *  GET  /api/admin/users          사용자 목록
 *  POST /api/admin/users          회원 만들기 {email, password, tier}
 *  POST /api/admin/users/{id}     역할·등급 지정 {role, tier, password} — password는 회원을 운영자로 올릴 때만(요청자 계정의 비밀번호, QA-338)
 *  GET  /api/admin/audit          감사 기록(최근 순)
 * </pre>
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminService admin;
    /** 운영자로 올릴 때의 비밀번호 확인에 거는 연속 실패 지연 — 로그인·비밀번호 재확인과 기록·느린 차선을 따로 씁니다(QA-068과 같은 이유). */
    private final LoginThrottle promoteThrottle;

    public AdminController(AdminService admin, LoginThrottle throttle) {
        this.admin = admin;
        this.promoteThrottle = throttle.separateLane();
    }

    public record CreateRequest(String email, String password, String tier) {
    }

    public record UpdateRequest(String role, String tier, String password) {
    }

    @GetMapping("/users")
    public Map<String, Object> users() {
        return Map.of("users", admin.users());
    }

    @PostMapping("/users")
    public ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) CreateRequest body,
                                                      HttpServletRequest request) {
        String problem = body == null ? "요청 본문이 없습니다."
                : admin.create(CurrentUser.of(request), body.email(), body.password(), body.tier());
        return result(problem, "회원을 만들었습니다. 처음 비밀번호를 전달하고 내 계정에서 바꾸도록 안내하세요.");
    }

    @PostMapping("/users/{id}")
    public ResponseEntity<Map<String, Object>> update(@PathVariable long id,
                                                      @RequestBody(required = false) UpdateRequest body,
                                                      HttpServletRequest request) {
        String success = "바꿨습니다. 그 사용자의 다음 요청부터 반영됩니다.";
        if (body == null) {
            return result("요청 본문이 없습니다.", success);
        }
        CurrentUser user = CurrentUser.of(request);
        if (!admin.promotes(id, body.role())) {
            return result(admin.update(user, id, body.role(), body.tier()), success);
        }
        // 회원을 운영자로 올리는 요청 — 요청자 계정의 비밀번호를 확인합니다(QA-338). 운영자 비밀번호를 대입해 볼 수 있는 통로가 하나
        // 더 생기는 것이므로 연속 실패에는 로그인과 같은 지연을 겁니다(요청자 번호마다). 비밀번호가 빈 요청은 대입이 아니라 형식 오류라
        // 지연 기록을 건드리지 않고 거절합니다 — 기록에 넣으면 '성공'으로도 '실패'로도 셀 수 없습니다(빈 값으로 셈을 되돌리게 됨).
        if (body.password() == null || body.password().isEmpty()) {
            return result(AdminService.PROMOTE_NEEDS_PASSWORD, success);
        }
        AtomicReference<AdminService.Update> outcome = new AtomicReference<>();
        LoginThrottle.Outcome slowed = promoteThrottle.attempt("promote|" + user.id(), () -> {
            outcome.set(admin.update(user, id, body.role(), body.tier(), body.password()));
            return outcome.get().passwordVerified();
        });
        if (slowed.busy()) {
            return tooMany(slowed.retryAfter(), "다른 확인 요청을 처리하는 중입니다. 잠시 후 다시 시도하세요.");
        }
        if (AdminService.PROMOTE_WRONG_PASSWORD.equals(outcome.get().problem()) && !slowed.retryAfter().isZero()) {
            long seconds = Math.max(1, (slowed.retryAfter().toMillis() + 999) / 1000);
            return tooMany(slowed.retryAfter(), "비밀번호 확인 실패가 반복됐습니다. " + seconds + "초 뒤에 다시 시도하세요.");
        }
        return result(outcome.get().problem(), success);
    }

    @GetMapping("/audit")
    public Map<String, Object> audit(@RequestParam(defaultValue = "100") int limit) {
        return Map.of("entries", admin.audit(limit));
    }

    private static ResponseEntity<Map<String, Object>> tooMany(Duration wait, String message) {
        long seconds = Math.max(1, (wait.toMillis() + 999) / 1000);
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .header(HttpHeaders.RETRY_AFTER, String.valueOf(seconds))
                .body(Map.of("ok", false, "retryAfterSeconds", seconds, "message", message));
    }

    private static ResponseEntity<Map<String, Object>> result(String problem, String success) {
        if (problem != null) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", problem));
        }
        return ResponseEntity.ok(Map.of("ok", true, "message", success));
    }
}
