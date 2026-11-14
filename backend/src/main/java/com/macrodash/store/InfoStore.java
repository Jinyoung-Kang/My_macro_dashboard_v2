package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 정보 수집(ADR 0035)의 글({@code info_items})과 출처 판정({@code fetch_source_state}) 읽기 — 수집기가 쓰는 표라 백엔드는 <b>읽기만</b> 합니다
 * (ADR 0008). 쓰는 메서드를 두지 않습니다.
 */
@Repository
public class InfoStore {

    /** 목록 한 줄 — 본문은 싣지 않습니다(펼칠 때 {@link #item}). */
    public record Item(String id, String source, String kind, String url, String title, String titleKo, String author,
                       Instant publishedAt, Instant firstSeenAt, String summary, String bodyStatus, String fetchTier,
                       JsonNode meta, String body) {
    }

    /**
     * 출처 하나의 마지막 판정.
     *
     * @param status            ok·blocked·format·failed
     * @param streak            같은 판정이 이어진 횟수
     * @param staleAfterMinutes 이만큼 성공이 없으면 '오래 못 받음'
     */
    public record SourceState(String task, String status, int streak, String reason, Instant lastOkAt, Instant lastRunAt,
                              int staleAfterMinutes, Instant createdAt) {
    }

    /** 출처별 글 수와 가장 최근 글 시각. */
    public record SourceCount(String source, int items, Instant latest) {
    }

    private static final String LIST_COLUMNS = "id, source, kind, url, title, title_ko, author, published_at, first_seen_at, "
            + "summary, body_status, fetch_tier, meta";

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;
    private final ObjectMapper mapper;

    public InfoStore(JdbcTemplate jdbc, SchemaCheck schema, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.schema = schema;
        this.mapper = mapper;
    }

    /** 표가 있는가. 수집기가 아직 V33을 적용하지 않았으면 false입니다. */
    public boolean ready() {
        return schema.tableExists("info_items") && schema.tableExists("fetch_source_state");
    }

    /** 쪽 하나와 전체 수. */
    public record Page<T>(List<T> rows, int total) {
    }

    /** 사건 뉴스 RSS 제목 한 줄(관측치 news_headline·kr_news_headline). {@code summary}는 피드가 준 요약(없으면 null — ADR 0037). */
    public record Headline(String dataset, String title, String link, String source, String feed, Instant publishedAt,
                           String fetchedAt, String summary) {
    }

    /**
     * 최근 글부터(작성 시각, 모르면 처음 받은 시각) — 본문 없이, 쪽으로.
     *
     * @param sources 이 출처들만(비면 전부)
     * @param query   제목·한국어 제목·요약에 이 글자가 있는 것만(비면 전부, 대소문자 무시)
     */
    public Page<Item> items(List<String> sources, String query, int offset, int limit) {
        StringBuilder where = new StringBuilder(" WHERE TRUE");
        List<Object> args = new ArrayList<>();
        if (sources != null && !sources.isEmpty()) {
            where.append(" AND source = ANY(?)");
            args.add(sources.toArray(new String[0]));
        }
        if (query != null && !query.isBlank()) {
            where.append(" AND (title ILIKE ? OR title_ko ILIKE ? OR summary ILIKE ?)");
            String like = like(query);
            args.add(like);
            args.add(like);
            args.add(like);
        }
        Integer total = jdbc.query(con -> bind(con.prepareStatement("SELECT COUNT(*) FROM info_items" + where), args),
                rs -> rs.next() ? rs.getInt(1) : 0);
        List<Object> page = new ArrayList<>(args);
        page.add(limit);
        page.add(offset);
        List<Item> rows = jdbc.query(con -> bind(con.prepareStatement("SELECT " + LIST_COLUMNS + ", NULL AS body FROM info_items" + where
                + " ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT ? OFFSET ?"), page), itemMapper());
        return new Page<>(rows, total == null ? 0 : total);
    }

