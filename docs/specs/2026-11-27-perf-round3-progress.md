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
