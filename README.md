# Local Macro Dashboard

글로벌 매크로 지표 · 연준 순유동성 · 섹터 로테이션 · CFTC COT · KRX 파생 ·
SEC 13F · 국내 수급을 **한 화면에서** 보는 개인용 대시보드입니다. 운영자 전용
모의 알고리즘 매매도 들어 있습니다 — 미국(규칙·Claude 계좌1·SPY·60/40 네 계좌 + 체결 시점 실험 Claude 계좌2 — 장중 확인 최대 한 번(MINUTE·HOURLY), $100k씩)과 한국(규칙·Claude·KODEX 200·60/40 네 계좌,
1억 원씩 — 출발일 `PAPER_KR_START_DATE`를 정하면 출발, 서버는 2026-10-30 출발).
체결 시점은 설정으로 넓힐 수 있습니다([ADR 0027](docs/adr/0027-free-fill-timing.md)) — 네 Claude 계좌는 계좌별 스위치(`claude.freeTiming` 등, 기본 꺼짐)를 켜면
다음 세션의 분 단위 지정 시각·종가 주문과 장중 판단(Claude가 시각을 고름)을 쓰고, 규칙 계좌는 `rules.timing`·`kr.rules.timing`으로 체결 시각을 정합니다(기본은 지금 그대로).
[ADR 0031](docs/adr/0031-open-offset-window-intraday-budget.md)부터 장중 체결 창은 모든 계좌가 정규장 개장 10분 뒤 ~ 마감 전(미국 09:40~15:54 ET, 한국 09:10~15:19)이고, 켠 판 메뉴에는 시가가 없으며,
장중 판단은 세션마다 계좌별 최대 3번(세션 중간 보장 1번·급변 사건이 앞당김 — 설정)입니다. 장중 스탑 감시([ADR 0032](docs/adr/0032-paper-intraday-stop-watch.md) — `stopWatch.mode`·`kr.stopWatch.mode`, 기본 꺼짐)를 켜면
보유 종목을 정규장 5분마다 보고 트레일링 스탑선 아래가 두 번 이어지면 그 세션 안에 팝니다.
운영 서버에서는 운영자가 화면에서 켜면 토스증권 실제 계좌의 원화 자산 전부가 고른 한국 모의 책(켜기 창 기본은 규칙 계좌 — Claude 계좌1·2도 고를 수 있음)을 따라 실제로 매매합니다([ADR 0028](docs/adr/0028-real-trade-mirror.md) —
기본 꺼짐, 서버 스위치 둘 + 화면 스위치, 켜기는 확인 글자와 운영자 비밀번호, 끄기는 언제나 즉시). 따라 하는 책이 개장 10분 뒤 지정 시각으로 체결하는 날은 그 시각 시장가로 맞추고,
그 책의 장중 스탑도 같은 길로 따라 팝니다([ADR 0033](docs/adr/0033-real-isa-open-offset-and-stops.md)). 모의 책 자체는 지금처럼 주문을 내지 않습니다.
맥에서 Docker 한 줄로 띄우고, 모의 매매가 도는 운영본은 Vultr 서울의 서버 한 대(24시간, 접속은 Tailscale)에 둡니다(2026-11-03 02:30 KST에 AWS EC2에서 옮김 — ADR 0023).

> 이 저장소(`My_macro_dashboard_v2`)는 2026-10-26에 `My_macro_dashboard_v1`에서 전체 이력으로 갈라져 나왔습니다 — 화면 전면 개편과
> 한국 증시 모의 매매를 여기서 합니다([v2 프로그램 계획서](docs/specs/2026-10-26-v2-program-plan.md)). 운영본은 2026-10-29부터 v2(지금은 Vultr 서버)이고,
> 로컬 v2는 모의 매매 정기 작업을 끈 채(`PAPER_ENABLED=false`) 돕니다. v1은 2026-10-25에 `Local_macro_dashboard_v3`에서 갈라져 나왔습니다.
> **공개 저장소입니다**(2026-10-26 사용자 확인 — 모의 매매 프롬프트·투자 OS 원문도 공개). 비밀값은 `.env`에만 둡니다.
> 같은 맥에서 v3(3000/8080/8000/5432)·v1(3001/8081/8001/5433)과 함께 띄울 수 있게 이 저장소는 **3002/8082/8002/5434**를 씁니다(`.env`의 포트 값).

만든 사람: **강진영** · <kangjy5235@gmail.com>

```
Next.js ──REST──► Spring Boot ──JDBC──► PostgreSQL ◄──적재── Collector (Python)
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

make setup     # .env 생성 + 수집기 내부 토큰·운영자 비밀번호 자동 생성
make up        # 전체 기동 (최초 빌드 5~10분)
make collect   # 첫 수집 — 이걸 해야 화면에 숫자가 찹니다

open http://localhost:3002
```

