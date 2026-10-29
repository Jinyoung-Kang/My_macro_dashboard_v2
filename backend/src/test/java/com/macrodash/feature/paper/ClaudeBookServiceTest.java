package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.ApiUsage;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.support.InvalidRequestException;
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
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;
import static com.macrodash.feature.paper.PaperFixtures.staleBar;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Claude 재량 책({@link ClaudeBookService}) — 공식 SDK를 실제로 돌리고 Claude API 자리에 가짜 서버(127.0.0.1)를 둡니다(유료 호출
 * 없음). 패킷은 가짜로 두고(패킷 자체는 PacketBuilderTest), 호출 → 사용량 → 형식 검사 → 검증기 → 장부·결정 기록의 흐름을 봅니다.
 *
 * <p>네 응답(정상·형식 오류·거절·429)마다 장부를 바꾸지 않거나 통과 주문만 바꾸는지, 일일 호출 상한, API 오류의 재시도 한 번,
 * 미리보기가 장부·결정 표를 건드리지 않음, 시작이 얼려 둔 출발일 종가로 사후 체결함, 노출 0%·100%가 모두 통과함을 고정합니다.
 *
 * <p>시각: 결정 = 2026-10-26(월) 세션, 지금 = 2026-10-26T23:00Z(KST 10-27 08:00 — 사용량의 날짜는 KST 10-27).
 */
class ClaudeBookServiceTest {

    private static final Instant NOW = Instant.parse("2026-10-26T23:00:00Z");
    private static final LocalDate TODAY_KST = LocalDate.of(2026, 10, 27);
    private static final String KEY = "sk-ant-test-CLAUDEBOOK";
    private static final String PACKET_TEXT = "{\"0_instructions\":\"가짜 패킷\"}";
    private static final String USAGE = "{\"input_tokens\":21000,\"output_tokens\":3100,"
            + "\"cache_read_input_tokens\":7800,\"cache_creation_input_tokens\":0}";
    private static final String RATE_LIMITED =
            "{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"slow down\"}}";
    /** 가짜 패킷의 측정 태그(2단계 §6) — 일정 섹션 3줄, 사건 2건(B6 entity 목록), 서프라이즈 7종목(C). */
    private static final DecisionMeasure MEASURE = new DecisionMeasure(true, 3, 2,
            List.of("0123456789abcdef", "fedcba9876543210"), true, 7);
    private static final String MEASURE_JSON = "{\"hasCalendar\":true,\"calendarItems\":3,\"hasEvents\":2,"
            + "\"eventIds\":[\"0123456789abcdef\",\"fedcba9876543210\"],\"hasEarnings\":true,\"earningsRows\":7}";

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperSelectionService selection;
    private PacketBuilder packets;
    private PaperSettingsService settings;
    private PaperLedgerService ledger;

    private HttpServer server;
    private String baseUrl;
    private final Deque<String[]> answers = new ArrayDeque<>();
    private final AtomicInteger hits = new AtomicInteger();
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    /** 가짜 서버가 응답하기 전에 부르는 일 — "Claude를 부르는 사이에" 일어나는 일(일시정지·초기화)을 흉내 냅니다. */
    private volatile Runnable duringCall;

    @BeforeEach
    void setUp() throws Exception {
        store = new FakePaperStore();
        store.dbNow = NOW;
        reader = PaperFixtures.quietReader();
        marketData = mock(PaperMarketData.class);
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.of(quotes(MON_FINAL,
                bar("AAA", FRI, 99, MON, 100), bar("HELD", FRI, 99, MON, 100), bar("SHY", FRI, 82, MON, 82.5),
                bar("SPY", FRI, 680, MON, 681), bar("XLK", FRI, 200, MON, 201), bar("XLF", FRI, 50, MON, 51),
                bar("XLE", FRI, 90, MON, 91), bar("XLV", FRI, 140, MON, 141), bar("XLI", FRI, 130, MON, 131),
                bar("NOPX", FRI, 10, MON, 11))));
        selection = mock(PaperSelectionService.class);
        when(selection.selectionOn(any())).thenReturn(Optional.of(new Selection(FRI, List.of("0000000001"), null, 1,
                FRI_CLOSE)));
        packets = mock(PacketBuilder.class);
        when(packets.build(any(), anyString(), anyBoolean(), any(), any())).thenReturn(new PacketBuilder.Packet(
                MAPPER.readTree("{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\"}}"), PACKET_TEXT, "hash-abc", List.of(),
                MEASURE));
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        ledger = new PaperLedgerService(store, marketData, MAPPER);

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            hits.incrementAndGet();
            requests.add(MAPPER.readTree(exchange.getRequestBody().readAllBytes()));
            Runnable hook = duringCall;
            if (hook != null) {
                duringCall = null;
                hook.run();
            }
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

    // ------------------------------------------------------------------ 재료
    private AiService ai(String key) {
        AiService ai = new AiService(240, 60, 180);
        ReflectionTestUtils.setField(ai, "anthropicKey", key);
        ReflectionTestUtils.setField(ai, "anthropicBaseUrl", baseUrl);
        return ai;
    }

    private ClaudeBookService service() {
        return service(KEY);
    }

