# 진행 기록 — 메뉴 재배치와 정보 검색(대상 중심 검색 · 관심 대상) (2026-11-14~)

- 지시문: [2026-11-14-info-search-exec-instructions.md](2026-11-14-info-search-exec-instructions.md)(4판) ·
  프롬프트: [2026-11-14-info-search-exec-prompt.md](2026-11-14-info-search-exec-prompt.md)
- 작업 브랜치 `claude/info-search-2026-11`(main `4981080f`에서 — 계획 기준 `a7ca2063` 뒤로 문서 커밋 하나만 더 있음), 첫 커밋 `6a62238b`(지시문·프롬프트).
- 승인 범위: 단계 0~5(2026-11-14 사용자 승인 — 결정 D-1~D-11은 프롬프트의 기본값 그대로). 단계 6은 사용자가 "다음 단계 진행해"라고 할 때.

## 단계 0 — 재확인 · 서버 실측 · ADR 초안 (2026-11-14 토)

### 서버 실측 (2026-11-14 16:30~16:50 KST, Vultr 서버의 수집기 컨테이너에서 출처마다 1~4번, 응답 원문은 남기지 않고 요약만)

새 피드 묶음 후보 13개 — 일반 브라우저 User-Agent(공용 세션과 같은 값)로 한 번씩:

| 피드 | 응답 | 글 | 최신 | 시각 칸 | 검증 값 | 판정 |
|---|---|---|---|---|---|---|
| 연준 전체 보도자료 | 200 · 15 KB | 20 | 11-13 21:15 UTC | pubDate | ETag·Last-Modified | 넣음 |
| ECB 보도자료 | 200 · 6 KB | 15 | 11-13 | pubDate | ETag | 넣음(요약 칸 없음 — 제목만) |
| 영란은행 소식 | 200 · 26 KB | 50 | 11-13 | pubDate | 없음 | 넣음 |
| Bloomberg 시장 | 200 · 16 KB | 20 | 11-14 05:20 UTC | pubDate | ETag | 넣음 |
| MarketWatch 주요 기사 | 200 · 8 KB | 10 | 11-14 | pubDate | ETag | 넣음 |
| CNBC 금융 | 200 · 21 KB | 30 | 11-14 | pubDate | 없음 | 넣음 |
| CNBC 세계 | 200 · 20 KB | 30 | 11-14 | pubDate | 없음 | 넣음(같은 호스트 — 시각을 겹치지 않게) |
| Benzinga | 200 · 213 KB(본문 포함) | 25 | 11-13 | pubDate | Last-Modified | 넣음 — 제목·요약·링크만 저장 |
| Seeking Alpha 시장 속보 | 200 · 5 KB | 7 | 11-14 | pubDate | ETag | 넣음(요약 칸 없음) |
| BBC 비즈니스 | 200 · 41 KB | 56 | 11-14 | pubDate | 없음 | 넣음 |
| Economist 금융·경제 | 200 · 151 KB | 300 | 11-12 | pubDate | ETag·Last-Modified | 넣음(가장 오래된 글 2026-01 — 2년 안) |
| **FXStreet 뉴스** | **403**(HTML 5.7 KB) | — | — | — | — | **뺌 — 서버 IP에서 막힘(D-11)** |
| Nikkei Asia | 200 · 26 KB(RDF) | 50 | — | **없음**(글마다 제목·링크뿐) | 없음 | 넣음 — 처음 받은 시각을 '받은 시각'으로 |

검색 출처(정보 검색·관심 대상이 부를 공식 API·RSS):

- 구글 뉴스 RSS — 서버 IP에서 200(전제 유지). `"Ken Griffin" OR "Kenneth Cordele Griffin" after:2024-11-14`(영어 판) 58건, 2025-07-16~2026-11-13,
  2년 밖 0건. `"삼성전자" after:…`(한국어 판) 108건, 10-31~11-14(많이 나오는 이름은 최근 2주만 옴). `"Duquesne Family Office"` 44건, 2025-02~2026-11.
  `"NVIDIA"` 106건, 11-06~11-14. 링크는 모두 `news.google.com` 경유 주소, 매체는 `<source url=…>`. 제목이 중국어인 글 0건.
- Bing 뉴스 RSS — 200. `"Ken Griffin"` 10건(2026-05~11), `"삼성전자"`(setlang=ko-KR) 8건. 링크 10/10·8/8에 인자 `url`(원문 주소)이 있음,
  매체 칸은 `News:Source`(MSN 재게재는 'on MSN'이 붙음).
