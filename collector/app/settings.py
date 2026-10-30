"""
수집기 설정과 외부 API 키 로더.

키는 **환경변수 + 선택적 TOML 파일** 두 경로에서 읽습니다.

**키가 없어도 수집기는 정상 기동해야 합니다.** 키가 필요한 소스만 건너뛰고,
무엇이 왜 빠졌는지 /status가 알려 줍니다. 어떤 키가 없으면 무엇이 안 되는지는
README의 "설정" 표에 있습니다.
"""
from __future__ import annotations

import logging
import os
import tomllib
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

# secrets.toml 경로. 없으면 환경변수만으로 동작합니다.
_SECRETS_PATH = Path(
    os.environ.get("MACRO_SECRETS_FILE", "/run/secrets/secrets.toml")
)


@lru_cache(maxsize=1)
def _load_secrets_file() -> dict:
    """secrets.toml을 한 번만 읽습니다. 없거나 깨졌으면 빈 dict."""
    if not _SECRETS_PATH.exists():
        return {}
    try:
        with _SECRETS_PATH.open("rb") as fp:
            return tomllib.load(fp)
    except Exception as exc:  # noqa: BLE001
        logger.warning("secrets 파일을 읽지 못했습니다 (%s): %s", _SECRETS_PATH, exc)
        return {}


def get_secret(key_path: str, default: str = "") -> str:
    """
    'fred.api_key' 같은 점 표기로 값을 찾습니다.

    탐색 순서
      1) 환경변수 FRED_API_KEY (점 → 밑줄, 대문자)
      2) 환경변수 key_path 그대로
      3) secrets.toml의 [fred] api_key

    컨테이너 환경에서는 환경변수가 1차 수단이라 TOML 파일보다 먼저 봅니다.

    :returns: 값의 앞뒤 공백을 제거한 문자열. 어디에도 없으면 빈 문자열
    """
    env_name = key_path.replace(".", "_").upper()
    for candidate in (env_name, key_path):
        value = os.environ.get(candidate)
        if value and value.strip():
            return value.strip()

    node: object = _load_secrets_file()
    for part in key_path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return default

    return str(node).strip() if node is not None else default


# ==============================================================================
# 데이터베이스 / 서비스 설정
# ==============================================================================
def database_url() -> str:
    """psycopg 연결 문자열."""
    return os.environ.get(
        "DATABASE_URL",
        "postgresql://macro:macro@localhost:5432/macrodash",
    )


def scheduler_enabled() -> bool:
    """
    상주 스케줄러 사용 여부.

    끄면 수집기는
    REST 요청(POST /collect)으로만 동작합니다.
    """
    return os.environ.get("COLLECTOR_SCHEDULER", "true").lower() in (
        "1", "true", "yes", "on",
    )


def interval_seconds(group: str) -> int:
    """작업군별 수집 주기 (기본 5분 / 1시간 / 12시간 / session 5분 — 🧪 계좌2 장중 확인 감시, compose가 환경변수를 넘기지 않아 이 값)."""
    defaults = {"fast": 5 * 60, "slow": 60 * 60, "weekly": 12 * 60 * 60, "session": 5 * 60}
    env_key = f"COLLECTOR_{group.upper()}_INTERVAL"
    try:
        return max(30, int(os.environ.get(env_key, defaults[group])))
    except (TypeError, ValueError):
        return defaults[group]


RUN_LOG_RETENTION_DAYS = 90


def run_log_retention_days() -> int:
    """
    수집 실행 기록 보존 기간(일). 기본 90일, 최소 7일.

    오류 모음 화면은 최근 24시간, 실행 이력 화면은 최근 200건까지만 봅니다. 잘못된 값이나
    너무 짧은 값으로 방금 기록까지 지우지 않도록 7일 밑으로는 내리지 않습니다.
    """
    try:
        return max(7, int(os.environ.get("COLLECTOR_RUN_LOG_RETENTION_DAYS", RUN_LOG_RETENTION_DAYS)))
    except (TypeError, ValueError):
        return RUN_LOG_RETENTION_DAYS


