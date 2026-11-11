package com.macrodash.feature.positioning;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * "화면은 수집을 기다리지 않습니다." 저장본이 있으면(오래됐더라도) 수집기를 동기로 부르지 않습니다.
 * 예전에는 15분 지난 저장본에서 liveRadar(읽기 타임아웃 90초)를 불러, 수집기가 응답을 못 하면
 * 랭킹 90초·교집합 180초·AI 리포트 270초가 멈췄습니다.
 */
class RadarServiceNonBlockingTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    @DisplayName("오래된 저장본이 있으면 수집기를 기다리지 않고 저장본을 돌려준다")
    void staleSnapshotIsServedWithoutWaiting() throws Exception {
        String name = Datasets.radarScanner("KOSPI", "외국인", "순매수", "TODAY");
        JsonNode payload = MAPPER.readTree("""
                {"source":"Daum","sourceKind":"daum","isHistorical":false,
                 "rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":100.0}]}
                """);
        Snapshot stale = new Snapshot(name, payload, "json", "ok", null,
                Instant.now().minus(Duration.ofMinutes(20)));

        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        // StoreReader.read는 오래된 저장본이면 수집기에 비동기로 알리고 저장본을 돌려줍니다.
        when(store.readStored(eq(name))).thenReturn(Optional.of(stale));
        when(store.read(eq(name), anyLong(), anyString())).thenReturn(Optional.of(stale));
        CollectorClient collector = mock(CollectorClient.class);

        long started = System.nanoTime();
        Map<String, Object> out = new RadarService(store, mock(StoreRepository.class), collector)
                .ranking("KOSPI", "외국인", "순매수", 30, "TODAY", null);

        assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(500);
        assertThat(out).containsEntry("available", true).containsEntry("stale", true);
        verify(collector, never()).liveRadar(anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.any());
        verify(store).read(eq(name), eq(Datasets.MAX_AGE_REALTIME), eq("radar_rankings"));
    }

    @Test
    @DisplayName("저장본이 없는 조합만 수집기에 지금 받는다")
    void onlyUncollectedCombinationsGoLive() throws Exception {
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.liveRadar(anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(Optional.of(MAPPER.readTree("""
                        {"source":"토스증권 공식","sourceKind":"toss","isHistorical":false,"rows":[{"code":"000660"}]}
                        """)));

        Map<String, Object> out = new RadarService(store, mock(StoreRepository.class), collector)
                .ranking("KOSPI", "연기금", "순매수", 30, "TODAY", null);

        assertThat(out).containsEntry("available", true).containsEntry("sourceKind", "toss");
    }

    @Test
    @DisplayName("저장본이 없는 기본 조합은 radar_rankings 수집을 기다리지 않고 바로 지금 받는다")
    void missingSnapshotDoesNotAwaitScheduledTask() throws Exception {
        // StoreReader.read는 저장본이 **없으면** 태스크를 기다립니다(수집기 읽기 타임아웃 90초).
        // radar_rankings는 스케줄 조합 3개만 수집하므로 '개인·순매수' 같은 조합은 기다려도 결과가
        // 없습니다 — 그 경로를 타면 이 테스트는 실패해야 합니다.
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(store.readStored(anyString())).thenReturn(Optional.empty());
        when(store.read(anyString(), anyLong(), anyString()))
                .thenThrow(new AssertionError("저장본이 없는데 StoreReader.read(수집 대기)를 불렀습니다"));
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.liveRadar(anyString(), anyString(), anyString(), org.mockito.ArgumentMatchers.anyInt(), anyString(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(Optional.of(MAPPER.readTree("""
                        {"source":"Daum","sourceKind":"daum","isHistorical":false,"rows":[{"code":"005930"}]}
                        """)));

        Map<String, Object> out = new RadarService(store, mock(StoreRepository.class), collector)
                .ranking("KOSPI", "개인", "순매수", 30, "TODAY", null);

        assertThat(out).containsEntry("available", true).containsEntry("sourceKind", "daum");
        verify(store, never()).read(anyString(), anyLong(), anyString());
    }
}
