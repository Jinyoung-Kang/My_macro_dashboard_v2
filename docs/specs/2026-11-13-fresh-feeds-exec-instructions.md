# 실행 세션 지시문 — 수집 신선도 개선(VIX 실시간 · 경제지표 실제치 발표 직후 · 사건 뉴스 탄력 주기) (2026-11-13)

## 1. 역할과 목표

너는 이 프로젝트를 넘겨받은 시니어 풀스택 엔지니어야. 이 작업은 두 세션으로 나뉘어 있어. 계획 세션(2026-11-13)이 지금 구현과 외부 출처를
직접 확인해 무엇을 어떻게 바꿀지 이 지시문을 썼고, 사용자가 계획 세션의 권장안대로 진행하라고 승인했어. 이 세션은 그 계획을 실행하는
세션이야. 너는 계획 세션의 대화를 볼 수 없어. 이 지시문, 프롬프트, 저장소의 문서와 코드가 네가 아는 전부야.

목표는 모의 매매 결정·장중 판단과 운영자 화면이 쓰는 세 가지 자료를 **더 최신으로** 받되, **상대 서버에 부담을 더 주지 않고 악성 봇으로
보이지 않게** 하는 거야.

- 작업 A — VIX를 실시간 출처(TradingView `TVC:VIX`)로: 지금은 Yahoo `^VIX` 일봉(15분 지연)을 1시간마다 받음. **사전 검증을 통과했을 때만** 바꿈.
- 작업 B — 미국 경제지표 실제치를 발표 직후에: 지금은 Nasdaq 컨센서스를 동부 하루 1회, TradingView 경제 캘린더를 3~6시간에 한 번 받아,
  당일 발표치가 결정 패킷에 늦게(대개 다음 날) 들어감.
- 작업 C — 사건 뉴스 RSS(미국 8곳·한국 4곳)를 1시간 고정 주기에서 탄력 주기로: C1 조건부 요청(304), C2 피드마다 다른 간격 + 무작위
  흔들림, C3 결정·판단 직전과 지표 발표 직후에 한 번 더.

## 2. 계획 세션이 확인한 사실 (2026-11-13, 그때의 `main@b5be1c3d` 기준)

코드 위치는 파일과 심볼로 가리켜. 실행하기 전에 지금 코드에서 다시 확인해.

### 공통
- 수집 태스크 등록: `collector/app/tasks/registry.py`. 속도군 `fast`(5분)·`slow`(매시 :15 고정)·`weekly`·`session`·`polite`(비주기 —
  `collector/app/tasks/polite.py`의 `Cadence`·`scheduled`, 다음 실행 시각을 표 `fetch_schedule`(V21)에 둠, 스케줄러 틱 `main.POLITE_TICK_SECONDS` 300초 +
  지터 120초). polite 속도군과 차단 통과 수집 계층(`collector/app/fetch/`)은 서버에서만 켜짐(`POLITE_FETCH_ENABLED`).
- HTTP 공용 세션: `collector/app/http.py` — 호스트별 최소 간격 + 지터(`pace`), 403·429·봇 차단이면 그 호스트 5분 래치(`REJECT_LATCH_SECONDS`),
  5xx·408·연결 오류만 재시도, `Retry-After` 상한 5초. SEC는 `SEC_USER_AGENT`(연락처) 필수, BLS는 전용 세션(403 안내 있음).
- 모의 매매 설정은 백엔드 표 `paper_settings`(수집기는 읽기만 — 예: `collector/app/store.py`의 stopWatch 설정 읽기, `tasks/paper_stopwatch.py`).
  결정 시각은 `decisionTimeKst`·`decisionBeforeOpenMinutes`(한국은 `kr.` 접두어), 고정 장중 판단은 `intradayFixed`(개장 1시간 뒤·마감 40분 전) —
  ADR 0039. 2026-11-13 15:40 KST에 설정 v27(미국 개장 45분 전)·v28(한국 개장 120분 전)로 켜졌다고 기록돼 있어. 실제 값은 서버 DB 설정으로 확인해.

### 작업 A — VIX
- 지금: `volatility_history`(slow, 1시간)가 Yahoo `^VIX`·`^MOVE` 5년 일봉을 스냅숏 `catalog.snap_ticker_history("^VIX", "5y")`에 저장
  (`collector/app/tasks/series.py:task_volatility_history`). 백엔드는 `MacroService.volatilityEntry("^VIX")`로 위험 패널의 VIX를 만들고,
  `AnalyticsService`의 시계열 `ticker:VIX`도 같은 저장본을 씀. 모의 매매 패킷 코드에는 VIX가 없음(확인함).
