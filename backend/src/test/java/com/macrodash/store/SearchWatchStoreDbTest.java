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
import static org.assertj.core.api.Assertions.within;

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

    /** 화제 판정용 합성 글 — 작성 시각을 모르면(정기 피드의 처음 받은 시각 기준 줄) null. */
    private void hotItem(String key, String itemId, String source, Instant publishedAt, Instant firstSeenAt) {
        jdbc.update("INSERT INTO search_watch_items (entity_key, item_id, kind, title, source, published_at, first_seen_at) "
                        + "VALUES (?, ?, 'news', '합성 제목', ?, ?, ?)", key, itemId, source,
                publishedAt == null ? null : Timestamp.from(publishedAt), Timestamp.from(firstSeenAt));
    }

    @Test
    @DisplayName("화제 건수 — 지난 24시간과 그 앞 30일(지금의 31일 전~24시간 전)에 처음 받은 글을 따로 센다. 경계·창 밖·미래 시각, 받을 때 이미 하루 넘게 지난 글(첫 수집의 옛 글)은 세지 않는다")
    void buzzCountsWindows() {
        Instant now = AT.plus(Duration.ofDays(60));
        SearchWatchStore.Watch watch = store.insert(alice, MARK + "h", "topic", "h", List.of("h"), null, AT);
        for (int n = 0; n < 6; n++) {
            hotItem(MARK + "h", "day" + n, "google_en", now.minus(Duration.ofHours(n + 2)), now.minus(Duration.ofHours(n + 1)));
        }
        hotItem(MARK + "h", "feedNoTime", "feeds", null, now.minus(Duration.ofHours(3)));                     // 작성 시각 모름 — 처음 받은 시각 기준, 셈
        hotItem(MARK + "h", "backfill", "google_ko", now.minus(Duration.ofDays(10)), now.minus(Duration.ofHours(2)));   // 받을 때 열흘 지난 글 — 빼
        hotItem(MARK + "h", "edge", "google_en", now.minus(Duration.ofHours(30)), now.minus(Duration.ofHours(24)));    // 정확히 24시간 전 — 앞 30일 쪽
        for (int n = 0; n < 9; n++) {
            hotItem(MARK + "h", "base" + n, "bing", now.minus(Duration.ofDays(n + 2)), now.minus(Duration.ofDays(n + 2)).plusSeconds(600));
        }
        hotItem(MARK + "h", "lateBase", "bing", now.minus(Duration.ofDays(9)), now.minus(Duration.ofDays(5)));       // 받을 때 나흘 지난 글 — 빼
        hotItem(MARK + "h", "tooOld", "bing", now.minus(Duration.ofDays(32)), now.minus(Duration.ofDays(32)));       // 31일보다 전 — 빼
        hotItem(MARK + "h", "future", "bing", now.plusSeconds(60), now.plusSeconds(60));                            // 지금 뒤 — 빼
        SearchWatchStore.Watch quiet = store.insert(alice, MARK + "q", "topic", "q", List.of("q"), null, AT);

        Map<Long, SearchWatchStore.Buzz> buzz = store.buzz(alice, List.of(), now);

        assertThat(buzz.get(watch.id())).isEqualTo(new SearchWatchStore.Buzz(7, 10, 30.0));
        assertThat(buzz.get(quiet.id())).as("글이 없는 대상도 한 줄(0건)").isEqualTo(new SearchWatchStore.Buzz(0, 0, 30.0));
        assertThat(store.buzz(bob, List.of(), now)).as("등록한 것이 없으면 빈 지도").isEmpty();
    }

    @Test
    @DisplayName("화제 건수 — 숨길 출처(회원의 운영자 전용 출처)는 세지 않는다(새 글 수와 같음)")
    void buzzHidesSources() {
        Instant now = AT.plus(Duration.ofDays(40));
        SearchWatchStore.Watch watch = store.insert(alice, MARK + "s", "topic", "s", List.of("s"), null, AT);
        String[] sources = {"google_en", "feeds", "wire", "info", "guru"};
        for (int n = 0; n < sources.length; n++) {
            hotItem(MARK + "s", "s" + n, sources[n], now.minus(Duration.ofHours(n + 1)), now.minus(Duration.ofHours(n + 1)));
            hotItem(MARK + "s", "b" + n, sources[n], now.minus(Duration.ofDays(n + 3)), now.minus(Duration.ofDays(n + 3)));
        }

        assertThat(store.buzz(alice, List.of(), now).get(watch.id())).isEqualTo(new SearchWatchStore.Buzz(5, 5, 30.0));
        assertThat(store.buzz(alice, List.of("info", "guru", "wire"), now).get(watch.id())).isEqualTo(new SearchWatchStore.Buzz(2, 2, 30.0));
    }

    @Test
    @DisplayName("화제의 앞 30일 가운데 모은 날 수는 그 대상이 서버에서 처음 등록된 때부터(누가 등록했든) — 하루 전에 처음 등록된 대상은 0일")
    void buzzBaselineDaysFromFirstRegistration() {
        Instant now = AT.plus(Duration.ofDays(60));
        store.insert(bob, MARK + "f", "topic", "f", List.of("f"), null, now.minus(Duration.ofDays(10)));
        SearchWatchStore.Watch shared = store.insert(alice, MARK + "f", "topic", "f", List.of("f"), null, now.minus(Duration.ofHours(2)));
        SearchWatchStore.Watch fresh = store.insert(alice, MARK + "g", "topic", "g", List.of("g"), null, now.minus(Duration.ofHours(2)));
        SearchWatchStore.Watch dayAgo = store.insert(alice, MARK + "k", "topic", "k", List.of("k"), null, now.minus(Duration.ofHours(36)));

        Map<Long, SearchWatchStore.Buzz> buzz = store.buzz(alice, List.of(), now);

        assertThat(buzz.get(shared.id()).earlierDays()).as("bob이 열흘 전에 등록 — 앞 30일 중 9일").isCloseTo(9.0, within(1e-9));
        assertThat(buzz.get(fresh.id()).earlierDays()).isZero();
        assertThat(buzz.get(dayAgo.id()).earlierDays()).isCloseTo(0.5, within(1e-9));
    }

    @Test
    @DisplayName("화제의 앞 30일 건수는 모은 날과 같은 기간 — 먼저 등록한 사람이 지워 처음 등록 시각이 늦어지면, 그 앞에 쓰인 글(그때 모은 글)은 세지 않는다")
    void buzzBaselineCountMatchesDaysAfterEarliestLeaves() {
        Instant now = AT.plus(Duration.ofDays(60));
        SearchWatchStore.Watch first = store.insert(bob, MARK + "m", "topic", "m", List.of("m"), null, now.minus(Duration.ofDays(60)));
        SearchWatchStore.Watch later = store.insert(alice, MARK + "m", "topic", "m", List.of("m"), null, now.minus(Duration.ofDays(10)));
        for (int k = 1; k <= 30; k++) {      // 하루 한 건 — 지금의 36시간 전 ~ 732시간 전, 모두 앞 30일 안
            Instant written = now.minus(Duration.ofHours(k * 24L + 12));
            hotItem(MARK + "m", "d" + k, "bing", written, written.plusSeconds(600));
        }
        for (int n = 0; n < 5; n++) {
            hotItem(MARK + "m", "now" + n, "google_en", now.minus(Duration.ofHours(n + 2)), now.minus(Duration.ofHours(n + 1)));
        }
        assertThat(store.buzz(alice, List.of(), now).get(later.id())).as("bob이 60일 전부터 모음 — 30일 30건, 평균 1")
                .isEqualTo(new SearchWatchStore.Buzz(5, 30, 30.0));

        store.delete(first.id(), bob);
        SearchWatchStore.Buzz buzz = store.buzz(alice, List.of(), now).get(later.id());

        assertThat(buzz).as("alice가 등록한 10일 전부터 — 모은 날 9일, 그 사이에 쓰인 9건").isEqualTo(new SearchWatchStore.Buzz(5, 9, 9.0));
        assertThat(buzz.dailyAverage()).isCloseTo(1.0, within(1e-9));
        assertThat(buzz.hot()).isTrue();
    }

    @Test
    @DisplayName("화제의 앞 30일 건수는 처음 등록한 뒤에 쓰인 글만 — 첫 수집이 넣은 등록 전 하루치와, 처음 받은 시각을 과거로 되돌린 작성 시각 없는 줄은 세지 않는다")
    void buzzBaselineSkipsWhatWasWrittenBeforeFirstRegistration() {
        Instant now = AT.plus(Duration.ofDays(60));
        Instant since = now.minus(Duration.ofHours(72));
        SearchWatchStore.Watch watch = store.insert(alice, MARK + "r", "topic", "r", List.of("r"), null, since);
        hotItem(MARK + "r", "storeOld", "feeds", null, now.minus(Duration.ofDays(5)));                        // 저장본이 닷새 전에 받은 줄 — 빼
        hotItem(MARK + "r", "storeOlder", "event_news", null, now.minus(Duration.ofDays(20)));               // 스무날 전 — 빼
        hotItem(MARK + "r", "preReg", "google_en", since.minus(Duration.ofHours(6)), since.plusSeconds(300));  // 첫 수집의 등록 전 6시간 글 — 빼
        hotItem(MARK + "r", "post1", "google_en", since.plus(Duration.ofHours(6)), since.plus(Duration.ofHours(7)));
        hotItem(MARK + "r", "post2", "bing", since.plus(Duration.ofHours(30)), since.plus(Duration.ofHours(31)));
        hotItem(MARK + "r", "postNoTime", "feeds", null, since.plus(Duration.ofHours(40)));

        SearchWatchStore.Buzz buzz = store.buzz(alice, List.of(), now).get(watch.id());

        assertThat(buzz).isEqualTo(new SearchWatchStore.Buzz(0, 3, 2.0));
        assertThat(buzz.dailyAverage()).isCloseTo(1.5, within(1e-9));
    }

    @Test
    @DisplayName("화제 건수 — 날짜만 아는 줄(DART·SEC 전문 검색·국내 리포트, 접수 시각 없는 SEC 줄)은 그 날의 끝을 작성 시각으로 본다. 시각을 아는 줄은 하루 넘게 늦게 받으면 빼")
    void buzzDateOnlyRowsCountUntilTheDayEnds() {
        Instant now = Instant.parse("2027-01-13T03:00:00Z");                                                  // KST 1월 13일 12:00
        SearchWatchStore.Watch watch = store.insert(alice, MARK + "t", "topic", "t", List.of("t"), null, AT);
        // KST 1월 12일 공시를 다음 날 01:00 KST에 처음 받음(00:00에서 25시간)
        hotItem(MARK + "t", "dart", "dart", Instant.parse("2027-01-11T15:00:00Z"), Instant.parse("2027-01-12T16:00:00Z"));
        hotItem(MARK + "t", "naver", "naver_research", Instant.parse("2027-01-11T15:00:00Z"), Instant.parse("2027-01-12T17:00:00Z"));
        // 미국 동부 1월 11일 00:00(EST)의 날짜 줄을 26·27시간 뒤에 받음
        hotItem(MARK + "t", "fts", "sec_fts", Instant.parse("2027-01-11T05:00:00Z"), Instant.parse("2027-01-12T07:00:00Z"));
        hotItem(MARK + "t", "secDay", "sec", Instant.parse("2027-01-11T05:00:00Z"), Instant.parse("2027-01-12T08:00:00Z"));
        // 접수 시각을 아는 SEC 줄·시각 있는 뉴스는 25시간 늦게 받으면 빼
        hotItem(MARK + "t", "secTime", "sec", Instant.parse("2027-01-11T21:08:27Z"), Instant.parse("2027-01-12T22:10:00Z"));
        hotItem(MARK + "t", "late", "google_en", Instant.parse("2027-01-11T09:00:00Z"), Instant.parse("2027-01-12T10:00:00Z"));
        // 날짜 줄이라도 그 날이 끝나고 하루 넘게 지나 받으면 빼
        hotItem(MARK + "t", "dartOld", "dart", Instant.parse("2027-01-09T15:00:00Z"), Instant.parse("2027-01-12T18:00:00Z"));

        assertThat(store.buzz(alice, List.of(), now).get(watch.id())).isEqualTo(new SearchWatchStore.Buzz(4, 0, 30.0));
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
