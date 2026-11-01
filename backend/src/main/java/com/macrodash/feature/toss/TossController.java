package com.macrodash.feature.toss;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 토스증권 API 테스트.
 *
 * <p>경로는 화면 호환을 위해 {@code /api/ai/toss/*}를 유지합니다. AI와는 관계가 없고
 * (연결 테스트 화면에 함께 있을 뿐), 출처(토스 키)가 따로라 기능 패키지도 따로 둡니다.
 */
@RestController
@RequestMapping("/api/ai/toss")
public class TossController {

    private final TossService toss;

    public TossController(TossService toss) {
        this.toss = toss;
    }

    @GetMapping("/diagnostics")
    public Map<String, Object> tossDiagnostics() {
        return toss.diagnostics();
    }

    @GetMapping("/exchange-rate")
    public Map<String, Object> tossExchangeRate(@RequestParam(defaultValue = "USD") String base,
                                                @RequestParam(defaultValue = "KRW") String quote) {
        return toss.exchangeRate(base, quote);
    }

    @GetMapping("/indices")
    public Map<String, Object> tossIndices(@RequestParam String symbols) {
        return toss.indices(symbols);
    }
}
