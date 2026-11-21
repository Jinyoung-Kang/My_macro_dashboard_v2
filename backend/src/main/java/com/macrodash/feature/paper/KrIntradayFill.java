package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.KrxCorporateActions;
import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Choice;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;

/**
 * 한국 장중 감시 STOP 체결의 장중 계산(ADR 0045) — 상태 없는 순수 함수 모음입니다. 감시 저장본({@code paper.stopwatch.kr}) 한 종목 항목으로 밤 장부와 같은
 * 사다리({@link KrTimedLadder#price} — 같은 함수)를 돌려 R1(라벨 T+1 봉 시가, {@value KrTimedLadder#SOURCE_AT})만 받고, 기록 전 관문(G1 대상·G3 시간 순서·
 * G4 기업행위·G5 실제 계좌 창 + 60초)을 판정하며, 밤 처리 뒤 대조 칸을 만듭니다. 장부를 쓰거나 저장본을 읽는 일은 {@code KrStopFillStep}이 합니다.
 *
 * <ul>
 *   <li><b>창 만들기</b>({@link #timed}): 수집기 {@code kr_paper_timed.summarize_windows}와 같은 규칙 — 창 키 T의 창 = 항목 봉 가운데 라벨이 T+1 ~ T+5인
 *       것 전부(거래량과 상관없이, 라벨 순), 창 뒤 첫 거래 봉 = 라벨 ≥ T+1이고 거래량 &gt; 0인 첫 봉, 마감 봉 없음. 라벨은 봉 끝(한국 — {@link KrTimedLadder#BAR_LABEL})이라
 *       창 키 T의 첫 라벨이 T+1이고 라벨 T 봉(생성을 품은 분)은 고르지 않습니다(미리 보기 금지).</li>
 *   <li><b>안정 조건</b>({@link #r1}): 항목이 그 세션 것이고 이어받지 않았으며({@link StopWatch#usable}), 그 종목 항목을 받은 시각이 라벨 T+1 봉 끝(T + 1분)
 *       + {@link #SETTLE} 이후이고, 사다리 결과가 R1일 때만 — R2·R2b·기다림·체결 불가는 장중에 판단하지 않고 밤에 맡깁니다(저장본은 '아직 없음'과 '없음'을
 *       가리지 못함). 감시 항목은 종가가 비거나 0인 봉을 버리므로(수집기 {@code paper_stopwatch.kr_entry}) 밤이 R1으로 고르는 봉을 장중이 못 고를 수 있는데,
 *       그 쪽은 밤에 맡기는 쪽이라 안전합니다(두 길 대조 표 {@code paper/kr-intraday-fill/cases.json}).</li>
 * </ul>
 */
final class KrIntradayFill {

    private KrIntradayFill() {
    }

    /** 주문 근거의 칸 이름 — {@code reason.intradayFill}. */
    static final String FIELD = "intradayFill";
    /** 근거 칸 — 그 단계의 스위치 값(SHADOW·ON). */
    static final String MODE = "mode";
    static final String EVALUATED_AT = "evaluatedAt";
    /** 판정 — {@value #RECORD}(관문을 모두 지남)·{@value #DEFER}(밤에 맡김 — {@link #REASONS}). */
    static final String OUTCOME = "outcome";
    static final String REASONS = "reasons";
    static final String SNAPSHOT_FETCHED_AT = "snapshotFetchedAt";
    static final String TARGET_AT = "targetAt";
    static final String BAR_LABEL = "barLabel";
    static final String RAW_PRICE = "rawPrice";
    static final String VOLUME = "volume";
    static final String PRICE_SOURCE = "priceSource";
    static final String QTY = "qty";
    static final String CASH_DELTA = "cashDelta";
    static final String FEE = "fee";
    static final String TAX = "tax";
    static final String SLIPPAGE_COST = "slippageCost";
    static final String SETTINGS_VERSION = "settingsVersion";
    static final String GATE_AT = "gateAt";
    /** ON 기록 칸 — 장부에 적은 시각, 적기 직전 보유 사본, 그 트랜잭션이 쓰기 직전·직후의 상태 현금(쓴 값 그대로 — 실제 계좌 창의 되감기). */
    static final String RECORDED_AT = "recordedAt";
    static final String BEFORE = "before";
    static final String CASH_BEFORE = "cashBefore";
    static final String CASH_AFTER = "cashAfter";
    /** ON 기록 칸 — 기록 직전 보유의 since 봉 거래량(보유 레코드 밖 — 사후 점검의 기업행위 판정이 since 봉을 밤과 같게 만듦). */
    static final String FILL_REF_VOLUME = "fillRefVolume";
    /** ON 사후 점검의 기업행위 판정 칸(밤 일괄이었다면 그 STOP을 보류했을 판정 — 운영 알림, 되돌리지 않음). */
    static final String POST_CHECK = "postCheck";
    /** 기록 뒤 그 세션 밤 처리 전에 책을 일시정지함(밤 일괄이면 그 STOP이 취소됐을 경우 — 실제 계좌 창은 보유·현금만 되감고 주문은 넣지 않음). */
    static final String PAUSED_AT = "pausedAt";
    /** 밤 처리 뒤 대조 칸. */
    static final String CHECK = "check";

