package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 보안 공지 저장소 읽기(ADR 0046, V40) — 실제 표(테스트 DB)에서 공지·표 행·버전 목록·출처 판정을 읽는지. 수집기가 쓰는 표라 여기서 넣는 행은 시험
 * 고정본입니다(값은 모두 가짜 — 글 번호는 9.9억대, 출처 판정 태스크는 {@code test-}). 버전 목록 표 셋은 늘 한 벌이라 시험이 끝나면 비웁니다.
 * 백엔드가 쓰는 알림 기록({@code security_alerts}, {@link SecurityAlertStore})도 함께 봅니다.
 */
class SecurityStoreDbTest {

    private static final long A = 990_000_001L;
    private static final long B = 990_000_002L;

    private JdbcTemplate jdbc;
    private SecurityStore store;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        store = new SecurityStore(jdbc, new ObjectMapper(), new SchemaCheck(jdbc));
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM security_notices WHERE ntt_id BETWEEN 990000000 AND 990000999");
        jdbc.update("DELETE FROM security_alerts WHERE ntt_id BETWEEN 990000000 AND 990000999");
        jdbc.update("DELETE FROM fetch_source_state WHERE task LIKE 'test-%'");
        jdbc.update("DELETE FROM env_components");
        jdbc.update("DELETE FROM env_pending_updates");
        jdbc.update("DELETE FROM env_inventory");
        jdbc.update("DELETE FROM env_changelog_cves");
    }

    @Test
    @DisplayName("공지와 표 행 — JSON 배열 칸·번호 칸 null·날짜를 그대로 읽고, 표 행은 행 순서")
    void noticesAndRows() {
        assertThat(store.ready()).isTrue();
        jdbc.update("INSERT INTO security_notices (ntt_id, list_no, title, posted_on, url, pinned, detail_status, detail_attempts, layout, "
                        + "products, notes, body_text, detail_fetched_at) VALUES (?, 77, '가짜 공지 A', ?, 'https://boho.example/a', false, 'ok', 1, "
                        + "'product_table', '[\"가짜 제품\", \"가짜 제품 2\"]'::jsonb, '[\"※ 가짜 조건\"]'::jsonb, '가짜 본문', ?)",
                A, Date.valueOf(LocalDate.parse("2026-11-20")), Timestamp.from(Instant.parse("2026-11-21T01:00:00Z")));
        jdbc.update("INSERT INTO security_notices (ntt_id, title, posted_on, url, pinned) VALUES (?, '가짜 공지 B', ?, 'https://boho.example/b', true)",
                B, Date.valueOf(LocalDate.parse("2026-11-19")));
        jdbc.update("INSERT INTO security_notice_rows (ntt_id, row_no, cve, product, affected, fixed) VALUES "
                + "(?, 1, 'CVE-2099-0002', '가짜 제품 2', '2.0 이하', '2.1'), (?, 0, 'CVE-2099-0001', '가짜 제품', '1.0 이하', '1.1')", A, A);

        SecurityStore.Notice a = store.notice(A).orElseThrow();
        assertThat(a.listNo()).isEqualTo(77);
        assertThat(a.postedOn()).isEqualTo(LocalDate.parse("2026-11-20"));
        assertThat(a.products()).containsExactly("가짜 제품", "가짜 제품 2");
        assertThat(a.notes()).containsExactly("※ 가짜 조건");
        assertThat(a.layout()).isEqualTo("product_table");
        assertThat(a.detailFetchedAt()).isEqualTo(Instant.parse("2026-11-21T01:00:00Z"));
        SecurityStore.Notice b = store.notice(B).orElseThrow();
        assertThat(b.listNo()).isNull();
        assertThat(b.pinned()).isTrue();
        assertThat(b.detailStatus()).isEqualTo("pending");
        assertThat(b.layout()).isNull();
        assertThat(b.products()).isEmpty();
        assertThat(b.bodyText()).isNull();
        assertThat(store.notice(990_000_999L)).isEmpty();

        assertThat(store.notices()).extracting(SecurityStore.Notice::nttId).containsSubsequence(A, B);
        assertThat(store.rows(A)).extracting(SecurityStore.NoticeRow::rowNo).containsExactly(0, 1);
        assertThat(store.rows()).filteredOn(r -> r.nttId() == A).extracting(SecurityStore.NoticeRow::cve)
                .containsExactly("CVE-2099-0001", "CVE-2099-0002");
    }

    @Test
    @DisplayName("버전 목록 — 받은 적이 없으면 비고, 받으면 구역 JSON(count·reason 없으면 null)·구성 요소·보류(보안 먼저)")
    void inventory() {
        assertThat(store.inventoryReady()).isTrue();
        assertThat(store.inventory()).isEmpty();

        jdbc.update("INSERT INTO env_inventory (id, collected_at, host_included, apt_lists_at, sections) VALUES (1, ?, true, NULL, "
                + "'{\"host\": {\"status\": \"ok\", \"count\": 2}, \"postgres\": {\"status\": \"failed\", \"reason\": \"가짜 사유\"}}'::jsonb)",
                Timestamp.from(Instant.parse("2026-11-20T22:20:00Z")));
        jdbc.update("INSERT INTO env_components (source, ecosystem, name, version, source_package) VALUES "
                + "('host', 'dpkg', 'fake-libssl', '9.9.9-0fake1', 'fake-openssl'), ('host', 'runtime', 'docker', '99.1.0', NULL)");
        jdbc.update("INSERT INTO env_pending_updates (package, arch, installed, candidate, repos, security) VALUES "
                + "('a-fake', 'amd64', '1', '2', 'noble', false), ('z-fake', 'amd64', '1', '2', 'noble-security', true)");

        SecurityStore.Inventory inv = store.inventory().orElseThrow();
        assertThat(inv.collectedAt()).isEqualTo(Instant.parse("2026-11-20T22:20:00Z"));
        assertThat(inv.receivedAt()).isNotNull();
        assertThat(inv.hostIncluded()).isTrue();
        assertThat(inv.aptListsAt()).isNull();
        assertThat(inv.sections()).containsExactlyInAnyOrder(new SecurityStore.Section("host", "ok", 2, null),
                new SecurityStore.Section("postgres", "failed", null, "가짜 사유"));
        assertThat(store.components()).extracting(SecurityStore.Component::name).containsExactly("fake-libssl", "docker");
        assertThat(store.components().get(1).sourcePackage()).isNull();
        assertThat(store.pending()).extracting(SecurityStore.Pending::pkg).containsExactly("z-fake", "a-fake");
        assertThat(store.pending().get(0).security()).isTrue();
    }

    @Test
    @DisplayName("변경 기록 CVE(V41) — 없으면 빈 목록, 있으면 원본 패키지·버전·번호 그대로")
    void changelogCves() {
        assertThat(store.changelogCves()).isEmpty();
        jdbc.update("INSERT INTO env_changelog_cves (package, version, cve) VALUES "
                + "('fake-openssl', '9.9.9-0fake1', 'CVE-2099-0001'), ('kernel', '0.0.1-fake-generic', 'CVE-2099-7777')");

        assertThat(store.changelogCves()).containsExactlyInAnyOrder(
                new SecurityStore.ChangelogCve("fake-openssl", "9.9.9-0fake1", "CVE-2099-0001"),
                new SecurityStore.ChangelogCve("kernel", "0.0.1-fake-generic", "CVE-2099-7777"));
    }

    @Test
    @DisplayName("출처 판정 — 그 태스크의 행만, 없으면 비어 있음")
    void sourceState() {
        assertThat(store.sourceState("test-security")).isEmpty();
        jdbc.update("INSERT INTO fetch_source_state (task, status, streak, reason, last_ok_at, last_run_at, stale_after_minutes) "
                + "VALUES ('test-security', 'format', 2, '가짜 사유', NULL, ?, 1080)", Timestamp.from(Instant.parse("2026-11-21T00:00:00Z")));

        SecurityStore.SourceState state = store.sourceState("test-security").orElseThrow();
        assertThat(state.status()).isEqualTo("format");
        assertThat(state.streak()).isEqualTo(2);
        assertThat(state.lastOkAt()).isNull();
        assertThat(state.lastRunAt()).isEqualTo(Instant.parse("2026-11-21T00:00:00Z"));
        assertThat(state.staleAfterMinutes()).isEqualTo(1080);
        assertThat(List.of(state.reason())).containsExactly("가짜 사유");
    }

    @Test
    @DisplayName("알림 기록 — 공지당 한 행(두 번째 넣기는 거짓), 텔레그램 보낸 시각은 빈 행만, 트랜잭션 안에서 예외면 되돌림")
    void alertRecords() {
        SecurityAlertStore alerts = new SecurityAlertStore(jdbc, new SchemaCheck(jdbc));
        assertThat(alerts.ready()).isTrue();
        Instant first = Instant.parse("2026-11-21T03:00:00Z");
        Instant later = Instant.parse("2026-11-21T03:15:00Z");

        assertThat(alerts.insert(A, first, 7L)).isTrue();
        assertThat(alerts.insert(A, later, null)).isFalse();
        assertThat(alerts.insert(B, first, null)).isTrue();
        assertThat(alerts.telegramSent(List.of(A), first)).isEqualTo(1);
        assertThat(alerts.telegramSent(List.of(A), later)).as("이미 보낸 행은 그대로").isZero();

        List<SecurityAlertStore.Alert> rows = alerts.all().stream().filter(a -> a.nttId() == A || a.nttId() == B).toList();
        assertThat(rows).containsExactly(new SecurityAlertStore.Alert(A, first, 7L, first), new SecurityAlertStore.Alert(B, first, null, null));

        long c = 990_000_003L;
        try {
            alerts.atomically(() -> {
                alerts.insert(c, first, null);
                throw new IllegalStateException("되돌림");
            });
        } catch (IllegalStateException expected) {
            // 되돌렸는지 아래에서 봅니다.
        }
        assertThat(alerts.all()).noneMatch(a -> a.nttId() == c);
    }
}
