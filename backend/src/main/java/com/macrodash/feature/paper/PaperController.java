package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 모의 알고리즘 매매(운영자 전용) — 장부 조회와 관리 버튼.
 *
 * <pre>
 *  GET  /api/paper/status?market=US              스키마·초기화·정기 작업 상태(시장 US·KR, 없으면 US)
 *  GET  /api/paper/books/{code}/positions         보유·재진입 금지·현금
 *  GET  /api/paper/books/{code}/orders?limit=50   주문(최근 순, 1–500)
 *  GET  /api/paper/books/{code}/fills?limit=50    체결(최근 순, 1–500)
 *  GET  /api/paper/books/{code}/nav               거래일별 순자산
 *  GET  /api/paper/books/{code}/execution?limit=50 실행 감사(미국·한국 Claude 계좌만 — 주문별 메뉴 반사실·1분봉 지연과 시점별 요약)
 *  POST /api/paper/init?market=US                 네 책 만들기 + 벤치마크 사후 체결(멱등 — 한국은 출발일 검사 뒤 네 계좌 '시작 전'만)
 *  POST /api/paper/books/{code}/status            {"status":"ACTIVE"|"PAUSED"}
 *  POST /api/paper/books/{code}/reset             {"confirm":"<code>"}
 *  POST /api/paper/run/risk?market=US            리스크 점검 한 번(설정과 상관없이 — 그 시장 장부 실패 기억을 지우고, 시장 US·KR, 없으면 US)
 *  POST /api/paper/admin/cost-backfill            {"market":"US","confirm":"비용 소급"} 미국 체결 비용의 과거 소급(ADR 0030 — 두 번 돌려도 한 번)
 *  GET  /api/paper/track-record?asOf=             13F 트랙레코드·순위·선정·수집 진행률(없으면 가장 최근 계산)
 *  POST /api/paper/run/rerank                     {"asOf"?} 트랙레코드 수동 재계산(선정은 그대로)
 * </pre>
 *
 * <p>개요({@code GET /api/paper/overview} — 장부 응답 + 장중 지금 값)는 {@link PaperOverviewController}입니다. 모든 경로는 운영자만
 * 부릅니다(AccessPolicy). 테이블이 없으면 500이 아니라 {@code available:false}(+ POST는 {@code ok:false})입니다.
 * {@code market}(2단계 명세 §4-16, F1)이 없거나 US면 미국 응답 그대로, KR이면 그 시장 판({@link PaperMarkets#requested}), 그 밖 값은 400입니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperController {

    private final PaperQueryService query;
    private final PaperAdminService admin;
    private final PaperRiskJob risk;
    private final PaperSelectionService selection;
    private final PaperMarkets markets;

    public PaperController(PaperQueryService query, PaperAdminService admin, PaperRiskJob risk,
                           PaperSelectionService selection, PaperMarkets markets) {
        this.query = query;
        this.admin = admin;
        this.risk = risk;
        this.selection = selection;
        this.markets = markets;
    }

    public record StatusRequest(String status) {
    }

    public record ResetRequest(String confirm) {
    }

    /** 출발일 종가로 다시 출발 — 확인 문구와 한국 가격 출처(없으면 금융위). */
    public record RestartRequest(String confirm, String priceSource) {
    }

    /** 수동 재계산의 기준일(yyyy-MM-dd). 없으면 마지막 완료 세션. */
    public record RerankRequest(String asOf) {
    }

    /** 미국 체결 비용 소급 — 시장(US만)과 확인 문구('비용 소급'). */
    public record CostBackfillRequest(String market, String confirm) {
    }

    @GetMapping("/status")
    public Map<String, Object> status(@RequestParam(required = false) String market) {
        return query.status(market);
    }

    @GetMapping("/names")
    public Map<String, Object> names(@RequestParam(required = false) String market) {
        return query.names(market);
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

    /** 미국 Claude 계좌 밖의 코드는 400(ADR 0022 — 실행 감사는 단계 0에서 계좌1만). */
    @GetMapping("/books/{code}/execution")
    public Map<String, Object> execution(@PathVariable String code, @RequestParam(defaultValue = "50") int limit) {
        return query.execution(code, limit);
    }

    /**
     * {@code market}이 KR이면 한국 초기화({@link PaperAdminService#initKr} — 멱등, 출발일이 비었거나 달력이 그해를 모르거나 KRX 거래일이 아니거나
     * 처음 만들 때 출발 기한이 지났으면 400, 사후 체결·출발일 종가 없음), 없거나 US면 미국 응답 그대로.
     */
    @PostMapping("/init")
    public Map<String, Object> init(@RequestParam(required = false) String market) {
        PaperMarket requested = markets.requested(market);
        if (!query.ready()) {
            return notReady();
        }
        if (requested != UsPaperMarket.INSTANCE) {
            // 운영 시장 목록은 미국·한국 둘(PaperMarkets.PRODUCTION) — 미국 밖은 한국 초기화.
            PaperAdminService.KrInitResult result = admin.initKr();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("market", requested.code());
            out.put("startDate", result.startDate().toString());
            out.put("created", result.created());
            out.put("settingsCreated", result.settingsCreated());
            out.put("settingsVersion", result.settingsVersion());
            out.put("settingsKeysWritten", result.settingsKeysWritten());
            return out;
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

    /**
     * 출발일 종가로 다시 출발({@link PaperAdminService#restartAtStartClose} — 사용자 결정 2026-11-02). 본문 {@code {"confirm":"<code>",
     * "priceSource":"FSC"|"TOSS"}}(가격 출처는 한국 계좌만, 없으면 금융위).
     */
    @PostMapping("/books/{code}/restart-at-start-close")
    public Map<String, Object> restartAtStartClose(@PathVariable String code,
                                                   @RequestBody(required = false) RestartRequest body) {
        if (!query.ready()) {
            return notReady();
        }
        StartCloseRestart.Result result = admin.restartAtStartClose(code, body == null ? null : body.confirm(),
                body == null ? null : body.priceSource());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("book", query.bookSummary(code));
        out.put("startDate", result.startDate().toString());
        out.put("cancelledOrders", result.cancelled());
        out.put("fills", query.fillRows(result.fills()));
        List<Map<String, Object>> skipped = new ArrayList<>();
        result.skipped().forEach(e -> skipped.add(Map.of("ticker", e.getKey(), "reason", e.getValue())));
        out.put("skipped", skipped);
        out.put("cash", result.cash());
        out.put("nav", result.nav());
        return out;
    }

    /**
     * {@code market}이 KR이면 한국 수동 리스크 점검({@link PaperRiskJob#runNowView} — 한국 장부 실패 기억을 지우는 창 안의 복구 단추, 쉬는 한국은
     * {@code ok:false}·{@code dormantReason}), 없거나 US면 미국 응답 그대로.
     */
    @PostMapping("/run/risk")
    public Map<String, Object> runRisk(@RequestParam(required = false) String market) {
        PaperMarket requested = markets.requested(market);
        if (!query.ready()) {
            return notReady();
        }
        if (requested != UsPaperMarket.INSTANCE) {
            return risk.runNowView(requested);
        }
        PaperLedgerService.Outcome outcome = risk.runNow();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", outcome.errors().isEmpty());
        out.put("outcome", outcome);
        return out;
    }

    /**
     * 미국 체결 비용의 과거 소급({@link PaperAdminService#costBackfill} — ADR 0030, 명세 2026-11-06 §2). 본문 {@code {"market":"US",
     * "confirm":"비용 소급"}} → {@code {ok, market, books:[{code, fills, fee, tax, cashDelta}], navRowsUpdated, versions:[{settingsVersion, rates,
     * fills}], zeroCostFills}}(모의 자료라 금액을 실음). 비율은 체결마다 그때 유효했던 설정 판. 시장·확인 문구가 다르면 400. 장부 잠금 안 한
     * 트랜잭션이고, 이미 조정한 체결·새 비용으로 체결된 행은 건너뜁니다.
     */
    @PostMapping("/admin/cost-backfill")
    public Map<String, Object> costBackfill(@RequestBody(required = false) CostBackfillRequest body) {
        if (!query.ready()) {
            return notReady();
        }
        UsCostBackfill.Result result = admin.costBackfill(body == null ? null : body.market(),
                body == null ? null : body.confirm());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("market", result.market());
        List<Map<String, Object>> books = new ArrayList<>();
        for (UsCostBackfill.BookResult book : result.books()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("code", book.code());
            row.put("fills", book.fills());
            row.put("fee", book.fee().doubleValue());
            row.put("tax", book.tax().doubleValue());
            row.put("cashDelta", book.cashDelta().doubleValue());
            books.add(row);
        }
        out.put("books", books);
        out.put("navRowsUpdated", result.navRowsUpdated());
        List<Map<String, Object>> versions = new ArrayList<>();
        for (UsCostBackfill.VersionUsed version : result.versions()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("settingsVersion", version.settingsVersion());
            row.put("rates", version.rates());
            row.put("fills", version.fills());
            versions.add(row);
        }
        out.put("versions", versions);
        out.put("zeroCostFills", result.zeroCostFills());
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