    static final String RECORD = "RECORD";
    static final String DEFER = "DEFER";

    /** 미룬 사유 — 장부 밀림(G2). */
    static final String LEDGER_BEHIND = "LEDGER_BEHIND";
    /** 미룬 사유 — 같은 책에 시가 대기 주문(G3 (a)). */
    static final String OPEN_ORDER = "OPEN_ORDER";
    /** 미룬 사유 — 같은 책에 기준 시각이 같거나 이른 대기 주문(다른 종목 STOP 매도 제외 — G3 (b)). */
    static final String EARLIER_ORDER = "EARLIER_ORDER";
    /** 미룬 사유 — 같은 책 같은 종목의 다른 대기 주문(G3 (c)). */
    static final String SAME_TICKER = "SAME_TICKER";
    /** 미룬 사유 — 미처리 기업행위 표시(G4 ①). */
    static final String CORP_HOLD = "CORP_HOLD";
    /** 미룬 사유 — 보유의 since 봉이 전 거래일이 아님(G4 ②). */
    static final String CORP_SINCE = "CORP_SINCE";
    /** 미룬 사유 — 감시 갭 가드 통과 아님·전일 원시·수정 종가 없음·전일 종가 날짜가 전 거래일이 아님(G4 ③). */
    static final String CORP_GUARD = "CORP_GUARD";
    /** 미룬 사유 — 금융위 상장 상태 신호(G4 ④). */
    static final String CORP_LISTING = "CORP_LISTING";
    /** 미룬 사유 — R1 자료 없음(봉 없음·거래 없음·항목 없음·이어받음·덜 굳음 — 그날 마감 전까지 갖춰지지 않음). */
    static final String NO_R1 = "NO_R1";
    /** 미룬 사유 — 금융위 시장 구분 없음(ETF 목록 밖 — 밤이면 '종목 구분 모름' 보류). */
    static final String NO_FSC_MARKET = "NO_FSC_MARKET";
    /** 미룬 사유 — 체결 조건 보류(세율 시행일 전 등 — 밤도 보류). */
    static final String HOLD = "HOLD";
    /** 미룬 사유 — 보유가 없음(밤이면 '체결 시점에 보유가 없습니다' 취소). */
    static final String NO_POSITION = "NO_POSITION";

    /** 대조 사유 — 밤이 그 주문을 체결하지 않음(만료·취소·보류 — ADR 0045 동치의 전제). */
    static final String NIGHT_NOT_FILLED = "NIGHT_NOT_FILLED";
    /** 대조 사유 — 기록 때 설정 판과 밤 체결 때 설정 판이 다름(비용·재진입 금지 일수가 갈릴 수 있음). */
    static final String SETTINGS_CHANGED = "SETTINGS_CHANGED";
    static final String PRICE_MISMATCH = "PRICE_MISMATCH";
    static final String SOURCE_MISMATCH = "SOURCE_MISMATCH";
    static final String QTY_MISMATCH = "QTY_MISMATCH";
    static final String DATE_MISMATCH = "DATE_MISMATCH";
    /**
     * 대조 사유 — 비용(수수료·세금·슬리피지 — 원, 소수 넷째 자리)이 다름(QA-792): 장중 기록은 기록 때의 금융위 시장 구분·설정으로, 밤은 그때의 것으로 체결
     * 조건을 세므로 둘이 갈리면 현금이 갈림. 불일치로 셉니다(설정 판이 다르면 {@value #SETTINGS_CHANGED}도 함께).
     */
    static final String COST_MISMATCH = "COST_MISMATCH";
    /** 사후 점검 사유(ON) — 밤 일괄이었다면 기업행위 판정이 그 STOP을 보류했음(밤이 체결하지 않음과 함께 씀). */
    static final String CORP_ACTION = "CORP_ACTION";
    /** 사후 점검 사유(ON) — 그 세션 밤 관측치가 이미 다음 세션 것이라 밤 일괄을 다시 셀 수 없음({@code match} null). */
    static final String NIGHT_UNCHECKED = "NIGHT_UNCHECKED";

