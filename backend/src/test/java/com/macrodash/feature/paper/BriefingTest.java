package com.macrodash.feature.paper;

import com.macrodash.analytics.CarriedConditions;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.DecisionSummary;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 마감 브리핑의 순수 부분({@link Briefing}, ADR 0039): 설정 읽기, 사실 조립(없는 값은 null·조건은 코드가 매김·장부가 뒤처진 계좌의 참고), 글 만들기
 * (사실 줄 + 의견, 의견이 없으면 사실만), 응답 스키마.
 */
class BriefingTest {

    private static final LocalDate SESSION = LocalDate.of(2026, 11, 12);
    private static final LocalDate PREVIOUS = LocalDate.of(2026, 11, 11);
    private static final Instant CLOSE = Instant.parse("2026-11-12T21:00:00Z");
    private static final Instant NOW = Instant.parse("2026-11-12T21:30:00Z");

    private static JsonNode card(String key, String name, Double price, Double pct) {
        ObjectNode node = MAPPER.createObjectNode().put("key", key).put("name", name);
        node.put("price", price);
        node.put("pct", pct);
        return node;
    }

    private static Position position(String code, String ticker, int qty, double avgCost, Double last) {
        return new Position(code, ticker, qty, avgCost, PREVIOUS, CLOSE, avgCost, null, last, null, false, null, 0, null);
    }

    private static List<Briefing.BookData> books() {
        Book claude = new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌", 100_000, PREVIOUS, PaperBooks.ACTIVE, CLOSE);
        Book rules = new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 계좌", 100_000, PREVIOUS, PaperBooks.ACTIVE, CLOSE);
        List<NavRow> nav = List.of(new NavRow(PaperBooks.CLAUDE, PREVIOUS, 100_000, 60_000, 40_000, 40.0, true),
                new NavRow(PaperBooks.CLAUDE, SESSION, 99_000, 55_000, 44_000, 44.444, true));
        Fill stopFill = new Fill(1, 7, PaperBooks.CLAUDE, "AAA", "SELL", 5, 108.12345, 108.2, 2.5, 540.6, CLOSE, SESSION, "YAHOO", false, CLOSE);
        Order pending = new Order(9, PaperBooks.CLAUDE, 5L, "BBB", "BUY", null, 10.0, null, "AT_MINUTE", "CLAUDE", PaperBooks.ORDER_PENDING,
                null, null, SESSION, NOW, null, null, LocalTime.of(9, 40));
        DecisionSummary decision = new DecisionSummary(5, PaperBooks.CLAUDE, PREVIOUS, RuleBookService.SCHEDULED, CLOSE, "OK",
                "claude-sonnet-5-5", 15, 26, PREVIOUS, 45.0, "금리 부담으로 노출을 줄인다", null, true, 1, 0);
        List<CarriedConditions.Condition> conditions = List.of(
                new CarriedConditions.Condition("us10y", CarriedConditions.ABOVE, 5.1, "노출 축소 검토"),
                new CarriedConditions.Condition("AAA", CarriedConditions.BELOW, 100.0, "매도 검토", "AAA"),
                new CarriedConditions.Condition("cpi", CarriedConditions.ABOVE, 3.0, "직접 확인"));
        Briefing.BookData one = new Briefing.BookData(claude, new BookState(PaperBooks.CLAUDE, 55_000, 99_000, 44_000, 44.444, CLOSE, CLOSE,
                SESSION, CLOSE), nav, List.of(position(PaperBooks.CLAUDE, "AAA", 10, 100, 110.0), position(PaperBooks.CLAUDE, "ZZZ", 0, 50, 51.0),
                position(PaperBooks.CLAUDE, "NOP", 3, 20, null)), List.of(stopFill), List.of(7L), List.of(pending), List.of(decision), conditions);
        // 규칙 계좌 — 장부가 그 세션을 아직 처리하지 않음(순자산 줄이 전날까지).
        Briefing.BookData two = new Briefing.BookData(rules, new BookState(PaperBooks.RULES, 101_000, 101_000, 0, 0, CLOSE, CLOSE, PREVIOUS,
                CLOSE), List.of(new NavRow(PaperBooks.RULES, PREVIOUS, 101_000, 101_000, 0, 0, true)), List.of(), List.of(), List.of(), List.of(),
                List.of(), List.of());
        return List.of(one, two);
    }

