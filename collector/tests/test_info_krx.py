"""
tests/test_info_krx.py
KRX 정보데이터시스템(로그인, ADR 0036) — 로그인 순서·코드, 파서, 기준일, 저장과 레이더의 KRX 단계.

고정하는 규칙
  1. 로그인은 화면 순서 그대로 세 번(로그인 화면 → 로그인 틀 → POST). 중복 로그인(CD011)이면 skipDup=Y로 한 번 더, 비밀번호 변경(CD010)·
     그 밖의 코드면 받지 않고 멈춥니다. 오류 글에 계정 값을 싣지 않습니다.
  2. 기준일은 거래일 18:30(KST) 뒤면 그날, 아니면 앞 거래일. 이미 그 기준일을 빠짐없이 받았으면 외부를 부르지 않습니다.
  3. 순매수 상위는 금액이 없거나 0인 종목을 빼고 순매수·순매도 50씩, 관측치 krx_investor_rank에 (시장, 투자주체)마다 그날을 교체합니다.
  4. 받지 못한 부분은 직전 저장본을 이어받고 isStale(부분마다 제 기준일). 공매도 잔고는 기준일 2거래일 앞부터 거슬러 처음 나오는 날.
  5. 레이더는 KRX 저장본을 외부 호출 없이 읽습니다 — 당일 조회는 가장 가까운 앞 날짜, 과거 조회는 그 날짜만.

표본은 구조만 흉내 낸 합성 JSON입니다(실제 응답 원문 아님). 네트워크를 쓰지 않습니다.
"""
from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta, timezone

import pytest

from app import catalog
from app.fetch import ladder, pacing, policy, state
from app.fetch.reply import Reply
from app.services import krx_data, radar
from app.services.info_text import ShapeError
from app.tasks import info as info_tasks

# 2026-11-11(수) 19:00 KST = 10:00 UTC — 거래일 18:30 뒤라 그날이 기준일.
EVENING = datetime(2026, 11, 11, 10, 0, tzinfo=timezone.utc)
MORNING = datetime(2026, 11, 11, 1, 0, tzinfo=timezone.utc)


def _rank_rows(n: int = 3) -> list[dict]:
    rows = [{"ISU_SRT_CD": f"00000{i}", "ISU_NM": f"종목{i}", "NETBID_TRDVAL": f"{(n - i) * 1_000_000_000:,}",
             "NETBID_TRDVOL": "1,000", "BID_TRDVAL": "5,000,000,000", "ASK_TRDVAL": "4,000,000,000"} for i in range(n)]
    rows.append({"ISU_SRT_CD": "000009", "ISU_NM": "파는종목", "NETBID_TRDVAL": "-2,500,000,000", "NETBID_TRDVOL": "-10"})
    rows.append({"ISU_SRT_CD": "000008", "ISU_NM": "모름", "NETBID_TRDVAL": "", "NETBID_TRDVOL": ""})
    return rows


class FakeKrx:
    """ladder.fetch 대역 — 로그인 코드와 bld별 답을 돌려주고 보낸 것을 적습니다."""

    def __init__(self, *, login_codes=("CD001",), answers=None, empty_balance_days=()):
        self.login_codes = list(login_codes)
        self.answers = answers or {}
        self.empty_balance_days = set(empty_balance_days)
        self.calls: list[tuple[str, str, dict]] = []

    def _reply(self, url: str, payload) -> ladder.Fetched:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return ladder.Fetched(url=url, status=200, content_type="text/html; charset=utf-8", body=body, tier="impersonate",
                              final_url=url)

    def __call__(self, url, *, method="GET", data=None, headers=None, **_):
        self.calls.append((method, url, dict(data or {})))
        if url == krx_data.LOGIN_URL:
            return self._reply(url, {"_error_code": self.login_codes.pop(0)})
        if url != krx_data.DATA_URL:
            return self._reply(url, b"<html>login</html>")
        bld = data["bld"].rsplit("/", 1)[-1]
        answer = self.answers.get(bld)
        if isinstance(answer, Exception):
            raise answer
        if bld == "MDCSTAT30501":
            rows = [] if data["trdDd"] in self.empty_balance_days else [
                {"ISU_CD": "000001", "ISU_ABBRV": "가나", "BAL_AMT": "9,000,000,000", "BAL_QTY": "100", "BAL_RTO": "0.5"}]
            return self._reply(url, {"OutBlock_1": rows})
        if answer is not None:
            return self._reply(url, answer)
        if bld == "MDCSTAT02401":
            return self._reply(url, {"output": _rank_rows()})
        if bld == "MDCSTAT02201":
            return self._reply(url, {"output": [{"INVST_TP_NM": "외국인", "NETBID_TRDVAL": "65,730,200,000,000"}]})
        if bld == "MDCSTAT03701":
            return self._reply(url, {"output": [{"ISU_SRT_CD": "000001", "ISU_ABBRV": "가나", "FORN_SHR_RT": "50.5",
                                                 "FORN_LMT_EXHST_RT": "50.5", "TDD_CLSPRC": "1,000"}]})
        return self._reply(url, {"OutBlock_1": [{"ISU_CD": "000001", "ISU_ABBRV": "가나", "CVSRTSELL_TRDVAL": "3,000,000,000",
                                                 "TRDVAL_WT": "5.1"}]})

    def data_calls(self, bld: str) -> list[dict]:
        return [d for _, url, d in self.calls if url == krx_data.DATA_URL and d.get("bld", "").endswith(bld)]


