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
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.IntConsumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 정보 검색의 중계(SearchService, 계약 docs/specs/2026-11-14-info-search-contract.md §3) — 입력 검사(400), 데모·store_only면 external=false,
 * 운영자면 owner=true, 글·논평 탭은 운영자만(403), 회원에게서 운영자 전용 줄(info·guru·wire)을 한 번 더 지움, 수집기 응답에 available:true,
 * Finviz를 새로 줄에 넣는 횟수의 사용자당 한 시간 한도(계약 §8-5).
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
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        service.suggest(" 엔비디아 ", MEMBER);
        verify(collector).liveSearchSuggest("엔비디아", true, false);
        service.resolve("Ken Griffin", PRO);
        verify(collector).liveSearchResolve("Ken Griffin", true, false);
        service.entity("wd:Q3195170", OWNER);
        verify(collector).liveSearchEntity("wd:Q3195170", true, true);
        service.feed("us:NVDA", "news", MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, false, true);
        service.feed("kr:005930", null, OWNER);
        verify(collector).liveSearchFeed("kr:005930", "timeline", true, true, false, false);
    }

    @Test
    @DisplayName("데모 열람은 외부를 부르지 않는다(external=false) — 수집기는 저장본·캐시만으로 답함")
    void demoIsOffline() {
        when(collector.liveSearchSuggest(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        service.suggest("NVDA", DEMO);
        verify(collector).liveSearchSuggest("NVDA", false, false);
        service.resolve("NVDA", DEMO);
        verify(collector).liveSearchResolve("NVDA", false, false);
        service.entity("us:NVDA", DEMO);
        verify(collector).liveSearchEntity("us:NVDA", false, false);
        service.feed("us:NVDA", "timeline", DEMO);
        verify(collector).liveSearchFeed("us:NVDA", "timeline", false, false, false, false);
    }

    @Test
    @DisplayName("결과는 그 사용자가 그 대상을 관심 대상으로 등록했으면 그 줄의 별칭을 aliases로 넘긴다(계약 §9-4) — 등록하지 않은 대상·남의 줄·표가 없을 때는 인자 없이")
    void feedPassesWatchAliases() {
        SearchWatchServiceTest.MemoryWatchStore watches = new SearchWatchServiceTest.MemoryWatchStore();
        Instant at = CLOCK.instant();
        watches.rows.add(new com.macrodash.store.SearchWatchStore.Watch(1, MEMBER.id(), "us:NVDA", "company", "엔비디아",
                List.of("NVIDIA", "엔비디아", "합성 별칭"), null, at, at));
        SearchService withWatches = new SearchService(store, collector, watches, CLOCK);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(withWatches.feed("us:NVDA", "news", MEMBER)).containsEntry("available", true);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, false, true, List.of("NVIDIA", "엔비디아", "합성 별칭"));

        withWatches.feed("us:AAPL", "timeline", MEMBER);
        verify(collector).liveSearchFeed("us:AAPL", "timeline", true, false, false, true);
        withWatches.feed("us:NVDA", "filings", PRO);
        verify(collector).liveSearchFeed("us:NVDA", "filings", true, false, false, false);
        withWatches.feed("us:NVDA", "timeline", DEMO);
        verify(collector).liveSearchFeed("us:NVDA", "timeline", false, false, false, false);

        watches.ready = false;
        withWatches.feed("us:NVDA", "research", MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "research", true, false, false, false);
        verify(collector, org.mockito.Mockito.times(1)).liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(),
                anyBoolean(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    @DisplayName("wd: 키로 연 대상도 그 사용자가 대표 키(us: 등)로 등록한 줄의 식별자 wikidata가 같으면 그 줄의 별칭을 넘긴다(화면이 별칭 편집을 보이는 줄과 같음) — "
            + "60자 넘는 별칭·제어 글자가 든 별칭은 빼고, 남는 것이 없으면 인자 없이. 남의 줄은 쓰지 않음")
    void feedPassesAliasesForWikidataKeyAndDropsUnusable() {
        SearchWatchServiceTest.MemoryWatchStore watches = new SearchWatchServiceTest.MemoryWatchStore();
        Instant at = CLOCK.instant();
        tools.jackson.databind.node.ObjectNode nvda = tools.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("wikidata", "Q182477");
        tools.jackson.databind.node.ObjectNode other = tools.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("wikidata", "Q95");
        tools.jackson.databind.node.ObjectNode longOnly = tools.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("wikidata", "Q312");
        watches.rows.add(new com.macrodash.store.SearchWatchStore.Watch(1, MEMBER.id(), "us:NVDA", "company", "엔비디아",
                List.of("NVIDIA", "가".repeat(61), "합성\u0085별칭", "합성 별칭"), nvda, at, at));
        watches.rows.add(new com.macrodash.store.SearchWatchStore.Watch(2, PRO.id(), "us:GOOGL", "company", "알파벳",
                List.of("Alphabet"), other, at, at));
        watches.rows.add(new com.macrodash.store.SearchWatchStore.Watch(3, MEMBER.id(), "us:AAPL", "company", "애플",
                List.of("가".repeat(100)), longOnly, at, at));
        SearchService withWatches = new SearchService(store, collector, watches, CLOCK);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean(),
                org.mockito.ArgumentMatchers.any())).thenReturn(Optional.of(json("{\"items\":[]}")));

        withWatches.feed("wd:Q182477", "filings", MEMBER);
        verify(collector).liveSearchFeed("wd:Q182477", "filings", true, false, false, false, List.of("NVIDIA", "합성 별칭"));
        withWatches.feed("us:NVDA", "research", MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "research", true, false, false, false, List.of("NVIDIA", "합성 별칭"));

        withWatches.feed("wd:Q95", "filings", MEMBER);
        verify(collector).liveSearchFeed("wd:Q95", "filings", true, false, false, false);
        withWatches.feed("us:AAPL", "filings", MEMBER);
        verify(collector).liveSearchFeed("us:AAPL", "filings", true, false, false, false);
        withWatches.feed("wd:Q312", "research", MEMBER);
        verify(collector).liveSearchFeed("wd:Q312", "research", true, false, false, false);
    }

    @Test
    @DisplayName("관심 대상 별칭을 읽지 못하면(DB 오류) 별칭 없이 그대로 부른다 — 결과를 막지 않음")
    void feedWithoutAliasesWhenWatchStoreFails() {
        com.macrodash.store.SearchWatchStore broken = org.mockito.Mockito.mock(com.macrodash.store.SearchWatchStore.class);
        when(broken.ready()).thenReturn(true);
        when(broken.find(org.mockito.ArgumentMatchers.anyLong(), anyString()))
                .thenThrow(new org.springframework.dao.DataAccessResourceFailureException("합성 실패"));
        SearchService withBroken = new SearchService(store, collector, broken, CLOCK);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(withBroken.feed("us:NVDA", "news", MEMBER)).containsEntry("available", true);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, false, true);
    }

    @Test
    @DisplayName("store_only 읽기 모드도 external=false — 운영자여도 외부를 부르지 않는다(available:false로 막지는 않음)")
    void storeOnlyIsOffline() {
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchResolve(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(service.feed("us:NVDA", "news", OWNER)).containsEntry("available", true);
        verify(collector).liveSearchFeed("us:NVDA", "news", false, true, false, false);
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

        when(collector.liveSearchFeed("us:NVDA", "posts", true, true, false, false)).thenReturn(Optional.of(json(
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

        when(collector.liveSearchFeed("us:NVDA", "news", true, false, false, true)).thenReturn(Optional.of(json("[1,2]")));
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
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false, false, true)).thenReturn(Optional.of(json(FEED)));

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
    @DisplayName("같은 사건 묶음 칸(clusterId·cluster)은 회원에게도 그대로 넘기고, 지운 운영자 전용 줄을 가리키던 줄의 묶음 칸만 비운다(닫힌 실패)")
    void clusterFieldsSurviveAndPointersToRemovedRowsAreCleared() {
        String feed = """
                {"entityKey": "us:NVDA", "tab": "timeline", "items": [
                  {"id": "n1", "kind": "news", "title": "합성 기사 하나", "source": "google_en", "publishedAt": "2026-11-13T03:00:00+00:00",
                   "clusterId": "n2", "cluster": null},
                  {"id": "n2", "kind": "news", "title": "합성 기사 하나 다른 매체", "source": "bing", "publishedAt": "2026-11-13T01:00:00+00:00",
                   "clusterId": "n2", "cluster": {"size": 2, "publishers": 2}},
                  {"id": "n3", "kind": "news", "title": "합성 기사 둘", "source": "google_en", "publishedAt": "2026-11-12T03:00:00+00:00",
                   "clusterId": "w1", "cluster": null},
                  {"id": "w1", "kind": "wire", "title": "합성 속보", "source": "wire", "publishedAt": "2026-11-12T01:00:00+00:00",
                   "clusterId": "w1", "cluster": {"size": 2, "publishers": 2}}],
                 "sources": [], "rangeCounts": {"7d": 4, "30d": 4, "1y": 4, "2y": 4}, "pending": false}
                """;
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false, false, true)).thenReturn(Optional.of(json(feed)));

        JsonNode items = (JsonNode) service.feed("us:NVDA", "timeline", MEMBER).get("items");

        assertThat(items.values().stream().map(item -> item.path("id").asString()).toList()).containsExactly("n1", "n2", "n3");
        assertThat(items.get(0).path("clusterId").asString()).as("정상 묶음은 그대로").isEqualTo("n2");
        assertThat(items.get(1).path("cluster").path("size").asInt()).isEqualTo(2);
        assertThat(items.get(2).get("clusterId").isNull()).as("지운 줄(대표)을 가리키던 줄은 비움 — 운영자 전용 줄의 id가 남지 않게").isTrue();
        assertThat(items.get(2).get("cluster").isNull()).isTrue();
    }

    @Test
    @DisplayName("운영자에게는 아무것도 지우지 않는다")
    void ownerSeesEverything() {
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, true, false, true)).thenReturn(Optional.of(json(FEED)));

        Map<String, Object> out = service.feed("us:NVDA", "timeline", OWNER);

        JsonNode original = json(FEED);
        for (String key : List.of("items", "sources", "rangeCounts", "window", "olderOnlyLatest", "pending", "fetchedAt", "entityKey", "tab")) {
            assertThat(out.get(key)).as(key).isEqualTo(original.get(key));
        }
    }

    @Test
    @DisplayName("데모도 회원과 같이 운영자 전용 줄을 지운다")
    void demoIsFilteredToo() {
        when(collector.liveSearchFeed("us:NVDA", "news", false, false, false, false)).thenReturn(Optional.of(json(FEED)));
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
        when(collector.liveSearchFeed("us:NVDA", "news", true, false, false, true)).thenReturn(Optional.of(json(feed)));
        Map<String, Object> out = service.feed("us:NVDA", "news", MEMBER);
        JsonNode counts = (JsonNode) out.get("rangeCounts");
        assertThat(counts.get("7d").isNull()).isTrue();
        assertThat(counts.path("30d").asInt()).isZero();
        assertThat(counts.get("1y").asString()).isEqualTo("?");
        assertThat(counts.path("2y").asInt()).isZero();
        assertThat(((JsonNode) out.get("items")).size()).isZero();

        when(collector.liveSearchFeed("us:AAPL", "news", true, false, false, true)).thenReturn(Optional.of(json("{\"items\":[{\"source\":\"guru\"}]}")));
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
        when(collector.liveSearchFeed("us:NVDA", "news", true, false, false, true)).thenReturn(Optional.of(json(MALFORMED_FEED)));

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
        when(collector.liveSearchFeed("us:NVDA", "news", true, true, false, true)).thenReturn(Optional.of(json(MALFORMED_FEED)));
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
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false, false, true)).thenReturn(Optional.of(payload));
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
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(true), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));

        Map<String, Object> first = limited.feed("us:NVDA", "news", true, MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, true, true);
        assertThat(first).containsEntry("refreshNote", null);

        clock.advance(java.time.Duration.ofMinutes(9));
        Map<String, Object> second = limited.feed("kr:005930", "timeline", true, MEMBER);
        verify(collector).liveSearchFeed("kr:005930", "timeline", true, false, false, false);
        assertThat(refreshNote(second)).contains("10분").contains("받아 둔 결과");

        Map<String, Object> other = limited.feed("us:AAPL", "news", true, PRO);
        verify(collector).liveSearchFeed("us:AAPL", "news", true, false, true, true);
        assertThat(other).as("다른 사용자는 따로 셈").containsEntry("refreshNote", null);

        clock.advance(java.time.Duration.ofMinutes(1).plusSeconds(1));
        assertThat(limited.feed("us:NVDA", "timeline", true, MEMBER)).containsEntry("refreshNote", null);
        verify(collector).liveSearchFeed("us:NVDA", "timeline", true, false, true, true);

        Map<String, Object> plain = limited.feed("us:NVDA", "timeline", false, MEMBER);
        assertThat(plain).as("새로 받기를 묻지 않으면 칸 없음").doesNotContainKey("refreshNote");
    }

    @Test
    @DisplayName("데모·store_only는 새로 받지 않는다 — 외부를 부르지 않는 모드라 refreshNote에 안내, 한도도 쓰지 않음")
    void refreshIsIgnoredOffline() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        Map<String, Object> demo = service.feed("us:NVDA", "news", true, DEMO);
        verify(collector).liveSearchFeed("us:NVDA", "news", false, false, false, false);
        assertThat(refreshNote(demo)).contains("외부를 부르지 않는");

        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        assertThat(refreshNote(service.feed("us:NVDA", "news", true, OWNER))).isNotBlank();
        verify(collector).liveSearchFeed("us:NVDA", "news", false, true, false, false);
        verify(collector, org.mockito.Mockito.never()).liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(true), anyBoolean());

        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(true), anyBoolean()))
                .thenReturn(Optional.of(json("{\"items\":[]}")));
        assertThat(service.feed("us:NVDA", "news", true, OWNER)).as("앞의 거절이 한도를 쓰지 않음").containsEntry("refreshNote", null);
    }

    @Test
    @DisplayName("수집기에 닿지 못해도 새로 받기 안내는 붙는다(available:false 응답에도)")
    void refreshNoteOnFailure() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(true), anyBoolean())).thenReturn(Optional.empty());
        Map<String, Object> out = service.feed("us:NVDA", "news", true, MEMBER);
        assertThat(out).containsEntry("available", false);
        assertThat(out).containsEntry("refreshNote", null);
    }

    @Test
    @DisplayName("수집기에 닿지 못한 새로 받기는 10분 한 번을 쓰지 않는다 — 곧바로 다시 누르면 다시 새로 받음")
    void failedRefreshDoesNotSpendTheAllowance() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(true), anyBoolean()))
                .thenReturn(Optional.empty(), Optional.of(json("{\"items\":[]}")), Optional.of(json("{\"items\":[]}")));
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json("{\"items\":[]}")));

        assertThat(limited.feed("us:NVDA", "news", true, MEMBER)).containsEntry("available", false).containsEntry("refreshNote", null);
        clock.advance(java.time.Duration.ofSeconds(30));
        assertThat(limited.feed("us:NVDA", "news", true, MEMBER)).as("실패한 앞 요청은 한도를 쓰지 않음")
                .containsEntry("available", true).containsEntry("refreshNote", null);
        clock.advance(java.time.Duration.ofSeconds(30));
        assertThat(refreshNote(limited.feed("us:NVDA", "news", true, MEMBER))).as("성공한 새로 받기는 한도를 씀").contains("10분");
        verify(collector, org.mockito.Mockito.times(2)).liveSearchFeed("us:NVDA", "news", true, false, true, true);
    }

    private static String refreshNote(Map<String, Object> out) {
        assertThat(out).containsKey("refreshNote");
        assertThat(out.get("refreshNote")).isInstanceOf(String.class);
        return (String) out.get("refreshNote");
    }

    // ------------------------------------------------------------------ 단계 4 — 공시·리서치 출처는 회원에게도 (계약 §7-2·7-3·7-8)

    private static final String FILINGS_FEED = """
            {
              "entityKey": "us:NVDA",
              "tab": "timeline",
              "items": [
                {"id": "s1", "kind": "filing", "title": "8-K · 합성 설명", "url": "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm",
                 "publisher": "합성 회사", "publisherDomain": "sec.gov", "publishedAt": "2026-11-13T21:05:00+00:00",
                 "timeBasis": "published", "source": "sec", "lang": "en", "summary": "보고 기준일 2026-11-12", "readerId": null},
                {"id": "s2", "kind": "filing", "title": "4 · 합성 제출자", "url": "https://www.sec.gov/Archives/edgar/data/2/000000000226000002/0000000002-26-000002-index.htm",
                 "publisher": "합성 제출자", "publisherDomain": "sec.gov", "publishedAt": "2026-11-12T05:00:00+00:00",
                 "timeBasis": "date", "source": "sec_fts", "lang": "en", "summary": "합성 설명", "readerId": null},
                {"id": "d1", "kind": "filing", "title": "합성 주요사항보고서", "url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261112000001",
                 "publisher": "합성 제출인", "publisherDomain": "dart.fss.or.kr", "publishedAt": "2026-11-11T15:00:00+00:00",
                 "timeBasis": "date", "source": "dart", "lang": "ko", "summary": "비고 유", "readerId": "stray-2"},
                {"id": "y1", "kind": "research", "title": "합성 증권: 상향 Hold → Buy", "url": "https://finance.yahoo.com/quote/NVDA/analysis/",
                 "publisher": "합성 증권", "publisherDomain": null, "publishedAt": "2026-10-01T13:00:00+00:00",
                 "timeBasis": "published", "source": "yahoo_research", "lang": "en", "summary": "목표가 100 → 120", "readerId": null},
                {"id": "r1", "kind": "research", "title": "합성 리포트", "url": "https://finance.naver.com/research/",
                 "publisher": "합성 증권사", "publisherDomain": null, "publishedAt": "2025-06-01T15:00:00+00:00",
                 "timeBasis": "date", "source": "naver_research", "lang": "ko", "summary": null, "readerId": null},
                {"id": "w1", "kind": "wire", "title": "합성 속보", "source": "wire", "publishedAt": "2026-11-13T22:00:00+00:00",
                 "timeBasis": "published", "readerId": null}
              ],
              "sources": [
                {"source": "sec", "label": "SEC 공시(회사별)", "status": "ok", "count": 1,
                 "dropped": {"old": 4, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "최근 1,000건만 — 그 앞은 SEC에서"},
                {"source": "sec_fts", "label": "SEC 전문 검색(이름)", "status": "cached", "count": 1,
                 "dropped": {"old": 0, "noTime": 1, "chinese": 0, "excluded": 0}, "message": null},
                {"source": "dart", "label": "DART 공시", "status": "ok", "count": 1,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "최근 200건(전체 345건 — 그 앞은 DART에서)"},
                {"source": "yahoo_research", "label": "투자의견 변경(Yahoo)", "status": "ok", "count": 1,
                 "dropped": {"old": 2, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null},
                {"source": "naver_research", "label": "증권사 리포트(네이버)", "status": "error", "count": 1,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "합성 사유"},
                {"source": "wire", "label": "속보", "status": "ok", "count": 1,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null}
              ],
              "window": {"from": "2024-11-14", "to": "2026-11-14"},
              "rangeCounts": {"7d": 4, "30d": 4, "1y": 5, "2y": 6},
              "olderOnlyLatest": null,
              "pending": false,
              "fetchedAt": "2026-11-14T03:00:00+00:00"
            }
            """;

    @Test
    @DisplayName("공시·리서치 출처(sec·sec_fts·dart·yahoo_research·naver_research)의 줄과 상태 줄은 회원에게도 그대로 — 운영자 전용 줄만 지운다")
    void filingAndResearchSourcesReachMembers() {
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false, false, true)).thenReturn(Optional.of(json(FILINGS_FEED)));

        Map<String, Object> out = service.feed("us:NVDA", "timeline", MEMBER);

        JsonNode original = json(FILINGS_FEED);
        JsonNode items = (JsonNode) out.get("items");
        assertThat(items.values().stream().map(item -> item.path("source").asString()).toList())
                .containsExactly("sec", "sec_fts", "dart", "yahoo_research", "naver_research");
        for (int i = 0; i < 5; i++) {
            JsonNode row = items.get(i);
            JsonNode before = original.get("items").get(i);
            for (String key : List.of("id", "kind", "title", "url", "publisher", "publisherDomain", "publishedAt", "timeBasis", "lang", "summary")) {
                assertThat(row.get(key)).as(before.path("source").asString() + "." + key).isEqualTo(before.get(key));
            }
            assertThat(row.get("readerId").isNull()).as("원문 팝업 id는 운영자에게만").isTrue();
        }
        assertThat(items.get(2).path("timeBasis").asString()).as("날짜만 아는 출처의 시각 칸(계약 §7-1)").isEqualTo("date");

        JsonNode sources = (JsonNode) out.get("sources");
        for (int i = 0; i < 5; i++) {
            assertThat(sources.get(i)).as(sources.get(i).path("source").asString()).isEqualTo(original.get("sources").get(i));
        }
        assertThat(sources.get(5).path("status").asString()).isEqualTo("owner_only");

        // 지운 줄은 속보 하나(오늘 — 모든 기간에서 뺌).
        JsonNode counts = (JsonNode) out.get("rangeCounts");
        assertThat(counts.path("7d").asInt()).isEqualTo(3);
        assertThat(counts.path("30d").asInt()).isEqualTo(3);
        assertThat(counts.path("1y").asInt()).isEqualTo(4);
        assertThat(counts.path("2y").asInt()).isEqualTo(5);
    }

    @Test
    @DisplayName("공시·리서치 탭도 회원이 부를 수 있다(403 아님) — 데모는 external=false")
    void filingsAndResearchTabsAreMemberTabs() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), eq(false), anyBoolean())).thenReturn(Optional.of(json(FILINGS_FEED)));

        assertThat(service.feed("kr:005930", "filings", MEMBER)).containsEntry("available", true);
        verify(collector).liveSearchFeed("kr:005930", "filings", true, false, false, false);
        assertThat(service.feed("us:NVDA", "research", PRO)).containsEntry("available", true);
        verify(collector).liveSearchFeed("us:NVDA", "research", true, false, false, false);
        assertThat(service.feed("cik:0001067983", "filings", DEMO)).containsEntry("available", true);
        verify(collector).liveSearchFeed("cik:0001067983", "filings", false, false, false, false);
    }

    // ------------------------------------------------------------------ 연결 보강 (계약 §7-5·7-8)

    private static final String LINKS = """
            {
              "entityKey": "us:NVDA",
              "links": [
                {"relation": "insider", "key": null, "name": "합성 임원", "kind": "person", "source": "yahoo",
                 "detail": "합성 직함 · 최근 합성 거래 2026-10-01"},
                {"relation": "ultimate_parent", "key": null, "name": "합성 지주", "kind": "company", "source": "gleif",
                 "detail": "US · LEI 00000000000000000000"},
                {"relation": "subsidiary", "key": null, "name": "합성 자회사", "kind": "company", "source": "gleif", "detail": null}
              ],
              "sources": [
                {"source": "insiders", "label": "내부자 명단(Yahoo)", "status": "ok", "count": 1,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null},
                {"source": "gleif", "label": "법인 관계(GLEIF)", "status": "ok", "count": 2,
                 "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "자회사 20곳까지(전체 31곳)"}
              ],
              "fetchedAt": "2026-11-14T03:00:00+00:00"
            }
            """;

    @Test
    @DisplayName("연결 보강(/links)은 수집기 응답에 available:true를 더해 그대로 중계한다 — 회원에게도 거르지 않음")
    void linksRelay() {
        when(collector.liveSearchLinks("us:NVDA", true, false)).thenReturn(Optional.of(json(LINKS)));

        Map<String, Object> out = service.links(" us:NVDA ", MEMBER);

        assertThat(out.keySet()).containsExactly("available", "entityKey", "links", "sources", "fetchedAt");
        assertThat(out).containsEntry("available", true);
        JsonNode original = json(LINKS);
        for (String key : List.of("entityKey", "links", "sources", "fetchedAt")) {
            assertThat(out.get(key)).as(key).isEqualTo(original.get(key));
        }
        verify(collector).liveSearchLinks("us:NVDA", true, false);
    }

    @Test
    @DisplayName("연결 보강 — 운영자는 owner=true, 데모·store_only·사용자 없음은 external=false, 주제 키는 수집기와 같은 모양으로")
    void linksFlags() {
        when(collector.liveSearchLinks(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json(LINKS)));

        service.links("wd:Q182477", OWNER);
        verify(collector).liveSearchLinks("wd:Q182477", true, true);
        service.links("us:NVDA", DEMO);
        verify(collector).liveSearchLinks("us:NVDA", false, false);
        service.links("kr:005930", null);
        verify(collector).liveSearchLinks("kr:005930", false, false);
        service.links("topic:  AI   반도체 ", MEMBER);
        verify(collector).liveSearchLinks("topic:AI 반도체", true, false);

        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        assertThat(service.links("cik:0001067983", OWNER)).containsEntry("available", true);
        verify(collector).liveSearchLinks("cik:0001067983", false, true);
    }

    @Test
    @DisplayName("연결 보강 — 키가 틀리면 400이고 수집기를 부르지 않으며, 수집기에 닿지 못하면 available:false와 사유")
    void linksInvalidAndUnavailable() {
        for (String bad : new String[]{null, "", "NVDA", "us:nvda", "wd:Q0123", "topic:"}) {
            assertThatThrownBy(() -> service.links(bad, MEMBER)).as(String.valueOf(bad)).isInstanceOf(InvalidRequestException.class);
        }
        verifyNoInteractions(collector);

        when(collector.liveSearchLinks("us:NVDA", true, false)).thenReturn(Optional.empty());
        assertThat(service.links("us:NVDA", MEMBER))
                .containsExactly(Map.entry("available", false), Map.entry("message", "수집기에서 응답을 받지 못했습니다."));
        when(collector.liveSearchLinks("us:AAPL", true, false)).thenReturn(Optional.of(json("[]")));
        assertThat(service.links("us:AAPL", MEMBER)).containsEntry("available", false);
    }

    @Test
    @DisplayName("연결 보강 — 수집기 응답 객체를 고치지 않는다")
    void linksDoNotMutatePayload() {
        JsonNode payload = json(LINKS);
        when(collector.liveSearchLinks("us:NVDA", true, false)).thenReturn(Optional.of(payload));
        service.links("us:NVDA", MEMBER);
        assertThat(payload).isEqualTo(json(LINKS));
    }

    // ------------------------------------------------------------------ 단계 5 — Finviz 종목 뉴스 (계약 §8-4·8-5)

    /** 이 요청이 Finviz를 새로 줄에 넣었다고 수집기가 답한 응답(받는 중). {@code QUEUED} 자리에 참·거짓을 넣습니다. */
    private static final String FINVIZ_PENDING = """
            {"entityKey": "us:NVDA", "tab": "news",
             "items": [{"id": "n1", "kind": "news", "title": "합성 제목", "source": "google_en", "publishedAt": "2026-11-13T01:00:00+00:00",
                        "timeBasis": "published", "readerId": null}],
             "sources": [{"source": "google_en", "label": "구글 뉴스(영어)", "status": "ok", "count": 1,
                          "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null},
                         {"source": "finviz", "label": "Finviz 종목 뉴스", "status": "pending", "count": 0,
                          "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": "받는 중 — 몇 초 뒤 채움"}],
             "rangeCounts": {"7d": 1, "30d": 1, "1y": 1, "2y": 1},
             "pending": true, "finvizQueued": QUEUED, "fetchedAt": "2026-11-14T03:00:00+00:00"}
            """;

    /** 30분 캐시에서 채운 Finviz 줄(회원에게도 보임 — D-1). */
    private static final String FINVIZ_CACHED = """
            {"entityKey": "us:NVDA", "tab": "timeline",
             "items": [{"id": "fz1", "kind": "news", "title": "합성 Finviz 제목", "url": "https://example.com/a", "publisher": "합성 매체",
                        "publisherDomain": "example.com", "publishedAt": "2026-11-13T04:24:00+00:00", "timeBasis": "published",
                        "source": "finviz", "lang": "en", "summary": null, "readerId": null},
                       {"id": "w1", "kind": "wire", "title": "합성 속보", "source": "wire", "publishedAt": "2026-11-13T22:00:00+00:00",
                        "timeBasis": "published", "readerId": null}],
             "sources": [{"source": "finviz", "label": "Finviz 종목 뉴스", "status": "cached", "count": 1,
                          "dropped": {"old": 3, "noTime": 0, "chinese": 0, "excluded": 1}, "message": null},
                         {"source": "wire", "label": "속보", "status": "ok", "count": 1,
                          "dropped": {"old": 0, "noTime": 0, "chinese": 0, "excluded": 0}, "message": null}],
             "rangeCounts": {"7d": 2, "30d": 2, "1y": 2, "2y": 2},
             "pending": false, "finvizQueued": false, "fetchedAt": "2026-11-14T03:00:00+00:00"}
            """;

    private static String finvizPending(boolean queued) {
        return FINVIZ_PENDING.replace("QUEUED", String.valueOf(queued));
    }

    /**
     * 수집기 흉내 — 부를 때마다 넘긴 finviz 인자를 적고, 줄에 넣어도 된다고 했을 때만 새로 넣었다고 답합니다(한도 안의 실제 수집기처럼).
     * {@code during}은 응답하기 전에(요청이 수집기에 가 있는 동안) 몇 번째 부름인지를 받아 할 일입니다.
     */
    private List<Boolean> fakeFinvizCollector(IntConsumer during) {
        List<Boolean> seen = new ArrayList<>();
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    boolean finviz = call.getArgument(5);
                    seen.add(finviz);
                    if (during != null) {
                        during.accept(seen.size());
                    }
                    return Optional.of(json(finvizPending(finviz)));
                });
        return seen;
    }

    private static List<Boolean> repeat(boolean value, int times) {
        return Collections.nCopies(times, value);
    }

    private static List<Boolean> concat(List<Boolean> first, List<Boolean> second) {
        List<Boolean> out = new ArrayList<>(first);
        out.addAll(second);
        return out;
    }

    @Test
    @DisplayName("Finviz — 사용자마다 지난 1시간에 수집기가 새로 줄에 넣은(finvizQueued:true) 것이 10번이면 그다음은 finviz=0")
    void finvizLimitPerUserPerHour() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = fakeFinvizCollector(null);

        for (int i = 0; i < 10; i++) {
            assertThat(limited.feed("us:NVDA", i % 2 == 0 ? "news" : "timeline", MEMBER)).containsEntry("available", true);
            clock.advance(Duration.ofMinutes(1));
        }
        Map<String, Object> over = limited.feed("us:AAPL", "news", MEMBER);

        assertThat(seen).containsExactlyElementsOf(concat(repeat(true, 10), repeat(false, 1)));
        assertThat(over).as("한도를 넘어도 결과는 그대로 — 받아 둔 결과만(수집기가 skipped로 알림)").containsEntry("available", true);
        verify(collector).liveSearchFeed("us:AAPL", "news", true, false, false, false);
    }

    @Test
    @DisplayName("Finviz — 1시간이 지난 것은 세지 않는다(정확히 1시간 뒤면 빠짐)")
    void finvizWindowExpires() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = fakeFinvizCollector(null);

        for (int i = 0; i < 5; i++) {
            limited.feed("us:NVDA", "news", MEMBER);                // 03:00 다섯
        }
        clock.advance(Duration.ofMinutes(30));
        for (int i = 0; i < 5; i++) {
            limited.feed("us:NVDA", "news", MEMBER);                // 03:30 다섯 — 열
        }
        clock.advance(Duration.ofMinutes(29).plusSeconds(59));
        limited.feed("us:NVDA", "news", MEMBER);                    // 03:59:59 — 아직 열(거절)
        clock.advance(Duration.ofSeconds(1));
        for (int i = 0; i < 5; i++) {
            limited.feed("us:NVDA", "news", MEMBER);                // 04:00 — 03:00 다섯이 빠져 다섯 더
        }
        limited.feed("us:NVDA", "news", MEMBER);                    // 04:00 — 다시 열(거절)
        clock.advance(Duration.ofMinutes(30));
        limited.feed("us:NVDA", "news", MEMBER);                    // 04:30 — 03:30 다섯이 빠짐

        List<Boolean> expected = concat(repeat(true, 10), repeat(false, 1));
        expected = concat(expected, repeat(true, 5));
        expected = concat(expected, List.of(false, true));
        assertThat(seen).containsExactlyElementsOf(expected);
    }

    @Test
    @DisplayName("Finviz — 새로 넣지 않은 응답(finvizQueued:false·칸 없음·참이 아닌 값)과 수집기에 닿지 못한 요청은 세지 않는다")
    void finvizOnlyCountsQueuedTrue() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = new ArrayList<>();
        List<Optional<JsonNode>> answers = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            answers.add(Optional.of(json(finvizPending(false))));      // 캐시·같은 티커가 이미 줄에 있음(다시 부르기)
            answers.add(Optional.of(json("{\"items\":[]}")));         // 칸 없음(미국 종목이 아님)
            answers.add(Optional.of(json(FINVIZ_PENDING.replace("QUEUED", "\"true\""))));   // 참이 아닌 값(글)
            answers.add(Optional.empty());                              // 수집기에 닿지 못함
            answers.add(Optional.of(json("[1]")));                     // 객체가 아님
        }
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    seen.add(call.getArgument(5));
                    return answers.get(seen.size() - 1);
                });

        for (int i = 0; i < answers.size(); i++) {
            limited.feed("us:NVDA", "news", MEMBER);
            clock.advance(Duration.ofSeconds(5));
        }

        assertThat(seen).hasSize(60).containsOnly(true);
    }

    @Test
    @DisplayName("Finviz — 한도는 사용자마다 따로 센다(회원이 다 써도 다른 회원·운영자는 그대로)")
    void finvizLimitIsPerUser() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        fakeFinvizCollector(null);

        for (int i = 0; i < 10; i++) {
            limited.feed("us:NVDA", "news", MEMBER);
        }
        limited.feed("us:NVDA", "news", MEMBER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, false, false, false);

        limited.feed("us:AMD", "news", PRO);
        verify(collector).liveSearchFeed("us:AMD", "news", true, false, false, true);
        limited.feed("us:NVDA", "news", OWNER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, true, false, true);

        limited.feed("us:MSFT", "timeline", MEMBER);
        verify(collector).liveSearchFeed("us:MSFT", "timeline", true, false, false, false);
    }

    @Test
    @DisplayName("Finviz — 같은 사용자의 요청이 수집기에 가 있는 동안 온 요청도 그 자리를 센다(동시 요청 둘이 열한 번째를 넘기지 않음)")
    void finvizConcurrentRequestsShareTheLimit() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> nested = new ArrayList<>();
        List<Boolean> seen = fakeFinvizCollector(call -> {
            // 열 번째 요청이 수집기에 가 있는 동안 같은 사용자의 다른 요청이 옴(한 번만).
            if (call == 10) {
                nested.add(Boolean.TRUE);
                limited.feed("us:AAPL", "news", MEMBER);
            }
        });

        for (int i = 0; i < 10; i++) {
            limited.feed("us:NVDA", "news", MEMBER);
        }

        assertThat(nested).as("겹친 요청을 실제로 보냄").hasSize(1);
        assertThat(seen).as("열 번째가 자리를 잡은 동안 온 요청은 finviz=0").containsExactlyElementsOf(
                concat(repeat(true, 10), repeat(false, 1)));
        limited.feed("us:NVDA", "news", MEMBER);
        assertThat(seen.get(seen.size() - 1)).as("열 번째가 새로 넣었으므로 한도").isFalse();
    }

    @Test
    @DisplayName("Finviz — 새로 넣지 않은 요청이 잡았던 자리는 돌려준다(겹친 요청이 거절돼도 그다음은 다시 됨)")
    void finvizReservationIsReleasedWhenNotQueued() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = new ArrayList<>();
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    boolean finviz = call.getArgument(5);
                    seen.add(finviz);
                    if (seen.size() == 10) {
                        limited.feed("us:AAPL", "news", MEMBER);   // 열 번째가 가 있는 동안 — 자리가 없어 finviz=0
                        return Optional.of(json(finvizPending(false)));   // 열 번째는 새로 넣지 않음(캐시)
                    }
                    return Optional.of(json(finvizPending(finviz)));
                });

        for (int i = 0; i < 10; i++) {
            limited.feed("us:NVDA", "news", MEMBER);
        }
        limited.feed("us:NVDA", "news", MEMBER);

        assertThat(seen).containsExactlyElementsOf(concat(concat(repeat(true, 10), repeat(false, 1)), repeat(true, 1)));
    }

    @Test
    @DisplayName("Finviz — finviz=0으로 불렀는데 수집기가 새로 넣었다고 답해도 센다(한도가 그만큼 오래 감)")
    void finvizUnexpectedQueueIsCounted() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = new ArrayList<>();
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    seen.add(call.getArgument(5));
                    return Optional.of(json(finvizPending(true)));   // 늘 새로 넣었다고 답함(수집기 결함 흉내)
                });

        for (int i = 0; i < 10; i++) {
            limited.feed("us:NVDA", "news", MEMBER);               // 03:00 열
        }
        clock.advance(Duration.ofMinutes(30));
        for (int i = 0; i < 10; i++) {
            limited.feed("us:NVDA", "news", MEMBER);               // 03:30 — 거절이지만 수집기가 넣었다고 답함(열)
        }
        clock.advance(Duration.ofMinutes(30));
        limited.feed("us:NVDA", "news", MEMBER);                   // 04:00 — 03:30 열이 남아 거절
        clock.advance(Duration.ofMinutes(30));
        limited.feed("us:NVDA", "news", MEMBER);                   // 04:30 — 모두 빠짐

        assertThat(seen).containsExactlyElementsOf(concat(concat(repeat(true, 10), repeat(false, 11)), repeat(true, 1)));
    }

    @Test
    @DisplayName("Finviz — 붙지 않는 탭(공시·리서치·글)과 대상(kr:·topic:)은 finviz=0이고 자리를 잡지 않는다(그동안 온 뉴스 요청이 한도에 막히지 않음)")
    void finvizReservedOnlyWhereItApplies() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<String> seen = new ArrayList<>();
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    String key = call.getArgument(0);
                    String tab = call.getArgument(1);
                    boolean finviz = call.getArgument(5);
                    seen.add(key + " " + tab + " " + finviz);
                    if ("us:NVDA".equals(key) && "news".equals(tab)) {
                        return Optional.of(json(finvizPending(finviz)));   // 처음 아홉 — 새로 줄에 넣음
                    }
                    if (!"us:AAPL".equals(key)) {
                        // Finviz가 붙지 않는 요청이 수집기에 가 있는 동안 같은 사용자의 뉴스 요청이 옴(다른 브라우저 탭·빠른 탭 옮김).
                        limited.feed("us:AAPL", "news", OWNER);
                    }
                    return Optional.of(json(finvizPending(false)));        // 붙지 않는 요청·AAPL(이미 받아 둠)은 새로 넣지 않음
                });

        for (int i = 0; i < 9; i++) {
            limited.feed("us:NVDA", "news", OWNER);
        }
        limited.feed("us:NVDA", "filings", OWNER);
        limited.feed("us:NVDA", "research", OWNER);
        limited.feed("us:NVDA", "posts", OWNER);
        limited.feed("kr:005930", "news", OWNER);
        limited.feed("topic:AI 반도체", "timeline", OWNER);

        List<String> expected = new ArrayList<>(Collections.nCopies(9, "us:NVDA news true"));
        for (String other : List.of("us:NVDA filings", "us:NVDA research", "us:NVDA posts", "kr:005930 news", "topic:AI 반도체 timeline")) {
            expected.add(other + " false");
            expected.add("us:AAPL news true");
        }
        assertThat(seen).containsExactlyElementsOf(expected);
    }

    @Test
    @DisplayName("Finviz — 열 번째로 줄에 넣은 티커를 화면이 다시 부르면 finviz=0이어도 수집기의 pending(받는 중)이 그대로 가고 셈은 늘지 않는다")
    void finvizPollAfterTenthKeepsPending() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = new ArrayList<>();
        java.util.Set<String> queued = new java.util.HashSet<>();
        // 수집기 흉내(계약 §8-4·search_finviz.request의 순서) — 줄에 있으면 finviz 인자와 상관없이 pending, 새로 넣을 때만 finvizQueued:true,
        // finviz=0인데 줄에 없으면 skipped.
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenAnswer(call -> {
                    String key = call.getArgument(0);
                    boolean finviz = call.getArgument(5);
                    seen.add(finviz);
                    if (queued.contains(key)) {
                        return Optional.of(json(finvizPending(false)));
                    }
                    if (finviz) {
                        queued.add(key);
                        return Optional.of(json(finvizPending(true).replace("us:NVDA", key)));
                    }
                    return Optional.of(json(finvizPending(false).replace("\"status\": \"pending\"", "\"status\": \"skipped\"")
                            .replace("\"pending\": true", "\"pending\": false")));
                });

        for (int i = 0; i < 10; i++) {
            limited.feed("us:T" + i, "news", MEMBER);
            clock.advance(Duration.ofSeconds(5));
        }
        for (int poll = 0; poll < 12; poll++) {
            Map<String, Object> out = limited.feed("us:T9", "news", MEMBER);   // 화면이 5초마다 다시 부름
            assertThat(out.get("pending")).as("다시 부른 응답도 받는 중").isEqualTo(json("true"));
            assertThat(((JsonNode) out.get("sources")).get(1).path("status").asString()).isEqualTo("pending");
            assertThat(out).doesNotContainKey("finvizQueued");
            clock.advance(Duration.ofSeconds(5));
        }
        Map<String, Object> fresh = limited.feed("us:NEW", "news", MEMBER);

        assertThat(seen).as("열 번 뒤 다시 부르기는 finviz=0").containsExactlyElementsOf(concat(repeat(true, 10), repeat(false, 13)));
        assertThat(((JsonNode) fresh.get("sources")).get(1).path("status").asString()).as("한도 뒤 새 티커는 skipped").isEqualTo("skipped");
        clock.advance(Duration.ofMinutes(59));
        limited.feed("us:NEW", "news", MEMBER);
        assertThat(seen.get(seen.size() - 1)).as("다시 부르기는 셈을 늘리지 않아 첫 요청에서 1시간 뒤 풀림").isTrue();
    }

    @Test
    @DisplayName("Finviz — finvizQueued 칸은 화면에 넘기지 않는다(회원·운영자 모두), pending·Finviz 상태 줄은 그대로")
    void finvizQueuedIsStripped() {
        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json(finvizPending(true))));

        for (CurrentUser user : List.of(MEMBER, OWNER, DEMO)) {
            Map<String, Object> out = service.feed("us:NVDA", "news", user);
            assertThat(out).as(String.valueOf(user.id())).containsEntry("available", true).doesNotContainKey("finvizQueued");
            assertThat(out.get("pending")).isEqualTo(json("true"));
            JsonNode finviz = ((JsonNode) out.get("sources")).get(1);
            assertThat(finviz).isEqualTo(json(finvizPending(true)).get("sources").get(1));
        }

        when(collector.liveSearchFeed(anyString(), anyString(), anyBoolean(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(Optional.of(json(finvizPending(false))));
        assertThat(service.feed("us:NVDA", "news", MEMBER)).doesNotContainKey("finvizQueued");
        assertThat(service.feed("us:NVDA", "news", true, MEMBER)).doesNotContainKey("finvizQueued").containsKey("refreshNote");
    }

    @Test
    @DisplayName("Finviz — 줄과 상태 줄은 회원에게도 그대로 간다(운영자 전용 아님, D-1)")
    void finvizRowsReachMembers() {
        when(collector.liveSearchFeed("us:NVDA", "timeline", true, false, false, true)).thenReturn(Optional.of(json(FINVIZ_CACHED)));

        Map<String, Object> out = service.feed("us:NVDA", "timeline", MEMBER);

        JsonNode original = json(FINVIZ_CACHED);
        JsonNode items = (JsonNode) out.get("items");
        assertThat(items.size()).isEqualTo(1);
        assertThat(items.get(0)).isEqualTo(original.get("items").get(0));
        JsonNode sources = (JsonNode) out.get("sources");
        assertThat(sources.get(0)).isEqualTo(original.get("sources").get(0));
        assertThat(sources.get(1).path("status").asString()).isEqualTo("owner_only");
        assertThat(out).doesNotContainKey("finvizQueued");
        assertThat(((JsonNode) out.get("rangeCounts")).path("2y").asInt()).as("속보 하나만 뺌").isEqualTo(1);
    }

    @Test
    @DisplayName("Finviz — 데모·store_only·사용자 없음은 external=false라 finviz=0이고 한도를 쓰지 않는다")
    void finvizOfflineModes() {
        SearchWatchServiceTest.MutableClock clock = new SearchWatchServiceTest.MutableClock(Instant.parse("2026-11-14T03:00:00Z"));
        SearchService limited = new SearchService(store, collector, clock);
        List<Boolean> seen = fakeFinvizCollector(null);

        for (int i = 0; i < 12; i++) {
            limited.feed("us:NVDA", "news", DEMO);
        }
        limited.feed("us:NVDA", "news", null);
        verify(collector, org.mockito.Mockito.times(13)).liveSearchFeed("us:NVDA", "news", false, false, false, false);

        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        for (int i = 0; i < 12; i++) {
            limited.feed("us:NVDA", "news", OWNER);
        }
        verify(collector, org.mockito.Mockito.times(12)).liveSearchFeed("us:NVDA", "news", false, true, false, false);

        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        limited.feed("us:NVDA", "news", OWNER);
        verify(collector).liveSearchFeed("us:NVDA", "news", true, true, false, true);
        assertThat(seen).containsExactlyElementsOf(concat(repeat(false, 25), repeat(true, 1)));
    }
}
