package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.SearchExcludeStore;
import com.macrodash.store.SearchWatchStore;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.net.IDN;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 정보 검색의 관심 대상과 매체 제외 목록(ADR 0041 결정 6·9, 계약 docs/specs/2026-11-14-info-search-contract.md §6-4).
 *
 * <p>관심 대상: 로그인한 사용자마다 자기 목록. 등록은 수집기의 대상 풀기({@code /live/search/entity})로 이름·종류·별칭(대상의 것만, 12개까지)·식별자를
 * 채워 <b>대표 키</b>로 저장합니다(같은 대상을 다른 키로 등록해도 한 줄). 상한은 회원 10·운영자 50, 서버 전체 서로 다른 대표 키 100이고, 이미 누군가
 * 모으는 대상은 서버 상한을 늘리지 않습니다(알림 관심 종목 QA-062와 같은 해석). 세기부터 저장까지는 한 잠금 안에서(QA-092와 같은 방식) — 대상
 * 풀기(외부 호출일 수 있음)는 잠금 밖에서 합니다. 데모 열람은 쓰지 못하고(사용자 FK가 없는 음수 번호), 읽기 방식 store_only도 등록하지 못하며(결정 2),
 * 덜 풀린 대상(풀기 응답의 일시 오류)은 저장하지 않습니다. 남의 줄은 404입니다. 새 글 수는 수집기가 모은
 * 글 표를 읽기만 하고, 회원에게는 운영자 전용 저장본(수집 글·거장 견해·속보)에서 온 글을 세지 않습니다.
 *
 * <p>매체 제외: 목록은 수집기의 처음 값(코드 상수)과 운영자가 더한 표의 줄을 함께 보이고, 더하기·지우기는 운영자만(경로 등급 + 여기서 한 번 더).
 * 도메인은 소문자 호스트로 맞춥니다(경로·포트·공백은 거절). 대조는 수집기가 합니다.
 *
 * <p>관심 대상·모은 글·제외 목록은 모의 매매의 입력이 아닙니다. 대상 키·별칭은 로그에 남기지 않습니다(결정 12).
 */
@Service
public class SearchWatchService {

    static final int MEMBER_WATCHES = 10;
    static final int OWNER_WATCHES = 50;
    static final int SERVER_WATCHES = 100;
    static final int MAX_ALIASES = 12;
    static final int MAX_NAME = 200;
    static final int MAX_ALIAS = 100;
    static final int MAX_EXCLUDE_NAME = 80;
    static final int MAX_NOTE = 200;
    static final int MAX_HOST = 253;
    /** 수집기 정기 수집 스위치({@code politeEnabled})를 다시 묻는 간격 — 서버 설정이라 자주 바뀌지 않습니다. 묻지 못했으면 {@link #COLLECTING_RETRY} 뒤. */
    static final Duration COLLECTING_TTL = Duration.ofMinutes(10);
    static final Duration COLLECTING_RETRY = Duration.ofMinutes(1);

    static final Set<String> KINDS = Set.of("company", "institution", "person", "topic");
    static final Set<String> EXCLUDE_KINDS = Set.of("domain", "name");
    /**
     * 대상 풀기 응답 {@code errors}의 출처 가운데 다시 물으면 달라질 것 — {@code entity}(풀기 시간 초과로 저장본 이름만), {@code wikidata}·{@code sec}(일시 실패).
     * {@code dart}(DART 고유번호 저장본에 그 종목이 없음)는 다시 물어도 같아서 넣지 않습니다.
     */
    static final Set<String> RETRY_ERRORS = Set.of("entity", "wikidata", "sec");
    private static final List<String> ID_FIELDS = List.of("ticker", "market", "stockCode", "cik", "dartCorpCode", "wikidata", "lei");
    private static final String TOPIC = "topic:";
    private static final Pattern CONTROL = Pattern.compile("\\p{Cntrl}");
    private static final Pattern HOST_LABEL = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?");
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx");

    static final String NOT_READY = "관심 대상 표가 아직 없습니다 — 수집기가 스키마를 적용한 뒤(make up) 다시 보세요.";
    static final String EXCLUDES_NOT_READY = "매체 제외 표가 아직 없습니다 — 수집기가 스키마를 적용한 뒤(make up) 다시 보세요.";

    /** 결과 — {@code status}는 HTTP 상태, {@code body}는 응답 본문. */
    public record Result(int status, Map<String, Object> body) {
    }