    /** 안정 조건 — 그 종목 항목을 받은 시각이 라벨 T+1 봉 끝 + 이만큼 이후(토스 새 봉 10초 안·완성 봉 거래량 고정 관측에 여유). */
    static final Duration SETTLE = Duration.ofSeconds(60);
    /** G5 — 실제 계좌 스탑 창 끝({@link SessionWindows#krStopMirrorEnd}) + 이만큼 뒤부터 적음. */
    static final Duration GATE_AFTER_WINDOW = Duration.ofSeconds(60);
    private static final Duration MINUTE = Duration.ofMinutes(1);

    /**
     * R1 판정 결과 — 고른 체결(R1일 때만), 그 봉의 라벨·거래량·항목 수집 시각, 아니면 사유(사람이 읽는 한 줄).
     *
     * @param settled 그 종목 항목이 안정 조건(수집 시각)을 지났는가 — 지나지 않았으면 다음 저장본을 기다림
     * @param decided R1이 아님이 굳었는가 — 굳은 항목에서 사다리가 R1이 아닌 뒤 봉(R2·R2b)을 고름(라벨 T+1 봉이 완성됐는데 거래가 없거나 빠짐). 그
     *                STOP은 기다리지 않고 밤에 맡김으로 남깁니다. 창 봉이 아직 없는 기다림·체결 불가는 굳지 않음(뒤 저장본에서 바뀔 수 있음)
     */
    record R1(Choice choice, String barLabel, Long volume, Instant fetchedAt, boolean settled, boolean decided, String reason) {

        boolean found() {
            return choice != null;
        }
    }

    // ------------------------------------------------------------------ 대상(G1의 주문 부분)
    /**
     * 장중 기록 대상인가 — 대기 STOP 매도, 장중 감시가 낸 것({@link StopWatch#intradayStop}), 장중 시장가({@code MARKET}), 생성 시각을 앎, 목표 세션·만료일이
     * 그 세션, 기준 시각 T가 그 세션 장 끝 여유 앞(종가 단일가 전). 밤 대체 STOP·종가·지정 시각은 밤 그대로입니다(ADR 0045 범위).
     */
    static boolean candidate(Order order, LocalDate session, TradingCalendar calendar) {
        if (order == null || !PaperBooks.ORDER_PENDING.equals(order.status()) || !PaperBooks.SELL.equals(order.side())
                || !StopWatch.intradayStop(order) || !PaperBooks.MARKET.equals(order.timing()) || order.createdAt() == null
                || order.ticker() == null || !session.equals(order.expiresOn())) {
            return false;
        }
        if (!session.equals(ExecutionAudit.targetSession(order, calendar))) {
            return false;
        }
        Instant target = KrTimedLadder.targetOn(order, session, calendar);
        return target != null && session.equals(target.atZone(KrxCalendar.SEOUL).toLocalDate())
                && target.isBefore(SessionWindows.end(calendar, session, true));
    }

    /**
     * G5 — 이 시각부터 적을 수 있음: 실제 계좌 스탑 창 끝({@link SessionWindows#krStopMirrorEnd} — 모의 달력의 개장·종가 단일가 시작) + {@link #GATE_AFTER_WINDOW}.
     * 창이 비면(실제 계좌가 따라 팔 창이 없음) T + 60초.
     */
    static Instant gateAt(TradingCalendar calendar, LocalDate session, Instant target) {
        Instant end = SessionWindows.krStopMirrorEnd(calendar.openInstant(session),
                calendar.closeInstant(session).minus(SessionWindows.KR_CLOSING_AUCTION), target);
        return (end == null ? target : end).plus(GATE_AFTER_WINDOW);
    }

