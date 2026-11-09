package com.macrodash.feature.realtrade;

import com.macrodash.feature.realtrade.ManualAccountLedger.Entry;
import com.macrodash.feature.realtrade.ManualAccountLedger.State;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static com.macrodash.feature.realtrade.RealTradeFixtures.kst;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * ISA 계좌 장부의 순수 계산({@link ManualAccountLedger}, ADR 0029 — 명세 §1): 현금·보유·평단·순입금, 음수가 되는 장부 거절(어느 시점에서든), 같은 시각 안 순서,
 * 새 행이 쓸 수 있는 현금·보유. 금액·종목은 모두 합성 값입니다.
 */
class ManualAccountLedgerTest {

    private static final String A = "005930";
    private static final String B = "000660";

    private static Entry deposit(long id, String at, String amount) {
        return new Entry(id, kst(at), "DEPOSIT", null, null, null, d(amount), BigDecimal.ZERO, BigDecimal.ZERO);
    }

    private static Entry withdraw(long id, String at, String amount) {
        return new Entry(id, kst(at), "WITHDRAW", null, null, null, d(amount), BigDecimal.ZERO, BigDecimal.ZERO);
    }

    private static Entry trade(long id, String at, String kind, String symbol, String qty, String price, String fee, String tax) {
        return new Entry(id, kst(at), kind, symbol, d(qty), d(price), null, d(fee), d(tax));
    }

    private static Entry adjust(long id, String at, String symbol, String qty) {
        return new Entry(id, kst(at), "ADJUST", symbol, d(qty), null, null, BigDecimal.ZERO, BigDecimal.ZERO);
    }

