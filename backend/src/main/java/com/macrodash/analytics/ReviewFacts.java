package com.macrodash.analytics;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 🧪 주간 복기(2단계 명세 D1·D2)의 입력 사실 — Claude 계좌의 지난 결정을 그 뒤 실제 가격과 대조한 값을 <b>코드가</b> 만듭니다.
 * Claude는 이 사실을 읽고 판정만 합니다(수익률을 Claude가 계산하면 틀려도 알 수 없음).
 *
 * <p><b>복기 기준일({@link #weekEnding})</b>은 ISO 주(월~일)의 마지막 미국 거래일 — 보통 금요일, 금요일이 휴장이면 목요일
 * ({@link UsMarketCalendar}). 창은 (기준일 − 주 수×7일, 기준일] 안에 결정 기준일({@code as_of})이 있는 결정입니다. 기본 4주이고,
 * 조립한 입력의 어림이 {@link #TOKEN_LIMIT}을 넘으면 서비스가 2주로 다시 조립해 이유({@link #trimmedReason})를 남깁니다(단계 0).
 * 달력({@link TradingCalendar})을 받는 판은 기준일·가정 진입일·계좌 비교 시작일을 그 시장 달력으로 셉니다(받지 않는 판은 미국).
 *
 * <p><b>주문별 사실</b>(모두 복기 기준일 종가 기준, 기준일 뒤 값은 쓰지 않음):
 * <ul>
 *   <li>매수 체결: 체결 뒤 수익률 = 기준일 종가 ÷ 체결가 − 1(그 뒤 팔았든 스탑이 났든 계속 들고 있었다면 — 명세 D2), 체결 뒤 최대
 *       낙폭(체결가를 첫 고점으로 둔 종가 기준 고점 대비, 0 이하), 스탑 발동 여부(체결일부터 기준일까지 그 종목의 스탑 체결 — 그 전에
 *       전량 매도했으면 그 스탑은 다시 산 포지션의 것이라 발동 아님).</li>
 *   <li>매도 체결: 판 뒤 가격 변화 = 기준일 종가 ÷ 매도 체결가 − 1 — 음수면 {@link #AVOIDED}(피한 하락), 양수면 {@link #MISSED}
 *       (놓친 상승). 판 종목의 낙폭·스탑은 해당이 없습니다.</li>
 *   <li>거절 주문: 결정 다음 세션 종가에 체결됐다고 <b>가정</b>한 수익률(그 세션 종가 → 기준일 종가). 매도면 위와 같은 표시.</li>
 *   <li>모든 주문: 기준일 종가와 200거래일 단순 이동평균(PacketBuilder의 {@code vs200dPct}와 같은 식 — 마지막 200개 점). 상태는
 *       기준일 시점 값입니다({@link #statusAt} — 기준일 뒤 체결·만료는 PENDING).</li>
 * </ul>
 *
 * <p><b>무효화 조건은 코드가 읽을 수 있는 꼴만 평가합니다</b>({@link #evaluate}): (a) 스탑 언급 → 스탑 발동 여부, (b) 200일선 언급
 * 바로 뒤의 이탈·하회·아래(또는 'below the 200-day') → 기준일 종가 &lt; 200일 평균, (c) '−8%'·'8% 하락' 같은 주가 하락 폭 → 체결 뒤
 * 최대 낙폭 ≤ −N%(매출·EPS·가이던스·SPY 대비처럼 주가가 아닌 수치의 −N%는 읽지 않음). 그 밖은
 * {@link #UNEVALUABLE} — 위 사실을 함께 실어 Claude가 판단합니다. 문장 안의 다른 조건(실적·가이던스 등)은 코드가 모르므로, 읽은 조건이
 * '충족'이어도 문장 전체가 그렇다는 뜻은 아닙니다(결과는 조건별로 남김).
 *
 * <p><b>없는 숫자를 만들지 않습니다</b>: 종가·체결이 없으면 null과 이유({@code notes}), 0으로 채우지 않습니다. 계좌 비교는
 * {@code paper_nav_daily}의 두 끝 줄이 있어야 값이 있고, 확정 종가가 아닌 줄이 끼면 {@code isEstimated}입니다.
 *
 * <p>가격은 수정주가 이력({@code equity_close})이라 체결가(장부 그대로)와 기준이 다를 수 있습니다: 배당락이 끼면 낙폭이 배당만큼
 * 커 보이고(분기 1% 안팎, 한계), 분할·병합이 끼면 과거 값이 비율만큼 다시 쓰여 −50% 같은 가짜 수익률이 됩니다. 그래서 체결일의
 * 이력 종가와 체결가의 비가 {@link #BASIS_LOW}~{@link #BASIS_HIGH} 밖이면 체결가 대비 수치를 내지 않습니다(분할 의심 — 5:4보다
 * 작은 분할은 이 띠 안이라 못 잡습니다. 장중 체결가가 그날 종가와 20% 넘게 다르면 멀쩡한 값도 null이 되는데, 틀린 값보다 낫습니다).
 *
 * <p>같은 입력이면 같은 결과입니다 — 결정은 기준일·id 순, 주문은 id 순, 계좌는 받은 순서. {@link Facts#toMap}의 키 순서도 고정이라
 * 직렬화한 문자열(→ 토큰 어림·저장본)이 실행마다 같습니다. 이 클래스는 정보를 모을 뿐 규칙 계좌·검증기를 바꾸지 않습니다(D6·D35).
 */
public final class ReviewFacts {

    private ReviewFacts() {
    }

    /** 입력 모양의 판 — 칸을 바꾸면 올립니다(복기 기록끼리 비교할 때 같은 모양인지 알게). */
    public static final int INPUT_VERSION = 1;

    /** 기본 창(주) — 명세 D2·D32. */
    public static final int DEFAULT_WEEKS = 4;
    /** 어림이 {@link #TOKEN_LIMIT}을 넘을 때 다시 조립하는 창(주) — 단계 0. */
    public static final int FALLBACK_WEEKS = 2;
    /** 이보다 크면 2주로 다시 조립합니다(PacketBuilder 어림 기준 — 실측은 어림의 약 1.7배, 단계 0). */
    public static final int TOKEN_LIMIT = 25_000;

    /** 복기가 열리는 요일·시각(한국 시각) — 명세 D1. 금요일 마감(한국 토요일 05:00·06:00) 뒤 확정 종가가 들어올 여유를 둡니다. */
    public static final DayOfWeek OPENS_ON = DayOfWeek.SATURDAY;
    public static final LocalTime OPENS_AT = LocalTime.of(9, 0);

    /** 글자 상한 — 결정 요약은 PacketBuilder의 앞선 결정 요약과 같은 300자. 논거·무효화 문장은 스키마 상한(600·300)이라 자르지 않음. */
    public static final int SUMMARY_CHARS = 300;
    public static final int RATIONALE_CHARS = 300;
    public static final int NO_TRADE_CHARS = 300;

    /** 이동평균 기간(거래일, 점 수). */
    public static final int MOVING_AVERAGE_DAYS = 200;

    /** 체결가 ÷ 체결일 이력 종가가 이 띠 밖이면 기준이 다르다고(분할·병합 의심) 봅니다(양 끝 포함은 정상). */
    public static final double BASIS_LOW = 0.8;
    public static final double BASIS_HIGH = 1.25;

    /** 결정·주문 상태(paper_decisions·paper_orders, V8과 같은 문자열). */
    public static final String OK = "OK";
    public static final String NO_TRADE = "NO_TRADE";
    public static final String REJECTED = "REJECTED";
    public static final String BUY = "BUY";
    public static final String SELL = "SELL";
    static final String PENDING = "PENDING";
    static final String FILLED = "FILLED";
    static final String EXPIRED = "EXPIRED";

    /** 매도 뒤 가격 변화의 표시. */
    public static final String AVOIDED = "avoided";
    public static final String MISSED = "missed";
    public static final String FLAT = "flat";
    /** 거절 주문 가정 수익률의 표시. */
    public static final String HYPOTHETICAL = "가정";

    /** 무효화 평가 결과. */
    public static final String MET = "충족";
    public static final String NOT_MET = "미충족";
    public static final String PARTIAL = "일부 평가 불가";
    public static final String UNEVALUABLE = "평가 불가";

    /** 코드가 읽는 무효화 조건의 꼴. 결과의 조건 목록은 이 순서입니다(하락 폭은 작은 N부터). */
    public static final String STOP = "STOP";
    public static final String MA200 = "MA200";
    public static final String DRAWDOWN = "DRAWDOWN";

    // (a) 스탑 — 영어는 앞이 영문자·하이픈이 아닐 때만(nonstop·non-stop 제외 — \b는 하이픈 뒤에도 서서 'non-stop'을 읽었음),
    // 한글 표기 둘(논스톱·논스탑 제외).
    private static final Pattern STOP_WORD = Pattern.compile("(?i)(?<![-A-Za-z])stop|(?<!논)스[탑톱]");
    // (b) 200일선 — '200일(선·이동평균·이평)'·'200-day'·'200 day'·'200DMA'·'200d'.
    private static final String MA200_MENTION = "(?<![0-9.])200\\s*(?:-\\s*)?(?:일|day|dma|d\\b)";
    private static final String BELOW_WORD = "(?:이탈|하회|아래|밑|\\bbelow\\b|\\bunder\\b)";
    /**
     * 방향 말이 200일선 언급 <b>바로 뒤</b>({@value #MA200_GAP}자 안)에 붙을 때만 (b)로 읽습니다. 사이에 숫자·쉼표·마침표·쌍반점이 끼면
     * 다른 조건입니다 — 앞뒤 20자 창으로 보던 때는 '50일선 이탈 시 축소, 200일선은 지지'·'200일선 위 유지 중 50일선 하회'의 '이탈·하회'를
     * 200일선에 붙여, 50일선 조건의 판정을 200일선 사실이 정했습니다. 영어는 'below/under (the·its) 200-day'.
     */
    private static final int MA200_GAP = 10;
    private static final Pattern MA200_THEN_BELOW = Pattern.compile("(?i)" + MA200_MENTION
            + "(?:\\s*moving\\s+average)?[^0-9,;.]{0," + MA200_GAP + "}?" + BELOW_WORD);
    private static final Pattern BELOW_THEN_MA200 =
            Pattern.compile("(?i)\\b(?:below|under)\\s+(?:the\\s+|its\\s+)?" + MA200_MENTION);
    // (c) 하락 폭 — '−8%'(앞이 숫자·글자면 '3-8%' 같은 범위라 제외, 바로 뒤가 p면 퍼센트포인트 '%p'라 제외)와 '8% (이상) 하락'·
    // 'drops 8%'.
    private static final Pattern MINUS_PERCENT =
            Pattern.compile("(?<![0-9A-Za-z.%])[-−–]\\s*(\\d+(?:\\.\\d+)?)\\s*%(?![pP])");
    private static final Pattern PERCENT_DROP = Pattern.compile(
            "(?i)(?<![0-9.])(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:이상\\s*|넘게\\s*|넘는\\s*)?(?:하락|급락|떨어|빠지|빠질|빠져|손실"
                    + "|drop|decline|fall|loss)");
    private static final Pattern DROP_PERCENT = Pattern.compile(
            "(?i)\\b(?:drops?|declines?|falls?|drawdown)\\s+(?:of\\s+|by\\s+)?(\\d+(?:\\.\\d+)?)\\s*%");
    /**
     * (c)의 숫자가 주가가 아닌 수치(매출·EPS·가이던스·금리·지수 등)나 상대 성과(SPY 대비·상대 부진)의 변화면 읽지 않습니다 — 그런 문장을
     * 주가 최대 낙폭으로 평가하면 4주에 흔한 −3~−5% 조정만으로 '충족'이 나와 Claude에 틀린 사실로 갑니다. 숫자 앞은 같은 절(쉼표·'또는'
     * 뒤)의 {@value #METRIC_BEFORE}자, 뒤는 {@value #METRIC_AFTER}자를 봅니다. '고점 대비'·'매수가 대비'(가격이 기준)와 '실적 발표 뒤'
     * (사건 시점)는 가격 조건의 일부라 가리고 봅니다({@link #PRICE_CONTEXT}).
     */
    private static final int METRIC_BEFORE = 12;
    private static final int METRIC_AFTER = 8;
    private static final Pattern NON_PRICE_BEFORE = Pattern.compile("(?i)매출|이익|실적|가이던스|성장|마진|금리|컨센서스|대비|상대"
            + "|지수|점유율|\\beps\\b|revenue|sales|earnings|guidance|margin|growth|consensus|relative|\\bvs\\b|versus|index");
    private static final Pattern NON_PRICE_AFTER =
            Pattern.compile("(?i)상대|대비|relative|\\bvs\\b|versus|underperform|언더퍼폼");
    private static final Pattern PRICE_CONTEXT =
            Pattern.compile("(?:전고점|고점|최고가|매수가|매입가|체결가|진입가|평단가?|평균\\s*단가)\\s*대비|실적\\s*발표");
    private static final Pattern CLAUSE_BREAK = Pattern.compile("(?i)[,;·/()]|또는|혹은|그리고|\\bor\\b|\\band\\b");

    static final String NOTE = "수익률·낙폭은 %. returnSinceFillPct = 복기 기준일 종가 ÷ 체결가 − 1(그 뒤 매도·스탑과 무관하게 "
            + "계속 들고 있었다면). maxDrawdownPct = 체결일부터 기준일까지 종가의 고점 대비 최대 낙폭(체결가를 첫 고점으로, 0 이하). "
            + "stop = 체결 뒤 그 종목의 트레일링 스탑 체결(returnPct = 스탑 체결가 ÷ 체결가 − 1, 그 전에 전량 매도했으면 다시 산 포지션의 "
            + "스탑이라 triggered=false). 매도는 afterSellPct = 기준일 종가 ÷ "
            + "매도 체결가 − 1 — 음수면 avoided(피한 하락), 양수면 missed(놓친 상승). 거절 주문의 hypothetical은 결정 다음 세션 종가에 "
            + "체결됐다고 가정한 값(가정). ma200 = 기준일 종가와 200거래일 단순 이동평균. status는 복기 기준일 장 마감 시점의 상태. "
            + "invalidationCheck는 코드가 읽을 수 있는 조건(스탑 언급·200일선 바로 뒤의 이탈·주가의 N% 하락 — 매출·EPS·가이던스·SPY 대비 "
            + "등의 −N%는 읽지 않음)만 조건별로 평가하고 그 밖은 '평가 불가' — 문장의 다른 조건은 위 사실로 판단. null은 값 "
            + "없음(이유는 notes), 0이 아님. 가격은 수정주가 이력이라 배당락이 끼면 낙폭이 배당만큼 커 보일 수 있음.";

    // ------------------------------------------------------------------ 입력
    /** 체결 한 건 — 장부의 체결가(슬리피지 포함)와 그 관측일(미국 동부 세션 날짜). */
    public record Fill(LocalDate date, double price) {
    }

    /**
     * Claude 계좌 주문 한 건.
     *
     * @param targetWeightPct 매수의 목표 비중(%) — 모델이 제안한 값(장부에 낸 증분이 아니라)
     * @param sellFraction    매도 비율(0~1, null = 전량)
     * @param status          지금(조립 시점) 상태 — PENDING·FILLED·EXPIRED·CANCELLED·REJECTED. 입력에는 기준일 시점 값으로 실음
     *                        ({@link #statusAt})
     * @param rejectReason    거절 사유(거절이 아니면 null)
     * @param fill            체결(없으면 null)
     * @param expiresOn       만료일(이날까지 유효 — 장부는 다음 세션에 EXPIRED로 바꿈). 모르면 null
     */
    public record Order(long id, String ticker, String side, Double targetWeightPct, Double sellFraction, String timing,
                        String status, String rejectReason, String thesis, String invalidation, Fill fill,
                        LocalDate expiresOn) {
    }

    /**
     * Claude 계좌 결정 한 건.
     *
     * @param status OK·NO_TRADE는 사실을 만들고, 나머지(오류·거부·건너뜀)는 건수만 셉니다({@link Facts#omittedDecisions})
     */
    public record Decision(long id, String kind, LocalDate asOf, String status, String stance, Double targetExposurePct,
                           String summary, String exposureRationale, String noTradeReason, Integer frameworkVersion,
                           List<Order> orders) {
        public Decision {
            Objects.requireNonNull(asOf, "asOf");
            orders = orders == null ? List.of() : List.copyOf(orders);
        }
    }

    /** Claude 계좌의 스탑 체결 한 건(paper_orders.source = STOP). */
    public record StopFill(String ticker, LocalDate date, double price) {
    }

    /**
     * Claude 계좌의 전량 매도 체결 한 건(스탑이 아닌 매도 중 비율이 없거나 1 이상). 포지션이 닫힌 날 — 그 뒤 스탑은 다시 산 포지션의
     * 것입니다({@link #stop}).
     */
    public record FullSell(String ticker, LocalDate date) {
    }

    /** 계좌의 거래일별 순자산 한 줄(paper_nav_daily). */
    public record NavPoint(LocalDate date, double nav, boolean pricesFinal) {
    }

    /** 계좌 하나의 순자산 줄(날짜 순서 상관없음). */
    public record BookNav(String book, List<NavPoint> rows) {
        public BookNav {
            rows = rows == null ? List.of() : List.copyOf(rows);
        }
    }

    /**
     * 조립에 쓰는 전부. 창보다 넓게 줘도 됩니다(창 밖 결정·기준일 뒤 값은 여기서 버림).
     *
     * @param closes    티커 → 일별 종가(수정주가 이력 + 기준일 확정 종가). 없는 티커는 가격 사실이 null
     * @param fullSells 전량 매도 체결(스탑 제외 — 스탑이 어느 포지션의 것인지 가르는 데만 씀)
     * @param books     비교할 계좌(이 순서로 실음 — rules·bench_spy·bench_mix·claude 등)
     */
    public record Inputs(List<Decision> decisions, Map<String, DailySeries> closes, List<StopFill> stops,
                         List<FullSell> fullSells, List<BookNav> books, Integer frameworkVersion,
                         String frameworkStatus) {
        public Inputs {
            decisions = decisions == null ? List.of() : List.copyOf(decisions);
            closes = closes == null ? Map.of() : Collections.unmodifiableMap(new HashMap<>(closes));
            stops = stops == null ? List.of() : List.copyOf(stops);
            fullSells = fullSells == null ? List.of() : List.copyOf(fullSells);
            books = books == null ? List.of() : List.copyOf(books);
        }
    }

    // ------------------------------------------------------------------ 결과
    /** 창: 결정 기준일 ∈ (after, through]. */
    public record Window(int weeks, LocalDate after, LocalDate through) {
        public boolean contains(LocalDate d) {
            return d != null && d.isAfter(after) && !d.isAfter(through);
        }
    }

    /** 체결 뒤 스탑. 발동하지 않았으면 날짜·가격·수익률이 null. */
    public record Stop(boolean triggered, LocalDate date, Double price, Double returnPct) {
    }

    /** 기준일 종가와 200거래일 평균. {@code below}는 반올림 전 값으로 판정합니다. */
    public record Ma200(double close, double average, double vsPct, boolean below) {
    }

    /** 거절 주문의 가정 체결(결정 다음 세션 종가). 못 구하면 가격·수익률이 null(이유는 주문의 notes). */
    public record Hypothetical(LocalDate entryDate, Double entryClose, Double returnPct, String afterSellLabel) {
    }

    /** 코드가 평가할 사실 — 해당이 없거나 못 구했으면 값이 null이고 그 이유. */
    public record Evidence(Boolean stopTriggered, String stopReason, Double maxDrawdownPct, String drawdownReason,
                           Boolean below200, String ma200Reason) {
    }

    /**
     * 읽은 조건 하나.
     *
     * @param thresholdPct 하락 폭 조건만(−8.0 = 8% 하락). 그 밖은 null
     * @param met          충족 여부. 사실이 없어 평가하지 못하면 null(이유는 reason)
     */
    public record Check(String pattern, Double thresholdPct, Boolean met, String reason) {
    }

    /** 무효화 문장 평가. {@code reason}은 조건을 하나도 읽지 못했을 때만. */
    public record InvalidationCheck(String result, List<Check> checks, String reason) {
        public InvalidationCheck {
            checks = List.copyOf(checks);
        }
    }

    /**
     * 주문 하나의 사실. 해당이 없는 칸(매도의 낙폭 등)은 null이고 {@link Facts#toMap}에서 빠집니다. 해당이 있는데 못 구한 값은
     * null + {@code notes}에 이유.
     *
     * @param status 기준일 장 마감 시점의 상태({@link #statusAt})
     * @param fill   복기에 쓴 체결 — 기준일 뒤 체결은 미체결로 보고 null
     */
    public record OrderFacts(long id, String ticker, String side, Double targetWeightPct, Double sellFraction,
                             String timing, String status, boolean accepted, String rejectReason, String thesis,
                             String invalidation, Fill fill, Double weekEndingClose, Double returnSinceFillPct,
                             Double maxDrawdownPct, Stop stop, Double afterSellPct, String afterSellLabel,
                             Hypothetical hypothetical, Ma200 ma200, InvalidationCheck invalidationCheck,
                             List<String> notes) {
        public OrderFacts {
            notes = List.copyOf(notes);
        }
    }

    /**
     * 결정 하나. 요약·노출 근거·관망 사유는 글자 상한으로 자른 값. 주문이 없는 NO_TRADE는 짧은 줄(노출·관망 사유만), 낸 주문이 모두
     * 거절된 NO_TRADE는 OK처럼 주문까지 싣습니다(거절 주문의 가정 수익률).
     */
    public record DecisionFacts(long id, String kind, LocalDate asOf, String status, String stance,
                                Double targetExposurePct, String summary, String exposureRationale,
                                String noTradeReason, Integer frameworkVersion, List<OrderFacts> orders) {
        public DecisionFacts {
            orders = List.copyOf(orders);
        }
    }

    /** 계좌 하나의 같은 기간 수익률. 못 구하면 수익률·추정 여부가 null이고 이유. */
    public record BookReturn(String book, Double returnPct, Boolean isEstimated, String reason) {
    }

    /** 계좌 비교 — from 종가 → to 종가. 공통 시작일이 없으면 from이 null. */
    public record Comparison(LocalDate from, LocalDate to, String note, List<BookReturn> books) {
        public Comparison {
            books = List.copyOf(books);
        }
    }

    /**
     * 복기 입력 전체.
     *
     * @param trimmedReason      2주로 줄였으면 그 이유(아니면 null)
     * @param omittedDecisions   사실을 만들지 않은 결정의 상태 → 건수(이름 순)
     */
    public record Facts(LocalDate weekEnding, Window window, String trimmedReason, Integer frameworkVersion,
                        String frameworkStatus, List<DecisionFacts> decisions, Map<String, Integer> omittedDecisions,
                        Comparison comparison) {
        public Facts {
            decisions = List.copyOf(decisions);
            omittedDecisions = Collections.unmodifiableMap(new TreeMap<>(omittedDecisions));
        }

        /** 창 안에 복기할 결정(OK·NO_TRADE)이 있는지 — 없으면 서비스는 호출 없이 SKIPPED로 남깁니다. */
        public boolean hasDecisions() {
            return !decisions.isEmpty();
        }

        /** JSON으로 옮길 모양 — 키 순서 고정, 날짜는 'YYYY-MM-DD' 문자열, null은 그대로 null. */
        public Map<String, Object> toMap() {
            return ReviewFacts.toMap(this);
        }
    }

    // ------------------------------------------------------------------ 복기 기준일·시각
    /**
     * day가 속한 ISO 주(월~일)의 마지막 미국 거래일 — 금요일, 금요일이 휴장이면 목요일. 예: 2026-06-19(준틴스, 금) 주 → 06-18,
     * 추수감사절 주(목 휴장·금 조기 폐장) → 금요일. {@link #weekEnding(TradingCalendar, LocalDate)}에 미국 달력을 넘깁니다.
     *
     * @throws IllegalStateException 그 주에 거래일이 없으면(휴장 규칙상 일어나지 않음)
     */
    public static LocalDate weekEnding(LocalDate day) {
        return weekEnding(UsMarketCalendar.CALENDAR, day);
    }

    /**
     * day가 속한 ISO 주(월~일)의 그 시장 마지막 거래일(금요일부터 월요일 쪽으로 처음 만나는 거래일).
     *
     * @param calendar 그 시장의 거래일 달력
     * @throws IllegalStateException 그 주 평일이 모두 휴장이면
     */
    public static LocalDate weekEnding(TradingCalendar calendar, LocalDate day) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        Objects.requireNonNull(day, "day");
        LocalDate monday = day.with(DayOfWeek.MONDAY);
        for (LocalDate d = monday.plusDays(4); !d.isBefore(monday); d = d.minusDays(1)) {
            if (calendar.isTradingDay(d)) {
                return d;
            }
        }
        throw new IllegalStateException("거래일이 없는 주입니다: " + monday);
    }

    /**
     * now에 마감이 끝난 가장 최근 복기 기준일 — 마감이 끝난 최근 세션이 그 주의 기준일이면 그날, 아니면(주 중간) 지난주 기준일.
     * 금요일 마감 전까지는 지난주를 가리키므로, 놓친 복기(맥이 꺼져 있던 토요일)는 다음 주 기준일 마감 전까지 이 값으로 다시 잡힙니다.
     * 미국 달력 — {@link #latestCompletedWeekEnding(TradingCalendar, Instant)}.
     */
    public static LocalDate latestCompletedWeekEnding(Instant now) {
        return latestCompletedWeekEnding(UsMarketCalendar.CALENDAR, now);
    }

    /**
     * {@link #latestCompletedWeekEnding(Instant)}와 같되 그 시장 달력의 세션·주 마지막 거래일로.
     *
     * @param calendar 그 시장의 거래일 달력
     */
    public static LocalDate latestCompletedWeekEnding(TradingCalendar calendar, Instant now) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        LocalDate session = calendar.lastCompletedSession(now);
        LocalDate ending = weekEnding(calendar, session);
        return ending.equals(session) ? ending
                : weekEnding(calendar, session.with(DayOfWeek.MONDAY).minusDays(1));
    }

    /**
     * 그 주 복기가 열리는 순간 = 기준일과 같은 ISO 주의 토요일 09:00(zone). 목요일이 기준일인 주도 토요일입니다.
     *
     * @param zone 한국 시각(서비스가 {@code Kst.ZONE}을 넘김 — analytics는 우리 패키지를 쓰지 않아 받기만 함)
     */
    public static Instant opensAt(LocalDate weekEnding, ZoneId zone) {
        return ZonedDateTime.of(weekEnding.with(OPENS_ON), OPENS_AT, zone).toInstant();
    }

    /** now가 그 주 복기 시각 이후인지(그 순간 포함). */
    public static boolean isDue(Instant now, LocalDate weekEnding, ZoneId zone) {
        return !now.isBefore(opensAt(weekEnding, zone));
    }

    /** 창: (기준일 − 주 수 × 7일, 기준일]. */
    public static Window window(LocalDate weekEnding, int weeks) {
        Objects.requireNonNull(weekEnding, "weekEnding");
        if (weeks < 1) {
            throw new IllegalArgumentException("복기 창은 1주 이상이어야 합니다: " + weeks);
        }
        return new Window(weeks, weekEnding.minusWeeks(weeks), weekEnding);
    }

    /**
     * 기본 창으로 조립한 입력의 어림 토큰이 상한을 넘으면 2주로 줄이는 이유, 아니면 null.
     *
     * @param estimatedTokens 기본 창({@link #DEFAULT_WEEKS}주) 입력의 어림(PacketBuilder 어림)
     */
    public static String trimmedReason(int estimatedTokens) {
        if (estimatedTokens <= TOKEN_LIMIT) {
            return null;
        }
        return DEFAULT_WEEKS + "주 입력 어림 " + estimatedTokens + "토큰 > " + TOKEN_LIMIT + " — " + FALLBACK_WEEKS
                + "주로 다시 조립";
    }

    // ------------------------------------------------------------------ 조립
    /**
     * 복기 입력을 조립합니다 — 미국 달력({@link #build(TradingCalendar, Inputs, LocalDate, int, String)}).
     *
     * @param weekEnding    복기 기준일 — {@link #weekEnding}이 돌려주는 날이어야 함
     * @param weeks         창(주)
     * @param trimmedReason 2주로 줄였으면 이유({@link #trimmedReason}), 아니면 null
     * @throws IllegalArgumentException 기준일이 그 주의 마지막 거래일이 아니거나 weeks &lt; 1
     */
    public static Facts build(Inputs in, LocalDate weekEnding, int weeks, String trimmedReason) {
        return build(UsMarketCalendar.CALENDAR, in, weekEnding, weeks, trimmedReason);
    }

    /**
     * 복기 입력을 조립합니다. 주 마지막 거래일 검사·거절 주문의 가정 진입일(결정 다음 세션)·계좌 비교 시작일을 그 시장 달력으로 셉니다.
     *
     * @param calendar      그 계좌들이 속한 시장의 거래일 달력
     * @param weekEnding    복기 기준일 — {@link #weekEnding(TradingCalendar, LocalDate)}가 돌려주는 날이어야 함
     * @param weeks         창(주)
     * @param trimmedReason 2주로 줄였으면 이유({@link #trimmedReason}), 아니면 null
     * @throws IllegalArgumentException 기준일이 그 주의 마지막 거래일이 아니거나 weeks &lt; 1
     */
    public static Facts build(TradingCalendar calendar, Inputs in, LocalDate weekEnding, int weeks,
                              String trimmedReason) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        Objects.requireNonNull(in, "in");
        Objects.requireNonNull(weekEnding, "weekEnding");
        if (!weekEnding.equals(weekEnding(calendar, weekEnding))) {
            // 기준일이 주 중간이면 '그 주 금요일 종가'라는 수익률의 뜻이 바뀝니다 — 호출부 실수라 막습니다.
            throw new IllegalArgumentException("복기 기준일은 그 주의 마지막 거래일이어야 합니다: " + weekEnding);
        }
        Window window = window(weekEnding, weeks);
        List<StopFill> stops = new ArrayList<>(in.stops());
        stops.sort(Comparator.comparing(StopFill::date).thenComparing(StopFill::ticker));
        List<FullSell> fullSells = new ArrayList<>(in.fullSells());
        fullSells.sort(Comparator.comparing(FullSell::date).thenComparing(FullSell::ticker));
        List<Decision> inWindow = new ArrayList<>();
        for (Decision d : in.decisions()) {
            if (window.contains(d.asOf())) {
                inWindow.add(d);
            }
        }
        inWindow.sort(Comparator.comparing(Decision::asOf).thenComparingLong(Decision::id));
        List<DecisionFacts> decisions = new ArrayList<>();
        Map<String, Integer> omitted = new TreeMap<>();
        for (Decision d : inWindow) {
            if (OK.equals(d.status()) || NO_TRADE.equals(d.status())) {
                decisions.add(decision(calendar, d, weekEnding, in.closes(), stops, fullSells));
            } else {
                // 오류·거부·건너뜀은 논거가 없어 판정할 것이 없습니다 — 건수만 실어 '결정이 빠진 날'이 있었음을 알립니다.
                omitted.merge(String.valueOf(d.status()), 1, Integer::sum);
            }
        }
        return new Facts(weekEnding, window, trimmedReason, in.frameworkVersion(), in.frameworkStatus(), decisions,
                omitted, comparison(calendar, in.books(), window));
    }

    private static DecisionFacts decision(TradingCalendar calendar, Decision d, LocalDate weekEnding,
                                          Map<String, DailySeries> closes, List<StopFill> stops,
                                          List<FullSell> fullSells) {
        if (NO_TRADE.equals(d.status()) && d.orders().isEmpty()) {
            // 관망 결정은 짧게: 노출과 관망 사유만(주문이 없어 대조할 가격 사실이 없음).
            return new DecisionFacts(d.id(), d.kind(), d.asOf(), d.status(), d.stance(), d.targetExposurePct(), null,
                    null, clip(d.noTradeReason(), NO_TRADE_CHARS), d.frameworkVersion(), List.of());
        }
        // NO_TRADE인데 주문이 있으면 낸 주문이 모두 거절된 결정입니다(통과 0건 → NO_TRADE) — 짧은 줄로 접으면 거절 주문의 가정
        // 수익률(명세 D2)이 사라지므로 주문까지 싣습니다(관망 사유가 있으면 함께).
        List<Order> orders = new ArrayList<>(d.orders());
        orders.sort(Comparator.comparingLong(Order::id));
        List<OrderFacts> facts = new ArrayList<>(orders.size());
        for (Order o : orders) {
            facts.add(order(calendar, o, d.asOf(), weekEnding, closes.get(o.ticker()), stops, fullSells));
        }
        return new DecisionFacts(d.id(), d.kind(), d.asOf(), d.status(), d.stance(), d.targetExposurePct(),
                clip(d.summary(), SUMMARY_CHARS), clip(d.exposureRationale(), RATIONALE_CHARS),
                clip(d.noTradeReason(), NO_TRADE_CHARS), d.frameworkVersion(), facts);
    }

    /** 주문 하나의 사실(클래스 설명의 목록). */
    static OrderFacts order(TradingCalendar calendar, Order o, LocalDate asOf, LocalDate weekEnding,
                            DailySeries series, List<StopFill> stops, List<FullSell> fullSells) {
        List<String> notes = new ArrayList<>();
        boolean buy = BUY.equals(o.side());
        boolean sell = SELL.equals(o.side());
        boolean rejected = REJECTED.equals(o.status());
        String status = statusAt(o, weekEnding);
        if (!buy && !sell) {
            notes.add("알 수 없는 side(" + o.side() + ") — 체결 대비 사실을 내지 않음");
        }
        boolean hasHistory = series != null && !series.isEmpty();
        Double close = hasHistory ? series.valueOn(weekEnding) : null;
        if (!hasHistory) {
            notes.add("가격 이력 없음 — 가격 사실 전부 null");
        } else if (close == null) {
            LocalDate last = series.floorDate(weekEnding);
            notes.add("복기 기준일(" + weekEnding + ") 종가 없음 — "
                    + (last == null ? "그 전 종가도 없음" : "마지막 종가 " + last));
        }

        Fill fill = o.fill();
        if (fill != null && fill.date().isAfter(weekEnding)) {
            // 기준일 뒤 체결은 이 주에 알 수 없던 사실입니다 — 체결도, 체결일도 싣지 않고 상태는 기준일 시점의 PENDING(statusAt)으로.
            // 체결일을 notes에 적으면 늦게 돌린 복기만 '월요일에 체결됨'을 알게 돼 토요일에 돌린 복기와 입력이 달라집니다.
            fill = null;
        }
        if (fill == null && !rejected) {
            notes.add("미체결(" + status + ")");
        }

        boolean basisOk = fill != null && basisMatches(fill, series, notes);
        Double returnSinceFill = null;
        Double maxDrawdown = null;
        Stop stop = null;
        Double afterSell = null;
        String afterSellLabel = null;
        if (fill != null && buy) {
            if (basisOk && close != null) {
                returnSinceFill = pct(close / fill.price() - 1.0);
            }
            if (basisOk && hasHistory) {
                maxDrawdown = maxDrawdownPct(series, fill, weekEnding);
                if (maxDrawdown == null) {
                    notes.add("체결일(" + fill.date() + ")부터 기준일까지 종가 없음 — 최대 낙폭 null");
                }
            }
            stop = stop(o.ticker(), fill, weekEnding, stops, fullSells, basisOk, notes);
        } else if (fill != null && sell && basisOk && close != null) {
            afterSell = pct(close / fill.price() - 1.0);
            afterSellLabel = sellLabel(afterSell);
        }

        Hypothetical hypothetical = rejected && (buy || sell)
                ? hypothetical(calendar, asOf, weekEnding, series, close, sell, notes) : null;
        Ma200 ma200 = ma200(series, weekEnding, close, notes);
        Evidence evidence = evidence(fill, buy, sell, stop, maxDrawdown, ma200);
        return new OrderFacts(o.id(), o.ticker(), o.side(), o.targetWeightPct(), o.sellFraction(), o.timing(),
                status, !rejected, rejected ? o.rejectReason() : null, o.thesis(), o.invalidation(), fill,
                close == null ? null : round(close, 4), returnSinceFill, maxDrawdown, stop, afterSell, afterSellLabel,
                hypothetical, ma200, evaluate(o.invalidation(), evidence), notes);
    }

    /**
     * 복기 기준일 장 마감 시점의 주문 상태 — 그 뒤에 체결(FILLED)되거나 만료(EXPIRED)된 주문은 PENDING으로 되돌립니다. 토요일을 놓쳐 다음 주
     * 중에 돈 정기·수동 복기가 토요일에 돌린 것과 같은 입력이 되게, 그리고 기준일 뒤의 사건이 Claude에 새지 않게(룩어헤드). 만료는 장부가
     * 만료일 다음 세션에 처리하므로({@code expires_on < 세션}) 만료일이 기준일 이후인 EXPIRED는 기준일에 아직 대기 중이었습니다. 취소
     * (CANCELLED)는 시각이 없어 그대로 둡니다.
     */
    static String statusAt(Order o, LocalDate weekEnding) {
        String status = o.status();
        if (FILLED.equals(status) && o.fill() != null && o.fill().date().isAfter(weekEnding)) {
            return PENDING;
        }
        if (EXPIRED.equals(status) && o.expiresOn() != null && !o.expiresOn().isBefore(weekEnding)) {
            return PENDING;
        }
        return status;
    }

    /** 체결가와 체결일 이력 종가의 비가 띠 안인지. 체결일 종가가 없으면 확인하지 못하므로 그대로 씁니다. */
    private static boolean basisMatches(Fill fill, DailySeries series, List<String> notes) {
        if (series == null) {
            return true;
        }
        Double reference = series.valueOn(fill.date());
        if (reference == null || !(reference > 0)) {
            return true;
        }
        double ratio = fill.price() / reference;
        if (ratio < BASIS_LOW || ratio > BASIS_HIGH) {
            notes.add("체결가 " + round(fill.price(), 4) + " ÷ 체결일 이력 종가 " + round(reference, 4) + " = "
                    + round(ratio, 2) + " — " + BASIS_LOW + "~" + BASIS_HIGH
                    + " 밖이라 분할·병합 뒤 수정주가로 의심, 체결가 대비 수치를 내지 않음");
            return false;
        }
        return true;
    }

    /**
     * 체결일(포함)부터 기준일(포함)까지 종가의 고점 대비 최대 낙폭(%, 0 이하). 체결가를 첫 고점으로 둡니다 — 트레일링 스탑의 최고가가
     * 체결가에서 시작하는 것과 같은 기준({@link TrailingStop}). 그 구간에 종가가 없으면 null.
     */
    static Double maxDrawdownPct(DailySeries series, Fill fill, LocalDate weekEnding) {
        double peak = fill.price();
        double worst = 0.0;
        int seen = 0;
        for (int i = 0; i < series.size(); i++) {
            LocalDate d = series.dateAt(i);
            if (d.isBefore(fill.date())) {
                continue;
            }
            if (d.isAfter(weekEnding)) {
                break;
            }
            double value = series.valueAt(i);
            peak = Math.max(peak, value);
            worst = Math.min(worst, value / peak - 1.0);
            seen++;
        }
        return seen == 0 ? null : pct(worst);
    }

    /**
     * 체결일부터 기준일까지 그 종목의 첫 스탑 체결. 같은 날 스탑은 체결 뒤로 봅니다 — 스탑이 난 종목은 20거래일 재진입 금지라 같은 날
     * 스탑 뒤에 다시 살 수 없기 때문입니다({@link TrailingStop#lockoutUntil}).
     *
     * <p>매수 체결과 그 스탑 사이에 그 종목을 전량 매도했으면 그 스탑은 다시 산 포지션의 것입니다 — 포지션이 닫히면 장부의 스탑 기준
     * 최고가도 새로 시작하므로 이 매수의 스탑이 아닙니다(발동 안 함 + 이유). 날짜만으로 순서를 가르므로: 매수 체결일과 같은 날의 전량
     * 매도는 그 매수 <b>전</b>(한 관측치 안에서 장부는 매도를 매수보다 먼저 처리), 스탑과 같은 날의 전량 매도는 스탑 <b>전</b>으로 봅니다
     * (스탑이 먼저 났으면 팔 보유가 없어 그 매도는 체결되지 않고 취소됨).
     */
    private static Stop stop(String ticker, Fill fill, LocalDate weekEnding, List<StopFill> stops,
                             List<FullSell> fullSells, boolean basisOk, List<String> notes) {
        for (StopFill s : stops) {
            boolean inRange = !s.date().isBefore(fill.date()) && !s.date().isAfter(weekEnding);
            if (Objects.equals(s.ticker(), ticker) && inRange) {
                for (FullSell sold : fullSells) {
                    if (Objects.equals(sold.ticker(), ticker) && sold.date().isAfter(fill.date())
                            && !sold.date().isAfter(s.date())) {
                        notes.add("스탑(" + s.date() + ")은 그 전 " + sold.date() + " 전량 매도 뒤 다시 산 포지션의 것 — 이 매수의 "
                                + "스탑으로 보지 않음");
                        return new Stop(false, null, null, null);
                    }
                }
                Double r = basisOk ? pct(s.price() / fill.price() - 1.0) : null;
                return new Stop(true, s.date(), round(s.price(), 4), r);
            }
        }
        return new Stop(false, null, null, null);
    }

    /** 거절 주문: 결정 다음 세션 종가 → 기준일 종가. */
    private static Hypothetical hypothetical(TradingCalendar calendar, LocalDate asOf, LocalDate weekEnding,
                                             DailySeries series, Double close, boolean sell, List<String> notes) {
        LocalDate entry = calendar.nextTradingDay(asOf);
        if (entry.isAfter(weekEnding)) {
            notes.add("가정 수익률: 결정 다음 세션(" + entry + ")이 복기 기준일 뒤");
            return new Hypothetical(entry, null, null, null);
        }
        Double entryClose = series == null ? null : series.valueOn(entry);
        if (entryClose == null || !(entryClose > 0)) {
            if (series != null && !series.isEmpty()) {
                notes.add("가정 수익률: 결정 다음 세션(" + entry + ") 종가 없음");
            }
            return new Hypothetical(entry, null, null, null);
        }
        if (close == null) {
            return new Hypothetical(entry, round(entryClose, 4), null, null);
        }
        Double r = pct(close / entryClose - 1.0);
        return new Hypothetical(entry, round(entryClose, 4), r, sell ? sellLabel(r) : null);
    }

    /**
     * 기준일 종가와 그날까지 마지막 200개 점의 평균. 기준일 종가가 없거나 점이 200개 미만이면 null(이유는 notes — 기준일 종가 없음은
     * 이미 적혀 있음).
     */
    static Ma200 ma200(DailySeries series, LocalDate weekEnding, Double close, List<String> notes) {
        if (series == null || series.isEmpty() || close == null) {
            return null;
        }
        DailySeries upTo = series.until(weekEnding);
        int n = upTo.size();
        if (n < MOVING_AVERAGE_DAYS) {
            notes.add("200일선: 기준일까지 이력 " + n + "일 < " + MOVING_AVERAGE_DAYS + "일");
            return null;
        }
        double sum = 0.0;
        for (int i = n - MOVING_AVERAGE_DAYS; i < n; i++) {
            sum += upTo.valueAt(i);
        }
        double average = sum / MOVING_AVERAGE_DAYS;
        if (!(average > 0)) {
            notes.add("200일선: 평균이 0 이하");
            return null;
        }
        return new Ma200(round(close, 4), round(average, 4), pct(close / average - 1.0), close < average);
    }

    /** 주문 사실에서 무효화 평가에 쓸 사실과 '못 쓰는 이유'. */
    private static Evidence evidence(Fill fill, boolean buy, boolean sell, Stop stop, Double maxDrawdown, Ma200 ma200) {
        String fillOnly = sell ? "매도 주문 — 해당 없음" : "매수 체결 없음";
        boolean bought = fill != null && buy;
        Boolean stopTriggered = bought ? stop.triggered() : null;
        String drawdownReason = !bought ? fillOnly : maxDrawdown == null ? "체결 뒤 최대 낙폭 없음(notes)" : null;
        return new Evidence(stopTriggered, bought ? null : fillOnly, maxDrawdown, drawdownReason,
                ma200 == null ? null : ma200.below(), ma200 == null ? "200일선 없음(notes)" : null);
    }

    // ------------------------------------------------------------------ 무효화 조건
    /**
     * 무효화 문장에서 코드가 읽을 수 있는 조건(클래스 설명 (a)~(c))을 찾아 사실로 평가합니다. 결과는 읽은 조건 중 하나라도 충족이면
     * {@link #MET}, 모두 평가했고 하나도 아니면 {@link #NOT_MET}, 일부만 평가했고 충족이 없으면 {@link #PARTIAL}, 읽은 조건이 없거나
     * 하나도 평가하지 못하면 {@link #UNEVALUABLE}. 조건 사이의 '그리고·또는'은 읽지 않습니다 — 조건별 결과를 그대로 남깁니다.
     */
    public static InvalidationCheck evaluate(String invalidation, Evidence e) {
        Objects.requireNonNull(e, "evidence");
        if (invalidation == null || invalidation.isBlank()) {
            return new InvalidationCheck(UNEVALUABLE, List.of(), "무효화 조건 없음");
        }
        List<Check> checks = new ArrayList<>();
        if (STOP_WORD.matcher(invalidation).find()) {
            checks.add(new Check(STOP, null, e.stopTriggered(), e.stopTriggered() == null ? e.stopReason() : null));
        }
        if (mentionsBelow200(invalidation)) {
            checks.add(new Check(MA200, null, e.below200(), e.below200() == null ? e.ma200Reason() : null));
        }
        for (BigDecimal n : dropThresholds(invalidation)) {
            double threshold = -n.doubleValue();
            Boolean met = e.maxDrawdownPct() == null ? null : e.maxDrawdownPct() <= threshold;
            checks.add(new Check(DRAWDOWN, threshold, met, met == null ? e.drawdownReason() : null));
        }
        if (checks.isEmpty()) {
            return new InvalidationCheck(UNEVALUABLE, checks,
                    "코드가 읽는 조건(스탑·200일선 이탈·N% 하락)이 아님 — 주문 사실로 판단");
        }
        boolean anyMet = checks.stream().anyMatch(c -> Boolean.TRUE.equals(c.met()));
        boolean anyUnknown = checks.stream().anyMatch(c -> c.met() == null);
        boolean allUnknown = checks.stream().allMatch(c -> c.met() == null);
        String result = anyMet ? MET : allUnknown ? UNEVALUABLE : anyUnknown ? PARTIAL : NOT_MET;
        return new InvalidationCheck(result, checks, null);
    }

    /** 200일선 언급에 아래 방향 말이 붙어 있는지({@link #MA200_GAP} — 언급 바로 뒤, 또는 영어 'below the 200-day'). */
    private static boolean mentionsBelow200(String text) {
        return MA200_THEN_BELOW.matcher(text).find() || BELOW_THEN_MA200.matcher(text).find();
    }

    /** 주가 하락 폭 N(0 초과 100 미만)들 — 작은 것부터, 같은 수는 한 번. 주가가 아닌 수치의 −N%는 뺍니다({@link #priceDrop}). */
    private static List<BigDecimal> dropThresholds(String text) {
        // 가격 조건의 일부인 말(고점 대비·실적 발표)은 먼저 같은 길이의 공백으로 가립니다 — 창이 그 말을 반쯤 잘라도 '대비'만 남지 않게.
        String masked = mask(text, PRICE_CONTEXT);
        TreeSet<BigDecimal> out = new TreeSet<>();
        for (Pattern p : List.of(MINUS_PERCENT, PERCENT_DROP, DROP_PERCENT)) {
            Matcher m = p.matcher(text);
            while (m.find()) {
                BigDecimal n = new BigDecimal(m.group(1)).stripTrailingZeros();
                if (n.signum() > 0 && n.compareTo(BigDecimal.valueOf(100)) < 0 && priceDrop(masked, m.start(), m.end())) {
                    out.add(n);
                }
            }
        }
        return new ArrayList<>(out);
    }

    /**
     * [start, end)의 하락 폭이 주가 조건인지 — 같은 절의 앞 {@link #METRIC_BEFORE}자와 뒤 {@link #METRIC_AFTER}자에 주가가 아닌 수치·상대
     * 성과의 말이 없으면 참({@link #NON_PRICE_BEFORE} 위 설명). 절은 쉼표·'또는' 같은 말에서 끊습니다 — '가이던스 하향 또는 −8% 하락'의
     * '−8%'는 가격 조건입니다.
     */
    private static boolean priceDrop(String masked, int start, int end) {
        String before = masked.substring(Math.max(0, start - METRIC_BEFORE), start);
        Matcher cut = CLAUSE_BREAK.matcher(before);
        int from = 0;
        while (cut.find()) {
            from = cut.end();
        }
        if (NON_PRICE_BEFORE.matcher(before.substring(from)).find()) {
            return false;
        }
        String after = masked.substring(end, Math.min(masked.length(), end + METRIC_AFTER));
        Matcher stop = CLAUSE_BREAK.matcher(after);
        if (stop.find()) {
            after = after.substring(0, stop.start());
        }
        return !NON_PRICE_AFTER.matcher(after).find();
    }

    /** pattern에 맞는 곳을 같은 길이의 공백으로 바꿉니다(위치를 그대로 두려고). */
    private static String mask(String text, Pattern pattern) {
        Matcher m = pattern.matcher(text);
        StringBuilder out = new StringBuilder(text);
        while (m.find()) {
            for (int i = m.start(); i < m.end(); i++) {
                out.setCharAt(i, ' ');
            }
        }
        return out.toString();
    }

    // ------------------------------------------------------------------ 계좌 비교
    /**
     * 같은 기간 계좌별 순자산 수익률. 기간은 창 시작(after) 당일(휴장이면 직전 거래일) 종가 → 기준일 종가. 기준일 줄이 있는 계좌 중
     * 하나라도 시작 줄이 없으면(계좌가 창 중간에 시작) 그 계좌들 모두에 줄이 있는 첫 날부터 셉니다 — 계좌마다 기간이 다르면 비교가
     * 아닙니다. 기준일 줄이 없는 계좌는 null(시작 전·기록 누락), 0이 아닙니다.
     */
    static Comparison comparison(List<BookNav> books, Window window) {
        return comparison(UsMarketCalendar.CALENDAR, books, window);
    }

    /** {@link #comparison(List, Window)}와 같되 시작일(창 시작 당일, 휴장이면 직전 거래일)을 그 시장 달력으로. */
    static Comparison comparison(TradingCalendar calendar, List<BookNav> books, Window window) {
        LocalDate base = calendar.isTradingDay(window.after()) ? window.after()
                : calendar.previousTradingDay(window.after());
        LocalDate end = window.through();
        Map<String, TreeMap<LocalDate, NavPoint>> byBook = new LinkedHashMap<>();
        for (BookNav b : books) {
            TreeMap<LocalDate, NavPoint> rows = new TreeMap<>();
            for (NavPoint p : b.rows()) {
                if (!p.date().isBefore(base) && !p.date().isAfter(end)) {
                    rows.put(p.date(), p);
                }
            }
            byBook.put(b.book(), rows);
        }
        List<String> withEnd = new ArrayList<>();
        byBook.forEach((book, rows) -> {
            if (rows.containsKey(end)) {
                withEnd.add(book);
            }
        });
        LocalDate from = commonStart(byBook, withEnd, base, end);
        String note;
        if (from == null) {
            note = "모든 계좌에 순자산 줄이 있는 시작일이 없음 — 수익률 null";
        } else if (from.equals(base)) {
            note = "순자산 수익률(%) — " + from + " 종가 → " + end + " 종가. isEstimated = 확정 종가가 아닌 줄을 씀";
        } else {
            note = "순자산 수익률(%) — 창 시작(" + base + ")에 순자산이 없는 계좌가 있어 모두 줄이 있는 첫 날 " + from
                    + " 종가 → " + end + " 종가. isEstimated = 확정 종가가 아닌 줄을 씀";
        }
        List<BookReturn> out = new ArrayList<>();
        byBook.forEach((book, rows) -> {
            NavPoint last = rows.get(end);
            if (last == null) {
                out.add(new BookReturn(book, null, null, rows.isEmpty() && noRowsAtAll(books, book)
                        ? "순자산 기록 없음" : "복기 기준일(" + end + ") 순자산 없음"));
                return;
            }
            NavPoint first = from == null ? null : rows.get(from);
            if (first == null || !(first.nav() > 0)) {
                out.add(new BookReturn(book, null, null, "공통 시작일 순자산 없음"));
                return;
            }
            boolean estimated = !(first.pricesFinal() && last.pricesFinal());
            out.add(new BookReturn(book, pct(last.nav() / first.nav() - 1.0), estimated, null));
        });
        return new Comparison(from, end, note, out);
    }

    /** base에 모두 줄이 있으면 base, 아니면 (base, end) 안에서 모두 줄이 있는 첫 날. 없으면 null. */
    private static LocalDate commonStart(Map<String, TreeMap<LocalDate, NavPoint>> byBook, List<String> books,
                                         LocalDate base, LocalDate end) {
        if (books.isEmpty()) {
            return null;
        }
        for (LocalDate d : byBook.get(books.get(0)).headMap(end, false).keySet()) {
            boolean all = true;
            for (String book : books) {
                if (!byBook.get(book).containsKey(d)) {
                    all = false;
                    break;
                }
            }
            if (all) {
                return d;   // 날짜 오름차순이라 base가 있으면 base가 먼저 나옵니다.
            }
        }
        return null;
    }

    private static boolean noRowsAtAll(List<BookNav> books, String book) {
        for (BookNav b : books) {
            if (Objects.equals(b.book(), book) && !b.rows().isEmpty()) {
                return false;
            }
        }
        return true;
    }

    // ------------------------------------------------------------------ 직렬화 모양
    static Map<String, Object> toMap(Facts f) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("inputVersion", INPUT_VERSION);
        out.put("weekEnding", text(f.weekEnding()));
        Map<String, Object> window = new LinkedHashMap<>();
        window.put("weeks", f.window().weeks());
        window.put("after", text(f.window().after()));
        window.put("through", text(f.window().through()));
        window.put("rule", "결정 기준일 ∈ (after, through]");
        out.put("window", window);
        out.put("trimmedReason", f.trimmedReason());
        Map<String, Object> framework = new LinkedHashMap<>();
        framework.put("version", f.frameworkVersion());
        framework.put("status", f.frameworkStatus());
        out.put("framework", framework);
        out.put("note", NOTE);
        List<Object> decisions = new ArrayList<>();
        f.decisions().forEach(d -> decisions.add(decisionMap(d)));
        out.put("decisions", decisions);
        out.put("omittedDecisions", new LinkedHashMap<>(f.omittedDecisions()));
        out.put("comparison", comparisonMap(f.comparison()));
        return out;
    }

    private static Map<String, Object> decisionMap(DecisionFacts d) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.id());
        m.put("kind", d.kind());
        m.put("asOf", text(d.asOf()));
        m.put("status", d.status());
        m.put("stance", d.stance());
        m.put("targetExposurePct", d.targetExposurePct());
        if (NO_TRADE.equals(d.status()) && d.orders().isEmpty()) {
            m.put("noTradeReason", d.noTradeReason());
            m.put("frameworkVersion", d.frameworkVersion());
            return m;
        }
        m.put("summary", d.summary());
        m.put("exposureRationale", d.exposureRationale());
        if (d.noTradeReason() != null) {
            m.put("noTradeReason", d.noTradeReason());
        }
        m.put("frameworkVersion", d.frameworkVersion());
        List<Object> orders = new ArrayList<>();
        d.orders().forEach(o -> orders.add(orderMap(o)));
        m.put("orders", orders);
        return m;
    }

    private static Map<String, Object> orderMap(OrderFacts o) {
        boolean buy = BUY.equals(o.side());
        boolean sell = SELL.equals(o.side());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", o.id());
        m.put("ticker", o.ticker());
        m.put("side", o.side());
        if (buy) {
            m.put("targetWeightPct", o.targetWeightPct());
        } else if (sell) {
            m.put("sellFraction", o.sellFraction());
        }
        m.put("timing", o.timing());
        m.put("status", o.status());
        m.put("accepted", o.accepted());
        if (!o.accepted()) {
            m.put("rejectReason", o.rejectReason());
        }
        m.put("thesis", o.thesis());
        m.put("invalidation", o.invalidation());
        if (o.fill() == null) {
            m.put("fill", null);
        } else {
            Map<String, Object> fill = new LinkedHashMap<>();
            fill.put("date", text(o.fill().date()));
            fill.put("price", round(o.fill().price(), 4));
            m.put("fill", fill);
        }
        m.put("weekEndingClose", o.weekEndingClose());
        if (o.fill() != null && buy) {
            m.put("returnSinceFillPct", o.returnSinceFillPct());
            m.put("maxDrawdownPct", o.maxDrawdownPct());
            Map<String, Object> stop = new LinkedHashMap<>();
            stop.put("triggered", o.stop().triggered());
            if (o.stop().triggered()) {
                stop.put("date", text(o.stop().date()));
                stop.put("price", o.stop().price());
                stop.put("returnPct", o.stop().returnPct());
            }
            m.put("stop", stop);
        } else if (o.fill() != null && sell) {
            m.put("afterSellPct", o.afterSellPct());
            m.put("afterSellLabel", o.afterSellLabel());
        }
        if (o.hypothetical() != null) {
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("basis", HYPOTHETICAL);
            h.put("entryDate", text(o.hypothetical().entryDate()));
            h.put("entryClose", o.hypothetical().entryClose());
            h.put("returnPct", o.hypothetical().returnPct());
            if (sell) {
                h.put("afterSellLabel", o.hypothetical().afterSellLabel());
            }
            m.put("hypothetical", h);
        }
        if (o.ma200() == null) {
            m.put("ma200", null);
        } else {
            Map<String, Object> ma = new LinkedHashMap<>();
            ma.put("close", o.ma200().close());
            ma.put("average", o.ma200().average());
            ma.put("vsPct", o.ma200().vsPct());
            ma.put("below", o.ma200().below());
            m.put("ma200", ma);
        }
        m.put("invalidationCheck", checkMap(o.invalidationCheck()));
        if (!o.notes().isEmpty()) {
            m.put("notes", o.notes());
        }
        return m;
    }

    private static Map<String, Object> checkMap(InvalidationCheck c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("result", c.result());
        List<Object> checks = new ArrayList<>();
        for (Check check : c.checks()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("pattern", check.pattern());
            if (check.thresholdPct() != null) {
                row.put("thresholdPct", check.thresholdPct());
            }
            row.put("met", check.met());
            if (check.reason() != null) {
                row.put("reason", check.reason());
            }
            checks.add(row);
        }
        m.put("checks", checks);
        if (c.reason() != null) {
            m.put("reason", c.reason());
        }
        return m;
    }

    private static Map<String, Object> comparisonMap(Comparison c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("from", text(c.from()));
        m.put("to", text(c.to()));
        m.put("note", c.note());
        List<Object> books = new ArrayList<>();
        for (BookReturn b : c.books()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("book", b.book());
            row.put("returnPct", b.returnPct());
            row.put("isEstimated", b.isEstimated());
            if (b.reason() != null) {
                row.put("reason", b.reason());
            }
            books.add(row);
        }
        m.put("books", books);
        return m;
    }

    // ------------------------------------------------------------------ 도우미
    /** 매도 뒤 변화의 표시 — 반올림한 값(화면·입력에 보이는 값)으로 정합니다. */
    private static String sellLabel(Double pct) {
        if (pct == null) {
            return null;
        }
        return pct < 0 ? AVOIDED : pct > 0 ? MISSED : FLAT;
    }

    /** 비율 → % 소수 둘째 자리(0.5는 0에서 먼 쪽). NaN·무한대면 null. */
    private static Double pct(double ratio) {
        return round(ratio * 100.0, 2);
    }

    private static Double round(double v, int scale) {
        if (!Double.isFinite(v)) {
            return null;
        }
        // Math.round(v × 10^n) / 10^n은 0.145 × 100 = 14.499…처럼 끝자리가 틀립니다(PaperLedger.round4와 같은 이유).
        return BigDecimal.valueOf(v).setScale(scale, RoundingMode.HALF_UP).doubleValue();
    }

    /** max자로 자르고 끝에 '…'(합쳐 max자, PacketBuilder와 같은 꼴). 서로게이트 쌍을 가르지 않습니다. */
    static String clip(String text, int max) {
        if (text == null || text.length() <= max) {
            return text;
        }
        int cut = max - 1;
        if (cut > 0 && Character.isHighSurrogate(text.charAt(cut - 1))) {
            cut--;
        }
        return text.substring(0, cut) + "…";
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
