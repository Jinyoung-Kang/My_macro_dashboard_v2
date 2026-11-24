# 실행 세션 지시문 — 성능 개선 2차(보안 공지 판정 · 기관 목록 · 외부 대기 상한 · 경고 띠 · 레이아웃 밀림) (2026-11-24)

## 1. 역할과 목표

너는 이 프로젝트를 넘겨받은 시니어 풀스택 엔지니어야. 이 작업은 두 세션으로 나뉘어 있어. 계획 세션(2026-11-24)이 배포본 `main@119cfa4f`를 QA 스택과
운영 서버(읽기만)에서 다시 재고 이 지시문을 썼고, 이 세션은 그 계획을 실행하는 세션이야. 너는 계획 세션의 대화를 볼 수 없어. 이 지시문, 프롬프트,
저장소의 문서와 코드가 네가 아는 전부야.

배경: 1차(2026-11-22, [진행 기록](2026-11-22-perf-status-macro-js-progress.md), ADR 0047)는 상태 질의·미리 받기·매크로 차트를 고쳤어. 이번 재측정에서
그 개선은 그대로 유지되고 있었고(회귀 없음), 대신 아래 다섯 가지를 새로 찾았어. 이 다섯 가지만 고쳐.

- 작업 A — 보안 공지 목록: 운영에서 `/api/security/notices`가 **매번 1.65~1.75초**. 열 때마다 공지 전부를 다시 판정해.
- 작업 B — 기관 목록: 운영에서 `/api/sec13f/institutions`가 **매번 110~120 ms**. 큰 저장본에서 칸 하나를 꺼내려고 전체를 풀어.
- 작업 C — 외부 대기 상한: 외부 출처가 응답하지 않으면 상세·KRX 장중 조회가 **30~62초** 붙잡혀.
- 작업 D — 출처 경고 띠: 끊긴 출처가 있는 날에는 홈을 뺀 모든 화면에서 띠가 늦게 끼어들어 본문 전체를 밀어.
- 작업 E — 띠와 무관하게 남는 레이아웃 밀림: 다섯 화면.

원자료는 [docs/qa/evidence/2026-11-24-perf/baseline.txt](../qa/evidence/2026-11-24-perf/baseline.txt), 측정에 쓴 임시 스크립트 셋은 그 옆 `tools/`에 있어.

## 2. 계획 세션이 확인한 사실 (2026-11-24, `main@119cfa4f` — 같은 날 16:37 KST 배포본)

코드 위치는 파일과 심볼로 가리켜. 실행하기 전에 지금 코드에서 다시 확인해. '확인함'과 '추정'을 구분해 적었어.

### 측정 조건
- QA 스택(이 PC WSL2, 로그인 없는 모드, 외부 차단)을 배포본으로 다시 빌드해 쟀어. **Vultr 값이 아니야.**
- QA DB에는 보안 공지가 씨앗 몇 건뿐이고 13F 즐겨찾기가 없어. 그래서 **작업 A·B는 QA에서 보이지 않아**(보안 공지 43 ms, 기관 목록 3 ms).
- 운영 서버는 읽기만 했어: 이 PC에서 화면이 부르는 조회 API 97개를 경로마다 2~3번, 한 번에 하나씩(응답은 버림, 실제 계좌 경로 제외), DB는 통계 표와 크기만.
  운영 값에는 왕복 약 8 ms가 들어 있어.
- 운영에는 느린 질의·응답 시간 기록이 없어(`pg_stat_statements` 없음, `log_min_duration_statement` = −1, caddy 접근 기록 없음).

### 유지되고 있는 것(1차 결과 — 건드리지 않아도 되는 근거)

| 항목 | 2026-11-22 끝 | 2026-11-24 |
|---|---|---|
| 11경로 혼합 동시 50명 | 581건/초 | 581.1건/초 · p95 256.7 ms |
| `/api/status/issues`(QA 단발) | 17 ms | 12 ms |
| 화면별 RSC 미리 받기 | 0 | 0 (58화면 모두) |
| 홈 스크립트 전송량 | 342 KB | 343 KB |
| 매크로 모바일 성능 · TBT / 데스크톱 TBT | 66 · 694 ms / 51 ms | 66 · 676 ms / 31 ms |

