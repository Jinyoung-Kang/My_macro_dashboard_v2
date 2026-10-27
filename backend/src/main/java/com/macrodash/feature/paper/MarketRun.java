package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * 🧪 실행 하나의 시장 문맥(2단계 명세 §9 묶음 A 리뷰 메모 'C1 — 시장 목록과 실행마다 달력 한 벌', C1a) — 시장 묶음 + 그 실행이 시작할 때
 * <b>한 번</b> 만든 달력 + 그 실행이 읽은 설정 행. 정기 작업 한 번(결정·리스크 점검·복기)과 조회 한 번(개요·상태·보유·책 요약)이
 * 시작할 때 {@link PaperMarkets#open}으로 하나 열어 장부·결정 파이프라인·조회에 넘깁니다. 그래서
 *
 * <ul>
 *   <li>한 실행 안의 달력 호출(세션 날짜·봉마다 확정 판정·만료·재진입 금지·보유 거래일)이 모두 같은 한 벌을 씁니다 — 한국 달력은
 *       공휴일 저장본·설정 판으로 만드는데(C1b), 실행 도중 저장본이나 설정이 바뀌어도 한 실행이 두 달력을 섞지 않습니다.</li>
 *   <li>결정 행의 {@code settings_version}·패킷·시스템 프롬프트·검증기·장부가 그 실행이 읽은 설정 판 하나입니다({@link #settingsRow})
 *       — 결정 작업이 시각을 정할 때와 Claude 결정을 남길 때 설정을 따로 읽어 그사이 저장한 판이 끼지 않게.</li>
 * </ul>
 *
 * <p>{@link PaperMarket}을 그대로 구현해 감싼 시장 묶음({@link #definition})에 맡깁니다 — 시장 묶음을 받던 코드가 실행을 받아도 그대로
 * 돌고, {@link #calendar()}만 그 실행의 달력입니다. <b>달력을 쓰는 기본 메서드</b>({@link #isFinal}·{@link #requireCalendarWindow})는
 * 이 실행의 달력으로 돕니다 — 시장 묶음이 그 기본 메서드를 덮어쓰면 여기서는 그 판을 부르지 않으므로, 시장마다 다른 판정은 달력을
 * 인자로 받는 메서드로 둡니다(C2의 확정 판정 나누기가 따를 규칙). 나머지 기본 메서드는 감싼 묶음의 것을 그대로 부릅니다.
 *
 * <p>시장 묶음을 받는 옛 경로(미국 판 시그니처·시험)는 {@link #of}로 고정 달력과 지금 설정 행의 실행을 그 자리에서 엽니다. 실행마다
 * 달력을 만드는 시장의 묶음은 고정 달력이 없어({@link PaperMarket#calendar()}가 던짐) 그 경로로는 돌 수 없습니다 — 실행을 넘겨야
 * 합니다. 값 객체라 같음은 동일성입니다(실행 둘은 늘 다름).
 */
final class MarketRun implements PaperMarket {

    /** 저장본 하나를 읽는 함수 — 실행을 여는 곳이 {@code StoreReader.quietly}로 감싸 넘깁니다(정기 작업이 수집을 깨우지 않게). */
    @FunctionalInterface
    interface Snapshots {
        Optional<Snapshot> read(String dataset, long maxAgeSeconds, String task);
    }

    /**
     * 실행의 달력을 만들 때 시장 묶음이 읽는 것({@link PaperMarket#openCalendar}).
     *
     * @param settingsBody 그 실행이 읽은 설정 본문(설정 행이 없으면 null — 읽는 쪽이 키마다 기본값)
     * @param snapshots    저장본 읽기(조용히 — 수집 요청 없음)
     */
    record Inputs(JsonNode settingsBody, Snapshots snapshots) {

        Inputs {
            Objects.requireNonNull(snapshots, "snapshots");
        }
    }

    private final PaperMarket market;
    private final TradingCalendar calendar;
    private final SettingsRow settingsRow;
    private final PaperSettings settings;

    /**
     * @param market      감싸는 시장 묶음(실행을 다시 감싸지 않음)
     * @param calendar    그 실행의 달력 한 벌
     * @param settingsRow 그 실행이 읽은 설정 행(행이 없으면 — 초기화 전·테이블 없음 — null)
     */
    MarketRun(PaperMarket market, TradingCalendar calendar, SettingsRow settingsRow) {
        Objects.requireNonNull(market, "market");
        if (market instanceof MarketRun) {
            throw new IllegalArgumentException("실행을 다시 실행으로 감싸지 않습니다: " + market);
        }
        this.market = market;
        this.calendar = Objects.requireNonNull(calendar, "calendar");
        this.settingsRow = settingsRow;
        this.settings = settingsRow == null ? PaperSettings.defaults(market)
                : PaperSettings.from(settingsRow.body(), market);
    }

    /**
     * 받은 시장 문맥이 이미 실행이면 그대로, 시장 묶음이면 고정 달력({@link PaperMarket#calendar()})과 지금 설정 행으로 실행 하나를
     * 엽니다(클래스 설명의 옛 경로). 테이블이 없으면 설정 행 없이 엽니다.
     *
     * @throws IllegalStateException 실행마다 달력을 만드는 시장의 묶음(고정 달력 없음 — 실행을 넘겨야 함)
     */
    static MarketRun of(PaperMarket market, PaperStore store) {
        if (market instanceof MarketRun run) {
            return run;
        }
        TradingCalendar fixed = market.calendar();
        return new MarketRun(market, fixed, store.ready() ? store.settings().orElse(null) : null);
    }

    /** 그 실행이 읽은 설정 행 — 행이 없으면(초기화 전) empty. */
    Optional<SettingsRow> settingsRow() {
        return Optional.ofNullable(settingsRow);
    }

    /** 그 실행이 읽은 설정 판 — 행이 없으면 null("판 0"을 지어내지 않음). */
    Integer settingsVersion() {
        return settingsRow == null ? null : settingsRow.version();
    }

    /** 그 실행이 읽은 설정 본문 — 행이 없으면 null(읽는 쪽이 키마다 기본값). */
    JsonNode settingsBody() {
        return settingsRow == null ? null : settingsRow.body();
    }

    /**
     * 장부가 읽는 값(슬리피지·스탑·재진입 금지·현금성) — 그 실행이 읽은 설정 행을 그 시장 접두어·현금성 기본값으로 읽은 것
     * ({@link PaperSettings#from(JsonNode, PaperMarket)}).
     */
    PaperSettings settings() {
        return settings;
    }

    @Override
    public PaperMarket definition() {
        return market;
    }

    /** 그 실행의 달력 한 벌(클래스 설명). */
    @Override
    public TradingCalendar calendar() {
        return calendar;
    }

    @Override
    public String toString() {
        return "MarketRun[" + market.code() + ", 설정 v" + settingsVersion() + "]";
    }

    // ------------------------------------------------------------------ 시장 묶음에 맡김
    @Override
    public String code() {
        return market.code();
    }

    @Override
    public String currency() {
        return market.currency();
    }

    @Override
    public String quotesDataset() {
        return market.quotesDataset();
    }

    @Override
    public String quotesTask() {
        return market.quotesTask();
    }

    @Override
    public Duration quotesLateAfter() {
        return market.quotesLateAfter();
    }

    @Override
    public String historyDataset() {
        return market.historyDataset();
    }

    @Override
    public Duration finalDelay() {
        return market.finalDelay();
    }

    @Override
    public List<PaperBooks.Definition> books() {
        return market.books();
    }

    @Override
    public Comparator<String> bookOrder() {
        return market.bookOrder();
    }

    @Override
    public String rulesBook() {
        return market.rulesBook();
    }

    @Override
    public String claudeBook() {
        return market.claudeBook();
    }

    @Override
    public String benchmarkBook() {
        return market.benchmarkBook();
    }

    @Override
    public String benchmarkOf(String bookCode) {
        return market.benchmarkOf(bookCode);
    }

    @Override
    public List<String> defaultCashLike() {
        return market.defaultCashLike();
    }

    @Override
    public double defaultMinOrderNotional() {
        return market.defaultMinOrderNotional();
    }

    @Override
    public List<String> timings() {
        return market.timings();
    }

    @Override
    public String earlyTiming() {
        return market.earlyTiming();
    }

    @Override
    public Map<String, String> timingNames() {
        return market.timingNames();
    }

    @Override
    public OrderValidator.Money money() {
        return market.money();
    }

    @Override
    public OrderValidator.Market orderValidation() {
        return market.orderValidation();
    }

    @Override
    public LocalTime defaultDecisionTime() {
        return market.defaultDecisionTime();
    }

    @Override
    public LocalTime defaultDeadline() {
        return market.defaultDeadline();
    }

    @Override
    public Instant decisionInstant(LocalDate session, LocalTime kstTime) {
        return market.decisionInstant(session, kstTime);
    }

    @Override
    public List<String> promptHardRules(JsonNode settingsBody) {
        return market.promptHardRules(settingsBody);
    }

    @Override
    public String promptFixedRules() {
        return market.promptFixedRules();
    }

    @Override
    public DayOfWeek reviewOpensOn() {
        return market.reviewOpensOn();
    }

    @Override
    public LocalTime reviewOpensAt() {
        return market.reviewOpensAt();
    }

    @Override
    public Instant reviewOpening(LocalDate weekEnding) {
        return market.reviewOpening(weekEnding);
    }

    @Override
    public String settingsPrefix() {
        return market.settingsPrefix();
    }

    @Override
    public String settingKey(String key) {
        return market.settingKey(key);
    }

    @Override
    public String jobPrefix() {
        return market.jobPrefix();
    }

    @Override
    public String jobName(String job) {
        return market.jobName(job);
    }
}
