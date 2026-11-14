package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;

/**
 * 정보 검색의 관심 대상(ADR 0041 결정 9, V37) — 백엔드가 쓰는 표 {@code search_watches}(사용자·대표 키마다 한 줄)와, 수집기가 모은 글 표
 * {@code search_watch_items}의 <b>읽기</b>(새 글 수·화제 건수). 글 표는 수집기 소유라 쓰는 메서드를 두지 않습니다(ADR 0008). 수집기는 {@code search_watches}를
 * 읽기만 합니다({@code paper_settings} 선례).
 *
 * <p>알림함 연결(계약 §9-5, V38): 줄마다 {@code notify}(기본 꺼짐)와 {@code notified_at}(그 줄로 마지막 알림을 만든 시각). 수집기는 이 두 칸을 읽지도 쓰지도
 * 않습니다. V38이 아직 없으면 두 칸을 꺼짐·null로 읽고({@link #notifyReady()}가 거짓), 알림 켜기와 정기 작업은 일하지 않습니다.
 *
 * <p>관심 대상·모은 글은 모의 매매의 입력이 아닙니다({@code ArchitectureRulesTest} — feature.paper가 이 저장소를 쓰지 않음).
 */
@Repository
public class SearchWatchStore {

    /**
     * 관심 대상 한 줄.
     *
     * @param kind       company·institution·person·topic
     * @param aliases    수집기가 검색식·대조에 쓰는 별칭(등록 때 대상 풀기의 것, 사용자가 고칠 수 있음 — 계약 §9-4)
     * @param ids        대상 풀기의 식별자 객체(없었으면 빈 객체)
     * @param lastSeenAt 화면이 그 대상의 타임라인을 마지막으로 연 시각 — 새 글 수의 기준
     * @param notifyEnabled 새 글을 알림함으로 받는가(V38, 기본 꺼짐 — V38 전에는 늘 거짓)
     * @param notifiedAt 그 줄로 마지막 알림을 만든 시각(없으면 null) — 켤 때 그 시각으로 둠
     */
    public record Watch(long id, long userId, String entityKey, String kind, String name, List<String> aliases, JsonNode ids,
                       Instant createdAt, Instant lastSeenAt, boolean notifyEnabled, Instant notifiedAt) {

        /** 알림 칸 없이(꺼짐) — V37 모양. */
        public Watch(long id, long userId, String entityKey, String kind, String name, List<String> aliases, JsonNode ids,
                     Instant createdAt, Instant lastSeenAt) {
            this(id, userId, entityKey, kind, name, aliases, ids, createdAt, lastSeenAt, false, null);
        }
    }

    /**
     * 알림을 만들 줄 하나(계약 §9-5) — {@link #notifyCandidates}가 돌려줍니다.
     *
     * @param fresh      알릴 새 글 수(1 이상)
     * @param titles     그 가운데 최근(작성 시각, 모르면 처음 받은 시각) 제목 {@link #NOTIFY_TITLES}개까지
     * @param notifiedAt 후보를 읽을 때의 알린 시각(없으면 null) — {@link #markNotified}가 이 값과 같을 때만 고칩니다
     */
    public record NotifyCandidate(long watchId, long userId, String entityKey, String name, int fresh, List<String> titles, Instant notifiedAt) {
    }

    /**
     * 화제 판정(계약 §9-2)에 쓰는 한 대상의 건수. 글은 처음 받은 시각으로 나누고, 받을 때 작성 시각이 이미 {@link SearchWatchStore#HOT_FRESH}보다 지난 글(등록 직후 첫
     * 수집이 넣은 2년치·늦게 찾은 옛 글)은 어느 쪽에도 세지 않습니다 — 세면 새로 등록한 대상이 하루 동안 모두 '화제'가 되고, 그 뒤 30일은 평균이 부풀어
     * 화제가 거의 뜨지 않습니다. 작성 시각은 날짜만 아는 줄({@link SearchWatchStore#DATE_SOURCES}, 접수 시각 없이 미국 동부 00:00으로 넣은 {@code sec} 줄)이면
     * 그 날의 끝, 모르면 처음 받은 시각입니다.
     *
     * @param lastDay     지난 {@link SearchWatchStore#HOT_WINDOW}(지금까지)에 처음 받은 글 수
     * @param earlier     그 앞 {@link SearchWatchStore#HOT_BASELINE}(지금의 31일 전 초과 ~ 24시간 전 이하)에 처음 받았고, 작성 시각이 그 대표 키를 서버에서
     *                    처음 등록한 때(지금 남은 줄 가운데 가장 이른 등록) 뒤인 글 수 — {@code earlierDays}와 같은 기간을 셉니다(첫 수집이 넣은 등록 전 글,
     *                    먼저 등록한 사람이 지운 뒤 남은 그 앞의 글은 빼)
     * @param earlierDays 그 30일 가운데 이 대상을 모은 날 수(0~30, 소수) — 그 대표 키가 서버에서 처음 등록된 때(누가 등록했든)부터 셉니다
     */
    public record Buzz(int lastDay, int earlier, double earlierDays) {

