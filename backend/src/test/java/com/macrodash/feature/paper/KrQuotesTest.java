package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 관측치 파서 — {@code paper.kr.quotes} 계약 1(명세 §9 'B4·C2') → 한국 봉(결정 d10, C2b). 모양은 수집기 {@code kr_paper_quotes}가 쓰는
 * 칸 그대로입니다({@link KrFixtures.Payload}).
 */
class KrQuotesTest {

    private static final LocalDate MON = LocalDate.of(2026, 11, 2);
    private static final LocalDate TUE = LocalDate.of(2026, 11, 3);
    private static final Instant FETCHED = Instant.parse("2026-11-03T12:57:00Z");
    private static final Instant COLLECTED = Instant.parse("2026-11-03T13:01:00Z");

    @Test
    @DisplayName("계약 1 종목 → 마지막 봉 날짜·종가·이어받기 여부, 한국 칸(시가·거래량·출처·1분봉 개장 봉·종목 수집 시각·NXT 여부), 머리의 세션")
    void readsContractOne() {
        KrFixtures.Payload payload = new KrFixtures.Payload(TUE);
        payload.code("005930", FETCHED).bar(MON, 218_000.0, 214_000.0, 17_213_072)
                .bar(TUE, 215_500.0, 213_000.0, 12_000_000).minute("OK", "09:01", 213_500.0, 592_667, "10:01", 214_000.0, 43_523);
        payload.etf("069500", FETCHED).bar(MON, 86_265.0, 85_995.0, 2_000_000).bar(TUE, 86_000.0, 86_500.0, 1_900_000)
                .minute("NO_BAR");

        Quotes quotes = KrQuotes.parse(payload.snapshot(COLLECTED)).orElseThrow();

        assertThat(quotes.collectedAt()).isEqualTo(COLLECTED);
        assertThat(quotes.session()).as("머리의 대상 세션").isEqualTo(TUE);
        assertThat(quotes.modalBarDate()).isEqualTo(TUE);
        Bar samsung = quotes.bars().get("005930");
        assertThat(samsung.date()).isEqualTo(TUE);
        assertThat(samsung.close()).as("평가 = 토스 잠정 종가(원시)").isEqualTo(213_000.0);
        assertThat(samsung.stale()).isFalse();
        assertThat(samsung.recent().valueOn(MON)).isEqualTo(214_000.0);
        KrQuotes.Quote kr = samsung.kr();
        assertThat(kr.fetchedAt()).as("체결 조건 ①의 종목 수집 시각").isEqualTo(FETCHED);
        assertThat(kr.nxtSupported()).isTrue();
        assertThat(kr.securityType()).isEqualTo("STOCK");
        assertThat(kr.fscMarket()).as("금융위 시장 구분은 저장본에 없음 — 장부가 덧붙임").isNull();
        assertThat(kr.choice()).isNull();
        assertThat(kr.days()).extracting(KrQuotes.Day::date).containsExactly(MON, TUE);
        KrQuotes.Day tue = kr.last();
        assertThat(tue.open()).isEqualByComparingTo("215500");
        assertThat(tue.volume()).isEqualTo(12_000_000L);
        assertThat(tue.priceSource()).isEqualTo(KrQuotes.SOURCE_INTEGRATED);
        assertThat(tue.observed()).isTrue();
        assertThat(tue.minute().status()).isEqualTo(KrQuotes.MINUTE_OK);
        assertThat(tue.minute().opens()).containsOnlyKeys("09:01", "10:01");
        assertThat(tue.minute().opens().get("09:01").open()).isEqualByComparingTo("213500");
        assertThat(tue.minute().opens().get("09:01").volume()).isEqualTo(592_667L);
        assertThat(kr.day(MON).orElseThrow().minute()).as("묻지 않은 봉은 1분봉 칸 없음").isNull();

        KrQuotes.Quote etf = quotes.bars().get("069500").kr();
        assertThat(etf.nxtSupported()).isFalse();
        assertThat(etf.last().priceSource()).as("KRX 단독 봉").isEqualTo(KrQuotes.SOURCE_DAILY);
        assertThat(etf.last().minute().status()).isEqualTo(KrQuotes.MINUTE_NO_BAR);
        assertThat(etf.last().minute().opens()).isEmpty();
    }

    @Test
    @DisplayName("관측이 아닌 것: 이어받은 항목은 stale(체결하지 않음), NO_BARS·모르는 상태·봉 없음은 관측치에 없음, 거래량 0·모름은 그대로(0으로 채우지 않음)")
    void staleAndAbsentEntries() {
        KrFixtures.Payload payload = new KrFixtures.Payload(TUE);
        payload.code("005930", FETCHED).bar(TUE, 215_500.0, 213_000.0, 1_000).stale();
        payload.code("000660", FETCHED).node.put("status", "NO_BARS");
        payload.code("035420", FETCHED).bar(TUE, 200_000, 201_000, 5).node.put("status", "WHAT");
        payload.code("051910", FETCHED);   // 봉 없음
        payload.code("101530", FETCHED).bar(MON, 5_530, 5_530, 0).bar(TUE, null, 5_530, null);

        Quotes quotes = KrQuotes.parse(payload.snapshot(COLLECTED)).orElseThrow();

        assertThat(quotes.bars()).containsOnlyKeys("005930", "101530");
        assertThat(quotes.bars().get("005930").stale()).as("이어받기(QA-032) — 관측 아님").isTrue();
        assertThat(quotes.staleTickers()).containsExactly("005930");
        KrQuotes.Quote halted = quotes.bars().get("101530").kr();
        assertThat(halted.day(MON).orElseThrow().volume()).as("정지일").isZero();
        assertThat(halted.day(MON).orElseThrow().observed()).isFalse();
        assertThat(halted.last().volume()).as("모르는 거래량").isNull();
        assertThat(halted.last().observed()).isFalse();
        assertThat(halted.last().open()).as("없는 시가").isNull();
    }

