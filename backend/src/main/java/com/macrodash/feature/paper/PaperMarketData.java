package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
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
 * 저장본이면 마지막 봉이 그날의 지연 시세이고, 장 마감 15분 뒤 이후에 수집했으면 그날 종가입니다(시장 묶음의
 * {@link PaperMarket#closeAvailable}).
 * 날짜·종가 개수가 다르거나 마지막 값이 비면 그 티커는 관측치에서 뺍니다 — 어느 값이 어느 날짜인지 모르거나 지금 값이 없는
 * 것이고, 0이나 직전 값으로 채우면 없는 체결가를 만들게 됩니다.
 *
 * <p><b>시장</b>: 관측치·이력은 시장 묶음({@link PaperMarket})의 데이터셋에서 읽습니다({@link #quotes(PaperMarket)}·
 * {@link #history(PaperMarket, Collection, LocalDate, LocalDate)} — 장부·리스크 점검이 씀, 2단계 명세 §9 A5). 시장을 받지 않는 옛
 * 판({@link #quotes()}·{@link #history(Collection, LocalDate, LocalDate)})과 사후 체결 종가 {@link #sourcedClosesOn}은 미국
 * 것입니다(미국 패킷·선정·결정·복기·관리가 씀). 종가 판정은 시장 묶음의 {@link PaperMarket#closeAvailable}입니다(결정 d9) — 미국 달력을 직접 부르던
 * 옛 정적 판은 시험({@code UsPaperMarketTest})의 대조 기준으로 옮겼습니다(이 파일은 A8의 시장 중립 코어).
 */
@Service
public class PaperMarketData {

    /** 마감 뒤 이만큼 지나 수집한 봉을 확정 종가로 봅니다(설계 §6-1). 야후가 마감 경매 결과를 반영하는 여유. */
    public static final Duration FINAL_DELAY = Duration.ofMinutes(15);

    /**
     * 티커 하나의 마지막 봉.
     *
     * @param stale  수집기가 이번에 받지 못해 직전 저장본 값을 이어 쓴 봉({@code isStale}) — 체결하지 않습니다
     * @param recent 같은 저장본의 최근 일봉 종가(미국 3개월 — 분할 감지의 참조일 종가를 여기서 먼저 찾음, 한국 최근 5봉)
     * @param kr     한국 관측치의 칸(시가·거래량·출처·1분봉 개장 봉·종목 수집 시각 — {@link KrQuotes#parse}, C2b). 미국은 null
     */
    public record Bar(String ticker, LocalDate date, double close, boolean stale, DailySeries recent,
                      KrQuotes.Quote kr) {

        /** 미국 모양의 봉(한국 칸 없음). */
        public Bar(String ticker, LocalDate date, double close, boolean stale, DailySeries recent) {
            this(ticker, date, close, stale, recent, null);
        }
    }

    /**
     * 저장본 하나 = 관측치 하나. 티커 순.
     *
     * @param session 저장본 머리가 밝힌 대상 세션(한국 {@code paper.kr.quotes}의 {@code session} — 늦음 판정이 씀). 미국·모르면 null
     * @param absent  출처가 이번에 답했는데 봉이 0개인 종목(한국 계약 1의 {@code NO_BARS} — '응답에 없음', 이어받은 항목은 빠짐). 관측치
     *                봉에는 없고 기업행위 판정의 토스 상장 상태(사라진 종목 — 금융위도 없을 때만, §4-2 'B7 구현에서 정한 것')가 씁니다. 미국은 빈 집합
     */
    public record Quotes(Instant collectedAt, Map<String, Bar> bars, LocalDate session, Set<String> absent) {

        public Quotes {
            bars = Collections.unmodifiableMap(new TreeMap<>(bars));
            absent = Collections.unmodifiableSet(new java.util.TreeSet<>(absent));
        }

        /** '응답에 없음' 종목이 없는 관측치. */
        public Quotes(Instant collectedAt, Map<String, Bar> bars, LocalDate session) {
            this(collectedAt, bars, session, Set.of());
        }

        /** 머리에 세션이 없는 관측치(미국). */
        public Quotes(Instant collectedAt, Map<String, Bar> bars) {
            this(collectedAt, bars, null);
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

    /**
     * 그 시장의 최신 관측치(시장의 관측치 데이터셋, 시장의 파서 {@link PaperMarket#parse} — 결정 d10). 저장본이 없거나 쓸 수 있는 티커가
     * 하나도 없으면 empty.
     */
    Optional<Quotes> quotes(PaperMarket market) {
        return store.read(market.quotesDataset(), Datasets.MAX_AGE_DAILY, market.quotesTask())
                .flatMap(market::parse);
    }

    /** 미국 관측치 저장본({@code paper.quotes})의 파서 — 미국 묶음의 {@link PaperMarket#parse}가 그대로 부릅니다(클래스 설명의 관측치). */
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

    /**
     * 한국 유니버스 한 기준일치(수집기 {@code kr_paper_universe} 행 그대로 — {@code {code, name, rank, marketCap, listedShares, close, rule}}
     * + {@code obsDate}).
     *
     * @param baseDate 금융위 기준일 B
     */
    record KrUniverseRows(LocalDate baseDate, List<JsonNode> rows) {

        KrUniverseRows {
            rows = List.copyOf(rows);
        }
    }

    /**
     * 기준 세션 D의 한국 유니버스 U(D) — D보다 이른 가장 최근 금융위 기준일 B의 행(2단계 명세 §4-5 'U(D)는 기준일 B &lt; D'). D 당일·뒤 기준일의
     * 행은 그 결정 때 알 수 없던 값이라 읽지 않습니다. 그런 기준일이 없거나 행이 없으면 empty. 수집기 테이블을 읽기만 하고 수집을 깨우지
     * 않습니다(observations 직접 읽기).
     */
    Optional<KrUniverseRows> krUniverseBefore(LocalDate session) {
        LocalDate base = repository.latestObservationDateBefore(Datasets.OBS_KR_PAPER_UNIVERSE, session);
        if (base == null) {
            return Optional.empty();
        }
        List<JsonNode> rows = repository.readObservations(Datasets.OBS_KR_PAPER_UNIVERSE, base, null, null);
        return rows == null || rows.isEmpty() ? Optional.empty() : Optional.of(new KrUniverseRows(base, rows));
    }

    /**
     * 한국 유니버스의 저장된 최신 기준일과 그날 행 수(상태 응답의 한국 수집 상태 — {@link KrCollectionStatus}).
     *
     * @param baseDate 저장된 가장 최근 금융위 기준일 B
     * @param size     그 기준일의 행 수(규칙대로면 100)
     */
    record KrUniverseLatest(LocalDate baseDate, int size) {
    }

    /**
     * {@link KrUniverseLatest} — 저장된 기준일이 없으면 null(0행으로 채우지 않음). 결정이 쓰는 {@link #krUniverseBefore}(기준일 &lt; D)와 달리
     * 오늘 기준일까지 봅니다(수집이 따라왔는지 보는 자리). 수집기 테이블을 읽기만 하고 수집을 깨우지 않습니다(observations 직접 읽기).
     */
    KrUniverseLatest krUniverseLatest() {
        LocalDate base = repository.latestObservationDate(Datasets.OBS_KR_PAPER_UNIVERSE);
        if (base == null) {
            return null;
        }
        List<JsonNode> rows = repository.readObservations(Datasets.OBS_KR_PAPER_UNIVERSE, base, null, null);
        return new KrUniverseLatest(base, rows == null ? 0 : rows.size());
    }

    /**
     * 한국 종목들의 수급 기록({@code kr_paper_flow}) — {@code from}(포함) 이후 날짜, 종목 → 기록(최신 날짜 먼저, 각 payload에 {@code obsDate}).
     * 뒤쪽 날짜를 자르지 않습니다 — 기준 세션 뒤 날짜·결정 시각 뒤에 받은 기록을 빼는 것은 부르는 쪽(한국 규칙 계좌의 입력 읽기)이 하고 그 수를
     * 결정 행에 남깁니다. 수집기 테이블을 읽기만 합니다.
     */
    Map<String, List<JsonNode>> krFlows(Collection<String> codes, LocalDate from) {
        if (codes.isEmpty()) {
            return Map.of();
        }
        Map<String, List<JsonNode>> rows = repository.readObservationSeries(Datasets.OBS_KR_PAPER_FLOW,
                List.copyOf(new LinkedHashSet<>(codes)), from);
        return rows == null ? Map.of() : rows;
    }

    /** DART 사업보고서 주요계정 저장본({@code kr.dart_fundamentals}) — 부르는 쪽이 {@link StoreReader#quietly} 안에서 부릅니다. */
    Optional<Snapshot> krDartFundamentals() {
        return store.read(Datasets.SNAP_DART_FUNDAMENTALS, Datasets.MAX_AGE_WEEKLY, "dart_fundamentals");
    }

    /** 한국 책 수급의 종목별 수집 상태 저장본({@code kr.paper_flows.status}) — 부르는 쪽이 {@link StoreReader#quietly} 안에서 부릅니다. */
    Optional<Snapshot> krFlowsStatus() {
        return store.read(Datasets.SNAP_KR_PAPER_FLOWS_STATUS, Datasets.MAX_AGE_DAILY, "kr_paper_flows");
    }

    /**
     * 한국 종목들의 금융위 시장 구분({@code fsc_price}의 {@code market} — {@code KOSPI}·{@code KOSDAQ}·{@code KONEX}, 금융위 {@code mrktCtg}) — 저장된
     * 가장 최근 기준일의 행에서. 그날 행이 없는 종목(상장폐지·새 상장 등)과 칸이 빈 종목은 결과에 없습니다(모름 — 비용 종목 구분이 주문을
     * 보류, §4-3). 수집기 테이블을 읽기만 하고 수집을 깨우지 않습니다(observations 직접 읽기).
     */
    Map<String, String> fscMarkets(Collection<String> codes) {
        Map<String, String> out = new TreeMap<>();
        if (codes.isEmpty()) {
            return out;
        }
        LocalDate latest = repository.latestObservationDate(Datasets.OBS_FSC_PRICE);
        if (latest == null) {
            return out;
        }
        repository.readObservationsFor(Datasets.OBS_FSC_PRICE, latest, List.copyOf(new LinkedHashSet<>(codes)))
                .forEach((code, payload) -> {
                    String market = Json.asText(payload, "market");
                    if (market != null && !market.isBlank()) {
                        out.put(code, market.strip());
                    }
                });
        return out;
    }

    /**
     * 금융위 두 데이터셋(주식시세·증권상품시세)의 저장된 최신 기준일 — 각각 받은 것이 없으면 null. 확정 조정이 '지난 주기와 금융위가 그대로인가'를
     * 볼 때 범위 읽기 없이 이것만 읽습니다(묶음 C 리뷰).
     */
    record FscLatest(LocalDate stocks, LocalDate etfs) {
    }

    /** {@link FscLatest} — 수집기 테이블을 읽기만 하고 수집을 깨우지 않습니다. */
    FscLatest fscLatest() {
        return new FscLatest(repository.latestObservationDate(Datasets.OBS_FSC_PRICE),
                repository.latestObservationDate(Datasets.OBS_FSC_ETF_PRICE));
    }

    /**
     * 한국 종목들의 금융위 확정 시세({@link KrConfirmed}, C2c) — 주식은 주식시세({@code fsc_price}: 종가·거래량·상장주식수·시가·시장 구분),
     * ETF는 증권상품시세({@code fsc_etf_price}: 종가·거래량·상장좌수·시가 — 시가는 확정 조정의 확정가, C3). 데이터셋마다 최신 기준일을 보고 {@code from}과 (최신 기준일 −
     * {@value KrConfirmed#LOOKBACK_DAYS}일) 중 이른 날부터 최신까지 읽습니다(직전 기준일 상장주식수를 찾으려고). 받은 종목은 행이 없어도
     * 결과에 있고(최신 기준일이 있으면 '없음'), 출처가 아무 기준일도 받지 않았으면 그 종목들은 '모름'입니다. 수집기 테이블을 읽기만 하고
     * 수집을 깨우지 않습니다(observations 직접 읽기 — {@link #fscMarkets}와 같음).
     *
     * @param from 읽을 가장 이른 기준일(null이면 최신 기준일 근처만)
     */
    KrConfirmed krConfirmed(Collection<String> stocks, Collection<String> etfs, LocalDate from) {
        Map<String, KrConfirmed.Series> out = new TreeMap<>();
        readConfirmed(Datasets.OBS_FSC_PRICE, "listedShares", KrConfirmed.SOURCE_FSC, stocks, from, out);
        readConfirmed(Datasets.OBS_FSC_ETF_PRICE, "listedUnits", KrConfirmed.SOURCE_FSC_ETF, etfs, from, out);
        return new KrConfirmed(out);
    }

    private void readConfirmed(String dataset, String listedField, String source, Collection<String> codes,
                               LocalDate from, Map<String, KrConfirmed.Series> out) {
        Set<String> wanted = new LinkedHashSet<>(codes);
        if (wanted.isEmpty()) {
            return;
        }
        LocalDate latest = repository.latestObservationDate(dataset);
        Map<String, List<JsonNode>> rows = Map.of();
        if (latest != null) {
            LocalDate start = latest.minusDays(KrConfirmed.LOOKBACK_DAYS);
            if (from != null && from.isBefore(start)) {
                start = from;
            }
            rows = repository.readObservationSeries(dataset, List.copyOf(wanted), start);
        }
        for (String code : wanted) {
            TreeMap<LocalDate, KrConfirmed.Day> days = new TreeMap<>();
            for (JsonNode row : rows.getOrDefault(code, List.of())) {
                LocalDate date = Json.parseDate(Json.asText(row, "obsDate"));
                if (date != null && !date.isAfter(latest)) {
                    String market = Json.asText(row, "market");
                    days.put(date, new KrConfirmed.Day(date, positiveDecimal(row.get("close")),
                            wholeNumber(row.get("volume"), false), wholeNumber(row.get(listedField), true),
                            positiveDecimal(row.get("open")), market == null || market.isBlank() ? null : market.strip()));
                }
            }
            out.put(code, new KrConfirmed.Series(source, latest, days));
        }
    }

    /** 양수 십진수(금융위 float 저장값 그대로), 아니면 null. */
    private static java.math.BigDecimal positiveDecimal(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble()) || !(node.asDouble() > 0)) {
            return null;
        }
        return node.decimalValue();
    }

    /** 0 이상(또는 양의) 정수 — 소수가 붙었거나 범위 밖이면 null(모름 — 0으로 채우지 않음). */
    private static Long wholeNumber(JsonNode node, boolean positive) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        java.math.BigDecimal value = node.decimalValue();
        if (value.signum() < 0 || (positive && value.signum() == 0) || value.stripTrailingZeros().scale() > 0) {
            return null;
        }
        try {
            return value.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
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
        return sourcedClosesOn(UsPaperMarket.INSTANCE, tickers, date);
    }

    /**
     * {@link #sourcedClosesOn(Collection, LocalDate)}와 같은 규칙을 그 시장의 이력·관측치 데이터셋, 달력의 지금 세션, 종가 판정
     * ({@link PaperMarket#closeAvailable})으로
     * (2단계 명세 §9 A6 — 주간 복기의 기준일 종가). 출처 글자는 그 시장의 데이터셋 이름입니다(미국: {@code equity_close}·
     * {@code paper.quotes} — {@link PaperBooks#SOURCE_HISTORY}·{@link PaperBooks#SOURCE_QUOTES}와 같은 글자).
     */
    Map<String, SourcedClose> sourcedClosesOn(PaperMarket market, Collection<String> tickers, LocalDate date) {
        Map<String, SourcedClose> out = new TreeMap<>();
        Set<String> wanted = new LinkedHashSet<>(tickers);
        if (wanted.isEmpty()) {
            return out;
        }
        if (!date.equals(market.calendar().currentOrLastSession(clock.instant()))) {
            history(market, List.copyOf(wanted), date, date).forEach((ticker, series) -> {
                Double value = series.valueOn(date);
                if (value != null && value > 0) {
                    out.put(ticker, new SourcedClose(value, market.historyDataset()));
                }
            });
        }
        if (out.size() == wanted.size()) {
            return out;
        }
        Optional<Quotes> quotes = quotes(market);
        if (quotes.isEmpty() || !market.closeAvailable(date, quotes.get().collectedAt())) {
            return out;
        }
        for (String ticker : wanted) {
            Bar bar = quotes.get().bars().get(ticker);
            if (out.containsKey(ticker) || bar == null || (bar.stale() && !bar.date().isAfter(date))) {
                continue;
            }
            Double value = bar.recent().valueOn(date);
            if (value != null) {
                out.put(ticker, new SourcedClose(value, market.quotesDataset()));
            }
        }
        return out;
    }
}
