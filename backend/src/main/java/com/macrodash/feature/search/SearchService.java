package com.macrodash.feature.search;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * 정보 검색(ADR 0041, 계약 docs/specs/2026-11-14-info-search-contract.md §3) — 수집기 {@code /live/search/*}의 중계.
 *
 * <p>하는 일은 넷입니다. ① 입력 검사(검색어 1~60자, 대상 키 문법, 탭 — 틀리면 400, 수집기를 부르지 않음 — 수집기의 400은 빈 값이 되어 사유가
 * 사라지므로 여기서 먼저 막습니다). ② 데모 열람·읽기 모드 {@code store_only}면 {@code external=false}(수집기가 외부를 부르지 않고 저장본·캐시만),
 * 운영자면 {@code owner=true}. ③ 글·논평 탭은 운영자만(403). ④ 회원에게 가는 결과에서 운영자 전용 줄(수집 글·거장 견해·속보)을 한 번 더 지움
 * (수집기에 owner=false를 보냈어도 — 이중 방어). 2년 자르기·중국어 제목·매체 거름은 수집기가 원본이라 다시 구현하지 않습니다.
 *
 * <p>검색어와 대상 키는 로그에 남기지 않습니다(결정 12). 정보 검색 자료는 모의 매매의 입력이 아닙니다.
 */
@Service
public class SearchService {

    private static final Logger log = LoggerFactory.getLogger(SearchService.class);

    static final int MAX_QUERY = 60;
    static final String NO_RESPONSE = "수집기에서 응답을 받지 못했습니다.";
    static final Set<String> TABS = Set.of("timeline", "news", "posts", "filings", "research");
    static final String DEFAULT_TAB = "timeline";
    /** 운영자 전용 저장본에서 온 줄의 출처(수집 글 info_items · 거장 견해 · 속보) — 회원에게는 지웁니다(결정 2). */
    static final Set<String> OWNER_ONLY_SOURCES = Set.of("info", "guru", "wire");
    static final String OWNER_ONLY = "owner_only";

    /** 대상 키(계약 §2) — 티커는 영문 대문자·숫자·'.'·'-', 종목코드 6자리·CIK 10자리 숫자, Wikidata는 Q+숫자. */
    // 수집기(search.py _KEY_PATTERNS)와 같은 문법 — 어긋나면 수집기의 400이 '응답을 받지 못함'으로 바뀝니다.
    private static final Pattern US_KEY = Pattern.compile("us:[A-Z0-9.\\-]{1,15}");
    private static final Pattern KR_KEY = Pattern.compile("kr:[0-9]{6}");
    private static final Pattern CIK_KEY = Pattern.compile("cik:[0-9]{10}");
    private static final Pattern WD_KEY = Pattern.compile("wd:Q[1-9][0-9]{0,11}");
    /** 제어 글자(수집기가 400으로 막는 것과 같음). */
    private static final Pattern CONTROL = Pattern.compile("\\p{Cntrl}");
    private static final Pattern SPACES = Pattern.compile("(?U)\\s+");
    private static final String TOPIC = "topic:";

    /** '지금 새로 받기'(feed?refresh=1)의 사용자당 간격(계약 §6-4) — 출처 캐시를 건너뛰어 외부 호출이 늘기 때문입니다. */
    static final Duration REFRESH_INTERVAL = Duration.ofMinutes(10);

    private final StoreReader store;
    private final CollectorClient collector;
    private final Clock clock;
    /**
     * 사용자 번호 → 마지막으로 새로 받은 시각. 백엔드 한 프로세스의 메모리라 재기동하면 비워집니다(그래도 한 번 더 받을 뿐 — 출처 캐시와 수집기의
     * 거부 래치는 그대로). 크기는 사용자 수만큼입니다.
     */
    private final Map<Long, Instant> lastRefresh = new ConcurrentHashMap<>();

    @Autowired
    public SearchService(StoreReader store, CollectorClient collector) {
        this(store, collector, Clock.systemUTC());
    }

    SearchService(StoreReader store, CollectorClient collector, Clock clock) {
        this.store = store;
        this.collector = collector;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ 경로

    /** 치는 동안의 후보(계약 §3-1) — 수집기가 이미 가진 색인만. */
    public Map<String, Object> suggest(String q, CurrentUser user) {
        String text = query(q);
        boolean owner = owner(user);
        boolean external = external(user);
        return relay(() -> collector.liveSearchSuggest(text, external, owner), null);
    }

    /** Enter의 후보(계약 §3-2) — 로컬 + Wikidata, 맨 끝에 주제 하나. */
    public Map<String, Object> resolve(String q, CurrentUser user) {
        String text = query(q);
        boolean owner = owner(user);
        boolean external = external(user);
        return relay(() -> collector.liveSearchResolve(text, external, owner), null);
    }

    /** 대상 풀기(계약 §3-3). */
    public Map<String, Object> entity(String e, CurrentUser user) {
        String key = entityKey(e);
        boolean owner = owner(user);
        boolean external = external(user);
        return relay(() -> collector.liveSearchEntity(key, external, owner), null);
    }

    /** 결과(계약 §3-4) — 새로 받기 없이. */
    public Map<String, Object> feed(String e, String tab, CurrentUser user) {
        return feed(e, tab, false, user);
    }

    /**
     * 결과(계약 §3-4) — 2년 묶음 한 번에. 글·논평 탭은 운영자만이고, 회원에게는 운영자 전용 줄을 지웁니다.
     *
     * <p>{@code refresh}(계약 §6-4 '지금 새로 받기')는 사용자마다 {@link #REFRESH_INTERVAL}에 한 번만 수집기에 넘기고, 넘으면 캐시 그대로 부르며
     * 응답의 {@code refreshNote}에 안내 한 줄을 둡니다(새로 받았으면 null). 외부를 부르지 않는 모드(데모·store_only)는 새로 받지 않고 한도도 쓰지
     * 않습니다. {@code refresh}를 묻지 않으면 그 칸이 없습니다.
     *
     * @throws InvalidRequestException 대상 키·탭이 틀림(400)
     * @throws ResponseStatusException 회원이 글·논평 탭을 부름(403)
     */
    public Map<String, Object> feed(String e, String tab, boolean refresh, CurrentUser user) {
        String key = entityKey(e);
        String which = tab(tab);
        boolean owner = owner(user);
        if ("posts".equals(which) && !owner) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "글·논평 탭은 운영자만 볼 수 있습니다.");
        }
        boolean external = external(user);
        Instant now = clock.instant();
        String refused = refresh ? refreshRefusal(user, external, now) : null;
        boolean applied = refresh && refused == null;
        Map<String, Object> out = relay(() -> applied ? collector.liveSearchFeed(key, which, external, owner, true)
                : collector.liveSearchFeed(key, which, external, owner), owner ? null : body -> hideOwnerOnly(body, which));
        if (applied && !Boolean.TRUE.equals(out.get("available"))) {
            // 수집기에 닿지 못한 새로 받기는 한 번으로 세지 않습니다(그 사이 같은 사용자가 다시 받았으면 그 시각은 그대로).
            lastRefresh.remove(user.id(), now);
        }
        if (refresh) {
            out.put("refreshNote", refused);
        }
        return out;
    }

    /**
     * 첫 화면의 최근 글(계약 §6-4) — 수집기 저장본(새 피드 묶음, 운영자면 속보도)을 중계하고, 회원에게서는 운영자 전용 줄을 한 번 더 지웁니다.
     * 외부를 부르지 않으므로 데모·store_only도 같습니다.
     */
    public Map<String, Object> recent(CurrentUser user) {
        boolean owner = owner(user);
        return relay(() -> collector.liveSearchRecent(owner), owner ? null : body -> hideOwnerOnly(body, "recent"));
    }

    /**
     * 새로 받기를 거절할 사유 — 받아도 되면 null이고 그 사용자의 시각({@code now})을 적습니다(검사와 적기를 한 번에 — 같은 사용자의 동시 요청 둘이
     * 모두 통과하지 않게). 수집기에 닿지 못하면 {@link #feed}가 그 시각을 지웁니다.
     */
    private String refreshRefusal(CurrentUser user, boolean external, Instant now) {
        if (!external || user == null) {
            return "외부를 부르지 않는 모드(데모 열람·저장본만 읽기)라 새로 받지 않고 받아 둔 결과를 보입니다.";
        }
        Instant[] previous = new Instant[1];
        lastRefresh.compute(user.id(), (id, last) -> {
            if (last != null && now.isBefore(last.plus(REFRESH_INTERVAL))) {
                previous[0] = last;
                return last;
            }
            return now;
        });
        if (previous[0] == null) {
            return null;
        }
        long seconds = Duration.between(now, previous[0].plus(REFRESH_INTERVAL)).toSeconds();
        long minutes = Math.max(1, (seconds + 59) / 60);
        return "지금 새로 받기는 " + REFRESH_INTERVAL.toMinutes() + "분에 한 번입니다 — 약 " + minutes + "분 뒤에 다시 누르세요. 지금은 받아 둔 결과입니다.";
    }

    // ------------------------------------------------------------------ 입력 검사

    /**
     * 검색어 — 앞뒤 공백을 지운 뒤 1~60자. 글자 수는 코드 포인트로 셉니다(수집기 Python의 {@code len}과 같게).
     *
     * @throws InvalidRequestException 비었거나 너무 김(400)
     */
    static String query(String q) {
        String text = q == null ? "" : q.strip();
        if (text.isEmpty()) {
            throw new InvalidRequestException("검색어를 입력하세요.");
        }
        if (text.codePointCount(0, text.length()) > MAX_QUERY) {
            throw new InvalidRequestException("검색어는 " + MAX_QUERY + "자 이하로 입력하세요.");
        }
        if (CONTROL.matcher(text).find()) {
            throw new InvalidRequestException("검색어에 제어 글자를 쓸 수 없습니다.");
        }
        return text;
    }

    /**
     * 대상 키(계약 §2) — {@code us:<티커>} · {@code kr:<6자리>} · {@code cik:<10자리>} · {@code wd:Q<숫자>} · {@code topic:<1~60자>}.
     * 키 앞뒤 공백과 주제 글의 앞뒤 공백은 지우고, 주제 글 가운데의 이어진 공백은 하나로 줄입니다(수집기 {@code clean_query}와 같은 키 — 관심 대상
     * 등록·정기 수집·결과가 같은 키를 씀). 대소문자는 바꾸지 않습니다(그 밖은 400).
     *
     * @throws InvalidRequestException 모양이 틀림(400)
     */
    static String entityKey(String e) {
        String key = e == null ? "" : e.strip();
        if (key.startsWith(TOPIC)) {
            String raw = key.substring(TOPIC.length()).strip();
            if (CONTROL.matcher(raw).find()) {
                throw new InvalidRequestException("주제에 제어 글자를 쓸 수 없습니다.");
            }
            // 접은 뒤에 앞뒤를 지웁니다 — strip()은 U+00A0·U+2007·U+202F·U+0085를 공백으로 보지 않지만 (?U)\s는 봄(수집기 str.split과 같게).
            String text = SPACES.matcher(raw).replaceAll(" ").strip();
            int length = text.codePointCount(0, text.length());
            if (length < 1 || length > MAX_QUERY) {
                throw new InvalidRequestException("주제는 1~" + MAX_QUERY + "자입니다.");
            }
            return TOPIC + text;
        }
        if (US_KEY.matcher(key).matches() || KR_KEY.matcher(key).matches() || CIK_KEY.matcher(key).matches()
                || WD_KEY.matcher(key).matches()) {
            return key;
        }
        throw new InvalidRequestException("대상 키 형식이 올바르지 않습니다 (us:티커 · kr:종목코드 6자리 · cik:10자리 · wd:Q번호 · topic:글).");
    }

    /**
     * 탭 — 비면 타임라인.
     *
     * @throws InvalidRequestException 다섯 탭 밖(400)
     */
    static String tab(String tab) {
        String which = tab == null ? "" : tab.strip();
        if (which.isEmpty()) {
            return DEFAULT_TAB;
        }
        if (!TABS.contains(which)) {
            throw new InvalidRequestException("tab은 timeline·news·posts·filings·research 중 하나입니다.");
        }
        return which;
    }

    // ------------------------------------------------------------------ 사용자

    /** 운영자만 운영자 전용 줄을 받습니다. 사용자가 없으면(필터 밖) 운영자가 아닙니다. */
    static boolean owner(CurrentUser user) {
        return user != null && user.isOwner();
    }

    /** 데모 열람·store_only·사용자 없음이면 외부를 부르지 않습니다(결정 2). */
    private boolean external(CurrentUser user) {
        return external(user, store);
    }

    /** {@link #external(CurrentUser)}와 같은 규칙 — 관심 대상 등록의 대상 풀기({@code SearchWatchService})도 씁니다. */
    static boolean external(CurrentUser user, StoreReader store) {
        return user != null && !user.demo() && store.readMode() != AppProperties.ReadMode.STORE_ONLY;
    }

    // ------------------------------------------------------------------ 중계

    /** 수집기 응답(객체)에 {@code available:true}를 앞에 더합니다. 닿지 못했거나 객체가 아니면 {@code available:false}와 사유. */
    private Map<String, Object> relay(Supplier<Optional<JsonNode>> call, Consumer<ObjectNode> adjust) {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<JsonNode> payload = call.get();
        if (payload.isEmpty() || !payload.get().isObject()) {
            out.put("available", false);
            out.put("message", NO_RESPONSE);
            return out;
        }
        ObjectNode body = (ObjectNode) payload.get().deepCopy();
        body.remove("available");
        if (adjust != null) {
            adjust.accept(body);
        }
        out.put("available", true);
        for (Map.Entry<String, JsonNode> field : body.properties()) {
            out.put(field.getKey(), field.getValue());
        }
        return out;
    }

    /**
     * 회원에게 가는 결과에서 운영자 전용 줄을 지웁니다 — 줄은 빼고, 그 출처의 상태 줄은 {@code owner_only}·0건(거른 건수 0, 사유 없음),
     * 남은 줄의 원문 팝업 id({@code readerId} — 운영자 화면 전용)는 null. 지운 줄이 있으면 받은 건수({@code rangeCounts})에서도 뺍니다.
     * 출처를 알 수 없는 줄(객체가 아니거나 {@code source}가 없거나 글이 아님)도 운영자 전용인지 가릴 수 없어 지웁니다(닫힌 실패).
     * 출처 칸이 없는 상태 줄은 본문이 없으므로 그대로 둡니다.
     */
    private void hideOwnerOnly(ObjectNode body, String tab) {
        List<JsonNode> removed = new ArrayList<>();
        if (body.get("items") instanceof ArrayNode items) {
            ArrayNode kept = JsonNodeFactory.instance.arrayNode();
            for (JsonNode item : items) {
                String source = text(item, "source");
                if (source == null || OWNER_ONLY_SOURCES.contains(source)) {
                    removed.add(item);
                    continue;
                }
                if (item instanceof ObjectNode row && row.has("readerId")) {
                    row.putNull("readerId");
                }
                kept.add(item);
            }
            body.set("items", kept);
        }
        if (body.get("sources") instanceof ArrayNode sources) {
            for (JsonNode source : sources) {
                String name = text(source, "source");
                if (source instanceof ObjectNode row && name != null && OWNER_ONLY_SOURCES.contains(name)) {
                    row.put("status", OWNER_ONLY);
                    row.put("count", 0);
                    ObjectNode dropped = row.putObject("dropped");
                    dropped.put("old", 0).put("noTime", 0).put("chinese", 0).put("excluded", 0);
                    row.putNull("message");
                }
            }
        }
        if (!removed.isEmpty()) {
            // 수집기에 owner=false를 보냈는데도 운영자 전용 줄이나 출처를 모르는 줄이 왔음 — 수집기 쪽 결함이라 남깁니다(검색어·대상 키 없이 탭과 건수만).
            log.warn("정보 검색: 회원 응답에서 운영자 전용이거나 출처를 모르는 줄 {}건을 지웠습니다 (tab={})", removed.size(), tab);
            if (body.get("rangeCounts") instanceof ObjectNode counts) {
                subtractRangeCounts(counts, removed);
            }
        }
    }

    /**
     * 받은 건수에서 지운 줄을 뺍니다. 기간의 시작은 2년 창과 같은 방식(오늘(KST) − 기간의 날짜 00:00 KST)으로 봅니다. 숫자가 아닌 칸은 그대로,
     * 0 밑으로 내리지 않습니다. 결과에 남았던 줄은 모두 2년 안이므로 2년 칸에서는 늘 뺍니다.
     */
    private void subtractRangeCounts(ObjectNode counts, List<JsonNode> removed) {
        LocalDate today = Kst.today(clock);
        Map<String, Instant> starts = new LinkedHashMap<>();
        starts.put("7d", today.minusDays(7).atStartOfDay(Kst.ZONE).toInstant());
        starts.put("30d", today.minusDays(30).atStartOfDay(Kst.ZONE).toInstant());
        starts.put("1y", today.minusYears(1).atStartOfDay(Kst.ZONE).toInstant());
        starts.put("2y", null);
        for (Map.Entry<String, Instant> range : starts.entrySet()) {
            JsonNode value = counts.get(range.getKey());
            if (value == null || !value.isIntegralNumber() || !value.canConvertToInt()) {
                continue;
            }
            Instant start = range.getValue();
            int inside = 0;
            for (JsonNode item : removed) {
                Instant at = instant(text(item, "publishedAt"));
                if (start == null || (at != null && !at.isBefore(start))) {
                    inside++;
                }
            }
            counts.put(range.getKey(), Math.max(0, value.intValue() - inside));
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        return value != null && value.isString() ? value.stringValue() : null;
    }

    private static Instant instant(String iso) {
        if (iso == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(iso).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
