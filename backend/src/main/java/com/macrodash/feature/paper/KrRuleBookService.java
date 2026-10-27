package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrFundamentals;
import com.macrodash.analytics.KrReselection;
import com.macrodash.analytics.KrRules;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 🧪 한국 규칙 계좌({@code kr_rules}, 동결 대조군) — 수급 규칙(2단계 명세 §4-6·K7·K10·K33)의 순수 계산({@link KrRules}·{@link KrReselection})을
 * 저장본·장부·결정 행에 잇는 자리(D1b). 미국 13F 규칙 책({@link RuleBookService})과 코드를 나누지 않습니다 — 미국 규칙 책은 그대로입니다.
 *
 * <pre>
 *  정기 결정(결정 작업, 세션 D)
 *    그 실행의 설정 판(kr.*) → 이 계좌의 매수 결정 날짜(OK인 REBALANCE·INITIAL, 출발일 이후) → KrReselection.selectionOn(D)
 *      선정함 → REBALANCE(cycleDate = r, selectionAsOf = D — 예정일 당일이면 r = D, 놓쳤으면 따라잡기 K33)
 *      아님   → SCHEDULED(매도 신호·남는 현금 153130만)
 *    입력 읽기 한 번(K26 동결과 같은 읽기) → KrRules.select(후보·점수·사유 — 매일 셈, 동결·화면) → 장부 잠금 안에서 주문 계획 → 결정 행 + 주문
 *  기한 지남(D+1 01:00, 결정 작업의 기한 뒤 갈고리) → 그 세션의 NO_TRADE 행(사유 '기한 지남' — 따라잡기의 근거, 주문 없음)
 *  출발(S 22:30, KrStartPipeline 계좌 몫) → INITIAL = 재선정과 같은 계산(cycleDate = r(S), selectionAsOf = S), 주문은 S+1 시가
 * </pre>
 *
 * <p><b>입력 읽기</b>(K26, 그 실행에서 한 번 — {@link StoreReader#quietly}, 수집을 깨우지 않음): U(D) = D보다 이른 가장 최근 금융위 기준일 B의
 * {@code kr_paper_universe}(순위·시총·상장주식수 — 정의는 수집기 한 곳), 수급 = U ∪ 보유의 {@code kr_paper_flow}(D로 끝나는 20 KR 거래일 창),
 * DART = {@code kr.dart_fundamentals}(회사마다 마지막 보고서 — 접수일 ≤ D만, B8), 재진입 금지 = 체결될 날(D 다음 KR 거래일)에도 금지인 종목,
 * 거래정지 = 그 실행 관측치의 토스 {@code krxTradingSuspended} 또는 D 봉 거래량 0. <b>결정 시각 뒤에 알 수 있던 값은 쓰지 않습니다</b>: D 뒤 날짜의
 * 수급 기록, 읽는 순간({@code readAt}) 뒤에 받은 기록, 받은 시각({@code fetchedAt})을 모르는 기록은 빼고 그 수를 결정 행에 남깁니다(빠진 날은
 * '자료 부족' — 다른 판으로 채우지 않음).
 *
 * <p><b>결정 행 동결</b>(K26, 응답 {@code input}): 읽은 순간, U(기준일 B·규칙 판·종목마다 순위·시총·상장주식수), 수급 창과 종목마다 20일·5일 합·연속일·
 * D 기록의 판({@code updatedAt})·받은 시각·세부 칸 유무, DART(회사마다 사업연도·접수번호·접수일·ROE·부채비율·매출액 계정 유무·자본잠식), 점수·후보
 * 여부·빠진 사유(해당하는 것 모두 — '자료 없음' 세부 사유 포함), U 밖 보유의 수급, 재진입 금지·거래정지. 선정한 날은 {@code cycleDate}·
 * {@code selectionAsOf}·후보 순서·매수 종목·비중을 함께 남깁니다(K33 — 따라잡기는 r′ 자료로 고른 것이 행에 보임).
 *
 * <p><b>주문</b>(장부가 다음 거래일 시가에 체결): 출처 {@code RULE}, 시점 {@code NEXT_OPEN}, 기준 거래일 D, 만료 D + 3거래일. 매도 = 보유 전량
 * ({@code sellFraction} null — 체결 때의 보유 전부), 매수 = 목표 비중 − 지금 비중만큼(순자산 대비 %, {@code kr.minOrderNotional} 미만은 내지 않음).
 * 매수는 선정한 날(REBALANCE·INITIAL)에만, 매도 신호는 매일(20일 외국인·기관 둘 다 순매도) + 선정한 날 후보 밖. 남는 현금은 153130 — 선정한 날은
 * 여유 0.5%p를 넘는 만큼(모자라면 153130을 팔아 메움), 그 밖의 날은 {@code kr.rules.parkCashThresholdPct}를 넘을 때만. 선정한 날은 앞선 날의
 * 대기 중인 남는 현금 주문({@code park_cash})을 먼저 취소합니다(미국 규칙 책 {@code replaceParkingOrders}와 같은 까닭). 비중은 마지막 평가 가격
 * (없으면 평단)으로, 현금 어림은 대기·이번 주문을 비용 요율(수수료 + 슬리피지 + 매도세)로 줄여 셉니다(어림 — 체결은 장부가 {@code KrxCosts}로).
 *
 * <p><b>상태</b>: 선정한 결정(REBALANCE·INITIAL)은 주문이 없어도 {@code OK}입니다 — 그 주기의 매수 결정이라 따라잡기가 다시 고르지 않게(K33,
 * {@link KrReselection}은 OK만 셈). SCHEDULED는 주문이 있으면 OK, 없으면 {@code NO_TRADE}(미국과 같은 뜻). 기한이 지나 결정하지 않은 세션도
 * {@code NO_TRADE}이고 응답의 {@code noTradeReason}으로 가립니다. 일시정지 계좌는 입력을 읽지 않고 {@code SKIPPED}입니다.
 *
 * <p><b>설정</b>(e6): 결정 작업이 연 실행({@link MarketRun})의 설정 행 하나를 {@code kr.} 접두어로 읽습니다 — 결정 행의 {@code settings_version}이
 * 그 판입니다. 없거나 틀린 키는 기본값으로 읽고 응답 {@code settings.fallbacks}에 실제 키 이름으로 남깁니다.
 */
final class KrRuleBookService {

    private static final Logger log = LoggerFactory.getLogger(KrRuleBookService.class);

    /** 매수 결정의 종류(재선정 따라잡기가 세는 것 — 상태 OK만). */
    static final List<String> BUY_KINDS = List.of(RuleBookService.REBALANCE, RuleBookService.INITIAL);
    /** 기한이 지나 결정하지 않은 세션의 사유(결정 행 응답 {@code noTradeReason}). */
    static final String PAST_DEADLINE_REASON = "기한 지남";
    /**
     * 기한이 지난 세션에 게이트 ⑤(069500 D 봉)가 미달이었을 때의 사유 — 늦게 지정된 휴장일과 토스 쪽 지연을 가르지 않습니다(결정 e4, 명세 §9 'D1 —
     * 세션 자료 다시 묻기와 게이트 ⑤': 수집기는 069500에 D 봉이 없으면 다른 종목을 다시 묻지 않음).
     */
    static final String ANCHOR_MISSING_REASON = "069500 D 봉 없음(휴장 또는 지연)";
    /** 신호 주문(매수·매도)의 근거 이름. */
    static final String RULE_SIGNAL = "K7";
    /** 선정한 날의 남는 현금 153130 주문. */
    static final String RULE_PARK_SELECTION = "K7-park";
    /** 그 밖의 날 남는 현금 153130 주문 — 선정한 날 계획이 먼저 취소합니다. */
    static final String RULE_PARK_DAILY = "park_cash";
    /** 수급 창의 앞쪽 거래일 수(D 포함 20). */
    private static final int WINDOW_BACK = KrRules.FLOW_DAYS - 1;

    /**
     * 그 세션의 U를 읽을 수 없음 — D보다 이른 기준일의 {@code kr_paper_universe}가 없거나 읽을 수 있는 종목이 없음(짐작한 U로 돌지 않음). 결정
     * 게이트 ③의 미달입니다({@link KrDecisionGates#flows} — 수집기가 다음 주기에 U를 만들면 통과, 기한이 지나면 그 세션 NO_TRADE).
     */
    static final class InputUnavailable extends IllegalStateException {

        InputUnavailable(String message) {
            super(message);
        }
    }

    /**
     * 한국 규칙 계좌가 결정에서 읽는 {@code kr.*} 키(장부가 그 계좌 체결·스탑에 읽는 키는 {@link #LEDGER_KEYS}) — 설정 키 표의 '규칙 계좌 영향'
     * 표시({@code affectsRules})가 이 둘의 합과 같아야 합니다({@code KrRuleBookServiceTest}).
     */
    static final List<String> DECISION_KEYS = List.of("kr.rulesMaxNames", "kr.rules.weighting", "kr.rules.minStreakDays",
            "kr.rules.debtRatioMaxPct", "kr.rules.reselection", "kr.rules.parkCashThresholdPct", "kr.maxWeightStockPct",
            "kr.minOrderNotional", "kr.cashLikeTickers", "kr.slippageBp", "kr.commissionBp", "kr.tax.kospi.sttBp",
            "kr.tax.kospi.ruralBp", "kr.tax.etfBp");
    /** 한국 장부가 규칙 계좌 체결·스탑·재진입 금지에 읽는 {@code kr.*} 키(C2·C3 — {@link PaperSettings}). */
    static final List<String> LEDGER_KEYS = List.of("kr.slippageBp", "kr.commissionBp", "kr.tax.kospi.sttBp",
            "kr.tax.kospi.ruralBp", "kr.tax.kosdaq.sttBp", "kr.tax.etfBp", "kr.tax.effectiveFrom", "kr.trailingStopPct",
            "kr.lockoutTradingDays", "kr.cashLikeTickers");

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperLedgerService ledger;
    private final ObjectMapper mapper;
    private final Clock clock;

    KrRuleBookService(PaperStore store, StoreReader reader, PaperMarketData marketData, PaperLedgerService ledger,
                      ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.ledger = ledger;
        this.mapper = mapper;
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    // ------------------------------------------------------------------ 설정(e6)
    /**
     * 그 실행의 설정 판에서 읽은 한국 규칙 계좌 값.
     *
     * @param buyCostBp       매수 현금 어림의 비용 요율(수수료 + 슬리피지, bp)
     * @param stockSellCostBp 주식 매도 현금 어림의 비용 요율(수수료 + 슬리피지 + 코스피 거래세·농특세 — U는 코스피뿐)
     * @param etfSellCostBp   ETF(153130) 매도 현금 어림의 비용 요율
     * @param fallbacks       기본값으로 읽은 실제 키 이름
     */
    record Settings(KrRules.Params params, double minOrderNotional, Set<String> cashLike, double slippageBp,
                    double commissionBp, double buyCostBp, double stockSellCostBp, double etfSellCostBp,
                    int lockoutTradingDays, double trailingStopPct, List<String> fallbacks) {

        Settings {
            cashLike = Set.copyOf(cashLike);
            fallbacks = List.copyOf(fallbacks);
        }

        static Settings from(MarketRun run) {
            JsonNode body = run.settingsBody();
            JsonNode kr = body == null ? null : PaperSettings.scoped(body, run.settingsPrefix());
            JsonNode rules = Json.child(kr, "rules");
            List<String> fallbacks = new ArrayList<>();
            int maxNames = (int) number(kr, "rulesMaxNames", PaperSettingsService.KR_DEFAULT_RULES_MAX_NAMES,
                    v -> v >= 1 && v <= 50 && v == Math.rint(v), fallbacks, "kr.rulesMaxNames");
            KrRules.Weighting weighting = choice(rules, "weighting", KrRules.Weighting.class, KrRules.Weighting.EQUAL,
                    fallbacks, "kr.rules.weighting");
            int minStreak = (int) number(rules, "minStreakDays", 0, v -> v >= 0 && v <= KrRules.FLOW_DAYS && v == Math.rint(v),
                    fallbacks, "kr.rules.minStreakDays");
            double debtMax = number(rules, "debtRatioMaxPct", PaperSettingsService.KR_DEFAULT_DEBT_RATIO_MAX_PCT,
                    v -> v >= 0 && v <= 1_000, fallbacks, "kr.rules.debtRatioMaxPct");
            KrReselection.Mode mode = choice(rules, "reselection", KrReselection.Mode.class,
                    KrReselection.Mode.MONTHLY_FIRST, fallbacks, "kr.rules.reselection");
            double stockCap = number(kr, "maxWeightStockPct", 10, v -> v >= 1 && v <= 100, fallbacks,
                    "kr.maxWeightStockPct");
            double minOrder = number(kr, "minOrderNotional", PaperSettingsService.KR_DEFAULT_MIN_ORDER_NOTIONAL,
                    v -> v >= 0 && v <= 100_000_000, fallbacks, "kr.minOrderNotional");
            PaperSettings ledgerSettings = run.settings();
            fallbacks.addAll(ledgerSettings.rules().fallbacks());
            fallbacks.addAll(ledgerSettings.fallbacks().stream().filter(key -> key.startsWith(run.settingsPrefix()))
                    .toList());
            PaperSettings.CostRates rates = ledgerSettings.costRates();
            double commission = rates == null ? PaperSettingsService.KR_DEFAULT_COMMISSION_BP : rates.commissionBp();
            double kospiTax = rates == null ? 0 : rates.tax().kospiSttBp().add(rates.tax().kospiRuralBp()).doubleValue();
            double etfTax = rates == null ? 0 : rates.tax().etfBp().doubleValue();
            if (rates != null) {
                fallbacks.addAll(rates.fallbacks());
            }
            double slippage = ledgerSettings.slippageBp();
            KrRules.Params params = new KrRules.Params(maxNames, weighting, minStreak, debtMax, stockCap,
                    ledgerSettings.rules().parkCashThresholdPct(), mode);
            return new Settings(params, minOrder, new LinkedHashSet<>(ledgerSettings.cashLikeTickers()), slippage,
                    commission, slippage + commission, slippage + commission + kospiTax, slippage + commission + etfTax,
                    ledgerSettings.lockoutTradingDays(), ledgerSettings.trailingStopPct(),
                    new ArrayList<>(new LinkedHashSet<>(fallbacks)));
        }

        boolean cashLike(String code) {
            return KrRules.PARKING_CODE.equals(code) || cashLike.contains(code);
        }

        Map<String, Object> view(Integer settingsVersion) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("settingsVersion", settingsVersion);
            out.put("rulesMaxNames", params.maxNames());
            out.put("weighting", params.weighting().name());
            out.put("minStreakDays", params.minStreakDays());
            out.put("debtRatioMaxPct", params.debtRatioMaxPct());
            out.put("reselection", params.reselection().name());
            out.put("parkCashThresholdPct", params.parkCashThresholdPct());
            out.put("maxWeightStockPct", params.maxWeightStockPct());
            out.put("minOrderNotional", minOrderNotional);
            out.put("cashLikeTickers", new ArrayList<>(new TreeSet<>(cashLike)));
            out.put("slippageBp", slippageBp);
            out.put("commissionBp", commissionBp);
            out.put("stockSellCostBp", stockSellCostBp);
            out.put("lockoutTradingDays", lockoutTradingDays);
            out.put("trailingStopPct", trailingStopPct);
            out.put("cashBufferPct", KrRules.CASH_BUFFER_PCT);
            out.put("fallbacks", fallbacks);
            return out;
        }

        private static double number(JsonNode node, String key, double fallback,
                                     java.util.function.DoublePredicate valid, List<String> fallbacks, String name) {
            Double value = Json.asDouble(node, key);
            if (value == null || !Double.isFinite(value) || !valid.test(value)) {
                fallbacks.add(name);
                return fallback;
            }
            return value;
        }

        private static <E extends Enum<E>> E choice(JsonNode node, String key, Class<E> type, E fallback,
                                                    List<String> fallbacks, String name) {
            String text = Json.asText(node, key);
            try {
                return Enum.valueOf(type, text == null ? "" : text.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                fallbacks.add(name);
                return fallback;
            }
        }
    }

    // ------------------------------------------------------------------ 판정
    /** 이 계좌의 그 세션 정기 결정(REBALANCE 먼저, 없으면 SCHEDULED). */
    Optional<Decision> decisionOn(LocalDate d) {
        return store.decisionFor(PaperBooks.KR_RULES, d, RuleBookService.REBALANCE)
                .or(() -> store.decisionFor(PaperBooks.KR_RULES, d, RuleBookService.SCHEDULED));
    }

    /**
     * 그 세션에 정기 결정을 내지 않는 사유 — 계좌 없음·시작 전·출발일 이하(출발 INITIAL이 그날 결정)·이미 결정함. 낼 차례면 null(일시정지도 낼
     * 차례 — {@code SKIPPED} 행을 남김, 미국 규칙 책과 같음).
     */
    String skipReason(LocalDate d) {
        Optional<Book> book = store.book(PaperBooks.KR_RULES);
        if (book.isEmpty()) {
            return "한국 규칙 계좌 없음";
        }
        if (PaperBooks.NOT_STARTED.equals(book.get().status())) {
            return "시작 전 — 결정을 내지 않습니다";
        }
        LocalDate startedOn = book.get().startedOn();
        if (startedOn == null || !d.isAfter(startedOn)) {
            return "출발일(" + startedOn + ") 이하 — 출발 결정(INITIAL)이 그날 결정입니다";
        }
        Optional<Decision> existing = decisionOn(d);
        return existing.map(decision -> "이미 결정함(" + decision.kind() + " " + decision.status() + ")").orElse(null);
    }

    /** 그 세션 정기 결정이 남았나({@link #skipReason}이 null). */
    boolean due(LocalDate d) {
        return skipReason(d) == null;
    }

    /**
     * 그 세션의 선정 — 이 계좌의 매수 결정(상태 OK인 REBALANCE·INITIAL, 출발일 이후)을 넘겨 {@link KrReselection#selectionOn}. 선정하면
     * 그 주기(r)와 기준일 D, 아니면 empty.
     */
    Optional<KrReselection.Cycle> selectionOn(MarketRun run, LocalDate d, Settings settings) {
        LocalDate startedOn = store.book(PaperBooks.KR_RULES).map(Book::startedOn).orElse(null);
        List<LocalDate> buys = store.decisionDates(PaperBooks.KR_RULES, BUY_KINDS, RuleBookService.STATUS_OK, startedOn);
        return KrReselection.selectionOn(run.calendar(), settings.params().reselection(), d, buys);
    }

    // ------------------------------------------------------------------ 정기 결정
    /**
     * 그 세션의 정기 결정(클래스 설명). 이미 있으면 그대로 돌려줍니다. 입력 읽기·선정 계산은 장부 잠금 밖에서, 주문 계획·결정 행·주문은 장부 잠금
     * 안의 한 트랜잭션으로 씁니다.
     *
     * @param quotes 그 실행이 읽은 관측치(거래정지·체결할 수 있는 종목 판정 — 결정 작업의 한 번 읽기). 없으면 그 판정 없이
     * @throws IllegalStateException 계좌가 없거나 시작 전, 설정 행 없음, U 저장본 없음 등 입력 오류(결정 작업이 그 계좌 오류로 셈)
     */
    Decision decide(MarketRun run, LocalDate d, boolean pricesFinal, Optional<Quotes> quotes) {
        return decide(run, d, pricesFinal, quotes, null, null);
    }

    /**
     * 결정 작업의 정기 결정 — 자료 게이트가 본 그 읽기({@link KrDecisionGates.Inputs#rules} — 게이트 ③과 같은 U·수급, 결정 e5)로 정하고 판정
     * ({@code gates} — ①~⑥)을 결정 행 응답 {@code gates}에 남깁니다.
     *
     * @param read  그 실행이 게이트 ③ 때 읽은 입력(같은 세션)
     * @param gates 그 결정의 자료 게이트 판정(사람이 읽을 모양)
     */
    Decision decide(MarketRun run, LocalDate d, boolean pricesFinal, KrDecisionGates.Inputs read,
                    List<Map<String, Object>> gates) {
        if (read.rules() == null || !d.equals(read.rules().input().session())) {
            throw new IllegalStateException("한국 규칙 계좌 결정의 입력이 게이트 판정과 함께 넘어오지 않았습니다(" + d + ")");
        }
        return decide(run, d, pricesFinal, read.quotes(), read.rules(), gates);
    }

    private Decision decide(MarketRun run, LocalDate d, boolean pricesFinal, Optional<Quotes> quotes, Read given,
                            List<Map<String, Object>> gates) {
        Optional<Decision> existing = decisionOn(d);
        if (existing.isPresent()) {
            return existing.get();
        }
        String skip = skipReason(d);
        if (skip != null) {
            throw new IllegalStateException("한국 규칙 계좌 결정을 낼 차례가 아닙니다: " + skip);
        }
        Instant started = clock.instant();
        int version = settingsVersion(run);
        Settings settings = Settings.from(run);
        Optional<KrReselection.Cycle> cycle = selectionOn(run, d, settings);
        String kind = cycle.isPresent() ? RuleBookService.REBALANCE : RuleBookService.SCHEDULED;
        Book book = store.book(PaperBooks.KR_RULES).orElseThrow();
        if (PaperBooks.PAUSED.equals(book.status())) {
            return writeSkipped(run, d, kind, version, cycle.orElse(null), pricesFinal, started);
        }
        Set<String> holdings = holdingCodes(settings);
        Read read = given != null ? given : read(run, d, started, quotes, holdings);
        KrRules.Selection selection = KrRules.select(run.calendar(), read.input(), settings.params());
        boolean selectionDay = cycle.isPresent();
        List<KrRules.HoldingCheck> checks = KrRules.holdingChecks(run.calendar(), d, holdings, read.input().flows(),
                selectionDay ? selection.candidateCodes() : null, settings.cashLike());

        return ledger.exclusively(() -> store.atomically(() -> {
            Optional<Decision> raced = decisionOn(d);
            if (raced.isPresent()) {
                return raced.get();
            }
            Book current = store.book(PaperBooks.KR_RULES).orElseThrow();
            if (PaperBooks.NOT_STARTED.equals(current.status())) {
                throw new IllegalStateException("한국 규칙 계좌가 결정을 준비하는 사이에 초기화돼 시작 전입니다 — 결정을 내지 않았습니다");
            }
            if (selectionDay) {
                cancelDailyParking();
            }
            View view = view(PaperBooks.KR_RULES);
            Draft draft = plan(kind, selectionDay, selection, checks, view, settings, read.tradable());
            boolean selected = selectionDay;
            String status = selected || !draft.orders.isEmpty() ? RuleBookService.STATUS_OK : RuleBookService.STATUS_NO_TRADE;
            Map<String, Object> response = response(d, kind, cycle.orElse(null), read, selection, checks, view, draft,
                    settings, version, gates == null ? null : Map.of("gates", gates));
            Decision decision = new Decision(0, PaperBooks.KR_RULES, d, kind, null, status, null, null, version,
                    selected ? d : null, selected ? round4(selection.stockWeightPct()) : null, null, null, null,
                    mapper.valueToTree(response), null, null, null, pricesFinal, latency(started), 0);
            long id = store.insertDecisionIfAbsent(decision).orElseThrow(() -> new IllegalStateException(
                    PaperBooks.KR_RULES + "에 " + d + " " + kind + " 결정이 이미 있습니다"));
            LocalDate expires = run.calendar().addTradingDays(d, RuleBookService.ORDER_EXPIRY_TRADING_DAYS);
            for (PlannedOrder order : draft.orders) {
                store.insertOrder(order(order, id, d, expires));
            }
            log.info("한국 규칙 계좌 결정 {} {}: {} — {}", d, kind, status, response.get("summary"));
            return store.decision(id).orElseThrow();
        }));
    }

    /**
     * 기한이 지나 결정하지 않은 세션의 행(결정 작업의 기한 뒤 갈고리 — §4-9 'D0 구현에서 정한 것'). 그날이 선정할 날이었으면 REBALANCE, 아니면
     * SCHEDULED 종류로 {@code NO_TRADE}·주문 없음 — 따라잡기(K33)는 OK만 세므로 다음 KR 결정일에 그날 자료로 다시 선정합니다. 저장된 사실이라
     * 재기동해도 다시 쓰지 않습니다(이미 있으면 그 행).
     */
    Decision pastDeadline(MarketRun run, LocalDate d, Instant deadline) {
        return pastDeadline(run, d, deadline, null);
    }

    /**
     * {@link #pastDeadline(MarketRun, LocalDate, Instant)}에 그 순간의 자료 게이트 판정을 더한 것 — 응답 {@code gates}·{@code waitedFor}(미달
     * 게이트)에 남기고, ⑤(069500 D 봉)가 미달이면 사유를 {@value #ANCHOR_MISSING_REASON}로 둡니다(명세 §9 'D1 — 세션 자료 다시 묻기와 게이트 ⑤',
     * 결정 e4 — 늦게 지정된 휴장일과 토스 지연을 가르는 척하지 않음). 그 밖에는 {@value #PAST_DEADLINE_REASON}.
     *
     * @param gates 기한 뒤 첫 실행이 본 게이트(①은 이 계좌, 판정하지 못했으면 null)
     */
    Decision pastDeadline(MarketRun run, LocalDate d, Instant deadline, List<KrDecisionGates.Gate> gates) {
        Optional<Decision> existing = decisionOn(d);
        if (existing.isPresent()) {
            return existing.get();
        }
        int version = settingsVersion(run);
        Settings settings = Settings.from(run);
        Optional<KrReselection.Cycle> cycle = selectionOn(run, d, settings);
        String kind = cycle.isPresent() ? RuleBookService.REBALANCE : RuleBookService.SCHEDULED;
        boolean anchorMissing = KrDecisionGates.anchorMissing(gates);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("summary", "결정 기한(" + Kst.stamp(deadline) + ")이 지나 " + d + " 세션은 결정하지 않습니다(NO_TRADE)"
                + (anchorMissing ? " — " + ANCHOR_MISSING_REASON : "")
                + (cycle.isPresent() ? " — 재선정은 다음 KR 결정일에 그날 자료로(K33)" : ""));
        response.put("book", PaperBooks.KR_RULES);
        response.put("kind", kind);
        response.put("asOfTradingDate", d.toString());
        response.put("noTradeReason", anchorMissing ? ANCHOR_MISSING_REASON : PAST_DEADLINE_REASON);
        response.put("pastDeadline", true);
        response.put("deadlineKst", Kst.stamp(deadline));
        response.put("gates", gates == null ? null : gates.stream().map(KrDecisionGates.Gate::view).toList());
        response.put("waitedFor", gates == null ? null : KrDecisionGates.blocking(gates));
        response.put("selectionDay", cycle.isPresent());
        response.put("cycleDate", cycle.map(c -> c.cycleDate().toString()).orElse(null));
        response.put("orders", List.of());
        response.put("settings", settings.view(version));
        Decision decision = new Decision(0, PaperBooks.KR_RULES, d, kind, null, RuleBookService.STATUS_NO_TRADE, null,
                null, version, null, null, null, null, null, mapper.valueToTree(response), null, null, null, false, null, 0);
        return store.insertDecisionIfAbsent(decision).flatMap(store::decision)
                .orElseGet(() -> decisionOn(d).orElseThrow());
    }

    private Decision writeSkipped(MarketRun run, LocalDate d, String kind, int version, KrReselection.Cycle cycle,
                                  boolean pricesFinal, Instant started) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("summary", "일시정지 중 — 주문을 내지 않습니다");
        response.put("book", PaperBooks.KR_RULES);
        response.put("kind", kind);
        response.put("asOfTradingDate", d.toString());
        response.put("selectionDay", cycle != null);
        response.put("cycleDate", cycle == null ? null : cycle.cycleDate().toString());
        response.put("orders", List.of());
        response.put("notes", List.of("일시정지 중이라 입력을 읽지 않고 주문을 내지 않습니다(재개한 뒤의 결정부터 다시 냅니다 — 선정할 날이었으면 "
                + "재개 뒤 첫 결정일에 따라잡기)"));
        Decision decision = new Decision(0, PaperBooks.KR_RULES, d, kind, null, RuleBookService.STATUS_SKIPPED, null,
                null, version, null, null, null, null, null, mapper.valueToTree(response), null, null, null, pricesFinal,
                latency(started), 0);
        return store.insertDecisionIfAbsent(decision).flatMap(store::decision)
                .orElseGet(() -> decisionOn(d).orElseThrow());
    }

    // ------------------------------------------------------------------ 출발(e8)
    /**
     * 한국 출발({@link KrStartPipeline})의 규칙 계좌 몫 — S의 재선정과 같은 계산(입력 동결 K26, {@link KrReselection#initial}: cycleDate = r(S),
     * selectionAsOf = S)으로 INITIAL 결정과 S+1 시가 주문을 계획합니다(쓰기는 파이프라인이 네 계좌 함께 한 트랜잭션으로). 입력은 파이프라인이 게이트 ③과
     * 함께 읽은 것({@link KrDecisionGates.Checked} — 결정 e5)이라 U 없음은 여기까지 오지 않고 게이트에서 기다립니다. 계획 중 오류(계좌 상태 없음 등)는
     * 계획 실패({@link KrStartPipeline.Plan#failed}) — 어느 계좌에도 쓰지 않고 그 세션 출발을 미룹니다.
     */
    KrStartPipeline.Leg startLeg(PaperConfig config) {
        return new KrStartPipeline.Leg() {
            @Override
            public String book() {
                return PaperBooks.KR_RULES;
            }

            @Override
            public KrStartPipeline.Plan plan(MarketRun run, LocalDate session, Instant deadline,
                                             KrDecisionGates.Checked gates) {
                try {
                    return startPlan(run, session, gates, config);
                } catch (RuntimeException e) {
                    log.warn("한국 규칙 계좌 출발 계획 실패({}): {}", session, e.toString());
                    return KrStartPipeline.Plan.failed(PaperBooks.KR_RULES, "규칙 계좌 출발 계획 실패 — "
                            + e.getClass().getSimpleName() + " " + e.getMessage());
                }
            }
        };
    }

    private KrStartPipeline.Plan startPlan(MarketRun run, LocalDate session, KrDecisionGates.Checked gates,
                                           PaperConfig config) {
        Instant started = clock.instant();
        int version = settingsVersion(run);
        Settings settings = Settings.from(run);
        KrReselection.Cycle cycle = KrReselection.initial(run.calendar(), settings.params().reselection(), session);
        Set<String> holdings = holdingCodes(settings);
        // 게이트 ③이 본 그 읽기(K26 동결과 같은 값 — 결정 e5). 게이트가 통과했으면 늘 있음.
        Read read = gates.inputs().rules();
        if (read == null || !session.equals(read.input().session())) {
            throw new IllegalStateException("출발 결정의 규칙 계좌 입력이 게이트 판정과 함께 넘어오지 않았습니다(" + session + ")");
        }
        KrRules.Selection selection = KrRules.select(run.calendar(), read.input(), settings.params());
        List<KrRules.HoldingCheck> checks = KrRules.holdingChecks(run.calendar(), session, holdings,
                read.input().flows(), selection.candidateCodes(), settings.cashLike());
        View view = view(PaperBooks.KR_RULES);
        Draft draft = plan(RuleBookService.INITIAL, true, selection, checks, view, settings, read.tradable());
        Map<String, Object> start = new LinkedHashMap<>();
        start.put("configuredStartDate", String.valueOf(config.krStartDate()));
        start.put("postponed", !session.equals(config.krStartDate()));
        start.put("gates", gates.views());
        Map<String, Object> response = response(session, RuleBookService.INITIAL, cycle, read, selection, checks, view,
                draft, settings, version, start);
        Decision decision = new Decision(0, PaperBooks.KR_RULES, session, RuleBookService.INITIAL, null,
                RuleBookService.STATUS_OK, null, null, version, session, round4(selection.stockWeightPct()), null, null,
                null, mapper.valueToTree(response), null, null, null, false, latency(started), 0);
        List<Order> orders = new ArrayList<>();
        for (PlannedOrder order : draft.orders) {
            orders.add(order(order, null, session, null));
        }
        return KrStartPipeline.Plan.of(PaperBooks.KR_RULES, decision, orders);
    }

    // ------------------------------------------------------------------ 입력 읽기(K26)
    /**
     * 한 결정의 입력(그 실행에서 한 번 읽은 것 — 결정 행 동결과 같은 값).
     *
     * @param readAt        읽은 순간(이 뒤에 받은 기록은 쓰지 않음)
     * @param universeRule  U 규칙 판(수집기 {@code KR_UNIVERSE_RULE} — 행마다 같아야 함, 다르면 쉼표로)
     * @param stamps        코드 → D 기록의 판(토스 {@code updatedAt})·받은 시각·세부 칸 유무
     * @param excluded      빼고 읽은 수급 기록 수(사유 → 수)
     * @param tradable      그 실행 관측치에 봉이 있는 코드(관측치가 없으면 null — 판정하지 않음)
     */
    record Read(Instant readAt, KrRules.Input input, String universeRule, LocalDate windowStart,
                Map<String, Stamp> stamps, Snapshot dart, Snapshot flowsStatus, List<Lockout> lockouts,
                Map<String, Integer> excluded, Set<String> tradable, List<String> notes) {
    }

    /** D 기록 한 건의 판 — 토스 {@code updatedAt}(원문)·우리가 받은 시각·기관 세부 칸이 있나. */
    record Stamp(String updatedAt, String fetchedAt, boolean detail) {
    }

    /**
     * 그 세션의 입력 읽기(K26) — 이 계좌 보유(현금성 빼고)를 그 실행의 설정 판으로 정해 {@link #read}. 결정 게이트 ③({@link KrDecisionGates})과 그
     * 결정이 같은 읽기를 씁니다(D1c, 결정 e5).
     *
     * @throws InputUnavailable D보다 이른 기준일의 U가 없음·읽을 수 있는 종목이 없음
     */
    Read readInputs(MarketRun run, LocalDate session, Instant readAt, Optional<Quotes> quotes) {
        return read(run, session, readAt, quotes, holdingCodes(Settings.from(run)));
    }

    Read read(MarketRun run, LocalDate session, Instant readAt, Optional<Quotes> quotes, Collection<String> holdings) {
        TradingCalendar calendar = run.calendar();
        List<String> notes = new ArrayList<>();
        PaperMarketData.KrUniverseRows universe = reader.quietly(() -> marketData.krUniverseBefore(session))
                .orElseThrow(() -> new InputUnavailable("한국 유니버스 저장본(kr_paper_universe)에 " + session
                        + "보다 이른 기준일이 없습니다 — 수집기 kr_paper_universe가 먼저 돌아야 합니다(짐작한 U로 돌지 않음)"));
        List<KrRules.Member> members = new ArrayList<>();
        Set<String> rules = new TreeSet<>();
        for (JsonNode row : universe.rows()) {
            String code = Json.asText(row, "code");
            Double rank = Json.asDouble(row, "rank");
            if (code == null || code.isBlank() || rank == null || rank != Math.rint(rank)) {
                notes.add("U 행 하나를 읽지 못함(코드·순위 없음): " + row);
                continue;
            }
            String rule = Json.asText(row, "rule");
            if (rule != null) {
                rules.add(rule);
            }
            members.add(new KrRules.Member(code.strip(), Json.asText(row, "name"), rank.intValue(),
                    decimal(row.get("marketCap")), wholeNumber(row.get("listedShares"))));
        }
        members.sort(java.util.Comparator.comparingInt(KrRules.Member::rank).thenComparing(KrRules.Member::code));
        if (members.isEmpty()) {
            throw new InputUnavailable("한국 유니버스 기준일 " + universe.baseDate() + "에 읽을 수 있는 종목이 없습니다");
        }
        LocalDate previous = calendar.previousTradingDay(session);
        if (!universe.baseDate().equals(previous)) {
            notes.add("U 기준일 " + universe.baseDate() + "이 직전 KR 거래일 " + previous + "이 아님 — 저장된 가장 최근 U로 판정");
        }

        LocalDate windowStart = session;
        for (int i = 0; i < WINDOW_BACK; i++) {
            windowStart = calendar.previousTradingDay(windowStart);
        }
        Set<String> codes = new LinkedHashSet<>();
        members.forEach(m -> codes.add(m.code()));
        codes.addAll(holdings);
        LocalDate from = windowStart;
        Map<String, List<JsonNode>> rows = reader.quietly(() -> marketData.krFlows(codes, from));
        Map<String, List<KrRules.FlowDay>> flows = new HashMap<>();
        Map<String, Stamp> stamps = new TreeMap<>();
        Map<String, Integer> excluded = new LinkedHashMap<>();
        for (String code : codes) {
            List<KrRules.FlowDay> days = new ArrayList<>();
            for (JsonNode row : rows.getOrDefault(code, List.of())) {
                LocalDate date = Json.parseDate(Json.asText(row, "obsDate"));
                if (date == null || date.isBefore(from)) {
                    continue;
                }
                if (date.isAfter(session)) {
                    excluded.merge("afterSession", 1, Integer::sum);       // D 뒤 날짜 — 결정 때 없던 세션
                    continue;
                }
                Instant fetched = instant(Json.asText(row, "fetchedAt"));
                if (fetched == null) {
                    excluded.merge("unknownFetchedAt", 1, Integer::sum);   // 받은 시각을 모름 — 결정 전에 있던 값인지 모름
                    continue;
                }
                if (fetched.isAfter(readAt)) {
                    excluded.merge("fetchedAfterRead", 1, Integer::sum);   // 결정 시각 뒤에 받은 판
                    continue;
                }
                JsonNode investors = Json.child(row, "investors");
                days.add(new KrRules.FlowDay(date, net(investors, "foreigner"), net(investors, "institution"),
                        Json.asText(row, "updatedAt")));
                if (date.equals(session)) {
                    JsonNode breakdown = Json.child(row, "breakdown");
                    stamps.put(code, new Stamp(Json.asText(row, "updatedAt"), Json.asText(row, "fetchedAt"),
                            breakdown != null && breakdown.isObject() && !breakdown.isEmpty()));
                }
            }
            if (!days.isEmpty()) {
                flows.put(code, days);
            }
        }

        Snapshot dart = reader.quietly(marketData::krDartFundamentals).orElse(null);
        JsonNode companies = dart == null ? null : Json.child(dart.payload(), "companies");
        if (companies == null || !companies.isObject()) {
            notes.add("DART 주요계정 저장본(kr.dart_fundamentals)이 없음 — U 모든 종목이 '자료 없음(DART 없음)'");
        }
        Map<String, KrRules.Financials> financials = new HashMap<>();
        for (KrRules.Member member : members) {
            JsonNode company = companies == null ? null : companies.get(member.code());
            if (company != null && company.isObject()) {
                financials.put(member.code(), KrRules.Financials.fromAccounts(Json.asText(company, "bsnsYear"),
                        Json.asText(company, "rceptNo"), accounts(Json.child(company, "accounts"))));
            }
        }
        Snapshot status = reader.quietly(marketData::krFlowsStatus).orElse(null);

        LocalDate fillDay = calendar.nextTradingDay(session);
        List<Lockout> lockouts = new ArrayList<>();
        Set<String> lockedOut = new TreeSet<>();
        for (Lockout lockout : store.lockouts(PaperBooks.KR_RULES)) {
            if (TrailingStop.lockedOut(lockout.untilTradingDate(), fillDay)) {
                lockouts.add(lockout);
                lockedOut.add(lockout.ticker());
            }
        }
        Set<String> suspended = new TreeSet<>();
        Set<String> tradable = null;
        if (quotes.isPresent()) {
            tradable = new TreeSet<>(quotes.get().bars().keySet());
            for (Bar bar : quotes.get().bars().values()) {
                KrQuotes.Quote quote = bar.kr();
                if (quote == null) {
                    continue;
                }
                boolean halted = Boolean.TRUE.equals(quote.krxTradingSuspended())
                        || quote.day(session).map(day -> day.volume() != null && day.volume() == 0).orElse(false);
                if (halted) {
                    suspended.add(bar.ticker());
                }
            }
        } else {
            notes.add("관측치 저장본(paper.kr.quotes)을 읽지 못함 — 거래정지·체결할 수 있는 종목을 판정하지 않음");
        }
        KrRules.Input input = new KrRules.Input(session, universe.baseDate(), members, flows, financials, lockedOut,
                suspended);
        return new Read(readAt, input, rules.isEmpty() ? null : String.join(",", rules), windowStart, stamps, dart,
                status, lockouts, excluded, tradable, notes);
    }

    /** 이 계좌 보유 중 신호를 볼 종목(현금성·153130 빼고). */
    private Set<String> holdingCodes(Settings settings) {
        Set<String> out = new TreeSet<>();
        for (Position position : store.positions(PaperBooks.KR_RULES)) {
            if (!settings.cashLike(position.ticker())) {
                out.add(position.ticker());
            }
        }
        return out;
    }

    private static Long net(JsonNode investors, String who) {
        JsonNode node = Json.child(Json.child(investors, who), "net");
        if (node == null || !node.isNumber()) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        if (value.stripTrailingZeros().scale() > 0) {
            return null;
        }
        try {
            return value.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
    }

    /** DART 계정표 — {@code {계정명: {current, previous}}}(화면 레이더 재무와 같은 읽기). */
    static Map<String, KrFundamentals.Amounts> accounts(JsonNode node) {
        Map<String, KrFundamentals.Amounts> out = new LinkedHashMap<>();
        if (node == null || !node.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> entry : node.properties()) {
            out.put(entry.getKey(), new KrFundamentals.Amounts(Json.asDouble(entry.getValue(), "current"),
                    Json.asDouble(entry.getValue(), "previous")));
        }
        return out;
    }

    // ------------------------------------------------------------------ 장부 보기·계획
    /**
     * 결정이 보는 장부(원) — 마지막 평가 가격(없으면 평단)의 평가. pendingSells = 대기 매도 티커 → 파는 비율(전량 1), pendingBuys = 대기 매수
     * 티커 → 어림 금액(목표 비중 × 지금 순자산, 수량 주문은 수량 × 가격).
     */
    private record View(BigDecimal cash, BigDecimal nav, Map<String, Integer> qty, Map<String, BigDecimal> price,
                        Map<String, Double> pendingSells, Map<String, BigDecimal> pendingBuys) {

        BigDecimal value(String ticker) {
            Integer q = qty.get(ticker);
            return q == null ? BigDecimal.ZERO : price.get(ticker).multiply(BigDecimal.valueOf(q));
        }

        double weight(String ticker) {
            return nav.signum() > 0 ? value(ticker).divide(nav, MathContext.DECIMAL64).doubleValue() * 100.0 : 0;
        }

        BigDecimal equity() {
            BigDecimal out = BigDecimal.ZERO;
            for (String ticker : qty.keySet()) {
                out = out.add(value(ticker));
            }
            return out;
        }
    }

    private View view(String code) {
        BookState state = store.state(code).orElseThrow(() -> new IllegalStateException(
                "한국 규칙 계좌 상태가 없습니다 — 한국 초기화를 다시 누르세요"));
        Map<String, Integer> qty = new TreeMap<>();
        Map<String, BigDecimal> price = new TreeMap<>();
        BigDecimal cash = BigDecimal.valueOf(state.cash());
        BigDecimal nav = cash;
        for (Position p : store.positions(code)) {
            BigDecimal last = BigDecimal.valueOf(p.lastPrice() != null ? p.lastPrice() : p.avgCost());
            qty.put(p.ticker(), p.qty());
            price.put(p.ticker(), last);
            nav = nav.add(last.multiply(BigDecimal.valueOf(p.qty())));
        }
        Map<String, Double> sells = new TreeMap<>();
        Map<String, BigDecimal> buys = new TreeMap<>();
        for (Order order : store.ordersByStatus(code, PaperBooks.ORDER_PENDING)) {
            if (PaperBooks.SELL.equals(order.side())) {
                double fraction = order.sellFraction() == null ? 1.0 : Math.max(0, Math.min(1, order.sellFraction()));
                sells.merge(order.ticker(), fraction, (a, b) -> Math.min(1.0, a + b));
            } else {
                BigDecimal amount = BigDecimal.ZERO;
                if (order.qty() != null && price.containsKey(order.ticker())) {
                    amount = price.get(order.ticker()).multiply(BigDecimal.valueOf(Math.max(0, order.qty())));
                } else if (order.targetWeightPct() != null && Double.isFinite(order.targetWeightPct())) {
                    amount = pct(nav, Math.max(0, order.targetWeightPct()));
                }
                buys.merge(order.ticker(), amount, BigDecimal::add);
            }
        }
        return new View(cash, nav, qty, price, sells, buys);
    }

    /** 낼 주문 한 줄(저장 전). 매수 targetWeightPct = 살 금액(체결 시점 순자산 대비 %), 매도 sellFraction null = 전량. */
    record PlannedOrder(String ticker, String side, Double targetWeightPct, Double sellFraction,
                        Map<String, Object> reason, boolean parking) {
    }

    private static final class Draft {
        final List<PlannedOrder> orders = new ArrayList<>();
        final List<Map<String, Object>> skipped = new ArrayList<>();
        final List<String> notes = new ArrayList<>();

        void skip(String ticker, String reason) {
            skipped.add(RuleBookService.skip(ticker, reason));
        }
    }

    /**
     * 주문 계획(클래스 설명의 '주문') — ① 매도 신호(보유 전량) ② 선정한 날만 매수(목표 − 지금) ③ 남는 현금 153130.
     *
     * @param tradable 그 실행 관측치에 봉이 있는 코드(null이면 판정하지 않음) — 없는 종목은 체결할 수 없어 사지 않음
     */
    private Draft plan(String kind, boolean selectionDay, KrRules.Selection selection, List<KrRules.HoldingCheck> checks,
                       View view, Settings settings, Set<String> tradable) {
        Draft draft = new Draft();
        BigDecimal nav = view.nav();
        BigDecimal projected = view.cash().add(pendingCash(view, settings));

        // ① 매도 신호 — 20일 둘 다 순매도(매일) · 후보 밖(선정한 날). 매도는 보유 전량.
        for (KrRules.HoldingCheck check : checks) {
            if (!check.sell()) {
                continue;
            }
            String ticker = check.code();
            if (view.pendingSells().containsKey(ticker)) {
                draft.skip(ticker, "매도 신호 — 이미 대기 중인 매도 주문이 있어 다시 내지 않음");
                continue;
            }
            List<String> labels = check.reasons().stream().map(KrRules.SellReason::label).toList();
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("rule", RULE_SIGNAL);
            reason.put("signal", "SELL");
            reason.put("kind", kind);
            reason.put("reasons", check.reasons().stream().map(Enum::name).toList());
            reason.put("text", String.join(" · ", labels) + " — 보유 전량 매도");
            reason.put("flows", flowsView(check.flows(), null));
            reason.put("currentWeightPct", round4(view.weight(ticker)));
            draft.orders.add(new PlannedOrder(ticker, PaperBooks.SELL, null, null, reason, false));
            projected = projected.add(afterCost(view.value(ticker), -settings.stockSellCostBp()));
        }

        if (!selectionDay) {
            if (!selection.candidates().isEmpty()) {
                draft.notes.add("후보 " + selection.candidates().size() + "개는 재선정일이 아니라 사지 않습니다(K10 — 매수는 재선정일·따라잡기·"
                        + "출발에만)");
            }
            parkDaily(draft, kind, view, settings, tradable, projected);
            return draft;
        }
        if (nav.signum() <= 0) {
            draft.notes.add("순자산이 0 이하라 매수 비중을 정할 수 없습니다");
            return draft;
        }

        // ② 매수 — 선정의 매수 종목(점수 순 상위 kr.rulesMaxNames, 목표 비중)마다 모자란 만큼.
        Map<String, KrRules.Evaluation> byCode = new HashMap<>();
        selection.evaluations().forEach(e -> byCode.put(e.code(), e));
        for (KrRules.Target target : selection.targets()) {
            String ticker = target.code();
            if (view.pendingBuys().containsKey(ticker)) {
                draft.skip(ticker, "이미 대기 중인 매수 주문이 있음");
                continue;
            }
            if (view.pendingSells().containsKey(ticker)) {
                draft.skip(ticker, "대기 중인 매도 주문이 있음 — 같은 시가에 사고팔지 않음");
                continue;
            }
            if (tradable != null && !tradable.contains(ticker)) {
                draft.skip(ticker, "이번 관측치에 그 종목 봉이 없음 — 체결할 수 없어 사지 않음");
                continue;
            }
            double current = view.weight(ticker);
            double shortfall = target.weightPct() - current;
            if (!(shortfall > 0)) {
                draft.skip(ticker, String.format(Locale.ROOT, "이미 목표 비중 이상 보유(현재 %.2f%% ≥ 목표 %.2f%%)", current,
                        target.weightPct()));
                continue;
            }
            double orderWeight = round4(shortfall);
            BigDecimal amount = pct(nav, orderWeight);
            if (belowMinimum(draft, ticker, amount, settings)) {
                continue;
            }
            KrRules.Evaluation evaluation = byCode.get(ticker);
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("rule", RULE_SIGNAL);
            reason.put("signal", "BUY");
            reason.put("kind", kind);
            reason.put("text", String.format(Locale.ROOT, "점수 %.4f(순위 %d) — 20일 외국인·기관 둘 다 순매수", target.score(),
                    target.rankInPlan()));
            reason.put("score", round6(target.score()));
            reason.put("rankInPlan", target.rankInPlan());
            reason.put("universeRank", evaluation == null ? null : evaluation.member().rank());
            reason.put("flows", evaluation == null ? null : flowsView(evaluation.flows(), null));
            reason.put("targetWeightPct", round4(target.weightPct()));
            reason.put("currentWeightPct", round4(current));
            reason.put("orderWeightPct", orderWeight);
            reason.put("weighting", settings.params().weighting().name());
            draft.orders.add(new PlannedOrder(ticker, PaperBooks.BUY, orderWeight, null, reason, false));
            projected = projected.subtract(afterCost(amount, settings.buyCostBp()));
        }

        // ③ 남는 현금 — 153130에(여유 0.5%p), 모자라면 153130을 팔아 메움.
        double spare = projected.divide(nav, MathContext.DECIMAL64).doubleValue() * 100.0;
        double increment = KrRules.parkingIncrementPct(spare, true, settings.params().parkCashThresholdPct());
        String parking = KrRules.PARKING_CODE;
        double parkingWeight = view.weight(parking);
        if (increment > 0) {
            if (tradable != null && !tradable.contains(parking)) {
                draft.notes.add(parking + " 시세가 없어 남는 현금 " + String.format(Locale.ROOT, "%.2f%%", spare) + "를 현금으로 둡니다");
            } else if (view.pendingBuys().containsKey(parking) || view.pendingSells().containsKey(parking)) {
                draft.skip(parking, "남는 현금 — 이미 대기 중인 " + parking + " 주문이 있음");
            } else {
                double weight = round4(increment);
                if (!belowMinimum(draft, parking, pct(nav, weight), settings)) {
                    Map<String, Object> reason = parkingReason(RULE_PARK_SELECTION, kind, spare, parkingWeight);
                    reason.put("text", String.format(Locale.ROOT, "남는 현금 %.2f%% 중 %.2f%%를 %s에(여유 %.1f%%p)", spare,
                            weight, parking, KrRules.CASH_BUFFER_PCT));
                    reason.put("targetWeightPct", round4(parkingWeight + weight));
                    reason.put("orderWeightPct", weight);
                    draft.orders.add(new PlannedOrder(parking, PaperBooks.BUY, weight, null, reason, true));
                }
            }
        } else if (spare < 0) {
            BigDecimal available = afterCost(view.value(parking), -settings.etfSellCostBp());
            if (available.signum() <= 0) {
                draft.notes.add(String.format(Locale.ROOT, "현금이 순자산의 %.2f%%만큼 모자라는데 팔 %s가 없습니다 — 뒤쪽 매수는 체결 때 "
                        + "살 수 있는 만큼으로 줄어듭니다(cashLimited)", -spare, parking));
            } else if (view.pendingSells().containsKey(parking)) {
                draft.skip(parking, "모자란 현금 — 이미 대기 중인 매도 주문이 있음");
            } else {
                BigDecimal need = pct(nav, KrRules.CASH_BUFFER_PCT - spare);
                Double fraction = need.compareTo(available) >= 0 ? null
                        : round6(need.divide(available, MathContext.DECIMAL64).doubleValue());
                Map<String, Object> reason = parkingReason(RULE_PARK_SELECTION, kind, spare, parkingWeight);
                reason.put("text", String.format(Locale.ROOT, "종목 매수에 현금이 순자산의 %.2f%%만큼 모자라 %s %s 매도", -spare,
                        parking, fraction == null ? "전량" : String.format(Locale.ROOT, "%.1f%%", fraction * 100)));
                reason.put("sellFraction", fraction);
                draft.orders.add(new PlannedOrder(parking, PaperBooks.SELL, null, fraction, reason, true));
            }
        }
        return draft;
    }

    /** 선정하지 않은 날의 남는 현금 — 어림한 남는 현금이 기준(kr.rules.parkCashThresholdPct, 여유 이상)을 넘으면 153130 매수 한 건. */
    private static void parkDaily(Draft draft, String kind, View view, Settings settings, Set<String> tradable,
                                  BigDecimal projected) {
        BigDecimal nav = view.nav();
        if (nav.signum() <= 0) {
            return;
        }
        double threshold = settings.params().parkCashThresholdPct();
        double spare = projected.divide(nav, MathContext.DECIMAL64).doubleValue() * 100.0;
        double increment = KrRules.parkingIncrementPct(spare, false, threshold);
        if (!(increment > 0)) {
            return;
        }
        String parking = KrRules.PARKING_CODE;
        if (tradable != null && !tradable.contains(parking)) {
            draft.notes.add(parking + " 시세가 없어 남는 현금 " + String.format(Locale.ROOT, "%.2f%%", spare) + "를 현금으로 둡니다");
            return;
        }
        if (view.pendingBuys().containsKey(parking) || view.pendingSells().containsKey(parking)) {
            draft.skip(parking, "남는 현금 — 이미 대기 중인 " + parking + " 주문이 있음");
            return;
        }
        double weight = round4(increment);
        if (belowMinimum(draft, parking, pct(nav, weight), settings)) {
            return;
        }
        double parkingWeight = view.weight(parking);
        Map<String, Object> reason = parkingReason(RULE_PARK_DAILY, kind, spare, parkingWeight);
        reason.put("thresholdPct", threshold);
        String text = String.format(Locale.ROOT, "남는 현금 %.2f%%가 기준 %.1f%%를 넘어 %.2f%%를 %s에(여유 %.1f%%p) — 신호 매수가 "
                + "아닌 현금 관리", spare, threshold, weight, parking, KrRules.CASH_BUFFER_PCT);
        reason.put("text", text);
        reason.put("targetWeightPct", round4(parkingWeight + weight));
        reason.put("orderWeightPct", weight);
        draft.orders.add(new PlannedOrder(parking, PaperBooks.BUY, weight, null, reason, true));
        draft.notes.add(text);
    }

    /**
     * 대기 주문이 다음 시가에 함께 체결될 때의 현금 어림 — 대기 매도 대금(비용 뺌) − 대기 매수 금액(비용 더함). 현금성(153130)의 대기 주문은 넣지
     * 않습니다(장부가 현금성 매수를 종목 매수 뒤에 남는 현금으로만 체결 — 미국 규칙 책과 같은 까닭).
     */
    private static BigDecimal pendingCash(View view, Settings settings) {
        BigDecimal out = BigDecimal.ZERO;
        for (Map.Entry<String, Double> sell : view.pendingSells().entrySet()) {
            if (!settings.cashLike(sell.getKey())) {
                out = out.add(afterCost(view.value(sell.getKey()).multiply(BigDecimal.valueOf(sell.getValue())),
                        -settings.stockSellCostBp()));
            }
        }
        for (Map.Entry<String, BigDecimal> buy : view.pendingBuys().entrySet()) {
            if (!settings.cashLike(buy.getKey())) {
                out = out.subtract(afterCost(buy.getValue(), settings.buyCostBp()));
            }
        }
        return out;
    }

    /** 선정한 날 계획 전에 앞선 날의 대기 중인 남는 현금 주문({@value #RULE_PARK_DAILY})을 취소합니다(장부 잠금 안). */
    private void cancelDailyParking() {
        for (Order order : store.ordersByStatus(PaperBooks.KR_RULES, PaperBooks.ORDER_PENDING)) {
            if (RULE_PARK_DAILY.equals(Json.asText(order.reason(), "rule"))) {
                store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, "재선정일 계획이 남는 현금을 다시 정함");
            }
        }
    }

    private static boolean belowMinimum(Draft draft, String ticker, BigDecimal amount, Settings settings) {
        if (amount.compareTo(BigDecimal.valueOf(settings.minOrderNotional())) >= 0) {
            return false;
        }
        draft.skip(ticker, String.format(Locale.ROOT, "최소 금액 미만(%,.0f원 < %,.0f원)", amount.doubleValue(),
                settings.minOrderNotional()));
        return true;
    }

    private static Map<String, Object> parkingReason(String rule, String kind, double spare, double currentWeight) {
        Map<String, Object> reason = new LinkedHashMap<>();
        reason.put("rule", rule);
        reason.put("signal", "PARKING");
        reason.put("kind", kind);
        reason.put("parking", true);
        reason.put("spareCashPct", round4(spare));
        reason.put("bufferPct", KrRules.CASH_BUFFER_PCT);
        reason.put("currentWeightPct", round4(currentWeight));
        return reason;
    }

    private Order order(PlannedOrder order, Long decisionId, LocalDate d, LocalDate expires) {
        return new Order(0, PaperBooks.KR_RULES, decisionId, order.ticker(), order.side(), null, order.targetWeightPct(),
                order.sellFraction(), PaperBooks.NEXT_OPEN, RuleBookService.SOURCE_RULE, PaperBooks.ORDER_PENDING, null,
                mapper.valueToTree(order.reason()), d, null, expires, null);
    }

    // ------------------------------------------------------------------ 결정 기록(K26 동결)
    private Map<String, Object> response(LocalDate d, String kind, KrReselection.Cycle cycle, Read read,
                                         KrRules.Selection selection, List<KrRules.HoldingCheck> checks, View view,
                                         Draft draft, Settings settings, int version, Map<String, Object> start) {
        boolean selectionDay = cycle != null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("summary", summary(kind, cycle, selection, draft));
        out.put("book", PaperBooks.KR_RULES);
        out.put("kind", kind);
        out.put("asOfTradingDate", d.toString());
        out.put("timing", PaperBooks.NEXT_OPEN);
        out.put("selectionDay", selectionDay);
        out.put("cycleDate", selectionDay ? cycle.cycleDate().toString() : null);
        out.put("selectionAsOf", selectionDay ? cycle.selectionAsOf().toString() : null);
        out.put("catchUp", selectionDay && RuleBookService.REBALANCE.equals(kind) && cycle.catchUp());
        if (start != null) {
            out.putAll(start);
        }
        out.put("input", inputView(read, selection, checks));
        out.put("selection", selectionView(selection, selectionDay));
        out.put("holdings", checks.stream().map(check -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("code", check.code());
            row.put("qty", view.qty().get(check.code()));
            row.put("weightPct", round4(view.weight(check.code())));
            row.put("sell", check.sell());
            row.put("reasons", check.reasons().stream().map(KrRules.SellReason::label).toList());
            return row;
        }).toList());
        Map<String, Object> valuation = new LinkedHashMap<>();
        valuation.put("cash", round2(view.cash()));
        valuation.put("nav", round2(view.nav()));
        valuation.put("equityValue", round2(view.equity()));
        valuation.put("exposurePct", view.nav().signum() > 0
                ? round2(view.equity().multiply(BigDecimal.valueOf(100)).divide(view.nav(), MathContext.DECIMAL64)) : null);
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
        List<String> notes = new ArrayList<>(read.notes());
        notes.addAll(draft.notes);
        out.put("notes", notes);
        out.put("settings", settings.view(version));
        return out;
    }

    /** 입력 동결(K26) — 결정 때 읽은 그대로. */
    private Map<String, Object> inputView(Read read, KrRules.Selection selection, List<KrRules.HoldingCheck> checks) {
        KrRules.Input input = read.input();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("session", input.session().toString());
        out.put("readAtKst", Kst.stamp(read.readAt()));
        Map<String, Object> universe = new LinkedHashMap<>();
        universe.put("baseDate", input.universeDate().toString());
        universe.put("rule", read.universeRule());
        universe.put("size", input.universe().size());
        out.put("universe", universe);
        Map<String, Object> window = new LinkedHashMap<>();
        window.put("from", read.windowStart().toString());
        window.put("to", input.session().toString());
        window.put("tradingDays", KrRules.FLOW_DAYS);
        out.put("flowsWindow", window);
        out.put("flowsStatus", snapshotView(read.flowsStatus(), "session", "universeDate"));
        Map<String, Object> dart = snapshotView(read.dart(), null, null);
        if (dart != null) {
            JsonNode companies = Json.child(read.dart().payload(), "companies");
            dart.put("companies", companies == null ? 0 : companies.size());
            dart.put("receiptRule", "접수일(rceptNo 앞 8자리) ≤ 기준 세션 " + input.session() + "만");
        }
        out.put("dart", dart);
        out.put("excludedFlowRecords", read.excluded());
        out.put("lockedOut", read.lockouts().stream().map(lockout -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("code", lockout.ticker());
            row.put("until", lockout.untilTradingDate().toString());
            return row;
        }).toList());
        out.put("suspended", new ArrayList<>(new TreeSet<>(input.suspended())));
        List<Map<String, Object>> members = new ArrayList<>();
        for (KrRules.Evaluation evaluation : selection.evaluations()) {
            KrRules.Member member = evaluation.member();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("rank", member.rank());
            row.put("code", member.code());
            row.put("name", member.name());
            row.put("marketCap", member.marketCap());
            row.put("listedShares", member.listedShares());
            row.put("flows", flowsView(evaluation.flows(), read.stamps().get(member.code())));
            row.put("dart", dartView(evaluation));
            row.put("score", evaluation.score() == null ? null : round6(evaluation.score()));
            row.put("candidate", evaluation.candidate());
            row.put("reasons", evaluation.exclusions().stream().map(e -> {
                Map<String, Object> reason = new LinkedHashMap<>();
                reason.put("reason", e.reason().label());
                reason.put("sub", e.sub());
                reason.put("detail", e.detail());
                return reason;
            }).toList());
            members.add(row);
        }
        out.put("members", members);
        Set<String> universeCodes = new HashSet<>();
        input.universe().forEach(m -> universeCodes.add(m.code()));
        List<Map<String, Object>> outside = new ArrayList<>();
        for (KrRules.HoldingCheck check : checks) {
            if (!universeCodes.contains(check.code())) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("code", check.code());
                row.put("flows", flowsView(check.flows(), read.stamps().get(check.code())));
                outside.add(row);
            }
        }
        out.put("outsideUniverse", outside);
        return out;
    }

    private static Map<String, Object> selectionView(KrRules.Selection selection, boolean selectionDay) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("maxNames", selection.params().maxNames());
        out.put("weighting", selection.params().weighting().name());
        out.put("candidates", selection.candidates().stream().map(e -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("code", e.code());
            row.put("universeRank", e.member().rank());
            row.put("score", round6(e.score()));
            return row;
        }).toList());
        Map<String, Integer> counts = new LinkedHashMap<>();
        selection.exclusionCounts().forEach((reason, n) -> counts.put(reason.label(), n));
        out.put("exclusionCounts", counts);
        if (selectionDay) {
            out.put("targets", selection.targets().stream().map(t -> {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("code", t.code());
                row.put("rankInPlan", t.rankInPlan());
                row.put("score", round6(t.score()));
                row.put("weightPct", round4(t.weightPct()));
                return row;
            }).toList());
            out.put("notChosen", selection.notChosen().stream().map(KrRules.Evaluation::code).toList());
            out.put("stockWeightPct", round4(selection.stockWeightPct()));
            out.put("parkingWeightPct", round4(selection.parkingWeightPct()));
        } else {
            out.put("targets", null);
            out.put("note", "재선정일이 아님 — 후보·점수는 참고(매수하지 않음)");
        }
        return out;
    }

    private static Map<String, Object> flowsView(KrRules.FlowSummary flows, Stamp stamp) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("days", flows.daysAvailable());
        out.put("foreign20", flows.foreignNet20());
        out.put("institution20", flows.institutionNet20());
        out.put("foreign5", flows.foreignNet5());
        out.put("institution5", flows.institutionNet5());
        out.put("streak", flows.streakDays());
        out.put("sessionUpdatedAt", flows.sessionUpdatedAt());
        if (stamp != null) {
            out.put("sessionFetchedAt", stamp.fetchedAt());
            out.put("sessionDetail", stamp.detail());
        }
        return out;
    }

    private static Map<String, Object> dartView(KrRules.Evaluation evaluation) {
        KrRules.Financials financials = evaluation.financials();
        if (financials == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("bsnsYear", financials.bsnsYear());
        out.put("rceptNo", financials.rceptNo());
        out.put("receiptDate", evaluation.receiptDate() == null ? null : evaluation.receiptDate().toString());
        out.put("roePct", financials.roePct());
        out.put("debtRatioPct", financials.debtRatioPct());
        out.put("hasRevenueAccount", financials.hasRevenueAccount());
        out.put("capitalImpaired", financials.capitalImpaired());
        return out;
    }

    private static Map<String, Object> snapshotView(Snapshot snapshot, String sessionKey, String universeKey) {
        if (snapshot == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("collectedAtKst", snapshot.collectedAt() == null ? null : Kst.stamp(snapshot.collectedAt()));
        if (sessionKey != null) {
            out.put(sessionKey, Json.asText(snapshot.payload(), sessionKey));
        }
        if (universeKey != null) {
            out.put(universeKey, Json.asText(snapshot.payload(), universeKey));
        }
        return out;
    }

    private static String summary(String kind, KrReselection.Cycle cycle, KrRules.Selection selection, Draft draft) {
        long buys = draft.orders.stream().filter(o -> PaperBooks.BUY.equals(o.side()) && !o.parking()).count();
        long sells = draft.orders.stream().filter(o -> PaperBooks.SELL.equals(o.side()) && !o.parking()).count();
        Optional<PlannedOrder> parking = draft.orders.stream().filter(PlannedOrder::parking).findFirst();
        List<String> parts = new ArrayList<>();
        if (cycle != null) {
            String head = RuleBookService.INITIAL.equals(kind) ? "출발 선정" : cycle.catchUp()
                    ? "따라잡기 재선정(주기 " + cycle.cycleDate() + ", 입력 " + cycle.selectionAsOf() + ")"
                    : "재선정(주기 " + cycle.cycleDate() + ")";
            parts.add(head + " — 후보 " + selection.candidates().size() + " · 매수 종목 " + selection.targets().size()
                    + String.format(Locale.ROOT, "(주식 %.1f%%)", selection.stockWeightPct()));
        }
        if (buys > 0) {
            parts.add("매수 " + buys);
        }
        if (sells > 0) {
            parts.add("매도 " + sells);
        }
        parking.ifPresent(o -> parts.add(KrRules.PARKING_CODE + (PaperBooks.BUY.equals(o.side())
                ? String.format(Locale.ROOT, " 매수 %.2f%%", o.targetWeightPct()) : " 일부 매도")));
        if (parts.isEmpty()) {
            return "주문 없음 — 매도 신호 없음(재선정일 아님)";
        }
        return String.join(" · ", parts);
    }

    // ------------------------------------------------------------------ 조각
    private static int settingsVersion(MarketRun run) {
        Integer version = run.settingsVersion();
        if (version == null) {
            throw new IllegalStateException("설정 행이 없습니다 — 한국 초기화를 다시 누르세요(결정 행의 설정 판이 필요)");
        }
        return version;
    }

    private long latency(Instant started) {
        return Math.max(0, clock.millis() - started.toEpochMilli());
    }

    /** 금액 × 퍼센트(원, 소수 넷째 자리까지). */
    private static BigDecimal pct(BigDecimal amount, double percent) {
        return amount.multiply(BigDecimal.valueOf(percent)).divide(BigDecimal.valueOf(100), 4, RoundingMode.HALF_UP);
    }

    /** 금액 × (1 + bp/10,000) — 매수 유출은 +, 매도 수취는 −bp. */
    private static BigDecimal afterCost(BigDecimal amount, double bp) {
        return amount.multiply(BigDecimal.ONE.add(BigDecimal.valueOf(bp).divide(BigDecimal.valueOf(10_000),
                MathContext.DECIMAL64))).setScale(4, RoundingMode.HALF_UP);
    }

    private static BigDecimal decimal(JsonNode node) {
        return node == null || !node.isNumber() || !Double.isFinite(node.asDouble()) ? null : node.decimalValue();
    }

    /** 양의 정수(소수가 붙었거나 0 이하면 null — 모름, 0으로 채우지 않음). */
    private static Long wholeNumber(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        if (value.signum() <= 0 || value.stripTrailingZeros().scale() > 0) {
            return null;
        }
        try {
            return value.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
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

    private static double round4(double value) {
        return BigDecimal.valueOf(value).setScale(4, RoundingMode.HALF_UP).doubleValue();
    }

    private static double round6(double value) {
        return BigDecimal.valueOf(value).setScale(6, RoundingMode.HALF_UP).doubleValue();
    }

    private static double round2(BigDecimal value) {
        return value.setScale(2, RoundingMode.HALF_UP).doubleValue();
    }
}
