package com.macrodash.feature.info;

import com.macrodash.feature.ai.AiService;
import com.macrodash.store.TranslationStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국어 번역(ADR 0037) — 낮은 등급 모델·effort로 부르고, 저장본에 있는 글자는 다시 번역하지 않고, 하루 상한을 넘기지 않는다. 모델은 대역입니다.
 */
class InfoTranslatorTest {

    private static final Instant NOW = Instant.parse("2026-11-11T12:00:00Z");
    private static final String MODEL = "claude-haiku-5-5";

    private AiService ai;
    private GeminiClient gemini;
    private TranslationStore store;
    private Map<String, String> saved;
    private InfoTranslator translator;

    @BeforeEach
    void setUp() {
        ai = mock(AiService.class);
        gemini = mock(GeminiClient.class);
        store = mock(TranslationStore.class);
        saved = new ConcurrentHashMap<>();      // 본문 조각은 여러 스레드가 함께 저장합니다
        when(store.ready()).thenReturn(true);
        when(store.find(anyCollection())).thenAnswer(call -> {
            Map<String, String> out = new HashMap<>();
            call.<java.util.Collection<String>>getArgument(0).forEach(id -> {
                if (saved.containsKey(id)) {
                    out.put(id, saved.get(id));
                }
            });
            return out;
        });
        doAnswer(call -> saved.putIfAbsent(call.getArgument(0), call.getArgument(3)))
                .when(store).put(anyString(), anyString(), anyInt(), anyString(), anyString());
        translator = translator(1_000_000);
    }

    private static final String GEMINI = "gemini-3.5-flash";
    private static final String LOWER = "gemini-3.5-flash-lite";

    private InfoTranslator translator(long dailyChars) {
        return translator("auto", dailyChars, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private InfoTranslator translator(String engine, long dailyChars, Clock clock) {
        return new InfoTranslator(ai, gemini, store, new ObjectMapper(), engine, MODEL, GEMINI, LOWER, "low", dailyChars, 30, 20, clock);
    }

    private static AiService.StructuredResult ok(String json) {
        return new AiService.StructuredResult(true, json, "end_turn", null, null, true, 10L, 10L, null, null, 5L);
    }

    private static AiService.StructuredResult failed(String kind) {
        return new AiService.StructuredResult(false, null, null, kind, "실패: " + kind, false, null, null, null, null, 0L);
    }

    @Test
    @DisplayName("번역할 글인지 — 한글이 대부분이거나 글자가 없으면 번역하지 않는다")
    void needsTranslation() {
        assertThat(InfoTranslator.needsTranslation("Fed's Waller: rates are restrictive")).isTrue();
        assertThat(InfoTranslator.needsTranslation("한국은행, 기준금리 동결")).isFalse();
        assertThat(InfoTranslator.needsTranslation("코스피 3% 급락, Fed 발언 영향")).isFalse();
        assertThat(InfoTranslator.needsTranslation("2026-11-11 12:00 +3.5%")).isFalse();
        assertThat(InfoTranslator.needsTranslation(" ")).isFalse();
        assertThat(InfoTranslator.needsTranslation(null)).isFalse();
    }

    @Test
    @DisplayName("제목은 한 번의 호출로 묶어 번역하고 저장한다 — 낮은 등급 모델·effort, 한글 제목과 이미 번역한 제목은 보내지 않는다")
    void titlesAreBatchedAndStored() {
        saved.put(TranslationStore.id(TranslationStore.TITLE, "Already done"), "이미 번역함");
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"연준, 금리 동결\"},{\"n\":2,\"ko\":\"유가 급등\"},{\"n\":9,\"ko\":\"범위 밖\"}]}"));

        InfoTranslator.Titles out = translator.titles(List.of("Fed holds rates", "Already done", "한국어 제목", "Oil jumps", "Fed holds rates"));

        assertThat(out.ok()).isTrue();
        assertThat(out.called()).isTrue();
        assertThat(out.translated()).containsEntry("Fed holds rates", "연준, 금리 동결").containsEntry("Oil jumps", "유가 급등")
                .containsEntry("Already done", "이미 번역함").doesNotContainKey("한국어 제목");
        ArgumentCaptor<String> user = ArgumentCaptor.forClass(String.class);
        verify(ai, times(1)).structured(eq(MODEL), eq(InfoTranslator.TITLE_SYSTEM), user.capture(), any(), eq("low"), eq(30));
        assertThat(user.getValue()).contains("Fed holds rates").contains("Oil jumps").doesNotContain("Already done").doesNotContain("한국어 제목");
        verify(store).put(eq(TranslationStore.id(TranslationStore.TITLE, "Oil jumps")), eq(TranslationStore.TITLE), eq(9), eq("유가 급등"), eq(MODEL));
    }