    /**
     * Claude 결정 패킷의 '수집 글' 섹션 재료(ADR 0036 결정 7 — 2026-11-12 개정, QA-400) — 이 출처들의 글 가운데 <b>처음 받은 시각</b>
     * ({@code first_seen_at} — 수집기가 행을 처음 넣은 순간, 그 뒤 바뀌지 않음)이 (from, to]인 것을, 본문 없이(요약만).
     *
     * <ul>
     *   <li>창을 작성 시각이 아니라 받은 시각으로 봅니다 — 결정 뒤에 처음 받은 글(작성은 결정 전)이 다음 결정의 창에 듭니다. 결정 창들이 겹치지 않고
     *       이어지면 글마다 한 창에만 듭니다.</li>
     *   <li>작성 시각(모르면 받은 시각으로 봄)이 {@code to}보다 뒤인 글과, 받을 때 이미 작성 뒤 {@code maxAge}가 넘은 글(처음 수집하는 피드에 남아 있던
     *       묵은 글)은 뺍니다.</li>
     *   <li>출처마다 상위 {@code perGroup}편만 — 본문을 다 받은 글 먼저, 그 안에서 작성 시각 최근 순. 글이 많은 출처 하나가 후보를 다 채워 다른 출처가
     *       빠지지 않게 SQL에서 자릅니다. 분류({@code meta.category})에 {@code categoryMarks}의 글자가 든 글과 아닌 글은 한 출처 안에서 따로 셉니다
     *       (부르는 쪽이 분류로 한쪽만 고르므로 — 국내·해외 시장 글이 서로를 밀어내지 않게).</li>
     * </ul>
     * 돌려주는 순서는 본문을 다 받은 글 먼저, 작성 시각 최근 순, id 순입니다.
     */
    public List<Item> recentForPacket(List<String> sources, Instant from, Instant to, Duration maxAge, int perGroup,
                                      List<String> categoryMarks) {
        if (sources == null || sources.isEmpty() || perGroup <= 0) {
            return List.of();
        }
        String[] marks = (categoryMarks == null ? List.<String>of() : categoryMarks).stream().map(InfoStore::like)
                .toArray(String[]::new);
        String written = "COALESCE(published_at, first_seen_at)";
        String order = "(body_status = 'full') DESC, " + written + " DESC, id";
        List<Object> args = List.of(marks, sources.toArray(new String[0]), Timestamp.from(from), Timestamp.from(to),
                Timestamp.from(to), maxAge.toSeconds(), perGroup);
        return jdbc.query(con -> bind(con.prepareStatement("SELECT " + LIST_COLUMNS + ", NULL AS body FROM ("
                + "SELECT " + LIST_COLUMNS + ", ROW_NUMBER() OVER (PARTITION BY source, "
                + "COALESCE(meta->>'category' LIKE ANY(?), FALSE) ORDER BY " + order + ") AS rank_in_group "
                + "FROM info_items WHERE source = ANY(?) AND first_seen_at > ? AND first_seen_at <= ? "
                + "AND " + written + " <= ? AND " + written + " >= first_seen_at - (? * INTERVAL '1 second')"
                + ") ranked WHERE rank_in_group <= ? ORDER BY " + order), args), itemMapper());
    }

