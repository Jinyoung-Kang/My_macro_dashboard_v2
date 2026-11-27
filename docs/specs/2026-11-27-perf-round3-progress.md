# 진행 기록 — 성능 개선 3차(차트 시계열 조회 · 계산 결과 기억 · 검색 피드 · 모바일 레이아웃 밀림) (2026-11-27~)

지시문 [2026-11-27-perf-round3-exec-instructions.md](2026-11-27-perf-round3-exec-instructions.md), 계획 기준 커밋 `02071150`, 작업 브랜치 `claude/perf-round3-2026-11`.
사용자 결정(프롬프트): D-1 단계 0 → 1(A) → 2(B) → 3(C·D), 받아들임 기준을 채우면 묻지 않고 다음 단계 · D-2 서버 코드가 바뀐 단계마다 main·CI 뒤 권하는 창에서 배포 ·
D-3 차트 시계열의 외부 대기 예산 10초, 받은 결과는 일봉(1개월 이상) 5분·분봉(1일·5일) 60초 기억, 받지 못한 결과는 기억하지 않음 · D-4 검색 피드는 먼저 재고 기준을 넘을 때만
보이는 만큼만 그리기(날짜 묶음 단위) · D-5 응답 전 자리의 높이만 맞춤 · D-6 새 의존성·스키마 변경·백엔드 새 경로 없음.

측정 원자료(표)는 [docs/qa/evidence/2026-11-27-perf/](../qa/evidence/2026-11-27-perf/) — `baseline.txt`(계획 세션), `step0-reproduce.txt`(이 세션의 도구·씨앗·다시 잰 기준선).

## 시작할 때 (2026-11-27 22:08 KST)

- `make test` 기준선: 계획 기준 커밋 `02071150`(main과 같은 내용)에서 22:08~22:40 KST — 수집기 3,859 통과·40 건너뜀, 백엔드 4,136, 화면 5,131(파일 517), `make` 종료 코드 0(32분 —
  그 사이 QA 측정과 별도 작업 폴더의 백엔드 컴파일이 함께 돌아 평소보다 김). 도는 동안 본체 폴더에서 고친 것은 `scripts/qa/`와 수집기 `app/main.py`·`app/services/market.py`,
  새 시험 파일 둘(이미 모인 시험 목록에는 들지 않음)이고, 백엔드·화면 소스는 시험이 끝난 뒤에 고쳤다(백엔드 작업은 그동안 별도 작업 폴더 `.claude/worktrees/perf-r3`에서).
- QA 스택: 계획 세션이 이 폴더(`/home/jykang/Projects/My_macro_dashboard_v2` — 컨테이너 라벨 `com.docker.compose.project.working_dir`)에서 배포본으로 띄운 것. 다른 세션의 작업 폴더가 아니라 그대로 씀.
- 결함 번호: QA-1039(작업 A)·QA-1040(B1)·QA-1041(B2)·QA-1042(D)를 이 작업이 쓴다(결함 기록에 먼저 잡음). 다음 번호 QA-1043.
- 커밋마다의 시험: 커밋마다 그 커밋이 바꾼 묶음의 관련 시험과 린트를 돌리고, 전체 `make test`는 단계 끝 커밋에서 돌린다(2차와 같은 방식 — 단계마다 적음).

## 단계 0 — 측정 도구와 재현 자료

- `scripts/qa/hang-test.sh`: `FRESH=once|each`(QA 수집기·백엔드를 `restart`로 다시 띄우고 둘 다 답할 때까지 기다린 뒤 잼 — `docker kill`은 쓰지 않음)와 `TARGET=collector`
  (수집기 `/live/…`를 바로 — 서비스 토큰은 `.env.qa`에서 읽어 머리글로만). 머리 설명에 '화면 기록 직후에 재면 앞선 호출의 기억·호스트 잠금 때문에 바로 끝난다'를 적음.
