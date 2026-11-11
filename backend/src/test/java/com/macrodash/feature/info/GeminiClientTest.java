package com.macrodash.feature.info;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Gemini 호출부(ADR 0037 개정) — 키가 없으면 나가지 않고, 응답에서 사고 부분을 뺀 글만 꺼내며, 막힘·잘림·빈 응답은 실패다. 네트워크를 쓰지 않습니다. */
class GeminiClientTest {

    private final GeminiClient client = new GeminiClient("test-key", "http://127.0.0.1:1", new ObjectMapper());

    @Test
    @DisplayName("키가 없으면 보내지 않고 NO_KEY")
    void noKey() {
        GeminiClient none = new GeminiClient(" ", "http://127.0.0.1:1", new ObjectMapper());

        assertThat(none.configured()).isFalse();
        assertThat(none.structured("m", "s", "u", Map.of("type", "object"), 1).errorKind()).isEqualTo("NO_KEY");
    }

    @Test
    @DisplayName("닿지 못하면 IO — 사유에 키와 주소가 없다")
    void unreachable() {
        GeminiClient.Reply reply = client.structured("m", "s", "u", Map.of("type", "object"), 1);

        assertThat(reply.ok()).isFalse();
        assertThat(reply.errorKind()).isEqualTo("IO");
        assertThat(reply.error()).doesNotContain("test-key").doesNotContain("127.0.0.1");
    }

    @Test
    @DisplayName("응답 읽기 — 사고 부분은 빼고 글만 잇는다")
    void readsText() {
        GeminiClient.Reply reply = client.read("""
                {"candidates":[{"content":{"parts":[{"text":"생각","thought":true},{"text":"{\\"ko\\":"},{"text":"\\"번역\\"}"}]},"finishReason":"STOP"}]}
                """);

        assertThat(reply.ok()).isTrue();
        assertThat(reply.text()).isEqualTo("{\"ko\":\"번역\"}");
    }

    @Test
    @DisplayName("막힘·잘림·빈 응답은 실패")
    void failures() {
        assertThat(client.read("{\"promptFeedback\":{\"blockReason\":\"SAFETY\"}}").errorKind()).isEqualTo("REFUSAL");
        assertThat(client.read("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{\"}]},\"finishReason\":\"MAX_TOKENS\"}]}").errorKind())
                .isEqualTo("MAX_TOKENS");
        assertThat(client.read("{\"candidates\":[{\"finishReason\":\"SAFETY\"}]}").errorKind()).isEqualTo("REFUSAL");
        assertThat(client.read("{}").errorKind()).isEqualTo("EMPTY");
        assertThat(client.read("not json").errorKind()).isEqualTo("EMPTY");
    }

    // ------------------------------------------------------------------ QA-405
    @Test
    @DisplayName("QA-405: 글이 일부 있어도 종료 사유가 정상 종료가 아니면 실패다")
    void partialTextWithAbnormalFinishIsFailure() {
        for (String finish : new String[]{"SAFETY", "RECITATION", "OTHER", "PROHIBITED_CONTENT"}) {
            GeminiClient.Reply reply = client.read(
                    "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{\\\"ko\\\":\\\"번역의 앞부\"}]},\"finishReason\":\"" + finish + "\"}]}");

            assertThat(reply.ok()).as(finish).isFalse();
            assertThat(reply.errorKind()).as(finish).isEqualTo("REFUSAL");
            assertThat(reply.text()).as("끝나지 않은 글은 돌려주지 않습니다").isNull();
        }
    }

    @Test
    @DisplayName("종료 사유가 비었거나 정상 종료면 성공이다(지금 동작)")
    void normalFinishIsSuccess() {
        assertThat(client.read("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{}\"}]},\"finishReason\":\"STOP\"}]}").ok()).isTrue();
        assertThat(client.read("{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"{}\"}]}}]}").ok()).isTrue();
    }

    /** 루프백의 임시 서버 — 정해 둔 상태 코드로만 답합니다(외부로 나가지 않음). */
    private static GeminiClient.Reply callAgainst(int status) throws Exception {
        com.sun.net.httpserver.HttpServer server = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] body = "{\"error\":{\"code\":%d,\"message\":\"synthetic\"}}".formatted(status).getBytes(StandardCharsets.UTF_8);
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            GeminiClient local = new GeminiClient("test-key", "http://127.0.0.1:" + server.getAddress().getPort(), new ObjectMapper());
            return local.structured("m", "s", "u", Map.of("type", "object"), 5);
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("QA-405: 요청 거절(HTTP 400)은 BAD_REQUEST로 따로 가른다")
    void badRequestHasItsOwnKind() throws Exception {
        GeminiClient.Reply reply = callAgainst(400);

        assertThat(reply.ok()).isFalse();
        assertThat(reply.errorKind()).isEqualTo("BAD_REQUEST");
        assertThat(reply.error()).contains("400").doesNotContain("test-key").doesNotContain("synthetic");
    }

    @Test
    @DisplayName("그 밖의 상태 코드 분류는 그대로다 — 429 한도, 503 붐빔, 500 일반 오류")
    void otherStatusKinds() throws Exception {
        assertThat(callAgainst(429).errorKind()).isEqualTo("RATE_LIMIT");
        assertThat(callAgainst(503).errorKind()).isEqualTo("OVERLOADED");
        assertThat(callAgainst(500).errorKind()).isEqualTo("HTTP");
    }
}
