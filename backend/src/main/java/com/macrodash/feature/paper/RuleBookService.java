package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.HoldingsDiff;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.Signal13F;
import com.macrodash.analytics.Signal13F.Allocation;
import com.macrodash.analytics.Signal13F.Candidate;
import com.macrodash.analytics.Signal13F.Contribution;
import com.macrodash.analytics.Signal13F.Event;
import com.macrodash.analytics.Signal13F.FilerQuarter;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.PaperSelectionService.PoolMember;
import com.macrodash.feature.paper.PaperSelectionService.SignalPool;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.store.PaperStore.TrackRecordRow;
import com.macrodash.store.StoreRepository.HoldingRow;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.DoublePredicate;

/**
 * 🧪 규칙 책(대조군) — 신호 풀(그룹 A 7년 트랙레코드 상위 5 ∪ 그룹 B 기존 13F 메뉴 2년 상위 4, D27)의 13F 신호만 따르는
 * 기계적인 책(명세 R1~R6, 설계 §4-1~§4-3). 매크로 게이트는 입력이 아닙니다(D19): 게이트 지표는 결정 기록에 참고로 실을 뿐
 * 주문을 바꾸지 않습니다.
 *
 * <p><b>하루 한 번의 결정</b>({@link #decide}): 그날 유효한 선정(재선정일에만 바뀜)의 신호 풀 기관마다 13F 최신 분기와 바로 앞
 * 분기를 대조해({@link Signal13F#collect}) ① 보유 종목을 풀 기관 minHolders곳(기본 2) 이상이 전량 매도했으면 전량 매도, ② 재선정일
 * (공시 기한 다음 거래일, R5)과 "시작"({@link #start})에만 매수 후보를 점수 순 상위 N(기본 10)개 삽니다 — 점수 = Σ 매수 기관의
 * 기관 가중 × 확신도, 목표 비중은 설정 {@code blend.allocation}(기본 확신도 비례: 종목 상한 × 점수 / 최고 점수, 1% 미만은 뺌 —
 * 대안 동일 비중)이고, 이미 들고 있는 후보는 목표 비중까지 모자란 만큼만, ③ 남는 현금은 SHY에(설정 {@code parkCashInShy}), 현금이
 * 모자라면 SHY를 일부 팔아 메웁니다. 그 외 날(SCHEDULED·MANUAL)은 매도 신호와 남는 현금 관리만 합니다 — 어림한 남는 현금이 순자산의
 * {@code rules.parkCashThresholdPct}(기본 2%)를 넘으면 SHY 매수 한 건({@link #parkIdleCash}, 신호 매수가 아님). 스탑은 장부가 관측치마다
 * 봅니다. 매수(종목·SHY)는 금액이 {@code minOrderNotional}(기본 500달러) 미만이면 내지 않습니다.
 *
 * <p><b>신호 풀과 기관 가중은 선정 행에서 읽습니다</b>({@link PaperSelectionService#signalPool}) — 다시 계산하지 않으므로 선정
 * 뒤에 설정(g·topN)이 바뀌어도 그 선정의 가중은 그대로입니다. 풀 기관의 13F는 선정과 같은 출처(q30이 있으면 그것, 없으면
 * 기존 메뉴의 q8)입니다.
 *
 * <p><b>Point-in-Time</b>: 신호는 선정 기준일({@code as_of})까지 낸 공시({@code filingDate ≤ as_of})로만 만듭니다. 선정 사이에 늦게
 * 들어온 공시는 다음 재선정까지 쓰지 않습니다 — 같은 선정이면 날마다 같은 신호이고, 결정을 다시 만들어도 같은 답입니다. 그래서
 * 매도 신호는 선정 직후 한 번 나면 보유가 없어질 때까지 같은 근거로 남습니다(대기 중인 매도가 있으면 다시 내지 않음).
 * 대조하는 분기도 모든 기관이 같습니다 — 선정 기준일에 재선정이 이미 지난 최신 분기 q
 * ({@link UsMarketCalendar#latestQuarterEndReselectedBy})와 그 앞 분기. 다음 분기를 일찍 낸 기관도 q로 대조합니다(기관마다
 * 다른 분기를 대조하면 서로 다른 분기의 매수가 '동시 매수'로 묶이고, 일찍 낸 기관의 q 분기 매수가 사라짐).
 *
 * <p><b>멱등</b>: 결정은 (책, 기준 거래일, 종류)마다 한 건입니다({@code paper_decisions} 유일 제약). 이미 있으면 새로 만들지 않고
 * 그 결정을 돌려줍니다 — 결정 작업이 10분마다 돌아도, 버튼을 두 번 눌러도 주문은 한 번입니다. 결정과 주문은 한 트랜잭션입니다.
 *
 * <p><b>주문 모양</b>(장부가 체결): 출처 {@code RULE}, 시점 {@code NEXT_OBSERVATION}, 기준 거래일 = 결정의 기준 거래일(그 봉으로는
 * 체결되지 않음 — 다음 세션 봉부터), 만료 = 기준 거래일 + 3거래일. 매수의 {@code targetWeightPct}는 장부가 읽는 대로 "체결 시점
 * 순자산 대비 살 금액(%)"이라, 이미 들고 있는 후보는 모자란 비중(목표 − 현재)이고 목표 비중 자체는 근거에 남깁니다. 비중은
 * 마지막 관측 가격의 평가(가격을 못 받은 보유는 평단)로 계산합니다.
 *
 * <p>근거(주문 {@code reason}·결정 {@code response})에는 종목마다 점수와 "어느 기관(그룹·순위·가중)이 신규/+30%였고 확신도가
 * 얼마였나"·"어느 기관이 전량 매도했나"를 이름과 함께 남깁니다(수용 기준).
 */
@Service
public class RuleBookService {

    private static final Logger log = LoggerFactory.getLogger(RuleBookService.class);

    public static final String SCHEDULED = "SCHEDULED";
    public static final String MANUAL = "MANUAL";
    public static final String REBALANCE = "REBALANCE";
    public static final String INITIAL = "INITIAL";
    /**
     * 장중 확인 응답 결정(V18 — 미국 Claude 계좌2 단계 2, {@link CheckpointPacket}). 기준 거래일은 아침 결정과 같은 d라 UNIQUE(book, d, kind)가
     * '세션당 한 번'을 강제합니다. 아침 패킷 빌더의 종류({@link PacketBuilder#KINDS})에는 넣지 않습니다. 재시도하지 않습니다.
     */
    public static final String CHECKPOINT = "CHECKPOINT";

    /** 결정 상태(paper_decisions.status). */
    static final String STATUS_OK = "OK";
    static final String STATUS_NO_TRADE = "NO_TRADE";
    static final String STATUS_SKIPPED = "SKIPPED";

    /** 주문 출처·시점(paper_orders.source·timing). */
    static final String SOURCE_RULE = "RULE";
    static final String NEXT_OBSERVATION = "NEXT_OBSERVATION";

    /** 확대로 보는 주식 수 증가율(R2 "+30%"). 설정 키가 없어 고정입니다(명세의 규칙 그대로). */
    static final double ADD_THRESHOLD_PCT = 30;
    /**
     * 남는 현금을 SHY에 둘 때 남겨 두는 현금(순자산의 %p). 결정 때 어림한 금액과 체결 때 가격·슬리피지가 조금 달라도 SHY
     * 매수가 마지막 종목 매수의 현금을 다투지 않게.
     */
    static final double CASH_BUFFER_PCT = 0.5;
    /** 대기 주문의 수명(설계 §3-1 만료): 기준 거래일 + 3거래일까지. */
    static final int ORDER_EXPIRY_TRADING_DAYS = 3;
    /** 남는 현금 자리(설정 parkCashInShy). */
    static final String PARKING_TICKER = "SHY";
    /** 결정 기록에 싣는 순위표 줄 수. */
    static final int RANKING_SHOWN = 10;

