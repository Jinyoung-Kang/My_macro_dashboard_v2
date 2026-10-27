package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.ReviewFacts;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 미국 책의 시장 묶음({@link PaperMarket}) — 값은 모두 이 묶음 전부터 있던 상수를 그대로 돌려줍니다(2단계 명세 §9 A4, 미국 숫자
 * 불변). 상수의 자리는 아직 원래 클래스이고, {@code UsPaperMarketTest}가 값 자체와 원래 상수가 같은지를 함께 고정합니다.
 *
 * <ul>
 *   <li>시장·통화 US·USD(V13 기본값), 달력 {@link UsMarketCalendar#CALENDAR}(뉴욕 세션 날짜)</li>
 *   <li>관측치 {@code paper.quotes}(수집기 태스크 {@code paper_quotes}, 3시간 넘게 묵으면 늦음)·이력 {@code equity_close}, 확정 판정 셋
 *       (종가 나옴·그 시점 가격 있음·확정 — C2a)은 모두 옛 isFinal = 마감 + 15분 뒤 수집</li>
 *   <li>책 넷({@link PaperBooks#ALL} — 규칙·Claude·SPY 100%·SPY 60/SHY 40), 비교 기준 {@code bench_spy}, 현금성 기본 SHY, 최소 주문
 *       기본 $500</li>
 *   <li>Claude 체결 시점 NEXT_OBSERVATION·NEXT_CLOSE(이른 시점 NEXT_OBSERVATION), 검증기 시점 이름·금액 표기는
 *       {@link OrderValidator.Market#US}(다음 관측치·확정 종가, 달러) 그대로</li>
 *   <li>결정 07:30·기한 12:00 KST, 세션 <b>다음 KST 날</b>의 그 시각(미국 마감이 KST 새벽이라)</li>
 *   <li>복기 토요일 09:00 KST, 설정 키·작업 기록 이름은 접두어 없이 지금 그대로</li>
 *   <li>Claude 시스템 프롬프트의 하드 규칙 줄은 지금 렌더링의 줄({@code FrameworkService.hardRules}), 고정 문단은
 *       {@link ClaudePrompts#FIXED_RULES} — A6 전 렌더링과 글자 그대로</li>
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

    /** {@code paper.quotes}의 미국 모양 — {@link PaperMarketData#parse} 그대로(결정 d10 — 이 묶음 전 파서, 고정본 바이트 그대로). */
    @Override
    public Optional<Quotes> parse(Snapshot snapshot) {
        return PaperMarketData.parse(snapshot);
    }

    /**
     * 수집 + {@link PaperQueryService#QUOTES_LATE}(3시간) + 1초 — 저장본 나이를 초로 버려 세어 3시간을 넘으면 늦음이던 규칙(C1c 전 화면
     * 계산)과 같은 순간입니다(나이 ≥ 3시간 1초 ⇔ 버린 초 &gt; 3시간). 달력·세션은 보지 않습니다.
     */
    @Override
    public Instant quotesLateAt(Instant collectedAt, LocalDate session, TradingCalendar calendar) {
        return collectedAt.plus(PaperQueryService.QUOTES_LATE).plusSeconds(1);
    }

    @Override
    public String historyDataset() {
        return Datasets.TS_EQUITY_CLOSE;
    }

    /**
     * 봉 날짜가 거래일이고 저장본을 그날 마감 + {@link PaperMarketData#FINAL_DELAY}(15분) 이후에 수집함 — 옛 {@code isFinal} 그대로
     * (C2a — 셋으로 나누기 전 판정 식, {@code UsPaperMarketTest}가 2025~2027 모든 날에서 대조).
     */
    @Override
    public boolean closeAvailable(LocalDate barDate, Instant collectedAt, TradingCalendar calendar) {
        return calendar.isTradingDay(barDate)
                && !collectedAt.isBefore(calendar.closeInstant(barDate).plus(PaperMarketData.FINAL_DELAY));
    }

    /** {@code NEXT_CLOSE}면 그 봉의 종가가 나왔을 때만({@link #closeAvailable}), 그 밖의 시점(NEXT_OBSERVATION)은 늘 — 옛 체결 조건 ③ 그대로. */
    @Override
    public boolean fillable(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar) {
        return !PaperBooks.NEXT_CLOSE.equals(order.timing()) || closeAvailable(bar.date(), collectedAt, calendar);
    }

    /** 종가가 나왔으면 확정({@link #closeAvailable}) — 미국은 잠정·확정 가격이 따로 없습니다(옛 {@code isFinal} 그대로). */
    @Override
    public boolean pricesConfirmed(LocalDate barDate, Instant collectedAt, TradingCalendar calendar) {
        return closeAvailable(barDate, collectedAt, calendar);
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
    public double defaultMinOrderNotional() {
        return PacketBuilder.Limits.DEFAULT_MIN_ORDER_NOTIONAL;
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
    public Map<String, String> timingNames() {
        return OrderValidator.Market.US.timingNames();
    }

    @Override
    public OrderValidator.Money money() {
        return OrderValidator.Money.USD;
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
    public List<String> promptHardRules(JsonNode settingsBody) {
        return FrameworkService.hardRules(this, settingsBody);
    }

    @Override
    public String promptFixedRules() {
        return ClaudePrompts.FIXED_RULES;
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