- `scripts/qa/sql-replay.sh`: 실행 줄(execute·statement)만 센 '문장'과 기록 줄 수('줄')를 함께 찍고 전체 합(처음·다시)을 냄. 2026-11-24 기준선의 653 · 417은 실행 문장 수.
- `scripts/qa/page-apis.js`: `--rate <배수>`(CDP `Emulation.setCPUThrottlingRate`) — 긴 작업·DOM을 CPU 4배 감속으로 볼 때(작업 C).
- `scripts/qa/perf-seed.py feed`: 검색 피드 재현 자료 — 대상 `us:NVDA`에 합성 글. 수집기의 읽기 상한(모은 글 1000·피드 묶음 500)은 그대로 두고 세 출처로 나눠 넣음:
  모은 글 `search_watch_items` 1,050행(상한에 걸려 1,000줄 — 운영처럼 '최근 1000건까지만 읽음'), 새 피드 묶음 `observations search_feed_headline` 480행,
  사건 뉴스 `observations news_headline` 1,276행. 제목은 낱말 주머니 조합 + `NVIDIA`(QA가 푸는 이름), 약 4분의 1은 같은 사건의 변주(같은 글 묶기가 일함), 매체 `[QA] 가짜 매체 NN`,
  주소 `example.invalid`, 요약 `[QA 성능 씨앗]…`. 사건 뉴스 표는 모의 매매 패킷·정보 화면도 읽으므로 **8일보다 오래된 날짜로만** 넣고 `feed` 칸을 `qa_perf_seed`로 적음
  (다만 QA DB가 11-04 복원본이라 `/info/news` 앞쪽에 이 줄이 보임). 첫 운영자의 관심 대상에 `us:NVDA`를 더함. 지우는 법은 파일 머리.
  - 넣은 뒤 QA `/api/search/feed?e=us:NVDA&tab=timeline`: 2,764줄(씨앗 2,756 + QA에 있던 8), 7일 1,480 · 30일 2,089 · 1년 2,343 · 2년 2,764, 원본 1,895 KB(gzip 256 KB),
    한 줄 평균 715 B, 묶음 191개(묶인 줄 842). 운영(2,756줄 · 7일 1,647 · 30일 2,079 · 1,630 KB · gzip 428 KB · 598 B)과 건수·30일 비율은 같고, 7일 비율이 조금 낮고
    (54% 대 60% — 8일 안쪽은 패킷 표를 피하느라 두 출처만 씀) 합성 글이라 더 잘 눌린다.
- 모든 `/live/*` 경로를 hang(비운 상태, 수집기를 바로)에서 한 번씩 — 표는 `step0-reproduce.txt` 2절. 예산 + 2초(12초)를 넘는 것:
  `/live/symbols` 120초 넘음 · `/live/prices` 100초 · `/live/ticker` 70초 · `/live/radar` 62초 · `/live/search/feed`·`links` 45초 · `resolve`·`entity` 15초.
  검색 넷은 ADR 0041의 설계 값(대상 풀기·resolve 15초 + 출처 30초 = 45초 — `services/search.py`의 `ENTITY_DEADLINE`·`RESOLVE_DEADLINE`·`SOURCE_DEADLINE`)이라 그대로 두고,
  **종목 찾기·실시간 시세·수급 랭킹 셋은 문서로 확인되는 설계 값이 없어 작업 A에서 차트 시계열과 같은 방법으로 고친다**(지시문 A1).
