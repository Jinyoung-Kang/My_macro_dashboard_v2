package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 정보 검색의 매체 제외 목록 중 운영자가 더한 줄(ADR 0041 결정 6, V37 {@code search_media_excludes}) — 백엔드가 쓰고 수집기는 읽기만 합니다(ADR 0008).
 * 처음 값(확실한 중국 국가·당 매체 등)은 수집기 코드 상수이고 여기에는 없습니다. 종류·값(대소문자 무시)마다 한 줄입니다.
 */
@Repository
public class SearchExcludeStore {

    /**
     * 제외 매체 한 줄.
     *
     * @param kind  domain(소문자 호스트 — 점 경계로 대조) 또는 name(매체 이름 — 대소문자 무시 완전 일치)
     * @param note  운영자의 메모(없으면 null)
     */
    public record Exclude(long id, String kind, String value, String note, Instant createdAt) {
    }

    private static final String COLUMNS = "id, kind, value, note, created_at";

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public SearchExcludeStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    public boolean ready() {
        return schema.tableExists("search_media_excludes");
    }

    /** 더한 줄 전부(더한 순서). */
    public List<Exclude> all() {
        return jdbc.query("SELECT " + COLUMNS + " FROM search_media_excludes ORDER BY created_at, id", mapper());
    }

    /** 같은 종류·값(대소문자 무시)의 줄. */
    public Optional<Exclude> find(String kind, String value) {
        return jdbc.query("SELECT " + COLUMNS + " FROM search_media_excludes WHERE kind = ? AND lower(value) = lower(?)", mapper(), kind, value)
                .stream().findFirst();
    }

    /** 넣기 — 같은 종류·값(대소문자 무시)이 이미 있으면 넣지 않고 빈 값. */
    public Optional<Exclude> insert(String kind, String value, String note) {
        return jdbc.query("INSERT INTO search_media_excludes (kind, value, note) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING " + COLUMNS,
                mapper(), kind, value, note).stream().findFirst();
    }

    /** 번호로 지우기 — 지운 줄 수. */
    public int delete(long id) {
        return jdbc.update("DELETE FROM search_media_excludes WHERE id = ?", id);
    }

    private static RowMapper<Exclude> mapper() {
        return (rs, rowNum) -> new Exclude(rs.getLong("id"), rs.getString("kind"), rs.getString("value"), rs.getString("note"),
                UserStore.instant(rs.getTimestamp("created_at")));
    }
}
