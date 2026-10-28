package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 화면 경로의 시장 값(2단계 명세 §4-16 '?market', F1) — 값이 없으면 미국, 운영 목록의 코드(US·KR)만 받고 그 밖은 400, 조회 한 번의 시장
 * 문맥({@link PaperMarkets.Scope})은 쉬는 한국 시장에도 실행(그 실행의 한국 달력)을 열고 쉬는 사유를 함께 싣습니다.
 */
class PaperMarketsRequestTest {

    private static final LocalDate S = LocalDate.of(2026, 11, 30);

    private FakePaperStore store;
    private PaperMarkets markets;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        StoreReader reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        markets = new PaperMarkets(store, reader);
    }

    private static PaperConfig krConfig(LocalDate start) {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    @Test
    @DisplayName("시장 값이 없으면 미국, US·KR은 그 시장 묶음")
    void knownCodes() {
        assertThat(markets.requested(null)).isSameAs(UsPaperMarket.INSTANCE);
        assertThat(markets.requested("US")).isSameAs(UsPaperMarket.INSTANCE);
        assertThat(markets.requested("KR")).isSameAs(KrPaperMarket.INSTANCE);
    }

    @Test
    @DisplayName("모르는 값·빈 값·소문자·공백 붙은 값은 400 — 받는 값을 적어 알리고 미국으로 읽지 않는다")
    void unknownCodesAreRejected() {
        for (String code : new String[]{"JP", "", " ", "kr", " KR", "US "}) {
            assertThatThrownBy(() -> markets.requested(code)).as("'" + code + "'")
                    .isInstanceOf(InvalidRequestException.class)
                    .hasMessageContaining("market는 US · KR 가운데 하나여야 합니다");
        }
    }

    @Test
    @DisplayName("조회 문맥: 출발일이 비었으면 쉬는 사유(출발일 없음)와 함께 한국 실행을 연다 — 그 실행의 달력은 공휴일 저장본의 KRX 달력")
    void dormantKoreaStillOpensItsRun() {
        PaperMarkets.Scope scope = markets.scope(KrPaperMarket.INSTANCE, PaperFixtures.config());

        assertThat(scope.dormantReason()).isEqualTo(PaperConfig.KR_START_MISSING);
        assertThat(scope.market()).isSameAs(KrPaperMarket.INSTANCE);
        // 2026-10-09(금) 한글날 — KRX 휴장(미국 달력이면 거래일). 10-10 10:00 KST에 마감이 끝난 최근 세션은 10-08.
        assertThat(scope.run().calendar().lastCompletedSession(Instant.parse("2026-10-10T01:00:00Z")))
                .isEqualTo(LocalDate.of(2026, 10, 8));
    }

    @Test
    @DisplayName("조회 문맥: 출발일이 있어도 한국 계좌가 없으면 '한국 계좌 없음', 계좌가 생기면 쉬지 않음, 미국은 늘 쉬지 않음")
    void dormancyFollowsTheJobsRule() {
        assertThat(markets.scope(KrPaperMarket.INSTANCE, krConfig(S)).dormantReason())
                .isEqualTo(KrPaperMarket.NOT_INITIALIZED);
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, null, PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
        assertThat(markets.scope(KrPaperMarket.INSTANCE, krConfig(S)).dormantReason()).isNull();
        assertThat(markets.scope(UsPaperMarket.INSTANCE, PaperFixtures.config()).dormantReason()).isNull();
        assertThat(markets.scope(UsPaperMarket.INSTANCE, PaperFixtures.config()).market())
                .isSameAs(UsPaperMarket.INSTANCE);
    }

    @Test
    @DisplayName("테이블이 없으면 쉬는 사유를 보지 않는다(null) — 응답은 부르는 쪽의 available:false")
    void notReadySkipsDormancy() {
        store.ready = false;

        assertThat(markets.scope(KrPaperMarket.INSTANCE, PaperFixtures.config()).dormantReason()).isNull();
    }
}
