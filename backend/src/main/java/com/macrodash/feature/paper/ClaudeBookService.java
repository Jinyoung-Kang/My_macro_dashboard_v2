package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.feature.ai.AiService;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Attempt;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.LedgerView;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.MarketContext;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Plan;
import com.macrodash.feature.paper.ClaudeDecisionPipeline.Planned;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.TooManyRequestsException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;

import static com.macrodash.feature.paper.ClaudeDecisionPipeline.cashOnly;
import static com.macrodash.feature.paper.ClaudeDecisionPipeline.fillsView;
import static com.macrodash.feature.paper.ClaudeDecisionPipeline.observedUniverse;
import static com.macrodash.feature.paper.ClaudeDecisionPipeline.statusLabel;
import static com.macrodash.feature.paper.ClaudeDecisionPipeline.usageView;

/**
 * 🧪 Claude 재량 책(실험군) — 하루 한 번 Claude가 입력 패킷을 보고 주문과 목표 주식 노출을 <b>제안</b>하고, 검증기가 하드 규칙으로
 * 통과·거절합니다(명세 C1~C11·D5·D7·D18·D26, 설계 §5-1~§5-6).
 *
 * <p><b>결정 한 번</b>({@link #decide}): ① 일일 호출 상한(설정 {@code apiDailyCallCap}, 기본 20(2026-10-26 v2, 처음은 6) — KST 하루, 결정·미리보기·시작·재시도와
 * 프레임 제안을 모두 셈 — {@link PaperApiCalls}) → ② 시스템 프롬프트(지금 프레임 판을 결정 시점 설정으로 렌더링한 것 —
 * {@link FrameworkService#render}, 판이 없으면 임시 v0을 시드) → ③ 패킷({@link PacketBuilder}, 섹션 1에 그 판 번호) →
 * ④ 구조화 출력 호출 한 번({@link AiService#structured}, 설정 {@code model}·{@code effort}, 자동 전환 없음 — D5) → ⑤ 사용량 기록
 * (성공·실패 모두 호출 +1, 토큰·추정 비용 합산) → ⑥ 스키마 전체 검사({@link StructuredSchema#validate} — API에는 보낼 수 없는 범위·길이·개수
 * 제약까지, D26) → ⑦ 검증기({@link OrderValidator}) → 통과 주문은 대기(PENDING, 출처 CLAUDE, 시점은 응답대로), 거절 주문은 사유와
 * 함께 REJECTED → ⑧ 결정 기록(패킷·해시·원문·검증한 응답·사용량·모델·프레임 판·설정 판·목표 노출·exposureMismatch·메모 번호·지연·
 * 확정 종가·측정 태그 {@code response.measure}). 프레임 판은 Claude를 부른 결정이면 늘 남깁니다(임시 v0 포함 — 응답의 {@code framework = {version, status, title}}).
 *
 * <p><b>실패</b>(C3·C7): 401·403·404·429·5xx·연결·시간 초과는 {@code API_ERROR}, 안전 분류기 거절은 {@code REFUSED}, JSON이 아니거나
 * 스키마 밖이면 {@code FORMAT_ERROR}. 출력 한도로 잘린 응답({@code MAX_TOKENS})과 200인데 텍스트가 없는 응답({@code EMPTY})도 모델이
 * 이미 답한(과금된) 스키마 밖 응답이라 {@code FORMAT_ERROR}입니다. 어느 실패든 그날 재량 주문은 없고 기록만 남습니다 — 리스크 규칙
 * (스탑)은 장부가 따로 계속합니다. <b>재시도는 API_ERROR만, 같은 거래일·같은 종류에 한 번</b>: 다음 결정 작업(또는 같은 버튼)이 그 행을
 * 다시 내고({@code retry_count = 1}) 행을 새로 만들지 않습니다. 거절·형식 오류는 같은 입력이면 같은 답일 가능성이 커 다시 부르지
 * 않습니다(비용만 듦). <b>응답을 받은 뒤</b>(과금됨) 검증·저장이 예외로 끝나도 원문·사용량·오류를 따로 한 트랜잭션으로 남기고 다시 부르지
 * 않는 행({@code API_ERROR}·{@code retry_count = 1})으로 둡니다 — 행이 없으면 결정 작업이 다음 주기마다 Claude를 또 부릅니다.
 *
 * <p><b>매수 비중의 두 뜻</b>: Claude 응답의 BUY {@code targetWeightPct}는 "체결 뒤 그 종목의 목표 비중"(검증기·패킷 하드 규칙)이고,
 * 장부의 매수 주문 {@code targetWeightPct}는 "체결 시점 순자산 대비 살 금액"(규칙 책과 같음)입니다. 그래서 통과한 매수는
 * {@link OrderValidator#buyIncrementPct}(목표 − 현재)를 주문에 넣고 목표는 근거({@code reason.proposed}, 규칙 책과 같은 키
 * {@code reason.targetWeightPct}에도)에 남깁니다 — 그대로 넣으면 이미 든 종목을 목표보다 더 삽니다. 거절한 매수(REJECTED) 행은 집행되지
 * 않으므로 받은 값 그대로(목표 비중) 남깁니다 — "무엇을 왜 거절했나"가 기록에 보이게(V8 주문 표 설명). 화면은 거절 행을 "목표 …%
 * (제안)"으로 적습니다.
 *
 * <p><b>새 결정은 앞선 대기 주문을 대신합니다</b>: 검증까지 끝난 결정(OK·NO_TRADE)은 이 책에 남은 앞선 결정의 대기 주문을 취소합니다
 * ("다음 결정이 대신함"). 패킷에 대기 주문이 없어 Claude는 그 주문을 모른 채 정하므로, 남기면 같은 매수가 두 번 체결됩니다. 실패한
 * 결정은 판단이 없으니 앞선 주문을 건드리지 않습니다(그 주문은 3거래일 뒤 만료).
 *
 * <p><b>노출</b>: {@code targetEquityExposurePct}는 기록·표시용입니다(C11). 주문을 반영한 예상 노출(보유 비중 × (1 − 통과한 매도 비율) +
 * 통과한 매수 증가분, 현금성 포함 — 장부·패킷의 {@code exposurePct}와 같은 정의)과 15%p 넘게 다르면 {@code exposureMismatch = true}로
 * 남기고 숫자를 맞추지 않습니다(설계 §5-3). 노출 0%·100%는 거절 사유가 아닙니다(D7).
 *
 * <p><b>Claude 호출은 장부 잠금 밖에서</b> 합니다(몇 분 걸릴 수 있음 — 그동안 리스크 점검이 멈추지 않게). 응답을 받은 뒤 잠금 안에서
 * 그때의 장부로 검증하고 결정·주문을 한 트랜잭션으로 남깁니다. 그사이 책이 바뀌었으면 잠금 안에서 다시 봅니다: <b>일시정지</b>면 결정은
 * 응답·검증과 함께 {@code SKIPPED}로 남기되 통과 주문은 대기가 아니라 취소({@value #PAUSED_DURING_CALL})로 남기고 앞선 대기 주문도
 * 건드리지 않습니다(일시정지가 대기 주문을 취소하는 것과 같은 이유 — 재개했을 때 묵은 주문이 그날 가격으로 체결되지 않게, 규칙 책과
 * 같음). <b>초기화</b>(리셋 — 시작 전)됐거나 <b>초기화 뒤 다시 시작</b>했으면(출발일은 같아도 초기 결정이 새 행) 결정을 남기지 않고
 * 400입니다 — 리셋 전 장부로 만든 결정이고, 새 책에 남기면 새 책의 그날 결정을 막습니다.
 *
 * <p>초기 결정({@link #start})·미리보기({@link #preview})는 {@code dashboard.paper.start-date} 기준 초기 패킷(그날 이하 값만, C6)으로
 * 부르고, 시작은 통과 주문을 얼려 둔 출발일 종가로 사후 체결합니다(규칙 책과 같은 함수 — {@link PaperLedgerService#backfill}).
 *
 * <p><b>시장 문맥</b>(2단계 명세 §9 A6): 하루 결정은 시장 묶음({@link PaperMarket})을 받아 그 시장의 Claude 책·관측치·달력과 그 시장의
 * 결정 파이프라인(패킷·응답 스키마·시스템 프롬프트의 시장별 부분 — {@link ClaudeDecisionPipeline.MarketContext})으로 냅니다. 다른 시장
 * 책은 건드리지 않습니다. 시장을 받지 않는 옛 시그니처는 미국입니다. 지금 문맥은 미국 하나이고(한국은 E2), 시작·미리보기는 미국
 * 것입니다(13F 출발일 선정·출발일 종가 사후 체결 — 한국은 출발일 사후 체결이 없음, 명세 K28).
 */
