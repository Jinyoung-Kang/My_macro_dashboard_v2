package com.macrodash.feature.info;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.InfoStore;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
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

/** 정보 수집 화면의 읽기(ADR 0035) — 저장본만 읽고, 분류는 출처 키로, 끊긴 출처는 상태 줄과 사건 목록에 함께. */
class InfoServiceTest {

    private static final Instant NOW = Instant.parse("2026-11-11T09:00:00Z");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private InfoStore store;
    private StoreReader reader;
    private InfoService service;

    @BeforeEach
    void setUp() {
        store = mock(InfoStore.class);
        reader = mock(StoreReader.class);
        when(store.ready()).thenReturn(true);
        service = new InfoService(store, reader, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static InfoStore.Item item(String source, Instant published) {
        return new InfoStore.Item("0123456789abcdef01234567", source, "article", "https://wolfstreet.com/x", "Rates", "금리",
                "Wolf", published, NOW, "요약", "full", "impersonate", MAPPER.createObjectNode(), null);
    }

    @Test
    @DisplayName("블로그 분류는 블로그 출처 키 전부와 한국어 제목만 있는 waedge 블로그 행을 읽는다")
    @SuppressWarnings("unchecked")
    void blogCategoryKeys() {
        when(store.items(anyList(), any(), any(), anyInt())).thenReturn(List.of(item("blog.wolfstreet", NOW.minusSeconds(60))));

        Map<String, Object> out = service.items("blog", null, null, null, null);

        org.mockito.ArgumentCaptor<List<String>> keys = org.mockito.ArgumentCaptor.forClass(List.class);
        verify(store).items(keys.capture(), eq(null), eq(null), eq(InfoService.DEFAULT_LIMIT));
        assertThat(keys.getValue()).contains("blog.wolfstreet", "blog.irrelevantinvestor", "waedge.blogs").hasSize(15);
        List<Map<String, Object>> items = (List<Map<String, Object>>) out.get("items");
        assertThat(items.get(0)).containsEntry("sourceLabel", "Wolf Street").containsEntry("titleKo", "금리").doesNotContainKey("body");
        assertThat(out.get("next")).as("한 쪽을 다 채우지 않았으면 다음 쪽이 없다").isNull();
    }

    @Test
    @DisplayName("모르는 분류·틀린 시각·틀린 id는 400")
    void badRequests() {
        assertThatThrownBy(() -> service.items("x", null, null, null, null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.items(null, null, null, "어제", null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.item("../etc")).isInstanceOf(InvalidRequestException.class);
        verify(store, never()).item(anyString());
    }

    @Test
    @DisplayName("글 한 편은 본문을 싣고, 없으면 found:false")
    void oneItem() {
        InfoStore.Item withBody = new InfoStore.Item("0123456789abcdef01234567", "waedge.brief", "brief", "https://news.waedge.ai/a/1.html",
                "글", null, null, null, NOW, null, "full", "browser", MAPPER.createObjectNode().put("category", "시장 · 국내"), "본문");
        when(store.item("0123456789abcdef01234567")).thenReturn(Optional.of(withBody));
        when(store.item("aaaaaaaaaaaaaaaaaaaaaaaa")).thenReturn(Optional.empty());

        assertThat(service.item("0123456789abcdef01234567")).containsEntry("found", true);
        @SuppressWarnings("unchecked")
        Map<String, Object> found = (Map<String, Object>) service.item("0123456789abcdef01234567").get("item");
        assertThat(found).containsEntry("body", "본문").containsEntry("category", "시장 · 국내").containsEntry("fetchTier", "browser");
        assertThat(service.item("aaaaaaaaaaaaaaaaaaaaaaaa")).containsEntry("found", false);
    }

    @Test
    @DisplayName("출처 상태는 표의 모든 출처를 싣고, 끊긴 출처는 그 줄과 사건 목록에 함께")
    @SuppressWarnings("unchecked")
    void sources() {
        when(store.states()).thenReturn(List.of(new InfoStore.SourceState("info_blog_wolfstreet", "blocked", 1, "HTTP 403",
                NOW.minus(Duration.ofHours(2)), NOW.minus(Duration.ofMinutes(3)), 1440, NOW.minus(Duration.ofDays(1)))));
        when(store.counts()).thenReturn(List.of(new InfoStore.SourceCount("blog.wolfstreet", 12, NOW.minusSeconds(600))));

        Map<String, Object> out = service.sources();

        List<Map<String, Object>> rows = (List<Map<String, Object>>) out.get("sources");
        assertThat(rows).hasSize(InfoSources.ALL.size());
        Map<String, Object> wolf = rows.get(0);
        assertThat(wolf).containsEntry("label", "Wolf Street").containsEntry("status", "blocked").containsEntry("items", 12);
        assertThat(wolf.get("incident")).isNotNull();
        assertThat((List<Map<String, Object>>) out.get("incidents")).singleElement()
                .satisfies(incident -> assertThat(incident).containsEntry("kind", "blocked"));
        assertThat(out).containsEntry("recorded", true);
    }

    @Test
    @DisplayName("저장본이 없으면 available:false이고 수집을 요청하지 않는다(readStored만)")
    void snapshotsReadStoredOnly() {
        when(reader.readStored(Datasets.SNAP_INFO_NAVER_FLOWS)).thenReturn(Optional.empty());

        assertThat(service.flows()).containsEntry("available", false);
        verify(reader).readStored(Datasets.SNAP_INFO_NAVER_FLOWS);
        verify(reader, never()).read(anyString(), org.mockito.ArgumentMatchers.anyLong(), anyString());
    }

    @Test
    @DisplayName("표가 아직 없으면(백엔드만 새로 띄움) 빈 답")
    void notReady() {
        when(store.ready()).thenReturn(false);

        assertThat(service.items(null, null, null, null, null)).containsEntry("available", false);
        assertThat(service.sources()).containsEntry("available", false);
    }
}