    private ClaudeBookService service(String key) {
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger,
                PaperFixtures.config(), MAPPER, clock);
        AiService ai = ai(key);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        return new ClaudeBookService(store, reader, marketData, selection, ledger, admin, packets,
                new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock), calls, ai, settings,
                PaperFixtures.config(), MAPPER, 30, clock);
    }

    /** 운용 중인 Claude 책 — 현금 95,000 + HELD 50주 × 100(5%) = 순자산 100,000. */
    private void activeWithHolding() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 95_000, 100_000, 5_000, 5, FRI_CLOSE,
                FRI_CLOSE, FRI, null));
        PaperFixtures.position(store, PaperBooks.CLAUDE, "HELD", 50, 100, 100, 100.0, FRI, 100);
    }

    /** 운용 중인 Claude 책 — 현금만 100,000. */
    private void activeCashOnly() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 100_000, 100_000, 0, 0, FRI_CLOSE,
                FRI_CLOSE, FRI, null));
    }

    /** 시작 전 Claude 책(현금만)과 얼려 둔 출발일 종가 AAA 50 · SHY 82.5. */
    private void notStartedWithStartPrices() {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                null, PaperBooks.NOT_STARTED, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 100_000, 100_000, 0, 0, null, null, null,
                null));
        store.startPrices.put("AAA", new StartPrice("AAA", FRI, 50.0, "equity_close", FRI_CLOSE));
        store.startPrices.put("SHY", new StartPrice("SHY", FRI, 82.5, "equity_close", FRI_CLOSE));
    }

    private void answer(int status, String body) {
        synchronized (answers) {
            answers.add(new String[]{String.valueOf(status), body});
        }
    }

    /** 정상 응답(사고 블록 뒤 텍스트 블록에 JSON). */
    private void answerJson(String json) throws Exception {
        answer(200, message("[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig\"},{\"type\":\"text\",\"text\":"
                + MAPPER.writeValueAsString(json) + "}]", "end_turn", ""));
    }

    private static String message(String content, String stopReason, String extra) {
        return "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-5-5\","
                + "\"content\":" + content + ",\"stop_reason\":\"" + stopReason + "\",\"stop_sequence\":null" + extra
                + ",\"usage\":" + USAGE + "}";
    }

    private static String order(String ticker, String side, Double target, Double fraction, String timing) {
        return "{\"ticker\":\"" + ticker + "\",\"side\":\"" + side + "\",\"targetWeightPct\":" + target
                + ",\"sellFraction\":" + fraction + ",\"timing\":\"" + timing + "\",\"thesis\":\"" + ticker
                + " 논거\",\"labels\":[\"사실\",\"가설\"],\"invalidation\":\"200일선 이탈\"}";
    }

    private static String decision(double exposure, String noTradeReason, String... orders) {
        return "{\"schemaVersion\":2,\"stance\":\"RISK_ON\",\"targetEquityExposurePct\":" + exposure
                + ",\"exposureRationale\":\"할인율 완화\",\"summary\":\"오늘 판단 요약\",\"orders\":["
                + String.join(",", orders) + "],\"noTradeReason\":"
                + (noTradeReason == null ? "null" : "\"" + noTradeReason + "\"")
                + ",\"watchlist\":[{\"ticker\":\"XLE\",\"condition\":\"유가 95 돌파\"}],\"confidence\":0.6}";
    }

    private List<Order> claudeOrders(String status) {
        return store.ordersOf(PaperBooks.CLAUDE).stream().filter(o -> o.status().equals(status)).toList();
    }

    private int callsToday() {
        return store.apiUsage(TODAY_KST).map(ApiUsage::calls).orElse(0);
    }

    // ------------------------------------------------------------------ 정상
    @Test
    @DisplayName("정상 응답: 통과 주문만 대기(매수는 목표 − 현재 = 살 비중), 거절은 사유와 REJECTED, 장부는 그대로, 결정에 패킷·원문·사용량")
    void normalResponsePlacesOnlyAcceptedOrders() throws Exception {
        activeWithHolding();
        answerJson(decision(60, null,
                order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION"),
                order("ZZZ", "BUY", 5.0, null, "NEXT_OBSERVATION"),
                order("HELD", "BUY", 10.0, null, "NEXT_CLOSE")));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(d.model()).isEqualTo("claude-sonnet-5-5");
        assertThat(d.frameworkVersion()).as("판이 없어 시드한 임시 v0 — 그 판 번호를 남김").isZero();
        assertThat(d.packetHash()).isEqualTo("hash-abc");
        assertThat(d.packetText()).as("보낸 패킷 문자열 그대로 — 해시를 다시 만들 수 있게").isEqualTo(PACKET_TEXT);
        assertThat(d.selectionAsOf()).isEqualTo(FRI);
        assertThat(d.targetExposurePct()).isEqualTo(60.0);
        assertThat(d.responseRaw()).contains("\"schemaVersion\":2");
        assertThat(d.pricesFinal()).isTrue();
        assertThat(d.retryCount()).isZero();
        assertThat(d.usage().path("inputTokens").asLong()).isEqualTo(21_000);
        assertThat(d.usage().path("cacheReadTokens").asLong()).isEqualTo(7_800);
        assertThat(d.response().path("stance").asString()).isEqualTo("RISK_ON");
        assertThat(d.response().path("framework").toString())
                .isEqualTo("{\"version\":0,\"status\":\"INTERIM\",\"title\":\"임시 v0 — OS 원문 반영 전\"}");
        assertThat(store.frameworks).as("판이 없으면 결정이 임시 v0을 시드").containsOnlyKeys(0);
        assertThat(d.response().path("validation")).hasSize(3);
        assertThat(d.response().path("validation").get(1).path("rejectReason").asString()).isEqualTo("OUT_OF_UNIVERSE");
        // 예상 노출 = HELD 5 + 매수 증가분 AAA 8 + HELD 5 = 18 → 목표 60과 15%p 넘게 다름(숫자를 맞추지 않고 표시만)
        assertThat(d.response().path("expectedExposurePct").asDouble()).isEqualTo(18.0);
        assertThat(d.response().path("exposureMismatch").asBoolean()).isTrue();
        assertThat(d.response().path("measure").toString()).as("패킷의 측정 태그 그대로(null 키도 남김)")
                .isEqualTo(MEASURE_JSON);
        assertThat(d.packet().has("measure")).as("측정 태그는 기록용 — Claude에게 보낸 패킷 본문에는 없음").isFalse();

        List<Order> pending = claudeOrders("PENDING");
        assertThat(pending).extracting(Order::ticker).containsExactly("AAA", "HELD");
        assertThat(pending).allSatisfy(o -> {
            assertThat(o.source()).isEqualTo("CLAUDE");
            assertThat(o.decisionId()).isEqualTo(d.id());
            assertThat(o.asOfTradingDate()).isEqualTo(MON);
            assertThat(o.expiresOn()).isEqualTo(LocalDate.of(2026, 10, 29));
        });
        assertThat(pending.get(0).targetWeightPct()).isEqualTo(8.0);
        assertThat(pending.get(1).targetWeightPct()).as("이미 5% 보유 — 목표 10%까지 모자란 만큼").isEqualTo(5.0);
        assertThat(pending.get(1).timing()).isEqualTo("NEXT_CLOSE");
        assertThat(pending.get(1).reason().path("proposed").path("targetWeightPct").asDouble()).isEqualTo(10.0);
        assertThat(pending.get(1).reason().path("targetWeightPct").asDouble())
                .as("목표 비중은 규칙 책과 같은 키에도 — 화면이 '(목표 10.00%)'를 붙임").isEqualTo(10.0);
        assertThat(pending.get(0).reason().path("targetWeightPct").asDouble()).isEqualTo(8.0);
        assertThat(pending.get(0).reason().path("thesis").asString()).isEqualTo("AAA 논거");
        assertThat(pending.get(0).reason().path("labels").toString()).contains("사실", "가설");
        assertThat(pending.get(0).reason().path("invalidation").asString()).isEqualTo("200일선 이탈");
        assertThat(claudeOrders("REJECTED")).singleElement().satisfies(o -> {
            assertThat(o.ticker()).isEqualTo("ZZZ");
            assertThat(o.rejectReason()).isEqualTo("OUT_OF_UNIVERSE");
            // 거절 행은 집행되지 않으므로 받은 값 그대로(목표 비중) — 근거에도 같은 목표
            assertThat(o.targetWeightPct()).isEqualTo(5.0);
            assertThat(o.reason().path("targetWeightPct").asDouble()).isEqualTo(5.0);
        });
        // 장부는 체결 전이라 그대로(체결은 다음 관측치에서 장부가)
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(95_000);
        assertThat(store.fillsOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(store.positions(PaperBooks.CLAUDE)).singleElement().extracting(p -> p.qty()).isEqualTo(50);
        // 사용량: 호출 1회와 토큰
        ApiUsage usage = store.apiUsage(TODAY_KST).orElseThrow();
        assertThat(usage.calls()).isEqualTo(1);
        assertThat(usage.inputTokens()).isEqualTo(21_000);
        assertThat(usage.outputTokens()).isEqualTo(3_100);
        assertThat(usage.cacheReadTokens()).isEqualTo(7_800);

        // 추정 비용(Sonnet 기본 단가 2/10/0.10/2.50 달러/100만 토큰): 21,000×2 + 3,100×10 + 7,800×0.10 = 73,780 → $0.07378
        assertThat(usage.estCostUsd()).isCloseTo(0.07378, within(1e-9));
        assertThat(usage.estCostCalls()).isEqualTo(1);

        // 요청: 지금 판(임시 v0)의 렌더링(캐시 블록)·패킷·스키마(API가 받지 않는 키 없음)·effort, temperature 없음
        JsonNode request = requests.get(0);
        assertThat(request.path("model").asString()).isEqualTo("claude-sonnet-5-5");
        assertThat(request.path("max_tokens").asLong()).isEqualTo(16_000);
        assertThat(request.path("system").get(0).path("text").asString())
                .isEqualTo(FrameworkService.render(FrameworkService.interimBody(MAPPER), 0, store.settings().orElseThrow()
                        .body()))
                .startsWith("# 투자 OS — v0 (임시 v0 — OS 원문 반영 전)\n" + ClaudePrompts.ROLE)
                .endsWith(ClaudePrompts.FIXED_RULES.strip());
        assertThat(request.path("system").get(0).path("cache_control").path("type").asString()).isEqualTo("ephemeral");
        assertThat(request.path("messages").toString()).contains("가짜 패킷");
        assertThat(request.path("output_config").path("effort").asString()).isEqualTo("high");
        assertThat(request.path("output_config").path("format").path("schema").path("properties").has("orders"))
                .isTrue();
        assertThat(request.path("output_config").toString()).doesNotContain("\"maximum\"", "\"maxLength\"");
        assertThat(request.has("temperature")).isFalse();
        assertThat(request.has("thinking")).isFalse();
        verify(packets).build(eq(MON), eq("SCHEDULED"), eq(false), eq(0), any());

        // 같은 거래일·같은 종류는 한 번 — 다시 불러도 Claude를 부르지 않음
        assertThat(service().decide(MON, RuleBookService.SCHEDULED, true).id()).isEqualTo(d.id());
        assertThat(hits.get()).isEqualTo(1);
    }

    // ------------------------------------------------------------------ 고정본(2단계 묶음 A 기준선)
    @Test
    @DisplayName("고정본(묶음 A 기준선): 미국 정기 결정 — 보낸 요청(시스템 프롬프트·패킷 자리·스키마·모델 인자)과 남긴 결정·주문(검증 판정·노출·측정)이 바이트까지 같다")
    void goldenScheduledDecision() throws Exception {
        activeWithHolding();
        answerJson(decision(60, null,
                order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION"),
                order("ZZZ", "BUY", 5.0, null, "NEXT_OBSERVATION"),
                order("HELD", "BUY", 10.0, null, "NEXT_CLOSE"),
                order("XLK", "BUY", 25.0, null, "NEXT_OBSERVATION"),
                order("SHY", "BUY", 30.0, null, "NEXT_CLOSE"),
                order("XLE", "BUY", 0.3, null, "NEXT_OBSERVATION"),
                order("XLF", "SELL", null, null, "NEXT_OBSERVATION")));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(requests).hasSize(1);
        // 시스템 프롬프트 = 임시 v0을 결정 시점 설정(기본값)으로 렌더링 — FrameworkServiceTest의 같은 고정본.
        Golden.assertClaudeRequest(requests.get(0), "render-us-v0-default.txt", null,
                "claude-decision-request-us.json");
        StringBuilder out = new StringBuilder();
        out.append("decision book=").append(d.bookCode()).append(" asOf=").append(d.asOfTradingDate())
                .append(" kind=").append(d.kind()).append(" status=").append(d.status()).append(" model=")
                .append(d.model()).append(" framework=").append(d.frameworkVersion()).append(" settings=")
                .append(d.settingsVersion()).append(" selectionAsOf=").append(d.selectionAsOf()).append(" target=")
                .append(d.targetExposurePct()).append(" pricesFinal=").append(d.pricesFinal()).append(" retry=")
                .append(d.retryCount()).append(" packetHash=").append(d.packetHash()).append(" noteIds=")
                .append(d.noteIds()).append(" error=").append(d.error()).append('\n');
        ObjectNode usage = (ObjectNode) d.usage().deepCopy();
        usage.remove("latencyMs");   // 가짜 서버까지 걸린 실제 시간 — 실행마다 다름
        out.append("usage=").append(MAPPER.writeValueAsString(usage)).append('\n');
        out.append("response=").append(Golden.prettyJson(d.response())).append('\n');
        for (Order o : store.ordersOf(PaperBooks.CLAUDE)) {
            out.append("order #").append(o.id()).append(' ').append(o.ticker()).append(' ').append(o.side())
                    .append(" qty=").append(o.qty()).append(" targetWeightPct=").append(o.targetWeightPct())
                    .append(" sellFraction=").append(o.sellFraction()).append(" timing=").append(o.timing())
                    .append(" source=").append(o.source()).append(" status=").append(o.status()).append(" reject=")
                    .append(o.rejectReason()).append(" decision=").append(o.decisionId()).append(" asOf=")
                    .append(o.asOfTradingDate()).append(" expiresOn=").append(o.expiresOn()).append(" reason=")
                    .append(MAPPER.writeValueAsString(o.reason())).append('\n');
        }
        Golden.assertMatches("claude-decision-record-us.txt", out.toString().stripTrailing());
    }

    @Test
    @DisplayName("프레임: 지금 판(가장 큰 번호)을 결정 시점 설정으로 렌더링해 보내고, 판 번호를 패킷 1_basis·결정 기록·response.framework에 남긴다")
    void decisionUsesCurrentFrameworkRenderedWithCurrentSettings() throws Exception {
        activeWithHolding();
        FrameworkService frameworks = new FrameworkService(store, ai(KEY), settings, new PaperApiCalls(store, settings),
                MAPPER, 30, Clock.fixed(NOW, ZoneOffset.UTC));
        ObjectNode body = (ObjectNode) FrameworkService.interimBody(MAPPER).deepCopy();
        body.put("title", "사용자 OS v1");
        body.put("status", "USER");
        assertThat(frameworks.save(body, "사용자 OS 원문을 옮김", 0).get("version")).isEqualTo(1);
        // 판을 만든 뒤 설정을 바꿉니다 — 판 행의 rendered(만들 때 설정)가 아니라 결정 때 설정으로 다시 렌더링해야 합니다.
        PaperStore.SettingsRow row = store.settings().orElseThrow();
        ObjectNode changed = (ObjectNode) row.body().deepCopy();
        changed.put("maxWeightStockPct", 7);
        store.settings = new PaperStore.SettingsRow(row.version() + 1, changed, NOW);
        answerJson(decision(5, "오늘은 주문 없음"));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(d.frameworkVersion()).isEqualTo(1);
        assertThat(d.settingsVersion()).isEqualTo(row.version() + 1);
        assertThat(d.response().path("framework").toString())
                .isEqualTo("{\"version\":1,\"status\":\"USER\",\"title\":\"사용자 OS v1\"}");
        // FW-5 패킷도 이 결정이 읽은 설정 행(시스템 프롬프트·검증기·기록과 같은 판)으로 만듭니다 — 패킷이 따로 읽지 않게.
        verify(packets).build(eq(MON), eq("SCHEDULED"), eq(false), eq(1), eq(store.settings));
        String system = requests.get(0).path("system").get(0).path("text").asString();
        assertThat(system).isEqualTo(FrameworkService.render(body, 1, changed))
                .startsWith("# 투자 OS — v1 (사용자 OS v1)").contains("종목 비중 ≤ 7%")
                .doesNotContain("종목 비중 ≤ 10%");
        assertThat(store.frameworks.get(1).rendered()).as("판 행의 렌더링은 만들 때 설정 그대로").contains("종목 비중 ≤ 10%");
    }

    @Test
    @DisplayName("FW-5 결정이 읽은 설정 행 하나로 프롬프트·패킷·기록을 만든다 — 패킷을 만드는 사이 설정 탭에서 새 판을 저장해도 패킷에는 결정의 행을 넘긴다")
    void packetUsesDecisionSettingsRow() throws Exception {
        activeWithHolding();
        PaperStore.SettingsRow row = store.settings().orElseThrow();
        ObjectNode later = (ObjectNode) row.body().deepCopy();
        later.put("maxWeightStockPct", 8);
        List<PaperStore.SettingsRow> passed = new CopyOnWriteArrayList<>();
        when(packets.build(any(), anyString(), anyBoolean(), any(), any())).thenAnswer(call -> {
            passed.add(call.getArgument(4));
            store.saveSettings(later, List.of("maxWeightStockPct"));   // 결정이 행을 읽은 뒤 설정 탭에서 저장
            return new PacketBuilder.Packet(MAPPER.readTree("{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\"}}"),
                    PACKET_TEXT, "hash-abc", List.of(), null);
        });
        answerJson(decision(5, "오늘은 주문 없음"));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(passed).containsExactly(row);
        assertThat(d.settingsVersion()).isEqualTo(row.version());
        String system = requests.get(0).path("system").get(0).path("text").asString();
        assertThat(system).contains("종목 비중 ≤ 10%").doesNotContain("종목 비중 ≤ 8%");
        assertThat(store.settings().orElseThrow().version()).as("저장한 설정은 다음 결정부터").isEqualTo(row.version() + 1);
    }

    @Test
    @DisplayName("검증까지 끝난 새 결정은 앞선 결정의 대기 주문을 '다음 결정이 대신함'으로 취소한다(같은 매수가 두 번 체결되지 않게)")
    void laterDecisionSupersedesPendingOrders() throws Exception {
        activeCashOnly();
        answerJson(decision(10, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION")));
        Decision first = service().decide(MON, RuleBookService.SCHEDULED, true);
        long firstOrder = claudeOrders("PENDING").get(0).id();

        answerJson(decision(10, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION")));
        Decision manual = service().decide(MON, RuleBookService.MANUAL, false);

        assertThat(store.orders.get(firstOrder).status()).isEqualTo("CANCELLED");
        assertThat(store.orders.get(firstOrder).rejectReason()).isEqualTo("다음 결정이 대신함");
        assertThat(claudeOrders("PENDING")).singleElement().satisfies(o ->
                assertThat(o.decisionId()).isEqualTo(manual.id()));
        assertThat(manual.response().path("supersededOrders").get(0).asLong()).isEqualTo(firstOrder);
        assertThat(manual.pricesFinal()).isFalse();
        assertThat(first.id()).isNotEqualTo(manual.id());
    }

    // ------------------------------------------------------------------ 실패
    @Test
    @DisplayName("형식 오류(스키마 밖·JSON 아님): FORMAT_ERROR, 주문·장부 변화 없음, 위반 문구와 원문을 남기고 재시도하지 않는다")
    void formatErrorLeavesLedgerUntouched() throws Exception {
        activeWithHolding();
        answerJson("{\"schemaVersion\":2,\"stance\":\"MAYBE\"}");

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_FORMAT_ERROR);
        assertThat(d.error()).contains("스키마 위반");
        assertThat(d.responseRaw()).contains("MAYBE");
        assertThat(d.targetExposurePct()).isNull();
        assertThat(d.response().path("failure").path("violations").size()).isPositive();
        assertThat(d.response().has("stance")).as("검사를 지나지 못한 응답은 결정 응답으로 싣지 않음").isFalse();
        assertThat(d.response().path("measure").toString()).as("실패한 결정도 보낸 패킷의 측정 태그").isEqualTo(MEASURE_JSON);
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(95_000);
        assertThat(callsToday()).isEqualTo(1);
        assertThat(service().decide(MON, RuleBookService.SCHEDULED, true).id()).as("재시도 없음").isEqualTo(d.id());
        assertThat(hits.get()).isEqualTo(1);

        answerJson("이건 JSON이 아닙니다");
        Decision manual = service().decide(MON, RuleBookService.MANUAL, true);
        assertThat(manual.status()).isEqualTo(ClaudeBookService.STATUS_FORMAT_ERROR);
        assertThat(manual.error()).contains("JSON");
    }

    @Test
    @DisplayName("거절(refusal): REFUSED, 주문·장부 변화 없음, 다른 모델로 넘어가지 않고 재시도하지 않는다")
    void refusalLeavesLedgerUntouched() throws Exception {
        activeWithHolding();
        answer(200, message("[]", "refusal",
                ",\"stop_details\":{\"type\":\"refusal\",\"category\":\"cyber\",\"explanation\":\"정책상 답할 수 없습니다\"}"));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_REFUSED);
        assertThat(d.error()).contains("REFUSAL", "cyber");
        assertThat(d.frameworkVersion()).as("실패한 결정도 부른 판 번호를 남김").isZero();
        assertThat(d.response().path("framework").path("status").asString()).isEqualTo("INTERIM");
        assertThat(d.usage().path("stopReason").asString()).isEqualTo("refusal");
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(store.positions(PaperBooks.CLAUDE)).hasSize(1);
        assertThat(service().decide(MON, RuleBookService.SCHEDULED, true).id()).isEqualTo(d.id());
        assertThat(hits.get()).as("한 모델로 한 번만").isEqualTo(1);
        assertThat(requests).extracting(r -> r.path("model").asString()).containsOnly("claude-sonnet-5-5");
    }

    @Test
    @DisplayName("429: API_ERROR(재시도 전) → 다음 실행에서 같은 행을 한 번 더(retryCount 1, 통과 주문은 그 결정 번호로) → 그 뒤로는 부르지 않음")
    void apiErrorIsRetriedOnceOnTheSameRow() throws Exception {
        activeWithHolding();
        answer(429, RATE_LIMITED);

        Decision failed = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(failed.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(failed.error()).contains("RATE_LIMIT", "429");
        assertThat(failed.retryCount()).isZero();
        assertThat(failed.usage().path("inputTokens").isNull()).as("응답이 없으면 토큰은 null").isTrue();
        assertThat(failed.packetText()).as("실패한 결정도 보낸 패킷을 남김").isEqualTo(PACKET_TEXT);
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(callsToday()).as("실패도 호출 1회").isEqualTo(1);
        assertThat(store.apiUsage(TODAY_KST).orElseThrow().estCostUsd())
                .as("토큰을 모르는 호출은 추정하지 않음(0달러로 채우지 않음)").isNull();
        assertThat(ClaudeBookService.retryable(failed)).isTrue();

        answerJson(decision(15, null, order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION")));
        Decision retried = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(retried.id()).isEqualTo(failed.id());
        assertThat(retried.retryCount()).isEqualTo(1);
        assertThat(retried.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(retried.error()).isNull();
        assertThat(retried.packetText()).isEqualTo(PACKET_TEXT);
        assertThat(store.decisionsOf(PaperBooks.CLAUDE)).hasSize(1);
        assertThat(claudeOrders("PENDING")).singleElement().satisfies(o ->
                assertThat(o.decisionId()).isEqualTo(failed.id()));
        assertThat(callsToday()).isEqualTo(2);

        answer(429, RATE_LIMITED);
        assertThat(service().decide(MON, RuleBookService.SCHEDULED, true).retryCount()).isEqualTo(1);
        assertThat(hits.get()).as("재시도는 한 번뿐").isEqualTo(2);
    }

    @Test
    @DisplayName("재시도한 API 오류가 또 실패하면 그 행은 API_ERROR·retryCount 1로 끝난다(세 번째는 없음)")
    void secondApiErrorEndsRetries() {
        activeWithHolding();
        answer(429, RATE_LIMITED);
        answer(500, "{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"boom\"}}");

        service().decide(MON, RuleBookService.SCHEDULED, true);
        Decision second = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(second.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(second.retryCount()).isEqualTo(1);
        assertThat(ClaudeBookService.retryable(second)).isFalse();
        assertThat(second.response().path("failure").path("retry").asBoolean()).isTrue();
        assertThat(hits.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("키가 없으면 API_ERROR(NO_KEY) — 요청을 보내지 않았으니 호출 수를 돌려놓는다")
    void missingKeyDoesNotCountACall() {
        activeWithHolding();

        Decision d = service("").decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(d.error()).contains("NO_KEY");
        assertThat(callsToday()).isZero();
        assertThat(hits.get()).isZero();
    }

    // ------------------------------------------------------------------ 일일 상한
    @Test
    @DisplayName("일일 호출 상한(기본 30, 오늘 KST 30회)에 닿았으면 부르지 않고 SKIPPED — 재시도 차례였으면 그 재시도를 쓴 것으로 남긴다")
    void dailyCapSkipsWithoutCalling() {
        activeWithHolding();
        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 30, 0, 0, 0, 0));

        Decision skipped = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(skipped.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(skipped.response().path("summary").asString()).contains("일일 호출 상한(30회");
        assertThat(skipped.model()).isNull();
        assertThat(hits.get()).isZero();
        assertThat(callsToday()).isEqualTo(30);
        verify(packets, org.mockito.Mockito.never()).build(any(), anyString(), anyBoolean(), any(), any());

        // 재시도 차례인 API 오류 + 상한 → 부르지 않고 재시도를 씀(10분마다 다시 오지 않게)
        long id = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, "MANUAL", null, "API_ERROR",
                "claude-sonnet-5-5", null, 1, null, null, null, null, null, null, null, "[RATE_LIMIT] 429", null, true,
                5L, 0)).orElseThrow();
        Decision consumed = service().decide(MON, RuleBookService.MANUAL, true);
        assertThat(consumed.id()).isEqualTo(id);
        assertThat(consumed.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(consumed.retryCount()).isEqualTo(1);
        assertThat(consumed.error()).contains("[RATE_LIMIT] 429", "재시도 안 함", "일일 호출 상한");
        assertThat(hits.get()).isZero();

        // 상한 0 = 부르지 않음
        store.apiUsage.clear();
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).put("apiDailyCallCap", 0);
        assertThat(service().decide(PaperFixtures.TUE, RuleBookService.SCHEDULED, true).status())
                .isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(hits.get()).isZero();
    }

    @Test
    @DisplayName("시작 전 책은 결정 400, 일시정지 책은 부르지 않고 SKIPPED")
    void notStartedAndPaused() {
        notStartedWithStartPrices();
        assertThatThrownBy(() -> service().decide(MON, RuleBookService.SCHEDULED, true))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("시작 전");

        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.PAUSED, FRI_CLOSE));
        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(d.response().path("summary").asString()).contains("일시정지");
        assertThat(d.response().has("measure")).as("패킷을 만들지 않은 결정에는 측정 태그가 없음").isFalse();
        assertThat(hits.get()).isZero();
        assertThatThrownBy(() -> service().decide(MON, RuleBookService.INITIAL, true))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("일시정지 중 수동 결정은 행 없이 400 — 같은 거래일에 재개한 뒤 다시 누르면 Claude를 부른다(SKIPPED가 그날 수동 결정을 쓰지 않게)")
    void pausedManualLeavesNoRow() throws Exception {
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 재량 책", 100_000,
                FRI, PaperBooks.PAUSED, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 100_000, 100_000, 0, 0, FRI_CLOSE,
                FRI_CLOSE, FRI, null));

        assertThatThrownBy(() -> service().decide(MON, RuleBookService.MANUAL, false))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("일시정지").hasMessageContaining("재개");
        assertThat(store.decisionFor(PaperBooks.CLAUDE, MON, RuleBookService.MANUAL)).isEmpty();
        assertThat(hits.get()).isZero();
        assertThat(callsToday()).isZero();

        activeCashOnly();   // 같은 거래일에 재개
        answerJson(decision(0, "관망"));
        Decision manual = service().decide(MON, RuleBookService.MANUAL, false);
        assertThat(manual.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(hits.get()).as("재개한 뒤에는 Claude를 부름").isEqualTo(1);
    }

    // ------------------------------------------------------------------ 노출
    @Test
    @DisplayName("노출 0%(주문 없음)·100%(ETF 다섯 × 20%) 모두 거절 사유가 아니다 — 현금 비중은 하드 규칙이 아님(D7)")
    void zeroAndFullExposureAreBothAccepted() throws Exception {
        activeCashOnly();
        answerJson(decision(0, "세 축 모두 압박 — 전부 현금"));

        Decision zero = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(zero.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(zero.targetExposurePct()).isEqualTo(0.0);
        assertThat(zero.error()).isNull();
        assertThat(zero.response().path("exposureMismatch").asBoolean(true)).isFalse();
        assertThat(zero.response().path("noTradeReason").asString()).contains("현금");
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();

        answerJson(decision(100, null,
                order("XLK", "BUY", 20.0, null, "NEXT_OBSERVATION"), order("XLF", "BUY", 20.0, null, "NEXT_OBSERVATION"),
                order("XLE", "BUY", 20.0, null, "NEXT_OBSERVATION"), order("XLV", "BUY", 20.0, null, "NEXT_OBSERVATION"),
                order("XLI", "BUY", 20.0, null, "NEXT_OBSERVATION")));

        Decision full = service().decide(MON, RuleBookService.MANUAL, true);

        assertThat(full.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(full.targetExposurePct()).isEqualTo(100.0);
        assertThat(full.response().path("validation")).allSatisfy(v ->
                assertThat(v.path("accepted").asBoolean()).as(v.toString()).isTrue());
        assertThat(full.response().path("expectedExposurePct").asDouble()).isEqualTo(100.0);
        assertThat(full.response().path("exposureMismatch").asBoolean(true)).isFalse();
        assertThat(claudeOrders("PENDING")).hasSize(5);
    }

    // ------------------------------------------------------------------ 미리보기·시작
    @Test
    @DisplayName("미리보기: 초기 패킷으로 부르고 검증까지 — 장부·결정·주문·체결을 건드리지 않고 사용량만 남긴다")
    void previewDoesNotTouchLedgerOrDecisions() throws Exception {
        notStartedWithStartPrices();
        answerJson(decision(60, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("SHY", "BUY", 50.0, null, "NEXT_OBSERVATION")));

        Map<String, Object> preview = service().preview();

        assertThat(preview.get("ok")).isEqualTo(true);
        assertThat(preview.get("preview")).isEqualTo(true);
        assertThat(preview.get("status")).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(preview.get("asOfTradingDate")).isEqualTo("2026-10-23");
        assertThat(preview.get("model")).isEqualTo("claude-sonnet-5-5");
        assertThat(preview.get("packetHash")).isEqualTo("hash-abc");
        assertThat(((JsonNode) preview.get("validation"))).hasSize(2)
                .allSatisfy(v -> assertThat(v.path("accepted").asBoolean()).isTrue());
        assertThat(((JsonNode) preview.get("response")).path("stance").asString()).isEqualTo("RISK_ON");
        assertThat(preview.get("exposureMismatch")).isEqualTo(false);
        assertThat(((JsonNode) preview.get("response")).path("measure").toString()).isEqualTo(MEASURE_JSON);
        assertThat((String) preview.get("note")).as("무엇을 남겼는지 그대로 — 사용량만이 아님")
                .contains("장부·결정·주문 기록은 바꾸지 않았습니다", "사용량", "출발일 기관 선정", "출발일 종가")
                .doesNotContain("사용량만");
        verify(packets).build(eq(FRI), eq("INITIAL"), eq(true), any(), any());

        assertThat(store.decisions).isEmpty();
        assertThat(store.orders).isEmpty();
        assertThat(store.fills).isEmpty();
        assertThat(store.books.get(PaperBooks.CLAUDE).status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(100_000);
        assertThat(store.nav.getOrDefault(PaperBooks.CLAUDE, new java.util.TreeMap<>())).isEmpty();
        assertThat(callsToday()).isEqualTo(1);
    }

    @Test
    @DisplayName("시작: 통과 주문을 얼려 둔 출발일 종가 + 슬리피지로 사후 체결, 거절은 REJECTED로 남기고 책은 운용·출발일로")
    void startBackfillsAcceptedOrdersAtFrozenStartPrices() throws Exception {
        notStartedWithStartPrices();
        answerJson(decision(60, null,
                order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("SHY", "BUY", 50.0, null, "NEXT_CLOSE"),
                order("ZZZ", "BUY", 5.0, null, "NEXT_OBSERVATION"),
                order("NOPX", "BUY", 5.0, null, "NEXT_OBSERVATION")));

        ClaudeBookService.StartResult result = service().start();

        Decision d = result.decision();
        assertThat(d.kind()).isEqualTo("INITIAL");
        assertThat(d.asOfTradingDate()).isEqualTo(FRI);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.targetExposurePct()).isEqualTo(60.0);
        assertThat(d.response().path("fills")).hasSize(2);
        assertThat(d.response().path("measure").toString()).as("초기 결정도 같은 자리(체결을 덧붙인 뒤에도 남음)")
                .isEqualTo(MEASURE_JSON);

        double aaaPrice = PaperLedger.fillPrice(50.0, PaperLedger.Side.BUY, 5);
        double shyPrice = PaperLedger.fillPrice(82.5, PaperLedger.Side.BUY, 5);
        assertThat(result.fills()).extracting(Fill::ticker).containsExactly("AAA", "SHY");
        Fill aaa = result.fills().get(0);
        assertThat(aaa.rawPrice()).isEqualTo(50.0);
        assertThat(aaa.price()).isEqualTo(PaperLedgerService.price6(aaaPrice));
        assertThat(aaa.qty()).isEqualTo(PaperLedger.buyQty(10_000, PaperLedgerService.price6(aaaPrice)));
        assertThat(aaa.backfill()).isTrue();
        assertThat(aaa.observedAt()).isEqualTo(FRI_CLOSE);
        assertThat(aaa.priceSource()).isEqualTo("equity_close");
        assertThat(result.fills().get(1).qty()).isEqualTo(PaperLedger.buyQty(50_000,
                PaperLedgerService.price6(shyPrice)));

        assertThat(claudeOrders("FILLED")).allSatisfy(o -> {
            assertThat(o.timing()).isEqualTo("BACKFILL");
            assertThat(o.source()).isEqualTo("CLAUDE");
            assertThat(o.decisionId()).isEqualTo(d.id());
        });
        assertThat(claudeOrders("REJECTED")).extracting(Order::ticker, Order::rejectReason)
                .containsExactlyInAnyOrder(org.assertj.core.groups.Tuple.tuple("ZZZ", "OUT_OF_UNIVERSE"),
                        org.assertj.core.groups.Tuple.tuple("NOPX", "NO_PRICE"));
        assertThat(claudeOrders("PENDING")).isEmpty();

        Book book = store.books.get(PaperBooks.CLAUDE);
        assertThat(book.status()).isEqualTo(PaperBooks.ACTIVE);
        assertThat(book.startedOn()).isEqualTo(FRI);
        assertThat(store.navSeries(PaperBooks.CLAUDE)).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(FRI);
            assertThat(row.pricesFinal()).isTrue();
        });
        assertThat(callsToday()).isEqualTo(1);
        verify(packets).build(eq(FRI), eq("INITIAL"), eq(true), any(), any());

        assertThatThrownBy(() -> service().start()).as("한 번뿐").isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("이미 시작");
    }

    @Test
    @DisplayName("초기 배분(사후 체결 주문)은 그달 재량 주문 상한을 먹지 않는다 — 시작 뒤 첫 결정도 월 상한 자리가 그대로")
    void initialBackfillDoesNotUseMonthlyCap() throws Exception {
        notStartedWithStartPrices();
        answerJson(decision(60, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("SHY", "BUY", 50.0, null, "NEXT_OBSERVATION")));
        service().start();
        assertThat(claudeOrders("FILLED")).hasSize(2).allSatisfy(o -> {
            assertThat(o.timing()).isEqualTo("BACKFILL");
            assertThat(o.asOfTradingDate()).as("출발일 전 거래일 — 같은 10월").isEqualTo(LocalDate.of(2026, 10, 22));
        });
        // 월 상한 2 — 사후 체결 주문 둘을 세면 자리가 0이라 다음 결정의 매수가 MONTHLY_CAP으로 거절됩니다.
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).put("maxDiscretionaryOrdersPerMonth", 2);

        answerJson(decision(65, null, order("XLK", "BUY", 5.0, null, "NEXT_OBSERVATION")));
        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.response().path("monthlyDiscretionaryOrders").asInt()).isZero();
        assertThat(d.response().path("validation").get(0).path("accepted").asBoolean())
                .as(d.response().path("validation").toString()).isTrue();
        assertThat(claudeOrders("PENDING")).singleElement().extracting(Order::ticker).isEqualTo("XLK");
    }

    @Test
    @DisplayName("시작: 통과 주문이 없으면(노출 0%) 현금만 든 채 운용으로, 호출이 실패하면 시작하지 않고 400(책은 시작 전 그대로)")
    void startWithoutOrdersAndStartFailure() throws Exception {
        notStartedWithStartPrices();
        answer(429, RATE_LIMITED);

        assertThatThrownBy(() -> service().start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("시작하지 않았습니다").hasMessageContaining("API 오류");
        assertThat(store.books.get(PaperBooks.CLAUDE).status()).isEqualTo(PaperBooks.NOT_STARTED);
        assertThat(store.decisions).isEmpty();
        assertThat(callsToday()).isEqualTo(1);

        answerJson(decision(0, "관망 — 출발일엔 현금"));
        ClaudeBookService.StartResult result = service().start();
        assertThat(result.decision().status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(result.fills()).isEmpty();
        assertThat(store.books.get(PaperBooks.CLAUDE).status()).isEqualTo(PaperBooks.ACTIVE);
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(100_000);
        assertThat(store.states.get(PaperBooks.CLAUDE).exposurePct()).isZero();
    }

    @Test
    @DisplayName("미리보기·시작도 일일 호출 상한을 지킨다 — 닿았으면 부르지 않고 400")
    void previewRespectsDailyCap() {
        notStartedWithStartPrices();
        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 30, 0, 0, 0, 0));

        assertThatThrownBy(() -> service().preview()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("일일 호출 상한");
        assertThatThrownBy(() -> service().start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("일일 호출 상한");
        assertThat(hits.get()).isZero();
    }

    @Test
    @DisplayName("정기 작업 몫 예약(2단계 명세 §4-10·§5, E2b): 수동 호출(미리보기·시작·수동 결정)은 그날 호출이 상한 30 − 예약 7 = 23 미만일 때만, 정기 결정은 상한까지 — 23회째 뒤에도 정기 결정은 부르고 29회면 30회째를 씀")
    void manualCallsStopAtCapMinusReserveScheduledGoToCap() throws Exception {
        activeWithHolding();
        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 23, 0, 0, 0, 0));

        Decision manual = service().decide(MON, RuleBookService.MANUAL, true);
        assertThat(manual.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(manual.response().path("summary").asString()).contains("일일 호출 상한(30회")
                .contains("정기 작업 몫 7회를 남겨 수동 호출은 23회까지").contains("apiScheduledReserve");
        assertThat(hits.get()).as("수동 결정은 부르지 않음").isZero();
        assertThat(callsToday()).isEqualTo(23);

        answerJson(decision(5, "관망"));
        Decision scheduled = service().decide(MON, RuleBookService.SCHEDULED, true);
        assertThat(scheduled.status()).as("정기 결정은 예약 몫을 씀").isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(hits.get()).isEqualTo(1);
        assertThat(callsToday()).isEqualTo(24);

        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 29, 0, 0, 0, 0));
        answerJson(decision(5, "관망"));
        assertThat(service().decide(PaperFixtures.TUE, RuleBookService.SCHEDULED, true).status())
                .as("상한까지 — 30회째").isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(callsToday()).isEqualTo(30);
        assertThat(hits.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("정기 작업 몫 예약: 미리보기·시작은 수동 호출 — 22회면 부르고 23회면 400(예약 문구), 예약이 상한 이상이면 수동 호출은 늘 막힘")
    void previewStopsAtCapMinusReserve() throws Exception {
        notStartedWithStartPrices();
        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 23, 0, 0, 0, 0));
        assertThatThrownBy(() -> service().preview()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("정기 작업 몫 7회를 남겨 수동 호출은 23회까지");
        assertThatThrownBy(() -> service().start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("정기 작업 몫 7회를 남겨 수동 호출은 23회까지");
        assertThat(hits.get()).isZero();

        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 22, 0, 0, 0, 0));
        answerJson(decision(0, "관망"));
        assertThat(service().preview()).containsEntry("preview", true);
        assertThat(hits.get()).as("22회 — 23회째 수동 호출").isEqualTo(1);
        assertThat(callsToday()).isEqualTo(23);

        store.apiUsage.clear();
        ((ObjectNode) store.settings.body()).put("apiScheduledReserve", 30);
        assertThatThrownBy(() -> service().preview()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("수동 호출은 0회까지");
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("설정의 모델·effort·상한을 읽고, 목록 밖이면 기본값(sonnet·high·20)")
    void claudeSettingsFallBackToDefaults() {
        JsonNode body = MAPPER.valueToTree(Map.of("model", "claude-haiku-5-5", "effort", "MAX", "apiDailyCallCap", 2));
        ClaudeBookService.ClaudeSettings read = ClaudeBookService.ClaudeSettings.from(body);
        assertThat(read.model()).isEqualTo("claude-haiku-5-5");
        assertThat(read.effort()).isEqualTo("max");
        assertThat(read.dailyCallCap()).isEqualTo(2);
        assertThat(read.fallbacks()).isEmpty();

        ClaudeBookService.ClaudeSettings bad = ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of(
                "model", "claude-opus-5-5", "effort", "turbo", "apiDailyCallCap", 600)));
        assertThat(bad.model()).isEqualTo("claude-sonnet-5-5");
        assertThat(bad.effort()).isEqualTo("high");
        assertThat(bad.dailyCallCap()).isEqualTo(30);
        assertThat(bad.fallbacks()).containsExactly("model", "effort", "apiDailyCallCap");

        // 정기 작업 몫 예약(E2b) — 없거나 범위 밖이면 기본 7(fallbacks에는 넣지 않음 — 결정 응답의 settings.fallbacks가 그 키 전의 행에서도 그대로).
        assertThat(read.scheduledReserve()).isEqualTo(7);
        assertThat(read.callLimit(true)).isEqualTo(2);
        assertThat(read.callLimit(false)).as("예약이 상한 이상 — 수동 호출은 늘 막힘").isZero();
        ClaudeBookService.ClaudeSettings reserved = ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of(
                "apiDailyCallCap", 20, "apiScheduledReserve", 9)));
        assertThat(reserved.scheduledReserve()).isEqualTo(9);
        assertThat(reserved.callLimit(true)).isEqualTo(20);
        assertThat(reserved.callLimit(false)).isEqualTo(11);
        assertThat(ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of("apiScheduledReserve", 2.5)))
                .scheduledReserve()).isEqualTo(7);
        // 범위(0~50) 밖은 아래·위 모두 기본 7 — 음수 예약을 받으면 수동 문턱이 상한을 넘음(20 − (−1) = 21).
        for (int outside : new int[] {-1, 51}) {
            ClaudeBookService.ClaudeSettings clamped = ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of(
                    "apiDailyCallCap", 20, "apiScheduledReserve", outside)));
            assertThat(clamped.scheduledReserve()).as("apiScheduledReserve " + outside).isEqualTo(7);
            assertThat(clamped.callLimit(false)).as("apiScheduledReserve " + outside).isEqualTo(13);
            assertThat(clamped.callLimit(true)).isEqualTo(20);
        }
        ClaudeBookService.ClaudeSettings edges = ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of(
                "apiDailyCallCap", 50, "apiScheduledReserve", 50)));
        assertThat(edges.scheduledReserve()).as("끝값 50은 받음").isEqualTo(50);
        assertThat(ClaudeBookService.ClaudeSettings.from(MAPPER.valueToTree(Map.of("apiScheduledReserve", 0)))
                .scheduledReserve()).as("끝값 0은 받음").isZero();
        assertThat(bad.fallbacks()).doesNotContain("apiScheduledReserve");
    }

    // ------------------------------------------------------------------ 시장 격리(2단계 명세 §9 A6)
    /** 시험용 한국 패킷 — 미국 가짜 패킷과 글자가 다름. */
    private static final String KR_PACKET_TEXT = "{\"0_instructions\":\"시험용 한국 패킷\"}";

    /**
     * 시계를 바꾸고 시험용 한국 결정 문맥(가짜 패킷 — 받은 인자를 {@code krPacketCalls}에 남김, 응답 스키마는 미국과 같은 파일)을 더한
     * 서비스.
     */
    private ClaudeBookService serviceWithKr(Instant now, List<String> krPacketCalls) throws Exception {
        return serviceWithKr(TestKrMarket.INSTANCE, now, krPacketCalls);
    }

    /** {@link #serviceWithKr(Instant, List)}의 시장 판 — 달력만 바꾼 시험용 한국 묶음({@link TestKrMarket#withCalendar})용. */
    private ClaudeBookService serviceWithKr(PaperMarket market, Instant now, List<String> krPacketCalls)
            throws Exception {
        Clock clock = Clock.fixed(now, ZoneOffset.UTC);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger,
                PaperFixtures.config(), MAPPER, clock);
        AiService ai = ai(KEY);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        PacketBuilder.Packet krPacket = new PacketBuilder.Packet(MAPPER.readTree(KR_PACKET_TEXT), KR_PACKET_TEXT,
                "hash-kr", List.of(), null);
        ClaudeDecisionPipeline.MarketContext kr = new ClaudeDecisionPipeline.MarketContext(market,
                (asOf, kind, initial, version, row) -> {
                    krPacketCalls.add(asOf + " " + kind + " " + initial + " v" + version + " s" + row.version());
                    return krPacket;
                }, ClaudeBookService.SCHEMA_RESOURCE);
        return new ClaudeBookService(store, reader, marketData, selection, ledger, admin, packets,
                new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock), calls, ai, settings,
                PaperFixtures.config(), MAPPER, 30, clock, List.of(kr));
    }

    private static String systemText(JsonNode request) {
        JsonNode system = request.path("system");
        return system.isArray() ? system.get(0).path("text").asString() : system.asString();
    }

    @Test
    @DisplayName("시장 격리(A6): 다른 시장 문맥의 결정은 그 시장 Claude 책·관측치·달력(주문 만료·재진입 금지를 보는 다음 세션)·패킷·시스템 프롬프트의 시장별 부분만 쓰고, 미국 Claude 책의 대기 주문·결정·상태는 그대로 — 하루 호출 상한은 두 시장이 함께 셈")
    void otherMarketDecisionTouchesOnlyItsBook() throws Exception {
        PaperFixtures.dropKrDefaults(store);   // 시험용 한국 묶음의 기본값(최소 주문 500원)으로
        // 세션 2026-11-25(수): 미국은 다음 날(11-26 추수감사절) 휴장, 시험용 한국 달력(서울 평일)은 거래일 — 두 달력이 갈리는 주.
        LocalDate wed = LocalDate.of(2026, 11, 25);
        Instant now = Instant.parse("2026-11-25T13:30:00Z");   // KST 11-25 22:30
        LocalDate todayKst = LocalDate.of(2026, 11, 25);
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        activeCashOnly();
        long usPending = PaperFixtures.pending(store, PaperBooks.CLAUDE, "AAA", "BUY", null, 5.0, null,
                "NEXT_OBSERVATION", FRI, FRI_CLOSE);
        BookState usState = store.states.get(PaperBooks.CLAUDE);
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
        long krPending = PaperFixtures.pending(store, krBook, "KRB", "BUY", null, 5.0, null, "NEXT_CLOSE", FRI,
                FRI_CLOSE);
        // 재진입 금지 11-26까지 — 한국 달력의 다음 세션(11-26)이면 막히고, 미국 달력이었다면 다음 세션이 11-27이라 풀립니다.
        store.upsertLockout(new PaperStore.Lockout(krBook, "KRL", LocalDate.of(2026, 11, 26), "STOP"));
        when(marketData.quotes(market(kr))).thenReturn(Optional.of(quotes(Instant.parse("2026-11-25T12:00:00Z"),
                bar("KRA", LocalDate.of(2026, 11, 24), 50, wed, 51), bar("KRB", LocalDate.of(2026, 11, 24), 30, wed, 31),
                bar("KRL", LocalDate.of(2026, 11, 24), 20, wed, 21))));
        store.apiUsage.put(todayKst, new ApiUsage(todayKst, 29, 0, 0, 0, 0));
        answerJson(decision(8, null, order("KRA", "BUY", 8.0, null, "NEXT_CLOSE"),
                order("KRL", "BUY", 5.0, null, "NEXT_CLOSE")));
        List<String> krPacketCalls = new java.util.ArrayList<>();
        ClaudeBookService service = serviceWithKr(now, krPacketCalls);

        Decision d = service.decide(kr, wed, RuleBookService.SCHEDULED, true);

        assertThat(d.bookCode()).isEqualTo(krBook);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.packetText()).isEqualTo(KR_PACKET_TEXT);
        assertThat(d.packetHash()).isEqualTo("hash-kr");
        assertThat(d.response().path("book").asString()).isEqualTo(krBook);
        assertThat(krPacketCalls).as("그 시장 패킷을 결정이 읽은 판·설정 행으로").containsExactly(
                wed + " SCHEDULED false v0 s" + store.settings().orElseThrow().version());
        verify(packets, org.mockito.Mockito.never()).build(any(), anyString(), anyBoolean(), any(), any());
        assertThat(requests).hasSize(1);
        assertThat(systemText(requests.get(0))).as("시스템 프롬프트의 시장별 부분은 그 시장 묶음의 것")
                .contains("- 시험용 한국 하드 규칙 — 최대 20종목").contains("## 시험용 한국 고정(고정)")
                .doesNotContain("주문 최소 $").doesNotContain("## 근거(고정)");
        assertThat(requests.get(0).path("messages").get(0).toString()).contains("시험용 한국 패킷");

        List<Order> krOrders = store.ordersOf(krBook);
        assertThat(krOrders).filteredOn(o -> Long.valueOf(d.id()).equals(o.decisionId()))
                .extracting(Order::ticker, Order::status, Order::rejectReason, Order::expiresOn)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("KRA", "PENDING", null, LocalDate.of(2026, 11, 30)),
                        org.assertj.core.groups.Tuple.tuple("KRL", "REJECTED", "LOCKED_OUT", null));
        assertThat(PaperFixtures.order(store, krPending).status()).as("그 시장 앞선 대기 주문은 다음 결정이 대신함")
                .isEqualTo(PaperBooks.ORDER_CANCELLED);

        assertThat(PaperFixtures.order(store, usPending).status()).as("미국 책의 대기 주문은 그대로")
                .isEqualTo(PaperBooks.ORDER_PENDING);
        assertThat(store.decisionFor(PaperBooks.CLAUDE, wed, RuleBookService.SCHEDULED)).isEmpty();
        assertThat(store.states.get(PaperBooks.CLAUDE)).isEqualTo(usState);
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).hasSize(1);

        // 하루 호출 상한(기본 30)은 시장과 상관없이 하나 — 한국 결정이 30번째를 썼으니 같은 날 미국 결정은 부르지 않음.
        assertThat(store.apiUsage(todayKst).map(ApiUsage::calls)).contains(30);
        Decision us = service.decide(wed, RuleBookService.SCHEDULED, true);
        assertThat(us.bookCode()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(us.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(us.response().path("summary").asString()).contains("일일 호출 상한(30회");
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("자정 넘은 한국 재시도(명세 §4-10·§5, D1c) — 화 00:10 KST 실행의 세션은 그 시장 달력의 lastCompletedSession = 월(기준 거래일 D 그대로), 호출 수는 다음 KST 날(화) 줄에 셈")
    void midnightRetryCountsOnTheNextKstDay() throws Exception {
        PaperFixtures.dropKrDefaults(store);   // 시험용 한국 묶음의 기본값(최소 주문 500원)으로
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        LocalDate mon = PaperFixtures.MON;
        LocalDate tue = mon.plusDays(1);
        Instant now = Instant.parse("2026-10-26T15:10:00Z");   // 화 00:10 KST
        activeCashOnly();
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
        when(marketData.quotes(market(kr))).thenReturn(Optional.of(quotes(Instant.parse("2026-10-26T12:00:00Z"),
                bar("KRA", FRI, 50, mon, 51))));
        answerJson(decision(0, "시험 — 주문 없음"));
        LocalDate session = kr.calendar().lastCompletedSession(now);

        Decision d = serviceWithKr(now, new java.util.ArrayList<>()).decide(kr, session, RuleBookService.SCHEDULED, true);

        assertThat(session).isEqualTo(mon);
        assertThat(d.asOfTradingDate()).isEqualTo(mon);
        assertThat(store.apiUsage(tue).map(ApiUsage::calls)).as("호출 상한 줄 = Kst.today() — 다음 KST 날").contains(1);
        assertThat(store.apiUsage(mon)).as("세션 날 줄에는 세지 않음").isEmpty();
    }

    @Test
    @DisplayName("시장 표기(A7): 다른 시장 문맥의 결정은 그 시장의 받는 체결 시점·금액 표기로 검증 — 그 시장에 없는 시점(NEXT_OBSERVATION)은 MALFORMED, 근거 문구의 금액은 그 시장 표기('$' 없음)")
    void otherMarketValidatesWithItsTimingsAndMoney() throws Exception {
        PaperFixtures.dropKrDefaults(store);   // 시험용 한국 묶음의 기본값(최소 주문 500원)으로
        LocalDate wed = LocalDate.of(2026, 11, 25);
        Instant now = Instant.parse("2026-11-25T13:30:00Z");   // KST 11-25 22:30
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        activeCashOnly();
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
        when(marketData.quotes(market(kr))).thenReturn(Optional.of(quotes(Instant.parse("2026-11-25T12:00:00Z"),
                bar("KRA", LocalDate.of(2026, 11, 24), 50, wed, 51), bar("KRB", LocalDate.of(2026, 11, 24), 30, wed, 31),
                bar("KRC", LocalDate.of(2026, 11, 24), 20, wed, 21))));
        answerJson(decision(8, null, order("KRA", "BUY", 8.0, null, "NEXT_CLOSE"),
                order("KRB", "BUY", 5.0, null, "NEXT_OBSERVATION"), order("KRC", "BUY", 0.4, null, "NEXT_CLOSE")));
        ClaudeBookService service = serviceWithKr(now, new java.util.ArrayList<>());

        Decision d = service.decide(kr, wed, RuleBookService.SCHEDULED, true);

        assertThat(d.bookCode()).isEqualTo(krBook);
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(store.ordersOf(krBook)).filteredOn(o -> Long.valueOf(d.id()).equals(o.decisionId()))
                .extracting(Order::ticker, Order::status, Order::rejectReason)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("KRA", "PENDING", null),
                        org.assertj.core.groups.Tuple.tuple("KRB", "REJECTED", OrderValidator.MALFORMED),
                        org.assertj.core.groups.Tuple.tuple("KRC", "REJECTED", OrderValidator.MIN_NOTIONAL));
        List<String> details = new java.util.ArrayList<>();
        d.response().path("validation").forEach(row -> details.add(row.path("detail").asString()));
        assertThat(details).containsExactly(
                "현재 0.00% → 목표 8.00%(+8.00%p, 약 8,000원)",
                "timing은 NEXT_CLOSE여야 함: NEXT_OBSERVATION",
                "매수 증가분 약 400원 < 최소 500원(현재 0.00% → 목표 0.40%)");
        assertThat(d.response().path("validation").toString()).doesNotContain("$");
    }

    @Test
    @DisplayName("시장별 설정 읽기(C1a): 다른 시장의 결정은 검증기 한도·현금성을 그 시장 키(kr.)로 — 설정 루트(미국)의 최소 금액 500·현금성 SHY가 새지 않아, 현금성 KRC 30%는 비중 상한 없이 통과하고 8,000원 매수는 kr.minOrderNotional 9,000원에 걸림")
    void otherMarketValidatesWithItsSettingKeys() throws Exception {
        LocalDate wed = LocalDate.of(2026, 11, 25);
        Instant now = Instant.parse("2026-11-25T13:30:00Z");   // KST 11-25 22:30
        PaperMarket kr = TestKrMarket.INSTANCE;
        String krBook = TestKrMarket.CLAUDE_BOOK;
        ObjectNode body = (ObjectNode) store.settings.body();
        ObjectNode krKeys = body.putObject("kr");
        krKeys.put("minOrderNotional", 9_000);
        krKeys.putArray("cashLikeTickers").add("KRC");
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 100_000, 100_000, 0, 0, FRI_CLOSE, FRI_CLOSE, FRI, null));
        when(marketData.quotes(PaperFixtures.market(kr))).thenReturn(Optional.of(quotes(
                Instant.parse("2026-11-25T12:00:00Z"), bar("KRA", LocalDate.of(2026, 11, 24), 50, wed, 51),
                bar("KRC", LocalDate.of(2026, 11, 24), 100, wed, 101))));
        answerJson(decision(38, null, order("KRA", "BUY", 8.0, null, "NEXT_CLOSE"),
                order("KRC", "BUY", 30.0, null, "NEXT_CLOSE")));

        Decision d = serviceWithKr(now, new java.util.ArrayList<>()).decide(kr, wed, RuleBookService.SCHEDULED, true);

        assertThat(store.ordersOf(krBook)).filteredOn(o -> Long.valueOf(d.id()).equals(o.decisionId()))
                .extracting(Order::ticker, Order::status, Order::rejectReason)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("KRA", "REJECTED", OrderValidator.MIN_NOTIONAL),
                        org.assertj.core.groups.Tuple.tuple("KRC", "PENDING", null));
        assertThat(d.response().path("validation").get(0).path("detail").asString()).contains("최소 9,000원");
        assertThat(d.response().path("settings").toString()).as("결정 응답의 설정 요약도 그 시장 값")
                .contains("KRC").doesNotContain("SHY");
    }

    @Test
    @DisplayName("달력 없음(K35): 보유를 연 해의 공휴일 목록이 없으면 그 보유 거래일만 모름 — 결정은 이어 가고 그 종목 재량 매도는 MIN_HOLD('보유 거래일을 알 수 없음')")
    void unknownHoldingYearRejectsOnlyThatSell() throws Exception {
        LocalDate wed = LocalDate.of(2026, 11, 25);
        Instant now = Instant.parse("2026-11-25T13:30:00Z");   // KST 11-25 22:30
        // 2026년만 아는 한국 달력 — 2025-12-15에 연 보유의 거래일 수를 셀 수 없음.
        PaperMarket kr = TestKrMarket.withCalendar(new com.macrodash.analytics.KrxCalendar(java.util.Map.of(2026,
                List.of(LocalDate.of(2026, 1, 1), LocalDate.of(2026, 12, 25))), List.of()));
        String krBook = TestKrMarket.CLAUDE_BOOK;
        activeCashOnly();
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 80_000, 100_000, 20_000, 20, FRI_CLOSE, FRI_CLOSE, FRI, null));
        store.upsertPosition(new PaperStore.Position(krBook, "KRA", 200, 50, LocalDate.of(2025, 12, 15), FRI_CLOSE, 51,
                FRI_CLOSE, 51.0, FRI_CLOSE, false, LocalDate.of(2025, 12, 15), 50, null));
        store.upsertPosition(new PaperStore.Position(krBook, "KRB", 300, 30, LocalDate.of(2026, 11, 2), FRI_CLOSE, 31,
                FRI_CLOSE, 31.0, FRI_CLOSE, false, LocalDate.of(2026, 11, 2), 30, null));
        when(marketData.quotes(market(kr))).thenReturn(Optional.of(quotes(Instant.parse("2026-11-25T12:00:00Z"),
                bar("KRA", LocalDate.of(2026, 11, 24), 50, wed, 51), bar("KRB", LocalDate.of(2026, 11, 24), 30, wed, 31))));
        answerJson(decision(10, null, order("KRA", "SELL", null, 1.0, "NEXT_CLOSE"),
                order("KRB", "SELL", null, 1.0, "NEXT_CLOSE")));
        ClaudeBookService service = serviceWithKr(kr, now, new java.util.ArrayList<>());

        Decision d = service.decide(kr, wed, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(store.ordersOf(krBook)).filteredOn(o -> Long.valueOf(d.id()).equals(o.decisionId()))
                .extracting(Order::ticker, Order::status, Order::rejectReason)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("KRA", "REJECTED", OrderValidator.MIN_HOLD),
                        org.assertj.core.groups.Tuple.tuple("KRB", "PENDING", null));
        assertThat(d.response().path("validation").get(0).path("detail").asString()).contains("보유 거래일을 알 수 없음");
    }

    @Test
    @DisplayName("한국 운영 문맥(E2b): 한국 Claude 결정은 그 실행의 관측치·읽은 순간이 있어야 함 — 없으면 아무것도 읽거나 쓰기 전에 거절(결정 작업이 넘김)")
    void krDecisionNeedsTheRunInputs() {
        activeCashOnly();
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        AiService ai = ai(KEY);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        ClaudeBookService service = new ClaudeBookService(store, reader, marketData, selection, ledger,
                new PaperAdminService(store, marketData, reader, settings, ledger, PaperFixtures.config(), MAPPER, clock),
                packets, new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock), calls, ai, settings,
                PaperFixtures.config(), MAPPER, 30, clock, mock(KrPacketBuilder.class));

        assertThatThrownBy(() -> service.decide(KrPaperMarket.INSTANCE, MON, RuleBookService.SCHEDULED, true))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("관측치·읽은 순간");
        assertThat(store.decisions).isEmpty();
        assertThat(hits.get()).isZero();
        assertThat(callsToday()).isZero();
    }

    @Test
    @DisplayName("시장 격리(A6): 결정 문맥이 없는 시장이면 아무것도 읽거나 쓰기 전에 거절(코드 오류)")
    void unknownMarketIsRejected() {
        activeCashOnly();
        assertThatThrownBy(() -> service().decide(TestKrMarket.INSTANCE, MON, RuleBookService.SCHEDULED, true))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("KR");
        assertThat(store.decisions).isEmpty();
        assertThat(hits.get()).isZero();
    }

    @Test
    @DisplayName("한 실행 = 달력 한 벌·설정 판 하나(C1a): 결정 작업 한 번이 그 시장 달력을 한 번만 만들어 장부·관측치 요약·Claude 파이프라인(주문 만료)이 그 한 벌을 쓰고, 실행을 연 뒤 저장된 새 설정 판이 끼어도 결정 행의 settings_version·패킷·시스템 프롬프트는 그 실행이 읽은 판")
    void decisionRunUsesOneCalendarAndTheSettingsVersionItRead() throws Exception {
        PaperFixtures.dropKrDefaults(store);   // 시험용 한국 묶음의 기본값(최소 주문 500원)으로
        List<CountingCalendar> opened = new java.util.ArrayList<>();
        TestKrMarket kr = TestKrMarket.perRun(CountingCalendar.factory(opened, new java.util.ArrayList<>()));
        String krBook = TestKrMarket.CLAUDE_BOOK;
        store.books.put(krBook, TestKrMarket.book(krBook, 100_000, FRI));
        store.states.put(krBook, new BookState(krBook, 100_000, 100_000, 0, 0, null, null, null, null));
        int version = store.settings().orElseThrow().version();
        Instant collected = Instant.parse("2026-10-26T12:00:00Z");   // 월 21:00 KST — 시험용 한국 달력으로 확정 종가 뒤
        // 실행을 연 뒤(결정 작업이 관측치를 읽는 순간) 설정 탭에서 새 판을 저장 — 최대 종목 수 20 → 7.
        AtomicInteger quoteReads = new AtomicInteger();
        when(marketData.quotes(PaperFixtures.market(kr))).thenAnswer(invocation -> {
            if (quoteReads.getAndIncrement() == 0) {
                ObjectNode saved = ((ObjectNode) store.settings.body()).deepCopy();
                saved.put("maxPositions", 7);
                store.saveSettings(saved, List.of("maxPositions"));
            }
            return Optional.of(quotes(collected, bar("KRA", FRI, 50, MON, 51)));
        });
        answerJson(decision(8, null, order("KRA", "BUY", 8.0, null, "NEXT_CLOSE")));
        List<String> krPacketCalls = new java.util.ArrayList<>();
        Instant now = Instant.parse("2026-10-26T13:40:00Z");   // 월 22:40 KST — 시험용 한국 결정 시각(22:30) 뒤
        ClaudeBookService service = serviceWithKr(kr, now, krPacketCalls);
        PaperDecisionJob job = new PaperDecisionJob(store, reader, marketData, ledger, selection,
                mock(RuleBookService.class), service, settings, PaperFixtures.config(), MAPPER,
                Clock.fixed(now, ZoneOffset.UTC), List.of(kr));

        PaperDecisionJob.Result result = job.run(kr);

        assertThat(result.outcome()).isEqualTo(PaperDecisionJob.DECIDED);
        assertThat(quoteReads.get()).as("결정 작업·결정 저장 두 번 읽음").isEqualTo(2);
        assertThat(store.settings().orElseThrow().version()).as("실행 도중 새 판이 저장됨").isEqualTo(version + 1);
        Decision d = result.claude();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_OK);
        assertThat(d.settingsVersion()).as("결정 행의 settings_version = 그 실행이 읽은 판").isEqualTo(version);
        assertThat(krPacketCalls).as("패킷도 그 판으로").containsExactly(MON + " SCHEDULED false v0 s" + version);
        assertThat(systemText(requests.get(0))).as("시스템 프롬프트의 하드 규칙도 그 판(20종목)")
                .contains("- 시험용 한국 하드 규칙 — 최대 20종목").doesNotContain("최대 7종목");
        assertThat(opened).as("결정 작업 한 번에 달력 한 벌 — 실행 밖에서 달력을 물으면 이 시장 묶음은 던짐").hasSize(1);
        assertThat(opened.get(0).calls()).isPositive();
        assertThat(store.states.get(krBook).lastProcessedCollectedAt()).as("장부도 그 실행으로 돎").isEqualTo(collected);
        assertThat(store.navSeries(krBook)).extracting(PaperStore.NavRow::tradingDate, PaperStore.NavRow::pricesFinal)
                .containsExactly(org.assertj.core.groups.Tuple.tuple(MON, true));
        assertThat(store.ordersOf(krBook)).filteredOn(o -> Long.valueOf(d.id()).equals(o.decisionId()))
                .extracting(Order::ticker, Order::status, Order::expiresOn)
                .as("주문 만료 = 그 실행 달력의 3거래일 뒤(서울 평일 목요일)")
                .containsExactly(org.assertj.core.groups.Tuple.tuple("KRA", "PENDING", LocalDate.of(2026, 10, 29)));
        assertThat(store.jobRuns).extracting(PaperStore.JobRun::job).containsExactly("kr.decision");
    }

    // ------------------------------------------------------------------ 호출하는 사이의 변화·응답 뒤 오류
    private PaperAdminService admin() {
        return new PaperAdminService(store, marketData, reader, settings, ledger, PaperFixtures.config(), MAPPER,
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private List<Order> ordersOfDecision(long decisionId) {
        return store.ordersOf(PaperBooks.CLAUDE).stream().filter(o -> Long.valueOf(decisionId).equals(o.decisionId()))
                .toList();
    }

    @Test
    @DisplayName("Claude를 부르는 사이에 일시정지되면 대기 주문을 남기지 않는다 — 결정은 응답·검증과 함께 SKIPPED, 통과 주문은 '결정 중 일시정지'로 취소, 앞선 주문을 대신하지 않음")
    void pauseDuringCallLeavesNoPendingOrders() throws Exception {
        activeCashOnly();
        answerJson(decision(10, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION")));
        service().decide(MON, RuleBookService.SCHEDULED, true);
        long earlier = claudeOrders("PENDING").get(0).id();

        PaperAdminService admin = admin();
        duringCall = () -> admin.setStatus(PaperBooks.CLAUDE, PaperBooks.PAUSED);
        answerJson(decision(25, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("XLK", "BUY", 10.0, null, "NEXT_CLOSE"), order("ZZZ", "BUY", 5.0, null, "NEXT_OBSERVATION")));

        Decision manual = service().decide(MON, RuleBookService.MANUAL, true);

        assertThat(store.books.get(PaperBooks.CLAUDE).status()).isEqualTo(PaperBooks.PAUSED);
        assertThat(claudeOrders("PENDING")).as("재개해도 묵은 주문이 체결되지 않게").isEmpty();
        assertThat(manual.status()).isEqualTo(ClaudeBookService.STATUS_SKIPPED);
        assertThat(manual.responseRaw()).as("과금된 응답은 남김").contains("\"schemaVersion\":2");
        assertThat(manual.usage().path("inputTokens").asLong()).isEqualTo(21_000);
        assertThat(manual.response().path("validation")).hasSize(3);
        assertThat(manual.response().path("skipped").asString()).contains("일시정지", "2건");
        assertThat(manual.response().path("pausedDuringCall").asBoolean()).isTrue();
        assertThat(manual.response().has("supersededOrders")).isFalse();
        assertThat(store.orders.get(earlier).status()).isEqualTo("CANCELLED");
        assertThat(store.orders.get(earlier).rejectReason()).as("일시정지가 취소한 그대로 — 다음 결정이 대신하지 않음")
                .isNotEqualTo("다음 결정이 대신함");
        List<Order> mine = ordersOfDecision(manual.id());
        assertThat(mine).filteredOn(o -> o.status().equals("CANCELLED")).extracting(Order::ticker)
                .containsExactlyInAnyOrder("AAA", "XLK");
        assertThat(mine).filteredOn(o -> o.status().equals("CANCELLED")).allSatisfy(o -> {
            assertThat(o.rejectReason()).isEqualTo(ClaudeBookService.PAUSED_DURING_CALL);
            assertThat(o.expiresOn()).isNull();
        });
        assertThat(mine).filteredOn(o -> o.status().equals("REJECTED")).extracting(Order::ticker)
                .containsExactly("ZZZ");
        assertThat(hits.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("Claude를 부르는 사이에 초기화된 뒤 다시 시작했으면(출발일 같음) 결정·주문을 남기지 않고 400 — 초기화 전 장부로 만든 결정")
    void resetAndRestartDuringCallLeavesNothing() throws Exception {
        activeWithHolding();
        PaperAdminService admin = admin();
        duringCall = () -> {
            admin.reset(PaperBooks.CLAUDE, PaperBooks.CLAUDE);
            // 다시 시작 — 출발일은 설정값이라 같고, 초기 결정이 새 행으로 생깁니다.
            store.updateBookStatus(PaperBooks.CLAUDE, PaperBooks.ACTIVE);
            store.updateBookStartedOn(PaperBooks.CLAUDE, FRI);
            store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, FRI, "INITIAL", null, "NO_TRADE",
                    "claude-sonnet-5-5", null, 1, null, 0.0, null, null, null, null, null, null, null, true, 0L, 0));
        };
        answerJson(decision(60, null, order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION")));

        assertThatThrownBy(() -> service().decide(MON, RuleBookService.SCHEDULED, true))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("다시 시작");

        assertThat(store.decisionFor(PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED)).isEmpty();
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("응답을 받은 뒤(과금됨) 검증·저장이 예외로 끝나면 원문·사용량·오류를 다시 부르지 않는 API_ERROR 행(retryCount 1)으로 남긴다 — 다음 실행은 Claude를 부르지 않음")
    void failureAfterPaidResponseIsNotRetried() throws Exception {
        activeWithHolding();
        BookState state = store.states.remove(PaperBooks.CLAUDE);   // 잠금 안에서 장부를 읽다 실패(저장 단계 예외의 대역)
        answerJson(decision(15, null, order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION")));

        assertThatThrownBy(() -> service().decide(MON, RuleBookService.SCHEDULED, true))
                .isInstanceOf(IllegalStateException.class);

        Decision d = store.decisionFor(PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED).orElseThrow();
        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(d.retryCount()).isEqualTo(1);
        assertThat(ClaudeBookService.retryable(d)).isFalse();
        assertThat(d.responseRaw()).contains("\"schemaVersion\":2");
        assertThat(d.usage().path("inputTokens").asLong()).isEqualTo(21_000);
        assertThat(d.packetText()).isEqualTo(PACKET_TEXT);
        assertThat(d.error()).contains("응답을 받은 뒤", "paper_book_state");
        assertThat(d.response().path("failure").path("stage").asString()).isEqualTo("AFTER_RESPONSE");
        assertThat(d.response().path("measure").toString()).isEqualTo(MEASURE_JSON);
        assertThat(store.ordersOf(PaperBooks.CLAUDE)).isEmpty();
        assertThat(callsToday()).isEqualTo(1);

        store.states.put(PaperBooks.CLAUDE, state);
        assertThat(service().decide(MON, RuleBookService.SCHEDULED, true).id()).as("다시 부르지 않음").isEqualTo(d.id());
        assertThat(hits.get()).isEqualTo(1);

        // 재시도 차례였던 API 오류도 같은 행에서 끝냅니다(retryCount 1 — 세 번째 호출 없음).
        long id = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, "MANUAL", null, "API_ERROR",
                "claude-sonnet-5-5", null, 1, null, null, null, null, null, null, null, "[RATE_LIMIT] 429", null, true,
                5L, 0)).orElseThrow();
        store.states.remove(PaperBooks.CLAUDE);
        answerJson(decision(15, null, order("AAA", "BUY", 8.0, null, "NEXT_OBSERVATION")));
        assertThatThrownBy(() -> service().decide(MON, RuleBookService.MANUAL, true))
                .isInstanceOf(IllegalStateException.class);
        Decision retried = store.decision(id).orElseThrow();
        assertThat(retried.status()).isEqualTo(ClaudeBookService.STATUS_API_ERROR);
        assertThat(retried.retryCount()).isEqualTo(1);
        assertThat(retried.responseRaw()).contains("\"schemaVersion\":2");
        assertThat(retried.response().path("failure").path("retry").asBoolean()).isTrue();
        store.states.put(PaperBooks.CLAUDE, state);
        assertThat(service().decide(MON, RuleBookService.MANUAL, true).id()).isEqualTo(id);
        assertThat(hits.get()).isEqualTo(2);
    }

    // ------------------------------------------------------------------ 1주 미만 매도·초기 유니버스
    @Test
    @DisplayName("보유 수량 × sellFraction이 1주 미만인 부분 매도는 BELOW_ONE_SHARE로 거절(장부는 전량으로 집행) — 수량을 검증기에 넘긴다")
    void partialSellBelowOneShareIsRejected() throws Exception {
        activeWithHolding();   // HELD 50주
        ((tools.jackson.databind.node.ObjectNode) store.settings.body()).put("minHoldTradingDaysForSell", 0);
        answerJson(decision(4, null, order("HELD", "SELL", null, 0.01, "NEXT_OBSERVATION")));

        Decision d = service().decide(MON, RuleBookService.SCHEDULED, true);

        assertThat(d.status()).isEqualTo(ClaudeBookService.STATUS_NO_TRADE);
        assertThat(claudeOrders("PENDING")).isEmpty();
        assertThat(claudeOrders("REJECTED")).singleElement().satisfies(o -> {
            assertThat(o.rejectReason()).isEqualTo("BELOW_ONE_SHARE");
            assertThat(o.reason().path("validation").asString()).contains("보유 50주", "sellFraction 1");
        });
    }

    @Test
    @DisplayName("초기 결정의 유니버스는 출발일 종가를 얼리기 전에 정한다 — 유니버스 밖 종목은 종가 이력이 있어도 얼리지 않고 OUT_OF_UNIVERSE(미리보기·시작)")
    void initialUniverseIsFixedBeforeFreezingStartCloses() throws Exception {
        notStartedWithStartPrices();
        when(marketData.sourcedCloseOn(eq("GONE"), eq(FRI)))
                .thenReturn(Optional.of(new PaperMarketData.SourcedClose(40.0, "equity_close")));
        String body = decision(15, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("GONE", "BUY", 5.0, null, "NEXT_OBSERVATION"));

        answerJson(body);
        Map<String, Object> preview = service().preview();
        JsonNode validation = (JsonNode) preview.get("validation");
        assertThat(validation.get(0).path("accepted").asBoolean()).isTrue();
        assertThat(validation.get(1).path("rejectReason").asString()).isEqualTo("OUT_OF_UNIVERSE");
        assertThat(store.startPrices).as("유니버스 밖 종목은 얼리지 않음(다음 패킷의 유니버스가 넓어지지 않게)")
                .doesNotContainKey("GONE");

        answerJson(body);
        ClaudeBookService.StartResult result = service().start();
        assertThat(result.fills()).extracting(Fill::ticker).containsExactly("AAA");
        assertThat(claudeOrders("REJECTED")).singleElement().satisfies(o -> {
            assertThat(o.ticker()).isEqualTo("GONE");
            assertThat(o.rejectReason()).isEqualTo("OUT_OF_UNIVERSE");
        });
        assertThat(store.startPrices).doesNotContainKey("GONE");
    }

    @Test
    @DisplayName("초기 결정의 검증 유니버스는 패킷이 보인 12_hardRules.universe 그대로 — 관측치에 있어도 패킷 밖이면 OUT_OF_UNIVERSE")
    void initialUniverseFollowsPacket() throws Exception {
        notStartedWithStartPrices();
        when(packets.build(any(), anyString(), anyBoolean(), any(), any())).thenReturn(new PacketBuilder.Packet(
                MAPPER.readTree("{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\"},\"12_hardRules\":{\"universe\":\"AAA,SHY\"}}"),
                PACKET_TEXT, "hash-abc", List.of(), null));
        when(marketData.sourcedCloseOn(eq("XLK"), eq(FRI)))
                .thenReturn(Optional.of(new PaperMarketData.SourcedClose(200.0, "equity_close")));
        answerJson(decision(20, null, order("AAA", "BUY", 10.0, null, "NEXT_OBSERVATION"),
                order("XLK", "BUY", 10.0, null, "NEXT_OBSERVATION")));

        JsonNode validation = (JsonNode) service().preview().get("validation");

        assertThat(validation.get(0).path("accepted").asBoolean()).isTrue();
        assertThat(validation.get(1).path("rejectReason").asString()).isEqualTo("OUT_OF_UNIVERSE");
        assertThat(store.startPrices).doesNotContainKey("XLK");
    }

    @Test
    @DisplayName("가격 없음·입력 오래됨 판정(패킷과 함께 쓰는 계산): 이어 쓴 봉 + 봉 없는 보유, 저장본 없음·24시간 초과")
    void noPriceAndStaleInputHelpers() {
        Optional<PaperMarketData.Quotes> quotes = Optional.of(quotes(MON_FINAL, bar("AAA", FRI, 99, MON, 100),
                staleBar("OLD", FRI, 10, MON, 10)));
        assertThat(ClaudeBookService.noPriceTickers(quotes, List.of("AAA", "GONE")))
                .containsExactlyInAnyOrder("OLD", "GONE");
        assertThat(ClaudeBookService.noPriceTickers(Optional.empty(), List.of("AAA"))).containsExactly("AAA");
        assertThat(ClaudeBookService.inputsStale(Optional.empty(), NOW)).isTrue();
        assertThat(ClaudeBookService.inputsStale(quotes, NOW)).isFalse();
        assertThat(ClaudeBookService.inputsStale(quotes, MON_FINAL.plus(java.time.Duration.ofHours(25)))).isTrue();
    }
}
