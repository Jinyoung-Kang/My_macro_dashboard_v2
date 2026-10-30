package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.PaperLedgerService.BookRun;
import com.macrodash.feature.paper.PaperLedgerService.Holding;
import com.macrodash.feature.paper.PaperLedgerService.Reference;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * 🧪 미국 시각 지정 체결 — 장부 처리 순서의 2b·3a·3b(미국 Claude 계좌2 실험 단계 1 — 명세
 * docs/specs/2026-10-30-claude-book2-timing-design.md §6-2·§8·§10-1~§10-4, ADR 0022 결정 3·12). 시각 지정 시점({@link #TIMINGS} — 목표 세션 E의
 * NEXT_OPEN 09:30 · AT_1000~AT_1500 매시, 뉴욕 시간)의 대기 주문을 1분봉 저장본(수집기 {@code paper_bars_us}, contract 1 —
 * {@code collector/app/tasks/paper_bars.py} 머리말)의 그 시각 봉으로 체결합니다. 처리를 일으키는 흐름은 여전히 시간별 관측치 W(paper.quotes)
 * 하나이고 — 장부가 W를 처리할 때 이 단계가 돕니다 — 1분봉 저장본은 조회표일 뿐입니다(두 번째 처리 흐름·멱등 키가 없음, §10-1).
 *
 * <p><b>2b</b>: 시각 지정 대기 주문 중 기준 시각 T &lt; W 수집 시각인 것을 T 순으로, 같은 T에서는 시장 시각 순(R2b로 늦게 푼 주문은 그 봉 시각·R3는
 * 그 관측치 W 수집 시각 — R1·R2의 T 창은 한 시각, 리뷰 F4) · 같은 시각에서는 매도 → 매수(현금성 마지막 — 장부의 시간별 매수와 같은 규칙). 판정(사다리)을
 * 먼저 모두 구한 뒤 그 순서로 적용합니다. 가격 사다리(원가격 × (1 ± 슬리피지)):
 * <ol>
 *   <li>R1 {@value #RUNG_AT}·R2 {@value #RUNG_NEXT} — T 봉 시가(거래량 &gt; 0), 아니면 T+1~T+4분 첫 거래 봉 시가. 실행 감사의 반사실과 같은 판정
 *       ({@link ExecutionAudit#fromBars} — ⑤ T &gt; 주문 생성 + 60초·봉 시작 ≥ T, ⑥ 봉의 세션 = E, ⑦ 완성된 봉, ⑧ 이어받은 종목 아님·거래량 &gt; 0·
 *       그 세션을 받은 시각 &gt; 주문 생성)이라 같은 주문의 체결과 반사실이 갈리지 않습니다.</li>
 *   <li>R2b {@value #RUNG_LATE}(대체) — 창 안 거래 봉이 없고 E 안에서 T 뒤 첫 거래 봉({@code firstTradeAfter[T]})이 있으면 그 봉 시가. W 뒤에 받은
 *       저장본·이어받은 값이 아닌 그 종목 항목만(§10-4) — E가 W에서 끝났으면(3a 조건) W 전에 받은 저장본의 완성된 봉(⑤~⑧)도 씁니다(T 뒤 실제로
 *       거래된 가격, 1분봉 태스크가 마지막 회차들만 실패한 날 주문을 잃지 않게). R1·R2는 원래 W 전 저장본도 씁니다.</li>
 *   <li>R3 {@value #RUNG_FALLBACK}(대체) — <b>1분봉 자료 자체가 없을 때만</b>({@link Evidence#MISSING}) 장중 관측치 W의 관측 종가: W ≥ T + 20분,
 *       W의 그 종목 봉 날짜 = E, ①④(주문 뒤 수집·이어 쓴 봉 아님).</li>
 * </ol>
 * 1분봉이 'E 안 T 뒤 거래 없음'을 보이면(⑧b — 그 종목 세션의 첫 거래 봉이 없음, 또는 기준 종목은 같은 회차에 E 세션을 받았는데 그 종목만 없음) 대체 체결(R2b·
 * R3·{@value #RUNG_CLOSE})을 하지 않고 기다립니다 — 멈춘 가격으로 없는 체결을 만들지 않습니다(T18).
 *
 * <p><b>3a</b>: 2b 뒤에도 남은 주문 가운데 E가 끝난 것(W가 E 마감 + 15분 뒤 — E 확정 종가 관측치 W* 또는 그 뒤)은 대기로 남기지 않습니다 — 1분봉
 * 자료가 없고 W의 그 종목 봉이 E의 확정 종가(봉 날짜 = E)면 그 종가({@value #RUNG_CLOSE}, 대체), 아니면 만료와 사유(아래 {@link #NO_BARS}·
 * {@link #NO_TRADE_AFTER_T}·{@link #NO_SESSION_BARS}). 'T 뒤 거래 없음'(⑧b)은 그 1분봉 저장본이 E를 끝까지 봤을 때만(W 뒤에 받았거나 E 마감 +
 * 15분 뒤에 받음) {@link #NO_TRADE_AFTER_T}이고, 그 전에 받은 W 전 저장본이면 그 뒤 거래가 있었을 수 있어 {@link #NO_BARS}입니다(거래 없음을 보인
 * 저장본이라 종가로도 채우지 않음). E 가격 밖으로는 체결하지 않습니다 — E 장중에 서버가 꺼졌다 E+1에 켜져도 E 주문은 E의 1분봉·
 * E 종가로만 풀리고, 관측치의 3개월 이력(배당 조정)에서 E 값을 꺼내지 않습니다. 그래서 시각 지정 주문은 장부의 만료 단계(1)에서 만료하지 않고
 * 여기서 만료합니다({@code PaperStore#expireOrders(String, LocalDate, java.util.Collection)}).
 *
 * <p><b>3b</b>: 2b·3a로 생긴 보유의 평가 가격을 W의 그 종목 봉(새 값이고 봉 날짜 ≥ E)으로 다시 맞춥니다 — 그러지 않으면 평가·순자산이 T 가격으로
 * 남고 W의 스탑 판정에서 빠집니다. W에 그 값이 없으면 T 가격 그대로 '가격 없음'.
 *
 * <p><b>수량</b>(§10-3): 매수 목표 금액 = 목표 비중 × T 시각의 순자산(현금 — 같은 2b에서 앞선 체결 반영 — + 보유 × 그 종목의 같은 T 창 첫 거래 봉
 * 시가, 없으면 갱신 전 평가 가격 — W의 관측가로 T의 수량을 정하지 않음). 그 매수의 시장 시각(체결 봉 시작, R3·종가는 그 관측치 수집 시각)보다 뒤 시각에
 * 판 매도 — R2b 봉 시각·R3 관측치 수집 시각(앞 T 주문이라 먼저 적용된 것) — 는 아직 팔지 않은 것으로 봅니다: 그 대금은 현금에 넣지 않고 그 보유를 T 시각
 * 순자산에 그대로 셈(리뷰 F4 ⓐ·R3 — T 뒤 가격을 T 수량에 쓰지 않음). 현금이 모자라면 줄여 사고 주문 근거에 {@code cashLimited}·
 * {@code requestedQty}·{@code filledQty}, 1주도 못 사면 취소. 재진입 금지는 E로 판정. 보유 없는 매도는 취소. 분할을 확인하지 못한 보유(이번 W에 그
 * 종목 새 값이 없음)는 지금 규칙대로 기다리고, E가 끝나도 확인하지 못하면 만료합니다. 새 보유의 최고가는 체결가부터, 분할 기준은 W 저장본의 E
 * 직전 거래일 종가입니다.
 *
 * <p><b>스탑과의 순서</b>(§10-2): 시간별 스탑(장부 4단계)은 W 관측가로 돕니다. 2b 뒤에도 기준 시각 T가 지난 시각 지정 주문이 풀리지 않고 남은 종목
 * (W가 (T, T + 6분)에 수집돼 그 뒤 1분봉 저장본도 T 창을 다 보지 못함 — {@link Evidence#NOT_YET}, 거래 없음 기다림·재검사 오류 등)은 그 W의 스탑에서
 * 뺍니다({@code BookRun.timedUnresolved}) — 그러지 않으면 W 스탑이 앞 시각 T의 매도보다 먼저 팔고 재진입 금지를 걸어, 다음 W에서 그 매도는 '보유 없음',
 * 매수는 재진입 금지로 취소됩니다. 다음 W에서 그 주문을 먼저 푼 뒤 그 W의 관측가로 스탑을 다시 판정합니다 — 미룬 W의 트리거(관측가·봉 날짜)는 이어 가지
 * 않으므로 그 사이 스탑 위로 돌아오면 스탑이 없고, 아직 아래면 다음 W 가격에 팝니다(대가: 그 종목의 스탑 판정이 늦어지고 트리거가 사라질 수 있음 — 1분봉
 * 기다림은 W의 가격 표본을 그대로 쓰지만 이 미룸은 W의 표본을 버림, 미룬 때는 작업 기록 notes에 한 줄). E가 끝나면(3a) 모든 주문이 풀리므로 미룸은 그 세션
 * 안에서 끝납니다.
 *
 * <p><b>장부 재검사</b>(§8 끝): 고른 봉이 ⑤⑥을 어기면(수집기 저장본의 값이 틀림 — 창에 든 T 앞 봉·다른 날 봉 등) 체결하지 않고 운영 알림
 * ({@code Outcome.alerts})으로 남깁니다. 주문 자체가 ⑤를 어기면(T ≤ 생성 + 60초 — 검증기 {@code LATE_FOR_TIMING}이 막는 것)·E 마감 뒤 시각(조기
 * 폐장)이면 체결할 수 없어 취소하고 알림을 남깁니다. 장부 오류(예외)가 아니므로 그 책의 다른 처리는 그대로 됩니다.
 *
 * <p><b>늦게 풂</b>({@code paper_order_exec.late_resolved}, M4)은 여기서 쓰지 않습니다 — 실행 감사 작업이 체결 행(사다리 칸 {@code fill_rung}·장부 반영
 * 시각 {@code observed_at})으로 셉니다({@link ExecutionAudit#lateResolved}).
 *
 * <p>다른 계좌에는 시각 지정 주문이 없어 이 단계가 아무 일도 하지 않습니다(장부 고정본 {@code ledger-us-week.txt} 바이트 그대로). 미국 장부만 부릅니다.
 */
final class UsTimedFills {

    /**
     * 시각 지정 시점 — 실행 감사의 메뉴({@link ExecutionAudit#MENU} — V17 timing CHECK·수집기 MENU와 같은 글자)와 장중 확인 응답의 장중 시장가
     * {@value PaperBooks#MARKET}(단계 2 — V18, 기준 시각은 그 주문의 생성 + 60초 뒤 첫 분 {@link ExecutionAudit#marketTarget}). 이 목록이 시간별 체결에서
     * 빼는 시점({@code UsPaperMarket.fillable})·장부 만료 단계가 남기는 시점·2b가 푸는 시점을 함께 정합니다.
     */
    static final Set<String> TIMINGS = timings();

    /** MARKET은 E 마감 이만큼 전(보통 날 15:55·조기 폐장일 12:55 ET) 이후의 기준 시각이면 받지 않습니다(검증기 MALFORMED — 계좌2 명세 §6-2). */
    static final Duration MARKET_BEFORE_CLOSE = Duration.ofMinutes(5);

    /**
     * 1분봉 저장본의 봉 시각 {@code t}가 무엇인가 — 늘 봉 <b>시작</b>입니다(수집기 계약 {@code paper_bars.BAR_LABEL}과 같은 글자, 시험이 대조). Yahoo
     * 라벨이 끝으로 판명되면(X1) 수집기가 그 상수만 바꿔 1분을 빼 저장하므로, 장부의 ⑤⑦은 '봉 시작' 기준 그대로입니다(§6-2).
     */
    static final String BAR_LABEL = "START";

    /** 사다리 칸 — V17 {@code paper_fills.fill_rung} CHECK와 같은 글자. */
    static final String RUNG_AT = ExecutionAudit.RUNG_AT;
    static final String RUNG_NEXT = ExecutionAudit.RUNG_NEXT;
    static final String RUNG_LATE = "Y1M_LATE";
    static final String RUNG_FALLBACK = "QUOTES_FALLBACK";
    static final String RUNG_CLOSE = ExecutionAudit.RUNG_CLOSE;
    /** 대체 체결 칸({@code fallback: true} — M1에서 따로 셈). */
    static final Set<String> FALLBACK_RUNGS = Set.of(RUNG_LATE, RUNG_FALLBACK, RUNG_CLOSE);

    /**
     * 1분봉 기다림 상한의 기본값(§10-2) — 관측치 W 수집 뒤 이만큼 지나면 W 뒤의 1분봉 저장본 없이 처리합니다. 장부는 그 실행 설정의
     * {@code claude2.barsWaitMinutes}(0~30 — {@link Claude2Settings#barsWait})를 쓰고, 이 값은 그 키가 없거나 틀릴 때의 값입니다.
     */
    static final Duration BARS_WAIT = Duration.ofMinutes(15);
    /** R3: W 수집이 T + 이만큼 뒤일 때부터(§10-4). */
    static final Duration FALLBACK_AFTER = Duration.ofMinutes(20);
    /** (나): 1분봉 저장본(또는 그 종목 세션)을 T + 이만큼 전에 받았으면 그 저장본은 T 창을 다 보지 못함. */
    static final Duration WINDOW_SEEN = Duration.ofMinutes(6);
    /** (나): W 수집이 T + 이만큼 뒤면 1분봉 태스크가 한 회차 넘게 실패한 것으로 봄 — slow 한 회차(60분) + 앞 태스크 여유 5분. */
    static final Duration ONE_ROUND = Duration.ofMinutes(65);
    /**
     * 늦게 풂(M4 — {@link ExecutionAudit#lateResolved})의 문턱: 장부 반영(관측치 W 수집)이 T + 이만큼 뒤일 때만 늦음 — {@link #WINDOW_SEEN}(1분봉 저장본이
     * T 창을 다 봄) + {@link #ONE_ROUND} = 71분. T 뒤 첫 관측치 W1이 T + 6분 전에 오면 그 뒤 1분봉 저장본도 T 창을 다 보지 못해(NOT_YET) 다음 관측치
     * W2(≈ W1 + 60분 — T + 60~66분)에서 풀리는데, 이 W2까지는 정상 경로라 늦음이 아닙니다. 문턱을 T + 65분으로 두면 같은 원인이 W1이 T + 5분 앞이냐
     * 뒤냐로 갈렸습니다(리뷰 F5 ⓐ). 알려진 한계: W1이 T + 6~11분인데 그 회차 1분봉이 실패해 W2에서 푼 것도 늦음이 아님 — 갈리는 곳이 T + 11/12분으로
     * 옮겨 갈 뿐입니다({@link ExecutionAudit#lateResolved}).
     */
    static final Duration LATE_AFTER = WINDOW_SEEN.plus(ONE_ROUND);

    /** 만료 사유 코드({@code paper_orders.reject_reason}의 앞머리 — 뒤에 한 줄 설명). E 1분봉 없음(서버 꺼짐·수집 실패)·풀지 못함. */
    static final String NO_BARS = "NO_BARS";
    /** 만료 사유 코드 — 1분봉이 E 안 T 뒤 거래를 보이지 않음(거래 정지·무거래 가능, T18). */
    static final String NO_TRADE_AFTER_T = "NO_TRADE_AFTER_T";
    /** 만료 사유 코드 — 관측치(paper.quotes)에도 그 종목의 E 봉이 없음(임시 휴장 포함). */
    static final String NO_SESSION_BARS = "NO_SESSION_BARS";
    /** 만료 사유 코드 — 분할 여부를 확인하지 못한 보유(관측치에 그 종목 새 값 없음)라 E가 끝날 때까지 풀지 못함. */
    static final String HOLDING_UNVERIFIED = "HOLDING_UNVERIFIED";
    /** 만료 사유 코드 — 장부 재검사(⑤⑥)가 1분봉 저장본의 봉을 거절한 채 E가 끝남. */
    static final String RECHECK_FAILED = "RECHECK_FAILED";

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    private final PaperStore store;
    private final ObjectMapper mapper;

    UsTimedFills(PaperStore store, ObjectMapper mapper) {
        this.store = store;
        this.mapper = mapper;
    }

    private static Set<String> timings() {
        Set<String> out = new java.util.LinkedHashSet<>(ExecutionAudit.MENU.keySet());
        out.add(PaperBooks.MARKET);
        return java.util.Collections.unmodifiableSet(out);
    }

    /** 시각 지정 시점인가. */
    static boolean timed(String timing) {
        return timing != null && TIMINGS.contains(timing);
    }

    /**
     * 그 결정에서 닫힌 시각 지정 시점(검증기 {@link OrderValidator.Market#closed} — 계좌2 명세 §6-2·§10-5): 목표 세션
     * E(기준 거래일 다음 거래일)의 마감 이후 시각(조기 폐장일 13:00 ET의 AT_1300~AT_1500)은 MALFORMED, 기준 시각 T가 지금 + 60초 이전이면
     * LATE_FOR_TIMING(주문은 검증 직후 같은 트랜잭션에서 만들어지므로 지금을 생성 시각으로 봄 — 장부가 체결 때 실제 생성 시각으로 다시 봄, ⑤).
     * 시각 지정이 아닌 시점(NEXT_CLOSE)은 닫지 않습니다.
     *
     * @param timings 받는 체결 시점(계좌 프로필)
     */
    static Map<String, OrderValidator.Closed> closedTimings(List<String> timings, LocalDate asOf,
                                                                                    Instant now, TradingCalendar calendar) {
        LocalDate session = calendar.nextTradingDay(asOf);
        Instant close = calendar.closeInstant(session);
        Map<String, OrderValidator.Closed> out = new LinkedHashMap<>();
        for (String timing : timings) {
            if (PaperBooks.MARKET.equals(timing)) {
                // 장중 시장가(장중 확인 응답) — 기준 시각 T = 지금 + 60초 뒤 첫 분이 그 세션 정규장 안이고 마감 5분 전 앞이어야 함.
                Instant target = ExecutionAudit.marketTarget(now);
                Instant last = close.minus(MARKET_BEFORE_CLOSE);
                if (target.isBefore(calendar.openInstant(session))
                        || !target.atZone(calendar.zone()).toLocalDate().equals(session)) {
                    out.put(timing, new OrderValidator.Closed(OrderValidator.MALFORMED, "장중 시장가는 " + session
                            + " 정규장 안에서만 — 기준 시각 " + et(target, calendar) + "은 정규장 밖이라 받지 않음"));
                } else if (!target.isBefore(last)) {
                    out.put(timing, new OrderValidator.Closed(OrderValidator.MALFORMED, "마감 5분 전("
                            + CLOCK.format(last.atZone(calendar.zone())) + " ET) 뒤 시장가는 받지 않음 — 기준 시각 "
                            + et(target, calendar)));
                }
                continue;
            }
            Instant target = timed(timing) ? ExecutionAudit.targetAt(timing, session, calendar) : null;
            if (target == null) {
                continue;
            }
            if (!target.isBefore(close)) {
                out.put(timing, new OrderValidator.Closed(
                        OrderValidator.MALFORMED, "조기 폐장 " + CLOCK.format(close.atZone(calendar.zone()))
                        + " ET — " + session + " " + timing + "(" + CLOCK.format(target.atZone(calendar.zone()))
                        + " ET)은 마감 뒤라 받지 않음"));
            } else if (!target.isAfter(now.plus(ExecutionAudit.AFTER_CREATED))) {
                out.put(timing, new OrderValidator.Closed(
                        OrderValidator.LATE_FOR_TIMING, "기준 시각 " + et(target, calendar)
                        + "이 주문 생성(지금 " + Kst.stamp(now) + ") + 60초 이전이라 받지 않음(⑤)"));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 1분봉 저장본
    /**
     * 1분봉 저장본 한 벌 — 저장본 수집 시각(DB)과 본문(contract 1). 저장본이 없거나 수집 시각을 모르거나 모양 판이 다르면 {@link #NONE}(1분봉 자료
     * 없음 — 0이나 다른 값으로 채우지 않음).
     */
    record Bars(Instant collectedAt, JsonNode payload) {

        static final Bars NONE = new Bars(null, null);

        static Bars of(Optional<Snapshot> snapshot) {
            if (snapshot == null || snapshot.isEmpty()) {
                return NONE;
            }
            Snapshot found = snapshot.get();
            JsonNode payload = found.payload();
            if (found.collectedAt() == null || payload == null
                    || payload.path("contract").asInt(-1) != ExecutionAudit.BARS_CONTRACT) {
                return NONE;
            }
            return new Bars(found.collectedAt(), payload);
        }

        boolean present() {
            return collectedAt != null && payload != null;
        }

        /** 그 종목 항목(없으면 null). */
        JsonNode entry(String ticker) {
            return present() ? Json.child(Json.child(payload, "tickers"), ticker) : null;
        }

        /** 이번 회차에 받은 그 종목 항목인가(있고 이어받은 값이 아님). */
        boolean fresh(String ticker) {
            JsonNode entry = entry(ticker);
            return entry != null && !Json.asBoolean(entry, "isStale");
        }

        /** 이번 회차에 받은 그 종목 항목의 그 세션(뉴욕 날짜) — 없거나 이어받은 항목이면 null. */
        JsonNode session(String ticker, LocalDate day) {
            return fresh(ticker) ? Json.child(Json.child(entry(ticker), "sessions"), day.toString()) : null;
        }

        /** 지연·세션 대조의 기준 종목(저장본 {@code reference}, 없으면 SPY). */
        String reference() {
            String named = present() ? Json.asText(payload, "reference") : null;
            return named == null || named.isBlank() ? ExecutionAudit.REFERENCE : named;
        }
    }

    /**
     * 그 종목·E·T에 대해 1분봉 저장본이 무엇을 보이나(§10-4).
     *
     * <ul>
     *   <li>{@link #BARS} — 이번 회차에 받은 그 종목의 E 세션이 있고 그 세션을 T + 6분 뒤에 받음(창·T 뒤 첫 거래 봉으로 판정)</li>
     *   <li>{@link #NO_TRADE} — 이번 회차에 받은 그 종목 항목에 E 세션이 없는데 기준 종목(SPY)은 <b>같은 회차에</b> E 세션을 받음(그 세션의
     *       {@code fetchedAt} = 그 종목 항목의 {@code fetchedAt}) — E에 그 종목 거래가 (아직) 없음. 기준 종목도 이번에 받지 못했으면 구분할 수 없어
     *       이쪽(대체 체결을 하지 않는 쪽)</li>
     *   <li>{@link #MISSING} — 1분봉 자료 자체가 없음: (가) W 뒤에 받은 저장본인데 그 종목 항목이 이어받은 값·없음(종목만 받지 못함), (나) 저장본
     *       (또는 그 종목 세션)을 T + 6분 전에 받았고 W ≥ T + 65분(1분봉 태스크가 한 회차 넘게 실패 — 저장본이 아예 없을 때도), (다) 그 종목도 기준
     *       종목도 E 세션이 없는 새 저장본(서버가 꺼져 E를 받지 못함·임시 휴장 — 관측치가 가름), (라) W 뒤에 받은 저장본인데 그 종목 항목에 E 세션이
     *       없고 기준 종목의 E 세션은 앞 회차에 받아 합쳐 둔 것(이번 회차는 E를 받지 않음 — 그 종목에 E 세션이 없다는 것이 거래 없음의 증거가 아님)</li>
     *   <li>{@link #NOT_YET} — 아직 모름(W 전에 받은 저장본이고 (나)도 아님 — (가)·(라)의 W 전 저장본 포함, 다음 저장본을 기다림)</li>
     * </ul>
     */
    enum Evidence { BARS, NO_TRADE, MISSING, NOT_YET }

    static Evidence evidence(String ticker, LocalDate session, Instant target, Bars bars, Instant observedAt) {
        boolean longAfter = !observedAt.isBefore(target.plus(ONE_ROUND));
        if (!bars.present() || bars.collectedAt().isBefore(target.plus(WINDOW_SEEN))) {
            return longAfter ? Evidence.MISSING : Evidence.NOT_YET;                    // (나)
        }
        boolean afterObservation = !bars.collectedAt().isBefore(observedAt);
        if (!bars.fresh(ticker)) {
            return afterObservation ? Evidence.MISSING : Evidence.NOT_YET;             // (가)
        }
        JsonNode day = bars.session(ticker, session);
        if (day == null) {
            String reference = bars.reference();
            if (!bars.fresh(reference)) {
                return Evidence.NO_TRADE;                                              // ⑧b — 기준 종목도 받지 못해 구분할 수 없음
            }
            JsonNode referenceDay = bars.session(reference, session);
            if (referenceDay == null) {
                return Evidence.MISSING;                                               // (다)
            }
            if (!sameRound(referenceDay, bars.entry(ticker))) {
                return afterObservation ? Evidence.MISSING : Evidence.NOT_YET;         // (라)
            }
            return Evidence.NO_TRADE;                                                  // ⑧b
        }
        Instant fetched = instant(Json.asText(day, "fetchedAt"));
        if (fetched == null || fetched.isBefore(target.plus(WINDOW_SEEN))) {
            return longAfter ? Evidence.MISSING : Evidence.NOT_YET;                    // 합쳐 둔 옛 세션 — (나)와 같은 뜻
        }
        return Evidence.BARS;
    }

    /**
     * 기준 종목의 그 세션을 그 종목 항목과 같은 회차에 받았나 — 세션의 {@code fetchedAt} = 항목의 {@code fetchedAt}(수집기는 한 회차에 같은 시각을
     * 적고, 합쳐 둔 앞 회차 세션은 그때 시각 그대로). 어느 쪽이든 시각을 모르면 아님.
     */
    private static boolean sameRound(JsonNode referenceDay, JsonNode entry) {
        Instant reference = instant(Json.asText(referenceDay, "fetchedAt"));
        return reference != null && reference.equals(instant(Json.asText(entry, "fetchedAt")));
    }

    // ------------------------------------------------------------------ 기다림·대상
    /** 시각 지정 대기 주문 하나와 그 목표 세션 E·기준 시각 T(기준 거래일이 없으면 둘 다 null). */
    record Due(Order order, LocalDate session, Instant target) {
    }

    /**
     * 대기 주문 중 시각 지정 시점이고 T가 관측치 수집 시각보다 앞인 것 — 이 관측치에서 풀어야 하는 주문(만든 순 그대로). 기준 거래일이 없는 시각
     * 지정 주문도 넣습니다(풀 수 없어 취소).
     */
    static List<Due> due(List<Order> pending, Instant observedAt, TradingCalendar calendar) {
        List<Due> out = new ArrayList<>();
        for (Order order : pending) {
            if (!timed(order.timing()) || !PaperBooks.ORDER_PENDING.equals(order.status())) {
                continue;
            }
            LocalDate session = ExecutionAudit.targetSession(order, calendar);
            Instant target = session == null ? null : ExecutionAudit.targetAt(order, session, calendar);
            if (target == null || target.isBefore(observedAt)) {
                out.add(new Due(order, session, target));
            }
        }
        return out;
    }

    /**
     * 1분봉 기다림의 판정(§10-2) — 풀어야 할 주문이 있는 책에서만 묻습니다. W 뒤에 받은 1분봉 저장본이 있으면 바로, 없으면 W 수집 뒤
     * 상한({@link #BARS_WAIT} — 설정 {@code claude2.barsWaitMinutes})이 지날 때까지 기다림.
     *
     * @param text 기다리면 그 사유, 아니면 풀린 사유(작업 기록의 '풀림' 줄)
     */
    record BarsWait(boolean waiting, String text) {
    }

    /** {@link #barsWait(Bars, Instant, Instant, Duration)}를 기본 상한 {@link #BARS_WAIT}로. */
    static BarsWait barsWait(Bars bars, Instant observedAt, Instant now) {
        return barsWait(bars, observedAt, now, BARS_WAIT);
    }

    /**
     * @param limit 기다림 상한(그 실행 설정의 {@code claude2.barsWaitMinutes} — 0이면 기다리지 않음)
     */
    static BarsWait barsWait(Bars bars, Instant observedAt, Instant now, Duration limit) {
        if (bars.present() && !bars.collectedAt().isBefore(observedAt)) {
            return new BarsWait(false, "관측치 뒤의 1분봉 저장본(수집 " + Kst.stamp(bars.collectedAt()) + ")으로 처리");
        }
        Instant until = observedAt.plus(limit);
        if (!now.isBefore(until)) {
            return new BarsWait(false, "기다림 상한 " + limit.toMinutes() + "분이 지나 관측치 뒤의 1분봉 저장본 없이 처리");
        }
        return new BarsWait(true, "기준 시각이 지난 시각 지정 주문이 있어 관측치(수집 " + Kst.stamp(observedAt)
                + ") 뒤의 1분봉 저장본을 기다립니다(" + Kst.stamp(until) + "까지)");
    }

    // ------------------------------------------------------------------ 판정
    /** 주문 하나의 판정 결과. */
    enum Kind { FILL, WAIT, INVALID, ERROR, EXPIRE }

    /**
     * @param raw   체결 원가격(FILL — 슬리피지 전)
     * @param barAt 체결 봉 시작(1분봉으로 푼 칸만, 관측치 칸은 null)
     * @param rung  사다리 칸(FILL)
     * @param text  기다림·취소·오류·만료 사유
     */
    record Look(Kind kind, double raw, Instant barAt, String rung, String text) {

        static Look fill(double raw, Instant barAt, String rung) {
            return new Look(Kind.FILL, raw, barAt, rung, null);
        }

        static Look waiting(String text) {
            return new Look(Kind.WAIT, Double.NaN, null, null, text);
        }

        static Look invalid(String text) {
            return new Look(Kind.INVALID, Double.NaN, null, null, text);
        }

        static Look error(String text) {
            return new Look(Kind.ERROR, Double.NaN, null, null, text);
        }

        static Look expire(String code, String text) {
            return new Look(Kind.EXPIRE, Double.NaN, null, null, code + " — " + text);
        }

        boolean fallback() {
            return rung != null && FALLBACK_RUNGS.contains(rung);
        }
    }

    /** 2b — 관측치 W에서 이 주문을 풀 수 있나(사다리 R1·R2·R2b·R3, 클래스 설명). 순수 계산(DB 없음). */
    static Look look(Due due, Bars bars, Quotes observed, TradingCalendar calendar) {
        Order order = due.order();
        LocalDate session = due.session();
        Instant target = due.target();
        if (session == null || target == null) {
            return Look.invalid("기준 거래일이 없어 목표 세션을 정할 수 없습니다");
        }
        if (order.createdAt() == null || !target.isAfter(order.createdAt().plus(ExecutionAudit.AFTER_CREATED))) {
            return Look.invalid("LATE_FOR_TIMING — 기준 시각 " + et(target, calendar) + "이 주문 생성 + 60초 이전입니다(⑤)");
        }
        Instant close = calendar.closeInstant(session);
        if (!target.isBefore(close)) {
            return Look.invalid("기준 시각 " + et(target, calendar) + "이 " + session + " 마감(" + et(close, calendar)
                    + ") 뒤입니다(조기 폐장)");
        }
        Instant observedAt = observed.collectedAt();
        return switch (evidence(order.ticker(), session, target, bars, observedAt)) {
            case BARS -> fromBars(due, bars, observedAt, calendar);
            case MISSING -> quotesFallback(due, observed, calendar);
            case NO_TRADE -> Look.waiting("1분봉에 그 종목의 " + session + " 세션이 아직 없습니다(거래 정지·무거래 가능)");
            case NOT_YET -> Look.waiting("기준 시각 창을 본 1분봉 저장본이 아직 없습니다");
        };
    }

    /** R1·R2(실행 감사와 같은 판정) → R2b. 창·첫 거래 봉이 아직 완성되지 않았으면 기다림. */
    private static Look fromBars(Due due, Bars bars, Instant observedAt, TradingCalendar calendar) {
        Order order = due.order();
        LocalDate session = due.session();
        Instant target = due.target();
        Price price = ExecutionAudit.fromBars(order, order.timing(), session, bars.payload(), calendar);
        if (price != null) {
            String broken = recheck(due, price.at(), price.raw(), target.plus(ExecutionAudit.WINDOW), calendar);
            return broken != null ? Look.error(broken) : Look.fill(price.raw(), price.at(), price.rung());
        }
        JsonNode day = bars.session(order.ticker(), session);
        String label = ExecutionAudit.label(target, calendar);
        if (tradedInWindow(day, label, target, session, calendar)) {
            return Look.waiting("기준 시각 창의 봉이 아직 완성되지 않았습니다(⑦)");
        }
        JsonNode first = Json.child(Json.child(day, "firstTradeAfter"), label);
        if (first == null) {
            return Look.waiting("1분봉이 " + session + " " + label + " ET 뒤 거래를 아직 보이지 않습니다(⑧b — 거래 정지·무거래 가능)");
        }
        // E가 이 관측치에서 끝났으면(3a 조건) W 전에 받은 저장본의 완성된 봉도 씁니다 — T 뒤 실제로 거래된 가격이라 룩어헤드가 아니고, 3a가 이
        // 관측치에서 주문을 풀어야 해 더 기다릴 저장본이 없습니다(1분봉 태스크가 마지막 회차들만 실패한 날). 여기서 풀어 T 순 그대로입니다.
        if (bars.collectedAt().isBefore(observedAt) && !sessionOver(session, observedAt, calendar)) {
            return Look.waiting("관측치 뒤에 받은 1분봉 저장본이 아니라 대체 체결(R2b)을 미룹니다");
        }
        Instant start = instant(Json.asText(first, "t"));
        Double open = Json.asDouble(first, "o");
        Double volume = Json.asDouble(first, "v");
        if (start == null || open == null || volume == null || !(volume > 0)) {
            return Look.error("1분봉 저장본의 T 뒤 첫 거래 봉(" + label + ")을 읽을 수 없습니다");
        }
        String broken = recheck(due, start, open, null, calendar);
        if (broken != null) {
            return Look.error(broken);
        }
        Instant fetched = instant(Json.asText(day, "fetchedAt"));
        Instant last = instant(Json.asText(Json.child(day, "lastBar"), "t"));
        boolean complete = (last != null && last.isAfter(start))
                || (fetched != null && !fetched.isBefore(calendar.closeInstant(session).plus(PaperMarketData.FINAL_DELAY)));
        if (!complete) {
            return Look.waiting("T 뒤 첫 거래 봉이 아직 완성되지 않았습니다(⑦)");
        }
        if (fetched == null || !fetched.isAfter(order.createdAt())) {
            return Look.waiting("그 세션을 주문 전에 받았습니다(⑧)");
        }
        return Look.fill(open, start, RUNG_LATE);
    }

    /** R3 — 1분봉 자료 자체가 없을 때 장중 관측치 W의 관측 종가(§10-4). E가 끝났으면 3a(E 종가)에 맡깁니다. */
    private static Look quotesFallback(Due due, Quotes observed, TradingCalendar calendar) {
        Order order = due.order();
        LocalDate session = due.session();
        Instant observedAt = observed.collectedAt();
        if (sessionOver(session, observedAt, calendar)) {
            return Look.waiting("1분봉 자료가 없습니다 — 세션이 끝나 종가로 정리합니다");
        }
        if (observedAt.isBefore(due.target().plus(FALLBACK_AFTER))) {
            return Look.waiting("1분봉 자료가 없습니다 — 대체 체결은 기준 시각 + " + FALLBACK_AFTER.toMinutes() + "분 뒤 관측치부터");
        }
        Bar bar = observed.bars().get(order.ticker());
        if (bar == null || bar.stale() || !session.equals(bar.date()) || !observedAt.isAfter(order.createdAt())) {
            return Look.waiting("1분봉 자료가 없고 관측치에도 그 종목의 " + session + " 새 값이 없습니다");
        }
        return Look.fill(bar.close(), null, RUNG_FALLBACK);
    }

    /**
     * 3a — E가 끝났는데(W가 E 마감 + 15분 뒤) 2b로 풀리지 않은 주문의 마무리: E 종가 체결 또는 만료와 사유. 순수 계산(DB 없음).
     *
     * @param carried 2b의 판정(오류였으면 그 사유로 만료)
     */
    static Look settle(Due due, Bars bars, Quotes observed, TradingCalendar calendar, Look carried) {
        if (carried != null && carried.kind() == Kind.ERROR) {
            return Look.expire(RECHECK_FAILED, "장부 재검사 오류로 풀지 못했습니다(" + carried.text() + ")");
        }
        Order order = due.order();
        LocalDate session = due.session();
        Instant target = due.target();
        Instant observedAt = observed.collectedAt();
        return switch (evidence(order.ticker(), session, target, bars, observedAt)) {
            case BARS -> {
                JsonNode day = bars.session(order.ticker(), session);
                JsonNode first = Json.child(Json.child(day, "firstTradeAfter"), ExecutionAudit.label(target, calendar));
                Instant fetched = instant(Json.asText(day, "fetchedAt"));
                if (first != null) {
                    yield Look.expire(NO_BARS, session + " 1분봉에 " + et(target, calendar)
                            + " 뒤 거래 봉이 있으나 완성된 봉(⑦⑧)으로 풀지 못했습니다");
                }
                if (!sawTheSessionEnd(bars, fetched, session, observedAt, calendar)) {
                    yield unproven(session + " 1분봉의 " + et(target, calendar) + " 뒤 거래 없음", fetched, calendar);
                }
                yield Look.expire(NO_TRADE_AFTER_T, session + " 1분봉(받은 시각 " + et(fetched, calendar) + ")에 "
                        + et(target, calendar) + " 뒤 거래 봉이 없습니다(거래 정지·무거래 가능)");
            }
            case NO_TRADE -> sawTheSessionEnd(bars, bars.collectedAt(), session, observedAt, calendar)
                    ? Look.expire(NO_TRADE_AFTER_T, "1분봉에 그 종목의 " + session + " 세션이 없습니다(거래 정지·무거래 가능)")
                    : unproven("1분봉에 그 종목의 " + session + " 세션 없음", bars.collectedAt(), calendar);
            case MISSING, NOT_YET -> quotesClose(due, observed, calendar);
        };
    }

    /**
     * 1분봉 저장본의 '거래 없음'이 E를 끝까지 본 것인가 — 관측치 W 뒤에 받은 저장본이거나(W는 E 마감 + 15분 뒤), W 전 저장본이라도 그 세션(E 세션이
     * 없으면 그 저장본)을 E 마감 + 15분 뒤에 받았을 때. 아니면 그 저장본을 받은 뒤 거래가 있었을 수 있습니다.
     *
     * @param seen 그 '거래 없음'을 받은 시각(세션의 fetchedAt, E 세션이 없으면 저장본 수집 시각)
     */
    private static boolean sawTheSessionEnd(Bars bars, Instant seen, LocalDate session, Instant observedAt,
                                            TradingCalendar calendar) {
        return !bars.collectedAt().isBefore(observedAt) || (seen != null && sessionOver(session, seen, calendar));
    }

    /**
     * E 마감 + 15분 전에 받은 W 전 저장본의 '거래 없음' — 그 뒤 거래가 있었을 수 있어 NO_TRADE_AFTER_T가 아니고, 거래가 없었을 수도 있어 관측치의 E
     * 종가로도 채우지 않습니다(⑧b — 1분봉 자료 자체가 없을 때만 종가). 풀지 못한 만료 {@link #NO_BARS}.
     */
    private static Look unproven(String what, Instant seen, TradingCalendar calendar) {
        return Look.expire(NO_BARS, what + "(받은 시각 " + et(seen, calendar) + ")은 마감 + 15분 전에 받은 관측치 전 저장본이라 "
                + "그 뒤 거래가 있었는지 모릅니다 — 거래 없음을 보여 종가로도 채우지 않습니다(⑧b)");
    }

    /** 1분봉 자료가 없을 때의 E 종가({@value #RUNG_CLOSE}) — W의 그 종목 봉이 E의 확정 종가일 때만, 아니면 만료(§10-4·§12-4 'E 봉일 때만'). */
    private static Look quotesClose(Due due, Quotes observed, TradingCalendar calendar) {
        Order order = due.order();
        LocalDate session = due.session();
        Instant observedAt = observed.collectedAt();
        Bar bar = observed.bars().get(order.ticker());
        boolean fresh = bar != null && !bar.stale();
        if (fresh && session.equals(bar.date()) && UsPaperMarket.INSTANCE.closeAvailable(session, observedAt, calendar)
                && observedAt.isAfter(order.createdAt())) {
            return Look.fill(bar.close(), null, RUNG_CLOSE);
        }
        if (fresh && (bar.date().isBefore(session) || bar.recent().valueOn(session) == null)) {
            return Look.expire(NO_SESSION_BARS, "관측치(paper.quotes)에도 그 종목의 " + session + " 봉이 없습니다(임시 휴장·거래 정지 포함)");
        }
        return Look.expire(NO_BARS, session + " 1분봉이 없습니다(서버 꺼짐·수집 실패) — 이 관측치가 그 세션의 확정 종가가 아니라 "
                + "체결하지 않습니다");
    }

    /** 장부 재검사(§8 끝) — 고른 봉이 ⑤⑥을 지키나. 어긋나면 그 사유(체결하지 않고 오류로 남김), 지키면 null. */
    static String recheck(Due due, Instant start, double raw, Instant windowEnd, TradingCalendar calendar) {
        Order order = due.order();
        Instant created = order.createdAt().plus(ExecutionAudit.AFTER_CREATED);
        Instant floor = due.target().isAfter(created) ? due.target() : created;
        String where = "주문 " + order.id() + " " + order.ticker() + " " + order.timing() + "의 봉 " + start;
        if (start.isBefore(floor)) {
            return where + "이 기준 시각·주문 생성 + 60초 앞에 시작합니다(⑤)";
        }
        if (windowEnd != null && !start.isBefore(windowEnd)) {
            return where + "이 기준 시각 창(T ~ T+4분) 밖입니다";
        }
        if (!start.atZone(calendar.zone()).toLocalDate().equals(due.session())
                || !start.isBefore(calendar.closeInstant(due.session()))) {
            return where + "이 목표 세션 " + due.session() + " 밖입니다(⑥)";
        }
        if (!Double.isFinite(raw) || !(raw > 0)) {
            return where + "의 시가를 쓸 수 없습니다";
        }
        return null;
    }

    /** E가 끝났나 — W가 E 마감 + 15분 뒤(E 확정 종가 관측치 W* 또는 그 뒤 — 장부의 확정 판정과 같은 식). */
    static boolean sessionOver(LocalDate session, Instant observedAt, TradingCalendar calendar) {
        return UsPaperMarket.INSTANCE.closeAvailable(session, observedAt, calendar);
    }

    /** 그 세션 창에 거래 봉(창 안·E 날짜·거래량 &gt; 0)이 있나. */
    private static boolean tradedInWindow(JsonNode day, String label, Instant target, LocalDate session,
                                          TradingCalendar calendar) {
        return windowOpen(day, label, target, session, calendar) != null;
    }

    /** 그 세션 창의 첫 거래 봉 시가(창 안 — T ~ T+4분에 시작, 봉 날짜 = E, 거래량 &gt; 0), 없으면 null. */
    private static Double windowOpen(JsonNode day, String label, Instant target, LocalDate session,
                                     TradingCalendar calendar) {
        JsonNode window = Json.child(Json.child(day, "windows"), label);
        if (window == null || !window.isArray()) {
            return null;
        }
        Instant end = target.plus(ExecutionAudit.WINDOW);
        Instant best = null;
        Double open = null;
        for (JsonNode row : window) {
            Instant start = instant(Json.asText(row, "t"));
            Double o = Json.asDouble(row, "o");
            Double v = Json.asDouble(row, "v");
            if (start == null || o == null || v == null || !(v > 0) || !Double.isFinite(o) || !(o > 0)
                    || start.isBefore(target) || !start.isBefore(end)
                    || !start.atZone(calendar.zone()).toLocalDate().equals(session)) {
                continue;
            }
            if (best == null || start.isBefore(best)) {
                best = start;
                open = o;
            }
        }
        return open;
    }

    // ------------------------------------------------------------------ 장부(책 하나의 트랜잭션 안)
    /** 주문 하나를 다룬 결과 — 끝남(체결·취소·만료), 대기 그대로, 분할 확인 전이라 보류. */
    private enum Status { DONE, PENDING, HELD }

    /**
     * 2b·3a·3b(클래스 설명) — 장부가 분할·가격 갱신(2) 뒤, 시간별 매도(3) 앞에서 부릅니다. 풀어야 할 주문이 없으면 아무것도 하지 않습니다.
     *
     * @param pending 그 책의 대기 주문(만료 단계 뒤에 읽은 목록 — 시각 지정 주문만 봄)
     * @param bars    이 처리가 읽은 1분봉 저장본(없으면 {@link Bars#NONE})
     */
    void process(BookRun run, List<Order> pending, Bars bars) {
        TradingCalendar calendar = run.market.calendar();
        List<Due> due = new ArrayList<>(due(pending, run.at, calendar));
        if (due.isEmpty()) {
            return;
        }
        // 2b의 판정(사다리 R1·R2·R2b·R3)을 먼저 구합니다 — 장부 상태를 보지 않는 순수 계산이라 순서와 상관없고, R2b로 늦게 푼 주문의 봉 시각·R3의
        // 관측치 수집 시각으로 같은 T 안의 적용 순서를 정합니다(클래스 설명 '수량').
        Map<Long, Look> carried = new HashMap<>();
        for (Due d : due) {
            carried.put(d.order().id(), look(d, bars, run.quotes, calendar));
        }
        due.sort(byMarketTime(run, carried));
        Pass pass = new Pass();
        Map<Long, Status> status = new HashMap<>();

        // 2b — (T, R2b면 그 봉 시각·R3면 그 관측치 수집 시각, 방향) 순으로 적용
        for (Due d : due) {
            status.put(d.order().id(), apply(run, d, carried.get(d.order().id()), bars, pass));
        }

        // 3a — E가 끝난 남은 주문: E 종가 또는 만료(대기로 남기지 않음)
        for (Due d : due) {
            long id = d.order().id();
            if (status.get(id) == Status.DONE || d.session() == null || !sessionOver(d.session(), run.at, calendar)) {
                continue;
            }
            Look look = status.get(id) == Status.HELD ? unverified(d)
                    : settle(d, bars, run.quotes, calendar, carried.get(id));
            Status settled = apply(run, d, look, bars, pass);
            if (settled == Status.HELD) {
                settled = apply(run, d, unverified(d), bars, pass);
            }
            status.put(id, settled);
        }

        // 3b — 2b·3a로 생긴 보유의 평가 가격을 W의 봉으로
        pass.touched.forEach((ticker, session) -> revalue(run, ticker, session));

        // 기준 시각이 지났는데 아직 풀리지 않은 주문의 종목 — 이 W의 시간별 스탑에서 뺍니다(장부 4단계, 클래스 설명 '스탑과의 순서').
        for (Due d : due) {
            if (status.get(d.order().id()) != Status.DONE && d.order().ticker() != null) {
                run.timedUnresolved.putIfAbsent(d.order().ticker(), "주문 " + d.order().id() + " " + d.order().side() + " "
                        + d.order().timing());
            }
        }
    }

    private static Look unverified(Due due) {
        return Look.expire(HOLDING_UNVERIFIED, "분할 여부를 확인하지 못한 보유라(관측치에 그 종목 새 값 없음) " + due.session()
                + " 안에 풀지 못했습니다");
    }

    /**
     * 적용 순서(리뷰 F4 ⓐ·R3) — T 순, 같은 T 안에서는 시장 시각({@link #marketTime} — R2b {@value #RUNG_LATE}는 그 봉 시각, R3 {@value #RUNG_FALLBACK}는
     * 그 관측치 수집 시각, 그 밖은 T — R1·R2의 T 창은 한 시각으로 봄) 순, 같은 시각에서는 매도 → 매수(현금성 마지막), 그다음 만든 순. 같은 T의 R2b 매도
     * (예: 10:40)·R3 매도(W 10:25)는 더 이른 봉(10:00 R1·10:37 R2b)의 매수 뒤에 적용되므로 그 대금이 그 매수의 현금·T 시각 순자산에 들어가지 않습니다.
     */
    private static Comparator<Due> byMarketTime(BookRun run, Map<Long, Look> looks) {
        return Comparator.comparing((Due d) -> d.target(), Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparing(d -> marketTime(run, d, looks.get(d.order().id())),
                        Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparingInt(d -> PaperBooks.SELL.equals(d.order().side()) ? 0
                        : run.settings.cashLike(d.order().ticker()) ? 2 : 1)
                .thenComparing(d -> d.order().createdAt(), Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparingLong(d -> d.order().id());
    }

    /**
     * 정렬의 시장 시각 — R2b로 푼 주문은 그 봉 시작, R3(관측치 W의 관측가)는 그 관측치 수집 시각, 그 밖은 기준 시각 T(모르면 null). 매수가 쓸 수 있는
     * 매도 대금도 같은 시각으로 가립니다({@link #sell}·{@link Pass#after}).
     */
    private static Instant marketTime(BookRun run, Due due, Look look) {
        if (look != null && RUNG_LATE.equals(look.rung()) && look.barAt() != null) {
            return look.barAt();
        }
        if (look != null && RUNG_FALLBACK.equals(look.rung())) {
            return run.at;
        }
        return due.target();
    }

    /**
     * 한 처리(2b·3a)의 공용 상태 — 3b가 다시 평가할 보유(종목 → 목표 세션)와, 이 처리에서 R2b·R3로 판 매도(그 시장 시각보다 이른 시각의 매수가 그 대금을
     * 쓰지 않게, 리뷰 F4 ⓐ·R3 — T 순 적용이라 앞 T의 늦은 매도가 뒤 T의 더 이른 봉 매수보다 먼저 적용될 수 있음).
     */
    private static final class Pass {
        final Map<String, LocalDate> touched = new LinkedHashMap<>();
        final List<LateSale> lateSales = new ArrayList<>();

        /** 시장 시각이 {@code at}보다 뒤인 R2b·R3 매도 — 시각 {@code at}의 매수가 아직 몰랐을 대금(같은 시각이면 앎 — 같은 W의 R3끼리). */
        List<LateSale> after(Instant at) {
            return lateSales.stream().filter(s -> s.at().isAfter(at)).toList();
        }
    }

    /**
     * R2b·R3로 판 매도 하나 — 종목·판 수량·그 보유의 갱신 전 평가 가격(그 매도 전의 T 시각 순자산에 그 보유를 셀 때)·현금 변화·시장 시각(R2b는 체결 봉
     * 시작, R3는 그 관측치 수집 시각 — {@link #marketTime}).
     */
    private record LateSale(String ticker, int qty, double priceBefore, double cashDelta, Instant at) {
    }

    private Status apply(BookRun run, Due due, Look look, Bars bars, Pass pass) {
        Order order = due.order();
        switch (look.kind()) {
            case FILL -> {
                return PaperBooks.SELL.equals(order.side()) ? sell(run, due, look, pass)
                        : buy(run, due, look, bars, pass);
            }
            case INVALID -> {
                cancel(run, order, "시각 지정 체결 불가 — " + look.text());
                run.alerts.add("장부 재검사 — 주문 " + order.id() + " " + order.ticker() + " " + order.timing()
                        + " 취소: " + look.text());
                return Status.DONE;
            }
            case ERROR -> {
                run.alerts.add("장부 재검사 오류 — 체결하지 않음: " + look.text());
                return Status.PENDING;
            }
            case EXPIRE -> {
                expire(run, order, look.text());
                return Status.DONE;
            }
            default -> {
                return Status.PENDING;   // WAIT — 다음 관측치(또는 3a)
            }
        }
    }

    private Status sell(BookRun run, Due due, Look look, Pass pass) {
        Order order = due.order();
        Holding holding = run.holdings.get(order.ticker());
        if (holding == null) {
            cancel(run, order, "체결 시점에 보유가 없습니다");
            return Status.DONE;
        }
        if (!holding.verified && !pass.touched.containsKey(order.ticker())) {
            return Status.HELD;   // 분할 여부를 확인하지 못한 보유 — 수량을 믿을 수 없음(시간별 매도와 같은 규칙)
        }
        int qty;
        if (order.qty() != null) {
            if (order.qty() <= 0) {
                cancel(run, order, "매도 수량이 0 이하입니다");
                return Status.DONE;
            }
            qty = Math.min(order.qty(), holding.qty);
        } else {
            Double fraction = order.sellFraction();
            if (fraction != null && (!(fraction > 0) || fraction.isInfinite())) {
                cancel(run, order, "매도 비율이 0 이하입니다");
                return Status.DONE;
            }
            qty = PaperLedger.sellQty(holding.qty, fraction);
        }
        FillTerms.SlippageInPrice terms = terms(run, order, look);
        FillTerms.Costs costs = terms.costs(qty);
        record(run, order, qty, terms, costs, due.session(), look);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        if ((RUNG_LATE.equals(look.rung()) && look.barAt() != null) || RUNG_FALLBACK.equals(look.rung())) {
            // T 창 밖 시각에 판 매도(R2b 봉·R3 관측치) — 그보다 이른 시각의 매수가 이 대금을 쓰지 않게(리뷰 F4 ⓐ·R3).
            pass.lateSales.add(new LateSale(holding.ticker, qty, holding.priceBefore, costs.cashDelta(),
                    marketTime(run, due, look)));
        }
        holding.qty -= qty;
        if (holding.qty == 0) {
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
            pass.touched.remove(holding.ticker);
        }
        run.filled++;
        return Status.DONE;
    }

    private Status buy(BookRun run, Due due, Look look, Bars bars, Pass pass) {
        Order order = due.order();
        LocalDate session = due.session();
        Holding holding = run.holdings.get(order.ticker());
        if (holding != null && !holding.verified && !pass.touched.containsKey(order.ticker())) {
            return Status.HELD;   // 분할 여부를 확인하지 못한 보유에 더 사지 않음(평단이 섞임)
        }
        LocalDate until = run.timedLockouts.get(order.ticker());
        if (TrailingStop.lockedOut(until, session)) {
            cancel(run, order, "재진입 금지 중입니다(" + until + "까지, 트레일링 스탑)");
            return Status.DONE;
        }
        FillTerms.SlippageInPrice terms = terms(run, order, look);
        double price = terms.price();
        // 이 매수의 시장 시각(1분봉 체결이면 그 봉 시작, 관측치·종가 체결이면 이 관측치)보다 뒤 시각에 R2b(봉)·R3(관측치)로 판 매도는 아직 일어나지 않은
        // 매도입니다 — 그 대금을 현금에서 빼고 그 보유를 T 시각 순자산에 그대로 둡니다(리뷰 F4 ⓐ·R3 — T 뒤 가격을 T 수량에 쓰지 않음, 명세 §10-3).
        List<LateSale> later = pass.after(look.barAt() != null ? look.barAt() : run.at);
        double unsold = later.stream().mapToDouble(LateSale::cashDelta).sum();
        double cash = Math.max(0, run.cash - unsold);
        int wanted;
        if (order.qty() != null) {
            wanted = order.qty();
        } else if (order.targetWeightPct() != null && Double.isFinite(order.targetWeightPct())) {
            // 목표 금액 = 목표 비중 × T 시각의 순자산 — W의 관측가가 아니라 T 창의 가격으로 셈(§10-3).
            wanted = terms.affordableQty(order.targetWeightPct() / 100.0 * navAt(run, due, bars, later));
        } else {
            cancel(run, order, "매수 크기(수량·목표 비중)가 없습니다");
            return Status.DONE;
        }
        if (wanted <= 0) {
            cancel(run, order, "목표 금액으로 1주도 살 수 없습니다");
            return Status.DONE;
        }
        int qty = Math.min(wanted, terms.affordableQty(cash));
        if (qty <= 0) {
            cancel(run, order, "현금이 모자라 1주도 살 수 없습니다(현금 " + PaperLedgerService.money(cash) + laterNote(later)
                    + ")");
            return Status.DONE;
        }
        FillTerms.Costs costs = terms.costs(qty);
        record(run, order, qty, terms, costs, session, look);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        Instant priceAt = look.barAt() != null ? look.barAt() : run.at;
        if (holding == null) {
            Reference reference = reference(run, order.ticker(), session, look.raw());
            holding = new Holding(order.ticker(), qty, price, session, run.at, price, run.at, look.raw(), priceAt,
                    reference.date(), reference.close());
            run.holdings.put(holding.ticker, holding);
        } else {
            holding.avgCost = PaperLedger.averageCost(holding.qty, holding.avgCost, qty, price);
            holding.qty += qty;
            PaperLedgerService.raiseWatermark(holding, price, run.at);
        }
        pass.touched.putIfAbsent(order.ticker(), session);
        if (qty < wanted) {
            ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy()
                    : mapper.createObjectNode();
            reason.put("cashLimited", true);
            reason.put("requestedQty", wanted);
            reason.put("filledQty", qty);
            store.updateOrderReason(order.id(), reason);
            run.note("주문 " + order.id() + " " + order.ticker() + " 현금 부족으로 " + wanted + "주 중 " + qty
                    + "주만 매수(cashLimited" + laterNote(later) + ")");
        }
        run.filled++;
        return Status.DONE;
    }

    /** 현금 부족 문구에 붙이는 '아직 쓰지 않은 R2b·R3 매도 대금'(없으면 빈 글자). */
    private static String laterNote(List<LateSale> later) {
        if (later.isEmpty()) {
            return "";
        }
        return " — 이 매수 뒤 시각에 R2b·R3로 판 " + String.join("·", later.stream().map(LateSale::ticker).toList()) + " 대금 "
                + PaperLedgerService.money(later.stream().mapToDouble(LateSale::cashDelta).sum()) + "은 쓰지 않음";
    }

    /**
     * T 시각의 순자산(§10-3) — 현금(같은 2b에서 앞선 체결 반영) + 보유 × 그 종목의 같은 T 창 첫 거래 봉 시가(없으면 갱신 전 평가 가격, 이번 2b에서
     * 산 보유는 그 체결 원가격). 이 매수의 시장 시각보다 뒤 시각에 R2b·R3로 판 매도({@code later} — T 순 적용이라 먼저 적용됨)는 아직 팔지 않은 것으로
     * 셉니다: 그 대금을 현금에서 빼고 판 수량을 그 종목의 같은 규칙 가격(T 창 시가, 없으면 그 보유의 갱신 전 평가 가격)으로 더함(리뷰 F4 ⓐ·R3).
     */
    private static double navAt(BookRun run, Due due, Bars bars, List<LateSale> later) {
        TradingCalendar calendar = run.market.calendar();
        String label = ExecutionAudit.label(due.target(), calendar);
        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Holding holding : run.holdings.values()) {
            Double open = windowOpen(bars.session(holding.ticker, due.session()), label, due.target(), due.session(),
                    calendar);
            qty.put(holding.ticker, holding.qty);
            price.put(holding.ticker, open != null ? open : holding.priceBefore);
        }
        double cash = run.cash;
        for (LateSale sale : later) {
            cash -= sale.cashDelta();
            qty.merge(sale.ticker(), sale.qty(), Integer::sum);
            if (!price.containsKey(sale.ticker())) {
                Double open = windowOpen(bars.session(sale.ticker(), due.session()), label, due.target(), due.session(),
                        calendar);
                price.put(sale.ticker(), open != null ? open : sale.priceBefore());
            }
        }
        return PaperLedger.value(cash, qty, price).nav();
    }

    /** 새 보유의 분할 감지 기준 — W 저장본(그 종목)의 E 직전 거래일 종가, 없으면 그 체결 원가격(E). */
    private static Reference reference(BookRun run, String ticker, LocalDate session, double raw) {
        Bar bar = run.bar(ticker);
        if (bar != null) {
            LocalDate previous = bar.recent().floorDate(session.minusDays(1));
            if (previous != null) {
                return new Reference(previous, bar.recent().valueOn(previous));
            }
        }
        return new Reference(session, raw);
    }

    /** 3b — 2b·3a로 생기거나 늘어난 보유의 평가 가격을 W의 그 종목 봉(새 값, 봉 날짜 ≥ E)으로. 없으면 T 가격 그대로 '가격 없음'. */
    private static void revalue(BookRun run, String ticker, LocalDate session) {
        Holding holding = run.holdings.get(ticker);
        if (holding == null) {
            return;
        }
        Bar bar = run.bar(ticker);
        if (bar != null && !bar.stale() && !bar.date().isBefore(session)) {
            holding.lastPrice = bar.close();
            holding.lastPriceAt = run.at;
            holding.priceStale = false;
            holding.verified = true;   // 이번 관측치의 새 값 — 최고가·스탑(4단계)을 봄
        } else if (!holding.verified) {
            holding.priceStale = true;   // 새로 산 보유 — W에 그 종목 새 값이 없어 T 가격 그대로
        }
    }

    private static FillTerms.SlippageInPrice terms(BookRun run, Order order, Look look) {
        String source = look.barAt() != null ? Datasets.SNAP_PAPER_BARS_US : PaperBooks.SOURCE_QUOTES;
        return FillTerms.SlippageInPrice.ofRaw(order.side(), look.raw(), run.settings.slippageBp(), source);
    }

    private void record(BookRun run, Order order, int qty, FillTerms terms, FillTerms.Costs costs, LocalDate session,
                        Look look) {
        store.insertTimedFill(new Fill(0, order.id(), run.book.code(), order.ticker(), order.side(), qty, terms.price(),
                terms.rawPrice(), terms.slippageBp(), costs.gross(), run.at, session, terms.priceSource(), false, null,
                costs.fee(), costs.tax(), costs.slippageCost()), look.barAt(), look.rung());
        store.markOrderFilled(order.id(), run.at);
        if (look.fallback()) {
            run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 대체 체결(" + look.rung() + ") — "
                    + session + (look.barAt() == null ? " 관측치 종가" : " " + et(look.barAt(), run.market.calendar()) + " 봉"));
        }
    }

    private void cancel(BookRun run, Order order, String reason) {
        store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, reason);
        run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 취소 — " + reason);
    }

    private void expire(BookRun run, Order order, String reason) {
        store.markOrderStatus(order.id(), PaperBooks.ORDER_EXPIRED, reason);
        run.expired++;
        run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 만료 — " + reason);
    }

    // ------------------------------------------------------------------ 표기
    /**
     * 메뉴 시점의 창 키 'HH:MM'(저장본 {@code windows}·{@code firstTradeAfter}의 키) — MARKET처럼 주문마다 기준 시각이 다른 시점은 null이라 장부는
     * 주문의 기준 시각으로 셉니다({@link ExecutionAudit#label(Instant, TradingCalendar)}).
     */
    static String label(String timing) {
        LocalTime at = ExecutionAudit.MENU.get(timing);
        return at == null ? null : ExecutionAudit.label(at);
    }

    /** 뉴욕 시각 표기 'yyyy-MM-dd HH:mm ET'. */
    private static String et(Instant at, TradingCalendar calendar) {
        var local = at.atZone(calendar.zone());
        return local.toLocalDate() + " " + CLOCK.format(local) + " ET";
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
}
