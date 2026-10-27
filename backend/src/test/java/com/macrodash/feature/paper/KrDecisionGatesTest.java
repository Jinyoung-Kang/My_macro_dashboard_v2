package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.KrRuleBookServiceTest.FRI;
import static com.macrodash.feature.paper.KrRuleBookServiceTest.R;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 게이트 ①이 기다리지 않는 주문의 판정({@link KrDecisionGates#unworkable} — 2단계 명세 §4-9 'D2b', 사용자 결정 2026-10-28 u2)의 갈래 하나씩. 결정
 * 작업 끝까지의 흐름은 {@code KrRulesJobTest}가 봅니다. 외부 호출·DB 없음.
 */
class KrDecisionGatesTest {

    private static Order sell(String ticker, LocalDate asOf) {
        return new Order(7, PaperBooks.KR_RULES, null, ticker, PaperBooks.SELL, null, null, null, PaperBooks.NEXT_OPEN,
                RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null, null, asOf,
                Instant.parse("2026-10-30T13:30:00Z"), LocalDate.of(2026, 11, 4), null);
    }

    private static Optional<Quotes> krQuotes() {
        return KrQuotes.parse(KrRulesFixtures.quotes(R));
    }

    @Test
    @DisplayName("관측치가 없으면 봉으로는 판정하지 않음(막음 — null), 저장된 미처리 기업행위 보유·장부가 그 관측치에서 보류한 종목은 관측치 없이도 사유")
    void withoutAnObservationOnlyHoldsExempt() {
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), Optional.empty(), Map.of(), Map.of())).isNull();
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), Optional.empty(), Map.of("005930", "큰 변동"), Map.of()))
                .isEqualTo("미처리 기업행위 보유(큰 변동) — 장부가 그 종목 주문을 보류");
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), Optional.empty(), Map.of(),
                Map.of("005930", "기업행위 판정 대기 — …"))).isEqualTo("장부가 이번 관측치로는 보류 — 기업행위 판정 대기 — …");
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), Optional.empty(), Map.of("000660", "큰 변동"),
                Map.of("000660", "판정 대기"))).as("다른 종목의 보류는 상관없음").isNull();
    }

    @Test
    @DisplayName("한국 칸이 없는 봉(미국 모양)·기준일 없는 주문은 판정하지 않음(막음 — null), 관측치에 그 종목 항목이 없으면 '수집 범위 밖·봉 없음'")
    void judgesOnlyKrBarsOfOrdersWithABaseDate() {
        Optional<Quotes> usShaped = Optional.of(new Quotes(Instant.parse("2026-11-02T12:57:00Z"),
                Map.of("005930", new Bar("005930", R, 10_100, false, null))));
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), usShaped, Map.of(), Map.of())).isNull();
        assertThat(KrDecisionGates.unworkable(sell("034020", null), krQuotes(), Map.of(), Map.of())).isNull();
        assertThat(KrDecisionGates.unworkable(sell("034020", FRI), krQuotes(), Map.of(), Map.of()))
                .isEqualTo("이번 관측치에 그 종목 봉이 없음(수집 범위 밖·봉 없음)");
        assertThat(KrDecisionGates.unworkable(sell("005930", FRI), krQuotes(), Map.of(), Map.of()))
                .as("기준일 뒤 R 봉이 관측 봉 — 장부가 일하는 주문").isNull();
    }
}
