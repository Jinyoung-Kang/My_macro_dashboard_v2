package com.macrodash.feature.paper;

import com.macrodash.feature.paper.LiveValuation.Current;
import com.macrodash.feature.paper.LiveValuation.LivePrice;
import com.macrodash.feature.paper.LiveValuation.Session;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookLedger;
import com.macrodash.store.PaperStore.NavRow;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 모의 매매 개요 응답의 조립 — {@code GET /api/paper/overview?market=US|KR}. 장부 응답({@link PaperQueryService#overview(PaperMarket)})을 그대로 두고
 * 장중 '지금 값'을 덧붙입니다(명세 docs/specs/2026-10-31-paper-live-overview.md §5): 계좌마다 {@code current}({@link LiveValuation#current})·
 * {@code lastNavTradingDate}·{@code lastNavFinal}, 최상위 {@code navEstimate}({@link LiveValuation#navEstimate})·{@code liveSession}. 기존 칸은 한
 * 글자도 바꾸지 않습니다 — BookSummary는 {@code /positions}·{@code /nav}·결정 응답도 함께 쓰므로 장중 값을 넣지 않습니다.
 *
 * <p>장중 저장본은 {@link StoreReader#readStored}로만 읽습니다 — 개요는 화면이 60초마다 읽어, 여기서 수집을 요청하면 '보는 동안 사용자 간격으로만
 * 받는다'(ADR 0020 장중 평가)를 우회합니다. 수집은 {@code /live}만 깨웁니다. 관측치(paper.quotes)는 읽지 않습니다(지금 값에 필요 없음). 책·상태·보유·
 * 순자산 줄·대기 주문은 한 스냅숏({@link PaperStore#ledgers}, QA-152)이고, 장부 응답과 같은 실행(달력 한 벌)을 씁니다.
 *
 * <p>지금 값은 표시 전용입니다 — 통계·순자산 곡선·노출 추이 칸은 장부 응답 그대로이고, 장중 데이터셋을 참조할 수 있는 개요 쪽 클래스는 이것 하나입니다
 * ({@code LiveIsolationTest}).
 */
@Service
public class PaperOverviewService {

    private final PaperQueryService query;
    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarkets markets;
    private final Clock clock;

    @Autowired
    PaperOverviewService(PaperQueryService query, PaperStore store, StoreReader reader, PaperMarkets markets) {
        this(query, store, reader, markets, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperOverviewService(PaperQueryService query, PaperStore store, StoreReader reader, PaperMarkets markets,
                         Clock clock) {
        this.query = query;
        this.store = store;
        this.reader = reader;
        this.markets = markets;
        this.clock = clock;
    }

    /** GET /api/paper/overview — {@code market}이 없으면 미국, 모르는 값은 400({@link PaperMarkets#requested}). 클래스 설명. */
    public Map<String, Object> overview(String marketCode) {
        PaperMarket requested = markets.requested(marketCode);
        if (!store.ready()) {
            return query.overview(requested);
        }
        MarketRun run = markets.open(requested);
        Map<String, Object> out = query.overview(run);
        if (Boolean.TRUE.equals(out.get("available"))) {
            addLive(out, run);
        }
        return out;
    }

    /** 장부 응답에 지금 값을 덧붙입니다(클래스 설명) — 계좌 줄 순서는 장부 응답 그대로. */
    @SuppressWarnings("unchecked")
    private void addLive(Map<String, Object> out, MarketRun run) {
        boolean korea = Book.MARKET_KR.equals(run.code());
        Instant now = clock.instant();
        Session session = LiveValuation.session(run.calendar(), now);
        Map<String, LivePrice> live = reader.readStored(LiveValuation.dataset(korea))
                .map(snapshot -> LiveValuation.livePrices(snapshot.payload())).orElse(Map.of());
        Map<String, BookLedger> ledgers = new HashMap<>();
        store.ledgers(run.code()).forEach(ledger -> ledgers.put(ledger.book().code(), ledger));

        List<BookLedger> shown = new ArrayList<>();
        Map<String, Current> currents = new LinkedHashMap<>();
        for (Map<String, Object> summary : (List<Map<String, Object>>) out.get("books")) {
            BookLedger ledger = ledgers.get((String) summary.get("code"));
            if (ledger == null) {
                // 장부 응답을 읽은 뒤 스냅숏 전에 사라진 책(리셋 등) — 지금 값을 짓지 않습니다
                summary.put("current", null);
                summary.put("lastNavTradingDate", null);
                summary.put("lastNavFinal", null);
                continue;
            }
            Current current = LiveValuation.current(ledger, live, session, run.calendar(), now, korea);
            NavRow last = ledger.nav().isEmpty() ? null : ledger.nav().get(ledger.nav().size() - 1);
            summary.put("current", current.view());
            summary.put("lastNavTradingDate", last == null ? null : last.tradingDate().toString());
            summary.put("lastNavFinal", last == null ? null : last.pricesFinal());
            shown.add(ledger);
            currents.put(ledger.book().code(), current);
        }
        out.put("navEstimate", LiveValuation.navEstimate(shown, currents, session));
        out.put("liveSession", LiveValuation.sessionSummary(session));
    }
}
