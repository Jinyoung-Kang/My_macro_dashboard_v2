package com.macrodash.feature.positioning;

import com.macrodash.analytics.SeriesMath;
import com.macrodash.collector.CollectorClient;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 국내 파생 & 투기세력 (KRX).
 *
 * <p>KOSPI200 선물 종가·미결제약정·베이시스, 4대 국면 판정, 한국판 COT Index,
 * Daum 투자주체별 선물 수급(계약수 기준), 장중 수급 가속도.
 *
 * <p><b>이 화면이 특히 조심해야 하는 것</b>
 * <ul>
 *   <li>등락률이 없으면 국면은 "판정 불가"입니다. 어느 쪽으로도 기울이지 않습니다.
 *       (구버전은 결측을 0.0으로 메워 하락한 날에도 '신규 롱'으로 표시했습니다.)</li>
 *   <li>추정치(KODEX 200 기반)일 때는 화면이 반드시 그 사실을 표시해야 합니다.</li>
 *   <li>Daum 선물 수급은 <b>계약수</b>만 제공합니다. 금액(억원) 기준은 없습니다.</li>
 * </ul>
 */
@Service
public class KrxService {

    private final StoreReader store;
    private final CollectorClient collector;

    public KrxService(StoreReader store, CollectorClient collector) {
        this.store = store;
        this.collector = collector;
    }