    // ------------------------------------------------------------------ 창·R1
    /**
     * 감시 항목 → 창 키 {@code key}의 1분봉 칸(클래스 설명 '창 만들기'). 상태 OK, 수집 시각 = 그 항목의 {@code fetchedAt}, 마감 봉 없음.
     */
    static Timed timed(JsonNode entry, LocalTime key) {
        TreeMap<String, Bar1m> bars = new TreeMap<>();
        for (JsonNode bar : Json.array(entry, "bars")) {
            String label = Json.asText(bar, "label");
            if (label != null) {
                bars.put(label, new Bar1m(label, price(bar.get("o")), volume(bar.get("v"))));
            }
        }
        String first = KrTimedLadder.label(key.plusMinutes(1));
        List<Bar1m> window = new ArrayList<>();
        for (int minute = 1; minute <= KrTimedLadder.WINDOW_BARS; minute++) {
            Bar1m bar = bars.get(KrTimedLadder.label(key.plusMinutes(minute)));
            if (bar != null) {
                window.add(bar);
            }
        }
        Bar1m after = null;
        for (Bar1m bar : bars.tailMap(first, true).values()) {
            if (bar.volume() != null && bar.volume() > 0) {
                after = bar;
                break;
            }
        }
        Map<String, Bar1m> firstAfter = new LinkedHashMap<>();
        firstAfter.put(KrTimedLadder.label(key), after);
        return new Timed(KrQuotes.TIMED_OK, null, fetchedAt(entry), Map.of(KrTimedLadder.label(key), window), firstAfter, Map.of());
    }

    /**
     * 그 STOP의 R1(클래스 설명의 안정 조건) — 감시 항목으로 만든 칸을 밤과 같은 사다리({@link KrTimedLadder#price})에 넣어 {@value KrTimedLadder#SOURCE_AT}일
     * 때만 체결을 돌려줍니다.
     */
    static R1 r1(Order order, JsonNode entry, LocalDate session, TradingCalendar calendar) {
        Instant target = KrTimedLadder.targetOn(order, session, calendar);
        if (target == null) {
            return new R1(null, null, null, null, false, false, "기준 시각 모름(생성 시각 없음)");
        }
        if (!StopWatch.usable(entry, session)) {
            return new R1(null, null, null, null, false, false, entry == null ? "감시 항목 없음" : "감시 항목이 그 세션 것이 아니거나 이어받음");
        }
        Instant fetched = fetchedAt(entry);
        LocalTime key = target.atZone(KrxCalendar.SEOUL).toLocalTime();
        String first = KrTimedLadder.label(key.plusMinutes(1));
        if (fetched == null || fetched.isBefore(target.plus(MINUTE).plus(SETTLE))) {
            return new R1(null, first, null, fetched, false, false, "감시 항목 수집 " + (fetched == null ? "시각 모름" : com.macrodash.Kst.stamp(fetched))
                    + " — 라벨 " + first + " 봉 끝 + " + SETTLE.toSeconds() + "초 전(덜 굳음)");
        }
        KrTimedLadder.Result result = KrTimedLadder.price(order.timing(), order.createdAt(), null, timed(entry, key), null, session, fetched,
                calendar, calendar.closeInstant(session));
        if (result.choice() == null || !KrTimedLadder.SOURCE_AT.equals(result.choice().source())) {
            String why = result.choice() == null ? result.reason() : "R1 아님(" + result.choice().source() + ")";
            return new R1(null, first, null, fetched, true, result.choice() != null, why);
        }
        Long volume = null;
        for (JsonNode bar : Json.array(entry, "bars")) {
            if (first.equals(Json.asText(bar, "label"))) {
                volume = volume(bar.get("v"));
            }
        }
        return new R1(result.choice(), first, volume, fetched, true, true, null);
    }

    // ------------------------------------------------------------------ G3 시간 순서
    /**
     * G3 — 밤 순서({@code processAuction}: 시가 → 장중 시각 순(날짜를 보지 않는 {@link LocalTime}) → 종가)와 같게 그 STOP을 지금 적어도 되는가. 그 책의
     * 대기 주문(만료일이 그 세션 앞인 것·그 STOP 자신 빼기) 가운데 (a) 시가 주문이 하나라도 있으면 {@value #OPEN_ORDER}, (b) 장중 시각이 그 STOP의 기준 시각
     * 이하인 주문(다른 종목의 STOP 매도는 빼고 — 매도는 현금을 쓰지 않아 서로 결과를 바꾸지 않음)이 있으면 {@value #EARLIER_ORDER}, (c) 같은 종목의 다른
     * 주문이 있으면 {@value #SAME_TICKER}. 비면 통과.
     */
    static List<String> orderGate(Order stop, List<Order> pending, LocalDate session) {
        LocalTime at = PaperLedgerService.intradayTime(stop);
        boolean open = false;
        boolean earlier = false;
        boolean same = false;
        for (Order o : pending) {
            if (o.id() == stop.id() || !PaperBooks.ORDER_PENDING.equals(o.status())
                    || (o.expiresOn() != null && o.expiresOn().isBefore(session))) {
                continue;
            }
            if (Objects.equals(stop.ticker(), o.ticker())) {
                same = true;
            }
            if (PaperBooks.NEXT_OPEN.equals(o.timing())) {
                open = true;
                continue;
            }
            boolean otherStopSell = PaperBooks.SOURCE_STOP.equals(o.source()) && PaperBooks.SELL.equals(o.side())
                    && !Objects.equals(stop.ticker(), o.ticker());
            LocalTime other = PaperLedgerService.intradayTime(o);
            if (!otherStopSell && other != null && at != null && !other.isAfter(at)) {
                earlier = true;
            }
        }
        List<String> out = new ArrayList<>();
        if (open) {
            out.add(OPEN_ORDER);
        }
        if (earlier) {
            out.add(EARLIER_ORDER);
        }
        if (same) {
            out.add(SAME_TICKER);
        }
        return out;
    }

