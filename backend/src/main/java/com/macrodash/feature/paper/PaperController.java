package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 🧪 모의 알고리즘 매매(운영자 전용) — 장부 조회와 관리 버튼.
 *
 * <pre>
 *  GET  /api/paper/overview?market=US            네 책 요약·순자산 곡선·관측치 신선도·한계 문구·작업 기록(시장 US·KR, 없으면 US)
 *  GET  /api/paper/status?market=US              스키마·초기화·정기 작업 상태(시장 US·KR, 없으면 US)
 *  GET  /api/paper/books/{code}/positions         보유·재진입 금지·현금
 *  GET  /api/paper/books/{code}/orders?limit=50   주문(최근 순, 1–500)
 *  GET  /api/paper/books/{code}/fills?limit=50    체결(최근 순, 1–500)
 *  GET  /api/paper/books/{code}/nav               거래일별 순자산
 *  POST /api/paper/init                           네 책 만들기 + 벤치마크 사후 체결(멱등)
 *  POST /api/paper/books/{code}/status            {"status":"ACTIVE"|"PAUSED"}
 *  POST /api/paper/books/{code}/reset             {"confirm":"<code>"}
 *  POST /api/paper/run/risk                       리스크 점검 한 번(설정과 상관없이)
 *  GET  /api/paper/track-record?asOf=             13F 트랙레코드·순위·선정·수집 진행률(없으면 가장 최근 계산)
 *  POST /api/paper/run/rerank                     {"asOf"?} 트랙레코드 수동 재계산(선정은 그대로)
 * </pre>
 *
 * <p>모든 경로는 운영자만 부릅니다(AccessPolicy). 테이블이 없으면 500이 아니라 {@code available:false}(+ POST는 {@code ok:false})입니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperController {

    private final PaperQueryService query;
    private final PaperAdminService admin;
    private final PaperRiskJob risk;
    private final PaperSelectionService selection;

    public PaperController(PaperQueryService query, PaperAdminService admin, PaperRiskJob risk,
                           PaperSelectionService selection) {
        this.query = query;
        this.admin = admin;
        this.risk = risk;
        this.selection = selection;
    }

    public record StatusRequest(String status) {
    }

    public record ResetRequest(String confirm) {
    }

    /** 수동 재계산의 기준일(yyyy-MM-dd). 없으면 마지막 완료 세션. */
    public record RerankRequest(String asOf) {
    }

    /** {@code market}이 없으면 미국(시장을 받기 전 응답 그대로), 모르는 값은 400(2단계 명세 §4-16). */
    @GetMapping("/overview")
    public Map<String, Object> overview(@RequestParam(required = false) String market) {
        return query.overview(market);
    }

    @GetMapping("/status")
    public Map<String, Object> status(@RequestParam(required = false) String market) {
        return query.status(market);
    }

    @GetMapping("/books/{code}/positions")
    public Map<String, Object> positions(@PathVariable String code) {
        return query.positions(code);
    }

    @GetMapping("/books/{code}/orders")
    public Map<String, Object> orders(@PathVariable String code, @RequestParam(defaultValue = "50") int limit) {
        return query.orders(code, limit);
    }

    @GetMapping("/books/{code}/fills")
    public Map<String, Object> fills(@PathVariable String code, @RequestParam(defaultValue = "50") int limit) {
        return query.fills(code, limit);
    }

    @GetMapping("/books/{code}/nav")
    public Map<String, Object> nav(@PathVariable String code) {
        return query.nav(code);
    }

    @PostMapping("/init")
    public Map<String, Object> init() {
        if (!query.ready()) {
            return notReady();
        }
        PaperAdminService.InitResult result = admin.init();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("created", result.created());
        out.put("backfilled", result.backfilled());
        out.put("skipped", result.skipped());
        out.put("settingsCreated", result.settingsCreated());
        out.put("startPricesCaptured", result.startPricesCaptured());
        return out;
    }

    @PostMapping("/books/{code}/status")
    public Map<String, Object> bookStatus(@PathVariable String code,
                                          @RequestBody(required = false) StatusRequest body) {
        if (!query.ready()) {
            return notReady();
        }
        PaperAdminService.StatusChange change = admin.setStatus(code, body == null ? null : body.status());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("book", query.bookSummary(code));
        out.put("cancelledOrders", change.cancelledOrders());
        return out;
    }

    @PostMapping("/books/{code}/reset")
    public Map<String, Object> reset(@PathVariable String code, @RequestBody(required = false) ResetRequest body) {
        if (!query.ready()) {
            return notReady();
        }
        PaperAdminService.ResetResult result = admin.reset(code, body == null ? null : body.confirm());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("book", query.bookSummary(code));
        out.put("backfilled", result.backfilled());
        out.put("skippedReason", result.skippedReason());
        return out;
    }

    @PostMapping("/run/risk")
    public Map<String, Object> runRisk() {
        if (!query.ready()) {
            return notReady();
        }
        PaperLedgerService.Outcome outcome = risk.runNow();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", outcome.errors().isEmpty());
        out.put("outcome", outcome);
        return out;
    }

    @GetMapping("/track-record")
    public Map<String, Object> trackRecord(@RequestParam(required = false) String asOf) {
        return selection.trackRecord(asOf);
    }

    @PostMapping("/run/rerank")
    public Map<String, Object> rerank(@RequestBody(required = false) RerankRequest body) {
        if (!query.ready()) {
            return notReady();
        }
        return selection.rerank(body == null ? null : body.asOf());
    }

    private Map<String, Object> notReady() {
        Map<String, Object> out = query.notReady();
        out.put("ok", false);
        return out;
    }
}
