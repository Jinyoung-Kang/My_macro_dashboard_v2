"""
tests/test_fetch_browser_client.py
계층 2 호출(app/fetch/browser_client)과 브라우저 컨테이너의 연결 (ADR 0026 결정 8, 명세 docs/specs/2026-11-05-polite-fetch.md §5).

고정하는 규칙
  1. 브라우저 컨테이너의 주소와 공유 비밀이 둘 다 있어야 계층 2가 켜집니다 — 기반 compose는 둘 다 빈 값이라 로컬·QA에서는 꺼져 있습니다.
  2. 보내는 것은 주소(질의 포함)와 기다릴 시간, 공유 비밀뿐입니다. 요청 문맥 머리글은 넘기지 않습니다.
  3. 컨테이너가 거절했거나(비밀·허용 호스트·바쁨) 닿지 못한 것은 전송 실패입니다 — 출처의 거부로 세지 않습니다.
  4. 출처의 답(상태 코드·본문·검사 상태)은 그대로 옮기고 판정은 계층 올라가기가 합니다 — 사람 확인이면 풀지 않고 길게 닫습니다.
  5. 서버 compose의 허용 호스트 목록은 수집기 정책 표에서 계층 2를 쓰는 호스트와 같습니다.

브라우저를 띄우지 않습니다(브라우저 컨테이너 앱 + 가짜 드라이버를 프로세스 안에서 호출). 외부 네트워크에 나가지 않습니다.
"""
from __future__ import annotations

import time
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app import http as app_http
from app.fetch import browser_client, ladder, pacing, policy, state
from app.fetch.reply import TransportError
from sidecar.app import DriverError, create_app

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "shared-secret-for-tests"
PAGE_URL = "https://www.calendar.example/economic-calendar/"
PAGE = {"status": 200, "finalUrl": PAGE_URL, "contentType": "text/html; charset=utf-8",
        "body": "<html><body>달력</body></html>", "challenge": None}


class FakeDriver:
    def __init__(self) -> None:
        self.result: dict = dict(PAGE)
        self.error: Exception | None = None
        self.calls: list[tuple[str, float]] = []

    def fetch(self, url: str, *, wait_seconds: float, allowed: frozenset[str]) -> dict:
        self.calls.append((url, wait_seconds))
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture()
def sidecar(monkeypatch):
    """브라우저 컨테이너 앱(가짜 드라이버)을 계층 2의 호출 대상으로 둡니다. 보낸 요청의 머리글도 기록합니다."""
    driver = FakeDriver()
    client = TestClient(create_app(driver, token=TOKEN, allowed_hosts="www.calendar.example"))
    sent: list[dict] = []

    class Session:
        def post(self, url, **kwargs):
            sent.append({"url": url, **kwargs})
            return client.post(url, json=kwargs["json"], headers=kwargs["headers"])

    monkeypatch.setenv(browser_client.ENV_URL, "http://browser:8191/")
    monkeypatch.setenv(browser_client.ENV_TOKEN, TOKEN)
    monkeypatch.setattr(browser_client, "_http", lambda: Session())
    return types.SimpleNamespace(driver=driver, sent=sent)


def _send(url: str = PAGE_URL, **kwargs):
    return browser_client.send("GET", url, host="www.calendar.example", **kwargs)


# ==============================================================================
# 1. 켜짐
# ==============================================================================
@pytest.mark.parametrize("url, token, expected", [
    ("http://browser:8191", TOKEN, True),
    ("", TOKEN, False),
    ("http://browser:8191", "", False),
    ("  ", "  ", False),
])
def test_주소와_공유_비밀이_둘_다_있어야_켜진다(monkeypatch, url, token, expected):
    monkeypatch.setenv(browser_client.ENV_URL, url)
    monkeypatch.setenv(browser_client.ENV_TOKEN, token)

    assert browser_client.available() is expected


def test_꺼져_있으면_부르지_않는다(monkeypatch):
    monkeypatch.delenv(browser_client.ENV_URL, raising=False)
    monkeypatch.delenv(browser_client.ENV_TOKEN, raising=False)

    assert browser_client.available() is False
    with pytest.raises(TransportError, match="설정돼 있지 않음"):
        _send()


