package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * 🧪 한국 책의 시장 묶음({@link PaperMarket}, 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4 — C1c). 미국 묶음과 달리 <b>고정 달력이
 * 없습니다</b>: 실행을 열 때마다({@link PaperMarkets#open}) 그 실행이 조용히 읽은 공휴일 저장본({@code calendar.kr_holidays})과 그 실행이
 * 읽은 설정 판의 임시휴장({@code kr.calendar.extraClosures})·장 시간 변경일({@code kr.calendar.openTimeOverrides} — 결정 d8)로
 * {@link KrxCalendar}를 한 벌 만듭니다({@link #openCalendar}). 실행 밖에서 달력을 물으면({@link #calendar()}) 던집니다.
 *
 * <ul>
 *   <li>시장·통화 KR·KRW, 설정 접두어·작업 기록 접두어 {@code kr.}</li>
 *   <li>관측치 {@code paper.kr.quotes}(수집기 {@code kr_paper_quotes}, KR 거래일 D 20:30 뒤 하루 1회 — K17)·이력 {@code kr_close_adj};
 *       파싱({@link #parse} — 계약 1, {@link KrQuotes})과 체결 선택(결정 d10)은 시장 몫(C2b)</li>
 *   <li>확정 판정 셋(결정 d9, C2a): 종가 나옴 = 그날 한국 수집 시각(20:30) 이후 수집({@link #closeAvailable}), 그 시점 가격 있음 = 시가
 *       사다리(C2b — {@link #fillable}), 확정 = 아직 없음(금융위 확정 조정은 C3 — {@link #pricesConfirmed})</li>
 *   <li>체결(C2b — {@link KrFills}): 기준 거래일 뒤 첫 관측 봉의 시가 사다리({@link #fillBar}, 1분봉 FAILED는 결정 기한 뒤 수집본까지
 *       기다림 — 결정 d11), 체결가 = 관측가·비용 칸({@link #fill}), 시가 체결 장부 순서({@link #auctionFills})</li>
 *   <li>관측치 늦음 = 다음 수집 예정 + 여유(결정 d5, 명세 §4-9 'C1a에서 정한 것' — {@link #quotesLateAt})</li>
 *   <li>계좌 넷({@link PaperBooks#KR} — K1·§4-8), 비교 기준 {@code kr_bench_k200}, 현금성 기본 153130, 최소 주문 기본 500,000원</li>
 *   <li>체결 시점 {@code NEXT_OPEN}뿐 — {@code NEXT_CLOSE}는 G2 판정 뒤 정하는 코드 상수 {@link #ALLOW_NEXT_CLOSE}(지금 false, K13·K38)</li>
 *   <li>결정 22:30·기한 01:00 KST(K6), 세션 D <b>그날</b>의 그 시각 — 09:00 전 시각은 D+1 아침(설정 저장 규칙과 같은 뜻, 명세 §4-13
 *       'C1b 구현에서 정한 것')</li>
 *   <li>복기 토요일 22:30 KST(K19 코드 상수)</li>
 *   <li>Claude 시스템 프롬프트의 하드 규칙 줄·고정 문단은 E2({@code KR_FIXED_RULES}) — 그 전에 부르면 던집니다(한국 Claude 계좌는 E2까지
 *       시작하지 않음)</li>
 * </ul>
 */
final class KrPaperMarket implements PaperMarket {

    static final KrPaperMarket INSTANCE = new KrPaperMarket();

    /**
     * Claude 계좌의 {@code NEXT_CLOSE}(다음 거래일 종가 — 1분봉 15:30 단일가 봉) 허용 — G2(1분봉 15:30 봉 = 금융위 종가) 판정 뒤 정하는 코드
     * 상수입니다(K13·K38 — 설정이면 정적 스키마의 timing enum·프롬프트 문장을 맞출 수 없음). G2를 아직 판정하지 않아 false.
     */
    static final boolean ALLOW_NEXT_CLOSE = false;

    /** 관측치를 채우는 수집기 태스크(B4). */
    static final String QUOTES_TASK = "kr_paper_quotes";
    /** 공휴일 저장본을 채우는 수집기 태스크(조용히 읽으므로 요청하지는 않음 — 이름은 저장본 읽기의 인자). */
    static final String HOLIDAYS_TASK = "kr_holidays";

    /** 한국 수집 태스크가 KR 거래일 D의 값을 받기 시작하는 시각(KST) — 수집기 {@code kr_paper.KR_COLLECT_AFTER}(K17). */
    static final LocalTime COLLECT_AFTER = LocalTime.of(20, 30);
    /** 서버 창이 매일 여는 시각(KST, ADR 0019 — 그 뒤 첫 slow가 그날 한국 수집). */
    static final LocalTime SERVER_WINDOW_OPENS = LocalTime.of(21, 55);
    /**
     * 늦음 여유 — 다음 수집 예정에서 이만큼 지나면 늦음(명세 §4-9 'C1a에서 정한 것' 2시간 5분 = 기동 직후 slow와 그 다음 slow가 연달아
     * 새 저장본을 내지 못한 뒤, 한국 결정 기한 D′+1 01:00보다 한 시간 앞).
     */
    static final Duration QUOTES_LATE_MARGIN = Duration.ofMinutes(125);
    /** 결정 시각·기한 기본값(KST, K6 — 설정 {@code kr.decisionTimeKst}·{@code kr.decisionDeadlineKst}의 기본값과 같음). */
    static final LocalTime DEFAULT_DECISION_TIME = LocalTime.parse(PaperSettingsService.KR_DEFAULT_DECISION_TIME);
    static final LocalTime DEFAULT_DEADLINE = LocalTime.parse(PaperSettingsService.KR_DEFAULT_DECISION_DEADLINE);
    /** 이 시각 전의 결정·기한 시각은 세션 다음 날 아침으로 읽습니다(다음 개장 09:00 — {@link PaperSettingsService#KR_NEXT_OPEN}). */
    static final LocalTime NEXT_MORNING_BEFORE = PaperSettingsService.KR_NEXT_OPEN;

    /** 한국 주간 복기 — 토요일 22:30 KST(K19, 미국 {@code ReviewFacts.OPENS_AT}처럼 코드 상수). */
    static final DayOfWeek REVIEW_OPENS_ON = DayOfWeek.SATURDAY;
    static final LocalTime REVIEW_OPENS_AT = LocalTime.of(22, 30);

    /** 한국 계좌가 없을 때 정기 작업이 한국을 건너뛰는 사유({@link #dormantReason}). */
    static final String NOT_INITIALIZED = "한국 계좌가 없습니다 — 한국 초기화 전에는 한국 정기 작업(리스크 점검·결정·복기)을 돌리지 않습니다";

    /** 검증기 근거 문구의 금액 표기 — 원, 소수 없음. */
    static final OrderValidator.Money KRW = new OrderValidator.Money("", "원", 0);

    /**
     * 벤치마크 종목(한국 계좌 정의의 비중 종목 — 069500·153130) — 설정 현금성({@code kr.cashLikeTickers})과 함께 비용 계산의 ETF 목록(§4-3
     * '시장 구분은 금융위, ETF는 설정 목록(kr.cashLikeTickers·벤치마크 종목)').
     */
    static final java.util.Set<String> BENCHMARK_TICKERS = PaperBooks.KR.stream()
            .flatMap(definition -> definition.weights().keySet().stream())
            .collect(java.util.stream.Collectors.toUnmodifiableSet());

    private static final List<String> TIMINGS = ALLOW_NEXT_CLOSE
            ? List.of(PaperBooks.NEXT_OPEN, PaperBooks.NEXT_CLOSE) : List.of(PaperBooks.NEXT_OPEN);
    private static final Map<String, String> TIMING_NAMES = timingNames(TIMINGS);
    private static final Pattern ISO_DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");

    private KrPaperMarket() {
    }

    @Override
    public String code() {
        return PaperStore.Book.MARKET_KR;
    }

    @Override
    public String currency() {
        return PaperStore.Book.CURRENCY_KRW;
    }

    /**
     * @throws IllegalStateException 늘 — 한국 달력은 실행마다 만듭니다(클래스 설명). 실행 문맥({@link MarketRun})을 넘기지 않은 코드 오류입니다.
     */
    @Override
    public TradingCalendar calendar() {
        throw new IllegalStateException("한국 시장 묶음의 달력은 실행마다 만듭니다 — 실행 문맥(MarketRun, PaperMarkets.open) 밖에서 "
                + "달력을 물었습니다");
    }

    /**
     * 그 실행의 한국 거래일 달력 — 조용히 읽은 공휴일 저장본({@link #holidaysByYear}) + 그 실행이 읽은 설정 판의 임시휴장·장 시간 변경일
     * ({@link #extraClosures}·{@link #sessionHours}). 저장본이 없으면 아는 해가 없는 달력이라 평일마다 '달력 없음'으로 섭니다(K35).
     */
    @Override
    public TradingCalendar openCalendar(MarketRun.Inputs inputs) {
        Snapshot stored = inputs.snapshots().read(Datasets.SNAP_KR_HOLIDAYS, Datasets.MAX_AGE_WEEKLY, HOLIDAYS_TASK)
                .orElse(null);
        return new KrxCalendar(holidaysByYear(stored == null ? null : stored.payload()),
                extraClosures(inputs.settingsBody()), sessionHours(inputs.settingsBody()));
    }

    /**
     * 공휴일 저장본({@code {years: {"2026": {holidays: [{date, name}], announced, fetchedAt}}}} — 수집기 {@code task_kr_holidays})의 해
     * → 공휴일. 목록이 비었거나(발표 전 — {@code announced=false}) 날짜 하나라도 {@code yyyy-MM-dd}가 아니거나 그해가 아닌 해는 <b>모르는
     * 해</b>로 둡니다(fail-closed — 일부만 읽은 목록은 빠진 날을 거래일로 보이게 함). 해 키가 숫자가 아니면 버립니다.
     */
    static Map<Integer, List<LocalDate>> holidaysByYear(JsonNode payload) {
        Map<Integer, List<LocalDate>> out = new TreeMap<>();
        JsonNode years = payload == null ? null : payload.get("years");
        if (years == null || !years.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> entry : years.properties()) {
            int year;
            try {
                year = Integer.parseInt(entry.getKey());
            } catch (NumberFormatException e) {
                continue;
            }
            JsonNode list = entry.getValue() == null ? null : entry.getValue().get("holidays");
            if (list == null || !list.isArray() || list.isEmpty()) {
                continue;
            }
            List<LocalDate> days = new ArrayList<>();
            for (JsonNode day : list) {
                LocalDate date = isoDate(day == null ? null : day.get("date"));
                if (date == null || date.getYear() != year) {
                    days = null;
                    break;
                }
                days.add(date);
            }
            if (days != null) {
                out.put(year, Collections.unmodifiableList(days));
            }
        }
        return out;
    }

    /**
     * 설정 본문의 임시휴장({@code kr.calendar.extraClosures}, {@code DATE_LIST}). 없거나 형이 틀리면(손으로 고친 행) 그 키 기본값(빈
     * 목록)으로 읽습니다 — 다른 설정 키와 같은 규칙(저장은 설정 API가 형·범위를 검사).
     */
    static List<LocalDate> extraClosures(JsonNode settingsBody) {
        JsonNode value = PaperSettingsService.valueAt(settingsBody, "kr.calendar.extraClosures");
        if (value == null || !value.isArray()) {
            return List.of();
        }
        List<LocalDate> out = new ArrayList<>();
        for (JsonNode item : value) {
            LocalDate date = isoDate(item);
            if (date == null) {
                return List.of();
            }
            out.add(date);
        }
        return List.copyOf(out);
    }

    /**
     * 설정 본문의 장 시간 변경일({@code kr.calendar.openTimeOverrides}, {@code DATE_TIME_MAP} — 결정 d8 {@code {"2026-11-19": {"open":
     * "10:00", "close": "16:30"}}}). 없거나 형이 틀리면 그 키 기본값(빈 표 — 모든 날 정규장)으로 읽습니다({@link #extraClosures}와 같은 규칙).
     */
    static Map<LocalDate, KrxCalendar.Hours> sessionHours(JsonNode settingsBody) {
        JsonNode value = PaperSettingsService.valueAt(settingsBody, "kr.calendar.openTimeOverrides");
        if (value == null || !value.isObject()) {
            return Map.of();
        }
        Map<LocalDate, KrxCalendar.Hours> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> entry : value.properties()) {
            LocalDate date = isoDate(entry.getKey());
            LocalTime open = time(entry.getValue() == null ? null : entry.getValue().get("open"));
            LocalTime close = time(entry.getValue() == null ? null : entry.getValue().get("close"));
            if (date == null || open == null || close == null || !open.isBefore(close)) {
                return Map.of();
            }
            out.put(date, new KrxCalendar.Hours(open, close));
        }
        return Collections.unmodifiableMap(out);
    }

    /**
     * 출발일이 비었으면({@link PaperConfig#KR_START_MISSING}) 또는 한국 계좌가 하나도 없으면(한국 초기화 전 — {@link #NOT_INITIALIZED}) 정기
     * 작업이 한국을 건너뜁니다(서버 안전 — {@link PaperMarket#dormantReason}).
     */
    @Override
    public String dormantReason(PaperConfig config, BooleanSupplier hasBooks) {
        if (!config.krStartConfigured()) {
            return PaperConfig.KR_START_MISSING;
        }
        return hasBooks.getAsBoolean() ? null : NOT_INITIALIZED;
    }

    @Override
    public String quotesDataset() {
        return Datasets.SNAP_KR_PAPER_QUOTES;
    }

    @Override
    public String quotesTask() {
        return QUOTES_TASK;
    }

    /**
     * 한국 관측치({@code paper.kr.quotes} 계약 1 → 한국 봉: 시가·종가·거래량·출처·1분봉 개장 봉·종목 수집 시각 — {@link KrQuotes#parse}, 결정 d10,
     * C2b). 계약 판이 1이 아니거나 쓸 수 있는 종목이 없으면 empty입니다.
     */
    @Override
    public Optional<Quotes> parse(Snapshot snapshot) {
        return KrQuotes.parse(snapshot);
    }

    /**
     * 늦음이 되는 순간(결정 d5, 명세 §4-9 'C1a에서 정한 것'): 저장본이 덮는 세션 S(머리의 {@code session}, 없으면 수집 시각으로 수집기
     * {@code kr_target_session}과 같은 식 — {@link #targetSession}) 다음 KR 거래일 D′의 다음 수집 예정 E = max(D′ 20:30, D′ 21:55 서버 창
     * 기동) KST에 여유 {@link #QUOTES_LATE_MARGIN}을 더한 순간 = <b>D′+1 00:00 KST</b>. 금요일 저장본은 화요일 00:00부터 늦음이고(주말
     * 없음), 휴장이 끼면 D′이 그만큼 뒤로 갑니다. 한국 저장본은 한 번 다 받으면 그 밤 다시 쓰지 않아 수집 시각이 하루 넘게 그대로인 것이
     * 정상이라 미국식 '나이 > 고정 시간'을 쓰지 않습니다.
     *
     * @throws com.macrodash.analytics.CalendarUnavailableException D′(또는 S)가 달력이 모르는 해 — 부르는 쪽이 늦음 = null + '달력 없음'
     */
    @Override
    public Instant quotesLateAt(Instant collectedAt, LocalDate session, TradingCalendar calendar) {
        LocalDate covered = session != null ? session : targetSession(collectedAt, calendar);
        LocalDate next = calendar.nextTradingDay(covered);
        Instant collect = ZonedDateTime.of(next, COLLECT_AFTER, KrxCalendar.SEOUL).toInstant();
        Instant window = ZonedDateTime.of(next, SERVER_WINDOW_OPENS, KrxCalendar.SEOUL).toInstant();
        return (collect.isAfter(window) ? collect : window).plus(QUOTES_LATE_MARGIN);
    }

    /**
     * 수집 시각 t에 받는 KR 세션 — t의 KST 날짜가 거래일이고 {@link #COLLECT_AFTER}(20:30) 이후면 그날, 아니면 직전 거래일(수집기
     * {@code kr_paper.kr_target_session}과 같은 식).
     */
    static LocalDate targetSession(Instant collectedAt, TradingCalendar calendar) {
        ZonedDateTime local = collectedAt.atZone(KrxCalendar.SEOUL);
        LocalDate today = local.toLocalDate();
        if (calendar.isTradingDay(today) && !local.toLocalTime().isBefore(COLLECT_AFTER)) {
            return today;
        }
        return calendar.previousTradingDay(today);
    }

    /**
     * 세션 D의 한국 결정 창 — 결정 시각({@code opens}) ~ 기한({@code deadline}).
     */
    record DecisionWindow(Instant opens, Instant deadline) {
    }

    /**
     * 세션 D의 한국 결정 창: 그 실행이 읽은 설정 판의 {@code kr.decisionTimeKst}·{@code kr.decisionDeadlineKst}(없거나 틀리면 기본 22:30·
     * 01:00)를 {@link #decisionInstant}로 순간으로 만들고, 기한이 결정 시각보다 이르거나 같으면 다음 날로 읽습니다(설정 저장 규칙과 같은 뜻 —
     * 명세 §4-13 'C1b 구현에서 정한 것'). 기본값이면 D 22:30 ~ D+1 01:00. 한국 출발(S 22:30, 기한 S+1 01:00 — §4-8)과 한국 초기화의 출발일
     * 검사가 씁니다 — 정기 결정 작업의 기한 묶기({@code PaperDecisionJob.times})를 시장으로 옮기는 일은 D1(명세 §9 'D1·E2 — 결정 기한').
     *
     * @param market 한국 묶음 또는 그 실행(설정 키 접두어·기본값·결정 순간 식)
     */
    static DecisionWindow decisionWindow(PaperMarket market, JsonNode settingsBody, LocalDate session) {
        LocalTime decision = PaperDecisionJob.decisionTime(market, settingsBody);
        LocalTime deadline = time(PaperSettingsService.valueAt(settingsBody, market.settingKey("decisionDeadlineKst")));
        Instant opens = market.decisionInstant(session, decision);
        Instant due = market.decisionInstant(session, deadline == null ? market.defaultDeadline() : deadline);
        while (!due.isAfter(opens)) {
            due = due.plus(Duration.ofDays(1));
        }
        return new DecisionWindow(opens, due);
    }

    @Override
    public String historyDataset() {
        return Datasets.TS_KR_CLOSE_ADJ;
    }

    /**
     * 봉 날짜가 KR 거래일이고 저장본을 그날 {@link #COLLECT_AFTER}(20:30 KST — 한국 수집 규칙 K17, 통합 세션 마감 20:00·수급 저녁판 뒤)
     * 이후에 수집함. 정규장 마감 시각({@code closeInstant})이 아니라 수집 시각으로 봅니다 — 장 시간 변경일(수능일 마감 16:30)에도 수집기는
     * 20:30 뒤 하루 1회라(설정을 읽지 않음, ADR 0008) 마감 + 여유로 세면 그날만 21:30이 되어 수집 규칙과 어긋납니다(명세 §4-9 'C1c에서
     * 정한 것'의 넘김). 그날 값은 토스 잠정 종가이고 확정({@link #pricesConfirmed})이 아닙니다.
     *
     * @throws com.macrodash.analytics.CalendarUnavailableException 봉 날짜가 달력이 모르는 해의 평일
     */
    @Override
    public boolean closeAvailable(LocalDate barDate, Instant collectedAt, TradingCalendar calendar) {
        return calendar.isTradingDay(barDate)
                && !collectedAt.isBefore(ZonedDateTime.of(barDate, COLLECT_AFTER, KrxCalendar.SEOUL).toInstant());
    }

    /**
     * 그 봉 날짜에 그 주문 시점의 잠정가가 있는가(③ — 시가 사다리 {@code TOSS_1M_OPEN} → 토스 일봉 시가, 1분봉 {@code FAILED}는 결정 기한
     * 뒤 수집본까지 기다림, {@code NEXT_CLOSE}는 없음 — {@link KrFills}, 결정 d11). 기다림의 끝은 기본 결정 기한(설정 판을 받는
     * {@link #fillBar}가 장부의 경로)입니다. 거래량 0·모름 봉은 관측이 아니라 false입니다.
     */
    @Override
    public boolean fillable(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar) {
        return KrFills.fillable(order, bar, collectedAt, calendar, deadlines(null));
    }

    /**
     * 체결 봉 고르기(한국판 체결 조건 ①~④ — {@link KrFills#choose}): 그 종목을 주문 뒤에 새로 받았을 때 최근 봉 창에서 기준 거래일 뒤 첫 관측
     * 봉(거래량 &gt; 0)과 그날 시가 사다리. 1분봉 {@code FAILED}의 기다림은 그 봉 날짜 밤의 결정 기한(그 실행 설정 판 —
     * {@link #decisionWindow}) 뒤 수집본에서 끝납니다(결정 d11 — 벽시계가 아니라 자료).
     */
    @Override
    public FillChoice fillBar(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar,
                              JsonNode settingsBody) {
        return KrFills.choose(order, bar, collectedAt, calendar, deadlines(settingsBody));
    }

    /**
     * 늘 false — 한국 가격의 확정은 금융위 값으로 하는 확정 조정(K29, C3)입니다. 그 전의 순자산 줄·결정 행은 잠정({@code prices_final =
     * false})이고, 토스 잠정 종가를 확정으로 적지 않습니다(보유가 없는 현금뿐인 줄은 장부가 따로 확정으로 둠).
     */
    @Override
    public boolean pricesConfirmed(LocalDate barDate, Instant collectedAt, TradingCalendar calendar) {
        return false;
    }

    /**
     * 한국 체결 조건(K31·§4-3 — {@link KrFills#terms}): 체결가 = 고른 관측가, 비용 칸은 {@code KrxCosts}(그 실행 설정 판의 수수료·슬리피지·
     * 세율), 종목 구분은 ETF 목록(설정 현금성 + 벤치마크 종목 {@link #BENCHMARK_TICKERS}) → 금융위 시장 구분, 코넥스·모르는 시장·세율 모름은
     * 보류({@link FillTerms.Hold}).
     */
    @Override
    public FillTerms fill(Order order, Bar bar, PaperSettings settings, TradingCalendar calendar) {
        return KrFills.terms(order, bar, settings, calendar, deadlines(null), BENCHMARK_TICKERS);
    }

    /**
     * 시가 체결 장부(명세 §4-2의 한 관측치 안 순서: 만료 → 기업행위 → 시가 매도 → 시가 매수 → 종가 매도 → 종가 매수 → 최고가·스탑 감지 →
     * 평가) — 장부의 한국 경로.
     */
    @Override
    public boolean auctionFills() {
        return true;
    }

    /**
     * 관측치 종목마다 금융위 시장 구분({@code fsc_price.market}, 최신 기준일 — {@link PaperMarketData#fscMarkets})을 덧붙입니다. 비용 종목
     * 구분(§4-3)이 씁니다 — 저장본(계약 1)에는 없는 칸이라 장부가 체결 전에 한 번 읽습니다.
     */
    @Override
    public Quotes withListings(Quotes quotes, PaperMarketData data) {
        Map<String, String> markets = data.fscMarkets(quotes.bars().keySet());
        Map<String, Bar> bars = new LinkedHashMap<>();
        quotes.bars().forEach((code, bar) -> bars.put(code, bar.kr() == null ? bar
                : new Bar(bar.ticker(), bar.date(), bar.close(), bar.stale(), bar.recent(),
                bar.kr().withFscMarket(markets.get(code)))));
        return new Quotes(quotes.collectedAt(), bars, quotes.session());
    }

    /**
     * 금융위 확정 시세({@link PaperMarketData#krConfirmed} — C2c): ETF 목록({@link #etf} — 비용 종목 구분과 같은 규칙)은 증권상품시세, 나머지는
     * 주식시세. 스탑 재판정·최고가·기업행위 상장 상태·묶인 평가가 씁니다({@link PaperMarket#confirmedPrices}).
     */
    @Override
    public KrConfirmed confirmedPrices(PaperMarketData data, java.util.Collection<String> codes, PaperSettings settings,
                                       LocalDate from) {
        List<String> stocks = new ArrayList<>();
        List<String> etfs = new ArrayList<>();
        for (String code : new java.util.TreeSet<>(codes)) {
            (etf(code, settings) ? etfs : stocks).add(code);
        }
        return data.krConfirmed(stocks, etfs, from);
    }

    /**
     * 그 종목이 ETF인가 — 설정 현금성({@code kr.cashLikeTickers}) ∪ 벤치마크 종목({@link #BENCHMARK_TICKERS}). 비용 종목 구분(§4-3 — {@link KrFills})과
     * 같은 목록이고, 확정 시세의 출처(증권상품시세)를 가릅니다.
     */
    static boolean etf(String code, PaperSettings settings) {
        return settings.cashLike(code) || BENCHMARK_TICKERS.contains(code);
    }

    /** 봉 날짜 → 그 밤 한국 결정 기한(그 설정 본문, null이면 기본 22:30 → D+1 01:00 — {@link #decisionWindow}). */
    private java.util.function.Function<LocalDate, Instant> deadlines(JsonNode settingsBody) {
        return day -> decisionWindow(this, settingsBody, day).deadline();
    }

    @Override
    public List<PaperBooks.Definition> books() {
        return PaperBooks.KR;
    }

    @Override
    public String rulesBook() {
        return PaperBooks.KR_RULES;
    }

    @Override
    public String claudeBook() {
        return PaperBooks.KR_CLAUDE;
    }

    @Override
    public String benchmarkBook() {
        return PaperBooks.KR_BENCH_K200;
    }

    @Override
    public List<String> defaultCashLike() {
        return PaperSettingsService.KR_DEFAULT_CASH_LIKE;
    }

    @Override
    public double defaultMinOrderNotional() {
        return PaperSettingsService.KR_DEFAULT_MIN_ORDER_NOTIONAL;
    }

    @Override
    public List<String> timings() {
        return TIMINGS;
    }

    @Override
    public String earlyTiming() {
        return PaperBooks.NEXT_OPEN;
    }

    @Override
    public Map<String, String> timingNames() {
        return TIMING_NAMES;
    }

    @Override
    public OrderValidator.Money money() {
        return KRW;
    }

    @Override
    public LocalTime defaultDecisionTime() {
        return DEFAULT_DECISION_TIME;
    }

    @Override
    public LocalTime defaultDeadline() {
        return DEFAULT_DEADLINE;
    }

    /**
     * 세션 D에 딸린 KST 시각의 순간 — {@link #NEXT_MORNING_BEFORE}(09:00) 전 시각은 D+1 아침, 나머지는 D 그날(밤). 설정 저장 규칙
     * (결정 시각 20:30~23:59 또는 00:00~08:59, 기한은 결정 뒤 첫 그 시각·D+1 08:30까지)으로 받는 값이면 기본 22:30 → D 22:30, 01:00 →
     * D+1 01:00처럼 '결정 시각 뒤의 첫 그 시각'과 같은 순간입니다. (결정 작업의 기한 묶기 규칙을 시장으로 옮기는 일은 D1 — 명세 §9
     * 'D1·E2 — 결정 기한'.)
     */
    @Override
    public Instant decisionInstant(LocalDate session, LocalTime kstTime) {
        LocalDate day = kstTime.isBefore(NEXT_MORNING_BEFORE) ? session.plusDays(1) : session;
        return ZonedDateTime.of(day, kstTime, KrxCalendar.SEOUL).toInstant();
    }

    /** @throws IllegalStateException 늘 — 한국 하드 규칙 줄(₩·153130·NEXT_OPEN)은 E2(명세 K34). 한국 Claude 계좌는 그 전에 시작하지 않습니다. */
    @Override
    public List<String> promptHardRules(JsonNode settingsBody) {
        throw new IllegalStateException("한국 Claude 시스템 프롬프트의 하드 규칙 줄은 아직 없습니다(2단계 E2, 명세 K34)");
    }

    /** @throws IllegalStateException 늘 — 한국 고정 문단 {@code KR_FIXED_RULES}는 E2(명세 K34). */
    @Override
    public String promptFixedRules() {
        throw new IllegalStateException("한국 Claude 시스템 프롬프트의 고정 문단(KR_FIXED_RULES)은 아직 없습니다(2단계 E2, 명세 K34)");
    }

    @Override
    public DayOfWeek reviewOpensOn() {
        return REVIEW_OPENS_ON;
    }

    @Override
    public LocalTime reviewOpensAt() {
        return REVIEW_OPENS_AT;
    }

    @Override
    public String settingsPrefix() {
        return "kr.";
    }

    @Override
    public String jobPrefix() {
        return "kr.";
    }

    @Override
    public String toString() {
        return "KrPaperMarket";
    }

    // ------------------------------------------------------------------ 보조
    private static Map<String, String> timingNames(List<String> timings) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String timing : timings) {
            out.put(timing, PaperBooks.NEXT_OPEN.equals(timing) ? "다음 거래일 시가" : "다음 거래일 종가");
        }
        return Collections.unmodifiableMap(out);
    }

    private static LocalDate isoDate(JsonNode node) {
        return node == null || !node.isString() ? null : isoDate(node.asString(""));
    }

    private static LocalDate isoDate(String text) {
        if (text == null || !ISO_DATE.matcher(text).matches()) {
            return null;
        }
        try {
            return LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    private static LocalTime time(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        try {
            return LocalTime.parse(node.asString(""));
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
