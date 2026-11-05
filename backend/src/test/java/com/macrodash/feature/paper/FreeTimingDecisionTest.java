package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Order;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 자유 시점 판의 미국 결정 한 번(ADR 0027 결정 1·2·8 — 스위치 {@code claude.freeTiming}·{@code claude2.freeTiming}) — 공식 SDK를 실제로 돌리고 Claude
 * API 자리에 가짜 서버(127.0.0.1)를 둡니다(유료 호출 없음). 패킷은 가짜 빌더가 고정본 글자를 돌려줍니다(조립은 PacketBuilderTest).
 *
 * <p>보는 것: ① 스위치가 켜진 계좌만 켠 판(시스템 프롬프트·응답 스키마·패킷 프로필)으로 부르고, 끄면 다음 결정부터 끈 판 ② 분 단위 지정 시각 주문이
 * {@code AT_MINUTE} + {@code target_local} 행이 되고 다음 세션 하루짜리 ③ 시각이 없거나 범위 밖이면 그 주문만 거절 행(받은 값 그대로) ④ 순위는 기준
 * 시각 순 ⑤ 계좌1의 기존 장중 확인(종류 CHECKPOINT)은 늘 끈 판.
 *
 * <p>시각: 기준 거래일 d = 10-26(월), 지금 = 10-26 23:00Z(19:00 ET — 마감 뒤), 목표 세션 E = 10-27(화).
 */
class FreeTimingDecisionTest {

