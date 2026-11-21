# 실행 세션 지시문 — 성능 개선 세 가지(상태 질의 · 공용 JS · 매크로 화면) (2026-11-22)

## 1. 역할과 목표

너는 이 프로젝트를 넘겨받은 시니어 풀스택 엔지니어야. 이 작업은 두 세션으로 나뉘어 있어. 계획 세션(2026-11-22)이 QA 스택과 운영 서버(읽기만)에서
성능을 다시 재고 이 지시문을 썼고, 이 세션은 그 계획을 실행하는 세션이야. 너는 계획 세션의 대화를 볼 수 없어. 이 지시문, 프롬프트, 저장소의
문서와 코드가 네가 아는 전부야.

배경: 사용자가 백엔드를 Java에서 Rust로 바꾸는 것을 검토했고, 측정 결과 **언어는 병목이 아니었어**(백엔드 API 중앙값 2~30 ms, 운영 서버 CPU 평균 3~5%).
체감 속도를 붙잡는 것은 아래 세 가지였고, 이것만 고치기로 했어. 언어·프레임워크를 바꾸는 일은 이 작업의 범위가 아니야.

- 작업 A — 상태 질의: 홈이 매번 부르는 `/api/status/issues`가 QA 스택에서 303 ms(2026-11-04에는 70.6 ms). 수집기의 태스크별 최근 실행 질의가
  잘못된 색인을 고르는 것이 원인이고, 운영은 지금은 올바른 색인을 쓰지만 추정 비용이 거의 같아 언제든 넘어갈 수 있어.
- 작업 C — 공용 JS: 어느 화면이든 스크립트 38~44개·전송 750~840 KB(원본 2.3 MB)를 받아. 화면에 보이는 링크마다 다른 화면을 미리 받기 때문이야.
- 작업 B — 매크로 화면: 모바일 Lighthouse 성능 46점(2026-11-05에는 64점), 막힘 시간(TBT) 2.1초. 거의 전부 React가 그리는 시간이야.

원자료는 [docs/qa/evidence/2026-11-22-perf/baseline.txt](../qa/evidence/2026-11-22-perf/baseline.txt)에 있어.

## 2. 계획 세션이 확인한 사실 (2026-11-22, `main@13527d26` 기준)

코드 위치는 파일과 심볼로 가리켜. 실행하기 전에 지금 코드에서 다시 확인해. '확인함'과 '추정'을 구분해 적었어.

### 측정 조건
- 이 PC(WSL2)의 QA 스택, 외부 호출 차단. **Vultr 값이 아니야.** 운영 서버에서는 수집기 `/status` 응답 시간과 질의 계획(`EXPLAIN`만 — 실행 없음)만 읽었어.
- QA 스택은 다른 세션이 로그인 없는 모드(`QA_NO_LOGIN=1`)로 띄워 둔 것이었어. 기존 측정 스크립트 셋(`scripts/bench-api.sh`,
  `scripts/qa/lighthouse.sh`, `scripts/qa/k6/api-load.js`)은 로그인을 전제로 해서 **401로 실패했고**, 계획 세션은 쿠키 없는 임시 스크립트로 쟀어.
  임시 스크립트는 저장소에 없어(단계 0이 다시 만들어).
- QA DB는 복원 뒤 통계가 비어 있었어(`pg_stat_user_tables`의 `last_analyze`·`last_autoanalyze`가 빈 값). 계획 세션이 `ANALYZE`를 한 번 실행했고,
  그 뒤에도 아래 작업 A의 느린 계획은 그대로였어.
- Lighthouse는 화면마다 한 번씩만 돌렸어(오차 ±5점쯤으로 봐). QA DB의 모의 매매 주문은 33건뿐이라 모의매매 경로는 운영보다 가볍게 나와.

### 기준선

| 측정 | 2026-11-04·05 | 2026-11-22(지금) |
|---|---|---|
| 11경로 혼합, 동시 1명: 처리량 · p50 · p95 | 27.5건/초 · 6.0 ms · 71.7 ms | 20.0건/초 · 5.9 ms · 311.1 ms |
| 같은 것, 동시 50명 | 250.8건/초 · 100.6 ms · 562 ms | 180.3건/초 · 32.5 ms · 2,304.8 ms |
| `/api/status/issues` p50(1명 · 20명) | 70.6 ms · 131.3 ms | 307.1 ms · 990.7 ms |
| postgres CPU 평균(1 · 5 · 20 · 50명) | 36 · 198 · 316 · 400% | 69 · 382 · 859 · 855% |
| 그 밖의 경로 p50(1명) | macro/overview 17.3 · paper/overview 미국 18.1 · paper/status 미국 26.1 ms | 16.0 · 17.0 · 25.8 ms |

