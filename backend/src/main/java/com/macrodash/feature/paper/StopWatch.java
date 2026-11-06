package com.macrodash.feature.paper;

import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

/**
 * 모의 장중 스탑 감시의 판정(ADR 0032) — 감시 저장본({@code paper.stopwatch.us}·{@code paper.stopwatch.kr}, 수집기 {@code paper_stopwatch} 머리말의
 * contract 1) 한 장만 보는 상태 없는 순수 함수 모음입니다. 재기동에도 같은 저장본이면 같은 답입니다(저장본은 이름마다 최신 1건).
 *
 * <ul>
 *   <li><b>격자</b>: G<sub>k</sub> = 그 세션 개장 + 5분 × k(k ≥ 1), 끝은 마감 − 장 끝 여유(미국 15:55 ET, 한국 15:20 — 종가 단일가 앞,
 *       {@link SessionWindows#end}). 그 시장 실행 달력으로 셉니다(조기 폐장·장 시간 변경일 포함).</li>
 *   <li><b>격자의 가격</b>: 미국은 봉 시작 t ∈ [G − 5분, G − 1분], 한국은 봉 끝 라벨 ∈ (G − 5분, G] 가운데 거래 봉(미국 spark는 종가가 있는 봉,
 *       한국은 거래량 &gt; 0)의 마지막 종가 — 그 5분 동안의 마지막 체결가입니다. 없거나, 항목의 세션이 그 세션이 아니거나, 이어받은 항목이면 '모름'.</li>
 *   <li><b>판정</b>: G − 5와 G 두 격자의 가격이 모두 스탑가({@link TrailingStop#stopPrice}) 이하이면 건다(같으면 건다 — 기존 의미 그대로). 첫 격자
 *       (개장 + 5분)는 앞 격자가 없어 걸 수 없으므로 가장 이른 판정은 개장 + 10분입니다(개장 10분 전에는 팔지 않음).</li>
 *   <li><b>갭 가드</b>(통합 검토 R1 — 기업행위 오인 방지): 그날 첫 봉 가격(미국 첫 분 종가, 한국 개장 봉 시가) ≤ 전일 원시 종가 × {@value #GAP_GUARD}이면
 *       그날 그 종목은 감시에서 뺍니다. 한국은 토스 일봉의 전일 원시·수정 종가가 {@value #KR_ADJUSTED_MISMATCH}배 넘게 다를 때, 미국은 Yahoo 전일 종가와
 *       장부의 전일 종가({@code fill_ref_close})가 {@value #US_CLOSE_MISMATCH}배 넘게 다를 때도 뺍니다. 뺀 종목은 밤·시간별 경로(기업행위·분할 판정 뒤
 *       스탑)가 맡습니다. 가드를 판단할 자료(첫 봉·전일 종가)가 없으면 '모름' — 감시가 그 종목을 판정하지 않습니다.</li>
 *   <li><b>덮음</b>({@link #covered}): 장부의 대체 경로(미국 시간별·한국 밤 스탑)가 그 종목을 건너뛰어도 되는가 — 그 세션 항목이 이어받지 않은 새
 *       값이고, 가드가 판단되어 빼지 않았고, min(그 시각, 격자 끝) − {@link #COVER_WINDOW} 이후의 거래 표본이 있을 때.</li>
 *   <li><b>주문 시점</b>({@link #target}): T = 감지(주문 생성) + 60초 뒤 첫 분({@link ExecutionAudit#marketTarget} — 늦은 주문 가드 ⑤를 지킴). T가 그
 *       세션 첫 분(개장 + 10분) 앞이면 그 첫 분의 지정 시각, 장 끝 여유 안(미국 15:55·한국 15:20 뒤)이면 종가, 그 밖은 장중 시장가.</li>
 * </ul>
 */
final class StopWatch {

    private StopWatch() {
    }

