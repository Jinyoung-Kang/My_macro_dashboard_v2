# 정보 검색 계약 — 대상 키 · 경로 · 응답 모양 · 규칙 (2026-11-14, 단계 2 기준)

[ADR 0041](../adr/0041-info-search-watch.md)의 결정을 수집기·백엔드·화면이 같은 모양으로 구현하도록 고정한 계약입니다. 단계 3~5에서 칸을 **더하기만** 합니다
(지울 때는 이 문서와 ADR에 적음). 시각은 모두 UTC ISO(`YYYY-MM-DDTHH:MM:SS+00:00`, `datetime.astimezone(timezone.utc).isoformat(timespec="seconds")` —
문자열 정렬이 시간 순서와 같아야 함), 화면은 KST로 보입니다. 모르는 값은 `null`(0이나 빈 글로 채우지 않음).

## 1. 누가 무엇을 하나

| 층 | 하는 일 | 하지 않는 일 |
|---|---|---|
| 수집기 `services/search*.py` + `/live/search/*` | 대상 풀기(로컬 색인·Wikidata·SEC·DART 표), 출처 호출(공용 세션), 자기 표 읽기(사건 뉴스 관측치·`info_items`·거장 견해·13F 기관 목록), 합치기·같은 글 가리기·**2년 자르기**·**중국어 제목 거름**·**`.cn`·매체 제외 목록**·출처별 상태, 메모리 캐시 | DB에 쓰지 않음(단계 2). 검색어·경로를 로그에 남기지 않음(호스트만) |
| 백엔드 `feature/search` | 입력 검사(400), 등급(회원), 운영자 전용 줄 거르기(`CurrentUser.isOwner()`), 데모·`STORE_ONLY`면 `external=false`로 부름, 중계(`CollectorClient`) | 자르기·거르기 규칙을 다시 구현하지 않음(수집기가 원본) — 다만 운영자 전용 줄은 백엔드가 한 번 더 거름(이중 방어) |
| 화면 `/search` | 주소 상태, 기간 단추(받은 2년 묶음에서 화면이 자름 — 다시 부르지 않음), 날짜 묶음·정렬, 세 칸·어두운 범위 토큰, 키보드 | 출처를 직접 부르지 않음 |

## 2. 대상 키(`e`)

| 모양 | 종류 | 예 | 풀기 |
|---|---|---|---|
| `us:<티커>` | company | `us:NVDA` | SEC 티커 표 → CIK·이름, Wikidata(CIK `P5531` 또는 이름) |
| `kr:<6자리>` | company | `kr:005930` | DART 고유번호 저장본(`kr.dart_corp_codes`) → 고유번호·이름, Wikidata(한국어 이름) |
| `cik:<10자리>` | institution | `cik:0001067983` | 13F 기관 목록(이름·운용자), Wikidata(이름) |
| `wd:<QID>` | person · company · institution · topic(사람·조직이 아닌 항목 — 개념·글 등, 대상으로 엶) | `wd:Q3195170` | Wikidata(라벨·별칭·설명·관계), 관계에 CIK·티커가 있으면 그 식별자도 |
| `topic:<글>` | topic | `topic:AI 반도체` | 풀지 않음 — 입력 그대로 구문 검색 |

- 키 글자: 티커는 영문 대문자·숫자·`.`·`-` 1~15자, 국내 코드는 숫자 6자리(영문이 섞인 새 코드는 아직 받지 않음 — DART 저장본도 숫자 6자리만), CIK는 10자리,
  QID는 `Q` + 0으로 시작하지 않는 숫자 1~12자리, `topic:`은 1~60자이고 제어 글자 없음. 그 밖은 400(세 층이 같은 문법).
- 같은 대상이 여러 키로 올 수 있습니다(예: `wd:Q182477`과 `us:NVDA`). 풀린 대상의 `ids`에 서로의 식별자가 실리고, 관심 대상 등록(단계 3)은 **대표 키**로 합니다 —
  상장사는 `us:`/`kr:`, 13F 기관은 `cik:`, 그 밖은 `wd:`, 주제는 `topic:`(응답의 `entity.key`가 대표 키).

## 3. 경로(백엔드 — 모두 회원, `GET`)

- 백엔드는 수집기 응답에 `"available": true`를 더해 그대로 돌려줍니다. 수집기에 닿지 못하면 `{"available": false, "message": "수집기에서 응답을 받지 못했습니다."}`
  (상세 화면 `DetailService.relay`와 같은 말). 입력이 틀리면 400(`support.InvalidRequestException`).
- 수집기 경로는 같은 이름의 `/live/search/<이름>`이고 백엔드가 `external`(데모·`STORE_ONLY`면 `false`)·`owner`(운영자면 `true`)를 붙입니다.

### 3-1. `GET /api/search/suggest?q=` — 치는 동안의 후보(외부 호출 없음)
- `q` 1~60자(앞뒤 공백 제거). 수집기 `GET /live/search/suggest?q=`가 **이미 가진 색인만**(DART 고유번호 저장본·SEC 티커 표의 저장본/메모리·13F 기관 목록·거장 목록·
  모의 유니버스 등 — 외부로 받지 않음) 찾아 최대 12개.
- 응답 `{ "items": [Candidate], "fetchedAt": iso }`

```
Candidate = {
  "key": "us:NVDA" | null,     // 2절의 키. 식별자가 없는 이름(거장·운용자 이름 등)은 null — 고르면 화면이 그 이름으로 3-2(resolve)를 부름
  "kind": "company" | "institution" | "person" | "topic",
  "name": "엔비디아",           // 보이는 이름(한국어가 있으면 한국어)
  "sub": "NVDA · 미국",          // 식별자 한 줄(티커·시장·CIK·'13F 기관'·'거장' 등) — 없으면 null
  "source": "sec" | "dart" | "13f" | "guru" | "universe" | "wikidata" | "topic"
}
```

### 3-2. `GET /api/search/resolve?q=` — Enter를 눌렀을 때의 후보(외부 호출 있음 — Wikidata 검색, 1시간 캐시)
- 3-1의 로컬 후보 + Wikidata `wbsearchentities`(한글이 있으면 `language=ko`, 아니면 `en` — 다른 언어 없음) 후보를 합쳐 최대 15개, 맨 끝에 언제나 `topic:<q>` 하나.
- Wikidata 후보 중 설명·라벨이 중국어뿐인 것은 뺍니다. 같은 대상(로컬 후보와 이름이 같고 Wikidata 설명이 회사·사람과 맞음)을 둘로 보이지 않게 합니다(완벽하지 않아도 됨 — 동명이인은 남김).
- 응답 `{ "items": [Candidate], "errors": {source: reason}, "fetchedAt": iso }`. 화면은 `topic`을 뺀 후보가 정확히 하나이고 이름이 입력과 같으면 바로 열고, 아니면 목록을 보입니다(자동으로 고르지 않음).

### 3-3. `GET /api/search/entity?e=` — 대상 풀기(외부 호출 있음 — Wikidata `wbgetentities`·SEC·DART 표, 하루 캐시)

