package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * 시험용 한국 시장 묶음 — 시장 격리 시험(2단계 명세 §9 A5)이 "받은 시장의 책·달력·데이터셋만 쓰는가"를 보려고 씁니다. 실제 한국
 * 묶음(C1의 {@code KrPaperMarket})이 아니고 값도 정하지 않습니다: 달력은 주말만 쉬는 서울 09:00~15:30 장, 데이터셋·태스크 이름은
 * 시험용 가짜 이름(수집기에 없음), 책은 시험 접두어 {@code t_kr_} 하나.
 *
 * <p>미국과 일부러 갈리게 골랐습니다 — 서울 21:00(UTC 12:00)은 이 달력으로는 그날 세션의 확정 종가 뒤지만 미국 달력으로는 개장
 * 전(직전 세션)입니다. 장부가 미국 달력을 썼다면 세션·확정 여부·순자산 줄이 달라집니다.
 */
final class TestKrMarket implements PaperMarket {

    static final String CLAUDE_BOOK = "t_kr_claude";
    static final String QUOTES_DATASET = "test.kr.quotes";
    static final String QUOTES_TASK = "test_kr_quotes";
    static final String HISTORY_DATASET = "test.kr.history";
    /** 시험용 관측치 늦음 기준 — 미국 3시간과 일부러 다른 값(하루 한 번 수집하는 시장을 흉내). */
    static final Duration QUOTES_LATE = Duration.ofHours(26);
    /** 시험용 체결 시점 이름(검증기 근거 문구) — 미국 이름과 일부러 다른 글자. */
    static final String CLOSE_NAME = "시험용 종가";
    /** 시험용 금액 표기(원, 소수 없음) — 검증기 근거 문구에 '$'가 섞이지 않는지 보려고. */
    static final OrderValidator.Money MONEY = new OrderValidator.Money("", "원", 0);
    /** 시험용 시스템 프롬프트 고정 문단 — 미국 고정 문단과 일부러 다른 글자(줄 끝 공백·빈 줄은 렌더링이 정리). */
    static final String FIXED_RULES = "## 시험용 한국 고정(고정)   \n- 시험용 체결 시점 문장\n\n";

    /** 주말만 쉬는 서울 09:00~15:30 장(시험용 — 실제 KRX 달력 아님). */
    static final TradingCalendar SEOUL_WEEKDAYS = new TradingCalendar() {
        @Override
        public ZoneId zone() {
            return Kst.ZONE;
        }

        @Override
        public boolean isHoliday(LocalDate d) {
            return false;
        }

        @Override
        public boolean isTradingDay(LocalDate d) {
            DayOfWeek w = d.getDayOfWeek();
            return w != DayOfWeek.SATURDAY && w != DayOfWeek.SUNDAY;
        }

        @Override
        public boolean isEarlyClose(LocalDate d) {
            return false;
        }

        @Override
        public Instant openInstant(LocalDate tradingDate) {
            return ZonedDateTime.of(tradingDate, LocalTime.of(9, 0), Kst.ZONE).toInstant();
        }

        @Override
        public Instant closeInstant(LocalDate tradingDate) {
            return ZonedDateTime.of(tradingDate, LocalTime.of(15, 30), Kst.ZONE).toInstant();
        }
    };

    /** 주말만 쉬는 달력의 시험용 한국 묶음(아래 상수 뒤에 둬야 달력이 먼저 만들어짐). */
    static final TestKrMarket INSTANCE = new TestKrMarket(SEOUL_WEEKDAYS, null);

    /** 고정 달력 — 실행마다 달력을 만드는 판({@link #perRun})이면 null. */
    private final TradingCalendar calendar;
    /** 실행마다 달력을 만드는 함수({@link #perRun}) — 고정 달력 판이면 null. */
    private final Function<MarketRun.Inputs, TradingCalendar> perRun;

    private TestKrMarket(TradingCalendar calendar, Function<MarketRun.Inputs, TradingCalendar> perRun) {
        this.calendar = calendar;
        this.perRun = perRun;
    }

    /**
     * 실행마다 달력을 만드는 시험용 한국 묶음(C1a — 실제 한국 묶음 {@code KrPaperMarket}이 C1c에서 그렇게 됨): 고정 달력이 없어
     * {@link #calendar()}가 던지고, 실행을 열 때({@link PaperMarkets#open})만 {@code factory}가 달력을 만듭니다. 한 실행이 달력을 한
     * 벌만 쓰는지(실행 밖 경로가 달력을 묻지 않는지)를 보는 시험이 씁니다. 나머지는 {@link #INSTANCE}와 같습니다.
     */
    static TestKrMarket perRun(Function<MarketRun.Inputs, TradingCalendar> factory) {
        return new TestKrMarket(null, java.util.Objects.requireNonNull(factory));
    }

    /**
     * 달력만 바꾼 시험용 한국 묶음 — '달력 없음' 시험(명세 K35)이 공휴일 목록이 빠진 {@code KrxCalendar}를 넣습니다. 나머지(책·데이터셋·
     * 시각)는 {@link #INSTANCE}와 같습니다.
     */
    static TestKrMarket withCalendar(TradingCalendar calendar) {
        return new TestKrMarket(calendar, null);
    }

    /** 시험용 한국 책 한 권(운용 중) — 시장·통화가 KR·KRW. */
    static PaperStore.Book book(String code, double initialCash, LocalDate startedOn) {
        return new PaperStore.Book(code, PaperBooks.KIND_CLAUDE, code, initialCash, startedOn, PaperBooks.ACTIVE,
                PaperFixtures.FRI_CLOSE, PaperStore.Book.MARKET_KR, PaperStore.Book.CURRENCY_KRW);
    }

    @Override
    public String code() {
        return PaperStore.Book.MARKET_KR;
    }

    @Override
    public String currency() {
        return PaperStore.Book.CURRENCY_KRW;
    }

    @Override
    public TradingCalendar calendar() {
        if (calendar == null) {
            throw new IllegalStateException("시험용 한국 묶음(실행마다 달력) — 실행 문맥(MarketRun) 밖에서 달력을 물었습니다");
        }
        return calendar;
    }

    @Override
    public TradingCalendar openCalendar(MarketRun.Inputs inputs) {
        return perRun == null ? calendar() : perRun.apply(inputs);
    }

    @Override
    public String quotesDataset() {
        return QUOTES_DATASET;
    }

    @Override
    public String quotesTask() {
        return QUOTES_TASK;
    }

    /** 수집 + {@link #QUOTES_LATE} + 1초(미국 판과 같은 '나이가 그 시간을 넘음' 규칙). */
    @Override
    public Instant quotesLateAt(Instant collectedAt, LocalDate session, TradingCalendar calendar) {
        return collectedAt.plus(QUOTES_LATE).plusSeconds(1);
    }

    @Override
    public String historyDataset() {
        return HISTORY_DATASET;
    }

    @Override
    public Duration finalDelay() {
        return Duration.ofMinutes(15);
    }

    @Override
    public List<PaperBooks.Definition> books() {
        return List.of(new PaperBooks.Definition(CLAUDE_BOOK, PaperBooks.KIND_CLAUDE, "시험용 한국 Claude 계좌", Map.of()));
    }

    @Override
    public String rulesBook() {
        return CLAUDE_BOOK;
    }

    @Override
    public String claudeBook() {
        return CLAUDE_BOOK;
    }

    @Override
    public String benchmarkBook() {
        return CLAUDE_BOOK;
    }

    @Override
    public List<String> defaultCashLike() {
        return List.of();
    }

    /** 시험용 최소 주문 금액 기본값 — 미국 값과 같은 숫자(원)로 두어 앞선 시험의 검증 문구('최소 500원')를 그대로 둡니다. */
    @Override
    public double defaultMinOrderNotional() {
        return 500;
    }

    @Override
    public List<String> timings() {
        return List.of(PaperBooks.NEXT_CLOSE);
    }

    @Override
    public String earlyTiming() {
        return PaperBooks.NEXT_CLOSE;
    }

    @Override
    public Map<String, String> timingNames() {
        return Map.of(PaperBooks.NEXT_CLOSE, CLOSE_NAME);
    }

    @Override
    public OrderValidator.Money money() {
        return MONEY;
    }

    @Override
    public LocalTime defaultDecisionTime() {
        return LocalTime.of(22, 30);
    }

    @Override
    public LocalTime defaultDeadline() {
        return LocalTime.of(23, 30);
    }

    @Override
    public Instant decisionInstant(LocalDate session, LocalTime kstTime) {
        return ZonedDateTime.of(session, kstTime, Kst.ZONE).toInstant();
    }

    /** 시험용 하드 규칙 줄 — 받은 설정 본문의 한 키를 그대로 적어, 렌더링이 결정의 설정을 넘기는지 보이게. */
    @Override
    public List<String> promptHardRules(JsonNode settingsBody) {
        return List.of("- 시험용 한국 하드 규칙 — 최대 " + Json.asText(settingsBody, "maxPositions") + "종목",
                "- 시험용 한국 하드 규칙 둘째 줄");
    }

    @Override
    public String promptFixedRules() {
        return FIXED_RULES;
    }

    @Override
    public DayOfWeek reviewOpensOn() {
        return DayOfWeek.SATURDAY;
    }

    @Override
    public LocalTime reviewOpensAt() {
        return LocalTime.of(22, 30);
    }

    @Override
    public String settingsPrefix() {
        return "kr.";
    }

    @Override
    public String jobPrefix() {
        return "kr.";
    }
}
