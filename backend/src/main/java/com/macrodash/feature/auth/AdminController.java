package com.macrodash.feature.auth;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 사용자 관리(운영자만 — 접근 정책 표가 막음).
 *
 * <pre>
 *  GET  /api/admin/users          사용자 목록
 *  POST /api/admin/users          회원 만들기 {email, password, tier}
 *  POST /api/admin/users/{id}     역할·등급 지정 {role, tier}
 *  GET  /api/admin/audit          감사 기록(최근 순)
 * </pre>
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminService admin;

    public AdminController(AdminService admin) {
        this.admin = admin;
    }

    public record CreateRequest(String email, String password, String tier) {
    }

    public record UpdateRequest(String role, String tier) {
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
        String problem = body == null ? "요청 본문이 없습니다."
                : admin.update(CurrentUser.of(request), id, body.role(), body.tier());
        return result(problem, "바꿨습니다. 그 사용자의 다음 요청부터 반영됩니다.");
    }

    @GetMapping("/audit")
    public Map<String, Object> audit(@RequestParam(defaultValue = "100") int limit) {
        return Map.of("entries", admin.audit(limit));
    }

    private static ResponseEntity<Map<String, Object>> result(String problem, String success) {
        if (problem != null) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", problem));
        }
        return ResponseEntity.ok(Map.of("ok", true, "message", success));
    }
}
