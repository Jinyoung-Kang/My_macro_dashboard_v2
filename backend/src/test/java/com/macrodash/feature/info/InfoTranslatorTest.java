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
    private TranslationStore store;
    private Map<String, String> saved;
    private InfoTranslator translator;

    @BeforeEach
    void setUp() {
        ai = mock(AiService.class);
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

    private InfoTranslator translator(long dailyChars) {
        return new InfoTranslator(ai, store, new ObjectMapper(), MODEL, "low", dailyChars, 30, Clock.fixed(NOW, ZoneOffset.UTC));
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
}
