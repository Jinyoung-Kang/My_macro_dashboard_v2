package com.macrodash.feature.auth;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 경로마다 누가 부를 수 있는가 — 표 하나(ADR 0010).
 *
 * <p>모든 경로를 <b>빠짐없이</b> 적습니다. 기본값을 두지 않는 이유: 새 경로가 생겼을 때 조용히 "로그인한 누구나"로
 * 열리면, 운영 기능이나 유료 기능이 의도치 않게 공개됩니다. 컨트롤러 경로 목록과 이 표를 대조하는 테스트
 * ({@code AccessPolicyTest})가 빠진 경로를 빌드에서 막습니다. 표에 없는 경로(404가 될 요청)는 로그인만 요구합니다.
 *
 * <p>같은 경로 안의 범위 제한(무료는 최근 30건 등)은 이 표가 아니라 서비스가 사용자 등급을 받아 처리합니다.
 * 이 표는 "부를 수 있나"만 정합니다.
 */
public final class AccessPolicy {

    private AccessPolicy() {
    }

    public enum Access {
        /** 로그인 없이. */
        PUBLIC,
        /** 로그인한 누구나(무료 포함). */
        MEMBER,
        /** 유료 등급(운영자 포함). */
        PRO,
        /** 운영자만 — 수집을 일으키거나, 내부 상태·키 설정 여부를 보여 주거나, 유료 AI를 부르는 경로. */
        OWNER
    }

    private record Rule(String method, Pattern path, Access access) {
    }

    /** "메서드 경로" → 접근. 경로의 {이름}은 한 조각과 맞습니다. */
    static final Map<String, Access> ROUTES = new LinkedHashMap<>();

    static {
        public_("GET /api/health", "POST /api/auth/login", "GET /api/auth/session",
                "POST /api/auth/signup", "POST /api/auth/verify", "POST /api/auth/reset/request",
                "POST /api/auth/reset/confirm");
        member("POST /api/auth/logout", "POST /api/auth/logout-all", "GET /api/auth/sessions",
                "POST /api/auth/password", "POST /api/auth/delete");

        // 📊 매크로 · 순유동성 · 로테이션
        member("GET /api/macro/overview", "GET /api/macro/risk", "GET /api/macro/advanced",
                "GET /api/macro/usdkrw", "GET /api/macro/fx", "GET /api/macro/fx/options",
                "GET /api/macro/scraped", "GET /api/macro/spread", "GET /api/macro/fred/{seriesId}",
                "GET /api/macro/ticker", "GET /api/liquidity",
                "GET /api/sector/rotation", "GET /api/sector/momentum");
        // 📑 13F · 🧬 기관 스타일 · 🩺 스코어카드
        member("GET /api/sec13f/institutions", "GET /api/sec13f/portfolio", "GET /api/sec13f/consensus",
                "GET /api/guru/profiles", "GET /api/guru/similarity",
                "GET /api/guru/holders", "GET /api/stock/universe", "GET /api/stock/scorecard");
        // 💎 유료 — 심화 분석(신규 매수 교집합·포트폴리오 위험)
        pro("GET /api/sec13f/new-buys", "GET /api/guru/risk");
        // 🏛️ COT · 🇰🇷 파생 · 📡 레이더 · 🏦 투자자별 매매 · 공공 API
        member("GET /api/cot/assets", "GET /api/cot/overview", "GET /api/cot/asset", "GET /api/cot/extremes",
                "GET /api/krx/futures", "GET /api/krx/investor-trend", "GET /api/krx/intraday",
                "GET /api/krx/oi-trend", "GET /api/krx/spot-futures",
                "GET /api/radar/options", "GET /api/radar/ranking", "GET /api/radar/consensus",
                "GET /api/radar/history",
                "GET /api/kr/investor-flows", "GET /api/calendar/kr-holidays",
                "GET /api/kr/fundamentals", "GET /api/kr/market-totals");
        // 🔗 상관 · 🧭 국면 · 원본 텍스트
        member("GET /api/analytics/series", "GET /api/analytics/correlation", "GET /api/analytics/regime",
                "GET /api/analytics/regime/log", "GET /api/analytics/regime/track-record", "GET /api/snapshot/text");
        // 🤖 AI (조회) · 🔌 토스 공개 시세
        member("GET /api/ai/engines", "GET /api/ai/report-types",
                "GET /api/ai/toss/exchange-rate", "GET /api/ai/toss/indices");
        // 💎 유료 — 종목별 투자자 매매 이력, AI 리포트(유료 API, 하루 한도는 UsageService)
        pro("GET /api/kr/stock-flows", "POST /api/ai/report");

        // 🔔 알림 — 규칙·알림함(등급별 규칙 수와 종류는 AlertService가 제한)
        member("GET /api/alerts/rules", "POST /api/alerts/rules", "POST /api/alerts/rules/{id}",
                "DELETE /api/alerts/rules/{id}", "GET /api/alerts/inbox", "GET /api/alerts/unread-count",
                "POST /api/alerts/inbox/read");

        // 🗄️ 운영 — 수집을 일으키거나 내부 상태·키 설정 여부를 보여 줌
        owner("GET /api/status", "GET /api/status/issues", "GET /api/status/tasks", "GET /api/status/history",
                "POST /api/status/refresh", "POST /api/status/run/{taskName}", "GET /api/status/public-apis",
                "POST /api/verification", "GET /api/radar/diagnostics", "GET /api/ai/toss/diagnostics",
                "POST /api/ai/test");
        // 👥 사용자 관리
        owner("GET /api/admin/users", "POST /api/admin/users", "POST /api/admin/users/{id}", "GET /api/admin/audit");
        // 🧪 모의 매매 — 운영자 한 사람의 실험 장부. 초기화·리셋·리스크 실행·트랙레코드 재계산·결정·시작이 장부를 바꾸고,
        //    Claude 책의 결정·미리보기·시작은 운영자 키로 Claude를 부름(비용). 설정은 실험 조건을 바꿈
        owner("GET /api/paper/overview", "GET /api/paper/live", "GET /api/paper/status", "GET /api/paper/books/{code}/positions",
                "GET /api/paper/books/{code}/orders", "GET /api/paper/books/{code}/fills",
                "GET /api/paper/books/{code}/nav", "POST /api/paper/init", "POST /api/paper/books/{code}/status",
                "POST /api/paper/books/{code}/reset", "POST /api/paper/run/risk", "GET /api/paper/track-record",
                "POST /api/paper/run/rerank", "GET /api/paper/decisions", "GET /api/paper/decisions/{id}",
                "POST /api/paper/run/decision", "POST /api/paper/run/initial-decision", "GET /api/paper/settings",
                "POST /api/paper/settings", "GET /api/paper/settings/history");
        //    투자 OS 프레임·메모(단계 3b) — 프레임 판·제안 승인이 Claude 책의 시스템 프롬프트를 바꾸고, 제안은 Claude를 부름(비용)
        owner("GET /api/paper/framework", "GET /api/paper/framework/versions/{version}", "POST /api/paper/framework",
                "GET /api/paper/framework/proposals", "POST /api/paper/framework/proposals",
                "POST /api/paper/framework/proposals/{id}/approve", "POST /api/paper/framework/proposals/{id}/reject",
                "GET /api/paper/notes", "POST /api/paper/notes", "DELETE /api/paper/notes/{id}");
        //    주간 복기(2단계 D) — 지난 결정과 그 뒤 가격의 대조, 수동 실행은 Claude를 부름(비용)·프레임 제안을 낼 수 있음(승인은 위 경로)
        owner("GET /api/paper/reviews", "GET /api/paper/reviews/{weekEnding}", "POST /api/paper/reviews/run");
    }