- SEC(`SEC_USER_AGENT`): `company_tickers.json` 200(10,404행), submissions(NVDA) 200(최근 1,000건, 2020-09~2026-11-12, 그 밖 파일 1개),
  **EDGAR 전문 검색** `efts.sec.gov/LATEST/search-index` 200 — `"Ken Griffin"` 20건(2025-02~2026-08, 1-A POS·8-K 등), `"Duquesne Family Office"` 62건
  (2024-11-14~2026-10-15, 13F-HR·S-1/A·DEF 14A 등). 응답 칸: `adsh`·`ciks`·`display_names`·`file_date`·`form`·`root_forms`·`file_description` 등.
- Open DART `list.json`: 삼성전자(`corp_code` 00126380) 2년 → 3,722건(38쪽, 쪽당 100). `corp_code` 없이 2년 → status 100
  "corp_code가 없는 경우 검색기간은 3개월만 가능합니다"(문서와 같음).
- Wikidata — 연락처 없는 일반 이름 UA(`LocalMacroDashboard/2.0`)로 200(D-5 그대로 됨). `Ken Griffin` 후보 7건(동명이인 — `Q3195170`이 헤지펀드
  운용자, 별칭 `Kenneth Cordele Griffin`·`Ken Griffin`, 한국어 이름 없음, 소유 `P1830` 있음). `삼성전자`(ko) → `Q20718`(한국어 별칭 '삼성'·'삼성반도체').
  `NVIDIA` → `Q182477`(한국어 이름 '엔비디아', CIK `P5531`·자회사 `P355`·모회사 `P749`·상장 `P414` 있음 — 티커 `P249`는 문장이 아니라 `P414`의 한정자).
  `Duquesne Family Office` 0건(지시문과 같음).
- GLEIF — 일반 이름 UA로 200. `Samsung Electronics` 85건(첫 쪽은 해외 자회사, 본사는 `삼성전자(주)` KR), `Duquesne Family Office` 3건(
  `DUQUESNE FAMILY OFFICE LLC` 외 펀드 둘). 관계: 첫 결과(해외 자회사)의 direct-parent·ultimate-parent는 404(보고 예외 — 관계가 없을 수 있음),
  direct-children 0건 — 관계 자료는 법인마다 비어 있을 수 있어 '있으면 보임'으로만 씀.
- yfinance 1.7.0(서버 수집기): `insider_transactions`(NVDA 150행, 2025-03~2026-09, 칸 Insider·Position·Transaction·Start Date·Shares·Value),
  `insider_roster_holders`(10행), `institutional_holders`(10행, Date Reported), `upgrades_downgrades`(1,011행, 2017-08~2026-11-13 — 2년으로 자름,
  칸 Firm·ToGrade·FromGrade·Action·현재·이전 목표가) 있음. **임원 목록(`info.companyOfficers`)은 0건** — 연결 탭의 임원은 내부자 명단으로 대신.
  `Search` 뉴스 10건 모두 `relatedTickers`가 있고 NVDA 10/10.
- **Finviz**(한 번 — `robots.txt` 1 + 종목 화면 `quote.ashx?t=NVDA` 1, 9초 간격, 계층 1과 같은 curl_cffi `chrome150` 지문):
  `robots.txt` 200 — `quote.ashx`·`news.ashx`를 막는 줄 없음, Crawl-delay 없음. 종목 화면 **200 · 329 KB · Cloudflare 앞단, 사람 확인 표시 없음
  → 서버 IP에서 계층 1로 지나감**. 뉴스 표(`id="news-table"`) 100줄, 링크 94 외부·6 Finviz 안쪽(상대 경로). 날짜 칸은 그날의 첫 줄만
  `Nov-13-26 11:24PM` 모양이고 나머지는 `10:40PM`처럼 시각만(앞 줄의 날짜를 이어받음) — 시간대는 미국 동부로 보이며 단계 5에서 확인.
  'Show Previous News' 단추 있음(받지 않음). 매체 상위: Barrons.com·MarketWatch 14, Yahoo Finance 11, Investing.com 8, Stocktwits 7, Reuters 6, …,
  **DigiTimes 3**(대만 매체 — D-9 보고 대상).

D-9 — 실측에서 보인 중화권 영어 매체: **DigiTimes**(대만, Finviz NVDA 목록), **BigGo Finance**(`finance.biggo.com`, 대만 BigGo — 구글 뉴스 Duquesne),
**Moomoo**(`www.moomoo.com`, 중국 Futu 계열 — 구글 뉴스 Duquesne). 제목이 중국어인 글은 이번 실측에서 0건.

