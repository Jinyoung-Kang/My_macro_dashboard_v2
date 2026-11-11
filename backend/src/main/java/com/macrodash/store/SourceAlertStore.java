package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

/**
 * 수집 출처 끊김 알림의 기록({@code source_alerts}, V34 — ADR 0035 결정 7). 백엔드가 쓰는 표입니다(ADR 0008 — 수집기는 모름).
 *
 * <p>끊김 사건 하나에 한 행이고 키는 '태스크|종류'입니다. 표에 두어 배포로 백엔드가 다시 떠도 '이미 알린 것'과 '보내지 못한 것'이 이어집니다.
 */
@Repository
public class SourceAlertStore {

    /** 열린(아직 풀리지 않은) 사건. {@code notifiedAt}이 null이면 텔레그램을 아직 보내지 못한 것입니다. */
    public record Open(String key, String task, String kind, String reason, Instant openedAt, Instant notifiedAt) {
    }

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public SourceAlertStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    /** 표가 있는가. 수집기가 아직 V34를 적용하지 않았으면 false입니다. */
    public boolean ready() {
        return schema.tableExists("source_alerts");
    }

    /** 열린 사건(키 이름순). */
    public List<Open> open() {
        return jdbc.query("SELECT alert_key, task, kind, reason, opened_at, notified_at FROM source_alerts "
                        + "WHERE recovered_at IS NULL ORDER BY alert_key",
                (rs, rowNum) -> {
                    Timestamp notified = rs.getTimestamp("notified_at");
                    return new Open(rs.getString("alert_key"), rs.getString("task"), rs.getString("kind"), rs.getString("reason"),
                            rs.getTimestamp("opened_at").toInstant(), notified == null ? null : notified.toInstant());
                });
    }

    /** 사건을 엽니다 — 같은 키의 풀린 옛 행은 지우고 새로 넣습니다(열린 행이 있으면 그대로). */
    public void open(String key, String task, String kind, String reason, Instant at) {
        jdbc.update("DELETE FROM source_alerts WHERE alert_key = ? AND recovered_at IS NOT NULL", key);
        jdbc.update("INSERT INTO source_alerts (alert_key, task, kind, reason, opened_at) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (alert_key) DO NOTHING", key, task, kind, reason, Timestamp.from(at));
    }

    /** 텔레그램을 보냈다고 적습니다. */
    public void notified(String key, Instant at) {
        jdbc.update("UPDATE source_alerts SET notified_at = ? WHERE alert_key = ? AND recovered_at IS NULL", Timestamp.from(at), key);
    }

    /** 사건이 풀렸다고 적습니다. */
    public void recovered(String key, Instant at) {
        jdbc.update("UPDATE source_alerts SET recovered_at = ? WHERE alert_key = ? AND recovered_at IS NULL", Timestamp.from(at), key);
    }
}
