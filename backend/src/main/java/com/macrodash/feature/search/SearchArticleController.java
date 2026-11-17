package com.macrodash.feature.search;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 검색 본문 보기(운영자 전용, ADR 0043, 계약 docs/specs/2026-11-14-info-search-contract.md §10).
 *
 * <pre>
 *  POST /api/search/article             {ref} → 운영 서버가 그 결과 줄의 글 한 건을 받아 본문만(처음엔 pending — 화면이 같은 경로를 다시 부름)
 *  POST /api/search/article/translate   {ref} → 받아 둔 본문을 한국어로(저장하지 않음 — 서버 메모리 24시간)
 * </pre>
 *
 * <p>상태를 바꾸지 않지만 외부 기사를 받고 유료 모델을 부르므로 POST입니다(QA 퍼저가 부르지 않음 — scripts/qa/routes.json). 경로 등급은
 * {@code AccessPolicy}의 운영자이고, 서비스가 한 번 더 막습니다.
 */
@RestController
@RequestMapping("/api/search")
public class SearchArticleController {

    private final SearchArticleService articles;

    public SearchArticleController(SearchArticleService articles) {
        this.articles = articles;
    }

    /** 본문 보기 요청 — 결과 줄의 꼬리표(bodyRef). */
    public record ArticleRequest(String ref) {
    }

    @PostMapping("/article")
    public Map<String, Object> article(@RequestBody(required = false) ArticleRequest body, HttpServletRequest request) {
        return articles.article(body == null ? null : body.ref(), CurrentUser.of(request));
    }

    @PostMapping("/article/translate")
    public Map<String, Object> translate(@RequestBody(required = false) ArticleRequest body, HttpServletRequest request) {
        return articles.translate(body == null ? null : body.ref(), CurrentUser.of(request));
    }
}