@pytest.fixture()
def account(monkeypatch):
    monkeypatch.setenv("KRX_ID", "test-id-not-real")
    monkeypatch.setenv("KRX_PW", "test-pw-not-real")


# ==============================================================================
# 1. 로그인
# ==============================================================================
def test_로그인은_화면_순서대로_세_번(account):
    fake = FakeKrx()
    krx_data.login(fake)

    assert [(m, u.rsplit("/", 1)[-1]) for m, u, _ in fake.calls] == [
        ("GET", "MDCCOMS001.cmd"), ("GET", "login.jsp?site=mdc"), ("POST", "MDCCOMS001D1.cmd")]
    assert "skipDup" not in fake.calls[-1][2]


def test_중복_로그인이면_skipDup으로_한_번_더(account):
    fake = FakeKrx(login_codes=("CD011", "CD001"))
    krx_data.login(fake)

    assert fake.calls[-1][2]["skipDup"] == "Y"


@pytest.mark.parametrize("code,expected", [("CD010", "비밀번호 변경"), ("CD002", "거절")])
def test_로그인이_안_되면_멈추고_계정_값은_싣지_않는다(account, code, expected):
    with pytest.raises(krx_data.KrxLoginError, match=expected) as raised:
        krx_data.login(FakeKrx(login_codes=(code,)))
    assert "test-id-not-real" not in str(raised.value) and "test-pw-not-real" not in str(raised.value)


def test_계정이_없으면_보내지_않는다(monkeypatch):
    monkeypatch.delenv("KRX_ID", raising=False)
    fake = FakeKrx()
    with pytest.raises(krx_data.KrxLoginError, match="설정되지 않음"):
        krx_data.login(fake)
    assert fake.calls == []


# ==============================================================================
# 2. 파서·기준일
# ==============================================================================
def test_순매수_상위는_금액이_없거나_0이면_빼고_방향별로_순위를_매긴다():
    rows = krx_data.parse_rankings(_rank_rows(), market="KOSPI", investor="연기금", day="2026-11-11")

    buys = [r for r in rows if r["tradeType"] == "순매수"]
    sells = [r for r in rows if r["tradeType"] == "순매도"]
    assert [r["code"] for r in buys] == ["000000", "000001", "000002"] and buys[0]["netAmountEok"] == 30.0
    assert [r["code"] for r in sells] == ["000009"] and sells[0]["netAmountEok"] == -25.0 and sells[0]["rank"] == 1
    assert all(r["code"] != "000008" for r in rows), "금액이 비면 순위에 넣지 않습니다"
    assert buys[0]["entity"] == "KOSPI|연기금|순매수|000000" and buys[0]["dataDate"] == "2026-11-11"
    assert buys[0]["price"] is None, "KRX 순위 응답에는 가격이 없습니다 — 0으로 채우지 않음"


def test_기준일은_거래일_18시30분_뒤면_그날_아니면_앞_거래일():
    assert info_tasks.krx_target_day(EVENING) == date(2026, 11, 11)
    assert info_tasks.krx_target_day(MORNING) == date(2026, 11, 10)
    assert info_tasks.krx_target_day(datetime(2026, 11, 14, 3, 0, tzinfo=timezone.utc)) == date(2026, 11, 13), "토요일은 금요일"


def test_JSON이_아니면_형식_바뀜():
    fake = FakeKrx(answers={"MDCSTAT02201": b"<html>error</html>"})
    with pytest.raises(ShapeError, match="JSON이 아님"):
        krx_data.data("dbms/MDC/STAT/standard/MDCSTAT02201", {}, fake)


