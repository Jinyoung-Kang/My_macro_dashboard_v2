package com.macrodash.feature.search;

import com.macrodash.store.AlertStore;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.SearchWatchStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.spy;

/**
 * 관심 대상 새 글 알림(계약 §9-5)을 실제 테스트 DB로 — 알림함에 한 줄(규칙 없음, 읽지 않은 수에 셈, 누르면 갈 주소), 같은 글로 두 번 알리지 않음, 알림함 쓰기가
 * 실패하면 알린 시각도 되돌림(한 트랜잭션).
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 시험용 사용자(이메일 표지)·대상 키 표지({@code topic:알림시험표지…})와 그
 * 사용자에게 간 사건만 지웁니다. 글·제목은 합성입니다.
 */
class SearchWatchAlertJobDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String MARK = "topic:알림시험표지";
    private static final String EMAIL = "search-watch-alert-test-%d@example.invalid";
    private static final Instant AT = Instant.parse("2026-11-15T03:00:00Z");
    /** 이 시험이 직접 넣는 사건 키의 표지. */
    private static final String OTHER_EVENT = "search-watch-alert-test:";

    private JdbcTemplate jdbc;
    private SearchWatchStore watches;
    private AlertStore alerts;
    private SearchWatchServiceTest.MutableClock clock;
    private SearchWatchAlertJob job;
    private long alice;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"), System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        watches = new SearchWatchStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        alerts = spy(new AlertStore(jdbc, MAPPER, new SchemaCheck(jdbc)));
        clock = new SearchWatchServiceTest.MutableClock(AT.plus(Duration.ofHours(1)));
        job = new SearchWatchAlertJob(watches, alerts, clock);
        cleanUp();
        Long id = jdbc.queryForObject("INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'MEMBER') RETURNING id",
                Long.class, EMAIL.formatted(1));
        alice = id == null ? -1 : id;
    }

    @AfterEach
    void cleanUp() {
        // 사건은 사용자를 지워도 남으므로 먼저(배달은 사건·사용자를 따라 지워짐).
        jdbc.update("DELETE FROM alert_events WHERE kind = 'SEARCH_WATCH' AND id IN (SELECT d.event_id FROM alert_deliveries d "
                + "JOIN users u ON u.id = d.user_id WHERE u.email LIKE 'search-watch-alert-test-%@example.invalid')");
        jdbc.update("DELETE FROM alert_events WHERE event_key LIKE ?", OTHER_EVENT + "%");
        jdbc.update("DELETE FROM search_watch_items WHERE entity_key LIKE ?", MARK + "%");
        jdbc.update("DELETE FROM users WHERE email LIKE 'search-watch-alert-test-%@example.invalid'");
    }

    private void item(String key, String itemId, String title, Instant publishedAt, Instant firstSeenAt) {
        jdbc.update("INSERT INTO search_watch_items (entity_key, item_id, kind, title, source, published_at, first_seen_at) "
                + "VALUES (?, ?, 'news', ?, 'google_en', ?, ?)", key, itemId, title, Timestamp.from(publishedAt), Timestamp.from(firstSeenAt));
    }

    private long events(long watchId) {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM alert_events WHERE event_key LIKE ?", Long.class,
                "search_watch:" + watchId + ":%");
        return count == null ? 0 : count;
    }

    @Test
    @DisplayName("알림을 켠 대상에 새 글이 오면 알림함에 한 줄(규칙 없음·읽지 않은 수에 셈·주소), 같은 글로 두 번 알리지 않고 다음 새 글은 새 사건")
    void deliversOncePerNewItems() {
        String key = MARK + " 하나";
        SearchWatchStore.Watch watch = watches.insert(alice, key, "topic", "알림시험표지 하나", List.of("알림시험표지 하나"), null, AT);
        SearchWatchStore.Watch quiet = watches.insert(alice, MARK + " 둘", "topic", "알림시험표지 둘", List.of("알림시험표지 둘"), null, AT);
        watches.patch(watch.id(), alice, null, true, AT);
        Instant now = clock.instant();
        item(key, "a", "합성 제목 A", now.minus(Duration.ofMinutes(40)), now.minus(Duration.ofMinutes(30)));
        item(key, "b", "합성 제목 B", now.minus(Duration.ofMinutes(20)), now.minus(Duration.ofMinutes(10)));
        item(MARK + " 둘", "c", "알림을 끈 대상의 글", now.minus(Duration.ofMinutes(20)), now.minus(Duration.ofMinutes(10)));
        int unreadBefore = alerts.unreadCount(alice);

        assertThat(job.run()).isEqualTo(1);

        List<AlertStore.InboxItem> inbox = alerts.inbox(alice, 10);
        assertThat(inbox).singleElement().satisfies(row -> {
            assertThat(row.kind()).isEqualTo("SEARCH_WATCH");
            assertThat(row.title()).isEqualTo("관심 대상 '알림시험표지 하나' 새 글 2건");
            assertThat(row.body()).isEqualTo("합성 제목 B\n합성 제목 A");
            assertThat(row.href()).isEqualTo(SearchWatchAlertJob.href(key));
            assertThat(row.late()).isFalse();
            assertThat(row.readAt()).isNull();
        });
        assertThat(alerts.unreadCount(alice)).as("읽지 않은 수에 셈").isEqualTo(unreadBefore + 1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM alert_deliveries WHERE user_id = ? AND rule_id IS NULL AND channel = 'inbox'",
                Long.class, alice)).isEqualTo(1L);
        assertThat(watches.find(alice, key).orElseThrow().notifiedAt()).isEqualTo(now);
        assertThat(events(quiet.id())).as("알림을 끈 대상").isZero();

        clock.advance(Duration.ofMinutes(15));
        assertThat(job.run()).as("알린 뒤 새 글이 없음").isZero();
        assertThat(events(watch.id())).isEqualTo(1);

        item(key, "c", "합성 제목 C", clock.instant().minus(Duration.ofMinutes(5)), clock.instant().minus(Duration.ofMinutes(1)));
        clock.advance(Duration.ofMinutes(15));
        assertThat(job.run()).isEqualTo(1);
        assertThat(alerts.inbox(alice, 10)).hasSize(2).first().satisfies(row -> {
            assertThat(row.title()).isEqualTo("관심 대상 '알림시험표지 하나' 새 글 1건");
            assertThat(row.body()).isEqualTo("합성 제목 C");
        });
        assertThat(events(watch.id())).isEqualTo(2);
    }

    @Test
    @DisplayName("알림함 쓰기가 실패하면 사건·알린 시각을 모두 되돌려 다음 실행에 다시 알림")
    void failureRollsBackNotifiedAt() {
        String key = MARK + " 셋";
        SearchWatchStore.Watch watch = watches.insert(alice, key, "topic", "알림시험표지 셋", List.of("알림시험표지 셋"), null, AT);
        watches.patch(watch.id(), alice, null, true, AT);
        Instant now = clock.instant();
        item(key, "a", "합성 제목 A", now.minus(Duration.ofMinutes(40)), now.minus(Duration.ofMinutes(30)));
        doThrow(new IllegalStateException("합성 실패")).when(alerts).deliverInbox(anyLong(), anyLong());

        assertThat(job.run()).isZero();
        assertThat(events(watch.id())).as("사건도 되돌림").isZero();
        assertThat(watches.find(alice, key).orElseThrow().notifiedAt()).as("알린 시각은 켠 때 그대로").isEqualTo(AT);

        org.mockito.Mockito.reset(alerts);
        clock.advance(Duration.ofMinutes(15));
        assertThat(job.run()).isEqualTo(1);
        assertThat(alerts.inbox(alice, 10)).singleElement().extracting(AlertStore.InboxItem::title)
                .isEqualTo("관심 대상 '알림시험표지 셋' 새 글 1건");
    }

    @Test
    @DisplayName("배달이 남지 않은 SEARCH_WATCH 사건(탈퇴·알림함 정리 뒤 — 이름·제목이 든 한 사람의 내용)은 다음 실행에 지움, 배달이 남은 사건·다른 종류의 사건은 그대로")
    void purgesUndeliveredSearchWatchEvents() {
        Long bobId = jdbc.queryForObject("INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'MEMBER') RETURNING id",
                Long.class, EMAIL.formatted(2));
        long bob = bobId == null ? -1 : bobId;
        String key = MARK + " 넷";
        SearchWatchStore.Watch mine = watches.insert(alice, key, "topic", "알림시험표지 넷", List.of("알림시험표지 넷"), null, AT);
        SearchWatchStore.Watch his = watches.insert(bob, key, "topic", "알림시험표지 넷", List.of("알림시험표지 넷"), null, AT);
        watches.patch(mine.id(), alice, null, true, AT);
        watches.patch(his.id(), bob, null, true, AT);
        Instant now = clock.instant();
        item(key, "a", "합성 제목 A", now.minus(Duration.ofMinutes(40)), now.minus(Duration.ofMinutes(30)));
        alerts.insertEvent("TEST_OTHER", OTHER_EVENT + "other", java.time.LocalDate.parse("2026-11-15"), "합성", "합성",
                MAPPER.createObjectNode());
        assertThat(job.run()).isEqualTo(2);
        assertThat(events(mine.id())).isEqualTo(1);
        assertThat(events(his.id())).isEqualTo(1);

        jdbc.update("DELETE FROM users WHERE id = ?", bob);           // 탈퇴 — 배달은 함께 지워지고 사건만 남음
        jdbc.update("DELETE FROM alert_deliveries WHERE user_id = ? AND event_id IN (SELECT id FROM alert_events WHERE event_key LIKE ?)",
                alice, "search_watch:" + mine.id() + ":%");          // 알림함 90일 정리와 같은 결과
        clock.advance(Duration.ofMinutes(15));
        job.run();

        assertThat(events(his.id())).as("탈퇴한 사용자의 사건").isZero();
        assertThat(events(mine.id())).as("배달이 정리된 사건").isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM alert_events WHERE event_key = ?", Long.class, OTHER_EVENT + "other"))
                .as("다른 종류의 사건(전역 사실 — 중복 판정 키)은 지우지 않음").isEqualTo(1L);
    }

    @Test
    @DisplayName("알림함의 href는 화면 안 주소('/'로 시작, '//'·역슬래시·제어 글자 없음)만 — 아니면 null")
    void inboxHrefIsInAppOnly() {
        List<String> hrefs = List.of("/search?e=topic:x&tab=timeline", "https://example.invalid/x", "//example.invalid/x", "/\\example.invalid",
                "javascript:alert(1)", "/search?e=a\u0007b");
        for (int i = 0; i < hrefs.size(); i++) {
            long event = alerts.insertEvent("SEARCH_WATCH", OTHER_EVENT + "href:" + i, java.time.LocalDate.parse("2026-11-15"), "합성 " + i, "합성",
                    MAPPER.createObjectNode().put("href", hrefs.get(i))).orElseThrow();
            alerts.deliverInbox(event, alice);
        }
        long none = alerts.insertEvent("SEARCH_WATCH", OTHER_EVENT + "href:none", java.time.LocalDate.parse("2026-11-15"), "합성 없음", "합성",
                MAPPER.createObjectNode()).orElseThrow();
        alerts.deliverInbox(none, alice);

        java.util.Map<String, String> byTitle = new java.util.HashMap<>();
        alerts.inbox(alice, 20).forEach(row -> byTitle.put(row.title(), row.href()));
        assertThat(byTitle).hasSize(hrefs.size() + 1).containsEntry("합성 0", "/search?e=topic:x&tab=timeline")
                .containsEntry("합성 1", null).containsEntry("합성 2", null).containsEntry("합성 3", null).containsEntry("합성 4", null)
                .containsEntry("합성 5", null).containsEntry("합성 없음", null);
    }
}
