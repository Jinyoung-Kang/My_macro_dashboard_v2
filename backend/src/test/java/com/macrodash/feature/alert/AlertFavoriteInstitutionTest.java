package com.macrodash.feature.alert;

import com.macrodash.feature.institution.InstitutionCatalog;
import com.macrodash.feature.institution.InstitutionHistory;
import com.macrodash.read.StoreReader;
import com.macrodash.store.AlertStore;
import com.macrodash.store.Datasets;
import com.macrodash.store.RegimeLogStore;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.CurrentUser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 신규 편입 알림의 관심 기관 = 기본 12곳 + 13F 즐겨찾기(ADR 0048 단계 3) — 규칙 검증이 즐겨찾기를 받고(그 밖은 400), 규칙 설명·알림 제목은 표시 이름,
 * 평가는 즐겨찾기 저장본을 수집 없이 읽음. 값은 모두 가짜(CIK 99억대).
 */
class AlertFavoriteInstitutionTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String FAV = "0009900001";
    private static final CurrentUser PRO = new CurrentUser(2, "p@x", "MEMBER", "PRO", null);

    private static InstitutionCatalog catalog() {
        Sec13FFavoriteStore favorites = mock(Sec13FFavoriteStore.class);
        when(favorites.ready()).thenReturn(true);
        when(favorites.all()).thenReturn(List.of(new Sec13FFavoriteStore.Favorite(FAV, "FAKE CAPITAL LLC", "가짜 운용", null, Instant.now())));
        return new InstitutionCatalog(favorites);
    }

    @Test
    @DisplayName("관심 기관 규칙은 즐겨찾기 CIK를 받고 설명은 표시 이름, 목록 밖 CIK는 400")
    void ruleAcceptsFavorite() {
        AlertStore store = mock(AlertStore.class);
        AlertService service = new AlertService(store, MAPPER, new InstitutionHistory(null, catalog()));

        assertThat(service.create(PRO, "INSTITUTION_NEW", MAPPER.createObjectNode().put("cik", FAV)).status()).isEqualTo(200);
        assertThat(service.create(PRO, "INSTITUTION_NEW", MAPPER.createObjectNode().put("cik", "0009900009")).status()).isEqualTo(400);
        verify(store).insertRule(eq(2L), eq("INSTITUTION_NEW"), any());

        when(store.rules(2)).thenReturn(List.of(new AlertStore.Rule(5, 2, "INSTITUTION_NEW", MAPPER.createObjectNode().put("cik", FAV), true, Instant.now())));
        List<Map<String, Object>> rules = service.rules(PRO);
        assertThat(rules.get(0)).containsEntry("description", "13F 신규 편입 — 가짜 운용");
    }

    @Test
    @DisplayName("평가는 즐겨찾기 q8을 수집 없이 읽고, 알림 제목에 표시 이름")
    void evaluatorReadsFavoriteQuietly() {
        StoreReader store = mock(StoreReader.class);
        when(store.read(anyString(), anyLong(), anyString())).thenReturn(Optional.empty());
        when(store.readStoredFirstQuarters(anyString(), org.mockito.ArgumentMatchers.anyInt())).thenReturn(Optional.empty());
        when(store.quietly(any())).thenAnswer(invocation -> ((Supplier<?>) invocation.getArgument(0)).get());
        String name = Datasets.sec13f(FAV, Datasets.MAX_TRACKED_QUARTERS);
        when(store.read(eq(name), anyLong(), anyString())).thenReturn(Optional.of(new Snapshot(name, MAPPER.readTree("""
                {"quarters":[{"reportDate":"2026-06-30","filingDate":"2026-08-12","holdings":[
                    {"name":"X CORP","cusip":"X00000001","class":"COM","value":100,"shares":10,"weight":100.0}]},
                 {"reportDate":"2026-03-31","filingDate":"2026-05-11","holdings":[
                    {"name":"Y CORP","cusip":"Y00000001","class":"COM","value":100,"shares":10,"weight":100.0}]}]}"""),
                "json", "ok", null, Instant.now())));
        AlertStore alerts = mock(AlertStore.class);
        when(alerts.enabledRules("INSTITUTION_NEW")).thenReturn(List.of(new AlertStore.Rule(
                1L, 1L, "INSTITUTION_NEW", MAPPER.createObjectNode().put("cik", FAV), true, Instant.now())));
        Clock clock = Clock.fixed(Instant.parse("2026-08-20T03:00:00Z"), ZoneOffset.UTC);

        new AlertEvaluator(alerts, mock(RegimeLogStore.class), store, mock(StoreRepository.class), MAPPER, clock, catalog()).institutionEvents();

        verify(store).quietly(any());
        verify(alerts).insertEvent(eq("INSTITUTION_NEW"), eq("13f:" + FAV + ":2026-08-12"), any(), contains("가짜 운용"), anyString(), any());
    }
}
