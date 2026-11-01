package com.macrodash.feature.detail;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 검색 상세 화면(종목 {@code /s/<시장>/<코드>}·지표 {@code /markets/i/<id>}·기관 {@code /institutions/<CIK>})의 외부 정보와 AI 요약.
 * 차트는 기존 {@code GET /api/macro/ticker}, 대시보드 자료(스코어카드·13F 보유 기관·국내 재무)는 기존 경로를 화면이 함께 부릅니다.
 */
@RestController
@RequestMapping("/api/detail")
public class DetailController {

    private final DetailService details;
    private final DetailSummaryService summaries;

    public DetailController(DetailService details, DetailSummaryService summaries) {
        this.details = details;
        this.summaries = summaries;
    }

    /** 시세·핵심 지표·개요(미국·해외 Yahoo, 국내 네이버). */
    @GetMapping("/quote")
    public Map<String, Object> quote(@RequestParam String market, @RequestParam String code) {
        return details.quote(market, code);
    }

    /** 주요 뉴스 — 종목(시장·코드) 뉴스와 검색어(q) 구글 뉴스. */
    @GetMapping("/news")
    public Map<String, Object> news(@RequestParam(required = false) String market,
                                    @RequestParam(required = false) String code,
                                    @RequestParam(required = false) String q) {
        return details.news(market, code, q);
    }

    /** 종목 찾기(통합 검색이 저장된 색인 밖의 종목을 찾을 때). */
    @GetMapping("/symbols")
    public Map<String, Object> symbols(@RequestParam(required = false) String q) {
        return details.symbols(q);
    }

    /** AI 요약(유료 등급 — Claude 호출, 하루 한도). 본문 {@code {market?, code?, q?, label?}}. */
    @PostMapping("/summary")
    public Map<String, Object> summary(@RequestBody DetailSummaryService.Request request, HttpServletRequest http) {
        return summaries.summarize(request, CurrentUser.of(http));
    }
}
