"""
app/publicapi.py
국내 공공 API(공공데이터포털·Open DART) 호출의 공통 규칙.

한 곳에 모은 이유 — 이 API들은 **인증키를 쿼리 문자열로** 받습니다. 호출자마다
URL을 만들고 예외를 처리하면, 다음에 생기는 호출자가 반드시 무언가를 빠뜨립니다.

1. 키 형태 — 공공데이터포털은 키를 두 형태로 줍니다.
     Encoding 키  퍼센트 인코딩된 문자열 (``%2B`` 등이 들어 있음)
     Decoding 키  원문 (``+`` ``/`` ``=``가 들어 있을 수 있음)
   Encoding 키를 requests의 params=로 넘기면 ``%``가 ``%25``로 **한 번 더**
   인코딩되어 인증에 실패합니다. Decoding 키를 그대로 붙이면 ``+``가 공백으로
   해석됩니다. 그래서 어느 쪽을 받든 "원문으로 풀고 → 정확히 한 번 인코딩"해서
   직접 붙입니다(:func:`encoded_key`).

2. 키 유출 — requests 예외 메시지에는 요청 URL이 통째로 들어갑니다. 그 문자열이
   수집 실패 사유로 DB에 저장되고 상태 화면에 뜨면 키가 노출됩니다. 로그 필터
   (logredact)는 **로그**만 가리므로, 여기서 나가는 모든 오류 문구를 키의 모든
   형태(원문·인코딩·이중 인코딩)로 지운 뒤 내보냅니다(:func:`scrub`).

3. 재시도 — 401·403은 키 문제입니다. 다시 보내도 같은 답이 오고 일일 호출
   한도만 줄어듭니다. 429·5xx만 재시도합니다(공용 세션은 5xx만 다시 보내고 403·429는 거부 래치로 닫습니다 — http.py).

4. 오류 봉투 — 공공데이터포털은 인증 오류를 정상 응답과 **다른 봉투**
   (``OpenAPI_ServiceResponse``)로 줍니다. 관측된 실물(2026-08, 천문연 특일정보):
     등록되지 않은 키 → HTTP 403 + SERVICE_KEY_IS_NOT_REGISTERED_ERROR
     빈 키          → HTTP 401 + SERVICE_KEY_IS_NULL
   HTTP 상태만 보면 200으로 오는 오류를 놓치므로 봉투를 직접 검사합니다.

참고한 실물 코드: lunalism/holidays (sources/kr/kasi_client.py, kasi_parser.py),
PublicDataReader (PublicDataPortal/molit.py), kenshin579/opendart-go (httpclient).
"""
from __future__ import annotations

import logging
import threading
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote, urlencode

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from . import http

logger = logging.getLogger(__name__)

# 공공데이터포털의 "정상" 결과 코드. 서비스마다 자릿수가 다릅니다.
#   "00"  천문연 특일정보·금융위 주식시세
#   "000" 국토교통부 계열 서비스
DATA_GO_KR_OK = ("00", "000")

# 관측으로 확인한 인증 오류만 안내 문구를 붙입니다. 나머지는 원문 그대로 보여 줍니다.
_AUTH_HINTS = {
    "SERVICE_KEY_IS_NOT_REGISTERED_ERROR":
        "인증키가 등록되지 않았습니다 — 해당 API 활용신청 승인 여부와 키 값(.env)을 확인하세요",
    "SERVICE_KEY_IS_NULL":
        "인증키가 비어 있습니다 — .env의 DATA_GO_KR_SERVICE_KEY를 확인하세요",
}


class PublicApiError(RuntimeError):
    """
    공공 API 호출 실패.

    주의사항 — 메시지는 이미 키가 지워진 상태입니다. 그대로 로그·DB·화면에
    내보내도 됩니다. 이 클래스 밖에서 만든 문자열은 그렇지 않습니다.
    """


class MissingKey(PublicApiError):
    """인증키가 설정되지 않았습니다. 수집을 시도하지 않고 멈춥니다."""


class NotRegistered(PublicApiError):
    """
    이 키로 그 서비스의 활용신청이 없습니다 — 게이트웨이 봉투의 ``SERVICE_KEY_IS_NOT_REGISTERED_ERROR``(코드 30, HTTP 403).
    공공데이터포털은 키 하나에 서비스별 활용신청이라, 같은 키가 다른 서비스에는 200을 받으면서 이 서비스만 이렇게 옵니다
    ([확인] 2026-10-26 증권상품시세 — 주식시세는 200). 다른 날·쪽을 물어도 같은 답이라, 부르는 쪽이 바로 멈추고 '활용신청 필요'로
    남길 때만 따로 잡습니다(메시지는 PublicApiError와 같은 문구).
    """


