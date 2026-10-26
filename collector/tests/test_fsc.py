"""
tests/test_fsc.py
금융위원회 주식시세정보 (GetStockSecuritiesInfoService_V2 / getStockPriceInfo_V2).

응답 형태의 근거 — 금융위원회_주식시세정보 오픈API 활용가이드의 요청·응답 명세와
응답 예시(tests/fixtures/public/fsc_getStockPriceInfo_V2_guide_sample.xml).

고정하는 규칙
  1. 활용가이드의 오퍼레이션 이름(getStockPriceInfo_V2)으로 부른다.
     (getStockPriceInfo로 부르면 NO_OPENAPI_SERVICE_ERROR — 실제로 겪은 일)
  2. "A005930" 같은 접두어를 떼고 6자리 코드로 맞춘다. 숫자·영문 대문자 6자리(토스 규칙)가 아니면 None.
  3. 시가·고가·저가를 저장한다 — 없거나 0이면(거래 없음) None. 0으로 채우지 않는다.
  4. 시장 합계는 값이 있는 행만 더하고, 빠진 행 수를 남긴다.
  5. totalCount만큼 받으면 페이지 요청을 멈춘다.
  6. 이미 최신 기준일이 저장돼 있으면 호출 0회.
  7. 저장 첫 기준일 이전을 과거 쪽으로 메운다 — 따로 된 실행당 예산(90), 실패한 날에서 멈춤, 자료 없는 날은 건너뜀,
     보존 창(400일) 안까지, 다 메웠으면 호출 0회(v2 2단계 명세 §4-15 B2).
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from app import publicapi
from app.services import fsc


def _xml(items: list[dict], total: int, code: str = "00") -> SimpleNamespace:
    body = "".join(
        "<item>" + "".join(f"<{k}>{v}</{k}>" for k, v in item.items()) + "</item>" for item in items
    )
    text = (f"<response><header><resultCode>{code}</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>"
            f"<body><items>{body}</items><numOfRows>1000</numOfRows><pageNo>1</pageNo>"
            f"<totalCount>{total}</totalCount></body></response>")
    return SimpleNamespace(text=text, status_code=200)


SAMSUNG = {"basDt": "20260923", "srtnCd": "A005930", "itmsNm": "삼성전자", "mrktCtg": "KOSPI",
           "clpr": "71,000", "vs": "-500", "fltRt": "-0.70", "trqu": "1000", "trPrc": "71000000",
           "lstgStCnt": "100", "mrktTotAmt": "7100000"}


def test_행을_정규화한다():
    row = fsc.normalize(dict(SAMSUNG, mkp="70,500", hipr="71,200", lopr="70,100"))
    assert row["code"] == "005930" and row["market"] == "KOSPI"
    assert row["close"] == 71000.0 and row["changePct"] == -0.70
    assert (row["open"], row["high"], row["low"]) == (70500.0, 71200.0, 70100.0)
    assert fsc.normalize({"srtnCd": "XYZ", "clpr": "-"})["code"] is None
    assert fsc.normalize({"srtnCd": "000660", "clpr": ""})["close"] is None


def test_영문이_섞인_새_종목코드도_받는다():
    """
    예전 규칙(숫자 6자리)은 영문이 섞인 새 코드를 None으로 만들어 그 종목 행을 버렸습니다. 토스 종목코드 규칙
    ^[0-9A-Z]{6}$과 같게 받습니다(v2 2단계 명세 §4-5 B2). A 접두어는 그대로 뗍니다.
    """
    assert fsc.normalize({"srtnCd": "0126Z0"})["code"] == "0126Z0"
    assert fsc.normalize({"srtnCd": "A0126Z0"})["code"] == "0126Z0"
    assert fsc.normalize({"srtnCd": "00680K"})["code"] == "00680K"
    assert fsc.normalize({"srtnCd": "A005930"})["code"] == "005930"
    for bad in ("00680k", "1234567", "12345", "KR7005930003", ""):
        assert fsc.normalize({"srtnCd": bad})["code"] is None, bad


def test_시가_고가_저가가_없으면_None이다():
    """칸이 없거나 비었거나 숫자가 아니면 None — 0으로 채우지 않습니다(명세 §4-15 '없으면 null')."""
    row = fsc.normalize(SAMSUNG)                               # mkp·hipr·lopr 칸 자체가 없음
    assert (row["open"], row["high"], row["low"]) == (None, None, None)
    row = fsc.normalize(dict(SAMSUNG, mkp="", hipr="-", lopr="N/A"))
    assert (row["open"], row["high"], row["low"]) == (None, None, None)
    assert row["close"] == 71000.0, "종가는 그대로"


def test_거래가_없던_날의_시가_0은_None이다():
    """
    거래량 0인 종목(거래정지 등)은 실제 응답에서 시가·고가·저가가 0으로 옵니다(종가는 직전 종가). 0원은 가격이 아니라
    '체결 없음'이라 None으로 둡니다 — 시가 0이 이력에 쌓이면 수익률·대조가 0원에서 출발합니다.
    """
    from pathlib import Path

    text = (Path(__file__).parent / "fixtures" / "public" / "fsc_getStockPriceInfo_V2_halted_101530.xml").read_text()
    root = publicapi.parse_xml(SimpleNamespace(text=text, status_code=200), key="k" * 20)
    row = fsc.normalize(publicapi.xml_items(root)[0])
    assert row["code"] == "101530" and row["basDt"] == "20261023"
    assert (row["open"], row["high"], row["low"]) == (None, None, None)
    assert row["close"] == 5530.0 and row["volume"] == 0.0
    assert fsc.normalize(dict(SAMSUNG, mkp="-5"))["open"] is None


def test_시장_합계는_빈_값을_0으로_섞지_않는다():
    rows = [
        {"market": "KOSPI", "marketCap": 100.0, "tradingValue": 10.0},
        {"market": "KOSPI", "marketCap": None, "tradingValue": 5.0},
        {"market": None, "marketCap": 7.0, "tradingValue": None},
    ]
    totals = fsc.market_totals(rows)
    assert totals["KOSPI"] == {"count": 2, "marketCap": 100.0, "tradingValue": 15.0, "missingCap": 1}
    assert totals["기타"]["marketCap"] == 7.0


def test_시장_합계는_전부_비면_0이_아니라_None():
    """
    모든 행에 시가총액이 없으면(필드 이름 변경) 합계가 0.0으로 나와 timeseries에
    '시가총액 0원'이 쌓이고 화면 차트가 0으로 떨어졌습니다. 하나도 모르면 모르는 것입니다.
    거래대금도 같은 규칙입니다.
    """
    rows = [
        {"market": "KOSPI", "marketCap": None, "tradingValue": None},
        {"market": "KOSPI", "marketCap": None, "tradingValue": 5.0},
    ]
    totals = fsc.market_totals(rows)
    assert totals["KOSPI"]["marketCap"] is None
    assert totals["KOSPI"]["missingCap"] == 2
    assert totals["KOSPI"]["tradingValue"] == 5.0
    assert fsc.market_totals([{"market": "KOSDAQ", "marketCap": 1.0, "tradingValue": None}])["KOSDAQ"]["tradingValue"] is None


def test_활용가이드의_V2_오퍼레이션으로_부른다(monkeypatch):
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    monkeypatch.delenv("FSC_STOCK_PRICE_URL", raising=False)
    seen = []

    def fake_get(url, params, **kwargs):
        seen.append(url)
        return _xml([SAMSUNG], 1)

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    rows, url = fsc.fetch_day("20260923", publicapi.CallBudget(5))
    assert seen == [url] and url.endswith("/GetStockSecuritiesInfoService_V2/getStockPriceInfo_V2")
    assert [r["code"] for r in rows] == ["005930"]


def test_실패하면_다른_주소로_호출하지_않고_사유를_올린다(monkeypatch):
    """이전 주소 폴백은 승인되지 않은 서비스라 매번 403으로 호출만 낭비했습니다."""
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    calls = []

    def fake_get(url, params, **kwargs):
        calls.append(url)
        return SimpleNamespace(
            text="<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>NO_OPENAPI_SERVICE_ERROR</errMsg>"
                 "<returnReasonCode>12</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
            status_code=400)

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    with pytest.raises(publicapi.PublicApiError, match="NO_OPENAPI_SERVICE_ERROR"):
        fsc.fetch_day("20260923", publicapi.CallBudget(5))
    assert len(calls) == 1


def test_활용가이드_응답_예시를_읽는다():
    from pathlib import Path

    text = (Path(__file__).parent / "fixtures" / "public" / "fsc_getStockPriceInfo_V2_guide_sample.xml").read_text()
    root = publicapi.parse_xml(SimpleNamespace(text=text, status_code=200), key="k" * 20)
    row = fsc.normalize(publicapi.xml_items(root)[0])
    assert row == {
        "code": "900290", "name": "GRT", "market": "KOSDAQ", "close": 3185.0,
        "open": 3170.0, "high": 3205.0, "low": 3015.0, "change": 15.0, "changePct": 0.47, "volume": 493925.0, "tradingValue": 1533304201.0,
        "listedShares": 81800000.0, "marketCap": 260533000000.0, "basDt": "20260611",
    }


def test_totalCount만큼_받으면_멈춘다(monkeypatch):
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    pages = []

    def fake_get(url, params, **kwargs):
        pages.append(params["pageNo"])
        item = dict(SAMSUNG, srtnCd=f"{params['pageNo']:06d}")
        return _xml([item], 2)

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    rows, _ = fsc.fetch_day("20260923", publicapi.CallBudget(10))
    assert pages == [1, 2] and len(rows) == 2


def test_예산이_없으면_호출하지_않는다(monkeypatch):
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    monkeypatch.setattr(fsc.publicapi, "get", lambda *a, **k: pytest.fail("호출하면 안 됩니다"))
    budget = publicapi.CallBudget(0)
    with pytest.raises(publicapi.PublicApiError, match="예산"):
        fsc.fetch_day("20260923", budget)


# 과거 쪽 메우기가 이미 끝난 저장본의 첫 기준일 — 보존 하한보다 이르면 과거 쪽은 할 일이 없습니다. 최신 쪽 시험이 과거 쪽 호출을 섞지 않게
# _FakeStore의 기본값으로 씁니다(과거 쪽은 _HistoryStore 시험).
_BACKFILLED = "2000-01-01"


class _FakeStore:
    def __init__(self, latest=None, earliest=_BACKFILLED):
        self.latest = latest
        self.earliest = earliest
        self.observations, self.timeseries, self.snapshots = [], [], {}

    def latest_observation_date(self, dataset):
        return self.latest

    def earliest_observation_date(self, dataset):
        return self.earliest

    def read_snapshot(self, name):
        return None

    def put_observations(self, dataset, obs_date, rows, entity_key):
        self.observations.append((obs_date, len(rows)))
        return len(rows)

    def put_timeseries(self, dataset, series, points):
        self.timeseries.append((series, points))

    def put_snapshot(self, name, payload):
        self.snapshots[name] = payload

    def delete_observations_before(self, dataset, before):
        return 0

    @contextlib.contextmanager
    def transaction(self):
        yield None


def test_이미_최신이면_호출_0회(monkeypatch):
    from datetime import datetime, timedelta

    from app import tasks

    today = datetime.now(tasks.KST).date()
    fake = _FakeStore(latest=(today - timedelta(days=1)).isoformat())
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.fsc_service, "fetch_day", lambda *a: pytest.fail("호출하면 안 됩니다"))
    assert "최신 상태" in tasks.task_fsc_prices()


def test_발표_전이면_하루_더_거슬러_올라가_저장한다(monkeypatch):
    from app import catalog, tasks

    fake = _FakeStore(latest=None)
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    calls = []

    def fetch(bas_dt, budget):
        budget.take()
        calls.append(bas_dt)
        return ([] if len(calls) == 1 else [fsc.normalize(SAMSUNG)]), fsc.URL

    monkeypatch.setattr(tasks.fsc_service, "fetch_day", fetch)
    result = tasks.task_fsc_prices()

    assert len(calls) == 2 and len(fake.observations) == 1
    assert ("KOSPI.marketCap", [(fake.observations[0][0], 7100000.0)]) in fake.timeseries
    assert fake.snapshots[catalog.SNAP_FSC_PRICES_META]["endpoint"] == fsc.URL
    assert "1종목" in result


def test_빠진_영업일을_오래된_날부터_전부_메운다(monkeypatch):
    """
    수집기가 며칠 꺼져 있다 켜지면 예전 코드는 가장 최근 하루만 받고 멈춰, 그 사이
    날들은 영영 받지 않았습니다. 저장된 마지막 기준일 이후의 영업일을 전부 받되,
    메타 스냅샷의 latestBasDt는 가장 최근 날이어야 합니다.
    """
    from datetime import datetime

    from app import catalog, tasks

    today = datetime.now(tasks.KST).date()
    candidates = tasks._fsc_candidate_dates(today)        # 어제부터 과거로
    fake = _FakeStore(latest=candidates[2].isoformat())   # 3영업일 전까지 저장됨
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    calls = []

    def fetch(bas_dt, budget):
        budget.take()
        calls.append(bas_dt)
        return [fsc.normalize(SAMSUNG)], fsc.URL

    monkeypatch.setattr(tasks.fsc_service, "fetch_day", fetch)
    result = tasks.task_fsc_prices()

    expected = [candidates[1].strftime("%Y%m%d"), candidates[0].strftime("%Y%m%d")]
    assert calls == expected, "오래된 날부터, 저장된 날은 건너뛴다"
    assert [d for d, _ in fake.observations] == [candidates[1].isoformat(), candidates[0].isoformat()]
    assert fake.snapshots[catalog.SNAP_FSC_PRICES_META]["latestBasDt"] == candidates[0].isoformat()
    assert "2일 보충" in result


def test_하루치는_한_트랜잭션이라_중간에_실패하면_종목도_남지_않는다(store, monkeypatch):
    """
    종목 3천 행을 커밋한 뒤 시장 합계나 메타 저장에서 멈추면 latest_observation_date가
    그날로 잡혀 다음 실행이 '최신 상태'라며 건너뛰고, 합계는 영영 비었습니다.
    """
    from app import catalog, tasks

    monkeypatch.setattr(tasks.fsc_service, "fetch_day",
                        lambda bas_dt, budget: ([fsc.normalize(SAMSUNG)], fsc.URL))

    def boom(*args, **kwargs):
        raise RuntimeError("메타 저장 실패")

    monkeypatch.setattr(tasks.store, "put_snapshot", boom)

    with pytest.raises(RuntimeError):
        tasks.task_fsc_prices()

    assert store.latest_observation_date(catalog.OBS_FSC_PRICE) is None
    assert store.read_timeseries(catalog.TS_FSC_MARKET, "KOSPI.marketCap") == []


def test_QA034_보충_중_실패한_날에서_멈춰_다음_실행이_그날부터_다시_받는다(monkeypatch):
    """
    [목·금·월]을 보충하다 목요일이 오류를 내면 예전에는 금·월을 저장했고, 저장된 마지막 기준일이 월요일로
    올라가 목요일은 다시 받지 않았습니다. 실패한 날에서 멈춰야 다음 실행이 그날부터 다시 받습니다.
    """
    from datetime import datetime

    from app import publicapi, tasks

    today = datetime.now(tasks.KST).date()
    candidates = tasks._fsc_candidate_dates(today)
    fake = _FakeStore(latest=candidates[3].isoformat())   # 4영업일 전까지 저장됨 → 3일 보충
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    oldest_missing = candidates[2].strftime("%Y%m%d")

    def fetch(bas_dt, budget):
        budget.take()
        if bas_dt == oldest_missing:
            raise publicapi.PublicApiError("2페이지 응답 오류")
        return [fsc.normalize(SAMSUNG)], fsc.URL

    monkeypatch.setattr(tasks.fsc_service, "fetch_day", fetch)
    with pytest.raises(tasks.EmptyResult) as caught:
        tasks.task_fsc_prices()

    assert fake.observations == [], "실패한 날 뒤의 날짜를 먼저 저장하면 그날은 다시 받지 않습니다"
    assert "2페이지 응답 오류" in str(caught.value), "실패 사유가 상태 화면에 남습니다"


# ---- QA-078: 끝까지 받지 못한 하루치를 완전한 날로 저장하던 문제 ------------------------------------------
def _xml_without_total(items: list[dict]) -> SimpleNamespace:
    """totalCount 태그가 없는 응답(게이트웨이 이상 등)."""
    response = _xml(items, 0)
    return SimpleNamespace(text=response.text.replace("<totalCount>0</totalCount>", ""), status_code=200)


def _paged(monkeypatch, pages: dict[int, SimpleNamespace]) -> list[int]:
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    seen: list[int] = []

    def fake_get(url, params, **kwargs):
        seen.append(params["pageNo"])
        return pages[params["pageNo"]]

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    return seen


def test_QA078_totalCount보다_적게_받고_페이지가_비면_실패한다(monkeypatch):
    """
    2페이지가 resultCode 00에 0건으로 오면 예전에는 1페이지 행만 '그날 전체'로 돌려줘, 시장 합계가 실제의 일부로
    저장되고 저장된 마지막 기준일이 그날로 올라가 다시 받지 않았습니다. 실패로 올려야 QA-034의 '실패한 날에서 멈춤'을 탑니다.
    """
    _paged(monkeypatch, {1: _xml([dict(SAMSUNG, srtnCd="000001")], 2), 2: _xml([], 2)})
    with pytest.raises(publicapi.PublicApiError, match="totalCount"):
        fsc.fetch_day("20260923", publicapi.CallBudget(10))


def test_QA078_totalCount가_없으면_실패한다(monkeypatch):
    """전체 종목 수를 모르면 끝까지 받았는지 알 수 없습니다. 1페이지만 받고 '완전한 날'로 저장하지 않습니다."""
    pages = _paged(monkeypatch, {1: _xml_without_total([SAMSUNG])})
    with pytest.raises(publicapi.PublicApiError, match="totalCount"):
        fsc.fetch_day("20260923", publicapi.CallBudget(10))
    assert pages == [1]


def test_QA078_1페이지가_비고_totalCount도_없으면_발표_전이다(monkeypatch):
    """1페이지가 비고 전체 수도 없거나 0이면 아직 발표 전(또는 휴장일)입니다 — 실패가 아니라 빈 날입니다."""
    _paged(monkeypatch, {1: _xml_without_total([])})
    assert fsc.fetch_day("20260923", publicapi.CallBudget(10))[0] == []
    _paged(monkeypatch, {1: _xml([], 0)})
    assert fsc.fetch_day("20260923", publicapi.CallBudget(10))[0] == []


def test_QA078_잘린_하루치는_저장하지_않고_그날에서_멈춘다(monkeypatch):
    """태스크 경로: 잘린 응답이 저장되지 않고, 저장본이 있는 보충이므로 그날에서 멈춰 다음 실행이 다시 받습니다."""
    from datetime import datetime

    from app import tasks

    today = datetime.now(tasks.KST).date()
    candidates = tasks._fsc_candidate_dates(today)
    fake = _FakeStore(latest=candidates[1].isoformat())   # 하루 보충
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    _paged(monkeypatch, {1: _xml([dict(SAMSUNG, srtnCd="000001")], 2), 2: _xml([], 2)})

    with pytest.raises(tasks.EmptyResult):
        tasks.task_fsc_prices()
    assert fake.observations == [] and fake.timeseries == []


# ---- B2: 과거 쪽 메우기(저장 첫 기준일 이전, 보존 창 안) ------------------------------------------------------------
class _HistoryStore(_FakeStore):
    """저장된 날(기준일 → 행 수)을 들고 최신·첫 기준일을 거기서 셉니다 — 실행을 이어 붙여 시험합니다."""

    def __init__(self, dates):
        super().__init__()
        self.days = {d: 1 for d in dates}
        self.deleted_before: list[str] = []

    def latest_observation_date(self, dataset):
        return max(self.days) if self.days else None

    def earliest_observation_date(self, dataset):
        return min(self.days) if self.days else None

    def put_observations(self, dataset, obs_date, rows, entity_key):
        self.days[obs_date] = len(rows)
        return super().put_observations(dataset, obs_date, rows, entity_key)

    def delete_observations_before(self, dataset, before):
        self.deleted_before.append(before)
        gone = [d for d in self.days if d < before]
        for d in gone:
            del self.days[d]
        return len(gone)


def _today():
    from datetime import datetime

    from app import tasks

    return datetime.now(tasks.KST).date()


def _up_to_date(monkeypatch, *older_days):
    """최신 쪽이 할 일 없는 저장본(어제 거래일까지 있음) + older_days. (가짜 저장소, 저장된 날 목록)"""
    from app import tasks

    latest = tasks._fsc_candidate_dates(_today())[0]
    fake = _HistoryStore([latest.isoformat(), *(d.isoformat() for d in older_days)])
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    return fake, latest


def _days_with_pages(monkeypatch, pages: int, *, fail_on=(), empty_on=()):
    """
    실제 fetch_day를 거치는 가짜 HTTP — 하루치가 pages쪽(쪽마다 1행, totalCount = pages). 부른 (basDt, 쪽) 목록을 돌려줍니다.
    fail_on의 날은 연결 실패(publicapi.get이 올리는 PublicApiError), empty_on의 날은 1쪽이 비고 totalCount 0(그날 자료 없음).
    """
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "k" * 20)
    calls: list[tuple[str, int]] = []

    def fake_get(url, params, **kwargs):
        calls.append((params["basDt"], params["pageNo"]))
        if params["basDt"] in fail_on:
            raise publicapi.PublicApiError("ReadTimeout: 읽기 시간 초과")
        if params["basDt"] in empty_on:
            return _xml([], 0)
        item = dict(SAMSUNG, srtnCd=f"{params['pageNo']:06d}", basDt=params["basDt"])
        return _xml([item], pages)

    monkeypatch.setattr(fsc.publicapi, "get", fake_get)
    return calls


def _ymd(day) -> str:
    return day.strftime("%Y%m%d")


def test_B2_과거_쪽을_최근_날부터_메우고_메타의_최신_기준일은_건드리지_않는다(monkeypatch):
    """
    저장본이 최근 며칠뿐이면(2026-10-21부터) 보존 창 400일이 차는 데 1년 넘게 걸렸습니다 — 최신 쪽만 메웠기 때문입니다.
    저장 첫 기준일 바로 앞 거래일부터 거슬러 가며 하루치(종목 + 시장 합계)를 저장하고, 메타 스냅샷(latestBasDt = 최신 기준일)은 쓰지 않습니다.
    """
    from datetime import timedelta

    from app import catalog, tasks

    fake, latest = _up_to_date(monkeypatch)
    calls = _days_with_pages(monkeypatch, 3)
    result = tasks.task_fsc_prices()

    expected = tasks._fsc_backfill_dates(latest, _today() - timedelta(days=tasks.FSC_RETENTION_DAYS))[:30]
    assert [d for d, _ in fake.observations] == [d.isoformat() for d in expected], "최근 날부터 30기준일(90회 ÷ 3쪽)"
    assert [c for c in calls if c[1] == 1] == [(_ymd(d), 1) for d in expected], "최신 쪽은 호출 0회"
    assert len(calls) == tasks.FSC_BACKFILL_CALL_BUDGET == 90
    assert catalog.SNAP_FSC_PRICES_META not in fake.snapshots, "과거 날짜로 최신 기준일을 덮지 않습니다"
    assert ("KOSPI.marketCap", [(expected[-1].isoformat(), 7100000.0 * 3)]) in fake.timeseries, "시장 합계도 그날 것으로"
    assert result.startswith(f"최신 상태 (기준일 {latest.isoformat()}, 호출 0회)")
    assert f"과거 쪽 30일 보충, 가장 이른 기준일 {expected[-1].isoformat()}" in result and "호출 90회" in result


def test_B2_과거_쪽_예산은_최신_쪽과_따로_센다(monkeypatch):
    """최신 쪽 보충(예산 12)이 호출을 쓴 실행에서도 과거 쪽은 제 예산 90을 다 씁니다 — 한쪽이 다른 쪽을 굶기지 않습니다."""
    from app import tasks

    candidates = tasks._fsc_candidate_dates(_today())
    fake = _HistoryStore([candidates[2].isoformat()])          # 최신 쪽 2일 빠짐
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    calls = _days_with_pages(monkeypatch, 3)
    result = tasks.task_fsc_prices()

    forward = [c for c in calls if c[0] in (_ymd(candidates[1]), _ymd(candidates[0]))]
    assert len(forward) == 6 and len(calls) == 6 + 90
    assert fake.latest_observation_date("x") == candidates[0].isoformat()
    assert len(fake.days) == 3 + 30
    assert result.startswith(f"{candidates[0].isoformat()} 3종목 · 2일 보충 (호출 6회) · 과거 쪽 30일 보충")


def test_B2_새_기준일이_아직_없어도_과거_쪽을_저장했으면_수집_결과_없음이_아니다(monkeypatch):
    """최신 쪽이 '발표 전'(빈 날)이어도 과거 쪽에서 진짜 데이터를 저장했으면 성공입니다 — 수집 결과 없음(EmptyResult)은 아무것도 쓰지 않은 실행만."""
    from app import tasks

    candidates = tasks._fsc_candidate_dates(_today())
    fake = _HistoryStore([candidates[1].isoformat()])          # 어제 거래일 하루가 빠짐 — 아직 발표 전
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    calls = _days_with_pages(monkeypatch, 3, empty_on={_ymd(candidates[0])})
    result = tasks.task_fsc_prices()

    assert calls[0] == (_ymd(candidates[0]), 1)
    assert fake.latest_observation_date("x") == candidates[1].isoformat()
    assert result.startswith("새 기준일 데이터 없음 (호출 1회) · 과거 쪽 30일 보충")


def test_B2_과거_쪽은_하루치를_다_받지_못하고_예산이_떨어진_날은_저장하지_않고_실패로도_세지_않는다(monkeypatch):
    """하루치가 4쪽이면 90회로 22일(88회)을 받고 23번째 날은 2쪽에서 예산이 떨어집니다 — 잘린 하루치는 버리고 다음 실행이 그날부터."""
    from datetime import timedelta

    from app import tasks

    fake, latest = _up_to_date(monkeypatch)
    calls = _days_with_pages(monkeypatch, 4)
    result = tasks.task_fsc_prices()

    pending = tasks._fsc_backfill_dates(latest, _today() - timedelta(days=tasks.FSC_RETENTION_DAYS))
    assert len(calls) == 90 and len(fake.observations) == 22
    assert calls[-2:] == [(_ymd(pending[22]), 1), (_ymd(pending[22]), 2)]
    assert pending[22].isoformat() not in fake.days, "잘린 하루치는 저장하지 않습니다"
    assert "사유" not in result, "예산 소진은 출처의 실패가 아닙니다"

    calls.clear()
    tasks.task_fsc_prices()
    assert calls[0] == (_ymd(pending[22]), 1), "다음 실행은 그날부터"


def test_B2_과거_쪽은_실패한_날에서_멈추고_다음_실행이_그날부터_다시_받는다(monkeypatch):
    """
    QA-034를 과거 쪽으로 뒤집은 규칙 — 실패한 날보다 오래된 날을 먼저 저장하면 저장 첫 기준일이 그날을 앞질러 다시 받지 않습니다.
    받은 날은 진짜 데이터라 저장하고(태스크는 성공), 사유를 남깁니다.
    """
    from datetime import timedelta

    from app import tasks

    fake, latest = _up_to_date(monkeypatch)
    pending = tasks._fsc_backfill_dates(latest, _today() - timedelta(days=tasks.FSC_RETENTION_DAYS))
    calls = _days_with_pages(monkeypatch, 3, fail_on={_ymd(pending[2])})
    result = tasks.task_fsc_prices()

    assert [d for d, _ in fake.observations] == [pending[0].isoformat(), pending[1].isoformat()]
    assert all(c[0] != _ymd(pending[3]) for c in calls), "실패한 날 뒤(더 과거)는 부르지도 않습니다"
    assert f"과거 쪽 {pending[2].isoformat()}: ReadTimeout" in result
    assert "과거 쪽 2일 보충" in result

    calls = _days_with_pages(monkeypatch, 3)                   # 출처가 다시 답함
    tasks.task_fsc_prices()
    assert calls[0] == (_ymd(pending[2]), 1), "다음 실행은 실패한 날부터"
    assert pending[2].isoformat() in fake.days


def test_B2_과거_쪽은_자료_없는_날을_건너뛰고_더_거슬러_간다(monkeypatch):
    """
    지난 날에 1쪽이 비고 totalCount 0이면 '발표 전'이 아니라 달력이 모르는 휴장일입니다(저장된 공휴일 목록에 없는 해 — 2025년).
    그날에서 멈추면 영영 막히므로 건너뛰고, 그보다 오래된 날을 저장하면 다시 묻지 않습니다.
    """
    from datetime import timedelta

    from app import tasks

    fake, latest = _up_to_date(monkeypatch)
    pending = tasks._fsc_backfill_dates(latest, _today() - timedelta(days=tasks.FSC_RETENTION_DAYS))
    calls = _days_with_pages(monkeypatch, 3, empty_on={_ymd(pending[1])})
    result = tasks.task_fsc_prices()

    saved = [d for d, _ in fake.observations]
    assert pending[1].isoformat() not in saved and pending[2].isoformat() in saved
    assert len(calls) == 1 + 3 * 29 + 2 and len(saved) == 29, "빈 날은 1회만 쓰고 예산 안에서 계속"
    assert f"자료 없는 날 1일 건너뜀({pending[1].isoformat()})" in result
    assert "사유" not in result

    calls.clear()
    tasks.task_fsc_prices()
    assert all(c[0] != _ymd(pending[1]) for c in calls), "더 오래된 날을 저장했으면 그 빈 날은 다시 묻지 않습니다"


def test_B2_과거_쪽은_보존_창_안까지만_메우고_다_메우면_호출_0회다(monkeypatch):
    """보존 하한(오늘 − 400일)보다 이른 날은 받지 않습니다(받아도 바로 지워짐). 끝까지 메운 뒤에는 몇 번 돌아도 호출 0회 — 같은 저장본입니다."""
    from datetime import timedelta

    from app import tasks

    floor = _today() - timedelta(days=tasks.FSC_RETENTION_DAYS)
    near_floor = tasks._fsc_backfill_dates(tasks._fsc_candidate_dates(_today())[0], floor)[-3]   # 하한 위 세 번째 거래일
    fake, latest = _up_to_date(monkeypatch, near_floor)
    calls = _days_with_pages(monkeypatch, 3)
    result = tasks.task_fsc_prices()

    remaining = tasks._fsc_backfill_dates(near_floor, floor)
    assert len(remaining) == 2 and all(d >= floor for d in remaining)
    assert [d for d, _ in fake.observations] == [d.isoformat() for d in remaining]
    assert len(calls) == 6 and "보존 창 끝까지 메움" in result
    assert fake.deleted_before == [floor.isoformat()], "정리는 같은 하한으로"

    before = dict(fake.days)
    calls.clear()
    result = tasks.task_fsc_prices()
    assert calls == [] and fake.days == before
    assert result == f"최신 상태 (기준일 {latest.isoformat()}, 호출 0회)"


def test_B2_과거_쪽은_시간_상한을_넘기면_새_기준일을_시작하지_않는다(monkeypatch):
    """slow 상한(600초)에 닿으면 '시간 초과'로 받은 것도 기록이 흐려집니다. 태스크 시작부터 300초가 지나면 새 날을 더 시작하지 않습니다."""
    from app import tasks

    clock = {"t": 0.0}
    monkeypatch.setattr(tasks.korea_public, "_clock", lambda: clock["t"])
    fake, _latest = _up_to_date(monkeypatch)
    calls = _days_with_pages(monkeypatch, 3)
    real_get = fsc.publicapi.get

    def slow_get(url, params, **kwargs):
        clock["t"] += 50.0                     # 쪽마다 50초 — 하루치 150초
        return real_get(url, params, **kwargs)

    monkeypatch.setattr(fsc.publicapi, "get", slow_get)
    result = tasks.task_fsc_prices()

    assert len(fake.observations) == 2 and len(calls) == 6, "0초·150초에 시작한 이틀만, 300초에는 시작하지 않음"
    assert f"시간 상한 {tasks.FSC_BACKFILL_TIME_LIMIT_SECONDS:.0f}초 — 나머지는 다음 실행" in result


def test_B2_과거_쪽에서_키가_없으면_수집_결과_없음이다(monkeypatch):
    """최신 쪽이 할 일 없어도 과거 쪽이 부르려다 키가 없으면 '키 미설정'으로 남깁니다(최신 쪽과 같은 문구)."""
    from app import tasks

    _up_to_date(monkeypatch)
    monkeypatch.setattr(fsc.settings, "data_go_kr_key", lambda: "")
    with pytest.raises(tasks.EmptyResult, match="DATA_GO_KR_SERVICE_KEY 미설정"):
        tasks.task_fsc_prices()


def test_B2_과거_쪽_메우기는_실제_저장본에서_멱등이다(store, monkeypatch):
    """
    실제 PostgreSQL에서 — 첫 기준일(MIN)을 읽어 하한까지 메우고, 다시 돌면 호출 0회·행 그대로입니다.
    시장 합계는 날마다 하나씩, 메타 스냅샷의 latestBasDt는 최신 기준일 그대로입니다.
    """
    from datetime import timedelta

    from app import catalog, tasks

    monkeypatch.setattr(tasks.korea_public, "FSC_RETENTION_DAYS", 20)   # 하한을 가깝게 — 한 실행에 끝나도록
    latest = tasks._fsc_candidate_dates(_today())[0]
    tasks.korea_public._put_fsc_day(latest.isoformat(), [fsc.normalize(SAMSUNG)], fsc.URL)
    calls = _days_with_pages(monkeypatch, 1)

    tasks.task_fsc_prices()
    floor = _today() - timedelta(days=20)
    expected = tasks._fsc_backfill_dates(latest, floor)
    assert len(expected) >= 10 and len(calls) == len(expected)
    assert store.earliest_observation_date(catalog.OBS_FSC_PRICE) == expected[-1].isoformat()
    assert store.list_observation_dates(catalog.OBS_FSC_PRICE) == sorted(d.isoformat() for d in [latest, *expected])
    assert len(store.read_timeseries(catalog.TS_FSC_MARKET, "KOSPI.marketCap")) == len(expected) + 1
    assert store.read_snapshot(catalog.SNAP_FSC_PRICES_META).payload["latestBasDt"] == latest.isoformat()
    rows = store.read_observations(catalog.OBS_FSC_PRICE, obs_date=expected[-1].isoformat())
    assert len(rows) == 1 and rows[0]["open"] is None and rows[0]["close"] == 71000.0, "시가 칸이 없는 응답은 null로"

    calls.clear()
    assert tasks.task_fsc_prices() == f"최신 상태 (기준일 {latest.isoformat()}, 호출 0회)"
    assert calls == []
    assert store.list_observation_dates(catalog.OBS_FSC_PRICE) == sorted(d.isoformat() for d in [latest, *expected])