    /** 감시 간격(사용자 결정 2026-11-06 '5분 감시'). */
    static final Duration GRID = Duration.ofMinutes(5);
    /** 갭 가드 — 첫 봉 가격이 전일 원시 종가의 이 배 이하이면 그날 감시에서 뺌(0.2주 무상증자 약 −17%를 잡는 값). */
    static final double GAP_GUARD = 0.85;
    /** 한국 — 토스 일봉 전일 원시·수정 종가가 이만큼(비율) 넘게 다르면 그날 기업행위가 반영된 것으로 봄. */
    static final double KR_ADJUSTED_MISMATCH = 0.005;
    /** 미국 — Yahoo 전일 종가와 장부의 전일 종가가 이만큼(비율) 넘게 다르면 분할 등이 반영된 것으로 봄. */
    static final double US_CLOSE_MISMATCH = 0.02;
    /** 덮음 판정 — 이 시간 안의 거래 표본이 있어야 감시가 그 종목을 지켜본 것으로 봅니다. */
    static final Duration COVER_WINDOW = Duration.ofMinutes(10);
    private static final Duration MINUTE = Duration.ofMinutes(1);

    /** 판정 결과. */
    enum Verdict {
        /** 두 격자 모두 스탑가 이하 — 건다. */
        TRIGGER,
        /** 두 가격을 알지만 걸지 않음. */
        NONE,
        /** 가격을 모름(표본 없음·다른 세션·이어받은 항목) — 판정하지 않음. */
        UNKNOWN
    }

    /** 한 격자의 가격 — 가격(모르면 null)과 그 가격의 봉 시각(미국 봉 시작, 한국 봉 끝). */
    record Check(Instant grid, Double price, Instant barAt) {
    }

    /** 한 격자의 판정 — 앞 격자(G − 5)와 그 격자(G)의 가격. */
    record Evaluation(Verdict verdict, Check previous, Check current) {
    }

    /**
     * 갭 가드의 판단.
     *
     * @param known   판단할 자료(첫 봉·전일 종가)가 있었나 — 없으면 감시가 그 종목을 판정하지 않음
     * @param guarded 그날 감시에서 뺌
     * @param reason  뺀 까닭·모르는 까닭(사람이 읽는 한 줄) — 통과면 null
     */
    record Guard(boolean known, boolean guarded, String reason) {

        static final Guard PASS = new Guard(true, false, null);

        /** 감시가 이 종목을 판정해도 되는가. */
        boolean clear() {
            return known && !guarded;
        }
    }

    /** 감시 STOP의 시점 — {@code timing}·기준 시각 T(종가면 그 세션 마감)·지정 시각(AT_MINUTE일 때만, 그 시장 현지 시각). */
    record Target(String timing, Instant at, LocalTime targetLocal) {
    }

    // ------------------------------------------------------------------ 격자
    /** 그 세션의 격자 끝 — 마감 − 장 끝 여유({@link SessionWindows#end}). */
    static Instant gridEnd(TradingCalendar calendar, LocalDate session, boolean korea) {
        return SessionWindows.end(calendar, session, korea);
    }

    /** 그 세션의 격자 전부(이른 순) — 개장 + 5분부터 격자 끝까지. 거래일이 아니면 빈 목록. */
    static List<Instant> grids(TradingCalendar calendar, LocalDate session, boolean korea) {
        if (!calendar.isTradingDay(session)) {
            return List.of();
        }
        Instant end = gridEnd(calendar, session, korea);
        List<Instant> out = new ArrayList<>();
        for (Instant g = calendar.openInstant(session).plus(GRID); !g.isAfter(end); g = g.plus(GRID)) {
            out.add(g);
        }
        return out;
    }

    // ------------------------------------------------------------------ 가격·판정
    /** 그 세션의 이어받지 않은 항목인가(판정·덮음의 전제). */
    static boolean usable(JsonNode entry, LocalDate session) {
        return entry != null && !Json.asBoolean(entry, "isStale") && session.toString().equals(Json.asText(entry, "session"));
    }

