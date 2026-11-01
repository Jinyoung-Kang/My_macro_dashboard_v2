package com.macrodash.feature.status;

import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 데이터 저장소 상태 · 교차 검증 · 헬스체크.
 *
 * <pre>
 *  GET  /api/health            헬스체크 (인증 없음)
 *  GET  /api/status/*          수집 현황·오류 모음·태스크·실행 이력
 *  POST /api/status/*          수동 새로고침·태스크 1건 실행
 *  POST /api/verification      교차 검증
 * </pre>
 *
 * <p>국내 공공 API 진단({@code /api/status/public-apis})은 출처가 같은
 * {@code feature.publicdata.PublicDataController}에, 전체 원본 텍스트({@code /api/snapshot/text})는
 * {@code feature.snapshot.SnapshotTextController}에 있습니다.
 */
@RestController
@RequestMapping("/api")
public class StatusController {

    private final DataStatusService status;
    private final VerificationService verification;

    public StatusController(DataStatusService status,
                            VerificationService verification) {
        this.status = status;
        this.verification = verification;
    }

    /**
     * 컨테이너 헬스체크·make doctor가 보는 상태.
     *
     * <p>예전에는 상수 {"status":"ok"}라 DB 연결이 죽어도 헬스체크가 초록이었습니다. DB에
     * 닿지 못하면 503입니다(이 앱에서 DB는 가용성이 필수인 유일한 계층).
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        boolean database = status.databaseReachable();
        Map<String, Object> body = Map.of(
                "status", database ? "ok" : "degraded",
                "database", database ? "ok" : "unreachable");
        return ResponseEntity.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).body(body);
    }

    // --------------------------------------------------- 저장소 상태
    @GetMapping("/status")
    public Map<String, Object> status() {
        return status.status();
    }

    /**
     * 수집 오류·경고 모음 — 지금 실패 중인 태스크, 최근 24시간 실패 이력(같은 사유는 묶음),
     * 누락 데이터셋. {@code text}는 그대로 복사해 붙일 수 있는 형태이고 비밀값은 가려져 있습니다.
     */
    @GetMapping("/status/issues")
    public Map<String, Object> statusIssues() {
        return status.issues();
    }

    @GetMapping("/status/tasks")
    public Map<String, Object> tasks() {
        return status.tasks();
    }

    @GetMapping("/status/history")
    public Map<String, Object> taskHistory(@RequestParam(required = false) String task,
                                           @RequestParam(defaultValue = "40") int limit) {
        return status.taskHistory(task, limit);
    }

    @PostMapping("/status/refresh")
    public Map<String, Object> refresh(@RequestParam(defaultValue = "true") boolean runFast) {
        return status.refresh(runFast);
    }

    /**
     * 태스크 1건 실행 시작 → 202. 끝났는지는 {@code GET /api/status/history?task=…&limit=1}의
     * 시작 시각이 {@code baselineStartedAt}보다 늦어졌는지로 확인합니다.
     *
     * @return 202 시작함 · 400 모르는 태스크 · 502 수집기에 닿지 못함
     */
    @PostMapping("/status/run/{taskName}")
    public ResponseEntity<Map<String, Object>> runTask(@PathVariable String taskName) {
        return ResponseEntity.accepted().body(status.startTask(taskName));
    }

    @PostMapping("/verification")
    public Map<String, Object> verification() {
        return verification.run();
    }
}