### 코드 재확인 (2026-11-14, 읽기 전용 에이전트 9개 — 워크플로 `wf_966810e4-274`)

지시문 §3의 사실은 대부분 그대로였습니다. 다르거나 없던 것과 설계에 주는 영향:

- 메뉴: `TABS`·`OWNER_ONLY_MENUS`·`TabBar.COLUMNS`(5·6)·`MoreMenu`(정보 수집 맨 위) 모두 지시문과 같음. `/radar`·`/krx`가 '한국'으로 찾히는 것은 탭 이름이
  검색어가 되어서였음(`navSearchItems`) → 두 화면에 검색어 '한국'을 직접 넣어야 함. 더보기 탭의 하위 메뉴 줄(`subNav`)이 탭의 모든 화면을 그려서, 묶음
  표지 없이 옮기면 `/alerts` 줄에 레이더가 섞임 → `NavItem.group`으로 거름. `/search` 화면이 없어 단계 1만 배포하면 404 → 단계 1에 자리 화면을 둠.
- 접근: 등급은 `PUBLIC·MEMBER·PRO·OWNER`이고 데모는 등급이 아니라 `CurrentUser.demo()`, `store_only`는 읽기 방식(`AppProperties.ReadMode.STORE_ONLY`).
  수집기 호출은 `com.macrodash.collector.CollectorClient`(실패 로그가 `e.getMessage()` — 전체 URI가 섞일 수 있어 새 경로는 이름표만 남김).
  새 경로 등록 대상에 `scripts/qa/routes.json`(RouteInventoryTest가 대조)과 `endpoints.test.ts`의 경로 함수 수 고정(71)도 있음.
- 뉴스: `services/news.entry_summary`는 본문 칸이 길면 본문을 2,000자까지 고름 → 새 묶음은 description·summary만 쓰는 따로 된 추출. 사건 뉴스 시험이
  `CADENCES` 키 = `FEEDS ∪ KR_FEEDS`를 요구하고 `NewsFeedsParityTest`가 `news.py`의 `FEEDS` 블록을 읽음 → 새 묶음은 다른 모듈·다른 이름.
  정보 수집 화면의 헤드라인 경로는 `us`·`kr` 두 묶음만 앎(세 번째 묶음은 화면·백엔드를 함께 고쳐야 함).
- SEC 티커↔CIK 표(`sec_fundamentals.fetch_company_tickers`)는 이미 있음 → 새로 쓰지 않고 재사용(새로 쓰는 것은 submissions 목록·EDGAR 전문 검색).
- 차단 통과 계층: 하루 예산이 `fetch_hosts` 행에 호스트당 하나 → 검색 예산을 따로 세려면 새 칸·표가 필요(단계 5). `ladder.fetch`는 `POLITE_FETCH_ENABLED`를
  보지 않음 → 화면발 Finviz는 스위치를 직접 확인. 브라우저 컨테이너는 동시 1건.
- 화면: `useSearchParams`·`<Suspense>` 사용처가 없음(쓰면 정적 빌드에 Suspense 필요 — Next 16.4.5 문서). 포털(`ui/Dialog`·토스트)에 범위 표지를 넘길 길이
  없음 → `Dialog`에 선택 칸을 더함. 대비 검증은 저장소 안 시험이 없고 명세가 '다시 계산'으로 적음 → 범위 토큰 대비 시험을 새로 둠. 기업·사람·주제 아이콘은
  `ui/icons`에 없음(셸 아이콘 경로를 옮겨 씀). `lib/search.ts`는 상단 통합 검색이 쓰는 이름 → 새 순수 모듈은 `lib/infoSearch.ts`.
- 저장본: `info_items` 보관 180일(블로그는 30일 안 글만 넣음, 속보 48시간), 사건 뉴스 관측치 7일, 13F 8분기 — '최근 2년'이라도 저장본 탭에 실제로 있는 범위는
  이만큼이라 화면에 '받은 자료 기준'으로 적음. 본문 검색용 색인(pg_trgm 등)이 없음 → 본문 검색은 건수·시간 상한을 둔 단순 검색으로 시작.
- 문서와 코드의 어긋남(이 작업 범위 밖, 기록만): 정책 표의 하루 예산(`policy.py` — TradingView 30·KRX 100)이 `DATA_SOURCES.md`·명세의 옛 값(12·40)과 다름.
  DEVELOPMENT §7 '재부팅 뒤 확인'의 결정 시각은 ADR 0039 이전 값.

### 매체 소유 확인 (2026-11-14, 웹 조사 에이전트 — 근거 주소는 워크플로 기록)