@Service
public class ClaudeBookService {

    private static final Logger log = LoggerFactory.getLogger(ClaudeBookService.class);
    /** 시작·미리보기·옛 시그니처의 시장(클래스 설명). */
    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    /** 결정 상태(paper_decisions.status CHECK). */
    public static final String STATUS_OK = "OK";
    public static final String STATUS_NO_TRADE = "NO_TRADE";
    public static final String STATUS_REFUSED = "REFUSED";
    public static final String STATUS_FORMAT_ERROR = "FORMAT_ERROR";
    public static final String STATUS_API_ERROR = "API_ERROR";
    public static final String STATUS_SKIPPED = "SKIPPED";

    /** 고를 수 있는 모델(D5)·effort(C2). 설정 검사({@link PaperSettingKeys})와 같은 목록입니다. */
    public static final List<String> MODELS = List.of("claude-sonnet-5-5", "claude-haiku-5-5");
    public static final List<String> EFFORTS = List.of("low", "medium", "high", "xhigh", "max");
    static final String DEFAULT_MODEL = "claude-sonnet-5-5";
    static final String DEFAULT_EFFORT = "high";
    static final int DEFAULT_DAILY_CALL_CAP = 20;
    /** 일일 호출 상한의 최댓값 — 설정 실수(600)로 하루 비용이 백 배가 되지 않게. */
    static final int MAX_DAILY_CALL_CAP = 50;

    /** 응답 스키마(설계 §5-3) — API용(제약을 걷어 낸 것)과 검사용(전체)이 같은 파일입니다(D26). */
    static final String SCHEMA_RESOURCE = "paper/decision.schema.json";
    /** 목표 노출과 주문 반영 뒤 예상 노출의 차이가 이보다 크면 exposureMismatch(설계 §5-3). */
    static final double MISMATCH_PCT = 15;
    /** 종목 저장본이 이보다 오래되면 그날 재량 주문 전부 STALE_INPUT(설계 §5-4). */
    static final Duration STALE_INPUT_AFTER = Duration.ofHours(24);
    /** 호출 하나의 대기 한도 기본값(초). Sonnet·effort high·출력 16,000토큰이 다 차도 끝나는 여유. */
    static final int DEFAULT_TIMEOUT_SECONDS = 300;
    /** 결정 기록의 오류 문구에 싣는 스키마 위반 수(전부는 응답의 failure.violations에). */
    static final int VIOLATIONS_IN_ERROR = 5;
    static final int ERROR_CHARS = 1_000;
    /** 미리보기 응답의 안내 — 무엇을 남겼고 무엇을 바꾸지 않았나({@link #preview}). */
    static final String PREVIEW_NOTE = "미리보기 — 장부·결정·주문 기록은 바꾸지 않았습니다. 남긴 것: 사용량, 출발일 기관 선정·제안 종목의 "
            + "출발일 종가(없을 때만 — 시작이 같은 값을 씀). 시작하면 Claude를 다시 부릅니다.";
    /** 미리보기·시작이 겹쳤을 때 다시 누를 때까지의 안내 시간. */
    static final Duration BUSY_RETRY = Duration.ofSeconds(30);
    /** Claude를 부르는 사이에 일시정지된 결정의 통과 주문 사유(클래스 설명) — 대기로 두지 않고 이 사유로 취소해 남깁니다. */
    static final String PAUSED_DURING_CALL = "결정 중 일시정지 — 집행 안 함";

