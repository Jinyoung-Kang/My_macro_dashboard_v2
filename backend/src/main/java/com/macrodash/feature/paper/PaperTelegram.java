package com.macrodash.feature.paper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.time.Duration;

/**
 * 모의 매매 알림의 텔레그램 보내기(사용자 요청 2026-11-02) — Bot API {@code sendMessage} 한 번에 글 한 통(길면 여러 통). 봇 토큰·대화방은 서버 {@code .env}의
 * {@code TELEGRAM_BOT_TOKEN}·{@code TELEGRAM_CHAT_ID}(S3 백업 실패 알림과 같은 값 — scripts/vultr/backup-s3.sh, QA-199)이고 둘 다 있어야 켜집니다. 로컬·QA에는 값이 없어 보내지
 * 않습니다.
 *
 * <p><b>봇 네 개</b>(사용자 요청 2026-11-08 — {@link Channel}): 알림 종류마다 봇을 나눕니다. 위 두 값이 운영 봇이고, 미국·한국·계좌 봇은 토큰
 * ({@code TELEGRAM_US_BOT_TOKEN}·{@code TELEGRAM_KR_BOT_TOKEN}·{@code TELEGRAM_ACCOUNT_BOT_TOKEN})만 따로 둡니다. 토큰이 비면 운영 봇으로 보내고,
 * 대화방은 네 봇이 같습니다(운영자와의 1:1 대화).
 *
 * <ul>
 *   <li>글은 텔레그램 MarkdownV2 서식(parse_mode MarkdownV2 — 사용자 요청 2026-11-08)입니다. 글을 만드는 쪽이 값을 모두 {@link #esc}로 넣고 표시는 {@link #bold}·
 *       {@link #quote}·{@link #link}로만 붙입니다(모두 한 줄 안에서 닫혀 나눠 보내도 갈라지지 않음). 텔레그램이 서식을 거절하면(HTTP 400 — 엔티티 해석 실패 등) 같은
 *       글을 표시를 떼고 평문으로 한 번 더 보냅니다({@link #plain} — 알림이 빠지지 않게). 링크 미리보기는 끔({@code link_preview_options.is_disabled}).
 *       {@value #MAX_CHARS}자를 넘으면 줄 경계에서 나눠 여러 통으로 차례로 보냅니다(자르지 않음 — QA-168).</li>
 *   <li>실패 사유에 봇 토큰이 섞이지 않게 합니다(주소에 토큰이 들어가므로 예외 글에서 지움). 재시도는 부르는 쪽(알림 작업 — 다음 주기)이 합니다.</li>
 * </ul>
 */
@Component
public class PaperTelegram {

    private static final Logger log = LoggerFactory.getLogger(PaperTelegram.class);

    static final String API = "https://api.telegram.org";
    static final Duration TIMEOUT = Duration.ofSeconds(10);
    /** 한 통의 글자 상한 — Bot API 4096자(서식을 푼 뒤)보다 조금 작게. 이스케이프·표시까지 세므로 보이는 글은 늘 이보다 짧습니다. */
    static final int MAX_CHARS = 4000;

    /** 보내는 길 — 시험이 가짜로 바꿔 끼웁니다. */
    @FunctionalInterface
    interface Sender {
        /** 응답 상태와 본문. 연결 실패는 예외. */
        Reply post(URI uri, String json) throws Exception;
    }

    record Reply(int status, String body) {
    }

    /** 알림을 보내는 봇 — 토큰이 없는 봇의 알림은 운영 봇({@link #OPS})으로 갑니다. */
    public enum Channel { OPS, US, KR, ACCOUNT }

    private final String token;
    private final String chatId;
    private final Map<Channel, String> channelTokens;
    private final ObjectMapper mapper;
    private final Sender sender;

    @Autowired
    PaperTelegram(@Value("${dashboard.paper.telegram-bot-token:}") String token,
                  @Value("${dashboard.paper.telegram-chat-id:}") String chatId,
                  @Value("${dashboard.paper.telegram-us-bot-token:}") String usToken,
                  @Value("${dashboard.paper.telegram-kr-bot-token:}") String krToken,
                  @Value("${dashboard.paper.telegram-account-bot-token:}") String accountToken, ObjectMapper mapper) {
        this(token, chatId, channels(usToken, krToken, accountToken), mapper, httpSender());
    }

    /** 시험용 — 운영 봇 하나만, 보내는 길을 바꿔 끼웁니다. */
    PaperTelegram(String token, String chatId, ObjectMapper mapper, Sender sender) {
        this(token, chatId, Map.of(), mapper, sender);
    }

    /** 시험용 — 봇별 토큰과 보내는 길을 바꿔 끼웁니다. */
    PaperTelegram(String token, String chatId, Map<Channel, String> channelTokens, ObjectMapper mapper, Sender sender) {
        this.token = token == null ? "" : token.strip();
        this.chatId = chatId == null ? "" : chatId.strip();
        this.channelTokens = Map.copyOf(channelTokens);
        this.mapper = mapper;
        this.sender = sender;
    }

    private static Map<Channel, String> channels(String usToken, String krToken, String accountToken) {
        Map<Channel, String> out = new EnumMap<>(Channel.class);
        out.put(Channel.US, usToken == null ? "" : usToken);
        out.put(Channel.KR, krToken == null ? "" : krToken);
        out.put(Channel.ACCOUNT, accountToken == null ? "" : accountToken);
        return out;
    }

    /** 그 봇의 토큰 — 없으면 운영 봇의 토큰. */
    private String tokenOf(Channel channel) {
        String own = channelTokens.get(channel);
        return own == null || own.isBlank() ? token : own.strip();
    }