일곱 화면 Lighthouse(3회 중앙값)는 1차 끝과 성능 ±1점·CLS 같음. 운영 97경로의 중앙값은 11.5 ms이고 100 ms를 넘는 것은 8개야.
SQL 문장 수는 경로당 최대 36개(`/api/paper/overview`)이고 QA에서 10 ms 넘는 문장은 1,552개 중 8개(큰 저장본 첫 읽기와 60초 기억되는 행 수 세기)라 **SQL 쪽 문제는 없어.**

### 작업 A — 보안 공지 목록 (확인함)
- 운영에서 여섯 번 연달아 1,745·1,717·1,713·1,654·1,712·1,683 ms. `/api/security/inventory`는 15~19 ms, QA의 목록은 43 ms.
- `SecurityService.notices`(`backend/.../feature/security/SecurityService.java`)가 요청마다 `judgeAll`을 불러. `judgeAll`은 `store.notices()`·`store.rows()`로 공지와 표 행을
  전부 읽고 공지마다 `NoticeJudge.judge`를 돌린 뒤, 메모리에서 거르고 20건만 잘라 줘. 그 앞에 `loadInventory`가 구성·대기 갱신·변경 기록 CVE·추적기 상태를 전부 읽어.
  `SecurityController`는 응답 캐시를 쓰지 않아.
- 운영 표 크기: `security_notices` 135행(222 kB), `security_notice_rows` 1,999, `env_components` 1,712, `env_changelog_cves` 11,340, `distro_cve_status` 9.
- 같은 `judgeAll`을 `SecurityAlertJob`이 15분마다 돌려(`@Scheduled` — `alert-interval-ms` 900000).
- 판정의 입력은 수집기가 쓰는 표(`security_notices`·`security_notice_rows`·`env_inventory`·`env_components`·`env_pending_updates`·`env_changelog_cves`·
  `distro_cve_status`)와 코드의 별칭 표뿐이야. 변경을 싸게 알 수 있는 칸: `security_notices.updated_at`, `env_inventory.received_at`·`collected_at`,
  `distro_cve_status.checked_at`. 수집기가 이 표들을 어떻게 쓰는지(통째로 바꿔 쓰는지, 행마다 고치는지)는 확인하지 않았어.
- `read.ComputedCache`는 **저장본(`snapshots`)의 최신 수집 시각**으로만 값을 버려. 보안 표는 저장본이 아니라서 그대로 쓰면 옛 판정이 최대 60초 남아. 그리고 서비스 안에서
  `ComputedCache`를 부르면 안 돼(ADR 0001 — 클래스 설명).
- 1.7초 가운데 DB 읽기·구성 조립(`toInventory`)·판정의 몫은 **재지 않았어**(QA에 그 규모의 자료가 없음).

### 작업 B — 기관 목록 (확인함)
- 운영에서 여섯 번 연달아 110~119 ms. `/institutions`·`/consensus`·`/alerts` 화면이 불러.
- `InstitutionController.institutions` → `Sec13FFavoriteService.listEntries` → `StoreReader.readStoredHeads` → `StoreRepository.readSnapshotHeads`의 질의
  `SELECT name, collected_at, payload->'quarters'->0->>'reportDate' … FROM snapshots WHERE name = ANY (?)`가 이름마다 저장본 JSONB 전체를 풀어.
- 운영: 즐겨찾기 12곳(이름은 기관마다 q8·q30 둘), 13F 저장본 66개·29 MB(큰 것은 하나에 1.5~3.7 MB).
- QA에서 재현(13F 저장본 52개·16 MB): 그 칸을 꺼내면 100~114 ms, `name`·`collected_at`만 읽으면 0.35 ms.
- 같은 표에서 `payload->'quarters'`를 SQL로 다루는 질의가 `StoreRepository`에 둘 더 있어(`jsonb_typeof(payload->'quarters')`를 조건으로 쓰는 것,
  `jsonb_array_elements(… payload->'quarters')`를 펼치는 것). 어디서 얼마나 자주 불리는지는 재지 않았어.

### 작업 C — 외부 대기 상한 (확인함)
- QA 프록시를 `hang`(요청을 받고 응답하지 않음)으로 두고 화면 GET 102경로를 한 번씩 부른 결과:

| 경로 | 걸린 시간 |
|---|---|
| `/api/detail/news?q=…`(질의어) | 62.1초 |
| `/api/detail/news?market=us&code=NVDA` · `?market=kr&code=005930` | 53.8초 · 31.0초 |
| `/api/detail/quote`(미국 · 한국) | 30.0초 · 31.0초 |
| `/api/krx/intraday?minutes=30` | 31.0초 |
| `/api/search/feed` · `/api/search/resolve` · `/api/search/entity` | 17.7초 · 15.0초 · 15.0초 |

  나머지 92경로는 0.5초 안이야 — 화면 대부분은 저장본으로 그려져 외부에 붙잡히지 않아.
