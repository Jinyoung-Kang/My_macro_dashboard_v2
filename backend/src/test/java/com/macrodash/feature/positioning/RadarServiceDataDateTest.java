package com.macrodash.feature.positioning;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
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
 * 레이더 순위의 기준일(QA-396).
 *
 * <p>거래일 장중에 Daum이 비면 수집기는 KRX 확정 순위의 가장 가까운 앞 거래일 값을 돌려줍니다(ADR 0036 결정 6). 그 날짜가 응답에
 * 없으면 화면은 '방금 수집' 아래 전날 순위를 보이고, 교집합은 오늘과 전날을 맞춥니다 — "기준일이 다르면 비교하지 않습니다"(PRINCIPLES).
 */
class RadarServiceDataDateTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Snapshot fresh(String name, String json) throws Exception {
        return new Snapshot(name, MAPPER.readTree(json), "json", "ok", null, Instant.now());
    }

    private static StoreReader storeWith(Snapshot... snapshots) {
        StoreReader store = mock(StoreReader.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        when(store.readStored(anyString())).thenReturn(Optional.empty());
        for (Snapshot snapshot : snapshots) {
            when(store.readStored(eq(snapshot.name()))).thenReturn(Optional.of(snapshot));
            when(store.read(eq(snapshot.name()), anyLong(), anyString())).thenReturn(Optional.of(snapshot));
        }
        return store;
    }

    @Test
    @Disabled("QA-396: 순위 응답에 기준일(dataDate)이 없습니다 — 수정 커밋에서 풉니다")
    @DisplayName("QA-396: 저장본의 기준일을 순위 응답에 그대로 싣는다")
    void snapshotDataDateIsPassedThrough() throws Exception {
        Snapshot foreign = fresh(Datasets.radarScanner("KOSPI", "외국인", "순매수", "TODAY"), """
                {"source":"KRX 정보데이터시스템 확정 (외국인, 2026-11-10)","sourceKind":"krx","isHistorical":false,
                 "intervalType":"TODAY","dataDate":"2026-11-10","rows":[{"rank":1,"code":"005930","netAmountEok":10.0}]}
                """);

        Map<String, Object> out = new RadarService(storeWith(foreign), mock(StoreRepository.class), mock(CollectorClient.class))
                .ranking("KOSPI", "외국인", "순매수", 30, "TODAY", null);

        assertThat(out).containsEntry("available", true).containsEntry("dataDate", "2026-11-10");
    }

    @Test
    @Disabled("QA-396: 순위 응답에 기준일(dataDate)이 없습니다 — 수정 커밋에서 풉니다")
    @DisplayName("QA-396: 지금 받은 순위의 기준일도 응답에 싣는다")
    void liveDataDateIsPassedThrough() throws Exception {
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.liveRadar(anyString(), anyString(), anyString(), anyInt(), anyString(), any()))
                .thenReturn(Optional.of(MAPPER.readTree("""
                        {"source":"KRX 정보데이터시스템 확정 (개인, 2026-11-10)","sourceKind":"krx","isHistorical":false,
                         "intervalType":"TODAY","dataDate":"2026-11-10","rows":[{"rank":1,"code":"005930"}]}
                        """)));

        Map<String, Object> out = new RadarService(storeWith(), mock(StoreRepository.class), collector)
                .ranking("KOSPI", "개인", "순매수", 30, "TODAY", null);

        assertThat(out).containsEntry("available", true).containsEntry("dataDate", "2026-11-10");
    }

    @Test
    @Disabled("QA-396: 교집합이 기준일이 다른 두 순위를 맞춥니다 — 수정 커밋에서 풉니다")
    @DisplayName("QA-396: 두 쪽의 기준일이 다르면 교집합을 만들지 않고 사유를 준다")
    void consensusRefusesDifferentDataDates() throws Exception {
        Snapshot foreign = fresh(Datasets.radarScanner("KOSPI", "외국인", "순매수", "TODAY"), """
                {"source":"Daum API (외국인, 당일, 20261111)","sourceKind":"daum","isHistorical":false,"intervalType":"TODAY",
                 "dataDate":"2026-11-11","rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":100.0}]}
                """);
        Snapshot institution = fresh(Datasets.radarScanner("KOSPI", "기관", "순매수", "TODAY"), """
                {"source":"KRX 정보데이터시스템 확정 (기관, 2026-11-10)","sourceKind":"krx","isHistorical":false,"intervalType":"TODAY",
                 "dataDate":"2026-11-10","rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":50.0}]}
                """);

        Map<String, Object> out = new RadarService(storeWith(foreign, institution), mock(StoreRepository.class), mock(CollectorClient.class))
                .consensus("KOSPI", "순매수", 30, "TODAY");

        assertThat(out).containsEntry("available", false).containsEntry("rows", List.of());
        assertThat(String.valueOf(out.get("message")))
                .contains("외국인 2026-11-11").contains("기관 2026-11-10").contains("기준일이 달라");
    }

    @Test
    @DisplayName("기준일이 같거나 한쪽이라도 모르면 교집합을 만든다(지금 동작)")
    void consensusStillWorksWhenDatesMatchOrUnknown() throws Exception {
        Snapshot foreign = fresh(Datasets.radarScanner("KOSPI", "외국인", "순매수", "TODAY"), """
                {"source":"Daum","sourceKind":"daum","isHistorical":false,"intervalType":"TODAY",
                 "dataDate":"2026-11-11","rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":100.0}]}
                """);
        Snapshot sameDay = fresh(Datasets.radarScanner("KOSPI", "기관", "순매수", "TODAY"), """
                {"source":"Daum","sourceKind":"daum","isHistorical":false,"intervalType":"TODAY",
                 "dataDate":"2026-11-11","rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":50.0}]}
                """);
        Snapshot unknownDay = fresh(Datasets.radarScanner("KOSPI", "기관", "순매수", "TODAY"), """
                {"source":"KIS 장중 가집계","sourceKind":"kis","isHistorical":false,"intervalType":"TODAY",
                 "rows":[{"rank":1,"code":"005930","name":"삼성전자","netAmountEok":50.0}]}
                """);

        for (Snapshot institution : List.of(sameDay, unknownDay)) {
            Map<String, Object> out = new RadarService(storeWith(foreign, institution), mock(StoreRepository.class), mock(CollectorClient.class))
                    .consensus("KOSPI", "순매수", 30, "TODAY");
            assertThat(out).containsEntry("available", true);
        }
    }
}