    /**
     * 규칙 책이 읽는 설정(설계 §4-4). 키가 없거나 범위 밖이면 그 키만 기본값으로 읽고 {@link #fallbacks}에 남깁니다
     * ({@link PaperSettings}와 같은 방식 — 설정 쓰기 API(단계 3a)가 검사하기 전의 행이 있어도 결정이 멈추지 않게).
     *
     * @param minHolders      매수 후보·매도 신호가 되는 최소 기관 수(기본 2)
     * @param maxNames        매수 종목 수 상한(rulesMaxNames, 기본 10)
     * @param maxWeightPct    종목당 비중 상한(maxWeightStockPct, 기본 10)
     * @param maxWeightEtfPct ETF 비중 상한(maxWeightEtfPct, 기본 20)
     * @param etfs            ETF로 보는 티커 — 유니버스에 늘 넣는 ETF(universeExtraTickers, D8)와 벤치마크 SPY·QQQ. 13F에 나오는
     *                        다른 ETF는 종류를 알 길이 없어 개별 종목 상한을 받습니다(더 작은 상한이라 덜 사는 쪽)
     * @param parkCashInShy   남는 현금을 SHY에 둠(기본 true)
     * @param minOrderNotional 매수 주문의 최소 금액(달러, 기본 500, 0 이상 — 0이면 끔). 목표까지 모자란 몇백 달러를 채우는 주문·SHY
     *                        매수는 슬리피지만 내고 비중은 거의 바꾸지 않아 내지 않습니다(건너뜀 "최소 금액 미만"). 매도에는 걸지
     *                        않습니다(매도 신호·모자란 현금은 금액과 상관없이 따라야 함)
     */
    record RuleSettings(int minHolders, int maxNames, double maxWeightPct, double maxWeightEtfPct, Set<String> etfs,
                        boolean parkCashInShy, double minOrderNotional, List<String> fallbacks) {

        static final int DEFAULT_MIN_HOLDERS = 2;
        static final int DEFAULT_MAX_NAMES = 10;
        static final double DEFAULT_MAX_WEIGHT_PCT = 10;
        static final double DEFAULT_MAX_WEIGHT_ETF_PCT = 20;
        static final double DEFAULT_MIN_ORDER_NOTIONAL = 500;
        /** 벤치마크 ETF — 수집 유니버스에만 있고 universeExtraTickers에는 없음(PaperSettingsService). */
        static final List<String> BENCHMARK_ETFS = List.of("SPY", "QQQ");

        RuleSettings {
            etfs = Set.copyOf(etfs);
            fallbacks = List.copyOf(fallbacks);
        }

        static RuleSettings from(JsonNode body) {
            List<String> fallbacks = new ArrayList<>();
            int minHolders = (int) number(body, "minHolders", DEFAULT_MIN_HOLDERS,
                    v -> v >= 1 && v <= 50 && v == Math.rint(v), fallbacks);
            int maxNames = (int) number(body, "rulesMaxNames", DEFAULT_MAX_NAMES,
                    v -> v >= 1 && v <= 100 && v == Math.rint(v), fallbacks);
            double maxWeight = number(body, "maxWeightStockPct", DEFAULT_MAX_WEIGHT_PCT, v -> v > 0 && v <= 100,
                    fallbacks);
            double maxWeightEtf = number(body, "maxWeightEtfPct", DEFAULT_MAX_WEIGHT_ETF_PCT, v -> v > 0 && v <= 100,
                    fallbacks);
            Set<String> etfs = new TreeSet<>(BENCHMARK_ETFS);
            JsonNode extra = Json.child(body, "universeExtraTickers");
            if (extra != null && extra.isArray()) {
                for (JsonNode item : extra) {
                    if (item.isString() && !item.asString("").isBlank()) {
                        etfs.add(item.asString("").trim().toUpperCase(Locale.ROOT));
                    }
                }
            } else {
                etfs.addAll(PaperSettingsService.UNIVERSE_EXTRA_TICKERS);
                fallbacks.add("universeExtraTickers");
            }
            JsonNode park = Json.child(body, "parkCashInShy");
            boolean parkCash = true;
            if (park != null && park.isBoolean()) {
                parkCash = park.asBoolean();
            } else {
                fallbacks.add("parkCashInShy");
            }
            double minNotional = number(body, "minOrderNotional", DEFAULT_MIN_ORDER_NOTIONAL, v -> v >= 0, fallbacks);
            return new RuleSettings(minHolders, maxNames, maxWeight, maxWeightEtf, etfs, parkCash, minNotional,
                    fallbacks);
        }

        private static double number(JsonNode body, String key, double fallback, DoublePredicate valid,
                                     List<String> fallbacks) {
            Double value = Json.asDouble(body, key);
            if (value == null || !Double.isFinite(value) || !valid.test(value)) {
                fallbacks.add(key);
                return fallback;
            }
            return value;
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
    private final PaperSettingsService settings;
    private final PaperLedgerService ledger;
    private final PaperAdminService admin;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    public RuleBookService(PaperStore store, StoreReader reader, PaperMarketData marketData,
                           PaperSelectionService selection, PaperSettingsService settings, PaperLedgerService ledger,
                           PaperAdminService admin, PaperConfig config, ObjectMapper mapper) {
        this(store, reader, marketData, selection, settings, ledger, admin, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다("시작"은 출발일 마감 15분 뒤부터). */
    RuleBookService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperSelectionService selection,
                    PaperSettingsService settings, PaperLedgerService ledger, PaperAdminService admin,
                    PaperConfig config, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.selection = selection;
        this.settings = settings;
        this.ledger = ledger;
        this.admin = admin;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 그 거래일 시점에 재선정이 지난 최신 분기의 재선정일 r(13F 공시 기한 다음 거래일, R5 — 미국 달력). 거래일이 r이면 재선정일이고,
     * r 뒤면 r 선정으로 사는 그 분기의 재선정이 이미 열린 것입니다. 결정 작업이 재선정·따라잡기를 판정하고, 결정이 REBALANCE의
     * 선정을 확인할 때 이 날을 씁니다 — 미국 규칙 책 전용 단계라 이 미국 전용 서비스에 둡니다(A8 허용 목록).
     */
    static LocalDate reselectionDayAsOf(LocalDate tradingDate) {
        return UsMarketCalendar.reselectionDay(UsMarketCalendar.latestQuarterEndReselectedBy(tradingDate));
    }

    // ------------------------------------------------------------------ 하루 결정
    /** {@link #decide(LocalDate, String, boolean)} — 확정 종가 표시 없이(true). */
    public Decision decide(LocalDate asOf, String kind) {
        return decide(asOf, kind, true);
    }

    /**
     * 그 거래일의 결정(클래스 설명). 이미 있으면 그대로 돌려줍니다. 일시정지 책은 주문 없이 {@code SKIPPED}를 남깁니다(재개했을 때
     * 며칠 묵은 주문이 체결되지 않게 — 일시정지가 대기 주문을 취소하는 것과 같은 이유).
     *
     * @param kind        SCHEDULED(정기) · REBALANCE(재선정일 정기) · MANUAL(수동 — 매도 신호와 남는 현금 SHY만). 초기 결정은 {@link #start}
     * @param pricesFinal 결정에 쓴 관측치가 확정 종가였나({@code prices_final}) — 마감 기한을 넘겨 진행했으면 false
     * @throws InvalidRequestException 규칙 책이 없음(초기화 전)·시작 전
     */
    public Decision decide(LocalDate asOf, String kind, boolean pricesFinal) {
        return decide(null, asOf, kind, pricesFinal);
    }

    /**
     * {@link #decide(LocalDate, String, boolean)}를 그 실행이 읽은 설정 행으로 — 결정 작업이 연 실행({@link MarketRun})을 받으면 결정 행의
     * {@code settings_version}·{@link RuleSettings}·장부 설정(섞기 등)이 모두 그 실행의 판 하나입니다(같은 실행의 장부·결정 시각과 같은 판 —
     * 실행 도중 설정을 저장해도 결정 행에 다음 판이 끼지 않게, 묶음 C 리뷰). 실행이 아니거나(null·시장 묶음) 그 실행에 행이 없으면 지금 행을 한 번
     * 읽어 두 값을 모두 그 행에서 읽습니다.
     */
    Decision decide(PaperMarket run, LocalDate asOf, String kind, boolean pricesFinal) {
        if (asOf == null) {
            throw new IllegalArgumentException("기준 거래일이 없습니다");
        }
        if (!List.of(SCHEDULED, MANUAL, REBALANCE).contains(kind)) {
            throw new IllegalArgumentException("규칙 계좌 결정 종류는 SCHEDULED · MANUAL · REBALANCE입니다(초기 결정은 start): "
                    + kind);
        }
        requireReady();
        Optional<Decision> existing = store.decisionFor(PaperBooks.RULES, asOf, kind);
        if (existing.isPresent()) {
            return existing.get();
        }
        Book book = rulesBook();
        if (PaperBooks.NOT_STARTED.equals(book.status())) {
            throw new InvalidRequestException("규칙 계좌는 아직 시작 전입니다 — 개요의 '시작'으로 초기 결정을 먼저 내리세요.");
        }
        Instant started = clock.instant();
        SettingsRow row = run instanceof MarketRun opened ? opened.settingsRow().orElseGet(this::settingsRow) : settingsRow();
        RuleSettings rules = RuleSettings.from(row.body());
        PaperSettings paper = PaperSettings.from(row.body(), UsPaperMarket.INSTANCE);
        Optional<Selection> effective = selection.selectionOn(asOf);
        // 13F 저장본 읽기는 장부와 상관없어 장부 잠금 밖에서 합니다(관측치 처리를 기다리게 하지 않게).
        SignalContext context = effective.map(s -> signals(s, rules, paper.blend())).orElse(null);
        Set<String> universe = observedUniverse(false);

        return ledger.exclusively(() -> {
            Optional<Decision> raced = store.decisionFor(PaperBooks.RULES, asOf, kind);
            if (raced.isPresent()) {
                return raced.get();
            }
            Book current = rulesBook();
            if (PaperBooks.NOT_STARTED.equals(current.status())) {
                // 잠금 밖에서 13F를 읽는 사이에 초기화(리셋)됐습니다 — 현금만 든 시작 전 책에 주문을 남기지 않습니다.
                throw new InvalidRequestException("규칙 계좌가 결정을 준비하는 사이에 초기화돼 시작 전 상태입니다 — 결정을 내지 "
                        + "않았습니다. 개요의 '시작'으로 초기 결정을 먼저 내리세요.");
            }
            boolean paused = PaperBooks.PAUSED.equals(current.status());
            if (REBALANCE.equals(kind) && !paused && context != null) {
                replaceParkingOrders();
            }
            LedgerView view = ledgerView(current);
            Draft draft = context == null || paused ? new Draft()
                    : plan(asOf, kind, context, rules, paper, universe, Map.of(), view, lockedOut(asOf));
            if (context == null) {
                draft.notes.add("그날 유효한 기관 선정이 없습니다 — 신호를 만들 수 없어 주문을 내지 않습니다");
            } else if (paused) {
                draft.notes.addAll(context.notes());
                draft.notes.add("일시정지 중이라 주문을 내지 않습니다(재개한 뒤의 결정부터 다시 냅니다)");
            }
            String status = paused ? STATUS_SKIPPED : draft.orders.isEmpty() ? STATUS_NO_TRADE : STATUS_OK;
            String summary = paused ? "일시정지 중 — 주문을 내지 않습니다"
                    : summary(kind, draft, context == null ? null : context.selection());
            Map<String, Object> response = response(asOf, kind, summary, context, draft, view, rules, paper, universe);
            Decision decision = record(asOf, kind, status, row.version(), context, response, draft, pricesFinal,
                    started);
            log.info("규칙 책 결정 {} {}: {} — {}", asOf, kind, status, summary);
            return decision;
        });
    }

    // ------------------------------------------------------------------ 시작(초기 결정)
    /**
     * "시작"(명세 L2·설계 §4-0 ⑤) — 출발일({@code dashboard.paper.start-date}) 기준으로 선정 → 신호(그날까지 낸 공시) → 배분 →
     * 그날 종가로 <b>사후 체결</b>하고 책을 운용으로 바꿉니다. 결정 종류는 INITIAL, 주문·체결은 얼려 둔 출발일 종가
     * ({@link PaperAdminService#startClose})로 냅니다(벤치마크와 같은 사후 체결 함수 — {@link PaperLedgerService#backfill}).
     *
     * <p>트랙레코드 수집이 끝나지 않았으면(후보 목록에 30분기 수집이 덜 끝난 기관이 있으면) 시작하지 않습니다 — 덜 모인 기관은
     * 자격에서 빠진 채 선정이 굳어, 수집이 끝난 뒤의 순위와 다른 다섯 곳으로 몇 달을 운용하게 됩니다. 선정은 한 번 남기면 바꾸지
     * 않으므로(같은 기준일 재계산도 선정은 그대로) 수집이 끝난 뒤에 누르게 합니다.
     *
     * @throws InvalidRequestException 초기화 전·이미 시작함·출발일 마감 15분 전·후보 목록 없음·수집 중·선정을 만들지 못함
     */
    public StartResult start() {
        Prepared prepared = prepareStart(false);
        return ledger.exclusively(() -> {
            Book book = rulesBook();
            requireNotStarted(book);
            Optional<Decision> existing = store.decisionFor(PaperBooks.RULES, prepared.start(), INITIAL);
            if (existing.isPresent()) {
                // 시작 전 책에 초기 결정이 남아 있을 수는 없지만(리셋이 지움), 있으면 새로 사지 않고 그 기록을 돌려줍니다.
                return new StartResult(existing.get(), List.of());
            }
            BookState state = store.state(PaperBooks.RULES).orElseThrow(() -> new IllegalStateException(
                    "규칙 계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요"));
            LedgerView view = cashOnlyView(state.cash());
            Draft draft = plan(prepared.start(), INITIAL, prepared.context(), prepared.rules(), prepared.paper(),
                    prepared.universe(), prepared.unpriced(), view, Set.of());
            String summary = summary(INITIAL, draft, prepared.context().selection());
            Map<String, Object> response = response(prepared.start(), INITIAL, summary, prepared.context(), draft, view,
                    prepared.rules(), prepared.paper(), prepared.universe());
            return store.atomically(() -> {
                // 시작 전 책에 남은 대기 주문(리셋과 겹친 결정이 남긴 것 등)은 운용으로 바뀐 뒤 초기 배분 위에 더 체결되지 않게
                // 먼저 취소합니다 — 시작 전 책은 주문을 낼 수 없으므로 여기 남은 것은 모두 그런 찌꺼기입니다.
                int stale = store.cancelPendingOrders(PaperBooks.RULES);
                if (stale > 0) {
                    log.warn("규칙 책 시작: 시작 전 책에 남아 있던 대기 주문 {}건을 취소했습니다", stale);
                }
                Optional<Long> id = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, prepared.start(),
                        INITIAL, null, draft.orders.isEmpty() ? STATUS_NO_TRADE : STATUS_OK, null, null,
                        prepared.version(), prepared.context().selection().asOfDate(), null, null, null, null,
                        mapper.valueToTree(response), null, null, null, true, latency(prepared.startedAt()), 0));
                if (id.isEmpty()) {
                    return new StartResult(store.decisionFor(PaperBooks.RULES, prepared.start(), INITIAL).orElseThrow(),
                            List.of());
                }
                List<PaperLedgerService.BackfillLeg> legs = new ArrayList<>();
                for (PlannedOrder order : draft.orders) {
                    legs.add(new PaperLedgerService.BackfillLeg(order.ticker(), order.side(), order.targetWeightPct(),
                            order.sellFraction(), mapper.valueToTree(order.reason())));
                }
                PaperLedgerService.BackfillResult result = ledger.backfill(new PaperLedgerService.BackfillRequest(book,
                        prepared.start(), SOURCE_RULE, id.get(), state.cash(), view.nav(), legs, prepared.closes(),
                        prepared.paper()));
                // 체결 결과를 같은 결정 기록에 덧붙입니다(체결가·수량, 사지 못한 종목).
                ObjectNode updated = mapper.valueToTree(response);
                updated.set("fills", mapper.valueToTree(fillsView(result.fills())));
                List<Map<String, Object>> backfillSkipped = new ArrayList<>();
                result.skipped().forEach(e -> backfillSkipped.add(skip(e.getKey(), e.getValue())));
                updated.set("backfillSkipped", mapper.valueToTree(backfillSkipped));
                store.updateDecision(id.get(), result.fills().isEmpty() ? STATUS_NO_TRADE : STATUS_OK, updated, null);
                log.info("규칙 책 시작: 출발일 {}, 선정 {}, 체결 {}건 — {}", prepared.start(),
                        prepared.context().selection().selectedCiks(), result.fills().size(), summary);
                return new StartResult(store.decision(id.get()).orElseThrow(), result.fills());
            });
        });
    }

    /**
     * "시작" 미리보기 — 장부·선정을 바꾸지 않고 시작하면 낼 주문을 보입니다(응답 JSON 모양은 결정 기록과 같음). 출발일 선정이
     * 아직 없으면 그 기준일의 트랙레코드를 계산해(수동 재계산과 같은 기록) 상위 N곳으로 미리 봅니다 — 선정 기록은 남기지 않습니다.
     */
    public JsonNode preview() {
        Prepared prepared = prepareStart(true);
        Book book = rulesBook();
        BookState state = store.state(PaperBooks.RULES).orElse(null);
        double cash = state == null ? book.initialCash() : state.cash();
        LedgerView view = cashOnlyView(cash);
        Draft draft = plan(prepared.start(), INITIAL, prepared.context(), prepared.rules(), prepared.paper(),
                prepared.universe(), prepared.unpriced(), view, Set.of());
        Map<String, Object> response = response(prepared.start(), INITIAL,
                summary(INITIAL, draft, prepared.context().selection()), prepared.context(), draft, view,
                prepared.rules(), prepared.paper(), prepared.universe());
        response.put("preview", true);
        return mapper.valueToTree(response);
    }

    /** 시작에 필요한 것(검사·선정·신호·종가) — 장부 잠금 밖에서 준비합니다(선정 계산은 몇 초 걸릴 수 있음). */
    private record Prepared(LocalDate start, int version, RuleSettings rules, PaperSettings paper,
                            SignalContext context, Set<String> universe, Map<String, String> unpriced,
                            Map<String, PaperMarketData.SourcedClose> closes, Instant startedAt) {
    }

    private Prepared prepareStart(boolean preview) {
        requireReady();
        Instant startedAt = clock.instant();
        requireNotStarted(rulesBook());
        LocalDate start = config.startDate();
        if (startedAt.isBefore(UsMarketCalendar.closeInstant(start).plus(PaperMarketData.FINAL_DELAY))) {
            throw new InvalidRequestException(start + " 장 마감 15분 뒤부터 시작할 수 있습니다(그날 종가로 사후 체결).");
        }
        SettingsRow row = settingsRow();
        requireCollectionComplete(row);
        Selection chosen = preview ? previewSelection(start) : startSelection(start);
        RuleSettings rules = RuleSettings.from(row.body());
        PaperSettings paper = settings.current().settings();
        SignalContext context = signals(chosen, rules, paper.blend());
        Set<String> universe = observedUniverse(true);

        // 출발일 종가가 있어야 사후 체결합니다 — 유니버스 안 후보와 SHY의 종가를 미리 찾아(얼린 값, 없으면 지금 찾아 얼림),
        // 없는 종목은 배분 전에 "출발일 종가 없음"으로 빼 다음 후보가 그 자리를 갖게 합니다.
        Map<String, PaperMarketData.SourcedClose> closes = new TreeMap<>();
        Map<String, String> unpriced = new TreeMap<>();
        Set<String> wanted = new TreeSet<>();
        context.signals().buyCandidates().forEach(c -> wanted.add(c.ticker()));
        wanted.add(PARKING_TICKER);
        for (String ticker : wanted) {
            if (!universe.contains(ticker)) {
                continue;
            }
            Optional<PaperMarketData.SourcedClose> close = admin.startClose(ticker);
            if (close.isPresent()) {
                closes.put(ticker, close.get());
            } else {
                unpriced.put(ticker, "출발일(" + start + ") 종가 없음");
            }
        }
        return new Prepared(start, row.version(), rules, paper, context, universe, unpriced, closes, startedAt);
    }

    /** 출발일 선정 — 이미 있으면 그대로, 없으면 지금 계산해 남깁니다. 남기지 못하면(자격 기관 0곳 + 수집 중 등) 400. */
    private Selection startSelection(LocalDate start) {
        PaperSelectionService.SelectionOutcome outcome = selection.select(start);
        if (outcome.selection() == null) {
            throw new InvalidRequestException("출발일(" + start + ") 기관 선정을 만들지 못했습니다: "
                    + outcome.skippedReason());
        }
        return outcome.selection();
    }

    /**
     * 미리보기 선정 — 남긴 선정이 있으면 그것, 없으면 계산한 두 그룹의 상위와 신호 풀({@link PaperSelectionService#draftSelection}
     * — 선정이 남기는 것과 같은 모양, 기록하지 않음).
     */
    private Selection previewSelection(LocalDate start) {
        Optional<Selection> saved = selection.selectionOn(start).filter(s -> s.asOfDate().equals(start));
        if (saved.isPresent()) {
            return saved.get();
        }
        PaperSelectionService.Computation computation = selection.compute(start);
        if (computation.skippedReason() != null) {
            throw new InvalidRequestException("출발일(" + start + ") 순위를 계산하지 못했습니다: "
                    + computation.skippedReason());
        }
        return selection.draftSelection(computation);
    }

    /** 트랙레코드 수집이 끝났는가 — 후보(설정 candidateCiks로 거른 수집 목록) 중 complete가 아닌 기관이 있으면 400. */
    private void requireCollectionComplete(SettingsRow row) {
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
            String names = collecting.stream().limit(5)
                    .map(f -> (f.name() == null ? f.cik() : f.name()) + " " + f.storedQuarters() + "/"
                            + index.get().targetQuarters())
                    .reduce((a, b) -> a + ", " + b).orElse("");
            throw new InvalidRequestException("수집 중 " + collecting.size() + "곳(후보 " + candidates.size()
                    + "곳) — 13F 30분기 수집이 끝난 뒤 시작하세요. 덜 모인 기관은 순위에서 빠진 채 선정이 굳습니다: " + names
                    + (collecting.size() > 5 ? " …" : ""));
        }
    }

    // ------------------------------------------------------------------ 신호
    /**
     * 신호 풀 기관 하나(결정 기록에 싣는 값). 공시가 없으면 날짜가 null.
     *
     * @param groups 든 그룹("A"·"B")
     * @param rankA  그룹 A 순위(없으면 null)
     * @param rankB  그룹 B 순위(없으면 null)
     * @param weight 기관 가중(선정 행의 값, 풀 합 1)
     * @param source 읽은 13F 저장본(q30·q8). 저장본이 없으면 null
     */
    record SelectedFiler(String cik, String name, List<String> groups, Integer rankA, Integer rankB, double weight,
                         String source, LocalDate reportDate, LocalDate filingDate, LocalDate previousReportDate,
                         boolean previousFiled) {
    }

    /** 선정과 그 신호 — 장부와 상관없는 부분. */
    record SignalContext(Selection selection, SignalPool pool, List<SelectedFiler> filers, Signal13F.Signals signals,
                         List<String> notes) {

        Map<String, SelectedFiler> byCik() {
            Map<String, SelectedFiler> out = new HashMap<>();
            filers.forEach(f -> out.put(f.cik(), f));
            return out;
        }
    }

    /**
     * 신호 풀 기관마다 그 선정 기준일까지 낸 공시로 대상 분기 q(클래스 설명의 Point-in-Time)와 그 앞 분기를 읽어 신호를 만듭니다.
     * 풀·그룹·순위·가중·이름은 선정 행의 값입니다({@link PaperSelectionService#signalPool} — 다시 계산하지 않음). 확신도 상한은
     * 지금 설정 {@code blend.convictionCapPct}입니다. 두 분기 모두 보유한 티커는 수정주가({@code equity_close})로 주식 분할을
     * 보정합니다({@link Signal13F#collect(List, int, double, double, Signal13F.AdjustedCloses)}).
     */
    SignalContext signals(Selection chosen, RuleSettings rules, PaperSettings.Blend blend) {
        SignalPool pool = PaperSelectionService.signalPool(chosen);
        LocalDate quarterEnd = UsMarketCalendar.latestQuarterEndReselectedBy(chosen.asOfDate());
        List<FilerQuarter> quarters = new ArrayList<>();
        List<SelectedFiler> filers = new ArrayList<>();
        List<String> notes = new ArrayList<>(pool.notes());
        for (PoolMember member : pool.members()) {
            StoredRows stored = holdings(member.cik());
            FilerQuarter quarter = filerQuarter(member, stored.rows(), chosen.asOfDate(), quarterEnd);
            if (quarter == null) {
                notes.add(label(member.cik(), member.name(), member.rankA(), member.rankB()) + ": 선정 기준일("
                        + chosen.asOfDate() + ")까지 낸 " + quarterEnd + " 분기 13F가 저장본에 없음");
                filers.add(new SelectedFiler(member.cik(), member.name(), member.groups(), member.rankA(),
                        member.rankB(), member.weight(), stored.source(), null, null, null, false));
                continue;
            }
            quarters.add(quarter);
            filers.add(new SelectedFiler(member.cik(), member.name(), member.groups(), member.rankA(), member.rankB(),
                    member.weight(), stored.source(), quarter.reportDate(), quarter.filingDate(),
                    HoldingsDiff.previousQuarterEnd(quarter.reportDate()), quarter.previous() != null));
        }
        Signal13F.Signals signals = Signal13F.collect(quarters, rules.minHolders(), ADD_THRESHOLD_PCT,
                blend.convictionCapPct(), adjustedCloses(quarters, quarterEnd));
        notes.addAll(signals.notes());
        return new SignalContext(chosen, pool, filers, signals, notes);
    }

    /** 한 기관의 13F 보유 열과 그 출처. */
    private record StoredRows(List<HoldingRow> rows, String source) {
    }

    /**
     * 풀 기관의 13F — 기관 선정과 같은 출처(D27): 후보 수집 저장본 q30이 있으면 그것, 없으면 기존 메뉴 저장본 q8. 보유 열만 캐시
     * 없이 읽습니다({@link StoreReader#readStoredHoldings} — 30분기 트리를 저장소 파싱 캐시에 남기지 않게). 저장본이 있으면 분기마다
     * 적어도 한 줄이 나오므로, 빈 결과 = 그 저장본 없음입니다.
     */
    private StoredRows holdings(String cik) {
        List<HoldingRow> q30 = reader.readStoredHoldings(Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS));
        if (!q30.isEmpty()) {
            return new StoredRows(q30, TrackRecordRow.SOURCE_Q30);
        }
        List<HoldingRow> q8 = reader.readStoredHoldings(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS));
        return q8.isEmpty() ? new StoredRows(List.of(), null) : new StoredRows(q8, TrackRecordRow.SOURCE_Q8);
    }

    /** 보고일 수정 종가로 보는 가장 오래된 값(휴장일·거래 정지 — 이보다 오래된 값이면 그 티커는 분할을 보정하지 않음). */
    static final int SPLIT_PRICE_MAX_AGE_DAYS = 7;

    /**
     * 분할 보정용 수정주가 — 두 분기 모두 보유한 티커만, 앞 분기 말 − 14일 ~ 대상 분기 말 범위를 한 번에 읽습니다(대상 분기 말은
     * 선정 기준일보다 앞이라 룩어헤드가 없음). 계열을 다시 쓰는 뒤의 분할·배당은 두 날의 비율에서 지워집니다.
     */
    private Signal13F.AdjustedCloses adjustedCloses(List<FilerQuarter> quarters, LocalDate quarterEnd) {
        Set<String> tickers = new TreeSet<>();
        for (FilerQuarter quarter : quarters) {
            if (quarter.previous() == null) {
                continue;
            }
            Set<String> before = new HashSet<>();
            quarter.previous().forEach(row -> before.add(row.ticker()));
            quarter.current().stream().map(Signal13F.Row::ticker)
                    .filter(t -> t != null && before.contains(t)).forEach(tickers::add);
        }
        if (tickers.isEmpty()) {
            return (ticker, date) -> null;
        }
        LocalDate from = HoldingsDiff.previousQuarterEnd(quarterEnd).minusDays(PaperSelectionService.PRICE_MARGIN_DAYS);
        Map<String, DailySeries> series = marketData.history(tickers, from, quarterEnd);
        return (ticker, date) -> {
            DailySeries s = series.get(ticker);
            LocalDate at = s == null ? null : s.floorDate(date);
            return at == null || at.isBefore(date.minusDays(SPLIT_PRICE_MAX_AGE_DAYS)) ? null : s.floorValue(date);
        };
    }

    /** 13F 한 분기의 줄과 날짜. */
    private record StoredQuarter(LocalDate filingDate, LocalDate reportDate, List<HoldingRow> rows) {
    }

    /**
     * 기관 하나의 13F 저장본에서 그 기준일까지 낸 공시 중 대상 분기 {@code quarterEnd}(같은 분기를 두 번 냈으면 늦은 공시)와
     * 바로 앞 분기({@link HoldingsDiff#previousQuarterEnd} — 분기가 빠졌으면 null). 대상 분기를 아직 내지 않았으면 null입니다
     * (더 앞 분기로 대신하면 기관마다 다른 분기를 대조함). 총평가액은 티커 없는 줄까지 더한 값이고, 평가액을 모르는 줄은 넣지
     * 않습니다(0으로 넣으면 "보유 아님"으로 읽혀 가짜 전량 매도가 됨).
     */
    private static FilerQuarter filerQuarter(PoolMember member, List<HoldingRow> rows, LocalDate asOf,
                                             LocalDate quarterEnd) {
        Map<Integer, List<HoldingRow>> byQuarter = new LinkedHashMap<>();
        for (HoldingRow row : rows) {
            byQuarter.computeIfAbsent(row.quarterIndex(), key -> new ArrayList<>()).add(row);
        }
        List<StoredQuarter> known = new ArrayList<>();
        for (List<HoldingRow> quarter : byQuarter.values()) {
            LocalDate filing = Json.parseDate(quarter.get(0).filingDate());
            LocalDate report = Json.parseDate(quarter.get(0).reportDate());
            if (filing != null && report != null && !filing.isAfter(asOf)) {
                known.add(new StoredQuarter(filing, report, quarter));
            }
        }
        Comparator<StoredQuarter> latestFirst = Comparator.comparing(StoredQuarter::reportDate)
                .thenComparing(StoredQuarter::filingDate).reversed();
        Optional<StoredQuarter> latest = known.stream().filter(q -> q.reportDate().equals(quarterEnd))
                .min(latestFirst);
        if (latest.isEmpty()) {
            return null;
        }
        LocalDate previousEnd = HoldingsDiff.previousQuarterEnd(quarterEnd);
        Optional<StoredQuarter> previous = known.stream().filter(q -> q.reportDate().equals(previousEnd))
                .min(latestFirst);
        List<Signal13F.Row> current = rows(latest.get().rows());
        double total = current.stream().mapToDouble(Signal13F.Row::value).sum();
        return new FilerQuarter(member.cik(), member.rankA(), member.rankB(), member.weight(),
                latest.get().reportDate(), latest.get().filingDate(), total, current,
                previous.map(q -> rows(q.rows())).orElse(null));
    }

    private static List<Signal13F.Row> rows(List<HoldingRow> holdings) {
        List<Signal13F.Row> out = new ArrayList<>(holdings.size());
        for (HoldingRow holding : holdings) {
            if (holding.value() == null) {
                continue;   // 보유가 없는 분기의 빈 줄이거나 평가액을 모르는 줄
            }
            String ticker = holding.ticker() == null || holding.ticker().isBlank() ? null : holding.ticker().strip();
            out.add(new Signal13F.Row(ticker, holding.value(), holding.shares()));
        }
        return out;
    }

    // ------------------------------------------------------------------ 계획
    /** 낼 주문 한 줄(저장 전). 매수 targetWeightPct = 살 금액(체결 시점 순자산 대비 %), 매도 sellFraction null = 전량. */
    record PlannedOrder(String ticker, String side, Double targetWeightPct, Double sellFraction,
                        Map<String, Object> reason, boolean parking) {
    }

    /** 결정 하나의 계획. */
    private static final class Draft {
        final List<PlannedOrder> orders = new ArrayList<>();
        final List<Map<String, Object>> skipped = new ArrayList<>();
        final List<String> notes = new ArrayList<>();

        void skip(String ticker, String reason) {
            skipped.add(RuleBookService.skip(ticker, reason));
        }
    }

    /**
     * 재선정일 계획 전에, 앞선 정기·수동 결정이 낸 현금 관리 SHY 주문({@code rule: "park_cash"})을 취소합니다. 재선정일 계획은 남는
     * 현금을 종목 매수까지 넣어 다시 정하므로(R3), 남겨 두면 그 계획의 SHY 매도와 같은 관측치에서 함께 체결돼 SHY를 팔고 다시 사며
     * 슬리피지를 양쪽으로 냅니다(단계 2 검증). 장부 잠금 안에서 부릅니다 — 취소와 계획 사이에 체결이 끼지 않습니다.
     */
    private void replaceParkingOrders() {
        for (Order order : store.ordersByStatus(PaperBooks.RULES, PaperBooks.ORDER_PENDING)) {
            if ("park_cash".equals(Json.asText(order.reason(), "rule"))) {
                store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, "재선정일 계획이 남는 현금을 다시 정함");
            }
        }
    }

    /**
     * 결정이 보는 장부 — 마지막 관측 가격의 평가(가격을 못 받은 보유는 평단, 장부 평가와 같음). pendingSells는 대기 중인 매도의
     * 티커 → 파는 비율(전량 1, 같은 티커에 여러 건이면 합하되 1까지), pendingBuyAmounts는 대기 중인 매수의 티커 → 어림 금액(달러,
     * 슬리피지 전 — 같은 티커에 여러 건이면 합).
     */
    private record LedgerView(double cash, double nav, double equityValue, double exposurePct,
                              Map<String, Integer> qty, Map<String, Double> price, Set<String> pendingBuys,
                              Map<String, Double> pendingSells, Map<String, Double> pendingBuyAmounts) {

        double value(String ticker) {
            Integer q = qty.get(ticker);
            return q == null ? 0 : q * price.get(ticker);
        }

        double weight(String ticker) {
            return nav > 0 ? value(ticker) / nav * 100.0 : 0;
        }
    }

    private LedgerView ledgerView(Book book) {
        BookState state = store.state(book.code()).orElseThrow(() -> new IllegalStateException(
                "규칙 계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요"));
        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        for (Position p : store.positions(book.code())) {
            qty.put(p.ticker(), p.qty());
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(state.cash(), qty, price);
        Set<String> pendingBuys = new HashSet<>();
        Map<String, Double> pendingSells = new HashMap<>();
        Map<String, Double> pendingBuyAmounts = new HashMap<>();
        for (Order order : store.ordersByStatus(book.code(), PaperBooks.ORDER_PENDING)) {
            if (PaperBooks.SELL.equals(order.side())) {
                double fraction = order.sellFraction() == null ? 1.0 : Math.max(0, Math.min(1, order.sellFraction()));
                pendingSells.merge(order.ticker(), fraction, (a, b) -> Math.min(1.0, a + b));
            } else {
                pendingBuys.add(order.ticker());
                pendingBuyAmounts.merge(order.ticker(), pendingBuyAmount(order, price, valuation.nav()), Double::sum);
            }
        }
        return new LedgerView(state.cash(), valuation.nav(), valuation.equityValue(), valuation.exposurePct(), qty,
                price, pendingBuys, pendingSells, pendingBuyAmounts);
    }

    /**
     * 대기 매수 한 건이 쓸 현금의 어림(달러, 슬리피지 전). 장부는 목표 비중 주문을 "체결 시점 순자산 × 비중"으로 사므로 지금
     * 순자산으로 어림하고, 수량 주문은 마지막 가격으로 어림합니다. 가격을 모르는 수량 주문(보유하지 않은 종목 — 규칙 책은 수량
     * 주문을 내지 않음)은 금액을 지어내지 않고 0으로 둡니다.
     */
    private static double pendingBuyAmount(Order order, Map<String, Double> price, double nav) {
        if (order.qty() != null) {
            Double last = price.get(order.ticker());
            return last == null ? 0 : Math.max(0, order.qty()) * last;
        }
        Double weight = order.targetWeightPct();
        return weight == null || !Double.isFinite(weight) ? 0 : Math.max(0, weight) / 100.0 * nav;
    }

    private static LedgerView cashOnlyView(double cash) {
        return new LedgerView(cash, cash, 0, 0, Map.of(), Map.of(), Set.of(), Map.of(), Map.of());
    }

    /**
     * 현금 어림의 출발점 — 현금 + 대기 매도 대금 − 대기 매수 금액(재선정일 계획·매일 남는 현금이 같이 씀). 대기 주문은 다음
     * 관측치에서 이번 결정의 주문과 함께 체결되므로(매도 먼저), 빼면 남는 현금을 잘못 잡아 SHY를 덜/더 사거나 쓸데없이 SHY를
     * 팝니다(R3). 현금성 종목(SHY)의 대기 주문은 넣지 않습니다 — 대기 SHY 매수는 장부가 종목 매수 뒤에 남는 현금으로만 체결해
     * 종목 매수와 현금을 다투지 않고(PaperLedgerService.fill), 대기 SHY 주문이 있으면 남는 현금 단계가 새 SHY 주문을 내지 않습니다.
     */
    private static double pendingCash(LedgerView view, PaperSettings paper, double bp) {
        double out = 0;
        for (Map.Entry<String, Double> sell : view.pendingSells().entrySet()) {
            if (!paper.cashLike(sell.getKey())) {
                out += view.value(sell.getKey()) * sell.getValue() * (1 - bp);
            }
        }
        for (Map.Entry<String, Double> buy : view.pendingBuyAmounts().entrySet()) {
            if (!paper.cashLike(buy.getKey())) {
                out -= buy.getValue() * (1 + bp);
            }
        }
        return out;
    }

    /**
     * 주문 계획(클래스 설명의 ①~③). {@code excluded}는 배분 전에 뺄 후보와 그 사유(시작: 출발일 종가 없음).
     */
    private Draft plan(LocalDate asOf, String kind, SignalContext context, RuleSettings rules, PaperSettings paper,
                       Set<String> universe, Map<String, String> excluded, LedgerView view, Set<String> lockedOut) {
        Draft draft = new Draft();
        draft.notes.addAll(context.notes());
        Signal13F.Signals signals = context.signals();
        Map<String, SelectedFiler> filers = context.byCik();
        double bp = paper.slippageBp() / 10_000.0;
        double nav = view.nav();
        // 이미 대기 중인 주문(앞선 결정이 낸 것)은 다음 관측치에서 이번 주문과 함께 체결되므로 현금 어림에 먼저 넣습니다.
        double projectedCash = view.cash() + pendingCash(view, paper, bp);

        // ① 매도 신호 — 보유 종목을 풀 기관 minHolders곳 이상이 전량 매도(R2). SHY는 신호가 아니라 남는 현금 자리라 보지 않음.
        for (String ticker : new TreeSet<>(view.qty().keySet())) {
            List<String> closers = signals.closedBy().getOrDefault(ticker, List.of());
            Double pendingFraction = view.pendingSells().get(ticker);
            if (paper.cashLike(ticker)) {
                continue;
            }
            if (closers.size() < rules.minHolders()) {
                continue;
            }
            if (pendingFraction != null) {
                draft.skip(ticker, "매도 신호 — 이미 대기 중인 매도 주문이 있어 다시 내지 않음");
                continue;
            }
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("rule", "R2");
            reason.put("signal", "SELL");
            reason.put("kind", kind);
            reason.put("text", closers.size() + "곳 전량 매도: " + closers.stream()
                    .map(cik -> describe(filers.get(cik), cik)).reduce((a, b) -> a + ", " + b).orElse(""));
            reason.put("closers", closers.stream().map(cik -> filerView(filers.get(cik), cik)).toList());
            reason.put("minHolders", rules.minHolders());
            reason.put("currentWeightPct", PaperQueryService.round4(view.weight(ticker)));
            reason.put("selectionAsOf", context.selection().asOfDate().toString());
            draft.orders.add(new PlannedOrder(ticker, PaperBooks.SELL, null, null, reason, false));
            projectedCash += view.value(ticker) * (1 - bp);
        }

        boolean buyDay = REBALANCE.equals(kind) || INITIAL.equals(kind);
        if (!buyDay) {
            if (!signals.buyCandidates().isEmpty()) {
                draft.notes.add("매수 후보 " + signals.buyCandidates().size() + "개는 재선정일이 아니라 사지 않습니다(R5 — "
                        + "매수는 공시 기한 다음 거래일에만)");
            }
            parkIdleCash(draft, kind, context, rules, paper, universe, view, projectedCash);
            return draft;
        }
        // REBALANCE는 그 분기의 재선정일 r 선정으로만 삽니다. 재선정일을 놓쳐 뒤늦게 내는 REBALANCE(결정 작업)도 r 선정을 씁니다.
        LocalDate reselection = reselectionDayAsOf(asOf);
        if (REBALANCE.equals(kind) && !context.selection().asOfDate().equals(reselection)) {
            draft.notes.add("재선정일(" + reselection + ") 선정이 없습니다(가장 최근 선정 " + context.selection().asOfDate()
                    + ") — 지난 분기 신호로 다시 사지 않습니다");
            // 선정을 기다리는 동안(따라잡기 REBALANCE가 날마다 나는 기간)에도 남는 현금은 평소처럼 SHY에 둡니다(R3).
            parkIdleCash(draft, kind, context, rules, paper, universe, view, projectedCash);
            return draft;
        }
        if (!(nav > 0)) {
            draft.notes.add("순자산이 0 이하라 매수 비중을 정할 수 없습니다");
            return draft;
        }
        if (universe.isEmpty()) {
            draft.notes.add("관측치 저장본(paper.quotes)이 없어 살 수 있는 종목을 알 수 없습니다 — 매수하지 않습니다");
        }

        // ② 배분 — 현금성·매도 신호와 겹치는 후보·종가 없는 후보는 자리를 차지하지 않게 먼저 뺍니다.
        List<Candidate> eligible = new ArrayList<>();
        Map<String, Candidate> byTicker = new HashMap<>();
        for (Candidate candidate : signals.buyCandidates()) {
            int closers = signals.closedBy().getOrDefault(candidate.ticker(), List.of()).size();
            if (paper.cashLike(candidate.ticker())) {
                draft.skip(candidate.ticker(), "현금성 종목(남는 현금 자리)");
            } else if (closers >= rules.minHolders()) {
                draft.skip(candidate.ticker(), "매도 신호(" + closers + "곳 전량 매도)와 겹침");
            } else if (excluded.containsKey(candidate.ticker())) {
                draft.skip(candidate.ticker(), excluded.get(candidate.ticker()));
            } else {
                eligible.add(candidate);
                byTicker.putIfAbsent(candidate.ticker(), candidate);
            }
        }
        PaperSettings.Blend blend = paper.blend();
        Signal13F.Plan allocation = Signal13F.allocate(eligible, rules.maxNames(), rules.maxWeightPct(),
                rules.maxWeightEtfPct(), rules.etfs(), universe, lockedOut, blend.allocation(), blend.minTargetPct());
        allocation.skipped().forEach(entry -> draft.skip(entry.getKey(), entry.getValue()));
        int rankInPlan = 0;
        for (Allocation a : allocation.allocations()) {
            rankInPlan++;
            if (view.pendingBuys().contains(a.ticker())) {
                draft.skip(a.ticker(), "이미 대기 중인 매수 주문이 있음");
                continue;
            }
            double current = view.weight(a.ticker());
            double shortfall = a.targetWeightPct() - current;
            if (!(shortfall > 0)) {
                draft.skip(a.ticker(), String.format(Locale.ROOT, "이미 목표 비중 이상 보유(현재 %.2f%% ≥ 목표 %.2f%%)",
                        current, a.targetWeightPct()));
                continue;
            }
            double orderWeight = round4(shortfall);
            if (belowMinNotional(draft, a.ticker(), orderWeight, nav, rules)) {
                continue;   // 목표까지 몇백 달러 모자란 보유를 채우는 주문 — 비중은 그대로 두고 현금은 남는 현금으로
            }
            Candidate candidate = byTicker.get(a.ticker());
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("rule", "R2·R4");
            reason.put("signal", "BUY");
            reason.put("kind", kind);
            reason.put("text", buyText(candidate, filers));
            reason.put("score", round6(candidate.score()));
            reason.put("contributions", contributionsView(candidate, filers));
            reason.put("rankInPlan", rankInPlan);
            reason.put("allocation", blend.allocation().name());
            reason.put("buyers", candidate.events().stream().map(e -> eventView(e, filers)).toList());
            reason.put("combinedWeightPct", PaperQueryService.round4(candidate.combinedWeightPct()));
            reason.put("targetWeightPct", round4(a.targetWeightPct()));
            reason.put("currentWeightPct", PaperQueryService.round4(current));
            reason.put("orderWeightPct", orderWeight);
            reason.put("selectionAsOf", context.selection().asOfDate().toString());
            draft.orders.add(new PlannedOrder(a.ticker(), PaperBooks.BUY, orderWeight, null, reason, false));
            projectedCash -= orderWeight / 100.0 * nav * (1 + bp);
        }

        // ③ 남는 현금 — SHY에 두거나(여유 0.5%p를 남김), 모자라면 SHY를 일부 팔아 메웁니다.
        if (!rules.parkCashInShy()) {
            return draft;
        }
        double spare = projectedCash / nav * 100.0;
        double shyWeight = view.weight(PARKING_TICKER);
        boolean shyTradable = universe.contains(PARKING_TICKER) && !excluded.containsKey(PARKING_TICKER);
        if (spare > CASH_BUFFER_PCT) {
            if (!shyTradable) {
                draft.notes.add(PARKING_TICKER + " 시세(또는 출발일 종가)가 없어 남는 현금 "
                        + String.format(Locale.ROOT, "%.2f%%", spare) + "를 현금으로 둡니다");
            } else if (view.pendingBuys().contains(PARKING_TICKER)) {
                draft.skip(PARKING_TICKER, "남는 현금 — 이미 대기 중인 매수 주문이 있음");
            } else {
                double increment = round4(spare - CASH_BUFFER_PCT);
                if (belowMinNotional(draft, PARKING_TICKER, increment, nav, rules)) {
                    return draft;   // 남는 현금이 여유를 조금 넘을 뿐 — 몇백 달러 SHY는 슬리피지만 냄
                }
                Map<String, Object> reason = parkingReason("R3", kind, spare, shyWeight, context);
                reason.put("text", String.format(Locale.ROOT, "남는 현금 %.2f%% 중 %.2f%%를 %s에(여유 %.1f%%p)", spare,
                        increment, PARKING_TICKER, CASH_BUFFER_PCT));
                reason.put("targetWeightPct", round4(shyWeight + increment));
                reason.put("orderWeightPct", increment);
                draft.orders.add(new PlannedOrder(PARKING_TICKER, PaperBooks.BUY, increment, null, reason, true));
            }
        } else if (spare < 0) {
            double shyValue = view.value(PARKING_TICKER) * (1 - bp);
            if (!(shyValue > 0)) {
                draft.notes.add(String.format(Locale.ROOT, "현금이 순자산의 %.2f%%만큼 모자라는데 팔 %s가 없습니다 — 뒤쪽 매수는 "
                        + "체결 때 살 수 있는 만큼으로 줄어듭니다(cashLimited)", -spare, PARKING_TICKER));
            } else if (view.pendingSells().containsKey(PARKING_TICKER)) {
                draft.skip(PARKING_TICKER, "모자란 현금 — 이미 대기 중인 매도 주문이 있음");
            } else {
                double need = (CASH_BUFFER_PCT - spare) / 100.0 * nav;
                Double fraction = need >= shyValue ? null : round6(need / shyValue);
                Map<String, Object> reason = parkingReason("R3", kind, spare, shyWeight, context);
                reason.put("text", String.format(Locale.ROOT, "종목 매수에 현금이 순자산의 %.2f%%만큼 모자라 %s %s 매도", -spare,
                        PARKING_TICKER, fraction == null ? "전량" : String.format(Locale.ROOT, "%.1f%%", fraction * 100)));
                reason.put("sellFraction", fraction);
                draft.orders.add(new PlannedOrder(PARKING_TICKER, PaperBooks.SELL, null, fraction, reason, true));
            }
        }
        return draft;
    }

    /**
     * 재선정일이 아닌 날(SCHEDULED·MANUAL)의 남는 현금 관리 — 명세 R3 "남는 현금은 SHY에 둔다"와 R5 "그 외 날은 스탑·매도 신호만"을
     * 함께 지키는 자리(설계 §4-2). 매도 신호·스탑으로 생긴 현금이 다음 재선정일(최대 석 달)까지 놀면 규칙 책이 "현금을 두는 전략"이
     * 돼 Claude 책과의 비교가 흐려지므로, 어림한 남는 현금(현금 + 대기·이번 매도 대금 − 대기 매수 금액, 재선정일 계획과 같은 어림)이
     * 순자산의 {@code rules.parkCashThresholdPct}(기본 2%)를 넘으면 SHY 매수 한 건(남는 현금 − 여유 0.5%p)을 냅니다. 신호 매수가 아니라
     * 현금 관리라 근거는 {@code rule: "park_cash"}이고 메모에도 남깁니다. 기준 아래면 아무것도 하지 않습니다(작은 금액을 날마다
     * 사고팔지 않게).
     *
     * <p>일시정지·시작 전 책에는 오지 않습니다 — {@link #decide}가 일시정지면 계획을 세우지 않고, 시작 전이면 거절합니다. SHY 주문이
     * 이미 대기 중이면(같은 날 앞선 결정·체결 전의 주문, 매수·매도 모두) 새로 내지 않습니다 — 다음 관측치에서 둘이 겹쳐 체결되지 않게.
     */
    private static void parkIdleCash(Draft draft, String kind, SignalContext context, RuleSettings rules,
                                     PaperSettings paper, Set<String> universe, LedgerView view, double projectedCash) {
        double nav = view.nav();
        if (!rules.parkCashInShy() || !(nav > 0)) {
            return;
        }
        double threshold = paper.rules().parkCashThresholdPct();
        // 기준이 여유(0.5%p)보다 낮게 설정돼도 여유는 남깁니다 — 남는 현금 − 여유가 0 이하면 살 것이 없습니다.
        double trigger = Math.max(threshold, CASH_BUFFER_PCT);
        double spare = projectedCash / nav * 100.0;
        if (!(spare > trigger)) {
            return;
        }
        if (!universe.contains(PARKING_TICKER)) {
            draft.notes.add(PARKING_TICKER + " 시세가 없어 남는 현금 " + String.format(Locale.ROOT, "%.2f%%", spare)
                    + "를 현금으로 둡니다");
            return;
        }
        if (view.pendingBuys().contains(PARKING_TICKER) || view.pendingSells().containsKey(PARKING_TICKER)) {
            draft.skip(PARKING_TICKER, "남는 현금 — 이미 대기 중인 " + PARKING_TICKER + " 주문이 있음");
            return;
        }
        double increment = round4(spare - CASH_BUFFER_PCT);
        if (belowMinNotional(draft, PARKING_TICKER, increment, nav, rules)) {
            return;
        }
        double shyWeight = view.weight(PARKING_TICKER);
        Map<String, Object> reason = parkingReason("park_cash", kind, spare, shyWeight, context);
        reason.put("thresholdPct", threshold);
        String text = String.format(Locale.ROOT, "남는 현금 %.2f%%가 기준 %.1f%%를 넘어 %.2f%%를 %s에(여유 %.1f%%p) — "
                + "신호 매수가 아닌 현금 관리", spare, threshold, increment, PARKING_TICKER, CASH_BUFFER_PCT);
        reason.put("text", text);
        reason.put("targetWeightPct", round4(shyWeight + increment));
        reason.put("orderWeightPct", increment);
        draft.orders.add(new PlannedOrder(PARKING_TICKER, PaperBooks.BUY, increment, null, reason, true));
        // 결정 기록에서도 이 매수가 신호(R2·R4)가 아니라 현금 관리임을 바로 읽게 — 매수는 재선정일에만이라는 R5와 헷갈리지 않게.
        draft.notes.add(text);
    }

    /**
     * 매수 금액(순자산 대비 % × 순자산)이 {@code minOrderNotional} 미만이면 건너뜀에 남기고 true. 종목 보충 매수와 SHY 매수가
     * 같이 씁니다.
     */
    private static boolean belowMinNotional(Draft draft, String ticker, double orderWeightPct, double nav,
                                            RuleSettings rules) {
        double amount = orderWeightPct / 100.0 * nav;
        if (amount >= rules.minOrderNotional()) {
            return false;
        }
        draft.skip(ticker, String.format(Locale.ROOT, "최소 금액 미만(%,.2f달러 < %,.0f달러)", amount,
                rules.minOrderNotional()));
        return true;
    }

    private static Map<String, Object> parkingReason(String rule, String kind, double spare, double shyWeight,
                                                     SignalContext context) {
        Map<String, Object> reason = new LinkedHashMap<>();
        reason.put("rule", rule);
        reason.put("signal", "PARKING");
        reason.put("kind", kind);
        reason.put("parking", true);
        reason.put("spareCashPct", round4(spare));
        reason.put("bufferPct", CASH_BUFFER_PCT);
        reason.put("currentWeightPct", round4(shyWeight));
        reason.put("selectionAsOf", context.selection().asOfDate().toString());
        return reason;
    }

    // ------------------------------------------------------------------ 기록
    private Decision record(LocalDate asOf, String kind, String status, int settingsVersion, SignalContext context,
                            Map<String, Object> response, Draft draft, boolean pricesFinal, Instant started) {
        return store.atomically(() -> {
            Optional<Long> id = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.RULES, asOf, kind, null, status,
                    null, null, settingsVersion, context == null ? null : context.selection().asOfDate(), null, null,
                    null, null, mapper.valueToTree(response), null, null, null, pricesFinal, latency(started), 0));
            if (id.isEmpty()) {
                return store.decisionFor(PaperBooks.RULES, asOf, kind).orElseThrow();
            }
            LocalDate expires = UsMarketCalendar.addTradingDays(asOf, ORDER_EXPIRY_TRADING_DAYS);
            for (PlannedOrder order : draft.orders) {
                store.insertOrder(new Order(0, PaperBooks.RULES, id.get(), order.ticker(), order.side(), null,
                        order.targetWeightPct(), order.sellFraction(), NEXT_OBSERVATION, SOURCE_RULE,
                        PaperBooks.ORDER_PENDING, null, mapper.valueToTree(order.reason()), asOf, null, expires, null));
            }
            return store.decision(id.get()).orElseThrow();
        });
    }

    /**
     * 결정 기록({@code response}) — 설계 §4-3의 {@code {gate(참고), selection, signals, orders, skipped, notes}}에 요약·장부
     * 평가·쓴 설정을 더한 것.
     */
    private Map<String, Object> response(LocalDate asOf, String kind, String summary, SignalContext context, Draft draft,
                                         LedgerView view, RuleSettings rules, PaperSettings paper,
                                         Set<String> universe) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("summary", summary);
        out.put("book", PaperBooks.RULES);
        out.put("kind", kind);
        out.put("asOfTradingDate", asOf.toString());
        out.put("gate", store.gate(asOf).map(PaperGate::view).orElse(null));
        out.put("selection", context == null ? null : selectionView(context));
        out.put("signals", context == null ? null : signalsView(context, rules));
        Map<String, Object> valuation = new LinkedHashMap<>();
        valuation.put("cash", PaperQueryService.round2(view.cash()));
        valuation.put("nav", PaperQueryService.round2(view.nav()));
        valuation.put("equityValue", PaperQueryService.round2(view.equityValue()));
        valuation.put("exposurePct", PaperQueryService.round2(view.exposurePct()));
        valuation.put("positions", view.qty().size());
        out.put("valuation", valuation);
        List<Map<String, Object>> orders = new ArrayList<>();
        for (PlannedOrder order : draft.orders) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", order.ticker());
            row.put("side", order.side());
            row.put("targetWeightPct", order.targetWeightPct());
            row.put("sellFraction", order.sellFraction());
            row.put("parking", order.parking());
            row.put("reason", order.reason());
            orders.add(row);
        }
        out.put("orders", orders);
        out.put("skipped", draft.skipped);
        out.put("notes", draft.notes);
        Map<String, Object> used = new LinkedHashMap<>();
        used.put("minHolders", rules.minHolders());
        used.put("rulesMaxNames", rules.maxNames());
        used.put("maxWeightStockPct", rules.maxWeightPct());
        used.put("maxWeightEtfPct", rules.maxWeightEtfPct());
        used.put("parkCashInShy", rules.parkCashInShy());
        used.put("parkCashThresholdPct", paper.rules().parkCashThresholdPct());
        used.put("minOrderNotional", rules.minOrderNotional());
        used.put("addThresholdPct", ADD_THRESHOLD_PCT);
        PaperSettings.Blend blend = paper.blend();
        used.put("allocation", blend.allocation().name());
        used.put("convictionCapPct", blend.convictionCapPct());
        used.put("minTargetPct", blend.minTargetPct());
        used.put("slippageBp", paper.slippageBp());
        used.put("universeSize", universe.size());
        List<String> fallbacks = new ArrayList<>(rules.fallbacks());
        fallbacks.addAll(blend.fallbacks());
        fallbacks.addAll(paper.rules().fallbacks());
        used.put("fallbacks", fallbacks);
        out.put("settings", used);
        return out;
    }

    /**
     * 결정 기록의 선정(D27) — {@code {asOf, ciks(신호 풀), groupA, groupB(순위표 상위 10, 선정 행 그대로), pool, groupWeightA,
     * legacy, filers:[풀 기관마다 그룹·순위·가중·출처·대조한 분기]}}. 섞기 전 선정(legacy)은 groupA만 — 그 행의 순위표 배열.
     */
    private static Map<String, Object> selectionView(SignalContext context) {
        Selection s = context.selection();
        SignalPool pool = context.pool();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("asOf", s.asOfDate().toString());
        out.put("ciks", s.selectedCiks());
        JsonNode ranking = s.ranking();
        out.put("groupA", topRows(pool.legacy() ? ranking : Json.child(ranking, "groupA")));
        out.put("groupB", topRows(pool.legacy() ? null : Json.child(ranking, "groupB")));
        out.put("pool", PaperSelectionService.poolView(pool.members()));
        out.put("groupWeightA", pool.groupWeightA());
        out.put("legacy", pool.legacy());
        List<Map<String, Object>> filers = new ArrayList<>();
        for (SelectedFiler f : context.filers()) {
            Map<String, Object> row = filerView(f, f.cik());
            row.put("source", f.source());
            row.put("reportDate", text(f.reportDate()));
            row.put("filingDate", text(f.filingDate()));
            row.put("previousReportDate", text(f.previousReportDate()));
            row.put("previousFiled", f.previousFiled());
            filers.add(row);
        }
        out.put("filers", filers);
        return out;
    }

    /** 순위표 배열의 앞 {@link #RANKING_SHOWN}줄(그대로). 배열이 아니면 빈 목록. */
    private static List<JsonNode> topRows(JsonNode rows) {
        List<JsonNode> out = new ArrayList<>();
        if (rows != null && rows.isArray()) {
            for (JsonNode entry : rows) {
                if (out.size() >= RANKING_SHOWN) {
                    break;
                }
                out.add(entry);
            }
        }
        return out;
    }

    private static Map<String, Object> signalsView(SignalContext context, RuleSettings rules) {
        Map<String, SelectedFiler> filers = context.byCik();
        Signal13F.Signals signals = context.signals();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("minHolders", rules.minHolders());
        out.put("addThresholdPct", ADD_THRESHOLD_PCT);
        out.put("events", signals.events().stream().map(e -> eventView(e, filers)).toList());
        // 후보는 Signal13F의 모양(정렬·점수) 그대로에 기관 이름·그룹을 붙입니다. 전량 매도는 CIK만(이름은 selection.filers).
        List<Map<String, Object>> candidates = new ArrayList<>();
        for (Candidate c : signals.buyCandidates()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", c.ticker());
            row.put("buyerCiks", c.buyerCiks());
            row.put("score", round6(c.score()));
            row.put("contributions", contributionsView(c, filers));
            row.put("combinedWeightPct", PaperQueryService.round4(c.combinedWeightPct()));
            row.put("events", c.events().stream().map(e -> eventView(e, filers)).toList());
            row.put("text", buyText(c, filers));
            candidates.add(row);
        }
        out.put("candidates", candidates);
        out.put("closedBy", signals.closedBy());
        return out;
    }

    /**
     * 후보 점수의 기관별 기여 — {@code [{cik, name, groups, rankA, rankB, filerWeight, conviction, points, action, sharesChangePct,
     * weightPct}]}(수용 기준 "어느 기관(그룹·순위·가중)"). 가중·확신도·기여는 0~1 비율(6자리), 비중은 %(4자리). Signal13F가
     * contributions와 events를 같은 기관 순서로 주므로 같은 자리끼리 짝짓습니다.
     */
    private static List<Map<String, Object>> contributionsView(Candidate candidate, Map<String, SelectedFiler> filers) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < candidate.contributions().size(); i++) {
            Contribution c = candidate.contributions().get(i);
            Event event = i < candidate.events().size() ? candidate.events().get(i) : null;
            Map<String, Object> row = filerView(filers.get(c.cik()), c.cik());
            row.remove("weight");
            row.put("filerWeight", round6(c.filerWeight()));
            row.put("conviction", round6(c.conviction()));
            row.put("points", round6(c.points()));
            row.put("action", event == null ? null : event.action());
            row.put("sharesChangePct", event == null ? null : PaperQueryService.round2(event.sharesChangePct()));
            row.put("weightPct", event == null ? null : PaperQueryService.round4(event.weightPct()));
            out.add(row);
        }
        return out;
    }

    private static Map<String, Object> eventView(Event e, Map<String, SelectedFiler> filers) {
        SelectedFiler filer = filers.get(e.cik());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cik", e.cik());
        out.put("name", filer == null ? null : filer.name());
        out.put("groups", filer == null ? List.of() : filer.groups());
        out.put("rankA", filer == null ? null : filer.rankA());
        out.put("rankB", filer == null ? null : filer.rankB());
        out.put("ticker", e.ticker());
        out.put("action", e.action());
        out.put("sharesChangePct", PaperQueryService.round2(e.sharesChangePct()));
        out.put("weightPct", PaperQueryService.round4(e.weightPct()));
        out.put("previousWeightPct", PaperQueryService.round4(e.previousWeightPct()));
        return out;
    }

    /** 기관 한 곳의 이름·그룹·순위·가중({@code weight}, 0~1 — 6자리). 풀에 없으면 CIK 말고는 null. */
    private static Map<String, Object> filerView(SelectedFiler filer, String cik) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cik", cik);
        out.put("name", filer == null ? null : filer.name());
        out.put("groups", filer == null ? List.of() : filer.groups());
        out.put("rankA", filer == null ? null : filer.rankA());
        out.put("rankB", filer == null ? null : filer.rankB());
        out.put("weight", filer == null ? null : round6(filer.weight()));
        return out;
    }

    /**
     * "2곳 동시 매수(점수 0.4333): A1·B1 듀케인(0001536411) 신규(가중 0.3667 × 확신도 1.00), A3 …(…) +35.0%(가중 0.0667 ×
     * 확신도 0.50)" — 근거 한 줄(수용 기준: 어느 기관(그룹·순위·가중)이 신규/+30%였고 점수에 얼마를 보탰나).
     */
    private static String buyText(Candidate candidate, Map<String, SelectedFiler> filers) {
        StringBuilder text = new StringBuilder().append(candidate.buyerCiks().size()).append("곳 동시 매수(점수 ")
                .append(String.format(Locale.ROOT, "%.4f", candidate.score())).append("): ");
        for (int i = 0; i < candidate.events().size(); i++) {
            Event event = candidate.events().get(i);
            if (i > 0) {
                text.append(", ");
            }
            text.append(describe(filers.get(event.cik()), event.cik())).append(' ');
            if (Signal13F.NEW.equals(event.action()) || event.sharesChangePct() == null) {
                text.append("신규");
            } else {
                text.append(String.format(Locale.ROOT, "%+.1f%%", event.sharesChangePct()));
            }
            if (i < candidate.contributions().size()) {
                Contribution c = candidate.contributions().get(i);
                text.append(String.format(Locale.ROOT, "(가중 %.4f × 확신도 %.2f)", c.filerWeight(), c.conviction()));
            }
        }
        return text.toString();
    }

    private static String describe(SelectedFiler filer, String cik) {
        return filer == null ? cik : label(cik, filer.name(), filer.rankA(), filer.rankB());
    }

    /** "A1·B2 이름(CIK)" — 그룹 순위가 없으면 이름(CIK)만, 이름이 없으면 CIK. */
    private static String label(String cik, String name, Integer rankA, Integer rankB) {
        List<String> ranks = new ArrayList<>(2);
        if (rankA != null) {
            ranks.add("A" + rankA);
        }
        if (rankB != null) {
            ranks.add("B" + rankB);
        }
        String who = name == null || name.isBlank() ? cik : name + "(" + cik + ")";
        return ranks.isEmpty() ? who : String.join("·", ranks) + " " + who;
    }

    private static String summary(String kind, Draft draft, Selection chosen) {
        if (chosen == null) {
            return "선정 없음 — 주문을 내지 않습니다";
        }
        long sells = draft.orders.stream().filter(o -> !o.parking() && PaperBooks.SELL.equals(o.side())).count();
        long buys = draft.orders.stream().filter(o -> !o.parking() && PaperBooks.BUY.equals(o.side())).count();
        List<String> parts = new ArrayList<>();
        if (sells > 0) {
            parts.add("매도 " + sells);
        }
        if (buys > 0) {
            parts.add("매수 " + buys);
        }
        draft.orders.stream().filter(PlannedOrder::parking).findFirst().ifPresent(o -> parts.add(
                PARKING_TICKER + (PaperBooks.BUY.equals(o.side()) ? " 매수(남는 현금)" : " 매도(모자란 현금)")));
        boolean buyDay = REBALANCE.equals(kind) || INITIAL.equals(kind);
        String head = parts.isEmpty()
                ? "주문 없음" + (buyDay ? "" : " — 매도 신호 없음(매수는 재선정일에만)")
                : String.join(" · ", parts);
        return head + " (선정 " + chosen.asOfDate() + " · " + chosen.selectedCiks().size() + "곳)";
    }

    private List<Map<String, Object>> fillsView(List<Fill> fills) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Fill f : fills) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("orderId", f.orderId());
            row.put("ticker", f.ticker());
            row.put("side", f.side());
            row.put("qty", f.qty());
            row.put("price", PaperQueryService.round4(f.price()));
            row.put("rawPrice", PaperQueryService.round4(f.rawPrice()));
            row.put("gross", PaperQueryService.round2(f.gross()));
            row.put("priceSource", f.priceSource());
            out.add(row);
        }
        return out;
    }

    static Map<String, Object> skip(String ticker, String reason) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ticker", ticker);
        out.put("reason", reason);
        return out;
    }

    // ------------------------------------------------------------------ 유니버스·조각
    /**
     * 살 수 있는 종목 — 관측치 저장본({@code paper.quotes})이 받는 종목. 시작(출발일 사후 체결)은 얼려 둔 출발일 종가가 있는
     * 종목도 더합니다(얼린 시점의 관측치 유니버스). 저장본은 수집을 깨우지 않고 읽습니다.
     */
    private Set<String> observedUniverse(boolean withStartPrices) {
        Set<String> out = new TreeSet<>();
        reader.quietly(marketData::quotes).ifPresent(quotes -> out.addAll(quotes.bars().keySet()));
        if (withStartPrices) {
            for (StartPrice frozen : store.startPrices()) {
                if (config.startDate().equals(frozen.tradingDate())) {
                    out.add(frozen.ticker());
                }
            }
        }
        return out;
    }

    /** 다음 세션(주문이 체결될 날)에도 재진입 금지인 종목 — 장부가 체결 때 보는 조건과 같은 날로 봅니다. */
    private Set<String> lockedOut(LocalDate asOf) {
        LocalDate fillDay = UsMarketCalendar.nextTradingDay(asOf);
        Set<String> out = new TreeSet<>();
        for (Lockout lockout : store.lockouts(PaperBooks.RULES)) {
            if (TrailingStop.lockedOut(lockout.untilTradingDate(), fillDay)) {
                out.add(lockout.ticker());
            }
        }
        return out;
    }

    private Book rulesBook() {
        return store.book(PaperBooks.RULES).orElseThrow(() -> new InvalidRequestException(
                "규칙 계좌가 없습니다 — 먼저 초기화(POST /api/paper/init)를 누르세요."));
    }

    private static void requireNotStarted(Book book) {
        if (!PaperBooks.NOT_STARTED.equals(book.status())) {
            throw new InvalidRequestException("규칙 계좌는 이미 시작했습니다(상태 " + book.status() + ", 출발 "
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

    private long latency(Instant started) {
        return Math.max(0, clock.millis() - started.toEpochMilli());
    }

    private static double round4(double value) {
        return BigDecimal.valueOf(value).setScale(4, RoundingMode.HALF_UP).doubleValue();
    }

    private static double round6(double value) {
        return BigDecimal.valueOf(value).setScale(6, RoundingMode.HALF_UP).doubleValue();
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
