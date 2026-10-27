package com.macrodash.store;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 수집기 테이블 읽기 (이 테이블들은 <b>읽기만</b> 합니다).
 *
 * <p>{@code snapshots}·{@code timeseries}·{@code observations}·{@code collector_*}·{@code refresh_requests}는
 * 수집기(Python)만 씁니다. 수동 새로고침 기준 시각도 수집기의 {@code POST /refresh}가 씁니다. 백엔드가 쓰는
 * 테이블(판정 기록 등)은 따로 둔 저장소가 맡습니다(ADR 0008, {@link RegimeLogStore}).
 * 이렇게 나누면 "화면을 열었더니 수집이 시작돼 사용자가 수십 초를 기다리는"
 * 구버전의 구조적 문제가 되살아나지 않습니다.
 */
@Repository
public class StoreRepository {

    private static final Logger log = LoggerFactory.getLogger(StoreRepository.class);

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public StoreRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    // ------------------------------------------------------------------ 스냅샷
    /**
     * 스냅샷 1건. DB 장애는 그대로 올립니다.
     *
     * <p>예전에는 DataAccessException을 삼키고 "없음"으로 답했습니다. 그러면 auto 모드의
     * StoreReader가 "저장본이 없다"고 보고 수집기를 90초씩 기다렸고, 화면은 "수집기를
     * 실행하세요"라는 틀린 안내를 냈습니다. 500이 나와야 원인(DB)이 보입니다.
     */
    public Optional<Snapshot> readSnapshot(String name) {
        Snapshot cached = parsed.get(name);
        if (cached != null) {
            Instant current = collectedAt(name);
            if (current != null && current.equals(cached.collectedAt())) {
                return Optional.of(cached);
            }
            parsed.remove(name);
            if (current == null) {
                return Optional.empty();
            }
        }
        Optional<Loaded> loaded = jdbc.query(
                "SELECT name, payload, kind, status, error, collected_at, "
                        + "pg_column_size(payload) AS bytes FROM snapshots WHERE name = ?",
                loadedMapper(),
                name
        ).stream().findFirst();
        loaded.filter(l -> l.bytes() >= CACHE_MIN_BYTES && l.snapshot().payload() != null)
                .ifPresent(l -> parsed.put(name, l.snapshot()));
        return loaded.map(Loaded::snapshot);
    }

    /**
     * 큰 스냅샷의 파싱 결과 캐시.
     *
     * <p>13F 분기 저장본(최대 2.5MB)과 종목 종가 저장본(2.2MB)을 요청마다 DB에서 읽어 다시
     * 파싱했습니다 — 구루 화면이 요청 하나에 그런 저장본 12개를 파싱해 300~450ms였습니다.
     * 이름별로 파싱 결과를 들고, 읽을 때 collected_at 한 값만 조회해 바뀌지 않았으면 그대로
     * 씁니다(새 수집이 들어오면 collected_at이 바뀌어 자동으로 다시 읽음). 작은 저장본은
     * 파싱이 싸고 수가 많아 캐시하지 않습니다. 캐시한 JsonNode는 읽기 전용으로만 씁니다.
     */
    static final long CACHE_MIN_BYTES = 32 * 1024;
    private final Map<String, Snapshot> parsed = new ConcurrentHashMap<>();

    record Loaded(Snapshot snapshot, long bytes) {
    }

    private Instant collectedAt(String name) {
        List<Timestamp> rows = jdbc.query(
                "SELECT collected_at FROM snapshots WHERE name = ?",
                (rs, rowNum) -> rs.getTimestamp("collected_at"),
                name);
        return rows.isEmpty() ? null : toInstant(rows.get(0));
    }

    private RowMapper<Loaded> loadedMapper() {
        RowMapper<Snapshot> base = snapshotMapper();
        return (rs, rowNum) -> new Loaded(base.mapRow(rs, rowNum), rs.getLong("bytes"));
    }

    /**
     * 저장본 전체에서 가장 최근 수집 시각. 어떤 저장본이든 새로 쓰이면 바뀌므로 "계산 결과가 아직 유효한가"의
     * 버전으로 씁니다({@code read.ComputedCache}). 표가 수십 행이라 조회는 1ms 안팎입니다. 저장본이 없으면 null.
     */
    public Instant latestCollectedAt() {
        List<Timestamp> rows = jdbc.query(
                "SELECT MAX(collected_at) AS latest FROM snapshots",
                (rs, rowNum) -> rs.getTimestamp("latest"));
        return rows.isEmpty() || rows.get(0) == null ? null : toInstant(rows.get(0));
    }