```
{ "entity": Entity | null, "errors": {source: reason}, "fetchedAt": iso }

Entity = {
  "key": "us:NVDA",                  // 대표 키
  "kind": "company" | "institution" | "person" | "topic",
  "name": "엔비디아", "nameKo": "엔비디아" | null, "nameEn": "NVIDIA Corp" | null,
  "aliases": ["NVIDIA", "Nvidia", "엔비디아"],   // 검색식에 쓰는 별칭(ko·en만, 중국어 없음, 중복 없음)
  "description": "미국의 반도체 기업" | null,      // Wikidata 설명(ko 우선, 없으면 en)
  "ids": { "ticker": "NVDA"|null, "market": "us"|"kr"|null, "stockCode": "005930"|null,
           "cik": "0001045810"|null, "dartCorpCode": "00126380"|null, "wikidata": "Q182477"|null },
  "links": [Link],                    // 연결 탭(가진 것만 — 단계 2는 Wikidata 관계 + 13F 운용자↔기관)
  "sources": ["sec", "wikidata"]      // 이 대상을 푸는 데 쓴 출처
}
Link = { "relation": "owner_of" | "owned_by" | "founded_by" | "founder_of" | "employer" | "employee" | "ceo" | "ceo_of"
                     | "parent" | "subsidiary" | "manager" | "managed_by",
         "key": "wd:Q…" | "cik:…" | "us:…" | null,  // 누르면 넘어갈 대상(없으면 null — 누르면 그 이름으로 3-2를 부름)
         "name": "…", "kind": "company"|"institution"|"person"|null, "source": "wikidata" | "13f" }
```

- 관계 이름: `owner_of`(P1830 소유) · `owned_by`(P127) · `founded_by`(P112) · `founder_of`(P112 역) · `employer`(P108 — 사람의 소속) · `ceo`(P169 — 회사의 대표) ·
  `parent`(P749) · `subsidiary`(P355) · `manager`(13F 기관의 운용자) · `managed_by`(운용자의 기관). 관계 대상의 이름은 ko·en 라벨만.
- `topic:` 키는 외부를 부르지 않고 `{kind:"topic", name:<글>, aliases:[<글>], ids 모두 null, links: []}`.

### 3-4. `GET /api/search/feed?e=&tab=` — 결과(2년 묶음 한 번에)
- `tab`: `timeline` · `news` · `posts`(운영자) · `filings`(단계 4 — 7절) · `research`(단계 4 — 7절, 단계 2·3에서는 빈 목록 + 상태 `later`). 보유·연결 탭은 이 경로를 쓰지 않음
  (보유는 기존 13F 경로, 연결은 3-3의 `links`).
- 기간 인자 없음 — 응답은 **오늘(KST)부터 2년 안의 줄 전부**이고 화면이 7일·30일·1년·2년으로 자릅니다.

```
{
  "entityKey": "us:NVDA",
  "tab": "news",
  "items": [FeedItem],                     // 작성 시각(없으면 받은 시각) 최근부터, 2년 안만
  "sources": [SourceStatus],               // 출처마다 한 줄 — 실패를 빈 목록으로 숨기지 않음
  "window": { "from": "2024-11-14", "to": "2026-11-14" },   // KST 날짜
  "rangeCounts": { "7d": n, "30d": n, "1y": n, "2y": n },   // 받은 자료 기준
  "olderOnlyLatest": "2023-05-02" | null,  // 2년 안에 하나도 없고 출처가 2년보다 오래된 줄만 줬을 때 그중 가장 최근 날짜(KST)
  "pending": false,                        // 받는 중인 출처가 있으면 true(단계 5 Finviz) — 화면은 몇 초 뒤 다시 부름
  "fetchedAt": iso
}

FeedItem = {
  "id": "…",                 // 같은 글 가리기 키(정규화 원문 주소 해시, 없으면 제목 키)
  "kind": "news" | "headline" | "post" | "opinion" | "wire" | "filing" | "research",
  "title": "…",
  "url": "https://…" | null, // 원문(구글은 경유 주소 그대로, Bing은 인자에서 꺼낸 원문)
  "publisher": "Reuters" | null,
  "publisherDomain": "reuters.com" | null,
  "publishedAt": iso | null,
  "timeBasis": "published" | "fetched",   // fetched = 처음 받은 시각(시각 칸 없는 피드)
  "source": "google_ko" | "google_en" | "bing" | "yahoo" | "naver" | "infomax" | "event_news" | "info" | "guru" | "wire",
  "lang": "ko" | "en" | null,
  "summary": "…" | null,      // 출처가 준 요약(짧은 상한 300자) — 본문 아님
  "readerId": "…" | null      // 수집 글(info_items)의 id — 운영자 화면의 원문 팝업용, 그 밖에는 null
}

SourceStatus = {
  "source": "google_ko",
  "label": "구글 뉴스(한국어)",
  "status": "ok" | "empty" | "error" | "cached" | "skipped" | "owner_only" | "offline" | "later" | "pending" | "server_only",
  "count": n,                       // 이 출처에서 남은 줄 수(거른 뒤)
  "dropped": { "old": n, "noTime": n, "chinese": n, "excluded": n },   // 거른 건수(받은 자료 기준)
  "message": "…" | null            // 실패 사유·안내(경로·검색어 없이)
}
```

- 출처와 탭: `news` = 구글(ko·en)·Bing·사건 뉴스 저장본(`news_headline`·`kr_news_headline` — 보관 7일), 종목이면 Yahoo(`relatedTickers`에 그 티커가 있는 줄만)·네이버 종목 뉴스·
  연합인포맥스. `posts`(운영자) = 수집 글(`info_items`의 블로그·waedge — 제목·한국어 제목·요약·본문에서 별칭 찾기, 건수 상한 200·문 시간 상한)·거장 견해. 속보(`wire`)는
  운영자에게만 `timeline`·`news`에 섞습니다. `timeline` = 그 대상에 허락된 모든 탭의 합.
- 운영자 전용 줄(`source` = `info`·`guru`·`wire`)은 백엔드가 회원에게서 지웁니다(상태 줄은 `owner_only`, 건수 0). `posts` 탭을 회원이 부르면 403.
- `external=false`(데모·`STORE_ONLY`): 외부 출처는 부르지 않고 상태 `offline`, 저장본·캐시만.
- 캐시: 출처마다 성공 15분·실패 60초(결과 전체 캐시는 없음 — 운영자 전용 출처는 운영자 요청에서만 부름). `external=false`는 캐시를 읽기만 하고 쓰지 않습니다.
  대상 풀기는 하루(캐시 키에 `external` 포함), resolve는 1시간.

## 4. 규칙(수집기가 원본 — 시험으로 고정)

1. **2년 자르기**: 창 시작 = 오늘(KST) − 2년의 날짜 00:00 KST. 작성 시각이 창 시작보다 이르면 `dropped.old`(가장 최근 날짜를 기억 — `olderOnlyLatest`),
   시각을 모르면(정기 피드의 처음 받은 시각도 없으면) `dropped.noTime`. 미래 시각(지금 + 1일 넘음)은 시각 모름으로 봅니다.
2. **중국어 제목**: 제목에 한글(가-힣)이나 가나(ぁ-ヿ)가 하나라도 있으면 남김. 그렇지 않고 한자(一-鿿) 2자 이상이고 한자 / (한자 + 라틴 글자) ≥ 0.3이면 뺌(`dropped.chinese`).
   한국어 제목의 한자(예: `이재용 회장, 日 R&D`)와 일본어 제목은 남아야 함(시험).
