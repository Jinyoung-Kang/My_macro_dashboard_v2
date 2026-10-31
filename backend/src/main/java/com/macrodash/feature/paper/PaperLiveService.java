package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.feature.paper.LiveValuation.LivePrice;
import com.macrodash.feature.paper.LiveValuation.Session;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 모의 매매 장중 평가 — {@code GET /api/paper/live?market=US|KR}(운영자). 정규장 동안 보유 종목을 최신 1분봉 가격(수집기
 * {@code paper_live_us}·{@code paper_live_kr})으로 다시 평가해 계좌·종목 수익률이 움직이게 하고, 모든 값에 기준 시각·출처를 붙입니다.
 *
 * <p><b>표시 전용 추정</b>입니다({@code isEstimated:true}). 장부(체결·스탑·확정 순자산·통계·결정 패킷)는 지금처럼 관측치와 확정 종가로만
 * 움직이고 이 값을 읽지 않습니다 — 진행 중인 실험 조건을 바꾸지 않습니다. 시세는 화면이 볼 때만 받습니다(사용자 결정 2026-10-30): 정규장이면
 * live 읽기({@link Datasets#MAX_AGE_LIVE})가 오래된 저장본을 두고 수집을 요청하고 {@code quotes.refreshRequested:true}로 알려, 화면이
 * 잠시 뒤 한 번 더 읽습니다. 장 밖에서는 수집을 요청하지 않고 장부의 마지막 관측치로 답합니다.
 *
 * <p>값 규칙 — 가격은 그날 세션 안의 1분봉이고 오래되지 않았을 때만 장중 값(LIVE), 아니면 장부의 마지막 관측 가격(LAST_OBSERVATION)이고
 * 그것도 없으면 null(0으로 채우지 않음). '오늘 변화'는 기준 거래일 앞의 마지막 확정 순자산(정규장·장 마감 직후는 그날, 그 밖은 장부가 마지막으로
 * 평가한 거래일) 대비, 종목은 관측치 일봉의 직전 거래일 종가 대비입니다.
 */
@Service
public class PaperLiveService {

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperMarkets markets;
    private final PaperConfig config;
    private final Clock clock;

    @Autowired
    PaperLiveService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperMarkets markets,
                     PaperConfig config) {
        this(store, reader, marketData, markets, config, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    PaperLiveService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperMarkets markets,
                     PaperConfig config, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.markets = markets;
        this.config = config;
        this.clock = clock;
    }

    /** GET /api/paper/live — 클래스 설명. {@code market}이 없으면 미국, 모르는 값은 400({@link PaperMarkets#requested}). */
    public Map<String, Object> live(String marketCode) {
        if (!store.ready()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("available", false);
            out.put("message", "모의 매매 테이블이 아직 없습니다");
            return out;
        }
        PaperMarket requested = markets.requested(marketCode);
        PaperMarkets.Scope scope = markets.scope(requested, config);
        MarketRun run = scope.run();
        PaperMarket market = scope.market();
        boolean korea = Book.MARKET_KR.equals(market.code());
        Instant now = clock.instant();
        Session session = LiveValuation.session(run.calendar(), now);

        String dataset = korea ? Datasets.SNAP_PAPER_LIVE_KR : Datasets.SNAP_PAPER_LIVE_US;
        String task = korea ? "paper_live_kr" : "paper_live_us";
        // 정규장이면 화면이 보는 지금 받습니다(오래됐으면 요청하고 기존 값을 먼저 보여 줌). 장 밖에서는 수집을 깨우지 않습니다.
        Optional<Snapshot> snapshot = LiveValuation.REGULAR.equals(session.phase())
                ? reader.read(dataset, Datasets.MAX_AGE_LIVE, task) : reader.readStored(dataset);
        // 나이는 이 서비스의 시계로 잽니다(StoreReader가 같은 하한으로 수집을 요청함 — 화면이 잠시 뒤 한 번 더 읽을지 알림)
        boolean refreshRequested = LiveValuation.REGULAR.equals(session.phase()) && (snapshot.isEmpty()
                || snapshot.get().collectedAt() == null
                || Duration.between(snapshot.get().collectedAt(), now).getSeconds() > Datasets.MAX_AGE_LIVE);
        Map<String, LivePrice> live = snapshot.map(s -> LiveValuation.livePrices(s.payload())).orElse(Map.of());
        Map<String, Bar> bars = marketData.quotes(market).map(Quotes::bars).orElse(Map.of());

        List<Book> books = new ArrayList<>(store.books(market.code()));
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Book book : books) {
            Optional<BookState> state = store.state(book.code());
            LocalDate reference = session.intraday() ? session.sessionDate()
                    : state.map(BookState::lastNavTradingDate).orElse(null);
            NavRow previous = LiveValuation.previousNav(store.navSeries(book.code()), reference);
            rows.add(LiveValuation.book(book, state.orElse(null), store.positions(book.code()), previous, reference, live,
                    bars, session, now));
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("market", market.code());
        out.put("currency", market.currency());
        out.put("nowKst", Kst.stamp(now));
        out.put("session", sessionView(session));
        out.put("quotes", quotesView(snapshot.orElse(null), refreshRequested));
        out.put("isEstimated", true);
        out.put("books", rows);
        return out;
    }

    private static Map<String, Object> sessionView(Session session) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("phase", session.phase());
        out.put("sessionDate", session.sessionDate() == null ? null : session.sessionDate().toString());
        out.put("openAtKst", session.openAt() == null ? null : Kst.stamp(session.openAt()));
        out.put("closeAtKst", session.closeAt() == null ? null : Kst.stamp(session.closeAt()));
        out.put("nextOpenAtKst", session.nextOpenAt() == null ? null : Kst.stamp(session.nextOpenAt()));
        return out;
    }

    private static Map<String, Object> quotesView(Snapshot snapshot, boolean refreshRequested) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", snapshot == null ? null : Json.asText(snapshot.payload(), "source"));
        out.put("collectedAtKst", snapshot == null || snapshot.collectedAt() == null ? null : Kst.stamp(snapshot.collectedAt()));
        out.put("refreshRequested", refreshRequested);
        List<String> missing = new ArrayList<>();
        if (snapshot != null) {
            Json.array(snapshot.payload(), "missing").forEach(node -> missing.add(node.asString()));
        }
        out.put("missing", missing);
        out.put("error", snapshot == null ? null : Json.asText(snapshot.payload(), "error"));
        return out;
    }
}
