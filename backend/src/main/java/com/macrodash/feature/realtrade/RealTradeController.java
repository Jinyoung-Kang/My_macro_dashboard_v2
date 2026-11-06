package com.macrodash.feature.realtrade;

import com.macrodash.support.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 실제 매매 — 토스증권 실제 계좌가 모의 한국 책을 따라 함(운영자 전용, ADR 0028 — 명세 docs/specs/2026-11-06-real-trade-mirror.md §7.2).
 *
 * <pre>
 *  GET  /api/realtrade/status?market=KR|US                    상태·서버 스위치·한도·오늘 창·최근 실제 주문 50·이벤트 30·책 목록
 *  GET  /api/realtrade/preview?market=KR&amp;sourceBook=…         켜기 창의 예상 목록(지금 계좌 + 그 책의 다음 시가 목표)
 *  POST /api/realtrade/enable   {market, sourceBook, lossLimitPct, confirm:"실제 매매 켜기", password, version}
 *  POST /api/realtrade/disable  {market}                       비밀번호·확인 글자 없이 늘
 *  POST /api/realtrade/update   {market, sourceBook?, lossLimitPct?, rebaseline?, confirm:"설정 바꾸기", password, version}
 *  POST /api/realtrade/resume   {market, confirm:"멈춤 해제", password, version}
 * </pre>
 *
 * <p>거절은 {@code {ok:false, error:<사유 코드>, message}}와 그 HTTP 상태(400 not-supported·confirm-mismatch, 403 password-invalid·password-locked,
 * 409 version-conflict …)입니다. 토스 주문 번호·클라이언트 키·계좌 값은 응답에 없습니다.
 */
@RestController
@RequestMapping("/api/realtrade")
public class RealTradeController {

    private final RealTradeService service;

    public RealTradeController(RealTradeService service) {
        this.service = service;
    }

    @GetMapping("/status")
    public Map<String, Object> status(@RequestParam(required = false) String market) {
        return service.status(market);
    }

    @GetMapping("/preview")
    public Map<String, Object> preview(@RequestParam(required = false) String market,
                                       @RequestParam(required = false) String sourceBook) {
        return service.preview(market, sourceBook);
    }

    @PostMapping("/enable")
    public Map<String, Object> enable(@RequestBody(required = false) RealTradeService.EnableRequest body, HttpServletRequest request) {
        return service.enable(CurrentUser.of(request), body);
    }

    @PostMapping("/disable")
    public Map<String, Object> disable(@RequestBody(required = false) RealTradeService.DisableRequest body, HttpServletRequest request) {
        return service.disable(CurrentUser.of(request), body);
    }

    @PostMapping("/update")
    public Map<String, Object> update(@RequestBody(required = false) RealTradeService.UpdateRequest body, HttpServletRequest request) {
        return service.update(CurrentUser.of(request), body);
    }

    @PostMapping("/resume")
    public Map<String, Object> resume(@RequestBody(required = false) RealTradeService.ResumeRequest body, HttpServletRequest request) {
        return service.resume(CurrentUser.of(request), body);
    }

    @ExceptionHandler(RealTradeException.class)
    ResponseEntity<Map<String, Object>> rejected(RealTradeException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", e.code());
        body.put("message", e.getMessage());
        return ResponseEntity.status(e.status()).body(body);
    }
}
