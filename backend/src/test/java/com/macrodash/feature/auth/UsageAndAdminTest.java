package com.macrodash.feature.auth;

import com.macrodash.store.AuditLogStore;
import com.macrodash.store.UsageStore;
import com.macrodash.support.CurrentUser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import tools.jackson.databind.ObjectMapper;

import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 하루 사용량 한도(AI 리포트)와 운영자의 사용자 관리 — 실제 테스트 DB.
 */
class UsageAndAdminTest {

    private final AuthTestDatabase db = new AuthTestDatabase("usage");

    @AfterEach
    void cleanUp() {
        db.cleanUp();
    }

    @Test
    @DisplayName("유료 회원은 하루 한도까지, 동시에 눌러도 한도를 넘지 않는다. 무료는 0건, 운영자는 한도 없음")
    void dailyLimit() throws Exception {
        UsageService usage = new UsageService(new UsageStore(db.jdbc), 3, 20);
        long proId = db.user("pro", "pro passphrase!!", "MEMBER", "PRO");
        CurrentUser pro = new CurrentUser(proId, db.email("pro"), "MEMBER", "PRO", null);

        ExecutorService pool = Executors.newFixedThreadPool(6);
        try {
            Callable<Boolean> call = () -> usage.consume(pro, UsageService.AI_REPORT).allowed();
            long allowed = 0;
            for (Future<Boolean> result : pool.invokeAll(List.of(call, call, call, call, call, call))) {
                allowed += result.get() ? 1 : 0;
            }
            assertThat(allowed).isEqualTo(3);
        } finally {
            pool.shutdown();
        }
        usage.refund(pro, UsageService.AI_REPORT);
        assertThat(usage.consume(pro, UsageService.AI_REPORT).allowed()).as("실패한 호출은 되돌려 다시 씀").isTrue();

        long freeId = db.user("free", "free passphrase!", "MEMBER", "FREE");
        assertThat(usage.consume(new CurrentUser(freeId, db.email("free"), "MEMBER", "FREE", null),
                UsageService.AI_REPORT).allowed()).isFalse();
        long ownerId = db.user("own", "owner passphrase", "OWNER", "FREE");
        CurrentUser owner = new CurrentUser(ownerId, db.email("own"), "OWNER", "FREE", null);
        for (int i = 0; i < 5; i++) {
            assertThat(usage.consume(owner, UsageService.AI_REPORT).allowed()).isTrue();
        }
        assertThat(usage.consume(owner, UsageService.AI_REPORT).limit()).isNull();
    }

    @Test
    @DisplayName("QA-133 peek은 세지 않고 오늘 사용량만 본다 — consume과 같은 한도·모양(유료·무료·운영자·데모)")
    void peekDoesNotCount() {
        UsageService usage = new UsageService(new UsageStore(db.jdbc), 3, 5);
        long proId = db.user("peekpro", "pro passphrase!!", "MEMBER", "PRO");
        CurrentUser pro = new CurrentUser(proId, db.email("peekpro"), "MEMBER", "PRO", null);

        assertThat(usage.peek(pro, UsageService.AI_REPORT)).isEqualTo(new UsageService.Quota(true, 0, 3));
        usage.consume(pro, UsageService.AI_REPORT);
        usage.consume(pro, UsageService.AI_REPORT);
        assertThat(usage.peek(pro, UsageService.AI_REPORT)).isEqualTo(new UsageService.Quota(true, 2, 3));
        assertThat(usage.peek(pro, UsageService.AI_REPORT)).as("여러 번 봐도 그대로").isEqualTo(new UsageService.Quota(true, 2, 3));
        usage.consume(pro, UsageService.AI_REPORT);
        assertThat(usage.peek(pro, UsageService.AI_REPORT)).as("다 썼으면 allowed=false").isEqualTo(new UsageService.Quota(false, 3, 3));

        long freeId = db.user("peekfree", "free passphrase!", "MEMBER", "FREE");
        assertThat(usage.peek(new CurrentUser(freeId, db.email("peekfree"), "MEMBER", "FREE", null), UsageService.AI_REPORT))
                .isEqualTo(new UsageService.Quota(false, 0, 0));
        long ownerId = db.user("peekown", "owner passphrase", "OWNER", "FREE");
        CurrentUser owner = new CurrentUser(ownerId, db.email("peekown"), "OWNER", "FREE", null);
        usage.consume(owner, UsageService.AI_REPORT);
        assertThat(usage.peek(owner, UsageService.AI_REPORT)).isEqualTo(new UsageService.Quota(true, 1, null));
        assertThat(usage.peek(DemoViewer.user(), UsageService.AI_REPORT)).isEqualTo(new UsageService.Quota(true, 0, 5, true));
    }

