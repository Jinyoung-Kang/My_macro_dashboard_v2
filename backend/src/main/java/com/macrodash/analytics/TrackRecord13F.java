package com.macrodash.analytics;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;

/**
 * 13F 공시일 기준 복제 트랙레코드 — 구간 수익률·커버리지·창 통계·자격·순위(명세 R7·R9·R10, 설계 §4-0 ④⑤).
 *
 * <p><b>왜 보고일이 아니라 공시일인가</b>: 13F는 분기 말 보유를 최대 45일 뒤에 공개합니다. 분기 말(보고일)부터 들었다고 치면
 * 그때는 아무도 몰랐던 보유로 수익을 내는 셈이라(룩어헤드) 성과가 실제보다 좋아 보입니다. 그래서 공시를 본 <b>다음 거래일</b>
 * 종가에 사서 다음 공시를 본 다음 거래일 종가까지 들었다고 봅니다 — 모의 매매가 실제로 따라 할 수 있는 수익률입니다.
 *
 * <p><b>이것은 그 기관의 수익률이 아닙니다.</b> 13F는 미국 상장 주식의 롱 포지션만 보이고(공매도·채권·옵션·해외 없음), 분기
 * 중간 매매도 보이지 않습니다. 또 티커를 붙이지 못한 보유는 빼고 남은 평가액으로 다시 나눕니다(재정규화) — 그래서 구간마다
 * 커버리지(티커·가격이 있는 평가액 / 총평가액)를 함께 내고, 커버리지가 낮은 기관은 자격에서 뺍니다(R9). 화면 한계 문구가 이를
 * 적습니다.
 *
 * <p>가격은 수정주가(배당·분할 반영) 종가입니다. 같은 날짜에 대해 {@link DailySeries#floorValue}를 쓰므로 그날 봉이 빠져도
 * 직전 종가로 계산하지만, <b>시작 가격은 7일보다 오래된 값을 쓰지 않습니다</b> — 상장 전이거나 이미 사라진 종목을 오래된 가격으로
 * 산 것처럼 만들지 않기 위해서입니다. 끝 가격은 시작일 뒤의 마지막 종가면 됩니다 — 구간 중에 상장폐지·인수된 종목은 마지막
 * 거래 가격으로 판 것으로 봅니다(그 구간에서 빼면 망한 종목이 커버리지에서만 사라져 수익률이 좋아 보이는 생존 편향).
 *
 * <p>표본이 없으면 수치는 null입니다(0으로 채우지 않음). {@code …Pct}는 ×100 값, 커버리지는 0~1 비율입니다.
 */
public final class TrackRecord13F {

    private TrackRecord13F() {
    }

    /** 시작 가격으로 인정하는 가장 오래된 종가 — 시작일에서 이 일수(달력일)보다 앞이면 '가격 없음'. */
    static final int MAX_START_PRICE_AGE_DAYS = 7;
    /** 연율화는 달력일 기준입니다 — 구간이 공시일로 정해져 거래일 수가 아니라 달력 기간이 뜻을 갖습니다. */
    private static final double DAYS_PER_YEAR = 365.0;
    /** 이보다 작은 표준편차는 0으로 봅니다(PaperStats와 같은 이유 — 끝자리 잡음으로 나눈 샤프가 10^15가 되지 않게). */
    private static final double FLAT = 1e-12;
    /** 비율을 % 정수로 내릴 때 0.29×100 = 28.999…가 28이 되지 않게 더하는 여유. */
    private static final double PERCENT_EPSILON = 1e-9;

    /**
     * 13F 보유 한 줄.
     *
     * @param ticker 야후 티커. null(또는 빈 문자열)이면 티커를 붙이지 못한 보유 — 총평가액에는 들어가고 커버리지에서 빠집니다
     * @param value  평가액(달러). 숫자가 아니거나 음수인 줄은 계산에서 빼므로(총평가액에도 넣지 않음) 서비스가 걸러 넣으세요
     */
    public record Holding13F(String ticker, double value) {
    }

