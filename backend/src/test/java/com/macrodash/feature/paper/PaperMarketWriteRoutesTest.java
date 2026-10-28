package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 화면 경로의 쓰기·실행 POST가 받는 시장 값(2단계 명세 §4-16, F1b) — 컨트롤러를 실제 서비스(가짜 저장소·가짜 저장본 읽기)로 부릅니다. 값이 없거나 US면
 * 미국 경로 그대로, KR이면 그 시장 판(머리에 {@code market}), 그 밖 값은 아무것도 쓰기 전에 400. 한국 초기화는 멱등이고 출발일 검사에 걸리면 400,
 * 쉬는 한국의 리스크 점검은 예외가 아니라 {@code ok:false}와 쉬는 사유입니다. 외부 호출 없음.
 */
class PaperMarketWriteRoutesTest {

    /** 한국 출발일 S — 2026-11-30(월). */
    private static final LocalDate S = LocalDate.of(2026, 11, 30);
    /** 출발 며칠 전(2026-11-27 금 12:00 KST). */
    private static final Clock BEFORE = Clock.fixed(Instant.parse("2026-11-27T03:00:00Z"), ZoneOffset.UTC);

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;
    private PaperLedgerService ledger;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = new PaperMarketData(reader, mock(StoreRepository.class));
        ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
    }

    private static PaperConfig krConfig(LocalDate start) {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, start, PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    /** 장부 컨트롤러 — 운영 시장 목록(미국·한국), 같은 장부·같은 시계. */
    private PaperController paper(PaperConfig config, Clock clock) {
        PaperSettingsService settings = PaperFixtures.settings(store);
        return new PaperController(new PaperQueryService(store, marketData, reader, settings, config, clock),
                new PaperAdminService(store, marketData, reader, settings, ledger, config, PaperFixtures.MAPPER, clock),
                new PaperRiskJob(store, reader, marketData, ledger, config, PaperFixtures.MAPPER, clock),
                mock(PaperSelectionService.class), new PaperMarkets(store, reader));
    }

    private List<String> krBooks() {
        return store.books.values().stream().filter(b -> "KR".equals(b.market())).map(b -> b.code()).toList();
    }

    @Test
    @DisplayName("POST /init?market=KR — 한국 초기화: 머리 market·출발일, 네 계좌 '시작 전'·설정 판 한 번. 다시 누르면 아무것도 바꾸지 않음(멱등)")
    void krInitIsIdempotent() {
        PaperController paper = paper(krConfig(S), BEFORE);

        Map<String, Object> first = paper.init("KR");

        assertThat(first.keySet()).containsExactly("ok", "market", "startDate", "created", "settingsCreated",
                "settingsVersion", "settingsKeysWritten");
        assertThat(first).containsEntry("ok", true).containsEntry("market", "KR").containsEntry("startDate", "2026-11-30")
                .containsEntry("settingsCreated", true).containsEntry("settingsVersion", 1);
        assertThat(first.get("created")).isEqualTo(List.of("kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix"));
        assertThat(krBooks()).hasSize(4);
        assertThat(store.books.values()).allSatisfy(b -> assertThat(b.status()).isEqualTo(PaperBooks.NOT_STARTED));
        assertThat(store.books).as("미국 계좌는 만들지 않음").doesNotContainKeys("rules", "claude", "bench_spy", "bench_mix");

        Map<String, Object> again = paper.init("KR");
        assertThat(again.get("created")).isEqualTo(List.of());
        assertThat(again.get("settingsKeysWritten")).isEqualTo(List.of());
        assertThat(again).containsEntry("settingsVersion", 1).containsEntry("settingsCreated", false);
        assertThat(store.settings.version()).isEqualTo(1);
        assertThat(store.orders).as("사후 체결·주문 없음(K28)").isEmpty();
    }

    @Test
    @DisplayName("POST /init?market=KR — 출발한 뒤(계좌 운용·현금이 바뀜, 출발 기한 지남) 다시 눌러도 계좌·상태·설정 판을 건드리지 않음")
    void krInitAfterTheStartChangesNothing() {
        paper(krConfig(S), BEFORE).init("KR");
        for (String code : krBooks()) {
            store.updateBookStatus(code, PaperBooks.ACTIVE);
            store.updateBookStartedOn(code, S);
            com.macrodash.store.PaperStore.BookState state = store.states.get(code);
            store.upsertState(new com.macrodash.store.PaperStore.BookState(code, 1_234, state.nav(), state.equityValue(),
                    state.exposurePct(), state.lastObservedAt(), state.lastProcessedCollectedAt(), S, null));
        }
        Map<String, com.macrodash.store.PaperStore.Book> books = Map.copyOf(store.books);
        Map<String, com.macrodash.store.PaperStore.BookState> states = Map.copyOf(store.states);

        Clock later = Clock.fixed(Instant.parse("2026-12-02T03:00:00Z"), ZoneOffset.UTC);   // S+2 정오 — 출발 기한 지남
        Map<String, Object> again = paper(krConfig(S), later).init("KR");

        assertThat(again.get("created")).isEqualTo(List.of());
        assertThat(store.books).isEqualTo(books);
        assertThat(store.states).isEqualTo(states);
        assertThat(store.settings.version()).isEqualTo(1);
    }

    @Test
    @DisplayName("POST /init?market=KR — 출발일이 비었거나 KRX 거래일이 아니면 400(아무것도 만들지 않음)")
    void krInitRefusesABadStartDate() {
        assertThatThrownBy(() -> paper(PaperFixtures.config(), BEFORE).init("KR"))
                .isInstanceOf(InvalidRequestException.class).hasMessage(PaperConfig.KR_START_MISSING);
        assertThatThrownBy(() -> paper(krConfig(LocalDate.of(2026, 11, 28)), BEFORE).init("KR"))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("KRX 거래일이 아닙니다");
        assertThat(store.books).isEmpty();
        assertThat(store.settings).isNull();
    }

    @Test
    @DisplayName("모르는 시장 값은 아무것도 쓰기 전에 400 — 초기화·리스크 점검(빈 값·소문자·공백 포함)")
    void unknownMarketIsRefusedBeforeAnyWrite() {
        PaperController paper = paper(krConfig(S), BEFORE);
        for (String market : new String[]{"JP", "", "kr", " KR"}) {
            assertThatThrownBy(() -> paper.init(market)).as("init '" + market + "'")
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("market는 US · KR 가운데 하나여야 합니다");
            assertThatThrownBy(() -> paper.runRisk(market)).as("run/risk '" + market + "'")
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("market는 US · KR 가운데 하나여야 합니다");
        }
        assertThat(store.books).isEmpty();
        assertThat(store.jobRuns).isEmpty();
    }

    @Test
    @DisplayName("POST /run/risk?market=KR — 쉬는 한국은 예외가 아니라 ok:false·쉬는 사유(실행을 열지 않음), 초기화 뒤에는 그 시장 실행의 결과(관측치 저장본 없음) — 미국 응답은 시장 값 없음·US가 같음")
    void krRiskRun() {
        Map<String, Object> dormant = paper(PaperFixtures.config(), BEFORE).runRisk("KR");
        assertThat(dormant.keySet()).containsExactly("ok", "market", "dormantReason", "outcome");
        assertThat(dormant).containsEntry("ok", false).containsEntry("market", "KR")
                .containsEntry("dormantReason", PaperConfig.KR_START_MISSING);
        assertThat(((PaperLedgerService.Outcome) dormant.get("outcome")).skippedReason())
                .isEqualTo(PaperConfig.KR_START_MISSING);
        assertThat(store.jobRuns).isEmpty();

        PaperController paper = paper(krConfig(S), BEFORE);
        paper.init("KR");
        Map<String, Object> ready = paper.runRisk("KR");
        assertThat(ready).containsEntry("ok", true).containsEntry("market", "KR").containsEntry("dormantReason", null);
        assertThat(((PaperLedgerService.Outcome) ready.get("outcome")).skippedReason()).contains("paper.kr.quotes");

        Map<String, Object> us = paper.runRisk(null);
        assertThat(us.keySet()).as("미국 응답 그대로").containsExactly("ok", "outcome");
        assertThat(paper.runRisk("US")).isEqualTo(us);
    }
}
