package com.macrodash.feature.auth;

import com.macrodash.config.AppProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

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
 *
 * <p>신원은 요청의 호스트가 허용 출처 목록({@code FRONTEND_ORIGIN} — 신원이 켜진 서버에서는 이것이 허용 출처 전부)의 호스트일 때만 인정합니다
 * (QA-383, 2026-11-12). 비상용 SSH 포워딩으로 온 요청은 Serve를 거치지 않아 클라이언트가 실은 신원 헤더가 지워지지 않습니다. 그 PC의 브라우저가
 * 공격자 페이지를 열면, 그 페이지는 자기 이름의 주소를 포워딩 포트로 바꿔(DNS 리바인딩) 같은 출처 읽기에 헤더를 직접 실을 수 있고, 같은 출처라
 * Origin 검사도 지나갑니다. 그런 요청은 Host가 공격자 이름이라 여기서 걸립니다. 보는 값은 둘 — Host 헤더(caddy가 그대로 넘김)와 서버 이름
 * (caddy가 Host로 채운 X-Forwarded-Host를 Tomcat이 반영한 값, {@code server.forward-headers-strategy=native}) — 이고 둘 다 목록에 있어야 합니다.
 * 포트는 가리지 않습니다(이름을 꾸밀 수 없으면 리바인딩이 성립하지 않고, 앞단이 포트를 붙이거나 떼도 잠기지 않게). 목록 밖이면 '신원 없음'으로만
 * 처리해 세션 쿠키 로그인은 그대로입니다.
 */
@Component
public class TailnetLogin {

    public static final String HEADER = "Tailscale-User-Login";

    private static final Logger log = LoggerFactory.getLogger(TailnetLogin.class);

    /** 목록 밖 호스트 경고의 최소 간격 — 화면이 되풀이해 부르거나 누가 두드려도 로그가 쌓이지 않게. */
    static final long REFUSAL_LOG_INTERVAL_MILLIS = 10 * 60 * 1000L;

    private final String ownerLogin;
    /** 신원을 인정하는 호스트 이름(소문자, 포트·끝의 점 없음, IPv6는 대괄호와 함께) — {@code FRONTEND_ORIGIN}의 호스트 전부. */
    private final Set<String> allowedHosts;
    /** 마지막으로 목록 밖 호스트 경고를 남긴 시각(밀리초) — 한 번도 없으면 0. */
    private final AtomicLong lastRefusalLogAt = new AtomicLong();

    @Autowired
    public TailnetLogin(AppProperties properties) {
        this(properties.getTailnetOwnerLogin(), properties.getFrontendOrigin());
        if (enabled()) {
            // 값(로그인 이름)은 로그에 남기지 않습니다.
            log.warn("Tailscale 신원 자동 로그인 켜짐(TAILNET_OWNER_LOGIN) — 그 Tailscale 사용자의 요청은 로그인 없이 운영자로 엽니다(ADR 0023). "
                    + "신원을 인정하는 호스트 {}개(FRONTEND_ORIGIN의 호스트 — QA-383)", allowedHosts.size());
            if (allowedHosts.isEmpty()) {
                log.warn("Tailscale 신원을 인정할 호스트가 없습니다(FRONTEND_ORIGIN에서 호스트를 읽지 못함) — 모든 요청이 로그인 화면으로 갑니다");
            }
        }
    }

    /** 같은 설정을 읽는 다른 곳(세션 응답)과 시험용 — 기동 로그를 다시 남기지 않습니다. */
    TailnetLogin(String ownerLogin, String frontendOrigins) {
        this.ownerLogin = ownerLogin == null ? "" : ownerLogin.strip();
        this.allowedHosts = hostsOf(frontendOrigins);
    }

    public boolean enabled() {
        return !ownerLogin.isEmpty();
    }

    /** 신원을 인정하는 호스트 이름들(정규화한 모양) — 허용 출처 목록과의 대조 시험이 읽습니다. */
    public Set<String> allowedHosts() {
        return allowedHosts;
    }

    /**
     * Tailscale Serve가 붙인 신원이 운영자로 정한 Tailscale 사용자이고, 요청이 허용 출처 목록의 호스트로 왔는가. 꺼져 있으면 늘 false.
     * 신원은 맞는데 호스트가 목록 밖이면 false(로그인 없는 요청으로 처리)이고 경고를 한 줄 남깁니다 — 10분에 한 번, 호스트 이름만.
     */
    public boolean matches(HttpServletRequest request) {
        if (!enabled()) {
            return false;
        }
        String login = request.getHeader(HEADER);
        if (login == null || !login.strip().equalsIgnoreCase(ownerLogin)) {
            return false;
        }
        if (!fromAllowedHost(request)) {
            warnRefusedHost(request);
            return false;
        }
        return true;
    }

