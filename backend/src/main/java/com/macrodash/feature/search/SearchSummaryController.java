package com.macrodash.feature.search;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 검색 AI 요약(운영자 전용, 계약 docs/specs/2026-11-14-info-search-contract.md §9-6).
 *
 * <pre>
 *  POST /api/search/summary   {e, tab, range} → 받아 둔 결과의 고른 기간 최근 40줄을 한국어 요약 5줄 안팎으로(줄마다 근거 줄 id)
 * </pre>
 *
 * <p>상태를 바꾸지 않지만 유료 모델을 부르므로 POST입니다(QA 퍼저가 부르지 않음 — scripts/qa/routes.json). 경로 등급은 {@code AccessPolicy}의 운영자이고,
 * 서비스가 한 번 더 막습니다.
 */
@RestController
@RequestMapping("/api/search")
public class SearchSummaryController {

    private final SearchSummaryService summaries;

    public SearchSummaryController(SearchSummaryService summaries) {
        this.summaries = summaries;
    }

    /** 요약 요청 — 대상 키·탭(비면 타임라인)·기간(비면 30일). */
    public record SummaryRequest(String e, String tab, String range) {
    }

    @PostMapping("/summary")
    public Map<String, Object> summary(@RequestBody(required = false) SummaryRequest body, HttpServletRequest request) {
        SummaryRequest input = body == null ? new SummaryRequest(null, null, null) : body;
        return summaries.summarize(input.e(), input.tab(), input.range(), CurrentUser.of(request));
    }
}