    private static final List<Rule> RULES = new ArrayList<>();

    static {
        ROUTES.forEach((route, access) -> {
            String[] parts = route.split(" ", 2);
            String regex = Pattern.quote(parts[1]).replaceAll("\\{[^}]+}", "\\\\E[^/]+\\\\Q");
            RULES.add(new Rule(parts[0], Pattern.compile(regex), access));
        });
    }

    private static void public_(String... routes) {
        put(Access.PUBLIC, routes);
    }

    private static void member(String... routes) {
        put(Access.MEMBER, routes);
    }

    private static void pro(String... routes) {
        put(Access.PRO, routes);
    }

    private static void owner(String... routes) {
        put(Access.OWNER, routes);
    }

    private static void put(Access access, String... routes) {
        for (String route : routes) {
            if (ROUTES.put(route, access) != null) {
                throw new IllegalStateException("접근 정책에 같은 경로가 두 번: " + route);
            }
        }
    }

    /**
     * 이 요청에 필요한 접근. 표에 없으면(404가 될 요청) 로그인만 요구합니다.
     *
     * <p>HEAD는 같은 경로의 GET으로 봅니다 — 스프링은 HEAD를 GET 처리기로 돌리므로, 따로 보면 표에 없는 요청(로그인만)이
     * 되어 무료 회원이 운영자·유료 GET 처리기를 실행했습니다(QA-017).
     */
    public static Access required(String method, String path) {
        String effective = "HEAD".equalsIgnoreCase(method) ? "GET" : method;
        for (Rule rule : RULES) {
            if (rule.method().equalsIgnoreCase(effective) && rule.path().matcher(path).matches()) {
                return rule.access();
            }
        }
        return Access.MEMBER;
    }

    /** 이 사용자가 그 접근을 만족하는가. */
    public static boolean allows(Access required, String role, String tier) {
        return switch (required) {
            case PUBLIC, MEMBER -> true;
            case PRO -> "OWNER".equals(role) || "PRO".equals(tier);
            case OWNER -> "OWNER".equals(role);
        };
    }

    /** 표에 적힌 경로 전체(테스트·문서용, 읽기 전용). */
    public static Map<String, Access> routes() {
        return java.util.Collections.unmodifiableMap(ROUTES);
    }
}
