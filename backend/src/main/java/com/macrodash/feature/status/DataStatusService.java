package com.macrodash.feature.status;

import com.macrodash.collector.CollectorClient;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import com.macrodash.support.SecretRedactor;
import com.macrodash.support.UpstreamUnavailableException;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 데이터 저장소 상태.
 *
 * <p>구버전 {@code collector.py --status}가 터미널에 출력하던 내용을 화면에서
 * 그대로 볼 수 있게 합니다.
 * <ul>
 *   <li>태스크별 최근 결과 — 정상 / 데이터 없음 / 오류 + 실패 이유</li>
 *   <li>있어야 하는데 없는 데이터셋 — 기대 목록과 대조</li>
 *   <li>실제 실행 상태 — 수집기가 죽으면 기록은 'running'에 남습니다.
 *       PID 생존 여부와 heartbeat로 검사해 '비정상 종료'로 보고합니다.</li>
 * </ul>
 */
@Service
public class DataStatusService {

    private final StoreRepository repository;
    private final StoreReader store;
    private final CollectorClient collector;

    public DataStatusService(StoreRepository repository, StoreReader store,
                             CollectorClient collector) {
        this.repository = repository;
        this.store = store;
        this.collector = collector;
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("readMode", store.readMode().name().toLowerCase());

        // 수집기가 살아 있으면 그쪽 요약을 씁니다(키 보유 여부·누락 목록을 압니다).
        Optional<JsonNode> collectorStatus = collector.status();
        if (collectorStatus.isPresent()) {
            JsonNode payload = collectorStatus.get();
            out.put("collectorReachable", true);
            out.put("keys", payload.get("keys"));
            out.put("intervals", payload.get("intervals"));
            out.put("missingDatasets", payload.get("missingDatasets"));
            out.put("lastRun", redactDetails(payload.get("lastRun")));
            out.put("lastRunStatus", Json.asText(payload, "lastRunStatus"));
            out.put("taskSummary", redactDetails(payload.get("taskSummary")));
            out.put("timeseriesRows", Json.asDouble(payload, "timeseriesRows"));
            out.put("observationRows", Json.asDouble(payload, "observationRows"));
        } else {
            // 수집기가 죽어 있어도 상태 화면은 떠야 합니다. DB만으로 채웁니다.
            out.put("collectorReachable", false);
            out.put("message",
                    "수집기에 연결하지 못했습니다. 아래 정보는 데이터베이스에서 직접 읽은 값입니다.");
            // 수집기가 주는 것과 같은 모양으로 바꿔 내보냅니다(아래 runView·taskView 설명).
            Optional<Map<String, Object>> lastRun = repository.readLastRun();
            out.put("lastRun", lastRun.map(DataStatusService::runView).orElse(null));
            out.put("lastRunStatus", resolveRunStatus(lastRun.orElse(null), Instant.now()));
            out.put("taskSummary", repository.readTaskSummary().stream().map(DataStatusService::taskView).toList());
            out.put("timeseriesRows", repository.countTimeseries());
            out.put("observationRows", repository.countObservations());
        }

        out.put("snapshots", snapshotFreshness());
        out.put("radarHistoryDates", repository.listObservationDates(Datasets.OBS_RADAR));
        return out;
    }

