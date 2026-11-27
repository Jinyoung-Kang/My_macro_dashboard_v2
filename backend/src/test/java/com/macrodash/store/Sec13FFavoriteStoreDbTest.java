package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 13F 즐겨찾기 표(V43, ADR 0048)와 저장본 머리 읽기 — 실제 테스트 DB에서 CIK마다 한 줄(겹치면 넣지 않음), 더한 차례, 표시 이름이 없으면 SEC 이름, 지우기,
 * CIK 모양 검사, 저장본 머리(수집 시각·첫 분기 보고 기준일 — 있는 이름만). 시험 CIK는 99억대, 저장본 이름은 {@code t.fav.}로 시작합니다.
 */
class Sec13FFavoriteStoreDbTest {

    private static final String A = "0009900001";
    private static final String B = "0009900002";

    private JdbcTemplate jdbc;
    private Sec13FFavoriteStore store;
    private StoreRepository repository;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"), System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new Sec13FFavoriteStore(jdbc, new SchemaCheck(jdbc));
        repository = new StoreRepository(jdbc, new ObjectMapper());
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM sec13f_favorites WHERE cik LIKE '00099000%'");
        jdbc.update("DELETE FROM snapshots WHERE name LIKE 't.fav.%'");
    }

    @Test
    @DisplayName("CIK마다 한 줄 — 겹치면 넣지 않고, 더한 차례·표시 이름(없으면 SEC 이름)·지우기")
    void oneRowPerCik() {
        assertThat(store.ready()).isTrue();
        assertThat(store.insert(B, "SECOND FAKE LLC", null, null, null)).isPresent();
        assertThat(store.insert(A, "FIRST FAKE LLC", "가짜 운용", "설명", null)).isPresent();
        assertThat(store.insert(A, "OTHER", null, null, null)).isEmpty();

        List<Sec13FFavoriteStore.Favorite> rows = store.all().stream().filter(row -> row.cik().startsWith("00099000")).toList();
        assertThat(rows).extracting(Sec13FFavoriteStore.Favorite::cik).containsExactly(B, A);
        assertThat(rows).extracting(Sec13FFavoriteStore.Favorite::name).containsExactly("SECOND FAKE LLC", "가짜 운용");
        assertThat(store.find(A)).get().extracting(Sec13FFavoriteStore.Favorite::description).isEqualTo("설명");
        assertThat(store.count()).isGreaterThanOrEqualTo(2);

        // 표시 이름·설명 고치기 — 받은 값으로 바꿈(null이면 비움), 없는 CIK는 빈 값
        assertThat(store.updateLabels(A, null, "새 설명")).get().satisfies(row -> {
            assertThat(row.name()).isEqualTo("FIRST FAKE LLC");
            assertThat(row.description()).isEqualTo("새 설명");
        });
        assertThat(store.updateLabels("0009900009", "x", null)).isEmpty();

        assertThat(store.delete(A)).isEqualTo(1);
        assertThat(store.delete(A)).isZero();
        assertThat(store.find(A)).isEmpty();
    }

    @Test
    @DisplayName("CIK는 10자리 숫자만(DB 제약)")
    void cikShapeChecked() {
        assertThatThrownBy(() -> store.insert("12345", "SHORT", null, null, null)).isInstanceOf(Exception.class);
    }

    @Test
    @DisplayName("저장본 머리 — 있는 이름만, 수집 시각과 첫 분기 보고 기준일(13F 꼴이 아니면 null)")
    void snapshotHeads() {
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb)", "t.fav.q8",
                "{\"quarters\":[{\"reportDate\":\"2026-06-30\"},{\"reportDate\":\"2026-03-31\"}]}");
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb)", "t.fav.other", "{\"rows\":[]}");

        Map<String, StoreRepository.SnapshotHead> heads = repository.readSnapshotHeads(List.of("t.fav.q8", "t.fav.other", "t.fav.none"));

        assertThat(heads).containsOnlyKeys("t.fav.q8", "t.fav.other");
        assertThat(heads.get("t.fav.q8").firstReportDate()).isEqualTo("2026-06-30");
        assertThat(heads.get("t.fav.q8").collectedAt()).isNotNull();
        assertThat(heads.get("t.fav.other").firstReportDate()).isNull();
        assertThat(repository.readSnapshotHeads(List.of())).isEmpty();
    }

    @Test
    @DisplayName("13F 앞 분기 자르기 — 앞 N분기만(차례 그대로)·받지 않은 분기 보관은 뺌, 13F 꼴이 아니거나 없으면 empty")
    void firstQuarters() {
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb)", "t.fav.q30",
                "{\"name\":\"X\",\"quarters\":[{\"reportDate\":\"2026-06-30\"},{\"reportDate\":\"2026-03-31\"},{\"reportDate\":\"2025-12-31\"}],"
                        + "\"supersededQuarters\":[{\"reportDate\":\"2020-01-01\"}]}");
        jdbc.update("INSERT INTO snapshots (name, payload) VALUES (?, ?::jsonb)", "t.fav.other", "{\"rows\":[]}");

        var cut = repository.readSnapshotFirstQuarters("t.fav.q30", 2).orElseThrow().payload();
        assertThat(cut.get("quarters")).hasSize(2);
        assertThat(cut.get("quarters").get(0).get("reportDate").asString()).isEqualTo("2026-06-30");
        assertThat(cut.has("supersededQuarters")).isFalse();
        assertThat(cut.get("name").asString()).isEqualTo("X");
        assertThat(repository.readSnapshotFirstQuarters("t.fav.other", 2)).isEmpty();
        assertThat(repository.readSnapshotFirstQuarters("t.fav.none", 2)).isEmpty();
    }

    @Test
    @DisplayName("그 기관의 13F 신규 편입 알림 규칙 세기·지우기(모든 사용자, 다른 종류·다른 기관은 그대로)")
    void institutionAlertRules() {
        jdbc.update("DELETE FROM users WHERE email LIKE 'sec13f-fav-test-%@example.invalid'");
        Long user = jdbc.queryForObject("INSERT INTO users (email, password_hash, role, tier) VALUES ('sec13f-fav-test-1@example.invalid', 'x', 'MEMBER', 'PRO') RETURNING id", Long.class);
        try {
            jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'INSTITUTION_NEW', ?::jsonb)", user, "{\"cik\":\"" + A + "\"}");
            jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'INSTITUTION_NEW', ?::jsonb)", user, "{\"cik\":\"" + B + "\"}");
            jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'REGIME_CHANGE', '{}'::jsonb)", user);
            AlertStore alerts = new AlertStore(jdbc, new ObjectMapper(), new SchemaCheck(jdbc));
            jdbc.update("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, 'INSTITUTION_NEW', ?::jsonb)", user, "{\"cik\":\"" + B + "\",\"minWeight\":1}");
            assertThat(alerts.countInstitutionRulesByCik()).containsEntry(A, 1).containsEntry(B, 2);
            assertThat(alerts.deleteInstitutionRules(A)).isEqualTo(1);
            assertThat(alerts.countInstitutionRulesByCik()).doesNotContainKey(A).containsEntry(B, 2);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM alert_rules WHERE user_id = ?", Integer.class, user)).isEqualTo(3);
        } finally {
            jdbc.update("DELETE FROM users WHERE email LIKE 'sec13f-fav-test-%@example.invalid'");
        }
    }
}
