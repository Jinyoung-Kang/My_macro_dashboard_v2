package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.Arrays;
import java.util.Map;
import java.util.NavigableMap;
import java.util.TreeMap;

/**
 * 날짜 오름차순 일별 값 — 원시 배열 두 개(에포크 일수·값)로 압축해 들고 있는 읽기 전용 계열.
 *
 * <p>모의 매매는 유니버스 수백 종목의 10년 종가(종목당 약 2,500점)를 읽습니다. {@code TreeMap<LocalDate, Double>}로 들면
 * 점마다 객체 세 개(항목·날짜·Double)가 생겨 수십 MB가 됩니다. 저장소({@code StoreRepository.readTimeseriesColumns})가
 * 원시 배열로 주는 값을 그대로 받아 이진 탐색으로 찾습니다.
 *
 * <p><b>룩어헤드 방지</b>: 과거의 그날로 계산할 때는 {@link #until}로 그날까지 자른 계열만 넘기세요. 이 클래스는 '그날
 * 알 수 있었는지'를 모릅니다 — 관측일 기준입니다.
 *
 * <p>값이 없는 날은 점이 없습니다(0이나 NaN으로 채우지 않음). 그날 값이 없으면 {@link #valueOn}은 null이고,
 * 직전 값을 쓰려면 {@link #floorValue}를 고르세요 — 어느 쪽인지는 호출부가 정합니다.
 */
public final class DailySeries {

    private final int[] epochDays;
    private final double[] values;

    /**
     * @param epochDays {@link LocalDate#toEpochDay()} 값, 엄격히 오름차순(같은 날 두 점 금지)
     * @param values    같은 길이의 값
     * @throws IllegalArgumentException null이거나 길이가 다르거나 오름차순이 아니면
     */
    public DailySeries(int[] epochDays, double[] values) {
        if (epochDays == null || values == null) {
            throw new IllegalArgumentException("날짜·값 배열이 없습니다");
        }
        if (epochDays.length != values.length) {
            throw new IllegalArgumentException(
                    "날짜와 값의 길이가 다릅니다: " + epochDays.length + " ≠ " + values.length);
        }
        // 호출부가 배열을 나중에 바꿔도 이 계열은 바뀌지 않게 복사해 둔 뒤 검사합니다.
        this.epochDays = epochDays.clone();
        this.values = values.clone();
        for (int i = 1; i < this.epochDays.length; i++) {
            if (this.epochDays[i] <= this.epochDays[i - 1]) {
                throw new IllegalArgumentException("날짜가 엄격한 오름차순이 아닙니다: "
                        + LocalDate.ofEpochDay(this.epochDays[i - 1]) + " 다음 " + LocalDate.ofEpochDay(this.epochDays[i]));
            }
        }
    }

    /**
     * 날짜 → 값 맵에서. null 값은 건너뜁니다(없는 날로 봄). 맵의 정렬 순서와 상관없이 날짜 오름차순으로 담습니다.
     *
     * @param values null이면 빈 계열
     */
    public static DailySeries of(NavigableMap<LocalDate, Double> values) {
        if (values == null || values.isEmpty()) {
            return new DailySeries(new int[0], new double[0]);
        }
        // 역순 맵(descendingMap)을 넘겨도 맞게 담도록 자연 순서로 다시 정렬합니다.
        TreeMap<LocalDate, Double> sorted = new TreeMap<>();
        sorted.putAll(values);
        int[] days = new int[sorted.size()];
        double[] out = new double[sorted.size()];
        int n = 0;
        for (Map.Entry<LocalDate, Double> entry : sorted.entrySet()) {
            if (entry.getValue() != null) {
                days[n] = Math.toIntExact(entry.getKey().toEpochDay());
                out[n] = entry.getValue();
                n++;
            }
        }
        return new DailySeries(Arrays.copyOf(days, n), Arrays.copyOf(out, n));
    }

    public int size() {
        return values.length;
    }

    public boolean isEmpty() {
        return values.length == 0;
    }

    /** 첫 날짜. 비면 null. */
    public LocalDate firstDate() {
        return isEmpty() ? null : LocalDate.ofEpochDay(epochDays[0]);
    }

    /** 마지막 날짜. 비면 null. */
    public LocalDate lastDate() {
        return isEmpty() ? null : LocalDate.ofEpochDay(epochDays[epochDays.length - 1]);
    }

    /** 마지막 값. 비면 null. */
    public Double lastValue() {
        return isEmpty() ? null : values[values.length - 1];
    }

    /** 정확히 그날의 값. 그날 점이 없으면 null(직전 값으로 대신하지 않음). */
    public Double valueOn(LocalDate d) {
        long key = d.toEpochDay();
        if (key < Integer.MIN_VALUE || key > Integer.MAX_VALUE) {
            return null;
        }
        int index = Arrays.binarySearch(epochDays, (int) key);
        return index >= 0 ? values[index] : null;
    }

    /** 그날 또는 그 전 가장 가까운 날의 값. 그날 이전에 점이 없으면 null. */
    public Double floorValue(LocalDate d) {
        int index = floorIndex(d);
        return index < 0 ? null : values[index];
    }

    /** {@link #floorValue}가 쓴 날짜. 없으면 null. */
    public LocalDate floorDate(LocalDate d) {
        int index = floorIndex(d);
        return index < 0 ? null : LocalDate.ofEpochDay(epochDays[index]);
    }

    /** 그날(포함)까지 자른 계열. 그날 이전 점이 없으면 빈 계열. */
    public DailySeries until(LocalDate inclusive) {
        int count = floorIndex(inclusive) + 1;
        if (count == size()) {
            return this;    // 읽기 전용이라 그대로 돌려줘도 됩니다.
        }
        return new DailySeries(Arrays.copyOf(epochDays, count), Arrays.copyOf(values, count));
    }

    /** i번째(0부터) 날짜. 범위 밖이면 IndexOutOfBoundsException. */
    public LocalDate dateAt(int i) {
        return LocalDate.ofEpochDay(epochDays[i]);
    }

    /** i번째(0부터) 값. 범위 밖이면 IndexOutOfBoundsException. */
    public double valueAt(int i) {
        return values[i];
    }

    /** 그날 이하인 마지막 점의 위치. 없으면 −1. */
    private int floorIndex(LocalDate d) {
        long key = d.toEpochDay();
        if (key > Integer.MAX_VALUE) {
            return values.length - 1;
        }
        if (key < Integer.MIN_VALUE) {
            return -1;
        }
        int index = Arrays.binarySearch(epochDays, (int) key);
        return index >= 0 ? index : -index - 2;   // 삽입 위치(−index−1)의 바로 앞
    }

    @Override
    public String toString() {
        return "DailySeries[size=" + size() + ", first=" + firstDate() + ", last=" + lastDate() + "]";
    }
}