로컬 실행은 **로그인 없이 이 맥에서만** 열립니다 — 화면·API는 `127.0.0.1`에만 열리고, 이 맥의 브라우저는 운영자 계정으로
바로 들어갑니다(휴대폰 등 다른 기기에서는 열리지 않음, [ADR 0016](docs/adr/0016-local-no-login.md)). 로그인 화면은
서버([아래](#vultr-서버-운영본) — 운영자의 Tailscale 신원이면 로그인 없이 운영자)와 QA 스택에만 있습니다. 운영자 계정은 처음 기동할 때 계정이 없으면 `.env`의 `OWNER_EMAIL`과 `APP_PASSWORD`로
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
make update && make up   # 최신 코드 받기 → 재빌드   (git pull 대신 이것을 쓰세요)
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

> Docker 설치부터의 상세 절차, 포트 변경, launchd 상주, Homebrew 네이티브
> 실행은 **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)** 에 있습니다.

---

## 2. 무엇을 보는 화면인가

화면은 **다섯 탭 + 더보기**(홈·시장·기관·한국·모의매매·더보기)입니다. 넓은 화면(1024px 이상)은 왼쪽 내비, 그보다 좁으면 아래쪽 탭 바로
탭을 옮기고, 탭 안의 화면은 상단바 아래 하위 메뉴 줄에서 고릅니다. 상단바에는 통합 검색(⌘K, 맥이 아니면 Ctrl+K — 메뉴·지표·기관·종목, 고르면 상세 화면),
장 상태 칩 둘(KOSPI·NASDAQ — 거래 중·마감·휴장과 시각, 좁은 화면은 둘째 줄)과 알림 벨이 있습니다. 첫 화면(로그인 뒤 포함)은 홈 `/`입니다. 모의매매 탭과 운영자 화면 셋(데이터 저장소 상태·외부 API 연결 테스트·사용자 관리)은
운영자에게만 보입니다. 라이트·다크 두 벌이고 기본은 시스템 설정을 따릅니다 — 왼쪽 내비 아래(좁은 화면은 더보기)에서 시스템·라이트·다크를 고릅니다.
겉모양은 Coinbase식(2026-11 개편 — 흰/거의 검은 바탕, 알약 단추, 큰 히어로 숫자, 자산 행)이고, 강조 파랑은 누를 수 있는 것에만 씁니다 — 상승은 빨강·하락은 파랑
그대로이고 값·표·차트에는 강조 파랑을 쓰지 않습니다. 화면 문구에는 이모지 대신 아이콘과 글을 씁니다([명세](docs/specs/2026-10-31-v2-coinbase-ui.md)).

> **v2 1단계(2026-10-26)**: 새로 쓴 화면은 홈과 모의매매(미국)뿐입니다. 시장·기관·한국 탭(과 더보기의 화면)은 지금 있는 화면을 지금 경로 그대로 엽니다 —
> 옛 화면을 `/markets/…`로 옮기는 일은 4단계입니다([UI 설계](docs/specs/2026-10-26-v2-ui-design.md)). 검색 상세 화면(지표·종목·기관)은 2026-11-01에 먼저 열어,
> 통합 검색에서 지표·기관·종목을 고르면 그 상세 화면으로 갑니다([명세](docs/specs/2026-11-01-search-detail.md)).

굵은 항목은 이 대시보드에만 있는 것입니다.

| 탭 | 메뉴 | 경로 | 보는 것 |
|---|---|---|---|
| 홈 | 홈 | `/` | 오늘의 국면(판정 글·신호 네 개)·모의매매 순자산(미국·한국 탭 — 미국 다섯·한국 네 계좌, 히어로는 각 시장의 기본 Claude 계좌, 두 책 수익률은 서로 비교하지 않음, 운영자)·시장 자산 행(매크로 카드)·알림 요약·수집 상태 한 줄(운영자) |
| 시장 | 거시경제 매크로 지표 | `/macro` | 환율·국채·원자재·지수, 10Y−2Y·30Y−2Y 금리차(공식 + 스크래핑 병기), 신용·변동성 리스크, 심화 지표 6종, **환율 겹쳐 보기**, **전체 원본 데이터 복사** |
| 시장 | 연준 순유동성 트래커 | `/liquidity` | WALCL − TGA − ON RRP, 구성 항목 분해, 4주/12주 모멘텀 |
| 시장 | 섹터 & 자산군 로테이션 | `/sector` | S&P 11개 섹터 + 자산군 수익률·순위·초과성과 |
| 시장 | 지표 상관관계 | `/correlation` | 지표 20종 중 둘을 골라 롤링 상관계수·산점도 |
| 시장 | 글로벌 투기세력 (COT) | `/cot` | CFTC 순포지션 6개 자산, **극단 포지션 이후 4·13주 수익률 백테스트** |
| 시장 | 지표·종목 상세(검색) | `/markets/i/<카드 키>` · `/s/us/<Yahoo 심볼>` · `/s/kr/<6자리 코드>` | **Google Finance·Yahoo Finance식 한 화면** — 시세 히어로(전일 대비·출처 배지·차트 1개월~5년, 문지르면 그 날 값)·핵심 지표·회사 개요·애널리스트 의견·증권사 리포트(국내)·13F 보유 기관(미국 주식)·주요 뉴스(원문 링크)·**AI 요약(근거 번호 → 출처 링크, 유료)**·다른 곳에서 보기(Yahoo·Google Finance·Investing.com·네이버·SEC·DART). 미국·해외는 Yahoo, 국내는 네이버 증권, 뉴스 검색은 구글 뉴스 — 볼 때만 조회하고 저장하지 않음 |
| 시장 | 시장 국면 판정 | `/regime` | 성장·신용 축 × 유동성 축으로 4국면 + 근거 지표, **판정 성과(과거 재현 → 4·13·26주 수익률, 표본 부족 표시)**, **판정 기록(하루 한 건, 고치지 않음)** |
| 기관 | 기관 13F 포트폴리오 | `/institutions` | 기관별 분기 보유, 분기 대비 액션, 비중 히트맵 |
| 기관 | 기관 상세(검색) | `/institutions/<CIK>` | 13F 보고 평가액과 분기 추이·상위 보유 종목(비중·지난 분기 대비)·기관 소개·뉴스(영문 이름 검색)·AI 요약·SEC EDGAR 링크 |
| 기관 | 기관 13F Money 교집합 | `/consensus` | 여러 기관 공통 보유·동시 매수/매도, 공통 신규 매수 |
| 기관 | 기관 13F 스타일·위험 | `/style` | **집중도(유효 종목 수)·회전율, 기관 간 유사도 행렬, 포트폴리오 위험(변동성·VaR·베타·추적오차)** |
| 기관 | 종목 스코어카드 | `/scorecard` | **모멘텀·변동성·낙폭·추세를 대형주 대비 백분위로** |
| 한국 | 외국인/기관 수급 레이더 (KRX) | `/radar` | **시장 전체 투자자별 매매대금·기관 세부(토스 공식)**, 투자자별 순매수 상위, **종목별 수급 지속성(며칠째 순매수·연기금·외국인 보유율, 토스 공식)**, **외국인·기관 공통 순매수/순매도**, **순매수 종목의 재무·밸류에이션(DART 부채비율·증가율 + PER·PBR)**, 소스 진단 |
| 한국 | 국내 파생 & 투기세력 | `/krx` | KOSPI200 선물 OI·베이시스·4대 국면·한국판 COT Index, **현물·선물 수급 동조(외국인·기관·개인·금융투자)**, **증시 규모(시가총액·거래대금, 금융위 공식)** |
| 모의매매 | 모의 알고리즘 매매(미국) | `/paper/us`(탭은 `/paper/us/<탭>`, 옛 `/paper`는 리디렉션) | **$100k 네 계좌 — 벤치마크 SPY 계좌·60/40 계좌(SPY 60% · SHY 40%), 13F 규칙 계좌(대조군), Claude 계좌1(실험군) — 두 계좌는 하루 한 번 결정하고, 네 계좌 모두 같은 관측치로 모의 체결**. 계좌1은 설정 `claude.checkpoint`를 켜면 다음 세션 장중(뉴욕 `claude.checkpointAtEt`, 기본 12:00 뒤 첫 시간별 관측치)에 같은 패킷으로 한 번 더 결정(2026-11-02 — 장중 확인 세션당 한 번). 다섯째 **Claude 계좌2**(체결 시점 실험 — [ADR 0022](docs/adr/0022-us-claude-book2-timing.md))는 계좌1과 같은 입력·프레임·한도로 계좌1 바로 뒤에 결정하고 주문마다 체결 시점(다음 세션 시가·10:00~15:00 ET 매시·종가 — Yahoo 1분봉 `paper_bars_us`)을 스스로 골라, 늦게(설정 `claude2.enabled`) 앞으로 체결로 출발 — 설정 `claude2.checkpoints`를 켜면 아침 결정이 다음 세션 장중 확인 최대 한 번(10:00~15:00 ET 30분 단위, 자료는 감시 1분봉 `MINUTE` 또는 전 종목 시간별 `HOURLY` — 둘 다 지연 자료)을 요청하고, 그 확인은 그대로 두거나 기준 시각이 아직 오지 않은 대기 주문만 새 주문(장중 시장가 포함)으로 대신함. 개요의 '체결 시점 실험'이 계좌2가 고른 시점의 체결(M1 — 주 판정)과 같은 주문을 시점마다 체결했다면의 계좌1식 대비 bp를 보임. Claude 계좌 입력에는 미국 종목 재무(SEC XBRL, 공시일 ≤ 기준일)와 다음 10거래일의 발표·실적 일정(FRED·FOMC·yfinance — 판단 자료일 뿐 주문을 막지 않음), 직전 결정 이후(평일 24시간, 주말·휴장 뒤는 그 사이 전부)의 사건 헤드라인(RSS 제목만 — 보유·후보 종목이나 매크로 키워드에 걸린 것, 하루 최대 10건, 설정에서 끔), 재무 종목마다 최근 4분기 어닝 서프라이즈(EPS 실제치·컨센서스·서프라이즈율 — yfinance, 발표일 ≤ 기준일)도 들어감. 탭 8개: 개요(맨 위 히어로 — 고른 계좌의 지금 값과 그 곡선(기간 알약·문지르기) · 계좌 행 · 장중 시세(추정) · 순자산 곡선 · 계좌 비교 표 — 지금 값은 정규장이면 보유를 장중 1분봉으로 다시 평가한 표시 전용 추정이고 '장중 추정 HH:MM'·'장부'·'MM-DD 잠정/확정'으로 단계를 적음, 그날 순자산 줄이 생기기 전이면 곡선 끝에 오늘 추정 점의 점선 꼬리, 히어로 제목 줄 오른쪽 고르기 상자나 계좌 행으로 히어로의 계좌를 바꾸고, 계좌 행을 누르면 정의·지금 설정·구성 도넛·최근 체결을 보이는 계좌 상세가 열림) / 기관 선정(13F 공시일 기준 트랙레코드) / 보유·체결 / 결정 로그(주간 복기 소탭 — 토요일마다 Claude 계좌의 지난 4주 결정을 그 뒤 가격과 대조한 복기 메모, 프레임 수정은 제안으로만) / 프레임(투자 OS 판) / 메모 / 설정 / 실제 계좌. **실제 계좌 탭**(`/paper/us/real`, [ADR 0025](docs/adr/0025-toss-real-account-readonly.md))은 모의 장부와 별개로 운영자의 토스증권 실제 계좌 가운데 달러 쪽(미국 주식 보유·달러 매수 가능 금액·주문 내역)을 읽기만 함 — 주문 기능 없음, 저장하지 않음, 운영 서버에서만 켬(`TOSS_ACCOUNT_ENABLED` — 로컬은 꺼짐 안내만), 장부·순자산·Claude 패킷·알림과 섞지 않음. 하위 메뉴 '미국 | 한국'으로 한국 책과 오감. 운영자 전용, v3(`Local_macro_dashboard_v3`)에는 넣지 않음([ADR 0018](docs/adr/0018-paper-trading-guardrails.md)). Claude 호출은 하루 상한(설정 `apiDailyCallCap`, 기본 30회 — 2026-10-26 v2에서 6→20, 10-29 기본 30, 운영 값은 설정 화면, 한국 책과 함께 셈) 안에서만이고, 수동 호출(미리보기·시작·수동 결정·프레임 제안·수동 복기)은 정기 작업 몫(`apiScheduledReserve`, 기본 7)을 남긴 문턱까지(기본 30 − 7 = 23회, 운영 값은 상한 − 정기 몫) |
| 모의매매 | 모의 알고리즘 매매(한국) | `/paper/kr`(탭은 `/paper/kr/<탭>`) | **1억 원 네 계좌 — KODEX 200 계좌(069500)·한국 60/40 계좌(069500 60% · 153130 40%), 수급 신호 규칙 계좌(코스피 시총 상위 100 보통주 중 외국인·기관이 함께 사는 종목, 월 1~2회 재선정 — 대조군), Claude 계좌1(실험군) — 같은 날(출발일 밤 결정) 함께 출발하고, KR 거래일 밤 22:30 KST에 결정해 다음 KR 거래일에 모의 체결**. 체결 시점은 규칙 계좌가 `kr.rules.timing`(기본 시가 — KRX 시가 단일가, `AT_MINUTE`면 개장 10분 뒤 지정 시각 `kr.rules.timingAtKst`), Claude 계좌가 자유 시점 판 스위치(`kr.claude.freeTiming`·`kr.claude2.freeTiming` — 켜면 지정 시각·종가와 장중 판단, 켠 판 메뉴에 시가 없음 — ADR 0027·0031)를 따름. 트레일링 스탑은 `kr.stopWatch.mode`를 켜면 정규장 5분 감시가 그 세션 안에 팔고(감시가 덮지 못한 종목만 밤에 감지해 다음 거래일 첫 분에 팖 — ADR 0032), 끄면 밤에 감지해 다음 거래일 시가에 팖. 다섯째 **한국 Claude 계좌2**(2026-11-02 — 계좌1과 같은 자료·한도에 투자 성향 `kr.claude2.riskProfile`(기본 공격투자형)을 더해 계좌1 바로 뒤에 따로 결정, 계좌1 출발 패킷으로 출발일 종가 출발. 단계 2a(2026-11-02)부터 주문마다 체결 시점 메뉴 — 다음 KR 거래일 시가·매시 10:00~15:00 KST·종가, 매시·종가는 목표 세션 토스 1분봉 `paper.kr.timed`로 체결 — 와 고른 이유를 냄. 단계 2b(2026-11-02)부터 밤 결정이 다음 거래일 장중 확인 한 번(10:00~15:00 KST 30분 단위·감시 1~10종목)을 요청할 수 있고, 그 시각 뒤 한 번 받은 토스 1분봉 `paper.watch.kr`로 한 번 더 판단해 그대로 두거나 기준 시각이 아직 오지 않은 주문만 장중 시장가 `MARKET`·남은 매시·종가로 바꿈 — 설정 `kr.claude2.checkpoints`로 끔). 단계 2c(2026-11-02)부터 개요의 '체결 시점 실험'이 한국 계좌2가 고른 시점의 체결(M1)과 계좌1·2 주문을 매시·종가로 체결했다면의 값을 계좌1식(다음 세션 시가 — 토스 1분봉 반사실) 대비 bp로 보임(판정 문턱은 미국과 같은 사전 등록). 2026-11-02에 한국 네 계좌와 미국 계좌2는 체결 전 출발 주문을 출발일(10-30) 종가 사후 체결로 바꿔 다시 출발(`restart-at-start-close` — 한국은 토스증권 종가). 체결·평가는 토스증권 잠정값이고 금융위원회(공공데이터포털) 확정 종가가 들어오면 확정 조정 행으로 현금·평단을 맞춤(화면에 잠정·확정·실효 비용 bp·'금융위 확정 미보정'·'기업행위 확인 필요' 배지). Claude 계좌 입력은 한국 패킷(유니버스 잠정 종가·20일/5일 수급·점수, DART 재무(접수일 ≤ 기준일), 환율·시장 투자자별 매매대금, 금통위·주요 발표 일정, 한국 사건 헤드라인, 시장 KR 메모). 탭 9개: 개요(미국과 같은 히어로·계좌 행·장중 시세·지금 값, 네 계좌·순자산 곡선과 노출 맞춘 참고선(계좌 아님)·출발 상태·한국 수집 상태·체결 시점 실험·이 장부의 한계) / 종목 선정(재선정 유니버스·수급 신호·제외 표) / 보유·체결 / 결정 로그(여섯 게이트·기한 지남·주간 복기) / 프레임 / 메모 / 설정 / 실제 계좌 / ISA 계좌(아래 줄) — 프레임·설정은 미국과 공용(한 판·한 행). 실제 계좌 탭(`/paper/kr/real`)은 토스증권 실제 계좌의 원화 쪽(국내 주식 보유·원화 매수 가능 금액·주문 내역)을 미국 화면과 같은 규칙으로 읽음(운영자·서버에서만, 모의 장부와 별개 — ADR 0025). 그 탭 맨 위 **'실제 매매' 칸**(같은 켜기/끄기 단추가 계좌 요약 '다시 읽기' 옆에도)에서 운영자가 켜면 실제 계좌의 원화 자산 전부(원화 매수 가능 금액 + 국내 보유, 서버 안전 상한까지)가 고른 한국 책(규칙 계좌·Claude 계좌1·Claude 계좌2, 기본 규칙 계좌)을 따라 함 — 책이 시가로 체결하는 날은 시가 단일가에 책의 시가 뒤 예상 비중으로, 개장 10분 뒤 지정 시각으로 체결하는 날은 그 시각(09:10~09:13) 시장가로 그 시각까지의 예상 비중으로 보유를 맞추고(책에 없는 국내 주식은 팖), 그 책의 장중 스탑도 같은 길로 따라 팖([ADR 0033](docs/adr/0033-real-isa-open-offset-and-stops.md)), 장중 시점 주문(지정 시각·장중 시장가·종가)은 그 기준 시각에 차이만 시장가로([ADR 0028](docs/adr/0028-real-trade-mirror.md)·[명세](docs/specs/2026-11-06-real-trade-mirror.md) — 서버 스위치 둘(`TOSS_TRADING_ENABLED`·`REAL_TRADE_ENABLED`)과 화면 스위치가 모두 켜져야 주문, 켜기·방식 바꾸기·멈춤 해제는 확인 글자 + 운영자 비밀번호, 끄기는 언제나 즉시, 손실 한도(기본 15%)는 새 매수만 멈추고 모르는 결과·같은 오류 반복·회전율 초과 등은 이상 멈춤, 텔레그램은 건수·상태만). 실제 주문 기록은 저장함(`real_trade_*` — 멱등·감사). 미국 탭의 실제 매매는 준비 중. 출발일(`PAPER_KR_START_DATE`)이 비면 쉬는 사유만 보임. Claude 호출은 미국과 같은 하루 상한 안에서 셈. 서버에서는 두 책의 체결(계좌·장부 처리마다 한 통 — 매도·매수 줄과 합계, 2026-11-07)·결정마다(요약·새 주문)·결정 없는 주문(스탑 등, 같은 묶음마다 한 통)을 텔레그램으로 알림(설정 `notify.telegram`, 서버 `.env`의 `TELEGRAM_*` — S3 백업 실패 알림과 같은 봇(QA-199)) |
| 모의매매 | ISA 계좌(한국) | `/paper/kr/isa`(한국 탭 줄 '실제 계좌' 옆 — 미국 탭 줄에는 없음) | **이 프로젝트와 연결하지 않은 다른 증권사 계좌를 한국 규칙 계좌 메커니즘으로 — 시스템은 잔고와 다음 매매 지시만, 매매는 운영자가 직접**([ADR 0034](docs/adr/0034-isa-balance.md)). 시작할 때 총평가금액과 종목·수량·매입 금액을 넣고, 잔고의 평가액·평가손익·수수료·세금을 자동 계산합니다. 규칙 계좌의 밤 결정 뒤 그 비중에 맞출 종목·방향·수량을 계산해 화면과 텔레그램(개장 전 08:00, 확인하지 않았으면 장 중반·마감 30분 전 각 한 번 — 종목 코드·이름·수량만, 금액 없음)으로 알립니다. 지시의 '확인'을 누르면 그 순간의 실시간 가격으로 잔고에 바로 반영하고, 실제 체결과 다르면 잔고에서 종목·수량·가격을 고칩니다. 증권사로 주문을 보내지 않습니다 |
| 정보 수집 | 정보 수집 | `/info/<분류>`(사이드바 모의매매와 더보기 사이 — 휴대폰은 더보기 맨 위, 옛 `/paper/info`는 리디렉션) | **수집기가 받는 모든 출처(태스크 63개 + 보류 1)의 자료·상태를 큰 분류로**([ADR 0035](docs/adr/0035-info-collection.md)·[ADR 0036](docs/adr/0036-info-hub-krx-packet.md)). 분류: 개요(분류별 정상·주의·위험 수, 끊긴 출처, 최근 글) / 뉴스·글(해외 투자·경제 블로그 14곳 — RSS 피드 본문 우선·없을 때만 글 페이지, waedge 시황·거장 글 본문과 거장 견해, 사건 뉴스 RSS 미국·한국 — 원문 링크·펼치면 본문·검색) / 국내 시장·수급(KRX 정보데이터시스템 — 계정 로그인으로 거래일 저녁 한 번: 여섯 투자주체 순매수·순매도 상위, 투자자별 거래실적, 외국인 보유 비중, 공매도 거래·잔고 — 와 네이버 매매동향·매매상위, 장중 추정 순위의 금액은 '—') / 해외 시장·거시 / 기관·공시 / 모의매매 입력(출처 카드 — 링크·기관·접근 방식·마지막 실행·다음 실행·데이터 화면) / 출처 상태(전 출처 한 표, 분류·상태로 거름) / 정보(메커니즘)(차단 통과 수집의 스위치·간격·물러남·호스트별 하루 예산·다음 실행, 끊김 알림 기준, 패킷 활용 — 수집기 코드의 실제 값). 긴 목록은 10줄씩 쪽을 나누고 맨 위로 단추. 차단 통과 수집(블로그·waedge·네이버·KRX·TradingView 캘린더)은 운영 서버에서만(`POLITE_FETCH_ENABLED` — 로컬은 꺼짐, 이 PC의 IP로 받지 않음), 서버 IP가 막히면 그 출처만 잠시 멈추고 텔레그램과 운영자 화면 위 안내 띠로 알림(형식 바뀜·오래 못 받음도). 수집 글(블로그·waedge)의 제목과 앞부분은 Claude 모의매매 패킷에 참고 자료로 들어감(섹션 `11c_reading`, 설정 `info.packet`·`kr.info.packet` 기본 켬). saveticker 뉴스는 서버 IP가 막혀 보류. 운영자 전용 |
| 더보기 | 알림 | `/alerts` | 국면 전환(3일 확정)·외국인 N일 연속 순매수(시장·관심 종목)·관심 기관 13F 신규 편입을 **화면 알림함**으로. 상단바 알림 벨·브라우저 탭 제목에 읽지 않은 수 |
| 더보기 | AI 종합 데이터 분석 | `/ai/report` | 수집 원본을 AI에 넘겨 리포트 생성 (8개 엔진 폴백 — Claude Haiku 5.5부터, 키가 없는 엔진은 건너뜀) |
| 더보기 | 데이터 저장소 상태 | `/status` | 태스크별 수집 결과·실패 사유·수동 재실행, **오류·경고 로그 모음(한 번에 복사, 비밀값 가림)**, **국내 공공 API 연결 진단** |
| 더보기 | 외부 API 연결 테스트 | `/connections` | AI 엔진별 호출·지연시간, 토스증권 연결 진단·조회 (버튼을 눌렀을 때만 외부 호출) |
| 더보기 | 사용자 관리 · 내 계정 | `/admin/users` · `/account` | (운영자) 역할·등급 지정·회원 만들기·감사 기록 / 비밀번호 변경·로그인한 기기·계정 삭제 |
| 더보기 | 더보기 화면 | `/more` | 위 메뉴 목록(보이는 것만) + 계정 영역·운영자 수동 새로고침·테마 전환·빌드 정보(좁은 화면에서는 왼쪽 내비 대신 여기) |

> `/guru`·`/ai/test`·`/toss`로 들어와도 해당 메뉴(`/style`·`/connections`)로 자동 이동합니다(`next.config.mjs`의 redirects).

### 화면을 읽을 때 알아야 할 것

- **`—`는 "데이터 없음"입니다.** 0이 아닙니다. 수집에 실패하면 이렇게 보입니다.
- **모든 숫자에 수집 시각이 붙습니다.** 오른쪽 위 배지를 보세요. 오래된 저장본이면
  경고색으로 바뀝니다.
- **모든 데이터 카드에 "출처" 줄이 있습니다.** 공식·비공식·추정·자체 계산 여부를 함께 적습니다.
- **'추정' 배지는 추정치입니다.** 예: MOVE 지수는 실제 ICE BofA MOVE가 아니라
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
│  Collector   │    Python 3.11 · FastAPI · pandas · yfinance · feedparser
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

**밖으로 나가는 쓰기는 하나뿐입니다** — 실제 매매([ADR 0028](docs/adr/0028-real-trade-mirror.md), 운영 서버에서만).
백엔드 정기 작업이 모의 책(읽기)과 토스에서 새로 읽은 실제 보유로 보낼 수량을 정하고, 주문 행을 먼저 DB(`real_trade_*`)에 쓴 뒤
수집기의 전용 쓰기 세션으로 토스에 보냅니다. 수집기는 백엔드 값을 믿지 않고 창·한도를 한 번 더 확인합니다. 그 밖의 토스 호출은 모두 읽기입니다.

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
│   │   ├── equities_cusip.py 13F CUSIP → 티커 매핑표 (모의 매매 트랙레코드 q30에만)
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
│       ├── components/      shell(왼쪽 내비·하단 탭·검색·알림 벨) · screens/<탭>(홈·모의매매·검색 상세) · patterns(자산 행·배지·표) · charts · ui
│       ├── hooks/           useApi · useTheme · useUsdKrw · 새로고침 신호
│       └── lib/             순수 함수 — 포맷·거래소 달력·메뉴 표(nav)·검색·테마·화면 모델·타입
├── db/migrations/      스키마
├── deploy/vultr/      Vultr 서버의 앞단 설정(Caddyfile)
├── docs/               문서
└── scripts/            setup · update · version · doctor
    └── vultr/           Vultr 서버: bootstrap(첫 기동) · tailscale-up · deploy(배포) · backup-s3(cron) · instance·firewall-pc-ip(PC)
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

> 주의: **테스트는 전용 DB(`macrodash_test`)에서 돕니다.** 백엔드 통합 테스트는
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
| `AI_ENGINES` | 쓸 AI 엔진 ID만 쉼표로(예: `anthropic_haiku`). 비우면 키가 있는 엔진을 모두 씀(기본). 모르는 ID면 백엔드가 기동하지 않음([ADR 0014](docs/adr/0014-aws-demo-ai-report.md)). 모의 매매 Claude 계좌도 이 목록을 모델 단위로 따름 — 정하면 목록 안 Anthropic 엔진의 모델만(예: `anthropic_haiku`면 Haiku만, Sonnet 설정은 '허용 목록 밖'으로 그날 주문 없음) |
| `FRED_API_KEY` | FRED 웹 CSV로 폴백 (대부분 정상). 모의 매매 발표·실적 일정(`us_calendar`)의 FRED 발표일(CPI·PCE·고용·GDP)은 대체 경로가 없어 비고 "키 미설정"으로 표시(FOMC 상수·실적일은 그대로) |
| `SEC_USER_AGENT` | **키가 아니라 본인 이메일입니다.** 없으면 13F 수집(모의 매매 트랙레코드 포함)과 모의 매매 미국 종목 재무(`sec_fundamentals`)가 멈추고, 사건 뉴스(`news_headlines`)의 SEC 보도자료 피드(`sec_press`)도 실패로 남습니다(나머지 7개 피드는 정상) |
| `KRX_API_KEY` | KRX 선물이 KODEX 200 기반 **추정치**로 폴백 (`isEstimated` 표시) |
| `KRX_ID` / `KRX_PW` | KRX 정보데이터시스템 계정. 운영 서버의 정보 수집 태스크 `info_krx_daily`만 씀(로컬은 차단 통과 수집이 꺼져 쓰지 않음 — 서버 `.env`에도 두 줄). 없으면 그 태스크가 실패로 남고 정보 수집 화면의 KRX 표와 수급 레이더의 KRX 단계가 비어 레이더는 토스·누적 이력으로 넘어감([ADR 0036](docs/adr/0036-info-hub-krx-packet.md)) |
| `SAVETICKER_ID` / `SAVETICKER_PW` | 보류 — 지금은 아무 코드도 읽지 않음(saveticker가 서버 IP를 막음, ADR 0036) |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | 장중 수급 가집계와 교차 검증 비활성화 |
| AI 키 (`NVIDIA` / `CEREBRAS` / `CLOUDFLARE`) | AI 메뉴만 비활성화. 하나만 있어도 동작 |
| `ANTHROPIC_API_KEY` | AI 리포트의 Claude 엔진을 건너뜀. 모의 매매 Claude 계좌(결정·프레임 제안·주간 복기)는 'API Key 누락'으로 실패하고 규칙 계좌·벤치마크는 그대로. Claude 계좌도 이 키를 씀(`AI_ENGINES`를 정했으면 그 목록의 모델만) |
| `PAPER_ENABLED` | 비우면 `true`. `false`면 모의 매매 정기 작업(리스크 점검·하루 한 번 결정·출발일 종가 얼리기·주간 복기)이 쉼. 화면의 수동 실행은 그대로. 네이티브 `make dev-backend`는 `true`일 때만 켜고 비우거나 없으면 끔 |
| `PAPER_KR_START_DATE` | 한국 책 출발 거래일(`yyyy-MM-dd`). 기본값 없음 — 비우면 한국 초기화·출발이 막히고 미국 책은 그대로(이미 출발한 한국 계좌의 장부·확정 조정·결정·복기는 출발일 없이도 돎). 형식이 틀리면 백엔드가 기동하지 않음(거래일 검사는 한국 초기화·출발 때) |
| `TRACK_RECORD_FETCH_BUDGET` | 13F 트랙레코드 수집(`sec_13f_track_record`)이 한 번에 새로 받는 공시 수. 비우면 400(1~2000) |
| `FUNDAMENTALS_FETCH_BUDGET` | 미국 종목 재무 수집(`sec_fundamentals`, SEC XBRL companyfacts)이 한 번에 보내는 요청(CIK) 수. 비우면 200(1~600) — 유니버스 약 570곳을 약 36시간에 한 바퀴 |
| `US_CALENDAR_EARNINGS_BUDGET` | 발표·실적 일정 수집(`us_calendar`, 1시간마다)이 한 번에 yfinance에 묻는 실적 일정 종목 수. 비우면 120(1~600) — 종목마다 24시간 캐시라 처음 약 5시간에 유니버스(ETF 제외)를 채우고 그 뒤로는 하루에 한 바퀴 |
| `EARNINGS_SURPRISE_BUDGET` | 어닝 서프라이즈 수집(`earnings_surprise`, 12시간마다)이 한 번에 yfinance에 묻는 종목 수. 비우면 100(1~600) — 유니버스(ETF 제외) 약 576종목을 약 3일에 한 바퀴(실적 발표가 나왔을 법한 종목을 먼저) |
| `TOSS_*` | 토스 연결 테스트 + 레이더의 "시장 전체·수급 지속성", 국내 파생의 "현물·선물 수급 동조" 카드가 비활성화되고, 한국 모의 책의 토스 태스크(관측치·수급·이력·1분봉 — `kr_paper_quotes`·`kr_paper_flows`·`kr_paper_price_history`·`kr_paper_timed`·`paper_watch_kr`·`paper_live_kr`)도 돌지 않아 한국 책 장부가 새 관측치를 받지 못함. 서버의 실제 계좌 탭은 키 미설정(`NOT_CONFIGURED`) 안내만(나머지 메뉴는 그대로) |
| `TOSS_ACCOUNT_ENABLED` | 비우면 꺼짐. 운영 서버 `.env`에서 `true`일 때만 모의매매(한국·미국) 화면의 '실제 계좌' 탭이 토스증권 실제 계좌를 읽기 전용으로 보임([ADR 0025](docs/adr/0025-toss-real-account-readonly.md) — 주문 기능 없음, 저장하지 않음). 로컬 compose는 `"false"`로 고정해 `.env`에 적어도 쓰이지 않음(토큰은 키 하나에 1개라 로컬이 부르면 서버의 토큰을 무효로 만들고, 토스 허용 IP는 서버). 서비스 토큰(`COLLECTOR_API_TOKEN`) 없이 뜬 수집기에서도 꺼짐. 실제 매매(아래 `TOSS_TRADING_ENABLED`)도 이것이 켜져 있어야 켜짐 |
| `POLITE_FETCH_ENABLED` | 비우면 서버에서 켜짐. 차단 통과 수집(polite 속도군 — TradingView 경제 캘린더·정보 수집 19개 태스크(KRX 정보데이터시스템 포함), [ADR 0035](docs/adr/0035-info-collection.md)·[0036](docs/adr/0036-info-hub-krx-packet.md))을 운영 서버에서만 돌림 — 로컬·QA compose는 `"false"`로 고정해 이 PC의 IP로 받지 않음. 서버 `.env`에 `false`를 적으면 그 수집만 멈춤. 같은 서버 전용 줄 `BROWSER_PRESS_CHECKBOX`(비우면 켜짐)는 브라우저 계층이 사람 확인의 입력 없는 체크박스만 한 번 누르는 것을 끌 때 `false` |
| `TOSS_TRADING_ENABLED`·`REAL_TRADE_ENABLED` | 비우면 꺼짐. 실제 매매([ADR 0028](docs/adr/0028-real-trade-mirror.md))의 서버 스위치 둘 — 수집기 주문 경로(`TOSS_ACCOUNT_ENABLED`도 켜져 있고 서비스 토큰이 있을 때만)와 백엔드 정기 작업. 운영 서버 `.env`에서 둘 다 `true`이고 화면에서 운영자가 켰을 때만 주문이 나감. 로컬·QA compose는 `"false"`로 고정해 `.env`에 적어도 쓰이지 않음 |
| `TOSS_TRADING_MAX_ORDER_KRW`·`TOSS_TRADING_MAX_ORDERS_PER_DAY`·`TOSS_TRADING_MAX_BUY_KRW_PER_DAY`·`TOSS_TRADING_MAX_EQUITY_KRW` | 실제 매매의 한도(1건 금액·하루 건수·하루 매수 금액·운용 평가액 상한). 하나라도 없거나 정수가 아니거나 범위 밖이면 수집기가 매매를 끔. 운영 서버 `.env`에만 — 로컬·QA 수집기에는 넘기지 않음([.env.vultr.example](.env.vultr.example)) |
| `BROWSER_FETCH_URL`·`BROWSER_FETCH_TOKEN` | 비우면 꺼짐. 운영 서버 `.env`에 둘 다 있을 때만 차단 통과 수집 계층이 브라우저 컨테이너(계층 2)를 부릅니다([ADR 0026](docs/adr/0026-polite-fetch-layers.md)). 로컬 compose는 빈 값 고정 |
| `DATA_GO_KR_SERVICE_KEY` | 공공데이터포털 **일반 인증키 하나**로 특일정보·주식시세를 씁니다(서비스별 활용신청 필요). 없으면 시계는 내장 휴일 표(2025~2028)로, 공식 시세·PER·PBR은 비어 있음 |
| `DART_API_KEY` | 수급 레이더의 재무 체크만 비어 있음 |
| `LOCAL_NO_LOGIN` | 비우면 `true` — 로컬은 로그인 없이 이 맥에서 운영자로 열림. `false`면 로그인 화면(웹·QA 덧붙임은 늘 `false`로 고정, [ADR 0016](docs/adr/0016-local-no-login.md)) |
| `COOKIE_SECURE` | HTTPS로만 접속할 때 `true` (http://에서 켜면 로그인이 안 됨). `LOCAL_NO_LOGIN=false`와 함께 — 로그인 없는 로컬과 함께 켜면 백엔드가 기동하지 않음. Vultr 서버는 덧붙임이 기본 `true`로 둠(ts.net 주소는 HTTPS, 비상용 `http://localhost`는 Chrome·Firefox가 받음) — 로컬 값을 서버 `.env`에 옮기지 않음 |
| `AI_TIMEOUT_SECONDS` | 엔진을 직접 고른 경우의 대기 한도 (기본 240초) |
| `AI_AUTO_ATTEMPT_SECONDS` / `AI_AUTO_BUDGET_SECONDS` | `자동 탐색`의 엔진별·전체 시간 예산 (기본 60초 / 180초) |
| `COMPUTE_MAX_CONCURRENT` | 캐시에 없는 비싼 계산(스코어카드·기관 위험·13F 조합 등)의 동시 실행 상한. 비우거나 0이면 자동(코어 수의 절반, 최소 1). 넘친 요청은 2초 기다린 뒤 429 |

> **`SEC_USER_AGENT`는 영문 이메일이어야 합니다.** HTTP 헤더는 latin-1만 담을 수
> 있어 한글이 섞이면 요청 자체가 불가능합니다. 예시 값을 그대로 두는 것도
> 막습니다 — SEC는 연락이 닿지 않는 요청을 차단합니다.
>
> ```ini
> SEC_USER_AGENT=gildong.hong@<본인 도메인>   # ✓ 본인이 실제로 받는 영문 주소
> SEC_USER_AGENT=이메일@이메일.com        # ✗ 한글 불가
> SEC_USER_AGENT=your-name@example.com   # ✗ 예시 값
> ```

> **`.env`에 따옴표를 쓰지 마세요.** docker compose는 `KEY=VALUE`를 그대로
> 읽습니다. `KEY="값"`이면 따옴표까지 값이 됩니다.

**모든 포트(화면·API·DB·수집기)는 이 맥(127.0.0.1)에서만 열립니다.** 로컬 화면은 로그인 없이 운영자로 열리기 때문입니다
(예전 `WEB_BIND_HOST`로 다른 기기에 여는 방법은 없앴습니다). 이 맥의 다른 웹사이트가 로컬 API를 부르지 못하게, 로그인 없는
요청은 이 맥의 화면 주소에서 온 것만 받습니다 — 쿠키 없이 curl로 쓰기 요청을 보낼 때는 `Origin: http://localhost:3002`이 필요합니다.

### Vultr 서버 (운영본)

운영 서버는 Vultr 서울의 한 대(`my-macro-app`, vhf-2c-4gb · 2 vCPU · 4 GB, 24시간, 월 $24)입니다([ADR 0023](docs/adr/0023-vultr-deployment.md)).
2026-11-03 02:30 KST에 AWS EC2([ADR 0019](docs/adr/0019-aws-personal-deployment.md))에서 옮겼고(컷오버), 모의 매매 정기 작업은 여기서만 돕니다.
AWS의 서버·공개 주소 자원은 같은 날 지웠습니다(남은 것은 S3 백업 버킷).

- 접속은 **Tailscale 하나**입니다. 서버·PC·휴대폰이 같은 tailnet에 있고 화면은 `https://my-macro-app.<tailnet>.ts.net`(Tailscale이 받는 인증서) — 서버의
  `tailscale serve`가 루프백의 caddy(`127.0.0.1:8201`)로 넘깁니다. 공개 인터넷에 열린 TCP 포트·잠금화면은 없고, 로그인은 그대로입니다.
- 로컬과 다른 점은 덧붙임 [compose.vultr.yml](compose.vultr.yml)과 [scripts/vultr/](scripts/vultr/)에 있습니다(옛 AWS 덧붙임에서 갈라냄 — gate·공개 리스너 없음).

```bash
bash scripts/vultr/instance.sh status      # PC: 서버 상태·주소(Vultr API, .env의 VULTR_API_KEY·VULTR_INSTANCE_ID)
bash scripts/vultr/firewall-pc-ip.sh       # PC 공인 IP가 바뀌었을 때 비상용 SSH(22) 규칙을 지금 IP로
ssh ubuntu@my-macro-app                    # 서버 셸(Tailscale SSH) — 그 안에서 bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh
```

- 서버 `.env`는 로컬 `.env`에서 포트 네 줄·`COOKIE_SECURE`·`LOCAL_NO_LOGIN`·`FRONTEND_ORIGIN`·`PUBLIC_URL`·`AWS_INSTANCE_ID`·`VULTR_*`·`TAILSCALE_*`·`TAILNET_DOMAIN`·`TOSS_ACCOUNT_ENABLED`·`TOSS_TRADING_*`·`REAL_TRADE_ENABLED`를 빼고
  `COMPOSE_FILE`·`AWS_BACKUP_BUCKET`·`PUBLIC_ORIGIN`(Tailscale 주소)·`PAPER_KR_START_DATE`(한국 출발일)·`TAILNET_OWNER_LOGIN`(그 Tailscale 사용자는 로그인 없이 운영자 —
  [ADR 0023](docs/adr/0023-vultr-deployment.md) 결정 10, 비면 로그인 화면)·`TOSS_ACCOUNT_ENABLED`(켤 때만 `true` — 토스 실제 계좌 읽기 전용 조회, [ADR 0025](docs/adr/0025-toss-real-account-readonly.md))·`BROWSER_FETCH_URL`·`BROWSER_FETCH_TOKEN`(켤 때만 — 브라우저 컨테이너, [ADR 0026](docs/adr/0026-polite-fetch-layers.md))·`TOSS_TRADING_ENABLED`·`REAL_TRADE_ENABLED`·한도 네 줄(켤 때만 — 실제 매매, [ADR 0028](docs/adr/0028-real-trade-mirror.md), 값은 켜기 전에 사용자 확인)을 더한 것입니다([.env.vultr.example](.env.vultr.example)).
  PC의 `.env`에는 `VULTR_API_KEY`·`VULTR_INSTANCE_ID`·`VULTR_SERVER_IP`·`VULTR_FIREWALL_GROUP_ID`·`TAILSCALE_AUTH_KEY`·`TAILNET_DOMAIN`을 더합니다.
- DB는 매일 08:00 KST(미국 결정 뒤 — 2026-11-07 배포 전까지는 06:45)와 일요일 23:00 KST에 S3 백업 버킷의 `db/vultr/`로 백업합니다(`scripts/vultr/backup-s3.sh`, cron, 60일 보관).
- 서버 만들기·`.env` 전달·배포·백업 절차는 [docs/DEVELOPMENT.md §7](docs/DEVELOPMENT.md#7-vultr-서버)에 있습니다. 실제 매매를 켜는 절차·켜기 전 점검표·**비상 끄기 순서**도 같은 절('실제 매매 켜기')입니다.
  실제 매매가 꺼져 있지 않으면(켜짐·끄는 중·이상 멈춤 — 끄는 중·이상 멈춤도 미체결 취소를 보냄) `deploy.sh`는 한국 거래 창(평일 08:45~15:35 KST — 정규장 전체, 장 시간 변경일은 개장 −15분 ~ 마감 +5분, 설정을 읽지 못하면 08:45~16:35)에 멈추고, `make restore`는 복원한 백업에서 꺼지지 않은 실제 매매를 이상 멈춤(`restored`)과 ISA 계좌의 오늘까지 장중 스탑 지시를 건너뜀(`restored`)으로 두며 복원 전 DB에서 켜져 있었는데 백업에 그 상태·주문이 없으면 경고합니다(토스 앱에서 미체결 직접 확인).
  서버 `.env`를 다시 전달해도 서버 전용 줄(토스 키·텔레그램·실제 매매 스위치·한도 등)은 서버에서 그대로 이어 붙이고, 백엔드·수집기는 다시 만들 때 보내던 주문이 끝나도록 90초·30초까지 기다립니다.
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
| AI 리포트가 `N초 안에 응답하지 않았습니다` | `자동 탐색`을 고르거나 `AI_TIMEOUT_SECONDS`를 늘리세요 |
| 복사 버튼이 안 먹음 | 다른 기기에서 `http://192.168.x.x:3000`으로 열면 브라우저가 클립보드를 막습니다. 화면이 사유를 표시합니다 |
| KRX 선물이 "추정치" | `KRX_API_KEY` 미설정. KODEX 200 기반 폴백입니다 |
| 수급 레이더에 "누적 이력" 경고 | 외부 소스가 모두 실패해 저장된 이력을 보는 중입니다. **날짜**를 확인하세요 |
| 교차 검증이 "확인 못 함"만 나옴 | 시간 조건입니다. 시세 대조는 장 마감 후, 수급 대조는 정규장 중에만 가능합니다. 토스 3항목은 토스 키가 있어야 하고, 원/달러는 매크로 화면 저장본이 1시간 이내여야 합니다 |
| `git push`가 403 | 이 PC에 저장된 GitHub 토큰(gh CLI) 문제입니다 → [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |

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
| 국내 수급·파생 | KRX Open API · KIS · 토스 · Daum · Naver | 공식 + 비공식 혼합 |
| 13F 포트폴리오 | SEC EDGAR | 공식 (분기 공시, 45일 지연) |
| CFTC COT | CFTC 공개 API | 공식 (주 1회, 화요일 기준) |
| 한국 공휴일 (KRX 휴장) | 한국천문연구원 특일정보 | 공식 (대체공휴일·선거일 포함) |
| 국내 종목 공식 시세·시가총액 | 금융위원회 주식시세정보 | 공식 (거래소 확정치, **다음 영업일 13시 이후**) |
| 국내 종목 재무 | 금융감독원 Open DART (사업보고서) | 공식 (연 1회, 직전 사업연도) |
| 미국 종목 재무 (모의 매매 Claude 계좌 패킷) | SEC EDGAR XBRL Company Facts | 공식 (10-Q·10-K·20-F 공시일 기준, 실적 보도자료 8-K 없음) |
| 미국 발표·실적 일정 (모의 매매 Claude 계좌 패킷) | FRED release/dates · 연준 FOMC 일정표(상수) · yfinance quoteSummary | 거시는 공식(FRED는 그해 12-31까지만), 실적일은 **비공식 참고** (yfinance 내부 호출, 장 구분은 발표 시각으로 추정) |
| 어닝 서프라이즈 (모의 매매 Claude 계좌 패킷) | yfinance quoteSummary `earnings` (내부 호출) | **비공식 참고** — 컨센서스는 Yahoo 집계, 한 번에 최근 4분기만(쌓아서 8분기), 추정치가 0에 가까우면 비율이 부풂(`smallBase`) |
| 정보 수집(사이드바 '정보 수집', 운영자 화면 전용) | 해외 블로그 14곳 RSS·waedge 뉴스 HTML·네이버 증권 화면 API | **비공식 참고** — 운영 서버에서만 차단 통과 수집 계층으로 비주기 수집, 본문은 DB에만(180일). 블로그·waedge 글의 제목과 앞부분은 모의 매매 Claude 계좌 패킷에 참고 자료로(설정으로 끔 — [ADR 0035](docs/adr/0035-info-collection.md)·[ADR 0036](docs/adr/0036-info-hub-krx-packet.md)) |
| 투자자별 순매수 상위·거래실적·외국인 보유·공매도(정보 수집·수급 레이더) | KRX 정보데이터시스템(계정 로그인 `KRX_ID`·`KRX_PW`) | 거래소 확정치 — 운영 서버가 거래일 18:30 뒤 하루 한 번 받음(공매도 잔고는 2~3거래일 늦음). 화면 표시 구조가 바뀌면 끊김 알림([ADR 0036](docs/adr/0036-info-hub-krx-packet.md)) |
| 사건 뉴스 헤드라인 (모의 매매 Claude 계좌 패킷) | RSS — Investing.com 넷 · 연준 · BLS 둘 · SEC (야후는 robots.txt가 막아 제외) | 제목·출처·시각만, 7일 보관. 인베스팅닷컴은 최근 10건만 줘 사이 항목을 놓칠 수 있고 이용 조건 [확인 필요] |
| 검색 상세 화면(종목 시세·핵심 지표·뉴스·종목 찾기) | Yahoo(yfinance)·네이버 증권 모바일 API·구글 뉴스 RSS 검색 | **비공식 참고** — 화면이 볼 때만 조회(5~60분 캐시)하고 저장하지 않음. robots.txt가 막는 출처지만 개인·비상업 용도로 사용자가 허락(2026-11-01) |
| **MOVE 지수** | `^TNX` 변동성 역산 | **추정치 — 실제 MOVE 아님** |

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
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | 수집 태스크 63종, 소스별 폴백 체인, 한계 |
| [docs/specs/2026-11-06-real-trade-mirror.md](docs/specs/2026-11-06-real-trade-mirror.md) | **실제 매매 계약(2026-11-06, [ADR 0028](docs/adr/0028-real-trade-mirror.md))** — 토스 실제 계좌가 모의 한국 책을 따라 하는 방식·창·멱등·멈춤·API·화면 |
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
| Collector | Python 3.11 · FastAPI · pandas · yfinance · feedparser(RSS 읽기만) · curl_cffi | 금융 데이터 수집·파싱 라이브러리 생태계 |
| DevOps | Docker Compose · GitHub Actions · Vultr(서울 vhf-2c-4gb) · Tailscale · AWS S3(백업) · Caddy | 네 프로세스를 한 명령으로, 세 언어 테스트를 매 푸시마다. 운영본은 공개 TCP 포트 없이 Tailscale로만 여는 서버 한 대, 24시간([ADR 0023](docs/adr/0023-vultr-deployment.md)) |

**의도적으로 쓰지 않은 것** — Kafka/CDC(하루 수천 건 규모라 브로커가 처리할
트래픽이 없음), BigQuery/ClickHouse(전체 수십 MB), 네이티브 앱(같은 기능을 두 벌
유지해야 함), 쿠버네티스(1인용 로컬 대시보드). 필요해지면 붙일 수 있도록 경계는
열어 두었습니다.

---

## 만든 사람

**강진영** · <kangjy5235@gmail.com>

기획 · 아키텍처 설계 · 데이터 수집 · 백엔드 · 프런트엔드 · 운영까지 1인 개발했습니다.