    // ------------------------------------------------------------------ G4 기업행위
    /**
     * G4 — 밤 기업행위 판정이 보류했을 STOP을 장중이 먼저 팔지 않게(보수적으로): ① 미처리 기업행위 표시 {@value #CORP_HOLD}, ② 보유의 since 봉이 전 거래일이
     * 아님 {@value #CORP_SINCE}, ③ 감시 갭 가드가 통과가 아니거나 전일 원시·수정 종가가 없거나 그 날짜가 전 거래일이 아님 {@value #CORP_GUARD}, ④ 금융위
     * 상장 상태 신호({@link KrxCorporateActions#assess} — since 봉 하나와 토스 '상장'·금융위 존재·상장주식수, 기준일 = 그 세션)가 '없음'이 아님
     * {@value #CORP_LISTING}. 넷을 모두 봅니다(통계용 — 하나라도 있으면 밤에 맡김).
     *
     * @param fillRefVolume 보유 since 봉 거래량(보유 레코드 밖 — 모르면 null)
     * @param fsc           그 종목 금융위 확정 시세(읽지 못했으면 {@link KrConfirmed.Series#UNKNOWN})
     * @param etf           ETF 목록 종목인가(분배락 수정 비율 건너뜀 — 밤과 같음)
     */
    static List<String> corpGate(Position position, Long fillRefVolume, boolean corpHold, JsonNode entry, KrConfirmed.Series fsc,
                                 LocalDate session, LocalDate previous, boolean etf) {
        List<String> out = new ArrayList<>();
        if (corpHold) {
            out.add(CORP_HOLD);
        }
        if (!previous.equals(position.fillRefDate())) {
            out.add(CORP_SINCE);
        }
        JsonNode prev = Json.child(entry, "prevClose");
        Double raw = Json.asDouble(prev, "raw");
        Double adjusted = Json.asDouble(prev, "adjusted");
        StopWatch.Guard guard = StopWatch.guard(entry, true, null);
        if (!guard.clear() || raw == null || !(raw > 0) || adjusted == null || !(adjusted > 0)
                || !previous.toString().equals(Json.asText(prev, "date"))) {
            out.add(CORP_GUARD);
        }
        if (position.fillRefDate() != null) {
            List<KrxCorporateActions.DailyBar> bars = new ArrayList<>();
            if (position.fillRefClose() > 0 && Double.isFinite(position.fillRefClose())) {
                bars.add(new KrxCorporateActions.DailyBar(position.fillRefDate(), position.fillRefClose(), fillRefVolume, null));
            }
            KrxCorporateActions.Listing listing = new KrxCorporateActions.Listing(KrxCorporateActions.Presence.LISTED, fsc.presence(),
                    fsc.sharesBefore(), fsc.sharesAfter());
            KrxCorporateActions.Assessment assessment = KrxCorporateActions.assess(session, position.fillRefDate(), position.qty(), bars,
                    listing, etf);
            if (assessment.kind() != KrxCorporateActions.Kind.NONE) {
                out.add(CORP_LISTING);
            }
        } else if (!out.contains(CORP_SINCE)) {
            out.add(CORP_SINCE);
        }
        return out;
    }

