"""
app/fetch/policy.py
호스트별 정책 표와 계층 공통 수치 (명세 §3·§4). 수치는 초기값입니다 — 서버에서 잰 뒤 고치면 명세의 표를 함께 고칩니다.
"""
from __future__ import annotations

from dataclasses import dataclass

TIER_IMPERSONATE = "impersonate"    # 계층 1 — 브라우저와 같은 TLS·헤더(curl_cffi)
TIER_BROWSER = "browser"            # 계층 2 — 요청마다 띄우는 실제 브라우저(브라우저 컨테이너)

EXPECT_HTML = "html"
EXPECT_JSON = "json"


@dataclass(frozen=True)
class Gap:
    """
    같은 호스트로 가는 요청 사이의 지연 분포(초). 로그정규(중앙값 ``median``)에서 뽑아 [``low``, ``high``]로 자르고, ``long_chance``의
    확률로는 대신 [``long_low``, ``long_high``]에서 고르게 뽑습니다(읽다가 멈춘 것 같은 긴 틈). 그 위에 1초 미만의 잡음을 얹습니다.
    """

    median: float = 7.0
    sigma: float = 0.45
    low: float = 4.0
    high: float = 15.0
    long_chance: float = 0.10
    long_low: float = 20.0
    long_high: float = 45.0


@dataclass(frozen=True)
class HostPolicy:
    """
    한 호스트를 받는 규칙.

    :param tiers: 쓸 수 있는 계층(낮은 것부터). 거부되면 다음 계층으로 한 번만 올라갑니다
    :param daily_budget: KST 하루에 그 호스트로 보내는 요청 수의 상한(계층을 가리지 않고 한 건씩)
    """

    host: str
    tiers: tuple[str, ...]
    daily_budget: int
    gap: Gap = Gap()


# 출처를 연결하는 커밋이 자기 호스트를 여기에 더합니다(명세 §6). 표에 없는 호스트는 이 계층으로 받지 않습니다.
POLICIES: dict[str, HostPolicy] = {
    policy.host: policy
    for policy in (
        # TradingView 경제 캘린더(services/tv_calendar) — JSON API라 계층 1에서 끝납니다. 3~6시간에 한 번 1건이라 하루 4~8건.
        HostPolicy("economic-calendar.tradingview.com", (TIER_IMPERSONATE,), daily_budget=12),
    )
}

# 거부 뒤 물러남(분) — 연속 거부 1회·2회·3회 이상. 구간 안에서 무작위로 고릅니다(정각에 다시 오지 않게).
BACKOFF_MINUTES: tuple[tuple[int, int], ...] = ((30, 60), (180, 360), (720, 1440))
# 사람 확인(CAPTCHA·체크박스)을 만났을 때 닫아 두는 구간(분). 풀지 않습니다(ADR 0026 결정 5).
HUMAN_CHECK_MINUTES: tuple[int, int] = (720, 1440)
# 연속 거부가 이만큼이면 그 출처를 포기합니다 — 운영자가 풀 때까지 다시 시도하지 않습니다(ADR 0026 결정 4).
GIVE_UP_LEVEL = 5


class UnknownHost(ValueError):
    """정책 표에 없는 호스트 — 이 계층으로 받지 않습니다."""


def policy_for(host: str) -> HostPolicy:
    """:raises UnknownHost: 표에 없는 호스트"""
    policy = POLICIES.get(host.lower())
    if policy is None:
        raise UnknownHost(f"차단 통과 계층의 정책 표에 없는 호스트입니다: {host}")
    return policy
