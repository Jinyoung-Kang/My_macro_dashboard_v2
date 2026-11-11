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
    private TranslationStore translations;

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
        translations = new TranslationStore(jdbc, schema);
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM info_items WHERE source LIKE 'test-%'");
        jdbc.update("DELETE FROM fetch_source_state WHERE task LIKE 'test-%'");
        jdbc.update("DELETE FROM source_alerts WHERE task LIKE 'test-%'");
        jdbc.update("DELETE FROM info_translations WHERE model = 'test-model'");
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

        InfoStore.Page<InfoStore.Item> all = info.items(List.of("test-a", "test-b"), null, 0, 10);
        assertThat(all.total()).isEqualTo(3);
        assertThat(all.rows()).extracting(InfoStore.Item::id)
                .containsExactly("a00000000000000000000002", "a00000000000000000000001", "a00000000000000000000003");
        assertThat(all.rows().get(1).body()).isNull();
        assertThat(all.rows().get(1).meta().path("category").asText()).isEqualTo("x");

        assertThat(info.items(List.of("test-a", "test-b"), "rates", 0, 10).rows()).hasSize(2);
        assertThat(info.items(List.of("test-a", "test-b"), "100%", 0, 10).rows()).extracting(InfoStore.Item::id)
                .containsExactly("a00000000000000000000003");
        assertThat(info.items(List.of("test-b"), null, 0, 10).rows()).hasSize(1);
        InfoStore.Page<InfoStore.Item> second = info.items(List.of("test-a", "test-b"), null, 2, 2);
        assertThat(second.rows()).extracting(InfoStore.Item::id).containsExactly("a00000000000000000000003");
        assertThat(second.total()).isEqualTo(3);
        // QA-400(2026-11-12): 패킷 후보의 창은 작성 시각이 아니라 처음 받은 시각입니다 — 예전 기대(작성 시각이 창 안인 1번 + 받은 시각으로 본 2번)에서
        // 1번이 빠집니다(작성은 창 안이지만 창 끝 30초 뒤에 처음 받음 — 다음 창의 몫). 자세한 경계는 아래 packetWindowIsByFirstSeenAt.
        assertThat(info.recentForPacket(List.of("test-a", "test-b"), NOW.minusSeconds(4000), NOW.minusSeconds(30), Duration.ofHours(72), 2,
                List.of())).extracting(InfoStore.Item::id).as("창 (from, to] 안에 처음 받은 글")
                .containsExactly("a00000000000000000000002");
        assertThat(info.recentForPacket(List.of("test-a", "test-b"), NOW.minusSeconds(30), NOW, Duration.ofHours(72), 2, List.of()))
                .extracting(InfoStore.Item::id).as("다음 창 — 본문 다 받은 글, 작성 최근 순")
                .containsExactly("a00000000000000000000001", "a00000000000000000000003");
        assertThat(info.recentForPacket(List.of(), NOW.minusSeconds(4000), NOW, Duration.ofHours(72), 2, List.of())).isEmpty();
        assertThat(info.item("a00000000000000000000001")).get().extracting(InfoStore.Item::body).isEqualTo("본문 1");
        assertThat(info.counts()).filteredOn(count -> count.source().equals("test-a")).singleElement()
                .satisfies(count -> assertThat(count.items()).isEqualTo(2));
    }

    private void item(String id, String source, Instant published, Instant firstSeen, boolean full, String category) {
        jdbc.update("INSERT INTO info_items (id, source, kind, url, title, published_at, first_seen_at, summary, body, body_status, meta) "
                        + "VALUES (?, ?, 'article', ?, ?, ?, ?, ?, ?, ?, ?::jsonb)",
                id, source, "https://example.org/" + id, "제목 " + id, published == null ? null : Timestamp.from(published),
                Timestamp.from(firstSeen), "요약 " + id, full ? "본문" : null, full ? "full" : "none",
                category == null ? "{}" : "{\"category\": \"" + category + "\"}");
    }

    /** 패킷의 수집 글 섹션이 후보를 읽는 호출 그대로({@code ReadingSection.candidates}) — 창 (from, to], 받을 때 작성 72시간 안, 출처·분류마다 2편. */
    private List<String> packetIds(List<String> sources, Instant from, Instant to) {
        return info.recentForPacket(sources, from, to, Duration.ofHours(72), 2, List.of("국내", "한국", "코스피", "코스닥")).stream()
                .map(InfoStore.Item::id).toList();
    }

    @Test
    @DisplayName("QA-400: 패킷 후보의 창은 처음 받은 시각 (from, to] — 작성이 창 앞이어도 창 안에 받았으면 들고, 받을 때 작성 72시간이 넘었거나 작성이 "
            + "창 끝보다 뒤면 빠지며, 글마다 한 창에만 든다")
    void packetWindowIsByFirstSeenAt() {
        Instant to = NOW;                              // 이번 결정
        Instant from = to.minusSeconds(24 * 3600);     // 직전 결정
        Instant next = to.plusSeconds(24 * 3600);      // 다음 결정
        Instant previous = from.minusSeconds(24 * 3600);
        // 글마다 출처를 달리합니다 — 출처마다 2편 상한(packetCandidatesAreCappedPerSource)이 창 판정에 섞이지 않게.
        List<String> sources = List.of("test-w1", "test-w2", "test-w3", "test-w4", "test-w5", "test-w6", "test-w7", "test-w8", "test-w9",
                "test-wa");
        // 블로그가 직전 결정 2시간 전에 낸 글을 수집기가 직전 결정 1시간 뒤에 처음 받음 — 이번 창의 몫
        item("b00000000000000000000001", "test-w1", from.minusSeconds(2 * 3600), from.plusSeconds(3600), true, null);
        // 처음 수집하는 피드에 남아 있던 열흘 전 글 — 받을 때 이미 72시간이 넘어 어느 창에도 싣지 않음
        item("b00000000000000000000002", "test-w2", to.minusSeconds(10 * 24 * 3600), from.plusSeconds(2 * 3600), true, null);
        // 이번 결정 1시간 전에 쓰였지만 결정 90분 뒤에 처음 받음 — 이번 창이 아니라 다음 창의 몫(지금은 다음 창에서도 빠짐)
        item("b00000000000000000000003", "test-w3", to.minusSeconds(3600), to.plusSeconds(90 * 60), true, null);
        // 직전 창에 받은 글 — 앞 창의 몫이라 이번 창에 다시 싣지 않음
        item("b00000000000000000000004", "test-w4", from.minusSeconds(3 * 3600), from.minusSeconds(3600), true, null);
        // 작성 시각이 이번 결정보다 뒤(시각이 틀린 글) — 싣지 않음
        item("b00000000000000000000005", "test-w5", to.plusSeconds(2 * 3600), from.plusSeconds(3 * 3600), true, null);
        // 작성 시각을 모르는 글 — 받은 시각으로 봄
        item("b00000000000000000000006", "test-w6", null, from.plusSeconds(4 * 3600), false, null);
        // 경계: 받은 시각이 창 끝과 같으면 이번 창, 창 시작과 같으면 앞 창
        item("b00000000000000000000007", "test-w7", to.minusSeconds(600), to, true, null);
        item("b00000000000000000000008", "test-w8", from.minusSeconds(600), from, true, null);
        // 경계: 받을 때 작성 뒤 정확히 72시간이면 들고, 1초 더 지났으면 빠짐
        item("b00000000000000000000009", "test-w9", from.plusSeconds(5 * 3600).minusSeconds(72 * 3600), from.plusSeconds(5 * 3600), true, null);
        item("b0000000000000000000000a", "test-wa", from.plusSeconds(5 * 3600).minusSeconds(72 * 3600 + 1), from.plusSeconds(5 * 3600), true, null);

        List<String> before = packetIds(sources, previous, from);
        List<String> current = packetIds(sources, from, to);
        List<String> after = packetIds(sources, to, next);

        assertThat(current).as("이번 창 (from, to]").containsExactlyInAnyOrder("b00000000000000000000001", "b00000000000000000000006",
                "b00000000000000000000007", "b00000000000000000000009");
        assertThat(before).as("앞 창").containsExactlyInAnyOrder("b00000000000000000000004", "b00000000000000000000008");
        assertThat(after).as("다음 창 — 이번 결정 뒤에 처음 받은 글").containsExactly("b00000000000000000000003");
        List<String> all = new java.util.ArrayList<>(before);
        all.addAll(current);
        all.addAll(after);
        assertThat(all).as("글마다 한 창에만").doesNotHaveDuplicates();
    }

    @Test
    @DisplayName("QA-400: 패킷 후보는 출처마다 상위 2편(본문 다 받은 글·최근 순) — 글이 61건인 출처와 오래된 2건뿐인 출처가 둘 다 들고, 분류 표시가 "
            + "든 글과 아닌 글은 따로 센다(국내·해외 시장 글이 서로를 밀어내지 않게)")
    void packetCandidatesAreCappedPerSource() {
        Instant to = NOW;
        Instant from = to.minusSeconds(72 * 3600);
        for (int i = 0; i < 61; i++) {
            item(String.format("c%023d", i), "test-many", to.minusSeconds(60L * (i + 1)), to.minusSeconds(60L * (i + 1)), true, null);
        }
        item("d00000000000000000000001", "test-few", to.minusSeconds(40 * 3600), to.minusSeconds(39 * 3600), false, null);
        item("d00000000000000000000002", "test-few", to.minusSeconds(50 * 3600), to.minusSeconds(49 * 3600), true, null);
        for (int i = 0; i < 3; i++) {
            item("e0000000000000000000000" + i, "test-brief", to.minusSeconds(600L * (i + 1)), to.minusSeconds(600L * (i + 1)), true,
                    "마감 브리핑 · 국내");
        }
        item("e00000000000000000000005", "test-brief", to.minusSeconds(5 * 3600), to.minusSeconds(5 * 3600), true, "시장 · 해외 소식");
        item("e00000000000000000000006", "test-brief", to.minusSeconds(6 * 3600), to.minusSeconds(6 * 3600), true, null);
        item("e00000000000000000000007", "test-brief", to.minusSeconds(7 * 3600), to.minusSeconds(7 * 3600), true, "시장 · 해외 소식");

        List<String> ids = packetIds(List.of("test-many", "test-few", "test-brief"), from, to);

        assertThat(ids).filteredOn(id -> id.startsWith("c")).as("글이 많은 출처도 2편까지 — 가장 최근 둘")
                .containsExactly(String.format("c%023d", 0), String.format("c%023d", 1));
        assertThat(ids).filteredOn(id -> id.startsWith("d")).as("오래된 2건뿐인 출처도 후보에 듦 — 본문 다 받은 글이 앞")
                .containsExactly("d00000000000000000000002", "d00000000000000000000001");
        assertThat(ids).filteredOn(id -> id.startsWith("e")).as("분류 표시(국내)가 든 글 둘 + 아닌 글 둘")
                .containsExactly("e00000000000000000000000", "e00000000000000000000001", "e00000000000000000000005",
                        "e00000000000000000000006");
        assertThat(ids).as("전체 순서는 본문 다 받은 글 먼저, 그 안에서 최근 순").startsWith(String.format("c%023d", 0))
                .endsWith("d00000000000000000000001");
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

    @Test
    @DisplayName("번역 저장(V35) — id는 Postgres md5와 같고, 먼저 넣은 번역을 지키며, 글자 수를 센다")
    void translationsRoundTrip() {
        assertThat(translations.ready()).isTrue();
        String title = "Fed's Waller: 금리 is “restrictive” — test " + System.nanoTime();
        String id = TranslationStore.id(TranslationStore.TITLE, title);

        assertThat(id).isEqualTo(jdbc.queryForObject("SELECT md5('title:' || ?)", String.class, title));
        long before = translations.charsSince(Instant.now().minusSeconds(3600));
        translations.put(id, TranslationStore.TITLE, title.length(), "월러: 금리는 제약적", "test-model");
        translations.put(id, TranslationStore.TITLE, title.length(), "다른 번역", "test-model");

        assertThat(translations.find(List.of(id, "missing"))).containsExactly(java.util.Map.entry(id, "월러: 금리는 제약적"));
        // 번역 행에 남긴 모델 이름도 다시 읽습니다(QA-403) — 번역이 없는 id는 빠집니다.
        assertThat(translations.models(List.of(id, "missing"))).containsExactly(java.util.Map.entry(id, "test-model"));
        assertThat(translations.models(List.of())).isEmpty();
        assertThat(translations.charsSince(Instant.now().minusSeconds(3600)) - before).isEqualTo(title.length());
    }
}
