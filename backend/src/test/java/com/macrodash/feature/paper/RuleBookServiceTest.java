package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository.HoldingRow;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;
import static org.assertj.core.api.Assertions.within;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 규칙 책 — 재선정일에만 매수, 그 외 날은 매도 신호와 남는 현금 관리(SHY, 기준 rules.parkCashThresholdPct)만, 매도 신호의 기관 수,
 * 이미 보유한 후보의 부족분, SHY 남는 현금·모자란 현금, 최소 주문 금액(minOrderNotional), 멱등, 시작(수집 중 거절·종목마다
 * 기관·그룹·순위·가중 근거·사후 체결), 선정 기준일 뒤 공시를 쓰지 않음, 두 그룹 섞기(D27 — 점수·확신도 비례 배분·동일 비중·q8 출처·
 * 섞기 전 선정).
 *
 * <p>기본 선정은 그룹 A 셋(A1·A2·A3, 그룹 B 없음 → 기관 가중 3/6·2/6·1/6). 저장본의 분기(보고일, 공시일): Q1(2026-03-31, 05-15) ·
 * Q2(06-30, 08-14) · Q3(09-30, 11-13). 출발일(2026-10-23) 선정은 Q2까지만 보므로 신호는 Q2 대 Q1입니다.
 * <ul>
 *   <li>CCC: A1 신규(비중 20.8%)·A2 신규(50%) → 점수 0.5 + 0.3333 = 0.8333(확신도 둘 다 1)</li>
 *   <li>BBB: A1 +40%(58.3%)·A3 신규(50%) → 점수 0.5 + 0.1667 = 0.6667 — 확신도 비례면 목표 10% × 0.6667/0.8333 = 8%</li>
 *   <li>OLD·GONE: A1·A2 전량 매도(2곳) · ONE: A3만 전량 매도(1곳)</li>
 * </ul>
 */
class RuleBookServiceTest {

