package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.feature.ai.AiService;
import com.macrodash.feature.info.GeminiClient;
import com.macrodash.feature.info.InfoAiBudget;
import com.macrodash.read.StoreReader;
import com.macrodash.store.TranslationStore;
import com.macrodash.support.CurrentUser;
import com.macrodash.web.ApiExceptionHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 정보 검색 AI 요약 경로({@code POST /api/search/summary}, 계약 §9-6) — 본문 {@code {e, tab, range}}를 서비스에 넘기고, 400·403·429가 공통 오류 모양
 * ({@code {error, message}})으로 나가는지. 경로 등급(운영자)은 세션 필터가 {@code AccessPolicy}로 막고, 서비스도 한 번 더 막습니다. 모델은 대역입니다.
 */
class SearchSummaryControllerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);
    /** 2026-11-15 12:00 KST. */
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-15T03:00:00Z"), ZoneOffset.UTC);

    private CollectorClient collector;
    private GeminiClient gemini;
    private TranslationStore translations;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        collector = mock(CollectorClient.class);
        gemini = mock(GeminiClient.class);
        when(gemini.configured()).thenReturn(true);
        AiService ai = mock(AiService.class);
        when(ai.engines()).thenReturn(Map.of("keys", Map.of("anthropic", false), "engines", List.of()));
        translations = mock(TranslationStore.class);
        when(translations.ready()).thenReturn(true);
        when(translations.charsSince(any())).thenReturn(0L);
        SearchService search = new SearchService(store, collector, CLOCK);
        SearchSummaryService service = new SearchSummaryService(search, gemini, ai, new InfoAiBudget(translations, 1_000_000, CLOCK),
                MAPPER, "auto", "claude-haiku-5-5", "gemini-3.5-flash", "", "low", 30, 20, CLOCK);
        mvc = MockMvcBuilders.standaloneSetup(new SearchSummaryController(service))
                .setControllerAdvice(new ApiExceptionHandler())
                .build();
    }

    private MvcResult call(CurrentUser user, String body) throws Exception {
        var request = post("/api/search/summary").requestAttr(CurrentUser.ATTRIBUTE, user).contentType(MediaType.APPLICATION_JSON);
        if (body != null) {
            request = request.content(body);
        }
        return mvc.perform(request).andReturn();
    }

    private static JsonNode json(MvcResult result) throws Exception {
        return MAPPER.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private void feedWithOneRow() {
        String feed = """
                {"entityKey":"us:SYNT","tab":"news","window":{"from":"2024-11-15","to":"2026-11-15"},"sources":[],
                 "items":[{"id":"a1","kind":"news","title":"Synthetic headline","url":"https://news.example/a1","publisher":"Example Wire",
                           "publishedAt":"2026-11-15T01:00:00+00:00","timeBasis":"published","source":"google_en","lang":"en",
                           "summary":null,"readerId":null}]}
                """;
        when(collector.liveSearchFeed("us:SYNT", "news", false, true, false, false)).thenReturn(Optional.of(MAPPER.readTree(feed)));
    }

    @Test
    @DisplayName("운영자의 요청은 받아 둔 결과(external=false)로 요약해 {available, summary, basedOn, model, generatedAt, cached}")
    void ownerGetsSummary() throws Exception {
        feedWithOneRow();
        when(gemini.structured(eq("gemini-3.5-flash"), anyString(), anyString(), any(), anyInt()))
                .thenReturn(new GeminiClient.Reply(true, "{\"lines\":[{\"text\":\"합성 요약\",\"refs\":[1]}]}", null, null));

        MvcResult result = call(OWNER, "{\"e\":\"us:SYNT\",\"tab\":\"news\",\"range\":\"7d\"}");

        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        JsonNode body = json(result);
        assertThat(body.path("available").asBoolean()).isTrue();
        assertThat(body.path("summary").path(0).path("text").asString()).isEqualTo("합성 요약");
        assertThat(body.path("summary").path(0).path("refs").path(0).asString()).isEqualTo("a1");
        assertThat(body.path("basedOn").asInt()).isEqualTo(1);
        assertThat(body.path("model").asString()).isEqualTo("gemini-3.5-flash");
        assertThat(body.path("generatedAt").asString()).isEqualTo("2026-11-15T03:00:00+00:00");
        assertThat(body.path("cached").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("틀린 입력·빈 본문은 400 {error:bad_request, message}이고 수집기를 부르지 않는다")
    void badInputIs400() throws Exception {
        for (String body : new String[]{"{\"e\":\"NVDA\",\"tab\":\"news\",\"range\":\"7d\"}",
                "{\"e\":\"us:SYNT\",\"tab\":\"holdings\",\"range\":\"7d\"}", "{\"e\":\"us:SYNT\",\"tab\":\"news\",\"range\":\"5y\"}",
                "{}", null, "{\"e\":"}) {
            MvcResult result = call(OWNER, body);
            assertThat(result.getResponse().getStatus()).as(String.valueOf(body)).isEqualTo(400);
            assertThat(json(result).path("error").asString()).as(String.valueOf(body)).isEqualTo("bad_request");
        }
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("회원은 403 {error:forbidden, message} — 서비스가 한 번 더 막음(경로 등급은 AccessPolicy)")
    void memberIs403() throws Exception {
        MvcResult result = call(MEMBER, "{\"e\":\"us:SYNT\",\"tab\":\"news\",\"range\":\"7d\"}");
        assertThat(result.getResponse().getStatus()).isEqualTo(403);
        assertThat(json(result).path("error").asString()).isEqualTo("forbidden");
        assertThat(json(result).path("message").asString()).contains("운영자");
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("하루 글자 상한을 넘으면 429 {error:too_many_requests, message} + Retry-After(다음 KST 자정까지)")
    void budgetIs429() throws Exception {
        feedWithOneRow();
        when(translations.charsSince(any())).thenReturn(1_000_000L);

        MvcResult result = call(OWNER, "{\"e\":\"us:SYNT\",\"tab\":\"news\",\"range\":\"7d\"}");

        assertThat(result.getResponse().getStatus()).isEqualTo(429);
        assertThat(json(result).path("error").asString()).isEqualTo("too_many_requests");
        assertThat(json(result).path("message").asString()).contains("상한");
        assertThat(result.getResponse().getHeader("Retry-After")).isEqualTo(String.valueOf(12 * 3600));
    }
}
