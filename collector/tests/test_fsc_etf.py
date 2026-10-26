"""
tests/test_fsc_etf.py
금융위원회 증권상품시세정보 (GetSecuritiesProductInfoService_V2 / getETFPriceInfo_V2) — 태스크 fsc_etf_prices(v2 2단계 B3).

응답 형태의 근거 — 실제 응답 두 건(tests/fixtures/public/fsc_getETFPriceInfo_V2_069500.xml·_0000Y0.xml, 2026-10-27 조회)과
그날 전체 응답(1,183종목)을 본 결과(명세 §7 G3, fixtures README).

고정하는 규칙
  1. 실제 응답 한 행을 저장 형태(close·open·high·low·volume·tradingValue·marketCap·nav·netAssets·listedUnits·indexName·
     indexClose·basDt + code·name)로 옮긴다. 거래 없던 날의 시가·고가·저가 0은 None, 영문 섞인 코드는 받는다.
  2. 주식시세와 같은 끝까지 받기(QA-078) — totalCount만큼 받으면 멈추고, 못 미친 채 쪽이 비면 실패.
  3. 403 코드 30(활용신청 없음)은 호출 1회로 멈추고 '활용신청 필요' EmptyResult — 저장본은 그대로.
  4. 주식시세(fsc_prices)와 따로 — 한쪽이 403이어도 다른 쪽은 저장한다.
  5. 최신이면 호출 0회, 보충은 오래된 날부터·실패한 날에서 멈춤(QA-034), 저장본이 없으면 가장 최근 하루만, 400일 정리.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import catalog, publicapi, tasks
from app.services import fsc

FIXTURES = Path(__file__).parent / "fixtures" / "public"
KEY = "k" * 20


def _fixture(name: str, status: int = 200) -> SimpleNamespace:
    return SimpleNamespace(text=(FIXTURES / name).read_text(encoding="utf-8"), status_code=status)


def _xml(items: list[dict], total: int) -> SimpleNamespace:
    body = "".join("<item>" + "".join(f"<{k}>{v}</{k}>" for k, v in item.items()) + "</item>" for item in items)
    return SimpleNamespace(
        text=(f"<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>"
              f"<body><numOfRows>2000</numOfRows><pageNo>1</pageNo><totalCount>{total}</totalCount>"
              f"<items>{body}</items></body></response>"),
        status_code=200,
    )


KODEX200 = {"basDt": "20261023", "srtnCd": "069500", "itmsNm": "KODEX 200", "clpr": "87075", "mkp": "84470",
            "hipr": "87100", "lopr": "83045", "trqu": "32381043", "trPrc": "2762810237422", "mrktTotAmt": "21768750000000",
            "nav": "87240.93", "nPptTotAmt": "21805870284076", "stLstgCnt": "250000000", "bssIdxIdxNm": "코스피 200",
            "bssIdxClpr": "862.77"}


def _row(item: dict) -> dict:
    root = publicapi.parse_xml(SimpleNamespace(text=item.text, status_code=item.status_code), key=KEY)
    return fsc.normalize_etf(publicapi.xml_items(root)[0])


# ---- 1. 행 정규화 --------------------------------------------------------------------------------------------------
def test_실제_응답_한_행을_저장_형태로_옮긴다():
    assert _row(_fixture("fsc_getETFPriceInfo_V2_069500.xml")) == {
        "code": "069500", "name": "KODEX 200", "close": 87075.0, "open": 84470.0, "high": 87100.0, "low": 83045.0,
        "volume": 32381043.0, "tradingValue": 2762810237422.0, "marketCap": 21768750000000.0, "nav": 87240.93,
        "netAssets": 21805870284076.0, "listedUnits": 250000000.0, "indexName": "코스피 200", "indexClose": 862.77,
        "basDt": "20261023",
    }


def test_거래가_없던_ETF의_시가_0은_None이고_영문_섞인_코드를_받는다():
    """
    실제 응답에서 거래량 0인 ETF(그날 11종목)는 시가·고가·저가가 0, 종가는 직전 종가(대비 0)입니다. 0원은 '체결 없음'이라 None —
    주식시세(fsc_price)와 같은 규칙입니다. 0000Y0처럼 영문이 섞인 코드(그날 324종목)를 버리면 그 ETF는 확정가가 영영 없습니다.
    """
    row = _row(_fixture("fsc_getETFPriceInfo_V2_0000Y0.xml"))
    assert row["code"] == "0000Y0"
    assert (row["open"], row["high"], row["low"]) == (None, None, None)
    assert row["close"] == 102320.0 and row["volume"] == 0.0 and row["tradingValue"] == 0.0
    assert row["nav"] == 102311.62 and row["indexClose"] == 110.74, "NAV·기초지수는 거래가 없어도 옵니다"


def test_숫자가_아니거나_0_이하인_가격은_None이다():
    """없는 숫자를 만들지 않습니다 — 칸이 없거나 비었거나 숫자가 아니면 None, NAV·기초지수 종가 0 이하도 값이 아닙니다."""
    row = fsc.normalize_etf({"srtnCd": "A153130", "clpr": "", "nav": "0", "bssIdxClpr": "-1", "trqu": "-", "itmsNm": " "})
    assert row["code"] == "153130", "A 접두어는 뗍니다(주식시세와 같은 코드 규칙)"
    assert (row["close"], row["nav"], row["indexClose"], row["volume"], row["name"]) == (None, None, None, None, None)
    assert row["open"] is None and row["listedUnits"] is None and row["indexName"] is None
    for bad in ("0000y0", "KR7069500007", "06950", ""):
        assert fsc.normalize_etf({"srtnCd": bad})["code"] is None, bad


# ---- 2. 끝까지 받기 ------------------------------------------------------------------------------------------------
def _http(monkeypatch, responder):
    """publicapi.get을 바꿔 끼우고 (주소, 파라미터) 목록을 돌려줍니다."""
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: KEY)
    calls: list[tuple[str, dict]] = []

    def fake_get(url, params, **kwargs):
        calls.append((url, dict(params)))
        return responder(url, params)

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    return calls


def test_증권상품시세_V2_주소로_하루치를_한_쪽에_받는다(monkeypatch):
    calls = _http(monkeypatch, lambda url, params: _fixture("fsc_getETFPriceInfo_V2_069500.xml"))
    budget = publicapi.CallBudget(5)
    rows, url = fsc.fetch_etf_day("20261023", budget)
    assert url == fsc.ETF_URL and url.endswith("/GetSecuritiesProductInfoService_V2/getETFPriceInfo_V2")
    assert [c[0] for c in calls] == [fsc.ETF_URL] and budget.used == 1, "totalCount 1을 받았으니 2쪽은 부르지 않습니다"
    assert calls[0][1] == {"basDt": "20261023", "numOfRows": fsc.ETF_ROWS_PER_PAGE, "pageNo": 1}
    assert fsc.ETF_ROWS_PER_PAGE == 2000, "[확인] 하루 1,183종목이 한 쪽에 옴"
    assert [r["code"] for r in rows] == ["069500"]


def test_QA078_totalCount보다_적게_받고_쪽이_비면_실패한다(monkeypatch):
    pages = {1: _xml([KODEX200], 2), 2: _xml([], 2)}
    _http(monkeypatch, lambda url, params: pages[params["pageNo"]])
    with pytest.raises(publicapi.PublicApiError, match="totalCount 2건 중 1건"):
        fsc.fetch_etf_day("20261023", publicapi.CallBudget(5))


def test_1쪽이_비고_totalCount가_0이면_그날_자료가_없다(monkeypatch):
    _http(monkeypatch, lambda url, params: _xml([], 0))
    assert fsc.fetch_etf_day("20261026", publicapi.CallBudget(5))[0] == []


# ---- 3~5. 태스크 ---------------------------------------------------------------------------------------------------
class _Store:
    """데이터셋별 저장된 날(기준일 → 행)을 들고 최신·첫 기준일을 셉니다. 주식시세·ETF가 서로의 저장본을 건드리는지 봅니다."""

    def __init__(self, days: dict[str, list[str]] | None = None):
        self.days: dict[str, dict[str, list]] = {ds: {d: [] for d in dates} for ds, dates in (days or {}).items()}
        self.deleted: list[tuple[str, str]] = []
        self.timeseries, self.snapshots = [], {}

    def latest_observation_date(self, dataset):
        return max(self.days.get(dataset) or [None], key=lambda d: d or "")

    def earliest_observation_date(self, dataset):
        stored = self.days.get(dataset) or {}
        return min(stored) if stored else None

    def put_observations(self, dataset, obs_date, rows, entity_key):
        rows = [r for r in rows if r.get(entity_key) is not None]
        self.days.setdefault(dataset, {})[obs_date] = rows
        return len(rows)

    def delete_observations_before(self, dataset, before):
        self.deleted.append((dataset, before))
        return 0

    def put_timeseries(self, dataset, series, points):
        self.timeseries.append((series, points))

    def put_snapshot(self, name, payload):
        self.snapshots[name] = payload

    def transaction(self):
        import contextlib

        return contextlib.nullcontext()


def _today():
    return datetime.now(tasks.KST).date()


def _candidates():
    return tasks._fsc_candidate_dates(_today())        # 어제 거래일부터 과거로 7거래일


def _ymd(day) -> str:
    return day.strftime("%Y%m%d")


def _use(monkeypatch, fake: _Store) -> _Store:
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    return fake


def _etf_day(params) -> SimpleNamespace:
    return _xml([dict(KODEX200, basDt=params["basDt"])], 1)


def test_403_코드_30이면_호출_1회로_멈추고_활용신청_필요로_남긴다(monkeypatch):
    """
    활용신청 전의 키는 게이트웨이가 403 + SERVICE_KEY_IS_NOT_REGISTERED_ERROR(코드 30)로 답합니다([확인] 2026-10-26). 저장본이 없으면
    '하루 앞을 보는' 규칙이 7거래일을 다 물어 한도만 쓰므로 첫 403에서 멈추고, 할 일(활용신청)을 상태 화면에 남깁니다.
    """
    fake = _use(monkeypatch, _Store())
    calls = _http(monkeypatch, lambda url, params: _fixture("datagokr_error_not_registered.xml", 403))
    with pytest.raises(tasks.EmptyResult) as caught:
        tasks.task_fsc_etf_prices()
    message = str(caught.value)
    assert message.startswith(tasks.FSC_ETF_NOT_REGISTERED)
    assert "활용신청 필요" in message and "금융위원회_증권상품시세정보" in message and "기존 저장본 유지" in message
    assert "코드 30" in message and KEY not in message
    assert len(calls) == 1
    assert fake.days == {} and fake.deleted == []


def test_주식시세와_따로라_ETF가_403이어도_주식은_저장된다(monkeypatch):
    """활용신청은 서비스마다 따로입니다. 같은 키로 주식시세는 200, 증권상품시세는 403일 때 한쪽 실패가 다른 쪽 저장을 막지 않습니다."""
    yesterday = _candidates()[0]
    fake = _use(monkeypatch, _Store({catalog.OBS_FSC_PRICE: ["2000-01-01"]}))    # 주식 과거 쪽은 할 일 없음

    def responder(url, params):
        if url == fsc.ETF_URL:
            return _fixture("datagokr_error_not_registered.xml", 403)
        item = {"basDt": params["basDt"], "srtnCd": "005930", "itmsNm": "삼성전자", "mrktCtg": "KOSPI", "clpr": "71000"}
        return _xml([item], 1)

    _http(monkeypatch, responder)
    monkeypatch.setattr(tasks.korea_public, "FSC_LOOKBACK_DAYS", 1)
    with pytest.raises(tasks.EmptyResult, match="활용신청 필요"):
        tasks.task_fsc_etf_prices()
    assert tasks.task_fsc_prices().startswith(f"{yesterday.isoformat()} 1종목")
    assert yesterday.isoformat() in fake.days[catalog.OBS_FSC_PRICE]
    assert catalog.OBS_FSC_ETF_PRICE not in fake.days

    # 거꾸로 — 주식시세가 실패해도 ETF는 받습니다.
    _http(monkeypatch, lambda url, params: _etf_day(params) if url == fsc.ETF_URL
          else _fixture("datagokr_error_not_registered.xml", 403))
    assert tasks.task_fsc_etf_prices().startswith(f"{yesterday.isoformat()} ETF 1종목")


def test_이미_최신이면_호출_0회(monkeypatch):
    _use(monkeypatch, _Store({catalog.OBS_FSC_ETF_PRICE: [_candidates()[0].isoformat()]}))
    monkeypatch.setattr(tasks.fsc_service, "fetch_etf_day", lambda *a: pytest.fail("호출하면 안 됩니다"))
    assert tasks.task_fsc_etf_prices() == f"최신 상태 (기준일 {_candidates()[0].isoformat()}, 호출 0회)"


def test_저장본이_없으면_가장_최근에_발표된_하루만_받는다(monkeypatch):
    """어제 거래일이 아직 발표 전(빈 날)이면 하루 앞을 보고, 처음 발표된 날 하나만 저장합니다 — 시작점을 잡는 것입니다."""
    candidates = _candidates()
    fake = _use(monkeypatch, _Store())
    calls = _http(monkeypatch, lambda url, params: _xml([], 0) if params["basDt"] == _ymd(candidates[0]) else _etf_day(params))
    result = tasks.task_fsc_etf_prices()

    assert [c[1]["basDt"] for c in calls] == [_ymd(candidates[0]), _ymd(candidates[1])]
    assert list(fake.days[catalog.OBS_FSC_ETF_PRICE]) == [candidates[1].isoformat()]
    stored = fake.days[catalog.OBS_FSC_ETF_PRICE][candidates[1].isoformat()]
    assert stored[0]["code"] == "069500" and stored[0]["basDt"] == _ymd(candidates[1])
    assert result == f"{candidates[1].isoformat()} ETF 1종목 (호출 2회)"


def test_빠진_거래일을_오래된_날부터_메우고_400일_지난_행을_정리한다(monkeypatch):
    candidates = _candidates()
    fake = _use(monkeypatch, _Store({catalog.OBS_FSC_ETF_PRICE: [candidates[3].isoformat()]}))
    calls = _http(monkeypatch, lambda url, params: _etf_day(params))
    result = tasks.task_fsc_etf_prices()

    expected = [candidates[2], candidates[1], candidates[0]]
    assert [c[1]["basDt"] for c in calls] == [_ymd(d) for d in expected], "오래된 날부터, 저장된 날은 건너뜀"
    assert sorted(fake.days[catalog.OBS_FSC_ETF_PRICE]) == sorted(d.isoformat() for d in [candidates[3], *expected])
    floor = (_today() - timedelta(days=tasks.FSC_RETENTION_DAYS)).isoformat()
    assert fake.deleted == [(catalog.OBS_FSC_ETF_PRICE, floor)], "정리는 ETF 데이터셋만, 주식시세와 같은 400일"
    assert result == f"{candidates[0].isoformat()} ETF 1종목 · 3일 보충 (호출 3회)"


def test_QA034_보충_중_실패한_날에서_멈춰_다음_실행이_그날부터_다시_받는다(monkeypatch):
    """[목·금·월]을 보충하다 목요일이 실패하면 금·월을 먼저 저장하지 않습니다 — 마지막 기준일이 앞질러 목요일을 다시 받지 않게 됩니다."""
    candidates = _candidates()
    fake = _use(monkeypatch, _Store({catalog.OBS_FSC_ETF_PRICE: [candidates[3].isoformat()]}))
    failing = _ymd(candidates[2])

    def responder(url, params):
        if params["basDt"] == failing:
            raise publicapi.PublicApiError("ReadTimeout: 읽기 시간 초과")
        return _etf_day(params)

    calls = _http(monkeypatch, responder)
    with pytest.raises(tasks.EmptyResult) as caught:
        tasks.task_fsc_etf_prices()
    assert [c[1]["basDt"] for c in calls] == [failing]
    assert list(fake.days[catalog.OBS_FSC_ETF_PRICE]) == [candidates[3].isoformat()]
    assert "ReadTimeout" in str(caught.value) and "기존 저장본 유지" in str(caught.value)

    calls = _http(monkeypatch, lambda url, params: _etf_day(params))
    tasks.task_fsc_etf_prices()
    assert calls[0][1]["basDt"] == failing, "다음 실행은 실패한 날부터"


def test_QA078_잘린_하루치는_저장하지_않는다(monkeypatch):
    candidates = _candidates()
    fake = _use(monkeypatch, _Store({catalog.OBS_FSC_ETF_PRICE: [candidates[1].isoformat()]}))
    pages = {1: _xml([KODEX200], 2), 2: _xml([], 2)}
    _http(monkeypatch, lambda url, params: pages[params["pageNo"]])
    with pytest.raises(tasks.EmptyResult, match="totalCount"):
        tasks.task_fsc_etf_prices()
    assert list(fake.days[catalog.OBS_FSC_ETF_PRICE]) == [candidates[1].isoformat()]


def test_키가_없으면_부르지_않고_키_미설정으로_남긴다(monkeypatch):
    _use(monkeypatch, _Store())
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "")
    monkeypatch.setattr(fsc.publicapi, "_get_session", lambda: pytest.fail("호출하면 안 됩니다"))
    with pytest.raises(tasks.EmptyResult, match="DATA_GO_KR_SERVICE_KEY 미설정"):
        tasks.task_fsc_etf_prices()


def test_시간_상한을_넘기면_새_기준일을_시작하지_않는다(monkeypatch):
    """연결 실패가 이어져 쪽마다 시간이 쌓여도 slow 상한(600초) 전에 멈춥니다. 받은 날은 남기고 나머지는 다음 실행이 이어 받습니다."""
    candidates = _candidates()
    fake = _use(monkeypatch, _Store({catalog.OBS_FSC_ETF_PRICE: [candidates[4].isoformat()]}))
    clock = {"t": 0.0}
    monkeypatch.setattr(tasks.korea_public, "_clock", lambda: clock["t"])

    def slow(url, params):
        clock["t"] += 160.0
        return _etf_day(params)

    calls = _http(monkeypatch, slow)
    result = tasks.task_fsc_etf_prices()
    assert len(calls) == 2 and len(fake.days[catalog.OBS_FSC_ETF_PRICE]) == 3, "0초·160초에 시작한 이틀만, 320초에는 시작하지 않음"
    assert f"시간 상한 {tasks.FSC_ETF_TIME_LIMIT_SECONDS:.0f}초 — 나머지는 다음 실행" in result
    assert tasks.FSC_ETF_TIME_LIMIT_SECONDS < tasks.TASK_DEADLINE_SECONDS["slow"]


def test_예산은_되돌아보기_7거래일을_한_번에_메운다():
    assert tasks.FSC_ETF_CALL_BUDGET >= tasks.FSC_LOOKBACK_DAYS


def test_slow에서_주식시세_바로_뒤에_돌고_태스크는_30개():
    """같은 slow 바퀴에서 한국 확정가(주식 → ETF)가 토스 태스크보다 먼저 들어옵니다(명세 §4-9 시각표)."""
    task = tasks.TASKS_BY_NAME["fsc_etf_prices"]
    assert task.speed == "slow" and task.run is tasks.korea_public.task_fsc_etf_prices
    names = [t.name for t in tasks.ALL_TASKS]
    assert names.index("fsc_etf_prices") == names.index("fsc_prices") + 1
    assert len(tasks.ALL_TASKS) == len(tasks.TASKS_BY_NAME) == 30


def test_실제_저장본에서_ETF_하루치를_넣고_다시_돌면_호출_0회다(store, monkeypatch):
    """실제 PostgreSQL에서 — 코드가 entity, payload는 정규화한 행 그대로, 주식시세(fsc_price)에는 아무것도 쓰지 않습니다."""
    yesterday = _candidates()[0]
    calls = _http(monkeypatch, lambda url, params: _xml([dict(KODEX200, basDt=params["basDt"]),
                                                         dict(KODEX200, srtnCd="0000Y0", mkp="0", basDt=params["basDt"])], 2))
    assert tasks.task_fsc_etf_prices() == f"{yesterday.isoformat()} ETF 2종목 (호출 1회)"

    rows = {r["code"]: r for r in store.read_observations(catalog.OBS_FSC_ETF_PRICE, obs_date=yesterday.isoformat())}
    assert set(rows) == {"069500", "0000Y0"}
    assert rows["069500"]["close"] == 87075.0 and rows["069500"]["nav"] == 87240.93 and rows["069500"]["indexName"] == "코스피 200"
    assert rows["0000Y0"]["open"] is None
    assert store.latest_observation_date(catalog.OBS_FSC_PRICE) is None

    calls.clear()
    assert tasks.task_fsc_etf_prices() == f"최신 상태 (기준일 {yesterday.isoformat()}, 호출 0회)"
    assert calls == []
