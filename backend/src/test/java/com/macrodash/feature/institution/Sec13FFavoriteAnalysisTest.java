package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 즐겨찾기를 교집합·공통 신규 매수·스타일(성격·유사도·보유 기관·위험)에(ADR 0048 단계 3) — 즐겨찾기 CIK를 받고(그 밖은 400), 기관 이름은 표시 이름,
 * 스타일 표에는 즐겨찾기 표시, 트랙레코드 저장본(q30)은 앞 8분기만 DB에서 잘라 읽고(q30을 통째로 풀거나 수집을 부르지 않음), 기본 12곳만 부르는 교집합
 * (AI 리포트 원문 — SnapshotTextService)은 즐겨찾기가 있어도 같은 결과. 값은 모두 가짜(CIK 99억대·이름 FAKE).
 */
class Sec13FFavoriteAnalysisTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String BERKSHIRE = "0001067983";
    private static final String FAV_Q8 = "0009900001";
    private static final String FAV_Q30 = "0009900002";

    private static String quarters(String cusip) {
        return """
                [{"filingDate":"2026-08-14","reportDate":"2026-06-30","totalValue":1500,"holdings":[
                   {"name":"FAKE ALPHA","cusip":"999999991","class":"COM","value":1000,"shares":10,"weight":66.7},
                   {"name":"FAKE %s","cusip":"%s","class":"COM","value":500,"shares":5,"weight":33.3}]},
                 {"filingDate":"2026-05-15","reportDate":"2026-03-31","totalValue":1000,"holdings":[
                   {"name":"FAKE ALPHA","cusip":"999999991","class":"COM","value":1000,"shares":10,"weight":100.0}]}]
                """.formatted(cusip, cusip);
    }

    private static Snapshot snapshot(String name, String quarters) {
        return new Snapshot(name, MAPPER.readTree("{\"quarters\":" + quarters + "}"), "json", "ok", null, Instant.now());
    }

    /** 버크셔(q8)·즐겨찾기 둘(하나는 q8, 하나는 q30만)의 저장본. q30은 앞 분기 자르기 길로만 돌려줍니다. */
    private static StoreReader store() {
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        when(store.readStoredFirstQuarters(anyString(), anyInt())).thenReturn(Optional.empty());
        when(store.quietly(any())).thenAnswer(invocation -> ((Supplier<?>) invocation.getArgument(0)).get());
        String berkshire = Datasets.sec13f(BERKSHIRE, Datasets.MAX_TRACKED_QUARTERS);
        when(store.read(eq(berkshire), anyLong(), anyString())).thenReturn(Optional.of(snapshot(berkshire, quarters("999999992"))));
        String favQ8 = Datasets.sec13f(FAV_Q8, Datasets.MAX_TRACKED_QUARTERS);
        when(store.read(eq(favQ8), anyLong(), anyString())).thenReturn(Optional.of(snapshot(favQ8, quarters("999999992"))));
        String favQ30 = Datasets.sec13f(FAV_Q30, Datasets.TRACK_RECORD_QUARTERS);
        when(store.readStoredFirstQuarters(eq(favQ30), eq(Datasets.MAX_TRACKED_QUARTERS)))
                .thenReturn(Optional.of(snapshot(favQ30, quarters("999999993"))));
        return store;
    }

    private static InstitutionCatalog catalog() {
        Sec13FFavoriteStore favorites = mock(Sec13FFavoriteStore.class);
        when(favorites.ready()).thenReturn(true);
        when(favorites.all()).thenReturn(List.of(
                new Sec13FFavoriteStore.Favorite(FAV_Q8, "FAKE ONE LLC", "가짜 하나", null, Instant.now()),
                new Sec13FFavoriteStore.Favorite(FAV_Q30, "FAKE TWO LLC", null, "설명", Instant.now())));
        return new InstitutionCatalog(favorites);
    }

    @Test
    @DisplayName("교집합은 즐겨찾기 CIK를 받고 이름은 표시 이름(없으면 SEC 이름), q30은 앞 8분기만 — 그 밖 CIK는 지금처럼 400")
    @SuppressWarnings("unchecked")
    void consensusAcceptsFavorites() {
        StoreReader store = store();
        Sec13FService service = new Sec13FService(store, catalog());
        Map<String, Object> out = service.consensus(List.of(BERKSHIRE, FAV_Q8, FAV_Q30), null, 2, 30);

        assertThat((List<String>) out.get("participants")).containsExactly(Institutions.byCik(BERKSHIRE).get("name"), "가짜 하나", "FAKE TWO LLC");
        verify(store, never()).read(eq(Datasets.sec13f(FAV_Q30, Datasets.TRACK_RECORD_QUARTERS)), anyLong(), anyString());
        assertThatThrownBy(() -> service.consensus(List.of(BERKSHIRE, "0009900009"), null, 2, 30)).isInstanceOf(InvalidRequestException.class);
        assertThat((List<String>) service.newBuys(List.of(FAV_Q8, FAV_Q30), null, 1).get("participants")).containsExactly("가짜 하나", "FAKE TWO LLC");
    }

    @Test
    @DisplayName("기본 12곳만 부르는 교집합(AI 리포트 원문의 호출)은 즐겨찾기가 있어도 결과가 같다(불변식 1)")
    void defaultsConsensusUnchangedByFavorites() {
        List<String> defaults = Institutions.ciks();
        Map<String, Object> without = new Sec13FService(store()).consensus(defaults, null, 2, 15);
        Map<String, Object> with = new Sec13FService(store(), catalog()).consensus(defaults, null, 2, 15);
        assertThat(MAPPER.writeValueAsString(with)).isEqualTo(MAPPER.writeValueAsString(without));
    }

    @Test
    @DisplayName("스타일 — 성격 표·유사도·보유 기관에 즐겨찾기(표시), 위험은 즐겨찾기 CIK를 받음, 기본 12곳 줄은 모양 그대로")
    @SuppressWarnings("unchecked")
    void styleIncludesFavorites() {
        GuruService guru = new GuruService(store(), catalog());

        List<Map<String, Object>> rows = (List<Map<String, Object>>) guru.profiles().get("rows");
        assertThat(rows).extracting(row -> row.get("cik")).containsExactlyInAnyOrder(BERKSHIRE, FAV_Q8, FAV_Q30);
        Map<String, Object> berkshire = rows.stream().filter(row -> BERKSHIRE.equals(row.get("cik"))).findFirst().orElseThrow();
        assertThat(berkshire).doesNotContainKey("favorite");
        assertThat(rows.stream().filter(row -> FAV_Q30.equals(row.get("cik"))).findFirst().orElseThrow())
                .containsEntry("favorite", true).containsEntry("name", "FAKE TWO LLC").containsEntry("key", "fav-" + FAV_Q30);

        List<Map<String, String>> institutions = (List<Map<String, String>>) guru.similarity().get("institutions");
        assertThat(institutions).extracting(row -> row.get("cik")).containsExactly(BERKSHIRE, FAV_Q8, FAV_Q30);
        assertThat(institutions.get(2)).containsEntry("favorite", "true");
        assertThat(institutions.get(0)).doesNotContainKey("favorite");

        Map<String, Object> holders = guru.holders("FAKE 999999993");
        assertThat((List<Map<String, Object>>) holders.get("rows")).extracting(row -> row.get("institution")).containsExactly("FAKE TWO LLC");

        assertThat(guru.risk(FAV_Q8, "SPY", 1)).containsKey("institution");
        assertThatThrownBy(() -> guru.risk("0009900009", "SPY", 1)).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("즐겨찾기를 모르는 서비스(기본 12곳만)는 지금과 같다 — 즐겨찾기 CIK는 400")
    void defaultsOnlyRejectsFavorites() {
        assertThatThrownBy(() -> new Sec13FService(store()).consensus(List.of(FAV_Q8), null, 1, 30)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> new GuruService(store()).risk(FAV_Q8, "SPY", 1)).isInstanceOf(InvalidRequestException.class);
    }
}