    /**
     * Claude 책이 읽는 설정(설계 §4-4). 키가 없거나 목록·범위 밖이면 그 키만 기본값으로 읽고 {@link #fallbacks}에 남깁니다
     * ({@link PaperSettings}와 같은 방식 — 손으로 고친 행이 있어도 결정이 멈추지 않게. 쓰기 API는 {@link PaperSettingsService#update}가
     * 같은 목록으로 막습니다).
     *
     * @param model        모델 ID(claude-sonnet-5-5 · claude-haiku-5-5)
     * @param effort       low · medium · high · xhigh · max
     * @param dailyCallCap 하루(KST) 호출 상한(0~{@value #MAX_DAILY_CALL_CAP}, 0이면 부르지 않음)
     */
    record ClaudeSettings(String model, String effort, int dailyCallCap, List<String> fallbacks) {

        ClaudeSettings {
            fallbacks = List.copyOf(fallbacks);
        }

        static ClaudeSettings from(JsonNode body) {
            List<String> fallbacks = new ArrayList<>();
            String model = Json.asText(body, "model");
            if (model == null || !MODELS.contains(model.strip())) {
                fallbacks.add("model");
                model = DEFAULT_MODEL;
            }
            String effort = Json.asText(body, "effort");
            String normalized = effort == null ? null : effort.strip().toLowerCase(Locale.ROOT);
            if (normalized == null || !EFFORTS.contains(normalized)) {
                fallbacks.add("effort");
                normalized = DEFAULT_EFFORT;
            }
            Double cap = Json.asDouble(body, "apiDailyCallCap");
            int dailyCap = DEFAULT_DAILY_CALL_CAP;
            if (cap != null && Double.isFinite(cap) && cap >= 0 && cap <= MAX_DAILY_CALL_CAP && cap == Math.rint(cap)) {
                dailyCap = cap.intValue();
            } else {
                fallbacks.add("apiDailyCallCap");
            }
            return new ClaudeSettings(model.strip(), normalized, dailyCap, fallbacks);
        }
    }

    /** "시작" 결과 — 초기 결정과 그 사후 체결. */
    public record StartResult(Decision decision, List<Fill> fills) {
        public StartResult {
            fills = List.copyOf(fills);
        }
    }

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperSelectionService selection;
    private final PaperLedgerService ledger;
    private final PaperAdminService admin;
    private final PaperSettingsService settings;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /**
     * 시장 코드 → 그 시장의 결정 한 번의 호출·검증·기록(2단계 명세 §9 A6에서 떼어 냄 — {@link ClaudeDecisionPipeline}). 지금은 미국
     * 하나입니다(클래스 설명).
     */
    private final Map<String, ClaudeDecisionPipeline> pipelines;
    /** 미리보기·시작이 겹치지 않게(두 번 눌러 두 번 과금되지 않게). 정기 결정은 결정 작업의 잠금이 줄을 세웁니다. */
    private final ReentrantLock initialCall = new ReentrantLock();

