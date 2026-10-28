package com.macrodash.feature.paper;

import com.macrodash.analytics.ReviewFacts.EntryOpen;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Day;
import com.macrodash.feature.paper.KrQuotes.Minute;
import com.macrodash.feature.paper.KrQuotes.Open;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 🧪 한국 주간 복기의 가정 진입 시가(2단계 명세 §9 'E3 — 복기의 가정 진입가', 사용자 결정 v5) — 종목 → 세션 날짜 → 시가·출처.
 * 거절 주문은 결정 다음 세션 시가({@code NEXT_OPEN})에 체결됐다고 가정합니다({@code ReviewFacts.Entry.NEXT_OPEN}). 시가가 없는 날은 이 표에
 * 없고, 복기 입력이 그 세션 종가로 근사해 {@code isProxy}를 답니다.
 *
 * <p><b>출처 순서</b>(날마다):
 * <ol>
 *   <li>금융위 확정 시가 — 주식시세 {@code mkp}·증권상품시세 시가({@link KrConfirmed.Day#open}, 출처 {@code FSC}·{@code FSC_ETF}). 금융위
 *       확정 조정이 시가 체결을 확정하는 값과 같습니다(K29, C3). 거래가 없던 날은 시가 칸이 없어 쓰지 않습니다.</li>
 *   <li>금융위가 그날을 아직 내지 않았으면(금요일 시가는 다음 거래일 밤에 들어옴) 토스 관측치의 그날 봉 — 장부의 시가 사다리와 같은 순서
 *       ({@link KrFills}): 거래량 &gt; 0 봉이고, 1분봉 '개장 + 1분' 라벨 봉(그 실행 달력의 개장 시각 — {@link KrFills#openLabel})의 시가·거래량
 *       &gt; 0이면 {@code TOSS_1M_OPEN}, 아니면 토스 일봉 시가(봉 출처 {@code TOSS_DAILY}·{@code TOSS_INTEGRATED}). 1분봉 {@code FAILED}는
 *       장부처럼 기다리지 않고 일봉 시가로 내려갑니다(복기는 그 세션이 한참 지난 뒤라 다시 물을 자리가 없음 — 출처 글자로 구분). 이어받은
 *       항목({@code isStale} — 이번에 받지 못함)은 쓰지 않습니다.</li>
 * </ol>
 * 저장본 읽기(관측치)는 부르는 쪽이 {@code StoreReader.quietly}로 감쌉니다(정기 작업이 수집을 깨우지 않게).
 */
final class KrReviewOpens {

    private KrReviewOpens() {
    }

    /**
     * 종목마다 {@code from}(포함) 이후 세션의 시가 표(클래스 설명의 출처 순서). 시가가 하나도 없는 종목은 결과에 없습니다.
     *
     * @param fsc      그 종목들의 금융위 확정 시세({@link PaperMarket#confirmedPrices})
     * @param quotes   한국 관측치(없으면 empty — 금융위 시가만)
     * @param calendar 그 실행의 달력(1분봉 개장 봉 라벨 — 장 시간 변경일)
     */
    static Map<String, Map<LocalDate, EntryOpen>> read(KrConfirmed fsc, Optional<Quotes> quotes,
                                                      Collection<String> tickers, LocalDate from,
                                                      TradingCalendar calendar) {
        Map<String, Map<LocalDate, EntryOpen>> out = new LinkedHashMap<>();
        for (String ticker : new TreeSet<>(tickers)) {
            TreeMap<LocalDate, EntryOpen> days = new TreeMap<>();
            KrConfirmed.Series series = fsc.of(ticker);
            for (KrConfirmed.Day day : series.days().tailMap(from, true).values()) {
                if (day.open() != null && day.open().signum() > 0) {
                    days.put(day.date(), new EntryOpen(day.open().doubleValue(), series.source()));
                }
            }
            Bar bar = quotes.map(q -> q.bars().get(ticker)).orElse(null);
            Quote quote = bar == null || bar.stale() ? null : bar.kr();
            if (quote != null) {
                for (Day day : quote.days()) {
                    if (day.date().isBefore(from) || days.containsKey(day.date())) {
                        continue;
                    }
                    EntryOpen provisional = provisional(day, calendar);
                    if (provisional != null) {
                        days.put(day.date(), provisional);
                    }
                }
            }
            if (!days.isEmpty()) {
                out.put(ticker, days);
            }
        }
        return out;
    }

    /** 토스 봉 하나의 잠정 시가(클래스 설명 ②) — 관측 봉이 아니거나 시가가 없으면 null. */
    private static EntryOpen provisional(Day day, TradingCalendar calendar) {
        if (!day.observed()) {
            return null;
        }
        Minute minute = day.minute();
        if (minute != null && KrQuotes.MINUTE_OK.equals(minute.status())) {
            Open open = minute.opens().get(KrFills.openLabel(day.date(), calendar));
            if (open != null && positive(open.open()) && open.volume() != null && open.volume() > 0) {
                return new EntryOpen(open.open().doubleValue(), KrQuotes.SOURCE_1M_OPEN);
            }
        }
        if (!positive(day.open())) {
            return null;
        }
        String source = KrQuotes.SOURCE_DAILY.equals(day.priceSource()) ? KrQuotes.SOURCE_DAILY
                : KrQuotes.SOURCE_INTEGRATED;
        return new EntryOpen(day.open().doubleValue(), source);
    }

    private static boolean positive(BigDecimal value) {
        return value != null && value.signum() > 0;
    }
}
