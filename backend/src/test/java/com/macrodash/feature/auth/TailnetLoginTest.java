package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

import static org.assertj.core.api.Assertions.assertThat;

/** Tailscale 신원 자동 로그인 판정({@link TailnetLogin}, ADR 0023) — 설정과 Serve가 붙인 신원이 같을 때만(대소문자·앞뒤 공백 무시), 비면 꺼짐. */
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
}
