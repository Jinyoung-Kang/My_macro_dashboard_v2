"""
tests/test_log_redaction.py
로그에 비밀값이 새어 나가지 않는지 고정합니다.

실제로 새어 나갔습니다. FRED 호출이 느려 urllib3가 재시도 경고를 찍었는데
그 경고에 요청 URL 전체가 들어 있었습니다.

    WARNING urllib3.connectionpool: Retrying (...) after connection broken by
    'ReadTimeoutError(...)': /fred/series/observations?series_id=WALCL
    &api_key=deadbeefdeadbeefdeadbeefdeadbeef&file_type=json&...

URL을 찍는 쪽이 서드파티 라이브러리라 우리 코드만 조심해서는 막을 수
없습니다. 로깅 계층에서 한 번에 걸러야 합니다.
"""
from __future__ import annotations

import logging

import pytest

from app import logredact


@pytest.fixture()
def captured(caplog):
    """필터를 단 핸들러로 로그를 잡습니다."""
    caplog.set_level(logging.INFO)
    for handler in caplog.handler, logging.getLogger().handlers[0] if logging.getLogger().handlers else caplog.handler:
        handler.addFilter(logredact.RedactingFilter())
    return caplog


def test_URL의_api_key가_가려진다(captured):
    logging.getLogger("urllib3.connectionpool").warning(
        "Retrying after connection broken: %s",
        "/fred/series/observations?series_id=WALCL"
        "&api_key=deadbeefdeadbeefdeadbeefdeadbeef&file_type=json",
    )

    text = captured.text
    assert "deadbeefdeadbeefdeadbeefdeadbeef" not in text
    assert "***redacted***" in text
    # 진단에 필요한 부분은 남아야 합니다.
    assert "series_id=WALCL" in text


def test_여러_형태의_비밀_파라미터를_가린다():
    samples = {
        "?api_key=SECRET1": "SECRET1",
        "?auth_key=SECRET2&basDd=20260916": "SECRET2",
        "?appkey=SECRET3": "SECRET3",
        "?app_secret=SECRET4": "SECRET4",
        "?access_token=SECRET5": "SECRET5",
        "?password=SECRET6": "SECRET6",
        # 토스 토큰 발급 본문. '_' 뒤의 secret은 단어 경계가 아니라 예전에는 그대로 남았습니다.
        "grant_type=client_credentials&client_id=cid&client_secret=SECRET7": "SECRET7",
    }
    for text, secret in samples.items():
        assert secret not in logredact.redact(text), text


def test_Bearer_토큰도_가린다():
    out = logredact.redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc")
    assert "eyJhbGciOiJIUzI1NiJ9" not in out
    assert "Bearer ***redacted***" in out


def test_비밀이_아닌_값은_건드리지_않는다():
    text = "series_id=WALCL&file_type=json&observation_start=2016-06-21"
    assert logredact.redact(text) == text


def test_로그_인자에_담겨_와도_가려진다(captured):
    """urllib3는 URL을 %s 인자로 넘깁니다. 메시지만 보면 놓칩니다."""
    logging.getLogger("t").info("요청: %s", "https://x/api?api_key=TOPSECRET")

    assert "TOPSECRET" not in captured.text


def test_대소문자를_가리지_않는다():
    assert "SECRET" not in logredact.redact("?API_KEY=SECRET")
    assert "SECRET" not in logredact.redact("?Api_Key=SECRET")


def test_국내_공공_API_키_파라미터도_가린다():
    """공공데이터포털·DART·KOSIS·V-World·R-ONE·SGIS의 키 이름."""
    samples = {
        "https://apis.data.go.kr/x/getRestDeInfo?serviceKey=AbC%2B12%3D%3D&solYear=2026": "AbC%2B12%3D%3D",
        "?ServiceKey=DATAGOKR": "DATAGOKR",
        "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=DARTKEY&corp_code=00126380": "DARTKEY",
        "?method=getList&apiKey=KOSISKEY&format=json": "KOSISKEY",
        "https://api.vworld.kr/req/data?key=VWORLDKEY&request=GetFeature": "VWORLDKEY",
        "SttsApiTblData.do?KEY=REBKEY&Type=json": "REBKEY",
        "?consumer_key=SGISID&consumer_secret=SGISSECRET": "SGISSECRET",
        "?accessToken=SGISTOKEN&year=2024": "SGISTOKEN",
    }
    for text, secret in samples.items():
        assert secret not in logredact.redact(text), text
    # 진단에 필요한 다른 파라미터는 남습니다.
    assert "corp_code=00126380" in logredact.redact(
        "?crtfc_key=DARTKEY&corp_code=00126380")


def test_key로_끝나는_일반_파라미터는_가리지_않는다():
    """'key'를 추가했다고 sort_key 같은 평범한 값까지 지우면 진단이 어려워집니다."""
    text = "?sort_key=date&monkey=1"
    assert logredact.redact(text) == text


class _UrlError(Exception):
    """requests.ConnectionError처럼 메시지에 요청 URL을 담는 예외."""


def test_QA018_예외_객체_인자에_담긴_키도_가린다(captured):
    """FRED 실패 경로: ``logger.warning("FRED API 실패 (%s): %s", series_id, exc)`` — exc는 문자열이 아닙니다."""
    exc = _UrlError(
        "Max retries exceeded with url: /fred/series/observations"
        "?series_id=WALCL&api_key=QA018SECRETKEY&file_type=json"
    )
    logging.getLogger("app.services.fred").warning("FRED API 실패 (%s): %s", "WALCL", exc)

    assert "QA018SECRETKEY" not in captured.text
    assert "series_id=WALCL" in captured.text


def test_QA018_traceback에_담긴_키도_가린다(captured):
    try:
        raise _UrlError("GET https://api.example/x?api_key=QA018TRACEBACKKEY")
    except _UrlError:
        logging.getLogger("t").exception("수집 실패")

    assert "QA018TRACEBACKKEY" not in captured.text
    assert "_UrlError" in captured.text


def test_BLS_registrationkey도_가린다():
    """BLS Public Data API(ADR 0040)의 키 이름 — 'key' 앞에 낱말 경계가 없어 key 규칙으로는 걸리지 않습니다."""
    text = "https://api.bls.gov/publicAPI/v2/timeseries/data/?registrationkey=BLSKEY123&catalog=true"
    assert "BLSKEY123" not in logredact.redact(text)
    assert "catalog=true" in logredact.redact(text)