- 실시간 출처: `collector/app/services/scraper.py`의 `SCRAPER_MARKETS`(TradingView Scanner `scanner.tradingview.com/global/scan`, POST, Origin·Referer)와
  매크로 카드의 실시간 대체 `collector/app/indicators.py:REALTIME_QUOTES`(응답 `update_mode`가 `streaming`인 것만 — QA-138)가 이미 있음.
- 2026-11-13 19:5x KST(미국 장 닫힘)에 공개 응답으로 확인한 `update_mode`: `TVC:VIX` = `streaming`, `CBOE:VIX` = `delayed_streaming_900`(15분),
  네이버 `.VIX` = delayTime 15. **장중에 `TVC:VIX`가 실제 VIX와 같은 값인지는 확인하지 못했어** — 그래서 작업 A는 사전 검증부터야(§4 A).

### 작업 B — 경제지표 실제치
- Nasdaq 컨센서스: `us_calendar_consensus`(slow) → 스냅숏 `calendar.us_consensus`(`collector/app/tasks/us_consensus.py`, 출처 `services/us_consensus.py`
  `api.nasdaq.com/api/calendar/economicevents`, `date=D`가 동부 D−1을 줌 — `QUERY_OFFSET_DAYS`). **같은 동부 날짜에 이미 받은 날은 다시 묻지 않아**
  (모듈 설명) — 그래서 당일 발표치는 그날 다시 받지 않음. 백엔드 미국 결정 패킷의 `1b_calendar` 컨센서스 층이 결정 순간 전에 받은 발표치를
  `actual` 열로 실음(`backend/.../feature/paper/CalendarSection.java` — 설정 `calendar.consensus`).
- 예: 미국 결정이 개장 45분 전(동부 08:45)이면 08:30 발표(CPI·고용)는 결정 15분 전에 나오는데, 지금 구조로는 그 결정 패킷에 실리지 않음.
- TradingView 경제 캘린더: `econ_calendar_tradingview`(polite, 3~6시간) → 스냅숏 `calendar.econ.tradingview`(`services/tv_calendar.py`),
  운영자 화면 전용(매크로 화면 카드 — 결정 패킷 입력이 아님). 호스트 하루 예산 `fetch/policy.py`의 `economic-calendar.tradingview.com` = 30.
- 발표 일정: `us_calendar`(FRED release dates + FOMC 상수) → `calendar.us_events`, Nasdaq 행의 시각 칸도 있음(칸 이름·형식은 확인해).

### 작업 C — 사건 뉴스 RSS
- 미국 `news_headlines`·한국 `kr_news_headlines`(둘 다 slow, 매시 :15) → `observations` `news_headline`·`kr_news_headline`(7일 보관, 제목 해시로 중복 제거)
  + 상태 스냅숏. 피드 표 `collector/app/services/news.py`의 `FEEDS`·`KR_FEEDS`, 받기는 `fetch_feed`(세션 `default`·`bls`·`sec`·`product`).
  **조건부 요청(ETag·If-Modified-Since)을 쓰지 않아** 매번 전체를 받음(확인함).
- 쓰는 곳: 미국·한국 정기 결정 패킷의 사건 섹션(`EventsSection`·`KrEventsSection`), 장중 판단 패킷의 사건 뉴스(`KrPacketBuilder.intradayEvents`,
  `PacketBuilder`), 정보 수집 화면(`InfoService`). 모두 **읽는 시각이 정해져 있어** — 그 시각의 신선도가 중요해.
- 2026-11-13 서버에서 피드마다 한 번 요청해 본 응답 헤더:

| 호스트 | ETag | Last-Modified | Cache-Control | 비고 |
|---|---|---|---|---|
| www.investing.com (4곳) | 있음 | 있음 | 없음 | Cloudflare 뒤 — 가장 조심 |
| www.federalreserve.gov | 있음 | 있음 | 없음 | |
| www.sec.gov | 있음 | 있음 | `max-age=48` | SEC 공정 접근 규칙(선언 UA) |
| www.yna.co.kr | 있음 | 있음 | 없음 | |
| www.bok.or.kr | 없음 | 없음 | `no-cache` | |
| mofe.go.kr · mods.go.kr | 없음 | 없음 | 없음 | |
| www.bls.gov (2곳) | 확인 안 함 | | | 전용 세션·UA로 확인해 |

  헤더가 있다는 것만 봤고 **실제로 304가 돌아오는지는 확인하지 않았어** — 구현 전에 서버에서 피드마다 한 번 확인해(§5 '외부 요청').