- 기준선 다시 재기(같은 QA·같은 DB, 씨앗을 넣은 뒤 — `step0-reproduce.txt`):
  - 식은 계산 경로(백엔드가 뜬 지 10분 뒤, 앞 호출에서 2분 40초 쉬고): `guru/profiles` 467 ms · `guru/similarity` 497 ms · `info/catalog` 78 ms · `sec13f/consensus` 36 ·
    `new-buys` 22 · `stock/scorecard` 50 · `snapshot/text` 111 · `sec13f/portfolio`(즐겨찾기) 27 · `guru/risk` 12 · `analytics/regime` 15 · `regime/track-record` 17. 바로 다음 호출은 모두 2~14 ms.
    계획 세션의 값(499~600 ms)과 같은 자리.
  - 검색 화면(`/search?e=us:NVDA&tab=timeline&range=30d`, CPU 4배 감속, 세 번 중앙값): DOM **12,679개**(2년이면 17,781 · 7일 9,008), 긴 작업의 50 ms 넘는 몫의 합
    모바일 208 ms · 데스크톱 683 ms, `render-profile.js`(모바일 390폭 · CPU 4배)로는 긴 작업 7개 합 869 ms · 커밋 23개. 계획 세션 때는 QA에 모은 글이 없어 DOM 828개였다.
  - 검색 피드 응답 약 200 ms의 내역(QA 수집기 안에서 다섯 번 중앙값): 모은 글 읽기 14 ms · 피드 묶음 11 ms · 사건 뉴스 47 ms(뒤 둘은 15분 출처 캐시라 평소 응답에는 안 듦) ·
    규칙 적용 29 ms · 합치기 12 ms · 같은 사건 묶기 59 ms · 본문 꼬리표 58 ms · 기간 건수 1 ms · JSON 직렬화 13 ms. 수집기 직접 196~198 ms, 백엔드 경유 198~272 ms.
  - 모바일 레이아웃 밀림(390폭, 출처 경고 요청 막음): `/s/kr/005930` 0.136 · `/search?e=…` 0.192 · `/s/us/NVDA` 0.163 · 기관 상세 0.114 · `/radar` 0.108 · `/search` **0.482** ·
    `/paper/kr/real` 0.091 · `/scorecard` 0.191 · `/markets/i/us10y` 0.061. 계획 세션과 다른 값의 까닭: `/search`(0.101 → 0.482, 데스크톱 0.004 → 0.242)와 `/search?e=…`(0.148 → 0.192)는
    씨앗으로 '최근 글'·결과 목록이 채워져서(운영에 가까운 쪽), `/scorecard`(0.071 → 0.191)는 이번에 스코어카드 응답이 식어 있어(82 ms) 뼈대가 더 오래 보인 탓으로 본다(추정 — 단계 3에서 다시 봄).
  - 백엔드 경유 hang(비운 상태, 경로마다 다시 띄움): `/api/macro/ticker` 70.07초(두 심볼 모두 — 계획 세션의 59.98초는 한 번만 다시 띄운 값) · `/api/detail/symbols` 90.11초
    (백엔드의 읽기 상한에서 끊김) · `/api/radar/ranking`(저장하지 않는 조합) 62.13초.
- 커밋: 단계 0 한 커밋(도구·씨앗·문구·기록 — 아래 '전달'에 번호). 배포 없음(QA 도구와 문서만). 시험: `node --check`·`bash -n`·`python3 -m py_compile`, 화면 묶음의 이모지 검사
  (`noEmoji.test.ts` — 스크립트·문서를 읽음)와 스크립트 시험(`node --test scripts/qa/*.test.js`)은 단계 1 끝의 전체 `make test`에 포함.

## 단계 1 — 작업 A(QA-1039)

- 범위: 지시문의 차트 시계열(`/live/ticker`)에 더해, 단계 0의 표에서 예산 + 2초를 넘고 설계 값이 문서에 없는 셋(`/live/symbols`·`/live/prices`·`/live/radar`)도 같은 방법으로(지시문 A1).
- A1 예산: 수집기 `main.py`의 네 경로를 `http.run_with_budget(http.LIVE_BUDGET_SECONDS …)`로 감쌈 — 새 장치 없음(2차의 가드 그대로, yfinance는 `app.yahoo`의 예산 세션이 같은 가드를 봄).
  남길 시간(`reserve_seconds`)은 2차가 고친 화면 조회 값(0.5초)을 그대로 타서 10초 예산에서 Yahoo로 보낸다(시험 — 먹통 프록시가 요청을 받음).
  증권사 API 세션(KIS 장중 가집계·토스 1분봉)은 그 가드 밖이라 그 대체 경로를 타는 수급 랭킹·실시간 시세는 예산을 넘겨 답할 수 있다 — 그래서 백엔드의 읽기 한도는
  차트 시계열·종목 찾기만 15초(`liveFetchClient`)로 바꾸고 그 둘은 일반 한도 그대로 둠.
