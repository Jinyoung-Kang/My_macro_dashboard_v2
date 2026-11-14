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
- 홍콩: SCMP(`scmp.com`·`inkstonenews.com`), The Standard(`thestandard.com.hk`), RTHK(`rthk.hk`), Hong Kong Free Press(`hongkongfp.com`), Asia Times(`asiatimes.com`),
  EJ Insight(`ejinsight.com`·`hkej.com`), HKET(`hket.com`), AASTOCKS(`aastocks.com`), ETNet(`etnet.com.hk`), Mingtiandi(`mingtiandi.com`),
  Dimsum Daily(`dimsumdaily.hk`), Phoenix(`ifeng.com`), Week in China(`weekinchina.com`)
- 마카오: Macau Business(`macaubusiness.com`), Macau Daily Times(`macaudailytimes.com.mo`), GGRAsia(`ggrasia.com`), Inside Asian Gaming(`asgam.com`),
  Macau News Agency(`macaunews.mo`)
- 대만: Focus Taiwan·CNA(`focustaiwan.tw`·`cna.com.tw`), Taipei Times(`taipeitimes.com`), Taiwan News(`taiwannews.com.tw`), DigiTimes(`digitimes.com`·
  `digitimes.com.tw`), TrendForce(`trendforce.com`), CommonWealth(`cw.com.tw`), Taiwan Today(`taiwantoday.tw`), RTI(`rti.org.tw`), The China Post(`chinapost.com.tw`),
  BigGo(`biggo.com` — 실측에서 `finance.biggo.com`)
- 중국 자본 금융 매체: Investing.com(`investing.com`), StreetInsider(`streetinsider.com`), Futu·moomoo(`moomoo.com`·`futunn.com`·`futuhk.com`·`futuholdings.com`)
- 처음 값에 넣지 않고 보고(불확실): Webull, Tiger Brokers(UP Fintech), KrASIA, China Briefing, AInvest, Bamboo Works, The News Lens
- 비중국 매체의 중국어 판(`cn.wsj.com`·`cn.nytimes.com`·`ftchinese.com`·`zh.cn.nikkei.com`·`fxstreet.cn`)은 중국어 제목 거름과 `.cn` 규칙이 잡고,
  잡지 못하는 도메인은 목록에 넣음.

### 고친 설계와 이유

- 새 피드 묶음은 **12개**(FXStreet 뺌 — 서버 403, D-11). Nikkei Asia는 시각 칸이 없어 처음 받은 시각('받은 시각' 표시)으로.
- 연결 탭의 '임원'은 yfinance 임원 목록이 비어 있어 **내부자 명단**(`insider_roster_holders` — 이름·직위)으로 대신(단계 4).
- Finviz 결과의 회원 노출은 D-1(회원 등급)을 따르되 ADR 0026 결정 10을 고치는 것이라 ADR 0041 결정 10에 적음.
- 관심 대상 글 표는 D29 재개정('robots 출처는 저장하지 않음')을 고치는 것이라 ADR 0041 머리에 적음(사용자 결정 D-4).
- 매체 제외 목록: 처음 값(코드에 둔 확실한 목록 — 위) + 사용자가 더하는 표(단계 3 마이그레이션에 함께). 즉석 검색·관심 대상 모두 수집기가 거름.

## 남은 확인

- 사용자 결정 거리(보고에 적음): Investing.com·StreetInsider(중국 자본)를 지금 쓰는 곳(사건 뉴스 RSS 넷 — 모의 매매 패킷 입력, 정보 수집, 종목 상세 링크)을 어떻게
  할지 · 불확실한 매체(Webull·Tiger·AInvest 등)를 제외 목록에 넣을지 · 대만 매체 제외로 반도체 검색 결과가 줄어드는 것.
- Finviz 시각의 시간대(미국 동부로 보임) — 단계 5에서 원문 기사 시각과 몇 건 대조.