## 3. 실행 순서와 멈춤점

| 단계 | 내용 | 시작 조건 | 끝 |
|---|---|---|---|
| 1 | C1 조건부 요청 + C2 피드별 간격·흔들림 | 바로 | 구현·시험·main·CI·배포 → **관찰 시작** |
| 2 | B 경제지표 실제치 발표 직후 | 단계 1 배포 뒤 | 구현·시험·main·CI·배포 |
| 3 | C3 결정·판단 직전·발표 직후 뉴스 | 단계 1 배포 뒤 **미국·한국 각 2거래일 이상 관찰**해 304 비율·거부(403·429) 이상 없음 | 구현·시험·main·CI·배포 |
| 4 | A VIX — 사전 검증 → 통과 시 구현 | **2026-11-16(월) 미국 정규장(23:30 KST~)** 이후 | 검증 기록 → (통과) 구현·시험·main·CI·배포 |

- 단계 2는 단계 3이 쓸 '발표 시각 일정'을 만들어. 단계 3은 그것을 다시 써(같은 일을 두 번 구현하지 마).
- 시작 조건이 아직 아니면 그 단계에서 멈추고, 지금까지 한 일과 다음 단계의 시작 조건·날짜를 보고한 뒤 끝내. 사용자가 "다음 단계 진행해"라고
  하면 이어서 해. 기다리는 동안 세션 예약(ScheduleWakeup 등)을 걸지 마 — PC를 오래 켜 둬야 해서 사용자가 싫어해.
- 단계 4 검증이 통과하지 못하면 A는 구현하지 말고 결과와 근거를 보고해(지금의 Yahoo 15분 지연을 유지).

## 4. 작업별 명세

### 작업 C1 — 조건부 요청(단계 1)
- 피드마다 마지막 응답의 `ETag`·`Last-Modified`를 저장해 다음 요청에 `If-None-Match`·`If-Modified-Since`로 붙여. **재기동해도 이어지게**
  저장해(수집기가 쓰는 기존 저장 장치 — 예: 뉴스 상태 스냅숏이나 `fetch_schedule` — 를 먼저 검토하고, 새 표가 필요하면 근거를 ADR에 적고
  `db/migrations/`(다음 번호는 확인)·표 소유권 시험(`test_table_ownership`)을 같이).
- 304면 파싱하지 않고 '변경 없음'으로 기록, 직전 항목은 그대로. 상태 스냅숏에 피드별 마지막 요청 시각·마지막 변경 시각·304 횟수를 둬.
- `Cache-Control: max-age`(SEC 48초 등)가 남아 있으면 그 전에 다시 묻지 마. `Retry-After`·403·429는 기존 래치를 따르고, 그 피드의 다음 간격을
  두 배로(상한까지) 늘렸다가 성공하면 되돌려.
- 검증 값이 없는 피드(한국은행·재정경제부·국가데이터처, BLS는 확인 결과에 따라)는 전체를 받되 본문 해시가 같으면 파싱·저장을 건너뛰어도 돼.
- 세션(UA)은 피드별 지금 값을 그대로 둬. UA 돌리기·프록시·차단 우회는 하지 마.

### 작업 C2 — 피드마다 다른 간격 + 무작위 흔들림(단계 1)

| 피드 | 활발한 시간(KST) | 활발할 때 | 그 밖 |
|---|---|---|---|
| Investing.com 4곳 | 미국 21:00~07:00 | 12~20분 | 45~90분 |
| 연합뉴스 마켓+ | 한국 07:00~16:00 | 12~20분 | 45~90분 |
| 연준·BLS 2곳·SEC | — | 60~120분 | 60~120분 |
| 한국은행·재정경제부·국가데이터처 | — | 60~120분 | 60~120분 |

- 실행마다 다음 시각을 구간 안에서 무작위로 정해(polite의 `Cadence`처럼). 활발한 시간 경계는 주말·휴장일이면 '그 밖'으로.
- 하한: Investing.com은 어떤 경우에도 12분 미만으로 줄이지 마. 다른 피드도 10분 미만 금지. 같은 호스트의 피드는 한꺼번에 묻지 말고 차례로
  (사이 2~5초 + 기존 `pace`).
