package com.macrodash.feature.macro;

import com.macrodash.Kst;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.NavigableMap;

/**
 * 연준 순유동성 트래커.
 *
 * <p>순유동성 = WALCL(연준 총자산) − TGA(재무부 일반계정) − ON RRP(역레포).
 * 시장에 실제로 남아 있는 달러 유동성의 근사치입니다.
 *
 * <p>수집기가 이미 계산해 둔 시계열을 읽어 최신값·변화·분해 항목을 정리합니다.
 */
@Service
public class LiquidityService {

    private final StoreReader store;

    public LiquidityService(StoreReader store) {
        this.store = store;
    }

    public Map<String, Object> netLiquidity(Integer years) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_FED_LIQUIDITY, Datasets.MAX_AGE_DAILY, "fed_liquidity");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "순유동성 저장본이 없습니다. 수집기를 실행하세요.");
            return out;
        }

        Snapshot snap = snapshot.get();
        JsonNode payload = snap.payload();
        List<JsonNode> rows = Json.array(payload, "rows");

        if (years != null && years > 0) {
            LocalDate cutoff = Kst.yearsAgo(years);
            rows = rows.stream()
                    .filter(row -> {
                        LocalDate date = Json.parseDate(Json.asText(row, "date"));
                        return date != null && !date.isBefore(cutoff);
                    })
                    .toList();
        }

        List<Double> netValues = new ArrayList<>();
        NavigableMap<LocalDate, Double> netByDate = new TreeMap<>();
        for (JsonNode row : rows) {
            Double value = Json.asDouble(row, "netLiquidityT");
            if (value != null) {
                netValues.add(value);
                LocalDate date = Json.parseDate(Json.asText(row, "date"));
                if (date != null) {
                    netByDate.put(date, value);
                }
            }
        }

        Double latest = SeriesMath.last(netValues);
        Double previous = SeriesMath.previous(netValues);

        out.put("available", !rows.isEmpty());
        // 주의: 추정치 여부를 그대로 전달합니다. 화면은 이 값을 보고 경고해야 합니다.
        out.put("isEstimated", Json.asBoolean(payload, "isEstimated") || snap.isEstimated());
        snap.putFreshness(out);
        out.put("stale", !snap.isFresh(Datasets.MAX_AGE_DAILY));
        // 차트용 행은 1년보다 오래된 구간을 주 단위(그 주의 마지막 행)로 솎습니다. 최신값·4주/12주 변화는
        // 위에서 전체 행으로 계산했습니다.
        out.put("rows", SeriesMath.thinOlderThan(rows,
                row -> Json.parseDate(Json.asText(row, "date")), Kst.today().minusYears(1)));

        Map<String, Object> latestBlock = new LinkedHashMap<>();
        latestBlock.put("netLiquidityT", latest);
        latestBlock.put("previousT", previous);
        latestBlock.put("deltaT", SeriesMath.difference(latest, previous));
        latestBlock.put("pct", SeriesMath.percentChange(latest, previous));

        if (!rows.isEmpty()) {
            JsonNode last = rows.get(rows.size() - 1);
            latestBlock.put("date", Json.asText(last, "date"));
            latestBlock.put("walclT", Json.asDouble(last, "walclT"));
            latestBlock.put("tgaB", Json.asDouble(last, "wtregenB"));
            latestBlock.put("rrpB", Json.asDouble(last, "rrpB"));
        }
        out.put("latest", latestBlock);

        // 4주/12주 변화 — 유동성은 방향과 속도가 함께 중요합니다. 행은 WALCL(주간)·TGA·RRP(일간)
        // 날짜의 합집합이라 일 단위이므로, 행 수가 아니라 날짜로 셉니다(국면 화면과 같은 계산).
        Map<String, Object> momentum = new LinkedHashMap<>();
        momentum.put("change4w", SeriesMath.changeOverWeeks(netByDate, 4));
        momentum.put("change12w", SeriesMath.changeOverWeeks(netByDate, 12));
        out.put("momentum", momentum);

        return out;
    }
}
