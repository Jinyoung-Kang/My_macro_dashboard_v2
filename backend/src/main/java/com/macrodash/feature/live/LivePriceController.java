package com.macrodash.feature.live;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.Map;

/**
 * 화면 실시간 시세(ADR 0024) — 모의 매매 장중 카드·보유 표·종목 상세. 저장하지 않고 수집기 {@code /live/prices}를 전합니다.
 * 종목은 {@code items=US:AAPL,KR:005930}(60개까지), 주기는 5초~3시간(서비스의 목록).
 */
@RestController
@RequestMapping("/api/live/prices")
public class LivePriceController {

    private final LivePriceService prices;

    public LivePriceController(LivePriceService prices) {
        this.prices = prices;
    }

    /** 지금 가격 한 번(자동 새로고침을 끈 화면) → {@code {available, prices}}. */
    @GetMapping
    public Map<String, Object> snapshot(@RequestParam String items) {
        return prices.snapshot(items);
    }

    /** SSE 구독 — 바로 한 번, 그 뒤 {@code interval}초마다 'prices' 이벤트(본문은 위와 같음). */
    @GetMapping("/stream")
    public SseEmitter stream(@RequestParam String items, @RequestParam Integer interval) {
        return prices.stream(items, interval);
    }
}
