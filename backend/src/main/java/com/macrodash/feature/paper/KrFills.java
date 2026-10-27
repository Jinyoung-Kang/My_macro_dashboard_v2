package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.KrxCosts;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Choice;
import com.macrodash.feature.paper.KrQuotes.Day;
import com.macrodash.feature.paper.KrQuotes.Minute;
import com.macrodash.feature.paper.KrQuotes.Open;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.PaperMarket.FillChoice;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.store.PaperStore.Order;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * 🧪 한국 체결 — 체결 봉 고르기·시가 사다리·체결 조건(비용 칸)(2단계 명세 §4-1·§4-2·§4-3, 결정 d10·d11, C2b). 한국 시장 묶음
 * ({@link KrPaperMarket})이 이 함수들로 {@link PaperMarket#fillBar}·{@link PaperMarket#fillable}·{@link PaperMarket#fill}을 답합니다.
 *
 * <p><b>체결 봉</b>(조건 ①~④, 미국 {@code fillableBar}의 한국판): 그 종목 항목이 이번에 새로 받은 것이고(이어받은 {@code isStale}이 아님 — ④)
 * 그 종목을 받은 시각({@code fetchedAt})이 주문 생성보다 뒤일 때(①), 최근 봉 창에서 <b>기준 거래일 뒤 첫 관측 봉</b>(② 봉 날짜 &gt; 기준 거래일,
 * ④ 거래량 &gt; 0 — 0은 정지일, 모름은 체결이 있었는지 모름)입니다. 그 봉에 그 시점의 잠정가가 있어야 체결하고(③), 없으면 그 관측치로는
 * 체결하지 않고 다음 관측치를 기다립니다(다음 봉으로 건너뛰지 않음 — 그날 시가가 그 주문의 가격). 서버가 하룻밤 꺼졌던 뒤에도 그 주문은
 * 기준일 다음 거래일 시가로 체결됩니다(마지막 봉이 아니라 창에서 고름). 만료(기준일 + 3거래일)는 장부가 체결 전에 정리합니다.
 *
 * <p><b>시가 사다리</b>({@code NEXT_OPEN}, §4-1·K14): 1분봉 '개장 + 1분' 라벨 봉(그날 개장 시각은 그 실행의 달력 — 장 시간 변경일
 * {@code kr.calendar.openTimeOverrides}면 10:00 → {@code "10:01"})의 시가가 있고 그 봉 거래량이 0보다 크면 <b>반드시</b> 그 값
 * ({@code TOSS_1M_OPEN}). 그 라벨 봉이 없거나(NO_BAR·라벨 없음)·거래량이 0·모름이거나 1분봉을 받지 않은 봉이면 토스 일봉 시가로 내려가고 그 봉의
 * 출처를 답니다({@code TOSS_INTEGRATED} — NXT 종목은 08:00 프리마켓 첫 체결일 수 있음, KRX 단독 봉이면 {@code TOSS_DAILY}). 둘 다 잠정이고
 * 금융위 확정 때 고칩니다(K29, C3). 1분봉이 {@code FAILED}(호출 실패·'아직 묻지 못함' — 수집기가 같은 밤 다음 slow에 그 봉만 다시 물음)면
 * <b>기다립니다</b>(결정 d11) — 사다리로 내려가지 않습니다. 기다림의 끝은 벽시계가 아니라 <b>자료</b>입니다: 수집 시각이 그 봉 날짜 밤의 한국
 * 결정 기한(기본 D+1 01:00 — 그 실행 설정 판의 {@code kr.decisionDeadlineKst}) 이후인 저장본에도 FAILED면 사다리로 내려가고 사유를 남깁니다.
 * 기다리는 동안 그 주문은 대기라 결정 게이트 ①('앞 결정의 D 대상 주문이 정리됨')이 막힙니다(D1). {@code NEXT_CLOSE}는 토스 일봉 종가로
 * 체결하지 않습니다 — 1분봉 15:30 봉(G2)은 계약 1에 없고 {@link KrPaperMarket#ALLOW_NEXT_CLOSE}도 false라 그 주문은 만료됩니다.
 *
 * <p><b>체결 조건</b>(§4-3·K31): 체결가 = 관측가 그대로, 수수료·세금·슬리피지는 비용 칸({@link KrxCosts} — 칸마다 원 미만 절사), 수량은
 * 비용 포함 유출이 예산 안. 종목 구분은 설정 ETF 목록({@code kr.cashLikeTickers} + 벤치마크 종목) → ETF, 아니면 금융위 시장 구분
 * ({@code fsc_price.market} — 장부가 덧붙임)이 코스피·코스닥일 때만 주식이고, 코넥스·모르는 시장은 <b>주문 보류</b>({@link FillTerms.Hold} —
 * 세율을 짐작하지 않음, 주문은 대기로 남아 만료). 매도 체결일이 그 설정 판의 세율 시행일보다 이르면 같은 이유로 보류합니다. 관측가가
 * 호가 단위에 안 맞으면 경고만 남기고 값은 그대로 씁니다.
 */
final class KrFills {

    private KrFills() {
    }

    /**
     * 그 주문을 그 관측치로 체결할 봉(클래스 설명의 체결 봉) — 고른 날의 봉(날짜·종가 = 그날, 한국 칸에 고른 체결 {@link Choice})이나
     * 체결하지 않음(사람이 알아야 할 기다림이면 사유).
     *
     * @param deadline 봉 날짜 → 그 밤 한국 결정 기한(1분봉 FAILED 기다림의 끝 — 결정 d11)
     */
    static FillChoice choose(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar,
                             Function<LocalDate, Instant> deadline) {
        Quote quote = bar.kr();
        if (quote == null) {
            return FillChoice.waiting("한국 관측치 칸이 없는 봉 — 체결하지 않음");
        }
        if (bar.stale()) {
            return FillChoice.NONE;                        // ④ 이어받은 항목 — 이번 관측이 아님
        }
        if (order.createdAt() == null || quote.fetchedAt() == null || !quote.fetchedAt().isAfter(order.createdAt())) {
            return FillChoice.NONE;                        // ① 그 종목을 주문 뒤에 받은 관측치만
        }
        if (order.asOfTradingDate() == null) {
            return FillChoice.NONE;
        }
        for (Day day : quote.days()) {
            if (!day.date().isAfter(order.asOfTradingDate())) {
                continue;                                  // ② 결정이 이미 본 봉
            }
            if (order.expiresOn() != null && day.date().isAfter(order.expiresOn())) {
                return FillChoice.NONE;                    // 만료일 뒤의 봉(장부가 만료를 먼저 정리 — 방어)
            }
            if (!day.observed()) {
                continue;                                  // ④ 거래량 0(정지일)·모름 — 관측이 아님, 다음 봉
            }
            Ladder ladder = price(order, day, collectedAt, calendar, deadline);   // ③
            return ladder.choice() == null ? FillChoice.waiting(ladder.reason())
                    : FillChoice.of(view(bar, quote, day, ladder.choice()));
        }
        return FillChoice.NONE;
    }

    /**
     * 그 봉 날짜({@code bar.date()})에 그 주문 시점의 잠정가가 있는가(③ — {@link PaperMarket#fillable}). 기다림의 끝은 기본 결정 기한입니다
     * (설정 판을 받는 {@link #choose}가 장부의 경로).
     */
    static boolean fillable(Order order, Bar bar, Instant collectedAt, TradingCalendar calendar,
                            Function<LocalDate, Instant> deadline) {
        Quote quote = bar.kr();
        if (quote == null) {
            return false;
        }
        Optional<Day> day = quote.day(bar.date());
        return day.isPresent() && day.get().observed()
                && price(order, day.get(), collectedAt, calendar, deadline).choice() != null;
    }

    /**
     * 그 주문을 고른 봉으로 체결하는 조건(클래스 설명의 체결 조건). 고른 체결이 없는 봉이면 그 봉 날짜로 사다리를 다시 봅니다(아래 주석).
     *
     * @param etfs 설정 밖의 ETF 목록(벤치마크 종목) — 설정 현금성({@code kr.cashLikeTickers})과 함께 ETF로 셈
     * @throws IllegalArgumentException 한국 칸이 없는 봉, 고른 체결의 날짜가 봉 날짜와 다름
     * @throws IllegalStateException    설정에 한국 비용 요율이 없음(한국 시장 판으로 읽지 않은 설정)
     */
    static FillTerms terms(Order order, Bar bar, PaperSettings settings, TradingCalendar calendar,
                           Function<LocalDate, Instant> deadline, Set<String> etfs) {
        Quote quote = bar.kr();
        if (quote == null) {
            throw new IllegalArgumentException("한국 관측치 칸이 없는 봉입니다: " + bar.ticker());
        }
        Choice choice = quote.choice();
        if (choice == null) {
            // 체결 봉 고르기를 거치지 않은 봉 — 그 봉 날짜로 사다리를 다시 봅니다. 수집 시각 대신 그 종목을 받은 시각(그보다 이르거나 같음)으로
            // 1분봉 기다림의 끝을 보므로, 기한 근처에서는 기다리는 쪽(보류)으로만 갈립니다.
            Optional<Day> day = quote.day(bar.date());
            if (day.isEmpty() || !day.get().observed() || quote.fetchedAt() == null) {
                return new FillTerms.Hold(bar.date() + " 봉이 관측 봉이 아니거나(거래량 0·모름·없음) 그 종목을 받은 시각을 모름");
            }
            Ladder ladder = price(order, day.get(), quote.fetchedAt(), calendar, deadline);
            if (ladder.choice() == null) {
                return new FillTerms.Hold(ladder.reason());
            }
            choice = ladder.choice();
        }
        if (!choice.date().equals(bar.date())) {
            throw new IllegalArgumentException("고른 체결의 날짜(" + choice.date() + ")가 봉 날짜(" + bar.date() + ")와 다릅니다");
        }
        PaperSettings.CostRates costRates = settings.costRates();
        if (costRates == null) {
            throw new IllegalStateException("한국 비용 요율이 없는 설정입니다 — 한국 시장 판으로 읽은 설정을 넘기세요(PaperSettings.from(body, KR))");
        }
        String code = bar.ticker();
        boolean etf = settings.cashLike(code) || etfs.contains(code);
        Optional<KrxCosts.Instrument> instrument = KrxCosts.classify(quote.fscMarket(), etf);
        if (instrument.isEmpty()) {
            return new FillTerms.Hold("종목 구분 모름 — 금융위 시장 구분 "
                    + (quote.fscMarket() == null ? "없음(최신 기준일에 그 종목 행 없음)" : "'" + quote.fscMarket() + "'")
                    + "이고 ETF 목록(kr.cashLikeTickers·벤치마크)에도 없음: 세율·호가를 짐작하지 않고 주문 보류(코넥스·모르는 시장, §4-3)");
        }
        PaperLedger.Side side = PaperBooks.SELL.equals(order.side()) ? PaperLedger.Side.SELL : PaperLedger.Side.BUY;
        if (side == PaperLedger.Side.SELL && choice.date().isBefore(costRates.tax().effectiveFrom())) {
            return new FillTerms.Hold("세율 모름 — 매도 체결일 " + choice.date() + "이 이 설정 판의 세율 시행일(kr.tax.effectiveFrom "
                    + costRates.tax().effectiveFrom() + ")보다 이름(그 전 세율은 이 판에 없음 — 짐작하지 않고 주문 보류)");
        }
        List<String> warnings = new ArrayList<>();
        if (choice.note() != null) {
            warnings.add(choice.note());
        }
        if (!KrxCosts.onTick(instrument.get(), choice.price())) {
            warnings.add("호가 단위에 안 맞는 관측가 " + choice.price().stripTrailingZeros().toPlainString() + "원(호가 "
                    + KrxCosts.tickSize(instrument.get(), choice.price()).toPlainString() + "원) — 값 그대로 체결");
        }
        return new Terms(side, instrument.get(), choice.date(), choice.price(), choice.source(), settings.slippageBp(),
                costRates.rates(settings.slippageBp()), warnings);
    }

    /**
     * 그날의 1분봉 개장 봉 라벨 — 그 실행 달력의 그날 개장 시각 + 1분(봉 끝 시각, KST {@code "HH:mm"}). 수집기 저장본의 키({@code minute.opens})와
     * 글자로 맞추는 값이라 JVM 기본 로캘과 상관없이 ASCII 숫자입니다({@link Locale#ROOT} — 아랍어·페르시아어 로캘의 {@code formatted}는 그 지역 숫자를
     * 써서 조회가 늘 빗나갔음).
     */
    static String openLabel(LocalDate date, TradingCalendar calendar) {
        LocalTime open = calendar.openInstant(date).atZone(KrxCalendar.SEOUL).toLocalTime().plusMinutes(1);
        return String.format(Locale.ROOT, "%02d:%02d", open.getHour(), open.getMinute());
    }

    // ------------------------------------------------------------------ 시가 사다리
    /** 사다리 결과 — 체결(가격·출처·내려간 사유) 또는 기다림 사유. */
    private record Ladder(Choice choice, String reason) {

        static Ladder of(Choice choice) {
            return new Ladder(choice, null);
        }

        static Ladder waiting(String reason) {
            return new Ladder(null, reason);
        }
    }

    private static Ladder price(Order order, Day day, Instant collectedAt, TradingCalendar calendar,
                                Function<LocalDate, Instant> deadline) {
        if (PaperBooks.NEXT_CLOSE.equals(order.timing())) {
            return Ladder.waiting("NEXT_CLOSE는 1분봉 15:30 종가 단일가 봉으로만 체결 — 계약 1에 그 봉이 없고 G2 판정 전"
                    + "(ALLOW_NEXT_CLOSE=false)이라 토스 일봉 종가로 체결하지 않음(만료까지 대기)");
        }
        if (!PaperBooks.NEXT_OPEN.equals(order.timing())) {
            return Ladder.waiting("한국 체결 시점이 아님(" + order.timing() + ") — NEXT_OPEN만 체결(만료까지 대기)");
        }
        String label = openLabel(day.date(), calendar);
        Minute minute = day.minute();
        String fallback;
        if (minute == null) {
            fallback = day.date() + " 1분봉 개장 봉을 받지 않은 봉";
        } else if (KrQuotes.MINUTE_OK.equals(minute.status())) {
            Open open = minute.opens().get(label);
            if (open != null && open.open() != null && open.volume() != null && open.volume() > 0) {
                return Ladder.of(new Choice(day.date(), open.open(), KrQuotes.SOURCE_1M_OPEN, null));
            }
            fallback = day.date() + " 1분봉 " + label + " 봉 " + (open == null || open.open() == null ? "없음"
                    : open.volume() == null ? "거래량 모름" : "거래량 0");
        } else if (KrQuotes.MINUTE_NO_BAR.equals(minute.status())) {
            fallback = day.date() + " 1분봉 " + label + " 봉 없음(NO_BAR)";
        } else {
            // FAILED(호출 실패·'아직 묻지 못함')나 모르는 상태 — 수집기가 다시 묻는 중이라 기다림, 기한 뒤 수집본에도 남으면 사다리(결정 d11).
            Instant until = Objects.requireNonNull(deadline.apply(day.date()), "결정 기한");
            String why = day.date() + " 1분봉 개장 봉 " + minute.status()
                    + (minute.reason() == null || minute.reason().isBlank() ? "" : "(" + minute.reason() + ")");
            if (collectedAt.isBefore(until)) {
                return Ladder.waiting(why + " — 수집기가 다시 묻는 중이라 기다림(결정 기한 " + Kst.stamp(until)
                        + " 뒤 수집본에도 남으면 토스 일봉 시가로)");
            }
            fallback = why + "가 결정 기한 " + Kst.stamp(until) + " 뒤 수집본(" + Kst.stamp(collectedAt) + ")에도 남음";
        }
        if (day.open() == null) {
            return Ladder.waiting(fallback + " — 토스 일봉 시가도 없어 그날 체결 가격이 없음(만료까지 대기)");
        }
        String source = KrQuotes.SOURCE_DAILY.equals(day.priceSource()) ? KrQuotes.SOURCE_DAILY : KrQuotes.SOURCE_INTEGRATED;
        return Ladder.of(new Choice(day.date(), day.open(), source,
                fallback + " → 토스 일봉 시가 " + source + "(잠정 — 금융위 확정 때 고침)"));
    }

    /** 고른 날의 봉 — 날짜·종가는 그날(종가가 없으면 체결가), 한국 칸에 고른 체결. 이어받기 아님, 종가 이력은 그대로. */
    private static Bar view(Bar bar, Quote quote, Day day, Choice choice) {
        BigDecimal close = day.close() != null ? day.close() : choice.price();
        return new Bar(bar.ticker(), day.date(), close.doubleValue(), false, bar.recent(), quote.withChoice(choice));
    }

    // ------------------------------------------------------------------ 체결 조건
    /**
     * 한국 체결 조건 — 체결가 = 관측가(K31), 비용 칸은 {@link KrxCosts}(칸마다 원 미만 절사), 매수 가능 수량은 수수료·슬리피지를 포함한
     * 유출(절사 뒤)이 예산 이하인 최대 정수 주.
     *
     * @param slippageBp 슬리피지 설정값의 기록({@code paper_fills.slippage_bp})
     * @param warnings   사다리를 내려간 사유·호가 경고
     */
    record Terms(PaperLedger.Side side, KrxCosts.Instrument instrument, LocalDate tradeDate, BigDecimal observed,
                 String priceSource, double slippageBp, KrxCosts.Rates rates, List<String> warnings) implements FillTerms {

        Terms {
            Objects.requireNonNull(side, "side");
            Objects.requireNonNull(instrument, "instrument");
            Objects.requireNonNull(tradeDate, "tradeDate");
            Objects.requireNonNull(observed, "observed");
            Objects.requireNonNull(priceSource, "priceSource");
            Objects.requireNonNull(rates, "rates");
            warnings = List.copyOf(warnings);
        }

        @Override
        public double price() {
            return observed.doubleValue();
        }

        @Override
        public double rawPrice() {
            return observed.doubleValue();
        }

        /** 예산(원)으로 살 수 있는 정수 주 — 예산이 0 이하·유한하지 않으면 0. */
        @Override
        public int affordableQty(double budget) {
            if (!(budget > 0) || Double.isInfinite(budget)) {
                return 0;
            }
            return KrxCosts.affordableQty(BigDecimal.valueOf(budget), observed, rates);
        }

        @Override
        public Costs costs(int qty) {
            KrxCosts.Costs costs = KrxCosts.fill(side, instrument, tradeDate, qty, observed, rates);
            return new Costs(costs.notional().doubleValue(), costs.commission(), costs.tax(), costs.slippage(),
                    costs.cashFlow().doubleValue());
        }
    }
}