    /**
     * 요청의 호스트가 목록에 있는가 — Host 헤더(있으면)와 서버 이름 둘 다. Host 헤더는 브라우저가 연 주소 그대로이고(스크립트가 바꿀 수 없는
     * 헤더, caddy는 그대로 넘김), 서버 이름은 Tomcat이 X-Forwarded-Host(caddy가 들어온 값을 버리고 Host로 채움)를 반영한 값입니다.
     * 한쪽만 보면 앞단 설정이 바뀌었을 때(X-Forwarded-Host를 그대로 넘기는 앞단 등) 꾸민 값이 통과할 수 있어 둘 다 봅니다.
     */
    boolean fromAllowedHost(HttpServletRequest request) {
        String serverName = normalizeHost(request.getServerName());
        if (serverName == null || !allowedHosts.contains(serverName)) {
            return false;
        }
        String hostHeader = request.getHeader("Host");
        if (hostHeader == null) {
            return true;
        }
        String host = normalizeHost(hostHeader);
        return host != null && allowedHosts.contains(host);
    }

    private void warnRefusedHost(HttpServletRequest request) {
        long now = System.currentTimeMillis();
        long last = lastRefusalLogAt.get();
        if ((last != 0 && now - last < REFUSAL_LOG_INTERVAL_MILLIS) || !lastRefusalLogAt.compareAndSet(last, now)) {
            return;
        }
        // 신원 값은 싣지 않습니다. 호스트는 요청이 정한 글자라 이름에 쓰이는 글자만 남기고 길이를 자릅니다.
        log.warn("Tailscale 신원 헤더가 왔지만 요청의 호스트가 허용 출처 목록(FRONTEND_ORIGIN)에 없어 로그인 없는 요청으로 처리했습니다 — "
                        + "Host '{}', 서버 이름 '{}'. 화면이 로그인 화면으로 가면 이 이름이 목록에 있는지 확인하세요(ADR 0023 결정 10, QA-383). "
                        + "이 경고는 10분에 한 번만 남깁니다.",
                printable(request.getHeader("Host")), printable(request.getServerName()));
    }

    /** 로그에 남길 호스트 — 소문자로, 이름에 쓰이는 글자(영문·숫자·{@code . - : [ ]})만, 80자까지. 없으면 '없음'. */
    static String printable(String host) {
        if (host == null || host.isBlank()) {
            return "없음";
        }
        String cleaned = host.strip().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9.:\\[\\]-]", "?");
        return cleaned.length() > 80 ? cleaned.substring(0, 80) + "…" : cleaned;
    }

    /** 쉼표로 나눈 출처 목록에서 호스트 이름들. 와일드카드({@code *})가 든 값·사용자 정보가 든 값·읽지 못한 값은 버립니다(넓히는 쪽으로 읽지 않음). */
    static Set<String> hostsOf(String origins) {
        Set<String> hosts = new LinkedHashSet<>();
        if (origins == null) {
            return Set.of();
        }
        for (String origin : origins.split(",")) {
            String value = origin.strip();
            int scheme = value.indexOf("://");
            if (value.isEmpty() || scheme <= 0) {
                continue;
            }
            String authority = value.substring(scheme + 3);
            int end = indexOfAny(authority, "/?#");
            if (end >= 0) {
                authority = authority.substring(0, end);
            }
            if (authority.indexOf('@') >= 0 || authority.indexOf('*') >= 0) {
                continue;
            }
            String host = normalizeHost(authority);
            if (host != null) {
                hosts.add(host);
            }
        }
        return Collections.unmodifiableSet(hosts);
    }

    /**
     * {@code 이름[:포트]}·{@code [IPv6][:포트]}·대괄호 없는 IPv6(서블릿의 서버 이름)를 견줄 모양으로 — 소문자, 포트 뗌, 끝의 점 하나 뗌,
     * IPv6는 대괄호와 함께. 이름에 쓰이지 않는 글자가 있거나 포트가 숫자가 아니면 null(어느 목록에도 없는 것으로).
     */
    static String normalizeHost(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.strip().toLowerCase(Locale.ROOT);
        if (value.isEmpty() || value.length() > 300) {
            return null;
        }
        String name;
        if (value.startsWith("[")) {
            int close = value.indexOf(']');
            if (close < 0 || !validPort(value.substring(close + 1))) {
                return null;
            }
            name = value.substring(1, close);
            return name.isEmpty() || !name.matches("[0-9a-f:.]+") ? null : "[" + name + "]";
        }
        int firstColon = value.indexOf(':');
        if (firstColon >= 0 && firstColon != value.lastIndexOf(':')) {
            // 대괄호 없는 IPv6(포트를 붙일 수 없는 모양)
            return value.matches("[0-9a-f:.]+") ? "[" + value + "]" : null;
        }
        if (firstColon >= 0) {
            if (!validPort(value.substring(firstColon))) {
                return null;
            }
            value = value.substring(0, firstColon);
        }
        name = value.endsWith(".") ? value.substring(0, value.length() - 1) : value;
        return name.isEmpty() || !name.matches("[a-z0-9._-]+") ? null : name;
    }

    /** 빈 값이거나 {@code :숫자}(1~5자리)인가. */
    private static boolean validPort(String suffix) {
        return suffix.isEmpty() || suffix.matches(":[0-9]{1,5}");
    }

    private static int indexOfAny(String value, String chars) {
        int best = -1;
        for (int i = 0; i < chars.length(); i++) {
            int at = value.indexOf(chars.charAt(i));
            if (at >= 0 && (best < 0 || at < best)) {
                best = at;
            }
        }
        return best;
    }
}