    private static final String F1 = "0000000001";
    private static final String F2 = "0000000002";
    private static final String F3 = "0000000003";
    private static final String F4 = "0000000004";
    /** 2026-06-30 분기의 재선정일(공시 기한 08-14 금 → 다음 거래일). */
    private static final LocalDate Q2_RESELECTION = LocalDate.of(2026, 8, 17);
    /** 출발일 다음 날 낮 — 출발일 마감 15분 뒤가 지남. */
    private static final Clock NOW = Clock.fixed(Instant.parse("2026-10-24T03:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private Map<String, List<HoldingRow>> holdings;
    private Map<String, Snapshot> snapshots;
    private RuleBookService rules;

    private record Line(String ticker, double shares, double value) {
    }

    private record Quarter(String report, String filed, List<Line> lines) {
    }

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        store = new FakePaperStore();
        holdings = new HashMap<>();
        snapshots = new HashMap<>();
        reader = mock(StoreReader.class);
        when(reader.quietly(any())).thenAnswer(invocation -> ((Supplier<Object>) invocation.getArgument(0)).get());
        when(reader.readStoredHoldings(anyString())).thenAnswer(invocation ->
                holdings.getOrDefault((String) invocation.getArgument(0), List.of()));
        when(reader.read(anyString(), anyLong(), any())).thenAnswer(invocation ->
                Optional.ofNullable(snapshots.get((String) invocation.getArgument(0))));
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.quotes()).thenReturn(Optional.of(quotes(MON_FINAL, bar("AAA", MON, 100),
                bar("BBB", MON, 50), bar("CCC", MON, 100), bar("DDD", MON, 10), bar("EEE", MON, 20),
                bar("OLD", MON, 100), bar("ONE", MON, 100), bar("GONE", MON, 30), bar("SHY", MON, 80))));

        // 설정: 기본값 + 후보 목록 제한 없음(테스트 CIK가 실제 27곳 목록에 없으므로).
        ObjectNode body = (ObjectNode) PaperFixtures.settings(store).defaultsJson();
        ((ObjectNode) body.get("trackRecord")).putNull("candidateCiks");
        store.settings = new SettingsRow(1, body, store.dbNow);
        store.settingsHistory.put(1, store.settings);

        PaperSettingsService settings = PaperFixtures.settings(store);
        PaperSelectionService selection = new PaperSelectionService(store, reader, marketData, settings, MAPPER, NOW);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, MAPPER);
        PaperAdminService admin = new PaperAdminService(store, marketData, reader, settings, ledger,
                PaperFixtures.config(), MAPPER, NOW);
        rules = new RuleBookService(store, reader, marketData, selection, settings, ledger, admin,
                PaperFixtures.config(), MAPPER, NOW);
        standardFilings(false);
    }

    // ------------------------------------------------------------------ 재료
    private static Line line(String ticker, double shares, double value) {
        return new Line(ticker, shares, value);
    }

    private static Quarter quarter(String report, String filed, Line... lines) {
        return new Quarter(report, filed, List.of(lines));
    }

    /** 저장본처럼 최근 분기를 앞에. 티커 null = 티커를 붙이지 못한 줄. */
    private void q30(String cik, Quarter... quarters) {
        List<HoldingRow> rows = new ArrayList<>();
        for (int i = 0; i < quarters.length; i++) {
            Quarter q = quarters[i];
            for (Line l : q.lines()) {
                rows.add(new HoldingRow(i, q.filed(), q.report(), cik, "CUSIP" + l.ticker(), l.ticker(), l.value(),
                        l.shares()));
            }
        }
        holdings.put(Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS), rows);
    }

    /** 클래스 설명의 Q1·Q2. extras면 시작 시험용 후보 둘을 더함(EEE: 출발일 종가 없음, XXX: 유니버스 밖). */
    private void standardFilings(boolean extras) {
        List<Line> f1q2 = new ArrayList<>(List.of(line("BBB", 1400, 140_000), line("CCC", 500, 50_000),
                line(null, 0, 50_000)));
        List<Line> f3q2 = new ArrayList<>(List.of(line("AAA", 50, 5_000), line("BBB", 50, 5_000)));
        List<Line> f2q2 = new ArrayList<>(List.of(line("AAA", 100, 10_000), line("CCC", 100, 10_000)));
        if (extras) {
            f1q2.add(line("EEE", 10, 1_000));
            f3q2.add(line("EEE", 10, 200));
            f2q2.add(line("XXX", 10, 1_000));
            f3q2.add(line("XXX", 10, 100));
        }
        q30(F1, new Quarter("2026-06-30", "2026-08-14", f1q2),
                quarter("2026-03-31", "2026-05-15", line("OLD", 100, 10_000), line("GONE", 100, 10_000),
                        line("BBB", 1000, 100_000), line(null, 0, 50_000)));
        q30(F2, new Quarter("2026-06-30", "2026-08-14", f2q2),
                quarter("2026-03-31", "2026-05-15", line("OLD", 100, 10_000), line("GONE", 100, 10_000),
                        line("AAA", 100, 10_000)));
        q30(F3, new Quarter("2026-06-30", "2026-08-14", f3q2),
                quarter("2026-03-31", "2026-05-15", line("ONE", 100, 10_000), line("AAA", 50, 5_000)));
    }

    /** 기본 선정 — 그룹 A만 셋(A1·A2·A3, 이름 "기관 A·B·C"), 그룹 B 없음. */
    private void selection(LocalDate asOf) {
        selection(asOf, List.of(F1, F2, F3), List.of(), 0.5);
    }

    private static String nameOf(String cik) {
        return "기관 " + (char) ('A' + Integer.parseInt(cik) - 1);
    }

    /**
     * D27 선정 행 — PaperSelectionService.draftSelection과 같은 모양: groupA·groupB(선정만), pool(가중 = blendWeights), g.
     * 그룹 B에도 있는 기관은 둘 다 받습니다.
     */
    private void selection(LocalDate asOf, List<String> groupA, List<String> groupB, double g) {
        Map<String, Double> weights = com.macrodash.analytics.Signal13F.blendWeights(groupA, groupB, g);
        ObjectNode ranking = MAPPER.createObjectNode();
        ArrayNode a = ranking.putArray("groupA");
        for (int i = 0; i < groupA.size(); i++) {
            a.addObject().put("cik", groupA.get(i)).put("name", nameOf(groupA.get(i))).put("rank", i + 1)
                    .put("selected", true);
        }
        ArrayNode b = ranking.putArray("groupB");
        for (int i = 0; i < groupB.size(); i++) {
            b.addObject().put("cik", groupB.get(i)).put("name", nameOf(groupB.get(i))).put("rank", i + 1)
                    .put("selected", true);
        }
        ArrayNode pool = ranking.putArray("pool");
        weights.forEach((cik, weight) -> {
            ObjectNode member = pool.addObject().put("cik", cik).put("name", nameOf(cik));
            ArrayNode groups = member.putArray("groups");
            if (groupA.contains(cik)) {
                groups.add("A");
            }
            if (groupB.contains(cik)) {
                groups.add("B");
            }
            if (groupA.contains(cik)) {
                member.put("rankA", groupA.indexOf(cik) + 1);
            } else {
                member.putNull("rankA");
            }
            if (groupB.contains(cik)) {
                member.put("rankB", groupB.indexOf(cik) + 1);
            } else {
                member.putNull("rankB");
            }
            member.put("weight", weight);
        });
        ranking.put("groupWeightA", g);
        store.selections.put(asOf, new Selection(asOf, List.copyOf(weights.keySet()), ranking, 1, store.dbNow));
    }

    /** 섞기(D27) 전 모양의 선정 — 순위표 배열(순위 1·2·3), 선정 = 그룹 A. */
    private void legacySelection(LocalDate asOf) {
        ArrayNode ranking = MAPPER.createArrayNode();
        List<String> ciks = List.of(F1, F2, F3);
        for (int i = 0; i < ciks.size(); i++) {
            ranking.addObject().put("cik", ciks.get(i)).put("name", nameOf(ciks.get(i))).put("rank", i + 1);
        }
        store.selections.put(asOf, new Selection(asOf, ciks, ranking, 1, store.dbNow));
    }

    /** 설정 blend 한 키를 바꿉니다(배분 방식 등). */
    private void blend(String key, String value) {
        ObjectNode blend = (ObjectNode) store.settings.body().get("blend");
        blend.put(key, value);
    }

    /** 매일 남는 현금 SHY의 기준(rules.parkCashThresholdPct)을 바꿉니다. */
    private void parkThreshold(double pct) {
        ((ObjectNode) store.settings.body().get("rules")).put("parkCashThresholdPct", pct);
    }

    /**
     * 남는 현금을 SHY에 두지 않음(parkCashInShy=false) — 매도 신호·선정만 보는 시험에서 현금이 많은 장부가 매일 SHY 주문을 더해
     * 주문 목록이 흐려지지 않게. 남는 현금 SHY는 아래 '매일 남는 현금' 시험들이 따로 봅니다.
     */
    private void noParking() {
        ((ObjectNode) store.settings.body()).put("parkCashInShy", false);
    }

    /** 운용 중인 규칙 책 — 현금과 보유(티커·수량·가격 반복). 순자산 = 현금 + Σ 수량 × 가격. */
    private void activeRules(String status, double cash, Object... tickerQtyPrice) {
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, FRI,
                status, FRI_CLOSE));
        store.states.put(PaperBooks.RULES, new BookState(PaperBooks.RULES, cash, cash, 0, 0, MON_FINAL, MON_FINAL,
                null, null));
        for (int i = 0; i < tickerQtyPrice.length; i += 3) {
            double price = ((Number) tickerQtyPrice[i + 2]).doubleValue();
            store.upsertPosition(new Position(PaperBooks.RULES, (String) tickerQtyPrice[i],
                    (Integer) tickerQtyPrice[i + 1], price, FRI, FRI_CLOSE, price, FRI_CLOSE, price, FRI_CLOSE, false,
                    FRI, price, null));
        }
    }

    /** 시작 전 규칙 책(현금 100,000). */
    private void notStartedRules() {
        store.books.put(PaperBooks.RULES, new Book(PaperBooks.RULES, PaperBooks.KIND_RULES, "규칙 책", 100_000, null,
                PaperBooks.NOT_STARTED, FRI_CLOSE));
        store.states.put(PaperBooks.RULES, new BookState(PaperBooks.RULES, 100_000, 100_000, 0, 0, null, null, null,
                null));
    }

    private void index(boolean... complete) {
        List<Map<String, Object>> filers = new ArrayList<>();
        List<String> ciks = List.of(F1, F2, F3, F4);
        for (int i = 0; i < complete.length; i++) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("cik", ciks.get(i));
            f.put("name", "기관 " + (char) ('A' + i));
            f.put("storedQuarters", complete[i] ? 30 : 12);
            f.put("complete", complete[i]);
            filers.add(f);
        }
        snapshots.put(Datasets.SNAP_TRACK_RECORD_INDEX, new Snapshot(Datasets.SNAP_TRACK_RECORD_INDEX,
                MAPPER.valueToTree(Map.of("filers", filers, "targetQuarters", 30)), "json", "ok", null,
                Instant.parse("2026-10-24T01:00:00Z")));
    }

    private void frozen(String ticker, double close) {
        store.startPrices.put(ticker, new StartPrice(ticker, FRI, close, "equity_close", store.dbNow));
    }

    private List<Order> orders() {
        return store.ordersOf(PaperBooks.RULES);
    }

    private static List<String> skippedReasons(Decision decision, String ticker) {
        List<String> out = new ArrayList<>();
        for (JsonNode skip : decision.response().path("skipped")) {
            if (ticker.equals(skip.path("ticker").asString())) {
                out.add(skip.path("reason").asString());
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 하루 결정
    @Test
    @DisplayName("재선정일이 아닌 날은 매도 신호만 — 매수 후보가 있어도 사지 않고, SHY는 남는 현금 관리(매도 대금 포함)로만 산다")
    void nonReselectionDayOnlySells() {
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 51_000, "OLD", 100, 100, "ONE", 100, 100, "CCC", 50, 100, "SHY", 300, 80);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        // 남는 현금: 51,000 + OLD 매도 9,995 = 60,995(60.995%) > 기준 2% → SHY 60.495%(여유 0.5%p) — 신호 매수(CCC·BBB)는 없음
        assertThat(orders()).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                tuple("OLD", "SELL", null), tuple("SHY", "BUY", 60.495));
        assertThat(orders().get(1).reason().path("rule").asString()).isEqualTo("park_cash");
        assertThat(orders().get(1).reason().path("targetWeightPct").asDouble()).as("지금 24% + 60.495%")
                .isEqualTo(84.495);
        Order sell = orders().get(0);
        assertThat(sell.status()).isEqualTo("PENDING");
        assertThat(sell.source()).isEqualTo("RULE");
        assertThat(sell.timing()).isEqualTo("NEXT_OBSERVATION");
        assertThat(sell.sellFraction()).as("전량").isNull();
        assertThat(sell.asOfTradingDate()).isEqualTo(MON);
        assertThat(sell.expiresOn()).as("기준 거래일 + 3거래일").isEqualTo(LocalDate.of(2026, 10, 29));
        assertThat(sell.decisionId()).isEqualTo(decision.id());
        assertThat(sell.reason().path("text").asString()).isEqualTo(
                "2곳 전량 매도: A1 기관 A(0000000001), A2 기관 B(0000000002)");
        assertThat(sell.reason().path("closers").get(1).path("rankA").asInt()).isEqualTo(2);
        assertThat(sell.reason().path("closers").get(1).path("groups").toString()).isEqualTo("[\"A\"]");

        assertThat(decision.kind()).isEqualTo("SCHEDULED");
        assertThat(decision.status()).isEqualTo("OK");
        assertThat(decision.selectionAsOf()).isEqualTo(FRI);
        assertThat(decision.settingsVersion()).isEqualTo(1);
        JsonNode response = decision.response();
        assertThat(response.path("summary").asString()).startsWith("매도 1 · SHY 매수(남는 현금) (선정 2026-10-23 · 3곳)");
        assertThat(response.path("signals").path("candidates")).extracting(c -> c.path("ticker").asString())
                .containsExactly("CCC", "BBB");
        assertThat(response.path("notes").toString()).contains("재선정일이 아니라 사지 않습니다");
        assertThat(response.path("selection").path("filers").get(0).path("reportDate").asString())
                .isEqualTo("2026-06-30");
    }

    @Test
    @DisplayName("매도 신호는 보유 종목을 선정 기관 minHolders곳 이상이 전량 매도했을 때만 — 1곳(ONE)·보유 없는 종목(GONE)은 주문 없음")
    void sellSignalNeedsMinHoldersAmongHeld() {
        noParking();
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 80_000, "OLD", 100, 100, "ONE", 100, 100);

        rules.decide(MON, RuleBookService.SCHEDULED);
        assertThat(orders()).extracting(Order::ticker).containsExactly("OLD");
        assertThat(store.decisionsOf(PaperBooks.RULES).get(0).response().path("signals").path("closedBy")
                .path("GONE").size()).as("closedBy에는 보유와 상관없이 다 남음").isEqualTo(2);

        // 기관 1곳으로 낮추면 ONE도 매도 신호(다른 날의 결정)
        ((ObjectNode) store.settings.body()).put("minHolders", 1);
        rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED);
        assertThat(orders()).extracting(Order::ticker).containsExactly("OLD", "ONE");
        assertThat(orders().get(1).reason().path("text").asString()).isEqualTo("1곳 전량 매도: A3 기관 C(0000000003)");
    }

    @Test
    @DisplayName("재선정일에는 점수 순 후보를 확신도 비례로 산다(최고 점수 = 상한 10%, BBB 8%) — 이미 들고 있는 후보는 부족분만, 남는 현금은 SHY(여유 0.5%p)")
    void reselectionDayBuysTopsUpAndParksShy() {
        selection(Q2_RESELECTION);
        // 순자산 100,000: 현금 51,000 · OLD 10% · ONE 10% · CCC 5% · SHY 24%
        activeRules(PaperBooks.ACTIVE, 51_000, "OLD", 100, 100, "ONE", 100, 100, "CCC", 50, 100, "SHY", 300, 80);

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        // 목표: CCC 10%(최고 점수) · BBB 10% × 0.6667/0.8333 = 8%. 현금 어림: 51,000 + OLD 매도 9,995 − CCC 5,002.5
        // − BBB 8,004 = 47,988.5 → 남는 현금 47.9885% − 0.5 = 47.4885%
        assertThat(orders()).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                tuple("OLD", "SELL", null), tuple("CCC", "BUY", 5.0), tuple("BBB", "BUY", 8.0),
                tuple("SHY", "BUY", 47.4885));
        Order ccc = orders().get(1);
        assertThat(ccc.reason().path("currentWeightPct").asDouble()).isEqualTo(5.0);
        assertThat(ccc.reason().path("targetWeightPct").asDouble()).isEqualTo(10.0);
        assertThat(ccc.reason().path("text").asString()).isEqualTo("2곳 동시 매수(점수 0.8333): "
                + "A1 기관 A(0000000001) 신규(가중 0.5000 × 확신도 1.00), A2 기관 B(0000000002) 신규(가중 0.3333 × 확신도 1.00)");
        assertThat(ccc.reason().path("rankInPlan").asInt()).isEqualTo(1);
        assertThat(ccc.reason().path("allocation").asString()).isEqualTo("CONVICTION");
        Order bbb = orders().get(2);
        assertThat(bbb.reason().path("targetWeightPct").asDouble()).as("상한 × 점수 / 최고 점수").isEqualTo(8.0);
        assertThat(bbb.reason().path("score").asDouble()).isCloseTo(2.0 / 3, within(1e-6));
        assertThat(bbb.reason().path("rankInPlan").asInt()).isEqualTo(2);
        Order shy = orders().get(3);
        assertThat(shy.reason().path("parking").asBoolean()).isTrue();
        assertThat(shy.reason().path("targetWeightPct").asDouble()).as("지금 24% + 47.4885%").isEqualTo(71.4885);
        assertThat(decision.kind()).isEqualTo("REBALANCE");
        assertThat(decision.response().path("summary").asString()).startsWith("매도 1 · 매수 2 · SHY 매수(남는 현금)");
        assertThat(decision.response().path("settings").path("allocation").asString()).isEqualTo("CONVICTION");
        assertThat(decision.response().path("settings").path("convictionCapPct").asDouble()).isEqualTo(10.0);
    }

    @Test
    @DisplayName("blend.allocation = EQUAL이면 예전 동일 비중 — 상위 후보 모두 min(100/N, 상한) = 10%, 점수는 순서에만")
    void equalAllocationMode() {
        blend("allocation", "EQUAL");
        selection(Q2_RESELECTION);
        activeRules(PaperBooks.ACTIVE, 51_000, "OLD", 100, 100, "ONE", 100, 100, "CCC", 50, 100, "SHY", 300, 80);

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        // 현금 어림: 51,000 + 9,995 − 5,002.5 − 10,005 = 45,987.5 → SHY 45.4875%
        assertThat(orders()).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                tuple("OLD", "SELL", null), tuple("CCC", "BUY", 5.0), tuple("BBB", "BUY", 10.0),
                tuple("SHY", "BUY", 45.4875));
        assertThat(orders().get(2).reason().path("allocation").asString()).isEqualTo("EQUAL");
        assertThat(decision.response().path("settings").path("allocation").asString()).isEqualTo("EQUAL");
    }

    @Test
    @DisplayName("확신도 비례 목표가 blend.minTargetPct 미만이면 '확신도 낮음'으로 뺀다 — 다음 후보가 자리를 대신하지 않음")
    void lowConvictionTargetIsSkipped() {
        ((ObjectNode) store.settings.body().get("blend")).put("minTargetPct", 9.0);
        selection(Q2_RESELECTION);
        activeRules(PaperBooks.ACTIVE, 100_000);

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        assertThat(orders()).extracting(Order::ticker).as("BBB 8% < 9%").containsExactly("CCC", "SHY");
        assertThat(skippedReasons(decision, "BBB")).containsExactly("확신도 낮음");
        assertThat(decision.response().path("settings").path("minTargetPct").asDouble()).isEqualTo(9.0);
    }

    @Test
    @DisplayName("두 그룹 신호 풀: 겹친 기관은 두 그룹 가중을 모두 받고(A2·B1 = 0.5), q30이 없는 그룹 B 기관은 기존 메뉴 q8로 읽는다")
    void twoGroupPoolWeightsAndQ8Source() {
        // F4는 그룹 B에만 있고 q30 저장본이 없음 — 기존 메뉴 저장본(q8)에 CCC 신규.
        List<HoldingRow> q8 = new ArrayList<>(List.of(
                new HoldingRow(0, "2026-08-14", "2026-06-30", F4, "CUSIPCCC", "CCC", 10_000.0, 100.0),
                new HoldingRow(0, "2026-08-14", "2026-06-30", F4, "CUSIPDDD", "DDD", 10_000.0, 100.0),
                new HoldingRow(1, "2026-05-15", "2026-03-31", F4, "CUSIPDDD", "DDD", 10_000.0, 100.0)));
        holdings.put(Datasets.sec13f(F4, Datasets.MAX_TRACKED_QUARTERS), q8);
        // 그룹 A = F1·F2(가중 a = 2/3·1/3), 그룹 B = F2·F4(b = 2/3·1/3), g = 0.5
        // → F2 = 0.5 × 1/3 + 0.5 × 2/3 = 0.5, F1 = 1/3, F4 = 1/6.
        selection(FRI, List.of(F1, F2), List.of(F2, F4), 0.5);
        activeRules(PaperBooks.ACTIVE, 100_000);

        JsonNode response = rules.decide(MON, RuleBookService.SCHEDULED).response();

        JsonNode pool = response.path("selection").path("pool");
        assertThat(pool).extracting(m -> m.path("cik").asString()).as("A 순서 뒤에 B에만 있는 기관")
                .containsExactly(F1, F2, F4);
        assertThat(pool.get(1).path("weight").asDouble()).isCloseTo(0.5, within(1e-12));
        JsonNode filers = response.path("selection").path("filers");
        assertThat(filers.get(1).path("groups").toString()).isEqualTo("[\"A\",\"B\"]");
        assertThat(filers.get(1).path("rankA").asInt()).isEqualTo(2);
        assertThat(filers.get(1).path("rankB").asInt()).isEqualTo(1);
        assertThat(filers.get(2).path("source").asString()).isEqualTo("q8");
        assertThat(filers.get(2).path("groups").toString()).isEqualTo("[\"B\"]");
        assertThat(filers.get(0).path("source").asString()).isEqualTo("q30");

        JsonNode candidates = response.path("signals").path("candidates");
        assertThat(candidates).extracting(c -> c.path("ticker").asString())
                .as("BBB는 F1만(F3은 풀 밖) — 후보 아님").containsExactly("CCC");
        JsonNode ccc = candidates.get(0);
        assertThat(ccc.path("score").asDouble()).as("확신도 모두 1 → 가중 합").isCloseTo(1.0, within(1e-6));
        assertThat(ccc.path("contributions")).extracting(c -> c.path("cik").asString()).as("가중 ↓")
                .containsExactly(F2, F1, F4);
        assertThat(ccc.path("text").asString()).startsWith("3곳 동시 매수(점수 1.0000): "
                + "A2·B1 기관 B(0000000002) 신규(가중 0.5000 × 확신도 1.00)");
        assertThat(ccc.path("contributions").get(2).path("groups").toString()).isEqualTo("[\"B\"]");
        assertThat(ccc.path("contributions").get(2).path("rankB").asInt()).isEqualTo(2);
    }

    @Test
    @DisplayName("섞기(D27) 전에 남긴 선정(순위표 배열)도 읽는다 — 그룹 A만의 풀, 가중은 그룹 A 순위 가중, 메모로 알림")
    void legacySelectionStillWorks() {
        noParking();
        legacySelection(FRI);
        activeRules(PaperBooks.ACTIVE, 80_000, "OLD", 100, 100, "ONE", 100, 100);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        assertThat(orders()).extracting(Order::ticker).containsExactly("OLD");
        JsonNode selection = decision.response().path("selection");
        assertThat(selection.path("legacy").asBoolean()).isTrue();
        assertThat(selection.path("groupA")).hasSize(3);
        assertThat(selection.path("groupB")).isEmpty();
        assertThat(selection.path("pool")).extracting(m -> m.path("weight").asDouble())
                .containsExactly(0.5, 2.0 / 6, 1.0 / 6);
        assertThat(decision.response().path("notes").toString()).contains("그룹 섞기(D27) 전에 남긴 선정");
        assertThat(orders().get(0).reason().path("text").asString())
                .isEqualTo("2곳 전량 매도: A1 기관 A(0000000001), A2 기관 B(0000000002)");
    }

    @Test
    @DisplayName("목표 비중 이상 보유한 후보는 주문하지 않고, 현금이 모자라면 SHY를 그만큼(+여유) 일부 판다")
    void heldAboveTargetAndShySellWhenCashShort() {
        selection(Q2_RESELECTION);
        // 순자산 100,000: 현금 1,000 · CCC 12% · SHY 80% · AAA 7%
        activeRules(PaperBooks.ACTIVE, 1_000, "CCC", 120, 100, "SHY", 1_000, 80, "AAA", 70, 100);

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        // BBB만 8% 매수(확신도 비례) → 현금 1,000 − 8,004 = −7,004(−7.004%) → (0.5 + 7.004)% × 100,000 = 7,504
        // / (80,000 × 0.9995)
        assertThat(orders()).extracting(Order::ticker, Order::side).containsExactly(tuple("BBB", "BUY"),
                tuple("SHY", "SELL"));
        assertThat(orders().get(1).sellFraction()).isCloseTo(7_504 / 79_960.0, within(1e-6));
        assertThat(skippedReasons(decision, "CCC")).singleElement().asString().startsWith("이미 목표 비중 이상 보유");
        assertThat(decision.response().path("summary").asString()).startsWith("매수 1 · SHY 매도(모자란 현금)");
    }

    /** 앞선 결정이 낸 대기 주문(체결 전) 하나. */
    private void pendingOrder(String ticker, String side, Double sellFraction, LocalDate asOf) {
        pendingOrder(ticker, side, null, sellFraction, asOf);
    }

    /** 대기 매수 — targetWeightPct = 체결 시점 순자산 대비 살 금액(%). */
    private void pendingBuy(String ticker, double weightPct, LocalDate asOf) {
        pendingOrder(ticker, PaperBooks.BUY, weightPct, null, asOf);
    }

    private void pendingOrder(String ticker, String side, Double weightPct, Double sellFraction, LocalDate asOf) {
        store.insertOrder(new Order(0, PaperBooks.RULES, null, ticker, side, null, weightPct, sellFraction,
                "NEXT_OBSERVATION", "RULE", "PENDING", null, null, asOf, null,
                com.macrodash.analytics.UsMarketCalendar.addTradingDays(asOf, 3), null));
    }

    private List<Order> ordersOf(Decision decision) {
        return orders().stream().filter(o -> o.decisionId() != null && o.decisionId() == decision.id()).toList();
    }

    @Test
    @DisplayName("재선정일 계획은 이미 대기 중인 매도의 대금도 현금에 넣는다 — 매도를 다시 내지 않으면서 SHY를 덜 사지 않게")
    void rebalanceCountsPendingSellProceeds() {
        selection(Q2_RESELECTION);
        // reselectionDayBuysTopsUpAndParksShy와 같은 장부 — 다만 OLD 전량 매도는 앞선 수동 결정이 이미 냈음(대기 중)
        activeRules(PaperBooks.ACTIVE, 51_000, "OLD", 100, 100, "ONE", 100, 100, "CCC", 50, 100, "SHY", 300, 80);
        pendingOrder("OLD", PaperBooks.SELL, null, LocalDate.of(2026, 8, 14));

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        List<Order> made = orders().stream().filter(o -> o.decisionId() != null && o.decisionId() == decision.id())
                .toList();
        // 현금 어림: 51,000 + 대기 중인 OLD 매도 9,995 − CCC 5,002.5 − BBB 8,004 = 47,988.5 → SHY 47.4885%
        // (대기 매도를 빼면 37.4935%만 사서 OLD 대금 약 10%가 다음 분기까지 현금으로 놂)
        assertThat(made).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                tuple("CCC", "BUY", 5.0), tuple("BBB", "BUY", 8.0), tuple("SHY", "BUY", 47.4885));
        assertThat(skippedReasons(decision, "OLD")).singleElement().asString().contains("이미 대기 중인 매도");
    }

    // ------------------------------------------------------------------ 매일 남는 현금(SHY)·최소 금액
    @Test
    @DisplayName("재선정일이 아닌 날 남는 현금(현금 + 대기·이번 매도 대금 − 대기 매수 금액)이 2%를 넘으면 SHY 한 건 — 근거 park_cash, 결정 기록에도 남김")
    void dailyParkingAboveThreshold() {
        selection(FRI);
        // 순자산 100,000: 현금 1,000 · OLD 3,000(매도 대기 중) · GONE 1,200(2곳 전량 매도 → 이번에 매도) · AAA 94,800
        activeRules(PaperBooks.ACTIVE, 1_000, "OLD", 30, 100, "GONE", 40, 30, "AAA", 948, 100);
        pendingOrder("OLD", PaperBooks.SELL, null, FRI);
        pendingBuy("BBB", 1.2, FRI);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        // 남는 현금: 1,000 + OLD 2,998.5 + GONE 1,199.4 − BBB 1,200 × 1.0005 = 3,997.3(3.9973%) > 2% → SHY 3.4973%
        List<Order> made = ordersOf(decision);
        assertThat(made).extracting(Order::ticker, Order::side, Order::targetWeightPct).containsExactly(
                tuple("GONE", "SELL", null), tuple("SHY", "BUY", 3.4973));
        JsonNode reason = made.get(1).reason();
        assertThat(reason.path("rule").asString()).isEqualTo("park_cash");
        assertThat(reason.path("signal").asString()).isEqualTo("PARKING");
        assertThat(reason.path("kind").asString()).isEqualTo("SCHEDULED");
        assertThat(reason.path("parking").asBoolean()).isTrue();
        assertThat(reason.path("spareCashPct").asDouble()).isEqualTo(3.9973);
        assertThat(reason.path("thresholdPct").asDouble()).isEqualTo(2.0);
        assertThat(reason.path("bufferPct").asDouble()).isEqualTo(0.5);
        assertThat(reason.path("orderWeightPct").asDouble()).isEqualTo(3.4973);
        assertThat(reason.path("text").asString())
                .isEqualTo("남는 현금 4.00%가 기준 2.0%를 넘어 3.50%를 SHY에(여유 0.5%p) — 신호 매수가 아닌 현금 관리");
        assertThat(skippedReasons(decision, "OLD")).singleElement().asString().contains("이미 대기 중인 매도");

        JsonNode response = decision.response();
        assertThat(decision.status()).isEqualTo("OK");
        assertThat(response.path("summary").asString()).startsWith("매도 1 · SHY 매수(남는 현금) (선정 2026-10-23");
        assertThat(response.path("notes").toString()).contains("신호 매수가 아닌 현금 관리")
                .contains("재선정일이 아니라 사지 않습니다");
        assertThat(response.path("orders").get(1).path("parking").asBoolean()).isTrue();
        assertThat(response.path("settings").path("parkCashThresholdPct").asDouble()).isEqualTo(2.0);
        assertThat(response.path("settings").path("minOrderNotional").asDouble()).isEqualTo(500.0);
    }

    @Test
    @DisplayName("재선정일 선정을 기다리는 따라잡기 REBALANCE 날에도 남는 현금은 SHY에 둔다(매수는 하지 않음)")
    void catchUpRebalanceStillParksCash() {
        selection(FRI);   // 10-23 선정만 있음 — 11-17 재선정일 선정은 아직(수집 중 등)
        LocalDate r = com.macrodash.analytics.UsMarketCalendar.reselectionDay(LocalDate.of(2026, 9, 30));
        // 순자산 100,000: 현금 30,000 · AAA 70,000
        activeRules(PaperBooks.ACTIVE, 30_000, "AAA", 700, 100);

        Decision decision = rules.decide(r, RuleBookService.REBALANCE);

        List<Order> made = ordersOf(decision);
        assertThat(made).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("SHY", "BUY", 29.5));
        assertThat(made.get(0).reason().path("rule").asString()).isEqualTo("park_cash");
        assertThat(decision.response().path("notes").toString()).contains("재선정일(" + r + ") 선정이 없습니다");
    }

    @Test
    @DisplayName("재선정일 계획은 앞선 수동 결정의 현금 관리 SHY 주문을 취소하고 다시 정한다 — 같은 관측치에서 SHY를 팔고 다시 사지 않게")
    void rebalanceReplacesPendingParkingOrder() {
        selection(Q2_RESELECTION);
        // 순자산 100,000: 현금 5,000 · SHY 250주×80 · AAA 750주×100 — 수동 결정이 남는 현금 4.5%를 SHY로
        activeRules(PaperBooks.ACTIVE, 5_000, "SHY", 250, 80, "AAA", 750, 100);
        Decision manual = rules.decide(MON, RuleBookService.MANUAL);
        Order parking = ordersOf(manual).stream().filter(o -> "SHY".equals(o.ticker())).findFirst().orElseThrow();
        assertThat(parking.reason().path("rule").asString()).isEqualTo("park_cash");

        rules.decide(MON, RuleBookService.REBALANCE);

        assertThat(store.orders.get(parking.id()).status()).as("수동 결정의 SHY 매수는 취소").isEqualTo("CANCELLED");
        List<Order> pendingShy = store.ordersByStatus(PaperBooks.RULES, "PENDING").stream()
                .filter(o -> "SHY".equals(o.ticker())).toList();
        assertThat(pendingShy).as("SHY는 한 방향 주문 하나만").hasSizeLessThanOrEqualTo(1);
    }

    @Test
    @DisplayName("남는 현금이 기준(rules.parkCashThresholdPct) 이하면 SHY를 사지 않는다 — 대기 매수 금액도 빼고 보며, 기준을 낮추면 수동 결정도 산다")
    void dailyParkingBelowThreshold() {
        selection(FRI);
        // 순자산 100,000: 현금 1,900(1.9%) · AAA 98,100
        activeRules(PaperBooks.ACTIVE, 1_900, "AAA", 981, 100);

        Decision scheduled = rules.decide(MON, RuleBookService.SCHEDULED);
        assertThat(orders()).isEmpty();
        assertThat(scheduled.status()).isEqualTo("NO_TRADE");
        assertThat(scheduled.response().path("skipped").toString()).doesNotContain("SHY");

        // 기준 1.5%면 1.9% > 1.5% → SHY 1.4%(= 1,400달러). 같은 날 수동 결정(MANUAL)도 남는 현금을 봅니다.
        parkThreshold(1.5);
        Decision manual = rules.decide(MON, RuleBookService.MANUAL);
        assertThat(ordersOf(manual)).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("SHY", "BUY", 1.4));
        assertThat(ordersOf(manual).get(0).reason().path("kind").asString()).isEqualTo("MANUAL");
        assertThat(ordersOf(manual).get(0).reason().path("thresholdPct").asDouble()).isEqualTo(1.5);

        // 현금 5%라도 대기 중인 종목 매수(3.5%)가 쓸 현금을 빼면 5,000 − 3,501.75 = 1.49825% → 기준 2% 아래
        store.orders.clear();
        activeRules(PaperBooks.ACTIVE, 5_000, "AAA", 950, 100);
        parkThreshold(2);
        pendingBuy("BBB", 3.5, MON);
        Decision withPendingBuy = rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED);
        assertThat(ordersOf(withPendingBuy)).isEmpty();
        assertThat(withPendingBuy.status()).isEqualTo("NO_TRADE");
    }

    @Test
    @DisplayName("SHY 주문이 이미 대기 중이면(매수·매도) 매일 남는 현금 SHY를 새로 내지 않는다")
    void dailyParkingSkipsWhenShyOrderPending() {
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 5_000, "AAA", 950, 100);
        pendingBuy("SHY", 3.0, FRI);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        assertThat(ordersOf(decision)).isEmpty();
        assertThat(decision.status()).isEqualTo("NO_TRADE");
        assertThat(skippedReasons(decision, "SHY")).containsExactly("남는 현금 — 이미 대기 중인 SHY 주문이 있음");

        // 대기 중인 SHY 매도(재선정일의 모자란 현금)도 같음
        store.orders.clear();
        activeRules(PaperBooks.ACTIVE, 5_000, "AAA", 900, 100, "SHY", 62, 80);
        pendingOrder("SHY", PaperBooks.SELL, 0.5, FRI);
        Decision sellPending = rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED);
        assertThat(ordersOf(sellPending)).isEmpty();
        assertThat(skippedReasons(sellPending, "SHY")).containsExactly("남는 현금 — 이미 대기 중인 SHY 주문이 있음");
    }

    @Test
    @DisplayName("일시정지 책·parkCashInShy=false면 남는 현금이 많아도 매일 SHY를 사지 않는다")
    void dailyParkingNeverOnPausedOrDisabled() {
        selection(FRI);
        activeRules(PaperBooks.PAUSED, 50_000, "AAA", 500, 100);

        Decision paused = rules.decide(MON, RuleBookService.SCHEDULED);
        assertThat(paused.status()).isEqualTo("SKIPPED");
        assertThat(orders()).isEmpty();
        assertThat(paused.response().path("orders")).isEmpty();

        activeRules(PaperBooks.ACTIVE, 50_000, "AAA", 500, 100);
        noParking();
        Decision disabled = rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED);
        assertThat(orders()).isEmpty();
        assertThat(disabled.status()).isEqualTo("NO_TRADE");
    }

    @Test
    @DisplayName("매수 금액이 minOrderNotional(500달러) 미만이면 내지 않는다 — 목표까지 300달러 모자란 보유 보충·276달러 SHY는 건너뜀 '최소 금액 미만'")
    void minOrderNotionalSkipsSmallTopUpAndShy() {
        selection(Q2_RESELECTION);
        // 순자산 100,000: 현금 8,780 · CCC 9.7%(목표 10%) · SHY 81.52%
        activeRules(PaperBooks.ACTIVE, 8_780, "CCC", 97, 100, "SHY", 1_019, 80);

        Decision decision = rules.decide(Q2_RESELECTION, RuleBookService.REBALANCE);

        // CCC 보충 0.3% = 300달러 < 500 → 건너뜀. BBB 8% 매수 → 남는 현금 8,780 − 8,004 = 776(0.776%) → SHY 0.276% = 276달러 < 500
        assertThat(orders()).extracting(Order::ticker, Order::side, Order::targetWeightPct)
                .containsExactly(tuple("BBB", "BUY", 8.0));
        assertThat(skippedReasons(decision, "CCC")).containsExactly("최소 금액 미만(300.00달러 < 500달러)");
        assertThat(skippedReasons(decision, "SHY")).containsExactly("최소 금액 미만(276.00달러 < 500달러)");
        assertThat(decision.response().path("summary").asString()).startsWith("매수 1 (선정 2026-08-17");
    }

    @Test
    @DisplayName("매일 남는 현금 SHY에도 최소 금액 — 기준 0%여도 여유 0.5%p는 남기고, 남는 0.4%(400달러) SHY는 '최소 금액 미만'")
    void minOrderNotionalAppliesToDailyParking() {
        parkThreshold(0);
        selection(FRI);
        // 순자산 100,000: 현금 900(0.9%) · AAA 99,100
        activeRules(PaperBooks.ACTIVE, 900, "AAA", 991, 100);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        assertThat(orders()).isEmpty();
        assertThat(skippedReasons(decision, "SHY")).containsExactly("최소 금액 미만(400.00달러 < 500달러)");

        // 남는 현금이 여유(0.5%p) 이하면 기준이 0이어도 살 것이 없습니다(건너뜀도 남기지 않음).
        activeRules(PaperBooks.ACTIVE, 400, "AAA", 996, 100);
        Decision tiny = rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED);
        assertThat(ordersOf(tiny)).isEmpty();
        assertThat(skippedReasons(tiny, "SHY")).isEmpty();
    }

    @Test
    @DisplayName("설정: rules.parkCashThresholdPct(0~20)·minOrderNotional(0 이상)이 없거나 범위 밖이면 그 키만 기본값(2%·500달러)으로 읽고 이름을 남긴다")
    void parkingSettingsFallbacks() {
        ObjectNode body = MAPPER.createObjectNode();
        body.putObject("rules").put("parkCashThresholdPct", 25);
        body.put("minOrderNotional", -1);
        PaperSettings.Rules outOfRange = PaperSettings.Rules.from(body);
        assertThat(outOfRange.parkCashThresholdPct()).isEqualTo(2.0);
        assertThat(outOfRange.fallbacks()).containsExactly("rules.parkCashThresholdPct");
        RuleBookService.RuleSettings rulesOut = RuleBookService.RuleSettings.from(body);
        assertThat(rulesOut.minOrderNotional()).isEqualTo(500.0);
        assertThat(rulesOut.fallbacks()).contains("minOrderNotional");

        ((ObjectNode) body.get("rules")).put("parkCashThresholdPct", 0);
        body.put("minOrderNotional", 250);
        assertThat(PaperSettings.Rules.from(body).parkCashThresholdPct()).isZero();
        assertThat(PaperSettings.Rules.from(body).fallbacks()).isEmpty();
        assertThat(RuleBookService.RuleSettings.from(body).minOrderNotional()).isEqualTo(250.0);
        ((ObjectNode) body.get("rules")).put("parkCashThresholdPct", "3");
        assertThat(PaperSettings.Rules.from(body).fallbacks()).as("숫자가 아님").containsExactly("rules.parkCashThresholdPct");

        PaperSettings.Rules old = PaperSettings.Rules.from(MAPPER.createObjectNode().put("minHolders", 2));
        assertThat(old.fallbacks()).as("단계 2 전 행 — rules 묶음이 통째로 없음").containsExactly("rules");
        assertThat(old.parkCashThresholdPct()).isEqualTo(2.0);
        assertThat(PaperSettings.Rules.from(PaperFixtures.settings(store).defaultsJson()))
                .isEqualTo(PaperSettings.Rules.defaults());
        assertThat(PaperSettings.from(PaperFixtures.settings(store).defaultsJson()).fallbacks())
                .as("rules 기본값은 장부 경고에 섞지 않음").isEmpty();
        assertThat(PaperSettings.from(null).rules()).isEqualTo(PaperSettings.Rules.defaults());

        // rules 묶음이 없는 설정 행으로 결정하면 기본 2%로 읽고, 결정 기록의 settings.fallbacks에 'rules'가 남습니다.
        ((ObjectNode) store.settings.body()).remove("rules");
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 1_900, "AAA", 981, 100);
        JsonNode used = rules.decide(MON, RuleBookService.SCHEDULED).response().path("settings");
        assertThat(used.path("parkCashThresholdPct").asDouble()).isEqualTo(2.0);
        assertThat(used.path("fallbacks").toString()).contains("\"rules\"");
        assertThat(orders()).as("1.9% ≤ 2%").isEmpty();
    }

    @Test
    @DisplayName("결정이 13F를 읽는 사이 책이 초기화(시작 전)되면 주문 없이 400 — 시작 전 책에 REBALANCE 주문을 남기지 않는다")
    void resetDuringDecisionLeavesNoOrders() {
        selection(Q2_RESELECTION);
        activeRules(PaperBooks.ACTIVE, 51_000, "OLD", 100, 100, "SHY", 300, 80);
        PaperSettingsService settings = PaperFixtures.settings(store);
        boolean[] reset = {false};
        PaperLedgerService racing = new PaperLedgerService(store, marketData, MAPPER) {
            @Override
            <T> T exclusively(Supplier<T> work) {
                if (!reset[0]) {
                    reset[0] = true;
                    store.resetBook(PaperBooks.RULES);   // 사용자가 rules 리셋을 누름(잠금을 먼저 잡음)
                    notStartedRules();
                }
                return super.exclusively(work);
            }
        };
        PaperSelectionService selections = new PaperSelectionService(store, reader, marketData, settings, MAPPER, NOW);
        RuleBookService racingRules = new RuleBookService(store, reader, marketData, selections, settings, racing,
                new PaperAdminService(store, marketData, reader, settings, racing, PaperFixtures.config(), MAPPER, NOW),
                PaperFixtures.config(), MAPPER, NOW);

        assertThatThrownBy(() -> racingRules.decide(Q2_RESELECTION, RuleBookService.REBALANCE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("시작 전");
        assertThat(orders()).isEmpty();
        assertThat(store.decisionsOf(PaperBooks.RULES)).isEmpty();
    }

    @Test
    @DisplayName("같은 (거래일, 종류)의 결정은 한 번 — 다시 불러도 같은 결정·주문, 같은 날 수동 결정은 대기 중인 매도·SHY를 다시 내지 않는다")
    void decisionsAreIdempotent() {
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 90_000, "OLD", 100, 100);

        Decision first = rules.decide(MON, RuleBookService.SCHEDULED);
        Decision second = rules.decide(MON, RuleBookService.SCHEDULED);

        assertThat(second.id()).isEqualTo(first.id());
        assertThat(orders()).extracting(Order::ticker).as("OLD 매도 + 남는 현금 SHY").containsExactly("OLD", "SHY");
        assertThat(store.decisionsOf(PaperBooks.RULES)).hasSize(1);

        Decision manual = rules.decide(MON, RuleBookService.MANUAL);
        assertThat(manual.id()).isNotEqualTo(first.id());
        assertThat(manual.status()).isEqualTo("NO_TRADE");
        assertThat(orders()).as("매도·SHY 주문은 그대로 하나씩").hasSize(2);
        assertThat(skippedReasons(manual, "OLD")).singleElement().asString().contains("이미 대기 중인 매도");
        assertThat(skippedReasons(manual, "SHY")).containsExactly("남는 현금 — 이미 대기 중인 SHY 주문이 있음");
    }

    @Test
    @DisplayName("일시정지 책은 주문 없이 SKIPPED를 남기고, 시작 전 책·초기화 전은 400")
    void pausedSkipsAndNotStartedRefuses() {
        selection(FRI);
        activeRules(PaperBooks.PAUSED, 90_000, "OLD", 100, 100);
        assertThat(rules.decide(MON, RuleBookService.SCHEDULED).status()).isEqualTo("SKIPPED");
        assertThat(orders()).isEmpty();

        notStartedRules();
        assertThatThrownBy(() -> rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("시작 전");
        store.books.clear();
        assertThatThrownBy(() -> rules.decide(PaperFixtures.TUE, RuleBookService.SCHEDULED))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("초기화");
    }

    @Test
    @DisplayName("신호는 선정 기준일까지 낸 공시만 쓴다 — 선정 뒤에 들어온 분기(Q3)는 다음 재선정까지 쓰지 않는다")
    void signalsIgnoreFilingsAfterSelectionAsOf() {
        // Q3(11-13 공시): 1위·2위가 CCC를 전량 매도
        q30(F1, quarter("2026-09-30", "2026-11-13", line("BBB", 1400, 140_000)),
                quarter("2026-06-30", "2026-08-14", line("BBB", 1400, 140_000), line("CCC", 500, 50_000)),
                quarter("2026-03-31", "2026-05-15", line("BBB", 1000, 100_000)));
        q30(F2, quarter("2026-09-30", "2026-11-13", line("AAA", 100, 10_000)),
                quarter("2026-06-30", "2026-08-14", line("AAA", 100, 10_000), line("CCC", 100, 10_000)),
                quarter("2026-03-31", "2026-05-15", line("AAA", 100, 10_000)));
        noParking();
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 90_000, "CCC", 100, 100);

        Decision before = rules.decide(LocalDate.of(2026, 11, 16), RuleBookService.SCHEDULED);
        assertThat(orders()).as("10-23 선정은 Q2까지만 — CCC는 신규 매수였을 뿐").isEmpty();
        assertThat(before.response().path("selection").path("filers").get(0).path("reportDate").asString())
                .isEqualTo("2026-06-30");

        selection(LocalDate.of(2026, 11, 17));
        rules.decide(LocalDate.of(2026, 11, 18), RuleBookService.SCHEDULED);
        assertThat(orders()).extracting(Order::ticker, Order::side).containsExactly(tuple("CCC", "SELL"));
    }

    @Test
    @DisplayName("모든 기관을 같은 분기로 대조한다 — 다음 분기(Q3)를 일찍 낸 기관도 10-23 선정에서는 Q2 대 Q1(서로 다른 분기의 매수를 묶지 않음)")
    void signalsUseOneQuarterForAllFilers() {
        // 1위가 Q3(09-30)를 10-15에 일찍 냄: Q3에 ZZZ를 새로 삼. 2위는 Q2에 ZZZ를 새로 삼.
        q30(F1, quarter("2026-09-30", "2026-10-15", line("BBB", 1400, 140_000), line("CCC", 500, 50_000),
                        line("ZZZ", 10, 1_000)),
                quarter("2026-06-30", "2026-08-14", line("BBB", 1400, 140_000), line("CCC", 500, 50_000)),
                quarter("2026-03-31", "2026-05-15", line("BBB", 1000, 100_000)));
        q30(F2, quarter("2026-06-30", "2026-08-14", line("AAA", 100, 10_000), line("CCC", 100, 10_000),
                        line("ZZZ", 10, 1_000)),
                quarter("2026-03-31", "2026-05-15", line("AAA", 100, 10_000)));
        q30(F3, quarter("2026-03-31", "2026-05-15", line("AAA", 100, 10_000)));   // Q2를 아직 내지 않음
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 90_000);

        Decision decision = rules.decide(MON, RuleBookService.SCHEDULED);

        JsonNode response = decision.response();
        assertThat(response.path("selection").path("filers").get(0).path("reportDate").asString())
                .as("일찍 낸 Q3가 아니라 선정 대상 분기 Q2").isEqualTo("2026-06-30");
        assertThat(response.path("signals").path("candidates")).extracting(c -> c.path("ticker").asString())
                .as("1위의 Q2 신규 CCC가 살아 있고, 분기가 다른 ZZZ는 '동시 매수'가 아님").containsExactly("CCC");
        assertThat(response.path("selection").path("filers").get(2).path("reportDate").isNull()).isTrue();
        assertThat(response.path("notes").toString())
                .contains("A3 기관 C(0000000003): 선정 기준일(2026-10-23)까지 낸 2026-06-30 분기 13F가 저장본에 없음");
    }

    @Test
    @DisplayName("두 분기 사이 주식 분할은 수정주가로 보정한다 — 분할만 있었던 종목은 '동시 매수' 후보가 되지 않는다")
    void splitBetweenQuartersIsNotABuySignal() {
        // 1위·2위가 SPL을 그대로 들고 있었는데 2:1 분할로 주식 수만 두 배(평가액 그대로)
        q30(F1, quarter("2026-06-30", "2026-08-14", line("SPL", 200, 20_000), line("CCC", 500, 50_000)),
                quarter("2026-03-31", "2026-05-15", line("SPL", 100, 20_000)));
        q30(F2, quarter("2026-06-30", "2026-08-14", line("SPL", 400, 40_000), line("CCC", 100, 10_000)),
                quarter("2026-03-31", "2026-05-15", line("SPL", 200, 40_000)));
        q30(F3, quarter("2026-06-30", "2026-08-14", line("AAA", 50, 5_000)),
                quarter("2026-03-31", "2026-05-15", line("AAA", 50, 5_000)));
        java.util.TreeMap<LocalDate, Double> spl = new java.util.TreeMap<>(Map.of(
                LocalDate.of(2026, 3, 31), 100.0, LocalDate.of(2026, 6, 30), 100.0));
        when(marketData.history(anyCollection(), org.mockito.ArgumentMatchers.eq(LocalDate.of(2026, 3, 17)),
                org.mockito.ArgumentMatchers.eq(LocalDate.of(2026, 6, 30))))
                .thenReturn(Map.of("SPL", com.macrodash.analytics.DailySeries.of(spl)));
        selection(FRI);
        activeRules(PaperBooks.ACTIVE, 90_000);

        JsonNode response = rules.decide(MON, RuleBookService.SCHEDULED).response();

        assertThat(response.path("signals").path("candidates")).extracting(c -> c.path("ticker").asString())
                .containsExactly("CCC");
        assertThat(response.path("signals").path("events")).noneMatch(e -> "SPL".equals(e.path("ticker").asString()));
        assertThat(response.path("notes").toString()).contains("SPL 2:1 분할");
    }

    // ------------------------------------------------------------------ 시작
    @Test
    @DisplayName("시작: 후보 목록에 수집 중인 기관이 있으면 400(수집 중 n곳) — 장부·선정을 바꾸지 않는다")
    void startRefusesWhileCollecting() {
        notStartedRules();
        index(true, true, true, false);

        assertThatThrownBy(() -> rules.start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("수집 중 1곳(후보 4곳)").hasMessageContaining("기관 D 12/30");
        assertThat(store.selections).isEmpty();
        assertThat(store.books.get(PaperBooks.RULES).status()).isEqualTo("NOT_STARTED");

        snapshots.clear();
        assertThatThrownBy(() -> rules.start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("후보 목록");
    }

    @Test
    @DisplayName("시작: 출발일 선정의 신호로 사후 체결 — 종목마다 점수와 어느 기관(그룹·순위·가중·확신도)이 신규/+30%였는지 남기고, 종목 먼저·SHY 마지막, 책은 운용")
    void startBackfillsWithEvidence() {
        standardFilings(true);
        notStartedRules();
        index(true, true, true);
        selection(FRI);
        frozen("CCC", 100);
        frozen("BBB", 50);
        frozen("SHY", 80);

        RuleBookService.StartResult result = rules.start();

        // 목표 CCC 10%(최고 점수 0.8333) · BBB 8%(0.6667). CCC 10,000 / 100.05 → 99주, BBB 8,000 / 50.025 → 159주,
        // SHY (100,000 − 10,005 − 8,004 = 81,991 → 81.991% − 0.5%p) 81,491 / 80.04 → 1,018주
        assertThat(result.fills()).extracting(Fill::ticker, Fill::qty).containsExactly(tuple("CCC", 99),
                tuple("BBB", 159), tuple("SHY", 1018));
        assertThat(result.fills()).allSatisfy(f -> {
            assertThat(f.backfill()).isTrue();
            assertThat(f.observedAt()).isEqualTo(FRI_CLOSE);
        });
        Decision decision = result.decision();
        assertThat(decision.kind()).isEqualTo("INITIAL");
        assertThat(decision.status()).isEqualTo("OK");
        assertThat(decision.asOfTradingDate()).isEqualTo(FRI);
        assertThat(decision.selectionAsOf()).isEqualTo(FRI);
        assertThat(decision.response().path("fills").size()).isEqualTo(3);
        assertThat(skippedReasons(decision, "EEE")).containsExactly("출발일(2026-10-23) 종가 없음");
        assertThat(skippedReasons(decision, "XXX")).containsExactly("유니버스 밖");

        Order bbb = orders().stream().filter(o -> o.ticker().equals("BBB")).findFirst().orElseThrow();
        assertThat(bbb.timing()).isEqualTo("BACKFILL");
        assertThat(bbb.status()).isEqualTo("FILLED");
        assertThat(bbb.decisionId()).isEqualTo(decision.id());
        assertThat(bbb.reason().path("text").asString()).isEqualTo("2곳 동시 매수(점수 0.6667): "
                + "A1 기관 A(0000000001) +40.0%(가중 0.5000 × 확신도 1.00), A3 기관 C(0000000003) 신규(가중 0.1667 × 확신도 1.00)");
        JsonNode buyers = bbb.reason().path("buyers");
        assertThat(buyers.get(0).path("action").asString()).isEqualTo("ADDED");
        assertThat(buyers.get(0).path("sharesChangePct").asDouble()).isEqualTo(40.0);
        assertThat(buyers.get(1).path("rankA").asInt()).isEqualTo(3);
        assertThat(buyers.get(1).path("action").asString()).isEqualTo("NEW");
        // 수용 기준 — 어느 기관(그룹·순위·가중)이 무엇을 했고 점수에 얼마를 보탰나.
        assertThat(bbb.reason().path("score").asDouble()).isCloseTo(2.0 / 3, within(1e-6));
        assertThat(bbb.reason().path("targetWeightPct").asDouble()).isEqualTo(8.0);
        JsonNode contributions = bbb.reason().path("contributions");
        assertThat(contributions).hasSize(2);
        assertThat(contributions.get(0).path("cik").asString()).isEqualTo(F1);
        assertThat(contributions.get(0).path("name").asString()).isEqualTo("기관 A");
        assertThat(contributions.get(0).path("groups").toString()).isEqualTo("[\"A\"]");
        assertThat(contributions.get(0).path("rankA").asInt()).isEqualTo(1);
        assertThat(contributions.get(0).path("filerWeight").asDouble()).isEqualTo(0.5);
        assertThat(contributions.get(0).path("conviction").asDouble()).isEqualTo(1.0);
        assertThat(contributions.get(0).path("points").asDouble()).isEqualTo(0.5);
        assertThat(contributions.get(0).path("action").asString()).isEqualTo("ADDED");
        assertThat(contributions.get(0).path("weightPct").asDouble()).as("140,000 / 241,000")
                .isCloseTo(58.0913, within(1e-4));
        assertThat(contributions.get(1).path("filerWeight").asDouble()).isCloseTo(1.0 / 6, within(1e-6));
        // 결정 기록의 후보에도 점수·기여, 선정에는 그룹·풀·가중.
        JsonNode candidates = decision.response().path("signals").path("candidates");
        assertThat(candidates).extracting(c -> c.path("ticker").asString()).as("점수 ↓")
                .containsExactly("CCC", "BBB", "XXX", "EEE");
        assertThat(candidates.get(0).path("score").asDouble()).isCloseTo(0.5 + 1.0 / 3, within(1e-6));
        assertThat(candidates.get(3).path("contributions").get(0).path("conviction").asDouble())
                .as("EEE: 1,000 / 241,000 = 0.41% → 확신도 0.0415").isCloseTo(0.041494, within(1e-6));
        JsonNode selection = decision.response().path("selection");
        assertThat(selection.path("pool")).extracting(m -> m.path("cik").asString()).containsExactly(F1, F2, F3);
        assertThat(selection.path("pool").get(1).path("weight").asDouble()).isCloseTo(1.0 / 3, within(1e-12));
        assertThat(selection.path("filers").get(0).path("source").asString()).isEqualTo("q30");
        assertThat(selection.path("legacy").asBoolean()).isFalse();

        assertThat(store.books.get(PaperBooks.RULES).status()).isEqualTo("ACTIVE");
        assertThat(store.books.get(PaperBooks.RULES).startedOn()).isEqualTo(FRI);
        // 100,000 − 99 × 100.05 − 159 × 50.025 − 1,018 × 80.04
        assertThat(store.states.get(PaperBooks.RULES).cash()).isCloseTo(660.355, within(1e-6));
        assertThat(store.navSeries(PaperBooks.RULES)).singleElement().satisfies(row -> {
            assertThat(row.tradingDate()).isEqualTo(FRI);
            assertThat(row.pricesFinal()).isTrue();
        });

        assertThatThrownBy(() -> rules.start()).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("이미 시작");
        assertThat(store.fillsOf(PaperBooks.RULES)).hasSize(3);
    }

    @Test
    @DisplayName("시작은 시작 전 책에 남은 대기 주문(리셋과 겹친 결정의 찌꺼기)을 먼저 취소한다 — 초기 배분 위에 더 체결되지 않게")
    void startCancelsLeftoverPendingOrders() {
        notStartedRules();
        index(true, true, true);
        selection(FRI);
        frozen("CCC", 100);
        frozen("BBB", 50);
        frozen("SHY", 80);
        pendingOrder("AAA", PaperBooks.BUY, null, FRI);

        rules.start();

        assertThat(orders()).filteredOn(o -> o.ticker().equals("AAA")).singleElement()
                .satisfies(o -> assertThat(o.status()).isEqualTo("CANCELLED"));
        assertThat(store.ordersByStatus(PaperBooks.RULES, "PENDING")).isEmpty();
    }

    @Test
    @DisplayName("시작 미리보기는 장부·선정을 바꾸지 않고 낼 주문을 보인다")
    void previewDoesNotTouchLedger() {
        notStartedRules();
        index(true, true, true);
        selection(FRI);
        frozen("CCC", 100);
        frozen("BBB", 50);
        frozen("SHY", 80);

        JsonNode plan = rules.preview();

        assertThat(plan.path("preview").asBoolean()).isTrue();
        assertThat(plan.path("orders")).extracting(o -> o.path("ticker").asString())
                .containsExactly("CCC", "BBB", "SHY");
        assertThat(store.orders).isEmpty();
        assertThat(store.decisions).isEmpty();
        assertThat(store.books.get(PaperBooks.RULES).status()).isEqualTo("NOT_STARTED");
    }
}
