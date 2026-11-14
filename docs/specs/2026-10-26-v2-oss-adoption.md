# 외부 오픈소스 채택 목록 — camofox-browser · FinceptTerminal · Vibe-Trading

- 작성: 2026-10-26 · 상위 문서: [프로그램 계획서](2026-10-26-v2-program-plan.md)
- 원칙: **코드째 들여오지 않는다.** 알고리즘 정의·데이터 출처·안전 패턴을 읽고, 우리 층(수집기는 저장만 · 백엔드 `analytics` 순수 함수 · 화면은 표시)에 다시 쓴다.
  옮긴 계산은 원본 테스트의 기대값으로 고정한다. 라이선스는 따지지 않는다(V8).
- 저장소 사본은 저장소 밖(세션 scratchpad)에만 둔다. 어떤 코드도 실행하지 않고 읽기만 했다.

## 1. 가져오는 것 (단계별)

| 단계 | 가져오는 정의·패턴 | 출처(저장소 · 경로:줄) | 우리 자리 |
|---|---|---|---|
| 1 | 경제 캘린더 `forecast`·`previous`·`actual`·`importance`·출처·ISO 시각 | Fincept `fincept-qt/scripts/tradingview_data.py:66`(TradingView `economic-calendar.tradingview.com/events`), 예비 `nasdaq_data.py:681`(Nasdaq `api/calendar/economicevents`) | 수집기 `us_calendar` 보강 → `calendar.us_events` → 백엔드 `CalendarWindow` → 패킷 `1b_calendar`, 홈·지표 상세 '다음 발표' |
| 1 | 거부 응답 래치: 403·429·HTML 챌린지 본문을 "데이터 없음"이 아니라 "출처가 거부"로 분류해 5분 동안 남은 호출을 멈춤 | Vibe `agent/backtest/loaders/stooq_loader.py:47-70, 233-257` | `collector/app/http.py`(공용 세션 어댑터) |
| 1 | 호스트별 최소 간격 + 지터, 시간 예산 안 재시도(일시 오류만) | Vibe `agent/backtest/loaders/_http.py:35-46`, `base.py:406` | `collector/app/http.py` |
| 1 | bulk 다운로드 뒤 빈 슬라이스 티커만 개별 재다운로드, 빈 프레임을 "no usable data"로 기록 | Vibe `yfinance_loader.py:336-351` | `collector/app/tasks/paper.py` |
| 2 | 시장 규칙 모델(거래 단위·세금·수수료를 시장 객체로) — A주 엔진의 T+1·인지세·100주를 본떠 한국은 거래세(매도)·호가단위·정수 주 | Vibe `agent/backtest/engines/`(A주 엔진), `agent/src/tools/paper_trade/rules.py:161`(수수료 Decimal 반올림) | 백엔드 `Market` 인터페이스·`KrMarket` |
| 2 | 분할 감지 3중 조건: 가격비 ≈ 1/m(m ∈ {2,3,4,5,10,3/2}와 역수, 상대 1e-3) · 거래량비 ≈ m · 순자산 연속성 1e-4. 밴드(2/3, 3/2) 밖인데 셋을 못 채우면 그 종목 주문 보류 | Vibe `agent/src/tools/paper_trade/corporate_actions.py` | `analytics.SplitDetector` 보강(거래량이 있는 한국 책부터) |
| 2 | KIS 토큰 캐시: 발급 분당 1회 제한 → 파일 캐시(0600)·만료 120초 여유·"만료된 token" 거절 시 1회 재발급·`tr_cont` 페이지네이션은 상한에서 예외 | Vibe `agent/src/trading/connectors/kis/sdk.py:685-739, 764-811, 843-867` | `collector/app/services/kis.py` |
| 2 | Toss 종목 봉 엔드포인트(`/api/v1/candles` 1m·1d, 200개 상한)·`/api/v1/prices` | Vibe `connectors/toss/sdk.py:318-390` | 한국 관측치 수집(우리 키로 확인 뒤) |
| 3 | 숫자 근거 검사: 상대 0.5% 또는 적힌 자릿수 반 단위, 1000 미만 정수는 가격으로 보지 않음, 불일치 시 교정 1회·그 뒤 표시만 | Vibe `agent/src/agent/grounding/policies.py:103-132`, `figures.py:29-193`, `release.py:28-61` | `analytics.FigureCheck`, `ClaudeBookService`, `AiReportService` |
| 3 | 재무 팩터 정의: 이익수익률·FCF 수익률·장부가/시가·ROE·GP/TA·발생액(−(NI−CFO)/TA)·매출 성장 | Vibe `agent/src/factors/zoo/fundamental/*`, 연산자 `factors/base.py:79-425` | `analytics.FundamentalFactors` → 스코어카드 |
| 3 | Piotroski F 9항목·Altman Z | Fincept `fincept-qt/src/services/equity/EquityValuationModels.cpp:142-228` | 같은 곳 |
| 3 | 뉴스 군집(제목 토큰 Jaccard ≥ 0.25, 같은 분류 ×0.8, 24시간)·속도(2시간 vs 이전)·삼각측량(3개 이상 출처 같은 첫 50자) | Fincept `src/services/news/NewsClusterService.cpp:39-40`, `NewsSignalDetector.h:36-42`, 피드 53개 `NewsService_Feeds.cpp:36-176` | `analytics.NewsEvents`, 설정 `news.feeds` |
| 3 | 뉴스 시점 규칙: 16:00 이후 발행은 다음 날 '알 수 있는 날' | Vibe `agent/backtest/loaders/rsshub_events.py:49, 277, 416` | `analytics.NewsEvents`(복기·백테스트용) |
| 5 | Brinson-Fachler(배분 (wp−wb)(rb−Rb) · 선택 wb(rp−rb) · 교차 (wp−wb)(rp−rb)) + Carino 다기간 연결, 4섹터 기대값 | Vibe `agent/src/quantlib/attribution.py:209, 341, 384`, `agent/tests/quantlib/test_attribution.py:22-30` | `analytics.Brinson` |
| 5 | purged walk-forward 분할(훈련은 과거만, 라벨 끝이 시험 시작 이후면 제외) | Vibe `agent/src/quantlib/crossvalidation.py:417`, 회귀 테스트 `agent/tests/test_walkforward_empty_training_regressions.py` | `analytics.WalkForward` |
| 5 | `bootstrap_statistic`(통계 함수를 넘김) + 블록 부트스트랩은 직접 추가, PSR(≥30 관측)·Deflated Sharpe·PBO | Vibe `quantlib/timeseries.py:771, 827`, `quantlib/multipletesting.py:217, 339, 463` | `analytics.Bootstrap`, `analytics.SharpeTests` |
| 5 | 증거 등급: 거래 10건 미만 '부족', 730일 미만 '한계'; 1년 미만 구간은 연율화하지 않음(None) | Vibe `strategy_discovery/models.py:75-89`, `quantlib/performance.py:425` | `analytics.PaperStats`·walk-forward 결과 표시 |
| 5 | BIS SDMX: `WS_CREDIT_GAP`(신용갭)·`WS_DSR`·`WS_CBPOL`(정책금리)·`WS_SPP`(주택가격)·`WS_GLI` | Fincept `fincept-qt/scripts/bis_data.py:6, 1025-1050` | 수집기 새 태스크 → `timeseries` |
| 5 | SEC XBRL frames(한 개념·한 기간·전 회사) — 유니버스 밖 비교군이 필요할 때 | Fincept `scripts/sec_xbrl_data.py:55` | 수집기 선택 태스크 |
| 5 | 우회 수집 대상: KRX 정보데이터시스템 전 종목 투자자별·공매도, 네이버·FnGuide 국내 컨센서스. 방식은 one-shot 헤드리스(Playwright 또는 camoufox 파이썬 패키지) | camofox `lib/page-structure.js:66-112`(표 구조화·refs 150줄은 일반 Playwright로 그대로 됨) | 수집기 태스크(V2 결정 뒤) |

