"""
tests/test_paper_switch_compose.py
모의 매매 정기 작업(PAPER_ENABLED)은 운영 서버 한 곳에서만 돕니다 (ADR 0019·0020·0023 — QA-341).

기반 compose(로컬)는 보간 없는 "false"라 로컬 `.env`·셸의 값이 끼어들 자리가 없고, 서버 덧붙임(compose.vultr.yml)과 QA 덧붙임만
`${PAPER_ENABLED:-true}`로 켭니다 — 차단 통과 수집 스위치(POLITE_FETCH_ENABLED, tests/test_polite_switch.py)와 같은 꼴입니다.
예전 기반 파일은 `${PAPER_ENABLED:-true}`였습니다: `.env.example`을 그대로 복사한 `.env`(빈 값)나 셸에 남은 true로 `make up`을 하면
로컬 백엔드가 리스크 점검·결정·체결을 돌리고 Claude 키가 있으면 유료 호출을 냈습니다.

docker 없이 YAML 원문만 읽습니다(해석된 값은 CI의 'compose 해석' 단계가 단언 — 아래 마지막 시험이 그 단언이 있는지 봅니다).
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "docker-compose.yml"
VULTR = ROOT / "compose.vultr.yml"
QA = ROOT / "scripts" / "qa" / "docker-compose.qa.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"


def _backend_env(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["services"]["backend"]["environment"]


def test_QA341_기반_compose는_보간_없이_끈다():
    assert _backend_env(BASE)["PAPER_ENABLED"] == "false"


@pytest.mark.parametrize("overlay", [VULTR, QA], ids=["vultr", "qa"])
def test_QA341_서버와_QA_덧붙임만_켠다(overlay):
    # 기반이 "false"인데 덧붙임 줄이 빠지면 서버의 정기 작업(리스크 점검·결정·체결)이 조용히 꺼집니다 — 그래서 한 커밋에서 함께 바꿉니다.
    assert _backend_env(overlay).get("PAPER_ENABLED") == "${PAPER_ENABLED:-true}"


def test_QA341_CI가_세_해석의_PAPER_ENABLED를_단언한다():
    text = CI.read_text(encoding="utf-8")
    probe = ".services.backend.environment.PAPER_ENABLED"

    assert f'{probe} == "true"\' "$RUNNER_TEMP/vultr.json"' in text, "서버: 값이 없으면 켜짐"
    assert "PAPER_ENABLED=false docker compose --env-file /dev/null -f docker-compose.yml -f compose.vultr.yml" in text, "서버: false면 꺼짐"
    assert "PAPER_ENABLED=true docker compose --env-file /dev/null -f docker-compose.yml config" in text, "로컬: 셸에 true가 있어도 꺼짐"
    assert f'{probe} == "false"\' "$RUNNER_TEMP/local.json"' in text, "로컬: 값이 없어도 꺼짐"
    assert f'{probe} == "true"\' "$RUNNER_TEMP/qa.json"' in text, "QA: 값이 없으면 켜짐"
