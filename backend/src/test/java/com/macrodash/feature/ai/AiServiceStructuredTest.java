package com.macrodash.feature.ai;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.ClaudeSse;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 모의 매매 Claude 책의 구조화 출력 호출({@link AiService#structured}) — 공식 SDK를 실제로 돌리고, Claude API 자리에 가짜
 * 서버를 둡니다(유료 호출 없음, {@link AiServiceAnthropicTest}와 같은 방식).
 *
 * <p>요청 모양(스키마·effort·시스템 캐시 블록·temperature/thinking 없음·출력 한도), 정상 응답의 텍스트와 토큰(캐시 포함),
 * 거절·출력 한도·빈 응답·HTTP 오류·연결 실패·시간 초과의 종류와 과금 표시, 키 없음, 로그에 키·주소가 남지 않음을 고정합니다.
 * 스트리밍 판({@link AiService#structuredStreaming} — 주간 복기, QA-475)은 가짜 서버가 같은 응답을 SSE 사건 열로 답해({@link ClaudeSse})
 * 같은 결과·종류가 나오는지와, 스트리밍에만 있는 실패(스트림 도중 오류 사건·끝 사건 없음·스트림 도중 시간 초과)와 그때 남기는
 * 사용량(받은 사건의 토큰만 — 검토 지적)을 봅니다.
 */
class AiServiceStructuredTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String MODEL = "claude-sonnet-5-5";
    private static final String KEY = "sk-ant-test-STRUCTUREDKEY";

    /** 결정 스키마를 닮은 작은 스키마 — 형 배열·pattern(역슬래시)·한글 enum·중첩 객체가 그대로 가는지 봅니다. */
    private static final String SCHEMA = """
            {"type":"object","additionalProperties":false,"required":["schemaVersion","stance","orders"],
             "properties":{
               "schemaVersion":{"const":2},
               "stance":{"enum":["RISK_ON","RISK_OFF"]},
               "orders":{"type":"array","items":{"type":"object","additionalProperties":false,
                 "required":["ticker","weight","labels"],
                 "properties":{"ticker":{"type":"string","pattern":"^[A-Z.\\\\-]{1,8}$"},
                               "weight":{"type":["number","null"]},
                               "labels":{"type":"array","items":{"enum":["사실","확인 필요"]}}}}}}}
            """;

    private HttpServer server;
    private final AtomicInteger hits = new AtomicInteger();
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    private final List<String> apiKeys = new CopyOnWriteArrayList<>();
    private final Logger logger = (Logger) LoggerFactory.getLogger(AiService.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @AfterEach
    void stop() {
        logger.detachAppender(appender);
        if (server != null) {
            server.stop(0);
            server = null;
        }
    }

    private String startServer(int status, String body) throws Exception {
        return startServer(status, body, 0);
    }

    /** /v1/messages에 status·body로 답하는 가짜 Claude API. {@code delayMillis}만큼 기다렸다 답합니다(시간 초과 시험). */
    private String startServer(int status, String body, long delayMillis) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            hits.incrementAndGet();
            JsonNode request = MAPPER.readTree(exchange.getRequestBody().readAllBytes());
            requests.add(request);
            apiKeys.add(String.valueOf(exchange.getRequestHeaders().getFirst("x-api-key")));
            if (delayMillis > 0) {
                try {
                    Thread.sleep(delayMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            // 스트리밍 요청(QA-475)이면 같은 응답을 SSE 사건 열로 — 오류 상태는 스트리밍이어도 JSON 본문 그대로입니다.
            boolean sse = status == 200 && ClaudeSse.requested(request);
            byte[] bytes = (sse ? ClaudeSse.fromMessage(body) : body).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", sse ? ClaudeSse.CONTENT_TYPE : "application/json");
            try {
                exchange.sendResponseHeaders(status, bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            } catch (java.io.IOException ignored) {
                // 시간 초과 시험에서는 클라이언트가 먼저 끊습니다.
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /**
     * 스트림 응답을 사건 단위로 보내는 가짜 Claude API(200, SSE) — {@code first}를 보내 비우고 {@code pauseMillis}만큼 쉰 뒤 {@code rest}를
     * 보냅니다(스트림 도중 시간 초과·오류 사건·끝 사건 없는 스트림 시험).
     */
    private String startStreamServer(List<String> first, long pauseMillis, List<String> rest) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            hits.incrementAndGet();
            requests.add(MAPPER.readTree(exchange.getRequestBody().readAllBytes()));
            exchange.getResponseHeaders().set("Content-Type", ClaudeSse.CONTENT_TYPE);
            try {
                exchange.sendResponseHeaders(200, 0);   // 0 = 길이를 정하지 않음(조각 전송)
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(String.join("", first).getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    if (pauseMillis > 0) {
                        Thread.sleep(pauseMillis);
                    }
                    out.write(String.join("", rest).getBytes(StandardCharsets.UTF_8));
                }
            } catch (java.io.IOException ignored) {
                // 시간 초과 시험에서는 클라이언트가 먼저 끊습니다.
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static AiService service(String baseUrl, String key) {
        return restricted(baseUrl, key, "");
    }

    /** 허용 목록({@code AI_ENGINES})을 준 서비스 — 빈 값이면 제한 없음({@link #service}). */
    private static AiService restricted(String baseUrl, String key, String engines) {
        AiService service = new AiService(240, 60, 180, engines);
        for (String field : List.of("nvidiaKey", "cerebrasKey", "cloudflareAccountId", "cloudflareToken")) {
            ReflectionTestUtils.setField(service, field, "");
        }
        ReflectionTestUtils.setField(service, "anthropicKey", key);
        service.anthropicBaseUrl = baseUrl;
        return service;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> schema() throws Exception {
        return MAPPER.readValue(SCHEMA, LinkedHashMap.class);
    }

    private static String message(String content, String stopReason, String extra, String usage) {
        return """
                {"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-5-5",
                 "content":%s,"stop_reason":"%s","stop_sequence":null%s,
                 "usage":%s}
                """.formatted(content, stopReason, extra, usage);
    }

    private static String textBlock(String text) throws Exception {
        return "[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"},{\"type\":\"text\",\"text\":"
                + MAPPER.writeValueAsString(text) + "}]";
    }

    private static final String USAGE = "{\"input_tokens\":21000,\"output_tokens\":3100,"
            + "\"cache_read_input_tokens\":7800,\"cache_creation_input_tokens\":0}";

    private static final String ANSWER = "{\"schemaVersion\":2,\"stance\":\"RISK_ON\",\"orders\":[]}";

    @Test
    @DisplayName("정상 응답: 사고 블록 뒤의 텍스트(JSON)와 토큰 사용량(캐시 읽기·쓰기 포함)을 돌려준다")
    void returnsJsonTextAndUsage() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));

        AiService.StructuredResult result = service(base, KEY)
                .structured(MODEL, "프레임 v1", "패킷", schema(), "high", 120);

        assertThat(result.ok()).isTrue();
        assertThat(result.text()).isEqualTo(ANSWER);
        assertThat(result.stopReason()).isEqualTo("end_turn");
        assertThat(result.errorKind()).isNull();
        assertThat(result.error()).isNull();
        assertThat(result.charged()).isTrue();
        assertThat(result.inputTokens()).isEqualTo(21_000L);
        assertThat(result.outputTokens()).isEqualTo(3_100L);
        assertThat(result.cacheReadTokens()).isEqualTo(7_800L);
        assertThat(result.cacheWriteTokens()).as("0은 API가 준 값 그대로 — 없는 값(null)과 구분").isEqualTo(0L);
        assertThat(result.latencyMs()).isGreaterThanOrEqualTo(0L);
        assertThat(hits.get()).isEqualTo(1);
        assertThat(apiKeys).containsExactly(KEY);
    }

    @Test
    @DisplayName("요청 본문: output_config에 스키마(그대로)·effort, 시스템은 캐시 블록, temperature·thinking·fallbacks 없음")
    void sendsSchemaEffortAndCachedSystem() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));

        service(base, KEY).structured(MODEL, "프레임 v1 — 시스템 프롬프트", "오늘의 패킷", schema(), "xhigh", 120);

        JsonNode sent = requests.get(0);
        assertThat(sent.path("model").asString()).isEqualTo(MODEL);
        assertThat(sent.path("max_tokens").asLong()).isEqualTo(16_000L).isEqualTo(AiService.STRUCTURED_MAX_TOKENS);
        assertThat(sent.path("output_config").path("effort").asString()).isEqualTo("xhigh");
        JsonNode format = sent.path("output_config").path("format");
        assertThat(format.path("type").asString()).isEqualTo("json_schema");
        assertThat(format.path("schema")).as("Jackson 3로 읽은 Map이 키·순서·형 배열·pattern·한글까지 그대로")
                .isEqualTo(MAPPER.readTree(SCHEMA));
        assertThat(List.copyOf(format.path("schema").path("properties").propertyNames()))
                .as("키 순서도 파일 순서 — 같은 스키마면 같은 요청 본문").containsExactly("schemaVersion", "stance", "orders");
        assertThat(format.path("schema").path("properties").path("orders").path("items").path("properties")
                .path("ticker").path("pattern").asString()).isEqualTo("^[A-Z.\\-]{1,8}$");

        JsonNode system = sent.path("system");
        assertThat(system.isArray()).as("캐시 표시를 달려면 문자열이 아니라 블록 목록").isTrue();
        assertThat(system.size()).isEqualTo(1);
        assertThat(system.get(0).path("type").asString()).isEqualTo("text");
        assertThat(system.get(0).path("text").asString()).isEqualTo("프레임 v1 — 시스템 프롬프트");
        assertThat(system.get(0).path("cache_control").path("type").asString()).isEqualTo("ephemeral");

        assertThat(sent.path("messages").size()).isEqualTo(1);
        assertThat(sent.path("messages").get(0).path("role").asString()).isEqualTo("user");
        assertThat(sent.path("messages").get(0).path("content").asString()).isEqualTo("오늘의 패킷");

        assertThat(sent.has("temperature")).as("Sonnet·Haiku 5.5는 기본값이 아닌 temperature에 400").isFalse();
        assertThat(sent.has("thinking")).as("사고는 기본(adaptive)").isFalse();
        assertThat(sent.has("fallbacks")).as("다른 모델로 자동 전환하지 않음(D5)").isFalse();
    }

    @Test
    @DisplayName("effort를 비우면 high(C2 기본), 대소문자는 무시, 시스템 프롬프트가 비면 system을 보내지 않는다")
    void effortDefaultsToHighAndBlankSystemIsOmitted() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));
        AiService service = service(base, KEY);

        service.structured(MODEL, null, "패킷", schema(), null, 60);
        service.structured(MODEL, "  ", "패킷", schema(), "MAX", 60);

        assertThat(requests.get(0).path("output_config").path("effort").asString()).isEqualTo("high");
        assertThat(requests.get(1).path("output_config").path("effort").asString()).isEqualTo("max");
        assertThat(requests.get(0).has("system")).isFalse();
        assertThat(requests.get(1).has("system")).isFalse();
    }

    @Test
    @DisplayName("안전 분류기 거절(refusal): REFUSAL·과금됨, 분류·설명을 남기고 다시 보내지 않는다")
    void refusalIsReportedWithCategory() throws Exception {
        String base = startServer(200, message("[]", "refusal",
                ",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"정책상 답할 수 없습니다\"}",
                "{\"input_tokens\":20000,\"output_tokens\":12}"));

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("REFUSAL");
        assertThat(result.stopReason()).isEqualTo("refusal");
        assertThat(result.charged()).isTrue();
        assertThat(result.error()).contains("거절", "cyber", "정책상 답할 수 없습니다");
        assertThat(result.text()).isNull();
        assertThat(result.inputTokens()).isEqualTo(20_000L);
        assertThat(result.cacheReadTokens()).as("API가 주지 않은 값은 0이 아니라 null").isNull();
        assertThat(result.cacheWriteTokens()).isNull();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("429: RATE_LIMIT·과금 안 됨, SDK가 다시 보내지 않는다(재시도는 부른 쪽이 같은 거래일 한 번 — C7)")
    void rateLimitIsNotRetried() throws Exception {
        String base = startServer(429,
                "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}");

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("RATE_LIMIT");
        assertThat(result.charged()).isFalse();
        assertThat(result.error()).contains("429").doesNotContain("엔진");
        assertThat(result.text()).isNull();
        assertThat(result.inputTokens()).isNull();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("형식이 깨진 응답(텍스트 블록 없음): EMPTY·과금됨, 받은 토큰은 남긴다")
    void emptyTextIsEmpty() throws Exception {
        String base = startServer(200, message("[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"}]",
                "end_turn", "", USAGE));

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("EMPTY");
        assertThat(result.charged()).isTrue();
        assertThat(result.text()).isNull();
        assertThat(result.stopReason()).isEqualTo("end_turn");
        assertThat(result.outputTokens()).isEqualTo(3_100L);
    }

    @Test
    @DisplayName("응답 본문이 Message 모양이 아니면(200인데 content 없음) EMPTY·과금됨")
    void unreadableMessageIsEmpty() throws Exception {
        String base = startServer(200, "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\"}");

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("EMPTY");
        assertThat(result.charged()).as("모델이 이미 답했을 수 있음 — 되돌리지 않는 쪽(QA-021)").isTrue();
    }

    @Test
    @DisplayName("출력 한도(max_tokens)로 끝나면 텍스트가 있어도 MAX_TOKENS — 잘린 JSON은 원문으로만 남긴다")
    void maxTokensIsFailureEvenWithText() throws Exception {
        String base = startServer(200, message(textBlock("{\"schemaVersion\":2,\"stance\":\"RIS"), "max_tokens", "", USAGE));

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("MAX_TOKENS");
        assertThat(result.charged()).isTrue();
        assertThat(result.text()).isEqualTo("{\"schemaVersion\":2,\"stance\":\"RIS");
        assertThat(result.error()).contains("출력 한도", "16000");
    }

    @Test
    @DisplayName("HTTP 오류 상태: 401·403·404·그 밖(500·402)을 종류로 나누고, 모두 과금 안 됨, 키는 문구에 없다")
    void httpErrorsAreClassified() throws Exception {
        Map<Integer, String> expected = new LinkedHashMap<>();
        expected.put(401, "UNAUTHORIZED");
        expected.put(403, "FORBIDDEN");
        expected.put(404, "NOT_FOUND");
        expected.put(500, "HTTP");
        expected.put(402, "HTTP");
        Map<Integer, String> types = Map.of(401, "authentication_error", 403, "permission_error",
                404, "not_found_error", 500, "api_error", 402, "billing_error");

        for (Map.Entry<Integer, String> entry : expected.entrySet()) {
            String base = startServer(entry.getKey(), "{\"type\":\"error\",\"error\":{\"type\":\""
                    + types.get(entry.getKey()) + "\",\"message\":\"x\"}}");

            AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 60);

            assertThat(result.errorKind()).as("HTTP %d", entry.getKey()).isEqualTo(entry.getValue());
            assertThat(result.ok()).isFalse();
            assertThat(result.charged()).as("HTTP %d", entry.getKey()).isFalse();
            assertThat(result.error()).doesNotContain(KEY);
            stop();
        }
        assertThat(hits.get()).as("상태마다 한 번씩만 — SDK 재시도 없음").isEqualTo(expected.size());
    }

    @Test
    @DisplayName("연결이 거부되면 IO·과금 안 됨, 로그에 키·요청 주소가 남지 않는다")
    void connectionRefusedIsUnchargedIo() throws Exception {
        // 서버를 띄웠다 바로 내려, 아무도 듣지 않는 포트를 얻습니다.
        String base = startServer(200, "{}");
        stop();
        appender.start();
        logger.addAppender(appender);

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 10);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("IO");
        assertThat(result.charged()).as("연결 단계에서 끝남 — 모델에 닿지 않음").isFalse();
        assertThat(result.inputTokens()).isNull();
        assertThat(appender.list).isNotEmpty();
        assertThat(appender.list).allSatisfy(event -> assertThat(event.getFormattedMessage())
                .doesNotContain(KEY).doesNotContain(base));
    }

    @Test
    @DisplayName("대기 한도를 넘기면 TIMEOUT — 응답을 기다리다 끊긴 것이라 과금된 것으로 본다")
    void slowResponseIsTimeout() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE), 3_000);

        AiService.StructuredResult result = service(base, KEY).structured(MODEL, "프레임", "패킷", schema(), "high", 1);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("TIMEOUT");
        assertThat(result.charged()).isTrue();
        assertThat(result.error()).contains("1초").doesNotContain("자동 탐색");
        assertThat(result.latencyMs()).isLessThan(3_000L);
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("키가 없으면 NO_KEY — 네트워크에 나가지 않고 과금도 없다")
    void missingKeyDoesNotCallOut() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));

        AiService.StructuredResult result = service(base, "").structured(MODEL, "프레임", "패킷", schema(), "high", 60);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("NO_KEY");
        assertThat(result.charged()).isFalse();
        assertThat(result.error()).contains("ANTHROPIC_API_KEY");
        assertThat(result.latencyMs()).isZero();
        assertThat(hits.get()).isZero();
    }

    @Test
    @DisplayName("허용 목록(AI_ENGINES)이 있으면 목록 엔진의 모델만 부른다 — 밖이면 NOT_ALLOWED, 키가 없어도 이쪽이 먼저, 나가지 않고 과금 없음")
    void allowListLimitsModels() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));

        AiService.StructuredResult sonnet = restricted(base, KEY, "anthropic_haiku")
                .structured(MODEL, "프레임", "패킷", schema(), "high", 60);
        assertThat(sonnet.ok()).isFalse();
        assertThat(sonnet.errorKind()).isEqualTo("NOT_ALLOWED");
        assertThat(sonnet.charged()).isFalse();
        assertThat(sonnet.latencyMs()).isZero();
        assertThat(sonnet.error()).contains("AI_ENGINES").contains(MODEL).doesNotContain(KEY);
        assertThat(restricted(base, KEY, "nvidia_nemotron")
                .structured("claude-haiku-5-5", "프레임", "패킷", schema(), "high", 60).errorKind())
                .as("Anthropic 엔진이 없는 목록").isEqualTo("NOT_ALLOWED");
        assertThat(restricted(base, "", "anthropic_haiku")
                .structured(MODEL, "프레임", "패킷", schema(), "high", 60).errorKind())
                .as("키가 없어도 허용 목록이 먼저(엔진 목록 화면과 같은 순서)").isEqualTo("NOT_ALLOWED");
        assertThat(hits.get()).isZero();

        AiService.StructuredResult haiku = restricted(base, KEY, "nvidia_nemotron, anthropic_haiku")
                .structured("claude-haiku-5-5", "프레임", "패킷", schema(), "high", 60);
        assertThat(haiku.ok()).as("목록 엔진의 모델").isTrue();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("모르는 effort·빈 스키마·빈 메시지·0초 한도는 호출 전에 멈춘다(과금되는 호출을 보내지 않음)")
    void invalidArgumentsFailBeforeCalling() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));
        AiService service = service(base, KEY);
        Map<String, Object> schema = schema();

        assertThatThrownBy(() -> service.structured(MODEL, "s", "u", schema, "extreme", 60))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("effort");
        assertThatThrownBy(() -> service.structured(MODEL, "s", "u", Map.of(), "high", 60))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.structured(MODEL, "s", " ", schema, "high", 60))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.structured("", "s", "u", schema, "high", 60))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.structured(MODEL, "s", "u", schema, "high", 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(hits.get()).isZero();
    }

    // ------------------------------------------------------------------ 스트리밍 구조화 출력(QA-475 — 주간 복기)
    @Test
    @DisplayName("스트리밍 요청 본문은 스트리밍이 아닌 요청과 같고 stream만 더한다 — 64,000토큰 한도, 기본 경로의 위 끝 20,000은 그대로")
    void streamingRequestIsTheSameRequestPlusStream() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));
        AiService service = service(base, KEY);

        service.structured(MODEL, "프레임 — 시스템", "패킷", schema(), "high", 120, AiService.STRUCTURED_MAX_TOKENS_CEILING);
        service.structuredStreaming(MODEL, "프레임 — 시스템", "패킷", schema(), "high", 120,
                AiService.STRUCTURED_MAX_TOKENS_CEILING);
        service.structuredStreaming(MODEL, "프레임 — 시스템", "패킷", schema(), "high", 120, 64_000);

        assertThat(requests.get(0).has("stream")).as("스트리밍이 아닌 경로(결정·제안·브리핑·장중 판단)는 stream을 보내지 않음").isFalse();
        ObjectNode streamed = (ObjectNode) requests.get(1).deepCopy();
        assertThat(streamed.path("stream").asBoolean(false)).isTrue();
        streamed.remove("stream");
        assertThat(streamed).as("stream 말고는 바이트까지 같은 요청(스키마·effort·시스템 캐시 블록·thinking 없음)").isEqualTo(requests.get(0));
        assertThat(requests.get(2).path("max_tokens").asLong()).isEqualTo(64_000L)
                .isEqualTo(AiService.STRUCTURED_STREAMING_MAX_TOKENS_CEILING);
        assertThat(requests.get(2).path("output_config").path("effort").asString()).isEqualTo("high");
        assertThat(AiService.STRUCTURED_MAX_TOKENS_CEILING).as("다른 호출의 위 끝은 그대로").isEqualTo(20_000L);
    }

    @Test
    @DisplayName("스트리밍 정상 응답: 사건을 모은 Message에서 사고 블록 뒤의 텍스트와 토큰(캐시 포함)을 스트리밍이 아닌 경로와 같게 돌려준다")
    void streamingReturnsAccumulatedTextAndUsage() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));

        AiService.StructuredResult result = service(base, KEY)
                .structuredStreaming(MODEL, "프레임 v1", "패킷", schema(), "high", 120, 64_000);

        assertThat(result.ok()).isTrue();
        assertThat(result.text()).isEqualTo(ANSWER);
        assertThat(result.stopReason()).isEqualTo("end_turn");
        assertThat(result.errorKind()).isNull();
        assertThat(result.charged()).isTrue();
        assertThat(result.inputTokens()).isEqualTo(21_000L);
        assertThat(result.outputTokens()).isEqualTo(3_100L);
        assertThat(result.cacheReadTokens()).isEqualTo(7_800L);
        assertThat(result.cacheWriteTokens()).isEqualTo(0L);
        assertThat(hits.get()).isEqualTo(1);
        assertThat(apiKeys).containsExactly(KEY);
    }

    @Test
    @DisplayName("스트리밍의 출력 한도·거절·빈 응답은 스트리밍이 아닌 경로와 같은 종류 — 한도 문구는 64,000, 잘린 텍스트는 원문으로 남김")
    void streamingStopReasonsMatchNonStreaming() throws Exception {
        String base = startServer(200, message(textBlock("{\"schemaVersion\":2,\"stance\":\"RIS"), "max_tokens", "", USAGE));
        AiService.StructuredResult cut = service(base, KEY).structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60,
                64_000);
        assertThat(cut.ok()).isFalse();
        assertThat(cut.errorKind()).isEqualTo("MAX_TOKENS");
        assertThat(cut.charged()).isTrue();
        assertThat(cut.text()).isEqualTo("{\"schemaVersion\":2,\"stance\":\"RIS");
        assertThat(cut.error()).isEqualTo("출력 한도(64000 토큰)에 걸려 응답이 중간에 잘렸습니다");
        assertThat(cut.outputTokens()).isEqualTo(3_100L);
        stop();

        base = startServer(200, message("[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"}]", "max_tokens",
                "", USAGE));
        AiService.StructuredResult thinkingOnly = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);
        assertThat(thinkingOnly.errorKind()).isEqualTo("MAX_TOKENS");
        assertThat(thinkingOnly.text()).isNull();
        assertThat(thinkingOnly.error()).isEqualTo("출력 한도(64000 토큰)에 걸려 답을 쓰기 전에 끝났습니다");
        stop();

        base = startServer(200, message("[]", "refusal",
                ",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"정책상 답할 수 없습니다\"}",
                "{\"input_tokens\":20000,\"output_tokens\":12}"));
        AiService.StructuredResult refused = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);
        assertThat(refused.errorKind()).isEqualTo("REFUSAL");
        assertThat(refused.charged()).isTrue();
        assertThat(refused.error()).contains("거절", "cyber", "정책상 답할 수 없습니다");
        assertThat(refused.inputTokens()).isEqualTo(20_000L);
        assertThat(refused.cacheReadTokens()).as("API가 주지 않은 값은 null").isNull();
        stop();

        base = startServer(200, message("[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"}]", "end_turn",
                "", USAGE));
        AiService.StructuredResult empty = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);
        assertThat(empty.errorKind()).isEqualTo("EMPTY");
        assertThat(empty.charged()).isTrue();
        assertThat(empty.outputTokens()).isEqualTo(3_100L);
        assertThat(hits.get()).as("모두 한 번씩 — SDK 재시도 없음").isEqualTo(4);
    }

    @Test
    @DisplayName("스트림 전의 HTTP 오류(429)는 스트리밍이 아닌 경로와 같게 RATE_LIMIT·과금 안 됨, 다시 보내지 않는다")
    void streamingHttpErrorBeforeTheStream() throws Exception {
        String base = startServer(429,
                "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}");

        AiService.StructuredResult result = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("RATE_LIMIT");
        assertThat(result.charged()).isFalse();
        assertThat(result.text()).isNull();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("스트림 도중의 오류 사건(과부하)은 HTTP·과금됨 — 200을 받은 뒤라 모델에 닿았음, 텍스트는 남기지 않고 받은 사용량(입력·캐시)만 남김")
    void midStreamErrorEventIsChargedHttp() throws Exception {
        List<String> events = ClaudeSse.events(message(textBlock(ANSWER), "end_turn", "", USAGE));
        String base = startStreamServer(events.subList(0, 3), 0,
                List.of(ClaudeSse.error("overloaded_error", "Overloaded")));

        AiService.StructuredResult result = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("HTTP");
        assertThat(result.charged()).isTrue();
        assertThat(result.error()).contains("스트림 도중", "overloaded_error", "과부하").doesNotContain(KEY);
        assertThat(result.text()).isNull();
        // message_start의 사용량은 받았음(과금된 입력이 사용량에서 빠지지 않게), message_delta 전이라 출력은 모름 — 0으로 채우지 않음.
        assertThat(result.inputTokens()).isEqualTo(21_000L);
        assertThat(result.cacheReadTokens()).isEqualTo(7_800L);
        assertThat(result.cacheWriteTokens()).isEqualTo(0L);
        assertThat(result.outputTokens()).isNull();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("끝 사건(message_stop) 없이 스트림이 끝나면 IO·과금됨 — 한국어 사유, 잘린 응답을 성공으로 읽지 않음, 받은 사건의 토큰만 남김")
    void streamWithoutMessageStopIsChargedIo() throws Exception {
        List<String> events = ClaudeSse.events(message(textBlock(ANSWER), "end_turn", "", USAGE));
        String base = startStreamServer(events.subList(0, events.size() - 2), 0, List.of());

        AiService.StructuredResult result = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("IO");
        assertThat(result.charged()).isTrue();
        assertThat(result.error()).contains("message_stop");
        assertThat(result.text()).isNull();
        assertThat(result.inputTokens()).as("message_start의 입력").isEqualTo(21_000L);
        assertThat(result.outputTokens()).as("message_delta 전에 끊김 — 출력은 모름").isNull();
        stop();

        // message_delta(누적 출력 토큰)까지 받고 끝 사건만 빠진 스트림 — 토큰 넷을 모두 알아 추정 비용을 셀 수 있음.
        base = startStreamServer(events.subList(0, events.size() - 1), 0, List.of());
        AiService.StructuredResult afterDelta = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 60, 64_000);
        assertThat(afterDelta.errorKind()).isEqualTo("IO");
        assertThat(afterDelta.text()).isNull();
        assertThat(afterDelta.inputTokens()).isEqualTo(21_000L);
        assertThat(afterDelta.outputTokens()).isEqualTo(3_100L);
        assertThat(afterDelta.cacheReadTokens()).isEqualTo(7_800L);
        assertThat(afterDelta.cacheWriteTokens()).isEqualTo(0L);
    }

    @Test
    @DisplayName("대기 한도는 스트림 전체에 걸린다 — 첫 사건을 받은 뒤 멈춘 스트림도 한도에서 TIMEOUT·과금됨")
    void streamingTimeoutCoversTheWholeStream() throws Exception {
        List<String> events = ClaudeSse.events(message(textBlock(ANSWER), "end_turn", "", USAGE));
        String base = startStreamServer(events.subList(0, 1), 3_000, events.subList(1, events.size()));

        AiService.StructuredResult result = service(base, KEY)
                .structuredStreaming(MODEL, "프레임", "패킷", schema(), "high", 1, 64_000);

        assertThat(result.ok()).isFalse();
        assertThat(result.errorKind()).isEqualTo("TIMEOUT");
        assertThat(result.charged()).isTrue();
        assertThat(result.error()).contains("1초", "스트림").doesNotContain("자동 탐색");
        assertThat(result.latencyMs()).isLessThan(3_000L);
        assertThat(result.inputTokens()).as("첫 사건(message_start)의 입력은 남김").isEqualTo(21_000L);
        assertThat(result.outputTokens()).isNull();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("한도 범위: 스트리밍은 16,000~64,000, 스트리밍이 아닌 경로는 16,000~20,000 그대로 — 밖이면 호출 전에 멈춤, 키 없음·허용 목록 밖은 나가지 않음")
    void streamingLimitsAndGuards() throws Exception {
        String base = startServer(200, message(textBlock(ANSWER), "end_turn", "", USAGE));
        AiService service = service(base, KEY);
        Map<String, Object> schema = schema();

        assertThatThrownBy(() -> service.structuredStreaming(MODEL, "s", "u", schema, "high", 60, 64_001))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("64000");
        assertThatThrownBy(() -> service.structuredStreaming(MODEL, "s", "u", schema, "high", 60, 15_999))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.structured(MODEL, "s", "u", schema, "high", 60, 64_000))
                .as("스트리밍이 아닌 요청은 큰 한도를 받지 않음").isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("20000");
        assertThatThrownBy(() -> service.structuredStreaming(MODEL, "s", "u", schema, "extreme", 60, 64_000))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("effort");
        assertThat(service(base, "").structuredStreaming(MODEL, "s", "u", schema, "high", 60, 64_000).errorKind())
                .isEqualTo("NO_KEY");
        assertThat(restricted(base, KEY, "anthropic_haiku").structuredStreaming(MODEL, "s", "u", schema, "high", 60, 64_000)
                .errorKind()).isEqualTo("NOT_ALLOWED");
        assertThat(hits.get()).isZero();
    }
}
