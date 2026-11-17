package com.macrodash.feature.search;

import com.macrodash.collector.CollectorClient;
import com.macrodash.feature.info.InfoTranslator;
import com.macrodash.read.StoreReader;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 정보 검색 본문 보기(ADR 0043, 계약 docs/specs/2026-11-14-info-search-contract.md §10) — 운영자가 결과 줄의 '본문 보기'를 누르면 수집기
 * {@code /live/search/article}에 그 줄의 꼬리표({@code ref})를 넘겨, 운영 서버가 그 글 한 건을 받아 본문만 추린 것을 중계합니다. 화면은 주소를 보내지
 * 않습니다(수집기가 자기 결과의 주소만 받음 — SSRF).
 *
 * <ul>
 *   <li><b>운영자만</b>: 경로 등급은 {@code AccessPolicy}의 운영자이고 여기서 한 번 더 막습니다(403). 회원 결과에서는 꼬리표를 지웁니다
 *       ({@link SearchService} — 닫힌 실패). 저작권·비용 — 번역·AI 요약과 같은 결정.</li>
 *   <li><b>외부를 부르지 않는 모드</b>(데모·{@code STORE_ONLY}): 수집기에 {@code start=false}(받아 둔 것만) — 없으면 사유 {@code offline}.</li>
 *   <li><b>사용자 한 시간 한도</b>: 지난 1시간에 수집기가 새로 줄에 넣은 것({@code queued:true})이 {@value #PER_HOUR}번이면 {@code start=false}로 부르고,
 *       받아 둔 것이 없으면 사유 {@code user_limit}과 남은 분. 자리 잡기·정산은 Finviz 한도({@link SearchService})와 같은 모양(예외가 나도 자리를 돌려줌,
 *       백엔드 한 프로세스의 메모리라 재기동하면 비워짐 — 수집기의 하루 예산·대기열 상한은 그대로).</li>
 *   <li><b>번역</b>({@link #translate}): 수집기 캐시만 읽고({@code start=false}) 본문과 제목 모두 {@link InfoTranslator#bodyUnsaved}(저장하지 않음 —
 *       메모리 24시간, 하루 글자 상한은 함께 셈). 제목은 결과 줄 제목이 아니라 받은 쪽에서 추린 제목(og:title·h1 등)이라 본문처럼 표에 두지 않습니다.
 *       같은 글을 번역하는 중이면 429.</li>
 * </ul>
 *
 * <p>꼬리표·주소·제목·본문은 로그에 남기지 않습니다(사유 코드·건수만). 본문은 모의 매매의 입력이 아니고 AI 요약에도 들어가지 않습니다.
 */
@Service
public class SearchArticleService {

    private static final Logger log = LoggerFactory.getLogger(SearchArticleService.class);

    /** 한 운영자가 한 시간에 새로 받게 할 수 있는 글 수(계약 §10-5). */
    static final int PER_HOUR = 10;
    static final Duration WINDOW = Duration.ofHours(1);
    /** 같은 글을 번역하는 중일 때 다시 누를 때까지. */
    static final Duration TRANSLATE_BUSY_RETRY = Duration.ofSeconds(15);
    static final Pattern REF = Pattern.compile("[0-9a-f]{32}");
    /** 수집기 응답의 '이 요청이 새로 줄에 넣었는지' 칸 — 셈에만 쓰고 화면에 넘기지 않습니다. */
    static final String QUEUED = "queued";
    static final String OFFLINE = "외부를 부르지 않는 읽기 방식이라 받아 둔 본문만 봅니다 — 원문 열기로 보세요.";
    static final String NO_ARTICLE = "받아 둔 본문이 없습니다 — 본문 보기를 다시 눌러 주세요.";

    private final CollectorClient collector;
    private final StoreReader store;
    private final InfoTranslator translator;
    private final Clock clock;
    /** 사용자 번호 → 지난 {@link #WINDOW} 안에 수집기가 새로 줄에 넣은 시각(수집기에 가 있는 요청이 잡은 자리 포함). */
    private final Map<Long, List<Instant>> started = new ConcurrentHashMap<>();
    /** 지금 번역하는 꼬리표 — 같은 글을 두 번 사지 않게. */
    private final Set<String> translating = ConcurrentHashMap.newKeySet();

    @Autowired
    public SearchArticleService(CollectorClient collector, StoreReader store, InfoTranslator translator) {
        this(collector, store, translator, Clock.systemUTC());
    }

    SearchArticleService(CollectorClient collector, StoreReader store, InfoTranslator translator, Clock clock) {
        this.collector = collector;
        this.store = store;
        this.translator = translator;
        this.clock = clock;
    }

    /**
     * 본문 보기 한 번 — 처음이면 수집기가 줄에 넣고 {@code pending}, 화면이 같은 경로를 다시 불러 결과를 받습니다.
     *
     * @return 수집기 응답에서 {@code queued}를 뺀 것 + {@code available:true}. 닿지 못하면 {@code {available:false, message}}
     * @throws InvalidRequestException 꼬리표 모양이 틀림(400)
     * @throws ResponseStatusException 운영자가 아님(403)
     */
    public Map<String, Object> article(String ref, CurrentUser user) {
        requireOwner(user);
        String checked = ref(ref);
        boolean external = SearchService.external(user, store);
        Instant now = clock.instant();
        boolean reserved = external && reserve(user.id(), now);
        boolean queued = false;
        try {
            Optional<JsonNode> payload = collector.liveSearchArticle(checked, reserved);
            if (payload == null || payload.isEmpty() || !payload.get().isObject()) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("available", false);
                out.put("message", SearchService.NO_RESPONSE);
                return out;
            }
            ObjectNode body = (ObjectNode) payload.get().deepCopy();
            body.remove("available");
            JsonNode flag = body.remove(QUEUED);
            queued = flag != null && flag.isBoolean() && flag.booleanValue();
            if (!reserved && "not_cached".equals(text(body, "reason"))) {
                if (!external) {
                    body.put("reason", "offline");
                    body.put("message", OFFLINE);
                    body.put("retryable", false);
                    body.putNull("retryAfterSeconds");
                } else {
                    long minutes = minutesUntilSlot(user.id(), now);
                    body.put("reason", "user_limit");
                    body.put("message", "한 시간에 새로 받을 수 있는 " + PER_HOUR + "건을 다 썼습니다 — 약 " + minutes + "분 뒤 다시 누르세요.");
                    body.put("retryable", true);
                    body.put("retryAfterSeconds", minutes * 60);
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("available", true);
            for (Map.Entry<String, JsonNode> field : body.properties()) {
                out.put(field.getKey(), field.getValue());
            }
            return out;
        } finally {
            settle(user, reserved, queued, now);
        }
    }

    /**
     * 받아 둔 본문(수집기 캐시 — 외부를 부르지 않음)을 한국어로 — 응답 모양은 {@code /api/info/translate}와 같음.
     *
     * @return {@code {ok, titleKo, textKo, alreadyKorean, cached, truncated, model, models, error}}
     * @throws InvalidRequestException  꼬리표 모양이 틀림(400)
     * @throws ResponseStatusException  운영자가 아님(403)
     * @throws TooManyRequestsException 같은 글을 번역하는 중(429)
     */
    public Map<String, Object> translate(String ref, CurrentUser user) {
        requireOwner(user);
        String checked = ref(ref);
        if (!translating.add(checked)) {
            throw new TooManyRequestsException("같은 글을 번역하는 중입니다 — 잠시 뒤 다시 누르세요.", TRANSLATE_BUSY_RETRY);
        }
        try {
            Optional<JsonNode> payload = collector.liveSearchArticle(checked, false);
            JsonNode article = payload == null ? null : payload.filter(JsonNode::isObject)
                    .filter(body -> "ok".equals(text(body, "status")))
                    .map(body -> body.get("article")).filter(JsonNode::isObject).orElse(null);
            if (article == null) {
                return failed(NO_ARTICLE);
            }
            List<String> paragraphs = new ArrayList<>();
            article.path("paragraphs").forEach(node -> {
                if (node.isString() && !node.asString().isBlank()) {
                    paragraphs.add(node.asString());
                }
            });
            String text = String.join("\n\n", paragraphs);
            if (text.isBlank()) {
                return failed(NO_ARTICLE);
            }
            // 받은 쪽에서 추린 제목도 본문처럼 저장하지 않는 길로 — 지금 제목 번역 길(titles)은 번역 표에 오래 남깁니다.
            String title = text(article, "title");
            String error = null;
            String titleKo = null;
            String titleModel = null;
            List<String> models = new ArrayList<>();
            if (title != null && !title.isBlank() && title.length() <= 500 && InfoTranslator.needsTranslation(title)) {
                InfoTranslator.UnsavedBody titled = translator.bodyUnsaved(title);
                titleKo = titled.ok() ? titled.textKo() : null;
                error = titled.ok() ? null : titled.error();
                titleModel = titled.model();
                if (titleKo != null) {
                    models.addAll(titled.models());
                }
            }
            InfoTranslator.UnsavedBody body = translator.bodyUnsaved(text);
            if (!body.ok()) {
                error = body.error();
            }
            body.models().stream().filter(model -> !models.contains(model)).forEach(models::add);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", error == null);
            out.put("titleKo", titleKo);
            out.put("textKo", body.textKo());
            out.put("alreadyKorean", body.alreadyKorean());
            out.put("cached", body.cached());
            out.put("truncated", body.truncated());
            out.put("model", body.model() != null ? body.model() : titleModel);
            out.put("models", List.copyOf(models));
            out.put("error", error);
            log.info("정보 검색 본문 번역: {}(조각 캐시 {})", error == null ? "ok" : "실패", body.cached());
            return out;
        } finally {
            translating.remove(checked);
        }
    }

    // ------------------------------------------------------------------ 한도

    /** 이 요청이 수집기에 새로 받게 해도 되는지 — 검사와 자리 잡기를 한 번에(같은 사용자의 동시 요청이 함께 넘지 않게). */
    private boolean reserve(long userId, Instant now) {
        Instant cutoff = now.minus(WINDOW);
        boolean[] reserved = new boolean[1];
        started.compute(userId, (id, times) -> {
            List<Instant> kept = times == null ? new ArrayList<>() : times;
            kept.removeIf(at -> !at.isAfter(cutoff));
            if (kept.size() < PER_HOUR) {
                kept.add(now);
                reserved[0] = true;
            }
            return kept.isEmpty() ? null : kept;
        });
        return reserved[0];
    }

    /** 자리를 잡았는데 새로 넣지 않았으면(캐시·받는 중·실패·닿지 못함) 돌려주고, 자리 없이 불렀는데 넣었다고 답하면(수집기 쪽 결함) 그래도 셉니다. */
    private void settle(CurrentUser user, boolean reserved, boolean queued, Instant at) {
        if (user == null || reserved == queued) {
            return;
        }
        if (reserved) {
            started.computeIfPresent(user.id(), (id, times) -> {
                times.remove(at);
                return times.isEmpty() ? null : times;
            });
            return;
        }
        log.warn("정보 검색 본문 보기: start=false로 불렀는데 수집기가 새로 줄에 넣었다고 답했습니다");
        started.compute(user.id(), (id, times) -> {
            List<Instant> kept = times == null ? new ArrayList<>() : times;
            kept.add(at);
            return kept;
        });
    }

    /** 가장 오래된 기록이 창을 벗어날 때까지 남은 분(올림, 1 이상). */
    private long minutesUntilSlot(long userId, Instant now) {
        List<Instant> times = started.get(userId);
        Instant oldest = times == null ? null : times.stream().min(Instant::compareTo).orElse(null);
        if (oldest == null) {
            return 1;
        }
        long seconds = Duration.between(now, oldest.plus(WINDOW)).toSeconds();
        return Math.max(1, (seconds + 59) / 60);
    }

    // ------------------------------------------------------------------ 보조

    /** 운영자만 — 데모 열람은 역할과 상관없이 막습니다(데모의 POST는 데모 쓰기 금지 규칙이 먼저 막지만 한 번 더). */
    private static void requireOwner(CurrentUser user) {
        if (!SearchService.owner(user) || user.demo()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "본문 보기는 운영자만 쓸 수 있습니다.");
        }
    }

    /** 꼬리표(32자 소문자 16진) — 아니면 400. */
    static String ref(String ref) {
        if (ref == null || !REF.matcher(ref).matches()) {
            throw new InvalidRequestException("ref는 32자 소문자 16진입니다.");
        }
        return ref;
    }

    private static Map<String, Object> failed(String error) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("titleKo", null);
        out.put("textKo", null);
        out.put("alreadyKorean", false);
        out.put("cached", false);
        out.put("truncated", false);
        out.put("model", null);
        out.put("models", List.of());
        out.put("error", error);
        return out;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        return value == null || value.isNull() ? null : value.asString();
    }
}
