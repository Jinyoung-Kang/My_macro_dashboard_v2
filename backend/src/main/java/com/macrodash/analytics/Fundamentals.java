package com.macrodash.analytics;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * 미국 종목 재무 — SEC XBRL Company Facts 사실로 그날 <b>알 수 있었던</b> TTM·성장률·마진·FCF·듀퐁 항
 * (명세 D28, 설계 §4-5 ④~⑥).
 *
 * <p>수집기({@code sec_fundamentals})가 공시일({@code filed})마다 그날 처음 낸(또는 값이 바뀐) 사실 묶음을 쌓고, 여기서는
 * 한 종목의 묶음 전부와 기준일을 받아 지표를 계산합니다. 저장소 없이 테스트하는 순수 계산입니다.
 *
 * <p><b>왜 공시일로 거르는가</b>: 분기 말 숫자는 몇 주 뒤에야 공개되고, 정정 공시(/A)는 그보다 더 늦게 옛 값을 바꿉니다(측정상
 * /A 사실의 5%는 값이 다름). 기준일 d의 결정에는 {@code filed ≤ d}인 사실만 쓰고, 같은 (분류체계, 개념, 단위, 시작, 끝)이
 * 여럿이면 그 안에서 가장 늦게 낸 값을 씁니다 — 13F의 {@code filingDate ≤ asOf}와 같은 규칙입니다. 뒤에 낸 정정값으로 과거를
 * 계산하면 그때는 몰랐던 숫자로 판단한 셈이 됩니다.
 *
 * <p><b>왜 기간을 시작·끝으로만 판단하는가</b>: {@code fy}·{@code fp}는 사실의 기간이 아니라 그 사실을 담은 공시의
 * 회계연도·분기이고(같은 분기가 다음 해 비교 열로 다시 나옴), {@code frame}은 가장 늦게 낸 값에만 붙어 그 시점의 값이
 * 아닙니다. 그래서 기간 길이로 3개월·6개월·9개월·연간을 나눕니다(52/53주 회계연도를 감안한 폭, {@link Span}).
 *
 * <p><b>왜 누계를 빼는가</b>: 10-Q 현금흐름은 연초부터의 누계(YTD)뿐이고, 10-K에는 4분기 3개월 사실이 없습니다. 분기 값은
 * 3개월 사실이 있으면 그것, 없으면 누계 차감(Q2 = 6M − Q1, Q3 = 9M − 6M, Q4 = FY − 9M)입니다. TTM은 직전 연간 + 당해 누계 −
 * 전년 같은 누계(또는 최근 4개 분기 합)이고, 둘 다 되는데 다르면(정정이 한쪽에만 반영 등) 연간 기준을 쓰고 {@code notes}에
 * 적습니다. 전년 누계만 연간 공시 <b>뒤에</b> 재작성됐으면(중단영업 재분류 — 연간은 다음 10-K에서야 고침) 두 방법이 같은 섞인
 * 값을 내므로 대조로는 잡히지 않습니다. 그때는 TTM을 내지 않고 {@code notes}에 적습니다({@link #revisedAfter}).
 *
 * <p><b>왜 개념을 '가장 최근 end'로 고르는가</b>: 회사마다 태그가 다르고 바뀌기도 합니다(JPM은 {@code Revenues}가 10-K에만,
 * 분기는 {@code RevenuesNetOfInterestExpense}). 고정 우선순위로 고르면 몇 년 전에 멈춘 개념을 집어 듭니다. 후보 가운데 가장
 * 최근 end를 가진 개념을 고르고(같으면 {@link #CANDIDATES} 순서), 한 필드의 시계열 안에서는 개념을 섞지 않습니다 — 섞으면
 * 정의가 다른 숫자끼리 빼고 더하게 됩니다. 쓴 개념 이름은 {@link Result#conceptsUsed()}로 함께 냅니다.
 *
 * <p><b>모든 값은 한 기간 기준</b>: 손익·현금흐름 TTM과 재무상태 값은 전부 {@link Result#latestPeriodEnd()}(고른 개념들의 가장
 * 늦은 end) 기준입니다. 어떤 필드가 그 기간 값을 만들 수 없으면 옛 기간 값을 대신 넣지 않고 null + {@code notes}입니다 — 마진·
 * FCF·듀퐁 항이 서로 다른 기간을 섞지 않게 하기 위해서입니다. 주식수만 예외로 그 개념의 최신 end(표지의 기준일은 기간 말보다
 * 늦음)를 씁니다.
 *
 * <p>단위
 * <ul>
 *   <li>금액(…Ttm·{@code longTermDebt})은 보고 통화 원 단위 그대로입니다(패킷이 백만 달러로 바꿈). <b>보고 통화가 USD가
 *       아니면 금액은 전부 null</b>이고 비율·성장률만 냅니다 — 환율·ADS 비율 없이 금액을 다른 종목과 비교하지 않게.</li>
 *   <li>비율·성장률({@code revenueYoY}·{@code netMargin}·{@code fcfConversion}·{@code roe}·{@code receivablesYoY}·
 *       {@code inventoryYoY}·{@code sharesYoY}·{@code debtToEquity})은 ×100(%) 값입니다({@link KrFundamentals}와 같음).</li>
 *   <li>{@code assetTurnover}·{@code leverage}는 배수(배)입니다. 그래서 {@code roe = netMargin × assetTurnover × leverage}가
 *       그대로 성립합니다(듀퐁).</li>
 * </ul>
 *
 * <p>사실이 없거나 계산할 수 없는 값은 0이 아니라 null입니다(자사주·배당이 없는 것은 대개 '안 함'이지만 확인할 수 없음).
 */
public final class Fundamentals {

    private Fundamentals() {
    }

    public static final String REVENUE = "revenue";
    public static final String NET_INCOME = "netIncome";
    public static final String OCF = "ocf";
    public static final String CAPEX = "capex";
    public static final String ASSETS = "assets";
    public static final String EQUITY = "equity";
    public static final String RECEIVABLES = "receivables";
    public static final String INVENTORY = "inventory";
    public static final String LONG_TERM_DEBT = "longTermDebt";
    public static final String BUYBACKS = "buybacks";
    public static final String DIVIDENDS = "dividends";
    public static final String SHARES = "shares";

    /** 1년 전 값을 찾을 때 허용하는 날짜 차(달력일) — 52/53주 회계연도는 7일 안팎, 표지 기준일은 몇 주씩 움직입니다. 분기 간격(약 91일)보다는 훨씬 좁게. */
    static final int YEAR_TOLERANCE_DAYS = 31;
    /**
     * 주식수 1년 변화를 내지 않는 배율(이 배 이상이거나 1/이 배 이하). 표지 주식수(dei)는 공시마다 기준일이 달라 분할 뒤에도 옛 값이
     * 소급 수정되지 않고, us-gaap 발행주식수의 1년 전 값도 원래 공시 그대로라 10:1 분할이면 +900%가 '대규모 희석'으로, 역분할이면
     * −90%가 '대규모 소각'으로 읽힙니다. 1.5가 아니라 1.4인 것은 3:2 분할(1.5배)에 자사주 소각이 겹쳐 1.5배 아래로 내려온 경우도
     * 잡으려는 것입니다 — 분할 없이 1년에 40% 넘게 늘거나 30% 가까이 주는 경우(대규모 주식 인수)도 함께 빠지지만, 틀린 신호를 내는
     * 것보다 '비율 없음 + 사유'가 낫습니다.
     */
    static final double SPLIT_RATIO = 1.4;
    /** 최신 기간 end가 기준일보다 이 개월 수를 넘게 앞서면 {@code isStale}(측정상 IFRS 2026 연보가 companyfacts에 없는 13곳 등). */
    static final int STALE_MONTHS = 15;
    /**
     * 두 TTM(연간 기준·분기 합)이 '다르다'고 보는 상대 차. 백만 단위로 반올림해 내는 회사는 분기 합과 누계가 끝자리에서 어긋나므로
     * 그 정도의 잡음으로는 표시하지 않습니다(정정이면 대개 % 단위로 다름 — GPRO 9개월 순이익 −84.4M → −90.5M).
     */
    static final double TTM_MISMATCH = 0.001;

    private static final Pattern CURRENCY = Pattern.compile("[A-Z]{3}");
    private static final String SHARES_UNIT = "shares";
    private static final String DEI = "dei";
    private static final List<String> TAXONOMY_ORDER = List.of("us-gaap", "ifrs-full");

    /**
     * 공시 사실 하나(payload {@code facts[]}의 한 칸).
     *
     * @param t 분류체계({@code us-gaap}·{@code ifrs-full}·{@code dei})
     * @param c 개념 이름
     * @param u 단위({@code USD}·{@code EUR}·{@code shares}…)
     * @param s 기간 시작. 시점 사실(재무상태)은 null
     * @param e 기간 끝(시점 사실은 그날)
     * @param v 값. null이면 이 사실은 없는 것으로 봅니다
     * @param f 서식({@code 10-Q}·{@code 10-K/A}…)
     * @param a 접수 번호(accn)
     */
    public record Fact(String t, String c, String u, LocalDate s, LocalDate e, Double v, String f, String a) {
    }

    /**
     * 한 공시일의 사실 묶음({@code observations} 한 행 — {@code obs_date = filed}).
     *
     * @param filed 공시일. null이면 시점을 알 수 없어 행 전체를 쓰지 않습니다
     * @param facts null이면 빈 목록
     */
    public record Row(LocalDate filed, List<Fact> facts) {
        public Row {
            facts = facts == null ? List.of() : Collections.unmodifiableList(new ArrayList<>(facts));
        }
    }

    /**
     * 한 종목의 그 시점 재무 지표. 값을 만들 수 없으면 null이고 이유는 {@code notes}에 있습니다.
     *
     * @param latestPeriodEnd     고른 개념들의 가장 늦은 기간 end — 모든 TTM·재무상태 값의 기준. 사실이 없으면 null
     * @param filed               그 기간 사실을 담은 공시 가운데 가장 늦은 것의 공시일
     * @param form                그 공시의 서식
     * @param currency            보고 통화(금액 사실의 단위). 금액 사실이 없으면 null
     * @param taxonomy            쓴 개념의 분류체계({@code us-gaap}·{@code ifrs-full}, 섞였으면 쉼표로 이음. {@code dei} 제외)
     * @param revenueTtm          매출 TTM(보고 통화 원 단위, USD 아니면 null)
     * @param revenueYoY          매출 TTM의 1년 전 TTM 대비 증가율(%)
     * @param netIncomeTtm        순이익 TTM(금액)
     * @param netMargin           순이익 TTM ÷ 매출 TTM(%)
     * @param ocfTtm              영업현금흐름 TTM(금액)
     * @param capexTtm            설비투자 TTM(금액, 지출이 양수)
     * @param fcfTtm              영업현금흐름 − 설비투자(금액). 설비투자가 없으면 null
     * @param fcfConversion       FCF ÷ 순이익(%). 순이익 ≤ 0이거나 FCF가 없으면 null
     * @param fcfConversionReason {@code fcfConversion}이 null인 이유(값이 있으면 null)
     * @param assetTurnover       매출 TTM ÷ 평균 자산(배)
     * @param leverage            평균 자산 ÷ 평균 자본(배). 평균 자본 ≤ 0이면 null
     * @param roe                 순이익 TTM ÷ 평균 자본(%) — {@code netMargin × assetTurnover × leverage}와 같음
     * @param receivablesYoY      매출채권 1년 전 대비(%)
     * @param inventoryYoY        재고 1년 전 대비(%)
     * @param sharesYoY           주식수 1년 전 대비(%) — 자사주 소각 확인용. 분할·병합 모양({@link #SPLIT_RATIO})이면 null + 메모
     * @param buybacksTtm         자사주 매입 TTM(금액)
     * @param dividendsTtm        배당 지급 TTM(금액)
     * @param longTermDebt        장기부채(금액, 최신 기간 말). 유동분 포함 여부가 개념마다 달라 {@code conceptsUsed}를 함께 봄
     * @param debtToEquity        장기부채 ÷ 최신 자본(%). 자본 ≤ 0이면 null
     * @param conceptsUsed        값을 낸 필드 → 쓴 개념({@code 분류체계:개념}), {@link #CANDIDATES} 순서
     * @param isStale             최신 기간 end가 기준일보다 15개월 넘게 앞섬
     * @param isProxy             주식수를 가중평균 희석 주식수로 대신함
     * @param notes               계산하지 못했거나 대신한 것의 설명(결정적 순서 — 뜻이 큰 것부터, {@link Notes})
     */
    public record Result(LocalDate latestPeriodEnd, LocalDate filed, String form, String currency, String taxonomy,
                         Double revenueTtm, Double revenueYoY, Double netIncomeTtm, Double netMargin,
                         Double ocfTtm, Double capexTtm, Double fcfTtm, Double fcfConversion,
                         String fcfConversionReason, Double assetTurnover, Double leverage, Double roe,
                         Double receivablesYoY, Double inventoryYoY, Double sharesYoY,
                         Double buybacksTtm, Double dividendsTtm, Double longTermDebt, Double debtToEquity,
                         Map<String, String> conceptsUsed, boolean isStale, boolean isProxy, List<String> notes) {
        public Result {
            conceptsUsed = conceptsUsed == null ? Map.of()
                    : Collections.unmodifiableMap(new LinkedHashMap<>(conceptsUsed));
            notes = notes == null ? List.of() : List.copyOf(notes);
        }
    }

    /** 필드가 담는 사실의 종류 — 기간 흐름(TTM), 시점 잔액, 주식수(시점 또는 가중평균 기간). */
    private enum Kind { FLOW, STOCK, SHARES }

    private record FieldSpec(String key, Kind kind, List<String> candidates) {
    }

    /** 필드별 개념 후보({@code 분류체계:개념}) — 설계 §4-5 ⑤ 그대로. 순서는 end가 같을 때의 우선순위입니다. */
    private static final List<FieldSpec> FIELDS = List.of(
            new FieldSpec(REVENUE, Kind.FLOW, List.of(
                    "us-gaap:Revenues",
                    "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
                    "us-gaap:RevenuesNetOfInterestExpense",
                    "ifrs-full:Revenue")),
            new FieldSpec(NET_INCOME, Kind.FLOW, List.of(
                    "us-gaap:NetIncomeLoss",
                    "us-gaap:ProfitLoss",
                    "ifrs-full:ProfitLossAttributableToOwnersOfParent",
                    "ifrs-full:ProfitLoss")),
            new FieldSpec(OCF, Kind.FLOW, List.of(
                    "us-gaap:NetCashProvidedByUsedInOperatingActivities",
                    "ifrs-full:CashFlowsFromUsedInOperatingActivities")),
            new FieldSpec(CAPEX, Kind.FLOW, List.of(
                    "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
                    "us-gaap:PaymentsToAcquireProductiveAssets",
                    "us-gaap:PaymentsToAcquireOtherPropertyPlantAndEquipment",
                    "us-gaap:PaymentsToAcquireRealEstate",
                    "us-gaap:PaymentsToDevelopRealEstateAssets",
                    "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities")),
            new FieldSpec(ASSETS, Kind.STOCK, List.of(
                    "us-gaap:Assets",
                    "ifrs-full:Assets")),
            new FieldSpec(EQUITY, Kind.STOCK, List.of(
                    "us-gaap:StockholdersEquity",
                    "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
                    "us-gaap:PartnersCapital",
                    "ifrs-full:EquityAttributableToOwnersOfParent",
                    "ifrs-full:Equity")),
            new FieldSpec(RECEIVABLES, Kind.STOCK, List.of(
                    "us-gaap:AccountsReceivableNetCurrent",
                    "us-gaap:ReceivablesNetCurrent",
                    "ifrs-full:TradeAndOtherCurrentReceivables",
                    "ifrs-full:CurrentTradeReceivables")),
            new FieldSpec(INVENTORY, Kind.STOCK, List.of(
                    "us-gaap:InventoryNet",
                    "us-gaap:InventoryFinishedGoodsNetOfReserves",
                    "ifrs-full:Inventories")),
            new FieldSpec(LONG_TERM_DEBT, Kind.STOCK, List.of(
                    "us-gaap:LongTermDebt",
                    "us-gaap:LongTermDebtNoncurrent",
                    "us-gaap:LongTermDebtAndCapitalLeaseObligations",
                    "us-gaap:LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
                    "us-gaap:DebtInstrumentCarryingAmount",
                    "ifrs-full:LongtermBorrowings",
                    "ifrs-full:NoncurrentPortionOfNoncurrentBorrowings",
                    "ifrs-full:Borrowings")),
            new FieldSpec(BUYBACKS, Kind.FLOW, List.of(
                    "us-gaap:PaymentsForRepurchaseOfCommonStock",
                    "us-gaap:PaymentsForRepurchaseOfEquity",
                    "ifrs-full:PaymentsToAcquireOrRedeemEntitysShares")),
            new FieldSpec(DIVIDENDS, Kind.FLOW, List.of(
                    "us-gaap:PaymentsOfDividends",
                    "us-gaap:PaymentsOfDividendsCommonStock",
                    "us-gaap:PaymentsOfOrdinaryDividends",
                    "us-gaap:DistributionMadeToLimitedPartnerCashDistributionsPaid",
                    "ifrs-full:DividendsPaidClassifiedAsFinancingActivities",
                    "ifrs-full:DividendsPaid")),
            new FieldSpec(SHARES, Kind.SHARES, List.of(
                    "dei:EntityCommonStockSharesOutstanding",
                    "us-gaap:CommonStockSharesOutstanding",
                    "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding",
                    "ifrs-full:AdjustedWeightedAverageShares")));

    /** 필드 → 개념 후보({@code 분류체계:개념}, 우선순위 순). 수집기가 추출하는 개념 목록과 같아야 합니다. */
    public static final Map<String, List<String>> CANDIDATES;

    /** 가중평균 주식수 — 발행주식수가 아니라 대용치({@code isProxy}). */
    static final Set<String> PROXY_SHARES = Set.of(
            "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding",
            "ifrs-full:AdjustedWeightedAverageShares");

    private static final Set<String> ALL_CONCEPTS;
    private static final Set<String> MONETARY_CONCEPTS;

    static {
        Map<String, List<String>> candidates = new LinkedHashMap<>();
        Set<String> all = new LinkedHashSet<>();
        Set<String> monetary = new LinkedHashSet<>();
        for (FieldSpec spec : FIELDS) {
            candidates.put(spec.key(), spec.candidates());
            all.addAll(spec.candidates());
            if (spec.kind() != Kind.SHARES) {
                monetary.addAll(spec.candidates());
            }
        }
        CANDIDATES = Collections.unmodifiableMap(candidates);
        ALL_CONCEPTS = Collections.unmodifiableSet(all);
        MONETARY_CONCEPTS = Collections.unmodifiableSet(monetary);
    }

    /**
     * 기간 길이 분류(시작~끝 달력일 차, 52/53주 회계연도 감안). 폭은 3개월 = 12~17주, 6개월 = 24~28주, 9개월 = 36~40주로 잡습니다 —
     * 12-12-12-16주 달력(COST: 24주 누계 167일, 16주 4분기 111일)과 16-12-12-12주 달력(KR: 16주 1분기 111일, 28주 누계 195일)의
     * 누계·분기가 어느 폭에서도 빠지면 그 회사의 흐름 지표가 해마다 반년 가까이 통째로 비었습니다. 네 폭은 서로 겹치지 않습니다.
     * 어느 폭에도 들지 않는 기간(인수 직후의 짧은 기간 등)은 분류하지 않고 계산에서 뺍니다.
     */
    enum Span {
        QUARTER(80, 120), HALF(160, 200), NINE_MONTHS(240, 290), YEAR(350, 380);

        final int minDays;
        final int maxDays;

        Span(int minDays, int maxDays) {
            this.minDays = minDays;
            this.maxDays = maxDays;
        }

        /** 누계 차감의 짝 — 이 누계에서 앞 누계를 빼면 마지막 분기(6M − Q1, 9M − 6M, FY − 9M). */
        Span next() {
            return switch (this) {
                case QUARTER -> HALF;
                case HALF -> NINE_MONTHS;
                case NINE_MONTHS -> YEAR;
                case YEAR -> null;
            };
        }
    }

    /** 기간 분류. 시작이 없으면(시점 사실) 또는 어느 폭에도 들지 않으면 null. */
    static Span span(LocalDate start, LocalDate end) {
        if (start == null || end == null) {
            return null;
        }
        long days = ChronoUnit.DAYS.between(start, end);
        for (Span s : Span.values()) {
            if (days >= s.minDays && days <= s.maxDays) {
                return s;
            }
        }
        return null;
    }

    /** 기준일까지 알 수 있었던 사실 하나(같은 키 중 가장 늦게 낸 값). {@code concept}는 {@code 분류체계:개념}. */
    record Known(String concept, String unit, LocalDate start, LocalDate end, double value,
                 LocalDate filed, String form, String accn, Span span) {

        String taxonomy() {
            int colon = concept.indexOf(':');
            return colon < 0 ? concept : concept.substring(0, colon);
        }
    }

    private record Key(String concept, String unit, LocalDate start, LocalDate end) {
    }

    /**
     * 같은 키에서 '더 늦은' 사실 — 공시일, 같은 날이면 정정(/A), 그다음 접수 번호, 마지막으로 값(입력 순서와 무관하게 결정적).
     */
    private static final Comparator<Known> LATER = Comparator.comparing(Known::filed)
            .thenComparing((Known k) -> isAmendment(k.form()))
            .thenComparing(Known::accn, Comparator.nullsFirst(Comparator.naturalOrder()))
            .thenComparingDouble(Known::value);

    private static final Comparator<Known> BY_PERIOD = Comparator.comparing(Known::concept)
            .thenComparing(Known::unit)
            .thenComparing(Known::start, Comparator.nullsFirst(Comparator.naturalOrder()))
            .thenComparing(Known::end);

    /** 연간 사실이 여럿이면(같은 end의 52주·53주, 10-Q의 364일 TTM) 1년에 가장 가까운 것, 그다음 이른 시작. */
    private static final Comparator<Known> YEAR_LIKE = Comparator
            .comparingLong((Known k) -> Math.abs(ChronoUnit.DAYS.between(k.start(), k.end()) - 364))
            .thenComparing(Known::start);

    private record Series(String concept, List<Known> facts, LocalDate latestEnd) {
    }

    /** 분기 하나 — 3개월 사실이면 {@code derived = false}, 누계 차감이면 true. */
    record Quarter(LocalDate start, LocalDate end, double value, boolean derived) {
    }

    /**
     * TTM과, 연간 기준과 분기 합이 둘 다 되는데 서로 달랐는지. {@code mixedBasis}면 값이 없습니다(전년 누계만 연간 공시 뒤 재작성 —
     * {@link #revisedAfter}).
     */
    record Ttm(Double value, boolean mismatch, boolean mixedBasis) {
        static final Ttm MIXED = new Ttm(null, false, true);
    }

    /** 연간 기준 TTM — 값, 또는 기준이 섞여 내지 않음. 연간·누계가 모자라면 이 객체 대신 null입니다. */
    private record Annual(Double value, boolean mixedBasis) {
        static final Annual MIXED = new Annual(null, true);
    }

    /**
     * 계산 메모 세 묶음 — 패킷은 한 줄을 80자에서 자르므로 뜻이 큰 것부터 둡니다. ① 낸 값의 뜻이 바뀐 것(평균에 최신 값만 씀,
     * TTM 두 방법 불일치, 분류체계 섞임 등 — 값만 보면 알 수 없음) ② 자료는 있는데 일부러 비운 값(자본잠식, 순이익 ≤ 0, 분할 추정,
     * 기준이 섞인 누계 — 패킷의 '빈 값 = 자료 없음'과 다른 뜻) ③ 자료가 없어 빈 값(빈 값의 기본 뜻이라 잘려도 손해가 작고, 개념
     * 이름이 들어가 깁니다). 같은 묶음 안은 넣은 순서(결정적)입니다.
     */
    private static final class Notes {
        private final List<String> caveats = new ArrayList<>();
        private final List<String> withheld = new ArrayList<>();
        private final List<String> gaps = new ArrayList<>();

        void caveat(String note) {
            caveats.add(note);
        }

        void withheld(String note) {
            withheld.add(note);
        }

        void gap(String note) {
            gaps.add(note);
        }

        List<String> all() {
            List<String> out = new ArrayList<>(caveats);
            out.addAll(withheld);
            out.addAll(gaps);
            return out;
        }
    }

    /**
     * 한 종목의 지표를 계산합니다.
     *
     * @param rows 그 종목의 공시일별 사실 묶음(순서 무관). 기준일 뒤에 낸 행은 무시합니다
     * @param asOf 기준일(결정의 기준 거래일) — {@code filed ≤ asOf}인 사실만 씁니다
     */
    public static Result compute(List<Row> rows, LocalDate asOf) {
        if (asOf == null) {
            throw new IllegalArgumentException("기준일이 없습니다");
        }
        Notes notes = new Notes();
        List<Known> known = pointInTime(rows, asOf);
        if (known.isEmpty()) {
            notes.gap("기준일 " + asOf + "까지 낸 재무 사실이 없음");
            return new Result(null, null, null, null, null, null, null, null, null, null, null, null, null,
                    "재무 사실 없음", null, null, null, null, null, null, null, null, null, null,
                    Map.of(), false, false, notes.all());
        }

        String currency = currency(known);
        Map<String, List<Known>> byConcept = new HashMap<>();
        for (Known k : known) {
            byConcept.computeIfAbsent(k.concept(), x -> new ArrayList<>()).add(k);
        }
        Map<String, Series> chosen = new LinkedHashMap<>();
        for (FieldSpec spec : FIELDS) {
            Series series = choose(spec, byConcept, currency);
            if (series != null) {
                chosen.put(spec.key(), series);
            }
        }

        // 주식수는 표지 기준일(기간 말보다 늦음)이라 기준 기간을 정하는 데 넣지 않습니다.
        LocalDate anchor = null;
        for (Map.Entry<String, Series> e : chosen.entrySet()) {
            if (!SHARES.equals(e.getKey()) && (anchor == null || e.getValue().latestEnd().isAfter(anchor))) {
                anchor = e.getValue().latestEnd();
            }
        }
        Known header = header(chosen, anchor);

        boolean usd = "USD".equals(currency);
        if (currency != null && !usd) {
            notes.caveat("보고 통화 " + currency + " — 금액은 비우고 비율·성장률만 냄(환율·ADS 비율 없이 금액을 비교하지 않게)");
        }
        Set<String> used = new LinkedHashSet<>();

        Double revenue = flow(REVENUE, chosen, anchor, notes, used);
        // 이번 TTM이 없으면 증가율도 없으므로 1년 전 TTM의 메모를 남기지 않습니다(한 줄 80자 메모를 쓸모없는 말로 채우지 않게).
        Double revenuePrior = revenue == null ? null : priorFlow(REVENUE, chosen, anchor, notes);
        Double netIncome = flow(NET_INCOME, chosen, anchor, notes, used);
        Double ocf = flow(OCF, chosen, anchor, notes, used);
        Double capex = flow(CAPEX, chosen, anchor, notes, used);
        Double buybacks = flow(BUYBACKS, chosen, anchor, notes, used);
        Double dividends = flow(DIVIDENDS, chosen, anchor, notes, used);

        Double assets = stock(ASSETS, chosen, anchor, notes, used);
        Double equity = stock(EQUITY, chosen, anchor, notes, used);
        Double receivables = stock(RECEIVABLES, chosen, anchor, notes, used);
        Double inventory = stock(INVENTORY, chosen, anchor, notes, used);
        Double longTermDebt = stock(LONG_TERM_DEBT, chosen, anchor, notes, used);
        Double avgAssets = average(ASSETS, assets, chosen, anchor, notes);
        Double avgEquity = average(EQUITY, equity, chosen, anchor, notes);

        Double fcf = ocf != null && capex != null ? ocf - capex : null;
        Double fcfConversion = null;
        String fcfReason;
        if (fcf == null) {
            fcfReason = ocf == null ? "영업현금흐름 자료 없음 — FCF 없음" : "설비투자 자료 없음 — FCF 없음";
        } else if (netIncome == null) {
            fcfReason = "순이익 자료 없음";
        } else if (netIncome <= 0) {
            fcfReason = "순이익 ≤ 0 — 전환율 의미 없음";
            // 자료는 있는데 비율이 뜻이 없어 비운 값 — 패킷의 '빈 값 = 자료 없음 [확인 필요]'와 다른 뜻이라 메모로도 냅니다
            // (fcfConversionReason은 패킷 열이 아님).
            notes.withheld("fcfConversion: " + fcfReason);
        } else {
            fcfConversion = fcf / netIncome * 100.0;
            fcfReason = null;
        }

        // 자본잠식이면 배수·ROE의 부호가 뒤집혀 '좋아 보이는' 숫자가 되므로 내지 않습니다(KrFundamentals와 같은 이유).
        if (avgEquity != null && avgEquity <= 0) {
            notes.withheld("평균 자본 ≤ 0 — leverage·roe 계산 안 함");
        }
        if (equity != null && equity <= 0) {
            notes.withheld("최신 자본 ≤ 0 — debtToEquity 계산 안 함");
        }
        Double netMargin = netIncome != null && revenue != null && revenue > 0 ? netIncome / revenue * 100.0 : null;
        Double assetTurnover = revenue != null && revenue >= 0 && avgAssets != null && avgAssets > 0
                ? revenue / avgAssets : null;
        Double leverage = avgAssets != null && avgEquity != null && avgEquity > 0 ? avgAssets / avgEquity : null;
        Double roe = netIncome != null && avgEquity != null && avgEquity > 0 ? netIncome / avgEquity * 100.0 : null;
        Double debtToEquity = longTermDebt != null && equity != null && equity > 0
                ? longTermDebt / equity * 100.0 : null;

        Double revenueYoY = growth(REVENUE + " TTM", revenue, revenuePrior, notes);
        Double receivablesYoY = growth(RECEIVABLES, receivables, yearAgoStock(RECEIVABLES, chosen, anchor), notes);
        Double inventoryYoY = growth(INVENTORY, inventory, yearAgoStock(INVENTORY, chosen, anchor), notes);

        Series sharesSeries = chosen.get(SHARES);
        Double sharesYoY = null;
        boolean proxy = false;
        if (sharesSeries != null) {
            NavigableMap<LocalDate, Known> points = sharePoints(sharesSeries.facts());
            Map.Entry<LocalDate, Known> latest = points.lastEntry();
            used.add(SHARES);
            proxy = PROXY_SHARES.contains(sharesSeries.concept());
            if (anchor != null && latest.getKey().isBefore(anchor.minusDays(YEAR_TOLERANCE_DAYS))) {
                notes.caveat(SHARES + ": 최신 값이 " + latest.getKey() + " 기준(최신 기간 " + anchor + "보다 이전)");
            }
            LocalDate before = closest(points.keySet(), latest.getKey().minusYears(1));
            sharesYoY = shareGrowth(latest.getValue().value(), before == null ? null : points.get(before).value(), notes);
        }

        Map<String, String> conceptsUsed = new LinkedHashMap<>();
        Set<String> taxonomies = new LinkedHashSet<>();
        for (FieldSpec spec : FIELDS) {
            if (used.contains(spec.key())) {
                Series series = chosen.get(spec.key());
                conceptsUsed.put(spec.key(), series.concept());
                String taxonomy = series.facts().get(0).taxonomy();
                if (!DEI.equals(taxonomy)) {
                    taxonomies.add(taxonomy);
                }
            }
        }
        String taxonomy = taxonomy(taxonomies);
        if (taxonomies.size() > 1) {
            notes.caveat("분류체계가 섞임(" + taxonomy + ") — 필드마다 conceptsUsed 확인");
        }

        boolean stale = anchor != null && anchor.plusMonths(STALE_MONTHS).isBefore(asOf);
        return new Result(anchor, header == null ? null : header.filed(), header == null ? null : header.form(),
                currency, taxonomy,
                amount(revenue, usd), revenueYoY, amount(netIncome, usd), netMargin,
                amount(ocf, usd), amount(capex, usd), amount(fcf, usd), fcfConversion, fcfReason,
                assetTurnover, leverage, roe, receivablesYoY, inventoryYoY, sharesYoY,
                amount(buybacks, usd), amount(dividends, usd), amount(longTermDebt, usd), debtToEquity,
                conceptsUsed, stale, proxy, notes.all());
    }

    /**
     * 시점 규칙 — {@code filed ≤ asOf}인 행만, 같은 (분류체계, 개념, 단위, 시작, 끝)은 그 안에서 가장 늦게 낸 값. 후보 개념만
     * 남기고 기간 순으로 정렬해 돌려줍니다(입력 순서와 무관).
     */
    static List<Known> pointInTime(List<Row> rows, LocalDate asOf) {
        Map<Key, Known> latest = new HashMap<>();
        if (rows != null) {
            for (Row row : rows) {
                if (row == null || row.filed() == null || row.filed().isAfter(asOf)) {
                    continue;
                }
                for (Fact f : row.facts()) {
                    if (f == null || f.t() == null || f.c() == null || f.u() == null || f.e() == null
                            || f.v() == null || !Double.isFinite(f.v())) {
                        continue;
                    }
                    String concept = f.t() + ":" + f.c();
                    if (!ALL_CONCEPTS.contains(concept) || (f.s() != null && f.s().isAfter(f.e()))) {
                        continue;
                    }
                    Known k = new Known(concept, f.u(), f.s(), f.e(), f.v(), row.filed(), f.f(), f.a(),
                            span(f.s(), f.e()));
                    latest.merge(new Key(concept, f.u(), f.s(), f.e()), k,
                            (a, b) -> LATER.compare(a, b) >= 0 ? a : b);
                }
            }
        }
        List<Known> out = new ArrayList<>(latest.values());
        out.sort(BY_PERIOD);
        return out;
    }

    /**
     * 보고 통화 — 가장 늦은 end에 금액 사실이 있는 통화 가운데 사실이 가장 많은 것(같으면 이름순). 중국 ADR은 최근 연도만 USD
     * 환산값을 함께 싣는데, 그 USD를 고르면 최근 연도 말고는 비교할 값이 없습니다.
     */
    static String currency(List<Known> known) {
        Map<String, Integer> counts = new TreeMap<>();
        Map<String, LocalDate> latestEnd = new HashMap<>();
        LocalDate maxEnd = null;
        for (Known k : known) {
            if (!MONETARY_CONCEPTS.contains(k.concept()) || !CURRENCY.matcher(k.unit()).matches()) {
                continue;
            }
            counts.merge(k.unit(), 1, Integer::sum);
            latestEnd.merge(k.unit(), k.end(), (a, b) -> a.isAfter(b) ? a : b);
            if (maxEnd == null || k.end().isAfter(maxEnd)) {
                maxEnd = k.end();
            }
        }
        String best = null;
        for (Map.Entry<String, Integer> e : counts.entrySet()) {
            if (!latestEnd.get(e.getKey()).equals(maxEnd)) {
                continue;
            }
            if (best == null || e.getValue() > counts.get(best)) {
                best = e.getKey();
            }
        }
        return best;
    }

    /** 후보 가운데 가장 최근 end를 가진 개념(같으면 후보 순서). 금액 필드는 보고 통화 단위의 사실만 봅니다. */
    private static Series choose(FieldSpec spec, Map<String, List<Known>> byConcept, String currency) {
        Series best = null;
        for (String concept : spec.candidates()) {
            List<Known> usable = new ArrayList<>();
            LocalDate end = null;
            for (Known k : byConcept.getOrDefault(concept, List.of())) {
                if (!usable(spec.kind(), k, currency)) {
                    continue;
                }
                usable.add(k);
                if (end == null || k.end().isAfter(end)) {
                    end = k.end();
                }
            }
            if (end != null && (best == null || end.isAfter(best.latestEnd()))) {
                best = new Series(concept, List.copyOf(usable), end);
            }
        }
        return best;
    }

    private static boolean usable(Kind kind, Known k, String currency) {
        return switch (kind) {
            case FLOW -> k.unit().equals(currency) && k.span() != null;
            case STOCK -> k.unit().equals(currency) && k.start() == null;
            case SHARES -> SHARES_UNIT.equals(k.unit()) && (k.start() == null || k.span() != null);
        };
    }

    /** 기준 기간 사실을 담은 공시 가운데 가장 늦은 것(정정이 있으면 정정). */
    private static Known header(Map<String, Series> chosen, LocalDate anchor) {
        Known best = null;
        if (anchor == null) {
            return null;
        }
        for (Map.Entry<String, Series> e : chosen.entrySet()) {
            if (SHARES.equals(e.getKey())) {
                continue;
            }
            for (Known k : e.getValue().facts()) {
                if (k.end().equals(anchor) && (best == null || LATER.compare(k, best) > 0)) {
                    best = k;
                }
            }
        }
        return best;
    }

    /** 흐름 필드의 기준 기간 TTM. 만들 수 없으면 null + 이유. */
    private static Double flow(String key, Map<String, Series> chosen, LocalDate anchor, Notes notes,
                               Set<String> used) {
        Series series = chosen.get(key);
        if (series == null || anchor == null) {
            return null;
        }
        if (series.latestEnd().isBefore(anchor)) {
            notes.gap(key + ": 최신 기간 " + anchor + " 값 없음(" + series.concept() + " 최신 end " + series.latestEnd() + ")");
            return null;
        }
        Ttm ttm = ttm(series.facts(), anchor);
        if (ttm == null) {
            notes.gap(key + ": 최신 기간 " + anchor + " TTM을 만들 수 없음(연간·누계·분기 사실 부족)");
            return null;
        }
        if (ttm.mixedBasis()) {
            notes.withheld(key + ": 전년 누계가 연간 공시 뒤 재작성됨 — 기준이 섞여 TTM을 내지 않음");
            return null;
        }
        if (ttm.mismatch()) {
            notes.caveat(key + " TTM: 연간 기준과 최근 4개 분기 합이 달라 연간 기준을 씀");
        }
        used.add(key);
        return ttm.value();
    }

    /** 1년 전 TTM(기준 기간 end에서 1년 전과 가장 가까운 end, ±31일). 같은 개념으로만. */
    private static Double priorFlow(String key, Map<String, Series> chosen, LocalDate anchor, Notes notes) {
        Series series = chosen.get(key);
        if (series == null || anchor == null || series.latestEnd().isBefore(anchor)) {
            return null;
        }
        Set<LocalDate> ends = new LinkedHashSet<>();
        for (Known k : series.facts()) {
            ends.add(k.end());
        }
        LocalDate before = closest(ends, anchor.minusYears(1));
        Ttm ttm = before == null ? null : ttm(series.facts(), before);
        if (ttm != null && ttm.mixedBasis()) {
            notes.withheld(key + " 1년 전 TTM: 전년 누계가 연간 공시 뒤 재작성됨 — 기준이 섞여 증가율을 내지 않음");
            return null;
        }
        if (ttm != null && ttm.mismatch()) {
            notes.caveat(key + " 1년 전 TTM: 연간 기준과 최근 4개 분기 합이 달라 연간 기준을 씀");
        }
        return ttm == null ? null : ttm.value();
    }

    /** 시점 필드의 기준 기간 값. 그 기간 값이 없으면 null + 이유. */
    private static Double stock(String key, Map<String, Series> chosen, LocalDate anchor, Notes notes,
                                Set<String> used) {
        Series series = chosen.get(key);
        if (series == null || anchor == null) {
            return null;
        }
        Double value = instantAt(series.facts(), anchor);
        if (value == null) {
            notes.gap(key + ": 최신 기간 " + anchor + " 값 없음(" + series.concept() + " 최신 end " + series.latestEnd() + ")");
            return null;
        }
        used.add(key);
        return value;
    }

    /** 시점 필드의 1년 전 값(±31일 안에서 가장 가까운 날). */
    private static Double yearAgoStock(String key, Map<String, Series> chosen, LocalDate anchor) {
        Series series = chosen.get(key);
        if (series == null || anchor == null) {
            return null;
        }
        Set<LocalDate> ends = new LinkedHashSet<>();
        for (Known k : series.facts()) {
            ends.add(k.end());
        }
        LocalDate before = closest(ends, anchor.minusYears(1));
        return before == null ? null : instantAt(series.facts(), before);
    }

    /** 평균 = (최신 + 1년 전)/2. 1년 전이 없으면 최신 값만 쓰고 표시합니다. */
    private static Double average(String key, Double latest, Map<String, Series> chosen, LocalDate anchor,
                                  Notes notes) {
        if (latest == null) {
            return null;
        }
        Double before = yearAgoStock(key, chosen, anchor);
        if (before == null) {
            notes.caveat(key + " 평균: 1년 전 시점 값이 없어 최신 값만 씀");
            return latest;
        }
        return (latest + before) / 2.0;
    }

    private static Double instantAt(List<Known> facts, LocalDate end) {
        for (Known k : facts) {
            if (k.start() == null && k.end().equals(end)) {
                return k.value();
            }
        }
        return null;
    }

    /**
     * 주식수의 날짜별 값. 가중평균(기간 사실)은 더할 수 있는 값이 아니라 누계 차감을 하지 않고, 같은 end면 가장 짧은 기간(최근
     * 분기)의 값을 씁니다.
     */
    private static NavigableMap<LocalDate, Known> sharePoints(List<Known> facts) {
        List<Known> sorted = new ArrayList<>(facts);
        sorted.sort(Comparator.comparing(Known::end)
                .thenComparing((Known k) -> k.span() == null ? -1 : k.span().ordinal())
                .thenComparing(Known::start, Comparator.nullsFirst(Comparator.naturalOrder())));
        NavigableMap<LocalDate, Known> out = new TreeMap<>();
        for (Known k : sorted) {
            out.putIfAbsent(k.end(), k);
        }
        return out;
    }

    /**
     * TTM — ① 연간 기준(연간 사실이 그 end에 있으면 그것, 아니면 직전 연간 + 당해 누계 − 전년 같은 누계), ② 최근 4개 분기 합.
     * 둘 다 되면 ①을 쓰고, 다르면 {@code mismatch}. 둘 다 안 되면 null. ①이 기준이 섞인 누계를 만나면 ②로 대신하지 않고
     * {@link Ttm#MIXED}입니다 — 그때 분기 합도 같은 섞인 사실(당해 1·2분기는 옛 기준, 3분기는 새 기준 등)로 이뤄져 있습니다.
     */
    static Ttm ttm(List<Known> facts, LocalDate end) {
        Annual annual = viaAnnual(facts, end);
        if (annual != null && annual.mixedBasis()) {
            return Ttm.MIXED;
        }
        Double quarters = viaQuarters(facts, end);
        if (annual == null && quarters == null) {
            return null;
        }
        if (annual == null) {
            return new Ttm(quarters, false, false);
        }
        return new Ttm(annual.value(), quarters != null && differs(annual.value(), quarters), false);
    }

    private static Annual viaAnnual(List<Known> facts, LocalDate end) {
        Known year = pick(facts, k -> k.span() == Span.YEAR && k.end().equals(end), YEAR_LIKE);
        if (year != null) {
            return new Annual(year.value(), false);
        }
        for (Span ytdSpan : List.of(Span.NINE_MONTHS, Span.HALF, Span.QUARTER)) {
            List<Known> ytds = new ArrayList<>();
            for (Known k : facts) {
                if (k.span() == ytdSpan && k.end().equals(end)) {
                    ytds.add(k);
                }
            }
            ytds.sort(Comparator.comparing(Known::start));
            for (Known ytd : ytds) {
                // 누계의 시작 전날이 직전 연간의 끝 — 52/53주 회계연도도 공시의 날짜끼리는 정확히 이어집니다.
                LocalDate fiscalEnd = ytd.start().minusDays(1);
                Known fiscal = pick(facts, k -> k.span() == Span.YEAR && k.end().equals(fiscalEnd), YEAR_LIKE);
                if (fiscal == null) {
                    continue;
                }
                Known prior = pick(facts, k -> k.span() == ytdSpan && k.start().equals(fiscal.start()),
                        Comparator.comparing(Known::end));
                if (prior == null) {
                    continue;
                }
                if (revisedAfter(prior, fiscal, facts)) {
                    return Annual.MIXED;
                }
                return new Annual(fiscal.value() + ytd.value() - prior.value(), false);
            }
        }
        return null;
    }

    /**
     * {@code later}(전년 같은 누계, 또는 누계 차감의 짧은 쪽)가 {@code base}(직전 연간, 또는 긴 누계)를 마지막으로 낸 날 <b>뒤에</b>
     * 바뀌어, 둘의 기준이 다를 수 있는가.
     *
     * <p>수집기는 같은 키의 같은 값 재게재를 버리므로, 짧은 쪽(더 일찍 끝나 먼저 공시되는 기간)의 공시일이 긴 쪽보다 늦다는 것은 긴 쪽을
     * 낸 뒤 짧은 쪽 값이 바뀌었다는 뜻입니다. 중단영업 재분류가 대표적입니다 — 10-Q가 전년 비교 열(9개월 누계·분기)을 먼저 고치고,
     * 연간은 다음 10-K(또는 수집하지 않는 8-K)에서야 고칩니다. 그 사이 '연간(옛) + 당해 누계(새) − 전년 누계(새)'는 두 기준을 섞은
     * 값이고, 분기 합도 '연간(옛) − 9개월(새)'로 만든 4분기를 써서 같은 값이 되므로 두 방법의 대조로는 잡히지 않습니다(매출 TTM 24%
     * 과대 사례).
     *
     * <p>다만 {@code base}가 연간이고 그 연간 공시가 그 전 연간도 <b>같은 날</b> 고쳤다면(연말에 재분류해 10-K가 전년을 다시 냄) 연간은
     * 이미 새 기준이고, 뒤에 고친 전년 누계는 그 기준을 따라온 것이라 섞이지 않습니다 — 이 경우까지 비우면 연말 재분류 뒤 1년 내내
     * TTM이 빕니다.
     */
    private static boolean revisedAfter(Known later, Known base, List<Known> facts) {
        if (!later.filed().isAfter(base.filed())) {
            return false;
        }
        if (base.span() != Span.YEAR) {
            return true;
        }
        LocalDate previousEnd = base.start().minusDays(1);
        Known previousYear = pick(facts, k -> k.span() == Span.YEAR && k.end().equals(previousEnd), YEAR_LIKE);
        return previousYear == null || !previousYear.filed().equals(base.filed());
    }

    private static Double viaQuarters(List<Known> facts, LocalDate end) {
        NavigableMap<LocalDate, Quarter> quarters = quarters(facts);
        double sum = 0;
        LocalDate cursor = end;
        for (int i = 0; i < 4; i++) {
            Quarter q = quarters.get(cursor);
            if (q == null) {
                return null;
            }
            sum += q.value();
            cursor = q.start().minusDays(1);
        }
        return sum;
    }

    /**
     * 분기 값(end → 분기). 3개월 사실이 있으면 그것, 없으면 같은 시작의 누계끼리 뺀 값(Q2 = 6M − Q1, Q3 = 9M − 6M,
     * Q4 = FY − 9M). 뺀 결과가 3개월 폭이 아니거나, 짧은 누계가 긴 누계를 낸 뒤 재작성돼 기준이 섞였으면({@link #revisedAfter})
     * 버립니다. 한 개념의 사실만 넣으세요.
     */
    static NavigableMap<LocalDate, Quarter> quarters(List<Known> facts) {
        NavigableMap<LocalDate, Quarter> out = new TreeMap<>();
        List<Known> sorted = new ArrayList<>();
        for (Known k : facts) {
            if (k.span() != null) {
                sorted.add(k);
            }
        }
        sorted.sort(Comparator.comparing(Known::start).thenComparing(Known::end));
        for (Known k : sorted) {
            if (k.span() == Span.QUARTER) {
                out.putIfAbsent(k.end(), new Quarter(k.start(), k.end(), k.value(), false));
            }
        }
        for (Known shorter : sorted) {
            Span longerSpan = shorter.span().next();
            if (longerSpan == null) {
                continue;
            }
            Known longer = pick(sorted, k -> k.span() == longerSpan && k.start().equals(shorter.start()),
                    Comparator.comparing(Known::end));
            if (longer == null || out.containsKey(longer.end()) || revisedAfter(shorter, longer, sorted)) {
                continue;
            }
            LocalDate start = shorter.end().plusDays(1);
            if (span(start, longer.end()) == Span.QUARTER) {
                out.put(longer.end(), new Quarter(start, longer.end(), longer.value() - shorter.value(), true));
            }
        }
        return out;
    }

    private static Known pick(List<Known> facts, Predicate<Known> test, Comparator<Known> order) {
        Known best = null;
        for (Known k : facts) {
            if (test.test(k) && (best == null || order.compare(k, best) < 0)) {
                best = k;
            }
        }
        return best;
    }

    private static boolean differs(double a, double b) {
        return Math.abs(a - b) > TTM_MISMATCH * Math.max(1.0, Math.max(Math.abs(a), Math.abs(b)));
    }

    /** {@code target}에 가장 가까운 날(±{@link #YEAR_TOLERANCE_DAYS}일, 같으면 이른 날). 없으면 null. */
    private static LocalDate closest(Iterable<LocalDate> dates, LocalDate target) {
        LocalDate best = null;
        long bestGap = Long.MAX_VALUE;
        for (LocalDate d : dates) {
            long gap = Math.abs(ChronoUnit.DAYS.between(d, target));
            if (gap > YEAR_TOLERANCE_DAYS) {
                continue;
            }
            if (gap < bestGap || (gap == bestGap && d.isBefore(best))) {
                best = d;
                bestGap = gap;
            }
        }
        return best;
    }

    /**
     * 1년 전 대비(%). 전기가 0 이하이거나 당기가 음수면 비율이 방향을 거꾸로 말하므로 null + 표시(1년 전 값이 아예 없으면 표시
     * 없이 null).
     */
    private static Double growth(String label, Double now, Double before, Notes notes) {
        if (now == null || before == null) {
            return null;
        }
        if (before <= 0 || now < 0) {
            notes.withheld(label + " 1년 변화: 0·음수 구간이라 비율을 내지 않음");
            return null;
        }
        return (now / before - 1.0) * 100.0;
    }

    /** 주식수 1년 변화(%) — 분할·병합 모양({@link #SPLIT_RATIO})이면 null + 표시, 나머지는 {@link #growth}와 같음. */
    private static Double shareGrowth(Double now, Double before, Notes notes) {
        if (now != null && before != null && now > 0 && before > 0) {
            double ratio = now / before;
            if (ratio >= SPLIT_RATIO || ratio <= 1.0 / SPLIT_RATIO) {
                notes.withheld(SHARES + " 1년 변화 " + String.format(Locale.ROOT, "%.2f", ratio)
                        + "배: 분할·병합(또는 대규모 발행·소각) 추정이라 비율을 내지 않음");
                return null;
            }
        }
        return growth(SHARES, now, before, notes);
    }

    private static String taxonomy(Set<String> taxonomies) {
        if (taxonomies.isEmpty()) {
            return null;
        }
        List<String> ordered = new ArrayList<>();
        for (String t : TAXONOMY_ORDER) {
            if (taxonomies.contains(t)) {
                ordered.add(t);
            }
        }
        List<String> rest = new ArrayList<>(taxonomies);
        rest.removeAll(TAXONOMY_ORDER);
        Collections.sort(rest);
        ordered.addAll(rest);
        return String.join(",", ordered);
    }

    private static Double amount(Double value, boolean usd) {
        return usd ? value : null;
    }

    private static boolean isAmendment(String form) {
        return form != null && form.endsWith("/A");
    }
}
