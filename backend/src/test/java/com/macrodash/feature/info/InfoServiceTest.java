package com.macrodash.feature.info;

import com.macrodash.collector.CollectorClient;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.FetchStateStore;
import com.macrodash.store.InfoStore;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 정보 수집 화면의 읽기(ADR 0035·0036) — 저장본만 읽고, 목록은 쪽으로, 모든 출처를 탭으로 묶어 상태를 붙인다. */
class InfoServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-11T09:00:00Z");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private InfoStore store;
    private FetchStateStore fetchState;
    private StoreReader reader;
    private StoreRepository repository;
    private CollectorClient collector;
    private InfoTranslator translator;
    private InfoService service;

    @BeforeEach
    void setUp() {
        store = mock(InfoStore.class);
        fetchState = mock(FetchStateStore.class);
        reader = mock(StoreReader.class);
        repository = mock(StoreRepository.class);
        collector = mock(CollectorClient.class);
        when(store.ready()).thenReturn(true);
        when(fetchState.ready()).thenReturn(true);
        translator = mock(InfoTranslator.class);
        service = new InfoService(store, fetchState, reader, repository, collector, translator, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static InfoStore.Item item(String source) {
        return new InfoStore.Item("0123456789abcdef01234567", source, "article", "https://wolfstreet.com/x", "Rates", "금리",
                "Wolf", NOW.minusSeconds(60), NOW, "요약", "full", "impersonate", MAPPER.createObjectNode(), null);
    }

    @Test
    @DisplayName("블로그 종류는 블로그 출처 키 전부와 한국어 제목만 있는 waedge 블로그 행을 쪽으로 읽는다")
    @SuppressWarnings("unchecked")
    void blogItemsPaged() {
        when(store.items(anyList(), any(), anyInt(), anyInt())).thenReturn(new InfoStore.Page<>(List.of(item("blog.wolfstreet")), 23));

        Map<String, Object> out = service.items("blog", null, null, 3, 10);

        ArgumentCaptor<List<String>> keys = ArgumentCaptor.forClass(List.class);
        verify(store).items(keys.capture(), eq(null), eq(20), eq(10));
        assertThat(keys.getValue()).contains("blog.wolfstreet", "blog.irrelevantinvestor", "waedge.blogs").hasSize(15);
        assertThat(out).containsEntry("page", 3).containsEntry("size", 10).containsEntry("total", 23).containsEntry("pages", 3);
        List<Map<String, Object>> items = (List<Map<String, Object>>) out.get("items");
        assertThat(items.get(0)).containsEntry("sourceLabel", "Wolf Street").doesNotContainKey("body");
    }

    @Test
    @DisplayName("모르는 종류·틀린 id·모르는 뉴스 묶음·KRX 허용 밖 값은 400")
    void badRequests() {
        assertThatThrownBy(() -> service.items("x", null, null, null, null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.item("../etc")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.headlines("jp", null, null, null, null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.krx("NYSE", null, null)).isInstanceOf(InvalidRequestException.class);
        verify(store, never()).item(anyString());
    }

    @Test
    @DisplayName("사건 뉴스는 고른 묶음의 관측치만 쪽으로 — 시각은 KST")
    @SuppressWarnings("unchecked")
    void headlines() {
        when(store.headlines(anyList(), any(), any(), anyInt(), anyInt())).thenReturn(new InfoStore.Page<>(List.of(
                new InfoStore.Headline(Datasets.OBS_KR_NEWS_HEADLINE, "금리 동결", "https://example.org/a", "한국은행", "bok_press",
                        Instant.parse("2026-11-11T01:00:00Z"), "2026-11-11 10:05:00 KST", "기준금리를 동결했다")), 1));

        Map<String, Object> out = service.headlines("kr", null, null, null, null);

        verify(store).headlines(eq(List.of(Datasets.OBS_KR_NEWS_HEADLINE)), eq(null), eq(null), eq(0), eq(InfoService.DEFAULT_SIZE));
        assertThat(((List<Map<String, Object>>) out.get("items")).get(0))
                .containsEntry("set", "kr").containsEntry("publishedAt", "2026-11-11 10:00 KST");
    }

    @Test
    @DisplayName("한눈 보기는 모든 출처를 탭으로 묶고 마지막 실행·판정·끊김에 따라 색을 매긴다 — 보류한 saveticker는 회색")
    @SuppressWarnings("unchecked")
    void catalog() {
        tools.jackson.databind.node.ObjectNode status = MAPPER.createObjectNode();
        tools.jackson.databind.node.ArrayNode summary = status.putArray("taskSummary");
        summary.addObject().put("task", "fred_series").put("speed", "slow").put("status", "ok").put("startedAt", "2026-11-11T08:00:00+00:00");
        summary.addObject().put("task", "cot_history").put("speed", "slow").put("status", "fail").put("detail", "HTTP 503");
        when(collector.status()).thenReturn(Optional.of(status));
        when(store.states()).thenReturn(List.of(new InfoStore.SourceState("info_blog_wolfstreet", "blocked", 1, "HTTP 403",
                NOW.minus(Duration.ofHours(2)), NOW.minus(Duration.ofMinutes(3)), 1440, NOW.minus(Duration.ofDays(1)))));
        when(store.counts()).thenReturn(List.of(new InfoStore.SourceCount("blog.wolfstreet", 12, NOW.minusSeconds(600))));
        when(fetchState.schedule()).thenReturn(Map.of("info_blog_wolfstreet", NOW.plus(Duration.ofHours(1))));

        Map<String, Object> out = service.catalog();

        List<Map<String, Object>> rows = (List<Map<String, Object>>) out.get("sources");
        assertThat(rows).hasSize(InfoSources.ALL.size());
        Map<String, Map<String, Object>> byTask = new java.util.HashMap<>();
        rows.forEach(row -> byTask.put((String) row.get("task"), row));
        assertThat(byTask.get("fred_series")).containsEntry("tone", "ok").containsEntry("tab", "global")
                .containsEntry("lastRunAt", "2026-11-11 17:00 KST");
        assertThat(byTask.get("cot_history")).containsEntry("tone", "danger");
        assertThat(byTask.get("info_blog_wolfstreet")).containsEntry("tone", "danger").containsEntry("items", 12)
                .containsEntry("nextDueAt", "2026-11-11 19:00 KST");
        assertThat(byTask.get("saveticker")).containsEntry("tone", "neutral").containsEntry("access", "deferred");
        assertThat(byTask.get("sec_13f")).containsEntry("tone", "neutral");
        assertThat(out).containsEntry("collectorReachable", true);
        assertThat((List<Map<String, Object>>) out.get("tabs")).extracting(tab -> tab.get("key"))
                .containsExactly("news", "kr", "global", "filings", "paper", "ops");
    }

    @Test
    @DisplayName("메커니즘은 수집기의 실제 값에 호스트 상태·다음 실행·알림 기준과 보류 출처를 더한다")
    @SuppressWarnings("unchecked")
    void mechanism() {
        when(collector.infoMechanism()).thenReturn(Optional.of(MAPPER.createObjectNode().put("politeEnabled", true)));
        when(fetchState.hosts()).thenReturn(List.of(new FetchStateStore.HostState("wolfstreet.com", "impersonate", 0, null, null,
                false, com.macrodash.Kst.today(), 5)));
        when(fetchState.schedule()).thenReturn(Map.of());

        Map<String, Object> out = service.mechanism();

        assertThat(out.get("collector").toString()).contains("politeEnabled");
        assertThat((List<Map<String, Object>>) out.get("hostStates")).singleElement()
                .satisfies(host -> assertThat(host).containsEntry("usedToday", 5).containsEntry("blockedUntil", null));
        assertThat((Map<String, Object>) out.get("alerts")).containsEntry("formatStreak", SourceIncidents.FORMAT_STREAK);
        assertThat(out.get("deferred").toString()).contains("saveticker", "SAVETICKER_ID");
    }

    @Test
    @DisplayName("KRX는 스냅샷과 고른 조합의 가장 최근 날짜 순위를 순위 순으로")
    @SuppressWarnings("unchecked")
    void krx() {
        when(reader.readStored(Datasets.SNAP_INFO_KRX_DAILY)).thenReturn(Optional.empty());
        when(repository.listObservationDates(eq(Datasets.OBS_KRX_INVESTOR_RANK), any(Map.class))).thenReturn(List.of("2026-11-10", "2026-11-11"));
        when(repository.readObservations(eq(Datasets.OBS_KRX_INVESTOR_RANK), any(), eq(null), any(Map.class))).thenReturn(List.of(
                MAPPER.createObjectNode().put("rank", 2).put("code", "B"), MAPPER.createObjectNode().put("rank", 1).put("code", "A")));

        Map<String, Object> out = service.krx("KOSDAQ", "연기금", "순매도");

        Map<String, Object> ranking = (Map<String, Object>) out.get("ranking");
        assertThat(ranking).containsEntry("date", "2026-11-11").containsEntry("investor", "연기금");
        assertThat(ranking.get("rows").toString()).startsWith("[{\"rank\":1");
        assertThat(out).containsEntry("available", false);
    }

    @Test
    @DisplayName("저장본이 없으면 available:false이고 수집을 요청하지 않는다(readStored만)")
    void snapshotsReadStoredOnly() {
        when(reader.readStored(Datasets.SNAP_INFO_NAVER_FLOWS)).thenReturn(Optional.empty());

        assertThat(service.flows()).containsEntry("available", false);
        verify(reader, never()).read(anyString(), org.mockito.ArgumentMatchers.anyLong(), anyString());
    }

    @Test
    @DisplayName("글 목록은 제목을 원문 그대로 내리고(미리 번역하지 않음 — 출처가 붙인 한국어 제목만), 속보(wire)만 고를 수 있다")
    @SuppressWarnings("unchecked")
    void itemsCarryTranslatedTitles() {
        InfoStore.Item wire = new InfoStore.Item("0123456789abcdef01234568", "wire.financialjuice", "headline",
                "https://www.financialjuice.com/News/1/x.aspx", "Fed's Waller: rates are restrictive", null, null,
                NOW.minusSeconds(60), NOW, null, "none", "impersonate", MAPPER.createObjectNode(), null);
        when(store.items(anyList(), any(), anyInt(), anyInt())).thenReturn(new InfoStore.Page<>(List.of(wire, item("blog.wolfstreet")), 2));

        Map<String, Object> out = service.items("wire", null, null, null, null);

        verify(store).items(eq(List.of("wire.financialjuice")), eq(null), eq(0), eq(InfoService.DEFAULT_SIZE));
        List<Map<String, Object>> rows = (List<Map<String, Object>>) out.get("items");
        assertThat(rows.get(0)).containsEntry("title", "Fed's Waller: rates are restrictive").containsEntry("titleKo", null)
                .containsEntry("sourceLabel", "Financial Juice 속보")
                .containsEntry("kind", "headline").containsEntry("bodyStatus", "none");
        assertThat(rows.get(1)).containsEntry("titleKo", "금리");
        verify(translator, never()).titles(anyList());

        // 종류를 고르지 않으면 글(블로그·waedge)만 — 속보가 '최근 글'을 덮지 않습니다.
        ArgumentCaptor<List<String>> all = ArgumentCaptor.forClass(List.class);
        service.items(null, null, null, null, 5);
        verify(store).items(all.capture(), eq(null), eq(0), eq(5));
        assertThat(all.getValue()).contains("blog.wolfstreet", "waedge.brief", "waedge.blogs").doesNotContain("wire.financialjuice");
    }

    @Test
    @DisplayName("번역 — 수집 글은 저장된 본문(없으면 요약)을, 글 표에 없는 것은 보낸 글을 번역한다. 수집은 일으키지 않는다")
    void translate() {
        InfoStore.Item stored = new InfoStore.Item("0123456789abcdef01234567", "blog.wolfstreet", "article", "https://wolfstreet.com/x",
                "Rates", null, "Wolf", NOW, NOW, "Short summary", "full", "impersonate", MAPPER.createObjectNode(), "Long body text");
        when(store.item("0123456789abcdef01234567")).thenReturn(Optional.of(stored));
        when(translator.titles(List.of("Rates"))).thenReturn(new InfoTranslator.Titles(Map.of("Rates", "금리"), null, null, true, "gemini-3.5-flash"));
        when(translator.body("Long body text")).thenReturn(new InfoTranslator.Body(true, "긴 본문", false, false, false, null, "claude-haiku-5-5"));
        when(translator.body("Summary only")).thenReturn(new InfoTranslator.Body(false, null, false, false, false, "오늘 번역량 상한", null));

        Map<String, Object> item = service.translate("0123456789abcdef01234567", "ignored", "ignored");
        Map<String, Object> text = service.translate(null, "한국어 제목", "Summary only");

        assertThat(item).containsEntry("ok", true).containsEntry("titleKo", "금리").containsEntry("textKo", "긴 본문")
                .containsEntry("model", "claude-haiku-5-5");
        assertThat(text).containsEntry("ok", false).containsEntry("error", "오늘 번역량 상한").containsEntry("titleKo", null);
        assertThatThrownBy(() -> service.translate("nope", null, null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.translate(null, " ", null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.translate(null, null, "x".repeat(InfoService.TRANSLATE_TEXT_MAX + 1)))
                .isInstanceOf(InvalidRequestException.class);
        verify(collector, never()).status();
    }
}