- 재기동 직후 모든 피드를 한꺼번에 묻지 마(다음 시각을 저장본에서 이어 받고, 없으면 흩어 정함).
- 이 수집은 polite 계층(브라우저 흉내·서버 전용)이 아니라 지금처럼 공용 세션으로 받고 **로컬에서도 돌아야 해**. 스케줄링만 비주기로
  바꿔(구현 방식 — 5분 틱에서 피드별로 때가 된 것만 받기, 새 속도군 등 — 은 네가 정하고 ADR에 이유를 적어).
- 할 일이 없던 틱의 실행 기록은 polite 속도군의 기존 관례('수집 결과 없음' + 다음 예정 시각)를 따르되, 실행 기록이 하루 수백 건 늘어나면
  기록하지 않는 쪽을 검토하고 결정을 ADR에 적어.
- 예상 요청량(계획 세션 추정): 지금 하루 약 288회(전부 전체 본문) → 약 350~450회(대부분 304). 배포 뒤 실제 값을 재서 기록해.

### 작업 B — 경제지표 실제치 발표 직후(단계 2)
- 오늘(동부) 발표가 있는 지표마다 **발표 시각 + 2~4분**(무작위)에 Nasdaq을 그 날짜 하나만 다시 물어(요청 1회), 오늘 행만 바꿔 저장해
  (다른 날짜·이어받은 값은 그대로). 실제치가 아직 비면 **+15~25분**에 한 번 더. 같은 발표 시각의 여러 지표는 한 번에. Nasdaq 추가 요청은
  하루 8회 이내.
- 발표 시각은 Nasdaq 행의 시각 칸과 `calendar.us_events`(FRED·FOMC)에서 정해. 칸 이름과 형식(동부 기준 여부)을 저장본에서 먼저 확인해.
  날짜 어긋남 검사(목요일 실업수당 — 모듈 설명 '실패 규칙')는 그대로 지켜.
- TradingView 경제 캘린더(운영자 화면)도 같은 일정으로 발표 직후 한 번 — polite 계층의 호스트 예산(30/일)·닫힘·포기 규칙 안에서, 추가는 하루 6회 이내.
- 받아들임 기준: 시험에서 가짜 시계로 동부 08:30 CPI가 있는 날 08:32~08:34에 오늘 날짜 요청이 나가고, 08:45(개장 45분 전 결정) 전에 저장본의
  그 행에 `actual`이 있음. 결정 패킷 고정본(`backend/src/test/resources/paper/golden/`)은 바뀌지 않아야 해(패킷 모양은 그대로 — 실릴 때가 빨라질 뿐).

### 작업 C3 — 결정·판단 직전과 발표 직후 뉴스(단계 3)
- 다음 소비 시각마다 그 시장 피드를 **T − 5~3분**에 한 번 받아: 미국·한국 정기 결정(`decisionBeforeOpenMinutes`가 1 이상이면 개장 N분 전, 0이면
  `decisionTimeKst`), 켜져 있으면 고정 장중 판단(`intradayFixed` — 개장 1시간 뒤·마감 40분 전). 설정은 `paper_settings`를 읽기만, 휴장일은 기존
  달력(수집기의 한국 휴장 표·미국 달력)을 써.
- 미국 지표 발표 직후(작업 B의 일정) BLS 2곳·연준 피드를 + 1~3분에 한 번.
- 이 추가 요청도 C1(조건부 요청)·C2의 하한(같은 피드 10분, Investing 12분 안이면 건너뜀)을 지켜. 피드마다 추가는 하루 6회 이내.

### 작업 A — VIX(단계 4)
- **사전 검증**(2026-11-16 월 미국 정규장 이후, 서버에서): 1분마다 한 번, 40분 이상 TradingView Scanner에 `TVC:VIX`와 `CBOE:VIX`를 한 요청으로
  물어(`close`·`update_mode`·시각) 기록해. 기준: `CBOE:VIX`가 15분 지연이므로 `TVC:VIX(t)`와 `CBOE:VIX(t+15분)`의 차이가 0.02포인트 이내인 표본이
  90% 이상이고, 그날 `TVC:VIX` 마감 값이 다음 날 Yahoo `^VIX` 일봉 종가와 같아야 해. 결과(표본 수·일치율·차이 분포)를 진행 기록에 남겨.
  통과하지 못하면 작업 A는 하지 마.
