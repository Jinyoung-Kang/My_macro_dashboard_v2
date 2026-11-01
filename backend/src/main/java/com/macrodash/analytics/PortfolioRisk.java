package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * 포트폴리오 위험 계산.
 *
 * <p>비중과 일별 종가만 받습니다. 재무 데이터도, 상용 리스크 모델도 쓰지
 * 않습니다 — 여기 있는 값은 전부 <b>과거 수익률에서 직접 잰 것</b>입니다.
 *
 * <p><b>이 계산이 말하지 않는 것</b> — 과거 1년의 변동이 앞으로도 같으리라는
 * 보장은 없습니다. VaR는 "이보다 나쁜 날이 5%는 있었다"는 과거의 기록이지
 * 손실의 상한이 아닙니다. 화면이 이 한계를 함께 적어야 합니다.
 *
 * <p>연율화는 √252(미국 거래일)를 씁니다.
 */
public final class PortfolioRisk {

    private PortfolioRisk() {
    }

    /** 미국 시장의 연간 거래일. 일별 변동성을 연율로 옮길 때 씁니다. */
    public static final double TRADING_DAYS = 252.0;

    /** 재구성한 포트폴리오의 일별 수익률. */
    public record Returns(List<LocalDate> dates, double[] values) {
        public int size() {
            return values.length;
        }
    }

    /**
     * 비중 가중 일별 수익률을 만듭니다.
     *
     * @param weights 종목 키 → 비중(%). 합이 100이 아니어도 됩니다
     * @param prices  종목 키 → 일별 종가. 비중에 있어도 여기 없으면 <b>제외</b>됩니다
     * @return 날짜와 수익률(소수, 0.01 = 1%). 쓸 수 있는 종목이 없으면 크기 0
     *
     * <p>두 가지 가정이 있고 화면이 이를 적어야 합니다.
     * <ul>
     *   <li><b>매일 재조정(고정 비중)</b> — 13F는 분기에 한 번 찍힌 사진이라
     *       그사이 실제 비중이 어떻게 흘렀는지 알 수 없습니다.</li>
     *   <li><b>가격을 찾은 종목만으로 100%</b> — 커버하지 못한 몫까지 들고 계산하면
     *       "현금을 들고 있었다"는 다른 포트폴리오가 됩니다. 커버리지는 호출부가
     *       따로 표시합니다.</li>
     * </ul>
     *
     * <p>날짜는 <b>모든 종목에 값이 있는 날</b>만 씁니다. 한 종목이 쉰 날을 0%로
     * 채우면 그날 포트폴리오가 실제보다 덜 움직인 것이 됩니다.
     */
    public static Returns weightedReturns(Map<String, Double> weights,
                                          Map<String, NavigableMap<LocalDate, Double>> prices) {
        Map<String, NavigableMap<LocalDate, Double>> usable = new LinkedHashMap<>();
        double total = 0.0;
        for (Map.Entry<String, Double> entry : weights.entrySet()) {
            NavigableMap<LocalDate, Double> series = prices.get(entry.getKey());
            if (series != null && series.size() >= 2 && entry.getValue() != null
                    && entry.getValue() > 0) {
                usable.put(entry.getKey(), series);
                total += entry.getValue();
            }
        }
        if (usable.isEmpty() || total <= 0) {
            return new Returns(List.of(), new double[0]);
        }

        List<LocalDate> dates = sharedDates(usable);
        if (dates.size() < 2) {
            return new Returns(List.of(), new double[0]);
        }

        List<LocalDate> outDates = new ArrayList<>(dates.subList(1, dates.size()));
        double[] out = new double[outDates.size()];
        for (Map.Entry<String, NavigableMap<LocalDate, Double>> entry : usable.entrySet()) {
            // 남은 종목만으로 비중을 다시 100%로 맞춥니다. 커버하지 못한 몫까지
            // 들고 계산하면 "현금을 들고 있었다"는 다른 포트폴리오가 됩니다.
            double weight = weights.get(entry.getKey()) / total;
            NavigableMap<LocalDate, Double> series = entry.getValue();
            for (int i = 1; i < dates.size(); i++) {
                double previous = series.get(dates.get(i - 1));
                double current = series.get(dates.get(i));
                out[i - 1] += weight * (current / previous - 1.0);
            }
        }
        return new Returns(outDates, out);
    }

