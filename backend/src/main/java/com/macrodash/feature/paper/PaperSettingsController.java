package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 모의 매매 설정(운영자 전용, 명세 S1~S3) — 설정 한 행 보기·바꾸기·이력. 장부는 {@link PaperController}, 결정은
 * {@link PaperDecisionController}입니다.
 *
 * <pre>
 *  GET  /api/paper/settings           지금 설정(버전·본문·기본값·키 설명)
 *  POST /api/paper/settings           {"키": 값, …} 바꿀 키만(점 경로 또는 묶음) → {ok, version, changedKeys, warning}
 *  GET  /api/paper/settings/history   설정 변경 이력(최근 버전 순)
 * </pre>
 *
 * <p>테이블이 없으면 500이 아니라 {@code available:false}(+ POST는 {@code ok:false})입니다. 형·범위가 틀린 값은 400이고 아무것도
 * 바꾸지 않습니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperSettingsController {

    private final PaperSettingsService settings;

    public PaperSettingsController(PaperSettingsService settings) {
        this.settings = settings;
    }

    @GetMapping("/settings")
    public Map<String, Object> settings() {
        return settings.view();
    }

    /** 본문은 JSON 객체 그대로 받아(키가 정해져 있지 않음) 서비스가 키·형·범위를 검사합니다. */
    @PostMapping("/settings")
    public Map<String, Object> update(@RequestBody(required = false) Map<String, Object> patch) {
        return settings.updateBody(patch);
    }

    @GetMapping("/settings/history")
    public Map<String, Object> history() {
        return settings.history();
    }
}
