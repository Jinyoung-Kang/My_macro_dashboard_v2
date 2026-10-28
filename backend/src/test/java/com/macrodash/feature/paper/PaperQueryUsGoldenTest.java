package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.feature.paper.PaperMarketData.SourcedClose;
import com.macrodash.store.PaperStore.ApiUsage;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.NavRow;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.FRI;
import static com.macrodash.feature.paper.PaperFixtures.MON;
import static com.macrodash.feature.paper.PaperFixtures.MON_FINAL;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.market;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static com.macrodash.feature.paper.PaperFixtures.staleBar;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 미국 개요·상태 응답의 고정본(F1 리뷰) — 화면 경로가 {@code ?market}을 받기 전(main {@code 7c32e46})의 미국 응답을 같은 재료로 떠 둔
 * {@code paper/golden/paper-overview-us.json}·{@code paper-status-us.json}과 <b>글자 그대로</b> 견줍니다. 시장 값 없음·{@code US}·옛 시그니처
 * 셋이 모두 그 고정본과 같아야 합니다 — 새 코드끼리만 견주는 {@link PaperQueryMarketTest#usResponsesAreUnchanged}가 잡지 못하는 미국 갈래 안의
 * 변화(키 순서·칸 이동·{@code settingsFallbacks} 목록)를 여기서 잡습니다.
 *
 * <p>재료: 운용 중인 Claude 계좌(보유·순자산 줄 둘·정기 결정 하나), 사후 체결한 벤치마크 둘, 시작 전 규칙 계좌, 같은 저장소의 한국 네 계좌(미국 응답에
 * 섞이면 안 됨), 미국·한국 작업 기록, 오늘 호출 사용량, 기본값으로 읽는 설정 키 셋(장부 {@code slippageBp}·{@code blend.minTargetPct}·
 * {@code rules} 묶음 통째). 외부 호출 없음 — 가짜 저장소·가짜 저장본 읽기·고정 시계.
 *
 * <p>고정본은 main 코드에 이 재료를 넣어 만들었습니다({@code git archive main backend}로 푼 트리에서 이 시험(시장 값 판 호출만 뺀 것)을
 * {@code GOLDEN_UPDATE=1}로 두 번 — 두 번 다 같은 글자). 고정본이 바뀌는 커밋은 미국 화면 응답을 바꾸는 커밋입니다({@link Golden}).
 */
class PaperQueryUsGoldenTest {

    /** 2026-10-27 06:00 KST — 미국 10-26(월) 세션이 끝나고 확정 종가를 받은 뒤. */
    private static final Instant NOW = Instant.parse("2026-10-26T21:00:00Z");

    private FakePaperStore store;
    private PaperQueryService query;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        PaperSettingsService settings = PaperFixtures.settings(store);
        // 단계 2 전 설정 행처럼 키 셋이 빠진 행 — 상태의 settingsFallbacks가 장부·섞기·규칙 책 키를 모두 싣습니다.
        ObjectNode body = (ObjectNode) settings.defaultsJson();
        body.remove("slippageBp");
        ((ObjectNode) body.get("blend")).remove("minTargetPct");
        body.remove("rules");
        store.initSettingsIfAbsent(body);

        PaperMarketData marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.sourcedCloseOn(anyString(), any())).thenReturn(Optional.empty());
        when(marketData.sourcedCloseOn("SPY", FRI)).thenReturn(Optional.of(new SourcedClose(500, "equity_close")));
        when(marketData.sourcedCloseOn("SHY", FRI)).thenReturn(Optional.of(new SourcedClose(82.5, "equity_close")));
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        PaperLedgerService ledger = new PaperLedgerService(store, marketData, PaperFixtures.MAPPER);
        new PaperAdminService(store, marketData, PaperFixtures.quietReader(), settings, ledger, PaperFixtures.config(),
                PaperFixtures.MAPPER, clock).init();
        when(marketData.quotes(market(UsPaperMarket.INSTANCE))).thenReturn(Optional.of(quotes(MON_FINAL,
                bar("SPY", FRI, 500, MON, 505), bar("AAA", FRI, 100, MON, 110), staleBar("QQQ", FRI, 400))));

        // 운용 중인 Claude 계좌 — 보유 AAA·SHY, 순자산 줄 FRI(확정)·MON(확정), MON 정기 결정(노출 60%).
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, "CLAUDE", "Claude 재량 책", 100_000, FRI,
                PaperBooks.ACTIVE, PaperFixtures.FRI_CLOSE));
        store.states.put(PaperBooks.CLAUDE, new BookState(PaperBooks.CLAUDE, 40_000, 101_000, 61_000, 60.3960,
                MON_FINAL, MON_FINAL, MON, null));
        PaperFixtures.position(store, PaperBooks.CLAUDE, "AAA", 500, 100, 110, 110.0, FRI, 100);
        PaperFixtures.position(store, PaperBooks.CLAUDE, "SHY", 100, 82.5, 82.5, null, FRI, 82.5);
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, FRI, 100_000, 41_750, 58_250, 58.25, true));
        store.upsertNav(new NavRow(PaperBooks.CLAUDE, MON, 101_000, 40_000, 61_000, 60.40, true));
        store.upsertNav(new NavRow(PaperBooks.BENCH_SPY, MON, 101_000, 450.25, 100_549.75, 99.55, true));
        store.insertDecisionIfAbsent(new Decision(0, PaperBooks.CLAUDE, MON, RuleBookService.SCHEDULED, null, "OK",
                "claude-sonnet-5-5", 0, store.settings.version(), FRI, 60.0, null, null, null,
                PaperFixtures.MAPPER.createObjectNode().put("summary", "AAA 비중 유지"), null, null, null, true, null, 0));

        // 같은 저장소의 한국 네 계좌(시작 전) — 미국 개요·상태에 섞이지 않아야 합니다.
        for (PaperBooks.Definition d : PaperBooks.KR) {
            store.books.put(d.code(), new Book(d.code(), d.kind(), d.label(), 100_000_000, null, PaperBooks.NOT_STARTED,
                    PaperFixtures.FRI_CLOSE, Book.MARKET_KR, Book.CURRENCY_KRW));
        }

        store.recordJobRun("risk", NOW.minusSeconds(900), NOW.minusSeconds(890), "ok", null);
        store.recordJobRun("kr.decision", NOW.minusSeconds(600), NOW.minusSeconds(590), "DORMANT", null);
        store.recordJobRun("decision", NOW.minusSeconds(300), NOW.minusSeconds(240), "DECIDED",
                PaperFixtures.MAPPER.createObjectNode().put("tradingDate", MON.toString()));
        LocalDate today = LocalDate.of(2026, 10, 27);
        store.apiUsage.put(today, new ApiUsage(today, 3, 12_000, 2_400, 8_000, 1_000, 0.0912, 3));

        query = new PaperQueryService(store, marketData, PaperFixtures.quietReader(), settings, PaperFixtures.config(),
                clock);
    }

    @Test
    @DisplayName("미국 개요는 main의 응답과 글자 그대로 — 옛 시그니처·시장 값 없음·US 셋 모두 고정본 paper-overview-us.json")
    void overviewMatchesTheGolden() {
        Golden.assertMatches("paper-overview-us.json", Golden.prettyJson(query.overview()));
        Golden.assertMatches("paper-overview-us.json", Golden.prettyJson(query.overview((String) null)));
        Golden.assertMatches("paper-overview-us.json", Golden.prettyJson(query.overview("US")));
    }

    @Test
    @DisplayName("미국 상태는 main의 응답과 글자 그대로(키 순서·settingsFallbacks 장부·blend·rules 이은 목록 포함) — 옛 시그니처·시장 값 없음·US 셋 모두 고정본 paper-status-us.json")
    void statusMatchesTheGolden() {
        Golden.assertMatches("paper-status-us.json", Golden.prettyJson(query.status()));
        Golden.assertMatches("paper-status-us.json", Golden.prettyJson(query.status((String) null)));
        Golden.assertMatches("paper-status-us.json", Golden.prettyJson(query.status("US")));
    }
}
