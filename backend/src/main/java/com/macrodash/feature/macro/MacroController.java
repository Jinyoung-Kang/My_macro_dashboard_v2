package com.macrodash.feature.macro;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 거시경제 매크로 지표 · 연준 순유동성 · 섹터 &amp; 자산군 로테이션.
 *
 * <pre>
 *  GET /api/macro/*       매크로 카드·위험·심화 지표·환율·FRED·티커
 *  GET /api/liquidity     순유동성
 *  GET /api/sector/*      로테이션·모멘텀
 * </pre>
 */
@RestController
@RequestMapping("/api")
public class MacroController {

    private final MacroService macro;
    private final FxService fx;
    private final LiquidityService liquidity;
    private final SectorService sector;

    public MacroController(MacroService macro,
                           FxService fx,
                           LiquidityService liquidity,
                           SectorService sector) {
        this.macro = macro;
        this.fx = fx;
        this.liquidity = liquidity;
        this.sector = sector;
    }

    // ------------------------------------------------------- 매크로
    /**
     * @param live 매크로 화면의 자동 갱신이 켜져 있으면 true.
     *             저장본을 다시 받을 기준이 15분 → 60초로 내려갑니다.
     *             (더 짧게 두지 않는 이유는 Datasets.MAX_AGE_LIVE 주석에)
     */
    @GetMapping("/macro/overview")
    public Map<String, Object> macroOverview(
            @RequestParam(name = "live", defaultValue = "false") boolean live) {
        return macro.overview(live);
    }

    @GetMapping("/macro/risk")
    public Map<String, Object> macroRisk() {
        return macro.riskIndicators();
    }

    @GetMapping("/macro/advanced")
    public Map<String, Object> macroAdvanced() {
        return macro.advancedIndicators();
    }

    /** 원/달러 환율 (달러 금액을 원화로 병기할 때 씁니다). */
    @GetMapping("/macro/usdkrw")
    public Map<String, Object> usdKrw() {
        return macro.usdKrw();
    }

    /**
     * 환율·달러인덱스 비교 차트 (여러 계열 겹쳐 보기).
     *
     * @param ids    쉼표로 구분한 계열 키. 비면 기본 선택(원/달러 + 달러 인덱스)
     * @param mode   index = 기준일 100 (기본) · raw = 원래 단위
     */
    @GetMapping("/macro/fx")
    public Map<String, Object> macroFx(
            @RequestParam(required = false) String ids,
            @RequestParam(defaultValue = "1y") String period,
            @RequestParam(defaultValue = "index") String mode) {
        return fx.series(ids, period, mode);
    }

    @GetMapping("/macro/fx/options")
    public Map<String, Object> macroFxOptions() {
        return Map.of("periods", FxService.PERIODS, "defaultIds", FxService.DEFAULT_IDS);
    }

    @GetMapping("/macro/scraped")
    public Map<String, Object> macroScraped() {
        return macro.scrapedMarkets();
    }

    @GetMapping("/macro/spread")
    public Map<String, Object> macroSpread(
            @RequestParam(defaultValue = "DGS10") String longId,
            @RequestParam(defaultValue = "DGS2") String shortId) {
        return macro.officialSpread(longId, shortId);
    }

    @GetMapping("/macro/fred/{seriesId}")
    public Map<String, Object> fredSeries(@PathVariable String seriesId,
                                          @RequestParam(required = false) Integer years) {
        return macro.fredSeries(seriesId, years);
    }

    @GetMapping("/macro/ticker")
    public Map<String, Object> ticker(@RequestParam String symbol,
                                      @RequestParam(defaultValue = "1y") String period) {
        return macro.tickerSeries(symbol, period);
    }

    // ------------------------------------------------------ 순유동성
    @GetMapping("/liquidity")
    public Map<String, Object> liquidity(@RequestParam(required = false) Integer years) {
        return liquidity.netLiquidity(years);
    }

    // ------------------------------------------------------ 로테이션
    @GetMapping("/sector/rotation")
    public Map<String, Object> rotation(@RequestParam(defaultValue = "1M") String period) {
        return sector.rotation(period);
    }

    @GetMapping("/sector/momentum")
    public Map<String, Object> momentum() {
        return sector.momentum();
    }
}