    /**
     * 공시 한 건.
     *
     * @param filingDate 공시일(EDGAR 접수일) — 이 날짜로 구간을 나눕니다. 필수
     * @param reportDate 보고 분기 말. 같은 날 두 건을 냈을 때 순서를 정하고 화면에 보일 뿐 계산에는 쓰지 않습니다
     * @param holdings   null이면 빈 목록
     */
    public record Filing(LocalDate filingDate, LocalDate reportDate, List<Holding13F> holdings) {
        public Filing {
            if (filingDate == null) {
                throw new IllegalArgumentException("공시일이 없습니다(보고일 " + reportDate + ")");
            }
            holdings = holdings == null ? List.of() : List.copyOf(holdings);
        }
    }

    /**
     * 구간을 나누는 공시 순서 — 공시일, 같은 날이면 보고일(모르면 앞). {@link #compute}가 이 순서로 구간을 만들고, 가격을 미리
     * 읽을 티커를 고르는 쪽(PaperSelectionService)도 같은 순서를 써야 합니다. 같은 날 낸 두 공시의 순서가 다르면 뒤 분기의
     * 보유로 만든 구간의 티커를 읽지 않아 커버리지·수익률이 틀립니다.
     */
    public static final Comparator<Filing> FILING_ORDER = Comparator.comparing(Filing::filingDate)
            .thenComparing(Filing::reportDate, Comparator.nullsFirst(Comparator.naturalOrder()));

    /**
     * 창 길이와 자격 기준(명세 R9·D22, 설정 {@code trackRecord.*}).
     *
     * @param windowYears 롤링 창(년), 1 이상
     * @param minPeriods  수익률이 있는 구간 수 하한
     * @param minCoverage 창 안 모든 구간의 커버리지 하한(0~1)
     * @param avgCoverage 창 안 구간 커버리지 평균의 하한(0~1)
     */
    public record Criteria(int windowYears, int minPeriods, double minCoverage, double avgCoverage) {
        public Criteria {
            if (windowYears < 1) {
                throw new IllegalArgumentException("창은 1년 이상이어야 합니다: " + windowYears);
            }
            if (minPeriods < 0) {
                throw new IllegalArgumentException("최소 구간 수는 0 이상이어야 합니다: " + minPeriods);
            }
            requireFraction(minCoverage, "최소 커버리지");
            requireFraction(avgCoverage, "평균 커버리지");
        }

        /** 7년 창, 구간 24개(분기 기준 7년의 85%), 최소 커버리지 50%, 평균 70%(D22). */
        public static Criteria defaults() {
            return new Criteria(7, 24, 0.5, 0.7);
        }

        private static void requireFraction(double v, String what) {
            if (!(v >= 0.0 && v <= 1.0)) {
                throw new IllegalArgumentException(what + "는 0~1 사이 비율이어야 합니다: " + v);
            }
        }
    }

    /**
     * 공시 한 건을 들고 있던 구간.
     *
     * @param start          산 날(공시 다음 거래일). 창의 첫 구간은 창 시작일로 잘린 날짜(거래일이 아닐 수 있음)
     * @param end            판 날(다음 공시의 다음 거래일, 마지막 구간은 기준일 이하 마지막 거래일)
     * @param returnPct      커버된 보유의 평가액 가중 수익률(%). 커버된 평가액이 0이면 null(이 구간은 누적에 들어가지 않음)
     * @param spyReturnPct   같은 날짜의 SPY 수익률(%). SPY 가격이 없으면 null
     * @param coverage       시작·끝 가격이 모두 있는 보유의 평가액 / 총평가액(티커 없는 보유 포함). 총평가액이 0이면 0
     * @param coveredTickers 가격이 있는 서로 다른 티커 수(같은 티커 여러 줄은 하나)
     * @param holdings       공시의 보유 줄 수
     */
    public record Period(LocalDate filingDate, LocalDate reportDate, LocalDate start, LocalDate end,
                         Double returnPct, Double spyReturnPct, double coverage, int coveredTickers, int holdings) {
    }

