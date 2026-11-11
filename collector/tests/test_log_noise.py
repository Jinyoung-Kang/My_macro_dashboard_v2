"""
tests/test_log_noise.py
라이브러리가 만든 로그 잡음이 실제 오류를 덮지 않는지 고정합니다.

[실제로 겪은 일]
예전 의존성 pykrx(2026-11-11 제거)는 내부에서 이렇게 찍었습니다. 다른 라이브러리도 같은 실수를 할 수 있어 필터는 남깁니다.

    logging.info(args, kwargs)      # pykrx/website/comm/util.py

메시지 자리에 튜플, 인자 자리에 dict가 들어갑니다. 로깅이 출력 직전에
``str(msg) % args``를 하다 TypeError를 내고, 파이썬은 그 실패를 다시
"--- Logging error ---"와 전체 traceback으로 찍습니다.

수급 레이더는 데이터가 없으면 과거 날짜로 6번까지 되짚습니다. 조합 하나를
조회할 때마다 이 40줄짜리 덩어리가 여섯 번 반복돼, `make logs`로 진짜 원인을
찾는 것이 불가능했습니다. 라이브러리를 고칠 수는 없으니 출력 직전에 거릅니다.
"""
from __future__ import annotations

import logging

import pytest

from app import logredact


@pytest.fixture()
def captured(caplog):
    caplog.set_level(logging.DEBUG)
    caplog.handler.addFilter(logredact.SafeFormatFilter())
    caplog.handler.addFilter(logredact.RedactingFilter())
    return caplog


def test_형식이_깨진_로그가_traceback으로_번지지_않는다(captured):
    # 예전 pykrx가 하던 것과 같은 호출입니다.
    logging.getLogger("test.broken").warning(
        ("20260918", "20260918", "KOSPI", "외국인"), {}
    )

    # 예외 없이 지나가고, 무엇을 찍으려 했는지는 남아야 합니다.
    assert "20260918" in captured.text
    assert "KOSPI" in captured.text


def test_형식이_멀쩡한_로그는_건드리지_않는다(captured):
    logging.getLogger("test.fine").info("수집 완료: %s/%s", 3, 3)

    assert "수집 완료: 3/3" in captured.text


def test_형식이_깨져도_비밀값은_가려진다(captured):
    """
    SafeFormat이 먼저 돌아 메시지를 바꾸므로, 가리기가 그 뒤에 와야 합니다.
    순서가 뒤집히면 깨진 레코드가 가려지지 않은 채 새어 나갑니다.
    """
    logging.getLogger("test.broken").warning(
        ("https://example.com/x?api_key=deadbeefdeadbeefdeadbeef",), {}
    )

    assert "deadbeefdeadbeefdeadbeef" not in captured.text
    assert "***redacted***" in captured.text


def test_우리_코드의_INFO는_남긴다(captured):
    logging.getLogger("app.services.radar").info(
        "Daum 랭킹 빈 결과: market=KOSPI, investor=외국인"
    )

    assert "Daum 랭킹 빈 결과" in captured.text
