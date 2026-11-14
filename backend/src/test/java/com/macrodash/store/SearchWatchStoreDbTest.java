package com.macrodash.store;

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
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 관심 대상·매체 제외 표(V37, ADR 0041 결정 9) — 실제 테스트 DB에서 사용자·대상마다 한 줄, 자기 줄만 지우고 '봤음'을 적기, 새 글 수(마지막으로 본 뒤 처음 받은 글,
 * 회원은 운영자 전용 출처를 세지 않음), 서로 다른 대상 수, 매체 제외의 대소문자 무시 유일을 확인합니다. 수집기 글 표({@code search_watch_items})는 백엔드가
 * 읽기만 하므로 이 시험의 준비 줄은 시험 코드가 직접 넣습니다.
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 시험용 사용자(이메일 표지)와 대상 키 표지({@code topic:시험표지…})만 지웁니다.
 */
class SearchWatchStoreDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String MARK = "topic:시험표지";
    private static final String EMAIL = "search-watch-store-test-%d@example.invalid";
    private static final Instant AT = Instant.parse("2026-11-14T03:00:00Z");

    private JdbcTemplate jdbc;
    private SearchWatchStore store;
    private SearchExcludeStore excludes;
    private long alice;
    private long bob;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"), System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new SearchWatchStore(jdbc, MAPPER, new SchemaCheck(jdbc));
        excludes = new SearchExcludeStore(jdbc, new SchemaCheck(jdbc));
        cleanUp();
        alice = user(1);
        bob = user(2);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM search_watch_items WHERE entity_key LIKE ?", MARK + "%");
        jdbc.update("DELETE FROM users WHERE email LIKE 'search-watch-store-test-%@example.invalid'");   // search_watches는 CASCADE
        jdbc.update("DELETE FROM search_media_excludes WHERE value LIKE '%.store-test.invalid' OR value LIKE 'Store Test %'");
    }

    private long user(int n) {
        Long id = jdbc.queryForObject("INSERT INTO users (email, password_hash, role) VALUES (?, 'x', 'MEMBER') RETURNING id",
                Long.class, EMAIL.formatted(n));
        return id == null ? -1 : id;
    }

    private void item(String key, String itemId, String source, Instant firstSeenAt) {
        jdbc.update("INSERT INTO search_watch_items (entity_key, item_id, kind, title, source, published_at, first_seen_at) "
                + "VALUES (?, ?, 'news', '합성 제목', ?, NULL, ?)", key, itemId, source, Timestamp.from(firstSeenAt));
    }

    @Test
    @DisplayName("표가 있으면 준비됨 — 사용자·대상마다 한 줄, 다시 넣으면 처음 줄이 그대로(이름·별칭·식별자 유지)")
    void oneRowPerUserAndKey() {
        assertThat(store.ready()).isTrue();
        SearchWatchStore.Watch first = store.insert(alice, MARK + "1", "topic", "첫 이름", List.of("첫 이름", "별칭"),
                MAPPER.valueToTree(Map.of("ticker", "NVDA")), AT);
        SearchWatchStore.Watch again = store.insert(alice, MARK + "1", "company", "다른 이름", List.of(), null, AT.plusSeconds(60));

        assertThat(again.id()).isEqualTo(first.id());
        assertThat(again.name()).isEqualTo("첫 이름");
        assertThat(again.kind()).isEqualTo("topic");
        assertThat(again.aliases()).containsExactly("첫 이름", "별칭");
        assertThat(again.ids().path("ticker").asString()).isEqualTo("NVDA");
        assertThat(again.createdAt()).isEqualTo(AT);
        assertThat(again.lastSeenAt()).isEqualTo(AT);
        assertThat(store.countForUser(alice)).isEqualTo(1);
        assertThat(store.find(alice, MARK + "1")).contains(first);
        assertThat(store.find(bob, MARK + "1")).isEmpty();

        SearchWatchStore.Watch bare = store.insert(bob, MARK + "2", "person", "이름만", List.of(), null, AT);
        assertThat(bare.ids().isObject()).as("식별자가 없으면 빈 객체").isTrue();
        assertThat(bare.ids().size()).isZero();
        assertThat(bare.aliases()).isEmpty();
    }

    @Test
    @DisplayName("서로 다른 대상 수와 '누군가 등록함'은 사용자를 가리지 않고 센다")
    void distinctKeys() {
        int before = store.countKeys();
        store.insert(alice, MARK + "a", "topic", "a", List.of("a"), null, AT);
        store.insert(bob, MARK + "a", "topic", "a", List.of("a"), null, AT);
        store.insert(bob, MARK + "b", "topic", "b", List.of("b"), null, AT);

        assertThat(store.countKeys()).isEqualTo(before + 2);
        assertThat(store.watchedByAnyone(MARK + "a")).isTrue();
        assertThat(store.watchedByAnyone(MARK + "zz")).isFalse();
        assertThat(store.watches(bob)).extracting(SearchWatchStore.Watch::entityKey).containsExactly(MARK + "a", MARK + "b");
    }

    @Test
    @DisplayName("지우기·봤음은 자기 줄만 — 남의 번호는 0줄, 봤음은 그 시각을 돌려준다")
    void deleteAndSeenOwnRowsOnly() {
        SearchWatchStore.Watch mine = store.insert(alice, MARK + "d", "topic", "d", List.of("d"), null, AT);

        assertThat(store.delete(mine.id(), bob)).isZero();
        assertThat(store.markSeen(mine.id(), bob, AT.plusSeconds(5))).isEmpty();
        assertThat(store.markSeen(mine.id(), alice, AT.plusSeconds(5))).contains(AT.plusSeconds(5));
        assertThat(store.find(alice, MARK + "d").orElseThrow().lastSeenAt()).isEqualTo(AT.plusSeconds(5));
        assertThat(store.delete(mine.id(), alice)).isEqualTo(1);
        assertThat(store.find(alice, MARK + "d")).isEmpty();
    }

    @Test
    @DisplayName("새 글 수 — 마지막으로 본 뒤 처음 받은 글만, 숨길 출처를 주면 그 출처는 세지 않는다. 글이 없는 대상은 0")
    void newCounts() {
        SearchWatchStore.Watch nvda = store.insert(alice, MARK + "n", "topic", "n", List.of("n"), null, AT);
        SearchWatchStore.Watch empty = store.insert(alice, MARK + "e", "topic", "e", List.of("e"), null, AT);
        item(MARK + "n", "i0", "google_ko", AT.minus(Duration.ofMinutes(1)));
        item(MARK + "n", "i1", "google_en", AT.plusSeconds(60));
        item(MARK + "n", "i2", "wire", AT.plusSeconds(120));
        item(MARK + "n", "i3", "info", AT.plusSeconds(180));
        item(MARK + "n", "i4", "feeds", AT.plusSeconds(240));

        assertThat(store.newCounts(alice, List.of())).containsEntry(nvda.id(), 4).containsEntry(empty.id(), 0);
        assertThat(store.newCounts(alice, List.of("info", "guru", "wire"))).containsEntry(nvda.id(), 2).containsEntry(empty.id(), 0);

        store.markSeen(nvda.id(), alice, AT.plusSeconds(200));
        assertThat(store.newCounts(alice, List.of())).containsEntry(nvda.id(), 1);
        assertThat(store.newCounts(bob, List.of())).isEmpty();
    }

    @Test
    @DisplayName("새 글 수는 작성 시각이 마지막으로 본 때의 하루 전·등록 시각보다 앞선 글을 세지 않는다 — 등록 직후 첫 수집이 넣은 2년치가 '새 글 100+'이 되지 않게")
    void newCountsSkipBackfill() {
        SearchWatchStore.Watch watch = store.insert(alice, MARK + "b", "topic", "b", List.of("b"), null, AT);
        Instant collected = AT.plusSeconds(600);
        insertItem(MARK + "b", "old", AT.minus(Duration.ofDays(30)), collected);
        insertItem(MARK + "b", "before", AT.minus(Duration.ofHours(20)), collected);
        insertItem(MARK + "b", "after", AT.plusSeconds(300), collected);
        assertThat(store.newCounts(alice, List.of())).as("등록 전 글(30일 전·20시간 전)은 빼고 등록 뒤 글만").containsEntry(watch.id(), 1);

        Instant seen = AT.plus(Duration.ofDays(3));
        store.markSeen(watch.id(), alice, seen);
        Instant later = seen.plus(Duration.ofHours(6));
        insertItem(MARK + "b", "late", seen.minus(Duration.ofHours(20)), later);
        insertItem(MARK + "b", "stale", seen.minus(Duration.ofDays(5)), later);
        assertThat(store.newCounts(alice, List.of())).as("등록 하루 뒤부터는 본 때의 24시간 전 뒤에 나온 늦게 잡힌 글을 셈, 5일 전 글은 아님")
                .containsEntry(watch.id(), 1);
    }

    private void insertItem(String key, String itemId, Instant publishedAt, Instant firstSeenAt) {
        jdbc.update("INSERT INTO search_watch_items (entity_key, item_id, kind, title, source, published_at, first_seen_at) "
                + "VALUES (?, ?, 'news', '합성 제목', 'google_en', ?, ?)", key, itemId, Timestamp.from(publishedAt), Timestamp.from(firstSeenAt));
    }

    @Test
    @DisplayName("매체 제외 — 종류·값(대소문자 무시)마다 한 줄, 다시 넣으면 빈 값이고 찾기로 처음 줄을 얻는다. 번호로 지운다")
    void excludesAreUniqueIgnoringCase() {
        assertThat(excludes.ready()).isTrue();
        Optional<SearchExcludeStore.Exclude> first = excludes.insert("name", "Store Test Wire", "합성 메모");
        assertThat(first).isPresent();
        assertThat(excludes.insert("name", "store test wire", null)).isEmpty();
        assertThat(excludes.insert("domain", "a.store-test.invalid", null)).isPresent();
        assertThat(excludes.find("name", "STORE TEST WIRE")).contains(first.get());
        assertThat(excludes.all()).extracting(SearchExcludeStore.Exclude::value).contains("Store Test Wire", "a.store-test.invalid");
        assertThat(first.get().note()).isEqualTo("합성 메모");
        assertThat(first.get().createdAt()).isNotNull();

        assertThat(excludes.delete(first.get().id())).isEqualTo(1);
        assertThat(excludes.delete(first.get().id())).isZero();
        assertThat(excludes.find("name", "Store Test Wire")).isEmpty();
    }
}