| 매체 | 소유 | 중국 자본 |
|---|---|---|
| 연준·ECB·영란은행 | 미국 연방 기관 · EU 중앙은행들 출자 · 영국 정부 100% | 없음 |
| Bloomberg | Bloomberg L.P.(M. Bloomberg 약 88%, 2026-07 소수 지분 매각 논의 보도 — 발표 없음) | 찾지 못함 |
| MarketWatch | Dow Jones → News Corp | 없음 |
| CNBC | Versant Media Group(2026-01 Comcast에서 분사, 나스닥 VSNT) | 찾지 못함 |
| Benzinga | Beringer Capital 과반(2021~) + 창업자 | 찾지 못함(펀드 출자자 비공개) |
| Seeking Alpha | Seeking Alpha Ltd.(이스라엘, 벤처 투자) | 찾지 못함 |
| BBC | 공영(칙허장) | 없음 |
| Economist | Exor 43.4% · Smith Financial 26.9%(2026-04, 로스차일드 지분 인수) · 그 밖 가문·직원 | 없음 |
| FXStreet | ForexStreet S.L.U.(바르셀로나, 단독 주주 비공개) | 찾지 못함 — 어차피 서버 403으로 뺌 |
| Nikkei Asia | Nikkei Inc.(직원 소유, FT 100% 소유) | 없음 |

같은 조사에서 드러난 것(이 작업 밖 — 보고):
- **Investing.com: 2021년 홍콩 Joffre Capital이 약 5억 달러에 인수, 회사 소개에 선전 사무소** → 중국 자본. 지금 사건 뉴스 묶음 `FEEDS`의 네 피드
  (모의 매매 패킷 입력)·정보 수집 출처 표·종목 상세의 바깥 검색 링크에서 쓰고 있음. 패킷 입력을 바꾸는 일이라 고치지 않고 사용자 결정을 기다림.
- StreetInsider(2023년 Investing.com이 인수) — 중국 자본(간접). Futu/moomoo — 홍콩 본사. Webull·Tiger(UP Fintech)·AInvest — 소유·운영이 불확실.

매체 제외 목록의 처음 값(확실한 것만 — 도메인 점 경계, 이름 완전 일치):
- 중국 국가·당 매체: Xinhua(`xinhuanet.com`·`news.cn`), China Daily(`chinadaily.com.cn`·`chinadailyhk.com`·`chinadailyasia.com`), Global Times(`globaltimes.cn`),
  People's Daily(`people.cn`·`people.com.cn`·`peopledaily.com.cn`), CGTN·CCTV·CRI(`cgtn.com`·`cctv.com`·`cri.cn`), China News Service(`ecns.cn`·`chinanews.com.cn`),
  China.org.cn·Beijing Review(`china.org.cn`·`bjreview.com`), Sixth Tone·The Paper(`sixthtone.com`·`thepaper.cn`), Yicai(`yicaiglobal.com`·`yicai.com`),
  Shanghai Daily(`shine.cn`·`shanghaidaily.com`), 증권 3지(`stcn.com`·`cs.com.cn`·`cnstock.com`)
- 본토 민간: Caixin(`caixinglobal.com`·`caixin.com`), Jiemian(`jiemian.com`), Economic Observer(`eeo.com.cn`), 21st Century Business Herald(`21jingji.com`),
  36Kr(`36kr.com`), TechNode(`technode.com`), Pandaily(`pandaily.com`), Mysteel(`mysteel.net`·`mysteel.com`), SMM(`metal.com`), Gasgoo(`gasgoo.com`),
  CnEVPost(`cnevpost.com`), CarNewsChina(`carnewschina.com`)
- 홍콩: The Standard(`thestandard.com.hk`), RTHK(`rthk.hk`), Hong Kong Free Press(`hongkongfp.com`), Asia Times(`asiatimes.com`),
  EJ Insight(`ejinsight.com`·`hkej.com`), HKET(`hket.com`), AASTOCKS(`aastocks.com`), ETNet(`etnet.com.hk`), Mingtiandi(`mingtiandi.com`),
  Dimsum Daily(`dimsumdaily.hk`), Phoenix(`ifeng.com`), Week in China(`weekinchina.com`)
- 마카오: Macau Business(`macaubusiness.com`), Macau Daily Times(`macaudailytimes.com.mo`), GGRAsia(`ggrasia.com`), Inside Asian Gaming(`asgam.com`),
  Macau News Agency(`macaunews.mo`)
