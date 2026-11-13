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

    /** 장중 판단 예약을 적은 결정 — {@code checkpoints}는 배열 글자 그대로. */
    private static String decisionWith(String checkpoints, String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"RISK_ON\",\"targetEquityExposurePct\":10,\"exposureRationale\":\"r\","
                + "\"summary\":\"자유 시점 판단\",\"orders\":[" + String.join(",", orders) + "],\"noTradeReason\":null,"
                + "\"checkpoints\":" + checkpoints + ",\"confidence\":0.6}";
    }

    private static String checkpoint(String at, String feed, String watch, String question) {
        return "{\"at\":\"" + at + "\",\"feed\":\"" + feed + "\",\"watch\":" + watch + ",\"question\":\"" + question + "\"}";
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
        assertThat(on[2]).contains("atLocal").contains("AT_MINUTE").contains("\"checkpoints\"").doesNotContain("AT_1000")
                .as("끈 판의 장중 확인 요청 칸(checkpoint — 단수)은 없음").doesNotContain("\"checkpoint\"");
        assertThat(on[0]).contains("## 장중 판단(고정)").contains("nextCheckpoint");
        assertThat(d.response().has("intradayPlan")).as("예약도 남은 계획 행도 없으면 칸이 없음").isFalse();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, TUE)).isEmpty();
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
        assertThat(outside.reason().path("validation").asString()).contains("09:40~15:54 ET");

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
    @DisplayName("판단 이어받기(ADR 0038 — 설정 continuity): 자유 시점 판 결정만 이어받기 절이 붙은 시스템 프롬프트와 세 칸(바라는 노출·계획·조건)을 더 "
            + "받는 스키마로 부른다 — 그 칸이 빠진 응답은 형식 오류, 끄면 다음 결정부터 예전 판(고정본 그대로). 자유 시점 판이 아니면 스위치와 무관")
    void continuitySwitchAddsTheSectionAndSchemaFields() {
        active(PaperBooks.CLAUDE);
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);
        ((ObjectNode) store.settings.body()).put("continuity", true);
        String carried = "{\"schemaVersion\":2,\"stance\":\"NEUTRAL\",\"targetEquityExposurePct\":10,"
                + "\"desiredEquityExposurePct\":40,\"exposurePlan\":\"10년물이 내려오면 두 번에 나눠 좁힌다\",\"exposureRationale\":\"r\","
                + "\"summary\":\"이어받기 판단\",\"orders\":[" + buy("AAA", 5, "NEXT_CLOSE", null) + "],\"noTradeReason\":null,"
                + "\"conditions\":[{\"metric\":\"us10y\",\"op\":\"BELOW\",\"level\":4.75,\"then\":\"노출 확대 검토\",\"ticker\":\"\"}],"
                + "\"confidence\":0.6}";
        answerJson(carried);

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.error()).isNull();
        assertThat(d.status()).isEqualTo("OK");
        assertThat(d.response().get("desiredEquityExposurePct").asDouble()).isEqualTo(40.0);
        assertThat(d.response().get("conditions").get(0).get("metric").asString()).isEqualTo("us10y");
        String[] on = sent();
        Golden.assertMatches("render-us-ft-claude-v0-continuity.txt", on[0]);
        Golden.assertMatches("decision-schema-forapi-us-ft3.json", on[2]);
        assertThat(on[0]).contains("## 이어받기(고정)").contains("10b_carried").contains("desiredEquityExposurePct");
        assertThat(on[0].indexOf("## 이어받기(고정)")).as("장중 판단 절 다음, 출력 절 앞")
                .isGreaterThan(on[0].indexOf("## 장중 판단(고정)")).isLessThan(on[0].indexOf(ClaudePrompts.OUTPUT_HEADER));
        assertThat(on[0].replace(ClaudePrompts.CONTINUITY_SECTION, "")).as("이어받기 절을 빼면 자유 시점 판 프롬프트 그대로")
                .isEqualTo(FrameworkService.render(ClaudeBookProfile.US_CLAUDE_FT, FrameworkService.interimBody(MAPPER), 0,
                        settings.defaultsJson()));
        assertThat(on[2]).contains("\"desiredEquityExposurePct\"").contains("\"exposurePlan\"").contains("\"conditions\"");

        // 그 칸이 빠진 응답(예전 판 모양)은 형식 오류 — 주문이 나가지 않는다.
        answerJson(decision(buy("BBB", 5, "NEXT_CLOSE", null)));
        Decision missing = service().decide(TUE, RuleBookService.SCHEDULED, true);
        assertThat(missing.status()).isEqualTo(ClaudeBookService.STATUS_FORMAT_ERROR);
        assertThat(missing.error()).contains("desiredEquityExposurePct");

        // 끄면 다음 결정부터 예전 판 — 시스템 프롬프트·스키마가 고정본 그대로.
        ((ObjectNode) store.settings.body()).put("continuity", false);
        answerJson(decision(buy("CCC", 3, "NEXT_CLOSE", null)));
        Decision off = service().decide(TUE, RuleBookService.MANUAL, true);
        assertThat(off.error()).isNull();
        String[] plain = sent();
        Golden.assertMatches("render-us-ft-claude-v0-default.txt", plain[0]);
        Golden.assertMatches("decision-schema-forapi-us-ft.json", plain[2]);
    }

    @Test
    @DisplayName("계좌1: claude.freeTiming을 켠 정기 결정은 켠 판(계좌2와 같은 스키마·고정 문단, 투자 성향 절 없음) — 종가·지정 시각 주문이 다음 세션 하루짜리, "
            + "받는 가장 이른 분은 개장 10분 뒤(09:40 ET — 09:39는 MALFORMED). 끈 판 응답 시점(NEXT_OBSERVATION)과 시가(NEXT_OPEN — 판 ft-2부터)는 켠 판 스키마가 "
            + "받지 않음. 기존 장중 확인(종류 CHECKPOINT)은 스위치가 켜져 있어도 끈 판 파이프라인")
    void claude1SwitchSelectsTheVariantButNotForTheOldCheckpoint() {
        active(PaperBooks.CLAUDE);
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);
        answerJson(decision(buy("AAA", 5, "NEXT_CLOSE", null), buy("BBB", 5, "AT_MINUTE", "09:40"),
                buy("CCC", 3, "AT_MINUTE", "09:39")));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.error()).isNull();
        String[] on = sent();
        Golden.assertMatches("render-us-ft-claude-v0-default.txt", on[0]);
        Golden.assertMatches("packet-us-ft-claude-scheduled.json", on[1]);
        Golden.assertMatches("decision-schema-forapi-us-ft.json", on[2]);
        assertThat(on[0]).doesNotContain("## 투자 성향").doesNotContain("timing은 NEXT_OBSERVATION");
        verify(packets, never()).build(any(), anyString(), anyBoolean(), any(), any());
        Order close = orderOf(PaperBooks.CLAUDE, "AAA");
        assertThat(close.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(close.timing()).isEqualTo(PaperBooks.NEXT_CLOSE);
        assertThat(close.expiresOn()).as("시각 지정 방식 — 다음 세션 하루짜리").isEqualTo(TUE);
        Order first = orderOf(PaperBooks.CLAUDE, "BBB");
        assertThat(first.targetLocal()).as("받는 가장 이른 분 — 개장 10분 뒤").isEqualTo(LocalTime.of(9, 40));
        assertThat(first.status()).isEqualTo(PaperBooks.ORDER_PENDING);
        Order early = orderOf(PaperBooks.CLAUDE, "CCC");
        assertThat(early.status()).isEqualTo("REJECTED");
        assertThat(early.rejectReason()).isEqualTo(com.macrodash.analytics.OrderValidator.MALFORMED);
        assertThat(early.reason().path("validation").asString()).contains("09:39").contains("09:40~15:54 ET");

        // 끈 판의 시점 글자와 시가(판 ft-2부터)는 켠 판 스키마(enum 둘)가 받지 않음 — 형식 오류로 남고 주문 행은 없음.
        for (String refused : List.of("NEXT_OBSERVATION", "NEXT_OPEN")) {
            store.decisions.clear();
            store.orders.clear();
            answerJson(decision(buy("AAA", 5, refused, null)));
            Decision bad = service().decide(MON, RuleBookService.SCHEDULED, true);
            assertThat(bad.status()).as(refused).isEqualTo("FORMAT_ERROR");
            assertThat(bad.error()).as(refused).contains("허용 값이 아닙니다");
            assertThat(store.ordersOf(PaperBooks.CLAUDE)).as(refused).isEmpty();
        }

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
    @DisplayName("장중 판단 예약(계좌2): 켠 판 결정의 checkpoints가 시각 순으로 순번 1·2의 PLANNED 행(판 ft-2·그 결정)이 됨. 같은 세션의 뒤 결정(수동)이 "
            + "예약을 줄이면 첫 순번은 새 값으로 바뀌고 남은 순번은 SUPERSEDED, 규칙에 맞지 않는 항목만 버려지고 주문 판정은 그대로")
    void checkpointsBecomePlanRowsAndALaterDecisionReplacesThem() {
        active(PaperBooks.CLAUDE2);
        set("claude2", "freeTiming", true);
        answerJson(decisionWith("[" + checkpoint("13:30", "HOURLY", "[]", "오후 확인") + ","
                + checkpoint("10:15", "MINUTE", "[\"AAA\",\"SHY\"]", "개장 뒤 확인") + "]", buy("AAA", 5, "AT_MINUTE", "10:47")));

        Decision d = service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null,
                null, true).decision();

        assertThat(d.error()).isNull();
        assertThat(orderOf(PaperBooks.CLAUDE2, "AAA").status()).isEqualTo(PaperBooks.ORDER_PENDING);
        List<com.macrodash.store.PaperStore.IntradayPlan> plans = store.intradayPlans(PaperBooks.CLAUDE2, TUE);
        assertThat(plans).extracting(p -> p.slot() + " " + p.atLocal() + " " + p.feed() + " " + p.watch() + " " + p.status() + " "
                + p.variant() + " " + p.manual()).as("시각 순으로 순번")
                .containsExactly("1 10:15 MINUTE [AAA, SHY] PLANNED ft-2 false", "2 13:30 HOURLY [] PLANNED ft-2 false");
        assertThat(plans).allSatisfy(p -> {
            assertThat(p.sourceDecisionId()).isEqualTo(d.id());
            assertThat(p.requestedByDecisionId()).as("아침 결정이 예약").isNull();
            assertThat(p.intradayDecisionId()).isNull();
        });
        assertThat(plans.get(0).question()).isEqualTo("개장 뒤 확인");
        JsonNode view = d.response().path("intradayPlan");
        assertThat(view.path("session").asString()).isEqualTo(TUE.toString());
        assertThat(view.path("maxPerSession").asInt()).isEqualTo(2);
        assertThat(view.path("planned").size()).isEqualTo(2);
        assertThat(view.path("planned").get(0).path("slot").asInt()).isEqualTo(1);
        assertThat(view.path("planned").get(0).path("atEt").asString()).isEqualTo("10:15");
        assertThat(view.path("planned").get(1).path("status").asString()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);
        assertThat(view.path("rejected").size()).isZero();
        assertThat(view.path("superseded").asInt()).isZero();
        assertThat(store.checkpoints).as("끈 판의 장중 확인 표는 쓰지 않음").isEmpty();

        // 같은 세션을 대신하는 수동 결정 — 하나는 유니버스 밖 감시 종목이라 버리고 하나만 받음.
        answerJson(decisionWith("[" + checkpoint("11:00", "MINUTE", "[\"ZZZ\"]", "없는 종목") + ","
                + checkpoint("14:00", "HOURLY", "[]", "늦은 확인") + "]", buy("BBB", 5, "NEXT_CLOSE", null)));
        Decision manual = service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.MANUAL, true, null,
                null, false).decision();

        assertThat(manual.error()).isNull();
        assertThat(orderOf(PaperBooks.CLAUDE2, "BBB").status()).as("예약이 버려져도 주문 판정은 그대로").isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.intradayPlans(PaperBooks.CLAUDE2, TUE)).extracting(p -> p.slot() + " " + p.atLocal() + " " + p.feed() + " "
                + p.status() + " " + p.sourceDecisionId() + " " + p.reason()).containsExactly(
                "1 14:00 HOURLY PLANNED " + manual.id() + " null", "2 13:30 HOURLY SUPERSEDED " + d.id() + " " + IntradayPlanner.SUPERSEDED);
        JsonNode second = manual.response().path("intradayPlan");
        assertThat(second.path("planned").size()).isEqualTo(1);
        assertThat(second.path("rejected").get(0).path("atEt").asString()).isEqualTo("11:00");
        assertThat(second.path("rejected").get(0).path("reason").asString())
                .startsWith(com.macrodash.analytics.OrderValidator.CHECKPOINT_INVALID).contains("유니버스 밖 티커: ZZZ");
        assertThat(second.path("superseded").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("장중 판단 예약(계좌1): 세션당 횟수 설정이 0이면 예약을 받지 않고 사유를 남김. 횟수 1이면 이른 것 하나만. 스위치를 끈 뒤의 결정(끈 판)은 "
            + "예약을 읽지 않고 그 세션의 남은 계획 행만 닫음")
    void sessionLimitAndOffVariantDecisionClosesThePlans() {
        active(PaperBooks.CLAUDE);
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 0);
        // 미국 HOURLY 예약은 10:10 ET부터 받습니다(QA-359) — 첫 예약을 10:30으로 둡니다.
        String two = "[" + checkpoint("10:30", "HOURLY", "[]", "첫 확인") + "," + checkpoint("12:00", "HOURLY", "[]", "둘째 확인") + "]";
        answerJson(decisionWith(two));

        Decision none = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(none.error()).isNull();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, TUE)).as("횟수 0 — 행을 쓰지 않음").isEmpty();
        JsonNode disabled = none.response().path("intradayPlan");
        assertThat(disabled.path("maxPerSession").asInt()).isZero();
        assertThat(disabled.path("planned").size()).isZero();
        assertThat(disabled.path("rejected").size()).isEqualTo(2);
        assertThat(disabled.path("rejected").get(0).path("reason").asString()).isEqualTo(IntradayPlanner.DISABLED);

        // 횟수 1 — 이른 것 하나만 받음(수동 결정이 같은 세션을 대신함).
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 1);
        answerJson(decisionWith(two));
        Decision one = service().decide(MON, RuleBookService.MANUAL, true);
        assertThat(one.error()).isNull();
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, TUE)).extracting(p -> p.slot() + " " + p.atLocal() + " " + p.status())
                .containsExactly("1 10:30 PLANNED");
        assertThat(one.response().path("intradayPlan").path("rejected").get(0).path("atEt").asString()).isEqualTo("12:00");
        assertThat(one.response().path("intradayPlan").path("rejected").get(0).path("reason").asString()).contains("횟수");

        // 스위치를 끈 뒤 같은 세션의 정기 결정이 다시 남(재시도 차례를 흉내 — 정기 행을 지우고 다시) — 끈 판은 checkpoints를 읽지 않고 남은 행만 닫음.
        store.decisions.remove(none.id());
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", false);
        answerJson("{\"schemaVersion\":2,\"stance\":\"NEUTRAL\",\"targetEquityExposurePct\":0,\"exposureRationale\":\"r\","
                + "\"summary\":\"s\",\"orders\":[],\"noTradeReason\":\"없음\",\"confidence\":0.5}");
        Decision off = service().decide(MON, RuleBookService.SCHEDULED, true);
        assertThat(off.error()).isNull();
        Golden.assertMatches("render-us-v0-default.txt", sent()[0]);
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, TUE)).extracting(p -> p.slot() + " " + p.status() + " " + p.reason())
                .containsExactly("1 SUPERSEDED " + IntradayPlanner.SUPERSEDED);
        assertThat(off.response().path("intradayPlan").path("superseded").asInt()).isEqualTo(1);
        assertThat(off.response().path("intradayPlan").path("planned").size()).isZero();
    }

    @Test
    @DisplayName("스위치가 꺼져 있으면(기본·키 없음) 두 계좌 모두 끈 판 그대로 — 켠 판 프로필로 패킷을 조립하지 않음")
    void switchesOffKeepTheOffVariants() {
        active(PaperBooks.CLAUDE);
        active(PaperBooks.CLAUDE2);
        ((ObjectNode) store.settings.body().get("claude")).remove("freeTiming");
        ((ObjectNode) store.settings.body().get("claude2")).remove("freeTiming");
        answerJson(decision());
        Decision first = service().decide(MON, RuleBookService.SCHEDULED, true);
        String[] one = sent();
        answerJson(decision());
        Decision second = service().decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, RuleBookService.SCHEDULED, true, null,
                null, true).decision();
        String[] two = sent();
        assertThat(first.response().has("intradayPlan")).as("끈 판 — 계획 행이 없으면 응답에 그 칸이 없음").isFalse();
        assertThat(second.response().has("intradayPlan")).isFalse();
        assertThat(store.intradayPlans).isEmpty();

        Golden.assertMatches("render-us-v0-default.txt", one[0]);
        Golden.assertMatches("decision-schema-forapi-us.json", one[2]);
        Golden.assertMatches("render-us-claude2-v0-default.txt", two[0]);
        Golden.assertMatches("decision-schema-forapi-us-claude2.json", two[2]);
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2_FT), anyString(), any());
        verify(packets, never()).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE_FT), anyString(), any());
    }
}
