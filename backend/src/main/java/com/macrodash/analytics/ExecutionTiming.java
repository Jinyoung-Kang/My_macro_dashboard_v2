package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Random;
import java.util.TreeMap;

/**
 * 🧪 체결 시점 비교(미국 Claude 계좌2 실험 — 명세 docs/specs/2026-10-30-claude-book2-timing-design.md §14-2, ADR 0022): 주문마다 "그 시점에
 * 체결했다면 계좌1식(다음 시간별 관측치)보다 몇 bp 나았나"와, 그 차이의 금액 가중 평균·결정일 묶음 부트스트랩 90% 구간.
 *
 * <p><b>차이</b> = s × (P_기준 − P_시점) ÷ P_기준 × 10⁴ bp. s는 매수 +1·매도 −1이라 양수면 그 시점이 기준보다 유리합니다(싸게 삼·비싸게 팖).
 * 가격은 슬리피지를 얹기 전의 원가격입니다(슬리피지는 시점과 무관하게 같은 5bp — §6-2).
 *
 * <p><b>표본이 모자라면 숫자를 내지 않습니다.</b> 주문이 {@value #MIN_ORDERS}건 미만이거나 결정일(기준 거래일) 묶음이 {@value #MIN_DAYS}개
 * 미만이면 평균·구간 모두 null입니다(§14-2 M1 — 0이 아님). 같은 날 결정의 주문들은 같은 시장 움직임을 함께 겪어 서로 독립이 아니므로,
 * 구간은 주문이 아니라 결정일 묶음을 다시 뽑습니다.
 *
 * <p><b>부트스트랩</b>: 결정일 묶음 K개에서 K개를 복원 추출하기를 {@value #RESAMPLES}번, 매번 뽑힌 묶음에 든 주문의 금액 가중 평균을 내고
 * 그 분포의 5%·95% 분위(선형 보간 — 순서 통계량 사이)를 구간으로 씁니다. 씨앗이 고정이고({@value #SEED}) 난수는 알고리즘이 명세된
 * {@link Random}이라 JDK 판이 달라도 같은 입력이면 같은 구간입니다. 묶음은 날짜 순으로 놓은 뒤 뽑으므로 표본을 넘기는 순서와도 무관합니다.
 */
public final class ExecutionTiming {

    private ExecutionTiming() {
    }

    /** 평균·구간을 내는 최소 주문 수(§14-2 M1). */
    public static final int MIN_ORDERS = 10;
    /** 평균·구간을 내는 최소 결정일 묶음 수(§14-2 M1). */
    public static final int MIN_DAYS = 5;
    /** 부트스트랩 반복 수. */
    public static final int RESAMPLES = 2000;
    /** 부트스트랩 씨앗 — 고정(같은 입력이면 같은 구간). */
    public static final long SEED = 20_261_030L;
    /** 구간 아래·위 분위(90% 구간). */
    public static final double LOW_QUANTILE = 0.05;
    public static final double HIGH_QUANTILE = 0.95;

    /**
     * 주문 하나의 표본.
     *
     * @param day    결정일 묶음 — 그 주문의 기준 거래일
     * @param id     주문 번호(같은 날 안의 순서를 정하는 데만 씀)
     * @param weight 금액 가중치(체결 금액) — 0보다 큰 유한한 수
     * @param bp     그 시점의 차이({@link #advantageBp})
     */
    public record Sample(LocalDate day, long id, double weight, double bp) {

        public Sample {
            Objects.requireNonNull(day, "결정일이 없습니다");
            if (!(weight > 0) || !Double.isFinite(weight)) {
                throw new IllegalArgumentException("금액 가중치는 0보다 큰 유한한 수여야 합니다: " + weight);
            }
            if (!Double.isFinite(bp)) {
                throw new IllegalArgumentException("차이(bp)가 유한한 수가 아닙니다: " + bp);
            }
        }
    }

    /**
     * 시점 하나의 요약.
     *
     * @param n      표본 주문 수
     * @param days   표본의 결정일 묶음 수
     * @param meanBp 금액 가중 평균 — 표본이 모자라면(클래스 설명) null
     * @param lowBp  90% 구간 아래 끝 — 표본이 모자라면 null
     * @param highBp 90% 구간 위 끝 — 표본이 모자라면 null
     */
    public record Summary(int n, int days, Double meanBp, Double lowBp, Double highBp) {
    }

    /**
     * 기준 가격 대비 그 시점 가격의 차이(bp, 클래스 설명의 식). 가격 하나라도 없거나 0 이하·유한하지 않으면 null — 없는 가격을 0으로
     * 셈하지 않습니다.
     *
     * @param sign 매수 +1 · 매도 −1
     * @throws IllegalArgumentException sign이 ±1이 아님
     */
    public static Double advantageBp(int sign, Double baseline, Double price) {
        if (sign != 1 && sign != -1) {
            throw new IllegalArgumentException("방향은 매수 +1·매도 −1입니다: " + sign);
        }
        if (!usable(baseline) || !usable(price)) {
            return null;
        }
        return sign * (baseline - price) / baseline * 10_000.0;
    }

    /** 표본 → 요약(클래스 설명). 빈 목록이면 n = 0·평균·구간 null. */
    public static Summary summarize(List<Sample> samples) {
        List<Sample> sorted = new ArrayList<>(samples);
        sorted.sort(Comparator.comparing(Sample::day).thenComparingLong(Sample::id));
        TreeMap<LocalDate, double[]> clusters = new TreeMap<>();   // 날짜 → {가중치 합, 가중치 × 차이 합}
        for (Sample s : sorted) {
            double[] sums = clusters.computeIfAbsent(s.day(), day -> new double[2]);
            sums[0] += s.weight();
            sums[1] += s.weight() * s.bp();
        }
        int n = sorted.size();
        int days = clusters.size();
        if (n < MIN_ORDERS || days < MIN_DAYS) {
            return new Summary(n, days, null, null, null);
        }
        double[][] byDay = clusters.values().toArray(new double[0][]);
        double mean = weightedMean(byDay, null);
        Random random = new Random(SEED);
        double[] means = new double[RESAMPLES];
        int[] picks = new int[days];
        for (int r = 0; r < RESAMPLES; r++) {
            for (int k = 0; k < days; k++) {
                picks[k] = random.nextInt(days);
            }
            means[r] = weightedMean(byDay, picks);
        }
        Arrays.sort(means);
        return new Summary(n, days, mean, quantile(means, LOW_QUANTILE), quantile(means, HIGH_QUANTILE));
    }

    /** 묶음 합으로 금액 가중 평균 — {@code picks}가 null이면 모든 묶음 한 번씩, 아니면 그 번호의 묶음(중복 포함). */
    private static double weightedMean(double[][] byDay, int[] picks) {
        double weight = 0;
        double weighted = 0;
        int count = picks == null ? byDay.length : picks.length;
        for (int k = 0; k < count; k++) {
            double[] sums = byDay[picks == null ? k : picks[k]];
            weight += sums[0];
            weighted += sums[1];
        }
        return weighted / weight;
    }

    /** 정렬된 값의 분위 — 순서 통계량 사이를 선형 보간(위치 (길이 − 1) × p). */
    private static double quantile(double[] sorted, double p) {
        double position = (sorted.length - 1) * p;
        int below = (int) Math.floor(position);
        int above = Math.min(below + 1, sorted.length - 1);
        return sorted[below] + (position - below) * (sorted[above] - sorted[below]);
    }

    private static boolean usable(Double price) {
        return price != null && Double.isFinite(price) && price > 0;
    }
}