    private static JsonNode facts(boolean korea) {
        List<JsonNode> macro = List.of(card("us10y", "미 10년", 5.125, 0.5), card("sp500", "S&P 500", 6800.12, -1.23),
                card("gold", "금", null, null), card("vix", "VIX", 20.0, 3.0));
        return MAPPER.valueToTree(Briefing.facts(korea ? "KR" : "US", SESSION, PREVIOUS, CLOSE, NOW, macro, books(), korea));
    }

    @Test
    @DisplayName("설정: 기본은 꺼짐·마감 30분 뒤 — 키가 없거나 형이 틀리거나 범위 밖(0~480)이면 꺼짐·기본 분, 시장별로 따로 읽음")
    void settings() {
        assertThat(Briefing.Settings.from(null, false)).isEqualTo(new Briefing.Settings(false, 30));
        ObjectNode body = MAPPER.createObjectNode();
        body.set("briefing", MAPPER.valueToTree(Briefing.defaultsBody()));
        assertThat(Briefing.Settings.from(body, false)).isEqualTo(new Briefing.Settings(false, 30));
        ((ObjectNode) body.get("briefing")).put("enabled", true).put("afterCloseMinutes", 45);
        body.putObject("kr").putObject("briefing").put("enabled", "true").put("afterCloseMinutes", 481);
        assertThat(Briefing.Settings.from(body, false)).isEqualTo(new Briefing.Settings(true, 45));
        assertThat(Briefing.Settings.from(body, true)).as("글자 true·범위 밖 분").isEqualTo(new Briefing.Settings(false, 30));
        ((ObjectNode) body.get("kr").get("briefing")).put("enabled", true).put("afterCloseMinutes", 330);
        assertThat(Briefing.Settings.from(body, true)).isEqualTo(new Briefing.Settings(true, 330));
    }