| 화면(Lighthouse 13.6.0, 데스크톱/모바일) | 성능 | TBT(ms) | CLS | 스크립트 전송(KB) |
|---|---|---|---|---|
| `/` | 99 / 82 (11-05: 83 / 55) | 28 / 229 | 0.035 / 0.031 | 800 / 759 |
| `/macro` | 89 / 46 (11-05: 80 / 64) | 246 / 2,129 | 0.035 / 0.032 | 803 / 780 |
| `/institutions` | 99 / 71 | 11 / 254 | 0.035 / 0.161 | 773 / 773 |
| `/paper/us` | 96 / 69 (11-05: 99 / 72) | 15 / 326 | 0.093 / 0.089 | 748 / 748 |
| `/paper/kr` | 95 / 72 | 13 / 225 | 0.109 / 0.143 | 748 / 748 |
| `/info/overview` | 99 / 72 | 0 / 167 | 0.071 / 0.282 | 839 / 748 |
| `/s/us/NVDA` | 97 / 72 | 0 / 200 | 0.096 / 0.197 | 826 / 804 |

단발 API 31경로 가운데 29개는 중앙값 2~30 ms이고, 나머지 둘이 `/api/status`(289 ms)와 `/api/status/issues`(303 ms)야.

### 작업 A — 상태 질의 (확인함)
- 경로: 화면 홈 → `GET /api/status/issues`(`StatusController` → `DataStatusService.issues()`) → 수집기 `GET /status`(`collector/app/main.py:status` →
  `store.store_stats`) + 백엔드 자체 질의(`StoreRepository.readTaskSummary`·`readRecentTaskIssues`) + 수집기 `GET /tasks`.
- 수집기 `store_stats` 230.6 ms의 내역(QA, 5회 중앙값): `read_task_summary` **167.7 ms**, `count_observations` 37.0 ms, `count_timeseries` 23.6 ms,
  나머지(`list_snapshots`·`read_last_run`·`missing_datasets`)는 각 1 ms 이하.
- `read_task_summary`(`collector/app/store.py`)의 계획: 태스크 이름마다 `WHERE r.task = t.task AND NOT (…) ORDER BY r.id DESC LIMIT 1`을 도는데,
  계획기가 `idx_task_runs_task (task, id DESC)` 대신 **기본 키를 거꾸로 훑는 계획**(`Index Scan Backward using collector_task_runs_pkey`)을 골랐어.
  등록 태스크 69개 가운데 실행 기록이 없는 28개는 표 전체(39,202행)를 읽어. 버퍼 859,093.
- 함수 주석은 '지금 0.14ms'라고 적혀 있어 — 그 값은 올바른 색인을 탈 때의 값이야.
- 운영 서버(60,794행, 태스크 68종)는 지금 `idx_task_runs_task`를 써(수집기 `/status` 103~148 ms — 대부분 `COUNT(*)` 둘로 추정). 다만 두 계획의
  추정 비용이 `Limit` 기준 3.26(운영, 올바른 색인)과 3.23(QA, 기본 키)으로 거의 같아. 실행 기록은 90일 보관이라 운영 표는 지금의 서너 배로 커질 거야(추정).
- 계획 세션이 QA에서 견준 고치는 방법(결과 행은 모두 같음):

| 꼴 | 고른 색인 | 중앙값 | 버퍼 |
|---|---|---|---|
| V1 지금 — `r.task = t.task … ORDER BY r.id DESC` | 기본 키 역방향 | 163.5 ms | 859,780 |
| V2 — `ORDER BY r.task, r.id DESC` | 기본 키 역방향 | 160.1 ms | 859,777 |
| V3 — `r.task >= t.task AND r.task <= t.task … ORDER BY r.task, r.id DESC` | `idx_task_runs_task` | **0.9 ms** | 220 |
| V4 — `ORDER BY r.id + 0 DESC` | `idx_task_runs_task` | 15.4 ms | 14,013 |

  V3은 조건을 범위로 써서 기본 키가 정렬을 대신하지 못하게 한 것이야. V4는 태스크의 모든 행을 읽어 정렬하므로 표가 커지면 같이 느려져.