- 원인: `collector/app/services/detail.py`가 공용 세션(`http.get_session` — 재시도 2회·backoff 0.5)으로 요청마다 `timeout=FETCH_TIMEOUT`(10초)을 줘서 출처 하나에
  약 31초, 뉴스는 출처·질의가 둘이면 두 배가 돼. 백엔드 → 수집기 일반 호출의 읽기 상한은 90초(`CollectorClient` — 전용 상한은 `CONTROL_READ_TIMEOUT` 3초·
  `SEARCH_SUGGEST_READ_TIMEOUT` 10초 등 몇 개만), 화면 요청에는 상한이 없어(`frontend/src/lib/api.ts`의 `timeoutMs` 0).
- `collector/app/http.py`에는 **태스크의 시간 상한에 맞춰 요청 timeout을 줄이는 장치**가 이미 있어(`MIN_REQUEST_TIMEOUT`·`RETRY_RESERVE_SECONDS` 주변, 모듈 설명).
  재시도 없는 세션(`relay` 꼴)도 있어.
- 외부가 바로 끊길 때(`block`)는 `krx/intraday` 1.0초, 브라우저 기준 `detail/news` 1~2초·검색 1.3~2.7초야. 운영 정상 때는 `detail/news` 첫 호출 1,265 ms 뒤 26 ms,
  `search/resolve` 첫 호출 3,227 ms 뒤 16 ms, `krx/intraday` 매번 89~356 ms.
- 검색 세 경로의 15초가 ADR 0041의 설계 값인지는 확인하지 않았어.

### 작업 D — 출처 경고 띠 (확인함)
- `frontend/src/components/shell/Shell.tsx`가 `<main>` 안 본문 맨 위에 `SourceAlertBanner`를 그려(홈 `/`만 뺌 — QA-613). 띠는 `/api/info/sources` 응답이 온 뒤
  (약 100 ms) 끼어들어 그 아래 전부를 밀어. 근거 결정은 ADR 0035 결정 7과 그 덧붙임(2026-11-17 홈 제외, 2026-11-12 QA-408 사건 회차)이야.
- 끊긴 출처 사건이 있을 때만 떠. QA는 외부 차단이라 늘 1건, **운영은 측정 시점에 0건**이었어.
- 띠의 요청을 막고(`*/api/info/sources*`) 모바일 Lighthouse를 한 번씩 돌린 값:

| 화면(모바일) | 띠 있음 CLS · 성능 | 띠 없음 CLS · 성능 |
|---|---|---|
| `/institutions` | 0.161 · 69 | 0.019 · 75 |
| `/paper/us` | 0.143 · 63 | 0.004 · 67 |
| `/macro` | 0.032 · 66 | 0.000 · 64 |
| `/info/overview` | 0.569 · 67 | 0.253 · 77 |
| `/s/us/NVDA` | 0.197 · 73 | 0.114 · 79 |

  곧 1차 기록의 '모바일 CLS 0.1 넘는 화면 넷' 가운데 기관·모의매매는 전부 띠였어.
- 데스크톱 58화면(감속 없음)에서 CLS 0.1 이상은 띠가 있으면 10화면, 띠를 막으면 3화면이야.

### 작업 E — 띠와 무관하게 남는 밀림 (확인함 — 띠 요청을 막은 상태)

| 화면 | 값 | 밀린 요소 · 때 |
|---|---|---|
| `/security`(데스크톱) | 0.351 | 탭 패널(`div#…-panel`)과 `section.@container` · 89 ms |
| `/ai/report`(데스크톱) | 0.221 | `section.rounded-card` · 95 ms |
| `/institutions/[cik]`(데스크톱, 표본 `0001608046`) | 0.170 | `section.rounded-card` 둘 · 170 ms |
| `/info/overview`(모바일 Lighthouse) | 0.253 | `div.space-y-6 > div.grid` 0.165 + 0.087 |
| `/s/us/NVDA`(모바일 Lighthouse) | 0.114 | `main > div.mx-auto > div.flex > div.flex` |

