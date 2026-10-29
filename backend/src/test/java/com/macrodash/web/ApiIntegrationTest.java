package com.macrodash.web;

import com.macrodash.store.Datasets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ApplicationContext;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.web.filter.FormContentFilter;
import tools.jackson.databind.JsonNode;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * API 통합 테스트 (실제 PostgreSQL 필요).
 *
 * <p>{@code TEST_DATABASE_URL}이 없으면 Spring이 데이터소스를 만들지 못해
 * 컨텍스트 기동이 실패하므로, CI에서는 서비스 컨테이너로 DB를 띄웁니다.
 * 로컬에서 DB 없이 돌릴 때는 {@code -Dtest=!ApiIntegrationTest}로 제외하세요.
 *
 * <p>확인하는 것
 * <ul>
 *   <li>인증 없이는 데이터 API에 접근할 수 없다</li>
 *   <li>로그인 후에는 저장본을 읽어 화면 계약대로 응답한다</li>
 *   <li>저장본이 없어도 500이 아니라 "available=false"로 답한다</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestRestTemplate
@TestPropertySource(properties = {
        "spring.datasource.url=${TEST_DATABASE_URL:jdbc:postgresql://localhost:5432/macrodash_test}",
        "dashboard.password=test-password",
        "dashboard.owner-email=" + ApiIntegrationTest.OWNER,
        "dashboard.read-mode=store_only",
        "dashboard.collector-url=http://localhost:1",    // 수집기가 없어도 화면은 떠야 합니다
        "dashboard.ai.timeout-seconds=333",              // 설정 주입이 실제로 먹는지 확인용
        // AI 키는 셸 환경과 상관없이 비웁니다 — 데모의 AI 리포트 요청이 외부(유료) 호출 없이 "키 없음"으로 끝나게.
        "dashboard.ai.anthropic-api-key=", "dashboard.ai.nvidia-api-key=", "dashboard.ai.cerebras-api-key=",
        "dashboard.ai.cloudflare-account-id=", "dashboard.ai.cloudflare-api-token=",
        "dashboard.ai.demo-daily-limit=7",
        "dashboard.scheduler.enabled=false",             // 정기 작업이 테스트 DB에 쓰면 결과가 실행 시각에 따라 달라짐
        "dashboard.paper.enabled=false",                 // 모의 매매 리스크 점검도(스케줄러를 켜는 테스트가 생겨도 장부를 건드리지 않게)
        "dashboard.paper.kr.start-date=",                // 한국 출발일은 셸 환경과 상관없이 비움(한국 계좌 경로는 '출발일 없음'으로 쉼)
        "dashboard.scheduler.regime-record-hour-kst=17", // 설정 주입이 실제로 먹는지 확인용(QA-093, AWS 배포값)
        // 데모 열람(ADR 0013)을 켜 둡니다 — 헤더를 보내지 않는 다른 테스트는 평소와 같습니다(그것도 함께 확인됨).
        "dashboard.demo-viewer-token=" + ApiIntegrationTest.DEMO_TOKEN
})
class ApiIntegrationTest {

    @LocalServerPort
    int port;

    @Autowired
    TestRestTemplate rest;

    @Autowired
    com.macrodash.feature.ai.AiService ai;

    @Autowired
    JdbcTemplate jdbc;

    @Autowired
    com.macrodash.store.StoreRepository repository;

    @Autowired
    com.macrodash.store.UserStore users;

    @Autowired
    com.macrodash.feature.auth.PasswordHasher hasher;

    @Autowired
    ApplicationContext context;

    static final String OWNER = "owner@test.local";
    static final String MEMBER = "member@test.local";
    /** 테스트용 데모 열람 토큰(32자 이상). 실제 배포 토큰은 서버의 .env에만 있습니다. */
    static final String DEMO_TOKEN = "test-demo-viewer-token-0123456789abcdef";

    private String sessionCookie;

    @BeforeEach
    void setUp() {
        guardAgainstRealDatabase();
        jdbc.execute("DELETE FROM snapshots");
        jdbc.update("DELETE FROM observations WHERE dataset = ?", Datasets.OBS_TOSS_STOCK_FLOW);
        // 테스트 DB에는 다른 테스트가 만든 계정이 남아 있을 수 있어, 첫 계정 만들기(빈 테이블일 때만)에 기대지 않습니다.
        ensureUser(OWNER, "OWNER");
        ensureUser(MEMBER, "MEMBER");
        sessionCookie = login(OWNER, "test-password");
    }

    private void ensureUser(String email, String role) {
        if (users.findByEmail(email).isEmpty()) {
            users.insert(email, hasher.hash("test-password"), role, "FREE", true);
        }
    }

    /**
     * 운영 DB에 붙었으면 <b>지우기 전에</b> 멈춥니다.
     *
     * <p>이 테스트는 시작할 때마다 snapshots를 비웁니다. 접속 대상이 실제로
     * 쓰는 DB(macrodash)였을 때는 테스트 한 번에 수집해 둔 데이터가 전부
     * 사라졌습니다 — 되살리려면 전체 재수집(10분 이상)이 필요합니다.
     * 이름이 {@code _test}로 끝나는 DB에서만 돌게 막아 둡니다.
     */
    private void guardAgainstRealDatabase() {
        String database = jdbc.queryForObject("SELECT current_database()", String.class);
        if (database == null || !database.endsWith("_test")) {
            throw new IllegalStateException(
                    "이 테스트는 데이터를 지우므로 테스트 전용 DB에서만 돌릴 수 있습니다. "
                            + "지금 접속한 DB: '" + database + "'. "
                            + "'make test-backend'를 쓰거나 TEST_DATABASE_URL을 "
                            + "…/macrodash_test 로 지정하세요.");
        }
    }

