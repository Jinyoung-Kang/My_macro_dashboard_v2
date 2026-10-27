package com.macrodash.feature.paper;

import com.macrodash.analytics.NewsEvents;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 설정 쓰기(명세 S1~S3, 설계 §4-4) — 알려진 키만·형·범위 검사, 바뀐 키·버전·이력, 규칙 책 영향 경고, 화면용 키 설명.
 * 저장소는 메모리 가짜({@link FakePaperStore})이고 실제 SQL은 {@code PaperStoreDbTest}가 봅니다.
 */
class PaperSettingsServiceTest {

    private FakePaperStore store;
    private PaperSettingsService service;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        service = new PaperSettingsService(store, MAPPER);
        service.ensureInitialized();
    }

    private Map<String, Object> update(Object... keyAndValue) {
        Map<String, Object> patch = new LinkedHashMap<>();
        for (int i = 0; i < keyAndValue.length; i += 2) {
            patch.put((String) keyAndValue[i], keyAndValue[i + 1]);
        }
        return service.update(MAPPER.valueToTree(patch));
    }

    private JsonNode body() {
        return store.settings().orElseThrow().body();
    }

    @Test
    @DisplayName("점 경로·묶음 둘 다 받아 바뀐 키만 반영 — 버전 +1·이력, 규칙 책 영향 키면 경고, 다음 읽기부터 새 값")
    void updatesKnownKeysAndBumpsVersion() {
        Map<String, Object> out = update("slippageBp", 10, "trackRecord.windowYears", 5,
                "blend", Map.of("groupB", Map.of("topN", 3)), "model", "claude-haiku-5-5");

        assertThat(out.get("ok")).isEqualTo(true);
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("slippageBp", "trackRecord.windowYears",
                "blend.groupB.topN", "model"));
        assertThat(out.get("warning")).isEqualTo("규칙 계좌는 동결된 대조군입니다 — 이 변경은 실험 조건을 바꿉니다");
        assertThat(body().path("slippageBp").asDouble()).isEqualTo(10);
        assertThat(body().path("trackRecord").path("windowYears").asInt()).isEqualTo(5);
        assertThat(body().path("trackRecord").path("topN").asInt()).as("다른 키는 그대로").isEqualTo(5);
        assertThat(body().path("blend").path("groupB").path("topN").asInt()).isEqualTo(3);
        assertThat(body().path("blend").path("groupB").path("windowYears").asInt()).isEqualTo(2);
        // 캐시 없이 다음 읽기부터 새 값(S1)
        assertThat(service.current().version()).isEqualTo(2);
        assertThat(service.current().settings().slippageBp()).isEqualTo(10);
        assertThat(service.current().settings().blend().groupBTopN()).isEqualTo(3);
        assertThat(ClaudeBookService.ClaudeSettings.from(body()).model()).isEqualTo("claude-haiku-5-5");

        Map<String, Object> claudeOnly = update("effort", "MEDIUM", "apiDailyCallCap", 3);
        assertThat(claudeOnly.get("version")).isEqualTo(3);
        assertThat(claudeOnly.get("warning")).as("Claude 책만 읽는 키는 경고 없음").isNull();
        assertThat(body().path("effort").asString()).as("정해진 표기로").isEqualTo("medium");

        JsonNode history = MAPPER.valueToTree(service.history().get("history"));
        assertThat(history).extracting(h -> h.path("version").asInt()).containsExactly(3, 2, 1);
        assertThat(history.get(0).path("changedKeys").toString()).contains("effort", "apiDailyCallCap");
        assertThat(history.get(2).path("changedKeys")).as("처음 값").isEmpty();
        assertThat(history.get(1).path("body").path("slippageBp").asDouble()).isEqualTo(10);
    }

    @Test
    @DisplayName("지금 값과 같으면 바뀐 키가 아니다 — 5와 5.0도 같음, 바뀐 것이 없으면 저장하지 않고 버전 그대로")
    void sameValuesDoNotSave() {
        Map<String, Object> out = update("slippageBp", 5, "trailingStopPct", 8.0, "model", "claude-sonnet-5-5");

        assertThat(out.get("version")).isEqualTo(1);
        assertThat(out.get("changedKeys")).isEqualTo(List.of());
        assertThat(out.get("warning")).isNull();
        assertThat(store.settingsHistory).hasSize(1);

        // 기본값 본문을 통째로 보내도 모든 값이 검사를 지나고 바뀐 키가 없음(기본값이 쓰기 범위 안)
        Map<String, Object> defaults = service.update(service.defaultsJson());
        assertThat(defaults.get("changedKeys")).isEqualTo(List.of());
    }

    @Test
    @DisplayName("모르는 키·형·범위·정수·모델·시각이 하나라도 틀리면 아무것도 바꾸지 않고 400(사유를 모두)")
    void rejectsInvalidPatches() {
        assertThatThrownBy(() -> update("slippageBp", 7, "nope", 1)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("모르는 설정 키: nope");
        assertThatThrownBy(() -> update("trackRecord", Map.of("windowYears", 9))).hasMessageContaining(
                "trackRecord.windowYears: 1~7 범위");
        assertThatThrownBy(() -> update("maxPositions", 12.5)).hasMessageContaining("정수");
        assertThatThrownBy(() -> update("slippageBp", "5")).hasMessageContaining("숫자");
        assertThatThrownBy(() -> update("model", "claude-opus-5-5")).hasMessageContaining("claude-sonnet-5-5")
                .hasMessageContaining("claude-haiku-5-5");
        assertThatThrownBy(() -> update("effort", "turbo")).hasMessageContaining("effort");
        assertThatThrownBy(() -> update("decisionTimeKst", "7:30")).hasMessageContaining("HH:mm");
        assertThatThrownBy(() -> update("parkCashInShy", "yes")).hasMessageContaining("true·false");
        assertThatThrownBy(() -> update("cashLikeTickers", List.of("SHY", "bad ticker"))).hasMessageContaining("티커");
        assertThatThrownBy(() -> update("trackRecord.candidateCiks", List.of())).hasMessageContaining("비면");
        assertThatThrownBy(() -> update("blend.allocation", "RANDOM")).hasMessageContaining("CONVICTION");
        assertThatThrownBy(() -> update("slippageBp", 7, "trailingStopPct", 0, "lockoutTradingDays", -1))
                .hasMessageContaining("trailingStopPct").hasMessageContaining("lockoutTradingDays");
        assertThatThrownBy(() -> service.update(MAPPER.createObjectNode())).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.update(null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.update(MAPPER.valueToTree(List.of(1)))).isInstanceOf(
                InvalidRequestException.class);
        assertThatThrownBy(() -> update("gate", 4.8)).as("묶음 자리에 값").hasMessageContaining("모르는 설정 키: gate");

        assertThat(store.settings().orElseThrow().version()).as("아무것도 바꾸지 않음").isEqualTo(1);
        assertThat(body().path("slippageBp").asDouble()).isEqualTo(5);
    }

    @Test
    @DisplayName("마감 기한이 결정 시각보다 이르면 400 — 저장된 값과 합쳐서 본다")
    void deadlineMustNotPrecedeDecisionTime() {
        assertThatThrownBy(() -> update("decisionDeadlineKst", "07:00")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("decisionDeadlineKst");
        assertThat(update("decisionTimeKst", "06:30", "decisionDeadlineKst", "07:00").get("version")).isEqualTo(2);
    }

    @Test
    @DisplayName("값을 정해진 모양으로 — 티커 대문자·중복 제거, CIK 10자리, 정수 키는 정수, 선택 값은 정해진 표기")
    void normalizesValues() {
        update("universeExtraTickers", List.of("xlk", " SHY ", "XLK", "BRK.B"),
                "trackRecord.candidateCiks", List.of("1067983", 1061768, "0001067983"),
                "trackRecord.metric", "sharpe", "maxPositions", 15.0, "blend.allocation", "equal");

        assertThat(body().path("universeExtraTickers").toString()).isEqualTo("[\"XLK\",\"SHY\",\"BRK.B\"]");
        assertThat(body().path("trackRecord").path("candidateCiks").toString())
                .isEqualTo("[\"0001067983\",\"0001061768\"]");
        assertThat(body().path("trackRecord").path("metric").asString()).isEqualTo("SHARPE");
        assertThat(body().path("maxPositions").isInt()).isTrue();
        assertThat(body().path("blend").path("allocation").asString()).isEqualTo("EQUAL");
    }

    @Test
    @DisplayName("사건 뉴스 설정(2단계 B): 키워드는 공백을 한 칸으로·대소문자만 다른 중복은 앞의 것만·빈 항목은 뺌, 피드는 아는 키만(소문자) — 틀리면 400")
    void newsSettings() {
        Map<String, Object> out = update("news.keywords", List.of(" rate   decision ", "Fed", "fed", "", "Middle\tEast"),
                "news.feeds", List.of("SEC_PRESS", "bls_cpi", "sec_press"), "news.maxPerDay", 0, "news.enabled", false);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("news.keywords", "news.feeds", "news.maxPerDay",
                "news.enabled"));
        assertThat(out.get("warning")).as("규칙 계좌가 읽지 않는 키").isNull();
        assertThat(body().path("news").path("keywords").toString()).isEqualTo("[\"rate decision\",\"Fed\",\"Middle East\"]");
        assertThat(body().path("news").path("feeds").toString()).as("피드 순서(선택지 순)로 저장 — 받은 순서가 아님")
                .isEqualTo("[\"bls_cpi\",\"sec_press\"]");
        assertThat(EventsSection.settings(body()).fallbacks()).isEmpty();
        assertThat(EventsSection.settings(body()).settings().enabled()).isFalse();
        // 회귀(B-SET-2): 순서만 다른 같은 묶음은 바뀐 값이 아닙니다 — 버전·이력이 늘지 않고, 기본값과 같은 묶음은 기본값 그대로 저장됩니다.
        int version = store.settings.version();
        assertThat(update("news.feeds", List.of("sec_press", "bls_cpi")).get("changedKeys")).isEqualTo(List.of());
        assertThat(store.settings.version()).isEqualTo(version);
        List<String> reversed = new ArrayList<>(NewsEvents.DEFAULT_FEEDS);
        Collections.reverse(reversed);
        assertThat(update("news.feeds", reversed).get("changedKeys")).isEqualTo(List.of("news.feeds"));
        assertThat(body().path("news").path("feeds")).isEqualTo(MAPPER.valueToTree(NewsEvents.DEFAULT_FEEDS));
        assertThat(update("news.feeds", NewsEvents.DEFAULT_FEEDS).get("changedKeys")).isEqualTo(List.of());
        assertThat(update("news.keywords", List.of(), "news.feeds", List.of()).get("changedKeys"))
                .as("빈 목록도 받음 — 티커만·고른 피드 없음").isEqualTo(List.of("news.keywords", "news.feeds"));

        assertThatThrownBy(() -> update("news.feeds", List.of("yahoo"))).hasMessageContaining("모르는 피드 키");
        assertThatThrownBy(() -> update("news.feeds", "sec_press")).hasMessageContaining("피드 키 목록");
        assertThatThrownBy(() -> update("news.keywords", "Fed")).hasMessageContaining("글자 목록");
        assertThatThrownBy(() -> update("news.keywords", List.of("<<사건 끝>>"))).hasMessageContaining("꺾쇠");
        assertThatThrownBy(() -> update("news.keywords", List.of("x".repeat(61)))).hasMessageContaining("60자");
        assertThatThrownBy(() -> update("news.maxPerDay", 31)).hasMessageContaining("0~30");
        assertThatThrownBy(() -> update("news.enabled", "yes")).hasMessageContaining("true·false");
    }

    @Test
    @DisplayName("묶음이 없는 옛 행(단계 2 전 — blend·rules 없음)에도 그 아래 키를 쓸 수 있다")
    void writesIntoMissingGroups() {
        tools.jackson.databind.node.ObjectNode old = (tools.jackson.databind.node.ObjectNode) body();
        old.remove("blend");
        old.remove("rules");

        Map<String, Object> out = update("blend.groupWeightA", 0.7, "rules.parkCashThresholdPct", 3);

        assertThat(out.get("changedKeys")).isEqualTo(List.of("blend.groupWeightA", "rules.parkCashThresholdPct"));
        assertThat(body().path("blend").path("groupWeightA").asDouble()).isEqualTo(0.7);
        assertThat(body().path("rules").path("parkCashThresholdPct").asDouble()).isEqualTo(3);
    }

    @Test
    @DisplayName("설정 행이 없으면 먼저 기본값으로 버전 1을 만든 뒤 바꾼다(이력에 처음 값과 바꾼 값이 따로)")
    void createsVersionOneBeforeFirstChange() {
        store = new FakePaperStore();
        service = new PaperSettingsService(store, MAPPER);

        assertThat(update("slippageBp", 9).get("version")).isEqualTo(2);
        assertThat(store.settingsHistory).containsOnlyKeys(1, 2);
        assertThat(store.settingsHistory.get(1).body().path("slippageBp").asDouble()).isEqualTo(5);
    }

    @Test
    @DisplayName("화면용 키 설명 — 기본값 키 전부(gate·blend·rules·trackRecord 포함)가 있고, 형·범위·선택지·규칙 책 영향을 싣는다")
    void viewDescribesEveryDefaultKey() {
        Map<String, Object> view = service.view();
        assertThat(view.get("available")).isEqualTo(true);
        assertThat(view.get("version")).isEqualTo(1);
        JsonNode keys = MAPPER.valueToTree(view.get("keys"));
        List<String> listed = new ArrayList<>();
        keys.forEach(k -> listed.add(k.path("key").asString()));

        List<String> leaves = new ArrayList<>();
        collectLeaves(service.defaultsJson(), "", leaves);
        assertThat(listed).as("기본값 본문의 키 = 화면에서 바꿀 수 있는 키").containsExactlyInAnyOrderElementsOf(leaves);

        JsonNode model = keys.get(listed.indexOf("model"));
        assertThat(model.path("type").asString()).isEqualTo("string");
        assertThat(model.path("options").toString()).contains("claude-sonnet-5-5", "claude-haiku-5-5");
        assertThat(model.path("affectsRules").asBoolean()).isFalse();
        JsonNode window = keys.get(listed.indexOf("trackRecord.windowYears"));
        assertThat(window.path("type").asString()).isEqualTo("integer");
        assertThat(window.path("min").asInt()).isEqualTo(1);
        assertThat(window.path("max").asInt()).isEqualTo(7);
        assertThat(window.path("affectsRules").asBoolean()).isTrue();
        for (String key : List.of("trailingStopPct", "maxWeightStockPct", "maxWeightEtfPct", "minHolders",
                "rulesMaxNames", "blend.allocation", "trackRecord.candidateCiks")) {
            assertThat(keys.get(listed.indexOf(key)).path("affectsRules").asBoolean()).as(key).isTrue();
        }
        assertThat(keys.get(listed.indexOf("gate.us10yStage1")).path("affectsRules").asBoolean())
                .as("게이트는 참고 지표 — 규칙 책 입력이 아님(D19)").isFalse();
        assertThat(keys.get(listed.indexOf("decisionTimeKst")).path("type").asString()).isEqualTo("time");
        assertThat(keys.get(listed.indexOf("cashLikeTickers")).path("type").asString()).isEqualTo("list");
        // 사건 뉴스(2단계 B): 키워드는 공백이 든 구절 목록(화면이 공백으로 나누지 않게 다른 형 이름), 피드는 목록 — 선택지를 보내면 화면이
        // 한 값 고르기로 그려 여럿을 고를 수 없어 선택지는 설명에만.
        assertThat(keys.get(listed.indexOf("news.keywords")).path("type").asString()).isEqualTo("phrases");
        JsonNode feeds = keys.get(listed.indexOf("news.feeds"));
        assertThat(feeds.path("type").asString()).isEqualTo("list");
        assertThat(feeds.path("options").isNull()).isTrue();
        assertThat(feeds.path("description").asString()).contains("investing_stock", "sec_press");
        assertThat(keys.get(listed.indexOf("news.maxPerDay")).path("max").asInt()).isEqualTo(30);
        for (String key : List.of("news.enabled", "news.maxPerDay", "news.keywords", "news.feeds")) {
            assertThat(keys.get(listed.indexOf(key)).path("affectsRules").asBoolean()).as(key + " — Claude 패킷만").isFalse();
        }

        store.ready = false;
        assertThat(service.view().get("available")).isEqualTo(false);
        assertThat(service.history().get("available")).isEqualTo(false);
        assertThat(service.update(MAPPER.valueToTree(Map.of("slippageBp", 6))).get("ok")).isEqualTo(false);
    }

    @Test
    @DisplayName("공유 키(2단계 K18·K22·K37): 예약 7·세 스위치 꺼짐이 기본, 형·범위대로 검사, 바꿔도 경고 없음 — 키를 더해도 저장된 행의 판은 그대로")
    void sharedStage2Keys() {
        JsonNode defaults = service.defaultsJson();
        assertThat(defaults.path("apiScheduledReserve").asInt()).isEqualTo(7);
        assertThat(defaults.path("calendar").path("consensus").asBoolean(true)).isFalse();
        assertThat(defaults.path("claude").path("schemaV3").asBoolean(true)).isFalse();
        assertThat(defaults.path("claude").path("figureCheck").asBoolean(true)).isFalse();
        PaperSettingKeys.Spec reserve = PaperSettingKeys.find("apiScheduledReserve").orElseThrow();
        assertThat(reserve.type()).isEqualTo(PaperSettingKeys.Type.INTEGER);
        assertThat(List.of(reserve.min(), reserve.max())).containsExactly(0.0, (double) ClaudeBookService.MAX_DAILY_CALL_CAP);
        for (String key : List.of("calendar.consensus", "claude.schemaV3", "claude.figureCheck")) {
            assertThat(PaperSettingKeys.find(key).orElseThrow().type()).as(key).isEqualTo(PaperSettingKeys.Type.BOOLEAN);
            assertThat(PaperSettingKeys.find(key).orElseThrow().affectsRules()).as(key).isFalse();
        }

        // 공유 키가 없는 옛 행(C1b 전 — 서버의 지금 행)은 그대로 읽히고 판이 오르지 않으며, 그 키를 처음 쓸 때만 판이 오른다.
        tools.jackson.databind.node.ObjectNode old = (tools.jackson.databind.node.ObjectNode) body();
        old.remove("apiScheduledReserve");
        old.remove("calendar");
        old.remove("claude");
        assertThat(service.current().version()).isEqualTo(1);
        assertThat(service.view().get("version")).isEqualTo(1);
        Map<String, Object> switches = new LinkedHashMap<>();
        switches.put("schemaV3", true);
        switches.put("figureCheck", true);
        Map<String, Object> out = update("calendar.consensus", true, "claude", switches, "apiScheduledReserve", 9);
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("calendar.consensus", "claude.schemaV3", "claude.figureCheck",
                "apiScheduledReserve"));
        assertThat(out.get("warning")).as("규칙 계좌가 읽지 않는 키").isNull();
        assertThat(body().path("claude").path("figureCheck").asBoolean()).isTrue();

        assertThatThrownBy(() -> update("apiScheduledReserve", 51)).hasMessageContaining("0~50");
        assertThatThrownBy(() -> update("apiScheduledReserve", -1)).hasMessageContaining("0~50");
        assertThatThrownBy(() -> update("claude.schemaV3", "true")).hasMessageContaining("true·false");
        assertThatThrownBy(() -> update("calendar", true)).as("묶음 자리에 값").hasMessageContaining("모르는 설정 키: calendar");
        assertThatThrownBy(() -> update("claude.unknownSwitch", true)).hasMessageContaining("모르는 설정 키: claude.unknownSwitch");
    }

    @Test
    @DisplayName("시장 범위(2단계 §4-13) — 공유 키는 market null·나머지는 US, 규칙 계좌 경고는 그 시장 문장(미국 키만이면 지금 문장 그대로)")
    void marketScopeAndRulesWarningPerMarket() {
        JsonNode keys = MAPPER.valueToTree(service.view().get("keys"));
        List<String> shared = new ArrayList<>();
        for (JsonNode key : keys) {
            assertThat(key.has("market")).as(key.path("key").asString()).isTrue();
            if (key.path("market").isNull()) {
                shared.add(key.path("key").asString());
                assertThat(key.path("affectsRules").asBoolean()).as("공유 키는 규칙 계좌 영향 없음").isFalse();
            } else {
                assertThat(key.path("market").asString()).as(key.path("key").asString()).isEqualTo("US");
            }
        }
        assertThat(shared).containsExactly("model", "effort", "apiDailyCallCap", "apiScheduledReserve",
                "frameworkTokenBudget",
                "pricing.sonnet.inputUsdPerMTok", "pricing.sonnet.outputUsdPerMTok", "pricing.sonnet.cacheReadUsdPerMTok",
                "pricing.sonnet.cacheWriteUsdPerMTok", "pricing.haiku.inputUsdPerMTok", "pricing.haiku.outputUsdPerMTok",
                "pricing.haiku.cacheReadUsdPerMTok", "pricing.haiku.cacheWriteUsdPerMTok",
                "calendar.consensus", "claude.schemaV3", "claude.figureCheck");

        PaperSettingKeys.Spec usRules = PaperSettingKeys.find("slippageBp").orElseThrow();
        PaperSettingKeys.Spec usPlain = PaperSettingKeys.find("decisionTimeKst").orElseThrow();
        PaperSettingKeys.Spec sharedKey = PaperSettingKeys.find("model").orElseThrow();
        PaperSettingKeys.Spec krRules = new PaperSettingKeys.Spec("kr.test", PaperSettingKeys.Type.NUMBER, 0.0, 1.0,
                List.of(), true, "시험용 한국 키", PaperSettingKeys.Scope.KR);
        assertThat(PaperSettingKeys.rulesWarning(List.of(usPlain, sharedKey))).isNull();
        assertThat(PaperSettingKeys.rulesWarning(List.of(usRules, sharedKey)))
                .isEqualTo("규칙 계좌는 동결된 대조군입니다 — 이 변경은 실험 조건을 바꿉니다");
        assertThat(PaperSettingKeys.rulesWarning(List.of(krRules)))
                .isEqualTo("한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다");
        assertThat(PaperSettingKeys.rulesWarning(List.of(krRules, usRules))).as("둘 다면 미국 · 한국 순")
                .isEqualTo(PaperSettingKeys.RULES_FROZEN_WARNING + " · " + PaperSettingKeys.KR_RULES_FROZEN_WARNING);

        // 접두어와 범위가 어긋나면 키 표가 올라오지 않음 — 한국 키는 kr. 아래에만, kr. 아래는 한국 키만.
        assertThatThrownBy(() -> new PaperSettingKeys.Spec("kr.slippageBp", PaperSettingKeys.Type.NUMBER, 0.0, 1.0,
                List.of(), true, "", PaperSettingKeys.Scope.US)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new PaperSettingKeys.Spec("slippageBp", PaperSettingKeys.Type.NUMBER, 0.0, 1.0,
                List.of(), true, "", PaperSettingKeys.Scope.KR)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("쓰기 범위는 읽는 쪽의 범위 안 — 모든 숫자 키를 최솟값·최댓값으로 저장해도 어느 읽기도 기본값으로 바꾸지 않는다")
    void writableRangesAreReadableWithoutFallbacks() {
        for (boolean useMax : List.of(false, true)) {
            Map<String, Object> patch = new LinkedHashMap<>();
            for (PaperSettingKeys.Spec spec : PaperSettingKeys.ALL) {
                if (spec.min() != null) {
                    double v = useMax ? spec.max() : spec.min();
                    patch.put(spec.key(), spec.type() == PaperSettingKeys.Type.INTEGER ? (Object) (int) v : v);
                }
            }
            // 마감 기한은 결정 시각보다 늦게(숫자 키가 아님)
            service.update(MAPPER.valueToTree(patch));
            JsonNode body = body();
            PaperSettings paper = PaperSettings.from(body);
            List<String> fallbacks = new ArrayList<>(paper.fallbacks());
            fallbacks.addAll(paper.blend().fallbacks());
            fallbacks.addAll(paper.rules().fallbacks());
            fallbacks.addAll(RuleBookService.RuleSettings.from(body).fallbacks());
            fallbacks.addAll(PaperSelectionService.TrackRecordSettings.from(body).fallbacks());
            fallbacks.addAll(ClaudeBookService.ClaudeSettings.from(body).fallbacks());
            fallbacks.addAll(EventsSection.settings(body).fallbacks());
            assertThat(fallbacks).as(useMax ? "최댓값" : "최솟값").isEmpty();
            PacketBuilder.Limits limits = PacketBuilder.Limits.from(body);
            assertThat(limits.maxPositions()).isEqualTo(body.path("maxPositions").asInt());
            assertThat(limits.maxDiscretionaryOrdersPerMonth())
                    .isEqualTo(body.path("maxDiscretionaryOrdersPerMonth").asInt());
            assertThat(limits.minHoldTradingDaysForSell()).isEqualTo(body.path("minHoldTradingDaysForSell").asInt());
            assertThat(limits.minOrderNotional()).isEqualTo(body.path("minOrderNotional").asDouble());
        }
    }

    private static void collectLeaves(JsonNode node, String prefix, List<String> out) {
        for (Map.Entry<String, JsonNode> field : node.properties()) {
            String path = prefix.isEmpty() ? field.getKey() : prefix + "." + field.getKey();
            if (field.getValue().isObject()) {
                collectLeaves(field.getValue(), path, out);
            } else {
                out.add(path);
            }
        }
    }
}
