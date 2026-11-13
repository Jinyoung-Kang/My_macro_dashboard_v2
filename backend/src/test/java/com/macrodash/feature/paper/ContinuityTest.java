package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.io.InputStream;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 판단 이어받기(ADR 0038)의 스위치·고정 문단·응답 스키마·재료 읽기. 패킷 조립은 {@code PacketBuilderTest}·{@code KrPacketBuilderTest}·
 * {@code CheckpointPacketTest}, 호출 경로는 {@code FreeTimingDecisionTest}가 봅니다.
 */
class ContinuityTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final LocalDate FRI = LocalDate.of(2026, 10, 23);
    private static final Instant FRI_CLOSE = Instant.parse("2026-10-23T20:00:00Z");

    private FakePaperStore store;
    private PaperSettingsService settings;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        settings = PaperFixtures.settings(store);
    }

    private static JsonNode schema(String resource) throws Exception {
        try (InputStream in = ContinuityTest.class.getClassLoader().getResourceAsStream(resource)) {
            assertThat(in).as(resource).isNotNull();
            return MAPPER.readTree(in);
        }
    }

    @Test
    @DisplayName("스위치: 기본 꺼짐(키가 없는 행도 꺼짐), 시장마다 따로, 자유 시점 판 프로필에만 든다")
    void switchIsOffByDefaultAndOnlyForFreeTiming() {
        JsonNode defaults = settings.defaultsJson();
        assertThat(Continuity.on(defaults, false)).isFalse();
        assertThat(Continuity.on(defaults, true)).isFalse();
        assertThat(Continuity.on(MAPPER.createObjectNode(), false)).as("키가 없는 지금 설정 행").isFalse();
        assertThat(Continuity.on((JsonNode) null, true)).isFalse();

        ObjectNode body = (ObjectNode) defaults.deepCopy();
        body.put("continuity", true);
        assertThat(Continuity.on(body, false)).isTrue();
        assertThat(Continuity.on(body, true)).as("미국 스위치는 한국을 켜지 않음").isFalse();
        assertThat(Continuity.on(ClaudeBookProfile.US_CLAUDE_FT, body)).isTrue();
        assertThat(Continuity.on(ClaudeBookProfile.US_CLAUDE2_FT, body)).isTrue();
        assertThat(Continuity.on(ClaudeBookProfile.US_CLAUDE, body)).as("자유 시점 판이 아닌 계좌1").isFalse();
        assertThat(Continuity.on(ClaudeBookProfile.US_CLAUDE2, body)).isFalse();
        assertThat(Continuity.on(ClaudeBookProfile.KR_CLAUDE_FT, body)).isFalse();
        ((ObjectNode) body.get("kr")).put("continuity", true);
        assertThat(Continuity.on(ClaudeBookProfile.KR_CLAUDE_FT, body)).isTrue();
        assertThat(Continuity.on(ClaudeBookProfile.KR_CLAUDE2_FT, body)).isTrue();
        assertThat(Continuity.on(ClaudeBookProfile.KR_CLAUDE, body)).isFalse();
        ((ObjectNode) body).put("continuity", "true");
        assertThat(Continuity.on(body, false)).as("불리언이 아니면 꺼짐").isFalse();
    }

    @Test
    @DisplayName("고정 문단: 켠 결정만 이어받기 절이 출력 절 앞(계좌2는 성향 절 다음)에 붙고, 끄면 글자 그대로 — 한국도 같은 절")
    void renderInsertsTheSectionOnlyWhenOn() {
        JsonNode frame = FrameworkService.interimBody(MAPPER);
        ObjectNode on = (ObjectNode) settings.defaultsJson().deepCopy();
        on.put("continuity", true);
        ((ObjectNode) on.get("kr")).put("continuity", true);
        for (ClaudeBookProfile profile : List.of(ClaudeBookProfile.US_CLAUDE_FT, ClaudeBookProfile.US_CLAUDE2_FT,
                ClaudeBookProfile.KR_CLAUDE_FT, ClaudeBookProfile.KR_CLAUDE2_FT)) {
            String plain = FrameworkService.render(profile, frame, 0, settings.defaultsJson());
            String carried = FrameworkService.render(profile, frame, 0, on);
            assertThat(plain).as(profile.code()).doesNotContain("## 이어받기(고정)");
            assertThat(carried.replace(ClaudePrompts.CONTINUITY_SECTION, "")).as(profile.code() + " — 절을 빼면 그대로").isEqualTo(plain);
            assertThat(carried.indexOf("## 이어받기(고정)")).as(profile.code() + " — 출력 절 바로 앞")
                    .isEqualTo(carried.indexOf(ClaudePrompts.OUTPUT_HEADER) - ClaudePrompts.CONTINUITY_SECTION.length());
            if (profile.code().endsWith("claude2")) {
                assertThat(carried.indexOf("## 이어받기(고정)")).as("성향 절 다음").isGreaterThan(carried.indexOf("## 투자 성향"));
            }
        }
        for (ClaudeBookProfile profile : List.of(ClaudeBookProfile.US_CLAUDE, ClaudeBookProfile.US_CLAUDE2,
                ClaudeBookProfile.KR_CLAUDE, ClaudeBookProfile.KR_CLAUDE2)) {
            assertThat(FrameworkService.render(profile, frame, 0, on)).as(profile.code() + " — 끈 판은 스위치와 무관")
                    .isEqualTo(FrameworkService.render(profile, frame, 0, settings.defaultsJson()));
        }
        Golden.assertMatches("render-kr-ft-claude2-v0-continuity.txt",
                FrameworkService.render(ClaudeBookProfile.KR_CLAUDE2_FT, frame, 0, on));
    }

    @Test
    @DisplayName("응답 스키마: 이어받기 판(ft3)은 자유 시점 판 스키마에 세 칸(바라는 노출·계획·조건)만 더한 것이고, 절에 적은 길이·개수가 스키마와 같다. "
            + "조건의 종목 칸(판 2)은 필수 문자열 — 계좌 전체 조건은 빈 글자(선택·null 칸을 늘리지 않음)")
    void schemaAddsExactlyThreeFields() throws Exception {
        for (String[] pair : List.of(new String[]{"paper/us-decision-ft.schema.json", ClaudeDecisionPipeline.US_CONTINUITY_SCHEMA_RESOURCE},
                new String[]{"paper/kr-decision-ft.schema.json", ClaudeDecisionPipeline.KR_CONTINUITY_SCHEMA_RESOURCE})) {
            ObjectNode base = (ObjectNode) schema(pair[0]);
            ObjectNode extended = (ObjectNode) schema(pair[1]);
            ObjectNode properties = (ObjectNode) extended.get("properties");
            assertThat(properties.get("desiredEquityExposurePct")).isEqualTo(base.get("properties").get("targetEquityExposurePct"));
            assertThat(properties.get("exposurePlan").get("maxLength").asInt()).isEqualTo(600);
            assertThat(properties.get("conditions").get("maxItems").asInt()).isEqualTo(16);
            JsonNode item = properties.get("conditions").get("items");
            assertThat(item.get("properties").get("ticker")).isEqualTo(MAPPER.readTree("{\"type\":\"string\",\"maxLength\":12}"));
            List<String> itemRequired = new java.util.ArrayList<>();
            item.get("required").forEach(name -> itemRequired.add(name.asString()));
            assertThat(itemRequired).containsExactly("metric", "op", "level", "then", "ticker");
            assertThat(item.get("properties").get("then").get("maxLength").asInt()).isEqualTo(200);
            List<String> ops = new java.util.ArrayList<>();
            item.get("properties").get("op").get("enum").forEach(op -> ops.add(op.asString()));
            assertThat(ops).containsExactly(com.macrodash.analytics.CarriedConditions.ABOVE,
                    com.macrodash.analytics.CarriedConditions.BELOW);
            List<String> required = new java.util.ArrayList<>();
            extended.get("required").forEach(name -> required.add(name.asString()));
            assertThat(required).as("세 칸 모두 필수(선택 칸을 늘리지 않음)")
                    .contains("desiredEquityExposurePct", "exposurePlan", "conditions");
            properties.remove(List.of("desiredEquityExposurePct", "exposurePlan", "conditions"));
            required.removeAll(List.of("desiredEquityExposurePct", "exposurePlan", "conditions"));
            List<String> baseRequired = new java.util.ArrayList<>();
            base.get("required").forEach(name -> baseRequired.add(name.asString()));
            assertThat(required).isEqualTo(baseRequired);
            assertThat(properties).as(pair[1] + " — 세 칸을 빼면 자유 시점 판 스키마").isEqualTo(base.get("properties"));
            assertThat(StructuredSchema.load(pair[1]).forApi()).isNotEmpty();
        }
        assertThat(ClaudePrompts.CONTINUITY_SECTION).contains("exposurePlan(600자 이내)").contains("conditions(16건 이내)")
                .contains("계좌 전체의 조건이면 빈 문자열").contains("holdingChecks.met").contains("holdingChecks.missing")
                .contains("then은 충족되면 할 일(200자 이내)").contains("ABOVE(level 초과)·BELOW(level 미만)")
                .doesNotContainPattern("\\d{4}-\\d{2}-\\d{2}");
    }

    @Test
    @DisplayName("진입 논거: 그 종목을 가장 최근에 산 Claude 주문(체결된 매수)의 논거·무효화 조건 — 논거 없는 주문·매도·미체결·다른 출처는 건너뛴다")
    void entriesComeFromTheLatestFilledClaudeBuy() {
        long old = order("AAA", "BUY", "FILLED", "CLAUDE", reason("옛 논거", "옛 무효화"), FRI_CLOSE);
        long latest = order("AAA", "BUY", "FILLED", "CLAUDE", reason("새 논거", "새 무효화"), FRI_CLOSE.plusSeconds(60));
        order("AAA", "BUY", "PENDING", "CLAUDE", reason("대기", "대기"), FRI_CLOSE.plusSeconds(120));
        order("AAA", "SELL", "FILLED", "CLAUDE", reason("매도", "매도"), FRI_CLOSE.plusSeconds(180));
        order("BBB", "BUY", "FILLED", "CLAUDE", null, FRI_CLOSE);
        order("CCC", "BUY", "FILLED", "RULES", reason("규칙", "규칙"), FRI_CLOSE);
        order("DDD", "BUY", "FILLED", "CLAUDE", reason("가".repeat(400), null), FRI_CLOSE);

        Map<String, Continuity.Entry> entries = Continuity.entries(store, PaperBooks.CLAUDE, List.of("AAA", "BBB", "CCC", "DDD"));

        assertThat(entries).containsOnlyKeys("AAA", "DDD");
        assertThat(entries.get("AAA").thesis()).isEqualTo("새 논거");
        assertThat(entries.get("AAA").invalidation()).isEqualTo("새 무효화");
        assertThat(entries.get("AAA").asOf()).isEqualTo(FRI.toString());
        assertThat(entries.get("DDD").thesis()).hasSize(Continuity.THESIS_CHARS).endsWith("…");
        assertThat(entries.get("DDD").invalidation()).isNull();
        assertThat(old).isLessThan(latest);
        assertThat(Continuity.entries(store, PaperBooks.CLAUDE, List.of())).isEmpty();

        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        rows.add(new java.util.LinkedHashMap<>(Map.of("ticker", "AAA")));
        rows.add(new java.util.LinkedHashMap<>(Map.of("ticker", "BBB")));
        Continuity.attachEntries(rows, entries);
        assertThat(rows.get(0).get("entry")).isEqualTo(entries.get("AAA").toMap());
        assertThat(rows.get(1)).as("찾지 못한 종목은 null").containsEntry("entry", null);
        assertThat(Continuity.tickers(rows)).containsExactly("AAA", "BBB");
    }

    @Test
    @DisplayName("값 표: 미국 매크로 카드·하이일드, 한국 환율·외국인 순매수, 가격 섹션(열 이름으로), 장중 피드의 마지막 값, 한국 종목명")
    void metricTables() throws Exception {
        JsonNode macro = MAPPER.readTree("{\"cards\":{\"items\":[{\"key\":\"us10y\",\"price\":5.05},{\"key\":\"wti\",\"price\":78.1},"
                + "{\"key\":\"stale\"}]}}");
        JsonNode regime = MAPPER.readTree("{\"inputs\":{\"hyOas\":{\"value\":3.4}}}");
        assertThat(Continuity.usMacro(macro, regime)).containsExactly(Map.entry("us10y", 5.05), Map.entry("wti", 78.1),
                Map.entry("hyOas", 3.4));
        assertThat(Continuity.usMacro(MAPPER.readTree("{\"cards\":[{\"key\":\"vix\",\"value\":17.2}]}"), null))
                .as("목록 꼴 카드").containsExactly(Map.entry("vix", 17.2));
        assertThat(Continuity.usMacro(null, null)).isEmpty();

        JsonNode kr = MAPPER.readTree("{\"fx\":{\"items\":[{\"key\":\"usdkrw\",\"close\":1364}]},\"investorFlows\":{\"rows\":["
                + "{\"market\":\"KOSPI\",\"foreigner\":{\"sessionNet\":2496,\"net5\":-11495,\"net20\":null}}]}}");
        assertThat(Continuity.krMacro(kr)).containsExactly(Map.entry("usdkrw", 1364.0), Map.entry("kospiForeignNet", 2496.0),
                Map.entry("kospiForeignNet5", -11495.0));

        JsonNode prices = MAPPER.readTree("{\"columns\":[\"code\",\"name\",\"close\"],\"rows\":[[\"005930\",\"삼성전자\",10100],"
                + "[\"153130\",null,108020],[\"000660\",\"SK하이닉스\",null]]}");
        assertThat(Continuity.table(prices, "code", "close")).containsExactly(Map.entry("005930", 10100.0),
                Map.entry("153130", 108020.0));
        assertThat(Continuity.table(prices, "ticker", "close")).as("그 열이 없으면 빈 표").isEmpty();
        JsonNode night = MAPPER.createObjectNode().set(PacketBuilder.PRICES, prices);
        assertThat(Continuity.krNames(night, List.of("005930", "153130", "000660")))
                .containsExactly(Map.entry("005930", List.of("삼성전자")), Map.entry("000660", List.of("SK하이닉스")));
        Map<String, Object> prev = Continuity.prevCloses(night, "code", List.of("005930", "999999"));
        assertThat(prev.get("values")).isEqualTo(Map.of("005930", 10100.0));

        JsonNode feed = MAPPER.readTree("{\"tickers\":{\"AAPL\":{\"last\":230.1},\"069500\":{\"lastBar\":{\"c\":85810.0}},"
                + "\"NONE\":{}}}");
        assertThat(Continuity.feedLast(feed)).containsExactly(Map.entry("AAPL", 230.1), Map.entry("069500", 85810.0));
    }

    @Test
    @DisplayName("이어받은 섹션: 직전 결정이 없거나 이어받기 판 전의 결정이면 빈 목록과 그 까닭 — 조건을 지어내지 않는다")
    void carriedWithoutPriorIsEmpty() {
        Map<String, Object> none = Continuity.carried(null, Map.of("us10y", 5.0), List.of("us10y"));
        assertThat(none).containsEntry("note", Continuity.NOTE_NONE).containsEntry("fromDecision", null)
                .containsEntry("conditions", List.of()).containsEntry("watchlist", List.of())
                .containsEntry("desiredEquityExposurePct", null);
        assertThat(none.get("metrics")).isEqualTo(Map.of("names", List.of("us10y"), "note", Continuity.METRICS_NOTE));
    }

    @Test
    @DisplayName("보유 종목의 조건(판 2): 종목마다 그 종목에 조건을 적은 가장 최근 결정의 묶음 — 직전 결정이 빠뜨려도 남고, 다시 적으면 통째로 바뀌고, "
            + "그 종목을 산 결정보다 앞선 결정·거름 밖 결정·종목 없는 조건은 쓰지 않는다")
    void holdingChecksComeFromTheLatestDecisionThatNamedTheTicker() {
        long first = decision(FRI.minusDays(3), """
                [{"metric":"us10y","op":"ABOVE","level":5.0,"then":"XLP 논거 폐기","ticker":"XLP"},
                 {"metric":"XLP","op":"BELOW","level":70.0,"then":"매도","ticker":"xlp "},
                 {"metric":"brent","op":"ABOVE","level":95.0,"then":"DAL 매도","ticker":"DAL"},
                 {"metric":"OLD","op":"BELOW","level":10.0,"then":"옛 보유 때 조건","ticker":"OLD"},
                 {"metric":"vix","op":"ABOVE","level":30.0,"then":"노출 축소","ticker":""}]""");
        long second = decision(FRI.minusDays(2), """
                [{"metric":"brent","op":"ABOVE","level":98.0,"then":"DAL 매도(수준 올림)","ticker":"DAL"},
                 {"metric":"vix","op":"ABOVE","level":28.0,"then":"노출 축소"}]""");
        long third = decision(FRI.minusDays(1), "[]");
        long excluded = decision(FRI, """
                [{"metric":"XLP","op":"BELOW","level":1.0,"then":"지금 다시 만드는 결정","ticker":"XLP"}]""");
        // OLD는 second 뒤에 다시 산 종목 — 그 결정(third)보다 앞선 조건은 붙지 않는다.
        Map<String, Continuity.Entry> entries = Map.of("OLD", new Continuity.Entry(third, FRI.minusDays(1).toString(), "재진입", null),
                "XLP", new Continuity.Entry(first, FRI.minusDays(3).toString(), "방어주", "10년물 5% 재상승"));

        Map<String, Continuity.HoldingChecks> checks = Continuity.holdingChecks(store, PaperBooks.CLAUDE,
                List.of("XLP", "DAL", "OLD", "NEW"), entries, d -> d.asOfTradingDate().isBefore(FRI));

        assertThat(checks).containsOnlyKeys("XLP", "DAL");
        assertThat(checks.get("XLP").decisionId()).as("뒤 결정들이 XLP를 적지 않아도 남는다").isEqualTo(first);
        assertThat(checks.get("XLP").conditions()).extracting(com.macrodash.analytics.CarriedConditions.Condition::metric)
                .containsExactly("us10y", "XLP");
        assertThat(checks.get("DAL").decisionId()).as("다시 적은 결정의 묶음으로 통째로 바뀐다").isEqualTo(second);
        assertThat(checks.get("DAL").conditions()).singleElement().satisfies(c -> assertThat(c.level()).isEqualTo(98.0));
        assertThat(excluded).isGreaterThan(third);
        assertThat(Continuity.holdingChecks(store, PaperBooks.CLAUDE, List.of(), entries, d -> true)).isEmpty();

        // 보유 행에 붙이기 — 값 표: 10년물 5.125(> 5.0 충족), XLP 78(< 70 아님), 브렌트 96(> 98 아님). NEW·OLD는 조건 없음.
        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        for (String ticker : List.of("XLP", "DAL", "OLD", "NEW", "CASH")) {
            rows.add(new java.util.LinkedHashMap<>(Map.of("ticker", ticker)));
        }
        // 진입 논거 — OLD·NEW는 무효화 조건을 적었고, CASH(현금성)는 논거만 있어 옮겨 적을 것이 없다.
        Continuity.attachEntries(rows, Map.of("XLP", entries.get("XLP"),
                "OLD", new Continuity.Entry(third, null, "재진입", "200일선 이탈"), "NEW", new Continuity.Entry(third, null, "신규", "-10%"),
                "CASH", new Continuity.Entry(third, null, "대기 자금", null)));
        Map<String, Object> summary = Continuity.attachChecks(rows, checks, Map.of("us10y", 5.125, "XLP", 78.0, "brent", 96.0));
        JsonNode xlp = MAPPER.valueToTree(rows.get(0).get("checks"));
        assertThat(xlp.get("fromDecision").asLong()).isEqualTo(first);
        assertThat(xlp.get("asOf").asString()).isEqualTo(FRI.minusDays(3).toString());
        assertThat(xlp.get("conditions").get(0).get("status").asString()).isEqualTo("충족");
        assertThat(xlp.get("conditions").get(0).get("current").asDouble()).isEqualTo(5.125);
        assertThat(xlp.get("conditions").get(1).get("status").asString()).isEqualTo("미충족");
        assertThat(rows.get(2)).as("조건이 없는 보유는 null").containsEntry("checks", null);
        JsonNode view = MAPPER.valueToTree(summary);
        assertThat(view.get("note").asString()).isEqualTo(Continuity.HOLDING_CHECKS_NOTE);
        assertThat(view.get("met")).hasSize(1);
        assertThat(view.get("met").get(0).get("ticker").asString()).isEqualTo("XLP");
        assertThat(view.get("met").get(0).get("metric").asString()).isEqualTo("us10y");
        assertThat(view.get("met").get(0).get("then").asString()).isEqualTo("XLP 논거 폐기");
        assertThat(view.get("met").get(0).get("fromDecision").asLong()).isEqualTo(first);
        List<String> missing = new java.util.ArrayList<>();
        view.get("missing").forEach(m -> missing.add(m.asString()));
        assertThat(missing).as("무효화 조건을 적었는데 코드가 매길 조건이 없는 보유만 — 현금성은 재촉하지 않음").containsExactly("OLD", "NEW");
        assertThat(rows.get(4)).containsEntry("checks", null);
        // 조건을 남긴 결정이 없으면 보유 종목 전부가 missing이고 충족 목록은 비어 있다(조건을 지어내지 않음).
        JsonNode none = MAPPER.valueToTree(Continuity.attachChecks(rows, Map.of(), Map.of()));
        assertThat(none.get("met")).isEmpty();
        assertThat(none.get("missing")).hasSize(3);
    }

    @Test
    @DisplayName("조건 읽기: ticker가 없는 옛 판의 조건·빈 글자·공백은 종목 없음, 배열이 아니면 빈 목록")
    void conditionListReadsTheTicker() throws Exception {
        List<com.macrodash.analytics.CarriedConditions.Condition> list = Continuity.conditionList(MAPPER.readTree("""
                [{"metric":"us10y","op":"ABOVE","level":5.1,"then":"a"},
                 {"metric":"us10y","op":"ABOVE","level":5.1,"then":"b","ticker":""},
                 {"metric":"us10y","op":"ABOVE","level":5.1,"then":"c","ticker":"  "},
                 {"metric":"us10y","op":"ABOVE","level":5.1,"then":"d","ticker":" XLP "}]"""));
        assertThat(list).extracting(com.macrodash.analytics.CarriedConditions.Condition::ticker)
                .containsExactly(null, null, null, "XLP");
        assertThat(Continuity.conditionList(null)).isEmpty();
        assertThat(Continuity.conditionList(MAPPER.readTree("{\"metric\":\"x\"}"))).isEmpty();
    }

    /** 조건 목록만 남긴 검증된 결정 한 건(계좌1 정기). */
    private long decision(LocalDate day, String conditions) {
        ObjectNode response = MAPPER.createObjectNode();
        response.put("schemaVersion", 2);
        response.set("conditions", MAPPER.readTree(conditions));
        return store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.CLAUDE, day,
                RuleBookService.SCHEDULED, null, "OK", "claude-sonnet-5-5", null, 1, day, 40.0, null, null, null, response, null,
                null, List.of(), true, 900L, 0)).orElseThrow();
    }

    private static JsonNode reason(String thesis, String invalidation) {
        ObjectNode node = MAPPER.createObjectNode();
        node.put("thesis", thesis);
        if (invalidation != null) {
            node.put("invalidation", invalidation);
        }
        return node;
    }

    private long order(String ticker, String side, String status, String source, JsonNode reason, Instant createdAt) {
        return store.insertOrder(new Order(0, PaperBooks.CLAUDE, 7L, ticker, side, null, 5.0, null, "NEXT_CLOSE", source, status,
                null, reason, FRI, createdAt, null, "FILLED".equals(status) ? createdAt : null));
    }
}