# ==============================================================================
# 3·4. 모으기
# ==============================================================================
def test_기준일_자료를_받아_순위는_관측치에_나머지는_스냅샷에(store, account):
    fake = FakeKrx(empty_balance_days={"20261109"})
    detail = info_tasks.collect_krx(fetch=fake, now=EVENING, rng=random.Random(2))

    assert "순매수 상위 12/12" in detail
    assert len(fake.data_calls("MDCSTAT02401")) == 12
    rows = store.read_observations(catalog.OBS_KRX_INVESTOR_RANK, obs_date="2026-11-11",
                                   filters={"market": "KOSDAQ", "investor": "투신", "tradeType": "순매수"})
    assert len(rows) == 3
    snap = store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload
    assert snap["asOf"] == "2026-11-11" and snap["failed"] == []
    assert snap["totals"]["KOSPI"]["rows"][0]["netEok"] == 657302.0
    balances = [d["trdDd"] for d in fake.data_calls("MDCSTAT30501")]
    assert balances[:2] == ["20261109", "20261106"], "잔고는 2거래일 앞(11-09)부터 거슬러 처음 나오는 날"
    assert snap["shortBalances"]["KOSPI"]["asOf"] == "2026-11-06"


def test_이미_받은_기준일이면_외부를_부르지_않는다(store, account):
    info_tasks.collect_krx(fetch=FakeKrx(), now=EVENING)
    again = FakeKrx()

    detail = info_tasks.collect_krx(fetch=again, now=EVENING)

    assert again.calls == [] and "외부 호출 0회" in detail


def test_받지_못한_부분은_직전_값을_이어받고_표시한다(store, account):
    info_tasks.collect_krx(fetch=FakeKrx(), now=datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc))
    fake = FakeKrx(answers={"MDCSTAT03701": ladder.FetchFailed("data.krx.co.kr HTTP 503")})

    info_tasks.collect_krx(fetch=fake, now=EVENING)

    snap = store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload
    assert snap["foreign"]["KOSPI"]["isStale"] is True and snap["foreign"]["KOSPI"]["asOf"] == "2026-11-10", "제 기준일을 지킴"
    assert "foreign.KOSPI" in snap["failed"] and snap["totals"]["KOSPI"]["asOf"] == "2026-11-11"


def test_모두_형식이_다르면_형식_바뀜(store, account):
    bad = b"<html>bad</html>"
    fake = FakeKrx(answers={b: bad for b in ("MDCSTAT02401", "MDCSTAT02201", "MDCSTAT03701", "MDCSTAT30101", "MDCSTAT30501")})
    fake.empty_balance_days = set()

    def broken(url, **kwargs):
        if url == krx_data.DATA_URL and kwargs.get("data", {}).get("bld", "").endswith("MDCSTAT30501"):
            return fake._reply(url, bad)
        return fake(url, **kwargs)

    with pytest.raises(ShapeError):
        info_tasks.collect_krx(fetch=broken, now=EVENING)
    assert store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY) is None


# ==============================================================================
# 3-2. 다시 받기와 로그인 거절 (QA-390) — 깰 때마다 로그인하고 전부 다시 받지 않습니다
# ==============================================================================
def test_QA390_다시_받을_때는_받지_못한_부분만_받는다(store, account):
    first = FakeKrx(answers={"MDCSTAT03701": ladder.FetchFailed("data.krx.co.kr HTTP 503")})
    info_tasks.collect_krx(fetch=first, now=EVENING)
    assert sorted(store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload["failed"]) == ["foreign.KOSDAQ", "foreign.KOSPI"]

    again = FakeKrx()
    detail = info_tasks.collect_krx(fetch=again, now=EVENING)

    assert [(m, u.rsplit("/", 1)[-1]) for m, u, _ in again.calls[:3]] == [
        ("GET", "MDCCOMS001.cmd"), ("GET", "login.jsp?site=mdc"), ("POST", "MDCCOMS001D1.cmd")]
    assert sorted(d["bld"].rsplit("/", 1)[-1] for _, url, d in again.calls[3:]) == ["MDCSTAT03701", "MDCSTAT03701"], \
        "로그인 뒤에는 받지 못한 화면 두 건(코스피·코스닥)만 보냅니다"
    snap = store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload
    assert snap["failed"] == [] and snap["asOf"] == "2026-11-11"
    assert snap["foreign"]["KOSPI"]["asOf"] == "2026-11-11" and "isStale" not in snap["foreign"]["KOSPI"]
    assert snap["totals"]["KOSPI"]["asOf"] == "2026-11-11" and "isStale" not in snap["totals"]["KOSPI"], "이미 받은 부분은 그대로"
    assert len(snap["rankings"]) == 12 and "순매수 상위 12/12" in detail

    third = FakeKrx()
    assert "외부 호출 0회" in info_tasks.collect_krx(fetch=third, now=EVENING) and third.calls == []


