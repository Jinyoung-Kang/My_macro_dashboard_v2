"""
tests/test_fetch_ladder.py
차단 통과 수집 계층(app/fetch — ADR 0026, 명세 docs/specs/2026-11-05-polite-fetch.md §2·§3)의 규칙.

고정하는 규칙
  1. 판정 — 2xx이고 기대한 모양이면 통과. 403·429·차단 페이지 표지·'JSON 대신 HTML'은 거부. 404·5xx·전송 실패는 그 실행만 실패(물러나지 않음).
  2. 거부되면 한 번만 위 계층으로 올라가고, 통과한 계층을 기억해 다음에는 그 계층부터 시작합니다. 올라갈 곳이 없으면 물러납니다 —
     1회 30~60분, 2회 3~6시간, 3회 이상 12~24시간, 연속 5회면 포기(운영자가 풀 때까지). 닫힌 동안은 네트워크에 나가지 않습니다.
  3. 사람 확인은 풀지 않고 12~24시간 닫습니다(연속 거부는 올리지 않음).
  4. 닫힘은 이 계층의 표에만 있습니다 — 공용 세션의 5분 호스트 래치를 닫지 않아, 같은 호스트의 기존 수집이 그대로 나갑니다.
  5. 호스트별 하루 예산(KST 날짜)을 넘기지 않고, 같은 호스트의 요청 사이에는 4~16초(가끔 20~46초)의 불규칙한 지연을 둡니다. 첫 요청은
     기다리지 않습니다. 태스크 시간 예산이 모자라면 자지 않고 다음 회차로 넘깁니다.
  6. 호스트마다 브라우저 프로필 하나를 고정합니다 — 요청마다 바꾸지 않고, 재기동(프로세스 기록을 비움) 뒤에도 같고, curl_cffi 판이
     바뀔 때만 다시 뽑습니다. User-Agent를 덮어쓰지 못하고, 프록시 인자를 넘기지 않습니다.
  7. 실행기 — 거부로 끝난 실행은 error '거부됨'으로 적힙니다(empty '수집 결과 없음'이 아님).

외부 네트워크에 나가지 않습니다(127.0.0.1의 로컬 서버, 가짜 계층 2, 가짜 시계). 표는 시험마다 새 스키마입니다.
"""
from __future__ import annotations

import random
import re
import time
import types
from datetime import datetime, timedelta, timezone

import pytest

from app import http as app_http
from app import tasks
from app.fetch import impersonate, ladder, pacing, policy, state
from app.fetch.reply import CHALLENGE_HUMAN, CHALLENGE_JS, Reply, TransportError

HOST = "127.0.0.1"
JSON = {"Content-Type": "application/json"}
HTML = {"Content-Type": "text/html; charset=UTF-8"}
PAGE = b"<html><head><title>Economic Calendar</title></head><body><table id='rows'></table></body></html>"
CLOUDFLARE_CHALLENGE = (b"<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title>"
                        b"<script>window._cf_chl_opt={cvId: '3'};</script></head><body>Enable JavaScript</body></html>")


@pytest.fixture()
def clock(monkeypatch):
    """닫힘·예산·일정이 보는 시계(app.fetch.state._utcnow)를 손으로 돌립니다."""
    now = {"t": datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)}      # KST 12:00
    monkeypatch.setattr(state, "_utcnow", lambda: now["t"])
    return now


@pytest.fixture()
def local(server, store, clock, monkeypatch):
    """127.0.0.1을 정책 표에 넣고(계층 1만, 하루 50건) 지연은 자지 않고 기록만 합니다."""
    waits: list[float] = []
    monkeypatch.setattr(pacing, "_sleep", waits.append)
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(HOST, (policy.TIER_IMPERSONATE,), daily_budget=50))
    return types.SimpleNamespace(server=server, store=store, clock=clock, waits=waits)


def _with_browser(monkeypatch, replies: list, budget: int = 50) -> list[str]:
    """가짜 계층 2를 붙입니다 — ``replies``를 차례로 돌려주고(마지막은 반복, 예외면 던짐) 받은 주소를 기록합니다."""
    calls: list[str] = []

    def send(method, url, *, host, headers, params, data):
        calls.append(url)
        answer = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setitem(ladder._SENDERS, policy.TIER_BROWSER, (send, lambda: True))
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(
        HOST, (policy.TIER_IMPERSONATE, policy.TIER_BROWSER), daily_budget=budget))
    return calls