    @Test
    @DisplayName("모두 저장본에 있으면 모델을 부르지 않는다")
    void cachedTitlesDoNotCall() {
        saved.put(TranslationStore.id(TranslationStore.TITLE, "Fed holds rates"), "연준, 금리 동결");

        InfoTranslator.Titles out = translator.titles(List.of("Fed holds rates"));

        assertThat(out.ok()).isTrue();
        assertThat(out.called()).isFalse();
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("하루 상한을 넘으면 부르지 않는다 — 제목·본문 모두")
    void dailyBudget() {
        InfoTranslator tight = translator(100);
        when(store.charsSince(any())).thenReturn(95L);

        InfoTranslator.Titles titles = tight.titles(List.of("Fed holds rates"));
        InfoTranslator.Body body = tight.body("The Committee decided to maintain the target range.");

        assertThat(titles.errorKind()).isEqualTo("BUDGET");
        assertThat(body.ok()).isFalse();
        assertThat(body.error()).contains("상한");
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("모델 실패는 그대로 알리고 저장하지 않는다")
    void titleFailure() {
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(failed("RATE_LIMIT"));

        InfoTranslator.Titles out = translator.titles(List.of("Fed holds rates"));

        assertThat(out.ok()).isFalse();
        assertThat(out.errorKind()).isEqualTo("RATE_LIMIT");
        assertThat(saved).isEmpty();
    }

    @Test
    @DisplayName("본문은 문단 경계에서 조각으로 나눠 번역하고, 다시 부르면 저장본만으로 끝난다")
    void bodyIsChunkedAndCached() {
        String first = "First paragraph. ".repeat(250).strip();       // 약 4,250자
        String second = "Second paragraph. ".repeat(250).strip();
        String text = first + "\n\n" + second;
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenAnswer(call -> {
            String user = call.getArgument(2);
            return ok(user.contains("First paragraph") ? "{\"ko\":\"첫 문단\"}" : "{\"ko\":\"둘째 문단\"}");
        });

        InfoTranslator.Body out = translator.body(text);
        InfoTranslator.Body again = translator.body(text);

        assertThat(out.ok()).isTrue();
        assertThat(out.textKo()).isEqualTo("첫 문단\n\n둘째 문단");
        assertThat(out.cached()).isFalse();
        assertThat(again.textKo()).isEqualTo("첫 문단\n\n둘째 문단");
        assertThat(again.cached()).isTrue();
        verify(ai, times(2)).structured(eq(MODEL), eq(InfoTranslator.BODY_SYSTEM), anyString(), any(), eq("low"), eq(30));
    }

    @Test
    @DisplayName("조각 하나가 실패하면 실패지만 번역된 조각은 남아 다시 부르면 남은 조각만 번역한다")
    void bodyPartialFailureKeepsDoneParts() {
        String first = "First paragraph. ".repeat(250).strip();
        String second = "Second paragraph. ".repeat(250).strip();
        String text = first + "\n\n" + second;
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenAnswer(call -> {
            String user = call.getArgument(2);
            return user.contains("First paragraph") ? ok("{\"ko\":\"첫 문단\"}") : failed("TIMEOUT");
        });

        InfoTranslator.Body out = translator.body(text);

        assertThat(out.ok()).isFalse();
        assertThat(out.textKo()).isNull();
        assertThat(out.error()).contains("다시 누르면");
        assertThat(saved).containsValue("첫 문단").hasSize(1);
    }

    @Test
    @DisplayName("이미 한국어인 글은 번역하지 않는다")
    void koreanBodyIsLeft() {
        InfoTranslator.Body out = translator.body("한국은행은 기준금리를 동결했다. 물가 상승률은 2%대다.");

        assertThat(out.ok()).isTrue();
        assertThat(out.alreadyKorean()).isTrue();
        assertThat(out.textKo()).isNull();
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("조각 나누기 — 문단을 지키고, 긴 문단은 문장 끝에서 자르고, 어느 조각도 상한을 넘지 않는다")
    void chunks() {
        assertThat(InfoTranslator.chunks("a\n\nb\n\n\nc", 100)).containsExactly("a\n\nb\n\nc");
        assertThat(InfoTranslator.chunks("aaaa\n\nbbbb\n\ncccc", 10)).containsExactly("aaaa\n\nbbbb", "cccc");
        List<String> longOne = InfoTranslator.chunks("One sentence here. ".repeat(40).strip(), 100);
        assertThat(longOne).allSatisfy(part -> assertThat(part.length()).isLessThanOrEqualTo(100));
        assertThat(longOne).allSatisfy(part -> assertThat(part).endsWith("."));
        assertThat(String.join(" ", longOne)).isEqualTo("One sentence here. ".repeat(40).strip());
    }

    @Test
    @DisplayName("엔진 auto — 1순위 Gemini로 번역하고 그 모델을 남긴다. Gemini가 한도에 걸리면 2순위 Claude Haiku로 넘어가고, 한동안 Gemini를 건너뛴다")
    void geminiFirstThenClaude() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "{\"items\":[{\"n\":1,\"ko\":\"연준, 금리 동결\"}]}", null, null))
                .thenReturn(GeminiClient.Reply.failed("RATE_LIMIT", "Gemini API 호출 한도에 걸렸습니다(429)."));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"유가 급등\"}]}"))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"금값 하락\"}]}"));
        java.util.concurrent.atomic.AtomicReference<Instant> now = new java.util.concurrent.atomic.AtomicReference<>(NOW);
        Clock ticking = new Clock() {
            @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(java.time.ZoneId zone) { return this; }
            @Override public Instant instant() { return now.get(); }
        };
        InfoTranslator auto = translator("auto", 1_000_000, ticking);

        InfoTranslator.Titles first = auto.titles(List.of("Fed holds rates"));
        InfoTranslator.Titles second = auto.titles(List.of("Oil jumps"));
        InfoTranslator.Titles third = auto.titles(List.of("Gold falls"));

        assertThat(auto.status()).containsEntry("engine", "gemini").containsEntry("model", GEMINI).containsEntry("fallbackModel", MODEL)
                .containsEntry("geminiResting", true);
        assertThat(first.model()).isEqualTo(GEMINI);
        assertThat(first.translated()).containsEntry("Fed holds rates", "연준, 금리 동결");
        assertThat(second.ok()).isTrue();
        assertThat(second.model()).isEqualTo(MODEL);
        assertThat(second.translated()).containsEntry("Oil jumps", "유가 급등");
        assertThat(third.model()).isEqualTo(MODEL);
        // 세 번째는 쉬는 중이라 Gemini를 부르지 않고 바로 Claude로 갑니다.
        verify(gemini, times(2)).structured(eq(GEMINI), eq(InfoTranslator.TITLE_SYSTEM), anyString(), any(), eq(20));
        verify(ai, times(2)).structured(eq(MODEL), eq(InfoTranslator.TITLE_SYSTEM), anyString(), any(), eq("low"), eq(30));
        verify(store).put(anyString(), eq(TranslationStore.TITLE), eq(15), eq("연준, 금리 동결"), eq(GEMINI));
        verify(store).put(anyString(), eq(TranslationStore.TITLE), eq(9), eq("유가 급등"), eq(MODEL));

        // 쉬는 시간이 지나면 다시 Gemini부터.
        now.set(NOW.plusSeconds(InfoTranslator.GEMINI_REST_MINUTES * 60L + 1));
        assertThat(auto.status()).containsEntry("geminiResting", false);
    }

    @Test
    @DisplayName("둘 다 실패하면 두 사유를 함께 알린다. 시간 초과 같은 일시 실패는 Gemini를 쉬게 하지 않는다")
    void bothFail() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt())).thenReturn(GeminiClient.Reply.failed("IO", "닿지 못함"));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(failed("NO_KEY"));
        InfoTranslator auto = translator(1_000_000);

        InfoTranslator.Titles out = auto.titles(List.of("Fed holds rates"));

        assertThat(out.ok()).isFalse();
        assertThat(out.error()).contains("Gemini: 닿지 못함").contains("Claude: 실패: NO_KEY");
        assertThat(auto.status()).containsEntry("geminiResting", false);
        assertThat(saved).isEmpty();
    }

    @Test
    @DisplayName("엔진을 gemini로 고정하면 넘어가지 않고, 키가 없는 auto는 Claude만 부른다. 모르는 엔진 이름이면 멈춘다")
    void fixedEngines() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt())).thenReturn(GeminiClient.Reply.failed("RATE_LIMIT", "한도"));
        InfoTranslator onlyGemini = translator("gemini", 1_000_000, Clock.fixed(NOW, ZoneOffset.UTC));

        assertThat(onlyGemini.titles(List.of("Fed holds rates")).errorKind()).isEqualTo("RATE_LIMIT");
        assertThat(onlyGemini.status()).containsEntry("fallbackModel", null);
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());

        when(gemini.configured()).thenReturn(false);
        InfoTranslator noKey = translator(1_000_000);
        assertThat(noKey.status()).containsEntry("engine", "claude").containsEntry("model", MODEL).containsEntry("fallbackModel", null);
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> translator("papago", 1, Clock.fixed(NOW, ZoneOffset.UTC)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("Gemini 1순위 모델이 실패하면(붐빔·시간 초과 등 종류를 가리지 않고) 한 등급 아래 Gemini를 부르고, 그것도 실패하면 Claude Haiku로")
    void failureTriesLowerGeminiThenClaude() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(eq(GEMINI), anyString(), anyString(), any(), anyInt()))
                .thenReturn(GeminiClient.Reply.failed("OVERLOADED", "붐빔(503): " + GEMINI))
                .thenReturn(GeminiClient.Reply.failed("IO", "시간 초과"));
        when(gemini.structured(eq(LOWER), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "{\"items\":[{\"n\":1,\"ko\":\"연준, 금리 동결\"}]}", null, null))
                .thenReturn(GeminiClient.Reply.failed("OVERLOADED", "붐빔(503): " + LOWER));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"유가 급등\"}]}"));
        InfoTranslator auto = translator(1_000_000);

        InfoTranslator.Titles viaLower = auto.titles(List.of("Fed holds rates"));
        InfoTranslator.Titles viaClaude = auto.titles(List.of("Oil jumps"));

        assertThat(viaLower.model()).isEqualTo(LOWER);
        assertThat(viaLower.translated()).containsEntry("Fed holds rates", "연준, 금리 동결");
        assertThat(viaClaude.model()).isEqualTo(MODEL);
        assertThat(viaClaude.translated()).containsEntry("Oil jumps", "유가 급등");
        assertThat(auto.status()).containsEntry("geminiLowerModel", LOWER).containsEntry("geminiResting", false);
        verify(gemini, times(2)).structured(eq(GEMINI), anyString(), anyString(), any(), anyInt());
        verify(gemini, times(2)).structured(eq(LOWER), anyString(), anyString(), any(), anyInt());
        verify(ai, times(1)).structured(eq(MODEL), anyString(), anyString(), any(), anyString(), anyInt());
        verify(store).put(anyString(), eq(TranslationStore.TITLE), eq(15), eq("연준, 금리 동결"), eq(LOWER));
    }

    @Test
    @DisplayName("1순위가 한도에 걸리면 그 모델만 쉬고 아래 Gemini가 받는다 — 쉬는 동안에는 1순위를 부르지 않고 아래 모델부터")
    void rateLimitedPrimaryRestsAlone() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(eq(GEMINI), anyString(), anyString(), any(), anyInt())).thenReturn(GeminiClient.Reply.failed("RATE_LIMIT", "한도"));
        when(gemini.structured(eq(LOWER), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "{\"items\":[{\"n\":1,\"ko\":\"번역\"}]}", null, null));
        InfoTranslator auto = translator(1_000_000);

        assertThat(auto.titles(List.of("Fed holds rates")).model()).isEqualTo(LOWER);
        assertThat(auto.titles(List.of("Oil jumps")).model()).isEqualTo(LOWER);

        assertThat(auto.status()).containsEntry("geminiResting", false);
        verify(gemini, times(1)).structured(eq(GEMINI), anyString(), anyString(), any(), anyInt());
        verify(gemini, times(2)).structured(eq(LOWER), anyString(), anyString(), any(), anyInt());
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("키·결제 문제면 아래 모델을 부르지 않고(같은 키라 같은 결과) 바로 Claude로, 두 Gemini 모델을 함께 쉰다")
    void keyProblemSkipsLowerModel() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt())).thenReturn(GeminiClient.Reply.failed("BILLING", "크레딧 없음"));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"유가 급등\"}]}"));
        InfoTranslator auto = translator(1_000_000);

        assertThat(auto.titles(List.of("Oil jumps")).model()).isEqualTo(MODEL);

        assertThat(auto.status()).containsEntry("geminiResting", true);
        verify(gemini, times(1)).structured(eq(GEMINI), anyString(), anyString(), any(), anyInt());
        verify(gemini, never()).structured(eq(LOWER), anyString(), anyString(), any(), anyInt());
    }

    // ------------------------------------------------------------------ QA-405
    // Gemini가 '성공'으로 답했는데 글이 형식 밖(JSON 아님·빈 번역)이면, 응답을 읽는 것이 호출 뒤라 다음 순위로 넘어가지 못했습니다 —
    // 그 조각은 누를 때마다 같은 길로 실패했습니다(ADR 0037 개정: '실패의 종류를 가리지 않고 넘어감').

    @Test
    @DisplayName("QA-405: Gemini가 성공 응답에 JSON이 아닌 글을 주면 다음 순위(아래 Gemini → Claude)로 넘어가 그 번역을 저장한다")
    void malformedSuccessFallsThrough() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "죄송하지만 번역할 수 없습니다", null, null));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"ko\":\"위원회는 목표 범위를 유지했다.\"}"));
        InfoTranslator auto = translator(1_000_000);

        InfoTranslator.Body out = auto.body("The Committee decided to maintain the target range.");

        assertThat(out.ok()).isTrue();
        assertThat(out.textKo()).isEqualTo("위원회는 목표 범위를 유지했다.");
        assertThat(out.model()).isEqualTo(MODEL);
        verify(gemini, times(1)).structured(eq(GEMINI), anyString(), anyString(), any(), anyInt());
        verify(gemini, times(1)).structured(eq(LOWER), anyString(), anyString(), any(), anyInt());
        verify(ai, times(1)).structured(eq(MODEL), anyString(), anyString(), any(), anyString(), anyInt());
        assertThat(saved).containsValue("위원회는 목표 범위를 유지했다.").hasSize(1);
    }

    @Test
    @DisplayName("QA-405: 제목 번역도 같다 — 쓸 제목이 없는 성공 응답이면 다음 순위로 넘어간다")
    void emptyTitleItemsFallThrough() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "{\"items\":[{\"n\":7,\"ko\":\"범위 밖\"},{\"n\":1,\"ko\":\" \"}]}", null, null));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"연준, 금리 동결\"}]}"));
        InfoTranslator auto = translator(1_000_000);

        InfoTranslator.Titles out = auto.titles(List.of("Fed holds rates"));

        assertThat(out.ok()).isTrue();
        assertThat(out.model()).isEqualTo(MODEL);
        assertThat(out.translated()).containsEntry("Fed holds rates", "연준, 금리 동결");
    }

    @Test
    @DisplayName("모든 순위가 형식 밖으로 답하면 PARSE 실패로 알리고 저장하지 않는다")
    void allMalformedIsParseFailure() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "not json", null, null));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(ok("still not json"));
        InfoTranslator auto = translator(1_000_000);

        InfoTranslator.Titles out = auto.titles(List.of("Fed holds rates"));

        assertThat(out.ok()).isFalse();
        assertThat(out.errorKind()).isEqualTo("PARSE");
        assertThat(saved).isEmpty();
    }

    @Test
    @DisplayName("QA-405: 요청 거절(400)로 실패한 Gemini 모델은 한동안 건너뛴다 — 다음 호출은 Gemini를 부르지 않고 Claude로")
    void badRequestRestsGemini() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(GeminiClient.Reply.failed("BAD_REQUEST", "Gemini API가 요청을 받지 않았습니다(400)."));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"연준, 금리 동결\"}]}"))
                .thenReturn(ok("{\"items\":[{\"n\":1,\"ko\":\"유가 급등\"}]}"));
        InfoTranslator auto = translator(1_000_000);

        assertThat(auto.titles(List.of("Fed holds rates")).model()).isEqualTo(MODEL);
        assertThat(auto.titles(List.of("Oil jumps")).model()).isEqualTo(MODEL);

        // 첫 호출에서 1순위·아래 모델을 한 번씩 불러 보고, 둘 다 쉬는 동안에는 부르지 않습니다.
        verify(gemini, times(1)).structured(eq(GEMINI), anyString(), anyString(), any(), anyInt());
        verify(gemini, times(1)).structured(eq(LOWER), anyString(), anyString(), any(), anyInt());
        assertThat(auto.status()).containsEntry("geminiResting", true);
    }
}
