package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.function.Supplier;

/**
 * 보안 공지 알림의 기록({@code security_alerts}, V40 — ADR 0046 결정 7). 백엔드가 쓰는 표입니다(ADR 0008 — 수집기는 읽지도 쓰지도 않음).
 *
 * <p>'해당'이 된 공지 하나에 한 행입니다. 알림함 사건을 만든 때 행을 넣고, 텔레그램을 보낸 뒤에 보낸 시각을 적습니다 — 보내지 못한 행은 보낸 시각이
 * 비어 있어 다음 주기에 다시 보냅니다({@code source_alerts}와 같은 모양). 표에 두어 배포로 백엔드가 다시 떠도 같은 공지를 다시 알리지 않습니다.
 */
@Repository
public class SecurityAlertStore {

    /** 알림 기록 한 행. {@code alertEventId}는 알림함 사건(없으면 null), {@code telegramSentAt}이 null이면 텔레그램을 아직 보내지 못한 것. */
    public record Alert(long nttId, Instant alertedAt, Long alertEventId, Instant telegramSentAt) {
    }

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;
    private final TransactionTemplate transactions;

    public SecurityAlertStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /** 표가 있는가 — 수집기가 아직 V40을 적용하지 않았으면 false. */
    public boolean ready() {
        return schema.tableExists("security_alerts");
    }

    /**
     * 한 트랜잭션으로 — 알림함 사건·배달({@code AlertStore})의 쓰기도 이 스레드의 같은 연결에 합류합니다({@code UserStore.atomically}와 같은 방식).
     * 중간에 예외가 나면 모두 되돌려 다음 주기가 같은 공지로 다시 알립니다.
     */
    public <T> T atomically(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    /** 기록 전부(글 번호순). */
    public List<Alert> all() {
        return jdbc.query("SELECT ntt_id, alerted_at, alert_event_id, telegram_sent_at FROM security_alerts ORDER BY ntt_id",
                (rs, rowNum) -> {
                    long event = rs.getLong("alert_event_id");
                    Long eventId = rs.wasNull() ? null : event;
                    Timestamp sent = rs.getTimestamp("telegram_sent_at");
                    return new Alert(rs.getLong("ntt_id"), rs.getTimestamp("alerted_at").toInstant(), eventId,
                            sent == null ? null : sent.toInstant());
                });
    }

    /** 알렸다고 적습니다. 이미 있으면 그대로. @return 새로 넣었으면 true */
    public boolean insert(long nttId, Instant at, Long alertEventId) {
        return jdbc.update("INSERT INTO security_alerts (ntt_id, alerted_at, alert_event_id) VALUES (?, ?, ?) ON CONFLICT (ntt_id) DO NOTHING",
                nttId, Timestamp.from(at), alertEventId) == 1;
    }

    /** 텔레그램을 보냈다고 적습니다(아직 비어 있는 행만). @return 고친 행 수 */
    public int telegramSent(Collection<Long> nttIds, Instant at) {
        int changed = 0;
        for (Long id : nttIds) {
            changed += jdbc.update("UPDATE security_alerts SET telegram_sent_at = ? WHERE ntt_id = ? AND telegram_sent_at IS NULL",
                    Timestamp.from(at), id);
        }
        return changed;
    }
}
