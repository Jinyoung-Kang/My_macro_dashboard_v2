package com.macrodash.feature.institution;

import com.macrodash.Kst;
import com.macrodash.analytics.Benchmarks;
import com.macrodash.analytics.GuruStyle;
import com.macrodash.analytics.PortfolioRisk;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.HoldingsJson;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 구루 포트폴리오 분석 — 스타일 · 유사도 · 위험.
 *
 * <p>13F 화면은 "누가 무엇을 들고 있나"를 보여 줍니다. 이 계층은 한 발 더
 * 들어가 <b>어떤 식으로</b> 들고 있는지를 봅니다 — 몇 종목에 쏠려 있는지,
 * 누구와 닮았는지, 그 포트폴리오가 얼마나 흔들렸는지.
 *
 * <p><b>13F가 담지 않는 것</b>을 화면이 계속 상기시켜야 합니다. 공시 대상은
 * 미국 상장 <b>롱 포지션</b>뿐입니다. 채권·현금·해외 상장분·공매도는 애초에
 * 이 숫자 안에 없습니다. 그리고 <b>45일 지연</b>된 분기말 사진입니다.
 */
@Service
public class GuruService {

    /** 위험 분석에 쓸 벤치마크. 저장본에 함께 실려 오는 티커여야 합니다. */

    private final StoreReader store;

    public GuruService(StoreReader store) {
        this.store = store;
    }

    // ==================================================== 스타일 프로파일
    /**
     * 기관별 성격 요약.
     *
     * <p>종목 수만 세면 인덱스 펀드와 집중 투자자가 같은 칸에 놓입니다. 그래서
     * <b>유효 종목 수</b>(1/HHI)를 함께 적습니다 — 3,000종목을 들고 있어도 상위
     * 몇 개에 쏠려 있으면 이 값은 수십으로 나옵니다.
     */
    public Map<String, Object> profiles() {
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> rows = new ArrayList<>();

        for (Map<String, String> institution : Institutions.ALL) {
            String cik = institution.get("cik");
            List<JsonNode> quarters = quartersOf(cik);
            if (quarters.isEmpty()) {
                continue;
            }
            JsonNode latest = quarters.get(0);
            Map<String, Double> weights = weightsOf(latest);
            if (weights.isEmpty()) {
                continue;
            }
            // 직전 분기는 바로 앞 분기 말일의 공시입니다. 분기가 빠졌으면 반년치 회전율을 내지 않습니다(QA-085).
            JsonNode previousQuarter = HoldingsJson.previousQuarter(quarters, latest);
            Map<String, Double> previous = previousQuarter == null ? Map.of() : weightsOf(previousQuarter);

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("cik", cik);
            row.put("key", institution.get("key"));
            row.put("name", institution.get("name"));
            row.put("desc", institution.get("desc"));
            row.put("reportDate", Json.asText(latest, "reportDate"));
            row.put("totalValue", Json.asDouble(latest, "totalValue"));
            row.put("holdingCount", weights.size());
            row.put("effectiveHoldings", GuruStyle.effectiveHoldings(weights));
            row.put("hhi", GuruStyle.herfindahl(weights));
            row.put("top10Weight", GuruStyle.topWeight(weights, 10));
            // 직전 분기가 없으면 null입니다 — 0으로 두면 "한 주도 안 바꿨다"가 됩니다.
            row.put("turnover", GuruStyle.turnover(previous, weights));
            row.put("quarterCount", quarters.size());
            rows.add(row);
        }

        // 집중된 곳부터. 성격 차이가 가장 눈에 띄는 축입니다.
        rows.sort(Comparator.comparingDouble(
                row -> -(double) (Double) row.getOrDefault("hhi", 0.0)));

        out.put("available", !rows.isEmpty());
        out.put("rows", rows);
        out.put("note", "13F는 미국 상장 롱 포지션만 공시 대상입니다. 채권·현금·"
                + "해외 상장분·공매도는 이 숫자에 들어 있지 않습니다. 분기말 기준이며 "
                + "제출까지 최대 45일 지연됩니다.");
        if (rows.isEmpty()) {
            out.put("message", "13F 저장본이 없습니다. 수집기의 weekly 작업을 실행하세요.");
        }
        return out;
    }