TRACK_RECORD_FETCH_BUDGET = 400


def track_record_fetch_budget() -> int:
    """
    13F 트랙레코드 수집(task_sec_13f_track_record)이 한 번 실행에서 새로 내려받는 공시 수 상한. 기본 400, 1~2000으로 자릅니다.

    후보 27곳 30분기는 약 810건(공시 하나 약 0.4초)이라 한 번에 다 받으면 weekly 시간 상한(30분)에 가깝고, 같은 SEC 한도를
    기존 sec_13f와 나눠 씁니다. 예산 안에서 최신 공시부터 채우고 나머지는 다음 실행이 이어 받습니다(설계 §4-0 ②).
    비었거나 숫자가 아니면 기본값 — 잘못 적은 값으로 수집을 멈추지(0) 않게 1 밑으로는 내리지 않습니다.
    """
    raw = (os.environ.get("TRACK_RECORD_FETCH_BUDGET") or "").strip()
    if not raw:
        return TRACK_RECORD_FETCH_BUDGET
    try:
        return min(2000, max(1, int(raw)))
    except ValueError:
        return TRACK_RECORD_FETCH_BUDGET


FUNDAMENTALS_FETCH_BUDGET = 200


def fundamentals_fetch_budget() -> int:
    """
    미국 종목 재무 수집(task_sec_fundamentals)이 한 번 실행에서 보내는 companyfacts 요청 수(= CIK 수) 상한. 기본 200, 1~600.

    200 × 0.37~0.6초(단계 0-b 측정) = 75~120초로 weekly 시간 상한(30분)의 13% 아래이고, 같은 SEC 토큰 버킷을 13F 두 태스크와
    나눠 씁니다. 유니버스 약 570곳은 세 번(약 36시간)에 한 바퀴 돕니다(명세 D28, 설계 §4-5 ②).
    비었거나 숫자가 아니면 기본값 — 잘못 적은 값으로 수집을 멈추지(0) 않게 1 밑으로는 내리지 않습니다.
    """
    raw = (os.environ.get("FUNDAMENTALS_FETCH_BUDGET") or "").strip()
    if not raw:
        return FUNDAMENTALS_FETCH_BUDGET
    try:
        return min(600, max(1, int(raw)))
    except ValueError:
        return FUNDAMENTALS_FETCH_BUDGET


US_CALENDAR_EARNINGS_BUDGET = 120


def us_calendar_earnings_budget() -> int:
    """
    미국 일정 수집(task_us_calendar)이 한 번 실행에서 yfinance에 묻는 실적 일정 종목 수 상한. 기본 120, 1~600.

    종목마다 24시간 캐시라 평소에는 한 시간에 약 24종목(유니버스 약 576종목 ÷ 24)만 다시 묻고, 처음 채울 때만 다섯 번(약 5시간)에
    나눠 받습니다. 120 × (응답 0.16~0.7초 + 간격 0.5초) ≈ 80~140초로 slow 시간 상한(600초) 안이고, 같은 Yahoo 한도를
    paper_quotes 등과 나눠 씁니다(명세 2단계 A2 — 계좌 보유는 백엔드 테이블이라 수집기는 유니버스 전체를 받음).
    비었거나 숫자가 아니면 기본값 — 잘못 적은 값으로 수집을 멈추지(0) 않게 1 밑으로는 내리지 않습니다.
    """
    raw = (os.environ.get("US_CALENDAR_EARNINGS_BUDGET") or "").strip()
    if not raw:
        return US_CALENDAR_EARNINGS_BUDGET
    try:
        return min(600, max(1, int(raw)))
    except ValueError:
        return US_CALENDAR_EARNINGS_BUDGET


EARNINGS_SURPRISE_BUDGET = 100


