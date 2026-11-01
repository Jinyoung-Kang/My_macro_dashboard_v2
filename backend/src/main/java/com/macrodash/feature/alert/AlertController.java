package com.macrodash.feature.alert;

import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 알림 — 규칙과 화면 알림함.
 *
 * <pre>
 *  GET    /api/alerts/rules            내 규칙 + 상한
 *  POST   /api/alerts/rules            만들기 {kind, params}
 *  POST   /api/alerts/rules/{id}       켜기·끄기 {enabled}
 *  DELETE /api/alerts/rules/{id}       지우기
 *  GET    /api/alerts/inbox?limit=50   알림함(최근 순)
 *  GET    /api/alerts/unread-count     읽지 않은 수(지난 사건 제외)
 *  POST   /api/alerts/inbox/read       읽음 {ids:[…]} 또는 {all:true}
 * </pre>
 */
@RestController
@RequestMapping("/api/alerts")
public class AlertController {

    private final AlertService alerts;

    public AlertController(AlertService alerts) {
        this.alerts = alerts;
    }

    public record RuleRequest(String kind, JsonNode params) {
    }

    public record EnableRequest(Boolean enabled) {
    }

    public record ReadRequest(List<Long> ids, Boolean all) {
    }

    /** 고른 항목 읽음 처리의 한 번 상한(QA-020). 화면은 한 화면(최대 50개)씩만 보냅니다. */
    static final int MAX_READ_IDS = 200;

    @GetMapping("/rules")
    public Map<String, Object> rules(HttpServletRequest request) {
        CurrentUser user = CurrentUser.of(request);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", alerts.ready());
        if (!alerts.ready()) {
            out.put("message", "알림 테이블이 아직 없습니다 — make up 후 다시 보세요.");
            return out;
        }
        out.put("limit", alerts.ruleLimit(user));
        out.put("rules", alerts.rules(user));
        return out;
    }

    @PostMapping("/rules")
    public ResponseEntity<Map<String, Object>> create(@RequestBody(required = false) RuleRequest body,
                                                      HttpServletRequest request) {
        AlertService.Result result = body == null ? new AlertService.Result(400, "요청 본문이 없습니다.")
                : alerts.create(CurrentUser.of(request), body.kind(), body.params());
        return respond(result);
    }

    @PostMapping("/rules/{id}")
    public ResponseEntity<Map<String, Object>> enable(@PathVariable long id,
                                                      @RequestBody(required = false) EnableRequest body,
                                                      HttpServletRequest request) {
        boolean enabled = body == null || !Boolean.FALSE.equals(body.enabled());
        return respond(alerts.setEnabled(CurrentUser.of(request), id, enabled));
    }

    @DeleteMapping("/rules/{id}")
    public ResponseEntity<Map<String, Object>> delete(@PathVariable long id, HttpServletRequest request) {
        return respond(alerts.delete(CurrentUser.of(request), id));
    }

    @GetMapping("/inbox")
    public Map<String, Object> inbox(@RequestParam(defaultValue = "50") int limit, HttpServletRequest request) {
        CurrentUser user = CurrentUser.of(request);
        if (!alerts.ready()) {
            return Map.of("items", List.of(), "unread", 0);
        }
        return Map.of("items", alerts.inbox(user, limit), "unread", alerts.unreadCount(user));
    }

    @GetMapping("/unread-count")
    public Map<String, Object> unread(HttpServletRequest request) {
        return Map.of("unread", alerts.ready() ? alerts.unreadCount(CurrentUser.of(request)) : 0);
    }

    @PostMapping("/inbox/read")
    public Map<String, Object> read(@RequestBody(required = false) ReadRequest body, HttpServletRequest request) {
        // {all:true}면 모두, 아니면 고른 것만(없으면 아무것도 바꾸지 않음).
        boolean all = body != null && Boolean.TRUE.equals(body.all());
        List<Long> ids = all ? null : (body == null || body.ids() == null ? List.of() : body.ids());
        if (ids != null && ids.size() > MAX_READ_IDS) {
            throw new InvalidRequestException("한 번에 " + MAX_READ_IDS + "개까지 읽음 처리할 수 있습니다.");
        }
        int changed = alerts.markRead(CurrentUser.of(request), ids);
        return Map.of("ok", true, "changed", changed);
    }

    private static ResponseEntity<Map<String, Object>> respond(AlertService.Result result) {
        return ResponseEntity.status(result.status())
                .body(Map.of("ok", result.status() == 200, "message", result.message()));
    }
}