- 그다음 큰 것: `/s/kr/005930` 0.090, `/radar` 0.056, `/search?e=…` 0.050(데스크톱).
- 종목 상세의 밀림은 QA에서 시세가 차단돼 오류 문장이 뜨는 탓일 수 있어(추정). LCP도 그 안내 문장에 끌려가(`/s/kr/005930` 3,136 ms).
- 화면 파일: `app/(dashboard)/security/`(`SecurityScreen`·`NoticeScreen`), `app/(dashboard)/ai/report/`, `components/screens/detail/`(`InstitutionDetailScreen`·`DetailParts`),
  `components/screens/info/OverviewSection.tsx`, `app/(dashboard)/s/[market]/[code]/page.tsx`.
- 계획 세션의 임시 도구는 **모바일 폭에서 CLS가 거의 0으로만 나왔어**(원인 미확인). 모바일은 Lighthouse 값만 믿어.

### 범위 밖에서 본 것(기록만 — 고치지 마)
- `/api/macro/ticker`가 운영에서 매번 약 100 ms(열 때마다 수집기가 외부를 조회 — `MacroService.tickerSeries`). 기억해 두려면 신선도 결정이 필요해.
- `/api/search/feed`가 2년 묶음 2,573건·원본 1.5 MB(gzip 377 KB)를 한 번에 줘 — 기간 단추를 다시 부르지 않게 한 설계야(`lib/endpoints.ts`의 주석).
- 모의매매 화면의 스크립트가 608 KB로 가장 커(홈 343 KB). `/api/paper/overview`는 계좌마다 같은 질의를 되풀이해 36문장(운영 55~60 ms, 18화면이 부름).
- 매크로 모바일 TBT 676 ms(1차에서 그대로 두기로 한 값), 셸 왼쪽 메뉴의 강제 레이아웃(1차 기록).
- 운영에 느린 질의 기록이 없는 것 — 켜려면 질의 인자 값이 기록에 남지 않게 해야 해(실제 계좌 자료 규칙). 이번에는 하지 마.
- 로컬 스택(3002)의 postgres가 Docker 재시작 뒤 `Exited (127)`로 남아 있어(계획 세션은 건드리지 않음).

## 3. 실행 순서와 멈춤점

| 단계 | 내용 | 시작 조건 | 끝 |
|---|---|---|---|
| 0 | 측정 도구를 저장소에 넣고 QA에 운영 규모의 합성 자료를 넣어 A·B를 재현 | 바로 | 구현·시험·main·CI (배포 없음) |
| 1 | 작업 A·B (백엔드) | 단계 0 뒤 | 구현·시험·측정·main·CI·배포·운영 확인 |
| 2 | 작업 C (수집기·백엔드) | 단계 1 뒤 | 구현·시험·측정·main·CI·배포 |
| 3 | 작업 D·E (화면) | 단계 2 뒤 | 구현·시험·측정·main·CI·배포 |

- 단계를 끝낼 때마다 보고하고, 다음 단계로 바로 넘어갈지는 프롬프트의 D-1을 따라.
- 받아들임 기준에 못 미치면 억지로 맞추지 말고, 잰 값과 남은 원인을 적어 보고한 뒤 멈춰.
- 기다릴 일이 생겨도 세션 예약(ScheduleWakeup 등)을 걸지 마.

## 4. 작업별 명세

### 단계 0 — 측정 도구와 재현 자료
- `docs/qa/evidence/2026-11-24-perf/tools/`의 셋을 `scripts/qa/`로 옮겨 다듬어(이름·사용법 주석·안전 문구는 지금 있는 `nav-timing.js`·`core-get.sh`의 관례대로):
  - `page-apis.js` — 화면 경로마다 열어 `/api/` 요청(시간·크기·상태)과 CLS·LCP·긴 작업·DOM 수를 모음. `--block`으로 요청을 막을 수 있음(띠 없는 상태 재기).
    **모바일 폭에서 CLS가 0으로만 나오는 문제를 먼저 고쳐**(Lighthouse 모바일 값과 대조해 확인). 못 고치면 모바일은 Lighthouse만 쓴다고 주석에 적어.
  - `sql-replay.sh` — QA postgres에 문장 기록을 잠깐 켜고 경로마다 두 번 불러 문장 수·DB 시간을 셈(끝에 설정을 되돌림).
  - `hang-test.sh` — QA 프록시를 `hang`으로 바꿔 경로마다 한 번 부름(끝에 `block`으로 되돌림).
