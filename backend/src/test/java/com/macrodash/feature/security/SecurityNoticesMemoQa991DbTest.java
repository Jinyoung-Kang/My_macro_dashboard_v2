package com.macrodash.feature.security;

import com.macrodash.store.SchemaCheck;
import com.macrodash.store.SecurityStore;
import com.macrodash.store.SqlRecorder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.time.LocalDate;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * QA-991 — 보안 공지 목록({@code GET /api/security/notices})이 부를 때마다 공지·표 행·버전 목록을 모두 다시 읽고 공지 전부를 다시 판정함(운영 1.65~1.75초).
 * 시간이 아니라 꼴로 봅니다: 입력 표가 그대로면 두 번째 목록은 공지 전부를 다시 읽지 않아야 합니다. 테스트 DB의 실제 표에 가짜 공지(글 번호 9.9억대)를 넣고 지웁니다.
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
    }

    @Test
    @Disabled("QA-991 재현 — 입력이 그대로여도 목록마다 공지 전부를 다시 읽고 다시 판정함(고친 뒤 켬)")
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
}