    /**
     * 한 기관의 창 통계.
     *
     * @param periodsUsed      수익률이 있는(누적에 들어간) 구간 수
     * @param periodsTotal     창 안 구간 수(수익률이 없는 구간 포함)
     * @param firstFilingDate  창 안 첫 구간의 공시일. 구간이 없으면 null
     * @param lastFilingDate   기준일까지 낸 마지막 공시일(기준일 당일 공시처럼 아직 구간이 없는 공시도 포함). 공시가 없으면 null
     * @param cumReturnPct     Π(1+R) − 1 (%)
     * @param cagrPct          (1+누적)^(365/일수) − 1 (%), 일수 = 마지막 구간 끝 − 첫 구간 시작(달력일, 수익률 있는 구간 기준)
     * @param volPct           sd(R) × √(365/평균 구간 일수) (%). 수익률 있는 구간이 2개 미만이면 null
     * @param mddPct           구간 끝 누적 경로(시작 1.0)의 최대 낙폭(%, 0 이하)
     * @param sharpe           mean(R)/sd(R) × √(365/평균 구간 일수), 무위험 0. 구간 2개 미만이거나 sd가 0이면 null
     * @param spyCumReturnPct  같은 구간들(수익률 있는 구간)의 Π(1+R_spy) − 1 (%). 그중 한 구간이라도 SPY가 없으면 null
     * @param excessVsSpyPct   누적 − SPY 누적(%p)
     * @param coverageMin      창 안 모든 구간 커버리지의 최솟값(0~1). 구간이 없으면 null
     * @param coverageAvg      창 안 모든 구간 커버리지의 평균(0~1). 구간이 없으면 null
     * @param ineligibleReason 자격이 없을 때 사유(한국어, 여럿이면 "; "). 자격이 있으면 null
     */
    public record Result(String cik, int periodsUsed, int periodsTotal, LocalDate firstFilingDate,
                         LocalDate lastFilingDate, Double cumReturnPct, Double cagrPct, Double volPct, Double mddPct,
                         Double sharpe, Double spyCumReturnPct, Double excessVsSpyPct, Double coverageMin,
                         Double coverageAvg, boolean eligible, String ineligibleReason, List<Period> periods) {
        public Result {
            periods = periods == null ? List.of() : List.copyOf(periods);
        }
    }

    /** 순위 기준(명세 R10·D20). 기본은 CAGR. */
    public enum Metric { CAGR, EXCESS_VS_SPY, SHARPE }

    /** 순위가 붙은 결과. rank는 1부터. */
    public record Ranked(Result result, int rank) {
    }

