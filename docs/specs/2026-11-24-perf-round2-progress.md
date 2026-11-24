# 진행 기록 — 성능 개선 2차(보안 공지 판정 · 기관 목록 · 외부 대기 상한 · 경고 띠 · 레이아웃 밀림) (2026-11-24~)

지시문 [2026-11-24-perf-round2-exec-instructions.md](2026-11-24-perf-round2-exec-instructions.md), 계획 기준 커밋 `6479ea4e`, 작업 브랜치 `claude/perf-round2-2026-11`.
사용자 결정(프롬프트): D-1 단계 0 → 1(A·B) → 2(C) → 3(D·E), 받아들임 기준을 채우면 묻지 않고 다음 단계 · D-2 서버 코드가 바뀐 단계마다 main·CI 뒤 권하는 창에서 배포 ·
D-3 화면 조회의 외부 대기 예산 요청 하나에 10초(상세 시세·뉴스·KRX 장중), 검색 세 경로는 ADR 0041의 설계 값이면 그대로 · D-4 띠는 상단바 안의 경고 표시(아이콘·건수)로 ·
D-5 응답 전 자리의 높이만 맞춤 · D-6 새 의존성·스키마 변경·백엔드 새 경로 없음.

측정 원자료(표)는 [docs/qa/evidence/2026-11-24-perf/](../qa/evidence/2026-11-24-perf/) — `baseline.txt`(계획 세션), `step0-seed.txt`(씨앗을 넣은 QA).

## 시작할 때

- `make test` 기준선: 계획 기준 커밋 `6479ea4e`(main)에서 17:20~17:47 KST — 수집기 3610 통과·36 건너뜀, 백엔드 4066, 화면 5081(파일 514)·화면 감사 9, `make` 종료 코드 0(27분).
  화면 시험 단계만은 그 사이 이 세션이 고친 `scripts/qa/` 파일(이모지 검사 대상)을 함께 읽었음 — 코드 변경은 들어가지 않음(백엔드는 컴파일이 끝난 뒤에 고침).
- QA 스택: 계획 세션이 이 폴더(`/home/jykang/Projects/My_macro_dashboard_v2` — 컨테이너 라벨 `com.docker.compose.project.working_dir`)에서 배포본으로 띄운 것.
  다른 세션의 작업 폴더가 아니라 그대로 씀.
- 로컬 스택의 postgres가 `Exited (127)`이라 `make test`를 위해 `docker compose up -d --force-recreate --no-deps postgres`로 다시 만듦(볼륨 그대로 — 메모리의 절차).
- 결함 번호: QA-991~995를 이 작업이 씀(결함 기록에 먼저 잡음). 다음 번호 QA-996.

## 단계 0 — 측정 도구와 재현 자료

- 옮김(`88f3a405`): 계획 세션의 임시 도구 셋을 `scripts/qa/`로 그대로.
- 다듬기: `page-apis.js`·`sql-replay.sh`·`hang-test.sh` 머리 설명(사용·안전)을 `nav-timing.js`·`core-get.sh` 관례로, 저장소 경로·`.env.qa`의 포트를 스스로 찾음,
  GET 목록으로 `page-apis.js`의 결과 JSON도 받음, `sql-replay.sh`는 끝에 경로별 문장 수·DB 시간 표를 냄. `lighthouse.sh`에 `BLOCK`(Lighthouse `--blocked-url-patterns`).
- **모바일 CLS 0 문제**(`page-apis.js`): 모바일 에뮬레이션(`mobile: true`)에서 크롬이 첫 약 32 ms에 입력이 있었다고 표시해(`lastInputTime`) 모든 이동이
  `hadRecentInput=true`로 빠졌음 — 같은 화면을 `mobile: false` 390폭으로 열면 같은 이동 값이 그대로 나옴. 도구는 입력을 보내지 않으므로 그 표시를 무시하고 더함
  (표시된 수는 `inputFlagged`). 고친 뒤 모바일 값이 Lighthouse 모바일과 같은 방향(기관 띠 있음 0.153/LH 0.161, 막음 0.012/0.019 — `step0-seed.txt`).
- **QA 재현 자료** `scripts/qa/perf-seed.py`(표준 라이브러리만, 고정 씨앗): 보안 공지 135건·표 행 약 2,200·구성 1,706·변경 기록 CVE 11,151·추적기 9줄(모두 지어낸 글·
  CVE-2098/2099·큰 판), 13F 즐겨찾기 12곳(가짜 CIK — 기관마다 q8·q30, QA DB의 기존 13F 저장본 가운데 큰 것을 복사, 24개 14 MB). 공지·추적기·저장본은 SQL로
  (`security-seed.sql`과 같은 관례 — QA는 외부가 막혀 씨앗이 수집기 자리를 채움), 버전 목록은 수집기 받기 길 `app.inventory`로(ADR 0046 결정 2·ADR 0008).
  처음에는 즐겨찾기를 QA에 이미 있는 기관에서 골랐는데 기관마다 저장본이 하나뿐이라 기관 목록이 36 ms로 재현이 안 됐음 → 운영처럼 두 저장본씩 두게 바꿈.