### 1-1. 정보 검색에 접목한 것(2026-11-14, [ADR 0041](../adr/0041-info-search-watch.md) 결정 13 — 코드는 가져오지 않고 출처·주소·규칙만, 우리 구조로 새로 씀)

| 무엇 | 어디서 배운 것(라이선스) | 우리 자리 |
|---|---|---|
| 우리에게 없는 RSS 12개(연준·ECB·영란은행 보도자료, Bloomberg·MarketWatch·CNBC 둘·Benzinga·Seeking Alpha·BBC·Economist·Nikkei Asia) | FinceptTerminal 피드 53개(AGPL-3.0) | 새 피드 묶음(단계 3) — FXStreet는 서버 IP 403으로 뺌 |
| 키워드 감시(이름·키워드·한 번만 알림·오래된 글 제외) | FinceptTerminal `NewsMonitorService` | 관심 대상의 별칭 대조(단계 3) |
| Yahoo 검색 뉴스를 `relatedTickers`로 거르기 | FinceptTerminal `yfinance_data.py` | 정보 검색 뉴스 탭(단계 2) |
| 회사별 공시 목록·이름으로 EDGAR 전문 검색 | FinceptTerminal `sec_data.py`·`deal_scanner.py` | 공시 탭(단계 4) — 티커↔CIK 표는 이미 있던 `sec_fundamentals` 재사용 |
| 모회사·자회사(GLEIF), 임원·내부자·투자의견 변경(yfinance) | FinceptTerminal `lei_data.py`·`relationship_map.py` | 연결·리서치 탭(단계 4) |
| 차단을 감지하면 재시도하지 않고 멈춤, 지수 간격 + 흔들림 | akshare `utils/http.py`(MIT) | 이미 우리 계층(ADR 0026)에 더 엄격하게 있음 |

- 접목하지 않은 것: akshare의 출처 전부(뉴스 검색·7x24 속보·기업 프로필·목표가·공시·연구보고서 — 모두 중화권 사이트), akquant(Rust·Python 백테스트 엔진 — 자체 출처
  없음), FinceptTerminal의 `scmp` 피드와 범위 밖 피드(지정학·기술·가상자산 등), 키가 필요한 출처(OpenCorporates·Finnhub·FMP 등), 손으로 적은 동종 기업 표,
  JS로 토큰을 계산해 보내는 방식(새 의존성).
