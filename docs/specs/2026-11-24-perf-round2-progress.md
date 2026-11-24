# 진행 기록 — 성능 개선 2차(보안 공지 판정 · 기관 목록 · 외부 대기 상한 · 경고 띠 · 레이아웃 밀림) (2026-11-24~)

지시문 [2026-11-24-perf-round2-exec-instructions.md](2026-11-24-perf-round2-exec-instructions.md), 계획 기준 커밋 `6479ea4e`, 작업 브랜치 `claude/perf-round2-2026-11`.
사용자 결정(프롬프트): D-1 단계 0 → 1(A·B) → 2(C) → 3(D·E), 받아들임 기준을 채우면 묻지 않고 다음 단계 · D-2 서버 코드가 바뀐 단계마다 main·CI 뒤 권하는 창에서 배포 ·
D-3 화면 조회의 외부 대기 예산 요청 하나에 10초(상세 시세·뉴스·KRX 장중), 검색 세 경로는 ADR 0041의 설계 값이면 그대로 · D-4 띠는 상단바 안의 경고 표시(아이콘·건수)로 ·
D-5 응답 전 자리의 높이만 맞춤 · D-6 새 의존성·스키마 변경·백엔드 새 경로 없음.

측정 원자료(표)는 [docs/qa/evidence/2026-11-24-perf/](../qa/evidence/2026-11-24-perf/) — `baseline.txt`(계획 세션), `step0-seed.txt`(씨앗을 넣은 QA).

## 시작할 때

- `make test` 기준선: (기준선 실행 중 — 끝나면 적음)
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
