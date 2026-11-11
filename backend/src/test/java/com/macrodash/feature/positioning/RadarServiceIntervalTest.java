package com.macrodash.feature.positioning;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 레이더 순위의 실제 기간(QA-397).
 *
 * <p>기간(5일·20일)을 요청해도 수집기가 하루치를 돌려줄 수 있습니다 — Daum이 그 투자주체의 기간 누적을 주지 않거나(기관, 개인 등 KRX 경로)
 * 기간 조회가 실패해 당일 경로로 넘어간 경우입니다. 수집기는 실제로 받은 기간을 {@code intervalType}으로 밝히는데(QA-028), 백엔드가 요청한
 * 값을 그대로 내려 화면이 '5거래일' 아래 하루치 금액을 보였습니다.
 */
class RadarServiceIntervalTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static StoreReader emptyStore() {
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(store.readStored(anyString())).thenReturn(Optional.empty());
        return store;
    }

    private static CollectorClient collectorGiving(String json) throws Exception {
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.liveRadar(anyString(), anyString(), anyString(), anyInt(), anyString(), any()))
                .thenReturn(Optional.of(MAPPER.readTree(json)));
        return collector;
    }

    @Test
    @DisplayName("QA-397: 기간 요청이 하루치로 바뀌면 응답의 기간은 실제 값이고, 요청 값과 경고를 함께 준다")
    void liveIntervalIsTheActualOne() throws Exception {
        CollectorClient collector = collectorGiving("""
                {"source":"KRX 정보데이터시스템 확정 (개인, 2026-11-10)","sourceKind":"krx","isHistorical":false,
                 "intervalType":"TODAY","dataDate":"2026-11-10","rows":[{"rank":1,"code":"005930"}]}
                """);

        Map<String, Object> out = new RadarService(emptyStore(), mock(StoreRepository.class), collector)
                .ranking("KOSPI", "개인", "순매수", 30, "DAYS_5", null);

        assertThat(out).containsEntry("available", true)
                .containsEntry("intervalType", "TODAY")
                .containsEntry("requestedIntervalType", "DAYS_5");
        assertThat(String.valueOf(out.get("warning"))).contains("5거래일").contains("하루치");
    }

    @Test
    @DisplayName("요청한 기간 그대로 받았으면 경고도 요청 값 칸도 없다")
    void sameIntervalHasNoWarning() throws Exception {
        CollectorClient collector = collectorGiving("""
                {"source":"Daum API (외국인, 5일)","sourceKind":"daum","isHistorical":false,"intervalType":"DAYS_5",
                 "rows":[{"rank":1,"code":"005930"}]}
                """);

        Map<String, Object> out = new RadarService(emptyStore(), mock(StoreRepository.class), collector)
                .ranking("KOSPI", "외국인", "순매수", 30, "DAYS_5", null);

        assertThat(out).containsEntry("available", true).containsEntry("intervalType", "DAYS_5")
                .doesNotContainKey("requestedIntervalType").doesNotContainKey("warning");
    }

    @Test
    @DisplayName("수집기가 기간을 밝히지 않은 응답이면 요청한 기간을 그대로 둔다(지어내지 않음)")
    void missingIntervalKeepsRequested() throws Exception {
        CollectorClient collector = collectorGiving("""
                {"source":"Daum","sourceKind":"daum","isHistorical":false,"rows":[{"rank":1,"code":"005930"}]}
                """);

        Map<String, Object> out = new RadarService(emptyStore(), mock(StoreRepository.class), collector)
                .ranking("KOSPI", "외국인", "순매수", 30, "DAYS_20", null);

        assertThat(out).containsEntry("intervalType", "DAYS_20").doesNotContainKey("requestedIntervalType").doesNotContainKey("warning");
    }

    @Test
    @DisplayName("QA-397: 교집합의 한쪽이 요청한 기간이 아니면 경고한다")
    void consensusWarnsWhenOneSideIsNotTheRequestedInterval() throws Exception {
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.liveRadar(eq("KOSPI"), eq("외국인"), anyString(), anyInt(), eq("DAYS_5"), any()))
                .thenReturn(Optional.of(MAPPER.readTree("""
                        {"source":"Daum API (외국인, 5일)","sourceKind":"daum","isHistorical":false,"intervalType":"DAYS_5",
                         "rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":500.0}]}
                        """)));
        when(collector.liveRadar(eq("KOSPI"), eq("기관"), anyString(), anyInt(), eq("DAYS_5"), any()))
                .thenReturn(Optional.of(MAPPER.readTree("""
                        {"source":"Daum API (기관, 당일)","sourceKind":"daum","isHistorical":false,"intervalType":"TODAY",
                         "dataDate":"2026-11-11","rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":50.0}]}
                        """)));

        Map<String, Object> out = new RadarService(emptyStore(), mock(StoreRepository.class), collector)
                .consensus("KOSPI", "순매수", 30, "DAYS_5");

        assertThat(out).containsEntry("available", true);
        assertThat(String.valueOf(out.get("warning"))).contains("기관").contains("하루치");
    }

    @Test
    @DisplayName("QA-397: 저장본에 적힌 실제 기간이 요청과 다르면(옛 저장본) 같은 표시를 한다")
    void snapshotIntervalIsTheActualOne() throws Exception {
        String name = Datasets.radarScanner("KOSPI", "외국인", "순매수", "TODAY");
        Snapshot snapshot = new Snapshot(name, MAPPER.readTree("""
                {"source":"Daum","sourceKind":"daum","isHistorical":false,"intervalType":"TODAY",
                 "rows":[{"rank":1,"code":"005930"}]}
                """), "json", "ok", null, Instant.now());
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        when(store.readStored(anyString())).thenReturn(Optional.of(snapshot));
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.of(snapshot));

        Map<String, Object> out = new RadarService(store, mock(StoreRepository.class), mock(CollectorClient.class))
                .ranking("KOSPI", "외국인", "순매수", 30, "DAYS_20", null);

        assertThat(out).containsEntry("intervalType", "TODAY").containsEntry("requestedIntervalType", "DAYS_20");
        assertThat(String.valueOf(out.get("warning"))).contains("20거래일").contains("하루치");
    }
}
