package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * 시험용 달력 감싸개 — 받은 달력에 맡기고 불린 횟수를 셉니다. 실행마다 달력을 만드는 시험용 한국 묶음({@link TestKrMarket#perRun})의
 * 공장이 실행마다 새 감싸개를 만들어, "한 실행이 달력 한 벌만 만들고 그 한 벌을 실제로 썼는가"를 봅니다(C1a).
 */
final class CountingCalendar implements TradingCalendar {

    private final TradingCalendar delegate;
    private final AtomicInteger calls = new AtomicInteger();

    CountingCalendar(TradingCalendar delegate) {
        this.delegate = delegate;
    }

    /**
     * 실행을 열 때마다 서울 평일 달력({@link TestKrMarket#SEOUL_WEEKDAYS})의 새 감싸개를 만들어 {@code opened}에 남기는 공장 — 받은 재료
     * ({@link MarketRun.Inputs})는 {@code inputs}에 남깁니다.
     */
    static Function<MarketRun.Inputs, TradingCalendar> factory(List<CountingCalendar> opened,
                                                               List<MarketRun.Inputs> inputs) {
        return in -> {
            inputs.add(in);
            CountingCalendar calendar = new CountingCalendar(TestKrMarket.SEOUL_WEEKDAYS);
            opened.add(calendar);
            return calendar;
        };
    }

    /** 이 한 벌이 불린 횟수(기본 메서드가 부른 기본 판정까지). */
    int calls() {
        return calls.get();
    }

    @Override
    public ZoneId zone() {
        calls.incrementAndGet();
        return delegate.zone();
    }

    @Override
    public boolean isHoliday(LocalDate d) {
        calls.incrementAndGet();
        return delegate.isHoliday(d);
    }

    @Override
    public boolean isTradingDay(LocalDate d) {
        calls.incrementAndGet();
        return delegate.isTradingDay(d);
    }

    @Override
    public boolean isEarlyClose(LocalDate d) {
        calls.incrementAndGet();
        return delegate.isEarlyClose(d);
    }

    @Override
    public Instant openInstant(LocalDate tradingDate) {
        calls.incrementAndGet();
        return delegate.openInstant(tradingDate);
    }

    @Override
    public Instant closeInstant(LocalDate tradingDate) {
        calls.incrementAndGet();
        return delegate.closeInstant(tradingDate);
    }
}