def test_QA390_순위는_그날_관측치가_있는_쌍을_건너뛴다(store, account):
    empty_once = FakeKrx()
    real = empty_once.__call__

    def kosdaq_pension_empty(url, **kwargs):
        data = kwargs.get("data") or {}
        if url == krx_data.DATA_URL and data.get("bld", "").endswith("MDCSTAT02401") \
                and (data.get("mktId"), data.get("invstTpCd")) == ("KSQ", "6000"):
            empty_once.calls.append((kwargs.get("method", "GET"), url, dict(data)))
            return empty_once._reply(url, {"output": []})
        return real(url, **kwargs)

    info_tasks.collect_krx(fetch=kosdaq_pension_empty, now=EVENING)
    assert store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload["failed"] == ["rank.KOSDAQ.연기금"]

    again = FakeKrx()
    info_tasks.collect_krx(fetch=again, now=EVENING)

    ranks = again.data_calls("MDCSTAT02401")
    assert [(d["mktId"], d["invstTpCd"]) for d in ranks] == [("KSQ", "6000")], "그날 관측치가 이미 있는 11쌍은 다시 받지 않습니다"
    assert len(again.calls) == 3 + 1
    assert store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload["failed"] == []


def test_QA390_하루_예산이_떨어지면_남은_부분을_보내지_않는다(store, account):
    fake = FakeKrx()
    sent = {"data": 0}

    def budget_runs_out(url, **kwargs):
        if url == krx_data.DATA_URL:
            sent["data"] += 1
            if sent["data"] > 5:
                raise ladder.FetchSkipped("data.krx.co.kr 오늘 요청 예산(100건)을 다 써서 보내지 않음")
        return fake(url, **kwargs)

    info_tasks.collect_krx(fetch=budget_runs_out, now=EVENING, rng=random.Random(3))

    assert sent["data"] == 6, "예산이 떨어진 것을 안 뒤에는 남은 부분마다 다시 보내 보지 않습니다(지연만 쌓임)"
    snap = store.read_snapshot(catalog.SNAP_INFO_KRX_DAILY).payload
    assert len(snap["failed"]) == 20 - 5, "받지 못한 부분은 모두 '받지 못함'으로 남아 다음에 그 부분만 다시 받습니다"