    /** 격자 G의 가격(클래스 설명) — 항목이 그 세션 것이 아니거나 이어받은 것이면 가격 null. */
    static Check price(JsonNode entry, Instant grid, LocalDate session, TradingCalendar calendar, boolean korea) {
        if (!usable(entry, session)) {
            return new Check(grid, null, null);
        }
        Instant from = grid.minus(GRID);
        Double price = null;
        Instant at = null;
        for (JsonNode bar : Json.array(entry, "bars")) {
            Instant time = barTime(bar, session, calendar, korea);
            Double close = Json.asDouble(bar, "c");
            if (time == null || close == null || !(close > 0) || !traded(bar, korea)) {
                continue;
            }
            boolean inside = korea ? time.isAfter(from) && !time.isAfter(grid)
                    : !time.isBefore(from) && !time.isAfter(grid.minus(MINUTE));
            if (inside && (at == null || time.isAfter(at))) {
                price = close;
                at = time;
            }
        }
        return new Check(grid, price, at);
    }

    /** 격자 G의 판정(클래스 설명) — 앞 격자와 그 격자 가격이 모두 스탑가 이하이면 TRIGGER. */
    static Evaluation evaluate(JsonNode entry, Instant grid, double stopPrice, LocalDate session, TradingCalendar calendar,
                               boolean korea) {
        Check previous = price(entry, grid.minus(GRID), session, calendar, korea);
        Check current = price(entry, grid, session, calendar, korea);
        if (previous.price() == null || current.price() == null) {
            return new Evaluation(Verdict.UNKNOWN, previous, current);
        }
        boolean below = previous.price() <= stopPrice && current.price() <= stopPrice;
        return new Evaluation(below ? Verdict.TRIGGER : Verdict.NONE, previous, current);
    }

    /** 그 세션에서 '걸렸는가'를 볼 첫 격자 — 개장 + 10분(앞 격자가 있는 첫 격자). */
    static Instant firstJudgedGrid(TradingCalendar calendar, LocalDate session) {
        return calendar.openInstant(session).plus(GRID).plus(GRID);
    }

    // ------------------------------------------------------------------ 갭 가드
    /**
     * 갭 가드(클래스 설명).
     *
     * @param ledgerPrevClose 장부가 아는 전일 종가(미국 보유의 {@code fill_ref_close} — 기준일이 그 세션 직전 거래일일 때, 한국은 저장본에 전일 종가가
     *                        없을 때의 밤 관측 종가), 모르면 null
     */
    static Guard guard(JsonNode entry, boolean korea, Double ledgerPrevClose) {
        JsonNode first = Json.child(Json.child(entry, "day"), "first");
        Double firstPrice = Json.asDouble(first, korea ? "o" : "c");
        if (firstPrice == null || !(firstPrice > 0)) {
            return new Guard(false, false, "그날 첫 봉을 모름");
        }
        if (korea) {
            JsonNode prev = Json.child(entry, "prevClose");
            Double raw = positive(Json.asDouble(prev, "raw"));
            Double adjusted = positive(Json.asDouble(prev, "adjusted"));
            Double reference = raw != null ? raw : positive(ledgerPrevClose);
            if (reference == null) {
                return new Guard(false, false, "전일 원시 종가를 모름");
            }
            if (firstPrice <= GAP_GUARD * reference) {
                return new Guard(true, true, "그날 첫 봉 시가 " + trim(firstPrice) + " ≤ 전일 원시 종가 " + trim(reference) + " × "
                        + GAP_GUARD + " — 기업행위 가능성, 밤 경로에 맡김");
            }
            if (raw != null && adjusted != null && Math.abs(adjusted / raw - 1) > KR_ADJUSTED_MISMATCH) {
                return new Guard(true, true, "전일 수정 종가 " + trim(adjusted) + " ≠ 원시 종가 " + trim(raw)
                        + " — 그날 기업행위 반영, 밤 경로에 맡김");
            }
            return Guard.PASS;
        }
        Double yahoo = positive(Json.asDouble(entry, "prevClose"));
        Double ledger = positive(ledgerPrevClose);
        Double reference = ledger != null ? ledger : yahoo;
        if (reference == null) {
            return new Guard(false, false, "전일 종가를 모름");
        }
        if (firstPrice <= GAP_GUARD * reference) {
            return new Guard(true, true, "그날 첫 분 종가 " + trim(firstPrice) + " ≤ 전일 종가 " + trim(reference) + " × " + GAP_GUARD
                    + " — 분할·기업행위 가능성, 시간별 경로에 맡김");
        }
        if (ledger != null && yahoo != null && Math.abs(yahoo / ledger - 1) > US_CLOSE_MISMATCH) {
            return new Guard(true, true, "Yahoo 전일 종가 " + trim(yahoo) + " ≠ 장부 전일 종가 " + trim(ledger)
                    + " — 분할 등 반영, 시간별 경로에 맡김");
        }
        return Guard.PASS;
    }