- A2 짧은 기억: 수집기 `services.market.live_ticker`(화면 조회 경로에만) — 일봉 5분·분봉(`1d`·`5d`) 60초, 받지 못한 결과(빈 `points`·자리표시)는 기억하지 않음, 64 조합 상한
  (기한 지난 것부터, 그래도 넘으면 가장 먼저 끝나는 것부터), 같은 심볼·기간을 함께 물으면 한 번만 Yahoo를 부름. `collect_ticker`에 두지 않은 까닭: 정기 수집
  (`tasks/series.py`·매크로 카드·교차 검증)이 같은 함수를 써서 거기에 두면 태스크가 묵은 값을 받는다 — 결정은 ADR 0052.
- 시험: `collector/tests/test_live_ticker.py` 10 · `test_live_budget_rest.py` 4(고치기 전 예상 실패 9 · 통과 4 — 재현 커밋), 백엔드 `CollectorClientLiveFetchTimeoutTest` 3.
  재현 시험은 끝나지 않은 요청을 먹통 서버를 닫아 끝낸 뒤 정리한다(바꿔 끼운 주소가 풀린 뒤 남은 사슬이 실제 출처로 나가지 않게).
- QA 측정(`step1-live-budget.txt` — 같은 QA·같은 DB, hang은 경로마다 다시 띄움):
  - 백엔드 경유 hang: `/api/macro/ticker` 70.07 → **9.58초**(다른 심볼 9.56) · `/api/detail/symbols` 90.11 → 9.56 · `/api/radar/ranking`(저장하지 않는 조합) 62.13 → 7.21 —
    받아들임 기준(예산 + 2초 = 12초 안) 충족.
  - 수집기 직접 hang: `/live/ticker` 70.02 → 9.51 · `/live/symbols` 120초 넘음 → 9.51 · `/live/prices` 100.10 → 8.92 · `/live/radar` 62.08 → 7.15.
  - block(출처가 바로 거절): 응답 9/9가 고치기 전과 같음(시각 칸·남은 초 숫자 제외). 정상 응답은 QA에서 만들 수 없어 시험(바꿔 끼운 Yahoo)으로 봄.
- 남은 확인: 배포 뒤 운영에서 같은 `/api/macro/ticker` 경로를 여섯 번 안에서 불러 둘째부터 30 ms 이하(아래 '전달·배포').

## 단계 2 — 작업 B(QA-1040 · QA-1041 · 알림 규칙 세기)

- B1 입력 확인(코드에서 하나씩): 스타일 요약·유사도·보유 색인은 `InstitutionHistory.entries()`(기본 12곳 상수 + 즐겨찾기 표)와 `read(cik)`(기본 12곳은 q8을 `store.read` —
  낡으면 `sec_13f`를 깨움, 즐겨찾기는 q30의 앞 8분기, 없으면 q8 — 둘 다 수집 없이)만 읽는다. 교집합·공통 신규 매수도 같은 `history.read`·`history.name`뿐.
  응답에 '지금 기준' 값이 없다(`putFreshness`는 포트폴리오·위험·스코어카드에만).
- B1 결정(ADR 0052 결정 5): 응답 캐시에 **입력 규칙**을 더함 — `ComputedCache.get(key, inputs, compute)`. 입력의 판은 `InstitutionHistory.inputVersion`
  (기본 12곳 q8의 수집 시각 + 즐겨찾기 목록 + 즐겨찾기 q30·q8의 수집 시각 → SHA-256). 판이 같은 동안은 다른 저장본이 새로 쓰여도·60초가 지나도 그대로(상한 하루),
  판이 null(기본 12곳 가운데 저장본이 없음·DB 장애)이면 예전 규칙. 저장본은 기억하지 않음(결과만).
  - **수집 깨우기 유지**: 계산을 건너뛰면 `store.read`도 건너뛰므로, 수집 시각을 `StoreReader.collectedAt`로 읽어 `read`와 같은 규칙(하루보다 오래됨·수동 새로고침 기준 —
    6시간 안에 받은 것은 다시 받지 않음, 30초에 한 번, store_only·조용히 읽기는 요청 없음)으로 `sec_13f`를 요청한다.
  - **경로마다의 결정**: 입력 규칙 — `guru.profiles`·`guru.similarity`·`guru.holders.index`·`sec13f.consensus`·`sec13f.newBuys`. 예전 규칙 그대로 —
    `sec13f.portfolio`(응답에 `ageSeconds` — 60초 안에서 맞아야 함, 13F 메뉴 밖 기관의 저장본도 읽음, 식었을 때 QA 5~37 ms), `guru.risk`(가격 저장본·오늘 날짜·`ageSeconds`, 12~15 ms).
