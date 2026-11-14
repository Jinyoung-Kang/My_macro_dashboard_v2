package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 정보 검색의 관심 대상(ADR 0041 결정 9, V37) — 백엔드가 쓰는 표 {@code search_watches}(사용자·대표 키마다 한 줄)와, 수집기가 모은 글 표
 * {@code search_watch_items}의 <b>읽기</b>(새 글 수). 글 표는 수집기 소유라 쓰는 메서드를 두지 않습니다(ADR 0008). 수집기는 {@code search_watches}를
 * 읽기만 합니다({@code paper_settings} 선례).
 *
 * <p>관심 대상·모은 글은 모의 매매의 입력이 아닙니다({@code ArchitectureRulesTest} — feature.paper가 이 저장소를 쓰지 않음).
 */
@Repository
public class SearchWatchStore {

    /**
     * 관심 대상 한 줄.
     *
     * @param kind       company·institution·person·topic
     * @param aliases    수집기가 검색식·대조에 쓰는 별칭(대상의 것만)
     * @param ids        대상 풀기의 식별자 객체(없었으면 빈 객체)
     * @param lastSeenAt 화면이 그 대상의 타임라인을 마지막으로 연 시각 — 새 글 수의 기준
     */
    public record Watch(long id, long userId, String entityKey, String kind, String name, List<String> aliases, JsonNode ids,
                       Instant createdAt, Instant lastSeenAt) {
    }

    /** 새 글로 세는 작성 시각의 여유 — 마지막으로 본 때의 이만큼 전부터 나온 글(늦게 잡힌 어제 기사는 셈, 첫 수집의 옛 글은 세지 않음). */
    public static final Duration NEW_ITEM_LOOKBACK = Duration.ofHours(24);
    private static final String COLUMNS = "id, user_id, entity_key, kind, name, aliases::text AS aliases, ids::text AS ids, created_at, last_seen_at";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;

