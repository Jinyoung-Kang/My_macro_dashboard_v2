"""
tests/test_scraper_yahoo_path.py
Yahoo로 가는 길이 하나인지 고정합니다.

실제로 겪은 문제입니다. 같은 시각, 같은 종목인데 화면 두 곳의 결과가
갈렸습니다.

    거시경제 매크로 지표 (yfinance)   WTI 102.47 · 브렌트 105.77   ✓
    비공식 스크래핑 시세 비교 (requests) 429 Too Many Requests      ✗

원인은 데이터가 아니라 **클라이언트**였습니다. yfinance는 Yahoo가 요구하는
쿠키·crumb를 관리하지만, 생 requests 호출은 그 처리가 없어 먼저 차단됩니다.
한 출처에 두 방식으로 붙으면 한쪽만 조용히 막히고, 화면에는 설명할 수 없는
상태가 남습니다.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pandas as pd
import pytest

from app.services import market, scraper


def _code_strings(module) -> list[str]:
    """모듈의 문자열 상수 중 **주석·독스트링이 아닌 것**만 모읍니다."""
    tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
    docstrings = {
        node.body[0].value
        for node in ast.walk(tree)
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef))
        and node.body
        and isinstance(node.body[0], ast.Expr)
        and isinstance(node.body[0].value, ast.Constant)
        and isinstance(node.body[0].value.value, str)
    }
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node not in docstrings
    ]


def test_스크래퍼가_yahoo_데이터_API에_직접_붙지_않는다():
    """
    query1(데이터 API) 직접 호출이 다시 들어오는 것을 막습니다.

    finance.yahoo.com/quote/… 는 화면의 '출처' 링크라 그대로 둡니다 —
    사람이 눌러 보는 주소이지 우리가 호출하는 API가 아닙니다.
    """
    api_hosts = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
    offenders = [
        text for text in _code_strings(scraper)
        if any(host in text for host in api_hosts)
    ]
    assert not offenders, (
        f"Yahoo 데이터 호출은 yfinance 경로 하나로 모읍니다. 남아 있는 주소: {offenders}"
    )


def test_스크래퍼는_yfinance_경로에_위임한다(monkeypatch):
    """구현이 바뀌어도 '한 길로 모은다'는 성질은 유지돼야 합니다."""
    called = {}

    def fake(symbol):
        called["symbol"] = symbol
        return 102.5, 101.0, None

    monkeypatch.setattr(market, "last_two_closes", fake)

    assert scraper.fetch_yahoo_chart("CL=F") == (102.5, 101.0)
    assert called["symbol"] == "CL=F"


def test_최근_종가와_직전_종가를_돌려준다(monkeypatch):
    frame = pd.DataFrame(
        {"Close": [100.0, 101.0, 102.5]},
        index=pd.to_datetime(["2026-09-12", "2026-09-15", "2026-09-16"]),
    )
    monkeypatch.setattr(market, "_download", lambda s, p: (frame, False, None))

    current, previous, reason = market.last_two_closes("CL=F")

    assert current == 102.5
    assert previous == 101.0
    assert reason is None


def test_하루치만_있으면_직전값은_없지만_현재가는_준다(monkeypatch):
    frame = pd.DataFrame(
        {"Close": [102.5]}, index=pd.to_datetime(["2026-09-16"])
    )
    monkeypatch.setattr(market, "_download", lambda s, p: (frame, False, None))

    current, previous, reason = market.last_two_closes("CL=F")

    assert current == 102.5
    assert previous is None, "없는 직전값을 0으로 지어내면 등락률이 거짓이 됩니다"
    assert reason is None


def test_수집_실패는_사유와_함께_올라온다(monkeypatch):
    monkeypatch.setattr(
        market, "_download",
        lambda s, p: (None, False, "yfinance(1.7.0)가 빈 응답을 받았습니다"),
    )

    current, previous, reason = market.last_two_closes("CL=F")
    assert current is None and previous is None
    assert "yfinance" in reason

    # 스크래퍼는 이 사유를 그대로 올려 화면 '비고'에 보여 줍니다.
    with pytest.raises(RuntimeError) as exc:
        scraper.fetch_yahoo_chart("CL=F")
    assert "yfinance" in str(exc.value)


def test_종가가_전부_결측이면_실패로_본다(monkeypatch):
    frame = pd.DataFrame(
        {"Close": [None, None]},
        index=pd.to_datetime(["2026-09-15", "2026-09-16"]),
    )
    monkeypatch.setattr(market, "_download", lambda s, p: (frame, False, None))

    current, previous, reason = market.last_two_closes("CL=F")
    assert current is None
    assert reason, "빈 값을 성공으로 넘기면 화면이 '—'만 보여 줍니다"


# ==============================================================================
# 코스피200 야간선물 — 구버전에 있었는데 v2로 넘어오며 빠져 있던 카드
# ==============================================================================
# 구버전(services/night_futures_scraper_service.py)은 TradingView → Investing.com
# → KODEX 200 프록시 순으로 받았습니다. v2에는 아예 없었습니다.
# 앞의 두 단계는 HTML 정규식이라 조용히 깨지는 경로였으므로 Symbol Scanner
# JSON으로 바꾸되, 마지막 KODEX 프록시는 그대로 살립니다.


def _night_config():
    return next(
        c for c in scraper.SCRAPER_MARKETS if c["key"] == "kospi200_night"
    )


def test_야간선물_항목이_존재한다():
    config = _night_config()
    assert config["kind"] == "tradingview_symbol"
    assert config["fallback"] == "kodex_proxy"


def _quote(price, previous, change, change_pct, delay=0):
    """fetch_symbol_snapshot의 반환 모양(QA-137부터 사전 — 시세 지연을 함께 줍니다)."""
    return {"price": price, "previous": previous, "change": change, "changePct": change_pct,
            "delayMinutes": delay}


def test_스캐너가_되면_프록시를_쓰지_않는다(monkeypatch):
    monkeypatch.setattr(
        scraper, "fetch_symbol_snapshot",
        lambda symbol: _quote(412.5, 410.0, 2.5, 0.61),
    )
    monkeypatch.setattr(
        market, "last_two_closes",
        lambda s: pytest.fail("스캐너가 성공했는데 프록시를 불렀습니다"),
    )

    item = scraper._collect_one(_night_config())

    assert item["status"] == "ok"
    assert item["price"] == 412.5
    assert not item.get("isEstimated"), "실제 값은 추정치로 표시하면 안 됩니다"


def test_스캐너가_실패하면_KODEX_추정치로_내려간다(monkeypatch):
    def boom(symbol):
        raise RuntimeError("심볼을 찾지 못했습니다")

    monkeypatch.setattr(scraper, "fetch_symbol_snapshot", boom)
    # KODEX 200은 지수의 약 100배 가격입니다.
    monkeypatch.setattr(
        market, "last_two_closes", lambda s: (41250.0, 41000.0, None)
    )

    item = scraper._collect_one(_night_config())

    assert item["status"] == "ok"
    assert item["price"] == 412.5, "KODEX 스케일(1/100)이 적용돼야 합니다"
    assert item["previousClose"] == 410.0
    assert item["isEstimated"] is True, "추정치를 확정치처럼 보여 주면 안 됩니다"
    assert "추정치" in item["provider"]
    assert "심볼을 찾지 못했습니다" in item["note"], "왜 대체했는지가 남아야 합니다"


def test_프록시마저_실패하면_실패로_남는다(monkeypatch):
    def boom(symbol):
        raise RuntimeError("스캐너 실패")

    monkeypatch.setattr(scraper, "fetch_symbol_snapshot", boom)
    monkeypatch.setattr(market, "last_two_closes", lambda s: (None, None, "빈 응답"))

    item = scraper._collect_one(_night_config())

    assert item["status"] == "fail"
    assert "스캐너 실패" in str(item["error"])


# ==============================================================================
# Naver 진단 — "빈 결과입니다"에서 끝나지 않게
# ==============================================================================
# 화면에 이렇게만 떴습니다.
#   NAVER  ✗ 실패  empty  빈 결과입니다. 페이지 구조 변경 또는 차단을 의심하세요.
# 원인이 둘 중 무엇인지 알 수 없어 다음에 할 일을 고를 수 없습니다.
# 표가 아예 없는 것(차단·JS 요구)과 표는 있는데 행이 없는 것(휴장·구조 변경)은
# 조치가 완전히 다릅니다.


class _Res:
    def __init__(self, text: str, status_code: int = 200):
        self.text = text
        self.status_code = status_code
        self.encoding = None
        self.apparent_encoding = "euc-kr"


def _stub_naver(monkeypatch, response):
    from app.services import radar

    class _Session:
        def get(self, *a, **kw):
            if isinstance(response, Exception):
                raise response
            return response

    monkeypatch.setattr(radar, "get_session", lambda: _Session())
    radar._NAVER_LAST_REASON["value"] = None
    return radar


def test_표가_없으면_차단_가능성을_말한다(monkeypatch):
    radar = _stub_naver(monkeypatch, _Res("<html><body>차단</body></html>"))

    assert radar.fetch_naver_ranking("20260916", "KOSPI", "외국인", "순매수", 5) == []

    message = radar.test_naver_connection()["message"]
    assert "표가 없습니다" in message
    assert "차단" in message or "렌더링" in message


def test_표는_있는데_행이_없으면_휴장_가능성을_말한다(monkeypatch):
    html = '<table class="type_1"><tr><th>종목</th></tr></table>'
    radar = _stub_naver(monkeypatch, _Res(html))

    assert radar.fetch_naver_ranking("20260916", "KOSPI", "외국인", "순매수", 5) == []

    message = radar.test_naver_connection()["message"]
    assert "종목 행이 없습니다" in message
    assert "휴장" in message


def test_HTTP_오류는_상태코드를_남긴다(monkeypatch):
    radar = _stub_naver(monkeypatch, _Res("", status_code=503))

    assert radar.fetch_naver_ranking("20260916", "KOSPI", "외국인", "순매수", 5) == []
    assert "503" in radar.test_naver_connection()["message"]


def test_성공하면_사유가_남지_않는다(monkeypatch):
    html = """
    <table class="type_1">
      <tr><td>1</td><td><a href="/item/main.naver?code=005930">삼성전자</a></td>
          <td>70,000</td><td>1,234</td><td>+1.23</td><td>x</td><td>y</td>
          <td>5,678</td></tr>
    </table>
    """
    radar = _stub_naver(monkeypatch, _Res(html))

    rows = radar.fetch_naver_ranking("20260916", "KOSPI", "외국인", "순매수", 5)

    assert rows and rows[0]["code"] == "005930"
    assert radar._NAVER_LAST_REASON["value"] is None


# ==============================================================================
# bonds scanner는 폴백입니다 — 매번 부르지 않습니다
# ==============================================================================
# 로그에 5분마다 같은 줄이 찍혔습니다.
#   bonds scanner 미수집: ['us02y', 'us10y', 'us30y'] — Symbol Scanner 값으로 대체합니다.
# Symbol Scanner가 세 개를 항상 채우는데도 매번 병렬로 함께 호출했기 때문입니다.
# 쓸모없는 왕복 한 번과 같은 로그가 반복됐습니다.


def _stub_all_markets(monkeypatch, price=4.5):
    monkeypatch.setattr(
        scraper, "fetch_symbol_snapshot",
        lambda symbol: _quote(price, price - 0.1, 0.1, 2.2),
    )
    monkeypatch.setattr(
        scraper, "fetch_yahoo_chart", lambda symbol: (price, price - 0.1)
    )


def test_국채를_모두_받으면_bonds_scanner를_부르지_않는다(monkeypatch):
    _stub_all_markets(monkeypatch)
    called = {"count": 0}

    def spy():
        called["count"] += 1
        return {}

    monkeypatch.setattr(scraper, "fetch_treasury_yields", spy)

    payload = scraper.collect_scraped_markets()

    assert called["count"] == 0, "폴백을 매번 부르면 5분마다 쓸모없는 요청이 나갑니다"
    assert len(payload["items"]) == len(scraper.SCRAPER_MARKETS)


def test_국채가_비면_bonds_scanner로_보강한다(monkeypatch):
    def only_non_treasury(symbol):
        if symbol.startswith("TVC:US"):
            raise RuntimeError("국채 심볼 실패")
        return _quote(100.0, 99.0, 1.0, 1.0)

    monkeypatch.setattr(scraper, "fetch_symbol_snapshot", only_non_treasury)
    monkeypatch.setattr(scraper, "fetch_yahoo_chart", lambda s: (100.0, 99.0))
    monkeypatch.setattr(
        scraper, "fetch_treasury_yields",
        lambda: {"us10y": {"price": 4.99, "provider": "TradingView Scanner"}},
    )

    payload = scraper.collect_scraped_markets()
    by_key = {item["key"]: item for item in payload["items"]}

    assert by_key["us10y"]["status"] == "ok"
    assert by_key["us10y"]["price"] == 4.99
    # 폴백도 못 채운 것은 실패로 남습니다 — 지어내지 않습니다.
    assert by_key["us02y"]["status"] == "fail"
