package com.macrodash.analytics;

import com.macrodash.Golden;
import com.macrodash.analytics.OrderValidator.Context;
import com.macrodash.analytics.OrderValidator.Limits;
import com.macrodash.analytics.OrderValidator.Proposed;
import com.macrodash.analytics.OrderValidator.Verdict;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * Claude 재량 책 주문의 하드 규칙(설계 §5-4). 순자산을 100,000달러로 두어 비중 1% = 1,000달러로 셀 수 있게 했고, 규칙마다 걸리는
 * 경우와 경계값(상한 정확히·500달러 정확히·합 100% 정확히)이 통과하는 경우를 함께 봅니다. 사유는 주문마다 하나라서, 여러 규칙에
 * 걸리는 주문으로 검사 순서도 따로 확인합니다.
 */
class OrderValidatorTest {

    private static final double NAV = 100_000;
    /** 설정 §4-4 기본값: 종목 10%, ETF 20%, 20종목, 500달러, 월 20건, 5거래일. */
    private static final Limits DEFAULT = new Limits(10, 20, 20, 500, 20, 5);
    private static final Set<String> ETFS = Set.of("XLK", "XLE", "XLF", "SHY", "GLD", "TLT");
    private static final Set<String> STOCKS = Set.of("AAPL", "MSFT", "NVDA", "META", "AMZN", "GOOGL", "AVGO", "JPM",
            "XOM", "LLY", "UNH", "COST");

    // ------------------------------------------------------------------ 만들기
    private static Proposed buy(String ticker, double targetWeightPct) {
        return new Proposed(ticker, OrderValidator.BUY, targetWeightPct, null, OrderValidator.NEXT_OBSERVATION);
    }

    /** 매수와 같은 시점(NEXT_OBSERVATION)의 매도 — 같은 관측치에 매도가 먼저 체결돼 매수의 자리를 만듭니다. */
    private static Proposed sell(String ticker, Double sellFraction) {
        return new Proposed(ticker, OrderValidator.SELL, null, sellFraction, OrderValidator.NEXT_OBSERVATION);
    }

    private static Proposed atClose(Proposed order) {
        return new Proposed(order.ticker(), order.side(), order.targetWeightPct(), order.sellFraction(),
                OrderValidator.NEXT_CLOSE);
    }

    /** 장부 상태 만들기 — 기본은 현금 100%, 보유 없음, SHY만 현금성. */
    private static final class Book {
        double cash = NAV;
        final Map<String, Double> weights = new LinkedHashMap<>();
        final Map<String, Integer> days = new LinkedHashMap<>();
        final Set<String> universe = new LinkedHashSet<>();
        final Set<String> locked = new LinkedHashSet<>();
        final Set<String> noPrice = new LinkedHashSet<>();
        /** 보유 수량(주) — 비면 수량을 모르는 것(1주 미만 매도 검사를 하지 않음). */
        final Map<String, Integer> qty = new LinkedHashMap<>();
        int monthly;
        boolean stale;

        Book() {
            universe.addAll(STOCKS);
            universe.addAll(ETFS);
        }

        Book hold(String ticker, double weightPct, Integer heldDays) {
            weights.put(ticker, weightPct);
            if (heldDays != null) {
                days.put(ticker, heldDays);
            }
            cash -= weightPct / 100.0 * NAV;
            return this;
        }

        Context context() {
            return new Context(NAV, cash, weights, days, universe, ETFS, Set.of("SHY"), locked, noPrice, monthly, stale,
                    qty);
        }
    }

    private static List<Verdict> runWith(Book book, Limits limits, Proposed... orders) {
        return OrderValidator.validate(Arrays.asList(orders), book.context(), limits);
    }

    private static List<Verdict> run(Book book, Proposed... orders) {
        return runWith(book, DEFAULT, orders);
    }

    private static void assertAccepted(Verdict verdict) {
        assertThat(verdict.accepted()).as(verdict.toString()).isTrue();
        assertThat(verdict.rejectReason()).isNull();
    }

    private static void assertRejected(Verdict verdict, String reason) {
        assertThat(verdict.accepted()).as(verdict.toString()).isFalse();
        assertThat(verdict.rejectReason()).as(verdict.toString()).isEqualTo(reason);
        assertThat(verdict.detail()).isNotBlank();
    }

    // ------------------------------------------------------------------ 규칙마다
    @Test
    @DisplayName("STALE_INPUT: 자료가 오래됐으면 매도·정상 매수·모양이 틀린 주문까지 전부 거절")
    void staleInputRejectsEverything() {
        Book book = new Book().hold("AAPL", 5, 30);
        book.stale = true;

        List<Verdict> verdicts = run(book, buy("MSFT", 5), sell("AAPL", null), null, buy("ZZZZ", 50));

        assertThat(verdicts).hasSize(4);
        verdicts.forEach(v -> assertRejected(v, OrderValidator.STALE_INPUT));
    }

    @Test
    @DisplayName("MALFORMED: 주문·티커·side·timing이 틀림, 매수 목표 없음·범위 밖, 매도 비율 범위 밖, 비율 없는 부분 매도")
    void malformed() {
        Book book = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30).hold("META", 5, 30)
                .hold("AMZN", 5, 30).hold("GOOGL", 5, 30);

        List<Verdict> verdicts = run(book,
                null,
                buy(null, 5),
                buy(" ", 5),
                new Proposed("JPM", "HOLD", 5.0, null, OrderValidator.NEXT_OBSERVATION),
                new Proposed("XOM", OrderValidator.BUY, 5.0, null, "IMMEDIATE"),
                new Proposed("LLY", OrderValidator.BUY, 5.0, null, null),
                new Proposed("UNH", OrderValidator.BUY, null, null, OrderValidator.NEXT_OBSERVATION),
                buy("COST", 100.5),
                buy("AVGO", Double.NaN),
                buy("XLK", -1),
                sell("AAPL", 0.0),
                sell("MSFT", 1.5),
                sell("NVDA", Double.NaN),
                new Proposed("META", OrderValidator.SELL, 2.0, null, OrderValidator.NEXT_CLOSE));

        verdicts.forEach(v -> assertRejected(v, OrderValidator.MALFORMED));
        assertThat(verdicts.get(0).order()).isNull();
        assertThat(verdicts.get(13).detail()).contains("전량");

