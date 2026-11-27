package com.macrodash.feature.institution;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.ComputedCache;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.Sec13FFavoriteStore;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * QA-1040 — 기관 스타일 요약·유사도({@code /api/guru/profiles}·{@code /api/guru/similarity})가 13F와 상관없는 저장본이 새로 수집될 때마다, 그리고
 * 60초마다 다시 계산됨. 5분 주기 태스크가 도는 운영에서는 화면을 열 때 거의 매번이었습니다(운영 100 ms·250~280 ms, 즐겨찾기 19곳의 QA 500~600 ms —
 * 다시 계산할 때마다 13F 저장본을 DB에서 다듬어 읽음).
 *
 * <p>실제 표로 봅니다(테스트 DB — 기본 12곳의 13F 저장본과 가짜 즐겨찾기 한 곳을 만들고 끝나면 지움). 시간이 아니라 계산 횟수로:
 * 계산이 읽는 입력(13F 저장본·즐겨찾기 목록)이 그대로면 다른 저장본이 새로 쓰여도 다시 계산하지 않고, 그 입력이 바뀌면 다음 호출에 다시 계산합니다.
 * 60초 규칙을 벗어나는 것은 {@code ComputedCacheInputRuleTest}가 시계를 옮겨 봅니다.
 */
class GuruStyleMemoQa1040DbTest {

    private static final String FAVORITE = "0009901040";
    private static final String OTHER = "t.qa1040.other";

    private JdbcTemplate jdbc;
    private InstitutionController controller;
    private final AtomicInteger profilesComputed = new AtomicInteger();
    private final AtomicInteger similarityComputed = new AtomicInteger();

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        cleanUp();
        for (String cik : Institutions.ciks()) {
            put(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), 2);
        }
        put(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS), 3);

        StoreRepository repository = new StoreRepository(jdbc, new ObjectMapper());
        CollectorClient collector = mock(CollectorClient.class);
        when(collector.runTask(anyString(), anyBoolean())).thenReturn(Optional.empty());
        AppProperties properties = new AppProperties();
        properties.setReadMode("auto");
        StoreReader store = new StoreReader(repository, collector, properties);
        InstitutionCatalog catalog = new InstitutionCatalog(new Sec13FFavoriteStore(jdbc, new SchemaCheck(jdbc)));
        GuruService guru = new GuruService(store, catalog) {
            @Override
            public Map<String, Object> profiles() {
                profilesComputed.incrementAndGet();
                return super.profiles();
            }

            @Override
            public Map<String, Object> similarity() {
                similarityComputed.incrementAndGet();
                return super.similarity();
            }
        };
        controller = new InstitutionController(new Sec13FService(store, catalog), guru, mock(Sec13FFavoriteService.class),
                new ComputedCache(repository));
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM sec13f_favorites WHERE cik = ?", FAVORITE);
        jdbc.update("DELETE FROM snapshots WHERE name = ? OR name = ANY (?)", OTHER, names().toArray(String[]::new));
    }

    private static List<String> names() {
        List<String> names = new java.util.ArrayList<>(Institutions.ciks().stream()
                .map(cik -> Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS)).toList());
        names.add(Datasets.sec13f(FAVORITE, Datasets.MAX_TRACKED_QUARTERS));
        names.add(Datasets.sec13f(FAVORITE, Datasets.TRACK_RECORD_QUARTERS));
        return names;
    }

    /** 13F 형식 저장본 하나(한 분기, 보유 {@code holdings}줄) — 넣거나 고칠 때마다 수집 시각을 새로 적습니다(수집기 put_snapshot과 같은 꼴). */
    private void put(String name, int holdings) {
        StringBuilder rows = new StringBuilder();
        for (int i = 0; i < holdings; i++) {
            rows.append(i == 0 ? "" : ",").append("{\"name\":\"QA FAKE ").append(i).append("\",\"cusip\":\"00000Q10").append(i)
                    .append("\",\"weight\":").append(100.0 / holdings).append(",\"value\":").append(1000 + i).append("}");
        }
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb) ON CONFLICT (name) DO UPDATE SET payload = EXCLUDED.payload, "
                        + "collected_at = clock_timestamp()",
                name, "{\"quarters\":[{\"reportDate\":\"2026-09-30\",\"filingDate\":\"2026-11-14\",\"totalValue\":100000,\"holdings\":[" + rows + "]}]}");
    }

    private static List<?> rows(Map<String, Object> body) {
        return (List<?>) body.get("rows");
    }

    @Test
    @Disabled("QA-1040: 다른 저장본이 새로 수집되면 13F 계산 결과까지 버려 다시 계산함")
    @DisplayName("QA-1040: 13F와 상관없는 저장본이 새로 수집돼도 스타일 요약·유사도는 다시 계산하지 않는다")
    void unrelatedCollectionDoesNotRecompute() {
        Map<String, Object> profiles = controller.guruProfiles();
        Map<String, Object> similarity = controller.guruSimilarity();
        assertThat(rows(profiles)).hasSize(Institutions.ciks().size());

        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, '{}'::jsonb)", OTHER);   // 5분 주기 태스크가 다른 저장본을 새로 씀

        assertThat(controller.guruProfiles()).isSameAs(profiles);
        assertThat(controller.guruSimilarity()).isSameAs(similarity);
        assertThat(profilesComputed).hasValue(1);
        assertThat(similarityComputed).hasValue(1);
    }

    @Test
    @DisplayName("13F 저장본 하나가 새로 수집되면 다음 호출에 다시 계산해 새 값을 보인다")
    void recollectedFilingRecomputes() {
        String cik = Institutions.ciks().get(0);
        Map<String, Object> before = controller.guruProfiles();

        put(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), 5);
        Map<String, Object> after = controller.guruProfiles();

        assertThat(after).isNotSameAs(before);
        assertThat(profilesComputed).hasValue(2);
        assertThat(rows(after)).anySatisfy(row -> {
            assertThat(((Map<?, ?>) row).get("cik")).isEqualTo(cik);
            assertThat(((Map<?, ?>) row).get("holdingCount")).isEqualTo(5);
        });
    }

    @Test
    @Disabled("QA-1040: 응답 캐시가 즐겨찾기 표를 몰라, 서비스가 캐시를 비워 주지 않는 변경(다른 프로세스·직접 고침)은 60초까지 옛 목록")
    @DisplayName("즐겨찾기를 더하거나 빼면 다음 호출에 다시 계산한다 — 저장본이 그대로여도")
    void favoriteChangesRecompute() {
        assertThat(rows(controller.guruProfiles())).hasSize(Institutions.ciks().size());

        jdbc.update("INSERT INTO sec13f_favorites (cik, sec_name) VALUES (?, 'QA FAKE FILER 1040')", FAVORITE);
        Map<String, Object> added = controller.guruProfiles();
        assertThat(rows(added)).hasSize(Institutions.ciks().size() + 1);
        assertThat(controller.guruProfiles()).isSameAs(added);

        jdbc.update("DELETE FROM sec13f_favorites WHERE cik = ?", FAVORITE);
        assertThat(rows(controller.guruProfiles())).hasSize(Institutions.ciks().size());
        assertThat(profilesComputed).hasValue(3);
    }
}
