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

    /**
     * 호스트 한 줄의 상태(정보 수집 화면의 '메커니즘').
     *
     * @param budgetDay  하루 예산을 센 KST 날짜(오늘이 아니면 오늘 쓴 양은 0)
     */
    public record HostState(String host, String lastGoodTier, int failLevel, Instant blockedUntil, String blockedReason,
                            boolean givenUp, java.time.LocalDate budgetDay, int budgetUsed) {
    }

    /** 모든 호스트의 상태(호스트 이름순). */
    public List<HostState> hosts() {
        return jdbc.query("SELECT host, last_good_tier, fail_level, blocked_until, blocked_reason, given_up, budget_day, budget_used "
                        + "FROM fetch_hosts ORDER BY host",
                (rs, rowNum) -> {
                    Timestamp until = rs.getTimestamp("blocked_until");
                    java.sql.Date day = rs.getDate("budget_day");
                    return new HostState(rs.getString("host"), rs.getString("last_good_tier"), rs.getInt("fail_level"),
                            until == null ? null : until.toInstant(), rs.getString("blocked_reason"), rs.getBoolean("given_up"),
                            day == null ? null : day.toLocalDate(), rs.getInt("budget_used"));
                });
    }

    /** polite 태스크마다 다음 실행 시각. */
    public java.util.Map<String, Instant> schedule() {
        java.util.Map<String, Instant> out = new java.util.LinkedHashMap<>();
        jdbc.query("SELECT task, next_due_at FROM fetch_schedule ORDER BY next_due_at", rs -> {
            out.put(rs.getString("task"), rs.getTimestamp("next_due_at").toInstant());
        });
        return out;
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