    /**
     * 사건 뉴스 RSS 제목(수집기 news_headlines·kr_news_headlines의 관측치)을 최근부터, 쪽으로.
     *
     * @param datasets news_headline·kr_news_headline 가운데
     * @param feed     피드 키 하나(비면 전부)
     */
    public Page<Headline> headlines(List<String> datasets, String feed, String query, int offset, int limit) {
        StringBuilder where = new StringBuilder(" WHERE dataset = ANY(?)");
        List<Object> args = new ArrayList<>();
        args.add(datasets.toArray(new String[0]));
        if (feed != null && !feed.isBlank()) {
            where.append(" AND (payload->>'feed' = ? OR jsonb_exists(COALESCE(payload->'feeds', '[]'::jsonb), ?))");
            args.add(feed.strip());
            args.add(feed.strip());
        }
        if (query != null && !query.isBlank()) {
            where.append(" AND payload->>'title' ILIKE ?");
            args.add(like(query));
        }
        // 작성 시각이 없는 줄(새 피드 묶음의 Nikkei Asia 등)은 처음 받은 시각, 그것도 없으면 행의 갱신 시각 — 셋 다 같은 UTC ISO 모양
        // (YYYY-MM-DDTHH:MM:SS+00:00)이라야 글자 비교가 시간 순서와 같습니다(updated_at::text는 'T' 대신 공백이라 같은 날 줄 뒤로 밀림).
        String order = " ORDER BY COALESCE(NULLIF(payload->>'publishedAt', ''), NULLIF(payload->>'fetchedAt', ''), "
                + "to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"+00:00\"')) DESC, entity";
        Integer total = jdbc.query(con -> bind(con.prepareStatement("SELECT COUNT(*) FROM observations" + where), args),
                rs -> rs.next() ? rs.getInt(1) : 0);
        List<Object> page = new ArrayList<>(args);
        page.add(limit);
        page.add(offset);
        List<Headline> rows = jdbc.query(con -> bind(con.prepareStatement("SELECT dataset, payload FROM observations" + where + order
                + " LIMIT ? OFFSET ?"), page), (rs, rowNum) -> {
                    JsonNode payload = json(rs.getString("payload"));
                    Instant published = null;
                    String text = payload.path("publishedAt").asText("");
                    if (!text.isBlank()) {
                        try {
                            published = java.time.OffsetDateTime.parse(text).toInstant();
                        } catch (java.time.format.DateTimeParseException e) {
                            published = null;
                        }
                    }
                    // 정보 검색의 새 피드 묶음(search_feed_headline, ADR 0041)은 링크·매체를 url·publisher 칸에 둡니다(사건 뉴스는 link·source).
                    return new Headline(rs.getString("dataset"), payload.path("title").asText(null), either(payload, "link", "url"),
                            either(payload, "source", "publisher"), payload.path("feed").asText(null), published,
                            payload.path("fetchedAt").asText(null), payload.path("summary").asText(null));
                });
        return new Page<>(rows, total == null ? 0 : total);
    }

    /** 첫 칸의 글, 없으면 둘째 칸의 글(둘 다 없으면 null). */
    private static String either(JsonNode payload, String field, String fallback) {
        String value = payload.path(field).asText(null);
        return value != null ? value : payload.path(fallback).asText(null);
    }

    private static String like(String query) {
        return "%" + query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    private static java.sql.PreparedStatement bind(java.sql.PreparedStatement ps, List<Object> args) throws SQLException {
        for (int i = 0; i < args.size(); i++) {
            Object arg = args.get(i);
            if (arg instanceof String[] array) {
                ps.setArray(i + 1, ps.getConnection().createArrayOf("text", array));
            } else {
                ps.setObject(i + 1, arg);
            }
        }
        return ps;
    }

    /** 글 한 편(본문 포함). */
    public Optional<Item> item(String id) {
        List<Item> rows = jdbc.query("SELECT " + LIST_COLUMNS + ", body FROM info_items WHERE id = ?", itemMapper(), id);
        return rows.stream().findFirst();
    }

    /** 출처별 글 수와 가장 최근 글 시각. */
    public List<SourceCount> counts() {
        return jdbc.query("SELECT source, COUNT(*) AS n, MAX(COALESCE(published_at, first_seen_at)) AS latest "
                        + "FROM info_items GROUP BY source ORDER BY source",
                (rs, rowNum) -> new SourceCount(rs.getString("source"), rs.getInt("n"), instant(rs, "latest")));
    }

    /** polite 태스크마다의 마지막 판정(태스크 이름순). */
    public List<SourceState> states() {
        return jdbc.query("SELECT task, status, streak, reason, last_ok_at, last_run_at, stale_after_minutes, created_at "
                        + "FROM fetch_source_state ORDER BY task",
                (rs, rowNum) -> new SourceState(rs.getString("task"), rs.getString("status"), rs.getInt("streak"),
                        rs.getString("reason"), instant(rs, "last_ok_at"), instant(rs, "last_run_at"),
                        rs.getInt("stale_after_minutes"), instant(rs, "created_at")));
    }

    private RowMapper<Item> itemMapper() {
        return (rs, rowNum) -> new Item(rs.getString("id"), rs.getString("source"), rs.getString("kind"), rs.getString("url"),
                rs.getString("title"), rs.getString("title_ko"), rs.getString("author"), instant(rs, "published_at"),
                instant(rs, "first_seen_at"), rs.getString("summary"), rs.getString("body_status"), rs.getString("fetch_tier"),
                json(rs.getString("meta")), rs.getString("body"));
    }

    private JsonNode json(String text) {
        if (text == null) {
            return mapper.createObjectNode();
        }
        try {
            return mapper.readTree(text);
        } catch (RuntimeException e) {
            return mapper.createObjectNode();
        }
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }
}