def test_QA390_로그인이_거절되면_그_호스트를_닫아_닫힌_동안_로그인을_보내지_않는다(store, account, monkeypatch):
    now = {"t": datetime(2026, 11, 11, 10, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    monkeypatch.setattr(pacing, "_sleep", lambda seconds: None)
    sent: list[tuple[str, str]] = []

    def send(method, url, *, host, headers, params, data):
        sent.append((method, url.rsplit("/", 1)[-1]))
        body = b'{"_error_code": "CD010"}' if url == krx_data.LOGIN_URL else b"<html>login</html>"
        return Reply(status=200, headers={"content-type": "text/html; charset=utf-8"}, body=body, final_url=url)

    monkeypatch.setitem(ladder._SENDERS, policy.TIER_IMPERSONATE, (send, lambda: True))
    state.set_due_at(info_tasks.KRX_TASK, now["t"] - timedelta(minutes=1))

    with pytest.raises(ladder.FetchRejected, match=r"KRX 로그인 거절\(CD010\)") as caught:
        info_tasks.task_info_krx_daily()

    assert sent == [("GET", "MDCCOMS001.cmd"), ("GET", "login.jsp?site=mdc"), ("POST", "MDCCOMS001D1.cmd")]
    assert "test-id-not-real" not in str(caught.value) and "test-pw-not-real" not in str(caught.value)
    shut = state.closed(krx_data.HOST)
    assert shut is not None and timedelta(hours=12) <= shut.until - now["t"] <= timedelta(hours=24), "사람이 고쳐야 풀리는 닫힘"
    row = store.source_state(info_tasks.KRX_TASK)
    assert row["status"] == "blocked" and "KRX 로그인 거절(CD010)" in row["reason"], "출처 상태 '차단' → 끊김 알림"

    # 세 시간 뒤 — 일정이 됐더라도(강제로 당김) 닫힌 동안에는 로그인 요청이 나가지 않습니다.
    now["t"] += timedelta(hours=3)
    state.set_due_at(info_tasks.KRX_TASK, now["t"] - timedelta(minutes=1))
    with pytest.raises(ladder.FetchRejected):
        info_tasks.task_info_krx_daily()
    assert len(sent) == 3, "닫힌 동안 로그인 요청 0건"


def test_QA390_일시_실패는_닫지_않는다(store, account, monkeypatch):
    now = {"t": datetime(2026, 11, 11, 10, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    monkeypatch.setattr(pacing, "_sleep", lambda seconds: None)

    def send(method, url, *, host, headers, params, data):
        status = 503 if url == krx_data.LOGIN_URL else 200
        return Reply(status=status, headers={"content-type": "text/html"}, body=b"<html>busy</html>", final_url=url)

    monkeypatch.setitem(ladder._SENDERS, policy.TIER_IMPERSONATE, (send, lambda: True))

    with pytest.raises(ladder.FetchFailed):
        info_tasks.collect_krx(now=now["t"])

    assert state.closed(krx_data.HOST) is None, "5xx·시간 초과는 로그인 거절이 아닙니다"


# ==============================================================================
# 5. 레이더의 KRX 단계
# ==============================================================================
def test_레이더는_KRX_저장본을_당일엔_가장_가까운_앞_날짜로_과거엔_그_날짜만(store, account):
    info_tasks.collect_krx(fetch=FakeKrx(), now=datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc))

    nearest = radar.fetch_krx_stored_ranking("20261111", "KOSPI", "개인", "순매수", 30, nearest=True)
    exact_miss = radar.fetch_krx_stored_ranking("20261111", "KOSPI", "개인", "순매수", 30, nearest=False)
    exact_hit = radar.fetch_krx_stored_ranking("20261110", "KOSPI", "개인", "순매도", 30, nearest=False)

    assert [r["code"] for r in nearest] == ["000000", "000001", "000002"] and nearest[0]["dataDate"] == "2026-11-10"
    assert "KRX 정보데이터시스템 확정" in nearest[0]["source"]
    assert exact_miss == [], "과거 조회는 다른 날 값을 그 날 값처럼 보이지 않습니다"
    assert [r["code"] for r in exact_hit] == ["000009"]


def test_레이더_체인에서_KRX는_Naver_뒤_토스_앞(monkeypatch):
    order: list[str] = []
    monkeypatch.setattr(radar, "is_regular_session", lambda now=None: False)
    monkeypatch.setattr(radar.kis, "fetch_deal_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "fetch_daum_ranking", lambda *a, **k: [])
    monkeypatch.setattr(radar, "fetch_naver_ranking", lambda *a, **k: order.append("naver") or [])
    monkeypatch.setattr(radar, "fetch_krx_stored_ranking",
                        lambda *a, **k: order.append("krx") or [{"rank": 1, "code": "000001", "source": "KRX"}])
    monkeypatch.setattr(radar, "fetch_toss_ranking", lambda *a, **k: order.append("toss") or [])

    result = radar.collect_radar_ranking(datetime.now(radar.KST).date(), investor="개인")

    assert result["sourceKind"] == "krx" and order == ["naver", "krx"]


# ==============================================================================
# 메커니즘 응답 — 코드에 있는 실제 값을 내려 준다
# ==============================================================================
def test_메커니즘_응답은_스위치_정책_간격을_싣고_외부를_부르지_않는다(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main
    from app.fetch import policy

    monkeypatch.setattr(main, "_check_token", lambda token: None)
    body = TestClient(main.app).get("/info/mechanism").json()

    assert body["politeEnabled"] is True and body["giveUpLevel"] == policy.GIVE_UP_LEVEL
    hosts = {row["host"]: row for row in body["hosts"]}
    assert hosts["data.krx.co.kr"]["tiers"] == ["impersonate"] and hosts["news.waedge.ai"]["dailyBudget"] == 200
    cadences = {row["task"]: row for row in body["cadences"]}
    assert {"info_krx_daily", "info_naver_flows", "econ_calendar_tradingview", "info_blog_wolfstreet"} <= set(cadences)
    assert body["browser"]["configured"] is False and body["browser"]["pressCheckbox"] is None
    assert body["articles"]["retentionDays"] == 180
