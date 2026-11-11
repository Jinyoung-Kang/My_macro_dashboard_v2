package com.macrodash.web;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tailscale 신원의 호스트 검사(QA-383, ADR 0023 결정 10)를 실제 웹 서버로 봅니다 — Vultr 서버와 같은 설정(앞단 헤더 전략 native, 허용 출처 셋)에서
 * Tomcat이 Host·X-Forwarded-Host를 어떻게 읽는지가 이 검사의 전부라, 흉내 요청이 아니라 진짜 요청 줄을 소켓으로 보냅니다
 * (HTTP 클라이언트는 Host 헤더를 마음대로 정하지 못함).
 *
 * <p>보내는 모양은 서버의 길 그대로입니다: Tailscale Serve는 Host를 바꾸지 않고 X-Forwarded-Host를 붙이며, caddy는 Host를 그대로 넘기고
 * X-Forwarded-Host를 자기가 받은 Host로 다시 채웁니다. 이 시험의 접속 주소(127.0.0.1)는 Tomcat이 믿는 내부 대역이라 서버의 caddy 컨테이너와 같습니다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
        "spring.datasource.url=${TEST_DATABASE_URL:jdbc:postgresql://localhost:5432/macrodash_test}",
        "dashboard.local-no-login=false",
        "dashboard.tailnet-owner-login=owner@example.invalid",
        "dashboard.demo-viewer-token=",
        "dashboard.cookie-secure=true",
        "server.forward-headers-strategy=native",
        "dashboard.frontend-origin=http://localhost:8201,http://127.0.0.1:8201,https://my-macro-app.example.ts.net",
        "dashboard.frontend-port=8201",
        // 첫 계정 만들기(빈 테이블일 때 OWNER_EMAIL로)가 셸 환경으로 테스트 DB에 계정을 만들지 않게 비웁니다.
        "dashboard.owner-email=", "dashboard.password=",
        "dashboard.read-mode=store_only",
        "dashboard.collector-url=http://localhost:1",
        "dashboard.ai.anthropic-api-key=", "dashboard.ai.nvidia-api-key=", "dashboard.ai.cerebras-api-key=",
        "dashboard.ai.cloudflare-account-id=", "dashboard.ai.cloudflare-api-token=",
        "dashboard.scheduler.enabled=false",
        "dashboard.paper.enabled=false"
})
class TailnetLoginIntegrationTest {

    /** 테스트 DB에 운영자가 없을 때만 만드는 이 테스트 전용 계정. */
    static final String OWN_OWNER = "tailnet-it-owner@test.local";
    static final String TAILNET_HOST = "my-macro-app.example.ts.net";

    @LocalServerPort
    int port;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    com.macrodash.store.UserStore users;

    @BeforeEach
    void setUp() {
        String database = jdbc.queryForObject("SELECT current_database()", String.class);
        assertThat(database).as("테스트 전용 DB에서만 돕니다").endsWith("_test");
        if (users.firstOwner().isEmpty()) {
            users.insert(OWN_OWNER, "not-a-login-hash", "OWNER", "PRO", true);
        }
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM users WHERE email = ?", OWN_OWNER);
    }

