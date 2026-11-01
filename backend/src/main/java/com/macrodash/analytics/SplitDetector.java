package com.macrodash.analytics;

import java.util.Optional;

/**
 * 주식 분할·병합 감지(명세 L8, 설계 §3-4).
 *
 * <p>체결할 때 그날 종가를 참조값({@code fill_ref_close})으로 저장해 둡니다. 시계열은 수정주가라 분할이 일어나면 과거 값이
 * 분할 비율만큼 다시 쓰입니다. 그래서 '같은 날짜의 종가'가 지금 얼마로 보이는지와 참조값을 비교하면 분할을 알 수 있습니다:
 * 2:1 분할이면 참조일 종가 200이 100으로 다시 쓰여 r = 200/100 = 2.
 *
 * <p><b>±10% 안은 무시합니다.</b> 수정주가는 배당으로도 과거 값이 조금씩 내려가 r이 1보다 약간 커집니다(분기 배당 1%면
 * 1.01). 이것을 분할로 읽으면 배당 때마다 수량이 바뀝니다.
 *
 * <p><b>비율은 '가장 단순한' 분수로 읽습니다</b>(계약의 "가장 가까운 분수"와 다른 점). r의 연분수 수렴분수를 분모가 작은
 * 것부터 보며 상대 오차 3% 안인 첫 분수를 고릅니다. 분자·분모 ≤ 50 중 <b>가장 가까운</b> 분수를 고르면, 2:1 분할 뒤 배당
 * 조정으로 r = 2.04가 됐을 때 49/24(오차 0.08%)가 2/1(오차 2%)을 이겨 100주가 204주로 바뀝니다. 수렴분수는 r이 정확한
 * 분수(2, 1.5, 0.1, 1/40)면 그 분수를 그대로 돌려줍니다.
 *
 * <p>한계: 1/39와 1/40처럼 서로 3% 안에 있는 큰 비율은 잡음이 1% 넘게 끼면 구별하지 못합니다. 감지 결과는 split_note로
 * 남고 화면에 배지로 보입니다(수동 교정은 뒤 단계).
 */
public final class SplitDetector {

    private SplitDetector() {
    }

    /** 이 구간 안의 r은 배당 조정 등으로 보고 분할로 읽지 않습니다(포함). */
    private static final double BAND_LOW = 0.9;
    private static final double BAND_HIGH = 1.1;
    /** 분자·분모 상한. 1:50보다 큰 병합·50:1보다 큰 분할은 감지하지 않습니다. */
    private static final int MAX_TERM = 50;
    /** 고른 분수와 r의 상대 오차 상한. */
    private static final double TOLERANCE = 0.03;
    /** 연분수 항을 내림할 때 정수로 보는 여유. */
    private static final double INTEGER_SLACK = 1e-9;

    /**
     * 분할 비율. 2:1 분할 = Ratio(2, 1)(주식 수 2배, 가격 절반), 1:10 병합(역분할) = Ratio(1, 10).
     *
     * @throws IllegalArgumentException 분자·분모가 1 미만
     */
    public record Ratio(int numerator, int denominator) {
        public Ratio {
            if (numerator < 1 || denominator < 1) {
                throw new IllegalArgumentException("분할 비율은 양의 정수여야 합니다: " + numerator + ":" + denominator);
            }
        }

        /** 분자 / 분모. */
        public double value() {
            return (double) numerator / denominator;
        }

        /** "2:1" 꼴 — split_note·화면 배지용. */
        public String label() {
            return numerator + ":" + denominator;
        }
    }

    /**
     * r = refClose / currentCloseOnRefDate. 0.9 ≤ r ≤ 1.1이면 empty(배당 조정 등). 밖이면 분자·분모 ≤ 50이고 상대 오차
     * 3% 이내인 가장 단순한 분수(위 설명), 없으면 empty.
     *
     * @param refClose              체결 때 저장한 참조일 종가
     * @param currentCloseOnRefDate 지금 시계열에 보이는 같은 날짜의 종가
     * @return 값이 0 이하·NaN이면 판정하지 않고 empty(가격이 사라진 처리는 서비스의 price_stale)
     */
    public static Optional<Ratio> detect(double refClose, double currentCloseOnRefDate) {
        if (!(refClose > 0) || !(currentCloseOnRefDate > 0)
                || Double.isInfinite(refClose) || Double.isInfinite(currentCloseOnRefDate)) {
            return Optional.empty();
        }
        double r = refClose / currentCloseOnRefDate;
        if (r >= BAND_LOW && r <= BAND_HIGH) {
            return Optional.empty();
        }
        // 연분수 전개: h/k가 차례로 a0, a0+1/a1, … 의 수렴분수. h(−1)=1, h(−2)=0, k(−1)=0, k(−2)=1.
        long hPrev = 1;
        long hPrevPrev = 0;
        long kPrev = 0;
        long kPrevPrev = 1;
        double x = r;
        for (int step = 0; step < 64; step++) {
            // 0.07/2.8(정확히 1:40)의 역수가 double로 39.99999999999999가 되듯 정수 바로 밑으로 떨어지는 끝자리 오차를 올려 줍니다.
            // 안 그러면 1/39(오차 2.6%, 3% 안)가 먼저 잡혀 1:40이 1:39로 읽힙니다.
            double a = Math.floor(x + INTEGER_SLACK);
            long h = (long) a * hPrev + hPrevPrev;
            long k = (long) a * kPrev + kPrevPrev;
            if (h > MAX_TERM || k > MAX_TERM) {
                return Optional.empty();
            }
            // r < 1이면 첫 수렴분수가 0/1입니다 — 분할 비율이 아니므로 건너뜁니다.
            if (h >= 1 && Math.abs((double) h / k - r) / r <= TOLERANCE) {
                return Optional.of(new Ratio((int) h, (int) k));
            }
            double fraction = x - a;
            if (fraction < INTEGER_SLACK) {
                return Optional.empty();   // 전개가 끝났는데 3% 안이 없었음(마지막 수렴분수는 r 자신이라 사실상 오지 않음)
            }
            x = 1.0 / fraction;
            hPrevPrev = hPrev;
            hPrev = h;
            kPrevPrev = kPrev;
            kPrev = k;
        }
        return Optional.empty();
    }

    /**
     * 분할 뒤 수량 = floor(qty × 분자 / 분모). 단주는 버립니다 — 실제 증권사는 단주를 현금으로 정산하지만, 장부는 그 몫을
     * 생략합니다(한 주 미만의 가치라 순자산 차이가 작음). 1:10 병합에서 5주는 0주가 됩니다(보유 정리는 서비스가).
     */
    public static int adjustQty(int qty, Ratio r) {
        return Math.toIntExact(Math.floorDiv((long) qty * r.numerator(), (long) r.denominator()));
    }

    /** 분할 뒤 가격(평단·최고가) = price × 분모 / 분자. */
    public static double adjustPrice(double price, Ratio r) {
        return price * r.denominator() / r.numerator();
    }
}