    // ------------------------------------------------------------------ 덮음
    /**
     * 장부의 대체 경로가 그 종목을 건너뛰어도 되는가(클래스 설명) — 감시 저장본이 그 세션의 그 종목을 지켜보고 있었음.
     *
     * @param payload 감시 저장본 본문(없으면 거짓)
     * @param at      대체 경로의 판정 시각(관측치 수집 시각)
     */
    static boolean covered(JsonNode payload, String ticker, LocalDate session, Instant at, TradingCalendar calendar, boolean korea,
                           Double ledgerPrevClose) {
        JsonNode entry = Json.child(Json.child(payload, "tickers"), ticker);
        if (!usable(entry, session) || !guard(entry, korea, ledgerPrevClose).clear()) {
            return false;
        }
        Instant end = gridEnd(calendar, session, korea);
        Instant since = (at.isBefore(end) ? at : end).minus(COVER_WINDOW);
        for (JsonNode bar : Json.array(entry, "bars")) {
            Instant time = barTime(bar, session, calendar, korea);
            Double close = Json.asDouble(bar, "c");
            if (time != null && close != null && close > 0 && traded(bar, korea)
                    && !(korea ? time : time.plus(MINUTE)).isBefore(since)) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ 주문 시점
    /** 감시 STOP의 시점(클래스 설명) — 감지(생성) 시각과 그 세션의 달력으로. */
    static Target target(Instant createdAt, LocalDate session, TradingCalendar calendar, boolean korea) {
        Instant t = ExecutionAudit.marketTarget(createdAt);
        Instant first = SessionWindows.first(calendar, session);
        if (t.isBefore(first)) {
            return new Target(PaperBooks.AT_MINUTE, first, SessionWindows.firstLocal(calendar, session));
        }
        if (!t.isBefore(SessionWindows.end(calendar, session, korea))) {
            return new Target(PaperBooks.NEXT_CLOSE, calendar.closeInstant(session), null);
        }
        return new Target(PaperBooks.MARKET, t, null);
    }

    // ------------------------------------------------------------------ 저장본 읽기
    /** 봉의 시각 — 미국은 {@code t}(봉 시작 ISO), 한국은 그 세션 날짜의 {@code label}(봉 끝 'HH:MM', 서울). 읽을 수 없으면 null. */
    static Instant barTime(JsonNode bar, LocalDate session, TradingCalendar calendar, boolean korea) {
        try {
            if (korea) {
                String label = Json.asText(bar, "label");
                return label == null ? null : ZonedDateTime.of(session, LocalTime.parse(label), calendar.zone()).toInstant();
            }
            String t = Json.asText(bar, "t");
            return t == null ? null : OffsetDateTime.parse(t).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** 거래가 있던 봉인가 — 한국은 거래량 &gt; 0, 미국 spark는 거래량을 주지 않아 종가가 있으면 거래로 봄(종가가 없는 분은 저장본에 없음). */
    private static boolean traded(JsonNode bar, boolean korea) {
        if (!korea) {
            return true;
        }
        Double volume = Json.asDouble(bar, "v");
        return volume != null && volume > 0;
    }

    private static Double positive(Double value) {
        return value != null && value > 0 && Double.isFinite(value) ? value : null;
    }

    private static String trim(double value) {
        return java.math.BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }
}
