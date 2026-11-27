package com.macrodash.feature.institution;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Sec13FFavoriteStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 13F 계열 계산이 읽는 입력의 판({@link InstitutionHistory#inputVersion}, QA-1040) — 그 계산이 읽는 것 가운데 하나라도 바뀌면 판이 달라지고,
 * 읽지 않는 것이 바뀌면 그대로다. 판이 같은 동안 응답 캐시가 결과를 다시 계산하지 않으므로, 빠뜨린 입력이 있으면 옛 결과가 남습니다.
 */
class InstitutionHistoryInputVersionTest {

    private static final Instant T0 = Instant.parse("2026-11-20T03:00:00Z");
    private static final String FAVORITE = "0009900001";

    private final StoreReader store = mock(StoreReader.class);
    private final Sec13FFavoriteStore favoriteStore = mock(Sec13FFavoriteStore.class);
    private final List<Sec13FFavoriteStore.Favorite> favorites = new ArrayList<>();
    private final Map<String, Instant> tracked = new LinkedHashMap<>();
    private final Map<String, Instant> favoriteSnapshots = new LinkedHashMap<>();
    private InstitutionHistory history;

    @BeforeEach
    void setUp() {
        for (String cik : Institutions.ciks()) {
            tracked.put(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), T0);
        }
        when(store.collectedAt(anyCollection(), anyLong(), eq("sec_13f"))).thenAnswer(call -> new LinkedHashMap<>(tracked));
        when(store.readStoredCollectedAt(anyCollection())).thenAnswer(call -> new LinkedHashMap<>(favoriteSnapshots));
        when(favoriteStore.ready()).thenReturn(true);
        when(favoriteStore.all()).thenAnswer(call -> List.copyOf(favorites));
        history = new InstitutionHistory(store, new InstitutionCatalog(favoriteStore));
    }

    private void favorite(String cik, String displayName, String description) {
        favorites.removeIf(row -> row.cik().equals(cik));
        favorites.add(new Sec13FFavoriteStore.Favorite(cik, "QA FAKE FILER", displayName, description, T0));
    }

    @Test
    @DisplayName("입력이 그대로면 같은 판 — 부를 때마다 달라지지 않는다")
    void sameInputsSameVersion() {
        favorite(FAVORITE, "가짜 제출자", "설명");
        favoriteSnapshots.put(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS), T0);

        String first = history.inputVersion();

        assertThat(first).matches("[0-9a-f]{64}");
        assertThat(history.inputVersion()).isEqualTo(first);
    }

    @Test
    @DisplayName("기본 12곳의 13F 저장본 하나가 새로 수집되면 판이 바뀐다 — 수집 시각은 read와 같은 규칙(하루·sec_13f)으로 본다")
    void defaultSnapshotRecollected() {
        String before = history.inputVersion();
        tracked.put(Datasets.sec13f(Institutions.ciks().get(3), Datasets.MAX_TRACKED_QUARTERS), T0.plusSeconds(3600));

        assertThat(history.inputVersion()).isNotEqualTo(before);
        List<String> names = Institutions.ciks().stream().map(cik -> Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS)).toList();
        verify(store, org.mockito.Mockito.atLeastOnce()).collectedAt(names, Datasets.MAX_AGE_SLOW, "sec_13f");
    }

    @Test
    @DisplayName("즐겨찾기를 더하거나 빼면, 표시 이름·설명을 고치면 판이 바뀐다")
    void favoritesChange() {
        String none = history.inputVersion();

        favorite(FAVORITE, null, null);
        String added = history.inputVersion();
        favorite(FAVORITE, "새 이름", null);
        String renamed = history.inputVersion();
        favorite(FAVORITE, "새 이름", "새 설명");
        String described = history.inputVersion();
        favorites.clear();

        assertThat(List.of(none, added, renamed, described)).doesNotHaveDuplicates();
        assertThat(history.inputVersion()).isEqualTo(none);
    }

    @Test
    @DisplayName("즐겨찾기의 저장본이 생기거나(모으는 중 → 모음) 새로 수집되면 판이 바뀐다 — q30과 q8 둘 다 본다")
    void favoriteSnapshotsChange() {
        favorite(FAVORITE, null, null);
        String collecting = history.inputVersion();

        favoriteSnapshots.put(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS), T0);
        String q8 = history.inputVersion();
        favoriteSnapshots.put(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS), T0);
        String q30 = history.inputVersion();
        favoriteSnapshots.put(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS), T0.plusSeconds(60));
        String recollected = history.inputVersion();

        assertThat(List.of(collecting, q8, q30, recollected)).doesNotHaveDuplicates();
        verify(store, org.mockito.Mockito.atLeastOnce()).readStoredCollectedAt(List.of(
                Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS), Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS)));
    }

    @Test
    @DisplayName("기본 12곳과 겹치는 즐겨찾기 줄은 계산이 쓰지 않으므로 판에도 넣지 않는다")
    void favoriteThatIsADefaultIsIgnored() {
        String before = history.inputVersion();
        favorite(Institutions.ciks().get(0), "겹치는 이름", null);

        assertThat(history.inputVersion()).isEqualTo(before);
    }

    @Test
    @DisplayName("기본 12곳 가운데 저장본이 없는 곳이 있으면 판이 없다(null) — 계산이 수집을 기다리는 경우라 예전 규칙대로")
    void missingDefaultSnapshotMeansNoVersion() {
        tracked.remove(Datasets.sec13f(Institutions.ciks().get(0), Datasets.MAX_TRACKED_QUARTERS));

        assertThat(history.inputVersion()).isNull();
    }

    @Test
    @DisplayName("DB를 읽지 못하면 판이 없다(null) — 캐시 없이 계산해 지금의 오류 응답이 그대로 나간다")
    void databaseFailureMeansNoVersion() {
        when(store.collectedAt(anyCollection(), anyLong(), eq("sec_13f"))).thenThrow(new DataAccessResourceFailureException("시험 — DB 끊김"));

        assertThat(history.inputVersion()).isNull();
    }
}