class BudgetExhausted(PublicApiError):
    """
    이번 실행의 호출 예산(:class:`CallBudget`)을 다 써서 부르지 않았습니다 — 출처의 실패가 아닙니다.
    여러 쪽짜리 하루치를 받다 예산이 떨어지면 그날은 저장하지 않고 다음 실행이 그날부터 다시 받습니다.
    """


# ==============================================================================
# 키 형태
# ==============================================================================
def encoded_key(key: str) -> str:
    """
    어떤 형태로 받은 키든 "정확히 한 번 인코딩된" 형태로 맞춥니다.

    Encoding 키는 풀었다 다시 인코딩하면 원래대로 돌아오고, Decoding 키는 한 번
    인코딩됩니다. 그래서 두 형태가 같은 결과가 됩니다.

    :param key: .env에 적힌 키 (앞뒤 공백 허용)
    :returns: 쿼리 문자열에 그대로 붙일 값
    """
    return quote(unquote(key.strip()), safe="")


def key_forms(key: str) -> set[str]:
    """
    이 키가 문자열 안에 나타날 수 있는 모든 형태.

    이중 인코딩까지 포함해야 합니다. 라이브러리가 인코딩된 키를 한 번 더
    인코딩하면 ``%2B``가 ``%252B``가 되고, 그 형태가 예외 메시지에 실려 옵니다.
    """
    raw = key.strip()
    if not raw:
        return set()
    decoded = unquote(raw)
    once = quote(decoded, safe="")
    forms = {raw, decoded, once, quote(once, safe=""), quote(decoded)}
    return {form for form in forms if len(form) >= 6}


def scrub(text: str, *keys: str) -> str:
    """
    문자열에서 키를 어떤 형태로 들어 있든 지웁니다.

    긴 형태부터 지웁니다. 짧은 형태가 먼저 걸리면 긴 형태의 일부만 바뀌어
    나머지 조각이 남습니다.

    :param text: 로그·DB·화면으로 나갈 문자열
    :param keys: 지울 키들 (빈 값은 무시)
    :returns: 키가 ``***``로 바뀐 문자열
    """
    forms: set[str] = set()
    for key in keys:
        if key:
            forms |= key_forms(key)
    for form in sorted(forms, key=len, reverse=True):
        text = text.replace(form, "***")
    return text


# ==============================================================================
# HTTP
# ==============================================================================
_session_lock = threading.Lock()
_session: requests.Session | None = None


def _get_session() -> requests.Session:
    """
    공공 API 전용 세션.

    재시도는 429·5xx만 합니다. 401·403(키 문제)은 재시도해도 같은 답이 오고
    호출 한도만 줄어듭니다.
    """
    global _session
    with _session_lock:
        if _session is None:
            session = requests.Session()
            retry = Retry(
                total=2,
                backoff_factor=1.0,
                status_forcelist=(429, 500, 502, 503, 504),
                allowed_methods=("GET",),
                raise_on_status=False,
                retry_after_max=http.RETRY_AFTER_MAX_SECONDS,   # Retry-After 대기 상한(QA-080, http.py 참고)
            )
            adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
            session.mount("https://", adapter)
            session.mount("http://", adapter)
            session.headers.update({"User-Agent": http.BROWSER_HEADERS["User-Agent"]})
            _session = session
        return _session


def build_url(base: str, params: dict, *, key: str, key_param: str) -> str:
    """
    인증키를 직접 붙인 요청 URL.

    params=로 넘기지 않는 이유는 모듈 설명 1번을 보세요. 나머지 파라미터는
    일반적인 방식으로 인코딩합니다.

    :param base: 오퍼레이션까지 포함한 주소
    :param params: 키를 뺀 쿼리 파라미터
    :param key: 인증키(형태 무관)
    :param key_param: 키 파라미터 이름 (``serviceKey``, ``crtfc_key`` 등)
    """
    query = f"{key_param}={encoded_key(key)}"
    rest = urlencode({k: v for k, v in params.items() if v is not None})
    return f"{base}?{query}&{rest}" if rest else f"{base}?{query}"


