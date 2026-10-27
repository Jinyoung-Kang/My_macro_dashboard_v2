package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCosts;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 책 설정 키(2단계 명세 §4-13 {@code kr.*}, C1b) — 기본값·시장 범위·규칙 계좌 경고, 키마다의 저장 규칙(빈 목록만·수집기가 받는 ETF만·
 * 미래 시행일 불가·장 시간 변경일의 개장·마감), 한국 결정 시각·기한의 창, 모르는 키 거절, 키를 더해도 저장된 행의 판이 오르지 않음.
 * 형 자체의 검사는 {@code PaperSettingTypesTest}, 미국 키는 {@code PaperSettingsServiceTest}가 봅니다.
 */
class PaperSettingsKrTest {

    /** 2026-10-27(화) 14:00 KST — '오늘'은 10-27. */
    private static final Instant NOW = Instant.parse("2026-10-27T05:00:00Z");

    private FakePaperStore store;
    private PaperSettingsService service;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        service = new PaperSettingsService(store, MAPPER, Clock.fixed(NOW, ZoneOffset.UTC));
        service.ensureInitialized();
    }

    private Map<String, Object> update(Object... keyAndValue) {
        return update(service, keyAndValue);
    }

    private static Map<String, Object> update(PaperSettingsService target, Object... keyAndValue) {
        Map<String, Object> patch = new LinkedHashMap<>();
        for (int i = 0; i < keyAndValue.length; i += 2) {
            patch.put((String) keyAndValue[i], keyAndValue[i + 1]);
        }
        return target.update(MAPPER.valueToTree(patch));
    }

    private JsonNode kr() {
        return store.settings().orElseThrow().body().path("kr");
    }

    private JsonNode keys() {
        return MAPPER.valueToTree(service.view().get("keys"));
    }

    private JsonNode key(String name) {
        for (JsonNode key : keys()) {
            if (name.equals(key.path("key").asString())) {
                return key;
            }
        }
        throw new AssertionError(name + " 키가 없습니다");
    }

    private static Map<String, Object> pair(String open, String close) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("open", open);
        out.put("close", close);
        return out;
    }

    @Test
    @DisplayName("한국 키 목록·순서와 기본값(§4-13) — 세율은 KrxCosts.TaxRates.KRX_2026, 피드 넷(yna_market 포함 — G12 사용자 결정), 키워드에 '원' 없음")
    void krKeysAndDefaults() {
        List<String> kr = new ArrayList<>();
        for (JsonNode key : keys()) {
            String name = key.path("key").asString();
            if (name.startsWith("kr.")) {
                kr.add(name);
                assertThat(key.path("market").asString()).as(name).isEqualTo("KR");
            }
        }
        assertThat(kr).containsExactly("kr.slippageBp", "kr.commissionBp", "kr.tax.kospi.sttBp", "kr.tax.kospi.ruralBp",
                "kr.tax.kosdaq.sttBp", "kr.tax.etfBp", "kr.tax.effectiveFrom", "kr.minOrderNotional", "kr.maxWeightStockPct",
                "kr.maxWeightEtfPct", "kr.maxPositions", "kr.maxDiscretionaryOrdersPerMonth", "kr.minHoldTradingDaysForSell",
                "kr.trailingStopPct", "kr.lockoutTradingDays", "kr.rulesMaxNames", "kr.rules.weighting",
                "kr.rules.minStreakDays", "kr.rules.debtRatioMaxPct", "kr.rules.reselection",
                "kr.rules.parkCashThresholdPct", "kr.cashLikeTickers", "kr.universeExtraTickers", "kr.decisionTimeKst",
                "kr.decisionDeadlineKst", "kr.calendar.extraClosures", "kr.calendar.openTimeOverrides", "kr.news.enabled",
                "kr.news.maxPerDay", "kr.news.keywords", "kr.news.feeds", "kr.news.aliases");

        JsonNode d = service.defaultsJson().path("kr");
        assertThat(d.path("slippageBp").asDouble()).isEqualTo(5);
        assertThat(d.path("commissionBp").asDouble()).isEqualTo(1.5);
        KrxCosts.TaxRates law = KrxCosts.TaxRates.KRX_2026;
        JsonNode tax = d.path("tax");
        assertThat(new KrxCosts.TaxRates(java.time.LocalDate.parse(tax.path("effectiveFrom").asString()),
                tax.path("kospi").path("sttBp").decimalValue(), tax.path("kospi").path("ruralBp").decimalValue(),
                tax.path("kosdaq").path("sttBp").decimalValue(), tax.path("etfBp").decimalValue())).isEqualTo(law);
        assertThat(tax.path("effectiveFrom").asString()).isEqualTo("2026-01-01");
        assertThat(d.path("minOrderNotional").asDouble()).isEqualTo(500_000);
        assertThat(List.of(d.path("maxWeightStockPct").asInt(), d.path("maxWeightEtfPct").asInt(), d.path("maxPositions").asInt(),
                d.path("maxDiscretionaryOrdersPerMonth").asInt(), d.path("minHoldTradingDaysForSell").asInt()))
                .as("미국 값과 같은 값").containsExactly(10, 20, 20, 20, 5);
        assertThat(List.of(d.path("trailingStopPct").asDouble(), d.path("lockoutTradingDays").asDouble(),
                d.path("rules").path("parkCashThresholdPct").asDouble())).containsExactly(8.0, 20.0, 2.0);
        assertThat(d.path("rulesMaxNames").asInt()).isEqualTo(15);
        assertThat(d.path("rules").path("weighting").asString()).isEqualTo("EQUAL");
        assertThat(d.path("rules").path("minStreakDays").asInt()).isZero();
        assertThat(d.path("rules").path("debtRatioMaxPct").asDouble()).isEqualTo(200);
        assertThat(d.path("rules").path("reselection").asString()).isEqualTo("MONTHLY_FIRST");
        assertThat(d.path("cashLikeTickers").toString()).isEqualTo("[\"153130\"]");
        assertThat(d.path("universeExtraTickers").toString()).isEqualTo("[]");
        assertThat(d.path("decisionTimeKst").asString()).isEqualTo("22:30");
        assertThat(d.path("decisionDeadlineKst").asString()).isEqualTo("01:00");
        assertThat(d.path("calendar").toString()).isEqualTo("{\"extraClosures\":[],\"openTimeOverrides\":{}}");
        JsonNode news = d.path("news");
        assertThat(news.path("enabled").asBoolean()).isTrue();
        assertThat(news.path("maxPerDay").asInt()).isEqualTo(10);
        assertThat(news.path("feeds").toString()).isEqualTo("[\"bok_press\",\"mofe_press\",\"mods_press\",\"yna_market\"]");
        assertThat(news.path("aliases").toString()).isEqualTo("{}");
        List<String> keywords = new ArrayList<>();
        news.path("keywords").forEach(k -> keywords.add(k.asString()));
        assertThat(keywords).hasSize(23).contains("기준금리", "부동산 PF", "밸류업").doesNotContain("원");

        // 형 이름(화면 settingKind)·선택지
        assertThat(key("kr.tax.effectiveFrom").path("type").asString()).isEqualTo("date");
        assertThat(key("kr.calendar.extraClosures").path("type").asString()).isEqualTo("dates");
        assertThat(key("kr.calendar.openTimeOverrides").path("type").asString()).isEqualTo("dateTimeMap");
        assertThat(key("kr.news.aliases").path("type").asString()).isEqualTo("aliasMap");
        assertThat(key("kr.decisionTimeKst").path("type").asString()).isEqualTo("time");
        assertThat(key("kr.cashLikeTickers").path("type").asString()).isEqualTo("list");
        assertThat(key("kr.news.keywords").path("type").asString()).isEqualTo("phrases");
        assertThat(key("kr.rules.weighting").path("options").toString()).isEqualTo("[\"EQUAL\",\"SCORE\"]");
        assertThat(key("kr.rules.reselection").path("options").toString()).isEqualTo("[\"MONTHLY_FIRST\",\"TWICE_MONTHLY\"]");
        assertThat(key("kr.news.feeds").path("options").isNull()).isTrue();
        assertThat(key("kr.news.feeds").path("description").asString()).contains("yna_market").contains("사용자 결정");
        assertThat(key("kr.minOrderNotional").path("max").asDouble()).isEqualTo(100_000_000);

        // 규칙 계좌 영향 — 한국 규칙 계좌(kr_rules)가 읽는 키만
        for (String rules : List.of("kr.slippageBp", "kr.commissionBp", "kr.tax.kospi.sttBp", "kr.tax.kospi.ruralBp",
                "kr.tax.kosdaq.sttBp", "kr.tax.etfBp", "kr.tax.effectiveFrom", "kr.minOrderNotional", "kr.maxWeightStockPct",
                "kr.maxWeightEtfPct", "kr.trailingStopPct", "kr.lockoutTradingDays", "kr.rulesMaxNames",
                "kr.rules.weighting", "kr.rules.minStreakDays", "kr.rules.debtRatioMaxPct", "kr.rules.reselection",
                "kr.rules.parkCashThresholdPct", "kr.cashLikeTickers")) {
            assertThat(key(rules).path("affectsRules").asBoolean()).as(rules).isTrue();
        }
        for (String plain : List.of("kr.maxPositions", "kr.maxDiscretionaryOrdersPerMonth", "kr.minHoldTradingDaysForSell",
                "kr.universeExtraTickers", "kr.decisionTimeKst", "kr.decisionDeadlineKst", "kr.calendar.extraClosures",
                "kr.calendar.openTimeOverrides", "kr.news.enabled", "kr.news.maxPerDay", "kr.news.keywords",
                "kr.news.feeds", "kr.news.aliases")) {
            assertThat(key(plain).path("affectsRules").asBoolean()).as(plain).isFalse();
        }
    }

    @Test
    @DisplayName("한국 규칙 계좌 영향 키를 바꾸면 한국 문장의 경고, 둘 다면 미국 · 한국, 한국 Claude 전용 키는 경고 없음")
    void krRulesWarning() {
        assertThat(update("kr.slippageBp", 7).get("warning"))
                .isEqualTo("한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다");
        assertThat(update("kr.news.maxPerDay", 5, "kr.maxPositions", 12).get("warning")).isNull();
        assertThat(update("slippageBp", 6, "kr.tax.kospi.sttBp", 6).get("warning"))
                .isEqualTo(PaperSettingKeys.RULES_FROZEN_WARNING + " · " + PaperSettingKeys.KR_RULES_FROZEN_WARNING);
        assertThat(kr().path("tax").path("kospi").path("sttBp").asDouble()).isEqualTo(6);
        assertThat(kr().path("tax").path("kospi").path("ruralBp").asDouble()).as("같은 묶음의 다른 키는 그대로").isEqualTo(15);
    }

    @Test
    @DisplayName("kr.universeExtraTickers는 빈 목록만(결정 d6 — 수집기가 설정을 읽지 않음), 한국 티커 키는 6자리 코드만(소문자는 대문자로)")
    void universeExtraTickersOnlyEmpty() {
        assertThatThrownBy(() -> update("kr.universeExtraTickers", List.of("005930")))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("kr.universeExtraTickers: 빈 목록만")
                .hasMessageContaining("ADR 0008");
        assertThat(update("kr.universeExtraTickers", List.of()).get("changedKeys")).as("기본값과 같음").isEqualTo(List.of());
        assertThatThrownBy(() -> update("kr.universeExtraTickers", List.of("SPY"))).hasMessageContaining("6자리 종목 코드");
        assertThatThrownBy(() -> update("kr.cashLikeTickers", List.of("15313"))).hasMessageContaining("6자리 종목 코드");
        assertThatThrownBy(() -> update("kr.cashLikeTickers", List.of("SHY"))).hasMessageContaining("6자리 종목 코드");
        assertThat(store.settings().orElseThrow().version()).isEqualTo(1);
    }

    @Test
    @DisplayName("kr.cashLikeTickers는 수집기가 늘 받는 ETF(069500·153130)만 — 빈 목록(현금성 없음)은 받음")
    void cashLikeOnlyScopeEtfs() {
        assertThatThrownBy(() -> update("kr.cashLikeTickers", List.of("153130", "005930")))
                .hasMessageContaining("수집기가 늘 받는 ETF(069500·153130)만").hasMessageContaining("005930");
        assertThat(update("kr.cashLikeTickers", List.of(" 069500 ", "153130")).get("changedKeys"))
                .isEqualTo(List.of("kr.cashLikeTickers"));
        assertThat(kr().path("cashLikeTickers").toString()).isEqualTo("[\"069500\",\"153130\"]");
        assertThat(update("kr.cashLikeTickers", List.of()).get("changedKeys")).isEqualTo(List.of("kr.cashLikeTickers"));
    }

    @Test
    @DisplayName("kr.tax.effectiveFrom은 오늘(KST) 이하만(결정 d7) — 내일은 거절, 오늘·지난 날은 받음, 오늘은 KST 자정에 바뀜")
    void taxEffectiveFromNotInFuture() {
        assertThatThrownBy(() -> update("kr.tax.effectiveFrom", "2026-10-28"))
                .isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("kr.tax.effectiveFrom: 오늘(KST 2026-10-27)보다 늦은 시행일(2026-10-28)");
        assertThatThrownBy(() -> update("kr.tax.effectiveFrom", "2027-01-01")).hasMessageContaining("세율 모름");
        assertThat(update("kr.tax.effectiveFrom", "2026-10-27").get("changedKeys")).isEqualTo(List.of("kr.tax.effectiveFrom"));
        assertThat(update("kr.tax.effectiveFrom", "2025-01-01").get("changedKeys")).isEqualTo(List.of("kr.tax.effectiveFrom"));
        assertThatThrownBy(() -> update("kr.tax.effectiveFrom", "2026-1-1")).hasMessageContaining("yyyy-MM-dd");

        // 12-31 23:59 KST에는 01-01이 미래, 01-01 00:00 KST(UTC 12-31 15:00)부터 받음 — 서버 시간대(UTC)가 아니라 KST 날짜.
        PaperSettingsService before = new PaperSettingsService(store, MAPPER,
                Clock.fixed(Instant.parse("2026-12-31T14:59:00Z"), ZoneOffset.UTC));
        assertThatThrownBy(() -> update(before, "kr.tax.effectiveFrom", "2027-01-01")).hasMessageContaining("늦은 시행일");
        PaperSettingsService after = new PaperSettingsService(store, MAPPER,
                Clock.fixed(Instant.parse("2026-12-31T15:00:00Z"), ZoneOffset.UTC));
        assertThat(update(after, "kr.tax.effectiveFrom", "2027-01-01").get("changedKeys"))
                .isEqualTo(List.of("kr.tax.effectiveFrom"));
    }

    @Test
    @DisplayName("kr.calendar.openTimeOverrides(결정 d8) — 날짜마다 개장·마감 쌍, 개장은 수집기 1분봉 라벨의 09:00·10:00만, 마감은 20:00까지")
    void openTimeOverrides() {
        Map<String, Object> overrides = new LinkedHashMap<>();
        overrides.put("2026-11-19", pair("10:00", "16:30"));
        overrides.put("2027-01-04", pair("10:00", "15:30"));
        assertThat(update("kr.calendar.openTimeOverrides", overrides).get("changedKeys"))
                .isEqualTo(List.of("kr.calendar.openTimeOverrides"));
        assertThat(kr().path("calendar").path("openTimeOverrides").toString()).isEqualTo(
                "{\"2026-11-19\":{\"open\":\"10:00\",\"close\":\"16:30\"},\"2027-01-04\":{\"open\":\"10:00\",\"close\":\"15:30\"}}");
        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("2027-01-04", pair("10:00", "15:30"));
        reordered.put("2026-11-19", pair("10:00", "16:30"));
        assertThat(update("kr.calendar.openTimeOverrides", reordered).get("changedKeys")).as("순서만 다름 = 같은 값")
                .isEqualTo(List.of());

        assertThatThrownBy(() -> update("kr.calendar.openTimeOverrides", Map.of("2026-11-19", pair("09:30", "15:30"))))
                .hasMessageContaining("개장은 09:00·10:00만").hasMessageContaining("09:30");
        assertThatThrownBy(() -> update("kr.calendar.openTimeOverrides", Map.of("2026-11-19", pair("10:00", "20:30"))))
                .hasMessageContaining("마감은 20:00까지");
        assertThat(update("kr.calendar.openTimeOverrides", Map.of("2026-11-19", pair("09:00", "20:00"))).get("ok"))
                .as("경계 포함").isEqualTo(true);
        assertThat(update("kr.calendar.openTimeOverrides", Map.of()).get("changedKeys"))
                .isEqualTo(List.of("kr.calendar.openTimeOverrides"));
    }

    @Test
    @DisplayName("임시휴장일·별칭 표 — 정해진 모양으로 저장, 순서만 다른 같은 값은 판을 올리지 않음")
    void extraClosuresAndAliases() {
        Map<String, Object> aliases = new LinkedHashMap<>();
        aliases.put("005930", List.of("삼전"));
        aliases.put("000660", List.of("하이닉스", "SK 하이닉스"));
        Map<String, Object> out = update("kr.calendar.extraClosures", List.of("2026-12-30", "2026-11-02"),
                "kr.news.aliases", aliases);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("kr.calendar.extraClosures", "kr.news.aliases"));
        assertThat(out.get("warning")).isNull();
        assertThat(kr().path("calendar").path("extraClosures").toString()).isEqualTo("[\"2026-11-02\",\"2026-12-30\"]");
        assertThat(kr().path("news").path("aliases").toString())
                .isEqualTo("{\"000660\":[\"하이닉스\",\"SK 하이닉스\"],\"005930\":[\"삼전\"]}");
        int version = store.settings().orElseThrow().version();
        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("000660", List.of("하이닉스", "SK 하이닉스"));
        reordered.put("005930", List.of("삼전"));
        assertThat(update("kr.calendar.extraClosures", List.of("2026-11-02", "2026-12-30", "2026-11-02"),
                "kr.news.aliases", reordered).get("changedKeys")).isEqualTo(List.of());
        assertThat(store.settings().orElseThrow().version()).isEqualTo(version);
    }

    @Test
    @DisplayName("한국 결정 창 — 결정은 20:30~23:59 또는 00:00~08:59, 기한은 결정보다 이르거나 같으면 다음 날로 읽어 08:30까지(미국 '기한 ≥ 결정' 규칙은 한국 키에 안 걸림)")
    void krDecisionWindow() {
        assertThat(update("kr.decisionTimeKst", "20:30", "kr.decisionDeadlineKst", "08:30").get("ok"))
                .as("밤 결정 → 다음 날 08:30 기한(경계)").isEqualTo(true);
        assertThat(update("kr.decisionTimeKst", "23:50", "kr.decisionDeadlineKst", "00:10").get("ok")).isEqualTo(true);
        assertThat(update("kr.decisionTimeKst", "22:30", "kr.decisionDeadlineKst", "23:30").get("ok"))
                .as("기한이 결정보다 늦으면 같은 날").isEqualTo(true);
        assertThat(update("kr.decisionTimeKst", "07:00", "kr.decisionDeadlineKst", "08:30").get("ok"))
                .as("다음 날 아침 결정(G4 재검토 안)").isEqualTo(true);
        assertThat(update("kr.decisionTimeKst", "22:30", "kr.decisionDeadlineKst", "01:00").get("ok")).isEqualTo(true);

        assertThatThrownBy(() -> update("kr.decisionTimeKst", "15:00")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("kr.decisionTimeKst(15:00)").hasMessageContaining("20:30~23:59");
        assertThatThrownBy(() -> update("kr.decisionTimeKst", "20:29")).hasMessageContaining("kr.decisionTimeKst(20:29)");
        assertThatThrownBy(() -> update("kr.decisionTimeKst", "09:00")).hasMessageContaining("kr.decisionTimeKst(09:00)");
        assertThatThrownBy(() -> update("kr.decisionDeadlineKst", "08:31")).hasMessageContaining("08:30")
                .hasMessageContaining("kr.decisionDeadlineKst(08:31)");
        assertThatThrownBy(() -> update("kr.decisionDeadlineKst", "22:30")).as("같은 시각 = 다음 날 = 다음 개장 뒤")
                .hasMessageContaining("kr.decisionDeadlineKst(22:30)");
        assertThatThrownBy(() -> update("kr.decisionTimeKst", "07:00", "kr.decisionDeadlineKst", "06:00"))
                .as("아침 결정보다 이른 기한은 그다음 날").hasMessageContaining("kr.decisionDeadlineKst(06:00)");
        assertThatThrownBy(() -> update("kr.decisionTimeKst", "7:00")).hasMessageContaining("HH:mm");
        assertThat(kr().path("decisionTimeKst").asString()).as("거절된 저장은 아무것도 바꾸지 않음").isEqualTo("22:30");
        assertThat(kr().path("decisionDeadlineKst").asString()).isEqualTo("01:00");

        // 한국 키가 없는 옛 행에 한쪽만 쓰면 다른 쪽은 기본값으로 봄 — 22:30 기본 결정에 09:00 기한은 다음 개장 뒤.
        ((ObjectNode) store.settings.body()).remove("kr");
        assertThatThrownBy(() -> update("kr.decisionDeadlineKst", "09:00")).hasMessageContaining("kr.decisionTimeKst(22:30)");
        // 미국 규칙은 그대로 미국 키만 — 한국 기본값(01:00 < 22:30)이 미국 저장을 막지 않음.
        assertThat(update("decisionTimeKst", "07:00").get("ok")).isEqualTo(true);
        assertThatThrownBy(() -> update("decisionDeadlineKst", "06:00")).hasMessageContaining("decisionDeadlineKst(06:00)");
    }

    @Test
    @DisplayName("모르는 한국 키는 그대로 거절 — 묶음 이름만·묶음 자리에 값·없는 하위 키, 하나라도 틀리면 아무것도 바꾸지 않음")
    void unknownKrKeysRejected() {
        assertThatThrownBy(() -> update("kr.nope", 1)).hasMessageContaining("모르는 설정 키: kr.nope");
        assertThatThrownBy(() -> update("kr", 1)).hasMessageContaining("모르는 설정 키: kr");
        assertThatThrownBy(() -> update("kr", Map.of("tax", Map.of("kospi", Map.of("sttBp", 6, "extraBp", 1)))))
                .hasMessageContaining("모르는 설정 키: kr.tax.kospi.extraBp");
        assertThatThrownBy(() -> update("kr.slippageBp", 3, "kr.allowNextClose", true))
                .as("명세 K38 — 설정이 아닌 것(코드 상수)").hasMessageContaining("모르는 설정 키: kr.allowNextClose");
        assertThatThrownBy(() -> update("kr.reviewTimeKst", "22:30")).hasMessageContaining("모르는 설정 키: kr.reviewTimeKst");
        assertThatThrownBy(() -> update("kr.slippageBp", 101)).hasMessageContaining("kr.slippageBp: 0~100");
        assertThatThrownBy(() -> update("kr.rules.weighting", "RANDOM")).hasMessageContaining("EQUAL · SCORE");
        assertThat(store.settings().orElseThrow().version()).isEqualTo(1);
        assertThat(kr().path("slippageBp").asDouble()).isEqualTo(5);
    }

    @Test
    @DisplayName("한국 키를 더해도 저장된 행의 판은 그대로(C1b 전 행 = 한국 묶음 없음) — 미국 읽기 같음, 처음 쓴 한국 키만 판을 올림")
    void addingKrKeysDoesNotBumpTheStoredVersion() {
        ObjectNode old = (ObjectNode) store.settings.body();
        old.remove("kr");
        PaperSettings usBefore = service.current().settings();
        assertThat(service.current().version()).isEqualTo(1);
        assertThat(service.view().get("version")).isEqualTo(1);
        assertThat(MAPPER.valueToTree(service.view().get("defaults")).path("kr").path("slippageBp").asDouble())
                .as("화면은 기본값을 봄").isEqualTo(5);
        assertThat(service.current().settings()).isEqualTo(usBefore);

        Map<String, Object> out = update("kr.commissionBp", 2);
        assertThat(out.get("version")).isEqualTo(2);
        assertThat(out.get("changedKeys")).isEqualTo(List.of("kr.commissionBp"));
        assertThat(kr().toString()).as("그 키만 묶음에 — 다른 한국 키는 읽는 쪽이 기본값으로").isEqualTo("{\"commissionBp\":2.0}");
        assertThat(service.current().settings()).as("미국 판은 그대로").isEqualTo(usBefore);
    }
}
