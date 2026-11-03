"""
tests/test_detail.py
검색 상세 화면의 실시간 조회(services/detail.py) — 네트워크 없이 고정 응답으로 파싱·합치기·캐시·요청 검사를 봅니다.

- 시세: Yahoo `Ticker.info`(미국·해외)는 숫자 그대로·없는 값은 null(0으로 채우지 않음)·전일 대비는 계산, 네이버(국내)는 글 지표 그대로·부호 있는 글을
  숫자로·코스닥은 '.KQ' 차트 심볼
- 뉴스: 네이버 시각(KST yyyyMMddHHmm) → UTC, 기사 주소, HTML 엔티티 풀기 / 구글 뉴스 제목 끝 ' - 매체' 떼기 / 합치기는 최신순·같은 기사 하나만
- 종목 찾기: Yahoo '.KS'·'.KQ'는 국내 코드로, 네이버 자동완성은 국내만
- 국내 주식 개요: WISEfn 기업개요 HTML → 항목마다 한 줄·WICS 업종·기준일, 시세 응답에 출처와 함께(ETF는 부르지 않음, 못 받으면 사유)
- 캐시: 같은 질의는 한 번만 부르고, 실패 응답은 짧게만 둠
- 요청 검사: 시장·코드 형식이 틀리면 400(부르지 않음)
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.services import detail
from app.services import live_prices

_REAL_NAVER_WORLD = detail.naver_world   # 아래 fixture가 바꿔 끼우기 전의 것 — 자동완성 질의를 보는 시험이 씀


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    detail.reset_cache()
    # 네트워크 없이 — 네이버 해외주식 찾기는 기본으로 '못 찾음', 국내 기업개요는 '받지 못함'(그 경로를 보는 시험만 바꿈).
    monkeypatch.setattr(detail, "naver_world", lambda code: None)
    monkeypatch.setattr(detail, "_wisereport_profile", lambda code: {"profile": None, "error": "시험 — 네트워크 없음"})
    yield
    detail.reset_cache()


YAHOO_INFO = {
    "longName": "Apple Inc.", "shortName": "Apple", "fullExchangeName": "NasdaqGS", "currency": "USD", "quoteType": "EQUITY",
    "regularMarketPrice": 344.63, "regularMarketPreviousClose": 348.91, "regularMarketTime": 1793390401,
    "marketCap": 5029592301568, "trailingPE": 39.52, "forwardPE": None, "dividendYield": 0.31, "beta": "N/A",
    "fiftyTwoWeekHigh": 351.73, "fiftyTwoWeekLow": 243.42, "sector": "Technology", "industry": "Consumer Electronics",
    "website": "https://www.apple.com", "longBusinessSummary": "Apple designs &amp; sells devices.", "fullTimeEmployees": 150000,
    "targetMeanPrice": 360.5, "recommendationKey": "buy", "numberOfAnalystOpinions": 40,
}


def test_Yahoo_시세는_숫자_그대로_없는_값은_null_전일_대비는_계산():
    out = detail.quote_from_yahoo("AAPL", YAHOO_INFO)
    assert out["name"] == "Apple Inc." and out["exchange"] == "NasdaqGS" and out["yahooSymbol"] == "AAPL"
    assert out["price"] == 344.63 and out["previousClose"] == 348.91
    assert out["change"] == pytest.approx(-4.28) and out["changePct"] == pytest.approx(-4.28 / 348.91 * 100)
    keys = [s["key"] for s in out["stats"]]
    assert "marketCap" in keys and "trailingPE" in keys
    assert "forwardPE" not in keys and "beta" not in keys, "없는 값·글('N/A')은 지표에서 뺌 — 0으로 채우지 않음"
    assert out["profile"]["summary"] == "Apple designs & sells devices."
    assert out["consensus"] == {"targetMean": 360.5, "recommendation": "buy", "analysts": 40}
    assert out["source"]["url"] == "https://finance.yahoo.com/quote/AAPL" and out["error"] is None
    assert out["asOf"].startswith("2026-")


def test_Yahoo가_아무것도_주지_않으면_오류_문구():
    out = detail.quote_from_yahoo("ZZZZ", {})
    assert out["price"] is None and out["change"] is None and out["stats"] == [] and out["error"]


NAVER_BASIC = {
    "itemCode": "091990", "stockName": "셀트리온헬스케어", "stockEndType": "stock", "closePrice": "62,300",
    "compareToPreviousClosePrice": "−1,200", "fluctuationsRatio": "-1.89", "localTradedAt": "2026-10-30T15:30:00+09:00",
    "marketStatus": "CLOSE", "stockExchangeType": {"code": "KQ", "nameKor": "코스닥"}, "stockExchangeName": "KOSDAQ",
    "endUrl": "https://m.stock.naver.com/domestic/stock/091990",
}
NAVER_INTEGRATION = {
    "totalInfos": [{"code": "marketValue", "key": "시총", "value": "12조 3,456억"}, {"code": "per", "key": "PER", "value": "35.2배"},
                   {"code": "empty", "key": "빈 값", "value": ""}],
    "description": "바이오 의약품 유통",
    "consensusInfo": {"recommMean": "3.90", "priceTargetMean": "80,000"},
    "researches": [{"id": 97383, "tit": "성장 재개", "bnm": "미래에셋증권", "wdt": "20261030"}, {"tit": "번호 없음"}],
}


def test_네이버_시세는_글_지표_그대로_부호_있는_글은_숫자로_코스닥은_KQ():
    out = detail.quote_from_naver("091990", NAVER_BASIC, NAVER_INTEGRATION)
    assert out["market"] == "kr" and out["yahooSymbol"] == "091990.KQ" and out["exchange"] == "KOSDAQ"
    assert out["price"] == 62300 and out["change"] == -1200 and out["previousClose"] == 63500 and out["changePct"] == -1.89
    assert [(s["label"], s["text"]) for s in out["stats"]] == [("시총", "12조 3,456억"), ("PER", "35.2배")]
    assert out["consensus"]["targetMean"] == 80000
    assert out["research"] == [{"title": "성장 재개", "broker": "미래에셋증권", "date": "2026-10-30",
                                "url": "https://finance.naver.com/research/company_read.naver?nid=97383"}]
    assert out["profile"]["summary"] == "바이오 의약품 유통"
    kospi = detail.quote_from_naver("005930", {**NAVER_BASIC, "stockExchangeType": {"code": "KS"}}, None)
    assert kospi["yahooSymbol"] == "005930.KS" and kospi["stats"] == []


def test_네이버_뉴스는_KST_시각을_UTC로_기사_주소를_만든다():
    payload = [{"total": 2, "items": [
        {"officeId": "020", "articleId": "0003759210", "officeName": "동아일보", "datetime": "202611012253",
         "title": "R&amp;D 현장점검"},
        {"officeId": "015", "title": "기사 번호 없음"},
    ]}]
    assert detail.news_from_naver(payload) == [{
        "title": "R&D 현장점검", "url": "https://n.news.naver.com/mnews/article/020/0003759210", "publisher": "동아일보",
        "publishedAt": "2026-11-01T13:53:00+00:00", "source": "네이버 증권",
    }]


GOOGLE_RSS = b"""<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>search</title>
<item><title>Apple beats estimates - Reuters</title><link>https://news.google.com/rss/articles/abc</link>
<pubDate>Sun, 01 Nov 2026 12:00:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item>
<item><title>No date story</title><link>https://news.google.com/rss/articles/def</link></item>
</channel></rss>"""


def test_구글_뉴스는_제목_끝_매체를_떼고_매체_칸으로():
    items = detail.news_from_google(GOOGLE_RSS, "application/rss+xml")
    assert items[0] == {"title": "Apple beats estimates", "url": "https://news.google.com/rss/articles/abc", "publisher": "Reuters",
                        "publishedAt": "2026-11-01T12:00:00+00:00", "source": "Google News"}
    assert items[1]["publishedAt"] is None and items[1]["publisher"] is None


def test_뉴스_합치기는_최신순_같은_기사는_먼저_온_출처_하나_시각_모름은_뒤():
    naver = [{"title": "이재용 회장, 日 R&D 첨단연구소 현장점검…삼성전자 반도체 초격차 ...", "publishedAt": "2026-11-01T13:53:00+00:00",
              "source": "네이버 증권"}]
    google = [{"title": "이재용 회장, 日 R&D 첨단연구소 현장점검…삼성전자 반도체 초격차 강조", "publishedAt": "2026-11-01T13:55:00+00:00",
               "source": "Google News"},
              {"title": "다른 기사", "publishedAt": "2026-11-01T14:00:00+00:00", "source": "Google News"},
              {"title": "시각 없음", "publishedAt": None, "source": "Google News"}]
    merged = detail.merge_news(naver, google)
    assert [(item["title"][:5], item["source"]) for item in merged] == [("다른 기사", "Google News"), ("이재용 회", "네이버 증권"),
                                                                         ("시각 없음", "Google News")]
    assert len(detail.merge_news(google, limit=1)) == 1


def test_Yahoo_뉴스는_제목·링크가_있는_것만():
    items = detail.news_from_yahoo([{"title": "A", "link": "https://finance.yahoo.com/a", "publisher": "IBD", "providerPublishTime": 1793541907},
                                    {"title": "링크 없음"}])
    assert items == [{"title": "A", "url": "https://finance.yahoo.com/a", "publisher": "IBD", "publishedAt": "2026-11-01T14:05:07+00:00",
                      "source": "Yahoo Finance"}]


def test_종목_찾기_Yahoo의_KS_KQ는_국내_코드로_네이버는_국내만():
    yahoo = detail.symbols_from_yahoo([
        {"symbol": "NVDA", "longname": "NVIDIA Corporation", "exchDisp": "NASDAQ", "quoteType": "EQUITY"},
        {"symbol": "005930.KS", "shortname": "SamsungElec", "exchange": "KSC", "quoteType": "EQUITY"},
        {"symbol": "bad symbol!"},
    ])
    assert [(i["market"], i["code"], i["yahooSymbol"]) for i in yahoo] == [("us", "NVDA", "NVDA"), ("kr", "005930", "005930.KS")]
    naver = detail.symbols_from_naver({"items": [
        {"code": "247540", "name": "에코프로비엠", "typeCode": "KOSDAQ", "typeName": "코스닥", "nationCode": "KOR", "category": "stock"},
        {"code": "AAPL", "name": "애플", "nationCode": "USA"},
    ]})
    assert naver == [{"market": "kr", "code": "247540", "yahooSymbol": "247540.KQ", "name": "에코프로비엠", "exchange": "코스닥",
                      "kind": "stock", "source": "네이버 증권"}]
    assert detail.symbols_from_naver(None) == [] and detail.symbols_from_naver({"items": "x"}) == []


def test_네이버_해외주식_개요는_줄바꿈_태그를_줄로_한국어_이름·업종과_함께():
    korean = detail.korean_profile_from_naver({
        "companyName": "애플", "summary": "애플은 설계한다.<br>제품은 아이폰.<br><br><br>서비스 &amp; 결제<b>!</b>",
        "industry": {"industryGroupKor": "전화 및 소형 장치"},
    })
    assert korean == {"nameKo": "애플", "summaryKo": "애플은 설계한다.\n제품은 아이폰.\n\n서비스 & 결제!", "industryKo": "전화 및 소형 장치"}
    assert detail.korean_profile_from_naver({}) is None
    assert detail.korean_profile_from_naver(None) is None


# WISEfn 기업개요(c1010001) 페이지의 필요한 조각 — 2026-11-03 실제 응답(005930)의 모양 그대로 줄임.
WISE_PAGE = """<td class="cmp-table-cell td0101"><span class="name">삼성전자</span>
  <dl><dt class="line-left">KOSPI : 코스피 전기·전자</dt>
  <dt class="line-left">WICS : 반도체와반도체장비</dt></dl></td>
