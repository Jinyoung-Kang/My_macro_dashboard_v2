package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

/**
 * 알림 규칙·사건·알림함({@code alert_rules}·{@code alert_events}·{@code alert_deliveries}) — 백엔드가 쓰는 테이블
 * (ADR 0008·0011). 사건 키와 (사건, 사용자, 채널)이 유일해서, 같은 데이터를 몇 번 평가해도 결과는 한 번입니다.
 */
@Repository
public class AlertStore {

    public record Rule(long id, long userId, String kind, JsonNode params, boolean enabled, Instant createdAt) {
    }

    public record Event(long id, String kind, String eventKey, LocalDate occurredOn, String title, String body) {
    }

    /**
     * 알림함 한 줄. {@code href}는 사건 {@code payload.href}(누르면 갈 화면 안 주소 — 정보 검색 관심 대상 알림 {@code SEARCH_WATCH}, 계약 §9-5), 없거나 화면 안
     * 주소가 아니면 null({@link #inAppHref}).
     * 화면에는 {@code payload: {href}}(없으면 null)로 냅니다(docs/API.md 알림함).
     */
    public record InboxItem(long id, String kind, LocalDate occurredOn, String title, String body, boolean late,
                            Instant createdAt, Instant readAt, String href) {
    }

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;

    public AlertStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
    }

    public boolean ready() {
        return schema.tableExists("alert_deliveries");
    }

    // ------------------------------------------------------------------ 규칙
    public List<Rule> rules(long userId) {
        return jdbc.query("SELECT id, user_id, kind, params::text AS params, enabled, created_at FROM alert_rules "
                + "WHERE user_id = ? ORDER BY id", ruleMapper(), userId);
    }

    /**
     * 정기 평가가 읽는 켜진 규칙. 국면 전환 밖의 종류는 지금 유료 기능을 쓸 수 있는 사용자(운영자 또는 PRO)의 것만 돌려줍니다 —
     * 이 조건은 {@code CurrentUser.isPro()}와 같은 규칙이라, 한쪽을 바꾸면 다른 쪽도 함께 바꿉니다.
     *
     * <p>무료로 저장할 때 규칙을 끄지만({@link #disablePaidRules}), 그 처리가 생기기 전에 이미 내려간 회원이나 내리기와 겹친
     * 켜기 요청으로 켜진 채 남은 규칙이 있을 수 있습니다. 그런 규칙이 무료 회원에게 유료 알림을 계속 넣지 않도록 읽을 때
     * 등급으로 한 번 더 거릅니다(QA-115). 규칙 자체는 건드리지 않습니다.
     */
    public List<Rule> enabledRules(String kind) {
        return jdbc.query("SELECT r.id, r.user_id, r.kind, r.params::text AS params, r.enabled, r.created_at "
                + "FROM alert_rules r JOIN users u ON u.id = r.user_id "
                + "WHERE r.kind = ? AND r.enabled "
                + "AND (r.kind = 'REGIME_CHANGE' OR u.role = 'OWNER' OR u.tier = 'PRO') ORDER BY r.id", ruleMapper(), kind);
    }

    public int countRules(long userId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM alert_rules WHERE user_id = ?", Integer.class, userId);
        return count == null ? 0 : count;
    }

    /** 종목 대상 연속 순매수 규칙의 서로 다른 종목 수(전체 또는 한 사용자). 종목별 수급 수집 범위의 상한을 지킵니다. */
    public int countStockCodes(Long userId) {
        String sql = "SELECT COUNT(DISTINCT params->>'code') FROM alert_rules "
                + "WHERE kind = 'FOREIGN_STREAK' AND params->>'target' = 'STOCK' AND enabled"
                + (userId == null ? "" : " AND user_id = ?");
        Integer count = userId == null ? jdbc.queryForObject(sql, Integer.class)
                : jdbc.queryForObject(sql, Integer.class, userId);
        return count == null ? 0 : count;
    }

    public boolean hasStockCode(String code) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM alert_rules WHERE kind = 'FOREIGN_STREAK' "
                + "AND params->>'target' = 'STOCK' AND params->>'code' = ? AND enabled", Integer.class, code);
        return count != null && count > 0;
    }

    public long insertRule(long userId, String kind, JsonNode params) {
        Long id = jdbc.queryForObject("INSERT INTO alert_rules (user_id, kind, params) VALUES (?, ?, ?::jsonb) RETURNING id",
                Long.class, userId, kind, mapper.writeValueAsString(params));
        if (id == null) {
            throw new IllegalStateException("규칙 번호를 받지 못했습니다");
        }
        return id;
    }

    public int setEnabled(long ruleId, long userId, boolean enabled) {
        return jdbc.update("UPDATE alert_rules SET enabled = ? WHERE id = ? AND user_id = ?", enabled, ruleId, userId);
    }

    /**
     * 한 사용자의 유료 종류(국면 전환 밖) 규칙을 모두 끕니다 — 등급을 무료로 저장할 때(QA-091·QA-115). 수집기(관심 종목
     * 수집 범위)는 {@code enabled}만 보므로 꺼야 따라옵니다(정기 평가는 {@link #enabledRules}가 등급으로도 거름). 지우지
     * 않고 끄기만 해서, 다시 유료가 되면 회원이 켤 수 있습니다.
     *
     * @return 이번에 끈 규칙 수(이미 꺼져 있던 것은 세지 않음)
     */
    public int disablePaidRules(long userId) {
        return jdbc.update("UPDATE alert_rules SET enabled = false "
                + "WHERE user_id = ? AND kind <> 'REGIME_CHANGE' AND enabled", userId);
    }

    public int deleteRule(long ruleId, long userId) {
        return jdbc.update("DELETE FROM alert_rules WHERE id = ? AND user_id = ?", ruleId, userId);
    }

    // ------------------------------------------------------------------ 사건
    /** 사건을 넣습니다. 같은 키가 이미 있으면 넣지 않고 비어 있음. */
    public Optional<Long> insertEvent(String kind, String eventKey, LocalDate occurredOn, String title, String body,
                                      JsonNode payload) {
        return jdbc.query("INSERT INTO alert_events (kind, event_key, occurred_on, title, body, payload) "
                        + "VALUES (?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING id",
                (rs, rowNum) -> rs.getLong("id"), kind, eventKey, Date.valueOf(occurredOn), title, body,
                mapper.writeValueAsString(payload)).stream().findFirst();
    }

    /** 최근에 만든 사건 — 정기 평가가 규칙과 다시 맞춰 봅니다(규칙을 나중에 만든 경우). */
    public List<Event> recentEvents(String kind, int days) {
        return jdbc.query("SELECT id, kind, event_key, occurred_on, title, body FROM alert_events "
                        + "WHERE kind = ? AND created_at > now() - make_interval(days => ?) ORDER BY id",
                (rs, rowNum) -> new Event(rs.getLong("id"), rs.getString("kind"), rs.getString("event_key"),
                        rs.getDate("occurred_on").toLocalDate(), rs.getString("title"), rs.getString("body")),
                kind, days);
    }

    /** 알림함에 넣습니다. 이미 있으면 그대로(유일 제약). @return 새로 넣었으면 true */
    public boolean deliver(long eventId, long userId, long ruleId, boolean late) {
        return jdbc.update("INSERT INTO alert_deliveries (event_id, user_id, rule_id, channel, late) "
                + "VALUES (?, ?, ?, 'inbox', ?) ON CONFLICT (event_id, user_id, channel) DO NOTHING",
                eventId, userId, ruleId, late) == 1;
    }

    /**
     * 규칙 없이 한 사용자의 알림함에 넣습니다({@code rule_id} NULL, 지난 사건 아님 — 읽지 않은 수에 셈). 규칙 표가 아닌 곳에서 켜는 알림(정보 검색 관심 대상의
     * {@code notify}, 계약 §9-5)용입니다. 이미 있으면 그대로(유일 제약). @return 새로 넣었으면 true
     */
    public boolean deliverInbox(long eventId, long userId) {
        return jdbc.update("INSERT INTO alert_deliveries (event_id, user_id, rule_id, channel, late) "
                + "VALUES (?, ?, NULL, 'inbox', false) ON CONFLICT (event_id, user_id, channel) DO NOTHING",
                eventId, userId) == 1;
    }

    // ------------------------------------------------------------------ 알림함
    public List<InboxItem> inbox(long userId, int limit) {
        return jdbc.query("SELECT d.id, e.kind, e.occurred_on, e.title, e.body, d.late, d.created_at, d.read_at, e.payload->>'href' AS href "
                        + "FROM alert_deliveries d JOIN alert_events e ON e.id = d.event_id "
                        + "WHERE d.user_id = ? ORDER BY d.created_at DESC, d.id DESC LIMIT ?",
                (rs, rowNum) -> new InboxItem(rs.getLong("id"), rs.getString("kind"),
                        rs.getDate("occurred_on").toLocalDate(), rs.getString("title"), rs.getString("body"),
                        rs.getBoolean("late"), UserStore.instant(rs.getTimestamp("created_at")),
                        UserStore.instant(rs.getTimestamp("read_at")), inAppHref(rs.getString("href"))),
                userId, limit);
    }

    /**
     * 사건 {@code payload.href} 가운데 이 화면 안의 주소만 — '/'로 시작하고 '//'(다른 호스트)·역슬래시·제어 글자가 없을 때 그대로, 아니면 null. 사건은 백엔드만
     * 쓰지만 화면이 이 값으로 이동하므로 한 번 더 거릅니다.
     */
    static String inAppHref(String href) {
        if (href == null || !href.startsWith("/") || href.startsWith("//") || href.indexOf('\\') >= 0
                || href.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) {
            return null;
        }
        return href;
    }

    public int unreadCount(long userId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM alert_deliveries "
                + "WHERE user_id = ? AND read_at IS NULL AND NOT late", Integer.class, userId);
        return count == null ? 0 : count;
    }

    public int markRead(long userId, List<Long> ids) {
        if (ids == null) {
            return jdbc.update("UPDATE alert_deliveries SET read_at = now() WHERE user_id = ? AND read_at IS NULL", userId);
        }
        Long[] wanted = ids.stream().filter(java.util.Objects::nonNull).toArray(Long[]::new);
        if (wanted.length == 0) {
            return 0;
        }
        // 한 문장으로(건마다 UPDATE하면 요청 하나가 연결을 쥔 채 수천 번 왕복합니다 — QA-020).
        return jdbc.update(connection -> {
            java.sql.PreparedStatement statement = connection.prepareStatement("UPDATE alert_deliveries "
                    + "SET read_at = now() WHERE user_id = ? AND id = ANY(?) AND read_at IS NULL");
            statement.setLong(1, userId);
            statement.setArray(2, connection.createArrayOf("bigint", wanted));
            return statement;
        });
    }

    /**
     * 배달이 하나도 남지 않은 {@code kind} 사건을 지웁니다. 한 사람에게만 가는 사건(정보 검색 관심 대상 {@code SEARCH_WATCH} — 제목에 관심 대상 이름, 본문에 글
     * 제목, 계약 §9-5)이 알림함 정리({@link #purgeDeliveries})·탈퇴(배달은 사용자를 따라 지워짐) 뒤에 전역 표에 남지 않게 합니다. 사건 키에 실행 시각이 들어
     * 있어 중복 판정에 다시 쓰이지 않습니다. 규칙 종류의 전역 사실 사건(국면 전환 등 — 중복 판정 키이자 기록)에는 쓰지 않습니다. @return 지운 사건 수
     */
    public int purgeUndeliveredEvents(String kind) {
        return jdbc.update("DELETE FROM alert_events e WHERE e.kind = ? "
                + "AND NOT EXISTS (SELECT 1 FROM alert_deliveries d WHERE d.event_id = e.id)", kind);
    }

    /** 알림함 항목은 90일 보관합니다. 사건은 지우지 않습니다(중복 판정 키이자 기록). */
    public int purgeDeliveries(int days) {
        return jdbc.update("DELETE FROM alert_deliveries WHERE created_at < now() - make_interval(days => ?)", days);
    }

    private RowMapper<Rule> ruleMapper() {
        return (rs, rowNum) -> new Rule(rs.getLong("id"), rs.getLong("user_id"), rs.getString("kind"),
                mapper.readTree(rs.getString("params")), rs.getBoolean("enabled"),
                UserStore.instant(rs.getTimestamp("created_at")));
    }
}
