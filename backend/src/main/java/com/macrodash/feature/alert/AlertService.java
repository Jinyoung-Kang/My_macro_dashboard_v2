package com.macrodash.feature.alert;

import com.macrodash.feature.institution.Institutions;
import com.macrodash.store.AlertStore;
import com.macrodash.support.CurrentUser;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 알림 규칙과 화면 알림함(명세 C, D2: 화면 알림함만).
 *
 * <p>규칙 수 상한(D5 등급표): 무료 1개(국면 전환만) · 유료 20개 · 운영자 50개. 관심 종목 규칙은 사용자당 20종목,
 * 전체 60종목까지 — 종목별 수급 수집 범위(레이더 40종목 + 관심 종목)에 들어가야 알릴 수 있기 때문입니다
 * (범위를 넘으면 받아 두고 조용히 안 보내지 않고, 만들 때 거절합니다).
 */
@Service
public class AlertService {

    static final int FREE_RULES = 1;
    static final int PRO_RULES = 20;
    static final int OWNER_RULES = 50;
    static final int STOCKS_PER_USER = 20;
    static final int STOCKS_TOTAL = 60;
    static final int MIN_STREAK = 3;
    static final int MAX_STREAK = 20;
    static final Set<String> MARKETS = Set.of("KOSPI", "KOSDAQ");
    private static final Pattern STOCK_CODE = Pattern.compile("^\\d{6}$");
    private static final String FREE_TIER_ONLY_REGIME =
            "무료 등급은 국면 전환 알림만 쓸 수 있습니다. 다른 알림은 유료 등급에서 쓸 수 있습니다.";

    /** 결과 — {@code status}는 HTTP 상태. */
    public record Result(int status, String message) {
    }

    private final AlertStore alerts;
    private final ObjectMapper mapper;
    /**
     * 상한 검사(세기)부터 저장(만들기·켜기)까지를 한 줄로 세우는 잠금(QA-092). 세기와 저장이 따로 도는 문장이라, 동시에 들어온
     * 요청이 모두 저장 전 값을 보고 통과해 규칙 수·사용자 20종목·전체 60종목을 넘었습니다. 전체 60을 넘으면 수집기가 코드
     * 순으로 앞 60개만 받아, 먼저 규칙을 건 다른 사용자의 종목이 조용히 수집에서 빠집니다.
     *
     * <p>백엔드가 한 프로세스라는 전제입니다(로컬 compose·AWS EC2 한 대, ADR 0012). 여러 대로 늘리면 이 잠금으로는 막지
     * 못합니다 — 그때는 {@code AlertStore} 안에서 트랜잭션을 열고 {@code pg_advisory_xact_lock(고정 키)}을 건 뒤 세고 저장해야
     * 합니다(자동 커밋 문장 하나로 잠그면 문장이 끝날 때 풀려 소용없습니다).
     */
    private final Object ruleCapLock = new Object();

    public AlertService(AlertStore alerts, ObjectMapper mapper) {
        this.alerts = alerts;
        this.mapper = mapper;
    }

    public boolean ready() {
        return alerts.ready();
    }

