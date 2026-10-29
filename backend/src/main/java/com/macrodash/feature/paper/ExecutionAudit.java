package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 🧪 실행 감사의 판정(미국 Claude 계좌2 실험 단계 0 — 명세 docs/specs/2026-10-30-claude-book2-timing-design.md §6-2·§8·§14-1, ADR 0022):
 * 주문 하나를 계좌1식(다음 시간별 관측치)·시가·매시·종가로 체결했다면의 원가격(반사실)을 1분봉 저장본·관측치·그 주문의 체결에서 셉니다.
 * 저장본·DB를 읽지 않는 순수 계산이라 정기 작업({@link PaperExecutionAuditJob})과 시험이 그대로 부릅니다.
 *
 * <p><b>목표 세션 E</b> = 주문 기준 거래일 다음 거래일(미국 달력). 메뉴 시점의 기준 시각 T는 E 날짜의 뉴욕 시각이라(America/New_York — 고정
 * UTC 오프셋 없음) 서머타임 전환 주에도 09:30 ET 그대로입니다(2026-10-30 EDT 13:30Z, 2026-11-02 EST 14:30Z).
 *
 * <p><b>메뉴 시점</b>(NEXT_OPEN 09:30 · AT_1000~AT_1500 hh:00)은 1분봉 저장본의 그 창(T ~ T+4분에 시작한 봉)에서 사다리 R1·R2만 씁니다 —
 * R1 {@value #RUNG_AT} = T에 시작한 봉이 거래량 &gt; 0이면 그 봉 시가, R2 {@value #RUNG_NEXT} = 아니면 T+1~T+4분 안 첫 거래 봉 시가. 대체 체결
 * (R2b·R3)은 반사실에 쓰지 않습니다(§14-1 '대체 없음'). 아래 조건이 하나라도 어긋나면 그 시점은 null입니다(없는 숫자를 만들지 않음):
 * <ul>
 *   <li>⑤ T &gt; 주문 생성 + 60초, 봉 시작 ≥ T(그 창 안 — T+5분 전)</li>
 *   <li>⑥ 봉의 세션 날짜(뉴욕) = E — 저장본의 E 세션 항목에서만 찾습니다</li>
 *   <li>⑦ 완성된 봉: 같은 종목에 그 뒤 봉이 저장본에 있거나(창 안 다음 봉·그 세션 마지막 봉), 그 세션을 E 마감 + 15분 뒤에 받았음</li>
 *   <li>⑧ 그 종목 항목이 이어받은 값(isStale)이 아니고, 거래량 &gt; 0(모르면 거래로 보지 않음), 그 세션을 받은 시각 &gt; 주문 생성</li>
 *   <li>T가 E 마감 이후(조기 폐장일 13:00의 AT_1300~AT_1500)면 그 시점은 체결할 수 없어 null</li>
 * </ul>
 *
 * <p><b>NEXT_CLOSE</b>는 관측치({@code paper.quotes})가 E 확정 종가를 보일 때만 — 그 종목 봉 날짜가 E이고 이어받은 봉이 아니며 그 저장본이
 * {@link UsPaperMarket#closeAvailable}(E 마감 + 15분 뒤 수집)일 때 그 종가({@value #RUNG_CLOSE}, 시각 = E 마감). 다음 세션이 열린 뒤의 저장본은
 * 마지막 봉이 E가 아니라 쓰지 않습니다(조정 이력에서 꺼내지 않음 — 배당락이 지난 값을 바꿈).
 * <b>NEXT_OBSERVATION</b>(계좌1식 기준)은 계좌1 주문(시점 NEXT_OBSERVATION)의 실제 체결 원가격(슬리피지 전 {@code raw_price}, 시각 = 그
 * 관측치 수집 시각, {@value #RUNG_OBSERVATION})에서 옮깁니다(§14-1 '계좌1 주문은 실제 체결 행에서'). 그 밖의 주문은 아직 null입니다.
 *
 * <p><b>지연</b>({@link #lagSeconds}) = 그 세션을 받은 시각 − (기준 종목 SPY 마지막 봉 시작 + 60초). 받은 시각이 그 세션 날의 정규장(미국 달력의
 * 개장 ~ 마감 — 조기 폐장일은 13:00까지) 안일 때만 셉니다 — 수집기는 달력을 몰라 조기 폐장을 구분하지 못하므로 저장본의 재료로 다시 셉니다.
 */
final class ExecutionAudit {

    private ExecutionAudit() {
    }

    static final String NEXT_OBSERVATION = OrderValidator.NEXT_OBSERVATION;

    /**
     * 1분봉으로 반사실을 적는 메뉴 시점과 기준 시각 T(뉴욕 시간, 명세 §6-2 — T5). 이름은 V17 {@code paper_orders.timing} CHECK, 시각은 수집기
     * {@code app/tasks/paper_bars.py}의 {@code MENU}와 같습니다(시험이 두 파일과 대조).
     */
    static final Map<String, LocalTime> MENU = menu();

    /** 반사실을 적는 시점 전부, 응답·요약 순서 — 계좌1식 기준 + 계좌2 메뉴 여덟(시가 · 매시 여섯 · 종가). */
    static final List<String> TIMINGS = timings();

    /** 사다리 칸(V17 {@code paper_fills.fill_rung}과 같은 글자) — 반사실은 R1·R2와 종가만. */
    static final String RUNG_AT = "Y1M_AT";
    static final String RUNG_NEXT = "Y1M_NEXT";
    static final String RUNG_CLOSE = "QUOTES_CLOSE";
    /** 계좌1식 기준의 칸 — 그 주문이 실제로 체결된 시간별 관측치(사다리 칸이 아니라 V17 CHECK에는 없음 — 반사실 JSON에만). */
    static final String RUNG_OBSERVATION = "QUOTES_OBSERVATION";

    /** 저장본 모양 판(수집기 {@code paper_bars.CONTRACT}). 다르면 읽지 않습니다. */
    static final int BARS_CONTRACT = 1;
    /** 창 하나 = T ~ T+4분에 시작한 봉(사다리 R1 T 봉·R2 다음 4분). */
    static final Duration WINDOW = Duration.ofMinutes(5);
    /** ⑤ 주문 생성 뒤 이만큼 지난 시각부터의 봉만(봉 라벨이 시작·끝 어느 쪽이어도 생성 뒤에 시작한 봉 — §8). */
    static final Duration AFTER_CREATED = Duration.ofSeconds(60);
    /** 지연 기준 종목(저장본 {@code reference}가 없을 때). */
    static final String REFERENCE = "SPY";

    /**
     * 반사실 가격 하나 — 원가격(슬리피지 전), 그 가격의 시장 시각(1분봉 = 봉 시작, 종가 = E 마감, 계좌1식 = 그 관측치 수집 시각), 사다리 칸.
     */
    record Price(double raw, Instant at, String rung) {

        /** 저장 모양 {@code {raw, at, rung}}(at은 UTC ISO). */
        ObjectNode toJson() {
            ObjectNode out = JsonNodeFactory.instance.objectNode();
            out.put("raw", raw);
            out.put("at", at.toString());
            out.put("rung", rung);
            return out;
        }
    }

    /** 미국 Claude 계좌(실행 감사 대상) — 미국 책 정의 가운데 kind CLAUDE, 정의 순. 지금은 계좌1({@code claude}) 하나. */
    static List<String> auditedBooks() {
        return UsPaperMarket.INSTANCE.books().stream().filter(d -> PaperBooks.KIND_CLAUDE.equals(d.kind()))
                .map(PaperBooks.Definition::code).toList();
    }

    /** 목표 세션 E — 기준 거래일 다음 거래일. 기준 거래일이 없으면 null. */
    static LocalDate targetSession(Order order, TradingCalendar calendar) {
        return order.asOfTradingDate() == null ? null : calendar.nextTradingDay(order.asOfTradingDate());
    }

    /**
     * 목표 시각 T — 메뉴 시점은 E의 그 시각(뉴욕), NEXT_CLOSE는 E 마감(조기 폐장일 13:00), 정해진 시각이 없는 NEXT_OBSERVATION·모르는 시점은
     * null.
     */
    static Instant targetAt(String timing, LocalDate session, TradingCalendar calendar) {
        if (session == null) {
            return null;
        }
        LocalTime at = MENU.get(timing);
        if (at != null) {
            return ZonedDateTime.of(session, at, calendar.zone()).toInstant();
        }
        return PaperBooks.NEXT_CLOSE.equals(timing) ? calendar.closeInstant(session) : null;
    }

    /**
     * 메뉴 시점 하나의 반사실 — 1분봉 저장본(수집기 모양 contract 1)의 그 창에서 사다리 R1·R2(클래스 설명의 ⑤~⑧). 못 구하면 null.
     *
     * @param payload 1분봉 저장본 본문(없으면 null)
     */
    static Price fromBars(Order order, String timing, LocalDate session, JsonNode payload, TradingCalendar calendar) {
        LocalTime at = MENU.get(timing);
        if (at == null || session == null || payload == null || order.createdAt() == null
                || !calendar.isTradingDay(session) || payload.path("contract").asInt(-1) != BARS_CONTRACT) {
            return null;
        }
        Instant target = targetAt(timing, session, calendar);
        Instant close = calendar.closeInstant(session);
        if (!target.isBefore(close)) {
            return null;                                   // 조기 폐장일의 마감 뒤 시각 — 그날 그 시각에는 장이 없음
        }
        if (!target.isAfter(order.createdAt().plus(AFTER_CREATED))) {
            return null;                                   // ⑤ 주문 생성 + 60초 이전의 시각
        }
        JsonNode entry = Json.child(Json.child(payload, "tickers"), order.ticker());
        if (entry == null || Json.asBoolean(entry, "isStale")) {
            return null;                                   // ⑧ 이번에 받지 못해 이어받은 종목
        }
        JsonNode day = Json.child(Json.child(entry, "sessions"), session.toString());
        Instant fetched = day == null ? null : instant(Json.asText(day, "fetchedAt"));
        if (fetched == null || !fetched.isAfter(order.createdAt())) {
            return null;                                   // ⑥ E 세션이 없음 · ⑧ 주문 전에 받은 세션
        }
        List<MinuteBar> bars = bars(Json.child(Json.child(day, "windows"), label(at)));
        Instant end = target.plus(WINDOW);
        MinuteBar chosen = null;
        for (MinuteBar bar : bars) {
            boolean inWindow = !bar.start().isBefore(target) && bar.start().isBefore(end)
                    && bar.start().atZone(calendar.zone()).toLocalDate().equals(session);
            if (inWindow && bar.traded()) {
                chosen = bar;                              // ⑤⑥ 창 안 · ⑧ 거래량 > 0 — 시작 순으로 첫 봉
                break;
            }
        }
        if (chosen == null) {
            return null;
        }
        Instant last = lastBarStart(day);
        MinuteBar picked = chosen;
        boolean later = bars.stream().anyMatch(bar -> bar.start().isAfter(picked.start()))
                || (last != null && last.isAfter(chosen.start()));
        if (!later && fetched.isBefore(close.plus(PaperMarketData.FINAL_DELAY))) {
            return null;                                   // ⑦ 진행 중일 수 있는 봉 — 다음 저장본에서 다시 봄
        }
        return new Price(chosen.open(), chosen.start(), chosen.start().equals(target) ? RUNG_AT : RUNG_NEXT);
    }

    /**
     * NEXT_CLOSE 반사실 — 관측치가 E 확정 종가를 보일 때만(클래스 설명). 못 구하면 null.
     *
     * @param quotes 지금 관측치(없으면 null)
     */
    static Price fromQuotes(Order order, LocalDate session, Quotes quotes, TradingCalendar calendar) {
        if (quotes == null || session == null || order.createdAt() == null
                || !quotes.collectedAt().isAfter(order.createdAt())) {
            return null;                                   // ① 주문 뒤에 수집한 관측치만
        }
        Bar bar = quotes.bars().get(order.ticker());
        if (bar == null || bar.stale() || !session.equals(bar.date())) {
            return null;                                   // ④ 이어 쓴 봉 · E가 아닌 봉
        }
        if (!UsPaperMarket.INSTANCE.closeAvailable(session, quotes.collectedAt(), calendar)) {
            return null;                                   // E 마감 + 15분 전 — 아직 확정 종가가 아님
        }
        return new Price(bar.close(), calendar.closeInstant(session), RUNG_CLOSE);
    }

    /**
     * NEXT_OBSERVATION(계좌1식 기준) 반사실 — 그 주문이 계좌1식(시점 NEXT_OBSERVATION)으로 실제 체결됐으면 그 원가격. 사후 체결·관측치가 아닌
     * 가격 출처·체결 없음은 null.
     *
     * @param fill 그 주문의 체결(없으면 null)
     */
    static Price fromFill(Order order, Fill fill) {
        if (fill == null || !NEXT_OBSERVATION.equals(order.timing()) || fill.backfill()
                || !PaperBooks.SOURCE_QUOTES.equals(fill.priceSource()) || fill.observedAt() == null
                || order.createdAt() == null || !fill.observedAt().isAfter(order.createdAt())
                || !Double.isFinite(fill.rawPrice()) || !(fill.rawPrice() > 0)) {
            return null;
        }
        return new Price(fill.rawPrice(), fill.observedAt(), RUNG_OBSERVATION);
    }

    /**
     * 주문 하나의 반사실 전부 — {@link #TIMINGS} 순서의 시점 → 가격(못 구하면 null). 상태가 없는 계산이라 같은 입력이면 같은 값이고, 한 번 쓴
     * 값을 지키는 것은 저장 쪽입니다({@code PaperStore.mergeOrderExec}).
     */
    static Map<String, Price> counterfactuals(Order order, Fill fill, JsonNode barsPayload, Quotes quotes,
                                              TradingCalendar calendar) {
        LocalDate session = targetSession(order, calendar);
        Map<String, Price> out = new LinkedHashMap<>();
        for (String timing : TIMINGS) {
            Price price;
            if (NEXT_OBSERVATION.equals(timing)) {
                price = fromFill(order, fill);
            } else if (PaperBooks.NEXT_CLOSE.equals(timing)) {
                price = fromQuotes(order, session, quotes, calendar);
            } else {
                price = fromBars(order, timing, session, barsPayload, calendar);
            }
            out.put(timing, price);
        }
        return out;
    }

    /**
     * 1분봉 저장본의 지연(초) — 기준 종목(저장본 {@code reference}, 없으면 SPY)의 마지막 세션을 받은 시각 − (그 세션 마지막 봉 시작 + 60초).
     * 기준 종목이 이어받은 값이거나, 받은 시각이 그 세션 날의 정규장(미국 달력 — 조기 폐장일은 13:00까지) 밖이면 null — 장이 닫힌 시간은
     * 지연이 아닙니다. 음수(진행 중인 봉까지 받음 — X1의 단서)는 그대로 둡니다.
     */
    static Integer lagSeconds(JsonNode payload, TradingCalendar calendar) {
        if (payload == null || payload.path("contract").asInt(-1) != BARS_CONTRACT) {
            return null;
        }
        String reference = Json.asText(payload, "reference");
        JsonNode entry = Json.child(Json.child(payload, "tickers"), reference == null ? REFERENCE : reference);
        JsonNode sessions = Json.child(entry, "sessions");
        if (entry == null || Json.asBoolean(entry, "isStale") || sessions == null || !sessions.isObject()) {
            return null;
        }
        String latest = null;
        for (String name : sessions.propertyNames()) {
            if (Json.parseDate(name) != null && (latest == null || name.compareTo(latest) > 0)) {
                latest = name;
            }
        }
        LocalDate day = Json.parseDate(latest);
        if (day == null || !calendar.isTradingDay(day)) {
            return null;
        }
        JsonNode session = sessions.get(latest);
        Instant fetched = instant(Json.asText(session, "fetchedAt"));
        Instant last = lastBarStart(session);
        if (fetched == null || last == null || fetched.isBefore(calendar.openInstant(day))
                || !fetched.isBefore(calendar.closeInstant(day))) {
            return null;
        }
        return Math.toIntExact(Math.round(Duration.between(last.plusSeconds(60), fetched).toMillis() / 1000.0));
    }

    /** 창 키 'HH:MM'(수집기 저장본 {@code windows}의 키, {@code menu} 대응표의 값). */
    static String label(LocalTime at) {
        return String.format("%02d:%02d", at.getHour(), at.getMinute());
    }

    // ------------------------------------------------------------------ 저장본 읽기
    /** 1분봉 한 줄 — 봉 시작·시가·거래량(모르면 null). */
    private record MinuteBar(Instant start, double open, Double volume) {

        /** 거래량 &gt; 0(모르면 거래로 보지 않음)이고 시가가 쓸 수 있는 값. */
        boolean traded() {
            return volume != null && volume > 0 && Double.isFinite(open) && open > 0;
        }
    }

    /** 창 하나의 봉(시작 순). 시각·시가를 읽을 수 없는 줄은 뺍니다. */
    private static List<MinuteBar> bars(JsonNode window) {
        List<MinuteBar> out = new ArrayList<>();
        if (window == null || !window.isArray()) {
            return out;
        }
        for (JsonNode row : window) {
            Instant start = instant(Json.asText(row, "t"));
            Double open = Json.asDouble(row, "o");
            if (start != null && open != null) {
                out.add(new MinuteBar(start, open, Json.asDouble(row, "v")));
            }
        }
        out.sort(Comparator.comparing(MinuteBar::start));
        return out;
    }

    private static Instant lastBarStart(JsonNode session) {
        return instant(Json.asText(Json.child(session, "lastBar"), "t"));
    }

    private static Instant instant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text.strip()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static Map<String, LocalTime> menu() {
        Map<String, LocalTime> out = new LinkedHashMap<>();
        out.put(PaperBooks.NEXT_OPEN, LocalTime.of(9, 30));
        for (int hour = 10; hour <= 15; hour++) {
            out.put(String.format("AT_%02d00", hour), LocalTime.of(hour, 0));
        }
        return java.util.Collections.unmodifiableMap(out);
    }

    private static List<String> timings() {
        List<String> out = new ArrayList<>();
        out.add(NEXT_OBSERVATION);
        out.addAll(MENU.keySet());
        out.add(PaperBooks.NEXT_CLOSE);
        return List.copyOf(out);
    }
}