    public Map<String, Object> futures(Integer days) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_KRX_FUTURES, Datasets.MAX_AGE_DAILY, "krx_futures");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "KRX 선물 저장본이 없습니다. 수집기를 실행하세요.");
            return out;
        }

        Snapshot snap = snapshot.get();
        List<JsonNode> rows = Json.array(snap.payload(), "rows");
        if (days != null && days > 0 && rows.size() > days) {
            rows = rows.subList(rows.size() - days, rows.size());
        }

        boolean estimated = Json.asBoolean(snap.payload(), "isEstimated") || snap.isEstimated();

        out.put("available", !rows.isEmpty());
        out.put("isEstimated", estimated);
        if (estimated) {
            out.put("estimateNotice",
                    "KRX 수집 실패로 KODEX 200 기반 추정치를 보여 주고 있습니다. "
                            + "미결제약정·베이시스는 추정하지 않으므로 비어 있습니다.");
        }
        snap.putFreshness(out);
        out.put("stale", !snap.isFresh(Datasets.MAX_AGE_DAILY));
        out.put("rows", rows);
        out.put("latest", latestBlock(rows));
        return out;
    }

    private Map<String, Object> latestBlock(List<JsonNode> rows) {
        Map<String, Object> latest = new LinkedHashMap<>();
        if (rows.isEmpty()) {
            return latest;
        }

        JsonNode last = rows.get(rows.size() - 1);
        latest.put("date", Json.asText(last, "date"));
        latest.put("futuresClose", Json.asDouble(last, "futuresClose"));
        latest.put("changePct", Json.asDouble(last, "changePct"));
        latest.put("changePctReported", Json.asDouble(last, "changePctReported"));
        latest.put("volume", Json.asDouble(last, "volume"));
        latest.put("openInterest", Json.asDouble(last, "openInterest"));
        latest.put("oiChange", Json.asDouble(last, "oiChange"));
        latest.put("marketBasis", Json.asDouble(last, "marketBasis"));
        latest.put("theoryPrice", Json.asDouble(last, "theoryPrice"));
        latest.put("contractName", Json.asText(last, "contractName"));
        latest.put("marketPhase", Json.asText(last, "marketPhase"));
        latest.put("cotOiIndex", Json.asDouble(last, "cotOiIndex"));

        // 베이시스 해석: 콘탱고(+)/백워데이션(-)
        Double basis = Json.asDouble(last, "marketBasis");
        if (basis == null) {
            latest.put("basisState", "데이터 미제공");
            latest.put("basisNote",
                    "KRX 지수 조회가 실패해 베이시스를 계산하지 못했습니다. "
                            + "0으로 메우지 않습니다.");
        } else if (basis >= 0) {
            latest.put("basisState", "콘탱고 (선물 고평가)");
            latest.put("basisNote", "프로그램 매수 차익거래 유인이 있는 구간입니다.");
        } else {
            latest.put("basisState", "백워데이션 (선물 저평가)");
            latest.put("basisNote", "프로그램 매도 차익거래 유인이 있는 구간입니다.");
        }

        // 5일 평균 OI 변화 — 방향이 유지되는지 봅니다.
        int window = Math.min(5, rows.size());
        double sum = 0;
        int count = 0;
        for (int i = rows.size() - window; i < rows.size(); i++) {
            Double change = Json.asDouble(rows.get(i), "oiChange");
            if (change != null) {
                sum += change;
                count++;
            }
        }
        latest.put("oiChange5dAvg", count == 0 ? null : sum / count);
        return latest;
    }

    /** Daum 투자주체별 선물 수급 (계약수 기준). */
    public Map<String, Object> investorTrend() {
        Optional<Snapshot> snapshot = store.read(
                Datasets.daumFuturesTrend(Datasets.DAUM_TREND_LOOKBACK),
                Datasets.MAX_AGE_DAILY, "daum_futures_trend");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("measure", "CONTRACT");
            out.put("unit", "계약");
            out.put("message", "Daum 선물 수급 저장본이 없습니다.");
            return out;
        }

        JsonNode payload = snapshot.get().payload();
        out.put("available", !Json.array(payload, "rows").isEmpty());
        snapshot.get().putFreshness(out);
        out.put("dataDate", Json.asText(payload, "dataDate"));
        // 금액(억원) 기준은 Daum이 제공하지 않습니다. 단위를 명시해 오해를 막습니다.
        out.put("measure", Json.asText(payload, "measure"));
        out.put("unit", Json.asText(payload, "unit"));
        out.put("source", "Daum 금융 투자주체별 매매동향 (비공식)");
        out.put("rows", payload.get("rows"));
        return out;
    }

    /**
     * 장중 선물 수급 가속도 (최근 N분 변화).
     *
     * <p>1분 단위로 변하는 값이라 저장하지 않고 수집기에 직접 물어봅니다.
     * store_only 모드에서는 외부를 부르지 않는다는 약속이 우선이므로 건너뜁니다.
     */
    public Map<String, Object> intradayAcceleration(int minutes) {
        if (store.readMode() == com.macrodash.config.AppProperties.ReadMode.STORE_ONLY) {
            return Map.of(
                    "available", false,
                    "skipped", true,
                    "message", "store_only 모드에서는 장중 수급 가속도를 조회하지 않습니다.");
        }

        Optional<JsonNode> payload = collector.daumIntraday(minutes);
        if (payload.isEmpty()) {
            return Map.of(
                    "available", false,
                    "message", "수집기에서 장중 수급을 받지 못했습니다.");
        }

        Map<String, Object> out = new LinkedHashMap<>();
        payload.get().properties().forEach(entry ->
                out.put(entry.getKey(), entry.getValue()));
        return out;
    }

    /** 미결제약정 추세 요약 (COT Index 기반). */
    public Map<String, Object> openInterestTrend() {
        Map<String, Object> futures = futures(60);
        Object rowsObject = futures.get("rows");

        Map<String, Object> out = new LinkedHashMap<>();
        if (!(rowsObject instanceof List<?> rows) || rows.isEmpty()) {
            out.put("available", false);
            return out;
        }

        List<Double> index = new java.util.ArrayList<>();
        for (Object row : rows) {
            if (row instanceof JsonNode node) {
                Double value = Json.asDouble(node, "cotOiIndex");
                if (value != null) {
                    index.add(value);
                }
            }
        }

        out.put("available", !index.isEmpty());
        out.put("latest", SeriesMath.last(index));
        out.put("previous", SeriesMath.previous(index));
        out.put("delta", SeriesMath.difference(
                SeriesMath.last(index), SeriesMath.previous(index)));
        return out;
    }
}
