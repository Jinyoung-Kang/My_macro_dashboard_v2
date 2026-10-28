package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 개요·상태의 시장 값(2단계 명세 §4-16 '?market', F1) — 값이 없거나 US면 미국 응답이 시장을 받기 전과 같고, 모르는 값은 400, 한국은 그 조회
 * 실행의 KRX 달력(통계 표본·관측치 확정·늦음)·원 장부·한국 작업 기록·{@code kr.*} 설정 키로 답하며, 정기 작업이 쉬는 한국(출발일·한국 계좌
 * 없음)은 예외가 아니라 그 사유를 싣습니다.
 */
class PaperQueryMarketTest {

    /** 2026-10-13(화) 10:00 KST — 미국 10-12 세션이 끝났고, 한국은 10-12 밤 수집 뒤·10-13 장 전. */
    private static final Instant NOW = Instant.parse("2026-10-13T01:00:00Z");
    private static final LocalDate S = LocalDate.of(2026, 11, 30);
    /** 한국 관측치 세션(10-09 한글날 휴장 뒤 첫 거래일 10-12) — 그날 22:00 KST 수집. */
    private static final LocalDate KR_SESSION = LocalDate.of(2026, 10, 12);
    private static final Instant KR_COLLECTED = kst("2026-10-12T22:00");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = new PaperMarketData(reader, mock(StoreRepository.class), Clock.fixed(NOW, ZoneOffset.UTC));
        store.recordJobRun("risk", NOW.minusSeconds(600), NOW.minusSeconds(590), "ok", null);
        store.recordJobRun("kr.decision", NOW.minusSeconds(300), NOW.minusSeconds(290), "DORMANT", null);
        store.recordJobRun("decision", NOW.minusSeconds(60), NOW.minusSeconds(50), "DECIDED", null);
    }

    private static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), com.macrodash.Kst.ZONE).toInstant();
    }

    private PaperQueryService query(PaperConfig config) {
        return new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store), config,
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static PaperConfig krConfig(LocalDate start) {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    /** 한국 네 계좌 — KODEX 200 계좌만 10-08 출발(운용), 순자산 줄 10-08·10-12, 나머지는 현금만 든 시작 전. */
    private void krBooks() {
        for (PaperBooks.Definition d : PaperBooks.KR) {
            boolean started = PaperBooks.KR_BENCH_K200.equals(d.code());
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000,
                    started ? LocalDate.of(2026, 10, 8) : null, started ? PaperBooks.ACTIVE : PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
            store.states.put(d.code(), new BookState(d.code(), started ? 34_000 : 100_000_000,
                    started ? 101_034_000 : 100_000_000, started ? 101_000_000 : 0, started ? 99.97 : 0, KR_COLLECTED,
                    KR_COLLECTED, null, null));
        }
        store.upsertNav(new NavRow(PaperBooks.KR_BENCH_K200, LocalDate.of(2026, 10, 8), 99_950_000, 34_000,
                99_916_000, 99.97, true));
        store.upsertNav(new NavRow(PaperBooks.KR_BENCH_K200, KR_SESSION, 101_034_000, 34_000, 101_000_000, 99.97,
                false));
    }

    private void krQuotes() {
        KrFixtures.stub(reader, Datasets.SNAP_KR_PAPER_QUOTES, KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES,
                KrFixtures.quotesPayload(KR_SESSION, Map.of("069500", KR_SESSION, "153130", KR_SESSION)), KR_COLLECTED));
    }

    @Test
    @DisplayName("시장 값이 없거나 US면 개요·상태가 시장을 받기 전 미국 응답과 글자 하나까지 같다 — 한국 칸(market·dormantReason)이 붙지 않고 작업 기록은 모든 작업")
    void usResponsesAreUnchanged() {
        krBooks();
        krQuotes();
        PaperQueryService query = query(krConfig(S));
        String overview = MAPPER.writeValueAsString(query.overview());
        String status = MAPPER.writeValueAsString(query.status());

        assertThat(MAPPER.writeValueAsString(query.overview((String) null))).isEqualTo(overview);
        assertThat(MAPPER.writeValueAsString(query.overview("US"))).isEqualTo(overview);
        assertThat(MAPPER.writeValueAsString(query.status((String) null))).isEqualTo(status);
        assertThat(MAPPER.writeValueAsString(query.status("US"))).isEqualTo(status);
        Map<String, Object> us = query.overview("US");
        assertThat(us).doesNotContainKeys("market", "currency", "dormantReason");
        assertThat((List<?>) us.get("books")).as("미국 계좌만(한국 계좌는 빠짐)").isEmpty();
        assertThat(jobNames(us)).containsExactly("decision", "kr.decision", "risk");
        assertThat(query.status("US")).doesNotContainKeys("market", "currency", "dormantReason")
                .containsEntry("startDate", "2026-10-23").containsEntry("initialCash", 100_000.0);
    }

    @Test
    @DisplayName("모르는 시장 값(JP·빈 값·소문자)은 개요·상태 모두 400")
    void unknownMarketIsRejected() {
        PaperQueryService query = query(PaperFixtures.config());
        for (String market : List.of("JP", "", "kr")) {
            assertThatThrownBy(() -> query.overview(market)).as(market).isInstanceOf(InvalidRequestException.class)
                    .hasMessageContaining("market는 US · KR 가운데 하나여야 합니다");
            assertThatThrownBy(() -> query.status(market)).as(market).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("쉬는 한국(출발일·한국 계좌 없음): 예외가 아니라 쉬는 사유 — 계좌 없음·초기화 전, 미국 전용 칸은 비우고 작업 기록은 kr.만, 상태는 원 초기 현금·공유 호출 사용량")
    @SuppressWarnings("unchecked")
    void dormantKoreaCarriesTheReason() {
        PaperQueryService query = query(PaperFixtures.config());

        Map<String, Object> overview = query.overview("KR");
        assertThat(List.copyOf(overview.keySet()).subList(0, 5))
                .containsExactly("available", "market", "currency", "dormantReason", "initialized");
        assertThat(overview).containsEntry("available", true).containsEntry("market", "KR")
                .containsEntry("currency", "KRW").containsEntry("dormantReason", PaperConfig.KR_START_MISSING)
                .containsEntry("initialized", false).containsEntry("startDate", null)
                .containsEntry("quotes", null).containsEntry("selection", null).containsEntry("gate", null)
                .containsEntry("limits", List.of()).containsEntry("pendingBackfill", List.of());
        assertThat((List<?>) overview.get("books")).isEmpty();
        assertThat(jobNames(overview)).containsExactly("kr.decision");

        Map<String, Object> status = query.status("KR");
        assertThat(status).containsEntry("market", "KR").containsEntry("dormantReason", PaperConfig.KR_START_MISSING)
                .containsEntry("schemaReady", true).containsEntry("initialized", false)
                .containsEntry("startDate", null).containsEntry("initialCash", 100_000_000L)
                .containsEntry("settingsVersion", 1).containsEntry("settingsFallbacks", List.of())
                .containsEntry("fundamentals", null).containsEntry("calendar", null).containsEntry("news", null)
                .containsEntry("earnings", null);
        assertThat(jobNames(status)).containsExactly("kr.decision");
        Map<String, Object> today = (Map<String, Object>) ((Map<String, Object>) status.get("apiUsage")).get("today");
        assertThat(today).containsEntry("cap", 20).containsEntry("scheduledReserve", 7).containsEntry("manualLimit", 13);
        assertThat(MAPPER.writeValueAsString(status.get("apiUsage")))
                .as("호출 사용량은 시장과 상관없이 하나(상한 공유)")
                .isEqualTo(MAPPER.writeValueAsString(query.status().get("apiUsage")));

        PaperQueryService preInit = query(krConfig(S));
        assertThat(preInit.overview("KR")).as("출발일은 있으나 한국 초기화 전")
                .containsEntry("dormantReason", KrPaperMarket.NOT_INITIALIZED).containsEntry("startDate", "2026-11-30");
        assertThat(preInit.status("KR")).containsEntry("dormantReason", KrPaperMarket.NOT_INITIALIZED);
    }

    @Test
    @DisplayName("한국: 그 조회 실행의 KRX 달력 — 한글날(10-09) 휴장이라 10-08→10-12 표본 1거래일, 관측치는 한국 늦음 규칙(36시간 아님 — 다음 수집 예정 + 여유), 정의 순 네 계좌·원 금액")
    @SuppressWarnings("unchecked")
    void koreaUsesTheRunCalendar() {
        krBooks();
        krQuotes();
        PaperQueryService query = query(krConfig(S));

        Map<String, Object> overview = query.overview("KR");
        assertThat(overview).containsEntry("dormantReason", null).containsEntry("initialized", true)
                .containsEntry("startDate", "2026-11-30");
        List<Map<String, Object>> books = (List<Map<String, Object>>) overview.get("books");
        assertThat(books).extracting(b -> b.get("code"))
                .containsExactly("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix");
        Map<String, Object> k200 = books.get(2);
        assertThat(k200).containsEntry("benchmark", null).containsEntry("nav", 101_034_000.0)
                .containsEntry("initialCash", 100_000_000.0).containsEntry("statsReason", null);
        Map<String, Object> stats = (Map<String, Object>) k200.get("stats");
        assertThat(stats.get("sampleDays")).as("KRX 달력: 10-09 휴장(미국 달력이면 2)").isEqualTo(1);
        assertThat(books.get(0)).containsEntry("benchmark", "kr_bench_k200").containsEntry("returnPct", null);
        assertThat((List<String>) ((Map<String, Object>) overview.get("navSeries")).get("dates"))
                .containsExactly("2026-10-08", "2026-10-12");

        Map<String, Object> quotes = (Map<String, Object>) overview.get("quotes");
        assertThat(quotes).containsEntry("barDate", "2026-10-12").containsEntry("finalClose", true)
                .containsEntry("stale", false).containsEntry("tickers", 2).containsEntry("ageSeconds", 12L * 3600)
                .containsEntry("collectedAtKst", "2026-10-12 22:00 KST");
        assertThat(query.status("KR").get("quotes")).isEqualTo(quotes);
        assertThat(query.status("KR")).containsEntry("initialized", true).containsEntry("dormantReason", null);
    }

    @Test
    @DisplayName("한국 상태의 설정 키: 그 실행이 읽은 설정 행에 한국 묶음이 없으면 kr.* 이름으로 기본값 키(설정 화면의 한국 읽기와 같은 목록, 미국 gate 등은 빠짐)")
    @SuppressWarnings("unchecked")
    void koreaStatusListsKoreanFallbacks() {
        PaperFixtures.dropKrDefaults(store);

        List<String> fallbacks = (List<String>) query(PaperFixtures.config()).status("KR").get("settingsFallbacks");

        assertThat(fallbacks).isEqualTo(PaperSettingsService.krFallbacks(store.settings().orElseThrow().body()))
                .contains("kr.slippageBp", "kr.trailingStopPct", "kr.commissionBp").allMatch(k -> k.startsWith("kr."));
    }

    @Test
    @DisplayName("한국 달력이 순자산 줄의 해를 모르면(공휴일 저장본 없음) 통계·관측치 확정만 null + 사유 — 응답은 실패하지 않는다")
    @SuppressWarnings("unchecked")
    void unknownKoreanYearIsNullWithReason() {
        krBooks();
        krQuotes();
        KrFixtures.stubHolidays(reader, null);

        Map<String, Object> overview = query(krConfig(S)).overview("KR");

        Map<String, Object> k200 = ((List<Map<String, Object>>) overview.get("books")).get(2);
        assertThat(k200.get("stats")).isNull();
        assertThat((String) k200.get("statsReason")).isNotBlank();
        Map<String, Object> quotes = (Map<String, Object>) overview.get("quotes");
        assertThat(quotes.get("finalClose")).isNull();
        assertThat((String) quotes.get("finalCloseReason")).isNotBlank();
    }

    @Test
    @DisplayName("결정 목록(계좌 코드 경로 그대로 — ?market 없음): book=kr_rules·kr_claude는 그 계좌 결정만, 쉬는 한국은 빈 목록, 미국 book은 그대로, 모르는 값은 네 코드를 적은 400")
    @SuppressWarnings("unchecked")
    void decisionsTakeKoreanBookCodes() {
        PaperQueryService query = query(PaperFixtures.config());
        assertThat((List<?>) query.decisions(PaperBooks.KR_RULES, 50).get("decisions")).as("쉬는 한국 — 결정 없음").isEmpty();
        assertThat((List<?>) query.decisions(PaperBooks.KR_CLAUDE, 50).get("decisions")).isEmpty();

        decision(PaperBooks.RULES, LocalDate.of(2026, 10, 12), "SCHEDULED", null, null);
        decision(PaperBooks.KR_RULES, S, "INITIAL", S, 79.4869);
        decision(PaperBooks.KR_RULES, LocalDate.of(2026, 12, 1), "REBALANCE", LocalDate.of(2026, 12, 1), 80.0);
        decision(PaperBooks.KR_CLAUDE, S, "INITIAL", null, 60.0);

        List<Map<String, Object>> rules = (List<Map<String, Object>>) query.decisions(PaperBooks.KR_RULES, 50)
                .get("decisions");
        assertThat(rules).extracting(r -> r.get("book") + " " + r.get("asOfTradingDate") + " " + r.get("kind") + " "
                        + r.get("selectionAsOf") + " " + r.get("targetExposurePct"))
                .containsExactly("kr_rules 2026-12-01 REBALANCE 2026-12-01 80.0", "kr_rules 2026-11-30 INITIAL 2026-11-30 79.49");
        assertThat((List<Map<String, Object>>) query.decisions(PaperBooks.KR_CLAUDE, 1).get("decisions"))
                .extracting(r -> r.get("book")).containsExactly("kr_claude");
        assertThat((List<Map<String, Object>>) query.decisions(PaperBooks.RULES, 50).get("decisions"))
                .extracting(r -> r.get("book")).containsExactly("rules");
        assertThatThrownBy(() -> query.decisions("kr_bench_k200", 50)).isInstanceOf(InvalidRequestException.class)
                .hasMessage("book는 rules · claude · kr_rules · kr_claude 가운데 하나여야 합니다: kr_bench_k200");
    }

    private void decision(String book, LocalDate asOf, String kind, LocalDate selectionAsOf, Double exposure) {
        store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, book, asOf, kind, null, "OK", null,
                null, 1, selectionAsOf, exposure, null, null, null, MAPPER.createObjectNode().put("summary", kind), null,
                null, null, false, 5L, 0));
    }

    @SuppressWarnings("unchecked")
    private static List<Object> jobNames(Map<String, Object> body) {
        return ((List<Map<String, Object>>) body.get("jobs")).stream().map(row -> row.get("job")).toList();
    }
}