- `scripts/qa/lighthouse.sh`에 요청을 막는 인자(Lighthouse의 `--blocked-url-patterns`)를 넘길 길을 더해 — 띠 없는 상태를 3회 중앙값으로 재려고.
- **QA 재현 자료**: QA DB에 운영 규모의 합성 자료를 넣는 씨앗을 만들어 — 보안 공지 약 135건·표 행 약 2,000·구성 약 1,700·변경 기록 CVE 약 11,000·추적기 상태 몇 건,
  13F 즐겨찾기 12곳과 그 저장본(MB 단위). **운영의 공지 원문·근거 버전·실제 계좌 자료를 가져오지 마** — 합성 글과 지어낸 CVE 번호·판만(지금 `scripts/qa/security-seed.sql`과
  결함 기록의 관례). 씨앗은 QA DB에만 쓰이게(운영·시험 DB에 닿지 않게) 하고, 테이블마다 쓰는 프로세스 규칙(ADR 0008)은 QA 씨앗의 기존 관례를 따라.
- 씨앗을 넣은 QA에서 `/api/security/notices`와 `/api/sec13f/institutions`를 재서 진행 기록에 적어. 운영 값(1.7초·110 ms)과 크게 다르면 이유를 적고, 재현이 안 되면 멈추고 물어봐.
- 운영 단발 측정은 스크립트로 두지 말고 §5의 규칙대로 손으로 해(주소가 저장소에 남지 않게).

### 작업 A — 보안 공지 목록 (단계 1)
- **A1 먼저 나눠 재기.** 씨앗을 넣은 QA에서 `notices` 한 번의 시간을 DB 읽기 / 구성 조립 / 판정으로 나눠 재(임시 계측이나 프로파일러 — 계측 코드는 커밋하지 마).
- **A2 입력이 바뀔 때만 다시 판정.** 판정 결과(`judgeAll`의 목록)를 기억해 두고, 입력 표와 별칭 표가 그대로면 다시 계산하지 않게 해. '바뀌면 반드시 달라지는' 판 값을
  정하려면 수집기가 그 표들을 쓰는 방식부터 확인해(§2). 판 값 확인은 싸야 해(행 전체를 읽지 않게). 판 값을 놓치는 경우에 대비해 시간 상한도 함께 둬.
  기억을 어디에 둘지(서비스 안의 전용 기억, 컨트롤러 쪽 캐시)는 ADR 0001의 의존 규칙과 `ComputedCache` 설명을 읽고 정해 — 이유를 기록해.
- `SecurityAlertJob`도 같은 결과를 쓰게 해. 다만 알림이 옛 판정으로 나가면 안 되니 판 값 확인은 매번 해.
- 목록의 거르기·세기·자르기(`verdict`·`reason`·`q`·`page`·`size`)는 기억한 결과 위에서 지금처럼.
- A1에서 판 값이 바뀐 직후의 첫 계산이 여전히 1초를 넘으면, 그 원인(요청마다 다시 만드는 색인·정규식, 공지마다 되풀이되는 일)을 줄여. 판정 규칙은 바꾸지 마.
- **결과는 한 글자도 달라지면 안 돼**: 고치기 전후 `/api/security/notices`(필터 조합 여럿)·`/api/security/notices/{id}`·`/api/security/inventory`의 JSON이 시각 칸을 빼고 같음을
  시험으로 고정해. 입력이 바뀌면(공지 하나 고침, 구성 바뀜, 추적기 상태 바뀜) 다음 호출에 바로 반영되는 것도 시험해.
- 받아들임 기준: 씨앗을 넣은 QA에서 두 번째 호출부터 **30 ms 이하**, 입력이 바뀐 뒤 첫 호출은 고치기 전 값 이하. 배포 뒤 운영에서 여섯 번 연달아 불러 둘째부터
  **50 ms 이하**(왕복 포함).

### 작업 B — 기관 목록 (단계 1)
- `readSnapshotHeads`가 호출마다 저장본을 풀지 않게 해. 한 가지 길: 먼저 `name`·`collected_at`만 읽고, 수집 시각이 바뀐 이름만 보고 기준일을 다시 읽어 기억. 더 나은 길이 있으면
  그것으로(이유 기록). 스키마를 바꾸는 길(보고 기준일을 따로 저장)은 프롬프트 D-6에 따라 하지 마.