    /**
     * 공시일 기준 복제(명세 R7, 설계 §4-0 ④).
     *
     * <p>filingDate ≤ asOf인 공시만 씁니다(공시일·보고일 순으로 정렬). F_i의 보유를 start_i = F_i 다음 거래일 종가에 사서
     * end_i = F_{i+1} 다음 거래일 종가까지 들었다고 봅니다. 마지막 구간과, F_{i+1} 다음 거래일이 기준일 뒤인 구간은 기준일 이하
     * 마지막 거래일에서 끝냅니다 — 기준일 뒤 가격을 쓰지 않기 위해서입니다(그래서 기준일 당일 공시는 아직 구간이 없습니다).
     * 길이가 0 이하인 구간(같은 날 낸 두 공시 중 앞의 것 등)은 구간으로 세지 않습니다 — 그날 산 것은 뒤 공시의 보유입니다.
     *
     * <p>창: end_i &gt; asOf − windowYears인 구간만, 첫 구간 start는 max(start_i, asOf − windowYears)로 자릅니다.
     * 자격: periodsUsed ≥ minPeriods, coverageMin ≥ minCoverage, coverageAvg ≥ avgCoverage(커버리지는 창 안 모든 구간 기준).
     *
     * @param prices 티커 → 수정주가 계열. 모르는 티커는 null을 돌려주면 됩니다(그 보유는 커버되지 않음). 티커마다 한 번만 부릅니다
     * @param spy    SPY 수정주가. null이면 SPY 수익률·초과가 null
     * @throws IllegalArgumentException asOf·criteria·prices가 null
     */
    public static Result compute(String cik, List<Filing> filings, Function<String, DailySeries> prices,
                                 DailySeries spy, LocalDate asOf, Criteria criteria) {
        if (asOf == null || criteria == null || prices == null) {
            throw new IllegalArgumentException("기준일·자격 기준·가격 조회가 필요합니다");
        }
        List<Filing> seen = new ArrayList<>();
        if (filings != null) {
            for (Filing filing : filings) {
                if (filing != null && !filing.filingDate().isAfter(asOf)) {
                    seen.add(filing);
                }
            }
        }
        if (seen.isEmpty()) {
            return new Result(cik, 0, 0, null, null, null, null, null, null, null, null, null, null, null,
                    false, "공시 없음", List.of());
        }
        seen.sort(FILING_ORDER);

        LocalDate lastSession = UsMarketCalendar.isTradingDay(asOf) ? asOf : UsMarketCalendar.previousTradingDay(asOf);
        LocalDate windowStart = asOf.minusYears(criteria.windowYears());
        Map<String, DailySeries> memo = new HashMap<>();
        Function<String, DailySeries> lookup = ticker -> {
            // computeIfAbsent는 null을 담지 않아 모르는 티커를 매번 다시 묻게 되므로 containsKey로 기억합니다.
            if (!memo.containsKey(ticker)) {
                memo.put(ticker, prices.apply(ticker));
            }
            return memo.get(ticker);
        };

        List<Slice> slices = new ArrayList<>();
        for (int i = 0; i < seen.size(); i++) {
            Filing filing = seen.get(i);
            LocalDate start = UsMarketCalendar.nextTradingDay(filing.filingDate());
            LocalDate end = lastSession;
            if (i + 1 < seen.size()) {
                LocalDate next = UsMarketCalendar.nextTradingDay(seen.get(i + 1).filingDate());
                end = next.isBefore(lastSession) ? next : lastSession;
            }
            if (!end.isAfter(windowStart)) {
                continue;
            }
            if (start.isBefore(windowStart)) {
                start = windowStart;
            }
            if (!end.isAfter(start)) {
                continue;
            }
            slices.add(slice(filing, start, end, lookup, spy));
        }
        return summarize(cik, seen.get(seen.size() - 1).filingDate(), slices, criteria);
    }