    // ------------------------------------------------------------------ 밤 뒤 대조
    /**
     * 밤 처리 뒤 대조 칸({@value #CHECK}) — 그 주문이 체결됐으면 밤 체결의 관측가·출처·수량·관측일·비용·설정 판을 기록의 값과 견주고, 체결되지 않았으면
     * {@value #NIGHT_NOT_FILLED}. 판정이 {@value #RECORD}가 아닌 기록(밤에 맡김)은 견주지 않고({@code match} null) 밤 결과만 남깁니다.
     *
     * @param fill                밤 체결(없으면 null)
     * @param nightSettingsVersion 밤 체결 때 유효한 설정 판(모르면 null — 견주지 않음)
     */
    static Map<String, Object> check(JsonNode record, Order order, Fill fill, Integer nightSettingsVersion, Instant now) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkedAt", now.toString());
        out.put("nightStatus", order.status());
        out.put("nightRawPrice", fill == null ? null : fill.rawPrice());
        out.put("nightSource", fill == null ? null : fill.priceSource());
        out.put("nightQty", fill == null ? null : fill.qty());
        out.put("nightDate", fill == null || fill.observationDate() == null ? null : fill.observationDate().toString());
        out.put("nightSettingsVersion", nightSettingsVersion);
        boolean recorded = RECORD.equals(Json.asText(record, OUTCOME));
        List<String> reasons = new ArrayList<>();
        Boolean match = null;
        if (recorded) {
            if (fill == null || !PaperBooks.ORDER_FILLED.equals(order.status())) {
                reasons.add(NIGHT_NOT_FILLED);
            } else {
                Double price = Json.asDouble(record, RAW_PRICE);
                if (price == null || BigDecimal.valueOf(price).compareTo(BigDecimal.valueOf(fill.rawPrice())) != 0) {
                    reasons.add(PRICE_MISMATCH);
                }
                if (!Objects.equals(Json.asText(record, PRICE_SOURCE), fill.priceSource())) {
                    reasons.add(SOURCE_MISMATCH);
                }
                Double qty = Json.asDouble(record, QTY);
                if (qty == null || qty.intValue() != fill.qty()) {
                    reasons.add(QTY_MISMATCH);
                }
                String target = Json.asText(record, TARGET_AT);
                Instant targetAt = target == null ? null : instant(target);
                LocalDate session = targetAt == null ? null : targetAt.atZone(KrxCalendar.SEOUL).toLocalDate();
                if (session == null || !session.equals(fill.observationDate())) {
                    reasons.add(DATE_MISMATCH);
                }
                if (!sameCosts(record, fill.fee(), fill.tax(), fill.slippageCost())) {
                    reasons.add(COST_MISMATCH);
                }
            }
            match = reasons.isEmpty();
            Double version = Json.asDouble(record, SETTINGS_VERSION);
            if (nightSettingsVersion != null && version != null && version.intValue() != nightSettingsVersion) {
                reasons.add(SETTINGS_CHANGED);   // 값은 같아도 판이 다르면 따로 가름(비용·재진입 금지 일수가 갈릴 수 있는 날)
            }
        }
        out.put("match", match);
        out.put(REASONS, reasons);
        return out;
    }

    // ------------------------------------------------------------------ ON 사후 점검(밤 일괄이었다면)
    /**
     * 사후 점검의 기업행위 판정(ON — 클래스 설명 G4의 밤 뒤 짝): 밤 장부의 판정({@code PaperLedgerService.assess})과 같은 입력 — 그 밤 관측치의 그 종목 봉(이어받은
     * 항목이면 넘기지 않음) + 기록 직전 보유의 since 봉(저장본 창 밖이면 더함), 토스 상장 상태(새 항목이면 상장, 관측치가 '없음'으로 적었으면 없음, 아니면 모름)·
     * 금융위 존재·상장주식수, 기준일 = 그 봉의 마지막 날(새 항목이 아니면 그 세션). 밤 일괄에서 이 판정이 '없음'이 아니면 그 STOP은 보류돼 체결되지 않았습니다.
     *
     * @param bar           그 밤 관측치의 그 종목 봉(없으면 null)
     * @param absent        그 밤 관측치가 그 종목을 '없음'으로 적음
     * @param before        기록 직전 보유(근거 {@value #BEFORE}) — since 봉이 없으면 판정하지 않고 null을 돌려줌
     * @param fillRefVolume 기록 직전 since 봉 거래량(근거 {@value #FILL_REF_VOLUME} — 모르면 null)
     */
    static KrxCorporateActions.Assessment nightCorporate(PaperMarketData.Bar bar, boolean absent, LocalDate session, Position before,
                                                         Long fillRefVolume, KrConfirmed.Series fsc, boolean etf) {
        if (before == null || before.fillRefDate() == null) {
            return null;
        }
        boolean fresh = bar != null && !bar.stale() && bar.kr() != null;
        List<KrxCorporateActions.DailyBar> bars = new ArrayList<>();
        if (fresh) {
            for (KrQuotes.Day day : bar.kr().days()) {
                if (day.close() != null) {
                    bars.add(new KrxCorporateActions.DailyBar(day.date(), day.close().doubleValue(), day.volume(), day.adjRatio()));
                }
            }
        }
        if (before.fillRefClose() > 0 && Double.isFinite(before.fillRefClose())) {
            KrxCorporateActions.DailyBar since = new KrxCorporateActions.DailyBar(before.fillRefDate(), before.fillRefClose(), fillRefVolume, null);
            if (bars.stream().noneMatch(b -> b.date().equals(since.date()))
                    && (bars.isEmpty() || since.date().isBefore(bars.get(bars.size() - 1).date()))) {
                bars.add(since);
            }
        }
        KrxCorporateActions.Presence toss = fresh ? KrxCorporateActions.Presence.LISTED
                : absent ? KrxCorporateActions.Presence.ABSENT : KrxCorporateActions.Presence.UNKNOWN;
        KrConfirmed.Series series = fsc == null ? KrConfirmed.Series.UNKNOWN : fsc;
        KrxCorporateActions.Listing listing = new KrxCorporateActions.Listing(toss, series.presence(), series.sharesBefore(),
                series.sharesAfter());
        LocalDate asOf = fresh ? bar.kr().last().date() : session;
        return KrxCorporateActions.assess(asOf, before.fillRefDate(), before.qty(), bars, listing, etf);
    }

    /**
     * 사후 점검의 값 비교(ON) — 밤 일괄이 그 STOP에 골랐을 체결(관측가·출처·체결일·수량·비용)과 장중 기록의 값. 다르면 그 사유들({@value #PRICE_MISMATCH}·
     * {@value #SOURCE_MISMATCH}·{@value #DATE_MISMATCH}·{@value #QTY_MISMATCH}·{@value #COST_MISMATCH}), 같으면 빈 목록.
     *
     * @param nightCosts 밤 일괄이 그 체결에 셌을 비용(밤과 같은 체결 조건 — {@link FillTerms#costs})
     */
    static List<String> compare(JsonNode record, double nightRaw, String nightSource, LocalDate nightDate, int nightQty, FillTerms.Costs nightCosts) {
        List<String> out = new ArrayList<>();
        Double price = Json.asDouble(record, RAW_PRICE);
        if (price == null || BigDecimal.valueOf(price).compareTo(BigDecimal.valueOf(nightRaw)) != 0) {
            out.add(PRICE_MISMATCH);
        }
        if (!Objects.equals(Json.asText(record, PRICE_SOURCE), nightSource)) {
            out.add(SOURCE_MISMATCH);
        }
        String target = Json.asText(record, TARGET_AT);
        Instant targetAt = target == null ? null : instant(target);
        if (targetAt == null || !targetAt.atZone(KrxCalendar.SEOUL).toLocalDate().equals(nightDate)) {
            out.add(DATE_MISMATCH);
        }
        Double qty = Json.asDouble(record, QTY);
        if (qty == null || qty.intValue() != nightQty) {
            out.add(QTY_MISMATCH);
        }
        if (nightCosts == null || !sameCosts(record, nightCosts.fee(), nightCosts.tax(), nightCosts.slippageCost())) {
            out.add(COST_MISMATCH);
        }
        return out;
    }

    /** 기록의 비용 세 칸({@value #FEE}·{@value #TAX}·{@value #SLIPPAGE_COST})이 밤 값과 모두 같은가(십진수로 — 자릿수는 보지 않음). 어느 쪽이든 없으면 다름. */
    private static boolean sameCosts(JsonNode record, BigDecimal fee, BigDecimal tax, BigDecimal slippage) {
        return sameAmount(Json.child(record, FEE), fee) && sameAmount(Json.child(record, TAX), tax)
                && sameAmount(Json.child(record, SLIPPAGE_COST), slippage);
    }

    private static boolean sameAmount(JsonNode recorded, BigDecimal night) {
        return recorded != null && recorded.isNumber() && night != null && recorded.decimalValue().compareTo(night) == 0;
    }

    // ------------------------------------------------------------------ 보유 사본·되감기(실제 계좌 공개 창의 거울 보기)
    /**
     * 장중 기록 직전 보유의 사본(근거 {@value #BEFORE}) — 보유 레코드 칸 그대로(날짜·시각은 ISO 글). 공개 창({@link PaperMirrorService})이 그 세션 밤 처리
     * 전까지 이 사본으로 보유를 되살립니다({@link #position}).
     */
    static Map<String, Object> before(Position p) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("qty", p.qty());
        out.put("avgCost", p.avgCost());
        out.put("openedOn", p.openedOn() == null ? null : p.openedOn().toString());
        out.put("openedAt", p.openedAt() == null ? null : p.openedAt().toString());
        out.put("highWatermark", p.highWatermark());
        out.put("watermarkAt", p.watermarkAt() == null ? null : p.watermarkAt().toString());
        out.put("lastPrice", p.lastPrice());
        out.put("lastPriceAt", p.lastPriceAt() == null ? null : p.lastPriceAt().toString());
        out.put("priceStale", p.priceStale());
        out.put("fillRefDate", p.fillRefDate() == null ? null : p.fillRefDate().toString());
        out.put("fillRefClose", p.fillRefClose());
        out.put("splitNote", p.splitNote());
        return out;
    }

    /** 근거의 보유 사본({@link #before}) → 그 책·종목의 보유, 수량을 읽을 수 없으면(1 미만 포함) null. */
    static Position position(String book, String ticker, JsonNode before) {
        Double qty = Json.asDouble(before, "qty");
        Double avgCost = Json.asDouble(before, "avgCost");
        if (qty == null || qty < 1 || avgCost == null) {
            return null;
        }
        Double high = Json.asDouble(before, "highWatermark");
        Double refClose = Json.asDouble(before, "fillRefClose");
        String openedOn = Json.asText(before, "openedOn");
        String fillRefDate = Json.asText(before, "fillRefDate");
        return new Position(book, ticker, qty.intValue(), avgCost, openedOn == null ? null : LocalDate.parse(openedOn),
                instantOrNull(Json.asText(before, "openedAt")), high == null ? avgCost : high, instantOrNull(Json.asText(before, "watermarkAt")),
                Json.asDouble(before, "lastPrice"), instantOrNull(Json.asText(before, "lastPriceAt")), Json.asBoolean(before, "priceStale"),
                fillRefDate == null ? null : LocalDate.parse(fillRefDate), refClose == null ? 0 : refClose, Json.asText(before, "splitNote"));
    }

    /**
     * 현금 되감기 한 단계(기록 트랜잭션 하나) — 지금 상태 현금이 기록 직후 값({@value #CASH_AFTER} — 쓴 값 그대로)과 같으면 기록 직전 값({@value #CASH_BEFORE})
     * 그대로, 다르면(그사이 확정 조정 등이 현금을 옮김) 십진수로 '지금 − (직후 − 직전)'을 센 뒤 소수 넷째 자리(상태 현금 열과 같은 자리). 두 배정밀도 수의
     * 뺄셈으로 직전 값을 다시 만들면 끝자리가 갈려 장중 기록이 없던 세계와 비중·순자산이 비트까지 같지 않습니다.
     */
    static double rewindCash(double now, double before, double after) {
        if (Double.compare(now, after) == 0) {
            return before;
        }
        return BigDecimal.valueOf(now).subtract(BigDecimal.valueOf(after).subtract(BigDecimal.valueOf(before)))
                .setScale(4, java.math.RoundingMode.HALF_UP).doubleValue();
    }

    private static Instant instantOrNull(String text) {
        return text == null ? null : instant(text);
    }

    // ------------------------------------------------------------------ 저장본 칸 읽기
    /** 감시 항목을 받은 시각({@code fetchedAt} — 그 종목 응답을 받은 뒤), 모르면 null. */
    static Instant fetchedAt(JsonNode entry) {
        String text = Json.asText(entry, "fetchedAt");
        return text == null ? null : instant(text);
    }

    private static Instant instant(String text) {
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** 양수 가격(십진수 그대로), 아니면 null — {@link KrQuotes}의 1분봉 칸과 같은 규칙. */
    private static BigDecimal price(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        return value.signum() > 0 ? value : null;
    }

    /** 0 이상 정수 거래량, 아니면 null — {@link KrQuotes}의 1분봉 칸과 같은 규칙. */
    private static Long volume(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        if (value.signum() < 0 || value.stripTrailingZeros().scale() > 0) {
            return null;
        }
        try {
            return value.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
    }
}