<h5><span>기업개요</span></h5></dd><dd class="header-table-cell unit"><p>[기준:2026.09.14]</p></dd>
<div class="cmp_comment">
  <ul class="dot_cmp">
    <li class="dot_cmp" data-cd="005930">동사는 1969년 설립된 글로벌 전자 기업으로,
      309개의 종속기업을 보유하고 있음.</li>
    <li class="dot_cmp" data-cd="005930">DS 부문은 DRAM, NAND Flash 등의 반도체를 생산&middot;판매하고 있음.</li>
    <li class="dot_cmp" data-cd="005930">R&amp;D <b>투자</b>를 이어 감.</li>
    <li class="dot_cmp" data-cd="005930">  </li>
  </ul>
</div>
<dt class="right">* <b>WICS</b>: WISE Industry Classification Standard, modified by FnGuide</dt>"""


def test_WISEfn_기업개요는_항목마다_한_줄_WICS_업종·기준일과_함께():
    korean = detail.korean_profile_from_wisereport(WISE_PAGE)
    assert korean == {
        "summaryKo": "동사는 1969년 설립된 글로벌 전자 기업으로, 309개의 종속기업을 보유하고 있음.\n"
                     "DS 부문은 DRAM, NAND Flash 등의 반도체를 생산·판매하고 있음.\nR&D 투자를 이어 감.",
        "industryKo": "반도체와반도체장비", "basisDate": "2026-09-14"}
    assert detail.korean_profile_from_wisereport("<html>개요 없음</html>") is None
    assert detail.korean_profile_from_wisereport(None) is None


# QA-170: 운영 확인(2026-11-03 21:5x KST) — 실제 페이지에는 기업개요 머리보다 앞에 시세 표의 '[기준:2026.11.02]'가 둘 있어(그리고 뒤에 하나 더),
# 첫 '[기준:…]'을 잡으면 출처 이름의 기업개요 기준일이 시세 기준일(11-02)로 틀리게 나옴 — 기업개요의 기준일은 09-14.
def test_QA170_WISEfn_기업개요_기준일은_기업개요_머리_아래의_것():
    page = ('<p class="date">[기준:2026.11.02]</p><table>시세</table><span class="unit">[기준: 2026.11.02]</span>\n'
            + WISE_PAGE + '\n<p>[기준:2026.11.02]</p>')
    assert detail.korean_profile_from_wisereport(page)["basisDate"] == "2026-09-14"


def test_국내_주식_시세에는_WISEfn_개요를_출처와_함께_ETF는_부르지_않고_못_받으면_사유(monkeypatch):
    asked = []
    korean = detail.korean_profile_from_wisereport(WISE_PAGE)
    monkeypatch.setattr(detail, "_naver_json", lambda path: ((NAVER_BASIC if path.endswith("/basic") else {"totalInfos": []}), None))
    monkeypatch.setattr(detail, "_wisereport_profile", lambda code: asked.append(code) or {"profile": korean, "error": None})
    out = detail.quote("kr", "091990")
    assert out["profile"]["summaryKo"].startswith("동사는 1969년") and out["profile"]["industryKo"] == "반도체와반도체장비"
    assert out["profile"]["summary"] is None and out["profile"]["country"] == "대한민국"
    assert out["profile"]["koSource"] == {"label": "WISEfn 기업개요(네이버 증권 기업분석) — 기준 2026-09-14",
                                          "url": "https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=091990"}
    assert asked == ["091990"] and "profileKoError" not in out

    detail.reset_cache()
    etf = {**NAVER_BASIC, "stockEndType": "etf"}
    monkeypatch.setattr(detail, "_naver_json", lambda path: ((etf if path.endswith("/basic") else NAVER_INTEGRATION), None))
    assert detail.quote("kr", "069500")["profile"]["summary"] == "바이오 의약품 유통" and asked == ["091990"]

    detail.reset_cache()
    monkeypatch.setattr(detail, "_naver_json", lambda path: ((NAVER_BASIC if path.endswith("/basic") else None), None))
    monkeypatch.setattr(detail, "_wisereport_profile", lambda code: {"profile": None, "error": "HTTP 503"})
    failed = detail.quote("kr", "091990")
    assert failed["profileKoError"] == "HTTP 503" and "summaryKo" not in failed["profile"]


def test_네이버_자동완성에서_같은_코드의_미국_주식만_BRK_B는_점·공백으로도_맞춤():
    payload = {"items": [
        {"code": "AAPL", "name": "애플 ADR?", "nationCode": "KOR", "category": "stock", "reutersCode": "X"},
        {"code": "BRK.B", "name": "버크셔 해서웨이 B", "nationCode": "USA", "category": "stock", "reutersCode": "BRKb"},
        {"code": "AAPL", "name": "애플", "nationCode": "USA", "category": "stock", "reutersCode": "AAPL.O"},
    ]}
    assert detail.naver_world_item(payload, "AAPL") == {"reutersCode": "AAPL.O", "name": "애플"}
    assert detail.naver_world_item(payload, "BRK-B") == {"reutersCode": "BRKb", "name": "버크셔 해서웨이 B"}
    assert detail.naver_world_item(payload, "MSFT") is None
    assert detail.naver_world_item([], "AAPL") is None


def test_뉴스는_연합인포맥스를_구글_일반_검색보다_먼저_미국_종목은_한글_이름으로(monkeypatch):
    calls = []

    def google(q, lang):
        calls.append((q, lang))
        if "site:news.einfomax.co.kr" in q:
            return [{"title": "애플 실적 발표", "url": "https://news.google.com/a", "publisher": "연합인포맥스",
                     "publishedAt": "2026-11-01T10:00:00+00:00", "source": detail.GOOGLE_SOURCE}], None
        return [{"title": "애플 실적 발표", "url": "https://news.google.com/b", "publisher": "연합인포맥스",
                 "publishedAt": "2026-11-01T10:00:00+00:00", "source": detail.GOOGLE_SOURCE},
                {"title": "Apple beats", "url": "https://news.google.com/c", "publisher": "Reuters",
                 "publishedAt": "2026-11-01T09:00:00+00:00", "source": detail.GOOGLE_SOURCE}], None

    monkeypatch.setattr(detail, "_google_news", google)
    monkeypatch.setattr(detail, "_yahoo_news", lambda code: ([], None))
    monkeypatch.setattr(detail, "naver_world", lambda code: {"reutersCode": "AAPL.O", "name": "애플"})
    out = detail.news("us", "AAPL", "Apple Inc.")
    assert calls == [("애플 site:news.einfomax.co.kr", "ko"), ("Apple Inc.", "en")]
    assert [(i["url"], i["source"]) for i in out["items"]] == [
        ("https://news.google.com/a", detail.INFOMAX_SOURCE), ("https://news.google.com/c", detail.GOOGLE_SOURCE)]
    assert out["errors"] == {}


def test_캐시는_같은_질의를_한_번만_부르고_실패는_짧게만_둔다(monkeypatch):
    calls = []
    monkeypatch.setattr(detail, "_yahoo_info", lambda code: calls.append(code) or (YAHOO_INFO, None))
    first = detail.quote("us", "AAPL")
    assert detail.quote("us", "AAPL") is first and calls == ["AAPL"]

    failures = []
    monkeypatch.setattr(detail, "_yahoo_info", lambda code: failures.append(code) or (None, "거부됨 — HTTP 429"))
    now = [1000.0]
    monkeypatch.setattr(detail.time, "monotonic", lambda: now[0])
    assert detail.quote("us", "MSFT")["error"] == "거부됨 — HTTP 429"
    now[0] += detail.FAILURE_TTL + 1
    detail.quote("us", "MSFT")
    assert failures == ["MSFT", "MSFT"], "실패 응답은 FAILURE_TTL 뒤 다시 묻는다"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(main, "API_TOKEN", "")
    monkeypatch.setattr(main.store, "ping", lambda: None)
    return TestClient(main.app, raise_server_exceptions=False)


@pytest.mark.parametrize("query", ["market=jp&code=7203", "market=kr&code=5930", "market=kr&code=005930.KS", "market=us&code=AAPL;rm",
                                   "market=us&code=" + "A" * 25])
def test_시장·코드_형식이_틀리면_400이고_부르지_않는다(client, monkeypatch, query):
    monkeypatch.setattr(detail, "quote", lambda *a: pytest.fail("호출하면 안 됩니다"))
    assert client.get(f"/live/quote?{query}").status_code == 400


def test_시세·뉴스·종목_찾기_경로는_검사한_값으로_부른다(client, monkeypatch):
    seen = []
    monkeypatch.setattr(detail, "quote", lambda market, code: seen.append(("quote", market, code)) or {"ok": True})
    monkeypatch.setattr(detail, "news", lambda market, code, q: seen.append(("news", market, code, q)) or {"items": []})
    monkeypatch.setattr(detail, "symbols", lambda q: seen.append(("symbols", q)) or {"items": []})
    assert client.get("/live/quote?market=US&code=brk-b").status_code == 200
    assert client.get("/live/quote?market=kr&code=0088m0").status_code == 200
    assert client.get("/live/news?market=kr&code=005930&q=삼성전자").status_code == 200
    assert client.get("/live/news?q=Bridgewater").status_code == 200
    assert client.get("/live/news").status_code == 400
    assert client.get("/live/symbols?q=%20삼성%20").status_code == 200
    assert client.get("/live/symbols?q=").status_code == 422
    assert seen == [("quote", "us", "BRK-B"), ("quote", "kr", "0088M0"), ("news", "kr", "005930", "삼성전자"),
                    ("news", None, None, "Bridgewater"), ("symbols", "삼성")]


# --------------------------------------------------------------------------- QA-188
# 네이버 자동완성은 'BRK-B'를 'BRK B'로만 찾습니다(실시간 시세 live_prices가 2026-11-03 운영 서버 실측으로 질의를 바꿈). 상세의 같은 조회는
# 하루 먼저 따로 만들어져 'BRK-B'를 그대로 물어, '-' 든 미국 종목(BRK-B·BF-B)의 한국어 개요·한글 이름·연합인포맥스 뉴스가 빠졌습니다.
AC_BRK_B = {"items": [{"code": "BRK.B", "name": "버크셔 해서웨이 B", "nationCode": "USA", "category": "stock", "reutersCode": "BRKb"}]}
OVERVIEW_BRK_B = {"companyName": "버크셔 해서웨이 B", "summary": "버크셔 해서웨이는 지주회사다.", "industry": {"industryGroupKor": "보험"}}


def test_QA188_상세의_자동완성_질의도_BRK_B를_BRK_공백_B로_묻는다(monkeypatch):
    monkeypatch.setattr(detail, "naver_world", _REAL_NAVER_WORLD)
    asked: list = []

    def get(url, params=None, timeout=None, headers=None):
        if url == detail.NAVER_AC:
            asked.append(params["q"])
            return SimpleNamespace(status_code=200, json=lambda: AC_BRK_B if params["q"] == "BRK B" else {"items": []})
        assert url == f"{detail.NAVER_WORLD_API}/BRKb/overview"
        return SimpleNamespace(status_code=200, json=lambda: OVERVIEW_BRK_B)
    monkeypatch.setattr(detail, "get_session", lambda: SimpleNamespace(get=get))
    monkeypatch.setattr(detail, "_yahoo_info", lambda code: ({**YAHOO_INFO, "longName": "Berkshire Hathaway Inc."}, None))
    out = detail.quote("us", "BRK-B")
    assert asked == ["BRK B"]
    assert "profileKoError" not in out and out["nameKo"] == "버크셔 해서웨이 B"
    assert out["profile"]["summaryKo"] == "버크셔 해서웨이는 지주회사다."


def test_실시간_시세와_검색_상세는_자동완성_조회_하나를_함께_쓴다(monkeypatch):
    monkeypatch.setattr(detail, "naver_world", _REAL_NAVER_WORLD)
    asked: list = []

    def get(url, params=None, timeout=None, headers=None):
        asked.append(params["q"])
        return SimpleNamespace(status_code=200, json=lambda: AC_BRK_B if params["q"] == "BRK B" else {"items": []})
    monkeypatch.setattr(detail, "get_session", lambda: SimpleNamespace(get=get))
    assert live_prices._reuters_code("BRK-B") == "BRKb"
    assert detail.naver_world("BRK-B") == {"reutersCode": "BRKb", "name": "버크셔 해서웨이 B"}
    assert asked == ["BRK B"], "한 번 찾은 것을 두 화면이 함께 씀(질의·캐시·실패 처리가 한 곳)"
