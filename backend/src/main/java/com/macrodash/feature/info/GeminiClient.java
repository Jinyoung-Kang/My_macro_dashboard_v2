package com.macrodash.feature.info;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Gemini API(Google AI Studio 키)로 구조화 출력 한 번 — 정보 수집 글의 번역 전용(ADR 0037 개정).
 *
 * <ul>
 *   <li>REST {@code POST /v1beta/models/{model}:generateContent}. 키는 주소가 아니라 {@code x-goog-api-key} 머리글로 보냅니다(로그에 남지 않게).</li>
 *   <li>응답 모양은 {@code generationConfig.responseJsonSchema}로 강제하고, 사고는 낮게({@code thinkingConfig.thinkingLevel: low}) 둡니다.
 *       이 요청 모양은 2026-11-12에 실제 API의 형식 검증을 지나는 것을 확인했습니다(응답 본문은 그때 크레딧 소진(402)으로 받지 못함).</li>
 *   <li>재시도하지 않습니다. 실패는 종류와 사람이 읽는 사유로 돌려주고, 키·요청 주소는 사유에 넣지 않습니다.</li>
 * </ul>
 */
@Component
public class GeminiClient {

    /** 호출 결과 — {@code errorKind}: NO_KEY·BILLING·RATE_LIMIT·UNAUTHORIZED·NOT_FOUND·BAD_REQUEST(400)·OVERLOADED(503)·HTTP·IO·REFUSAL·MAX_TOKENS·EMPTY. 성공이면 null. */
    public record Reply(boolean ok, String text, String errorKind, String error) {
        static Reply failed(String kind, String error) {
            return new Reply(false, null, kind, error);
        }
    }

    private static final Logger log = LoggerFactory.getLogger(GeminiClient.class);
    private static final String DEFAULT_BASE = "https://generativelanguage.googleapis.com";

    private final String apiKey;
    private final String baseUrl;
    private final ObjectMapper mapper;

    @Autowired
    public GeminiClient(@Value("${dashboard.ai.gemini-api-key:}") String apiKey, ObjectMapper mapper) {
        this(apiKey, DEFAULT_BASE, mapper);
    }

    /** 시험이 가짜 서버 주소를 넣는 자리. */
    GeminiClient(String apiKey, String baseUrl, ObjectMapper mapper) {
        this.apiKey = apiKey == null ? "" : apiKey.strip();
        this.baseUrl = baseUrl;
        this.mapper = mapper;
    }

    public boolean configured() {
        return !apiKey.isEmpty();
    }

    /**
     * @param schema 응답의 JSON 스키마(표준 JSON Schema — additionalProperties 가능)
     */
    public Reply structured(String model, String system, String user, Map<String, Object> schema, int timeoutSeconds) {
        if (!configured()) {
            return Reply.failed("NO_KEY", "Gemini API 키 누락 — .env에 GEMINI_API_KEY를 넣고 다시 띄우세요.");
        }
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("responseMimeType", "application/json");
        config.put("responseJsonSchema", schema);
        config.put("thinkingConfig", Map.of("thinkingLevel", "low"));
        Map<String, Object> body = new LinkedHashMap<>();
        if (system != null && !system.isBlank()) {
            body.put("systemInstruction", Map.of("parts", List.of(Map.of("text", system))));
        }
        body.put("contents", List.of(Map.of("role", "user", "parts", List.of(Map.of("text", user)))));
        body.put("generationConfig", config);

        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofSeconds(timeoutSeconds));
        try {
            String raw = RestClient.builder().requestFactory(factory).baseUrl(baseUrl).build().post()
                    .uri("/v1beta/models/{model}:generateContent", model)
                    .header("x-goog-api-key", apiKey)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(mapper.writeValueAsString(body))
                    .retrieve()
                    .body(String.class);
            return read(raw);
        } catch (RestClientResponseException e) {
            int status = e.getStatusCode().value();
            log.warn("Gemini 호출 실패({}): HTTP {}", model, status);
            return switch (status) {
                case 402 -> Reply.failed("BILLING", "Gemini API 선불 크레딧이 없습니다(402) — AI Studio 결제 화면에서 충전하세요.");
                case 429 -> Reply.failed("RATE_LIMIT", "Gemini API 호출 한도에 걸렸습니다(429).");
                case 401, 403 -> Reply.failed("UNAUTHORIZED", "Gemini API 키를 쓸 수 없습니다(" + status + ") — 키와 프로젝트 설정을 확인하세요.");
                case 404 -> Reply.failed("NOT_FOUND", "Gemini 모델을 찾지 못했습니다(404): " + model);
                // 요청 자체를 받지 않음(모델이 이 설정·스키마를 지원하지 않는 등) — 같은 요청을 바로 다시 보내도 같아 부르는 쪽이 쉬게 합니다(QA-405).
                case 400 -> Reply.failed("BAD_REQUEST", "Gemini API가 요청을 받지 않았습니다(400): " + model);
                case 503 -> Reply.failed("OVERLOADED", "Gemini 모델이 지금 붐빕니다(503): " + model);
                default -> Reply.failed("HTTP", "Gemini API 오류(HTTP " + status + ")");
            };
        } catch (ResourceAccessException e) {
            log.warn("Gemini 호출 실패({}): {}", model, e.getClass().getSimpleName());
            return Reply.failed("IO", "Gemini API에 닿지 못했거나 " + timeoutSeconds + "초 안에 응답하지 않았습니다.");
        }
    }

    /** 응답 본문 → 텍스트(사고 부분은 뺌). 거절·잘림·빈 응답은 실패로 돌려줍니다. */
    Reply read(String raw) {
        JsonNode root;
        try {
            root = mapper.readTree(raw == null ? "" : raw);
        } catch (RuntimeException e) {
            return Reply.failed("EMPTY", "Gemini 응답을 읽지 못했습니다.");
        }
        JsonNode candidate = root.path("candidates").path(0);
        if (candidate.isMissingNode()) {
            String blocked = root.path("promptFeedback").path("blockReason").asText("");
            return blocked.isEmpty() ? Reply.failed("EMPTY", "Gemini 응답에 내용이 없습니다.")
                    : Reply.failed("REFUSAL", "Gemini가 이 요청을 막았습니다(" + blocked + ").");
        }
        StringBuilder text = new StringBuilder();
        for (JsonNode part : candidate.path("content").path("parts")) {
            if (!part.path("thought").asBoolean(false)) {
                text.append(part.path("text").asText(""));
            }
        }
        String finish = candidate.path("finishReason").asText("");
        if ("MAX_TOKENS".equals(finish)) {
            return Reply.failed("MAX_TOKENS", "Gemini 응답이 출력 한도에서 잘렸습니다.");
        }
        // 종료 사유가 비었거나 정상 종료(STOP)일 때만 성공입니다(QA-405). 안전·인용 등으로 중간에 끊긴 응답은 글이 일부 있어도 끝나지 않은
        // 글이라 쓰지 않습니다 — 성공으로 돌려주면 다음 순위 엔진으로 넘어가지 못하고 그 글은 누를 때마다 같은 길로 실패합니다.
        if (!finish.isEmpty() && !"STOP".equals(finish)) {
            return Reply.failed("REFUSAL", text.isEmpty() ? "Gemini가 답을 내지 않았습니다(" + finish + ")."
                    : "Gemini가 답을 끝내지 못했습니다(" + finish + ").");
        }
        if (text.isEmpty()) {
            return Reply.failed("EMPTY", "Gemini 응답에 글이 없습니다.");
        }
        return new Reply(true, text.toString(), null, null);
    }
}
