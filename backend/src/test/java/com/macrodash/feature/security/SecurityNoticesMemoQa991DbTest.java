package com.macrodash.feature.security;

import com.macrodash.store.SchemaCheck;
import com.macrodash.store.SecurityStore;
import com.macrodash.store.SqlRecorder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-991 — 보안 공지 목록({@code GET /api/security/notices})이 부를 때마다 공지·표 행·버전 목록을 모두 다시 읽고 공지 전부를 다시 판정함(운영 1.65~1.75초).
 * 시간이 아니라 꼴로 봅니다: 입력 표가 그대로면 두 번째 목록은 공지 전부를 다시 읽지 않아야 합니다. 고친 뒤에는 입력 판({@link SecurityStore#inputVersion})이
 * 수집기의 쓰기마다 달라지고, 고친 공지가 다음 목록에 바로 보이는 것도 봅니다. 테스트 DB의 실제 표에 가짜 공지(글 번호 9.9억대)를 넣고 지웁니다 — 버전 목록 표는
 * 늘 한 벌이라 시험이 끝나면 비우고, 추적기 결과는 스위트 {@code testfake…}만 지웁니다.
 */
class SecurityNoticesMemoQa991DbTest {

    private static final long A = 990_000_991L;

    private SqlRecorder recorder;
    private JdbcTemplate jdbc;
    private SecurityService service;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        recorder = new SqlRecorder(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(recorder.dataSource());
        service = new SecurityService(new SecurityStore(jdbc, new ObjectMapper(), new SchemaCheck(jdbc)));
        cleanUp();
        jdbc.update("INSERT INTO security_notices (ntt_id, list_no, title, posted_on, url, pinned, detail_status, detail_attempts, layout, products, "
                        + "notes, body_text) VALUES (?, 991, '가짜 PostgreSQL 보안 업데이트 권고', ?, 'https://boho.example/991', false, 'ok', 1, "
                        + "'product_table', '[\"PostgreSQL\"]'::jsonb, '[]'::jsonb, '가짜 본문')",
                A, Date.valueOf(LocalDate.parse("2026-11-20")));
        jdbc.update("INSERT INTO security_notice_rows (ntt_id, row_no, cve, product, affected, fixed) VALUES "
                + "(?, 0, 'CVE-2099-9910', 'PostgreSQL', '16 이상 16.50 미만', '16.50 이상')", A);
        recorder.clear();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM security_notices WHERE ntt_id BETWEEN 990000000 AND 990000999");
        jdbc.update("DELETE FROM env_components");
        jdbc.update("DELETE FROM env_pending_updates");
        jdbc.update("DELETE FROM env_changelog_cves");
        jdbc.update("DELETE FROM env_inventory");
        jdbc.update("DELETE FROM distro_cve_status WHERE suite LIKE 'testfake%'");
    }

    @Test
    @DisplayName("QA-991: 입력 표가 그대로면 두 번째 목록은 공지 전부를 다시 읽지 않는다 — 응답은 시각 칸 말고 같음")
    void secondListReusesJudgement() {
        Map<String, Object> first = service.notices(null, null, null, null, null);
        assertThat(recorder.count("FROM security_notices ORDER BY")).as("처음에는 공지 전부를 읽음").isEqualTo(1);
        recorder.clear();

        Map<String, Object> second = service.notices(null, null, null, null, null);

        assertThat(recorder.count("FROM security_notices ORDER BY")).as("둘째에는 공지 전부를 다시 읽지 않음").isZero();
        assertThat(recorder.count("FROM security_notice_rows ORDER BY")).as("표 행 전부도").isZero();
        first.remove("checkedAt");
        second.remove("checkedAt");
        assertThat(second).isEqualTo(first);
    }

    @Test
    @DisplayName("입력 판은 공지 고침·표 행 바뀜·버전 목록 다시 받음·추적기 결과 적음마다 달라지고, 그대로면 같다")
    void inputVersionFollowsCollectorWrites() {
        SecurityStore store = new SecurityStore(jdbc, new ObjectMapper(), new SchemaCheck(jdbc));
        SecurityStore.InputVersion start = store.inputVersion();
        assertThat(store.inputVersion()).as("그대로면 같음").isEqualTo(start);

        jdbc.update("UPDATE security_notices SET title = title || ' (고침)', updated_at = now() WHERE ntt_id = ?", A);
        SecurityStore.InputVersion edited = store.inputVersion();
        assertThat(edited).isNotEqualTo(start);
        jdbc.update("DELETE FROM security_notice_rows WHERE ntt_id = ?", A);
        SecurityStore.InputVersion rowsGone = store.inputVersion();
        assertThat(rowsGone).isNotEqualTo(edited);
        jdbc.update("INSERT INTO env_inventory (id, collected_at, received_at, host_included, sections) VALUES (1, now(), now(), true, '{}'::jsonb) "
                + "ON CONFLICT (id) DO UPDATE SET received_at = now()");
        SecurityStore.InputVersion inventory = store.inputVersion();
        assertThat(inventory).isNotEqualTo(rowsGone);
        jdbc.update("INSERT INTO distro_cve_status (distro, suite, package, cve, status, fixed_version, detail, checked_at) "
                + "VALUES ('ubuntu', 'testfake991', 'openssl', 'CVE-2099-9911', 'open', NULL, 'qa', now())");
        assertThat(store.inputVersion()).isNotEqualTo(inventory);
    }

    @Test
    @DisplayName("수집기가 공지를 고치면 다음 목록에 바로 보인다(판이 바뀌어 다시 판정)")
    void editedNoticeShowsOnNextList() {
        service.notices(null, null, null, null, null);
        jdbc.update("UPDATE security_notices SET title = '가짜 PostgreSQL 보안 업데이트 권고(고침)', updated_at = now() WHERE ntt_id = ?", A);

        Map<String, Object> out = service.notices(null, null, null, null, null);

        assertThat(items(out)).filteredOn(i -> Long.valueOf(A).equals(i.get("nttId"))).singleElement()
                .satisfies(i -> assertThat(i.get("title")).isEqualTo("가짜 PostgreSQL 보안 업데이트 권고(고침)"));
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> items(Map<String, Object> out) {
        return (List<Map<String, Object>>) out.get("items");
    }
}
