# Local Macro Dashboard

글로벌 매크로 지표 · 연준 순유동성 · 섹터 로테이션 · CFTC COT · KRX 파생 ·
SEC 13F · 국내 수급을 **한 화면에서** 보는 개인용 대시보드입니다. 운영자 전용
🧪 모의 알고리즘 매매도 들어 있습니다 — 미국(규칙·Claude·SPY·60/40 네 계좌, $100k씩)과 한국(규칙·Claude·KODEX 200·60/40 네 계좌,
1억 원씩 — 출발일 `PAPER_KR_START_DATE`를 정하면 출발, 서버 출발은 v2 4단계 교체 뒤).
맥에서 Docker 한 줄로 띄우고, 모의 매매가 도는 운영본은 AWS의 개인용 서버(EC2 한 대, 매일 밤 KST 21:55~08:00)에 둡니다.

> 이 저장소(`My_macro_dashboard_v2`)는 2026-10-26에 `My_macro_dashboard_v1`에서 전체 이력으로 갈라져 나왔습니다 — 화면 전면 개편과
> 한국 증시 모의 매매를 여기서 합니다([v2 프로그램 계획서](docs/specs/2026-10-26-v2-program-plan.md)). **교체 전까지 AWS 운영본은 v1**이고,
> 로컬 v2는 모의 매매 정기 작업을 끈 채(`PAPER_ENABLED=false`) 돕니다. v1은 2026-10-25에 `Local_macro_dashboard_v3`에서 갈라져 나왔습니다.
> **공개 저장소입니다**(2026-10-26 사용자 확인 — 모의 매매 프롬프트·투자 OS 원문도 공개). 비밀값은 `.env`에만 둡니다.
> 같은 맥에서 v3(3000/8080/8000/5432)·v1(3001/8081/8001/5433)과 함께 띄울 수 있게 이 저장소는 **3002/8082/8002/5434**를 씁니다(`.env`의 포트 값).

만든 사람: **강진영** · <kangjy5235@gmail.com>

```
Next.js ──REST──▶ Spring Boot ──JDBC──▶ PostgreSQL ◀──적재── Collector (Python)
 화면              계산·판정              저장본                  외부 데이터 수집
```

> **이 대시보드의 원칙 하나** — 값이 없으면 없다고 말합니다. 수집에 실패해도
> 0으로 채우거나 그럴듯한 숫자를 만들지 않습니다. 그 이유와 나머지 규칙은
> [docs/PRINCIPLES.md](docs/PRINCIPLES.md)에 있습니다.

---

## 목차

