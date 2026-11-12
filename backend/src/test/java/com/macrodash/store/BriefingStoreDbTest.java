package com.macrodash.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 마감 브리핑 기록 표(V36, ADR 0039) — 실제 테스트 DB(macrodash_test)에서 '시장·세션마다 한 행'과 보낸 시각 적기를 확인합니다.
 *
 * <p>운영 DB로 돌지 않도록 이름이 {@code _test}로 끝나는지 먼저 확인합니다. 1999년 날짜만 쓰고 그 날짜만 지웁니다.
 */
class BriefingStoreDbTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final LocalDate DAY = LocalDate.of(1999, 1, 4);

    private JdbcTemplate jdbc;
    private BriefingStore store;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        DriverManagerDataSource dataSource = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"), System.getenv().getOrDefault("DATABASE_PASSWORD", "macro"));
        jdbc = new JdbcTemplate(dataSource);
        store = new BriefingStore(jdbc, new SchemaCheck(jdbc), MAPPER);
        cleanUp();
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM paper_briefings WHERE session_date < '2000-01-01'");
    }

    private static BriefingStore.Row row(String market, String status, String message) {
        boolean ok = BriefingStore.OK.equals(status);
        return new BriefingStore.Row(market, DAY, status, MAPPER.valueToTree(Map.of("session", DAY.toString())),
                ok ? MAPPER.valueToTree(Map.of("headline", "한 줄")) : null, message, ok ? "claude-sonnet-5-5" : null,
                ok ? MAPPER.valueToTree(Map.of("inputTokens", 9000)) : null, ok ? null : "하루 호출 상한", null, null);
    }

    @Test
    @DisplayName("시장·세션마다 한 행 — 두 번째 넣기는 무시되고 첫 행이 그대로, 시장이 다르면 따로. 읽으면 사실·응답·글·사용량이 그대로이고 보낸 시각은 비어 있다")
    void oneRowPerMarketAndSession() {
        assertThat(store.ready()).isTrue();
        assertThat(store.find("US", DAY)).isEmpty();
        assertThat(store.insertIfAbsent(row("US", BriefingStore.OK, "첫 글"))).isTrue();
        assertThat(store.insertIfAbsent(row("US", BriefingStore.FACTS_ONLY, "둘째 글"))).isFalse();
        assertThat(store.insertIfAbsent(row("KR", BriefingStore.FACTS_ONLY, "한국 글"))).isTrue();

        BriefingStore.Row us = store.find("US", DAY).orElseThrow();
        assertThat(us.status()).isEqualTo(BriefingStore.OK);
        assertThat(us.message()).isEqualTo("첫 글");
        assertThat(us.facts().get("session").asString()).isEqualTo("1999-01-04");
        assertThat(us.response().get("headline").asString()).isEqualTo("한 줄");
        assertThat(us.usage().get("inputTokens").asInt()).isEqualTo(9000);
        assertThat(us.model()).isEqualTo("claude-sonnet-5-5");
        assertThat(us.error()).isNull();
        assertThat(us.createdAt()).isNotNull();
        assertThat(us.sentAt()).isNull();

        BriefingStore.Row kr = store.find("KR", DAY).orElseThrow();
        assertThat(kr.response()).isNull();
        assertThat(kr.usage()).isNull();
        assertThat(kr.error()).isEqualTo("하루 호출 상한");
    }

    @Test
    @DisplayName("보낸 시각은 비어 있을 때만 적는다 — 한 번 적힌 뒤의 두 번째 적기는 바꾸지 않는다. 표가 받지 않는 시장·상태는 막힌다")
    void marksSentOnce() {
        store.insertIfAbsent(row("US", BriefingStore.OK, "글"));
        Instant first = Instant.parse("1999-01-04T21:30:00Z");
        store.markSent("US", DAY, first);
        store.markSent("US", DAY, first.plusSeconds(600));
        assertThat(store.find("US", DAY).orElseThrow().sentAt()).isEqualTo(first);

        assertThatThrownBy(() -> store.insertIfAbsent(row("JP", BriefingStore.OK, "글"))).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> store.insertIfAbsent(row("KR", "DRAFT", "글"))).isInstanceOf(DataIntegrityViolationException.class);
    }
}
