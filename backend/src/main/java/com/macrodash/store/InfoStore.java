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

    /**
     * 최근 글부터(작성 시각, 모르면 처음 받은 시각) — 본문 없이.
     *
     * @param sources 이 출처들만(비면 전부)
     * @param query   제목·한국어 제목·요약에 이 글자가 있는 것만(비면 전부, 대소문자 무시)
     * @param before  이 시각보다 앞선 것만(다음 쪽 — null이면 처음부터)
     */
    public List<Item> items(List<String> sources, String query, Instant before, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + LIST_COLUMNS + ", NULL AS body FROM info_items WHERE TRUE");
        List<Object> args = new ArrayList<>();
        if (sources != null && !sources.isEmpty()) {
            sql.append(" AND source = ANY(?)");
            args.add(sources.toArray(new String[0]));
        }
        if (query != null && !query.isBlank()) {
            sql.append(" AND (title ILIKE ? OR title_ko ILIKE ? OR summary ILIKE ?)");
            String like = "%" + query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
            args.add(like);
            args.add(like);
            args.add(like);
        }
        if (before != null) {
            sql.append(" AND COALESCE(published_at, first_seen_at) < ?");
            args.add(Timestamp.from(before));
        }
        sql.append(" ORDER BY COALESCE(published_at, first_seen_at) DESC, id LIMIT ?");
        args.add(limit);
        return jdbc.query(con -> {
            var ps = con.prepareStatement(sql.toString());
            for (int i = 0; i < args.size(); i++) {
                Object arg = args.get(i);
                if (arg instanceof String[] array) {
                    ps.setArray(i + 1, con.createArrayOf("text", array));
                } else {
                    ps.setObject(i + 1, arg);
                }
            }
            return ps;
        }, itemMapper());
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
