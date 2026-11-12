package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;

/**
 * 모의 매매 마감 브리핑의 기록({@code paper_briefings}, V36 — ADR 0039). 백엔드가 쓰는 표입니다(ADR 0008 — 수집기는 모름).
 *
 * <p>시장·세션마다 한 행입니다. 행이 있으면 그 세션은 다시 부르지 않고, 보낸 시각이 비어 있으면 같은 글을 다시 보냅니다.
 */
@Repository
public class BriefingStore {

    /** 의견까지 담은 브리핑. */
    public static final String OK = "OK";
    /** Claude를 부르지 못했거나 응답을 쓰지 못해 사실만 담은 브리핑. */
    public static final String FACTS_ONLY = "FACTS_ONLY";

    /**
     * 브리핑 한 행.
     *
     * @param facts    코드가 만든 그날의 사실(JSON)
     * @param response Claude의 응답(해석·의견). 부르지 못했으면 null
     * @param message  보낸(보낼) 글 — 텔레그램 서식까지 든 그대로
     * @param error    의견을 싣지 못한 까닭(상태 {@link #FACTS_ONLY}) — 아니면 null
     * @param sentAt   텔레그램을 보낸 시각. 아직 보내지 못했으면 null
     */
    public record Row(String market, LocalDate sessionDate, String status, JsonNode facts, JsonNode response, String message,
                      String model, JsonNode usage, String error, Instant createdAt, Instant sentAt) {
    }

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;
    private final ObjectMapper mapper;

    public BriefingStore(JdbcTemplate jdbc, SchemaCheck schema, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.schema = schema;
        this.mapper = mapper;
    }

    /** 표가 있는가. 수집기가 아직 V36을 적용하지 않았으면 false입니다. */
    public boolean ready() {
        return schema.tableExists("paper_briefings");
    }

    /** 그 시장·그 세션의 브리핑. 없으면 empty. */
    public Optional<Row> find(String market, LocalDate sessionDate) {
        return jdbc.query("SELECT market, session_date, status, facts, response, message, model, usage, error, created_at, sent_at "
                        + "FROM paper_briefings WHERE market = ? AND session_date = ?",
                (rs, rowNum) -> {
                    Timestamp sent = rs.getTimestamp("sent_at");
                    return new Row(rs.getString("market"), rs.getDate("session_date").toLocalDate(), rs.getString("status"),
                            json(rs.getString("facts")), json(rs.getString("response")), rs.getString("message"),
                            rs.getString("model"), json(rs.getString("usage")), rs.getString("error"),
                            rs.getTimestamp("created_at").toInstant(), sent == null ? null : sent.toInstant());
                }, market, Date.valueOf(sessionDate)).stream().findFirst();
    }

    /**
     * 그 시장·그 세션에 아직 없을 때만 넣습니다.
     *
     * @return 이번에 넣었으면 true, 이미 있었으면 false(기존 행 그대로)
     */
    public boolean insertIfAbsent(Row r) {
        return jdbc.update("INSERT INTO paper_briefings (market, session_date, status, facts, response, message, model, usage, error, "
                        + "created_at) VALUES (?, ?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?, ?, CAST(? AS jsonb), ?, "
                        + "COALESCE(CAST(? AS timestamptz), now())) ON CONFLICT (market, session_date) DO NOTHING",
                r.market(), Date.valueOf(r.sessionDate()), r.status(), text(r.facts()), text(r.response()), r.message(), r.model(),
                text(r.usage()), r.error(), r.createdAt() == null ? null : r.createdAt().toString()) == 1;
    }

    /** 텔레그램을 보냈다고 적습니다(아직 비어 있을 때만). */
    public void markSent(String market, LocalDate sessionDate, Instant at) {
        jdbc.update("UPDATE paper_briefings SET sent_at = ? WHERE market = ? AND session_date = ? AND sent_at IS NULL",
                Timestamp.from(at), market, Date.valueOf(sessionDate));
    }

    private String text(JsonNode node) {
        return node == null || node.isNull() ? null : mapper.writeValueAsString(node);
    }

    private JsonNode json(String text) {
        return text == null ? null : mapper.readTree(text);
    }
}