- B2(QA-1041): `InfoService.catalog`가 `collector.statusLight()`(닿는지)와 `StoreRepository.readTaskSummary()`(마지막 실행 — 수집기 표를 읽기만)로. 가벼운 보기에는 태스크 요약이 없어
  (`store.status_light` — 마지막 실행·그 상태·누락 데이터셋만) 표를 읽는 쪽을 골랐다. 표를 바로 읽으므로 사유를 `SecretRedactor`로 가림. 닿지 못하면 지금처럼 칸을 비우고 표도 읽지 않음.
- B3(기록만): `stock.scorecard`(가격 저장본 하나 + 오늘 날짜 + 응답의 `ageSeconds`)와 `analytics.regime`·`regime.track`(저장본 여럿 + 누적 시계열 표 + 오늘 날짜)은 같은 방법이
  그대로 맞지 않는다 — 신선도 칸을 기억 밖에서 다시 매기고 날짜를 판에 넣어야 하며, 식었을 때 QA 15~56 ms(운영 28~143 ms)라 이번에는 두지 않았다. 다음에 한다면 스코어카드부터.
- B4: `Sec13FFavoriteService.listEntries`의 즐겨찾기마다 세기를 `AlertStore.countInstitutionRulesByCik`(질의 하나)로 — 따로 커밋. 쓰는 곳이 없어진 `countInstitutionRules`는 뺌.
- 시험: `ComputedCacheInputRuleTest` 8 · `StoreReaderCollectedAtTest` 6 · `InstitutionHistoryInputVersionTest` 7 · `GuruStyleMemoQa1040DbTest` 3(실제 표 — 재현 커밋에서는 둘이 @Disabled) ·
  `InfoServiceTest`의 새 시험 2(재현 커밋에서는 하나가 @Disabled)와 고친 시험 1 · `Sec13FFavoriteServiceTest`·`Sec13FFavoriteStoreDbTest`(세기).
  커밋 다섯을 하나씩 내려받아 관련 시험을 일회용 postgres로 돌림(모두 통과 — `568b9ef9` 5개 가운데 2 건너뜀, `b16e759e` 12개 가운데 1 건너뜀, `8923d9cb` 183, `f4a2dab9` 27, `0699a69b` 36).
- QA 측정(`step2-computed-memo.txt` — 같은 QA·같은 DB, 고치기 전은 단계 1의 백엔드):
  - 식었을 때(입력이 그대로인 채 앞 호출에서 6분 18초 쉬고 — 교집합·공통 신규 매수는 4분 57초): `guru/profiles` 467 → **9 ms** · `guru/similarity` 497 → **4 ms**(기준 30 ms 이하) · `guru/holders?q=` 499 → 6 ·
    `sec13f/consensus` 36 → 5 · `new-buys` 22 → 5 · `info/catalog` 78 → **19 ms**(2분 넘게 쉬고 — 기준 30 ms 이하).
  - 입력이 바뀌면: 13F 저장본 하나의 수집 시각을 바꾸면 다음 호출 497 ms(다시 계산) → 4 ms, 즐겨찾기를 표에서 빼면 454 ms·줄 24 → 23, 다시 더하면 446 ms·줄 24.
    13F가 아닌 저장본을 새로 쓰면 4 ms(다시 계산하지 않음).
  - 응답: 열 경로 가운데 아홉이 고치기 전과 같음(시각 칸 제외). `info/catalog`는 두 측정 사이에 QA 태스크 둘(`equity_history`·`sec_13f`)이 한 번 더 돌아 그 두 줄만 달랐고,
    같은 순간의 수집기 전체 상태(태스크 요약)와 출처 70줄(실행 기록 있는 41줄)을 한 줄씩 대조해 다른 줄 0.
- 남은 확인: 배포 뒤 운영에서 5분 쉬었다 한 번 불러 50 ms 이하(`guru/profiles`·`guru/similarity`), `info/catalog` 한 번.

