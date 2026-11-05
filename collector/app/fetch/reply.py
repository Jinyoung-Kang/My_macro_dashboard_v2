"""
app/fetch/reply.py
계층이 돌려주는 답의 공통 모양과, 출처의 거부가 아닌 전송 실패.
"""
from __future__ import annotations

from dataclasses import dataclass

# 계층 2(브라우저)가 알려 주는 검사 상태.
CHALLENGE_HUMAN = "human"     # 사람 입력(CAPTCHA 퍼즐·체크박스)을 요구받음 — 풀지도 누르지도 않고 그대로 돌려줌
CHALLENGE_JS = "js"           # 입력 없는 JS 검사가 시간 안에 끝나지 않음


class TransportError(Exception):
    """보내지 못했거나 답을 받지 못함(연결 실패·시간 초과·예산 부족·계층 2에 닿지 못함) — 출처의 거부가 아닙니다."""


@dataclass(frozen=True)
class Reply:
    """
    계층 하나가 한 번 보내고 받은 답(계층 1·2 공통 모양).

    :param headers: 이름을 소문자로 바꾼 응답 머리글
    :param challenge: 계층 2만 채웁니다 — ``CHALLENGE_HUMAN``·``CHALLENGE_JS``, 검사를 만나지 않았으면 None
    """

    status: int
    headers: dict[str, str]
    body: bytes
    final_url: str
    challenge: str | None = None

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type") or "").lower()