    @Test
    @DisplayName("운영자: 회원 만들기·등급 바꾸기, 자기 운영자 역할은 못 내림, 감사 기록이 남는다")
    void adminActions() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AdminService admin = new AdminService(db.users, db.audit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new tools.jackson.databind.ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));

        assertThat(admin.create(owner, db.email("m1"), "member passphrase", "FREE")).isNull();
        assertThat(admin.create(owner, db.email("m1"), "member passphrase", "FREE")).contains("이미");
        long memberId = db.users.findByEmail(db.email("m1")).orElseThrow().id();
        assertThat(db.users.findById(memberId).orElseThrow().emailVerifiedAt()).as("운영자가 만든 회원은 인증됨").isNotNull();

        assertThat(admin.update(owner, memberId, "MEMBER", "PRO")).isNull();
        assertThat(db.users.findById(memberId).orElseThrow().tier()).isEqualTo("PRO");
        assertThat(admin.update(owner, ownerId, "MEMBER", "PRO")).contains("자기 자신");
        assertThat(admin.update(owner, memberId, "GOD", "PRO")).contains("역할");
        assertThat(admin.audit(50)).anySatisfy(row -> assertThat(row.get("action")).isEqualTo("user.updated"));
    }

    @Test
    @DisplayName("QA-338 회원을 운영자로 올리는 요청은 요청자 비밀번호 없이는 거절되고 역할이 그대로다 — 등급만 바꾸기와 OWNER → OWNER는 그대로")
    void promotionWithoutPasswordIsRefused() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AdminService admin = new AdminService(db.users, db.audit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new tools.jackson.databind.ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));
        long memberId = db.user("m4", "member passphrase", "MEMBER", "FREE");

        // 수정 전: null(성공)이고 역할이 OWNER가 됐습니다 — 로그인 없는 운영자(Tailscale 신원)가 자기가 정한 비밀번호의 회원을 만들어
        // 운영자로 올린 뒤 그 계정으로 실제 매매 켜기류의 비밀번호 관문을 통과할 수 있었습니다.
        assertThat(admin.update(owner, memberId, "OWNER", "FREE")).as("비밀번호 없는 승격").contains("비밀번호");
        assertThat(db.users.findById(memberId).orElseThrow().role()).as("역할 그대로").isEqualTo("MEMBER");
        assertThat(db.jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE action = 'user.updated' AND detail->>'target' = ?",
                Integer.class, String.valueOf(memberId))).as("바뀐 것이 없으니 변경 감사 기록도 없음").isZero();

        assertThat(admin.update(owner, memberId, "MEMBER", "PRO")).as("등급만 바꾸기는 비밀번호 없이").isNull();
        assertThat(admin.update(owner, ownerId, "OWNER", "FREE")).as("이미 운영자인 계정의 등급 바꾸기도 비밀번호 없이").isNull();
    }

    @Test
    @DisplayName("QA-338 승격은 요청자 계정의 비밀번호가 맞을 때만 — 올릴 회원의 비밀번호나 틀린 값은 거절, 맞으면 감사 기록과 함께 올라간다")
    void promotionChecksRequesterPassword() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AdminService admin = new AdminService(db.users, db.audit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new tools.jackson.databind.ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));
        long memberId = db.user("m5", "member passphrase", "MEMBER", "FREE");

        assertThat(admin.promotes(memberId, "OWNER")).isTrue();
        assertThat(admin.promotes(memberId, "MEMBER")).isFalse();
        assertThat(admin.promotes(ownerId, "OWNER")).as("이미 운영자").isFalse();
        assertThat(admin.promotes(-1, "OWNER")).as("없는 사용자").isFalse();

        // 올릴 회원의 비밀번호(회원을 만든 사람이 아는 값)로는 통과하지 못합니다 — 요청자 계정의 비밀번호를 봅니다.
        AdminService.Update targetPassword = admin.update(owner, memberId, "OWNER", "FREE", "member passphrase");
        assertThat(targetPassword.problem()).isEqualTo(AdminService.PROMOTE_WRONG_PASSWORD);
        assertThat(targetPassword.passwordVerified()).isFalse();
        assertThat(admin.update(owner, memberId, "OWNER", "FREE", "").problem()).isEqualTo(AdminService.PROMOTE_NEEDS_PASSWORD);
        // 틀린 비밀번호는 다른 거절(잘못된 등급)보다 먼저 — 다른 거절에 섞어 대입 횟수를 숨기지 못합니다.
        assertThat(admin.update(owner, memberId, "OWNER", "GOLD", "wrong guess").problem()).isEqualTo(AdminService.PROMOTE_WRONG_PASSWORD);
        assertThat(db.users.findById(memberId).orElseThrow().role()).as("역할 그대로").isEqualTo("MEMBER");

        AdminService.Update promoted = admin.update(owner, memberId, "OWNER", "FREE", "owner passphrase");
        assertThat(promoted.problem()).isNull();
        assertThat(promoted.passwordVerified()).isTrue();
        assertThat(db.users.findById(memberId).orElseThrow().role()).isEqualTo("OWNER");
        assertThat(db.jdbc.queryForObject("SELECT detail->>'fromRole' FROM audit_log WHERE action = 'user.updated' "
                + "AND detail->>'target' = ? ORDER BY id DESC LIMIT 1", String.class, String.valueOf(memberId))).isEqualTo("MEMBER");
        assertThat(db.jdbc.queryForObject("SELECT count(*) FROM audit_log WHERE detail::text LIKE '%passphrase%'", Integer.class))
                .as("감사 기록에 비밀번호 값은 없음").isZero();

        // 세션 없는 운영자(로컬 무로그인·Tailscale 신원)도 같은 계정 번호라 그 계정(첫 운영자)의 비밀번호를 봅니다.
        long otherId = db.user("m6", "member passphrase", "MEMBER", "FREE");
        CurrentUser sessionless = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        assertThat(sessionless.isLocalOwner()).isTrue();
        assertThat(admin.update(sessionless, otherId, "OWNER", "FREE", "owner passphrase").problem()).isNull();
    }

    @Test
    @DisplayName("QA-338 승격 비밀번호를 연속으로 틀리면 로그인과 같은 지연(429)이 걸린다 — 빈 비밀번호가 그 셈을 되돌리지 않고, 맞는 비밀번호는 지연 중에도 통과")
    void promotionPasswordGuessesAreSlowed() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AdminService admin = new AdminService(db.users, db.audit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new tools.jackson.databind.ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));
        long memberId = db.user("m7", "member passphrase", "MEMBER", "FREE");
        AdminController controller = new AdminController(admin, new LoginThrottle(java.time.Clock.systemUTC(), millis -> { }));
        org.springframework.mock.web.MockHttpServletRequest http = new org.springframework.mock.web.MockHttpServletRequest();
        http.setAttribute(CurrentUser.ATTRIBUTE, owner);

        for (int i = 1; i <= LoginThrottle.FREE_ATTEMPTS - 1; i++) {
            assertThat(controller.update(memberId, new AdminController.UpdateRequest("OWNER", "FREE", "wrong guess " + i), http)
                    .getStatusCode().value()).as("틀린 비밀번호 %d번째", i).isEqualTo(400);
        }
        // 빈 비밀번호와 승격이 아닌 저장은 지연 기록을 건드리지 않습니다(성공으로 세면 대입 셈이 0으로 돌아감).
        assertThat(controller.update(memberId, new AdminController.UpdateRequest("OWNER", "FREE", null), http)
                .getBody().get("message")).isEqualTo(AdminService.PROMOTE_NEEDS_PASSWORD);
        assertThat(controller.update(memberId, new AdminController.UpdateRequest("MEMBER", "PRO", null), http)
                .getStatusCode().value()).isEqualTo(200);
        assertThat(controller.update(memberId, new AdminController.UpdateRequest("OWNER", "FREE", "wrong guess 5"), http)
                .getStatusCode().value()).as("무료 시도의 마지막").isEqualTo(400);

        var slowed = controller.update(memberId, new AdminController.UpdateRequest("OWNER", "FREE", "wrong guess 6"), http);
        assertThat(slowed.getStatusCode().value()).as("무료 시도를 넘긴 실패").isEqualTo(429);
        assertThat(slowed.getHeaders().getFirst("Retry-After")).isEqualTo("30");
        assertThat(db.users.findById(memberId).orElseThrow().role()).isEqualTo("MEMBER");

        assertThat(controller.update(memberId, new AdminController.UpdateRequest("OWNER", "PRO", "owner passphrase"), http)
                .getStatusCode().value()).as("맞는 비밀번호는 잠기지 않음").isEqualTo(200);
        assertThat(db.users.findById(memberId).orElseThrow().role()).isEqualTo("OWNER");
    }

    @Test
    @DisplayName("QA-115 이미 무료인 회원을 무료로 다시 저장해도 켜진 유료 알림 규칙을 끈다 — 여러 번 저장해도 같음")
    void savingUnpaidUserDisablesPaidRulesEvenIfAlreadyUnpaid() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AdminService admin = new AdminService(db.users, db.audit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new tools.jackson.databind.ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));
        // 이 배포 전에 PRO → FREE로 내려(그때는 규칙을 끄지 않았음) 유료 규칙이 켜진 채 남은 회원.
        long memberId = db.user("m2", "member passphrase", "MEMBER", "FREE");
        db.jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'REGIME_CHANGE', '{}'::jsonb), "
                + "(?, 'INSTITUTION_NEW', '{\"cik\":\"0001067983\"}'::jsonb)", memberId, memberId);
        String lastDisabled = "SELECT detail->>'disabledAlertRules' FROM audit_log WHERE action = 'user.updated' "
                + "AND detail->>'target' = ? ORDER BY id DESC LIMIT 1";

        assertThat(admin.update(owner, memberId, "MEMBER", "FREE")).isNull();
        assertThat(db.jdbc.queryForList("SELECT kind, enabled FROM alert_rules WHERE user_id = ? ORDER BY id", memberId))
                .extracting(row -> row.get("kind") + ":" + row.get("enabled"))
                .containsExactly("REGIME_CHANGE:true", "INSTITUTION_NEW:false");
        assertThat(db.jdbc.queryForObject(lastDisabled, String.class, String.valueOf(memberId)))
                .as("감사 기록에 끈 규칙 수").isEqualTo("1");

        assertThat(admin.update(owner, memberId, "MEMBER", "FREE")).isNull();
        assertThat(db.jdbc.queryForObject(lastDisabled, String.class, String.valueOf(memberId)))
                .as("다시 저장하면 이미 꺼져 있어 0").isEqualTo("0");
    }

    @Test
    @DisplayName("QA-134 역할·등급 변경 중 감사 기록 쓰기가 실패하면 등급도, 알림 규칙 끄기도 되돌아간다")
    void updateIsAllOrNothing() {
        long ownerId = db.user("admin", "owner passphrase", "OWNER", "PRO");
        CurrentUser owner = new CurrentUser(ownerId, db.email("admin"), "OWNER", "PRO", null);
        AuditLogStore failingAudit = new AuditLogStore(db.jdbc, new ObjectMapper()) {
            @Override
            public void append(Long userId, String action, Map<String, Object> detail) {
                if ("user.updated".equals(action)) {   // 마지막 문장에서 DB 오류
                    throw new DataAccessResourceFailureException("감사 기록 쓰기 실패(테스트)");
                }
                super.append(userId, action, detail);
            }
        };
        AdminService admin = new AdminService(db.users, failingAudit, db.hasher, new com.macrodash.store.AlertStore(
                db.jdbc, new ObjectMapper(), new com.macrodash.store.SchemaCheck(db.jdbc)));
        long memberId = db.user("m3", "member passphrase", "MEMBER", "PRO");
        db.jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'INSTITUTION_NEW', "
                + "'{\"cik\":\"0001067983\"}'::jsonb)", memberId);

        assertThatThrownBy(() -> admin.update(owner, memberId, "MEMBER", "FREE"))
                .isInstanceOf(DataAccessResourceFailureException.class);

        // 수정 전: 문장마다 자동 커밋이라 등급은 무료로 내려가고 유료 규칙도 꺼졌는데, 화면은 500(실패한 줄 앎)이고 감사 기록도 없었습니다.
        assertThat(db.users.findById(memberId).orElseThrow().tier()).as("등급 그대로").isEqualTo("PRO");
        assertThat(db.jdbc.queryForObject("SELECT enabled FROM alert_rules WHERE user_id = ?", Boolean.class, memberId))
                .as("유료 규칙도 켜진 채").isTrue();
    }
}