    @Test
    @DisplayName("인증 없이는 데이터 API에 접근할 수 없다")
    void requiresAuthentication() {
        ResponseEntity<String> response = rest.getForEntity(
                url("/api/macro/overview"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("QA-069: 인증 전에 PUT·PATCH·DELETE의 form 본문을 상한 없이 읽는 Spring 기본 필터(FormContentFilter)가 없다")
    void noFormContentFilterBeforeAuthentication() {
        // 이 필터는 SessionFilter(order 1)보다 앞(order -9900, 모든 경로)에서 돌아, 로그인 없이 보낸 수백 MB form 본문을
        // 통째로 문자열로 만듭니다 — 본문 상한(SessionFilter.capBody)보다 먼저라 막지 못합니다. 요청으로 힙을 실제로
        // 고갈시키는 시험은 같은 JVM의 다른 테스트를 흔들므로, 필터가 등록되지 않았는지만 봅니다.
        assertThat(context.getBeansOfType(FormContentFilter.class)).isEmpty();
    }

    @Test
    @DisplayName("로그아웃한 세션 쿠키는 만료 전이라도 다시 쓸 수 없다 (SEC-07)")
    void loggedOutSessionCannotBeReused() {
        // 예전에는 로그아웃이 브라우저 쿠키만 지워서, 쿠키 값을 가진 쪽은 12시간 동안 계속 쓸 수 있었습니다.
        String stolen = login(OWNER, "test-password");
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, stolen);
        assertThat(rest.exchange(url("/api/macro/overview"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        rest.exchange(url("/api/auth/logout"), HttpMethod.POST, new HttpEntity<>(null, headers), String.class);

        assertThat(rest.exchange(url("/api/macro/overview"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        JsonNode session = rest.exchange(url("/api/auth/session"), HttpMethod.GET,
                new HttpEntity<>(null, headers), JsonNode.class).getBody();
        assertThat(session.path("authenticated").asBoolean(true)).isFalse();
        // 다른 세션(이 테스트의 기본 로그인)은 그대로입니다.
        assertThat(authorizedGet("/api/auth/session").path("authenticated").asBoolean()).isTrue();
    }

    @Test
    @DisplayName("일반 회원은 데이터는 보지만 운영 경로(수집 실행·상태)는 403 — 막는 것은 백엔드다(ADR 0010)")
    void memberCannotCallOwnerRoutes() {
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        assertThat(rest.exchange(url("/api/analytics/regime/log"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<JsonNode> refresh = rest.exchange(url("/api/status/refresh"), HttpMethod.POST,
                new HttpEntity<>(null, headers), JsonNode.class);
        assertThat(refresh.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(refresh.getBody().path("required").asText()).isEqualTo("OWNER");
        assertThat(rest.exchange(url("/api/status"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        JsonNode session = rest.exchange(url("/api/auth/session"), HttpMethod.GET,
                new HttpEntity<>(null, headers), JsonNode.class).getBody();
        assertThat(session.path("user").path("role").asText()).isEqualTo("MEMBER");
    }

    @Test
    @DisplayName("QA-093: 판정 기록 시각은 설정값을 따른다 — AWS 데모(평일 08:50–18:00 운영)는 18시 전에 기록해야 쌓인다")
    void regimeRecordHourFollowsConfiguration() {
        JsonNode log = authorizedGet("/api/analytics/regime/log");

        assertThat(log.path("available").asBoolean()).isTrue();
        assertThat(log.path("recordHourKst").asInt()).isEqualTo(17);
        assertThat(log.path("note").asString()).contains("KST 17시 이후");
    }

    @Test
    @DisplayName("HEAD도 GET과 같은 접근 검사 — 무료 회원은 운영·유료 경로가 403, 회원 경로는 200(QA-017)")
    void headRequestsFollowGetAccessPolicy() {
        long memberId = users.findByEmail(MEMBER).orElseThrow().id();
        users.updateRoleAndTier(memberId, "MEMBER", "FREE");
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        for (String path : List.of("/api/status", "/api/admin/users", "/api/kr/stock-flows?codes=005930")) {
            assertThat(rest.exchange(url(path), HttpMethod.HEAD, new HttpEntity<>(null, headers), String.class)
                    .getStatusCode()).as("HEAD " + path).isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(rest.exchange(url("/api/analytics/regime/log"), HttpMethod.HEAD,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("QA-091 운영자가 유료 → 무료로 내리면 국면 전환 밖의 알림 규칙이 꺼지고(감사 기록에 개수), 회원이 다시 켤 수 없다")
    void tierDowngradeDisablesPaidAlertRules() {
        long memberId = users.findByEmail(MEMBER).orElseThrow().id();
        users.updateRoleAndTier(memberId, "MEMBER", "PRO");
        jdbc.update("DELETE FROM alert_rules WHERE user_id = ?", memberId);
        try {
            for (String[] rule : new String[][]{
                    {"REGIME_CHANGE", "{}"},
                    {"FOREIGN_STREAK", "{\"target\":\"KOSPI\",\"n\":5}"},
                    {"FOREIGN_STREAK", "{\"target\":\"STOCK\",\"code\":\"005930\",\"n\":5}"},
                    {"INSTITUTION_NEW", "{\"cik\":\"0001067983\"}"}}) {
                jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, ?, ?::jsonb)",
                        memberId, rule[0], rule[1]);
            }
            HttpHeaders owner = new HttpHeaders();
            owner.add(HttpHeaders.COOKIE, sessionCookie);
            owner.setContentType(MediaType.APPLICATION_JSON);
            assertThat(rest.exchange(url("/api/admin/users/" + memberId), HttpMethod.POST,
                    new HttpEntity<>(Map.of("role", "MEMBER", "tier", "FREE"), owner), String.class).getStatusCode())
                    .isEqualTo(HttpStatus.OK);

            // 수집기(관심 종목 범위)는 enabled만 보므로 꺼야 따라옵니다(정기 평가는 등급으로도 거름 — QA-115).
            List<Map<String, Object>> rules = jdbc.queryForList(
                    "SELECT id, kind, enabled FROM alert_rules WHERE user_id = ? ORDER BY id", memberId);
            assertThat(rules).extracting(row -> row.get("kind") + ":" + row.get("enabled")).containsExactly(
                    "REGIME_CHANGE:true", "FOREIGN_STREAK:false", "FOREIGN_STREAK:false", "INSTITUTION_NEW:false");
            assertThat(jdbc.queryForObject("SELECT detail->>'disabledAlertRules' FROM audit_log "
                    + "WHERE action = 'user.updated' AND detail->>'target' = ? ORDER BY id DESC LIMIT 1",
                    String.class, String.valueOf(memberId))).as("감사 기록에 끈 규칙 수").isEqualTo("3");

            HttpHeaders member = new HttpHeaders();
            member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
            member.setContentType(MediaType.APPLICATION_JSON);
            assertThat(rest.exchange(url("/api/alerts/rules/" + rules.get(1).get("id")), HttpMethod.POST,
                    new HttpEntity<>(Map.of("enabled", true), member), String.class).getStatusCode())
                    .as("무료 등급은 유료 종류 규칙을 다시 켤 수 없음").isEqualTo(HttpStatus.FORBIDDEN);
        } finally {
            jdbc.update("DELETE FROM alert_rules WHERE user_id = ?", memberId);
            users.updateRoleAndTier(memberId, "MEMBER", "FREE");
        }
    }

    @Test
    @DisplayName("무료 회원은 유료 경로가 403 required=PRO, 운영자가 등급을 바꾸면 다음 요청부터 열린다")
    void tierChangeAppliesOnNextRequest() {
        long memberId = users.findByEmail(MEMBER).orElseThrow().id();
        users.updateRoleAndTier(memberId, "MEMBER", "FREE");
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));

        ResponseEntity<JsonNode> locked = rest.exchange(url("/api/kr/stock-flows?codes=005930"), HttpMethod.GET,
                new HttpEntity<>(null, headers), JsonNode.class);
        assertThat(locked.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(locked.getBody().path("required").asText()).isEqualTo("PRO");

        HttpHeaders owner = new HttpHeaders();
        owner.add(HttpHeaders.COOKIE, sessionCookie);
        owner.setContentType(MediaType.APPLICATION_JSON);
        assertThat(rest.exchange(url("/api/admin/users/" + memberId), HttpMethod.POST,
                new HttpEntity<>(Map.of("role", "MEMBER", "tier", "PRO"), owner), String.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(rest.exchange(url("/api/kr/stock-flows?codes=005930"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        users.updateRoleAndTier(memberId, "MEMBER", "FREE");
    }

    @Test
    @DisplayName("없는 이메일과 틀린 비밀번호는 같은 응답이다 — 계정 존재를 드러내지 않는다")
    void unknownEmailLooksLikeWrongPassword() {
        ResponseEntity<String> unknown = rest.postForEntity(url("/api/auth/login"),
                Map.of("email", "nobody@test.local", "password", "test-password"), String.class);
        ResponseEntity<String> wrong = rest.postForEntity(url("/api/auth/login"),
                Map.of("email", MEMBER, "password", "not-the-password"), String.class);
        assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(unknown.getBody()).isEqualTo(wrong.getBody());
    }

    @Test
    @DisplayName("메일 발송이 설정되지 않으면 가입·재설정은 503, 로그인 화면은 그 사실을 세션 응답으로 안다")
    void signupNeedsMail() {
        ResponseEntity<String> signup = rest.postForEntity(url("/api/auth/signup"),
                Map.of("email", "new@test.local", "password", "a long enough passphrase", "agreed", true), String.class);
        assertThat(signup.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        JsonNode session = rest.getForEntity(url("/api/auth/session"), JsonNode.class).getBody();
        assertThat(session.path("mailAvailable").asBoolean(true)).isFalse();
    }

    @Test
    @DisplayName("다른 출처에서 온 상태 변경 요청은 403 (Origin 확인)")
    void foreignOriginPostIsRejected() {
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, sessionCookie);
        headers.add(HttpHeaders.ORIGIN, "https://evil.example");
        assertThat(rest.exchange(url("/api/auth/logout"), HttpMethod.POST, new HttpEntity<>(null, headers),
                String.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    @DisplayName("잘못된 비밀번호는 거부된다")
    void rejectsWrongPassword() {
        ResponseEntity<String> response = rest.postForEntity(
                url("/api/auth/login"), Map.of("email", OWNER, "password", "wrong"), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("저장본이 없어도 500이 아니라 available=false로 답한다")
    void emptyStoreDoesNotBreakScreens() {
        for (String path : List.of(
                "/api/macro/overview", "/api/liquidity", "/api/sector/rotation",
                "/api/krx/futures", "/api/cot/overview",
                "/api/kr/investor-flows", "/api/krx/spot-futures", "/api/kr/stock-flows?codes=005930")) {
            JsonNode body = authorizedGet(path);
            assertThat(body.path("available").asBoolean(true))
                    .as("%s는 저장본이 없을 때 available=false여야 합니다", path)
                    .isFalse();
        }
    }

    @Test
    @DisplayName("종목 수급: 요청한 종목의 최근 기록만 날짜 역순으로 읽어 요약한다")
    void stockFlowsReadsRecentSeriesOnly() {
        java.time.LocalDate today = com.macrodash.Kst.today();
        insertFlow("005930", today, 300);
        insertFlow("005930", today.minusDays(1), -100);
        insertFlow("005930", today.minusDays(60), 99999);   // 조회 범위(45일) 밖
        insertFlow("000660", today, 5);                     // 요청하지 않은 종목

        JsonNode body = authorizedGet("/api/kr/stock-flows?codes=005930,035420,bad");
        JsonNode stocks = body.path("stocks");

        assertThat(stocks).hasSize(2);   // 형식이 틀린 코드는 무시
        JsonNode samsung = stocks.get(0);
        assertThat(samsung.path("available").asBoolean()).isTrue();
        assertThat(samsung.path("records").asInt()).isEqualTo(2);
        assertThat(samsung.path("latestDate").asString()).isEqualTo(today.toString());
        JsonNode foreigner = samsung.path("investors").get(0);
        assertThat(foreigner.path("net5").path("sum").asLong()).isEqualTo(200);
        assertThat(foreigner.path("streak").asInt()).isEqualTo(1);
        assertThat(stocks.get(1).path("available").asBoolean(true)).isFalse();
    }

    private void insertFlow(String code, java.time.LocalDate date, long foreignerNet) {
        String payload = """
                {"code":"%s","date":"%s","updatedAt":"%sT18:10:00+09:00",
                 "investors":{"foreigner":{"buy":null,"sell":null,"net":%d},"institution":null,
                              "individual":null,"otherCorporation":null},
                 "breakdown":null,"foreignerHoldingRate":null}
                """.formatted(code, date, date, foreignerNet);
        jdbc.update("INSERT INTO observations (dataset, obs_date, entity, payload) VALUES (?, ?, ?, ?::jsonb)",
                Datasets.OBS_TOSS_STOCK_FLOW, java.sql.Date.valueOf(date), code, payload);
    }

    @Test
    @DisplayName("매크로 저장본을 그대로 화면 계약으로 전달한다")
    void servesStoredMacroSnapshot() {
        insertSnapshot(Datasets.SNAP_MACRO_COLLECTED, """
                {
                  "categories": [{
                    "id": "fx", "title": "💵 통화 및 환율", "note": "실시간",
                    "items": [{
                      "key": "usdkrw", "name": "원/달러 (USD/KRW)", "status": "ok",
                      "price": 1389.5, "priceStr": "1,389.50",
                      "delta": -3.2, "pct": -0.23, "deltaStr": "-3.20 (-0.23%)",
                      "prevStr": "1,392.70", "prevValue": 1392.7,
                      "lastTs": "15:30:00 KST"
                    }]
                  }],
                  "rates": {
                    "us02y": {"current": 3.62, "previous": 3.58},
                    "us10y": {"current": 4.11, "previous": 4.05}
                  }
                }
                """);

        JsonNode body = authorizedGet("/api/macro/overview");

        assertThat(body.path("available").asBoolean()).isTrue();
        assertThat(body.path("categories").get(0).path("items").get(0).path("priceStr").asString())
                .isEqualTo("1,389.50");
        // 10Y − 2Y = 4.11 − 3.62 = 0.49
        assertThat(body.path("spreads").path("realtime").path("spread").asDouble())
                .isEqualTo(0.49, org.assertj.core.data.Offset.offset(0.0001));
    }

    @Test
    @DisplayName("추정치 KRX 저장본은 isEstimated로 표시된다")
    void estimatedKrxSnapshotIsFlagged() {
        insertSnapshot(Datasets.SNAP_KRX_FUTURES, """
                {
                  "isEstimated": true,
                  "rows": [{
                    "date": "2026-09-11", "futuresClose": 1088.3, "changePct": -2.13,
                    "changePctReported": null, "volume": null, "openInterest": null,
                    "oiChange": null, "theoryPrice": null, "marketBasis": null,
                    "contractName": "KOSPI 200 최근월물 (KODEX 200 기반 추정)",
                    "marketPhase": "판정 불가 (등락률 미제공)", "cotOiIndex": null
                  }]
                }
                """, "estimated");

        JsonNode body = authorizedGet("/api/krx/futures");

        assertThat(body.path("isEstimated").asBoolean()).isTrue();
        assertThat(body.path("estimateNotice").asString()).contains("추정치");
        assertThat(body.path("latest").path("marketPhase").asString()).isEqualTo("판정 불가 (등락률 미제공)");
        // 베이시스를 모르면 0으로 메우지 않고 "데이터 미제공"으로 표시합니다.
        assertThat(body.path("latest").path("basisState").asString()).isEqualTo("데이터 미제공");
    }

    @Test
    @DisplayName("store_only 모드에서는 수집기가 죽어 있어도 응답한다")
    void storeOnlyModeNeverWaitsForCollector() {
        JsonNode body = authorizedGet("/api/status");

        assertThat(body.path("readMode").asString()).isEqualTo("store_only");
        assertThat(body.path("collectorReachable").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("로그아웃하면 세션이 무효가 된다")
    void logoutClearsSession() {
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, sessionCookie);

        rest.exchange(url("/api/auth/logout"), HttpMethod.POST,
                new HttpEntity<>(null, headers), String.class);

        ResponseEntity<String> after = rest.exchange(
                url("/api/auth/session"), HttpMethod.GET,
                new HttpEntity<>(null, headers), String.class);

        assertThat(after.getBody()).contains("authenticated");
    }

    /** 사용자 번호를 키로 쓰는 테이블(모두 users FK) — 데모 열람이 여기에 한 줄이라도 쓰면 안 됩니다. */
    private static final List<String> USER_KEYED_TABLES = List.of(
            "user_sessions", "audit_log", "usage_counters", "alert_rules", "alert_deliveries", "email_tokens");

    private Map<String, Long> userKeyedRowCounts() {
        Map<String, Long> counts = new java.util.TreeMap<>();
        for (String table : USER_KEYED_TABLES) {
            counts.put(table, jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class));
        }
        return counts;
    }

    @Test
    @DisplayName("데모 열람(ADR 0013): 로그인 없이 화면 GET이 200(사용자별 테이블을 읽는 경로 포함), AI 리포트 요청까지 DB에 아무것도 쓰지 않는다")
    void demoViewerReadsWithoutWriting() {
        HttpHeaders demo = new HttpHeaders();
        demo.add("X-Demo-Viewer", DEMO_TOKEN);
        Map<String, Long> before = userKeyedRowCounts();

        JsonNode session = rest.exchange(url("/api/auth/session"), HttpMethod.GET, new HttpEntity<>(null, demo),
                JsonNode.class).getBody();
        assertThat(session.path("authenticated").asBoolean()).isTrue();
        assertThat(session.path("user").path("demo").asBoolean()).isTrue();
        assertThat(session.path("user").path("email").isNull()).isTrue();

        for (String path : List.of("/api/auth/sessions", "/api/alerts/rules", "/api/alerts/inbox", "/api/alerts/unread-count",
                "/api/analytics/regime/log", "/api/analytics/regime/track-record", "/api/kr/stock-flows?codes=005930",
                "/api/macro/overview", "/api/ai/engines", "/api/ai/report-types")) {
            ResponseEntity<String> response = rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(null, demo),
                    String.class);
            assertThat(response.getStatusCode()).as(path).isEqualTo(HttpStatus.OK);
        }
        JsonNode inbox = rest.exchange(url("/api/alerts/inbox"), HttpMethod.GET, new HttpEntity<>(null, demo),
                JsonNode.class).getBody();
        assertThat(inbox.path("items").size()).as("데모의 알림함은 비어 있음").isZero();

        assertThat(rest.exchange(url("/api/status"), HttpMethod.GET, new HttpEntity<>(null, demo), String.class)
                .getStatusCode()).as("운영 경로").isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(rest.exchange(url("/api/status"), HttpMethod.HEAD, new HttpEntity<>(null, demo), String.class)
                .getStatusCode()).as("HEAD로 운영 경로를 돌리지 못함").isEqualTo(HttpStatus.FORBIDDEN);

        HttpHeaders demoJson = new HttpHeaders();
        demoJson.addAll(demo);
        demoJson.setContentType(MediaType.APPLICATION_JSON);
        for (String path : List.of("/api/alerts/rules", "/api/alerts/inbox/read", "/api/ai/test", "/api/auth/logout")) {
            ResponseEntity<JsonNode> write = rest.exchange(url(path), HttpMethod.POST,
                    new HttpEntity<>(Map.of("kind", "REGIME_CHANGE"), demoJson), JsonNode.class);
            assertThat(write.getStatusCode()).as(path).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(write.getBody().path("error").asString()).isEqualTo("demo_read_only");
        }

        // AI 리포트는 데모의 유일한 쓰기(ADR 0014) — 공용 하루 한도(메모리)로 세고 DB에는 쓰지 않습니다.
        // 이 테스트에는 AI 키가 없어 엔진을 못 쓰므로 한도를 쓰기 전에 끝납니다(외부 호출 없음, QA-133).
        JsonNode engines = rest.exchange(url("/api/ai/engines"), HttpMethod.GET, new HttpEntity<>(null, demo),
                JsonNode.class).getBody();
        assertThat(engines.path("quota").path("limit").asInt()).isEqualTo(7);
        assertThat(engines.path("quota").path("shared").asBoolean()).isTrue();
        ResponseEntity<JsonNode> report = rest.exchange(url("/api/ai/report"), HttpMethod.POST,
                new HttpEntity<>(Map.of("engineId", "anthropic_haiku"), demoJson), JsonNode.class);
        assertThat(report.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(report.getBody().path("status").asBoolean()).isFalse();
        assertThat(report.getBody().path("quota").path("used").asInt()).as("엔진을 못 쓰면 한도를 쓰지 않음").isZero();
        assertThat(report.getBody().path("quota").path("limit").asInt()).isEqualTo(7);
        assertThat(report.getBody().path("quota").path("shared").asBoolean()).isTrue();

        assertThat(userKeyedRowCounts()).as("사용자별 테이블의 행 수가 그대로").isEqualTo(before);
        for (String table : USER_KEYED_TABLES) {
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE user_id < 1", Long.class))
                    .as(table).isZero();
        }
    }

    @Test
    @DisplayName("데모 열람 헤더가 틀리면 401 — 헤더만으로는 열리지 않는다")
    void wrongDemoHeaderIsUnauthorized() {
        HttpHeaders wrong = new HttpHeaders();
        wrong.add("X-Demo-Viewer", "not-the-token");
        assertThat(rest.exchange(url("/api/macro/overview"), HttpMethod.GET, new HttpEntity<>(null, wrong), String.class)
                .getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ------------------------------------------------------------------ helpers
    private String login(String email, String password) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        ResponseEntity<String> response = rest.postForEntity(
                url("/api/auth/login"),
                new HttpEntity<>(Map.of("email", email, "password", password), headers),
                String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<String> cookies = response.getHeaders().get(HttpHeaders.SET_COOKIE);
        assertThat(cookies).isNotNull().isNotEmpty();
        return cookies.get(0).split(";")[0];
    }

    @Test
    @DisplayName("13F: quarters가 0이나 음수여도 500이 아니다")
    void sec13fSurvivesOutOfRangeQuarters() {
        // quarters는 URL 파라미터입니다. 예전에는 그대로 subList(0, quarters)에
        // 넘겨서 quarters=0이면 빈 목록의 get(0)으로, quarters=-1이면 subList가
        // 곧바로 예외를 던져 500이 났습니다.
        String cik = "0001067983";      // 버크셔
        insertSnapshot(
                Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS),
                """
                {"quarters":[
                  {"filingDate":"2026-08-14","reportDate":"2026-06-30","totalValue":1000,
                   "holdings":[{"name":"APPLE INC","value":600,"weight":60.0},
                               {"name":"COCA COLA CO","value":400,"weight":40.0}]},
                  {"filingDate":"2026-05-15","reportDate":"2026-03-31","totalValue":900,
                   "holdings":[{"name":"APPLE INC","value":500,"weight":55.6},
                               {"name":"COCA COLA CO","value":400,"weight":44.4}]}
                ]}
                """);

        for (int quarters : new int[]{0, -1, 1, 8, 999}) {
            JsonNode body = authorizedGet(
                    "/api/sec13f/portfolio?cik=" + cik + "&quarters=" + quarters);
            assertThat(body.path("available").asBoolean())
                    .as("quarters=%d 에서도 응답이 나와야 합니다", quarters)
                    .isTrue();
            assertThat(body.path("quarters").size())
                    .as("quarters=%d 에서 최소 한 분기는 나와야 합니다", quarters)
                    .isGreaterThanOrEqualTo(1);
        }
    }

    @Test
    @DisplayName("원본 데이터 텍스트는 저장본이 없어도 모든 영역을 표기한다")
    void snapshotTextAlwaysCoversEverySection() {
        // 📋 "전체 대시보드 원본 데이터 보기/복사"가 읽는 경로입니다.
        // 수집본이 하나도 없어도 500이 아니라, 어느 영역이 비었는지 보여 줘야
        // 합니다 — 빈 화면은 "이 메뉴가 고장났다"로 읽힙니다.
        JsonNode body = authorizedGet("/api/snapshot/text");

        String text = body.path("text").asString();
        assertThat(body.path("generatedAtKst").asString()).endsWith("KST");
        assertThat(body.path("chars").asInt()).isEqualTo(text.length());

        for (String section : List.of(
                "거시경제 매크로 지표", "심화 매크로 지표", "금융 리스크",
                "연준 순유동성", "섹터 & 자산군", "글로벌 투기세력",
                "국내 파생", "국내 수급 레이더", "기관 13F 스마트머니 교집합")) {
            assertThat(text).as("%s 영역이 텍스트에 있어야 합니다", section).contains(section);
        }
        // 값의 성격(확정치/스크래핑/추정치)을 텍스트 자체가 들고 다녀야 합니다.
        assertThat(text).contains("데이터 성격:");
    }

    @Test
    @DisplayName("원본 데이터 텍스트에는 수집 시각과 값의 성격이 함께 붙는다")
    void snapshotTextCarriesCollectionTimeAndNature() {
        insertSnapshot(Datasets.SNAP_MACRO_COLLECTED, """
                {
                  "categories": [{
                    "id": "fx", "title": "💵 통화 및 환율", "note": "실시간",
                    "items": [{
                      "key": "usdkrw", "name": "원/달러 (USD/KRW)", "status": "ok",
                      "price": 1389.5, "priceStr": "1,389.50",
                      "delta": -3.2, "pct": -0.23, "deltaStr": "-3.20 (-0.23%)",
                      "prevStr": "1,392.70", "prevValue": 1392.7,
                      "lastTs": "15:30:00 KST"
                    }]
                  }]
                }
                """);

        String text = authorizedGet("/api/snapshot/text").path("text").asString();

        assertThat(text).contains("- 수집 시각: ");
        assertThat(text).contains("원/달러 (USD/KRW): 1,389.50");
    }

    @Test
    @DisplayName("원본 데이터 텍스트는 응답 캐시를 거친다 — 같은 저장본이면 다시 만들지 않음")
    void snapshotTextIsServedFromTheResponseCache() {
        insertSnapshot(Datasets.SNAP_MACRO_COLLECTED, """
                {"categories": [{"id": "fx", "title": "💵 통화 및 환율", "items": [{
                  "key": "usdkrw", "name": "원/달러 (USD/KRW)", "status": "ok", "price": 1389.5, "priceStr": "1,389.50",
                  "deltaStr": "-3.20 (-0.23%)", "prevStr": "1,392.70", "lastTs": "15:30:00 KST"}]}]}
                """);
        String cached = authorizedGet("/api/snapshot/text").path("text").asString();
        assertThat(cached).contains("1,389.50");
        // 수집 시각(= 캐시의 저장본 버전)은 그대로 두고 값만 바꿉니다. 같은 캐시를 거치면 다시 만들지 않으므로 앞의 텍스트가
        // 그대로 나오고, 캐시 없이 매번 만들면 바뀐 값이 나옵니다. 예전에 이 텍스트를 내던 쌍둥이 경로
        // /api/ai/snapshot-text(QA-097)는 지웠고, 남은 이 경로의 캐시를 지킵니다.
        jdbc.update("UPDATE snapshots SET payload = replace(payload::text, '1,389.50', '1,400.00')::jsonb WHERE name = ?",
                Datasets.SNAP_MACRO_COLLECTED);

        assertThat(authorizedGet("/api/snapshot/text").path("text").asString()).isEqualTo(cached);
    }

    @Test
    @DisplayName("잘못된 파라미터는 400이고, 오류 본문에 내부 정보(예외·SQL·자바 타입)가 없다")
    void invalidParametersAreBadRequestsWithoutInternals() {
        // 예전에는 날짜 형식 오류가 500과 함께 "Text 'abc' could not be parsed…"를,
        // 숫자 형식 오류가 "Failed to convert value of type 'java.lang.String'…"을 돌려줬습니다.
        for (String path : List.of(
                "/api/radar/history?obsDate=abc",
                "/api/radar/history?startDate=2026-13-45",
                "/api/radar/ranking?topN=abc",
                "/api/macro/fred/DGS10?years=abc")) {
            ResponseEntity<JsonNode> response = authorizedExchange(path, HttpMethod.GET);
            assertThat(response.getStatusCode()).as("%s 상태", path).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(response.getBody().path("error").asString()).as(path).isEqualTo("bad_request");
            assertThat(response.getBody().path("message").asString()).as(path).isNotBlank();
            assertThat(response.getBody().toString()).as(path)
                    .doesNotContain("java.", "Exception", "SQL", "could not be parsed", "Failed to convert");
        }
    }

    @Test
    @DisplayName("범위를 벗어난 숫자 파라미터는 500이 아니라 허용 범위로 접어 응답한다")
    void extremeNumbersAreClampedNot500() {
        // 예전: limit=-1 → SQL 오류 문장이 그대로 담긴 500, years=2147483647 → DateTimeException 500
        for (String path : List.of(
                "/api/status/history?limit=-1",
                "/api/status/history?limit=2147483647",
                "/api/macro/fred/DGS10?years=2147483647",
                "/api/liquidity?years=2147483647",
                "/api/analytics/regime?years=2147483647",
                "/api/analytics/correlation?x=fred:DGS10&y=fred:DGS2&years=2147483647")) {
            ResponseEntity<JsonNode> response = authorizedExchange(path, HttpMethod.GET);
            assertThat(response.getStatusCode()).as("%s 상태", path).isEqualTo(HttpStatus.OK);
        }
    }

    @Test
    @DisplayName("추적하지 않는 CIK·모르는 FRED ID는 수집을 기다리지 않고 바로 400")
    void unknownIdentifiersAreRejectedUpFront() {
        // 예전에는 저장본이 "없음" → 전체 수집을 동기로 기다렸습니다(CIK 3개 = 수집 6회·30초 재현).
        for (String path : List.of(
                "/api/sec13f/portfolio?cik=0000000000",
                "/api/sec13f/consensus?ciks=1,2,3",
                "/api/sec13f/new-buys?ciks=0001067983,999",
                "/api/guru/risk?cik=0000000000",
                "/api/macro/fred/NOPE",
                "/api/macro/spread?longId=NOPE&shortId=DGS2")) {
            long started = System.nanoTime();
            ResponseEntity<JsonNode> response = authorizedExchange(path, HttpMethod.GET);
            long millis = (System.nanoTime() - started) / 1_000_000;

            assertThat(response.getStatusCode()).as("%s 상태", path).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(response.getBody().path("error").asString()).as(path).isEqualTo("bad_request");
            assertThat(millis).as("%s 응답 시간(ms)", path).isLessThan(2_000);
        }
        // 파생 시리즈(30Y-3M)와 목록에 있는 ID는 그대로 통과합니다.
        assertThat(authorizedExchange("/api/macro/fred/T30Y3M", HttpMethod.GET).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(authorizedExchange("/api/macro/spread?longId=DGS10&shortId=DGS2", HttpMethod.GET)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("수급 이력 latest=true: 그 조건의 거래일 목록과 하루치만 준다 (전 기간을 보내지 않음)")
    void radarHistoryLatestReturnsOneDayOnly() {
        // 예전에는 전 기간 이력을 모두 보내고 화면이 30행만 썼습니다(1년치 합성 데이터: 7,800행·2.3MB).
        jdbc.update("DELETE FROM observations WHERE dataset = ?", Datasets.OBS_RADAR);
        insertRadar("2026-09-23", "외국인", "005930", 10.0);
        insertRadar("2026-09-24", "외국인", "005930", 20.0);
        insertRadar("2026-09-24", "외국인", "000660", 15.0);
        insertRadar("2026-09-25", "기관", "005930", 30.0);     // 다른 조건만 있는 날

        String base = "/api/radar/history?market=KOSPI&investor=외국인&tradeType=순매수";
        JsonNode latest = authorizedGet(base + "&latest=true");
        assertThat(latest.path("obsDate").asString()).isEqualTo("2026-09-24");
        assertThat(latest.path("dates").toString()).isEqualTo("[\"2026-09-24\",\"2026-09-23\"]");
        assertThat(latest.path("rows")).hasSize(2);
        latest.path("rows").forEach(row -> assertThat(row.path("obsDate").asString()).isEqualTo("2026-09-24"));

        JsonNode chosen = authorizedGet(base + "&latest=true&obsDate=2026-09-23");
        assertThat(chosen.path("obsDate").asString()).isEqualTo("2026-09-23");
        assertThat(chosen.path("rows")).hasSize(1);

        // latest 없이 부르면 전 기간 — 최신 5,000행까지이고 상한과 잘렸는지가 응답에 실립니다(QA-133)
        JsonNode all = authorizedGet(base);
        assertThat(all.path("rows")).hasSize(3);
        assertThat(all.path("rowLimit").asInt()).isEqualTo(5_000);
        assertThat(all.path("truncated").isBoolean()).isTrue();
        assertThat(all.path("truncated").asBoolean()).isFalse();
        jdbc.update("DELETE FROM observations WHERE dataset = ?", Datasets.OBS_RADAR);
    }

    private void insertRadar(String date, String investor, String code, double netAmountEok) {
        String entity = "KOSPI|" + investor + "|순매수|TODAY|" + code;
        String payload = """
                {"code":"%s","name":"종목%s","netAmountEok":%s,"market":"KOSPI","investor":"%s",
                 "tradeType":"순매수","intervalType":"TODAY","entity":"%s"}
                """.formatted(code, code, netAmountEok, investor, entity);
        jdbc.update("INSERT INTO observations (dataset, obs_date, entity, payload) VALUES (?, ?, ?, ?::jsonb)",
                Datasets.OBS_RADAR, java.sql.Date.valueOf(date), entity, payload);
    }

    @Test
    @DisplayName("태스크별 최근 실행: 태스크마다 마지막에 기록한 1건을 이름 순으로 준다")
    void taskSummaryIsLastRecordedRowPerTask() {
        // 쿼리를 DISTINCT ON(전체 정렬)에서 태스크별 인덱스 첫 행 조회로 바꿨으므로 결과를 고정합니다.
        String prefix = "it_summary_";
        jdbc.update("DELETE FROM collector_task_runs WHERE task LIKE ?", prefix + "%");
        try {
            insertTaskRun(prefix + "radar", "ok", "2026-09-01T00:00:00Z");
            insertTaskRun(prefix + "fx", "error", "2026-09-01T00:05:00Z");
            insertTaskRun(prefix + "radar", "error", "2026-09-01T00:10:00Z");
            insertTaskRun(prefix + "fx", "ok", "2026-09-01T00:01:00Z");    // 시작은 더 이르지만 나중에 기록
            insertTaskRun(prefix + "cot", "empty", "2026-09-01T00:03:00Z");

            List<Map<String, Object>> mine = repository.readTaskSummary().stream()
                    .filter(row -> String.valueOf(row.get("task")).startsWith(prefix))
                    .toList();
            assertThat(mine).extracting(row -> row.get("task") + "=" + row.get("status"))
                    .containsExactly(prefix + "cot=empty", prefix + "fx=ok", prefix + "radar=error");
            assertThat(mine.get(0).keySet()).containsExactly(
                    "task", "speed", "status", "started_at", "duration_ms", "detail", "run_id");
        } finally {
            jdbc.update("DELETE FROM collector_task_runs WHERE task LIKE ?", prefix + "%");
        }
    }

    @Test
    @DisplayName("QA-139 태스크별 최근 실행: 좀비가 도는 동안의 ⚠️ '이전 수집이 아직 진행 중' 행 대신 앞선 시간 초과를 준다")
    void taskSummarySkipsStillRunningNotice() {
        String prefix = "it_zombie_";
        jdbc.update("DELETE FROM collector_task_runs WHERE task LIKE ?", prefix + "%");
        try {
            jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms, detail) "
                    + "VALUES (?, 'fast', 'error', '2026-10-20T00:00:00Z', 120000, '시간 초과: 120초 안에 끝나지 않았습니다')",
                    prefix + "macro");
            jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms, detail) "
                    + "VALUES (?, 'fast', 'empty', '2026-10-20T00:05:00Z', 0, "
                    + "'이전 수집이 아직 진행 중 — 시간 상한을 넘긴 앞선 실행이 끝나지 않아 새로 시작하지 않았습니다')",
                    prefix + "macro");

            List<Map<String, Object>> mine = repository.readTaskSummary().stream()
                    .filter(row -> String.valueOf(row.get("task")).startsWith(prefix))
                    .toList();
            assertThat(mine).extracting(row -> row.get("status") + " " + String.valueOf(row.get("detail")).substring(0, 5))
                    .containsExactly("error 시간 초과");
        } finally {
            jdbc.update("DELETE FROM collector_task_runs WHERE task LIKE ?", prefix + "%");
        }
    }

    @Test
    @DisplayName("수집기가 꺼져 DB에서 읽어도 상태 화면은 수집기와 같은 모양(camelCase)으로 받는다")
    void statusFallbackUsesTheCollectorShape() {
        // 예전에는 DB 행을 그대로 내보내(started_at·ok_count …) 화면이 "기록 없음 · 0 / 0 · NaNs"를
        // 그렸습니다. 이 테스트의 수집기 주소(localhost:1)는 닿지 않으므로 DB 폴백 경로를 탑니다.
        String prefix = "it_fallback_";
        Long runId = jdbc.queryForObject(
                "INSERT INTO collector_runs (started_at, finished_at, status, ok_count, fail_count, detail, "
                        + "pid, host, heartbeat_at, group_name) VALUES (now() - interval '10 minutes', "
                        + "now() - interval '9 minutes', 'partial', 17, 2, 'fsc_prices 실패', 1, 'it-host', "
                        + "now() - interval '9 minutes', 'slow') RETURNING id", Long.class);
        try {
            jdbc.update("INSERT INTO collector_task_runs (run_id, task, speed, status, started_at, duration_ms, detail) "
                    + "VALUES (?, ?, 'slow', 'ok', now() - interval '10 minutes', 1234, '12/12')", runId, prefix + "fred");

            JsonNode status = authorizedGet("/api/status");
            assertThat(status.path("collectorReachable").asBoolean(true)).isFalse();
            assertThat(status.path("lastRunStatus").asString()).isEqualTo("partial");
            JsonNode lastRun = status.path("lastRun");
            assertThat(lastRun.path("id").asLong()).isEqualTo(runId);
            assertThat(lastRun.path("okCount").asInt()).isEqualTo(17);
            assertThat(lastRun.path("failCount").asInt()).isEqualTo(2);
            assertThat(lastRun.path("groupName").asString()).isEqualTo("slow");
            assertThat(java.time.Instant.parse(lastRun.path("startedAt").asString())).isNotNull();
            assertThat(lastRun.has("ok_count") || lastRun.has("started_at")).isFalse();

            JsonNode task = null;
            for (JsonNode row : status.path("taskSummary")) {
                if ((prefix + "fred").equals(row.path("task").asString())) {
                    task = row;
                }
            }
            assertThat(task).isNotNull();
            assertThat(task.path("durationMs").asInt()).isEqualTo(1234);
            assertThat(task.path("runId").asLong()).isEqualTo(runId);
            assertThat(java.time.Instant.parse(task.path("startedAt").asString())).isNotNull();
            assertThat(task.has("duration_ms") || task.has("started_at")).isFalse();

            JsonNode history = authorizedGet("/api/status/history?task=" + prefix + "fred&limit=1").path("history");
            assertThat(history).hasSize(1);
            assertThat(history.get(0).path("durationMs").asInt()).isEqualTo(1234);
            assertThat(history.get(0).has("started_at")).isFalse();
        } finally {
            jdbc.update("DELETE FROM collector_task_runs WHERE task LIKE ?", prefix + "%");
            jdbc.update("DELETE FROM collector_runs WHERE id = ?", runId);
        }
    }

    private void insertTaskRun(String task, String status, String startedAt) {
        jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms) "
                + "VALUES (?, 'fast', ?, ?::timestamptz, 1)", task, status, startedAt);
    }

    @Test
    @DisplayName("수집기가 없으면 수동 실행은 502 — 200에 ok:false로 숨기지 않는다")
    void manualRunWithoutCollectorIsBadGateway() {
        ResponseEntity<JsonNode> response = authorizedExchange("/api/status/run/sec_13f", HttpMethod.POST);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(response.getBody().path("error").asString()).isEqualTo("bad_gateway");
        assertThat(response.getBody().path("message").asString()).contains("수집기");
    }

    @Test
    @DisplayName("없는 API·허용되지 않는 메서드도 같은 오류 형식으로 답한다")
    void unknownPathsAndMethodsUseTheSameErrorShape() {
        ResponseEntity<JsonNode> notFound = authorizedExchange("/api/does-not-exist", HttpMethod.GET);
        assertThat(notFound.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(notFound.getBody().path("error").asString()).isEqualTo("not_found");
        assertThat(notFound.getBody().path("message").asString()).isNotBlank();

        ResponseEntity<JsonNode> wrongMethod = authorizedExchange("/api/verification", HttpMethod.GET);
        assertThat(wrongMethod.getStatusCode()).isEqualTo(HttpStatus.METHOD_NOT_ALLOWED);
        assertThat(wrongMethod.getBody().path("error").asString()).isEqualTo("method_not_allowed");
    }

    /** 🧪 모의 매매의 GET 경로(책 코드가 든 경로는 bench_spy로 — 미국 Claude 계좌만 받는 실행 감사는 claude로). */
    private static final List<String> PAPER_GETS = List.of(
            "/api/paper/overview", "/api/paper/status", "/api/paper/books/bench_spy/positions",
            "/api/paper/books/bench_spy/orders?limit=5", "/api/paper/books/bench_spy/fills?limit=5",
            "/api/paper/books/bench_spy/nav", "/api/paper/books/claude/execution?limit=5", "/api/paper/track-record",
            "/api/paper/decisions?book=rules&limit=5", "/api/paper/settings", "/api/paper/settings/history");

    /** 테스트가 만든 모의 매매 책을 지웁니다(테스트 DB만 — setUp이 DB 이름을 확인함). 책을 지우면 장부가 함께 지워집니다. */
    private void deletePaperBooks() {
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT to_regclass('paper_books') IS NOT NULL", Boolean.class))) {
            jdbc.update("DELETE FROM paper_books WHERE code IN ('rules', 'claude', 'claude2', 'bench_spy', 'bench_mix')");
        }
        // 얼린 출발일 종가가 남으면 다음 실행의 초기화가 '종가 없음' 대신 그 값으로 사후 체결합니다(테스트 DB만).
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT to_regclass('paper_start_prices') IS NOT NULL", Boolean.class))) {
            jdbc.update("DELETE FROM paper_start_prices");
        }
    }

    @Test
    @DisplayName("🧪 모의 매매: 운영자는 모든 경로 200(테이블이 없어도 available:false), 일반 회원은 GET·POST 모두 403")
    void paperRoutesAreOwnerOnly() {
        HttpHeaders member = new HttpHeaders();
        member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        member.setContentType(MediaType.APPLICATION_JSON);
        for (String path : PAPER_GETS) {
            ResponseEntity<JsonNode> denied = rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(null, member),
                    JsonNode.class);
            assertThat(denied.getStatusCode()).as("회원 GET " + path).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(denied.getBody().path("required").asString()).isEqualTo("OWNER");
        }
        assertThat(rest.exchange(url("/api/paper/decisions/1"), HttpMethod.GET, new HttpEntity<>(null, member),
                JsonNode.class).getStatusCode()).as("회원 GET 결정 상세").isEqualTo(HttpStatus.FORBIDDEN);
        for (String path : List.of("/api/paper/init", "/api/paper/run/risk", "/api/paper/books/bench_spy/status",
                "/api/paper/books/bench_spy/reset", "/api/paper/run/rerank", "/api/paper/run/decision",
                "/api/paper/run/initial-decision", "/api/paper/settings")) {
            assertThat(rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(Map.of("status", "PAUSED",
                    "confirm", "bench_spy", "book", "rules"), member), String.class).getStatusCode())
                    .as("회원 POST " + path).isEqualTo(HttpStatus.FORBIDDEN);
        }

        deletePaperBooks();
        JsonNode status = authorizedGet("/api/paper/status");
        if (!status.path("schemaReady").asBoolean(false)) {
            // V8·V9를 적용하지 않은 테스트 DB — 500이 아니라 안내 문구
            for (String path : PAPER_GETS) {
                JsonNode body = authorizedGet(path);
                assertThat(body.path("available").asBoolean(true)).as(path).isFalse();
                assertThat(body.path("message").asString()).as(path).contains("make up");
            }
            return;
        }
        assertThat(status.path("enabled").asBoolean(true)).as("dashboard.paper.enabled=false").isFalse();
        JsonNode overview = authorizedGet("/api/paper/overview");
        assertThat(overview.path("available").asBoolean()).isTrue();
        assertThat(overview.path("initialized").asBoolean(true)).isFalse();
        assertThat(overview.path("limits").size()).isEqualTo(8);
        assertThat(overview.path("quotes").isNull()).as("관측치 저장본 없음(setUp이 snapshots를 비움)").isTrue();
        ResponseEntity<JsonNode> unknown = authorizedExchange("/api/paper/books/bench_spy/positions", HttpMethod.GET);
        assertThat(unknown.getStatusCode()).as("초기화 전 책 코드는 400(404 아님)").isEqualTo(HttpStatus.BAD_REQUEST);

        // 13F 트랙레코드: 후보 목록 저장본이 없으면(setUp이 snapshots를 비움) 진행률 없음, 재계산은 아무것도 쓰지 않음.
        JsonNode trackRecord = authorizedGet("/api/paper/track-record");
        assertThat(trackRecord.path("available").asBoolean()).isTrue();
        assertThat(trackRecord.path("collection").isNull()).isTrue();
        assertThat(trackRecord.path("limits").size()).isEqualTo(3);
        ResponseEntity<JsonNode> rerank = authorizedExchange("/api/paper/run/rerank", HttpMethod.POST);
        assertThat(rerank.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rerank.getBody().path("ok").asBoolean()).isTrue();
        assertThat(rerank.getBody().path("computed").asInt(-1)).isZero();
        assertThat(rerank.getBody().path("selectedUnchanged").asBoolean()).isTrue();
        assertThat(rerank.getBody().path("skippedReason").asString()).contains("track_record_index");
        HttpHeaders owner = new HttpHeaders();
        owner.add(HttpHeaders.COOKIE, sessionCookie);
        owner.setContentType(MediaType.APPLICATION_JSON);
        assertThat(rest.exchange(url("/api/paper/run/rerank"), HttpMethod.POST,
                new HttpEntity<>(Map.of("asOf", "2099-01-02"), owner), JsonNode.class).getStatusCode())
                .as("끝나지 않은 세션").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(authorizedExchange("/api/paper/track-record?asOf=2026-13-01", HttpMethod.GET).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    @DisplayName("🧪 모의 매매 ?market(2단계 F1): 없거나 US면 같은 응답, KR은 쉬는 사유와 함께 200(테스트 배포 설정에 한국 출발일 없음), 모르는 값은 400, 일반 회원은 403")
    void paperMarketParameter() {
        assumePaperSchema();
        HttpHeaders member = new HttpHeaders();
        member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        List<String> scoped = List.of("/api/paper/overview", "/api/paper/status", "/api/paper/reviews",
                "/api/paper/notes");
        for (String path : List.of(scoped.get(0), scoped.get(1), scoped.get(2), scoped.get(3),
                "/api/paper/reviews/2026-10-30")) {
            ResponseEntity<JsonNode> denied = rest.exchange(url(path + "?market=KR"), HttpMethod.GET,
                    new HttpEntity<>(null, member), JsonNode.class);
            assertThat(denied.getStatusCode()).as("회원 GET " + path + "?market=KR").isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(denied.getBody().path("required").asString()).isEqualTo("OWNER");
        }

        // 한국 출발일이 없는 배포 설정 — 이미 출발한(운용·일시정지) 한국 계좌가 없으면 정기 작업이 쉬는 사유(출발일 없음).
        boolean krStarted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_books WHERE market = 'KR' "
                + "AND status IN ('ACTIVE', 'PAUSED')", Long.class) > 0;
        for (String path : scoped) {
            JsonNode plain = authorizedGet(path);
            assertThat(authorizedGet(path + "?market=US")).as(path + "?market=US = 시장 값 없음").isEqualTo(plain);
            assertThat(plain.has("market")).as(path + " 미국 응답에 한국 칸 없음").isFalse();
            JsonNode kr = authorizedGet(path + "?market=KR");
            assertThat(kr.path("available").asBoolean()).as(path).isTrue();
            assertThat(kr.path("market").asString()).as(path).isEqualTo("KR");
            assertThat(kr.has("dormantReason")).as(path).isTrue();
            if (!krStarted) {
                assertThat(kr.path("dormantReason").asString()).as(path)
                        .isEqualTo(com.macrodash.feature.paper.PaperConfig.KR_START_MISSING);
            }
            ResponseEntity<JsonNode> unknown = authorizedExchange(path + "?market=JP", HttpMethod.GET);
            assertThat(unknown.getStatusCode()).as(path + "?market=JP").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(unknown.getBody().path("message").asString()).contains("market", "US · KR");
        }
        assertThat(authorizedGet("/api/paper/overview?market=KR").path("currency").asString()).isEqualTo("KRW");
        // 복기 한 건: 컨트롤러가 market을 넘기는지는 문구로 봅니다(미국 갈래도 없는 주는 400이라 상태 코드만으로는 못 가름 — F1 리뷰).
        ResponseEntity<JsonNode> krWeek = authorizedExchange("/api/paper/reviews/1999-01-08?market=KR", HttpMethod.GET);
        assertThat(krWeek.getStatusCode()).as("없는 한국 복기 주").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(krWeek.getBody().path("message").asString()).as("한국 행에서 찾음 — 시장을 적음")
                .startsWith("없는 복기입니다: KR 1999-01-08");
        if (!krStarted) {
            assertThat(krWeek.getBody().path("message").asString()).isEqualTo("없는 복기입니다: KR 1999-01-08 — "
                    + com.macrodash.feature.paper.PaperConfig.KR_START_MISSING);
        }
        ResponseEntity<JsonNode> usWeek = authorizedExchange("/api/paper/reviews/1999-01-08", HttpMethod.GET);
        assertThat(usWeek.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(usWeek.getBody().path("message").asString()).isEqualTo("없는 복기입니다: 1999-01-08");
        ResponseEntity<JsonNode> usWeekExplicit = authorizedExchange("/api/paper/reviews/1999-01-08?market=US",
                HttpMethod.GET);
        assertThat(usWeekExplicit.getStatusCode()).as("?market=US = 시장 값 없음").isEqualTo(usWeek.getStatusCode());
        assertThat(usWeekExplicit.getBody()).as("?market=US = 시장 값 없음").isEqualTo(usWeek.getBody());
        ResponseEntity<JsonNode> unknownWeek = authorizedExchange("/api/paper/reviews/1999-01-08?market=JP",
                HttpMethod.GET);
        assertThat(unknownWeek.getStatusCode()).as("복기 한 건 ?market=JP").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unknownWeek.getBody().path("message").asString()).contains("market", "US · KR");
        // 메모 목록: includeExpired와 market을 함께 받음(F1 리뷰).
        assertThat(authorizedGet("/api/paper/notes?includeExpired=true&market=KR").path("market").asString())
                .as("includeExpired=true&market=KR").isEqualTo("KR");
        assertThat(authorizedGet("/api/paper/notes?includeExpired=true&market=US")).as("includeExpired=true&market=US = 값 없음")
                .isEqualTo(authorizedGet("/api/paper/notes?includeExpired=true"));
        assertThat(authorizedGet("/api/paper/decisions?book=kr_rules&limit=5").path("available").asBoolean())
                .as("결정 목록은 계좌 코드로 시장을 고름").isTrue();
    }

    @Test
    @DisplayName("🧪 모의 매매 POST의 시장 값(2단계 F1b): 회원은 403, 모르는 값은 400(쓰기 없음), 시장 값 없음·US는 같은 응답, 한국은 테스트 배포 설정에 출발일이 없어 초기화·수동 결정·출발·복기가 그 사유로 400, 리스크 점검은 ok:false·쉬는 사유, 한국 메모는 달력 저장본이 없어 400")
    void paperMarketWriteRoutes() {
        assumePaperSchema();
        HttpHeaders member = new HttpHeaders();
        member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        member.setContentType(MediaType.APPLICATION_JSON);
        List<String> posts = List.of("/api/paper/init", "/api/paper/run/risk", "/api/paper/run/decision",
                "/api/paper/run/initial-decision", "/api/paper/reviews/run");
        for (String path : posts) {
            ResponseEntity<JsonNode> denied = rest.exchange(url(path + "?market=KR"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "kr_claude"), member), JsonNode.class);
            assertThat(denied.getStatusCode()).as("회원 POST " + path + "?market=KR").isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(denied.getBody().path("required").asString()).isEqualTo("OWNER");
        }
        assertThat(rest.exchange(url("/api/paper/notes"), HttpMethod.POST, new HttpEntity<>(Map.of("kind", "INSIGHT",
                "title", "t", "body", "b", "market", "KR"), member), JsonNode.class).getStatusCode())
                .as("회원 POST 메모(market KR)").isEqualTo(HttpStatus.FORBIDDEN);

        HttpHeaders owner = new HttpHeaders();
        owner.add(HttpHeaders.COOKIE, sessionCookie);
        owner.setContentType(MediaType.APPLICATION_JSON);
        long notesBefore = jdbc.queryForObject("SELECT COUNT(*) FROM paper_notes", Long.class);
        long jobRunsBefore = jdbc.queryForObject("SELECT COUNT(*) FROM paper_job_runs", Long.class);
        for (String path : posts) {
            ResponseEntity<JsonNode> unknown = rest.exchange(url(path + "?market=JP"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "kr_claude"), owner), JsonNode.class);
            assertThat(unknown.getStatusCode()).as(path + "?market=JP").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(unknown.getBody().path("message").asString()).contains("market", "US · KR");
        }
        ResponseEntity<JsonNode> unknownNote = rest.exchange(url("/api/paper/notes"), HttpMethod.POST,
                new HttpEntity<>(Map.of("kind", "INSIGHT", "title", "t", "body", "b", "market", "kr"), owner), JsonNode.class);
        assertThat(unknownNote.getStatusCode()).as("메모 market kr").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_notes", Long.class)).isEqualTo(notesBefore);

        JsonNode risk = authorizedExchange("/api/paper/run/risk", HttpMethod.POST).getBody();
        assertThat(authorizedExchange("/api/paper/run/risk?market=US", HttpMethod.POST).getBody())
                .as("?market=US = 시장 값 없음").isEqualTo(risk);
        assertThat(risk.has("market")).isFalse();
        // 수동 결정·시작은 book 없이 보내 미국 갈래의 첫 검사(400, 아무것도 쓰지 않음)를 견줍니다 — 같은 문구면 같은 갈래(F1 리뷰).
        for (String path : List.of("/api/paper/run/decision", "/api/paper/run/initial-decision")) {
            ResponseEntity<JsonNode> plain = rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(Map.of(), owner),
                    JsonNode.class);
            ResponseEntity<JsonNode> us = rest.exchange(url(path + "?market=US"), HttpMethod.POST,
                    new HttpEntity<>(Map.of(), owner), JsonNode.class);
            assertThat(plain.getStatusCode()).as(path + " book 없음").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(plain.getBody().path("message").asString()).as(path).contains("book", "rules · claude");
            assertThat(us.getStatusCode()).as(path + "?market=US = 시장 값 없음").isEqualTo(plain.getStatusCode());
            assertThat(us.getBody()).as(path + "?market=US = 시장 값 없음").isEqualTo(plain.getBody());
        }

        boolean krStarted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_books WHERE market = 'KR' "
                + "AND status IN ('ACTIVE', 'PAUSED')", Long.class) > 0;
        ResponseEntity<JsonNode> init = authorizedExchange("/api/paper/init?market=KR", HttpMethod.POST);
        assertThat(init.getStatusCode()).as("출발일 없는 한국 초기화").isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(init.getBody().path("message").asString())
                .isEqualTo(com.macrodash.feature.paper.PaperConfig.KR_START_MISSING);
        if (!krStarted) {
            JsonNode krRisk = authorizedExchange("/api/paper/run/risk?market=KR", HttpMethod.POST).getBody();
            assertThat(krRisk.path("ok").asBoolean(true)).isFalse();
            assertThat(krRisk.path("market").asString()).isEqualTo("KR");
            assertThat(krRisk.path("dormantReason").asString())
                    .isEqualTo(com.macrodash.feature.paper.PaperConfig.KR_START_MISSING);
            for (String path : List.of("/api/paper/run/decision", "/api/paper/run/initial-decision", "/api/paper/reviews/run")) {
                ResponseEntity<JsonNode> dormant = rest.exchange(url(path + "?market=KR"), HttpMethod.POST,
                        new HttpEntity<>(path.endsWith("/run/decision") ? Map.of("book", "kr_claude") : Map.of(), owner),
                        JsonNode.class);
                assertThat(dormant.getStatusCode()).as(path + "?market=KR — 쉬는 한국").isEqualTo(HttpStatus.BAD_REQUEST);
                assertThat(dormant.getBody().path("message").asString()).as(path)
                        .isEqualTo(com.macrodash.feature.paper.PaperConfig.KR_START_MISSING);
            }
        }
        ResponseEntity<JsonNode> krNote = rest.exchange(url("/api/paper/notes"), HttpMethod.POST, new HttpEntity<>(
                Map.of("kind", "INSIGHT", "title", "t", "body", "b", "market", "KR"), owner), JsonNode.class);
        assertThat(krNote.getStatusCode()).as("공휴일 저장본 없음(setUp이 snapshots를 비움) — 한국 메모는 기준일을 셀 수 없음")
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(krNote.getBody().path("message").asString()).contains("메모의 기준일·만료일을 셀 수 없습니다");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_notes", Long.class)).isEqualTo(notesBefore);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_job_runs", Long.class))
                .as("쉬는 한국·거절된 요청은 작업 기록을 남기지 않음").isEqualTo(jobRunsBefore);
    }

    @Test
    @DisplayName("🧪 모의 매매 초기화: 가격 없는 테스트 DB에서도 500이 아니라 벤치마크를 사유와 함께 건너뛰고, 두 번 눌러도 한 번")
    void paperInitWithoutPricesSkipsBenchmarks() {
        assumePaperSchema();
        deletePaperBooks();
        boolean settingsExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_settings", Long.class) > 0;
        // 설정 쓰기 시험이 버전을 올리므로, 시험 전 행을 기억해 끝에 되돌립니다(테스트 DB만).
        Map<String, Object> settingsBefore = settingsExisted ? jdbc.queryForMap(
                "SELECT version, body::text AS body FROM paper_settings WHERE id = 1") : null;
        long pricedLegs = jdbc.queryForObject("SELECT COUNT(*) FROM timeseries WHERE dataset = 'equity_close' "
                + "AND series_id IN ('SPY', 'SHY') AND obs_date = DATE '2026-10-23'", Long.class);
        try {
            ResponseEntity<JsonNode> first = authorizedExchange("/api/paper/init", HttpMethod.POST);
            assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(first.getBody().path("ok").asBoolean()).isTrue();
            assertThat(first.getBody().path("created").toString())
                    .contains("rules", "claude", "claude2", "bench_spy", "bench_mix");
            if (pricedLegs == 0) {
                assertThat(first.getBody().path("backfilled").size()).isZero();
                assertThat(first.getBody().path("skipped").size()).isEqualTo(2);
                assertThat(first.getBody().path("skipped").get(0).path("code").asString()).isEqualTo("bench_spy");
                assertThat(first.getBody().path("skipped").get(0).path("reason").asString())
                        .contains("SPY").contains("종가가 아직 없습니다");
            }

            ResponseEntity<JsonNode> second = authorizedExchange("/api/paper/init", HttpMethod.POST);
            assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(second.getBody().path("created").size()).as("멱등").isZero();
            assertThat(authorizedExchange("/api/paper/init?market=US", HttpMethod.POST).getBody())
                    .as("?market=US = 시장 값 없음(F1b)").isEqualTo(second.getBody());
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_books WHERE code IN "
                    + "('rules', 'claude', 'claude2', 'bench_spy', 'bench_mix')", Long.class)).isEqualTo(5);

            JsonNode overview = authorizedGet("/api/paper/overview");
            assertThat(overview.path("initialized").asBoolean()).isTrue();
            assertThat(overview.path("books").size()).as("미국 다섯 계좌(계좌2 — ADR 0022)").isEqualTo(5);
            assertThat(overview.path("books").get(2).path("code").asString()).isEqualTo("claude2");
            assertThat(overview.path("books").get(2).path("status").asString()).as("계좌2는 시작 전(앞으로 체결 출발)")
                    .isEqualTo("NOT_STARTED");
            assertThat(overview.path("books").get(0).path("code").asString()).isEqualTo("rules");
            assertThat(overview.path("books").get(0).path("status").asString()).isEqualTo("NOT_STARTED");
            assertThat(overview.path("books").get(0).path("nav").asDouble()).isEqualTo(100_000);
            assertThat(overview.path("books").get(0).path("returnPct").isNull()).isTrue();
            for (String path : PAPER_GETS) {
                assertThat(authorizedGet(path).path("available").asBoolean()).as(path).isTrue();
            }

            // 시작 전 책은 일시정지·재개 400, 확인 문구가 다르면 리셋 400, 리스크 실행은 관측치가 없다는 이유로 끝남
            HttpHeaders owner = new HttpHeaders();
            owner.add(HttpHeaders.COOKIE, sessionCookie);
            owner.setContentType(MediaType.APPLICATION_JSON);
            assertThat(rest.exchange(url("/api/paper/books/rules/status"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("status", "ACTIVE"), owner), JsonNode.class).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(rest.exchange(url("/api/paper/books/rules/reset"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("confirm", "claude"), owner), JsonNode.class).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            ResponseEntity<JsonNode> reset = rest.exchange(url("/api/paper/books/rules/reset"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("confirm", "rules"), owner), JsonNode.class);
            assertThat(reset.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(reset.getBody().path("book").path("code").asString()).isEqualTo("rules");
            JsonNode risk = authorizedExchange("/api/paper/run/risk", HttpMethod.POST).getBody();
            assertThat(risk.path("ok").asBoolean()).isTrue();
            assertThat(risk.path("outcome").path("skippedReason").asString()).contains("paper.quotes");
            assertThat(risk.path("outcome").has("alerts")).as("운영 알림이 없으면 칸 없음 — 미국 응답 그대로(C2c)").isFalse();
            assertThat(risk.path("outcome").has("confirmed")).as("확정 조정이 없으면 칸 없음 — 미국 응답 그대로(C3)").isFalse();
            assertThat(authorizedExchange("/api/paper/books/nope/orders", HttpMethod.GET).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            ResponseEntity<JsonNode> notAudited = authorizedExchange("/api/paper/books/bench_spy/execution", HttpMethod.GET);
            assertThat(notAudited.getStatusCode()).as("실행 감사는 미국 Claude 계좌만(초기화한 벤치마크도 400)")
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(notAudited.getBody().path("message").asString()).contains("미국 Claude 계좌");
            JsonNode execution = authorizedGet("/api/paper/books/claude/execution");
            assertThat(execution.path("orders").size()).as("감사 행 없음 — 빈 목록").isZero();
            assertThat(execution.path("summary").path("timings").get(0).path("meanBp").isNull()).as("표본 없음 — null").isTrue();

            // 결정: 시작 전 책은 수동 결정 400, 후보 목록 저장본이 없으면 시작 400(Claude 책 시작·미리보기도 — Claude를 부르기
            // 전에 멈춤. 테스트 설정은 키도 비어 있어 실제 호출이 나가지 않음)
            ResponseEntity<JsonNode> notStarted = rest.exchange(url("/api/paper/run/decision"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "rules"), owner), JsonNode.class);
            assertThat(notStarted.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(notStarted.getBody().path("message").asString()).contains("시작 전");
            ResponseEntity<JsonNode> start = rest.exchange(url("/api/paper/run/initial-decision"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "rules"), owner), JsonNode.class);
            assertThat(start.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(start.getBody().path("message").asString()).contains("후보 목록");
            ResponseEntity<JsonNode> claudeManual = rest.exchange(url("/api/paper/run/decision"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "claude"), owner), JsonNode.class);
            assertThat(claudeManual.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(claudeManual.getBody().path("message").asString()).contains("시작 전");
            boolean startSelected = jdbc.queryForObject("SELECT COUNT(*) FROM paper_selection_log "
                    + "WHERE as_of_date = DATE '2026-10-23'", Long.class) > 0;
            for (Map<String, Object> claudeStart : startSelected ? List.<Map<String, Object>>of()
                    : List.<Map<String, Object>>of(Map.of("book", "claude"), Map.of("book", "claude", "preview", true))) {
                ResponseEntity<JsonNode> claude = rest.exchange(url("/api/paper/run/initial-decision"), HttpMethod.POST,
                        new HttpEntity<>(claudeStart, owner), JsonNode.class);
                assertThat(claude.getStatusCode()).as(claudeStart.toString()).isEqualTo(HttpStatus.BAD_REQUEST);
                assertThat(claude.getBody().path("message").asString()).as(claudeStart.toString()).contains("후보 목록");
            }
            assertThat(authorizedGet("/api/paper/decisions?book=rules").path("decisions").size()).isZero();
            assertThat(authorizedGet("/api/paper/decisions?book=claude").path("decisions").size()).isZero();

            // 설정: 지금 행·키 설명, 규칙 책 영향 키를 바꾸면 버전 +1과 경고, 틀린 값은 400(아무것도 바꾸지 않음), 이력은 최근 순
            JsonNode view = authorizedGet("/api/paper/settings");
            assertThat(view.path("available").asBoolean()).isTrue();
            int version = view.path("version").asInt();
            assertThat(view.path("keys").size()).isGreaterThan(30);
            assertThat(view.path("body").path("model").isString()).isTrue();
            ResponseEntity<JsonNode> saved = rest.exchange(url("/api/paper/settings"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("trailingStopPct", 7.5, "effort", "medium"), owner), JsonNode.class);
            assertThat(saved.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(saved.getBody().path("version").asInt()).isEqualTo(version + 1);
            assertThat(saved.getBody().path("changedKeys").toString()).contains("trailingStopPct", "effort");
            assertThat(saved.getBody().path("warning").asString()).contains("동결된 대조군");
            ResponseEntity<JsonNode> invalid = rest.exchange(url("/api/paper/settings"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("trailingStopPct", 0, "model", "gpt"), owner), JsonNode.class);
            assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(invalid.getBody().path("message").asString()).contains("trailingStopPct", "model");
            assertThat(authorizedGet("/api/paper/settings").path("version").asInt()).isEqualTo(version + 1);
            JsonNode history = authorizedGet("/api/paper/settings/history");
            assertThat(history.path("history").get(0).path("version").asInt()).isEqualTo(version + 1);
            assertThat(history.path("history").get(0).path("changedKeys").toString()).contains("trailingStopPct");

            // 운용 중인 규칙 책(테스트 DB만): 수동 결정은 매도 신호만 보고, 보유가 없으니 주문 없이 한 건 — 다시 눌러도 같은 결정
            jdbc.update("UPDATE paper_books SET status = 'ACTIVE', started_on = DATE '2026-10-23' WHERE code = 'rules'");
            ResponseEntity<JsonNode> manual = rest.exchange(url("/api/paper/run/decision"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "rules"), owner), JsonNode.class);
            assertThat(manual.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(manual.getBody().path("ok").asBoolean()).isTrue();
            JsonNode decided = manual.getBody().path("decision");
            assertThat(decided.path("kind").asString()).isEqualTo("MANUAL");
            assertThat(decided.path("status").asString()).isEqualTo("NO_TRADE");
            assertThat(decided.path("orderCount").asInt(-1)).isZero();
            long decisionId = decided.path("id").asLong();
            assertThat(rest.exchange(url("/api/paper/run/decision"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("book", "rules"), owner), JsonNode.class).getBody()
                    .path("decision").path("id").asLong()).as("같은 거래일 MANUAL은 한 건").isEqualTo(decisionId);
            JsonNode list = authorizedGet("/api/paper/decisions?book=rules&limit=5");
            assertThat(list.path("decisions").size()).isEqualTo(1);
            assertThat(list.path("decisions").get(0).path("id").asLong()).isEqualTo(decisionId);
            JsonNode detail = authorizedGet("/api/paper/decisions/" + decisionId);
            assertThat(detail.path("decision").path("book").asString()).isEqualTo("rules");
            assertThat(detail.path("decision").path("response").path("summary").asString()).isNotBlank();
            assertThat(detail.path("orders").size()).isZero();
            assertThat(authorizedExchange("/api/paper/decisions/987654321", HttpMethod.GET).getStatusCode())
                    .as("없는 결정은 400").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(authorizedExchange("/api/paper/decisions?book=bench_spy", HttpMethod.GET).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
        } finally {
            deletePaperBooks();
            jdbc.update("DELETE FROM paper_job_runs WHERE job = 'decision'");
            if (!settingsExisted) {
                jdbc.update("DELETE FROM paper_settings");
                jdbc.update("DELETE FROM paper_settings_history");
            } else {
                int before = ((Number) settingsBefore.get("version")).intValue();
                jdbc.update("UPDATE paper_settings SET version = ?, body = CAST(? AS jsonb) WHERE id = 1", before,
                        settingsBefore.get("body"));
                jdbc.update("DELETE FROM paper_settings_history WHERE version > ?", before);
            }
        }
    }

    @Test
    @DisplayName("🧪 투자 OS 프레임·메모: 회원은 403, 운영자는 판 보기·형식이 틀린 수동 편집 400·메모 쓰기/목록/보관·키 없는 제안은 FAILED(외부 호출 없음)")
    void paperFrameworkAndNotes() {
        HttpHeaders member = new HttpHeaders();
        member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        member.setContentType(MediaType.APPLICATION_JSON);
        for (String path : List.of("/api/paper/framework", "/api/paper/framework/versions/0",
                "/api/paper/framework/proposals", "/api/paper/notes")) {
            ResponseEntity<JsonNode> denied = rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(null, member),
                    JsonNode.class);
            assertThat(denied.getStatusCode()).as("회원 GET " + path).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(denied.getBody().path("required").asString()).isEqualTo("OWNER");
        }
        for (String path : List.of("/api/paper/framework", "/api/paper/framework/proposals",
                "/api/paper/framework/proposals/1/approve", "/api/paper/framework/proposals/1/reject",
                "/api/paper/notes")) {
            assertThat(rest.exchange(url(path), HttpMethod.POST, new HttpEntity<>(Map.of("text", "글"), member),
                    String.class).getStatusCode()).as("회원 POST " + path).isEqualTo(HttpStatus.FORBIDDEN);
        }
        assertThat(rest.exchange(url("/api/paper/notes/1"), HttpMethod.DELETE, new HttpEntity<>(null, member),
                String.class).getStatusCode()).as("회원 DELETE 메모").isEqualTo(HttpStatus.FORBIDDEN);

        assumePaperSchema();
        HttpHeaders owner = new HttpHeaders();
        owner.add(HttpHeaders.COOKIE, sessionCookie);
        owner.setContentType(MediaType.APPLICATION_JSON);
        // 테스트 DB만 — 시험 전 상태를 기억해 끝에 되돌립니다(판은 v0 시드, 사용량은 오늘(KST) 행).
        boolean frameworkExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_framework_versions", Long.class) > 0;
        java.time.LocalDate today = com.macrodash.Kst.today();
        boolean usageExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_api_usage WHERE day = ?", Long.class,
                java.sql.Date.valueOf(today)) > 0;
        long callsBefore = jdbc.queryForObject("SELECT COALESCE(SUM(calls), 0) FROM paper_api_usage WHERE day = ?",
                Long.class, java.sql.Date.valueOf(today));
        long maxNote = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM paper_notes", Long.class);
        long maxProposal = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM paper_framework_proposals", Long.class);
        try {
            JsonNode view = authorizedGet("/api/paper/framework");
            assertThat(view.path("available").asBoolean()).isTrue();
            JsonNode current = view.path("current");
            int version = current.path("version").asInt(-1);
            assertThat(version).isGreaterThanOrEqualTo(0);
            assertThat(current.path("rendered").asString()).startsWith("# 투자 OS — v" + version + " (");
            assertThat(current.path("body").path("engines").size()).isEqualTo(8);
            assertThat(view.path("versions").size()).isGreaterThanOrEqualTo(1);
            assertThat(authorizedGet("/api/paper/framework/versions/" + version).path("version").path("version").asInt())
                    .isEqualTo(version);
            assertThat(authorizedExchange("/api/paper/framework/versions/987654", HttpMethod.GET).getStatusCode())
                    .as("없는 판은 400").isEqualTo(HttpStatus.BAD_REQUEST);

            tools.jackson.databind.node.ObjectNode seven = (tools.jackson.databind.node.ObjectNode)
                    current.path("body").deepCopy();
            ((tools.jackson.databind.node.ArrayNode) seven.path("engines")).remove(7);
            ResponseEntity<JsonNode> invalid = rest.exchange(url("/api/paper/framework"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("body", seven, "changelog", "엔진 하나 뺌", "baseVersion", version), owner),
                    JsonNode.class);
            assertThat(invalid.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(invalid.getBody().path("message").asString()).contains("엔진").contains("8개");
            assertThat(rest.exchange(url("/api/paper/framework"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("body", current.path("body"), "changelog", " ", "baseVersion", version), owner),
                    JsonNode.class).getStatusCode()).as("변경 기록 없음").isEqualTo(HttpStatus.BAD_REQUEST);
            // FW-1 기준 판이 지금 판이 아니거나 없으면 400 — 그사이 생긴 판의 변경을 지우지 않게.
            ResponseEntity<JsonNode> stale = rest.exchange(url("/api/paper/framework"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("body", current.path("body"), "changelog", "옛 판에서 고침", "baseVersion",
                            version + 1), owner), JsonNode.class);
            assertThat(stale.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(stale.getBody().path("message").asString()).contains("다른 판이 먼저 생겼습니다");
            assertThat(rest.exchange(url("/api/paper/framework"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("body", current.path("body"), "changelog", "기준 판 없음"), owner),
                    JsonNode.class).getStatusCode()).as("baseVersion 없음").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(view.path("maxIdNumbers").path("rules").size()).as("새 번호의 바닥(FW-2)").isEqualTo(8);
            assertThat(authorizedGet("/api/paper/framework").path("current").path("version").asInt())
                    .as("아무것도 바꾸지 않음").isEqualTo(version);

            ResponseEntity<JsonNode> market = rest.exchange(url("/api/paper/notes"), HttpMethod.POST, new HttpEntity<>(
                    Map.of("kind", "MARKET", "asOfDate", "2026-10-23", "title", "시황", "body", "브렌트 95"), owner),
                    JsonNode.class);
            assertThat(market.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(market.getBody().path("ok").asBoolean()).isTrue();
            long marketId = market.getBody().path("note").path("id").asLong();
            assertThat(market.getBody().path("note").path("expiresOn").asString()).as("기준일 + 3거래일")
                    .isEqualTo("2026-10-28");
            ResponseEntity<JsonNode> insight = rest.exchange(url("/api/paper/notes"), HttpMethod.POST, new HttpEntity<>(
                    Map.of("kind", "INSIGHT", "title", "방법론", "body", "집중 투자가 낫다"), owner), JsonNode.class);
            assertThat(insight.getStatusCode()).isEqualTo(HttpStatus.OK);
            long insightId = insight.getBody().path("note").path("id").asLong();
            assertThat(insight.getBody().path("note").path("expiresOn").isNull()).isTrue();
            assertThat(rest.exchange(url("/api/paper/notes"), HttpMethod.POST, new HttpEntity<>(
                    Map.of("kind", "NEWS", "title", "t", "body", "b"), owner), JsonNode.class).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            JsonNode listed = authorizedGet("/api/paper/notes?includeExpired=true");
            assertThat(listed.path("notes").toString()).contains("\"id\":" + marketId).contains("\"id\":" + insightId);

            // 테스트 설정은 Anthropic 키가 비어 있어 요청을 보내지 않고 NO_KEY로 끝납니다(FAILED 제안, 호출 수는 되돌림).
            ResponseEntity<JsonNode> proposed = rest.exchange(url("/api/paper/framework/proposals"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("noteId", insightId), owner), JsonNode.class);
            assertThat(proposed.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(proposed.getBody().path("ok").asBoolean(true)).isFalse();
            JsonNode failed = proposed.getBody().path("proposal");
            assertThat(failed.path("status").asString()).isEqualTo("FAILED");
            assertThat(failed.path("error").asString()).startsWith("[NO_KEY]");
            assertThat(failed.path("baseVersion").asInt()).isEqualTo(version);
            assertThat(rest.exchange(url("/api/paper/framework/proposals"), HttpMethod.POST,
                    new HttpEntity<>(Map.of("noteId", marketId), owner), JsonNode.class).getStatusCode())
                    .as("MARKET 메모로는 제안하지 않음").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(rest.exchange(url("/api/paper/framework/proposals"), HttpMethod.POST,
                    new HttpEntity<>(Map.of(), owner), JsonNode.class).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(authorizedGet("/api/paper/framework/proposals").path("proposals").toString())
                    .contains("\"id\":" + failed.path("id").asLong());
            assertThat(authorizedExchange("/api/paper/framework/proposals/" + failed.path("id").asLong() + "/approve",
                    HttpMethod.POST).getStatusCode()).as("FAILED는 승인할 수 없음").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(jdbc.queryForObject("SELECT COALESCE(SUM(calls), 0) FROM paper_api_usage WHERE day = ?",
                    Long.class, java.sql.Date.valueOf(today))).as("보내지 않은 호출은 세지 않음(잡은 호출을 되돌림)")
                    .isEqualTo(callsBefore);

            ResponseEntity<JsonNode> archived = authorizedExchange("/api/paper/notes/" + marketId, HttpMethod.DELETE);
            assertThat(archived.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(archived.getBody().path("ok").asBoolean()).isTrue();
            assertThat(authorizedGet("/api/paper/notes").path("notes").toString()).as("보관한 메모는 기본 목록에서 빠짐")
                    .doesNotContain("\"id\":" + marketId + ",");
            assertThat(authorizedExchange("/api/paper/notes/987654321", HttpMethod.DELETE).getStatusCode())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            // F6 보관한 방법론 메모로는 제안하지 않음(400 — 부르지 않음).
            assertThat(authorizedExchange("/api/paper/notes/" + insightId, HttpMethod.DELETE).getStatusCode())
                    .isEqualTo(HttpStatus.OK);
            ResponseEntity<JsonNode> archivedProposal = rest.exchange(url("/api/paper/framework/proposals"),
                    HttpMethod.POST, new HttpEntity<>(Map.of("noteId", insightId), owner), JsonNode.class);
            assertThat(archivedProposal.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(archivedProposal.getBody().path("message").asString()).contains("보관한 메모");

            assertThat(authorizedGet("/api/paper/overview").path("frameworkBoundaries").isArray()).isTrue();
            assertThat(authorizedGet("/api/paper/status").path("apiUsage").path("today").path("isEstimated")
                    .asBoolean()).isTrue();
        } finally {
            jdbc.update("DELETE FROM paper_framework_proposals WHERE id > ?", maxProposal);
            jdbc.update("DELETE FROM paper_notes WHERE id > ?", maxNote);
            if (!frameworkExisted) {
                jdbc.update("DELETE FROM paper_framework_versions");
            }
            if (!usageExisted) {
                jdbc.update("DELETE FROM paper_api_usage WHERE day = ?", java.sql.Date.valueOf(today));
            }
        }
    }

    @Test
    @DisplayName("🧪 주간 복기: 회원은 403, 운영자는 목록·한 건·수동 실행 — 조건이 안 되면 400, 결정이 없으면 SKIPPED, 키가 없으면 외부 호출 없이 "
            + "NO_KEY(API_ERROR, 한 번 재시도) — 한 주 한 행")
    void paperWeeklyReviews() {
        HttpHeaders member = new HttpHeaders();
        member.add(HttpHeaders.COOKIE, login(MEMBER, "test-password"));
        member.setContentType(MediaType.APPLICATION_JSON);
        for (String path : List.of("/api/paper/reviews", "/api/paper/reviews/2026-10-30")) {
            ResponseEntity<JsonNode> denied = rest.exchange(url(path), HttpMethod.GET, new HttpEntity<>(null, member),
                    JsonNode.class);
            assertThat(denied.getStatusCode()).as("회원 GET " + path).isEqualTo(HttpStatus.FORBIDDEN);
            assertThat(denied.getBody().path("required").asString()).isEqualTo("OWNER");
        }
        assertThat(rest.exchange(url("/api/paper/reviews/run"), HttpMethod.POST, new HttpEntity<>(Map.of(), member),
                String.class).getStatusCode()).as("회원 POST 수동 복기").isEqualTo(HttpStatus.FORBIDDEN);

        assumePaperSchema();
        java.time.LocalDate week = com.macrodash.analytics.ReviewFacts.latestCompletedWeekEnding(java.time.Instant.now());
        org.junit.jupiter.api.Assumptions.assumeTrue(jdbc.queryForObject(
                "SELECT COUNT(*) FROM paper_reviews WHERE week_ending = ?", Long.class, java.sql.Date.valueOf(week)) == 0,
                "테스트 DB에 이번 주 복기 행이 이미 있습니다");
        deletePaperBooks();
        // 테스트 DB만 — 시험 전 상태를 기억해 끝에 되돌립니다(설정 행·판 v0 시드·오늘(KST) 사용량 행·제안).
        boolean settingsExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_settings", Long.class) > 0;
        Map<String, Object> settingsBefore = settingsExisted ? jdbc.queryForMap(
                "SELECT version, body::text AS body FROM paper_settings WHERE id = 1") : null;
        boolean frameworkExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_framework_versions", Long.class) > 0;
        java.time.LocalDate today = com.macrodash.Kst.today();
        boolean usageExisted = jdbc.queryForObject("SELECT COUNT(*) FROM paper_api_usage WHERE day = ?", Long.class,
                java.sql.Date.valueOf(today)) > 0;
        long maxProposal = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM paper_framework_proposals", Long.class);
        HttpHeaders owner = new HttpHeaders();
        owner.add(HttpHeaders.COOKIE, sessionCookie);
        owner.setContentType(MediaType.APPLICATION_JSON);
        try {
            JsonNode list = authorizedGet("/api/paper/reviews");
            assertThat(list.path("available").asBoolean()).isTrue();
            assertThat(list.path("latestWeekEnding").asString()).isEqualTo(week.toString());
            assertThat(list.path("latestOpensAtKst").asString()).isNotBlank();
            assertThat(authorizedExchange("/api/paper/reviews/2026-13-01", HttpMethod.GET).getStatusCode())
                    .as("날짜 형식").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(authorizedExchange("/api/paper/reviews/" + week, HttpMethod.GET).getStatusCode())
                    .as("없는 주").isEqualTo(HttpStatus.BAD_REQUEST);

            ResponseEntity<JsonNode> noBook = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST);
            assertThat(noBook.getStatusCode()).as("계좌 없음 — 부르지 않음").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(noBook.getBody().path("message").asString()).contains("Claude 계좌");
            ResponseEntity<JsonNode> noBookUs = authorizedExchange("/api/paper/reviews/run?market=US", HttpMethod.POST);
            assertThat(noBookUs.getStatusCode()).as("?market=US = 시장 값 없음(F1 리뷰)").isEqualTo(noBook.getStatusCode());
            assertThat(noBookUs.getBody()).as("?market=US = 시장 값 없음(F1 리뷰)").isEqualTo(noBook.getBody());
            assertThat(authorizedExchange("/api/paper/init", HttpMethod.POST).getStatusCode()).isEqualTo(HttpStatus.OK);
            ResponseEntity<JsonNode> notStarted = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST);
            assertThat(notStarted.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(notStarted.getBody().path("message").asString()).contains("시작 전");
            assertThat(authorizedExchange("/api/paper/reviews/run?market=US", HttpMethod.POST).getBody())
                    .as("?market=US = 시장 값 없음(F1 리뷰)").isEqualTo(notStarted.getBody());

            jdbc.update("UPDATE paper_books SET status = 'ACTIVE', started_on = ? WHERE code = 'claude'",
                    java.sql.Date.valueOf(week.minusWeeks(2)));
            ResponseEntity<JsonNode> waiting = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST);
            assertThat(waiting.getStatusCode()).as("확정 종가 없음(setUp이 snapshots를 비움)").isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(waiting.getBody().path("message").asString()).contains("확정 종가");
            jdbc.update("INSERT INTO paper_nav_daily (book_code, trading_date, nav, cash, equity_value, exposure_pct, "
                    + "prices_final) VALUES ('claude', ?, 100000, 100000, 0, 0, true)", java.sql.Date.valueOf(week));

            // 창 안에 Claude 결정이 없음 → 부르지 않고 SKIPPED, 두 번 눌러도 한 행.
            ResponseEntity<JsonNode> skipped = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST);
            assertThat(skipped.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(skipped.getBody().path("ok").asBoolean()).isTrue();
            assertThat(skipped.getBody().path("outcome").asString()).isEqualTo("SKIPPED");
            assertThat(skipped.getBody().path("review").path("status").asString()).isEqualTo("SKIPPED");
            assertThat(skipped.getBody().path("review").path("input").path("window").path("weeks").asInt()).isEqualTo(4);
            ResponseEntity<JsonNode> again = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST);
            assertThat(again.getBody().path("outcome").asString()).isEqualTo("ALREADY_REVIEWED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_reviews WHERE week_ending = ?", Long.class,
                    java.sql.Date.valueOf(week))).isEqualTo(1L);
            JsonNode listed = authorizedGet("/api/paper/reviews").path("reviews").get(0);
            assertThat(listed.path("weekEnding").asString()).isEqualTo(week.toString());
            assertThat(listed.path("verdictCounts").isNull()).as("OK가 아닌 행의 판정 수는 null").isTrue();
            assertThat(authorizedGet("/api/paper/reviews/" + week).path("review").path("status").asString())
                    .isEqualTo("SKIPPED");

            // 창 안에 관망 결정 하나 — 테스트 설정은 Anthropic 키가 비어 있어 요청을 보내지 않고 NO_KEY(잡은 호출은 되돌림).
            jdbc.update("DELETE FROM paper_reviews WHERE week_ending = ?", java.sql.Date.valueOf(week));
            jdbc.update("INSERT INTO paper_decisions (book_code, as_of_trading_date, kind, status, model, framework_version, "
                    + "settings_version, target_exposure_pct, response) VALUES ('claude', ?, 'SCHEDULED', 'NO_TRADE', "
                    + "'claude-sonnet-5-5', 0, 1, 40, CAST(? AS jsonb))", java.sql.Date.valueOf(week.minusDays(3)),
                    "{\"stance\":\"NEUTRAL\",\"summary\":\"관망\",\"noTradeReason\":\"일정 대기\"}");
            long callsBefore = jdbc.queryForObject("SELECT COALESCE(SUM(calls), 0) FROM paper_api_usage WHERE day = ?",
                    Long.class, java.sql.Date.valueOf(today));
            JsonNode first = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST).getBody();
            assertThat(first.path("outcome").asString()).isEqualTo("REVIEWED");
            assertThat(first.path("review").path("status").asString()).isEqualTo("API_ERROR");
            assertThat(first.path("review").path("error").asString()).startsWith("[NO_KEY]");
            assertThat(first.path("review").path("retryable").asBoolean()).isTrue();
            assertThat(first.path("review").path("input").path("decisions").size()).isEqualTo(1);
            JsonNode retried = authorizedExchange("/api/paper/reviews/run", HttpMethod.POST).getBody();
            assertThat(retried.path("review").path("retryCount").asInt()).as("API 오류는 같은 행에서 한 번 더").isEqualTo(1);
            assertThat(retried.path("review").path("retryable").asBoolean(true)).isFalse();
            assertThat(authorizedExchange("/api/paper/reviews/run", HttpMethod.POST).getBody().path("outcome").asString())
                    .isEqualTo("ALREADY_REVIEWED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_reviews WHERE week_ending = ?", Long.class,
                    java.sql.Date.valueOf(week))).isEqualTo(1L);
            assertThat(jdbc.queryForObject("SELECT COALESCE(SUM(calls), 0) FROM paper_api_usage WHERE day = ?",
                    Long.class, java.sql.Date.valueOf(today))).as("보내지 않은 호출은 세지 않음").isEqualTo(callsBefore);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM paper_framework_proposals WHERE id > ?", Long.class,
                    maxProposal)).as("제안 없음").isZero();
        } finally {
            jdbc.update("DELETE FROM paper_reviews WHERE week_ending = ?", java.sql.Date.valueOf(week));
            jdbc.update("DELETE FROM paper_job_runs WHERE job = 'review'");
            jdbc.update("DELETE FROM paper_framework_proposals WHERE id > ?", maxProposal);
            deletePaperBooks();
            if (!settingsExisted) {
                jdbc.update("DELETE FROM paper_settings");
                jdbc.update("DELETE FROM paper_settings_history");
            } else {
                int before = ((Number) settingsBefore.get("version")).intValue();
                jdbc.update("UPDATE paper_settings SET version = ?, body = CAST(? AS jsonb) WHERE id = 1", before,
                        settingsBefore.get("body"));
                jdbc.update("DELETE FROM paper_settings_history WHERE version > ?", before);
            }
            if (!frameworkExisted) {
                jdbc.update("DELETE FROM paper_framework_versions");
            }
            if (!usageExisted) {
                jdbc.update("DELETE FROM paper_api_usage WHERE day = ?", java.sql.Date.valueOf(today));
            }
        }
    }

    private void assumePaperSchema() {
        org.junit.jupiter.api.Assumptions.assumeTrue(Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT to_regclass('paper_api_usage') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_attribute "
                        + "WHERE attrelid = to_regclass('paper_track_record') AND attname = 'data_source' "
                        + "AND NOT attisdropped) AND EXISTS (SELECT 1 FROM pg_attribute "
                        + "WHERE attrelid = to_regclass('paper_api_usage') AND attname = 'est_cost_calls' "
                        + "AND NOT attisdropped) AND to_regclass('paper_reviews') IS NOT NULL", Boolean.class)),
                "테스트 DB에 V8~V12(paper_*)가 없습니다 — make db-test");
    }

    @Test
    @DisplayName("AI 대기 한도 설정이 실제로 적용된다")
    void aiTimeoutPropertyIsInjected() {
        // 생성자가 둘인데 아무 표시가 없으면 Spring이 무인자 쪽을 골라
        // AI_TIMEOUT_SECONDS가 조용히 무시됩니다. 실제 빈으로 확인합니다.
        assertThat(ai.timeoutSeconds()).isEqualTo(333);
    }

    private JsonNode authorizedGet(String path) {
        ResponseEntity<JsonNode> response = authorizedExchange(path, HttpMethod.GET);

        assertThat(response.getStatusCode())
                .as("%s 응답 상태", path)
                .isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    /** 상태 코드를 검사하지 않고 그대로 돌려줍니다(오류 응답을 확인할 때). */
    private ResponseEntity<JsonNode> authorizedExchange(String path, HttpMethod method) {
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.COOKIE, sessionCookie);
        return rest.exchange(url(path), method, new HttpEntity<>(null, headers), JsonNode.class);
    }

    private void insertSnapshot(String name, String payload) {
        insertSnapshot(name, payload, "ok");
    }

    private void insertSnapshot(String name, String payload, String status) {
        jdbc.update(
                "INSERT INTO snapshots (name, payload, kind, status, collected_at) "
                        + "VALUES (?, ?::jsonb, 'json', ?, now()) "
                        + "ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, "
                        + "status = EXCLUDED.status, collected_at = EXCLUDED.collected_at",
                name, payload, status);
    }

    private String url(String path) {
        return "http://localhost:" + port + path;
    }
}
