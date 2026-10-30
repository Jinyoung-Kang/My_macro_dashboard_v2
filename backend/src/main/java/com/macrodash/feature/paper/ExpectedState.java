package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.LedgerView;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 🧪 장중 확인의 예상 상태(계좌2 명세 §10-6, 단계 2) — 장부 상태 + 기준 시각 T가 지금 이하인 시각 지정 대기 주문(현실에서는 이미 체결됐을 주문 —
 * ⑩이 대신하지 않음)을 체결했다고 본 장부. 확인 응답의 검증기 문맥(현금·순자산·비중·보유 수량)과 확인 패킷 {@code 4_portfolio.expected}가 씁니다.
 * <b>추정입니다</b> — 실제 체결은 장부가 T 순으로 1분봉으로 하므로(현금 부족은 장부 {@code cashLimited}, 거래 없음은 만료) 이 값과 갈릴 수 있고,
 * 장부의 그 판정이 마지막 방어선입니다.
 *
 * <ul>
 *   <li><b>가격</b>(원가격, 슬리피지 빼고 어림): 1분봉 저장본의 T 창 R1·R2({@link ExecutionAudit#fromBars} — 장부 2b와 같은 판정) → 감시 저장본의 그 종목
 *       E 세션 T 창 첫 거래 봉 시가(완성된 봉만) → 마지막 가격(관측치 종가, 없으면 보유의 마지막 평가 가격). 셋 다 없으면 그 주문은 체결로 보지 않고
 *       {@code unpriced}에 적습니다(없는 숫자를 만들지 않음).</li>
 *   <li><b>순서</b>: 매도 먼저(기준 시각 순), 그다음 매수(기준 시각 순). 매도 수량은 장부 규칙({@link PaperLedger#sellQty}), 매수는 주문의 목표 비중(살
 *       증가분) × 그때의 예상 순자산 ÷ 가격을 내림하고 현금을 넘지 않게 줄임(1주도 못 사면 체결로 보지 않음).</li>
 *   <li><b>예상 매수 보유</b>는 그 세션 E를 연 날로 둡니다 — 검증기의 보유 거래일이 0이라 같은 날 재량 매도는 MIN_HOLD가 막습니다.</li>
 *   <li>평가 가격은 이 체결로 정한 가격, 그 밖의 보유는 장부의 마지막 평가 가격(없으면 평단) — 아침 결정의 검증 문맥과 같은 규칙입니다.</li>
 * </ul>
 *
 * <p>저장본·DB를 읽지 않는 순수 계산이라 같은 입력이면 같은 값입니다(작업과 패킷이 같은 함수를 부름).
 */
final class ExpectedState {

    private ExpectedState() {
    }

    /** 가격 출처 — 1분봉 저장본 R1·R2. */
    static final String PRICE_BARS = "BARS";
    /** 가격 출처 — 감시 저장본의 T 창 첫 거래 봉. */
    static final String PRICE_WATCH = "WATCH";
    /** 가격 출처 — 마지막 가격(관측치 종가 또는 보유의 마지막 평가 가격). */
    static final String PRICE_LAST = "LAST";

    /** 체결로 본 대기 주문 하나(원가격·출처). */
    record Assumed(long orderId, String ticker, String side, String timing, Instant target, int qty, double price,
                   String priceSource) {
    }

    /**
     * 예상 상태.
     *
     * @param cash      예상 현금
     * @param nav       예상 순자산
     * @param positions 예상 보유(예상 매수 보유는 그 세션을 연 날)
     * @param price     종목 → 평가 가격
     * @param assumed   체결로 본 대기 주문
     * @param unpriced  기준 시각이 지났지만 가격을 몰라 체결로 보지 않은 주문 번호
     * @param now       기준(지금)
     */
    record State(double cash, double nav, double exposurePct, List<Position> positions, Map<String, Double> price,
                 List<Assumed> assumed, List<Long> unpriced, Instant now) {

        State {
            positions = List.copyOf(positions);
            price = Map.copyOf(price);
            assumed = List.copyOf(assumed);
            unpriced = List.copyOf(unpriced);
        }

        /** 검증기 문맥의 장부 칸({@link ClaudeDecisionPipeline#plan}). */
        LedgerView view() {
            return new LedgerView(cash, nav, exposurePct, positions, price);
        }

        /** 결정 응답·확인 패킷의 모양. */
        Map<String, Object> toMap(TradingCalendar calendar) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("asOfKst", Kst.stamp(now));
            out.put("cash", PacketBuilder.decimal(cash, 2));
            out.put("nav", PacketBuilder.decimal(nav, 2));
            out.put("exposurePct", PacketBuilder.decimal(exposurePct, 2));
            List<Map<String, Object>> held = new ArrayList<>();
            for (Position p : positions) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("ticker", p.ticker());
                row.put("qty", p.qty());
                Double at = price.get(p.ticker());
                row.put("price", at == null ? null : PacketBuilder.decimal(at, 4));
                row.put("weightPct", at == null || !(nav > 0) ? null : PacketBuilder.decimal(p.qty() * at / nav * 100, 2));
                row.put("openedOn", p.openedOn());
                held.add(row);
            }
            out.put("positions", held);
            List<Map<String, Object>> fills = new ArrayList<>();
            for (Assumed a : assumed) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("orderId", a.orderId());
                row.put("ticker", a.ticker());
                row.put("side", a.side());
                row.put("timing", a.timing());
                row.put("targetAtEt", a.target() == null ? null : ExecutionAudit.label(a.target(), calendar));
                row.put("qty", a.qty());
                row.put("rawPrice", PacketBuilder.decimal(a.price(), 4));
                row.put("priceSource", a.priceSource());
                fills.add(row);
            }
            out.put("assumedFills", fills);
            out.put("unpriced", unpriced);
            out.put("note", "추정 — 기준 시각이 지난 대기 주문을 그 시각 1분봉(없으면 감시 봉·마지막 가격) 원가격으로 체결했다고 본 장부"
                    + "(슬리피지 빼고 어림). 실제 체결은 장부가 T 순으로 하고 현금 부족·거래 없음은 장부가 판정한다");
            return out;
        }
    }

    /**
     * @param state     장부 상태(없으면 현금 0)
     * @param positions 장부 보유
     * @param pending   대기 주문(출처 CLAUDE — 시각 지정 시점이고 그 세션 E가 목표인 것만 봄)
     * @param session   목표 세션 E
     * @param now       지금(이 시각 이하의 기준 시각·완성 봉·받은 값만)
     * @param bars      1분봉 저장본 본문(지금 이전에 받은 것만 넘김 — 없으면 null)
     * @param watch     감시 저장본 본문(없으면 null)
     * @param quotes    관측치(없으면 null)
     */
    static State of(BookState state, List<Position> positions, List<Order> pending, LocalDate session, Instant now,
                    JsonNode bars, JsonNode watch, Quotes quotes, TradingCalendar calendar) {
        double cash = state == null ? 0 : state.cash();
        Map<String, Position> held = new TreeMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position p : positions) {
            held.put(p.ticker(), p);
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
        List<Order> due = new ArrayList<>();
        Map<Long, Instant> targets = new HashMap<>();
        for (Order o : pending) {
            if (!PaperBooks.ORDER_PENDING.equals(o.status()) || !UsTimedFills.timed(o.timing())
                    || !session.equals(ExecutionAudit.targetSession(o, calendar))) {
                continue;
            }
            Instant target = ExecutionAudit.targetAt(o, session, calendar);
            if (target != null && !target.isAfter(now)) {
                due.add(o);
                targets.put(o.id(), target);
            }
        }
        due.sort(Comparator.comparingInt((Order o) -> PaperBooks.SELL.equals(o.side()) ? 0 : 1)
                .thenComparing(o -> targets.get(o.id())).thenComparingLong(Order::id));
        List<Assumed> assumed = new ArrayList<>();
        List<Long> unpriced = new ArrayList<>();
        for (Order o : due) {
            Instant target = targets.get(o.id());
            Priced p = price(o, target, session, now, bars, watch, quotes, held.get(o.ticker()), calendar);
            if (p == null) {
                unpriced.add(o.id());
                continue;
            }
            if (PaperBooks.SELL.equals(o.side())) {
                Position h = held.get(o.ticker());
                if (h == null || h.qty() <= 0) {
                    continue;   // 보유 없는 매도 — 장부가 취소
                }
                int qty = o.qty() != null ? Math.min(Math.max(o.qty(), 0), h.qty())
                        : o.sellFraction() != null && !(o.sellFraction() > 0) ? 0 : PaperLedger.sellQty(h.qty(), o.sellFraction());
                if (qty <= 0) {
                    continue;
                }
                cash += qty * p.raw();
                price.put(o.ticker(), p.raw());
                if (qty == h.qty()) {
                    held.remove(o.ticker());
                } else {
                    held.put(o.ticker(), withQty(h, h.qty() - qty));
                }
                assumed.add(new Assumed(o.id(), o.ticker(), o.side(), o.timing(), target, qty, p.raw(), p.source()));
            } else {
                Map<String, Integer> qtyNow = new HashMap<>();
                held.forEach((t, h) -> qtyNow.put(t, h.qty()));
                double nav = PaperLedger.value(cash, qtyNow, price).nav();
                int wanted = o.qty() != null ? o.qty()
                        : o.targetWeightPct() != null && Double.isFinite(o.targetWeightPct())
                        ? (int) Math.floor(o.targetWeightPct() / 100.0 * nav / p.raw()) : 0;
                int qty = Math.min(wanted, (int) Math.floor(Math.max(0, cash) / p.raw()));
                if (qty <= 0) {
                    continue;   // 1주도 못 삼 — 장부가 취소
                }
                cash -= qty * p.raw();
                Position h = held.get(o.ticker());
                held.put(o.ticker(), h == null
                        ? new Position(o.bookCode(), o.ticker(), qty, p.raw(), session, target, p.raw(), target, p.raw(),
                                target, false, session, p.raw(), null)
                        : withQty(h, h.qty() + qty));
                price.put(o.ticker(), p.raw());
                assumed.add(new Assumed(o.id(), o.ticker(), o.side(), o.timing(), target, qty, p.raw(), p.source()));
            }
        }
        Map<String, Integer> qty = new HashMap<>();
        held.forEach((t, h) -> qty.put(t, h.qty()));
        Map<String, Double> valued = new HashMap<>();
        held.keySet().forEach(t -> valued.put(t, price.get(t)));
        PaperLedger.Valuation valuation = PaperLedger.value(cash, qty, valued);
        return new State(PaperLedger.round4(cash), valuation.nav(), valuation.exposurePct(), new ArrayList<>(held.values()),
                valued, assumed, unpriced, now);
    }

    private record Priced(double raw, String source) {
    }

    private static Priced price(Order o, Instant target, LocalDate session, Instant now, JsonNode bars, JsonNode watch,
                                Quotes quotes, Position held, TradingCalendar calendar) {
        ExecutionAudit.Price fromBars = bars == null ? null : ExecutionAudit.fromBars(o, o.timing(), session, bars, calendar);
        if (fromBars != null && !fromBars.at().plus(Duration.ofSeconds(60)).isAfter(now)) {
            return new Priced(fromBars.raw(), PRICE_BARS);
        }
        Double watched = watchOpen(watch, o.ticker(), session, target, now, calendar);
        if (watched != null) {
            return new Priced(watched, PRICE_WATCH);
        }
        Bar bar = quotes == null ? null : quotes.bars().get(o.ticker());
        if (bar != null && Double.isFinite(bar.close()) && bar.close() > 0) {
            return new Priced(bar.close(), PRICE_LAST);
        }
        if (held != null) {
            double last = held.lastPrice() != null ? held.lastPrice() : held.avgCost();
            if (Double.isFinite(last) && last > 0) {
                return new Priced(last, PRICE_LAST);
            }
        }
        return null;
    }

    /** 감시 저장본의 그 종목 E 세션 T 창(T ~ T+4분) 첫 거래 봉 시가 — 받은 시각·봉 끝이 지금 이하인 것만. 없으면 null. */
    private static Double watchOpen(JsonNode watch, String ticker, LocalDate session, Instant target, Instant now,
                                    TradingCalendar calendar) {
        JsonNode entry = Json.child(Json.child(watch, "tickers"), ticker);
        Instant fetched = instant(Json.asText(entry, "fetchedAt"));
        if (entry == null || fetched == null || fetched.isAfter(now) || !session.toString().equals(Json.asText(entry, "session"))
                || Json.asBoolean(entry, "isStale")) {
            return null;
        }
        Instant end = target.plus(ExecutionAudit.WINDOW);
        Instant best = null;
        Double open = null;
        for (JsonNode bar : entry.path("bars")) {
            Instant t = instant(Json.asText(bar, "t"));
            Double o = Json.asDouble(bar, "o");
            Double v = Json.asDouble(bar, "v");
            if (t == null || o == null || v == null || !(v > 0) || !(o > 0) || t.isBefore(target) || !t.isBefore(end)
                    || t.plus(Duration.ofSeconds(60)).isAfter(now) || !t.atZone(calendar.zone()).toLocalDate().equals(session)) {
                continue;
            }
            if (best == null || t.isBefore(best)) {
                best = t;
                open = o;
            }
        }
        return open;
    }

    private static Position withQty(Position p, int qty) {
        return new Position(p.bookCode(), p.ticker(), qty, p.avgCost(), p.openedOn(), p.openedAt(), p.highWatermark(),
                p.watermarkAt(), p.lastPrice(), p.lastPriceAt(), p.priceStale(), p.fillRefDate(), p.fillRefClose(),
                p.splitNote());
    }

    private static Instant instant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text.strip()).toInstant();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