- 중국 자본 금융 매체: Futu·moomoo(`moomoo.com`·`futunn.com`·`futuhk.com`·`futuholdings.com`)
- **사용자가 허용함(2026-11-14 — 제외 목록에 넣지 않음)**: 대만 매체 전부(Focus Taiwan·CNA, Taipei Times, Taiwan News, DigiTimes, TrendForce, CommonWealth,
  Taiwan Today, RTI, The China Post, BigGo 등), Investing.com, StreetInsider, South China Morning Post(`scmp.com`·자매 매체 Inkstone `inkstonenews.com`),
  소유가 불확실했던 매체(Webull, Tiger Brokers(UP Fintech), KrASIA, China Briefing, AInvest, Bamboo Works, The News Lens). 중국어 제목 거름과 `.cn` 규칙은
  이 매체들에도 그대로 적용됩니다(D-9 고정).
- 비중국 매체의 중국어 판(`cn.wsj.com`·`cn.nytimes.com`·`ftchinese.com`·`zh.cn.nikkei.com`·`fxstreet.cn`)은 중국어 제목 거름과 `.cn` 규칙이 잡고,
  잡지 못하는 도메인은 목록에 넣음.

### 고친 설계와 이유

- 새 피드 묶음은 **12개**(FXStreet 뺌 — 서버 403, D-11). Nikkei Asia는 시각 칸이 없어 처음 받은 시각('받은 시각' 표시)으로.
- 연결 탭의 '임원'은 yfinance 임원 목록이 비어 있어 **내부자 명단**(`insider_roster_holders` — 이름·직위)으로 대신(단계 4).
- Finviz 결과의 회원 노출은 D-1(회원 등급)을 따르되 ADR 0026 결정 10을 고치는 것이라 ADR 0041 결정 10에 적음.
- 관심 대상 글 표는 D29 재개정('robots 출처는 저장하지 않음')을 고치는 것이라 ADR 0041 머리에 적음(사용자 결정 D-4).
- 매체 제외 목록: 처음 값(코드에 둔 확실한 목록 — 위) + 사용자가 더하는 표(단계 3 마이그레이션에 함께). 즉석 검색·관심 대상 모두 수집기가 거름.

## 단계 1 — 메뉴 재배치 (2026-11-14 토, 배포 끝)

- 커밋 `6a4b60b6`(화면 — `TABS`에서 한국 탭 없앰, 정보 검색 탭 + 자리 화면, `/radar`·`/krx`는 더보기 탭의 `group: "한국 시장"`, 하위 메뉴 줄은 같은 묶음만,
  통합 검색은 검색어 '한국'·보조 글 '한국 시장', 더보기 화면은 '메뉴' 다음 '한국 시장' 묶음, 아이콘) · `f42eb980`(README·ARCHITECTURE·UI 설계서·ADR 0036 개정 메모).
- 시험: 먼저 고친 nav·Shell·MoreMenu 시험이 실패하는 것을 본 뒤 구현. `make test` 통과(수집기 2,524 통과·36 건너뜀, 백엔드 3,287, 화면 2,178).
  독립 검토 에이전트 1개: 큰 결함 없음(사소한 넷 — `subNav`의 늘 참인 조건 줄이기·자리 화면 문구는 단계 2에서 고침, 더보기 화면이 다른 묶음 값을 그리지 않는 것·
  통합 검색 결과의 레이더 아이콘이 더보기 아이콘인 것은 그대로 둠).
- main `f42eb980` push → CI 6/6 → **17:14 KST Vultr 배포**(`deploy.sh` — 화면 컨테이너만 새로 뜸), 컨테이너 6개 정상, 백엔드·화면 로그 오류 0,
  ts.net `/search`·`/more`·`/radar` 200.

## 단계 2 — 정보 검색 1판 (2026-11-14 토)

- 계약을 먼저 고정: [2026-11-14-info-search-contract.md](2026-11-14-info-search-contract.md)(대상 키·경로·응답 모양·규칙). 구현은 워크플로 `wf_cbd97f75-01d` —
  수집기·백엔드·화면 에이전트 셋이 나뉜 파일만 고침(같은 작업 트리, 커밋 없음, 백엔드는 따로 만든 시험 DB `macrodash_b_test`) → 영역마다 검토 둘(계약·규칙 관점,
  정확성·시험 관점) → 영역마다 고치는 에이전트 → 영역 간 계약 대조 에이전트(13개).
