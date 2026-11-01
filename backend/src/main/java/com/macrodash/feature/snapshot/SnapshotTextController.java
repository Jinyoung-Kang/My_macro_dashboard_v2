package com.macrodash.feature.snapshot;

import com.macrodash.read.ComputedCache;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 전체 원본 데이터 — 수집한 대시보드 원본 텍스트(화면 표시·복사용). */
@RestController
@RequestMapping("/api")
public class SnapshotTextController {

    private final SnapshotTextService snapshotText;

    private final ComputedCache cache;

    public SnapshotTextController(SnapshotTextService snapshotText, ComputedCache cache) {
        this.snapshotText = snapshotText;
        this.cache = cache;
    }

    /**
     * 수집한 전체 대시보드 원본 텍스트 (AI 분석 없음 · 화면 표시/복사용).
     *
     * <p>AI 리포트에 들어가는 것과 같은 텍스트지만 AI 경로 아래에 두지 않습니다. 원본
     * 데이터를 보는 일은 AI 키가 없어도 되는 기능인데, AI 경로 아래에 두면 "AI 기능"으로
     * 읽히기 때문입니다. 응답 캐시 항목은 {@link SnapshotTextService#CACHE_KEY}입니다.
     */
    @GetMapping("/snapshot/text")
    public Map<String, Object> snapshotText() {
        // 전 화면을 훑어 만드는 텍스트 — 같은 저장본이면 다시 만들지 않습니다(ComputedCache).
        return cache.get(SnapshotTextService.CACHE_KEY, snapshotText::payload);
    }
}