    /** 수집기가 풀어 준 대상(또는 주제 키에서 만든 것). {@code partial}은 다시 물으면 달라질 출처 오류가 섞인 풀기({@link #RETRY_ERRORS}). */
    private record Resolved(String key, String kind, String name, List<String> aliases, JsonNode ids, boolean partial) {
    }

    private record Collecting(Boolean value, Instant until) {
    }

    private final SearchWatchStore watches;
    private final SearchExcludeStore excludes;
    private final StoreReader store;
    private final CollectorClient collector;
    private final Clock clock;
    /**
     * 상한 검사(세기)부터 저장까지를 한 줄로 세우는 잠금 — 세기와 저장이 따로 도는 문장이라, 동시에 들어온 요청이 모두 저장 전 값을 보고 상한을 넘을 수
     * 있습니다(알림 규칙 QA-092와 같은 문제). 백엔드가 한 프로세스라는 전제입니다(ADR 0012). 여러 대로 늘리면 저장소 안에서 트랜잭션과
     * {@code pg_advisory_xact_lock}으로 바꿔야 합니다.
     */
    private final Object capLock = new Object();
    private volatile Collecting collecting;

    @Autowired
    public SearchWatchService(SearchWatchStore watches, SearchExcludeStore excludes, StoreReader store, CollectorClient collector) {
        this(watches, excludes, store, collector, Clock.systemUTC());
    }

    SearchWatchService(SearchWatchStore watches, SearchExcludeStore excludes, StoreReader store, CollectorClient collector, Clock clock) {
        this.watches = watches;
        this.excludes = excludes;
        this.store = store;
        this.collector = collector;
        this.clock = clock;
    }

    static int limit(CurrentUser user) {
        return user != null && user.isOwner() ? OWNER_WATCHES : MEMBER_WATCHES;
    }

    // ------------------------------------------------------------------ 관심 대상

