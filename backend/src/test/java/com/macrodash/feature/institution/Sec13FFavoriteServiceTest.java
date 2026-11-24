package com.macrodash.feature.institution;

import com.macrodash.collector.CollectorClient;
import com.macrodash.read.ComputedCache;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 즐겨찾기 더하기·지우기·검색(ADR 0048) — CIK 검사, 운영자만, 기본 12곳·중복·상한, SEC 확인(원본 13F-HR), 넣은 뒤 수집 네 갈래(저장본 있음·모음·
 * 시간 넘김·후보), 수집 실패면 넣지 않음, 쓰기 뒤 응답 캐시 비움. 수집기·표는 가짜입니다(CIK 99억대).
 */
class Sec13FFavoriteServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String CIK = "0009900001";
    private static final CurrentUser OWNER = new CurrentUser(1, "o@test.local", "OWNER", "PRO", UUID.randomUUID());
    private static final CurrentUser MEMBER = new CurrentUser(2, "m@test.local", "MEMBER", "PRO", UUID.randomUUID());

    private Sec13FFavoriteStore store;
    private StoreReader reader;
    private CollectorClient collector;
    private ComputedCache cache;
    private Sec13FFavoriteService service;
    private final List<Sec13FFavoriteStore.Favorite> rows = new ArrayList<>();
    private Map<String, StoreRepository.SnapshotHead> heads = Map.of();

    @BeforeEach
    void setUp() {
        store = mock(Sec13FFavoriteStore.class);
        reader = mock(StoreReader.class);
        collector = mock(CollectorClient.class);
        cache = mock(ComputedCache.class);
        when(store.ready()).thenReturn(true);
        when(store.all()).thenAnswer(invocation -> List.copyOf(rows));
        when(store.find(anyString())).thenAnswer(invocation -> rows.stream().filter(row -> row.cik().equals(invocation.getArgument(0))).findFirst());
        when(store.count()).thenAnswer(invocation -> rows.size());
        when(store.insert(anyString(), anyString(), any(), any(), any())).thenAnswer(invocation -> {
            Sec13FFavoriteStore.Favorite row = new Sec13FFavoriteStore.Favorite(invocation.getArgument(0), invocation.getArgument(1),
                    invocation.getArgument(2), invocation.getArgument(3), Instant.now());
            rows.add(row);
            return Optional.of(row);
        });
        when(store.updateLabels(anyString(), any(), any())).thenAnswer(invocation -> {
            String cik = invocation.getArgument(0);
            for (int i = 0; i < rows.size(); i++) {
                if (rows.get(i).cik().equals(cik)) {
                    Sec13FFavoriteStore.Favorite old = rows.get(i);
                    Sec13FFavoriteStore.Favorite next = new Sec13FFavoriteStore.Favorite(cik, old.secName(), invocation.getArgument(1),
                            invocation.getArgument(2), old.createdAt());
                    rows.set(i, next);
                    return Optional.of(next);
                }
            }
            return Optional.empty();
        });
        when(store.delete(anyString())).thenAnswer(invocation -> rows.removeIf(row -> row.cik().equals(invocation.getArgument(0))) ? 1 : 0);
        when(reader.readStoredHeads(any())).thenAnswer(invocation -> {
            Collection<String> names = invocation.getArgument(0);
            return heads.entrySet().stream().filter(entry -> names.contains(entry.getKey()))
                    .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
        });
        when(collector.sec13fFiler(anyString())).thenReturn(json("""
                {"cik":"0009900001","name":"FAKE CAPITAL LLC","latest13F":{"filingDate":"2026-08-14","reportDate":"2026-06-30"},"error":null}"""));
        service = new Sec13FFavoriteService(new InstitutionCatalog(store), store, reader, collector, cache);
    }

    private static Optional<JsonNode> json(String text) {
        return Optional.of(MAPPER.readTree(text));
    }

    @Test
    @DisplayName("CIK는 숫자 1~10자리 → 10자리, 그 밖은 400")
    void normalizeCik() {
        assertThat(Sec13FFavoriteService.normalizeCik(" 9900001 ")).isEqualTo(CIK);
        for (String bad : new String[]{null, "", "0", "abc", "12345678901", "-1"}) {
            assertThatThrownBy(() -> Sec13FFavoriteService.normalizeCik(bad)).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("운영자가 아니면 검색·더하기·지우기 모두 403이고 수집기를 부르지 않는다")
    void ownerOnly() {
        assertThat(service.search(MEMBER, "fake").status()).isEqualTo(403);
        assertThat(service.add(MEMBER, CIK, null, null).status()).isEqualTo(403);
        assertThat(service.remove(null, CIK).status()).isEqualTo(403);
        verify(collector, never()).sec13fSearch(anyString());
        verify(collector, never()).sec13fFiler(anyString());
    }

    @Test
    @DisplayName("기본 12곳·중복·상한 20곳은 409 — SEC를 부르지 않음")
    void rejectsDefaultDuplicateAndLimit() {
        assertThat(service.add(OWNER, Institutions.ciks().get(0), null, null).status()).isEqualTo(409);
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE", null, null, Instant.now()));
        assertThat(service.add(OWNER, CIK, null, null).status()).isEqualTo(409);
        for (int i = 0; rows.size() < InstitutionCatalog.FAVORITE_LIMIT; i++) {
            rows.add(new Sec13FFavoriteStore.Favorite("00098000" + String.format("%02d", i), "FILL", null, null, Instant.now()));
        }
        assertThat(service.add(OWNER, "9900002", null, null).status()).isEqualTo(409);
        verify(collector, never()).sec13fFiler(anyString());
    }

    @Test
    @DisplayName("SEC 최근 공시에 원본 13F-HR이 없거나 SEC 확인이 실패하면 넣지 않음(422)")
    void requiresThirteenF() {
        when(collector.sec13fFiler(anyString())).thenReturn(json("{\"cik\":\"0009900001\",\"name\":\"FAKE\",\"latest13F\":null,\"error\":null}"));
        assertThat(service.add(OWNER, CIK, null, null).status()).isEqualTo(422);
        when(collector.sec13fFiler(anyString())).thenReturn(json("{\"cik\":\"0009900001\",\"name\":null,\"latest13F\":null,\"error\":\"이 CIK의 SEC 공시 목록이 없습니다\"}"));
        assertThat(service.add(OWNER, CIK, null, null).body().get("message").toString()).contains("공시 목록이 없습니다");
        when(collector.sec13fFiler(anyString())).thenReturn(Optional.empty());
        assertThat(service.add(OWNER, CIK, null, null).status()).isEqualTo(502);
        verify(store, never()).insert(anyString(), anyString(), any(), any(), any());
    }

    @Test
    @DisplayName("저장본이 이미 있으면(q30·q8) 수집을 부르지 않고 stored")
    void storedSkipsCollection() {
        heads = Map.of(Datasets.sec13f(CIK, Datasets.TRACK_RECORD_QUARTERS), new StoreRepository.SnapshotHead(Instant.now(), "2026-06-30"));
        var result = service.add(OWNER, CIK, " 가짜 운용 ", " ");
        assertThat(result.status()).isEqualTo(200);
        assertThat(result.body()).containsEntry("collection", "stored");
        assertThat(rows).singleElement().satisfies(row -> {
            assertThat(row.secName()).isEqualTo("FAKE CAPITAL LLC");
            assertThat(row.displayName()).isEqualTo("가짜 운용");
            assertThat(row.description()).isNull();
        });
        verify(collector, never()).sec13fCollectFavorite(anyString());
        verify(cache).clear();
    }

    @Test
    @DisplayName("저장본이 없으면 그 기관 수집을 기다림 — 모으면 collected, 시간 넘김은 collecting(줄 남김), 후보면 waiting")
    void collectionOutcomes() {
        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json("{\"cik\":\"0009900001\",\"ok\":true,\"refused\":null,\"error\":null,\"quarters\":8}"));
        assertThat(service.add(OWNER, CIK, null, null).body()).containsEntry("collection", "collected");
        assertThat(service.remove(OWNER, CIK).status()).isEqualTo(200);

        when(collector.sec13fCollectFavorite(CIK)).thenReturn(Optional.empty());
        assertThat(service.add(OWNER, CIK, null, null).body()).containsEntry("collection", "collecting");
        assertThat(rows).hasSize(1);
        rows.clear();

        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json("{\"cik\":\"0009900001\",\"ok\":false,\"refused\":\"track_record\",\"error\":null}"));
        assertThat(service.add(OWNER, CIK, null, null).body()).containsEntry("collection", "waiting");
        assertThat(rows).hasSize(1);
    }

    @Test
    @DisplayName("수집이 실패를 돌려주면 줄을 지우고 422와 사유(넣지 않은 것과 같음)")
    void failedCollectionRemovesRow() {
        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json("{\"cik\":\"0009900001\",\"ok\":false,\"refused\":null,\"error\":\"www.sec.gov HTTP 503\"}"));
        var result = service.add(OWNER, CIK, null, null);
        assertThat(result.status()).isEqualTo(422);
        assertThat(result.body().get("message").toString()).contains("HTTP 503");
        assertThat(rows).isEmpty();
    }

    @Test
    @Disabled("QA-1014: 수집기가 모으지 않는다고 답한 CIK를 '모았습니다'로 답하고 줄을 남김")
    @DisplayName("QA-1014: 수집기가 모으지 않는 대상이라고 답하면(후보의 지금 CIK 말고) 줄을 지우고 409와 사유")
    void refusedTargetsAreNotKept() {
        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json("{\"cik\":\"0009900001\",\"ok\":false,\"refused\":\"default\",\"error\":null}"));
        var merged = service.add(OWNER, CIK, null, null);
        assertThat(merged.status()).isEqualTo(409);
        assertThat(merged.body().get("message")).isEqualTo("기본 기관에 합쳐 모으는 CIK라 따로 더할 수 없습니다.");
        assertThat(rows).isEmpty();

        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json(
                "{\"cik\":\"0009900001\",\"ok\":false,\"refused\":\"track_record_predecessor\",\"currentCik\":\"0009900777\",\"error\":null}"));
        var predecessor = service.add(OWNER, CIK, null, null);
        assertThat(predecessor.status()).isEqualTo(409);
        assertThat(predecessor.body().get("message")).isEqualTo("이 CIK는 0009900777의 옛 제출자 번호입니다 — 그 CIK로 더하세요.");
        assertThat(rows).isEmpty();

        when(collector.sec13fCollectFavorite(CIK)).thenReturn(json("{\"cik\":\"0009900001\",\"ok\":false,\"refused\":\"not_favorite\",\"error\":null}"));
        var other = service.add(OWNER, CIK, null, null);
        assertThat(other.status()).isEqualTo(409);
        assertThat(other.body().get("message")).isEqualTo("이 기관은 13F를 모으지 않는 대상입니다(not_favorite).");
        assertThat(rows).isEmpty();
    }

    @Test
    @DisplayName("표시 이름 60자·설명 200자 넘음과 제어 글자는 400")
    void textLimits() {
        assertThatThrownBy(() -> service.add(OWNER, CIK, "가".repeat(61), null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.add(OWNER, CIK, null, "a\u0007b")).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("지우기 — 없으면 404, 있으면 지우고 캐시 비움(저장본은 건드리지 않음)")
    void remove() {
        assertThat(service.remove(OWNER, CIK).status()).isEqualTo(404);
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE", null, null, Instant.now()));
        assertThat(service.remove(OWNER, "9900001").status()).isEqualTo(200);
        assertThat(rows).isEmpty();
        verify(cache).clear();
    }

    @Test
    @DisplayName("이름 검색 — 후보마다 기본 12곳·즐겨찾기 표시, 검색어 2~60자, SEC 실패는 502")
    void search() {
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE", null, null, Instant.now()));
        when(collector.sec13fSearch("fake capital")).thenReturn(json("""
                {"query":"fake capital","candidates":[{"cik":"0009900001","name":"FAKE CAPITAL LLC"},{"cik":"0001067983","name":"BERKSHIRE"},
                 {"cik":"0009900003","name":"FAKE CAPITAL II"}],"error":null}"""));
        var result = service.search(OWNER, "  fake   capital ");
        assertThat(result.status()).isEqualTo(200);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> candidates = (List<Map<String, Object>>) result.body().get("candidates");
        assertThat(candidates).extracting(row -> row.get("status")).containsExactly("favorite", "default", null);
        assertThatThrownBy(() -> service.search(OWNER, "a")).isInstanceOf(InvalidRequestException.class);
        when(collector.sec13fSearch("other")).thenReturn(json("{\"query\":\"other\",\"candidates\":[],\"error\":\"www.sec.gov HTTP 403\"}"));
        assertThat(service.search(OWNER, "other").status()).isEqualTo(502);
    }

    @Test
    @DisplayName("목록 줄 — 저장본 q30이 있으면 q30, 없으면 q8, 없으면 stored=false")
    void listEntries() {
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE CAPITAL LLC", "가짜 운용", "설명", Instant.now()));
        rows.add(new Sec13FFavoriteStore.Favorite("0009900002", "SECOND", null, null, Instant.now()));
        heads = Map.of(Datasets.sec13f(CIK, Datasets.MAX_TRACKED_QUARTERS), new StoreRepository.SnapshotHead(Instant.now(), "2026-06-30"));
        List<Map<String, Object>> entries = service.listEntries();
        assertThat(entries.get(0)).containsEntry("name", "가짜 운용").containsEntry("secName", "FAKE CAPITAL LLC").containsEntry("stored", true)
                .containsEntry("source", "q8").containsEntry("latestReportDate", "2026-06-30").containsEntry("key", "fav-" + CIK);
        assertThat(entries.get(1)).containsEntry("stored", false).containsEntry("source", null).containsEntry("desc", "");
    }

    @Test
    @DisplayName("지우면 그 기관의 13F 신규 편입 알림 규칙도 함께 지우고 수를 알림, 운영자 목록에는 규칙 수")
    void removeDeletesAlertRules() {
        com.macrodash.store.AlertStore alerts = org.mockito.Mockito.mock(com.macrodash.store.AlertStore.class);
        when(alerts.ready()).thenReturn(true);
        when(alerts.countInstitutionRules(CIK)).thenReturn(3);
        when(alerts.deleteInstitutionRules(CIK)).thenReturn(3);
        Sec13FFavoriteService withAlerts = new Sec13FFavoriteService(new InstitutionCatalog(store), store, reader, collector, cache, alerts);
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE", null, null, Instant.now()));

        assertThat(withAlerts.listEntries(true).get(0)).containsEntry("alertRules", 3);
        assertThat(withAlerts.listEntries(false).get(0)).doesNotContainKey("alertRules");
        var result = withAlerts.remove(OWNER, CIK);
        assertThat(result.body()).containsEntry("removedAlertRules", 3);
        assertThat(result.body().get("message").toString()).contains("알림 규칙 3개도 함께");
        verify(alerts).deleteInstitutionRules(CIK);
    }

    // QA-983: 한글 검색어를 수집기·SEC로 보내면 SEC가 47초쯤 뒤 503(2026-11-23 서버 재현) — 백엔드가 25초에 끊고 '수집기에 닿지 못해'로 적음.
    @Test
    @DisplayName("QA-983 영문(ASCII)이 아닌 검색어는 수집기를 부르지 않고 400 — SEC 등록 이름은 영문")
    void nonAsciiQueryRejectedBeforeCollector() {
        assertThatThrownBy(() -> service.search(OWNER, "아팔루사"))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("영문");
        verify(collector, never()).sec13fSearch(anyString());
    }

    // QA-986: 이름 검색 후보에 최근 원본 13F-HR 공시일이 없어 오래 전에 멈춘 제출자인지 고르기 전에 알 수 없었습니다.
    @Test
    @DisplayName("QA-986 이름 검색 후보마다 최근 13F 공시일(수집기가 확인한 값 그대로 — 확인 못 했으면 checked=false)")
    @SuppressWarnings("unchecked")
    void searchCarriesLatestThirteenF() {
        when(collector.sec13fSearch("fake")).thenReturn(json("""
                {"query":"fake","candidates":[
                  {"cik":"0009900003","name":"FAKE ONE","latest13F":{"filingDate":"2026-08-14","reportDate":"2026-06-30"},"checked":true},
                  {"cik":"0009900004","name":"FAKE TWO","latest13F":null,"checked":true},
                  {"cik":"0009900005","name":"FAKE THREE","latest13F":null,"checked":false}],"error":null}"""));
        List<Map<String, Object>> rows = (List<Map<String, Object>>) service.search(OWNER, "fake").body().get("candidates");
        assertThat(rows.get(0)).containsEntry("latest13F", Map.of("filingDate", "2026-08-14", "reportDate", "2026-06-30")).containsEntry("checked", true);
        assertThat(rows.get(1)).containsEntry("latest13F", null).containsEntry("checked", true);
        assertThat(rows.get(2)).containsEntry("checked", false);
    }

    @Test
    @DisplayName("표시 이름·설명 고치기(운영자) — 받은 값으로 바꾸고(비우면 SEC 이름·설명 없음) 캐시 비움, 없는 CIK 404, 회원 403, 글자 검사")
    void editLabels() {
        rows.add(new Sec13FFavoriteStore.Favorite(CIK, "FAKE CAPITAL LLC", "가짜 운용", "옛 설명", Instant.now()));

        var result = service.editLabels(OWNER, "9900001", " 새 이름 ", " 새 설명 ");
        assertThat(result.status()).isEqualTo(200);
        assertThat(rows.get(0).displayName()).isEqualTo("새 이름");
        assertThat(rows.get(0).description()).isEqualTo("새 설명");
        @SuppressWarnings("unchecked")
        Map<String, Object> favorite = (Map<String, Object>) result.body().get("favorite");
        assertThat(favorite).containsEntry("name", "새 이름").containsEntry("desc", "새 설명");
        verify(cache).clear();

        assertThat(service.editLabels(OWNER, CIK, " ", null).status()).isEqualTo(200);
        assertThat(rows.get(0).name()).isEqualTo("FAKE CAPITAL LLC");
        assertThat(rows.get(0).description()).isNull();

        assertThat(service.editLabels(OWNER, "0009900009", "x", null).status()).isEqualTo(404);
        assertThat(service.editLabels(MEMBER, CIK, "x", null).status()).isEqualTo(403);
        assertThatThrownBy(() -> service.editLabels(OWNER, CIK, "가".repeat(61), null)).isInstanceOf(InvalidRequestException.class);
        verify(collector, never()).sec13fFiler(anyString());
    }
}