    @Test
    @DisplayName("믿을 수 없는 종목은 뺌: 마지막 봉 종가 없음·0원, 날짜가 오름차순 아님·날짜 없음, 코드 모양 아님 — 가격 0 이하는 null, 수집 시각을 모르면 체결 시각만 null")
    void malformedEntries() {
        KrFixtures.Payload payload = new KrFixtures.Payload(TUE);
        payload.code("005930", FETCHED).bar(MON, 100, 100, 1).bar(TUE, 100, null, 1);
        payload.code("000660", FETCHED).bar(MON, 100, 100, 1).bar(TUE, 100, 0, 1);
        payload.code("035420", FETCHED).bar(TUE, 100, 100, 1).bar(MON, 100, 100, 1);
        ((tools.jackson.databind.node.ArrayNode) payload.code("051910", FETCHED).bar(TUE, 100, 100, 1).node.get("bars"))
                .addObject().put("close", 1);
        payload.code("05593a", FETCHED).bar(TUE, 100, 100, 1);
        payload.code("0000D0", FETCHED).bar(TUE, 0, 9_000, 3);
        payload.code("006400", FETCHED).bar(TUE, 100, 100, 1).node.put("fetchedAt", "어제");

        Quotes quotes = KrQuotes.parse(payload.snapshot(COLLECTED)).orElseThrow();

        assertThat(quotes.bars()).containsOnlyKeys("0000D0", "006400");
        assertThat(quotes.bars().get("0000D0").kr().last().open()).as("시가 0원 = 체결 없음").isNull();
        assertThat(quotes.bars().get("006400").kr().fetchedAt()).isNull();
    }

    @Test
    @DisplayName("저장본 전체를 믿을 수 없으면 empty: 계약 판이 1이 아니거나 없음, 수집 시각 모름, codes 없음, 쓸 종목이 하나도 없음 — 미국 파서는 이 모양을 읽지 않음")
    void wholeSnapshot() {
        KrFixtures.Payload payload = new KrFixtures.Payload(TUE);
        payload.code("005930", FETCHED).bar(TUE, 100, 100, 1);
        assertThat(KrQuotes.parse(payload.snapshot(COLLECTED))).isPresent();
        assertThat(PaperMarketData.parse(payload.snapshot(COLLECTED))).as("미국 파서(tickers 없음)").isEmpty();
        assertThat(KrQuotes.parse(payload.snapshot(null))).isEmpty();

        ObjectNode two = payload.payload.deepCopy().put("contract", 2);
        assertThat(KrQuotes.parse(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, two, COLLECTED))).isEmpty();
        ObjectNode none = payload.payload.deepCopy();
        none.remove("contract");
        assertThat(KrQuotes.parse(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, none, COLLECTED))).isEmpty();
        ObjectNode noCodes = payload.payload.deepCopy();
        noCodes.remove("codes");
        assertThat(KrQuotes.parse(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, noCodes, COLLECTED))).isEmpty();
        KrFixtures.Payload empty = new KrFixtures.Payload(TUE);
        empty.code("000660", FETCHED).node.put("status", "NO_BARS");
        assertThat(KrQuotes.parse(empty.snapshot(COLLECTED))).isEmpty();

        ObjectNode noSession = payload.payload.deepCopy();
        noSession.remove("session");
        Optional<Quotes> read = KrQuotes.parse(KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, noSession, COLLECTED));
        assertThat(read).isPresent();
        assertThat(read.get().session()).as("머리에 세션이 없으면 null(늦음은 수집 시각으로 셈)").isNull();
    }

    @Test
    @DisplayName("가격은 십진수 그대로(관측가 = 체결가 — K31): 원 단위 float 응답(213500.0)도 정확히 같은 값")
    void decimalPrices() {
        KrFixtures.Payload payload = new KrFixtures.Payload(TUE);
        payload.code("005930", FETCHED).bar(TUE, 71_300.0, 49_950.0, 400);
        KrQuotes.Day day = KrQuotes.parse(payload.snapshot(COLLECTED)).orElseThrow().bars().get("005930").kr().last();
        assertThat(day.open()).isEqualByComparingTo(new BigDecimal("71300"));
        assertThat(day.close().multiply(BigDecimal.valueOf(400))).isEqualByComparingTo("19980000");
    }
}
