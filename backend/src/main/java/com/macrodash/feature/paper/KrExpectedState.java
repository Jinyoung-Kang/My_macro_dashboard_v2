package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * 한국 Claude 계좌2 장중 확인의 예상 상태(단계 2b — 명세 2026-11-02 §10) — 장부 상태 + 기준 시각이 지금 이하인 대기 주문(현실에서는 이미 체결됐을 주문 —
 * 장중 확인이 대신하지 않음)을 체결했다고 본 장부. 미국 {@link ExpectedState}와 같은 계산({@link ExpectedState#simulate} — 기준 시각 순·같은 시각은
 * 매도 먼저·원가격·비용 빼고 어림)이고 가격 고르기만 한국 자료입니다. 한국 장부는 그 밤 관측치로 체결하므로 확인 시각에는 시가 주문도 아직 대기입니다.
 *
 * <ul>
 *   <li><b>대상</b>: 출처 CLAUDE 대기 주문 가운데 목표 세션이 E이고 기준 시각(시가 = E 개장, 매시 = hh:00, 장중 시장가 = 기준 분, 종가 = 마감 —
 *       {@link KrTimedLadder#targetOn})이 지금 이하인 것.</li>
 *   <li><b>가격</b>: 감시 저장본({@code paper.watch.kr})의 그 종목 창(키 = 기준 시각 'HH:MM' — 시가는 개장 시각) 안 첫 거래 봉 시가 → 창 뒤 첫 거래 봉
 *       시가(라벨 ≤ 지금) → 그 종목 마지막 완성 봉 종가({@link ExpectedState#PRICE_WATCH}) → 밤 관측치의 기준일 종가·보유의 마지막 평가 가격
 *       ({@link ExpectedState#PRICE_LAST}). 모두 없으면 체결로 보지 않고 {@code unpriced}에 적습니다.</li>
 * </ul>
 *
 * <p>추정입니다 — 실제 체결은 그 밤 장부가 1분봉 사다리로 하고(현금 부족·거래 없음은 장부 판정), 비용(수수료·세금·슬리피지)은 빼고 어림합니다.
 * 저장본·DB를 읽지 않는 순수 계산입니다.
 */
final class KrExpectedState {

    private KrExpectedState() {
    }

    /** 패킷·응답의 예상 상태 설명(미국 문장 대신). */
    static final String NOTE = "추정 — 기준 시각이 지난 대기 주문을 감시 1분봉(그 시각 창 → 창 뒤 첫 거래 봉 → 마지막 봉, 없으면 밤 종가)의 원가격으로 "
            + "체결했다고 본 장부(비용 빼고 어림). 실제 체결은 그 밤 장부가 1분봉 사다리로 하고 현금 부족·거래 없음은 장부가 판정한다";

    /**
     * @param state     장부 상태(없으면 현금 0)
     * @param positions 장부 보유
     * @param pending   대기 주문(출처 CLAUDE)
     * @param session   목표 세션 E
     * @param now       지금(이 시각 이하의 기준 시각·완성 봉만)
     * @param watch     감시 저장본 본문(없으면 null)
     * @param quotes    밤 관측치(없으면 null)
     * @param calendar  한국 달력(그 실행 — 장 시간 변경일 포함)
     */
    static ExpectedState.State of(BookState state, List<Position> positions, List<Order> pending, LocalDate session,
                                  Instant now, JsonNode watch, Quotes quotes, TradingCalendar calendar) {
        Map<String, Position> held = new TreeMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position p : positions) {
            held.put(p.ticker(), p);
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
        List<Order> due = new ArrayList<>();
        Map<Long, Instant> targets = new HashMap<>();
        for (Order o : pending) {
            if (!PaperBooks.ORDER_PENDING.equals(o.status()) || !PacketBuilder.SOURCE_CLAUDE.equals(o.source())
                    || !session.equals(ExecutionAudit.targetSession(o, calendar))) {
                continue;
            }
            Instant target = targetAt(o, session, calendar);
            if (target != null && !target.isAfter(now)) {
                due.add(o);
                targets.put(o.id(), target);
            }
        }
        return ExpectedState.simulate(state == null ? 0 : state.cash(), held, price, due, targets, session, now,
                (o, target, position) -> price(o, target, now, watch, quotes, position));
    }

    /**
     * {@link #of}와 같은 가격 고르기(감시 저장본 → 밤 관측치 → 보유의 마지막 평가 가격)를 다른 대상 고르기가 쓰도록 — 실제 매매 장중 따라 하기의 '그 주문 뒤
     * 예상 비중'(ADR 0028 — 명세 2026-11-06 §3.2, {@link PaperMirrorService#weightAfter})은 출처를 거르지 않고 시가 주문까지 넣으므로 대상만 다릅니다.
     * {@link #of}는 이 함수를 거치지 않고 그대로입니다(고정본 불변).
     *
     * @param now    지금(이 시각 이하에 끝난 봉만)
     * @param watch  감시 저장본 본문(없으면 null)
     * @param quotes 밤 관측치(없으면 null)
     */
    static ExpectedState.Pricer pricer(Instant now, JsonNode watch, Quotes quotes) {
        return (o, target, position) -> price(o, target, now, watch, quotes, position);
    }

    /** 그 주문의 E 기준 시각 — 시가는 개장, 그 밖은 {@link KrTimedLadder#targetOn}(모르는 시점은 null). */
    static Instant targetAt(Order order, LocalDate session, TradingCalendar calendar) {
        if (PaperBooks.NEXT_OPEN.equals(order.timing())) {
            return calendar.openInstant(session);
        }
        return KrTimedLadder.targetOn(order, session, calendar);
    }

    private static ExpectedState.Priced price(Order o, Instant target, Instant now, JsonNode watch, Quotes quotes,
                                              Position held) {
        JsonNode ticker = watch == null ? null : watch.path("tickers").path(o.ticker());
        if (ticker != null && ticker.isObject()) {
            String nowLabel = KrTimedLadder.label(now.atZone(KrxCalendar.SEOUL).toLocalTime());
            String key = KrTimedLadder.label(target.atZone(KrxCalendar.SEOUL).toLocalTime());
            for (JsonNode bar : ticker.path("windows").path(key)) {
                Double open = traded(bar, nowLabel);
                if (open != null) {
                    return new ExpectedState.Priced(open, ExpectedState.PRICE_WATCH);
                }
            }
            Double after = traded(ticker.path("firstAfter").path(key), nowLabel);
            if (after != null) {
                return new ExpectedState.Priced(after, ExpectedState.PRICE_WATCH);
            }
            JsonNode last = ticker.path("lastBar");
            Double close = positive(last.get("c"));
            if (close != null) {
                return new ExpectedState.Priced(close, ExpectedState.PRICE_WATCH);
            }
        }
        Bar bar = quotes == null ? null : quotes.bars().get(o.ticker());
        if (bar != null && bar.close() > 0) {
            return new ExpectedState.Priced(bar.close(), ExpectedState.PRICE_LAST);
        }
        if (held != null) {
            double last = held.lastPrice() != null ? held.lastPrice() : held.avgCost();
            if (last > 0) {
                return new ExpectedState.Priced(last, ExpectedState.PRICE_LAST);
            }
        }
        return null;
    }

    /** 거래가 있고(거래량 &gt; 0) 지금 이전에 끝난(라벨 ≤ 지금) 봉의 시가, 아니면 null. */
    private static Double traded(JsonNode bar, String nowLabel) {
        if (bar == null || !bar.isObject()) {
            return null;
        }
        String label = Json.asText(bar, "label");
        JsonNode volume = bar.get("volume");
        if (label == null || label.compareTo(nowLabel) > 0 || volume == null || !volume.isNumber() || volume.asLong() <= 0) {
            return null;
        }
        return positive(bar.get("open"));
    }

    private static Double positive(JsonNode value) {
        return value != null && value.isNumber() && value.asDouble() > 0 ? value.asDouble() : null;
    }
}
