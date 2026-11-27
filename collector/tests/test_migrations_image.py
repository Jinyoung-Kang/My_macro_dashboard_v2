"""
tests/test_migrations_image.py
QA-1036: 옛 수집기 이미지가 새 마이그레이션을 적용하던 결함.

수집기 이미지에는 마이그레이션이 없고 compose가 호스트의 `db/migrations`를 읽기 전용으로 마운트했습니다. 수집기는 기동할 때 그 폴더에서
기록에 없는 번호를 적용하므로, 코드를 받은 뒤 새 컨테이너가 뜨기 전에 **옛 컨테이너가 다시 뜨면**(빌드 실패·가드에서 멈춤·덤프 실패·재부팅·
메모리 상한 뒤 자동 재시작, 정상 배포의 빌드 몇 분) 옛 코드가 새 스키마를 적용했습니다. QA-1015는 실제 매매 창 안에서 받기 전에 멈추게만
했습니다.

고침: 폴더를 이미지에 넣고(compose `build.additional_contexts`의 이름 붙은 컨텍스트 → Dockerfile `COPY --from=migrations`) 마운트를
없앱니다 — 이미지가 아는 파일이 곧 적용하는 파일입니다. DB의 기록이 이미지보다 앞서 있으면(되돌림 배포) 경고만 남기고 기동은 계속합니다
(멈추면 자동 재시작과 겹쳐 재기동 반복이 되고 수집과 실제 매매 주문 길이 함께 섭니다 — 계획 D-11).
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path

import yaml

from app import migrations

ROOT = Path(__file__).resolve().parents[2]
REPO_MIGRATIONS = ROOT / "db" / "migrations"
# 수집기 서비스를 고칠 수 있는 compose 파일 전부(기반 + 덧붙임)
COMPOSE_FILES = [
    "docker-compose.yml",
    "compose.vultr.yml",
    "scripts/qa/docker-compose.qa.yml",
    "scripts/qa/docker-compose.qa-nologin.yml",
]
IMAGE_DIR = "/app/db/migrations"


def _collector(compose_file: str) -> dict:
    document = yaml.safe_load((ROOT / compose_file).read_text(encoding="utf-8"))
    return (document.get("services") or {}).get("collector") or {}


def _volume_text(volume) -> str:
    if isinstance(volume, dict):
        return f"{volume.get('source', '')}:{volume.get('target', '')}"
    return str(volume)


def test_QA1036_수집기_서비스는_호스트의_마이그레이션_폴더를_마운트하지_않는다():
    for compose_file in COMPOSE_FILES:
        volumes = [_volume_text(v) for v in _collector(compose_file).get("volumes") or []]
        mounted = [v for v in volumes if "db/migrations" in v]
        assert not mounted, f"{compose_file}: 수집기가 호스트의 db/migrations를 봅니다 — 옛 컨테이너가 새 파일을 적용합니다: {mounted}"


def test_QA1036_수집기_이미지는_이름_붙은_컨텍스트에서_마이그레이션을_복사한다():
    build = _collector("docker-compose.yml").get("build")
    assert isinstance(build, dict), "build는 컨텍스트와 additional_contexts를 적은 긴 꼴이어야 합니다"
    assert build.get("context") == "./collector"
    assert build.get("additional_contexts") == {"migrations": "./db/migrations"}
    # 덧붙임이 build를 덮어 컨텍스트를 빼면 그 스택의 이미지에는 폴더가 없습니다
    for overlay in COMPOSE_FILES[1:]:
        assert "build" not in _collector(overlay), f"{overlay}: 수집기 build를 덮지 않습니다"

    dockerfile = (ROOT / "collector/Dockerfile").read_text(encoding="utf-8")
    copies = re.findall(r"^COPY\s+--from=migrations\s+(\S+)\s+(\S+)\s*$", dockerfile, re.M)
    assert copies == [(".", f"{IMAGE_DIR}/")] or copies == [(".", IMAGE_DIR)], copies
    # 복사한 파일은 호스트의 권한을 따라옵니다 — 비root(USER app)가 읽을 수 있게 연 뒤에 사용자를 바꿉니다
    chmod = re.search(r"^RUN chmod -R a\+rX .*/app/db\b.*$", dockerfile, re.M)
    assert chmod, "복사한 마이그레이션을 누구나 읽게 엽니다(쓰기 권한은 주지 않음)"
    assert dockerfile.index("COPY --from=migrations") < chmod.start() < dockerfile.index("\nUSER app")
    # 적용기가 보는 곳은 그 폴더 하나입니다
    assert _collector("docker-compose.yml")["environment"]["MACRO_MIGRATIONS_DIR"] == IMAGE_DIR


def test_QA1036_CI_이미지_잡은_빌드한_수집기_이미지_안의_스키마_파일을_저장소와_대조한다():
    """이미지에 폴더가 빠지거나 일부만 들어가면 수집기는 경고 한 줄만 남기고 스키마 없이 뜹니다 — 빌드한 이미지로 확인합니다."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"))
    runs = [s.get("run") or "" for s in workflow["jobs"]["images"]["steps"]]
    build_at = next(i for i, run in enumerate(runs) if run.strip() == "docker compose build")
    checks = [i for i, run in enumerate(runs) if IMAGE_DIR in run]
    assert checks == [build_at + 1], "이미지 빌드 바로 다음 단계에서 한 번 봅니다"
    script = runs[checks[0]]
    assert "config --images collector" in script, "compose가 만든 이미지 이름을 물어 그 이미지로"
    run = script[script.index("docker run"):].splitlines()[0]
    assert "--rm" in run and "--network none" in run and "--entrypoint sh" in run and '"$collector_image"' in run
    assert "cd db/migrations && sha256sum" in script and f"cd {IMAGE_DIR} && sha256sum" in script, "개수만이 아니라 이름·내용까지"
    assert 'diff "$RUNNER_TEMP/migrations.repo" "$RUNNER_TEMP/migrations.image"' in script
    assert 'test -s "$RUNNER_TEMP/migrations.repo"' in script, "빈 목록끼리 같은 것은 통과가 아닙니다"