- §2의 같은 꼴 질의 둘은 불리는 곳과 빈도를 재 보고, **같은 문제가 실제로 보이는 것만** 고쳐.
- 저장본이 새로 수집되면 새 보고 기준일이 바로 보여야 해(시험). 즐겨찾기를 더하거나 지운 직후도.
- 시험은 시간으로 단정하지 말고 꼴로: 같은 목록을 두 번 부를 때 둘째에는 본문을 푸는 질의가 나가지 않음.
- 받아들임 기준: 씨앗을 넣은 QA에서 `/api/sec13f/institutions` 둘째부터 **10 ms 이하**, 응답 동일. 배포 뒤 운영 **20 ms 이하**(왕복 포함).

### 작업 C — 외부 대기 상한 (단계 2)
- 대상은 **화면에서 사용자가 열 때 수집기가 외부를 부르는 조회**야: 수집기 `/live/quote`·`/live/news`·`/live/daum-intraday`. 정기 수집(태스크)의 상한·재시도는 건드리지 마.
- 요청 하나의 전체 예산을 프롬프트 D-3의 값으로 둬. 출처가 여럿이면 예산 안에서 나눠 쓰고, 먼저 받은 것은 지금처럼 돌려줘. `http.py`에 이미 있는 '상한에 맞춰 timeout을
  줄이는 장치'나 재시도 없는 세션을 쓸 수 있는지부터 봐 — 새 장치를 만들기 전에.
- 예산이 끝나면 지금의 '받지 못함' 응답 꼴 그대로 돌려줘(화면의 문구와 모양은 그대로). 직전에 받은 값을 보여 주는 동작이 지금 있으면 유지해.
- 백엔드 → 수집기의 읽기 상한도 이 경로들에는 '예산 + 여유'로 맞춰(`CollectorClient`의 전용 상한 관례).
- 검색 세 경로(15~18초)는 ADR 0041에서 그 숫자가 설계 값인지 확인해. 설계 값이면 그대로 두고 기록만, 아니면 같은 예산으로.
- 상대 부담 원칙: 재시도를 줄이는 쪽이라 요청은 늘지 않아. 호스트별 간격·래치(`http.py`)는 그대로 둬.
- 시험은 외부에 요청하지 마 — 응답하지 않는 루프백 임시 서버로 예산 안에 끝나는지 봐.
- 받아들임 기준: QA 프록시 `hang`에서 `detail/news`·`detail/quote`·`krx/intraday`가 **예산 + 2초 안**, `block`과 정상 응답에서는 결과가 고치기 전과 같음, 수집기 시험 전부 통과.
  배포 뒤 운영에서 이 경로들을 두 번씩 불러 정상 응답 확인(읽기만).

### 작업 D — 출처 경고 띠 (단계 3)
- 프롬프트 D-4의 방식으로 **본문을 밀지 않게** 해. 문구(`bannerText`), '출처 상태 보기' 링크, 닫기와 다시 뜨는 규칙(사건 회차 — QA-408), 운영자에게만 보이는 것은 그대로 지켜.
  홈에서 띠를 그리지 않는 지금 규칙도 그대로(홈에는 패널이 있음).
- 작업대 화면 언어(ADR 0042)와 화면 계층(ADR 0004)을 지키고, 좁은 폭(390)에서도 누름 자리·넘침·대비 감사를 통과해야 해. 고치기 전후 캡처를 진행 기록에 설명과 함께(캡처 파일은 커밋 금지).
- 결정이 바뀌는 것이니 ADR 0035 결정 7에 덧붙임을 써.
- 받아들임 기준(QA — 사건 1건이 있는 상태): 일곱 화면 모바일 Lighthouse(3회 중앙값)의 CLS가 §2 표의 '띠 없음' 값 + 0.02 안, 데스크톱 58화면에서 띠가 있을 때와 요청을 막았을 때의
  CLS 차이가 화면마다 0.02 안. 닫으면 사라지고 새 사건이면 다시 뜨는 시험 통과.

### 작업 E — 남는 레이아웃 밀림 (단계 3)
- §2 표의 다섯 화면에서, 응답이 오기 전 자리(뼈대·빈 상태)의 높이를 응답 뒤와 맞춰 밀림을 없애. **내용·순서·숫자는 그대로**(프롬프트 D-5).
- 종목 상세는 QA의 차단된 시세 탓인지부터 가려(시세가 정상으로 올 때의 밀림을 잴 방법을 찾아 — 못 찾으면 그 화면은 기록만).
- 0.05~0.1인 세 화면(`/s/kr/005930`·`/radar`·`/search?e=…`)은 같은 원인으로 함께 고쳐지면 고치고, 아니면 기록만.
- 받아들임 기준(띠 요청을 막은 상태): 다섯 화면 모두 **CLS 0.05 이하**(데스크톱은 `page-apis.js`, 모바일은 Lighthouse 3회 중앙값), 다른 화면이 나빠지지 않음
  (58화면 데스크톱 기록 전후 비교 — 0.02 넘게 늘어난 화면 없음), 화면 시험과 `ui-audit.js` 통과.

