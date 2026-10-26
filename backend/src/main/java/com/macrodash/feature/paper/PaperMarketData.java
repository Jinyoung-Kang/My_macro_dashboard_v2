package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.Json;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

/**
 * 🧪 모의 매매가 읽는 시세 저장본 — 장부 관측치({@code paper.quotes})와 10년 종가 이력({@code timeseries equity_close}).
 *
 * <p>둘 다 수집기 테이블이라 읽기만 합니다(ADR 0008). 스냅샷은 {@link StoreReader}로 읽습니다 — 정기 작업·화면은 이 클래스를
 * {@link StoreReader#quietly} 안에서 불러, 저장본이 오래돼도 수집을 깨우거나 기다리지 않습니다(부르는 쪽 책임).
 *
 * <p><b>관측치</b> = 티커마다 저장본의 마지막 봉({@code dates[-1]}, {@code close[-1]})과 저장본 전체의 수집 시각. 장중에 수집한
 * 저장본이면 마지막 봉이 그날의 지연 시세이고, 장 마감 15분 뒤 이후에 수집했으면 그날 종가입니다({@link #isFinal}).
 * 날짜·종가 개수가 다르거나 마지막 값이 비면 그 티커는 관측치에서 뺍니다 — 어느 값이 어느 날짜인지 모르거나 지금 값이 없는
 * 것이고, 0이나 직전 값으로 채우면 없는 체결가를 만들게 됩니다.
 *
 * <p><b>시장</b>: 관측치·이력은 시장 묶음({@link PaperMarket})의 데이터셋에서 읽습니다({@link #quotes(PaperMarket)}·
 * {@link #history(PaperMarket, Collection, LocalDate, LocalDate)} — 장부·리스크 점검이 씀, 2단계 명세 §9 A5). 시장을 받지 않는 옛
 * 판({@link #quotes()}·{@link #history(Collection, LocalDate, LocalDate)})과 확정 판정 {@link #isFinal}·사후 체결 종가
 * {@link #sourcedClosesOn}은 미국 것입니다(미국 패킷·선정·결정·복기·관리가 씀 — 시장 문맥으로 옮기는 것은 A6).
 */
@Service
public class PaperMarketData {

    /** 마감 뒤 이만큼 지나 수집한 봉을 확정 종가로 봅니다(설계 §6-1). 야후가 마감 경매 결과를 반영하는 여유. */
    public static final Duration FINAL_DELAY = Duration.ofMinutes(15);

    /**
     * 티커 하나의 마지막 봉.
     *
     * @param stale  수집기가 이번에 받지 못해 직전 저장본 값을 이어 쓴 봉({@code isStale}) — 체결하지 않습니다
     * @param recent 같은 저장본의 최근 3개월 일봉(분할 감지의 참조일 종가를 여기서 먼저 찾음)
     */
    public record Bar(String ticker, LocalDate date, double close, boolean stale, DailySeries recent) {
    }

    /** 저장본 하나 = 관측치 하나. 티커 순. */
    public record Quotes(Instant collectedAt, Map<String, Bar> bars) {

        public Quotes {
            bars = Collections.unmodifiableMap(new TreeMap<>(bars));
        }

        /**
         * 다수 티커의 봉 날짜(최빈값) — "이 관측치는 어느 세션의 값인가". 새로 받은 봉만 세고(이어 쓴 봉은 옛 날짜), 그런 봉이
         * 없으면 전부 셉니다. 같은 수면 늦은 날짜. 봉이 없으면 null.
         */
        public LocalDate modalBarDate() {
            Map<LocalDate, Integer> fresh = new TreeMap<>();
            Map<LocalDate, Integer> all = new TreeMap<>();
            for (Bar bar : bars.values()) {
                all.merge(bar.date(), 1, Integer::sum);
                if (!bar.stale()) {
                    fresh.merge(bar.date(), 1, Integer::sum);
                }
            }
            Map<LocalDate, Integer> counts = fresh.isEmpty() ? all : fresh;
            LocalDate best = null;
            int bestCount = 0;
            for (Map.Entry<LocalDate, Integer> entry : counts.entrySet()) {   // 날짜 오름차순 → 같은 수면 뒤가 이김
                if (entry.getValue() >= bestCount) {
                    best = entry.getKey();
                    bestCount = entry.getValue();
                }
            }
            return best;
        }