1. [5분 만에 띄우기](#1-5분-만에-띄우기)
2. [무엇을 보는 화면인가](#2-무엇을-보는-화면인가)
3. [어떻게 굴러가는가](#3-어떻게-굴러가는가)
4. [개발](#4-개발)
5. [설정 (.env)](#5-설정-env)
6. [문제가 생기면](#6-문제가-생기면)
7. [데이터 출처와 신뢰도](#7-데이터-출처와-신뢰도)
8. [더 읽을 문서](#8-더-읽을-문서)

---

## 1. 5분 만에 띄우기

**필요한 것: Docker Desktop 하나.** Java·Node·Python·PostgreSQL을 맥에 설치할
필요가 없습니다 — 전부 컨테이너 안에 있습니다.

```bash
git clone https://github.com/Jinyoung-Kang/My_macro_dashboard_v2.git \
  ~/Projects/My_macro_dashboard_v2
cd ~/Projects/My_macro_dashboard_v2

make setup     # .env 생성 + 세션 서명 키 자동 생성
make up        # 전체 기동 (최초 빌드 5~10분)
make collect   # 첫 수집 — 이걸 해야 화면에 숫자가 찹니다

open http://localhost:3002
```

로컬 실행은 **로그인 없이 이 맥에서만** 열립니다 — 화면·API는 `127.0.0.1`에만 열리고, 이 맥의 브라우저는 운영자 계정으로
바로 들어갑니다(휴대폰 등 다른 기기에서는 열리지 않음, [ADR 0016](docs/adr/0016-local-no-login.md)). 로그인 화면은
AWS 개인용 서버(터널로 여는 화면, [아래](#aws-개인용-서버))에만 있습니다. 운영자 계정은 처음 기동할 때 계정이 없으면 `.env`의 `OWNER_EMAIL`과 `APP_PASSWORD`로
만듭니다. `APP_PASSWORD`가 비어 있으면 `make setup`이 무작위 값을 만들어 넣고 한 번 보여 주고, `OWNER_EMAIL`은 직접 넣어야
합니다(기본값 없음). 이 비밀번호는 로그인 모드(`LOCAL_NO_LOGIN=false`)·QA 스택·이 DB를 복원한 곳에서 씁니다.

| 주소 | 용도 |
|---|---|
| <http://localhost:3002> | 화면 |
| <http://localhost:8082/api/health> | 백엔드 상태 확인 |
| <http://localhost:8002/docs> | 수집기 API 문서 (이 맥에서만 열립니다) |

### 처음 켠 뒤 해야 할 일

`make collect`는 **5분 주기 그룹(fast)만** 받습니다. 차트가 비어 있다면 나머지를
한 번 받으세요.

```bash
make collect-all    # 전체 수집 (fast + slow + weekly, 수 분 소요)
make status         # 무엇이 들어왔는지 확인
```

### 자주 쓰는 명령

```bash
make help            # 전체 명령 목록
make update && make up   # 최신 코드 받기 → 재빌드   ⚠️ git pull 대신 이것을 쓰세요
make version         # 지금 돌고 있는 코드의 브랜치·커밋
make doctor          # 데이터가 안 보일 때 — 어디가 막혔는지 한 번에 진단
make logs S=collector # 특정 서비스 로그
make test            # 세 언어 테스트 전부
make backup          # DB 백업 → backups/
make down            # 정지
```

> **왜 `git pull`이 아니라 `make update`인가** — `git pull`은 *지금 체크아웃된
> 브랜치*만 당깁니다. 새 작업이 다른 브랜치에 있으면 아무것도 받지 않고 조용히
> 끝나고, 이어서 `make up`을 해도 새 작업이 빠진 코드가 그대로 다시 뜹니다.
> "고쳤다는 기능이 화면에 없는" 상황이 여기서 나옵니다. `make update`는 다른
> 브랜치에 새 작업이 있는지까지 확인해 알려 줍니다.
>
> 지금 화면이 어느 코드인지는 **화면 왼쪽 아래**(왼쪽 내비 맨 아래, 좁은 화면은 더보기 화면 — `main@1e4d3be`, 그 아래 줄은 그 커밋의 날짜인
> '최종 수정 2026-10-20')와 `make version`에서 확인합니다.

맥을 재부팅해도 Docker Desktop이 뜨면 컨테이너가 자동 복구됩니다
(`restart: unless-stopped`).

> 📘 Docker 설치부터의 상세 절차, 포트 변경, launchd 상주, Homebrew 네이티브
> 실행은 **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)** 에 있습니다.

---

## 2. 무엇을 보는 화면인가

화면은 **다섯 탭 + 더보기**(홈·시장·기관·한국·모의매매·더보기)입니다. 넓은 화면(1024px 이상)은 왼쪽 내비, 그보다 좁으면 아래쪽 탭 바로
탭을 옮기고, 탭 안의 화면은 상단바 아래 하위 메뉴 줄에서 고릅니다. 상단바에는 통합 검색(⌘K, 맥이 아니면 Ctrl+K — 메뉴·지표·기관·종목)과
알림 벨이 있습니다. 첫 화면(로그인 뒤 포함)은 홈 `/`입니다. 모의매매 탭과 운영자 화면 셋(데이터 저장소 상태·외부 API 연결 테스트·사용자 관리)은
운영자에게만 보입니다. 라이트·다크 두 벌이고 기본은 시스템 설정을 따릅니다 — 왼쪽 내비 아래(좁은 화면은 더보기)에서 시스템·라이트·다크를 고릅니다.

> **v2 1단계(2026-10-26)**: 새로 쓴 화면은 홈과 모의매매(미국)뿐입니다. 시장·기관·한국 탭(과 더보기의 화면)은 지금 있는 화면을 지금 경로 그대로 엽니다 —
> `/markets/…` 같은 새 경로와 지표·종목 상세 화면은 4단계입니다([UI 설계](docs/specs/2026-10-26-v2-ui-design.md)). 그래서 통합 검색에서 지표·기관·종목을
> 골라도 아직은 그 값을 고르는 화면(`/macro`·`/institutions`·`/scorecard`)으로 갑니다.

굵은 항목은 이 대시보드에만 있는 것입니다.

| 탭 | 메뉴 | 경로 | 보는 것 |
|---|---|---|---|
| 홈 | 🏠 홈 | `/` | 오늘의 국면(판정 글·신호 네 개)·모의매매 순자산(미국·한국 탭 — 네 계좌씩, 두 책 수익률은 서로 비교하지 않음, 운영자)·시장 자산 행(매크로 카드)·알림 요약·수집 상태 한 줄(운영자) |
| 시장 | 📊 거시경제 매크로 지표 | `/macro` | 환율·국채·원자재·지수, 10Y−2Y·30Y−2Y 금리차(공식 + 스크래핑 병기), 신용·변동성 리스크, 심화 지표 6종, **환율 겹쳐 보기**, **전체 원본 데이터 복사** |
| 시장 | 🏢 연준 순유동성 트래커 | `/liquidity` | WALCL − TGA − ON RRP, 구성 항목 분해, 4주/12주 모멘텀 |
| 시장 | 🔄 섹터 & 자산군 로테이션 | `/sector` | S&P 11개 섹터 + 자산군 수익률·순위·초과성과 |
| 시장 | 🔗 지표 상관관계 | `/correlation` | 지표 20종 중 둘을 골라 롤링 상관계수·산점도 |
| 시장 | 🏛️ 글로벌 투기세력 (COT) | `/cot` | CFTC 순포지션 6개 자산, **극단 포지션 이후 4·13주 수익률 백테스트** |
| 시장 | 🧭 시장 국면 판정 | `/regime` | 성장·신용 축 × 유동성 축으로 4국면 + 근거 지표, **판정 성과(과거 재현 → 4·13·26주 수익률, 표본 부족 표시)**, **판정 기록(하루 한 건, 고치지 않음)** |
| 기관 | 📑 기관 13F 포트폴리오 | `/institutions` | 기관별 분기 보유, 분기 대비 액션, 비중 히트맵 |
| 기관 | 🎯 기관 13F Money 교집합 | `/consensus` | 여러 기관 공통 보유·동시 매수/매도, 공통 신규 매수 |
| 기관 | 🧬 기관 13F 스타일·위험 | `/style` | **집중도(유효 종목 수)·회전율, 기관 간 유사도 행렬, 포트폴리오 위험(변동성·VaR·베타·추적오차)** |
| 기관 | 🩺 종목 스코어카드 | `/scorecard` | **모멘텀·변동성·낙폭·추세를 대형주 대비 백분위로** |
| 한국 | 📡 외국인/기관 수급 레이더 (KRX) | `/radar` | **시장 전체 투자자별 매매대금·기관 세부(토스 공식)**, 투자자별 순매수 상위, **종목별 수급 지속성(며칠째 순매수·연기금·외국인 보유율, 토스 공식)**, **외국인·기관 공통 순매수/순매도**, **순매수 종목의 재무·밸류에이션(DART 부채비율·증가율 + PER·PBR)**, 소스 진단 |
| 한국 | 🇰🇷 국내 파생 & 투기세력 | `/krx` | KOSPI200 선물 OI·베이시스·4대 국면·한국판 COT Index, **현물·선물 수급 동조(외국인·기관·개인·금융투자)**, **증시 규모(시가총액·거래대금, 금융위 공식)** |
| 모의매매 | 🧪 모의 알고리즘 매매(미국) | `/paper/us`(탭은 `/paper/us/<탭>`, 옛 `/paper`는 리디렉션) | **$100k 네 계좌 — 벤치마크 SPY 계좌·60/40 계좌(SPY 60% · SHY 40%), 13F 규칙 계좌(대조군), Claude 계좌(실험군) — 두 계좌는 하루 한 번 결정하고, 네 계좌 모두 같은 관측치로 모의 체결**. Claude 계좌 입력에는 미국 종목 재무(SEC XBRL, 공시일 ≤ 기준일)와 다음 10거래일의 발표·실적 일정(FRED·FOMC·yfinance — 판단 자료일 뿐 주문을 막지 않음), 직전 결정 이후(평일 24시간, 주말·휴장 뒤는 그 사이 전부)의 사건 헤드라인(RSS 제목만 — 보유·후보 종목이나 매크로 키워드에 걸린 것, 하루 최대 10건, 설정에서 끔), 재무 종목마다 최근 4분기 어닝 서프라이즈(EPS 실제치·컨센서스·서프라이즈율 — yfinance, 발표일 ≤ 기준일)도 들어감. 탭 7개: 개요(계좌 행 + 계좌 비교 표 — 계좌 행을 누르면 정의·지금 설정·구성 도넛·최근 체결을 보이는 계좌 상세) / 기관 선정(13F 공시일 기준 트랙레코드) / 보유·체결 / 결정 로그(주간 복기 소탭 — 토요일마다 Claude 계좌의 지난 4주 결정을 그 뒤 가격과 대조한 복기 메모, 프레임 수정은 제안으로만) / 프레임(투자 OS 판) / 메모 / 설정. 하위 메뉴 '미국 | 한국'으로 한국 책과 오감. 운영자 전용, v3(`Local_macro_dashboard_v3`)에는 넣지 않음([ADR 0018](docs/adr/0018-paper-trading-guardrails.md)). Claude 호출은 하루 상한(설정 `apiDailyCallCap`, 기본 20회 — 2026-10-26 v2에서 6→20, 한국 책과 함께 셈) 안에서만이고, 수동 호출(미리보기·시작·수동 결정·프레임 제안·수동 복기)은 정기 작업 몫(`apiScheduledReserve`, 기본 7)을 남긴 13회까지 |
| 모의매매 | 🧪 모의 알고리즘 매매(한국) | `/paper/kr`(탭은 `/paper/kr/<탭>`) | **1억 원 네 계좌 — KODEX 200 계좌(069500)·한국 60/40 계좌(069500 60% · 153130 40%), 수급 신호 규칙 계좌(코스피 시총 상위 100 보통주 중 외국인·기관이 함께 사는 종목, 월 1~2회 재선정 — 대조군), Claude 계좌(실험군) — 같은 날(출발일 밤 결정) 함께 출발하고, KR 거래일 밤 22:30 KST에 결정해 다음 KR 거래일 시가(KRX 시가 단일가)에 모의 체결**. 체결·평가는 토스증권 잠정값이고 금융위원회(공공데이터포털) 확정 종가가 들어오면 확정 조정 행으로 현금·평단을 맞춤(화면에 잠정·확정·실효 비용 bp·'금융위 확정 미보정'·'기업행위 확인 필요' 배지). Claude 계좌 입력은 한국 패킷(유니버스 잠정 종가·20일/5일 수급·점수, DART 재무(접수일 ≤ 기준일), 환율·시장 투자자별 매매대금, 금통위·주요 발표 일정, 한국 사건 헤드라인, 시장 KR 메모). 탭 7개: 개요(네 계좌·순자산 곡선과 노출 맞춘 참고선(계좌 아님)·출발 상태·한국 수집 상태·이 장부의 한계) / 종목 선정(재선정 유니버스·수급 신호·제외 표) / 보유·체결 / 결정 로그(여섯 게이트·기한 지남·주간 복기) / 프레임 / 메모 / 설정 — 프레임·설정은 미국과 공용(한 판·한 행). 출발일(`PAPER_KR_START_DATE`)이 비면 쉬는 사유만 보임. Claude 호출은 미국과 같은 하루 상한 안에서 셈 |
| 더보기 | 🔔 알림 | `/alerts` | 국면 전환(3일 확정)·외국인 N일 연속 순매수(시장·관심 종목)·관심 기관 13F 신규 편입을 **화면 알림함**으로. 상단바 알림 벨·브라우저 탭 제목에 읽지 않은 수 |
| 더보기 | 🤖 AI 종합 데이터 분석 | `/ai/report` | 수집 원본을 AI에 넘겨 리포트 생성 (8개 엔진 폴백 — Claude Haiku 5.5부터, 키가 없는 엔진은 건너뜀) |
| 더보기 | 🗄️ 데이터 저장소 상태 | `/status` | 태스크별 수집 결과·실패 사유·수동 재실행, **오류·경고 로그 모음(한 번에 복사, 비밀값 가림)**, **국내 공공 API 연결 진단** |
| 더보기 | 🔌 외부 API 연결 테스트 | `/connections` | AI 엔진별 호출·지연시간, 토스증권 연결 진단·조회 (버튼을 눌렀을 때만 외부 호출) |
| 더보기 | 👥 사용자 관리 · 👤 내 계정 | `/admin/users` · `/account` | (운영자) 역할·등급 지정·회원 만들기·감사 기록 / 비밀번호 변경·로그인한 기기·계정 삭제 |
| 더보기 | 더보기 화면 | `/more` | 위 메뉴 목록(보이는 것만) + 계정 영역·운영자 수동 새로고침·테마 전환·빌드 정보(좁은 화면에서는 왼쪽 내비 대신 여기) |

> `/guru`·`/ai/test`·`/toss`로 들어와도 해당 메뉴(`/style`·`/connections`)로 자동 이동합니다(`next.config.mjs`의 redirects).

### 화면을 읽을 때 알아야 할 것

- **`—`는 "데이터 없음"입니다.** 0이 아닙니다. 수집에 실패하면 이렇게 보입니다.
- **모든 숫자에 수집 시각이 붙습니다.** 오른쪽 위 배지를 보세요. 오래된 저장본이면
  경고색으로 바뀝니다.
- **모든 데이터 카드에 "출처" 줄이 있습니다.** 공식·비공식·추정·자체 계산 여부를 함께 적습니다.
- **⚠️ 표시는 추정치입니다.** 예: MOVE 지수는 실제 ICE BofA MOVE가 아니라
  `^TNX` 변동성에서 역산한 대용값입니다.
- **13F는 45일 지연된 분기말 사진**이며 미국 상장 롱 포지션만 담습니다.

---

## 3. 어떻게 굴러가는가

네 계층이 각자 한 가지만 합니다.

```
┌──────────────┐  ①화면은 계산하지 않습니다. 받아서 그립니다.
│  Frontend    │    Next.js 16 · React 19 · TypeScript · Tailwind · Recharts · Radix UI
└──────┬───────┘
       │ REST (쿠키 세션)
┌──────▼───────┐  ②모든 계산·판정이 여기 있습니다. 수익률 매트릭스, 국면 판정,
│  Backend     │    위험 지표, 교차 검증. 타입으로 고정되고 테스트가 지킵니다.
└──────┬───────┘    Java 21 · Spring Boot 4.1
       │ JDBC
┌──────▼───────┐  ③저장본(JSONB) + 누적 이력. 수집기와 백엔드가 공유하는 유일한 지점.
│  PostgreSQL  │
└──────▲───────┘
       │ 적재
┌──────┴───────┐  ④받아서 적재만 합니다. 계산하지 않습니다.
│  Collector   │    Python 3.11 · FastAPI · pandas · yfinance · pykrx
└──────────────┘
```

**왜 수집과 계산을 나눴나** — 같은 원본에서 두 결과가 갈라지는 것을 막기
위해서입니다. 수집기가 "받아서 적재", 백엔드가 "계산"으로 역할이 갈리면 화면에
보이는 숫자의 출처가 언제나 하나입니다.

### 데이터가 화면에 닿기까지

```
① 수집기 스케줄러(또는 make collect)가 외부 소스를 호출
② 결과를 snapshots 테이블에 JSONB로 저장 (실패하면 기존 저장본을 덮지 않음)
③ 화면이 백엔드에 요청
④ 백엔드가 저장본을 읽어 계산 → 신선도(수집 시각·경과)와 함께 응답
⑤ 저장본이 오래됐으면 수집기에 "다시 받아라"고 요청하되 기다리지 않음
```

⑤가 중요합니다. **화면은 수집을 기다리지 않습니다.** 오래된 값이라도 먼저 보여
주고 언제 받은 값인지 함께 적습니다. 외부 수집에 걸리는 수십 초가 화면을 여는
시간이 되지 않게 하기 위해서입니다.

> 저장 스키마와 계층별 책임은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)에
> 자세히 있습니다.

---

## 4. 개발

### 폴더 구조

```
.
├── collector/          Python · FastAPI — 외부 데이터 수집
│   ├── app/
│   │   ├── tasks/           수집 태스크(주제별 모듈)·목록(registry)·실행기(runner: 합치기·시간 상한)
│   │   ├── numbers.py       외부 응답 숫자 해석(모르는 값은 None)
│   │   ├── catalog.py       데이터셋 이름·신선도 기준 (백엔드와 공유하는 문자열)
│   │   ├── indicators.py    수집 대상 정의 (티커·FRED 시리즈·COT 자산·기관)
│   │   ├── equities.py      13F 종목명 → 티커·섹터 매핑표
│   │   ├── equities_cusip.py 13F CUSIP → 티커 매핑표 (🧪 모의 매매 트랙레코드 q30에만)
│   │   ├── store.py         PostgreSQL 적재
│   │   └── services/        소스별 수집 로직 (fred·krx·cot·sec13f·radar·…)
│   └── tests/
├── backend/            Java · Spring Boot — 계산·판정·REST API
│   └── src/main/java/com/macrodash/
│       ├── feature/         기능별 모듈 (컨트롤러 + 서비스: macro·institution·positioning·…)
│       ├── analytics/       순수 계산 (상관·국면·위험·백테스트·스코어)
│       ├── store/           저장소 접근, 데이터셋 이름, 신선도
│       └── support/         공통 도구 (JSON 읽기·파라미터·비밀값 가림)
├── frontend/           TypeScript · Next.js — 화면
│   └── src/
│       ├── app/(dashboard)/ 메뉴별 라우트(새 화면은 그리기만 — 옛 화면은 섹션 파일까지 여기, 4단계에 옮김)
│       ├── components/      shell(왼쪽 내비·하단 탭·검색·알림 벨) · screens/<탭>(홈·모의매매) · patterns(자산 행·배지·표) · charts · ui
│       ├── hooks/           useApi · useTheme · useUsdKrw · 새로고침 신호
│       └── lib/             순수 함수 — 포맷·거래소 달력·메뉴 표(nav)·검색·테마·화면 모델·타입
├── db/migrations/      스키마
├── deploy/aws/         AWS 개인용 서버의 앞단 설정(Caddyfile)
├── docs/               문서
└── scripts/            setup · update · version · doctor
    └── aws/             AWS 개인용 서버: bootstrap(첫 기동) · deploy(배포) · backup-s3(cron) · tunnel(PC의 SSM 터널) · instance(손으로 켜고 끄기)
```

### Docker 없이 개발하기

```bash
make infra            # PostgreSQL만 컨테이너로

make dev-collector    # 터미널 1 — 자동 리로드
make dev-backend      # 터미널 2
make dev-frontend     # 터미널 3 — 핫 리로드
```

### 테스트

```bash
make test              # 세 가지 전부
make test-collector    # pytest
make test-backend      # JUnit (실제 DB 사용)
make test-frontend     # 자가검증 + 훅 테스트(vitest) + 린트 + 빌드(타입 검사)
```

> ⚠️ **테스트는 전용 DB(`macrodash_test`)에서 돕니다.** 백엔드 통합 테스트는
> 시작할 때마다 `snapshots`를 비우기 때문에, 평소 쓰는 `macrodash`를 가리키면
> 수집해 둔 데이터가 사라집니다. `make test-*`가 알아서 전용 DB를 쓰지만,
> 직접 실행할 때는 `TEST_DATABASE_URL`을 확인하세요.

### 기능을 하나 붙이려면

데이터가 필요한 기능은 **네 곳을 순서대로** 건드립니다.

1. `collector/app/indicators.py` — 무엇을 받을지 정의
2. `collector/app/tasks/` — 받아서 저장하는 태스크를 주제 모듈에 추가하고 `registry.py`에 한 줄 (+ `catalog.py`에 이름)
3. `backend/.../analytics/` — 순수 계산 작성 (테스트를 여기에)
4. `backend/.../feature/<기능>/` 서비스 + 컨트롤러 — 응답 조립 + 엔드포인트
5. `frontend/src/` — 화면(라우트 `app/(dashboard)/…`, 조립 `components/screens/<탭>/`, 메뉴는 `lib/nav.ts`의 `TABS`)

**데이터셋 이름은 `catalog.py`(Python)와 `Datasets.java`(Java) 양쪽에 있고,
`DatasetsParityTest`가 두 파일을 실제로 읽어 대조합니다.** 한쪽만 고치면 빌드가
깨집니다 — "수집은 되는데 화면에 안 보이는" 버그를 막기 위한 장치입니다.

---

## 5. 설정 (.env)

`make setup`이 `.env.example`을 복사해 만듭니다. **키가 없어도 대부분 동작합니다.**

| 키 | 없으면 |
|---|---|
| `OWNER_EMAIL` | 처음 운영자 계정의 이메일. 없으면 계정을 만들지 않아 로컬 화면이 '운영자 계정이 없음' 안내를 띄움(`make doctor`가 알림) |
| `APP_PASSWORD` | 처음 운영자 계정의 비밀번호. `make setup`이 무작위로 만듭니다. 비었거나 `admin1234@`면 계정을 만들지 않음 |
| `MAIL_HOST`·`MAIL_PORT`·`MAIL_USERNAME`·`MAIL_PASSWORD` | 계정 메일(가입 인증·비밀번호 재설정). 없으면 가입·재설정만 꺼짐(운영자 로그인·나머지는 정상) |
| `AI_DAILY_LIMIT` | 유료 회원의 하루 AI 리포트 한도(기본 20). 운영자는 한도 없음, 무료 회원은 쓸 수 없음 |
| `AI_ENGINES` | 쓸 AI 엔진 ID만 쉼표로(예: `anthropic_haiku`). 비우면 키가 있는 엔진을 모두 씀(기본). 모르는 ID면 백엔드가 기동하지 않음([ADR 0014](docs/adr/0014-aws-demo-ai-report.md)). 🧪 모의 매매 Claude 계좌도 이 목록을 모델 단위로 따름 — 정하면 목록 안 Anthropic 엔진의 모델만(예: `anthropic_haiku`면 Haiku만, Sonnet 설정은 '허용 목록 밖'으로 그날 주문 없음) |
| `FRED_API_KEY` | FRED 웹 CSV로 폴백 (대부분 정상). 🧪 모의 매매 발표·실적 일정(`us_calendar`)의 FRED 발표일(CPI·PCE·고용·GDP)은 대체 경로가 없어 비고 "키 미설정"으로 표시(FOMC 상수·실적일은 그대로) |
| `SEC_USER_AGENT` | **키가 아니라 본인 이메일입니다.** 없으면 13F 수집(🧪 모의 매매 트랙레코드 포함)과 🧪 모의 매매 미국 종목 재무(`sec_fundamentals`)가 멈추고, 🧪 사건 뉴스(`news_headlines`)의 SEC 보도자료 피드(`sec_press`)도 실패로 남습니다(나머지 7개 피드는 정상) |
| `KRX_API_KEY` | KRX 선물이 KODEX 200 기반 **추정치**로 폴백 (`isEstimated` 표시) |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | 장중 수급 가집계와 교차 검증 비활성화 |
| `LS_APP_KEY` / `LS_APP_SECRET` | 수급 레이더 폴백 체인에서 LS 단계만 건너뜀 |
| `KRX_ID` / `KRX_PW` | pykrx를 비로그인으로 사용 (선택) |
| AI 키 (`NVIDIA` / `CEREBRAS` / `CLOUDFLARE`) | AI 메뉴만 비활성화. 하나만 있어도 동작 |
| `ANTHROPIC_API_KEY` | AI 리포트의 Claude 엔진을 건너뜀. 🧪 모의 매매 Claude 계좌(결정·프레임 제안·주간 복기)는 'API Key 누락'으로 실패하고 규칙 계좌·벤치마크는 그대로. Claude 계좌도 이 키를 씀(`AI_ENGINES`를 정했으면 그 목록의 모델만) |
| `PAPER_ENABLED` | 비우면 `true`. `false`면 🧪 모의 매매 정기 작업(리스크 점검·하루 한 번 결정·출발일 종가 얼리기·주간 복기)이 쉼. 화면의 수동 실행은 그대로 |
| `PAPER_KR_START_DATE` | 🧪 한국 책 출발 거래일(`yyyy-MM-dd`). 기본값 없음 — 비우면 한국 초기화·출발이 막히고 미국 책은 그대로(이미 출발한 한국 계좌의 장부·확정 조정·결정·복기는 출발일 없이도 돎). 형식이 틀리면 백엔드가 기동하지 않음(거래일 검사는 한국 초기화·출발 때) |
| `TRACK_RECORD_FETCH_BUDGET` | 🧪 13F 트랙레코드 수집(`sec_13f_track_record`)이 한 번에 새로 받는 공시 수. 비우면 400(1~2000) |
| `FUNDAMENTALS_FETCH_BUDGET` | 🧪 미국 종목 재무 수집(`sec_fundamentals`, SEC XBRL companyfacts)이 한 번에 보내는 요청(CIK) 수. 비우면 200(1~600) — 유니버스 약 570곳을 약 36시간에 한 바퀴 |
| `US_CALENDAR_EARNINGS_BUDGET` | 🧪 발표·실적 일정 수집(`us_calendar`, 1시간마다)이 한 번에 yfinance에 묻는 실적 일정 종목 수. 비우면 120(1~600) — 종목마다 24시간 캐시라 처음 약 5시간에 유니버스(ETF 제외)를 채우고 그 뒤로는 하루에 한 바퀴 |
| `EARNINGS_SURPRISE_BUDGET` | 🧪 어닝 서프라이즈 수집(`earnings_surprise`, 12시간마다)이 한 번에 yfinance에 묻는 종목 수. 비우면 100(1~600) — 유니버스(ETF 제외) 약 576종목을 약 3일에 한 바퀴(실적 발표가 나왔을 법한 종목을 먼저) |
| `TOSS_*` | 토스 연결 테스트 + 레이더의 "시장 전체·수급 지속성", 국내 파생의 "현물·선물 수급 동조" 카드가 비활성화 (나머지는 그대로) |
| `DATA_GO_KR_SERVICE_KEY` | 공공데이터포털 **일반 인증키 하나**로 특일정보·주식시세를 씁니다(서비스별 활용신청 필요). 없으면 시계는 내장 휴일 표(2025~2028)로, 공식 시세·PER·PBR은 비어 있음 |
| `DART_API_KEY` | 수급 레이더의 재무 체크만 비어 있음 |
| `LOCAL_NO_LOGIN` | 비우면 `true` — 로컬은 로그인 없이 이 맥에서 운영자로 열림. `false`면 로그인 화면(웹·QA 덧붙임은 늘 `false`로 고정, [ADR 0016](docs/adr/0016-local-no-login.md)) |
| `COOKIE_SECURE` | HTTPS로만 접속할 때 `true` (http://에서 켜면 로그인이 안 됨). `LOCAL_NO_LOGIN=false`와 함께 — 로그인 없는 로컬과 함께 켜면 백엔드가 기동하지 않음. AWS 개인용 서버는 덧붙임이 기본 `true`로 둠(터널의 `http://localhost`는 Chrome·Firefox가 받음) — 로컬 값을 서버 `.env`에 옮기지 않음 |
| `AI_TIMEOUT_SECONDS` | 엔진을 직접 고른 경우의 대기 한도 (기본 240초) |
| `AI_AUTO_ATTEMPT_SECONDS` / `AI_AUTO_BUDGET_SECONDS` | `⚡ 자동 탐색`의 엔진별·전체 시간 예산 (기본 60초 / 180초) |
| `COMPUTE_MAX_CONCURRENT` | 캐시에 없는 비싼 계산(스코어카드·기관 위험·13F 조합 등)의 동시 실행 상한. 비우거나 0이면 자동(코어 수의 절반, 최소 1). 넘친 요청은 2초 기다린 뒤 429 |

> **`SEC_USER_AGENT`는 영문 이메일이어야 합니다.** HTTP 헤더는 latin-1만 담을 수
> 있어 한글이 섞이면 요청 자체가 불가능합니다. 예시 값을 그대로 두는 것도
> 막습니다 — SEC는 연락이 닿지 않는 요청을 차단합니다.
>
> ```ini
> SEC_USER_AGENT=gildong.hong@<본인 도메인>   # ✅ 본인이 실제로 받는 영문 주소
> SEC_USER_AGENT=이메일@이메일.com        # ❌ 한글 불가
> SEC_USER_AGENT=your-name@example.com   # ❌ 예시 값
> ```

> **`.env`에 따옴표를 쓰지 마세요.** docker compose는 `KEY=VALUE`를 그대로
> 읽습니다. `KEY="값"`이면 따옴표까지 값이 됩니다.

**모든 포트(화면·API·DB·수집기)는 이 맥(127.0.0.1)에서만 열립니다.** 로컬 화면은 로그인 없이 운영자로 열리기 때문입니다
(예전 `WEB_BIND_HOST`로 다른 기기에 여는 방법은 없앴습니다). 이 맥의 다른 웹사이트가 로컬 API를 부르지 못하게, 로그인 없는
요청은 이 맥의 화면 주소에서 온 것만 받습니다 — 쿠키 없이 curl로 쓰기 요청을 보낼 때는 `Origin: http://localhost:3002`이 필요합니다.

### AWS 개인용 서버

🧪 모의 매매를 돌리려고 AWS 서울의 EC2 한 대(`my-macro-app`, t4g.medium ARM · 4 GiB)에 올립니다. DB는 로컬과 같은
Postgres 컨테이너입니다. 서버는 **매일 KST 21:55에 켜지고 08:00(토요일은 10:00)에 꺼집니다**(EventBridge Scheduler) — 미국 장·마지막 지연 봉·
06:10 백업·07:30 결정이 모두 이 안에 있습니다. 사용자는 1명(운영자)입니다. 화면은 **공개 주소**(CloudFront `https://dXXXX.cloudfront.net` —
첫 화면에서 접근 코드를 넣은 뒤 로그인, 주소와 코드는 운영자에게만)나 PC의 SSM 포트 포워딩(관리용)으로 엽니다. 서버에 들어오는 길은 CloudFront
원본용 대역 → 8301 한 줄뿐입니다(ADR 0019 결정 16). 로컬과 다른 점은 덧붙임 [compose.aws.yml](compose.aws.yml)과 [scripts/aws/](scripts/aws/)에 있고,
이유는 [ADR 0019](docs/adr/0019-aws-personal-deployment.md)에 있습니다. 월 약 $17(하루 10시간 기준).

```bash
bash scripts/aws/tunnel.sh             # PC: 서버 화면을 http://localhost:8201 로 엽니다(로그인: OWNER_EMAIL · 닫기: Ctrl-C)
bash scripts/aws/instance.sh status    # 지금 켜져 있나 — 08:00 뒤에 보려면 instance.sh start(다음 정지 일정에 다시 꺼짐)
```

새 코드를 서버에 올릴 때는 PC에서 서버 셸에 붙어(`aws ssm start-session --region ap-northeast-2 --target <AWS_INSTANCE_ID>`) 이렇게 합니다.

```bash
sudo -iu ubuntu
bash ~/My_macro_dashboard_v2/scripts/aws/deploy.sh   # main 받기 → 이미지 하나씩 빌드 → 기동 → 스키마 적용
```

- 서버에서는 `make up` 대신 `deploy.sh`를 씁니다. 4 GiB라 이미지를 하나씩 빌드하고(backend → frontend → collector), 기동 뒤에는
  `make migrate`와 같은 스키마 적용을 돌립니다(QA-016). 어느 단계든 실패하면 0이 아닌 값으로 끝납니다.
- 앞단 Caddy가 서버의 `127.0.0.1:8201` 하나만 열고 `/api/*`는 백엔드, 나머지는 화면으로 보냅니다(같은 출처, `NEXT_PUBLIC_API_BASE=/`).
  TLS는 없습니다 — 평문은 서버의 루프백과 SSM 터널(암호화) 안에서만 흐릅니다.
- 로그인 화면은 늘 거칩니다(`compose.aws.yml`이 로그인 없는 로컬 모드를 `"false"`로 고정, [ADR 0016](docs/adr/0016-local-no-login.md)).
  세션 쿠키에는 `Secure`가 붙습니다 — Chrome·Firefox는 `http://localhost`를 안전한 출처로 봐 받고, Safari는 받지 않습니다
  (Safari로 열 때만 서버 `.env`에 `COOKIE_SECURE=false`, DEVELOPMENT §7). 메일(가입·재설정)은 꺼 둡니다.
- 서버 `.env`는 로컬 `.env`에서 포트 네 줄·`COOKIE_SECURE`·`LOCAL_NO_LOGIN`·`FRONTEND_ORIGIN`·`PUBLIC_URL`·`AWS_INSTANCE_ID`를 빼고
  `COMPOSE_FILE`·`AWS_BACKUP_BUCKET`을 더한 것입니다([.env.aws.example](.env.aws.example)). 빠져야 할 이름이 있으면 `deploy.sh`가 멈춥니다
  (`COOKIE_SECURE`·`PAPER_ENABLED`는 알리고 계속 — Secure 쿠키를 받지 못하는 브라우저, 서버 정기 작업을 일부러 끈 경우의 자리).
  전환 뒤 로컬의 `PAPER_ENABLED=false`도 옮기지 않습니다(서버는 비우면 켜짐). PC의 `.env`에는 `AWS_INSTANCE_ID`(서버 인스턴스 ID)만 더합니다.
- DB는 매일 06:10 KST에 S3로 백업합니다(`scripts/aws/backup-s3.sh`, cron, 60일 보관).
- 🧪 모의 매매 정기 작업은 **서버 한 곳에서만** 돕니다. 데이터를 서버로 옮긴 뒤 로컬 v1은 `.env`에 `PAPER_ENABLED=false`를 넣고 띄웁니다
  — 두 곳이 같은 계좌를 따로 결정·체결하면 안 됩니다.
- 서버 만들기·데이터 전환·SSM 셸 절차는 [docs/DEVELOPMENT.md §7](docs/DEVELOPMENT.md#7-aws-개인용-서버)에 있습니다.
- v3에서 옮겨 온 공개 데모 배포(RDS·CloudFront·데모 열람, [ADR 0012](docs/adr/0012-aws-demo-deployment.md)~[0014](docs/adr/0014-aws-demo-ai-report.md))는
  이 저장소에서 쓰지 않습니다.

---

## 6. 문제가 생기면

**먼저 `make doctor`.** 컨테이너 → 수집기 → DB → 백엔드 → 화면 순으로 검사하고
*가장 먼저 고칠 것 한 가지*를 알려 줍니다.

### 가장 흔한 네 가지

| 증상 | 원인 / 해결 |
|---|---|
| 화면이 전부 "데이터 없음" | 수집기가 아직 안 돌았습니다. `make collect-all` |
| **고쳤다는 기능이 화면에 없음** | 그 코드로 빌드되지 않았습니다. 화면 왼쪽 아래 버전과 `make version`을 보세요. `git pull` 말고 `make update` |
| 로그인 후 401 반복 | `FRONTEND_ORIGIN`과 실제 접속 주소가 다릅니다 (`localhost`와 `127.0.0.1`은 다른 오리진) |
| **화면이 "백엔드 API에 연결하지 못했습니다"** | 백엔드 컨테이너가 뜨지 못했습니다. 흔한 원인은 `port is already allocated` — 8080을 다른 컨테이너·프로그램이 잡고 있습니다. `make up`이 기동 전에 누가 잡았는지 알려 줍니다(`bash scripts/ports.sh check`). 끄거나 `.env`의 `BACKEND_PORT`를 바꾸세요 |

### 수집이 비어 있을 때

| 사유 문구 | 해결 |
|---|---|
| `yfinance(…)가 빈 응답을 받았습니다` | yfinance가 낡았습니다. `make update && make up` |
| `CSV HTTP 403` | FRED 웹 CSV 차단. `.env`에 무료 `FRED_API_KEY` |
| `SEC_USER_AGENT가 설정되지 않았습니다` | `.env`에 본인 이메일 (키 아님) |
| `429 Too Many Requests` | Yahoo 호출 한도. 잠시 후 재시도 |
| 투자주체가 `(지원 안 함)` | Naver 페이지 폐지(HTTP 410). 외국인·기관은 정상 |

### 그 외

| 증상 | 해결 |
|---|---|
| AI 리포트가 `N초 안에 응답하지 않았습니다` | `⚡ 자동 탐색`을 고르거나 `AI_TIMEOUT_SECONDS`를 늘리세요 |
| 복사 버튼이 안 먹음 | 다른 기기에서 `http://192.168.x.x:3000`으로 열면 브라우저가 클립보드를 막습니다. 화면이 사유를 표시합니다 |
| KRX 선물이 "추정치" | `KRX_API_KEY` 미설정. KODEX 200 기반 폴백입니다 |
| 수급 레이더에 "누적 이력" 경고 | 외부 소스가 모두 실패해 저장된 이력을 보는 중입니다. **날짜**를 확인하세요 |
| 교차 검증이 "확인 못 함"만 나옴 | 시간 조건입니다. 시세 대조는 장 마감 후, 수급 대조는 정규장 중에만 가능합니다. 토스 3항목은 토스 키가 있어야 하고, 원/달러는 매크로 화면 저장본이 1시간 이내여야 합니다 |
| LS `서버에 접속하지 못했습니다` | 키 문제가 아니라 망 문제입니다 |
| LS `OAuth 토큰 발급 거절` | 이때가 키 문제입니다. LS 홈에서 "Open API" 사용등록 확인 |
| 수집기 로그 첫 줄 `KRX 로그인 실패` | pykrx가 import할 때 찍는 문구입니다. 우리 앱 오류가 아닙니다 |
| `git push`가 403 | 맥에 저장된 GitHub 토큰 문제입니다 → [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |

> 전체 증상 표와 맥 환경 문제는 [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md),
> Git 관련은 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)에 있습니다.

---

## 7. 데이터 출처와 신뢰도

공식 API와 비공식 웹 소스를 **섞어서** 씁니다. 화면의 출처 배지를 반드시
확인하세요.

| 구분 | 출처 | 신뢰도 |
|---|---|---|
| 금리·신용 스프레드·유동성·심화 지표 | FRED 공식 API | 공식 (일별/주간 확정치) |
| 환율·원자재·지수·종목 종가 | yfinance | 종목마다 0~20분 지연 (카드 배지) |
| 미국채 3M/2Y/10Y/30Y, 달러 인덱스·엔/원·코스피·닛케이·항셍 실시간 | TradingView 공개 Scanner | **비공식 참고** (못 받으면 Yahoo 값과 그 지연) |
| 국내 수급·파생 | KRX Open API · KIS · LS · pykrx · Daum | 공식 + 비공식 혼합 |
| 13F 포트폴리오 | SEC EDGAR | 공식 (분기 공시, 45일 지연) |
| CFTC COT | CFTC 공개 API | 공식 (주 1회, 화요일 기준) |
| 한국 공휴일 (KRX 휴장) | 한국천문연구원 특일정보 | 공식 (대체공휴일·선거일 포함) |
| 국내 종목 공식 시세·시가총액 | 금융위원회 주식시세정보 | 공식 (거래소 확정치, **다음 영업일 13시 이후**) |
| 국내 종목 재무 | 금융감독원 Open DART (사업보고서) | 공식 (연 1회, 직전 사업연도) |
| 🧪 미국 종목 재무 (모의 매매 Claude 계좌 패킷) | SEC EDGAR XBRL Company Facts | 공식 (10-Q·10-K·20-F 공시일 기준, 실적 보도자료 8-K 없음) |
| 🧪 미국 발표·실적 일정 (모의 매매 Claude 계좌 패킷) | FRED release/dates · 연준 FOMC 일정표(상수) · yfinance quoteSummary | 거시는 공식(FRED는 그해 12-31까지만), 실적일은 **비공식 참고** (yfinance 내부 호출, 장 구분은 발표 시각으로 추정) |
| 🧪 어닝 서프라이즈 (모의 매매 Claude 계좌 패킷) | yfinance quoteSummary `earnings` (내부 호출) | **비공식 참고** — 컨센서스는 Yahoo 집계, 한 번에 최근 4분기만(쌓아서 8분기), 추정치가 0에 가까우면 비율이 부풂(`smallBase`) |
| 🧪 사건 뉴스 헤드라인 (모의 매매 Claude 계좌 패킷) | RSS — Investing.com 넷 · 연준 · BLS 둘 · SEC (야후는 robots.txt가 막아 제외) | 제목·출처·시각만, 7일 보관. 인베스팅닷컴은 최근 10건만 줘 사이 항목을 놓칠 수 있고 이용 조건 [확인 필요] |
| **MOVE 지수** | `^TNX` 변동성 역산 | ⚠️ **추정치 — 실제 MOVE 아님** |

> 이 대시보드는 **정보 제공용**입니다. 투자 판단과 그 결과의 책임은 이용자에게
> 있습니다.

---

## 8. 더 읽을 문서

| 문서 | 내용 |
|---|---|
| [docs/PRINCIPLES.md](docs/PRINCIPLES.md) | **이 프로젝트가 지키는 규칙과 그 이유** — 새 기능을 붙이기 전에 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 계층 구조, 데이터 흐름, 저장 스키마 |
| [docs/API.md](docs/API.md) | REST 엔드포인트 전체 목록 |
| [docs/adr/](docs/adr/README.md) | 설계 결정 기록 — 기능 단위 패키지·의존 규칙, Spring Boot 4 전환, 백업·복원, 프런트엔드 층 나누기 |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | 수집 태스크 38종, 소스별 폴백 체인, 한계 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 기여 절차, 브랜치·Git 문제 해결, 테스트 상세 |
| [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) | 맥 설치·실행 상세, 포트 변경, launchd 상주 |
| [CLAUDE.md](CLAUDE.md) | Claude Code가 매 대화 시작 때 읽는 작업 규칙 요약 — 위 문서들의 핵심과 절대 규칙 |
| [docs/specs/2026-10-26-v2-program-plan.md](docs/specs/2026-10-26-v2-program-plan.md) | **v2 프로그램 계획(2026-10-26)** — 이 저장소를 `My_macro_dashboard_v2`로 갈라내 화면 전면 개편·한국 증시 모의매매를 더하고 AWS의 v1을 교체하는 순서·결정·전환 절차. 교체 전까지 v1은 그대로 운영 |

---

## 기술 스택

| 영역 | 채택 | 왜 |
|---|---|---|
| Frontend | TypeScript · React 19 · Next.js 16 · Tailwind · Recharts · Radix UI(dialog·toast·visually-hidden) | 여러 화면이 같은 패턴(자산 행·배지·표·차트)을 다시 쓰므로 공용 컴포넌트가 크게 이득. 대화상자·토스트의 포커스·키보드·ARIA는 Radix에 맡김. 라이트·다크는 CSS 변수 토큰(기본은 시스템 설정 따름) |
| Backend | Java 21 · Spring Boot 4.1 | 모든 계산을 한 계층에 모아 타입과 테스트로 고정 |
| AI | Claude API (Haiku 5.5, 공식 Java SDK) · NVIDIA · Cerebras · Cloudflare | 수집 원본으로 리포트 생성. 엔진이 실패하면 다음 엔진으로 자동 전환. 모의 매매 Claude 계좌는 같은 SDK의 구조화 출력으로 Sonnet 5.5(설정에서 Haiku 5.5) 한 모델만 부름(전환 없음) |
| Store | PostgreSQL 16 | 수집기와 API가 다른 프로세스라 파일 공유 불가. JSONB로 저장해 SQL로 질의 |
| Collector | Python 3.11 · FastAPI · pandas · yfinance · pykrx · feedparser(RSS 읽기만) | 금융 데이터 수집·파싱 라이브러리 생태계 |
| DevOps | Docker Compose · GitHub Actions · AWS(EC2 t4g · SSM Session Manager · S3 · EventBridge Scheduler) · Caddy | 네 프로세스를 한 명령으로, 세 언어 테스트를 매 푸시마다. 운영본은 인바운드 포트 없이 SSM 터널로만 여는 EC2 한 대, 밤 10시간만 켬([ADR 0019](docs/adr/0019-aws-personal-deployment.md)) |

**의도적으로 쓰지 않은 것** — Kafka/CDC(하루 수천 건 규모라 브로커가 처리할
트래픽이 없음), BigQuery/ClickHouse(전체 수십 MB), 네이티브 앱(같은 기능을 두 벌
유지해야 함), 쿠버네티스(1인용 로컬 대시보드). 필요해지면 붙일 수 있도록 경계는
열어 두었습니다.

---

## 만든 사람

**강진영** · <kangjy5235@gmail.com>

기획 · 아키텍처 설계 · 데이터 수집 · 백엔드 · 프런트엔드 · 운영까지 1인 개발했습니다.
