package com.macrodash.feature.publicdata;

import com.macrodash.Kst;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository.TimeseriesPoint;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 국내 증시 규모 — 시장별 시가총액·거래대금 합계 (금융위 공식 시세).
 *
 * <p>지수(KOSPI 2,500)는 "가격"만 보여 줍니다. 시가총액 합계는 신규 상장·증자까지
 * 반영한 시장의 크기이고, 거래대금은 참여 강도입니다. 둘 다 거래소 확정치를
 * 전 종목 합산한 값입니다(수집기 fsc_prices).
 */
@Service
public class KrMarketService {

    /** 보여 줄 시장. 합계가 의미 있는 두 시장만(KONEX는 규모가 작아 선이 바닥에 붙습니다). */
    static final List<String> MARKETS = List.of("KOSPI", "KOSDAQ");

    private final StoreReader store;
    private final StoreRepository repository;

    public KrMarketService(StoreReader store, StoreRepository repository) {
        this.store = store;
        this.repository = repository;
    }

    /**
     * @param days 조회 기간(일). 20~400으로 제한
     * @return 시장별 {marketCap, tradingValue} 점 목록(원) + 최신 기준일
     */
    public Map<String, Object> totals(int days) {
        int span = Math.max(20, Math.min(days, 400));
        LocalDate from = Kst.today().minusDays(span);

        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> meta = store.read(Datasets.SNAP_FSC_PRICES_META, Datasets.MAX_AGE_DAILY, "fsc_prices");
        if (meta.isEmpty() || meta.get().payload() == null) {
            out.put("available", false);
            out.put("message", "공식 시세 저장본이 없습니다. DATA_GO_KR_SERVICE_KEY를 설정하고 "
                    + "금융위원회_주식시세정보 활용신청을 확인하세요.");
            out.put("markets", List.of());
            return out;
        }
        meta.get().putFreshness(out);
        JsonNode payload = meta.get().payload();
        out.put("available", true);
        out.put("source", Json.asText(payload, "source"));
        out.put("latestBasDt", Json.asText(payload, "latestBasDt"));

        List<Map<String, Object>> markets = new ArrayList<>();
        for (String market : MARKETS) {
            List<TimeseriesPoint> caps = repository.readTimeseries(Datasets.TS_FSC_MARKET, market + ".marketCap", from);
            List<TimeseriesPoint> values = repository.readTimeseries(Datasets.TS_FSC_MARKET, market + ".tradingValue", from);
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("market", market);
            one.put("marketCap", points(caps));
            one.put("tradingValue", points(values));
            markets.add(one);
        }
        out.put("markets", markets);
        return out;
    }

    private static List<Map<String, Object>> points(List<TimeseriesPoint> series) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (TimeseriesPoint point : series) {
            if (point.value() != null) {
                out.add(Map.of("date", point.date().toString(), "value", point.value()));
            }
        }
        return out;
    }
}