- 검토에서 고친 것(주요): 사용자가 허용한 매체(대만·Investing.com·StreetInsider·SCMP)가 제외 목록에 남아 있던 것(구현 중에 사용자 결정이 와서 — 시험을 뒤집어 고정),
  해외 거래소 티커가 엉뚱한 미국 종목 키가 되던 것(LVMH 'MC' → Moelis — 거래소별 티커만), 키 없는 로컬 후보가 같은 이름의 Wikidata 사람을 지우던 것,
  resolve에 시간 상한이 없던 것, 회원 응답에서 출처 칸이 없는 줄 하나가 500을 내던 것(백엔드 `hideOwnerOnly` — 닫힌 실패로), 모든 출처가 실패해도 '자료가 없습니다'로
  보이던 것(받은 출처가 없으면 '모릅니다' + 받지 못한 출처 한 줄), 단독 링크의 누름 자리 44px, 범위 블록의 바탕·글자색이 레이어 밖에서 대화상자 `bg-surface`를 이기던 것.
- 대조에서 직접 고친 것: Wikidata의 사람·조직이 아닌 항목(종류 `topic`, 키 `wd:`)을 화면이 '주제로 찾기'로 보이던 것(`isTopicSearch` — 출처·키로 가름),
  맨 끝 주제 후보의 부제 '주제' 겹침(null), 세 층의 키 문법 차이(티커 15자·QID 0으로 시작 안 함·제어 글자 400 — 수집기의 400이 '응답 없음'으로 바뀌던 것).
- 계약을 구현에 맞게 고친 곳: `wd:` 종류에 `topic`, 캐시는 출처마다(결과 전체 캐시 없음, `external=false`는 읽기만), 대상 이름은 4글자 미만이어도 검색식에,
  빈 결과 안내 두 줄 더함.
- 시험: `make test` 통과(수집기 2,712 통과·36 건너뜀, 백엔드 3,319, 화면 2,319). 새 시험 — 수집기 `test_search_{rules,sources,entity,store,api}.py`,
  백엔드 `SearchServiceTest`·`SearchControllerTest`·`CollectorClientSearchLogTest`, 화면 `infoSearch.test.ts`·`searchTheme.test.ts`·`SearchScreen.test.tsx`·
  `useInfoSearch.test.tsx`.
- 이 PC에서 실제 출처로 한 번(수집기 에이전트, 응답 원문은 남기지 않음): `wd:Q182477` → `us:NVDA`, 뉴스 탭 약 4초에 출처 5곳 ok, Ken Griffin 후보가 사람·주제로 나뉨.
  Wikidata가 짧게 약 15건에 429 → 요청 사이 1초 넘게(서버에서는 배포 뒤 확인).
- 남긴 한계: 영문이 섞인 국내 새 종목 코드는 `kr:` 키로 받지 않음, 수집 글 본문 검색은 색인 없이 문 시간 3초·200건, 시간 상한을 넘긴 출처 호출은 끝날 때까지 스레드로 남음.
- 브랜치 CI 6/6(`63e8ff01`) → main ff push → **18:37 KST Vultr 배포**(`deploy.sh`, 컨테이너 6개 정상). QA 스택(로그인 없는 모드)에서 첫 화면·대상 화면(1440px, 앱 밝음)·
  휴대폰(390px) 캡처 — 밝은 셸 옆 어두운 내용 영역, 세 칸(좁은 화면은 한 칸 + 거르기 단추), 출처가 막히면 '실패'와 사유가 출처 상태 줄에 보임.
- 서버 실측(18:4x KST, ts.net에서 운영자로 한 번씩): `suggest '삼성'` 12건(DART 저장본만), `resolve 'Ken Griffin'` 후보 9(동명이인·주제 갈림, 오류 0),
  `entity us:NVDA` → 한글 이름 엔비디아·CIK·Wikidata Q182477·연결 16, `feed us:NVDA timeline` 619건(구글 한 97·영 99, Yahoo 20, 연합인포맥스 99, 사건 뉴스 159,
  속보 106, 수집 글 38, 거장 1 — 2년 밖·중국어·제외 0), `feed kr:005930 news` 319건, `feed wd:Q3195170 timeline` 54건(7일 12·30일 20·1년 48 — 한국어 이름이 없어
  구글 한국어 판은 '건너뜀'). Wikidata 429 없음.
- **발견 — Bing은 늘 0건**: 서버에서 다시 재 보니 Bing 뉴스 RSS는 `"A" OR "B"` 모양(괄호 포함)과 아주 흔한 한 단어(`NVIDIA`, 따옴표 있든 없든)에 0건을 주고,
  여러 단어 구문(`"Nvidia Corp"` 11·`"Duquesne Family Office"` 11·`"Ken Griffin"` 10)과 한글 이름(`삼성전자` 8·`엔비디아` 2)에는 줍니다. 단계 3 뒤에 고침 —
  Bing은 판마다 구문 하나(여러 단어 이름 먼저), 0건이면 다음 별칭으로 한 번 더(판마다 최대 2번).

