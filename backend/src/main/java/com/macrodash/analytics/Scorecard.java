package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.NavigableMap;

/**
 * 종목 스코어카드 — <b>가격으로 잴 수 있는 것만</b>.
 *
 * <p><b>이 카드에 없는 것을 먼저 적습니다.</b> 재무 안정성(부채비율·이자보상배율)과
 * 성장성(매출·이익 증가율)은 여기 없습니다. 이 프로젝트가 재무 데이터를 수집하지
 * 않기 때문입니다. 그래서 이 점수는 <b>종합 점수가 아닙니다</b> — 부실기업도
 * 주가만 오르면 높은 점수를 받습니다. "이 회사가 좋은가"가 아니라 "이 주식이
 * 최근 어떻게 움직였나"를 재는 카드입니다.
 *
 * <p>점수는 <b>백분위</b>입니다. 같은 유니버스(13F 매핑 대형주)의 다른 종목들과
 * 견주어 몇 %에 있는지를 0~100으로 적습니다. 절대 기준(예: "변동성 30% 이하면
 * 80점")을 쓰지 않는 이유는, 그 기준선이 어디서 왔는지 설명할 수 없기
 * 때문입니다. 비교 대상은 화면에 함께 적습니다.
 */
public final class Scorecard {

    private Scorecard() {
    }

    /** 원자료 — 점수로 바꾸기 전의 실제 측정값. 점수만 보여 주면 검증할 수 없습니다. */
    public record Raw(Double momentum1m, Double momentum3m, Double momentum6m,
                      Double momentum12m, Double volatility, Double beta,
                      Double maxDrawdown, Double trendPosition, Integer samples) {
    }

    /**
     * 가격 시계열에서 측정값을 뽑습니다 — 전체 시계열과 측정 구간이 같을 때.
     *
     * @param series    종목 일별 종가 (날짜 오름차순)
     * @param benchmark 베타를 재는 기준 계열. null이면 베타만 null이 됩니다
     * @return 측정값 묶음. <b>표본이 30 거래일 미만이면 모든 값이 null</b>입니다
     */
    public static Raw measure(NavigableMap<LocalDate, Double> series,
                              NavigableMap<LocalDate, Double> benchmark) {
        return measure(series, series, benchmark);
    }

    /**
     * 가격 시계열에서 측정값을 뽑습니다.
     *
     * <p><b>'최근 n거래일' 지표(모멘텀 1·3·6·12개월, 200일 추세 위치)는 측정 구간과 상관없이 전체 시계열로</b> 잽니다.
     * 측정 구간(1년)으로 먼저 자르면 표본이 많아야 252개라 252거래일 전 값이 남지 않아, 기본 화면에서 12개월
     * 모멘텀이 모든 종목에서 늘 비었습니다(QA-088). 측정 구간은 그 구간의 성격을 재는 변동성·최대낙폭·베타·표본 수에만
     * 씁니다. 측정 구간이 전체 시계열의 끝부분이면 '최근 n거래일'의 값은 구간 안에 있을 때 그대로라, 2년 이상
     * 구간의 값은 예전과 같습니다.
     *
     * @param history   잘리지 않은 전체 일별 종가 (날짜 오름차순)
     * @param window    측정 구간으로 자른 종가 — history의 끝부분이어야 합니다
     * @param benchmark 베타를 재는 기준 계열(측정 구간). null이면 베타만 null이 됩니다
     * @return 측정값 묶음. <b>측정 구간 표본이 30 거래일 미만이면 모든 값이 null</b>입니다
     */
    public static Raw measure(NavigableMap<LocalDate, Double> history,
                              NavigableMap<LocalDate, Double> window,
                              NavigableMap<LocalDate, Double> benchmark) {
        NavigableMap<LocalDate, Double> series = window;
        if (series == null || series.size() < 30) {
            return new Raw(null, null, null, null, null, null, null, null,
                    series == null ? 0 : series.size());
        }
        NavigableMap<LocalDate, Double> full = history == null ? series : history;

        double[] returns = dailyReturns(series);
        Double beta = null;
        if (benchmark != null && benchmark.size() >= 30) {
            double[] paired = pairedBenchmarkReturns(series, benchmark);
            if (paired != null) {
                double[] own = pairedOwnReturns(series, benchmark);
                beta = PortfolioRisk.beta(own, paired);
            }
        }

        return new Raw(
                momentum(full, 21),
                momentum(full, 63),
                momentum(full, 126),
                momentum(full, 252),
                PortfolioRisk.annualizedVolatility(returns),
                beta,
                PortfolioRisk.maxDrawdown(returns),
                trendPosition(full, 200),
                returns.length);
    }

