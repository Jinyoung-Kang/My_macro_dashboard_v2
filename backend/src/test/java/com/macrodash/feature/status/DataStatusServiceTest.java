package com.macrodash.feature.status;

import com.macrodash.collector.CollectorClient;
import com.macrodash.read.StoreReader;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.UpstreamUnavailableException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 태스크 수동 실행 — 끝날 때까지 기다리지 않고 시작만 합니다(BUG-03).
 *
 * <p>예전에는 수집기 대기 한도(90초)보다 오래 걸리는 태스크(13F 등)를 "다시 실행"하면
 * 실제로는 수집 중인데 "수집기에 연결하지 못했습니다"로 표시됐습니다(재현: 한도 3초·작업 5초).
 */
class DataStatusServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final CollectorClient collector = mock(CollectorClient.class);
    private final StoreRepository repository = mock(StoreRepository.class);
    private final DataStatusService service =
            new DataStatusService(repository, mock(StoreReader.class), collector);

    private JsonNode tasks(String... names) {
        var array = mapper.createArrayNode();
        for (String name : names) {
            array.addObject().put("name", name);
        }
        var root = mapper.createObjectNode();
        root.set("tasks", array);
        return root;
    }

    @Test
    @DisplayName("기다리지 않고(wait=false) 시작하고, 끝난 것을 가릴 기준 시각을 돌려준다")
    void startsWithoutWaitingAndReturnsBaseline() {
        Instant previous = Instant.parse("2026-09-27T00:00:00.123Z");
        when(collector.tasks()).thenReturn(Optional.of(tasks("sec_13f", "fred_series")));
        when(repository.readTaskHistory("sec_13f", 1))
                .thenReturn(List.of(Map.of("started_at", Timestamp.from(previous))));
        when(collector.runTask("sec_13f", false)).thenReturn(Optional.of(mapper.createObjectNode()));

        Map<String, Object> result = service.startTask("sec_13f");

        assertThat(result).containsEntry("accepted", true).containsEntry("task", "sec_13f");
        assertThat(result.get("baselineStartedAt")).isEqualTo(previous.toString());
        verify(collector).runTask("sec_13f", false);
        verify(collector, never()).runTask("sec_13f", true);
    }

    @Test
    @DisplayName("기준 시각은 화면이 확인하는 경로(수집기 실행 이력)와 같은 곳에서 읽는다")
    void baselineComesFromTheSamePathAsPolling() {
        var history = mapper.createObjectNode();
        history.putArray("history").addObject().put("startedAt", "2026-09-26T00:00:00+00:00");
        when(collector.tasks()).thenReturn(Optional.of(tasks("sec_13f")));
        when(collector.taskHistory("sec_13f", 1)).thenReturn(Optional.of(history));
        when(collector.runTask("sec_13f", false)).thenReturn(Optional.of(mapper.createObjectNode()));

        assertThat(service.startTask("sec_13f"))
                .containsEntry("baselineStartedAt", "2026-09-26T00:00:00+00:00");
        verify(repository, never()).readTaskHistory(anyString(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    @DisplayName("실행 기록이 한 번도 없던 태스크는 기준 시각이 null")
    void baselineIsNullWithoutHistory() {
        when(collector.tasks()).thenReturn(Optional.of(tasks("kr_holidays")));
        when(repository.readTaskHistory("kr_holidays", 1)).thenReturn(List.of());
        when(collector.runTask("kr_holidays", false)).thenReturn(Optional.of(mapper.createObjectNode()));

        assertThat(service.startTask("kr_holidays")).containsEntry("baselineStartedAt", null);
    }

    @Test
    @DisplayName("수집기가 모르는 태스크는 400 — 실행을 요청하지 않는다")
    void unknownTaskIsRejected() {
        when(collector.tasks()).thenReturn(Optional.of(tasks("sec_13f")));

        assertThatThrownBy(() -> service.startTask("nope"))
                .isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("nope");
        verify(collector, never()).runTask(anyString(), anyBoolean());
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 502 — 200에 ok:false로 숨기지 않는다")
    void unreachableCollectorIsBadGateway() {
        when(collector.tasks()).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.startTask("sec_13f"))
                .isInstanceOf(UpstreamUnavailableException.class);
    }

    @Test
    @DisplayName("실행 요청이 거절되면 502")
    void rejectedRunIsBadGateway() {
        when(collector.tasks()).thenReturn(Optional.of(tasks("sec_13f")));
        when(repository.readTaskHistory("sec_13f", 1)).thenReturn(List.of());
        when(collector.runTask("sec_13f", false)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.startTask("sec_13f"))
                .isInstanceOf(UpstreamUnavailableException.class);
    }

    @Test
    @DisplayName("수집기 응답에 키가 빠져도 500이 아니라 빈 목록이다 (Map.of는 null을 거부한다)")
    void missingKeysInCollectorResponseDoNotCrash() {
        when(collector.taskHistory("x", 10)).thenReturn(Optional.of(mapper.createObjectNode()));
        when(collector.tasks()).thenReturn(Optional.of(mapper.createObjectNode()));

        assertThat(service.taskHistory("x", 10)).containsEntry("history", List.of());
        assertThat(service.tasks()).containsEntry("tasks", List.of());
    }

    // 수정 전에는 수집기에 닿지 못해도 누락 목록을 빈 목록으로 넘겨 '누락 데이터셋 0'이 됐다(화면은 초록 '오류·경고 없음').
    @Test
    @DisplayName("오류·경고 모음: 수집기에 닿지 못하면 누락 데이터셋 수는 모름(null), 복사 텍스트도 '확인 못 함'")
    @SuppressWarnings("unchecked")
    void issuesWithoutCollectorDoNotClaimZeroMissing() {
        when(collector.statusLight()).thenReturn(Optional.empty());
        when(collector.tasks()).thenReturn(Optional.empty());
        when(repository.readTaskSummary()).thenReturn(List.of());
        when(repository.readRecentTaskIssues(any(), anyInt())).thenReturn(List.of());

        Map<String, Object> out = service.issues();

        assertThat(out).containsEntry("collectorReachable", false);
        assertThat((Map<String, Object>) out.get("counts")).containsEntry("missingDatasets", null);
        assertThat((String) out.get("text")).contains("확인 못 함(수집기 연결 안 됨)").doesNotContain("누락 데이터셋 0");
    }
    @Test
    @DisplayName("오류·경고 모음과 새로고침 기준 실행 번호는 수집기의 가벼운 상태만 부른다 — 행 수 세기·태스크 요약을 일으키지 않음(ADR 0047)")
    @SuppressWarnings("unchecked")
    void issuesAndBaselineUseLightStatus() {
        JsonNode light = mapper.readTree("""
                {"lastRun": {"id": 42, "status": "ok"}, "lastRunStatus": "partial",
                 "missingDatasets": [{"name": "fake_snap", "label": "가짜 데이터셋"}]}
                """);
        when(collector.statusLight()).thenReturn(Optional.of(light));
        when(collector.tasks()).thenReturn(Optional.of(tasks("fake_task")));
        when(repository.readTaskSummary()).thenReturn(List.of());
        when(repository.readRecentTaskIssues(any(), anyInt())).thenReturn(List.of());
        StoreReader reader = mock(StoreReader.class);
        when(reader.readMode()).thenReturn(com.macrodash.config.AppProperties.ReadMode.AUTO);
        DataStatusService withReader = new DataStatusService(repository, reader, collector);
        when(collector.requestRefresh()).thenReturn(Optional.of(mapper.createObjectNode()));
        when(collector.runGroup("fast", false)).thenReturn(Optional.of(mapper.createObjectNode()));

        Map<String, Object> out = withReader.issues();
        Map<String, Object> refreshed = withReader.refresh(true);

        assertThat(out).containsEntry("collectorReachable", true);
        assertThat((Map<String, Object>) out.get("counts")).containsEntry("missingDatasets", 1);
        assertThat((String) out.get("text")).contains("가짜 데이터셋 (fake_snap)");
        assertThat(refreshed).containsEntry("baselineRunId", 42L);
        verify(collector, never()).status();
    }
}