- 같은 꼴(태스크로 거르고 `ORDER BY id DESC LIMIT n`)이 더 있어: 백엔드 `StoreRepository.readTaskSummary`(이름을 기록에서 찾으므로 '기록 없는
  태스크'는 없지만 드물게 도는 태스크는 멀리 훑음)·`readTaskHistory`·`countTaskRunsStarted`(모의 매매 실행 감사 `PaperExecutionAuditJob`이 씀),
  수집기 `read_task_history`. 이들의 계획은 계획 세션이 재지 않았어.
- 수집기 `/status` 응답 가운데 `issues()`가 쓰는 것은 `lastRunStatus`·`missingDatasets`뿐이고, `currentRunId()`(`refresh()`가 기준 실행 번호를
  잡을 때 부름)는 `lastRun.id`만 써. 그런데 수집기는 부를 때마다 행 수 세기 둘과 태스크 요약까지 다 만들어.
  행 수(`timeseriesRows`·`observationRows`)를 보여 주는 곳은 상태 화면(`frontend/src/app/(dashboard)/status/page.tsx`) 하나야.
- 화면의 새로고침 확인(`frontend/src/hooks/useRefreshSignal.tsx`)은 새로고침을 누른 뒤 **전체 `GET /api/status`**를 2~10초 간격으로 최대 90초 동안
  부르면서 `lastRun`만 읽어.
- 백엔드 쪽 나머지: QA에서 `/api/status/issues` 303 ms − 수집기 230 ms = 약 70 ms. 내역은 재지 않았어(위 백엔드 질의 둘로 추정).
- 이미 알려진 항목: `docs/qa/IMPROVEMENTS.md` 6번(행 수 세기가 상태 API마다 나감).

### 작업 C — 공용 JS (확인함)
- 화면마다 스크립트 38~44개, 전송 748~839 KB(원본 약 2.3 MB), 전부 우선순위 Low. `fetch` 36~41건 가운데 **24~31건이 RSC 미리 받기**(`?_rsc=`)이고
  API는 10~12건이야. 미리 받는 대상은 그 화면에 보이는 링크의 경로야(홈에서 `/macro`·`/institutions`·`/paper/us`·`/regime`·`/search`·`/status`·
  `/markets/i/*` 등).
- 정적 JS 전체: 76개 파일, 원본 3,273 KB, gzip 997 KB(2026-10-18에는 36개, 1,324 KB, 399 KB). 곧 한 화면이 앱 전체 JS의 약 70%를 받아.
- 큰 묶음(원본): 432 KB(recharts·d3·redux가 든 묶음), 387 KB(**내용 미확인**), 229 KB(react-dom), 188·156·109·96 KB. 묶음 이름은 빌드마다 바뀌어.
- 홈은 차트 모듈을 직접 가져오지 않는데도 recharts 묶음을 받아. `components/screens/paper/bookColors.ts`는 이미 차트 배럴 대신
  `charts/frame`에서 색을 가져오게 고쳐져 있어(그 파일 주석) — 그러니 홈의 recharts는 가져오기 경로가 아니라 **미리 받기로 온 것으로 추정**해.
- `next/dynamic`·`React.lazy` 사용 0건. `"use client"` 파일 231개(시험 제외 390개 중). recharts를 직접 가져오는 파일은
  `components/charts/index.tsx`·`LineChart.tsx` 둘이고, `@/components/charts`를 가져오는 파일은 22개야.
- Lighthouse의 '쓰지 않는 JS' 추정: 홈 282 KiB, 매크로 257 KiB.
- Next.js 16.4.5 문서에서 확인한 것(Context7 `/vercel/next.js/v16.4.5`): 묶음 분석은 내장 명령 `npx next analyze`(Turbopack, `--output --snapshot <이름>`으로
  저장) — **새 의존성이 필요 없어.** `<Link>`의 `prefetch`는 기본값이 화면에 보이면 미리 받기(운영 빌드에서만), `false`는 끔, 문서가 권하는
  '가리킬 때만' 꼴은 `prefetch={active ? null : false}` + `onMouseEnter`야.
- `next/link`를 쓰는 파일은 47개. 셸 쪽은 `components/shell/`의 `SideNav`·`TabBar`·`SubNav`·`MoreMenu`·`TopBar`·`Breadcrumbs`·`SearchCommand`·
  `AccountBox`·`SourceAlertBanner`, 홈은 `components/screens/home/`의 `MarketPanel`·`RegimePanel`·`PaperPnlPanel`·`AlertsSummary`야.

### 작업 B — 매크로 화면
- 확인함: 모바일(모의 감속) 메인 스레드 6.0초 = 스크립트 실행 3,749 ms + 스타일·레이아웃 1,452 ms + 그 밖. 스크립트별로는 react-dom 묶음이
  4,940 ms로 거의 전부야(다른 묶음은 각 160 ms 이하) — 곧 **React가 그리는 일**이야. 긴 작업 1,335·385·335·258·209 ms. DOM 2,295~2,464개.
  데스크톱은 TBT 246 ms, react-dom 묶음 1,013 ms. 견줄 값: 홈 모바일 메인 스레드 1.7초, 모의매매(미국) 2.3초.
- 확인함: `frontend/src/app/(dashboard)/macro/page.tsx`는 클라이언트 컴포넌트 하나가 `useApi` 3개·`useLivePrices`·`useMinuteClock`·
  `useAutoRefreshSeconds`를 쥐고 구역 여덟 개(`IndicatorsSection`·`SpreadSection`·`RiskSection`·`AdvancedSection`·`SingleChartSection`·
  `ScrapedSection`·`EconCalendarSection`·`FxCompareSection`)를 한 번에 그려. 구역 파일에 `memo`는 없어. 구역 안의 `useApi`는 5개 더 있고,
  차트(`LineSeries`·`MultiLineSeries`)는 네 구역(`SingleChart`·`FxCompare`·`Advanced`·`Spread`)이 써. 화면이 부르는 API는 12건 + SSE 하나야.
- 확인함: QA 스택에서 매크로의 LCP 요소는 상단의 '실시간 시세: … ProxyError' 안내 문장이야(외부가 막혀 약 2초 뒤에 뜸). **QA의 LCP는 이 안내에
  끌려가므로 매크로는 TBT와 메인 스레드 시간으로 판단해.**
- 추정(프로파일로 확인할 것 — 계획 세션은 어느 컴포넌트가 몇 번 그려지는지 재지 않았어):
  - H1 응답이 하나 올 때마다 화면 전체가 다시 그려짐(상태가 `page.tsx` 꼭대기에 있음).
  - H2 실시간 시세·분 시계·자동 새로고침이 값이 바뀔 때마다 화면 전체를 다시 그림.
  - H3 차트 네 구역과 큰 표의 첫 그리기 자체가 비쌈(스타일·레이아웃 1.5초는 차트 폭 재기가 되풀이되는 것일 수 있음 — `components/charts/sizeHold.tsx`·`frame.tsx`).
  - H4 화면 밖 구역까지 처음에 모두 그림.
- 2026-11-05의 64점에서 46점으로 내려간 사이에 작업대 화면 개편(ADR 0042, P0~P8)이 있었어. 어느 변경에서 내려갔는지는 확인하지 않았어.

### 범위 밖에서 본 것(기록만 — 고치지 마)
- 모바일 CLS가 0.1을 넘는 화면: `/info/overview` 0.282, `/s/us/NVDA` 0.197, `/institutions` 0.161, `/paper/kr` 0.143.
- 서버 디스크의 Docker 빌드 캐시 41 GB(37 GB 회수 가능 — `scripts/vultr/deploy.sh`가 7일 지난 것만 지움).

## 3. 실행 순서와 멈춤점

| 단계 | 내용 | 시작 조건 | 끝 |
|---|---|---|---|
| 0 | 측정 도구 고치기 + 기준선 다시 재기 | 바로 | 구현·시험·main·CI (배포 없음 — 서버 코드가 아님) |
| 1 | 작업 A 상태 질의 | 단계 0 뒤 | 구현·시험·측정·main·CI·배포·운영 확인 |
| 2 | 작업 C 공용 JS | 단계 1 뒤 | 분석 기록 → 구현·시험·측정·main·CI·배포 |
| 3 | 작업 B 매크로 화면 | 단계 2 뒤(미리 받기가 줄어든 상태에서 재야 값이 섞이지 않아) | 원인 기록 → 구현·시험·측정·main·CI·배포 |

- 단계를 끝낼 때마다 보고하고, 다음 단계로 바로 넘어갈지는 프롬프트의 D-1을 따라.
- 받아들임 기준에 못 미치면 억지로 맞추지 말고, 잰 값과 남은 원인을 적어 보고한 뒤 멈춰.
- 기다릴 일이 생겨도 세션 예약(ScheduleWakeup 등)을 걸지 마 — PC를 오래 켜 둬야 해서 사용자가 싫어해.

## 4. 작업별 명세

### 단계 0 — 측정 도구
- 기존 스크립트 셋이 **로그인 없는 QA 스택에서도 돌게** 해: `GET /api/auth/session`의 `noLogin`이 참이면 로그인을 건너뛰고 쿠키 없이 부르게.
  로그인 모드의 동작은 그대로 둬.
- `scripts/qa/k6/core-get.js`를 새로 만들어(2026-11-04 측정이 쓴 11경로 혼합이 저장소에 없어). 경로와 조건은 기준선 파일 2절 그대로 —
  닫힌 고리·생각 시간 0·경로별 p50·p95·p99·429 수. k6는 이 PC에 깔려 있지 않고 docker 이미지 `grafana/k6:2.3.0`이 있어(`--network host`).
- `scripts/qa/lighthouse.sh`: 화면 목록을 기준선의 일곱 화면으로, Lighthouse 판을 13.6.0으로(지금은 `@12`), 열에 FCP·스크립트 전송량·RSC 미리 받기
  수를 더하고, `N`번 돌려 중앙값을 내는 인자를 둬(기본 3).
- **함정**: WSL에서 Lighthouse(chrome-launcher)가 실행한 폴더에 `C:\Users\…\AppData\Local\lighthouse.XXXXXX`라는 이름의 폴더를 남겨(계획 세션은
  저장소 최상위에 14개가 생겨 손으로 지웠어). 스크립트가 임시 폴더로 옮겨 가서 돌고 끝에 지우게 해.
- QA DB 복원 뒤 통계가 비는 것: `scripts/qa/qa-stack.sh restore`(또는 그것이 부르는 복원 스크립트) 끝에 `ANALYZE`를 넣을지 살펴봐. 운영 복원 절차는
  건드리지 말고, 바꾼다면 QA 쪽만.
- 끝나면 지금 `main`으로 QA 스택을 맞춘 뒤 기준선을 **다시 재서** 진행 기록에 적어(계획 세션의 값과 다르면 이유도).

### 작업 A — 상태 질의 (단계 1)
- **A1 계획이 흔들리지 않는 질의로(결함 — `QA-###` 두 커밋).** 수집기 `read_task_summary`와 백엔드 `readTaskSummary`를 고쳐. 계획 세션의 V3 꼴이
  QA에서 0.9 ms였지만, 네가 지금 코드와 PostgreSQL 16에서 다시 확인하고 더 나은 꼴이 있으면 그것을 써(이유를 진행 기록에).
  - 재현 시험: `macrodash_test`에 수만 행과 '기록 없는 태스크'를 넣고, 요약 질의의 `EXPLAIN (FORMAT JSON)`이 기본 키 역방향 훑기를 쓰지 않는지(또는
    읽은 버퍼 수가 상한 안인지)를 단정해. 통계가 있을 때와 없을 때 둘 다 봐. 고치기 전에는 strict xfail/`@Disabled`여야 해 — 시험 DB에서 느린 계획이
    재현되지 않으면 재현 조건을 찾은 과정과 함께 보고해.
  - 결과가 고치기 전과 같은지(같은 행·같은 순서, `STILL_RUNNING_PREFIX` 행 건너뛰기 — QA-139) 시험으로 고정해.
  - 같은 꼴의 다른 질의(§2에 적은 넷)는 QA에서 `EXPLAIN ANALYZE`로 재 보고, **같은 문제가 실제로 보이는 것만** 같은 방법으로 고쳐.
    `countTaskRunsStarted`는 모의 매매 실행 감사의 입력이라 결과가 한 건도 달라지면 안 돼 — 고친다면 결과 동일 시험을 먼저 써.
- **A2 가벼운 경로.** `issues()`와 `currentRunId()`가 행 수 세기와 태스크 요약을 일으키지 않게 해. 수집기 `/status`에 가벼운 변형(질의 인자나 새
  경로 — 네가 정하고 이유를 기록)을 두고 백엔드 두 곳이 그것을 부르게. `GET /api/status`·`GET /api/status/issues`의 **응답 모양과 값은 그대로**여야 해.
  수집기 경로가 바뀌면 `docs/API.md`의 수집기 절(`GET /status` 줄)을 같이 고쳐. 백엔드에 새 `/api` 경로는 만들지 마(필요해 보이면 멈추고 물어봐).
  새로고침 확인이 전체 `/api/status`를 되풀이해 부르는 것은, A1과 D-3으로 그 경로가 충분히 가벼워지면 그대로 둬. 그래도 무거우면 기존 경로에
  가벼운 보기 인자를 더하는 방법을 살펴보고(`AccessPolicy`·`RouteInventoryTest`·`docs/API.md`에 닿는지 확인), 새 경로가 필요하면 멈추고 물어봐.
- **A3 행 수 세기.** 프롬프트 D-3을 따라. 추정값을 화면에 내보내게 되면 `isEstimated`를 함께(PRINCIPLES).
- **A4 백엔드 쪽 나머지 약 70 ms**의 내역을 재서 기록하고, 10 ms 넘게 남는 것이 있으면 같은 단계에서 고쳐.
- 받아들임 기준(QA 스택, 단발 7회 중앙값): `/api/status/issues` 303 ms → **30 ms 이하**, `/api/status` 289 ms → **100 ms 이하**(D-3에서 캐시를 고르면
  두 번째 호출부터 30 ms 이하). 11경로 혼합 동시 50명이 2026-11-04 수준(250건/초, p95 562 ms)보다 나쁘지 않을 것. 고치기 전후 두 API의 JSON이
  시각 칸을 빼고 같을 것.
- 배포 뒤 운영 확인(읽기만): 수집기 `/status` 응답 시간(지금 103~148 ms)과 가벼운 경로의 응답 시간, 백엔드 ERROR 0.

### 작업 C — 공용 JS (단계 2)
- **C1 분석 먼저.** `npx next analyze --output --snapshot before`로 묶음별 내용과 '어느 경로가 어느 묶음을 받는지'를 뽑아 진행 기록에 표로 적어.
  387 KB 묶음의 정체도. 분석 산출물(`.next/diagnostics/…`)은 커밋하지 마. 그리고 첫 로딩에 꼭 필요한 스크립트와 미리 받기로 온 스크립트를 갈라서
  세(Lighthouse `network-requests`의 시작 시각·initiator, 또는 미리 받기를 끈 실험 빌드와의 차이).
- **C2 미리 받기 정책.** 프롬프트 D-4를 따라. 기본 권장은 '가리킬 때만': 공용 링크 컴포넌트 하나를 만들어(화면 계층 ADR 0004 — 놓을 자리는 규칙에
  맞게) 셸 메뉴와 목록성 링크가 그것을 쓰게 하고, 의도 신호는 마우스 올림·키보드 초점·터치 시작 셋 다 받아. 한 번 의도를 보인 링크는 Next 기본
  동작으로 돌아가(`prefetch={active ? null : false}`). 화면마다 미리 받기 수가 얼마로 줄었는지와 **이동 시간**(링크를 누른 때부터 새 화면의 첫 내용이
  그려질 때까지 — 고치기 전후, QA 스택, 감속 없음과 CPU 4배 감속 둘 다, 다섯 번 중앙값)을 재. 이동 시간이 중앙값 기준 150 ms 넘게 늘면 보고하고 멈춰.
- **C3 차트 묶음을 필요할 때만.** C1·C2 뒤에도 차트가 없는 화면의 첫 로딩에 recharts 묶음이 남으면 가져오기 경로를 끊어. 차트가 있는 화면에서
  `next/dynamic`으로 늦게 싣는 것은 **자리 높이를 고정해 CLS가 늘지 않을 때만** 하고, 첫 화면에 차트가 바로 보이는 화면은 이득이 있는지 재 보고 정해.
- **C4 그 밖.** 분석에서 한 화면만 쓰는 큰 모듈이 공용 묶음에 들어 있으면 떼어 내. 옮기는 커밋과 고치는 커밋을 나눠.
- 받아들임 기준: 차트 없는 화면(`/`·`/info/overview`)의 첫 로딩에 recharts 묶음이 없을 것, 화면마다 첫 로딩의 RSC 미리 받기가 5건 이하,
  홈의 첫 로딩 스크립트 전송량이 지금(759 KB)보다 40% 이상 줄 것(C1 결과로 이 목표가 맞지 않으면 근거와 함께 새 목표를 진행 기록에 적고 진행),
  일곱 화면 모두 CLS가 지금보다 늘지 않고 모바일 성능 점수가 떨어지지 않을 것(3회 중앙값, 오차 3점 안은 같음으로 봄).
- 시험으로 고정할 수 있는 것은 시험으로: 공용 링크의 미리 받기 속성, 차트 없는 화면의 모듈이 recharts에 닿지 않는 것(가져오기 그래프 검사 — 지금
  있는 화면 계층 시험의 방식을 따라).

### 작업 B — 매크로 화면 (단계 3)
- **B1 원인 좁히기 먼저(코드 고치기 전).** QA 스택에서 Chrome 성능 기록(CPU 4배 감속)과 React Profiler(운영 빌드 프로파일 — `next build --profile`이
  지금 판에서 되는지 문서로 확인)로 `/macro`를 처음 열 때 **어느 컴포넌트가 몇 번, 얼마 동안 그려지는지**를 표로 만들어 진행 기록에 적어.
  §2의 가설 H1~H4를 하나씩 맞다·아니다로 판정해. 2026-11-05 뒤 어느 변경에서 나빠졌는지는 원인이 분명하면 찾지 않아도 돼.
- **B2 보이는 내용과 구조를 그대로 두는 고침부터.** 예: 상태를 쓰는 구역 가까이로 내리기, 구역 단위 `memo`, 실시간 값·시계 구독을 카드 단위로,
  화면 밖 구역에 `content-visibility: auto` + `contain-intrinsic-size`(찾기·구역 색인 이동이 그대로 되는지 확인), 차트 폭 재기 되풀이 줄이기.
  고칠 때마다 그 고침 하나의 효과를 재서 기록해(효과 없는 고침은 되돌려).
- **B3 내용이 늦게 나타나거나 화면 구조가 바뀌는 방법**(탭으로 나누기, 스크롤해야 그리기, 구역 접기)은 하지 말고 필요해 보이면 멈추고 물어봐(프롬프트 D-5).
- 받아들임 기준(QA 스택, Lighthouse 13.6.0, 3회 중앙값): 모바일 TBT 2,129 ms → **600 ms 이하**, 모바일 성능 점수 **70 이상**, 데스크톱 TBT
  246 ms → **150 ms 이하**, CLS 0.05 이하. 화면의 내용·순서·숫자가 고치기 전과 같을 것(화면 시험, 전후 캡처 비교). 다른 여섯 화면이 나빠지지 않을 것.
  기준은 목표야 — 못 미치면 잰 값과 남은 원인을 보고해.
- 다른 화면(모의매매·기관 등)에도 같은 원인이 보이면 **기록만** 하고 이번에는 매크로만 고쳐.

## 5. 지켜야 할 규칙

원문은 `CLAUDE.md`·`docs/DEVELOPMENT.md`·`docs/PRINCIPLES.md`·`docs/adr/README.md` — 먼저 읽어. 이 지시문과 충돌하면 프로젝트 규칙이 우선이고,
무엇을 따랐는지 진행 기록에 적어.

- 작업 브랜치 `claude/perf-2026-11`(단계별로 나눠도 됨). 커밋 `type(scope): 요약`(요약은 한국어, type은 이 저장소가 쓰는 fix·test·feat·refactor·docs·chore) +
  `Co-Authored-By` 줄. 옮기는 커밋과 고치는 커밋을 나눠. 모든 커밋이 `make test`를 통과해야 해.
- 결함 번호: A1은 `QA-###` — 재현 시험 `test(QA-###)`(고치기 전 strict xfail/`@Disabled`) → `fix(QA-###)`. 다음 번호는 `docs/qa/2026-11-12-defects.md` 끝과
  `git log`에서 확인해(2026-11-22 기준 QA-982). 다른 세션이 같은 번호를 쓰지 않게 시작할 때 쓸 번호를 그 파일에 먼저 적어.
- **성능 시험은 QA 스택에서만**(13002/18082/18002/15434). 로컬 스택(3002…)과 운영 서버에 부하·브라우저 시험을 하지 마.
  - QA 스택은 하나뿐이고 포트가 고정이야. 떠 있으면 누가 띄웠는지 먼저 봐(컨테이너 라벨 `com.docker.compose.project.working_dir`) — 다른 세션의
    작업 폴더면 다시 빌드하거나 내리기 전에 사용자에게 물어봐.
  - 캡처·Lighthouse JSON·분석 산출물은 커밋하지 마. 표로 정리한 값만 `docs/qa/evidence/2026-11-22-perf/`에.
- 운영 서버는 **읽기만**(배포 제외). 운영 DB에서는 `EXPLAIN`(실행 없음)과 통계 표 읽기까지만 — `EXPLAIN ANALYZE`·부하·설정 변경을 하지 마.
- 모의 매매·실제 매매 코드와 프롬프트·스키마·패킷 고정본은 건드리지 않아. 고정본이 바뀌어야 한다면 멈추고 물어봐.
- 테이블마다 쓰는 프로세스는 하나(ADR 0008) — `collector_task_runs`는 수집기 표라 백엔드는 읽기만. 스키마를 바꾸거나 색인을 더해야 한다면(지금 계획은
  필요 없음) `db/migrations/`와 표 소유권 시험을 같이, 그리고 먼저 멈추고 물어봐.
- 화면은 작업대 화면 언어(ADR 0042)와 화면 계층(ADR 0004)을 지켜. 고친 화면은 `node scripts/qa/ui-audit.js`(12px·누름 자리·넘침·대비)를 전후로 돌려.
- 새 의존성을 넣지 마(묶음 분석은 내장 `next analyze`). 꼭 필요하면 이유를 설명하고 멈춰.
- 이모지 금지(코드·주석·문서·스크립트 출력·커밋 메시지). 날짜는 KST, 없는 숫자는 `null`.
- 라이브러리 동작은 기억으로 쓰지 말고 문서(Context7이 연결돼 있으면 그것)에서 지금 판 기준으로 확인해.

## 6. 검증 수단

| 묶음 | 명령 |
|---|---|
| 수집기 | `make test-collector`(ruff + pytest) |
| 백엔드 | `make test-backend`(이 PC는 JDK 25 — CI와 같은 JDK 21로 재는 방법은 `CLAUDE.md` '이 환경의 함정') |
| 화면 | `make test-frontend`(vitest·lint·build) |
| 전체 | `make test`(CI와 같은 명령) |
| CI | push 뒤 6개 job |

- 계획 세션은 `make test` 기준선을 재지 않았어. 시작할 때 `main`에서 한 번 재서 진행 기록에 적어.
- 시험은 `macrodash_test`만 써(`make test-*`가 맞춰 줌). postgres가 없으면 `make infra`.
- 성능은 단계 0의 스크립트로, 고치기 전후를 **같은 QA 스택·같은 DB·같은 시각대**에 재. Lighthouse는 3회 중앙값.

## 7. 전달과 배포

- 단계마다: 작업 브랜치 → `make test` 통과 → 본체 폴더 `main`에 fast-forward → `git push origin main <브랜치>` → CI 6/6 확인 → (서버 코드가 바뀐 단계면) 배포.
  CI가 GitHub 쪽 사정으로 취소되면 그 job만 다시 돌리고 코드 실패와 구분해 보고해.
- 배포 여부는 프롬프트 D-2를 따라. 서버에서 `bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh`. 배포하면 앱 컨테이너가 1~2분 다시 만들어지니
  매매·결정 시각을 피해: 한국 거래 창(평일 08:45~15:35 KST — `deploy.sh`가 막음), 미국 정규장과 두 시장의 정기 결정·고정 장중 판단·마감 브리핑
  전후(시각은 서버 설정으로 확인), 일요일 주간 복기(21:00·22:00), 백업(08:00·일 23:00). 권하는 창은 평일 16:30~22:00, 토요일, 일요일 20:30 전이야.
- 배포 뒤 확인: 컨테이너 6개 정상, `make status`, 백엔드 ERROR 0, 그 단계의 운영 확인 항목. 확인한 것과 못 한 것을 구분해 보고.
- 서버 접속은 Tailscale SSH야. 추가 확인(브라우저 재인증)에서 멈추면 `timeout`으로 끊고 사용자에게 재인증을 부탁해 — 비상 키 경로로 돌아가지 마.

## 8. 기록과 보고

- 진행 기록: `docs/specs/2026-11-22-perf-status-macro-js-progress.md`(새 파일) — 단계마다 한 일·커밋·시험 결과·전후 측정값·배포 시각·남은 일.
  요약으로, 코드는 옮겨 적지 말고 파일:심볼로.
- 측정 표: `docs/qa/evidence/2026-11-22-perf/`에 단계별 파일(기준선은 `baseline.txt`).
- 설계 결정(미리 받기 정책, 수집기 가벼운 경로, 행 수 세기 방식)은 ADR로 — 화면 쪽은 ADR 0042에 덧붙일지 새 ADR(다음 번호 확인 — 2026-11-22 기준
  0047)로 할지 네가 정하고, 지키는 방법(시험 이름)을 적어.
- 같이 고칠 문서: `docs/API.md`(수집기 경로가 바뀌면), `docs/DEVELOPMENT.md`와 `CLAUDE.md`의 측정 명령 문구(스크립트 사용법이 바뀌면),
  `docs/qa/IMPROVEMENTS.md` 6번(행 수 세기 항목의 상태), 결함 기록(`docs/qa/2026-11-12-defects.md`).
- 프로젝트 메모리(`~/.claude/projects/-home-jykang-Projects-My-macro-dashboard-v2/memory/perf-improvement-2026-11.md`)에 진행 상태를 이어 적어.
- 단계를 끝낼 때마다 사용자에게 한국어로 보고: 한 일, 커밋 번호, 시험·CI 결과, 전후 측정값, 배포 여부와 시각, 다음 단계. 확인한 사실과 추정을 구분해.

## 9. 멈추고 물어볼 때

- 받아들임 기준에 못 미칠 때, 또는 기준을 바꿔야 한다고 볼 때
- 화면의 내용이 늦게 나타나거나 구조가 바뀌는 방법이 필요해 보일 때(B3), 이동 시간이 150 ms 넘게 늘 때(C2)
- 스키마·색인 변경, 백엔드의 새 `/api` 경로, 새 의존성이 필요할 때
- 결정 패킷·프롬프트·스키마 고정본이나 모의 매매 실행 감사의 결과가 달라질 수 있을 때
- QA 스택을 다른 세션이 쓰고 있을 때
- 이 지시문과 지금 코드가 크게 달라 계획대로 할 수 없을 때
