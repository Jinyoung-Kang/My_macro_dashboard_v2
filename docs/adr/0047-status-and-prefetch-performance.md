# 0047. 성능: 수집기 상태의 가벼운 보기(`/status?view=light`) · 상태 화면 행 수는 센 그대로 60초 기억 · 태스크 요약 질의는 범위 조건으로(QA-982) · 화면 안 링크는 가리킬 때만 미리 받기 · 셸·홈은 정보 검색 전체 모듈을 싣지 않음

- 상태: 채택 (2026-11-22, 사용자 결정 — 성능 개선 세 가지 실행 승인. D-3 '화면에 보이는 숫자는 그대로 정확한 값, 상태 화면(`/api/status`)에서만 세고 수집기 안에서
  60초 동안 기억해 다시 씀, 추정값으로 바꾸지 않음' · D-4 '미리 받기는 가리킬 때만(마우스 올림·키보드 초점·터치 시작), 이동 시간이 중앙값 150 ms 넘게 늘면 멈춤' · D-6 '새 의존성·스키마 변경·백엔드 새 경로 없음'). 지시문 [2026-11-22-perf-status-macro-js-exec-instructions.md](../specs/2026-11-22-perf-status-macro-js-exec-instructions.md),
  진행 기록 [2026-11-22-perf-status-macro-js-progress.md](../specs/2026-11-22-perf-status-macro-js-progress.md).
- 함께 보는 결정: [ADR 0008](0008-backend-owned-tables-and-scheduled-jobs.md)(실행 기록 표는 수집기 표 — 백엔드는 읽기만, 이 결정도 그대로), `docs/qa/IMPROVEMENTS.md` 6번(행 수 세기 항목).
- 지키는 방법(시험): 계획 `test_store.py`의 `test_QA982_…기본_키를_거꾸로_훑지_않는다`·`StoreRepositoryTaskSummaryDbTest.planDoesNotScanPrimaryKeyBackward`(통계 없음·`ANALYZE` 뒤 둘 다),
  결과 동일 `…DISTINCT_ON과_같은_행…`·`sameRowsAsDistinctOn`, 가벼운 보기 `test_status_view.py`(세 칸만·행 수 세기·태스크 요약 없음·`full`의 같은 칸과 같음·`view` 값 검사),
  행 수 기억 `test_status_view.py::test_행_수는_60초_동안_기억하고_그_뒤에는_다시_센다`, 백엔드가 가벼운 보기만 부름 `DataStatusServiceTest.issuesAndBaselineUseLightStatus`.
  화면: 미리 받기 속성·next/link 직접 가져오기 금지 `components/ui/__tests__/IntentLink.test.tsx`, 차트 없는 화면이 recharts에 닿지 않음과 셸·홈이 `lib/infoSearch.ts`에 닿지 않음
  `components/charts/__tests__/chartlessScreens.test.ts`(가져오기 그래프), 팔레트 가져오기 목록 `paletteNoWrites.test.tsx`. 측정 도구 `scripts/qa/nav-timing.js`(이동 시간).
  매크로 그리기: `gridNoVertical.test.ts`(세로 격자 없는 격자는 빈 생성기), `LineChart.test.tsx`의 '외딴 값이 없는 선은 점 층을 만들지 않는다', `useChartWidth.test.tsx`(붙기 전에 잼·같은 너비로는 차트를 다시 그리지 않음).
  측정 도구 `scripts/qa/render-profile.js`(커밋마다 그린 컴포넌트·횟수·시간).

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
5. **화면 안 링크는 가리킬 때만 미리 받는다**(D-4): 공용 `components/ui/IntentLink`가 처음에는 `prefetch={false}`이고, 마우스 올림·키보드 초점·터치 시작 가운데 하나가 오면
   Next 기본(`prefetch={null}`)으로 돌아간다(Next.js 16.4.5 문서의 '가리킬 때만' 꼴). 호출한 쪽이 준 `prefetch={false}`는 그대로다. `next/link`를 쓰던 47곳이 모두 이것을 쓰고,
   시험이 `next/link` 직접 가져오기를 막는다 — 새 링크가 보이는 것만으로 미리 받기를 되살리지 않게. 이유: 셸 메뉴·목록의 링크가 화면마다 24~31개를 미리 받아(RSC + 그 화면의 스크립트)
   어느 화면을 열든 앱 전체 JS의 약 70%를 받았다. 이동 시간은 QA에서 고치기 전(미리 받기가 끝난 뒤 누름)과 견줘 −22 ~ +61 ms(가리킨 즉시 누르는 가장 나쁜 경우 +23 ~ +60 ms)로 멈춤 기준(+150 ms) 안이다.
6. **차트 없는 화면은 recharts에 닿지 않는다**: 홈·정보 개요·공용 레이아웃의 가져오기 그래프에 recharts·차트 배럴이 없다(분석상 처음부터 없었고, 홈의 recharts는 미리 받기로 왔음 — 시험으로 지킴).
   차트가 있는 화면의 `next/dynamic` 늦게 싣기는 하지 않는다 — 첫 화면에 차트가 바로 보이는 화면이라 CLS 위험에 견줘 이득이 작다고 봄(재지 않음).
7. **셸·홈은 정보 검색 전체 모듈을 싣지 않는다**: 명령 팔레트(`lib/search.ts`)와 홈 알림 요약이 함수 하나씩(`searchHref`·`searchWatchInboxHref`) 쓰려고 `lib/infoSearch.ts`(소스 166 KB, 묶음 42 KB)
   전체를 모든 화면의 첫 로딩에 끌고 왔다. 그 함수와 의존하는 대상 키 검사를 `lib/searchKey.ts`로 옮기고(infoSearch가 같은 이름으로 다시 내보냄) 셸·홈은 그것만 가져온다.
8. **매크로 화면의 그리기(작업 B — 보이는 내용·순서·구조는 그대로, D-5)**: 원인은 React의 화면 코드보다 차트 라이브러리 쪽이었다(진행 기록 B1 표).
   - 세로 격자를 그리지 않는 `CartesianGrid`에는 빈 세로 좌표 생성기(`charts/frame`의 `NO_VERTICAL_GRID`)를 준다 — Recharts 3.10.1은 `vertical={false}`여도 X축 눈금 글을 DOM에 넣어 잰다.
   - 외딴 점이 없는 선 차트는 `dot={false}` — 함수를 주면 값마다 점 부품을 만든다.
   - 매크로 화면의 여덟 구역은 `memo` — 꼭대기 상태(실시간 시세·1분 시계·자동 갱신 간격·응답)가 바뀌어도 받는 값이 같은 구역은 다시 그리지 않는다.
   - 선 차트는 붙기 전에 상자 너비를 먼저 잰다(`charts/useChartWidth`) — `onResize` 뒤의 차트 전체 다시 그리기와 그에 딸린 내부 연쇄를 없앤다.
   - 하지 않은 것: 화면 밖 구역의 `content-visibility`(효과 없고 CLS가 나빠짐), 탭 나누기·스크롤해야 그리기·구역 접기·늦게 그리기(D-5 — 사용자에게 물음), 점 수 줄이기·축 너비 고정·곡선 꼴 바꾸기(그림이 바뀜).


## 결과

- QA 스택(단발 7회 중앙값): `/api/status/issues` 302 → 17 ms, `/api/status` 242 → 13 ms(기억이 빈 첫 호출은 4회 73~104 ms, 중앙 91 ms). 수집기 `/status` 6 ms, `/status?view=light` 3 ms.
  11경로 혼합 동시 50명: 177 → 581건/초, p95 2,449 → 266 ms(2026-11-04 250건/초·562 ms보다 나음), postgres CPU 평균 974 → 169%. 표는 진행 기록과 `docs/qa/evidence/2026-11-22-perf/`.
- 화면(QA, Lighthouse 13.6.0 3회 중앙값, 같은 백엔드에서 고치기 전과 비교): RSC 미리 받기 화면마다 18~32건 → 0건, 첫 로딩 스크립트 38~44개 748~839 KB → 21~24개 285~584 KB
  (홈 759 → 342 KB, −55%). CLS는 늘지 않았고(매크로 모바일 0.032 → 0, 나머지 같음) 모바일 점수는 ±3점 안(매크로 47 → 53, 정보 개요 64 → 67, 기관 71 → 68). 기관 모바일은
  메인 스레드가 줄고 모의 TTI가 6.6 → 4.8초로 당겨졌는데, 데이터가 일찍 와 같은 그리기 작업이 앞당겨지며 점수에 드는 TBT가 248 → 363 ms로 늘었다(허용 폭 끝 — 진행 기록).
- 매크로(QA, 3회 중앙값): 모바일 TBT 1,928 → 694 ms·성능 53 → 66, 데스크톱 TBT 210 → 51 ms·성능 91 → 99, CLS 같음(0.032·0.035), 내용 같음. 모바일 목표(TBT 600 ms·성능 70)에는 못 미침 — 남은 몫은
  Recharts 내부의 붙은 뒤 다시 계산·모듈 초기화·셸 메뉴의 강제 레이아웃(진행 기록).
- 남은 위험(화면): 미리 받기가 없으면 처음 누르는 화면의 스크립트를 누를 때(가리킬 때) 받는다 — QA(같은 PC)에서는 차이가 작았지만, 느린 회선에서는 첫 이동이 그만큼 늦을 수 있다(운영은 tailnet 안).
- 남은 위험: 행 수는 길어야 60초 지난 값이다(상태 화면의 '행 수'는 참고용 — 판단에 쓰지 않음). 범위 조건의 뜻을 모르고 같음 조건으로 '정리'하면 계획이 다시 흔들린다 — 시험이 막는다.
