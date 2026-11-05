package com.macrodash.feature.macro;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 경제 캘린더 읽기(ADR 0026 결정 10) — 저장본만 읽고 수집을 일으키지 않는다, 없는 값은 만들지 않는다. */
class EconCalendarServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Snapshot snapshot(String json) {
        JsonNode payload = MAPPER.readTree(json);
        return new Snapshot(Datasets.SNAP_ECON_CALENDAR_TV, payload, "json", "ok", null, Instant.parse("2026-11-05T03:00:00Z"));
    }

    @Test
    @DisplayName("저장본만 읽는다 — 태스크 이름을 넘기는 읽기(수집 요청)를 쓰지 않는다")
    void readsTheStoredSnapshotOnly() {
        StoreReader store = mock(StoreReader.class);
        when(store.readStored(Datasets.SNAP_ECON_CALENDAR_TV)).thenReturn(Optional.of(snapshot("""
                {"source": "TradingView 경제 캘린더", "sourceUrl": "https://www.tradingview.com/economic-calendar/",
                 "sourceNote": "비공식 참고", "fetchTier": "impersonate",
                 "window": {"from": "2026-11-04T00:00:00.000Z", "to": "2026-11-19T00:00:00.000Z"},
                 "events": [{"country": "US", "title": "Inflation Rate YoY", "at": "2026-11-12T13:30:00+00:00",
                             "atKst": "2026-11-12 22:30 KST", "importance": 1, "actual": null, "forecast": 3.0, "previous": 3.1}]}
                """)));

        Map<String, Object> out = new EconCalendarService(store).calendar();

        verify(store, never()).read(anyString(), anyLong(), any());
        assertThat(out).containsEntry("available", true)
                .containsEntry("source", "TradingView 경제 캘린더")
                .containsEntry("fetchTier", "impersonate")
                .containsEntry("collectedAtKst", "2026-11-05 12:00 KST");
        assertThat(out.get("ageSeconds")).isNotNull();
        JsonNode events = (JsonNode) out.get("events");
        assertThat(events.size()).isEqualTo(1);
        assertThat(events.get(0).get("actual").isNull()).as("없는 값은 null 그대로 — 0으로 채우지 않는다").isTrue();
        assertThat(events.get(0).get("forecast").asDouble()).isEqualTo(3.0);
    }

    @Test
    @DisplayName("저장본이 없으면 '없음'으로 답하고 수집을 요청하지 않는다")
    void missingSnapshotIsUnavailable() {
        StoreReader store = mock(StoreReader.class);
        when(store.readStored(Datasets.SNAP_ECON_CALENDAR_TV)).thenReturn(Optional.empty());

        Map<String, Object> out = new EconCalendarService(store).calendar();

        verify(store, never()).read(anyString(), anyLong(), any());
        assertThat(out).containsEntry("available", false).containsEntry("events", List.of());
        assertThat(out).doesNotContainKey("collectedAtKst");
    }

    @Test
    @DisplayName("저장본에 일정 목록이 없으면(모양이 다름) '없음'")
    void snapshotWithoutEventsIsUnavailable() {
        StoreReader store = mock(StoreReader.class);
        when(store.readStored(Datasets.SNAP_ECON_CALENDAR_TV)).thenReturn(Optional.of(snapshot("{\"events\": {\"rows\": []}}")));

        assertThat(new EconCalendarService(store).calendar()).containsEntry("available", false);
    }
}
