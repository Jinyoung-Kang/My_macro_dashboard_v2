package com.macrodash.feature.auth;

import com.macrodash.store.AlertStore;
import com.macrodash.store.AuditLogStore;
import com.macrodash.store.UserStore;
import com.macrodash.support.CurrentUser;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 운영자의 사용자 관리 — 목록, 역할·등급 지정, 회원 만들기, 감사 기록(명세 B5·B9).
 *
 * <p>결제 연동 전까지 등급은 여기서 수동으로 정합니다(D4). 세션은 요청마다 사용자 행을 다시 읽으므로, 바꾼 역할·등급은
 * 그 사용자의 다음 요청부터 바로 반영됩니다. 운영자가 자기 역할을 내려 아무도 관리하지 못하게 되는 일은 막습니다.
 *
 * <p><b>회원을 운영자로 올릴 때만 요청자 계정의 비밀번호를 다시 확인합니다(QA-338).</b> 로그인 없는 운영자(Tailscale 신원·로컬 무로그인)는
 * 사람임을 증명하지 못합니다(ADR 0028 결정 3). 확인이 없으면 그 신원으로 자기가 정한 비밀번호의 회원을 만들어 운영자로 올린 뒤 그 계정으로
 * 로그인해, 실제 매매 켜기류의 비밀번호 관문(요청자 본인 계정의 비밀번호를 봄)을 자기가 정한 값으로 통과할 수 있었습니다. 무로그인 운영자의
 * '요청자 계정'은 첫 운영자입니다.
 */
@Service
public class AdminService {

    static final Set<String> ROLES = Set.of("OWNER", "MEMBER");
    static final Set<String> TIERS = Set.of("FREE", "PRO");

    static final String PROMOTE_NEEDS_PASSWORD = "회원을 운영자로 올리려면 지금 운영자 계정의 비밀번호를 함께 보내야 합니다.";
    static final String PROMOTE_WRONG_PASSWORD = "운영자 비밀번호가 올바르지 않습니다 — 역할을 바꾸지 않았습니다.";

    /**
     * 역할·등급 지정의 결과.
     *
     * @param problem          문제가 있으면 이유, 성공이면 null
     * @param passwordVerified 이 요청에서 요청자 비밀번호를 실제로 확인했고 맞았는가 — 연속 실패 지연({@link LoginThrottle})은 이 값이 참일 때만
     *                         기록을 지웁니다(다른 이유의 거절이 실패 셈을 되돌리지 않게)
     */
    public record Update(String problem, boolean passwordVerified) {
    }

    private final UserStore users;
    private final AuditLogStore audit;
    private final PasswordHasher hasher;
    private final AlertStore alerts;

    public AdminService(UserStore users, AuditLogStore audit, PasswordHasher hasher, AlertStore alerts) {
        this.users = users;
        this.audit = audit;
        this.hasher = hasher;
        this.alerts = alerts;
    }

