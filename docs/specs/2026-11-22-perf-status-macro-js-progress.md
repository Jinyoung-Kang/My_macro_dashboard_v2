# 진행 기록 — 성능 개선 세 가지(상태 질의 · 공용 JS · 매크로 화면) (2026-11-22~)

지시문 [2026-11-22-perf-status-macro-js-exec-instructions.md](2026-11-22-perf-status-macro-js-exec-instructions.md), 계획 기준 커밋 `d721329c`, 작업 브랜치 `claude/perf-2026-11`.
사용자 결정(프롬프트): D-1 단계 0 → 1(A) → 2(C) → 3(B), 받아들임 기준을 채우면 묻지 않고 다음 단계 · D-2 서버 코드가 바뀐 단계마다 main·CI 뒤 권하는 창에서 배포 ·
D-3 행 수는 정확한 값, 상태 화면에서만 세고 수집기 안에서 60초 기억 · D-4 미리 받기는 가리킬 때만(이동 시간 중앙값 150 ms 넘게 늘면 멈춤) · D-5 매크로는 내용·순서·구조 그대로 ·
D-6 새 의존성·스키마 변경·백엔드 새 경로 없음.

측정 원자료(표)는 [docs/qa/evidence/2026-11-22-perf/](../qa/evidence/2026-11-22-perf/) — `baseline.txt`(계획 세션), `step0-baseline.txt`(다시 잰 기준선), `step1-status.txt`.

## 시작할 때

- `make test` 기준선: 계획 기준 커밋과 코드가 같은 `13527d26`에서 같은 날 04:20 KST에 잰 값(지금 `main`과 차이는 문서뿐) — 수집기 3558 통과·36 건너뜀, 백엔드 4016, 화면 5010(파일 504). 전부 통과.
- QA 스택: 이 세션(보안 공지 작업 폴더 `.claude/worktrees/security-ux`)이 로그인 없는 모드로 띄운 것. 같은 폴더에서 `claude/perf-2026-11`을 만들어 다시 빌드했다(다른 세션의 스택이 아님).
- 결함 번호: QA-982를 이 작업이 쓴다(`f1273b97`에서 결함 기록에 먼저 잡음). 다음 번호 QA-983.

## 단계 0 — 측정 도구 (끝, `f775781f`)

- `scripts/bench-api.sh`·`scripts/qa/k6/api-load.js`·`scripts/qa/lighthouse.sh`: `GET /api/auth/session`의 `noLogin`이 참이면 로그인을 건너뛰고 쿠키 없이 부름(로그인 모드는 그대로).
  `bench-api.sh`는 기준선과 같은 31경로·7회·첫/중앙/최대 열로.
- `scripts/qa/k6/core-get.js`(새): 11경로 혼합(닫힌 고리·생각 시간 0, 경로별 p50·p95·p99, 429·그 밖 오류 수). `core-get.sh`(새): 1·5·20·50명 차례로 + docker stats 3초 간격 자원.
- `scripts/qa/lighthouse.sh`: 기준선의 일곱 화면, 13.6.0, FCP·스크립트 전송량·RSC 미리 받기 수·스크립트 수 열, N회(기본 3) 중앙값, 임시 폴더에서 실행하고 지움(WSL의 `C:\Users\…\lighthouse.XXXXXX` 폴더가 저장소에 남지 않음 — 확인함).
- `scripts/qa/qa-stack.sh restore`: 복원 뒤 QA DB에 `ANALYZE`(운영 복원 절차 `db-restore.sh`는 그대로).
- 기준선 다시 재기(`step0-baseline.txt`, 05:00~05:22 KST): 계획 세션 값과 오차 안에서 같음 — `/api/status/issues` 302 ms·`/api/status` 242 ms, 혼합 50명 177건/초·p95 2,449 ms,
  매크로 모바일 성능 47(46~51)·TBT 1,856 ms, 홈 모바일 82·스크립트 759 KB·RSC 미리 받기 26. 계획 세션과 다른 점: 매크로 모바일 TBT 2,129 → 1,856 ms(1회 값과 3회 중앙값의 차이로 봄).

## 단계 1 — 작업 A 상태 질의 (구현·시험·측정 끝, 배포 전)

커밋: `74eabe45` 질의 문장 떼어 내기(옮김) → `018e594f` test(QA-982) → `b5a712bb` fix(QA-982) → `174ca0d4` 가벼운 보기·행 수 기억 → 문서(이 기록·ADR 0047).