    public SearchWatchStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
    }

    /** 두 표가 다 있는가 — 수집기가 V37을 적용하기 전에는 '준비 중'. */
    public boolean ready() {
        return schema.tableExists("search_watches") && schema.tableExists("search_watch_items");
    }

    /** 내 관심 대상(등록한 순서). */
    public List<Watch> watches(long userId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM search_watches WHERE user_id = ? ORDER BY created_at, id", mapper(), userId);
    }

    public Optional<Watch> find(long userId, String entityKey) {
        return jdbc.query("SELECT " + COLUMNS + " FROM search_watches WHERE user_id = ? AND entity_key = ?", mapper(), userId, entityKey)
                .stream().findFirst();
    }

    public int countForUser(long userId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM search_watches WHERE user_id = ?", Integer.class, userId);
        return count == null ? 0 : count;
    }

    /** 서버 전체의 서로 다른 대표 키 수 — 수집기가 모으는 대상 수(여러 사용자가 같은 대상을 등록해도 한 번). */
    public int countKeys() {
        Integer count = jdbc.queryForObject("SELECT COUNT(DISTINCT entity_key) FROM search_watches", Integer.class);
        return count == null ? 0 : count;
    }

    /** 누구든 그 대표 키를 등록했는가 — 이미 모으는 대상은 서버 상한을 늘리지 않습니다. */
    public boolean watchedByAnyone(String entityKey) {
        Boolean found = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM search_watches WHERE entity_key = ?)", Boolean.class, entityKey);
        return Boolean.TRUE.equals(found);
    }

    /**
     * 한 줄 넣기 — 등록 시각과 마지막으로 본 시각은 {@code at}. 같은 사용자·대표 키가 이미 있으면 넣지 않고 그 줄을 돌려줍니다(처음 이름·별칭 유지).
     * {@code kind}는 비울 수 없고(표의 CHECK — company·institution·person·topic), 식별자가 없으면 빈 객체로 둡니다.
     */
    public Watch insert(long userId, String entityKey, String kind, String name, List<String> aliases, JsonNode ids, Instant at) {
        Timestamp stamp = Timestamp.from(at);
        jdbc.update("INSERT INTO search_watches (user_id, entity_key, kind, name, aliases, ids, created_at, last_seen_at) "
                        + "VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?) ON CONFLICT DO NOTHING",
                userId, entityKey, kind, name, mapper.writeValueAsString(aliases == null ? List.of() : aliases),
                ids == null || ids.isNull() ? "{}" : mapper.writeValueAsString(ids), stamp, stamp);
        return find(userId, entityKey).orElseThrow(() -> new IllegalStateException("관심 대상 줄을 읽지 못했습니다"));
    }

    /** 내 줄 하나 지우기 — 지운 줄 수(남의 줄·없는 줄은 0). */
    public int delete(long id, long userId) {
        return jdbc.update("DELETE FROM search_watches WHERE id = ? AND user_id = ?", id, userId);
    }

    /** 내 줄의 '마지막으로 본 시각'을 {@code at}으로 — 바꾼 시각(남의 줄·없는 줄은 빈 값). */
    public Optional<Instant> markSeen(long id, long userId, Instant at) {
        int changed = jdbc.update("UPDATE search_watches SET last_seen_at = ? WHERE id = ? AND user_id = ?", Timestamp.from(at), id, userId);
        return changed == 1 ? Optional.of(at) : Optional.empty();
    }

    /**
     * 내 관심 대상마다 새 글 수 — 수집기 글 표({@code search_watch_items})에서 그 대표 키의 글 가운데 마지막으로 본 뒤(없으면 등록 뒤) 처음 받았고,
     * 작성 시각(모르면 처음 받은 시각)이 그때의 {@link #NEW_ITEM_LOOKBACK} 전과 등록 시각 가운데 늦은 것보다 늦은 것. 등록 직후 첫 수집은 2년치 글을
     * 한꺼번에 넣으므로 작성 시각 조건이 없으면 '새 글 100+'이 되고(늦게 찾은 옛 글도 새 글이 아님), 등록 전에 나온 글은 등록할 때 화면에서 이미 본
     * 글입니다. {@code hiddenSources}를 주면(회원) 그 출처의 글은 세지 않습니다(운영자 전용 저장본에서 온 글). 글이 없는 대상은 0.
     */
    public Map<Long, Integer> newCounts(long userId, List<String> hiddenSources) {
        boolean hide = hiddenSources != null && !hiddenSources.isEmpty();
        String sql = "SELECT w.id, COUNT(i.item_id) AS fresh FROM search_watches w "
                + "LEFT JOIN search_watch_items i ON i.entity_key = w.entity_key AND i.first_seen_at > COALESCE(w.last_seen_at, w.created_at)"
                + " AND COALESCE(i.published_at, i.first_seen_at) > GREATEST(COALESCE(w.last_seen_at, w.created_at) - INTERVAL '"
                + NEW_ITEM_LOOKBACK.toHours() + " hours', w.created_at)"
                + (hide ? " AND i.source <> ALL (?)" : "")
                + " WHERE w.user_id = ? GROUP BY w.id ORDER BY w.id";
        Map<Long, Integer> out = new LinkedHashMap<>();
        jdbc.query(connection -> {
            PreparedStatement statement = connection.prepareStatement(sql);
            int index = 1;
            if (hide) {
                statement.setArray(index++, connection.createArrayOf("text", hiddenSources.toArray(new String[0])));
            }
            statement.setLong(index, userId);
            return statement;
        }, rs -> {
            out.put(rs.getLong("id"), rs.getInt("fresh"));
        });
        return out;
    }

    private RowMapper<Watch> mapper() {
        return (rs, rowNum) -> new Watch(rs.getLong("id"), rs.getLong("user_id"), rs.getString("entity_key"), rs.getString("kind"),
                rs.getString("name"), aliases(rs.getString("aliases")), json(rs.getString("ids")),
                UserStore.instant(rs.getTimestamp("created_at")), UserStore.instant(rs.getTimestamp("last_seen_at")));
    }

    private List<String> aliases(String text) {
        List<String> out = new ArrayList<>();
        JsonNode node = json(text);
        if (node != null && node.isArray()) {
            node.forEach(alias -> {
                if (alias.isString()) {
                    out.add(alias.stringValue());
                }
            });
        }
        return out;
    }

    private JsonNode json(String text) {
        if (text == null) {
            return null;
        }
        JsonNode node = mapper.readTree(text);
        return node == null || node.isNull() ? null : node;
    }
}
