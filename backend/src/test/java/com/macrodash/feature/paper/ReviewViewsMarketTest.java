package com.macrodash.feature.paper;

import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Review;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 복기 목록·한 건의 시장 값(2단계 명세 §4-16 '?market', F1) — 미국 응답은 그대로(미국 행만·미국 달력의 최근 주·토요일 09:00), 한국은 그 시장 행만,
 * 최근 복기 주·여는 시각·다시 부를 수 있음을 그 조회 실행의 KRX 달력과 한국 여는 순간(토요일 22:30 KST)으로 보고, 쉬는 한국은 사유를 싣습니다.
 */
class ReviewViewsMarketTest {

    /** 2026-10-10(토) 23:00 KST — 미국은 10-09(금) 세션까지 끝남, 한국은 10-09 한글날 휴장이라 그 주 마지막 거래일 10-08(목). */
    private static final Instant NOW = Instant.parse("2026-10-10T14:00:00Z");
    private static final LocalDate KR_WEEK = LocalDate.of(2026, 10, 8);
    private static final LocalDate US_WEEK = LocalDate.of(2026, 10, 9);
    private static final LocalDate PREVIOUS = LocalDate.of(2026, 10, 2);
    private static final LocalDate S = LocalDate.of(2026, 11, 30);

    private FakePaperStore store;
    private StoreReader reader;
    private ReviewService reviews;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.dbNow = NOW;
        PaperSettingsService settings = PaperFixtures.settings(store);
        store.initSettingsIfAbsent(settings.defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        PaperMarketData marketData = new PaperMarketData(reader, mock(StoreRepository.class), clock);
        AiService ai = new AiService(240, 60, 180);
        PaperApiCalls calls = new PaperApiCalls(store, settings);
        FrameworkService framework = new FrameworkService(store, ai, settings, calls, MAPPER, 30, clock);
        reviews = new ReviewService(store, reader, marketData, framework, calls, ai, settings, MAPPER, 30, clock);

        store.insertReviewIfAbsent(review(Book.MARKET_US, PREVIOUS, Review.OK));
        store.insertReviewIfAbsent(review(Book.MARKET_US, US_WEEK, Review.API_ERROR));
        store.insertReviewIfAbsent(review(Book.MARKET_KR, PREVIOUS, Review.OK));
        store.insertReviewIfAbsent(review(Book.MARKET_KR, KR_WEEK, Review.API_ERROR));
    }

    private static Review review(String market, LocalDate week, String status) {
        boolean ok = Review.OK.equals(status);
        return new Review(week, 4, MAPPER.createObjectNode(), "{}",
                ok ? MAPPER.readTree("{\"verdicts\":[{\"decisionId\":1,\"thesisHeld\":\"유지\"}]}") : null, null,
                "claude-sonnet", null, status, ok ? null : "[HTTP] 500", null, 0, 0, NOW.minusSeconds(3_600), market);
    }

    private PaperMarkets.Scope scope(PaperConfig config) {
        return new PaperMarkets(store, reader).scope(KrPaperMarket.INSTANCE, config);
    }

