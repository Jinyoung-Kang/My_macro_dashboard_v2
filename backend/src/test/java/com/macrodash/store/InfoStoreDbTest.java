package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 정보 수집 표 읽기(V33, ADR 0035)와 끊김 알림 기록(V34) — 실제 테스트 DB(macrodash_test). 수집기 표는 저장소에 쓰는 메서드가 없고 시험만
 * {@code test-} 접두어 행을 넣고 지웁니다.
 */
class InfoStoreDbTest {

    private static final Instant NOW = Instant.parse("2026-11-11T09:00:00Z");

    private JdbcTemplate jdbc;
    private InfoStore info;
    private SourceAlertStore alerts;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        SchemaCheck schema = new SchemaCheck(jdbc);
        info = new InfoStore(jdbc, schema, new ObjectMapper());
        alerts = new SourceAlertStore(jdbc, schema);
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM info_items WHERE source LIKE 'test-%'");
        jdbc.update("DELETE FROM fetch_source_state WHERE task LIKE 'test-%'");
        jdbc.update("DELETE FROM source_alerts WHERE task LIKE 'test-%'");
    }

    private void item(String id, String source, String title, Instant published, Instant firstSeen, String body) {
        jdbc.update("INSERT INTO info_items (id, source, kind, url, title, title_ko, published_at, first_seen_at, summary, body, body_status, meta) "
                        + "VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, ?, '{\"category\": \"x\"}'::jsonb)",
                id, source, "https://example.org/" + id, title, title + " 한국어", published == null ? null : Timestamp.from(published),
                Timestamp.from(firstSeen), "요약 " + title, body, body == null ? "none" : "full");
    }

    @Test
    @DisplayName("글 목록은 작성 시각(없으면 처음 받은 시각) 최근부터, 출처·검색·쪽으로 거르고 본문은 싣지 않는다")
    void listing() {
        assertThat(info.ready()).isTrue();
        item("a00000000000000000000001", "test-a", "Rates spike", NOW.minusSeconds(3600), NOW, "본문 1");
        item("a00000000000000000000002", "test-a", "Housing", null, NOW.minusSeconds(60), null);
        item("a00000000000000000000003", "test-b", "Rates 100% sure_", NOW.minusSeconds(7200), NOW, "본문 3");

        List<InfoStore.Item> all = info.items(List.of("test-a", "test-b"), null, null, 10);
        assertThat(all).extracting(InfoStore.Item::id)
                .containsExactly("a00000000000000000000002", "a00000000000000000000001", "a00000000000000000000003");
        assertThat(all.get(1).body()).isNull();
        assertThat(all.get(1).meta().path("category").asText()).isEqualTo("x");

        assertThat(info.items(List.of("test-a", "test-b"), "rates", null, 10)).hasSize(2);
        assertThat(info.items(List.of("test-a", "test-b"), "100%", null, 10)).extracting(InfoStore.Item::id)
                .containsExactly("a00000000000000000000003");
        assertThat(info.items(List.of("test-b"), null, null, 10)).hasSize(1);
        assertThat(info.items(List.of("test-a", "test-b"), null, NOW.minusSeconds(3000), 10)).extracting(InfoStore.Item::id)
                .containsExactly("a00000000000000000000001", "a00000000000000000000003");
        assertThat(info.item("a00000000000000000000001")).get().extracting(InfoStore.Item::body).isEqualTo("본문 1");
        assertThat(info.counts()).filteredOn(count -> count.source().equals("test-a")).singleElement()
                .satisfies(count -> assertThat(count.items()).isEqualTo(2));
    }

    @Test
    @DisplayName("출처 판정을 읽는다")
    void states() {
        jdbc.update("INSERT INTO fetch_source_state (task, status, streak, reason, last_run_at, stale_after_minutes) "
                + "VALUES ('test-task', 'format', 2, '모양이 다름', ?, 1440)", Timestamp.from(NOW));

        assertThat(info.states()).filteredOn(state -> state.task().equals("test-task")).singleElement()
                .satisfies(state -> {
                    assertThat(state.status()).isEqualTo("format");
                    assertThat(state.streak()).isEqualTo(2);
                    assertThat(state.lastOkAt()).isNull();
                    assertThat(state.createdAt()).isNotNull();
                });
    }

    @Test
    @DisplayName("알림 기록 — 열고·알리고·풀고, 풀린 뒤 다시 열면 새 사건")
    void alertLog() {
        assertThat(alerts.ready()).isTrue();
        alerts.open("test-task|blocked", "test-task", "blocked", "HTTP 403", NOW);
        alerts.open("test-task|blocked", "test-task", "blocked", "다시", NOW.plusSeconds(60));
        assertThat(mine()).singleElement().satisfies(open -> {
            assertThat(open.reason()).as("열린 사건은 그대로").isEqualTo("HTTP 403");
            assertThat(open.notifiedAt()).isNull();
        });

        alerts.notified("test-task|blocked", NOW.plusSeconds(5));
        assertThat(mine()).singleElement().satisfies(open -> assertThat(open.notifiedAt()).isEqualTo(NOW.plusSeconds(5)));

        alerts.recovered("test-task|blocked", NOW.plusSeconds(600));
        assertThat(mine()).isEmpty();

        alerts.open("test-task|blocked", "test-task", "blocked", "또 403", NOW.plusSeconds(900));
        assertThat(mine()).singleElement().satisfies(open -> {
            assertThat(open.reason()).isEqualTo("또 403");
            assertThat(open.notifiedAt()).isNull();
        });
    }

    private List<SourceAlertStore.Open> mine() {
        return alerts.open().stream().filter(open -> open.task().startsWith("test-")).toList();
    }
}
