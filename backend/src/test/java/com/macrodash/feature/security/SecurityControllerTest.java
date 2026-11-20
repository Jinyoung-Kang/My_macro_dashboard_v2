package com.macrodash.feature.security;

import com.macrodash.config.AppProperties;
import com.macrodash.feature.auth.AuthService;
import com.macrodash.feature.auth.PasswordHasher;
import com.macrodash.store.AuditLogStore;
import com.macrodash.store.SecurityStore;
import com.macrodash.store.SessionStore;
import com.macrodash.store.UserStore;
import com.macrodash.web.ApiExceptionHandler;
import com.macrodash.web.WebConfig;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 보안 공지 경로(ADR 0046)의 접근 — 세션 필터(실제 코드)가 {@code AccessPolicy}로 회원을 403으로 막고 운영자만 통과시키는지, 응답 모양과 없는 번호의 404.
 * 세션 저장소·공지 저장소는 대역이고 값은 모두 가짜입니다.
 */
class SecurityControllerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final List<String> PATHS = List.of("/api/security/notices", "/api/security/notices/9001", "/api/security/inventory");

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        SecurityStore store = mock(SecurityStore.class);
        when(store.ready()).thenReturn(true);
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.empty());
        SecurityStore.Notice notice = SecurityServiceTest.notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok",
                "product_table", List.of(), "가짜 개요");
        SecurityStore.NoticeRow row = SecurityServiceTest.row(9001, 0, "CVE-2099-1001", "PostgreSQL", "16 이상 16.50 미만", "16.50 이상");
        when(store.notices()).thenReturn(List.of(notice));
        when(store.rows()).thenReturn(List.of(row));
        when(store.notice(anyLong())).thenAnswer(call -> (long) call.getArgument(0) == 9001L ? Optional.of(notice) : Optional.empty());
        when(store.rows(anyLong())).thenReturn(List.of(row));
        when(store.sourceState(any())).thenReturn(Optional.empty());
        SecurityService service = new SecurityService(store, ProductAliases.defaults(),
                Clock.fixed(SecurityServiceTest.NOW, ZoneOffset.UTC));
        mvc = MockMvcBuilders.standaloneSetup(new SecurityController(service))
                .setControllerAdvice(new ApiExceptionHandler())
                .addFilters(sessionFilter())
                .build();
    }

    /** 쿠키 {@code owner-cookie}(운영자)·{@code member-cookie}(유료 회원)만 유효한 세션 필터. */
    private static WebConfig.SessionFilter sessionFilter() {
        UserStore users = mock(UserStore.class);
        when(users.ready()).thenReturn(true);
        SessionStore sessions = mock(SessionStore.class);
        when(sessions.findActive(any())).thenAnswer(call -> {
            byte[] hash = call.getArgument(0);
            Instant later = Instant.now().plusSeconds(3600);
            if (Arrays.equals(hash, sha256("owner-cookie"))) {
                return Optional.of(new SessionStore.Active(UUID.randomUUID(), 1, "owner@test.local", "OWNER", "PRO", Instant.now(), later));
            }
            if (Arrays.equals(hash, sha256("member-cookie"))) {
                return Optional.of(new SessionStore.Active(UUID.randomUUID(), 2, "member@test.local", "MEMBER", "PRO", Instant.now(), later));
            }
            return Optional.empty();
        });
        AuthService auth = new AuthService(new AppProperties(), users, sessions, mock(AuditLogStore.class), new PasswordHasher());
        return new WebConfig.SessionFilter(auth, List.of("http://*:3000"));
    }

    private MvcResult call(String path, String cookie) throws Exception {
        var request = get(path);
        if (cookie != null) {
            request = request.cookie(new Cookie(AuthService.COOKIE_NAME, cookie));
        }
        return mvc.perform(request).andReturn();
    }

    private static JsonNode json(MvcResult result) throws Exception {
        return MAPPER.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("회원(유료 포함)은 세 경로 모두 403, 쿠키가 없으면 401")
    void memberIsForbidden() throws Exception {
        for (String path : PATHS) {
            MvcResult member = call(path, "member-cookie");
            assertThat(member.getResponse().getStatus()).as(path).isEqualTo(403);
            assertThat(json(member).path("required").asString()).isEqualTo("OWNER");
            assertThat(call(path, null).getResponse().getStatus()).as(path).isEqualTo(401);
        }
    }

    @Test
    @DisplayName("운영자는 세 경로 모두 200 — 목록·한 건·버전 목록의 모양")
    void ownerGetsJson() throws Exception {
        for (String path : PATHS) {
            assertThat(call(path, "owner-cookie").getResponse().getStatus()).as(path).isEqualTo(200);
        }
        JsonNode list = json(call("/api/security/notices?verdict=check&page=1&size=10", "owner-cookie"));
        assertThat(list.path("available").asBoolean()).isTrue();
        assertThat(list.path("inventory").isNull()).as("버전 목록 없음").isTrue();
        assertThat(list.path("counts").path("check").asInt()).isEqualTo(1);
        assertThat(list.path("items").path(0).path("reasons").path(0).asString()).isEqualTo("NO_INVENTORY");
        assertThat(list.path("collection").path("recorded").asBoolean()).isFalse();
        assertThat(list.path("collection").path("status").isNull()).isTrue();

        JsonNode one = json(call("/api/security/notices/9001", "owner-cookie"));
        assertThat(one.path("notice").path("nttId").asLong()).isEqualTo(9001L);
        assertThat(one.path("rows").path(0).path("status").asString()).isEqualTo("check");

        JsonNode inventory = json(call("/api/security/inventory", "owner-cookie"));
        assertThat(inventory.path("present").asBoolean()).isFalse();
        assertThat(inventory.path("collectedAt").isNull()).isTrue();
    }

    @Test
    @DisplayName("없는 번호는 404, 숫자가 아닌 번호·허용 밖 판정은 400")
    void notFoundAndBadRequest() throws Exception {
        assertThat(call("/api/security/notices/1234", "owner-cookie").getResponse().getStatus()).isEqualTo(404);
        assertThat(call("/api/security/notices/abc", "owner-cookie").getResponse().getStatus()).isEqualTo(400);
        assertThat(call("/api/security/notices?verdict=safe", "owner-cookie").getResponse().getStatus()).isEqualTo(400);
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
