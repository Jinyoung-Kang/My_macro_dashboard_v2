package com.macrodash.feature.info;

import com.macrodash.feature.ai.AiService;
import com.macrodash.store.TranslationStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 저장하지 않는 본문 번역(정보 검색 본문 보기 — ADR 0043, {@link InfoTranslator#bodyUnsaved}) — 번역 표에 쓰지 않고 메모리(24시간)에만 두며, 하루 글자
 * 상한은 {@link InfoAiBudget#reserve}로 함께 세고(모델에 요청이 나가지 않았으면 돌려줌), 같은 조각은 다시 부르지 않습니다. 모델은 대역이고 글은 합성 표본입니다.
 */
class InfoTranslatorUnsavedTest {

    private static final Instant NOW = Instant.parse("2026-11-17T03:00:00Z");
    private static final String MODEL = "claude-haiku-5-5";
    private static final String ENGLISH = "Synthetic Widgets reported higher quarterly revenue in an invented note written for tests.";

    private AiService ai;
    private GeminiClient gemini;
    private TranslationStore store;
    private MutableClock clock;
    private InfoAiBudget budget;

    @BeforeEach
    void setUp() {
        ai = mock(AiService.class);
        gemini = mock(GeminiClient.class);
        store = mock(TranslationStore.class);
        when(store.ready()).thenReturn(true);
        when(store.charsSince(any())).thenReturn(0L);
        clock = new MutableClock(NOW);
    }

    private InfoTranslator translator(long dailyChars) {
        budget = new InfoAiBudget(store, dailyChars, clock);
        return new InfoTranslator(ai, gemini, store, budget, new ObjectMapper(), "claude", MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite",
                "low", 30, 20, clock);
    }

    private static AiService.StructuredResult ok(String ko) {
        return new AiService.StructuredResult(true, "{\"ko\":\"" + ko + "\"}", "end_turn", null, null, true, 10L, 10L, null, null, 5L);
    }

    private static AiService.StructuredResult failed(String kind) {
        return new AiService.StructuredResult(false, null, null, kind, "실패: " + kind, false, null, null, null, null, 0L);
    }

    @Test
    @DisplayName("저장하지 않는 길은 번역 표에 쓰지 않고, 하루 상한은 reserve로 센다")
    void neverWritesTheTable() {
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(ok("합성 위젯이 분기 매출 증가를 보고했다."));
        InfoTranslator translator = translator(1_000_000);

        InfoTranslator.UnsavedBody out = translator.bodyUnsaved(ENGLISH);

        assertThat(out.ok()).isTrue();
        assertThat(out.textKo()).isEqualTo("합성 위젯이 분기 매출 증가를 보고했다.");
        assertThat(out.cached()).isFalse();
        assertThat(out.model()).isEqualTo(MODEL);
        assertThat(out.models()).containsExactly(MODEL);
        verify(store, never()).put(anyString(), anyString(), anyInt(), anyString(), anyString());
        verify(store, never()).find(anyCollection());
        assertThat(budget.usedToday()).isEqualTo(ENGLISH.length());
        assertThat(translator.unsavedSize()).isEqualTo(1);
    }

    @Test
    @DisplayName("모델 응답이 JSON 형식 밖이면 실패로 두고, 로그에는 예외 종류만 — 읽지 못한 글(번역 앞부분)을 남기지 않는다")
    void parseFailureLogsNoText() {
        String token = "Bodytextsecretparagraphwordsfromthearticlebody";
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt()))
                .thenReturn(new AiService.StructuredResult(true, token + " 와 한국어 번역 문장", "end_turn", null, null, true, 10L, 10L, null, null, 5L));
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(InfoTranslator.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender = new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            InfoTranslator.UnsavedBody out = translator(1_000_000).bodyUnsaved(ENGLISH);

            assertThat(out.ok()).isFalse();
            assertThat(appender.list).isNotEmpty();
            assertThat(appender.list).allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(token));
            assertThat(appender.list).anySatisfy(event -> assertThat(event.getFormattedMessage()).contains("번역 응답을 읽지 못함"));
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    @DisplayName("같은 조각은 24시간 다시 부르지 않고(cached), 지나면 다시 번역한다")
    void sameChunkIsReusedFor24Hours() {
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(ok("번역"));
        InfoTranslator translator = translator(1_000_000);
        translator.bodyUnsaved(ENGLISH);

        InfoTranslator.UnsavedBody again = translator.bodyUnsaved(ENGLISH);
        assertThat(again.ok()).isTrue();
        assertThat(again.cached()).isTrue();
        assertThat(again.model()).isNull();
        assertThat(again.models()).containsExactly(MODEL);
        verify(ai, times(1)).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
        assertThat(budget.usedToday()).isEqualTo(ENGLISH.length());

        clock.advance(UnsavedTranslations.TTL.plusSeconds(1));
        assertThat(translator.bodyUnsaved(ENGLISH).cached()).isFalse();
        verify(ai, times(2)).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("일부 조각만 실패하면 번역된 조각은 메모리에 남아 다시 누르면 남은 조각만 번역한다")
    void partialFailureKeepsTranslatedChunks() {
        String first = "First synthetic paragraph about invented revenue. ".repeat(80).strip();
        String second = "Second synthetic paragraph about made-up margins. ".repeat(80).strip();
        String text = first + "\n\n" + second;
        AtomicInteger calls = new AtomicInteger();
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenAnswer(call -> {
            String user = call.getArgument(2);
            calls.incrementAndGet();
            return user.contains("Second") && calls.get() <= 2 ? failed("TIMEOUT") : ok("조각 번역");
        });
        InfoTranslator translator = translator(1_000_000);

        InfoTranslator.UnsavedBody broken = translator.bodyUnsaved(text);
        assertThat(broken.ok()).isFalse();
        assertThat(broken.error()).contains("남은 부분만");
        assertThat(translator.unsavedSize()).isEqualTo(1);

        InfoTranslator.UnsavedBody fixed = translator.bodyUnsaved(text);
        assertThat(fixed.ok()).isTrue();
        assertThat(fixed.textKo()).isEqualTo("조각 번역\n\n조각 번역");
        assertThat(calls.get()).isEqualTo(3);
        verify(store, never()).put(anyString(), anyString(), anyInt(), anyString(), anyString());
    }

    @Test
    @DisplayName("하루 상한을 넘으면 부르지 않고 ok:false와 안내 글 — 센 글자도 없다")
    void dailyLimit() {
        when(store.charsSince(any())).thenReturn(990L);
        InfoTranslator translator = translator(1_000);

        InfoTranslator.UnsavedBody out = translator.bodyUnsaved(ENGLISH);

        assertThat(out.ok()).isFalse();
        assertThat(out.error()).contains("상한");
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
        assertThat(budget.usedToday()).isEqualTo(990L);
    }

    @Test
    @DisplayName("모델에 요청이 나가지 않았으면(키 없음·허용 목록 밖) 센 글자를 돌려준다")
    void releasesWhenNothingWasSent() {
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(failed("NO_KEY"));
        InfoTranslator translator = translator(1_000_000);

        InfoTranslator.UnsavedBody out = translator.bodyUnsaved(ENGLISH);

        assertThat(out.ok()).isFalse();
        assertThat(budget.usedToday()).isZero();
    }

    @Test
    @Disabled("QA-1020: Gemini에 보낸 뒤 Claude가 NO_KEY면 '요청이 나가지 않음'으로 보고 센 글자를 돌려줌")
    @DisplayName("QA-1020: Gemini에 요청이 나갔으면 마지막 엔진(Claude)이 키 없음으로 끝나도 센 글자를 돌려주지 않는다")
    void keepsCountWhenGeminiWasCalled() {
        when(gemini.configured()).thenReturn(true);
        when(gemini.structured(anyString(), anyString(), anyString(), any(), anyInt()))
                .thenReturn(GeminiClient.Reply.failed("OVERLOADED", "붐빔(503)"));
        when(ai.structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt())).thenReturn(failed("NO_KEY"));
        budget = new InfoAiBudget(store, 1_000_000, clock);
        InfoTranslator translator = new InfoTranslator(ai, gemini, store, budget, new ObjectMapper(), "auto", MODEL, "gemini-3.5-flash",
                "gemini-3.5-flash-lite", "low", 30, 20, clock);

        InfoTranslator.UnsavedBody out = translator.bodyUnsaved(ENGLISH);

        assertThat(out.ok()).isFalse();
        verify(gemini, times(2)).structured(anyString(), anyString(), anyString(), any(), anyInt());
        assertThat(budget.usedToday()).as("Gemini에 보낸 글자는 오늘 쓴 양에 남음").isEqualTo(ENGLISH.length());
    }

    @Test
    @DisplayName("한국어 글은 번역하지 않고 alreadyKorean, 빈 글은 실패")
    void koreanAndBlank() {
        InfoTranslator translator = translator(1_000_000);
        assertThat(translator.bodyUnsaved("합성 기사는 이미 한국어로 쓴 글입니다.").alreadyKorean()).isTrue();
        assertThat(translator.bodyUnsaved("  ").ok()).isFalse();
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
    }

    @Test
    @DisplayName("메모리 캐시는 400조각까지 — 넘으면 오래 안 쓴 것부터 뺀다")
    void cacheIsBounded() {
        UnsavedTranslations cache = new UnsavedTranslations(clock);
        for (int i = 0; i < UnsavedTranslations.LIMIT + 5; i++) {
            cache.put(UnsavedTranslations.key("part " + i), "ko " + i, MODEL);
        }
        assertThat(cache.size()).isEqualTo(UnsavedTranslations.LIMIT);
        assertThat(cache.find(java.util.List.of(UnsavedTranslations.key("part 0")))).isEmpty();
        assertThat(cache.find(java.util.List.of(UnsavedTranslations.key("part 404")))).hasSize(1);
        assertThat(UnsavedTranslations.TTL).isEqualTo(Duration.ofHours(24));
    }

    /** 고칠 수 있는 시계. */
    static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
