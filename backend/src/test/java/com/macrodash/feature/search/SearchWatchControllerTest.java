package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.SearchExcludeStore;
import com.macrodash.support.CurrentUser;
import com.macrodash.web.ApiExceptionHandler;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 관심 대상·매체 제외 경로(계약 §6-4) — 컨트롤러가 요청의 사용자와 본문을 서비스에 넘기고, 결과의 상태 코드를 그대로 쓰는지. 경로 등급(회원·운영자)과
 * 데모의 쓰기 금지는 세션 필터가 {@code AccessPolicy}·데모 규칙으로 먼저 막으므로 여기서는 서비스의 이중 방어만 봅니다.
 */
class SearchWatchControllerTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser OTHER = new CurrentUser(8, null, "MEMBER", "FREE", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);

    private SearchWatchServiceTest.MemoryWatchStore watches;
    private SearchExcludeStore excludes;
    private CollectorClient collector;
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        watches = new SearchWatchServiceTest.MemoryWatchStore();
        excludes = mock(SearchExcludeStore.class);
        when(excludes.ready()).thenReturn(true);
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        collector = mock(CollectorClient.class);
        SearchWatchService service = new SearchWatchService(watches, excludes, store, collector,
                new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z")));
        mvc = MockMvcBuilders.standaloneSetup(new SearchWatchController(service))
                .setControllerAdvice(new ApiExceptionHandler())
                .build();
    }

    private JsonNode call(MockHttpServletRequestBuilder request, CurrentUser user, int status) throws Exception {
        MvcResult result = mvc.perform(request.requestAttr(CurrentUser.ATTRIBUTE, user)).andReturn();
        assertThat(result.getResponse().getStatus()).as(result.getRequest().getRequestURI()).isEqualTo(status);
        String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return body.isEmpty() ? MAPPER.nullNode() : MAPPER.readTree(body);
    }

    private static MockHttpServletRequestBuilder json(MockHttpServletRequestBuilder request, String body) {
        return request.contentType(MediaType.APPLICATION_JSON).content(body);
    }

    @Test
    @DisplayName("등록 → 목록 → 봤음 → 지우기가 한 바퀴 돈다. 남의 줄은 404")
    void watchRoundTrip() throws Exception {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(MAPPER.readTree(
                "{\"entity\":{\"key\":\"us:NVDA\",\"kind\":\"company\",\"name\":\"엔비디아\",\"aliases\":[\"NVIDIA\",\"엔비디아\"],"
                        + "\"ids\":{\"ticker\":\"NVDA\"}}}")));

        JsonNode created = call(json(post("/api/search/watch"), "{\"key\":\"us:NVDA\"}"), MEMBER, 200);
        assertThat(created.path("ok").asBoolean()).isTrue();
        assertThat(created.path("created").asBoolean()).isTrue();
        long id = created.path("item").path("id").asLong();

        JsonNode list = call(get("/api/search/watch"), MEMBER, 200);
        assertThat(list.path("available").asBoolean()).isTrue();
        assertThat(list.path("items").get(0).path("key").asString()).isEqualTo("us:NVDA");
        assertThat(list.path("limits").path("max").asInt()).isEqualTo(10);
        assertThat(list.get("collecting").isNull()).as("수집기에 닿지 못하면 모름").isTrue();

        assertThat(call(post("/api/search/watch/" + id + "/seen"), OTHER, 404).path("ok").asBoolean()).isFalse();
        assertThat(call(delete("/api/search/watch/" + id), OTHER, 404).path("ok").asBoolean()).isFalse();
        assertThat(call(post("/api/search/watch/" + id + "/seen"), MEMBER, 200).path("ok").asBoolean()).isTrue();
        assertThat(call(delete("/api/search/watch/" + id), MEMBER, 200).path("ok").asBoolean()).isTrue();
        assertThat(call(get("/api/search/watch"), MEMBER, 200).path("items").size()).isZero();
    }

    @Test
    @DisplayName("본문이 없거나 키가 틀리면 400 {error:bad_request}, 번호가 숫자가 아니면 400")
    void badRequests() throws Exception {
        assertThat(call(post("/api/search/watch"), MEMBER, 400).path("error").asString()).isEqualTo("bad_request");
        assertThat(call(json(post("/api/search/watch"), "{}"), MEMBER, 400).path("error").asString()).isEqualTo("bad_request");
        assertThat(call(json(post("/api/search/watch"), "{\"key\":\"NVDA\"}"), MEMBER, 400).path("error").asString())
                .isEqualTo("bad_request");
        assertThat(call(delete("/api/search/watch/abc"), MEMBER, 400).path("error").asString()).isEqualTo("bad_request");
        assertThat(watches.rows).isEmpty();
    }

    @Test
    @DisplayName("상한을 넘으면 409와 사유")
    void limitIs409() throws Exception {
        for (int i = 0; i < SearchWatchService.MEMBER_WATCHES; i++) {
            watches.seed(MEMBER.id(), "topic:주제" + i);
        }
        JsonNode body = call(json(post("/api/search/watch"), "{\"key\":\"topic:넘침\"}"), MEMBER, 409);
        assertThat(body.path("ok").asBoolean()).isFalse();
        assertThat(body.path("reason").asString()).isEqualTo("user_limit");
        assertThat(body.path("message").asString()).isNotBlank();
    }

    @Test
    @DisplayName("매체 제외 — 목록은 회원도 읽고, 더하기·지우기는 운영자만(회원은 403)")
    void excludes() throws Exception {
        when(collector.liveSearchExcludes()).thenReturn(Optional.of(MAPPER.readTree("{\"seed\":[]}")));
        when(excludes.all()).thenReturn(List.of());
        JsonNode list = call(get("/api/search/excludes"), MEMBER, 200);
        assertThat(list.path("available").asBoolean()).isTrue();
        assertThat(list.path("added").isArray()).isTrue();

        assertThat(call(json(post("/api/search/excludes"), "{\"kind\":\"domain\",\"value\":\"example.test\"}"), MEMBER, 403)
                .path("ok").asBoolean()).isFalse();
        assertThat(call(delete("/api/search/excludes/3"), MEMBER, 403).path("ok").asBoolean()).isFalse();

        when(excludes.insert("domain", "example.test", "합성")).thenReturn(Optional.of(
                new SearchExcludeStore.Exclude(3, "domain", "example.test", "합성", Instant.parse("2026-11-14T03:00:00Z"))));
        JsonNode added = call(json(post("/api/search/excludes"), "{\"kind\":\"domain\",\"value\":\"https://Example.test/\",\"note\":\"합성\"}"),
                OWNER, 200);
        assertThat(added.path("item").path("value").asString()).isEqualTo("example.test");
        assertThat(call(json(post("/api/search/excludes"), "{\"kind\":\"domain\",\"value\":\"example.test/news\"}"), OWNER, 400)
                .path("error").asString()).isEqualTo("bad_request");
        assertThat(call(post("/api/search/excludes"), OWNER, 400).path("error").asString()).isEqualTo("bad_request");

        when(excludes.delete(3)).thenReturn(1);
        assertThat(call(delete("/api/search/excludes/3"), OWNER, 200).path("ok").asBoolean()).isTrue();
        assertThat(call(delete("/api/search/excludes/4"), OWNER, 404).path("ok").asBoolean()).isFalse();
    }
}
