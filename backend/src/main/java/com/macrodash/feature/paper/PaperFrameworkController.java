package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.util.Map;

/**
 * 🧪 투자 OS 프레임·메모(운영자 전용, 명세 F1~F7·D14·D15) — 프레임 판 보기·수동 편집·제안→승인, 시황·방법론 메모. 장부는
 * {@link PaperController}, 결정은 {@link PaperDecisionController}, 설정은 {@link PaperSettingsController}입니다.
 *
 * <pre>
 *  GET    /api/paper/framework                          지금 판(렌더링·토큰 어림·예산 초과)과 판 목록
 *  GET    /api/paper/framework/versions/{version}       판 하나(지금 판과 같은 모양)
 *  POST   /api/paper/framework                          {"body", "changelog", "baseVersion"} 수동 편집 → 새 판
 *  GET    /api/paper/framework/proposals                제안 목록(최근 순)
 *  POST   /api/paper/framework/proposals                {"noteId"?, "text"?} Claude에 갱신안 요청(자동 반영 없음)
 *  POST   /api/paper/framework/proposals/{id}/approve   제안 승인 → 새 판
 *  POST   /api/paper/framework/proposals/{id}/reject    제안 거절
 *  GET    /api/paper/notes?includeExpired=false&market=US   메모 목록(시장 US·KR, 없으면 US)
 *  POST   /api/paper/notes                              {"kind", "asOfDate"?, "expiresOn"?, "title", "body"} 메모 쓰기
 *  DELETE /api/paper/notes/{id}                         메모 보관(지우지 않음)
 * </pre>
 *
 * <p>제안 요청은 Claude를 한 번 부릅니다(설정 {@code model}·{@code effort}, 하루 호출 상한 {@code apiDailyCallCap}을 Claude 책 결정과
 * 함께 셈). 테이블이 없으면 500이 아니라 {@code available:false}(+ POST·DELETE는 {@code ok:false})입니다. 형식이 틀린 요청은 400이고
 * 아무것도 바꾸지 않습니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperFrameworkController {

    private final FrameworkService framework;
    private final NoteService notes;
    private final PaperMarkets markets;
    private final PaperConfig config;

    public PaperFrameworkController(FrameworkService framework, NoteService notes, PaperMarkets markets,
                                    PaperConfig config) {
        this.framework = framework;
        this.notes = notes;
        this.markets = markets;
        this.config = config;
    }

    /**
     * 본문은 프레임 JSON 그대로({@code body}) — 키·형·길이는 서비스가 검사합니다. {@code baseVersion}은 편집을 시작한 판(지금 판과 다르면
     * 400 — 그사이 생긴 판의 변경을 지우지 않게).
     */
    public record SaveRequest(JsonNode body, String changelog, Integer baseVersion) {
    }

    public record ProposalRequest(Long noteId, String text) {
    }

    public record NoteRequest(String kind, String asOfDate, String expiresOn, String title, String body) {
    }

    @GetMapping("/framework")
    public Map<String, Object> framework() {
        return framework.view();
    }

    @GetMapping("/framework/versions/{version}")
    public Map<String, Object> version(@PathVariable int version) {
        return framework.versionView(version);
    }

    @PostMapping("/framework")
    public Map<String, Object> save(@RequestBody(required = false) SaveRequest request) {
        if (request == null) {
            return framework.saveBody(null, null, null);
        }
        return framework.saveBody(request.body(), request.changelog(), request.baseVersion());
    }

    @GetMapping("/framework/proposals")
    public Map<String, Object> proposals() {
        return framework.proposalsView();
    }

    @PostMapping("/framework/proposals")
    public Map<String, Object> propose(@RequestBody(required = false) ProposalRequest request) {
        return framework.propose(request == null ? null : request.noteId(), request == null ? null : request.text());
    }

    @PostMapping("/framework/proposals/{id}/approve")
    public Map<String, Object> approve(@PathVariable long id) {
        return framework.approve(id);
    }

    @PostMapping("/framework/proposals/{id}/reject")
    public Map<String, Object> reject(@PathVariable long id) {
        return framework.reject(id);
    }

    /**
     * {@code market}(2단계 명세 §4-16, F1)이 없거나 US면 미국 목록 그대로, KR이면 그 조회의 시장 문맥({@link PaperMarkets#scope} — 쉬는 사유·그
     * 실행의 한국 달력)으로 그 시장 메모를, 그 밖 값은 400입니다.
     */
    @GetMapping("/notes")
    public Map<String, Object> notes(@RequestParam(defaultValue = "false") boolean includeExpired,
                                     @RequestParam(required = false) String market) {
        PaperMarket requested = markets.requested(market);
        return requested == UsPaperMarket.INSTANCE ? notes.list(includeExpired)
                : notes.list(markets.scope(requested, config), includeExpired);
    }

    @PostMapping("/notes")
    public Map<String, Object> createNote(@RequestBody(required = false) NoteRequest request) {
        if (request == null) {
            return notes.create(null, null, null, null, null);
        }
        return notes.create(request.kind(), request.asOfDate(), request.expiresOn(), request.title(), request.body());
    }

    @DeleteMapping("/notes/{id}")
    public Map<String, Object> archiveNote(@PathVariable long id) {
        return notes.archive(id);
    }
}