        /** 앞 30일의 하루 평균 — 모은 날이 하루 미만이면 모름(null, 0으로 채우지 않음). */
        public Double dailyAverage() {
            return earlierDays >= HOT_MIN_BASELINE_DAYS ? earlier / earlierDays : null;
        }

        /**
         * 화제인가 — 지난 24시간 {@link SearchWatchStore#HOT_MIN_ITEMS}건 이상이고 앞 30일 하루 평균의 {@link SearchWatchStore#HOT_RATIO}배 이상(평균 0이면 5건부터).
         * 5건 미만은 평균과 상관없이 아님, 5건 이상인데 평균을 모르면 null.
         */
        public Boolean hot() {
            if (lastDay < HOT_MIN_ITEMS) {
                return false;
            }
            Double average = dailyAverage();
            return average == null ? null : lastDay >= HOT_RATIO * average;
        }
    }

    /** 새 글로 세는 작성 시각의 여유 — 마지막으로 본 때의 이만큼 전부터 나온 글(늦게 잡힌 어제 기사는 셈, 첫 수집의 옛 글은 세지 않음). */
    public static final Duration NEW_ITEM_LOOKBACK = Duration.ofHours(24);
    /** 화제의 '지난 24시간'. */
    public static final Duration HOT_WINDOW = Duration.ofHours(24);
    /** 화제의 비교 기간 — {@link #HOT_WINDOW} 앞의 30일. */
    public static final Duration HOT_BASELINE = Duration.ofDays(30);
    /** 화제 건수에 넣는 글 — 처음 받을 때 작성 시각(모르면 처음 받은 시각)이 이만큼 안이었던 글. */
    public static final Duration HOT_FRESH = Duration.ofHours(24);
    public static final int HOT_MIN_ITEMS = 5;
    public static final int HOT_RATIO = 3;
    /** 앞 30일 평균을 믿는 최소 모은 날 수 — 그보다 짧으면 평균을 모름. */
    public static final double HOT_MIN_BASELINE_DAYS = 1.0;
    /**
     * 날짜만 아는 출처(수집기 {@code services/search_filings.DATE_SOURCES}와 같음 — {@code SearchWatchServiceTest}가 대조). 이 줄의 작성 시각은 그 출처 달력의
     * 그 날 00:00이라, 화제에서는 {@link #DATE_DAY}를 더한 그 날의 끝을 작성 시각으로 봅니다(저녁 공시를 다음 날 처음 받아도 '받을 때 하루 넘게 지난 글'이 아님).
     */
    public static final Set<String> DATE_SOURCES = Set.of("sec_fts", "dart", "naver_research");
    /** 날짜만 아는 줄의 하루. */
    static final Duration DATE_DAY = Duration.ofHours(24);
    /**
     * 화제의 작성 시각 식 — 날짜만 아는 줄은 그 날의 끝, 접수 시각 없이 접수일(미국 동부 00:00:00)로 넣은 {@code sec} 줄도 같음(수집기
     * {@code search_filings.stored_basis}), 작성 시각을 모르면 처음 받은 시각.
     */
    private static final String WRITTEN = "COALESCE(i.published_at + CASE WHEN i.source IN ("
            + String.join(", ", DATE_SOURCES.stream().sorted().map(source -> "'" + source + "'").toList()) + ")"
            + " OR (i.source = 'sec' AND i.published_at = date_trunc('day', i.published_at AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')"
            + " THEN INTERVAL '" + DATE_DAY.toHours() + " hours' ELSE INTERVAL '0 hours' END, i.first_seen_at)";
    private static final double DAY_MILLIS = Duration.ofDays(1).toMillis();
    private static final String COLUMNS = "id, user_id, entity_key, kind, name, aliases::text AS aliases, ids::text AS ids, created_at, last_seen_at";
    /** V38의 알림 칸 — 아직 없으면 꺼짐·null로 읽습니다. */
    private static final String NOTIFY_COLUMNS = ", notify, notified_at";
    private static final String NO_NOTIFY_COLUMNS = ", false AS notify, NULL::timestamptz AS notified_at";
    /** 알림 본문에 싣는 최근 제목 수(계약 §9-5). */
    public static final int NOTIFY_TITLES = 3;
    /**
     * 새 글 규칙(계약 §6-4) — 관심 대상 줄 {@code w}와 모은 글 {@code i}의 조건. 마지막으로 본 뒤(없으면 등록 뒤) 처음 받았고, 작성 시각(모르면 처음 받은 시각)이
     * 그때의 {@link #NEW_ITEM_LOOKBACK} 전과 등록 시각 가운데 늦은 것보다 늦은 글. 새 글 수({@link #newCounts})와 알림({@link #notifyCandidates})이 같은 글을 씁니다.
     */
    private static final String NEW_ITEM = "i.entity_key = w.entity_key AND i.first_seen_at > COALESCE(w.last_seen_at, w.created_at)"
            + " AND COALESCE(i.published_at, i.first_seen_at) > GREATEST(COALESCE(w.last_seen_at, w.created_at) - INTERVAL '"
            + NEW_ITEM_LOOKBACK.toHours() + " hours', w.created_at)";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;
    private final TransactionTemplate transactions;

