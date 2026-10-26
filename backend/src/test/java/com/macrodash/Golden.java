package com.macrodash;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.fail;

/**
 * 고정본(golden) 대조 — 테스트가 만든 글자를 {@code src/test/resources/paper/golden/} 아래 파일과 <b>바이트까지</b> 맞춰 봅니다.
 *
 * <p>왜 있나: 2단계 묶음 A(시장 추상화, 명세 2026-10-26-v2-kr-paper-spec.md §9)는 "미국 책의 숫자·패킷·프롬프트·스키마가 하나도 안
 * 바뀜"이 수용 기준입니다. 리팩터 전에 지금 출력을 파일로 얼려 두고, 그 뒤 커밋들은 이 파일을 건드리지 않은 채 통과해야 합니다.
 * 고정본 파일이 바뀐 커밋은 미국 동작이 바뀐 커밋입니다 — 의도한 변경이면 그 커밋 메시지에 이유를 적습니다.
 *
 * <p>파일 모양: 출력 그대로 + 끝에 줄바꿈 하나(편집기·git이 "파일 끝 줄바꿈 없음"을 만들지 않게). 읽을 때 그 한 줄바꿈만 뗍니다.
 *
 * <p>다시 만들기: {@code GOLDEN_UPDATE=1 make test-backend}(환경 변수 — 메이븐이 띄운 테스트 JVM에도 그대로 전해짐). 소스 폴더의
 * 파일을 덮어쓰고 통과합니다. 만든 뒤에는 바뀐 내용을 사람이 읽고 커밋합니다. 테스트 코드 안의 해시 상수(패킷·스키마 파일)는
 * 저절로 바뀌지 않습니다 — 실패 메시지가 보여 주는 새 값으로 직접 고칩니다. 다를 때는 실제 출력을
 * {@code target/golden-actual/}에 남겨 {@code diff}로 비교할 수 있게 합니다.
 *
 * <p>출력에 실행마다 달라지는 값을 넣지 않습니다: 실제 경과 시간({@code latencyMs})은 빼고, 고정본에 그대로 실리는 재료는
 * {@code Map.of}가 아니라 넣은 순서를 지키는 맵으로 만듭니다({@code Map.of}의 순회 순서는 JVM마다 다름).
 */
public final class Golden {

    private Golden() {
    }

    /** 고정본을 다시 쓰게 하는 환경 변수(값이 {@code 1}·{@code true}). */
    public static final String UPDATE_ENV = "GOLDEN_UPDATE";
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String RESOURCE_DIR = "paper/golden/";
    private static final Path SOURCE_DIR = Path.of("src", "test", "resources", "paper", "golden");
    private static final Path ACTUAL_DIR = Path.of("target", "golden-actual");
    /** 다를 때 보여 줄 앞뒤 글자 수. */
    private static final int CONTEXT = 80;

    /**
     * {@code actual}이 고정본 {@code name}과 같은지 봅니다. 업데이트 모드면 고정본을 다시 씁니다.
     *
     * @param name 고정본 파일 이름({@code paper/golden/} 아래, 예: {@code packet-us-initial.json})
     */
    public static void assertMatches(String name, String actual) {
        if (actual == null) {
            fail("고정본 " + name + "과 견줄 출력이 null입니다");
            return;
        }
        if (updating()) {
            write(SOURCE_DIR.resolve(name), actual);
            return;
        }
        String expected = read(name);
        if (expected == null) {
            Path written = write(ACTUAL_DIR.resolve(name), actual);
            fail("고정본 " + RESOURCE_DIR + name + "이 없습니다 — " + UPDATE_ENV + "=1 make test-backend로 만든 뒤 내용을 읽고 "
                    + "커밋하세요(지금 출력: " + written + ")");
            return;
        }
        if (expected.equals(actual)) {
            return;
        }
        Path written = write(ACTUAL_DIR.resolve(name), actual);
        int at = firstDifference(expected, actual);
        fail("고정본 " + RESOURCE_DIR + name + "과 다릅니다 — 미국 책 동작이 바뀌었습니다.\n"
                + "첫 차이: " + position(expected, at) + " (기대 " + expected.length() + "자, 실제 " + actual.length() + "자)\n"
                + "기대: …" + around(expected, at) + "…\n"
                + "실제: …" + around(actual, at) + "…\n"
                + "실제 출력 전체: " + written.toAbsolutePath() + " (diff로 비교). 의도한 변경이면 " + UPDATE_ENV
                + "=1로 다시 만들고 커밋 메시지에 이유를 적으세요.");
    }