def test_QA1036_DB의_기록이_이미지보다_앞서_있으면_경고하고_기동을_이어_간다(store, tmp_path, caplog):
    """되돌림 배포 — 새 판이 적용한 번호를 옛 이미지는 모릅니다. 멈추지 않고 알리기만 합니다."""
    known = migrations.discover(REPO_MIGRATIONS)
    older = known[:-1]
    for migration in older:
        source = next(REPO_MIGRATIONS.glob(f"V{migration.version}__*.sql"))
        (tmp_path / source.name).write_text(source.read_text(encoding="utf-8"), encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="app.store"):
        store.init_schema(str(tmp_path))

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any(f"V{known[-1].version}" in m and f"V{older[-1].version}" in m and "앞서" in m for m in warnings), warnings
    assert store.schema_versions() == {
        "imageMax": older[-1].version, "databaseMax": known[-1].version, "databaseAhead": True,
    }
    # 읽기만 합니다 — 기록을 지우거나 고치지 않습니다
    with store.connection() as conn:
        versions = [r["version"] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY 1")]
    assert versions == [m.version for m in known]


def test_QA1036_이미지와_DB가_같으면_경고하지_않는다(store, caplog):
    with caplog.at_level(logging.WARNING, logger="app.store"):
        store.init_schema(str(REPO_MIGRATIONS))
    assert not [r for r in caplog.records if "앞서" in r.getMessage()]
    top = migrations.discover(REPO_MIGRATIONS)[-1].version
    assert store.schema_versions() == {"imageMax": top, "databaseMax": top, "databaseAhead": False}


def test_QA1036_상태_응답의_전체_보기는_스키마_번호를_싣고_가벼운_보기는_그대로다(store):
    from app import main

    top = migrations.discover(REPO_MIGRATIONS)[-1].version
    full = main.status()
    assert full["schema"] == {"imageMax": top, "databaseMax": top, "databaseAhead": False}
    assert list(main.status(view="light")) == ["lastRun", "lastRunStatus", "missingDatasets"]


def test_QA1036_기록_표가_없으면_DB_번호는_없음이다(store):
    """스키마를 적용하지 않고 뜬 수집기(COLLECTOR_INIT_SCHEMA=false·폴더 없음) — 0이나 지어낸 값이 아니라 null."""
    with store.connection() as conn:
        conn.execute("ALTER TABLE schema_migrations RENAME TO schema_migrations_gone")
    versions = store.schema_versions()
    assert versions["databaseMax"] is None and versions["databaseAhead"] is False


def test_QA1036_한_줄_요약은_두_번호를_보이고_DB가_앞서면_경고로_시작한다(store, monkeypatch):
    top = migrations.discover(REPO_MIGRATIONS)[-1].version
    assert store.schema_line() == f"스키마: 이미지 V{top} · DB V{top}"
    monkeypatch.setattr(store, "schema_versions", lambda: {"imageMax": 3, "databaseMax": 5, "databaseAhead": True})
    line = store.schema_line()
    assert line.startswith("경고: 스키마") and "이미지 V3" in line and "DB V5" in line
    monkeypatch.setattr(store, "schema_versions", lambda: {"imageMax": None, "databaseMax": None, "databaseAhead": False})
    assert store.schema_line() == "스키마: 이미지 — · DB —"


_FAKE_CURL = """#!/usr/bin/env bash
case "$*" in
    */status) cat "$FAKE_STATUS_JSON"; exit 0 ;;
esac
exit 7
"""


def _doctor(tmp_path, schema) -> str:
    """scripts/doctor.sh를 가짜 curl(수집기 /status만 답함)·가짜 docker로 돌린 출력."""
    fakes = tmp_path / "bin"
    fakes.mkdir()
    for name, body in (("curl", _FAKE_CURL), ("docker", "#!/usr/bin/env bash\nexit 1\n")):
        (fakes / name).write_text(body, encoding="utf-8")
        (fakes / name).chmod(0o755)
    status = {"lastRunStatus": "ok", "taskSummary": [], "missingDatasets": []}
    if schema is not None:
        status["schema"] = schema
    (tmp_path / "status.json").write_text(json.dumps(status), encoding="utf-8")
    env = {**os.environ, "PATH": f"{fakes}:{os.environ['PATH']}", "FAKE_STATUS_JSON": str(tmp_path / "status.json")}
    done = subprocess.run(["bash", str(ROOT / "scripts/doctor.sh")], env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)
    return done.stdout


def test_QA1036_doctor는_스키마_번호_한_줄을_보이고_DB가_앞서면_경고한다(tmp_path):
    def lines(schema, name):
        folder = tmp_path / name
        folder.mkdir()
        return [line.strip() for line in _doctor(folder, schema).splitlines() if "스키마:" in line]

    assert lines({"imageMax": 45, "databaseMax": 45, "databaseAhead": False}, "same") == ["스키마: 이미지 V45 · DB V45"]
    ahead = lines({"imageMax": 44, "databaseMax": 45, "databaseAhead": True}, "ahead")
    assert len(ahead) == 1 and ahead[0].startswith("스키마: 이미지 V44 · DB V45 — 경고: DB가 이미지보다 앞서")
    behind = lines({"imageMax": 45, "databaseMax": None, "databaseAhead": False}, "behind")
    assert behind == ["스키마: 이미지 V45 · DB — — 적용 대기(make migrate)"]
    assert lines(None, "old") == [], "옛 수집기(칸 없음)면 줄을 내지 않습니다"