    /**
     * 최근 n 거래일 수익률.
     *
     * @param series      일별 종가
     * @param tradingDays 며칠 전과 비교할지 (<b>달력이 아니라 거래일</b>)
     * @return 수익률(%). 표본이 부족하거나 과거 가격이 0 이하면 null
     */
    static Double momentum(NavigableMap<LocalDate, Double> series, int tradingDays) {
        List<Double> values = new ArrayList<>(series.values());
        if (values.size() <= tradingDays) {
            return null;
        }
        double last = values.get(values.size() - 1);
        double past = values.get(values.size() - 1 - tradingDays);
        return (past <= 0) ? null : (last / past - 1.0) * 100.0;
    }

    /**
     * 이동평균 대비 위치 — 종가가 이동평균보다 몇 % 위/아래인가.
     *
     * @param series 일별 종가
     * @param window 이동평균 구간 (거래일)
     * @return 위치(%). 0보다 크면 추세 위. 표본이 {@code window}보다 짧으면 null
     */
    static Double trendPosition(NavigableMap<LocalDate, Double> series, int window) {
        List<Double> values = new ArrayList<>(series.values());
        if (values.size() < window) {
            return null;
        }
        double sum = 0.0;
        for (int i = values.size() - window; i < values.size(); i++) {
            sum += values.get(i);
        }
        double average = sum / window;
        return average <= 0 ? null : (values.get(values.size() - 1) / average - 1.0) * 100.0;
    }

    /**
     * 일간 수익률. 0 이하·결측 종가가 낀 구간은 <b>표본에서 뺍니다</b>.
     *
     * <p>예전에는 그 구간을 0.0(변화 없음)으로 넣었습니다. 0원 종가는 거래가 아니라 깨진
     * 데이터인데, 0% 수익률 표본이 변동성을 낮추고 백분위를 밀었습니다.
     */
    static double[] dailyReturns(NavigableMap<LocalDate, Double> series) {
        List<Double> values = new ArrayList<>(series.values());
        List<Double> out = new ArrayList<>();
        for (int i = 1; i < values.size(); i++) {
            Double previous = values.get(i - 1);
            Double current = values.get(i);
            if (previous == null || current == null || previous <= 0 || current <= 0) {
                continue;
            }
            out.add(current / previous - 1.0);
        }
        return out.stream().mapToDouble(Double::doubleValue).toArray();
    }

    private static List<LocalDate> commonDates(NavigableMap<LocalDate, Double> a,
                                               NavigableMap<LocalDate, Double> b) {
        List<LocalDate> out = new ArrayList<>();
        for (LocalDate date : a.keySet()) {
            if (b.containsKey(date)) {
                out.add(date);
            }
        }
        return out;
    }

    static double[] pairedOwnReturns(NavigableMap<LocalDate, Double> series,
                                     NavigableMap<LocalDate, Double> benchmark) {
        return returnsOn(series, commonDates(series, benchmark));
    }

    static double[] pairedBenchmarkReturns(NavigableMap<LocalDate, Double> series,
                                           NavigableMap<LocalDate, Double> benchmark) {
        return returnsOn(benchmark, commonDates(series, benchmark));
    }

    private static double[] returnsOn(NavigableMap<LocalDate, Double> series, List<LocalDate> dates) {
        if (dates.size() < 2) {
            return null;
        }
        double[] out = new double[dates.size() - 1];
        for (int i = 1; i < dates.size(); i++) {
            double previous = series.get(dates.get(i - 1));
            double current = series.get(dates.get(i));
            if (previous <= 0) {
                return null;
            }
            out[i - 1] = current / previous - 1.0;
        }
        return out;
    }

    /**
     * 유니버스 안에서의 백분위 점수.
     *
     * @param value          점수를 낼 값
     * @param universe       비교 대상 값들 (같은 방식으로 측정한 것이어야 합니다)
     * @param higherIsBetter 큰 값이 좋은 지표인가 (모멘텀 true, 변동성·낙폭 false)
     * @return 0~100점. <b>비교 대상이 10개 미만이거나 값이 없으면 null</b>
     *
     * <p>10개 미만에서 점수를 내지 않는 이유 — 3개로 낸 "67점"은 숫자만 그럴듯하고
     * 아무것도 말하지 않습니다.
     */
    public static Double percentileScore(Double value, List<Double> universe,
                                         boolean higherIsBetter) {
        if (value == null || universe == null) {
            return null;
        }
        List<Double> sorted = new ArrayList<>();
        for (Double one : universe) {
            if (one != null && !Double.isNaN(one)) {
                sorted.add(one);
            }
        }
        // 비교 대상이 너무 적으면 백분위가 의미를 잃습니다. 3개로 낸 "67점"은
        // 숫자만 그럴듯하고 아무것도 말하지 않습니다.
        if (sorted.size() < 10) {
            return null;
        }
        Collections.sort(sorted);

        int below = 0;
        for (Double one : sorted) {
            if (one < value) {
                below++;
            }
        }
        double percentile = (double) below / sorted.size() * 100.0;
        return higherIsBetter ? percentile : 100.0 - percentile;
    }
}
