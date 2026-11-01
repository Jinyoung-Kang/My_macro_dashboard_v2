package com.macrodash.feature.paper;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 구조화 출력 스키마 — 파일 하나로 API에 보낼 스키마와 응답 검사를 함께 만듭니다(D26, 설계 §5-1).
 *
 * <p><b>왜 둘로 나누는가.</b> 단계 0에서 확인한 대로 API는 숫자 {@code minimum}·{@code maximum}을 400으로 거절하고, 문자열
 * 길이·배열 크기 제약도 받지 않습니다. 그렇다고 스키마 파일에서 그 제약을 빼면 "노출 0~100%", "주문 12건 이하" 같은 약속이
 * 아무 데도 남지 않습니다. 그래서 파일에는 전체 제약을 그대로 두고, {@link #forApi()}가 API가 받지 않는 키만 걷어 내 보내며,
 * 받은 응답은 {@link #validate}가 <b>같은 파일 전체</b>로 검사합니다. 어기면 C3 "응답 형식 오류"입니다.
 *
 * <p><b>아는 키만 씁니다.</b> {@link #validate}는 JSON Schema 전체가 아니라 우리 스키마가 쓰는 부분집합을 검사합니다. 파일에
 * 이 밖의 키(예: {@code anyOf}·{@code minProperties})가 있으면 {@link #load}가 멈춥니다 — 모르는 제약을 조용히 건너뛰면
 * API도 코드도 검사하지 않는 구멍이 생기기 때문입니다. 같은 이유로 객체 스키마마다 {@code additionalProperties: false}를
 * 요구합니다(API가 모든 객체에 요구, 단계 0).
 *
 * <p>스키마는 불변이고 여러 스레드가 함께 써도 됩니다.
 */
public final class StructuredSchema {

    /** API가 받지 않는 키(단계 0·D26) — {@link #forApi()}가 걷어 내고 {@link #validate}가 대신 검사합니다. */
    static final Set<String> API_UNSUPPORTED = Set.of("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
            "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems");

    /** API에도 보내고 검사도 하는 키, 그리고 설명용 키. */
    private static final Set<String> SHARED = Set.of("type", "enum", "const", "required", "additionalProperties",
            "properties", "items", "pattern", "description", "title");

    private static final Set<String> TYPES = Set.of("object", "array", "string", "integer", "number", "boolean", "null");

    /** 경로에 점 표기로 적어도 되는 키 이름. 그 밖(공백·한글 등)은 ['키']로 적습니다. */
    private static final Pattern PLAIN_KEY = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");

    /** 위반 문구에 값을 그대로 적을 때의 최대 길이 — 긴 문자열 하나가 결정 기록을 채우지 않게. */
    private static final int MAX_SHOWN = 80;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final String name;
    private final JsonNode root;
    private final Map<String, Object> api;
    /** pattern이 있는 스키마 노드(동일성 기준) → 컴파일한 정규식. 응답마다 다시 컴파일하지 않게 load 때 한 번 만듭니다. */
    private final Map<JsonNode, Pattern> patterns;

    private StructuredSchema(String name, JsonNode root) {
        List<String> problems = new ArrayList<>();
        Map<JsonNode, Pattern> compiled = new IdentityHashMap<>();
        checkSchema(root, "$", problems, compiled);
        if (!problems.isEmpty()) {
            throw new IllegalStateException("스키마 파일이 잘못됐습니다(" + name + "): " + String.join("; ", problems));
        }
        this.name = name;
        this.root = root;
        this.patterns = compiled;
        @SuppressWarnings("unchecked")
        Map<String, Object> stripped = (Map<String, Object>) stripForApi(root);
        this.api = stripped;
    }

    /**
     * 클래스패스의 스키마 파일을 읽습니다(예: {@code "paper/decision.schema.json"}, 앞의 {@code /}는 있어도 됨).
     *
     * @throws IllegalStateException 파일이 없거나 JSON이 아니거나, 아는 키·모양을 벗어났을 때(이유를 경로와 함께)
     */
    public static StructuredSchema load(String resource) {
        String path = resource.startsWith("/") ? resource.substring(1) : resource;
        ClassLoader loader = StructuredSchema.class.getClassLoader();
        try (InputStream in = loader.getResourceAsStream(path)) {
            if (in == null) {
                throw new IllegalStateException("스키마 파일이 없습니다: " + path);
            }
            return parse(path, new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("스키마 파일을 읽지 못했습니다: " + path, e);
        }
    }

    /** 문자열에서 바로 만듭니다 — 테스트가 작은 스키마로 키마다 검사할 때 씁니다. */
    static StructuredSchema parse(String name, String json) {
        JsonNode root;
        try {
            root = MAPPER.readTree(json);
        } catch (JacksonException e) {
            throw new IllegalStateException("스키마 파일이 JSON이 아닙니다(" + name + "): " + e.getOriginalMessage(), e);
        }
        return new StructuredSchema(name, root);
    }

    /** 이 스키마의 이름(리소스 경로). 로그·오류 문구용. */
    public String name() {
        return name;
    }

    /**
     * API에 보낼 스키마 — {@link #API_UNSUPPORTED} 키를 모든 깊이에서 걷어 낸 사본(속성 <b>이름</b>은 건드리지 않음).
     * pattern·enum·const·type 배열·required·additionalProperties·properties·items는 남습니다. 바꿀 수 없는 Map이고 키 순서는
     * 파일 순서 그대로입니다(같은 스키마면 같은 요청 본문 — API의 스키마 캐시가 맞습니다).
     */
    public Map<String, Object> forApi() {
        return api;
    }

    /**
     * 응답을 스키마 파일 <b>전체</b>로 검사합니다. 위반이 없으면 빈 목록.
     *
     * <p>위반마다 {@code "경로: 이유"} 한 줄(경로는 {@code $}가 뿌리, 예: {@code $.orders[2].ticker}). 한 값의 형이 틀리면 그 값의
     * 나머지 검사는 하지 않습니다(같은 원인으로 문구가 여러 개 생기지 않게). 범위·길이·개수·pattern은 JSON Schema처럼 그 형의
     * 값에만 적용됩니다 — 예: {@code ["number","null"]}에 붙은 {@code minimum}은 null이면 보지 않습니다. 문자열 길이는 코드
     * 포인트(글자) 수입니다.
     *
     * @param value 응답 텍스트를 JSON으로 읽은 것. null이면(읽지 못함) 위반 하나
     */
    public List<String> validate(JsonNode value) {
        List<String> out = new ArrayList<>();
        if (value == null || value.isMissingNode()) {
            out.add("$: 값이 없습니다");
            return out;
        }
        check(root, value, "$", out);
        return out;
    }

    // ── 검사 ───────────────────────────────────────────────────────────

    private void check(JsonNode schema, JsonNode value, String path, List<String> out) {
        JsonNode type = schema.get("type");
        if (type != null && !typeMatches(type, value)) {
            out.add("%s: 형이 맞지 않습니다 — 기대 %s, 실제 %s".formatted(path, typeLabel(type), actualType(value)));
            return;
        }
        JsonNode constant = schema.get("const");
        if (constant != null && !jsonEquals(constant, value)) {
            out.add("%s: 값이 %s여야 합니다 — 실제 %s".formatted(path, shown(constant), shown(value)));
            return;
        }
        JsonNode allowed = schema.get("enum");
        if (allowed != null && allowed.values().stream().noneMatch(option -> jsonEquals(option, value))) {
            out.add("%s: 허용 값이 아닙니다 — 실제 %s (허용: %s)".formatted(path, shown(value), allowedLabel(allowed)));
            return;
        }
        if (value.isNumber()) {
            checkNumber(schema, value, path, out);
        } else if (value.isString()) {
            checkString(schema, value.stringValue(), path, out);
        } else if (value.isArray()) {
            checkArray(schema, value, path, out);
        } else if (value.isObject()) {
            checkObject(schema, value, path, out);
        }
    }

    private static void checkNumber(JsonNode schema, JsonNode value, String path, List<String> out) {
        BigDecimal number = value.decimalValue();
        JsonNode limit;
        if ((limit = schema.get("minimum")) != null && number.compareTo(limit.decimalValue()) < 0) {
            out.add("%s: 최솟값 %s보다 작습니다 — 실제 %s".formatted(path, limit, value));
        }
        if ((limit = schema.get("maximum")) != null && number.compareTo(limit.decimalValue()) > 0) {
            out.add("%s: 최댓값 %s보다 큽니다 — 실제 %s".formatted(path, limit, value));
        }
        if ((limit = schema.get("exclusiveMinimum")) != null && number.compareTo(limit.decimalValue()) <= 0) {
            out.add("%s: %s보다 커야 합니다 — 실제 %s".formatted(path, limit, value));
        }
        if ((limit = schema.get("exclusiveMaximum")) != null && number.compareTo(limit.decimalValue()) >= 0) {
            out.add("%s: %s보다 작아야 합니다 — 실제 %s".formatted(path, limit, value));
        }
        if ((limit = schema.get("multipleOf")) != null
                && number.remainder(limit.decimalValue()).compareTo(BigDecimal.ZERO) != 0) {
            out.add("%s: %s의 배수가 아닙니다 — 실제 %s".formatted(path, limit, value));
        }
    }

    private void checkString(JsonNode schema, String text, String path, List<String> out) {
        int length = text.codePointCount(0, text.length());
        JsonNode limit;
        if ((limit = schema.get("minLength")) != null && length < limit.intValue()) {
            out.add("%s: 길이 %d자가 최소 %d자보다 짧습니다".formatted(path, length, limit.intValue()));
        }
        if ((limit = schema.get("maxLength")) != null && length > limit.intValue()) {
            out.add("%s: 길이 %d자가 최대 %d자를 넘습니다".formatted(path, length, limit.intValue()));
        }
        Pattern pattern = patterns.get(schema);
        // JSON Schema의 pattern은 전체 일치가 아니라 "어딘가에 맞음"입니다 — 고정은 스키마의 ^…$가 합니다.
        if (pattern != null && !pattern.matcher(text).find()) {
            out.add("%s: 형식 %s에 맞지 않습니다 — 실제 %s".formatted(path, pattern.pattern(), shown(text)));
        }
    }

    private void checkArray(JsonNode schema, JsonNode array, String path, List<String> out) {
        JsonNode limit;
        if ((limit = schema.get("minItems")) != null && array.size() < limit.intValue()) {
            out.add("%s: 항목 %d개가 최소 %d개보다 적습니다".formatted(path, array.size(), limit.intValue()));
        }
        if ((limit = schema.get("maxItems")) != null && array.size() > limit.intValue()) {
            out.add("%s: 항목 %d개가 최대 %d개를 넘습니다".formatted(path, array.size(), limit.intValue()));
        }
        JsonNode unique = schema.get("uniqueItems");
        if (unique != null && unique.booleanValue()) {
            duplicates:
            for (int i = 0; i < array.size(); i++) {
                for (int j = i + 1; j < array.size(); j++) {
                    if (jsonEquals(array.get(i), array.get(j))) {
                        out.add("%s: 중복 항목이 있습니다 — [%d]와 [%d]".formatted(path, i, j));
                        break duplicates;
                    }
                }
            }
        }
        JsonNode items = schema.get("items");
        if (items != null) {
            for (int i = 0; i < array.size(); i++) {
                check(items, array.get(i), path + "[" + i + "]", out);
            }
        }
    }

    private void checkObject(JsonNode schema, JsonNode object, String path, List<String> out) {
        JsonNode properties = schema.get("properties");
        JsonNode required = schema.get("required");
        if (required != null) {
            for (JsonNode key : required.values()) {
                if (!object.has(key.stringValue())) {
                    out.add("%s: 필수 키가 없습니다".formatted(child(path, key.stringValue())));
                }
            }
        }
        JsonNode additional = schema.get("additionalProperties");
        boolean closed = additional != null && additional.isBoolean() && !additional.booleanValue();
        for (Map.Entry<String, JsonNode> entry : object.properties()) {
            JsonNode sub = properties == null ? null : properties.get(entry.getKey());
            if (sub != null) {
                check(sub, entry.getValue(), child(path, entry.getKey()), out);
            } else if (closed) {
                out.add("%s: 스키마에 없는 키입니다".formatted(child(path, entry.getKey())));
            }
        }
    }

    private static boolean typeMatches(JsonNode type, JsonNode value) {
        if (type.isString()) {
            return isType(type.stringValue(), value);
        }
        for (JsonNode option : type.values()) {
            if (isType(option.stringValue(), value)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isType(String type, JsonNode value) {
        return switch (type) {
            case "object" -> value.isObject();
            case "array" -> value.isArray();
            case "string" -> value.isString();
            // JSON Schema의 integer는 "정수 값인 숫자"입니다 — 2.0도 integer입니다.
            case "integer" -> value.isNumber() && isIntegral(value);
            case "number" -> value.isNumber();
            case "boolean" -> value.isBoolean();
            case "null" -> value.isNull();
            default -> false;
        };
    }

    private static boolean isIntegral(JsonNode number) {
        if (number.isIntegralNumber()) {
            return true;
        }
        BigDecimal decimal = number.decimalValue();
        return decimal.signum() == 0 || decimal.stripTrailingZeros().scale() <= 0;
    }

    private static String actualType(JsonNode value) {
        if (value.isNumber()) {
            return isIntegral(value) ? "integer" : "number";
        }
        if (value.isString()) {
            return "string";
        }
        if (value.isBoolean()) {
            return "boolean";
        }
        if (value.isNull()) {
            return "null";
        }
        return value.isArray() ? "array" : value.isObject() ? "object" : String.valueOf(value.getNodeType());
    }

    private static String typeLabel(JsonNode type) {
        if (type.isString()) {
            return type.stringValue();
        }
        List<String> names = new ArrayList<>();
        type.values().forEach(option -> names.add(option.stringValue()));
        return String.join("|", names);
    }

    private static String allowedLabel(JsonNode allowed) {
        List<String> names = new ArrayList<>();
        allowed.values().forEach(option -> names.add(option.isString() ? option.stringValue() : option.toString()));
        return String.join(", ", names);
    }

    /**
     * JSON 값이 같은가 — 숫자는 값으로 비교합니다(2와 2.0은 같음, JSON Schema 규칙). Jackson의 equals는 노드 종류까지 봐서
     * {@code const: 2}에 2.0을 거절합니다.
     */
    private static boolean jsonEquals(JsonNode a, JsonNode b) {
        if (a.isNumber() && b.isNumber()) {
            return a.decimalValue().compareTo(b.decimalValue()) == 0;
        }
        if (a.isArray() && b.isArray()) {
            if (a.size() != b.size()) {
                return false;
            }
            for (int i = 0; i < a.size(); i++) {
                if (!jsonEquals(a.get(i), b.get(i))) {
                    return false;
                }
            }
            return true;
        }
        if (a.isObject() && b.isObject()) {
            if (a.size() != b.size()) {
                return false;
            }
            for (Map.Entry<String, JsonNode> entry : a.properties()) {
                JsonNode other = b.get(entry.getKey());
                if (other == null || !jsonEquals(entry.getValue(), other)) {
                    return false;
                }
            }
            return true;
        }
        return a.equals(b);
    }

    private static String child(String path, String key) {
        return PLAIN_KEY.matcher(key).matches() ? path + "." + key : path + "['" + key.replace("'", "\\'") + "']";
    }

    private static String shown(JsonNode value) {
        return clip(value.isString() ? '"' + value.stringValue() + '"' : value.toString());
    }

    private static String shown(String text) {
        return clip('"' + text + '"');
    }

    /** 위반 문구에 넣을 값 — 길면 {@link #MAX_SHOWN}글자(코드 포인트)에서 자릅니다. */
    private static String clip(String text) {
        return text.codePointCount(0, text.length()) > MAX_SHOWN
                ? text.substring(0, text.offsetByCodePoints(0, MAX_SHOWN)) + "…" : text;
    }

    // ── 스키마 파일 자체의 검사(load 때 한 번) ─────────────────────────────

    /**
     * 스키마가 아는 키·모양만 쓰는지 봅니다. 문제는 {@code problems}에 쌓고(한 번에 모두 보이게), pattern은 컴파일해 둡니다.
     */
    private static void checkSchema(JsonNode schema, String path, List<String> problems,
                                    Map<JsonNode, Pattern> patterns) {
        if (schema == null || !schema.isObject()) {
            problems.add(path + ": 스키마는 객체여야 합니다");
            return;
        }
        for (String key : schema.propertyNames()) {
            if (!SHARED.contains(key) && !API_UNSUPPORTED.contains(key)) {
                problems.add("%s: 모르는 키 %s — 검사기가 다루지 않는 제약입니다".formatted(path, key));
            }
        }

        Set<String> declaredTypes = new LinkedHashSet<>();
        JsonNode type = schema.get("type");
        if (type != null) {
            if (type.isString()) {
                declaredTypes.add(type.stringValue());
            } else if (type.isArray() && !type.isEmpty()) {
                type.values().forEach(option -> declaredTypes.add(option.isString() ? option.stringValue() : "?"));
            } else {
                problems.add(path + ".type: 문자열이나 비지 않은 문자열 배열이어야 합니다");
            }
            for (String name : declaredTypes) {
                if (!TYPES.contains(name)) {
                    problems.add("%s.type: 모르는 형 %s".formatted(path, name));
                }
            }
        }

        JsonNode allowed = schema.get("enum");
        if (allowed != null && (!allowed.isArray() || allowed.isEmpty())) {
            problems.add(path + ".enum: 비지 않은 배열이어야 합니다");
        }

        JsonNode properties = schema.get("properties");
        boolean objectSchema = declaredTypes.contains("object") || properties != null;
        JsonNode additional = schema.get("additionalProperties");
        if (additional != null && !(additional.isBoolean() && !additional.booleanValue())) {
            problems.add(path + ".additionalProperties: false만 씁니다(API가 다른 값을 받지 않음)");
        } else if (objectSchema && additional == null) {
            problems.add(path + ": 객체 스키마에 additionalProperties: false가 없습니다(API가 모든 객체에 요구)");
        }
        if (properties != null) {
            if (!properties.isObject()) {
                problems.add(path + ".properties: 객체여야 합니다");
            } else {
                properties.forEachEntry((key, sub) -> checkSchema(sub, child(path, key), problems, patterns));
            }
        }
        JsonNode required = schema.get("required");
        if (required != null) {
            if (!required.isArray()) {
                problems.add(path + ".required: 배열이어야 합니다");
            } else {
                for (JsonNode key : required.values()) {
                    if (!key.isString()) {
                        problems.add(path + ".required: 키 이름(문자열)만 씁니다");
                    } else if (properties == null || !properties.has(key.stringValue())) {
                        // additionalProperties: false와 함께면 지킬 수 없는 스키마가 됩니다.
                        problems.add("%s.required: %s가 properties에 없습니다".formatted(path, key.stringValue()));
                    }
                }
            }
        }
        JsonNode items = schema.get("items");
        if (items != null) {
            checkSchema(items, path + "[]", problems, patterns);
        }

        JsonNode pattern = schema.get("pattern");
        if (pattern != null) {
            if (!pattern.isString()) {
                problems.add(path + ".pattern: 문자열이어야 합니다");
            } else {
                try {
                    patterns.put(schema, Pattern.compile(pattern.stringValue()));
                } catch (PatternSyntaxException e) {
                    problems.add("%s.pattern: 정규식이 아닙니다 — %s".formatted(path, e.getDescription()));
                }
            }
        }
        for (String key : List.of("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum")) {
            JsonNode limit = schema.get(key);
            if (limit != null && !limit.isNumber()) {
                problems.add("%s.%s: 숫자여야 합니다".formatted(path, key));
            }
        }
        JsonNode multiple = schema.get("multipleOf");
        if (multiple != null && (!multiple.isNumber() || multiple.decimalValue().signum() <= 0)) {
            problems.add(path + ".multipleOf: 0보다 큰 숫자여야 합니다");
        }
        for (String key : List.of("minLength", "maxLength", "minItems", "maxItems")) {
            JsonNode limit = schema.get(key);
            if (limit != null && !(limit.isIntegralNumber() && limit.canConvertToInt() && limit.intValue() >= 0)) {
                problems.add("%s.%s: 0 이상의 정수여야 합니다".formatted(path, key));
            }
        }
        JsonNode unique = schema.get("uniqueItems");
        if (unique != null && !unique.isBoolean()) {
            problems.add(path + ".uniqueItems: true·false여야 합니다");
        }
    }

    // ── API용 사본 ──────────────────────────────────────────────────────

    /** 스키마 노드 → API용 Map. 걷어 낼 키는 스키마 자리에서만 봅니다(properties 안의 키는 속성 이름이라 그대로). */
    private static Object stripForApi(JsonNode schema) {
        Map<String, Object> out = new LinkedHashMap<>();
        schema.forEachEntry((key, value) -> {
            if (API_UNSUPPORTED.contains(key)) {
                return;
            }
            if ("properties".equals(key)) {
                Map<String, Object> props = new LinkedHashMap<>();
                value.forEachEntry((name, sub) -> props.put(name, stripForApi(sub)));
                out.put(key, Collections.unmodifiableMap(props));
            } else if ("items".equals(key)) {
                out.put(key, stripForApi(value));
            } else {
                out.put(key, plain(value));
            }
        });
        return Collections.unmodifiableMap(out);
    }

    /** JSON 값 → Java 값(Map·List·String·Number·Boolean·null). SDK의 {@code JsonValue.from}이 받는 모양입니다. */
    private static Object plain(JsonNode value) {
        if (value.isObject()) {
            Map<String, Object> out = new LinkedHashMap<>();
            value.forEachEntry((key, sub) -> out.put(key, plain(sub)));
            return Collections.unmodifiableMap(out);
        }
        if (value.isArray()) {
            List<Object> out = new ArrayList<>();
            value.values().forEach(sub -> out.add(plain(sub)));
            return Collections.unmodifiableList(out);
        }
        if (value.isString()) {
            return value.stringValue();
        }
        if (value.isNumber()) {
            return value.numberValue();
        }
        if (value.isBoolean()) {
            return value.booleanValue();
        }
        return null;
    }
}