- 통과하면: 수집기 5분 주기(TradingView 배치 — `scraper_markets`나 `REALTIME_QUOTES`와 같은 길)에 `TVC:VIX`를 더하고, 위험 패널의 '지금 VIX'는
  실시간 값(지연 배지 '실시간', 받은 시각)을 먼저 쓰고 못 받으면 지금처럼 Yahoo 값(15분 지연)으로. 5년 시계열(`volatility_history`)은 그대로.
  응답 모양이 바뀌면 `docs/API.md`와 화면 시험을 같이 고쳐.
- VIX가 쓰이는 다른 곳(AI 리포트 스냅숏 글 `SnapshotTextService`, 분석 시계열)을 찾아 어디에 실시간 값을 쓸지 ADR에 적어. 모르는 값을 지어내지
  마(실시간을 못 받으면 Yahoo 값과 그 지연 배지).

## 5. 지켜야 할 규칙

원문은 `CLAUDE.md`·`docs/DEVELOPMENT.md`·`docs/PRINCIPLES.md`·`docs/adr/README.md` — 먼저 읽어. 이 지시문과 충돌하면 프로젝트 규칙이 우선이고,
무엇을 따랐는지 진행 기록에 적어.

- 작업 브랜치 `claude/fresh-feeds-2026-11`(단계마다 같은 브랜치를 이어 써도 되고, 단계별로 나눠도 됨). 커밋 `type(scope): 요약`(요약은 한국어) +
  `Co-Authored-By` 줄. 옮기는 커밋과 고치는 커밋을 나눠. 모든 커밋이 `make test`를 통과해야 해.
- 이 작업 중 기존 결함을 찾으면 `QA-###`(다음 번호는 `docs/qa/2026-11-12-defects.md` 끝과 `git log`에서 확인 — 2026-11-13 기준 QA-418) — 재현 시험
  `test(QA-###)`(strict xfail) → `fix(QA-###)` 두 커밋.
- 설계 결정은 새 ADR 하나로(다음 번호 확인 — 2026-11-13 기준 0040). 단계마다 그 ADR에 절을 더해.
- 이모지 금지(코드·주석·문서·스크립트 출력·커밋 메시지). 날짜는 KST(`Kst.today()`), 없는 숫자는 `null`.
- 테이블마다 쓰는 프로세스는 하나(ADR 0008) — 수집기는 `paper_settings`를 읽기만. 데이터셋 이름을 바꾸거나 더하면 `catalog.py`와 `Datasets.java` 둘 다.
- 끈 판의 프롬프트·스키마·패킷 고정본은 바이트까지 그대로. 이 작업은 프롬프트·스키마·패킷 모양을 바꾸지 않아(실리는 자료가 더 최신이 될 뿐).
  고정본이 바뀌어야 한다면 멈추고 물어봐.
- 실제 계좌(토스·ISA) 자료는 어디에도 넣지 마. 실제 매매 켜기류 API를 부르지 마.
- **시험은 외부에 요청하지 마** — 목·고정본·루프백 임시 서버만. 수집기 시험이 기본 `DATABASE_URL`(5432 — 이 PC에서 v3 스택 자리)에 붙지 않는지 확인해.
- **외부 요청**(검증용)은 서버(Vultr — `ssh ubuntu@my-macro-app`, Tailscale)에서 최소한으로만: 304 확인은 피드마다 한두 번, VIX 검증은 1분에 한 번.
  이 PC에서 차단 통과 수집 출처에 요청하지 마. 요청 결과에 비밀값이 있으면 옮기지 마.
- 상대 부담 원칙(이 작업의 핵심): 조건부 요청, 서버 지시(`Cache-Control`·`Retry-After`) 존중, 같은 신원(UA) 유지, 하한 간격, 호스트별 차례 요청,
  거부되면 느려짐. '사람처럼 보이기' 위한 장치(UA 돌리기·프록시·헤더 위장 추가)는 넣지 마 — 무작위 흔들림은 부하를 흩기 위한 것이야.

## 6. 검증 수단과 기준선

| 묶음 | 명령 | 기준선(`main@b5be1c3d`, 2026-11-13) |
|---|---|---|
| 수집기 | `make test-collector`(ruff + pytest) | 2412 통과 · 36 건너뜀 · 약 640초 |
| 백엔드 | `make test-backend`(JDK 25) | 3287 통과, 실패 0 |
| 화면 | `make test-frontend` | vitest 157파일 2173 통과, lint·build 통과 |
| 전체 | `make test`(CI와 같은 명령) | 통과 |
| CI | push 뒤 6개 job | 6/6 성공(run 43397218474) |

