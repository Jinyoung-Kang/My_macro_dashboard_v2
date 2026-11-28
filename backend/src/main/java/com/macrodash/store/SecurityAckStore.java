package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 보안 공지의 '확인함' 표시({@code security_acks}, V47 — ADR 0046 덧붙임 2026-11-28). 백엔드가 쓰는 표입니다(ADR 0008 — 수집기는 읽지도 쓰지도 않음).
 *
 * <p>운영자가 '확인 필요' 공지를 손으로 확인했다고 적은 기록입니다. 공지 하나에 한 행이고, 확인할 때의 판정·사유를 함께 둡니다 — 판정은 읽을 때
 * 계산하는 값이라 이 표가 판정을 바꾸지 않고, 지금 판정·사유가 그때와 다르면 서비스가 그 확인을 무효로 봅니다(행은 그대로 둠). 메모에는 서버의
 * 실제 버전이 적힐 수 있어 로그에 싣지 않습니다.
 */
@Repository
public class SecurityAckStore {

    /**
     * 확인 기록 한 행.
     *
     * @param note    선택 메모(없으면 null)
     * @param verdict 확인할 때의 판정 코드
     * @param reasons 확인할 때의 사유 코드를 글자순으로 쉼표로 이은 글(없으면 빈 글)
     */
    public record Ack(long nttId, Instant ackedAt, String note, String verdict, String reasons) {
    }

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public SecurityAckStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    /** 표가 있는가 — 수집기가 아직 V47을 적용하지 않았으면 false(그동안 확인 표시는 없는 것으로 봄). */
    public boolean ready() {
        return schema.tableExists("security_acks");
    }

    /** 기록 전부(글 번호 → 기록). 표가 없으면 빈 맵. */
    public Map<Long, Ack> all() {
        Map<Long, Ack> out = new LinkedHashMap<>();
        if (!ready()) {
            return out;
        }
        jdbc.query("SELECT ntt_id, acked_at, note, verdict, reasons FROM security_acks ORDER BY ntt_id", rs -> {
            Ack ack = new Ack(rs.getLong("ntt_id"), rs.getTimestamp("acked_at").toInstant(), rs.getString("note"),
                    rs.getString("verdict"), rs.getString("reasons"));
            out.put(ack.nttId(), ack);
        });
        return out;
    }

    /** 한 공지의 기록. 표가 없으면 비어 있음. */
    public Optional<Ack> find(long nttId) {
        return Optional.ofNullable(all().get(nttId));
    }

    /** 확인했다고 적습니다 — 이미 있으면 시각·메모·판정·사유를 새 값으로 바꿉니다(판정이 바뀐 뒤 다시 확인). */
    public void save(Ack ack) {
        jdbc.update("INSERT INTO security_acks (ntt_id, acked_at, note, verdict, reasons) VALUES (?, ?, ?, ?, ?) "
                        + "ON CONFLICT (ntt_id) DO UPDATE SET acked_at = EXCLUDED.acked_at, note = EXCLUDED.note, "
                        + "verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons",
                ack.nttId(), Timestamp.from(ack.ackedAt()), ack.note(), ack.verdict(), ack.reasons());
    }

    /** 확인을 취소합니다. @return 지운 행이 있으면 true */
    public boolean delete(long nttId) {
        return jdbc.update("DELETE FROM security_acks WHERE ntt_id = ?", nttId) > 0;
    }
}
