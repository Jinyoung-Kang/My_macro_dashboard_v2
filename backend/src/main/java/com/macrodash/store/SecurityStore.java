package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 보안 공지(ADR 0046)의 수집기 표 읽기 — 보호나라 공지({@code security_notices}·{@code security_notice_rows})와 운영 환경의 버전 목록
 * ({@code env_inventory}·{@code env_components}·{@code env_pending_updates}·{@code env_changelog_cves}), 배포판 보안 추적기에 물어 본 결과
 * ({@code distro_cve_status}, V42), 그 태스크의 출처 판정({@code fetch_source_state}). 수집기가 쓰는 표라
 * 백엔드는 <b>읽기만</b> 합니다(ADR 0008). 스냅숏을 읽지 않으므로 수집을 일으키지 않습니다.
 *
 * <p>store는 기능 패키지를 모르므로(ADR 0001) 표의 행을 이 클래스의 레코드로 내리고, 판정 입력으로 옮기는 일은 서비스가 합니다.
 * 버전 칸·설치 버전은 원문 그대로입니다. 서버의 실제 버전은 운영 DB에만 있으므로 이 레코드를 로그에 남기지 않습니다.
 */
@Repository
public class SecurityStore {

    /**
     * 공지 한 건(표 {@code security_notices}).
     *
     * @param listNo      목록의 번호 칸(고정 공지로만 본 글은 null)
     * @param postedOn    게시일(KST 날짜)
     * @param detailStatus pending·ok·failed·skipped
     * @param layout      product_table·other_table·no_table — 상세를 읽지 못했으면 null
     * @param products    표의 제품명 고유 값(원문, 처음 나온 순서)
     * @param notes       표 밖 '※' 문장(원문)
     * @param bodyText    표를 뺀 본문 글자(상세 전이면 null)
     */
    public record Notice(long nttId, Integer listNo, String title, LocalDate postedOn, String url, boolean pinned,
                         String detailStatus, int detailAttempts, String detailError, String layout, List<String> products,
                         List<String> notes, String bodyText, Instant firstSeenAt, Instant detailFetchedAt) {
    }

    /** 공지 표 한 행(표 {@code security_notice_rows}) — 칸은 원문 그대로. */
    public record NoticeRow(long nttId, int rowNo, String cve, String product, String affected, String fixed) {
    }

    /**
     * 버전 목록의 머리(표 {@code env_inventory}의 한 행).
     *
     * @param collectedAt 호스트 스크립트가 모은 시각
     * @param receivedAt  수집기가 받은 시각
     * @param aptListsAt  apt 목록을 마지막으로 새로 받은 시각(모르면 null)
     * @param sections    구역 상태(표의 JSON 순서)
     */
    public record Inventory(Instant collectedAt, Instant receivedAt, boolean hostIncluded, Instant aptListsAt,
                            List<Section> sections) {
    }

    /**
     * 구역 하나의 상태.
     *
     * @param status ok·failed·skipped(원문 — 모르는 값도 그대로)
     * @param count  그 구역에서 받은 구성 요소 수(없으면 null)
     * @param reason 실패·건너뜀 사유 한 줄(없으면 null)
     * @param os     그 구역의 /etc/os-release(구역 객체의 {@code "os"} — ADR 0046 덧붙임 2026-11-21 '배포판 보안 추적기'). 없으면 null
     */
    public record Section(String name, String status, Integer count, String reason, Os os) {

        /** os 없이(V42 전 버전 목록·시험). */
        public Section(String name, String status, Integer count, String reason) {
            this(name, status, count, reason, null);
        }
    }

    /** 구역의 /etc/os-release 세 값({@code ID}·{@code VERSION_ID}·{@code VERSION_CODENAME}) — 없는 값은 null. */
    public record Os(String id, String versionId, String codename) {
    }

    /**
     * 배포판 보안 추적기에 물어 본 결과 한 행(표 {@code distro_cve_status}, V42 — 수집기가 씀).
     *
     * @param status       fixed·not_affected·open·unknown(원문)
     * @param fixedVersion 고친 판(fixed일 때만)
     * @param detail       추적기의 원래 상태 글(표시용)
     * @param checkedAt    물은 시각
     */
    public record TrackerStatus(String distro, String suite, String pkg, String cve, String status, String fixedVersion,
                                String detail, Instant checkedAt) {
    }

    /** 구성 요소 한 개(표 {@code env_components}). {@code sourcePackage}는 dpkg·apk의 원본 패키지, jdk는 배포처(release 파일의 IMPLEMENTOR). */
    public record Component(String source, String ecosystem, String name, String version, String sourcePackage) {
    }

