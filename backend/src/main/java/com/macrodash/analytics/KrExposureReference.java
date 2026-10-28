package com.macrodash.analytics;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 🧪 한국 규칙 계좌의 노출 맞춘 참고선(2단계 명세 §3·K40, F2) — 계산만 하는 선이고 계좌가 아닙니다. 규칙 계좌 결과는 종목 신호와 주식 노출
 * (후보가 모자란 만큼 153130)이 섞인 값이라, 같은 주식 비중을 지수(069500)와 단기채(153130)로 들었을 때의 선을 함께 그려 신호 몫을 가릅니다.
 *
 * <pre>
 *   ref_S = 규칙 계좌 출발 순자산(출발일 S의 순자산 줄)
 *   ref_t = ref_{t−1} × (1 + x_{t−1}·r069500_t + (1 − x_{t−1})·r153130_t)
 * </pre>
 *
 * <ul>
 *   <li>{@code t−1} = 날짜 줄(순자산 곡선의 거래일)의 바로 앞 날, {@code x_{t−1}} = 그날 규칙 계좌 주식 비중(%/100 — 부르는 쪽이 그날 결정의
 *       보유 비중 합에서 현금성을 뺀 값을 넘김, 명세 '전날 규칙 계좌 주식 비중' 글자 그대로). 출발일 S는 보유가 없어 0입니다.</li>
 *   <li>{@code r} = 금융위 증권상품시세 확정 종가의 날 대 날 수익률({@code close_t ÷ close_{t−1} − 1}). 비용은 넣지 않습니다.</li>
 *   <li>값은 원 단위 정수(반올림), 주식 비중은 그날 값에 쓴 앞 날의 비중(소수 2자리).</li>
 * </ul>
 *
 * <p><b>빈 자료(가장 보수적인 안 — 없는 숫자를 만들지 않음)</b>: 앞 날의 비중이나 두 날의 종가 중 하나라도 없으면 그날부터 끝까지 null이고 그 사유
 * ({@link Result#stoppedReason})를 남깁니다 — 앞 값으로 이어 쓰거나 다른 날의 비중으로 채우지 않습니다. 다만 금융위가 아직 내지 않은 날
 * ({@code etfLatest} 뒤 — 보통 마지막 하루, 다음 영업일 13시 공개)은 멈춤이 아니라 그날만 값 없음입니다(들어오면 다음 조회에서 이어짐).
 */
public final class KrExposureReference {

    /** 주식 몫 — KODEX 200. */
    public static final String STOCK_ETF = "069500";
    /** 나머지 몫 — KODEX 단기채권(규칙 계좌의 현금성). */
    public static final String BOND_ETF = "153130";

    private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);
    private static final MathContext MC = MathContext.DECIMAL64;

    private KrExposureReference() {
    }

    /**
     * 날짜 줄과 같은 길이의 결과.
     *
     * @param values         원 단위 정수 값(그날 값이 없으면 null)
     * @param stockWeightPct 그날 값에 쓴 앞 날의 규칙 계좌 주식 비중(%) — 출발일·값 없는 날은 null
     * @param asOfDate       값이 있는 마지막 날(없으면 null)
     * @param stoppedReason  빈 자료로 멈췄으면 그 사유(그날부터 끝까지 null), 아니면 null
     */
    public record Result(List<Long> values, List<BigDecimal> stockWeightPct, LocalDate asOfDate, String stoppedReason) {

        public Result {
            values = Collections.unmodifiableList(new ArrayList<>(values));
            stockWeightPct = Collections.unmodifiableList(new ArrayList<>(stockWeightPct));
        }
    }

    /**
     * @param dates       날짜 줄(오름차순 — 순자산 곡선의 거래일)
     * @param start       규칙 계좌 출발일 S
     * @param startNav    S의 규칙 계좌 순자산(모르면 null — 전부 값 없음 + 사유)
     * @param weights     거래일 → 그날 규칙 계좌 주식 비중(%, 0~100). 모르는 날은 키가 없습니다
     * @param stockCloses 거래일 → 069500 금융위 확정 종가
     * @param bondCloses  거래일 → 153130 금융위 확정 종가
     * @param etfLatest   금융위 증권상품시세의 저장된 최신 기준일(그 뒤 날은 아직 공개 전 — null이면 아무 날도 받지 않음)
     */
    public static Result compute(List<LocalDate> dates, LocalDate start, BigDecimal startNav, Map<LocalDate, BigDecimal> weights,
                                 Map<LocalDate, BigDecimal> stockCloses, Map<LocalDate, BigDecimal> bondCloses,
                                 LocalDate etfLatest) {
        Objects.requireNonNull(dates, "dates");
        Objects.requireNonNull(start, "start");
        List<Long> values = new ArrayList<>(Collections.nCopies(dates.size(), null));
        List<BigDecimal> used = new ArrayList<>(Collections.nCopies(dates.size(), null));
        int base = dates.indexOf(start);
        if (base < 0 || startNav == null || startNav.signum() <= 0) {
            return new Result(values, used, null, "규칙 계좌 출발일(" + start + ")의 순자산 줄이 없어 참고선의 기준이 없습니다");
        }
        BigDecimal ref = startNav;
        values.set(base, whole(ref));
        LocalDate previous = start;
        LocalDate asOf = start;
        String stopped = null;
        for (int i = base + 1; i < dates.size() && stopped == null; i++) {
            LocalDate day = dates.get(i);
            if (etfLatest == null || day.isAfter(etfLatest)) {
                continue;   // 금융위가 아직 내지 않은 날 — 멈춤이 아니라 그날 값 없음(보통 마지막 하루)
            }
            // 출발일 S의 규칙 계좌는 현금만 듭니다(S 밤 출발 결정의 주문은 S+1 시가에 체결) — S의 비중은 늘 0입니다(결정 행과 상관없는 사실).
            BigDecimal weight = previous.equals(start) ? BigDecimal.ZERO : weights.get(previous);
            if (weight == null) {
                stopped = previous + " 규칙 계좌 주식 비중을 모릅니다(그날 규칙 계좌 결정의 보유 비중이 없음 — 기한 지남·일시정지·비중 모름 등)"
                        + " — 그 뒤는 그리지 않습니다";
                break;
            }
            if (weight.signum() < 0 || weight.compareTo(HUNDRED) > 0) {
                stopped = previous + " 규칙 계좌 주식 비중 " + weight.toPlainString() + "%가 0~100% 밖입니다 — 그 뒤는 그리지 않습니다";
                break;
            }
            BigDecimal stockReturn = dayReturn(stockCloses, previous, day);
            BigDecimal bondReturn = dayReturn(bondCloses, previous, day);
            if (stockReturn == null || bondReturn == null) {
                stopped = day + " 금융위 ETF 확정 종가(" + (stockReturn == null ? STOCK_ETF : BOND_ETF) + ")가 " + previous + "·" + day
                        + " 중에 없습니다 — 그 뒤는 그리지 않습니다";
                break;
            }
            BigDecimal x = weight.divide(HUNDRED, MC);
            BigDecimal growth = BigDecimal.ONE.add(x.multiply(stockReturn, MC), MC)
                    .add(BigDecimal.ONE.subtract(x, MC).multiply(bondReturn, MC), MC);
            ref = ref.multiply(growth, MC);
            values.set(i, whole(ref));
            used.set(i, weight.setScale(2, RoundingMode.HALF_UP));
            previous = day;
            asOf = day;
        }
        return new Result(values, used, asOf, stopped);
    }

    /** {@code close_day ÷ close_previous − 1} — 둘 중 하나라도 없거나 양수가 아니면 null. */
    private static BigDecimal dayReturn(Map<LocalDate, BigDecimal> closes, LocalDate previous, LocalDate day) {
        BigDecimal before = closes.get(previous);
        BigDecimal after = closes.get(day);
        if (before == null || after == null || before.signum() <= 0 || after.signum() <= 0) {
            return null;
        }
        return after.divide(before, MC).subtract(BigDecimal.ONE, MC);
    }

    private static Long whole(BigDecimal value) {
        return value.setScale(0, RoundingMode.HALF_UP).longValueExact();
    }
}
