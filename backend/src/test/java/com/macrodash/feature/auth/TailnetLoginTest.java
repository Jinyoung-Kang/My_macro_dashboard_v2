package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.slf4j.LoggerFactory;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tailscale 신원 자동 로그인 판정({@link TailnetLogin}, ADR 0023) — 설정과 Serve가 붙인 신원이 같을 때만(대소문자·앞뒤 공백 무시), 비면 꺼짐.
 * 요청의 호스트가 허용 출처 목록의 호스트일 때만 인정합니다(QA-383).
 */
class TailnetLoginTest {

    private static MockHttpServletRequest with(String login) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/status");
        if (login != null) {
            request.addHeader(TailnetLogin.HEADER, login);
        }
        return request;
    }

    @Test
    @DisplayName("설정과 같은 Tailscale 사용자면 true — 대소문자·앞뒤 공백은 무시, 다른 사용자·헤더 없음은 false")
    void matchesOnlyTheOwner() {
        AppProperties properties = new AppProperties();
        properties.setTailnetOwnerLogin(" Owner@Example.Invalid ");
        TailnetLogin login = new TailnetLogin(properties);
        assertThat(login.enabled()).isTrue();
        assertThat(login.matches(with("owner@example.invalid"))).isTrue();
        assertThat(login.matches(with("OWNER@EXAMPLE.INVALID "))).isTrue();
        assertThat(login.matches(with("other@example.invalid"))).isFalse();
        assertThat(login.matches(with(""))).isFalse();
        assertThat(login.matches(with(null))).isFalse();
    }

    @Test
    @DisplayName("설정이 비면 꺼짐(기본 — 로컬·QA·AWS) — 같은 헤더를 보내도 false")
    void offByDefault() {
        TailnetLogin login = new TailnetLogin(new AppProperties());
        assertThat(login.enabled()).isFalse();
        assertThat(login.matches(with(""))).isFalse();
        assertThat(login.matches(with("owner@example.invalid"))).isFalse();
    }

    private static final String VULTR_ORIGINS = "http://localhost:8201,http://127.0.0.1:8201,https://my-macro-app.example.ts.net";

    /** 서버 이름과 Host 헤더를 따로 정한 요청(신원 헤더는 운영자) — {@code hostHeader}가 null이면 헤더를 싣지 않습니다. */
    private static MockHttpServletRequest from(String serverName, String hostHeader) {
        // 스프링의 흉내 요청은 Host 헤더가 있으면 서버 이름을 그 헤더에서 읽어, 두 값이 다른 경우를 보려고 서버 이름을 고정합니다.
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/status") {
            @Override
            public String getServerName() {
                return serverName;
            }
        };
        request.addHeader(TailnetLogin.HEADER, "owner@example.invalid");
        if (hostHeader != null) {
            request.addHeader("Host", hostHeader);
        }
        return request;
    }

    @Test
    @DisplayName("QA-383: 허용 호스트는 FRONTEND_ORIGIN의 호스트 전부 — 포트·경로를 떼고 소문자로, 와일드카드·사용자 정보가 든 값·모양이 틀린 값은 버림")
    void allowedHostsComeFromTheOriginList() {
        assertThat(new TailnetLogin("owner@example.invalid", VULTR_ORIGINS).allowedHosts())
                .containsExactly("localhost", "127.0.0.1", "my-macro-app.example.ts.net");
        assertThat(TailnetLogin.hostsOf(" https://My-Macro-App.Example.TS.net./ , http://[::1]:3001, http://localhost:3000/x?y#z "))
                .containsExactly("my-macro-app.example.ts.net", "[::1]", "localhost");
        assertThat(TailnetLogin.hostsOf("http://*:8201,https://*.ts.net,http://user@localhost:8201,localhost:8201,://x,http://,http://bad host,"
                + "http://localhost:port,http://exa$mple.test"))
                .as("넓히는 쪽으로 읽지 않음").isEmpty();
        assertThat(TailnetLogin.hostsOf(null)).isEmpty();
        assertThat(TailnetLogin.hostsOf("")).isEmpty();
    }

    @Test
    @DisplayName("QA-383: 호스트 견주기 — 포트·대소문자·끝의 점 하나·IPv6 대괄호는 가리지 않고, 이름이 다르면 다른 호스트")
    void hostNormalization() {
        assertThat(TailnetLogin.normalizeHost("LocalHost:8201")).isEqualTo("localhost");
        assertThat(TailnetLogin.normalizeHost(" my-macro-app.example.ts.net. ")).isEqualTo("my-macro-app.example.ts.net");
        assertThat(TailnetLogin.normalizeHost("my-macro-app.example.ts.net:443")).isEqualTo("my-macro-app.example.ts.net");
        assertThat(TailnetLogin.normalizeHost("127.0.0.1")).isEqualTo("127.0.0.1");
        assertThat(TailnetLogin.normalizeHost("[::1]:8201")).isEqualTo("[::1]");
        assertThat(TailnetLogin.normalizeHost("::1")).as("서블릿의 서버 이름은 대괄호 없이 올 수 있음").isEqualTo("[::1]");
        for (String bad : new String[]{null, "", " ", ":8201", "localhost:", "localhost:80a", "localhost:123456", "[::1", "[]:80",
                "[::1]x", "local host", "localhost/x", "user@localhost", "localhost..", ".", "a".repeat(301)}) {
            String normalized = TailnetLogin.normalizeHost(bad);
            assertThat(normalized == null || !java.util.Set.of("localhost", "127.0.0.1").contains(normalized)).as(String.valueOf(bad)).isTrue();
        }
        assertThat(TailnetLogin.normalizeHost("localhost.attacker.example")).isEqualTo("localhost.attacker.example");
    }

    @Test
    @DisplayName("QA-383: 신원이 맞아도 Host 헤더와 서버 이름이 둘 다 목록에 있어야 인정 — Host 헤더가 없으면 서버 이름만")
    void identityNeedsAnAllowedHost() {
        TailnetLogin login = new TailnetLogin("owner@example.invalid", VULTR_ORIGINS);
        assertThat(login.matches(from("my-macro-app.example.ts.net", "my-macro-app.example.ts.net"))).isTrue();
        assertThat(login.matches(from("my-macro-app.example.ts.net", null))).isTrue();
        assertThat(login.matches(from("127.0.0.1", "127.0.0.1:8201"))).isTrue();
        assertThat(login.matches(from("my-macro-app.example.ts.net", "127.0.0.1:8201")))
                .as("앞단이 Host를 루프백으로 바꾸고 X-Forwarded-Host로 원래 이름을 넘기는 경우").isTrue();
        assertThat(login.matches(from("attacker.example", "attacker.example:8201"))).isFalse();
        assertThat(login.matches(from("localhost", "attacker.example:8201"))).isFalse();
        assertThat(login.matches(from("attacker.example", "localhost:8201"))).isFalse();
        assertThat(login.matches(from("attacker.example", null))).isFalse();
        assertThat(login.matches(from("172.18.0.5", null))).as("Host 없는 요청의 서버 이름(컨테이너 주소)").isFalse();

        TailnetLogin noHosts = new TailnetLogin("owner@example.invalid", "");
        assertThat(noHosts.matches(from("localhost", "localhost:8201"))).as("목록이 비면 아무도 인정하지 않음(닫힘)").isFalse();
    }

    @Test
    @DisplayName("QA-383: 목록 밖 호스트의 신원은 경고 한 줄 — 10분에 한 번, 호스트 이름만(신원 값·이름 밖의 글자는 싣지 않음), 신원이 틀린 요청은 남기지 않음")
    void refusedHostIsLoggedOncePerInterval() {
        Logger logger = (Logger) LoggerFactory.getLogger(TailnetLogin.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            TailnetLogin login = new TailnetLogin("owner@example.invalid", VULTR_ORIGINS);
            MockHttpServletRequest stranger = from("attacker.example", "attacker.example:8201");
            stranger.removeHeader(TailnetLogin.HEADER);
            stranger.addHeader(TailnetLogin.HEADER, "guest@example.invalid");
            assertThat(login.matches(stranger)).isFalse();
            assertThat(appender.list).as("신원이 틀린 요청은 로그 없음").isEmpty();

            for (int i = 0; i < 50; i++) {
                assertThat(login.matches(from("attacker.example", "Attacker.Example:8201\u001b[31m <x>"))).isFalse();
            }
            assertThat(appender.list).hasSize(1);
            String line = appender.list.get(0).getFormattedMessage();
            assertThat(line).contains("attacker.example").contains("FRONTEND_ORIGIN").contains("QA-383");
            assertThat(line).doesNotContain("owner@example.invalid").doesNotContain("\u001b").doesNotContain("<x>");
            assertThat(login.matches(from("localhost", "localhost:8201"))).as("목록의 호스트는 그대로 인정").isTrue();
            assertThat(appender.list).hasSize(1);
        } finally {
            logger.detachAppender(appender);
        }
        assertThat(TailnetLogin.printable(null)).isEqualTo("없음");
        assertThat(TailnetLogin.printable("a".repeat(200))).hasSize(81);
    }
}