    /** DB에 닿는가(헬스체크용). 여기서는 예외를 삼키는 것이 맞습니다 — 답이 곧 상태입니다. */
    public boolean ping() {
        try {
            Integer one = jdbc.queryForObject("SELECT 1", Integer.class);
            return one != null && one == 1;
        } catch (DataAccessException e) {
            log.warn("DB 연결 확인 실패: {}", e.getMessage());
            return false;
        }
    }

    public List<Map<String, Object>> listSnapshotMeta() {
        return jdbc.query(
                "SELECT name, status, error, collected_at FROM snapshots ORDER BY name",
                (rs, rowNum) -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", rs.getString("name"));
                    row.put("status", rs.getString("status"));
                    row.put("error", rs.getString("error"));
                    row.put("collectedAt", toInstant(rs.getTimestamp("collected_at")));
                    return row;
                }
        );
    }

    /**
     * 저장본 본문에서 최상위 키 하나를 뺀 나머지(작은 메타 정보)와 신선도 — 큰 배열을 내려받거나 파싱하지 않습니다.
     *
     * <p>{@link #readSnapshot}은 32KB가 넘는 저장본의 파싱 결과를 이름별로 계속 들고 있습니다. 모의 매매 트랙레코드는 후보 27곳의
     * 30분기 13F(보유 수천 줄 × 30)를 읽는데, 그 트리를 다 캐시하면 백엔드 힙(약 700MB)을 위협합니다(단계 1b 검토). 그래서 메타와
     * 보유 열({@link #readQuarterHoldings})을 따로, 캐시 없이 읽습니다. DB 장애는 그대로 올립니다.
     *
     * @return 저장본이 없으면 empty
     */
    public Optional<Snapshot> readSnapshotMeta(String name, String droppedKey) {
        return jdbc.query(
                "SELECT name, payload - ? AS payload, kind, status, error, collected_at FROM snapshots WHERE name = ?",
                snapshotMapper(), droppedKey, name).stream().findFirst();
    }

    /**
     * 13F 형식 저장본({@code quarters[].holdings[]})의 분기·보유에서 필요한 열만, JSONB를 DB에서 풀어 읽습니다(캐시 없음 —
     * {@link #readSnapshotMeta}의 이유). 분기 순서는 저장본 그대로(quarterIndex 0부터)이고, 보유가 없는 분기도 한 줄(보유 열은 null)로
     * 나옵니다. 평가액·주식 수가 숫자가 아니면 null입니다(0으로 채우지 않음). 배열이 아닌 자리는 빈 배열로 봅니다.
     */
    public List<HoldingRow> readQuarterHoldings(String name) {
        return jdbc.query("""
                SELECT q.ord - 1 AS quarter_index,
                       q.value->>'filingDate' AS filing_date, q.value->>'reportDate' AS report_date,
                       q.value->>'filerCik' AS filer_cik, h.value->>'cusip' AS cusip, h.value->>'ticker' AS ticker,
                       CASE WHEN jsonb_typeof(h.value->'value') = 'number' THEN (h.value->>'value')::float8 END AS value,
                       CASE WHEN jsonb_typeof(h.value->'shares') = 'number' THEN (h.value->>'shares')::float8 END AS shares
                FROM snapshots s
                CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload->'quarters') = 'array'
                        THEN s.payload->'quarters' ELSE '[]'::jsonb END) WITH ORDINALITY AS q(value, ord)
                LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.value->'holdings') = 'array'
                        THEN q.value->'holdings' ELSE '[]'::jsonb END) AS h(value) ON true
                WHERE s.name = ?
                ORDER BY q.ord
                """, (rs, rowNum) -> new HoldingRow(rs.getInt("quarter_index"), rs.getString("filing_date"),
                rs.getString("report_date"), rs.getString("filer_cik"), rs.getString("cusip"), rs.getString("ticker"),
                (Double) rs.getObject("value"), (Double) rs.getObject("shares")), name);
    }

    private RowMapper<Snapshot> snapshotMapper() {
        return (ResultSet rs, int rowNum) -> new Snapshot(
                rs.getString("name"),
                parseJson(rs.getString("payload")),
                rs.getString("kind"),
                rs.getString("status"),
                rs.getString("error"),
                toInstant(rs.getTimestamp("collected_at"))
        );
    }

    private JsonNode parseJson(String raw) {
        try {
            return raw == null ? null : mapper.readTree(raw);
        } catch (Exception e) {
            log.warn("스냅샷 JSON 해석 실패: {}", e.getMessage());
            return null;
        }
    }

    // ---------------------------------------------------------------- 시계열
    public List<TimeseriesPoint> readTimeseries(String dataset, String seriesId, LocalDate from) {
        StringBuilder sql = new StringBuilder(
                "SELECT obs_date, value FROM timeseries WHERE dataset = ? AND series_id = ?");
        List<Object> params = new ArrayList<>(List.of(dataset, seriesId));
        if (from != null) {
            sql.append(" AND obs_date >= ?");
            params.add(java.sql.Date.valueOf(from));
        }
        sql.append(" ORDER BY obs_date");

        return jdbc.query(sql.toString(), (rs, rowNum) -> new TimeseriesPoint(
                rs.getDate("obs_date").toLocalDate(),
                (Double) rs.getObject("value")
        ), params.toArray());
    }

    /**
     * 같은 데이터셋의 시계열 여러 개를 날짜 범위로 한 번에 읽습니다(모의 매매의 10년 종가 등).
     *
     * <p><b>왜 따로 두나</b> — 종목 550여 개 × 10년이면 140만 행입니다. {@link #readTimeseries}처럼 점마다
     * {@code LocalDate}·{@code Double} 객체를 만들면 그것만 수백 MB이고(백엔드 힙은 약 700MB), 자동 커밋 연결에서는
     * 드라이버가 결과 전체를 메모리에 받은 뒤에야 넘겨줍니다. 그래서 커서({@value #STREAM_FETCH_ROWS}행씩)로 흘려 받으며
     * 시계열마다 원시 배열로 모읍니다 — 날짜는 DB가 계산한 epoch day(1970-01-01부터의 일수, {@code LocalDate.toEpochDay}와
     * 같은 값)라 날짜 객체를 쌓지 않습니다. 커서는 트랜잭션 안에서만 동작해 읽기 전용 트랜잭션으로 감쌉니다(바깥에
     * 트랜잭션이 있으면 거기에 합류).
     *
     * <p>값이 NULL이거나 유한한 수가 아닌(NaN·무한대) 행은 건너뜁니다 — 없는 값을 0으로 채우지 않습니다. 그래서 점이
     * 하나도 남지 않은 시계열, 저장된 적 없는 시계열은 결과에 키가 없습니다.
     *
     * @param seriesIds 읽을 시계열(비면 DB에 묻지 않고 빈 결과)
     * @param from      이 날짜부터(포함). null이면 제한 없음
     * @param to        이 날짜까지(포함). null이면 제한 없음
     * @return series_id → 날짜 오름차순 열(series_id 순으로 담김)
     */
    public Map<String, TimeseriesColumns> readTimeseriesColumns(String dataset, Collection<String> seriesIds,
                                                                LocalDate from, LocalDate to) {
        Map<String, TimeseriesColumns> out = new LinkedHashMap<>();
        if (seriesIds == null || seriesIds.isEmpty()) {
            return out;
        }
        String[] ids = seriesIds.stream().distinct().toArray(String[]::new);
        StringBuilder sql = new StringBuilder(
                "SELECT series_id, obs_date - DATE '1970-01-01' AS epoch_day, value FROM timeseries "
                        + "WHERE dataset = ? AND series_id = ANY(?) AND value IS NOT NULL");
        if (from != null) {
            sql.append(" AND obs_date >= ?");
        }
        if (to != null) {
            sql.append(" AND obs_date <= ?");
        }
        sql.append(" ORDER BY series_id, obs_date");

        ColumnCollector collector = new ColumnCollector(out);
        streamingTransactions().executeWithoutResult(status -> jdbc.query(connection -> {
            PreparedStatement statement = connection.prepareStatement(sql.toString());
            int index = 1;
            statement.setString(index++, dataset);
            statement.setArray(index++, connection.createArrayOf("text", ids));
            if (from != null) {
                statement.setDate(index++, java.sql.Date.valueOf(from));
            }
            if (to != null) {
                statement.setDate(index, java.sql.Date.valueOf(to));
            }
            statement.setFetchSize(STREAM_FETCH_ROWS);
            return statement;
        }, collector));
        collector.flush();
        return out;
    }

    /** 커서로 한 번에 받는 행 수. 1만 행이면 드라이버가 쥐는 메모리가 1~2MB 안팎입니다. */
    static final int STREAM_FETCH_ROWS = 10_000;

    /**
     * {@link #readTimeseriesColumns}의 읽기 전용 트랜잭션. 처음 쓸 때 만듭니다 — 가짜(mock) JdbcTemplate으로 이 저장소를
     * 만드는 단위 테스트에는 DataSource가 없어, 생성자에서 만들면 그 테스트들이 깨집니다.
     */
    private volatile TransactionTemplate streaming;

    private TransactionTemplate streamingTransactions() {
        TransactionTemplate template = streaming;
        if (template == null) {
            template = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
            template.setReadOnly(true);
            streaming = template;
        }
        return template;
    }

    /** series_id 순으로 오는 행을 시계열마다 원시 배열로 모읍니다. 버퍼 하나를 시계열마다 다시 씁니다. */
    private static final class ColumnCollector implements RowCallbackHandler {
        private final Map<String, TimeseriesColumns> out;
        private String current;
        private int[] days = new int[512];
        private double[] values = new double[512];
        private int size;

        ColumnCollector(Map<String, TimeseriesColumns> out) {
            this.out = out;
        }

        @Override
        public void processRow(ResultSet rs) throws SQLException {
            String seriesId = rs.getString(1);
            if (!seriesId.equals(current)) {
                flush();
                current = seriesId;
            }
            double value = rs.getDouble(3);
            if (!Double.isFinite(value)) {
                return;
            }
            if (size == days.length) {
                days = Arrays.copyOf(days, size * 2);
                values = Arrays.copyOf(values, size * 2);
            }
            days[size] = rs.getInt(2);
            values[size] = value;
            size++;
        }

        void flush() {
            if (current != null && size > 0) {
                out.put(current, new TimeseriesColumns(Arrays.copyOf(days, size), Arrays.copyOf(values, size)));
            }
            size = 0;
        }
    }

    public long countTimeseries() {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM timeseries", Long.class);
        return count == null ? 0 : count;
    }

    // -------------------------------------------------------------- 관측 레코드
    public List<JsonNode> readObservations(String dataset,
                                           LocalDate obsDate,
                                           LocalDate startDate,
                                           Map<String, String> filters) {
        return queryObservations(dataset, obsDate, startDate, filters, null);
    }

    /**
     * {@link #readObservations}와 같은 조건·순서로 <b>최신부터 {@code limit}행까지만</b> 읽습니다 (QA-133).
     *
     * <p>잘렸는지 알려면 행 수를 따로 세야 하는데, 그 대신 {@code limit + 1}행을 읽어 넘치는 한 행은 버리고
     * {@link ObservationPage#truncated()}로 알립니다(같은 쿼리 한 번).
     */
    public ObservationPage readNewestObservations(String dataset,
                                                  LocalDate obsDate,
                                                  LocalDate startDate,
                                                  Map<String, String> filters,
                                                  int limit) {
        if (limit < 1) {
            throw new IllegalArgumentException("limit은 1 이상이어야 합니다: " + limit);
        }
        List<JsonNode> rows = queryObservations(dataset, obsDate, startDate, filters, limit + 1);
        if (rows.size() <= limit) {
            return new ObservationPage(rows, false);
        }
        return new ObservationPage(new ArrayList<>(rows.subList(0, limit)), true);
    }

    private List<JsonNode> queryObservations(String dataset,
                                             LocalDate obsDate,
                                             LocalDate startDate,
                                             Map<String, String> filters,
                                             Integer limit) {
        StringBuilder sql = new StringBuilder(
                "SELECT obs_date, payload FROM observations WHERE dataset = ?");
        List<Object> params = new ArrayList<>(List.of(dataset));

        if (obsDate != null) {
            sql.append(" AND obs_date = ?");
            params.add(java.sql.Date.valueOf(obsDate));
        }
        if (startDate != null) {
            sql.append(" AND obs_date >= ?");
            params.add(java.sql.Date.valueOf(startDate));
        }
        if (filters != null && !filters.isEmpty()) {
            sql.append(" AND payload @> ?::jsonb");
            params.add(writeJson(filters));
        }
        // dataset이 하나로 정해져 (obs_date, entity)가 기본키처럼 유일하니 LIMIT로 자르는 경계가 호출마다 같습니다.
        sql.append(" ORDER BY obs_date DESC, entity");
        if (limit != null) {
            sql.append(" LIMIT ?");
            params.add(limit);
        }

        return jdbc.query(sql.toString(), (rs, rowNum) -> {
            JsonNode node = parseJson(rs.getString("payload"));
            if (node != null && node.isObject()) {
                ((tools.jackson.databind.node.ObjectNode) node)
                        .put("obsDate", rs.getDate("obs_date").toLocalDate().toString());
            }
            return node;
        }, params.toArray());
    }

    /**
     * 특정 날짜의 특정 개체만 읽습니다.
     *
     * <p>하루치 전 종목(약 3천 행)을 읽어 걸러 내지 않고, 기본키
     * (dataset, obs_date, entity) 인덱스로 필요한 행만 가져옵니다.
     *
     * @param entities 개체 키 목록 (호출하는 쪽이 형식을 검증해서 넘길 것)
     * @return entity → payload. 없는 개체는 키가 없습니다
     */
    public Map<String, JsonNode> readObservationsFor(String dataset, LocalDate obsDate,
                                                     Collection<String> entities) {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        if (entities.isEmpty()) {
            return out;
        }
        String placeholders = String.join(",", Collections.nCopies(entities.size(), "?"));
        List<Object> params = new ArrayList<>(List.of(dataset, java.sql.Date.valueOf(obsDate)));
        params.addAll(entities);
        jdbc.query("SELECT entity, payload FROM observations WHERE dataset = ? AND obs_date = ? "
                        + "AND entity IN (" + placeholders + ")",
                (RowCallbackHandler) rs -> out.put(rs.getString("entity"), parseJson(rs.getString("payload"))),
                params.toArray());
        return out;
    }

    /**
     * 여러 개체의 최근 기록을 개체별로 묶어 읽습니다 (최신 날짜가 앞).
     *
     * <p>기본키 (dataset, obs_date, entity)의 앞 두 열로 날짜 범위를 좁힌 뒤 개체를 거릅니다.
     * 종목 수십 개 × 수십 일이라 한 번의 쿼리로 끝납니다.
     *
     * @param entities 개체 키 (호출하는 쪽이 형식을 검증해서 넘길 것)
     * @param since    이 날짜 이후 기록만 (inclusive)
     * @return entity → 기록 목록(각 payload에 {@code obsDate} 추가). 기록이 없는 개체는 키가 없습니다
     */
    public Map<String, List<JsonNode>> readObservationSeries(String dataset, Collection<String> entities,
                                                             LocalDate since) {
        Map<String, List<JsonNode>> out = new LinkedHashMap<>();
        if (entities.isEmpty()) {
            return out;
        }
        String placeholders = String.join(",", Collections.nCopies(entities.size(), "?"));
        List<Object> params = new ArrayList<>(List.of(dataset, java.sql.Date.valueOf(since)));
        params.addAll(entities);
        jdbc.query("SELECT entity, obs_date, payload FROM observations WHERE dataset = ? AND obs_date >= ? "
                        + "AND entity IN (" + placeholders + ") ORDER BY entity, obs_date DESC",
                (RowCallbackHandler) rs -> {
                    JsonNode node = parseJson(rs.getString("payload"));
                    if (node != null && node.isObject()) {
                        ((tools.jackson.databind.node.ObjectNode) node)
                                .put("obsDate", rs.getDate("obs_date").toLocalDate().toString());
                        out.computeIfAbsent(rs.getString("entity"), key -> new ArrayList<>()).add(node);
                    }
                },
                params.toArray());
        return out;
    }

    /**
     * 여러 개체의 <b>기준일까지</b> 기록 전부를 개체별로 묶어 읽습니다(오래된 날짜가 앞).
     *
     * <p>시점(Point-in-Time) 계산용입니다 — 모의 매매 재무(D28, {@link Datasets#OBS_US_FUNDAMENTALS})는 obs_date가 공시일이라,
     * 기준일 d의 결정에는 {@code obs_date ≤ d}인 행만 써야 그날 몰랐던 정정값이 섞이지 않습니다. 시작일 없이 처음부터 읽는 것은
     * 연간 사실이 몇 년 전 공시에만 있기 때문입니다(같은 값의 재게재는 수집기가 버림). 기본키 (dataset, obs_date, entity)의 앞
     * 두 열로 범위를 좁힌 뒤 개체를 거릅니다.
     *
     * @param entities 개체 키 (호출하는 쪽이 형식을 검증해서 넘길 것)
     * @param until    이 날짜까지 기록만 (inclusive)
     * @return entity → 기록 목록(obs_date 오름차순, 각 payload에 {@code obsDate} 추가). 기록이 없는 개체는 키가 없습니다
     */
    public Map<String, List<JsonNode>> readObservationsUntil(String dataset, Collection<String> entities,
                                                             LocalDate until) {
        Map<String, List<JsonNode>> out = new LinkedHashMap<>();
        if (entities.isEmpty()) {
            return out;
        }
        String placeholders = String.join(",", Collections.nCopies(entities.size(), "?"));
        List<Object> params = new ArrayList<>(List.of(dataset, java.sql.Date.valueOf(until)));
        params.addAll(entities);
        jdbc.query("SELECT entity, obs_date, payload FROM observations WHERE dataset = ? AND obs_date <= ? "
                        + "AND entity IN (" + placeholders + ") ORDER BY entity, obs_date",
                (RowCallbackHandler) rs -> {
                    JsonNode node = parseJson(rs.getString("payload"));
                    if (node != null && node.isObject()) {
                        ((tools.jackson.databind.node.ObjectNode) node)
                                .put("obsDate", rs.getDate("obs_date").toLocalDate().toString());
                        out.computeIfAbsent(rs.getString("entity"), key -> new ArrayList<>()).add(node);
                    }
                },
                params.toArray());
        return out;
    }

    /**
     * 날짜 범위 {@code [from, to]}(양 끝 포함, {@code to}가 null이면 끝 없음)의 기록 전부(개체를 가리지 않음, 최신 날짜 → 개체 순).
     *
     * <p>모의 매매 사건 뉴스(2단계 B, {@link Datasets#OBS_NEWS_HEADLINE})용입니다 — entity가 제목 해시라 개체로 고를 수 없고, obs_date가
     * 발행 시각의 UTC 날짜라 결정 창(직전 결정 이후)을 덮는 날짜부터만 읽으면 됩니다. 기본키 (dataset, obs_date, entity)의 앞 두 열로 범위를
     * 좁힙니다. 보존이 7일이라 끝을 열어 둬도 수천 행 안입니다.
     *
     * @return 각 payload에 {@code obsDate}·{@code entity}를 더한 목록. 없으면 빈 목록. 시작이 없거나 범위가 거꾸로면 빈 목록
     */
    public List<JsonNode> readObservationsBetween(String dataset, LocalDate from, LocalDate to) {
        if (from == null || to != null && from.isAfter(to)) {
            return List.of();
        }
        StringBuilder sql = new StringBuilder(
                "SELECT entity, obs_date, payload FROM observations WHERE dataset = ? AND obs_date >= ?");
        List<Object> params = new ArrayList<>(List.of(dataset, java.sql.Date.valueOf(from)));
        if (to != null) {
            sql.append(" AND obs_date <= ?");
            params.add(java.sql.Date.valueOf(to));
        }
        sql.append(" ORDER BY obs_date DESC, entity");
        List<JsonNode> out = new ArrayList<>();
        jdbc.query(sql.toString(), (RowCallbackHandler) rs -> {
            JsonNode node = parseJson(rs.getString("payload"));
            if (node != null && node.isObject()) {
                ((tools.jackson.databind.node.ObjectNode) node)
                        .put("obsDate", rs.getDate("obs_date").toLocalDate().toString())
                        .put("entity", rs.getString("entity"));
                out.add(node);
            }
        }, params.toArray());
        return out;
    }

    /**
     * 그 데이터셋에서 {@code before}보다 이른(같은 날 제외) 가장 최근 obs_date. 없으면 null. 한국 규칙 계좌가 결정의 기준 세션 D에 쓸 유니버스
     * U(D)의 금융위 기준일 B(&lt; D — 2단계 명세 §4-5)를 고릅니다 — D 당일·뒤의 기준일 행은 결정 때 알 수 없던 값이라 보지 않습니다.
     */
    public LocalDate latestObservationDateBefore(String dataset, LocalDate before) {
        java.sql.Date date = jdbc.queryForObject(
                "SELECT MAX(obs_date) FROM observations WHERE dataset = ? AND obs_date < ?", java.sql.Date.class,
                dataset, java.sql.Date.valueOf(before));
        return date == null ? null : date.toLocalDate();
    }

    /** 그 데이터셋의 가장 최근 obs_date. 없으면 null. */
    public LocalDate latestObservationDate(String dataset) {
        java.sql.Date date = jdbc.queryForObject(
                "SELECT MAX(obs_date) FROM observations WHERE dataset = ?", java.sql.Date.class, dataset);
        return date == null ? null : date.toLocalDate();
    }

    public List<String> listObservationDates(String dataset) {
        return jdbc.query(
                "SELECT DISTINCT obs_date FROM observations WHERE dataset = ? ORDER BY obs_date DESC",
                (rs, rowNum) -> rs.getDate("obs_date").toLocalDate().toString(),
                dataset
        );
    }

    /**
     * 조건(payload 포함 관계)에 맞는 기록이 있는 날짜만, 최신 순.
     *
     * @param filters 비었으면 {@link #listObservationDates(String)}와 같습니다
     */
    public List<String> listObservationDates(String dataset, Map<String, String> filters) {
        if (filters == null || filters.isEmpty()) {
            return listObservationDates(dataset);
        }
        return jdbc.query(
                "SELECT DISTINCT obs_date FROM observations WHERE dataset = ? AND payload @> ?::jsonb "
                        + "ORDER BY obs_date DESC",
                (rs, rowNum) -> rs.getDate("obs_date").toLocalDate().toString(),
                dataset, writeJson(filters));
    }

    public long countObservations() {
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM observations", Long.class);
        return count == null ? 0 : count;
    }

    // ------------------------------------------------------------- 수집 실행 로그
    public Optional<Map<String, Object>> readLastRun() {
        return jdbc.queryForList("SELECT * FROM collector_runs ORDER BY id DESC LIMIT 1")
                .stream().findFirst();
    }

    /**
     * 시간 상한을 넘긴 실행이 뒤에서 계속 도는 동안의 호출이 남기는 ⚠️ 안내 행의 앞머리(수집기 {@code store.STILL_RUNNING_PREFIX},
     * {@code StillRunningNoticeParityTest}가 대조). 태스크별 요약은 이 행을 건너뜁니다(QA-139).
     */
    public static final String STILL_RUNNING_PREFIX = "이전 수집이 아직 진행 중";

    /**
     * 태스크별 가장 최근 실행 1건, 태스크 이름 순.
     *
     * <p>기록에 있는 태스크 이름을 (task, id DESC) 인덱스에서 하나씩 건너뛰며 찾고, 태스크마다
     * 첫 행만 읽습니다. 예전 {@code DISTINCT ON}은 실행 기록 전체를 정렬해 1년치(43만 행)에서
     * 116ms가 걸렸습니다(지금 0.3ms). 결과는 같습니다.
     *
     * <p>좀비가 도는 동안의 ⚠️ 안내 행({@link #STILL_RUNNING_PREFIX})은 건너뛰고 그 앞 실행(❌ 시간 초과)을 씁니다 — 그 행을
     * 고르면 실제로는 멈춰 있는 태스크가 상태 화면의 '현재 오류'에서 빠졌습니다(QA-139). 실행 기록에는 그대로 남습니다.
     */
    public List<Map<String, Object>> readTaskSummary() {
        return jdbc.queryForList(
                "WITH RECURSIVE names AS ("
                        + " (SELECT task FROM collector_task_runs ORDER BY task LIMIT 1)"
                        + " UNION ALL"
                        + " SELECT (SELECT r.task FROM collector_task_runs r"
                        + "         WHERE r.task > n.task ORDER BY r.task LIMIT 1)"
                        + " FROM names n WHERE n.task IS NOT NULL"
                        + ") "
                        + "SELECT latest.* FROM names n "
                        + "CROSS JOIN LATERAL ("
                        + " SELECT task, speed, status, started_at, duration_ms, detail, run_id"
                        + " FROM collector_task_runs r WHERE r.task = n.task"
                        + " AND NOT (r.status = 'empty' AND r.detail IS NOT NULL AND r.detail LIKE ?)"
                        + " ORDER BY r.id DESC LIMIT 1"
                        + ") latest "
                        + "ORDER BY latest.task", STILL_RUNNING_PREFIX + "%");
    }

    public List<Map<String, Object>> readTaskHistory(String task, int limit) {
        if (task == null || task.isBlank()) {
            return jdbc.queryForList(
                    "SELECT run_id, task, speed, status, started_at, duration_ms, detail "
                            + "FROM collector_task_runs ORDER BY id DESC LIMIT ?", limit);
        }
        return jdbc.queryForList(
                "SELECT run_id, task, speed, status, started_at, duration_ms, detail "
                        + "FROM collector_task_runs WHERE task = ? ORDER BY id DESC LIMIT ?",
                task, limit);
    }

    /**
     * 최근 실행 기록 중 정상(ok)이 아닌 것만, 최신 순.
     *
     * <p>성능 — 실행 기록은 계속 쌓입니다(하루 약 1천 행). 시각 조건만 걸면 문제가 없는 날
     * 표 전체를 거꾸로 훑게 되므로, 먼저 최근 {@code window}행(기본키 역순, 인덱스)으로
     * 범위를 자른 뒤 그 안에서 거릅니다. 비용이 표 크기와 무관하게 일정합니다.
     *
     * @param since  이 시각 이후만
     * @param window 살펴볼 최근 행 수
     */
    public List<Map<String, Object>> readRecentTaskIssues(Instant since, int window) {
        return jdbc.queryForList(
                "SELECT task, status, started_at, detail FROM ("
                        + " SELECT id, task, status, started_at, detail FROM collector_task_runs"
                        + " ORDER BY id DESC LIMIT ?) recent"
                        + " WHERE status NOT IN ('ok', 'running') AND started_at >= ?"
                        + " ORDER BY id DESC",
                window, Timestamp.from(since));
    }

    // --------------------------------------------------------- 수동 새로고침 기준
    public Instant refreshRequestedAt(String scope) {
        List<Timestamp> rows = jdbc.query(
                "SELECT requested_at FROM refresh_requests WHERE scope = ?",
                (rs, rowNum) -> rs.getTimestamp("requested_at"),
                scope);
        return rows.isEmpty() ? null : toInstant(rows.get(0));
    }

    private String writeJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 직렬화 실패", e);
        }
    }

    private static Instant toInstant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    /** 시계열 1점. */
    public record TimeseriesPoint(LocalDate date, Double value) {
    }

    /**
     * 13F 저장본의 보유 한 줄({@link #readQuarterHoldings}). 보유가 없는 분기는 cusip·ticker·value·shares가 모두 null인 한 줄입니다.
     *
     * @param quarterIndex 저장본의 분기 순서(0 = 첫 항목, 보통 최신)
     */
    public record HoldingRow(int quarterIndex, String filingDate, String reportDate, String filerCik, String cusip,
                             String ticker, Double value, Double shares) {
    }

    /**
     * 시계열 하나의 열 묶음({@link #readTimeseriesColumns}). 두 배열은 길이가 같고 날짜 오름차순이며, 날짜는
     * epoch day({@code LocalDate.ofEpochDay(epochDays[i])}로 되돌림)입니다. 배열은 읽기 전용으로 씁니다.
     */
    public record TimeseriesColumns(int[] epochDays, double[] values) {
        public TimeseriesColumns {
            if (epochDays.length != values.length) {
                throw new IllegalArgumentException(
                        "날짜와 값의 개수가 다릅니다: " + epochDays.length + " ≠ " + values.length);
            }
        }

        public int size() {
            return epochDays.length;
        }
    }

    /** 상한까지 읽은 관측 레코드. {@code truncated}면 조건에 맞는 더 오래된 행이 남아 있습니다 (QA-133). */
    public record ObservationPage(List<JsonNode> rows, boolean truncated) {
    }
}
