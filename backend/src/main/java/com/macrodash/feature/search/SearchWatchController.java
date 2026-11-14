package com.macrodash.feature.search;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 검색의 관심 대상과 매체 제외 목록(ADR 0041 결정 6·9, 계약 docs/specs/2026-11-14-info-search-contract.md §6-4).
 *
 * <pre>
 *  GET    /api/search/watch               내 관심 대상 + 새 글 수 + 상한 + 서버 정기 수집 여부
 *  POST   /api/search/watch               등록 {key} (데모 403, 상한 409)
 *  DELETE /api/search/watch/{id}          지우기(자기 것만 — 남의 것 404)
 *  POST   /api/search/watch/{id}/seen     지금 봤음(새 글 수 0)
 *  GET    /api/search/excludes            매체 제외 목록(처음 값 + 운영자가 더한 줄)
 *  POST   /api/search/excludes            (운영자) 더하기 {kind, value, note}
 *  DELETE /api/search/excludes/{id}       (운영자) 지우기
 * </pre>
 *
 * <p>등급(회원·운영자)과 데모의 쓰기 금지는 세션 필터가 먼저 막고({@code AccessPolicy}), 서비스가 한 번 더 봅니다. 응답 캐시를 쓰지 않습니다(사용자마다 다름).
 */
@RestController
@RequestMapping("/api/search")
public class SearchWatchController {

    private final SearchWatchService watches;

    public SearchWatchController(SearchWatchService watches) {
        this.watches = watches;
    }

    public record WatchRequest(String key) {
    }

    public record ExcludeRequest(String kind, String value, String note) {
    }

    @GetMapping("/watch")
    public Map<String, Object> list(HttpServletRequest request) {
        return watches.list(CurrentUser.of(request));
    }

    @PostMapping("/watch")
    public ResponseEntity<Map<String, Object>> add(@RequestBody(required = false) WatchRequest body, HttpServletRequest request) {
        // 본문이 없으면 키가 없는 것과 같습니다 — 서비스가 데모(403)를 먼저 보고 키를 검사(400)합니다.
        return respond(watches.add(CurrentUser.of(request), body == null ? null : body.key()));
    }

    @DeleteMapping("/watch/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable long id, HttpServletRequest request) {
        return respond(watches.delete(CurrentUser.of(request), id));
    }

    @PostMapping("/watch/{id}/seen")
    public ResponseEntity<Map<String, Object>> seen(@PathVariable long id, HttpServletRequest request) {
        return respond(watches.seen(CurrentUser.of(request), id));
    }

    @GetMapping("/excludes")
    public Map<String, Object> excludes() {
        return watches.excludes();
    }

    @PostMapping("/excludes")
    public ResponseEntity<Map<String, Object>> addExclude(@RequestBody(required = false) ExcludeRequest body, HttpServletRequest request) {
        // 본문이 없으면 칸이 모두 빈 것과 같습니다 — 서비스가 운영자인지(403)를 먼저 보고 칸을 검사(400)합니다.
        ExcludeRequest given = body == null ? new ExcludeRequest(null, null, null) : body;
        return respond(watches.addExclude(CurrentUser.of(request), given.kind(), given.value(), given.note()));
    }

    @DeleteMapping("/excludes/{id}")
    public ResponseEntity<Map<String, Object>> deleteExclude(@PathVariable long id, HttpServletRequest request) {
        return respond(watches.deleteExclude(CurrentUser.of(request), id));
    }

    private static ResponseEntity<Map<String, Object>> respond(SearchWatchService.Result result) {
        return ResponseEntity.status(result.status()).body(result.body());
    }
}