    /** 들여쓴 JSON(줄바꿈 {@code \n}) — 사람이 읽고 diff로 견주는 고정본용. 글자 값은 그대로(이스케이프만) 남습니다. */
    public static String prettyJson(Object value) {
        return MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value).replace("\r\n", "\n");
    }

    /**
     * Claude 요청 본문(가짜 서버가 받은 JSON) 대조. 시스템 프롬프트(첫 블록)의 글자는 고정본 {@code systemGolden}과, 첫 사용자
     * 메시지의 글자는 {@code userGolden}(null이면 떼지 않고 요청 JSON 안에 둠)과 글자 그대로 견줍니다. 요청 JSON의 그 자리는
     * {@code <<고정본 이름>>}으로 바꾼 뒤 나머지(모델·토큰 상한·effort·스키마·캐시 표시)를 {@code requestGolden}에 들여쓴 JSON으로
     * 견줍니다 — 긴 프롬프트가 JSON 이스케이프 없이 읽히게.
     */
    public static void assertClaudeRequest(JsonNode request, String systemGolden, String userGolden,
                                           String requestGolden) {
        ObjectNode copy = (ObjectNode) request.deepCopy();
        assertMatches(systemGolden, takeText(copy, "system", systemGolden));
        if (userGolden != null) {
            JsonNode messages = copy.path("messages");
            if (!messages.isArray() || messages.isEmpty() || !messages.get(0).isObject()) {
                fail("요청에 사용자 메시지가 없습니다: " + request);
            }
            assertMatches(userGolden, takeText((ObjectNode) messages.get(0), "content", userGolden));
        }
        assertMatches(requestGolden, prettyJson(copy));
    }

    /** {@code holder.field}의 글자(문자열이면 그것, 블록 배열이면 첫 블록의 text)를 꺼내고 그 자리를 고정본 이름 표시로 바꿉니다. */
    private static String takeText(ObjectNode holder, String field, String golden) {
        String marker = "<<고정본 " + golden + ">>";
        JsonNode value = holder.get(field);
        if (value != null && value.isString()) {
            holder.put(field, marker);
            return value.asString();
        }
        if (value != null && value.isArray() && !value.isEmpty() && value.get(0).isObject()
                && value.get(0).path("text").isString()) {
            ObjectNode block = (ObjectNode) value.get(0);
            String text = block.get("text").asString();
            block.put("text", marker);
            return text;
        }
        fail("요청의 " + field + "에서 글자를 찾지 못했습니다: " + holder);
        return null;
    }

    /** UTF-8 바이트의 SHA-256(소문자 16진수 64자). */
    public static String sha256(String text) {
        return sha256(text.getBytes(StandardCharsets.UTF_8));
    }

    /** 바이트의 SHA-256(소문자 16진수 64자). */
    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 쓸 수 없습니다", e);
        }
    }

    /** 클래스패스 자원의 바이트 그대로(스키마 파일처럼 소스에 있는 고정 자원의 해시용). 없으면 실패. */
    public static byte[] resourceBytes(String resource) {
        try (InputStream in = Golden.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) {
                fail("자원이 없습니다: " + resource);
                return new byte[0];
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static boolean updating() {
        String value = System.getenv(UPDATE_ENV);
        return "1".equals(value) || "true".equalsIgnoreCase(value);
    }

    /** 고정본 내용(끝 줄바꿈 하나를 뗀 것). 없으면 null. */
    private static String read(String name) {
        try (InputStream in = Golden.class.getClassLoader().getResourceAsStream(RESOURCE_DIR + name)) {
            if (in == null) {
                return null;
            }
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static Path write(Path file, String text) {
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, text + "\n", StandardCharsets.UTF_8);
            return file;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static int firstDifference(String a, String b) {
        int n = Math.min(a.length(), b.length());
        for (int i = 0; i < n; i++) {
            if (a.charAt(i) != b.charAt(i)) {
                return i;
            }
        }
        return n;
    }

    /** 글자 위치 → "줄 L, 칸 C(글자 i)". */
    private static String position(String text, int at) {
        int line = 1;
        int column = 1;
        for (int i = 0; i < Math.min(at, text.length()); i++) {
            if (text.charAt(i) == '\n') {
                line++;
                column = 1;
            } else {
                column++;
            }
        }
        return "줄 " + line + ", 칸 " + column + "(글자 " + at + ")";
    }

    private static String around(String text, int at) {
        int from = Math.max(0, at - CONTEXT);
        int to = Math.min(text.length(), at + CONTEXT);
        return text.substring(from, to).replace("\n", "⏎");
    }
}