    public SearchWatchStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
        // 시험의 메모리 흉내는 DB 없이 만듭니다(그때는 트랜잭션을 쓰지 않음).
        this.transactions = jdbc == null ? null : new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /** 두 표가 다 있는가 — 수집기가 V37을 적용하기 전에는 '준비 중'. */
    public boolean ready() {
        return schema.tableExists("search_watches") && schema.tableExists("search_watch_items");
    }

    /** V38(알림 칸 {@code notify}·{@code notified_at}과 등록 때의 이름 {@code name_ko}·{@code name_en})까지 있는가 — 없으면 알림 켜기·정기 알림 작업은 일하지 않습니다. */
    public boolean notifyReady() {
        return ready() && schema.columnExists("search_watches", "notify") && schema.columnExists("search_watches", "notified_at")
                && schema.columnExists("search_watches", "name_ko") && schema.columnExists("search_watches", "name_en");
    }

    /**
     * 쓰기 여러 개를 한 트랜잭션으로 묶습니다 — 안에서 예외가 나면 모두 되돌리고 그 예외를 그대로 던집니다. 같은 DataSource를 쓰는 다른 저장소(알림함
     * {@code AlertStore})의 쓰기도 이 스레드의 같은 연결에 합류합니다({@code UserStore.atomically}와 같은 방식).
     */
    public <T> T atomically(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    private String columns() {
        return COLUMNS + (notifyReady() ? NOTIFY_COLUMNS : NO_NOTIFY_COLUMNS);
    }

    /** 내 관심 대상(등록한 순서). */
    public List<Watch> watches(long userId) {
        return jdbc.query("SELECT " + columns() + " FROM search_watches WHERE user_id = ? ORDER BY created_at, id", mapper(), userId);
    }

    public Optional<Watch> find(long userId, String entityKey) {
        return jdbc.query("SELECT " + columns() + " FROM search_watches WHERE user_id = ? AND entity_key = ?", mapper(), userId, entityKey)
                .stream().findFirst();
    }

    /**
     * 그 사용자의 줄 가운데 식별자 {@code ids.wikidata}가 {@code qid}인 것(등록한 순서) — 결과 경로가 {@code wd:} 키로 연 대상의 별칭을 대표 키로 등록한 줄에서
     * 찾을 때 씁니다(계약 §9-4). 사용자마다 줄이 많아야 50이라 사용자 색인으로 좁힌 뒤 거릅니다.
     */
    public List<Watch> findByWikidata(long userId, String qid) {
        return jdbc.query("SELECT " + columns() + " FROM search_watches WHERE user_id = ? AND ids->>'wikidata' = ? ORDER BY created_at, id",
                mapper(), userId, qid);
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
        return insert(userId, entityKey, kind, name, null, null, aliases, ids, at);
    }

    /**
     * 줄 하나 넣기(이미 있으면 그대로) — {@code nameKo}·{@code nameEn}은 등록 때 대상 풀기가 준 이름(V38 {@code name_ko}·{@code name_en}, 없으면 null).
     * 수집기 정기 수집이 이 두 칸으로 검색어의 이름을 정해, 별칭 편집(계약 §9-4)으로 바뀐 별칭 앞자리에서 이름을 짐작하지 않습니다. V38 전이면 넣지 않습니다.
     */
    public Watch insert(long userId, String entityKey, String kind, String name, String nameKo, String nameEn, List<String> aliases,
                        JsonNode ids, Instant at) {
        Timestamp stamp = Timestamp.from(at);
        String aliasJson = mapper.writeValueAsString(aliases == null ? List.of() : aliases);
        String idsJson = ids == null || ids.isNull() ? "{}" : mapper.writeValueAsString(ids);
        if (notifyReady()) {
            jdbc.update("INSERT INTO search_watches (user_id, entity_key, kind, name, name_ko, name_en, aliases, ids, created_at, last_seen_at) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?) ON CONFLICT DO NOTHING",
                    userId, entityKey, kind, name, nameKo, nameEn, aliasJson, idsJson, stamp, stamp);
        } else {
            jdbc.update("INSERT INTO search_watches (user_id, entity_key, kind, name, aliases, ids, created_at, last_seen_at) "
                            + "VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?) ON CONFLICT DO NOTHING",
                    userId, entityKey, kind, name, aliasJson, idsJson, stamp, stamp);
        }
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
     * 내 줄의 별칭·알림을 한 문장으로 바꿈(계약 §9-4·9-5) — 바꾼 줄(남의 줄·없는 줄은 빈 값). {@code aliases}·{@code notify}가 null이면 그 칸은 그대로이고,
     * 이름은 바꾸지 않습니다. 알림을 꺼짐에서 켬으로 바꾸면 {@code notified_at}을 {@code at}으로 둡니다 — 켠 뒤에 처음 받은 글부터 알림(화면의 새 글 수로 이미
     * 본 글을 켜자마자 다시 알리지 않게). 이미 켜져 있거나 끌 때는 그대로입니다. 알림 칸을 바꾸려면 V38이 있어야 합니다({@link #notifyReady()}).
     */
    public Optional<Watch> patch(long id, long userId, List<String> aliases, Boolean notify, Instant at) {
        List<String> sets = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (aliases != null) {
            sets.add("aliases = ?::jsonb");
            args.add(mapper.writeValueAsString(aliases));
        }
        if (notify != null) {
            // SET의 오른쪽은 바꾸기 전 값을 봅니다(NOT notify = 지금 꺼져 있음).
            sets.add("notified_at = CASE WHEN ? AND NOT notify THEN ? ELSE notified_at END");
            args.add(notify);
            args.add(Timestamp.from(at));
            sets.add("notify = ?");
            args.add(notify);
        }
        if (sets.isEmpty()) {
            return jdbc.query("SELECT " + columns() + " FROM search_watches WHERE id = ? AND user_id = ?", mapper(), id, userId).stream().findFirst();
        }
        args.add(id);
        args.add(userId);
        return jdbc.query("UPDATE search_watches SET " + String.join(", ", sets) + " WHERE id = ? AND user_id = ? RETURNING " + columns(),
                mapper(), args.toArray()).stream().findFirst();
    }

    /**
     * 알림을 만들 줄(계약 §9-5) — 알림을 켠 줄마다 새 글({@link #NEW_ITEM} — 새 글 수와 같은 규칙) 가운데 {@code notified_at} 뒤에(없으면 조건 없음) 처음 받았고
     * {@code since} 뒤 {@code now} 이하에 처음 받은 글이 한 건 이상인 줄. 운영자가 아닌 사용자의 줄은 {@code memberHidden} 출처(운영자 전용 저장본)의 글을 세지
     * 않습니다({@link #newCounts}와 같음 — 운영자는 {@code users.role = 'OWNER'}, {@code CurrentUser.isOwner()}와 같은 규칙). 지금 뒤에 처음 받은 글(시계
     * 어긋남)은 다음 실행에 넘깁니다 — 이번 알림 시각보다 늦어 다시 세어지기 때문입니다.
     */
    public List<NotifyCandidate> notifyCandidates(List<String> memberHidden, Instant since, Instant now) {
        String sql = "SELECT w.id, w.user_id, w.entity_key, w.name, w.notified_at, c.fresh, c.titles FROM search_watches w "
                + "JOIN users u ON u.id = w.user_id "
                + "CROSS JOIN LATERAL (SELECT COUNT(*) AS fresh, (array_agg(i.title ORDER BY COALESCE(i.published_at, i.first_seen_at) DESC,"
                + " i.first_seen_at DESC, i.item_id))[1:" + NOTIFY_TITLES + "] AS titles FROM search_watch_items i"
                + " WHERE " + NEW_ITEM
                + " AND (w.notified_at IS NULL OR i.first_seen_at > w.notified_at)"
                + " AND i.first_seen_at > ? AND i.first_seen_at <= ?"
                + " AND (u.role = 'OWNER' OR i.source <> ALL (?))) c "
                + "WHERE w.notify AND c.fresh > 0 ORDER BY w.id";
        List<String> hidden = memberHidden == null ? List.of() : memberHidden;
        return jdbc.query(connection -> {
            PreparedStatement statement = connection.prepareStatement(sql);
            statement.setTimestamp(1, Timestamp.from(since));
            statement.setTimestamp(2, Timestamp.from(now));
            statement.setArray(3, connection.createArrayOf("text", hidden.toArray(new String[0])));
            return statement;
        }, (rs, rowNum) -> new NotifyCandidate(rs.getLong("id"), rs.getLong("user_id"), rs.getString("entity_key"), rs.getString("name"),
                rs.getInt("fresh"), texts(rs.getArray("titles")), UserStore.instant(rs.getTimestamp("notified_at"))));
    }

    /**
     * 그 줄로 알림을 만들었다고 적음({@code notified_at = at}) — 알림이 아직 켜져 있고, {@code notified_at}이 후보를 읽을 때의 값({@code expected})과 같고
     * {@code at}보다 이를 때만(비교 후 설정). 그 사이 끄거나 지운 줄, 다른 실행이 먼저 알린 줄, 껐다 다시 켠 줄(켠 시각부터 다시 셈), 같은 시각에 이미 적은 줄은
     * 거짓이라 같은 글로 두 번 알리지 않습니다 — 백엔드가 여럿이어도 같습니다. 알림함 쓰기와 한 트랜잭션({@link #atomically})에서 먼저 불러 그 줄을 잠급니다.
     */
    public boolean markNotified(long id, Instant expected, Instant at) {
        Timestamp stamp = Timestamp.from(at);
        if (expected == null) {
            return jdbc.update("UPDATE search_watches SET notified_at = ? WHERE id = ? AND notify AND notified_at IS NULL", stamp, id) == 1;
        }
        Timestamp read = Timestamp.from(expected);
        return jdbc.update("UPDATE search_watches SET notified_at = ? WHERE id = ? AND notify AND notified_at = ? AND notified_at < ?",
                stamp, id, read, stamp) == 1;
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
                + "LEFT JOIN search_watch_items i ON " + NEW_ITEM
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

    /**
     * 내 관심 대상마다 화제 건수({@link Buzz}) — 수집기 글 표에서 그 대표 키의 글을 {@code now} 기준 지난 24시간과 그 앞 30일로 나눠 셉니다(둘 다 처음 받은
     * 시각, 지금 뒤는 빼고, 받을 때 작성 시각이 {@link #HOT_FRESH}보다 지난 글은 빼고). 모은 날 수는 그 대표 키를 서버에서 처음 등록한 시각부터이고, 앞 30일
     * 건수도 그 뒤에 쓰인 글만 셉니다(분자와 분모가 같은 기간). {@code hiddenSources}를 주면(회원) 그 출처의 글은 세지 않습니다({@link #newCounts}와 같음).
     * 글이 없는 대상도 한 줄(0건).
     */
    public Map<Long, Buzz> buzz(long userId, List<String> hiddenSources, Instant now) {
        boolean hide = hiddenSources != null && !hiddenSources.isEmpty();
        Instant dayStart = now.minus(HOT_WINDOW);
        Instant baselineStart = dayStart.minus(HOT_BASELINE);
        // 결과를 바꾸지 않는 하한 — 세는 글은 모두 작성 시각(날짜 줄은 그 날 00:00)이 비교 기간 시작의 HOT_FRESH + 하루 전보다 늦습니다. 이 조건이 있어야
        // 작성 시각 색인(search_watch_items_recent·search_watch_items_time)으로 약 32일 범위만 훑습니다(first_seen_at에는 색인이 없음).
        Instant indexFloor = baselineStart.minus(HOT_FRESH).minus(DATE_DAY);
        String sql = "WITH mine AS (SELECT id, entity_key FROM search_watches WHERE user_id = ?), "
                + "starts AS (SELECT entity_key, MIN(created_at) AS since FROM search_watches "
                + "WHERE entity_key IN (SELECT entity_key FROM mine) GROUP BY entity_key) "
                + "SELECT m.id, s.since, COUNT(i.item_id) FILTER (WHERE i.first_seen_at > ?) AS last_day, "
                + "COUNT(i.item_id) FILTER (WHERE i.first_seen_at <= ? AND " + WRITTEN + " >= s.since) AS earlier "
                + "FROM mine m JOIN starts s ON s.entity_key = m.entity_key "
                + "LEFT JOIN search_watch_items i ON i.entity_key = m.entity_key AND i.first_seen_at > ? AND i.first_seen_at <= ?"
                + " AND COALESCE(i.published_at, i.first_seen_at) > ?"
                + " AND " + WRITTEN + " > i.first_seen_at - INTERVAL '" + HOT_FRESH.toHours() + " hours'"
                + (hide ? " AND i.source <> ALL (?)" : "")
                + " GROUP BY m.id, s.since ORDER BY m.id";
        Map<Long, Buzz> out = new LinkedHashMap<>();
        jdbc.query(connection -> {
            PreparedStatement statement = connection.prepareStatement(sql);
            int index = 1;
            statement.setLong(index++, userId);
            statement.setTimestamp(index++, Timestamp.from(dayStart));
            statement.setTimestamp(index++, Timestamp.from(dayStart));
            statement.setTimestamp(index++, Timestamp.from(baselineStart));
            statement.setTimestamp(index++, Timestamp.from(now));
            statement.setTimestamp(index++, Timestamp.from(indexFloor));
            if (hide) {
                statement.setArray(index, connection.createArrayOf("text", hiddenSources.toArray(new String[0])));
            }
            return statement;
        }, rs -> {
            Instant since = UserStore.instant(rs.getTimestamp("since"));
            // 처음 등록 시각을 모르면 모은 날도 모름(0일 — 평균 모름).
            double days = since == null ? 0
                    : Math.max(0, Duration.between(since.isBefore(baselineStart) ? baselineStart : since, dayStart).toMillis() / DAY_MILLIS);
            out.put(rs.getLong("id"), new Buzz(rs.getInt("last_day"), rs.getInt("earlier"), days));
        });
        return out;
    }

    private RowMapper<Watch> mapper() {
        return (rs, rowNum) -> new Watch(rs.getLong("id"), rs.getLong("user_id"), rs.getString("entity_key"), rs.getString("kind"),
                rs.getString("name"), aliases(rs.getString("aliases")), json(rs.getString("ids")),
                UserStore.instant(rs.getTimestamp("created_at")), UserStore.instant(rs.getTimestamp("last_seen_at")),
                rs.getBoolean("notify"), UserStore.instant(rs.getTimestamp("notified_at")));
    }

    private static List<String> texts(Array array) throws java.sql.SQLException {
        List<String> out = new ArrayList<>();
        if (array == null) {
            return out;
        }
        for (Object value : (Object[]) array.getArray()) {
            if (value instanceof String text) {
                out.add(text);
            }
        }
        return out;
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
