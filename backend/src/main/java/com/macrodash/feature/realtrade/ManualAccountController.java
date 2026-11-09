package com.macrodash.feature.realtrade;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ISA 계좌 — 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매'(운영자 전용, ADR 0029·0034). 증권사 연결·주문 경로는 없습니다.
 *
 * <pre>
 *  GET  /api/manual/isa                              계좌·요약·보유·다음 지시·스탑 지시·최근 지시 30·매매 내역 최근 200·메모
 *  POST /api/manual/isa/start                        {totalAsset, positions:[{symbol, quantity, purchaseAmount}], prices?} — 한 번만
 *  POST /api/manual/isa/balance/total                {totalAsset, prices?} — 총 잔고를 다시 넣어 현금을 다시 셈
 *  POST /api/manual/isa/balance/commission           {commissionPct}(0~1%)
 *  POST /api/manual/isa/positions                    {originalSymbol?, symbol, name?, quantity, price} — 보유 추가·고치기
 *  POST /api/manual/isa/positions/{symbol}/delete    보유 지우기
 *  POST /api/manual/isa/instructions/apply           {items:[{instructionId 또는 stopInstructionId, price?, priceSource?}]} — 확인을 잔고에 바로 반영
 *  POST /api/manual/isa/instructions/{id}/skip
 *  POST /api/manual/isa/trades/{id}/undo             확인 되돌리기(잔고 되돌림, 지시는 PLANNED — 그 세션 마감이 지났으면 SKIPPED)
 * </pre>
 *
 * <p>거절은 {@code {ok:false, error:<사유 코드>, message}}와 그 HTTP 상태(400 invalid-request, 404 not-found, 409 already-started·not-started·
 * already-recorded)입니다 — 본문(JSON)을 읽지 못하거나 경로 번호가 숫자가 아니어도 같은 모양(400 invalid-request).
 */
@RestController
@RequestMapping("/api/manual/isa")
public class ManualAccountController {

    private final ManualAccountService service;

    public ManualAccountController(ManualAccountService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> view() {
        return service.view();
    }

    @PostMapping("/start")
    public Map<String, Object> start(@RequestBody(required = false) ManualAccountService.StartRequest body) {
        return service.start(body);
    }

    @PostMapping("/balance/total")
    public Map<String, Object> total(@RequestBody(required = false) ManualAccountService.TotalRequest body) {
        return service.setTotal(body);
    }

    @PostMapping("/balance/commission")
    public Map<String, Object> commission(@RequestBody(required = false) ManualAccountService.CommissionRequest body) {
        return service.setCommission(body);
    }

    @PostMapping("/positions")
    public Map<String, Object> position(@RequestBody(required = false) ManualAccountService.PositionRequest body) {
        return service.savePosition(body);
    }

    @PostMapping("/positions/{symbol}/delete")
    public Map<String, Object> deletePosition(@PathVariable String symbol) {
        return service.deletePosition(symbol);
    }

    @PostMapping("/instructions/apply")
    public Map<String, Object> apply(@RequestBody(required = false) ManualAccountService.ApplyRequest body) {
        return service.apply(body);
    }

    @PostMapping("/instructions/{id}/skip")
    public Map<String, Object> skip(@PathVariable long id) {
        return service.skipInstruction(id);
    }

    @PostMapping("/trades/{id}/undo")
    public Map<String, Object> undo(@PathVariable long id) {
        return service.undoTrade(id);
    }

    @ExceptionHandler(ManualAccountException.class)
    ResponseEntity<Map<String, Object>> rejected(ManualAccountException e) {
        return body(e.status(), e.code(), e.getMessage());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<Map<String, Object>> unreadable(HttpMessageNotReadableException e) {
        return body(400, ManualAccountException.INVALID_REQUEST, "요청 본문(JSON)을 읽지 못했습니다 — 숫자 칸에 숫자를 넣었는지 보세요.");
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    ResponseEntity<Map<String, Object>> typeMismatch(MethodArgumentTypeMismatchException e) {
        return body(400, ManualAccountException.INVALID_REQUEST, "경로의 번호가 올바르지 않습니다.");
    }

    private static ResponseEntity<Map<String, Object>> body(int status, String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", code);
        body.put("message", message);
        return ResponseEntity.status(status).body(body);
    }
}