3. **매체 제외**: 매체 도메인이 `.cn`으로 끝나거나, 제외 목록의 도메인과 점 경계로 같으면(`host == d` 또는 `host.endswith("." + d)`), 또는 매체 이름이 목록의 이름과
   대소문자 무시 완전 일치면 뺌(`dropped.excluded`). 처음 목록은 진행 기록 '매체 제외 목록의 처음 값'(코드 상수), 사용자가 더하는 표는 단계 3.
   도메인은 구글 `<source url>`의 호스트, Bing은 링크 인자 `url`의 호스트, 그 밖은 링크 호스트. 국제화 도메인은 대조할 때 punycode(`xn--`)로 맞춥니다(단계 3 —
   화면·백엔드가 사용자 제외 도메인을 그 모양으로 저장).
4. **같은 글**: 원문 주소가 있으면 `info_text.item_id(url)`, 경유 주소(구글)뿐이면 `re.sub(r"\W+", "", title.lower())[:24]`. 먼저 온 것(출처 우선순위: 저장본 > Yahoo·네이버 >
   Bing > 구글)을 남깁니다.
5. **검색식**: 따옴표 구문을 ` OR `로 묶음. 한국어 판(구글 `hl=ko&gl=KR&ceid=KR:ko`)은 한글 이름·한글 별칭, 영어 판(`hl=en-US&gl=US&ceid=US:en`)은 영문 이름·영문 별칭.
   네 글자 미만의 별칭과 티커는 자유 검색어에 넣지 않음(티커는 종목 뉴스 출처에만). 대상의 이름 자체는 길이와 상관없이 넣음(예: '카카오' — 이름까지 빼면 묻지 못함). 별칭은 판마다 최대 4개(긴 이름 우선). 구글에는 `after:<창 시작 날짜>`를 붙입니다(믿지 않고 1번으로 다시 자름).
   **Bing은 예외**(단계 3, 서버 실측 2026-11-14 — `"A" OR "B"` 모양과 아주 흔한 한 단어 `NVIDIA`에 0건, 여러 단어 구문·한글 이름에는 줌): 판마다 따옴표 구문 하나를
   묻고(여러 단어 구문 먼저, 같으면 위 순서), 0건이면 다음 구문으로 한 번 더(판마다 최대 2번, 실패하면 다시 묻지 않음 — `search_sources.bing_queries`).
   미국 종목의 영어 판은 한 단어 구문에 티커를 따옴표 밖에 붙임(`"NVIDIA" NVDA` — 서버 실측 `"NVIDIA"` 0건·`"NVIDIA" NVDA` 9건·`"Apple" AAPL` 12건; 티커는 검색을 넓히지 않고 좁힘).
6. **로그**: 검색어·경로·인자를 남기지 않음. 오류 글은 호스트와 상태 코드만(`http.host_of`).

## 5. 화면

- 주소: `/search?q=<글>`(후보 보기) · `/search?e=<키>&tab=<탭>&range=<7d|30d|1y|2y>`(기본 탭 `timeline`, 기본 기간 `30d`). 대상을 바꾸면 기록에 쌓고(뒤로 가기),
  탭·기간은 바꿔 씀.
- 고른 기간에 없으면 '이 기간에는 자료가 없습니다' + 더 넓은 기간 단추(그 기간의 건수와 함께), 2년 안에 없으면 '최근 2년 안의 자료가 없습니다'(+ `olderOnlyLatest`가 있으면
  '가장 최근 자료: YYYY-MM-DD'). 답한 출처(ok·cached·empty)가 하나도 없으면 '받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다', 받지 못한 출처(error·offline·
  pending·server_only)가 있으면 안내에 그 출처를 적은 한 줄을 덧붙입니다(실패를 '없음'으로 보이지 않게 — 지시문 §8).
- `timeBasis`가 `fetched`인 줄은 시각 옆에 '받은 시각'.
- 보유 탭: 회사는 `GET /api/guru/holders?q=<티커 또는 이름>`, 기관은 `GET /api/sec13f/portfolio?cik=` — 가장 최근 보고가 2년보다 오래면 같은 안내.
- 출처 상태 줄: `sources`를 그대로(이름 · 상태 글 · 건수 · 거른 건수), 색만으로 구분하지 않음.

## 6. 단계 3 — 새 피드 묶음 · 관심 대상 · 매체 제외 표 (2026-11-14 추가)

### 6-1. 새 피드 묶음(수집기 flex 태스크 `search_feeds`)

- 피드 12개(ADR 0041 결정 8 — FXStreet 뺌). 모듈은 `services/news.py`의 `FEEDS`·`KR_FEEDS`와 **다른 모듈·다른 이름**(예: `services/search_feeds.py`의 `SEARCH_FEEDS`) —
  사건 뉴스 시험(`CADENCES` 키 = `FEEDS ∪ KR_FEEDS`, `NewsFeedsParityTest`)과 패킷에 섞이지 않게. `news.Feed`·조건부 요청(`fetch_feed_conditional`)은 재사용하고,
  피드 읽기는 자체 파서(`search_feeds.parse` — feedparser 직접)를 씁니다: `news.parse_feed`는 시각 없는 글을 버려 Nikkei가 통째로 빠지고, 요약에 본문 칸
  (`content:encoded`)을 2,000자까지 고릅니다. 간격 규칙(다음 시각·하한·물러남)은 `tasks/search_feeds`에 따로 둡니다(`news_feeds.CADENCES`는 사건 뉴스만).
- 받기: ADR 0040과 같은 flex 방식(피드마다 `fetch_schedule`의 `search_feeds/<피드>` 줄, 무작위 간격, 처음엔 2~25분 흩기, 하한 10분, 거부되면 그 피드 간격 두 배(최대 8배),
  같은 호스트는 차례로 2~5초 + 세션 간격 — CNBC 두 피드). 간격(분): 연준·ECB·영란은행 120~240, BBC 90~180, Economist 180~360, Bloomberg·CNBC 금융 60~120,
  CNBC 세계 90~180, Nikkei Asia 60~120, MarketWatch·Benzinga 45~90, Seeking Alpha 30~60. 로컬에서도 돕니다(공용 세션 — 사건 뉴스와 같음).
- 저장: 새 관측치 데이터셋 `search_feed_headline`(엔티티 = 같은 글 키 — 원문 주소 `info_text.item_id`, 없으면 제목 키), payload
  `{title, summary(description·summary만, 300자 — 본문 칸 안 씀), url, publisher(매체 이름 — 피드 설정의 이름), publisherDomain, feed(피드 키), publishedAt|null,
  fetchedAt(처음 받은 시각), timeBasis(published|fetched), lang:"en"}`. 2년 밖·중국어 제목은 넣지 않음. 보관 90일(정리 태스크). 상태 저장본 `search.feeds.status`
  (사건 뉴스 상태와 같은 피드별 줄). 데이터셋 이름은 `catalog.py`·`Datasets.java` 둘 다.
- 쓰는 곳: 정보 검색 `feed`의 저장본 출처(`source:"feeds"`, 라벨 '보도자료·경제지 피드' — 회원에게도), 첫 화면 최근 글(6-4), 관심 대상 대조(6-3).
  **모의 매매 패킷은 읽지 않음**(백엔드 `feature.paper`가 이 상수를 참조하지 않는다는 구조 시험 + 고정본 불변).
- 정보 수집 화면: 출처 표(`InfoSources`)에 한 줄(분류 뉴스·글, 종류 rss, 접근 공식 RSS), 뉴스·글 화면의 사건 뉴스 보기 옆에 세 번째 보기 '보도자료·경제지'
  (백엔드 `InfoService.headlines`의 `set` = `us`·`kr`·`world`).

### 6-2. 표(V37 — `db/migrations/V37__search_watch.sql`, 여러 번 실행해도 안전)

