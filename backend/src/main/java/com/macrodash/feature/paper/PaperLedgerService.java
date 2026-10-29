package com.macrodash.feature.paper;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.KrxCorporateActions;
import com.macrodash.analytics.KrxCorporateActions.Assessment;
import com.macrodash.analytics.KrxCorporateActions.DailyBar;
import com.macrodash.analytics.KrxCorporateActions.Kind;
import com.macrodash.analytics.KrxCorporateActions.Listing;
import com.macrodash.analytics.KrxCorporateActions.Presence;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.SplitDetector;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/**
 * 🧪 관측치 하나를 그 시장 책들의 장부에 적용합니다(명세 L3~L9, 설계 §3-1) — 체결·트레일링 스탑·분할·평가·순자산.
 *
 * <p><b>시장마다 따로입니다</b>(2단계 명세 §9 A5). 관측치 처리·미확정 순자산 줄·'새 관측치가 있나'·오류 기억은 받은 시장
 * ({@link PaperMarket})의 책({@code paper_books.market})만 보고, 세션 날짜·확정 판정 셋(종가 나옴·그 시점 가격 있음·확정 — 결정 d9)·
 * 분할 기준 이력·체결 조건(체결가·관측가·가격 출처·비용 칸·살 수 있는 수량 — {@link PaperMarket#fill}, 결정 d10)·스탑 뒤 재진입 금지
 * 거래일도 그 시장 묶음에서 가져옵니다. 다른 시장 책은 읽지도 쓰지도 않습니다 — 그러지 않으면 미국 관측치가 한국 책의 멱등 키
 * ({@code lastProcessedCollectedAt})를 미국 수집 시각으로 밀어 한국 관측치가 '이미 처리함'으로 버려집니다. 시장을 받지 않는 옛
 * 시그니처는 미국 책만 처리합니다(결정 작업이 시장 문맥으로 옮겨 가는 A6 전까지 그대로 부름). 사후 체결({@link #backfill})은 미국
 * 책만 받습니다(한국은 출발일 사후 체결이 없음, 명세 K28). <b>설정과 달력은 실행 문맥에서</b>(C1a) — 슬리피지·트레일링 스탑·재진입 금지
 * 거래일·현금성 종목은 그 실행({@link MarketRun})이 읽은 설정 행으로, 세션·확정 판정은 그 실행의 달력 한 벌로 셉니다. 장부가 설정을
 * 따로 읽지 않습니다. 키는 그 시장의 설정 접두어 아래이고 현금성이 없으면 그 시장 기본값입니다({@link PaperSettings#from(JsonNode,
 * PaperMarket)} — 미국은 접두어 없이 지금 키·SHY).
 *
 * <p><b>책마다 한 트랜잭션입니다</b>({@link PaperStore#atomically}). 한 책에서 오류가 나면 그 책만 되돌리고 다른 책은 계속합니다.
 * 그 책은 상태(멱등 키)가 바뀌지 않아 그대로 두면 정기 작업이 같은 저장본으로 5분마다 다시 돌며 같은 오류를 기록합니다(입력이
 * 같으면 대개 같은 예외 — 작업 기록 200건이 오류로 밀림). 그래서 실패한 (책, 수집 시각)을 메모리에 기억해 <b>같은 관측치로는
 * 다시 시도하지 않고</b>, 새 관측치가 오면 다시 시도합니다(미국 {@code paper.quotes}는 수집기가 1시간마다 저장, 한국 {@code paper.kr.quotes}는
 * KR 거래일마다 한 번이라 그 밤에는 새 관측치가 없음 — 한국 결정 게이트 ①이 그 계좌를 기한까지 기다리게 함, {@link KrDecisionGates}). 수동
 * 실행은 그 시장 기억을 지우고 한 번 더 시도합니다({@link #forgetFailures(PaperMarket)} — 미국 {@code POST /api/paper/run/risk}, 한국
 * {@code POST /api/paper/run/risk?market=KR} — 2단계 F1).
 * 기억은 재기동하면 사라집니다 — 그때 한 번 더 시도하는 것은 괜찮습니다.
 *
 * <p><b>멱등</b>: 저장본 수집 시각이 그 책의 {@code lastProcessedCollectedAt} 이하이면 건너뜁니다. 같은 저장본을 두 번 넣어도
 * 체결·스탑·순자산은 한 번입니다. 같은 JVM 안에서 정기 작업과 수동 실행이 겹치지 않게 {@link #exclusively}로 줄을 세웁니다
 * (둘이 같은 상태를 동시에 읽으면 스탑 매도가 두 번 들어갑니다). 백엔드는 한 프로세스라 JVM 안의 잠금으로 충분합니다.
 *
 * <p><b>처리 순서</b>(책 하나, 설계 §3-1):
 * <ol>
 *   <li>만료(기준 거래일 + 3거래일이 지난 대기 주문)·지난 재진입 금지 정리 — 체결보다 먼저(만료된 주문이 오늘 봉으로 체결되지 않게)</li>
 *   <li>분할 감지·가격 갱신 — <b>체결·스탑보다 먼저</b>. 그러지 않으면 2:1 분할 뒤 반값이 된 관측가가 분할 전 최고가와 비교돼
 *       가짜 스탑이 나고, 매도 수량도 분할 전 수량으로 계산됩니다.</li>
 *   <li>(미국 시각 지정 주문 — 명세 2026-10-30 §10-1, {@link UsTimedFills}) 2b 시각 지정 체결(기준 시각 T가 이 관측치 전인 주문을 1분봉 저장본의
 *       T 봉으로, T 순) → 3a 끝난 세션의 남은 주문을 그 세션 종가 또는 만료로 → 3b 새 보유의 평가 가격을 이 관측치로. 시각 지정 주문은 1의 만료에서
 *       빼고 여기서 만료하며, 시간별 체결(아래 매도·매수)은 그 주문을 보지 않습니다({@link UsPaperMarket#fillable}). 그런 주문이 있는 책은 이 관측치
 *       뒤의 1분봉 저장본을 최대 {@link UsTimedFills#BARS_WAIT} 기다립니다(그동안 그 책은 처리하지 않고 멱등 키 그대로 — 오류가 아님,
 *       {@link Outcome#waiting}). 그런 주문이 없는 책은 이 단계가 아무 일도 하지 않습니다.</li>
 *   <li>대기 매도 체결</li>
 *   <li>최고가 갱신 → 트레일링 스탑 — 그 관측치로 즉시 전량 매도 + 재진입 금지</li>
 *   <li>대기 매수 체결 — <b>스탑 뒤</b>. 이번 관측치에서 스탑에 걸린 종목의 대기 매수는 방금 건 재진입 금지로 취소됩니다
 *       (매수가 먼저면 사자마자 같은 관측치의 스탑으로 다시 팔려 슬리피지만 두 번 냅니다). 매도·스탑으로 생긴 현금은 쓸 수 있습니다.</li>
 *   <li>평가 → 그 세션의 마감 뒤 관측치면 그 거래일 순자산 → 상태(멱등 키) 저장</li>
 * </ol>
 * 일시정지(PAUSED) 책은 2·4의 최고가 갱신·6만(가격·분할·최고가는 따라가되 사고팔지 않음), 시작 전(NOT_STARTED) 책은 6의 상태만
 * (현금뿐이라 순자산 기록은 남기지 않음 — 시작하지 않은 책의 곡선이 평평하게 그려지지 않게).
 *
 * <p><b>한국 — 시가 체결 장부</b>({@link PaperMarket#auctionFills}, 2단계 C2b·C2c): 1 뒤 명세 §4-2 순서 — 기업행위(3중 조건, 결정 d12) → 시가
 * 매도(STOP 포함) → 시가 매수 → 종가 매도 → 종가 매수(현금성은 각 묶음 마지막) → 최고가·스탑 감지 → 평가 → 6. 체결 봉·체결가·비용 칸은
 * 시장 몫이고({@link PaperMarket#fillBar} — 기준 거래일 뒤 첫 관측 봉의 시가 사다리, {@link PaperMarket#fill} — 비용 칸·보류), 체결 조건 ①은
 * 저장본이 아니라 그 종목을 받은 시각입니다. 미국식 분할 감지·관측가 최고가·즉시 스탑은 쓰지 않습니다({@code processAuction}).
 *
 * <p><b>한국 — 금융위 확정 조정</b>({@link PaperMarket#confirmsFills}, 2단계 K29 — C3 {@link KrConfirmations}): 관측치를 처리하기 <b>전에</b> 책마다
 * 확정 안 된 체결을 금융위 시가로 확정하고(체결마다 한 행·현금·평단·최고가) 마지막 순자산 줄을 금융위 종가로 다시 씁니다 — 금융위 D 값이 들어온
 * 밤에 D+1 관측치보다 앞서야 장부가 D 마감 상태일 때 D 줄을 확정할 수 있습니다. 리스크 점검은 새 관측치가 없는 주기에도 확정 조정만 돌립니다
 * ({@link #confirm}). 관측치가 쓰는 한국 순자산 줄은 잠정이고(토스 관측치는 확정가가 아님), 현금뿐인 줄도 그날까지의 체결이 모두 확정됐을 때만
 * 확정입니다.
 *
 * <p><b>순자산 줄</b>: 관측 시각의 세션(시장 달력의 {@code currentOrLastSession})이 다수 티커의 봉 날짜와 같고 그 봉의 종가가
 * 나왔을 때만({@link PaperMarket#closeAvailable}) 그 거래일 줄을 씁니다 — 다음 날 개장 직후에는 새 봉의 과반이 아직 전날 날짜라, 이 조건이 없으면 장중가와 그날
 * 체결이 섞인 평가가 전날 확정 줄을 덮습니다(주말·휴장일·개장 전 재저장은 세션이 그대로라 다시 씀). 확정 표시
 * ({@code prices_final})는 <b>책마다</b> 정합니다: 수량이 있는 보유가 모두 그 세션의 확정 봉(이어 쓴 봉 아님, 분할 확인됨, 시장의
 * {@link PaperMarket#pricesConfirmed})으로 평가됐을 때만 true, 하나라도 마지막으로 본 값(장중 값일 수 있음)으로 평가했으면 false — 확정 줄은 미확정 값으로 덮이지
 * 않으므로({@link PaperStore#upsertNav}) 나중에 온전한 확정 관측치가 그 줄을 바로잡습니다.
 *
 * <p><b>체결 조건</b>(룩어헤드 방지, 설계 §3-1): ① 관측치 수집 시각 &gt; 주문 생성 시각, ② 봉 날짜 &gt; 주문의 기준 거래일 — 주말·휴장일에
 * 수집기가 직전 종가를 매시간 다시 저장하므로 ①만으로는 결정이 이미 본 종가로 체결됩니다, ③ 그 시점의 체결 가격이 있음(시장 묶음의
 * {@link PaperMarket#fillable} — 미국: {@code NEXT_CLOSE}면 마감 + 15분 뒤 수집), ④ 이어 쓴({@code isStale}) 봉은 다음 관측치를 기다립니다.
 *
 * <p><b>분할 감지 기준(fill_ref_date·fill_ref_close)</b>: 늘 <b>종가</b> 하나(시장의 {@link PaperMarket#closeAvailable})를 기준으로 둡니다. 장중에 체결하면 그 봉(지연 시세)이
 * 아니라 직전 거래일 종가를 기준으로 삼습니다 — 장중 체결가와 그날 종가가 10% 넘게 벌어지면 '8:7 분할' 같은 가짜 분할로 읽히기
 * 때문입니다. 확정 종가 관측치가 오면 기준을 그날로 옮기고(분할이 없음을 확인한 뒤), 배당 조정으로 기준일 값이 조금 바뀌면 그 값을
 * 따라갑니다 — 차이가 몇 년 쌓여 3%를 넘으면 엉뚱한 비율로 감지되기 때문입니다. 그래서 기준일은 대개 며칠 안이고, 기준일 종가는
 * 먼저 같은 저장본의 3개월 일봉에서, 없으면 10년 이력에서 찾습니다(관측치와 같은 저장본을 먼저 봐야, 분할이 시세에는 반영됐는데
 * 12시간 주기의 이력에는 아직 안 된 틈에 가짜 스탑이 나지 않음). 둘 다 없으면 분할 여부를 모르니 그 보유는 '가격 없음'으로 두고
 * 가격·최고가를 바꾸지 않습니다(스탑도 보지 않음).
 *
 * <p>가격을 모르는 보유(봉이 없거나 이어 쓴 봉)는 마지막으로 본 가격으로, 그것도 없으면 평단으로 평가하고 '가격 없음'
 * ({@code priceStale})으로 표시합니다. 0으로 평가하지 않습니다.
 */
@Service
public class PaperLedgerService {

    private static final Logger log = LoggerFactory.getLogger(PaperLedgerService.class);

    /** split_note에 남기는 최대 길이 — 분할이 여러 번 쌓여도 행이 끝없이 길어지지 않게(앞의 기록부터 남김). */
    static final int SPLIT_NOTE_MAX = 500;

    /**
     * 처리 한 번의 결과.
     *
     * @param booksProcessed 이번 관측치를 적용한 책(멱등으로 건너뛴 책은 빠짐)
     * @param skippedReason  아무 책도 처리하지 않았을 때 그 이유(처리했으면 null)
     * @param notes          체결하지 못하고 취소한 주문·현금 부족으로 줄인 매수·분할처럼 사람이 알아야 할 일("책: 내용")
     * @param errors         오류로 되돌린 책("책: 오류") — 그 책은 같은 관측치로는 다시 시도하지 않고 새 관측치에서 다시 시도합니다
     * @param alerts         운영 알림("책: 내용") — 한국 '미처리 기업행위' 보류가 걸린 날 뒤 5거래일을 넘김(명세 §4-2 K32 — 사람이 확인), 미국
     *                       시각 지정 체결의 장부 재검사가 주문·1분봉 봉을 거절함({@link UsTimedFills} — 시각 지정 주문이 있는 계좌만).
     *                       정기·수동 작업이 작업 기록({@code paper_job_runs.detail.alerts})에 남깁니다. 비었으면 응답 JSON(수동 실행
     *                       {@code POST /api/paper/run/risk})에 칸이 없습니다(시각 지정 주문이 없는 미국 응답 그대로)
     * @param confirmed      이번에 쓴 확정 조정 행 수(한국 금융위 확정 — K29, C3 {@link KrConfirmations}). 미국은 늘 0이고, 0이면 응답 JSON에 칸이
     *                       없습니다(미국 응답 그대로)
     * @param waiting        1분봉 기다림으로 이번에 처음 미룬 책("책: 사유" — 미국 시각 지정 주문, 명세 2026-10-30 §10-2). 그 책은 멱등 키가 그대로라
     *                       다음 점검이 같은 관측치로 다시 봅니다(오류가 아님 — 실패 기억에 넣지 않음). 비었으면 응답 JSON에 칸이 없습니다
     * @param stillWaiting   같은 관측치로 다시 미룬 책("책: 사유") — 정기 작업은 이것만 있는 주기를 기록하지 않습니다(첫 미룸·풀림만). 비었으면 칸 없음
     */
    public record Outcome(int filled, int stopped, int expired, int splits, List<String> booksProcessed,
                          String skippedReason, List<String> notes, List<String> errors,
                          @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> alerts,
                          @JsonInclude(JsonInclude.Include.NON_DEFAULT) int confirmed,
                          @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> waiting,
                          @JsonInclude(JsonInclude.Include.NON_EMPTY) List<String> stillWaiting) {

        public Outcome {
            booksProcessed = List.copyOf(booksProcessed);
            notes = List.copyOf(notes);
            errors = List.copyOf(errors);
            alerts = List.copyOf(alerts);
            waiting = List.copyOf(waiting);
            stillWaiting = List.copyOf(stillWaiting);
        }

        /** 1분봉 기다림이 없는 결과. */
        public Outcome(int filled, int stopped, int expired, int splits, List<String> booksProcessed,
                       String skippedReason, List<String> notes, List<String> errors, List<String> alerts,
                       int confirmed) {
            this(filled, stopped, expired, splits, booksProcessed, skippedReason, notes, errors, alerts, confirmed,
                    List.of(), List.of());
        }

        /** 확정 조정이 없는 결과. */
        public Outcome(int filled, int stopped, int expired, int splits, List<String> booksProcessed,
                       String skippedReason, List<String> notes, List<String> errors, List<String> alerts) {
            this(filled, stopped, expired, splits, booksProcessed, skippedReason, notes, errors, alerts, 0);
        }

        /** 운영 알림이 없는 결과. */
        public Outcome(int filled, int stopped, int expired, int splits, List<String> booksProcessed,
                       String skippedReason, List<String> notes, List<String> errors) {
            this(filled, stopped, expired, splits, booksProcessed, skippedReason, notes, errors, List.of());
        }

        /**
         * 확정 조정({@code confirmation})을 먼저 한 뒤 관측치를 처리한 결과({@code this}) — 셈·처리한 책·건너뛴 사유는 관측치 처리 쪽, 확정 조정
         * 행 수는 확정 쪽, 기록(notes·errors·alerts)은 확정 쪽이 앞입니다.
         */
        Outcome after(Outcome confirmation) {
            List<String> mergedNotes = new ArrayList<>(confirmation.notes());
            mergedNotes.addAll(notes);
            List<String> mergedErrors = new ArrayList<>(confirmation.errors());
            mergedErrors.addAll(errors);
            List<String> mergedAlerts = new ArrayList<>(confirmation.alerts());
            mergedAlerts.addAll(alerts);
            return new Outcome(filled, stopped, expired, splits, booksProcessed, skippedReason, mergedNotes, mergedErrors,
                    mergedAlerts, confirmed + confirmation.confirmed(), waiting, stillWaiting);
        }

        static Outcome skipped(String reason) {
            return new Outcome(0, 0, 0, 0, List.of(), reason, List.of(), List.of());
        }

        static Outcome failed(String error) {
            return new Outcome(0, 0, 0, 0, List.of(), null, List.of(), List.of(error));
        }
    }

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final ObjectMapper mapper;
    /** 장부를 바꾸는 일(관측치 처리·초기화·리셋·일시정지)을 한 줄로 세웁니다(클래스 설명). 시장이 여럿이어도 잠금은 하나입니다. */
    private final ReentrantLock lock = new ReentrantLock();
    /**
     * (시장, 책) → 처리하다 오류가 난 관측치의 수집 시각. 같은 관측치로 다시 시도하지 않으려고 기억합니다(클래스 설명). 시장마다
     * 관측치 저장본이 다르므로 기억도 시장마다 따로 봅니다 — 한 시장의 실패가 다른 시장 관측치를 막거나 지워지지 않게.
     */
    private final Map<FailureKey, Instant> failedObservations = new ConcurrentHashMap<>();

