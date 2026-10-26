package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * 🧪 모의 매매 책의 성과 통계(명세 L10): 누적·CAGR·연율 변동성·MDD·샤프·벤치마크 초과·베타.
 *
 * <p><b>표본이 20거래일 미만이면 누적 수익률만 냅니다.</b> 며칠치로 연율화하면 CAGR이 수백 %로 부풀고,
 * 샤프·베타는 우연과 구별되지 않습니다 — 0이 아니라 null(화면 {@code —})입니다. 표본이 넘어도 몇 달치 결과로는 통계적
 * 결론을 낼 수 없다는 것이 화면 한계 문구 7입니다.
 *
 * <p><b>기록이 빠진 날이 있어도 거래일로 셉니다.</b> 순자산 줄은 확정 종가 관측치가 있는 날에만 생기므로(맥 절전·수집 실패),
 * 또 책을 리셋하면 출발일 줄과 그 뒤 줄 사이가 몇 달 비므로, 기록 수가 거래일 수보다 적을 수 있습니다. 그래서 표본 크기와
 * CAGR의 지수는 첫 기록과 마지막 기록 사이의 <b>거래일 수</b>(그 시장 달력의 {@link TradingCalendar#tradingDaysBetween})로 셉니다 — 기록
 * 수로 세면 거래일 60일 중 40개만 남았을 때 +5%가 CAGR 37%(실제 23%)로 부풉니다. 변동성·샤프·베타는 <b>하루 간격 쌍</b>
 * (두 기록이 연속 거래일)의 수익률만 씁니다 — 며칠·몇 달치 수익률을 하루치로 세면 분산이 부풀고, 그런 쌍이 20개 미만이면
 * null입니다.
 *
 * <p>규약: 연율화는 252거래일(달력 365일이 아님 — 장부는 거래일마다 한 점), 무위험 수익률 0, 표준편차는 표본(n−1),
 * MDD는 0 이하의 %(−25.0 = 고점 대비 25% 하락, 기록된 점 기준). 장부 순자산은 배당을 반영하지 않은 가격 수익률입니다(D12).
 *
 * <p>순자산이 거의 움직이지 않으면(일별 수익률 표준편차 &lt; 1e-12, 예: 현금만 든 책) 변동성은 0, 샤프는 null입니다 —
 * 0에 가까운 수로 나누면 끝자리 잡음이 10^15 같은 샤프를 만듭니다.
 */
public final class PaperStats {

    private PaperStats() {
    }

    /** 이보다 짧은 거래일 구간(또는 적은 하루 간격 쌍)으로는 누적 외 통계를 내지 않습니다. */
    public static final int MIN_SAMPLE = 20;
    /** 연간 거래일. */
    public static final double TRADING_DAYS = 252.0;
    /** 이보다 작은 표준편차는 0으로 봅니다(위 설명). */
    private static final double FLAT = 1e-12;

    /**
     * @param cumReturnPct 누적 수익률(%) — 첫 점 대비 마지막 점. 점이 2개 미만이면 null
     * @param cagrPct      (1+누적)^(252/표본 거래일) − 1 (%)
     * @param volPct       하루 간격 쌍의 일별 수익률 표준편차 × √252 (%). 그런 쌍이 20개 미만이면 null
     * @param mddPct       최대 낙폭(%, 0 이하)
     * @param sharpe       하루 간격 쌍의 평균 / 표준편차 × √252 (무위험 0). 표준편차가 0이거나 쌍이 20개 미만이면 null
     * @param excessPct    누적 − 벤치마크 누적(%p) — 둘 다 값이 있는 첫 날과 마지막 날 사이. 벤치마크가 없으면 null
     * @param beta         cov(책, 벤치마크) / var(벤치마크) — 하루 간격이고 두 날 모두 벤치마크가 있는 쌍만. 20개 미만이면 null
     * @param sampleDays   첫 점과 마지막 점 사이의 거래일 수(빠진 날이 없으면 점 수 − 1, 점이 2개 미만이면 0)
     */
    public record Stats(Double cumReturnPct, Double cagrPct, Double volPct, Double mddPct, Double sharpe,
                        Double excessPct, Double beta, int sampleDays) {
    }

    /**
     * 거래일별 순자산(날짜 오름차순, null 없음 — 서비스가 걸러 줌)과 같은 날짜의 벤치마크 순자산(null 허용 — 그날 빠지면
     * 그날이 낀 수익률 쌍은 빼고 계산). 표본(첫·마지막 기록 사이 거래일 수) &lt; 20이면 cumReturnPct만 계산하고 나머지 null.
     * 기록 사이가 비는 날은 위 클래스 설명대로 다룹니다.
     *
     * <p>거래일은 미국 달력으로 셉니다 — {@link #compute(TradingCalendar, List, List, List)}에 미국 달력을 넘깁니다.
     *
     * @param benchmarkNav null이면 벤치마크 없음(bench_spy 자신) — 초과·베타 null
     * @throws IllegalArgumentException 길이가 다르거나, 날짜가 엄격한 오름차순이 아니거나, 순자산에 null·0 이하·NaN이 있으면
     */
    public static Stats compute(List<LocalDate> dates, List<Double> nav, List<Double> benchmarkNav) {
        return compute(UsMarketCalendar.CALENDAR, dates, nav, benchmarkNav);
    }

    /**
     * {@link #compute(List, List, List)}와 같되 표본·하루 간격 쌍의 거래일을 그 시장 달력으로 셉니다.
     *
     * @param calendar     그 책이 속한 시장의 거래일 달력
     * @param benchmarkNav null이면 벤치마크 없음 — 초과·베타 null
     * @throws IllegalArgumentException 길이가 다르거나, 날짜가 엄격한 오름차순이 아니거나, 순자산에 null·0 이하·NaN이 있으면
     */
    public static Stats compute(TradingCalendar calendar, List<LocalDate> dates, List<Double> nav,
                                List<Double> benchmarkNav) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        validate(dates, nav, benchmarkNav);
        int points = nav.size();
        if (points < 2) {
            return new Stats(null, null, null, null, null, null, null, 0);
        }
        // 표본 = 기록 수가 아니라 첫·마지막 기록 사이의 거래일 수(클래스 설명 — 빠진 날이 있어도 연율화가 부풀지 않게).
        int sample = calendar.tradingDaysBetween(dates.get(0), dates.get(points - 1));
        double growth = nav.get(points - 1) / nav.get(0);
        Double cum = (growth - 1.0) * 100.0;
        if (sample < MIN_SAMPLE) {
            return new Stats(cum, null, null, null, null, null, null, sample);
        }
        boolean[] daily = consecutiveDays(calendar, dates);

        Double cagr = (Math.pow(growth, TRADING_DAYS / sample) - 1.0) * 100.0;
        Double mdd = maxDrawdownPct(nav);
        Double vol = null;
        Double sharpe = null;
        double[] returns = dailyReturns(nav, daily);
        if (returns.length >= MIN_SAMPLE) {
            double mean = mean(returns);
            double sd = sampleStdDev(returns, mean);
            boolean flat = sd < FLAT;
            vol = flat ? 0.0 : sd * Math.sqrt(TRADING_DAYS) * 100.0;
            sharpe = flat ? null : mean / sd * Math.sqrt(TRADING_DAYS);
        }
        Double excess = benchmarkNav == null ? null : excessPct(nav, benchmarkNav);
        Double beta = benchmarkNav == null ? null : beta(nav, benchmarkNav, daily);
        return new Stats(cum, cagr, vol, mdd, sharpe, excess, beta, sample);
    }

    /** {@code out[i]}(i ≥ 1) = i−1번째와 i번째 기록이 연속 거래일인가. {@code out[0]}은 쓰지 않습니다. */
    private static boolean[] consecutiveDays(TradingCalendar calendar, List<LocalDate> dates) {
        boolean[] out = new boolean[dates.size()];
        for (int i = 1; i < dates.size(); i++) {
            out[i] = calendar.tradingDaysBetween(dates.get(i - 1), dates.get(i)) == 1;
        }
        return out;
    }

    /** 하루 간격 쌍의 일별 수익률만(기록 순). */
    private static double[] dailyReturns(List<Double> nav, boolean[] daily) {
        double[] out = new double[nav.size() - 1];
        int m = 0;
        for (int i = 1; i < nav.size(); i++) {
            if (daily[i]) {
                out[m++] = nav.get(i) / nav.get(i - 1) - 1.0;
            }
        }
        return Arrays.copyOf(out, m);
    }

    /** 고점 대비 최대 낙폭(%, 0 이하). 첫 점부터 고점으로 셉니다. */
    private static double maxDrawdownPct(List<Double> nav) {
        double peak = nav.get(0);
        double worst = 0.0;
        for (double value : nav) {
            peak = Math.max(peak, value);
            worst = Math.min(worst, value / peak - 1.0);
        }
        return worst * 100.0;
    }

    /**
     * 둘 다 값이 있는 첫 날 a와 마지막 날 b 사이의 누적 차. 중간에 벤치마크가 빈 날은 끝점 비교에 영향이 없습니다.
     * 그런 날이 2개 미만이면 null.
     */
    private static Double excessPct(List<Double> nav, List<Double> bench) {
        int first = -1;
        int last = -1;
        for (int i = 0; i < bench.size(); i++) {
            if (bench.get(i) != null) {
                if (first < 0) {
                    first = i;
                }
                last = i;
            }
        }
        if (first < 0 || first == last) {
            return null;
        }
        double book = nav.get(last) / nav.get(first) - 1.0;
        double benchmark = bench.get(last) / bench.get(first) - 1.0;
        return (book - benchmark) * 100.0;
    }

    /**
     * 일별 수익률 쌍(i−1→i가 연속 거래일이고 두 날 모두 벤치마크가 있는 i만)으로 cov/var. 빈 날을 건너뛴 이틀치 수익률은
     * 만들지 않습니다 — 하루치 수익률과 섞이면 분산이 커집니다.
     */
    private static Double beta(List<Double> nav, List<Double> bench, boolean[] daily) {
        int n = nav.size();
        double[] x = new double[n - 1];
        double[] y = new double[n - 1];
        int m = 0;
        for (int i = 1; i < n; i++) {
            Double previous = bench.get(i - 1);
            Double current = bench.get(i);
            if (daily[i] && previous != null && current != null) {
                x[m] = current / previous - 1.0;
                y[m] = nav.get(i) / nav.get(i - 1) - 1.0;
                m++;
            }
        }
        if (m < MIN_SAMPLE) {
            return null;
        }
        double meanX = 0.0;
        double meanY = 0.0;
        for (int i = 0; i < m; i++) {
            meanX += x[i];
            meanY += y[i];
        }
        meanX /= m;
        meanY /= m;
        double cov = 0.0;
        double var = 0.0;
        for (int i = 0; i < m; i++) {
            cov += (x[i] - meanX) * (y[i] - meanY);
            var += (x[i] - meanX) * (x[i] - meanX);
        }
        // 둘 다 (m−1)로 나누므로 비율에서 약분됩니다. 벤치마크가 움직이지 않았으면 베타는 정의되지 않습니다.
        if (Math.sqrt(var / (m - 1)) < FLAT) {
            return null;
        }
        return cov / var;
    }

    private static double mean(double[] values) {
        double sum = 0.0;
        for (double v : values) {
            sum += v;
        }
        return sum / values.length;
    }

    private static double sampleStdDev(double[] values, double mean) {
        double sum = 0.0;
        for (double v : values) {
            sum += (v - mean) * (v - mean);
        }
        return Math.sqrt(sum / (values.length - 1));
    }

    private static void validate(List<LocalDate> dates, List<Double> nav, List<Double> bench) {
        if (dates == null || nav == null) {
            throw new IllegalArgumentException("날짜·순자산 목록이 없습니다");
        }
        if (dates.size() != nav.size() || (bench != null && bench.size() != nav.size())) {
            throw new IllegalArgumentException("날짜·순자산·벤치마크 길이가 다릅니다: " + dates.size() + ", " + nav.size()
                    + ", " + (bench == null ? "없음" : bench.size()));
        }
        for (int i = 0; i < nav.size(); i++) {
            LocalDate date = dates.get(i);
            if (date == null || (i > 0 && !date.isAfter(dates.get(i - 1)))) {
                throw new IllegalArgumentException("날짜가 엄격한 오름차순이 아닙니다: " + i + "번째 " + date);
            }
            requirePositive(nav.get(i), "순자산", date);
            if (bench != null && bench.get(i) != null) {
                requirePositive(bench.get(i), "벤치마크 순자산", date);
            }
        }
    }

    private static void requirePositive(Double v, String what, LocalDate date) {
        if (v == null || !(v > 0) || v.isInfinite()) {
            throw new IllegalArgumentException(what + "은(는) 0보다 큰 수여야 합니다: " + date + "=" + v);
        }
    }
}
