package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 종목 이름 표({@link PaperMarketData#krNames} — 사용자 결정 2026-11-02, 한국 화면에 종목 코드 대신 기업명): 관측치 저장본의 토스 이름이 먼저,
 * 없으면 최근 금융위 유니버스 행의 이름, 빈 이름·모르는 종목은 넣지 않음, 미국은 빈 표.
 */
class KrNamesTest {

    private static final LocalDate BASE = LocalDate.of(2026, 10, 29);

    private StoreReader store;
    private StoreRepository repository;
    private PaperMarketData data;

    @BeforeEach
    void setUp() {
        store = mock(StoreReader.class);
        repository = mock(StoreRepository.class);
        data = new PaperMarketData(store, repository);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
    }

    private void universe(Map<String, String> names) {
        when(repository.latestObservationDate(Datasets.OBS_KR_PAPER_UNIVERSE)).thenReturn(BASE);
        List<tools.jackson.databind.JsonNode> rows = names.entrySet().stream()
                .map(e -> (tools.jackson.databind.JsonNode) MAPPER.createObjectNode().put("code", e.getKey()).put("name", e.getValue()))
                .toList();
        when(repository.readObservations(eq(Datasets.OBS_KR_PAPER_UNIVERSE), eq(BASE), eq(null), eq(null))).thenReturn(rows);
    }

    private void quotes(Map<String, String> names) {
        ObjectNode payload = MAPPER.createObjectNode().put("contract", 1);
        ObjectNode codes = payload.putObject("codes");
        names.forEach((code, name) -> {
            ObjectNode entry = codes.putObject(code).put("status", "OK");
            if (name != null) {
                entry.put("name", name);
            }
        });
        when(store.read(eq(Datasets.SNAP_KR_PAPER_QUOTES), anyLong(), anyString())).thenReturn(Optional.of(
                KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, payload, Instant.parse("2026-10-30T13:02:00Z"))));
    }

    @Test
    @DisplayName("관측치 저장본의 토스 이름이 먼저, 없으면 금융위 유니버스 이름 — 빈 이름·모르는 종목은 표에 없음(짐작하지 않음)")
    void tossNamesFirstThenUniverse() {
        universe(Map.of("005930", "삼성전자", "000660", "SK하이닉스", "035720", " "));
        java.util.Map<String, String> toss = new java.util.LinkedHashMap<>();
        toss.put("005930", "삼성전자(토스)");
        toss.put("153130", "KODEX 단기채권");
        toss.put("069500", null);
        quotes(toss);

        assertThat(data.krNames()).containsExactly(Map.entry("000660", "SK하이닉스"), Map.entry("005930", "삼성전자(토스)"),
                Map.entry("153130", "KODEX 단기채권"));
    }

    @Test
    @DisplayName("저장본·유니버스가 모두 없으면 빈 표")
    void emptyWithoutSources() {
        assertThat(data.krNames()).isEmpty();
    }
}
