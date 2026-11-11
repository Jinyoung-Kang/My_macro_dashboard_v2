package com.macrodash.feature.info;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

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
}