## 단계 3 — 새 피드 묶음 · 관심 대상 · 매체 제외 표 (2026-11-14 토)

- 워크플로 `wf_82299748-ba0`(층마다 구현 1 → 두 갈래 리뷰 → 고침 1, 마지막에 통합 점검 1 — 에이전트 13). 리뷰가 찾아 고친 것:
  - 수집기: 저장 id(제목 앞 24자 → 경유 주소의 기사 경로 해시), 예산 소진의 거짓 끊김, 일정 줄 이름에 대표 키(→ 해시), 깰 때마다 표 전체 정리, 등록 때의 이름 둘,
    뉴스 탭에 섞인 수집 글
  - 백엔드: `store_only` 등록, 상한에서 다른 키로 같은 대상, 반쯤 풀린 대상 저장(→ 503), 시각 없는 글의 정렬, API 문서
  - 화면: 최근 글의 `errors`, 새로 받기 실패가 결과를 덮음, 결과 전에 '봤음', 국제화 도메인, 매체 이름 공백
- 통합 뒤 고친 것(이 세션):
  - 국제화 도메인 대조(수집기가 punycode로 맞춤)
  - 실패한 새로 받기가 10분 한 번을 씀
  - 주제 키의 가운데 공백(백엔드도 하나로)
  - 등록 직후 '새 글 100+'(작성 시각이 마지막으로 본 때 24시간 전보다 늦은 글만)
  - 처리량(4곳 → 6곳, 예산 300·150 → 600·600)
  - Bing 검색식(판마다 구문 하나, 0건이면 다음 구문으로 한 번 더)
  - 태스크 수 66 → 68, DATA_SOURCES·ARCHITECTURE·계약 §6·ADR 단계 3 절

- 통합 수정분 리뷰(워크플로 `wf_f6ebf107-17a` — 세 갈래 + 지적마다 반박 검증 1, 에이전트 14). 확인된 것 7건을 고침:
  - 보낼 질의가 없는 주제(따옴표뿐)도 예산·간격을 씀
  - 태스크 설명의 '4곳'
  - 주제 키 앞뒤의 줄바꿈 없는 공백(Java `strip`이 못 지움 → 접은 뒤에 지움)
  - README `/search` 행
  - DATA_SOURCES의 `[우회]` 표지(받는 길은 공용 세션)
  - recent `errors`는 빈 객체
  - 등록 503의 reason 구분과 처리량 숫자(틱 지연을 넣으면 하루 약 250곳, 구글 예산은 처리량 상한이 먼저 걸림)
- 새 글 수의 기준은 '마지막으로 본 때 24시간 전'과 '등록 시각' 가운데 늦은 것으로 정함(등록할 때 본 글은 새 글이 아님).
- IDNA2003/2008 차이(ß 등)는 화면이 WHATWG URL(IDNA2008)로 punycode를 만들어 보내므로 실제 입력 경로에서는 닿지 않음 — 반박됨.

- **20:3x KST Vultr 배포**(main@0a92407c, CI 6/6). V37 적용(`schema_migrations` 37), `search_feeds`가 피드 12개의 첫 일정을 잡음(첫 요청 20:34). 서버에서 고친 Bing 재기:
  삼성전자 한 9·영 11, Ken Griffin 영 9, 엔비디아 한 5건 — 엔비디아 영어 판은 여전히 0건(이름이 `NVIDIA` 하나)이라 `"NVIDIA" NVDA` 9·`NVIDIA stock`·`"NVIDIA Corporation"` 12·
  `"Apple" AAPL`·`"Tesla" TSLA` 12건을 재고, 미국 종목 영어 판의 한 단어 구문에 티커를 붙이도록 고침. 이 측정 중 수집기 컨테이너의 별도 파이썬 과정에서 대상 풀기를
  짧게 네 번 하다 Wikidata 429를 한 번 받음(그 과정 안의 래치만 — 운영 수집기 과정과 따로).

