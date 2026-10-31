package com.macrodash.feature.ai;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 엔진 허용 목록(AI_ENGINES, ADR 0014) — 배포마다 쓸 엔진을 좁힙니다. 비면 지금과 같습니다(모든 엔진).
 *
 * <p>Claude·NVIDIA·Cerebras 자리에는 가짜 서버를 둡니다(유료·외부 호출 없음). Cloudflare는 주소를 바꿀 수 없어 키를
 * 넣는 테스트에서는 부르지 않는 자리(허용 목록 밖, 또는 폴오버 순서상 앞에서 끝남)에만 둡니다.
 */
class AiServiceAllowListTest {

    private HttpServer server;
    private final AtomicInteger anthropicHits = new AtomicInteger();
    private final AtomicInteger cerebrasHits = new AtomicInteger();
    private final AtomicInteger nvidiaHits = new AtomicInteger();

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    /** 세 제공자를 흉내 내는 가짜 서버. Claude는 anthropicStatus로, OpenAI 형식(NVIDIA·Cerebras)은 늘 200으로 답합니다. */
    private String startServer(int anthropicStatus) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            anthropicHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            String body = anthropicStatus == 200
                    ? """
                    {"id":"msg_test","type":"message","role":"assistant","model":"claude-haiku-5-5",
                     "content":[{"type":"text","text":"클로드가 쓴 한국어 리포트입니다. 지표를 정리했습니다."}],
                     "stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":20}}
                    """
                    : "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}";
            respond(exchange, anthropicStatus, body);
        });
        server.createContext("/cerebras", exchange -> {
            cerebrasHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 200, openAiReply("세레브라스가 쓴 한국어 리포트입니다. 지표를 정리했습니다."));
        });
        server.createContext("/nvidia", exchange -> {
            nvidiaHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 200, openAiReply("엔비디아가 쓴 한국어 리포트입니다. 지표를 정리했습니다."));
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static void respond(com.sun.net.httpserver.HttpExchange exchange, int status, String body)
            throws java.io.IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    private static String openAiReply(String text) {
        return "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"" + text + "\"}}]}";
    }

    /** 허용 목록 + 키(제공자별, 빈 문자열이면 없음). base가 있으면 Claude·NVIDIA·Cerebras를 가짜 서버로 보냅니다. */
    private static AiService service(String allowList, String base, String anthropic, String nvidia, String cerebras,
                                     String cloudflare) {
        AiService service = new AiService(240, 60, 180, allowList);
        ReflectionTestUtils.setField(service, "anthropicKey", anthropic);
        ReflectionTestUtils.setField(service, "nvidiaKey", nvidia);
        ReflectionTestUtils.setField(service, "cerebrasKey", cerebras);
        ReflectionTestUtils.setField(service, "cloudflareAccountId", cloudflare);
        ReflectionTestUtils.setField(service, "cloudflareToken", cloudflare);
        if (base != null) {
            service.anthropicBaseUrl = base;
            service.nvidiaUrl = base + "/nvidia";
            service.cerebrasUrl = base + "/cerebras";
        }
        return service;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Map<String, Object>> enginesById(AiService service) {
        Map<String, Map<String, Object>> byId = new java.util.LinkedHashMap<>();
        for (Map<String, Object> engine : (List<Map<String, Object>>) service.engines().get("engines")) {
            byId.put((String) engine.get("id"), engine);
        }
        return byId;
    }

    @Test
    @DisplayName("허용 목록이 비면 지금과 같다 — 키가 있는 엔진·자동 탐색은 사용 가능, 키 없는 엔진은 no_key")
    void emptyAllowListKeepsCurrentBehaviour() {
        AiService service = service("", null, "test-key", "", "", "");

        Map<String, Map<String, Object>> engines = enginesById(service);
        assertThat(engines.get("anthropic_haiku")).containsEntry("available", true).containsEntry("unavailableReason", null);
        assertThat(engines.get("auto")).as("키가 하나라도 있으면 자동 탐색").containsEntry("available", true);
        assertThat(engines.get("cerebras_llama")).containsEntry("available", false).containsEntry("unavailableReason", "no_key");
        assertThat(service.engines().get("enabled")).isEqualTo(true);

        AiService none = service(" ", null, "", "", "", "");
        assertThat(enginesById(none).get("auto")).containsEntry("unavailableReason", "no_key");
        assertThat(none.engines().get("enabled")).isEqualTo(false);
        assertThat(AiService.allowList(" , ")).as("쉼표·공백뿐이면 비운 것과 같음").isNull();
    }

    @Test
    @DisplayName("AI_ENGINES=anthropic_haiku — 다른 엔진은 키가 있어도 not_allowed, 자동 탐색도 not_allowed, 메뉴는 켜짐")
    void haikuOnly() {
        AiService service = service("anthropic_haiku", null, "test-key", "nv-key", "cb-key", "cf-key");

        Map<String, Map<String, Object>> engines = enginesById(service);
        assertThat(engines.get("anthropic_haiku")).containsEntry("available", true).containsEntry("unavailableReason", null);
        assertThat(engines.get("auto")).containsEntry("available", false).containsEntry("unavailableReason", "not_allowed");
        for (String id : List.of("nvidia_nemotron", "cerebras_llama", "cloudflare_llama")) {
            assertThat(engines.get(id)).as(id).containsEntry("available", false).containsEntry("unavailableReason", "not_allowed");
        }
        Map<String, Object> out = service.engines();
        assertThat(out.get("enabled")).isEqualTo(true);
        assertThat(out.get("keys")).as("keys는 허용 목록과 상관없이 키가 있는지").isEqualTo(
                Map.of("anthropic", true, "nvidia", true, "cerebras", true, "cloudflare", true));
    }

    @Test
    @DisplayName("허용한 엔진의 키가 없으면 그 엔진은 no_key, 목록 밖은 not_allowed(키가 없어도), 메뉴는 꺼짐 — 부르면 네트워크 없이 실패")
    void allowedEngineWithoutKey() throws Exception {
        String base = startServer(200);
        AiService service = service("anthropic_haiku", base, "", "", "", "");

        Map<String, Map<String, Object>> engines = enginesById(service);
        assertThat(engines.get("anthropic_haiku")).containsEntry("unavailableReason", "no_key");
        assertThat(engines.get("nvidia_nemotron")).as("목록 밖이 먼저").containsEntry("unavailableReason", "not_allowed");
        assertThat(service.engines().get("enabled")).isEqualTo(false);

        Map<String, Object> result = service.generate("anthropic_haiku", "질문", null);
        assertThat(result.get("status")).isEqualTo(false);
        assertThat(String.valueOf(result.get("error"))).contains("이 배포에서 쓰는 AI 엔진(anthropic_haiku)의 키");
        assertThat(anthropicHits.get()).isZero();
    }

    @Test
    @DisplayName("자동 탐색은 키가 있는 허용 엔진이 둘 이상일 때만 — 둘이면 사용 가능, 하나만 키가 있으면 no_key")
    void autoNeedsTwoUsableAllowedEngines() {
        AiService two = service("anthropic_haiku,cerebras_llama", null, "test-key", "", "cb-key", "");
        assertThat(enginesById(two).get("auto")).containsEntry("available", true).containsEntry("unavailableReason", null);

        AiService oneKey = service("anthropic_haiku, cerebras_llama", null, "test-key", "nv-key", "", "cf-key");
        assertThat(enginesById(oneKey).get("auto")).containsEntry("available", false).containsEntry("unavailableReason", "no_key");
        assertThat(oneKey.engines().get("enabled")).isEqualTo(true);
    }

    @Test
    @DisplayName("모르는 엔진 ID·auto가 있으면 기동을 멈춘다 — 쓸 수 있는 값을 알려 주고, ID 모양이 아닌 값(키 등)은 적지 않는다")
    void unknownIdFailsFast() {
        assertThatThrownBy(() -> new AiService(240, 60, 180, "anthropic_haiku,claude_opus"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("AI_ENGINES")
                .hasMessageContaining("claude_opus")
                .hasMessageContaining("anthropic_haiku, nvidia_nemotron");
        assertThatThrownBy(() -> new AiService(240, 60, 180, "auto"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("auto는 넣지 않습니다");

        String keyLike = "sk-ant-api03-" + "x".repeat(60);
        assertThatThrownBy(() -> new AiService(240, 60, 180, keyLike))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("엔진 ID 모양이 아닌 값 1개")
                .satisfies(error -> assertThat(error.getMessage()).doesNotContain("sk-ant"));
    }

    @Test
    @DisplayName("허용 목록 밖 엔진을 고르면 키가 있어도 네트워크에 나가지 않고 실패한다(키 없음과 같은 모양)")
    void disallowedEngineIsRejectedWithoutNetwork() throws Exception {
        String base = startServer(200);
        AiService service = service("cerebras_llama", base, "test-key", "", "cb-key", "");

        Map<String, Object> result = service.generate("anthropic_haiku", "질문", null);

        assertThat(result.get("status")).isEqualTo(false);
        assertThat(String.valueOf(result.get("error"))).contains("이 배포에서는 쓸 수 없는 엔진입니다");
        assertThat(result).containsKeys("provider", "response", "error", "latencyMs", "pipelineStep");
        assertThat(anthropicHits.get()).as("Claude를 부르지 않음").isZero();
        assertThat(cerebrasHits.get()).isZero();
    }

    @Test
    @DisplayName("자동 탐색을 쓸 수 없는 배포에서 auto(또는 엔진 미지정)는 네트워크 없이 실패하고, 허용된 엔진은 그대로 부른다")
    void autoRejectedWhenUnavailableButAllowedEngineWorks() throws Exception {
        String base = startServer(200);
        AiService service = service("anthropic_haiku", base, "test-key", "", "", "");

        for (String engineId : new String[]{"auto", null, " "}) {
            Map<String, Object> rejected = service.generate(engineId, "질문", null);
            assertThat(rejected.get("status")).as(String.valueOf(engineId)).isEqualTo(false);
            assertThat(String.valueOf(rejected.get("error"))).contains("이 배포에서는 쓸 수 없는 엔진입니다", "직접 고르세요");
        }
        assertThat(anthropicHits.get()).isZero();

        Map<String, Object> ok = service.generate("anthropic_haiku", "질문", null);
        assertThat(ok.get("status")).isEqualTo(true);
        assertThat(anthropicHits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("자동 탐색은 허용된 엔진만 순서대로 — 목록 밖 엔진(키가 있어도)은 부르지도, 경로에 적지도 않는다")
    void failoverConsidersOnlyAllowedEngines() throws Exception {
        String base = startServer(200);
        // 폴오버 순서: anthropic_haiku → cerebras_llama → … → nvidia_llama_33_70b. Claude는 키가 있지만 목록 밖입니다.
        AiService service = service("cerebras_llama,nvidia_llama_33_70b", base, "test-key", "nv-key", "cb-key", "");

        Map<String, Object> result = service.generate("auto", "질문", null);

        assertThat(result.get("status")).isEqualTo(true);
        assertThat(anthropicHits.get()).as("목록 밖의 Claude는 맨 앞이어도 건너뜀").isZero();
        assertThat(cerebrasHits.get()).isEqualTo(1);
        @SuppressWarnings("unchecked")
        List<String> path = (List<String>) result.get("failoverPath");
        assertThat(path).hasSize(1);
        assertThat(path.get(0)).startsWith("cerebras_llama").endsWith("성공");
    }

    @Test
    @DisplayName("앞 엔진이 실패하면 다음 허용 엔진으로 — 경로에는 허용 엔진만 남는다")
    void failoverMovesToNextAllowedEngine() throws Exception {
        String base = startServer(429);
        AiService service = service("anthropic_haiku,nvidia_llama_33_70b", base, "test-key", "nv-key", "cb-key", "");

        Map<String, Object> result = service.generate("auto", "질문", null);

        assertThat(result.get("status")).isEqualTo(true);
        assertThat(anthropicHits.get()).isEqualTo(1);
        assertThat(cerebrasHits.get()).as("Cerebras는 키가 있지만 목록 밖").isZero();
        assertThat(nvidiaHits.get()).isEqualTo(1);
        @SuppressWarnings("unchecked")
        List<String> path = (List<String>) result.get("failoverPath");
        assertThat(path).hasSize(2);
        assertThat(path.get(0)).startsWith("anthropic_haiku").contains("429");
        assertThat(path.get(1)).startsWith("nvidia_llama_33_70b").endsWith("성공");
    }

    @Test
    @DisplayName("번역기 제공자가 허용 목록에 없으면 번역하지 않고 원문을 둔다(Cerebras만 허용 → Cloudflare 번역기를 부르지 않음)")
    void translationSkippedWhenTranslatorProviderNotAllowed() throws Exception {
        startServer(200);
        server.removeContext("/cerebras");
        server.createContext("/cerebras", exchange -> {
            cerebrasHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            respond(exchange, 200, openAiReply("This is an English report about the macro indicators."));
        });
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        AiService service = service("cerebras_llama", base, "", "", "cb-key", "cf-key");

        Map<String, Object> result = service.generate("cerebras_llama", "질문", null);

        assertThat(result.get("status")).isEqualTo(true);
        assertThat(result.get("response")).isEqualTo("This is an English report about the macro indicators.");
        assertThat(String.valueOf(result.get("translationInfo"))).contains("번역 건너뜀", "cloudflare");
        assertThat(result).doesNotContainKey("translationError");
    }

    @Test
    @DisplayName("허용됐지만 키가 없는 엔진을 직접 고르면 네트워크 없이 제공자별 '키 누락' 문구로 실패한다(charged: false)")
    void allowedEngineWithoutKeyFailsWithProviderMessage() throws Exception {
        String base = startServer(200);
        // 키가 있는 엔진(NVIDIA)이 하나는 있어야 메뉴가 켜지고 엔진별 판정까지 갑니다.
        AiService service = service("", base, "", "nv-key", "", "");
        Map<String, String> expected = new java.util.LinkedHashMap<>();
        expected.put("anthropic_haiku", "Anthropic — Claude Haiku 5.5 API Key 누락 — .env에 ANTHROPIC_API_KEY를 넣고 make up 하세요.");
        expected.put("cerebras_llama", "Cerebras — Llama 3.3 70B API Key 누락");
        expected.put("cloudflare_llama", "Cloudflare 인증 정보 누락");

        for (Map.Entry<String, String> engine : expected.entrySet()) {
            Map<String, Object> result = service.generate(engine.getKey(), "질문", null);
            assertThat(result).as(engine.getKey())
                    .containsEntry("status", false).containsEntry("charged", false)
                    .containsEntry("error", engine.getValue()).containsEntry("latencyMs", 0L)
                    .doesNotContainKey("failoverPath");
            // 리포트가 한도·원본 텍스트 전에 보는 사전 판정도 같은 실패를 줍니다(QA-133).
            assertThat(service.unusable(engine.getKey())).as(engine.getKey()).contains(result);
        }
        assertThat(service.unusable("nvidia_llama_33_70b")).as("키가 있는 엔진은 쓸 수 있음").isEmpty();
        assertThat(service.unusable("auto")).as("키가 하나라도 있으면 자동 탐색").isEmpty();
        assertThat(anthropicHits.get() + cerebrasHits.get() + nvidiaHits.get()).isZero();
    }
}
