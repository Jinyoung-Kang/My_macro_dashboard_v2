package com.macrodash.feature.insight;

import com.macrodash.read.ComputedCache;
import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 저장된 여러 데이터를 엮어 계산하는 분석 — 지표 상관관계 · 시장 국면 · 종목 스코어카드.
 *
 * <pre>
 *  GET /api/analytics/*   상관 분석 계열·상관계수·국면
 *  GET /api/stock/*       스코어카드 종목·스코어카드
 * </pre>
 */
@RestController
@RequestMapping("/api")
public class AnalyticsController {

    private final AnalyticsService analytics;
    private final ScorecardService scorecard;
    private final RegimeLogService regimeLog;
    private final TrackRecordService trackRecord;

    private final ComputedCache cache;

    public AnalyticsController(AnalyticsService analytics, ScorecardService scorecard,
                               RegimeLogService regimeLog, TrackRecordService trackRecord, ComputedCache cache) {
        this.analytics = analytics;
        this.scorecard = scorecard;
        this.regimeLog = regimeLog;
        this.trackRecord = trackRecord;
        this.cache = cache;
    }

    // ----------------------------------------------- 상관관계 · 국면
    /** 상관 분석에 쓸 수 있는 계열 목록. */
    @GetMapping("/analytics/series")
    public Map<String, Object> analyticsSeries() {
        return Map.of("series", analytics.catalog());
    }

    /**
     * 두 계열의 상관관계.
     *
     * @param mode change(기본, 변화끼리) 또는 level(수준끼리 — 허위 상관 주의)
     */
    @GetMapping("/analytics/correlation")
    public Map<String, Object> correlation(
            @RequestParam String x,
            @RequestParam String y,
            @RequestParam(defaultValue = "60") int window,
            @RequestParam(defaultValue = "3") int years,
            @RequestParam(defaultValue = "change") String mode) {
        return analytics.correlation(x, y, window, years, mode);
    }

    /** 성장·신용 축 × 유동성 축으로 판정한 시장 국면. */
    @GetMapping("/analytics/regime")
    public Map<String, Object> regime(@RequestParam(defaultValue = "5") int years) {
        return cache.get("analytics.regime:" + years, () -> analytics.regime(years));
    }

    /**
     * 국면 판정 라이브 기록(최근 순). 저장본이 아니라 판정 기록 테이블에서 나오므로 응답 캐시를 쓰지 않습니다 —
     * 캐시의 버전(저장본 수집 시각)이 기록이 늘어난 것을 모릅니다.
     */
    @GetMapping("/analytics/regime/log")
    public Map<String, Object> regimeLog(@RequestParam(defaultValue = "90") int limit, HttpServletRequest request) {
        return regimeLog.recent(limit, CurrentUser.paid(request));
    }

    /**
     * 국면 판정 성과 — 판정을 과거에 적용했을 때 4·13·26주 뒤 수익률(국면 시작 시점·머문 모든 주)과 비교 기준.
     * 입력(누적 시계열)과 가격은 같은 수집 태스크가 저장본과 함께 쓰므로, 저장본 버전으로 캐시해도 낡지 않습니다.
     */
    @GetMapping("/analytics/regime/track-record")
    public Map<String, Object> regimeTrackRecord(@RequestParam(defaultValue = "SPY") String asset,
                                                 HttpServletRequest request) {
        boolean pro = CurrentUser.paid(request);
        // 등급마다 응답 범위가 달라 캐시 키에 등급을 넣습니다 — 빼면 서로의 캐시된 응답을 받습니다.
        return cache.get("analytics.regime.track:" + asset + ":" + (pro ? "pro" : "free"),
                () -> trackRecord.trackRecord(asset, pro));
    }

    // ----------------------------------------------------- 스코어카드
    /** 스코어카드를 낼 수 있는 종목 목록. */
    @GetMapping("/stock/universe")
    public Map<String, Object> stockUniverse() {
        return scorecard.universe();
    }

    /**
     * 종목 스코어카드 — <b>가격으로 잴 수 있는 것만</b>.
     *
     * <p>재무·성장·밸류에이션은 수집하지 않아 빠져 있습니다. 응답의
     * {@code missing}과 {@code caveat}이 그 사실을 함께 전달합니다.
     */
    @GetMapping("/stock/scorecard")
    public Map<String, Object> stockScorecard(
            @RequestParam String symbol,
            @RequestParam(defaultValue = "SPY") String benchmark,
            @RequestParam(defaultValue = "1") int years) {
        return cache.get("stock.scorecard:" + symbol + ":" + benchmark + ":" + years,
                () -> scorecard.scorecard(symbol, benchmark, years));
    }
}