    /** 모든 계열에 값이 있는 날짜만, 오름차순으로. */
    private static List<LocalDate> sharedDates(
            Map<String, NavigableMap<LocalDate, Double>> series) {
        TreeMap<LocalDate, Integer> counts = new TreeMap<>();
        for (NavigableMap<LocalDate, Double> one : series.values()) {
            for (Map.Entry<LocalDate, Double> point : one.entrySet()) {
                if (point.getValue() != null && point.getValue() > 0) {
                    counts.merge(point.getKey(), 1, Integer::sum);
                }
            }
        }
        List<LocalDate> out = new ArrayList<>();
        for (Map.Entry<LocalDate, Integer> entry : counts.entrySet()) {
            if (entry.getValue() == series.size()) {
                out.add(entry.getKey());
            }
        }
        return out;
    }

    /**
     * 연율 변동성.
     *
     * @param returns 일별 수익률 (소수)
     * @return 연율 변동성(%) = 일별 표준편차 × √252 × 100. 표본 2개 미만이면 null
     */
    public static Double annualizedVolatility(double[] returns) {
        Double daily = standardDeviation(returns);
        return daily == null ? null : daily * Math.sqrt(TRADING_DAYS) * 100.0;
    }

    static Double standardDeviation(double[] values) {
        if (values == null || values.length < 2) {
            return null;
        }
        double mean = Arrays.stream(values).average().orElse(0.0);
        double sum = 0.0;
        for (double value : values) {
            sum += (value - mean) * (value - mean);
        }
        // 표본 표준편차(n-1). 모집단이 아니라 관측된 표본이기 때문입니다.
        return Math.sqrt(sum / (values.length - 1));
    }

    /**
     * 역사적 VaR — 하위 (1−confidence) 분위수.
     *
     * @param returns    일별 수익률 (소수)
     * @param confidence 신뢰수준 (0.95, 0.99)
     * @return 손실을 <b>음수</b>로 돌려준 값(%). 표본 20개 미만이면 null
     *
     * <p>정규분포를 가정하지 않고 실제로 있었던 날들을 줄 세워 자릅니다 — 시장
     * 수익률은 정규분포보다 꼬리가 두껍습니다.
     *
     * <p><b>VaR는 손실의 상한이 아닙니다.</b> "이보다 나쁜 날이 5%는 있었다"는
     * 과거의 기록일 뿐입니다.
     */
    public static Double historicalVar(double[] returns, double confidence) {
        if (returns == null || returns.length < 20) {
            return null;
        }
        double[] sorted = returns.clone();
        Arrays.sort(sorted);
        int index = (int) Math.floor((1.0 - confidence) * sorted.length);
        index = Math.max(0, Math.min(sorted.length - 1, index));
        return sorted[index] * 100.0;
    }

    /**
     * 기대손실(ES · CVaR) — VaR를 넘어선 날들의 평균.
     *
     * @param returns    일별 수익률 (소수)
     * @param confidence 신뢰수준 (0.95, 0.99)
     * @return 음수(%). 표본 20개 미만이면 null. 항상 같은 신뢰수준의 VaR 이하입니다
     *
     * <p>VaR는 "얼마나 자주"만 말하고 "넘으면 얼마나"는 말하지 않습니다. 꼬리가
     * 두꺼운 자산일수록 둘의 차이가 벌어집니다.
     */
    public static Double expectedShortfall(double[] returns, double confidence) {
        if (returns == null || returns.length < 20) {
            return null;
        }
        double[] sorted = returns.clone();
        Arrays.sort(sorted);
        int cutoff = (int) Math.floor((1.0 - confidence) * sorted.length);
        cutoff = Math.max(1, Math.min(sorted.length, cutoff));
        double sum = 0.0;
        for (int i = 0; i < cutoff; i++) {
            sum += sorted[i];
        }
        return sum / cutoff * 100.0;
    }

