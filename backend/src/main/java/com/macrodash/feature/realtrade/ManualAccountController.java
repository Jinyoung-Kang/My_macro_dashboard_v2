package com.macrodash.feature.realtrade;

import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ISA 계좌 — 연결되지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 '지시 + 직접 매매'(운영자 전용, ADR 0029 — 명세
 * docs/specs/2026-11-06-isa-manual-account.md §5). 증권사 연결·주문 경로는 없습니다.
 *
 * <pre>
 *  GET  /api/manual/isa                              계좌·요약·보유·다음 시가 지시·최근 지시 30·장부 최근 200·메모
 *  POST /api/manual/isa/start                        {cash, startedAt?, buys:[{symbol, quantity, price}]} — 한 번만
 *  POST /api/manual/isa/ledger                       {id?, kind, symbol?, quantity?, price?, amount?, fee?, tax?, at?, note?, instructionId?}
 *  POST /api/manual/isa/ledger/{id}/delete           ?allowNegativeCash=true — 현금이 음수가 되는 지우기를 사용자가 확인함
 *  POST /api/manual/isa/instructions/{id}/skip
 *  POST /api/manual/isa/instructions/confirm         {ids:[…], confirmed?} — '매매함' 표시(장 중반 확인 알림의 신호)
 *  POST /api/manual/isa/instructions/fills           {fills:[{instructionId 또는 stopInstructionId, quantity, price, fee?, tax?}]} — 체결을 한 트랜잭션으로 장부에
 * </pre>
 *
 * <p>거절은 {@code {ok:false, error:<사유 코드>, message}}와 그 HTTP 상태(400 invalid-request·ledger-invalid, 404 not-found, 409 already-started·
 * not-started·already-recorded)입니다 — 본문(JSON)을 읽지 못하거나 경로 번호가 숫자가 아니어도 같은 모양(400 invalid-request).
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

    @PostMapping("/ledger")
    public Map<String, Object> ledger(@RequestBody(required = false) ManualAccountService.LedgerRequest body) {
        return service.saveLedger(body);
    }

    @PostMapping("/ledger/{id}/delete")
    public Map<String, Object> deleteLedger(@PathVariable long id, @RequestParam(defaultValue = "false") boolean allowNegativeCash) {
        return service.deleteLedger(id, allowNegativeCash);
    }

    @PostMapping("/instructions/{id}/skip")
    public Map<String, Object> skip(@PathVariable long id) {
        return service.skipInstruction(id);
    }

    @PostMapping("/instructions/confirm")
    public Map<String, Object> confirm(@RequestBody(required = false) ManualAccountService.ConfirmRequest body) {
        return service.confirmInstructions(body);
    }

    @PostMapping("/instructions/fills")
    public Map<String, Object> fills(@RequestBody(required = false) ManualAccountService.FillsRequest body) {
        return service.saveFills(body);
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
