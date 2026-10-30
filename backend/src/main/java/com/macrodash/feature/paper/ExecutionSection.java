package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.ExecutionTiming;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 🧪 미국 Claude 계좌2 패킷의 {@code 13_execution} 섹션(계좌2 명세 2026-10-30-claude-book2-timing-design.md §9-3, {@code executionMenuVersion} 1 —
 * 단계 1) — 목표 세션 E(기준 거래일 다음 거래일)의 날짜·개장·마감(ET·KST)·조기 폐장, 체결 시점 메뉴와 한 줄 뜻, 가격 사다리, 출처 사실(§7-2의 1·2),
 * 슬리피지, 자기 체결 기록({@code record} — 최근 20건, 사실만, T14).
 *
 * <p>날짜·시각은 달력이 정한 앞날(다음 세션 — {@code 1_basis.nextSession}과 같은 뜻)이라 자료가 아니고, 뉴욕 시간으로 정한 시각을 그날의
 * {@code America/New_York}으로 바꿔 KST를 적습니다(서머타임 전환 주에도 고정 오프셋 없음 — 2026-11-02 EST의 09:30 ET = 23:30 KST).
 *
 * <p><b>체결 기록</b>은 그 계좌의 결정 주문(출처 CLAUDE) 가운데 체결된 것, 최근 체결 순 {@value #RECORD_ROWS}건입니다 — 고른 시점·체결 원가격(슬리피지
 * 전)·사다리 칸·대체 체결 여부·체결 봉(KST)·계좌1식 기준 반사실(실행 감사 {@code paper_order_exec}의 {@code NEXT_OBSERVATION} 원가격 — 아직 없거나
 * 증명하지 못했으면 null)·차이 bp({@link ExecutionTiming#advantageBp} — 양수면 그 체결이 계좌1식보다 유리, 기준이 없으면 null). 평가 문장은 넣지
 * 않습니다(사실만). 설정 {@code claude2.executionRecord}가 꺼져 있으면 기록 없이 그 사실만 적습니다. 저장된 사실만 읽어 같은 상태면 같은 글자입니다.
 *
 * <p><b>장중 확인 판</b>({@code executionMenuVersion} 2 — 계좌2 명세 §9-3 단계 2, 설정 {@code claude2.checkpoints}를 켠 결정만): 위에 더해
 * {@code checkpointOptions}(고를 수 있는 확인 시각 — E의 10:00~15:00 ET 30분 단위, 마감 − 30분까지라 조기 폐장일은 12:30까지 · 피드 둘의 뜻 ·
 * 감시 목록 상한 · 최근 잰 지연 요약 · 규칙)와 출처 사실 셋째 줄. 끄면 섹션이 단계 1과 글자 그대로입니다(§16-3).
 */
final class ExecutionSection {

    private ExecutionSection() {
    }

    /** 체결 기록 상한(§9-3 — T14). */
    static final int RECORD_ROWS = 20;
    /** 체결 기록 한 줄의 열. */
    static final List<String> RECORD_COLUMNS = List.of("asOfTradingDate", "session", "ticker", "side", "timing",
            "rawPrice", "fillRung", "fallback", "barAtKst", "baselineRaw", "vsBaselineBp");
    /** 메뉴 한 줄의 열. */
    static final List<String> MENU_COLUMNS = List.of("timing", "atEt", "atKst", "meaning");

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    // ------------------------------------------------------------------ 장중 확인(단계 2 — 계좌2 명세 §5-2·§9-5)
    /** 장중 확인 피드 — 감시 종목 1분봉(5분 수집, 잰 지연). V18 {@code paper_checkpoints.feed} CHECK와 같은 글자. */
    static final String FEED_MINUTE = "MINUTE";
    /** 장중 확인 피드 — 전 종목 시간별 관측치(최대 60분 묵음). */
    static final String FEED_HOURLY = "HOURLY";
    /** 장중 확인 피드, 스키마 {@code checkpoint.feed} enum 순서. */
    static final List<String> FEEDS = List.of(FEED_MINUTE, FEED_HOURLY);
    /** 감시 목록 상한(스키마 {@code checkpoint.watch.maxItems}). */
    static final int WATCH_MAX = 10;
    /** 확인 시각은 E 마감보다 이만큼 앞서야 함(보통 날 15:00·조기 폐장일 12:30까지 — §5-2). */
    static final java.time.Duration CHECKPOINT_BEFORE_CLOSE = java.time.Duration.ofMinutes(30);
    /** 고를 수 있는 확인 시각(뉴욕) — 10:00~15:00 30분 단위, 스키마 {@code checkpoint.atEt} enum과 같은 목록({@code DecisionTimingsLockTest}). */
    static final List<LocalTime> CHECKPOINT_TIMES = checkpointGrid();

    /** 피드 한 줄 뜻('실시간'이라는 말은 쓰지 않음 — §7-2의 3). */
    static final Map<String, String> FEED_MEANINGS = feedMeanings();
    /** 장중 확인 규칙(고정 문단 장중 확인 절과 같은 뜻). */
    static final List<String> CHECKPOINT_RULES = List.of(
            "세션당 최대 한 번 — 고른 시각 + 2분 ~ + 20분에 한 번 부른다",
            "재시도 없음 — 호출이 실패해도 다시 부르지 않는다",
            "놓치면 없음 — 서버 꺼짐·자료 없음·호출 상한으로 그 창을 놓치면 나중에 대신 부르지 않고, 아침 주문은 그대로 체결된다");
    /** 출처 사실 셋째 줄(장중 확인 판만). */
    static final String CHECKPOINT_SOURCE_FACT = "장중 확인을 고르면 그때 볼 자료(MINUTE·HOURLY)만 고른다 — 체결가는 여전히 주문 뒤 1분봉이다.";

    private static List<LocalTime> checkpointGrid() {
        List<LocalTime> out = new ArrayList<>();
        for (LocalTime t = LocalTime.of(10, 0); !t.isAfter(LocalTime.of(15, 0)); t = t.plusMinutes(30)) {
            out.add(t);
        }
        return List.copyOf(out);
    }

    private static Map<String, String> feedMeanings() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(FEED_MINUTE, "감시 종목(watch, 10개 이하) + 보유·대기 종목의 최근 완성 1분봉 — 5분마다 수집, 잰 지연(lagSeconds)을 함께 줌. "
                + "그 밖의 종목은 보지 못함");
        out.put(FEED_HOURLY, "유니버스 전 종목의 시간별 관측치 — 최대 60분 묵은 값(수집 시각을 함께 줌)");
        return java.util.Collections.unmodifiableMap(out);
    }

    /** 그 세션에서 고를 수 있는 확인 시각 — {@link #CHECKPOINT_TIMES} 가운데 마감 − {@link #CHECKPOINT_BEFORE_CLOSE} 이하(조기 폐장일 12:30까지). */
    static List<LocalTime> checkpointTimes(LocalDate session, TradingCalendar calendar) {
        Instant last = calendar.closeInstant(session).minus(CHECKPOINT_BEFORE_CLOSE);
        List<LocalTime> out = new ArrayList<>();
        for (LocalTime t : CHECKPOINT_TIMES) {
            if (!java.time.ZonedDateTime.of(session, t, calendar.zone()).toInstant().isAfter(last)) {
                out.add(t);
            }
        }
        return out;
    }

    /** 확인 시각 'HH:mm'(스키마 {@code checkpoint.atEt}의 글자). */
    static String clock(LocalTime t) {
        return CLOCK.format(t);
    }

    /** 출처 사실(§7-2의 1·2) — 문서·화면과 같은 뜻. */
    static final List<String> SOURCE_FACTS = List.of(
            "지연 자료로 더 좋은 체결가를 얻을 수는 없다 — 체결은 늘 주문 뒤 그 시각의 실제 가격(1분봉)이고, 자료가 늦으면 장부에 반영되는 시각만 늦다.",
            "이 결정에는 데이터 선택이 없다 — 장이 닫힌 뒤 결정하므로 입력은 계좌1과 같은 확정 종가 관측치다. 고르는 것은 체결 시점뿐이다.");

    /** 가격 사다리(§6-2·§10-4) — 칸 이름은 체결 기록의 fillRung과 같은 글자. */
    static final List<String> LADDER = List.of(
            "Y1M_AT — 기준 시각 T에 시작한 1분봉 시가(거래량 > 0)",
            "Y1M_NEXT — T 봉에 거래가 없으면 T+1~T+4분 첫 거래 봉 시가",
            "Y1M_LATE — 그 창에 거래가 없으면 그날 T 뒤 첫 거래 봉 시가(대체 체결)",
            "QUOTES_FALLBACK — 1분봉 자료 자체를 받지 못했을 때만 T + 20분 뒤 시간별 관측치 종가(대체 체결)",
            "QUOTES_CLOSE — 세션이 끝날 때까지 1분봉 자료가 없으면 그날 확정 종가(대체 체결)",
            "그날 T 뒤 거래가 없으면(거래 정지·무거래) 체결하지 않고 만료(NO_TRADE_AFTER_T)");

    /** 1분봉 출처(§7-3 — X2 전에는 첫 봉 시가가 공식 개장가와 같은지 모름). */
    static final String BARS_SOURCE = "Yahoo(yfinance) 1분봉 — 정규장·원시가, 봉 시각은 봉 시작. 첫 봉 시가가 공식 개장 경매가와 같은지는 "
            + "확인하지 못했다.";

    /**
     * 섹션 하나(클래스 설명).
     *
     * @param asOf       기준 거래일(뉴욕 세션 날짜)
     * @param timings    받는 체결 시점(계좌 프로필 — 이른 것부터)
     * @param calendar   미국 달력
     * @param slippageBp 그 결정이 읽은 설정의 슬리피지(bp)
     * @param record     체결 기록을 싣나(설정 {@code claude2.executionRecord})
     * @param store      체결 기록을 읽을 저장소
     * @param book       그 계좌 코드
     */
    static Map<String, Object> build(LocalDate asOf, List<String> timings, TradingCalendar calendar, double slippageBp,
                                     boolean record, PaperStore store, String book) {
        return build(asOf, timings, calendar, slippageBp, record, store, book, false);
    }

    /**
     * {@link #build(LocalDate, List, TradingCalendar, double, boolean, PaperStore, String)}에 장중 확인 판을 더한 것(클래스 설명) — {@code checkpoints}가
     * 거짓이면 단계 1 섹션 그대로.
     *
     * @param checkpoints 장중 확인을 켠 결정인가({@link ClaudeBookProfile#checkpoints})
     */
    static Map<String, Object> build(LocalDate asOf, List<String> timings, TradingCalendar calendar, double slippageBp,
                                     boolean record, PaperStore store, String book, boolean checkpoints) {
        LocalDate session = calendar.nextTradingDay(asOf);
        Instant open = calendar.openInstant(session);
        Instant close = calendar.closeInstant(session);
        boolean earlyClose = calendar.isEarlyClose(session);
        Map<String, Object> sessionView = new LinkedHashMap<>();
        sessionView.put("date", session.toString());
        sessionView.put("openEt", et(open, calendar));
        sessionView.put("closeEt", et(close, calendar));
        sessionView.put("openKst", Kst.stamp(open));
        sessionView.put("closeKst", Kst.stamp(close));
        sessionView.put("earlyClose", earlyClose);
        sessionView.put("timeZone", calendar.zone().getId());

        List<List<Object>> menu = new ArrayList<>();
        List<String> closed = new ArrayList<>();
        for (String timing : timings) {
            Instant at = ExecutionAudit.targetAt(timing, session, calendar);
            boolean shut = at != null && UsTimedFills.timed(timing) && !at.isBefore(close);
            if (shut) {
                closed.add(timing);
            }
            List<Object> row = new ArrayList<>(MENU_COLUMNS.size());
            row.add(timing);
            row.add(at == null ? null : et(at, calendar));
            row.add(at == null ? null : Kst.stamp(at));
            row.add(meaning(timing, shut));
            menu.add(row);
        }
        Map<String, Object> menuView = new LinkedHashMap<>();
        menuView.put("columns", MENU_COLUMNS);
        menuView.put("rows", menu);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("executionMenuVersion", checkpoints ? PacketBuilder.EXECUTION_MENU_VERSION_C2
                : PacketBuilder.EXECUTION_MENU_VERSION);
        out.put("session", sessionView);
        out.put("menu", menuView);
        out.put("closedTimings", closed);
        out.put("ladder", LADDER);
        out.put("barsSource", BARS_SOURCE);
        if (checkpoints) {
            List<String> facts = new ArrayList<>(SOURCE_FACTS);
            facts.add(CHECKPOINT_SOURCE_FACT);
            out.put("sourceFacts", facts);
        } else {
            out.put("sourceFacts", SOURCE_FACTS);
        }
        out.put("slippageBp", PacketBuilder.decimal(slippageBp, 4));
        out.put("record", record ? record(store, book, calendar) : recordOff());
        if (checkpoints) {
            out.put("checkpointOptions", checkpointOptions(session, calendar));
        }
        return out;
    }

    /** 장중 확인 선택지(클래스 설명) — 그 세션의 확인 시각(ET·KST)·피드 뜻·감시 상한·최근 잰 지연 요약·규칙. */
    private static Map<String, Object> checkpointOptions(LocalDate session, TradingCalendar calendar) {
        List<Map<String, Object>> times = new ArrayList<>();
        for (LocalTime t : checkpointTimes(session, calendar)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("atEt", clock(t));
            row.put("atKst", Kst.stamp(java.time.ZonedDateTime.of(session, t, calendar.zone()).toInstant()));
            times.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("times", times);
        out.put("feeds", FEED_MEANINGS);
        out.put("watchMax", WATCH_MAX);
        // 최근 장중 확인(MINUTE)에서 잰 지연 요약 — 잰 값이 생기기 전(판 2 첫날)에는 null.
        out.put("recentLag", null);
        out.put("rules", CHECKPOINT_RULES);
        return out;
    }

    /** 메뉴 한 줄의 뜻. */
    private static String meaning(String timing, boolean closed) {
        if (closed) {
            return "조기 폐장일 마감 뒤라 받지 않음(MALFORMED)";
        }
        if (PaperBooks.NEXT_OPEN.equals(timing)) {
            return "개장 첫 1분봉 시가";
        }
        if (PaperBooks.NEXT_CLOSE.equals(timing)) {
            return "확정 종가(마감 + 15분 뒤 관측치)";
        }
        return "그 시각에 시작한 1분봉 시가";
    }

    private static Map<String, Object> recordOff() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", "꺼짐(설정 claude2.executionRecord) — 체결 기록을 싣지 않음");
        out.put("columns", RECORD_COLUMNS);
        out.put("rows", List.of());
        return out;
    }

    /** 체결 기록(클래스 설명) — 최근 체결 순. */
    private static Map<String, Object> record(PaperStore store, String book, TradingCalendar calendar) {
        Map<Long, Order> orders = new HashMap<>();
        for (Order order : store.executionOrders(book, null)) {
            if (PaperBooks.ORDER_FILLED.equals(order.status())) {
                orders.put(order.id(), order);
            }
        }
        List<ExecFill> fills = new ArrayList<>(store.fillsForOrders(new ArrayList<>(orders.keySet())));
        fills.sort(Comparator.comparing((ExecFill f) -> f.fill().observedAt(), Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(f -> f.fill().id(), Comparator.reverseOrder()));
        Map<Long, JsonNode> baselines = new HashMap<>();
        if (!fills.isEmpty()) {
            for (OrderExec exec : store.orderExecs(book)) {
                baselines.put(exec.orderId(), exec.cf().get(ExecutionAudit.NEXT_OBSERVATION));
            }
        }
        List<List<Object>> rows = new ArrayList<>();
        for (ExecFill f : fills.subList(0, Math.min(RECORD_ROWS, fills.size()))) {
            Order order = orders.get(f.fill().orderId());
            JsonNode stored = baselines.get(order.id());
            Double baseline = stored == null || stored.isNull() ? null : Json.asDouble(stored, "raw");
            int sign = PaperBooks.SELL.equals(order.side()) ? -1 : 1;
            List<Object> row = new ArrayList<>(RECORD_COLUMNS.size());
            row.add(text(order.asOfTradingDate()));
            row.add(text(f.fill().observationDate()));
            row.add(order.ticker());
            row.add(order.side());
            row.add(order.timing());
            row.add(PacketBuilder.decimal(f.fill().rawPrice(), 4));
            row.add(f.fillRung());
            row.add(f.fillRung() != null && UsTimedFills.FALLBACK_RUNGS.contains(f.fillRung()));
            row.add(f.barAt() == null ? null : Kst.stamp(f.barAt()));
            row.add(PacketBuilder.decimal(baseline, 4));
            row.add(PacketBuilder.decimal(ExecutionTiming.advantageBp(sign, baseline, f.fill().rawPrice()), 2));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", rows.isEmpty() ? "체결 없음" : "최근 체결 순 " + RECORD_ROWS + "건까지 — 사실만. rawPrice = 체결 원가격(슬리피지 전), "
                + "baselineRaw = 같은 주문을 계좌1식(다음 시간별 관측치)으로 체결했다면의 원가격(없거나 확인하지 못했으면 null), vsBaselineBp > 0이면 "
                + "그 체결이 계좌1식보다 유리, fallback = 대체 체결");
        out.put("columns", RECORD_COLUMNS);
        out.put("rows", rows);
        return out;
    }

    /** 뉴욕 시각 'HH:mm'. */
    private static String et(Instant at, TradingCalendar calendar) {
        LocalTime local = at.atZone(calendar.zone()).toLocalTime();
        return CLOCK.format(local);
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
