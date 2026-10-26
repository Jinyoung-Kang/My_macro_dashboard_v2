# 한국 사건 뉴스 RSS 테스트 입력 (`kr_news_headlines`, v2 2단계 명세 §4-11·K21·B9)

키·연락처·쿠키는 들어 있지 않습니다. 2026-10-26 23:27~23:30 KST에 설명형 UA(`LocalMacroDashboard/2.0`)로 받은 응답에서 **앞 3항목만 남기고**
요약(`description`)·작성자(`author`) 칸을 지운 것입니다(우리는 제목·링크·시각만 저장 — D29). 채널 머리와 항목 안의 제목·링크·날짜 형식은 원문 그대로입니다.

| 파일 | 피드 키 | URL | 시각 형식(`time_format`) |
|---|---|---|---|
| `bok_press.xml` | `bok_press` | https://www.bok.or.kr/portal/bbs/B0000552/news.rss?menuNo=200690 | `rfc822` — `Mon, 26 Oct 2026 17:30:00 +0900` |
| `mofe_press.xml` | `mofe_press` | https://mofe.go.kr/com/detailRssTagService.do?bbsId=MOSFBBS_000000000028 | `date_only` — `2026-10-25 00:00:00.0`(시각 칸은 늘 0 — 날짜만 앎, 시간대 없음 = KST) |
| `mods_press.xml` | `mods_press` | https://mods.go.kr/board.es?mid=a10301010000&bid=a103010100&act=rss | `yyyyMMddHHmm` — `202610251905`(시간대 없음 = KST. feedparser는 시각을 버리고 UTC 자정으로 읽음) |
| `yna_market.xml` | `yna_market` | https://www.yna.co.kr/rss/market.xml | `rfc822` — **합성 자료**(아래) |

`yna_market.xml`은 원문을 옮기지 않은 **합성 자료**입니다 — 채널 구조·날짜 형식(`+0900`)·항목 칸만 원문과 같고 제목·링크는 지어낸 시험 값입니다.
원문 채널의 `<copyright>`가 "저작권자(c) 연합뉴스, 무단 전재-재배포, AI 학습 및 활용 금지"라 공개 저장소에 제목을 싣지 않습니다(명세 §7 G12).

시각이 없는 항목·형식이 다른 시각·HTML 응답은 원문에 없어 테스트가 이 파일들을 고쳐 만듭니다(`test_kr_news_headlines.py`).
