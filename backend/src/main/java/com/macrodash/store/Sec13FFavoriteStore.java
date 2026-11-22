package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 13F 즐겨찾기 기관(ADR 0048, V43 {@code sec13f_favorites}) — 백엔드가 쓰고 수집기는 읽기만 합니다(ADR 0008). 사용자별이 아니라 하나의 목록이고
 * CIK(10자리)마다 한 줄입니다. 모의 매매·AI 리포트 원문은 이 표를 읽지 않습니다(ArchitectureRulesTest).
 */
@Repository
public class Sec13FFavoriteStore {

    /**
     * 즐겨찾기 한 줄.
     *
     * @param secName     SEC 등록 이름(더할 때 submissions로 확인)
     * @param displayName 표시 이름(없으면 null — 화면은 SEC 이름)
     * @param description 설명(없으면 null)
     */
    public record Favorite(String cik, String secName, String displayName, String description, Instant createdAt) {

        /** 화면에 보일 이름 — 표시 이름, 없으면 SEC 등록 이름. */
        public String name() {
            return displayName != null && !displayName.isBlank() ? displayName : secName;
        }
    }

    private static final String COLUMNS = "cik, sec_name, display_name, description, created_at";

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public Sec13FFavoriteStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    public boolean ready() {
        return schema.tableExists("sec13f_favorites");
    }

    /** 전부(더한 차례). */
    public List<Favorite> all() {
        return jdbc.query("SELECT " + COLUMNS + " FROM sec13f_favorites ORDER BY created_at, cik", mapper());
    }

    public Optional<Favorite> find(String cik) {
        return jdbc.query("SELECT " + COLUMNS + " FROM sec13f_favorites WHERE cik = ?", mapper(), cik).stream().findFirst();
    }

    public int count() {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM sec13f_favorites", Integer.class);
        return count == null ? 0 : count;
    }

    /** 넣기 — 같은 CIK가 이미 있으면 넣지 않고 빈 값. */
    public Optional<Favorite> insert(String cik, String secName, String displayName, String description, Long userId) {
        return jdbc.query("INSERT INTO sec13f_favorites (cik, sec_name, display_name, description, created_by) VALUES (?, ?, ?, ?, ?) "
                        + "ON CONFLICT (cik) DO NOTHING RETURNING " + COLUMNS,
                mapper(), cik, secName, displayName, description, userId).stream().findFirst();
    }

    /** 지우기 — 지운 줄 수. */
    public int delete(String cik) {
        return jdbc.update("DELETE FROM sec13f_favorites WHERE cik = ?", cik);
    }

    private static RowMapper<Favorite> mapper() {
        return (rs, rowNum) -> new Favorite(rs.getString("cik"), rs.getString("sec_name"), rs.getString("display_name"),
                rs.getString("description"), UserStore.instant(rs.getTimestamp("created_at")));
    }
}