    @Test
    @DisplayName("현금 = 입금 − 출금 − 매수(수량×체결가+수수료+세금) + 매도(수량×체결가−수수료−세금), 보유 = 매수 − 매도 + 조정, 순입금 = 입금 − 출금")
    void cashHoldingsAndNetDeposit() {
        List<Entry> rows = List.of(
                deposit(1, "2026-11-02T09:00", "1000000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "10", "50000", "100", "0"),
                trade(3, "2026-11-03T09:00", "SELL", A, "4", "60000", "50", "300"),
                trade(4, "2026-11-03T09:00", "BUY", B, "3", "20000", "0", "0"),
                withdraw(5, "2026-11-04T10:00", "100000"),
                adjust(6, "2026-11-04T10:00", B, "3"));

        State state = ManualAccountLedger.replay(rows);

        // 1,000,000 − 500,100 + (240,000 − 350) − 60,000 − 100,000
        assertThat(state.cash()).isEqualByComparingTo("579550");
        assertThat(state.held(A)).isEqualByComparingTo("6");
        assertThat(state.held(B)).as("3주 + 조정 3주(분할)").isEqualByComparingTo("6");
        assertThat(state.netDeposit()).isEqualByComparingTo("900000");
        assertThat(state.holdings().get(A).avgPrice()).as("매도는 평단을 바꾸지 않음").isEqualByComparingTo("50000");
        assertThat(state.holdings().get(B).avgPrice()).as("조정은 원가를 두고 수량만 — 분할이면 평단이 내려감").isEqualByComparingTo("10000");
        assertThat(ManualAccountLedger.firstInvalid(rows)).isNull();
    }

    @Test
    @DisplayName("전량 매도한 종목은 보유에서 빠지고, 다시 사면 그 값으로 평단을 새로 셈")
    void soldOutHoldingDisappears() {
        State state = ManualAccountLedger.replay(List.of(
                deposit(1, "2026-11-02T09:00", "1000000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "5", "10000", "0", "0"),
                trade(3, "2026-11-03T09:00", "SELL", A, "5", "12000", "0", "0"),
                trade(4, "2026-11-04T09:00", "BUY", A, "2", "15000", "0", "0")));

        assertThat(state.held(A)).isEqualByComparingTo("2");
        assertThat(state.holdings().get(A).avgPrice()).isEqualByComparingTo("15000");
        assertThat(ManualAccountLedger.replay(List.of(deposit(1, "2026-11-02T09:00", "10"),
                trade(2, "2026-11-02T09:00", "BUY", A, "1", "10", "0", "0"), trade(3, "2026-11-02T10:00", "SELL", A, "1", "10", "0", "0")))
                .holdings()).isEmpty();
    }

    @Test
    @DisplayName("어느 시점에서든 현금·보유가 음수가 되는 장부는 거절 — 시각 순으로 쌓고, 같은 시각이면 입금 → 매도 → 조정 → 매수 → 출금")
    void rejectsNegativeAtAnyPoint() {
        assertThat(ManualAccountLedger.firstInvalid(List.of(
                trade(1, "2026-11-02T09:00", "BUY", A, "1", "10000", "0", "0"),
                deposit(2, "2026-11-02T09:00", "10000")))).as("같은 시각 — 입금이 매수보다 먼저").isNull();
        Entry early = trade(3, "2026-11-02T08:59", "BUY", A, "1", "10000", "0", "0");
        assertThat(ManualAccountLedger.firstInvalid(List.of(deposit(2, "2026-11-02T09:00", "10000"), early))).as("입금보다 이른 매수")
                .isEqualTo(early);
        Entry oversell = trade(4, "2026-11-03T09:00", "SELL", A, "2", "10000", "0", "0");
        assertThat(ManualAccountLedger.firstInvalid(List.of(deposit(1, "2026-11-02T09:00", "10000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "1", "10000", "0", "0"), oversell))).isEqualTo(oversell);
        Entry fee = trade(2, "2026-11-02T09:00", "BUY", A, "1", "10000", "1", "0");
        assertThat(ManualAccountLedger.firstInvalid(List.of(deposit(1, "2026-11-02T09:00", "10000"), fee))).as("수수료까지 셈").isEqualTo(fee);
        Entry withdrawal = withdraw(3, "2026-11-02T10:00", "1");
        assertThat(ManualAccountLedger.firstInvalid(List.of(deposit(1, "2026-11-02T09:00", "10000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "1", "10000", "0", "0"), withdrawal))).isEqualTo(withdrawal);
        Entry reverse = adjust(3, "2026-11-02T10:00", A, "-2");
        assertThat(ManualAccountLedger.firstInvalid(List.of(deposit(1, "2026-11-02T09:00", "10000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "1", "10000", "0", "0"), reverse))).isEqualTo(reverse);
    }

    @Test
    @DisplayName("새 행이 쓸 수 있는 현금·보유는 그 자리부터 끝까지의 최솟값 — 뒤 시점 행이 음수가 되지 않게")
    void minimumFromInsertionPoint() {
        List<Entry> rows = new ArrayList<>(List.of(
                deposit(1, "2026-11-02T09:00", "100000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "3", "10000", "0", "0"),
                trade(3, "2026-11-04T09:00", "BUY", B, "5", "10000", "0", "0"),
                trade(4, "2026-11-05T09:00", "SELL", A, "2", "10000", "0", "0")));
        Instant at = kst("2026-11-03T09:00");

        // 11-03 시점 현금 70,000 → 11-04 매수 뒤 20,000 → 11-05 매도 뒤 40,000 — 최솟값 20,000
        assertThat(ManualAccountLedger.minCashFrom(rows, at, "BUY")).isEqualByComparingTo("20000");
        // 11-03 시점 A 3주 → 11-05 매도 뒤 1주 — 새 매도는 1주까지
        assertThat(ManualAccountLedger.minHoldingFrom(rows, A, at, "SELL")).isEqualByComparingTo("1");
        assertThat(ManualAccountLedger.minCashFrom(rows, kst("2026-11-06T09:00"), "BUY")).as("맨 뒤면 마지막 현금").isEqualByComparingTo("40000");
    }

    @Test
    @DisplayName("실현 손익률 — 매도 행만, 팔기 직전 이동평균 평단 대비(수수료·세금 제외), 조정은 평단을 낮추고, 원가를 모르는 매도는 없음")
    void realizedPctPerSell() {
        List<Entry> rows = List.of(
                deposit(1, "2026-11-02T09:00", "10000000"),
                trade(2, "2026-11-02T09:00", "BUY", A, "10", "50000", "100", "0"),
                trade(3, "2026-11-03T09:00", "SELL", A, "4", "60000", "500", "300"),   // 평단 50,000 → +20%
                trade(4, "2026-11-04T09:00", "BUY", A, "6", "70000", "0", "0"),        // 6주 50,000 + 6주 70,000 → 평단 60,000
                trade(5, "2026-11-05T09:00", "SELL", A, "3", "45000", "0", "0"),       // → −25%
                adjust(6, "2026-11-05T10:00", B, "10"),                                // 원가 없이 생긴 보유
                trade(7, "2026-11-06T09:00", "SELL", B, "1", "1000", "0", "0"));

        Map<Long, BigDecimal> pct = ManualAccountLedger.realizedPct(rows);

        assertThat(pct).containsOnlyKeys(3L, 5L);
        assertThat(pct.get(3L)).isEqualByComparingTo("20");
        assertThat(pct.get(5L)).isEqualByComparingTo("-25");
    }
}