- QA 스택 브라우저 확인(단계 3, 1440·390, 운영자, 합성 자료 — 에이전트 1).
  - 기대대로 된 것:
    - 첫 화면(관심 대상·새 글 n·상한 줄·최근 글 KST 날짜 묶음·'받은 시각')
    - 매체 제외(펼칠 때만 읽음, IDN → punycode 전송, 중복 알림, 지우기)
    - 별 단추 등록·해제, 타임라인을 그린 뒤 '봤음' 1회
    - 새로 받기 두 번째 거절 문구, 409·503 안내, /info '보도자료·경제지' 보기
    - 대비 4.5:1 미만 0건, 390 가로 넘침 0, 콘솔 오류 0
  - 찾은 것(단계 4 화면 작업 뒤 고침):
    - [중] 관심 대상 50개면 목록이 2,200px로 늘어 거르기·최근 글이 밀림
    - [하] 매체 제외를 더해도 최근 글을 다시 읽지 않음
    - [하] IDN 도메인이 punycode로만 보임
    - [하] 390에서 메모 칸이 눌림
    - [하] `www.` 하위 도메인이 따로 더해짐
    - [참고] 새로 받기 문구가 일부 출처 실패를 말하지 않음
    - [참고] world 보기의 '보관 90일'이 빈 목록에서만 보임
    - [참고] 390 대상 화면에서 새 글 수를 볼 수 없음
- 서버(20:34~): `search_feeds`가 Bloomberg 20·CNBC 금융 30건부터 받기 시작, `search_watch`는 첫 실행 20:44(등록된 대상 없음).

## 단계 4 — 공시 · 리서치 · 연결 보강 (2026-11-14 토)

- 계약 §7을 먼저 고정:
  - 날짜만 아는 줄은 `timeBasis:"date"`.
  - 공시 탭 출처는 SEC 회사별 submissions, EDGAR 이름 전문 검색(사람·기관), DART `list.json`(최대 200건).
  - 리서치 탭 출처는 Yahoo 투자의견 변경과 네이버 리포트(상세 응답 그대로).
  - 연결은 새 경로 `/api/search/links`로 따로 받습니다. Yahoo 내부자 명단과 GLEIF 모회사·최상위 모회사·자회사이고, LEI는 Wikidata P1278에서 얻습니다.
  - 관심 대상 정기 수집에 SEC·EDGAR·DART 공시를 더합니다. 하루 예산은 data.sec.gov 600·efts.sec.gov 300·opendart 600입니다.
- GLEIF는 이름 검색 대신 Wikidata LEI로만 찾습니다. 단계 0 실측에서 `Samsung Electronics` 이름 검색의 첫 결과가 해외 자회사였기 때문입니다.
- 워크플로 `wf_6a2c1ff5-458`(층마다 구현 → 두 갈래 리뷰 → 고침, 통합 점검 — 에이전트 13). 리뷰가 찾아 고친 것:
  - 수집기:
    - Wikidata를 읽지 못했는데 GLEIF를 'LEI 없음'으로 단정함(→ offline·error)
    - 전문 검색 두 번째 구문 실패가 '빈 결과'로 15분 캐시됨
    - 설정 없는 공시 질의가 예산을 씀
    - 모은 공시 줄이 실시간 출처 건수를 빼앗음
    - 빈 내부자 명단이 15분 캐시됨
  - 백엔드: API.md의 Link `detail`
  - 화면:
    - 상장되지 않은 기업에도 리서치 탭이 열림
    - Wikidata 실패를 '연결 없음'으로 보임
    - 같은 연결이 두 줄로 나옴
    - 다시 받기 중에도 실패 글이 남음
- 통합 뒤 고친 것:
  - **SEC `acceptanceDateTime`은 UTC**: 서버에서 엔비디아 8-K 한 건으로 대조했습니다. submissions 값 `2026-11-12T13:52:41.000Z`가 색인 쪽 'Accepted 2026-11-12 08:52:41'(EST)과 같은 순간이었습니다. 구현 초안은 미국 동부 벽시계로 읽어 5시간 어긋났습니다.
  - 대상 풀기 시간 초과를 화면이 '연결 없음'으로 단정함.
  - 상장되지 않은 기업의 타임라인에 리서치 건너뜀 줄이 남음.
  - 주제 관심 대상의 `ids`에 `lei` 칸이 없음.
- 받아들인 한계: 날짜만 아는 공시는 등록한 날 접수분을 새 글로 세지 않습니다.


## 남은 확인

- (닫힘, 2026-11-14 사용자 결정) 대만 매체·StreetInsider·Investing.com·South China Morning Post·소유가 불확실한 매체(Webull·Tiger·AInvest 등)는 수집 허용 —
  제외 목록에서 뺐고, 지금 쓰는 Investing.com 사건 뉴스 RSS 넷(모의 매매 패킷 입력)·정보 수집·종목 상세 링크도 그대로 둡니다.
- Finviz 시각의 시간대(미국 동부로 보임) — 단계 5에서 원문 기사 시각과 몇 건 대조.
