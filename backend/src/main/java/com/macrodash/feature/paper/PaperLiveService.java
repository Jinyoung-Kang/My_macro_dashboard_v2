package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
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

    /** 장 상태 — 그 시장 달력의 정규장 기준(장 전·정규장·마감 뒤 같은 날·휴장일). 달력이 그해를 모르면 UNKNOWN. */
    static final String PRE = "PRE";
    static final String REGULAR = "REGULAR";
    static final String AFTER = "AFTER";
    static final String CLOSED = "CLOSED";
    static final String UNKNOWN = "UNKNOWN";
    static final String LIVE = "LIVE";
    static final String LAST_OBSERVATION = "LAST_OBSERVATION";
    /** 봉 시각이 지금보다 이만큼 앞서도(시계 차이) 받습니다. 마감 뒤에는 마감 + 이 값까지의 봉이 그날 마지막 장중 값입니다. */
    static final Duration CLOCK_SLACK = Duration.ofMinutes(2);

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

    /** 장 상태 한 벌 — 그 시장 시간대의 세션 날짜와 정규장 시작·끝, 다음 개장(모르면 null). */
    record Session(String phase, LocalDate sessionDate, Instant openAt, Instant closeAt, Instant nextOpenAt) {

        boolean intraday() {
            return REGULAR.equals(phase) || AFTER.equals(phase);
        }
    }

    /** 장중 시세 한 건 — 이어받은 값({@code isStale})이면 {@code stale}. */
    record LivePrice(double price, Instant at, boolean stale) {
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
        Session session = session(run.calendar(), now);

        String dataset = korea ? Datasets.SNAP_PAPER_LIVE_KR : Datasets.SNAP_PAPER_LIVE_US;
        String task = korea ? "paper_live_kr" : "paper_live_us";
        // 정규장이면 화면이 보는 지금 받습니다(오래됐으면 요청하고 기존 값을 먼저 보여 줌). 장 밖에서는 수집을 깨우지 않습니다.
        Optional<Snapshot> snapshot = REGULAR.equals(session.phase())
                ? reader.read(dataset, Datasets.MAX_AGE_LIVE, task) : reader.readStored(dataset);
        // 나이는 이 서비스의 시계로 잽니다(StoreReader가 같은 하한으로 수집을 요청함 — 화면이 잠시 뒤 한 번 더 읽을지 알림)
        boolean refreshRequested = REGULAR.equals(session.phase()) && (snapshot.isEmpty()
                || snapshot.get().collectedAt() == null
                || Duration.between(snapshot.get().collectedAt(), now).getSeconds() > Datasets.MAX_AGE_LIVE);
        Map<String, LivePrice> live = snapshot.map(s -> livePrices(s.payload())).orElse(Map.of());
        Map<String, Bar> bars = marketData.quotes(market).map(Quotes::bars).orElse(Map.of());

        List<Book> books = new ArrayList<>(store.books(market.code()));
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Book book : books) {
            Optional<BookState> state = store.state(book.code());
            LocalDate reference = session.intraday() ? session.sessionDate()
                    : state.map(BookState::lastNavTradingDate).orElse(null);
            NavRow previous = previousNav(store.navSeries(book.code()), reference);
            rows.add(book(book, state.orElse(null), store.positions(book.code()), previous, reference, live, bars,
                    session, now));
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

    // ------------------------------------------------------------------ 순수 계산(시험)
    /**
     * 지금 그 시장의 장 상태. 오늘(그 시장 시간대)이 거래일이면 개장 전 PRE·정규장 REGULAR·마감 뒤 AFTER, 아니면 CLOSED. 다음 개장은
     * PRE면 오늘, 그 밖은 다음 거래일 개장. 달력이 그해를 모르면 UNKNOWN(시각 없음).
     */
    static Session session(TradingCalendar calendar, Instant now) {
        try {
            LocalDate today = now.atZone(calendar.zone()).toLocalDate();
            if (calendar.isTradingDay(today)) {
                Instant open = calendar.openInstant(today);
                Instant close = calendar.closeInstant(today);
                if (now.isBefore(open)) {
                    return new Session(PRE, today, open, close, open);
                }
                Instant next = calendar.openInstant(calendar.nextTradingDay(today));
                return new Session(now.isAfter(close) ? AFTER : REGULAR, today, open, close, next);
            }
            LocalDate next = calendar.nextTradingDay(today);
            return new Session(CLOSED, calendar.previousTradingDay(today), null, null, calendar.openInstant(next));
        } catch (CalendarUnavailableException e) {
            return new Session(UNKNOWN, null, null, null, null);
        }
    }

    /** 저장본의 종목별 시세 — 가격이 양수이고 시각을 읽을 수 있는 것만. */
    static Map<String, LivePrice> livePrices(JsonNode payload) {
        Map<String, LivePrice> out = new HashMap<>();
        JsonNode tickers = Json.child(payload, "tickers");
        if (tickers == null || !tickers.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> entry : tickers.properties()) {
            Double price = Json.asDouble(entry.getValue(), "price");
            String at = Json.asText(entry.getValue(), "at");
            if (price == null || !(price > 0) || at == null) {
                continue;
            }
            try {
                Instant moment = java.time.OffsetDateTime.parse(at).toInstant();
                out.put(entry.getKey(), new LivePrice(price, moment, Json.asBoolean(entry.getValue(), "isStale")));
            } catch (DateTimeParseException ignored) {
                // 시각을 모르는 값은 장중 값으로 쓰지 않습니다
            }
        }
        return out;
    }

    /** 그날 세션 안의 이어받지 않은 봉만 장중 값 — 세션 시작 이후, 지금(마감 뒤면 마감) + 여유 이하. */
    static boolean accepted(LivePrice price, Session session, Instant now) {
        if (price == null || price.stale() || !session.intraday() || session.openAt() == null) {
            return false;
        }
        Instant until = (now.isAfter(session.closeAt()) ? session.closeAt() : now).plus(CLOCK_SLACK);
        return !price.at().isBefore(session.openAt()) && !price.at().isAfter(until);
    }

    /** 기준 거래일 앞(엄격히 이전)의 마지막 순자산 줄. 기준일을 모르거나 없으면 null. */
    static NavRow previousNav(List<NavRow> rows, LocalDate reference) {
        if (reference == null || rows == null) {
            return null;
        }
        NavRow found = null;
        for (NavRow row : rows) {
            if (row.tradingDate().isBefore(reference) && (found == null || row.tradingDate().isAfter(found.tradingDate()))) {
                found = row;
            }
        }
        return found;
    }

    /** 계좌 한 줄과 종목들(클래스 설명의 값 규칙). 출발 전이거나 장부 상태가 없으면 금액·수익률은 null. */
    static Map<String, Object> book(Book book, BookState state, List<Position> positions, NavRow previous,
                                    LocalDate reference, Map<String, LivePrice> live, Map<String, Bar> bars,
                                    Session session, Instant now) {
        boolean started = !PaperBooks.NOT_STARTED.equals(book.status()) && state != null;
        List<Map<String, Object>> holdings = new ArrayList<>();
        double equity = 0;
        boolean priced = true;
        int liveCount = 0;
        Instant oldestLive = null;
        for (Position position : positions) {
            LivePrice quote = live.get(position.ticker());
            boolean isLive = accepted(quote, session, now);
            Double price = isLive ? Double.valueOf(quote.price()) : position.lastPrice();
            Instant priceAt = isLive ? quote.at() : position.lastPriceAt();
            if (isLive) {
                liveCount++;
                oldestLive = oldestLive == null || quote.at().isBefore(oldestLive) ? quote.at() : oldestLive;
            }
            Double previousClose = previousClose(bars.get(position.ticker()), reference);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", position.ticker());
            row.put("qty", position.qty());
            row.put("avgCost", PaperQueryService.round2(position.avgCost()));
            row.put("price", price == null ? null : round4(price));
            row.put("priceAtKst", priceAt == null ? null : Kst.stamp(priceAt));
            row.put("priceBasis", price == null ? null : isLive ? LIVE : LAST_OBSERVATION);
            row.put("value", price == null ? null : PaperQueryService.round2(price * position.qty()));
            row.put("returnPct", price == null || !(position.avgCost() > 0) ? null : pct(price / position.avgCost()));
            row.put("previousClose", previousClose == null ? null : round4(previousClose));
            row.put("dayChangePct", price == null || previousClose == null || !(previousClose > 0) ? null
                    : pct(price / previousClose));
            holdings.add(row);
            if (price == null) {
                priced = false;
            } else {
                equity += price * position.qty();
            }
        }
        Double nav = started && priced ? state.cash() + equity : null;
        for (Map<String, Object> row : holdings) {
            Object value = row.get("value");
            row.put("weightPct", nav == null || !(nav > 0) || value == null ? null
                    : PaperQueryService.round2((Double) value / nav * 100.0));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", book.code());
        out.put("label", book.label());
        out.put("status", book.status());
        out.put("initialCash", PaperQueryService.round2(book.initialCash()));
        out.put("cash", started ? PaperQueryService.round2(state.cash()) : null);
        out.put("nav", nav == null ? null : PaperQueryService.round2(nav));
        out.put("returnPct", nav == null || !(book.initialCash() > 0) ? null : pct(nav / book.initialCash()));
        out.put("previousNav", previous == null ? null : PaperQueryService.round2(previous.nav()));
        out.put("previousTradingDate", previous == null ? null : previous.tradingDate().toString());
        out.put("dayChangePct", nav == null || previous == null || !(previous.nav() > 0) ? null : pct(nav / previous.nav()));
        out.put("basis", liveCount > 0 ? LIVE : LAST_OBSERVATION);
        Instant basisAt = liveCount > 0 ? oldestLive : started ? state.lastObservedAt() : null;
        out.put("basisAtKst", basisAt == null ? null : Kst.stamp(basisAt));
        out.put("liveCount", liveCount);
        out.put("positionCount", positions.size());
        out.put("positions", holdings);
        return out;
    }

    /** 관측치 일봉에서 기준 거래일 앞(엄격히 이전)의 마지막 종가. 모르면 null. */
    static Double previousClose(Bar bar, LocalDate reference) {
        if (bar == null || reference == null) {
            return null;
        }
        DailySeries recent = bar.recent();
        if (recent != null && !recent.isEmpty()) {
            return recent.floorValue(reference.minusDays(1));
        }
        return bar.date() != null && bar.date().isBefore(reference) ? bar.close() : null;
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

    /** 배수 → 퍼센트(소수 둘째 자리). */
    private static Double pct(double ratio) {
        return PaperQueryService.round2((ratio - 1.0) * 100.0);
    }

    private static Double round4(double value) {
        return PaperQueryService.round4(value);
    }
}
