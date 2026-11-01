package com.macrodash.feature.positioning;

import com.macrodash.Kst;
import com.macrodash.analytics.FlowRecord;
import com.macrodash.analytics.InvestorFlows;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.FlowJson;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 투자자별 매매 (토스증권 공식 Open API) — 레이더·국내 파생 화면용 응답 조립.
 *
 * <p>계산은 {@link InvestorFlows}가 하고, 여기서는 저장본을 읽어 넘깁니다.
 * 토스 키가 없거나 아직 수집 전이면 {@code available=false}와 이유를 돌려줍니다.
 */
@Service
public class KrFlowsService {

    /** 한 요청에 받을 최대 종목 수 (레이더 한 화면 30개 + 여유). */
    static final int MAX_CODES = 60;
    /** 20거래일을 덮는 달력 일수 (연휴 여유 포함). */
    static final int LOOKBACK_CALENDAR_DAYS = 45;
    private static final Pattern STOCK_CODE = Pattern.compile("^[0-9A-Z]{6}$");
    private static final String SOURCE = "토스증권 Open API (공식)";
    private static final String NO_DATA =
            "토스 수급 저장본이 없습니다 — .env의 TOSS_CLIENT_ID/SECRET과 허용 IP를 확인하고, "
                    + "데이터 저장소 상태에서 toss_market_flows를 다시 실행하세요.";

    private final StoreReader store;
    private final StoreRepository repository;
    private final KrxService krx;

    public KrFlowsService(StoreReader store, StoreRepository repository, KrxService krx) {
        this.store = store;
        this.repository = repository;
        this.krx = krx;
    }