- 재현(씨앗 뒤 QA, 단발 6회): `/api/security/notices` 0.55~0.57초(운영 1.65~1.75), `/api/sec13f/institutions` 88~121 ms(운영 110~119). 보안 공지가 운영보다
  짧은 이유(추정): 같은 서비스의 가벼운 경로 `/api/security/inventory`가 QA 5 ms·운영 약 7~11 ms(왕복 빼고)로 운영 기계가 1.5~2배 느리고, 운영 공지는 실제 제품·버전
  글이라 맞는 줄이 씨앗보다 많을 수 있음. 매번 다시 판정하는 꼴은 같아 재현으로 봄.

- 커밋: `88f3a405`(옮김) → `ab5b8206`(다듬기·씨앗·기록). 배포 없음(QA 도구만).

## 단계 1 — 작업 A(QA-991)·B(QA-992)

커밋: `9c76b4b9` test(QA-991) → `d0f972d8` test(QA-992) → `3aa81ee0` fix(QA-992) → `e8deb415` fix(QA-991, ADR 0049) → 기록.

- A1 나눠 재기(고치기 전, QA DB): DB 읽기 약 20~50 ms(임시 프로그램은 연결을 새로 맺음 — 실제 앱은 sql-replay로 12~16 ms)·조립 2~5 ms·**판정 550~620 ms**.
  판정 안은 JFR 표본의 약 80%가 정규식(별칭 이름 찾기 — `ProductAliases$Alias.mentionedIn` 등). 판이 바뀐 직후 첫 계산이 QA에서 1초 아래(0.58초)라 판정 규칙·정규식은 그대로.
- A2 결정(ADR 0049): 입력 판 `SecurityStore.inputVersion` — (공지 수, 공지 `updated_at` 최댓값, 표 행 수, 버전 목록 `received_at`, 추적기 수, `checked_at` 최댓값)
  집계 한 줄. 수집기의 쓰기 방식을 먼저 확인함(`collector/app/store.py`: 공지 upsert·상세·실패 표시는 늘 `updated_at = now()`, 상세의 표 행은 같은 트랜잭션에서 통째로 바꿈,
  버전 목록 네 표는 한 트랜잭션으로 통째로 바꾸며 `received_at = now()`, 추적기 결과는 행마다 `checked_at`). 판을 놓칠 때를 대비한 시간 상한 10분.
  기억은 `SecurityService` 안(판정 한 벌 — 머리·입력·판정 목록, 잠금 안에서 다시 확인) — `ComputedCache`는 저장본 수집 시각으로만 값을 버려 보안 표의 변경을 모르고
  서비스가 부를 수 없음(ADR 0001). 목록·상세·알림 작업(`SecurityAlertJob` — 매번 판 확인)이 같은 한 벌을 씀. 상세는 버전 목록을 다시 읽지 않게 됨(QA 20 ms → 판 확인 한 번).
- B 결정: `StoreRepository.readSnapshotHeads`가 `name`·`collected_at`만 먼저 읽고 수집 시각이 기억과 다른 이름만 기준일을 다시 읽어 기억. 수집기는 본문을 새로 쓸 때마다 수집 시각도 새로
  적음(`put_snapshot` — 본문만 고치는 `update_snapshot_payload`는 뉴스·상태 저장본만 씀, 13F는 쓰지 않음). 같은 꼴의 다른 두 질의는 본문 자체를 쓰는 읽기라 고치지 않음
  (`readSnapshotFirstQuarters` — 즐겨찾기 기관 상세, `readQuarterHoldings` — 모의 매매 규칙 계좌·패킷).
- 시험: `SecurityJudgementMemoTest` 4(기억한 응답 = 새로 계산한 응답 — 목록 일곱 조합·상세 셋·버전 목록, 판 바뀜·판 모름·시간 상한, 알림 작업의 한 벌),
  `SecurityNoticesMemoQa991DbTest` 3(실제 표 — 둘째 목록은 공지·표 행을 읽지 않음, 입력 판이 네 가지 쓰기마다 달라짐, 고친 공지가 다음 목록에 보임),
  `StoreRepositoryHeadsQa992DbTest` 3(둘째 읽기에 본문 푸는 질의 없음, 새로 수집된 저장본·더한 이름·지워진 저장본). 시험 도우미 `SqlRecorder`(보낸 SQL을 적음).
- QA 측정(같은 QA·같은 DB, 고치기 전은 `6479ea4e` 백엔드 이미지를 잠깐 다시 띄워 잼 — `step1-security-institutions.txt`):
  보안 공지 목록 고치기 전 중앙값 0.587초 → 입력 그대로 5~6 ms(기준 30 ms 이하), 입력이 바뀐 뒤 첫 호출 중앙값 0.584초(고치기 전 이하) ·
  기관 목록 92~115 ms → 6~7 ms(기준 10 ms 이하). 응답 15/15가 고치기 전 저장본과 같음(시각 칸만 뺌).
