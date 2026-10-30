package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.KrFinancialSector;
import com.macrodash.analytics.KrFundamentals;
import com.macrodash.analytics.KrRules;
import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.NewsEvents;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.PacketBuilder.Limits;
import com.macrodash.feature.paper.PacketBuilder.Packet;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.DecisionSummary;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.RegimeLogStore;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.store.StoreRepository.TimeseriesColumns;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;

import java.math.BigDecimal;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.YearMonth;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 🧪 한국 Claude 계좌({@code kr_claude})의 입력 패킷(2단계 명세 §4-7·K8, E1a) — 미국 {@link PacketBuilder}와 같은 번호 체계의 섹션을 한국 자료로
 * 채웁니다. 미국 패킷·{@link PacketBuilder}는 건드리지 않습니다(미국 고정본·해시 그대로 — K37). 미국에 있는 {@code 2_macroCards}·{@code 3_fred}·
 * {@code 4_regime}·{@code 5_gate}·{@code 6}·{@code 6b}·{@code 7}(13F)은 없고, 매크로 카드·국면은 {@code 1_basis}에, 한국 금리·환율은 {@code 3_kr_macro}에
 * 둡니다.
 *
 * <p><b>섹션</b>({@link #SECTION_KEYS}): {@code 0_instructions} 한국 규칙(정수 주·호가·세금·체결 시점) · {@code 1_basis} 기준(시장 KR·원·판 6,
 * 다음 KRX 세션·휴장, 잠정가, 코스피·코스피200 야간선물·원/달러·엔/원 카드, 코스닥(지수 수집 없음 — 금융위 시장 합계), KRX 선물 투자주체, 국면 —
 * <b>전날 밤 판정</b> K39) · {@code 1b_calendar} 금통위·주요 발표({@link KrCalendarSection}) · {@code 3_kr_macro} 환율 일봉·시장 투자자별 매매대금
 * (한국 금리는 수집 없음 — null과 사유) · {@code 8_prices} 보유 → ETF → U(점수 순)의 잠정 종가·수익률·20일/5일 수급·점수·시총·체결 가능 여부 ·
 * {@code 8b_fundamentals} DART(접수일 ≤ 기준일) · {@code 9_portfolio} 장부(대기 주문 포함) · {@code 10_recentDecisions} · {@code 11_notes}(시장 KR
 * 메모, 설정 키는 두 책 공통 — 사용자 결정 v6) · {@code 11b_events} 한국 사건({@link KrEventsSection}) · {@code 12_hardRules} 한국 한도·체결 시점·
 * 비용·호가·최소 금액 500,000원.
 *
 * <p><b>시점</b>(Point-in-Time — 미국 {@code initialPacketHasNothingAfterAsOf}의 한국판): 모든 입력은 <b>읽은 순간</b>({@code readAt} — 그 실행의
 * 지금, 규칙 계좌 입력 동결과 같은 뜻 D1c) 이전에 수집된 것만 씁니다. 저장본(관측치·매크로 카드·환율·선물·시장 매매대금·일정·사건 상태)의 수집 시각이
 * 읽은 순간 뒤면 그 저장본은 없는 것으로 보고 사유를 적습니다. 날짜가 있는 값은 기준 세션 D 이하만(가격 이력·시장 합계·선물 일봉·시장 매매대금 기록),
 * 수급은 규칙 계좌와 같은 읽기({@link KrRuleBookService#read} — D 뒤 날짜·읽은 순간 뒤에 받은 기록·받은 시각 모름은 빠짐), DART는 접수일 ≤ D, 사건은
 * 알 수 있는 시각이 결정 순간 이하이고 받은 시각이 읽은 순간 이하, 국면은 D 앞 날짜의 판정(전날 밤). 한국 출발(INITIAL)은 그 밤 판으로 정기 결정과 같은
 * 조립이라 {@code asOfMismatch}가 없습니다(명세 §4-8·§5).
 *
 * <p><b>결정적</b>: 같은 저장 상태·같은 읽은 순간이면 같은 글자·같은 해시입니다({@link PacketBuilder#toNode}·{@link PacketBuilder#decimal}과 같은 직렬화).
 *
 * <p><b>크기</b>({@link #TARGET_TOKENS} — 미국과 같은 예산): 다 실은 패킷이 넘으면 {@code 8_prices}·{@code 8b_fundamentals}의 U 줄을 점수 낮은 쪽부터
 * 함께 잘라 예산 안으로 맞추고 잘린 수({@code omitted})를 적습니다(보유·ETF 줄은 자르지 않음 — 명세 §4-7 '점수 상위·보유 우선'). 같은 입력이면 같은
 * 수를 자릅니다(그 수는 가장 적게 자르는 수 — 이분 탐색).
 */
final class KrPacketBuilder {

    private static final Logger log = LoggerFactory.getLogger(KrPacketBuilder.class);

    // ------------------------------------------------------------------ 섹션 키(읽는 순서)
    static final String INSTRUCTIONS = PacketBuilder.INSTRUCTIONS;
    static final String BASIS = PacketBuilder.BASIS;
    static final String CALENDAR = PacketBuilder.CALENDAR;
    static final String KR_MACRO = "3_kr_macro";
    static final String PRICES = PacketBuilder.PRICES;
    static final String FUNDAMENTALS = PacketBuilder.FUNDAMENTALS;
    static final String PORTFOLIO = PacketBuilder.PORTFOLIO;
    static final String DECISIONS = PacketBuilder.DECISIONS;
    static final String NOTES = PacketBuilder.NOTES;
    static final String EVENTS = PacketBuilder.EVENTS;
    static final String HARD_RULES = PacketBuilder.HARD_RULES;
    static final List<String> SECTION_KEYS = List.of(INSTRUCTIONS, BASIS, CALENDAR, KR_MACRO, PRICES, FUNDAMENTALS,
            PORTFOLIO, DECISIONS, NOTES, EVENTS, HARD_RULES);

    /** 한국 패킷의 판 — 처음부터 6(미국 컨센서스 켬과 같은 판 번호, 명세 §4-12 '한국 패킷은 처음부터 6'). 섹션·칸을 바꾸면 올립니다. */
    static final int PACKET_VERSION = 6;
    /** 크기 예산 — 미국 패킷과 같은 값({@link PacketBuilder#TARGET_TOKENS}, 어림은 {@link PacketBuilder#estimateTokens}). */
    static final int TARGET_TOKENS = PacketBuilder.TARGET_TOKENS;

    /** 가격·수급 한 줄의 열(8_prices.columns). */
    static final List<String> PRICE_COLUMNS = List.of("code", "name", "role", "rank", "date", "close", "priceSource",
            "stale", "unfillable", "ret1mPct", "ret3mPct", "ret6mPct", "ret12mPct", "vs200dPct", "vs52wHighPct",
            "flowDays", "foreign20", "institution20", "foreign5", "institution5", "streakDays", "flowScore",
            "marketCapTrilKrw");
    /** 재무 한 줄의 열(8b_fundamentals.columns). */
    static final List<String> FUNDAMENTAL_COLUMNS = List.of("code", "bsnsYear", "rceptNo", "roePct", "debtRatioPct",
            "opMarginPct", "revenueGrowthPct", "opIncomeGrowthPct", "opTurn", "per", "pbr", "capitalImpaired",
            "financialSector", "status");
    /** 대기 주문 한 줄의 열 — 미국과 같은 열({@link PacketBuilder#PENDING_COLUMNS}). */
    static final List<String> PENDING_COLUMNS = PacketBuilder.PENDING_COLUMNS;

    static final String HOLDING = "HOLDING";
    static final String ETF = "ETF";
    static final String UNIVERSE = "UNIVERSE";

    /** 매크로 카드 저장본({@code macro.collected})에서 싣는 카드, 이 순서로 — 코스피·코스피200 야간선물·원/달러·엔/원. */
    static final List<String> CARD_KEYS = List.of("kospi", "kospi200_night_scraped", "usdkrw", "jpykrw");
    /** 환율 일봉 저장본({@code macro.fx_history})에서 싣는 계열(3_kr_macro). */
    static final List<String> FX_KEYS = List.of("usdkrw", "jpykrw", "usdjpy", "dxy");
    /** 시장 합계(금융위 {@code fsc_market}) — 코스피·코스닥. */
    static final List<String> MARKETS = List.of("KOSPI", "KOSDAQ");
    /** 시장 투자자별 매매대금(토스 {@code kr.toss_market_flows})에서 싣는 투자자. */
    static final List<String> MARKET_INVESTORS = List.of("foreigner", "institution", "individual");
    static final int HOLIDAY_HORIZON_DAYS = PacketBuilder.HOLIDAY_HORIZON_DAYS;
    static final int CHANGE_TRADING_DAYS = PacketBuilder.CHANGE_TRADING_DAYS;
    static final int PRICE_LOOKBACK_DAYS = PacketBuilder.PRICE_LOOKBACK_DAYS;
    static final int REGIME_LOOKBACK = PacketBuilder.REGIME_LOOKBACK;
    static final int MAX_RECENT_DECISIONS = PacketBuilder.MAX_RECENT_DECISIONS;
    static final int SUMMARY_CHARS = PacketBuilder.SUMMARY_CHARS;
    static final int MAX_REASON_CHARS = PacketBuilder.MAX_REASON_CHARS;
    /** 1조 원. */
    private static final double TRILLION = 1e12;
    /** 1억 원. */
    private static final double HUNDRED_MILLION = 1e8;

    /**
     * 가격 설명(0_instructions·1_basis) — 8_prices의 close·9_portfolio의 price는 토스 일봉 종가라, 토스가 NXT 미지원으로 표시한 봉({@code TOSS_DAILY})도
     * 20:00까지의 장 마감 뒤 체결이 섞일 수 있습니다(QA-146 — 그 봉도 시가만 KRX 시가 단일가).
     */
    static final String PRICES_NOTE = "토스 잠정 종가 — 금융위 확정 전이고 KRX 정규장 종가와 다를 수 있다(NXT 종목은 KRX+NXT 통합가, 토스가 NXT "
            + "미지원으로 표시한 봉도 20:00까지의 장 마감 뒤 체결이 섞일 수 있음). 확정가는 다음 밤 들어와 체결 행은 그대로 두고 확정 조정으로 "
            + "현금을 맞춘다";
    static final String REGIME_NOTE = "국면은 결정 전날 밤의 판정이다(서버 국면 기록은 23시대라 22:30 한국 결정은 그날 판정을 볼 수 없음 — K39). "
            + "미국 매크로 기준 판정이고 한국 시장 판정이 아니다";
    static final String KOSDAQ_NOTE = "코스닥 지수는 수집하지 않음(매크로 카드·이력 모두 없음) — 시장 합계(금융위 시가총액·거래대금, 지수가 아님)로 대신 본다";
    static final String RATES_NOTE = "한국 금리(기준금리·국고채 수익률)는 아직 수집하지 않음 — 출처 미정이라 싣지 않음(지어내지 않음). 금통위 일정은 "
            + "1b_calendar";
    static final String CREDIT_GAP_NOTE = "BIS 신용갭은 5단계(아직 없음)";
    static final String LATE_SNAPSHOT = "저장본이 읽은 순간 뒤에 수집됨 — 결정 전 판이 아니라 싣지 않음";

    private static final Pattern STAMP = Pattern.compile("(\\d{4}-\\d{2}-\\d{2})");
    private static final DateTimeFormatter HOUR_MINUTE = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    private final PaperStore store;
    private final StoreReader reader;
    private final StoreRepository repository;
    private final RegimeLogStore regimeLog;
    private final PaperMarketData marketData;
    private final NoteService notes;
    private final KrRuleBookService rules;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    /** 크기 예산 — 운영은 {@link #TARGET_TOKENS}, 시험은 작은 값으로 자르기를 봅니다. */
    private final int targetTokens;

    KrPacketBuilder(PaperStore store, StoreReader reader, StoreRepository repository, RegimeLogStore regimeLog,
                    PaperMarketData marketData, NoteService notes, KrRuleBookService rules, PaperConfig config,
                    ObjectMapper mapper) {
        this(store, reader, repository, regimeLog, marketData, notes, rules, config, mapper, TARGET_TOKENS);
    }

    /** 시험용 — 크기 예산을 바꿉니다. */
    KrPacketBuilder(PaperStore store, StoreReader reader, StoreRepository repository, RegimeLogStore regimeLog,
                    PaperMarketData marketData, NoteService notes, KrRuleBookService rules, PaperConfig config,
                    ObjectMapper mapper, int targetTokens) {
        this.targetTokens = targetTokens;
        this.store = Objects.requireNonNull(store, "store");
        this.reader = Objects.requireNonNull(reader, "reader");
        this.repository = Objects.requireNonNull(repository, "repository");
        this.regimeLog = Objects.requireNonNull(regimeLog, "regimeLog");
        this.marketData = Objects.requireNonNull(marketData, "marketData");
        this.notes = Objects.requireNonNull(notes, "notes");
        this.rules = Objects.requireNonNull(rules, "rules");
        this.config = Objects.requireNonNull(config, "config");
        this.mapper = Objects.requireNonNull(mapper, "mapper");
    }

    /**
     * 그 세션의 한국 패킷(클래스 설명).
     *
     * @param run              한국 실행(그 실행의 달력·설정 판 — 결정 행의 settings_version이 이 판)
     * @param asOf             기준 KR 세션 D(출발이면 S)
     * @param kind             결정 종류(SCHEDULED·MANUAL·INITIAL·REBALANCE)
     * @param initial          출발 결정(장부는 출발 현금뿐, 대기 주문·최근 결정 없음)
     * @param frameworkVersion 시스템 프롬프트로 쓴 프레임 판(모르면 null)
     * @param quotes           그 실행의 한국 관측치(결정 게이트가 본 것 — 장부·체결 가능 판정과 같은 것). 비면 관측치 없음
     * @param readAt           읽은 순간 — 이 뒤에 수집된 값은 쓰지 않음
     * @throws IllegalArgumentException 한국 실행이 아님·기준일 없음·모르는 종류
     * @throws IllegalStateException    모의 매매 테이블이 없음, U를 읽지 못함({@link KrRuleBookService.InputUnavailable})
     */
    Packet build(MarketRun run, LocalDate asOf, String kind, boolean initial, Integer frameworkVersion,
                 Optional<Quotes> quotes, Instant readAt) {
        Objects.requireNonNull(run, "run");
        if (!Book.MARKET_KR.equals(run.code())) {
            throw new IllegalArgumentException("한국 실행이 아닙니다: " + run);
        }
        if (asOf == null) {
            throw new IllegalArgumentException("기준 거래일이 없습니다");
        }
        if (!PacketBuilder.KINDS.contains(kind)) {
            throw new IllegalArgumentException("결정 종류는 " + PacketBuilder.KINDS + " 중 하나입니다: " + kind);
        }
        Objects.requireNonNull(readAt, "readAt");
        if (!store.ready()) {
            throw new IllegalStateException(PaperQueryService.NOT_READY_MESSAGE);
        }
        Optional<Quotes> given = quotes == null ? Optional.empty() : quotes;
        return reader.quietly(() -> assemble(run, asOf, kind, initial, frameworkVersion, given, readAt));
    }

    // ------------------------------------------------------------------ 조립
    /** 한 줄(8_prices·8b가 같은 줄을 같은 순서로) — 종목 코드·역할·U 구성원(없으면 null). */
    private record Line(String code, String role, KrRules.Member member) {
    }

    private Packet assemble(MarketRun run, LocalDate asOf, String kind, boolean initial, Integer frameworkVersion,
                            Optional<Quotes> givenQuotes, Instant readAt) {
        TradingCalendar calendar = run.calendar();
        JsonNode body = run.settingsBody();
        PaperSettings paper = run.settings();
        Limits limits = Limits.from(body, run);
        List<String> notesForBasis = new ArrayList<>();
        Optional<Quotes> quotes = givenQuotes.filter(q -> !q.collectedAt().isAfter(readAt));
        if (givenQuotes.isPresent() && quotes.isEmpty()) {
            notesForBasis.add("관측치(" + Datasets.SNAP_KR_PAPER_QUOTES + ")가 " + LATE_SNAPSHOT);
        }

        LedgerView ledger = ledger(asOf, initial);
        Set<String> etfs = new LinkedHashSet<>(KrPaperMarket.BENCHMARK_TICKERS.stream().sorted().toList());
        etfs.addAll(paper.cashLikeTickers());
        etfs.addAll(extraTickers(body));
        Set<String> readCodes = new TreeSet<>(etfs);
        ledger.positions().forEach(p -> readCodes.add(p.ticker()));
        KrRuleBookService.Read read = rules.read(run, asOf, readAt, quotes, readCodes);
        KrRules.Input input = read.input();
        Map<String, KrRules.Member> members = new LinkedHashMap<>();
        input.universe().forEach(m -> members.put(m.code(), m));
        Map<String, KrRules.FlowSummary> flows = new HashMap<>();
        Map<String, Double> scores = new HashMap<>();
        Set<String> allCodes = new TreeSet<>(readCodes);
        allCodes.addAll(members.keySet());
        for (String code : allCodes) {
            KrRules.FlowSummary summary = KrRules.flows(calendar, asOf, input.flows().get(code));
            flows.put(code, summary);
            KrRules.Member member = members.get(code);
            scores.put(code, member == null ? null : KrRules.score(summary, member.listedShares()));
        }
        Map<String, String> holds = new TreeMap<>();
        for (PaperStore.CorpActionHold hold : store.corpActionHolds(PaperBooks.KR_CLAUDE)) {
            holds.put(hold.ticker(), hold.reason());
        }
        KrRuleBookService.Fillable fillable = new KrRuleBookService.Fillable(asOf, read.tradable(), input.suspended(),
                holds);

        // 줄: 보유(코드 순) → ETF(벤치마크·현금성·추가) → U(점수 높은 순, 점수 없음은 뒤 — 같으면 U 순위).
        Map<String, Line> lines = new LinkedHashMap<>();
        ledger.positions().stream().map(Position::ticker).sorted()
                .forEach(code -> lines.putIfAbsent(code, new Line(code, HOLDING, members.get(code))));
        etfs.forEach(code -> lines.putIfAbsent(code, new Line(code, ETF, members.get(code))));
        List<KrRules.Member> ranked = new ArrayList<>(input.universe());
        ranked.sort(Comparator.comparing((KrRules.Member m) -> scores.get(m.code()),
                        Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparingInt(KrRules.Member::rank).thenComparing(KrRules.Member::code));
        List<String> universeRows = new ArrayList<>();
        for (KrRules.Member m : ranked) {
            if (lines.putIfAbsent(m.code(), new Line(m.code(), UNIVERSE, m)) == null) {
                universeRows.add(m.code());
            }
        }
        Map<String, DailySeries> history = adjustedHistory(run, lines.keySet(), asOf, quotes);

        Set<String> universe = new TreeSet<>(members.keySet());
        universe.addAll(etfs);
        LocalDate fillDay = calendar.nextTradingDay(asOf);
        Set<String> lockedOut = new TreeSet<>();
        for (Lockout l : ledger.lockouts()) {
            if (TrailingStop.lockedOut(l.untilTradingDate(), fillDay)) {
                lockedOut.add(l.ticker());
            }
        }
        Map<String, String> unfillable = new TreeMap<>();
        for (String code : lines.keySet()) {
            String reason = fillable.blocked(code);
            if (reason != null) {
                unfillable.put(code, reason);
            }
        }

        List<DecisionSummary> prior = priorDecisions(asOf, kind, initial);
        // DART 저장본도 읽은 순간 뒤에 수집된 판이면 쓰지 않습니다(규칙 계좌 입력은 그대로 — 접수일 규칙이 같은 시점을 지킴).
        Snapshot dart = read.dart();
        String dartMissing = dart == null ? "DART 주요계정 저장본이 없습니다"
                : dart.collectedAt() != null && dart.collectedAt().isAfter(readAt)
                ? LATE_SNAPSHOT + "(" + dart.collectedAtKst() + ")" : null;
        if (dartMissing != null) {
            dart = null;
        }
        JsonNode companies = dart == null ? null : Json.child(dart.payload(), "companies");

        // 섹션 — 8_prices·8b만 크기 예산으로 잘릴 수 있어 나머지는 한 번 만듭니다.
        Map<String, Object> instructions = instructions(asOf, initial, paper);
        Map<String, Object> basis = basis(run, asOf, kind, initial, quotes, frameworkVersion, read, readAt, notesForBasis);
        KrCalendarSection.Built calendarSection = KrCalendarSection.build(
                reader.read(Datasets.SNAP_KR_CALENDAR, Datasets.MAX_AGE_WEEKLY, "kr_calendar"), calendar, asOf, readAt);
        Map<String, Object> macro = krMacro(asOf, readAt);
        Map<String, Object> portfolio = portfolio(calendar, asOf, initial, ledger, paper, limits, holds);
        Map<String, Object> decisions = recentDecisions(prior);
        NoteService.PacketNotes packetNotes = notes.activeMarketNotes(run, asOf, body);
        Map<String, Object> notesSection = notesSection(packetNotes);
        KrEventsSection.Built events = events(run, calendar, asOf, body, readAt, lines, members, companies, etfs, paper);
        Map<String, Object> hardRules = hardRules(run, asOf, initial, limits, paper, etfs, universe, lockedOut,
                unfillable, quotes, input.universeDate());

        Map<String, Object> fixed = new LinkedHashMap<>();
        fixed.put(INSTRUCTIONS, instructions);
        fixed.put(BASIS, basis);
        fixed.put(CALENDAR, calendarSection.section());
        fixed.put(KR_MACRO, macro);
        fixed.put(PORTFOLIO, portfolio);
        fixed.put(DECISIONS, decisions);
        fixed.put(NOTES, notesSection);
        fixed.put(EVENTS, events.section());
        fixed.put(HARD_RULES, hardRules);
        Rows rows = new Rows(lines, universeRows, quotes, history, flows, scores, unfillable, members, companies, dart,
                dartMissing, asOf, read, paper);
        int cut = 0;
        String text = render(fixed, rows, 0);
        if (PacketBuilder.estimateTokens(text) > targetTokens && !universeRows.isEmpty()) {
            int low = 1;
            int high = universeRows.size();
            while (low < high) {
                int mid = (low + high) >>> 1;
                if (PacketBuilder.estimateTokens(render(fixed, rows, mid)) > targetTokens) {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            cut = low;
            text = render(fixed, rows, cut);
        }
        int tokens = PacketBuilder.estimateTokens(text);
        if (tokens > targetTokens) {
            log.warn("한국 Claude 패킷이 U 줄을 모두 잘라도 목표보다 큽니다: {} {} 약 {}토큰(목표 {})", asOf, kind, tokens,
                    targetTokens);
        } else if (cut > 0) {
            log.info("한국 Claude 패킷 {} {} — 크기 예산 {}토큰에 맞춰 U {}줄을 잘랐습니다(약 {}토큰)", asOf, kind, targetTokens,
                    cut, tokens);
        }
        JsonNode node;
        try {
            node = mapper.readTree(text);
        } catch (RuntimeException e) {
            throw new IllegalStateException("한국 패킷을 다시 읽지 못했습니다", e);
        }
        Integer eventCount = events.result().eventCount();
        DecisionMeasure measure = new DecisionMeasure(calendarSection.available(),
                calendarSection.available() ? calendarSection.rows() : null, eventCount,
                eventCount == null ? null : events.result().eventIds(), null, null);
        return new Packet(node, text, PacketBuilder.sha256(text), packetNotes.ids(), measure);
    }

    /** 8_prices·8b의 재료(크기 예산으로 U 줄을 자를 때 다시 만듦). */
    private record Rows(Map<String, Line> lines, List<String> universeRows, Optional<Quotes> quotes,
                        Map<String, DailySeries> history, Map<String, KrRules.FlowSummary> flows, Map<String, Double> scores,
                        Map<String, String> unfillable, Map<String, KrRules.Member> members, JsonNode companies,
                        Snapshot dart, String dartMissing, LocalDate asOf, KrRuleBookService.Read read,
                        PaperSettings paper) {
    }

    /** 섹션을 이어 글로 — U 줄을 뒤에서 {@code cut}만큼 뺀 8_prices·8b와 나머지(한 번 만든) 섹션, 읽는 순서대로. */
    private String render(Map<String, Object> fixed, Rows r, int cut) {
        List<String> universeRows = r.universeRows();
        Set<String> dropped = new LinkedHashSet<>(universeRows.subList(universeRows.size() - cut, universeRows.size()));
        List<Line> shown = r.lines().values().stream().filter(l -> !dropped.contains(l.code())).toList();
        Map<String, Object> root = new LinkedHashMap<>();
        for (String key : SECTION_KEYS) {
            if (PRICES.equals(key)) {
                root.put(key, priceSection(shown, cut, r.quotes(), r.history(), r.flows(), r.scores(), r.unfillable(),
                        r.asOf(), r.read()));
            } else if (FUNDAMENTALS.equals(key)) {
                root.put(key, fundamentalsSection(shown, cut, r.members(), r.companies(), r.asOf(), r.dart(),
                        r.dartMissing(), r.paper()));
            } else {
                root.put(key, fixed.get(key));
            }
        }
        return mapper.writer().without(SerializationFeature.INDENT_OUTPUT).writeValueAsString(PacketBuilder.toNode(root));
    }

    // ------------------------------------------------------------------ 0 지시
    private static Map<String, Object> instructions(LocalDate asOf, boolean initial, PaperSettings paper) {
        PaperSettings.CostRates rates = paper.costRates() == null ? PaperSettings.CostRates.defaults() : paper.costRates();
        List<String> lines = new ArrayList<>();
        lines.add("아래 패킷의 자료만으로 판단한다. 패킷에 없는 사실은 '확인 필요'로 둔다.");
        lines.add("메모의 숫자는 참고이고, 패킷의 숫자가 우선한다.");
        lines.add("현금 비중은 네가 정한다 — targetEquityExposurePct(0~100)에 목표 주식 노출을 적고 근거를 exposureRationale에 적는다. "
                + "현금 비중 상·하한은 없다.");
        lines.add("출력은 주어진 스키마대로 한다. 주문이 없어도 noTradeReason을 쓴다.");
        lines.add("한국 책(" + PaperBooks.KR_CLAUDE + ")이다 — 통화는 원(KRW), 날짜는 KRX 거래일(KST), 시각 표기도 KST다. 티커는 6자리 종목 "
                + "코드다.");
        lines.add(timingLine());
        lines.add("체결은 정수 주다 — 목표 비중 증가분을 체결가(시가)와 비용으로 나눈 정수 주만 사고, 1주 가격보다 작은 매수 증가분은 체결되지 "
                + "않는다(12_hardRules).");
        lines.add("호가단위: " + KrxCosts.tickTableText() + " — 체결가는 관측된 단일가 그대로라 호가를 맞출 필요는 없다.");
        lines.add(costLine(rates, paper.slippageBp()));
        lines.add("가격(8_prices의 close, 9_portfolio의 price와 그 값으로 센 weightPct·unrealizedPct·stopDistancePct)은 " + PRICES_NOTE
                + ". 9_portfolio의 avgCost는 체결가 평단(확정 뒤에는 금융위 확정가로 옮김), highWatermark·stopPrice는 진입 체결가(확정 뒤에는 "
                + "금융위 확정가)에서 시작해 금융위 확정 종가로만 오른 최고가와 그 스탑가다.");
        lines.add("수급(외국인·기관 순매수, 주)은 토스 집계(KRX·NXT 통합)이고, 20일·5일 합은 기준 거래일로 끝나는 KRX 거래일 창이다.");
        lines.add("국면(1_basis.regime)은 전날 밤 판정이다.");
        if (initial) {
            lines.add("이번은 출발 결정이다(기준일 " + asOf + ") — 통과한 주문은 다음 KRX 거래일 시가에 네 계좌가 함께 체결된다(사후 체결 "
                    + "없음). 장부는 출발 현금뿐이다.");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines);
        return out;
    }

    /** 체결 시점 문장 — {@link KrPaperMarket#ALLOW_NEXT_CLOSE}에 따라. */
    static String timingLine() {
        return KrPaperMarket.ALLOW_NEXT_CLOSE
                ? "주문은 기준 거래일 다음 KRX 거래일의 시가(NEXT_OPEN — 정규장 시가 단일가, 기본) 또는 종가(NEXT_CLOSE — 정규장 종가 단일가)에 "
                        + "체결된다."
                : "주문은 기준 거래일 다음 KRX 거래일의 시가(NEXT_OPEN — 정규장 시가 단일가)에 체결된다. 체결 시점은 NEXT_OPEN뿐이다.";
    }

    /** 비용 문장(0_instructions·12_hardRules). */
    private static String costLine(PaperSettings.CostRates rates, double slippageBp) {
        KrxCosts.TaxRates tax = rates.tax();
        return "비용: 수수료 " + plain(rates.commissionBp()) + "bp·슬리피지 " + plain(slippageBp)
                + "bp(매수·매도 각각, 체결가가 아니라 비용 칸), 매도세 코스피 거래세 " + plain(tax.kospiSttBp().doubleValue())
                + "bp + 농특세 " + plain(tax.kospiRuralBp().doubleValue()) + "bp · 코스닥 " + plain(tax.kosdaqSttBp().doubleValue())
                + "bp · ETF " + plain(tax.etfBp().doubleValue()) + "bp(" + tax.effectiveFrom() + " 시행) — 원 미만 절사.";
    }

    // ------------------------------------------------------------------ 1 기준
    private Map<String, Object> basis(MarketRun run, LocalDate asOf, String kind, boolean initial, Optional<Quotes> quotes,
                                      Integer frameworkVersion, KrRuleBookService.Read read, Instant readAt,
                                      List<String> extraNotes) {
        TradingCalendar calendar = run.calendar();
        LocalDate next = calendar.nextTradingDay(asOf);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("packetVersion", PACKET_VERSION);
        out.put("market", Book.MARKET_KR);
        out.put("currency", Book.CURRENCY_KRW);
        out.put("book", PaperBooks.KR_CLAUDE);
        out.put("asOfTradingDate", asOf.toString());
        out.put("decisionKind", kind);
        out.put("initial", initial);
        out.put("nextSession", next.toString());
        out.put("nextSessionOpenKst", HOUR_MINUTE.format(calendar.openInstant(next).atZone(Kst.ZONE)));
        out.put("nextSessionCloseKst", HOUR_MINUTE.format(calendar.closeInstant(next).atZone(Kst.ZONE)));
        List<String> closures = new ArrayList<>();
        String closuresReason = null;
        try {
            for (int i = 1; i <= HOLIDAY_HORIZON_DAYS; i++) {
                LocalDate day = asOf.plusDays(i);
                if (day.getDayOfWeek() != DayOfWeek.SATURDAY && day.getDayOfWeek() != DayOfWeek.SUNDAY
                        && !calendar.isTradingDay(day)) {
                    closures.add(day.toString());
                }
            }
        } catch (CalendarUnavailableException e) {
            closuresReason = "달력 없음 — " + e.getMessage();
        }
        out.put("upcomingClosures", closuresReason == null ? closures : null);
        if (closuresReason != null) {
            out.put("upcomingClosuresReason", closuresReason);
        }
        out.put("pricesFinal", false);
        out.put("pricesNote", PRICES_NOTE);
        out.put("quotesSession", quotes.map(Quotes::session).map(LocalDate::toString).orElse(null));
        out.put("quotesCollectedAtKst", quotes.map(q -> Kst.stamp(q.collectedAt())).orElse(null));
        out.put("readAtKst", Kst.stamp(readAt));
        out.put("frameworkVersion", frameworkVersion);
        out.put("settingsVersion", run.settingsVersion());
        out.put("universeAsOf", read.input().universeDate().toString());
        out.put("universeRule", read.universeRule());
        out.put("markets", markets(asOf, readAt));
        out.put("futures", futures(asOf, readAt));
        out.put("regime", regime(asOf));
        List<String> notesOut = new ArrayList<>(extraNotes);
        notesOut.addAll(read.notes());
        if (!notesOut.isEmpty()) {
            out.put("notes", notesOut);
        }
        return out;
    }

    /** 코스피·코스피200 야간선물·원/달러·엔/원 카드(지금 수집본 — 읽은 순간 전)와 코스닥(지수 없음 — 금융위 시장 합계). */
    private Map<String, Object> markets(LocalDate asOf, Instant readAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> macro = reader.read(Datasets.SNAP_MACRO_COLLECTED, Datasets.MAX_AGE_REALTIME, "macro_collected");
        Snapshot snap = macro.orElse(null);
        out.put("source", "snapshot " + Datasets.SNAP_MACRO_COLLECTED + " — 매크로 화면 카드의 최신 수집본(최신 1건만 저장)");
        out.put("note", "카드 시각(lastTs, KST)이 기준 거래일보다 앞이면 asOfMismatch — 원/달러·엔/원·야간선물은 결정 시각의 시세");
        if (snap == null || snap.collectedAt() == null) {
            out.put("missing", "매크로 카드 저장본(" + Datasets.SNAP_MACRO_COLLECTED + ")이 없습니다");
        } else if (snap.collectedAt().isAfter(readAt)) {
            out.put("missing", LATE_SNAPSHOT + "(" + snap.collectedAtKst() + ")");
        } else {
            out.put("collectedAtKst", snap.collectedAtKst());
            Map<String, JsonNode> byKey = new LinkedHashMap<>();
            for (JsonNode category : Json.array(snap.payload(), "categories")) {
                for (JsonNode item : Json.array(category, "items")) {
                    String key = Json.asText(item, "key");
                    if (key != null) {
                        byKey.putIfAbsent(key, item);
                    }
                }
            }
            List<Map<String, Object>> items = new ArrayList<>();
            for (String key : CARD_KEYS) {
                JsonNode item = byKey.get(key);
                Map<String, Object> card = new LinkedHashMap<>();
                card.put("key", key);
                if (item == null) {
                    card.put("missing", "카드 없음");
                    items.add(card);
                    continue;
                }
                String lastTs = Json.asText(item, "lastTs");
                LocalDate observed = kstDate(lastTs);
                card.put("name", Json.asText(item, "name"));
                card.put("price", PacketBuilder.decimal(Json.asDouble(item, "price"), 4));
                card.put("prevValue", PacketBuilder.decimal(Json.asDouble(item, "prevValue"), 4));
                card.put("pct", PacketBuilder.decimal(Json.asDouble(item, "pct"), 2));
                card.put("lastTs", lastTs);
                card.put("isStale", Json.asBoolean(item, "isStale"));
                card.put("source", Json.asText(item, "source"));
                card.put("asOfMismatch", observed == null || observed.isBefore(asOf));
                items.add(card);
            }
            out.put("cards", items);
        }
        Map<String, Object> kosdaq = new LinkedHashMap<>();
        kosdaq.put("index", null);
        kosdaq.put("note", KOSDAQ_NOTE);
        out.put("kosdaq", kosdaq);
        out.put("totals", marketTotals(asOf));
        return out;
    }

    /** 금융위 시장 합계({@code timeseries fsc_market}) — 기준일 이하 마지막 날, 1일·20거래일 변화. */
    private Map<String, Object> marketTotals(LocalDate asOf) {
        List<String> ids = new ArrayList<>();
        for (String market : MARKETS) {
            ids.add(market + ".marketCap");
            ids.add(market + ".tradingValue");
        }
        Map<String, TimeseriesColumns> columns = repository.readTimeseriesColumns(Datasets.TS_FSC_MARKET, ids,
                asOf.minusDays(PRICE_LOOKBACK_DAYS), asOf);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (String market : MARKETS) {
            DailySeries cap = series(columns.get(market + ".marketCap"), asOf);
            DailySeries value = series(columns.get(market + ".tradingValue"), asOf);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("market", market);
            if (cap == null) {
                row.put("missing", "시장 합계 없음");
                rows.add(row);
                continue;
            }
            List<Double> caps = new ArrayList<>();
            for (int i = 0; i < cap.size(); i++) {
                caps.add(cap.valueAt(i));
            }
            row.put("date", cap.lastDate().toString());
            row.put("marketCapTrilKrw", PacketBuilder.decimal(cap.lastValue() / TRILLION, 1));
            row.put("change1dPct", PacketBuilder.decimal(SeriesMath.periodReturn(caps, 1), 2));
            row.put("change20dPct", PacketBuilder.decimal(SeriesMath.periodReturn(caps, CHANGE_TRADING_DAYS), 2));
            Double traded = value == null ? null : value.valueOn(cap.lastDate());
            row.put("tradingValueTrilKrw", PacketBuilder.decimal(traded == null ? null : traded / TRILLION, 2));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", "timeseries " + Datasets.TS_FSC_MARKET + " — 금융위 시장 합계(기준일 이하 마지막 날, 보통 기준일 전 거래일)");
        out.put("isProxy", true);
        out.put("note", "시가총액 변화는 지수 변화가 아님(상장·증자 포함) — 코스닥 지수 대신 보는 근사");
        out.put("rows", rows);
        return out;
    }

    /** KRX 코스피200 선물 일봉(기준일 이하 마지막 줄)과 선물 투자주체(그날 수집본 — 자료일 ≤ 기준일). */
    private Map<String, Object> futures(LocalDate asOf, Instant readAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        Snapshot history = reader.read(Datasets.SNAP_KRX_FUTURES, Datasets.MAX_AGE_DAILY, "krx_futures").orElse(null);
        Map<String, Object> daily = new LinkedHashMap<>();
        daily.put("source", "snapshot " + Datasets.SNAP_KRX_FUTURES);
        if (history == null || history.collectedAt() == null) {
            daily.put("missing", "선물 일봉 저장본이 없습니다");
        } else if (history.collectedAt().isAfter(readAt)) {
            daily.put("missing", LATE_SNAPSHOT + "(" + history.collectedAtKst() + ")");
        } else {
            JsonNode last = null;
            LocalDate lastDate = null;
            for (JsonNode row : Json.array(history.payload(), "rows")) {
                LocalDate date = Json.parseDate(Json.asText(row, "date"));
                if (date != null && !date.isAfter(asOf) && (lastDate == null || date.isAfter(lastDate))) {
                    last = row;
                    lastDate = date;
                }
            }
            if (last == null) {
                daily.put("missing", "기준일 이하 선물 일봉이 없습니다");
            } else {
                daily.put("date", lastDate.toString());
                daily.put("contractName", Json.asText(last, "contractName"));
                daily.put("futuresClose", PacketBuilder.decimal(Json.asDouble(last, "futuresClose"), 2));
                daily.put("changePct", PacketBuilder.decimal(Json.asDouble(last, "changePct"), 2));
                daily.put("openInterest", PacketBuilder.decimal(Json.asDouble(last, "openInterest"), 0));
                daily.put("oiChange", PacketBuilder.decimal(Json.asDouble(last, "oiChange"), 0));
                daily.put("marketBasis", PacketBuilder.decimal(Json.asDouble(last, "marketBasis"), 2));
                daily.put("marketPhase", Json.asText(last, "marketPhase"));
                daily.put("asOfMismatch", lastDate.isBefore(asOf));
            }
        }
        out.put("daily", daily);
        String trendName = Datasets.daumFuturesTrend(Datasets.DAUM_TREND_LOOKBACK);
        Snapshot trend = reader.read(trendName, Datasets.MAX_AGE_DAILY, "krx_futures_trend").orElse(null);
        Map<String, Object> investors = new LinkedHashMap<>();
        investors.put("source", "snapshot " + trendName + " — 투자주체별 순매수(계약), 오늘·5일·20일");
        LocalDate dataDate = trend == null ? null : Json.parseDate(Json.asText(trend.payload(), "dataDate"));
        if (trend == null || trend.collectedAt() == null) {
            investors.put("missing", "선물 투자주체 저장본이 없습니다");
        } else if (trend.collectedAt().isAfter(readAt)) {
            investors.put("missing", LATE_SNAPSHOT + "(" + trend.collectedAtKst() + ")");
        } else if (dataDate == null || dataDate.isAfter(asOf) || Json.asBoolean(trend.payload(), "isPlaceholder")) {
            investors.put("missing", "자료일이 없거나 기준일 뒤 — 싣지 않음");
        } else {
            investors.put("dataDate", dataDate.toString());
            investors.put("unit", Json.asText(trend.payload(), "unit"));
            investors.put("asOfMismatch", dataDate.isBefore(asOf));
            List<List<Object>> rows = new ArrayList<>();
            for (JsonNode row : Json.array(trend.payload(), "rows")) {
                List<Object> values = new ArrayList<>(4);
                values.add(Json.asText(row, "investor"));
                values.add(PacketBuilder.decimal(Json.asDouble(row, "netToday"), 0));
                values.add(PacketBuilder.decimal(Json.asDouble(row, "net5d"), 0));
                values.add(PacketBuilder.decimal(Json.asDouble(row, "net20d"), 0));
                rows.add(values);
            }
            investors.put("columns", List.of("investor", "netToday", "net5d", "net20d"));
            investors.put("rows", rows);
        }
        out.put("investors", investors);
        return out;
    }

    /**
     * 국면 — 기준 세션 D보다 앞 날짜(KST 달력)의 가장 최근 판정(K39 '전날 밤 판정'). 서버의 국면 기록은 23시대라 D 22:30 결정은 D 판정을 볼 수
     * 없고, 기록 시각이 다른 배포(로컬 18시)나 자정 넘은 재시도에서도 같은 판정이 되게 날짜로 자릅니다.
     */
    private Map<String, Object> regime(LocalDate asOf) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!regimeLog.ready()) {
            out.put("available", false);
            out.put("note", "국면 판정 기록 테이블(regime_log)이 없습니다");
            return out;
        }
        Optional<RegimeLogStore.Entry> entry = regimeLog.recent(REGIME_LOOKBACK).stream()
                .filter(e -> e.verdictDate() != null && e.verdictDate().isBefore(asOf)).findFirst();
        if (entry.isEmpty()) {
            out.put("available", false);
            out.put("note", "기준 거래일 앞 날짜의 국면 판정 기록이 없습니다");
            return out;
        }
        RegimeLogStore.Entry e = entry.get();
        long days = java.time.temporal.ChronoUnit.DAYS.between(e.verdictDate(), asOf);
        out.put("available", true);
        out.put("verdictDate", e.verdictDate().toString());
        out.put("relation", days == 1 ? "전날 판정" : days + "일 전 판정");
        out.put("code", e.code());
        out.put("label", e.label());
        out.put("inputs", e.inputs());
        out.put("missing", e.missing());
        out.put("ruleVersion", e.ruleVersion());
        out.put("note", REGIME_NOTE);
        return out;
    }

    // ------------------------------------------------------------------ 3 한국 매크로
    private Map<String, Object> krMacro(LocalDate asOf, Instant readAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> rates = new LinkedHashMap<>();
        rates.put("available", false);
        rates.put("note", RATES_NOTE);
        out.put("rates", rates);
        out.put("fx", fx(asOf, readAt));
        out.put("investorFlows", marketFlows(asOf, readAt));
        out.put("creditGap", null);
        out.put("creditGapNote", CREDIT_GAP_NOTE);
        return out;
    }

    /** 환율 일봉(기준일 이하 마지막 값·20거래일 변화). */
    private Map<String, Object> fx(LocalDate asOf, Instant readAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", "snapshot " + Datasets.SNAP_FX_HISTORY);
        out.put("note", "기준 거래일 이하 마지막 일봉 — 20거래일 변화(%)");
        Snapshot snap = reader.read(Datasets.SNAP_FX_HISTORY, Datasets.MAX_AGE_DAILY, "fx_history").orElse(null);
        if (snap == null || snap.collectedAt() == null) {
            out.put("missing", "환율 일봉 저장본이 없습니다");
            return out;
        }
        if (snap.collectedAt().isAfter(readAt)) {
            out.put("missing", LATE_SNAPSHOT + "(" + snap.collectedAtKst() + ")");
            return out;
        }
        JsonNode series = Json.child(snap.payload(), "series");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (String key : FX_KEYS) {
            JsonNode entry = series == null ? null : Json.child(series, key);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", key);
            if (entry == null) {
                row.put("missing", "계열 없음");
                rows.add(row);
                continue;
            }
            NavigableMap<LocalDate, Double> known = Json.dateValueSeries(entry, "dates", "close", null).headMap(asOf, true);
            row.put("name", Json.asText(entry, "name"));
            if (known.isEmpty()) {
                row.put("close", null);
                row.put("date", null);
                row.put("change20dPct", null);
            } else {
                row.put("close", PacketBuilder.decimal(known.lastEntry().getValue(), 4));
                row.put("date", known.lastKey().toString());
                row.put("change20dPct", PacketBuilder.decimal(SeriesMath.periodReturn(new ArrayList<>(known.values()),
                        CHANGE_TRADING_DAYS), 2));
            }
            rows.add(row);
        }
        out.put("items", rows);
        return out;
    }

    /** 코스피·코스닥 투자자별 매매대금(토스) — 기준일 기록과 기준일까지 5·20기록 합(억 원). */
    private Map<String, Object> marketFlows(LocalDate asOf, Instant readAt) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", "snapshot " + Datasets.SNAP_TOSS_MARKET_FLOWS + " — 토스 시장 투자자별 매매대금(순매수, 억 원)");
        Snapshot snap = reader.read(Datasets.SNAP_TOSS_MARKET_FLOWS, Datasets.MAX_AGE_DAILY, "toss_market_flows").orElse(null);
        if (snap == null || snap.collectedAt() == null) {
            out.put("missing", "시장 매매대금 저장본이 없습니다");
            return out;
        }
        if (snap.collectedAt().isAfter(readAt)) {
            out.put("missing", LATE_SNAPSHOT + "(" + snap.collectedAtKst() + ")");
            return out;
        }
        out.put("note", "sessionNet = 기준 거래일 기록(updatedAt = 토스 판), net5·net20 = 기준일까지 최근 기록 5·20개의 합(덜 차면 null)");
        List<Map<String, Object>> rows = new ArrayList<>();
        JsonNode markets = Json.child(snap.payload(), "markets");
        for (String market : MARKETS) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("market", market);
            List<JsonNode> records = new ArrayList<>();
            for (JsonNode record : Json.array(Json.child(markets, market), "records")) {
                LocalDate date = Json.parseDate(Json.asText(record, "date"));
                if (date != null && !date.isAfter(asOf)) {
                    records.add(record);
                }
            }
            records.sort(Comparator.comparing((JsonNode r) -> Json.parseDate(Json.asText(r, "date"))).reversed());
            JsonNode session = records.isEmpty() || !asOf.equals(Json.parseDate(Json.asText(records.get(0), "date")))
                    ? null : records.get(0);
            row.put("sessionUpdatedAt", session == null ? null : Json.asText(session, "updatedAt"));
            for (String who : MARKET_INVESTORS) {
                Map<String, Object> values = new LinkedHashMap<>();
                values.put("sessionNet", session == null ? null : eok(net(session, who)));
                values.put("net5", sumNet(records, who, 5));
                values.put("net20", sumNet(records, who, 20));
                row.put(who, values);
            }
            rows.add(row);
        }
        out.put("rows", rows);
        return out;
    }

    private static Double net(JsonNode record, String who) {
        return Json.asDouble(Json.child(Json.child(record, "investors"), who), "net");
    }

    private static BigDecimal sumNet(List<JsonNode> records, String who, int n) {
        if (records.size() < n) {
            return null;
        }
        double sum = 0;
        for (int i = 0; i < n; i++) {
            Double v = net(records.get(i), who);
            if (v == null) {
                return null;
            }
            sum += v;
        }
        return eok(sum);
    }

    private static BigDecimal eok(Double won) {
        return won == null ? null : PacketBuilder.decimal(won / HUNDRED_MILLION, 0);
    }

    // ------------------------------------------------------------------ 8 가격·수급
    /** 종목별 수정 종가 이력(기준일 이하) — 토스 {@code kr_close_adj} 뒤에 관측치의 기준일 이하 봉(수정 종가 = 종가 × 수정 비율)을 잇습니다. */
    private Map<String, DailySeries> adjustedHistory(MarketRun run, Collection<String> codes, LocalDate asOf,
                                                     Optional<Quotes> quotes) {
        Map<String, DailySeries> stored = marketData.history(run, codes, asOf.minusDays(PRICE_LOOKBACK_DAYS), asOf);
        Map<String, DailySeries> out = new LinkedHashMap<>();
        for (String code : codes) {
            DailySeries recent = null;
            Bar bar = quotes.map(q -> q.bars().get(code)).orElse(null);
            if (bar != null && bar.kr() != null) {
                TreeMap<LocalDate, Double> points = new TreeMap<>();
                for (KrQuotes.Day day : bar.kr().days()) {
                    if (day.close() != null && day.adjRatio() != null && !day.date().isAfter(asOf)) {
                        points.put(day.date(), day.close().doubleValue() * day.adjRatio());
                    }
                }
                recent = points.isEmpty() ? null : DailySeries.of(points);
            }
            DailySeries merged = PacketBuilder.merge(stored.get(code), recent, asOf, null);
            if (merged != null) {
                out.put(code, merged);
            }
        }
        return out;
    }

    private Map<String, Object> priceSection(List<Line> shown, int cut, Optional<Quotes> quotes,
                                             Map<String, DailySeries> history, Map<String, KrRules.FlowSummary> flows,
                                             Map<String, Double> scores, Map<String, String> unfillable, LocalDate asOf,
                                             KrRuleBookService.Read read) {
        List<List<Object>> rows = new ArrayList<>();
        for (Line line : shown) {
            Bar bar = quotes.map(q -> q.bars().get(line.code())).orElse(null);
            KrQuotes.Day day = null;
            if (bar != null && bar.kr() != null) {
                for (KrQuotes.Day d : bar.kr().days()) {
                    if (!d.date().isAfter(asOf)) {
                        day = d;
                    }
                }
            }
            DailySeries series = history.get(line.code());
            Map<String, Object> momentum = PacketBuilder.momentum(line.code(), line.role(), series);
            KrRules.FlowSummary f = flows.get(line.code());
            KrRules.Member m = line.member();
            List<Object> row = new ArrayList<>(PRICE_COLUMNS.size());
            row.add(line.code());
            row.add(m == null ? null : m.name());
            row.add(line.role());
            row.add(m == null ? null : m.rank());
            if (day != null && day.close() != null) {
                row.add(day.date().toString());
                row.add(day.close().stripTrailingZeros().scale() <= 0 ? day.close().setScale(0)
                        : PacketBuilder.decimal(day.close().doubleValue(), 2));
                row.add(day.priceSource());
            } else {
                // 관측치가 없으면 수정 종가 이력의 마지막 값(출처 kr_close_adj — 수정주가).
                row.add(momentum.get("date"));
                row.add(series == null || series.isEmpty() ? null : PacketBuilder.decimal(series.lastValue(), 2));
                row.add(series == null || series.isEmpty() ? null : Datasets.TS_KR_CLOSE_ADJ);
            }
            row.add(bar == null ? null : bar.stale());
            row.add(unfillable.get(line.code()));
            for (String key : List.of("ret1mPct", "ret3mPct", "ret6mPct", "ret12mPct", "vs200dPct", "vs52wHighPct")) {
                row.add(momentum.get(key));
            }
            row.add(f == null ? null : f.daysAvailable());
            row.add(f == null ? null : f.foreignNet20());
            row.add(f == null ? null : f.institutionNet20());
            row.add(f == null ? null : f.foreignNet5());
            row.add(f == null ? null : f.institutionNet5());
            row.add(f == null ? null : f.streakDays());
            row.add(PacketBuilder.decimal(scores.get(line.code()), 4));
            row.add(m == null || m.marketCap() == null ? null
                    : PacketBuilder.decimal(m.marketCap().doubleValue() / TRILLION, 2));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", Datasets.SNAP_KR_PAPER_QUOTES + "(잠정 종가·출처) + timeseries " + Datasets.TS_KR_CLOSE_ADJ
                + "(토스 수정 종가 이력 — 수익률) + observations " + Datasets.OBS_KR_PAPER_FLOW + "(수급) + "
                + Datasets.OBS_KR_PAPER_UNIVERSE + "(순위·시총) — 기준일(" + asOf + ")까지");
        out.put("note", "role = HOLDING(보유)·ETF(069500 = KODEX 200 — 벤치마크, 153130 = 단기채 ETF — 현금성)·UNIVERSE(U 구성원, "
                + "flowScore 높은 순). close = 기준일 "
                + "잠정 종가(원, 금융위 확정 전 — priceSource TOSS_INTEGRATED = KRX+NXT 통합가, TOSS_DAILY = 토스가 NXT 미지원으로 표시한 봉: "
                + "시가는 KRX 시가 단일가지만 종가에는 20:00까지의 장 마감 뒤 체결이 섞일 수 있음), 관측치에 없으면 수정 종가 이력의 "
                + "마지막 값(priceSource kr_close_adj). stale = 이번 관측치에서 받지 못해 이어 쓴 항목. unfillable = 지금 체결할 수 없는 사유"
                + "(이번 관측치에 봉 없음·기준일 거래정지·미처리 기업행위 보유 — 그 종목 매수는 거절, 12_hardRules). ret = 1·3·6·12개월"
                + "(21·63·126·252거래일) 수정 종가 수익률(%), vs200dPct = 200일 평균 대비, vs52wHighPct = 52주 고점 대비(이력이 짧으면 null)");
        out.put("flowsNote", "flowDays = 20거래일 창(" + read.windowStart() + "~" + asOf + ") 중 외국인·기관 기록이 모두 있는 날 수, "
                + "foreign20·institution20 = 창 합(주, 창이 덜 차면 null), foreign5·institution5 = 마지막 5거래일 합, streakDays = 기준일부터 "
                + "거슬러 둘 다 순매수한 연속일, flowScore = (foreign20 + institution20) ÷ 상장주식수 × 100(규칙 계좌와 같은 점수 — 참고), "
                + "marketCapTrilKrw = U 기준일 시가총액(조 원). 수급은 토스 집계(KRX·NXT 통합) — 결정 전에 받은 기록만");
        out.put("universeAsOf", read.input().universeDate().toString());
        out.put("columns", PRICE_COLUMNS);
        out.put("rows", rows);
        if (cut > 0) {
            out.put("omitted", cut);
            out.put("omittedNote", "패킷 크기 예산(" + targetTokens + "토큰)에 맞춰 flowScore가 낮은 U 종목 " + cut
                    + "개를 뺐다(보유·ETF는 빼지 않음) — 12_hardRules.universe에는 그대로 있다");
        }
        if (!read.excluded().isEmpty()) {
            out.put("flowsExcluded", new TreeMap<>(read.excluded()));
        }
        return out;
    }

    // ------------------------------------------------------------------ 8b 재무
    private Map<String, Object> fundamentalsSection(List<Line> shown, int cut, Map<String, KrRules.Member> members,
                                                    JsonNode companies, LocalDate asOf, Snapshot dart,
                                                    String dartMissing, PaperSettings paper) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", "snapshot " + Datasets.SNAP_DART_FUNDAMENTALS + " — DART 사업보고서 주요계정(회사마다 마지막 보고서 하나)");
        out.put("rule", "접수일(rceptNo 앞 8자리) ≤ 기준일(" + asOf + ")인 보고서만 — 아니면 값 없이 status에 사유");
        out.put("units", "% — 사업보고서 연간·기말. ROE = 당기순이익 ÷ 기말 자본총계, opTurn = 영업이익 흑자·적자 전환, per·pbr = U 기준일 시가총액 ÷ "
                + "당기순이익·자본총계(배 — 시점이 다름)");
        out.put("financialSectorNote", "financialSector = 금융업 코드 표(" + KrFinancialSector.VERSION + ")의 회사 — 부채비율이 커도 정상");
        if (dart == null) {
            out.put("missing", dartMissing == null ? "DART 주요계정 저장본이 없습니다" : dartMissing);
            return out;
        }
        List<List<Object>> rows = new ArrayList<>();
        List<String> excluded = new ArrayList<>();
        for (Line line : shown) {
            if (ETF.equals(line.role()) || paper.cashLike(line.code())) {
                excluded.add(line.code());
                continue;
            }
            JsonNode company = companies == null ? null : companies.get(line.code());
            List<Object> row = new ArrayList<>(FUNDAMENTAL_COLUMNS.size());
            row.add(line.code());
            if (company == null || !company.isObject()) {
                row.add(null);
                row.add(null);
                for (int i = 0; i < 9; i++) {
                    row.add(null);
                }
                row.add(KrFinancialSector.contains(line.code()));
                row.add(KrRules.NO_DART);
                rows.add(row);
                continue;
            }
            String rceptNo = Json.asText(company, "rceptNo");
            KrRules.Financials financials = KrRules.Financials.fromAccounts(Json.asText(company, "bsnsYear"), rceptNo,
                    KrRuleBookService.accounts(Json.child(company, "accounts")));
            LocalDate receipt = financials.receiptDate();
            String status = receipt == null ? KrRules.RECEIPT_UNKNOWN
                    : receipt.isAfter(asOf) ? KrRules.RECEIPT_AFTER_BASE : null;
            row.add(Json.asText(company, "bsnsYear"));
            row.add(rceptNo);
            if (status != null) {
                for (int i = 0; i < 9; i++) {
                    row.add(null);
                }
            } else {
                Map<String, KrFundamentals.Amounts> accounts = KrRuleBookService.accounts(Json.child(company, "accounts"));
                Map<String, Object> metrics = KrFundamentals.metrics(accounts);
                row.add(PacketBuilder.decimal((Double) metrics.get("roe"), 2));
                row.add(PacketBuilder.decimal((Double) metrics.get("debtRatio"), 1));
                row.add(PacketBuilder.decimal((Double) metrics.get("operatingMargin"), 2));
                row.add(PacketBuilder.decimal((Double) metrics.get("revenueGrowth"), 2));
                row.add(PacketBuilder.decimal((Double) metrics.get("operatingIncomeGrowth"), 2));
                row.add(metrics.get("operatingTurn"));
                KrRules.Member member = members.get(line.code());
                KrFundamentals.Amounts net = accounts.get(KrFundamentals.NET_INCOME);
                KrFundamentals.Amounts equity = accounts.get(KrFundamentals.EQUITY);
                Map<String, Object> valuation = KrFundamentals.valuation(
                        member == null || member.marketCap() == null ? null : member.marketCap().doubleValue(),
                        net == null ? null : net.current(), equity == null ? null : equity.current(),
                        Json.asText(company, "currency"));
                row.add(PacketBuilder.decimal((Double) valuation.get("per"), 2));
                row.add(PacketBuilder.decimal((Double) valuation.get("pbr"), 2));
                row.add(financials.capitalImpaired());
            }
            row.add(KrFinancialSector.contains(line.code()));
            row.add(status);
            rows.add(row);
        }
        out.put("collectedAtKst", dart.collectedAtKst());
        out.put("columns", FUNDAMENTAL_COLUMNS);
        out.put("rows", rows);
        out.put("excluded", excluded);
        if (cut > 0) {
            out.put("omitted", cut);
        }
        return out;
    }

    // ------------------------------------------------------------------ 9 포트폴리오
    /** 한국 Claude 계좌 장부(출발 결정이면 출발 현금만). pending = 앞선 결정이 남긴 대기 주문(출처 CLAUDE, 만든 순). */
    private record LedgerView(boolean exists, String status, double cash, double nav, double equityValue,
                              double exposurePct, List<Position> positions, List<Lockout> lockouts, int monthlyOrders,
                              List<Order> pending) {
    }

    private LedgerView ledger(LocalDate asOf, boolean initial) {
        Optional<Book> book = store.book(PaperBooks.KR_CLAUDE);
        if (initial) {
            double cash = book.map(Book::initialCash).orElse(config.krInitialCash().doubleValue());
            return new LedgerView(book.isPresent(), book.map(Book::status).orElse(null), cash, cash, 0, 0, List.of(),
                    List.of(), 0, List.of());
        }
        Optional<BookState> state = store.state(PaperBooks.KR_CLAUDE);
        if (book.isEmpty() || state.isEmpty()) {
            double cash = config.krInitialCash().doubleValue();
            return new LedgerView(false, null, cash, cash, 0, 0, List.of(), List.of(), 0, List.of());
        }
        int monthly = monthlyDiscretionaryOrders(store, asOf);
        List<Order> pending = store.ordersByStatus(PaperBooks.KR_CLAUDE, PaperBooks.ORDER_PENDING).stream()
                .filter(o -> PacketBuilder.SOURCE_CLAUDE.equals(o.source())).toList();
        BookState s = state.get();
        return new LedgerView(true, book.get().status(), s.cash(), s.nav(), s.equityValue(), s.exposurePct(),
                store.positions(PaperBooks.KR_CLAUDE), store.lockouts(PaperBooks.KR_CLAUDE), monthly, pending);
    }

    /**
     * 이달(기준 거래일의 달) 재량 주문 수 — 미국 {@link PacketBuilder#monthlyDiscretionaryOrders}와 같은 규칙(출처 CLAUDE·기준일이 그 달이고 기준일
     * 이하·체결된 주문)에 <b>출발 결정(INITIAL)의 주문을 뺍니다</b> — 미국은 출발 배분이 사후 체결({@code BACKFILL})이라 그 시점으로 빠지지만 한국 출발은
     * {@code NEXT_OPEN} 주문이라 결정 종류로 가립니다(같은 원칙 — 출발 배분은 과매매가 아님, E1a에서 정함). 한국 검증기(E2)가 같은 함수를 써야 합니다.
     */
    static int monthlyDiscretionaryOrders(PaperStore store, LocalDate asOf) {
        return monthlyDiscretionaryOrders(store, PaperBooks.KR_CLAUDE, asOf);
    }

    /**
     * 그 계좌의 이달 재량 주문 수 — {@link #monthlyDiscretionaryOrders(PaperStore, LocalDate)}와 같은 계산(출발 결정 INITIAL의 주문을 뺌)을 그 계좌
     * 코드로. 앞으로 체결로 출발하는 미국 Claude 계좌2도 같은 계산을 씁니다(계좌2 명세 §4-1의 5·§10-5 — 출발 주문은 BACKFILL이 아님).
     */
    static int monthlyDiscretionaryOrders(PaperStore store, String book, LocalDate asOf) {
        List<Order> orders = store.recentOrders(book, PacketBuilder.MONTHLY_SCAN);
        YearMonth month = YearMonth.from(asOf);
        Map<Long, Boolean> initialDecision = new HashMap<>();
        int count = 0;
        for (Order o : orders) {
            if (!PacketBuilder.SOURCE_CLAUDE.equals(o.source()) || o.asOfTradingDate() == null
                    || o.asOfTradingDate().isAfter(asOf) || !YearMonth.from(o.asOfTradingDate()).equals(month)
                    || !PaperBooks.ORDER_FILLED.equals(o.status()) || PaperBooks.BACKFILL.equals(o.timing())) {
                continue;
            }
            boolean initial = o.decisionId() != null && initialDecision.computeIfAbsent(o.decisionId(),
                    id -> store.decision(id).map(d -> RuleBookService.INITIAL.equals(d.kind())).orElse(false));
            if (!initial) {
                count++;
            }
        }
        return count;
    }

    private Map<String, Object> portfolio(TradingCalendar calendar, LocalDate asOf, boolean initial, LedgerView ledger,
                                          PaperSettings paper, Limits limits, Map<String, String> holds) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("book", PaperBooks.KR_CLAUDE);
        out.put("status", ledger.status());
        out.put("currency", Book.CURRENCY_KRW);
        if (initial) {
            out.put("note", "출발 결정 — 출발 현금만(보유 없음)");
        } else if (!ledger.exists()) {
            out.put("note", "한국 Claude 계좌 장부가 없습니다(한국 초기화 전) — 출발 현금 기준");
        }
        out.put("nav", PacketBuilder.decimal(ledger.nav(), 0));
        out.put("cash", PacketBuilder.decimal(ledger.cash(), 0));
        out.put("equityValue", PacketBuilder.decimal(ledger.equityValue(), 0));
        out.put("currentExposurePct", PacketBuilder.decimal(ledger.exposurePct(), 2));
        List<Map<String, Object>> positions = new ArrayList<>();
        for (Position p : ledger.positions().stream().sorted(Comparator.comparing(Position::ticker)).toList()) {
            boolean cashLike = paper.cashLike(p.ticker());
            double price = p.lastPrice() != null ? p.lastPrice() : p.avgCost();
            Double stop = cashLike ? null : TrailingStop.stopPrice(p.highWatermark(), paper.trailingStopPct());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", p.ticker());
            row.put("qty", p.qty());
            row.put("avgCost", PacketBuilder.decimal(p.avgCost(), 2));
            row.put("price", PacketBuilder.decimal(price, 2));
            row.put("priceStale", p.priceStale() || p.lastPrice() == null);
            row.put("weightPct", PacketBuilder.decimal(ledger.nav() > 0 ? p.qty() * price / ledger.nav() * 100.0 : null, 2));
            row.put("unrealizedPct", PacketBuilder.decimal(p.avgCost() > 0 ? (price / p.avgCost() - 1.0) * 100.0 : null, 2));
            row.put("highWatermark", PacketBuilder.decimal(p.highWatermark(), 2));
            row.put("stopPrice", PacketBuilder.decimal(stop, 2));
            row.put("stopDistancePct", PacketBuilder.decimal(stop != null && stop > 0 ? (price / stop - 1.0) * 100.0 : null,
                    2));
            row.put("openedOn", text(p.openedOn()));
            row.put("holdingTradingDays", p.openedOn() == null ? null : calendar.tradingDaysBetween(p.openedOn(), asOf));
            row.put("cashLike", cashLike);
            row.put("corpActionHold", holds.get(p.ticker()));
            positions.add(row);
        }
        out.put("positions", positions);
        List<Map<String, Object>> lockouts = new ArrayList<>();
        for (Lockout l : ledger.lockouts()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", l.ticker());
            row.put("untilTradingDate", text(l.untilTradingDate()));
            row.put("reason", clip(l.reason(), MAX_REASON_CHARS));
            lockouts.add(row);
        }
        out.put("lockouts", lockouts);
        Map<String, Object> monthly = new LinkedHashMap<>();
        monthly.put("month", YearMonth.from(asOf).toString());
        monthly.put("used", ledger.monthlyOrders());
        monthly.put("cap", limits.maxDiscretionaryOrdersPerMonth());
        out.put("monthlyDiscretionaryOrders", monthly);
        out.put("pendingOrders", pendingOrders(ledger.pending()));
        return out;
    }

    private Map<String, Object> pendingOrders(List<Order> pending) {
        Map<Long, String> kinds = new TreeMap<>();
        List<List<Object>> rows = new ArrayList<>();
        for (Order o : pending) {
            boolean buy = OrderValidator.BUY.equals(o.side());
            String kind = o.decisionId() == null ? null : kinds.computeIfAbsent(o.decisionId(),
                    id -> store.decision(id).map(Decision::kind).orElse(null));
            List<Object> row = new ArrayList<>(PENDING_COLUMNS.size());
            row.add(o.ticker());
            row.add(o.side());
            row.add(buy ? PacketBuilder.decimal(Json.asDouble(o.reason(), "targetWeightPct"), 4) : null);
            row.add(buy ? PacketBuilder.decimal(o.targetWeightPct(), 4) : null);
            row.add(buy ? null : PacketBuilder.decimal(o.sellFraction(), 4));
            row.add(o.timing());
            row.add(text(o.asOfTradingDate()));
            row.add(kind);
            row.add(text(o.expiresOn()));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", "앞선 결정이 낸 아직 체결되지 않은 주문(보유·현금에 아직 반영 안 됨). " + PacketBuilder.PENDING_SUPERSEDED
                + ". targetWeightPct = 그 매수의 목표 비중, orderWeightPct = 매수 증가분, SELL의 sellFraction null = 전량");
        out.put("columns", PENDING_COLUMNS);
        out.put("rows", rows);
        return out;
    }

    // ------------------------------------------------------------------ 10·11 최근 결정·메모
    private List<DecisionSummary> priorDecisions(LocalDate asOf, String kind, boolean initial) {
        return store.decisions(PaperBooks.KR_CLAUDE, MAX_RECENT_DECISIONS * 4).stream()
                .filter(d -> d.asOfTradingDate().isBefore(asOf)
                        || !initial && d.asOfTradingDate().equals(asOf) && !d.kind().equals(kind))
                .limit(MAX_RECENT_DECISIONS).toList();
    }

    private Map<String, Object> recentDecisions(List<DecisionSummary> recent) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (DecisionSummary d : recent) {
            JsonNode response = store.decision(d.id()).map(Decision::response).orElse(null);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("tradingDate", d.asOfTradingDate().toString());
            row.put("kind", d.kind());
            row.put("status", d.status());
            row.put("stance", Json.asText(response, "stance"));
            row.put("targetExposurePct", PacketBuilder.decimal(d.targetExposurePct(), 2));
            row.put("summary", clip(d.summary(), SUMMARY_CHARS));
            row.put("acceptedOrders", d.orderCount() - d.rejectedCount());
            row.put("rejectedOrders", d.rejectedCount());
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", rows.isEmpty() ? "앞선 결정 없음" : "최근 순 — 요약은 " + SUMMARY_CHARS + "자까지");
        out.put("decisions", rows);
        return out;
    }

    /** 섹션 11 — 미국 패킷과 같은 모양(본문은 text에만, 목록은 번호·날짜·제목). */
    private static Map<String, Object> notesSection(NoteService.PacketNotes packetNotes) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> note : packetNotes.notes()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (String key : List.of("id", "asOfDate", "expiresOn", "title")) {
                row.put(key, note.get(key));
            }
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("market", Book.MARKET_KR);
        out.put("instruction", packetNotes.note());
        out.put("text", packetNotes.text());
        out.put("notes", rows);
        out.put("maxChars", packetNotes.maxChars());
        out.put("omitted", packetNotes.omitted());
        return out;
    }

    // ------------------------------------------------------------------ 11b 사건
    private KrEventsSection.Built events(MarketRun run, TradingCalendar calendar, LocalDate asOf, JsonNode body,
                                         Instant readAt, Map<String, Line> lines, Map<String, KrRules.Member> members,
                                         JsonNode companies, Set<String> etfs, PaperSettings paper) {
        LocalTime decisionTime = PaperDecisionJob.decisionTime(run, body);
        NewsEvents.Window window = NewsEvents.window(calendar, asOf, d -> run.decisionInstant(d, decisionTime));
        KrEventsSection.NewsSettings news = KrEventsSection.settings(body);
        List<JsonNode> rows = news.settings().enabled()
                ? repository.readObservationsBetween(Datasets.OBS_KR_NEWS_HEADLINE, KrEventsSection.readFrom(window), null)
                : List.of();
        JsonNode status = null;
        if (news.settings().enabled()) {
            Snapshot snap = reader.readStored(Datasets.SNAP_KR_NEWS_STATUS).orElse(null);
            status = snap == null || snap.collectedAt() == null || snap.collectedAt().isAfter(readAt) ? null : snap.payload();
        }
        // 대상 = 보유·U의 주식(ETF·현금성 빼고) — 이름은 금융위 종목명·DART 회사명(코드와 같으면 뺌)·설정 별칭.
        Map<String, List<String>> names = new TreeMap<>();
        for (Line line : lines.values()) {
            if (etfs.contains(line.code()) || paper.cashLike(line.code())) {
                continue;
            }
            List<String> list = new ArrayList<>();
            KrRules.Member member = members.get(line.code());
            if (member != null && member.name() != null) {
                list.add(member.name());
            }
            JsonNode company = companies == null ? null : companies.get(line.code());
            String dartName = Json.asText(company, "name");
            if (dartName != null && !dartName.isBlank() && !dartName.strip().equals(line.code())) {
                list.add(dartName);
            }
            list.addAll(news.aliases().getOrDefault(line.code(), List.of()));
            names.put(line.code(), list);
        }
        return KrEventsSection.build(rows, window, readAt, news, names, status);
    }

    // ------------------------------------------------------------------ 12 하드 규칙
    private static Map<String, Object> hardRules(MarketRun run, LocalDate asOf, boolean initial, Limits limits,
                                                 PaperSettings paper, Set<String> etfs, Set<String> universe,
                                                 Set<String> lockedOut, Map<String, String> unfillable,
                                                 Optional<Quotes> quotes, LocalDate universeDate) {
        PaperSettings.CostRates rates = paper.costRates() == null ? PaperSettings.CostRates.defaults() : paper.costRates();
        String cashLike = String.join(", ", paper.cashLikeTickers());
        List<String> lines = new ArrayList<>();
        lines.add(PacketBuilder.NO_CASH_BOUNDS + ". 노출 0%·100% 모두 거절 사유가 아니다(매크로 조건도 검사하지 않음).");
        lines.add(String.format(Locale.ROOT, "BUY의 targetWeightPct = 그 종목의 목표 비중(체결 시점 순자산 대비 %%, 이미 보유분 포함). "
                        + "종목 ≤ %s%%, ETF(etfTickers) ≤ %s%%, 현금성(%s)은 상한 없음. 매수 뒤 최대 %d종목.",
                plain(limits.maxWeightStockPct()), plain(limits.maxWeightEtfPct()), cashLike.isEmpty() ? "없음" : cashLike,
                limits.maxPositions()));
        lines.add("BUY는 정수 주로 체결된다 — 매수 증가분 금액이 1주 체결가(수수료·슬리피지 포함)보다 작으면 BUY_BELOW_ONE_SHARE로 거절.");
        lines.add("SELL의 sellFraction = 보유 수량 대비 파는 비율(0 초과 1 이하, null이면 전량). 보유가 없는 종목은 팔 수 없다. "
                + "부분 매도는 1주 이상이어야 한다 — floor(보유 수량 × sellFraction) < 1이면 BELOW_ONE_SHARE로 거절"
                + "(보유 수량은 9_portfolio.positions의 qty).");
        lines.add(KrPaperMarket.ALLOW_NEXT_CLOSE
                ? "매수 목표 합 + 매도 뒤 남는 보유 비중이 100%를 넘으면 목표 비중이 큰 주문부터 받고 넘치는 주문은 거절(OVER_ALLOCATED). "
                        + "매도는 같은 시점이거나 더 늦은 매수의 자리만 만든다 — NEXT_CLOSE 매도는 NEXT_OPEN 매수보다 늦게 체결되므로 "
                        + "NEXT_OPEN 매수의 현금(비중 합, OVER_ALLOCATED)·종목 자리(최대 종목 수, MAX_POSITIONS)를 비우지 못한다. "
                        + "unfillableTickers 종목의 매도는 어느 시점 매수의 자리도 만들지 못한다."
                : "매수 목표 합 + 매도 뒤 남는 보유 비중이 100%를 넘으면 목표 비중이 큰 주문부터 받고 넘치는 주문은 거절(OVER_ALLOCATED). "
                        + "매도와 매수가 모두 같은 다음 거래일 시가에 체결되므로 매도는 그 매수들의 현금·종목 자리를 만든다 — 단 "
                        + "unfillableTickers 종목의 매도는 그 시가에 체결되지 않으므로 현금(OVER_ALLOCATED)·종목 자리(MAX_POSITIONS)를 "
                        + "만들지 못한다.");
        lines.add(String.format(Locale.ROOT, "매수 증가분 금액 < %s원 거절. ", won(limits.minOrderNotional()))
                + (initial
                ? String.format(Locale.ROOT, "재량 주문 월 %d건 상한은 출발 결정에도 걸린다 — 이번 결정 안에서 %d건까지만 받고(매도 먼저 목록 순, "
                        + "그다음 매수를 목표 비중 큰 순) 넘치면 MONTHLY_CAP. 출발 결정 주문은 이후 결정의 이달 누계에는 세지 않는다. ",
                limits.maxDiscretionaryOrdersPerMonth(), limits.maxDiscretionaryOrdersPerMonth())
                : String.format(Locale.ROOT, "재량 주문 월 %d건까지 — 이번 결정은 상한에서 이달 체결된 정기·수동 결정 주문 수"
                        + "(9_portfolio.monthlyDiscretionaryOrders.used, 출발 결정 주문 제외)를 뺀 건수까지만 받고(매도 먼저 목록 순, 그다음 "
                        + "매수를 목표 비중 큰 순) 넘치면 MONTHLY_CAP. ", limits.maxDiscretionaryOrdersPerMonth()))
                + String.format(Locale.ROOT, "재량 매도는 보유 %d거래일 뒤부터.", limits.minHoldTradingDaysForSell()));
        lines.add(String.format(Locale.ROOT, "트레일링 스탑 −%s%%는 코드가 밤마다 잠정 종가로 감지해 다음 거래일 시가에 매도한다(체결 때 확정 "
                        + "종가로 다시 판정, 최고가는 KRX 기준 종가로만 오름). 스탑 뒤 %d거래일 재진입 금지.",
                plain(paper.trailingStopPct()), paper.lockoutTradingDays()));
        lines.add("유니버스(universe — U = 코스피 시가총액 상위 100 보통주, 금융위 기준일 universeAsOf ∪ etfTickers) 밖·같은 티커 두 번·"
                + "재진입 금지 종목의 주문은 거절. 보유 종목은 U 밖이어도 팔 수 있다. unfillableTickers(지금 체결할 수 없는 종목 — 이번 관측치에 "
                + "봉 없음·기준 거래일 거래정지·미처리 기업행위 보유, 규칙 계좌와 같은 판정)의 매수는 UNFILLABLE로 거절. 그 종목 보유의 "
                + "매도는 받아 대기로 두고, 만료 전에 풀리면 그 뒤 첫 시가에 체결된다(규칙 계좌와 같음).");
        lines.add("주문은 기준 거래일 뒤 첫 관측 봉(거래량 > 0)의 시가로 체결된다 — 기준 거래일 이하 봉·주문보다 먼저 받은 관측치·거래정지일"
                + "(거래량 0) 봉으로는 체결되지 않고, 체결되지 않은 주문은 기준일 + 3거래일에 만료된다.");
        if (!initial) {
            lines.add("9_portfolio.pendingOrders(앞선 결정의 대기 주문): " + PacketBuilder.PENDING_SUPERSEDED + ".");
        }
        lines.add(costLine(rates, paper.slippageBp()) + " 호가 — " + KrxCosts.tickTableText() + ".");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("noCashBounds", PacketBuilder.NO_CASH_BOUNDS);
        out.put("lines", lines);
        out.put("currency", Book.CURRENCY_KRW);
        out.put("maxWeightStockPct", PacketBuilder.decimal(limits.maxWeightStockPct(), 4));
        out.put("maxWeightEtfPct", PacketBuilder.decimal(limits.maxWeightEtfPct(), 4));
        out.put("maxPositions", limits.maxPositions());
        out.put("minOrderNotional", PacketBuilder.decimal(limits.minOrderNotional(), 0));
        out.put("maxDiscretionaryOrdersPerMonth", limits.maxDiscretionaryOrdersPerMonth());
        out.put("minHoldTradingDaysForSell", limits.minHoldTradingDaysForSell());
        out.put("trailingStopPct", PacketBuilder.decimal(paper.trailingStopPct(), 4));
        out.put("lockoutTradingDays", paper.lockoutTradingDays());
        out.put("timings", run.timings());
        out.put("commissionBp", PacketBuilder.decimal(rates.commissionBp(), 4));
        out.put("slippageBp", PacketBuilder.decimal(paper.slippageBp(), 4));
        Map<String, Object> tax = new LinkedHashMap<>();
        tax.put("effectiveFrom", rates.tax().effectiveFrom().toString());
        tax.put("kospiSttBp", PacketBuilder.decimal(rates.tax().kospiSttBp().doubleValue(), 4));
        tax.put("kospiRuralBp", PacketBuilder.decimal(rates.tax().kospiRuralBp().doubleValue(), 4));
        tax.put("kosdaqSttBp", PacketBuilder.decimal(rates.tax().kosdaqSttBp().doubleValue(), 4));
        tax.put("etfBp", PacketBuilder.decimal(rates.tax().etfBp().doubleValue(), 4));
        out.put("sellTax", tax);
        out.put("cashLikeTickers", paper.cashLikeTickers());
        out.put("etfTickers", List.copyOf(new TreeSet<>(etfs)));
        out.put("lockedOut", List.copyOf(lockedOut));
        out.put("unfillableTickers", unfillable);
        out.put("quotesSession", quotes.map(Quotes::session).map(LocalDate::toString).orElse(null));
        out.put("quotesCollectedAtKst", quotes.map(q -> Kst.stamp(q.collectedAt())).orElse(null));
        out.put("universeAsOf", universeDate.toString());
        out.put("universeSize", universe.size());
        out.put("universe", String.join(",", universe));
        return out;
    }

    // ------------------------------------------------------------------ 조각
    /** 설정 {@code kr.universeExtraTickers}(빈 목록만 저장됨 — C1b d6). */
    private static List<String> extraTickers(JsonNode body) {
        JsonNode extra = Json.child(Json.child(body, "kr"), "universeExtraTickers");
        List<String> out = new ArrayList<>();
        if (extra != null && extra.isArray()) {
            for (JsonNode item : extra) {
                if (item.isString() && !item.asString("").isBlank()) {
                    out.add(item.asString("").strip().toUpperCase(Locale.ROOT));
                }
            }
        }
        return out;
    }

    private static DailySeries series(TimeseriesColumns column, LocalDate asOf) {
        if (column == null || column.size() == 0) {
            return null;
        }
        DailySeries s = new DailySeries(column.epochDays(), column.values()).until(asOf);
        return s.isEmpty() ? null : s;
    }

    /** 카드 시각 글({@code "2026-10-28 15:23 KST (…)"})의 KST 날짜. 읽을 수 없으면 null. */
    static LocalDate kstDate(String lastTs) {
        if (lastTs == null) {
            return null;
        }
        Matcher m = STAMP.matcher(lastTs.strip());
        if (!m.find()) {
            return null;
        }
        try {
            return LocalDate.parse(m.group(1));
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static String won(double amount) {
        return String.format(Locale.ROOT, "%,d", Math.round(amount));
    }

    private static String plain(double value) {
        BigDecimal d = PacketBuilder.decimal(value, 4);
        return d == null ? "?" : d.toPlainString();
    }

    private static String clip(String text, int max) {
        if (text == null || text.length() <= max) {
            return text;
        }
        return text.substring(0, max - 1) + "…";
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
