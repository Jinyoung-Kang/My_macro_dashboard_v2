package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 한국 결정 자료 게이트(2단계 명세 §4-9 — 모두 충족해야 결정을 부름). 정기 결정 작업({@link PaperDecisionJob} — ①~⑥)과 한국 출발
 * ({@link KrStartPipeline} — S 22:30, ①은 앞 주문이 없어 보지 않음 §4-8)이 같은 판정을 씁니다(D1c).
 *
 * <ul>
 *   <li>① 장부가 앞 결정의 주문을 정리함 — 그 계좌 장부가 그 실행의 관측치를 처리했고(상태의 마지막 처리 수집 시각 ≥ 그 관측치의 수집 시각 —
 *       장부가 그 관측치에서 오류로 그 계좌를 되돌렸으면 같은 관측치로는 다시 시도하지 않으므로, D 체결·만료·스탑 감지·평가 전 장부로 결정하지
 *       않게. 한국 관측치는 KR 거래일마다 한 번이라 그 밤 새 관측치가 오지 않습니다 — 복구는 원인을 고친 뒤 한국 수동 리스크 점검
 *       {@value #LEDGER_RECOVERY}(그 시장 실패 기억을 지우고 같은 관측치를 다시 처리 — F1)이나 백엔드 재기동, 아니면 기한 뒤 NO_TRADE), 그 계좌에 기준 거래일 &lt; D이고 그 시장이 체결하는 시점({@link PaperMarket#timings})인 대기 주문이
 *       없음(결정 d11 '대기 = 정리 안 됨'). 확정 순자산 줄의 대기 주문 조건과 같은 거름({@link KrConfirmations#pendingBefore})이되 체결 조건 ⑤
 *       (D 개장 순간 &gt; 주문 생성)는 보지 않습니다 — D 개장 뒤에 만든 주문도 아직 체결되지 않은 대기입니다(결정 e3). <b>장부가 그 실행의
 *       관측치로 체결할 수 없는 주문은 기다리지 않습니다</b>(사용자 결정 2026-10-28 u2 — 명세 §9 '주문 뒤에 시작된 정지와 게이트 ①'의 ⓑ,
 *       {@link #unworkable}): 그 관측치에 그 종목의 기준일 뒤 관측 봉(거래량 &gt; 0)이 없음(거래정지·수집 범위 밖·봉 없음), 그 계좌의
 *       미처리 기업행위 보유(장부가 그 종목 주문을 보류), 또는 장부가 그 관측치를 처리하면서 그 종목 주문을 그날 보류함(기업행위 판정 대기·
 *       분할·병합을 반영한 밤·보유 없는 주문 종목의 신호 — {@link PaperLedgerService#orderHolds(PaperMarket, String, Instant)}, 장부가 처리할
 *       때 주문 행에 남긴 표시(V16)라 재기동해도 같음 — 사용자 결정 v3). 주문은 대기 그대로라 만료(기준일 + 3거래일) 전에 풀리면 체결됩니다. 관측 봉이 있는데
 *       기다리는 주문(1분봉 {@code FAILED} — 결정 d11, 조건 ⑤)은 그대로 막습니다. 결정하는 계좌마다 따로
 *       봅니다(그 계좌의 주문 — 한 계좌의 대기 주문이 다른 계좌 결정을 막지 않게, 두 책은 따로). 정기 결정 작업이 그 실행에서 장부를 처리한
 *       뒤에 봅니다. 일시정지 계좌는 보지 않습니다(장부가 사고팔지 않아 정리되지 않고, 그 결정은 주문 없는 SKIPPED)</li>
 *   <li>② 수집 범위 90% 이상에 D 봉 — {@code paper.kr.quotes} 머리 {@code session} = D이고, {@code scope}의 종목 중 이어받지 않은 항목의
 *       마지막 봉 날짜가 D인 비율(수집기 {@code _has_session_bar}와 같은 규칙). 그 저장본을 <b>시장 파서가 읽지 못하면</b>(계약 판이 다름 —
 *       수집기와 백엔드를 따로 배포하는 사이 — 수집 시각·쓸 수 있는 봉 없음) 원문 봉을 세지 않고 미달입니다: 장부가 처리하지 않는(체결·만료·
 *       평가가 없는) 관측치이고, 규칙 계좌의 체결 가능·거래정지 판정도 그 관측치로 하기 때문입니다</li>
 *   <li>③ U 90% 이상에 D 수급 — U 구성원 중 D 기록의 토스 판({@code updatedAt})이 D 15:35 KST 이후이고 기관 세부 칸이 채워진
 *       비율. <b>규칙 계좌의 입력 동결(K26)과 같은 읽기</b>({@link KrRuleBookService#readInputs} — 결정 시각 뒤에 받은 기록·받은 시각을 모르는
 *       기록은 빠진 채)로 셉니다: 게이트가 본 U·수급이 곧 그 결정이 쓰고 결정 행에 남기는 값입니다(D1c, 결정 e5). U를 읽지 못함(D보다 이른 기준일의
 *       U가 없음 — {@link KrRuleBookService.InputUnavailable})도 이 게이트의 미달입니다. 그리고 <b>20거래일 창의 날마다 U의 절반 이상에
 *       기록</b>이 있어야 합니다({@link #thinWindowDays}) — 달력이 거래일로 아는 날에 시장이 쉬었으면(늦게 지정된 임시휴장이 아직
 *       {@code kr_holidays}·{@code kr.calendar.extraClosures}에 없음) 토스 기록이 통째로 없어 U 전 종목이 최대 19세션 '자료 부족'이 되고, 그
 *       사이 재선정하면 종목 0·153130 99.5%로 보유를 다 팔게 됩니다. 신규 상장·정지 같은 종목 하나의 빈 날과는 이 문턱으로 가릅니다</li>
 *   <li>④ 금융위 기준일 = 직전 거래일 — {@code kr.fsc_prices_meta.latestBasDt} = D의 직전 KR 거래일</li>
 *   <li>⑤ 069500 D 봉 — 늦게 지정된 휴장일 대비(§4-4)</li>
 *   <li>⑥ D가 거래일 — 그 실행의 달력</li>
 * </ul>
 *
 * <p><b>읽기 한 번</b>({@link Inputs}): 관측치 저장본·금융위 메타·규칙 계좌 입력을 그 실행에서 한 번 읽고, 게이트와 그 결정(출발의 규칙 계좌 몫)이
 * 같은 값을 씁니다 — 저장본은 {@link StoreReader#quietly}로만(정기 작업이 수집을 깨우지 않게).
 */
final class KrDecisionGates {

    /** 게이트 ②·③의 문턱(§4-9 — 90% 이상). */
    static final double COVERAGE_MIN = 0.9;
    /** 게이트 ③ — D 수급 기록의 토스 판이 이 시각(KST) 이후여야 장 마감 뒤 판(개인·기관 세부 칸이 차는 판, §4-9 · 조사 2026-10-26). */
    static final LocalTime FLOWS_FROM = LocalTime.of(15, 35);
    private static final String FLOWS_FROM_TEXT = "15:35";
    /**
     * 게이트 ③ — 20거래일 창의 날마다 그날 기록(외국인·기관 둘 다)이 있는 U 비율의 문턱(이상이면 통과). 달력이 모르는 휴장일은 0%라 통째로 걸리고,
     * 종목 하나의 빈 날(신규 상장·정지·그 종목만 받지 못함)은 걸리지 않는 값[추정 — 2026-10-28 로컬 저장본은 창의 날마다 U 100/100].
     */
    static final double WINDOW_DAY_MIN = 0.5;
    /**
     * 게이트 ①의 '장부가 이 실행의 관측치를 처리하지 못함'을 그 창 안에서 푸는 경로 — 한국 수동 리스크 점검(그 시장 장부 실패 기억을 지우고 같은
     * 관측치를 다시 처리, {@link PaperRiskJob#runNowView} — 2단계 명세 §9 'F1 — 한국 장부 실패 기억 지우기').
     */
    static final String LEDGER_RECOVERY = "POST /api/paper/run/risk?market=KR";

    /** 게이트 하나의 판정. {@code status}는 PASS·FAIL. */
    record Gate(String id, String status, String note) {

        boolean blocks() {
            return "FAIL".equals(status);
        }

        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("gate", id);
            out.put("status", status);
            out.put("note", note);
            return out;
        }
    }

    /**
     * 한 세션의 입력 — 그 실행에서 한 번 읽은 것(클래스 설명 '읽기 한 번').
     *
     * @param quotesSnapshot   관측치 저장본({@code paper.kr.quotes}, 없으면 null)
     * @param quotes           그 저장본의 한국 관측치(시장 파서 — 장부·거래정지·체결할 수 있는 종목 판정)
     * @param fscMeta          금융위 메타 저장본 본문(없으면 null)
     * @param rules            규칙 계좌 입력(K26 동결과 같은 읽기). 읽지 못했으면 null
     * @param rulesUnavailable 규칙 계좌 입력을 읽지 못한 사유(읽었으면 null)
     */
    record Inputs(LocalDate session, Snapshot quotesSnapshot, Optional<Quotes> quotes, JsonNode fscMeta,
                  KrRuleBookService.Read rules, String rulesUnavailable) {

        JsonNode quotesPayload() {
            return quotesSnapshot == null ? null : quotesSnapshot.payload();
        }
    }

    /**
     * 한 세션에서 판정한 게이트와 그 순간 — 기한 지남 행의 사유·기다린 까닭(결정 e4)을 기한 전 마지막 판정으로 남기는지
     * ({@code beforeDeadline}), 그 기록이 없어 기한 뒤에 판정했는지. 장부 처리 전 게이트(②④⑤⑥)에서 멈췄으면 그 넷뿐입니다(①③은 판정 전).
     * 기한 전 판정은 결정 작업이 그 실행의 작업 기록에 {@link #view}로 남기고 기한 뒤 첫 실행이 {@link #fromView}로 다시 읽습니다(재기동해도 같음 —
     * 2단계 명세 §4-9 'E0', 사용자 결정 v3).
     */
    record Judged(List<Gate> gates, Instant at, boolean beforeDeadline) {

        Judged {
            gates = List.copyOf(gates);
        }

        /** 결정 행 응답의 판정 근거 문구. */
        String basis() {
            return beforeDeadline ? "기한 전 마지막 판정"
                    : "기한 뒤 판정 — 기한 전 판정 기록이 없음(그 밤 첫 실행이 기한 뒤이거나 그 기록을 쓰지 못함)";
        }

        /** 작업 기록 상세에 남기는 모양 — {@code judgedAt}(ISO 순간)·{@code judgedAtKst}·{@code gates}. */
        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("judgedAt", at.toString());
            out.put("judgedAtKst", Kst.stamp(at));
            out.put("gates", gates.stream().map(Gate::view).toList());
            return out;
        }

        /** {@link #view}로 남긴 기한 전 판정을 다시 읽음 — 없거나 모양이 틀리면 null(짐작하지 않음). */
        static Judged fromView(JsonNode view) {
            if (view == null || !view.isObject() || !view.path("gates").isArray()) {
                return null;
            }
            try {
                Instant at = Instant.parse(view.path("judgedAt").asString(""));
                List<Gate> gates = new ArrayList<>();
                for (JsonNode gate : view.path("gates")) {
                    String id = gate.path("gate").asString("");
                    String status = gate.path("status").asString("");
                    if (id.isEmpty() || !("PASS".equals(status) || "FAIL".equals(status))) {
                        return null;
                    }
                    gates.add(new Gate(id, status, gate.path("note").asString("")));
                }
                return new Judged(gates, at, true);
            } catch (DateTimeParseException e) {
                return null;
            }
        }
    }

    /** 판정과 그 재료 — 계좌 몫(출발)이 게이트를 결정 행에 남기고 같은 입력으로 계획합니다. */
    record Checked(List<Gate> gates, Inputs inputs) {

        Checked {
            gates = List.copyOf(gates);
        }

        List<Map<String, Object>> views() {
            return gates.stream().map(Gate::view).toList();
        }
    }

    private final StoreReader reader;
    private final KrRuleBookService rules;

    KrDecisionGates(StoreReader reader, KrRuleBookService rules) {
        this.reader = reader;
        this.rules = rules;
    }

    // ------------------------------------------------------------------ 읽기
    /** 관측치 저장본과 금융위 메타(게이트 ②④⑤⑥의 재료) — 규칙 계좌 입력은 아직 없음({@link #withRules}). */
    Inputs readSession(MarketRun run, LocalDate d) {
        Snapshot quotes = snapshot(Datasets.SNAP_KR_PAPER_QUOTES, KrPaperMarket.QUOTES_TASK);
        Snapshot meta = snapshot(Datasets.SNAP_FSC_PRICES_META, "fsc_prices");
        Optional<Quotes> parsed = quotes == null ? Optional.empty() : run.parse(quotes);
        return new Inputs(d, quotes, parsed, meta == null ? null : meta.payload(), null, null);
    }

    /**
     * 규칙 계좌 입력을 더한 입력(게이트 ③의 재료 — {@link KrRuleBookService#readInputs}, 읽은 순간 {@code readAt}). 보유·재진입 금지를 읽으므로
     * 정기 결정에서는 장부를 처리한 뒤에 부릅니다. U를 읽지 못하면 사유만 남깁니다(그 밖의 예외는 그대로 — 부르는 쪽의 오류).
     */
    Inputs withRules(MarketRun run, Inputs session, Instant readAt) {
        try {
            KrRuleBookService.Read read = rules.readInputs(run, session.session(), readAt, session.quotes());
            return new Inputs(session.session(), session.quotesSnapshot(), session.quotes(), session.fscMeta(), read, null);
        } catch (KrRuleBookService.InputUnavailable e) {
            return new Inputs(session.session(), session.quotesSnapshot(), session.quotes(), session.fscMeta(), null,
                    e.getMessage());
        }
    }

    // ------------------------------------------------------------------ 판정
    /**
     * 자료 게이트 ②~⑥(클래스 설명) — 출발 결정은 이것만(①은 앞 주문이 없어 보지 않음, §4-8), 정기 결정은 계좌마다 {@link #ledger}(①)를 더합니다.
     * 입력에 규칙 계좌 입력이 없으면({@link #readSession}만 읽음) ③은 미달입니다.
     */
    List<Gate> data(MarketRun run, Inputs in) {
        TradingCalendar calendar = run.calendar();
        List<Gate> out = new ArrayList<>();
        out.add(coverage(in));
        out.add(flows(calendar, in));
        out.add(fsc(in.fscMeta(), calendar.previousTradingDay(in.session())));
        out.add(anchor(in.quotesPayload(), in.session()));
        out.add(tradingDay(calendar, in.session()));
        return out;
    }

    /**
     * 장부를 처리하기 전에 볼 수 있는 게이트 ②④⑤⑥(관측치 저장본·금융위 메타·달력) — 정기 결정 작업은 이것이 미달이면 장부·규칙 계좌 입력을 읽지
     * 않고 기다립니다(그날 관측치 전에 미확정 순자산 줄을 쓰지 않게).
     */
    List<Gate> beforeLedger(MarketRun run, Inputs in) {
        TradingCalendar calendar = run.calendar();
        return List.of(coverage(in),
                fsc(in.fscMeta(), calendar.previousTradingDay(in.session())),
                anchor(in.quotesPayload(), in.session()),
                tradingDay(calendar, in.session()));
    }

    /**
     * ① 그 계좌의 장부가 앞 결정의 주문을 정리함(클래스 설명) — 그 실행의 관측치({@code in}의 관측치 — ②는 시장 파서가 읽은 저장본에서만 통과하므로
     * ② 뒤에는 늘 있음, 없으면 그 판정 없이)를 처리했고, 기준 거래일 &lt; D·체결하는 시점인 대기 주문 중 장부가 그 관측치로 일하는 것이 없음
     * (체결할 수 없는 주문은 문구에만 — {@link #unworkable}). 판정 문구 머리에 계좌 코드.
     *
     * @param ledgerHolds 그 계좌 장부가 그 관측치를 처리하면서 그날 보류한 주문 종목(코드 → 사유 —
     *                    {@link PaperLedgerService#orderHolds(PaperMarket, String, Instant)}, 모르면 빈 표)
     */
    static Gate ledger(PaperStore store, PaperMarket market, String book, LocalDate d, Inputs in,
                       Map<String, String> ledgerHolds) {
        if (store.book(book).map(b -> PaperBooks.PAUSED.equals(b.status())).orElse(false)) {
            // 일시정지 계좌는 장부가 사고팔지 않아 대기 주문이 정리되지 않고, 그 결정은 주문을 내지 않습니다(SKIPPED) — 막을 까닭이 없음.
            return new Gate("①", "PASS", book + " — 일시정지 중(주문을 내지 않음 — 대기 주문을 보지 않음)");
        }
        Instant observed = in == null ? null : in.quotes().map(Quotes::collectedAt).orElse(null);
        if (observed != null) {
            Instant processed = store.state(book).map(PaperStore.BookState::lastProcessedCollectedAt).orElse(null);
            if (processed == null || processed.isBefore(observed)) {
                // 복구 경로(명세 §4-9 'D1c'·§9 'F1'): 장부는 오류 난 관측치로 다시 시도하지 않고, paper.kr.quotes는 KR 거래일마다 한 번이라 그
                // 밤 새 관측치가 오지 않습니다 — 원인을 고친 뒤 한국 수동 리스크 점검(그 시장 오류 기억을 지우고 같은 관측치를 다시 처리)이나
                // 재기동(오류 기억이 메모리라 지워짐), 아니면 기한 뒤 NO_TRADE.
                return new Gate("①", "FAIL", book + " — 장부가 이 실행의 관측치(수집 " + Kst.stamp(observed) + ")를 처리하지 못함(마지막 처리 "
                        + (processed == null ? "없음" : Kst.stamp(processed)) + ") — D 체결·만료·스탑 감지·평가 전 장부로 결정하지 않음. "
                        + "장부 오류였으면 같은 관측치로는 다시 시도하지 않고 한국 관측치는 그 밤 새로 저장되지 않음(다음은 다음 KR 거래일 "
                        + "20:30 뒤) — 원인을 고친 뒤 수동 리스크 점검 " + LEDGER_RECOVERY + "(한국 장부 오류 기억을 지우고 같은 관측치를 "
                        + "다시 처리 — 다음 결정 주기가 그 창에서 결정)이나 백엔드 재기동, 아니면 기한 뒤 NO_TRADE");
            }
        }
        List<Order> pending = KrConfirmations.pendingBefore(store, market, book, d);
        if (pending.isEmpty()) {
            return new Gate("①", "PASS", book + " — 기준일 < " + d + "인 대기 주문 없음(앞 결정의 주문이 정리됨)");
        }
        Map<String, String> holds = new LinkedHashMap<>();
        store.corpActionHolds(book).forEach(hold -> holds.put(hold.ticker(), hold.reason()));
        Optional<Quotes> quotes = in == null ? Optional.empty() : in.quotes();
        List<Order> working = new ArrayList<>();
        List<String> idle = new ArrayList<>();
        for (Order order : pending) {
            String why = unworkable(order, quotes, holds, ledgerHolds);
            if (why == null) {
                working.add(order);
            } else {
                idle.add(row(order) + " " + why);
            }
        }
        String idleNote = idle.isEmpty() ? "" : "대기 주문 " + idle.size() + "건은 장부가 이번 관측치로 체결할 수 없어 기다리지 않음 "
                + String.join(" · ", idle.subList(0, Math.min(5, idle.size()))) + (idle.size() > 5 ? " …" : "")
                + " — 주문은 대기 그대로(만료 전에 풀리면 체결)";
        if (working.isEmpty()) {
            return new Gate("①", "PASS", book + " — 기준일 < " + d + "인 " + idleNote);
        }
        List<String> rows = new ArrayList<>();
        for (Order order : working.subList(0, Math.min(5, working.size()))) {
            rows.add(row(order));
        }
        return new Gate("①", "FAIL", book + " — 기준일 < " + d + "인 대기 주문 " + working.size() + "건 " + String.join(" · ", rows)
                + (working.size() > 5 ? " …" : "") + " — 체결·불가 판정 전(정리 안 됨)" + (idleNote.isEmpty() ? "" : " · 그 밖의 " + idleNote));
    }

    /**
     * 장부가 그 실행의 관측치로는 그 대기 주문을 체결할 수 없는 사유 — ①이 그 주문을 기다리지 않습니다(클래스 설명, 사용자 결정 2026-10-28 u2).
     * 장부가 그 관측치를 처리하면서 그 종목 주문을 그날 보류했으면({@code ledgerHolds} — 기업행위 판정 대기·분할·병합을 반영한 밤·보유 없는 주문
     * 종목의 신호, 주문 행의 그날 보류 표시 — V16) 관측 봉이 있어도 그 관측치로는 체결하지 않습니다. 체결할 수 있거나 아직 일하는 주문이면 null: 관측치에 그
     * 종목의 기준일 뒤 관측 봉(거래량 &gt; 0 — 체결 조건 ④와 같은 뜻)이 있으면 장부가 그 봉으로 체결하거나 기다리는 중입니다(1분봉 {@code FAILED} —
     * 결정 d11, D 개장 뒤 생성 — 조건 ⑤). 이어받은 항목({@code isStale})의 봉도 셉니다 — 관측 봉을 이어받았으면 수집기가 그 종목을 다시 받는 중이라
     * 기다리는 쪽으로 둡니다. 관측치가 없으면 판정하지 않습니다(막음).
     *
     * @param holds       그 계좌의 미처리 기업행위 보유(코드 → 사유 — 장부가 그 종목 주문을 보류, 저장된 표시)
     * @param ledgerHolds 장부가 그 관측치를 처리하면서 그날 보류한 주문 종목(코드 → 사유, 모르면 빈 표)
     */
    static String unworkable(Order order, Optional<Quotes> quotes, Map<String, String> holds,
                             Map<String, String> ledgerHolds) {
        String hold = holds.get(order.ticker());
        if (hold != null) {
            return "미처리 기업행위 보유(" + hold + ") — 장부가 그 종목 주문을 보류";
        }
        String held = ledgerHolds.get(order.ticker());
        if (held != null) {
            return "장부가 이번 관측치로는 보류 — " + held;
        }
        if (quotes.isEmpty() || order.asOfTradingDate() == null) {
            return null;
        }
        PaperMarketData.Bar bar = quotes.get().bars().get(order.ticker());
        if (bar == null) {
            return "이번 관측치에 그 종목 봉이 없음(수집 범위 밖·봉 없음)";
        }
        if (bar.kr() == null) {
            return null;
        }
        for (KrQuotes.Day day : bar.kr().days()) {
            if (day.date().isAfter(order.asOfTradingDate()) && day.observed()) {
                return null;
            }
        }
        return "이번 관측치에 기준일 뒤 관측 봉(거래량 > 0)이 없음(거래정지 등)";
    }

    private static String row(Order order) {
        return "#" + order.id() + " " + order.side() + " " + order.ticker() + "(기준일 " + order.asOfTradingDate() + ")";
    }

    /** 그 게이트 목록에서 ⑤(069500 D 봉)가 미달인가 — 기한 지남 NO_TRADE 행의 사유(결정 e4). */
    static boolean anchorMissing(List<Gate> gates) {
        return gates != null && gates.stream().anyMatch(g -> "⑤".equals(g.id()) && g.blocks());
    }

    /** ② 그 실행의 입력으로 — 저장본을 시장 파서가 읽지 못했으면 원문 봉을 세지 않고 미달(클래스 설명), 읽었으면 {@link #coverage(JsonNode, LocalDate)}. */
    static Gate coverage(Inputs in) {
        if (in.quotesSnapshot() != null && in.quotes().isEmpty()) {
            JsonNode contract = in.quotesPayload() == null ? null : in.quotesPayload().get("contract");
            return new Gate("②", "FAIL", "관측치 저장본(paper.kr.quotes)을 장부가 읽지 못함(계약 판 "
                    + (contract == null || contract.isNull() ? "없음" : contract.toString()) + " — 이 백엔드가 읽는 판 "
                    + KrQuotes.CONTRACT + ", 또는 수집 시각·쓸 수 있는 봉 없음) — 장부가 처리하지 않는 관측치로 결정하지 않음");
        }
        return coverage(in.quotesPayload(), in.session());
    }

    /** ② 수집 범위 90% 이상에 D 봉(클래스 설명 — 저장본 원문의 머리·봉). */
    static Gate coverage(JsonNode quotes, LocalDate d) {
        if (quotes == null) {
            return new Gate("②", "FAIL", "관측치 저장본(paper.kr.quotes)이 없음");
        }
        String session = text(quotes.get("session"));
        if (!d.toString().equals(session)) {
            return new Gate("②", "FAIL", "관측치 세션 " + session + " ≠ " + d + "(그날 20:30 뒤 수집 전)");
        }
        JsonNode scope = quotes.get("scope");
        int total = scope == null || !scope.isArray() ? 0 : scope.size();
        if (total == 0) {
            return new Gate("②", "FAIL", "수집 범위(scope)가 비었음");
        }
        int covered = 0;
        for (JsonNode code : scope) {
            if (hasSessionBar(quotes, text(code), d)) {
                covered++;
            }
        }
        String note = "수집 범위 " + covered + "/" + total + "에 " + d + " 봉";
        return covered >= COVERAGE_MIN * total ? new Gate("②", "PASS", note) : new Gate("②", "FAIL", note + "(90% 미만)");
    }

    /**
     * ③ U 90% 이상에 D 수급(클래스 설명) — U 구성원마다 그 입력의 D 기록 판({@link KrRuleBookService.Stamp})을 봅니다: 기록 없음(빠진 기록 포함)·판
     * 모름(토스 {@code updatedAt}을 읽지 못함)·15:35 전 판·세부 칸 없음은 세지 않습니다. 그리고 20거래일 창의 날마다 U 절반 이상에 기록이 있어야
     * 합니다({@link #thinWindowDays}).
     */
    static Gate flows(TradingCalendar calendar, Inputs in) {
        if (in.rules() == null) {
            return new Gate("③", "FAIL", "U·수급을 읽지 못함 — " + in.rulesUnavailable());
        }
        LocalDate d = in.session();
        Instant from = ZonedDateTime.of(d, FLOWS_FROM, KrxCalendar.SEOUL).toInstant();
        List<String> missing = new ArrayList<>();
        List<String> unknown = new ArrayList<>();
        List<String> early = new ArrayList<>();
        List<String> noDetail = new ArrayList<>();
        int total = 0;
        int covered = 0;
        for (com.macrodash.analytics.KrRules.Member member : in.rules().input().universe()) {
            total++;
            KrRuleBookService.Stamp stamp = in.rules().stamps().get(member.code());
            Instant updated = stamp == null ? null : instant(stamp.updatedAt());
            if (stamp == null) {
                missing.add(member.code());
            } else if (updated == null) {
                unknown.add(member.code());
            } else if (updated.isBefore(from)) {
                early.add(member.code());
            } else if (!stamp.detail()) {
                noDetail.add(member.code());
            } else {
                covered++;
            }
        }
        StringBuilder note = new StringBuilder("U " + covered + "/" + total + "에 " + d + " 수급(" + FLOWS_FROM_TEXT
                + " 뒤 판·세부 칸, U 기준일 " + in.rules().input().universeDate() + ")");
        miss(note, "D 기록 없음", missing);
        miss(note, "판 모름", unknown);
        miss(note, FLOWS_FROM_TEXT + " 전 판", early);
        miss(note, "세부 칸 없음", noDetail);
        boolean session = total > 0 && covered >= COVERAGE_MIN * total;
        if (!session) {
            note.append("(90% 미만)");
        }
        List<String> thin = thinWindowDays(calendar, in.rules().input());
        if (!thin.isEmpty()) {
            note.append(" · 20거래일 창에 U 기록이 절반 미만인 날 ").append(thin.size()).append('(')
                    .append(String.join(", ", thin.subList(0, Math.min(5, thin.size())))).append(thin.size() > 5 ? ", …" : "")
                    .append(") — 달력이 모르는 휴장일이면 kr.calendar.extraClosures에 더함, 아니면 수집 구멍(창이 덜 찬 종목은 '자료 부족')");
        }
        return session && thin.isEmpty() ? new Gate("③", "PASS", note.toString()) : new Gate("③", "FAIL", note.toString());
    }

    /**
     * D로 끝나는 20 KR 거래일 창({@link com.macrodash.analytics.KrRules#flows}와 같은 창)에서 그날 기록(외국인·기관 둘 다 — 같은 읽기의 거름 뒤)이
     * 있는 U 비율이 {@link #WINDOW_DAY_MIN} 미만인 날("날짜 n/U", 오래된 날부터).
     */
    static List<String> thinWindowDays(TradingCalendar calendar, com.macrodash.analytics.KrRules.Input input) {
        List<LocalDate> window = new ArrayList<>();
        LocalDate day = input.session();
        window.add(day);
        while (window.size() < com.macrodash.analytics.KrRules.FLOW_DAYS) {
            day = calendar.previousTradingDay(day);
            window.add(day);
        }
        int total = input.universe().size();
        Map<LocalDate, Integer> recorded = new LinkedHashMap<>();
        window.forEach(d -> recorded.put(d, 0));
        for (com.macrodash.analytics.KrRules.Member member : input.universe()) {
            for (com.macrodash.analytics.KrRules.FlowDay flow : input.flows().getOrDefault(member.code(), List.of())) {
                if (flow != null && flow.foreignNet() != null && flow.institutionNet() != null
                        && recorded.containsKey(flow.date())) {
                    recorded.merge(flow.date(), 1, Integer::sum);
                }
            }
        }
        List<String> out = new ArrayList<>();
        for (int i = window.size() - 1; i >= 0; i--) {
            LocalDate d = window.get(i);
            int n = recorded.get(d);
            if (total > 0 && n < WINDOW_DAY_MIN * total) {
                out.add(d + " " + n + "/" + total);
            }
        }
        return out;
    }

    /** ④ 금융위 기준일 = 직전 거래일(클래스 설명). */
    static Gate fsc(JsonNode meta, LocalDate previous) {
        String latest = meta == null ? null : text(meta.get("latestBasDt"));
        String note = "금융위 기준일 " + latest + " · 직전 거래일 " + previous;
        return previous.toString().equals(latest) ? new Gate("④", "PASS", note) : new Gate("④", "FAIL", note);
    }

    /** ⑤ 069500 D 봉(클래스 설명). */
    static Gate anchor(JsonNode quotes, LocalDate d) {
        boolean has = quotes != null && hasSessionBar(quotes, PaperBooks.KODEX_200, d);
        return has ? new Gate("⑤", "PASS", PaperBooks.KODEX_200 + " " + d + " 봉 있음")
                : new Gate("⑤", "FAIL", PaperBooks.KODEX_200 + " " + d + " 봉 없음(휴장 또는 지연)");
    }

    /** ⑥ D가 거래일(그 실행의 달력). */
    static Gate tradingDay(TradingCalendar calendar, LocalDate d) {
        return calendar.isTradingDay(d) ? new Gate("⑥", "PASS", d + " KRX 거래일")
                : new Gate("⑥", "FAIL", d + "는 KRX 거래일이 아님");
    }

    /** 그 종목 항목이 이번에 받은 것(이어받기 아님)이고 마지막 봉 날짜가 D인가 — 수집기 {@code _has_session_bar}. */
    static boolean hasSessionBar(JsonNode quotes, String code, LocalDate d) {
        JsonNode codes = quotes.get("codes");
        JsonNode entry = codes == null || code == null ? null : codes.get(code);
        if (entry == null || !entry.isObject() || entry.path("isStale").asBoolean(false)) {
            return false;
        }
        String last = null;
        JsonNode bars = entry.get("bars");
        if (bars != null && bars.isArray()) {
            for (JsonNode bar : bars) {
                String date = text(bar.get("date"));
                if (date != null && (last == null || date.compareTo(last) > 0)) {
                    last = date;
                }
            }
        }
        return d.toString().equals(last);
    }

    /** 막는 게이트의 '번호 사유' 목록(없으면 빈 목록). */
    static List<String> blocking(List<Gate> gates) {
        return gates.stream().filter(Gate::blocks).map(g -> g.id() + " " + g.note()).toList();
    }

    // ------------------------------------------------------------------ 조각
    private static void miss(StringBuilder note, String label, List<String> codes) {
        if (codes.isEmpty()) {
            return;
        }
        note.append(" · ").append(label).append(' ').append(codes.size()).append('(')
                .append(String.join(",", codes.subList(0, Math.min(5, codes.size()))))
                .append(codes.size() > 5 ? ",…" : "").append(')');
    }

    private Snapshot snapshot(String dataset, String task) {
        Optional<Snapshot> found = reader.quietly(() -> reader.read(dataset, Datasets.MAX_AGE_DAILY, task));
        return found == null ? null : found.orElse(null);
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

    private static String text(JsonNode node) {
        return node == null || !node.isString() ? null : node.asString("");
    }
}
