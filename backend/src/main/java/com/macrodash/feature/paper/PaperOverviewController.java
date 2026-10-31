package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 모의 매매 개요(운영자 전용).
 *
 * <pre>
 *  GET  /api/paper/overview?market=US   계좌 요약·순자산 곡선·관측치 신선도·한계 문구·작업 기록(시장 US·KR, 없으면 US) + 계좌마다 장중 지금 값(current)
 * </pre>
 *
 * <p>장부 응답은 {@link PaperQueryService} 그대로이고, 표시 전용 지금 값을 덧붙이는 조립은 {@link PaperOverviewService}입니다(명세
 * docs/specs/2026-10-31-paper-live-overview.md). {@code market}이 없으면 미국, 모르는 값은 400(2단계 명세 §4-16).
 */
@RestController
@RequestMapping("/api/paper")
public class PaperOverviewController {

    private final PaperOverviewService overviews;

    public PaperOverviewController(PaperOverviewService overviews) {
        this.overviews = overviews;
    }

    @GetMapping("/overview")
    public Map<String, Object> overview(@RequestParam(required = false) String market) {
        return overviews.overview(market);
    }
}
