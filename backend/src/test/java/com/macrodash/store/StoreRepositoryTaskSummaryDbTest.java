package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-982 — 태스크별 최근 실행 요약({@link StoreRepository#TASK_SUMMARY_SQL})의 계획. 실행 기록 4만 행(자주 도는 태스크 10개가 뒤쪽, 드물게 도는
 * 태스크 31개가 앞쪽에만 — 값은 모두 가짜)을 시험마다 새 스키마의 빈 표에 넣고, 통계가 없을 때와 {@code ANALYZE} 뒤에 실제 질의를 EXPLAIN 합니다.
 * 수집기 표라 백엔드는 읽기만 하지만(ADR 0008), 이 시험은 자기 스키마에 만든 사본에만 씁니다.
 */
class StoreRepositoryTaskSummaryDbTest {

    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private String schema;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        admin = new JdbcTemplate(dataSource(url));
        schema = "qa982_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        admin.execute("CREATE SCHEMA " + schema);
        admin.execute("CREATE TABLE " + schema + ".collector_task_runs (LIKE public.collector_task_runs INCLUDING ALL)");
        jdbc = new JdbcTemplate(dataSource(url + "?currentSchema=" + schema));
        jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms, detail) "
                + "SELECT 'qa982_rare_' || lpad((g % 31)::text, 2, '0'), 'slow', CASE WHEN g % 7 = 0 THEN 'error' ELSE 'ok' END, "
                + "timestamptz '2026-08-01' + g * interval '1 minute', g % 500, NULL FROM generate_series(0, 3099) g");
        jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms, detail) "
                + "SELECT 'qa982_frequent_' || lpad((g % 10)::text, 2, '0'), 'fast', 'ok', "
                + "timestamptz '2026-09-01' + g * interval '1 minute', g % 500, NULL FROM generate_series(0, 36899) g");
        // 드문 태스크 하나는 마지막 행이 '아직 진행 중' 안내(QA-139) — 요약은 그 앞 행을 써야 합니다.
        jdbc.update("INSERT INTO collector_task_runs (task, speed, status, started_at, duration_ms, detail) "
                + "VALUES ('qa982_rare_00', 'slow', 'empty', timestamptz '2026-10-01', 0, ?)", StoreRepository.STILL_RUNNING_PREFIX + " — 가짜 안내");
    }

    @AfterEach
    void tearDown() {
        admin.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    }

    private static DriverManagerDataSource dataSource(String url) {
        return new DriverManagerDataSource(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
    }

    @Test
    @DisplayName("QA-982 요약은 예전 정의(DISTINCT ON)와 같은 행을 같은 순서로 — '아직 진행 중' 안내 행은 건너뜀")
    void sameRowsAsDistinctOn() {
        List<Map<String, Object>> expected = jdbc.queryForList("SELECT DISTINCT ON (task) task, speed, status, started_at, duration_ms, detail, run_id "
                + "FROM collector_task_runs WHERE NOT (status = 'empty' AND detail IS NOT NULL AND detail LIKE ?) ORDER BY task, id DESC",
                StoreRepository.STILL_RUNNING_PREFIX + "%");
        List<Map<String, Object>> actual = jdbc.queryForList(StoreRepository.TASK_SUMMARY_SQL, StoreRepository.STILL_RUNNING_PREFIX + "%");
        assertThat(actual).hasSize(41).isEqualTo(expected);
        assertThat(actual.stream().filter(r -> "qa982_rare_00".equals(r.get("task"))).findFirst().orElseThrow().get("status"))
                .isNotEqualTo("empty");
    }

    @Test
    @Disabled("QA-982 재현 — 통계가 있으면 계획기가 기본 키를 거꾸로 훑어 드문 태스크마다 표 대부분을 읽음(고친 뒤 켬)")
    @DisplayName("QA-982 요약은 통계가 있든 없든 기본 키를 거꾸로 훑지 않고 읽는 블록이 2천 개 아래")
    void planDoesNotScanPrimaryKeyBackward() {
        for (boolean analyzed : new boolean[]{false, true}) {
            if (analyzed) {
                jdbc.execute("ANALYZE collector_task_runs");
            }
            String json = jdbc.queryForObject("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + StoreRepository.TASK_SUMMARY_SQL, String.class,
                    StoreRepository.STILL_RUNNING_PREFIX + "%");
            JsonNode plan = new ObjectMapper().readTree(json).get(0).get("Plan");
            String label = "통계 " + (analyzed ? "있음" : "없음");
            assertThat(backwardPkeyScans(plan)).as(label).isEmpty();
            assertThat(plan.get("Shared Hit Blocks").asLong() + plan.get("Shared Read Blocks").asLong()).as(label).isLessThan(2_000);
        }
    }

    private static List<String> backwardPkeyScans(JsonNode node) {
        List<String> found = new ArrayList<>();
        if ("collector_task_runs".equals(node.path("Relation Name").asString(""))
                && "Backward".equals(node.path("Scan Direction").asString(""))
                && node.path("Index Name").asString("").endsWith("_pkey")) {
            found.add(node.path("Index Name").asString(""));
        }
        for (JsonNode child : node.path("Plans")) {
            found.addAll(backwardPkeyScans(child));
        }
        return found;
    }
}
