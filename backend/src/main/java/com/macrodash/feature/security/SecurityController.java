package com.macrodash.feature.security;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 보안 공지(메뉴 더보기 '보안 공지', ADR 0046) — 운영자 전용, 읽기만 합니다(쓰기 경로 없음 — 결정 9의 4). 수집기가 받아 둔 공지·버전 목록을 읽고
 * 판정은 읽을 때 계산합니다(수집을 일으키지 않음).
 *
 * <pre>
 *  GET /api/security/notices            판정별 건수·버전 목록 기준 시각·수집 상태·공지 목록(verdict·reason·q·page·size)
 *  GET /api/security/notices/{nttId}    공지 한 건 — 틀 종류·※ 문장·표 행마다 판정·사유·설치 버전
 *  GET /api/security/inventory          버전 목록 — 구역 상태·구성 요소·apt 보류 목록
 * </pre>
 */
@RestController
@RequestMapping("/api/security")
public class SecurityController {

    private final SecurityService security;

    public SecurityController(SecurityService security) {
        this.security = security;
    }

    @GetMapping("/notices")
    public Map<String, Object> notices(@RequestParam(required = false) String verdict,
                                       @RequestParam(required = false) String reason,
                                       @RequestParam(required = false) String q,
                                       @RequestParam(required = false) Integer page,
                                       @RequestParam(required = false) Integer size) {
        return security.notices(verdict, reason, q, page, size);
    }

    @GetMapping("/notices/{nttId}")
    public Map<String, Object> notice(@PathVariable long nttId) {
        return security.notice(nttId);
    }

    @GetMapping("/inventory")
    public Map<String, Object> inventory() {
        return security.inventory();
    }
}