| 표 | 쓰는 쪽 | 칸 |
|---|---|---|
| `search_watches` | 백엔드 | `id bigserial PK`, `user_id bigint FK users ON DELETE CASCADE`, `entity_key text`, `kind text`, `name text`, `aliases jsonb`(문자열 배열), `ids jsonb`, `created_at timestamptz`, `last_seen_at timestamptz`, `UNIQUE(user_id, entity_key)` |
| `search_media_excludes` | 백엔드 | `id bigserial PK`, `kind text`(`domain`·`name`), `value text`(도메인은 소문자 호스트, 이름은 그대로), `note text`, `created_at timestamptz`, `UNIQUE(kind, lower(value))` |
| `search_watch_items` | 수집기 | `entity_key text`, `item_id text`, `kind text`, `title text`, `url text`, `publisher text`, `publisher_domain text`, `source text`, `lang text`, `summary text`, `published_at timestamptz NULL`, `first_seen_at timestamptz NOT NULL`, `PRIMARY KEY(entity_key, item_id)`, 색인 `(entity_key, coalesce(published_at, first_seen_at) DESC)`·`(coalesce(published_at, first_seen_at))`(2년 정리용) |
| `fetch_budgets` | 수집기 | `host text`, `purpose text`(`watch`·`search`), `budget_day date`, `budget_used int`, `updated_at`, `PRIMARY KEY(host, purpose)` — 즉석 검색·관심 대상의 호스트별 하루 예산(정기 polite 예산 `fetch_hosts`와 따로, 날이 바뀌면 그 줄을 0부터). `search` 용도는 단계 5(Finviz)부터 씀 — 단계 3의 즉석 검색은 사용자당 새로 받기 10분 1번과 같은 키 호출 묶기로만 막음 |

구현에서 더한 제약: `search_watches.kind`는 `company·institution·person·topic` CHECK, `aliases`는 배열 CHECK, `last_seen_at NOT NULL DEFAULT now()`,
`search_media_excludes.value`는 빈 글 CHECK, `fetch_budgets.budget_used >= 0`.

수집기는 `search_watches`·`search_media_excludes`를 읽기만 합니다(ADR 0008 — `paper_settings` 선례). 소유 시험 둘(`test_table_ownership.py`·`ArchitectureRulesTest`)을 함께 고칩니다.

### 6-3. 관심 대상 정기 수집(수집기 polite 태스크 `search_watch` — 서버에서만)

- 태스크 깨는 간격 `Cadence(20, 40)`분(본문이 끝난 뒤부터 재고 polite 틱 지연이 더해짐), 한 번에 때가 된 대상 최대 6개(하루 약 250곳 — 대상마다 3~8시간을 운영자
  상한 50곳까지 지킴, 서버 상한 100곳을 다 채우면 차례가 밀려 대상마다 9~10시간쯤). 처리량 상한이 먼저 걸려 구글은 하루 많아야 약 500건이고, Bing은 0건이라 두 번째
  구문을 묻는 일이 잦으면 예산이 바닥날 수 있음. 보낼 질의가 없는 대상(따옴표·공백뿐인 주제)은 예산·간격을 쓰지 않음. 대상마다 다음 시각은 `fetch_schedule`의 `search_watch/<대표 키의 md5 앞 16자>` 줄에 3~8시간(180~480분) 무작위 —
  줄 이름에 대표 키를 그대로 두지 않음(회원의 `topic:` 글이 운영자 메커니즘 화면에 드러나지 않게, ADR 0041 결정 12). 처음 등록된 대상(줄 없음)은 다음 깨기에서
  바로, 그다음 오래 기다린 대상. 여러 사용자가 같은 대상을 등록해도 한 번(대표 키 기준). 등록 표에는 이름 하나와 별칭만 있어, 등록 때의 이름 둘(한·영)은 별칭 앞쪽에서
  되살립니다(`watch_entity` — 즉석 검색과 같은 검색어).
- 한 대상의 처리: ① 저장본 대조(외부 0건 — 새 피드 묶음 90일·사건 뉴스 7일·속보·수집 글에서 별칭이 든 글: 영문은 단어 경계, 한글은 포함, 4글자 미만 별칭 안 씀)
  ② 외부 질의 — 구글 뉴스(한국어·영어 판)·Bing 뉴스(판마다 구문 하나, 0건이면 다음 구문으로 한 번 더 — 4절 규칙 5), 요청 사이 2~5초. 요청마다(Bing의 두 번째
  구문 포함) 호스트 하루 예산(`fetch_budgets`, purpose `watch`, KST 날짜): `news.google.com` 600·`www.bing.com` 600. 예산이 없으면 그 질의는 보내지 않고 그 대상은
  저장본 대조만 한 뒤 다음 시각을 잡음. 단계 4부터 SEC·DART, 단계 5부터 Finviz.
- 넣을 때 4절의 2년·중국어·`.cn`·매체 제외(코드 상수 + `search_media_excludes`)를 적용. 저장 id는 원문 주소면 `info_text.item_id(url)`, 경유 주소(구글)면 그
  기사 경로(`/rss/articles/<id>`, 인자 없음)의 같은 해시, 주소가 없으면 전체 제목의 해시 — 4절 규칙 4의 제목 앞 24자(한 요청 안의 임시 키)는 2년 보관 키로 쓰지
  않음(앞 24자가 같은 다른 기사를 막지 않게). 경유 주소·주소 없는 줄은 같은 실행이나 그 대상의 저장본에 전체 제목이 같은 글이 있으면 넣지 않음. 이미 있는 글은 처음
  받은 시각 그대로. 작성 시각이 없는 저장본 글(Nikkei 등)의 처음 받은 시각은 그 글을 처음 받은 시각.
- 정리: KST 하루 한 번 — 더는 아무도 등록하지 않은 대상의 글(그 대상의 일정 줄이 마지막으로 고쳐진 뒤 7일 유예, 일정 줄도 함께)·2년 지난 글. 제외 목록이 바뀌었을
  때(과정이 처음 깰 때 포함) 그 목록에 걸리는 매체의 글. 정리 문장은 10초 상한, 실패하면 실행 기록에 '정리 못 함'만 적고 수집은 이어 감.
- 판정: 저장본·외부 질의가 일부 실패하면 받은 것은 넣고 `Partial(failed)`. 하루 예산으로 보내지 않은 질의는 출처의 끊김이 아님 — 보낸 요청이 모두 성공했으면 '정상',
  하나도 못 보낸 깨기는 직전 판정이 정상(또는 없음)일 때만 '정상'(아니면 `Partial(unsent)` — 직전 판정 그대로). 태스크 시간 상한(600초)으로 남긴 대상이 있으면 `Partial(unsent)`.
- `POLITE_FETCH_ENABLED`가 꺼진 곳(로컬·QA)에서는 태스크가 돌지 않음(외부·표 읽기 0건 — 시험).
- 출처 표 `InfoSources`에 한 줄(접근 '공식 RSS·검색' — 화면 `/search`), 태스크 수 +2(`search_feeds`·`search_watch`).

### 6-4. 경로(백엔드)

