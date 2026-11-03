package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Tailscale 신원 자동 로그인(ADR 0023 덧붙임 — 사용자 결정 2026-11-03 "Tailscale 계정이면 자동 로그인").
 *
 * <p>Vultr 서버의 화면은 Tailscale Serve(tailnet 안에서만 듣는 HTTPS 앞단)가 받아 루프백의 caddy로 넘깁니다. Serve는 넘기는 요청에 사용자 신원
 * 헤더 {@value #HEADER}(Tailscale 로그인 이름)를 붙이고, 클라이언트가 보낸 같은 이름의 헤더는 지웁니다(Tailscale 공식 문서 'Serve — identity
 * headers', v1.92+). 이 값이 설정 {@code TAILNET_OWNER_LOGIN}과 같으면(대소문자 무시) 쿠키 없는 요청을 첫 운영자로 엽니다 — 로컬 무로그인
 * (ADR 0016)과 같은 운영자(세션 없이, 세션·감사 행을 만들지 않음). 비면 꺼짐(기본 — 로컬·QA·AWS).
 *
 * <p>전제: 앱(caddy 8201·백엔드 8080)이 서버의 루프백에만 열려 Serve를 거치지 않고는 닿지 않음(compose.vultr.yml — CI 'Vultr 덧붙임 해석'이
 * 포트를 봄). 루프백에 닿는 다른 길(비상용 SSH 포트 포워딩)로 온 요청에는 이 헤더가 없어 로그인 화면이 그대로 나옵니다.
 * 이 신원은 쿠키가 아니라 운영자 기기의 네트워크가 붙이는 자격이라, 운영자 브라우저에서 다른 사이트의 페이지가 이 서버를 부르면 그 요청에도 붙습니다.
 * 그래서 쿠키 없는 운영자 요청은 허용 출처(와일드카드 없는 명시 목록 — QA-171)에 맞아야 하고, 그 검사는 로컬 무로그인과 같습니다(WebConfig).
 * 허용 출처가 아니면 CORS 사전 요청도 거절되어, 다른 사이트가 이 헤더를 직접 실어 보낼 수도 없습니다.
 */
@Component
public class TailnetLogin {

    public static final String HEADER = "Tailscale-User-Login";

    private static final Logger log = LoggerFactory.getLogger(TailnetLogin.class);

    private final String ownerLogin;

    @Autowired
    public TailnetLogin(AppProperties properties) {
        this(properties.getTailnetOwnerLogin());
        if (enabled()) {
            // 값(로그인 이름)은 로그에 남기지 않습니다.
            log.warn("Tailscale 신원 자동 로그인 켜짐(TAILNET_OWNER_LOGIN) — 그 Tailscale 사용자의 요청은 로그인 없이 운영자로 엽니다(ADR 0023)");
        }
    }

    /** 같은 설정을 읽는 다른 곳(세션 응답)과 시험용 — 기동 로그를 다시 남기지 않습니다. */
    TailnetLogin(String ownerLogin) {
        this.ownerLogin = ownerLogin == null ? "" : ownerLogin.strip();
    }

    public boolean enabled() {
        return !ownerLogin.isEmpty();
    }

    /** Tailscale Serve가 붙인 신원이 운영자로 정한 Tailscale 사용자인가. 꺼져 있으면 늘 false. */
    public boolean matches(HttpServletRequest request) {
        if (!enabled()) {
            return false;
        }
        String login = request.getHeader(HEADER);
        return login != null && login.strip().equalsIgnoreCase(ownerLogin);
    }
}