## 5. 지켜야 할 규칙

원문은 `CLAUDE.md`·`docs/DEVELOPMENT.md`·`docs/PRINCIPLES.md`·`docs/adr/README.md` — 먼저 읽어. 이 지시문과 충돌하면 프로젝트 규칙이 우선이고,
무엇을 따랐는지 진행 기록에 적어.

- 작업 브랜치 `claude/perf-round2-2026-11`(단계별로 나눠도 됨). 커밋 `type(scope): 요약`(요약은 한국어, type은 이 저장소가 쓰는 fix·test·feat·refactor·docs·chore) +
  `Co-Authored-By` 줄. 옮기는 커밋과 고치는 커밋을 나눠. 모든 커밋이 `make test`를 통과해야 해 — **`make`의 종료 코드를 따로 확인해**(1차 때 출력 끝만 보고 통과로 읽은 일이 있었음).
- 다섯 작업은 결함으로 다뤄: `QA-###` — 재현 시험 `test(QA-###)`(고치기 전 strict xfail/`@Disabled`) → `fix(QA-###)`. 다음 번호는 `docs/qa/2026-11-12-defects.md` 끝과
  `git log`에서 확인해(2026-11-24 기준 QA-991). 다른 세션과 겹치지 않게 시작할 때 쓸 번호를 그 파일에 먼저 적어.
- **성능 시험은 QA 스택에서만.** 로컬 스택(3002…)에는 하지 마. QA 스택은 하나뿐이고 포트가 고정이야 — 떠 있으면 누가 띄웠는지 먼저 보고
  (컨테이너 라벨 `com.docker.compose.project.working_dir`), 다른 세션의 작업 폴더면 다시 빌드하거나 내리기 전에 사용자에게 물어봐.
  Docker가 다시 켜진 뒤 QA postgres가 `Exited (127)`이면 `bash scripts/qa/qa-stack.sh compose up -d --force-recreate --no-deps postgres qaproxy`.
- **운영 서버 측정 규칙(읽기만)**: 조회(GET) API를 한 번에 하나씩, 경로마다 여섯 번까지, 응답은 버리고 시간만 적어. 실제 계좌 경로(`/api/brokerage/account`·`/api/manual/*`·
  `/api/realtrade/*`·`/api/toss/*`)는 부르지 마. 매매·결정 시각(§7)을 피해. 부하·브라우저 시험·Lighthouse는 운영에 하지 마. 운영 DB는 통계 표·크기·`EXPLAIN`(실행 없음)까지만.
  주소·IP·tailnet 이름을 저장소에 적지 마.
- 보안 공지의 운영 원문과 근거 버전, 실제 계좌(토스·ISA) 자료는 저장소·시험 자료·QA 기록·로그 어디에도 넣지 마.
- 모의 매매·실제 매매 코드와 프롬프트·스키마·패킷 고정본은 건드리지 않아. 닿게 되면 멈추고 물어봐.
- 테이블마다 쓰는 프로세스는 하나(ADR 0008) — 보안·저장본 표는 수집기 표라 백엔드는 읽기만.
- 화면은 작업대 화면 언어(ADR 0042)와 화면 계층(ADR 0004)을 지켜. 고친 화면은 `node scripts/qa/ui-audit.js`를 전후로 돌려.
- 새 의존성·스키마 변경·백엔드의 새 `/api` 경로는 하지 마(프롬프트 D-6). 꼭 필요하면 이유를 설명하고 멈춰.
- 이모지 금지(코드·주석·문서·스크립트 출력·커밋 메시지). 날짜는 KST, 없는 숫자는 `null`.
- 라이브러리 동작은 기억으로 쓰지 말고 문서(Context7이 연결돼 있으면 그것)에서 지금 판 기준으로 확인해.
- 캡처·Lighthouse JSON·분석 산출물은 커밋하지 마. 표로 정리한 값만 `docs/qa/evidence/2026-11-24-perf/`에.

## 6. 검증 수단

