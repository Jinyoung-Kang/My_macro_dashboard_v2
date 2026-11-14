package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.SearchExcludeStore;
import com.macrodash.store.SearchWatchStore;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.BrokenBarrierException;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 관심 대상·매체 제외 목록(ADR 0041 결정 9, 계약 §6-4) — 등록은 수집기의 대상 풀기로 이름·별칭·식별자를 채워 대표 키로 저장하고, 상한(회원 10·운영자 50·서버
 * 서로 다른 대상 100)은 세기부터 저장까지 한 줄로 지킨다. 데모는 쓰지 못하고, 남의 줄은 404, 회원의 새 글 수에는 운영자 전용 출처를 세지 않는다.
 * 매체 제외의 더하기·지우기는 운영자만, 도메인은 소문자 호스트로.
 *
 * <p>저장소는 메모리 흉내(알림 상한 시험 {@code AlertServiceConcurrencyTest}와 같은 방식), 수집기 응답은 구조만 흉내 낸 합성 표본입니다.
 */
class SearchWatchServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Instant NOW = Instant.parse("2026-11-14T03:00:00Z");

    private static final CurrentUser MEMBER = new CurrentUser(7, null, "MEMBER", "FREE", null);
    private static final CurrentUser OTHER = new CurrentUser(8, null, "MEMBER", "PRO", null);
    private static final CurrentUser OWNER = new CurrentUser(1, null, "OWNER", "PRO", null);
    private static final CurrentUser DEMO = new CurrentUser(-1, null, "MEMBER", "PRO", null, true);

    private MemoryWatchStore watches;
    private SearchExcludeStore excludes;
    private StoreReader store;
    private CollectorClient collector;
    private MutableClock clock;
    private SearchWatchService service;

    @BeforeEach
    void setUp() {
        watches = new MemoryWatchStore();
        excludes = mock(SearchExcludeStore.class);
        when(excludes.ready()).thenReturn(true);
        store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        collector = mock(CollectorClient.class);
        when(collector.liveSearchExcludes()).thenReturn(Optional.of(json("{\"seed\": [], \"politeEnabled\": false}")));
        clock = new MutableClock(NOW);
        service = new SearchWatchService(watches, excludes, store, collector, clock);
    }

    private static JsonNode json(String text) {
        return MAPPER.readTree(text);
    }

    private static JsonNode entity(String key, String kind, String name, String... aliases) {
        Map<String, Object> ids = new LinkedHashMap<>();
        ids.put("ticker", key.startsWith("us:") ? key.substring(3) : null);
        ids.put("market", key.startsWith("us:") ? "us" : null);
        ids.put("stockCode", null);
        ids.put("cik", null);
        ids.put("dartCorpCode", null);
        ids.put("wikidata", "Q182477");
        Map<String, Object> entity = new LinkedHashMap<>();
        entity.put("key", key);
        entity.put("kind", kind);
        entity.put("name", name);
        entity.put("aliases", List.of(aliases));
        entity.put("ids", ids);
        entity.put("links", List.of());
        return MAPPER.valueToTree(Map.of("entity", entity, "errors", Map.of()));
    }

    /** 대상 풀기 응답에 출처 오류 한 줄을 붙인 것(합성 사유). */
    private static JsonNode withError(JsonNode answer, String source) {
        ObjectNode copy = (ObjectNode) answer.deepCopy();
        copy.putObject("errors").put(source, "합성 사유");
        return copy;
    }

    private void resolves(String asked, JsonNode answer) {
        when(collector.liveSearchEntity(org.mockito.ArgumentMatchers.eq(asked), anyBoolean(), anyBoolean())).thenReturn(Optional.of(answer));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> item(SearchWatchService.Result result) {
        return (Map<String, Object>) result.body().get("item");
    }

    // ------------------------------------------------------------------ 등록

    @Test
    @DisplayName("등록은 수집기의 대상 풀기로 대표 키·이름·종류·별칭(12개까지, 빈 것·겹친 것 빼고)·식별자를 저장하고 200 + 새 줄")
    void registersRepresentativeKey() {
        String[] aliases = {"NVIDIA", "Nvidia", "엔비디아", "NVIDIA", " ", "NVIDIA Corporation", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"};
        resolves("wd:Q182477", entity("us:NVDA", "company", "엔비디아", aliases));

        SearchWatchService.Result result = service.add(MEMBER, " wd:Q182477 ");

        assertThat(result.status()).isEqualTo(200);
        assertThat(result.body()).containsEntry("ok", true).containsEntry("created", true);
        verify(collector).liveSearchEntity("wd:Q182477", true, false);
        assertThat(watches.rows).hasSize(1);
        SearchWatchStore.Watch row = watches.rows.get(0);
        assertThat(row.entityKey()).as("대표 키로 저장").isEqualTo("us:NVDA");
        assertThat(row.kind()).isEqualTo("company");
        assertThat(row.name()).isEqualTo("엔비디아");
        assertThat(row.aliases()).hasSize(SearchWatchService.MAX_ALIASES)
                .startsWith("NVIDIA", "Nvidia", "엔비디아", "NVIDIA Corporation").doesNotContain(" ").doesNotHaveDuplicates();
        assertThat(row.ids().path("ticker").asString()).isEqualTo("NVDA");
        assertThat(row.ids().get("cik").isNull()).isTrue();

        Map<String, Object> item = item(result);
        assertThat(item).containsEntry("key", "us:NVDA").containsEntry("kind", "company").containsEntry("name", "엔비디아")
                .containsEntry("newCount", 0).containsEntry("createdAt", "2026-11-14T03:00:00+00:00")
                .containsEntry("lastSeenAt", "2026-11-14T03:00:00+00:00");
    }

    @Test
    @DisplayName("이미 등록한 키는 수집기를 부르지 않고 200 + 그 줄, 다른 키가 같은 대표 키로 풀려도 줄을 늘리지 않는다")
    void reRegisteringReturnsExisting() {
        resolves("us:NVDA", entity("us:NVDA", "company", "엔비디아", "NVIDIA"));
        assertThat(service.add(MEMBER, "us:NVDA").status()).isEqualTo(200);
        long id = watches.rows.get(0).id();

        SearchWatchService.Result again = service.add(MEMBER, "us:NVDA");
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.body()).containsEntry("ok", true).containsEntry("created", false);
        assertThat(item(again)).containsEntry("id", id);
        verify(collector, times(1)).liveSearchEntity(anyString(), anyBoolean(), anyBoolean());

        resolves("wd:Q182477", entity("us:NVDA", "company", "엔비디아", "NVIDIA"));
        SearchWatchService.Result viaWikidata = service.add(MEMBER, "wd:Q182477");
        assertThat(viaWikidata.status()).isEqualTo(200);
        assertThat(viaWikidata.body()).containsEntry("created", false);
        assertThat(watches.rows).hasSize(1);
    }

    @Test
    @DisplayName("데모 열람은 등록하지 못한다(403) — 수집기를 부르지 않고 아무것도 쓰지 않음")
    void demoCannotRegister() {
        SearchWatchService.Result result = service.add(DEMO, "us:NVDA");
        assertThat(result.status()).isEqualTo(403);
        assertThat(result.body()).containsEntry("ok", false);
        assertThat((String) result.body().get("message")).contains("데모");
        assertThat(service.add(null, "us:NVDA").status()).isEqualTo(403);
        assertThat(watches.rows).isEmpty();
        verify(collector, never()).liveSearchEntity(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    @DisplayName("키 모양이 틀리면 400(InvalidRequestException) — 수집기를 부르지 않음")
    void badKeyIs400() {
        for (String bad : new String[]{null, "", "NVDA", "us:nvda", "kr:12345", "topic:", "wd:Q0"}) {
            assertThatThrownBy(() -> service.add(MEMBER, bad)).as(String.valueOf(bad)).isInstanceOf(InvalidRequestException.class);
        }
        verify(collector, never()).liveSearchEntity(anyString(), anyBoolean(), anyBoolean());
    }

    @Test
    @DisplayName("store_only 읽기 모드는 등록하지 못한다(403 store_only, ADR 0041 결정 2·D-1) — 주제 키·운영자도, 수집기를 부르지 않고 아무것도 쓰지 않음. "
            + "지우기·봤음은 된다")
    void storeOnlyCannotRegister() {
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);

        for (String key : new String[]{"us:NVDA", "topic:AI 반도체"}) {
            SearchWatchService.Result result = service.add(MEMBER, key);
            assertThat(result.status()).as(key).isEqualTo(403);
            assertThat(result.body()).containsEntry("ok", false).containsEntry("reason", "store_only");
        }
        assertThat(service.add(OWNER, "topic:HBM").status()).as("운영자도").isEqualTo(403);
        assertThat(watches.rows).isEmpty();
        verify(collector, never()).liveSearchEntity(anyString(), anyBoolean(), anyBoolean());

        long id = watches.seed(MEMBER.id(), "us:NVDA");
        assertThat(service.seen(MEMBER, id).status()).isEqualTo(200);
        assertThat(service.delete(MEMBER, id).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("주제 키는 수집기가 대상을 못 풀거나 닿지 못해도 키의 글로 등록한다(묻기는 external=true)")
    void topicRegistersWithoutCollector() {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null,\"errors\":{}}")));

        SearchWatchService.Result result = service.add(MEMBER, "topic: AI 반도체 ");

        assertThat(result.status()).isEqualTo(200);
        verify(collector).liveSearchEntity("topic:AI 반도체", true, false);
        SearchWatchStore.Watch row = watches.rows.get(0);
        assertThat(row.entityKey()).isEqualTo("topic:AI 반도체");
        assertThat(row.kind()).isEqualTo("topic");
        assertThat(row.name()).isEqualTo("AI 반도체");
        assertThat(row.aliases()).containsExactly("AI 반도체");
        assertThat(row.ids().get("ticker").isNull()).isTrue();

        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.empty());
        assertThat(service.add(MEMBER, "topic:HBM").status()).as("수집기가 없어도 주제는 됨").isEqualTo(200);
        assertThat(watches.rows).hasSize(2);
    }

    @Test
    @DisplayName("주제가 아닌 키는 수집기에 닿지 못하면 503, 대상을 풀지 못하면 409(unresolved) — 아무것도 저장하지 않음")
    void unresolvedEntity() {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.empty());
        SearchWatchService.Result down = service.add(MEMBER, "us:NVDA");
        assertThat(down.status()).isEqualTo(503);
        assertThat((String) down.body().get("message")).contains("수집기");

        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null,\"errors\":{}}")));
        SearchWatchService.Result unresolved = service.add(MEMBER, "kr:005930");
        assertThat(unresolved.status()).isEqualTo(409);
        assertThat(unresolved.body()).containsEntry("reason", "unresolved").containsEntry("ok", false);
        assertThat(watches.rows).isEmpty();
    }

    @Test
    @DisplayName("대상 풀기가 덜 끝났으면(errors에 entity·wikidata·sec — 시간 초과·일시 실패) 저장하지 않고 503(partial). 다시 풀어 오류가 없으면 등록, "
            + "DART 저장본에 없는 종목(dart — 다시 해도 같음)은 그대로 등록")
    void partialResolutionIsNotStored() {
        for (String source : new String[]{"entity", "wikidata", "sec"}) {
            resolves("us:NVDA", withError(entity("us:NVDA", "company", "NVIDIA", "NVIDIA"), source));
            SearchWatchService.Result result = service.add(MEMBER, "us:NVDA");
            assertThat(result.status()).as(source).isEqualTo(503);
            assertThat(result.body()).as(source).containsEntry("ok", false).containsEntry("reason", "partial");
            assertThat((String) result.body().get("message")).contains("다시");
        }
        assertThat(watches.rows).as("덜 풀린 이름·별칭은 저장하지 않음").isEmpty();

        resolves("us:NVDA", entity("us:NVDA", "company", "엔비디아", "NVIDIA", "엔비디아"));
        assertThat(service.add(MEMBER, "us:NVDA").status()).isEqualTo(200);
        assertThat(watches.rows).singleElement().satisfies(row -> assertThat(row.aliases()).contains("엔비디아"));

        resolves("kr:005930", withError(entity("kr:005930", "company", "합성 종목", "합성 종목"), "dart"));
        assertThat(service.add(MEMBER, "kr:005930").status()).isEqualTo(200);
        assertThat(watches.rows).hasSize(2);
    }

    @Test
    @DisplayName("상한에 닿아도 다른 키로 이미 등록한 대상(wd: → 대표 키 us:)은 200(created:false), 새 대상·풀지 못한 대상은 409(user_limit)")
    void atLimitSameEntityViaOtherKey() {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        for (int i = 0; i < SearchWatchService.MEMBER_WATCHES - 1; i++) {
            assertThat(service.add(MEMBER, "topic:주제" + i).status()).isEqualTo(200);
        }
        resolves("us:NVDA", entity("us:NVDA", "company", "엔비디아", "NVIDIA"));
        assertThat(service.add(MEMBER, "us:NVDA").status()).isEqualTo(200);
        long id = watches.find(MEMBER.id(), "us:NVDA").orElseThrow().id();

        resolves("wd:Q182477", entity("us:NVDA", "company", "엔비디아", "NVIDIA"));
        SearchWatchService.Result same = service.add(MEMBER, "wd:Q182477");
        assertThat(same.status()).isEqualTo(200);
        assertThat(same.body()).containsEntry("ok", true).containsEntry("created", false);
        assertThat(item(same)).containsEntry("id", id);

        resolves("us:AAPL", entity("us:AAPL", "company", "애플", "Apple"));
        SearchWatchService.Result fresh = service.add(MEMBER, "us:AAPL");
        assertThat(fresh.status()).isEqualTo(409);
        assertThat(fresh.body()).containsEntry("reason", "user_limit");

        when(collector.liveSearchEntity(org.mockito.ArgumentMatchers.eq("kr:005930"), anyBoolean(), anyBoolean())).thenReturn(Optional.empty());
        SearchWatchService.Result down = service.add(MEMBER, "kr:005930");
        assertThat(down.status()).as("상한에 닿았으면 수집기가 없어도 상한 사유").isEqualTo(409);
        assertThat(down.body()).containsEntry("reason", "user_limit");
        assertThat(watches.countForUser(MEMBER.id())).isEqualTo(SearchWatchService.MEMBER_WATCHES);
    }

    @Test
    @DisplayName("수집기가 준 대표 키가 문법에 맞지 않으면 물은 키로 저장하고, 모르는 종류는 키 모양으로(wd:는 등록하지 않음), 식별자가 없으면 null, 별칭이 없으면 이름 하나")
    void oddEntityFallsBackToAskedKey() {
        resolves("cik:0001067983", json("{\"entity\":{\"key\":\"BRK\",\"kind\":\"fund\",\"name\":\"합성 기관\",\"aliases\":\"합성\"}}"));

        assertThat(service.add(MEMBER, "cik:0001067983").status()).isEqualTo(200);

        SearchWatchStore.Watch row = watches.rows.get(0);
        assertThat(row.entityKey()).isEqualTo("cik:0001067983");
        assertThat(row.kind()).as("모르는 종류는 키 모양으로 — cik:는 13F 기관").isEqualTo("institution");
        assertThat(row.name()).isEqualTo("합성 기관");
        assertThat(row.aliases()).as("별칭이 없으면 대상의 이름 하나").containsExactly("합성 기관");
        assertThat(row.ids()).isNull();

        resolves("wd:Q42", json("{\"entity\":{\"key\":\"wd:Q42\",\"kind\":\"thing\",\"name\":\"합성 항목\"}}"));
        SearchWatchService.Result unknownKind = service.add(MEMBER, "wd:Q42");
        assertThat(unknownKind.status()).as("wd: 키의 종류를 모르면 지어내지 않고 등록하지 않음").isEqualTo(409);
        assertThat(unknownKind.body()).containsEntry("reason", "unresolved");
        assertThat(watches.rows).hasSize(1);
    }

    // ------------------------------------------------------------------ 상한

    @Test
    @DisplayName("회원은 10개 — 11번째는 409(user_limit)이고 수집기를 부르지 않는다. 운영자는 50개")
    void perUserLimits() {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        for (int i = 0; i < SearchWatchService.MEMBER_WATCHES; i++) {
            assertThat(service.add(MEMBER, "topic:주제" + i).status()).isEqualTo(200);
        }
        SearchWatchService.Result over = service.add(MEMBER, "topic:넘침");
        assertThat(over.status()).isEqualTo(409);
        assertThat(over.body()).containsEntry("reason", "user_limit");
        assertThat((String) over.body().get("message")).contains("10");
        verify(collector, times(SearchWatchService.MEMBER_WATCHES)).liveSearchEntity(anyString(), anyBoolean(), anyBoolean());
        assertThat(service.add(MEMBER, "topic:주제3").status()).as("이미 있는 키는 상한에 걸리지 않음").isEqualTo(200);

        for (int i = 0; i < SearchWatchService.OWNER_WATCHES; i++) {
            assertThat(service.add(OWNER, "topic:운영" + i).status()).isEqualTo(200);
        }
        assertThat(service.add(OWNER, "topic:운영넘침").status()).isEqualTo(409);
        assertThat(watches.countForUser(OWNER.id())).isEqualTo(SearchWatchService.OWNER_WATCHES);
    }

    @Test
    @DisplayName("서버 전체 서로 다른 대상 100개 — 새 대상은 409(server_limit), 이미 누군가 등록한 대상은 그대로 된다")
    void serverWideLimit() {
        for (int i = 0; i < SearchWatchService.SERVER_WATCHES; i++) {
            watches.seed(100 + i % 12, "topic:다른" + i);
        }
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));

        SearchWatchService.Result fresh = service.add(MEMBER, "topic:새것");
        assertThat(fresh.status()).isEqualTo(409);
        assertThat(fresh.body()).containsEntry("reason", "server_limit");

        assertThat(service.add(MEMBER, "topic:다른5").status()).as("같은 대상은 서버 부하를 늘리지 않음").isEqualTo(200);
        assertThat(watches.countKeys()).isEqualTo(SearchWatchService.SERVER_WATCHES);
    }

    @Test
    @DisplayName("한 회원이 서로 다른 대상 30개를 동시에 등록해도 10개까지만 저장된다(세기~저장 한 줄)")
    void concurrentAddsRespectUserLimit() throws Exception {
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        watches.race(30);

        List<Integer> statuses = concurrently(30, i -> service.add(MEMBER, "topic:동시" + i).status());

        assertThat(watches.countForUser(MEMBER.id())).isEqualTo(SearchWatchService.MEMBER_WATCHES);
        assertThat(statuses.stream().filter(status -> status == 200)).hasSize(SearchWatchService.MEMBER_WATCHES);
        assertThat(statuses.stream().filter(status -> status == 409)).hasSize(30 - SearchWatchService.MEMBER_WATCHES);
    }

    @Test
    @DisplayName("서버 99개일 때 두 회원이 서로 다른 새 대상을 동시에 등록해도 100개를 넘지 않는다")
    void concurrentAddsRespectServerLimit() throws Exception {
        for (int i = 0; i < SearchWatchService.SERVER_WATCHES - 1; i++) {
            watches.seed(100 + i % 12, "topic:다른" + i);
        }
        when(collector.liveSearchEntity(anyString(), anyBoolean(), anyBoolean())).thenReturn(Optional.of(json("{\"entity\":null}")));
        watches.race(2);

        List<Integer> statuses = concurrently(2, i -> service.add(i == 0 ? MEMBER : OTHER, "topic:새것" + i).status());

        assertThat(watches.countKeys()).isEqualTo(SearchWatchService.SERVER_WATCHES);
        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
    }

    // ------------------------------------------------------------------ 목록

    @Test
    @DisplayName("목록은 내 줄만, 새 글 수는 마지막으로 본 뒤 처음 받은 글 — 회원은 운영자 전용 출처(info·guru·wire·모름)를 세지 않음")
    void listsMyWatchesWithNewCounts() {
        long mine = watches.seed(MEMBER.id(), "us:NVDA", NOW.minus(Duration.ofHours(5)));
        watches.seed(OTHER.id(), "us:AAPL");
        watches.item("us:NVDA", "google_ko", NOW.minus(Duration.ofHours(6)));   // 보기 전
        watches.item("us:NVDA", "google_en", NOW.minus(Duration.ofHours(1)));
        watches.item("us:NVDA", "feeds", NOW.minus(Duration.ofMinutes(30)));
        watches.item("us:NVDA", "wire", NOW.minus(Duration.ofMinutes(20)));
        watches.item("us:NVDA", "info", NOW.minus(Duration.ofMinutes(10)));
        watches.item("us:NVDA", null, NOW.minus(Duration.ofMinutes(5)));

        Map<String, Object> out = service.list(MEMBER);

        assertThat(out).containsEntry("available", true);
        List<Map<String, Object>> items = items(out);
        assertThat(items).hasSize(1);
        assertThat(items.get(0)).containsEntry("id", mine).containsEntry("key", "us:NVDA").containsEntry("newCount", 2)
                .containsKeys("kind", "name", "createdAt", "lastSeenAt");
        assertThat(out.get("limits")).isEqualTo(Map.of("mine", 1, "max", 10, "serverUsed", 2, "serverMax", 100));
        assertThat(out).containsEntry("collecting", false);

        watches.seed(OWNER.id(), "us:NVDA", NOW.minus(Duration.ofHours(5)));
        Map<String, Object> owner = service.list(OWNER);
        assertThat(items(owner).get(0)).as("운영자는 모두 셈").containsEntry("newCount", 5);
        assertThat(((Map<?, ?>) owner.get("limits")).get("max")).isEqualTo(50);
    }

    @Test
    @DisplayName("collecting은 수집기의 politeEnabled(제외 목록 경로가 함께 답함) — 칸이 없거나 수집기에 닿지 못하면 null, 받은 값은 잠시 다시 쓴다")
    void collectingFlag() {
        when(collector.liveSearchExcludes()).thenReturn(Optional.of(json("{\"seed\": [], \"politeEnabled\": true}")));
        assertThat(service.list(MEMBER)).containsEntry("collecting", true);
        when(collector.liveSearchExcludes()).thenReturn(Optional.empty());
        assertThat(service.list(MEMBER)).as("받은 값을 잠시 다시 씀").containsEntry("collecting", true);
        verify(collector, times(1)).liveSearchExcludes();

        clock.advance(SearchWatchService.COLLECTING_TTL.plusSeconds(1));
        assertThat(service.list(MEMBER)).containsEntry("collecting", null);
        clock.advance(SearchWatchService.COLLECTING_RETRY.plusSeconds(1));
        when(collector.liveSearchExcludes()).thenReturn(Optional.of(json("{\"seed\": [], \"politeEnabled\": \"yes\"}")));
        assertThat(service.list(MEMBER)).as("참·거짓이 아니면 모름").containsEntry("collecting", null);
        verify(collector, never()).status();
    }

    @Test
    @DisplayName("데모의 목록은 비어 있고 읽기만 한다")
    void demoListIsEmpty() {
        watches.seed(MEMBER.id(), "us:NVDA");
        Map<String, Object> out = service.list(DEMO);
        assertThat(items(out)).isEmpty();
        assertThat(watches.writes).isZero();
    }

    @Test
    @DisplayName("표가 아직 없으면 available:false와 사유 — 등록·지우기·보기는 503")
    void notReady() {
        watches.ready = false;
        Map<String, Object> out = service.list(MEMBER);
        assertThat(out).containsEntry("available", false);
        assertThat((String) out.get("message")).isNotBlank();
        assertThat(service.add(MEMBER, "topic:x").status()).isEqualTo(503);
        assertThat(service.delete(MEMBER, 1).status()).isEqualTo(503);
        assertThat(service.seen(MEMBER, 1).status()).isEqualTo(503);
        verifyNoInteractions(collector);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> items(Map<String, Object> out) {
        return (List<Map<String, Object>>) out.get("items");
    }

    // ------------------------------------------------------------------ 지우기 · 보기

    @Test
    @DisplayName("지우기와 '봤음'은 자기 줄만 — 남의 줄·없는 줄은 404이고 그대로 남는다")
    void deleteAndSeenOnlyOwnRows() {
        long mine = watches.seed(MEMBER.id(), "us:NVDA", NOW.minus(Duration.ofHours(5)));
        long theirs = watches.seed(OTHER.id(), "us:AAPL", NOW.minus(Duration.ofHours(5)));
        watches.item("us:NVDA", "google_ko", NOW.minus(Duration.ofHours(1)));

        assertThat(service.delete(MEMBER, theirs).status()).isEqualTo(404);
        assertThat(service.seen(MEMBER, theirs).status()).isEqualTo(404);
        assertThat(service.delete(MEMBER, 999).status()).isEqualTo(404);
        assertThat(service.delete(DEMO, mine).status()).isEqualTo(403);
        assertThat(watches.rows).hasSize(2);

        clock.advance(Duration.ofMinutes(1));
        SearchWatchService.Result seen = service.seen(MEMBER, mine);
        assertThat(seen.status()).isEqualTo(200);
        assertThat(seen.body()).containsEntry("lastSeenAt", "2026-11-14T03:01:00+00:00");
        assertThat(items(service.list(MEMBER)).get(0)).containsEntry("newCount", 0);

        assertThat(service.delete(MEMBER, mine).status()).isEqualTo(200);
        assertThat(watches.rows).extracting(SearchWatchStore.Watch::id).containsExactly(theirs);
    }

    // ------------------------------------------------------------------ 매체 제외 목록

    @Test
    @DisplayName("제외 목록은 수집기의 처음 값(seed)과 운영자가 더한 줄(added)을 함께 — 수집기에 닿지 못하면 seed는 null, available:false")
    void excludesMergeSeedAndAdded() {
        when(collector.liveSearchExcludes()).thenReturn(Optional.of(json(
                "{\"seed\":[{\"kind\":\"domain\",\"value\":\"example-state.test\",\"group\":\"합성 묶음\"}]}")));
        when(excludes.all()).thenReturn(List.of(new SearchExcludeStore.Exclude(3, "domain", "example.test", "합성 메모", NOW)));

        Map<String, Object> out = service.excludes();

        assertThat(out).containsEntry("available", true);
        assertThat(out.get("seed")).isEqualTo(json("[{\"kind\":\"domain\",\"value\":\"example-state.test\",\"group\":\"합성 묶음\"}]"));
        assertThat(out.get("added")).isEqualTo(List.of(Map.of("id", 3L, "kind", "domain", "value", "example.test", "note", "합성 메모",
                "createdAt", "2026-11-14T03:00:00+00:00")));

        when(collector.liveSearchExcludes()).thenReturn(Optional.empty());
        Map<String, Object> down = service.excludes();
        assertThat(down).containsEntry("available", false).containsEntry("seed", null);
        assertThat((List<?>) down.get("added")).hasSize(1);
        assertThat((String) down.get("message")).isNotBlank();
    }

    @Test
    @DisplayName("제외 매체 더하기·지우기는 운영자만(403) — 회원·데모는 저장소를 건드리지 않는다")
    void excludesWriteIsOwnerOnly() {
        for (CurrentUser user : new CurrentUser[]{MEMBER, OTHER, DEMO, null}) {
            assertThat(service.addExclude(user, "domain", "example.test", null).status()).isEqualTo(403);
            assertThat(service.deleteExclude(user, 3).status()).isEqualTo(403);
        }
        verify(excludes, never()).insert(anyString(), anyString(), any());
        verify(excludes, never()).delete(anyLong());
    }

    @Test
    @DisplayName("도메인은 소문자 호스트로(앞의 https://·끝의 '/'·'.'은 지움), 경로·공백·포트·사용자·253자 넘음·점 없음은 400")
    void domainIsNormalised() {
        when(excludes.insert(anyString(), anyString(), any())).thenAnswer(call -> Optional.of(new SearchExcludeStore.Exclude(5,
                call.getArgument(0), call.getArgument(1), call.getArgument(2), NOW)));
        Map<String, String> good = new LinkedHashMap<>();
        good.put("Example.COM", "example.com");
        good.put("https://News.Example.com/", "news.example.com");
        good.put("http://example.co.kr", "example.co.kr");
        good.put("  WWW.example.test.  ", "www.example.test");
        good.put("한국.example", "xn--3e0b707e.example");
        for (Map.Entry<String, String> entry : good.entrySet()) {
            SearchWatchService.Result result = service.addExclude(OWNER, "domain", entry.getKey(), "  ");
            assertThat(result.status()).as(entry.getKey()).isEqualTo(200);
            verify(excludes).insert("domain", entry.getValue(), null);
        }
        for (String bad : new String[]{"https://example.com/news", "example.com/a", "exa mple.com", "example.com:8080",
                "user@example.com", "example", "", "   ", "a".repeat(250) + ".com", "example.com?x=1", "-bad-.com", "ftp://example.com"}) {
            assertThatThrownBy(() -> service.addExclude(OWNER, "domain", bad, null)).as(bad).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("이름은 1~80자(앞뒤 공백 지움, 제어 글자 안 됨), 종류는 domain·name만, 메모는 200자까지")
    void nameAndKindChecks() {
        when(excludes.insert(anyString(), anyString(), any())).thenAnswer(call -> Optional.of(new SearchExcludeStore.Exclude(6,
                call.getArgument(0), call.getArgument(1), call.getArgument(2), NOW)));

        SearchWatchService.Result result = service.addExclude(OWNER, "name", "  Example Wire  ", "합성 메모");
        assertThat(result.status()).isEqualTo(200);
        verify(excludes).insert("name", "Example Wire", "합성 메모");
        @SuppressWarnings("unchecked")
        Map<String, Object> item = (Map<String, Object>) result.body().get("item");
        assertThat(item).containsEntry("id", 6L).containsEntry("kind", "name").containsEntry("value", "Example Wire");

        assertThat(service.addExclude(OWNER, "name", "가".repeat(80), null).status()).isEqualTo(200);
        for (String bad : new String[]{"", "  ", "가".repeat(81), "합성\u0007이름"}) {
            assertThatThrownBy(() -> service.addExclude(OWNER, "name", bad, null)).as(bad).isInstanceOf(InvalidRequestException.class);
        }
        for (String kind : new String[]{null, "", "url", "DOMAIN"}) {
            assertThatThrownBy(() -> service.addExclude(OWNER, kind, "example.com", null)).as(String.valueOf(kind))
                    .isInstanceOf(InvalidRequestException.class);
        }
        assertThatThrownBy(() -> service.addExclude(OWNER, "name", "합성", "가".repeat(201))).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("이미 있는 제외 매체(대소문자 무시)를 다시 더하면 200 + 그 줄(created:false)")
    void duplicateExcludeReturnsExisting() {
        when(excludes.insert("domain", "example.test", null)).thenReturn(Optional.empty());
        when(excludes.find("domain", "example.test")).thenReturn(Optional.of(new SearchExcludeStore.Exclude(9, "domain", "example.test",
                null, NOW)));

        SearchWatchService.Result result = service.addExclude(OWNER, "domain", "EXAMPLE.test", null);

        assertThat(result.status()).isEqualTo(200);
        assertThat(result.body()).containsEntry("ok", true).containsEntry("created", false);
        @SuppressWarnings("unchecked")
        Map<String, Object> item = (Map<String, Object>) result.body().get("item");
        assertThat(item).containsEntry("id", 9L).containsEntry("note", null);
    }

    @Test
    @DisplayName("제외 매체 지우기 — 없는 번호는 404, 표가 없으면 503")
    void deleteExclude() {
        when(excludes.delete(3)).thenReturn(1);
        when(excludes.delete(4)).thenReturn(0);
        assertThat(service.deleteExclude(OWNER, 3).status()).isEqualTo(200);
        assertThat(service.deleteExclude(OWNER, 4).status()).isEqualTo(404);
        when(excludes.ready()).thenReturn(false);
        assertThat(service.deleteExclude(OWNER, 3).status()).isEqualTo(503);
        assertThat(service.addExclude(OWNER, "name", "합성", null).status()).isEqualTo(503);
    }

    // ------------------------------------------------------------------ 흉내

    private interface Call {
        int run(int index) throws Exception;
    }

    private static List<Integer> concurrently(int n, Call call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        try {
            List<Future<Integer>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                int index = i;
                futures.add(pool.submit(() -> call.run(index)));
            }
            List<Integer> out = new ArrayList<>();
            for (Future<Integer> future : futures) {
                out.add(future.get(30, TimeUnit.SECONDS));
            }
            return out;
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

    /**
     * 메모리 저장소. {@link #race}를 켜면 저장(insert)이 모든 요청이 검사를 마칠 때까지 장벽에서 기다려 경합 창을 결정적으로 엽니다 — 세기부터 저장까지가
     * 한 줄로 서면 첫 요청만 장벽에서 기다리다(시간 초과로 장벽이 깨짐) 저장하고, 나머지는 바뀐 값을 봅니다.
     */
    static final class MemoryWatchStore extends SearchWatchStore {
        final List<Watch> rows = new ArrayList<>();
        final List<Object[]> items = new ArrayList<>();
        boolean ready = true;
        int writes;
        private long sequence;
        private CyclicBarrier barrier;

        MemoryWatchStore() {
            super(null, null, null);
        }

        void race(int parties) {
            barrier = new CyclicBarrier(parties);
        }

        synchronized long seed(long userId, String key) {
            return seed(userId, key, NOW);
        }

        synchronized long seed(long userId, String key, Instant seenAt) {
            long id = ++sequence;
            rows.add(new Watch(id, userId, key, "topic", key, List.of(key), null, seenAt, seenAt));
            return id;
        }

        synchronized void item(String key, String source, Instant firstSeenAt) {
            items.add(new Object[]{key, source, firstSeenAt});
        }

        @Override
        public boolean ready() {
            return ready;
        }

        @Override
        public synchronized List<Watch> watches(long userId) {
            return rows.stream().filter(row -> row.userId() == userId).toList();
        }

        @Override
        public synchronized Optional<Watch> find(long userId, String entityKey) {
            return rows.stream().filter(row -> row.userId() == userId && row.entityKey().equals(entityKey)).findFirst();
        }

        @Override
        public synchronized int countForUser(long userId) {
            return (int) rows.stream().filter(row -> row.userId() == userId).count();
        }

        @Override
        public synchronized int countKeys() {
            return (int) rows.stream().map(Watch::entityKey).distinct().count();
        }

        @Override
        public synchronized boolean watchedByAnyone(String entityKey) {
            return rows.stream().anyMatch(row -> row.entityKey().equals(entityKey));
        }

        @Override
        public Watch insert(long userId, String entityKey, String kind, String name, List<String> aliases, JsonNode ids, Instant at) {
            if (barrier != null) {
                try {
                    barrier.await(2, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } catch (BrokenBarrierException | TimeoutException e) {
                    // 한 줄로 섰으면 여기로 옵니다 — 그대로 저장합니다.
                }
            }
            synchronized (this) {
                writes++;
                Optional<Watch> existing = find(userId, entityKey);
                if (existing.isPresent()) {
                    return existing.get();
                }
                Watch row = new Watch(++sequence, userId, entityKey, kind, name, aliases, ids, at, at);
                rows.add(row);
                return row;
            }
        }

        @Override
        public synchronized int delete(long id, long userId) {
            writes++;
            return rows.removeIf(row -> row.id() == id && row.userId() == userId) ? 1 : 0;
        }

        @Override
        public synchronized Optional<Instant> markSeen(long id, long userId, Instant at) {
            writes++;
            for (int i = 0; i < rows.size(); i++) {
                Watch row = rows.get(i);
                if (row.id() == id && row.userId() == userId) {
                    rows.set(i, new Watch(row.id(), row.userId(), row.entityKey(), row.kind(), row.name(), row.aliases(), row.ids(),
                            row.createdAt(), at));
                    return Optional.of(at);
                }
            }
            return Optional.empty();
        }

        @Override
        public synchronized Map<Long, Integer> newCounts(long userId, List<String> hiddenSources) {
            Map<Long, Integer> out = new LinkedHashMap<>();
            for (Watch row : watches(userId)) {
                Instant since = row.lastSeenAt() == null ? row.createdAt() : row.lastSeenAt();
                int count = 0;
                for (Object[] item : items) {
                    String source = (String) item[1];
                    boolean hidden = !hiddenSources.isEmpty() && (source == null || hiddenSources.contains(source));
                    if (item[0].equals(row.entityKey()) && ((Instant) item[2]).isAfter(since) && !hidden) {
                        count++;
                    }
                }
                out.put(row.id(), count);
            }
            return out;
        }
    }
}