| 경로 | 등급 | 내용 |
|---|---|---|
| `GET /api/search/watch` | 회원 | 내 관심 대상 `{available, items:[{id, key, kind, name, createdAt, lastSeenAt, newCount}], limits:{mine, max, serverUsed, serverMax}, collecting:boolean}` — `newCount` = 마지막으로 본 뒤 처음 받았고(`first_seen_at > last_seen_at`) 작성 시각(모르면 처음 받은 시각)이 `last_seen_at`의 24시간 전과 등록 시각 가운데 늦은 것보다 늦은 글 수(등록 직후 첫 수집의 2년치·등록 전 글이 '새 글'이 되지 않게, 늦게 잡힌 어제 기사는 셈). 회원에게는 운영자 전용 출처(`info`·`guru`·`wire`)에서 온 글을 세지 않음. `collecting` = 서버 정기 수집이 켜진 곳인지(수집기 `/live/search/excludes`의 `politeEnabled` — 10분 캐시, 모르면 null) |
| `POST /api/search/watch` | 회원(데모·`store_only` 403) | `{key}` → 백엔드가 수집기 `entity`로 이름·별칭·식별자를 풀어 저장(별칭은 대상의 것만, 최대 12개). 상한: 회원 10·운영자 50, 서버 전체 서로 다른 대표 키 100 — 넘으면 409(reason `user_limit`·`server_limit`). 이미 있으면(다른 키로 같은 대상을 보내도 대표 키로 찾아) 200(`created:false`). 풀지 못하면 409(`unresolved`), 수집기에 닿지 못하면 503(reason 없음 — `topic:` 키는 풀기 없이 키의 글로 등록), 풀기가 일부 실패(`entity`·`wikidata`·`sec` 오류)하면 503(`partial` — 저장하지 않음) |
| `DELETE /api/search/watch/{id}` | 회원(자기 것만) | 지움 |
| `POST /api/search/watch/{id}/seen` | 회원(자기 것만) | `last_seen_at = now()` — 화면이 그 대상의 타임라인 결과를 받아 그렸을 때(받지 못했으면 보내지 않음) |
| `GET /api/search/recent` | 회원 | 첫 화면 — 새 피드 묶음 최근 30건(운영자는 속보 최근 20건을 더함) `{available, items:[FeedItem], errors:{출처: 사유}(없으면 빈 객체), fetchedAt}` — 화면은 `errors`가 있으면 '읽지 못한 출처'를 보이고, 비었어도 '없음'이라 하지 않음 |
| `GET /api/search/excludes` | 회원 | 매체 제외 목록 `{available, seed:[{kind, value, group}]|null, added:[{id, kind, value, note, createdAt}]|null}` (수집기 `/live/search/excludes`는 `fixedRules`·`politeEnabled`를 더 주지만 백엔드는 넘기지 않음) |
| `POST /api/search/excludes` · `DELETE /api/search/excludes/{id}` | 운영자 | 사용자가 더하는 제외 매체(도메인 — 소문자 ASCII 호스트, 국제화 도메인은 punycode · 이름 — 앞뒤 공백만 떼고 그대로, 80자). 같은 값을 다시 넣으면 200(`created:false`) |

- `feed`의 저장본 출처에 `watch`(그 대상의 `search_watch_items`, 라벨 '관심 대상 수집')와 `feeds`(6-1)를 더합니다. 모은 글 가운데 속보·수집 글에서 온 줄은 운영자에게만
  `source` = `wire`·`info` 그대로 보이고(회원에게는 지움), 뉴스 탭에는 수집 글·거장 견해에서 온 줄을 넣지 않음(글 탭의 것). 모은 글의 건수는 출처 상태 줄 `watch`에 셈
  (상태 줄 건수의 합 = 줄 수). 경유 주소(구글) 줄은 합칠 때 맨 뒤로 보내 같은 기사의 원문 주소 줄이 남게 함.
- `feed?refresh=1`은 캐시를 건너뛰는 '지금 새로 받기'(사용자당 10분에 1번 — 넘으면 캐시 그대로 + 응답 최상위 `refreshNote`에 안내 한 줄, 새로 받았으면 null,
  refresh를 묻지 않으면 칸 없음). 수집기에 닿지 못한 새로 받기는 한 번으로 세지 않음. 데모·`store_only`는 새로 받지 않고 한도도 쓰지 않음.
- 주제 키는 앞뒤 공백을 떼고 가운데 이어진 공백을 하나로(수집기 `clean_query`와 같은 키 — 등록·정기 수집·결과가 같은 키).

## 7. 단계 4 — 공시 · 리서치 · 연결 보강 (2026-11-14 추가)

지시문 4.2·4.5와 단계 0 실측(진행 기록 '서버 실측')이 근거입니다. 모두 **공식 API·라이브러리 길**(공용 세션 — 로컬에서도 나감)이고 스크래핑은 없습니다. 출처마다 성공 15분·실패
60초 캐시(3-4와 같음), `external=false`면 캐시만(`offline`). 검색어·경로·인자는 로그에 남기지 않습니다(호스트만). **모의 매매 입력이 아닙니다.**

### 7-1. 시각 칸 — `timeBasis: "date"`(더함)

날짜만 아는 출처(DART 접수일, EDGAR 전문 검색 `file_date`, 네이버 리포트 날짜)는 `publishedAt` = 그 날짜의 그 출처 달력 00:00(DART·네이버 = KST `+09:00`,
SEC = 미국 동부 — `zoneinfo('America/New_York')`)을 UTC ISO로 바꾼 값, `timeBasis: "date"`. 2년 자르기·정렬은 그 값으로 하고, 화면은 날짜만(`YYYY-MM-DD`) 보입니다.

### 7-2. 공시 탭(`filings`) — 대상 종류: 기업·기관·사람(주제는 탭 없음, `timeline`에도 공시 출처 없음)

| source | label | 언제 부름 | 호출 |
|---|---|---|---|
| `sec` | SEC 공시(회사별) | `ids.cik`가 있는 대상(회사·13F 기관·CIK가 있는 사람) | `https://data.sec.gov/submissions/CIK<10자리>.json` 한 번(`SEC_USER_AGENT` — 기존 SEC 세션·간격). `filings.recent`의 줄 가운데 2년 안. 최근 블록의 가장 오래된 접수일이 창 안이면(그 앞 파일이 따로 있음) 상태 `message` = "최근 1,000건만 — 그 앞은 SEC에서"(더 부르지 않음) |
| `sec_fts` | SEC 전문 검색(이름) | 사람·13F 기관(종류 `person`·`institution`)의 영문 이름이 있을 때 | `https://efts.sec.gov/LATEST/search-index?q="<구문>"&dateRange=custom&startdt=<창 시작>&enddt=<오늘 KST>` — 구문은 Bing과 같은 규칙(`bing_queries(edition_terms(entity,"en"))` — 티커 없이, 첫 구문이 0건이면 다음 구문 한 번). 첫 쪽(최대 100건)만 |
| `dart` | DART 공시 | `ids.dartCorpCode`가 있는 국내 회사 | `https://opendart.fss.or.kr/api/list.json?corp_code=&bgn_de=<창 시작 YYYYMMDD>&end_de=<오늘>&sort=date&sort_mth=desc&page_count=100&page_no=1`(+ `total_page`가 1보다 크면 `page_no=2` 한 번 — 최대 200건). `DART_API_KEY`(기존 `publicapi`). `total_count` > 받은 수면 `message` = "최근 200건(전체 n건 — 그 앞은 DART에서)". status `013`(자료 없음)은 `empty` |

