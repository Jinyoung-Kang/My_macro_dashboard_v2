package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

/**
 * 차단 통과 수집 계층의 닫힘 상태({@code fetch_hosts}) 읽기 — 수집기가 쓰는 표라 백엔드는 <b>읽기만</b> 합니다(ADR 0008·0026).
 *
 * <p>쓰는 메서드를 두지 않습니다. 닫힘·포기를 푸는 것은 운영자가 그 행을 지우는 일이고(docs/DATA_SOURCES.md '차단 통과 수집 계층'),
 * 그 뒤의 상태는 수집기가 다시 씁니다.
 */
@Repository
public class FetchStateStore {

    /**
     * 닫혀 있는 출처 하나.
     *
     * @param until   닫힘이 풀리는 시각 — 포기면 null
     * @param givenUp 연속 거부로 포기함(운영자가 풀 때까지 다시 시도하지 않음)
     */
    public record Closure(String host, String reason, Instant until, boolean givenUp) {
    }

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public FetchStateStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    /** 표가 있는가. 수집기가 아직 V21을 적용하지 않았으면 false입니다. */
    public boolean ready() {
        return schema.tableExists("fetch_hosts");
    }

    /** {@code now}에 닫혀 있는 출처 — 기한이 남았거나 포기한 것(호스트 이름순). */
    public List<Closure> closed(Instant now) {
        return jdbc.query(
                "SELECT host, blocked_reason, blocked_until, given_up FROM fetch_hosts "
                        + "WHERE given_up OR blocked_until > ? ORDER BY host",
                (rs, rowNum) -> {
                    Timestamp until = rs.getTimestamp("blocked_until");
                    boolean givenUp = rs.getBoolean("given_up");
                    return new Closure(rs.getString("host"), rs.getString("blocked_reason"),
                            givenUp || until == null ? null : until.toInstant(), givenUp);
                },
                Timestamp.from(now));
    }
}