    /** 서버의 apt 보류 업데이트 한 건(표 {@code env_pending_updates}). */
    public record Pending(String pkg, String arch, String installed, String candidate, String repos, boolean security) {
    }

    /**
     * 서버 배포판 패키지 변경 기록의 CVE 한 건(표 {@code env_changelog_cves}, V41 — ADR 0046 덧붙임 2026-11-21).
     * {@code pkg}는 dpkg 원본 패키지 이름, 실행 중인 커널이면 {@code kernel}({@code version}은 {@code uname -r}).
     */
    public record ChangelogCve(String pkg, String version, String cve) {
    }

    /** 그 태스크의 출처 판정(표 {@code fetch_source_state}의 한 행). */
    public record SourceState(String status, int streak, String reason, Instant lastOkAt, Instant lastRunAt,
                              int staleAfterMinutes) {
    }

    private static final String NOTICE_COLUMNS = "ntt_id, list_no, title, posted_on, url, pinned, detail_status, detail_attempts, "
            + "detail_error, layout, products, notes, body_text, first_seen_at, detail_fetched_at";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;

    public SecurityStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
    }

    /** 공지 표가 있는가 — 수집기가 아직 V40을 적용하지 않았으면 false. */
    public boolean ready() {
        return schema.tableExists("security_notices") && schema.tableExists("security_notice_rows");
    }

    /** 버전 목록 표가 있는가. */
    public boolean inventoryReady() {
        return schema.tableExists("env_inventory") && schema.tableExists("env_components")
                && schema.tableExists("env_pending_updates");
    }

    /** 공지 전부(게시일·글 번호 최근부터). 90일 메우기 한 벌이라 수백 건 안쪽입니다. */
    public List<Notice> notices() {
        return jdbc.query("SELECT " + NOTICE_COLUMNS + " FROM security_notices ORDER BY posted_on DESC, ntt_id DESC",
                (rs, rowNum) -> notice(rs));
    }

    public Optional<Notice> notice(long nttId) {
        return jdbc.query("SELECT " + NOTICE_COLUMNS + " FROM security_notices WHERE ntt_id = ?", (rs, rowNum) -> notice(rs), nttId)
                .stream().findFirst();
    }

    /** 표 행 전부(글 번호·행 순서). */
    public List<NoticeRow> rows() {
        return jdbc.query("SELECT ntt_id, row_no, cve, product, affected, fixed FROM security_notice_rows ORDER BY ntt_id, row_no",
                (rs, rowNum) -> row(rs));
    }

    /** 그 공지의 표 행(행 순서). */
    public List<NoticeRow> rows(long nttId) {
        return jdbc.query("SELECT ntt_id, row_no, cve, product, affected, fixed FROM security_notice_rows WHERE ntt_id = ? "
                + "ORDER BY row_no", (rs, rowNum) -> row(rs), nttId);
    }

    /** 버전 목록의 머리 — 받은 적이 없으면 비어 있음. */
    public Optional<Inventory> inventory() {
        return jdbc.query("SELECT collected_at, received_at, host_included, apt_lists_at, sections FROM env_inventory WHERE id = 1",
                (rs, rowNum) -> new Inventory(instant(rs, "collected_at"), instant(rs, "received_at"), rs.getBoolean("host_included"),
                        instant(rs, "apt_lists_at"), sections(rs.getString("sections")))).stream().findFirst();
    }

    /** 구성 요소 전부(구역·종류·이름·버전 순). */
    public List<Component> components() {
        return jdbc.query("SELECT source, ecosystem, name, version, source_package FROM env_components "
                        + "ORDER BY source, ecosystem, name, version",
                (rs, rowNum) -> new Component(rs.getString("source"), rs.getString("ecosystem"), rs.getString("name"),
                        rs.getString("version"), rs.getString("source_package")));
    }

    /** apt 보류 업데이트 전부(보안 먼저, 패키지 이름순). */
    public List<Pending> pending() {
        return jdbc.query("SELECT package, arch, installed, candidate, repos, security FROM env_pending_updates "
                        + "ORDER BY security DESC, package, arch",
                (rs, rowNum) -> new Pending(rs.getString("package"), rs.getString("arch"), rs.getString("installed"),
                        rs.getString("candidate"), rs.getString("repos"), rs.getBoolean("security")));
    }

    /** 변경 기록 CVE 전부 — 수집기가 아직 V41을 적용하지 않았으면 빈 목록(서버에서 만 줄 안팎, 호스트 구역이 없는 곳은 0줄). */
    public List<ChangelogCve> changelogCves() {
        if (!schema.tableExists("env_changelog_cves")) {
            return List.of();
        }
        return jdbc.query("SELECT package, version, cve FROM env_changelog_cves",
                (rs, rowNum) -> new ChangelogCve(rs.getString("package"), rs.getString("version"), rs.getString("cve")));
    }

    /**
     * 추적기 결과 전부 — 수집기가 아직 V42를 적용하지 않았으면 빈 목록. 물어볼 것({@code security_tracker_wants})만큼이라 수백 줄 안쪽입니다
     * (물어볼 것에서 빠진 행도 지우지 않아 조금씩 늘 수 있음).
     */
    public List<TrackerStatus> trackerStatuses() {
        if (!schema.tableExists("distro_cve_status")) {
            return List.of();
        }
        return jdbc.query("SELECT distro, suite, package, cve, status, fixed_version, detail, checked_at FROM distro_cve_status",
                (rs, rowNum) -> new TrackerStatus(rs.getString("distro"), rs.getString("suite"), rs.getString("package"),
                        rs.getString("cve"), rs.getString("status"), rs.getString("fixed_version"), rs.getString("detail"),
                        instant(rs, "checked_at")));
    }

    /** 그 태스크의 출처 판정 — 표가 없거나 기록이 없으면 비어 있음. */
    public Optional<SourceState> sourceState(String task) {
        if (!schema.tableExists("fetch_source_state")) {
            return Optional.empty();
        }
        return jdbc.query("SELECT status, streak, reason, last_ok_at, last_run_at, stale_after_minutes FROM fetch_source_state "
                        + "WHERE task = ?",
                (rs, rowNum) -> new SourceState(rs.getString("status"), rs.getInt("streak"), rs.getString("reason"),
                        instant(rs, "last_ok_at"), instant(rs, "last_run_at"), rs.getInt("stale_after_minutes")), task)
                .stream().findFirst();
    }

    // ---- 행 옮기기 ----------------------------------------------------------------------------------------------

    private Notice notice(ResultSet rs) throws SQLException {
        int listNo = rs.getInt("list_no");
        Integer listNoOrNull = rs.wasNull() ? null : listNo;
        Date posted = rs.getDate("posted_on");
        return new Notice(rs.getLong("ntt_id"), listNoOrNull, rs.getString("title"), posted == null ? null : posted.toLocalDate(),
                rs.getString("url"), rs.getBoolean("pinned"), rs.getString("detail_status"), rs.getInt("detail_attempts"),
                rs.getString("detail_error"), rs.getString("layout"), strings(rs.getString("products")),
                strings(rs.getString("notes")), rs.getString("body_text"), instant(rs, "first_seen_at"),
                instant(rs, "detail_fetched_at"));
    }

    private static NoticeRow row(ResultSet rs) throws SQLException {
        return new NoticeRow(rs.getLong("ntt_id"), rs.getInt("row_no"), rs.getString("cve"), rs.getString("product"),
                rs.getString("affected"), rs.getString("fixed"));
    }

    /** JSON 글자 배열 → 글 목록. 배열이 아니거나 읽지 못하면 빈 목록(글자가 아닌 칸은 건너뜀). */
    private List<String> strings(String json) {
        List<String> out = new ArrayList<>();
        JsonNode node = readTree(json);
        if (node != null && node.isArray()) {
            for (JsonNode item : node) {
                if (item.isString()) {
                    out.add(item.asString());
                }
            }
        }
        return List.copyOf(out);
    }

    /**
     * 구역 상태 JSON({구역: {status, count, reason?, os?: {id, versionId, codename}}}) → 구역 목록. 모양이 틀린 칸은 null로 둡니다(없는 값을
     * 만들지 않음).
     */
    private List<Section> sections(String json) {
        List<Section> out = new ArrayList<>();
        JsonNode node = readTree(json);
        if (node == null || !node.isObject()) {
            return List.of();
        }
        for (Map.Entry<String, JsonNode> entry : node.properties()) {
            JsonNode value = entry.getValue();
            String status = value.path("status").isString() ? value.path("status").asString() : null;
            Integer count = value.path("count").isIntegralNumber() ? value.path("count").asInt() : null;
            String reason = value.path("reason").isString() ? value.path("reason").asString() : null;
            JsonNode os = value.path("os");
            Os osValue = os.isObject() ? new Os(text(os, "id"), text(os, "versionId"), text(os, "codename")) : null;
            out.add(new Section(entry.getKey(), status, count, reason, osValue));
        }
        return List.copyOf(out);
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isString() ? value.asString() : null;
    }

    private JsonNode readTree(String json) {
        if (json == null) {
            return null;
        }
        try {
            return mapper.readTree(json);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp at = rs.getTimestamp(column);
        return at == null ? null : at.toInstant();
    }
}