    /**
     * 코스피·코스닥 시장 전체의 투자자별 매매대금 요약.
     *
     * @return {@code available, unit(KRW), markets: {KOSPI|KOSDAQ: summary + fetchedAt·isStale(+staleReason·staleSince)}}
     *         + 신선도. 저장본 신선도는 마지막으로 받은 시장의 것이라, 이어받은 시장은 {@code isStale}·{@code fetchedAt}을 봅니다
     */
    public Map<String, Object> marketFlows() {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> snapshot = readMarketSnapshot();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("message", NO_DATA);
            return out;
        }
        JsonNode payload = snapshot.get().payload();
        LocalDate today = Kst.today();
        Map<String, Object> markets = new LinkedHashMap<>();
        for (String market : List.of("KOSPI", "KOSDAQ")) {
            JsonNode node = payload.path("markets").path(market);
            List<FlowRecord> records = FlowJson.records(Json.array(node, "records"));
            if (!records.isEmpty()) {
                // 수집 실패로 이어받은 시장(isStale)은 그 시장을 받은 날로 잠정치를 판정합니다 — 장중에 받은 기록은 날이
                // 바뀌어도 잠정치입니다(QA-076). 받은 날을 모르면 오늘.
                boolean stale = Json.asBoolean(node, "isStale");
                LocalDate fetchedOn = stale ? FlowJson.marketFetchedOn(node, snapshot.get().collectedAt()) : null;
                Map<String, Object> summary = InvestorFlows.summarize(records, fetchedOn != null ? fetchedOn : today, 20);
                summary.put("fetchedAt", Json.asText(node, "fetchedAt"));
                summary.put("isStale", stale);
                if (stale) {
                    summary.put("staleReason", Json.asText(node, "staleReason"));
                    summary.put("staleSince", Json.asText(node, "staleSince"));
                }
                markets.put(market, summary);
            }
        }
        out.put("available", !markets.isEmpty());
        out.put("unit", "KRW");
        out.put("source", SOURCE + " — 시장 지표 투자자별 매매대금");
        out.put("note", "외국인은 등록·미등록 합계입니다(종목별 매매동향의 외국인은 등록외국인만).");
        out.put("markets", markets);
        snapshot.get().putFreshness(out);
        return out;
    }

    /**
     * 종목별 투자자 매매동향 요약 (최근 20거래일).
     *
     * @param codes 쉼표로 구분한 종목코드. 형식이 틀린 코드는 무시, 최대 {@value #MAX_CODES}개
     * @return {@code stocks: [{code, available, ...summary}]} — 저장본이 없는 종목은 available=false
     */
    public Map<String, Object> stockFlows(String codes) {
        Set<String> requested = parseCodes(codes);
        Map<String, List<JsonNode>> series = repository.readObservationSeries(
                Datasets.OBS_TOSS_STOCK_FLOW, requested, Kst.today().minusDays(LOOKBACK_CALENDAR_DAYS));
        LocalDate today = Kst.today();

        List<Map<String, Object>> stocks = new ArrayList<>();
        for (String code : requested) {
            List<FlowRecord> records = FlowJson.records(series.getOrDefault(code, List.of()));
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("code", code);
            row.put("available", !records.isEmpty());
            if (!records.isEmpty()) {
                row.putAll(InvestorFlows.summarize(records.subList(0, Math.min(20, records.size())), today, 0));
            }
            stocks.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", !series.isEmpty());
        out.put("unit", "주");
        out.put("source", SOURCE + " — 종목 투자자별 매매동향");
        out.put("note", "순매수 = 매수 − 매도 거래량(주). 외국인은 등록외국인 기준. "
                + "당일 기록은 장중 잠정치라 개인·기관 세부가 비어 있을 수 있습니다.");
        out.put("stocks", stocks);
        if (series.isEmpty() && !requested.isEmpty()) {
            out.put("message", NO_DATA.replace("toss_market_flows", "toss_stock_flows"));
        }
        return out;
    }

    /**
     * 코스피 현물(토스 공식, 원)과 KOSPI200 선물(Daum, 계약)의 투자자별 방향 비교.
     *
     * @return {@code available, spotDate, futuresDate, sameDay, rows[], spotFetchedAt, spotIsStale(+spotStaleReason·
     *         spotStaleSince)} + 신선도. 저장본 신선도는 마지막으로 받은 시장의 것이라, 이어받은 현물은
     *         {@code spotIsStale}·{@code spotFetchedAt}을 봅니다
     */
    public Map<String, Object> spotFutures() {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> snapshot = readMarketSnapshot();
        JsonNode kospi = snapshot.filter(s -> s.payload() != null)
                .map(s -> s.payload().path("markets").path("KOSPI"))
                .orElse(null);
        List<FlowRecord> spot = FlowJson.records(Json.array(kospi, "records"));
        Map<String, Object> futures = krx.investorTrend();
        Object rows = futures.get("rows");
        List<JsonNode> futuresRows = new ArrayList<>();
        if (rows instanceof JsonNode node && node.isArray()) {
            node.forEach(futuresRows::add);
        }

        if (spot.isEmpty() || futuresRows.isEmpty()) {
            out.put("available", false);
            out.put("message", spot.isEmpty() ? NO_DATA : "Daum 선물 수급 저장본이 없습니다.");
            return out;
        }
        out.put("available", true);
        out.putAll(InvestorFlows.spotFutures(
                spot, FlowJson.futuresRows(futuresRows), (String) futures.get("dataDate")));
        out.put("spotSource", SOURCE + " — 코스피 투자자별 매매대금(원)");
        out.put("futuresSource", futures.get("source") + " — 계약");
        snapshot.get().putFreshness(out);
        // 저장본 수집 시각은 마지막으로 받은 시장(코스닥일 수 있음)의 것입니다. KOSPI만 실패해 이어받은 현물은 그 시각과
        // 달리 예전 값이라, KOSPI를 받은 시각과 이전 값 표시를 따로 내립니다(QA-116, 시장 수급의 QA-076과 같은 규칙).
        // 받은 시각이 없는 예전 저장본은 null입니다.
        boolean spotStale = Json.asBoolean(kospi, "isStale");
        out.put("spotFetchedAt", Json.asText(kospi, "fetchedAt"));
        out.put("spotIsStale", spotStale);
        if (spotStale) {
            out.put("spotStaleReason", Json.asText(kospi, "staleReason"));
            out.put("spotStaleSince", Json.asText(kospi, "staleSince"));
        }
        return out;
    }

    private Optional<Snapshot> readMarketSnapshot() {
        return store.read(Datasets.SNAP_TOSS_MARKET_FLOWS, Datasets.MAX_AGE_DAILY, "toss_market_flows");
    }

    static Set<String> parseCodes(String codes) {
        Set<String> out = new LinkedHashSet<>();
        if (codes == null) {
            return out;
        }
        for (String raw : codes.split(",")) {
            String code = raw.trim().toUpperCase();
            if (STOCK_CODE.matcher(code).matches()) {
                out.add(code);
            }
            if (out.size() >= MAX_CODES) {
                break;
            }
        }
        return out;
    }
}
