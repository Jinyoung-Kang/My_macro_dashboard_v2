package com.macrodash.feature.info;

import com.macrodash.store.TranslationStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 제목 미리 번역 작업(ADR 0037) — 켜진 곳에서만, 묶어서, 실패하면 쉬고, 문제 제목 하나는 찾아내 건너뛴다. */
class InfoTranslateJobTest {

    private static final Instant NOW = Instant.parse("2026-11-11T12:00:00Z");

    private InfoTranslator translator;
    private TranslationStore store;

    @BeforeEach
    void setUp() {
        translator = mock(InfoTranslator.class);
        store = mock(TranslationStore.class);
        when(store.ready()).thenReturn(true);
    }

    private InfoTranslateJob job(boolean enabled) {
        return new InfoTranslateJob(translator, store, enabled, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static InfoTranslator.Titles all(List<String> batch) {
        Map<String, String> out = new LinkedHashMap<>();
        batch.forEach(title -> out.put(title, "번역 " + title));
        return new InfoTranslator.Titles(out, null, null, true);
    }

    @Test
    @DisplayName("꺼져 있으면 정기 실행이 아무것도 하지 않는다")
    void disabledDoesNothing() {
        job(false).scheduledRun();

        verify(store, never()).pendingTitles(any(), any(), anyInt());
        verify(translator, never()).titles(anyList());
    }

    @Test
    @DisplayName("기다리는 제목을 40개씩 묶어 번역한다")
    @SuppressWarnings("unchecked")
    void batches() {
        List<String> pending = IntStream.range(0, 90).mapToObj(i -> "Title " + i).toList();
        when(store.pendingTitles(any(), any(), anyInt())).thenReturn(pending);
        when(translator.titles(anyList())).thenAnswer(call -> all(call.getArgument(0)));

        int done = job(true).run();

        assertThat(done).isEqualTo(90);
        verify(translator, times(3)).titles(anyList());
    }

    @Test
    @DisplayName("호출 실패면 그 주기를 끝내고 쉰다 — 쉬는 동안에는 표도 읽지 않는다")
    void failureBacksOff() {
        when(store.pendingTitles(any(), any(), anyInt())).thenReturn(IntStream.range(0, 90).mapToObj(i -> "Title " + i).toList());
        when(translator.titles(anyList())).thenReturn(new InfoTranslator.Titles(Map.of(), "RATE_LIMIT", "한도", true));
        InfoTranslateJob job = job(true);

        assertThat(job.run()).isZero();
        assertThat(job.run()).isZero();

        verify(translator, times(1)).titles(anyList());
        verify(store, times(1)).pendingTitles(any(), any(), anyInt());
    }

    @Test
    @DisplayName("모델이 거절한 묶음은 반으로 나눠 문제 제목 하나만 건너뛰고 나머지는 번역한다")
    @SuppressWarnings("unchecked")
    void refusalIsBisected() {
        List<String> pending = List.of("Good 1", "Bad one", "Good 2", "Good 3");
        when(store.pendingTitles(any(), any(), anyInt())).thenReturn(pending);
        when(translator.titles(anyList())).thenAnswer(call -> {
            List<String> batch = call.getArgument(0);
            return batch.contains("Bad one") ? new InfoTranslator.Titles(Map.of(), "REFUSAL", "거절", true) : all(batch);
        });
        InfoTranslateJob job = job(true);

        assertThat(job.run()).isEqualTo(3);

        // 다음 주기에는 문제 제목을 다시 보내지 않습니다.
        when(store.pendingTitles(any(), any(), anyInt())).thenReturn(List.of("Bad one"));
        assertThat(job.run()).isZero();
        verify(translator, times(5)).titles(anyList());     // 4개(거절) → 앞 2개(거절) → 1개(성공)·1개(거절 — 건너뜀), 뒤 2개(성공)
    }
}