    @Test
    @DisplayName("사실: 매크로 카드는 정한 순서·정한 키만(값이 없으면 null), 계좌는 그 세션 순자산·일 변화·노출·보유(수량 0 제외)·체결(스탑 표시)·대기 주문·"
            + "그 세션 결정, 남긴 조건은 코드가 카드·보유 가격으로 매김 — 순자산 줄이 없는 계좌는 직전 값과 참고 한 줄(0으로 채우지 않음)")
    void factsAreBuiltByCode() {
        JsonNode facts = facts(false);
        assertThat(facts.get("market").asString()).isEqualTo("US");
        assertThat(facts.get("session").asString()).isEqualTo("2026-11-12");
        assertThat(facts.get("macro")).extracting(c -> c.get("key").asString()).as("US_MACRO 순서 — 목록에 없는 vix는 뺌")
                .containsExactly("sp500", "us10y", "gold");
        assertThat(facts.get("macro").get(2).get("price").isNull()).isTrue();

        JsonNode claude = facts.get("books").get(0);
        assertThat(claude.get("nav").asDouble()).isEqualTo(99_000.0);
        assertThat(claude.get("navDate").asString()).isEqualTo("2026-11-12");
        assertThat(claude.get("dayPct").asDouble()).isEqualTo(-1.0);
        assertThat(claude.get("exposurePct").asDouble()).isEqualTo(44.44);
        assertThat(claude.get("positionCount").asInt()).isEqualTo(2);
        assertThat(claude.get("positions")).extracting(p -> p.get("ticker").asString()).containsExactly("AAA", "NOP");
        assertThat(claude.get("positions").get(0).get("weightPct").asDouble()).isEqualTo(1.11);
        assertThat(claude.get("positions").get(0).get("unrealizedPct").asDouble()).isEqualTo(10.0);
        assertThat(claude.get("positions").get(1).get("weightPct").isNull()).as("마지막 가격이 없는 보유").isTrue();
        assertThat(claude.get("fills").get(0).toString())
                .isEqualTo("{\"ticker\":\"AAA\",\"side\":\"SELL\",\"qty\":5,\"price\":108.1235,\"stop\":true}");
        assertThat(claude.get("pending").get(0).toString())
                .isEqualTo("{\"ticker\":\"BBB\",\"side\":\"BUY\",\"timing\":\"AT_MINUTE\",\"at\":\"09:40\",\"source\":\"CLAUDE\"}");
        assertThat(claude.get("decisions").get(0).get("summary").asString()).isEqualTo("금리 부담으로 노출을 줄인다");
        assertThat(claude.get("conditions")).extracting(c -> c.get("metric").asString() + " " + c.get("status").asString())
                .containsExactly("us10y " + CarriedConditions.MET, "AAA " + CarriedConditions.NOT_MET, "cpi " + CarriedConditions.UNEVALUABLE);
        assertThat(claude.get("conditions").get(0).get("current").asDouble()).isEqualTo(5.125);
        assertThat(claude.get("conditions").get(2).get("current").isNull()).isTrue();
        assertThat(claude.get("conditions").get(1).get("ticker").asString()).as("종목을 붙인 조건(이어받기 판 2)").isEqualTo("AAA");
        assertThat(claude.get("conditions").get(0).has("ticker")).as("계좌 전체 조건은 이 칸이 없음").isFalse();

        JsonNode rules = facts.get("books").get(1);
        assertThat(rules.get("nav").asDouble()).as("직전 처리 기준").isEqualTo(101_000.0);
        assertThat(rules.get("navDate").asString()).isEqualTo("2026-11-11");
        assertThat(rules.get("dayPct").isNull()).as("그 세션 줄이 없으면 일 변화를 만들지 않음").isTrue();
        assertThat(facts.get("notes")).extracting(JsonNode::asString).containsExactly("장부가 이 세션을 아직 처리하지 않은 계좌가 있음 — 그 계좌의 순자산·체결은 직전 처리 기준");
        assertThat(facts(true).get("notes")).extracting(JsonNode::asString).as("한국 — 밤 장부 처리 전").contains(Briefing.KR_LEDGER_NOTE);
        assertThat(MAPPER.valueToTree(Briefing.facts("US", SESSION, PREVIOUS, CLOSE, NOW, List.of(), List.of(), false)).get("notes").get(0)
                .asString()).isEqualTo("매크로 카드 저장본이 없어 시장 값을 싣지 못함");
    }

