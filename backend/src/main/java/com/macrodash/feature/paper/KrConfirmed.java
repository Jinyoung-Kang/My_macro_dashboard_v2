package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCorporateActions.ListedShares;
import com.macrodash.analytics.KrxCorporateActions.Presence;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 🧪 한국 확정 시세 — 금융위 주식시세({@code fsc_price}, 종가 {@code clpr})·증권상품시세({@code fsc_etf_price}, ETF 종가)의 종목별 기준일 값
 * (2단계 명세 §4-1 '확정가', §4-2 K30·K32, C2c). 장부의 시가 체결 경로({@link PaperMarket#auctionFills})가 책 하나를 처리할 때 한 번 읽어
 * ({@link PaperMarket#confirmedPrices}) 네 곳에 씁니다:
 *
 * <ul>
 *   <li><b>스탑 재판정</b> — 밤 잠정 종가로 감지한 날 D의 확정 종가. STOP 주문을 체결 처리하는 D+1 밤에는 이미 들어와 있습니다(slow 순서
 *       {@code fsc_prices} → {@code kr_paper_quotes}). D 15:30에 공개된 값이라 룩어헤드가 아닙니다.</li>
 *   <li><b>최고가</b> — KRX 기준가로만 올림(G2 전에는 금융위 종가뿐 — 토스 통합 종가로는 올리지 않음).</li>
 *   <li><b>기업행위 판정의 상장 상태</b> — 그 데이터셋의 최신 기준일에 그 종목 행이 있는지({@link Series#presence}), 그 종목의 최근 두
 *       기준일 상장주식수(ETF는 상장좌수 — {@link Series#sharesBefore}·{@link Series#sharesAfter}).</li>
 *   <li><b>미처리 기업행위 보유의 묶인 평가</b> — 그 보유가 반영한 마지막 관측 날짜의 확정 종가.</li>
 * </ul>
 *
 * <p><b>거래량 0 행은 그날 종가가 아닙니다</b>({@link Day#observed}): 금융위는 거래가 없던 날의 {@code clpr}에 직전 종가를 줍니다([확인]
 * 101530 2026-10-21~23, 명세 §4-15 'B2 구현에서 정한 것'). 그래서 확정 종가로 쓰는 값은 거래량 &gt; 0 행뿐이고, 거래량을 모르는 행도 쓰지
 * 않습니다(짐작하지 않음). 모르는 종목·읽지 않은 종목은 {@link Presence#UNKNOWN}(출처가 아직 아무 기준일도 받지 않았을 때도 — 증권상품시세
 * 활용신청 전 등)이고, '없음'({@link Presence#ABSENT})은 출처가 최신 기준일을 끝까지 받았는데(QA-078) 그날 그 종목 행이 없을 때뿐입니다.
 */
final class KrConfirmed {

    /** 확정 출처 — 주식시세({@code paper_fill_confirmations.source}와 같은 글자). */
    static final String SOURCE_FSC = "FSC";
    /** 확정 출처 — 증권상품시세(ETF). */
    static final String SOURCE_FSC_ETF = "FSC_ETF";
    /**
     * 최신 기준일에서 거슬러 읽는 달력 일수 — 그 종목의 직전 기준일 상장주식수를 찾는 창(휴장·하루 빠진 수집을 넉넉히 덮음). 부르는 쪽이
     * 더 이른 날을 원하면({@code from}) 그날부터 읽습니다.
     */
    static final int LOOKBACK_DAYS = 14;

    /** 읽은 것이 없음(미국·확정 시세를 쓰지 않는 시장 — 모든 종목이 모름). */
    static final KrConfirmed NONE = new KrConfirmed(Map.of());

    /**
     * 한 기준일의 행.
     *
     * @param close  종가(양수, 모르면 null)
     * @param volume 거래량(0 이상 정수, 모르면 null). 0이면 그날 거래 없음 — 종가는 직전 값
     * @param listed 상장주식수(ETF 상장좌수, 양의 정수 — 모르면 null)
     */
    record Day(LocalDate date, BigDecimal close, Long volume, Long listed) {

        Day {
            Objects.requireNonNull(date, "date");
        }

        /** 그날 종가로 쓸 수 있는 행인가 — 종가가 있고 거래량 &gt; 0(거래량 0 행의 종가는 직전 값, 모르면 쓰지 않음). */
        boolean observed() {
            return close != null && volume != null && volume > 0;
        }
    }

    /**
     * 종목 하나.
     *
     * @param source        {@link #SOURCE_FSC}·{@link #SOURCE_FSC_ETF}(모르는 종목이면 null)
     * @param datasetLatest 그 데이터셋 전체의 최신 기준일(출처가 아직 아무것도 받지 않았으면 null — 상장 상태를 모름)
     * @param days          읽은 범위의 그 종목 행(기준일 오름차순)
     */
    record Series(String source, LocalDate datasetLatest, NavigableMap<LocalDate, Day> days) {

        /** 읽지 않은 종목(모름). */
        static final Series UNKNOWN = new Series(null, null, Collections.emptyNavigableMap());

        Series {
            days = Collections.unmodifiableNavigableMap(new TreeMap<>(days));
        }

        /** 그 기준일의 행. */
        Optional<Day> on(LocalDate date) {
            return Optional.ofNullable(days.get(date));
        }

        /** 그날 확정 종가 — 그날 행이 있고 거래량 &gt; 0일 때만({@link Day#observed}). */
        Optional<BigDecimal> closeOn(LocalDate date) {
            return on(date).filter(Day::observed).map(Day::close);
        }

        /** {@code from}(포함) 뒤 확정 종가로 쓸 수 있는 행, 오래된 날부터. */
        List<Day> observedFrom(LocalDate from) {
            return days.tailMap(from, true).values().stream().filter(Day::observed).toList();
        }

        /**
         * 그 출처에 그 종목이 있는가 — 출처가 아무것도 받지 않았으면 모름, 최신 기준일에 그 종목 행이 있으면 있음, 없으면 없음(출처는
         * 하루치를 끝까지 받은 날만 저장 — QA-078).
         */
        Presence presence() {
            if (datasetLatest == null) {
                return Presence.UNKNOWN;
            }
            return days.containsKey(datasetLatest) ? Presence.LISTED : Presence.ABSENT;
        }

        /** 최신 기준일의 상장주식수(그날 행이 없거나 값을 모르면 null). */
        ListedShares sharesAfter() {
            Day day = datasetLatest == null ? null : days.get(datasetLatest);
            return day == null || day.listed() == null ? null : new ListedShares(day.date(), day.listed());
        }

        /** 최신 기준일 앞의 그 종목 마지막 행의 상장주식수(읽은 범위 안 — 없거나 값을 모르면 null). */
        ListedShares sharesBefore() {
            if (datasetLatest == null || !days.containsKey(datasetLatest)) {
                return null;
            }
            Map.Entry<LocalDate, Day> before = days.lowerEntry(datasetLatest);
            return before == null || before.getValue().listed() == null ? null
                    : new ListedShares(before.getKey(), before.getValue().listed());
        }
    }

    private final Map<String, Series> byCode;

    KrConfirmed(Map<String, Series> byCode) {
        this.byCode = Map.copyOf(byCode);
    }

    /** 그 종목(읽지 않았으면 {@link Series#UNKNOWN}). */
    Series of(String code) {
        return byCode.getOrDefault(code, Series.UNKNOWN);
    }
}