    /**
     * 최대낙폭(MDD) — 누적 수익 곡선의 고점 대비 최대 하락.
     *
     * @param returns 일별 수익률 (소수)
     * @return <b>양수</b>(%). 표본 2개 미만이면 null
     */
    public static Double maxDrawdown(double[] returns) {
        if (returns == null || returns.length < 2) {
            return null;
        }
        double cumulative = 1.0;
        double peak = 1.0;
        double worst = 0.0;
        for (double value : returns) {
            cumulative *= (1.0 + value);
            peak = Math.max(peak, cumulative);
            worst = Math.min(worst, cumulative / peak - 1.0);
        }
        return Math.abs(worst) * 100.0;
    }

    /**
     * 베타 — 벤치마크가 1% 움직일 때 포트폴리오가 몇 % 움직였나.
     *
     * @param portfolio 포트폴리오 일별 수익률
     * @param benchmark 같은 날짜의 벤치마크 수익률. 길이가 같아야 합니다
     * @return 베타. 길이가 다르거나 표본 20개 미만이거나 벤치마크가 전혀 움직이지
     *         않았으면(분산 0) null
     */
    public static Double beta(double[] portfolio, double[] benchmark) {
        if (portfolio == null || benchmark == null
                || portfolio.length != benchmark.length || portfolio.length < 20) {
            return null;
        }
        double meanP = Arrays.stream(portfolio).average().orElse(0.0);
        double meanB = Arrays.stream(benchmark).average().orElse(0.0);
        double covariance = 0.0;
        double variance = 0.0;
        for (int i = 0; i < portfolio.length; i++) {
            covariance += (portfolio[i] - meanP) * (benchmark[i] - meanB);
            variance += (benchmark[i] - meanB) * (benchmark[i] - meanB);
        }
        return variance <= 0 ? null : covariance / variance;
    }

    /**
     * 추적오차 — 포트폴리오와 벤치마크 수익률 <b>차이</b>의 연율 변동성.
     *
     * @param portfolio 포트폴리오 일별 수익률
     * @param benchmark 같은 날짜의 벤치마크 수익률
     * @return 연율(%). 0이면 벤치마크를 그대로 따라간 것. 표본 20개 미만이면 null
     *
     * <p>수익이 좋았는지 나빴는지는 말하지 않습니다 — 얼마나 <b>달랐는지</b>만 봅니다.
     */
    public static Double trackingError(double[] portfolio, double[] benchmark) {
        if (portfolio == null || benchmark == null
                || portfolio.length != benchmark.length || portfolio.length < 20) {
            return null;
        }
        double[] active = new double[portfolio.length];
        for (int i = 0; i < portfolio.length; i++) {
            active[i] = portfolio[i] - benchmark[i];
        }
        return annualizedVolatility(active);
    }

    /** 종목 한 줄의 위험 기여. */
    public record Contribution(String key, String label, double weight,
                               Double volatility, Double beta,
                               Double marginal, Double contribution, Double share) {
    }