    public List<Map<String, Object>> rules(CurrentUser user) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (AlertStore.Rule rule : alerts.rules(user.id())) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", rule.id());
            row.put("kind", rule.kind());
            row.put("params", rule.params());
            row.put("enabled", rule.enabled());
            row.put("createdAt", String.valueOf(rule.createdAt()));
            row.put("description", describe(rule.kind(), rule.params()));
            out.add(row);
        }
        return out;
    }

    public int ruleLimit(CurrentUser user) {
        return user.isOwner() ? OWNER_RULES : user.isPro() ? PRO_RULES : FREE_RULES;
    }

    /** 규칙 만들기 — 종류와 대상 검사, 등급별 상한. 상한 검사부터 저장까지 한 줄로(QA-092). */
    public Result create(CurrentUser user, String kind, JsonNode params) {
        synchronized (ruleCapLock) {
            return createLocked(user, kind, params);
        }
    }

    private Result createLocked(CurrentUser user, String kind, JsonNode params) {
        if (!user.isPro() && !"REGIME_CHANGE".equals(kind)) {
            return new Result(403, FREE_TIER_ONLY_REGIME);
        }
        if (alerts.countRules(user.id()) >= ruleLimit(user)) {
            return new Result(400, "알림 규칙은 %d개까지 만들 수 있습니다.".formatted(ruleLimit(user)));
        }
        ObjectNode clean = mapper.createObjectNode();
        switch (kind == null ? "" : kind) {
            case "REGIME_CHANGE" -> {
                // 대상 없음 — 국면은 하나입니다.
            }
            case "FOREIGN_STREAK" -> {
                String target = text(params, "target");
                int n = params == null ? 0 : params.path("n").asInt(0);
                if (n < MIN_STREAK || n > MAX_STREAK) {
                    return new Result(400, "연속 일수는 %d~%d일입니다.".formatted(MIN_STREAK, MAX_STREAK));
                }
                if ("STOCK".equals(target)) {
                    String code = text(params, "code");
                    if (code == null || !STOCK_CODE.matcher(code).matches()) {
                        return new Result(400, "종목코드는 6자리 숫자입니다(예: 005930).");
                    }
                    Result capped = stockCapProblem(user, code);
                    if (capped != null) {
                        return capped;
                    }
                    clean.put("code", code);
                } else if (target == null || !MARKETS.contains(target)) {
                    return new Result(400, "대상은 KOSPI·KOSDAQ 또는 종목(STOCK)입니다.");
                }
                clean.put("target", target);
                clean.put("n", n);
            }
            case "INSTITUTION_NEW" -> {
                String cik = text(params, "cik");
                if (cik == null || !Institutions.ciks().contains(cik)) {
                    return new Result(400, "추적하는 기관(12곳) 중에서 고르세요.");
                }
                clean.put("cik", cik);
            }
            default -> {
                return new Result(400, "알림 종류는 REGIME_CHANGE·FOREIGN_STREAK·INSTITUTION_NEW 중 하나입니다.");
            }
        }
        alerts.insertRule(user.id(), kind, clean);
        return new Result(200, "알림 규칙을 만들었습니다. 지금부터 생기는 사건만 알림함에 들어옵니다(과거 사건은 보내지 않음).");
    }

    /** 켜기·끄기. 켜기는 만들기와 같은 검사를 하므로 같은 잠금 안에서(QA-092 — 끄기는 수를 줄이기만 하지만 함께 둡니다). */
    public Result setEnabled(CurrentUser user, long ruleId, boolean enabled) {
        synchronized (ruleCapLock) {
            return setEnabledLocked(user, ruleId, enabled);
        }
    }

    private Result setEnabledLocked(CurrentUser user, long ruleId, boolean enabled) {
        if (enabled) {
            // 켤 때도 관심 종목 상한을 봅니다. 상한은 켜진 규칙만 세므로, 껐다 켜면 넘을 수 있었고 수집기는 앞쪽
            // 60종목만 받아 넘친 종목 규칙은 조용히 울리지 않았습니다(QA-041).
            AlertStore.Rule rule = alerts.rules(user.id()).stream()
                    .filter(candidate -> candidate.id() == ruleId).findFirst().orElse(null);
            // 켤 때도 만들 때와 같은 등급 검사를 합니다. 유료에서 무료로 내린 회원이 꺼 둔(또는 등급을 내릴 때 꺼진) 유료
            // 종류 규칙을 다시 켤 수 있었습니다(QA-091). 끄기는 등급과 무관합니다.
            if (rule != null && !user.isPro() && !"REGIME_CHANGE".equals(rule.kind())) {
                return new Result(403, FREE_TIER_ONLY_REGIME);
            }
            if (rule != null && !rule.enabled() && "FOREIGN_STREAK".equals(rule.kind())
                    && "STOCK".equals(rule.params().path("target").asText())) {
                Result capped = stockCapProblem(user, rule.params().path("code").asText());
                if (capped != null) {
                    return capped;
                }
            }
        }
        return alerts.setEnabled(ruleId, user.id(), enabled) == 1
                ? new Result(200, enabled ? "켰습니다." : "껐습니다. 지금부터 생기는 사건은 들어오지 않습니다.")
                : new Result(404, "없는 규칙입니다.");
    }

    /**
     * 관심 종목 상한(사용자 20·전체 60 — 종목별 수급 수집 범위). 넘으면 400, 아니면 null.
     * 이미 켜 둔 종목의 규칙을 하나 더 만들거나 켜는 것은 종목 수를 늘리지 않으므로 상한에 걸리지 않습니다(QA-062).
     */
    private Result stockCapProblem(CurrentUser user, String code) {
        boolean alreadyWatching = alerts.rules(user.id()).stream().anyMatch(rule -> rule.enabled()
                && "FOREIGN_STREAK".equals(rule.kind())
                && "STOCK".equals(rule.params().path("target").asText())
                && code.equals(rule.params().path("code").asText()));
        if (!alreadyWatching && alerts.countStockCodes(user.id()) >= STOCKS_PER_USER) {
            return new Result(400, "관심 종목 알림은 %d종목까지입니다.".formatted(STOCKS_PER_USER));
        }
        if (!alerts.hasStockCode(code) && alerts.countStockCodes(null) >= STOCKS_TOTAL) {
            return new Result(400, "종목별 수급 수집 범위(전체 %d종목)를 넘습니다 — 수집 범위 초과. 다른 종목 규칙을 지운 뒤 다시 만드세요."
                    .formatted(STOCKS_TOTAL));
        }
        return null;
    }

    public Result delete(CurrentUser user, long ruleId) {
        return alerts.deleteRule(ruleId, user.id()) == 1 ? new Result(200, "지웠습니다.") : new Result(404, "없는 규칙입니다.");
    }

    public List<Map<String, Object>> inbox(CurrentUser user, int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (AlertStore.InboxItem item : alerts.inbox(user.id(), Math.max(1, Math.min(limit, 200)))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", item.id());
            row.put("kind", item.kind());
            row.put("occurredOn", item.occurredOn().toString());
            row.put("title", item.title());
            row.put("body", item.body());
            row.put("late", item.late());
            row.put("createdAt", String.valueOf(item.createdAt()));
            row.put("read", item.readAt() != null);
            // 화면 안 주소(AlertStore.inAppHref가 거른 값)만 — 정보 검색 관심 대상 알림(SEARCH_WATCH)이 그 대상으로 가게.
            row.put("payload", item.href() == null ? null : Map.of("href", item.href()));
            out.add(row);
        }
        return out;
    }

    public int unreadCount(CurrentUser user) {
        return alerts.unreadCount(user.id());
    }

    /** 읽음 처리 — {@code ids}가 null이면 모두. */
    public int markRead(CurrentUser user, List<Long> ids) {
        return alerts.markRead(user.id(), ids);
    }

    static String describe(String kind, JsonNode params) {
        return switch (kind) {
            case "REGIME_CHANGE" -> "국면 전환(새 판정이 3일 이어질 때)";
            case "FOREIGN_STREAK" -> "외국인 %d일 연속 순매수 — %s".formatted(params.path("n").asInt(),
                    "STOCK".equals(params.path("target").asText()) ? "종목 " + params.path("code").asText()
                            : params.path("target").asText());
            case "INSTITUTION_NEW" -> "13F 신규 편입 — " + Institutions.byCik(params.path("cik").asText()).get("name");
            default -> kind;
        };
    }

    private static String text(JsonNode params, String field) {
        if (params == null || !params.hasNonNull(field)) {
            return null;
        }
        String value = params.get(field).asText().trim();
        return value.isEmpty() ? null : value;
    }
}