def test_기반_compose는_계층_2를_끄고_서버_덧붙임만_서버_env_값을_넘긴다():
    base = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    overlay = yaml.safe_load((ROOT / "compose.vultr.yml").read_text(encoding="utf-8"))

    assert base["services"]["collector"]["environment"]["BROWSER_FETCH_URL"] == ""
    assert base["services"]["collector"]["environment"]["BROWSER_FETCH_TOKEN"] == ""
    assert "browser" not in base["services"], "브라우저 컨테이너는 서버 덧붙임에만 있습니다"
    collector = overlay["services"]["collector"]
    assert collector["environment"]["BROWSER_FETCH_URL"] == "${BROWSER_FETCH_URL:-}"
    assert collector["environment"]["BROWSER_FETCH_TOKEN"] == "${BROWSER_FETCH_TOKEN:-}"
    assert collector["networks"] == ["default", "fetchnet"], "기본 망을 함께 적어야 postgres에 닿습니다"
    browser = overlay["services"]["browser"]
    assert "ports" not in browser and browser["networks"] == ["fetchnet"]
    assert browser["cap_drop"] == ["ALL"] and "no-new-privileges:true" in browser["security_opt"]
    assert browser["environment"]["BROWSER_FETCH_TOKEN"] == "${BROWSER_FETCH_TOKEN:-}"


# ==============================================================================
# 2. 보내는 것
# ==============================================================================
def test_주소와_기다릴_시간과_공유_비밀만_보낸다(sidecar):
    reply = _send(headers={"Origin": "https://www.calendar.example", "Referer": "https://www.calendar.example/"},
                  params={"country": "KR", "week": "this week"})

    assert sidecar.driver.calls == [(f"{PAGE_URL}?country=KR&week=this+week", browser_client.WAIT_SECONDS)]
    sent = sidecar.sent[0]
    assert sent["url"] == "http://browser:8191/fetch"
    assert sent["json"] == {"url": f"{PAGE_URL}?country=KR&week=this+week", "waitSeconds": browser_client.WAIT_SECONDS}
    assert sent["headers"] == {browser_client.TOKEN_HEADER: TOKEN}, "요청 문맥 머리글은 넘기지 않습니다 — 브라우저가 스스로 보냅니다"
    assert (reply.status, reply.content_type, reply.challenge) == (200, "text/html; charset=utf-8", None)
    assert reply.body.decode("utf-8") == "<html><body>달력</body></html>" and reply.final_url == PAGE_URL


@pytest.mark.parametrize("method, data", [("POST", None), ("GET", {"a": "1"})])
def test_GET으로_여는_페이지만_받는다(sidecar, method, data):
    with pytest.raises(TransportError, match="GET으로 여는 페이지만"):
        browser_client.send(method, PAGE_URL, host="www.calendar.example", data=data)

    assert sidecar.sent == []


def test_태스크_시간_예산이_모자라면_브라우저를_부르지_않는다(sidecar):
    short = app_http.TaskGuard(deadline=time.monotonic() + browser_client.MIN_TIME_LEFT - 10)

    with pytest.raises(TransportError, match="브라우저를 부르지 않음"):
        app_http.run_guarded(short, _send)

    assert sidecar.sent == []


