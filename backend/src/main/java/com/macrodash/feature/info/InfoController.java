package com.macrodash.feature.info;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 정보 수집(모의매매 &gt; 정보 수집, ADR 0035) — 운영자 전용, 저장본만 읽습니다(화면이 수집을 일으키지 않음).
 *
 * <pre>
 *  GET /api/info/items        글 목록(최근부터, 본문 없이 — category·source·q·before·limit)
 *  GET /api/info/items/{id}   글 한 편(본문 포함)
 *  GET /api/info/sources      출처별 상태와 지금 끊긴 출처(모든 화면의 안내 띠)
 *  GET /api/info/flows        네이버 투자자별 매매동향·외국인·기관 매매상위
 *  GET /api/info/gurus        waedge 거장 견해
 * </pre>
 */
@RestController
@RequestMapping("/api/info")
public class InfoController {

    private final InfoService info;

    public InfoController(InfoService info) {
        this.info = info;
    }

    @GetMapping("/items")
    public Map<String, Object> items(@RequestParam(required = false) String category,
                                     @RequestParam(required = false) String source,
                                     @RequestParam(required = false) String q,
                                     @RequestParam(required = false) String before,
                                     @RequestParam(required = false) Integer limit) {
        return info.items(category, source, q, before, limit);
    }

    @GetMapping("/items/{id}")
    public Map<String, Object> item(@PathVariable String id) {
        return info.item(id);
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
}