def earnings_surprise_budget() -> int:
    """
    어닝 서프라이즈 수집(task_earnings_surprise, 12시간마다)이 한 번 실행에서 yfinance에 묻는 종목 수 상한. 기본 100, 1~600.

    유니버스 약 576종목(ETF 제외)을 하루 두 번 × 100으로 약 3일에 한 바퀴 돌고, 실적을 막 발표한 종목은 순서의 앞에 둡니다
    (명세 C2 '1회 예산 100종목, 증분'). 100 × (응답 0.16~0.7초 + 간격 0.5초) ≈ 70~120초로 weekly 시간 상한(1,800초)에 한참 못
    미치고, 같은 Yahoo 한도를 us_calendar·paper_quotes와 나눠 씁니다.
    비었거나 숫자가 아니면 기본값 — 잘못 적은 값으로 수집을 멈추지(0) 않게 1 밑으로는 내리지 않습니다.
    """
    raw = (os.environ.get("EARNINGS_SURPRISE_BUDGET") or "").strip()
    if not raw:
        return EARNINGS_SURPRISE_BUDGET
    try:
        return min(600, max(1, int(raw)))
    except ValueError:
        return EARNINGS_SURPRISE_BUDGET


# ==============================================================================
# 외부 API 키 (없으면 빈 문자열)
# ==============================================================================
def fred_key() -> str:
    return get_secret("fred.api_key") or get_secret("FRED_API_KEY")


def krx_key() -> str:
    return (
        get_secret("krx.api_key")
        or get_secret("krx.auth_key")
        or get_secret("KRX_AUTH_KEY")
    )


def kis_credentials() -> tuple[str, str]:
    return get_secret("kis.app_key"), get_secret("kis.app_secret")


def ls_credentials() -> tuple[str, str]:
    return get_secret("ls.app_key"), get_secret("ls.app_secret")


def ls_base_url_override() -> str:
    return get_secret("ls.base_url")


def toss_credentials() -> tuple[str, str]:
    return get_secret("toss.client_id"), get_secret("toss.client_secret")


# ---- 국내 공공 API --------------------------------------------------------------
# 공공데이터포털(data.go.kr)은 계정 하나에 인증키 하나이고, 활용 신청한 서비스마다
# 같은 키를 씁니다. 그래서 특일정보·주식시세가 한 값을 공유합니다.
def data_go_kr_key() -> str:
    """
    공공데이터포털 일반 인증키.

    Encoding 키(``%``가 들어 있음)와 Decoding 키 어느 쪽을 넣어도 됩니다.
    보내기 직전에 ``publicapi.encoded_key``가 한 가지 형태로 맞춥니다.

    :returns: 키 문자열. 없으면 빈 문자열이고 해당 수집만 멈춥니다
    """
    # 환경변수 DATA_GO_KR_SERVICE_KEY 또는 secrets.toml [data_go_kr] service_key
    return get_secret("data_go_kr.service_key")


def dart_key() -> str:
    """금융감독원 Open DART 인증키(40자리). 없으면 빈 문자열."""
    # 환경변수 DART_API_KEY 또는 secrets.toml [dart] api_key
    return get_secret("dart.api_key")


def sec_user_agent() -> str:
    """
    SEC EDGAR가 요구하는 연락처 포함 User-Agent.

    SEC는 "Declare your user agent in request headers"를 의무로 두고, 연락처가
    없거나 예시 값이면 403을 돌려줍니다. 키가 아니라 **연락 가능한 이메일**입니다.

    ``sec.user_agent``(TOML)와 ``SEC_USER_AGENT``(환경변수) 둘 다 받습니다.

    :returns: User-Agent 문자열. 설정하지 않았으면 빈 문자열이고 13F 수집만 멈춥니다
    """
    return get_secret("sec.user_agent") or get_secret("SEC_USER_AGENT")


KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis"
FRED_API_BASE = "https://api.stlouisfed.org/fred"
FRED_CSV_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv"
KIS_BASE_URL = "https://openapi.koreainvestment.com:9443"

# LS OPEN API 주소.
# 문서에는 오랫동안 :8080이 적혀 있었지만 서버가 그 포트를 더 이상 열어두지
# 않습니다(즉시 connection refused). 표준 443을 먼저 쓰고 8080은 보조로만
# 남깁니다.
LS_BASE_URL = "https://openapi.ls-sec.co.kr"
LS_ALT_BASE_URLS = ("https://openapi.ls-sec.co.kr:8080",)
