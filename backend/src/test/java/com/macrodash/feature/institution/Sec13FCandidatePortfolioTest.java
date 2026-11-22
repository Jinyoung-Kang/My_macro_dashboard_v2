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
        return store(candidateStored, "");
    }

    /** {@code extra}: 저장본 머리에 덧붙일 JSON 칸(예 {@code "name":"…",}) — 수집기 q30 저장본의 이름·스타일. */
    private static StoreReader store(boolean candidateStored, String extra) {
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        when(store.quietly(any())).thenAnswer(invocation -> ((Supplier<?>) invocation.getArgument(0)).get());
        if (candidateStored) {
            Snapshot snapshot = new Snapshot(Datasets.sec13f(CANDIDATE, Datasets.TRACK_RECORD_QUARTERS),
                    MAPPER.readTree("{" + extra + "\"cik\":\"" + CANDIDATE + "\",\"quarters\":" + QUARTERS + "}"), "json", "ok", null, Instant.now());
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
    @DisplayName("13F 메뉴 밖 기관의 기관 칸은 q30 저장본의 이름·스타일 — 이름이 없으면 지금처럼 CIK(기관 상세 제목·뉴스 검색어가 CIK 숫자가 되지 않게)")
    @SuppressWarnings("unchecked")
    void candidateInstitutionUsesStoredName() {
        Map<String, Object> named = new Sec13FService(store(true, "\"name\":\"가짜 후보 (Fake Capital)\",\"style\":\"가치·집중\","))
                .portfolio(CANDIDATE, 8, 30);
        assertThat((Map<String, Object>) named.get("institution"))
                .containsEntry("cik", CANDIDATE)
                .containsEntry("name", "가짜 후보 (Fake Capital)")
                .containsEntry("style", "가치·집중")
                .containsEntry("desc", "");

        Map<String, Object> unnamed = new Sec13FService(store(true)).portfolio(CANDIDATE, 8, 30);
        assertThat((Map<String, Object>) unnamed.get("institution"))
                .containsEntry("name", CANDIDATE)
                .doesNotContainKey("style");
    }

    @Test
    @DisplayName("13F 메뉴 기관의 기관 칸은 지금 그대로(상수 목록의 key·name·cik·desc)")
    @SuppressWarnings("unchecked")
    void menuInstitutionUnchanged() {
        String berkshire = "0001067983";
        StoreReader store = mock(StoreReader.class);
        Snapshot snapshot = new Snapshot(Datasets.sec13f(berkshire, Datasets.MAX_TRACKED_QUARTERS),
                MAPPER.readTree("{\"name\":\"다른 이름\",\"cik\":\"" + berkshire + "\",\"quarters\":" + QUARTERS + "}"), "json", "ok", null, Instant.now());
        when(store.read(eq(Datasets.sec13f(berkshire, Datasets.MAX_TRACKED_QUARTERS)), anyLong(), anyString())).thenReturn(Optional.of(snapshot));
        Map<String, Object> out = new Sec13FService(store).portfolio(berkshire, 8, 30);
        assertThat(out.get("institution")).isEqualTo(Institutions.byCik(berkshire));
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

    // ------------------------------------------------------------ 13F 즐겨찾기(ADR 0048)

    private static final String FAVORITE = "0009900007";

    private static InstitutionCatalog catalogWith(String cik) {
        com.macrodash.store.Sec13FFavoriteStore favorites = mock(com.macrodash.store.Sec13FFavoriteStore.class);
        when(favorites.ready()).thenReturn(true);
        when(favorites.all()).thenReturn(java.util.List.of(
                new com.macrodash.store.Sec13FFavoriteStore.Favorite(cik, "FAKE CAPITAL LLC", "가짜 운용", "설명", Instant.now())));
        return new InstitutionCatalog(favorites);
    }

    private static Snapshot snapshot(String name, String extra) {
        return new Snapshot(name, MAPPER.readTree("{" + extra + "\"quarters\":" + QUARTERS + "}"), "json", "ok", null, Instant.now());
    }

    @Test
    @DisplayName("즐겨찾기는 q30이 없으면 q8을 수집 없이 읽고, 기관 칸은 표시 이름·설명·favorite")
    @SuppressWarnings("unchecked")
    void favoriteReadsQ8Quietly() {
        StoreReader store = store(false);
        when(store.read(eq(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS)), anyLong(), anyString()))
                .thenReturn(Optional.of(snapshot(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS), "")));
        Map<String, Object> out = new Sec13FService(store, catalogWith(FAVORITE)).portfolio(FAVORITE, 8, 30);

        assertThat(out).containsEntry("available", true);
        assertThat((Map<String, Object>) out.get("institution")).containsEntry("name", "가짜 운용").containsEntry("desc", "설명")
                .containsEntry("favorite", true).containsEntry("key", "fav-" + FAVORITE);
        // 두 읽기 모두 quietly 안 — 수집을 부르지 않음
        verify(store, org.mockito.Mockito.times(2)).quietly(any());
    }

    @Test
    @DisplayName("즐겨찾기가 트랙레코드 후보(q30 있음)면 q30을 읽고 q8은 찾지 않음(불변식 2), 스타일은 저장본의 것")
    @SuppressWarnings("unchecked")
    void favoriteCandidateReadsQ30() {
        StoreReader store = store(false);
        when(store.read(eq(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS)), anyLong(), anyString()))
                .thenReturn(Optional.of(snapshot(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS), "\"style\":\"가치·집중\",")));
        Map<String, Object> out = new Sec13FService(store, catalogWith(FAVORITE)).portfolio(FAVORITE, 8, 30);

        assertThat((Map<String, Object>) out.get("institution")).containsEntry("style", "가치·집중").containsEntry("name", "가짜 운용");
        verify(store, never()).read(eq(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS)), anyLong(), anyString());
    }

    @Test
    @DisplayName("즐겨찾기인데 저장본이 없으면 400이 아니라 '아직 모으지 못함'(available=false)")
    @SuppressWarnings("unchecked")
    void favoriteWithoutSnapshot() {
        Map<String, Object> out = new Sec13FService(store(false), catalogWith(FAVORITE)).portfolio(FAVORITE, 8, 30);
        assertThat(out).containsEntry("available", false);
        assertThat(out.get("message").toString()).contains("아직 모으지 못했습니다");
        assertThat((Map<String, Object>) out.get("institution")).containsEntry("favorite", true);
    }

    @Test
    @DisplayName("즐겨찾기가 아닌 CIK는 지금처럼 400(카탈로그가 있어도)")
    void nonFavoriteStillRejected() {
        assertThatThrownBy(() -> new Sec13FService(store(false), catalogWith(FAVORITE)).portfolio("0009900008", 8, 30))
                .isInstanceOf(InvalidRequestException.class);
    }
}