def test_안쪽_망의_호출은_환경_프록시를_따르지_않는다(monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://qaproxy:8888")

    assert browser_client._http().trust_env is False


# ==============================================================================
# 3. 컨테이너의 거절·닿지 못함은 전송 실패
# ==============================================================================
def test_공유_비밀이_틀리면_전송_실패(sidecar, monkeypatch):
    monkeypatch.setenv(browser_client.ENV_TOKEN, "wrong")

    with pytest.raises(TransportError, match=r"요청을 받지 않음\(HTTP 401\)"):
        _send()

    assert sidecar.driver.calls == []


def test_허용_호스트가_아니면_전송_실패(sidecar):
    with pytest.raises(TransportError, match=r"요청을 받지 않음\(HTTP 400\)"):
        _send("https://www.other.example/")


def test_브라우저가_받지_못하면_전송_실패(sidecar):
    sidecar.driver.error = DriverError("브라우저 오류: 시간 초과")

    with pytest.raises(TransportError, match=r"요청을 받지 않음\(HTTP 502\)"):
        _send()


def test_컨테이너에_닿지_못하면_전송_실패이고_비밀을_싣지_않는다(monkeypatch):
    monkeypatch.setenv(browser_client.ENV_URL, "http://127.0.0.1:9")       # 듣는 곳이 없는 포트
    monkeypatch.setenv(browser_client.ENV_TOKEN, TOKEN)

    with pytest.raises(TransportError, match="브라우저 컨테이너에 닿지 못함") as caught:
        _send()

    assert TOKEN not in str(caught.value)


def test_답을_읽지_못하면_전송_실패(sidecar):
    sidecar.driver.result = {"finalUrl": PAGE_URL}        # status 없음

    with pytest.raises(TransportError, match="답을 읽지 못함"):
        _send()


# ==============================================================================
# 4. 판정은 계층 올라가기가 — 로컬 서버(계층 1) + 브라우저 컨테이너 앱(계층 2)
# ==============================================================================
@pytest.fixture()
def both_tiers(server, store, sidecar, monkeypatch):
    now = {"t": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    monkeypatch.setattr(pacing, "_sleep", lambda seconds: None)
    monkeypatch.setitem(policy.POLICIES, "127.0.0.1", policy.HostPolicy(
        "127.0.0.1", (policy.TIER_IMPERSONATE, policy.TIER_BROWSER), daily_budget=20))
    server.routes["/calendar"] = [(403, {"Content-Type": "text/html"}, b"<html>Forbidden</html>")]
    # 브라우저 컨테이너는 https 허용 호스트만 엽니다 — 이 시험은 계층 2의 문지기를 지나가도록 드라이버 앞의 검사만 열어 둡니다.
    monkeypatch.setattr("sidecar.guard.top_level_allowed", lambda url, allowed: True)
    # 가짜 드라이버의 기본 답은 최종 주소가 다른 호스트(PAGE_URL)입니다. 사다리는 최종 주소가 정책 표 밖인 답을 버리므로(QA-388),
    # 이 묶음에서는 연 주소 그대로 끝난 답으로 둡니다.
    sidecar.driver.result = {**PAGE, "finalUrl": f"{server.base}/calendar"}
    return types.SimpleNamespace(server=server, store=store, sidecar=sidecar, now=now)


def test_계층_1이_거부당하면_브라우저_컨테이너로_한_번_올라가_통과한다(both_tiers):
    got = ladder.fetch(f"{both_tiers.server.base}/calendar")

    assert got.tier == policy.TIER_BROWSER and "달력" in got.text()
    assert both_tiers.server.hits == ["/calendar"] and len(both_tiers.sidecar.driver.calls) == 1
    assert state.last_good_tier("127.0.0.1") == policy.TIER_BROWSER


def test_QA388_브라우저가_정책_표_밖의_주소에서_끝나면_그_답을_쓰지_않는다(both_tiers):
    both_tiers.sidecar.driver.result = {**PAGE, "finalUrl": "http://backend:8080/api/health", "body": "<html>internal</html>"}

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{both_tiers.server.base}/calendar")

    assert caught.value.why == "HTTP 403(계층 impersonate)", "올라간 계층에서 받지 못했으니 아래 계층의 거부가 최종입니다"
    assert state.last_good_tier("127.0.0.1") is None


def test_브라우저가_사람_확인을_만나면_풀지_않고_길게_닫는다(both_tiers):
    both_tiers.sidecar.driver.result = {**PAGE, "status": 403, "challenge": "human"}

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{both_tiers.server.base}/calendar")

    shut = caught.value.closed
    assert shut.reason == "사람 확인 요구(계층 browser)"
    assert timedelta(hours=12) <= shut.until - both_tiers.now["t"] <= timedelta(hours=24)
    assert len(both_tiers.sidecar.driver.calls) == 1


def test_브라우저_컨테이너가_거절하면_계층_1의_거부로_닫는다(both_tiers, monkeypatch):
    monkeypatch.setenv(browser_client.ENV_TOKEN, "wrong")

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{both_tiers.server.base}/calendar")

    assert caught.value.why == "HTTP 403(계층 impersonate)"


def test_계층_2가_꺼져_있으면_계층_1의_거부가_최종(both_tiers, monkeypatch):
    monkeypatch.setenv(browser_client.ENV_URL, "")

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{both_tiers.server.base}/calendar")

    assert caught.value.why == "HTTP 403(계층 impersonate)" and both_tiers.sidecar.sent == []


# ==============================================================================
# 5. 허용 호스트 목록 = 정책 표에서 계층 2를 쓰는 호스트
# ==============================================================================
def test_서버_compose의_허용_호스트는_정책_표에서_계층_2를_쓰는_호스트와_같다():
    overlay = yaml.safe_load((ROOT / "compose.vultr.yml").read_text(encoding="utf-8"))
    allowed = {host.strip().lower() for host in overlay["services"]["browser"]["environment"]["BROWSER_ALLOWED_HOSTS"].split(",")
               if host.strip()}
    wanted = {rules.host for rules in policy.POLICIES.values() if policy.TIER_BROWSER in rules.tiers}

    assert allowed == wanted, "출처를 계층 2에 연결할 때 수집기 정책 표와 compose.vultr.yml을 같은 커밋에서 고칩니다"