def _browser_page(body: bytes = PAGE, status: int = 200, challenge: str | None = None) -> Reply:
    return Reply(status=status, headers={"content-type": "text/html"}, body=body,
                 final_url="http://127.0.0.1/page", challenge=challenge)


# ==============================================================================
# 1. 판정
# ==============================================================================
def test_통과하면_본문과_통과한_계층을_돌려주고_그_계층을_기억한다(local):
    local.server.routes["/calendar"] = [(200, HTML, PAGE)]

    got = ladder.fetch(f"{local.server.base}/calendar")

    assert (got.status, got.tier, got.body) == (200, policy.TIER_IMPERSONATE, PAGE)
    assert "Economic Calendar" in got.text()
    assert state.last_good_tier(HOST) == policy.TIER_IMPERSONATE
    assert state.closed(HOST) is None
    assert local.waits == [], "그 실행에서 그 호스트로 가는 첫 요청은 기다리지 않습니다"


def test_JSON을_기대한_답은_파싱해_쓴다(local):
    local.server.routes["/events"] = [(200, JSON, b'{"status": "ok", "result": [{"title": "CPI"}]}')]

    got = ladder.fetch(f"{local.server.base}/events", expect=policy.EXPECT_JSON)

    assert got.json() == {"status": "ok", "result": [{"title": "CPI"}]}


@pytest.mark.parametrize("answer, why", [
    ((403, HTML, b"<html>Forbidden</html>"), "HTTP 403"),
    ((429, JSON, b"{}"), "HTTP 429"),
    ((403, {"cf-mitigated": "challenge", **HTML}, CLOUDFLARE_CHALLENGE), "HTTP 403(cf-mitigated)"),
    ((200, HTML, CLOUDFLARE_CHALLENGE), "차단 응답(HTTP 200, Cloudflare 챌린지)"),
])
def test_거부는_403과_429와_차단_페이지_표지(local, answer, why):
    local.server.routes["/page"] = [answer]

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")

    assert caught.value.why == f"{why}(계층 impersonate)"
    assert str(caught.value).startswith(f"거부됨 — {HOST} {why}(계층 impersonate) · ")
    assert "/page" not in str(caught.value), "주소(쿼리의 값)는 사유에 싣지 않습니다"


def test_JSON을_기대했는데_HTML이_오면_거부(local):
    local.server.routes["/data"] = [(200, HTML, b"<html><body>Access Denied</body></html>")]

    with pytest.raises(ladder.FetchRejected, match="JSON 대신 HTML 응답"):
        ladder.fetch(f"{local.server.base}/data", expect=policy.EXPECT_JSON)

    assert state.closed(HOST) is not None, "'데이터 없음'이 아니라 출처의 거부라 물러납니다"


@pytest.mark.parametrize("status", [404, 500, 503])
def test_그_밖의_실패는_그_실행만_실패하고_물러나지_않는다(local, status):
    local.server.routes["/page"] = [(status, HTML, b"<html>oops</html>")]

    with pytest.raises(ladder.FetchFailed, match=f"HTTP {status}"):
        ladder.fetch(f"{local.server.base}/page")

    assert state.closed(HOST) is None, "출처의 거부가 아니라 닫지 않습니다"
    assert local.server.hits == ["/page"], "다시 보내지 않습니다"


def test_답이_없으면_전송_실패로_끝나고_물러나지_않는다(local):
    local.server.routes["/page"] = ["RESET"]

    with pytest.raises(ladder.FetchFailed):
        ladder.fetch(f"{local.server.base}/page")

    assert state.closed(HOST) is None


def test_정책_표에_없는_호스트는_받지_않는다(server, store):
    with pytest.raises(policy.UnknownHost):
        ladder.fetch(f"{server.base}/page")

    assert server.hits == []


def test_정상_페이지에도_있는_흔적은_거부로_보지_않는다(local):
    normal = (b"<html><head><script src=\"/cdn-cgi/challenge-platform/scripts/jsd/main.js\"></script></head>"
              b"<body>captcha notice - CPI 3.1%</body></html>")
    local.server.routes["/page"] = [(200, HTML, normal)]

    assert ladder.fetch(f"{local.server.base}/page").body == normal


