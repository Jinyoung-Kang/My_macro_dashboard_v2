package com.macrodash.feature.info;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 수집(사이드바 '정보 수집', ADR 0035·0036) — 운영자 전용, 저장본·수집기 상태만 읽습니다(화면이 수집을 일으키지 않음).
 *
 * <pre>
 *  GET /api/info/catalog      모든 출처의 한눈 보기(탭·카드·마지막 실행·판정·끊김)
 *  GET /api/info/mechanism    작동 방식(스위치·계층·예산·간격·알림 기준 — 수집기 코드의 실제 값과 지금 상태)
 *  GET /api/info/items        글 목록(최근부터, 본문 없이 — kind·source·q·page·size)
 *  GET /api/info/items/{id}   글 한 편(본문 포함)
 *  GET /api/info/headlines    사건 뉴스 RSS 제목(set·feed·q·page·size)
 *  GET /api/info/sources      지금 끊긴 출처(모든 화면의 안내 띠)
 *  GET /api/info/flows        네이버 투자자별 매매동향·외국인·기관 매매상위
 *  GET /api/info/gurus        waedge 거장 견해
 *  GET /api/info/krx          KRX 정보데이터시스템 — 순매수 상위·시장 합계·외국인 보유·공매도
 *  POST /api/info/translate   글 하나를 한국어로(ADR 0037 — Claude Haiku, 결과는 저장해 다시 부르지 않음. 수집은 일으키지 않음)
 * </pre>
 */
@RestController
@RequestMapping("/api/info")
public class InfoController {

    private final InfoService info;

    public InfoController(InfoService info) {
        this.info = info;
    }

    @GetMapping("/catalog")
    public Map<String, Object> catalog() {
        return info.catalog();
    }

    @GetMapping("/mechanism")
    public Map<String, Object> mechanism() {
        return info.mechanism();
    }

    @GetMapping("/items")
    public Map<String, Object> items(@RequestParam(required = false) String kind,
                                     @RequestParam(required = false) String source,
                                     @RequestParam(required = false) String q,
                                     @RequestParam(required = false) Integer page,
                                     @RequestParam(required = false) Integer size) {
        return info.items(kind, source, q, page, size);
    }

    @GetMapping("/items/{id}")
    public Map<String, Object> item(@PathVariable String id) {
        return info.item(id);
    }

    @GetMapping("/headlines")
    public Map<String, Object> headlines(@RequestParam(required = false) String set,
                                         @RequestParam(required = false) String feed,
                                         @RequestParam(required = false) String q,
                                         @RequestParam(required = false) Integer page,
                                         @RequestParam(required = false) Integer size) {
        return info.headlines(set, feed, q, page, size);
    }

    /** 번역 요청 — 수집 글이면 {@code itemId}만, 글 표에 없는 것(사건 뉴스)은 {@code title}·{@code text}. */
    public record TranslateRequest(String itemId, String title, String text) {
    }

    @PostMapping("/translate")
    public Map<String, Object> translate(@RequestBody TranslateRequest request) {
        return info.translate(request.itemId(), request.title(), request.text());
    }

    @GetMapping("/sources")
    public Map<String, Object> sources() {
        return info.sources();
    }

    @GetMapping("/flows")
    public Map<String, Object> flows() {
        return info.flows();
    }

    @GetMapping("/gurus")
    public Map<String, Object> gurus() {
        return info.gurus();
    }

    @GetMapping("/krx")
    public Map<String, Object> krx(@RequestParam(required = false) String market,
                                   @RequestParam(required = false) String investor,
                                   @RequestParam(required = false) String tradeType) {
        return info.krx(market, investor, tradeType);
    }
}
