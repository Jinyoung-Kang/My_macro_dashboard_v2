package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 메뉴 밖 기관의 포트폴리오(모의 매매 신호 기관 팝업 — 2026-11-22 사용자 결정, ADR 0047과 같은 날 덧붙임): 트랙레코드 후보 기관의 저장본(q30)이
 * 있으면 수집을 부르지 않고(StoreReader.quietly) 읽고, 없거나 CIK 모양이 아니면 지금처럼 400. 값은 모두 가짜(CIK 99억대).
 */
class Sec13FCandidatePortfolioTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String CANDIDATE = "0009900000";
    private static final String QUARTERS = """
            [{"filingDate":"2026-08-14","reportDate":"2026-06-30","totalValue":1500,"holdings":[
               {"name":"FAKE ALPHA","cusip":"999999991","class":"COM","value":1000,"shares":10,"weight":66.7},
               {"name":"FAKE BETA","cusip":"999999992","class":"COM","value":500,"shares":5,"weight":33.3}]},
             {"filingDate":"2026-05-15","reportDate":"2026-03-31","totalValue":1000,"holdings":[
               {"name":"FAKE ALPHA","cusip":"999999991","class":"COM","value":1000,"shares":10,"weight":100.0}]}]
            """;

    private static StoreReader store(boolean candidateStored) {
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        when(store.quietly(any())).thenAnswer(invocation -> ((Supplier<?>) invocation.getArgument(0)).get());
        if (candidateStored) {
            Snapshot snapshot = new Snapshot(Datasets.sec13f(CANDIDATE, Datasets.TRACK_RECORD_QUARTERS),
                    MAPPER.readTree("{\"cik\":\"" + CANDIDATE + "\",\"quarters\":" + QUARTERS + "}"), "json", "ok", null, Instant.now());
            when(store.read(eq(Datasets.sec13f(CANDIDATE, Datasets.TRACK_RECORD_QUARTERS)), anyLong(), anyString()))
                    .thenReturn(Optional.of(snapshot));
        }
        return store;
    }

    @Test
    @DisplayName("13F 메뉴 밖 기관도 후보 저장본(q30)이 있으면 수집 없이 읽어 포트폴리오를 낸다 — q8(수집을 부를 수 있는 길)은 읽지 않음")
    @SuppressWarnings("unchecked")
    void candidateSnapshotIsReadQuietly() {
        StoreReader store = store(true);
        Map<String, Object> out = new Sec13FService(store).portfolio(CANDIDATE, 8, 30);

        assertThat(out).containsEntry("available", true).containsEntry("cik", CANDIDATE);
        assertThat((java.util.List<Map<String, Object>>) out.get("quarters")).hasSize(2);
        assertThat((java.util.List<Map<String, Object>>) out.get("holdings")).extracting(row -> row.get("name"))
                .contains("FAKE ALPHA", "FAKE BETA");
        verify(store).quietly(any());
        verify(store, never()).read(eq(Datasets.sec13f(CANDIDATE, Datasets.MAX_TRACKED_QUARTERS)), anyLong(), anyString());
    }

    @Test
    @DisplayName("13F 메뉴 밖 기관에 후보 저장본도 없으면 지금처럼 400(추적하지 않는 기관)")
    void candidateWithoutSnapshotIsRejected() {
        assertThatThrownBy(() -> new Sec13FService(store(false)).portfolio(CANDIDATE, 8, 30))
                .isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("추적하지 않는 기관 CIK");
    }

    @Test
    @DisplayName("CIK 모양이 아니면 저장본을 찾지 않고 400")
    void malformedCikIsRejectedBeforeReading() {
        StoreReader store = store(true);
        assertThatThrownBy(() -> new Sec13FService(store).portfolio("abc", 8, 30)).isInstanceOf(InvalidRequestException.class);
        verify(store, never()).read(anyString(), anyLong(), anyString());
        verify(store, never()).quietly(any());
    }
}
