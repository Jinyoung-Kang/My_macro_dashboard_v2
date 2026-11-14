package com.macrodash.feature.search;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 검색(사이드바 '정보 검색' {@code /search}, ADR 0041) — 회원 경로 여섯. 응답 모양은 계약(docs/specs/2026-11-14-info-search-contract.md §3·§6-4·§7-5)이
 * 정본이고, 수집기 응답에 {@code available}을 더해 그대로 전합니다.
 *
 * <pre>
 *  GET /api/search/suggest?q=          치는 동안의 후보(외부 호출 없음)
 *  GET /api/search/resolve?q=          Enter의 후보(로컬 + Wikidata)
 *  GET /api/search/entity?e=           대상 풀기
 *  GET /api/search/links?e=            연결 보강(내부자 명단·법인 관계 — 연결 탭을 열 때)
 *  GET /api/search/feed?e=&amp;tab=&amp;refresh=1   결과(2년 묶음, 글·논평 탭은 운영자만, refresh=1은 지금 새로 받기 — 사용자당 10분에 1번)
 *  GET /api/search/recent              첫 화면 최근 글(새 피드 묶음, 운영자는 속보도)
 * </pre>
 *
 * <p>관심 대상·매체 제외 경로는 {@link SearchWatchController}에 있습니다.
 *
 * <p>응답 캐시({@code ComputedCache})를 쓰지 않습니다 — 사용자(운영자·데모)마다 결과가 다르고, 캐시는 수집기 메모리에 있습니다.
 */
@RestController
@RequestMapping("/api/search")
public class SearchController {

    private final SearchService search;

    public SearchController(SearchService search) {
        this.search = search;
    }

    @GetMapping("/suggest")
    public Map<String, Object> suggest(@RequestParam(required = false) String q, HttpServletRequest request) {
        return search.suggest(q, CurrentUser.of(request));
    }

    @GetMapping("/resolve")
    public Map<String, Object> resolve(@RequestParam(required = false) String q, HttpServletRequest request) {
        return search.resolve(q, CurrentUser.of(request));
    }

    @GetMapping("/entity")
    public Map<String, Object> entity(@RequestParam(required = false) String e, HttpServletRequest request) {
        return search.entity(e, CurrentUser.of(request));
    }

    @GetMapping("/links")
    public Map<String, Object> links(@RequestParam(required = false) String e, HttpServletRequest request) {
        return search.links(e, CurrentUser.of(request));
    }

    @GetMapping("/feed")
    public Map<String, Object> feed(@RequestParam(required = false) String e, @RequestParam(required = false) String tab,
                                    @RequestParam(defaultValue = "false") boolean refresh, HttpServletRequest request) {
        return search.feed(e, tab, refresh, CurrentUser.of(request));
    }

    @GetMapping("/recent")
    public Map<String, Object> recent(HttpServletRequest request) {
        return search.recent(CurrentUser.of(request));
    }
}