| 묶음 | 명령 |
|---|---|
| 수집기 | `make test-collector` |
| 백엔드 | `make test-backend`(이 PC는 JDK 25 — CI와 같은 JDK 21로 재는 방법은 `CLAUDE.md` '이 환경의 함정') |
| 화면 | `make test-frontend` |
| 전체 | `make test`(CI와 같은 명령) |
| 성능 | `CLAUDE.md` '명령'의 측정 줄 + 단계 0에서 넣는 셋 |

- 계획 세션은 `make test` 기준선을 재지 않았어. 시작할 때 `main`에서 한 번 재서 진행 기록에 적어.
- 성능은 고치기 전후를 **같은 QA 스택·같은 DB·같은 백엔드**에서 재(1차 때 백엔드가 달라 CLS가 섞인 일이 있었음). Lighthouse는 3회 중앙값.

## 7. 전달과 배포

- 단계마다: 작업 브랜치 → `make test` 통과 → 본체 폴더 `main`에 fast-forward → `git push origin main <브랜치>` → CI 6/6 확인 → (서버 코드가 바뀐 단계면) 배포.
  새 push에 밀려 취소된 실행은 그 위 커밋의 실행으로 확인하고, GitHub 쪽 사정으로 취소된 job만 다시 돌려.
- 배포 여부는 프롬프트 D-2를 따라. 서버에서 `bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh`. 앱 컨테이너가 1~2분 다시 만들어지니 매매·결정 시각을 피해:
  한국 거래 창(평일 08:45~15:35 KST — `deploy.sh`가 막음), 미국 정규장과 두 시장의 정기 결정·고정 장중 판단·마감 브리핑 전후(시각은 서버 설정으로 확인),
  일요일 주간 복기(21:00·22:00), 백업(08:00·일 23:00). 권하는 창은 평일 16:30~22:00, 토요일, 일요일 20:30 전이야.
- 배포 뒤 확인: 컨테이너 여섯 정상, `make status`, 백엔드 ERROR 0, 그 단계의 운영 확인 항목. 확인한 것과 못 한 것을 구분해 보고.
- 서버 접속은 Tailscale SSH야. 추가 확인(브라우저 재인증)에서 멈추면 `timeout`으로 끊고 사용자에게 재인증을 부탁해 — 비상 키 경로로 돌아가지 마.

## 8. 기록과 보고

- 진행 기록: `docs/specs/2026-11-24-perf-round2-progress.md`(새 파일) — 단계마다 한 일·커밋·시험 결과·전후 측정값·배포 시각·남은 일. 코드는 옮겨 적지 말고 파일:심볼로.
- 측정 표: `docs/qa/evidence/2026-11-24-perf/`에 단계별 파일(기준선은 `baseline.txt`).
- 설계 결정(판정 기억과 판 값, 저장본 머리 읽기, 화면 조회의 외부 예산, 띠의 자리)은 ADR로 — ADR 0047에 덧붙일지 새 ADR(다음 번호 확인 — 2026-11-24 기준 0049)로 할지
  네가 정하고, 띠는 ADR 0035에도 덧붙여. 지키는 방법(시험 이름)을 적어.
- 같이 고칠 문서: `docs/API.md`(응답이나 수집기 경로가 바뀌면), `CLAUDE.md`·`docs/DEVELOPMENT.md`의 측정 명령 문구(스크립트를 더하면), 결함 기록.
- 프로젝트 메모리(`~/.claude/projects/-home-jykang-Projects-My-macro-dashboard-v2/memory/perf-improvement-2026-11.md`)에 진행 상태를 이어 적어.
- 단계를 끝낼 때마다 사용자에게 한국어로 보고: 한 일, 커밋 번호, 시험·CI 결과, 전후 측정값, 배포 여부와 시각, 다음 단계. 확인한 사실과 추정을 구분해.

## 9. 멈추고 물어볼 때

- 단계 0에서 A·B가 QA에 재현되지 않을 때
- 받아들임 기준에 못 미칠 때, 또는 기준을 바꿔야 한다고 볼 때
- 판정 결과·알림이 고치기 전과 달라질 수 있을 때(작업 A)
- 띠의 문구·닫기 규칙을 바꿔야 하거나, 화면의 내용·순서·구조가 바뀌는 방법이 필요해 보일 때(작업 D·E)
- 스키마·색인 변경, 백엔드의 새 `/api` 경로, 새 의존성이 필요할 때
- 모의 매매·실제 매매 코드나 고정본에 닿게 될 때
- QA 스택을 다른 세션이 쓰고 있을 때
- 이 지시문과 지금 코드가 크게 달라 계획대로 할 수 없을 때