- AGPL-3.0인 FinceptTerminal의 코드는 옮기지 않습니다(다른 언어로 줄 단위 번역 포함 — 저장소 전체가 AGPL-3.0이 됨). MIT인 akshare·akquant 코드를 옮길 일이
  생기면 저작권 고지와 라이선스 전문을 두고 옮긴 파일 머리에 출처를 적습니다(이번에는 옮긴 코드 없음).

## 2. 가져오지 않는 것과 이유

| 항목 | 이유 |
|---|---|
| camofox-browser 상주 REST 서버 | 인증 없으면 전 경로 개방(`/tabs/:id/evaluate` 포함), SSRF 보호 없음, 크래시 텔레메트리 기본 켜짐(공개 GitHub 이슈로 올라감), 메모리 가드가 Fly.io에서만 동작. 4 GiB 서버에 자리 없음. 필요하면 one-shot 방식 |
| Vibe LangChain/LangGraph 런타임, 브로커 커넥터 18개, 라이브 트레이딩 | 주문은 밖으로 나가지 않음(명세 §0), 공식 SDK·구조화 출력(ADR 0007·0018) 유지 |
| Vibe 투자위원회 swarm(불·베어·CRO·PM) | 결정 하나에 호출 4번. 상한 20 안에서도 비용 대비 이득 작음 — `bearCase` 필드와 반대 논거 1회 호출로 대체 |
| Vibe `agent/backtest/metrics.py calc_metrics` | 정의 안 되는 값을 0.0으로 채우고 분모에 1e-10을 더함, ddof 혼용 — "없는 숫자를 만들지 않는다"와 충돌 |
| Vibe KIS 커넥터의 시세 부분 | 국내 현물만. 해외(미국) 시세 없음. 토큰 캐시 패턴만 가져옴 |
| Fincept Brinson(`active_management.py:120-140`) | 배분·선택을 0.3/0.7로 고정한 가짜 분해 |
| Fincept Deflated Sharpe(`vbt_returns.py:159-191`) | 연율화 SR을 일간 n 분산식에 넣고 교차 시도 분산을 안 씀 — 틀림 |
| Fincept 공포탐욕 점수·키워드 감성 사전, Vibe 감성 사전 | 근거 없는 숫자 |
| Fincept 37개 에이전트 페르소나 | 프롬프트만으로 "지어내지 말라"는 방식. 코드 검사가 없음 — 우리는 숫자 근거 검사로 대신 |
| Stooq 폴백 | 이 맥에서 JS proof-of-work 챌린지 페이지(HTTP 200 HTML)를 돌려줘 쓸 수 없음(2026-10-26 확인) |

## 3. 확인한 엔드포인트 (2026-10-26, 이 맥에서 curl)

| 출처 | 결과 |
|---|---|
| TradingView `economic-calendar.tradingview.com/events?from&to&countries=US,KR&minImportance=1` | 200. `forecast`·`previous`·`actual`·`importance`·`source`·`date`(ISO). 창 안에 US 7건(Durable Goods·FOMC·GDP·Core PCE…). **KR 이벤트 포함 여부 미확인** |
| Nasdaq `api.nasdaq.com/api/calendar/economicevents?date=2026-10-29` | 200(브라우저 UA 필요). 58행, `consensus`·`previous`·`actual`, 시각은 GMT 문자열, `&nbsp;` 정리 필요 |
| BIS `stats.bis.org/api/v1/data/WS_CREDIT_GAP/Q.KR.P.A.A/all`, `WS_CBPOL/M.KR/all` | 200, 키 없음. 한국 신용갭 2026-Q1 값, 정책금리 2026-09 3.00 |
| SEC `data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025Q2.json` | 200, 1,941개 회사(연락처 UA 필수) |
| Stooq `stooq.com/q/d/l/?s=spy.us&i=d` | 200이지만 JS 챌린지 HTML — 사용 불가 |

## 4. camofox-browser에서 배운 운영 조건 (우회 수집을 넣을 때)

- 이미지 `ghcr.io/jo-inc/camofox-browser` linux/arm64 있음. 그래도 상주 서버는 올리지 않는다(§2).
- one-shot으로 쓸 때: 컨테이너 메모리 상한, `CAMOFOX_CRASH_REPORT_ENABLED=false`·`CAMOFOX_DISABLE_DEFAULT_ADDONS=1`에 해당하는 설정, 내부 네트워크만, 짧은 유휴 종료.
- Cloudflare 뒤 사이트는 데이터센터 IP에서 거주지 프록시 없이 통과를 보장하지 않는다. 실패는 EmptyResult로 이전 값 유지.
- 우리 쪽 원칙: 우회로 받은 값도 출처·수집 시각·'비공식' 표시를 붙이고, 같은 자료를 브라우저 없이 주는 출처가 있으면 그쪽을 먼저 쓴다.