    /**
     * 내 관심 대상 — {@code {available, items:[{id, key, kind, name, createdAt, lastSeenAt, newCount}], limits:{mine, max, serverUsed, serverMax},
     * collecting}}. 읽기만 합니다(데모도 부름 — 빈 목록). 표가 없으면 {@code {available:false, message}}.
     */
    public Map<String, Object> list(CurrentUser user) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!watches.ready()) {
            out.put("available", false);
            out.put("message", NOT_READY);
            return out;
        }
        long userId = user == null ? -1 : user.id();
        List<SearchWatchStore.Watch> rows = user == null ? List.of() : watches.watches(userId);
        Map<Long, Integer> counts = rows.isEmpty() ? Map.of()
                : watches.newCounts(userId, SearchService.owner(user) ? List.of() : List.copyOf(SearchService.OWNER_ONLY_SOURCES));
        List<Map<String, Object>> items = new ArrayList<>();
        for (SearchWatchStore.Watch row : rows) {
            items.add(itemJson(row, counts.getOrDefault(row.id(), 0)));
        }
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("mine", rows.size());
        limits.put("max", limit(user));
        limits.put("serverUsed", watches.countKeys());
        limits.put("serverMax", SERVER_WATCHES);
        out.put("available", true);
        out.put("items", items);
        out.put("limits", limits);
        out.put("collecting", collecting());
        return out;
    }

    /**
     * 등록 — {@code key}를 검사하고(틀리면 400) 수집기로 풀어 대표 키로 저장합니다. 데모·store_only는 403, 이미 있으면(다른 키로 등록한 같은 대상도)
     * 그대로 200({@code created:false}), 상한을 넘으면 409({@code reason} user_limit·server_limit), 대상을 풀지 못하면 409(unresolved),
     * 수집기에 닿지 못하면 503(주제 키는 키의 글로 등록), 풀기가 덜 끝났으면 503(partial — 저장하지 않음).
     *
     * @throws InvalidRequestException 키 모양이 틀림(400)
     */
    public Result add(CurrentUser user, String rawKey) {
        if (user == null || user.demo()) {
            return failure(403, null, "데모 열람에서는 관심 대상을 등록할 수 없습니다.");
        }
        // 저장본만 읽는 모드는 외부를 부르지 않으므로 대상을 제대로 풀 수 없어 등록하지 않습니다(ADR 0041 결정 2·D-1). 지우기·봤음은 됩니다.
        if (store.readMode() == AppProperties.ReadMode.STORE_ONLY) {
            return failure(403, "store_only", "저장본만 읽는 모드(store_only)에서는 관심 대상을 등록할 수 없습니다.");
        }
        String key = SearchService.entityKey(rawKey);
        if (!watches.ready()) {
            return failure(503, null, NOT_READY);
        }
        Optional<SearchWatchStore.Watch> existing = watches.find(user.id(), key);
        if (existing.isPresent()) {
            return registered(user, existing.get(), false);
        }
        // 상한에 닿았어도 같은 대상을 다른 키로 이미 등록했을 수 있어(wd:… → 대표 키 us:…) 주제가 아닌 키는 풀어서 대표 키로 한 번 더 찾습니다.
        // 주제 키는 대표 키가 그 키 자체라 바로 409. 저장 직전에 잠금 안에서 한 번 더 셉니다.
        boolean full = watches.countForUser(user.id()) >= limit(user);
        if (full && key.startsWith(TOPIC)) {
            return userLimit(user);
        }
        Optional<JsonNode> answer = collector.liveSearchEntity(key, SearchService.external(user, store), SearchService.owner(user));
        Resolved resolved = resolve(key, answer);
        if (resolved == null) {
            if (full) {
                return userLimit(user);
            }
            return answer.isEmpty()
                    ? failure(503, null, "수집기에서 응답을 받지 못해 대상을 풀지 못했습니다. 잠시 뒤 다시 등록하세요.")
                    : failure(409, "unresolved", "이 대상의 이름·식별자를 찾지 못해 등록하지 못했습니다. 검색에서 대상을 연 뒤 다시 등록하세요.");
        }
        synchronized (capLock) {
            Optional<SearchWatchStore.Watch> same = watches.find(user.id(), resolved.key());
            if (same.isPresent()) {
                return registered(user, same.get(), false);
            }
            if (watches.countForUser(user.id()) >= limit(user)) {
                return userLimit(user);
            }
            if (!watches.watchedByAnyone(resolved.key()) && watches.countKeys() >= SERVER_WATCHES) {
                return failure(409, "server_limit", "서버 전체 관심 대상이 %d개(서로 다른 대상)로 찼습니다 — 이미 누군가 등록한 대상만 더할 수 있습니다."
                        .formatted(SERVER_WATCHES));
            }
            // 덜 풀린 대상(시간 초과·Wikidata·SEC 일시 실패)의 이름·별칭은 저장하면 고쳐지지 않고 정기 수집의 검색식이 되므로 받지 않습니다.
            // 수집기는 실패가 섞인 풀기를 60초만 캐시해서 잠시 뒤 다시 누르면 새로 풉니다.
            if (resolved.partial()) {
                return failure(503, "partial", "대상 정보를 다 받지 못했습니다(일부 출처가 늦거나 실패함) — 1분쯤 뒤 다시 등록하세요.");
            }
            SearchWatchStore.Watch row = watches.insert(user.id(), resolved.key(), resolved.kind(), resolved.name(), resolved.aliases(),
                    resolved.ids(), clock.instant());
            return registered(user, row, true);
        }
    }

    /** 내 줄 지우기 — 남의 줄·없는 줄은 404. */
    public Result delete(CurrentUser user, long id) {
        if (user == null || user.demo()) {
            return failure(403, null, "데모 열람에서는 관심 대상을 바꿀 수 없습니다.");
        }
        if (!watches.ready()) {
            return failure(503, null, NOT_READY);
        }
        if (watches.delete(id, user.id()) != 1) {
            return failure(404, null, "없는 관심 대상입니다.");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("message", "관심 대상에서 지웠습니다.");
        return new Result(200, body);
    }

    /** 그 대상을 지금 봤다고 적음({@code last_seen_at = 지금}) — 새 글 수가 0이 됩니다. 남의 줄·없는 줄은 404. */
    public Result seen(CurrentUser user, long id) {
        if (user == null || user.demo()) {
            return failure(403, null, "데모 열람에서는 관심 대상을 바꿀 수 없습니다.");
        }
        if (!watches.ready()) {
            return failure(503, null, NOT_READY);
        }
        Optional<Instant> at = watches.markSeen(id, user.id(), clock.instant());
        if (at.isEmpty()) {
            return failure(404, null, "없는 관심 대상입니다.");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("message", "봤음으로 적었습니다.");
        body.put("lastSeenAt", iso(at.get()));
        return new Result(200, body);
    }

    /**
     * 수집기의 대상 풀기 응답에서 저장할 값을 고릅니다. 대표 키가 문법에 맞지 않으면 물은 키, 모르는 종류는 키 모양으로(wd:는 알 수 없어 null —
     * 등록하지 않음), 이름이 없으면 키의 값, 별칭은 문자열만·빈 것과 겹친 것 없이 12개까지(없으면 이름 하나), 식별자는 객체일 때만(아니면 null —
     * 표에는 빈 객체), {@code errors}에 다시 물으면 달라질 출처({@link #RETRY_ERRORS})가 있으면 partial. 대상이 없으면 주제 키만 키의 글로 만들고 그 밖은 null.
     */
    private Resolved resolve(String key, Optional<JsonNode> answer) {
        JsonNode entity = answer.map(body -> body.get("entity")).filter(JsonNode::isObject).orElse(null);
        if (entity == null) {
            if (!key.startsWith(TOPIC)) {
                return null;
            }
            String text = key.substring(TOPIC.length());
            ObjectNode ids = JsonNodeFactory.instance.objectNode();
            ID_FIELDS.forEach(ids::putNull);
            return new Resolved(key, "topic", text, List.of(text), ids, false);
        }
        String representative = key;
        String given = text(entity, "key");
        if (given != null) {
            try {
                representative = SearchService.entityKey(given);
            } catch (InvalidRequestException e) {
                representative = key;
            }
        }
        String kind = text(entity, "kind");
        if (kind == null || !KINDS.contains(kind)) {
            kind = kindOfKey(representative);
            if (kind == null) {
                return null;            // wd: 키의 종류를 모르면 지어내지 않고 등록하지 않습니다(표의 kind는 비울 수 없음)
            }
        }
        String name = text(entity, "name");
        name = name == null || name.isBlank() ? representative.substring(representative.indexOf(':') + 1) : cut(name.strip(), MAX_NAME);
        Set<String> aliases = new LinkedHashSet<>();
        JsonNode givenAliases = entity.get("aliases");
        if (givenAliases != null && givenAliases.isArray()) {
            for (JsonNode alias : givenAliases) {
                if (aliases.size() >= MAX_ALIASES) {
                    break;
                }
                if (alias.isString() && !alias.stringValue().isBlank() && !CONTROL.matcher(alias.stringValue()).find()) {
                    aliases.add(cut(alias.stringValue().strip(), MAX_ALIAS));
                }
            }
        }
        if (aliases.isEmpty()) {
            aliases.add(name);
        }
        JsonNode ids = entity.get("ids");
        JsonNode errors = answer.map(body -> body.get("errors")).filter(JsonNode::isObject).orElse(null);
        boolean partial = errors != null && RETRY_ERRORS.stream().anyMatch(errors::has);
        return new Resolved(representative, kind, name, List.copyOf(aliases), ids != null && ids.isObject() ? ids.deepCopy() : null, partial);
    }

    /** 키 모양이 정하는 종류(계약 §2) — 상장사 us:·kr:는 회사, cik:는 13F 기관, topic:은 주제. wd:는 키만으로 알 수 없어 null. */
    static String kindOfKey(String key) {
        if (key.startsWith("us:") || key.startsWith("kr:")) {
            return "company";
        }
        if (key.startsWith("cik:")) {
            return "institution";
        }
        return key.startsWith(TOPIC) ? "topic" : null;
    }

    private Result registered(CurrentUser user, SearchWatchStore.Watch row, boolean created) {
        int fresh = 0;
        if (!created) {
            fresh = watches.newCounts(user.id(), SearchService.owner(user) ? List.of() : List.copyOf(SearchService.OWNER_ONLY_SOURCES))
                    .getOrDefault(row.id(), 0);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("created", created);
        body.put("message", created ? "관심 대상에 더했습니다." : "이미 관심 대상에 있습니다.");
        body.put("item", itemJson(row, fresh));
        return new Result(200, body);
    }

    private Result userLimit(CurrentUser user) {
        return failure(409, "user_limit", "관심 대상은 %d개까지 등록할 수 있습니다 — 다른 대상을 지운 뒤 다시 등록하세요.".formatted(limit(user)));
    }

    private Map<String, Object> itemJson(SearchWatchStore.Watch row, int newCount) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", row.id());
        item.put("key", row.entityKey());
        item.put("kind", row.kind());
        item.put("name", row.name());
        item.put("createdAt", iso(row.createdAt()));
        item.put("lastSeenAt", iso(row.lastSeenAt()));
        item.put("newCount", newCount);
        return item;
    }

    /**
     * 서버 정기 수집이 켜진 곳인지(수집기 {@code POLITE_FETCH_ENABLED} — {@code /live/search/excludes}가 함께 답하는 {@code politeEnabled}. {@code /status}에도
     * 같은 칸이 있지만 그쪽은 실행 통계를 DB에서 모아 무겁습니다) — 칸이 없거나 묻지 못하면 null.
     */
    private Boolean collecting() {
        Instant now = clock.instant();
        Collecting cached = collecting;
        if (cached != null && now.isBefore(cached.until())) {
            return cached.value();
        }
        Boolean value = collector.liveSearchExcludes().map(answer -> answer.get("politeEnabled"))
                .filter(JsonNode::isBoolean).map(JsonNode::booleanValue).orElse(null);
        collecting = new Collecting(value, now.plus(value == null ? COLLECTING_RETRY : COLLECTING_TTL));
        return value;
    }

    // ------------------------------------------------------------------ 매체 제외

    /**
     * 제외 목록 — {@code {available, seed:[{kind, value, group}], added:[{id, kind, value, note, createdAt}]}}. 수집기에 닿지 못하면 seed는 null,
     * 표가 없으면 added는 null이고 그때 {@code available:false}와 사유.
     */
    public Map<String, Object> excludes() {
        JsonNode seed = collector.liveSearchExcludes().map(body -> body.get("seed")).filter(JsonNode::isArray).orElse(null);
        List<Map<String, Object>> added = null;
        if (excludes.ready()) {
            added = new ArrayList<>();
            for (SearchExcludeStore.Exclude row : excludes.all()) {
                added.add(excludeJson(row));
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", seed != null && added != null);
        if (seed == null) {
            out.put("message", "수집기에서 처음 목록을 받지 못했습니다.");
        } else if (added == null) {
            out.put("message", EXCLUDES_NOT_READY);
        }
        out.put("seed", seed);
        out.put("added", added);
        return out;
    }

    /**
     * 제외 매체 더하기(운영자만) — 종류 domain·name, 도메인은 소문자 호스트로 맞추고 이름은 1~80자. 이미 있으면(대소문자 무시) 그대로 200.
     *
     * @throws InvalidRequestException 종류·값·메모가 틀림(400)
     */
    public Result addExclude(CurrentUser user, String kind, String value, String note) {
        if (user == null || !user.isOwner()) {
            return failure(403, null, "제외 매체는 운영자만 바꿀 수 있습니다.");
        }
        if (kind == null || !EXCLUDE_KINDS.contains(kind)) {
            throw new InvalidRequestException("kind는 domain·name 중 하나입니다.");
        }
        String clean = "domain".equals(kind) ? host(value) : excludeName(value);
        String memo = note == null || note.isBlank() ? null : note.strip();
        if (memo != null && (memo.codePointCount(0, memo.length()) > MAX_NOTE || CONTROL.matcher(memo).find())) {
            throw new InvalidRequestException("메모는 제어 글자 없이 " + MAX_NOTE + "자까지입니다.");
        }
        if (!excludes.ready()) {
            return failure(503, null, EXCLUDES_NOT_READY);
        }
        Optional<SearchExcludeStore.Exclude> inserted = excludes.insert(kind, clean, memo);
        Optional<SearchExcludeStore.Exclude> row = inserted.isPresent() ? inserted : excludes.find(kind, clean);
        if (row.isEmpty()) {
            return failure(409, null, "같은 매체가 동시에 지워졌습니다 — 다시 더하세요.");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("created", inserted.isPresent());
        body.put("message", inserted.isPresent() ? "제외 매체에 더했습니다. 정보 검색·관심 대상 수집에서 이 매체의 글을 뺍니다." : "이미 제외 매체에 있습니다.");
        body.put("item", excludeJson(row.get()));
        return new Result(200, body);
    }

    /** 제외 매체 지우기(운영자만) — 없는 번호는 404. 처음 값(코드 상수)은 지울 수 없습니다. */
    public Result deleteExclude(CurrentUser user, long id) {
        if (user == null || !user.isOwner()) {
            return failure(403, null, "제외 매체는 운영자만 바꿀 수 있습니다.");
        }
        if (!excludes.ready()) {
            return failure(503, null, EXCLUDES_NOT_READY);
        }
        if (excludes.delete(id) != 1) {
            return failure(404, null, "없는 제외 매체입니다.");
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", true);
        body.put("message", "제외 매체에서 지웠습니다.");
        return new Result(200, body);
    }

    /**
     * 도메인 → 소문자 호스트. 앞의 {@code http://}·{@code https://}·{@code www.}와 끝의 '/'·'.'은 지우고(수집기 normalize_domain과 같게 —
     * 대조는 점 경계라 www 줄은 따로 둘 까닭이 없음), 국제화 도메인은 ASCII(punycode)로 바꿉니다.
     * 경로·인자·포트·사용자·공백, 253자 넘음, 점이 없는 이름, 규칙에 맞지 않는 이름표는 400.
     */
    static String host(String value) {
        String text = value == null ? "" : value.strip();
        if (text.isEmpty() || text.codePoints().anyMatch(Character::isWhitespace) || CONTROL.matcher(text).find()) {
            throw new InvalidRequestException("도메인을 공백 없이 입력하세요(예: example.com).");
        }
        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.startsWith("https://")) {
            text = text.substring("https://".length());
        } else if (lower.startsWith("http://")) {
            text = text.substring("http://".length());
        }
        if (text.endsWith("/")) {
            text = text.substring(0, text.length() - 1);
        }
        if (text.chars().anyMatch(c -> c == '/' || c == '?' || c == '#' || c == ':' || c == '@' || c == '\\')) {
            throw new InvalidRequestException("도메인만 입력하세요 — 경로·인자·포트는 받지 않습니다(예: example.com).");
        }
        if (text.endsWith(".")) {
            text = text.substring(0, text.length() - 1);
        }
        text = text.toLowerCase(Locale.ROOT);
        if (text.startsWith("www.")) {
            text = text.substring("www.".length());
        }
        String ascii;
        try {
            ascii = IDN.toASCII(text, IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            throw new InvalidRequestException("도메인 형식이 올바르지 않습니다(예: example.com).");
        }
        String[] labels = ascii.split("\\.", -1);
        if (ascii.length() > MAX_HOST || labels.length < 2) {
            throw new InvalidRequestException("도메인 형식이 올바르지 않습니다(예: example.com, " + MAX_HOST + "자까지).");
        }
        for (String label : labels) {
            if (!HOST_LABEL.matcher(label).matches()) {
                throw new InvalidRequestException("도메인 형식이 올바르지 않습니다(예: example.com).");
            }
        }
        return ascii;
    }

    /** 매체 이름 — 앞뒤 공백을 지운 1~80자, 제어 글자 없음(대소문자는 그대로 — 대조는 대소문자 무시). */
    static String excludeName(String value) {
        String text = value == null ? "" : value.strip();
        int length = text.codePointCount(0, text.length());
        if (length < 1 || length > MAX_EXCLUDE_NAME || CONTROL.matcher(text).find()) {
            throw new InvalidRequestException("매체 이름은 제어 글자 없이 1~" + MAX_EXCLUDE_NAME + "자입니다.");
        }
        return text;
    }

    private static Map<String, Object> excludeJson(SearchExcludeStore.Exclude row) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", row.id());
        item.put("kind", row.kind());
        item.put("value", row.value());
        item.put("note", row.note());
        item.put("createdAt", iso(row.createdAt()));
        return item;
    }

    // ------------------------------------------------------------------ 공통

    private static Result failure(int status, String reason, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        if (reason != null) {
            body.put("reason", reason);
        }
        body.put("message", message);
        return new Result(status, body);
    }

    /** 계약의 시각 모양(UTC ISO, 초까지, {@code +00:00}). 없으면 null. */
    static String iso(Instant at) {
        return at == null ? null : OffsetDateTime.ofInstant(at, ZoneOffset.UTC).format(ISO);
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        return value != null && value.isString() ? value.stringValue() : null;
    }

    private static String cut(String text, int max) {
        return text.codePointCount(0, text.length()) <= max ? text : text.substring(0, text.offsetByCodePoints(0, max));
    }
}
