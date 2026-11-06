package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.SourcedClose;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.CostAdjustment;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.FRI_CLOSE;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_INTRADAY;
import static com.macrodash.feature.paper.PaperFixtures.TUE;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.data.Offset.offset;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 미국 체결 비용의 과거 소급(ADR 0030 결정 2, 명세 2026-11-06-us-costs-backfill.md §2·§7) — 조정 행은 체결마다 한 번(두 번 돌려도 같음), 새 비용으로
 * 체결된 행은 건너뜀, 계좌 현금·순자산 줄·노출, 읽을 때 계산되는 통계, 확인 글자·시장, 한국 계좌 불변.
 *
 * <p>재료: ADR 0030 전처럼 미국 비용 비율 0인 설정으로 초기화(벤치마크 둘 사후 체결 — 비용 칸 0)하고, Claude 계좌1에 비용 칸 0인 매수·매도와 새 비용으로
 * 체결된 매수 하나, 순자산 줄 셋(금·월·화)을 둡니다(모두 10-26 12:00 UTC에 씀). 그 판 1의 이력 본문은 ADR 0030 전 판처럼 비용 키가 없게 바꿉니다
 * (기본 비율 — 수수료 10bp·SEC $20.60/백만·TAF $0.000195/주·상한 $9.79 — 로 읽힘). 다음 날 설정에 기본 비율을 적어 저장합니다(판 2). 소급은
 * 체결 때 유효했던 판(여기서는 판 1)의 비율을 씁니다.
 */
class UsCostBackfillTest {

