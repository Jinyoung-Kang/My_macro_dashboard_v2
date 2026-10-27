"""
tests/test_public_api.py
국내 공공 API 공통 규칙과 천문연 특일정보.

고정하는 규칙
  1. Encoding 키·Decoding 키 어느 쪽을 넣어도 **같은 URL**이 나간다
     (Encoding 키를 params=로 넘기면 %가 %25로 이중 인코딩돼 인증에 실패합니다).
  2. 오류 문구에는 키가 **어떤 형태로도** 남지 않는다 (DB·상태 화면으로 나갑니다).
  3. 게이트웨이 오류 봉투(OpenAPI_ServiceResponse)를 HTTP 상태와 무관하게 잡는다.
  4. 특일정보 실제 응답(2026)을 날짜·이름으로 옮기고, 발표 전 연도(0건)는 빈 목록.
  5. 0건 응답이 이미 받아 둔 해를 지우지 않는다.
  6. 2025년부터 남기고, 저장본에 없는 지난 해(2025년~작년)는 한 번 받는다(K35).

응답 표본은 tests/fixtures/public/ 에 있고 출처는 그 폴더의 README에 있습니다.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import publicapi, tasks
from app.services import kasi

FIXTURES = Path(__file__).parent / "fixtures" / "public"

# 형태만 공공데이터포털 키를 흉내 낸 가짜 값. '+' '/' '='가 모두 들어 있습니다.
DECODED = "Abc+def/ghi==XYZ0123456789"
ENCODED = "Abc%2Bdef%2Fghi%3D%3DXYZ0123456789"


def _response(name: str, status: int = 200):
    return SimpleNamespace(text=(FIXTURES / name).read_text(encoding="utf-8"), status_code=status)


# ------------------------------------------------------------------ 키 형태
def test_Encoding키와_Decoding키가_같은_URL이_된다():
    a = publicapi.build_url("https://x/op", {"solYear": 2026}, key=DECODED, key_param="serviceKey")
    b = publicapi.build_url("https://x/op", {"solYear": 2026}, key=ENCODED, key_param="serviceKey")
    assert a == b
    assert f"serviceKey={ENCODED}" in a
    # 이중 인코딩(%25)이 생기면 인증에 실패합니다.
    assert "%25" not in a


def test_키_앞뒤_공백은_무시한다():
    assert publicapi.encoded_key(f"  {DECODED}\n") == ENCODED


# ------------------------------------------------------------------ 키 유출
@pytest.mark.parametrize("form", [DECODED, ENCODED, ENCODED.replace("%", "%25")])
def test_오류_문구에서_키의_모든_형태를_지운다(form):
    text = f"ConnectionError: https://apis.data.go.kr/x?serviceKey={form}&solYear=2026"
    cleaned = publicapi.scrub(text, DECODED)
    assert "Abc" not in cleaned and "XYZ0123456789" not in cleaned
    assert "solYear=2026" in cleaned


def test_연결_실패_예외에도_키가_남지_않는다(monkeypatch):
    import requests

    class Boom:
        def get(self, url, timeout):
            raise requests.ConnectionError(f"Max retries exceeded with url: {url}")

    monkeypatch.setattr(publicapi, "_get_session", lambda: Boom())
    with pytest.raises(publicapi.PublicApiError) as info:
        publicapi.get("https://apis.data.go.kr/x", {"a": 1}, key=DECODED)
    assert "Abc" not in str(info.value) and ENCODED not in str(info.value)


def test_키가_없으면_호출하지_않는다(monkeypatch):
    monkeypatch.setattr(publicapi, "_get_session", lambda: pytest.fail("호출하면 안 됩니다"))
    with pytest.raises(publicapi.MissingKey):
        publicapi.get("https://x", {}, key="  ")


# ------------------------------------------------------------------ 봉투
def test_등록되지_않은_키_봉투를_사유와_함께_잡는다():
    with pytest.raises(publicapi.PublicApiError) as info:
        publicapi.parse_xml(_response("datagokr_error_not_registered.xml", 403), key=DECODED)
    message = str(info.value)
    assert "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" in message
    assert "HTTP 403" in message
    assert "활용신청" in message  # 무엇을 해야 하는지까지 알려 줍니다
    assert isinstance(info.value, publicapi.NotRegistered), "부르는 쪽이 '활용신청 필요'로 바로 멈출 수 있게(증권상품시세 B3)"


def test_빈_키_봉투도_잡는다():
    with pytest.raises(publicapi.PublicApiError, match="SERVICE_KEY_IS_NULL") as info:
        publicapi.parse_xml(_response("datagokr_error_key_null.xml", 401), key=DECODED)
    assert not isinstance(info.value, publicapi.NotRegistered), "빈 키(코드 20)는 활용신청 문제가 아닙니다"


def test_XML이_아닌_응답은_본문_앞부분을_보여_주되_키는_지운다():
    bad = SimpleNamespace(text=f"<html>error {DECODED}", status_code=502)
    with pytest.raises(publicapi.PublicApiError) as info:
        publicapi.parse_xml(bad, key=DECODED)
    assert "HTTP 502" in str(info.value) and "Abc" not in str(info.value)


def test_resultCode가_정상이_아니면_실패():
    body = SimpleNamespace(
        text="<response><header><resultCode>22</resultCode><resultMsg>LIMITED</resultMsg></header></response>",
        status_code=200,
    )
    with pytest.raises(publicapi.PublicApiError, match="resultCode=22 LIMITED"):
        publicapi.parse_xml(body, key=DECODED)


def test_호출_예산():
    budget = publicapi.CallBudget(2)
    assert budget.take() and budget.take()
    assert not budget.take() and budget.exhausted


# ------------------------------------------------------------------ 특일정보
def test_특일정보_실제_응답을_날짜별로_옮긴다():
    root = publicapi.parse_xml(_response("kasi_getRestDeInfo_2026.xml"), key=DECODED)
    holidays = kasi.parse_holidays(publicapi.xml_items(root), publicapi.total_count(root))
    by_date = {h["date"]: h["name"] for h in holidays}

    assert len(holidays) == 22
    # 고정 규칙으로는 알 수 없던 날들
    assert by_date["2026-08-17"] == "대체공휴일(광복절)"
    assert by_date["2026-06-03"] == "전국동시지방선거"
    assert by_date["2026-07-17"] == "제헌절"
    # 오늘(추석) 연휴
    assert {"2026-09-24", "2026-09-25", "2026-09-26"} <= by_date.keys()


def test_발표_전_연도는_빈_목록():
    root = publicapi.parse_xml(_response("kasi_getRestDeInfo_2029_empty.xml"), key=DECODED)
    assert kasi.parse_holidays(publicapi.xml_items(root), publicapi.total_count(root)) == []


def test_같은_날_두_공휴일은_한_건으로_합친다():
    items = [
        {"isHoliday": "Y", "locdate": "20250505", "dateName": "어린이날"},
        {"isHoliday": "Y", "locdate": "20250505", "dateName": "부처님오신날"},
        {"isHoliday": "N", "locdate": "20250515", "dateName": "스승의날"},
    ]
    assert kasi.parse_holidays(items, 3) == [{"date": "2025-05-05", "name": "어린이날·부처님오신날"}]


def test_페이지가_잘리면_실패():
    with pytest.raises(publicapi.PublicApiError, match="totalCount"):
        kasi.parse_holidays([{"isHoliday": "Y", "locdate": "20260101", "dateName": "1월1일"}], 5)


# ------------------------------------------------------------------ 저장 규칙
class _FakeStore:
    def __init__(self, payload=None):
        self.payload = payload
        self.saved = None

    def read_snapshot(self, name):
        return SimpleNamespace(payload=self.payload) if self.payload else None

    def put_snapshot(self, name, payload):
        self.saved = payload


def test_0건_응답이_받아_둔_해를_지우지_않는다(monkeypatch):
    from datetime import datetime

    this_year = datetime.now(tasks.KST).year
    old = [{"date": f"{this_year}-01-01", "name": "1월1일"}]
    fake = _FakeStore({"years": {str(this_year): {"holidays": old, "announced": True}}})
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(
        tasks.kasi_service, "fetch_year",
        lambda year: [] if year == this_year else [{"date": f"{year}-01-01", "name": "1월1일"}],
    )

    result = tasks.task_kr_holidays()

    assert fake.saved["years"][str(this_year)]["holidays"] == old
    assert "유지" in result


class _Fixed2029(dt.datetime):
    """2029-03-05 10:00 KST에 멈춘 시계 — 보존 하한이 해가 지나도 올라가지 않는지 보려고."""

    @classmethod
    def now(cls, tz=None):
        return cls(2029, 3, 5, 10, 0, tzinfo=tz)


def test_공휴일은_2025년부터_남긴다_2029년에도_2026년이_있다(monkeypatch):
    # v2 2단계 명세 K35 — 예전 규칙(지난해까지)이면 2029년에는 2028년부터만 남아 한국 책의 2026년 거래일을 셀 수 없었습니다.
    def year(y):
        return {"holidays": [{"date": f"{y}-01-01", "name": "1월1일"}], "announced": True}

    fake = _FakeStore({"years": {str(y): year(y) for y in range(2024, 2030)}})
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.korea_public, "datetime", _Fixed2029)
    fetched = []

    def fetch(y):
        fetched.append(y)
        return [{"date": f"{y}-01-01", "name": "1월1일"}]

    monkeypatch.setattr(tasks.kasi_service, "fetch_year", fetch)

    tasks.task_kr_holidays()

    assert fetched == [2029, 2030]
    assert sorted(fake.saved["years"]) == ["2025", "2026", "2027", "2028", "2029", "2030"]
    assert fake.saved["years"]["2026"]["holidays"] == [{"date": "2026-01-01", "name": "1월1일"}]
    assert tasks.korea_public.KR_HOLIDAYS_KEEP_FROM == 2025


class _Fixed2026(dt.datetime):
    """2026-10-27 22:00 KST에 멈춘 시계 — 로컬 저장본이 2026·2027년뿐이던 때."""

    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 27, 22, 0, tzinfo=tz)


def test_저장본에_없는_지난_해는_한_번_받고_그_뒤로는_묻지_않는다(monkeypatch):
    """
    받는 해가 올해·내년뿐이면 2025년 목록(K35의 근거 — 토스 1년 이력·금융위 과거 쪽 메우기의 범위)이 영영 생기지 않았습니다.
    받은 뒤에는 금융위 과거 쪽 메우기의 후보일에서 2025년 공휴일이 빠집니다('자료 없는 날'로 실행마다 다시 묻지 않음).
    """
    from app import krcalendar

    def year(y, days):
        return {"holidays": [{"date": d, "name": "공휴일"} for d in days], "announced": True}

    fake = _FakeStore({"years": {"2026": year(2026, ["2026-01-01"]), "2027": year(2027, ["2027-01-01"])}})
    monkeypatch.setattr(tasks.korea_public, "store", fake)
    monkeypatch.setattr(tasks.korea_public, "datetime", _Fixed2026)
    monkeypatch.setattr(krcalendar, "_holidays", set())          # 태스크가 바꾸는 전역 — 시험 뒤 되돌림
    fetched = []

    def fetch(y):
        fetched.append(y)
        return [{"date": "2025-12-25", "name": "기독탄신일"}] if y == 2025 else [{"date": f"{y}-01-01", "name": "1월1일"}]

    monkeypatch.setattr(tasks.kasi_service, "fetch_year", fetch)

    tasks.task_kr_holidays()

    assert fetched == [2025, 2026, 2027]
    assert fake.saved["years"]["2025"]["holidays"] == [{"date": "2025-12-25", "name": "기독탄신일"}]
    assert [d.isoformat() for d in tasks._fsc_backfill_dates(dt.date(2025, 12, 29), dt.date(2025, 12, 22))] == [
        "2025-12-26", "2025-12-24", "2025-12-23", "2025-12-22"]   # 12-25(공휴일)·주말을 건너뜀

    fake.payload = fake.saved
    fetched.clear()
    tasks.task_kr_holidays()
    assert fetched == [2026, 2027], "한 번 받은 지난 해는 다시 묻지 않습니다"


def test_키가_없으면_EmptyResult(monkeypatch):
    monkeypatch.setattr(tasks.korea_public, "store", _FakeStore())

    def missing(year):
        raise publicapi.MissingKey("x")

    monkeypatch.setattr(tasks.kasi_service, "fetch_year", missing)
    with pytest.raises(tasks.EmptyResult, match="DATA_GO_KR_SERVICE_KEY"):
        tasks.task_kr_holidays()
