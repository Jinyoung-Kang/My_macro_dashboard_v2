package com.macrodash.feature.realtrade;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** ISA 계좌 잔고의 순수 계산({@link ManualAccountBalance}, ADR 0034) — 값은 합성 값입니다. */
class ManualAccountBalanceTest {

    @Test
    @DisplayName("매수 — 현금 −(금액 + 수수료), 매입 금액 +금액, 수량 +")
    void buy() {
        ManualAccountBalance.Applied r = ManualAccountBalance.buy(d("1000000"), d("10"), d("100000"), d("5"), d("12000"), d("9"));
        assertThat(r.cash()).isEqualByComparingTo("939991");
        assertThat(r.quantity()).isEqualByComparingTo("15");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("160000");
        assertThat(r.costBasis()).isEqualByComparingTo("60000");
        assertThat(r.realizedPnl()).isNull();
        assertThat(r.empty()).isFalse();
    }

    @Test
    @DisplayName("없던 종목 매수도 — 보유·매입 금액은 0에서")
    void buyNewSymbol() {
        ManualAccountBalance.Applied r = ManualAccountBalance.buy(d("1000"), null, null, d("3"), d("100"), BigDecimal.ZERO);
        assertThat(r.quantity()).isEqualByComparingTo("3");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("300");
    }

    @Test
    @DisplayName("매도 — 현금 +(금액 − 수수료 − 세금), 매입 금액은 판 비율만큼, 실현 손익 = 금액 − 줄어든 매입 금액 − 수수료 − 세금")
    void sell() {
        ManualAccountBalance.Applied r = ManualAccountBalance.sell(d("100000"), d("10"), d("100000"), d("4"), d("12000"), d("7"), d("96"));
        assertThat(r.cash()).isEqualByComparingTo("147897");
        assertThat(r.quantity()).isEqualByComparingTo("6");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("60000");
        assertThat(r.costBasis()).isEqualByComparingTo("40000");
        assertThat(r.realizedPnl()).isEqualByComparingTo("7897");
    }

    @Test
    @DisplayName("전량 매도 — 매입 금액을 남기지 않음(나눗셈 잔돈 없음), 행을 없앰")
    void sellAll() {
        ManualAccountBalance.Applied r = ManualAccountBalance.sell(d("0"), d("3"), d("100"), d("3"), d("40"), BigDecimal.ZERO, BigDecimal.ZERO);
        assertThat(r.empty()).isTrue();
        assertThat(r.purchaseAmount()).isEqualByComparingTo("0");
        assertThat(r.costBasis()).isEqualByComparingTo("100");
        assertThat(r.realizedPnl()).isEqualByComparingTo("20");
    }