    private static final Clock NOW = Clock.fixed(Instant.parse("2026-11-06T12:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private PaperMarketData marketData;
    private PaperAdminService admin;
    private PaperQueryService query;
    private long claudeBuy;
    private long claudeSell;
    private long claudeNewCost;
    private long krFill;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.sourcedCloseOn(anyString(), any())).thenReturn(Optional.empty());
        when(marketData.sourcedCloseOn("SPY", FRI)).thenReturn(Optional.of(new SourcedClose(500, "equity_close")));
        when(marketData.sourcedCloseOn("SHY", FRI)).thenReturn(Optional.of(new SourcedClose(82.5, "equity_close")));
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.empty());
        PaperSettingsService settings = PaperFixtures.settings(store);
        ObjectNode body = (ObjectNode) settings.defaultsJson();
        body.put("commissionBp", 0);
        ((ObjectNode) body.get("regFees")).put("secPerMillion", 0).put("tafPerShare", 0).put("tafMaxPerTrade", 0);
        store.initSettingsIfAbsent(body);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        admin = new PaperAdminService(store, marketData, PaperFixtures.quietReader(), settings, ledger,
                PaperFixtures.config(), PaperFixtures.MAPPER, Clock.fixed(Instant.parse("2026-10-24T00:00:00Z"),
                ZoneOffset.UTC));
        admin.init();
        query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(), settings, PaperFixtures.config(), NOW);

        // Claude 계좌1 — 비용 칸 0인 매수(금)·매도(월), 새 비용으로 체결된 매수(월), 순자산 줄 셋.
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude", 100_000, FRI,
                PaperBooks.ACTIVE, FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 50_000, 100_000, 50_000, 50, MON_INTRADAY,
                MON_INTRADAY, TUE, null));
        claudeBuy = fill(PaperBooks.CLAUDE, "AAA", "BUY", 10, 100.05, 1_000.5, FRI, BigDecimal.ZERO, BigDecimal.ZERO);
        claudeSell = fill(PaperBooks.CLAUDE, "BBB", "SELL", 100, 91.85405, 9_185.405, MON, BigDecimal.ZERO, BigDecimal.ZERO);
        claudeNewCost = fill(PaperBooks.CLAUDE, "CCC", "BUY", 1, 50.025, 50.025, MON, new BigDecimal("0.05"), BigDecimal.ZERO);
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, FRI, 100_000, 50_000, 50_000, 50, true));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, MON, 101_000, 51_000, 50_000, 49.505, true));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, TUE, 100_000, 50_000, 50_000, 50, false));

        // 한국 계좌 — 비용 칸 0인 체결이 있어도 건드리지 않음(한국은 출발부터 비용 반영).
        store.books.put("kr_claude", new Book("kr_claude", PaperBooks.KIND_CLAUDE, "한국", 100_000_000, FRI,
                PaperBooks.ACTIVE, FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        store.states.put("kr_claude", new BookState("kr_claude", 1_000_000, 100_000_000, 99_000_000, 99, null, null, null,
                null));
        krFill = fill("kr_claude", "069500", "BUY", 10, 40_000, 400_000, FRI, BigDecimal.ZERO, BigDecimal.ZERO);
        store.upsertNav(new NavRow("kr_claude", FRI, 100_000_000, 1_000_000, 99_000_000, 99, true));

        // 판 1을 ADR 0030 전 본문(비용 키 없음)으로 — 초기화 때의 비용 0은 벤치마크 사후 체결의 비용 칸 0을 만드는 데만 씀.
        ObjectNode legacy = body.deepCopy();
        legacy.remove("commissionBp");
        legacy.remove("regFees");
        store.settingsHistory.put(1, new SettingsRow(1, legacy, store.settingsHistory.get(1).updatedAt()));

        // 배포 뒤(다음 날): 설정에 기본 비율을 적어 저장(판 2).
        store.dbNow = Instant.parse("2026-10-27T12:00:00Z");
        ObjectNode after = body.deepCopy();
        after.put("commissionBp", 10);
        ((ObjectNode) after.get("regFees")).put("secPerMillion", 20.6).put("tafPerShare", 0.000195).put("tafMaxPerTrade", 9.79);
        store.saveSettings(after, List.of("commissionBp", "regFees.secPerMillion", "regFees.tafPerShare",
                "regFees.tafMaxPerTrade"));
    }

    private long fill(String code, String ticker, String side, int qty, double price, double gross,
                      java.time.LocalDate date, BigDecimal fee, BigDecimal tax) {
        return fillAt(code, ticker, side, qty, price, gross, date, fee, tax, null);
    }

    /** 체결 행을 쓴 시각을 정해 넣음(null이면 가짜 저장소의 지금 — {@code dbNow}). */
    private long fillAt(String code, String ticker, String side, int qty, double price, double gross,
                        java.time.LocalDate date, BigDecimal fee, BigDecimal tax, Instant createdAt) {
        long orderId = store.insertOrder(new Order(0, code, null, ticker, side, qty, null, null, "NEXT_OBSERVATION",
                "CLAUDE", "FILLED", null, null, date.minusDays(1), FRI_CLOSE, date.plusDays(3), FRI_CLOSE));
        return store.insertFill(new Fill(0, orderId, code, ticker, side, qty, price, price, 5, gross, FRI_CLOSE, date,
                "paper.quotes", false, createdAt, fee, tax, BigDecimal.ZERO));
    }

    private static Map<String, Object> book(UsCostBackfill.Result result, String code) {
        UsCostBackfill.BookResult row = result.books().stream().filter(b -> b.code().equals(code)).findFirst().orElseThrow();
        return Map.of("fills", row.fills(), "fee", row.fee().toPlainString(), "tax", row.tax().toPlainString(),
                "cashDelta", row.cashDelta().toPlainString());
    }

    @Test
    @DisplayName("비용 칸 0인 미국 체결마다 체결 때 판(1 — 비용 키 없음 → 기본 비율)으로 조정 행 하나 — 수수료·제비용·현금 차이·반영 거래일·쓴 비율, 체결 행은 그대로")
    void adjustsEachZeroCostUsFillOnce() {
        UsCostBackfill.Result result = admin.costBackfill("US", "비용 소급");

        assertThat(result.market()).isEqualTo("US");
        assertThat(result.versions()).hasSize(1);
        UsCostBackfill.VersionUsed used = result.versions().get(0);
        assertThat(used.settingsVersion()).isEqualTo(1);
        assertThat(used.fills()).as("claude 2 + bench_spy 1 + bench_mix 2").isEqualTo(5);
        assertThat(used.rates()).containsEntry("commissionBp", BigDecimal.valueOf(10.0))
                .containsEntry("secPerMillion", BigDecimal.valueOf(20.6))
                .containsEntry("tafPerShare", BigDecimal.valueOf(0.000195))
                .containsEntry("tafMaxPerTrade", BigDecimal.valueOf(9.79));
        assertThat(result.zeroCostFills()).isZero();
        assertThat(result.books()).extracting(UsCostBackfill.BookResult::code)
                .containsExactly("rules", "claude", "claude2", "bench_spy", "bench_mix");
        // 매수 1,000.5 → 수수료 1.00(1.0005), 매도 9,185.405 → 수수료 9.19 + SEC 0.19 + TAF 0.02
        assertThat(book(result, "claude")).isEqualTo(Map.of("fills", 2, "fee", "10.19", "tax", "0.21", "cashDelta", "-10.40"));
        // 벤치마크도(ADR 0030 결정 1): SPY 199 × 500.25 = 99,549.75 → 99.55
        assertThat(book(result, "bench_spy")).isEqualTo(Map.of("fills", 1, "fee", "99.55", "tax", "0.00", "cashDelta", "-99.55"));
        // SPY 59,529.75 → 59.53, SHY 39,949.965 → 39.95
        assertThat(book(result, "bench_mix")).isEqualTo(Map.of("fills", 2, "fee", "99.48", "tax", "0.00", "cashDelta", "-99.48"));
        assertThat(book(result, "rules").get("fills")).isEqualTo(0);

        CostAdjustment sell = store.costAdjustments.get(claudeSell);
        assertThat(sell.market()).isEqualTo("US");
        assertThat(sell.fee()).isEqualByComparingTo("9.19");
        assertThat(sell.tax()).isEqualByComparingTo("0.21");
        assertThat(sell.cashDelta()).isEqualByComparingTo("-9.40");
        assertThat(sell.fillDate()).isEqualTo(MON);
        assertThat(sell.settingsVersion()).isEqualTo(1);
        assertThat(sell.reason()).isEqualTo("us-cost-backfill");
        assertThat(sell.rates().toString())
                .isEqualTo("{\"commissionBp\":10.0,\"secPerMillion\":20.6,\"tafPerShare\":0.000195,\"tafMaxPerTrade\":9.79}");
        assertThat(store.costAdjustments).as("새 비용 체결·한국 체결은 조정하지 않음").doesNotContainKeys(claudeNewCost, krFill)
                .containsKey(claudeBuy);
        assertThat(store.fills.get(claudeSell).fee()).as("체결 행은 그대로").isEqualByComparingTo("0");
        assertThat(store.fills.get(claudeSell).qty()).isEqualTo(100);
        assertThat(store.jobRuns).extracting(r -> r.job()).contains(UsCostBackfill.JOB);
    }

    @Test
    @DisplayName("계좌 현금·순자산은 조정 합만큼, 순자산 줄 d는 반영 거래일 ≤ d인 조정 합만큼(노출 다시 셈) — 평가액·확정 표시는 그대로, 한국 장부는 그대로")
    void shiftsCashAndNavRows() {
        UsCostBackfill.Result result = admin.costBackfill("US", "비용 소급");

        BookState claude = store.states.get(PaperBooks.CLAUDE);
        assertThat(claude.cash()).isCloseTo(50_000 - 10.40, offset(1e-9));
        assertThat(claude.nav()).isCloseTo(100_000 - 10.40, offset(1e-9));
        assertThat(claude.equityValue()).isEqualTo(50_000);
        assertThat(claude.exposurePct()).isCloseTo(50_000 / (100_000 - 10.40) * 100, offset(1e-4));
        assertThat(claude.lastProcessedCollectedAt()).as("멱등 키 그대로").isEqualTo(MON_INTRADAY);
        List<NavRow> nav = store.navSeries(PaperBooks.CLAUDE);
        assertThat(nav).extracting(NavRow::nav).containsExactly(100_000 - 1.00, 101_000 - 10.40, 100_000 - 10.40);
        assertThat(nav).extracting(NavRow::cash).containsExactly(50_000 - 1.00, 51_000 - 10.40, 50_000 - 10.40);
        assertThat(nav).extracting(NavRow::equityValue).containsOnly(50_000.0);
        assertThat(nav).extracting(NavRow::pricesFinal).containsExactly(true, true, false);
        assertThat(nav.get(1).exposurePct()).isCloseTo(50_000 / (101_000 - 10.40) * 100, offset(1e-4));

        assertThat(store.states.get("bench_spy").cash()).isCloseTo(450.25 - 99.55, offset(1e-9));
        assertThat(store.navSeries("bench_spy")).extracting(NavRow::nav).containsExactly(99_950.25 - 99.55);
        assertThat(store.states.get("bench_mix").cash()).as("앞으로의 체결로 냈을 때와 같은 현금(같은 수량)")
                .isCloseTo(420.805, offset(1e-9));
        // claude 줄 셋(금부터) + bench_spy 하나 + bench_mix 하나
        assertThat(result.navRowsUpdated()).isEqualTo(5);

        assertThat(store.states.get("kr_claude").cash()).isEqualTo(1_000_000);
        assertThat(store.navSeries("kr_claude")).extracting(NavRow::nav).containsExactly(100_000_000.0);
    }

    @Test
    @DisplayName("두 번 돌려도 한 번 — 두 번째는 조정 행·현금·순자산 줄이 그대로이고 결과는 체결 0")
    void secondRunChangesNothing() {
        admin.costBackfill("US", "비용 소급");
        Map<Long, CostAdjustment> first = Map.copyOf(store.costAdjustments);
        double cash = store.states.get(PaperBooks.CLAUDE).cash();
        List<NavRow> nav = store.navSeries(PaperBooks.CLAUDE);

        UsCostBackfill.Result again = admin.costBackfill("US", "비용 소급");

        assertThat(again.books()).allSatisfy(b -> {
            assertThat(b.fills()).isZero();
            assertThat(b.cashDelta()).isEqualByComparingTo("0");
        });
        assertThat(again.navRowsUpdated()).isZero();
        assertThat(store.costAdjustments).isEqualTo(first);
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(cash);
        assertThat(store.navSeries(PaperBooks.CLAUDE)).isEqualTo(nav);
    }

    @Test
    @DisplayName("통계·체결 목록은 읽을 때 셈 — 순자산 줄을 따라오고, 미국 체결 목록에 비용 칸과 소급 조정('비용 소급 — 수량은 당시 그대로')이 실림")
    @SuppressWarnings("unchecked")
    void readsFollowTheAdjustment() {
        Map<String, Object> before = (Map<String, Object>) ((Map<String, Object>) query.nav(PaperBooks.CLAUDE).get("book"))
                .get("stats");
        assertThat(before.get("cumReturnPct")).as("100,000 → 100,000").isEqualTo(0.0);

        admin.costBackfill("US", "비용 소급");

        Map<String, Object> navView = query.nav("bench_spy");
        List<Map<String, Object>> series = (List<Map<String, Object>>) navView.get("series");
        assertThat(series.get(0).get("nav")).isEqualTo(99_850.7);
        Map<String, Object> summary = (Map<String, Object>) navView.get("book");
        assertThat(summary.get("cash")).isEqualTo(350.7);
        // 통계는 순자산 줄에서 읽을 때 셈 — 99,999.00(금) → 99,989.60(화) = −0.0094% → −0.01
        Map<String, Object> after = (Map<String, Object>) ((Map<String, Object>) query.nav(PaperBooks.CLAUDE).get("book"))
                .get("stats");
        assertThat(after.get("cumReturnPct")).isEqualTo(-0.01);

        Map<String, Object> fills = query.fills(PaperBooks.CLAUDE, 50);
        Map<String, Object> total = (Map<String, Object>) fills.get("costAdjustmentTotal");
        assertThat(total).containsEntry("rows", 2).containsEntry("fee", 10.19).containsEntry("tax", 0.21)
                .containsEntry("cashDelta", -10.4);
        List<Map<String, Object>> rows = (List<Map<String, Object>>) fills.get("fills");
        Map<String, Object> sellRow = rows.stream().filter(r -> r.get("id").equals(claudeSell)).findFirst().orElseThrow();
        assertThat(sellRow.get("fee")).as("체결 행 비용 칸은 0 그대로").isEqualTo(0.0);
        Map<String, Object> adjustment = (Map<String, Object>) sellRow.get("costAdjustment");
        assertThat(adjustment).containsEntry("fee", 9.19).containsEntry("tax", 0.21).containsEntry("cashDelta", -9.4)
                .containsEntry("fillDate", "2026-10-26").containsEntry("settingsVersion", 1)
                .containsEntry("reason", "us-cost-backfill").containsEntry("note", "비용 소급 — 수량은 당시 그대로");
        Map<String, Object> newCostRow = rows.stream().filter(r -> r.get("id").equals(claudeNewCost)).findFirst()
                .orElseThrow();
        assertThat(newCostRow.get("fee")).isEqualTo(0.05);
        assertThat(newCostRow.get("costAdjustment")).isNull();
    }

    @Test
    @DisplayName("확인 글자('비용 소급')·시장(US)이 다르면 400 — 어느 경우도 아무것도 쓰지 않음")
    void rejectsWithoutWriting() {
        assertThatThrownBy(() -> admin.costBackfill("US", "비용소급")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("비용 소급");
        assertThatThrownBy(() -> admin.costBackfill("US", null)).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> admin.costBackfill("KR", "비용 소급")).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("미국");
        assertThatThrownBy(() -> admin.costBackfill(null, "비용 소급")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> admin.costBackfill("us", "비용 소급")).isInstanceOf(InvalidRequestException.class);
        assertThat(store.costAdjustments).isEmpty();
        assertThat(store.states.get(PaperBooks.CLAUDE).cash()).isEqualTo(50_000);
    }

    @Test
    @DisplayName("비율은 체결 때 유효했던 판 — 소급 전에 25bp로 저장해도 과거 체결은 그때 판, 비율 0인 판에서 낸 체결은 조정 행 없음(다시 돌려도), 이력보다 앞선 체결은 기본 비율(판 없음)")
    void usesRatesInForceAtEachFill() {
        // 판 3(10-28): 비율 모두 0 — 이 판에서 낸 매수는 0원이 맞음
        store.dbNow = Instant.parse("2026-10-28T12:00:00Z");
        ObjectNode zero = (ObjectNode) store.settings.body().deepCopy();
        zero.put("commissionBp", 0);
        ((ObjectNode) zero.get("regFees")).put("secPerMillion", 0).put("tafPerShare", 0).put("tafMaxPerTrade", 0);
        store.saveSettings(zero, List.of("commissionBp", "regFees.secPerMillion", "regFees.tafPerShare",
                "regFees.tafMaxPerTrade"));
        long zeroFill = fill(PaperBooks.CLAUDE, "DDD", "BUY", 5, 20.01, 100.05, TUE, BigDecimal.ZERO, BigDecimal.ZERO);
        // 이력(10-26 판 1)보다 앞선 체결 — 기본 비율, 판 번호 없음
        long early = fillAt("claude2", "EEE", "BUY", 10, 30.0, 300.0, FRI, BigDecimal.ZERO, BigDecimal.ZERO,
                Instant.parse("2026-10-20T12:00:00Z"));
        // 판 4(10-29): 수수료 25bp로 저장한 뒤 소급
        store.dbNow = Instant.parse("2026-10-29T12:00:00Z");
        ObjectNode high = zero.deepCopy();
        high.put("commissionBp", 25);
        ((ObjectNode) high.get("regFees")).put("secPerMillion", 20.6).put("tafPerShare", 0.000195).put("tafMaxPerTrade", 9.79);
        store.saveSettings(high, List.of("commissionBp", "regFees.secPerMillion", "regFees.tafPerShare",
                "regFees.tafMaxPerTrade"));

        UsCostBackfill.Result result = admin.costBackfill("US", "비용 소급");

        CostAdjustment sell = store.costAdjustments.get(claudeSell);
        assertThat(sell.fee()).as("판 1(기본 10bp) — 지금 판 25bp가 아님").isEqualByComparingTo("9.19");
        assertThat(sell.settingsVersion()).isEqualTo(1);
        assertThat(book(result, "claude")).isEqualTo(Map.of("fills", 2, "fee", "10.19", "tax", "0.21", "cashDelta", "-10.40"));
        assertThat(store.costAdjustments).as("비율 0인 판의 체결은 0원 — 조정 행을 남기지 않음").doesNotContainKey(zeroFill);
        assertThat(result.zeroCostFills()).isEqualTo(1);
        CostAdjustment before = store.costAdjustments.get(early);
        assertThat(before.settingsVersion()).as("이력 전 — 판 없음").isNull();
        assertThat(before.fee()).isEqualByComparingTo("0.30");
        assertThat(result.versions()).extracting(UsCostBackfill.VersionUsed::settingsVersion).containsExactly(null, 1);
        assertThat(result.versions()).extracting(UsCostBackfill.VersionUsed::fills).containsExactly(1, 5);

        UsCostBackfill.Result again = admin.costBackfill("US", "비용 소급");
        assertThat(store.costAdjustments).doesNotContainKey(zeroFill);
        assertThat(again.zeroCostFills()).as("다시 돌려도 0원이라 무해").isEqualTo(1);
        assertThat(again.versions()).isEmpty();
        assertThat(again.books()).allSatisfy(b -> assertThat(b.fills()).isZero());
    }

    @Test
    @DisplayName("계좌를 초기화(리셋)하면 그 계좌 체결과 함께 조정 행도 지워짐(외래키 CASCADE와 같음)")
    void resetDropsAdjustments() {
        admin.costBackfill("US", "비용 소급");
        assertThat(store.costAdjustments(PaperBooks.CLAUDE)).hasSize(2);
        store.resetBook(PaperBooks.CLAUDE);
        assertThat(store.costAdjustments(PaperBooks.CLAUDE)).isEmpty();
        assertThat(store.costAdjustments("bench_spy")).hasSize(1);
    }

    @Test
    @DisplayName("POST /api/paper/admin/cost-backfill — 응답 {ok, market, books:[{code, fills, fee, tax, cashDelta}], navRowsUpdated, versions:[{settingsVersion, rates, fills}], zeroCostFills}, 본문 없으면 400, 테이블이 없으면 available:false·ok:false")
    @SuppressWarnings("unchecked")
    void controllerRoute() {
        PaperController paper = new PaperController(query, admin, mock(PaperRiskJob.class),
                mock(PaperSelectionService.class), new PaperMarkets(store, PaperFixtures.quietReader()));

        Map<String, Object> out = paper.costBackfill(new PaperController.CostBackfillRequest("US", "비용 소급"));

        assertThat(out.keySet()).containsExactly("ok", "market", "books", "navRowsUpdated", "versions", "zeroCostFills");
        assertThat(out.get("ok")).isEqualTo(true);
        assertThat(out.get("market")).isEqualTo("US");
        List<Map<String, Object>> books = (List<Map<String, Object>>) out.get("books");
        assertThat(books.get(1)).isEqualTo(Map.of("code", "claude", "fills", 2, "fee", 10.19, "tax", 0.21,
                "cashDelta", -10.4));
        assertThat(books.get(1).keySet()).containsExactly("code", "fills", "fee", "tax", "cashDelta");
        assertThat(out.get("navRowsUpdated")).isEqualTo(5);
        List<Map<String, Object>> versions = (List<Map<String, Object>>) out.get("versions");
        assertThat(versions).hasSize(1);
        assertThat(versions.get(0).keySet()).containsExactly("settingsVersion", "rates", "fills");
        assertThat(versions.get(0).get("settingsVersion")).isEqualTo(1);
        assertThat(versions.get(0).get("fills")).isEqualTo(5);
        assertThat(((Map<String, Object>) versions.get(0).get("rates")).keySet()).containsExactly("commissionBp",
                "secPerMillion", "tafPerShare", "tafMaxPerTrade");
        assertThat(out.get("zeroCostFills")).isEqualTo(0);

        assertThatThrownBy(() -> paper.costBackfill(null)).isInstanceOf(InvalidRequestException.class);
        store.ready = false;
        Map<String, Object> notReady = paper.costBackfill(new PaperController.CostBackfillRequest("US", "비용 소급"));
        assertThat(notReady.get("available")).isEqualTo(false);
        assertThat(notReady.get("ok")).isEqualTo(false);
    }
}
