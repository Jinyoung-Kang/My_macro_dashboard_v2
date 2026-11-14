package com.macrodash.web;

import com.macrodash.config.AppProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class CorsOriginsTest {

    @Test
    @DisplayName("허용 메서드에 화면이 쓰는 PATCH가 있다 — 로컬·QA는 화면(3002)과 API(8082) 포트가 달라 사전 요청이 걸림(정보 검색 별칭·알림, 단계 6)")
    void allowsEveryMethodTheScreenUses() {
        assertThat(WebConfig.CORS_METHODS).contains("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");
    }

    @Test
    @DisplayName("명시한 origin에 더해 화면 포트의 모든 호스트를 허용한다 — 휴대폰이 LAN IP로 연다")
    void allowsAnyHostOnTheFrontendPort() {
        AppProperties properties = new AppProperties();
        properties.setFrontendOrigin("http://localhost:3000, http://dashboard.local");
        properties.setFrontendPort(3000);

        assertThat(WebConfig.allowedOriginPatterns(properties))
                .containsExactly("http://localhost:3000", "http://dashboard.local", "http://*:3000");
    }

    @Test
    @DisplayName("로컬 무로그인(ADR 0016)이면 이 맥의 화면 주소 셋만 — 와일드카드(http://*:포트)와 LAN 주소 없음")
    void localNoLoginAllowsOnlyThisMac() {
        AppProperties properties = new AppProperties();
        properties.setLocalNoLogin(true);
        properties.setFrontendOrigin("http://localhost:3001");
        properties.setFrontendPort(3001);

        assertThat(WebConfig.allowedOriginPatterns(properties))
                .containsExactly("http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001");

        // 필터의 출처 검사(foreignOrigin)도 같은 목록을 씁니다 — [::1]이 포트 목록 문법([8080,8081])으로 읽히지 않는지까지.
        WebConfig.SessionFilter filter = new WebConfig.SessionFilter(null, WebConfig.allowedOriginPatterns(properties), true);
        for (String origin : new String[]{"http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"}) {
            assertThat(filter.foreignOrigin(post(origin))).as(origin).isFalse();
        }
        for (String origin : new String[]{"http://192.168.0.10:3001", "http://localhost:3000", "https://localhost:3001",
                "http://[::2]:3001", "http://dashboard.local"}) {
            assertThat(filter.foreignOrigin(post(origin))).as(origin).isTrue();
        }
    }

    @Test
    @DisplayName("QA-136·ADR 0023: Vultr 서버(compose.vultr.yml)의 허용 출처는 Tailscale 주소(PUBLIC_ORIGIN, 필수)와 비상용 포워딩(localhost:8201)뿐이다")
    void vultrDeploymentAcceptsOnlyTheTailnetAndTheEmergencyForward() throws Exception {
        Path compose = Path.of("../compose.vultr.yml");
        assumeTrue(Files.exists(compose), "compose.vultr.yml을 찾을 수 없습니다");
        Matcher setting = Pattern.compile("\\n\\s+FRONTEND_ORIGIN:\\s*(.+)").matcher(Files.readString(compose));
        assertThat(setting.find()).as("compose.vultr.yml backend에 FRONTEND_ORIGIN이 있어야 함").isTrue();
        String origins = setting.group(1).trim().replaceAll("^\"|\"$", "");
        // 서버 .env가 끼어들 자리는 Tailscale 주소 하나뿐이고 기본값이 없음(비면 compose 해석이 실패) — FRONTEND_ORIGIN 자체는 보간하지 않음
        Matcher slot = Pattern.compile("\\$\\{PUBLIC_ORIGIN:\\?[^}]*}").matcher(origins);
        assertThat(slot.find()).as("PUBLIC_ORIGIN은 필수(:?)").isTrue();
        String publicSlot = slot.group();
        assertThat(origins.replace(publicSlot, "")).as("Tailscale 주소 밖의 보간 없음").doesNotContain("${");
        Matcher port = Pattern.compile("\\n\\s+FRONTEND_PORT:\\s*\"(\\d+)\"").matcher(Files.readString(compose));
        assertThat(port.find()).as("compose.vultr.yml backend에 FRONTEND_PORT 고정값이 있어야 함").isTrue();

        String tailnet = "https://my-macro-app.example.ts.net";
        AppProperties properties = new AppProperties();
        properties.setFrontendOrigin(origins.replace(publicSlot, tailnet));
        properties.setFrontendPort(Integer.parseInt(port.group(1)));
        WebConfig.SessionFilter filter = new WebConfig.SessionFilter(null, WebConfig.allowedOriginPatterns(properties), false);

        for (String origin : new String[]{tailnet, "http://localhost:8201", "http://127.0.0.1:8201"}) {
            assertThat(filter.foreignOrigin(post(origin))).as(origin).isFalse();
        }
        for (String origin : new String[]{"https://other-host.example.ts.net", "https://my-macro-app.other.ts.net", "http://my-macro-app.example.ts.net",
                "https://dxxxx.cloudfront.net", "https://attacker.example", "http://localhost:8202", "http://localhost:3000"}) {
            assertThat(filter.foreignOrigin(post(origin))).as(origin).isTrue();
        }
    }

    @Test
    @DisplayName("QA-171: Tailscale 신원 운영자가 켜지면 화면 포트 와일드카드(http://*:포트) 없이 명시한 출처만 — 쿠키 없는 운영자라 ADR 0016과 같은 이유")
    void tailnetOwnerLoginDropsTheWildcard() {
        AppProperties properties = new AppProperties();
        properties.setFrontendOrigin("http://localhost:8201,http://127.0.0.1:8201,https://my-macro-app.example.ts.net");
        properties.setFrontendPort(8201);
        properties.setTailnetOwnerLogin("owner@example.invalid");

        assertThat(WebConfig.allowedOriginPatterns(properties))
                .containsExactly("http://localhost:8201", "http://127.0.0.1:8201", "https://my-macro-app.example.ts.net");
        WebConfig.SessionFilter filter = new WebConfig.SessionFilter(null, WebConfig.allowedOriginPatterns(properties), false);
        for (String origin : new String[]{"http://attacker.example:8201", "http://203.0.113.5:8201", "http://my-macro-app:8201"}) {
            assertThat(filter.foreignOrigin(post(origin))).as(origin).isTrue();
        }

        properties.setTailnetOwnerLogin("");
        assertThat(WebConfig.allowedOriginPatterns(properties)).as("꺼져 있으면(쿠키 로그인만) 지금처럼 화면 포트의 모든 호스트")
                .contains("http://*:8201");
    }

    @Test
    @DisplayName("QA-383: Tailscale 신원을 인정하는 호스트는 허용 출처 목록의 호스트와 같다 — Vultr 서버는 localhost·127.0.0.1·Tailscale 주소 셋")
    void tailnetIdentityHostsAreTheAllowedOriginHosts() throws Exception {
        Path compose = Path.of("../compose.vultr.yml");
        assumeTrue(Files.exists(compose), "compose.vultr.yml을 찾을 수 없습니다");
        Matcher setting = Pattern.compile("\\n\\s+FRONTEND_ORIGIN:\\s*(.+)").matcher(Files.readString(compose));
        assertThat(setting.find()).isTrue();
        String origins = setting.group(1).trim().replaceAll("^\"|\"$", "")
                .replaceAll("\\$\\{PUBLIC_ORIGIN:\\?[^}]*}", "https://my-macro-app.example.ts.net");
        AppProperties properties = new AppProperties();
        properties.setFrontendOrigin(origins);
        properties.setFrontendPort(8201);
        properties.setTailnetOwnerLogin("owner@example.invalid");

        com.macrodash.feature.auth.TailnetLogin login = new com.macrodash.feature.auth.TailnetLogin(properties);
        assertThat(login.allowedHosts()).containsExactlyInAnyOrder("localhost", "127.0.0.1", "my-macro-app.example.ts.net");
        // 허용 출처마다 그 호스트가 인정 목록에 있고(잠기지 않음), 목록에는 허용 출처에 없는 호스트가 없습니다(넓히지 않음).
        java.util.Set<String> fromPatterns = new java.util.LinkedHashSet<>();
        for (String pattern : WebConfig.allowedOriginPatterns(properties)) {
            fromPatterns.add(java.net.URI.create(pattern).getHost().toLowerCase(java.util.Locale.ROOT));
        }
        assertThat(login.allowedHosts()).containsExactlyInAnyOrderElementsOf(fromPatterns);
    }

    private static MockHttpServletRequest post(String origin) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/alerts/rules");
        request.addHeader("Origin", origin);
        return request;
    }
}
