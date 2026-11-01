package com.macrodash.feature.positioning;

import com.macrodash.support.Params;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 누가 어느 쪽에 서 있나 — 글로벌 투기세력(COT) · 국내 파생 · 외국인/기관 수급 레이더.
 *
 * <pre>
 *  GET /api/cot/*     CFTC COT 포지션·극단값
 *  GET /api/krx/*     KOSPI200 선물·투자주체 수급·장중 가속도·미결제약정
 *  GET /api/radar/*   수급 랭킹·공통 종목·누적 이력·소스 진단
 * </pre>
 *
 * <p>토스 공식 API로 받은 투자자별 매매({@code /api/kr/*}, {@code /api/krx/spot-futures})는
 * 출처(키)가 달라 {@link FlowsController}에 있습니다.
 */
@RestController
@RequestMapping("/api")
public class PositioningController {

    private final CotService cot;
    private final KrxService krx;
    private final RadarService radar;

    public PositioningController(CotService cot, KrxService krx, RadarService radar) {
        this.cot = cot;
        this.krx = krx;
        this.radar = radar;
    }

    // ------------------------------------------------------ COT
    @GetMapping("/cot/assets")
    public Map<String, Object> cotAssets() {
        return cot.assetList();
    }

    @GetMapping("/cot/overview")
    public Map<String, Object> cotOverview() {
        return cot.overview();
    }

    @GetMapping("/cot/asset")
    public Map<String, Object> cotAsset(@RequestParam String name) {
        return cot.asset(name);
    }

    /** 극단 포지션 이후 4·13주 수익률 분포 (가격은 ETF 대용). */
    @GetMapping("/cot/extremes")
    public Map<String, Object> cotExtremes(
            @RequestParam String name,
            @RequestParam(defaultValue = "95") double percentile,
            @RequestParam(defaultValue = "52") int lookbackWeeks) {
        return cot.extremes(name, percentile, lookbackWeeks);
    }

    // ------------------------------------------------------ KRX
    @GetMapping("/krx/futures")
    public Map<String, Object> krxFutures(@RequestParam(defaultValue = "40") Integer days) {
        return krx.futures(days);
    }

    @GetMapping("/krx/investor-trend")
    public Map<String, Object> krxInvestorTrend() {
        return krx.investorTrend();
    }

    @GetMapping("/krx/intraday")
    public Map<String, Object> krxIntraday(@RequestParam(defaultValue = "30") int minutes) {
        return krx.intradayAcceleration(minutes);
    }

    @GetMapping("/krx/oi-trend")
    public Map<String, Object> krxOpenInterestTrend() {
        return krx.openInterestTrend();
    }

    // ------------------------------------------------------- 레이더
    @GetMapping("/radar/options")
    public Map<String, Object> radarOptions() {
        return radar.options();
    }

    @GetMapping("/radar/ranking")
    public Map<String, Object> radarRanking(
            @RequestParam(defaultValue = "KOSPI") String market,
            @RequestParam(defaultValue = "외국인") String investor,
            @RequestParam(defaultValue = "순매수") String tradeType,
            @RequestParam(defaultValue = "30") int topN,
            @RequestParam(defaultValue = "TODAY") String intervalType,
            @RequestParam(required = false) String targetDate) {
        // 모르는 값을 넘기면 수집기가 임의 이름의 저장본·이력을 만들었습니다(QA-037).
        Params.oneOf("investor", investor, RadarService.INVESTORS);
        Params.oneOf("tradeType", tradeType, RadarService.TRADE_TYPES);
        Params.oneOf("intervalType", intervalType, RadarService.INTERVALS);
        return radar.ranking(market, investor, tradeType, topN, intervalType, targetDate);
    }

    /**
     * 외국인·기관이 같은 방향으로 움직인 종목.
     *
     * <p>두 주체의 상위 목록을 각각 받아 종목코드로 맞춘 교집합입니다.
     * 상위 N 밖의 종목은 소스가 주지 않아 포함되지 않습니다.
     */
    @GetMapping("/radar/consensus")
    public Map<String, Object> radarConsensus(
            @RequestParam(defaultValue = "KOSPI") String market,
            @RequestParam(defaultValue = "순매수") String tradeType,
            @RequestParam(defaultValue = "30") int topN,
            @RequestParam(defaultValue = "TODAY") String intervalType) {
        return radar.consensus(market, tradeType, topN, intervalType);
    }

    @GetMapping("/radar/history")
    public Map<String, Object> radarHistory(
            @RequestParam(required = false) String market,
            @RequestParam(required = false) String investor,
            @RequestParam(required = false) String tradeType,
            @RequestParam(required = false) String obsDate,
            @RequestParam(required = false) String startDate,
            @RequestParam(defaultValue = "false") boolean latest) {
        return radar.history(market, investor, tradeType, obsDate, startDate, latest);
    }

    @GetMapping("/radar/diagnostics")
    public Map<String, Object> radarDiagnostics() {
        return radar.diagnostics();
    }
}
