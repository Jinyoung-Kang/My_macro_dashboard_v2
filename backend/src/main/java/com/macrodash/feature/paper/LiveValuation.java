package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookLedger;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 모의 매매 장중 평가의 계산 — 장 상태, 장중 1분봉 가격 고르기, 계좌·종목 평가({@link PaperLiveService}가 씀)와 개요의 지금 값·오늘 추정 점(개요
 * 조립이 씀 — 명세 docs/specs/2026-10-31-paper-live-overview.md §3). 저장소를 읽지 않는 순수 계산이고, 값 규칙은 {@link PaperLiveService} 클래스
 * 설명과 같습니다. 장중 시세 저장본의 이름·수집 태스크도 여기서 고릅니다 — 장중 데이터셋을 참조할 수 있는 곳은 이 계산과 {@code /live}·개요 조립뿐
 * 입니다(시험 {@code LiveIsolationTest}).
 */
final class LiveValuation {

    /** 장 상태 — 그 시장 달력의 정규장 기준(장 전·정규장·마감 뒤 같은 날·휴장일). 달력이 그해를 모르면 UNKNOWN. */
    static final String PRE = "PRE";
    static final String REGULAR = "REGULAR";
    static final String AFTER = "AFTER";
    static final String CLOSED = "CLOSED";
    static final String UNKNOWN = "UNKNOWN";
    static final String LIVE = "LIVE";
    static final String LAST_OBSERVATION = "LAST_OBSERVATION";
    /** 개요 지금 값의 단계(명세 §3) — 장중 추정은 {@link #LIVE}, 그 밖은 아래 넷. 기준({@code basis})은 {@link #LIVE}·{@link #LEDGER} 둘. */
    static final String LIVE_LAST = "LIVE_LAST";
    static final String LEDGER = "LEDGER";
    static final String PROVISIONAL = "PROVISIONAL";
    static final String FINAL = "FINAL";
    /** 봉 시각이 지금보다 이만큼 앞서도(시계 차이) 받습니다. 마감 뒤에는 마감 + 이 값까지의 봉이 그날 마지막 장중 값입니다. */
    static final Duration CLOCK_SLACK = Duration.ofMinutes(2);

    private LiveValuation() {
    }

    /** 그 시장의 장중 시세 저장본({@code paper.live.us}·{@code paper.live.kr}). */
    static String dataset(boolean korea) {
        return korea ? Datasets.SNAP_PAPER_LIVE_KR : Datasets.SNAP_PAPER_LIVE_US;
    }