    private static PaperConfig krConfig() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, S, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    private void krBooks() {
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, null, PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }
    }

    @Test
    @DisplayName("미국 목록·한 건은 그대로 — 미국 행만, 미국 달력의 최근 주(10-09)·토요일 09:00, 한국 칸 없음, 한국 주는 400")
    @SuppressWarnings("unchecked")
    void usViewsAreUnchanged() {
        Map<String, Object> us = reviews.listView();

        assertThat(us).doesNotContainKeys("market", "dormantReason")
                .containsEntry("latestWeekEnding", "2026-10-09").containsEntry("latestOpensAtKst", "2026-10-10 09:00 KST");
        assertThat((List<Map<String, Object>>) us.get("reviews")).extracting(r -> r.get("weekEnding") + " " + r.get("retryable"))
                .containsExactly("2026-10-09 true", "2026-10-02 false");
        assertThat(((Map<String, Object>) reviews.detailView("2026-10-09").get("review"))).containsEntry("retryable", true);
        assertThatThrownBy(() -> reviews.detailView("2026-10-08")).isInstanceOf(InvalidRequestException.class)
                .hasMessage("없는 복기입니다: 2026-10-08");
    }

    @Test
    @DisplayName("한국 목록: 한국 행만, 최근 주는 KRX 달력(한글날 휴장 → 10-08 목요일)·여는 시각 토요일 22:30 KST, 그 주 API 오류 행만 다시 부를 수 있음")
    @SuppressWarnings("unchecked")
    void koreanListUsesTheRunCalendar() {
        krBooks();

        Map<String, Object> kr = reviews.listView(scope(krConfig()));

        assertThat(List.copyOf(kr.keySet())).containsExactly("available", "market", "dormantReason", "reviews",
                "latestWeekEnding", "latestOpensAtKst");
        assertThat(kr).containsEntry("market", "KR").containsEntry("dormantReason", null)
                .containsEntry("latestWeekEnding", "2026-10-08").containsEntry("latestOpensAtKst", "2026-10-10 22:30 KST");
        assertThat((List<Map<String, Object>>) kr.get("reviews")).extracting(r -> r.get("weekEnding") + " " + r.get("retryable"))
                .containsExactly("2026-10-08 true", "2026-10-02 false");
    }

    @Test
    @DisplayName("한국 한 건: 한국 행을 그 시장 최근 주로 다시 부를 수 있음까지, 없는 한국 주는 400(시장을 적음)")
    @SuppressWarnings("unchecked")
    void koreanDetail() {
        krBooks();

        Map<String, Object> detail = reviews.detailView(scope(krConfig()), "2026-10-08");

        assertThat(detail).containsEntry("available", true).containsEntry("market", "KR")
                .containsEntry("dormantReason", null);
        Map<String, Object> review = (Map<String, Object>) detail.get("review");
        assertThat(review).containsEntry("weekEnding", "2026-10-08").containsEntry("status", Review.API_ERROR)
                .containsEntry("retryable", true);
        assertThatThrownBy(() -> reviews.detailView(scope(krConfig()), "2026-10-09"))
                .isInstanceOf(InvalidRequestException.class).hasMessage("없는 복기입니다: KR 2026-10-09");
        assertThatThrownBy(() -> reviews.detailView(scope(krConfig()), "2026-13-01"))
                .isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("쉬는 한국(출발일 없음): 목록은 예외 없이 쉬는 사유와 함께, 없는 주의 400 문구에도 그 사유")
    void dormantKoreaCarriesTheReason() {
        Map<String, Object> kr = reviews.listView(scope(PaperFixtures.config()));

        assertThat(kr).containsEntry("dormantReason", PaperConfig.KR_START_MISSING)
                .containsEntry("latestWeekEnding", "2026-10-08");
        assertThatThrownBy(() -> reviews.detailView(scope(PaperFixtures.config()), "2026-09-25"))
                .isInstanceOf(InvalidRequestException.class)
                .hasMessage("없는 복기입니다: KR 2026-09-25 — " + PaperConfig.KR_START_MISSING);
    }

    @Test
    @DisplayName("한국 달력이 지금의 해를 모르면(공휴일 저장본 없음) 최근 주·여는 시각만 null + 사유, 다시 부를 수 있음은 모두 false")
    @SuppressWarnings("unchecked")
    void unknownKoreanYear() {
        krBooks();
        KrFixtures.stubHolidays(reader, null);

        Map<String, Object> kr = reviews.listView(scope(krConfig()));

        assertThat(kr).containsEntry("latestWeekEnding", null).containsEntry("latestOpensAtKst", null);
        assertThat((String) kr.get("latestWeekEndingReason")).startsWith("달력 없음");
        assertThat((List<Map<String, Object>>) kr.get("reviews")).allSatisfy(r -> assertThat(r.get("retryable")).isEqualTo(false));
        assertThat((Map<String, Object>) reviews.detailView(scope(krConfig()), "2026-10-08").get("review"))
                .containsEntry("retryable", false);
    }

    @Test
    @DisplayName("테이블이 없으면 미국·한국 모두 available:false")
    void notReady() {
        store.ready = false;

        assertThat(reviews.listView(scope(krConfig()))).containsEntry("available", false);
        assertThat(reviews.detailView(scope(krConfig()), "2026-10-08")).containsEntry("available", false);
    }
}
