package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.feature.info.InfoTranslator;
import com.macrodash.read.StoreReader;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 정보 검색 본문 보기(ADR 0043, 계약 §10) — 운영자만, 꼬리표 모양 검사(400), 외부를 부르지 않는 모드는 start=false(없으면 offline), 사용자 한 시간 10건
 * (넘으면 start=false, 없으면 user_limit과 남은 분), 수집기의 queued는 셈에만 쓰고 지움, 닿지 못하면 available:false, 예외가 나도 자리를 돌려줌.
 * 번역은 수집기 캐시만 읽고(start=false) 본문은 저장하지 않는 길, 같은 글을 번역하는 중이면 429. 수집기·번역은 대역이고 글은 합성 표본입니다.
 */
class SearchArticleServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Instant NOW = Instant.parse("2026-11-17T03:00:00Z");
    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);
    private static final CurrentUser DEMO = new CurrentUser(-1, null, "OWNER", "PRO", null, true);
    private static final String REF = "0123456789abcdef0123456789abcdef";

    private MutableClock clock;
    private CollectorClient collector;
    private StoreReader store;
    private InfoTranslator translator;
    private SearchArticleService service;

    @BeforeEach
    void setUp() {
        clock = new MutableClock(NOW);
        collector = mock(CollectorClient.class);
        store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        translator = mock(InfoTranslator.class);
        service = new SearchArticleService(collector, store, translator, clock);
    }

    private static ObjectNode answer(String status, String reason, boolean queued) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("ref", REF);
        body.put("status", status);
        if (reason == null) {
            body.putNull("reason");
        } else {
            body.put("reason", reason);
        }
        body.putNull("message");
        body.put("retryable", false);
        body.putNull("retryAfterSeconds");
        body.put("queued", queued);
        body.putNull("article");
        body.put("fetchedAt", "2026-11-17T03:00:00+00:00");
        return body;
    }

    private static ObjectNode okAnswer(String title, List<String> paragraphs) {
        ObjectNode body = answer("ok", null, false);
        ObjectNode article = body.putObject("article");
        article.put("title", title);
        article.put("lang", "en");
        paragraphs.forEach(article.putArray("paragraphs")::add);
        return body;
    }

    @Test
    @DisplayName("꼬리표 모양이 틀리면 400이고 수집기를 부르지 않는다")
    void refShape() {
        for (String bad : new String[]{null, "", "abc", REF.toUpperCase(), REF + "0", "../" + REF.substring(3), "g".repeat(32)}) {
            assertThatThrownBy(() -> service.article(bad, OWNER)).isInstanceOf(InvalidRequestException.class);
            assertThatThrownBy(() -> service.translate(bad, OWNER)).isInstanceOf(InvalidRequestException.class);
        }
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("회원·데모는 403 — 수집기를 부르지 않는다")
    void ownerOnly() {
        assertThatThrownBy(() -> service.article(REF, MEMBER)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> service.translate(REF, MEMBER)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> service.article(REF, null)).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("처음 부름은 start=true — 수집기의 queued는 셈에만 쓰고 응답에서 지우며 available:true를 더한다")
    void firstCallStarts() {
        when(collector.liveSearchArticle(REF, true)).thenReturn(Optional.of(answer("pending", null, true)));

        Map<String, Object> out = service.article(REF, OWNER);

        assertThat(out).containsEntry("available", true).doesNotContainKey("queued");
        assertThat(((JsonNode) out.get("status")).asString()).isEqualTo("pending");
        verify(collector).liveSearchArticle(REF, true);
    }

    @Test
    @DisplayName("STORE_ONLY·데모는 start=false — 받아 둔 것이 없으면 offline")
    void storeOnlyIsOffline() {
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        when(collector.liveSearchArticle(REF, false)).thenReturn(Optional.of(answer("error", "not_cached", false)));

        Map<String, Object> out = service.article(REF, OWNER);

        assertThat(((JsonNode) out.get("reason")).asString()).isEqualTo("offline");
        assertThat(((JsonNode) out.get("message")).asString()).contains("받아 둔 본문만");
        verify(collector, never()).liveSearchArticle(anyString(), eq(true));
        assertThatThrownBy(() -> service.article(REF, DEMO)).isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("한 시간에 10번 새로 넣었으면 start=false — 받아 둔 것이 없으면 user_limit과 남은 분, 받아 둔 것은 그대로")
    void hourlyLimit() {
        when(collector.liveSearchArticle(anyString(), eq(true))).thenReturn(Optional.of(answer("pending", null, true)));
        for (int i = 0; i < SearchArticleService.PER_HOUR; i++) {
            clock.advance(Duration.ofMinutes(1));
            service.article(REF, OWNER);
        }
        when(collector.liveSearchArticle(REF, false)).thenReturn(Optional.of(answer("error", "not_cached", false)));

        Map<String, Object> out = service.article(REF, OWNER);

        assertThat(((JsonNode) out.get("reason")).asString()).isEqualTo("user_limit");
        assertThat(((JsonNode) out.get("message")).asString()).contains("10건").contains("약 51분");
        assertThat(((JsonNode) out.get("retryable")).booleanValue()).isTrue();
        assertThat(((JsonNode) out.get("retryAfterSeconds")).asInt()).isEqualTo(51 * 60);

        when(collector.liveSearchArticle(REF, false)).thenReturn(Optional.of(okAnswer("Synthetic", List.of("Body."))));
        assertThat(((JsonNode) service.article(REF, OWNER).get("status")).asString()).isEqualTo("ok");

        clock.advance(Duration.ofMinutes(51));
        service.article(REF, OWNER);
        verify(collector, org.mockito.Mockito.times(SearchArticleService.PER_HOUR + 1)).liveSearchArticle(REF, true);
    }

    @Test
    @DisplayName("새로 넣지 않은 요청(캐시·받는 중·실패)은 자리를 돌려준다 — 한도를 쓰지 않음")
    void notQueuedReleasesTheSlot() {
        when(collector.liveSearchArticle(REF, true)).thenReturn(Optional.of(answer("pending", null, false)));
        for (int i = 0; i < SearchArticleService.PER_HOUR * 3; i++) {
            service.article(REF, OWNER);
        }
        verify(collector, org.mockito.Mockito.times(SearchArticleService.PER_HOUR * 3)).liveSearchArticle(REF, true);
        verify(collector, never()).liveSearchArticle(REF, false);
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 available:false — 자리도 돌려준다")
    void collectorUnreachable() {
        when(collector.liveSearchArticle(anyString(), anyBoolean())).thenReturn(Optional.empty());
        for (int i = 0; i < SearchArticleService.PER_HOUR + 2; i++) {
            Map<String, Object> out = service.article(REF, OWNER);
            assertThat(out).containsEntry("available", false).containsEntry("message", SearchService.NO_RESPONSE);
        }
        verify(collector, never()).liveSearchArticle(REF, false);
    }

    @Test
    @DisplayName("예외가 나도 잡았던 자리를 돌려준다")
    void exceptionReleasesTheSlot() {
        when(collector.liveSearchArticle(REF, true)).thenThrow(new IllegalStateException("boom"));
        for (int i = 0; i < SearchArticleService.PER_HOUR + 2; i++) {
            assertThatThrownBy(() -> service.article(REF, OWNER)).isInstanceOf(IllegalStateException.class);
        }
        verify(collector, never()).liveSearchArticle(REF, false);
    }

    @Test
    @DisplayName("번역 — 수집기 캐시만(start=false), 받아 둔 본문이 없으면 ok:false와 다시 누르라는 안내")
    void translateNeedsCachedArticle() {
        when(collector.liveSearchArticle(REF, false)).thenReturn(Optional.of(answer("error", "not_cached", false)));

        Map<String, Object> out = service.translate(REF, OWNER);

        assertThat(out).containsEntry("ok", false).containsEntry("textKo", null);
        assertThat((String) out.get("error")).contains("본문 보기를 다시");
        verify(collector, never()).liveSearchArticle(REF, true);
        verifyNoInteractions(translator);
    }

    @Test
    @DisplayName("번역 — 본문은 저장하지 않는 길, 제목은 지금 번역 길, 응답은 /api/info/translate와 같은 모양")
    void translateUsesUnsavedBody() {
        when(collector.liveSearchArticle(REF, false))
                .thenReturn(Optional.of(okAnswer("Synthetic Widgets revenue rises", List.of("First paragraph.", "Second paragraph."))));
        when(translator.titles(anyList())).thenReturn(new InfoTranslator.Titles(Map.of("Synthetic Widgets revenue rises", "합성 위젯 매출 증가"),
                null, null, true, "claude-haiku-5-5"));
        when(translator.models("Synthetic Widgets revenue rises", null)).thenReturn(List.of("claude-haiku-5-5"));
        when(translator.bodyUnsaved("First paragraph.\n\nSecond paragraph."))
                .thenReturn(new InfoTranslator.UnsavedBody(true, "첫 문단.\n\n둘째 문단.", false, false, false, null, "gemini-3.5-flash",
                        List.of("gemini-3.5-flash")));

        Map<String, Object> out = service.translate(REF, OWNER);

        assertThat(out.keySet()).containsExactly("ok", "titleKo", "textKo", "alreadyKorean", "cached", "truncated", "model", "models", "error");
        assertThat(out).containsEntry("ok", true).containsEntry("titleKo", "합성 위젯 매출 증가").containsEntry("textKo", "첫 문단.\n\n둘째 문단.")
                .containsEntry("model", "gemini-3.5-flash").containsEntry("error", null);
        assertThat(out.get("models")).isEqualTo(List.of("claude-haiku-5-5", "gemini-3.5-flash"));
        verify(translator, never()).body(anyString());
    }

    @Test
    @DisplayName("같은 글을 번역하는 중이면 429")
    void translateBusy() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(collector.liveSearchArticle(REF, false)).thenAnswer(call -> {
            entered.countDown();
            release.await(5, TimeUnit.SECONDS);
            return Optional.of(answer("error", "not_cached", false));
        });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<Map<String, Object>> first = pool.submit(() -> service.translate(REF, OWNER));
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> service.translate(REF, OWNER)).isInstanceOf(TooManyRequestsException.class)
                    .hasMessageContaining("번역하는 중");
            release.countDown();
            assertThat(first.get(5, TimeUnit.SECONDS)).containsEntry("ok", false);
            assertThat(service.translate(REF, OWNER)).containsEntry("ok", false);
        } finally {
            pool.shutdownNow();
        }
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
