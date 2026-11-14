package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.CurrentUser;
import com.macrodash.web.ApiExceptionHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 정보 검색 경로 네 개(계약 §3) — 컨트롤러가 요청의 사용자를 서비스에 넘기고, 400·403이 공통 오류 모양({@code {error, message}})으로 나가는지.
 * 경로 등급(회원)은 세션 필터가 {@code AccessPolicy}로 막으므로 여기서는 요청 속성의 사용자만 넣습니다.
 */
class SearchControllerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);

    private CollectorClient collector;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        collector = mock(CollectorClient.class);
        SearchService service = new SearchService(store, collector, Clock.systemUTC());
        mvc = MockMvcBuilders.standaloneSetup(new SearchController(service))
                .setControllerAdvice(new ApiExceptionHandler())
                .build();
    }

    private JsonNode call(String path, CurrentUser user, int status, String... params) throws Exception {
        var request = get(path).requestAttr(CurrentUser.ATTRIBUTE, user);
        for (int i = 0; i + 1 < params.length; i += 2) {
            request = request.param(params[i], params[i + 1]);
        }
        MvcResult result = mvc.perform(request).andReturn();
        assertThat(result.getResponse().getStatus()).as(path).isEqualTo(status);
        return MAPPER.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("네 경로가 수집기 응답에 available:true를 더해 돌려준다")
    void relaysFourRoutes() throws Exception {
        when(collector.liveSearchSuggest(anyString(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(MAPPER.readTree("{\"items\":[],\"fetchedAt\":\"2026-11-14T03:00:00+00:00\"}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(MAPPER.readTree("{\"items\":[],\"errors\":{}}")));
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(MAPPER.readTree("{\"entity\":null,\"errors\":{}}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(MAPPER.readTree("{\"entityKey\":\"us:NVDA\",\"tab\":\"news\",\"items\":[]}")));

        JsonNode suggest = call("/api/search/suggest", MEMBER, 200, "q", "엔비디아");
        assertThat(suggest.path("available").asBoolean()).isTrue();
        assertThat(suggest.path("fetchedAt").asString()).isEqualTo("2026-11-14T03:00:00+00:00");
        verify(collector).liveSearchSuggest("엔비디아", true, false);

        assertThat(call("/api/search/resolve", OWNER, 200, "q", "Ken Griffin").path("available").asBoolean()).isTrue();
        verify(collector).liveSearchResolve("Ken Griffin", true, true);

        assertThat(call("/api/search/entity", MEMBER, 200, "e", "topic:AI 반도체").has("entity")).isTrue();
        verify(collector).liveSearchEntity("topic:AI 반도체", true, false);

        JsonNode feed = call("/api/search/feed", MEMBER, 200, "e", "us:NVDA", "tab", "news");
        assertThat(feed.path("available").asBoolean()).isTrue();
        assertThat(feed.path("entityKey").asString()).isEqualTo("us:NVDA");
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false);
    }

    @Test
    @DisplayName("틀린 입력은 400 {error:bad_request, message}이고 수집기를 부르지 않는다")
    void badInputIs400() throws Exception {
        assertThat(call("/api/search/suggest", MEMBER, 400).path("error").asString()).isEqualTo("bad_request");
        assertThat(call("/api/search/resolve", MEMBER, 400, "q", "a".repeat(61)).path("message").asString()).isNotBlank();
        assertThat(call("/api/search/entity", MEMBER, 400, "e", "NVDA").path("error").asString()).isEqualTo("bad_request");
        assertThat(call("/api/search/feed", MEMBER, 400, "e", "us:NVDA", "tab", "holdings").path("error").asString())
                .isEqualTo("bad_request");
        assertThat(call("/api/search/feed", OWNER, 400, "tab", "news").path("error").asString()).isEqualTo("bad_request");
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("글·논평 탭을 회원이 부르면 403 {error:forbidden, message}")
    void postsForMemberIs403() throws Exception {
        JsonNode body = call("/api/search/feed", MEMBER, 403, "e", "us:NVDA", "tab", "posts");
        assertThat(body.path("error").asString()).isEqualTo("forbidden");
        assertThat(body.path("message").asString()).contains("운영자");
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 200 + available:false와 사유")
    void collectorDownIsAvailableFalse() throws Exception {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.empty());
        JsonNode body = call("/api/search/feed", OWNER, 200, "e", "cik:0001067983", "tab", "posts");
        assertThat(body.path("available").asBoolean()).isFalse();
        assertThat(body.path("message").asString()).isEqualTo("수집기에서 응답을 받지 못했습니다.");
    }
}