- FeedItem(공통): `kind:"filing"`, `lang` SEC `en`·DART `ko`, `summary` ≤ 300자, `readerId:null`.
  - `sec`: `title` = `<form> · <primaryDocDescription>`(설명이 없거나 양식과 같으면 양식만), `url` = 접수 색인 쪽
    `https://www.sec.gov/Archives/edgar/data/<CIK 숫자>/<접수번호 대시 없음>/<접수번호>-index.htm`, `publisher` = 회사 이름(submissions `name`), `publisherDomain` = `sec.gov`,
    `publishedAt` = `acceptanceDateTime`(꼬리 `Z` 그대로 UTC — 서버 실측 2026-11-14: `…T13:52:41.000Z` = 접수 색인 쪽 'Accepted 08:52:41' 미국 동부 표준시, 있으면
    `timeBasis:"published"`) 없으면 `filingDate`(`"date"`), `summary` = "보고 기준일 <reportDate>"(있을 때).
  - `sec_fts`: `title` = `<form> · <제출자 이름>`(`display_names[0]`에서 꼬리 ` (CIK …)`·티커 괄호를 뗌), `url` = 같은 접수 색인 쪽(`ciks[0]`), `publisher` = 제출자 이름,
    `publishedAt` = `file_date`(`"date"`), `summary` = `file_description`.
  - 실패: 전문 검색에서 받은 줄 없이 두 번째 구문이 실패하면 `error`(60초 캐시). DART 2쪽이 실패하면 1쪽 줄과 안내("2쪽을 받지 못함(…)")를 둡니다. SEC submissions 404는
    빈 결과와 안내. 전문 검색에서 제출자 CIK가 없는 줄은 연결할 쪽이 없어 뺍니다. 2년 밖 줄은 규칙(4절)이 잘라 `dropped.old`에 셉니다.
  - **같은 공시 가리기**: SEC 두 출처는 `id` = `info_text.item_id("sec:" + 접수번호)`(쪽 주소가 아니라 접수번호 — 같은 접수가 두 출처에서 와도 한 줄, `sec`가 먼저).
  - `dart`: `title` = `report_nm`(앞뒤 공백 정리), `url` = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=<rcept_no>`, `publisher` = `flr_nm`(제출인), `publisherDomain` = `dart.fss.or.kr`,
    `publishedAt` = `rcept_dt`(KST 날짜, `"date"`), `summary` = `rm` 표지(유·코·채·넥·공·연·정·철 — 있으면 "비고 <rm>"), `id` = `info_text.item_id(url)`.
- 중국어·매체 제외 규칙은 그대로 거칩니다(공시는 걸릴 일이 거의 없음). 시각 모름은 `noTime`.

### 7-3. 리서치 탭(`research`) — 대상 종류: 기업(상장 종목)만

| source | label | 언제 | 호출 |
|---|---|---|---|
| `yahoo_research` | 투자의견 변경(Yahoo) | `ids.market == "us"`이고 티커가 있음 | yfinance `Ticker(t).upgrades_downgrades`(Yahoo 공용 거부 래치 `http.YAHOO_HOST`를 먼저 봄 — 닫혀 있으면 부르지 않고 `error`). 2년 안의 줄만 |
| `naver_research` | 증권사 리포트(네이버) | `ids.market == "kr"` | 종목 상세의 네이버 `integration` 응답의 `researches`(상세 화면 함수 그대로 — 새 네이버 경로를 늘리지 않음, 받은 만큼) |

- `yahoo_research`: `kind:"research"`, `title` = `<Firm>: <등급 바뀜>` — `Action`을 한국어로(`up` 상향·`down` 하향·`main` 유지·`init` 신규·`reit` 재개, 모르면 원문),
  `FromGrade → ToGrade`(앞 등급이 없으면 `ToGrade`만), `summary` = 목표가가 있으면 "목표가 <prior> → <current>"(달러, 없으면 null), `publisher` = `Firm`, `url` =
  `https://finance.yahoo.com/quote/<티커>/analysis/`(공용 — 같은 글 가리기는 `id`로), `id` = `info_text.item_id("yahoo-grade:" + 티커 + 날짜시각 + Firm + Action + ToGrade)`,
  `publishedAt` = `GradeDate`(UTC, `"published"`), `lang:"en"`.
- `naver_research`: `kind:"research"`, `title` = 리포트 제목, `publisher` = 증권사, `url` = 네이버 리포트 쪽(상세와 같음), `publishedAt` = 날짜(`"date"`, KST), `lang:"ko"`.

### 7-4. 타임라인

`timeline` = 그 대상에 허락된 모든 탭의 합(3-4) — 단계 4부터 기업·기관·사람은 공시 출처, 기업은 리서치 출처도 들어갑니다(상태 `later` 없앰). 같은 글 가리기 우선순위는
기존 순서 뒤에 `sec` > `sec_fts` > `dart` > `yahoo_research` > `naver_research`.

### 7-5. 연결 보강 — 새 경로 `GET /api/search/links?e=`(회원) · 수집기 `GET /live/search/links?e=&external=&owner=`

대상 풀기(3-3, 하루 캐시·15초 상한)를 무겁게 하지 않으려고 따로 부릅니다. 연결 탭을 열 때 화면이 부르고, 3-3의 `links`(Wikidata·13F)와 합쳐 보입니다.

```
{ "entityKey": "us:NVDA", "links": [Link], "sources": [SourceStatus], "fetchedAt": iso }
```

| source | label | 언제 | 호출 → Link |
|---|---|---|---|
| `insiders` | 내부자 명단(Yahoo) | 미국 상장 회사(티커) | yfinance `Ticker(t).insider_roster_holders`(Yahoo 래치) → `relation:"insider"`, `kind:"person"`, `key:null`, `name` = `Name`, `detail` = `Position` + (있으면) " · 최근 <Most Recent Transaction> <Latest Transaction Date(YYYY-MM-DD)>" |
| `gleif` | 법인 관계(GLEIF) | `ids.lei`가 있음 | `https://api.gleif.org/api/v1/lei-records/<LEI>/direct-parent`·`/ultimate-parent`(404 = 관계 없음 — 오류 아님)·`/direct-children?page[size]=20` (일반 이름 UA — Wikidata와 같은 UA, 하루 캐시) → `relation` `parent`·`ultimate_parent`·`subsidiary`, `kind:"company"`, `key:null`, `name` = `entity.legalName.name`, `detail` = 법인 소재지(`entity.legalAddress.country`) + " · LEI <lei>". 자식이 20을 넘으면 상태 `message` = "자회사 20곳까지(전체 n곳)" |

- `Link`에 칸 둘을 더합니다: `detail`(한 줄, 없으면 null), `source`에 `yahoo`·`gleif`. `relation`에 `insider`·`ultimate_parent`를 더합니다.
- `key:null` 연결은 누르면 그 이름으로 3-2(resolve)를 부릅니다(지금과 같음).
- `ids`에 `lei`를 더합니다(Wikidata `P1278`의 첫 값 — 20자 `[A-Z0-9]{18}[0-9]{2}`만, 없으면 null). 속성 칸에 보입니다.
- LEI가 없는 대상은 `gleif` 상태 `skipped`("LEI 없음 — Wikidata에 법인 식별자가 없음") — Wikidata가 답했을 때만. 외부 호출을 끈 요청이면 `offline`, Wikidata 실패나
  대상 풀기 시간 초과면 `error`("LEI를 모름 — <사유>"); 화면도 이 경우(대상 응답의 `errors.wikidata`·`errors.entity`) 연결이 '없다'고 하지 않고 '모른다'고 함.
  미국 상장 회사가 아니면 `insiders` `skipped`. 내부자 명단의 빈 표는 `empty`와 안내(받지 못했을 수 있음 — 60초 캐시).