    /** 그 저장본을 채우는 수집기 태스크({@code paper_live_us}·{@code paper_live_kr}) — {@code /live}가 정규장에만 요청합니다. */
    static String task(boolean korea) {
        return korea ? "paper_live_kr" : "paper_live_us";
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

    /** 보유 하나의 평가 가격과 그 시각 — 장중 1분봉({@code live})이거나 장부의 마지막 관측 가격. 둘 다 없으면 가격·시각 null. */
    record Priced(Position position, Double price, Instant at, boolean live) {
    }

    /**
     * 계좌 하나의 평가 — 종목마다 {@link #price}로 고른 가격, 순자산·보유 평가액·노출(장부와 같은 식 {@link PaperLedger#value} — 현금 + Σ 수량 × 가격,
     * 노출 = 평가액 ÷ 순자산 × 100, 현금성 포함). 출발 전이거나 가격 없는 보유({@code unpriced})가 있으면 셋 다 null입니다 — 장부는 그런 보유를
     * 평단으로 평가하지만 여기서는 없는 가격을 짓지 않습니다. {@code oldestLive}는 장중 1분봉으로 평가한 종목 가운데 가장 오래된 봉 시각.
     */
    record Valued(List<Priced> prices, Double nav, Double equityValue, Double exposurePct, int livePriced,
                  Instant oldestLive, int unpriced) {
    }

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

    /**
     * 보유 하나의 평가 가격 — 장중 1분봉({@link #accepted})이 장부의 마지막 관측(그 관측치의 수집 시각 {@code lastPriceAt})보다 늦을 때만 장중 값,
     * 아니면 장부의 마지막 관측 가격(명세 2026-10-31 §2 — 종목마다 늦은 가격). 장부 가격이 없으면 받은 장중 값을 씁니다.
     */
    static Priced price(Position position, LivePrice quote, Session session, Instant now) {
        boolean live = accepted(quote, session, now) && (position.lastPrice() == null || position.lastPriceAt() == null
                || quote.at().isAfter(position.lastPriceAt()));
        return live ? new Priced(position, quote.price(), quote.at(), true)
                : new Priced(position, position.lastPrice(), position.lastPriceAt(), false);
    }

    /** 계좌 하나를 평가합니다({@link Valued}). 출발 전({@code started} 아님)이면 금액은 null이고 종목 가격만 고릅니다. */
    static Valued value(boolean started, BookState state, List<Position> positions, Map<String, LivePrice> live,
                        Session session, Instant now) {
        List<Priced> prices = new ArrayList<>();
        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        int livePriced = 0;
        int unpriced = 0;
        Instant oldestLive = null;
        for (Position position : positions) {
            Priced priced = price(position, live.get(position.ticker()), session, now);
            prices.add(priced);
            if (priced.live()) {
                livePriced++;
                oldestLive = oldestLive == null || priced.at().isBefore(oldestLive) ? priced.at() : oldestLive;
            }
            if (priced.price() == null) {
                unpriced++;
            } else {
                qty.put(position.ticker(), position.qty());
                price.put(position.ticker(), priced.price());
            }
        }
        if (!started || state == null || unpriced > 0) {
            return new Valued(prices, null, null, null, livePriced, oldestLive, unpriced);
        }
        try {
            PaperLedger.Valuation valuation = PaperLedger.value(state.cash(), qty, price);
            return new Valued(prices, valuation.nav(), valuation.equityValue(), valuation.exposurePct(), livePriced,
                    oldestLive, unpriced);
        } catch (IllegalArgumentException e) {
            // 숫자가 아닌 금액·음수 가격(저장본·장부 오류) — 평가를 짓지 않습니다
            return new Valued(prices, null, null, null, livePriced, oldestLive, unpriced);
        }
    }

    /**
     * 시각이 지났는데 장부에 아직 없는 대기 주문 수(명세 2026-10-31 §5) — 미국은 시각 지정 시점({@link UsTimedFills#timed} — 계좌2)의 기준 시각 T가
     * 지금보다 앞이거나 같은 것({@link ExecutionAudit#targetAt}), 한국은 {@code NEXT_OPEN}의 목표 세션(기준 거래일 다음 거래일) 개장이 지난 것. 그
     * 밖의 시점(미국 NEXT_OBSERVATION·NEXT_CLOSE)은 세지 않습니다. 그 계산에 달력이 그해를 모르면 null.
     *
     * @param pending 그 책의 대기 주문(PENDING)
     */
    static Integer pendingOrders(List<Order> pending, boolean korea, TradingCalendar calendar, Instant now) {
        int count = 0;
        try {
            for (Order order : pending) {
                if (!PaperBooks.ORDER_PENDING.equals(order.status())) {
                    continue;
                }
                Instant target = null;
                if (korea && PaperBooks.NEXT_OPEN.equals(order.timing())) {
                    LocalDate session = ExecutionAudit.targetSession(order, calendar);
                    target = session == null ? null : calendar.openInstant(session);
                } else if (!korea && UsTimedFills.timed(order.timing())) {
                    LocalDate session = ExecutionAudit.targetSession(order, calendar);
                    target = session == null ? null : ExecutionAudit.targetAt(order, session, calendar);
                }
                if (target != null && !target.isAfter(now)) {
                    count++;
                }
            }
        } catch (CalendarUnavailableException e) {
            return null;
        }
        return count;
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

    /**
     * 계좌 한 줄과 종목들({@link PaperLiveService} 클래스 설명의 값 규칙). 출발 전이거나 장부 상태가 없으면 금액·수익률은 null.
     *
     * @param pendingOrders {@link #pendingOrders}(모르면 null)
     */
    static Map<String, Object> book(Book book, BookState state, List<Position> positions, NavRow previous,
                                    LocalDate reference, Map<String, LivePrice> live, Map<String, Bar> bars,
                                    Session session, Instant now, Integer pendingOrders) {
        boolean started = !PaperBooks.NOT_STARTED.equals(book.status()) && state != null;
        Valued valued = value(started, state, positions, live, session, now);
        Double nav = valued.nav();
        List<Map<String, Object>> holdings = new ArrayList<>();
        for (Priced priced : valued.prices()) {
            Position position = priced.position();
            Double price = priced.price();
            Double previousClose = previousClose(bars.get(position.ticker()), reference);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", position.ticker());
            row.put("qty", position.qty());
            row.put("avgCost", PaperQueryService.round2(position.avgCost()));
            row.put("price", price == null ? null : round4(price));
            row.put("priceAtKst", priced.at() == null ? null : Kst.stamp(priced.at()));
            row.put("priceBasis", price == null ? null : priced.live() ? LIVE : LAST_OBSERVATION);
            Double value = price == null ? null : PaperQueryService.round2(price * position.qty());
            row.put("value", value);
            row.put("returnPct", price == null || !(position.avgCost() > 0) ? null : pct(price / position.avgCost()));
            row.put("previousClose", previousClose == null ? null : round4(previousClose));
            row.put("dayChangePct", price == null || previousClose == null || !(previousClose > 0) ? null
                    : pct(price / previousClose));
            row.put("weightPct", nav == null || !(nav > 0) || value == null ? null
                    : PaperQueryService.round2(value / nav * 100.0));
            holdings.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", book.code());
        out.put("label", book.label());
        out.put("status", book.status());
        out.put("initialCash", PaperQueryService.round2(book.initialCash()));
        out.put("cash", started ? PaperQueryService.round2(state.cash()) : null);
        out.put("nav", nav == null ? null : PaperQueryService.round2(nav));
        out.put("returnPct", nav == null || !(book.initialCash() > 0) ? null : pct(nav / book.initialCash()));
        out.put("equityValue", PaperQueryService.round2(valued.equityValue()));
        out.put("exposurePct", PaperQueryService.round2(valued.exposurePct()));
        out.put("previousNav", previous == null ? null : PaperQueryService.round2(previous.nav()));
        out.put("previousTradingDate", previous == null ? null : previous.tradingDate().toString());
        out.put("previousNavFinal", previous == null ? null : previous.pricesFinal());
        out.put("dayChangePct", nav == null || previous == null || !(previous.nav() > 0) ? null : pct(nav / previous.nav()));
        out.put("basis", valued.livePriced() > 0 ? LIVE : LAST_OBSERVATION);
        Instant basisAt = valued.livePriced() > 0 ? valued.oldestLive() : started ? state.lastObservedAt() : null;
        out.put("basisAtKst", basisAt == null ? null : Kst.stamp(basisAt));
        out.put("liveCount", valued.livePriced());
        out.put("positionCount", positions.size());
        out.put("pendingOrders", pendingOrders);
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

    // ------------------------------------------------------------------ 개요의 지금 값(명세 2026-10-31 §3)
    /**
     * 개요 계좌 한 줄의 지금 값 — {@code stage}는 {@link #LIVE}(정규장 장중 추정)·{@link #LIVE_LAST}(마감 뒤 같은 날, 그 세션 줄 전의 장중 마지막
     * 추정)·{@link #LEDGER}(장부 상태 — 마지막 관측치 평가)·{@link #PROVISIONAL}·{@link #FINAL}(그 거래일 순자산 줄). {@code at}은 장중이면 장중가로
     * 평가한 종목 가운데 가장 오래된 봉 시각, 장부 상태면 그 관측 시각, 순자산 줄이면 그 세션 마감 시각. 출발 전이면 금액이 장부 상태 그대로입니다.
     */
    record Current(boolean started, Double nav, Double returnPct, Double exposurePct, Double dayChangePct, NavRow previous,
                   String stage, LocalDate tradingDate, Instant at, int livePriced, int positionCount, Integer pendingOrders,
                   String note) {

        /** 기준 중립 — 현금뿐이거나 출발 전이라 장중 값 = 장부 값(비교 표의 '한 표 한 기준' 판정에서 뺌). */
        boolean neutral() {
            return !started || positionCount == 0;
        }

        /** 장중 1분봉이 든 값인가({@code basis} LIVE — 표시 전용 추정). */
        boolean live() {
            return LIVE.equals(stage) || LIVE_LAST.equals(stage);
        }

        /** 응답 모양({@code current} — API.md 개요 줄). */
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("nav", PaperQueryService.round2(nav));
            out.put("returnPct", returnPct);
            out.put("exposurePct", PaperQueryService.round2(exposurePct));
            out.put("dayChangePct", dayChangePct);
            out.put("previousTradingDate", previous == null ? null : previous.tradingDate().toString());
            out.put("previousNavFinal", previous == null ? null : previous.pricesFinal());
            out.put("basis", live() ? LIVE : LEDGER);
            out.put("stage", stage);
            out.put("tradingDate", tradingDate == null ? null : tradingDate.toString());
            out.put("atKst", at == null ? null : Kst.stamp(at));
            out.put("isEstimated", live());
            out.put("livePriced", livePriced);
            out.put("positionCount", positionCount);
            out.put("pendingOrders", pendingOrders);
            out.put("neutral", neutral());
            out.put("note", note);
            return out;
        }
    }

    /**
     * 개요 계좌 한 줄의 지금 값을 고릅니다(명세 §3의 순서). ① 정규장 또는 마감 뒤 같은 날이고, 그 세션 순자산 줄이 없고(정규장은 보지 않음), 장중가로
     * 평가한 보유가 있고 장중 순자산이 있으면 장중 값. ② 아니면 마지막으로 끝난 세션 이하의 마지막 순자산 줄 R과 장부 상태가 관측한 세션 I(관측 시각이 속한
     * 세션)를 견줘 R의 거래일 ≥ I면 그 줄, 아니면 장부 상태. 달력이 그해를 모르면(UNKNOWN) 장부 상태. 출발 전이면 장부 상태 그대로(수익률 없음).
     * '오늘 변화'는 그 값의 거래일(장부 상태는 I) 앞의 마지막 줄(잠정 포함) 대비.
     */
    static Current current(BookLedger ledger, Map<String, LivePrice> live, Session session, TradingCalendar calendar,
                           Instant now, boolean korea) {
        Book book = ledger.book();
        BookState state = ledger.state();
        List<Position> positions = ledger.positions();
        List<NavRow> rows = ledger.nav();
        boolean started = !PaperBooks.NOT_STARTED.equals(book.status()) && state != null;
        Valued valued = value(started, state, positions, live, session, now);
        Integer pending = pendingOrders(ledger.pending(), korea, calendar, now);
        List<String> notes = new ArrayList<>();

        String stage;
        Double nav;
        Double exposure;
        LocalDate tradingDate;
        Instant at;
        LocalDate reference;
        int livePriced = 0;
        NavRow sessionRow = row(rows, session.sessionDate());
        if (!started) {
            stage = LEDGER;
            nav = state == null ? null : state.nav();
            exposure = state == null ? null : state.exposurePct();
            tradingDate = null;
            at = state == null ? null : state.lastObservedAt();
            reference = null;
            notes.add("출발 전");
        } else if (session.intraday() && valued.livePriced() > 0 && valued.nav() != null
                && (REGULAR.equals(session.phase()) || sessionRow == null)) {
            stage = REGULAR.equals(session.phase()) ? LIVE : LIVE_LAST;
            nav = valued.nav();
            exposure = valued.exposurePct();
            tradingDate = session.sessionDate();
            at = valued.oldestLive();
            reference = session.sessionDate();
            livePriced = valued.livePriced();
            if (livePriced < positions.size()) {
                notes.add("장중가 " + livePriced + "/" + positions.size() + "종목 — 나머지는 장부 관측가");
            }
        } else {
            LocalDate observed = UNKNOWN.equals(session.phase()) ? null : observedSession(calendar, state.lastObservedAt());
            NavRow latest = UNKNOWN.equals(session.phase()) ? null : latestRow(rows, completedSession(session, calendar));
            if (latest != null && (observed == null || !latest.tradingDate().isBefore(observed))) {
                stage = latest.pricesFinal() ? FINAL : PROVISIONAL;
                nav = latest.nav();
                exposure = latest.exposurePct();
                tradingDate = latest.tradingDate();
                at = closeOf(calendar, latest.tradingDate());
                reference = latest.tradingDate();
            } else {
                stage = LEDGER;
                nav = state.nav();
                exposure = state.exposurePct();
                tradingDate = observed;
                at = state.lastObservedAt();
                reference = observed != null ? observed : state.lastNavTradingDate();
            }
            if (session.intraday() && valued.livePriced() > 0 && valued.unpriced() > 0) {
                notes.add("가격을 한 번도 받지 못한 종목 " + valued.unpriced() + "개 — 장부 평가(평단)");
            }
        }
        if (pending != null && pending > 0) {
            notes.add(korea ? "시가 체결 대기 " + pending + "건 반영 전 — 그날 밤 관측치에서 체결"
                    : "체결 대기 " + pending + "건 반영 전 — 다음 장부 관측치에서 체결");
        }
        NavRow previous = previousNav(rows, reference);
        Double returnPct = started && nav != null && book.initialCash() > 0 ? pct(nav / book.initialCash()) : null;
        Double dayChange = nav == null || previous == null || !(previous.nav() > 0) ? null : pct(nav / previous.nav());
        return new Current(started, nav, returnPct, exposure, dayChange, previous, stage, tradingDate, at, livePriced,
                positions.size(), pending, notes.isEmpty() ? null : String.join(" · ", notes));
    }

    /**
     * 장부 기준 그날 변화(명세 §4 계좌 비교의 장부 칸) — 장부 상태의 순자산(BookSummary {@code nav}와 같은 값) ÷ 장부 상태가 관측한 세션 앞의 마지막
     * 순자산 줄(잠정 포함). 관측한 세션은 지금 값의 장부 단계와 같은 규칙({@link #observedSession} — 장 상태가 UNKNOWN이거나 모르면 null이고, 그때
     * 기준은 상태의 마지막 순자산 줄 거래일)입니다. 장중 값을 쓰지 않습니다 — 비교 표가 장중 값과 장부 값을 섞지 않으려고 표 전체를 장부 칸으로 둘 때
     * 그 표의 '오늘 변화'입니다(화면은 {@code navSeries}로 계산하지 않음). {@code {tradingDate, dayChangePct, previousTradingDate, previousNavFinal}},
     * 출발 전이거나 장부 상태가 없으면 null.
     */
    static Map<String, Object> ledgerDay(BookLedger ledger, Session session, TradingCalendar calendar) {
        BookState state = ledger.state();
        if (PaperBooks.NOT_STARTED.equals(ledger.book().status()) || state == null) {
            return null;
        }
        LocalDate observed = UNKNOWN.equals(session.phase()) ? null : observedSession(calendar, state.lastObservedAt());
        NavRow previous = previousNav(ledger.nav(), observed != null ? observed : state.lastNavTradingDate());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tradingDate", observed == null ? null : observed.toString());
        out.put("dayChangePct", previous == null || !(previous.nav() > 0) ? null : pct(state.nav() / previous.nav()));
        out.put("previousTradingDate", previous == null ? null : previous.tradingDate().toString());
        out.put("previousNavFinal", previous == null ? null : previous.pricesFinal());
        return out;
    }

    /**
     * 순자산 곡선의 오늘 추정 점(명세 §4 곡선 꼬리) — 정규장 또는 마감 뒤 같은 날이고 그 세션 순자산 줄이 어느 계좌에도 없을 때, 장중 값인 계좌가 하나라도
     * 있으면 {@code {date, atKst, isEstimated:true, books:{code: {nav, isEstimated}}}}(계좌 순서는 받은 순서). 장중 값 계좌는 그 순자산
     * ({@code isEstimated:true}), 현금뿐인 운용 계좌는 장부 값(= 장중 값, {@code isEstimated:false}), 그 밖은 {@code nav:null}. 점은 장중 값이 든
     * 추정이라 최상위에 {@code isEstimated:true}를 두고, 계좌마다 추정인지는 그 계좌의 표시입니다(PRINCIPLES — 추정치는 표시와 함께). {@code atKst}는
     * 장중 값 계좌들 가운데 가장 오래된 기준 시각. 아니면 null.
     *
     * @param currents 계좌 코드 → 지금 값(받은 순서)
     */
    static Map<String, Object> navEstimate(List<BookLedger> ledgers, Map<String, Current> currents, Session session) {
        if (!session.intraday() || session.sessionDate() == null) {
            return null;
        }
        for (BookLedger ledger : ledgers) {
            if (row(ledger.nav(), session.sessionDate()) != null) {
                return null;
            }
        }
        Map<String, Object> books = new LinkedHashMap<>();
        Instant oldest = null;
        for (Map.Entry<String, Current> entry : currents.entrySet()) {
            Current current = entry.getValue();
            boolean cashOnly = current.started() && current.positionCount() == 0;
            if (current.live()) {
                oldest = oldest == null || (current.at() != null && current.at().isBefore(oldest)) ? current.at() : oldest;
            }
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("nav", current.live() || cashOnly ? PaperQueryService.round2(current.nav()) : null);
            point.put("isEstimated", current.live());
            books.put(entry.getKey(), point);
        }
        if (oldest == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("date", session.sessionDate().toString());
        out.put("atKst", Kst.stamp(oldest));
        out.put("isEstimated", true);
        out.put("books", books);
        return out;
    }

    /** 장 상태의 짧은 모양 — 개요의 {@code liveSession{phase, sessionDate}}. */
    static Map<String, Object> sessionSummary(Session session) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("phase", session.phase());
        out.put("sessionDate", session.sessionDate() == null ? null : session.sessionDate().toString());
        return out;
    }

    /** 그 거래일의 순자산 줄(없거나 날짜가 null이면 null). */
    static NavRow row(List<NavRow> rows, LocalDate date) {
        if (date == null) {
            return null;
        }
        for (NavRow row : rows) {
            if (row.tradingDate().equals(date)) {
                return row;
            }
        }
        return null;
    }

    /** 그 날 이하의 마지막 순자산 줄(날짜가 null이면 null). */
    static NavRow latestRow(List<NavRow> rows, LocalDate until) {
        if (until == null) {
            return null;
        }
        NavRow found = null;
        for (NavRow row : rows) {
            if (!row.tradingDate().isAfter(until) && (found == null || row.tradingDate().isAfter(found.tradingDate()))) {
                found = row;
            }
        }
        return found;
    }

    /** 마지막으로 끝난 세션 — 정규장·장 전이면 그 세션의 직전 거래일, 마감 뒤·휴장일이면 그 세션 날짜(휴장일은 이미 직전 거래일). 모르면 null. */
    static LocalDate completedSession(Session session, TradingCalendar calendar) {
        if (session.sessionDate() == null) {
            return null;
        }
        try {
            return switch (session.phase()) {
                case REGULAR, PRE -> calendar.previousTradingDay(session.sessionDate());
                case AFTER, CLOSED -> session.sessionDate();
                default -> null;
            };
        } catch (CalendarUnavailableException e) {
            return null;
        }
    }

    /** 그 시각이 속한(또는 직전) 세션 — 장부 관측치가 본 거래일. 모르면 null. */
    static LocalDate observedSession(TradingCalendar calendar, Instant observedAt) {
        if (observedAt == null) {
            return null;
        }
        try {
            return calendar.currentOrLastSession(observedAt);
        } catch (CalendarUnavailableException e) {
            return null;
        }
    }

    private static Instant closeOf(TradingCalendar calendar, LocalDate date) {
        try {
            return calendar.closeInstant(date);
        } catch (CalendarUnavailableException e) {
            return null;
        }
    }

    /** 배수 → 퍼센트(소수 둘째 자리). */
    static Double pct(double ratio) {
        return PaperQueryService.round2((ratio - 1.0) * 100.0);
    }

    private static Double round4(double value) {
        return PaperQueryService.round4(value);
    }
}
