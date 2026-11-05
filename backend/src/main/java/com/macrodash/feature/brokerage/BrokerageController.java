package com.macrodash.feature.brokerage;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 토스증권 실제 계좌 — 읽기 전용(운영자 전용, ADR 0025).
 *
 * <pre>
 *  GET  /api/brokerage/account?market=KR   원화 쪽(국내 주식·원화 매수 가능 금액)  · market=US 달러 쪽
 * </pre>
 *
 * <p>모의 장부와 별개 기능이고 저장하지 않습니다. 주문·정정·취소 경로는 두지 않습니다 — 쓰기를 열려면 새 ADR과 승인이 필요하고
 * {@code BrokerageIsolationTest}를 일부러 고쳐야 합니다. {@code market}이 없거나 틀리면 400, 그 밖에는 늘 200({@link BrokerageService}).
 */
@RestController
@RequestMapping("/api/brokerage")
public class BrokerageController {

    private final BrokerageService brokerage;

    public BrokerageController(BrokerageService brokerage) {
        this.brokerage = brokerage;
    }

    @GetMapping("/account")
    public BrokerageAccountView account(@RequestParam(required = false) String market) {
        return brokerage.account(market);
    }
}
