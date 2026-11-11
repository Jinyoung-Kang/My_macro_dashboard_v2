package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
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

    /** 사건 뉴스 RSS 제목 한 줄(관측치 news_headline·kr_news_headline). */
    public record Headline(String dataset, String title, String link, String source, String feed, Instant publishedAt,
                           String fetchedAt) {
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
     * Claude 결정 패킷의 '수집 글' 섹션 재료(ADR 0036) — 이 출처들의 글 가운데 작성 시각(모르면 처음 받은 시각)이 (from, to]인 것을 최근부터,
     * 본문 없이(요약만). 본문을 다 받은 글을 앞에 둡니다.
     */
    public List<Item> recentForPacket(List<String> sources, Instant from, Instant to, int limit) {
        if (sources == null || sources.isEmpty()) {
            return List.of();
        }
        List<Object> args = List.of(sources.toArray(new String[0]), Timestamp.from(from), Timestamp.from(to), limit);
        return jdbc.query(con -> bind(con.prepareStatement("SELECT " + LIST_COLUMNS + ", NULL AS body FROM info_items "
                + "WHERE source = ANY(?) AND COALESCE(published_at, first_seen_at) > ? AND COALESCE(published_at, first_seen_at) <= ? "
                + "ORDER BY (body_status = 'full') DESC, COALESCE(published_at, first_seen_at) DESC, id LIMIT ?"), args), itemMapper());
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
        String order = " ORDER BY COALESCE(NULLIF(payload->>'publishedAt', ''), updated_at::text) DESC, entity";
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
                    return new Headline(rs.getString("dataset"), payload.path("title").asText(null), payload.path("link").asText(null),
                            payload.path("source").asText(null), payload.path("feed").asText(null), published,
                            payload.path("fetchedAt").asText(null));
                });
        return new Page<>(rows, total == null ? 0 : total);
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
