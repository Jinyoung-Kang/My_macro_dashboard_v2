package com.macrodash.feature.paper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.time.Duration;

/**
 * 모의 매매 알림의 텔레그램 보내기(사용자 요청 2026-11-02) — Bot API {@code sendMessage} 한 번에 글 한 통(길면 여러 통). 봇 토큰·대화방은 서버 {@code .env}의
 * {@code TELEGRAM_BOT_TOKEN}·{@code TELEGRAM_CHAT_ID}(잠금화면 알림과 같은 값 — ADR 0019 결정 16)이고 둘 다 있어야 켜집니다. 로컬·QA에는 값이 없어 보내지
 * 않습니다.
 *
 * <ul>
 *   <li>글은 그대로 보냅니다(서식 해석 없음 — 종목 이름·사유의 기호를 고칠 필요가 없게), 링크 미리보기는 끔, {@value #MAX_CHARS}자를 넘으면 줄 경계에서 나눠 여러 통으로
 *       차례로 보냅니다(자르지 않음 — QA-168).</li>
 *   <li>실패 사유에 봇 토큰이 섞이지 않게 합니다(주소에 토큰이 들어가므로 예외 글에서 지움). 재시도는 부르는 쪽(알림 작업 — 다음 주기)이 합니다.</li>
 * </ul>
 */
@Component
public class PaperTelegram {

    static final String API = "https://api.telegram.org";
    static final Duration TIMEOUT = Duration.ofSeconds(10);
    /** 한 통의 글자 상한 — Bot API 4096자보다 조금 작게. */
    static final int MAX_CHARS = 4000;

    /** 보내는 길 — 시험이 가짜로 바꿔 끼웁니다. */
    @FunctionalInterface
    interface Sender {
        /** 응답 상태와 본문. 연결 실패는 예외. */
        Reply post(URI uri, String json) throws Exception;
    }

    record Reply(int status, String body) {
    }

    private final String token;
    private final String chatId;
    private final ObjectMapper mapper;
    private final Sender sender;

    @Autowired
    PaperTelegram(@Value("${dashboard.paper.telegram-bot-token:}") String token,
                  @Value("${dashboard.paper.telegram-chat-id:}") String chatId, ObjectMapper mapper) {
        this(token, chatId, mapper, httpSender());
    }

    /** 시험용 — 보내는 길을 바꿔 끼웁니다. */
    PaperTelegram(String token, String chatId, ObjectMapper mapper, Sender sender) {
        this.token = token == null ? "" : token.strip();
        this.chatId = chatId == null ? "" : chatId.strip();
        this.mapper = mapper;
        this.sender = sender;
    }

    /** 봇 토큰과 대화방이 둘 다 있나. */
    boolean configured() {
        return !token.isEmpty() && !chatId.isEmpty();
    }

    /**
     * 글 하나를 보냅니다 — {@value #MAX_CHARS}자를 넘으면 {@link #parts}로 나눠 차례로.
     *
     * @return 모두 보냈으면 null, 실패면 사유(토큰 없음 — 나눠 보낸 글이면 몇 번째 통에서인지). 앞 통이 나간 뒤 실패하면 부르는 쪽이 다음 주기에 글
     *         전체를 다시 보내 앞 통이 한 번 더 갈 수 있습니다.
     */
    String send(String text) {
        if (!configured()) {
            return "텔레그램 값(TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID)이 없음";
        }
        List<String> parts = parts(text);
        for (int i = 0; i < parts.size(); i++) {
            String error = sendOne(parts.get(i));
            if (error != null) {
                return parts.size() > 1 ? (i + 1) + "/" + parts.size() + "통째 — " + error : error;
            }
        }
        return null;
    }

    /**
     * 글을 {@value #MAX_CHARS}자 이하 조각으로 나눕니다 — 줄 경계에서 나누고, 상한보다 긴 줄만 상한마다 끊습니다(서로게이트 쌍은 가르지 않음).
     * 줄 경계에서 나눈 조각은 줄바꿈으로, 긴 줄을 끊은 조각은 그대로 이으면 원래 글입니다.
     */
    static List<String> parts(String text) {
        if (text.length() <= MAX_CHARS) {
            return List.of(text);
        }
        List<String> out = new ArrayList<>();
        StringBuilder part = null;
        for (String line : text.split("\n", -1)) {
            while (line.length() > MAX_CHARS) {
                if (part != null) {
                    out.add(part.toString());
                    part = null;
                }
                int cut = Character.isHighSurrogate(line.charAt(MAX_CHARS - 1)) ? MAX_CHARS - 1 : MAX_CHARS;
                out.add(line.substring(0, cut));
                line = line.substring(cut);
            }
            if (part != null && part.length() + 1 + line.length() > MAX_CHARS) {
                out.add(part.toString());
                part = null;
            }
            part = part == null ? new StringBuilder(line) : part.append('\n').append(line);
        }
        if (part != null) {
            out.add(part.toString());
        }
        return out;
    }

    /** 한 통(상한 안의 글). */
    private String sendOne(String body) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("chat_id", chatId);
        payload.put("text", body);
        payload.put("disable_web_page_preview", true);
        try {
            Reply reply = sender.post(URI.create(API + "/bot" + token + "/sendMessage"), mapper.writeValueAsString(payload));
            if (reply.status() == 200) {
                return null;
            }
            return "HTTP " + reply.status() + describe(reply.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "보내는 중 끊김";
        } catch (Exception e) {
            return masked(e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
        }
    }

    /** Bot API 오류 본문의 description(있으면, 200자까지). */
    private String describe(String body) {
        try {
            JsonNode node = body == null ? null : mapper.readTree(body);
            String description = node == null ? null : node.path("description").asString(null);
            return description == null ? "" : " — " + masked(description.length() > 200 ? description.substring(0, 200) : description);
        } catch (RuntimeException e) {
            return "";
        }
    }

    private String masked(String text) {
        return token.isEmpty() ? text : text.replace(token, "***");
    }

    private static Sender httpSender() {
        HttpClient client = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
        return (uri, json) -> {
            HttpRequest request = HttpRequest.newBuilder(uri).timeout(TIMEOUT).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8)).build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Reply(response.statusCode(), response.body());
        };
    }
}
