package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 기준일까지 관측 기록 읽기({@link StoreRepository#readObservationsUntil}) — 모의 매매 재무(D28)의 시점 규칙(obs_date = 공시일 ≤
 * 기준일)이 SQL에서 지켜지는지 실제 테스트 DB(macrodash_test)로 확인합니다. 테스트 이름표 데이터셋({@value #DATASET})의 행만 만들고
 * 지웁니다.
 */
class StoreRepositoryObservationsUntilDbTest {

    private static final String DATASET = "t.us.fundamentals";

    private JdbcTemplate jdbc;
    private StoreRepository repository;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL",
                "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        repository = new StoreRepository(jdbc, new ObjectMapper());
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM observations WHERE dataset LIKE 't.%'");
    }

    private void put(String dataset, String filed, String entity, String payload) {
        jdbc.update("INSERT INTO observations (dataset, obs_date, entity, payload) VALUES (?, ?, ?, ?::jsonb)",
                dataset, java.sql.Date.valueOf(filed), entity, payload);
    }

    @Test
    @DisplayName("obs_date ≤ 기준일인 행만, 개체별·날짜 오름차순, payload에 obsDate — 다른 개체·데이터셋·기준일 뒤 공시는 빠짐")
    void readsUntilAsOf() {
        put(DATASET, "2025-10-31", "AAPL", "{\"cik\":[\"0000320193\"],\"facts\":[{\"c\":\"Revenues\",\"v\":1}]}");
        put(DATASET, "2026-07-31", "AAPL", "{\"cik\":[\"0000320193\"],\"facts\":[{\"c\":\"Revenues\",\"v\":2}]}");
        put(DATASET, "2026-10-23", "AAPL", "{\"cik\":[\"0000320193\"],\"facts\":[{\"c\":\"Revenues\",\"v\":3}]}");
        put(DATASET, "2026-10-30", "AAPL", "{\"cik\":[\"0000320193\"],\"facts\":[{\"c\":\"Revenues\",\"v\":4}]}");
        put(DATASET, "2026-08-06", "JPM", "{\"cik\":[\"0000019617\"],\"facts\":[]}");
        put(DATASET, "2026-08-01", "MSFT", "{\"cik\":[\"0000789019\"],\"facts\":[]}");
        put("t.other", "2026-01-01", "AAPL", "{\"facts\":[]}");

        Map<String, List<JsonNode>> rows = repository.readObservationsUntil(DATASET, List.of("JPM", "AAPL", "NONE"),
                LocalDate.of(2026, 10, 23));

        assertThat(rows.keySet()).as("기록이 없는 개체는 키가 없음").containsExactly("AAPL", "JPM");
        assertThat(rows.get("AAPL")).extracting(node -> node.path("obsDate").asString())
                .as("기준일 당일 공시는 포함, 뒤 공시(10-30)는 빠짐").containsExactly("2025-10-31", "2026-07-31", "2026-10-23");
        assertThat(rows.get("AAPL").get(1).path("facts").get(0).path("v").asInt()).isEqualTo(2);
        assertThat(rows.get("JPM")).singleElement().satisfies(node ->
                assertThat(node.path("cik").get(0).asString()).isEqualTo("0000019617"));
        assertThat(repository.readObservationsUntil(DATASET, List.of(), LocalDate.of(2026, 10, 23))).isEmpty();
    }

    @Test
    @DisplayName("기준일 앞 최신 obs_date — 같은 날·뒤 날은 빼고(한국 유니버스 U(D)의 기준일 B < D), 다른 데이터셋은 보지 않음, 없으면 null")
    void latestDateStrictlyBefore() {
        String universe = "t.kr.universe";
        put(universe, "2026-10-26", "005930", "{\"rank\":1}");
        put(universe, "2026-10-27", "005930", "{\"rank\":1}");
        put(universe, "2026-10-28", "005930", "{\"rank\":1}");
        put("t.other", "2026-10-27", "005930", "{}");

        assertThat(repository.latestObservationDateBefore(universe, LocalDate.of(2026, 10, 28)))
                .as("D 당일 행은 쓰지 않음").isEqualTo(LocalDate.of(2026, 10, 27));
        assertThat(repository.latestObservationDateBefore(universe, LocalDate.of(2026, 10, 30)))
                .isEqualTo(LocalDate.of(2026, 10, 28));
        assertThat(repository.latestObservationDateBefore(universe, LocalDate.of(2026, 10, 26))).isNull();
        assertThat(repository.latestObservationDateBefore("t.none", LocalDate.of(2026, 10, 30))).isNull();
    }
}