    /**
     * 자격 있는 결과만 metric 내림차순(값이 null이면 뒤로), 동률은 CIK 오름차순. rank는 1부터 차례로(동률도 다른 순위) —
     * 상위 N곳을 자를 때 동률 때문에 N곳이 넘지 않게 합니다.
     *
     * @throws IllegalArgumentException metric이 null
     */
    public static List<Ranked> rank(List<Result> results, Metric metric) {
        if (metric == null) {
            throw new IllegalArgumentException("순위 기준이 없습니다");
        }
        if (results == null) {
            return List.of();
        }
        Comparator<Result> order = Comparator
                .comparing((Result r) -> metricValue(r, metric), Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(Result::cik, Comparator.nullsLast(Comparator.naturalOrder()));
        List<Result> eligible = results.stream().filter(r -> r != null && r.eligible()).sorted(order).toList();
        List<Ranked> out = new ArrayList<>(eligible.size());
        for (int i = 0; i < eligible.size(); i++) {
            out.add(new Ranked(eligible.get(i), i + 1));
        }
        return List.copyOf(out);
    }

    private static Double metricValue(Result r, Metric metric) {
        return switch (metric) {
            case CAGR -> r.cagrPct();
            case EXCESS_VS_SPY -> r.excessVsSpyPct();
            case SHARPE -> r.sharpe();
        };
    }

    /** 구간 하나와 계산용 원래 비율(×100 하기 전 — 되돌려 나누며 생기는 끝자리 오차를 피함). */
    private record Slice(Period period, Double ret, Double spyRet, long days) {
    }

    private static Slice slice(Filing filing, LocalDate start, LocalDate end, Function<String, DailySeries> lookup,
                               DailySeries spy) {
        double total = 0.0;
        // 같은 티커가 여러 줄(같은 종목의 다른 줄·다른 운용역)이면 평가액을 더해 한 종목으로 셉니다.
        Map<String, Double> byTicker = new LinkedHashMap<>();
        for (Holding13F holding : filing.holdings()) {
            if (holding == null || !(holding.value() >= 0) || Double.isInfinite(holding.value())) {
                continue;
            }
            total += holding.value();
            String ticker = holding.ticker() == null ? null : holding.ticker().strip();
            if (ticker != null && !ticker.isEmpty()) {
                byTicker.merge(ticker, holding.value(), Double::sum);
            }
        }
        double covered = 0.0;
        double weighted = 0.0;
        int coveredTickers = 0;
        for (Map.Entry<String, Double> entry : byTicker.entrySet()) {
            Double ratio = priceRatio(lookup.apply(entry.getKey()), start, end);
            if (ratio != null) {
                covered += entry.getValue();
                weighted += entry.getValue() * (ratio - 1.0);
                coveredTickers++;
            }
        }
        // 재정규화: 커버된 평가액끼리의 비중. 커버된 평가액이 0이면 수익률을 만들지 않습니다(0%로 채우지 않음).
        Double ret = covered > 0 ? weighted / covered : null;
        Double spyRatio = spy == null ? null : priceRatio(spy, start, end);
        Double spyRet = spyRatio == null ? null : spyRatio - 1.0;
        double coverage = total > 0 ? covered / total : 0.0;
        Period period = new Period(filing.filingDate(), filing.reportDate(), start, end,
                ret == null ? null : ret * 100.0, spyRet == null ? null : spyRet * 100.0,
                coverage, coveredTickers, filing.holdings().size());
        return new Slice(period, ret, spyRet, ChronoUnit.DAYS.between(start, end));
    }

    /**
     * 끝 가격 / 시작 가격. 시작은 start 이하 마지막 종가가 start에서 7일 이내일 때만, 끝은 end 이하 마지막 종가가 start보다
     * 뒤일 때만(구간 중 상장폐지면 마지막 가격). 가격이 0 이하이거나 숫자가 아니면 null.
     */
    private static Double priceRatio(DailySeries series, LocalDate start, LocalDate end) {
        if (series == null || series.isEmpty()) {
            return null;
        }
        LocalDate startDate = series.floorDate(start);
        if (startDate == null || startDate.isBefore(start.minusDays(MAX_START_PRICE_AGE_DAYS))) {
            return null;
        }
        LocalDate endDate = series.floorDate(end);
        // 끝 가격 날짜가 start 이하이면 구간 동안 한 번도 거래되지 않은 것(시작 전에 이미 사라짐) — 수익률 0%로 만들지 않습니다.
        if (endDate == null || !endDate.isAfter(start)) {
            return null;
        }
        double p0 = series.floorValue(start);
        double p1 = series.floorValue(end);
        if (!(p0 > 0) || !(p1 > 0) || Double.isInfinite(p0) || Double.isInfinite(p1)) {
            return null;
        }
        return p1 / p0;
    }

    private static Result summarize(String cik, LocalDate lastFilingDate, List<Slice> slices, Criteria criteria) {
        List<Period> periods = slices.stream().map(Slice::period).toList();
        List<Slice> used = slices.stream().filter(s -> s.ret() != null).toList();
        int n = used.size();

        Double cum = null;
        Double cagr = null;
        Double vol = null;
        Double mdd = null;
        Double sharpe = null;
        Double spyCum = null;
        Double excess = null;
        if (n > 0) {
            double path = 1.0;
            double peak = 1.0;
            double worst = 0.0;
            double spyGrowth = 1.0;
            boolean spyComplete = true;
            for (Slice s : used) {
                path *= 1.0 + s.ret();
                peak = Math.max(peak, path);
                worst = Math.min(worst, path / peak - 1.0);
                if (s.spyRet() == null) {
                    spyComplete = false;
                } else {
                    spyGrowth *= 1.0 + s.spyRet();
                }
            }
            cum = (path - 1.0) * 100.0;
            mdd = worst * 100.0;
            long days = ChronoUnit.DAYS.between(used.get(0).period().start(), used.get(n - 1).period().end());
            if (days > 0) {
                cagr = (Math.pow(path, DAYS_PER_YEAR / days) - 1.0) * 100.0;
            }
            // SPY가 빠진 구간을 건너뛰고 곱하면 기관과 다른 기간을 비교하게 되므로, 하나라도 빠지면 비교하지 않습니다.
            if (spyComplete) {
                spyCum = (spyGrowth - 1.0) * 100.0;
                excess = cum - spyCum;
            }
            if (n >= 2) {
                double mean = 0.0;
                double meanDays = 0.0;
                for (Slice s : used) {
                    mean += s.ret();
                    meanDays += s.days();
                }
                mean /= n;
                meanDays /= n;
                double squares = 0.0;
                for (Slice s : used) {
                    squares += (s.ret() - mean) * (s.ret() - mean);
                }
                double sd = Math.sqrt(squares / (n - 1));
                // 구간 길이가 공시 간격(약 91일)이라 구간 수익률의 sd를 연율로 바꾸려면 √(1년 / 평균 구간 일수)를 곱합니다.
                double annualize = Math.sqrt(DAYS_PER_YEAR / meanDays);
                if (sd < FLAT) {
                    vol = 0.0;
                } else {
                    vol = sd * annualize * 100.0;
                    sharpe = mean / sd * annualize;
                }
            }
        }

        Double coverageMin = null;
        Double coverageAvg = null;
        if (!periods.isEmpty()) {
            double min = Double.POSITIVE_INFINITY;
            double sum = 0.0;
            for (Period p : periods) {
                min = Math.min(min, p.coverage());
                sum += p.coverage();
            }
            coverageMin = min;
            coverageAvg = sum / periods.size();
        }

        List<String> reasons = new ArrayList<>();
        if (n < criteria.minPeriods()) {
            reasons.add("구간 " + n + "개 < " + criteria.minPeriods());
        }
        if (coverageMin == null) {
            if (reasons.isEmpty()) {
                reasons.add("창 안 구간 없음");   // minPeriods가 0인 설정에서만 — 구간이 없는데 자격을 줄 수는 없습니다.
            }
        } else {
            if (coverageMin < criteria.minCoverage()) {
                reasons.add("최소 커버리지 " + percentFloor(coverageMin) + "% < " + percent(criteria.minCoverage()) + "%");
            }
            if (coverageAvg < criteria.avgCoverage()) {
                reasons.add("평균 커버리지 " + percentFloor(coverageAvg) + "% < " + percent(criteria.avgCoverage()) + "%");
            }
        }
        boolean eligible = reasons.isEmpty();
        LocalDate firstFilingDate = periods.isEmpty() ? null : periods.get(0).filingDate();
        return new Result(cik, n, periods.size(), firstFilingDate, lastFilingDate, cum, cagr, vol, mdd, sharpe,
                spyCum, excess, coverageMin, coverageAvg, eligible, eligible ? null : String.join("; ", reasons),
                periods);
    }

    /**
     * 기준에 못 미친 값을 % 정수로 — 반올림이 아니라 내림입니다. 반올림하면 49.6%가 "50% &lt; 50%"로 보여 사유가 틀린 것처럼
     * 읽힙니다.
     */
    private static int percentFloor(double fraction) {
        return (int) Math.floor(fraction * 100.0 + PERCENT_EPSILON);
    }

    /** 기준값을 %로(정수면 소수점 없이, 아니면 한 자리). */
    private static String percent(double fraction) {
        double pct = fraction * 100.0;
        long whole = Math.round(pct);
        if (Math.abs(pct - whole) < PERCENT_EPSILON) {
            return Long.toString(whole);
        }
        return String.format(Locale.ROOT, "%.1f", pct);
    }
}