def get(
    base: str,
    params: dict,
    *,
    key: str,
    key_param: str = "serviceKey",
    timeout: float = 20.0,
) -> requests.Response:
    """
    공공 API를 한 번 호출합니다.

    HTTP 상태로 판정하지 않고 응답을 그대로 돌려줍니다. 인증 오류(401·403)도
    본문에 사유가 담겨 오므로, 판정은 봉투를 읽는 쪽(:func:`parse_xml` 등)이 합니다.

    :raises MissingKey: 키가 비어 있을 때 (호출하지 않음)
    :raises PublicApiError: 연결 실패·시간 초과. 메시지에서 키는 지워져 있습니다
    """
    if not key or not key.strip():
        raise MissingKey("인증키가 설정되지 않았습니다")
    url = build_url(base, params, key=key, key_param=key_param)
    try:
        return _get_session().get(url, timeout=timeout)
    except requests.RequestException as exc:
        raise PublicApiError(scrub(http.brief_error(exc), key)) from None


# ==============================================================================
# 공공데이터포털 XML 봉투
# ==============================================================================
def parse_xml(response: requests.Response, *, key: str, ok_codes=DATA_GO_KR_OK) -> ET.Element:
    """
    공공데이터포털 XML 응답을 검사하고 루트를 돌려줍니다.

    두 가지 실패 형태를 갈라 봅니다.
      - 봉투가 ``OpenAPI_ServiceResponse`` — 인증·트래픽 오류 (게이트웨이가 답함)
      - ``header/resultCode``가 정상 코드가 아님 — 서비스 쪽 오류

    :param response: :func:`get`의 반환값
    :param key: 오류 문구에서 지울 키
    :param ok_codes: 정상으로 볼 resultCode
    :raises NotRegistered: 서비스 활용신청 없음(코드 30) — PublicApiError의 하위
    :raises PublicApiError: 정상 응답이 아닐 때 (키가 지워진 사유 포함)
    """
    text = response.text or ""
    try:
        root = ET.fromstring(text.strip())
    except ET.ParseError:
        head = scrub(" ".join(text.split())[:80], key)
        raise PublicApiError(
            f"HTTP {response.status_code} — XML이 아닌 응답: {head or '(빈 본문)'}"
        ) from None

    if root.tag == "OpenAPI_ServiceResponse":
        err = (root.findtext(".//errMsg") or "").strip()
        reason = (root.findtext(".//returnReasonCode") or "").strip()
        auth = (root.findtext(".//returnAuthMsg") or "").strip()
        hint = _AUTH_HINTS.get(auth) or _AUTH_HINTS.get(err) or ""
        detail = " / ".join(part for part in (err, auth, f"코드 {reason}" if reason else "") if part)
        error = NotRegistered if err == "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" or reason == "30" else PublicApiError
        raise error(scrub(
            f"HTTP {response.status_code} — {detail}" + (f" — {hint}" if hint else ""), key
        ))

    code = (root.findtext("header/resultCode") or "").strip()
    if code not in ok_codes:
        message = (root.findtext("header/resultMsg") or "").strip()
        raise PublicApiError(scrub(
            f"HTTP {response.status_code} — resultCode={code or '(없음)'} {message}".rstrip(), key
        ))
    return root


def xml_items(root: ET.Element) -> list[dict[str, str]]:
    """
    ``body/items/item``을 dict 목록으로 옮깁니다.

    항목이 하나뿐이어도, 없어도 같은 형태(목록)로 돌려줍니다. JSON 응답에서는
    한 건이면 dict, 없으면 빈 문자열로 오는 문제가 있는데 XML은 그 구분이 없습니다.
    """
    items = []
    for item in root.findall("body/items/item"):
        items.append({child.tag: (child.text or "").strip() for child in item})
    return items


def total_count(root: ET.Element) -> int | None:
    """``body/totalCount``. 없거나 숫자가 아니면 None."""
    raw = (root.findtext("body/totalCount") or "").strip()
    return int(raw) if raw.isdigit() else None


# ==============================================================================
# 호출 예산
# ==============================================================================
class CallBudget:
    """
    한 번의 수집에서 쓸 수 있는 호출 수.

    공공데이터포털 개발계정은 서비스별 일일 한도가 있습니다. 백필처럼 호출이
    많은 작업은 이 예산 안에서만 진행하고, 남은 것은 다음 주기로 넘깁니다.
    루프 버그 하나로 하루 한도를 다 태우는 사고를 막는 안전핀이기도 합니다.
    """

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0

    def take(self) -> bool:
        """호출 하나를 씁니다. 예산이 없으면 False (호출하지 말 것)."""
        if self.used >= self.limit:
            return False
        self.used += 1
        return True

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit
