package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.CalendarWindow;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * 🧪 모의 매매 시장 하나의 묶음 — 장부 코어가 시장마다 다르게 쓰는 값(달력·관측치·확정 판정·체결 시점·계좌 정의·결정 시각·
 * 복기 시각·통화·설정과 작업 기록의 이름)을 한곳에 둡니다(2단계 명세 2026-10-26-v2-kr-paper-spec.md §9 A4).
 *
 * <p>모든 것을 이 뒤로 보내지는 않습니다. 13F 선정·미국 패킷·게이트·일정/뉴스/재무 섹션은 자료부터 달라 미국 전용으로 남고, 한국은
 * 따로 만듭니다. 비용(수수료·세금)·출발일·초기 현금은 그것을 쓰는 묶음(B6·C1)에서 정합니다. 검증기의 체결 시점·금액 표기는 A7에서
 * 더했습니다({@link #orderValidation}).
 *
 * <p>구현은 미국({@link UsPaperMarket#INSTANCE} — 값은 이 묶음 전의 상수 그대로, {@code UsPaperMarketTest}가 고정)과 한국
 * ({@link KrPaperMarket#INSTANCE} — C1c, {@code KrPaperMarketTest})입니다. 장부·관측치·리스크 점검(A5)과 결정 작업·Claude 결정·주간 복기·메모·조회·관리(A6)가 시장마다 이 묶음으로 돕니다(시장
 * 목록 — 주입 빈 {@link PaperMarkets}) — Claude 시스템 프롬프트의 시장별 부분(하드 규칙 줄·고정 문단)과 복기 여는 순간도 여기서 받습니다.
 * 게이트 지표·13F 재선정·규칙 책 결정·출발일 사후 체결은 미국 전용 단계로 남습니다.
 *
 * <p><b>실행 문맥</b>(C1a): 정기 작업 한 번·조회 한 번은 시작할 때 이 묶음으로 {@link MarketRun}(그 실행의 달력 한 벌 + 읽은 설정 행)을
 * 하나 열어({@link PaperMarkets#open}) 장부·결정 파이프라인·조회에 넘깁니다. 실행도 이 인터페이스를 구현하므로 시장 묶음을 받던 코드가
 * 그대로 돌고, 미국 전용 단계 판정(동일성)은 {@link #definition()}으로 합니다.
 */
interface PaperMarket {

    /** 시장 코드 — {@code paper_books.market}(US·KR, V13)과 같은 문자열. */
    String code();

    /** 장부 통화 — {@code paper_books.currency}(USD·KRW, V13)와 같은 문자열. */
    String currency();

    /**
     * 세션 날짜를 정하고 체결·만료·재진입 금지·통계 표본을 세는 거래일 달력. 시장 묶음에서는 <b>고정 달력</b>(실행과 상관없이 늘 같음 —
     * 미국)이고, 실행({@link MarketRun})에서는 그 실행이 시작할 때 {@link #openCalendar}로 만든 한 벌입니다. 실행마다 저장본·설정
     * 판으로 달력을 만드는 시장(한국 — C1c의 KrPaperMarket)의 묶음은 고정 달력이 없어 이 메서드가 던집니다 — 실행 밖에서 달력을 물은 코드 오류입니다.
     *
     * @throws IllegalStateException 실행마다 달력을 만드는 시장의 묶음에 물음(실행 문맥을 넘기지 않은 코드)
     */
    TradingCalendar calendar();

    /**
     * 실행 하나의 달력을 만듭니다 — 실행을 열 때 한 번({@link PaperMarkets#open}). 기본은 고정 달력({@link #calendar()}) 그대로입니다.
     * 한국(C1c)은 그 실행이 조용히 읽은 공휴일 저장본({@code kr_holidays})과 그 실행이 읽은 설정 판(임시휴장)으로 새로 만듭니다 — 그래서
     * 한 실행 안의 달력 호출이 모두 같은 한 벌이고, 그 판이 결정 행의 {@code settings_version}과 같습니다.
     */
    default TradingCalendar openCalendar(MarketRun.Inputs inputs) {
        return calendar();
    }

    /**
     * 시장 묶음 자신(정의) — 실행({@link MarketRun})은 감싼 묶음을 돌려줍니다. 미국 전용 단계(게이트·13F·규칙 책 결정·미국 전용 칸)
     * 판정은 이 값과 {@link UsPaperMarket#INSTANCE}의 동일성으로 합니다(실행을 받아도 갈리지 않게).
     */
    default PaperMarket definition() {
        return this;
    }

    /**
     * 정기 작업이 앞으로 쓸 창의 거래일 수 — 주문 만료(기준일 + {@value RuleBookService#ORDER_EXPIRY_TRADING_DAYS}거래일)와 패킷 일정
     * 창({@code 1b_calendar}, 기준일 + {@value CalendarWindow#TRADING_DAYS}거래일) 중 긴 쪽(명세 §4-4·K35). 재진입 금지(체결일 + 설정 거래일, 기본 20)는
     * 설정 값이라 실행({@link MarketRun#requireCalendarWindow})이 그 실행 설정의 거래일만큼 창을 넓힙니다(묶음 C 리뷰 — 그 계산이 책 트랜잭션 안에서
     * 모르는 해에 닿아 장부 오류가 되지 않게).
     */
    int CALENDAR_WINDOW_TRADING_DAYS = Math.max(RuleBookService.ORDER_EXPIRY_TRADING_DAYS, CalendarWindow.TRADING_DAYS);

    /**
     * 정기 작업이 시작할 때 그 시장 달력이 앞으로 쓸 창(직전 세션 ~ 그 뒤 {@value #CALENDAR_WINDOW_TRADING_DAYS}거래일)이 걸친 해를
     * 아는지 확인합니다(명세 K35 — 앞 창의 해 목록이 없으면 그 시장 실행은 '달력 없음'으로 섬). 모르는 해에 닿으면 달력이 던진
     * {@link CalendarUnavailableException}이 그대로 나갑니다 — 작업은 그것을 작업 기록의 '달력 없음'으로 남깁니다
     * ({@link CalendarGaps}). 지난 해(통계 표본·보유 거래일)는 여기서 보지 않습니다 — 그 계산만 null + 사유(K35). 미국 달력은 늘 압니다.
     *
     * @throws CalendarUnavailableException 창이 걸친 해의 공휴일 목록이 없음
     */
    default void requireCalendarWindow(Instant now) {
        TradingCalendar calendar = calendar();
        calendar.addTradingDays(calendar.lastCompletedSession(now), CALENDAR_WINDOW_TRADING_DAYS);
    }

    /**
     * 정기 작업(리스크 점검·결정·주간 복기)이 이 시장을 건너뛰는 사유 — null이면 돕니다. 배포 설정·계좌가 갖춰지지 않은 시장은 실행을 열지
     * 않으므로(저장본을 읽지 않음) 작업 기록도 남기지 않습니다. 한국은 한국 계좌가 없거나, 출발일({@code dashboard.paper.kr.start-date})이 비었는데
     * 출발한(운용·일시정지) 한국 계좌도 없으면 쉽니다({@link KrPaperMarket#dormantReason} — 이 코드가 4단계 교체로 서버에 가도 한국 초기화 전에는
     * 한국 일이 하나도 돌지 않게, C1c; 출발한 뒤에는 출발일이 비어도 장부가 멈추지 않게 — 묶음 C 리뷰). 미국은 늘 돕니다(기본).
     *
     * @param books 그 시장 책 — 시장이 물을 때만 읽습니다(미국은 묻지 않음)
     */
    default String dormantReason(PaperConfig config, Supplier<List<PaperStore.Book>> books) {
        return null;
    }

    /** 장부 관측치 스냅샷의 데이터셋 — 그 관측치로 체결하면 체결 가격 출처({@code paper_fills.price_source})도 이 이름. */
    String quotesDataset();

    /** 관측치 스냅샷을 채우는 수집기 태스크 이름 — 저장본 읽기의 수집 요청 대상이고, '저장본 없음' 안내 문구에 들어갑니다. */
    String quotesTask();

    /**
     * 관측치 저장본({@link #quotesDataset}) 하나 → 관측치(결정 d10, C2a). 저장본 모양이 시장마다 달라 시장이 읽습니다 — 미국은
     * {@code paper.quotes}({@code tickers.{티커}.dates/close}, {@link PaperMarketData#parse} 그대로), 한국은 {@code paper.kr.quotes}
     * 계약 1(명세 §9 묶음 A 리뷰 메모 'B4·C2'). 수집 시각을 모르거나 쓸 수 있는 봉이 하나도 없으면 empty — 0이나 다른 날 값으로 채우지
     * 않습니다. {@link PaperMarketData#quotes(PaperMarket)}가 저장본을 읽어 이것으로 넘깁니다.
     */
    Optional<Quotes> parse(Snapshot snapshot);

    /**
     * 관측치 저장본이 '늦음'이 되는 순간 — 지금이 이 순간과 같거나 뒤면 화면(개요·상태의 관측치 요약)에 늦었다고 표시합니다. 그 시장
     * 관측치의 수집 주기에 맞춘 규칙이고(미국: 수집 + 3시간을 넘김, 한국: 다음 수집 예정 + 여유 — 명세 §4-9 'C1a에서 정한 것'), 달력은 그
     * 실행의 한 벌을 받습니다(시장마다 다른 판정은 달력을 인자로 — {@link MarketRun} 설명).
     *
     * @param collectedAt 저장본 수집 시각
     * @param session     저장본이 덮는 세션(저장본 머리의 값 — 모르면 null, 시장이 수집 시각으로 셈)
     * @param calendar    그 실행의 달력 한 벌
     * @throws CalendarUnavailableException 규칙이 달력이 모르는 해에 닿음(부르는 쪽이 늦음을 null + 사유로)
     */
    Instant quotesLateAt(Instant collectedAt, LocalDate session, TradingCalendar calendar);

    /** 종가 이력(timeseries)의 데이터셋 — 사후 체결·분할 감지·패킷 수익률. 그 이력으로 체결하면 가격 출처도 이 이름. */
    String historyDataset();

    // ------------------------------------------------------------------ 확정 판정 셋(결정 d9, C2a)
    // 옛 isFinal(봉 날짜, 수집 시각) 하나가 정하던 일을 셋으로 나눴습니다 — 한국은 ⓐ 밤 잠정 종가가 있음 ⓑ 그 체결 시점의 가격이 있음
    // ⓒ 금융위 확정이 갈리기 때문입니다(명세 §9 묶음 A 리뷰 메모 'C2·C3 — 확정 판정 나누기'). 미국은 셋 다 옛 isFinal 그대로입니다
    // (UsPaperMarketTest가 2025~2027 모든 날에서 대조). 시장마다 다른 판정이라 달력을 인자로 받고(MarketRun 설명의 규칙), 달력 없는
    // 판은 이 문맥의 달력으로 부르는 기본 메서드입니다.

    /**
     * 그 봉 날짜의 <b>종가가 나왔나</b>(ⓐ — 장중 값이 아님): 그 세션이 끝난 뒤(시장 규칙)에 수집한 저장본. 밤 순자산 줄 쓰기, 분할
     * 감지 기준가, 결정 작업의 '종가 관측치를 기다림'·미확정 순자산 줄, 복기 여는 조건, 관측치 요약의 {@code finalClose}, 저장본에서
     * 그날 종가 고르기가 씁니다. 지난 세션의 봉(휴장·거래 정지로 오늘 봉이 없음)은 마감이 이미 지났으므로 참입니다.
     *
     * @param calendar 그 실행의 달력 한 벌
     */
    boolean closeAvailable(LocalDate barDate, Instant collectedAt, TradingCalendar calendar);

    /** {@link #closeAvailable(LocalDate, Instant, TradingCalendar)}를 이 문맥의 달력({@link #calendar()} — 실행이면 그 실행의 한 벌)으로. */
    default boolean closeAvailable(LocalDate barDate, Instant collectedAt) {
        return closeAvailable(barDate, collectedAt, calendar());
    }

    /**
     * 그 주문을 그 봉으로 체결할 <b>가격이 그 시점에 있나</b>(ⓑ — 장부 체결 조건 ③). 장부가 공통 조건(① 수집 시각 &gt; 주문 생성 ② 봉
     * 날짜 &gt; 기준 거래일 ④ 이어 쓴 봉 아님)을 먼저 보고 이것을 묻습니다. 미국은 {@code NEXT_CLOSE}면 그 봉의 종가가 나왔을 때만
     * (옛 isFinal), 그 밖의 시점은 늘 참입니다.
     *
     * @param collectedAt 관측치 저장본의 수집 시각
     * @param calendar    그 실행의 달력 한 벌
     */
    boolean fillable(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar);

    /** {@link #fillable(Order, Bar, Instant, TradingCalendar)}를 이 문맥의 달력으로. */
    default boolean fillable(Order order, Bar bar, Instant collectedAt) {
        return fillable(order, bar, collectedAt, calendar());
    }

    /**
     * 체결 봉 고르기의 결과({@link #fillBar}) — 그 주문을 이 관측치로 체결할 봉, 또는 체결하지 않음.
     *
     * @param bar        체결할 봉(그 시장이 고른 날·가격을 담음 — 장부는 이 봉의 날짜를 체결 행의 관측일로 씀). null이면 이 관측치로는 체결하지 않음
     * @param waitReason 체결하지 않는 사유 중 사람이 알아야 할 것(한국 1분봉 기다림 등 — 장부가 작업 기록에 남김). 아직 새 봉이 없는 것처럼
     *                   늘 있는 기다림이면 null
     */
    record FillChoice(Bar bar, String waitReason) {

        /** 이 관측치로는 체결하지 않음(남길 사유 없음). */
        static final FillChoice NONE = new FillChoice(null, null);

        static FillChoice of(Bar bar) {
            return new FillChoice(java.util.Objects.requireNonNull(bar, "bar"), null);
        }

        static FillChoice waiting(String reason) {
            return new FillChoice(null, java.util.Objects.requireNonNull(reason, "reason"));
        }
    }

    /**
     * 그 주문을 그 관측치(그 종목의 봉)로 체결할 봉을 고릅니다 — 장부의 체결 조건 ①~④({@code PaperLedgerService} 설명). 기본(관측치 = 그날
     * 종가 하나 — 미국)은 그 봉 자신이고, 조건은 ① 관측치 수집 시각 &gt; 주문 생성 ④ 이어 쓴 봉 아님 ② 봉 날짜 &gt; 기준 거래일 ③ 그 시점의
     * 체결 가격({@link #fillable}) — C2b 전 장부의 {@code fillableBar} 그대로입니다. 한국은 최근 봉 창에서 기준 거래일 뒤 첫 관측 봉과 그날
     * 시가 사다리입니다({@code KrPaperMarket#fillBar}). 시장마다 다른 판정이라 달력을 인자로 받고, 실행({@link MarketRun})은 감싼 묶음에
     * 맡깁니다.
     *
     * @param collectedAt  관측치 저장본의 수집 시각
     * @param calendar     그 실행의 달력 한 벌
     * @param settingsBody 그 실행이 읽은 설정 본문(한국 1분봉 기다림의 끝 = 그 밤 결정 기한 — 결정 d11; null이면 기본값). 미국은 보지 않음
     */
    default FillChoice fillBar(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar,
                               JsonNode settingsBody) {
        if (order.createdAt() == null || !collectedAt.isAfter(order.createdAt())) {
            return FillChoice.NONE;                        // ① 주문 뒤에 수집한 관측치만
        }
        if (bar.stale()) {
            return FillChoice.NONE;                        // ④ 새 값이 없음 — 다음 관측치
        }
        if (order.asOfTradingDate() == null || !bar.date().isAfter(order.asOfTradingDate())) {
            return FillChoice.NONE;                        // ② 결정이 이미 본 봉(주말 재저장)
        }
        if (!fillable(order, bar, collectedAt, calendar)) {
            return FillChoice.NONE;                        // ③ 그 시점의 체결 가격이 아직 없음(미국: NEXT_CLOSE의 확정 종가 전)
        }
        return FillChoice.of(bar);
    }

    /**
     * 그 봉 날짜의 가격이 <b>확정</b>인가(ⓒ) — 순자산 줄의 {@code prices_final}, 결정 행·패킷의 {@code pricesFinal}이 씁니다. 미국은
     * 종가가 나왔으면 확정(옛 isFinal)입니다.
     *
     * @param calendar 그 실행의 달력 한 벌
     */
    boolean pricesConfirmed(LocalDate barDate, Instant collectedAt, TradingCalendar calendar);

    /** {@link #pricesConfirmed(LocalDate, Instant, TradingCalendar)}를 이 문맥의 달력으로. */
    default boolean pricesConfirmed(LocalDate barDate, Instant collectedAt) {
        return pricesConfirmed(barDate, collectedAt, calendar());
    }

    /**
     * 그 주문을 그 봉으로 체결하는 조건(결정 d10, C2a) — 체결가·관측가·가격 출처·슬리피지 기록값과 수량별 비용 칸. 장부가 체결 조건
     * ({@link #fillable})을 본 뒤 대기 주문마다, 그리고 관측치가 만든 즉시 주문(미국 트레일링 스탑 {@code IMMEDIATE})마다 부릅니다.
     * 미국은 관측 종가에 슬리피지를 얹은 체결가({@link FillTerms.SlippageInPrice} — 이 묶음 전 장부 식 그대로)입니다.
     *
     * @param settings 그 실행이 읽은 그 시장의 장부 설정(슬리피지 등)
     * @param calendar 그 실행의 달력 한 벌(한국 개장 봉 고르기 — 장 시간 변경일)
     */
    FillTerms fill(Order order, Bar bar, PaperSettings settings, TradingCalendar calendar);

    /**
     * 한 관측치 안 처리가 <b>시가 체결 장부</b>인가(한국 — 명세 §4-2: 만료 → 기업행위 → 시가 매도(STOP 포함) → 시가 매수 → 종가 매도 →
     * 종가 매수(현금성은 각 묶음 마지막) → 최고가·스탑 감지 → 평가). 기본(false)은 관측치 = 그날 종가 하나인 미국식(분할·가격 → 매도 →
     * 최고가·즉시 스탑 → 매수 → 평가)입니다. 장부({@code PaperLedgerService})가 이 값으로 경로를 고릅니다.
     */
    default boolean auctionFills() {
        return false;
    }

    /**
     * 장부가 관측치를 처리하기 전에 그 시장이 덧붙이는 종목 정보 — 기본은 그대로(미국). 한국은 금융위 시장 구분(비용 종목 구분, §4-3 —
     * 저장본에 없는 칸)입니다. 한 번의 처리에 한 번 부릅니다.
     */
    default Quotes withListings(Quotes quotes, PaperMarketData data) {
        return quotes;
    }

    /**
     * 시가 체결 장부({@link #auctionFills})가 책 하나를 처리할 때 한 번 읽는 확정 시세 — 스탑 재판정(감지한 날의 확정 종가)·최고가(KRX 기준가로만)·
     * 기업행위 판정의 상장 상태·미처리 기업행위 보유의 묶인 평가(2단계 명세 §4-2 K30·K32, C2c). 기본은 없음({@link KrConfirmed#NONE} — 미국 장부는
     * 부르지 않음). 한국은 금융위 주식시세·증권상품시세({@code KrPaperMarket#confirmedPrices}).
     *
     * @param codes    그 책의 보유·대기 주문 종목
     * @param settings 그 실행이 읽은 그 시장의 장부 설정(ETF 목록 — 현금성 종목)
     * @param from     읽을 가장 이른 기준일(보유가 반영한 마지막 관측·스탑을 감지한 날 중 가장 이른 날, 없으면 null)
     */
    default KrConfirmed confirmedPrices(PaperMarketData data, java.util.Collection<String> codes, PaperSettings settings,
                                        LocalDate from) {
        return KrConfirmed.NONE;
    }

    /**
     * 잠정 체결을 공식가로 확정 조정하는 시장인가(2단계 명세 K29, C3 — {@code KrConfirmations}). 참이면 장부가 관측치를 처리하기 전에(그리고
     * 리스크 점검이 새 관측치가 없는 주기에도) 확정 안 된 체결마다 공식가가 들어왔는지 보고 확정 조정 행·현금·평단을 씁니다. 기본(false)은
     * 확정 조정이 없는 시장(미국 — 체결가가 곧 관측치 종가)입니다. 확정가는 {@link #confirmedPrices}로 읽습니다.
     */
    default boolean confirmsFills() {
        return false;
    }

    /** 이 시장의 책 정의 — 초기화가 만드는 책이고, 화면에 보이는 순서입니다. */
    List<PaperBooks.Definition> books();

    /**
     * 이 시장 책 코드의 정의 순서({@link #books}의 순서 — 모르는 코드는 뒤, 코드 순). 장부·조회가 그 시장 책을 이 순서로 돌고
     * 보여 줍니다. 미국은 {@link PaperBooks#ORDER}와 같습니다.
     */
    default Comparator<String> bookOrder() {
        return PaperBooks.orderOf(books());
    }

    /** 규칙 책(동결 대조군)의 코드. */
    String rulesBook();

    /** Claude 책(실험군)의 코드. */
    String claudeBook();

    /** 통계(초과·베타)의 비교 기준 책 코드. */
    String benchmarkBook();

    /** 그 책의 비교 기준 책 — 기준 책 자신은 기준이 없습니다(null). */
    default String benchmarkOf(String bookCode) {
        return benchmarkBook().equals(bookCode) ? null : benchmarkBook();
    }

    /**
     * 설정에 현금성 종목 키(그 시장 접두어 + {@code cashLikeTickers})가 없을 때의 현금성 종목(스탑을 걸지 않고 비중 상한·종목 수·최소
     * 보유일에서 빠짐) — 장부·결정 파이프라인·검증기·프롬프트 하드 규칙·관리 리셋이 시장별 설정 읽기
     * ({@link PaperSettings#from(JsonNode, PaperMarket)}, 접두어 {@link #settingsPrefix})로 씁니다(C1a). 미국 SHY.
     */
    List<String> defaultCashLike();

    /**
     * 설정에 최소 주문 금액 키(그 시장 접두어 + {@code minOrderNotional})가 없을 때의 값 — 장부 통화 단위(미국 $500, 한국 500,000원 —
     * 명세 §4-7). 검증기 한도({@link PacketBuilder.Limits#from(JsonNode, PaperMarket)})의 기본값입니다.
     */
    double defaultMinOrderNotional();

    /** Claude가 고를 수 있는 체결 시점({@code paper_orders.timing}), 이른 것부터. */
    List<String> timings();

    /** 가장 이른 체결 시점 — 규칙 책 주문의 시점이고, 검증기가 '같은 시점 매도만 자리를 만든다'고 보는 시점. */
    String earlyTiming();

    /** 체결 시점({@link #timings}) → 검증기 근거 문구의 이름(미국 NEXT_OBSERVATION → 다음 관측치). 시점마다 하나. */
    Map<String, String> timingNames();

    /** 검증기 근거 문구의 금액 표기(장부 통화 — 미국 달러). */
    OrderValidator.Money money();

    /**
     * Claude 주문 검증의 시장 몫 — 받는 체결 시점({@link #timings})·이른 시점({@link #earlyTiming})·시점 이름·금액 표기(2단계
     * 명세 §9 A7). 결정 파이프라인이 이 값으로 {@link OrderValidator#validate(java.util.List, OrderValidator.Context,
     * OrderValidator.Limits, OrderValidator.Market)}를 부릅니다. 미국은 {@link OrderValidator.Market#US}와 같습니다.
     */
    default OrderValidator.Market orderValidation() {
        return new OrderValidator.Market(timings(), earlyTiming(), timingNames(), money());
    }

    /** 결정 시각(KST)의 기본값 — 설정 값이 없거나 틀릴 때. */
    LocalTime defaultDecisionTime();

    /** 확정 종가를 기다리는 기한(KST)의 기본값 — 설정 값이 없거나 틀릴 때. */
    LocalTime defaultDeadline();

    /**
     * 세션 날짜에 딸린 KST 시각의 순간 — 그 세션의 결정 시각·사건 창 끝이 이 식으로 순간이 됩니다(세션 날짜와 결정 시각의 관계가
     * 시장마다 달라서). 결정 기한은 결정 시각과의 관계까지 시장 규칙이라 {@link #deadlineInstant}로 셉니다.
     */
    Instant decisionInstant(LocalDate session, LocalTime kstTime);

    /**
     * 세션의 결정 기한 순간 — 그 실행이 읽은 결정 시각과 기한(설정 값, KST)으로(2단계 명세 §9 'D1·E2 — 결정 기한'). 결정 작업이 확정
     * 종가를 기다리는 끝입니다. 기한이 결정 시각과 어떤 관계일 때 무슨 순간인가가 시장마다 다릅니다 — 미국은 기한이 결정 시각보다
     * 앞이면 결정 시각(기다리지 않고 바로 진행 — 결정 작업의 예전 묶기 그대로).
     *
     * @param decisionTime 그 실행의 결정 시각(설정 값 — 없거나 틀리면 시장 기본값)
     * @param deadline     그 실행의 기한(설정 값 — 없거나 틀리면 시장 기본값)
     */
    Instant deadlineInstant(LocalDate session, LocalTime decisionTime, LocalTime deadline);

    /**
     * Claude 시스템 프롬프트의 하드 규칙 줄 — 코드가 집행하는 한도를 그 시장의 설정 읽기로 적은 것(검증기·장부와 같은 키). 렌더링
     * ({@link FrameworkService#render(PaperMarket, JsonNode, int, JsonNode)})이 '## 하드 규칙' 제목 아래에 이 줄을 그대로 넣습니다
     * (명세 K34 — 시장마다 한도 키·금액 표기가 다름).
     *
     * @param settingsBody 결정이 읽은 설정 본문(null이면 기본값으로 읽음 — 키마다 읽는 쪽과 같은 규칙)
     */
    List<String> promptHardRules(JsonNode settingsBody);

    /**
     * Claude 시스템 프롬프트 끝의 고정 문단(근거·출력·체결 시점 규칙) — 렌더링이 하드 규칙 줄 다음에 넣습니다(명세 K34). 미국은
     * {@link ClaudePrompts#FIXED_RULES} 그대로입니다(실험 중 시스템 프롬프트를 바꾸지 않음).
     */
    String promptFixedRules();

    /** 주간 복기가 열리는 요일(KST) — 시장별 코드 상수(명세 K38). */
    DayOfWeek reviewOpensOn();

    /** 주간 복기가 열리는 시각(KST) — 시장별 코드 상수(명세 K38). */
    LocalTime reviewOpensAt();

    /**
     * 그 주 복기가 열리는 순간 — 복기 기준일과 같은 ISO 주의 {@link #reviewOpensOn} {@link #reviewOpensAt}(KST). 미국은
     * {@code ReviewFacts.opensAt(weekEnding, Kst.ZONE)}(토요일 09:00)과 같습니다.
     */
    default Instant reviewOpening(LocalDate weekEnding) {
        return ZonedDateTime.of(weekEnding.with(reviewOpensOn()), reviewOpensAt(), Kst.ZONE).toInstant();
    }

    /** 설정 키의 접두어(같은 설정 한 행 안의 묶음). */
    String settingsPrefix();

    /** 이 시장의 설정 키 — 접두어 + 키. */
    default String settingKey(String key) {
        return settingsPrefix() + key;
    }

    /** 작업 기록 이름({@code paper_job_runs.job})의 접두어 — 시장마다 작업 기록을 따로 셉니다(작업마다 최근 200건). */
    String jobPrefix();

    /** 이 시장의 작업 기록 이름 — 접두어 + 작업 이름. */
    default String jobName(String job) {
        return jobPrefix() + job;
    }
}