        /** 이어 쓴(isStale) 봉의 티커, 티커 순. */
        public java.util.List<String> staleTickers() {
            return bars.values().stream().filter(Bar::stale).map(Bar::ticker).toList();
        }
    }

    /**
     * 그 봉이 확정 종가인가: 봉 날짜가 거래일이고, 저장본을 그날 마감 + {@link #FINAL_DELAY} 이후에 수집함. 지난 세션의 봉
     * (휴장·거래 정지로 오늘 봉이 없음)은 마감이 이미 지났으므로 확정입니다.
     */
    public static boolean isFinal(LocalDate barDate, Instant collectedAt) {
        return UsMarketCalendar.isTradingDay(barDate)
                && !collectedAt.isBefore(UsMarketCalendar.closeInstant(barDate).plus(FINAL_DELAY));
    }

    /** 사후 체결 가격과 그 출처(paper_fills.price_source). */
    public record SourcedClose(double close, String source) {
    }

    private final StoreReader store;
    private final StoreRepository repository;
    private final Clock clock;

    @Autowired
    public PaperMarketData(StoreReader store, StoreRepository repository) {
        this(store, repository, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다(사후 체결 종가의 출처 판정이 지금 세션에 따라 달라짐). */
    PaperMarketData(StoreReader store, StoreRepository repository, Clock clock) {
        this.store = store;
        this.repository = repository;
        this.clock = clock;
    }

    /** 미국 책의 최신 관측치({@code paper.quotes}) — {@link #quotes(PaperMarket)}의 미국 판. */
    public Optional<Quotes> quotes() {
        return quotes(UsPaperMarket.INSTANCE);
    }

    /** 그 시장의 최신 관측치(시장의 관측치 데이터셋). 저장본이 없거나 쓸 수 있는 티커가 하나도 없으면 empty. */
    Optional<Quotes> quotes(PaperMarket market) {
        return store.read(market.quotesDataset(), Datasets.MAX_AGE_DAILY, market.quotesTask())
                .flatMap(PaperMarketData::parse);
    }

    static Optional<Quotes> parse(Snapshot snapshot) {
        if (snapshot.collectedAt() == null) {
            return Optional.empty();   // 수집 시각을 모르면 체결 순서(주문 뒤 관측치)를 판정할 수 없습니다
        }
        JsonNode tickers = Json.child(snapshot.payload(), "tickers");
        if (tickers == null || !tickers.isObject()) {
            return Optional.empty();
        }
        Map<String, Bar> bars = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> entry : tickers.properties()) {
            Bar bar = bar(entry.getKey(), entry.getValue());
            if (bar != null) {
                bars.put(bar.ticker(), bar);
            }
        }
        return bars.isEmpty() ? Optional.empty() : Optional.of(new Quotes(snapshot.collectedAt(), bars));
    }

    /** 티커 한 칸 → 마지막 봉. 쓸 수 없으면 null(클래스 설명). */
    private static Bar bar(String ticker, JsonNode frame) {
        JsonNode dates = Json.child(frame, "dates");
        JsonNode closes = Json.child(frame, "close");
        if (dates == null || closes == null || !dates.isArray() || !closes.isArray()
                || dates.isEmpty() || dates.size() != closes.size()) {
            return null;
        }
        int size = dates.size();
        int[] days = new int[size];
        double[] values = new double[size];
        int n = 0;
        for (int i = 0; i < size; i++) {
            LocalDate date = Json.parseDate(dates.get(i).asString(""));
            JsonNode value = closes.get(i);
            boolean usable = date != null && value != null && value.isNumber()
                    && Double.isFinite(value.asDouble()) && value.asDouble() > 0;
            if (!usable) {
                if (i == size - 1) {
                    return null;   // 지금 값(마지막 봉)이 없음 — 직전 봉으로 대신하지 않습니다
                }
                continue;
            }
            days[n] = Math.toIntExact(date.toEpochDay());
            values[n] = value.asDouble();
            n++;
        }
        DailySeries recent;
        try {
            recent = new DailySeries(Arrays.copyOf(days, n), Arrays.copyOf(values, n));
        } catch (IllegalArgumentException e) {
            return null;   // 날짜가 오름차순이 아님 — 어느 봉이 마지막인지 믿을 수 없음
        }
        return new Bar(ticker, recent.lastDate(), recent.lastValue(), Json.asBoolean(frame, "isStale"), recent);
    }

    /** 미국 종목들의 10년 종가 이력({@code equity_close}) — {@link #history(PaperMarket, Collection, LocalDate, LocalDate)}의 미국 판. */
    public Map<String, DailySeries> history(Collection<String> tickers, LocalDate from, LocalDate to) {
        return history(UsPaperMarket.INSTANCE, tickers, from, to);
    }

    /**
     * 그 시장 종목들의 종가 이력(시장의 이력 데이터셋, 미국은 10년 수정주가)을 날짜 범위로. 없는 종목은 결과에 없습니다. from·to가
     * null이면 그쪽 제한 없음(포함). 룩어헤드 방지는 부르는 쪽이 범위({@code to})로 합니다.
     */
    Map<String, DailySeries> history(PaperMarket market, Collection<String> tickers, LocalDate from, LocalDate to) {
        Map<String, DailySeries> out = new LinkedHashMap<>();
        repository.readTimeseriesColumns(market.historyDataset(), tickers, from, to)
                .forEach((ticker, columns) -> out.put(ticker, new DailySeries(columns.epochDays(), columns.values())));
        return out;
    }

    /** 그날의 정확한 종가(사후 체결용). 없으면 null. 출처까지 필요하면 {@link #sourcedCloseOn}. */
    public Double closeOn(String ticker, LocalDate date) {
        return sourcedCloseOn(ticker, date).map(SourcedClose::close).orElse(null);
    }

    /** 그날의 정확한 종가와 출처(종목 하나). 규칙은 {@link #sourcedClosesOn}. */
    public Optional<SourcedClose> sourcedCloseOn(String ticker, LocalDate date) {
        return Optional.ofNullable(sourcedClosesOn(List.of(ticker), date).get(ticker));
    }

    /**
     * 종목들의 그날 정확한 종가와 출처(이력은 한 번에 읽음). 찾은 종목만 결과에 있고, 다른 날 값으로 대신하지 않습니다.
     *
     * <ol>
     *   <li>10년 이력({@code equity_close})의 그날 값 — 단 그날이 <b>지금 세션</b>({@link UsMarketCalendar#currentOrLastSession})
     *       이면 쓰지 않습니다. 그날은 이력의 마지막 날이고, 수집기(12시간 주기)가 장중에 돌았으면 그 행은 장중 값인데 행에
     *       언제 받았는지가 남지 않아 마감 뒤 값인지 알 수 없습니다. 다음 세션이 열리면(그 사이 이력이 다시 돔) 믿습니다.</li>
     *   <li>관측치 저장본의 최근 3개월 일봉 — 저장본을 그날 마감 + 15분 뒤에 수집했을 때만(그 전이면 그날 봉은 장중 지연 시세).
     *       이어 쓴({@code isStale}) 봉은 직전 저장본 것이라 언제 받았는지 모르니, 그날보다 뒤 세션까지 본 봉일 때만 그날 값을
     *       믿습니다(16:20 수집에서 그 종목만 실패해 15:20 장중 봉을 이어 쓴 경우를 막음).</li>
     * </ol>
     */
    public Map<String, SourcedClose> sourcedClosesOn(Collection<String> tickers, LocalDate date) {
        Map<String, SourcedClose> out = new TreeMap<>();
        Set<String> wanted = new LinkedHashSet<>(tickers);
        if (wanted.isEmpty()) {
            return out;
        }
        if (!date.equals(UsMarketCalendar.currentOrLastSession(clock.instant()))) {
            history(List.copyOf(wanted), date, date).forEach((ticker, series) -> {
                Double value = series.valueOn(date);
                if (value != null && value > 0) {
                    out.put(ticker, new SourcedClose(value, PaperBooks.SOURCE_HISTORY));
                }
            });
        }
        if (out.size() == wanted.size()) {
            return out;
        }
        Optional<Quotes> quotes = quotes();
        if (quotes.isEmpty() || !isFinal(date, quotes.get().collectedAt())) {
            return out;
        }
        for (String ticker : wanted) {
            Bar bar = quotes.get().bars().get(ticker);
            if (out.containsKey(ticker) || bar == null || (bar.stale() && !bar.date().isAfter(date))) {
                continue;
            }
            Double value = bar.recent().valueOn(date);
            if (value != null) {
                out.put(ticker, new SourcedClose(value, PaperBooks.SOURCE_QUOTES));
            }
        }
        return out;
    }
}