    private static final Instant NOW = Instant.parse("2026-10-26T23:00:00Z");
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    private static final String KEY = "sk-ant-test-FREE";
    private static final String USAGE = "{\"input_tokens\":21000,\"output_tokens\":3100,"
            + "\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}";

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PacketBuilder packets;
    private PaperSettingsService settings;
    private PaperLedgerService ledger;
    private HttpServer server;
    private String baseUrl;
    private final Deque<String[]> answers = new ArrayDeque<>();
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        store = new FakePaperStore();
        store.dbNow = NOW;
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.of(quotes(
                Instant.parse("2026-10-26T20:20:00Z"), bar("AAA", FRI, 99, MON, 100), bar("BBB", FRI, 49, MON, 50),
                bar("CCC", FRI, 19, MON, 20), bar("SHY", FRI, 82, MON, 82.5))));
        packets = mock(PacketBuilder.class);
        PacketBuilder.Packet off2 = packet(golden("packet-us-claude2-scheduled.json"));
        PacketBuilder.Packet off1 = packet(golden("packet-us-scheduled.json"));
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2), anyString(), any())).thenReturn(off2);
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_C2), anyString(), any()))
                .thenReturn(packet(golden("packet-us-claude2-c2-scheduled.json")));
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_FT), anyString(), any()))
                .thenReturn(packet(golden("packet-us-ft-claude2-scheduled.json")));
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE_FT), anyString(), any()))
                .thenReturn(packet(golden("packet-us-ft-claude-scheduled.json")));
        when(packets.build(any(), anyString(), anyBoolean(), any(), any())).thenReturn(off1);
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        ledger = new PaperLedgerService(store, marketData, MAPPER);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            requests.add(MAPPER.readTree(exchange.getRequestBody().readAllBytes()));
            String[] answer;
            synchronized (answers) {
                answer = answers.isEmpty() ? new String[]{"500", "{\"type\":\"error\",\"error\":{\"type\":\"api_error\","
                        + "\"message\":\"no answer queued\"}}"} : answers.poll();
            }
            byte[] bytes = answer[1].getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(Integer.parseInt(answer[0]), bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private static String golden(String name) {
        String text = new String(Golden.resourceBytes("paper/golden/" + name), StandardCharsets.UTF_8);
        return text.endsWith("\n") ? text.substring(0, text.length() - 1) : text;
    }

    private static PacketBuilder.Packet packet(String text) {
        return new PacketBuilder.Packet(MAPPER.readTree(text), text, PacketBuilder.sha256(text), List.of(), null);
    }

    private ClaudeBookService service() {
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger,
                PaperFixtures.config(), MAPPER, clock);
        AiService ai = new AiService(240, 60, 180);
        ReflectionTestUtils.setField(ai, "anthropicKey", KEY);
        ReflectionTestUtils.setField(ai, "anthropicBaseUrl", baseUrl);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        return new ClaudeBookService(store, reader, marketData, mock(PaperSelectionService.class), ledger, admin, packets,
                new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock), calls, ai, settings,
                PaperFixtures.config(), MAPPER, 30, clock);
    }

    private void active(String code) {
        store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(code, new BookState(code, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
    }

    private void set(String group, String key, boolean value) {
        ((ObjectNode) store.settings.body().get(group)).put(key, value);
    }

    private void answerJson(String json) {
        synchronized (answers) {
            answers.add(new String[]{"200", "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\","
                    + "\"model\":\"claude-sonnet-5-5\",\"content\":[{\"type\":\"text\",\"text\":" + MAPPER.writeValueAsString(json)
                    + "}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"usage\":" + USAGE + "}"});
        }
    }

    /** 주문 한 줄 — {@code atLocal}이 "-"면 그 칸을 아예 쓰지 않고, null이면 null로 씁니다. */
    private static String order(String ticker, String side, Double target, Double fraction, String timing, String atLocal) {
        String at = "-".equals(atLocal) ? "" : ",\"atLocal\":" + (atLocal == null ? "null" : "\"" + atLocal + "\"");
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"" + side + "\",\"targetWeightPct\":" + target + ",\"sellFraction\":"
                + fraction + ",\"timing\":\"" + timing + "\"" + at + ",\"executionNote\":\"" + timing + " — 갭 위험\",\"thesis\":\""
                + ticker + " 논거\",\"labels\":[\"사실\"],\"invalidation\":\"200일선 이탈\"}";
    }

    private static String buy(String ticker, double target, String timing, String atLocal) {
        return order(ticker, "BUY", target, null, timing, atLocal);
    }

    private static String decision(String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"RISK_ON\",\"targetEquityExposurePct\":10,\"exposureRationale\":\"r\","
                + "\"summary\":\"자유 시점 판단\",\"orders\":[" + String.join(",", orders) + "],\"noTradeReason\":null,"
                + "\"confidence\":0.6}";
    }

    private String[] sent() {
        JsonNode request = requests.get(requests.size() - 1);
        return new String[]{request.path("system").get(0).path("text").asString(),
                request.path("messages").get(0).path("content").asString(),
                Golden.prettyJson(request.path("output_config").path("format").path("schema"))};
    }

    private Order orderOf(String book, String ticker) {
        return store.ordersOf(book).stream().filter(o -> o.ticker().equals(ticker)).findFirst().orElseThrow();
    }

    @Test
    @DisplayName("계좌2: claude2.freeTiming을 켠 결정만 켠 판(프롬프트·스키마·패킷 프로필 고정본) — 장중 확인 판(claude2.checkpoints)보다 우선, 끄면 다음 결정부터 끈 판 그대로. "
            + "AT_MINUTE 주문은 target_local과 함께 다음 세션 하루짜리 대기 주문, 시각이 없거나 범위 밖이면 그 주문만 거절 행(받은 값 그대로)")
    void claude2SwitchSelectsTheVariantAndAtMinuteOrdersBecomeRows() {
        active(PaperBooks.CLAUDE2);
        set("claude2", "checkpoints", true);
        set("claude2", "freeTiming", true);
        answerJson(decision(buy("AAA", 5, "AT_MINUTE", "10:47"), buy("BBB", 5, "AT_MINUTE", null),
                buy("CCC", 3, "AT_MINUTE", "15:55"), buy("SHY", 4, "NEXT_CLOSE", "10:00")));

        Decision d = service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null,
                null, true).decision();

        assertThat(d.error()).isNull();
        assertThat(d.status()).isEqualTo("OK");
        String[] on = sent();
        Golden.assertMatches("render-us-ft-claude2-v0-default.txt", on[0]);
        Golden.assertMatches("packet-us-ft-claude2-scheduled.json", on[1]);
        Golden.assertMatches("decision-schema-forapi-us-ft.json", on[2]);
        assertThat(on[0]).contains("AT_MINUTE").contains("atLocal").contains("## 투자 성향").doesNotContain("AT_1000")
                .doesNotContain("## 장중 확인(고정)").doesNotContain("실시간");
        assertThat(on[2]).contains("atLocal").contains("AT_MINUTE").doesNotContain("AT_1000").doesNotContain("checkpoint");
        verify(packets).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_FT), eq(RuleBookService.SCHEDULED), any());
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_C2), anyString(), any());
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2), anyString(), any());

        Order minute = orderOf(PaperBooks.CLAUDE2, "AAA");
        assertThat(minute.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(minute.timing()).isEqualTo(PaperBooks.AT_MINUTE);
        assertThat(minute.targetLocal()).isEqualTo(LocalTime.of(10, 47));
        assertThat(minute.expiresOn()).as("다음 세션 하루짜리").isEqualTo(TUE);
        assertThat(minute.reason().path("proposed").path("atLocal").asString()).isEqualTo("10:47");
        assertThat(ExecutionAudit.targetAt(minute, TUE, UsPaperMarket.INSTANCE.calendar()))
                .as("장부가 세는 기준 시각 = 10-27 10:47 ET").isEqualTo(Instant.parse("2026-10-27T14:47:00Z"));

        Order missing = orderOf(PaperBooks.CLAUDE2, "BBB");
        assertThat(missing.status()).isEqualTo("REJECTED");
        assertThat(missing.rejectReason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
        assertThat(missing.timing()).isEqualTo(PaperBooks.AT_MINUTE);
        assertThat(missing.targetLocal()).as("시각을 지어내지 않음").isNull();
        assertThat(missing.reason().path("validation").asString()).contains(FreeTiming.MISSING_TIME);
        assertThat(missing.reason().path("proposed").path("atLocal").isNull()).isTrue();

        Order outside = orderOf(PaperBooks.CLAUDE2, "CCC");
        assertThat(outside.status()).isEqualTo("REJECTED");
        assertThat(outside.rejectReason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
        assertThat(outside.targetLocal()).as("거절 행은 받은 시각 그대로").isEqualTo(LocalTime.of(15, 55));
        assertThat(outside.reason().path("validation").asString()).contains("09:31~15:54 ET");

        Order close = orderOf(PaperBooks.CLAUDE2, "SHY");
        assertThat(close.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(close.timing()).isEqualTo(PaperBooks.NEXT_CLOSE);
        assertThat(close.targetLocal()).as("다른 시점의 atLocal은 보지 않음").isNull();

        JsonNode verdicts = d.response().path("validation");
        assertThat(verdicts.get(0).path("timing").asString()).isEqualTo("AT_MINUTE");
        assertThat(verdicts.get(0).path("atLocal").asString()).isEqualTo("10:47");
        assertThat(verdicts.get(1).has("atLocal")).as("시각을 읽지 못한 주문").isFalse();
        assertThat(d.response().toString()).as("검증 표의 열쇠는 기록에 남기지 않음 — 근거 문구 안의 표기 말고는").doesNotContain("\"timing\":\"AT_MINUTE@");

        // 끄면 다음 결정부터 끈 판(여기서는 장중 확인 판 c2 — 켜기 전 그대로).
        store.decisions.clear();
        set("claude2", "freeTiming", false);
        answerJson(decision());
        service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null, null, true);
        String[] off = sent();
        Golden.assertMatches("render-us-claude2-c2-v0-default.txt", off[0]);
        Golden.assertMatches("decision-schema-forapi-us-claude2-c2.json", off[2]);
        verify(packets).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_C2), eq(RuleBookService.SCHEDULED), any());
    }

    @Test
    @DisplayName("순위는 기준 시각 순 — 14:00 전량 매도는 10:00 매수의 현금을 만들지 못해 그 매수가 OVER_ALLOCATED, 09:45 매도는 10:00 매수의 자리를 만듦")
    void ranksFollowTheTargetTime() {
        active(PaperBooks.CLAUDE2);
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, 0, 100_000, 100_000, 100, FRI_CLOSE, FRI_CLOSE, FRI, null));
        // 최소 보유 거래일(5)을 넘긴 보유 — 10-01에 연 것.
        LocalDate opened = LocalDate.of(2026, 10, 1);
        Instant openedAt = Instant.parse("2026-10-01T20:20:00Z");
        store.upsertPosition(new com.macrodash.store.PaperStore.Position(PaperBooks.CLAUDE2, "AAA", 500, 100, opened, openedAt, 100,
                openedAt, 100.0, FRI_CLOSE, false, MON, 100, null));
        store.upsertPosition(new com.macrodash.store.PaperStore.Position(PaperBooks.CLAUDE2, "BBB", 1_000, 50, opened, openedAt, 50,
                openedAt, 50.0, FRI_CLOSE, false, MON, 50, null));
        set("claude2", "freeTiming", true);
        answerJson(decision(order("AAA", "SELL", null, 1.0, "AT_MINUTE", "14:00"), buy("CCC", 10, "AT_MINUTE", "10:00"),
                order("BBB", "SELL", null, 1.0, "AT_MINUTE", "09:45"), buy("SHY", 10, "AT_MINUTE", "10:00")));

        Decision d = service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null,
                null, true).decision();

        assertThat(d.error()).isNull();
        List<String> statuses = store.ordersOf(PaperBooks.CLAUDE2).stream().map(o -> o.ticker() + " " + o.status()
                + (o.rejectReason() == null ? "" : " " + o.rejectReason())).toList();
        // 보유 AAA 50% + BBB 50% = 100%. 10:00 시점에는 09:45의 BBB 매도(50%)만 자리를 만들었으므로 10:00 매수 둘(각 10%)은 들어가고,
        // 14:00의 AAA 매도는 10:00 매수의 자리를 만들지 못합니다 — 그 매도가 없어도 100% 안이라 둘 다 통과.
        assertThat(statuses).contains("AAA PENDING", "BBB PENDING", "CCC PENDING", "SHY PENDING");

        // 09:45 매도를 빼면 10:00 매수의 자리가 없습니다(14:00 매도는 더 늦음).
        store.decisions.clear();
        store.orders.clear();
        answerJson(decision(order("AAA", "SELL", null, 1.0, "AT_MINUTE", "14:00"), buy("CCC", 10, "AT_MINUTE", "10:00")));
        service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null, null, true);
        Order late = orderOf(PaperBooks.CLAUDE2, "CCC");
        assertThat(late.status()).isEqualTo("REJECTED");
        assertThat(late.rejectReason()).isEqualTo(com.macrodash.analytics.OrderValidator.OVER_ALLOCATED);
        assertThat(late.reason().path("validation").asString()).contains("다음 세션 10:00 ET");
        assertThat(orderOf(PaperBooks.CLAUDE2, "AAA").status()).isEqualTo(PaperBooks.ORDER_PENDING);
    }

    @Test
    @DisplayName("계좌1: claude.freeTiming을 켠 정기 결정은 켠 판(계좌2와 같은 스키마·고정 문단, 투자 성향 절 없음) — 시가 주문이 다음 세션 하루짜리. 끈 판 응답 시점"
            + "(NEXT_OBSERVATION)은 켠 판 스키마가 받지 않음. 기존 장중 확인(종류 CHECKPOINT)은 스위치가 켜져 있어도 끈 판 파이프라인")
    void claude1SwitchSelectsTheVariantButNotForTheOldCheckpoint() {
        active(PaperBooks.CLAUDE);
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);
        answerJson(decision(buy("AAA", 5, "NEXT_OPEN", null), buy("BBB", 5, "AT_MINUTE", "09:31")));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.error()).isNull();
        String[] on = sent();
        Golden.assertMatches("render-us-ft-claude-v0-default.txt", on[0]);
        Golden.assertMatches("packet-us-ft-claude-scheduled.json", on[1]);
        Golden.assertMatches("decision-schema-forapi-us-ft.json", on[2]);
        assertThat(on[0]).doesNotContain("## 투자 성향").doesNotContain("timing은 NEXT_OBSERVATION");
        verify(packets, never()).build(any(), anyString(), anyBoolean(), any(), any());
        Order open = orderOf(PaperBooks.CLAUDE, "AAA");
        assertThat(open.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(open.timing()).isEqualTo(PaperBooks.NEXT_OPEN);
        assertThat(open.expiresOn()).as("시각 지정 방식 — 다음 세션 하루짜리").isEqualTo(TUE);
        Order first = orderOf(PaperBooks.CLAUDE, "BBB");
        assertThat(first.targetLocal()).as("받는 가장 이른 분").isEqualTo(LocalTime.of(9, 31));
        assertThat(first.status()).isEqualTo(PaperBooks.ORDER_PENDING);

        // 끈 판의 시점 글자는 켠 판 스키마(enum 셋)가 받지 않음 — 형식 오류로 남고 주문 행은 없음.
        store.decisions.clear();
        store.orders.clear();
        answerJson(decision(buy("AAA", 5, "NEXT_OBSERVATION", "-")));
        Decision bad = service().decide(MON, RuleBookService.SCHEDULED, true);
        assertThat(bad.status()).isEqualTo("FORMAT_ERROR");
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();

        // 계좌1의 기존 장중 확인 — 늘 끈 판(끈 판 패킷 빌더·끈 판 스키마).
        store.decisions.clear();
        answerJson("{\"schemaVersion\":2,\"stance\":\"NEUTRAL\",\"targetEquityExposurePct\":0,\"exposureRationale\":\"r\","
                + "\"summary\":\"s\",\"orders\":[],\"noTradeReason\":\"없음\",\"confidence\":0.5}");
        service().decideCheckpoint(MarketRun.of(UsPaperMarket.INSTANCE, store), MON);
        String[] checkpoint = sent();
        Golden.assertMatches("render-us-v0-default.txt", checkpoint[0]);
        Golden.assertMatches("decision-schema-forapi-us.json", checkpoint[2]);
        verify(packets, times(1)).build(any(), anyString(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("스위치가 꺼져 있으면(기본·키 없음) 두 계좌 모두 끈 판 그대로 — 켠 판 프로필로 패킷을 조립하지 않음")
    void switchesOffKeepTheOffVariants() {
        active(PaperBooks.CLAUDE);
        active(PaperBooks.CLAUDE2);
        ((ObjectNode) store.settings.body().get("claude")).remove("freeTiming");
        ((ObjectNode) store.settings.body().get("claude2")).remove("freeTiming");
        answerJson(decision());
        service().decide(MON, RuleBookService.SCHEDULED, true);
        String[] one = sent();
        answerJson(decision());
        service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null, null, true);
        String[] two = sent();

        Golden.assertMatches("render-us-v0-default.txt", one[0]);
        Golden.assertMatches("decision-schema-forapi-us.json", one[2]);
        Golden.assertMatches("render-us-claude2-v0-default.txt", two[0]);
        Golden.assertMatches("decision-schema-forapi-us-claude2.json", two[2]);
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_FT), anyString(), any());
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE_FT), anyString(), any());
    }
}
