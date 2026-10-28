package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.GateIndicator;
import com.macrodash.feature.paper.PaperLedgerService.Outcome;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.GateRow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 🧪 하루 한 번의 결정 작업(설계 §6-2) — 10분마다 돌며, 미국 세션이 끝난 다음 날 아침(KST)에 그 거래일의 결정을 냅니다.
 *
 * <pre>
 *  그 시장 달력이 앞 창(직전 세션 ~ 10거래일)의 해를 모름 → NO_CALENDAR(그 시장·KST 날짜·빠진 해마다 한 번 기록 — 명세 K35)
 *  d = 마감이 끝난 가장 최근 세션
 *  d 다음 날 decisionTimeKst(07:30) 전           → TOO_EARLY(기록 안 함)
 *  그날 할 일(게이트 지표·규칙 책 결정·Claude 책 결정)이 다 됨 → ALREADY_DECIDED(기록 안 함)
 *  기한이 지났고 그 시장 규칙이 '결정하지 않음'(한국)  → PAST_DEADLINE(시장·세션마다 한 번 기록 — 저장된 기록으로 셈, Claude를 부르지 않음)
 *  관측치가 d의 확정 종가가 아님 && decisionDeadlineKst(12:00) 전 → PRICES_NOT_FINAL(기록 안 함 — 다음 주기에 다시)
 *    (한국 묶음은 이 자리가 자료 게이트 ①~⑥ — 미달이면 DATA_NOT_READY·그 세션 기다림 한 줄, 클래스 설명 '한국 결정 게이트')
 *  관측치 처리 → (확정이 아니면) d의 미확정 순자산 줄 → 게이트 지표 → 재선정일이면 선정 → 규칙 책 결정
 *  → Claude 책 결정(운용 중일 때만) → 작업 기록     (두 책 모두 출발일 뒤 거래일만 — 출발일은 초기 결정이 그날 결정)
 * </pre>
 *
 * <p>확정 종가 = 관측치의 다수 티커 봉 날짜가 d이고 마감 + 15분 뒤에 수집함. 기한을 넘기면 확정 종가 없이 진행하고 결정·순자산
 * 줄에 {@code prices_final = false}를 남깁니다(그날 결정을 아예 건너뛰지 않게 — 늦은 확정 관측치가 순자산 줄을 바로잡음). 기한 뒤에 할
 * 일은 시장 규칙입니다({@link PaperMarket#afterDeadline} — 미국은 이렇게 진행, 한국은 그 세션을 결정하지 않음: {@value #PAST_DEADLINE}).
 * 시장 묶음에서는 이 판정이 둘로 갈립니다(결정 d9, C2a): 기다림·미확정 순자산 줄은 'd의 종가가 나왔나'({@link #closesFor} —
 * {@link PaperMarket#closeAvailable}), 결정 행·패킷·작업 기록의 {@code pricesFinal}은 'd의 가격이 확정인가'({@link #confirmedFor} —
 * {@link PaperMarket#pricesConfirmed}). 미국은 둘이 늘 같습니다.
 * 결정·게이트는 거래일마다 한 건이라(유일 제약) 같은 날 여러 번 돌아도 한 번입니다.
 *
 * <p>재선정일(공시 기한 다음 거래일, R5)이면 먼저 그날 기준으로 기관을 다시 선정하고 규칙 책은 REBALANCE(매수 포함), 그 외 날은
 * SCHEDULED(매도 신호와 남는 현금 SHY만)입니다. <b>재선정일을 놓친 경우</b>(그날 결정 창 동안 작업이 한 번도 끝나지 못함 — 맥 꺼짐·오류 계속):
 * 규칙 책이 그 분기 재선정일 r 전에 시작했는데 <b>r 선정으로 낸</b> 매수 결정(REBALANCE·INITIAL, {@code selection_as_of = r})이
 * 없으면, 다음 결정 날에 r 기준으로 선정하고({@code select(r)} — d가 아니라 r이라 언제 따라잡아도 같은 선정) 그날 REBALANCE를
 * 냅니다. 그러지 않으면 그 분기 매수가 통째로 사라져 다음 재선정일까지 지난 분기 신호로 갑니다. r에 선정을 건너뛴 경우(수집 중·후보
 * 목록 없음 — {@link PaperSelectionService#select})도 같습니다: 그날 REBALANCE는 지난 선정이라 매수 없이 끝나므로 세지 않고, 다음
 * 결정 날마다 {@code select(r)}를 다시 불러 수집이 끝난 뒤 그 분기 매수를 냅니다. 시작 전 책은 결정을 내지 않고, 초기화 전(책이
 * 없음)이면 아무것도 하지 않습니다.
 *
 * <p><b>Claude 책</b>(단계 3a)은 규칙 책 다음에, 운용 중(ACTIVE)이고 그 거래일이 출발일 뒤일 때만 SCHEDULED 결정을 냅니다(출발일은
 * 초기 결정이 그날 결정입니다 — 같은 자료로 Claude를 한 번 더 부르지 않게). 그날 결정이 API 오류이고 아직 재시도하지 않았으면
 * "할 일이 남음"으로 보아 다음 주기에 한 번 더 부릅니다({@link ClaudeBookService#decide} — 같은 행, 명세 C7). Claude 호출은 몇 분
 * 걸릴 수 있고, 그동안 이 작업의 잠금을 쥡니다(같은 거래일 결정을 동시에 만들지 않게). <b>정기 실행은 그 잠금을 기다리지 않습니다</b>
 * — 수동 결정이 쥐고 있으면 {@value #BUSY}로 그 주기를 건너뜁니다(스케줄러 스레드를 몇 분씩 붙잡지 않게). 리스크 점검(5분 스탑)·알림
 * 같은 다른 정기 작업이 이 작업의 긴 호출 뒤에 줄 서지 않는 것은 스케줄러 스레드가 여럿이라서입니다({@code
 * spring.task.scheduling.pool.size}, application.yml — Spring Boot 기본은 1개). 리스크 점검은 장부 잠금만 쓰고, Claude 호출은 장부
 * 잠금 밖이라 그 잠금도 기다리지 않습니다. 수동 실행은 잠금을 기다립니다(누른 결정을 버리지 않게).
 *
 * <p><b>두 책은 따로</b>: 선정·규칙 책 결정과 Claude 책 결정은 오류를 따로 잡습니다 — 대조군(규칙 책)의 자료 오류가 실험군의 그날
 * 결정을 지우지 않게(반대도). 한쪽이라도 오류면 그 실행은 ERROR로 기록하고 그날 오류 횟수를 올리며, 다음 주기에는 남은 쪽만 다시
 * 합니다. 규칙 책의 그날 정기 결정이 이미 있으면 선정·결정을 다시 하지 않고 그 결정을 씁니다(Claude 쪽 일로 다시 돌 때 규칙 책
 * 결정이 하루 두 건이 되지 않게 — {@code decideRules}). 관측치 처리·순자산 줄·게이트 지표가 실패하면 두 책 모두 결정하지 않습니다.
 *
 * <p>저장본은 {@link StoreReader#quietly}로만 읽습니다(정기 작업이 수집을 깨우지 않게). 같은 거래일에 한 책 쪽 오류가
 * {@value #MAX_ATTEMPTS}번 나면 그날 그 책은 더 시도하지 않습니다 — 10분마다 같은 오류가 작업 기록 200건을 밀어내지 않게. 횟수는 책마다
 * 셉니다(관측치 처리·순자산 줄·게이트 지표의 오류는 두 책 모두 결정하지 못하므로 둘 다에). 남은 일이 있는 책이 모두 포기했으면
 * {@value #GAVE_UP}입니다. 수동 실행은 <b>그 책의</b> 횟수만 지웁니다 — 규칙 책 수동 결정이 Claude 책의 포기를 풀면 Claude 쪽 예외가
 * 되풀이될 때 유료 호출을 다시 부르게 됩니다. 재기동하면 처음부터 셉니다.
 * 정기 실행은 {@code dashboard.paper.enabled=false}면 아무것도 하지 않고, 수동 실행({@link #runNow})은 설정과 상관없이 돕니다.
 *
 * <p><b>시장마다 따로</b>입니다(2단계 명세 §9 A6). 정기 실행은 {@link PaperMarkets#all}을 차례로 돌고(미국 → 한국 — 한국은 출발일·한국
 * 계좌가 갖춰질 때까지 {@value #DORMANT}로 건너뜀, {@link PaperMarket#dormantReason}), 시장마다 세션
 * d(그 시장 달력)·결정 시각과 기한(그 시장의 설정 키 — 미국은 접두어 없이 지금 키, 없으면 시장 기본값 — 을 그 시장의 '세션 → 결정
 * 순간' 식과 기한 규칙 {@link PaperMarket#deadlineInstant}로 — 미국은 기한이 결정보다 앞이면 결정 시각, 한국은 기한 ≤ 결정이면 다음 날)·
 * 관측치와 확정 종가 판정·장부 처리·미확정 순자산 줄·책·오류 횟수(시장 × 거래일 × 책)·작업 기록 이름(시장 접두어 +
 * {@value #JOB})을 그 시장 것으로 씁니다. 게이트 지표·13F 재선정·규칙 책 결정({@link RuleBookService})은 미국 전용 단계라 미국 묶음에서만
 * 돌고, 한국 묶음의 규칙 계좌는 한국 수급 규칙({@link KrRuleBookService} — 재선정일·따라잡기 K33·입력 동결 K26, 2단계 D1b)이 그 실행으로
 * 냅니다(다른 시장 묶음 — 시험용 — 은 규칙 계좌 결정이 없음). Claude 책 결정은 그 시장 문맥으로 냅니다({@link ClaudeBookService}). 잠금은 시장과
 * 상관없이 하나입니다. 시장을 받지 않는 옛 시그니처(한 번 실행·수동 실행·시각 설정)는 미국 판입니다.
 *
 * <p><b>한국 출발</b>(2단계 명세 §4-8·K28, C1c): 한국 실행에서 한국 계좌가 모두 시작 전이면 정기 결정 대신 {@link KrStartPipeline}이
 * 출발을 냅니다 — 출발일 S(배포 설정) 이후 세션 D의 결정 창(22:30 ~ D+1 01:00) 안에서 자료 게이트(§4-9 ②~⑥)를 통과하면 계좌마다
 * 출발 계획(규칙 계좌 INITIAL — 재선정과 같은 계산 · 벤치마크 둘, Claude E2는 갈고리)을 한 트랜잭션으로 씁니다({@value #STARTED}). 게이트 미달은 {@value #START_WAITING}
 * (그 세션 기다림 한 줄 — {@link #recordWait}), 기한이 지나면 {@value #START_POSTPONED}(그 세션에 한 번 기록 — 다음 KR 거래일 창에서 다시)입니다.
 * 미룸 여부·기록 한 번·미룸 사유는 저장된 그 세션 작업 기록으로 정해 재기동해도 같습니다(2단계 명세 §4-9 'E0', 사용자 결정 v3).
 *
 * <p><b>한국 결정 게이트</b>(2단계 명세 §4-9·§5, D1c — {@link KrDecisionGates}): 한국 묶음의 정기 결정은 '그날 종가 관측치' 기다림 대신 자료
 * 게이트 ①~⑥을 모두 통과해야 냅니다. ②④⑤⑥(관측치 저장본의 D 봉 90%·금융위 기준일·069500 D 봉·거래일)이 미달이면 장부를 처리하지 않고,
 * 통과하면 장부를 처리한 뒤 규칙 계좌 입력을 한 번 읽어(K26 동결과 같은 읽기 — 그 결정이 그대로 씀) ③(U 90%의 D 수급 저녁 판)을 보고, 결정할
 * 계좌마다 ①(그 계좌 장부가 그 실행의 관측치를 처리했고 기준일 &lt; D 대기 주문 없음 — 체결 조건 ⑤는 보지 않고, 장부가 그 관측치로 체결할 수
 * 없는 주문(기준일 뒤 관측 봉 없음·미처리 기업행위·장부가 그 관측치에서 그날 보류한 주문 — 사용자 결정 u2)은 기다리지 않음)을 봅니다. 미달은
 * {@value #DATA_NOT_READY}(다음 주기에 다시 — 그 세션 기다림 한 줄로 기록하고 이어지는 동안 그 줄을 늘림, {@link #recordWait})이고, 판정은 결정 행
 * 응답과 작업 기록의 {@code gates}에 남습니다. 기한(D+1 01:00)이 지나면 규칙 계좌는 그 세션 NO_TRADE 행(그 세션 기한 전 마지막 게이트 판정과 사유
 * — ⑤ 미달이면 '069500 D 봉 없음(휴장 또는 지연)', 아니면 '기한 지남'; 그 판정은 작업 기록의 {@value #RULES_GATES} 칸에서 다시 읽어 재기동해도
 * 같고(2단계 명세 §4-9 'E0', 사용자 결정 v3), 그 기록이 없으면 기한 뒤 첫 실행의 판정에 '기한 뒤 판정' 표시), Claude는 부르지 않습니다. 자정을
 * 넘긴 실행도 세션은
 * {@code lastCompletedSession}이라 D 그대로입니다. 수동 결정도 결정 창과 게이트 안에서만 받습니다({@link #runNow(PaperMarket, String)}).
 *
 * <p><b>실행 하나 = 달력 한 벌·설정 판 하나</b>(C1a): 정기·수동 실행은 시작할 때 그 시장의 실행 문맥({@link MarketRun})을 한 번 열어
 * ({@link PaperMarkets#open}) 세션 d·결정 시각과 기한·관측치 확정 판정·장부 처리·미확정 순자산 줄·Claude 결정에 그대로 넘깁니다 —
 * 그 사이 설정 탭에서 새 판을 저장해도 Claude 결정 행의 {@code settings_version}·패킷·시스템 프롬프트는 이 실행이 읽은 판이고,
 * 한국 달력(공휴일 저장본·설정 판으로 만듦, C1c)도 실행마다 한 벌입니다.
 */
@Service
public class PaperDecisionJob {

    private static final Logger log = LoggerFactory.getLogger(PaperDecisionJob.class);

    /** 작업 기록의 이름(paper_job_runs.job). */
    static final String JOB = "decision";
    static final LocalTime DEFAULT_DECISION_TIME = LocalTime.of(7, 30);
    static final LocalTime DEFAULT_DEADLINE = LocalTime.of(12, 0);
    /** 같은 거래일에 오류가 이만큼 나면 그날은 더 시도하지 않습니다(클래스 설명). */
    static final int MAX_ATTEMPTS = 3;

    public static final String NOT_READY = "NOT_READY";
    public static final String NOT_INITIALIZED = "NOT_INITIALIZED";
    public static final String TOO_EARLY = "TOO_EARLY";
    public static final String ALREADY_DECIDED = "ALREADY_DECIDED";
    public static final String PRICES_NOT_FINAL = "PRICES_NOT_FINAL";
    public static final String GAVE_UP = "GAVE_UP";
    public static final String DECIDED = "DECIDED";
    public static final String ERROR = "ERROR";
    /** 수동 실행이 작업 잠금을 쥐고 있어 정기 실행이 그 주기를 건너뜀(기록 안 함 — 클래스 설명). */
    public static final String BUSY = "BUSY";
    /** 그 시장 달력이 앞 창의 해를 모름 — 그 시장 결정을 내지 않음(명세 K35, {@link CalendarGaps}). */
    public static final String NO_CALENDAR = CalendarGaps.NO_CALENDAR;
    /** 출발일·계좌가 갖춰지지 않은 시장 — 실행을 열지 않음(기록 안 함, {@link PaperMarket#dormantReason}). */
    public static final String DORMANT = "DORMANT";
    /** 한국 출발을 냄(기록 — {@link KrStartPipeline}). */
    public static final String STARTED = KrStartPipeline.STARTED;
    /** 한국 출발의 자료 게이트 미달 — 다음 주기에 다시(그 세션 기다림 한 줄 — {@link #recordWait}). */
    public static final String START_WAITING = KrStartPipeline.START_WAITING;
    /** 한국 출발 기한이 지나 다음 KR 거래일로 미룸(그 세션에 한 번 기록 — 저장된 기록으로 셈, 재기동해도 한 번). */
    public static final String START_POSTPONED = KrStartPipeline.START_POSTPONED;
    /**
     * 결정 기한이 지나 그 세션을 결정하지 않음(그 시장 규칙 {@link PaperMarket.AfterDeadline#NO_TRADE} — 한국). 시장·세션마다 한 번
     * 기록합니다(그 세션의 저장된 작업 기록으로 셈 — 재기동해도 한 번, 쓰지 못했으면 다음 주기에 다시).
     */
    public static final String PAST_DEADLINE = "PAST_DEADLINE";
    /**
     * 한국 결정 자료 게이트(§4-9 ①~⑥) 미달 — 결정하지 않고 다음 주기에 다시(그 세션 기다림 한 줄 — {@link KrDecisionGates}·{@link #recordWait}). 미국의
     * {@value #PRICES_NOT_FINAL}(그날 종가 관측치 기다림) 자리입니다.
     */
    public static final String DATA_NOT_READY = "DATA_NOT_READY";
    /** 기한이 지나 Claude 계좌를 부르지 않음(작업 기록 — 그 시장 Claude 계좌가 그날 결정할 차례였을 때). */
    static final String CLAUDE_PAST_DEADLINE = "결정 기한이 지나 Claude를 부르지 않습니다";
    /** 기한이 지나 규칙 계좌를 결정하지 않음(작업 기록 — NO_TRADE 결정 행은 그 시장 규칙 계좌 결정이 씁니다). */
    static final String RULES_PAST_DEADLINE = "결정 기한이 지나 결정하지 않습니다(NO_TRADE)";
    /** 출발 오류 횟수를 세는 자리(오류 횟수 표의 책 칸 — 계좌 코드와 겹치지 않음). */
    private static final String START_FAILURES = "start";
    /** 규칙 계좌 결정이 없는 시장 묶음의 자리(작업 기록 — 미국·한국 밖, 시험용 묶음, 클래스 설명). */
    static final String RULES_NOT_YET = "이 시장의 규칙 계좌 결정은 아직 없습니다(2단계 D1)";

    /**
     * 한 번 실행의 결과.
     *
     * @param outcome     위 상수 중 하나. DECIDED·ERROR만 작업 기록을 남깁니다(NO_CALENDAR는 시장·KST 날짜·빠진 해마다 한 번,
     *                    PAST_DEADLINE은 시장·세션마다 한 번)
     * @param tradingDate 결정 대상 거래일(테이블이 없으면 null)
     * @param pricesFinal 확정 종가로 결정했나(결정 전에 끝났으면 null)
     * @param rules       규칙 책 결정(내지 않았으면 null)
     * @param claude      Claude 책 결정(내지 않았으면 null)
     */
    public record Result(String outcome, LocalDate tradingDate, Boolean pricesFinal, Decision rules, Decision claude,
                         String message) {
    }

    /** 설정의 결정 시각과 마감 기한(KST) — 읽은 값 그대로(기한의 순간은 시장 규칙 {@link PaperMarket#deadlineInstant}). */
    record Times(LocalTime decision, LocalTime deadline) {
    }

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperLedgerService ledger;
    private final PaperSelectionService selection;
    private final RuleBookService rules;
    private final ClaudeBookService claude;
    private final PaperSettingsService settings;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 정기 실행이 도는 시장 목록(도는 순서 — {@link PaperMarkets#all}). */
    private final PaperMarkets markets;
    /** 정기 실행과 수동 실행이 겹치지 않게(같은 거래일 결정을 동시에 만들지 않게 — 유일 제약이 마지막 방어선). 시장이 여럿이어도 하나. */
    private final ReentrantLock running = new ReentrantLock();
    /** (시장, 거래일, 책) → 오류 난 횟수(클래스 설명). 재기동하면 사라집니다. */
    private final Map<FailureKey, Integer> failures = new ConcurrentHashMap<>();
    /** '달력 없음'을 시장·날짜·빠진 해마다 한 번만 남기는 장부(클래스 설명). */
    private final CalendarGaps calendarGaps = new CalendarGaps();
    /** 한국 네 계좌의 출발(클래스 설명 '한국 출발'). */
    private final KrStartPipeline krStart;
    /** 한국 규칙 계좌의 정기 결정·기한 지남 행(클래스 설명 '시장마다 따로'). */
    private final KrRuleBookService krRules;
    /** 한국 결정 자료 게이트(§4-9 ①~⑥ — 정기 결정·출발이 같은 판정, {@link KrDecisionGates}). */
    private final KrDecisionGates krGates;
    /**
     * 작업 기록 상세의 칸 — 그 실행이 끝났을 때 한국 규칙 계좌 몫의 마지막 자료 게이트 판정(기한 전 — 기다림·통과 모두, {@link
     * KrDecisionGates.Judged#view}). 그 세션 규칙 계좌 결정이 아직 없을 때만 남깁니다. 기한 지남 행의 사유와 기다린 까닭은 기한 뒤 첫 실행 때의
     * 저장본이 아니라 그 세션의 가장 최근 이 칸으로 정합니다(기한 직후 들어온 069500 D 봉이 '⑤로 기다렸음'을 지우지 않게 — 저장된 기록이라
     * 재기동해도 같음, 2단계 명세 §4-9 'E0', 사용자 결정 v3).
     */
    static final String RULES_GATES = "rulesGates";
    /**
     * 작업 기록 상세의 칸 — 그 실행이 끝났을 때 한국 Claude 계좌 몫의 마지막 자료 게이트 판정({@value #RULES_GATES}의 Claude 판 — 그 계좌 ① + ②~⑥,
     * 장부 전 게이트에서 멈췄으면 ②④⑤⑥). 그 세션 Claude 계좌가 정기 결정을 낼 차례이고 그 실행이 Claude 결정을 내지 않았을 때만 남깁니다. 기한 지남
     * SKIPPED 행(사용자 결정 v4)이 그 세션의 가장 최근 이 칸을 다시 읽습니다 — 규칙 계좌가 이미 결정한 밤에 Claude만 ①로 기다렸어도 그 까닭이 남게
     * (2단계 명세 §9 'E0 메모'의 'E2에 남긴 것', E2b).
     */
    static final String CLAUDE_GATES = "claudeGates";

    /** 오류 횟수를 세는 단위 — 시장 × 거래일(그 시장 세션) × 책 코드(그 시장의 규칙·Claude 책). */
    private record FailureKey(String market, LocalDate day, String book) {
    }

    /**
     * 그 거래일에 남은 일 — 게이트 지표(두 책이 함께 기다림), 시작한 규칙 책의 정기 결정, Claude 책의 정기 결정(재시도할 API 오류 포함).
     */
    private record Work(boolean gate, boolean rules, boolean claude) {

        boolean any() {
            return gate || rules || claude;
        }
    }

    @Autowired
    PaperDecisionJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                     PaperSelectionService selection, RuleBookService rules, ClaudeBookService claude,
                     PaperSettingsService settings, PaperConfig config, ObjectMapper mapper, PaperMarkets markets) {
        this(store, reader, marketData, ledger, selection, rules, claude, settings, config, mapper, Clock.systemUTC(),
                markets);
    }

    /** 테스트용 — 시계를 움직입니다(시장 목록은 운영 목록). */
    PaperDecisionJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                     PaperSelectionService selection, RuleBookService rules, ClaudeBookService claude,
                     PaperSettingsService settings, PaperConfig config, ObjectMapper mapper, Clock clock) {
        this(store, reader, marketData, ledger, selection, rules, claude, settings, config, mapper, clock,
                new PaperMarkets(store, reader));
    }

    /** 테스트용 — 시계와 시장 목록을 바꿉니다(시장 격리 시험이 시험용 한국 시장을 넣음). */
    PaperDecisionJob(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                     PaperSelectionService selection, RuleBookService rules, ClaudeBookService claude,
                     PaperSettingsService settings, PaperConfig config, ObjectMapper mapper, Clock clock,
                     List<PaperMarket> markets) {
        this(store, reader, marketData, ledger, selection, rules, claude, settings, config, mapper, clock,
                new PaperMarkets(store, reader, markets));
    }

    private PaperDecisionJob(PaperStore store, StoreReader reader, PaperMarketData marketData,
                             PaperLedgerService ledger, PaperSelectionService selection, RuleBookService rules,
                             ClaudeBookService claude, PaperSettingsService settings, PaperConfig config,
                             ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.ledger = ledger;
        this.selection = selection;
        this.rules = rules;
        this.claude = claude;
        this.settings = settings;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        this.markets = markets;
        this.krRules = new KrRuleBookService(store, reader, marketData, ledger, mapper, clock);
        this.krGates = new KrDecisionGates(reader, krRules);
        // 네 계좌 출발의 몫 — 규칙 계좌(D1b)·Claude 계좌(E2b)·벤치마크 둘.
        this.krStart = new KrStartPipeline(store, ledger, config, mapper, clock, null, krGates, krRules.startLeg(config),
                claudeStartLeg());
    }

    /**
     * 한국 출발의 Claude 계좌 몫 — 출발을 계획할 때 Claude 계좌 서비스의 몫({@link ClaudeBookService#krStartLeg})을 불러 맡깁니다(만들 때 그 서비스를
     * 건드리지 않음). 그 서비스에 한국 결정 문맥이 없으면(시험) '아직 없음'({@link KrStartPipeline#CLAUDE_NOT_YET}).
     */
    private KrStartPipeline.Leg claudeStartLeg() {
        return new KrStartPipeline.Leg() {
            @Override
            public String book() {
                return PaperBooks.KR_CLAUDE;
            }

            /** 과금되는 몫 — 다른 몫을 모두 계획한 뒤에만 부름({@link KrStartPipeline.Leg#charges}). */
            @Override
            public boolean charges() {
                return true;
            }

            @Override
            public KrStartPipeline.Plan plan(MarketRun run, LocalDate session, Instant deadline,
                                             KrDecisionGates.Checked gates) {
                KrStartPipeline.Leg leg = claude.krStartLeg();
                return leg == null ? KrStartPipeline.Plan.notYet(book(), KrStartPipeline.CLAUDE_NOT_YET)
                        : leg.plan(run, session, deadline, gates);
            }
        };
    }

    /**
     * 정기 실행 — 시장마다 차례로 한 번({@link PaperMarkets#all}, 클래스 설명). 한 시장의 예외는 그 시장만 로그로 남기고 다음 시장으로
     * 넘어갑니다. 꺼져 있으면 아무것도 하지 않습니다. 예외는 삼키고 로그만(RegimeLogService 관례).
     */
    @Scheduled(initialDelayString = "${dashboard.paper.decision-initial-delay-ms:120000}",
            fixedDelayString = "${dashboard.paper.decision-interval-ms:600000}")
    public void scheduledRun() {
        if (!config.enabled()) {
            return;
        }
        for (PaperMarket market : markets.all()) {
            try {
                Result result = run(market);
                if (BUSY.equals(result.outcome())) {
                    log.info("모의 매매 결정 작업: {}", result.message());
                } else if (ERROR.equals(result.outcome())) {
                    log.warn("모의 매매 결정 작업 오류({}) — {}", result.tradingDate(), result.message());
                } else if (STARTED.equals(result.outcome())) {
                    // 출발 미룸은 startKr가 그 세션 처음 한 번만 INFO로 남깁니다(기한 뒤 10분마다 같은 줄이 나오지 않게).
                    log.info("모의 매매 결정 작업({}): {}", market.code(), result.message());
                } else if (DECIDED.equals(result.outcome())) {
                    log.info("모의 매매 결정 작업: {} 규칙 책 {} · Claude 책 {}", result.tradingDate(),
                            result.rules() == null ? "결정 없음" : result.rules().status(),
                            result.claude() == null ? "결정 없음" : result.claude().status());
                }
            } catch (RuntimeException e) {
                log.warn("모의 매매 결정 작업 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
            }
        }
    }

    /** 미국 시장 정기 실행 한 번 — {@link #run(PaperMarket)}의 미국 판. 테스트가 부릅니다. */
    Result run() {
        return run(UsPaperMarket.INSTANCE);
    }

    /**
     * 그 시장의 정기 실행 한 번(클래스 설명의 순서). 수동 실행이 잠금을 쥐고 있으면 기다리지 않고 {@value #BUSY} — 스케줄러 스레드를
     * Claude 호출 몇 분 동안 붙잡지 않게(다음 주기에 다시 봅니다).
     */
    Result run(PaperMarket market) {
        if (!running.tryLock()) {
            return new Result(BUSY, null, null, null, null,
                    "수동 결정이 진행 중 — 이번 주기는 건너뛰고 다음 주기에 다시 봅니다");
        }
        try {
            return runLocked(market);
        } finally {
            running.unlock();
        }
    }

    private Result runLocked(PaperMarket requested) {
        if (!store.ready()) {
            return new Result(NOT_READY, null, null, null, null, PaperQueryService.NOT_READY_MESSAGE);
        }
        String dormant = dormantReason(requested);
        if (dormant != null) {
            return new Result(DORMANT, null, null, null, null, dormant);
        }
        Instant now = clock.instant();
        // 이 실행의 시장 문맥 — 달력 한 벌과 설정 행 하나(시각·장부·Claude 결정이 같은 판, 클래스 설명).
        MarketRun market = markets.open(requested);
        try {
            market.requireCalendarWindow(now);
            calendarGaps.clear(market);
        } catch (CalendarUnavailableException e) {
            return noCalendar(market, now, e);
        }
        LocalDate d = market.calendar().lastCompletedSession(now);
        if (store.books(market.code()).isEmpty()) {
            return new Result(NOT_INITIALIZED, d, null, null, null, "초기화 전입니다 — 계좌가 없습니다");
        }
        if (krStart.pending(market)) {
            // 한국 계좌가 모두 시작 전 — 정기 결정 대신 출발(S 22:30 → S+1 시가, 클래스 설명 '한국 출발').
            return startKr(market, now, d);
        }
        Times times = times(market, market.settingsBody());
        Instant decisionAt = market.decisionInstant(d, times.decision());
        if (now.isBefore(decisionAt)) {
            return new Result(TOO_EARLY, d, null, null, null, "결정 시각 " + Kst.stamp(decisionAt) + " 전");
        }
        Work work = pendingWork(market, d);
        if (!work.any()) {
            return new Result(ALREADY_DECIDED, d, null, null, null, d + " 결정·게이트 지표를 이미 남겼습니다");
        }
        Instant deadline = market.deadlineInstant(d, times.decision(), times.deadline());
        if (!now.isBefore(deadline) && market.afterDeadline() == PaperMarket.AfterDeadline.NO_TRADE) {
            // 기한이 지난 세션은 그 시장 규칙상 결정하지 않습니다 — 관측치·장부도 여기서 처리하지 않음(리스크 점검의 몫).
            return pastDeadline(market, now, d, deadline);
        }
        boolean rulesGaveUp = gaveUp(market, d, market.rulesBook());
        boolean claudeGaveUp = gaveUp(market, d, market.claudeBook());
        // 게이트 지표는 두 책이 함께 기다리는 일입니다(그 단계 오류는 두 책 모두에 셈).
        if ((!(work.gate() || work.rules()) || rulesGaveUp) && (!(work.gate() || work.claude()) || claudeGaveUp)) {
            return new Result(GAVE_UP, d, null, null, null, d + " 오류가 " + MAX_ATTEMPTS + "번 나 오늘은 더 시도하지 않습니다 — "
                    + "수동 실행(POST /api/paper/run/decision)은 다시 시도합니다");
        }
        if (krRulesSteps(market)) {
            // 한국 묶음 — 자료 게이트 ①~⑥(§4-9)가 '그날 종가 관측치' 기다림을 대신합니다(클래스 설명 '한국 결정 게이트').
            return decideKr(market, now, d, deadline, rulesGaveUp, claudeGaveUp);
        }
        Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(market));
        boolean closesIn = quotes.map(q -> closesFor(market, q, d)).orElse(false);
        boolean pricesFinal = quotes.map(q -> confirmedFor(market, q, d)).orElse(false);
        if (!closesIn && now.isBefore(deadline)) {
            return new Result(PRICES_NOT_FINAL, d, false, null, null, d + " 확정 종가 관측치를 기다립니다(기한 "
                    + Kst.stamp(deadline) + ")");
        }

        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tradingDate", d.toString());
        detail.put("pricesFinal", pricesFinal);
        detail.put("pastDeadline", !now.isBefore(deadline));
        quotes.ifPresent(q -> detail.put("quotes", PaperRiskJob.describe(market, q)));
        try {
            quotes.ifPresent(q -> detail.put("ledger", ledgerDetail(ledger.process(market, q))));
            // 다음 세션 봉이 섞인 관측치(기한을 한참 넘겨 장중에 돈 경우)로는 d의 줄을 쓰지 않습니다 — 그날 값이 아닙니다.
            boolean sameSession = quotes.map(q -> q.modalBarDate() == null || !q.modalBarDate().isAfter(d))
                    .orElse(true);
            if (sameSession) {
                detail.put("navSettled", ledger.settleNav(market, d, closesIn));
            }
            if (usSteps(market)) {
                GateRow gate = recordGate(d);
                detail.put("gateLevel", gate.level());
            }
        } catch (RuntimeException e) {
            // 장부·게이트가 실패하면 두 책 모두 결정하지 않습니다(그날 장부를 믿을 수 없음) — 오류도 두 책 모두에 셉니다.
            return failed(market, now, d, pricesFinal, detail, List.of(message(e)),
                    List.of(market.rulesBook(), market.claudeBook()), null, null);
        }

        // 규칙 책(대조군)과 Claude 책(실험군)은 따로 잡습니다 — 한쪽 오류가 다른 쪽의 그날 결정을 막지 않게(클래스 설명).
        List<String> errors = new ArrayList<>();
        List<String> failedBooks = new ArrayList<>();
        Decision decision = null;
        if (rulesGaveUp) {
            detail.put("rules", gaveUpNote());
        } else if (!usSteps(market)) {
            detail.put("rules", RULES_NOT_YET);
        } else {
            try {
                decision = decideRules(market, d, pricesFinal, detail);
                failures.remove(new FailureKey(market.code(), d, market.rulesBook()));
            } catch (RuntimeException e) {
                errors.add("규칙 계좌: " + message(e));
                detail.put("rulesError", message(e));
                failedBooks.add(market.rulesBook());
            }
        }
        Decision claudeDecision = null;
        if (claudeGaveUp) {
            detail.put("claude", gaveUpNote());
        } else {
            try {
                String claudeSkip = claudeSkipReason(market, store.book(market.claudeBook()), d);
                if (claudeSkip == null) {
                    claudeDecision = claude.decide(market, d, RuleBookService.SCHEDULED, pricesFinal);
                    detail.put("claude", decisionDetail(claudeDecision));
                } else {
                    detail.put("claude", claudeSkip);
                }
                failures.remove(new FailureKey(market.code(), d, market.claudeBook()));
            } catch (RuntimeException e) {
                errors.add("Claude 계좌: " + message(e));
                detail.put("claudeError", message(e));
                failedBooks.add(market.claudeBook());
            }
        }
        if (!errors.isEmpty()) {
            return failed(market, now, d, pricesFinal, detail, errors, failedBooks, decision, claudeDecision);
        }
        record(market, now, DECIDED, detail);
        return new Result(DECIDED, d, pricesFinal, decision, claudeDecision, null);
    }

    /**
     * 한국 정기 결정 한 번(클래스 설명 '한국 결정 게이트' — 2단계 명세 §4-9, D1c). 게이트 ②④⑤⑥(관측치 저장본·금융위 메타·달력)이 미달이면 장부를
     * 처리하지 않고 {@value #DATA_NOT_READY}(그 세션 기다림 한 줄), 통과하면 장부를 처리한 뒤 규칙 계좌 입력을 그 실행에서 한 번 읽어(K26 동결과 같은
     * 읽기 — 결정 e5) ③을 보고, 계좌마다 ①(그 계좌 장부가 이번 관측치를 처리함·기준일 &lt; D 대기 주문 없음 — 결정 e3)을 본 뒤 결정합니다. 판정은 결정 행
     * 응답 {@code gates}와 작업 기록 {@code gates}에 남고, 그 세션 규칙 계좌 결정이 아직 없으면 규칙 계좌 몫의 마지막 판정을 작업 기록
     * {@value #RULES_GATES}에도 남깁니다(기한 지남 행이 다시 읽음 — 오류 기록·기다림 줄·DECIDED 모두). 결정한 계좌가 없고 ①로 기다리는 계좌만 있으면
     * {@value #DATA_NOT_READY}입니다.
     */
    private Result decideKr(MarketRun market, Instant now, LocalDate d, Instant deadline, boolean rulesGaveUp,
                            boolean claudeGaveUp) {
        KrDecisionGates.Inputs session = krGates.readSession(market, d);
        if (!rulesGaveUp && krRules.due(d) && krRules.paused()) {
            // 일시정지 규칙 계좌 — 입력·자료 게이트 없이 그 세션 SKIPPED(주문을 내지 않으니 가격·수급을 기다릴 까닭이 없음). Claude 쪽 일이
            // 남았으면 아래 게이트 경로가 이어서 봅니다(규칙 계좌는 '이미 결정함').
            Result paused = skipPausedRules(market, now, d, session, claudeGaveUp);
            if (paused != null) {
                return paused;
            }
        }
        // 그 세션 규칙 계좌 결정이 아직 없나 — 그동안의 판정만 기한 지남 행이 다시 읽도록 작업 기록에 남깁니다(RULES_GATES).
        boolean rulesOpen = krRules.due(d);
        // Claude 계좌도 같음 — 그 세션 정기 결정을 낼 차례면 그 계좌 몫 판정을 남깁니다(CLAUDE_GATES — 기한 지남 SKIPPED 행이 다시 읽음, 사용자 결정 v4).
        boolean claudeOpen = !claudeGaveUp && claudeSkipReason(market, store.book(market.claudeBook()), d) == null;
        List<KrDecisionGates.Gate> before = krGates.beforeLedger(market, session);
        // 판정은 통과도 남깁니다 — 뒤의 장부 처리·입력 읽기가 예외로 끝나(세 번이면 포기) 기한이 지나도, 기한 지남 행이 앞 주기의 미달 판정
        // (예: 22:30의 ⑤)이 아니라 이 판정(통과 — '기한 지남', 기다린 까닭 없음)을 쓰게(오류 기록에 남김).
        List<KrDecisionGates.Gate> judged = before;
        if (!KrDecisionGates.blocking(before).isEmpty()) {
            return waitKr(market, now, d, before, rulesOpen ? judged : null, claudeOpen ? before : null, deadline, null,
                    null, null);
        }
        Optional<Quotes> quotes = session.quotes();
        boolean closesIn = quotes.map(q -> closesFor(market, q, d)).orElse(false);
        boolean pricesFinal = quotes.map(q -> confirmedFor(market, q, d)).orElse(false);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tradingDate", d.toString());
        detail.put("pricesFinal", pricesFinal);
        detail.put("pastDeadline", false);
        quotes.ifPresent(q -> detail.put("quotes", PaperRiskJob.describe(market, q)));
        KrDecisionGates.Inputs inputs;
        List<KrDecisionGates.Gate> data;
        try {
            quotes.ifPresent(q -> detail.put("ledger", ledgerDetail(ledger.process(market, q))));
            boolean sameSession = quotes.map(q -> q.modalBarDate() == null || !q.modalBarDate().isAfter(d))
                    .orElse(true);
            if (sameSession) {
                detail.put("navSettled", ledger.settleNav(market, d, closesIn));
            }
            // 장부를 처리한 뒤의 보유·재진입 금지로 — 게이트 ③과 규칙 계좌 결정이 같은 읽기(결정 e5). 읽은 순간 = 이 실행의 지금.
            inputs = krGates.withRules(market, session, now);
            data = krGates.data(market, inputs);
        } catch (RuntimeException e) {
            putGates(detail, RULES_GATES, rulesOpen ? judged : null, now);
            putGates(detail, CLAUDE_GATES, claudeOpen ? before : null, now);
            return failed(market, now, d, pricesFinal, detail, List.of(message(e)),
                    List.of(market.rulesBook(), market.claudeBook()), null, null);
        }
        judged = data;
        if (!KrDecisionGates.blocking(data).isEmpty()) {
            return waitKr(market, now, d, data, rulesOpen ? judged : null, claudeOpen ? data : null, deadline, null, null,
                    null);
        }

        List<KrDecisionGates.Gate> gates = new ArrayList<>();
        List<String> waiting = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        List<String> failedBooks = new ArrayList<>();
        Decision decision = null;
        boolean rulesDecided = false;
        if (rulesGaveUp) {
            detail.put("rules", gaveUpNote());
        } else {
            try {
                Optional<Decision> existing = krRules.decisionOn(d);
                String skip = existing.isPresent() ? null : krRules.skipReason(d);
                if (existing.isPresent()) {
                    Map<String, Object> view = krDecisionDetail(existing.get());
                    view.put("existing", true);
                    detail.put("rules", view);
                    decision = existing.get();
                } else if (skip != null) {
                    detail.put("rules", skip);
                } else {
                    KrDecisionGates.Gate first = ledgerGate(market, market.rulesBook(), d, inputs);
                    gates.add(first);
                    judged = withFirst(first, data);
                    if (first.blocks()) {
                        waiting.add(first.id() + " " + first.note());
                        detail.put("rules", "자료 게이트 미달 — 다음 주기에 다시: " + first.id() + " " + first.note());
                    } else {
                        decision = krRules.decide(market, d, pricesFinal, inputs, views(withFirst(first, data)));
                        rulesDecided = true;
                        detail.put("rules", krDecisionDetail(decision));
                    }
                }
                failures.remove(new FailureKey(market.code(), d, market.rulesBook()));
            } catch (RuntimeException e) {
                errors.add("규칙 계좌: " + message(e));
                detail.put("rulesError", message(e));
                failedBooks.add(market.rulesBook());
            }
        }
        Decision claudeDecision = null;
        List<KrDecisionGates.Gate> claudeJudged = data;
        if (claudeGaveUp) {
            detail.put("claude", gaveUpNote());
        } else {
            try {
                String claudeSkip = claudeSkipReason(market, store.book(market.claudeBook()), d);
                if (claudeSkip != null) {
                    detail.put("claude", claudeSkip);
                } else {
                    KrDecisionGates.Gate first = ledgerGate(market, market.claudeBook(), d, inputs);
                    gates.add(first);
                    claudeJudged = withFirst(first, data);
                    if (first.blocks()) {
                        waiting.add(first.id() + " " + first.note());
                        detail.put("claude", "자료 게이트 미달 — 다음 주기에 다시: " + first.id() + " " + first.note());
                    } else {
                        // 한국 Claude 계좌 — 그 실행의 관측치(게이트·장부가 본 것)와 읽은 순간(이 실행의 지금 — 규칙 계좌 입력 동결과 같음)으로
                        // 패킷을 만들고 같은 관측치로 검증합니다(E2b). 결정 행 응답에 그 계좌의 ① + ②~⑥.
                        claudeDecision = claude.decide(market, d, RuleBookService.SCHEDULED, pricesFinal,
                                new ClaudeDecisionPipeline.Observed(inputs.quotes(), now, views(withFirst(first, data))));
                        detail.put("claude", decisionDetail(claudeDecision));
                    }
                }
                failures.remove(new FailureKey(market.code(), d, market.claudeBook()));
            } catch (RuntimeException e) {
                errors.add("Claude 계좌: " + message(e));
                detail.put("claudeError", message(e));
                failedBooks.add(market.claudeBook());
            }
        }
        gates.addAll(data);
        detail.put("gates", views(gates));
        List<KrDecisionGates.Gate> rulesJudged = rulesOpen && !rulesDecided ? judged : null;
        List<KrDecisionGates.Gate> claudeLeft = claudeOpen && claudeDecision == null ? claudeJudged : null;
        if (!errors.isEmpty()) {
            putGates(detail, RULES_GATES, rulesJudged, now);
            putGates(detail, CLAUDE_GATES, claudeLeft, now);
            return failed(market, now, d, pricesFinal, detail, errors, failedBooks, decision, claudeDecision);
        }
        if (!waiting.isEmpty() && !rulesDecided && claudeDecision == null) {
            // 결정한 계좌 없이 ①로 기다리는 계좌만 — 그 세션 기다림 한 줄(이어지는 기다림은 그 줄을 늘림)로 남기고 다음 주기에 다시.
            return waitKr(market, now, d, gates, rulesJudged, claudeLeft, deadline, "자료 게이트 미달: "
                    + String.join(" · ", waiting) + " — 기한 " + Kst.stamp(deadline) + "까지 다음 주기에 다시 봅니다",
                    pricesFinal, decision);
        }
        putGates(detail, RULES_GATES, rulesJudged, now);
        putGates(detail, CLAUDE_GATES, claudeLeft, now);
        record(market, now, DECIDED, detail);
        return new Result(DECIDED, d, pricesFinal, decision, claudeDecision, null);
    }

    /**
     * 일시정지 한국 규칙 계좌의 그 세션 SKIPPED({@link KrRuleBookService#skipPaused} — 입력·게이트 없이). Claude 계좌도 그날 할 일이 없으면 그
     * 결정으로 끝내고(기록 DECIDED), 할 일이 있으면 null(게이트 경로로 이어감). 쓰다 예외가 나면 규칙 계좌 오류로 셉니다.
     */
    private Result skipPausedRules(MarketRun market, Instant now, LocalDate d, KrDecisionGates.Inputs session,
                                   boolean claudeGaveUp) {
        boolean pricesFinal = session.quotes().map(q -> confirmedFor(market, q, d)).orElse(false);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tradingDate", d.toString());
        detail.put("pricesFinal", pricesFinal);
        detail.put("pastDeadline", false);
        Decision skipped;
        try {
            skipped = krRules.skipPaused(market, d, pricesFinal);
            failures.remove(new FailureKey(market.code(), d, market.rulesBook()));
        } catch (RuntimeException e) {
            detail.put("rulesError", message(e));
            return failed(market, now, d, pricesFinal, detail, List.of("규칙 계좌: " + message(e)),
                    List.of(market.rulesBook()), null, null);
        }
        String claudeSkip = claudeGaveUp ? gaveUpNote() : claudeSkipReason(market, store.book(market.claudeBook()), d);
        if (claudeSkip == null) {
            return null;
        }
        detail.put("rules", krDecisionDetail(skipped));
        detail.put("claude", claudeSkip);
        record(market, now, DECIDED, detail);
        return new Result(DECIDED, d, pricesFinal, skipped, null, null);
    }

    /**
     * 그 실행의 계좌 몫 마지막 판정을 작업 기록 상세에 남깁니다({@value #RULES_GATES}·{@value #CLAUDE_GATES} — 판정이 없으면 남기지 않음).
     */
    private static void putGates(Map<String, Object> detail, String key, List<KrDecisionGates.Gate> judged, Instant at) {
        if (judged != null) {
            detail.put(key, new KrDecisionGates.Judged(judged, at, true).view());
        }
    }

    /**
     * 자료 게이트 미달 — 결정 없이 다음 주기에 다시({@value #DATA_NOT_READY}). 그 세션 기다림 한 줄({@link #recordWait})에 판정과 규칙 계좌 몫
     * 판정({@value #RULES_GATES} — 기한 지남 행이 다시 읽음)을 남깁니다.
     *
     * @param claudeJudged Claude 계좌 몫 판정({@value #CLAUDE_GATES} — 그 세션 Claude 정기 결정이 남았을 때만, 아니면 null)
     * @param message     결과 문구(null이면 미달 게이트로 만듦)
     * @param pricesFinal 결과의 {@code pricesFinal}(장부 처리 전 게이트에서 멈췄으면 null)
     * @param decision    그 실행이 돌려줄 규칙 계좌 결정(이미 있던 것 — 없으면 null)
     */
    private Result waitKr(MarketRun market, Instant now, LocalDate d, List<KrDecisionGates.Gate> gates,
                          List<KrDecisionGates.Gate> rulesJudged, List<KrDecisionGates.Gate> claudeJudged,
                          Instant deadline, String message, Boolean pricesFinal, Decision decision) {
        String text = message != null ? message : "자료 게이트 미달: " + String.join(" · ", KrDecisionGates.blocking(gates))
                + " — 기한 " + Kst.stamp(deadline) + "까지 다음 주기에 다시 봅니다";
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("tradingDate", d.toString());
        detail.put("deadline", Kst.stamp(deadline));
        detail.put("waiting", text);
        detail.put("gates", views(gates));
        putGates(detail, RULES_GATES, rulesJudged, now);
        putGates(detail, CLAUDE_GATES, claudeJudged, now);
        recordWait(market, now, d, DATA_NOT_READY, detail);
        return new Result(DATA_NOT_READY, d, pricesFinal, decision, null, text);
    }

    /**
     * 그 계좌의 게이트 ①({@link KrDecisionGates#ledger}) — 장부가 그 실행의 관측치를 처리하면서 그날 보류한 주문 종목(이 작업이나 리스크 점검이
     * 처리한 것, {@link PaperLedgerService#orderHolds(PaperMarket, String, Instant)})과 함께.
     */
    private KrDecisionGates.Gate ledgerGate(MarketRun market, String book, LocalDate d, KrDecisionGates.Inputs inputs) {
        Map<String, String> held = inputs.quotes().map(q -> ledger.orderHolds(market, book, q.collectedAt()))
                .orElse(Map.of());
        return KrDecisionGates.ledger(store, market, book, d, inputs, held);
    }

    /** ①(그 계좌) 다음에 ②~⑥. */
    private static List<KrDecisionGates.Gate> withFirst(KrDecisionGates.Gate first, List<KrDecisionGates.Gate> data) {
        List<KrDecisionGates.Gate> out = new ArrayList<>();
        out.add(first);
        out.addAll(data);
        return out;
    }

    private static List<Map<String, Object>> views(List<KrDecisionGates.Gate> gates) {
        return gates.stream().map(KrDecisionGates.Gate::view).toList();
    }

    /**
     * 기한이 지난 세션을 결정하지 않음({@link PaperMarket.AfterDeadline#NO_TRADE} — 한국, 명세 §4-9·§5). Claude 계좌는 부르지 않고 그날 결정할
     * 차례였으면 그 세션의 SKIPPED 행({@link ClaudeBookService#pastDeadline} — 사용자 결정 v4, 그 계좌 몫의 기한 전 마지막 판정
     * {@value #CLAUDE_GATES}와 함께)을 쓰며, 규칙 계좌도 결정하지 않습니다 — 한국 규칙 계좌는 이 자리에서 그 세션의 NO_TRADE 결정 행을 씁니다(재선정
     * 따라잡기 K33의 근거). 두 행 모두 저장된 사실이라 다시 쓰지 않고, 쓰기가 실패했으면 다음 주기에 다시 씁니다. 관측치·장부·순자산 줄은 이 작업에서
     * 처리하지 않습니다(리스크 점검이 5분마다 처리). 작업 기록은 시장·세션마다 한 번 {@value #PAST_DEADLINE}(사유·기한·계좌마다 한 일)이고 로그도
     * 그때만 INFO입니다.
     */
    private Result pastDeadline(MarketRun market, Instant now, LocalDate d, Instant deadline) {
        String message = d + " 결정 기한(" + Kst.stamp(deadline) + ")이 지나 그 세션은 결정하지 않습니다 — Claude를 부르지 않음";
        // 한국 규칙 계좌의 그 세션 NO_TRADE 행(사유 '기한 지남' — 따라잡기 K33의 근거)은 기록 한 번과 따로 씁니다: 저장된 사실이라 다시 쓰지 않고,
        // 쓰기가 실패했으면 다음 주기에 다시 씁니다.
        Object rulesView = usSteps(market) ? RULES_PAST_DEADLINE : RULES_NOT_YET;
        Decision rulesRow = null;
        KrDecisionGates.Judged judged = null;
        // 그 세션의 작업 기록(저장된 사실 — 재기동해도 같음, 2단계 명세 §4-9 'E0'): 기한 전 마지막 판정과 기한 지남 기록 한 번의 판정.
        List<PaperStore.JobRun> records = store.jobRunsFor(market.jobName(JOB), d);
        if (krRulesSteps(market)) {
            String skip = krRules.skipReason(d);
            if (skip != null) {
                rulesView = skip;
            } else {
                // NO_TRADE 행의 사유(⑤ 미달이면 '069500 D 봉 없음', 결정 e4)와 기다린 까닭 — 그 세션 기한 전 마지막 판정(작업 기록의
                // RULES_GATES), 그 기록이 없으면(그 밤 첫 실행이 기한 뒤) 지금 판정(① 규칙 계좌 · ②~⑥)에 '기한 뒤 판정' 표시. 일시정지 계좌는
                // 게이트 없이 SKIPPED 행.
                boolean paused = krRules.paused();
                judged = paused ? null : storedGates(records, RULES_GATES);
                if (judged == null && !paused) {
                    List<KrDecisionGates.Gate> current = deadlineGates(market, market.rulesBook(), d, now);
                    judged = current == null ? null : new KrDecisionGates.Judged(current, now, false);
                }
                try {
                    rulesRow = krRules.pastDeadline(market, d, deadline, judged);
                    rulesView = decisionDetail(rulesRow);
                } catch (RuntimeException e) {
                    rulesView = "기한 지남 NO_TRADE 행을 쓰지 못함 — 다음 주기에 다시: " + message(e);
                    log.warn("모의 매매 결정 작업({}) — 한국 규칙 계좌 기한 지남 행을 쓰지 못했습니다: {}", market.code(), e.toString());
                }
            }
        }
        // Claude 계좌가 그 세션 정기 결정을 낼 차례였으면 그 세션 SKIPPED 행(사용자 결정 v4 — 미국 호출 상한의 SKIPPED 행처럼, Claude는 부르지
        // 않음). 판정은 그 세션 Claude 몫의 기한 전 마지막 판정(CLAUDE_GATES), 없으면 지금 판정(① Claude 계좌 · ②~⑥)에 '기한 뒤 판정' 표시.
        // 저장된 사실이라 다시 쓰지 않고, 쓰기가 실패했으면 다음 주기에 다시 씁니다(규칙 계좌 행과 같음).
        String claudeSkip = claudeSkipReason(market, store.book(market.claudeBook()), d);
        Object claudeView = claudeSkip;
        Decision claudeRow = null;
        if (claudeSkip == null) {
            KrDecisionGates.Judged claudeJudged = null;
            // 재시도 차례인 API 오류 행이면 기한이 그 재시도를 쓸 뿐이라(행에 판정을 더하지 않음) 판정을 읽거나 만들지 않습니다.
            boolean retrying = store.decisionFor(market.claudeBook(), d, RuleBookService.SCHEDULED)
                    .filter(ClaudeBookService::retryable).isPresent();
            if (krRulesSteps(market) && !retrying) {
                claudeJudged = storedGates(records, CLAUDE_GATES);
                if (claudeJudged == null) {
                    List<KrDecisionGates.Gate> current = deadlineGates(market, market.claudeBook(), d, now);
                    claudeJudged = current == null ? null : new KrDecisionGates.Judged(current, now, false);
                }
            }
            try {
                claudeRow = claude.pastDeadline(market, d, deadline, claudeJudged);
                claudeView = claudeRow == null ? CLAUDE_PAST_DEADLINE : decisionDetail(claudeRow);
            } catch (RuntimeException e) {
                claudeView = CLAUDE_PAST_DEADLINE + " — 기한 지남 행을 쓰지 못함(다음 주기에 다시): " + message(e);
                log.warn("모의 매매 결정 작업({}) — Claude 계좌 기한 지남 행을 쓰지 못했습니다: {}", market.code(), e.toString());
            }
        }
        boolean first = records.stream().noneMatch(r -> PAST_DEADLINE.equals(r.outcome()));
        if (first) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("tradingDate", d.toString());
            detail.put("pastDeadline", true);
            detail.put("deadline", Kst.stamp(deadline));
            if (judged != null) {
                detail.put("gates", views(judged.gates()));
                detail.put("gatesBasis", judged.basis());
            }
            detail.put("rules", rulesView);
            detail.put("claude", claudeView);
            record(market, now, PAST_DEADLINE, detail);
            log.info("모의 매매 결정 작업({}): {}", market.code(), message);
        } else {
            log.debug("모의 매매 결정 작업({}): {}", market.code(), message);
        }
        return new Result(PAST_DEADLINE, d, null, rulesRow, claudeRow, message);
    }

    /** 그 세션 작업 기록 중 가장 최근의 그 계좌 몫 판정({@value #RULES_GATES}·{@value #CLAUDE_GATES} — 기한 전), 없으면 null. */
    private static KrDecisionGates.Judged storedGates(List<PaperStore.JobRun> records, String key) {
        for (PaperStore.JobRun run : records) {
            KrDecisionGates.Judged judged = run.detail() == null ? null
                    : KrDecisionGates.Judged.fromView(run.detail().get(key));
            if (judged != null) {
                return judged;
            }
        }
        return null;
    }

    /**
     * 기한이 지난 세션의 지금 자료 게이트(① 그 한국 계좌 · ②~⑥) — 그 세션 기한 전 판정 기록({@value #RULES_GATES}·{@value #CLAUDE_GATES})이 없을 때만
     * 씁니다. 이 작업은 기한 뒤 장부를 처리하지 않으므로 ①은 저장된 대기 주문(리스크 점검이 처리한 상태)으로 봅니다. 판정하다 예외가 나면 null(행은
     * '기한 지남'으로 그대로 씀 — 로그만).
     */
    private List<KrDecisionGates.Gate> deadlineGates(MarketRun market, String book, LocalDate d, Instant now) {
        try {
            KrDecisionGates.Inputs inputs = krGates.withRules(market, krGates.readSession(market, d), now);
            return withFirst(ledgerGate(market, book, d, inputs), krGates.data(market, inputs));
        } catch (RuntimeException e) {
            log.warn("모의 매매 결정 작업({}) — 기한 지난 세션 {}의 자료 게이트를 판정하지 못했습니다: {}", market.code(), d, e.toString());
            return null;
        }
    }

    /** 출발일·계좌가 갖춰지지 않은 시장이면 그 사유({@link PaperMarket#dormantReason}) — 실행을 열기 전에 봅니다(저장본을 읽지 않게). */
    private String dormantReason(PaperMarket market) {
        return market.dormantReason(config, () -> store.books(market.code()));
    }

    /**
     * 미국 전용 단계(게이트 지표·13F 재선정·규칙 책 결정 — {@link RuleBookService})를 도는 시장인가(클래스 설명). 미국 묶음 그 자체일
     * 때만 참입니다.
     */
    private static boolean usSteps(PaperMarket market) {
        return market.definition() == UsPaperMarket.INSTANCE;
    }

    /** 한국 규칙 계좌 결정({@link KrRuleBookService})을 도는 시장인가 — 한국 묶음 그 자체일 때만 참입니다(시험용 한국 묶음은 아님). */
    private static boolean krRulesSteps(PaperMarket market) {
        return market.definition() == KrPaperMarket.INSTANCE;
    }

    /** 한국 규칙 계좌 결정의 작업 기록 칸 — 결정 요약에 선정 날짜(주기 r·입력 r′·따라잡기)를 더한 것. */
    private static Map<String, Object> krDecisionDetail(Decision decision) {
        Map<String, Object> out = decisionDetail(decision);
        JsonNode response = decision.response();
        out.put("cycleDate", Json.asText(response, "cycleDate"));
        out.put("selectionAsOf", Json.asText(response, "selectionAsOf"));
        out.put("catchUp", Json.asBoolean(response, "catchUp"));
        return out;
    }

    /**
     * 규칙 책의 그날 정기 결정 — 재선정일이면 선정 → REBALANCE, 놓친 재선정일 따라잡기도 REBALANCE, 그 밖은 SCHEDULED(클래스 설명).
     * <b>그날 정기 결정(SCHEDULED·REBALANCE)이 이미 있으면 그것을 돌려주고 선정·결정을 다시 하지 않습니다</b> — Claude 쪽 일이 남아
     * 같은 거래일에 다시 돌 때(API 오류 재시도·Claude 오류), r 선정으로 낸 REBALANCE가 생긴 뒤라 {@link #rebalanceMissing}이 거짓이
     * 돼 SCHEDULED를 하나 더 내면 "거래일마다 책당 한 번"(C1·R5)이 깨집니다. 시작 전 책은 결정하지 않습니다(null).
     */
    private Decision decideRules(MarketRun market, LocalDate d, boolean pricesFinal, Map<String, Object> detail) {
        // 이 거래일 시점에 재선정이 지난 최신 분기의 재선정일 r — 오늘이 r이면 재선정, r을 놓쳤으면 따라잡기(클래스 설명).
        LocalDate reselectionDay = RuleBookService.reselectionDayAsOf(d);
        boolean reselection = reselectionDay.equals(d);
        detail.put("reselectionDay", reselection);
        Optional<Book> book = store.book(PaperBooks.RULES);
        boolean rulesStarted = book.isPresent() && !PaperBooks.NOT_STARTED.equals(book.get().status());
        Optional<Decision> existing = rulesStarted ? rulesDecisionOn(d) : Optional.empty();
        if (existing.isPresent()) {
            Map<String, Object> view = decisionDetail(existing.get());
            view.put("existing", true);
            detail.put("rules", view);
            return existing.get();
        }
        if (rulesStarted && !afterStart(book.get(), d)) {
            // 출발일은 초기 결정(INITIAL)이 그날 결정입니다 — Claude 책과 같게, 같은 거래일에 정기 결정을 하나 더 내지 않습니다.
            detail.put("rules", "출발일(" + book.get().startedOn() + ") 이하 — 초기 결정이 그날 결정입니다");
            return null;
        }
        boolean rebalance = rulesStarted && rebalanceMissing(book.get(), reselectionDay);
        if (rebalance && !reselection) {
            detail.put("catchUpReselection", reselectionDay.toString());
        }
        if (reselection || rebalance) {
            PaperSelectionService.SelectionOutcome outcome = selection.select(reselectionDay);
            Map<String, Object> picked = new LinkedHashMap<>();
            picked.put("created", outcome.created());
            picked.put("asOf", outcome.selection() == null ? null : outcome.selection().asOfDate().toString());
            picked.put("ciks", outcome.selection() == null ? null : outcome.selection().selectedCiks());
            picked.put("skippedReason", outcome.skippedReason());
            detail.put("selection", picked);
        }
        if (!rulesStarted) {
            detail.put("rules", "시작 전 — 결정을 내지 않습니다");
            return null;
        }
        // 그 실행의 설정 행 하나로(장부·결정 시각과 같은 판 — MarketRun).
        Decision decision = rules.decide(market, d, rebalance ? RuleBookService.REBALANCE : RuleBookService.SCHEDULED,
                pricesFinal);
        detail.put("rules", decisionDetail(decision));
        return decision;
    }

    /**
     * 한국 출발 한 번({@link KrStartPipeline}) — STARTED와 그 세션 기록이 아직 없는 미룸을 기록하고, 자료 게이트 기다림은 그 세션 기다림 한 줄로
     * 남깁니다({@link #recordWait}). 출발을 쓰다 예외가 나면 그 세션의 출발 오류 횟수를 올리고 ERROR로 기록하며, {@value #MAX_ATTEMPTS}번이면 그 세션
     * 기한까지 더 시도하지 않습니다(기한이 지나면 미룸 — 수동 출발 단추는 E2).
     */
    private Result startKr(MarketRun market, Instant now, LocalDate d) {
        FailureKey key = new FailureKey(market.code(), d, START_FAILURES);
        KrStartPipeline.Result start;
        try {
            start = krStart.run(market, now, failures.getOrDefault(key, 0) >= MAX_ATTEMPTS);
        } catch (RuntimeException e) {
            int attempt = failures.merge(key, 1, Integer::sum);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("start", true);
            detail.put("tradingDate", d.toString());
            detail.put("error", message(e));
            detail.put("attempt", attempt);
            record(market, now, ERROR, detail);
            return new Result(ERROR, d, null, null, null, message(e));
        }
        if (STARTED.equals(start.outcome())) {
            failures.remove(key);
        }
        if (start.waiting()) {
            recordWait(market, now, d, start.outcome(), start.detail());
        } else if (start.record()) {
            record(market, now, start.outcome(), start.detail());
        }
        if (START_POSTPONED.equals(start.outcome())) {
            // 미룬 세션은 기한 뒤 서버 정지까지 10분마다 같은 결과가 나옵니다 — 작업 기록처럼 처음 한 번만 INFO, 나머지는 DEBUG.
            if (start.record()) {
                log.info("모의 매매 결정 작업({}): {}", market.code(), start.message());
            } else {
                log.debug("모의 매매 결정 작업({}): {}", market.code(), start.message());
            }
        }
        return new Result(start.outcome(), start.session(), null, null, null, start.message());
    }

    /**
     * 오류로 끝난 실행 — 오류 난 책마다 그날 오류 횟수를 하나 올리고 기록합니다({@code attempt}는 그중 가장 큰 횟수, {@code attempts}는
     * 책마다). 그사이 낸 결정은 결과에 그대로 싣습니다.
     */
    private Result failed(PaperMarket market, Instant now, LocalDate d, boolean pricesFinal, Map<String, Object> detail,
                          List<String> errors, List<String> books, Decision rulesDecision, Decision claudeDecision) {
        int attempt = 0;
        for (String book : books) {
            attempt = Math.max(attempt, failures.merge(new FailureKey(market.code(), d, book), 1, Integer::sum));
        }
        Map<String, Integer> attempts = new LinkedHashMap<>();
        for (String book : List.of(market.rulesBook(), market.claudeBook())) {
            attempts.put(book, failures.getOrDefault(new FailureKey(market.code(), d, book), 0));
        }
        String message = String.join(" · ", errors);
        detail.put("error", message);
        detail.put("attempt", attempt);
        detail.put("attempts", attempts);
        record(market, now, ERROR, detail);
        return new Result(ERROR, d, pricesFinal, rulesDecision, claudeDecision, message);
    }

    /**
     * 그 시장 달력이 앞 창의 해를 모름(명세 K35) — 그 시장 결정을 내지 않고, 그 시장·KST 날짜·빠진 해마다 한 번 작업 기록에
     * {@value #NO_CALENDAR}로 남깁니다(10분마다 같은 줄이 작업 기록을 밀어내지 않게 — {@link CalendarGaps}).
     */
    private Result noCalendar(PaperMarket market, Instant now, CalendarUnavailableException e) {
        if (calendarGaps.firstToday(market, now, e)) {
            record(market, now, NO_CALENDAR, CalendarGaps.detail(e));
            log.warn("모의 매매 결정 작업({}) — {}", market.code(), e.getMessage());
        }
        return new Result(NO_CALENDAR, null, null, null, null, e.getMessage());
    }

    private boolean gaveUp(PaperMarket market, LocalDate d, String book) {
        return failures.getOrDefault(new FailureKey(market.code(), d, book), 0) >= MAX_ATTEMPTS;
    }

    private static String gaveUpNote() {
        return "오늘 오류 " + MAX_ATTEMPTS + "번 — 더 시도하지 않습니다(수동 실행은 다시 시도)";
    }

    private static String message(RuntimeException e) {
        return e.getClass().getSimpleName() + " " + e.getMessage();
    }

    /**
     * 수동 결정(POST /api/paper/run/decision) — 그 책만 종류 MANUAL로 한 번. 결정 시각·확정 종가를 기다리지 않고(결정의
     * {@code prices_final}에 그때 관측치가 확정 종가였는지 남김), 먼저 최신 관측치를 장부에 적용합니다. MANUAL도 거래일마다 한
     * 건이라 같은 날 다시 누르면 처음 결정을 돌려줍니다. 규칙 책은 매수가 재선정일·시작에만이라 수동 결정은 매도 신호와 남는 현금
     * SHY만 냅니다. Claude 책은 Claude를 한 번 부릅니다(하루 호출 상한에 셈 — 그 결정이 API 오류였으면 다시 누를 때 한 번 더 부름).
     *
     * @throws InvalidRequestException 책 코드가 rules·claude가 아님, 그 책이 시작 전, Claude 책이 일시정지 중
     */
    public Decision runNow(String book) {
        return runNow(UsPaperMarket.INSTANCE, book);
    }

    /**
     * 그 시장의 수동 결정 — {@link #runNow(String)}과 같되 책 코드·세션·관측치·장부·기록 이름이 그 시장 것. 규칙 책 수동 결정은 미국
     * 전용 단계라 미국 묶음에서만 받습니다(클래스 설명).
     *
     * <p><b>결정 창</b>(D1c — 2단계 명세 §4-13 'C1b 구현에서 정한 것'·§9 'E2 — 한국 수동 결정의 기준일'): 기한이 지나면 그 세션을 결정하지 않는
     * 시장({@link PaperMarket.AfterDeadline#NO_TRADE} — 한국)은 수동 결정도 그 세션의 결정 창(결정 시각 ~ 기한 — 기본 D 22:30 ~ D+1 01:00,
     * 00:00~08:59 설정은 D+1 아침) 안에서만 받습니다 — 창 밖(D+1 낮이면 D+1 장중 정보를 본 결정이 '기준일 D'로 남음)은 400. 한국 묶음은 정기
     * 결정과 같은 자료 게이트 ①(그 계좌)~⑥도 통과해야 합니다(미달이면 400 — 장부는 처리했을 수 있음, 리스크 점검과 같은 일).
     *
     * @throws InvalidRequestException 책 코드가 그 시장의 규칙·Claude 책이 아님(미국 밖 시장은 Claude 책만), 그 시장이 쉬는 중(출발일·
     *                                 계좌 없음 — {@link PaperMarket#dormantReason}), 그 책이 시작 전, Claude 책이 일시정지 중, 그 시장
     *                                 달력이 앞 창의 해를 모름('달력 없음' — 명세 K35), 결정 창 밖·자료 게이트 미달(한국)
     */
    Decision runNow(PaperMarket requested, String book) {
        String code = Params.oneOf("book", book, usSteps(requested)
                ? List.of(requested.rulesBook(), requested.claudeBook()) : List.of(requested.claudeBook()));
        String dormant = dormantReason(requested);
        if (dormant != null) {
            throw new InvalidRequestException(dormant);
        }
        running.lock();
        try {
            // 그 책의 오류 횟수만 지웁니다(클래스 설명) — 다른 책·다른 시장의 포기 상태는 그대로.
            failures.keySet().removeIf(key -> key.market().equals(requested.code()) && key.book().equals(code));
            Instant now = clock.instant();
            MarketRun market = markets.open(requested);
            try {
                market.requireCalendarWindow(now);
            } catch (CalendarUnavailableException e) {
                throw new InvalidRequestException(e.getMessage());
            }
            LocalDate d = market.calendar().lastCompletedSession(now);
            if (market.afterDeadline() == PaperMarket.AfterDeadline.NO_TRADE) {
                requireDecisionWindow(market, now, d);
            }
            KrDecisionGates.Inputs session = krRulesSteps(market) ? krGates.readSession(market, d) : null;
            if (session != null) {
                requireGates(krGates.beforeLedger(market, session));
            }
            ClaudeDecisionPipeline.Observed observed = null;
            Optional<Quotes> quotes = session != null ? session.quotes() : reader.quietly(() -> marketData.quotes(market));
            boolean pricesFinal = quotes.map(q -> confirmedFor(market, q, d)).orElse(false);
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("manual", true);
            detail.put("book", code);
            detail.put("tradingDate", d.toString());
            detail.put("pricesFinal", pricesFinal);
            quotes.ifPresent(q -> detail.put("ledger", ledgerDetail(ledger.process(market, q))));
            if (session != null) {
                // 장부를 처리한 뒤 ③(같은 읽기)과 그 계좌의 ① — 정기 결정과 같은 판정(클래스 설명 '한국 결정 게이트').
                KrDecisionGates.Inputs inputs = krGates.withRules(market, session, now);
                List<KrDecisionGates.Gate> gates = withFirst(ledgerGate(market, code, d, inputs),
                        krGates.data(market, inputs));
                requireGates(gates);
                detail.put("gates", views(gates));
                // 한국 Claude 수동 결정도 정기 결정과 같은 재료 — 이 실행의 관측치·읽은 순간(E2b).
                observed = new ClaudeDecisionPipeline.Observed(inputs.quotes(), now, views(gates));
            }
            Decision decision;
            if (!market.claudeBook().equals(code)) {
                decision = rules.decide(market, d, RuleBookService.MANUAL, pricesFinal);
            } else if (observed != null) {
                decision = claude.decide(market, d, RuleBookService.MANUAL, pricesFinal, observed);
            } else {
                decision = claude.decide(market, d, RuleBookService.MANUAL, pricesFinal);
            }
            detail.put(code, decisionDetail(decision));
            record(market, now, DECIDED, detail);
            return decision;
        } finally {
            running.unlock();
        }
    }

    /** 수동 결정의 결정 창(위 설명 '결정 창') — 창 밖이면 400. */
    private static void requireDecisionWindow(MarketRun market, Instant now, LocalDate d) {
        Times times = times(market, market.settingsBody());
        Instant opens = market.decisionInstant(d, times.decision());
        Instant deadline = market.deadlineInstant(d, times.decision(), times.deadline());
        if (now.isBefore(opens) || !now.isBefore(deadline)) {
            throw new InvalidRequestException(market.code() + " 수동 결정은 그 세션의 결정 창(" + Kst.stamp(opens) + " ~ "
                    + Kst.stamp(deadline) + " 전) 안에서만 받습니다 — 지금 " + Kst.stamp(now) + "(기준 거래일 " + d + ")");
        }
    }

    /** 자료 게이트가 하나라도 미달이면 400(수동 결정 — 정기 결정은 기다림). */
    private static void requireGates(List<KrDecisionGates.Gate> gates) {
        List<String> blocking = KrDecisionGates.blocking(gates);
        if (!blocking.isEmpty()) {
            throw new InvalidRequestException("자료 게이트 미달 — 수동 결정을 내지 않았습니다: " + String.join(" · ", blocking));
        }
    }

    // ------------------------------------------------------------------ 판정
    /**
     * 그 거래일에 아직 할 일 — 게이트 지표가 없음, 시작한 규칙 책의 그날 정기 결정(SCHEDULED·REBALANCE)이 없음, Claude 책이 그날
     * 결정을 내야 하는데 아직 없음(또는 재시도할 API 오류 — {@link #claudeSkipReason}).
     */
    private Work pendingWork(PaperMarket market, LocalDate d) {
        boolean claudeDue = claudeSkipReason(market, store.book(market.claudeBook()), d) == null;
        if (!usSteps(market)) {
            // 게이트 지표·13F 규칙 책은 미국 전용 단계, 한국 규칙 계좌는 한국 수급 규칙(클래스 설명).
            return new Work(false, krRulesSteps(market) && krRules.due(d), claudeDue);
        }
        Optional<Book> book = store.book(PaperBooks.RULES);
        boolean rules = book.isPresent() && !PaperBooks.NOT_STARTED.equals(book.get().status())
                && afterStart(book.get(), d) && rulesDecisionOn(d).isEmpty();
        return new Work(store.gate(d).isEmpty(), rules, claudeDue);
    }

    /** 출발일 뒤 거래일인가 — 출발일 이하는 초기 결정이 그날 결정이라 정기 결정을 내지 않습니다(두 책 같음). */
    private static boolean afterStart(Book book, LocalDate d) {
        return book.startedOn() != null && d.isAfter(book.startedOn());
    }

    /** 규칙 책의 그 거래일 정기 결정(REBALANCE 먼저, 없으면 SCHEDULED). 수동(MANUAL)은 정기 결정을 대신하지 않습니다. */
    private Optional<Decision> rulesDecisionOn(LocalDate d) {
        return store.decisionFor(PaperBooks.RULES, d, RuleBookService.REBALANCE)
                .or(() -> store.decisionFor(PaperBooks.RULES, d, RuleBookService.SCHEDULED));
    }

    /**
     * Claude 책이 그 거래일 정기 결정을 내야 하면 null, 아니면 내지 않는 이유 — 책 없음·운용 중 아님(시작 전·일시정지)·출발일
     * 이하(초기 결정이 그날 결정)·이미 결정함(재시도할 API 오류는 "낼 것"으로 봄, 명세 C7).
     */
    private String claudeSkipReason(PaperMarket market, Optional<Book> book, LocalDate d) {
        if (book.isEmpty()) {
            return "Claude 계좌 없음";
        }
        if (!PaperBooks.ACTIVE.equals(book.get().status())) {
            return PaperBooks.NOT_STARTED.equals(book.get().status()) ? "시작 전 — 결정을 내지 않습니다"
                    : "일시정지 중 — 결정을 내지 않습니다";
        }
        LocalDate startedOn = book.get().startedOn();
        if (startedOn == null || !d.isAfter(startedOn)) {
            return "출발일(" + startedOn + ") 이하 — 초기 결정이 그날 결정입니다";
        }
        Optional<Decision> existing = store.decisionFor(market.claudeBook(), d, RuleBookService.SCHEDULED);
        if (existing.isPresent() && !ClaudeBookService.retryable(existing.get())) {
            return "이미 결정함(" + existing.get().status() + ")";
        }
        return null;
    }

    /**
     * 그 분기의 매수 결정을 아직 내지 않았나 — 책이 재선정일 r 전에 시작했고, r 선정({@code selection_as_of = r})으로 낸
     * REBALANCE·INITIAL 결정이 없음. r 당일에는 늘 참이고(그날 처음 내는 결정), r을 놓쳤으면 다음 결정 날에도 참입니다. r에 선정을
     * 건너뛰어 지난 선정으로 낸 REBALANCE(매수 없음)는 세지 않습니다 — 날짜만 보면 그 분기 재선정을 다시 시도하지 않게 됩니다.
     * r 뒤에 시작한 책은 초기 결정이 그 분기 매수입니다.
     */
    private boolean rebalanceMissing(Book book, LocalDate reselectionDay) {
        if (book.startedOn() == null || !book.startedOn().isBefore(reselectionDay)) {
            return false;
        }
        return !store.hasDecisionWithSelection(PaperBooks.RULES,
                List.of(RuleBookService.REBALANCE, RuleBookService.INITIAL), reselectionDay);
    }

    /**
     * d의 종가 관측치인가 — 다수 티커의 봉 날짜가 d이고 그 봉의 종가가 나옴({@link PaperMarket#closeAvailable} — 미국: 마감 + 15분
     * 뒤에 수집, 설계 §6-1). 결정 작업의 기다림({@value #PRICES_NOT_FINAL})·미확정 순자산 줄과 복기 여는 조건이 씁니다(결정 d9).
     */
    static boolean closesFor(PaperMarket market, Quotes quotes, LocalDate d) {
        return d.equals(quotes.modalBarDate()) && market.closeAvailable(d, quotes.collectedAt());
    }

    /** 미국 관측치가 d의 확정가 관측치인가 — {@link #confirmedFor(PaperMarket, Quotes, LocalDate)}의 미국 판(미국 패킷이 씀). */
    static boolean confirmedFor(Quotes quotes, LocalDate d) {
        return confirmedFor(UsPaperMarket.INSTANCE, quotes, d);
    }

    /**
     * d의 확정가 관측치인가 — 다수 티커의 봉 날짜가 d이고 그 가격이 확정({@link PaperMarket#pricesConfirmed} — 미국은
     * {@link #closesFor}와 같음). 결정 행·패킷·작업 기록의 {@code pricesFinal}이 씁니다(결정 d9).
     */
    static boolean confirmedFor(PaperMarket market, Quotes quotes, LocalDate d) {
        return d.equals(quotes.modalBarDate()) && market.pricesConfirmed(d, quotes.collectedAt());
    }

    /** 미국 책의 결정 시각·마감 기한 — {@link #times(PaperMarket)}의 미국 판. */
    Times times() {
        return times(UsPaperMarket.INSTANCE);
    }

    /**
     * 설정의 결정 시각·마감 기한(그 시장의 {@code decisionTimeKst}·{@code decisionDeadlineKst} 키, "HH:mm" — 미국은 접두어 없음).
     * 없거나 틀리면 그 시장 기본값(미국 07:30·12:00). 읽은 값 그대로이고, 기한이 결정 시각보다 앞일 때의 뜻은 시장 규칙입니다
     * ({@link PaperMarket#deadlineInstant} — 미국은 결정 시각으로 봄: 기다리지 않고 바로 진행).
     */
    Times times(PaperMarket market) {
        return times(market, store.settings().map(PaperStore.SettingsRow::body).orElse(null));
    }

    /** 받은 설정 본문(실행이 읽은 판 — 없으면 null)의 결정 시각·마감 기한({@link #times(PaperMarket)}과 같은 규칙). */
    static Times times(PaperMarket market, JsonNode body) {
        return new Times(decisionTime(market, body),
                time(text(body, market.settingKey("decisionDeadlineKst")), market.defaultDeadline()));
    }

    /**
     * 설정 본문의 결정 시각({@code decisionTimeKst}) — 없거나 틀리면 07:30. 패킷의 사건 창({@code 11b_events})도 이 값으로 양 끝을
     * 정합니다: 결정 작업이 실제로 그 거래일 결정을 내는 시각과 같은 규칙이어야 창이 "직전 결정 이후(평일 24시간, 주말·휴장 뒤는
     * 그 사이 전부)"가 됩니다.
     */
    static LocalTime decisionTime(JsonNode body) {
        return decisionTime(UsPaperMarket.INSTANCE, body);
    }

    /** 설정 본문의 그 시장 결정 시각 — 없거나 틀리면 그 시장 기본값({@link #decisionTime(JsonNode)}의 시장 판). */
    static LocalTime decisionTime(PaperMarket market, JsonNode body) {
        return time(text(body, market.settingKey("decisionTimeKst")), market.defaultDecisionTime());
    }

    /** 설정 본문의 점 경로 값을 글로({@link Json#asText}와 같은 규칙 — 없거나 null이면 null). */
    private static String text(JsonNode body, String path) {
        JsonNode value = PaperSettingsService.valueAt(body, path);
        return value == null || value.isNull() ? null : value.asString("");
    }

    private static LocalTime time(String text, LocalTime fallback) {
        if (text == null || text.isBlank()) {
            return fallback;
        }
        try {
            return LocalTime.parse(text.trim());
        } catch (DateTimeParseException e) {
            return fallback;
        }
    }

    // ------------------------------------------------------------------ 게이트 지표
    /**
     * 그 거래일의 게이트 지표를 한 번 남깁니다(이미 있으면 그대로). 입력은 매크로 카드 저장본의 지금 값({@link PaperGate}),
     * 연속 일수는 <b>바로 전 거래일</b>의 기록에서 잇습니다 — 그 사이 기록이 빠졌으면(작업이 멈춘 날) 처음부터 셉니다. 빠진 날을
     * 참으로 이어 세면 확인되지 않은 '3일 연속'이 생기기 때문입니다. 같은 이유로 이어 쓴(isStale) 값·카드 시각이 그 거래일보다
     * 앞선 값도 그날 값으로 세지 않습니다({@link PaperGate#counted}).
     */
    GateRow recordGate(LocalDate d) {
        Optional<GateRow> existing = store.gate(d);
        if (existing.isPresent()) {
            return existing.get();
        }
        Optional<Snapshot> macro = reader.quietly(() -> reader.read(Datasets.SNAP_MACRO_COLLECTED,
                Datasets.MAX_AGE_REALTIME, "macro_collected"));
        Map<String, PaperGate.Input> read = PaperGate.read(macro.orElse(null));
        Map<String, Integer> previous = store.latestGateBefore(d)
                .filter(row -> row.tradingDate().equals(UsPaperMarket.INSTANCE.calendar().previousTradingDay(d)))
                .map(row -> PaperGate.streaks(row.streaks())).orElse(null);
        GateIndicator.Thresholds thresholds = settings.current().settings().gate();
        // 이어 쓴 값·그 거래일보다 앞선 값은 연속 일수에 넣지 않습니다(PaperGate.counted) — 기록에는 그대로 남김.
        GateIndicator.Result result = GateIndicator.evaluate(PaperGate.inputs(read, d), previous, thresholds);
        store.insertGateIfAbsent(new GateRow(d,
                mapper.valueToTree(PaperGate.inputsBody(read, d, result, thresholds, macro.orElse(null))),
                result.level(), mapper.valueToTree(result.streaks()), null));
        return store.gate(d).orElseThrow(() -> new IllegalStateException("게이트 지표를 남겼는데 다시 읽지 못했습니다: " + d));
    }

    // ------------------------------------------------------------------ 기록
    private void record(PaperMarket market, Instant started, String outcome, Map<String, Object> detail) {
        try {
            store.recordJobRun(market.jobName(JOB), started, clock.instant(), outcome, mapper.valueToTree(detail));
        } catch (RuntimeException e) {
            // 기록 실패가 결정(이미 커밋됨)을 오류로 바꾸지 않게 로그만 남깁니다.
            log.warn("모의 매매 결정 작업 기록을 남기지 못했습니다: {}", e.toString());
        }
    }

    /**
     * 그 세션 기다림 한 줄(2단계 명세 §4-9 'E0', 사용자 결정 v3 — 한국 결정 작업의 {@value #START_WAITING}·{@value #DATA_NOT_READY}). 그 세션의
     * 가장 최근 작업 기록이 같은 결과의 기다림이면 그 줄의 끝 시각·상세(마지막 판정)만 바꾸고 {@code checks}(이어진 주기 수)를 하나 올립니다 —
     * 10분마다 같은 줄이 작업 기록 200건을 밀어내지 않게. 다른 결과 뒤의 기다림(처음·결정·오류 뒤)은 새 줄입니다. 기한 뒤 판정(출발 미룸의 사유·
     * 기한 지남 행의 게이트)이 이 줄을 다시 읽으므로 재기동해도 같습니다. 기록 실패는 로그만 남깁니다.
     */
    private void recordWait(PaperMarket market, Instant started, LocalDate d, String outcome, Map<String, Object> detail) {
        try {
            String job = market.jobName(JOB);
            List<PaperStore.JobRun> records = store.jobRunsFor(job, d);
            PaperStore.JobRun last = records.isEmpty() ? null : records.get(0);
            Map<String, Object> body = new LinkedHashMap<>(detail);
            if (last != null && outcome.equals(last.outcome())) {
                JsonNode checks = last.detail() == null ? null : last.detail().get("checks");
                body.put("checks", (checks != null && checks.isInt() ? Math.max(1, checks.intValue()) : 1) + 1);
                store.updateJobRun(last.id(), clock.instant(), mapper.valueToTree(body));
            } else {
                body.put("checks", 1);
                store.recordJobRun(job, started, clock.instant(), outcome, mapper.valueToTree(body));
            }
        } catch (RuntimeException e) {
            log.warn("모의 매매 결정 작업의 기다림 기록을 남기지 못했습니다: {}", e.toString());
        }
    }

    private static Map<String, Object> ledgerDetail(Outcome outcome) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("filled", outcome.filled());
        out.put("stopped", outcome.stopped());
        out.put("expired", outcome.expired());
        out.put("splits", outcome.splits());
        out.put("booksProcessed", outcome.booksProcessed());
        out.put("skippedReason", outcome.skippedReason());
        if (!outcome.errors().isEmpty()) {
            out.put("errors", outcome.errors());
        }
        if (!outcome.alerts().isEmpty()) {
            out.put("alerts", outcome.alerts());
        }
        return out;
    }

    private static Map<String, Object> decisionDetail(Decision decision) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", decision.id());
        out.put("kind", decision.kind());
        out.put("status", decision.status());
        out.put("summary", Json.asText(decision.response(), "summary"));
        return out;
    }
}
