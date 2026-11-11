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
        ManualAccountBalance.Applied r = ManualAccountBalance.buy(d("1000000"), d("10"), d("100000"), d("5"), d("60000"), d("9"));
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
        ManualAccountBalance.Applied r = ManualAccountBalance.buy(d("1000"), null, null, d("3"), d("300"), BigDecimal.ZERO);
        assertThat(r.quantity()).isEqualByComparingTo("3");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("300");
    }

    @Test
    @DisplayName("매도 — 현금 +(금액 − 수수료 − 세금), 매입 금액은 판 비율만큼, 실현 손익 = 금액 − 줄어든 매입 금액 − 수수료 − 세금")
    void sell() {
        ManualAccountBalance.Applied r = ManualAccountBalance.sell(d("100000"), d("10"), d("100000"), d("4"), d("48000"), d("7"), d("96"));
        assertThat(r.cash()).isEqualByComparingTo("147897");
        assertThat(r.quantity()).isEqualByComparingTo("6");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("60000");
        assertThat(r.costBasis()).isEqualByComparingTo("40000");
        assertThat(r.realizedPnl()).isEqualByComparingTo("7897");
    }

    @Test
    @DisplayName("전량 매도 — 매입 금액을 남기지 않음(나눗셈 잔돈 없음), 행을 없앰")
    void sellAll() {
        ManualAccountBalance.Applied r = ManualAccountBalance.sell(d("0"), d("3"), d("100"), d("3"), d("120"), BigDecimal.ZERO, BigDecimal.ZERO);
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
        assertThatThrownBy(() -> ManualAccountBalance.sell(d("0"), d("1"), d("100"), d("2"), d("80"), BigDecimal.ZERO, BigDecimal.ZERO))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("되돌림은 정확히 거꾸로 — 매수·매도 뒤 되돌리면 현금·수량·매입 금액이 원래대로")
    void undoReverses() {
        ManualAccountBalance.Applied bought = ManualAccountBalance.buy(d("1000000"), d("10"), d("100000"), d("5"), d("60002.5"), d("9"));
        ManualAccountBalance.Applied undoneBuy = ManualAccountBalance.undoBuy(bought.cash(), bought.quantity(), bought.purchaseAmount(), d("5"), d("60002.5"), d("9"), bought.costBasis());
        assertThat(undoneBuy.cash()).isEqualByComparingTo("1000000");
        assertThat(undoneBuy.quantity()).isEqualByComparingTo("10");
        assertThat(undoneBuy.purchaseAmount()).isEqualByComparingTo("100000");

        ManualAccountBalance.Applied sold = ManualAccountBalance.sell(d("100000"), d("10"), d("100000"), d("4"), d("48000"), d("7"), d("96"));
        ManualAccountBalance.Applied undoneSell = ManualAccountBalance.undoSell(sold.cash(), sold.quantity(), sold.purchaseAmount(), d("4"), d("48000"), d("7"), d("96"), sold.costBasis());
        assertThat(undoneSell.cash()).isEqualByComparingTo("100000");
        assertThat(undoneSell.quantity()).isEqualByComparingTo("10");
        assertThat(undoneSell.purchaseAmount()).isEqualByComparingTo("100000");

        ManualAccountBalance.Applied soldAll = ManualAccountBalance.undoSell(d("0"), null, null, d("3"), d("120"), BigDecimal.ZERO, BigDecimal.ZERO, d("100"));
        assertThat(soldAll.quantity()).as("전량 판 뒤 되돌림 — 행이 다시 생김").isEqualByComparingTo("3");
        assertThat(soldAll.purchaseAmount()).isEqualByComparingTo("100");
    }

    @Test
    @DisplayName("매수 되돌림 — 수량이 모자라면 empty(음수라 서비스가 거절 — QA-339), 매입 금액은 0 아래로 내려가지 않음")
    void undoAfterEdit() {
        ManualAccountBalance.Applied r = ManualAccountBalance.undoBuy(d("0"), d("3"), d("100"), d("5"), d("60000"), BigDecimal.ZERO, d("60000"));
        assertThat(r.empty()).isTrue();
        ManualAccountBalance.Applied partial = ManualAccountBalance.undoBuy(d("0"), d("10"), d("100"), d("5"), d("60000"), BigDecimal.ZERO, d("60000"));
        assertThat(partial.empty()).isFalse();
        assertThat(partial.purchaseAmount()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("QA-339 매수 되돌림 — 수량이 음수가 되면 shortfall(부르는 쪽이 거절), 정확히 0이면 행만 없앰")
    void undoShortfall() {
        ManualAccountBalance.Applied afterSell = ManualAccountBalance.undoBuy(d("0"), d("3"), d("300000"), d("4"), d("400000"), BigDecimal.ZERO, d("400000"));
        assertThat(afterSell.quantity()).isEqualByComparingTo("-1");
        assertThat(afterSell.shortfall()).isTrue();
        ManualAccountBalance.Applied exact = ManualAccountBalance.undoBuy(d("0"), d("4"), d("400000"), d("4"), d("400000"), BigDecimal.ZERO, d("400000"));
        assertThat(exact.empty()).isTrue();
        assertThat(exact.shortfall()).isFalse();
    }

    @Test
    @DisplayName("QA-339 매수 고치기 — 수량·금액을 바꾸지 않으면 보유 수량·매입 금액이 그대로(뒤에 판 몫을 되살리지 않음), 현금은 수수료 차이만")
    void editBuyKeepsHoldingWhenUnchanged() {
        // 4주(400,000) 매수 → 1주 매도 → 보유 3·매입 300,000. 수수료만 60 → 70.
        ManualAccountBalance.Applied r = ManualAccountBalance.editBuy(d("1000"), d("3"), d("300000"), d("4"), d("400000"), d("60"), d("400000"),
                d("4"), d("400000"), d("70"));
        assertThat(r.quantity()).isEqualByComparingTo("3");
        assertThat(r.purchaseAmount()).isEqualByComparingTo("300000");
        assertThat(r.cash()).isEqualByComparingTo("990");
        assertThat(r.costBasis()).as("내역 행에 적는 매입 금액 몫은 새 체결 금액").isEqualByComparingTo("400000");
        assertThat(r.realizedPnl()).isNull();

        // 10주(매입 100) 보유 → 4주(400) 매수 → 9주 매도 → 5주·178.57. 보유가 그 매수 수량보다 많아도 매입 금액이 부풀지 않음(수정 전 400).
        ManualAccountBalance.Applied mixed = ManualAccountBalance.editBuy(d("0"), d("5"), d("178.57"), d("4"), d("400"), d("1"), d("400"), d("4"), d("400"), d("2"));
        assertThat(mixed.quantity()).isEqualByComparingTo("5");
        assertThat(mixed.purchaseAmount()).isEqualByComparingTo("178.57");
        assertThat(mixed.cash()).isEqualByComparingTo("-1");
    }

    @Test
    @DisplayName("QA-339 매수 고치기 — 금액·수량을 바꾸면 남아 있는 몫만큼만 매입 금액이 바뀜")
    void editBuyMovesOnlyRemainingShare() {
        // 금액만 400,000 → 440,000: 남은 3/4 몫만 — 300,000 + 440,000 × 3/4 − 400,000 × 3/4.
        ManualAccountBalance.Applied amountOnly = ManualAccountBalance.editBuy(d("0"), d("3"), d("300000"), d("4"), d("400000"), d("0"), d("400000"),
                d("4"), d("440000"), d("0"));
        assertThat(amountOnly.quantity()).isEqualByComparingTo("3");
        assertThat(amountOnly.purchaseAmount()).isEqualByComparingTo("330000");
        assertThat(amountOnly.cash()).isEqualByComparingTo("-40000");

        // 뒤에 판 것이 없으면(보유 = 옛 수량) 예전과 같음 — 2주(60,000)를 3주(91,000)로.
        ManualAccountBalance.Applied plain = ManualAccountBalance.editBuy(d("100000"), d("2"), d("60000"), d("2"), d("60000"), d("9"), d("60000"),
                d("3"), d("91000"), d("9"));
        assertThat(plain.quantity()).isEqualByComparingTo("3");
        assertThat(plain.purchaseAmount()).isEqualByComparingTo("91000");
        assertThat(plain.cash()).isEqualByComparingTo("69000");

        // 수량을 4 → 6으로: 남는 5주 가운데 새 매수의 몫 5/6 — 300,000 + 600,000 × 5/6 − 400,000 × 3/4.
        ManualAccountBalance.Applied more = ManualAccountBalance.editBuy(d("0"), d("3"), d("300000"), d("4"), d("400000"), d("0"), d("400000"),
                d("6"), d("600000"), d("0"));
        assertThat(more.quantity()).isEqualByComparingTo("5");
        assertThat(more.purchaseAmount()).isEqualByComparingTo("500000");

        // 매입 금액은 0 아래로 내려가지 않음(잔고에서 매입 금액을 직접 낮춘 뒤).
        ManualAccountBalance.Applied floored = ManualAccountBalance.editBuy(d("0"), d("4"), d("100"), d("4"), d("400000"), d("0"), d("400000"),
                d("4"), d("300000"), d("0"));
        assertThat(floored.purchaseAmount()).isEqualByComparingTo("0");
    }

    @Test
    @DisplayName("QA-339 매수 고치기 — 전량을 판 뒤에는 줄이 다시 생기지 않고, 판 수량보다 적게 고치면 shortfall")
    void editBuyAfterSells() {
        ManualAccountBalance.Applied soldAll = ManualAccountBalance.editBuy(d("0"), null, null, d("4"), d("400000"), d("60"), d("400000"), d("4"), d("400000"), d("70"));
        assertThat(soldAll.empty()).isTrue();
        assertThat(soldAll.shortfall()).isFalse();
        assertThat(soldAll.purchaseAmount()).isEqualByComparingTo("0");
        assertThat(soldAll.cash()).isEqualByComparingTo("-10");

        ManualAccountBalance.Applied tooFew = ManualAccountBalance.editBuy(d("0"), d("1"), d("100000"), d("4"), d("400000"), d("0"), d("400000"),
                d("2"), d("200000"), d("0"));
        assertThat(tooFew.shortfall()).as("3주를 팔았는데 2주만 샀다고 고칠 수 없음").isTrue();

        ManualAccountBalance.Applied exact = ManualAccountBalance.editBuy(d("0"), d("1"), d("100000"), d("4"), d("400000"), d("0"), d("400000"),
                d("3"), d("300000"), d("0"));
        assertThat(exact.empty()).isTrue();
        assertThat(exact.shortfall()).isFalse();

        // 전량을 판 뒤 더 많이 샀다고 고치면 늘어난 만큼만 보유로 — 새 매수 6주 가운데 2주의 몫.
        ManualAccountBalance.Applied grew = ManualAccountBalance.editBuy(d("0"), null, null, d("4"), d("400000"), d("0"), d("400000"), d("6"), d("600000"), d("0"));
        assertThat(grew.quantity()).isEqualByComparingTo("2");
        assertThat(grew.purchaseAmount()).isEqualByComparingTo("200000");
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
