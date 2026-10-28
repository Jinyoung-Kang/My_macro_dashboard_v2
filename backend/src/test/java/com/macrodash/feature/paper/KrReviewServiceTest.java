package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.ReviewFacts;
import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.ApiUsage;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Review;
import com.macrodash.store.StoreRepository;
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
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 한국 주간 복기({@link ReviewService}의 한국 문맥 — 2단계 명세 §4-7 '한국 주간 복기 프롬프트'·§4-9 '토 22:30'·§9 'E3', 사용자 결정 v5).
 * {@code ReviewServiceTest}의 한국판입니다: 실제 한국 실행({@link PaperMarkets#open} — 공휴일 저장본으로 만든 KrxCalendar·그 실행의 설정 행),
 * 실제 {@link PaperMarketData}(가짜 저장소 — 관측치 {@code paper.kr.quotes}·수정 종가 이력 {@code kr_close_adj}·금융위 주식시세), 가짜
 * Claude 서버(127.0.0.1 — 유료 호출 없음).
 *
 * <p>시각: 지금 = 토 2026-11-07 22:40 KST(복기 22:30 뒤). 복기 주 = 11-06(금), 4주 창 = (10-09, 11-06]. 금요일 값은 토스 잠정가(11-06 22:00 KST
 * 수집), 금융위 주식시세 최신 기준일 11-05(금요일 행은 다음 거래일 밤), 증권상품시세는 아직 받지 않음(ETF 확정 시세 없음).
 */
class KrReviewServiceTest {

    private static final LocalDate WE = LocalDate.of(2026, 11, 6);
    private static final LocalDate MON = LocalDate.of(2026, 11, 2);
    private static final LocalDate TUE = LocalDate.of(2026, 11, 3);
    private static final LocalDate WED = LocalDate.of(2026, 11, 4);
    private static final LocalDate THU = LocalDate.of(2026, 11, 5);
    private static final LocalDate STARTED = LocalDate.of(2026, 10, 30);
    private static final Instant NOW = kst("2026-11-07T22:40");
    private static final LocalDate TODAY_KST = LocalDate.of(2026, 11, 7);
    private static final String KEY = "sk-ant-test-KR-REVIEW";
    private static final String USAGE = "{\"input_tokens\":9500,\"output_tokens\":1300,"
            + "\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":5200}";

    private FakePaperStore store;
    private PaperSettingsService settings;
    private StoreReader reader;
    private StoreRepository repository;
    private PaperMarketData marketData;
    private Clock clock;
    private HttpServer server;
    private String baseUrl;
    private final Deque<String> answers = new ArrayDeque<>();
    private final AtomicInteger hits = new AtomicInteger();
    private final List<JsonNode> requests = new CopyOnWriteArrayList<>();
    /** 수정 종가 이력(kr_close_adj, 가짜) — 종목 → 날짜 → 종가. 기준일 점은 틀린 값(복기는 기준일 종가를 관측치에서 씀). */
    private final Map<String, TreeMap<LocalDate, Double>> history = new LinkedHashMap<>();
    /** 금융위 주식시세 행(가짜) — 종목 → 행. */
    private final Map<String, List<JsonNode>> fsc = new LinkedHashMap<>();

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() throws Exception {
        store = new FakePaperStore();
        store.dbNow = NOW;
        settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, STARTED, PaperBooks.ACTIVE,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, fridayQuotes());
        repository = mock(StoreRepository.class);
        when(repository.readTimeseriesColumns(eq(Datasets.TS_KR_CLOSE_ADJ), anyCollection(), any(), any()))
                .thenAnswer(invocation -> {
                    Collection<String> tickers = invocation.getArgument(1);
                    Map<String, StoreRepository.TimeseriesColumns> out = new LinkedHashMap<>();
                    for (String t : tickers) {
                        TreeMap<LocalDate, Double> points = history.get(t);
                        if (points != null) {
                            out.put(t, new StoreRepository.TimeseriesColumns(
                                    points.keySet().stream().mapToInt(d -> (int) d.toEpochDay()).toArray(),
                                    points.values().stream().mapToDouble(Double::doubleValue).toArray()));
                        }
                    }
                    return out;
                });
        when(repository.latestObservationDate(Datasets.OBS_FSC_PRICE)).thenReturn(THU);
        when(repository.readObservationSeries(eq(Datasets.OBS_FSC_PRICE), anyCollection(), any())).thenAnswer(invocation -> {
            Collection<String> codes = invocation.getArgument(1);
            Map<String, List<JsonNode>> out = new LinkedHashMap<>();
            codes.forEach(code -> out.put(code, fsc.getOrDefault(code, List.of())));
            return out;
        });
        clock = Clock.fixed(NOW, ZoneOffset.UTC);
        marketData = new PaperMarketData(reader, repository, clock);

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/messages", exchange -> {
            hits.incrementAndGet();
            requests.add(MAPPER.readTree(exchange.getRequestBody().readAllBytes()));
            String answer;
            synchronized (answers) {
                answer = answers.poll();
            }
            String body = answer == null ? "{\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"no answer\"}}"
                    : answer;
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(answer == null ? 500 : 200, bytes.length);
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
    private ReviewService service() {
        AiService ai = new AiService(240, 60, 180);
        ReflectionTestUtils.setField(ai, "anthropicKey", KEY);
        ReflectionTestUtils.setField(ai, "anthropicBaseUrl", baseUrl);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        FrameworkService framework = new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock);
        return new ReviewService(store, reader, marketData, framework, calls, ai, settings, MAPPER, 30, clock);
    }

    private MarketRun run() {
        return new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);
    }

    private void answerJson(String json) throws Exception {
        String body = "{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-5-5\","
                + "\"content\":[{\"type\":\"text\",\"text\":" + MAPPER.writeValueAsString(json) + "}],"
                + "\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"usage\":" + USAGE + "}";
        synchronized (answers) {
            answers.add(body);
        }
    }

    /**
     * 금요일 밤 관측치(11-06 22:00 KST 수집, 최근 봉 11-02~11-06). 005930 금요일 종가 55,000 · 000660 198,000 · 035720 일봉 시가 40,500
     * (통합가 — 08:00 프리마켓이 섞일 수 있음)·1분봉 09:01 봉 시가 40,000·종가 42,000 · 069500(KRX 단독) 시가 95,000·종가 95,950 · 207940
     * 11-03 봉의 시가 칸 없음(토스가 주지 않음)·금요일 종가 1,050,000.
     */
    private static com.macrodash.store.Snapshot fridayQuotes() {
        KrFixtures.Payload payload = new KrFixtures.Payload(WE);
        Instant fetched = kst("2026-11-06T21:58");
        payload.code("005930", fetched).bar(MON, 49_800, 50_000, 10_000).bar(TUE, 50_000, 50_500, 11_000)
                .bar(WED, 48_000, 47_500, 12_000).bar(THU, 51_000, 52_000, 13_000).bar(WE, 54_000, 55_000, 14_000);
        payload.code("000660", fetched).bar(TUE, 179_000, 182_000, 9_000).bar(WED, 183_000, 186_000, 9_000)
                .bar(THU, 187_000, 190_000, 9_000).bar(WE, 195_000, 198_000, 9_500);
        payload.code("035720", fetched).bar(THU, 39_000, 39_500, 20_000).bar(WE, 40_500, 42_000, 21_000)
                .minute("OK", "09:01", 40_000, 5_000);
        payload.etf("069500", fetched).bar(THU, 94_900, 95_000, 30_000).bar(WE, 95_000, 95_950, 31_000);
        payload.code("207940", fetched).bar(MON, 990_000, 995_000, 1_000).bar(TUE, null, 1_000_000, 1_100)
                .bar(WE, 1_040_000, 1_050_000, 1_200);
        return payload.snapshot(kst("2026-11-06T22:00"));
    }

    /** 금융위 주식시세 한 행(수집기 normalize 모양 — 시가 {@code open}은 {@code mkp}). */
    private static JsonNode fscRow(LocalDate date, double open, double close) {
        ObjectNode row = MAPPER.createObjectNode();
        row.put("obsDate", date.toString());
        row.put("open", open);
        row.put("close", close);
        row.put("volume", 1_000_000.0);
        row.put("listedShares", 728_002_365.0);
        row.put("market", "KOSPI");
        return row;
    }

    private void close(String ticker, Object... dateAndClose) {
        TreeMap<LocalDate, Double> map = history.computeIfAbsent(ticker, t -> new TreeMap<>());
        for (int i = 0; i < dateAndClose.length; i += 2) {
            map.put((LocalDate) dateAndClose[i], ((Number) dateAndClose[i + 1]).doubleValue());
        }
    }

    private long decision(LocalDate asOf, double target) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("stance", "NEUTRAL");
        response.put("summary", "한국 요약 " + asOf);
        response.put("exposureRationale", "노출 근거 " + asOf);
        response.put("noTradeReason", null);
        return store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, asOf, RuleBookService.SCHEDULED, null,
                ClaudeBookService.STATUS_OK, "claude-sonnet-5-5", 0, 1, null, target, null, null, null,
                MAPPER.valueToTree(response), null, null, null, false, null, 0)).orElseThrow();
    }

    private static JsonNode reason(String thesis, String invalidation, Double target, Double fraction) {
        Map<String, Object> proposed = new LinkedHashMap<>();
        proposed.put("targetWeightPct", target);
        proposed.put("sellFraction", fraction);
        proposed.put("timing", PaperBooks.NEXT_OPEN);
        Map<String, Object> reason = new LinkedHashMap<>();
        reason.put("thesis", thesis);
        reason.put("invalidation", invalidation);
        reason.put("proposed", proposed);
        return MAPPER.valueToTree(reason);
    }

    private long order(long decisionId, String ticker, String side, String status, String rejectReason, LocalDate asOf,
                       JsonNode reason) {
        boolean buy = PaperBooks.BUY.equals(side);
        return store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, decisionId, ticker, side, null, buy ? 8.0 : null,
                buy ? null : 0.5, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, status, rejectReason, reason, asOf,
                null, null, null));
    }

    private void nav(String book, LocalDate day, double nav, boolean pricesFinal) {
        store.upsertNav(new NavRow(book, day, nav, 0, nav, 0, pricesFinal));
    }

    /**
     * 손계산 장면(한국) —
     * <ul>
     *   <li>11-02(월) 결정: 005930 매수 체결(11-03 1분봉 시가 50,000 → 금요일 잠정 종가 55,000 = +10.00%, 그사이 종가 50,500 → 47,500 =
     *       최대 낙폭 −5.94%), 000660 매수 거절 UNFILLABLE(가정 진입 11-03 금융위 확정 시가 180,000 — 토스 시가 179,000이 아님 → 198,000 =
     *       +10.00%), 207940 매수 거절(11-03 금융위 행·토스 시가 없음 → 그 세션 종가 1,000,000으로 근사 → 1,050,000 = +5.00%, isProxy).</li>
     *   <li>11-05(목) 결정: 035720 매수 거절(가정 진입 11-06 — 금융위 금요일 행은 아직 없음 → 토스 1분봉 09:01 시가 40,000, 일봉 시가 40,500이
     *       아님 → 42,000 = +5.00%), 069500 매도 거절(증권상품시세 없음 → 토스 KRX 단독 일봉 시가 95,000 → 95,950 = +1.00%, missed).</li>
     *   <li>계좌 비교: 10-30(출발 — 창 시작 10-08에 줄 없음) → 11-06(잠정) — 규칙 +0.50%, KODEX 200 +2.00%, 60/40 +1.20%, Claude +1.00%,
     *       모두 isEstimated.</li>
     * </ul>
     */
    private long[] scene() {
        long first = decision(MON, 60.0);
        long bought = order(first, "005930", PaperBooks.BUY, PaperBooks.ORDER_FILLED, null, MON,
                reason("메모리 반도체 회복", "-8% 하락 시", 8.0, null));
        store.insertFill(new Fill(0, bought, PaperBooks.KR_CLAUDE, "005930", PaperBooks.BUY, 10, 50_000, 50_000, 0,
                500_000, kst("2026-11-03T21:58"), TUE, KrQuotes.SOURCE_1M_OPEN, false, null));
        order(first, "000660", PaperBooks.BUY, "REJECTED", "UNFILLABLE", MON, reason("HBM 수요", "스탑 발동 시", 8.0, null));
        order(first, "207940", PaperBooks.BUY, "REJECTED", "MONTHLY_CAP", MON, reason("바이오 수주", "200일선 이탈 시", 8.0, null));
        long second = decision(THU, 55.0);
        order(second, "035720", PaperBooks.BUY, "REJECTED", "MONTHLY_CAP", THU, reason("플랫폼 반등", "스탑 발동 시", 8.0, null));
        order(second, "069500", PaperBooks.SELL, "REJECTED", "MIN_HOLD", THU, reason("지수 비중 축소", "재돌파 시", null, 0.5));

        // 이력의 기준일 점(999 계열)은 틀린 값 — 기준일 종가는 금요일 밤 관측치(토스 잠정)에서만 씁니다.
        close("005930", TUE, 50_500, WED, 47_500, THU, 52_000, WE, 999_999);
        close("000660", TUE, 182_000, THU, 190_000, WE, 999_999);
        close("035720", THU, 39_500);
        close("069500", THU, 95_000);
        close("207940", MON, 995_000, TUE, 1_000_000);
        fsc.put("000660", List.of(fscRow(TUE, 180_000, 182_000), fscRow(THU, 188_000, 190_000)));
        fsc.put("035720", List.of(fscRow(THU, 39_100, 39_500)));

        nav(PaperBooks.KR_RULES, STARTED, 100_000_000, true);
        nav(PaperBooks.KR_RULES, WE, 100_500_000, false);
        nav(PaperBooks.KR_BENCH_K200, STARTED, 100_000_000, true);
        nav(PaperBooks.KR_BENCH_K200, WE, 102_000_000, false);
        nav(PaperBooks.KR_BENCH_MIX, STARTED, 100_000_000, true);
        nav(PaperBooks.KR_BENCH_MIX, WE, 101_200_000, false);
        nav(PaperBooks.KR_CLAUDE, STARTED, 100_000_000, true);
        nav(PaperBooks.KR_CLAUDE, WE, 101_000_000, false);
        return new long[]{first, second};
    }

    private static String reviewJson(long first, long second) {
        return "{\"schemaVersion\":1,\"weekEnding\":\"2026-11-06\",\"verdicts\":["
                + "{\"decisionId\":" + first + ",\"thesisHeld\":\"유지\",\"note\":\"체결 뒤 +10%, 거절된 000660도 +10%\"},"
                + "{\"decisionId\":" + second + ",\"thesisHeld\":\"판단불가\",\"note\":\"하루 경과\"}],"
                + "\"recurringErrors\":[\"월 상한 근처 신규 진입\"],\"keep\":[\"체결할 수 없는 종목은 사지 않기\"],"
                + "\"proposal\":null}";
    }

    private static List<JsonNode> orders(JsonNode input, int decision) {
        List<JsonNode> out = new ArrayList<>();
        input.path("decisions").get(decision).path("orders").forEach(out::add);
        return out;
    }

    // ------------------------------------------------------------------ 시험
    @Test
    @DisplayName("한국 복기 입력이 손계산과 같다 — 기준일 종가는 금요일 토스 잠정 종가(이력의 기준일 점은 버림), 거절 주문의 가정 진입은 다음 세션 시가(금융위 확정 → 토스 1분봉 → 토스 일봉), 시가가 없으면 종가 근사(isProxy), 계좌 비교는 한국 네 계좌(잠정 — isEstimated), 설명은 한국 판(사용자 결정 v5)")
    void krInputMatchesHandComputation() throws Exception {
        long[] ids = scene();
        answerJson(reviewJson(ids[0], ids[1]));

        ReviewService.Outcome outcome = service().review(run(), WE);

        assertThat(outcome.kind()).isEqualTo(ReviewService.Kind.CALLED);
        Review review = store.otherReviews.get(Book.MARKET_KR).get(WE);
        assertThat(review.status()).isEqualTo(Review.OK);
        JsonNode input = review.input();
        assertThat(input.path("note").asString()).isEqualTo(ReviewFacts.NEXT_OPEN_NOTE);
        assertThat(input.path("window").path("after").asString()).isEqualTo("2026-10-09");

        List<JsonNode> monday = orders(input, 0);
        assertThat(monday).extracting(o -> o.path("ticker").asString()).containsExactly("005930", "000660", "207940");
        JsonNode samsung = monday.get(0);
        assertThat(samsung.path("timing").asString()).isEqualTo("NEXT_OPEN");
        assertThat(samsung.path("fill").path("date").asString()).isEqualTo("2026-11-03");
        assertThat(samsung.path("fill").path("price").asDouble()).isEqualTo(50_000.0);
        assertThat(samsung.path("weekEndingClose").asDouble()).as("이력의 999,999가 아니라 금요일 토스 잠정 종가").isEqualTo(55_000.0);
        assertThat(samsung.path("returnSinceFillPct").asDouble()).as("55,000 ÷ 50,000 − 1").isEqualTo(10.0);
        assertThat(samsung.path("maxDrawdownPct").asDouble()).as("47,500 ÷ 50,500 − 1").isEqualTo(-5.94);
        assertThat(samsung.has("hypothetical")).isFalse();

        JsonNode hynix = monday.get(1).path("hypothetical");
        assertThat(monday.get(1).path("rejectReason").asString()).isEqualTo("UNFILLABLE");
        assertThat(hynix.path("entryDate").asString()).isEqualTo("2026-11-03");
        assertThat(hynix.path("entryPrice").asDouble()).as("금융위 확정 시가(토스 179,000이 아님)").isEqualTo(180_000.0);
        assertThat(hynix.path("entrySource").asString()).isEqualTo(KrConfirmed.SOURCE_FSC);
        assertThat(hynix.path("isProxy").asBoolean(true)).isFalse();
        assertThat(hynix.path("returnPct").asDouble()).as("198,000 ÷ 180,000 − 1").isEqualTo(10.0);
        assertThat(hynix.has("entryClose")).as("미국 칸 이름이 아님").isFalse();

        JsonNode bio = monday.get(2).path("hypothetical");
        assertThat(bio.path("entryPrice").asDouble()).as("시가 없음 → 그 세션 종가로 근사").isEqualTo(1_000_000.0);
        assertThat(bio.path("isProxy").asBoolean()).isTrue();
        assertThat(bio.path("entrySource").isNull()).isTrue();
        assertThat(bio.path("returnPct").asDouble()).as("1,050,000 ÷ 1,000,000 − 1").isEqualTo(5.0);
        assertThat(monday.get(2).path("notes").toString()).contains("시가 없음 — 그 세션 종가로 근사(isProxy)");

        List<JsonNode> thursday = orders(input, 1);
        JsonNode kakao = thursday.get(0).path("hypothetical");
        assertThat(kakao.path("entryDate").asString()).isEqualTo("2026-11-06");
        assertThat(kakao.path("entryPrice").asDouble()).as("금융위 금요일 행 전 — 토스 1분봉 09:01 시가(일봉 40,500이 아님)")
                .isEqualTo(40_000.0);
        assertThat(kakao.path("entrySource").asString()).isEqualTo(KrQuotes.SOURCE_1M_OPEN);
        assertThat(kakao.path("returnPct").asDouble()).as("42,000 ÷ 40,000 − 1").isEqualTo(5.0);
        JsonNode kodex = thursday.get(1).path("hypothetical");
        assertThat(thursday.get(1).path("side").asString()).isEqualTo("SELL");
        assertThat(kodex.path("entryPrice").asDouble()).as("증권상품시세 없음 — 토스 KRX 단독 일봉 시가").isEqualTo(95_000.0);
        assertThat(kodex.path("entrySource").asString()).isEqualTo(KrQuotes.SOURCE_DAILY);
        assertThat(kodex.path("returnPct").asDouble()).as("95,950 ÷ 95,000 − 1").isEqualTo(1.0);
        assertThat(kodex.path("afterSellLabel").asString()).isEqualTo(ReviewFacts.MISSED);

        JsonNode comparison = input.path("comparison");
        assertThat(comparison.path("from").asString()).isEqualTo("2026-10-30");
        assertThat(comparison.path("to").asString()).isEqualTo("2026-11-06");
        assertThat(comparison.path("note").asString()).as("창 시작 10-09(한글날)는 그 실행 달력의 직전 거래일 10-08")
                .contains("창 시작(2026-10-08)");
        JsonNode books = comparison.path("books");
        assertThat(books).extracting(b -> b.path("book").asString())
                .containsExactly(PaperBooks.KR_RULES, PaperBooks.KR_BENCH_K200, PaperBooks.KR_BENCH_MIX, PaperBooks.KR_CLAUDE);
        assertThat(books).extracting(b -> b.path("returnPct").asDouble()).containsExactly(0.5, 2.0, 1.2, 1.0);
        assertThat(books).allSatisfy(b -> assertThat(b.path("isEstimated").asBoolean()).as("금요일 줄은 잠정").isTrue());
        assertThat(callsToday()).isEqualTo(1);
    }

    @Test
    @DisplayName("고정본: 한국 주간 복기 요청 — 시스템 프롬프트는 REVIEW + 한국 렌더링(review-system-kr.txt, E2a 고정본 그대로), 사용자 메시지(한국 복기 입력)·모델 인자가 바이트까지 같다")
    void goldenKrReviewRequest() throws Exception {
        long[] ids = scene();
        answerJson(reviewJson(ids[0], ids[1]));

        assertThat(service().review(run(), WE).kind()).isEqualTo(ReviewService.Kind.CALLED);

        assertThat(requests).hasSize(1);
        Golden.assertClaudeRequest(requests.get(0), "review-system-kr.txt", "review-user-kr.txt",
                "review-request-kr.json");
        String system = requests.get(0).path("system").get(0).path("text").asString();
        assertThat(system).isEqualTo(ReviewService.systemPrompt(KrPaperMarket.INSTANCE, FrameworkService.interimBody(MAPPER),
                0, settings.defaultsJson()));
        assertThat(system).contains("현금성(153130)").contains(ClaudePrompts.KR_FIXED_RULES.split("\n", 2)[0])
                .doesNotContain("주문 최소 $");
    }

    @Test
    @DisplayName("한국 복기 행은 (market, week_ending) 기본키(B1) — 같은 주의 미국 행과 부딪치지 않고 덮지도 않으며, 같은 주 두 번째 실행은 부르지 않음")
    void krRowIsKeyedByMarketAndWeek() throws Exception {
        long[] ids = scene();
        Review us = new Review(WE, 4, MAPPER.createObjectNode(), null, null, null, null, null, Review.OK, null, null, 0, 0,
                NOW.minusSeconds(43_200));
        store.reviews.put(WE, us);
        answerJson(reviewJson(ids[0], ids[1]));
        ReviewService service = service();

        assertThat(service.review(run(), WE).kind()).as("같은 주 미국 행이 있어도 한국은 새로 복기")
                .isEqualTo(ReviewService.Kind.CALLED);
        ReviewService.Outcome again = service.review(run(), WE);

        assertThat(again.kind()).isEqualTo(ReviewService.Kind.EXISTING);
        assertThat(again.review().market()).isEqualTo(Book.MARKET_KR);
        assertThat(store.otherReviews.get(Book.MARKET_KR)).containsOnlyKeys(WE);
        assertThat(store.reviews).containsOnlyKeys(WE);
        assertThat(store.reviews.get(WE)).as("미국 행 그대로").isSameAs(us);
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("복기 작업(토 22:30 KST) → 실제 복기 서비스: 그 실행의 한국 문맥으로 금요일 잠정 줄 복기, 작업 기록 kr.review·정기 문턱, 같은 주 다시 돌면 ALREADY_REVIEWED")
    void scheduledKrReviewEndToEnd() throws Exception {
        long[] ids = scene();
        answerJson(reviewJson(ids[0], ids[1]));
        store.apiUsage.put(TODAY_KST, new ApiUsage(TODAY_KST, 13, 0, 0, 0, 0));   // 수동 문턱 13 — 정기 복기는 상한까지
        PaperConfig config = new PaperConfig(true, PaperFixtures.FRI, 100_000, LocalDate.of(2026, 10, 29),
                PaperConfig.DEFAULT_KR_INITIAL_CASH);
        PaperReviewJob job = new PaperReviewJob(store, reader, marketData, service(), config, MAPPER, clock,
                List.of(KrPaperMarket.INSTANCE));

        PaperReviewJob.Result result = job.run(KrPaperMarket.INSTANCE);

        assertThat(result.outcome()).isEqualTo(PaperReviewJob.REVIEWED);
        assertThat(result.review().market()).isEqualTo(Book.MARKET_KR);
        assertThat(result.review().input().path("note").asString()).isEqualTo(ReviewFacts.NEXT_OPEN_NOTE);
        assertThat(store.jobRuns).singleElement().satisfies(r -> {
            assertThat(r.job()).isEqualTo("kr.review");
            assertThat(r.detail().path("status").asString()).isEqualTo(Review.OK);
            assertThat(r.detail().path("manual").asBoolean(true)).isFalse();
        });
        assertThat(callsToday()).isEqualTo(14);
        assertThat(job.run(KrPaperMarket.INSTANCE).outcome()).isEqualTo(PaperReviewJob.ALREADY_REVIEWED);
        assertThat(hits.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("복기 프롬프트의 설정은 그 실행이 읽은 판(달력·장부 설정과 같은 판, E3) — 실행을 연 뒤 저장한 kr.maxPositions는 그 복기의 한국 하드 규칙 줄에 들지 않고, 다음 실행부터 들어감")
    void promptUsesTheRunsSettingsVersion() throws Exception {
        long[] ids = scene();
        answerJson(reviewJson(ids[0], ids[1]));
        answerJson(reviewJson(ids[0], ids[1]));
        MarketRun opened = run();
        ObjectNode body = (ObjectNode) settings.defaultsJson().deepCopy();
        ((ObjectNode) body.get("kr")).put("maxPositions", 17);
        store.saveSettings(body, List.of("kr.maxPositions"));
        ReviewService service = service();

        service.review(opened, WE);

        String first = requests.get(0).path("system").get(0).path("text").asString();
        assertThat(first).as("실행을 연 판(기본값)").isEqualTo(ReviewService.systemPrompt(KrPaperMarket.INSTANCE,
                FrameworkService.interimBody(MAPPER), 0, settings.defaultsJson())).contains("최대 20종목(현금성 제외)");

        store.otherReviews.clear();
        service.review(run(), WE);
        String second = requests.get(1).path("system").get(0).path("text").asString();
        assertThat(second).as("새 실행은 새 판").contains("최대 17종목(현금성 제외)").doesNotContain("최대 20종목");
    }

    private int callsToday() {
        return store.apiUsage(TODAY_KST).map(ApiUsage::calls).orElse(0);
    }
}