    /** 요청 줄과 헤더를 그대로 보내고 응답 전체(상태 줄·헤더·본문)를 글자로 돌려줍니다. {@code forwardedHost}가 null이면 그 헤더를 싣지 않습니다. */
    private String raw(String method, String path, String host, String forwardedHost, boolean identity, String... extra)
            throws IOException {
        StringBuilder request = new StringBuilder(method + " " + path + " HTTP/1.1\r\n");
        request.append("Host: ").append(host).append("\r\n");
        if (forwardedHost != null) {
            request.append("X-Forwarded-Host: ").append(forwardedHost).append("\r\n");
        }
        request.append("X-Forwarded-For: 100.64.0.7\r\n");
        if (identity) {
            request.append("Tailscale-User-Login: owner@example.invalid\r\n");
        }
        for (int i = 0; i < extra.length; i += 2) {
            request.append(extra[i]).append(": ").append(extra[i + 1]).append("\r\n");
        }
        request.append("Connection: close\r\n\r\n");
        try (Socket socket = new Socket(InetAddress.getLoopbackAddress(), port)) {
            socket.setSoTimeout(20_000);
            OutputStream out = socket.getOutputStream();
            out.write(request.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String statusOf(String response) {
        int end = response.indexOf("\r\n");
        return end < 0 ? response : response.substring(0, end);
    }

    @Test
    @DisplayName("QA-383: 서버의 길 그대로(Host·X-Forwarded-Host가 Tailscale 주소 또는 루프백 8201)면 신원을 인정 — 세션 응답 noLogin, 운영자 경로 200")
    void serverPathsKeepTheIdentity() throws Exception {
        String[][] shapes = {
                {TAILNET_HOST, TAILNET_HOST},            // Serve → caddy → 백엔드(둘 다 원래 이름)
                {TAILNET_HOST + ":443", TAILNET_HOST},   // 포트가 붙은 모양
                {TAILNET_HOST, null},                    // X-Forwarded-Host 없이
                {"127.0.0.1:8201", TAILNET_HOST},        // 앞단이 Host를 루프백으로 바꾸고 원래 이름은 X-Forwarded-Host로 넘기는 경우
                {"127.0.0.1:8201", "127.0.0.1:8201"},    // 비상 끄기 절차의 curl(서버 셸 → 루프백 caddy)
                {"localhost:8201", "localhost:8201"},    // 비상용 포워딩 화면에서 운영자가 직접 실은 경우
                {"MY-MACRO-APP.Example.TS.net.", null},  // 대소문자·끝의 점
        };
        for (String[] shape : shapes) {
            String label = shape[0] + " / " + shape[1];
            String session = raw("GET", "/api/auth/session", shape[0], shape[1], true);
            assertThat(statusOf(session)).as(label).contains(" 200");
            assertThat(session).as(label).contains("\"authenticated\":true").contains("\"noLogin\":true").contains("\"tailnet\":true");
            assertThat(statusOf(raw("GET", "/api/admin/users", shape[0], shape[1], true))).as(label + " 운영자 경로").contains(" 200");
        }
    }

    @Test
    @DisplayName("QA-383: 목록 밖 호스트(DNS 리바인딩)는 신원 헤더가 맞아도 로그인 없는 요청 — Host와 X-Forwarded-Host 가운데 하나만 꾸며도 401")
    void otherHostsLoseTheIdentity() throws Exception {
        String[][] shapes = {
                {"attacker.example:8201", "attacker.example:8201"},  // caddy가 받은 Host로 X-Forwarded-Host를 채운 실제 모양
                {"attacker.example:8201", "localhost:8201"},         // 앞단이 꾸민 X-Forwarded-Host를 그대로 넘긴다고 해도
                {"attacker.example:8201", null},
                {"localhost:8201", "attacker.example:8201"},
                {"my-macro-app.other.ts.net", "my-macro-app.other.ts.net"},
                {"localhost.attacker.example:8201", null},
                {"[::1]:8201", null},
        };
        for (String[] shape : shapes) {
            String label = shape[0] + " / " + shape[1];
            String session = raw("GET", "/api/auth/session", shape[0], shape[1], true, "Sec-Fetch-Site", "same-origin");
            assertThat(statusOf(session)).as(label).contains(" 200");
            assertThat(session).as(label).contains("\"authenticated\":false").contains("\"noLogin\":false");
            assertThat(statusOf(raw("GET", "/api/admin/users", shape[0], shape[1], true, "Sec-Fetch-Site", "same-origin")))
                    .as(label + " 운영자 경로").contains(" 401");
        }
        assertThat(statusOf(raw("GET", "/api/admin/users", TAILNET_HOST, TAILNET_HOST, false))).as("신원 헤더 없음").contains(" 401");
    }
}