- 시험은 `macrodash_test`만 써(`make test-*`가 맞춰 줌). postgres가 없으면 `make infra`. 건너뛰는 36개는 이 PC에 `psql`이 없어서야(CI에서는 돔).
- 시작할 때 기준선을 다시 재서 다르면 원인을 진행 기록에 적어.
- CI와 같은 JDK 21로 백엔드를 재는 방법은 `CLAUDE.md` '이 환경의 함정'.

## 7. 전달과 배포

- 단계마다: 작업 브랜치 → `make test` 통과 → 본체 폴더 `main`에 fast-forward → `git push origin main <브랜치>` → CI 6/6 확인 → 서버 배포.
  CI가 GitHub 쪽 사정으로 취소되면 그 job만 다시 돌리고 코드 실패와 구분해 보고해.
- **배포는 이 작업에서 승인돼 있어**(프롬프트 E-2). 서버에서 `bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh`. 배포하면 앱 컨테이너가 1~2분
  다시 만들어지니(앱 코드가 그대로여도 — 2026-11-12 실측) **매매·결정 시각을 피해**:
  - 피할 때(KST, 평일 기준 — 설정 값으로 다시 확인): 한국 정규장 09:00~15:30(실제 매매 창 08:45~15:35는 `deploy.sh`가 막음), 한국 결정(개장 120분 전 = 07:00 전후),
    한국 고정 장중 판단(10:00·14:50 전후), 미국 결정(개장 45분 전 = 22:45 전후), 미국 정규장 23:30~06:00, 미국 고정 장중 판단(00:30·05:20 전후),
    마감 브리핑(한국 16:00·미국 06:30 전후), 일요일 주간 복기(21:00·22:00), 백업(08:00·일 23:00), 재부팅 점검(16:10).
  - 권하는 창: 평일 16:30~22:00, 토요일, 일요일 20:30 전.
- 배포 뒤 확인: 컨테이너 6개 정상, `make status`, 수집 실행 기록에서 새 동작(304 비율·다음 예정 시각·거부 0), 백엔드 ERROR 0. 확인한 것과 못 한 것을 구분해 보고.
- 돌고 있는 코드를 바꾼 단계는 보고에 배포 여부를 적어.

## 8. 기록과 보고

- 진행 기록: `docs/specs/2026-11-13-fresh-feeds-progress.md`(새 파일) — 단계마다 한 일·커밋·시험 결과·배포 시각·관찰 값(304 비율, 하루 요청 수,
  거부 수)·남은 일. 요약으로, 코드는 옮겨 적지 말고 파일:심볼로.
- ADR(0040 예정): 문제, 선택한 방법, 버린 대안, 상대 부담 원칙, 지키는 방법(시험 이름). 단계마다 절을 더해.
- `docs/DATA_SOURCES.md`(§1 태스크 표의 주기 문구, §2·매크로 카드 지연 표, 사건 뉴스 절), 사용자에게 보이는 동작이 바뀌면 `README.md`, API 응답이 바뀌면 `docs/API.md`.
- 프로젝트 메모리(`~/.claude/projects/-home-jykang-Projects-My-macro-dashboard-v2/memory/`)에 진행 상태를 한 파일로 남기고 `MEMORY.md`에 한 줄.
- 단계를 끝낼 때마다 사용자에게 한국어로 보고: 한 일, 커밋 번호, 시험·CI 결과, 배포 여부와 시각, 관찰 값, 다음 단계와 시작 조건(날짜). 확인한 사실과 추정을 구분해.

## 9. 멈추고 물어볼 때

- 결정 패킷·프롬프트·스키마 고정본이 바뀌어야 할 때
- 새 의존성(패키지)이 필요할 때(이유를 먼저 설명)
- 304가 거의 오지 않거나(조건부 요청이 무시됨) 배포 뒤 어느 호스트에서든 403·429·차단 페이지가 늘 때 — 그 피드의 주기를 지금(1시간)으로 되돌리고 물어봐
- VIX 검증 결과가 기준에 걸치는 애매한 경우
- 이 지시문과 지금 코드가 크게 달라 계획대로 할 수 없을 때
