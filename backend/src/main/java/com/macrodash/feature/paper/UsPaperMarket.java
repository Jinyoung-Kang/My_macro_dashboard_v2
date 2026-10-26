package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.ReviewFacts;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;

/**
 * 🧪 미국 책의 시장 묶음({@link PaperMarket}) — 값은 모두 이 묶음 전부터 있던 상수를 그대로 돌려줍니다(2단계 명세 §9 A4, 미국 숫자
 * 불변). 상수의 자리는 아직 원래 클래스이고, {@code UsPaperMarketTest}가 값 자체와 원래 상수가 같은지를 함께 고정합니다.
 *
 * <ul>
 *   <li>시장·통화 US·USD(V13 기본값), 달력 {@link UsMarketCalendar#CALENDAR}(뉴욕 세션 날짜)</li>
 *   <li>관측치 {@code paper.quotes}(수집기 태스크 {@code paper_quotes})·이력 {@code equity_close}, 확정 종가 = 마감 + 15분 뒤 수집</li>
 *   <li>책 넷({@link PaperBooks#ALL} — 규칙·Claude·SPY 100%·SPY 60/SHY 40), 비교 기준 {@code bench_spy}, 현금성 기본 SHY</li>
 *   <li>Claude 체결 시점 NEXT_OBSERVATION·NEXT_CLOSE(이른 시점 NEXT_OBSERVATION)</li>
 *   <li>결정 07:30·기한 12:00 KST, 세션 <b>다음 KST 날</b>의 그 시각(미국 마감이 KST 새벽이라)</li>
 *   <li>복기 토요일 09:00 KST, 설정 키·작업 기록 이름은 접두어 없이 지금 그대로</li>
 * </ul>
 */
final class UsPaperMarket implements PaperMarket {

    static final UsPaperMarket INSTANCE = new UsPaperMarket();

    private static final List<String> TIMINGS = List.of(OrderValidator.NEXT_OBSERVATION, OrderValidator.NEXT_CLOSE);

    /** 관측치를 채우는 수집기 태스크 — A5 전에는 {@code PaperMarketData.quotes()}·리스크 점검 안내 문구에 글자로 있던 이름. */
    private static final String QUOTES_TASK = "paper_quotes";

    private UsPaperMarket() {
    }

    @Override
    public String code() {
        return PaperStore.Book.MARKET_US;
    }

    @Override
    public String currency() {
        return PaperStore.Book.CURRENCY_USD;
    }

    @Override
    public TradingCalendar calendar() {
        return UsMarketCalendar.CALENDAR;
    }

    @Override
    public String quotesDataset() {
        return Datasets.SNAP_PAPER_QUOTES;
    }

    @Override
    public String quotesTask() {
        return QUOTES_TASK;
    }

    @Override
    public String historyDataset() {
        return Datasets.TS_EQUITY_CLOSE;
    }

    @Override
    public Duration finalDelay() {
        return PaperMarketData.FINAL_DELAY;
    }

    @Override
    public List<PaperBooks.Definition> books() {
        return PaperBooks.ALL;
    }

    @Override
    public String rulesBook() {
        return PaperBooks.RULES;
    }

    @Override
    public String claudeBook() {
        return PaperBooks.CLAUDE;
    }

    @Override
    public String benchmarkBook() {
        return PaperBooks.BENCH_SPY;
    }

    @Override
    public List<String> defaultCashLike() {
        return PaperSettings.DEFAULT_CASH_LIKE;
    }

    @Override
    public List<String> timings() {
        return TIMINGS;
    }

    @Override
    public String earlyTiming() {
        return OrderValidator.NEXT_OBSERVATION;
    }

    @Override
    public LocalTime defaultDecisionTime() {
        return PaperDecisionJob.DEFAULT_DECISION_TIME;
    }

    @Override
    public LocalTime defaultDeadline() {
        return PaperDecisionJob.DEFAULT_DEADLINE;
    }

    /** 세션 d 다음 KST 날의 그 시각 — 결정 작업의 결정 시각·기한, 사건 창({@code NewsEvents.window})의 cutoff와 같은 식. */
    @Override
    public Instant decisionInstant(LocalDate session, LocalTime kstTime) {
        return ZonedDateTime.of(session.plusDays(1), kstTime, Kst.ZONE).toInstant();
    }

    @Override
    public DayOfWeek reviewOpensOn() {
        return ReviewFacts.OPENS_ON;
    }

    @Override
    public LocalTime reviewOpensAt() {
        return ReviewFacts.OPENS_AT;
    }

    @Override
    public String settingsPrefix() {
        return "";
    }

    @Override
    public String jobPrefix() {
        return "";
    }
}