    @Autowired
    public ClaudeBookService(PaperStore store, StoreReader reader, PaperMarketData marketData,
                             PaperSelectionService selection, PaperLedgerService ledger, PaperAdminService admin,
                             PacketBuilder packets, FrameworkService framework, PaperApiCalls calls, AiService ai,
                             PaperSettingsService settings, PaperConfig config, ObjectMapper mapper,
                             @Value("${dashboard.paper.claude-timeout-seconds:300}") int timeoutSeconds) {
        this(store, reader, marketData, selection, ledger, admin, packets, framework, calls, ai, settings, config,
                mapper, timeoutSeconds, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다(사용량의 KST 날짜·출발일 마감 검사·저장본 신선도). */
    ClaudeBookService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperSelectionService selection,
                      PaperLedgerService ledger, PaperAdminService admin, PacketBuilder packets,
                      FrameworkService framework, PaperApiCalls calls, AiService ai, PaperSettingsService settings,
                      PaperConfig config, ObjectMapper mapper, int timeoutSeconds, Clock clock) {
        this(store, reader, marketData, selection, ledger, admin, packets, framework, calls, ai, settings, config,
                mapper, timeoutSeconds, clock, List.of());
    }

    /**
     * 테스트용 — 시계와 함께 미국 밖 시장의 결정 문맥을 더합니다(시장 격리 시험이 시험용 한국 시장을 넣음). 미국 문맥은 늘 있고
     * (미국 묶음·{@link PacketBuilder#build}·{@value #SCHEMA_RESOURCE}), 같은 시장 코드를 두 번 넣으면 거절합니다.
     */
    ClaudeBookService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperSelectionService selection,
                      PaperLedgerService ledger, PaperAdminService admin, PacketBuilder packets,
                      FrameworkService framework, PaperApiCalls calls, AiService ai, PaperSettingsService settings,
                      PaperConfig config, ObjectMapper mapper, int timeoutSeconds, Clock clock,
                      List<MarketContext> otherMarkets) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.selection = selection;
        this.ledger = ledger;
        this.admin = admin;
        this.settings = settings;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
        List<MarketContext> contexts = new ArrayList<>();
        contexts.add(new MarketContext(US, packets::build, SCHEMA_RESOURCE));
        contexts.addAll(otherMarkets);
        Map<String, ClaudeDecisionPipeline> byMarket = new LinkedHashMap<>();
        for (MarketContext context : contexts) {
            // 스키마 파일이 깨졌으면 기동하지 않습니다(파이프라인이 만들 때 읽음) — 첫 결정 날 아침에야 알게 되지 않게.
            ClaudeDecisionPipeline pipeline = new ClaudeDecisionPipeline(context, store, framework, calls, ai, mapper,
                    clock, Math.max(1, timeoutSeconds));
            if (byMarket.putIfAbsent(context.market().code(), pipeline) != null) {
                throw new IllegalArgumentException("같은 시장의 결정 문맥이 둘입니다: " + context.market().code());
            }
        }
        this.pipelines = Map.copyOf(byMarket);
    }

    /** 같은 거래일·같은 종류에 한 번 더 낼 결정인가 — API 오류이고 아직 재시도하지 않음(명세 C7). */
    static boolean retryable(Decision d) {
        return d != null && STATUS_API_ERROR.equals(d.status()) && d.retryCount() == 0;
    }

    // ------------------------------------------------------------------ 하루 결정
    /** {@link #decide(LocalDate, String, boolean)} — 확정 종가 표시 true. */
    public Decision decide(LocalDate asOf, String kind) {
        return decide(asOf, kind, true);
    }

    /** 미국 Claude 책의 그 거래일 결정 — {@link #decide(PaperMarket, LocalDate, String, boolean)}의 미국 판. */
    public Decision decide(LocalDate asOf, String kind, boolean pricesFinal) {
        return decide(US, asOf, kind, pricesFinal);
    }

    /**
     * 그 시장 Claude 책의 그 거래일 결정(클래스 설명). 이미 있으면 그대로 돌려주고, 그 결정이 아직 재시도하지 않은 API 오류면 한 번 더 냅니다.
     * 일시정지 책은 Claude를 부르지 않고 정기 결정이면 {@code SKIPPED}, 수동 결정이면 행 없이 400(재개한 뒤 같은 거래일에 다시 누를 수
     * 있게)입니다. 일일 호출 상한에 닿았으면 {@code SKIPPED}(재시도 차례였으면 그 재시도를 쓴 것으로 남김 — 같은 날 10분마다 다시
     * 오지 않게)입니다. 호출하는 사이에 일시정지되면 응답을 {@code SKIPPED}로 남기고 주문을 집행하지 않습니다(클래스 설명).
     *
     * @param kind        SCHEDULED(정기) · MANUAL(수동). 초기 결정은 {@link #start}
     * @param pricesFinal 결정에 쓴 관측치가 그 거래일 확정 종가였나({@code prices_final})
     * @throws InvalidRequestException Claude 책이 없음(초기화 전)·시작 전·일시정지 중 수동 결정·호출하는 사이 초기화(뒤 재시작)
     * @throws IllegalArgumentException 결정 문맥이 없는 시장
     */
    Decision decide(PaperMarket market, LocalDate asOf, String kind, boolean pricesFinal) {
        ClaudeDecisionPipeline pipeline = pipeline(market);
        if (asOf == null) {
            throw new IllegalArgumentException("기준 거래일이 없습니다");
        }
        if (!List.of(RuleBookService.SCHEDULED, RuleBookService.MANUAL).contains(kind)) {
            throw new IllegalArgumentException("Claude 계좌 결정 종류는 SCHEDULED · MANUAL입니다(초기 결정은 start): " + kind);
        }
        requireReady();
        Decision retrying = null;
        Optional<Decision> existing = store.decisionFor(market.claudeBook(), asOf, kind);
        if (existing.isPresent()) {
            if (!retryable(existing.get())) {
                return existing.get();
            }
            retrying = existing.get();
        }
        Book book = claudeBook(market);
        if (PaperBooks.NOT_STARTED.equals(book.status())) {
            throw new InvalidRequestException("Claude 계좌는 아직 시작 전입니다 — 개요의 'Claude 계좌 시작'으로 초기 결정을 먼저 "
                    + "내리세요.");
        }
        SettingsRow row = settingsRow();
        ClaudeSettings claude = ClaudeSettings.from(row.body());
        if (PaperBooks.PAUSED.equals(book.status())) {
            if (RuleBookService.MANUAL.equals(kind)) {
                // 수동 결정은 행을 남기지 않습니다 — SKIPPED를 남기면 같은 거래일에 재개한 뒤 다시 눌러도 그 행이 돌아와 Claude를
                // 부르지 않습니다(MANUAL도 거래일마다 한 건).
                throw new InvalidRequestException("Claude 계좌가 일시정지 중이라 수동 결정을 내지 않았습니다(Claude를 부르지 않음) — "
                        + "보유·체결 탭에서 재개한 뒤 누르세요.");
            }
            if (retrying != null) {
                return retrying;   // 일시정지 중에는 재시도하지 않습니다(재개한 뒤의 결정부터 다시 부름)
            }
            return pipeline.recordSkipped(asOf, kind, row, claude, pricesFinal,
                    "일시정지 중 — Claude를 부르지 않고 주문을 내지 않습니다(재개한 뒤의 결정부터 다시 부릅니다)");
        }
        LocalDate today = Kst.today(clock);
        if (pipeline.callsLeft(today, claude) <= 0) {
            return pipeline.capSkipped(asOf, kind, row, claude, pricesFinal, retrying, today);
        }
        Generation before = generation(book);
        Attempt attempt = pipeline.attempt(asOf, kind, false, row, claude, today);
        if (attempt == null) {
            return pipeline.capSkipped(asOf, kind, row, claude, pricesFinal, retrying, today);
        }
        if (!attempt.succeeded()) {
            return pipeline.recordFailure(asOf, kind, row, claude, pricesFinal, attempt, retrying);
        }
        // 여기부터는 과금된 응답이 있습니다 — 검증·저장이 예외로 끝나도 그 응답을 다시 부르지 않는 행으로 남깁니다(클래스 설명).
        try {
            return persist(pipeline, asOf, kind, pricesFinal, row, claude, attempt, retrying, before);
        } catch (InvalidRequestException e) {
            throw e;   // 호출하는 사이 초기화(뒤 재시작) — 이 책의 결정이 아니라 남기지 않습니다(persist)
        } catch (RuntimeException e) {
            pipeline.recordAfterResponse(asOf, kind, row, claude, pricesFinal, attempt, retrying, e);
            throw e;
        }
    }

    /**
     * 받은 응답을 잠금 안에서 그때의 장부로 검증하고 결정·주문을 한 트랜잭션으로 남깁니다. 호출하는 사이의 초기화·재시작은 400,
     * 일시정지는 주문을 집행하지 않는 {@code SKIPPED}(클래스 설명).
     */
    private Decision persist(ClaudeDecisionPipeline pipeline, LocalDate asOf, String kind, boolean pricesFinal,
                             SettingsRow row, ClaudeSettings claude, Attempt attempt, Decision retried,
                             Generation before) {
        PaperMarket market = pipeline.market();
        Optional<Quotes> quotes = reader.quietly(() -> marketData.quotes(market));
        return ledger.exclusively(() -> {
            Book current = claudeBook(market);
            if (PaperBooks.NOT_STARTED.equals(current.status())) {
                // Claude를 부르는 사이에 초기화(리셋)됐습니다 — 현금만 든 시작 전 책에 주문을 남기지 않습니다.
                throw new InvalidRequestException("Claude 계좌가 결정을 준비하는 사이에 초기화돼 시작 전 상태입니다 — 결정을 내지 "
                        + "않았습니다.");
            }
            if (!before.equals(generation(current))) {
                // 초기화한 뒤 다시 시작했습니다(출발일은 설정값이라 같아도 초기 결정이 새 행) — 리셋 전 장부로 만든 결정입니다.
                throw new InvalidRequestException("Claude 계좌가 결정을 준비하는 사이에 초기화된 뒤 다시 시작했습니다 — 초기화 전 "
                        + "장부로 만든 결정이라 내지 않았습니다.");
            }
            Optional<Decision> raced = store.decisionFor(market.claudeBook(), asOf, kind);
            if (raced.isPresent() && (retried == null || !retryable(raced.get()))) {
                return raced.get();
            }
            // 호출하는 사이에 일시정지됐으면(일시정지는 장부 잠금만 잡아 호출 중에도 됨) 주문을 집행하지 않습니다 — 응답은 과금됐으니
            // 검증과 함께 남기고, 통과 주문은 취소로 남겨 무엇을 냈을지 보이게 합니다. 앞선 대기 주문은 일시정지가 이미 취소했습니다.
            boolean paused = PaperBooks.PAUSED.equals(current.status());
            LedgerView view = pipeline.ledgerView(false);
            Plan plan = pipeline.plan(asOf, kind, false, attempt, view, row, claude, quotes, observedUniverse(quotes),
                    Map.of());
            String status = paused ? STATUS_SKIPPED : plan.status();
            if (paused) {
                plan.response().put("skipped", "Claude를 부르는 사이에 계좌가 일시정지돼 통과 주문 " + plan.accepted()
                        + "건을 집행하지 않음(취소로 남김) — 재개한 뒤의 결정부터 다시 냅니다");
                plan.response().put("pausedDuringCall", true);
            }
            return store.atomically(() -> {
                if (!paused) {
                    List<Long> superseded = pipeline.supersedePending();
                    if (!superseded.isEmpty()) {
                        plan.response().set("supersededOrders", mapper.valueToTree(superseded));
                    }
                }
                Decision base = pipeline.decisionRow(retried == null ? 0 : retried.id(), asOf, kind, status, row,
                        claude, attempt, plan.target(), plan.response(), null, pricesFinal);
                long id;
                if (retried != null) {
                    if (!store.updateDecisionRetry(base)) {
                        throw new IllegalStateException("재시도하려던 결정이 그사이 바뀌었습니다: " + retried.id());
                    }
                    id = retried.id();
                } else {
                    Optional<Long> inserted = store.insertDecisionIfAbsent(base);
                    if (inserted.isEmpty()) {
                        throw new IllegalStateException("같은 거래일 결정이 그사이 생겼습니다: " + asOf + " " + kind);
                    }
                    id = inserted.get();
                }
                pipeline.insertOrders(id, asOf, plan, paused ? PaperBooks.ORDER_CANCELLED : PaperBooks.ORDER_PENDING);
                Decision saved = store.decision(id).orElseThrow();
                log.info("Claude 책 결정 {} {}{}: {} — 통과 {} · 거절 {}{}{}", asOf, kind, retried == null ? "" : "(재시도)",
                        status, plan.accepted(), plan.verdicts().size() - plan.accepted(),
                        plan.mismatch() ? " · 목표 노출과 주문이 어긋남" : "",
                        paused ? " · 호출 중 일시정지 — 통과 주문을 집행하지 않음" : "");
                return saved;
            });
        });
    }

    // ------------------------------------------------------------------ 초기 결정·미리보기
    /**
     * Claude 책 "시작"(명세 L2·C6) — 출발일 기준 초기 패킷으로 Claude를 부르고, 검증기가 통과시킨 주문을 얼려 둔 출발일 종가로
     * <b>사후 체결</b>한 뒤 책을 운용으로 바꿉니다(결정 종류 INITIAL). 통과한 주문이 없으면(노출 0% 포함) 현금만 든 채 시작합니다.
     *
     * <p><b>호출이 실패하면 시작하지 않습니다</b>(API 오류·거절·형식 오류 — 책은 시작 전 그대로, 400). 시작은 한 번뿐이라 실패로
     * 현금만 든 책을 굳히면 초기 결정을 다시 낼 길이 없습니다. 다시 누르면 Claude를 한 번 더 부릅니다(일일 호출 상한에 셈).
     *
     * @throws InvalidRequestException 초기화 전·이미 시작함·출발일 마감 15분 전·일일 호출 상한·출발일 선정을 만들 수 없음·호출 실패
     * @throws TooManyRequestsException 다른 미리보기·시작이 진행 중
     */
    public StartResult start() {
        if (!initialCall.tryLock()) {
            throw new TooManyRequestsException("다른 Claude 호출(미리보기·시작)이 진행 중입니다 — 끝난 뒤 다시 누르세요.",
                    BUSY_RETRY);
        }
        try {
            Prepared prepared = prepareInitial();
            ClaudeDecisionPipeline pipeline = pipeline(US);
            Attempt attempt = pipeline.attempt(prepared.start(), RuleBookService.INITIAL, true, prepared.row(),
                    prepared.claude(), prepared.today());
            if (attempt == null) {
                throw new InvalidRequestException(capMessage(prepared.claude(), prepared.today()));
            }
            if (!attempt.succeeded()) {
                log.warn("Claude 책 시작: 호출 실패({}) — 시작하지 않았습니다: {}", attempt.status(), attempt.error());
                throw new InvalidRequestException("Claude 호출이 실패해 시작하지 않았습니다(" + statusLabel(attempt.status())
                        + "): " + clip(attempt.error(), 400) + " — 계좌는 시작 전 그대로입니다. 다시 누르면 Claude를 한 번 더 "
                        + "부릅니다(하루 호출 상한에 셈).");
            }
            // 유니버스를 출발일 종가를 얼리기 전에 정합니다(initialUniverse) — 얼린 뒤에 세면 패킷 밖 종목이 들어옵니다.
            Set<String> universe = initialUniverse(attempt);
            Map<String, PaperMarketData.SourcedClose> closes = startCloses(attempt, universe);
            return ledger.exclusively(() -> {
                Book book = claudeBook(US);
                requireNotStarted(book);
                Optional<Decision> existing = store.decisionFor(US.claudeBook(), prepared.start(),
                        RuleBookService.INITIAL);
                if (existing.isPresent()) {
                    // 시작 전 책에 초기 결정이 남아 있을 수는 없지만(리셋이 지움), 있으면 새로 사지 않고 그 기록을 돌려줍니다.
                    return new StartResult(existing.get(), List.of());
                }
                BookState state = store.state(US.claudeBook()).orElseThrow(() -> new IllegalStateException(
                        "Claude 계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요"));
                LedgerView view = cashOnly(state.cash());
                Plan plan = pipeline.plan(prepared.start(), RuleBookService.INITIAL, true, attempt, view,
                        prepared.row(), prepared.claude(), Optional.empty(), universe, closes);
                return store.atomically(() -> {
                    // 시작 전 책에 남은 대기 주문(리셋과 겹친 결정의 찌꺼기)이 초기 배분 위에 더 체결되지 않게 먼저 취소합니다.
                    int stale = store.cancelPendingOrders(US.claudeBook());
                    if (stale > 0) {
                        log.warn("Claude 책 시작: 시작 전 책에 남아 있던 대기 주문 {}건을 취소했습니다", stale);
                    }
                    Optional<Long> id = store.insertDecisionIfAbsent(pipeline.decisionRow(0, prepared.start(),
                            RuleBookService.INITIAL, plan.status(), prepared.row(), prepared.claude(), attempt,
                            plan.target(), plan.response(), null, true));
                    if (id.isEmpty()) {
                        return new StartResult(store.decisionFor(US.claudeBook(), prepared.start(),
                                RuleBookService.INITIAL).orElseThrow(), List.of());
                    }
                    pipeline.insertOrders(id.get(), prepared.start(), plan, null);
                    List<PaperLedgerService.BackfillLeg> legs = new ArrayList<>();
                    for (Planned p : plan.planned()) {
                        if (p.verdict().accepted()) {
                            legs.add(new PaperLedgerService.BackfillLeg(p.verdict().order().ticker(),
                                    p.verdict().order().side(), p.orderWeightPct(), p.sellFraction(), p.reason()));
                        }
                    }
                    PaperLedgerService.BackfillResult result = ledger.backfill(new PaperLedgerService.BackfillRequest(
                            book, prepared.start(), PacketBuilder.SOURCE_CLAUDE, id.get(), state.cash(), view.nav(),
                            legs, closes, settings.current().settings()));
                    ObjectNode updated = plan.response().deepCopy();
                    updated.set("fills", mapper.valueToTree(fillsView(result.fills())));
                    List<Map<String, Object>> skipped = new ArrayList<>();
                    result.skipped().forEach(e -> skipped.add(RuleBookService.skip(e.getKey(), e.getValue())));
                    updated.set("backfillSkipped", mapper.valueToTree(skipped));
                    store.updateDecision(id.get(), result.fills().isEmpty() ? STATUS_NO_TRADE : STATUS_OK, updated, null);
                    log.info("Claude 책 시작: 출발일 {}, 통과 {} · 거절 {}, 체결 {}건", prepared.start(), plan.accepted(),
                            plan.verdicts().size() - plan.accepted(), result.fills().size());
                    return new StartResult(store.decision(id.get()).orElseThrow(), result.fills());
                });
            });
        } finally {
            initialCall.unlock();
        }
    }

    /**
     * 초기 결정 미리보기 — 시작과 같은 초기 패킷으로 Claude를 부르고 검증까지 하지만 <b>장부·결정·주문 표에 쓰지 않습니다</b>.
     * 남기는 것은 셋입니다: 사용량(호출 수·토큰), 출발일 기관 선정(없을 때만 — 시작과 같은 조건(수집 완료)으로. 선정은 기준일마다
     * 한 번이라 시작이 만들 것과 같은 행이고, 선정 없이 부르면 트랙레코드·13F 섹션이 빈 패킷에 비용을 쓰게 됩니다), 제안 종목의 출발일
     * 종가(없을 때만 얼림 — {@link PaperAdminService#startClose}. 얼린 값은 거래일마다 처음 값이 남아 시작의 사후 체결도 같은 값을
     * 씁니다).
     *
     * @return {@code {ok, preview:true, book, asOfTradingDate, model, effort, status, error, packet, packetHash,
     *         responseRaw, response, validation, exposureMismatch, usage, note}} — 실패면 {@code response}·
     *         {@code validation}이 null
     * @throws InvalidRequestException 시작과 같은 조건(호출 실패는 예외가 아니라 status·error로)
     * @throws TooManyRequestsException 다른 미리보기·시작이 진행 중
     */
    public Map<String, Object> preview() {
        if (!initialCall.tryLock()) {
            throw new TooManyRequestsException("다른 Claude 호출(미리보기·시작)이 진행 중입니다 — 끝난 뒤 다시 누르세요.",
                    BUSY_RETRY);
        }
        try {
            Prepared prepared = prepareInitial();
            ClaudeDecisionPipeline pipeline = pipeline(US);
            Attempt attempt = pipeline.attempt(prepared.start(), RuleBookService.INITIAL, true, prepared.row(),
                    prepared.claude(), prepared.today());
            if (attempt == null) {
                throw new InvalidRequestException(capMessage(prepared.claude(), prepared.today()));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("preview", true);
            out.put("book", US.claudeBook());
            out.put("asOfTradingDate", prepared.start().toString());
            out.put("model", attempt.model());
            out.put("effort", attempt.effort());
            out.put("packet", attempt.packet().body());
            out.put("packetHash", attempt.packet().sha256());
            out.put("responseRaw", attempt.result().text());
            out.put("usage", usageView(attempt));
            if (!attempt.succeeded()) {
                out.put("status", attempt.status());
                out.put("error", attempt.error());
                out.put("response", null);
                out.put("validation", null);
                out.put("exposureMismatch", null);
            } else {
                BookState state = store.state(US.claudeBook()).orElse(null);
                LedgerView view = cashOnly(state == null ? prepared.book().initialCash() : state.cash());
                Set<String> universe = initialUniverse(attempt);   // 얼리기 전에(시작과 같음)
                Plan plan = pipeline.plan(prepared.start(), RuleBookService.INITIAL, true, attempt, view,
                        prepared.row(), prepared.claude(), Optional.empty(), universe, startCloses(attempt, universe));
                out.put("status", plan.status());
                out.put("error", null);
                out.put("response", plan.response());
                out.put("validation", plan.response().get("validation"));
                out.put("exposureMismatch", plan.mismatch());
            }
            out.put("note", PREVIEW_NOTE);
            return out;
        } finally {
            initialCall.unlock();
        }
    }

    /** 시작·미리보기에 필요한 것(검사·설정·선정). */
    private record Prepared(LocalDate start, Book book, SettingsRow row, ClaudeSettings claude, LocalDate today) {
    }

    private Prepared prepareInitial() {
        requireReady();
        Instant now = clock.instant();
        Book book = claudeBook(US);
        requireNotStarted(book);
        LocalDate start = config.startDate();
        if (now.isBefore(US.calendar().closeInstant(start).plus(US.finalDelay()))) {
            throw new InvalidRequestException(start + " 장 마감 15분 뒤부터 시작할 수 있습니다(그날 종가로 사후 체결).");
        }
        SettingsRow row = settingsRow();
        ClaudeSettings claude = ClaudeSettings.from(row.body());
        LocalDate today = Kst.today(clock);
        if (pipeline(US).callsLeft(today, claude) <= 0) {
            throw new InvalidRequestException(capMessage(claude, today));
        }
        ensureStartSelection(start, row);
        return new Prepared(start, book, row, claude, today);
    }

    /**
     * 출발일 선정 — 이미 있으면 그대로, 없으면 규칙 책 시작과 같은 조건(13F 30분기 수집 완료)으로 만들어 남깁니다. 선정은 두 책이
     * 함께 쓰는 한 행이라, 덜 모인 자료로 먼저 굳히면 규칙 책도 그 선정으로 시작하게 됩니다(같은 이유로 규칙 책 시작도 수집이 끝나야
     * 함 — {@code RuleBookService.requireCollectionComplete}와 같은 검사).
     */
    private void ensureStartSelection(LocalDate start, SettingsRow row) {
        if (selection.selectionOn(start).filter(s -> s.asOfDate().equals(start)).isPresent()) {
            return;
        }
        Optional<PaperSelectionService.CollectionIndex> index = selection.index();
        if (index.isEmpty()) {
            throw new InvalidRequestException("후보 목록(sec.13f.track_record_index)이 아직 없습니다 — 수집기의 13F 트랙레코드 "
                    + "태스크(sec_13f_track_record)가 돈 뒤에 시작하세요.");
        }
        PaperSelectionService.TrackRecordSettings track = PaperSelectionService.TrackRecordSettings.from(row.body());
        List<PaperSelectionService.Filer> candidates = index.get().filers().stream()
                .filter(f -> track.candidateCiks() == null || track.candidateCiks().contains(f.cik())).toList();
        List<PaperSelectionService.Filer> collecting = candidates.stream().filter(f -> !f.complete()).toList();
        if (!collecting.isEmpty()) {
            throw new InvalidRequestException("수집 중 " + collecting.size() + "곳(후보 " + candidates.size()
                    + "곳) — 13F 30분기 수집이 끝난 뒤 시작하세요. 출발일 선정이 덜 모인 자료로 굳지 않게 합니다.");
        }
        PaperSelectionService.SelectionOutcome outcome = selection.select(start);
        if (outcome.selection() == null) {
            throw new InvalidRequestException("출발일(" + start + ") 기관 선정을 만들지 못했습니다: " + outcome.skippedReason());
        }
    }

    /**
     * 초기 결정의 사후 체결 종가 — 제안된 종목 중 <b>유니버스 안</b>의 종목마다 얼려 둔 출발일 종가({@link PaperAdminService#startClose},
     * 없으면 지금 찾아 얼림). 찾지 못한 종목은 맵에 없고 검증기가 {@code NO_PRICE}로 거절합니다. 유니버스 밖 종목은 얼리지 않습니다 —
     * 얼리면 그 종목이 다음 초기 패킷(미리보기 뒤의 시작)의 유니버스에 들어가고, 검증기는 {@code OUT_OF_UNIVERSE}로 거절합니다.
     */
    private Map<String, PaperMarketData.SourcedClose> startCloses(Attempt attempt, Set<String> universe) {
        Map<String, PaperMarketData.SourcedClose> out = new TreeMap<>();
        for (JsonNode order : Json.array(attempt.parsed(), "orders")) {
            String ticker = Json.asText(order, "ticker");
            if (ticker == null || out.containsKey(ticker) || !universe.contains(ticker)) {
                continue;
            }
            admin.startClose(ticker).ifPresent(close -> out.put(ticker, close));
        }
        return out;
    }


    /**
     * 초기 결정의 검증 유니버스 — 패킷이 Claude에 보인 유니버스({@code 12_hardRules.universe}, 쉼표로 이은 문자열 또는 배열) 그대로.
     * 패킷에 없으면 같은 규칙(관측치 종목 ∪ 이미 얼린 출발일 종가 종목)으로 지금 셉니다. <b>제안 종목의 출발일 종가를 얼리기
     * ({@link #startCloses}) 전에</b> 정해야 합니다 — 얼린 뒤에 세면 방금 얼린 패킷 밖 종목(수집 목록에서 빠졌지만 종가 이력이 남은
     * 종목 등)이 유니버스에 들어가 {@code OUT_OF_UNIVERSE}를 피하고, 관측치가 없어 스탑·매도 체결이 안 되는 보유로 남습니다.
     */
    private Set<String> initialUniverse(Attempt attempt) {
        JsonNode shown = Json.child(Json.child(attempt.packet().body(), PacketBuilder.HARD_RULES), "universe");
        Set<String> out = new TreeSet<>();
        if (shown != null && (shown.isArray() || shown.isString())) {
            List<String> tickers = new ArrayList<>();
            if (shown.isArray()) {
                shown.forEach(t -> tickers.add(t.asString("")));
            } else {
                tickers.addAll(List.of(shown.asString().split(",")));
            }
            for (String t : tickers) {
                if (!t.isBlank()) {
                    out.add(t.strip());
                }
            }
            return out;
        }
        reader.quietly(() -> marketData.quotes(US)).ifPresent(q -> out.addAll(q.bars().keySet()));
        for (StartPrice p : store.startPrices()) {
            if (config.startDate().equals(p.tradingDate())) {
                out.add(p.ticker());
            }
        }
        return out;
    }

    /**
     * 정기 결정에서 가격 없음({@code NO_PRICE})으로 거절할 종목 — 이어 쓴(isStale, 직전 저장본에서 이은) 봉의 종목과 봉이 없는 보유
     * 종목. 패킷({@link PacketBuilder})이 같은 목록을 보일 수 있게 패키지 안에 엽니다(검증기와 다른 계산을 두지 않게).
     *
     * @param quotes      관측치 저장본(없으면 보유 전부가 가격 없음)
     * @param heldTickers 보유 종목. null이면 없음
     */
    static Set<String> noPriceTickers(Optional<Quotes> quotes, Collection<String> heldTickers) {
        Map<String, PaperMarketData.Bar> bars = quotes == null ? Map.of() : quotes.map(Quotes::bars).orElse(Map.of());
        Set<String> out = new TreeSet<>();
        bars.values().stream().filter(PaperMarketData.Bar::stale).forEach(bar -> out.add(bar.ticker()));
        if (heldTickers != null) {
            for (String ticker : heldTickers) {
                if (ticker != null && !bars.containsKey(ticker)) {
                    out.add(ticker);
                }
            }
        }
        return out;
    }

    /**
     * 그날 재량 주문 전부 {@code STALE_INPUT}인가 — 관측치 저장본이 없거나 {@link #STALE_INPUT_AFTER}(24시간)보다 오래됨(설계 §5-4).
     * 패킷도 같은 판정을 보일 수 있게 패키지 안에 엽니다.
     */
    static boolean inputsStale(Optional<Quotes> quotes, Instant now) {
        return quotes == null || quotes.isEmpty() || quotes.get().collectedAt() == null
                || quotes.get().collectedAt().plus(STALE_INPUT_AFTER).isBefore(now);
    }


    static String capMessage(ClaudeSettings claude, LocalDate today) {
        return "일일 호출 상한(" + claude.dailyCallCap() + "회, KST " + today + ")에 닿아 Claude를 부르지 않았습니다"
                + " — 설정 apiDailyCallCap";
    }


    // ------------------------------------------------------------------ 조각
    /**
     * 책의 판 — 리셋하면 결정이 지워지고, 다시 시작하면 출발일(설정의 출발일이라 같음)은 그대로여도 초기 결정이 새 번호로 생깁니다.
     * Claude를 부르기 전과 뒤의 판이 다르면 그사이 초기화·재시작이 있었습니다({@link #persist}).
     */
    private record Generation(LocalDate startedOn, Long initialDecisionId) {
    }

    private Generation generation(Book book) {
        Long initial = book.startedOn() == null ? null : store.decisionFor(book.code(), book.startedOn(),
                RuleBookService.INITIAL).map(Decision::id).orElse(null);
        return new Generation(book.startedOn(), initial);
    }

    /** 그 시장의 Claude 책. 없으면(초기화 전) 400. */
    private Book claudeBook(PaperMarket market) {
        return store.book(market.claudeBook()).orElseThrow(() -> new InvalidRequestException(
                "Claude 계좌가 없습니다 — 먼저 초기화(POST /api/paper/init)를 누르세요."));
    }

    /** 그 시장의 결정 파이프라인(클래스 설명의 시장 문맥). */
    private ClaudeDecisionPipeline pipeline(PaperMarket market) {
        ClaudeDecisionPipeline pipeline = pipelines.get(market.code());
        if (pipeline == null || pipeline.market() != market) {
            throw new IllegalArgumentException("Claude 결정 문맥이 없는 시장입니다: " + market.code());
        }
        return pipeline;
    }

    private static void requireNotStarted(Book book) {
        if (!PaperBooks.NOT_STARTED.equals(book.status())) {
            throw new InvalidRequestException("Claude 계좌는 이미 시작했습니다(상태 " + book.status() + ", 출발 "
                    + book.startedOn() + ") — 다시 시작하려면 그 계좌를 초기화(리셋)한 뒤 누르세요.");
        }
    }

    /** 설정 행(없으면 기본값으로 만듦 — 결정 기록에 설정 버전이 필요). */
    private SettingsRow settingsRow() {
        Optional<SettingsRow> row = store.settings();
        if (row.isPresent()) {
            return row.get();
        }
        settings.ensureInitialized();
        return store.settings().orElseThrow(() -> new IllegalStateException("모의 매매 설정 행을 만들지 못했습니다"));
    }

    private void requireReady() {
        if (!store.ready()) {
            throw new IllegalStateException(PaperQueryService.NOT_READY_MESSAGE);
        }
    }

    static String clip(String text, int max) {
        if (text == null || text.length() <= max) {
            return text;
        }
        return text.substring(0, max) + "…";
    }
}