    private record FailureKey(String market, String book) {
    }

    /** 한국 금융위 확정 조정(K29, C3) — 확정 조정 시장({@link PaperMarket#confirmsFills})의 책마다 관측치 처리 앞에서 돕니다. */
    private final KrConfirmations confirmations;
    /**
     * (시장, 책) → 확정 조정에서 마지막으로 난 오류 문구. 확정 조정은 새 관측치가 없어도 5분마다 돌므로, 같은 오류를 결과({@link Outcome#errors})에
     * 다시 올리지 않습니다(작업 기록 200건이 같은 오류로 밀리지 않게 — 관측치 처리 오류의 기억과 같은 뜻). 성공하면 지우고, 수동 실행이 지웁니다.
     */
    private final Map<FailureKey, String> confirmErrors = new ConcurrentHashMap<>();

    /** 미국 시각 지정 체결(2b·3a·3b — 미국 Claude 계좌2 실험, 명세 2026-10-30 §10-1) — 시각 지정 주문이 있는 미국 책에서만 일합니다. */
    private final UsTimedFills timedFills;
    /**
     * (시장, 책) → 1분봉 기다림으로 미룬 관측치의 수집 시각(명세 2026-10-30 §10-2). 같은 관측치를 다시 미룬 주기는 기록하지 않으려고({@link Outcome#stillWaiting})
     * 기억합니다 — 오류 기억({@link #failedObservations})과 따로라 미룬 책은 '오류 난 책'으로 세지 않습니다. 풀리면 지웁니다. 재기동하면 사라집니다(그때 한 번
     * 더 기록하는 것은 괜찮음).
     */
    private final Map<FailureKey, Instant> barsWaits = new ConcurrentHashMap<>();
    /** 지금 시각 — 1분봉 기다림의 상한(관측치 수집 + {@link UsTimedFills#BARS_WAIT})을 셉니다. */
    private final java.time.Clock clock;

    /** 설정은 실행이 읽은 행으로 받습니다({@link MarketRun#settings}) — 장부가 따로 읽지 않습니다. */
    @org.springframework.beans.factory.annotation.Autowired
    public PaperLedgerService(PaperStore store, PaperMarketData marketData, ObjectMapper mapper) {
        this(store, marketData, mapper, java.time.Clock.systemUTC());
    }

    /** 시험용 — 시계(확정 조정이 최고가를 다시 셀 때의 시각·1분봉 기다림의 상한)를 정합니다. */
    PaperLedgerService(PaperStore store, PaperMarketData marketData, ObjectMapper mapper, java.time.Clock clock) {
        this.store = store;
        this.marketData = marketData;
        this.mapper = mapper;
        this.clock = clock;
        this.confirmations = new KrConfirmations(store, marketData, clock);
        this.timedFills = new UsTimedFills(store, mapper);
    }

    /** 장부를 바꾸는 다른 일(관리 서비스)도 이 잠금 안에서 합니다. */
    <T> T exclusively(Supplier<T> work) {
        lock.lock();
        try {
            return work.get();
        } finally {
            lock.unlock();
        }
    }

    /** 미국 책에 아직 적용하지 않은 관측치인가 — {@link #hasNewObservation(PaperMarket, Quotes)}의 미국 판. */
    public boolean hasNewObservation(Quotes quotes) {
        return hasNewObservation(UsPaperMarket.INSTANCE, quotes);
    }

    /**
     * 이 관측치를 아직 적용하지 않은 그 시장 책이 하나라도 있나(정기 작업이 '할 일 없음'을 기록하지 않으려고 먼저 봄). 이 관측치에서
     * 이미 오류가 난 책은 세지 않습니다 — 같은 관측치로 다시 시도하지 않습니다(클래스 설명). 다른 시장 책은 보지 않습니다.
     */
    boolean hasNewObservation(PaperMarket market, Quotes quotes) {
        if (!store.ready()) {
            return false;
        }
        for (Book book : store.books(market.code())) {
            Optional<BookState> state = store.state(book.code());
            if (state.isPresent() && isNew(quotes, state.get()) && !failedOn(market, book.code(), quotes)) {
                return true;
            }
        }
        return false;
    }

    /** 이 관측치에서 오류가 나 다시 시도하지 않고 있는 미국 책 — {@link #failedBooks(PaperMarket, Quotes)}의 미국 판. */
    public List<String> failedBooks(Quotes quotes) {
        return failedBooks(UsPaperMarket.INSTANCE, quotes);
    }

    /** 이 관측치에서 오류가 나 다시 시도하지 않고 있는 그 시장 책, 정의 순. */
    List<String> failedBooks(PaperMarket market, Quotes quotes) {
        return failedObservations.keySet().stream().filter(key -> key.market().equals(market.code()))
                .map(FailureKey::book).filter(code -> failedOn(market, code, quotes)).sorted(market.bookOrder())
                .toList();
    }

    /** 모든 시장의 오류 난 관측치 기억을 지웁니다 — 초기화·리셋 뒤 같은 관측치로 다시 처리해도 되게. */
    public void forgetFailures() {
        failedObservations.clear();
        confirmErrors.clear();
        barsWaits.clear();
    }

    /** 그 시장의 오류 난 관측치 기억만 지웁니다 — 수동 실행이 같은 관측치로 한 번 더 시도하게(다른 시장의 기억은 그대로). */
    void forgetFailures(PaperMarket market) {
        failedObservations.keySet().removeIf(key -> key.market().equals(market.code()));
        confirmErrors.keySet().removeIf(key -> key.market().equals(market.code()));
    }

    /**
     * 그 시장 책이 수집 시각 {@code collectedAt}의 관측치를 처리하면서 그날 보류한 주문 종목(코드 → 사유 — 시가 체결 장부의 기업행위 판정,
     * 그 종목 주문은 대기 그대로). 장부가 처리할 때 그 대기 주문 행에 남긴 표시({@code paper_orders.ledger_hold_*}, V16 — 사용자 결정 v3,
     * 2단계 명세 §4-9 'E0')를 읽으므로 백엔드를 재기동해도 같습니다(그 관측치는 이미 처리해 다시 처리하지 않음). 표시의 수집 시각이 그 관측치와
     * 다르면(장부가 그 관측치로 그 책을 처리하지 못했거나 다른 관측치를 처리함) 빈 표입니다 — 모르는 보류를 짐작하지 않습니다.
     */
    Map<String, String> orderHolds(PaperMarket market, String book, Instant collectedAt) {
        if (collectedAt == null) {
            return Map.of();
        }
        Instant observed = collectedAt.truncatedTo(ChronoUnit.MICROS);   // timestamptz는 마이크로초까지
        Map<String, String> out = new LinkedHashMap<>();
        for (PaperStore.LedgerHold hold : store.ledgerHolds(book)) {
            if (hold.collectedAt() != null && observed.equals(hold.collectedAt().truncatedTo(ChronoUnit.MICROS))) {
                out.putIfAbsent(hold.ticker(), hold.reason());
            }
        }
        return out;
    }

    private boolean failedOn(PaperMarket market, String code, Quotes quotes) {
        return quotes.collectedAt().equals(failedObservations.get(new FailureKey(market.code(), code)));
    }

    private static boolean isNew(Quotes quotes, BookState state) {
        Instant last = state.lastProcessedCollectedAt();
        return last == null || quotes.collectedAt().isAfter(last);
    }

    /** 미국 관측치 하나를 미국 책에 적용합니다 — {@link #process(PaperMarket, Quotes)}의 미국 판. */
    public Outcome process(Quotes quotes) {
        return process(UsPaperMarket.INSTANCE, quotes);
    }

    /**
     * 그 시장의 관측치 하나를 그 시장 책 모두에 적용합니다(클래스 설명). 다른 시장 책은 건드리지 않습니다. 실행({@link MarketRun})을 받으면
     * 그 실행의 달력·설정 행으로, 시장 묶음을 받으면(미국 판·시험) 고정 달력과 지금 설정 행으로 실행을 그 자리에서 엽니다
     * ({@link MarketRun#of}).
     */
    Outcome process(PaperMarket market, Quotes quotes) {
        MarketRun run = MarketRun.of(market, store);
        return exclusively(() -> {
            if (!run.confirmsFills()) {
                return processLocked(run, quotes);
            }
            // 확정 조정을 먼저(K29, C3) — 금융위 D 값이 들어온 밤에 D+1 관측치보다 앞서 D 체결을 확정해야, 장부가 D+1로 넘어가기 전에 확정
            // 현금으로 D+1 시가 체결을 셉니다.
            Outcome confirmation = confirmLocked(run, false);
            return processLocked(run, quotes).after(confirmation);
        });
    }

    /**
     * 그 시장 책의 금융위 확정 조정만 한 번({@link KrConfirmations}, 명세 K29 — C3). 리스크 점검이 새 관측치가 없는 주기에 부릅니다(금융위 값은
     * 관측치와 따로 들어오므로). 확정 조정 시장이 아니면 아무것도 하지 않습니다. 한 책의 오류는 그 책만 되돌리고, 같은 오류는 결과에 다시
     * 올리지 않습니다({@link #confirmErrors}). 결과의 {@code booksProcessed}는 확정 조정 행을 썼거나 순자산 줄이 확정이 된 책, {@code confirmed}는 쓴 행
     * 수이고, 한 일이 없으면 {@code skippedReason}이 있습니다. 지난 주기와 입력이 같고 그때 할 일이 없었던 책은 금융위 시세를 다시 읽지 않습니다
     * ({@link KrConfirmations#confirm(MarketRun, Book, boolean)} — 5분마다 범위 읽기가 쌓이지 않게).
     */
    Outcome confirm(PaperMarket market) {
        MarketRun run = MarketRun.of(market, store);
        if (!run.confirmsFills()) {
            return Outcome.skipped("확정 조정이 없는 시장입니다(" + run.code() + ")");
        }
        return exclusively(() -> confirmLocked(run, true));
    }

