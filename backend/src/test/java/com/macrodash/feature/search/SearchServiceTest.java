package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 정보 검색의 중계(SearchService, 계약 docs/specs/2026-11-14-info-search-contract.md §3) — 입력 검사(400), 데모·store_only면 external=false,
 * 운영자면 owner=true, 글·논평 탭은 운영자만(403), 회원에게서 운영자 전용 줄(info·guru·wire)을 한 번 더 지움, 수집기 응답에 available:true.
 *
 * <p>수집기 응답은 구조만 흉내 낸 합성 표본입니다(ADR 0026 결정 12).
 */
class SearchServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    /** 2026-11-14 12:00 KST. */
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-14T03:00:00Z"), ZoneOffset.UTC);

    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser PRO = new CurrentUser(8, null, "MEMBER", "PRO", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);
    private static final CurrentUser DEMO = new CurrentUser(-1, null, "MEMBER", "PRO", null, true);

    private StoreReader store;
    private CollectorClient collector;
    private SearchService service;

    @BeforeEach
    void setUp() {
        store = mock(StoreReader.class);
        collector = mock(CollectorClient.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        service = new SearchService(store, collector, CLOCK);
    }

    private static JsonNode json(String text) {
        return MAPPER.readTree(text);
    }

    // ------------------------------------------------------------------ 입력 검사

    @Test
    @DisplayName("검색어 — 앞뒤 공백을 지운 뒤 1~60자(코드 포인트로 셈), 비거나 넘으면 400")
    void queryLength() {
        assertThat(SearchService.query("  엔비디아 ")).isEqualTo("엔비디아");
        assertThat(SearchService.query("가".repeat(60))).hasSize(60);
        // 보조 평면 글자도 한 글자로 셉니다(수집기의 Python len과 같게).
        assertThat(SearchService.query("𝐀".repeat(60))).isNotNull();
        for (String bad : new String[]{null, "", "   ", "가".repeat(61), "a".repeat(61)}) {
            assertThatThrownBy(() -> SearchService.query(bad)).as(String.valueOf(bad)).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("대상 키 — us:티커(대문자·숫자·.·-) · kr:6자리 · cik:10자리 · wd:Q+숫자 · topic:1~60자, 그 밖은 400")
    void entityKeys() {
        for (String ok : List.of("us:NVDA", "us:BRK-B", "us:BRK.B", "kr:005930", "cik:0001067983", "wd:Q3195170", "wd:Q182477",
                "topic:AI 반도체", "topic:" + "가".repeat(60))) {
            assertThat(SearchService.entityKey(ok)).as(ok).isEqualTo(ok);
        }
        assertThat(SearchService.entityKey("  us:NVDA ")).isEqualTo("us:NVDA");
        assertThat(SearchService.entityKey("topic:  AI 반도체  ")).as("주제 글은 앞뒤 공백을 지움").isEqualTo("topic:AI 반도체");
        assertThat(SearchService.entityKey("topic:AI   반도체\u3000공급")).as("가운데 공백은 하나로 — 수집기 clean_query와 같은 키")
                .isEqualTo("topic:AI 반도체 공급");
        assertThat(SearchService.entityKey("topic:\u00a0fed\u202f")).as("줄바꿈 없는 공백도 앞뒤에서 지움").isEqualTo("topic:fed");
        assertThat(SearchService.entityKey("topic:\u0085x ")).isEqualTo("topic:x");
        for (String blank : new String[]{"topic:\u00a0", "topic:\u0085", "topic:\u2007\u202f"}) {
            assertThatThrownBy(() -> SearchService.entityKey(blank)).as(blank).isInstanceOf(InvalidRequestException.class);
        }
        // 수집기 문법과 같게(티커 15자까지, QID는 0으로 시작하지 않음, 제어 글자 없음) — 수집기의 400이 '응답 없음'으로 바뀌지 않게.
        assertThat(SearchService.entityKey("us:" + "A".repeat(15))).isEqualTo("us:" + "A".repeat(15));
        for (String bad : new String[]{"us:" + "A".repeat(16), "wd:Q0123", "topic:AI\u0007반도체", "topic:줄\n바꿈"}) {
            assertThatThrownBy(() -> SearchService.entityKey(bad)).as(bad).isInstanceOf(InvalidRequestException.class);
        }
        for (String bad : new String[]{null, "", "  ", "NVDA", "us:", "us:nvda", "us:NV DA", "us:^VIX", "us:" + "A".repeat(25),
                "US:NVDA", "kr:5930", "kr:0059300", "kr:0088M0", "cik:1067983", "cik:00010679830", "wd:3195170", "wd:q3195170",
                "wd:Q", "wd:QABC", "topic:", "topic:   ", "topic:" + "가".repeat(61), "jp:7203", "us:NVDA;rm"}) {
            assertThatThrownBy(() -> SearchService.entityKey(bad)).as(String.valueOf(bad)).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("탭 — timeline·news·posts·filings·research, 비면 timeline, 그 밖은 400")
    void tabs() {
        for (String ok : List.of("timeline", "news", "posts", "filings", "research")) {
            assertThat(SearchService.tab(ok)).isEqualTo(ok);
        }
        assertThat(SearchService.tab(null)).isEqualTo("timeline");
        assertThat(SearchService.tab(" ")).isEqualTo("timeline");
        for (String bad : new String[]{"holdings", "links", "NEWS", "news ;", "all"}) {
            assertThatThrownBy(() -> SearchService.tab(bad)).as(bad).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("입력이 틀리면 수집기를 부르지 않는다")
    void invalidInputDoesNotCallCollector() {
        assertThatThrownBy(() -> service.suggest(" ", MEMBER)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.resolve("a".repeat(61), MEMBER)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.entity("us:nvda", MEMBER)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.feed("us:NVDA", "holdings", MEMBER)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.feed("bad", "news", OWNER)).isInstanceOf(InvalidRequestException.class);
        verifyNoInteractions(collector);
    }

    // ------------------------------------------------------------------ external · owner

    @Test
    @DisplayName("회원·유료 회원은 external=true·owner=false, 운영자는 owner=true")
    void flagsByUser() {
        when(collector.liveSearchSuggest(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        service.suggest(" 엔비디아 ", MEMBER);
        verify(collector).liveSearchSuggest("엔비디아", true, false);
        service.resolve("Ken Griffin", PRO);
        verify(collector).liveSearchResolve("Ken Griffin", true, false);
        service.entity("wd:Q3195170", OWNER);
        verify(collector).liveSearchEntity("wd:Q3195170", true, true);
        service.feed("us:NVDA", "news", MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false);
        service.feed("kr:005930", null, OWNER);
        verify(collector).liveSearchFeed("kr:005930", "timeline", true, true);
    }

    @Test
    @DisplayName("데모 열람은 외부를 부르지 않는다(external=false) — 수집기는 저장본·캐시만으로 답함")
    void demoIsOffline() {
        when(collector.liveSearchSuggest(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        service.suggest("NVDA", DEMO);
        verify(collector).liveSearchSuggest("NVDA", false, false);
        service.resolve("NVDA", DEMO);
        verify(collector).liveSearchResolve("NVDA", false, false);
        service.entity("us:NVDA", DEMO);
        verify(collector).liveSearchEntity("us:NVDA", false, false);
        service.feed("us:NVDA", "timeline", DEMO);
        verify(collector).liveSearchFeed("us:NVDA", "timeline", false, false);
    }

    @Test
    @DisplayName("store_only 읽기 모드도 external=false — 운영자여도 외부를 부르지 않는다(available:false로 막지는 않음)")
    void storeOnlyIsOffline() {
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(service.feed("us:NVDA", "news", OWNER)).containsEntry("available", true);
        verify(collector).liveSearchFeed("us:NVDA", "news", false, true);
        service.resolve("NVDA", MEMBER);
        verify(collector).liveSearchResolve("NVDA", false, false);
    }

    @Test
    @DisplayName("사용자가 없으면(필터 밖) 운영자도 아니고 외부도 부르지 않는다")
    void missingUserIsConservative() {
        when(collector.liveSearchSuggest(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        service.suggest("NVDA", null);
        verify(collector).liveSearchSuggest("NVDA", false, false);
        assertThatThrownBy(() -> service.feed("us:NVDA", "posts", null)).isInstanceOf(ResponseStatusException.class);
    }

    // ------------------------------------------------------------------ 글·논평 탭

    @Test
    @DisplayName("글·논평 탭(posts)은 운영자만 — 회원·유료 회원·데모는 403이고 수집기를 부르지 않는다")
    void postsIsOwnerOnly() {
        for (CurrentUser user : List.of(MEMBER, PRO, DEMO)) {
            assertThatThrownBy(() -> service.feed("us:NVDA", "posts", user))
                    .isInstanceOfSatisfying(ResponseStatusException.class,
                            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        }
        verifyNoInteractions(collector);

        when(collector.liveSearchFeed("us:NVDA", "posts", true, true)).thenReturn(Optional.of(json(
                "{\"entityKey\":\"us:NVDA\",\"tab\":\"posts\",\"items\":[{\"id\":\"a\",\"source\":\"info\",\"readerId\":\"r1\"}]}")));
        Map<String, Object> out = service.feed("us:NVDA", "posts", OWNER);
        assertThat(out).containsEntry("available", true);
        assertThat(((JsonNode) out.get("items")).get(0).path("readerId").asString()).isEqualTo("r1");
    }

    // ------------------------------------------------------------------ 중계

    @Test
    @DisplayName("수집기 응답의 칸을 그대로 두고 available:true를 더한다")
    void relaysWithAvailable() {
        JsonNode payload = json("{\"items\":[{\"key\":\"us:NVDA\",\"kind\":\"company\",\"name\":\"엔비디아\",\"sub\":\"NVDA · 미국\","
                + "\"source\":\"sec\"}],\"fetchedAt\":\"2026-11-14T03:00:00+00:00\"}");
        when(collector.liveSearchSuggest("엔비디아", true, false)).thenReturn(Optional.of(payload));

        Map<String, Object> out = service.suggest("엔비디아", MEMBER);

        assertThat(out.keySet()).containsExactly("available", "items", "fetchedAt");
        assertThat(out).containsEntry("available", true);
        assertThat(out.get("items")).isEqualTo(payload.get("items"));
        assertThat(out.get("fetchedAt")).isEqualTo(payload.get("fetchedAt"));
    }

    @Test
    @DisplayName("수집기에 닿지 못하거나 객체가 아닌 응답이면 available:false와 상세 화면과 같은 말")
    void collectorUnavailable() {
        when(collector.liveSearchEntity("us:NVDA", true, false)).thenReturn(Optional.empty());
        assertThat(service.entity("us:NVDA", MEMBER))
                .containsExactly(Map.entry("available", false), Map.entry("message", "수집기에서 응답을 받지 못했습니다."));

        when(collector.liveSearchFeed("us:NVDA", "news", true, false)).thenReturn(Optional.of(json("[1,2]")));
        assertThat(service.feed("us:NVDA", "news", MEMBER))
                .containsEntry("available", false).containsEntry("message", "수집기에서 응답을 받지 못했습니다.");

        when(collector.liveSearchResolve("NVDA", true, false)).thenReturn(Optional.of(json("null")));
        assertThat(service.resolve("NVDA", MEMBER)).containsEntry("available", false);
    }

    @Test
    @DisplayName("수집기가 available 칸을 보내도 백엔드의 true가 앞에 하나만 남는다")
    void availableIsOurs() {
        when(collector.liveSearchResolve("NVDA", true, false)).thenReturn(Optional.of(json("{\"available\":false,\"items\":[]}")));
        Map<String, Object> out = service.resolve("NVDA", MEMBER);
        assertThat(out.keySet()).containsExactly("available", "items");
        assertThat(out).containsEntry("available", true);
    }

    // ------------------------------------------------------------------ 운영자 전용 줄(이중 방어)

    private static final String FEED = """
            {
              "entityKey": "us:NVDA",
              "tab": "timeline",
              "items": [
                {"id": "n1", "kind": "news", "title": "합성 제목 1", "source": "google_ko", "publishedAt": "2026-11-13T01:00:00+00:00",
                 "timeBasis": "published", "readerId": null},
                {"id": "w1", "kind": "wire", "title": "합성 속보", "source": "wire", "publishedAt": "2026-11-12T01:00:00+00:00",
                 "timeBasis": "published", "readerId": null},
                {"id": "i1", "kind": "post", "title": "합성 글", "source": "info", "publishedAt": "2026-09-01T01:00:00+00:00",
                 "timeBasis": "published", "readerId": "info-77"},
                {"id": "g1", "kind": "opinion", "title": "합성 견해", "source": "guru", "publishedAt": "2025-03-01T01:00:00+00:00",
                 "timeBasis": "published", "readerId": null},
                {"id": "n2", "kind": "news", "title": "합성 제목 2", "source": "bing", "publishedAt": "2025-12-01T01:00:00+00:00",
                 "timeBasis": "published", "readerId": "stray-1"}
              ],
              "sources": [
                {"source": "google_ko", "label": "구글 뉴스(한국어)", "status": "ok", "count": 1,
                 "dropped": {"old": 2, "noTime": 0, "chinese": 1, "excluded": 0}, "message": null},
                {"source": "wire", "label": "속보", "status": "ok", "count": 1,
                 "dropped": {"old": 0, "noTime": 3, "chinese": 0, "excluded": 0}, "message": "합성 안내"},
                {"source": "info", "label": "수집 글", "status": "error", "count": 1,
                 "dropped": {"old": 1, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "합성 사유"},
                {"source": "guru", "label": "거장 견해", "status": "ok", "count": 1,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null}
              ],
              "window": {"from": "2024-11-14", "to": "2026-11-14"},
              "rangeCounts": {"7d": 2, "30d": 2, "1y": 4, "2y": 5},
              "olderOnlyLatest": null,
              "pending": false,
              "fetchedAt": "2026-11-14T03:00:00+00:00"
            }
            """;

    @Test
    @DisplayName("회원에게는 운영자 전용 줄(info·guru·wire)을 지우고 그 상태 줄은 owner_only·0건, 받은 건수도 맞춘다")
    void hidesOwnerOnlyRowsFromMembers() {
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false)).thenReturn(Optional.of(json(FEED)));

        Map<String, Object> out = service.feed("us:NVDA", "timeline", MEMBER);

        assertThat(out).containsEntry("available", true);
        JsonNode items = (JsonNode) out.get("items");
        assertThat(items.values().stream().map(item -> item.path("id").asString()).toList()).containsExactly("n1", "n2");
        assertThat(items.values()).allSatisfy(item -> assertThat(item.get("readerId").isNull()).as("원문 팝업 id는 운영자에게만").isTrue());

        JsonNode sources = (JsonNode) out.get("sources");
        assertThat(sources.get(0).path("status").asString()).isEqualTo("ok");
        assertThat(sources.get(0).path("count").asInt()).isEqualTo(1);
        assertThat(sources.get(0).path("dropped").path("old").asInt()).as("공개 출처는 그대로").isEqualTo(2);
        for (int i = 1; i <= 3; i++) {
            JsonNode row = sources.get(i);
            assertThat(row.path("status").asString()).as(row.path("source").asString()).isEqualTo("owner_only");
            assertThat(row.path("count").asInt()).isZero();
            assertThat(row.get("message").isNull()).isTrue();
            for (String key : List.of("old", "noTime", "chinese", "excluded")) {
                assertThat(row.path("dropped").path(key).asInt()).isZero();
            }
            assertThat(row.path("label").asString()).as("이름은 그대로").isNotBlank();
        }

        // 지운 줄: 속보(2일 전 — 7일·30일·1년·2년), 수집 글(74일 전 — 1년·2년), 거장 견해(1년 8개월 전 — 2년).
        JsonNode counts = (JsonNode) out.get("rangeCounts");
        assertThat(counts.path("7d").asInt()).isEqualTo(1);
        assertThat(counts.path("30d").asInt()).isEqualTo(1);
        assertThat(counts.path("1y").asInt()).isEqualTo(2);
        assertThat(counts.path("2y").asInt()).isEqualTo(2);

        assertThat(out.get("window")).isEqualTo(json(FEED).get("window"));
        assertThat(out.get("pending")).isEqualTo(json(FEED).get("pending"));
    }

    @Test
    @DisplayName("운영자에게는 아무것도 지우지 않는다")
    void ownerSeesEverything() {
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, true)).thenReturn(Optional.of(json(FEED)));

        Map<String, Object> out = service.feed("us:NVDA", "timeline", OWNER);

        JsonNode original = json(FEED);
        for (String key : List.of("items", "sources", "rangeCounts", "window", "olderOnlyLatest", "pending", "fetchedAt", "entityKey", "tab")) {
            assertThat(out.get(key)).as(key).isEqualTo(original.get(key));
        }
    }

    @Test
    @DisplayName("데모도 회원과 같이 운영자 전용 줄을 지운다")
    void demoIsFilteredToo() {
        when(collector.liveSearchFeed("us:NVDA", "news", false, false)).thenReturn(Optional.of(json(FEED)));
        JsonNode items = (JsonNode) service.feed("us:NVDA", "news", DEMO).get("items");
        assertThat(items.values().stream().map(item -> item.path("source").asString()).toList()).containsExactly("google_ko", "bing");
    }

    @Test
    @DisplayName("받은 건수 칸이 없거나 숫자가 아니면 손대지 않고, 0 밑으로 내리지 않는다")
    void rangeCountsAreLeftAloneWhenUnknown() {
        String feed = """
                {"items": [{"id": "w1", "source": "wire", "publishedAt": "2026-11-13T01:00:00+00:00"},
                           {"id": "w2", "source": "wire", "publishedAt": null}],
                 "sources": [],
                 "rangeCounts": {"7d": null, "30d": 0, "1y": "?", "2y": 1}}
                """;
        when(collector.liveSearchFeed("us:NVDA", "news", true, false)).thenReturn(Optional.of(json(feed)));
        Map<String, Object> out = service.feed("us:NVDA", "news", MEMBER);
        JsonNode counts = (JsonNode) out.get("rangeCounts");
        assertThat(counts.get("7d").isNull()).isTrue();
        assertThat(counts.path("30d").asInt()).isZero();
        assertThat(counts.get("1y").asString()).isEqualTo("?");
        assertThat(counts.path("2y").asInt()).isZero();
        assertThat(((JsonNode) out.get("items")).size()).isZero();

        when(collector.liveSearchFeed("us:AAPL", "news", true, false)).thenReturn(Optional.of(json("{\"items\":[{\"source\":\"guru\"}]}")));
        Map<String, Object> bare = service.feed("us:AAPL", "news", MEMBER);
        assertThat(((JsonNode) bare.get("items")).size()).isZero();
        assertThat(bare).doesNotContainKey("rangeCounts");
    }

    private static final String MALFORMED_FEED = """
            {"items": [{"id": "n1", "source": "google_ko", "publishedAt": "2026-11-13T01:00:00+00:00"},
                       {"id": "x1", "publishedAt": "2026-11-13T02:00:00+00:00"},
                       {"id": "x2", "source": null, "publishedAt": "2026-11-12T02:00:00+00:00"},
                       {"id": "x3", "source": 7, "publishedAt": "2026-11-11T02:00:00+00:00"},
                       null,
                       "합성 줄"],
             "sources": [{"label": "출처 칸 없는 상태 줄", "status": "ok", "count": 1},
                         {"source": null, "label": "출처가 null인 상태 줄", "status": "ok", "count": 2},
                         null,
                         {"source": "google_ko", "label": "구글 뉴스(한국어)", "status": "ok", "count": 1}],
             "rangeCounts": {"7d": 4, "30d": 4, "1y": 4, "2y": 6}}
            """;

    @Test
    @DisplayName("출처 칸이 없거나 문자열이 아닌 줄이 섞여도 회원 응답이 500이 되지 않고, 그 줄은 회원에게서 지운다(닫힌 실패)")
    void malformedRowsDoNotBreakMemberFeed() {
        when(collector.liveSearchFeed("us:NVDA", "news", true, false)).thenReturn(Optional.of(json(MALFORMED_FEED)));

        Map<String, Object> out = service.feed("us:NVDA", "news", MEMBER);

        assertThat(out).containsEntry("available", true);
        JsonNode items = (JsonNode) out.get("items");
        assertThat(items.size()).as("출처를 모르는 줄은 운영자 전용인지 알 수 없어 회원에게 보이지 않음").isEqualTo(1);
        assertThat(items.get(0).path("id").asString()).isEqualTo("n1");
        assertThat(out.get("sources")).as("출처 칸이 없는 상태 줄은 그대로 둠").isEqualTo(json(MALFORMED_FEED).get("sources"));
        // 지운 줄: 시각 있는 셋(7일 안)은 모든 기간에서, 시각 없는 둘(null·글)은 2년에서만 뺌.
        JsonNode counts = (JsonNode) out.get("rangeCounts");
        for (String key : List.of("7d", "30d", "1y", "2y")) {
            assertThat(counts.path(key).asInt()).as(key).isEqualTo(1);
        }
    }

    @Test
    @DisplayName("출처 칸이 이상한 줄도 운영자에게는 그대로 간다")
    void malformedRowsReachOwnerUnchanged() {
        when(collector.liveSearchFeed("us:NVDA", "news", true, true)).thenReturn(Optional.of(json(MALFORMED_FEED)));
        Map<String, Object> out = service.feed("us:NVDA", "news", OWNER);
        JsonNode original = json(MALFORMED_FEED);
        for (String key : List.of("items", "sources", "rangeCounts")) {
            assertThat(out.get(key)).as(key).isEqualTo(original.get(key));
        }
    }

    @Test
    @DisplayName("후보·대상 풀기는 거르지 않는다 — 후보의 source 'guru'(거장 목록)는 회원 자료")
    void suggestionsAreNotFiltered() {
        JsonNode payload = json("{\"items\":[{\"key\":null,\"kind\":\"person\",\"name\":\"합성 거장\",\"sub\":\"거장\",\"source\":\"guru\"}]}");
        when(collector.liveSearchSuggest("합성", true, false)).thenReturn(Optional.of(payload));
        assertThat(service.suggest("합성", MEMBER).get("items")).isEqualTo(payload.get("items"));
    }

    @Test
    @DisplayName("수집기 응답 객체를 고치지 않는다(같은 객체를 다시 받아도 결과가 같음)")
    void doesNotMutateCollectorPayload() {
        JsonNode payload = json(FEED);
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false)).thenReturn(Optional.of(payload));
        service.feed("us:NVDA", "timeline", MEMBER);
        assertThat(payload).isEqualTo(json(FEED));
    }

    // ------------------------------------------------------------------ 첫 화면 최근 글 (계약 §6-4)

    private static final String RECENT = """
            {"items": [
               {"id": "f1", "kind": "headline", "title": "합성 보도자료", "source": "feeds", "publishedAt": "2026-11-14T01:00:00+00:00",
                "timeBasis": "published", "readerId": null},
               {"id": "w1", "kind": "wire", "title": "합성 속보", "source": "wire", "publishedAt": "2026-11-14T02:00:00+00:00",
                "timeBasis": "published", "readerId": null},
               {"id": "f2", "kind": "headline", "title": "합성 경제지", "source": "feeds", "publishedAt": null,
                "timeBasis": "fetched", "readerId": "stray"}],
             "fetchedAt": "2026-11-14T03:00:00+00:00"}
            """;

    @Test
    @DisplayName("첫 화면 최근 글 — 수집기 저장본을 중계하고, 회원에게서는 속보(운영자 전용) 줄을 지운다. 운영자는 그대로")
    void recentRelaysAndHidesWire() {
        when(collector.liveSearchRecent(false)).thenReturn(Optional.of(json(RECENT)));
        when(collector.liveSearchRecent(true)).thenReturn(Optional.of(json(RECENT)));

        Map<String, Object> member = service.recent(MEMBER);
        assertThat(member).containsEntry("available", true);
        JsonNode items = (JsonNode) member.get("items");
        assertThat(items.values().stream().map(item -> item.path("id").asString()).toList()).containsExactly("f1", "f2");
        assertThat(items.get(1).get("readerId").isNull()).isTrue();
        assertThat(member.get("fetchedAt")).isEqualTo(json(RECENT).get("fetchedAt"));
        verify(collector).liveSearchRecent(false);

        Map<String, Object> owner = service.recent(OWNER);
        assertThat(owner.get("items")).isEqualTo(json(RECENT).get("items"));
        verify(collector).liveSearchRecent(true);

        assertThat(service.recent(DEMO)).containsEntry("available", true);
        when(collector.liveSearchRecent(false)).thenReturn(Optional.empty());
        assertThat(service.recent(MEMBER)).containsEntry("available", false).containsEntry("message", "수집기에서 응답을 받지 못했습니다.");
    }

    // ------------------------------------------------------------------ 지금 새로 받기 (feed?refresh=1)

    @Test
    @DisplayName("지금 새로 받기는 사용자마다 10분에 한 번 — 넘으면 캐시 그대로 부르고 refreshNote에 안내(새로 받았으면 null), 10분 뒤 다시 됨")
    void refreshIsRateLimitedPerUser() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));

        Map<String, Object> first = limited.feed("us:NVDA", "news", true, MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, true);
        assertThat(first).containsEntry("refreshNote", null);

        clock.advance(java.time.Duration.ofMinutes(9));
        Map<String, Object> second = limited.feed("kr:005930", "timeline", true, MEMBER);
        verify(collector).liveSearchFeed("kr:005930", "timeline", true, false);
        assertThat(refreshNote(second)).contains("10분").contains("받아 둔 결과");

        Map<String, Object> other = limited.feed("us:AAPL", "news", true, PRO);
        verify(collector).liveSearchFeed("us:AAPL", "news", true, false, true);
        assertThat(other).as("다른 사용자는 따로 셈").containsEntry("refreshNote", null);

        clock.advance(java.time.Duration.ofMinutes(1).plusSeconds(1));
        assertThat(limited.feed("us:NVDA", "timeline", true, MEMBER)).containsEntry("refreshNote", null);
        verify(collector).liveSearchFeed("us:NVDA", "timeline", true, false, true);

        Map<String, Object> plain = limited.feed("us:NVDA", "timeline", false, MEMBER);
        assertThat(plain).as("새로 받기를 묻지 않으면 칸 없음").doesNotContainKey("refreshNote");
    }

    @Test
    @DisplayName("데모·store_only는 새로 받지 않는다 — 외부를 부르지 않는 모드라 refreshNote에 안내, 한도도 쓰지 않음")
    void refreshIsIgnoredOffline() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        Map<String, Object> demo = service.feed("us:NVDA", "news", true, DEMO);
        verify(collector).liveSearchFeed("us:NVDA", "news", false, false);
        assertThat(refreshNote(demo)).contains("외부를 부르지 않는");

        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        assertThat(refreshNote(service.feed("us:NVDA", "news", true, OWNER))).isNotBlank();
        verify(collector).liveSearchFeed("us:NVDA", "news", false, true);
        verify(collector, org.mockito.Mockito.never()).liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean());

        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));
        assertThat(service.feed("us:NVDA", "news", true, OWNER)).as("앞의 거절이 한도를 쓰지 않음").containsEntry("refreshNote", null);
    }

    @Test
    @DisplayName("수집기에 닿지 못해도 새로 받기 안내는 붙는다(available:false 응답에도)")
    void refreshNoteOnFailure() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean())).thenReturn(Optional.empty());
        Map<String, Object> out = service.feed("us:NVDA", "news", true, MEMBER);
        assertThat(out).containsEntry("available", false);
        assertThat(out).containsEntry("refreshNote", null);
    }

    @Test
    @DisplayName("수집기에 닿지 못한 새로 받기는 10분 한 번을 쓰지 않는다 — 곧바로 다시 누르면 다시 새로 받음")
    void failedRefreshDoesNotSpendTheAllowance() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.empty(), Optional.of(json("{\"items\":[]}")), Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(limited.feed("us:NVDA", "news", true, MEMBER)).containsEntry("available", false).containsEntry("refreshNote", null);
        clock.advance(java.time.Duration.ofSeconds(30));
        assertThat(limited.feed("us:NVDA", "news", true, MEMBER)).as("실패한 앞 요청은 한도를 쓰지 않음")
                .containsEntry("available", true).containsEntry("refreshNote", null);
        clock.advance(java.time.Duration.ofSeconds(30));
        assertThat(refreshNote(limited.feed("us:NVDA", "news", true, MEMBER))).as("성공한 새로 받기는 한도를 씀").contains("10분");
        verify(collector, org.mockito.Mockito.times(2)).liveSearchFeed("us:NVDA", "news", true, false, true);
    }

    private static String refreshNote(Map<String, Object> out) {
        assertThat(out).containsKey("refreshNote");
        assertThat(out.get("refreshNote")).isInstanceOf(String.class);
        return (String) out.get("refreshNote");
    }
}
