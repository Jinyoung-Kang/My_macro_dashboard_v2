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
- `tab`: `timeline` · `news` · `posts`(운영자) · `filings`(단계 4 — 그 전에는 빈 목록 + 상태 `later`) · `research`(단계 4, 같음). 보유·연결 탭은 이 경로를 쓰지 않음
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
   도메인은 구글 `<source url>`의 호스트, Bing은 링크 인자 `url`의 호스트, 그 밖은 링크 호스트.
4. **같은 글**: 원문 주소가 있으면 `info_text.item_id(url)`, 경유 주소(구글)뿐이면 `re.sub(r"\W+", "", title.lower())[:24]`. 먼저 온 것(출처 우선순위: 저장본 > Yahoo·네이버 >
   Bing > 구글)을 남깁니다.
5. **검색식**: 따옴표 구문을 ` OR `로 묶음. 한국어 판(구글 `hl=ko&gl=KR&ceid=KR:ko`)은 한글 이름·한글 별칭, 영어 판(`hl=en-US&gl=US&ceid=US:en`)은 영문 이름·영문 별칭.
   네 글자 미만의 별칭과 티커는 자유 검색어에 넣지 않음(티커는 종목 뉴스 출처에만). 대상의 이름 자체는 길이와 상관없이 넣음(예: '카카오' — 이름까지 빼면 묻지 못함). 별칭은 판마다 최대 4개(긴 이름 우선). 구글에는 `after:<창 시작 날짜>`를 붙입니다(믿지 않고 1번으로 다시 자름).
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
