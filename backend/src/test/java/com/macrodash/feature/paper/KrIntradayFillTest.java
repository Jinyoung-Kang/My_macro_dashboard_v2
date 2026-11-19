package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 장중 감시 STOP 체결의 순수 계산({@link KrIntradayFill} — ADR 0045): 대상(G1의 주문 부분)·G5 시각·창 만들기(수집기 summarize_windows 규칙)·R1과 안정
 * 조건·미리 보기 반례(라벨 T 봉)·G3 시간 순서 표·G4 기업행위 넷·밤 뒤 대조 칸.
 *
 * <p>세션 S = 2026-11-17(화), 전 거래일 2026-11-16. 감지 13:10:42 → T 13:11, R1 라벨 13:12.
 */
class KrIntradayFillTest {

    static final LocalDate S = LocalDate.of(2026, 11, 17);
    static final LocalDate PREV = LocalDate.of(2026, 11, 16);
    static final TradingCalendar CALENDAR = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)),
            List.of());

    static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    /** 감시 STOP — 장중 시장가, 기준일 PREV, 만료 S. */
    static Order watchStop(long id, String ticker, Instant created) {
        return new Order(id, PaperBooks.KR_RULES, null, ticker, PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE), PREV, created, S, null);
    }

    /** 감시 항목 — 라벨(봉 끝) → 시가(종가 = 시가 + 5), 거래량은 {@code quiet}이면 0, 아니면 100. 전일 원시·수정 종가는 PREV. */
    static ObjectNode entry(LocalDate session, Instant fetched, Map<String, Double> bars, List<String> quiet) {
        ObjectNode entry = MAPPER.createObjectNode();
        entry.put("fetchedAt", fetched.toString());
        entry.put("session", session.toString());
        ArrayNode array = entry.putArray("bars");
        new TreeMap<>(bars).forEach((label, open) -> {
            ObjectNode bar = array.addObject();
            bar.put("label", label).put("o", open).put("h", open + 5).put("l", open).put("c", open + 5).put("v", quiet.contains(label) ? 0 : 100);
        });
        entry.putObject("day").putObject("first").put("label", "09:01").put("o", 70_000.0);
        entry.putObject("prevClose").put("date", session.equals(S) ? PREV.toString() : session.minusDays(1).toString())
                .put("raw", 70_000.0).put("adjusted", 70_000.0);
        return entry;
    }

    static Map<String, Double> minutes(String from, String to, double base) {
        Map<String, Double> out = new TreeMap<>();
        LocalTime t = LocalTime.parse(from);
        int i = 0;
        while (!t.isAfter(LocalTime.parse(to))) {
            out.put(KrTimedLadder.label(t), base + 10 * i++);
            t = t.plusMinutes(1);
        }
        return out;
    }

    @Test
    @DisplayName("대상(G1의 주문 부분) — 장중 감시 STOP·장중 시장가·목표 세션과 만료일이 S·T가 종가 단일가 전만, 밤 대체·지정 시각·종가·체결된 주문·기준일이 다른 주문은 아님")
    void candidates() {
        Order stop = watchStop(1, "005930", kst("2026-11-17T13:10:42"));
        assertThat(KrIntradayFill.candidate(stop, S, CALENDAR)).isTrue();
        assertThat(KrIntradayFill.candidate(watchStop(2, "005930", kst("2026-11-17T15:18:59")), S, CALENDAR)).as("T 15:19").isTrue();
        assertThat(KrIntradayFill.candidate(watchStop(3, "005930", kst("2026-11-17T15:19:00")), S, CALENDAR)).as("T 15:20 — 종가 단일가")
                .isFalse();
        Order nightFallback = new Order(4, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("stopMode",
                PaperLedgerService.STOP_MODE_NIGHT_FALLBACK), PREV, kst("2026-11-17T13:10:42"), S, null);
        assertThat(KrIntradayFill.candidate(nightFallback, S, CALENDAR)).as("밤 대체 STOP(금융위 재판정)").isFalse();
        Order atMinute = new Order(5, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.AT_MINUTE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, stop.reason(), PREV, kst("2026-11-17T09:09:20"), S, null,
                LocalTime.of(9, 10));
        assertThat(KrIntradayFill.candidate(atMinute, S, CALENDAR)).as("첫 분 지정 시각").isFalse();
        Order close = new Order(6, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.NEXT_CLOSE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, stop.reason(), PREV, kst("2026-11-17T15:19:20"), S, null);
        assertThat(KrIntradayFill.candidate(close, S, CALENDAR)).as("종가 STOP").isFalse();
        Order filled = new Order(7, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_FILLED, null, stop.reason(), PREV, kst("2026-11-17T13:10:42"), S, kst("2026-11-17T21:00"));
        assertThat(KrIntradayFill.candidate(filled, S, CALENDAR)).isFalse();
        Order yesterday = new Order(8, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, stop.reason(), LocalDate.of(2026, 11, 13), kst("2026-11-16T13:10:42"),
                PREV, null);
        assertThat(KrIntradayFill.candidate(yesterday, S, CALENDAR)).as("지난 세션의 STOP(QA-318)").isFalse();
        Order claude = new Order(9, PaperBooks.KR_CLAUDE, null, "005930", PaperBooks.SELL, null, null, 1.0, PaperBooks.MARKET,
                PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, null, PREV, kst("2026-11-17T13:10:42"), S, null);
        assertThat(KrIntradayFill.candidate(claude, S, CALENDAR)).as("Claude 장중 시장가(2단계)").isFalse();
    }

    @Test
    @DisplayName("G5 시각 = 실제 계좌 스탑 창 끝(시작 max(T, 개장 + 10분), 끝 min(시작 + 3분, 종가 단일가 시작 − 30초)) + 60초 — 감지 09:10:30이면 T 09:11·끝 09:14·기록 09:15 뒤")
    void gateAt() {
        assertThat(KrIntradayFill.gateAt(CALENDAR, S, ExecutionAudit.marketTarget(kst("2026-11-17T09:10:30")))).isEqualTo(kst("2026-11-17T09:15:00"));
        assertThat(KrIntradayFill.gateAt(CALENDAR, S, kst("2026-11-17T13:11"))).isEqualTo(kst("2026-11-17T13:15"));
        assertThat(KrIntradayFill.gateAt(CALENDAR, S, kst("2026-11-17T15:19"))).as("창 끝이 종가 단일가 30초 전에서 잘림")
                .isEqualTo(kst("2026-11-17T15:20:30"));
        assertThat(KrIntradayFill.gateAt(CALENDAR, S, kst("2026-11-17T09:05"))).as("개장 10분 전 T — 창은 09:10부터")
                .isEqualTo(kst("2026-11-17T09:14"));
        assertThat(SessionWindows.krStopMirrorEnd(kst("2026-11-17T09:00"), kst("2026-11-17T15:20"), kst("2026-11-17T15:19:45")))
                .as("창이 빔").isNull();
    }

    @Test
    @DisplayName("창 만들기(수집기 summarize_windows 규칙) — 창 키 T의 창은 라벨 T+1~T+5(거래량 0 봉 포함, 라벨 T 봉 제외), 창 뒤 첫 거래 봉은 라벨 ≥ T+1이고 거래량 > 0")
    void timedWindow() {
        Map<String, Double> bars = minutes("13:05", "13:20", 70_000);
        ObjectNode entry = entry(S, kst("2026-11-17T13:20:20"), bars, List.of("13:12", "13:13", "13:14", "13:15", "13:16"));
        Timed timed = KrIntradayFill.timed(entry, LocalTime.of(13, 11));
        assertThat(timed.status()).isEqualTo(KrQuotes.TIMED_OK);
        assertThat(timed.fetchedAt()).isEqualTo(kst("2026-11-17T13:20:20"));
        assertThat(timed.windows().get("13:11")).extracting(KrQuotes.Bar1m::label).containsExactly("13:12", "13:13", "13:14", "13:15", "13:16");
        assertThat(timed.windows().get("13:11")).allSatisfy(b -> assertThat(b.traded()).isFalse());
        assertThat(timed.firstAfter().get("13:11").label()).as("창 뒤 첫 거래 봉").isEqualTo("13:17");
        assertThat(timed.closes()).isEmpty();
    }

    @Test
    @DisplayName("R1과 안정 조건 — 항목 수집이 라벨 T+1 끝 + 60초 이후·그 세션·이어받지 않음·T+1 봉 거래일 때만, 라벨 T 봉만 거래면 고르지 않음(봉 끝 라벨 — 'barTime ≥ T'로 거르면 라벨 T 봉이 들어오는 함정)")
    void r1AndTheLookAheadTrap() {
        Order stop = watchStop(1, "005930", kst("2026-11-17T13:10:42"));
        Map<String, Double> bars = minutes("13:05", "13:20", 70_000);
        KrIntradayFill.R1 ok = KrIntradayFill.r1(stop, entry(S, kst("2026-11-17T13:15:20"), bars, List.of()), S, CALENDAR);
        assertThat(ok.found()).isTrue();
        assertThat(ok.choice().price()).isEqualByComparingTo("70070");
        assertThat(ok.choice().source()).isEqualTo(KrTimedLadder.SOURCE_AT);
        assertThat(ok.barLabel()).isEqualTo("13:12");
        assertThat(ok.volume()).isEqualTo(100L);
        assertThat(ok.fetchedAt()).isEqualTo(kst("2026-11-17T13:15:20"));

        KrIntradayFill.R1 early = KrIntradayFill.r1(stop, entry(S, kst("2026-11-17T13:12:59"), bars, List.of()), S, CALENDAR);
        assertThat(early.found()).as("13:13:00 전 — 덜 굳음").isFalse();
        assertThat(early.settled()).isFalse();
        assertThat(early.decided()).isFalse();
        assertThat(KrIntradayFill.r1(stop, entry(S, kst("2026-11-17T13:13:00"), bars, List.of()), S, CALENDAR).found()).as("경계 포함").isTrue();

        ObjectNode stale = entry(S, kst("2026-11-17T13:15:20"), bars, List.of());
        stale.put("isStale", true);
        assertThat(KrIntradayFill.r1(stop, stale, S, CALENDAR).found()).isFalse();
        assertThat(KrIntradayFill.r1(stop, entry(PREV, kst("2026-11-16T13:15:20"), bars, List.of()), S, CALENDAR).found()).isFalse();
        assertThat(KrIntradayFill.r1(stop, null, S, CALENDAR).reason()).contains("감시 항목 없음");

        // 미리 보기 반례 — 라벨 T(13:11) 봉은 거래, T+1(13:12) 봉은 거래 없음: 봉 시각 ≥ T로 고르면 라벨 13:11 봉(13:10~13:11 — 생성 앞 거래)을 고름.
        ObjectNode trap = entry(S, kst("2026-11-17T13:15:20"), bars, List.of("13:12"));
        assertThat(StopWatch.barTime(trap.get("bars").get(6), S, CALENDAR, true)).as("라벨 13:11 봉의 시각 = T").isEqualTo(kst("2026-11-17T13:11"));
        KrIntradayFill.R1 none = KrIntradayFill.r1(stop, trap, S, CALENDAR);
        assertThat(none.found()).as("R1 없음(창 안 다음 봉은 R2 — 밤에 맡김)").isFalse();
        assertThat(none.reason()).contains("TOSS_1M_NEXT");
        assertThat(none.decided()).as("라벨 T+1 봉이 완성됐는데 거래 없음 — 굳음(기다리지 않고 밤에 맡김)").isTrue();
    }

    @Test
    @DisplayName("G3 시간 순서 표 — 시가 대기(날짜·출처 무관)·장중 시각 ≤ T인 대기(같은 시각 포함, 앞 세션 기다림 주문의 LocalTime 포함)·같은 종목 주문은 밤에 맡김, 다른 종목 STOP 매도·뒤 시각·종가·만료일 < S·자기 자신은 막지 않음")
    void orderGateTable() {
        Order stop = watchStop(1, "005930", kst("2026-11-17T13:10:42"));
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop), S)).isEmpty();
        Order otherStop = watchStop(2, "000660", kst("2026-11-17T13:10:41"));                          // 같은 T(13:11) 다른 종목 STOP
        Order otherStopEarlier = watchStop(3, "035420", kst("2026-11-17T12:00:10"));                   // 이른 T 다른 종목 STOP
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, otherStop, otherStopEarlier), S)).as("다른 종목 STOP 매도끼리는 서로 막지 않음").isEmpty();
        Order open = order(10, "000270", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, null, null, S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, open), S)).containsExactly(KrIntradayFill.OPEN_ORDER);
        Order openSell = order(11, "000270", PaperBooks.SELL, PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP, null, null, S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, openSell), S)).as("다른 종목 시가 STOP 매도도 막음(보수적 — D13)")
                .containsExactly(KrIntradayFill.OPEN_ORDER);
        Order sameTime = order(12, "000270", PaperBooks.BUY, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, null, LocalTime.of(13, 11), S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, sameTime), S)).containsExactly(KrIntradayFill.EARLIER_ORDER);
        Order later = order(13, "000270", PaperBooks.BUY, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, null, LocalTime.of(13, 12), S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, later), S)).as("뒤 시각").isEmpty();
        Order waitingFromBefore = order(14, "000270", PaperBooks.BUY, PaperBooks.AT_MINUTE, PacketBuilder.SOURCE_CLAUDE, null,
                LocalTime.of(10, 30), LocalDate.of(2026, 11, 19));                                       // 앞 세션의 10:30 주문 — 날짜를 보지 않음
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, waitingFromBefore), S)).containsExactly(KrIntradayFill.EARLIER_ORDER);
        Order closeBuy = order(15, "000270", PaperBooks.BUY, PaperBooks.NEXT_CLOSE, PacketBuilder.SOURCE_CLAUDE, null, null, S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, closeBuy), S)).as("종가는 장중 뒤").isEmpty();
        Order same = order(16, "005930", PaperBooks.BUY, PaperBooks.NEXT_CLOSE, PacketBuilder.SOURCE_CLAUDE, null, null, S);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, same), S)).containsExactly(KrIntradayFill.SAME_TICKER);
        Order expired = order(17, "000270", PaperBooks.BUY, PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, null, null, PREV);
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, expired), S)).as("만료일 < S — 밤 1단계가 먼저 만료").isEmpty();
        assertThat(KrIntradayFill.orderGate(stop, List.of(stop, open, sameTime, same), S))
                .containsExactly(KrIntradayFill.OPEN_ORDER, KrIntradayFill.EARLIER_ORDER, KrIntradayFill.SAME_TICKER);
    }

    private static Order order(long id, String ticker, String side, String timing, String source, Instant created, LocalTime at,
                               LocalDate expires) {
        return new Order(id, PaperBooks.KR_CLAUDE, null, ticker, side, null, PaperBooks.BUY.equals(side) ? 5.0 : null,
                PaperBooks.SELL.equals(side) ? 1.0 : null, timing, source, PaperBooks.ORDER_PENDING, null, null, PREV,
                created == null ? kst("2026-11-16T22:40") : created, expires, null, at);
    }

    @Test
    @DisplayName("G4 기업행위 넷 — 미처리 표시(CORP_HOLD)·since 봉이 전 거래일 아님(CORP_SINCE)·갭 가드·전일 원시·수정 종가·날짜(CORP_GUARD)·금융위 상장주식수 ±10%(CORP_LISTING), 모두 통과면 빈 목록")
    void corpGateFour() {
        Position position = new Position(PaperBooks.KR_RULES, "005930", 10, 60_000, PREV.minusDays(10), kst("2026-11-03T09:10"), 80_000,
                kst("2026-11-16T21:00"), 70_000.0, kst("2026-11-16T21:00"), false, PREV, 70_000, null);
        ObjectNode watched = entry(S, kst("2026-11-17T13:15:20"), minutes("13:05", "13:20", 70_000), List.of());
        KrConfirmed.Series listed = series(PREV, 1_000_000L, LocalDate.of(2026, 11, 13), 1_000_000L);
        assertThat(KrIntradayFill.corpGate(position, 1_000L, false, watched, listed, S, PREV, false)).isEmpty();
        assertThat(KrIntradayFill.corpGate(position, 1_000L, true, watched, listed, S, PREV, false)).containsExactly(KrIntradayFill.CORP_HOLD);
        Position older = new Position(PaperBooks.KR_RULES, "005930", 10, 60_000, PREV.minusDays(10), kst("2026-11-03T09:10"), 80_000,
                kst("2026-11-16T21:00"), 70_000.0, kst("2026-11-16T21:00"), false, LocalDate.of(2026, 11, 13), 70_000, null);
        assertThat(KrIntradayFill.corpGate(older, 1_000L, false, watched, listed, S, PREV, false)).containsExactly(KrIntradayFill.CORP_SINCE);
        ObjectNode gap = watched.deepCopy();
        ((ObjectNode) gap.get("day").get("first")).put("o", 50_000.0);                                    // 시가 ≤ 전일 × 0.85
        assertThat(KrIntradayFill.corpGate(position, 1_000L, false, gap, listed, S, PREV, false)).containsExactly(KrIntradayFill.CORP_GUARD);
        ObjectNode noAdjusted = watched.deepCopy();
        ((ObjectNode) noAdjusted.get("prevClose")).putNull("adjusted");                                   // 가드는 통과시키지만 장중 기록은 더 엄함
        assertThat(StopWatch.guard(noAdjusted, true, null).clear()).isTrue();
        assertThat(KrIntradayFill.corpGate(position, 1_000L, false, noAdjusted, listed, S, PREV, false)).containsExactly(KrIntradayFill.CORP_GUARD);
        ObjectNode wrongDate = watched.deepCopy();
        ((ObjectNode) wrongDate.get("prevClose")).put("date", "2026-11-13");
        assertThat(KrIntradayFill.corpGate(position, 1_000L, false, wrongDate, listed, S, PREV, false)).containsExactly(KrIntradayFill.CORP_GUARD);
        KrConfirmed.Series grown = series(PREV, 1_200_000L, LocalDate.of(2026, 11, 13), 1_000_000L);   // 상장주식수 +20%
        assertThat(KrIntradayFill.corpGate(position, 1_000L, false, watched, grown, S, PREV, false)).containsExactly(KrIntradayFill.CORP_LISTING);
        assertThat(KrIntradayFill.corpGate(position, 1_000L, true, gap, grown, S, PREV, false))
                .as("넷 모두 봄(통계용)").containsExactly(KrIntradayFill.CORP_HOLD, KrIntradayFill.CORP_GUARD, KrIntradayFill.CORP_LISTING);
    }

    private static KrConfirmed.Series series(LocalDate latest, long shares, LocalDate before, long sharesBefore) {
        NavigableMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
        days.put(before, new KrConfirmed.Day(before, BigDecimal.valueOf(70_000), 1_000L, sharesBefore, BigDecimal.valueOf(70_000), "KOSPI"));
        days.put(latest, new KrConfirmed.Day(latest, BigDecimal.valueOf(70_000), 1_000L, shares, BigDecimal.valueOf(70_000), "KOSPI"));
        return new KrConfirmed.Series(KrConfirmed.SOURCE_FSC, latest, days);
    }

    @Test
    @DisplayName("밤 뒤 대조 칸 — 같은 값이면 match, 체결되지 않았으면 NIGHT_NOT_FILLED, 설정 판이 다르면 SETTINGS_CHANGED를 따로, 밤에 맡긴 기록은 견주지 않음(match 없음)")
    void nightCheck() {
        ObjectNode record = MAPPER.createObjectNode().put(KrIntradayFill.MODE, "SHADOW").put(KrIntradayFill.OUTCOME, KrIntradayFill.RECORD)
                .put(KrIntradayFill.RAW_PRICE, 70_170).put(KrIntradayFill.PRICE_SOURCE, KrTimedLadder.SOURCE_AT).put(KrIntradayFill.QTY, 10)
                .put(KrIntradayFill.TARGET_AT, kst("2026-11-17T13:11").toString()).put(KrIntradayFill.SETTINGS_VERSION, 29);
        Order filled = filled(PaperBooks.ORDER_FILLED);
        Fill fill = new Fill(9, 1, PaperBooks.KR_RULES, "005930", PaperBooks.SELL, 10, 70_170, 70_170, 5, 701_700, kst("2026-11-17T21:00"), S,
                KrTimedLadder.SOURCE_AT, false, kst("2026-11-17T21:00:01"), BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        Instant now = kst("2026-11-17T21:01");
        Map<String, Object> same = KrIntradayFill.check(record, filled, fill, 29, now);
        assertThat(same.get("match")).isEqualTo(true);
        assertThat(reasons(same)).isEmpty();
        assertThat(same.get("nightRawPrice")).isEqualTo(70_170.0);
        assertThat(same.get("nightDate")).isEqualTo(S.toString());

        Map<String, Object> changed = KrIntradayFill.check(record, filled, fill, 30, now);
        assertThat(changed.get("match")).as("값은 같음").isEqualTo(true);
        assertThat(reasons(changed)).containsExactly(KrIntradayFill.SETTINGS_CHANGED);

        Map<String, Object> expired = KrIntradayFill.check(record, filled(PaperBooks.ORDER_EXPIRED), null, null, now);
        assertThat(expired.get("match")).isEqualTo(false);
        assertThat(reasons(expired)).containsExactly(KrIntradayFill.NIGHT_NOT_FILLED);
        assertThat(expired.get("nightStatus")).isEqualTo(PaperBooks.ORDER_EXPIRED);

        Fill other = new Fill(9, 1, PaperBooks.KR_RULES, "005930", PaperBooks.SELL, 9, 70_180, 70_180, 5, 631_620, kst("2026-11-18T21:00"),
                LocalDate.of(2026, 11, 18), KrTimedLadder.SOURCE_NEXT, false, kst("2026-11-18T21:00:01"), BigDecimal.ZERO, BigDecimal.ZERO,
                BigDecimal.ZERO);
        assertThat(reasons(KrIntradayFill.check(record, filled, other, 29, now))).containsExactly(
                KrIntradayFill.PRICE_MISMATCH, KrIntradayFill.SOURCE_MISMATCH, KrIntradayFill.QTY_MISMATCH, KrIntradayFill.DATE_MISMATCH);

        ObjectNode deferred = record.deepCopy().put(KrIntradayFill.OUTCOME, KrIntradayFill.DEFER);
        Map<String, Object> notCompared = KrIntradayFill.check(deferred, filled, fill, 29, now);
        assertThat(notCompared.get("match")).isNull();
        assertThat(reasons(notCompared)).isEmpty();
    }

    @Test
    @org.junit.jupiter.api.Disabled("QA-792 — 수정 전 실패: 세금만 다른 밤 체결의 대조가 match=true·reasons [] (기대 false·[COST_MISMATCH])")
    @DisplayName("QA-792: 밤 뒤 대조 — 관측가·출처·수량·관측일이 같아도 밤 체결의 비용(수수료·세금·슬리피지 — 기록 때와 밤의 금융위 시장 구분·설정이 갈린 날)이 "
            + "기록과 다르면 COST_MISMATCH(불일치 — 현금이 갈림), 설정 판도 다르면 SETTINGS_CHANGED를 함께")
    void nightCheckComparesCosts() {
        ObjectNode record = MAPPER.createObjectNode().put(KrIntradayFill.MODE, "SHADOW").put(KrIntradayFill.OUTCOME, KrIntradayFill.RECORD)
                .put(KrIntradayFill.RAW_PRICE, 70_170).put(KrIntradayFill.PRICE_SOURCE, KrTimedLadder.SOURCE_AT).put(KrIntradayFill.QTY, 10)
                .put(KrIntradayFill.TARGET_AT, kst("2026-11-17T13:11").toString()).put(KrIntradayFill.SETTINGS_VERSION, 29)
                .put(KrIntradayFill.FEE, new BigDecimal("105.2550")).put(KrIntradayFill.TAX, new BigDecimal("1403"))
                .put(KrIntradayFill.SLIPPAGE_COST, new BigDecimal("350.85"));
        Order filled = filled(PaperBooks.ORDER_FILLED);
        Instant now = kst("2026-11-17T21:01");
        Fill same = nightFill(new BigDecimal("105.255"), new BigDecimal("1403"), new BigDecimal("350.8500"));
        Map<String, Object> equal = KrIntradayFill.check(record, filled, same, 29, now);
        assertThat(equal.get("match")).as("소수 자릿수만 다른 같은 값").isEqualTo(true);
        assertThat(reasons(equal)).isEmpty();

        Fill taxed = nightFill(new BigDecimal("105.255"), new BigDecimal("1052"), new BigDecimal("350.85"));
        Map<String, Object> differed = KrIntradayFill.check(record, filled, taxed, 29, now);
        assertThat(differed.get("match")).isEqualTo(false);
        assertThat(reasons(differed)).containsExactly("COST_MISMATCH");
        Map<String, Object> saved = KrIntradayFill.check(record, filled, taxed, 30, now);
        assertThat(saved.get("match")).as("설정 판이 달라도 비용이 다르면 불일치").isEqualTo(false);
        assertThat(reasons(saved)).containsExactly("COST_MISMATCH", KrIntradayFill.SETTINGS_CHANGED);
    }

    private static Fill nightFill(BigDecimal fee, BigDecimal tax, BigDecimal slippage) {
        return new Fill(9, 1, PaperBooks.KR_RULES, "005930", PaperBooks.SELL, 10, 70_134.915, 70_170, 5, 701_349.15, kst("2026-11-17T21:00"), S,
                KrTimedLadder.SOURCE_AT, false, kst("2026-11-17T21:00:01"), fee, tax, slippage);
    }

    @SuppressWarnings("unchecked")
    private static List<String> reasons(Map<String, Object> check) {
        return (List<String>) check.get(KrIntradayFill.REASONS);
    }

    private static Order filled(String status) {
        return new Order(1, PaperBooks.KR_RULES, null, "005930", PaperBooks.SELL, null, null, null, PaperBooks.MARKET, PaperBooks.SOURCE_STOP,
                status, null, null, PREV, kst("2026-11-17T13:10:42"), S, PaperBooks.ORDER_FILLED.equals(status) ? kst("2026-11-17T21:00") : null);
    }
}