    /** 스냅샷별 신선도. 화면이 "몇 분 전 수집"과 "오래됨"을 표시합니다. */
    private List<Map<String, Object>> snapshotFreshness() {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> meta : repository.listSnapshotMeta()) {
            Map<String, Object> row = new LinkedHashMap<>(meta);
            Object collectedAt = meta.get("collectedAt");
            if (collectedAt instanceof Instant instant) {
                long age = Math.max(0,
                        java.time.Duration.between(instant, Instant.now()).getSeconds());
                row.put("ageSeconds", age);
                row.put("stale", age > Datasets.MAX_AGE_DAILY);
            }
            rows.add(row);
        }
        return rows;
    }

    /** 오류·경고 모음이 되돌아보는 기간과, 그 기간을 찾으려고 살펴볼 최근 실행 기록 수. */
    static final java.time.Duration ISSUE_LOOKBACK = java.time.Duration.ofHours(24);
    static final int ISSUE_WINDOW = 3000;

    /**
     * 수집 오류·경고 모음 (복사용 텍스트 포함). {@link StatusIssues} 참고.
     *
     * <p>실행 기록은 DB에서 직접 읽습니다 — 수집기가 죽어 있을 때가 가장 로그가 필요한
     * 때입니다. 수집기에 닿으면 등록된 태스크 목록과 누락 데이터셋을 더합니다. 닿지 않으면
     * 누락 데이터셋은 모름(null)입니다.
     */
    public Map<String, Object> issues() {
        Optional<JsonNode> collectorStatus = collector.status();
        List<Map<String, Object>> latest = repository.readTaskSummary();
        List<Map<String, Object>> history =
                repository.readRecentTaskIssues(Instant.now().minus(ISSUE_LOOKBACK), ISSUE_WINDOW);

        // 누락 목록은 수집기만 압니다. 닿지 않으면 null(모름)로 넘깁니다 — 빈 목록을 넘기면 '누락 0'이 됩니다(QA-102).
        List<String> missing = null;
        String lastRunStatus = null;
        java.util.Set<String> registered = null;
        if (collectorStatus.isPresent()) {
            JsonNode payload = collectorStatus.get();
            lastRunStatus = Json.asText(payload, "lastRunStatus");
            missing = new ArrayList<>();
            for (JsonNode entry : Json.array(payload, "missingDatasets")) {
                missing.add(Json.asText(entry, "label") + " (" + Json.asText(entry, "name") + ")");
            }
        }
        // 없앤 태스크의 옛 기록을 거르려면 지금 등록된 목록이 필요합니다(수집기만 압니다).
        // 수집기에 닿지 않으면 거르지 않습니다 — 모르는 것을 숨기는 것보다 낫습니다.
        Optional<JsonNode> tasks = collector.tasks();
        if (tasks.isPresent()) {
            registered = new java.util.HashSet<>();
            for (JsonNode task : Json.array(tasks.get(), "tasks")) {
                registered.add(Json.asText(task, "name"));
            }
        }

        Map<String, Object> out = new LinkedHashMap<>(
                StatusIssues.build(latest, history, missing, lastRunStatus, registered, Instant.now()));
        out.put("collectorReachable", collectorStatus.isPresent());
        out.put("lookbackHours", ISSUE_LOOKBACK.toHours());
        return out;
    }

    /** 실행 이력 한 번에 볼 수 있는 최대 행 수 (수집기 {@code /task-history}의 le=200과 같음). */
    static final int MAX_HISTORY_ROWS = 200;

    /** DB에 닿는가 — /api/health가 씁니다. */
    public boolean databaseReachable() {
        return repository.ping();
    }

    /**
     * 태스크 실행 이력.
     *
     * @param limit 1~{@value #MAX_HISTORY_ROWS}로 접습니다. 예전에는 음수가 그대로 SQL
     *              {@code LIMIT}에 들어가 500과 함께 SQL 문장이 응답에 실렸습니다.
     */
    public Map<String, Object> taskHistory(String task, int limit) {
        int rows = Params.clamp(limit, 1, MAX_HISTORY_ROWS);
        Optional<JsonNode> payload = collector.taskHistory(task, rows);
        Map<String, Object> out = new LinkedHashMap<>();
        if (payload.isPresent()) {
            // Map.of는 null 값을 거부합니다(NPE → 500). 수집기 응답에 키가 빠지면 빈 목록입니다.
            JsonNode history = payload.get().get("history");
            out.put("history", history == null ? List.of() : redactDetails(history));
            return out;
        }
        out.put("history",
                repository.readTaskHistory(task, rows).stream().map(DataStatusService::taskView).toList());
        return out;
    }

    // ------------------------------------------------------------ 실패 사유의 비밀값 가림
    // 사유는 예외 문구 그대로라 요청 URL(쿼리의 API 키)이 섞일 수 있고, 화면에 나가 복사됩니다.
    // 수집기도 저장·응답 전에 가리지만, 수집기가 죽어 DB에서 바로 읽는 경로와 가리기 전에
    // 저장된 기록이 있어 내보내기 직전에 한 번 더 거릅니다(오류 모음은 StatusIssues가 가림).

    /** 수집기 응답(객체 하나 또는 배열)의 detail. 응답을 파싱한 사본이라 그 자리에서 바꿉니다. */
    private static JsonNode redactDetails(JsonNode node) {
        if (node != null && node.isArray()) {
            node.forEach(DataStatusService::redactDetailNode);
        } else if (node != null) {
            redactDetailNode(node);
        }
        return node;
    }

    private static void redactDetailNode(JsonNode node) {
        if (node instanceof ObjectNode object && object.path("detail").isString()) {
            object.put("detail", SecretRedactor.redact(object.path("detail").asString()));
        }
    }

    // ------------------------------------------------------------ 수집기가 꺼졌을 때의 응답 모양
    // DB에서 바로 읽은 행을 수집기 /status·/task-history와 같은 모양으로 바꿉니다
    // (collector/app/store.py의 _serialize_run·_serialize_task — StatusShapeParityTest가 대조).
    // 예전에는 DB 행을 그대로 내보내 started_at·ok_count 같은 이름이 나갔고, 화면이 읽지 못해
    // "기록 없음 · 0 / 0 · NaNs"가 보였습니다(BUG-06).

    /** 'running' 기록을 비정상 종료로 보는 heartbeat 공백 (수집기 store.STALE_RUN_SECONDS와 같음). */
    static final Duration STALE_RUN = Duration.ofMinutes(30);

    /** collector_runs 한 행 → 수집기 lastRun 모양. 실패 사유의 비밀값은 가립니다. */
    static Map<String, Object> runView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", row.get("id"));
        out.put("startedAt", iso(row.get("started_at")));
        out.put("finishedAt", iso(row.get("finished_at")));
        out.put("heartbeatAt", iso(row.get("heartbeat_at")));
        out.put("status", row.get("status"));
        out.put("okCount", row.get("ok_count"));
        out.put("failCount", row.get("fail_count"));
        out.put("detail", redacted(row.get("detail")));
        out.put("pid", row.get("pid"));
        out.put("host", row.get("host"));
        out.put("groupName", row.get("group_name"));
        return out;
    }

    /** collector_task_runs 한 행 → 수집기 태스크 기록 모양 (요약·이력 공통). */
    static Map<String, Object> taskView(Map<String, Object> row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("task", row.get("task"));
        out.put("speed", row.get("speed"));
        out.put("status", row.get("status"));
        out.put("startedAt", iso(row.get("started_at")));
        out.put("durationMs", row.get("duration_ms"));
        out.put("detail", redacted(row.get("detail")));
        out.put("runId", row.get("run_id"));
        return out;
    }

    /**
     * 기록된 status를 실제 상태로 보정합니다 — 수집기 resolve_run_status와 같은 규칙.
     *
     * <p>'running'인데 heartbeat(없으면 시작 시각)가 30분 넘게 끊겼으면 'interrupted'.
     * 수집기는 PID 생존도 보지만, 백엔드는 다른 컨테이너라 PID를 볼 수 없어 시각만 봅니다.
     *
     * @param row 가장 최근 실행 기록. 없으면 null
     * @return none · ok · partial · fail · running · interrupted …
     */
    static String resolveRunStatus(Map<String, Object> row, Instant now) {
        if (row == null) {
            return "none";
        }
        Object status = row.get("status");
        if (!"running".equals(status)) {
            return status == null ? "?" : status.toString();
        }
        Object beat = row.get("heartbeat_at") != null ? row.get("heartbeat_at") : row.get("started_at");
        if (beat instanceof Timestamp timestamp
                && Duration.between(timestamp.toInstant(), now).compareTo(STALE_RUN) > 0) {
            return "interrupted";
        }
        return "running";
    }

    /** DB 시각 → ISO-8601 (수집기 응답과 같은 형식). 화면의 formatKst가 그대로 읽습니다. */
    private static String iso(Object value) {
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant().toString();
        }
        return value == null ? null : value.toString();
    }

    private static Object redacted(Object detail) {
        return detail instanceof String text ? SecretRedactor.redact(text) : detail;
    }

    /** 수동 새로고침: 기준 시각을 갱신하고, auto 모드면 fast 작업을 함께 돌립니다. */
    public Map<String, Object> refresh(boolean runFast) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("readMode", store.readMode().name().toLowerCase());

        if (store.readMode() == com.macrodash.config.AppProperties.ReadMode.STORE_ONLY) {
            // store_only의 약속은 "화면이 절대 외부를 기다리지 않는다"입니다.
            // 저장본을 다시 읽기만 하고 수집은 수집기의 몫으로 남깁니다.
            out.put("triggered", false);
            out.put("message",
                    "store_only 모드입니다. 저장본만 다시 읽었습니다 (수집은 수집기가 담당합니다).");
            return out;
        }

        Optional<JsonNode> refreshed = collector.requestRefresh();
        out.put("refreshRequested", refreshed.isPresent());

        if (runFast) {
            // 수집 시작 **전**의 실행 번호를 함께 돌려줍니다. 화면은 이 번호가
            // 바뀌고 finishedAt이 찍힐 때까지 기다렸다가 스스로 다시 읽습니다.
            // 이게 없으면 "잠시 후 새로고침하세요"라고 사람에게 떠넘기게 됩니다.
            out.put("baselineRunId", currentRunId().orElse(null));

            Optional<JsonNode> result = collector.runGroup("fast", false);
            out.put("triggered", result.isPresent());
            out.put("message", result.isPresent()
                    ? "수집기에 fast 작업을 요청했습니다. 끝나면 화면이 자동으로 갱신됩니다."
                    : "수집기에 연결하지 못했습니다. 저장본을 그대로 표시합니다.");
        } else {
            out.put("triggered", false);
            out.put("message", "다음 조회에서 저장본을 다시 확인합니다.");
        }
        return out;
    }

    /** 수집기가 기록한 마지막 실행 번호. 수집기가 죽어 있으면 비어 있습니다. */
    private Optional<Long> currentRunId() {
        return collector.status()
                .map(node -> node.path("lastRun").path("id"))
                .filter(JsonNode::isNumber)
                .map(JsonNode::asLong);
    }

    /** 수집 작업 목록 (화면에서 개별 실행 버튼을 그리기 위해). */
    public Map<String, Object> tasks() {
        Optional<JsonNode> payload = collector.tasks();
        Map<String, Object> out = new LinkedHashMap<>();
        if (payload.isPresent()) {
            JsonNode tasks = payload.get().get("tasks");
            out.put("tasks", tasks == null ? List.of() : tasks);
            return out;
        }
        out.put("tasks", List.of());
        out.put("collectorReachable", false);
        return out;
    }

    /**
     * 태스크 1건의 실행을 <b>시작</b>합니다(끝날 때까지 기다리지 않습니다).
     *
     * <p>예전에는 끝날 때까지 기다렸는데, 수집기 대기 한도(90초)보다 오래 걸리는 태스크
     * (13F 등)는 실제로는 수집 중인데도 "수집기에 연결하지 못했습니다"로 표시됐습니다.
     * 이제 바로 답하고, 화면이 실행 이력을 보며 끝났는지 확인합니다.
     *
     * @return {@code accepted, task, baselineStartedAt} — 이보다 늦게 시작한 실행 기록이 생기면
     *         끝난 것입니다(수집기는 태스크가 끝날 때 기록을 남깁니다). 기록이 없었으면 null
     * @throws InvalidRequestException      수집기에 등록되지 않은 태스크
     * @throws UpstreamUnavailableException 수집기에 닿지 못함
     */
    public Map<String, Object> startTask(String taskName) {
        Optional<JsonNode> registered = collector.tasks();
        if (registered.isEmpty()) {
            throw new UpstreamUnavailableException("수집기에 연결하지 못했습니다. 수집기가 실행 중인지 확인하세요.");
        }
        boolean known = Json.array(registered.get(), "tasks").stream()
                .anyMatch(task -> taskName.equals(Json.asText(task, "name")));
        if (!known) {
            throw new InvalidRequestException("알 수 없는 태스크입니다: " + Params.echo(taskName));
        }

        String baseline = latestStartedAt(taskName);
        if (collector.runTask(taskName, false).isEmpty()) {
            throw new UpstreamUnavailableException("수집기가 실행 요청을 받지 못했습니다. 잠시 후 다시 시도하세요.");
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("accepted", true);
        out.put("task", taskName);
        out.put("baselineStartedAt", baseline);
        return out;
    }

    /**
     * 그 태스크의 가장 최근 실행 기록이 시작한 시각(ISO-8601). 기록이 없으면 null.
     *
     * <p>화면이 끝났는지 확인할 때 읽는 경로({@link #taskHistory})와 <b>같은 곳</b>에서 읽습니다.
     * 다른 곳에서 읽으면 한쪽에만 있는 옛 기록을 "방금 끝난 실행"으로 착각할 수 있습니다.
     */
    private String latestStartedAt(String taskName) {
        Optional<JsonNode> fromCollector = collector.taskHistory(taskName, 1);
        if (fromCollector.isPresent()) {
            List<JsonNode> rows = Json.array(fromCollector.get(), "history");
            return rows.isEmpty() ? null : Json.asText(rows.get(0), "startedAt");
        }
        List<Map<String, Object>> rows = repository.readTaskHistory(taskName, 1);
        if (rows.isEmpty()) {
            return null;
        }
        return iso(rows.get(0).get("started_at"));
    }
}
