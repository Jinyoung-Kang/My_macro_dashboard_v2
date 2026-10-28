package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrDecisionGates.Gate;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 🧪 한국 네 계좌의 출발(2단계 명세 §4-8·K28, 결정 d13 — C1c). 결정 작업이 한국 실행을 열고 <b>한국 계좌가 모두 시작 전일 때</b>
 * ({@link #pending}) 정기 결정 대신 이 출발을 냅니다.
 *
 * <pre>
 *  D = 그 실행의 달력으로 마감이 끝난 최근 세션(KrxCalendar.lastCompletedSession)
 *  D &lt; 출발일 S(dashboard.paper.kr.start-date)          → TOO_EARLY(기록 안 함)
 *  D 결정 시각(kr.decisionTimeKst 22:30) 전               → TOO_EARLY
 *  D 출발 기한(kr.decisionDeadlineKst 01:00 → D+1 01:00) 지남 → START_POSTPONED(D마다 한 번 기록 — 출발을 다음 KR 거래일로)
 *  그 세션 미룸 기록이 이미 있음(계획 실패 — 저장된 기록, 재기동해도 같음) → START_POSTPONED(다시 계획하지 않음)
 *  자료 게이트(§4-9 ②~⑥ — ①은 앞 주문이 없어 보지 않음) 미달 → START_WAITING(그 세션 기다림 한 줄 — 다음 주기에 다시)
 *  계좌마다 출발 계획(규칙 D1b · Claude E2b · 벤치마크 둘) → 계획이 실패한 계좌가 있으면 START_POSTPONED(아무 계좌에도 쓰지 않음 — 그 세션은
 *                                                         다시 계획하지 않음)
 *  → 계획한 계좌의 결정(INITIAL)·주문(NEXT_OPEN, 기준 거래일 D)·운용 전환·D 순자산 줄을 한 트랜잭션으로 → STARTED(기록)
 * </pre>
 *
 * <p><b>출발은 사후 체결이 아닙니다</b>(K28): 주문은 D+1 시가({@code NEXT_OPEN})에 체결되고(그 체결은 C2 장부), 수익률의 기준은 D 마감 순자산
 * = 초기 현금 전액(그래서 D 줄을 {@code prices_final=true}로 씀 — 보유가 없어 가격이 들지 않음). {@code paper_start_prices}·사후 체결·출발일 종가
 * 동결은 없습니다. 벤치마크 결정은 판단이 없어 가격을 보지 않고 목표 비중 주문만 냅니다(수량은 시가 체결 때) — 결정 행의
 * {@code prices_final}은 false(한국 결정의 가격은 금융위 확정 전 잠정가 — 결정 d9의 {@code pricesConfirmed} 뜻).
 *
 * <p><b>출발일과 '미룸'</b>: 출발은 S 22:30 결정 창에서 냅니다. 그 창에서 내지 못하면(게이트 미달이 기한까지 이어짐·계획 실패) 그 세션을
 * '미룸'으로 한 번 기록하고 다음 KR 거래일의 창에서 다시 냅니다 — 실제 출발일은 결정 행의 기준 거래일이고, 응답·작업 기록에 설정 출발일
 * ({@code configuredStartDate})과 {@code postponed}를 남깁니다(§4-8 '바뀐 출발일을 화면·기록에'). 출발 기한이 지난 창에서는 어떤 경우에도 내지
 * 않습니다(그 시가에 체결될 주문이 개장 뒤 정보를 보지 않게 — 기한 규칙의 시장 이동은 D1).
 *
 * <p><b>계좌 몫(갈고리)</b>: 계좌마다 {@link Leg}가 출발 계획을 냅니다 — 벤치마크 둘({@link #benchmarkLeg} — 069500 100% · 069500 60% + 153130 40%,
 * 리밸런싱 없음 K2), 규칙 계좌(D1b — {@link KrRuleBookService#startLeg}: 재선정과 같은 계산·입력 동결 K26, INITIAL·S+1 시가 주문), Claude 계좌(E2b —
 * {@link ClaudeBookService#krStartLeg}: 정기 결정과 같은 조립의 출발 패킷·한국 스키마·한국 검증기, 통과 주문은 S+1 시가 대기 주문 — 상한·재시도 1회 뒤
 * 오류·거절·형식 오류·기한은 실패). 계획은 트랜잭션 밖에서 모두 만든 뒤(Claude 호출이 장부 잠금을 붙잡지 않게) 한 번에 씁니다 — 한 계좌라도
 * 실패({@link Plan#failed})하면 어느 계좌에도 쓰지 않습니다(K28 '네 계좌는 함께 출발'). 과금되는 몫({@link Leg#charges} — Claude)은 다른 몫을 모두
 * 계획한 뒤 그것들이 하나도 실패하지 않았을 때만 부릅니다(규칙 몫이 실패한 밤에 Claude 호출을 쓰고 버리지 않게, 묶음 E 리뷰). 계좌 몫은 그 세션의 출발 기한을 받고(Claude 몫은 호출 대기
 * 한도를 기한 안으로 묶음), 쓰기 트랜잭션은 그 안에서 지금 시각이 기한 전인지 다시 봅니다 — 계획이 기한을 넘겨 끝났으면 어느 계좌에도 쓰지 않고
 * 미룹니다.
 *
 * <p><b>게이트와 입력은 한 읽기</b>(D1c, 결정 e5): 관측치 저장본·금융위 메타를 읽어 싼 게이트 ②④⑤⑥을 먼저 보고(미달이면 규칙 계좌 입력을 읽지
 * 않고 기다림 — 정기 결정과 같은 순서), 통과하면 규칙 계좌 입력(U·수급·DART — K26 동결)을 한 번 읽어({@link KrDecisionGates.Inputs}) 게이트
 * ②~⑥을 판정하고, 계좌 몫은 그 판정과 같은 입력을 받습니다({@link KrDecisionGates.Checked}) — 게이트 ③이 본
 * U·수급이 곧 규칙 계좌 INITIAL이 고르고 결정 행에 남기는 값입니다. U를 읽지 못함(D보다 이른 기준일의 U가 없음)은 ③ 미달이라 기다립니다(기한이
 * 지나면 미룸 — 예전에는 규칙 계좌 몫의 계획 실패로 바로 미룸).
 *
 * <p><b>'아직 없음' 몫</b>(D1b에서 정함): 계획한 계좌만 한 트랜잭션으로 출발하고 {@link Plan#notYet} 계좌(몫이 없는 시험 파이프라인의 계좌)는 시작 전
 * 그대로입니다. 출발 판정이 '모두 시작 전'이라 그 계좌는 <b>뒤따라 출발하지 않습니다</b>('한 계좌만 늦은 시작' 없음 — K28). 운영(E2b 뒤)에서는 네
 * 계좌 몫이 모두 있어 네 계좌가 함께 출발합니다. 출발 기록({@code books})에 그 계좌의 사유가 남습니다.
 *
 * <p><b>저장된 판정</b>(2단계 명세 §4-9 'E0', 사용자 결정 v3 — 재기동해도 판정이 같게): '그 세션은 이미 미룸'(계획 실패 뒤 같은 창에서 다시
 * 계획하지 않음)과 '미룸 기록은 세션마다 한 번'은 그 세션의 {@code kr.decision} 작업 기록({@value #START_POSTPONED} — 결정 작업이 남김,
 * {@link PaperStore#jobRunsFor})으로, 미룸 기록의 사유(그 창의 마지막 기다림 사유)는 그 세션 기다림 한 줄({@value #START_WAITING} — 결정 작업이
 * 남기고 이어지는 동안 늘림)로 정합니다. 이 프로세스가 미룬 세션의 기억({@link #postponedHere})은 미룸 기록을 쓰지 못했을 때(DB 오류)도 같은 창에서
 * 다시 계획하지 않게(E2의 Claude 호출을 되풀이하지 않게) 막는 방어선일 뿐입니다.
 */
final class KrStartPipeline {

    static final String STARTED = "STARTED";
    static final String START_WAITING = "START_WAITING";
    static final String START_POSTPONED = "START_POSTPONED";

    /**
     * 계좌 하나의 출발 계획.
     *
     * @param book     계좌 코드
     * @param decision 쓸 결정 행(번호 없음 — 쓸 때 매김). 계획이 없거나 실패면 null
     * @param orders   쓸 주문(결정 번호 없음 — 쓸 때 채움)
     * @param note     계획이 없을 때·실패했을 때의 사유
     * @param failed   실패 — 네 계좌 모두 쓰지 않고 출발을 미룸
     * @param calls    그 계획이 한 과금 호출의 기록(Claude 몫 — {@code {calls, attempts:[…], isEstimated}}), 호출이 없으면 null. 출발이 미뤄지거나
     *                 쓰기 오류로 끝나 결정 행이 없을 때 작업 기록에 남깁니다(2단계 명세 §4-10 — 시장별 횟수를 셀 수 있게, 묶음 E 리뷰)
     */
    record Plan(String book, Decision decision, List<Order> orders, String note, boolean failed,
                Map<String, Object> calls) {

        Plan {
            orders = orders == null ? List.of() : List.copyOf(orders);
            calls = calls == null ? null : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(calls));
        }

        static Plan of(String book, Decision decision, List<Order> orders) {
            return new Plan(book, Objects.requireNonNull(decision, "decision"), orders, null, false, null);
        }

        /** 이 묶음에서는 그 계좌의 출발 계획이 아직 없음 — 그 계좌는 시작 전 그대로(실패가 아님). */
        static Plan notYet(String book, String note) {
            return new Plan(book, null, List.of(), note, false, null);
        }

        /** 계획 실패(Claude 상한·오류 등, E2) — 어느 계좌에도 쓰지 않고 출발을 다음 KR 거래일로 미룸. */
        static Plan failed(String book, String note) {
            return new Plan(book, null, List.of(), note, true, null);
        }

        /** 같은 계획에 과금 호출 기록을 붙인 것(null이면 그대로). */
        Plan withCalls(Map<String, Object> calls) {
            return new Plan(book, decision, orders, note, failed, calls);
        }

        boolean planned() {
            return decision != null;
        }
    }

    /**
     * 계획을 다 만든 뒤 쓰기 트랜잭션이 예외로 끝남 — 원래 예외({@link #getCause})에 그 계획들의 과금 호출 기록을 실어 결정 작업이 오류 기록에 남기게
     * 합니다(결정 행이 없는 호출을 셀 수 있게, 2단계 명세 §4-10). 결정 작업은 원래 예외의 문구로 기록합니다.
     */
    static final class WriteFailed extends RuntimeException {

        private final transient Map<String, Object> calls;

        WriteFailed(RuntimeException cause, Map<String, Object> calls) {
            super(cause.getMessage(), cause);
            this.calls = calls;
        }

        /** 계좌 코드 → 그 계획의 과금 호출 기록(호출이 없으면 빈 맵). */
        Map<String, Object> calls() {
            return calls;
        }

        /** 원래 예외. */
        RuntimeException original() {
            return (RuntimeException) getCause();
        }
    }

    /** 계좌 하나의 출발 계획을 내는 몫(클래스 설명 '계좌 몫'). */
    interface Leg {

        String book();

        /**
         * @param run      그 실행(달력 한 벌·설정 판 하나)
         * @param session  출발 결정의 기준 거래일 D
         * @param deadline 그 세션의 출발 기한(기본 D+1 01:00 — K28). 계획(E2의 Claude 호출)은 이 순간 안에 끝내야 하고, 넘기면 실패로 돌려줘도
         *                 됩니다. 계획이 기한을 넘겨 끝나면 파이프라인이 쓰기 트랜잭션 안에서 다시 보고 어느 계좌에도 쓰지 않습니다(출발 미룸)
         * @param gates    그 실행의 자료 게이트 판정(결정 행에 남김)과 그 판정의 입력(규칙 계좌 몫이 같은 읽기로 계획 — 결정 e5)
         */
        Plan plan(MarketRun run, LocalDate session, Instant deadline, KrDecisionGates.Checked gates);

        /**
         * 계획이 과금되는 호출을 하는가(Claude 몫) — 그런 몫은 다른 몫을 모두 계획한 뒤, 그것들이 하나도 실패하지 않았을 때만 부릅니다(클래스 설명
         * '계좌 몫' — 어차피 미룰 출발에 호출을 쓰지 않게, 묶음 E 리뷰).
         */
        default boolean charges() {
            return false;
        }
    }

    /**
     * 출발 한 번의 결과.
     *
     * @param record  작업 기록을 남길 결과인가(STARTED·그 세션 기록이 아직 없는 START_POSTPONED)
     * @param waiting 그 세션 기다림 한 줄로 남길 결과인가(자료 게이트·계좌 미달의 START_WAITING — 결정 작업이 이어지는 기다림은 그 줄을 늘림)
     */
    record Result(String outcome, LocalDate session, String message, boolean record, Map<String, Object> detail,
                  List<Decision> decisions, boolean waiting) {

        Result {
            decisions = decisions == null ? List.of() : List.copyOf(decisions);
        }

        Result(String outcome, LocalDate session, String message, boolean record, Map<String, Object> detail,
               List<Decision> decisions) {
            this(outcome, session, message, record, detail, decisions, false);
        }
    }

    private final PaperStore store;
    /** 자료 게이트(§4-9 — {@link KrDecisionGates}). */
    private final KrDecisionGates decisionGates;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    /** 쓰기 트랜잭션 안에서 출발 기한을 다시 보는 시계(결정 작업의 시계 — 계획이 길어 기한을 넘기면 쓰지 않음). */
    private final Clock clock;
    private final List<Leg> legs;
    /**
     * 이 프로세스가 미룬 세션 — 판정은 저장된 미룸 기록(클래스 설명 '저장된 판정')이고, 이것은 그 기록을 쓰지 못했을 때도 같은 창에서 다시
     * 계획하지 않게 막는 방어선입니다(재기동하면 비지만 그때는 저장된 기록이 판정).
     */
    private final Set<LocalDate> postponedHere = ConcurrentHashMap.newKeySet();

    /** 규칙 계좌 몫 없이(시작 전 그대로 — 시험·벤치마크 몫 만들기) Claude 갈고리 + 벤치마크 둘, 시계는 시스템 시계. */
    KrStartPipeline(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                    PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, ledger, config, mapper, Clock.systemUTC(), null);
    }

    /** 계좌 몫을 바꿉니다(시험 — E2의 실패 계획 자리), 시계는 시스템 시계. null이면 이 묶음의 몫. */
    KrStartPipeline(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                    PaperConfig config, ObjectMapper mapper, List<Leg> legs) {
        this(store, reader, marketData, ledger, config, mapper, Clock.systemUTC(), legs);
    }

    /**
     * 시계와 계좌 몫을 정합니다(시험). null이면 규칙 계좌 몫 없이(시작 전 그대로) Claude 갈고리 + 벤치마크 둘. 게이트 ③의 읽기는 그 저장본으로 만든
     * 규칙 계좌 입력 읽기({@link KrRuleBookService#readInputs}).
     */
    KrStartPipeline(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                    PaperConfig config, ObjectMapper mapper, Clock clock, List<Leg> legs) {
        this(store, ledger, config, mapper, clock, legs,
                new KrDecisionGates(reader, new KrRuleBookService(store, reader, marketData, ledger, mapper, clock)), null,
                null);
    }

    /**
     * 결정 작업의 출발 — 그 작업의 시계·자료 게이트(결정 작업과 같은 판정 — {@link KrDecisionGates})와 규칙 계좌 몫({@link KrRuleBookService#startLeg}),
     * Claude 계좌 몫({@link ClaudeBookService#krStartLeg} — E2b) + 벤치마크 둘(클래스 설명).
     *
     * @param legs      계좌 몫을 통째로 바꿀 때(시험). null이면 규칙 몫 · Claude 몫 · 벤치마크 둘
     * @param rulesLeg  규칙 계좌 몫. null이면 규칙 계좌도 '아직 없음'(시작 전 그대로)
     * @param claudeLeg Claude 계좌 몫. null이면 '아직 없음'(시작 전 그대로 — 한국 결정 문맥이 없는 시험)
     */
    KrStartPipeline(PaperStore store, PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper, Clock clock,
                    List<Leg> legs, KrDecisionGates decisionGates, Leg rulesLeg, Leg claudeLeg) {
        this.store = store;
        this.decisionGates = Objects.requireNonNull(decisionGates, "decisionGates");
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = Objects.requireNonNull(clock, "clock");
        this.legs = legs != null ? List.copyOf(legs) : List.of(
                rulesLeg != null ? rulesLeg
                        : hook(PaperBooks.KR_RULES, "규칙 계좌의 출발 계획이 이 파이프라인에 없음 — 시작 전 그대로(시험)"),
                claudeLeg != null ? claudeLeg : hook(PaperBooks.KR_CLAUDE, CLAUDE_NOT_YET),
                benchmarkLeg(PaperBooks.KR_BENCH_K200),
                benchmarkLeg(PaperBooks.KR_BENCH_MIX));
    }

    /** Claude 계좌 몫이 없을 때의 자리(한국 결정 문맥이 없는 시험) — 출발 기록 {@code books.kr_claude}에 남는 사유. */
    static final String CLAUDE_NOT_YET = "Claude 계좌의 출발 계획(정기 결정과 같은 패킷 · INITIAL)이 이 파이프라인에 없음 — 시작 전 그대로이고 이 출발 "
            + "뒤 따라 출발하지 않음(네 계좌를 리셋해 다시 출발)";

    /**
     * 한국 출발이 남았나 — 한국 묶음의 실행이고, 한국 계좌가 있고 <b>모두 시작 전</b>(NOT_STARTED)입니다. 한 계좌라도 운용·일시정지면 출발한
     * 장부라 정기 결정으로 갑니다(리셋으로 한 계좌만 시작 전이 돼도 그 계좌만 다시 출발하지 않음 — 미국식 '한 계좌만 늦은 시작' 없음, K28).
     */
    boolean pending(PaperMarket market) {
        if (market.definition() != KrPaperMarket.INSTANCE) {
            return false;
        }
        List<Book> books = store.books(market.code());
        return !books.isEmpty() && books.stream().allMatch(b -> PaperBooks.NOT_STARTED.equals(b.status()));
    }

    /**
     * 출발 한 번(클래스 설명의 순서). 쓰는 일은 장부 잠금 안의 한 트랜잭션입니다 — 그 안에서 다시 '모두 시작 전'인지 봅니다.
     *
     * @param gaveUp 그 세션에 출발 오류가 상한만큼 났음(결정 작업이 셈) — 기한 전이면 기다리고, 기한이 지나면 미룸으로
     */
    Result run(MarketRun run, Instant now, boolean gaveUp) {
        LocalDate start = Objects.requireNonNull(config.krStartDate(), "한국 출발일");
        TradingCalendar calendar = run.calendar();
        LocalDate d = calendar.lastCompletedSession(now);
        if (d.isBefore(start)) {
            return quiet(PaperDecisionJob.TOO_EARLY, d, "한국 출발일 " + start + " 전 — 출발 결정은 그날 결정 시각에 냅니다");
        }
        KrPaperMarket.DecisionWindow window = KrPaperMarket.decisionWindow(run, run.settingsBody(), d);
        if (now.isBefore(window.opens())) {
            return quiet(PaperDecisionJob.TOO_EARLY, d, "출발 결정 시각 " + Kst.stamp(window.opens()) + " 전");
        }
        List<PaperStore.JobRun> records = store.jobRunsFor(run.jobName(PaperDecisionJob.JOB), d);
        if (!now.isBefore(window.deadline())) {
            return postponed(run, d, start, window, lastWaitReason(records), records);
        }
        if (postponedHere.contains(d) || postponedRecord(records) != null) {
            // 그 세션은 이미 미룸(계획 실패 — 저장된 기록) — 같은 창에서 다시 계획하지 않습니다(재기동한 뒤에도, Claude를 다시 부르지 않게,
            // K28 '다음 KR 거래일로').
            return postponed(run, d, start, window, "그 세션은 이미 미뤘음", records);
        }
        if (gaveUp) {
            return quiet(START_WAITING, d, d + " 출발 오류가 상한만큼 나 기한(" + Kst.stamp(window.deadline())
                    + ")까지 더 시도하지 않습니다 — 기한이 지나면 다음 KR 거래일로 미룹니다");
        }
        // 싼 게이트 ②④⑤⑥(관측치 저장본·금융위 메타·달력)을 먼저 — 미달이면 규칙 계좌 입력(U·20일 수급·DART)을 읽지 않고 기다림(정기 결정과
        // 같은 순서, 10분마다 큰 읽기를 되풀이하지 않게). 통과하면 게이트 ③과 계좌 몫이 같은 읽기(클래스 설명 — 결정 e5), 읽은 순간 = 이 실행의 지금.
        KrDecisionGates.Inputs session = decisionGates.readSession(run, d);
        List<Gate> before = decisionGates.beforeLedger(run, session);
        String waiting = waitingReason(run, before);
        KrDecisionGates.Inputs inputs = null;
        List<Gate> gates = null;
        if (waiting == null) {
            inputs = decisionGates.withRules(run, session, now);
            gates = decisionGates.data(run, inputs);
            waiting = waitingReason(run, gates);
        }
        if (waiting != null) {
            // 그 세션 기다림 한 줄(결정 작업이 남기고, 이어지는 기다림은 그 줄을 늘림) — 기한 뒤 미룸 기록의 사유가 재기동해도 같게.
            Map<String, Object> detail = detail(d, start, window, gates != null ? gates : before);
            detail.put("reason", waiting);
            return new Result(START_WAITING, d, waiting + " — 기한 " + Kst.stamp(window.deadline()) + "까지 다음 주기에 다시 봅니다",
                    false, detail, List.of(), true);
        }

        // 계획은 트랜잭션 밖에서 모두 만든 뒤 한 번에(클래스 설명) — 한 계좌라도 실패하면 어느 계좌에도 쓰지 않습니다. 과금되는 몫(Claude)은 다른
        // 몫을 모두 계획한 뒤 그것들이 실패하지 않았을 때만 부릅니다(어차피 미룰 출발에 호출을 쓰지 않게). 계획의 자리는 몫의 순서 그대로(쓰는 순서).
        KrDecisionGates.Checked checked = new KrDecisionGates.Checked(gates, inputs);
        Plan[] planned = new Plan[legs.size()];
        for (int i = 0; i < legs.size(); i++) {
            if (!legs.get(i).charges()) {
                planned[i] = legs.get(i).plan(run, d, window.deadline(), checked);
            }
        }
        boolean cheapFailed = java.util.Arrays.stream(planned).anyMatch(p -> p != null && p.failed());
        List<String> skipped = new ArrayList<>();
        for (int i = 0; i < legs.size(); i++) {
            if (legs.get(i).charges()) {
                if (cheapFailed) {
                    skipped.add(legs.get(i).book());
                } else {
                    planned[i] = legs.get(i).plan(run, d, window.deadline(), checked);
                }
            }
        }
        List<Plan> plans = java.util.Arrays.stream(planned).filter(Objects::nonNull).toList();
        Map<String, Object> calls = calls(plans);
        List<Plan> failed = plans.stream().filter(Plan::failed).toList();
        if (!failed.isEmpty()) {
            String reason = String.join(" · ", failed.stream().map(p -> p.book() + ": " + p.note()).toList())
                    + (skipped.isEmpty() ? "" : " · 다른 계좌의 출발 계획이 실패해 부르지 않음: " + String.join("·", skipped));
            return withCalls(postponed(run, d, start, window, "출발 계획 실패 — " + reason, records), calls);
        }
        if (plans.stream().noneMatch(Plan::planned)) {
            return quiet(START_WAITING, d, "출발 계획을 낸 계좌가 없습니다 — " + String.join(" · ",
                    plans.stream().map(p -> p.book() + ": " + p.note()).toList()));
        }
        Map<String, Object> books = new LinkedHashMap<>();
        // 기한은 쓰기 트랜잭션 안에서 다시 봅니다 — 계획(E2의 Claude 호출)이 길어 기한을 넘겼으면 어느 계좌에도 쓰지 않습니다(K28 '기한으로 실패하면
        // 어느 계좌에도 쓰지 않음', §4-8 '기한이 지난 창에서는 어떤 경우에도 출발을 내지 않는다').
        java.util.concurrent.atomic.AtomicReference<Instant> late = new java.util.concurrent.atomic.AtomicReference<>();
        List<Decision> written;
        try {
            written = ledger.exclusively(() -> store.atomically(() -> {
                Instant at = clock.instant();
                if (!at.isBefore(window.deadline())) {
                    late.set(at);
                    return null;
                }
                return write(run, d, plans, books);
            }));
        } catch (RuntimeException e) {
            // 쓰지 못한 계획의 과금 호출을 오류 기록에 남기게 실어 보냅니다(결정 행이 없음 — §4-10).
            throw new WriteFailed(e, calls);
        }
        if (late.get() != null) {
            return withCalls(postponed(run, d, start, window, "출발 계획이 기한을 넘겨 끝남(" + Kst.stamp(late.get())
                    + ") — 어느 계좌에도 쓰지 않음", records), calls);
        }
        if (written == null) {
            return quiet(PaperDecisionJob.ALREADY_DECIDED, d, "다른 실행이 이미 한국 계좌를 출발시켰습니다");
        }
        postponedHere.remove(d);
        Map<String, Object> detail = detail(d, start, window, gates);
        detail.put("books", books);
        return new Result(STARTED, d, d + " 한국 출발 — " + String.join(" · ", written.stream().map(Decision::bookCode)
                .toList()) + "(다음 거래일 시가)", true, detail, written);
    }

    /** 계획한 계좌의 결정·주문·운용 전환·D 순자산 줄(한 트랜잭션 안). 그사이 다른 실행이 출발시켰으면 null. */
    private List<Decision> write(MarketRun run, LocalDate d, List<Plan> plans, Map<String, Object> books) {
        if (!pending(run)) {
            return null;
        }
        TradingCalendar calendar = run.calendar();
        LocalDate expires = calendar.addTradingDays(d, RuleBookService.ORDER_EXPIRY_TRADING_DAYS);
        List<Decision> out = new ArrayList<>();
        for (Plan plan : plans) {
            if (!plan.planned()) {
                books.put(plan.book(), plan.note());
                continue;
            }
            Book book = store.book(plan.book()).orElseThrow(() -> new IllegalStateException(
                    "한국 계좌가 없습니다: " + plan.book() + " — 한국 초기화를 다시 누르세요"));
            long id = store.insertDecisionIfAbsent(plan.decision()).orElseThrow(() -> new IllegalStateException(
                    plan.book() + "에 " + d + " 출발 결정이 이미 있습니다"));
            List<Long> orderIds = new ArrayList<>();
            for (Order o : plan.orders()) {
                // 만료는 대기 주문만(거절 주문 — Claude 몫의 REJECTED — 은 만료가 없음, 결정 파이프라인과 같음).
                boolean pending = PaperBooks.ORDER_PENDING.equals(o.status());
                orderIds.add(store.insertOrder(new Order(0, o.bookCode(), id, o.ticker(), o.side(), o.qty(),
                        o.targetWeightPct(), o.sellFraction(), o.timing(), o.source(), o.status(), o.rejectReason(),
                        o.reason(), d, o.createdAt(), pending ? expires : null, null)));
            }
            store.updateBookStatus(book.code(), PaperBooks.ACTIVE);
            store.updateBookStartedOn(book.code(), d);
            BookState state = store.state(book.code()).orElseThrow(() -> new IllegalStateException(
                    "한국 계좌 상태가 없습니다: " + book.code() + " — 한국 초기화를 다시 누르세요"));
            // 출발 기준 = D 마감 순자산(전액 현금 — 보유가 없어 가격이 들지 않으므로 확정, K28).
            store.upsertState(new BookState(book.code(), state.cash(), state.cash(), 0, 0, state.lastObservedAt(),
                    state.lastProcessedCollectedAt(), d, null));
            store.upsertNav(new NavRow(book.code(), d, state.cash(), state.cash(), 0, 0, true));
            Decision decision = store.decision(id).orElseThrow();
            out.add(decision);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("decisionId", id);
            view.put("orders", orderIds);
            books.put(book.code(), view);
        }
        return out;
    }

    /** 게이트·계좌·설정 판 중 막는 것이 있으면 그 사유(아니면 null). */
    private String waitingReason(MarketRun run, List<Gate> gates) {
        if (run.settingsVersion() == null) {
            return "설정 행이 없습니다 — 한국 초기화를 다시 누르세요";
        }
        List<String> missing = new ArrayList<>();
        for (PaperBooks.Definition definition : run.books()) {
            if (store.book(definition.code()).isEmpty()) {
                missing.add(definition.code());
            }
        }
        if (!missing.isEmpty()) {
            return "한국 계좌 " + String.join("·", missing) + "가 없습니다 — 한국 초기화를 다시 누르세요";
        }
        List<String> blocking = KrDecisionGates.blocking(gates);
        return blocking.isEmpty() ? null : "자료 게이트 미달: " + String.join(" · ", blocking);
    }

    // ------------------------------------------------------------------ 계좌 몫
    /** 출발 계획이 아직 없는 계좌의 갈고리(D1·E2가 채움). */
    private static Leg hook(String book, String note) {
        return new Leg() {
            @Override
            public String book() {
                return book;
            }

            @Override
            public Plan plan(MarketRun run, LocalDate session, Instant deadline, KrDecisionGates.Checked gates) {
                return Plan.notYet(book, note);
            }
        };
    }

    /**
     * 벤치마크 계좌의 출발 계획 — 정의의 비중대로 목표 비중 매수 주문(NEXT_OPEN, 출처 BENCHMARK, 기준 거래일 D). 판단이 없어 가격을 보지
     * 않습니다(수량은 D+1 시가 체결 때 — C2). 결정 행은 INITIAL·OK, 목표 노출 = 비중 합, 그 실행의 설정 판.
     */
    Leg benchmarkLeg(String code) {
        PaperBooks.Definition definition = PaperBooks.KR.stream().filter(d -> d.code().equals(code)).findFirst()
                .filter(PaperBooks.Definition::benchmark)
                .orElseThrow(() -> new IllegalArgumentException("한국 벤치마크 계좌가 아닙니다: " + code));
        return new Leg() {
            @Override
            public String book() {
                return code;
            }

            @Override
            public Plan plan(MarketRun run, LocalDate session, Instant deadline, KrDecisionGates.Checked gates) {
                double exposure = definition.weights().values().stream().mapToDouble(Double::doubleValue).sum();
                Map<String, Object> response = new LinkedHashMap<>();
                response.put("summary", definition.label() + " 출발 — " + weightsText(definition) + "를 " + session
                        + " 다음 거래일 시가(NEXT_OPEN)에 매수");
                response.put("book", code);
                response.put("kind", RuleBookService.INITIAL);
                response.put("asOfTradingDate", session.toString());
                response.put("configuredStartDate", String.valueOf(config.krStartDate()));
                response.put("postponed", !session.equals(config.krStartDate()));
                response.put("timing", PaperBooks.NEXT_OPEN);
                response.put("weights", definition.weights());
                response.put("rebalancing", "없음 — 출발 뒤 그대로 보유(K2)");
                response.put("gates", gates.views());
                response.put("note", "벤치마크 — 판단 없음. 목표 비중 주문이라 가격을 보지 않고 수량은 시가 체결 때 정합니다"
                        + "(사후 체결·출발일 종가 동결 없음, K28)");
                Decision decision = new Decision(0, code, session, RuleBookService.INITIAL, null, "OK", null, null,
                        Objects.requireNonNull(run.settingsVersion(), "설정 판"), null, exposure, null, null, null,
                        mapper.valueToTree(response), null, null, null, false, null, 0);
                List<Order> orders = new ArrayList<>();
                for (Map.Entry<String, Double> leg : definition.weights().entrySet()) {
                    Map<String, Object> reason = new LinkedHashMap<>();
                    reason.put("benchmark", true);
                    reason.put("start", true);
                    reason.put("weightPct", leg.getValue());
                    reason.put("note", "벤치마크 " + definition.label() + " — 출발 주문(다음 거래일 시가)");
                    orders.add(new Order(0, code, null, leg.getKey(), PaperBooks.BUY, null, leg.getValue(), null,
                            PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_BENCHMARK, PaperBooks.ORDER_PENDING, null,
                            mapper.valueToTree(reason), session, null, null, null));
                }
                return Plan.of(code, decision, orders);
            }
        };
    }

    private static String weightsText(PaperBooks.Definition definition) {
        List<String> parts = new ArrayList<>();
        definition.weights().forEach((ticker, pct) -> parts.add(ticker + " "
                + java.math.BigDecimal.valueOf(pct).stripTrailingZeros().toPlainString() + "%"));
        return String.join(" · ", parts);
    }

    // ------------------------------------------------------------------ 결과
    /**
     * 그 세션을 미룸 — 작업 기록은 그 세션 미룸 기록이 아직 없을 때만 남깁니다(저장된 기록이 '세션마다 한 번'의 판정이라 재기동해도 다시 남기지
     * 않고, 기록을 쓰지 못했으면 다음 주기에 다시 남김).
     *
     * @param records 그 세션의 {@code kr.decision} 작업 기록(최근 순 — 이 실행이 읽은 것)
     */
    private Result postponed(MarketRun run, LocalDate d, LocalDate start, KrPaperMarket.DecisionWindow window,
                             String reason, List<PaperStore.JobRun> records) {
        LocalDate next = run.calendar().nextTradingDay(d);
        String message = d + " 출발 기한(" + Kst.stamp(window.deadline()) + ")까지 출발하지 못해 다음 KR 거래일 " + next
                + "로 미룹니다 — " + reason;
        boolean first = postponedRecord(records) == null;
        postponedHere.add(d);
        Map<String, Object> detail = detail(d, start, window, null);
        detail.put("postponedTo", next.toString());
        detail.put("reason", reason);
        return new Result(START_POSTPONED, d, message, first, detail, List.of());
    }

    /** 계좌 코드 → 그 계획의 과금 호출 기록(호출이 있던 계획만, 몫의 순서). */
    private static Map<String, Object> calls(List<Plan> plans) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Plan plan : plans) {
            if (plan.calls() != null) {
                out.put(plan.book(), plan.calls());
            }
        }
        return out;
    }

    /** 미룸 결과의 작업 기록에 과금 호출 기록을 더함(없으면 그대로) — 결정 행이 없는 호출을 그 기록에서 셈(§4-10). */
    private static Result withCalls(Result result, Map<String, Object> calls) {
        if (!calls.isEmpty()) {
            Map<String, Object> detail = new LinkedHashMap<>(result.detail());
            detail.put("calls", calls);
            return new Result(result.outcome(), result.session(), result.message(), result.record(), detail,
                    result.decisions(), result.waiting());
        }
        return result;
    }

    /** 그 세션의 미룸 기록(없으면 null). */
    private static PaperStore.JobRun postponedRecord(List<PaperStore.JobRun> records) {
        return records.stream().filter(r -> START_POSTPONED.equals(r.outcome())).findFirst().orElse(null);
    }

    /** 그 세션 기다림 한 줄의 마지막 사유 — 없으면(그 창에서 기다린 기록 없음 — 그 밤 첫 실행이 기한 뒤 등) 그렇다고. */
    private static String lastWaitReason(List<PaperStore.JobRun> records) {
        return records.stream().filter(r -> START_WAITING.equals(r.outcome()))
                .map(r -> com.macrodash.support.Json.asText(r.detail(), "reason")).filter(Objects::nonNull).findFirst()
                .orElse("그 창에서 출발 결정을 내지 못함");
    }

    private Map<String, Object> detail(LocalDate d, LocalDate start, KrPaperMarket.DecisionWindow window,
                                       List<Gate> gates) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("start", true);
        out.put("tradingDate", d.toString());
        out.put("configuredStartDate", start.toString());
        out.put("postponed", !d.equals(start));
        out.put("decisionAtKst", Kst.stamp(window.opens()));
        out.put("deadlineKst", Kst.stamp(window.deadline()));
        if (gates != null) {
            out.put("gates", gates.stream().map(Gate::view).toList());
        }
        return out;
    }

    private static Result quiet(String outcome, LocalDate d, String message) {
        return new Result(outcome, d, message, false, Map.of(), List.of());
    }
}
