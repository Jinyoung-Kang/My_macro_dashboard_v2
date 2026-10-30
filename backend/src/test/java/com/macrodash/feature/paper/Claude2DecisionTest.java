package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.ApiUsage;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.support.InvalidRequestException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.JsonNode;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
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
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 미국 Claude 계좌2의 결정 한 번({@link ClaudeBookService#decideClaude2}, 계좌2 명세 §4-1·§5-1·§9-1) — 공식 SDK를 실제로 돌리고 Claude API 자리에 가짜
 * 서버(127.0.0.1)를 둡니다(유료 호출 없음). 패킷은 가짜(조립은 PacketBuilderTest)이고, 계좌 비의존 섹션 일곱을 담아 {@code sharedWith}를 볼 수 있게
 * 했습니다.
 *
 * <p>시각: 기준 거래일 d = 10-26(월), 지금 = 10-26 23:00Z(19:00 ET — 마감 뒤, KST 10-27 08:00), 목표 세션 E = 10-27, 개장 전 컷오프 = 10-27
 * 13:00Z(09:00 ET).
 */
class Claude2DecisionTest {

    private static final Instant NOW = Instant.parse("2026-10-26T23:00:00Z");
    private static final LocalDate TUE = LocalDate.of(2026, 10, 27);
    private static final LocalDate TODAY_KST = LocalDate.of(2026, 10, 27);
    private static final String KEY = "sk-ant-test-CLAUDE2";
    private static final String USAGE = "{\"input_tokens\":21000,\"output_tokens\":3100,"
            + "\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}";
    /** 계좌 비의존 섹션 일곱이 든 가짜 패킷(보낸 글자). */
    private static final String PACKET_TEXT = "{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\",\"book\":\"claude2\"},"
            + "\"2_macroCards\":{\"us10y\":4.21},\"3_fred\":{\"DGS10\":4.2},\"4_regime\":{\"state\":\"RISK_ON\"},\"5_gate\":{},"
            + "\"6_trackRecord\":{},\"6b_institutionProfiles\":{},\"11_notes\":{\"text\":\"메모 없음\"},\"13_execution\":{}}";

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
                bar("SHY", FRI, 82, MON, 82.5))));
        packets = mock(PacketBuilder.class);
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2), anyString(), any())).thenReturn(packet(PACKET_TEXT));
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

    private static PacketBuilder.Packet packet(String text) {
        return new PacketBuilder.Packet(MAPPER.readTree(text), text, PacketBuilder.sha256(text), List.of(), null);
    }

    private ClaudeBookService service(Instant now) {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
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

    private ClaudeBookService.Claude2Outcome decide(Instant now, String kind) {
        return service(now).decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON, kind, true, null, null, true);
    }

    private void notStarted() {
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, null, PaperBooks.NOT_STARTED, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE,
                null, null));
    }

    private void active() {
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE2, new BookState(PaperBooks.CLAUDE2, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE,
                FRI, null));
    }

    private void answer(int status, String body) {
        synchronized (answers) {
            answers.add(new String[]{String.valueOf(status), body});
        }
    }

    private void answerJson(String json) {
        answer(200, "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-5-5\","
                + "\"content\":[{\"type\":\"text\",\"text\":" + MAPPER.writeValueAsString(json) + "}],\"stop_reason\":\"end_turn\","
                + "\"stop_sequence\":null,\"usage\":" + USAGE + "}");
    }

    private void answerOverloaded() {
        answer(500, "{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"boom\"}}");
    }

    private static String order(String ticker, double target, String timing) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"BUY\",\"targetWeightPct\":" + target + ",\"sellFraction\":null,"
                + "\"timing\":\"" + timing + "\",\"executionNote\":\"" + timing + " — 갭 위험\",\"thesis\":\"" + ticker
                + " 논거\",\"labels\":[\"사실\"],\"invalidation\":\"200일선 이탈\"}";
    }

    private static String decision(String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"RISK_ON\",\"targetEquityExposurePct\":10,\"exposureRationale\":\"r\","
                + "\"summary\":\"계좌2 판단\",\"orders\":[" + String.join(",", orders) + "],\"noTradeReason\":null,"
                + "\"confidence\":0.6}";
    }

    private int callsToday() {
        return store.apiUsage(TODAY_KST).map(ApiUsage::calls).orElse(0);
    }

    // ------------------------------------------------------------------ 출발(§4-1)
    @Test
    @DisplayName("앞으로 체결 출발: INITIAL 결정(계좌2 스키마·고정 문단으로 부름) → 통과 주문은 E(10-27) 하루짜리 대기, 같은 트랜잭션에서 ACTIVE·started_on = S·S 순자산 줄 100,000(확정), 사후 체결 없음")
    void initialDecisionStartsTheBookForward() {
        notStarted();
        answerJson(decision(order("AAA", 5, "NEXT_OPEN"), order("BBB", 4, "AT_1000")));

        ClaudeBookService.Claude2Outcome outcome = decide(NOW, RuleBookService.INITIAL);

        assertThat(outcome.started()).isTrue();
        assertThat(outcome.failure()).isNull();
        assertThat(outcome.calls()).isEqualTo(1);
        Decision d = outcome.decision();
        assertThat(d.bookCode()).isEqualTo(PaperBooks.CLAUDE2);
        assertThat(d.kind()).isEqualTo(RuleBookService.INITIAL);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.packetText()).isEqualTo(PACKET_TEXT);
        assertThat(d.response().path("forwardStart").asString()).contains("사후 체결 없음");
        assertThat(d.response().path("sharedWith").isNull()).as("계좌1 결정 행 없음 — 지금 읽은 입력").isTrue();
        assertThat(d.response().path("marketSectionsSha256").asString())
                .isEqualTo(PacketBuilder.marketSectionsSha256(MAPPER.readTree(PACKET_TEXT), MAPPER));
        Book book = store.books.get(PaperBooks.CLAUDE2);
        assertThat(book.status()).isEqualTo(PaperBooks.ACTIVE);
        assertThat(book.startedOn()).as("출발일 = S(한국처럼 — S+1이 아님)").isEqualTo(MON);
        assertThat(store.navSeries(PaperBooks.CLAUDE2)).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(MON);
            assertThat(row.nav()).isEqualTo(100_000);
            assertThat(row.cash()).isEqualTo(100_000);
            assertThat(row.pricesFinal()).isTrue();
        });
        List<Order> orders = store.ordersOf(PaperBooks.CLAUDE2);
        assertThat(orders).extracting(Order::ticker, Order::timing, Order::status, Order::expiresOn).containsExactly(
                org.assertj.core.groups.Tuple.tuple("AAA", "NEXT_OPEN", "PENDING", TUE),
                org.assertj.core.groups.Tuple.tuple("BBB", "AT_1000", "PENDING", TUE));
        assertThat(orders.get(0).reason().path("executionNote").asString()).isEqualTo("NEXT_OPEN — 갭 위험");
        assertThat(store.fillsOf(PaperBooks.CLAUDE2)).as("사후 체결 없음").isEmpty();
        assertThat(store.startPrices).as("출발일 종가를 얼리지 않음").isEmpty();

        // 요청: 계좌2 시스템 프롬프트(우선순위 줄·체결 절)와 계좌2 스키마(메뉴 여덟·executionNote), 패킷은 INITIAL 조립.
        JsonNode request = requests.get(0);
        String system = request.path("system").get(0).path("text").asString();
        assertThat(system).contains(ClaudePrompts.ROLE).contains(ClaudePrompts.CLAUDE2_PRIORITY).contains("## 체결(고정)")
                .doesNotContain("timing은 NEXT_OBSERVATION(기준 거래일 다음 세션의 관측치, 기본)");
        String schema = request.path("output_config").path("format").path("schema").toString();
        assertThat(schema).contains("AT_1000").contains("executionNote").doesNotContain("NEXT_OBSERVATION");
        verify(packets).assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2), eq(RuleBookService.INITIAL), eq(0));

        // 이미 출발했으면 그 행을 돌려주고 다시 부르지 않음.
        assertThat(decide(NOW, RuleBookService.INITIAL).decision().id()).isEqualTo(d.id());
        assertThat(requests).hasSize(1);
    }

    @Test
    @DisplayName("출발 실패는 아무것도 쓰지 않음(§4-1의 4): API 오류는 같은 계획 안에서 같은 패킷으로 한 번 더 — 그래도 실패면 결정·주문·순자산 줄 없이 시작 전 그대로(호출 2회는 사용량에 셈)")
    void failedStartWritesNothing() {
        notStarted();
        answerOverloaded();
        answerOverloaded();

        ClaudeBookService.Claude2Outcome outcome = decide(NOW, RuleBookService.INITIAL);

        assertThat(outcome.decision()).isNull();
        assertThat(outcome.started()).isFalse();
        assertThat(outcome.calls()).isEqualTo(2);
        assertThat(outcome.failure()).startsWith("Claude 출발 호출 실패(API 오류, 재시도 1회 뒤)");
        assertThat(store.decisionsOf(PaperBooks.CLAUDE2)).isEmpty();
        assertThat(store.ordersOf(PaperBooks.CLAUDE2)).isEmpty();
        assertThat(store.navSeries(PaperBooks.CLAUDE2)).isEmpty();
        assertThat(store.books.get(PaperBooks.CLAUDE2).status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(callsToday()).isEqualTo(2);
        assertThat(requests.get(1).path("messages").toString()).as("재시도는 첫 호출의 패킷 그대로")
                .isEqualTo(requests.get(0).path("messages").toString());

        // 한 번 실패한 뒤 성공하면 출발(호출 2회).
        answerOverloaded();
        answerJson(decision());
        ClaudeBookService.Claude2Outcome retried = decide(NOW, RuleBookService.INITIAL);
        assertThat(retried.started()).isTrue();
        assertThat(retried.calls()).isEqualTo(2);
        assertThat(retried.decision().status()).as("주문 없이 출발(현금만)").isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(store.books.get(PaperBooks.CLAUDE2).status()).isEqualTo(PaperBooks.ACTIVE);
    }

    // ------------------------------------------------------------------ 정기 결정의 계좌2 조건(§5-1 ④⑤)
    @Test
    @DisplayName("개장 전 컷오프(⑤ — E 09:00 ET): 지난 뒤면 Claude를 부르지 않고 정기 결정은 SKIPPED '개장 전 컷오프', 출발은 쓰지 않고 실패, 수동은 400")
    void preOpenCutoff() {
        active();
        Instant cutoff = Instant.parse("2026-10-27T13:00:00Z");
        assertThat(ClaudeBookService.claude2Cutoff(UsPaperMarket.INSTANCE.calendar(), MON)).isEqualTo(cutoff);

        Decision skipped = decide(cutoff, RuleBookService.SCHEDULED).decision();
        assertThat(skipped.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(skipped.response().path("skipped").asString()).startsWith("개장 전 컷오프 — 목표 세션 2026-10-27 09:00 ET");
        assertThat(requests).isEmpty();
        assertThatThrownBy(() -> service(cutoff).decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON,
                RuleBookService.MANUAL, true, null, null, false)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("개장 전 컷오프");

        store.books.clear();
        notStarted();
        ClaudeBookService.Claude2Outcome start = decide(cutoff, RuleBookService.INITIAL);
        assertThat(start.decision()).isNull();
        assertThat(start.failure()).startsWith("개장 전 컷오프");
        assertThat(requests).isEmpty();
        // 컷오프 1초 전은 부름.
        answerJson(decision());
        assertThat(decide(cutoff.minusSeconds(1), RuleBookService.INITIAL).started()).isTrue();
    }

    @Test
    @DisplayName("계좌2 소상한(④ — 결정 주기 단위): d의 계좌2 정기·출발 행의 호출 수(1 + 재시도 수)가 claude2.maxCallsPerCycle 이상이면 정기 결정은 부르지 않고 SKIPPED, API 오류 재시도는 남은 자리가 있을 때만")
    void cycleCapCountsTheDecisionRows() {
        active();
        answerOverloaded();
        Decision failed = decide(NOW, RuleBookService.SCHEDULED).decision();
        assertThat(failed.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, MON)).isEqualTo(1);

        // 소상한 1 — 재시도 차례지만 이미 1회 → 부르지 않고 그 재시도를 쓴 것으로(행은 API 오류 그대로).
        tools.jackson.databind.node.ObjectNode body = (tools.jackson.databind.node.ObjectNode) store.settings.body();
        ((tools.jackson.databind.node.ObjectNode) body.get("claude2")).put("maxCallsPerCycle", 1);
        Decision capped = decide(NOW, RuleBookService.SCHEDULED).decision();
        assertThat(capped.id()).isEqualTo(failed.id());
        assertThat(capped.error()).contains("재시도 안 함: 계좌2 소상한(1회");
        assertThat(capped.retryCount()).isEqualTo(1);
        assertThat(requests).hasSize(1);
        assertThat(ClaudeBookService.claude2CallsInCycle(store, MON)).as("재시도를 건너뛴 행도 1을 더 셈(막는 쪽)").isEqualTo(2);

        // 새 결정 주기(다음 날)의 0 소상한 — 새 행은 SKIPPED.
        ((tools.jackson.databind.node.ObjectNode) body.get("claude2")).put("maxCallsPerCycle", 0);
        ClaudeBookService.Claude2Outcome zero = service(Instant.parse("2026-10-27T23:00:00Z")).decideClaude2(
                MarketRun.of(UsPaperMarket.INSTANCE, store), TUE, RuleBookService.SCHEDULED, true, null, null, true);
        assertThat(zero.decision().status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(zero.decision().response().path("summary").asString()).contains("계좌2 소상한(0회");
        assertThat(requests).hasSize(1);
    }

    @Test
    @DisplayName("정기 결정: 새 결정이 형식 검사를 통과하면 계좌2의 앞선 대기 주문을 모두 '다음 결정이 대신함'으로 취소(취소 수), 계좌1 주문은 건드리지 않음")
    void supersedesPendingBook2Orders() {
        active();
        long stale = store.insertOrder(new Order(0, PaperBooks.CLAUDE2, null, "AAA", "BUY", null, 3.0, null, "AT_1100",
                "CLAUDE", "PENDING", null, null, FRI, FRI_CLOSE, MON, null));
        long book1 = store.insertOrder(new Order(0, PaperBooks.CLAUDE, null, "AAA", "BUY", null, 3.0, null,
                "NEXT_OBSERVATION", "CLAUDE", "PENDING", null, null, FRI, FRI_CLOSE, LocalDate.of(2026, 10, 28), null));
        answerJson(decision(order("BBB", 5, "AT_1500")));

        ClaudeBookService.Claude2Outcome outcome = decide(NOW, RuleBookService.SCHEDULED);

        assertThat(outcome.superseded()).isEqualTo(1);
        assertThat(store.orders.get(stale).status()).isEqualTo(PaperBooks.ORDER_CANCELLED);
        assertThat(store.orders.get(stale).rejectReason()).isEqualTo("다음 결정이 대신함");
        assertThat(store.orders.get(book1).status()).isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(outcome.decision().response().path("supersededOrders").toString()).isEqualTo("[" + stale + "]");
        assertThat(outcome.started()).isFalse();
    }

    // ------------------------------------------------------------------ 입력 동결(§5-1·§9-1)
    @Test
    @DisplayName("입력 동결: 같은 실행의 시장 입력이 있으면 그것으로 조립(새로 읽지 않음), 따로 도는 실행은 같은 d의 계좌1 정기 결정 행이 보낸 섹션을 넣고 — 섹션이 바이트까지 같으면 sharedWith = 그 결정 번호, 다르면 null")
    void sharesTheMarketInputsWithBook1() {
        active();
        PacketBuilder.MarketInputs shared = mock(PacketBuilder.MarketInputs.class);
        long book1 = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED, null,
                "OK", "claude-sonnet-5-5", 0, 1, FRI, 50.0, MAPPER.readTree(PACKET_TEXT), "h", null,
                MAPPER.createObjectNode(), null, null, List.of(), true, 5L, 0, PACKET_TEXT.replace(",\"13_execution\":{}", "")))
                .orElseThrow();
        answerJson(decision());
        Decision withShared = service(NOW).decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON,
                RuleBookService.SCHEDULED, true, shared, store.decision(book1).orElseThrow(), true).decision();
        verify(packets).assemble(eq(shared), eq(ClaudeBookProfile.US_CLAUDE2), eq(RuleBookService.SCHEDULED), eq(0));
        verify(packets, never()).read(any(), anyBoolean(), any());
        assertThat(withShared.response().path("sharedWith").asLong()).isEqualTo(book1);

        // 따로 도는 실행(수동) — 지금 읽고 계좌1 행의 섹션을 넣음(withSectionsOf).
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        answerJson(decision());
        Decision manual = service(NOW).decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON,
                RuleBookService.MANUAL, true, null, null, false).decision();
        verify(packets).read(eq(MON), eq(false), any());
        verify(packets).withSectionsOf(any(), eq(store.decision(book1).orElseThrow()));
        assertThat(manual.response().path("sharedWith").asLong()).isEqualTo(book1);

        // 계좌1 섹션과 다른 패킷이면(지금 읽은 입력 — 계좌1이 다른 매크로 카드를 봄) sharedWith 없음.
        when(packets.assemble(any(), eq(ClaudeBookProfile.US_CLAUDE2), anyString(), any()))
                .thenReturn(packet(PACKET_TEXT.replace("4.21", "4.30")));
        store.decisions.values().removeIf(d -> d.bookCode().equals(PaperBooks.CLAUDE2));
        answerJson(decision());
        Decision differs = decide(NOW, RuleBookService.SCHEDULED).decision();
        assertThat(differs.response().path("sharedWith").isNull()).isTrue();
        assertThat(differs.response().path("marketSectionsSha256").asString()).hasSize(64);
    }

    @Test
    @DisplayName("상태: 출발은 시작 전 계좌만·정기는 출발한 계좌만(400), 일시정지 정기 결정은 부르지 않고 SKIPPED·수동은 400")
    void bookStateGuards() {
        notStarted();
        assertThatThrownBy(() -> decide(NOW, RuleBookService.SCHEDULED)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("출발 전");
        active();
        assertThatThrownBy(() -> decide(NOW, RuleBookService.INITIAL)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("이미 출발");
        store.books.put(PaperBooks.CLAUDE2, new Book(PaperBooks.CLAUDE2, PaperBooks.KIND_CLAUDE, PaperBooks.CLAUDE2_LABEL,
                100_000, FRI, PaperBooks.PAUSED, FRI_CLOSE));
        assertThat(decide(NOW, RuleBookService.SCHEDULED).decision().status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThatThrownBy(() -> service(NOW).decideClaude2(MarketRun.of(UsPaperMarket.INSTANCE, store), MON,
                RuleBookService.MANUAL, true, null, null, false)).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("일시정지");
        assertThat(requests).isEmpty();
        assertThat(store.navSeries(PaperBooks.CLAUDE2)).isEmpty();
    }
}
