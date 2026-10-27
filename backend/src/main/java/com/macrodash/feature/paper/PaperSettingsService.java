package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.GateIndicator;
import com.macrodash.store.PaperStore;
import com.macrodash.support.InvalidRequestException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 🧪 모의 매매 설정(명세 S1, 설계 §4-4) — DB 한 행({@code paper_settings}) + 변경 이력.
 *
 * <p>읽기·처음 값 넣기({@link #ensureInitialized})와, 화면에서 바꾸는 쓰기({@link #update} — 단계 3a, S2·S3)를 합니다.
 * 설정 행이 아직 없으면(초기화 전) {@link #defaultsJson()}을 그대로 쓰고 버전은 null입니다 — "버전 0"을 지어내지 않습니다.
 *
 * <p>읽을 때마다 DB 한 줄을 읽습니다(캐시 없음). 5분마다 도는 정기 작업과 화면 조회뿐이라 비용이 작고, 재기동 없이 바로
 * 반영돼야 하기 때문입니다(S1) — 저장하면 다음 작업부터 새 값입니다.
 */
@Service
public class PaperSettingsService {

    private static final Logger log = LoggerFactory.getLogger(PaperSettingsService.class);

    /** 설정 버전과 장부가 읽는 값. 행이 없으면 version은 null(기본값). */
    public record Current(Integer version, PaperSettings settings) {
    }

    /**
     * 후보 기관 27곳(설계 §4-0 ①, 단계 0 표 A — EDGAR에서 확인한 지금 CIK). 선행 CIK(그린라이트·퍼싱 스퀘어의 옛 등록)는
     * 수집기({@code indicators.TRACK_RECORD_FILERS}, 단계 1b)가 잇습니다 — 여기는 "누구를 순위에 올리나"만.
     */
    static final List<String> CANDIDATE_CIKS = List.of(
            "0001067983", "0001061768", "0002026053", "0001040273", "0001489933", "0001656456", "0001112520",
            "0001720792", "0000200217", "0001036325", "0001096343", "0001709323", "0000860643", "0001649339",
            "0001167483", "0001061165", "0001103804", "0001135730", "0001541617", "0001747057", "0000934639",
            "0001088875", "0001536411", "0000850529", "0001350694", "0001029160", "0000923093");

    /** 유니버스에 늘 넣는 ETF(D8): 섹터 11 + 현금성·헷지 6. 벤치마크 SPY·QQQ는 수집 유니버스에만 있습니다. */
    static final List<String> UNIVERSE_EXTRA_TICKERS = List.of(
            "XLK", "XLC", "XLY", "XLI", "XLF", "XLV", "XLP", "XLE", "XLB", "XLU", "XLRE",
            "SHY", "UUP", "GLD", "DBC", "TLT", "IEF");

    /** 설정 이력 응답에 싣는 최근 버전 수. 설정은 손으로 바꿀 때만 버전이 올라 몇 년이어도 이 안입니다. */
    static final int HISTORY_SHOWN = 100;

    private final PaperStore store;
    private final ObjectMapper mapper;
    /** 저장 둘이 같은 옛 본문에서 출발해 한쪽 변경을 지우지 않게(백엔드는 한 프로세스라 JVM 안의 잠금으로 충분). */
    private final ReentrantLock writing = new ReentrantLock();

    public PaperSettingsService(PaperStore store, ObjectMapper mapper) {
        this.store = store;
        this.mapper = mapper;
    }

    /** 지금 설정(미국 — {@link #current(PaperMarket)}의 미국 판). 테이블이 없거나 행이 없으면 기본값(버전 null). */
    public Current current() {
        return current(UsPaperMarket.INSTANCE);
    }

    /**
     * 지금 설정을 그 시장의 키(접두어·현금성 기본값 — {@link PaperSettings#from(JsonNode, PaperMarket)})로. 테이블이 없거나 행이 없으면
     * 그 시장 기본값(버전 null).
     */
    Current current(PaperMarket market) {
        if (!store.ready()) {
            return new Current(null, PaperSettings.defaults(market));
        }
        return store.settings()
                .map(row -> {
                    PaperSettings settings = PaperSettings.from(row.body(), market);
                    if (!settings.fallbacks().isEmpty()) {
                        log.warn("모의 매매 설정 v{}의 키 {}가 없거나 범위 밖이라 기본값으로 읽습니다", row.version(),
                                settings.fallbacks());
                    }
                    return new Current(row.version(), settings);
                })
                .orElseGet(() -> new Current(null, PaperSettings.defaults(market)));
    }

    /** 설정 행이 없으면 기본값으로 만듭니다(버전 1). 이미 있으면 그대로 둡니다. @return 이번에 만들었으면 true */
    public boolean ensureInitialized() {
        return store.initSettingsIfAbsent(defaultsJson());
    }

    // ------------------------------------------------------------------ 화면(GET·POST /api/paper/settings)
    /**
     * GET /api/paper/settings — {@code {available, version, updatedAtKst, body, defaults, keys:[{key, type, min, max, affectsRules,
     * market, description, options}], fallbacks}}({@code market} = 그 키를 읽는 책 US·KR, 두 책 공통이면 null). 행이 없으면(초기화 전) {@code version:null}이고 {@code body}는 기본값입니다.
     * {@code fallbacks}는 지금 본문에서 없거나 범위 밖이라 기본값으로 읽는 키(장부·섞기·규칙 책 묶음·Claude 책·추정 비용 단가·사건 뉴스).
     */
    public Map<String, Object> view() {
        if (!store.ready()) {
            return notReady();
        }
        java.util.Optional<PaperStore.SettingsRow> row = store.settings();
        JsonNode body = row.map(PaperStore.SettingsRow::body).orElseGet(this::defaultsJson);
        PaperSettings parsed = PaperSettings.from(body);
        List<String> fallbacks = new ArrayList<>(parsed.fallbacks());
        fallbacks.addAll(parsed.blend().fallbacks());
        fallbacks.addAll(parsed.rules().fallbacks());
        fallbacks.addAll(ClaudeBookService.ClaudeSettings.from(body).fallbacks());
        fallbacks.addAll(PaperApiCalls.Pricing.from(body).fallbacks());
        fallbacks.addAll(EventsSection.settings(body).fallbacks());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("version", row.map(PaperStore.SettingsRow::version).orElse(null));
        out.put("updatedAtKst", row.map(r -> r.updatedAt() == null ? null : Kst.stamp(r.updatedAt())).orElse(null));
        out.put("body", body);
        out.put("defaults", defaultsJson());
        out.put("keys", PaperSettingKeys.views());
        out.put("fallbacks", row.isPresent() ? fallbacks : List.of());
        return out;
    }

    /**
     * POST /api/paper/settings — 바꿀 키만 담은 patch를 검사해 설정 행에 반영합니다(명세 S1~S3, 설계 §4-4).
     *
     * <p>키는 점 경로({@code {"trackRecord.windowYears": 5}})로도, 묶음({@code {"trackRecord": {"windowYears": 5}}})으로도 받습니다.
     * 모르는 키·형이 틀린 값·범위 밖 값이 하나라도 있으면 <b>아무것도 바꾸지 않고</b> 400(사유를 모두 적음). 지금 값과 같은 키는 바뀐
     * 키로 세지 않고, 바뀐 키가 없으면 저장하지 않습니다(버전 그대로). 바뀐 키가 있으면 버전을 올리고 이력에 본문 전체와 바뀐 키를
     * 남깁니다 — 다음 작업부터 새 값입니다(캐시 없음). 규칙 책이 읽는 키를 바꾸면 {@code warning}(S3) — 그 키 시장의 규칙 계좌 문장
     * ({@link PaperSettingKeys#rulesWarning}, 미국 키만이면 예전 문장 그대로).
     *
     * <p>설정 행이 아직 없으면 먼저 기본값으로 버전 1을 만든 뒤 바꿉니다(이력에 "처음 값"과 "바꾼 값"이 따로 남게).
     *
     * @return {@code {ok, version, changedKeys, warning}} — 테이블이 없으면 {@code available:false, ok:false}
     * @throws InvalidRequestException patch가 객체가 아님·비었음·모르는 키·형·범위·결정 시각보다 이른 마감 기한
     */
    public Map<String, Object> update(JsonNode patch) {
        if (!store.ready()) {
            Map<String, Object> out = notReady();
            out.put("ok", false);
            return out;
        }
        if (patch == null || !patch.isObject() || patch.isEmpty()) {
            throw new InvalidRequestException("바꿀 설정을 {\"키\": 값} 모양으로 보내세요(키는 GET /api/paper/settings의 "
                    + "keys[].key).");
        }
        Map<String, JsonNode> flat = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();
        flatten(patch, "", flat, errors);
        Map<String, JsonNode> values = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> entry : flat.entrySet()) {
            PaperSettingKeys.Spec spec = PaperSettingKeys.find(entry.getKey()).orElseThrow();
            PaperSettingKeys.Checked checked = PaperSettingKeys.check(spec, entry.getValue());
            if (checked.error() != null) {
                errors.add(checked.error());
            } else {
                values.put(spec.key(), checked.value());
            }
        }
        if (!errors.isEmpty()) {
            throw new InvalidRequestException("설정을 저장하지 않았습니다 — " + String.join(" · ", errors));
        }
        writing.lock();
        try {
            ensureInitialized();
            PaperStore.SettingsRow row = store.settings().orElseThrow(() -> new IllegalStateException(
                    "모의 매매 설정 행을 만들지 못했습니다"));
            ObjectNode body = row.body() instanceof ObjectNode existing ? existing.deepCopy()
                    : (ObjectNode) defaultsJson();
            List<String> changed = new ArrayList<>();
            for (Map.Entry<String, JsonNode> entry : values.entrySet()) {
                if (!PaperSettingKeys.same(valueAt(body, entry.getKey()), entry.getValue())) {
                    setAt(body, entry.getKey(), entry.getValue());
                    changed.add(entry.getKey());
                }
            }
            requireDeadlineAfterDecision(body);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            if (changed.isEmpty()) {
                out.put("version", row.version());
                out.put("changedKeys", List.of());
                out.put("warning", null);
                return out;
            }
            int version = store.saveSettings(body, changed);
            // 경고는 바꾼 규칙 계좌 영향 키의 시장마다(미국 키만이면 지금 문장 그대로 — 명세 §4-13 '그 시장 규칙 계좌 기준').
            String warning = PaperSettingKeys.rulesWarning(changed.stream()
                    .map(key -> PaperSettingKeys.find(key).orElseThrow()).toList());
            log.info("모의 매매 설정 v{} → v{}: {}{}", row.version(), version, changed,
                    warning != null ? " (규칙 책 영향)" : "");
            out.put("version", version);
            out.put("changedKeys", changed);
            out.put("warning", warning);
            return out;
        } finally {
            writing.unlock();
        }
    }

    /** {@link #update(JsonNode)} — 컨트롤러가 받은 JSON 객체 본문(키가 정해져 있지 않아 Map으로 받음). null이면 400. */
    public Map<String, Object> updateBody(Map<String, Object> patch) {
        return update(patch == null ? null : mapper.valueToTree(patch));
    }

    /** GET /api/paper/settings/history — {@code {available, history:[{version, changedKeys, createdAtKst, body}]}} 최근 버전 순. */
    public Map<String, Object> history() {
        if (!store.ready()) {
            return notReady();
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (PaperStore.SettingsHistoryRow h : store.settingsHistory(HISTORY_SHOWN)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("version", h.version());
            row.put("changedKeys", h.changedKeys());
            row.put("createdAtKst", h.createdAt() == null ? null : Kst.stamp(h.createdAt()));
            row.put("body", h.body());
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("history", rows);
        return out;
    }

    private static Map<String, Object> notReady() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", false);
        out.put("message", PaperQueryService.NOT_READY_MESSAGE);
        return out;
    }

    /** patch → 점 경로별 값. 알려진 키는 그대로, 키를 품은 묶음은 안으로 들어가고, 그 밖은 모르는 키. */
    private static void flatten(JsonNode node, String prefix, Map<String, JsonNode> out, List<String> errors) {
        for (Map.Entry<String, JsonNode> field : node.properties()) {
            String path = prefix.isEmpty() ? field.getKey() : prefix + "." + field.getKey();
            if (PaperSettingKeys.find(path).isPresent()) {
                out.put(path, field.getValue());
            } else if (field.getValue() != null && field.getValue().isObject() && PaperSettingKeys.isGroup(path)) {
                flatten(field.getValue(), path, out, errors);
            } else {
                errors.add("모르는 설정 키: " + com.macrodash.support.Params.echo(path));
            }
        }
    }

    /** 본문에서 점 경로의 값. 없으면 null. */
    static JsonNode valueAt(JsonNode body, String path) {
        JsonNode node = body;
        for (String part : path.split("\\.")) {
            if (node == null || !node.isObject()) {
                return null;
            }
            node = node.get(part);
        }
        return node;
    }

    /** 본문의 점 경로에 값을 씁니다 — 중간 묶음이 없거나 객체가 아니면 새로 만듭니다(단계 2 전 행의 blend·rules 등). */
    private static void setAt(ObjectNode body, String path, JsonNode value) {
        String[] parts = path.split("\\.");
        ObjectNode node = body;
        for (int i = 0; i < parts.length - 1; i++) {
            JsonNode child = node.get(parts[i]);
            if (child instanceof ObjectNode object) {
                node = object;
            } else {
                node = node.putObject(parts[i]);
            }
        }
        node.set(parts[parts.length - 1], value);
    }

    /** 확정 종가를 기다리는 기한이 결정 시각보다 이르면 막습니다(결정 작업은 그런 기한을 결정 시각으로 읽어 기다리지 않게 됨). */
    private static void requireDeadlineAfterDecision(JsonNode body) {
        JsonNode decision = valueAt(body, "decisionTimeKst");
        JsonNode deadline = valueAt(body, "decisionDeadlineKst");
        if (decision == null || deadline == null || !decision.isString() || !deadline.isString()) {
            return;
        }
        try {
            if (LocalTime.parse(deadline.asString("")).isBefore(LocalTime.parse(decision.asString("")))) {
                throw new InvalidRequestException("설정을 저장하지 않았습니다 — decisionDeadlineKst("
                        + deadline.asString("") + ")가 decisionTimeKst(" + decision.asString("") + ")보다 이릅니다");
            }
        } catch (java.time.format.DateTimeParseException e) {
            // 손으로 고친 행의 옛 값 — 결정 작업이 기본값으로 읽습니다. 이번 저장이 그 키를 고치지 않았으면 막지 않습니다.
        }
    }

    /**
     * 설계 §4-4의 키 전부와 기본값. 단계 1이 읽는 키는 slippageBp·trailingStopPct·lockoutTradingDays·cashLikeTickers·gate.*
     * 이고, 나머지는 뒤 단계(규칙 책·Claude 책·메모)가 읽도록 처음부터 한 행에 둡니다 — 나중에 키를 더하면 버전이 바뀌어
     * "이 결정은 어느 설정으로 했나" 기록이 끊깁니다. {@code blend.*}(D27)·{@code rules.*}는 단계 2에 더한 키라 그 전에 만든 행에는 없고,
     * 없으면 읽는 쪽이 이 기본값으로 읽습니다(행을 고쳐 쓰지 않음 — 버전을 바꾸는 쓰기는 설정 API, 단계 3a).
     */
    public JsonNode defaultsJson() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", "claude-sonnet-5-5");
        body.put("effort", "high");
        body.put("decisionTimeKst", "07:30");
        body.put("decisionDeadlineKst", "12:00");
        body.put("slippageBp", PaperSettings.DEFAULT_SLIPPAGE_BP);
        body.put("maxWeightStockPct", 10);
        body.put("maxWeightEtfPct", 20);
        body.put("maxPositions", 20);
        body.put("trailingStopPct", PaperSettings.DEFAULT_TRAILING_STOP_PCT);
        body.put("lockoutTradingDays", PaperSettings.DEFAULT_LOCKOUT_TRADING_DAYS);
        body.put("maxDiscretionaryOrdersPerMonth", 20);
        body.put("minHoldTradingDaysForSell", 5);
        body.put("minOrderNotional", 500);
        Map<String, Object> trackRecord = new LinkedHashMap<>();
        trackRecord.put("windowYears", 7);
        trackRecord.put("topN", 5);
        trackRecord.put("metric", "CAGR");
        trackRecord.put("minPeriods", 24);
        trackRecord.put("minCoverage", 0.5);
        trackRecord.put("avgCoverage", 0.7);
        trackRecord.put("candidateCiks", CANDIDATE_CIKS);
        body.put("trackRecord", trackRecord);
        body.put("minHolders", 2);
        body.put("rulesMaxNames", 10);
        body.put("parkCashInShy", true);
        // 규칙 책 묶음(rules.*) — 단계 2에 더한 키라 그 전에 만든 설정 행에는 없고, 그 행은 PaperSettings.Rules가 이 기본값으로 읽습니다.
        Map<String, Object> rulesBody = new LinkedHashMap<>();
        rulesBody.put("parkCashThresholdPct", PaperSettings.Rules.DEFAULT_PARK_CASH_THRESHOLD_PCT);
        body.put("rules", rulesBody);
        // 두 기관 그룹 섞기(D27) — D27 전에 만든 설정 행에는 없고, 그 행은 PaperSettings.Blend가 이 기본값으로 읽습니다.
        PaperSettings.Blend blend = PaperSettings.Blend.defaults();
        Map<String, Object> groupB = new LinkedHashMap<>();
        groupB.put("topN", blend.groupBTopN());
        groupB.put("windowYears", blend.groupBWindowYears());
        groupB.put("minPeriods", blend.groupBMinPeriods());
        Map<String, Object> blendBody = new LinkedHashMap<>();
        blendBody.put("groupB", groupB);
        blendBody.put("groupWeightA", blend.groupWeightA());
        blendBody.put("convictionCapPct", blend.convictionCapPct());
        blendBody.put("allocation", blend.allocation().name());
        blendBody.put("minTargetPct", blend.minTargetPct());
        body.put("blend", blendBody);
        body.put("universeExtraTickers", UNIVERSE_EXTRA_TICKERS);
        body.put("cashLikeTickers", PaperSettings.DEFAULT_CASH_LIKE);
        GateIndicator.Thresholds gate = GateIndicator.Thresholds.defaults();
        Map<String, Object> gateBody = new LinkedHashMap<>();
        gateBody.put("us10yStage1", gate.us10yStage1());
        gateBody.put("us10yFull", gate.us10yFull());
        gateBody.put("brentMax", gate.brentMax());
        gateBody.put("wtiMax", gate.wtiMax());
        gateBody.put("usdjpyMin", gate.usdjpyMin());
        gateBody.put("confirmDays", gate.confirmDays());
        body.put("gate", gateBody);
        body.put("notesDefaultExpiryTradingDays", 3);
        body.put("notesMaxCharsInPacket", 6000);
        body.put("apiDailyCallCap", 20);
        body.put("frameworkTokenBudget", 8000);
        // 추정 비용 단가(C8, 단계 3b) — 그 전에 만든 설정 행에는 없고, 그 행은 PaperApiCalls.Pricing이 이 기본값으로 읽습니다.
        body.put("pricing", PaperApiCalls.Pricing.defaults().body());
        // 사건 뉴스(2단계 B, 패킷 11b_events) — 그 전에 만든 설정 행에는 없고, 그 행은 EventsSection.settings가 이 기본값으로 읽습니다.
        body.put("news", EventsSection.defaultsBody());
        return mapper.valueToTree(body);
    }
}
