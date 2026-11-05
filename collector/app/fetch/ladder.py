"""
app/fetch/ladder.py
계층 올라가기 — 닫힘 확인 → 지연 → 하루 예산 → 한 번 보냄 → 판정. 거부되면 한 번만 위 계층으로 (명세 §2).

판정
  - 정상: 2xx이고 기대한 모양 → 통과한 계층을 기억합니다(다음에는 그 계층부터 — 매번 아래 계층에서 한 번 거부당하고 올라가지 않게).
  - 거부: 403·429, 차단 서비스의 챌린지 머리글·차단 페이지 표지, JSON을 기대했는데 HTML → 위 계층이 있으면 지연 뒤 한 번 올라가고,
    없으면 물러납니다(:func:`app.fetch.state.note_rejected` — 연속으로 쌓이면 포기).
  - 사람 확인: 계층 2가 사람 입력을 요구받았다고 알려 줌 → 풀지 않고 길게 닫습니다.
  - 그 밖(404·5xx·시간 초과·전송 실패): 그 실행만 실패 — 출처의 거부가 아니라 물러나지 않습니다.

닫힘은 이 계층의 표에만 적습니다. 공용 세션의 호스트 래치(http.reject_host·http.check_host)는 부르지 않습니다 — 같은 호스트의 기존
수집(인베스팅닷컴 RSS)이 닫히지 않게(ADR 0026 결정 2). 실행 기록에는 :class:`FetchRejected`(http.SourceRejected의 하위)로 '거부됨'이 남습니다.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

import requests

from .. import http
from . import browser_client, impersonate, pacing, policy, state
from .reply import CHALLENGE_HUMAN, CHALLENGE_JS, Reply, TransportError

logger = logging.getLogger(__name__)

_OK, _BLOCKED, _HUMAN, _OTHER = "ok", "blocked", "human", "other"
_CHARSET = re.compile(r"charset=([\w-]+)", re.IGNORECASE)


class FetchRejected(http.SourceRejected):
    """
    출처가 거부해 닫혔거나, 닫혀 있는 동안의 요청(네트워크에 나가지 않음). 메시지는 화면에 뜨는 한 줄입니다(호스트·근거·언제까지).

    http.SourceRejected의 하위라 실행기(tasks/runner)와 사유 표지(REJECTED_MARK)가 그대로 '거부됨'으로 받습니다. 공용 세션의 5분 래치와는
    무관합니다 — 닫힘은 ``closed``(표 fetch_hosts)에 있습니다.
    """

    def __init__(self, closed: state.Closed) -> None:
        self.host = closed.host
        self.why = closed.reason
        self.closed = closed
        requests.exceptions.RequestException.__init__(self, f"{http.REJECTED_MARK} — {closed.message()}")


class FetchSkipped(Exception):
    """보내지 않음 — 오늘 그 호스트의 예산을 다 썼거나 태스크 시간 예산이 모자람. 실패가 아니라 다음 회차로 넘깁니다."""


class FetchFailed(Exception):
    """받지 못함 — 404·5xx·시간 초과·전송 실패. 출처의 거부가 아닙니다(물러나지 않음)."""


@dataclass(frozen=True)
class Fetched:
    """통과해 받은 답. ``tier``는 통과한 계층(저장본의 fetchTier)입니다."""

    url: str
    status: int
    content_type: str
    body: bytes
    tier: str
    final_url: str

    def text(self) -> str:
        match = _CHARSET.search(self.content_type)
        try:
            return self.body.decode(match.group(1) if match else "utf-8", errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        """:raises ValueError: JSON이 아님"""
        return json.loads(self.body)


def _send_impersonate(method: str, url: str, *, host: str, headers, params, data) -> Reply:
    return impersonate.send(method, url, profile=state.profile_for(host), headers=headers, params=params, data=data)


# 계층 → (보내는 함수, 지금 쓸 수 있는가). 계층 2는 브라우저 컨테이너의 주소와 공유 비밀이 설정된 곳(운영 서버)에서만 쓸 수 있습니다.
_SENDERS: dict[str, tuple[Callable[..., Reply], Callable[[], bool]]] = {
    policy.TIER_IMPERSONATE: (_send_impersonate, lambda: True),
    policy.TIER_BROWSER: (browser_client.send, browser_client.available),
}


def _usable_tiers(rules: policy.HostPolicy, host: str) -> list[str]:
    """지금 쓸 수 있는 계층을 낮은 것부터 — 지난번에 통과한 계층이 그 안에 있으면 거기부터."""
    usable = [tier for tier in rules.tiers if tier in _SENDERS and _SENDERS[tier][1]()]
    good = state.last_good_tier(host)
    if good in usable:
        usable = usable[usable.index(good):]
    return usable


def _looks_html(reply: Reply) -> bool:
    return "html" in reply.content_type or reply.body.lstrip()[:1] == b"<"


def judge(reply: Reply, expect: str) -> tuple[str, str | None]:
    """답 하나의 판정 → (판정, 근거 한 줄). 근거에는 주소·본문을 싣지 않습니다."""
    if reply.challenge == CHALLENGE_HUMAN:
        return _HUMAN, "사람 확인 요구"
    if reply.challenge == CHALLENGE_JS:
        return _BLOCKED, "JS 검사를 지나가지 못함"
    body = reply.body if (not reply.content_type or "html" in reply.content_type) else None
    sign = http.challenge_sign(reply.headers, body)
    if reply.status in http.REJECT_STATUSES:
        return _BLOCKED, f"HTTP {reply.status}" + (f"({sign})" if sign else "")
    if sign is not None:
        return _BLOCKED, f"차단 응답(HTTP {reply.status}, {sign})"
    if 200 <= reply.status < 300:
        if expect == policy.EXPECT_JSON and _looks_html(reply):
            return _BLOCKED, "JSON 대신 HTML 응답"
        return _OK, None
    return _OTHER, f"HTTP {reply.status}"


def fetch(
    url: str,
    *,
    expect: str = policy.EXPECT_HTML,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    data: Any = None,
) -> Fetched:
    """
    ``url``을 그 호스트의 정책대로 받습니다.

    :param expect: 기대하는 모양(``policy.EXPECT_HTML``·``EXPECT_JSON``) — JSON을 기대했는데 HTML이 오면 거부로 봅니다
    :param headers: 요청 문맥(Referer·Origin 등). 계층 2(브라우저)는 쓰지 않습니다
    :raises policy.UnknownHost: 정책 표에 없는 호스트
    :raises FetchRejected: 닫혀 있거나(보내지 않음) 이번에 거부당해 닫힘
    :raises FetchSkipped: 하루 예산·태스크 시간 예산이 모자라 보내지 않음
    :raises FetchFailed: 출처의 거부가 아닌 실패
    """
    host = http.host_of(url)
    rules = policy.policy_for(host)
    shut = state.closed(host)
    if shut is not None:
        raise FetchRejected(shut)

    blocked_why: str | None = None
    for attempt, tier in enumerate(_usable_tiers(rules, host)[:2]):       # 첫 계층 + 한 번 올라가기
        try:
            pacing.pace(host, rules.gap)
        except pacing.OutOfTime as exc:
            raise FetchSkipped(str(exc)) from exc
        if not state.take_budget(host, rules.daily_budget):
            raise FetchSkipped(f"{host} 오늘 요청 예산({rules.daily_budget}건)을 다 써서 보내지 않음")
        send = _SENDERS[tier][0]
        try:
            reply = send(method, url, host=host, headers=headers, params=params, data=data)
        except TransportError as exc:
            if attempt == 0:
                raise FetchFailed(f"{host} {exc}") from exc
            # 올라간 계층에 닿지 못함 — 아래 계층의 거부가 최종입니다(명세 §2).
            logger.warning("%s: 계층 %s로 올라가지 못함(%s) — 아래 계층의 거부로 닫습니다", host, tier, exc)
            break
        verdict, why = judge(reply, expect)
        if verdict == _OK:
            state.note_success(host, tier)
            if attempt:
                logger.info("%s: 계층 %s에서 통과(아래 계층은 %s)", host, tier, blocked_why)
            return Fetched(url=url, status=reply.status, content_type=reply.content_type, body=reply.body,
                           tier=tier, final_url=reply.final_url)
        if verdict == _OTHER:
            raise FetchFailed(f"{host} {why}")
        if verdict == _HUMAN:
            shut = state.note_human_check(host, f"{why}(계층 {tier})")
            logger.warning("출처가 사람 확인을 요구: %s", shut.message())
            raise FetchRejected(shut)
        blocked_why = f"{why}(계층 {tier})"

    if blocked_why is None:
        raise FetchFailed(f"{host}에 쓸 수 있는 계층이 없음")
    shut = state.note_rejected(host, blocked_why)
    logger.warning("출처 거부: %s", shut.message())
    raise FetchRejected(shut)


def reset() -> None:
    """프로세스 안의 기록(지연·세션)을 비웁니다(시험 사이의 격리용). 표의 값은 건드리지 않습니다."""
    pacing.reset()
    impersonate.reset()
    browser_client.reset()