- 사람 대상의 '임원·내부자 ↔ 기업' 역방향(사람 → 회사)은 이번 단계에서 하지 않습니다(SEC 소유 공시 역색인이 필요 — 단계 6 후보).

### 7-6. 관심 대상 정기 수집에 더함(6-3)

- 대상에 `ids.cik`가 있으면 SEC submissions(호스트 `data.sec.gov`, 하루 예산 600), 종류가 사람·13F 기관이면 EDGAR 전문 검색 첫 구문 한 번(호스트 `efts.sec.gov`, 300 —
  두 번째 구문은 묻지 않음), `ids.dartCorpCode`가 있으면 DART 첫 쪽(호스트 `opendart.fss.or.kr`, 600). 예산·간격·판정 규칙은 6-3과 같고, 넣는 줄은 `kind:"filing"`.
- 공시 줄의 저장 id = 7-2의 `id`(접수번호·DART 주소). 리서치·연결은 모으지 않습니다.
- `feed`의 저장본 출처 `watch`는 탭에 맞는 종류만 섞습니다: `news` 탭은 `kind` `news`·`headline`·`wire`(속보 — 운영자에게만 남음, 3-4), `filings` 탭은 `filing`,
  `timeline`은 전부(공시 탭이 없는 주제는 공시 줄도 없음). 모은 공시 줄은 합칠 때 `dart` 바로 뒤(같은 접수는 실시간 출처 줄로 남고 건수도 그쪽에 셈 — 실시간 출처가 실패하면
  모은 줄이 그 자리를 채움).
- 관심 대상 수집은 설정(`SEC_USER_AGENT`·`DART_API_KEY`)이 없으면 그 질의를 보내지 않고 예산·간격·요청 수도 쓰지 않습니다(실행 기록에 '설정이 없어 보내지 않음' — 끊김 아님).
- 새 글 수(6-4)의 한계: 날짜만 아는 공시 줄(`dart`·`sec_fts`·접수 시각 없는 `sec`)은 작성 시각이 그 날 00:00이라, 등록한 날에 접수된 공시는 새 글로 세지 않습니다(다음 날
  접수분부터 셈). 표에 시각 기준 칸을 더하는 마이그레이션 없이 받아들임.

### 7-7. 화면

- 공시·리서치 탭을 엽니다(대상 종류에 따라 — 주제는 공시·리서치 없음, 기관·사람은 리서치 없음, 리서치는 `ids.market`이 `us`·`kr`인 상장 기업만 — 풀기 전이면 키 모양
  `us:`·`kr:`로 판단). 탭이 없는 종류에서 그 탭을 직접 부르면 수집기는 출처별 `skipped` 줄을 돌려주고, 타임라인에는 그 출처 줄을 두지 않습니다. 줄의 종류 표지(공시·리서치), `timeBasis:"date"`는 날짜만.
- 연결 탭: 3-3의 `links` + 7-5 응답을 관계별 묶음으로(`insider` '내부자', `ultimate_parent` '최상위 모회사' 등), 각 줄에 `detail`, 출처 상태 줄. 받는 중·실패·건너뜀은 글로.
- 속성 칸: `ids.lei`(있으면).

### 7-8. 백엔드

- `GET /api/search/links?e=` — 회원(`AccessPolicy`), 키 검사는 `entityKey`, `external`·`owner` 인자는 다른 경로와 같음, 중계만(운영자 전용 출처 없음). `RouteInventoryTest`·`API.md`·
  `scripts/qa/routes.json`·화면 `endpoints.ts`.
- 새 출처(`sec`·`sec_fts`·`dart`·`yahoo_research`·`naver_research`·`insiders`·`gleif`)는 회원에게도 보입니다(운영자 전용 아님) — `hideOwnerOnly`가 이 줄을 지우지 않는지 시험.

## 8. 단계 5 — Finviz 종목 뉴스 (2026-11-14 추가)

지시문 4.6·ADR 0041 결정 10(ADR 0026 결정 10 일부 개정)·단계 0 실측(서버 IP에서 계층 1 `curl_cffi` 200, `robots.txt`가 `quote.ashx`를 막지 않음, 뉴스 표 100줄)이
근거입니다. **화면의 요청이 차단 통과 계층을 부르는 첫 길**이라 아래를 모두 지킵니다. 모의 매매 입력이 아닙니다.

### 8-1. 호스트 정책
- `fetch/policy.py` `POLICIES`에 `HostPolicy("finviz.com", (TIER_IMPERSONATE, TIER_BROWSER), daily_budget=250)` — 계층 1 → 계층 2(한 번 올림, 기존 규칙). 계층 예산 250은
  호스트 전체(올림·되돌림 포함)이고, 그 안에서 용도별 하루 예산을 `fetch_budgets`로 따로 셉니다: `search` 60 · `watch` 100(KST 날짜). `compose.vultr.yml`
  `BROWSER_ALLOWED_HOSTS`에 `finviz.com`(대조 시험). 리디렉트로 다른 호스트(`www.finviz.com` 등)가 나오면 표에 없어 실패로 끝남(그대로 — 넓히지 않음).
- 받는 것: `https://finviz.com/stock?t=<티커>`(배포 뒤 서버 실측 2026-11-14 — 옛 주소 `quote.ashx?t=`는 `/stock?t=`로 옮겨짐, `robots.txt`의 `*`는 둘 다 막지 않음; 최종 주소가 `/stock`·`/quote.ashx`가 아니면 쓰지 않음) 한 쪽의 뉴스 표(`id="news-table"`)만 — 시각·제목·매체·링크. 'Show Previous News'·`news.ashx`·유료·로그인·차트·
  시세·스크리너·내려받기·Finviz 안쪽 글의 본문은 받지 않음. 검색 한 번이 보내는 요청은 1건(계층 올림 1건 더 가능).
- 넓히지 않는 것(D-2): 프록시·IP 돌려쓰기, 퍼즐 풀이, 로그인·유료 장벽, 거부당한 뒤 다른 길로 다시 시도. 서버 IP로 지나가지 못하면 빼고 보고.

### 8-2. 줄 세우기와 캐시(수집기 `services/search_finviz.py`)
- 과정 하나에 **작업자 하나**(`ThreadPoolExecutor(max_workers=1)`) — 즉석 검색과 관심 대상 수집의 Finviz 요청이 모두 이 작업자(또는 같은 잠금)를 거쳐 `finviz.com`에 동시에
  두 건이 나가지 않음. 요청 사이 간격은 계층 값 그대로(`pacing`). 작업은 `http.run_guarded(TaskGuard(deadline=…))`로 감싸 시간 상한을 둠(작업 하나 300초).
- 티커마다 결과 캐시 30분(성공), 실패 5분. 같은 티커가 줄에 있거나 받는 중이면 새로 넣지 않음. 줄 길이 상한 5(넘으면 '대기열이 가득 참').
- **`POLITE_FETCH_ENABLED`를 이 길이 직접 확인**(`polite.enabled()` — 계층은 스위치를 보지 않음). 꺼진 곳(로컬·QA)은 줄에 넣지 않고 상태 `server_only`
  ("Finviz는 운영 서버에서만"). 시험으로 고정(외부 0건).