    public List<Map<String, Object>> users() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (UserStore.User user : users.all()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", user.id());
            row.put("email", user.email());
            row.put("role", user.role());
            row.put("tier", user.tier());
            row.put("verified", user.emailVerifiedAt() != null);
            row.put("createdAt", String.valueOf(user.createdAt()));
            out.add(row);
        }
        return out;
    }

    /** 이 요청이 회원을 운영자로 올리는가(지금 역할이 OWNER가 아닌데 새 역할이 OWNER) — 이때만 요청자 비밀번호를 확인합니다(QA-338). */
    public boolean promotes(long userId, String role) {
        return "OWNER".equals(role) && promotes(users.findById(userId).orElse(null), role);
    }

    private static boolean promotes(UserStore.User target, String role) {
        return target != null && "OWNER".equals(role) && !"OWNER".equals(target.role());
    }

    /**
     * 비밀번호 없이 역할·등급을 지정합니다 — 등급만 바꾸기, 운영자 → 회원, 이미 운영자인 계정. 회원을 운영자로 올리는 요청은 거절됩니다.
     *
     * @return 문제가 있으면 이유, 성공이면 null
     */
    public String update(CurrentUser admin, long userId, String role, String tier) {
        return update(admin, userId, role, tier, null).problem();
    }

    /**
     * 역할·등급을 지정합니다. 회원을 운영자로 올릴 때는 {@code password}가 요청자 계정({@code admin})의 비밀번호와 맞아야 합니다 —
     * 없거나 틀리면 아무것도 바꾸지 않습니다. 그 확인은 다른 검사보다 먼저 합니다(틀린 비밀번호와 다른 거절을 섞어 대입 횟수를 숨기지 못하게).
     */
    public Update update(CurrentUser admin, long userId, String role, String tier, String password) {
        UserStore.User target = users.findById(userId).orElse(null);
        boolean verified = false;
        if (promotes(target, role)) {
            if (password == null || password.isEmpty()) {
                return new Update(PROMOTE_NEEDS_PASSWORD, false);
            }
            UserStore.User requester = users.findById(admin.id()).orElse(null);
            if (requester == null || !hasher.matches(password, requester.passwordHash())) {
                return new Update(PROMOTE_WRONG_PASSWORD, false);
            }
            verified = true;
        }
        return new Update(apply(admin, target, userId, role, tier), verified);
    }

    private String apply(CurrentUser admin, UserStore.User target, long userId, String role, String tier) {
        if (!ROLES.contains(role) || !TIERS.contains(tier)) {
            return "역할은 OWNER·MEMBER, 등급은 FREE·PRO 중 하나여야 합니다.";
        }
        if (target == null) {
            return "없는 사용자입니다.";
        }
        if (target.id() == admin.id() && !"OWNER".equals(role)) {
            return "자기 자신의 운영자 역할은 내릴 수 없습니다(운영자가 없어지면 아무도 관리할 수 없습니다).";
        }
        // 결과가 무료면 국면 전환 밖의 알림 규칙을 끕니다(명세 B5 — 등급 변경은 다음 요청부터 반영). 끄지 않으면
        // 정기 평가가 유료 알림을 계속 넣고, 관심 종목이 종목별 수급 수집 범위(전체 60)를 계속 차지했습니다(QA-091).
        // 전에도 무료였어도 끕니다 — 이 처리가 생기기 전에 내려간 회원이나 내리기와 겹친 켜기 요청으로 켜진 채 남은 규칙을
        // 무료로 다시 저장해 정리할 수 있게(QA-115). 이미 꺼진 규칙은 세지 않아 몇 번 저장해도 결과가 같습니다(끈 수 0).
        // 다시 유료로 올려도 저절로 켜지 않습니다 — 회원이 알림 화면에서 켭니다.
        boolean disableRules = !paid(role, tier) && alerts.ready();
        // 저장·규칙 끄기·감사 기록은 한 트랜잭션(QA-134, QA-128과 같은 방식) — 중간에 실패하면 등급도 규칙도 그대로라
        // '응답은 500인데 등급은 내려가 있고 감사 기록은 없음'이 생기지 않습니다.
        users.atomically(() -> {
            users.updateRoleAndTier(userId, role, tier);
            Map<String, Object> detail = new LinkedHashMap<>(Map.of("target", userId, "role", role, "tier", tier,
                    "fromRole", target.role(), "fromTier", target.tier()));
            if (disableRules) {
                detail.put("disabledAlertRules", alerts.disablePaidRules(userId));
            }
            audit.append(admin.id(), "user.updated", detail);
            return null;
        });
        return null;
    }

    /** 유료 기능을 쓸 수 있는 역할·등급인가 — {@link CurrentUser#isPro()}와 같은 규칙(운영자는 등급과 무관). */
    private static boolean paid(String role, String tier) {
        return "OWNER".equals(role) || "PRO".equals(tier);
    }

    /** 메일 없이 회원을 만듭니다(인증된 상태). 처음 비밀번호는 운영자가 정해 전달하고, 회원이 내 계정에서 바꿉니다. */
    public String create(CurrentUser admin, String email, String password, String tier) {
        String normalized = AuthService.normalizeEmail(email);
        if (normalized == null) {
            return "메일 주소 형식이 아닙니다.";
        }
        if (!TIERS.contains(tier)) {
            return "등급은 FREE·PRO 중 하나여야 합니다.";
        }
        String problem = PasswordPolicy.problem(password, normalized);
        if (problem != null) {
            return problem;
        }
        try {
            long id = users.insert(normalized, hasher.hash(password), "MEMBER", tier, true);
            audit.append(admin.id(), "user.created", Map.of("target", id, "tier", tier));
            return null;
        } catch (DuplicateKeyException e) {
            return "이미 있는 메일 주소입니다.";
        }
    }

    public List<Map<String, Object>> audit(int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (AuditLogStore.Entry entry : this.audit.recent(Math.max(1, Math.min(limit, 500)))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("at", String.valueOf(entry.at()));
            row.put("userId", entry.userId());
            row.put("action", entry.action());
            row.put("detail", entry.detail());
            out.add(row);
        }
        return out;
    }
}