    @Test
    @DisplayName("매입 금액을 나눌 때 소수 둘째 자리 반올림 — 합이 어긋나도 음수가 되지 않음, 보유보다 많은 매도는 예외")
    void rounding() {
        ManualAccountBalance.Applied r = ManualAccountBalance.sell(d("0"), d("3"), d("100"), d("1"), d("40"), BigDecimal.ZERO, BigDecimal.ZERO);
        assertThat(r.costBasis()).isEqualByComparingTo("33.33");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("66.67");
        assertThatThrownBy(() -> ManualAccountBalance.sell(d("0"), d("1"), d("100"), d("2"), d("40"), BigDecimal.ZERO, BigDecimal.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("되돌림은 정확히 거꾸로 — 매수·매도 뒤 되돌리면 현금·수량·매입 금액이 원래대로")
    void undoReverses() {
        ManualAccountBalance.Applied bought = ManualAccountBalance.buy(d("1000000"), d("10"), d("100000"), d("5"), d("12000.5"), d("9"));
        ManualAccountBalance.Applied undoneBuy = ManualAccountBalance.undoBuy(bought.cash(), bought.quantity(), bought.purchaseAmount(), d("5"), d("12000.5"), d("9"),
                bought.costBasis());
        assertThat(undoneBuy.cash()).isEqualByComparingTo("1000000");
        assertThat(undoneBuy.quantity()).isEqualByComparingTo("10");
        assertThat(undoneBuy.purchaseAmount()).isEqualByComparingTo("100000");

        ManualAccountBalance.Applied sold = ManualAccountBalance.sell(d("100000"), d("10"), d("100000"), d("4"), d("12000"), d("7"), d("96"));
        ManualAccountBalance.Applied undoneSell = ManualAccountBalance.undoSell(sold.cash(), sold.quantity(), sold.purchaseAmount(), d("4"), d("12000"), d("7"), d("96"),
                sold.costBasis());
        assertThat(undoneSell.cash()).isEqualByComparingTo("100000");
        assertThat(undoneSell.quantity()).isEqualByComparingTo("10");
        assertThat(undoneSell.purchaseAmount()).isEqualByComparingTo("100000");

        ManualAccountBalance.Applied soldAll = ManualAccountBalance.undoSell(d("0"), null, null, d("3"), d("40"), BigDecimal.ZERO, BigDecimal.ZERO, d("100"));
        assertThat(soldAll.quantity()).as("전량 판 뒤 되돌림 — 행이 다시 생김").isEqualByComparingTo("3");
        assertThat(soldAll.purchaseAmount()).isEqualByComparingTo("100");
    }

    @Test
    @DisplayName("매수 되돌림 — 그사이 보유를 고쳐 수량이 모자라면 행을 없애고, 매입 금액은 0 아래로 내려가지 않음")
    void undoAfterEdit() {
        ManualAccountBalance.Applied r = ManualAccountBalance.undoBuy(d("0"), d("3"), d("100"), d("5"), d("12000"), BigDecimal.ZERO, d("60000"));
        assertThat(r.empty()).isTrue();
        ManualAccountBalance.Applied partial = ManualAccountBalance.undoBuy(d("0"), d("10"), d("100"), d("5"), d("12000"), BigDecimal.ZERO, d("60000"));
        assertThat(partial.empty()).isFalse();
        assertThat(partial.purchaseAmount()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("현금 = 총평가금액 − Σ(수량 × 가격) — 음수면 그대로(막지 않음), 소수 둘째 자리")
    void cashFromTotal() {
        assertThat(ManualAccountBalance.cashFromTotal(d("1000000"), List.of(new ManualAccountBalance.Lot(d("10"), d("12000")), new ManualAccountBalance.Lot(d("5"), d("21000.5")))))
                .isEqualByComparingTo("774997.50");
        assertThat(ManualAccountBalance.cashFromTotal(d("100"), List.of(new ManualAccountBalance.Lot(d("10"), d("12000"))))).isEqualByComparingTo("-119900");
        assertThat(ManualAccountBalance.cashFromTotal(d("100"), List.of())).isEqualByComparingTo("100");
    }

    @Test
    @DisplayName("평균 매입가·백분율 — 모르면 null(0으로 채우지 않음)")
    void avgAndPercent() {
        assertThat(ManualAccountBalance.avgPrice(d("100000"), d("10"))).isEqualByComparingTo("10000");
        assertThat(ManualAccountBalance.avgPrice(d("100"), d("3"))).isEqualByComparingTo("33.3333");
        assertThat(ManualAccountBalance.avgPrice(d("100"), BigDecimal.ZERO)).isNull();
        assertThat(ManualAccountBalance.percent(d("25"), d("200"))).isEqualByComparingTo("12.50");
        assertThat(ManualAccountBalance.percent(d("25"), BigDecimal.ZERO)).isNull();
        assertThat(ManualAccountBalance.percent(null, d("10"))).isNull();
    }

    @Test
    @DisplayName("종목 해석 — 코드 모양이면 코드(대문자), 아니면 이름 정확 일치 → 하나로 좁혀지는 부분 일치, 없거나 여럿이면 null")
    void resolveSymbol() {
        Map<String, String> names = Map.of("005930", "합성전자", "005935", "합성전자우", "000660", "합성 하이닉스", "035420", "다른화학");
        assertThat(ManualAccountBalance.resolveSymbol(" 005930 ", names)).isEqualTo("005930");
        assertThat(ManualAccountBalance.resolveSymbol("0117v0", names)).as("대문자로").isEqualTo("0117V0");
        assertThat(ManualAccountBalance.resolveSymbol("합성전자", names)).as("정확 일치가 부분 일치보다 먼저").isEqualTo("005930");
        assertThat(ManualAccountBalance.resolveSymbol("합성하이닉스", names)).as("공백 무시").isEqualTo("000660");
        assertThat(ManualAccountBalance.resolveSymbol("화학", names)).as("하나로 좁혀지는 부분 일치").isEqualTo("035420");
        assertThat(ManualAccountBalance.resolveSymbol("합성", names)).as("여럿").isNull();
        assertThat(ManualAccountBalance.resolveSymbol("없는이름", names)).isNull();
        assertThat(ManualAccountBalance.resolveSymbol(" ", names)).isNull();
    }
}