    /** @param reuseIdle 새 관측치가 없는 주기인가(지난 주기와 입력이 같으면 시세를 다시 읽지 않음 — 관측치 처리 앞에서는 false) */
    private Outcome confirmLocked(MarketRun market, boolean reuseIdle) {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다(V8·V9 적용 전)");
        }
        List<Book> books = new ArrayList<>(store.books(market.code()));
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        int confirmed = 0;
        List<String> worked = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (Book book : books) {
            if (!PaperBooks.ACTIVE.equals(book.status()) && !PaperBooks.PAUSED.equals(book.status())) {
                continue;   // 시작 전 책은 체결이 없음
            }
            FailureKey key = new FailureKey(market.code(), book.code());
            try {
                KrConfirmations.Result result = store.atomically(() -> confirmations.confirm(market, book, reuseIdle));
                confirmErrors.remove(key);
                confirmed += result.confirmed();
                if (result.worked()) {
                    worked.add(book.code());
                }
                result.notes().forEach(note -> notes.add(book.code() + ": " + note));
            } catch (RuntimeException e) {
                String message = book.code() + ": 확정 조정 " + e.getClass().getSimpleName() + " " + e.getMessage();
                if (!message.equals(confirmErrors.put(key, message))) {
                    log.warn("모의 매매 확정 조정 실패({}) — 이 책만 되돌렸고 다음 주기에 다시 시도합니다(같은 오류는 다시 올리지 않음): {}",
                            book.code(), e.toString());
                    errors.add(message);
                }
            }
        }
        String skipped = worked.isEmpty() && errors.isEmpty() ? "새로 확정할 체결이 없습니다" : null;
        return new Outcome(0, 0, 0, 0, worked, skipped, notes, errors, List.of(), confirmed);
    }

    private Outcome processLocked(MarketRun market, Quotes quotes) {
        if (!store.ready()) {
            return Outcome.skipped("모의 매매 테이블이 아직 없습니다(V8·V9 적용 전)");
        }
        List<Book> books = new ArrayList<>(store.books(market.code()));
        if (books.isEmpty()) {
            return Outcome.skipped("초기화 전입니다 — 계좌가 없습니다");
        }
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        // 그 실행이 읽은 설정 행(클래스 설명의 설정).
        PaperSettings current = market.settings();
        if (market.settingsRow().isPresent() && !current.fallbacks().isEmpty()) {
            log.warn("모의 매매 설정 v{}의 키 {}가 없거나 범위 밖이라 기본값으로 읽습니다", market.settingsVersion(),
                    current.fallbacks());
        }

        // 그 시장이 체결 전에 덧붙이는 종목 정보(한국: 금융위 시장 구분 — 비용 종목 구분). 미국은 그대로입니다.
        Quotes observed = market.withListings(quotes, marketData);
        JsonNode settingsBody = market.settingsBody();
        // 미국 시각 지정 체결의 1분봉 저장본 — 풀어야 할 시각 지정 주문이 있는 책이 처음 물을 때 한 번만 읽습니다(그 밖에는 읽지 않음).
        Supplier<UsTimedFills.Bars> bars = market.definition() == UsPaperMarket.INSTANCE ? once(
                () -> UsTimedFills.Bars.of(marketData.barsUs())) : null;

        int filled = 0;
        int stopped = 0;
        int expired = 0;
        int splits = 0;
        List<String> processed = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        List<String> alerts = new ArrayList<>();
        List<String> heldBack = new ArrayList<>();
        List<String> waiting = new ArrayList<>();
        List<String> stillWaiting = new ArrayList<>();
        for (Book book : books) {
            FailureKey key = new FailureKey(market.code(), book.code());
            if (failedOn(market, book.code(), quotes)) {
                heldBack.add(book.code());   // 이 관측치에서 이미 오류가 남 — 새 관측치까지 기다림(클래스 설명)
                continue;
            }
            try {
                BookRun run = store.atomically(() -> processBook(market, book, observed, current, settingsBody, bars));
                failedObservations.remove(key);
                if (run == null) {
                    continue;
                }
                if (run.barsWait != null) {
                    // 1분봉 기다림(명세 2026-10-30 §10-2) — 아무것도 쓰지 않았고 멱등 키도 그대로라 다음 점검이 같은 관측치로 다시 봅니다. 오류가
                    // 아니므로 실패 기억에 넣지 않습니다. 같은 관측치를 다시 미룬 것이면 stillWaiting(정기 작업이 기록하지 않음).
                    boolean first = !quotes.collectedAt().equals(barsWaits.put(key, quotes.collectedAt()));
                    (first ? waiting : stillWaiting).add(book.code() + ": " + run.barsWait);
                    continue;
                }
                Instant waited = barsWaits.remove(key);
                if (quotes.collectedAt().equals(waited) && run.barsReleased != null) {
                    notes.add(book.code() + ": 1분봉 기다림 풀림 — " + run.barsReleased);   // 미뤘던 그 관측치를 처리함
                }
                processed.add(book.code());
                filled += run.filled;
                stopped += run.stopped;
                expired += run.expired;
                splits += run.splits;
                run.notes.forEach(note -> notes.add(book.code() + ": " + note));
                run.alerts.forEach(alert -> alerts.add(book.code() + ": " + alert));
            } catch (RuntimeException e) {
                // 같은 관측치로는 다시 시도하지 않으니 이 경고는 관측치마다 한 번입니다.
                failedObservations.put(key, quotes.collectedAt());   // 되돌린 처리의 보류 표시도 앞 그대로(앞 관측치의 수집 시각)
                log.warn("모의 매매 장부 처리 실패({}, 관측치 {}) — 이 책만 되돌렸고, 같은 관측치로는 다시 시도하지 않고 "
                        + "새 관측치에서 다시 시도합니다: {}", book.code(), Kst.stamp(quotes.collectedAt()), e.toString());
                errors.add(book.code() + ": " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }
        String skipped = null;
        if (processed.isEmpty() && errors.isEmpty()) {
            List<String> deferred = new ArrayList<>(waiting);
            deferred.addAll(stillWaiting);
            skipped = !heldBack.isEmpty() ? heldBackReason(quotes, heldBack)
                    : !deferred.isEmpty() ? barsWaitReason(quotes, deferred)
                    : "이미 처리한 관측치입니다(수집 " + Kst.stamp(quotes.collectedAt()) + ")";
        }
        return new Outcome(filled, stopped, expired, splits, processed, skipped, notes, errors, alerts, 0, waiting,
                stillWaiting);
    }

    /** 1분봉 기다림으로 미룬 책만 남은 관측치의 사유 문구(명세 2026-10-30 §10-2). */
    static String barsWaitReason(Quotes quotes, List<String> deferred) {
        List<String> codes = deferred.stream().map(entry -> entry.substring(0, entry.indexOf(':'))).toList();
        return "수집 " + Kst.stamp(quotes.collectedAt()) + " 관측치는 1분봉 기다림 중인 계좌(" + String.join(", ", codes)
                + ")만 남았습니다 — 그 관측치 뒤의 1분봉 저장본이 들어오거나 " + UsTimedFills.BARS_WAIT.toMinutes()
                + "분이 지나면 처리합니다";
    }

    /** 한 번만 계산하는 공급자(한 처리 안 — 잠금 안이라 동기화하지 않음). */
    private static <T> Supplier<T> once(Supplier<T> work) {
        return new Supplier<>() {
            private T value;
            private boolean done;

            @Override
            public T get() {
                if (!done) {
                    value = work.get();
                    done = true;
                }
                return value;
            }
        };
    }

    /** 오류가 난 책만 남은 관측치의 사유 문구(정기 작업도 같은 문구를 씀). */
    static String heldBackReason(Quotes quotes, List<String> books) {
        return "수집 " + Kst.stamp(quotes.collectedAt()) + " 관측치에서 오류가 난 계좌(" + String.join(", ", books)
                + ")는 같은 관측치로 다시 시도하지 않습니다 — 새 관측치에서 다시 시도합니다(수동 실행은 한 번 더 시도)";
    }

    /**
     * 책 하나(트랜잭션 안). 이미 처리한 관측치면 null, 1분봉 기다림으로 미뤘으면 {@code barsWait}가 든 실행(아무것도 쓰지 않음).
     *
     * @param bars 미국 시각 지정 체결의 1분봉 저장본(한 처리에 한 번 읽음) — 미국이 아니면 null
     */
    private BookRun processBook(PaperMarket market, Book book, Quotes quotes, PaperSettings current,
                                JsonNode settingsBody, Supplier<UsTimedFills.Bars> bars) {
        Optional<BookState> stateRow = store.state(book.code());
        if (stateRow.isEmpty()) {
            throw new IllegalStateException("계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요");
        }
        BookState state = stateRow.get();
        if (!isNew(quotes, state)) {
            return null;
        }
        BookRun run = new BookRun(market, book, quotes, current, state.cash(), settingsBody);

        // 0. 미국 시각 지정 주문(명세 2026-10-30 §10-2): 기준 시각이 이 관측치 전인 대기 주문이 있으면 이 관측치 뒤의 1분봉 저장본을 기다립니다
        //    (최대 UsTimedFills.BARS_WAIT) — 그러지 않으면 아래 시간별 스탑이 그 앞 시각의 시각 지정 매도보다 먼저 돕니다. 미루면 아무것도 쓰지
        //    않습니다(멱등 키 그대로). 그런 주문이 없는 책(지금 모든 계좌)은 묻지 않고 지금처럼 처리합니다.
        if (bars != null && PaperBooks.ACTIVE.equals(book.status()) && !UsTimedFills.due(
                store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING), run.at, market.calendar()).isEmpty()) {
            UsTimedFills.BarsWait wait = UsTimedFills.barsWait(bars.get(), run.at, clock.instant());
            if (wait.waiting()) {
                run.barsWait = wait.text();
                return run;
            }
            run.barsReleased = wait.text();
            run.timedDue = true;
            // 2b의 재진입 금지는 목표 세션 E로 판정합니다 — 늦게 푸는 E 주문(서버가 꺼졌던 뒤)이 아래에서 지운 지난 금지에 걸리도록 지우기 전에 읽음.
            for (Lockout lockout : store.lockouts(book.code())) {
                run.timedLockouts.put(lockout.ticker(), lockout.untilTradingDate());
            }
        }

        // 1. 만료·재진입 금지 정리 — 미국 시각 지정 주문은 여기서 만료하지 않고 2b 뒤(3a)에(UsTimedFills)
        run.expired = bars != null ? store.expireOrders(book.code(), run.session, UsTimedFills.TIMINGS)
                : store.expireOrders(book.code(), run.session);
        store.deleteLockoutsBefore(book.code(), run.session);
        for (Lockout lockout : store.lockouts(book.code())) {
            run.lockouts.put(lockout.ticker(), lockout.untilTradingDate());
        }
        for (Position position : store.positions(book.code())) {
            run.holdings.put(position.ticker(), new Holding(position));
        }

        boolean active = PaperBooks.ACTIVE.equals(book.status());
        boolean started = active || PaperBooks.PAUSED.equals(book.status());
        List<Order> pending = active ? store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING) : List.of();
        if (market.auctionFills()) {
            loadAuction(run, pending);                              // 보유 쪽 칸(보류 표시·since 거래량)·확정 시세
            processAuction(run, pending, started);                  // 한국 — 시가 체결 장부(아래 '시가 체결 장부')
            settle(run, state, started);
            // 그날 보류한 종목의 대기 주문 표시(V16 — 결정 게이트 ①이 이 관측치로 판정할 때 읽음, 재기동해도 남음). 같은 트랜잭션이라
            // 처리를 되돌리면 표시도 앞 그대로입니다.
            store.markLedgerHolds(book.code(), quotes.collectedAt(), run.orderHolds);
            return run;
        }
        if (started) {
            refreshHoldings(run);                                   // 2. 분할·가격(갱신 전 평가 가격은 Holding.priceBefore)
        }
        if (run.timedDue) {
            timedFills.process(run, pending, bars.get());           // 2b. 시각 지정 체결 → 3a. 끝난 세션 정리 → 3b. 평가 가격
        }
        fill(run, pending, PaperBooks.SELL);                        // 3. 매도
        if (started) {
            raiseWatermarks(run);                                   // 4. 최고가 → 스탑
        }
        if (active && !PaperBooks.KIND_BENCHMARK.equals(book.kind())) {
            checkStops(run);
        }
        fill(run, pending, PaperBooks.BUY);                         // 5. 매수(방금 건 재진입 금지를 봄)
        settle(run, state, started);                                // 6. 평가·순자산·상태
        return run;
    }

    // ------------------------------------------------------------------ 2. 분할·가격
    private void refreshHoldings(BookRun run) {
        // 기준일 종가를 같은 저장본(3개월)에서 못 찾은 보유만 10년 이력에서 한 번에 찾습니다.
        Map<String, LocalDate> needHistory = new TreeMap<>();
        for (Holding holding : run.holdings.values()) {
            Bar bar = run.bar(holding.ticker);
            if (bar != null && !bar.stale() && bar.recent().valueOn(holding.fillRefDate) == null) {
                needHistory.put(holding.ticker, holding.fillRefDate);
            }
        }
        Map<String, DailySeries> history = Map.of();
        if (!needHistory.isEmpty()) {
            LocalDate from = Collections.min(needHistory.values());
            LocalDate to = Collections.max(needHistory.values());
            history = marketData.history(run.market, needHistory.keySet(), from, to);
        }
        for (Holding holding : new ArrayList<>(run.holdings.values())) {
            refresh(run, holding, history.get(holding.ticker));
        }
    }

    private void refresh(BookRun run, Holding holding, DailySeries history) {
        holding.verified = false;
        Bar bar = run.bar(holding.ticker);
        if (bar == null || bar.stale()) {
            holding.priceStale = true;   // 이번 관측치에 새 값이 없음 — 마지막 가격으로 평가, 스탑은 보지 않음
            return;
        }
        Double refNow = bar.recent().valueOn(holding.fillRefDate);
        if (refNow == null && history != null) {
            refNow = history.valueOn(holding.fillRefDate);
        }
        if (refNow == null) {
            holding.priceStale = true;
            run.note(holding.ticker + " 분할 확인 기준일(" + holding.fillRefDate
                    + ") 종가가 시세·이력에 없어 가격을 갱신하지 않았습니다");
            return;
        }
        Optional<SplitDetector.Ratio> split = SplitDetector.detect(holding.fillRefClose, refNow);
        if (split.isPresent()) {
            applySplit(run, holding, split.get(), refNow, bar.date());
            if (holding.qty == 0) {
                return;
            }
        } else {
            holding.fillRefClose = refNow;   // 배당 조정으로 조금 바뀐 기준값을 따라감(클래스 설명)
        }
        holding.lastPrice = bar.close();
        holding.lastPriceAt = run.at;
        holding.priceStale = false;
        if (run.market.closeAvailable(bar.date(), run.at) && bar.date().isAfter(holding.fillRefDate)) {
            holding.fillRefDate = bar.date();
            holding.fillRefClose = bar.close();
        }
        holding.verified = true;
    }

    private void applySplit(BookRun run, Holding holding, SplitDetector.Ratio ratio, double refNow, LocalDate seenOn) {
        int before = holding.qty;
        double avgBefore = holding.avgCost;
        holding.qty = SplitDetector.adjustQty(holding.qty, ratio);
        holding.avgCost = SplitDetector.adjustPrice(holding.avgCost, ratio);
        holding.highWatermark = SplitDetector.adjustPrice(holding.highWatermark, ratio);
        if (holding.lastPrice != null) {
            holding.lastPrice = SplitDetector.adjustPrice(holding.lastPrice, ratio);
        }
        holding.priceBefore = SplitDetector.adjustPrice(holding.priceBefore, ratio);
        holding.fillRefClose = refNow;
        String note = "%s %s 분할 감지 — %d주 → %d주, 평단 %.2f → %.2f".formatted(
                seenOn, ratio.label(), before, holding.qty, avgBefore, holding.avgCost);
        holding.splitNote = appendNote(holding.splitNote, note);
        run.splits++;
        run.note(holding.ticker + " " + note);
        if (holding.qty == 0) {
            // 병합으로 1주 미만이 됨 — 단주 현금 정산은 생략합니다(SplitDetector.adjustQty). 0주 보유는 둘 수 없어 지웁니다.
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
            run.note(holding.ticker + " 분할 뒤 0주가 되어 보유를 지웠습니다(단주 현금 정산 생략)");
        }
    }

    // ------------------------------------------------------------------ 3·5. 체결
    /**
     * 대기 주문 중 그쪽(매도·매수)만, 만든 순서대로. 매도는 스탑 앞, 매수는 스탑 뒤(클래스 설명의 처리 순서).
     *
     * <p>매수는 현금성(설정 {@code cashLikeTickers}, 기본 SHY)이 아닌 것을 먼저, 현금성 매수를 마지막에 체결합니다. 규칙 책은
     * 종목 매수와 함께 "남는 현금은 SHY에" 주문을 내는데, 그 주문은 남는 현금을 어림한 값이라 체결 시점 가격이 조금만 달라도
     * 종목 매수와 현금을 다툽니다 — SHY가 먼저 체결되면 신호 종목이 현금 부족으로 줄어듭니다(설계 §4-2: SHY는 남는 현금).
     */
    private void fill(BookRun run, List<Order> pending, String side) {
        if (PaperBooks.SELL.equals(side)) {
            for (Order order : pending) {
                if (PaperBooks.SELL.equals(order.side())) {
                    fillSell(run, order);
                }
            }
            return;
        }
        for (boolean cashLikePass : new boolean[]{false, true}) {
            for (Order order : pending) {
                if (PaperBooks.BUY.equals(order.side()) && run.settings.cashLike(order.ticker()) == cashLikePass) {
                    fillBuy(run, order);
                }
            }
        }
    }

    /**
     * 이 주문을 이 관측치로 체결할 수 있으면 그 봉, 아니면 null — 클래스 설명의 체결 조건 ①~④를 그 시장 묶음이 봅니다
     * ({@link PaperMarket#fillBar} — 미국은 그 봉 자신, ③은 {@link PaperMarket#fillable}). 이 관측치에 그 종목이 없으면 null.
     */
    static Bar fillableBar(PaperMarket market, Order order, Quotes quotes) {
        Bar bar = quotes.bars().get(order.ticker());
        return bar == null ? null : market.fillBar(order, bar, quotes.collectedAt(), market.calendar(), null).bar();
    }

    private void fillSell(BookRun run, Order order) {
        Bar bar = fillableBar(run.market, order, run.quotes);
        if (bar == null) {
            return;
        }
        Holding holding = run.holdings.get(order.ticker());
        if (holding == null) {
            cancel(run, order, "체결 시점에 보유가 없습니다");
            return;
        }
        if (!holding.verified) {
            return;   // 분할 여부를 확인하지 못한 보유 — 수량을 믿을 수 없어 다음 관측치를 기다립니다
        }
        int qty = sellQty(run, order, holding);
        if (qty < 0) {
            return;
        }
        FillTerms terms = run.fill(order, bar);
        FillTerms.Costs costs = terms.costs(qty);
        recordFill(run, order.id(), order.ticker(), PaperBooks.SELL, qty, terms, costs, bar);
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        holding.qty -= qty;
        if (holding.qty == 0) {
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
        }
        run.filled++;
    }

    /** 매도 수량(수량 주문은 보유까지, 비율 주문은 보유 × 비율 — null이면 전량). 수량·비율이 0 이하면 그 주문을 취소하고 −1. */
    private int sellQty(BookRun run, Order order, Holding holding) {
        if (order.qty() != null) {
            if (order.qty() <= 0) {
                cancel(run, order, "매도 수량이 0 이하입니다");
                return -1;
            }
            return Math.min(order.qty(), holding.qty);
        }
        Double fraction = order.sellFraction();
        if (fraction != null && (!(fraction > 0) || fraction.isInfinite())) {
            cancel(run, order, "매도 비율이 0 이하입니다");
            return -1;
        }
        return PaperLedger.sellQty(holding.qty, fraction);
    }

    private void fillBuy(BookRun run, Order order) {
        Bar bar = fillableBar(run.market, order, run.quotes);
        if (bar == null) {
            return;
        }
        Holding holding = run.holdings.get(order.ticker());
        if (holding != null && !holding.verified) {
            return;   // 분할 여부를 확인하지 못한 보유에 더 사지 않습니다(평단이 섞임) — 다음 관측치
        }
        // 이번 관측치의 스탑이 건 재진입 금지도 여기서 걸립니다(매수가 스탑 뒤라서 — 클래스 설명).
        LocalDate until = run.lockouts.get(order.ticker());
        if (TrailingStop.lockedOut(until, bar.date())) {
            cancel(run, order, "재진입 금지 중입니다(" + until + "까지, 트레일링 스탑)");
            return;
        }
        FillTerms terms = run.fill(order, bar);
        double price = terms.price();
        int wanted;
        if (order.qty() != null) {
            wanted = order.qty();
        } else if (order.targetWeightPct() != null && Double.isFinite(order.targetWeightPct())) {
            // 목표 금액 = 목표 비중 × 체결 시점 순자산(같은 관측치의 매도·앞선 매수를 반영한 값).
            wanted = terms.affordableQty(order.targetWeightPct() / 100.0 * run.nav());
        } else {
            cancel(run, order, "매수 크기(수량·목표 비중)가 없습니다");
            return;
        }
        if (wanted <= 0) {
            cancel(run, order, "목표 금액으로 1주도 살 수 없습니다");
            return;
        }
        int affordable = terms.affordableQty(run.cash);
        int qty = Math.min(wanted, affordable);
        if (qty <= 0) {
            cancel(run, order, "현금이 모자라 1주도 살 수 없습니다(현금 " + money(run.cash) + ")");
            return;
        }
        FillTerms.Costs costs = terms.costs(qty);
        recordFill(run, order.id(), order.ticker(), PaperBooks.BUY, qty, terms, costs, bar);
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        if (holding == null) {
            Reference reference = referenceFor(run.market, bar, run.at);
            holding = new Holding(order.ticker(), qty, price, bar.date(), run.at, price, run.at, bar.close(), run.at,
                    reference.date(), reference.close());
            holding.verified = true;
            run.holdings.put(holding.ticker, holding);
        } else {
            holding.avgCost = PaperLedger.averageCost(holding.qty, holding.avgCost, qty, price);
            holding.qty += qty;
            holding.lastPrice = bar.close();
            holding.lastPriceAt = run.at;
            raiseWatermark(holding, price, run.at);
        }
        if (qty < wanted) {
            // 현금이 모자라 요청보다 적게 산 사실을 그 주문의 근거에 남깁니다(설계 §3-1) — 실행 기록(notes)은 200건만 남지만
            // 주문은 장부와 함께 남으므로, 나중에 '왜 목표 비중보다 적게 샀나'를 주문 표에서 바로 봅니다.
            ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy()
                    : mapper.createObjectNode();
            reason.put("cashLimited", true);
            reason.put("requestedQty", wanted);
            reason.put("filledQty", qty);
            store.updateOrderReason(order.id(), reason);
            run.note("주문 " + order.id() + " " + order.ticker() + " 현금 부족으로 " + wanted + "주 중 " + qty
                    + "주만 매수(cashLimited)");
        }
        run.filled++;
    }

    /** 새 보유의 분할 감지 기준 — 종가 하나(클래스 설명). 장중 체결이면 직전 거래일 종가, 그것도 없으면 그 봉. */
    static Reference referenceFor(PaperMarket market, Bar bar, Instant collectedAt) {
        if (market.closeAvailable(bar.date(), collectedAt)) {
            return new Reference(bar.date(), bar.close());
        }
        LocalDate previous = bar.recent().floorDate(bar.date().minusDays(1));
        if (previous != null) {
            return new Reference(previous, bar.recent().valueOn(previous));
        }
        return new Reference(bar.date(), bar.close());
    }

    record Reference(LocalDate date, double close) {
    }

    private void cancel(BookRun run, Order order, String reason) {
        store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, reason);
        run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 취소 — " + reason);
    }

    // ------------------------------------------------------------------ 시가 체결 장부(한국 — 명세 §4-2, C2b)
    /**
     * 한국 책 하나의 관측치 처리(만료·재진입 금지 정리 뒤, 평가·순자산 앞) — 명세 §4-2의 한 관측치 안 순서: 기업행위 → 시가 매도(STOP 포함) →
     * 시가 매수 → 종가 매도 → 종가 매수(현금성은 각 묶음 마지막) → 최고가 갱신·스탑 감지 → 평가. 체결 봉·가격·비용 칸은 시장 몫
     * ({@link PaperMarket#fillBar}·{@link PaperMarket#fill} — {@code KrFills})입니다. 미국식 분할 감지(종가 하나의 비율)·관측가 최고가·즉시 스탑
     * ({@code IMMEDIATE})은 쓰지 않습니다(K30·K32 — 한국 스탑은 다음 거래일 시가 주문, 기업행위는 3중 조건).
     *
     * <p><b>기업행위</b>({@link #corporateActions}, 결정 d12): 보유마다 저장본의 최근 봉 + 그 보유가 반영한 마지막 관측(since 봉 — 보유 쪽
     * {@code fill_ref_date}·{@code fill_ref_close}·{@code fill_ref_volume})을 {@link KrxCorporateActions#assess}에 넘깁니다. 분할·병합이면 수량·평단·
     * 최고가를 고치고 그날 그 종목 주문을 보류, 판정 대기면 그날 주문만 보류, 미처리면 보유에 '기업행위 확인 필요' 표시를 걸어(한 번 걸면 사람이
     * 풀 때까지 남음) 평가를 마지막 확정가로 묶고 스탑을 보지 않으며 주문을 보류합니다. 보유가 없는 종목(주문만)은 그 주문의 기준 거래일 뒤를
     * 판정해 그날 주문만 보류합니다. 보류가 걸린 날 뒤 5거래일을 넘기면 운영 알림({@link Outcome#alerts}). 한쪽 출처만 실패·모름이면(토스 항목이
     * 없거나 이어받음, 금융위 모름) 사라진 종목이 아니라 '가격 없음'({@code price_stale})뿐입니다(§4-2 'B7 구현에서 정한 것').
     *
     * <p><b>since 봉</b>: 기업행위 판정이 그 보유에 새 사건이 없다고 본(또는 분할을 반영한) 관측치의 마지막 관측 봉(거래량 &gt; 0)으로 옮깁니다
     * ({@link #advanceSince} — 거래량 0 봉에서는 옮기지 않음). 이번 관측치에서 새로 산 보유는 체결 봉 그대로 둡니다(C2b — 다음 관측치가 그 뒤를 판정).
     *
     * <p><b>최고가 갱신·스탑 감지</b>(K30): 최고가는 KRX 기준가로만 올립니다 — G2 판정 전이라 금융위 확정 종가뿐이고 토스 종가로는 올리지 않습니다
     * ({@link #raiseKrxWatermarks}). 스탑은 밤 잠정 종가(토스)로 감지해 다음 거래일 {@code NEXT_OPEN} {@code STOP} 매도 주문을 내고
     * ({@link #detectStops} — 밤에는 장이 닫혀 그 가격으로 팔 수 없음), 그 주문을 체결 처리할 때 감지한 날 D의 금융위 확정 종가로 다시 판정합니다
     * ({@link #rejudgeStop}): 스탑가 위면 {@code STOP_NOT_CONFIRMED}로 취소(재진입 금지 없음), 금융위 D 행이 아직 없으면 잠정 판정대로 집행
     * ({@code stopBasis=PROVISIONAL}). 재진입 금지는 체결한 날부터 셉니다.
     *
     * <p><b>순자산 기준</b>: 목표 비중 매수의 목표 금액 = 목표 비중 × 그 체결 직전 순자산 — 보유 평가는 직전 관측치의 가격(이번 관측치의 종가는
     * 평가 단계에서 반영), 같은 관측치에서 앞서 산 종목은 체결가입니다. 그래서 한 시가에 함께 사는 주문(벤치마크 60/40 등)이 그날 시가 뒤
     * 움직임과 상관없이 같은 기준으로 나뉩니다.
     */
    private void processAuction(BookRun run, List<Order> pending, boolean started) {
        if (started) {
            corporateActions(run, pending);                             // 2. 기업행위(결정 d12)
        }
        auctionFills(run, pending, PaperBooks.SELL, true);              // 3. 시가 매도(STOP 포함)
        auctionFills(run, pending, PaperBooks.BUY, true);               // 4. 시가 매수
        auctionFills(run, pending, PaperBooks.SELL, false);             // 5. 종가 매도(NEXT_CLOSE — 지금은 체결하지 않음)
        auctionFills(run, pending, PaperBooks.BUY, false);              // 6. 종가 매수
        if (started) {
            raiseKrxWatermarks(run);                                    // 7. 최고가 갱신(KRX 기준가 — 금융위 확정 종가로만)
            if (PaperBooks.ACTIVE.equals(run.book.status()) && !PaperBooks.KIND_BENCHMARK.equals(run.book.kind())) {
                detectStops(run);                                       //    스탑 감지 → 다음 거래일 시가 STOP 주문
            }
            revalueAuction(run);                                        // 8. 평가 가격 = 이번 관측치의 그 종목 마지막 봉 종가
            advanceSince(run);                                          //    since 봉을 이번 관측치의 마지막 관측으로
        }
    }

    /** 시가 체결 장부가 쓰는 보유 쪽 칸(미처리 기업행위 표시·since 봉 거래량 — 보유 레코드 밖)과 그 책 종목의 확정 시세를 읽습니다. */
    private void loadAuction(BookRun run, List<Order> pending) {
        String code = run.book.code();
        store.corpActionHolds(code).forEach(hold -> {
            Holding holding = run.holdings.get(hold.ticker());
            if (holding != null) {
                holding.corpHold = hold.reason();
            }
        });
        store.fillRefVolumes(code).forEach((ticker, volume) -> {
            Holding holding = run.holdings.get(ticker);
            if (holding != null) {
                holding.fillRefVolume = volume;
            }
        });
        Set<String> codes = new TreeSet<>(run.holdings.keySet());
        LocalDate from = null;
        for (Holding holding : run.holdings.values()) {
            from = earlier(from, holding.fillRefDate);
        }
        for (Order order : pending) {
            codes.add(order.ticker());
            if (PaperBooks.SOURCE_STOP.equals(order.source())) {
                from = earlier(from, order.asOfTradingDate());
            }
        }
        if (!codes.isEmpty()) {
            run.confirmed = run.market.confirmedPrices(marketData, codes, run.settings, from);
        }
    }

    private static LocalDate earlier(LocalDate a, LocalDate b) {
        return a == null ? b : b == null || !b.isBefore(a) ? a : b;
    }

    // ------------------------------------------------------------------ 기업행위(한국 — 명세 §4-2 K32, 결정 d12)
    /**
     * 보유마다·주문만 있는 종목마다 기업행위 판정({@link #processAuction} 설명). 보유의 '확인됨'({@code verified} — 매도·추가 매수의 전제)은 이번
     * 관측치에 그 종목의 새 항목이 있고 보류 표시가 없을 때입니다.
     */
    private void corporateActions(BookRun run, List<Order> pending) {
        Map<String, LocalDate> orderOnly = new TreeMap<>();
        for (Order order : pending) {
            if (!run.holdings.containsKey(order.ticker()) && order.asOfTradingDate() != null) {
                orderOnly.merge(order.ticker(), order.asOfTradingDate(), (a, b) -> a.isBefore(b) ? a : b);
            }
        }
        for (Holding holding : new ArrayList<>(run.holdings.values())) {
            if (holding.corpHold != null) {
                // 이미 걸린 미처리 기업행위 — 평가 묶음·스탑 없음·주문 보류(사람이 풀 때까지), 다시 판정하지 않음.
                holding.verified = false;
                holding.assessed = Kind.UNPROCESSED;
                run.orderHolds.put(holding.ticker, "미처리 기업행위 보유 — " + holding.corpHold);
                alertIfDue(run, holding);
                continue;
            }
            Bar bar = run.bar(holding.ticker);
            holding.verified = bar != null && !bar.stale();
            Assessment assessment = assess(run, holding.ticker, holding.fillRefDate, holding.qty, sinceBar(holding));
            holding.assessed = assessment.kind();
            switch (assessment.kind()) {
                case NONE -> {
                }
                case PENDING -> holdOrders(run, holding.ticker, assessment);
                case SPLIT -> applyKrSplit(run, holding, assessment);
                case UNPROCESSED -> holdUnprocessed(run, holding, assessment);
            }
        }
        orderOnly.forEach((ticker, since) -> {
            Assessment assessment = assess(run, ticker, since, 0, null);
            if (assessment.holdOrders()) {
                holdOrders(run, ticker, assessment);
            }
        });
    }

    /**
     * 그 종목의 기업행위 판정 — 저장본의 새 봉(이어받은 항목은 넘기지 않음) + since 봉, 토스·금융위 상장 상태. ETF 목록({@link KrPaperMarket#etf})
     * 종목은 분배락의 수정 비율 변화를 건너뜁니다(QA-144).
     */
    private static Assessment assess(BookRun run, String ticker, LocalDate since, int qty, DailyBar sinceBar) {
        Bar bar = run.bar(ticker);
        boolean fresh = bar != null && !bar.stale() && bar.kr() != null;
        List<DailyBar> bars = new ArrayList<>();
        if (fresh) {
            for (KrQuotes.Day day : bar.kr().days()) {
                if (day.close() != null) {
                    bars.add(new DailyBar(day.date(), day.close().doubleValue(), day.volume(), day.adjRatio()));
                }
            }
        }
        if (sinceBar != null && bars.stream().noneMatch(b -> b.date().equals(sinceBar.date()))
                && (bars.isEmpty() || sinceBar.date().isBefore(bars.get(bars.size() - 1).date()))) {
            bars.add(sinceBar);   // 저장본 창 밖의 since 봉(결정 d12 — 정지 4봉 + 재상장 봉도 판정)
        }
        Presence toss = fresh ? Presence.LISTED
                : run.quotes.absent().contains(ticker) ? Presence.ABSENT : Presence.UNKNOWN;
        KrConfirmed.Series fsc = run.confirmed.of(ticker);
        Listing listing = new Listing(toss, fsc.presence(), fsc.sharesBefore(), fsc.sharesAfter());
        return KrxCorporateActions.assess(asOfOf(run, ticker), since, qty, bars, listing,
                KrPaperMarket.etf(ticker, run.settings));
    }

    /** 보유가 반영한 마지막 관측(since 봉) — 거래량을 모르면(V15 전 보유) 관측이 아니라 3중 조건의 E 전 관측이 되지 못함. */
    private static DailyBar sinceBar(Holding holding) {
        if (holding.fillRefDate == null || !(holding.fillRefClose > 0) || Double.isInfinite(holding.fillRefClose)) {
            return null;
        }
        return new DailyBar(holding.fillRefDate, holding.fillRefClose, holding.fillRefVolume, null);
    }

    /** 그날 그 종목 주문을 보류(대기 그대로 — 만료까지)하고 판정 근거를 작업 기록에. */
    private static void holdOrders(BookRun run, String ticker, Assessment assessment) {
        String reason = "기업행위 " + assessment.kind().label() + " — " + String.join("; ", assessment.details());
        run.orderHolds.put(ticker, reason + " — 그날 그 종목 주문 보류");
        run.note(ticker + " " + reason);
    }

    /**
     * 3중 조건을 채운 분할·병합 — 수량 floor(수량 × k), 평단·최고가·마지막 가격 ÷ k(미국과 같은 {@link SplitDetector} 식), 분할 기록, 그날 주문 보류.
     * since 봉은 평가 뒤 이번 관측치의 마지막 관측으로 옮겨 같은 비율 변화를 두 번 반영하지 않습니다({@link #advanceSince}).
     */
    private static void applyKrSplit(BookRun run, Holding holding, Assessment assessment) {
        SplitDetector.Ratio ratio = assessment.ratio();
        int before = holding.qty;
        double avgBefore = holding.avgCost;
        holding.qty = assessment.newQty();
        holding.avgCost = SplitDetector.adjustPrice(holding.avgCost, ratio);
        holding.highWatermark = SplitDetector.adjustPrice(holding.highWatermark, ratio);
        if (holding.lastPrice != null) {
            holding.lastPrice = SplitDetector.adjustPrice(holding.lastPrice, ratio);
        }
        holding.splitFrom = assessment.effectiveDate();
        String note = "%s %s 분할·병합 확인 — %d주 → %d주, 평단 %s → %s".formatted(assessment.effectiveDate(),
                ratio.label(), before, holding.qty, won(avgBefore), won(holding.avgCost));
        holding.splitNote = appendNote(holding.splitNote, note);
        run.splits++;
        holdOrders(run, holding.ticker, assessment);
    }

    /**
     * 미처리 기업행위 — 보유에 '기업행위 확인 필요' 표시({@link KrxCorporateActions#holdReason}, 머리 날짜 = 걸린 날)를 걸고, 평가를 마지막 확정가로
     * 묶습니다: 그 보유가 반영한 마지막 관측 날짜의 금융위 종가(거래량 &gt; 0 행), 없으면 마지막 평가 가격 그대로. 스탑을 보지 않고 그 종목 주문을
     * 보류합니다(사람이 풀 때까지 — 정리 기능은 2단계에 두지 않음, §4-2).
     */
    private void holdUnprocessed(BookRun run, Holding holding, Assessment assessment) {
        String reason = KrxCorporateActions.holdReason(asOfOf(run, holding.ticker), assessment);
        store.holdForCorpAction(run.book.code(), holding.ticker, reason);
        holding.corpHold = reason;
        holding.verified = false;
        Optional<BigDecimal> confirmed = holding.fillRefDate == null ? Optional.empty()
                : run.confirmed.of(holding.ticker).closeOn(holding.fillRefDate);
        String valued;
        if (confirmed.isPresent()) {
            holding.lastPrice = confirmed.get().doubleValue();
            holding.lastPriceAt = run.at;
            holding.priceStale = false;
            valued = "평가를 금융위 " + holding.fillRefDate + " 종가 " + won(holding.lastPrice) + "원으로 묶음";
        } else {
            valued = "금융위 " + holding.fillRefDate + " 확정 종가가 없어 마지막 평가 가격 "
                    + (holding.lastPrice == null ? "없음(평단 " + won(holding.avgCost) + "원)" : won(holding.lastPrice) + "원")
                    + "으로 묶음";
        }
        run.orderHolds.put(holding.ticker, "미처리 기업행위 보유 — " + reason);
        run.note(holding.ticker + " " + reason + " — " + valued + ", 스탑 없음·주문 보류(사람이 확인)");
    }

    /** 판정의 기준 거래일 — 그 종목 새 항목의 마지막 봉 날짜, 새 항목이 없으면 그 관측치의 세션(보류 사유 머리의 걸린 날). */
    private static LocalDate asOfOf(BookRun run, String ticker) {
        Bar bar = run.bar(ticker);
        return bar != null && !bar.stale() && bar.kr() != null ? bar.kr().last().date() : run.session;
    }

    /**
     * 걸린 날(보류 사유 머리 날짜)은 빼고 센 거래일이 5를 넘은 미처리 기업행위 보유 — 운영 알림({@link KrxCorporateActions#alertDue}, 명세 §4-2
     * 'B7 구현에서 정한 것'). 오늘 = 그 관측치의 세션. 걸린 날을 모르는 보류(사유 머리가 날짜가 아님)는 셀 수 없어 바로 알립니다.
     */
    private static void alertIfDue(BookRun run, Holding holding) {
        Optional<LocalDate> since = KrxCorporateActions.holdSince(holding.corpHold);
        if (since.isEmpty()) {
            run.alerts.add(holding.ticker + " 미처리 기업행위 보류 — 걸린 날을 모름(사유 머리가 날짜가 아님): 사람이 확인하세요 — "
                    + holding.corpHold);
            return;
        }
        try {
            if (KrxCorporateActions.alertDue(run.market.calendar(), since.get(), run.session)) {
                run.alerts.add(holding.ticker + " 미처리 기업행위 보류 " + run.market.calendar().tradingDaysBetween(since.get(),
                        run.session) + "거래일째(걸린 날 " + since.get() + " — " + KrxCorporateActions.ALERT_AFTER_TRADING_DAYS
                        + "거래일 넘음): 사람이 확인하세요 — " + holding.corpHold);
            }
        } catch (CalendarUnavailableException e) {
            run.note(holding.ticker + " 미처리 기업행위 알림 기한을 셀 수 없음 — " + e.getMessage());
        }
    }

    /**
     * since 봉을 이번 관측치의 마지막 관측(거래량 &gt; 0 봉)으로 옮깁니다 — 기업행위 판정이 새 사건 없음·분할 반영으로 본 보유만(판정 대기·미처리는
     * 그대로, 거래량 0 봉에서는 옮기지 않음 — 정지 중 바뀐 비율이 다음 관측 때 판정되게). 이번 관측치에서 새로 산 보유는 체결 봉 그대로입니다.
     */
    private static void advanceSince(BookRun run) {
        for (Holding holding : run.holdings.values()) {
            if (holding.opened || holding.corpHold != null || !holding.verified
                    || (holding.assessed != Kind.NONE && holding.assessed != Kind.SPLIT)) {
                continue;
            }
            Bar bar = run.bar(holding.ticker);
            if (bar == null || bar.kr() == null) {
                continue;
            }
            List<KrQuotes.Day> days = bar.kr().days();
            for (int i = days.size() - 1; i >= 0; i--) {
                KrQuotes.Day day = days.get(i);
                if (day.observed() && day.close() != null) {
                    if (holding.fillRefDate == null || day.date().isAfter(holding.fillRefDate)) {
                        holding.fillRefDate = day.date();
                        holding.fillRefClose = day.close().doubleValue();
                        holding.fillRefVolume = day.volume();
                    }
                    break;
                }
            }
        }
    }

    // ------------------------------------------------------------------ 최고가·트레일링 스탑(한국 — 명세 §4-2 K30)
    /**
     * 최고가를 KRX 기준가로만 올립니다(K30 — 통합가 고점으로 되돌릴 수 없는 매도·재진입 금지가 나지 않게). G2(1분봉 15:30 단일가 봉 = 금융위 종가)
     * 판정 전이라 KRX 기준가는 금융위 확정 종가(주식 {@code clpr}·ETF 종가, 거래량 &gt; 0 행)뿐이고, 토스 종가로는 올리지 않습니다 — NXT 종목의
     * 통합가({@code TOSS_INTEGRATED})는 물론 KRX 단독 봉({@code TOSS_DAILY})의 잠정 종가도(확정값으로 다시 계산할 일을 만들지 않게). 금융위 D 종가는
     * D+1 밤에 들어오므로 최고가는 하루 늦게 따라갑니다. 보는 날짜({@link #watermarkFrom}) = 그 보유가 이번 관측치 시작 때 반영한 마지막 관측(since)과
     * 금융위 최신 기준일 − {@value KrConfirmed#LOOKBACK_DAYS}일(확정 시세가 늘 읽는 창) 중 이른 날부터 — 금융위 X 값이 토스 X+1 관측치 처리보다 늦게
     * 들어와도(첫 slow의 {@code fsc_prices} 실패) since는 이미 X 뒤라 그 종가를 건너뛰었기 때문입니다(묶음 C 리뷰). 그 보유를 연 날 전, 분할·병합을
     * 반영한 날 E 전(그 전 가격은 옛 단위)으로는 넘어가지 않습니다 — 이번 관측치에서 분할을 반영했으면 E부터. 최고가는 max라 같은 종가를 다시 봐도
     * 두 번 오르지 않습니다. 미처리 기업행위·판정 대기 보유는 올리지 않습니다. 새 보유의 처음 값은 체결가(C2b — 시가 사다리를 내려간
     * {@code TOSS_INTEGRATED} 체결이면 그 값; 금융위 확정 때 다시 계산 — C3 {@link KrConfirmations}).
     */
    private static void raiseKrxWatermarks(BookRun run) {
        for (Holding holding : run.holdings.values()) {
            if (holding.corpHold != null || holding.assessed == Kind.PENDING || holding.assessed == Kind.UNPROCESSED) {
                continue;
            }
            KrConfirmed.Series series = run.confirmed.of(holding.ticker);
            LocalDate from = holding.splitFrom != null ? holding.splitFrom : watermarkFrom(holding, series);
            if (from == null) {
                continue;
            }
            for (KrConfirmed.Day day : series.observedFrom(from)) {
                raiseWatermark(holding, day.close().doubleValue(), run.at);
            }
        }
    }

    /** 한국 분할·병합을 반영한 기록의 머리({@link #applyKrSplit} — "E k:1 분할·병합 확인"). */
    private static final java.util.regex.Pattern KR_SPLIT_NOTE =
            java.util.regex.Pattern.compile("(\\d{4}-\\d{2}-\\d{2}) \\d+:\\d+ 분할·병합 확인");

    /**
     * 최고가를 올리는 금융위 종가를 읽기 시작할 날({@link #raiseKrxWatermarks}) — since와 (금융위 최신 기준일 − {@value KrConfirmed#LOOKBACK_DAYS}일) 중
     * 이른 날, 단 그 보유를 연 날·마지막으로 반영한 분할의 E보다 앞으로는 가지 않음. 분할 기록이 있는데 E를 읽을 수 없으면(잘린 기록) 거슬러 읽지 않고
     * since부터(옛 단위 가격을 섞지 않게). since가 없으면 null(올리지 않음).
     */
    static LocalDate watermarkFrom(LocalDate since, LocalDate openedOn, String splitNote, LocalDate fscLatest) {
        if (since == null) {
            return null;
        }
        LocalDate split = null;
        if (splitNote != null && !splitNote.isBlank()) {
            java.util.regex.Matcher matcher = KR_SPLIT_NOTE.matcher(splitNote);
            while (matcher.find()) {
                split = LocalDate.parse(matcher.group(1));
            }
            if (split == null) {
                return since;
            }
        }
        LocalDate from = fscLatest == null ? since : earlier(since, fscLatest.minusDays(KrConfirmed.LOOKBACK_DAYS));
        if (openedOn != null && from.isBefore(openedOn)) {
            from = openedOn;
        }
        if (split != null && from.isBefore(split)) {
            from = split;
        }
        return from;
    }

    private static LocalDate watermarkFrom(Holding holding, KrConfirmed.Series series) {
        return watermarkFrom(holding.sinceAtStart, holding.openedOn, holding.splitNote, series.datasetLatest());
    }

    /**
     * 스탑 감지(K30): 밤 잠정 종가(이번 관측치의 그 종목 마지막 봉 — 거래량 &gt; 0 관측일 때만)가 최고가 × (1 − {@code kr.trailingStopPct}%) 이하면
     * <b>다음 거래일 시가</b> 전량 매도 주문({@code SELL}·{@code NEXT_OPEN}·출처 {@code STOP}·{@code PENDING}, 수량 null = 체결 때 보유 전량,
     * 기준 거래일 = 감지한 봉 날짜 D, 만료 D + 3거래일, 생성 = 이 관측치의 수집 시각)을 냅니다 — 밤에는 장이 닫혀 그 가격으로 팔 수 없기 때문입니다.
     * 근거에 최고가·스탑 비율·스탑가·관측가와 그 출처를 남기고, 체결 때 그 값으로 다시 판정합니다({@link #rejudgeStop}). 그 종목에 대기 중인 스탑
     * 주문이 있으면 다시 내지 않습니다(같은 밤 다시 쓴 저장본). 현금성·미처리 기업행위·판정 대기·이번 관측치에 새 항목이 없는 보유는 보지 않습니다.
     * 운용 중인 규칙·Claude 책만(벤치마크·일시정지는 스탑 없음 — 미국과 같음).
     */
    private void detectStops(BookRun run) {
        double stopPct = run.settings.trailingStopPct();
        Set<String> waiting = new TreeSet<>();
        for (Order order : store.ordersByStatus(run.book.code(), PaperBooks.ORDER_PENDING)) {
            if (PaperBooks.SOURCE_STOP.equals(order.source())) {
                waiting.add(order.ticker());
            }
        }
        for (Holding holding : run.holdings.values()) {
            if (!holding.verified || holding.corpHold != null || holding.assessed == Kind.PENDING
                    || holding.assessed == Kind.UNPROCESSED || run.settings.cashLike(holding.ticker)
                    || waiting.contains(holding.ticker)) {
                continue;
            }
            Bar bar = run.bar(holding.ticker);
            if (bar == null || bar.stale() || bar.kr() == null) {
                continue;
            }
            KrQuotes.Day last = bar.kr().last();
            if (!last.observed() || last.close() == null) {
                continue;   // 정지일(거래량 0)·거래량 모름 — 그날 종가가 관측이 아님
            }
            double close = last.close().doubleValue();
            if (!TrailingStop.triggered(holding.highWatermark, close, stopPct)) {
                continue;
            }
            double stopPrice = TrailingStop.stopPrice(holding.highWatermark, stopPct);
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("trigger", "TRAILING_STOP");
            reason.put("stopPct", stopPct);
            reason.put("highWatermark", PaperLedger.round4(holding.highWatermark));
            reason.put("stopPrice", PaperLedger.round4(stopPrice));
            reason.put("observedPrice", close);
            reason.put("observedSource", last.priceSource());
            reason.put("barDate", last.date().toString());
            reason.put("detection", "밤 잠정 종가 — 다음 거래일 시가(NEXT_OPEN) 매도, 체결 때 금융위 " + last.date()
                    + " 종가로 다시 판정(스탑가 위면 STOP_NOT_CONFIRMED 취소)");
            LocalDate expires = run.market.calendar().addTradingDays(last.date(), RuleBookService.ORDER_EXPIRY_TRADING_DAYS);
            long id = store.insertOrder(new Order(0, run.book.code(), null, holding.ticker, PaperBooks.SELL, null, null, null,
                    PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, mapper.valueToTree(reason),
                    last.date(), run.at, expires, null));
            waiting.add(holding.ticker);
            run.note("주문 " + id + " " + holding.ticker + " 트레일링 스탑 감지 −" + trim(stopPct) + "%: 최고가 "
                    + won(holding.highWatermark) + " → " + last.date() + " 잠정 종가 " + won(close) + "("
                    + last.priceSource() + ") ≤ 스탑가 " + won(stopPrice) + " — 다음 거래일 시가 매도(만료 " + expires + ")");
        }
    }

    /**
     * STOP 주문 체결 처리 때의 다시 판정(K30) — 결과와 근거에 남길 칸.
     *
     * @param basis        {@code FSC}·{@code FSC_ETF}(감지한 날 D의 금융위 확정 종가로 판정) 또는 {@value #STOP_BASIS_PROVISIONAL}(금융위 D 행이 아직 없음)
     * @param cancelReason 취소 사유({@value #STOP_NOT_CONFIRMED} …) — 집행하면 null
     */
    private record StopCheck(String basis, BigDecimal confirmedClose, String cancelReason, String note) {

        Map<String, Object> fields() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("stopBasis", basis);
            if (confirmedClose != null) {
                out.put("confirmedClose", confirmedClose);
            }
            if (note != null) {
                out.put("stopBasisNote", note);
            }
            return out;
        }
    }

    /** 스탑 판정 근거 — 금융위 확정 종가가 아직 없어 잠정 판정대로 집행함. */
    static final String STOP_BASIS_PROVISIONAL = "PROVISIONAL";
    /** 스탑 취소 사유의 머리 — 확정 종가가 스탑가 위. */
    static final String STOP_NOT_CONFIRMED = "STOP_NOT_CONFIRMED";
    /**
     * STOP 근거의 칸 — 감지 뒤 금융위 확정 조정이 그 보유를 연 체결의 최고가를 <b>낮춰</b> 다시 센 값({@link KrConfirmations} — 감지 때 최고가는
     * 잠정 체결가였음). 확정 체결가와 체결일부터 그 STOP의 감지일까지의 금융위 종가로만 셉니다(감지 뒤 종가는 섞지 않음). 재판정은 감지 때 최고가와
     * 이 값 중 낮은 쪽으로 셉니다({@link #rejudgeStop}).
     */
    static final String STOP_CONFIRMED_WATERMARK = "confirmedHighWatermark";

    /**
     * 감지한 날 D(주문의 기준 거래일)의 금융위 확정 종가(거래량 &gt; 0 행 — {@link KrConfirmed.Series#closeOn})로 다시 판정합니다. 금융위 D 종가는
     * D 15:30에 공개된 값이라 D+1 밤의 체결 처리에서 써도 룩어헤드가 아닙니다. 감지 때 근거에 남긴 최고가·스탑 비율로 셉니다(그사이 오른 최고가로
     * 스탑가를 올리지 않음). 단 감지 뒤 금융위 확정 조정이 그 보유를 연 체결의 최고가를 낮췄으면({@value #STOP_CONFIRMED_WATERMARK} — 감지 때 최고가가
     * 잠정 체결가, 예: NXT 08:00 프리마켓 첫 체결가인 {@code TOSS_INTEGRATED} 시가) 그 낮아진 확정값으로 셉니다(K30 — 통합가 고점으로 되돌릴 수 없는
     * 매도·재진입 금지를 내지 않게, 묶음 C 리뷰). 스탑가 위면 취소({@value #STOP_NOT_CONFIRMED}), 이하면 집행. 금융위 D 행이 없거나(지연) 그날 거래가
     * 없던 행이면(종가는 전날 값) 잠정 판정대로 집행합니다 — G2 통과 뒤에는 잠정 = KRX 종가라 판정이 같습니다. 그때도 최고가가 낮아졌으면 밤 잠정 종가를
     * 낮아진 스탑가로 다시 보고, 스탑가 위면 취소합니다. 근거에 최고가·비율이 없으면(손으로 넣은 주문) 다시 판정할 수 없어 잠정 판정대로 집행합니다.
     */
    private static StopCheck rejudgeStop(BookRun run, Order order) {
        LocalDate detected = order.asOfTradingDate();
        KrConfirmed.Series series = run.confirmed.of(order.ticker());
        Optional<BigDecimal> close = detected == null ? Optional.empty() : series.closeOn(detected);
        Double detectedWatermark = positive(order.reason(), "highWatermark");
        Double corrected = positive(order.reason(), STOP_CONFIRMED_WATERMARK);
        Double pct = positive(order.reason(), "stopPct");
        boolean lowered = detectedWatermark != null && corrected != null && corrected < detectedWatermark;
        Double watermark = lowered ? corrected : detectedWatermark;
        String watermarkNote = lowered ? "최고가는 감지 뒤 금융위 확정 조정이 다시 센 " + won(corrected) + "원(감지 때 "
                + won(detectedWatermark) + "원 — 잠정 체결가)" : null;
        if (close.isEmpty()) {
            String note = "금융위 " + detected + " 확정 종가 없음(아직 들어오지 않음·그날 거래 없음) — 밤 잠정 종가의 판정대로 집행";
            Double observed = positive(order.reason(), "observedPrice");
            if (lowered && pct != null && pct < 100 && observed != null && !TrailingStop.triggered(watermark, observed, pct)) {
                return new StopCheck(STOP_BASIS_PROVISIONAL, null, STOP_NOT_CONFIRMED + " — 밤 잠정 종가 " + won(observed)
                        + "원이 확정 조정으로 낮아진 스탑가 " + won(TrailingStop.stopPrice(watermark, pct)) + "원(최고가 " + won(watermark)
                        + " × (1 − " + trim(pct) + "%)) 위: 감지 때 최고가 " + won(detectedWatermark)
                        + "원(잠정 체결가)의 판정이라 취소(재진입 금지 없음, 금융위 " + detected + " 종가는 아직 없음)", watermarkNote);
            }
            return new StopCheck(STOP_BASIS_PROVISIONAL, null, null, watermarkNote == null ? note : note + "; " + watermarkNote);
        }
        if (watermark == null || pct == null || pct >= 100) {
            return new StopCheck(STOP_BASIS_PROVISIONAL, close.get(), null,
                    "근거에 최고가·스탑 비율이 없어 금융위 종가로 다시 판정할 수 없음 — 잠정 판정대로 집행");
        }
        double confirmed = close.get().doubleValue();
        if (TrailingStop.triggered(watermark, confirmed, pct)) {
            return new StopCheck(series.source(), close.get(), null, watermarkNote);
        }
        double stopPrice = TrailingStop.stopPrice(watermark, pct);
        return new StopCheck(series.source(), close.get(), STOP_NOT_CONFIRMED + " — 금융위 " + detected + " 종가 "
                + won(confirmed) + "원이 스탑가 " + won(stopPrice) + "원(최고가 " + won(watermark) + " × (1 − " + trim(pct)
                + "%)) 위: 밤 잠정 종가 " + won(positive(order.reason(), "observedPrice")) + "원("
                + Json.asText(order.reason(), "observedSource") + ")의 감지를 확정 종가가 뒷받침하지 않아 취소(재진입 금지 없음)",
                watermarkNote);
    }

    /** 근거 JSON의 양수 칸(아니면 null). */
    private static Double positive(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        return value != null && value.isNumber() && Double.isFinite(value.asDouble()) && value.asDouble() > 0
                ? value.asDouble() : null;
    }

    /** 체결한 스탑의 재진입 금지 — 체결한 날(그 시가 봉 날짜)부터 {@code kr.lockoutTradingDays}거래일(K30 — 감지한 날이 아님). */
    private void stopLockout(BookRun run, Order order, StopCheck stop, Bar bar, double price) {
        LocalDate until = TrailingStop.lockoutUntil(run.market.calendar(), bar.date(), run.settings.lockoutTradingDays());
        store.upsertLockout(new Lockout(run.book.code(), order.ticker(), until,
                "트레일링 스탑 −%s%%: 최고가 %s → %s 잠정 종가 %s(판정 %s) · %s 시가 %s 체결".formatted(
                        won(positive(order.reason(), "stopPct")), won(positive(order.reason(), "highWatermark")),
                        order.asOfTradingDate(), won(positive(order.reason(), "observedPrice")), stop.basis(), bar.date(),
                        won(price))));
        run.lockouts.put(order.ticker(), until);
        run.stopped++;
        run.note("주문 " + order.id() + " " + order.ticker() + " 트레일링 스탑 체결 — 판정 " + stop.basis()
                + (stop.confirmedClose() == null ? "" : "(금융위 " + order.asOfTradingDate() + " 종가 "
                + stop.confirmedClose().stripTrailingZeros().toPlainString() + "원)")
                + ", 재진입 금지 " + until + "까지(체결한 날부터)");
    }

    /**
     * 그쪽(매도·매수)·그 묶음(시가 = {@code NEXT_OPEN}, 종가 = 그 밖의 시점)의 대기 주문을 만든 순서대로 — 현금성(설정 {@code kr.cashLikeTickers})이
     * 아닌 것 먼저, 현금성은 그 묶음 마지막(명세 §4-2, 미국 {@link #fill}의 이유와 같음 — 남는 현금 주문이 신호 종목과 현금을 다투지 않게).
     */
    private void auctionFills(BookRun run, List<Order> pending, String side, boolean open) {
        for (boolean cashLikePass : new boolean[]{false, true}) {
            for (Order order : pending) {
                if (side.equals(order.side()) && PaperBooks.NEXT_OPEN.equals(order.timing()) == open
                        && run.settings.cashLike(order.ticker()) == cashLikePass) {
                    if (PaperBooks.SELL.equals(side)) {
                        auctionSell(run, order);
                    } else {
                        auctionBuy(run, order);
                    }
                }
            }
        }
    }

    private void auctionSell(BookRun run, Order order) {
        Bar observed = run.bar(order.ticker());
        if (observed == null) {
            return;   // 이번 관측치에 그 종목이 없음 — 다음 관측치
        }
        if (heldByCorporateAction(run, order)) {
            return;
        }
        PaperMarket.FillChoice choice = run.chooseFill(order, observed);
        if (choice.bar() == null) {
            waitNote(run, order, choice.waitReason());
            return;
        }
        Holding holding = run.holdings.get(order.ticker());
        if (holding == null) {
            cancel(run, order, "체결 시점에 보유가 없습니다");
            return;
        }
        if (!holding.verified) {
            return;
        }
        StopCheck stop = PaperBooks.SOURCE_STOP.equals(order.source()) ? rejudgeStop(run, order) : null;
        if (stop != null && stop.cancelReason() != null) {
            store.updateOrderReason(order.id(), withFields(order, stop.fields()));
            cancel(run, order, stop.cancelReason());   // 확정 종가가 감지를 뒷받침하지 않음 — 재진입 금지 없음(K30)
            return;
        }
        int qty = sellQty(run, order, holding);
        if (qty < 0) {
            return;
        }
        FillTerms terms = run.fill(order, choice.bar());
        if (terms.holdReason() != null) {
            holdNote(run, order, terms.holdReason());
            return;
        }
        FillTerms.Costs costs = terms.costs(qty);
        recordFill(run, order.id(), order.ticker(), PaperBooks.SELL, qty, terms, costs, choice.bar());
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        holding.qty -= qty;
        if (holding.qty == 0) {
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);
        }
        annotate(run, order, null, qty, terms.warnings(), stop == null ? Map.of() : stop.fields());
        if (stop != null) {
            stopLockout(run, order, stop, choice.bar(), terms.price());
        }
        run.filled++;
    }

    private void auctionBuy(BookRun run, Order order) {
        Bar observed = run.bar(order.ticker());
        if (observed == null) {
            return;
        }
        if (heldByCorporateAction(run, order)) {
            return;
        }
        PaperMarket.FillChoice choice = run.chooseFill(order, observed);
        if (choice.bar() == null) {
            waitNote(run, order, choice.waitReason());
            return;
        }
        Bar bar = choice.bar();
        Holding holding = run.holdings.get(order.ticker());
        if (holding != null && !holding.verified) {
            return;
        }
        LocalDate until = run.lockouts.get(order.ticker());
        if (TrailingStop.lockedOut(until, bar.date())) {
            cancel(run, order, "재진입 금지 중입니다(" + until + "까지, 트레일링 스탑)");
            return;
        }
        FillTerms terms = run.fill(order, bar);
        if (terms.holdReason() != null) {
            holdNote(run, order, terms.holdReason());
            return;
        }
        int wanted;
        if (order.qty() != null) {
            wanted = order.qty();
        } else if (order.targetWeightPct() != null && Double.isFinite(order.targetWeightPct())) {
            // 목표 금액 = 목표 비중 × 체결 직전 순자산(processAuction 설명의 '순자산 기준'), 수수료·슬리피지 포함 유출이 그 안.
            wanted = terms.affordableQty(order.targetWeightPct() / 100.0 * run.nav());
        } else {
            cancel(run, order, "매수 크기(수량·목표 비중)가 없습니다");
            return;
        }
        if (wanted <= 0) {
            cancel(run, order, "목표 금액으로 1주도 살 수 없습니다");
            return;
        }
        int qty = Math.min(wanted, terms.affordableQty(run.cash));   // 현금 한도도 비용 포함 유출로
        if (qty <= 0) {
            cancel(run, order, "현금이 모자라 1주도 살 수 없습니다(현금 " + money(run.cash) + ")");
            return;
        }
        FillTerms.Costs costs = terms.costs(qty);
        recordFill(run, order.id(), order.ticker(), PaperBooks.BUY, qty, terms, costs, bar);
        store.markOrderFilled(order.id(), run.at);
        run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
        double price = terms.price();
        if (holding == null) {
            // 평단 = 체결가(비용은 비용 칸 — 결정 d14), 평가 가격은 평가 단계 전까지 체결가, 최고가 처음 값 = 체결가(올리는 규칙은 다음 단계 —
            // K30), since 봉(fill_ref) = 체결한 관측 봉의 날짜·원시 종가·거래량(기업행위 판정 — 결정 d12, 다음 관측치가 그 뒤를 판정).
            holding = new Holding(order.ticker(), qty, price, bar.date(), run.at, price, run.at, price, run.at, bar.date(),
                    bar.close());
            holding.fillRefVolume = bar.kr() == null ? null : bar.kr().day(bar.date()).map(KrQuotes.Day::volume).orElse(null);
            holding.verified = true;
            holding.opened = true;
            run.holdings.put(holding.ticker, holding);
        } else {
            holding.avgCost = PaperLedger.averageCost(holding.qty, holding.avgCost, qty, price);
            holding.qty += qty;
        }
        annotate(run, order, qty < wanted ? wanted : null, qty, terms.warnings());
        run.filled++;
    }

    /**
     * 이번 관측치의 그 종목 마지막 봉 종가로 평가(이어받은 항목·없는 종목은 마지막 가격 + '가격 없음' — 한쪽 출처만 실패·모름이면 사라진 종목이 아니라
     * 이것뿐, §4-2 'B7 구현에서 정한 것'). 미처리 기업행위 보유는 묶인 평가 그대로입니다.
     */
    private static void revalueAuction(BookRun run) {
        for (Holding holding : run.holdings.values()) {
            if (holding.corpHold != null) {
                continue;
            }
            Bar bar = run.bar(holding.ticker);
            if (bar == null || bar.stale()) {
                holding.priceStale = true;
                continue;
            }
            holding.lastPrice = bar.close();
            holding.lastPriceAt = run.at;
            holding.priceStale = false;
        }
    }

    /**
     * 체결한 주문의 근거에 남길 것 — 현금이 모자라 요청보다 적게 샀으면 {@code cashLimited}(미국과 같은 칸), 체결 경고(사다리를 내려감·호가에
     * 안 맞는 관측가 — {@link FillTerms#warnings})는 {@code fillWarnings}. 경고는 작업 기록에도 남깁니다.
     *
     * @param requested 현금 부족으로 줄였을 때 요청 수량(아니면 null)
     */
    private void annotate(BookRun run, Order order, Integer requested, int filledQty, List<String> warnings) {
        annotate(run, order, requested, filledQty, warnings, Map.of());
    }

    /** {@link #annotate(BookRun, Order, Integer, int, List)}에 더해 근거에 칸을 덧붙입니다(한국 스탑의 판정 근거 {@code stopBasis} 등). */
    private void annotate(BookRun run, Order order, Integer requested, int filledQty, List<String> warnings,
                          Map<String, Object> extra) {
        if (requested == null && warnings.isEmpty() && extra.isEmpty()) {
            return;
        }
        ObjectNode reason = withFields(order, extra);
        if (requested != null) {
            reason.put("cashLimited", true);
            reason.put("requestedQty", requested);
            reason.put("filledQty", filledQty);
            run.note("주문 " + order.id() + " " + order.ticker() + " 현금 부족으로 " + requested + "주 중 " + filledQty
                    + "주만 매수(cashLimited)");
        }
        if (!warnings.isEmpty()) {
            warnings.forEach(reason.putArray("fillWarnings")::add);
            warnings.forEach(text -> run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 체결 경고 — "
                    + text));
        }
        store.updateOrderReason(order.id(), reason);
    }

    /** 그 주문의 근거(JSON) 사본에 칸을 덧붙인 것(근거가 객체가 아니면 새 객체). */
    private ObjectNode withFields(Order order, Map<String, Object> fields) {
        ObjectNode reason = order.reason() instanceof ObjectNode existing ? existing.deepCopy() : mapper.createObjectNode();
        fields.forEach((key, value) -> reason.set(key, mapper.valueToTree(value)));
        return reason;
    }

    /** 체결하지 않고 기다리는 주문의 사유(1분봉 기다림 등) — 작업 기록에만(주문은 대기 그대로). 사유가 없는 기다림은 남기지 않습니다. */
    private static void waitNote(BookRun run, Order order, String reason) {
        if (reason != null) {
            run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 체결 기다림 — " + reason);
        }
    }

    /**
     * 기업행위로 그날 보류한 종목의 주문인가(판정 대기·분할을 반영한 날·미처리 기업행위 보유 — {@link #corporateActions}) — 그렇다면 체결하지
     * 않고 대기 그대로(만료까지) 두고 작업 기록에 사유.
     */
    private static boolean heldByCorporateAction(BookRun run, Order order) {
        String reason = run.orderHolds.get(order.ticker());
        if (reason == null) {
            return false;
        }
        holdNote(run, order, reason);
        return true;
    }

    /** 비용을 셀 수 없어 보류한 주문(종목 구분 모름·세율 모름) — 작업 기록에만(주문은 대기 그대로 — 만료까지). */
    private static void holdNote(BookRun run, Order order, String reason) {
        run.note("주문 " + order.id() + " " + order.side() + " " + order.ticker() + " 보류 — " + reason);
    }

    // ------------------------------------------------------------------ 4. 최고가·트레일링 스탑
    /** 이번 가격을 믿을 수 있는 보유(분할 확인됨)의 최고가를 관측가로 올립니다. 일시정지 책도 따라갑니다. */
    private void raiseWatermarks(BookRun run) {
        for (Holding holding : run.holdings.values()) {
            if (holding.verified) {
                raiseWatermark(holding, run.bar(holding.ticker).close(), run.at);
            }
        }
    }

    private void checkStops(BookRun run) {
        double stopPct = run.settings.trailingStopPct();
        for (Holding holding : new ArrayList<>(run.holdings.values())) {
            if (!holding.verified || run.settings.cashLike(holding.ticker)) {
                continue;   // 이번 가격을 믿을 수 없거나(가격 없음) 현금성(SHY) — 스탑을 보지 않음
            }
            Bar bar = run.bar(holding.ticker);
            if (!TrailingStop.triggered(holding.highWatermark, bar.close(), stopPct)) {
                continue;
            }
            double stopPrice = TrailingStop.stopPrice(holding.highWatermark, stopPct);
            int qty = holding.qty;
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("trigger", "TRAILING_STOP");
            reason.put("stopPct", stopPct);
            reason.put("highWatermark", PaperLedger.round4(holding.highWatermark));
            reason.put("stopPrice", PaperLedger.round4(stopPrice));
            reason.put("observedPrice", bar.close());
            reason.put("barDate", bar.date().toString());
            // 스탑은 관측치가 만든 주문이라 생성·체결 시각 모두 그 관측치의 수집 시각입니다(IMMEDIATE). 체결가는 시장 몫(그 관측가).
            Order stop = new Order(0, run.book.code(), null, holding.ticker, PaperBooks.SELL, qty,
                    null, null, PaperBooks.IMMEDIATE, PaperBooks.SOURCE_STOP, PaperBooks.ORDER_FILLED, null,
                    mapper.valueToTree(reason), bar.date(), run.at, null, run.at);
            FillTerms terms = run.fill(stop, bar);
            FillTerms.Costs costs = terms.costs(qty);
            long orderId = store.insertOrder(stop);
            recordFill(run, orderId, holding.ticker, PaperBooks.SELL, qty, terms, costs, bar);
            run.cash = PaperLedger.round4(run.cash + costs.cashDelta());
            run.holdings.remove(holding.ticker);
            run.removed.add(holding.ticker);

            LocalDate until = TrailingStop.lockoutUntil(run.market.calendar(), bar.date(),
                    run.settings.lockoutTradingDays());
            store.upsertLockout(new Lockout(run.book.code(), holding.ticker, until,
                    "트레일링 스탑 −%s%%: 최고가 %s → 관측가 %s (%s)".formatted(trim(stopPct),
                            money(holding.highWatermark), money(bar.close()), bar.date())));
            run.lockouts.put(holding.ticker, until);
            run.stopped++;
        }
    }

    // ------------------------------------------------------------------ 5. 평가·저장
    private void settle(BookRun run, BookState state, boolean started) {
        String code = run.book.code();
        PaperLedger.Valuation valuation = run.valuation();
        for (String ticker : run.removed) {
            if (!run.holdings.containsKey(ticker)) {
                store.deletePosition(code, ticker);
            }
        }
        for (Holding holding : run.holdings.values()) {
            store.upsertPosition(holding.toPosition(code));
            if (run.market.auctionFills()) {
                store.updateFillRefVolume(code, holding.ticker, holding.fillRefVolume);   // since 봉 거래량(V15 — 보유 레코드 밖)
            }
        }
        LocalDate navDate = state.lastNavTradingDate();
        LocalDate barDate = run.quotes.modalBarDate();
        // 그 세션의 마감 뒤 관측치일 때만 그 거래일(다수 티커의 봉 날짜) 순자산을 남깁니다(L9, 클래스 설명의 '순자산 줄').
        // 관측 시각의 세션이 봉 날짜와 달라졌으면(다음 날 개장 뒤) 지난 줄을 다시 쓰지 않습니다. 출발일 전 날짜도 남기지 않습니다.
        boolean sessionClose = barDate != null && barDate.equals(run.session)
                && run.market.closeAvailable(barDate, run.at)
                && (run.book.startedOn() == null || !barDate.isBefore(run.book.startedOn()));
        if (started && sessionClose) {
            // 확정 조정 시장(한국)은 그날까지의 체결이 모두 확정됐을 때만 — 현금에 잠정 체결가가 남아 있으면 현금뿐인 줄도 잠정(K29, C3).
            // 그날 이하 봉으로 나중에 체결될 수 있는 대기 주문(기준일 < 그날 — 1분봉 FAILED 기다림·보류, 그날 개장 뒤 생성은 빼고 — 조건 ⑤)이
            // 있어도 잠정입니다: 그 체결이 뒤늦게 그날 날짜로 들어오면 그 줄에는 그 체결이 빠져 있는데, 확정 줄은 다시 쓰이지 않기 때문입니다(묶음 C 리뷰).
            boolean pricesFinal = allFinal(run, barDate) && (!run.market.confirmsFills()
                    || (confirmedThrough(code, barDate) && KrConfirmations.pendingThrough(store, run.market,
                    run.market.calendar(), code, barDate).isEmpty()));
            store.upsertNav(new NavRow(code, barDate, PaperLedger.round4(valuation.nav()), PaperLedger.round4(run.cash),
                    PaperLedger.round4(valuation.equityValue()), PaperLedger.round4(valuation.exposurePct()),
                    pricesFinal));
            navDate = navDate == null || barDate.isAfter(navDate) ? barDate : navDate;
        }
        store.upsertState(new BookState(code, PaperLedger.round4(run.cash), PaperLedger.round4(valuation.nav()),
                PaperLedger.round4(valuation.equityValue()), PaperLedger.round4(valuation.exposurePct()), run.at, run.at,
                navDate, null));
    }

    /** 그 책의 체결 중 체결일 ≤ {@code day}인 것이 모두 금융위 확정 조정을 받았나(확정 조정 시장 — K29, C3). */
    private boolean confirmedThrough(String code, LocalDate day) {
        return store.unconfirmedFills(code).stream()
                .allMatch(u -> u.fill().observationDate() != null && u.fill().observationDate().isAfter(day));
    }

    /**
     * 이 책의 보유가 모두 그 세션의 확정 봉으로 평가됐나 — 이번 관측치의 새 봉(이어 쓴 봉 아님)이고 분할을 확인했고 봉 날짜가
     * 그 세션이고 그 가격이 확정({@link PaperMarket#pricesConfirmed}). 하나라도 마지막으로 본 값으로 평가했으면 false(클래스 설명).
     * 보유가 없으면(현금뿐) true.
     */
    private static boolean allFinal(BookRun run, LocalDate session) {
        for (Holding holding : run.holdings.values()) {
            Bar bar = run.bar(holding.ticker);
            if (!holding.verified || bar == null || bar.stale() || !session.equals(bar.date())
                    || !run.market.pricesConfirmed(bar.date(), run.at)) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------ 결정 작업이 채우는 순자산 줄
    /** 미국 책의 미확정 순자산 줄 — {@link #settleNav(PaperMarket, LocalDate, boolean)}의 미국 판(결정 작업이 부름). */
    public List<String> settleNav(LocalDate tradingDate, boolean pricesFinal) {
        return settleNav(UsPaperMarket.INSTANCE, tradingDate, pricesFinal);
    }

    /**
     * 결정 작업이 확정 종가를 끝내 받지 못한 채 마감 기한(설정 {@code decisionDeadlineKst}, 기본 12:00 KST)을 넘겨 진행할 때,
     * 그 거래일 순자산 줄이 없는 책에 지금 상태(마지막 관측치의 평가)를 <b>미확정</b>({@code prices_final = false}) 줄로 남깁니다
     * (설계 §6-2). 확정 줄은 관측치 처리만 씁니다 — 보유마다 그 세션의 확정 봉으로 평가됐는지를 보는 곳이 거기라서
     * ({@link #process}의 '순자산 줄'), {@code pricesFinal}이 true면 아무것도 하지 않습니다. 미확정 줄은 나중의 확정 관측치가
     * 덮습니다({@link PaperStore#upsertNav}). 이미 그날 줄이 있으면(확정이든 아니든) 건드리지 않습니다. 시작한(운용·일시정지)
     * 책만, 출발일 전 날짜는 쓰지 않습니다. 그 시장 책만 봅니다 — 다른 시장 책에는 줄을 쓰지 않습니다(거래일 d는 그 시장의 세션).
     *
     * @return 줄을 새로 쓴 책(정의 순)
     */
    List<String> settleNav(PaperMarket market, LocalDate tradingDate, boolean pricesFinal) {
        if (pricesFinal) {
            return List.of();
        }
        return exclusively(() -> {
            if (!store.ready()) {
                return List.of();
            }
            List<Book> books = new ArrayList<>(store.books(market.code()));
            books.sort(Comparator.comparing(Book::code, market.bookOrder()));
            List<String> written = new ArrayList<>();
            for (Book book : books) {
                boolean started = PaperBooks.ACTIVE.equals(book.status()) || PaperBooks.PAUSED.equals(book.status());
                if (!started || book.startedOn() == null || tradingDate.isBefore(book.startedOn())) {
                    continue;
                }
                Optional<BookState> state = store.state(book.code());
                boolean exists = store.navSeries(book.code()).stream()
                        .anyMatch(row -> row.tradingDate().equals(tradingDate));
                if (state.isEmpty() || exists) {
                    continue;
                }
                BookState s = state.get();
                store.atomically(() -> {
                    store.upsertNav(new NavRow(book.code(), tradingDate, s.nav(), s.cash(), s.equityValue(),
                            s.exposurePct(), false));
                    LocalDate navDate = s.lastNavTradingDate() == null || tradingDate.isAfter(s.lastNavTradingDate())
                            ? tradingDate : s.lastNavTradingDate();
                    store.upsertState(new BookState(s.bookCode(), s.cash(), s.nav(), s.equityValue(), s.exposurePct(),
                            s.lastObservedAt(), s.lastProcessedCollectedAt(), navDate, null));
                    return null;
                });
                written.add(book.code());
            }
            return written;
        });
    }

    // ------------------------------------------------------------------ 사후 체결(BACKFILL)
    /**
     * 사후 체결 주문 한 줄.
     *
     * @param targetWeightPct 매수: 기준 순자산({@link BackfillRequest#baseNav}) 대비 살 금액(%). 매도에는 쓰지 않음
     * @param sellFraction    매도: 보유 중 팔 비율. null이면 전량
     * @param reason          주문 근거 JSON — 주문 행에 그대로 남습니다
     */
    public record BackfillLeg(String ticker, String side, Double targetWeightPct, Double sellFraction,
                              JsonNode reason) {
    }

    /**
     * 사후 체결 요청.
     *
     * @param tradingDate 체결 거래일(출발일). 그날 종가로, 관측 시각은 그날 마감(16:00 ET)
     * @param source      주문 출처(BENCHMARK·RULE …, paper_orders.source)
     * @param decisionId  그 주문을 낸 결정(벤치마크는 null)
     * @param cash        체결 전 현금
     * @param baseNav     매수 금액의 기준 순자산. 다리마다 바뀌는 순자산이 아니라 체결 전 값입니다 — 슬리피지만큼 순자산이 줄어
     *                    뒤 다리일수록 덜 사는 일이 없게(벤치마크 60/40이 처음 정한 비중대로)
     * @param closes      종목 → 그날 종가와 출처(얼린 출발일 종가 — {@link PaperAdminService#startClose})
     * @param settings    슬리피지·현금성 종목
     */
    public record BackfillRequest(Book book, LocalDate tradingDate, String source, Long decisionId, double cash,
                                  double baseNav, List<BackfillLeg> legs,
                                  Map<String, PaperMarketData.SourcedClose> closes, PaperSettings settings) {
    }

    /**
     * 사후 체결 결과.
     *
     * @param fills   낸 체결(체결 순서 — 매도 → 매수 → 현금성 매수)
     * @param skipped 체결하지 못한 다리: 티커 → 사유(종가 없음·1주도 살 수 없음·보유 없음). 주문 행은 남기지 않습니다
     */
    public record BackfillResult(List<Fill> fills, List<Map.Entry<String, String>> skipped, double cash,
                                 PaperLedger.Valuation valuation) {
    }

    /**
     * 주문 목록을 그 거래일 종가로 한 번에 체결합니다(사후 체결, 명세 L2) — 벤치마크 초기화와 규칙 책 "시작"이 함께 씁니다.
     * 미국 책만 받습니다(거래일·마감 시각은 미국 달력 — 한국은 출발일 사후 체결이 없음, 명세 K28). 다른 시장 책이면 아무것도 쓰지
     * 않고 {@link IllegalArgumentException}.
     *
     * <p>순서는 관측치 처리와 같습니다: 매도 → 현금성이 아닌 매수 → 현금성 매수({@link #fill}의 이유). 체결가는 종가에 슬리피지,
     * 매수 수량은 {@code baseNav × 목표 비중}을 체결가로 나눠 내림(현금보다 많이 사지 않음 — 줄였으면 근거에 {@code cashLimited}).
     * 주문은 출처 그대로 {@code BACKFILL}·{@code FILLED}로 남기고(생성 = 그날 마감 1초 전, 기준 거래일 = 그 전 거래일 — 기록에서
     * 주문이 관측치보다 앞서 보이게), 체결은 {@code is_backfill = true}·관측 시각 = 그날 마감·가격 출처 = 종가의 출처입니다.
     *
     * <p>끝나면 그 종가로 평가해 그 거래일 순자산 줄(확정)·상태(멱등 키 = 그날 마감 — 그 전 저장본이 나중에 처리되며 장부를
     * 되돌리지 않게)를 쓰고 책을 운용(ACTIVE)·출발일 = 그 거래일로 바꿉니다. 한 트랜잭션이고, 바깥 트랜잭션이 있으면 합류합니다 —
     * 다리 하나라도 못 사면 되돌려야 하는 쪽(벤치마크)은 바깥에서 {@code skipped}를 보고 예외를 던지면 됩니다.
     */
    public BackfillResult backfill(BackfillRequest request) {
        PaperMarket us = UsPaperMarket.INSTANCE;
        if (!us.code().equals(request.book().market())) {
            throw new IllegalArgumentException("사후 체결은 미국 책만 합니다 — " + request.book().code() + "은 "
                    + request.book().market() + " 책입니다(한국은 출발일 사후 체결이 없음, 명세 K28)");
        }
        return store.atomically(() -> backfillLocked(us, request));
    }

    private BackfillResult backfillLocked(PaperMarket market, BackfillRequest r) {
        String code = r.book().code();
        LocalDate day = r.tradingDate();
        Instant close = market.calendar().closeInstant(day);
        double bp = r.settings().slippageBp();
        Map<String, Position> held = new TreeMap<>();
        store.positions(code).forEach(p -> held.put(p.ticker(), p));
        double cash = r.cash();
        List<Fill> fills = new ArrayList<>();
        List<Map.Entry<String, String>> skipped = new ArrayList<>();
        for (BackfillLeg leg : backfillOrder(r.legs(), r.settings())) {
            String ticker = leg.ticker();
            PaperMarketData.SourcedClose raw = r.closes().get(ticker);
            if (raw == null) {
                skipped.add(Map.entry(ticker, day + " " + ticker + " 종가가 없습니다"));
                continue;
            }
            if (PaperBooks.SELL.equals(leg.side())) {
                Position position = held.get(ticker);
                if (position == null) {
                    skipped.add(Map.entry(ticker, "체결 시점에 보유가 없습니다"));
                    continue;
                }
                int qty = PaperLedger.sellQty(position.qty(), leg.sellFraction());
                double price = price6(PaperLedger.fillPrice(raw.close(), PaperLedger.Side.SELL, bp));
                double gross = gross(qty, price);
                fills.add(backfillFill(market, r, leg, leg.reason(), qty, price, raw, gross, close));
                cash = PaperLedger.round4(cash + gross);
                int left = position.qty() - qty;
                if (left == 0) {
                    held.remove(ticker);
                    store.deletePosition(code, ticker);
                } else {
                    Position kept = new Position(code, ticker, left, position.avgCost(), position.openedOn(),
                            position.openedAt(), position.highWatermark(), position.watermarkAt(),
                            PaperLedger.round4(raw.close()), close, false, position.fillRefDate(),
                            position.fillRefClose(), position.splitNote());
                    held.put(ticker, kept);
                    store.upsertPosition(kept);
                }
                continue;
            }
            double price = price6(PaperLedger.fillPrice(raw.close(), PaperLedger.Side.BUY, bp));
            double weight = leg.targetWeightPct() == null ? 0 : leg.targetWeightPct();
            int wanted = PaperLedger.buyQty(r.baseNav() * weight / 100.0, price);
            if (wanted <= 0) {
                skipped.add(Map.entry(ticker, ticker + " 종가(" + raw.close() + ")로는 1주도 살 수 없습니다"));
                continue;
            }
            int qty = Math.min(wanted, PaperLedger.buyQty(cash, price));
            if (qty <= 0) {
                skipped.add(Map.entry(ticker, "현금이 모자라 1주도 살 수 없습니다(현금 " + money(cash) + ")"));
                continue;
            }
            JsonNode reason = leg.reason();
            if (qty < wanted) {
                ObjectNode limited = reason instanceof ObjectNode existing ? existing.deepCopy()
                        : mapper.createObjectNode();
                limited.put("cashLimited", true);
                limited.put("requestedQty", wanted);
                limited.put("filledQty", qty);
                reason = limited;
            }
            double gross = gross(qty, price);
            fills.add(backfillFill(market, r, leg, reason, qty, price, raw, gross, close));
            cash = PaperLedger.round4(cash - gross);
            Position before = held.get(ticker);
            Position after = before == null
                    ? new Position(code, ticker, qty, PaperLedger.round4(price), day, close, PaperLedger.round4(price),
                    close, PaperLedger.round4(raw.close()), close, false, day, raw.close(), null)
                    : new Position(code, ticker, before.qty() + qty,
                    PaperLedger.round4(PaperLedger.averageCost(before.qty(), before.avgCost(), qty, price)),
                    before.openedOn(), before.openedAt(),
                    PaperLedger.round4(TrailingStop.raiseWatermark(before.highWatermark(), price)), close,
                    PaperLedger.round4(raw.close()), close, false, before.fillRefDate(), before.fillRefClose(),
                    before.splitNote());
            held.put(ticker, after);
            store.upsertPosition(after);
        }

        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position position : held.values()) {
            PaperMarketData.SourcedClose raw = r.closes().get(position.ticker());
            qty.put(position.ticker(), position.qty());
            price.put(position.ticker(), raw != null ? raw.close()
                    : position.lastPrice() != null ? position.lastPrice() : position.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(cash, qty, price);
        double nav = PaperLedger.round4(valuation.nav());
        double equity = PaperLedger.round4(valuation.equityValue());
        double exposure = PaperLedger.round4(valuation.exposurePct());
        store.upsertNav(new NavRow(code, day, nav, cash, equity, exposure, true));
        store.upsertState(new BookState(code, cash, nav, equity, exposure, close, close, day, null));
        store.updateBookStatus(code, PaperBooks.ACTIVE);
        store.updateBookStartedOn(code, day);
        return new BackfillResult(fills, skipped, cash, valuation);
    }

    /** 사후 체결 순서: 매도 → 현금성이 아닌 매수 → 현금성 매수. 같은 묶음 안은 받은 순서. */
    private static List<BackfillLeg> backfillOrder(List<BackfillLeg> legs, PaperSettings settings) {
        List<BackfillLeg> out = new ArrayList<>();
        legs.stream().filter(leg -> PaperBooks.SELL.equals(leg.side())).forEach(out::add);
        legs.stream().filter(leg -> !PaperBooks.SELL.equals(leg.side()) && !settings.cashLike(leg.ticker()))
                .forEach(out::add);
        legs.stream().filter(leg -> !PaperBooks.SELL.equals(leg.side()) && settings.cashLike(leg.ticker()))
                .forEach(out::add);
        return out;
    }

    private Fill backfillFill(PaperMarket market, BackfillRequest r, BackfillLeg leg, JsonNode reason, int qty,
                              double price, PaperMarketData.SourcedClose raw, double gross, Instant close) {
        String code = r.book().code();
        String side = PaperBooks.SELL.equals(leg.side()) ? PaperBooks.SELL : PaperBooks.BUY;
        long orderId = store.insertOrder(new Order(0, code, r.decisionId(), leg.ticker(), side, null,
                PaperBooks.SELL.equals(side) ? null : leg.targetWeightPct(),
                PaperBooks.SELL.equals(side) ? leg.sellFraction() : null, PaperBooks.BACKFILL, r.source(),
                PaperBooks.ORDER_FILLED, null, reason, market.calendar().previousTradingDay(r.tradingDate()),
                close.minusSeconds(1), null, close));
        Fill fill = new Fill(0, orderId, code, leg.ticker(), side, qty, price, raw.close(), r.settings().slippageBp(),
                gross, close, r.tradingDate(), raw.source(), true, null);
        long fillId = store.insertFill(fill);
        return new Fill(fillId, orderId, code, leg.ticker(), side, qty, price, raw.close(), r.settings().slippageBp(),
                gross, close, r.tradingDate(), raw.source(), true, null);
    }

    /**
     * 체결 행 한 줄 — 체결가·관측가·출처·슬리피지 기록값은 시장의 체결 조건({@link FillTerms}), 금액·비용 칸(수수료·세금·슬리피지 금액 —
     * 한국 체결, 미국은 0)은 그 수량의 {@link FillTerms.Costs}. 현금 변화({@link FillTerms.Costs#cashDelta})에 든 비용이 체결 행에도 그대로
     * 남습니다(C2b — 그 전에는 0이 아닌 비용 칸을 받으면 버리지 않고 그 책을 되돌렸음). 관측 시각은 그 관측치의 수집 시각, 관측일은 그 봉 날짜입니다.
     */
    private void recordFill(BookRun run, long orderId, String ticker, String side, int qty, FillTerms terms,
                            FillTerms.Costs costs, Bar bar) {
        store.insertFill(new Fill(0, orderId, run.book.code(), ticker, side, qty, terms.price(), terms.rawPrice(),
                terms.slippageBp(), costs.gross(), run.at, bar.date(), terms.priceSource(), false, null, costs.fee(),
                costs.tax(), costs.slippageCost()));
    }

    static void raiseWatermark(Holding holding, double price, Instant at) {
        double raised = TrailingStop.raiseWatermark(holding.highWatermark, price);
        if (raised > holding.highWatermark) {
            holding.highWatermark = raised;
            holding.watermarkAt = at;
        }
    }

    // ------------------------------------------------------------------ 숫자
    /** 체결가를 저장 열(NUMERIC(18,6))과 같은 자리로 — 그래야 체결 금액 = 수량 × 화면의 체결가가 맞습니다. */
    static double price6(double price) {
        return BigDecimal.valueOf(price).setScale(6, RoundingMode.HALF_UP).doubleValue();
    }

    /** 체결 금액 = 수량 × 체결가, 소수 4자리(십진수). */
    static double gross(int qty, double price) {
        return BigDecimal.valueOf(price).multiply(BigDecimal.valueOf(qty)).setScale(4, RoundingMode.HALF_UP)
                .doubleValue();
    }

    static String money(double value) {
        return BigDecimal.valueOf(value).setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private static String trim(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    /** 한국 금액·가격 표기(원 — 소수 끝 0을 뗀 십진수, 모르면 "모름"). */
    private static String won(Double value) {
        return value == null ? "모름" : trim(value);
    }

    private static String appendNote(String existing, String note) {
        String joined = existing == null || existing.isBlank() ? note : existing + " · " + note;
        return joined.length() <= SPLIT_NOTE_MAX ? joined : joined.substring(joined.length() - SPLIT_NOTE_MAX);
    }

    // ------------------------------------------------------------------ 작업 상태
    /** 책 하나를 처리하는 동안의 작업 상태(트랜잭션 안에서만 삶). 미국 시각 지정 체결({@link UsTimedFills})도 이 상태로 일합니다. */
    static final class BookRun {
        /** 그 책의 시장 — 세션 날짜·확정 판정 셋·분할 기준 이력·체결 가격 출처. */
        final PaperMarket market;
        final Book book;
        final Quotes quotes;
        final PaperSettings settings;
        /** 그 실행이 읽은 설정 본문(시장의 체결 봉 고르기가 씀 — 한국 1분봉 기다림의 끝 = 결정 기한). 행이 없으면 null. */
        final JsonNode settingsBody;
        final Instant at;
        /** 관측 시각의 세션 날짜(시장 달력 — 장중·마감 뒤면 그날, 개장 전·주말이면 직전 거래일). */
        final LocalDate session;
        double cash;
        final Map<String, Holding> holdings = new TreeMap<>();
        final Set<String> removed = new LinkedHashSet<>();
        final Map<String, LocalDate> lockouts = new HashMap<>();
        final List<String> notes = new ArrayList<>();
        /** 운영 알림(미처리 기업행위 보류가 5거래일 넘음 — {@link Outcome#alerts}). */
        final List<String> alerts = new ArrayList<>();
        /** 기업행위로 그날 보류한 종목 → 사유(시가 체결 장부). */
        final Map<String, String> orderHolds = new HashMap<>();
        /** 그 책 종목의 확정 시세(시가 체결 장부 — {@link PaperMarket#confirmedPrices}). */
        KrConfirmed confirmed = KrConfirmed.NONE;
        /** 미국: 1분봉 기다림으로 이 관측치를 미룬 사유 — 있으면 이 책은 아무것도 쓰지 않았습니다({@link UsTimedFills#barsWait}). */
        String barsWait;
        /** 미국: 1분봉 기다림이 풀린 사유(미뤘던 관측치를 처리할 때 작업 기록에 한 줄). */
        String barsReleased;
        /** 미국: 이 관측치에서 풀어야 할 시각 지정 주문이 있음(2b를 돌림). */
        boolean timedDue;
        /** 미국: 만료 단계가 지난 재진입 금지를 지우기 전의 금지(종목 → 마지막 날) — 2b가 목표 세션 E로 판정. */
        final Map<String, LocalDate> timedLockouts = new HashMap<>();
        int filled;
        int stopped;
        int expired;
        int splits;

        BookRun(PaperMarket market, Book book, Quotes quotes, PaperSettings settings, double cash,
                JsonNode settingsBody) {
            this.market = market;
            this.book = book;
            this.quotes = quotes;
            this.settings = settings;
            this.settingsBody = settingsBody;
            this.at = quotes.collectedAt();
            this.session = market.calendar().currentOrLastSession(at);
            this.cash = cash;
        }

        Bar bar(String ticker) {
            return quotes.bars().get(ticker);
        }

        /** 그 주문을 그 봉으로 체결하는 조건 — 시장 몫(결정 d10), 이 실행이 읽은 설정과 그 실행의 달력으로. */
        FillTerms fill(Order order, Bar bar) {
            return market.fill(order, bar, settings, market.calendar());
        }

        /** 그 주문을 이 관측치(그 종목의 봉)로 체결할 봉 — 시장 몫({@link PaperMarket#fillBar}), 그 실행의 달력·설정 본문으로. */
        PaperMarket.FillChoice chooseFill(Order order, Bar bar) {
            return market.fillBar(order, bar, at, market.calendar(), settingsBody);
        }

        void note(String text) {
            notes.add(text);
        }

        PaperLedger.Valuation valuation() {
            Map<String, Integer> qty = new HashMap<>();
            Map<String, Double> price = new HashMap<>();
            for (Holding holding : holdings.values()) {
                qty.put(holding.ticker, holding.qty);
                price.put(holding.ticker, holding.valuationPrice());
            }
            return PaperLedger.value(cash, qty, price);
        }

        double nav() {
            return valuation().nav();
        }
    }

    /** 보유 한 건의 작업 사본. 끝에 {@link #toPosition}으로 저장합니다. */
    static final class Holding {
        final String ticker;
        int qty;
        double avgCost;
        final LocalDate openedOn;
        final Instant openedAt;
        double highWatermark;
        Instant watermarkAt;
        Double lastPrice;
        Instant lastPriceAt;
        boolean priceStale;
        LocalDate fillRefDate;
        double fillRefClose;
        String splitNote;
        /** 이번 관측치의 가격을 믿을 수 있나(새 봉이 있고 분할 여부를 확인함) — 체결·스탑의 전제. */
        boolean verified;
        /** 한국: since 봉(fill_ref)의 토스 원시 거래량(V15 — 보유 레코드 밖, 모르면 null). */
        Long fillRefVolume;
        /** 한국: '미처리 기업행위' 사유(corp_action_hold — 걸려 있으면 평가 묶음·스탑 없음·주문 보류). */
        String corpHold;
        /** 한국: 이번 관측치의 기업행위 판정 종류(판정하지 않았으면 null). */
        Kind assessed;
        /** 한국: 이번 관측치에서 분할·병합을 반영했으면 그 비율이 바뀐 날 E(그 전 가격은 옛 단위). */
        LocalDate splitFrom;
        /** 한국: 이번 관측치에서 새로 산 보유(since 봉은 체결 봉 그대로). */
        boolean opened;
        /** 한국: 이번 관측치 시작 때의 since 날짜(최고가를 올리는 확정 종가의 첫 날 — 새 보유는 체결 봉 날짜). */
        final LocalDate sinceAtStart;
        /**
         * 이번 관측치로 가격을 갱신하기 전의 평가 가격(분할을 반영한 단위) — 미국 시각 지정 체결이 T 시각의 순자산을 셀 때 그 종목의 T 창 가격이
         * 없으면 씁니다(W의 관측가로 T의 수량을 정하지 않게, 명세 2026-10-30 §10-3). 이번 2b에서 산 보유는 그 체결 원가격.
         */
        double priceBefore;

        Holding(Position p) {
            this.ticker = p.ticker();
            this.qty = p.qty();
            this.avgCost = p.avgCost();
            this.openedOn = p.openedOn();
            this.openedAt = p.openedAt();
            this.highWatermark = p.highWatermark();
            this.watermarkAt = p.watermarkAt();
            this.lastPrice = p.lastPrice();
            this.lastPriceAt = p.lastPriceAt();
            this.priceStale = p.priceStale();
            this.fillRefDate = p.fillRefDate();
            this.fillRefClose = p.fillRefClose();
            this.splitNote = p.splitNote();
            this.sinceAtStart = p.fillRefDate();
            this.priceBefore = valuationPrice();
        }

        Holding(String ticker, int qty, double avgCost, LocalDate openedOn, Instant openedAt, double highWatermark,
                Instant watermarkAt, double lastPrice, Instant lastPriceAt, LocalDate fillRefDate, double fillRefClose) {
            this.ticker = ticker;
            this.qty = qty;
            this.avgCost = avgCost;
            this.openedOn = openedOn;
            this.openedAt = openedAt;
            this.highWatermark = highWatermark;
            this.watermarkAt = watermarkAt;
            this.lastPrice = lastPrice;
            this.lastPriceAt = lastPriceAt;
            this.fillRefDate = fillRefDate;
            this.fillRefClose = fillRefClose;
            this.sinceAtStart = fillRefDate;
            this.priceBefore = lastPrice;
        }

        /** 평가 가격: 마지막으로 본 가격, 한 번도 못 봤으면 평단(가격 없음 배지와 함께). */
        double valuationPrice() {
            return lastPrice != null ? lastPrice : avgCost;
        }

        Position toPosition(String code) {
            return new Position(code, ticker, qty, PaperLedger.round4(avgCost), openedOn, openedAt,
                    PaperLedger.round4(highWatermark), watermarkAt, lastPrice == null ? null : PaperLedger.round4(lastPrice),
                    lastPriceAt, priceStale, fillRefDate, fillRefClose, splitNote);
        }
    }
}
