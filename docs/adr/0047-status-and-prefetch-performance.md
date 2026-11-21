# 0047. 성능: 수집기 상태의 가벼운 보기(`/status?view=light`) · 상태 화면 행 수는 센 그대로 60초 기억 · 태스크 요약 질의는 범위 조건으로(QA-982)

- 상태: 채택 (2026-11-22, 사용자 결정 — 성능 개선 세 가지 실행 승인. D-3 '화면에 보이는 숫자는 그대로 정확한 값, 상태 화면(`/api/status`)에서만 세고 수집기 안에서
  60초 동안 기억해 다시 씀, 추정값으로 바꾸지 않음' · D-6 '새 의존성·스키마 변경·백엔드 새 경로 없음'). 지시문 [2026-11-22-perf-status-macro-js-exec-instructions.md](../specs/2026-11-22-perf-status-macro-js-exec-instructions.md),
  진행 기록 [2026-11-22-perf-status-macro-js-progress.md](../specs/2026-11-22-perf-status-macro-js-progress.md).
- 함께 보는 결정: [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(실행 기록 표는 수집기 표 — 백엔드는 읽기만, 이 결정도 그대로), `docs/qa/IMPROVEMENTS.md` 6번(행 수 세기 항목).
- 지키는 방법(시험): 계획 `test_store.py`의 `test_QA982_…기본_키를_거꾸로_훑지_않는다`·`StoreRepositoryTaskSummaryDbTest.planDoesNotScanPrimaryKeyBackward`(통계 없음·`ANALYZE` 뒤 둘 다),
  결과 동일 `…DISTINCT_ON과_같은_행…`·`sameRowsAsDistinctOn`, 가벼운 보기 `test_status_view.py`(세 칸만·행 수 세기·태스크 요약 없음·`full`의 같은 칸과 같음·`view` 값 검사),
  행 수 기억 `test_status_view.py::test_행_수는_60초_동안_기억하고_그_뒤에는_다시_센다`, 백엔드가 가벼운 보기만 부름 `DataStatusServiceTest.issuesAndBaselineUseLightStatus`.

## 배경

홈이 1분마다 부르는 `/api/status/issues`가 QA 스택에서 303 ms(2026-11-04에는 70.6 ms), `/api/status`가 289 ms였다. 나머지 화면 API는 2~30 ms다.
- 수집기 `/status`(`store.store_stats`) 230 ms 가운데 태스크별 최근 실행 요약 168 ms, 행 수 세기 둘(`timeseries`·`observations` `COUNT(*)`) 61 ms.
- 요약 질의는 `r.task = t.task … ORDER BY r.id DESC LIMIT 1` 꼴이었다. 계획기가 task를 상수로 보고 정렬을 `id DESC`로 줄인 뒤, 통계가 있으면 `(task, id DESC)` 색인 대신
  기본 키를 거꾸로 훑는 계획을 골랐다 — 기록이 없거나 드문 태스크마다 표 대부분을 읽음(QA-982). 운영은 그때 올바른 색인을 썼지만 두 계획의 추정 비용이 거의 같았다.
- 백엔드의 같은 꼴 질의(`StoreRepository.readTaskSummary` — 오류·경고 모음)도 같은 계획으로 72 ms.
- 오류·경고 모음은 수집기 응답 가운데 마지막 실행 상태와 누락 데이터셋만 쓰는데, 수집기는 부를 때마다 행 수 세기와 태스크 요약까지 만들었다. 행 수를 보여 주는 곳은 상태 화면 하나다.

## 결정

1. **요약 질의는 범위 조건**: 수집기 `store.read_task_summary`(`_task_summary_sql`)와 백엔드 `StoreRepository.TASK_SUMMARY_SQL`의 태스크 조건을 `r.task >= t.task AND r.task <= t.task`로,
   정렬을 `ORDER BY r.task, r.id DESC LIMIT 1`로 쓴다. 기본 키로는 이 정렬을 만들 수 없어 통계와 상관없이 `(task, id DESC)` 색인을 쓴다. 결과(행·순서·'아직 진행 중' 안내 행 건너뛰기 — QA-139)는 그대로다.
   같은 꼴의 다른 질의(`readTaskHistory`·`countTaskRunsStarted`·수집기 `read_task_history`)는 같음 조건에 실제 값이 들어가 QA에서 이미 색인을 써서(0.05~0.23 ms) 바꾸지 않는다.
2. **수집기 `/status`의 가벼운 보기**: 새 경로가 아니라 같은 경로의 질의 인자 `view=light`로 둔다 — 응답은 `{lastRun, lastRunStatus, missingDatasets}`. 백엔드 `DataStatusService.issues()`와
   새로고침 기준 실행 번호(`currentRunId`)가 `CollectorClient.statusLight()`로 이것만 부른다. 기본(`full`)은 그대로라 상태 화면(`/api/status`)·정보 화면이 읽는 값은 바뀌지 않는다.
   질의 인자로 둔 까닭: 수집기의 토큰 없이 여는 경로 목록(`/health`·`/status`)과 문서가 그대로이고, 값은 기본 보기의 세 칸과 같은 함수로 만든다(시험으로 대조).
   백엔드에 새 `/api` 경로는 없고 `/api/status`·`/api/status/issues`의 응답 모양과 값은 그대로다(고치기 전후 JSON이 시각 칸을 빼고 같음 — 진행 기록).
3. **행 수는 센 그대로 60초 기억**(D-3): 수집기 `store.row_counts()`가 두 `COUNT(*)`를 세고 60초(`ROW_COUNTS_MAX_AGE_SECONDS`) 동안 그 값을 다시 쓴다. 추정값(`pg_class.reltuples`)으로 바꾸지 않으므로
   `isEstimated`는 붙이지 않는다 — 값은 길어야 60초 지난 정확한 수다. 연결 풀을 닫으면 기억도 버린다(다른 DB일 수 있음).
4. 새로고침 확인(`useRefreshSignal`)이 전체 `/api/status`를 2~10초 간격으로 부르는 것은 그대로 둔다 — 위 1·3으로 그 경로가 10 ms대(기억이 빈 첫 호출만 100 ms 안팎)가 됐다.

## 결과

- QA 스택(단발 7회 중앙값): `/api/status/issues` 302 → 17 ms, `/api/status` 242 → 13 ms(기억이 빈 첫 호출은 4회 73~104 ms, 중앙 91 ms). 수집기 `/status` 6 ms, `/status?view=light` 3 ms.
  11경로 혼합 동시 50명: 177 → 581건/초, p95 2,449 → 266 ms(2026-11-04 250건/초·562 ms보다 나음), postgres CPU 평균 974 → 169%. 표는 진행 기록과 `docs/qa/evidence/2026-11-22-perf/`.
- 남은 위험: 행 수는 길어야 60초 지난 값이다(상태 화면의 '행 수'는 참고용 — 판단에 쓰지 않음). 범위 조건의 뜻을 모르고 같음 조건으로 '정리'하면 계획이 다시 흔들린다 — 시험이 막는다.