- 즉석 검색이 줄에 넣기 전에 `fetch_budgets(finviz.com, search)`에서 한 건을 씀 — 없으면 상태 `skipped`("오늘 Finviz 검색 예산 소진"). 계층 예산이 바닥나면(`FetchSkipped`)
  같은 안내. 거부(`FetchRejected` — 닫힘·포기)는 상태 `error`와 그 사유(`closed.message()`), 그리고 `store.note_source_state("search_watch", "blocked", …)`로 끊김 알림에
  같이 걸림(관심 대상 수집의 다음 성공이 지움). 형식이 바뀌면(뉴스 표 없음) `error`("형식이 바뀜").

### 8-3. 줄 만들기
- 시각은 미국 동부 — 서버 실측(2026-11-14): Yahoo의 같은 기사 3건 가운데 2건이 0·1분 차이(1건은 15시간 21분 — Yahoo가 나중에 다시 실은 것으로 보임, 24·12시간 배수 아님).
- 표의 줄마다: 날짜 칸이 `Nov-13-26 11:24PM`이면 날짜와 시각, `10:40PM`이면 앞 줄의 날짜를 이어받음, `Today 10:40PM`이면 그날(미국 동부) — 시각은 **미국 동부**
  (`America/New_York`, 단계 5 배포 뒤 다른 출처의 같은 기사 시각과 몇 건 대조해 진행 기록에 남김). 날짜를 알 수 없는 줄은 시각 모름.
- FeedItem: `kind:"news"`(뉴스·블로그를 가를 근거가 없으면 뉴스 — 지어내지 않음), `source:"finviz"`, 라벨 'Finviz 종목 뉴스', `title`(앵커 글), `url`(절대 주소 — 상대
  경로면 `https://finviz.com` + 경로), `publisher`(줄의 매체 칸, 괄호 뗌), `publisherDomain`(원문 주소의 호스트, Finviz 안쪽 글이면 `finviz.com`), `publishedAt`,
  `timeBasis:"published"`, `lang:"en"`, `summary:null`, `id` = `info_text.item_id(url)`. 4절 규칙(2년·중국어·매체 제외) 그대로.
- 합치기 우선순위: `yahoo` 바로 뒤.

### 8-4. 결과 경로에 더함(3-4)
- 미국 상장 회사(`ids.market == "us"`, 티커)의 `news`·`timeline` 탭에 출처 `finviz`. 캐시가 있으면 `cached`(또는 막 받았으면 `ok`), 받는 중·줄에 있으면 `pending`
  ("받는 중 — 몇 초 뒤 채움")이고 응답 `pending: true`. 외부를 끈 요청(`external=false`)은 캐시만(`offline`).
- 수집기 응답에 `finvizQueued: true|false`(이 요청이 새로 줄에 넣었는지)를 둡니다 — 백엔드가 사용자 빈도를 셈.
- 수집기 인자 `finviz=0`이면 줄에 넣지 않고(캐시는 씀) 상태 `skipped`("한 사람이 한 시간에 Finviz를 새로 부를 수 있는 횟수를 넘음 — 받아 둔 결과만").

### 8-5. 백엔드
- `feed`가 수집기에 `finviz` 인자를 넘김: 사용자마다 지난 1시간에 `finvizQueued:true`가 10번이면 `finviz=0`(메모리, 프로세스 하나 전제 — 새로 받기 한도와 같음).
  `finvizQueued` 칸은 화면에 넘기지 않음(지움). 데모·`store_only`는 `external=false`라 Finviz를 부르지 않음.
- Finviz 줄은 회원에게도 보임(D-1 — 운영자 전용 아님).

### 8-6. 화면
- 응답 `pending: true`면 5초 뒤 같은 결과를 다시 부름(최대 12번 — 1분, 그 뒤에는 '받는 중' 그대로 두고 '다시 확인' 단추). 다시 부를 때 보이던 줄은 그대로 두고
  바꿔 끼움. 출처 상태 글: 대기·받는 중(`pending`)·받음·캐시·예산 소진·차단·서버에서만 — 색만으로 가르지 않음.

### 8-7. 관심 대상 정기 수집(6-3에 더함)
- 미국 상장 회사 대상이면 Finviz 한 쪽(같은 작업자·같은 30분 캐시 — 캐시가 있으면 요청 없음), `fetch_budgets(finviz.com, watch)` 100. 6-3의 예산·간격·판정 규칙을 따르고,
  거부는 `failed`가 아니라 그 대상의 Finviz만 건너뜀(호스트 닫힘은 계층이 기록 — 다른 출처는 계속).

### 8-8. 구현하며 정한 것(단계 5)
- **브라우저 컨테이너 줄 세우기**: 컨테이너는 한 번에 한 건이라(바쁘면 429 → 계층 올림 실패가 그 호스트의 거부로 기록됨), `fetch/browser_client.send`가 과정 안의 호출을
  잠금 하나로 줄 세웁니다. 기다리는 시간은 태스크의 남은 시간 − 150초(태스크 밖이면 120초), 넘으면 지금 컨테이너가 바쁠 때와 같은 전송 실패. 화면발 Finviz 작업자와
  polite 태스크(블로그·네이버 등)가 겹쳐도 차례로 갑니다(검토 지적 — 처음 구현의 'browser 계층이면 즉석 검색 끔' 우회는 걷어 냄).
- 즉석 검색은 호스트가 닫혀 있으면 줄에 넣지 않고 예산·끊김 알림도 쓰지 않고 `error`(닫힘 사유). 끊김 알림(`search_watch` blocked)은 **새로 거부당했을 때만**.
- 받은 답의 최종 주소가 `finviz.com/quote.ashx`가 아니면 쓰지 않음(`error` — "Finviz 종목 화면이 아닌 곳으로 옮겨짐"). 리디렉트를 따라가는 요청 자체는 계층 규칙대로(최대 3홉 —
  표 안의 호스트만).
- 대기열이 가득 차면 `skipped`("대기열이 가득 참 — 잠시 뒤 다시"). `finviz=0`(한 사람 빈도 상한)은 새로 줄에 넣는 것만 막음 — 상태 순서는 `cached`/`ok` → `offline` →
  `server_only` → `pending` → `skipped`. 백엔드는 `news`·`timeline` 탭이고 `kr:`·`topic:`이 아닐 때만 셈. '지금 새로 받기'도 Finviz 30분 캐시를 건너뛰지 않음(결정 10).
- 관심 대상 수집이 받는 동안 그 티커는 '받는 중'으로 표시 — 즉석 검색은 예산·사용자 셈 없이 `pending`. 관심 대상 수집은 남은 시간이 한 번 올라갈 만큼(282초) 있을 때만.
- 화면은 Finviz의 `skipped`(예산·빈도 상한·대기열)를 '받지 못한 출처'로 셉니다(5절의 안내 줄·새로 받기 문구).
- Finviz가 다루지 않는 티커(장외 OTC 등)는 HTTP 404(서버 실측 2026-11-14 — 계층은 거부로 세지 않음) → 실패가 아니라 빈 결과(`empty` + "Finviz에 이 종목 화면이 없음",
  30분 캐시). 관심 대상 수집도 실패로 세지 않음(거짓 끊김 알림 방지).
- 단계 4 QA 고침: CIK·DART 고유번호를 모르는 까닭이 대상 풀기의 실패(SEC 표·DART 저장본을 못 읽음·시간 초과)면 `error`("CIK를 모름 — …"), 읽었는데 없으면 `skipped`.
  'LEI 없음'은 Wikidata 항목을 읽었을 때만, 항목을 찾지 못했으면 "Wikidata 항목을 찾지 못해 LEI를 모름"(화면은 '모릅니다'). 첫 화면 최근 글은 제외 매체를 캐시 없이 읽음.
