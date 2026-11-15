package com.macrodash;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.List;

/**
 * 가짜 Claude 서버의 스트리밍 응답(QA-475) — 스트리밍이 아닌 응답 본문(Message JSON)을 같은 결과가 되는 SSE 사건 열로 바꿉니다.
 * 공식 SDK의 {@code MessageAccumulator}가 이 열을 모아 만든 Message는 원래 본문과 같은 블록·멈춘 까닭·거절 사유·토큰을 가집니다.
 *
 * <p>모양(Messages API 스트리밍): {@code message_start}(내용은 비고 멈춘 까닭은 null, usage는 본문 그대로) → 블록마다
 * {@code content_block_start}·{@code content_block_delta}·{@code content_block_stop} → {@code message_delta}(멈춘 까닭·거절 사유,
 * 출력 토큰) → {@code message_stop}. 시험이 스트림 도중의 실패를 만들 때는 {@link #events}로 사건을 하나씩 받아 그 사이에서 끊습니다.
 */
public final class ClaudeSse {

    private ClaudeSse() {
    }

    /** 스트리밍 응답의 Content-Type. */
    public static final String CONTENT_TYPE = "text/event-stream";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 받은 요청 본문이 스트리밍을 청했는가({@code "stream": true}). */
    public static boolean requested(JsonNode request) {
        return request != null && request.path("stream").asBoolean(false);
    }

    /** {@code messageJson}과 같은 결과가 되는 SSE 본문 전체. */
    public static String fromMessage(String messageJson) {
        return String.join("", events(messageJson));
    }

    /** {@code messageJson}과 같은 결과가 되는 SSE 사건들 — 사건마다 {@code event:}·{@code data:} 줄과 빈 줄 하나. */
    public static List<String> events(String messageJson) {
        JsonNode message = MAPPER.readTree(messageJson);
        List<String> out = new ArrayList<>();

        ObjectNode start = (ObjectNode) message.deepCopy();
        start.set("content", MAPPER.createArrayNode());
        start.putNull("stop_reason");
        start.putNull("stop_sequence");
        start.remove("stop_details");
        ObjectNode messageStart = MAPPER.createObjectNode();
        messageStart.put("type", "message_start");
        messageStart.set("message", start);
        out.add(event("message_start", messageStart));

        JsonNode content = message.path("content");
        for (int i = 0; content.isArray() && i < content.size(); i++) {
            JsonNode block = content.get(i);
            String type = block.path("type").asString();
            ObjectNode empty;
            if ("text".equals(type)) {
                empty = MAPPER.createObjectNode().put("type", "text").put("text", "");
            } else if ("thinking".equals(type)) {
                empty = MAPPER.createObjectNode().put("type", "thinking").put("thinking", "").put("signature", "");
            } else {
                empty = (ObjectNode) block.deepCopy();
            }
            out.add(event("content_block_start", MAPPER.createObjectNode()
                    .put("type", "content_block_start").put("index", i).set("content_block", empty)));
            if ("text".equals(type)) {
                out.add(delta(i, MAPPER.createObjectNode().put("type", "text_delta")
                        .put("text", block.path("text").asString())));
            } else if ("thinking".equals(type)) {
                String thinking = block.path("thinking").asString();
                if (!thinking.isEmpty()) {
                    out.add(delta(i, MAPPER.createObjectNode().put("type", "thinking_delta").put("thinking", thinking)));
                }
                out.add(delta(i, MAPPER.createObjectNode().put("type", "signature_delta")
                        .put("signature", block.path("signature").asString())));
            }
            out.add(event("content_block_stop", MAPPER.createObjectNode()
                    .put("type", "content_block_stop").put("index", i)));
        }

        ObjectNode deltaBody = MAPPER.createObjectNode();
        copyOrNull(message, deltaBody, "stop_reason");
        copyOrNull(message, deltaBody, "stop_sequence");
        if (message.has("stop_details")) {
            deltaBody.set("stop_details", message.get("stop_details"));
        }
        ObjectNode messageDelta = MAPPER.createObjectNode();
        messageDelta.put("type", "message_delta");
        messageDelta.set("delta", deltaBody);
        ObjectNode usage = MAPPER.createObjectNode();
        usage.put("output_tokens", message.path("usage").path("output_tokens").asLong(0));
        messageDelta.set("usage", usage);
        out.add(event("message_delta", messageDelta));
        out.add(event("message_stop", MAPPER.createObjectNode().put("type", "message_stop")));
        return out;
    }

    /** 스트림 도중의 오류 사건({@code event: error}) — 예: {@code overloaded_error}. */
    public static String error(String type, String message) {
        ObjectNode error = MAPPER.createObjectNode().put("type", type).put("message", message);
        ObjectNode body = MAPPER.createObjectNode();
        body.put("type", "error");
        body.set("error", error);
        return event("error", body);
    }

    private static String delta(int index, ObjectNode delta) {
        return event("content_block_delta", MAPPER.createObjectNode()
                .put("type", "content_block_delta").put("index", index).set("delta", delta));
    }

    private static void copyOrNull(JsonNode from, ObjectNode to, String field) {
        JsonNode value = from.get(field);
        if (value == null || value.isNull()) {
            to.putNull(field);
        } else {
            to.set(field, value);
        }
    }

    private static String event(String name, JsonNode data) {
        return "event: " + name + "\ndata: " + MAPPER.writeValueAsString(data) + "\n\n";
    }
}