    /**
     * 종목별 위험 기여도.
     *
     * @param weights   종목 키 → 비중(%)
     * @param labels    종목 키 → 화면에 보일 이름 (없으면 키를 그대로 씁니다)
     * @param prices    종목 키 → 일별 종가
     * @param portfolio {@link #weightedReturns}의 결과
     * @return 기여가 큰 순. 포트폴리오 표본이 20개 미만이면 빈 목록
     *
     * <p>한계기여 = cov(종목, 포트폴리오) ÷ 포트폴리오 표준편차, 기여 = 비중 ×
     * 한계기여입니다. 이렇게 하면 <b>기여의 합이 포트폴리오 변동성과 정확히
     * 일치</b>합니다 (테스트가 이 항등식을 고정합니다). 개별 변동성을 비중으로
     * 가중해 더하면 분산 효과가 사라져 합이 맞지 않습니다.
     *
     * <p>이 표를 두는 이유 — <b>비중이 큰 종목이 곧 위험이 큰 종목은 아닙니다.</b>
     * 조용한 대형주 20%와 널뛰는 종목 5%의 기여가 뒤집히는 일이 흔합니다.
     */
    public static List<Contribution> contributions(
            Map<String, Double> weights,
            Map<String, String> labels,
            Map<String, NavigableMap<LocalDate, Double>> prices,
            Returns portfolio) {

        if (portfolio.size() < 20) {
            return List.of();
        }
        Double portfolioSd = standardDeviation(portfolio.values());
        if (portfolioSd == null || portfolioSd <= 0) {
            return List.of();
        }

        double total = weights.entrySet().stream()
                .filter(e -> prices.containsKey(e.getKey()) && e.getValue() != null && e.getValue() > 0)
                .mapToDouble(Map.Entry::getValue).sum();
        if (total <= 0) {
            return List.of();
        }

        List<Contribution> out = new ArrayList<>();
        for (Map.Entry<String, Double> entry : weights.entrySet()) {
            NavigableMap<LocalDate, Double> series = prices.get(entry.getKey());
            if (series == null || entry.getValue() == null || entry.getValue() <= 0) {
                continue;
            }
            double[] stock = alignedReturns(series, portfolio.dates());
            if (stock == null) {
                continue;
            }
            double weight = entry.getValue() / total;
            Double covariance = covariance(stock, portfolio.values());
            if (covariance == null) {
                continue;
            }
            // 한계기여 = cov(종목, 포트폴리오) / 포트폴리오 표준편차
            double marginal = covariance / portfolioSd;
            double contribution = weight * marginal;
            out.add(new Contribution(
                    entry.getKey(),
                    labels.getOrDefault(entry.getKey(), entry.getKey()),
                    entry.getValue(),
                    annualizedVolatility(stock),
                    null,
                    marginal * Math.sqrt(TRADING_DAYS) * 100.0,
                    contribution * Math.sqrt(TRADING_DAYS) * 100.0,
                    contribution / portfolioSd * 100.0));
        }
        out.sort(Comparator.comparingDouble(
                (Contribution c) -> c.contribution() == null ? 0.0 : c.contribution()).reversed());
        return out;
    }

    /**
     * 포트폴리오 수익률과 같은 날짜에 맞춘 종목 수익률.
     *
     * @param series 종목 일별 종가
     * @param dates  맞출 날짜 (포트폴리오 수익률의 날짜)
     * @return 같은 길이의 수익률 배열. 날짜 하나라도 직전 가격을 찾지 못하면
     *         <b>배열 전체가 null</b>입니다 — 일부만 채우면 길이가 어긋납니다
     */
    public static double[] alignedReturns(NavigableMap<LocalDate, Double> series, List<LocalDate> dates) {
        double[] out = new double[dates.size()];
        for (int i = 0; i < dates.size(); i++) {
            LocalDate date = dates.get(i);
            Map.Entry<LocalDate, Double> previous = series.lowerEntry(date);
            Double current = series.get(date);
            if (previous == null || previous.getValue() == null || previous.getValue() <= 0
                    || current == null || current <= 0) {
                return null;
            }
            out[i] = current / previous.getValue() - 1.0;
        }
        return out;
    }

    static Double covariance(double[] a, double[] b) {
        if (a == null || b == null || a.length != b.length || a.length < 2) {
            return null;
        }
        double meanA = Arrays.stream(a).average().orElse(0.0);
        double meanB = Arrays.stream(b).average().orElse(0.0);
        double sum = 0.0;
        for (int i = 0; i < a.length; i++) {
            sum += (a[i] - meanA) * (b[i] - meanB);
        }
        return sum / (a.length - 1);
    }
}
