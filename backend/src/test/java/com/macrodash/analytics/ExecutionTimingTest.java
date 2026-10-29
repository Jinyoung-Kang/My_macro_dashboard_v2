package com.macrodash.analytics;

import com.macrodash.analytics.ExecutionTiming.Sample;
import com.macrodash.analytics.ExecutionTiming.Summary;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

/**
 * 체결 시점 비교의 계산({@link ExecutionTiming}, 명세 2026-10-30 §14-2) — 차이 bp의 방향, 표본 문턱(주문 10·결정일 5)에서 null, 금액 가중 평균,
 * 결정일 묶음 부트스트랩이 같은 입력·다른 순서에 같은 구간.
 */
class ExecutionTimingTest {

    private static final LocalDate D0 = LocalDate.of(2026, 11, 2);

    /** 결정일 {@code days}개에 주문 {@code perDay}건씩 — 날마다 차이가 다르고 금액도 다름(같은 씨앗의 무작위). */
    private static List<Sample> samples(int days, int perDay) {
        Random random = new Random(7);
        List<Sample> out = new ArrayList<>();
        long id = 1;
        for (int d = 0; d < days; d++) {
            double dayShift = random.nextGaussian() * 30;
            for (int k = 0; k < perDay; k++) {
                out.add(new Sample(D0.plusDays(d), id++, 1_000 + random.nextInt(9_000), dayShift + random.nextGaussian() * 50));
            }
        }
        return out;
    }

    @Test
    @DisplayName("차이 = s × (기준 − 시점) ÷ 기준 × 10⁴ — 매수는 더 싸게, 매도는 더 비싸게면 양수, 가격이 없거나 0 이하면 null")
    void advantageSignAndNulls() {
        assertThat(ExecutionTiming.advantageBp(1, 100.0, 99.0)).isCloseTo(100.0, within(1e-9));
        assertThat(ExecutionTiming.advantageBp(-1, 100.0, 101.0)).isCloseTo(100.0, within(1e-9));
        assertThat(ExecutionTiming.advantageBp(1, 100.0, 101.0)).isCloseTo(-100.0, within(1e-9));
        assertThat(ExecutionTiming.advantageBp(1, null, 99.0)).isNull();
        assertThat(ExecutionTiming.advantageBp(1, 100.0, null)).isNull();
        assertThat(ExecutionTiming.advantageBp(1, 0.0, 99.0)).isNull();
        assertThat(ExecutionTiming.advantageBp(1, 100.0, Double.NaN)).isNull();
        assertThatThrownBy(() -> ExecutionTiming.advantageBp(0, 100.0, 99.0)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("주문 10건 미만이거나 결정일 5일 미만이면 평균·구간 모두 null(0이 아님), 수는 그대로")
    void nullBelowThresholds() {
        Summary nine = ExecutionTiming.summarize(samples(9, 1));
        assertThat(nine).isEqualTo(new Summary(9, 9, null, null, null));
        Summary fourDays = ExecutionTiming.summarize(samples(4, 5));
        assertThat(fourDays).isEqualTo(new Summary(20, 4, null, null, null));
        assertThat(ExecutionTiming.summarize(List.of())).isEqualTo(new Summary(0, 0, null, null, null));

        Summary enough = ExecutionTiming.summarize(samples(5, 2));
        assertThat(enough.n()).isEqualTo(10);
        assertThat(enough.days()).isEqualTo(5);
        assertThat(enough.meanBp()).isNotNull();
        assertThat(enough.lowBp()).isNotNull().isLessThanOrEqualTo(enough.highBp());
    }

    @Test
    @DisplayName("평균은 금액 가중 — 큰 주문의 차이가 더 무겁다")
    void weightedMean() {
        List<Sample> list = new ArrayList<>();
        for (int d = 0; d < 5; d++) {
            list.add(new Sample(D0.plusDays(d), 2L * d, 9_000, 10.0));
            list.add(new Sample(D0.plusDays(d), 2L * d + 1, 1_000, -90.0));
        }
        Summary s = ExecutionTiming.summarize(list);
        assertThat(s.meanBp()).isCloseTo(0.0, within(1e-9));   // (9000×10 + 1000×(−90)) ÷ 10000
        assertThat(s.lowBp()).as("날마다 같은 묶음 — 어느 날을 뽑아도 평균 0").isCloseTo(0.0, within(1e-9));
        assertThat(s.highBp()).isCloseTo(0.0, within(1e-9));
    }

    @Test
    @DisplayName("부트스트랩은 결정적 — 같은 입력이면 같은 구간, 넘기는 순서를 섞어도 같은 구간, 구간은 평균을 감쌈")
    void bootstrapIsDeterministic() {
        List<Sample> list = samples(12, 3);
        Summary first = ExecutionTiming.summarize(list);
        Summary again = ExecutionTiming.summarize(list);
        List<Sample> shuffled = new ArrayList<>(list);
        Collections.shuffle(shuffled, new Random(99));
        Summary reordered = ExecutionTiming.summarize(shuffled);

        assertThat(again).isEqualTo(first);
        assertThat(reordered).isEqualTo(first);
        assertThat(first.lowBp()).isLessThan(first.meanBp());
        assertThat(first.highBp()).isGreaterThan(first.meanBp());
    }

    @Test
    @DisplayName("묶음은 결정일 — 같은 날 주문을 늘려도 묶음 수는 그대로, 날마다 차이가 크면 구간이 넓다")
    void clustersAreDecisionDays() {
        Summary few = ExecutionTiming.summarize(samples(6, 2));
        Summary many = ExecutionTiming.summarize(samples(6, 20));
        assertThat(few.days()).isEqualTo(6);
        assertThat(many.days()).isEqualTo(6);
        assertThat(many.n()).isEqualTo(120);
        assertThat(many.highBp() - many.lowBp()).as("날 사이 차이는 주문을 늘려도 줄지 않음").isGreaterThan(10.0);
    }

    @Test
    @DisplayName("표본은 결정일·0보다 큰 금액·유한한 차이만 받는다")
    void samplesAreValidated() {
        assertThatThrownBy(() -> new Sample(null, 1, 1, 1)).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> new Sample(D0, 1, 0, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Sample(D0, 1, Double.NaN, 1)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Sample(D0, 1, 1, Double.POSITIVE_INFINITY)).isInstanceOf(IllegalArgumentException.class);
    }
}