- A1(QA-982): 재현 시험이 시험 DB에서 재현됨 — 통계 없음(새 스키마의 새 표)은 `(task, id DESC)` 색인, `ANALYZE` 뒤에는 기본 키 역방향 훑기(수집기·백엔드 둘 다).
  QA DB에서 다시 견줌: 지금 꼴 301.7 ms·버퍼 860,536 → 범위 꼴(V3) 버퍼 248. `max(id)` 부분 질의 꼴은 최솟값·최댓값 최적화가 같은 기본 키 역방향 훑기를 고를 수 있어 버림 → 계획 세션의 V3를 씀.
  백엔드 `readTaskSummary`도 같은 계획이었음(QA 72.5 ms·버퍼 330,894 — 지시문이 '백엔드 나머지 약 70 ms'로 본 것이 이것).
  같은 꼴의 나머지 셋은 QA에서 `EXPLAIN ANALYZE`로 봄 — `readTaskHistory`(드문 태스크 LIMIT 1·50, 기록 없는 태스크) 0.05~0.14 ms, `countTaskRunsStarted`(시세 태스크·드문 태스크) 0.05~0.23 ms,
  모두 `idx_task_runs_task` → 문제가 보이지 않아 고치지 않음(`countTaskRunsStarted`는 모의 매매 실행 감사 입력이라 건드리지 않은 것이 안전 쪽).
- A2: 수집기 `GET /status?view=light`(마지막 실행·상태·누락 데이터셋만), 백엔드 `issues()`·`currentRunId()`가 `CollectorClient.statusLight()`. 새 경로가 아니라 질의 인자로 둔 까닭은 ADR 0047 결정 2.
  백엔드 새 `/api` 경로 없음. 새로고침 확인의 전체 `/api/status` 되풀이는 그대로 둠(그 경로가 10 ms대가 됨).
- A3(D-3): 수집기 `store.row_counts()` — 센 그대로 60초 기억(`isEstimated` 필요 없음).
- A4: 백엔드 쪽 나머지는 A1의 백엔드 질의였음. 고친 뒤 `/api/status/issues` 전체가 17 ms라 따로 남는 10 ms 넘는 항목 없음.
- 시험: 수집기 `test_store.py`(QA-982 둘)·`test_status_view.py`(넷), 백엔드 `StoreRepositoryTaskSummaryDbTest`(둘)·`DataStatusServiceTest.issuesAndBaselineUseLightStatus`.
- 측정(`step1-status.txt`, 같은 QA DB·같은 시각대):

| 측정 | 단계 0 기준선 | 단계 1 뒤 | 받아들임 기준 |
|---|---|---|---|
| `/api/status/issues` 단발 7회 중앙값 | 302 ms | **17 ms** | 30 ms 이하 |
| `/api/status` 단발 7회 중앙값 | 242 ms | **13 ms**(기억이 빈 첫 호출 4회 73~104 ms, 중앙 91 ms) | 100 ms 이하, 두 번째부터 30 ms 이하 |
| 혼합 1명: 처리량 · p50 · p95 | 16.6건/초 · 8.2 · 335.6 ms | 88.8건/초 · 4.9 · 24.9 ms | — |
| 혼합 50명: 처리량 · p50 · p95 | 177.3건/초 · 31.6 · 2,449 ms | **581.1건/초 · 46.5 · 265.5 ms** | 11-04(250건/초·p95 562 ms)보다 나쁘지 않음 |
| `home_issues` p50(1명 · 20명) | 317.8 · 1,007.8 ms | 10.1 · 34.7 ms | — |
| postgres CPU 평균(1·5·20·50명) | 75 · 455 · 920 · 974% | 21 · 108 · 184 · 169% | — |

  응답 대조: 두 API의 JSON이 고치기 전후 시각 칸을 빼고 같음.

- 시험: `make test` 통과(수집기 3564·36 건너뜀, 백엔드 4019 — JDK 25·21 둘 다, 화면 5010). main `f4a29915`, CI 6/6.
- **배포: 2026-11-22(일) 06:08~06:10 KST Vultr `main@f4a29915`**(매매·결정 시각 없음). 운영 확인(읽기만):
  - 수집기 `/status`(서버 루프백, 6회): 첫 호출 127 ms(행 수 기억이 빔) 뒤 6~11 ms — 배포 전 103~148 ms. `/status?view=light` 2.5~3.0 ms.
  - `/api/status/issues`(PC에서 tailnet, 7회): 49~60 ms(첫 140 ms) — 같은 길의 `/api/alerts/unread-count` 34~40 ms가 왕복 바닥이라 서버 몫은 15 ms 안팎. `/api/status` 54~72 ms.
  - 새 요약 질의의 운영 계획(`EXPLAIN`만): `Index Scan using idx_task_runs_task`, `Limit` 비용 0.41..3.96.
  - 컨테이너 여섯 정상, 배포 뒤 백엔드·수집기 ERROR 0.