# ==============================================================================
# 2. 계층 올라가기와 물러남
# ==============================================================================
def test_거부되면_지연_뒤_한_번만_위_계층으로_올라가고_다음에는_그_계층부터(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    calls = _with_browser(monkeypatch, [_browser_page()])

    got = ladder.fetch(f"{local.server.base}/page")

    assert got.tier == policy.TIER_BROWSER and got.body == PAGE
    assert local.server.hits == ["/page"] and len(calls) == 1
    assert len(local.waits) == 1 and 4.0 <= local.waits[0] < 46.0, "올라가기 전에 사람 같은 틈을 둡니다"
    assert state.last_good_tier(HOST) == policy.TIER_BROWSER and state.closed(HOST) is None

    ladder.fetch(f"{local.server.base}/page")

    assert local.server.hits == ["/page"], "매번 아래 계층에서 한 번 거부당하고 올라가지 않습니다"
    assert len(calls) == 2


def test_위_계층도_거부하면_물러나고_닫힌_동안은_나가지_않는다(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    calls = _with_browser(monkeypatch, [_browser_page(challenge=CHALLENGE_JS)])

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")

    shut = caught.value.closed
    assert shut.reason == "JS 검사를 지나가지 못함(계층 browser)" and shut.given_up is False
    assert timedelta(minutes=30) <= shut.until - local.clock["t"] <= timedelta(minutes=60)
    assert local.store.fetch_host(HOST)["fail_level"] == 1

    with pytest.raises(ladder.FetchRejected) as again:
        ladder.fetch(f"{local.server.base}/other")

    assert str(again.value) == str(caught.value), "닫힌 동안의 요청도 같은 한 줄입니다"
    assert local.server.hits == ["/page"] and len(calls) == 1, "닫힌 동안은 어느 계층으로도 나가지 않습니다"


def test_올라간_계층에_닿지_못하면_아래_계층의_거부가_최종(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    _with_browser(monkeypatch, [TransportError("브라우저 컨테이너에 닿지 못함")])

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")

    assert caught.value.why == "HTTP 403(계층 impersonate)"


def test_쓸_수_없는_계층은_건너뛴다(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    calls = _with_browser(monkeypatch, [_browser_page()])
    monkeypatch.setitem(ladder._SENDERS, policy.TIER_BROWSER, (ladder._SENDERS[policy.TIER_BROWSER][0], lambda: False))

    with pytest.raises(ladder.FetchRejected):
        ladder.fetch(f"{local.server.base}/page")

    assert calls == [], "브라우저 컨테이너가 꺼져 있으면 계층 1의 거부가 최종입니다"


def test_물러남은_거부가_쌓일수록_길어지고_다섯_번이면_포기(local):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    spans = []
    for _ in range(4):
        with pytest.raises(ladder.FetchRejected) as caught:
            ladder.fetch(f"{local.server.base}/page")
        spans.append(caught.value.closed.until - local.clock["t"])
        local.clock["t"] = caught.value.closed.until + timedelta(seconds=1)       # 기한이 지나 다시 열림

    assert timedelta(minutes=30) <= spans[0] <= timedelta(minutes=60)
    assert timedelta(hours=3) <= spans[1] <= timedelta(hours=6)
    assert all(timedelta(hours=12) <= span <= timedelta(hours=24) for span in spans[2:])

    with pytest.raises(ladder.FetchRejected) as fifth:
        ladder.fetch(f"{local.server.base}/page")

    assert fifth.value.closed.given_up is True and fifth.value.closed.until is None
    assert "연속 5회 거부로 포기(운영자가 풀 때까지 다시 시도하지 않음)" in str(fifth.value)
    assert len(local.server.hits) == 5

    local.clock["t"] += timedelta(days=30)
    with pytest.raises(ladder.FetchRejected, match="포기"):
        ladder.fetch(f"{local.server.base}/page")
    assert len(local.server.hits) == 5, "포기한 출처는 시간이 지나도 다시 시도하지 않습니다"


def test_통과하면_연속_거부가_0으로_돌아간다(local):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>"), (200, HTML, PAGE)]

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")
    local.clock["t"] = caught.value.closed.until + timedelta(seconds=1)
    ladder.fetch(f"{local.server.base}/page")

    row = local.store.fetch_host(HOST)
    assert (row["fail_level"], row["blocked_until"], row["blocked_reason"]) == (0, None, None)


# ==============================================================================
# 3. 사람 확인
# ==============================================================================
def test_사람_확인은_풀지_않고_길게_닫는다(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    calls = _with_browser(monkeypatch, [_browser_page(challenge=CHALLENGE_HUMAN)])

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")

    shut = caught.value.closed
    assert shut.reason == "사람 확인 요구(계층 browser)"
    assert timedelta(hours=12) <= shut.until - local.clock["t"] <= timedelta(hours=24)
    assert local.store.fetch_host(HOST)["fail_level"] == 0, "사람 확인은 포기로 가는 셈에 넣지 않습니다"
    assert len(calls) == 1, "한 번 요구받으면 다시 두드리지 않습니다"


# ==============================================================================
# 4. 공용 세션의 래치와 분리
# ==============================================================================
def test_새_계층의_거부가_공용_세션의_호스트_래치를_닫지_않는다(local):
    local.server.routes["/news"] = [(403, HTML, b"<html>Forbidden</html>")]
    local.server.routes["/rss"] = [(200, {"Content-Type": "application/rss+xml"}, b"<rss></rss>")]

    with pytest.raises(ladder.FetchRejected):
        ladder.fetch(f"{local.server.base}/news")

    assert app_http.active_rejection(HOST) is None, "공용 세션의 5분 래치는 열려 있습니다"
    response = app_http.get_session().get(f"{local.server.base}/rss", timeout=2)
    assert response.status_code == 200 and local.server.hits == ["/news", "/rss"], "같은 호스트의 기존 수집(RSS)은 그대로 나갑니다"


def test_공용_세션의_래치가_닫혀_있어도_새_계층은_자기_표만_본다(local):
    app_http.reject_host(HOST, "HTTP 429")
    local.server.routes["/calendar"] = [(200, HTML, PAGE)]

    assert ladder.fetch(f"{local.server.base}/calendar").status == 200


# ==============================================================================
# 5. 하루 예산과 지연
# ==============================================================================
def test_하루_예산을_넘기지_않고_KST_날짜가_바뀌면_다시_센다(local, monkeypatch):
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(HOST, (policy.TIER_IMPERSONATE,), daily_budget=2))
    local.server.routes["/page"] = [(200, HTML, PAGE)]

    ladder.fetch(f"{local.server.base}/page")
    ladder.fetch(f"{local.server.base}/page")
    with pytest.raises(ladder.FetchSkipped, match=r"오늘 요청 예산\(2건\)"):
        ladder.fetch(f"{local.server.base}/page")
    assert len(local.server.hits) == 2
    assert state.closed(HOST) is None, "예산 소진은 거부가 아닙니다"

    local.clock["t"] = datetime(2026, 11, 5, 15, 0, 1, tzinfo=timezone.utc)      # KST 2026-11-06 00:00:01
    ladder.fetch(f"{local.server.base}/page")
    assert len(local.server.hits) == 3


def test_위_계층으로_올라간_요청도_예산을_한_건_쓴다(local, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    _with_browser(monkeypatch, [_browser_page()], budget=1)

    with pytest.raises(ladder.FetchSkipped):
        ladder.fetch(f"{local.server.base}/page")

    assert state.closed(HOST) is None, "올라가지 못한 것은 예산 때문이라 그 거부로 닫지 않습니다(다음 회차에 다시)"


def test_같은_호스트의_요청_사이에는_불규칙한_틈을_둔다(local):
    local.server.routes["/page"] = [(200, HTML, PAGE)]

    for _ in range(6):
        ladder.fetch(f"{local.server.base}/page")

    assert len(local.waits) == 5, "첫 요청만 기다리지 않습니다"
    assert all(3.9 <= wait < 16.0 or 19.9 <= wait < 46.0 for wait in local.waits)
    assert len({round(wait, 3) for wait in local.waits}) == 5, "같은 간격이 되풀이되지 않습니다"


def test_지연은_4에서_16초_사이이고_열에_한_번쯤은_길게_쉰다(monkeypatch):
    monkeypatch.setattr(pacing, "_rng", random.Random(20261105))
    draws = [pacing.draw(policy.Gap()) for _ in range(4000)]

    short = [value for value in draws if value < 16.0]
    long = [value for value in draws if value >= 20.0]
    assert len(short) + len(long) == len(draws) and min(short) >= 4.0 and max(long) < 46.0
    assert 0.07 < len(long) / len(draws) < 0.13
    assert len(set(draws)) == len(draws), "초 단위로 떨어지는 값이 아니라 잡음이 얹힌 값이라 같은 지연이 되풀이되지 않습니다"
    middle = sorted(short)[len(short) // 2]
    assert 6.5 < middle < 8.5, "보통은 7초 안팎입니다"


def test_태스크_시간_예산이_모자라면_자지_않고_다음_회차로_넘긴다(local):
    local.server.routes["/page"] = [(200, HTML, PAGE)]
    short = app_http.TaskGuard(deadline=time.monotonic() + pacing.MIN_LEFT_AFTER_PAUSE - 5)

    with pytest.raises(ladder.FetchSkipped, match="다음 회차로 넘김"):
        app_http.run_guarded(short, lambda: ladder.fetch(f"{local.server.base}/page"))

    assert local.server.hits == [] and local.waits == []
    assert local.store.fetch_host(HOST) is None, "보내지 않은 요청은 예산을 쓰지 않습니다"


# ==============================================================================
# 6. 고정 프로필 · User-Agent · 프록시
# ==============================================================================
def test_프로필_후보는_설치된_curl_cffi의_최신_데스크톱_Chrome_셋():
    candidates = state.profile_candidates()

    assert len(candidates) == state.PROFILE_CANDIDATES
    numbers = [int(re.fullmatch(r"chrome(\d+)", name).group(1)) for name in candidates]
    assert numbers == sorted(numbers, reverse=True), "최신부터 — 안드로이드·별칭·옛 이름은 후보가 아닙니다"


def test_호스트마다_프로필_하나를_고정하고_요청마다_바꾸지_않는다(local):
    local.server.routes["/page"] = [(200, HTML, PAGE)]

    for _ in range(4):
        ladder.fetch(f"{local.server.base}/page")
    ladder.reset()                                    # 재기동 — 프로세스 안의 세션·지연 기록이 사라짐
    ladder.fetch(f"{local.server.base}/page")

    agents = {seen["user-agent"] for seen in local.server.seen}
    assert len(agents) == 1 and "Chrome/" in next(iter(agents)), "User-Agent는 요청마다도, 재기동 뒤에도 같습니다"
    row = local.store.fetch_host(HOST)
    assert row["profile"] in state.profile_candidates() and row["profile_lib"] == state.curl_cffi.__version__


def test_curl_cffi_판이_바뀔_때만_프로필을_다시_뽑는다(local, monkeypatch):
    first = state.profile_for(HOST)
    assert state.profile_for(HOST) == first

    monkeypatch.setattr(state.curl_cffi, "__version__", "99.0.0")
    monkeypatch.setattr(state, "profile_candidates", lambda: ["chrome999"])
    assert state.profile_for(HOST) == "chrome999"
    assert local.store.fetch_host(HOST)["profile_lib"] == "99.0.0"


def test_User_Agent를_덮어쓸_수_없다(local):
    with pytest.raises(ValueError, match="User-Agent를 덮어쓰지 않습니다"):
        ladder.fetch(f"{local.server.base}/page", headers={"User-Agent": "Mozilla/5.0 (random)"})

    assert local.server.hits == []


def test_요청_문맥_머리글은_그대로_실린다(local):
    local.server.routes["/events"] = [(200, JSON, b"{}")]

    ladder.fetch(f"{local.server.base}/events", expect=policy.EXPECT_JSON,
                 headers={"Referer": "https://www.example.org/calendar/", "Origin": "https://www.example.org"})

    assert local.server.seen[-1]["referer"] == "https://www.example.org/calendar/"
    assert local.server.seen[-1]["origin"] == "https://www.example.org"


def test_프록시_인자를_넘기지_않는다(local, monkeypatch):
    made: list[dict] = []
    sent: list[dict] = []
    real = impersonate.curl_requests.Session

    class Spy(real):
        def __init__(self, **kwargs):
            made.append(kwargs)
            super().__init__(**kwargs)

        def request(self, method, url, **kwargs):
            sent.append(kwargs)
            return super().request(method, url, **kwargs)

    monkeypatch.setattr(impersonate.curl_requests, "Session", Spy)
    local.server.routes["/page"] = [(200, HTML, PAGE)]

    ladder.fetch(f"{local.server.base}/page")

    assert set(made[0]) == {"impersonate"}, "세션은 프로필만 정합니다 — 프록시·검증 끄기·환경 무시 같은 인자가 없습니다"
    assert not {"proxies", "proxy", "proxy_auth", "verify"} & set(sent[0])


# ==============================================================================
# 8. 리다이렉트 (QA-388) — 계층 1은 따라가지 않고, 사다리가 정책 표 안의 https 목적지만 홉마다 보통 요청처럼 받습니다
# ==============================================================================
QA388 = pytest.mark.xfail(strict=True, reason="QA-388: 계층 1(curl_cffi 세션)이 리다이렉트를 검사 없이 따라갑니다")


def _redirect(location: str, status: int = 302):
    return (status, {"Location": location, "Content-Type": "text/html"}, b"")


@pytest.fixture()
def http_hops(monkeypatch):
    """로컬 서버는 http라, 같은 호스트 안의 홉을 보려는 시험만 리다이렉트 목적지의 허용 scheme에 http를 더합니다(운영 값은 https뿐)."""
    monkeypatch.setattr(ladder, "REDIRECT_SCHEMES", frozenset({"https", "http"}), raising=False)


@QA388
def test_QA388_정책_표_밖으로_가는_리다이렉트는_따라가지_않는다(local, http_hops):
    # 정책 표에는 127.0.0.1만 있습니다 — 같은 서버를 가리키는 localhost는 표 밖의 호스트입니다(내부 주소로 돌리는 출처의 모양).
    local.server.routes["/a"] = [_redirect(f"http://localhost:{local.server.port}/secret")]
    local.server.routes["/secret"] = [(200, HTML, b"<html><body>internal only</body></html>")]

    with pytest.raises(ladder.FetchFailed, match="정책 표 밖으로 리다이렉트 — 따라가지 않음: localhost"):
        ladder.fetch(f"{local.server.base}/a")

    assert local.server.hits == ["/a"], "표 밖의 목적지에는 요청이 나가지 않습니다"
    assert state.closed(HOST) is None, "출처의 거부가 아니라 닫지 않습니다"


@QA388
def test_QA388_https가_아닌_목적지는_따라가지_않는다(local):
    local.server.routes["/a"] = [_redirect("/b")]                       # 같은 호스트지만 http
    local.server.routes["/b"] = [(200, HTML, PAGE)]

    with pytest.raises(ladder.FetchFailed, match="https가 아닌 주소로 리다이렉트 — 따라가지 않음"):
        ladder.fetch(f"{local.server.base}/a")

    assert local.server.hits == ["/a"]


@QA388
def test_QA388_정책_표_안의_리다이렉트는_홉마다_보통_요청처럼_받는다(local, http_hops, monkeypatch):
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(HOST, (policy.TIER_IMPERSONATE,), daily_budget=3))
    local.server.routes["/a"] = [_redirect("/b?page=2", status=301)]    # 상대 주소
    local.server.routes["/b"] = [(200, HTML, PAGE)]

    got = ladder.fetch(f"{local.server.base}/a", headers={"Referer": "https://www.example.org/"})

    assert (got.status, got.body, got.url) == (200, PAGE, f"{local.server.base}/a")
    assert got.final_url == f"{local.server.base}/b?page=2"
    assert local.server.hits == ["/a", "/b"]
    assert local.server.seen[-1]["referer"] == "https://www.example.org/", "같은 호스트 안의 홉은 요청 문맥을 그대로 싣습니다"
    assert len(local.waits) == 1, "홉도 그 호스트의 요청 사이 지연을 지납니다"
    assert local.store.fetch_host(HOST)["budget_used"] == 2, "홉도 하루 예산을 한 건 씁니다"


@QA388
def test_QA388_홉이_하루_예산을_넘기면_보내지_않는다(local, http_hops, monkeypatch):
    monkeypatch.setitem(policy.POLICIES, HOST, policy.HostPolicy(HOST, (policy.TIER_IMPERSONATE,), daily_budget=1))
    local.server.routes["/a"] = [_redirect("/b")]
    local.server.routes["/b"] = [(200, HTML, PAGE)]

    with pytest.raises(ladder.FetchSkipped, match=r"오늘 요청 예산\(1건\)"):
        ladder.fetch(f"{local.server.base}/a")

    assert local.server.hits == ["/a"]


@QA388
def test_QA388_리다이렉트는_세_번까지만_따라간다(local, http_hops):
    for n in range(1, 5):
        local.server.routes[f"/h{n}"] = [_redirect(f"/h{n + 1}")]
    local.server.routes["/h5"] = [(200, HTML, PAGE)]

    with pytest.raises(ladder.FetchFailed, match="리다이렉트가 3번을 넘음"):
        ladder.fetch(f"{local.server.base}/h1")
    assert local.server.hits == ["/h1", "/h2", "/h3", "/h4"]

    local.server.hits.clear()
    assert ladder.fetch(f"{local.server.base}/h2").body == PAGE, "세 번까지는 따라갑니다"
    assert local.server.hits == ["/h2", "/h3", "/h4", "/h5"]


@QA388
def test_QA388_계층_2가_정책_표_밖의_주소에서_받은_답은_통과로_돌려주지_않는다(local, monkeypatch):
    # 계층 2(실제 브라우저)는 리다이렉트를 스스로 따라갑니다. 받은 뒤의 최종 주소가 표 밖이면 본문을 버립니다(저장·전파를 막는 사후 방어).
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    inside = Reply(status=200, headers={"content-type": "text/html"}, body=b"<html>internal</html>",
                   final_url="http://backend:8080/api/health")
    calls = _with_browser(monkeypatch, [inside])

    with pytest.raises(ladder.FetchRejected) as caught:
        ladder.fetch(f"{local.server.base}/page")

    assert caught.value.why == "HTTP 403(계층 impersonate)", "올라간 계층에서 받지 못했으니 아래 계층의 거부가 최종입니다"
    assert len(calls) == 1
    assert state.last_good_tier(HOST) is None, "표 밖에서 받은 답으로 그 계층을 '통과'로 기억하지 않습니다"


# ==============================================================================
# 7. 실행기
# ==============================================================================
@pytest.fixture()
def recorded(monkeypatch):
    rows: list[dict] = []
    monkeypatch.setattr(tasks.store, "start_run", lambda group_name=None: 1)
    monkeypatch.setattr(tasks.store, "record_task_run", lambda *args, **kwargs: rows.append(kwargs))
    return rows


def test_거부로_끝난_실행은_수집_결과_없음이_아니라_거부됨(local, recorded):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]

    ok, detail = tasks.run_task(tasks.Task("polite_probe", "slow", lambda: ladder.fetch(f"{local.server.base}/page"), ""))

    assert ok is False and recorded[-1]["status"] == "error"
    assert detail.startswith(f"거부됨: 출처가 요청을 거부 · 거부됨 — {HOST} HTTP 403(계층 impersonate) · ")
    assert "FetchRejected" not in detail


def test_위_계층에서_통과한_실행에는_거부됨이_붙지_않는다(local, recorded, monkeypatch):
    local.server.routes["/page"] = [(403, HTML, b"<html>Forbidden</html>")]
    _with_browser(monkeypatch, [_browser_page()])

    def task():
        return f"받음 — 계층 {ladder.fetch(f'{local.server.base}/page').tier}"

    ok, detail = tasks.run_task(tasks.Task("polite_probe", "slow", task, ""))

    assert ok is True and recorded[-1]["status"] == "ok"
    assert detail == "받음 — 계층 browser", "아래 계층의 거부는 실행 기록의 '거부됨'이 아닙니다(통과했음)"


# ==============================================================================
# 표 읽고 쓰기
# ==============================================================================
def test_예산은_한_문장으로_세고_올린다(store):
    day = datetime(2026, 11, 5).date()

    assert [store.take_fetch_budget("a.example", day, 3) for _ in range(5)] == [True, True, True, False, False]
    assert store.fetch_host("a.example")["budget_used"] == 3
    assert store.take_fetch_budget("a.example", day, 0) is False
    assert store.take_fetch_budget("a.example", day + timedelta(days=1), 3) is True
    assert store.fetch_host("a.example")["budget_used"] == 1


def test_상태_칸은_아는_이름만_쓴다(store):
    store.save_fetch_host("a.example", profile="chrome150", profile_lib="0.16.3")
    store.save_fetch_host("a.example", fail_level=2)

    row = store.fetch_host("a.example")
    assert (row["profile"], row["fail_level"], row["given_up"]) == ("chrome150", 2, False)
    with pytest.raises(ValueError, match="budget_used"):
        store.save_fetch_host("a.example", budget_used=0)


def test_다음_실행_시각을_적고_읽는다(store, clock):
    assert state.due_at("econ_calendar_probe") is None

    when = state.minutes_from_now(180, 360)
    state.set_due_at("econ_calendar_probe", when)

    assert timedelta(hours=3) <= when - clock["t"] <= timedelta(hours=6)
    assert state.due_at("econ_calendar_probe") == when