        // 비율 없는 매도 = 전량(장부 규칙과 같음), 목표 0%만 준 매도도 같은 뜻이라 통과. 비율 1 정확히도 통과.
        List<Verdict> ok = run(book, sell("AMZN", null),
                new Proposed("GOOGL", OrderValidator.SELL, 0.0, null, OrderValidator.NEXT_OBSERVATION),
                sell("AAPL", 1.0));
        ok.forEach(OrderValidatorTest::assertAccepted);
        assertThat(ok.get(0).detail()).contains("전량 매도");
    }

    @Test
    @DisplayName("DUPLICATE_TICKER: 같은 티커는 첫 주문만 — 첫 주문이 거절돼도 뒤 주문은 중복")
    void duplicateTicker() {
        Book book = new Book().hold("AAPL", 5, 30);

        List<Verdict> verdicts = run(book, buy("MSFT", 5), buy("MSFT", 8), sell("MSFT", null),
                new Proposed("NVDA", OrderValidator.BUY, null, null, OrderValidator.NEXT_OBSERVATION), buy("NVDA", 5));

        assertAccepted(verdicts.get(0));
        assertRejected(verdicts.get(1), OrderValidator.DUPLICATE_TICKER);
        assertThat(verdicts.get(1).detail()).contains("1번째");
        assertRejected(verdicts.get(2), OrderValidator.DUPLICATE_TICKER);
        assertRejected(verdicts.get(3), OrderValidator.MALFORMED);
        assertRejected(verdicts.get(4), OrderValidator.DUPLICATE_TICKER);
    }

    @Test
    @DisplayName("OUT_OF_UNIVERSE: 유니버스 밖 매수·미보유 매도는 거절, 보유 중인 종목의 매도는 유니버스 밖이어도 통과")
    void outOfUniverse() {
        Book book = new Book().hold("OLD", 4, 30);   // 설정에서 유니버스가 줄어 빠진 보유

        List<Verdict> verdicts = run(book, buy("ZZZZ", 5), sell("YYYY", null), sell("OLD", null), buy("OLD", 6));

        assertRejected(verdicts.get(0), OrderValidator.OUT_OF_UNIVERSE);
        assertRejected(verdicts.get(1), OrderValidator.OUT_OF_UNIVERSE);
        assertAccepted(verdicts.get(2));
        assertRejected(verdicts.get(3), OrderValidator.DUPLICATE_TICKER);

        assertRejected(run(book, buy("OLD", 6)).get(0), OrderValidator.OUT_OF_UNIVERSE);
    }

    @Test
    @DisplayName("NOT_HELD: 보유하지 않은(또는 비중 0·null인) 종목의 매도")
    void notHeld() {
        Book book = new Book();
        book.weights.put("NVDA", 0.0);
        book.weights.put("META", null);

        List<Verdict> verdicts = run(book, sell("MSFT", null), sell("NVDA", 0.5), sell("META", null));

        verdicts.forEach(v -> assertRejected(v, OrderValidator.NOT_HELD));
    }

    @Test
    @DisplayName("LOCKED_OUT: 재진입 금지 중인 종목의 매수(가격 없음보다 먼저)")
    void lockedOut() {
        Book book = new Book();
        book.locked.add("NVDA");
        book.locked.add("META");
        book.noPrice.add("META");

        List<Verdict> verdicts = run(book, buy("NVDA", 5), buy("META", 5), buy("MSFT", 5));

        assertRejected(verdicts.get(0), OrderValidator.LOCKED_OUT);
        assertRejected(verdicts.get(1), OrderValidator.LOCKED_OUT);
        assertAccepted(verdicts.get(2));
    }

    @Test
    @DisplayName("NO_PRICE: 가격이 없거나 오래된 종목은 매수·매도 모두 거절")
    void noPrice() {
        Book book = new Book().hold("AAPL", 5, 30);
        book.noPrice.add("AAPL");
        book.noPrice.add("MSFT");

        List<Verdict> verdicts = run(book, sell("AAPL", null), buy("MSFT", 5), buy("NVDA", 5));

        assertRejected(verdicts.get(0), OrderValidator.NO_PRICE);
        assertRejected(verdicts.get(1), OrderValidator.NO_PRICE);
        assertAccepted(verdicts.get(2));
    }

    @Test
    @DisplayName("MIN_HOLD: 보유 5거래일 미만·보유일 모름은 거절, 5거래일 정확히는 통과, 현금성(SHY)은 보지 않음")
    void minHold() {
        Book book = new Book().hold("AAPL", 5, 4).hold("MSFT", 5, 5).hold("GOOGL", 5, null).hold("SHY", 30, 1);

        List<Verdict> verdicts = run(book, sell("AAPL", null), sell("MSFT", 0.5), sell("GOOGL", null),
                sell("SHY", null));

        assertRejected(verdicts.get(0), OrderValidator.MIN_HOLD);
        assertThat(verdicts.get(0).detail()).contains("4거래일").contains("5거래일");
        assertAccepted(verdicts.get(1));
        assertThat(verdicts.get(1).detail()).contains("50% 매도");
        assertRejected(verdicts.get(2), OrderValidator.MIN_HOLD);
        assertThat(verdicts.get(2).detail()).contains("알 수 없음");
        assertAccepted(verdicts.get(3));

        // 최소 보유일 0이면 검사하지 않음(보유일을 몰라도 통과).
        Limits noHold = new Limits(10, 20, 20, 500, 20, 0);
        assertAccepted(runWith(book, noHold, sell("GOOGL", null)).get(0));
    }

    @Test
    @DisplayName("WEIGHT_CAP: 종목 10%·ETF 20%까지(정확히 상한은 통과), 현금성은 상한 없음")
    void weightCap() {
        Book book = new Book();

        List<Verdict> verdicts = run(book, buy("AAPL", 10), buy("MSFT", 10.01), buy("XLK", 20), buy("XLE", 20.5),
                buy("SHY", 60));

        assertAccepted(verdicts.get(0));
        assertRejected(verdicts.get(1), OrderValidator.WEIGHT_CAP);
        assertThat(verdicts.get(1).detail()).contains("종목 상한 10.00%");
        assertAccepted(verdicts.get(2));
        assertRejected(verdicts.get(3), OrderValidator.WEIGHT_CAP);
        assertThat(verdicts.get(3).detail()).contains("ETF 상한 20.00%");
        assertAccepted(verdicts.get(4));
    }

    @Test
    @DisplayName("MIN_NOTIONAL: 증가분 금액 500달러 미만·목표가 현재 비중 이하는 거절, 정확히 500달러는 통과")
    void minNotional() {
        Book book = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30);

        List<Verdict> verdicts = run(book, buy("META", 0.4), buy("AMZN", 0.5), buy("AAPL", 4), buy("MSFT", 5.3),
                buy("NVDA", 5), buy("GOOGL", 0));

        assertRejected(verdicts.get(0), OrderValidator.MIN_NOTIONAL);
        assertThat(verdicts.get(0).detail()).contains("$400.00").contains("$500.00");
        assertAccepted(verdicts.get(1));
        assertRejected(verdicts.get(2), OrderValidator.MIN_NOTIONAL);
        assertThat(verdicts.get(2).detail()).contains("현재 비중 이하");
        assertRejected(verdicts.get(3), OrderValidator.MIN_NOTIONAL);   // +0.3%p = 300달러
        assertRejected(verdicts.get(4), OrderValidator.MIN_NOTIONAL);   // 목표 = 현재
        assertRejected(verdicts.get(5), OrderValidator.MIN_NOTIONAL);

        // 최소 금액 0(끔)이어도 살 금액이 0 이하인 매수는 거절 — 장부에 0주 주문을 넘기지 않음.
        Limits off = new Limits(10, 20, 20, 0, 20, 5);
        List<Verdict> withoutFloor = runWith(book, off, buy("NVDA", 5), buy("META", 0.01));
        assertRejected(withoutFloor.get(0), OrderValidator.MIN_NOTIONAL);
        assertAccepted(withoutFloor.get(1));
    }

    @Test
    @DisplayName("MONTHLY_CAP: 남은 자리만큼 매도 먼저·매수는 큰 비중 순으로 받고, 거절된 주문은 자리를 쓰지 않음")
    void monthlyCap() {
        Book book = new Book().hold("AAPL", 5, 30);
        book.monthly = 18;   // 상한 20 → 남은 자리 2

        List<Verdict> verdicts = run(book, buy("MSFT", 5), buy("NVDA", 8), sell("AAPL", null));

        assertRejected(verdicts.get(0), OrderValidator.MONTHLY_CAP);
        assertThat(verdicts.get(0).detail()).contains("20건");
        assertAccepted(verdicts.get(1));
        assertAccepted(verdicts.get(2));

        // 1단계에서 거절된 주문은 자리를 쓰지 않음.
        book.monthly = 19;
        List<Verdict> skipBad = run(book, buy("ZZZZ", 5), buy("MSFT", 5));
        assertRejected(skipBad.get(0), OrderValidator.OUT_OF_UNIVERSE);
        assertAccepted(skipBad.get(1));

        // 이미 상한이면 정상 주문도 전부 거절(매도 포함).
        book.monthly = 20;
        run(book, buy("MSFT", 5), sell("AAPL", null)).forEach(v -> assertRejected(v, OrderValidator.MONTHLY_CAP));
    }

    @Test
    @DisplayName("MAX_POSITIONS: 신규 종목만 셈 — 보유 종목 추가 매수·현금성은 세지 않고, 전량 매도는 자리를 비움")
    void maxPositions() {
        Limits three = new Limits(10, 20, 3, 500, 20, 5);
        Book book = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("SHY", 10, 30);

        List<Verdict> verdicts = runWith(book, three, buy("NVDA", 6), buy("META", 4), buy("AAPL", 8),
                buy("SHY", 20));

        assertAccepted(verdicts.get(0));
        assertRejected(verdicts.get(1), OrderValidator.MAX_POSITIONS);
        assertThat(verdicts.get(1).detail()).contains("4 > 상한 3");
        assertAccepted(verdicts.get(2));
        assertAccepted(verdicts.get(3));

        // 전량 매도는 자리를 비우고, 일부 매도는 비우지 않음.
        List<Verdict> fullSell = runWith(book, three, sell("MSFT", null), buy("NVDA", 6), buy("META", 4));
        fullSell.forEach(OrderValidatorTest::assertAccepted);
        List<Verdict> partialSell = runWith(book, three, sell("MSFT", 0.5), buy("NVDA", 6), buy("META", 4));
        assertAccepted(partialSell.get(0));
        assertAccepted(partialSell.get(1));
        assertRejected(partialSell.get(2), OrderValidator.MAX_POSITIONS);
    }

    @Test
    @DisplayName("MAX_POSITIONS: 확정 종가(NEXT_CLOSE) 전량 매도가 비울 자리는 다음 관측치(NEXT_OBSERVATION) 신규 매수가 쓸 수 없다 — 종가 매수는 쓸 수 있음")
    void maxPositionsIsTimingAware() {
        Book book = new Book();
        for (int i = 1; i <= 20; i++) {
            String ticker = String.format("T%02d", i);
            book.universe.add(ticker);
            book.hold(ticker, 4.5, 30);   // 20종목 × 4.5% = 90%, 현금 10%
        }
        book.universe.addAll(List.of("NEW", "NEW2", "NEW3"));

        // 매도는 확정 종가, 신규 매수는 다음 관측치 → 다음 세션 장중~마감에 21종목(비중은 90 + 5 ≤ 100이라 통과하는 경우).
        List<Verdict> mixed = run(book, atClose(sell("T01", null)), buy("NEW", 5));
        assertAccepted(mixed.get(0));
        assertRejected(mixed.get(1), OrderValidator.MAX_POSITIONS);
        assertThat(mixed.get(1).detail()).contains("NEXT_CLOSE").contains("1종목").contains("21 > 상한 20");

        // 같은 시점이거나 매도가 더 이르면 자리를 씁니다.
        run(book, atClose(sell("T01", null)), atClose(buy("NEW", 5))).forEach(OrderValidatorTest::assertAccepted);
        run(book, sell("T01", null), buy("NEW", 5)).forEach(OrderValidatorTest::assertAccepted);
        run(book, sell("T01", null), atClose(buy("NEW", 5))).forEach(OrderValidatorTest::assertAccepted);

        // 다음 관측치 매도 한 자리 + 종가 매도 한 자리: 즉시 신규 하나(그 시점 20종목)와 종가 신규 하나(마감 20종목)는 통과, 종가
        // 신규 하나 더는 마감 21종목이라 거절.
        List<Verdict> split = run(book, sell("T01", null), atClose(sell("T02", null)), buy("NEW", 3),
                atClose(buy("NEW2", 2)), atClose(buy("NEW3", 1)));
        assertAccepted(split.get(0));
        assertAccepted(split.get(1));
        assertAccepted(split.get(2));
        assertAccepted(split.get(3));
        assertRejected(split.get(4), OrderValidator.MAX_POSITIONS);
        assertThat(split.get(4).detail()).contains("21 > 상한 20");
    }

    @Test
    @DisplayName("BELOW_ONE_SHARE: 1 미만 비율인데 보유 수량 × 비율이 1주 미만이면 거절(장부가 전량으로 집행) — 정확히 1주·전량(1·null)·수량 모름은 통과")
    void belowOneShare() {
        Book book = new Book().hold("COST", 10, 30).hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30)
                .hold("META", 5, 30).hold("SHY", 10, 30);
        book.qty.put("COST", 15);
        book.qty.put("AAPL", 15);
        book.qty.put("MSFT", 15);
        book.qty.put("NVDA", 20);
        book.qty.put("SHY", 9);
        // META는 수량을 모름

        List<Verdict> verdicts = run(book, sell("COST", 0.05), sell("AAPL", 1.0), sell("MSFT", null),
                sell("NVDA", 0.05), sell("META", 0.05), sell("SHY", 0.1));

        assertRejected(verdicts.get(0), OrderValidator.BELOW_ONE_SHARE);
        assertThat(verdicts.get(0).detail()).contains("보유 15주의 0.05는 1주 미만").contains("sellFraction 1");
        assertAccepted(verdicts.get(1));
        assertAccepted(verdicts.get(2));
        assertAccepted(verdicts.get(3));   // 20 × 0.05 = 정확히 1주
        assertAccepted(verdicts.get(4));
        assertRejected(verdicts.get(5), OrderValidator.BELOW_ONE_SHARE);   // 현금성도 장부 규칙은 같음(9 × 0.1 = 0.9주)
        // 거절된 매도는 자리를 만들지 않습니다 — COST 10%를 판 것으로 세지 않음.
        assertThat(verdicts.get(0).accepted()).isFalse();
    }

    @Test
    @DisplayName("OVER_ALLOCATED: 남는 보유 80%에 매수 5·15·10 → 큰 것부터 15 통과, 10은 넘쳐 거절, 5는 남은 자리에 통과")
    void overAllocatedBiggestFirst() {
        Book book = new Book().hold("AAPL", 40, 30).hold("MSFT", 40, 30);

        List<Verdict> verdicts = run(book, buy("NVDA", 5), buy("XLK", 15), buy("META", 10));

        assertAccepted(verdicts.get(0));
        assertAccepted(verdicts.get(1));
        assertRejected(verdicts.get(2), OrderValidator.OVER_ALLOCATED);
        assertThat(verdicts.get(2).detail()).contains("80.00%").contains("15.00%p").contains("105.00%");
    }

    @Test
    @DisplayName("OVER_ALLOCATED: 같은 비중이면 목록 순, 통과한 매도만 자리를 만든다(최소 보유일로 막힌 매도는 못 만듦)")
    void overAllocatedUsesAcceptedSells() {
        Book book = new Book().hold("AAPL", 50, 30).hold("MSFT", 50, 2);

        // AAPL 절반 매도 → 남는 보유 75% → XLK 20(95%)·NVDA 5(100% 정확히) 통과, META 1은 101%.
        List<Verdict> verdicts = run(book, sell("AAPL", 0.5), buy("META", 1), buy("XLK", 20), buy("NVDA", 5));
        assertAccepted(verdicts.get(0));
        assertRejected(verdicts.get(1), OrderValidator.OVER_ALLOCATED);
        assertAccepted(verdicts.get(2));
        assertAccepted(verdicts.get(3));

        // MSFT 매도가 MIN_HOLD로 막히면 자리가 없어 매수도 거절.
        List<Verdict> blocked = run(book, sell("MSFT", null), buy("XLK", 20));
        assertRejected(blocked.get(0), OrderValidator.MIN_HOLD);
        assertRejected(blocked.get(1), OrderValidator.OVER_ALLOCATED);

        // 같은 목표 비중 둘이 마지막 자리를 다투면 목록에서 앞선 것.
        Book tight = new Book().hold("AAPL", 95, 30);
        List<Verdict> tie = run(tight, buy("NVDA", 5), buy("META", 5));
        assertAccepted(tie.get(0));
        assertRejected(tie.get(1), OrderValidator.OVER_ALLOCATED);
    }

    @Test
    @DisplayName("OVER_ALLOCATED: 확정 종가(NEXT_CLOSE) 매도는 다음 관측치(NEXT_OBSERVATION) 매수보다 늦게 체결돼 그 매수의 자리를 만들지 못한다")
    void lateSellDoesNotFundEarlyBuy() {
        // 다 투자된 책(현금 2%) — AAPL 20% 전량 매도로 NVDA 10%를 사려 함.
        Book book = new Book().hold("AAPL", 20, 30).hold("MSFT", 40, 30).hold("XLK", 38, 30);

        // 매도는 확정 종가, 매수는 다음 관측치 → 장부에서 매수가 먼저 체결돼 현금 2%로 10%를 사려다 줄어듦(cashLimited) — 거절.
        List<Verdict> mixed = run(book, atClose(sell("AAPL", null)), buy("NVDA", 10));
        assertAccepted(mixed.get(0));
        assertRejected(mixed.get(1), OrderValidator.OVER_ALLOCATED);
        assertThat(mixed.get(1).detail()).contains("NEXT_CLOSE").contains("20.00%p").contains("98.00%")
                .contains("108.00%");

        // 같은 시점이면(둘 다 확정 종가 · 둘 다 다음 관측치) 같은 관측치에서 매도가 먼저라 통과.
        run(book, atClose(sell("AAPL", null)), atClose(buy("NVDA", 10))).forEach(OrderValidatorTest::assertAccepted);
        run(book, sell("AAPL", null), buy("NVDA", 10)).forEach(OrderValidatorTest::assertAccepted);
        // 매도가 더 이르면(다음 관측치 매도 → 확정 종가 매수) 통과.
        run(book, sell("AAPL", null), atClose(buy("NVDA", 10))).forEach(OrderValidatorTest::assertAccepted);

        // 다음 관측치 매수는 그때의 현금(2%)만 쓰고, 확정 종가 매수는 늦은 매도의 자리(20%)까지 씁니다: 종가 META 5·AMZN 5,
        // 즉시 NVDA 2(그 시점 100% 정확히) 통과, 즉시 GOOGL 1은 종가 기준 합(91%)은 남지만 그 시점 101%라 거절.
        List<Verdict> split = run(book, atClose(sell("AAPL", null)), buy("NVDA", 2), buy("GOOGL", 1),
                atClose(buy("META", 5)), atClose(buy("AMZN", 5)));
        assertAccepted(split.get(0));
        assertAccepted(split.get(1));
        assertRejected(split.get(2), OrderValidator.OVER_ALLOCATED);
        assertThat(split.get(2).detail()).contains("앞서 받은 다음 관측치 매수 2.00%p").contains("101.00%");
        assertAccepted(split.get(3));
        assertAccepted(split.get(4));
    }

    @Test
    @DisplayName("보유 종목 추가 매수는 증가분만 100%에 더한다 — 8%→10%면 +2%p")
    void heldBuyAddsOnlyIncrement() {
        Book book = new Book().hold("AAPL", 8, 30).hold("SHY", 90, 30);

        List<Verdict> verdicts = run(book, buy("AAPL", 10));

        assertAccepted(verdicts.get(0));
        assertThat(verdicts.get(0).detail()).contains("현재 8.00% → 목표 10.00%").contains("+2.00%p").contains("$2,000");
        assertThat(OrderValidator.buyIncrementPct(buy("AAPL", 10), book.context())).isCloseTo(2.0, within(1e-9));
        assertThat(OrderValidator.buyIncrementPct(buy("NVDA", 7), book.context())).isCloseTo(7.0, within(1e-9));
        assertThatThrownBy(() -> OrderValidator.buyIncrementPct(sell("AAPL", null), book.context()))
                .isInstanceOf(IllegalArgumentException.class);

        // 다른 보유가 0.5%p 더 많으면 같은 +2%p가 100.5%라 거절.
        Book fuller = new Book().hold("AAPL", 8, 30).hold("SHY", 90.5, 30);
        assertRejected(run(fuller, buy("AAPL", 10)).get(0), OrderValidator.OVER_ALLOCATED);
    }

    // ------------------------------------------------------------------ 현금 비중은 검사하지 않음(D7)
    @Test
    @DisplayName("노출 0%(전부 매도)와 100%(현금 전부로 매수, 합 정확히 100%) 모두 통과 — 현금 비중은 거절 사유가 아님")
    void exposureZeroAndHundredBothPass() {
        Book invested = new Book().hold("AAPL", 10, 30).hold("MSFT", 10, 30).hold("XLK", 20, 30).hold("XLE", 20, 30)
                .hold("NVDA", 10, 30).hold("META", 10, 30).hold("GLD", 20, 30);
        List<Verdict> toZero = run(invested, sell("AAPL", null), sell("MSFT", null), sell("XLK", null),
                sell("XLE", null), sell("NVDA", null), sell("META", null), sell("GLD", null));
        toZero.forEach(OrderValidatorTest::assertAccepted);

        Book allCash = new Book();
        List<Proposed> orders = new ArrayList<>();
        for (String ticker : List.of("AAPL", "MSFT", "NVDA", "META", "AMZN", "GOOGL", "AVGO", "JPM", "XOM", "LLY")) {
            orders.add(buy(ticker, 10));
        }
        List<Verdict> toHundred = OrderValidator.validate(orders, allCash.context(), DEFAULT);
        assertThat(toHundred).hasSize(10);
        toHundred.forEach(OrderValidatorTest::assertAccepted);

        // 끝자리 잡음: 8.2%씩 열 보유의 합은 double로 82.00000000000001이라 나머지 18을 사면 100.00000000000001 —
        // 정확히 100%를 채운 주문이 잡음으로 거절되지 않아야 함.
        Book noisy = new Book();
        for (int i = 0; i < 10; i++) {
            noisy.hold("N" + i, 8.2, 30);
        }
        noisy.universe.add("NX");
        double rest = 100.0 - 10 * 8.2;
        assertAccepted(runWith(noisy, new Limits(20, 20, 20, 500, 20, 5), buy("NX", rest)).get(0));
    }

    // ------------------------------------------------------------------ 순서·결정성
    @Test
    @DisplayName("여러 규칙에 걸리면 정해진 순서의 첫 사유 하나만")
    void oneReasonInFixedOrder() {
        Book book = new Book().hold("AAPL", 11.9, 30);
        book.locked.add("ZZZZ");
        book.noPrice.add("ZZZZ");
        book.locked.add("NVDA");
        book.noPrice.add("NVDA");
        book.noPrice.add("META");

        List<Verdict> verdicts = run(book,
                new Proposed("ZZZZ", OrderValidator.BUY, 150.0, null, OrderValidator.NEXT_OBSERVATION),
                buy("ZZZZ", 50),   // 모양은 맞지만 중복이 유니버스보다 먼저
                buy("NVDA", 50),   // 재진입 금지 > 가격 없음 > 상한
                buy("META", 50),   // 가격 없음 > 상한
                buy("AAPL", 12));  // 상한(12 > 10) > 최소 금액(+0.1%p)

        assertRejected(verdicts.get(0), OrderValidator.MALFORMED);
        assertRejected(verdicts.get(1), OrderValidator.DUPLICATE_TICKER);
        assertRejected(verdicts.get(2), OrderValidator.LOCKED_OUT);
        assertRejected(verdicts.get(3), OrderValidator.NO_PRICE);
        assertRejected(verdicts.get(4), OrderValidator.WEIGHT_CAP);
    }

    @Test
    @DisplayName("같은 입력이면 같은 결과 — 맵·집합의 넣은 순서가 달라도, 두 번 불러도")
    void deterministic() {
        List<Proposed> orders = List.of(sell("AAPL", 0.5), buy("NVDA", 7), buy("XLK", 15), buy("META", 7),
                buy("MSFT", 3), buy("ZZZZ", 5), buy("GOOGL", 9));
        Map<String, Double> weights = new LinkedHashMap<>();
        weights.put("AAPL", 30.3);
        weights.put("MSFT", 20.2);
        weights.put("XLE", 10.1);
        weights.put("SHY", 9.9);
        Map<String, Integer> days = Map.of("AAPL", 10, "MSFT", 3, "XLE", 40, "SHY", 1);
        Set<String> universe = new LinkedHashSet<>(STOCKS);
        universe.addAll(ETFS);

        Context first = new Context(NAV, 29_500, weights, days, universe, ETFS, Set.of("SHY"), Set.of(), Set.of(), 3,
                false);
        Map<String, Double> reversed = new HashMap<>();
        List<String> keys = new ArrayList<>(weights.keySet());
        Collections.reverse(keys);
        keys.forEach(k -> reversed.put(k, weights.get(k)));
        Context second = new Context(NAV, 29_500, reversed, new HashMap<>(days), new HashSet<>(universe),
                new HashSet<>(ETFS), new HashSet<>(Set.of("SHY")), new HashSet<>(), new HashSet<>(), 3, false);

        List<Verdict> a = OrderValidator.validate(orders, first, DEFAULT);
        List<Verdict> b = OrderValidator.validate(orders, first, DEFAULT);
        List<Verdict> c = OrderValidator.validate(orders, second, DEFAULT);

        assertThat(b).isEqualTo(a);
        assertThat(c).isEqualTo(a);
        // 결과는 입력과 같은 순서·같은 주문.
        assertThat(a).extracting(Verdict::order).containsExactlyElementsOf(orders);
        // 손 계산: 남는 보유 = 15.15 + 20.2 + 10.1 + 9.9 = 55.35 → XLK 15(70.35), GOOGL 9(79.35), NVDA 7(86.35),
        // META 7(93.35). MSFT는 현재 20.2 > 목표 3이라 MIN_NOTIONAL, ZZZZ는 유니버스 밖.
        assertThat(a).extracting(Verdict::rejectReason).containsExactly(null, null, null, null,
                OrderValidator.MIN_NOTIONAL, OrderValidator.OUT_OF_UNIVERSE, null);
    }

    @Test
    @DisplayName("문맥은 복사해 둔다 — 만든 뒤 원본 집합을 고쳐도 결과가 바뀌지 않음")
    void contextIsCopied() {
        Set<String> locked = new HashSet<>();
        Context ctx = new Context(NAV, NAV, Map.of(), Map.of(), new HashSet<>(STOCKS), ETFS, Set.of("SHY"), locked,
                Set.of(), 0, false);
        locked.add("NVDA");

        assertAccepted(OrderValidator.validate(List.of(buy("NVDA", 5)), ctx, DEFAULT).get(0));
    }

    @Test
    @DisplayName("한도·문맥이 틀리면 막고, 주문이 없으면 빈 결과")
    void invalidArguments() {
        assertThatThrownBy(() -> new Limits(0, 20, 20, 500, 20, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 120, 20, 500, 20, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 20, 0, 500, 20, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 20, 20, -1, 20, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 20, 20, Double.NaN, 20, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 20, 20, 500, -1, 5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Limits(10, 20, 20, 500, 20, -1)).isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> new Context(0, 0, null, null, Set.of(), null, null, null, null, 0, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Context(NAV, NAV, null, null, null, null, null, null, null, 0, false))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Context(NAV, NAV, null, null, Set.of(), null, null, null, null, -1, false))
                .isInstanceOf(IllegalArgumentException.class);

        Context ctx = new Context(NAV, NAV, null, null, Set.of("AAPL"), null, null, null, null, 0, false);
        assertThatThrownBy(() -> OrderValidator.validate(List.of(), null, DEFAULT))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> OrderValidator.validate(List.of(), ctx, null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(OrderValidator.validate(null, ctx, DEFAULT)).isEmpty();
        assertThat(OrderValidator.validate(List.of(), ctx, DEFAULT)).isEmpty();
        // null 집합·맵은 비어 있는 것과 같음.
        assertAccepted(OrderValidator.validate(List.of(buy("AAPL", 5)), ctx, DEFAULT).get(0));
    }

    // ------------------------------------------------------------------ 고정본(2단계 묶음 A 기준선)
    @Test
    @DisplayName("고정본(묶음 A 기준선): 대표 장면마다 미국 검증기의 통과·거절 사유·근거 문구('$' 금액·시점 이름)·매수 증가분이 바이트까지 같다")
    void goldenOutcomes() {
        StringBuilder out = new StringBuilder();

        Book stale = new Book().hold("AAPL", 5, 30);
        stale.stale = true;
        golden(out, "STALE_INPUT — 전부 거절", stale, DEFAULT, buy("MSFT", 5), sell("AAPL", null), null);

        Book six = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30).hold("META", 5, 30)
                .hold("AMZN", 5, 30).hold("GOOGL", 5, 30);
        golden(out, "MALFORMED — 모양", six, DEFAULT, null, buy(null, 5), buy(" ", 5),
                new Proposed("JPM", "HOLD", 5.0, null, OrderValidator.NEXT_OBSERVATION),
                new Proposed("XOM", OrderValidator.BUY, 5.0, null, "IMMEDIATE"),
                new Proposed("LLY", OrderValidator.BUY, 5.0, null, null),
                new Proposed("UNH", OrderValidator.BUY, null, null, OrderValidator.NEXT_OBSERVATION),
                buy("COST", 100.5), buy("AVGO", Double.NaN), buy("XLK", -1), sell("AAPL", 0.0), sell("MSFT", 1.5),
                sell("NVDA", Double.NaN),
                new Proposed("META", OrderValidator.SELL, 2.0, null, OrderValidator.NEXT_CLOSE));
        golden(out, "MALFORMED 아님 — 전량·목표 0% 매도·비율 1", six, DEFAULT, sell("AMZN", null),
                new Proposed("GOOGL", OrderValidator.SELL, 0.0, null, OrderValidator.NEXT_OBSERVATION),
                sell("AAPL", 1.0));

        golden(out, "DUPLICATE_TICKER", new Book().hold("AAPL", 5, 30), DEFAULT, buy("MSFT", 5), buy("MSFT", 8),
                sell("MSFT", null),
                new Proposed("NVDA", OrderValidator.BUY, null, null, OrderValidator.NEXT_OBSERVATION), buy("NVDA", 5));

        Book outside = new Book().hold("OLD", 4, 30);
        outside.weights.put("NVDA", 0.0);
        outside.weights.put("META", null);
        golden(out, "OUT_OF_UNIVERSE·NOT_HELD", outside, DEFAULT, buy("ZZZZ", 5), sell("YYYY", null),
                sell("OLD", null), sell("NVDA", 0.5), sell("META", null));

        Book blocked = new Book().hold("AAPL", 5, 30);
        blocked.locked.add("NVDA");
        blocked.locked.add("META");
        blocked.noPrice.add("META");
        blocked.noPrice.add("AAPL");
        blocked.noPrice.add("MSFT");
        golden(out, "LOCKED_OUT·NO_PRICE", blocked, DEFAULT, buy("NVDA", 5), buy("META", 5), sell("AAPL", null),
                buy("MSFT", 5), buy("AMZN", 5));

        Book held = new Book().hold("AAPL", 5, 4).hold("MSFT", 5, 5).hold("GOOGL", 5, null).hold("SHY", 30, 1);
        golden(out, "MIN_HOLD — 5거래일·모름·현금성", held, DEFAULT, sell("AAPL", null), sell("MSFT", 0.5),
                sell("GOOGL", null), sell("SHY", null));
        golden(out, "MIN_HOLD 끔(0)", held, new Limits(10, 20, 20, 500, 20, 0), sell("GOOGL", null));

        golden(out, "WEIGHT_CAP — 종목 10%·ETF 20%·현금성", new Book(), DEFAULT, buy("AAPL", 10), buy("MSFT", 10.01),
                buy("XLK", 20), buy("XLE", 20.5), buy("SHY", 60));

        Book three = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30);
        golden(out, "MIN_NOTIONAL — $500", three, DEFAULT, buy("META", 0.4), buy("AMZN", 0.5), buy("AAPL", 4),
                buy("MSFT", 5.3), buy("NVDA", 5), buy("GOOGL", 0));
        golden(out, "MIN_NOTIONAL 끔(0)", three, new Limits(10, 20, 20, 0, 20, 5), buy("NVDA", 5), buy("META", 0.01));

        Book monthly = new Book().hold("AAPL", 5, 30);
        monthly.monthly = 18;
        golden(out, "MONTHLY_CAP — 남은 자리 2", monthly, DEFAULT, buy("MSFT", 5), buy("NVDA", 8), sell("AAPL", null),
                buy("ZZZZ", 5));
        monthly.monthly = 20;
        golden(out, "MONTHLY_CAP — 상한", monthly, DEFAULT, buy("MSFT", 5), sell("AAPL", null));

        Limits threeMax = new Limits(10, 20, 3, 500, 20, 5);
        Book positions = new Book().hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("SHY", 10, 30);
        golden(out, "MAX_POSITIONS — 상한 3", positions, threeMax, buy("NVDA", 6), buy("META", 4), buy("AAPL", 8),
                buy("SHY", 20));
        golden(out, "MAX_POSITIONS — 일부 매도는 자리를 비우지 않음", positions, threeMax, sell("MSFT", 0.5),
                buy("NVDA", 6), buy("META", 4));
        Book full = new Book();
        for (int i = 1; i <= 20; i++) {
            String ticker = String.format("T%02d", i);
            full.universe.add(ticker);
            full.hold(ticker, 4.5, 30);
        }
        full.universe.addAll(List.of("NEW", "NEW2", "NEW3"));
        golden(out, "MAX_POSITIONS — 시점(NEXT_OBSERVATION·NEXT_CLOSE)", full, DEFAULT, sell("T01", null),
                atClose(sell("T02", null)), buy("NEW", 3), atClose(buy("NEW2", 2)), atClose(buy("NEW3", 1)));

        Book shares = new Book().hold("COST", 10, 30).hold("AAPL", 5, 30).hold("MSFT", 5, 30).hold("NVDA", 5, 30)
                .hold("META", 5, 30).hold("SHY", 10, 30);
        shares.qty.put("COST", 15);
        shares.qty.put("AAPL", 15);
        shares.qty.put("MSFT", 15);
        shares.qty.put("NVDA", 20);
        shares.qty.put("SHY", 9);
        golden(out, "BELOW_ONE_SHARE", shares, DEFAULT, sell("COST", 0.05), sell("AAPL", 1.0), sell("MSFT", null),
                sell("NVDA", 0.05), sell("META", 0.05), sell("SHY", 0.1));

        golden(out, "OVER_ALLOCATED — 큰 비중부터", new Book().hold("AAPL", 40, 30).hold("MSFT", 40, 30), DEFAULT,
                buy("NVDA", 5), buy("XLK", 15), buy("META", 10));
        golden(out, "OVER_ALLOCATED — 통과한 매도만 자리", new Book().hold("AAPL", 50, 30).hold("MSFT", 50, 2), DEFAULT,
                sell("AAPL", 0.5), buy("META", 1), buy("XLK", 20), buy("NVDA", 5), sell("MSFT", null));
        golden(out, "OVER_ALLOCATED — 늦은 매도(NEXT_CLOSE)", new Book().hold("AAPL", 20, 30).hold("MSFT", 40, 30)
                        .hold("XLK", 38, 30), DEFAULT, atClose(sell("AAPL", null)), buy("NVDA", 2), buy("GOOGL", 1),
                atClose(buy("META", 5)), atClose(buy("AMZN", 5)));

        golden(out, "보유 추가 매수 — 증가분", new Book().hold("AAPL", 8, 30).hold("SHY", 90, 30), DEFAULT,
                buy("AAPL", 10));

        Book reasons = new Book().hold("AAPL", 11.9, 30);
        reasons.locked.add("ZZZZ");
        reasons.noPrice.add("ZZZZ");
        reasons.locked.add("NVDA");
        reasons.noPrice.add("NVDA");
        reasons.noPrice.add("META");
        golden(out, "여러 규칙 — 첫 사유 하나", reasons, DEFAULT,
                new Proposed("ZZZZ", OrderValidator.BUY, 150.0, null, OrderValidator.NEXT_OBSERVATION),
                buy("ZZZZ", 50), buy("NVDA", 50), buy("META", 50), buy("AAPL", 12));

        Map<String, Double> weights = new LinkedHashMap<>();
        weights.put("AAPL", 30.3);
        weights.put("MSFT", 20.2);
        weights.put("XLE", 10.1);
        weights.put("SHY", 9.9);
        Set<String> universe = new LinkedHashSet<>(STOCKS);
        universe.addAll(ETFS);
        golden(out, "혼합 — 현금 29,500·이달 3건", new Context(NAV, 29_500, weights,
                        Map.of("AAPL", 10, "MSFT", 3, "XLE", 40, "SHY", 1), universe, ETFS, Set.of("SHY"), Set.of(),
                        Set.of(), 3, false), DEFAULT,
                List.of(sell("AAPL", 0.5), buy("NVDA", 7), buy("XLK", 15), buy("META", 7), buy("MSFT", 3),
                        buy("ZZZZ", 5), buy("GOOGL", 9)));

        Golden.assertMatches("order-validator-us.txt", out.toString().stripTrailing());
    }

    // ------------------------------------------------------------------ 한국 칸(2단계 명세 §4-7·사용자 결정 v2, E2a)
    /** 한국 1억 원 — 비중 1% = 1,000,000원. */
    private static final double KR_NAV = 100_000_000;
    /** 한국 기본 한도 — 미국과 같은 비율·값, 최소 주문 500,000원. */
    private static final Limits KR_LIMITS = new Limits(10, 20, 20, 500_000, 20, 5);
    /** 한국 시장 — 체결 시점 NEXT_OPEN뿐(ALLOW_NEXT_CLOSE=false), 원 표기(소수 없음). */
    private static final OrderValidator.Market KR_MARKET = new OrderValidator.Market(List.of("NEXT_OPEN"), "NEXT_OPEN",
            Map.of("NEXT_OPEN", "다음 거래일 시가"), new OrderValidator.Money("", "원", 0));
    /** 한국 기본 요율 — 수수료 1.5bp·슬리피지 5bp(설정 kr.commissionBp·kr.slippageBp 기본값). */
    private static final KrxCosts.Rates KR_RATES = new KrxCosts.Rates(new java.math.BigDecimal("1.5"),
            java.math.BigDecimal.valueOf(5), KrxCosts.TaxRates.KRX_2026);

    private static Proposed krBuy(String code, double targetWeightPct) {
        return new Proposed(code, OrderValidator.BUY, targetWeightPct, null, "NEXT_OPEN");
    }

    private static Proposed krSell(String code, Double sellFraction) {
        return new Proposed(code, OrderValidator.SELL, null, sellFraction, "NEXT_OPEN");
    }

    /** 한국 장부 — 현금 1억, U 셋 + ETF 둘(153130 현금성), 기준 가격은 종목마다. */
    private static final class KrBook {
        double cash = KR_NAV;
        final Map<String, Double> weights = new LinkedHashMap<>();
        final Map<String, Integer> days = new LinkedHashMap<>();
        final Map<String, Integer> qty = new LinkedHashMap<>();
        final Set<String> universe = new LinkedHashSet<>(List.of("005930", "000660", "207940", "069500", "153130"));
        final Set<String> locked = new LinkedHashSet<>();
        final Set<String> noPrice = new LinkedHashSet<>();
        final Map<String, String> unfillable = new LinkedHashMap<>();
        final Map<String, java.math.BigDecimal> prices = new LinkedHashMap<>(Map.of(
                "005930", java.math.BigDecimal.valueOf(49_950), "000660", java.math.BigDecimal.valueOf(180_000),
                "207940", java.math.BigDecimal.valueOf(1_200_000), "069500", java.math.BigDecimal.valueOf(95_000),
                "153130", java.math.BigDecimal.valueOf(108_000)));
        boolean wholeShares = true;
        int monthly;

        KrBook hold(String code, double weightPct, int heldDays, int shares) {
            weights.put(code, weightPct);
            days.put(code, heldDays);
            qty.put(code, shares);
            cash -= weightPct / 100.0 * KR_NAV;
            return this;
        }

        Context context() {
            return new Context(KR_NAV, cash, weights, days, universe, Set.of("069500", "153130"), Set.of("153130"),
                    locked, noPrice, monthly, false, qty, unfillable,
                    wholeShares ? new OrderValidator.WholeShares(prices, KR_RATES) : null);
        }
    }

    private static List<Verdict> runKr(KrBook book, Limits limits, Proposed... orders) {
        return OrderValidator.validate(Arrays.asList(orders), book.context(), limits, KR_MARKET);
    }

    @Test
    @DisplayName("BUY_BELOW_ONE_SHARE(한국): 최소 금액은 넘어도 1주 체결 금액(가격 + 수수료·슬리피지)보다 작은 증가분은 거절 — 손계산 1,200,000원 → 1,200,780원")
    void krBuyBelowOneShare() {
        KrBook book = new KrBook();

        List<Verdict> verdicts = runKr(book, KR_LIMITS, krBuy("207940", 0.6), krBuy("207940", 1.2007),
                krBuy("000660", 0.6));

        assertRejected(verdicts.get(0), OrderValidator.BUY_BELOW_ONE_SHARE);
        assertThat(verdicts.get(0).detail()).isEqualTo("매수 증가분 약 600,000원 < 1주 체결 금액 1,200,780원(기준 가격 "
                + "1,200,000원 + 수수료·슬리피지) — 정수 주라 1주도 살 수 없음(현재 0.00% → 목표 0.60%)");
        assertRejected(verdicts.get(1), OrderValidator.DUPLICATE_TICKER);
        assertAccepted(verdicts.get(2));
        assertThat(KrxCosts.oneShareOutflow(java.math.BigDecimal.valueOf(1_200_000), KR_RATES))
                .isEqualByComparingTo("1200780");   // 수수료 180 + 슬리피지 600

        assertRejected(runKr(book, KR_LIMITS, krBuy("207940", 1.2007)).get(0), OrderValidator.BUY_BELOW_ONE_SHARE);
        assertAccepted(runKr(book, KR_LIMITS, krBuy("207940", 1.2008)).get(0));   // 1,200,800 ≥ 1,200,780
    }

    @Test
    @DisplayName("BUY_BELOW_ONE_SHARE(한국): 장부와 같은 절사 규칙 — 49,950원 1주 = 49,981원(수수료 7·슬리피지 24), 절사 전 49,982.47원보다 작아도 1주는 산다")
    void krBuyBelowOneShareUsesLedgerTruncation() {
        KrBook book = new KrBook();
        Limits noMinimum = new Limits(10, 20, 20, 0, 20, 5);

        assertRejected(runKr(book, noMinimum, krBuy("005930", 0.04998)).get(0), OrderValidator.BUY_BELOW_ONE_SHARE);
        assertAccepted(runKr(book, noMinimum, krBuy("005930", 0.049982)).get(0));   // 약 49,982원 ≥ 49,981
        assertAccepted(runKr(book, noMinimum, krBuy("005930", 0.04999)).get(0));
        assertThat(KrxCosts.oneShareOutflow(java.math.BigDecimal.valueOf(49_950), KR_RATES)).isEqualByComparingTo("49981");
        assertThat(KrxCosts.affordableQty(java.math.BigDecimal.valueOf(49_981), java.math.BigDecimal.valueOf(49_950),
                KR_RATES)).isEqualTo(1);
        assertThat(KrxCosts.affordableQty(java.math.BigDecimal.valueOf(49_980), java.math.BigDecimal.valueOf(49_950),
                KR_RATES)).isZero();
    }

    @Test
    @DisplayName("BUY_BELOW_ONE_SHARE(한국): 최소 금액(MIN_NOTIONAL)이 먼저, 거절된 매수는 월 상한 자리를 쓰지 않음, 이미 보유한 종목은 증가분으로 셈")
    void krBuyBelowOneShareOrderAndSlots() {
        KrBook book = new KrBook().hold("207940", 1.0, 30, 1);
        book.monthly = 19;

        List<Verdict> verdicts = runKr(book, KR_LIMITS, krBuy("000660", 0.4), krBuy("207940", 2.1),
                krBuy("005930", 2));

        assertRejected(verdicts.get(0), OrderValidator.MIN_NOTIONAL);
        assertRejected(verdicts.get(1), OrderValidator.BUY_BELOW_ONE_SHARE);   // 증가분 1.1% = 1,100,000 < 1,200,780
        assertThat(verdicts.get(1).detail()).contains("현재 1.00% → 목표 2.10%");
        assertAccepted(verdicts.get(2));   // 남은 월 자리 1을 거절된 주문이 쓰지 않음
    }

    @Test
    @DisplayName("UNFILLABLE(한국, 사용자 결정 v2): 지금 체결할 수 없는 종목의 매수는 사유와 함께 거절, 그 종목 보유의 매도는 받음 — 검사 순서는 유니버스·재진입 금지 뒤, 가격 없음 앞")
    void krUnfillableRejectsBuysOnly() {
        KrBook book = new KrBook().hold("000660", 5, 30, 27);
        book.unfillable.put("000660", "2026-11-03 거래정지(KRX 매매정지 또는 그날 거래량 0)");
        book.unfillable.put("005930", "이번 관측치에 그 종목 봉이 없음");
        book.unfillable.put("999999", "이번 관측치에 그 종목 봉이 없음");
        book.locked.add("207940");
        book.unfillable.put("207940", "미처리 기업행위 보유(분할 확인 필요) — 장부가 그 종목 주문을 보류");
        book.noPrice.add("005930");

        List<Verdict> verdicts = runKr(book, KR_LIMITS, krBuy("005930", 3), krSell("000660", null),
                krBuy("999999", 3), krBuy("207940", 3), krBuy("069500", 10));

        assertRejected(verdicts.get(0), OrderValidator.UNFILLABLE);
        assertThat(verdicts.get(0).detail()).isEqualTo("지금 체결할 수 없는 종목 — 이번 관측치에 그 종목 봉이 없음 · 매수만 거절(보유 매도는 받음)");
        assertAccepted(verdicts.get(1));
        assertRejected(verdicts.get(2), OrderValidator.OUT_OF_UNIVERSE);
        assertRejected(verdicts.get(3), OrderValidator.LOCKED_OUT);
        assertAccepted(verdicts.get(4));

        KrBook staleHeld = new KrBook().hold("000660", 5, 30, 27);
        staleHeld.unfillable.put("000660", "이번 관측치에 그 종목 봉이 없음");
        assertRejected(runKr(staleHeld, KR_LIMITS, krBuy("000660", 8)).get(0), OrderValidator.UNFILLABLE);
    }

    @Test
    @DisplayName("NO_PRICE(한국 정수 주): 기준 가격이 없는 종목의 매수는 1주 금액을 정할 수 없어 거절 — 매도는 가격을 보지 않음")
    void krBuyWithoutReferencePriceIsNoPrice() {
        KrBook book = new KrBook().hold("000660", 5, 30, 27);
        book.prices.remove("005930");
        book.prices.remove("000660");
        book.prices.put("069500", java.math.BigDecimal.ZERO);

        List<Verdict> verdicts = runKr(book, KR_LIMITS, krBuy("005930", 3), krSell("000660", 0.5),
                krBuy("069500", 5));

        assertRejected(verdicts.get(0), OrderValidator.NO_PRICE);
        assertThat(verdicts.get(0).detail()).contains("1주 체결 금액을 정할 수 없음");
        assertAccepted(verdicts.get(1));
        assertRejected(verdicts.get(2), OrderValidator.NO_PRICE);
    }

    @Test
    @DisplayName("한국 칸이 비면(미국 문맥) 검사 그대로 — 정수 주·체결 불가 칸이 없는 문맥은 1주 미만 매수도 통과(장부가 체결 때 취소하던 예전 동작)")
    void emptyKoreanFieldsKeepTheCommonChecks() {
        KrBook book = new KrBook();
        book.wholeShares = false;

        assertAccepted(runKr(book, KR_LIMITS, krBuy("207940", 0.6)).get(0));
        Context us = new Book().context();
        assertThat(us.unfillable()).isEmpty();
        assertThat(us.wholeShares()).isNull();
        assertThatThrownBy(() -> new OrderValidator.WholeShares(Map.of(), null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static void golden(StringBuilder out, String scene, Book book, Limits limits, Proposed... orders) {
        golden(out, scene, book.context(), limits, Arrays.asList(orders));
    }

    /** 장면 하나 — 주문마다 "[i] 주문 → 판정 | 근거" 한 줄(통과한 매수는 증가분 %p도). */
    private static void golden(StringBuilder out, String scene, Context ctx, Limits limits, List<Proposed> orders) {
        out.append("## ").append(scene).append('\n');
        List<Verdict> verdicts = OrderValidator.validate(orders, ctx, limits);
        for (int i = 0; i < verdicts.size(); i++) {
            Verdict v = verdicts.get(i);
            Proposed o = v.order();
            out.append('[').append(i).append("] ");
            out.append(o == null ? "null" : o.side() + " " + o.ticker() + " target=" + o.targetWeightPct()
                    + " fraction=" + o.sellFraction() + " " + o.timing());
            out.append(" → ").append(v.accepted() ? "OK" : "REJECT " + v.rejectReason()).append(" | ")
                    .append(v.detail());
            if (v.accepted() && o != null && OrderValidator.BUY.equals(o.side())) {
                out.append(" | increment=").append(OrderValidator.buyIncrementPct(o, ctx));
            }
            out.append('\n');
        }
    }
}
