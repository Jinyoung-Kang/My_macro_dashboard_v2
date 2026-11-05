package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 차단 통과 수집 계층의 닫힘 상태 읽기(V21, ADR 0026) — 실제 테스트 DB(macrodash_test)에서 "지금 닫힌 것만"을 확인합니다.
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 이 표는 수집기가 쓰는 표라 저장소에는 쓰는 메서드가 없고,
 * 시험만 {@code .test} 호스트 행을 넣고 지웁니다.
 */
class FetchStateStoreDbTest {

    private static final Instant NOW = Instant.parse("2026-11-05T03:00:00Z");

    private JdbcTemplate jdbc;
    private FetchStateStore store;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new FetchStateStore(jdbc, new SchemaCheck(jdbc));
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM fetch_hosts WHERE host LIKE '%.fetchstore.test'");
    }

    private void row(String host, String reason, Instant until, boolean givenUp) {
        jdbc.update("INSERT INTO fetch_hosts (host, blocked_reason, blocked_until, given_up) VALUES (?, ?, ?, ?)",
                host + ".fetchstore.test", reason, until == null ? null : Timestamp.from(until), givenUp);
    }

    private List<FetchStateStore.Closure> mine() {
        return store.closed(NOW).stream().filter(closure -> closure.host().endsWith(".fetchstore.test")).toList();
    }

    @Test
    @DisplayName("기한이 남았거나 포기한 출처만 닫힌 것으로 읽는다")
    void onlyCurrentlyClosedHosts() {
        assertThat(store.ready()).isTrue();
        row("a-human", "사람 확인 요구(계층 browser)", NOW.plusSeconds(3600), false);
        row("b-given-up", "HTTP 403(계층 impersonate)", null, true);
        row("c-expired", "HTTP 403(계층 impersonate)", NOW.minusSeconds(1), false);
        row("d-open", null, null, false);

        List<FetchStateStore.Closure> closed = mine();

        assertThat(closed).extracting(FetchStateStore.Closure::host)
                .containsExactly("a-human.fetchstore.test", "b-given-up.fetchstore.test");
        assertThat(closed.get(0).until()).isEqualTo(NOW.plusSeconds(3600));
        assertThat(closed.get(0).givenUp()).isFalse();
        assertThat(closed.get(1).givenUp()).isTrue();
        assertThat(closed.get(1).until()).as("포기에는 풀리는 시각이 없다").isNull();
    }
}