    @Test
    @DisplayName("글: 제목·고지·한 줄·시장·계좌(체결·대기·조건)·참고 뒤에 의견 다섯 칸 — 값은 모두 MarkdownV2로 이스케이프하고 이모지가 없다. 의견이 없으면 "
            + "사실과 그 까닭만")
    void messageJoinsFactsAndOpinion() {
        ObjectNode response = MAPPER.createObjectNode().put("schemaVersion", 1).put("headline", "금리가 지배한 하루.")
                .put("reading", "10년물 5.1% 돌파가 밸류에이션을 눌렀다 — 다음 날 되돌리면 이 해석은 틀렸다.")
                .put("accounts", "조건대로 절반을 줄인 판단은 일관됐다.").put("strategy", "재진입은 조건이 풀린 뒤에 따진다.");
        response.putArray("tomorrow").add("10년물 5.1% 아래 복귀 여부").add(" ");
        response.putNull("caveats");
        String text = Briefing.message(facts(false), response, null);
        List<String> lines = text.lines().toList();
        assertThat(lines.get(0)).isEqualTo("*미국 마감 브리핑 — 2026\\-11\\-12*");
        assertThat(lines.get(1)).isEqualTo(PaperTelegram.esc(Briefing.DISCLAIMER));
        assertThat(text).contains("금리가 지배한 하루\\.")
                .contains("\\- S&P 500 6,800 \\(\\-1\\.23%\\)")
                .contains("\\- 미 10년 5\\.125 \\(\\+0\\.50%\\)")
                .contains("\\- 금 —")
                .contains("\\- Claude 계좌 — 순자산 99,000 \\(\\-1\\.00%\\), 노출 44\\.44%, 보유 2종목")
                .contains("  체결: AAA 매도 5주 @108\\.124\\(스탑\\)")
                .contains("  대기: BBB 매수 AT\\_MINUTE 09:40")
                .contains("  조건: us10y \\> 5\\.1 — 충족\\(지금 5\\.125\\)")
                .contains("  조건: cpi \\> 3 — 평가 불가")
                .contains("  조건: \\[AAA\\] AAA < 100 — 미충족\\(지금 110\\)")
                .contains("\\- 규칙 계좌 — 순자산 101,000, 노출 0%, 보유 0종목")
                .contains("참고: 장부가 이 세션을 아직 처리하지 않은 계좌가 있음")
                .contains("*해석*").contains("*계좌 판단*").contains("*다음 세션에 볼 것*").contains("\\- 10년물 5\\.1% 아래 복귀 여부")
                .contains("*매매 의견\\(주문 아님\\)*").doesNotContain("*한계*");
        assertThat(lines.stream().filter(l -> l.startsWith("\\- ") && l.strip().length() == 3)).as("빈 항목은 뺌").isEmpty();
        assertThat(text.codePoints().filter(cp -> cp >= 0x1F000).count()).as("이모지 없음").isZero();

        String factsOnly = Briefing.message(facts(true), null, "하루 호출 상한에 닿아 Claude를 부르지 않았습니다");
        assertThat(factsOnly).startsWith("*한국 마감 브리핑 — 2026\\-11\\-12*").contains("의견은 싣지 못했습니다 — 하루 호출 상한에 닿아 Claude를 부르지 않았습니다")
                .doesNotContain("*해석*").contains(PaperTelegram.esc("참고: " + Briefing.KR_LEDGER_NOTE));
        assertThat(Briefing.userMessage("{\"a\":1}")).contains(Briefing.INPUT_START + "\n{\"a\":1}\n" + Briefing.INPUT_END);
    }

    @Test
    @DisplayName("응답 스키마: 여섯 칸과 판 1 — 길이·개수를 넘거나 칸이 빠지면 막고, caveats는 null을 받는다. 지시문의 길이는 스키마와 같다")
    void schema() {
        StructuredSchema schema = StructuredSchema.load(Briefing.SCHEMA_RESOURCE);
        ObjectNode ok = MAPPER.createObjectNode().put("schemaVersion", 1).put("headline", "한 줄").put("reading", "해석")
                .put("accounts", "계좌").put("strategy", "의견");
        ok.putArray("tomorrow").add("볼 것");
        ok.putNull("caveats");
        assertThat(schema.validate(ok)).isEmpty();
        ObjectNode longHeadline = ok.deepCopy().put("headline", "가".repeat(121));
        assertThat(schema.validate(longHeadline)).isNotEmpty();
        ObjectNode many = ok.deepCopy();
        for (int i = 0; i < 5; i++) {
            ((tools.jackson.databind.node.ArrayNode) many.get("tomorrow")).add("더");
        }
        assertThat(schema.validate(many)).isNotEmpty();
        ObjectNode missing = ok.deepCopy();
        missing.remove("strategy");
        assertThat(schema.validate(missing)).isNotEmpty();
        assertThat(schema.validate(ok.deepCopy().put("schemaVersion", 2))).isNotEmpty();
        assertThat(schema.forApi()).isNotNull();
        assertThat(Briefing.PROMPT).contains("120자 이내").contains("700자 이내").contains("500자 이내").contains("160자 이내").contains("300자 이내")
                .contains("모의 매매의 입력으로 쓰이지 않는다");
        Map<String, Object> defaults = Briefing.defaultsBody();
        assertThat(defaults).containsEntry("enabled", false).containsEntry("afterCloseMinutes", 30);
    }
}
