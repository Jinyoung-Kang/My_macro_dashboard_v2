package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 한국어 번역 저장({@code info_translations}, V35 — ADR 0037). 백엔드가 쓰는 표입니다(ADR 0008 — 수집기는 모름).
 *
 * <p>번역 한 건에 한 행이고 id는 {@code md5(kind + ':' + 원문)}입니다 — 같은 글자는 한 번만 번역합니다(다시 눌러도 모델을 부르지 않음).
 * 원문은 저장하지 않습니다(글 표·관측치에 이미 있음).
 */
@Repository
public class TranslationStore {

    /** 목록 제목(화면에서 그 제목의 번역 단추를 누를 때). */
    public static final String TITLE = "title";
    /** 본문·요약 조각(화면에서 번역 단추를 누를 때). */
    public static final String BODY = "body";

    private final JdbcTemplate jdbc;
    private final SchemaCheck schema;

    public TranslationStore(JdbcTemplate jdbc, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.schema = schema;
    }

    /** 표가 있는가. 수집기가 아직 V35를 적용하지 않았으면 false입니다. */
    public boolean ready() {
        return schema.tableExists("info_translations");
    }

    /** 번역 행의 id — Postgres의 {@code md5(kind || ':' || text)}와 같은 값(UTF-8, 소문자 16진 32자). */
    public static String id(String kind, String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            return HexFormat.of().formatHex(digest.digest((kind + ":" + text).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("MD5를 쓸 수 없습니다", e);
        }
    }

    /** 이 id들 가운데 번역이 있는 것 → {id: 한국어}. */
    public Map<String, String> find(Collection<String> ids) {
        Map<String, String> out = new LinkedHashMap<>();
        if (ids == null || ids.isEmpty()) {
            return out;
        }
        String[] array = ids.stream().distinct().toArray(String[]::new);
        jdbc.query(con -> {
            var ps = con.prepareStatement("SELECT id, text_ko FROM info_translations WHERE id = ANY(?)");
            ps.setArray(1, con.createArrayOf("text", array));
            return ps;
        }, rs -> {
            out.put(rs.getString("id"), rs.getString("text_ko"));
        });
        return out;
    }

    /** 번역 한 건을 넣습니다 — 이미 있으면 그대로 둡니다(먼저 넣은 번역을 지킴). */
    public void put(String id, String kind, int sourceChars, String textKo, String model) {
        jdbc.update("INSERT INTO info_translations (id, kind, source_chars, text_ko, model) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (id) DO NOTHING", id, kind, Math.max(1, sourceChars), textKo, model);
    }

    /** {@code from} 뒤에 번역한 원문 글자 수의 합(하루 상한을 세는 데 씀). */
    public long charsSince(Instant from) {
        Long sum = jdbc.queryForObject("SELECT COALESCE(SUM(source_chars), 0) FROM info_translations WHERE created_at >= ?",
                Long.class, Timestamp.from(from));
        return sum == null ? 0L : sum;
    }
}
