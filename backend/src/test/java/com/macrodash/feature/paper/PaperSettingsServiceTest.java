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
    @DisplayName("QA-182 계좌1 장중 확인 시각(claude.checkpointAtEt)은 읽는 쪽 범위(뉴욕 10:00~15:00) 밖이면 400·경계는 저장 — 손으로 고친 옛 행은 화면 fallbacks에 남기고 다른 키 저장은 막지 않음")
    @SuppressWarnings("unchecked")
    void claude1CheckpointTimeMustBeReadable() {
        for (String outside : List.of("09:45", "09:59", "15:01", "15:30", "23:00")) {
            assertThatThrownBy(() -> update(Claude1Checkpoint.AT_ET, outside)).as(outside)
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining(Claude1Checkpoint.AT_ET)
                    .hasMessageContaining("10:00~15:00");
        }
        assertThat(store.settings().orElseThrow().version()).as("아무것도 바꾸지 않음").isEqualTo(1);
        assertThat(update(Claude1Checkpoint.AT_ET, "10:00").get("version")).isEqualTo(2);
        assertThat(update(Claude1Checkpoint.AT_ET, "15:00").get("version")).isEqualTo(3);
        assertThat(Claude1Checkpoint.from(body()).atEt()).isEqualTo(Claude1Checkpoint.LATEST);
        assertThat((List<String>) service.view().get("fallbacks")).doesNotContain(Claude1Checkpoint.AT_ET);

        // 손으로 고친 옛 행 — 작업은 범위 밖 값을 12:00 ET로 읽으므로 화면이 그 키를 기본값으로 읽는다고 보여야 함.
        tools.jackson.databind.node.ObjectNode edited = (tools.jackson.databind.node.ObjectNode) body().deepCopy();
        ((tools.jackson.databind.node.ObjectNode) edited.get("claude")).put("checkpointAtEt", "16:30");
        store.saveSettings(edited, List.of(Claude1Checkpoint.AT_ET));
        assertThat((List<String>) service.view().get("fallbacks")).contains(Claude1Checkpoint.AT_ET);
        assertThat(update("slippageBp", 7).get("ok")).as("그 키를 고치지 않는 저장은 통과").isEqualTo(true);
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
        // 장중 판단만의 effort(ADR 0031 초안)는 기본 본문에 없는 유일한 키 — 없으면 effort를 따름(IntradayPolicy.effort).
        leaves.add(IntradayPolicy.EFFORT);
        assertThat(listed).as("기본값 본문의 키 + 장중 판단 effort = 화면에서 바꿀 수 있는 키").containsExactlyInAnyOrderElementsOf(leaves);

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

        assertThatThrownBy(() -> update("apiScheduledReserve", 101)).hasMessageContaining("0~100");
        assertThatThrownBy(() -> update("apiScheduledReserve", -1)).hasMessageContaining("0~100");
        assertThatThrownBy(() -> update("claude.schemaV3", "true")).hasMessageContaining("true·false");
        assertThatThrownBy(() -> update("calendar", true)).as("묶음 자리에 값").hasMessageContaining("모르는 설정 키: calendar");
        assertThatThrownBy(() -> update("claude.unknownSwitch", true)).hasMessageContaining("모르는 설정 키: claude.unknownSwitch");
    }

    @Test
    @DisplayName("자유 시점 판 스위치(ADR 0027 결정 2): 계좌별 넷 모두 기본 꺼짐·규칙 계좌 영향 없음, 키가 없는 옛 행은 꺼짐으로 읽고 판 그대로, 켜는 저장 한 번이 "
            + "판 +1, 계좌1 장중 확인(claude.checkpoint)과 함께 켜는 저장은 거절 — 같은 저장에서 장중 확인을 끄면 받음")
    void freeTimingSwitches() {
        JsonNode defaults = service.defaultsJson();
        for (String key : List.of("claude.freeTiming", "claude2.freeTiming", "kr.claude.freeTiming", "kr.claude2.freeTiming")) {
            assertThat(PaperSettingsService.valueAt(defaults, key).booleanValue()).as(key + " 기본").isFalse();
            PaperSettingKeys.Spec spec = PaperSettingKeys.find(key).orElseThrow();
            assertThat(spec.type()).as(key).isEqualTo(PaperSettingKeys.Type.BOOLEAN);
            assertThat(spec.affectsRules()).as(key).isFalse();
        }
        assertThat(PaperSettingKeys.find("claude.freeTiming").orElseThrow().scope()).isEqualTo(PaperSettingKeys.Scope.US);
        assertThat(PaperSettingKeys.find("claude2.freeTiming").orElseThrow().scope()).isEqualTo(PaperSettingKeys.Scope.CLAUDE2);
        assertThat(PaperSettingKeys.find("kr.claude.freeTiming").orElseThrow().scope()).isEqualTo(PaperSettingKeys.Scope.KR);
        assertThat(FreeTimingSettings.from(defaults)).isEqualTo(FreeTimingSettings.OFF);
        assertThat(FreeTimingSettings.from(null)).isEqualTo(FreeTimingSettings.OFF);
        assertThat(FreeTimingSettings.key(PaperBooks.KR_CLAUDE2)).isEqualTo("kr.claude2.freeTiming");
        assertThat(FreeTimingSettings.key(PaperBooks.RULES)).as("규칙 계좌의 체결 시각은 다른 키").isNull();
        // 세션마다 계좌별 장중 판단 횟수 — 기본 2, 저장 0~3(ADR 0031 초안), 시장마다 따로.
        assertThat(defaults.path("intradayMaxPerSession").asInt()).isEqualTo(2);
        assertThat(defaults.path("kr").path("intradayMaxPerSession").asInt()).isEqualTo(2);
        assertThat(PaperSettingKeys.find("intradayMaxPerSession").orElseThrow()).extracting(PaperSettingKeys.Spec::min,
                PaperSettingKeys.Spec::max, PaperSettingKeys.Spec::affectsRules).containsExactly(0.0, 3.0, false);
        assertThat(PaperSettingKeys.find("kr.intradayMaxPerSession").orElseThrow()).extracting(PaperSettingKeys.Spec::min,
                PaperSettingKeys.Spec::max, PaperSettingKeys.Spec::affectsRules).containsExactly(0.0, 3.0, false);
        assertThat(PaperSettingKeys.find("kr.intradayMaxPerSession").orElseThrow().scope()).isEqualTo(PaperSettingKeys.Scope.KR);

        // 이 키들이 없는 옛 행(서버의 지금 행) — 꺼짐으로 읽고 판 그대로.
        ((tools.jackson.databind.node.ObjectNode) body().get("claude")).remove("freeTiming");
        ((tools.jackson.databind.node.ObjectNode) body().get("claude2")).remove("freeTiming");
        ((tools.jackson.databind.node.ObjectNode) body()).remove("kr");
        assertThat(service.current().version()).isEqualTo(1);
        assertThat(FreeTimingSettings.from(body())).isEqualTo(FreeTimingSettings.OFF);

        Map<String, Object> out = update("claude2.freeTiming", true, "kr.claude.freeTiming", true);
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("claude2.freeTiming", "kr.claude.freeTiming"));
        assertThat(out.get("warning")).as("규칙 계좌 영향 키가 아님").isNull();
        FreeTimingSettings on = FreeTimingSettings.from(body());
        assertThat(on).isEqualTo(new FreeTimingSettings(false, true, true, false, 2, 2));
        assertThat(on.on(PaperBooks.CLAUDE2)).isTrue();
        assertThat(on.on(PaperBooks.KR_CLAUDE)).isTrue();
        assertThat(on.on(PaperBooks.CLAUDE)).isFalse();
        assertThat(on.on(PaperBooks.KR_RULES)).isFalse();
        assertThat(on.on(null)).isFalse();

        // 규칙 계좌 체결 시각(ADR 0027 결정 5) — 기본은 지금 그대로, AT_MINUTE이면 지정 시각이 범위 안이어야 저장됨. 규칙 계좌 영향 키라 경고가 붙음.
        assertThat(service.defaultsJson().path("rules").path("timing").asString()).isEqualTo("NEXT_OBSERVATION");
        assertThat(service.defaultsJson().path("kr").path("rules").path("timing").asString()).isEqualTo("NEXT_OPEN");
        for (String key : List.of("rules.timing", "rules.timingAtEt", "kr.rules.timing", "kr.rules.timingAtKst")) {
            assertThat(PaperSettingKeys.find(key).orElseThrow().affectsRules()).as(key).isTrue();
        }
        assertThat(PaperSettingKeys.find("rules.timing").orElseThrow().options()).isEqualTo(RuleTiming.US_OPTIONS);
        assertThat(PaperSettingKeys.find("kr.rules.timing").orElseThrow().options()).isEqualTo(RuleTiming.KR_OPTIONS);
        assertThatThrownBy(() -> update("rules.timing", "AT_MINUTE", "rules.timingAtEt", "16:00")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("rules.timingAtEt").hasMessageContaining("09:40~15:54 ET");
        assertThatThrownBy(() -> update("rules.timing", "AT_MINUTE", "rules.timingAtEt", "09:39")).as("개장 뒤 10분 안")
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("09:40~15:54 ET");
        assertThatThrownBy(() -> update("kr.rules.timing", "AT_MINUTE", "kr.rules.timingAtKst", "09:09")).as("한국 개장 뒤 10분 안")
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("09:10~15:19 KST");
        assertThatThrownBy(() -> update("rules.timing", "AT_1000")).isInstanceOf(InvalidRequestException.class);
        Map<String, Object> minute = update("rules.timing", "AT_MINUTE", "rules.timingAtEt", "10:47");
        assertThat(minute.get("changedKeys")).isEqualTo(List.of("rules.timing", "rules.timingAtEt"));
        assertThat((String) minute.get("warning")).as("규칙 계좌 영향 키").isNotNull();
        assertThat(RuleTiming.us(body())).isEqualTo(new RuleTiming("AT_MINUTE", java.time.LocalTime.of(10, 47)));
        assertThatThrownBy(() -> update("rules.timingAtEt", "08:00")).as("AT_MINUTE인 채로 시각만 범위 밖으로")
                .isInstanceOf(InvalidRequestException.class);
        update("rules.timing", "NEXT_OBSERVATION");

        // 계좌1: 기존 장중 확인과 함께 켤 수 없음(장중 확인이 시각 지정 대기 주문을 지우고 끈 판 시점으로 다시 냄).
        update("claude.checkpoint", true);
        assertThatThrownBy(() -> update("claude.freeTiming", true)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("claude.checkpoint").hasMessageContaining("claude.freeTiming").hasMessageContaining("함께 켤 수 없습니다");
        assertThat(FreeTimingSettings.from(body()).claude()).as("거절된 저장은 아무것도 바꾸지 않음").isFalse();
        Map<String, Object> both = update("claude.freeTiming", true, "claude.checkpoint", false);
        assertThat(both.get("changedKeys")).isEqualTo(List.of("claude.freeTiming", "claude.checkpoint"));
        assertThat(FreeTimingSettings.from(body()).claude()).isTrue();
        assertThatThrownBy(() -> update("claude.checkpoint", true)).as("켠 판에서 장중 확인을 다시 켜는 저장도 거절")
                .isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> update("claude.freeTiming", "yes")).as("불리언만").isInstanceOf(InvalidRequestException.class);

        // 장중 판단 횟수 — 0~3만 받고(사용자 결정 2026-11-06 최대 3회) 시장마다 따로 읽음(키가 없는 옛 행은 2). 읽은 값은 코드가 부를 수 있는
        // 순번 수(RuleBookService.INTRADAY_MAX)를 넘지 않음.
        assertThat(FreeTimingSettings.from(body()).intradayMax(PaperBooks.KR_CLAUDE)).as("kr 묶음이 없던 행 — 기본 2").isEqualTo(2);
        assertThatThrownBy(() -> update("intradayMaxPerSession", 4)).as("최대 3회(사용자 결정)").isInstanceOf(InvalidRequestException.class);
        update("intradayMaxPerSession", 3, "kr.intradayMaxPerSession", 3);
        assertThat(FreeTimingSettings.from(body()).intradayMax(PaperBooks.CLAUDE)).isEqualTo(Math.min(3, RuleBookService.INTRADAY_MAX));
        assertThat(FreeTimingSettings.from(body()).intradayMax(PaperBooks.KR_CLAUDE2)).isEqualTo(Math.min(3, RuleBookService.INTRADAY_MAX));
        update("intradayMaxPerSession", 1, "kr.intradayMaxPerSession", 0);
        FreeTimingSettings counts = FreeTimingSettings.from(body());
        assertThat(counts.intradayMax(PaperBooks.CLAUDE)).isEqualTo(1);
        assertThat(counts.intradayMax(PaperBooks.CLAUDE2)).isEqualTo(1);
        assertThat(counts.intradayMax(PaperBooks.KR_CLAUDE2)).isZero();
        assertThat(counts.intradayMax(PaperBooks.RULES)).isZero();
        update("intradayMaxPerSession", 2, "kr.intradayMaxPerSession", 2);
    }

    // QA-313: 리뷰 XC-3 — 설정 설명 kr.trailingStopPct가 '밤 잠정 평가가로 감지해 다음 거래일 시가 매도'만 적어, kr.stopWatch.mode=ON을 저장한 뒤에는
    // 장중 감시가 그 세션 안에 팔고 덮지 못한 종목만 다음 거래일 첫 분에 파는 실제 동작과 다름.
    @Test
    @DisplayName("QA-313 kr.trailingStopPct 설명은 kr.stopWatch.mode의 두 경우를 함께 적음 — OFF·SHADOW는 밤 감지 뒤 다음 거래일 시가, ON은 장중 감시와 덮지 못한 "
            + "종목의 다음 거래일 첫 분")
    void qa313KrStopDescriptionFollowsTheWatchSwitch() {
        String description = PaperSettingKeys.find("kr.trailingStopPct").orElseThrow().description();
        assertThat(description).contains("kr.stopWatch.mode가 OFF·SHADOW면 밤 잠정 평가가로 감지해 다음 거래일 시가 매도")
                .contains("ON이면 장중 감시가 그 세션 안에 팔고").contains("다음 거래일 첫 분(개장 10분 뒤) 지정 시각 매도");
    }

    @Test
    @DisplayName("장중 스탑 감시·장중 판단 최소·사건·effort 키(ADR 0031·0032 초안): 기본은 지금 동작(OFF·0·꺼짐·effort 없음), 형·범위·시장·규칙 계좌 영향, "
            + "키가 없는 옛 행은 같은 값으로 읽고 판 그대로, 감시 스위치는 그 시장 규칙 계좌 경고")
    void stopWatchAndIntradayPolicyKeys() {
        JsonNode defaults = service.defaultsJson();
        assertThat(defaults.path("stopWatch").path("mode").asString()).isEqualTo("OFF");
        assertThat(defaults.path("kr").path("stopWatch").path("mode").asString()).isEqualTo("OFF");
        assertThat(defaults.path("intradayMinPerSession").asInt(-1)).isZero();
        assertThat(defaults.path("kr").path("intradayMinPerSession").asInt(-1)).isZero();
        assertThat(defaults.path("intradayEvents").asBoolean(true)).isFalse();
        assertThat(defaults.path("kr").path("intradayEvents").asBoolean(true)).isFalse();
        assertThat(defaults.has("intradayEffort")).as("없으면 effort를 따름 — 기본 본문에 넣지 않음").isFalse();
        assertThat(StopWatchMode.of(defaults, false)).isEqualTo(StopWatchMode.OFF);
        assertThat(StopWatchMode.of(defaults, true)).isEqualTo(StopWatchMode.OFF);
        assertThat(IntradayPolicy.from(defaults)).isEqualTo(IntradayPolicy.OFF);
        assertThat(IntradayPolicy.effort(defaults, "high")).isEqualTo("high");

        // 키 표 — 형·범위·시장·규칙 계좌 영향.
        PaperSettingKeys.Spec us = PaperSettingKeys.find("stopWatch.mode").orElseThrow();
        assertThat(us.type()).isEqualTo(PaperSettingKeys.Type.CHOICE);
        assertThat(us.options()).containsExactly("OFF", "SHADOW", "ON");
        assertThat(us.affectsRules()).as("규칙 계좌의 스탑 시점이 바뀜").isTrue();
        assertThat(us.scope()).isEqualTo(PaperSettingKeys.Scope.US);
        PaperSettingKeys.Spec kr = PaperSettingKeys.find("kr.stopWatch.mode").orElseThrow();
        assertThat(kr.options()).containsExactly("OFF", "SHADOW", "ON");
        assertThat(kr.affectsRules()).isTrue();
        assertThat(kr.scope()).isEqualTo(PaperSettingKeys.Scope.KR);
        for (String key : List.of("intradayMinPerSession", "kr.intradayMinPerSession")) {
            assertThat(PaperSettingKeys.find(key).orElseThrow()).as(key).extracting(PaperSettingKeys.Spec::type, PaperSettingKeys.Spec::min,
                    PaperSettingKeys.Spec::max, PaperSettingKeys.Spec::affectsRules).containsExactly(PaperSettingKeys.Type.INTEGER, 0.0, 1.0, false);
        }
        for (String key : List.of("intradayEvents", "kr.intradayEvents")) {
            assertThat(PaperSettingKeys.find(key).orElseThrow()).as(key).extracting(PaperSettingKeys.Spec::type, PaperSettingKeys.Spec::affectsRules)
                    .containsExactly(PaperSettingKeys.Type.BOOLEAN, false);
        }
        assertThat(PaperSettingKeys.find("kr.intradayEvents").orElseThrow().scope()).isEqualTo(PaperSettingKeys.Scope.KR);
        PaperSettingKeys.Spec effort = PaperSettingKeys.find("intradayEffort").orElseThrow();
        assertThat(effort.scope()).as("두 책 공통").isEqualTo(PaperSettingKeys.Scope.SHARED);
        assertThat(effort.options()).isEqualTo(ClaudeBookService.EFFORTS);
        assertThat(effort.affectsRules()).isFalse();

        // 이 키들이 없는 옛 행(서버의 지금 행) — 같은 값으로 읽고 판 그대로.
        tools.jackson.databind.node.ObjectNode old = (tools.jackson.databind.node.ObjectNode) body();
        old.remove(List.of("stopWatch", "intradayMinPerSession", "intradayEvents"));
        ((tools.jackson.databind.node.ObjectNode) old.get("kr")).remove(List.of("stopWatch", "intradayMinPerSession", "intradayEvents"));
        assertThat(service.current().version()).isEqualTo(1);
        assertThat(StopWatchMode.of(body(), false)).isEqualTo(StopWatchMode.OFF);
        assertThat(StopWatchMode.of(body(), true)).isEqualTo(StopWatchMode.OFF);
        assertThat(IntradayPolicy.from(body())).isEqualTo(IntradayPolicy.OFF);

        // 쓰기 검사 — 범위·형·선택지 밖은 아무것도 바꾸지 않음.
        assertThatThrownBy(() -> update("stopWatch.mode", "AUTO")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> update("kr.stopWatch.mode", true)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> update("intradayMinPerSession", 2)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> update("kr.intradayEvents", "true")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> update("intradayEffort", "ultra")).isInstanceOf(InvalidRequestException.class);
        assertThat(service.current().version()).isEqualTo(1);

        // 감시 스위치는 그 시장 규칙 계좌 경고, 장중 판단 키는 경고 없음.
        assertThat(update("stopWatch.mode", "SHADOW").get("warning")).isEqualTo(PaperSettingKeys.RULES_FROZEN_WARNING);
        assertThat(update("kr.stopWatch.mode", "ON").get("warning")).isEqualTo(PaperSettingKeys.KR_RULES_FROZEN_WARNING);
        assertThat(StopWatchMode.of(body(), false)).isEqualTo(StopWatchMode.SHADOW);
        assertThat(StopWatchMode.of(body(), false).watching()).isTrue();
        assertThat(StopWatchMode.of(body(), false).orders()).isFalse();
        assertThat(StopWatchMode.of(body(), true)).isEqualTo(StopWatchMode.ON);
        assertThat(StopWatchMode.of(body(), true).orders()).isTrue();
        Map<String, Object> intraday = update("intradayMinPerSession", 1, "intradayEvents", true, "kr.intradayMinPerSession", 1,
                "intradayEffort", "medium");
        assertThat(intraday.get("warning")).isNull();
        IntradayPolicy policy = IntradayPolicy.from(body());
        assertThat(policy).isEqualTo(new IntradayPolicy(1, 1, true, false));
        assertThat(policy.minPerSession(PaperBooks.CLAUDE2)).isEqualTo(1);
        assertThat(policy.minPerSession(PaperBooks.KR_CLAUDE)).isEqualTo(1);
        assertThat(policy.minPerSession(PaperBooks.RULES)).as("Claude 계좌 넷 밖").isZero();
        assertThat(policy.events(PaperBooks.CLAUDE)).isTrue();
        assertThat(policy.events(PaperBooks.KR_CLAUDE2)).isFalse();
        assertThat(policy.events(PaperBooks.KR_RULES)).isFalse();
        assertThat(IntradayPolicy.effort(body(), "high")).isEqualTo("medium");
        assertThat(ClaudeBookService.ClaudeSettings.from(body()).effort()).as("결정의 effort는 그대로").isEqualTo("high");

        // 손으로 고친 틀린 값은 그 키만 기본으로.
        tools.jackson.databind.node.ObjectNode broken = (tools.jackson.databind.node.ObjectNode) body();
        broken.putObject("stopWatch").put("mode", "on");
        broken.put("intradayMinPerSession", 5);
        broken.put("intradayEffort", "turbo");
        assertThat(StopWatchMode.of(body(), false)).isEqualTo(StopWatchMode.OFF);
        assertThat(IntradayPolicy.from(body()).minUs()).isZero();
        assertThat(IntradayPolicy.effort(body(), "high")).isEqualTo("high");
        assertThat(StopWatchMode.of(null, true)).isEqualTo(StopWatchMode.OFF);
        assertThat(IntradayPolicy.from(null)).isEqualTo(IntradayPolicy.OFF);
    }

    @Test
    @DisplayName("계좌2 키(claude2.*, 계좌2 명세 §13-2): 꺼짐·소상한 2·기다림 15·체결 기록 켬·장중 확인 꺼짐·투자 성향 공격투자형이 기본(11-02에 적극투자형에서 바꿈), 범위 CLAUDE2(시장 US)·규칙 계좌 영향 없음, 형·범위대로 검사 — 키가 없는 옛 행은 같은 값으로 읽히고 판이 오르지 않음")
    void claude2Keys() {
        JsonNode defaults = service.defaultsJson().path("claude2");
        assertThat(defaults.toString()).isEqualTo("{\"enabled\":false,\"maxCallsPerCycle\":2,\"barsWaitMinutes\":15,"
                + "\"executionRecord\":true,\"checkpoints\":false,\"riskProfile\":\"공격투자형\",\"freeTiming\":false}");
        List<String> keys = List.of("claude2.enabled", "claude2.maxCallsPerCycle", "claude2.barsWaitMinutes",
                "claude2.executionRecord", "claude2.checkpoints", "claude2.riskProfile", "claude2.freeTiming");
        for (String key : keys) {
            PaperSettingKeys.Spec spec = PaperSettingKeys.find(key).orElseThrow();
            assertThat(spec.scope()).as(key).isEqualTo(PaperSettingKeys.Scope.CLAUDE2);
            assertThat(spec.view().get("market")).as(key).isEqualTo("US");
            // 1분봉 기다림은 시각 지정 주문이 있는 모든 미국 책의 처리 지연을 정함 — 체결 시각을 정한 규칙 계좌 포함(ADR 0027 결정 5).
            assertThat(spec.affectsRules()).as(key).isEqualTo(key.equals("claude2.barsWaitMinutes"));
        }
        assertThat(PaperSettingKeys.find("claude2.maxCallsPerCycle").orElseThrow())
                .extracting(PaperSettingKeys.Spec::min, PaperSettingKeys.Spec::max).containsExactly(0.0, 10.0);
        assertThat(PaperSettingKeys.find("claude2.barsWaitMinutes").orElseThrow())
                .extracting(PaperSettingKeys.Spec::min, PaperSettingKeys.Spec::max).containsExactly(0.0, 30.0);
        PaperSettingKeys.Spec profile = PaperSettingKeys.find("claude2.riskProfile").orElseThrow();
        assertThat(profile.type()).isEqualTo(PaperSettingKeys.Type.CHOICE);
        assertThat(profile.options()).containsExactly("공격투자형", "적극투자형", "위험중립형", "안정추구형");
        assertThat(Claude2Settings.from(service.defaultsJson())).isEqualTo(Claude2Settings.DEFAULTS);
        assertThat(Claude2Settings.from(null)).isEqualTo(Claude2Settings.DEFAULTS);
        assertThatThrownBy(() -> new PaperSettingKeys.Spec("claude2.x", PaperSettingKeys.Type.BOOLEAN, null, null,
                List.of(), false, "", PaperSettingKeys.Scope.US)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new PaperSettingKeys.Spec("x", PaperSettingKeys.Type.BOOLEAN, null, null,
                List.of(), false, "", PaperSettingKeys.Scope.CLAUDE2)).isInstanceOf(IllegalStateException.class);

        // 이 키가 없는 옛 행(서버의 지금 행) — 판 그대로, 기본값으로 읽음(기본값으로 읽은 키를 남김), 켜는 저장 한 번이 판 +1.
        ((tools.jackson.databind.node.ObjectNode) body()).remove("claude2");
        assertThat(service.current().version()).isEqualTo(1);
        Claude2Settings old = Claude2Settings.from(body());
        assertThat(old.enabled()).isFalse();
        assertThat(old.maxCallsPerCycle()).isEqualTo(2);
        assertThat(old.barsWaitMinutes()).isEqualTo(15);
        assertThat(old.riskProfile()).as("키가 없는 옛 행도 기본 성향(사용자 결정 2026-11-01, 11-02에 공격투자형으로)").isEqualTo("공격투자형");
        assertThat(old.fallbacks()).as("자유 시점 판 스위치(claude2.freeTiming)는 FreeTimingSettings가 읽음 — 없으면 꺼짐, 여기 남기지 않음")
                .containsExactlyElementsOf(keys.subList(0, 6));
        assertThat(FreeTimingSettings.from(body())).isEqualTo(FreeTimingSettings.OFF);
        Map<String, Object> switches = new LinkedHashMap<>();
        switches.put("enabled", true);
        switches.put("maxCallsPerCycle", 2);
        Map<String, Object> out = update("apiScheduledReserve", 9, "claude2", switches);
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("apiScheduledReserve", "claude2.enabled",
                "claude2.maxCallsPerCycle"));
        assertThat(out.get("warning")).as("규칙 계좌가 읽지 않는 키").isNull();
        assertThat(Claude2Settings.from(body()).enabled()).isTrue();

        assertThatThrownBy(() -> update("claude2.maxCallsPerCycle", 11)).hasMessageContaining("0~10");
        assertThatThrownBy(() -> update("claude2.barsWaitMinutes", 31)).hasMessageContaining("0~30");
        assertThatThrownBy(() -> update("claude2.enabled", "true")).hasMessageContaining("true·false");
        assertThatThrownBy(() -> update("claude2.riskProfile", "안정형")).hasMessageContaining("공격투자형 · 적극투자형 · 위험중립형 · 안정추구형");
        Map<String, Object> chosen = update("claude2.riskProfile", "안정추구형");
        assertThat(chosen.get("changedKeys")).isEqualTo(List.of("claude2.riskProfile"));
        assertThat(Claude2Settings.from(body()).riskProfile()).isEqualTo("안정추구형");
        assertThatThrownBy(() -> update("claude2.unknown", true)).hasMessageContaining("모르는 설정 키: claude2.unknown");
    }

    @Test
    @DisplayName("시장 범위(2단계 §4-13) — 공유 키는 market null(메모 두 키 포함 — 사용자 결정 v6)·나머지는 US, 규칙 계좌 경고는 그 시장 문장(미국 키만이면 지금 문장 그대로)")
    void marketScopeAndRulesWarningPerMarket() {
        JsonNode keys = MAPPER.valueToTree(service.view().get("keys"));
        List<String> shared = new ArrayList<>();
        for (JsonNode key : keys) {
            assertThat(key.has("market")).as(key.path("key").asString()).isTrue();
            if (key.path("market").isNull()) {
                shared.add(key.path("key").asString());
                assertThat(key.path("affectsRules").asBoolean()).as("공유 키는 규칙 계좌 영향 없음").isFalse();
            } else {
                String name = key.path("key").asString();
                assertThat(key.path("market").asString()).as(name).isEqualTo(name.startsWith("kr.") ? "KR" : "US");
            }
        }
        assertThat(shared).containsExactly("model", "effort", "intradayEffort", "apiDailyCallCap", "apiScheduledReserve",
                "notesDefaultExpiryTradingDays", "notesMaxCharsInPacket", "frameworkTokenBudget",
                "pricing.sonnet.inputUsdPerMTok", "pricing.sonnet.outputUsdPerMTok", "pricing.sonnet.cacheReadUsdPerMTok",
                "pricing.sonnet.cacheWriteUsdPerMTok", "pricing.haiku.inputUsdPerMTok", "pricing.haiku.outputUsdPerMTok",
                "pricing.haiku.cacheReadUsdPerMTok", "pricing.haiku.cacheWriteUsdPerMTok",
                "calendar.consensus", "claude.schemaV3", "notify.telegram", "claude.figureCheck");

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
            // 한국 키(C1b)도 — 장부·검증기 한도는 kr. 접두어 묶음으로(시험용 한국 묶음의 접두어도 kr.), 세율·요율은 그 값을 받을
            // KrxCosts(C2가 읽음)의 범위 안.
            PaperSettings kr = PaperSettings.from(body, TestKrMarket.INSTANCE);
            assertThat(kr.fallbacks()).as("한국 " + (useMax ? "최댓값" : "최솟값")).isEmpty();
            assertThat(kr.rules().fallbacks()).isEmpty();
            JsonNode krBody = body.path("kr");
            assertThat(kr.slippageBp()).isEqualTo(krBody.path("slippageBp").asDouble());
            assertThat(kr.trailingStopPct()).isEqualTo(krBody.path("trailingStopPct").asDouble());
            assertThat(kr.lockoutTradingDays()).isEqualTo(krBody.path("lockoutTradingDays").asInt());
            PacketBuilder.Limits krLimits = PacketBuilder.Limits.from(body, TestKrMarket.INSTANCE);
            assertThat(krLimits).isEqualTo(new PacketBuilder.Limits(krBody.path("maxWeightStockPct").asDouble(),
                    krBody.path("maxWeightEtfPct").asDouble(), krBody.path("maxPositions").asInt(),
                    krBody.path("minOrderNotional").asDouble(), krBody.path("maxDiscretionaryOrdersPerMonth").asInt(),
                    krBody.path("minHoldTradingDaysForSell").asInt()));
            JsonNode tax = krBody.path("tax");
            new com.macrodash.analytics.KrxCosts.Rates(krBody.path("commissionBp").decimalValue(),
                    krBody.path("slippageBp").decimalValue(), new com.macrodash.analytics.KrxCosts.TaxRates(
                    java.time.LocalDate.parse(tax.path("effectiveFrom").asString()),
                    tax.path("kospi").path("sttBp").decimalValue(), tax.path("kospi").path("ruralBp").decimalValue(),
                    tax.path("kosdaq").path("sttBp").decimalValue(), tax.path("etfBp").decimalValue()));
            // 장부가 읽는 한국 비용 요율(C2b)도 기본값으로 바꾸지 않고 그 값 그대로.
            assertThat(kr.costRates().fallbacks()).as("한국 비용 요율 " + (useMax ? "최댓값" : "최솟값")).isEmpty();
            com.macrodash.analytics.KrxCosts.Rates read = kr.costRates().rates(kr.slippageBp());
            assertThat(read.commissionBp()).isEqualByComparingTo(krBody.path("commissionBp").decimalValue());
            assertThat(read.slippageBp()).isEqualByComparingTo(krBody.path("slippageBp").decimalValue());
            assertThat(read.tax().kospiSttBp()).isEqualByComparingTo(tax.path("kospi").path("sttBp").decimalValue());
            assertThat(read.tax().kospiRuralBp()).isEqualByComparingTo(tax.path("kospi").path("ruralBp").decimalValue());
            assertThat(read.tax().kosdaqSttBp()).isEqualByComparingTo(tax.path("kosdaq").path("sttBp").decimalValue());
            assertThat(read.tax().etfBp()).isEqualByComparingTo(tax.path("etfBp").decimalValue());
            assertThat(read.tax().effectiveFrom()).isEqualTo(java.time.LocalDate.parse(tax.path("effectiveFrom").asString()));
        }
    }

    private static void collectLeaves(JsonNode node, String prefix, List<String> out) {
        for (Map.Entry<String, JsonNode> field : node.properties()) {
            String path = prefix.isEmpty() ? field.getKey() : prefix + "." + field.getKey();
            // 값이 객체인 키(날짜별 시각 표·별칭 표 — C1b)는 그 자체가 키 하나입니다.
            if (field.getValue().isObject() && PaperSettingKeys.find(path).isEmpty()) {
                collectLeaves(field.getValue(), path, out);
            } else {
                out.add(path);
            }
        }
    }
}