    /** 봇 토큰과 대화방이 둘 다 있나. (수집 출처 닫힘 알림 — feature.status — 도 같은 봇으로 보냅니다, ADR 0026) */
    public boolean configured() {
        return !token.isEmpty() && !chatId.isEmpty();
    }

    /** 운영 봇으로 보냅니다 — {@link #send(Channel, String)}. */
    public String send(String text) {
        return send(Channel.OPS, text);
    }

    /**
     * 글 하나를 그 봇으로 보냅니다 — {@value #MAX_CHARS}자를 넘으면 {@link #parts}로 나눠 차례로.
     *
     * @return 모두 보냈으면 null, 실패면 사유(토큰 없음 — 나눠 보낸 글이면 몇 번째 통에서인지). 앞 통이 나간 뒤 실패하면 부르는 쪽이 다음 주기에 글
     *         전체를 다시 보내 앞 통이 한 번 더 갈 수 있습니다.
     */
    public String send(Channel channel, String text) {
        if (!configured()) {
            return "텔레그램 값(TELEGRAM_BOT_TOKEN·TELEGRAM_CHAT_ID)이 없음";
        }
        String botToken = tokenOf(channel);
        List<String> parts = parts(text);
        for (int i = 0; i < parts.size(); i++) {
            String error = sendOne(botToken, parts.get(i));
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
                int cut = Character.isHighSurrogate(line.charAt(MAX_CHARS - 1)) || line.charAt(MAX_CHARS - 1) == '\\' ? MAX_CHARS - 1 : MAX_CHARS;
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

    /** 한 통(상한 안의 글) — MarkdownV2 서식으로, 서식을 거절하면(HTTP 400) 평문으로 한 번 더. */
    private String sendOne(String botToken, String body) {
        String error = post(botToken, body, true);
        if (error == null || !error.startsWith("HTTP 400")) {
            return error;
        }
        String plainError = post(botToken, plain(body), false);
        if (plainError == null) {
            log.warn("텔레그램이 MarkdownV2 서식을 거절해 평문으로 보냈습니다 — {}", error);
        }
        return plainError;
    }

    /** MarkdownV2에서 표시로 읽히는 글자(Bot API 'MarkdownV2 style'이 이스케이프를 요구하는 목록) + 역슬래시. */
    private static final Pattern MARKDOWN_SPECIAL = Pattern.compile("[_*\\[\\]()~`>#+\\-=|{}.!\\\\]");

    /** 서버 값·모델 글을 글자 그대로 보이게. */
    public static String esc(String text) {
        return text == null ? "" : MARKDOWN_SPECIAL.matcher(text).replaceAll("\\\\$0");
    }

    /** 굵은 글씨 한 줄(제목·항목 이름). */
    public static String bold(String text) {
        return "*" + esc(text) + "*";
    }

    /** 인용 블록 — 줄마다 표시를 붙입니다(빈 줄은 뺌). 모델이 쓴 글을 서버 값과 구분해 보여 줍니다. */
    public static String quote(String text) {
        return text.lines().filter(line -> !line.isBlank()).map(line -> ">" + esc(line)).collect(Collectors.joining("\n"));
    }

    /** 글자에 건 링크. */
    public static String link(String label, String url) {
        return "[" + esc(label) + "](" + url.replace("\\", "\\\\").replace(")", "\\)") + ")";
    }

    /** MarkdownV2 글 → 평문(이스케이프를 풀고 굵은 글씨·인용 표시를 떼고, 링크는 '글자 주소'로). 서식이 거절됐을 때만 씁니다. */
    public static String plain(String markdown) {
        StringBuilder out = new StringBuilder(markdown.length());
        for (int i = 0; i < markdown.length(); i++) {
            char c = markdown.charAt(i);
            if (c == '\\' && i + 1 < markdown.length()) {
                out.append(markdown.charAt(++i));
            } else if (c == '>' && (i == 0 || markdown.charAt(i - 1) == '\n')) {
                continue;
            } else if (c == ']' && i + 1 < markdown.length() && markdown.charAt(i + 1) == '(') {
                out.append(' ');
                i++;
            } else if (c != '*' && c != '[' && c != ')') {
                out.append(c);
            }
        }
        return out.toString();
    }

    private String post(String botToken, String body, boolean markdown) {
        ObjectNode payload = mapper.createObjectNode();
        payload.put("chat_id", chatId);
        payload.put("text", body);
        if (markdown) {
            payload.put("parse_mode", "MarkdownV2");
        }
        payload.putObject("link_preview_options").put("is_disabled", true);
        try {
            Reply reply = sender.post(URI.create(API + "/bot" + botToken + "/sendMessage"), mapper.writeValueAsString(payload));
            if (reply.status() == 200) {
                return null;
            }
            return "HTTP " + reply.status() + describe(botToken, reply.body());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "보내는 중 끊김";
        } catch (Exception e) {
            return masked(botToken, e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage()));
        }
    }

    /** Bot API 오류 본문의 description(있으면, 200자까지). */
    private String describe(String botToken, String body) {
        try {
            JsonNode node = body == null ? null : mapper.readTree(body);
            String description = node == null ? null : node.path("description").asString(null);
            return description == null ? "" : " — " + masked(botToken, description.length() > 200 ? description.substring(0, 200) : description);
        } catch (RuntimeException e) {
            return "";
        }
    }

    private static String masked(String botToken, String text) {
        return botToken.isEmpty() ? text : text.replace(botToken, "***");
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