    // ========================================================== 유사도
    /**
     * 기관 간 유사도 행렬.
     *
     * <p>머리기사는 <b>겹침 비중</b>입니다 — "두 포트폴리오의 62%가 같은 종목"은
     * 그대로 읽히지만 "코사인 0.82"는 한 번 더 해석해야 합니다. 코사인은 비중의
     * 모양을 보는 보조 지표로 함께 냅니다.
     */
    public Map<String, Object> similarity() {
        List<Map<String, String>> institutions = new ArrayList<>();
        List<Map<String, Double>> weights = new ArrayList<>();

        for (Map<String, String> institution : Institutions.ALL) {
            List<JsonNode> quarters = quartersOf(institution.get("cik"));
            if (quarters.isEmpty()) {
                continue;
            }
            Map<String, Double> weight = weightsOf(quarters.get(0));
            if (weight.isEmpty()) {
                continue;
            }
            Map<String, String> meta = new LinkedHashMap<>(institution);
            meta.put("reportDate", String.valueOf(Json.asText(quarters.get(0), "reportDate")));
            institutions.add(meta);
            weights.add(weight);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("institutions", institutions);

        List<List<Double>> overlap = new ArrayList<>();
        List<List<Double>> cosine = new ArrayList<>();
        for (int i = 0; i < weights.size(); i++) {
            List<Double> overlapRow = new ArrayList<>();
            List<Double> cosineRow = new ArrayList<>();
            for (int j = 0; j < weights.size(); j++) {
                overlapRow.add(i == j ? 100.0
                        : GuruStyle.overlapWeight(weights.get(i), weights.get(j)));
                cosineRow.add(i == j ? 1.0
                        : GuruStyle.cosine(weights.get(i), weights.get(j)));
            }
            overlap.add(overlapRow);
            cosine.add(cosineRow);
        }
        out.put("overlap", overlap);
        out.put("cosine", cosine);

        // 가장 닮은 짝을 따로 뽑습니다. 12×12 행렬을 눈으로 훑게 두면
        // "무엇을 봐야 하는지"를 읽는 사람에게 떠넘기게 됩니다.
        List<Map<String, Object>> pairs = new ArrayList<>();
        for (int i = 0; i < weights.size(); i++) {
            for (int j = i + 1; j < weights.size(); j++) {
                Map<String, Object> pair = new LinkedHashMap<>();
                pair.put("left", institutions.get(i).get("name"));
                pair.put("right", institutions.get(j).get("name"));
                pair.put("overlap", overlap.get(i).get(j));
                pair.put("cosine", cosine.get(i).get(j));
                pairs.add(pair);
            }
        }
        pairs.sort(Comparator.comparingDouble(
                pair -> -(double) (Double) pair.get("overlap")));
        out.put("topPairs", pairs.stream().limit(10).toList());

        out.put("available", weights.size() >= 2);
        if (weights.size() < 2) {
            out.put("message", "비교하려면 13F 저장본이 최소 2곳 필요합니다.");
        }
        out.put("note", "겹침 비중 = 각 종목에서 작은 쪽 비중을 더한 값입니다. "
                + "애플을 한쪽이 10%, 다른 쪽이 3% 들고 있으면 겹치는 것은 3%입니다.");
        return out;
    }

    // ==================================================== 역방향 조회
    /**
     * 보유 기관 검색이 돌려주는 최대 행 수(QA-133). 예전에는 일치하는 행을 모두 돌려줘, 한 글자 검색(q=C)이 12개 기관 최신
     * 분기 보유 약 1만 6천 행 가운데 1만 4,748행(JSON 3MB)이 되고 화면은 그 행을 전부 그렸습니다. 비중 상위 200행이면
     * 실제로 읽는 범위를 넉넉히 덮고, 잘린 사실과 원래 일치 건수는 {@code truncated}·{@code totalMatches}로 함께 알립니다.
     */
    static final int HOLDERS_MAX_ROWS = 200;

    /**
     * 보유 기관 검색의 색인 한 줄 — 기관 하나의 최신 분기 13F 보유 하나. 검색어와 상관없고 바뀌지 않는 값이라 응답 캐시에
     * 두고 요청끼리 나눠 씁니다(QA-133).
     */
    public record HoldingRow(String institution, String cik, String name, String cusip,
                             Double weight, Double value, String reportDate) {
    }

    /**
     * 모든 기관의 최신 분기 보유 목록(검색어와 상관없음). 저장본을 풀어 만드는 비싼 쪽이라, 컨트롤러가 응답 캐시에 넣어
     * 같은 저장본 버전·60초 안에서는 한 번만 만듭니다(동시에 온 검색은 그 계산 하나를 기다림) — 예전에는 검색할 때마다 12개 기관 저장본을 다시 읽어(수집 시각 조회 12번 + 보유 약
     * 1만 6천 행 순회) 걸렀고, 파싱 캐시가 빈 재기동 직후에는 동시에 온 검색이 각자 약 17.7MB를 다시 풀었습니다(QA-133).
     * 돌려주는 목록은 바꿀 수 없습니다(캐시가 요청끼리 나눠 씀).
     */
    public List<HoldingRow> holdersIndex() {
        List<HoldingRow> index = new ArrayList<>();
        for (Map<String, String> institution : Institutions.ALL) {
            List<JsonNode> quarters = quartersOf(institution.get("cik"));
            if (quarters.isEmpty()) {
                continue;
            }
            JsonNode latest = quarters.get(0);
            String reportDate = Json.asText(latest, "reportDate");
            for (JsonNode holding : Json.array(latest, "holdings")) {
                String name = Json.asText(holding, "name");
                if (name == null) {
                    continue;
                }
                index.add(new HoldingRow(institution.get("name"), institution.get("cik"), name,
                        Json.asText(holding, "cusip"), Json.asDouble(holding, "weight"),
                        Json.asDouble(holding, "value"), reportDate));
            }
        }
        return List.copyOf(index);
    }

    /** 이 종목을 누가 들고 있나. 종목명 일부로 찾습니다. 저장본을 직접 읽어 색인을 만듭니다(테스트·단독 호출용). */
    public Map<String, Object> holders(String query) {
        return holders(holdersIndex(), query);
    }

    /**
     * 이 종목을 누가 들고 있나 — {@link #holdersIndex()}에서 이름에 검색어가 들어간 행을 비중 순으로 찾습니다.
     * 비중 상위 {@value #HOLDERS_MAX_ROWS}행까지만 돌려주고 원래 일치 건수와 잘렸는지를 함께 적습니다(QA-133).
     * {@code index}는 캐시가 나눠 쓰는 목록이라 바꾸지 않고, 응답 행은 요청마다 새로 만듭니다.
     */
    public Map<String, Object> holders(List<HoldingRow> index, String query) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("query", query);

        if (query == null || query.isBlank()) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "찾을 종목명을 입력하세요.");
            return out;
        }
        String needle = query.trim().toUpperCase();

        List<HoldingRow> matches = new ArrayList<>();
        for (HoldingRow holding : index) {
            if (holding.name().toUpperCase().contains(needle)) {
                matches.add(holding);
            }
        }
        matches.sort(Comparator.comparingDouble(
                holding -> -(holding.weight() == null ? 0.0 : holding.weight())));

        List<Map<String, Object>> rows = new ArrayList<>();
        for (HoldingRow holding : matches.subList(0, Math.min(matches.size(), HOLDERS_MAX_ROWS))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("institution", holding.institution());
            row.put("cik", holding.cik());
            row.put("name", holding.name());
            row.put("cusip", holding.cusip());
            row.put("weight", holding.weight());
            row.put("value", holding.value());
            row.put("reportDate", holding.reportDate());
            rows.add(row);
        }

        out.put("available", !rows.isEmpty());
        out.put("rows", rows);
        out.put("totalMatches", matches.size());
        out.put("truncated", matches.size() > rows.size());
        if (rows.isEmpty()) {
            out.put("message", "그 이름을 포함한 보유 종목이 없습니다. "
                    + "13F 공시 이름은 대문자 영문입니다(예: APPLE, NVIDIA).");
        }
        return out;
    }

    // ============================================================ 위험
    /**
     * 구루 포트폴리오의 위험 지표.
     *
     * <p><b>커버리지를 먼저 봅니다.</b> 13F에는 티커가 없어 이름으로 가격을
     * 찾는데, 매핑표에 없는 종목은 분석에서 빠집니다. 덮은 비중을 항상 함께
     * 적고, 덮지 못한 몫은 "모른다"로 둡니다 — 덮인 것만으로 계산한 값을
     * 전체인 것처럼 보여 주면 안 됩니다.
     */
    public Map<String, Object> risk(String cik, String benchmark, int years) {
        Institutions.requireKnownCik(cik);
        Map<String, Object> out = new LinkedHashMap<>();
        String benchmarkTicker = Benchmarks.resolve(benchmark);
        int window = Math.max(1, Math.min(5, years));
        out.put("cik", cik);
        out.put("benchmark", benchmarkTicker);
        out.put("years", window);
        out.put("institution", Institutions.byCik(cik));

        Optional<Snapshot> priceSnapshot = store.read(
                Datasets.SNAP_EQUITY_HISTORY, Datasets.MAX_AGE_DAILY, "equity_history");
        List<JsonNode> quarters = quartersOf(cik);

        if (priceSnapshot.isEmpty() || priceSnapshot.get().payload() == null) {
            return unavailable(out, "종목 가격 저장본이 없습니다. "
                    + "데이터 저장소 상태에서 'equity_history' 수집을 먼저 실행하세요.");
        }
        if (quarters.isEmpty()) {
            return unavailable(out, "13F 저장본이 없습니다. 수집기의 weekly 작업을 실행하세요.");
        }

        priceSnapshot.get().putFreshness(out);
        JsonNode payload = priceSnapshot.get().payload();
        JsonNode nameMap = Json.child(payload, "nameMap");
        JsonNode tickers = Json.child(payload, "tickers");
        Map<String, JsonNode> mappedByTicker = byTicker(nameMap);

        JsonNode latest = quarters.get(0);
        out.put("reportDate", Json.asText(latest, "reportDate"));

        // ── 보유 종목을 티커로 옮기면서 커버리지를 셉니다 ──────────────
        Map<String, Double> weights = new LinkedHashMap<>();
        Map<String, String> labels = new LinkedHashMap<>();
        Map<String, String> sectors = new LinkedHashMap<>();
        double coveredWeight = 0.0;
        double totalWeight = 0.0;
        int coveredCount = 0;
        int totalCount = 0;
        List<Map<String, Object>> uncovered = new ArrayList<>();

        for (JsonNode holding : Json.array(latest, "holdings")) {
            Double weight = Json.asDouble(holding, "weight");
            String name = Json.asText(holding, "name");
            if (weight == null || weight <= 0 || name == null) {
                continue;
            }
            totalCount++;
            totalWeight += weight;

            // 수집기가 13F를 저장할 때 두 단계 매칭(펀드·채권·우선주 등 제외)으로 붙인 티커를 먼저 씁니다(QA-087). 예전처럼
            // 이름을 매핑표 키와 정확히 비교만 하면 'NVIDIA CORPORATION' 같은 최대 보유 종목이 '매핑표에 없음'으로 빠졌습니다.
            // ticker 필드가 없는 옛 저장본만 이름으로 찾습니다. null이면 수집기가 모른다고 정한 것(펀드·채권·우선주 등)이라
            // 이름으로 다시 찾지 않습니다.
            JsonNode mapped;
            String ticker;
            if (holding.has("ticker")) {
                ticker = Json.asText(holding, "ticker");
                mapped = ticker == null ? null : mappedByTicker.get(ticker);
            } else {
                mapped = nameMap == null ? null : nameMap.get(name);
                ticker = mapped == null ? null : Json.asText(mapped, "ticker");
            }
            // 수집 실패로 이어받은 가격(isStale)은 마지막 날 뒤로 값이 없어, 넣으면 모든 보유 종목 날짜의 교집합이
            // 그날에 묶입니다. 빼고 이유를 적습니다(QA-065).
            boolean stale = ticker != null && tickers != null && Json.asBoolean(tickers.get(ticker), "isStale");
            if (ticker == null || tickers == null || tickers.get(ticker) == null || stale) {
                Map<String, Object> miss = new LinkedHashMap<>();
                miss.put("name", name);
                miss.put("weight", weight);
                miss.put("reason", stale ? "가격 수집 실패(이전 값이라 제외)" : uncoveredReason(holding, ticker));
                uncovered.add(miss);
                continue;
            }
            coveredCount++;
            coveredWeight += weight;
            // 같은 회사가 클래스별로 두 줄 들어오면 비중을 합칩니다.
            weights.merge(ticker, weight, Double::sum);
            labels.putIfAbsent(ticker, name);
            sectors.putIfAbsent(ticker, sectorLabel(mapped));
        }

        uncovered.sort(Comparator.comparingDouble(
                row -> -(row.get("weight") instanceof Number n ? n.doubleValue() : 0.0)));

        Map<String, Object> coverage = new LinkedHashMap<>();
        coverage.put("holdings", coveredCount);
        coverage.put("totalHoldings", totalCount);
        coverage.put("weight", coveredWeight);
        coverage.put("totalWeight", totalWeight);
        coverage.put("uncovered", uncovered.stream().limit(20).toList());
        coverage.put("uncoveredCount", uncovered.size());
        out.put("coverage", coverage);

        if (weights.isEmpty()) {
            return unavailable(out, "이 기관의 보유 종목 중 가격을 찾을 수 있는 종목이 "
                    + "없습니다. 매핑표(collector/app/equities.py)에 없는 종목들입니다.");
        }

        // ── 가격을 붙이고 포트폴리오 수익률을 재구성합니다 ──────────────
        LocalDate cutoff = Kst.today().minusYears(window);
        Map<String, NavigableMap<LocalDate, Double>> prices = new LinkedHashMap<>();
        for (String ticker : weights.keySet()) {
            NavigableMap<LocalDate, Double> series = Json.dateValueSeries(tickers.get(ticker), "dates", "close", cutoff);
            if (series.size() >= 2) {
                prices.put(ticker, series);
            }
        }
        NavigableMap<LocalDate, Double> benchmarkSeries =
                Json.dateValueSeries(tickers.get(benchmarkTicker), "dates", "close", cutoff);

        PortfolioRisk.Returns portfolio = PortfolioRisk.weightedReturns(weights, prices);
        if (portfolio.size() < 20) {
            return unavailable(out, "가격 표본이 부족해 위험을 계산할 수 없습니다 "
                    + "(모든 보유 종목에 값이 있는 거래일이 20일 미만).");
        }

        double[] benchmarkReturns = PortfolioRisk.alignedReturns(
                benchmarkSeries, portfolio.dates());

        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("volatility", PortfolioRisk.annualizedVolatility(portfolio.values()));
        metrics.put("var95", PortfolioRisk.historicalVar(portfolio.values(), 0.95));
        metrics.put("var99", PortfolioRisk.historicalVar(portfolio.values(), 0.99));
        metrics.put("es95", PortfolioRisk.expectedShortfall(portfolio.values(), 0.95));
        metrics.put("es99", PortfolioRisk.expectedShortfall(portfolio.values(), 0.99));
        metrics.put("maxDrawdown", PortfolioRisk.maxDrawdown(portfolio.values()));
        metrics.put("beta", PortfolioRisk.beta(portfolio.values(), benchmarkReturns));
        metrics.put("trackingError",
                PortfolioRisk.trackingError(portfolio.values(), benchmarkReturns));
        metrics.put("samples", portfolio.size());
        metrics.put("from", portfolio.dates().get(0).toString());
        metrics.put("to", portfolio.dates().get(portfolio.size() - 1).toString());
        out.put("metrics", metrics);

        // ── 종목별 기여 ────────────────────────────────────────────────
        List<Map<String, Object>> contributions = new ArrayList<>();
        for (PortfolioRisk.Contribution one
                : PortfolioRisk.contributions(weights, labels, prices, portfolio)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", one.key());
            row.put("name", one.label());
            row.put("sector", sectors.get(one.key()));
            row.put("weight", one.weight());
            row.put("volatility", one.volatility());
            row.put("marginal", one.marginal());
            row.put("contribution", one.contribution());
            row.put("share", one.share());
            contributions.add(row);
        }
        out.put("contributions", contributions);

        // ── 섹터 노출 ──────────────────────────────────────────────────
        Map<String, Double> bySector = new TreeMap<>();
        double covered = weights.values().stream().mapToDouble(Double::doubleValue).sum();
        for (Map.Entry<String, Double> entry : weights.entrySet()) {
            String sector = sectors.getOrDefault(entry.getKey(), "미분류");
            // 덮은 종목만으로 100%가 되게 다시 맞춥니다. 커버리지는 위에 따로
            // 적혀 있으므로, 여기서 또 줄이면 두 번 깎는 셈이 됩니다.
            bySector.merge(sector, entry.getValue() / covered * 100.0, Double::sum);
        }
        List<Map<String, Object>> sectorRows = new ArrayList<>();
        bySector.forEach((sector, weight) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("sector", sector);
            row.put("weight", weight);
            sectorRows.add(row);
        });
        sectorRows.sort(Comparator.comparingDouble(
                row -> -(double) (Double) row.get("weight")));
        out.put("sectors", sectorRows);

        out.put("available", true);
        out.put("note", "비중은 매일 재조정된다고 가정합니다(고정 비중). 13F는 분기에 "
                + "한 번 찍힌 사진이라 그사이 실제 비중이 어떻게 흘렀는지는 알 수 "
                + "없습니다. VaR는 '이보다 나쁜 날이 5%는 있었다'는 과거의 기록이지 "
                + "손실의 상한이 아닙니다.");
        return out;
    }

    private Map<String, Object> unavailable(Map<String, Object> out, String message) {
        out.put("available", false);
        out.put("message", message);
        return out;
    }

    // ------------------------------------------------------------ 공통 도구
    /** 기관의 분기 목록 (최신 우선, 중복 분기 제거). */
    private List<JsonNode> quartersOf(String cik) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS),
                Datasets.MAX_AGE_SLOW, "sec_13f");
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            return List.of();
        }
        return Sec13FService.dedupeByReportDate(Json.array(snapshot.get().payload(), "quarters"));
    }

    /**
     * 한 분기의 비중 벡터 (키 = CUSIP).
     *
     * <p>이름이 아니라 CUSIP으로 맞춥니다. 같은 회사도 기관마다 표기가 갈리지만
     * (BERKSHIRE HATHAWAY INC / BERKSHIRE HATHAWAY INC DEL) CUSIP은 같습니다.
     */
    private Map<String, Double> weightsOf(JsonNode quarter) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (JsonNode holding : Json.array(quarter, "holdings")) {
            String cusip = Json.asText(holding, "cusip");
            Double weight = Json.asDouble(holding, "weight");
            if (cusip != null && !cusip.isBlank() && weight != null && weight > 0) {
                out.merge(cusip, weight, Double::sum);
            }
        }
        return out;
    }

    /** 매핑표를 티커로 다시 묶습니다(섹터를 찾는 데 씁니다). 같은 티커의 이름이 여럿이면 처음 것. */
    private static Map<String, JsonNode> byTicker(JsonNode nameMap) {
        Map<String, JsonNode> out = new LinkedHashMap<>();
        if (nameMap != null && nameMap.isObject()) {
            for (Map.Entry<String, JsonNode> entry : nameMap.properties()) {
                String ticker = Json.asText(entry.getValue(), "ticker");
                if (ticker != null) {
                    out.putIfAbsent(ticker, entry.getValue());
                }
            }
        }
        return out;
    }

    /**
     * 가격을 붙이지 못한 보유의 미커버 이유. 수집기는 회사 이름이 매핑표에 있는데 일부러 뺀 보유에 그 종류({@code tickerNote})를
     * 적어 둡니다 — 채권·사채('debt'), 우선주·워런트·유닛('non_common'). 예전에는 이유를 가리지 않고 '매핑표에 없음'이라,
     * 매핑표에 회사를 더하면 덮일 것처럼 읽혔습니다(QA-127). 무엇을 뺄지는 수집기(equities.py)만 정하고 여기서는 옮기기만 합니다.
     * 티커는 찾았는데 가격 시계열이 없으면(매핑표에 막 더해 equity_history가 아직 돌지 않았거나, 야후가 주지 않는 티커)
     * 매핑표가 아니라 가격 쪽 문제라 따로 적습니다(QA-130). 이어받은 가격(isStale)은 부르는 쪽이 먼저 가립니다.
     */
    static String uncoveredReason(JsonNode holding, String ticker) {
        if (ticker != null) {
            return "가격 없음 — 매핑표에는 있으나 가격 시계열을 받지 못함";
        }
        String note = Json.asText(holding, "tickerNote");
        return switch (note == null ? "" : note) {
            case "debt" -> "채권·사채 — 주가로 계산하지 않음";
            case "non_common" -> "보통주가 아닌 증권(우선주·워런트·유닛) — 보통주 가격으로 대신하지 않음";
            default -> "매핑표에 없음";
        };
    }

    /** 매핑표의 섹터. 없으면 "미분류" — String.valueOf(null)은 문자열 "null"을 만들어 화면에 그대로 나갔습니다. */
    static String sectorLabel(JsonNode mapped) {
        String sector = Json.asText(mapped, "sector");
        return sector == null || sector.isBlank() ? "미분류" : sector;
    }
}
