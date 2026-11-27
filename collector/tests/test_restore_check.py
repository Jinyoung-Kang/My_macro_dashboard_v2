"""
tests/test_restore_check.py
백업 복원 자동 확인(scripts/vultr/restore-check.sh — ADR 0023 덧붙임 2026-11-27, docs/improve/2026-11-27-quality-plan.md §3)의 시험.

실제 서버·AWS·텔레그램·Docker에는 닿지 않습니다 — docker·aws·curl·logger·df·sleep은 PATH 앞의 가짜 실행 파일입니다(tests/fake_server_tools.py의
것에 이 시험의 docker·aws를 덮어씀). 가짜 docker는 일회용 컨테이너의 psql이 내는 '<이름>=<값>' 줄을 FAKE_FACTS·FAKE_REAL_FACTS로 흉내 냅니다.
판정 질의 자체는 맨 아래 시험이 진짜 PostgreSQL로 봅니다(psql 클라이언트가 없으면 건너뜀 — CI에는 있음).
"""
from __future__ import annotations

import fcntl
import os
import shutil
import stat
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pytest

from tests import fake_server_tools as tools

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/vultr/restore-check.sh"
SECRET = tools.SECRET
TG_TOKEN = "123456789:telegram-token-must-not-be-in-argv"
TG_CHAT = "-100777000111"
CTR = "my-macro-restore-check"
KEY = "db/vultr/macrodash-20261127-230000.sql"
ROW_LEAK = "COPY real_trade_orders, line 3: 005930 71000 row-value-must-not-leak"
REAL_MAKE = shutil.which("make")
_REAL_DATE = shutil.which("date") or "/usr/bin/date"

MAIN_TABLES = ["snapshots", "timeseries", "observations", "users", "paper_orders", "paper_fills", "paper_decisions", "paper_nav_daily"]
REAL_TABLES = ["real_trade_config", "real_trade_batches", "real_trade_orders", "real_trade_events", "real_trade_valuation",
               "manual_accounts", "manual_sessions", "manual_instructions", "manual_stop_instructions", "manual_trades",
               "manual_positions", "manual_balance", "manual_ledger"]

# 부른 인자를 기록 파일에 남깁니다. 운영 postgres 컨테이너는 'prodctr'(FAKE_NO_PROD면 없음), 그 이미지는 'sha256:prodimage'.
# 일회용 컨테이너의 psql은 -At가 있으면 판정 질의(실제 계좌 표를 세는 호출이면 FAKE_REAL_FACTS, 아니면 FAKE_FACTS — FAKE_QUERY_RC),
# 없으면 적재입니다 — 받은 입력의 바이트 수와 끝 300바이트를 <기록>.load에 남기고 FAKE_LOAD_RC로 끝납니다(실패하면 행 값이 섞인 오류 글을 stderr에).
_DOCKER = """#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
case " $* " in
    *" compose ps -q postgres "*) [ -n "${FAKE_NO_PROD:-}" ] || echo prodctr; exit 0 ;;
    *" inspect "*"{{.Image}}"*) echo "sha256:prodimage"; exit 0 ;;
    *" inspect "*"{{.State.OOMKilled}}"*) echo "${FAKE_OOM:-false}"; exit 0 ;;
    *" run "*) exit "${FAKE_RUN_RC:-0}" ;;
    *" pg_isready "*) exit "${FAKE_READY_RC:-0}" ;;
    *" psql "*" -At "*)
        cat > /dev/null
        [ "${FAKE_QUERY_RC:-0}" = 0 ] || { echo "ERROR: fake query failure" >&2; exit "$FAKE_QUERY_RC"; }
        case "$*" in *"counted=real_trade_config"*) printf '%s\\n' "$FAKE_REAL_FACTS" ;; *) printf '%s\\n' "$FAKE_FACTS" ;; esac
        exit 0 ;;
    *" psql "*)
        cat > "$FAKE_LOG.load.all"
        { wc -c < "$FAKE_LOG.load.all" | tr -d ' '; tail -c 300 "$FAKE_LOG.load.all"; } > "$FAKE_LOG.load"
        rm -f "$FAKE_LOG.load.all"
        [ "${FAKE_LOAD_RC:-0}" = 0 ] || { echo "ERROR: __ROW_LEAK__" >&2; exit "$FAKE_LOAD_RC"; }
        exit 0 ;;
esac
exit 0
""".replace("__ROW_LEAK__", ROW_LEAK)
# s3 cp <원본> <자리> — FAKE_S3_SRC를 그 자리에 복사합니다(FAKE_AWS_RC가 0이 아니면 버킷 이름이 든 오류 글과 함께 실패).
_AWS = """#!/usr/bin/env bash
echo "aws $*" >> "$FAKE_LOG"
[ "${FAKE_AWS_RC:-0}" = 0 ] || { echo "fatal error: An error occurred (404) when calling s3://$FAKE_BUCKET_ECHO" >&2; exit "$FAKE_AWS_RC"; }
cp "$FAKE_S3_SRC" "${@: -1}"
"""
_DATE = ('#!/usr/bin/env bash\n'
         'if [ "$1" = "+%u %H%M" ]; then [ "${TZ:-}" = Asia/Seoul ] || { echo "TZ=${TZ:-}" >&2; exit 1; }; echo "$FAKE_KST_NOW"; '
         f'else exec {_REAL_DATE} "$@"; fi\n')


@pytest.fixture()
def fakes(tmp_path):
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    for name, text in {"docker": _DOCKER, "aws": _AWS, "make": tools._FAKE_MAKE, "logger": tools._FAKE_LOGGER, "sleep": tools._FAKE_SLEEP,
                       "curl": tools._FAKE_CURL, "df": tools._FAKE_DF, "canonical-livepatch": tools._FAKE_LIVEPATCH,
                       "sudo": tools._FAKE_SUDO}.items():
        tools._write_exec(bin_dir / name, text)
    log.touch()
    return bin_dir, log


@pytest.fixture()
def root(tmp_path):
    """서버 역할의 저장소 최상위 — restore-check.sh·notify-common.sh·db-common.sh, 서버 .env(운영 봇 + 버킷), 방금 올린 백업의 기록."""
    here = tmp_path / "My_macro_dashboard_v2"
    (here / "scripts/vultr").mkdir(parents=True)
    for name in ("restore-check.sh", "notify-common.sh"):
        shutil.copy(ROOT / "scripts/vultr" / name, here / "scripts/vultr" / name)
    shutil.copy(ROOT / "scripts/db-common.sh", here / "scripts/db-common.sh")
    (here / ".env").write_text(f"COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=test-bucket-name\n"
                               f"TELEGRAM_BOT_TOKEN={TG_TOKEN}\nTELEGRAM_CHAT_ID={TG_CHAT}\nDATABASE_PASSWORD={SECRET}\n", encoding="utf-8")
    (here / "backups").mkdir()
    _write_last_s3(here, age_seconds=5400)
    return here


def _write_last_s3(here: Path, *, age_seconds: int, key: str = KEY) -> int:
    then = int(time.time()) - age_seconds
    (here / "backups/.last-s3-ok").write_text(f"{then} 2026-11-27T23:00:10Z {key}\n", encoding="utf-8")
    return then


def _dump_epoch(here: Path) -> int:
    try:
        return int((here / "backups/.last-s3-ok").read_text(encoding="utf-8").split()[0])
    except (OSError, IndexError, ValueError):   # 기록이 없거나 모양이 다른 경우를 보는 시험
        return int(time.time())


def _facts(here: Path, **over: str | None) -> str:
    """정상인 판정 질의 출력. over로 한 줄을 바꾸거나(None이면 뺌) 더합니다 — 이름의 '__'는 '.'."""
    lines = {"marker": "1", "tables": "75", "missing": "", "schema": "45", "fresh": str(_dump_epoch(here) - 600)}
    lines.update({f"rows.{t}": str(100 + i) for i, t in enumerate(MAIN_TABLES)})
    for name, value in over.items():
        name = name.replace("__", ".")
        if value is None:
            lines.pop(name, None)
        else:
            lines[name] = value
    return "\n".join(f"{k}={v}" for k, v in lines.items())


def _real_facts(skip: tuple[str, ...] = ()) -> str:
    lines = ["marker=1", "tables=75", "missing=", "schema=45", "fresh=1"]
    lines += [f"rows.{t}={7131 + i}" for i, t in enumerate(REAL_TABLES) if t not in skip]
    return "\n".join(lines)


def _dump_file(tmp_path: Path, *, complete: bool = True) -> Path:
    path = tmp_path / ("s3-object.sql" if complete else "s3-object-cut.sql")
    path.write_text("COPY public.t (a) FROM stdin;\n1\n\\.\n" + ("--\n-- PostgreSQL database dump complete\n--\n" if complete else ""),
                    encoding="utf-8")
    return path


def _check(here: Path, fakes, tmp_path: Path, *args: str, **extra: str) -> subprocess.CompletedProcess:
    meminfo = tmp_path / "meminfo"
    if not meminfo.exists():
        meminfo.write_text("MemTotal:        4000000 kB\nMemAvailable:    2097152 kB\n", encoding="utf-8")
    env = {"RESTORE_CHECK_ANYTIME": "1", "RESTORE_CHECK_MEMINFO": str(meminfo), "FAKE_BUCKET_ECHO": "test-bucket-name",
           "FAKE_S3_SRC": str(_dump_file(tmp_path)), "FAKE_FACTS": _facts(here), "FAKE_REAL_FACTS": _real_facts()}
    env.update(extra)
    return subprocess.run(["bash", str(here / "scripts/vultr/restore-check.sh"), *args], cwd=here, env=tools._env(fakes, **env),
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)


def _calls(fakes, prefix: str) -> list[str]:
    return [c for c in tools._calls(fakes) if c.startswith(prefix)]


def _logs(fakes) -> list[str]:
    return _calls(fakes, "logger -t my-macro-restore-check")


def _record(here: Path) -> Path:
    return here / "backups/.last-restore-ok"


def _seen(result: subprocess.CompletedProcess, fakes) -> str:
    """사람·알림·syslog에 닿는 글 전부(출력 + 가짜 명령이 받은 인자)."""
    return result.stdout + result.stderr + fakes[1].read_text(encoding="utf-8")


# --------------------------------------------------------------------------- 정상 길
def test_restore_check는_S3의_마지막_덤프를_받아_일회용_컨테이너에_적재하고_기록만_남긴다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith(f"✓ 백업 복원 확인: {KEY} — 표 75개 · 스키마 V45 · 주요 표 8개 행 수 정상 · 실제 계좌 표 13개 읽힘 · 적재 ")
    aws = _calls(fakes, "aws ")
    assert len(aws) == 1 and aws[0].startswith(f"aws s3 cp --only-show-errors s3://test-bucket-name/{KEY} ")
    assert _calls(fakes, "curl ") == [], "정상이면 알리지 않습니다(D-5)"
    logs = _logs(fakes)
    assert len(logs) == 1 and "복원 확인 정상: " in logs[0] and "user.notice" in logs[0]
    # 기록 — 첫 줄은 backup-s3.sh의 기록과 같은 모양, 다음 줄부터 다음 실행이 견줄 값. 소유자만 읽음.
    record = _record(root)
    lines = record.read_text(encoding="utf-8").splitlines()
    epoch, _utc, key = lines[0].split()
    assert abs(int(epoch) - time.time()) < 120 and key == KEY
    assert {"tables=75", "schema=45", "rows.snapshots=100", "rows.paper_nav_daily=107", "real.real_trade_config=7131",
            "real.manual_ledger=7143"} <= set(lines)
    assert f"size={_dump_file(tmp_path).stat().st_size}" in lines
    assert stat.S_IMODE(record.stat().st_mode) == 0o600
    assert not (root / "backups/.restore-check-tmp").exists(), "받은 덤프를 남기지 않습니다"
    assert not (root / "backups/.last-restore-ok.tmp").exists()


def test_restore_check의_컨테이너는_망도_포트도_운영_볼륨도_없이_뜨고_끝나면_익명_볼륨까지_지운다(root, fakes, tmp_path):
    assert _check(root, fakes, tmp_path).returncode == 0
    docker = _calls(fakes, "docker ")
    runs = [c for c in docker if c.startswith("docker run ")]
    assert len(runs) == 1
    run = runs[0]
    for part in (f"--name {CTR} ", "--network none ", "--memory 768m ", "--memory-swap 768m ", "--cpus 1 ", "--pull never ",
                 "POSTGRES_DB=restore_check", "POSTGRES_USER=macro", " sha256:prodimage "):
        assert part in run, part
    words = run.split()
    assert not any(w in ("-p", "-P", "--publish", "--publish-all", "-v", "--volume", "--mount", "--volumes-from", "--network=host",
                         "--privileged") for w in words), run
    assert "POSTGRES_DB=macrodash" not in run and "PASSWORD" not in run and SECRET not in run
    # 운영 쪽에서는 읽기 둘뿐 — 운영 postgres 컨테이너의 ID와 그 이미지.
    prod = [c for c in docker if CTR not in c]
    assert prod == ["docker compose ps -q postgres", "docker inspect --format {{.Image}} prodctr"], prod
    assert not any(c.startswith(("docker compose exec", "docker compose up", "docker compose stop", "docker compose down",
                                 "docker stop", "docker restart", "docker volume", "docker system", "docker network")) for c in docker)
    # 앞 실행의 찌꺼기를 먼저 지우고, 끝에서 한 번 더 지웁니다.
    removes = [i for i, c in enumerate(docker) if c == f"docker rm -f -v {CTR}"]
    assert len(removes) == 2 and removes[0] < docker.index(run) and removes[1] == len(docker) - 1


def test_restore_check의_적재는_오류에서_멈추고_덤프_뒤에_끝_표시를_덧붙인다(root, fakes, tmp_path):
    assert _check(root, fakes, tmp_path).returncode == 0
    execs = [c for c in _calls(fakes, f"docker exec -i {CTR} psql ")]
    assert len(execs) == 3, execs   # 적재 + 판정 질의 둘(수집·모의 표 / 실제 계좌 표)
    assert all("-X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U macro -d restore_check" in c for c in execs)
    assert " -At " not in execs[0] + " "
    loaded = fakes[1].with_name("calls.log.load").read_text(encoding="utf-8")
    size, _, tail = loaded.partition("\n")
    marker = "CREATE SCHEMA restore_check; CREATE TABLE restore_check.loaded AS SELECT 1 AS ok;\n"
    assert tail.endswith(marker) and "PostgreSQL database dump complete" in tail
    assert int(size) == _dump_file(tmp_path).stat().st_size + len(marker) + 1, "덤프 전체가 psql의 입력으로 갑니다"
    ready = _calls(fakes, f"docker exec {CTR} pg_isready ")
    assert ready and "-h 127.0.0.1" in ready[0], "초기화 중의 임시 서버(유닉스 소켓만)에 닿지 않게 TCP 루프백으로 기다립니다"


def test_restore_check는_실제_계좌_표의_건수를_기록_파일에만_남긴다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 0
    seen = _seen(result, fakes)
    for i in range(len(REAL_TABLES)):
        assert str(7131 + i) not in seen, "실제 계좌 표의 건수가 출력·syslog·명령 인자에 실렸습니다"
    assert "실제 계좌 표 13개 읽힘" in seen
    assert sum(line.startswith("real.") for line in _record(root).read_text(encoding="utf-8").splitlines()) == 13


def test_restore_check는_운영_postgres가_없어_이미지를_모르면_띄우지_않는다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path, FAKE_NO_PROD="1")
    assert result.returncode == 1 and "image_unknown" in result.stderr
    assert not any(c.startswith("docker run ") for c in _calls(fakes, "docker "))


def test_restore_check는_RESTORE_CHECK_IMAGE가_있으면_운영_컨테이너를_묻지_않는다(root, fakes, tmp_path):
    assert _check(root, fakes, tmp_path, RESTORE_CHECK_IMAGE="postgres:16-alpine").returncode == 0
    docker = _calls(fakes, "docker ")
    assert not any("compose" in c for c in docker)
    assert any(c.startswith("docker run ") and " postgres:16-alpine " in c for c in docker)


# --------------------------------------------------------------------------- 실패 갈래
_FAILURES = [
    ("받기_실패", dict(FAKE_AWS_RC="1"), "download_failed"),
    ("받기_시간_초과", dict(FAKE_AWS_RC="124"), "timeout_download"),
    ("끝_표시_없는_덤프", dict(_incomplete="1"), "dump_incomplete"),
    ("컨테이너_못_띄움", dict(FAKE_RUN_RC="125"), "container_start_failed"),
    ("준비_안_됨", dict(FAKE_READY_RC="2"), "container_not_ready"),
    ("준비_전에_메모리_상한", dict(FAKE_READY_RC="2", FAKE_OOM="true"), "out_of_memory"),
    ("적재_실패", dict(FAKE_LOAD_RC="3"), "load_failed"),
    ("적재_시간_초과", dict(FAKE_LOAD_RC="124"), "timeout_load"),
    ("적재_중_메모리_상한", dict(FAKE_LOAD_RC="137", FAKE_OOM="true"), "out_of_memory"),
    ("판정_질의_실패", dict(FAKE_QUERY_RC="3"), "query_failed"),
]


@pytest.mark.parametrize(("extra", "code"), [(e, c) for _, e, c in _FAILURES], ids=[n for n, _, _ in _FAILURES])
def test_restore_check는_실패하면_사유_코드만_운영_봇으로_알리고_컨테이너와_받은_파일을_지운다(root, fakes, tmp_path, extra, code):
    extra = dict(extra)
    if extra.pop("_incomplete", None):
        extra["FAKE_S3_SRC"] = str(_dump_file(tmp_path, complete=False))
    _record(root).write_text("1 x old\nsize=1\n", encoding="utf-8")
    result = _check(root, fakes, tmp_path, **extra)
    assert result.returncode == 1, result.stdout + result.stderr
    assert result.stderr.strip() == f"✗ 백업 복원 확인 실패: {code} ({KEY})"
    curls = _calls(fakes, "curl ")
    assert len(curls) == 1 and "-K -" in curls[0] and "--max-time" in curls[0]
    assert f"text=my-macro 서버 — 백업 복원 확인 실패: {code} ({KEY})" in curls[0]
    sent = fakes[1].read_text(encoding="utf-8")
    for part in ("실행:", "journalctl -t my-macro-restore-check --since today", "bash scripts/vultr/restore-check.sh --rebase",
                 "운영 DB는 건드리지 않았습니다", "복원 확인 실패 봐 줘"):
        assert part in sent, part
    logs = _logs(fakes)
    assert len(logs) == 1 and "user.err" in logs[0] and f"복원 확인 실패: {code} ({KEY})" in logs[0]
    assert _calls(fakes, "docker ")[-1] == f"docker rm -f -v {CTR}"
    assert not (root / "backups/.restore-check-tmp").exists()
    assert _record(root).read_text(encoding="utf-8") == "1 x old\nsize=1\n", "실패는 마지막 성공 기록을 바꾸지 않습니다"
    # 비밀값·버킷 이름·psql과 aws의 오류 글은 출력·syslog·명령 인자 어디에도 없습니다(버킷 이름은 aws의 인자에만).
    seen = _seen(result, fakes)
    assert TG_TOKEN not in seen and TG_CHAT not in seen and SECRET not in seen
    assert ROW_LEAK not in seen and "row-value" not in seen and "fatal error" not in seen and "fake query failure" not in seen
    assert "test-bucket-name" not in result.stdout + result.stderr + "\n".join(c for c in tools._calls(fakes) if not c.startswith("aws "))
    config = fakes[1].with_suffix(".curl-config").read_text(encoding="utf-8")
    assert f'url = "https://api.telegram.org/bot{TG_TOKEN}/sendMessage"' in config and f"chat_id={TG_CHAT}" in config


_JUDGEMENTS = [
    ("적재_끝_표시_없음", dict(marker="0"), "load_incomplete"),
    ("꼭_있어야_하는_표_없음", dict(missing="paper_fills,snapshots", rows__paper_fills=None, rows__snapshots=None, fresh=None),
     "tables_missing:paper_fills,snapshots fresh_unreadable"),
    ("스키마_번호_없음", dict(schema=""), "schema_unreadable"),
    ("스키마_표_없음", dict(schema=None), "schema_unreadable"),
    ("주요_표가_빔", dict(rows__paper_decisions="0"), "rows_zero:paper_decisions"),
    ("자료가_덤프보다_한참_앞", dict(fresh="-90000"), "data_stale"),
    ("자료가_덤프보다_뒤", dict(fresh="+3700"), "data_after_dump"),
    ("자료_시각을_못_읽음", dict(fresh=""), "fresh_unreadable"),
    ("여러_사유", dict(marker="0", rows__users="0"), "load_incomplete rows_zero:users"),
]


@pytest.mark.parametrize(("over", "codes"), [(o, c) for _, o, c in _JUDGEMENTS], ids=[n for n, _, _ in _JUDGEMENTS])
def test_restore_check는_판정에_걸린_사유_코드를_모두_알린다(root, fakes, tmp_path, over, codes):
    over = dict(over)
    if (over.get("fresh") or "")[:1] in ("-", "+"):
        over["fresh"] = str(_dump_epoch(root) + int(over["fresh"]))
    result = _check(root, fakes, tmp_path, FAKE_FACTS=_facts(root, **over))
    assert result.returncode == 1, result.stdout + result.stderr
    assert result.stderr.strip() == f"✗ 백업 복원 확인 실패: {codes} ({KEY})"
    assert len(_calls(fakes, "curl ")) == 1 and not _record(root).exists()
    assert _calls(fakes, "docker ")[-1] == f"docker rm -f -v {CTR}"


@pytest.mark.parametrize(("hours", "ok"), [("23", True), ("25", False)])
def test_restore_check의_최근_자료_시각은_덤프_시각_앞_24시간_안이어야_한다(root, fakes, tmp_path, hours, ok):
    fresh = str(_dump_epoch(root) - int(hours) * 3600)
    result = _check(root, fakes, tmp_path, FAKE_FACTS=_facts(root, fresh=fresh))
    assert (result.returncode == 0) is ok, result.stdout + result.stderr
    # 허용 폭은 RESTORE_CHECK_FRESH_HOURS로 넓힙니다(옛 덤프를 --file로 볼 때).
    assert _check(root, fakes, tmp_path, FAKE_FACTS=_facts(root, fresh=fresh), RESTORE_CHECK_FRESH_HOURS="48").returncode == 0


def test_restore_check는_실제_계좌_표가_하나라도_세어지지_않으면_개수만_알린다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path, FAKE_REAL_FACTS=_real_facts(skip=("manual_ledger", "real_trade_orders")))
    assert result.returncode == 1
    assert result.stderr.strip() == f"✗ 백업 복원 확인 실패: real_tables_unreadable:2 ({KEY})"
    curls = _calls(fakes, "curl ")
    assert len(curls) == 1 and "manual_ledger" not in curls[0] + result.stderr and not _record(root).exists()


# --------------------------------------------------------------------------- 직전 성공 기록과 견줌
def _write_record(here: Path, **values: int) -> str:
    text = "1700000000 2026-11-21T00:31:00Z db/vultr/old.sql\n" + "".join(f"{k.replace('__', '.')}={v}\n" for k, v in values.items())
    _record(here).write_text(text, encoding="utf-8")
    return text


@pytest.mark.parametrize(("prev", "ok"), [(111, True), (112, False)])
def test_restore_check는_주요_표의_행_수가_직전_성공보다_10퍼센트_넘게_줄면_실패로_본다(root, fakes, tmp_path, prev, ok):
    old = _write_record(root, rows__snapshots=prev)      # 이번 100행 — 111의 90%는 99.9, 112의 90%는 100.8
    result = _check(root, fakes, tmp_path)
    assert (result.returncode == 0) is ok, result.stdout + result.stderr
    if not ok:
        assert result.stderr.strip() == f"✗ 백업 복원 확인 실패: rows_dropped:snapshots ({KEY})"
        assert _record(root).read_text(encoding="utf-8") == old


def test_restore_check는_덤프_크기가_직전_성공보다_10퍼센트_넘게_줄면_실패로_본다(root, fakes, tmp_path):
    size = _dump_file(tmp_path).stat().st_size
    _write_record(root, size=size * 2)
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 1 and result.stderr.strip() == f"✗ 백업 복원 확인 실패: size_dropped ({KEY})"


def test_restore_check의_rebase는_직전_기록과_견주지_않고_정상이면_기록을_새로_쓴다(root, fakes, tmp_path):
    _write_record(root, size=10 ** 9, rows__snapshots=10 ** 6, rows__paper_fills=10 ** 6)
    assert _check(root, fakes, tmp_path).returncode == 1
    result = _check(root, fakes, tmp_path, "--rebase")
    assert result.returncode == 0, result.stdout + result.stderr
    lines = _record(root).read_text(encoding="utf-8").splitlines()
    assert lines[0].endswith(f" {KEY}") and "rows.snapshots=100" in lines
    assert _check(root, fakes, tmp_path).returncode == 0, "새 기록이 다음 실행의 기준입니다"
    # 줄어든 것 말고 다른 사유는 --rebase로도 넘어가지 않습니다.
    assert _check(root, fakes, tmp_path, "--rebase", FAKE_FACTS=_facts(root, rows__users="0")).returncode == 1


# --------------------------------------------------------------------------- 백업 기록·버킷
@pytest.mark.parametrize("text", [None, "", "abc 2026 db/vultr/x.sql\n", "1700000000 t db/x.sql\n", "1700000000 t db/vultr/../../x.sql\n",
                                  "1700000000 t db/vultr/a b.sql\n", "1700000000 t db/vultr/x.sql.gz\n", "1700000000 t\n"])
def test_restore_check는_마지막_S3_백업_기록이_없거나_모양이_다르면_아무것도_받지_않는다(root, fakes, tmp_path, text):
    record = root / "backups/.last-s3-ok"
    record.unlink()
    if text is not None:
        record.write_text(text, encoding="utf-8")
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 1 and "no_backup_record" in result.stderr
    assert _calls(fakes, "aws ") == [] and not any(c.startswith("docker run ") for c in _calls(fakes, "docker "))
    assert len(_calls(fakes, "curl ")) == 1


def test_restore_check는_버킷_이름이_없으면_받지_않는다(root, fakes, tmp_path):
    (root / ".env").write_text(f"TELEGRAM_BOT_TOKEN={TG_TOKEN}\nTELEGRAM_CHAT_ID={TG_CHAT}\n", encoding="utf-8")
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 1 and "no_bucket" in result.stderr and _calls(fakes, "aws ") == []


# --------------------------------------------------------------------------- 알림 길
@pytest.mark.parametrize("env_lines", ["", "TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=1\n", f"TELEGRAM_BOT_TOKEN={TG_TOKEN}\n"])
def test_restore_check는_텔레그램_값이_하나라도_없으면_보내지_않고_실패_코드는_그대로(root, fakes, tmp_path, env_lines):
    (root / ".env").write_text("AWS_BACKUP_BUCKET=test-bucket-name\n" + env_lines, encoding="utf-8")
    result = _check(root, fakes, tmp_path, FAKE_LOAD_RC="3")
    assert result.returncode == 1 and _calls(fakes, "curl ") == []
    assert any("텔레그램 값이 없어" in c for c in _logs(fakes))


def test_restore_check는_텔레그램_알림이_실패해도_종료_코드를_바꾸지_않고_syslog에_남긴다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path, FAKE_LOAD_RC="3", FAKE_CURL_RC="7")
    assert result.returncode == 1
    assert any("텔레그램 알림을 보내지 못함" in c for c in _logs(fakes))


# --------------------------------------------------------------------------- --file(손으로 보는 길)
def test_restore_check의_file은_받지도_알리지도_기록하지도_않는다(root, fakes, tmp_path):
    dump = _dump_file(tmp_path)
    _write_record(root, size=10 ** 9)                       # 견주지 않음
    before = _record(root).read_text(encoding="utf-8")
    fresh = str(int(dump.stat().st_mtime) - 60)             # 덤프 시각 = 파일 시각
    ok = _check(root, fakes, tmp_path, "--file", str(dump), FAKE_FACTS=_facts(root, fresh=fresh))
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert ok.stdout.startswith("✓ 백업 복원 확인: s3-object.sql — ")
    failed = _check(root, fakes, tmp_path, "--file", str(dump), FAKE_FACTS=_facts(root, fresh=fresh), FAKE_LOAD_RC="3")
    assert failed.returncode == 1 and "load_failed (s3-object.sql)" in failed.stderr
    assert _calls(fakes, "aws ") == [] and _calls(fakes, "curl ") == []
    assert _record(root).read_text(encoding="utf-8") == before
    assert dump.exists(), "넘겨받은 파일은 지우지 않습니다"


@pytest.mark.parametrize("args", [("--file",), ("--file", "없는-파일.sql"), ("--nope",), ("--summary", "x"), ("--rebase", "x")])
def test_restore_check는_인자가_틀리면_2로_끝나고_아무것도_띄우지_않는다(root, fakes, tmp_path, args):
    result = _check(root, fakes, tmp_path, *args)
    assert result.returncode == 2 and result.stderr
    assert not any(c.startswith(("docker run ", "aws ", "curl ")) for c in tools._calls(fakes))


# --------------------------------------------------------------------------- 안전장치
def _with_kst(fakes, now: str) -> dict[str, str]:
    tools._write_exec(fakes[0] / "date", _DATE)
    return {"FAKE_KST_NOW": now, "RESTORE_CHECK_ANYTIME": ""}


@pytest.mark.parametrize("now", ["1 0845", "3 1200", "5 1535", "2 1635"])
def test_restore_check는_평일_실제_매매_창과_그_뒤_한_시간에는_시작하지_않는다(root, fakes, tmp_path, now):
    result = _check(root, fakes, tmp_path, **_with_kst(fakes, now))
    assert result.returncode == 3 and "trade_window" in result.stderr and result.stderr.startswith("경고: ")
    assert _calls(fakes, "docker ") == [] and _calls(fakes, "aws ") == [] and _calls(fakes, "curl ") == []
    assert any("user.warning" in c and "건너뜀: trade_window" in c for c in _logs(fakes))
    # 알고 진행할 때만.
    assert _check(root, fakes, tmp_path, **{**_with_kst(fakes, now), "RESTORE_CHECK_ANYTIME": "1"}).returncode == 0


@pytest.mark.parametrize("now", ["1 0844", "2 1636", "6 0930", "7 1200", "4 2330"])
def test_restore_check는_그_창_밖이면_시작한다(root, fakes, tmp_path, now):
    result = _check(root, fakes, tmp_path, **_with_kst(fakes, now))
    assert result.returncode == 0, result.stdout + result.stderr


def test_restore_check는_여유_디스크가_6GB_미만이면_건너뛰고_알린다(root, fakes, tmp_path):
    result = _check(root, fakes, tmp_path, FAKE_DF_PCT="96")       # 가짜 df: 120 GB의 4% = 4.8 GB
    assert result.returncode == 3 and "low_disk" in result.stderr
    curls = _calls(fakes, "curl ")
    assert len(curls) == 1 and "백업 복원 확인 건너뜀: low_disk — 여유 디스크가 6GB 미만입니다(지금 4.8GB)" in curls[0]
    assert not any(c.startswith(("docker run ", "aws ")) for c in tools._calls(fakes))
    assert _check(root, fakes, tmp_path, FAKE_DF_PCT="94").returncode == 0   # 7.2 GB


def test_restore_check는_여유_메모리가_1GB_미만이면_건너뛰고_알린다(root, fakes, tmp_path):
    (tmp_path / "meminfo").write_text("MemTotal:        4000000 kB\nMemAvailable:     900000 kB\n", encoding="utf-8")
    result = _check(root, fakes, tmp_path)
    assert result.returncode == 3 and "low_memory" in result.stderr
    curls = _calls(fakes, "curl ")
    assert len(curls) == 1 and "low_memory — 여유 메모리가 1GB 미만입니다(지금 878MB)" in curls[0]
    assert not any(c.startswith(("docker run ", "aws ")) for c in tools._calls(fakes))


def test_restore_check는_디스크와_메모리를_읽지_못하면_그대로_진행한다(root, fakes, tmp_path):
    assert _check(root, fakes, tmp_path, FAKE_DF_RC="1", RESTORE_CHECK_MEMINFO=str(tmp_path / "없음")).returncode == 0


def test_restore_check는_다른_실행이_잠금을_쥐고_있으면_그_컨테이너를_건드리지_않고_물러난다(root, fakes, tmp_path):
    if shutil.which("flock") is None:
        pytest.skip("flock이 없어 건너뜁니다.")
    with (root / "backups/.restore-check.lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        result = _check(root, fakes, tmp_path)
    assert result.returncode == 3 and "locked" in result.stderr
    assert _calls(fakes, "docker ") == [], "돌고 있는 실행의 컨테이너를 지우면 안 됩니다"
    assert _calls(fakes, "curl ") == []
    assert _check(root, fakes, tmp_path).returncode == 0, "잠금은 쥔 쪽이 끝나면 풀립니다"


def test_restore_check는_적재_중에_중단되면_기다리지_않고_컨테이너와_받은_파일을_지운다(root, fakes, tmp_path):
    """bash는 앞에서 도는 명령이 끝나야 신호를 처리합니다 — 적재를 뒤에서 돌리고 기다리지 않으면 정리가 적재 끝(최대 30분)까지 밀립니다."""
    bin_dir, log = fakes
    slow = _DOCKER.replace('        cat > "$FAKE_LOG.load.all"\n', '        touch "$FAKE_LOG.loading"; exec sleep 30\n', 1)
    assert slow != _DOCKER
    tools._write_exec(bin_dir / "docker", slow)
    tools._write_exec(bin_dir / "sleep", f"#!/usr/bin/env bash\nexec {shutil.which('sleep') or '/bin/sleep'} \"$@\"\n")
    meminfo = tmp_path / "meminfo"
    meminfo.write_text("MemAvailable:    2097152 kB\n", encoding="utf-8")
    env = tools._env(fakes, RESTORE_CHECK_ANYTIME="1", RESTORE_CHECK_MEMINFO=str(meminfo), FAKE_S3_SRC=str(_dump_file(tmp_path)),
                     FAKE_FACTS=_facts(root), FAKE_REAL_FACTS=_real_facts())
    proc = subprocess.Popen(["bash", str(root / "scripts/vultr/restore-check.sh")], cwd=root, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 20
        while not Path(f"{log}.loading").exists():
            assert time.time() < deadline and proc.poll() is None, "적재가 시작되지 않았습니다"
            time.sleep(0.05)
        began = time.time()
        proc.terminate()
        assert proc.wait(timeout=10) == 143
        assert time.time() - began < 5
    finally:
        if proc.poll() is None:
            proc.kill()
    assert _calls(fakes, "docker ")[-1] == f"docker rm -f -v {CTR}"
    assert not (root / "backups/.restore-check-tmp").exists() and not _record(root).exists()


# --------------------------------------------------------------------------- 요약(deploy.sh 끝 · make status)
def _summary(here: Path, fakes, tmp_path: Path, flag: str = "--summary") -> subprocess.CompletedProcess:
    return _check(here, fakes, tmp_path, flag, RESTORE_CHECK_ANYTIME="")


def _write_age(here: Path, days: int) -> None:
    # 하루의 한가운데(+12시간)로 적어, 시험이 도는 사이에 날 경계를 넘지 않게 합니다.
    _record(here).write_text(f"{int(time.time()) - days * 86400 - 43200} t {KEY}\nsize=1\n", encoding="utf-8")


@pytest.mark.parametrize(("days", "line"), [(0, "마지막 백업 복원 확인: 0일 전"), (9, "마지막 백업 복원 확인: 9일 전"),
                                           (10, "경고: 마지막 백업 복원 확인이 10일 전입니다(9일 넘음)")])
def test_restore_check_요약은_마지막_확인의_나이를_한_줄로_찍고_9일을_넘으면_경고한다(root, fakes, tmp_path, days, line):
    _write_age(root, days)
    result = _summary(root, fakes, tmp_path)
    assert result.returncode == 0 and result.stderr == ""
    assert len(result.stdout.splitlines()) == 1 and result.stdout.startswith(line)
    assert tools._calls(fakes) == [], "요약은 아무것도 띄우지도 알리지도 않습니다"


@pytest.mark.parametrize("text", [None, "", "abc\n"])
def test_restore_check_요약은_기록이_없거나_읽지_못하면_경고한다(root, fakes, tmp_path, text):
    if text is not None:
        _record(root).write_text(text, encoding="utf-8")
    result = _summary(root, fakes, tmp_path)
    assert result.returncode == 0
    assert result.stdout.startswith("경고: 백업 복원 확인 기록(backups/.last-restore-ok)이 없습니다") and len(result.stdout.splitlines()) == 1


def test_restore_check는_summary_if_server면_서버가_아닐_때_아무것도_찍지_않는다(root, fakes, tmp_path):
    assert _summary(root, fakes, tmp_path, "--summary-if-server").stdout.startswith("경고: 백업 복원 확인 기록")
    (root / ".env").write_text("FRONTEND_PORT=3002\n", encoding="utf-8")
    result = _summary(root, fakes, tmp_path, "--summary-if-server")
    assert result.returncode == 0 and result.stdout == "" and result.stderr == ""


def test_deploy_끝_요약과_make_status가_복원_확인_나이를_부른다():
    deploy = (ROOT / "scripts/vultr/deploy.sh").read_text(encoding="utf-8")
    assert "\n[ ! -f scripts/vultr/restore-check.sh ] || bash scripts/vultr/restore-check.sh --summary || true\n" in deploy, \
        "요약이라 없거나 실패해도 배포를 실패로 만들지 않습니다"
    assert deploy.index("bash scripts/vultr/backup-age.sh\n") < deploy.index("restore-check.sh --summary ||")
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    assert "\n\t@[ ! -f scripts/vultr/restore-check.sh ] || bash scripts/vultr/restore-check.sh --summary-if-server\n" in makefile


@pytest.mark.skipif(REAL_MAKE is None, reason="make가 없어 건너뜁니다.")
@pytest.mark.parametrize("days", [2, 12, None])
def test_make_status는_서버면_복원_확인_나이를_요약과_같은_줄로_찍는다(fakes, tmp_path, days):
    here = tmp_path / "status-root"
    shutil.copytree(ROOT / "scripts", here / "scripts")
    (here / ".env").write_text("COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\n", encoding="utf-8")
    (here / "backups").mkdir()
    if days is not None:
        _write_age(here, days)
    env = tools._env(fakes, FAKE_CURL_RC="7")
    status = subprocess.run([REAL_MAKE, "--no-print-directory", "-C", str(here), "-f", str(ROOT / "Makefile"), "status"], env=env,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    assert status.returncode == 0, status.stdout + status.stderr
    lines = [line for line in status.stdout.splitlines() if "복원 확인" in line]
    summary = subprocess.run(["bash", str(here / "scripts/vultr/restore-check.sh"), "--summary"], cwd=here, env=env,
                             capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert lines == summary.stdout.splitlines() and len(lines) == 1
    assert lines[0].startswith("경고:") is (days != 2)


def test_make_status는_PC에서는_복원_확인_줄을_찍지_않는다(fakes, tmp_path):
    if REAL_MAKE is None:
        pytest.skip("make가 없어 건너뜁니다.")
    here = tmp_path / "status-root"
    shutil.copytree(ROOT / "scripts", here / "scripts")
    status = subprocess.run([REAL_MAKE, "--no-print-directory", "-C", str(here), "-f", str(ROOT / "Makefile"), "status"],
                            env=tools._env(fakes, FAKE_CURL_RC="7"), capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert status.returncode == 0 and "복원 확인" not in status.stdout + status.stderr


# --------------------------------------------------------------------------- 판정 질의(진짜 PostgreSQL — psql이 없으면 건너뜀, CI에서 돎)
def _facts_sql() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    start = text.index("    cat <<'SQL'\n") + len("    cat <<'SQL'\n")
    return text[start:text.index("\nSQL\n", start)] + "\n"


def _script_list(name: str) -> str:
    """스크립트의 표 목록(required·main_tables·real_tables) — 시험의 목록과 갈라지지 않게 스크립트에서 읽습니다."""
    for line in SCRIPT.read_text(encoding="utf-8").splitlines():
        if line.startswith(f'{name}="'):
            return line.split('"')[1]
    raise AssertionError(name)


def test_restore_check의_표_목록은_마이그레이션에_있는_표이고_실제_계좌_표_13개를_모두_센다():
    created = set()
    for path in (ROOT / "db/migrations").glob("V*__*.sql"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("CREATE TABLE"):
                created.add(line.replace("IF NOT EXISTS ", "").split()[2].strip("("))
    created.add("schema_migrations")   # 수집기가 만듦(app/migrations.py)
    for name in ("required", "main_tables", "real_tables"):
        assert set(_script_list(name).split()) <= created, name
    assert _script_list("main_tables").split() == MAIN_TABLES and _script_list("real_tables").split() == REAL_TABLES
    assert set(REAL_TABLES) == {t for t in created if t.startswith(("real_trade_", "manual_"))}, \
        "실제 계좌 표(real_trade_*·manual_*)가 늘면 real_tables에 더합니다 — 건수가 기록 파일에만 남도록"
    assert not set(MAIN_TABLES) & set(REAL_TABLES), "실제 계좌 표의 건수는 주요 표 길(알림에 표 이름이 실림)로 세지 않습니다"


@pytest.fixture()
def facts_db(database_url):
    if shutil.which("psql") is None:
        pytest.skip("psql 클라이언트가 없어 restore-check.sh 판정 질의 시험을 건너뜁니다.")
    import psycopg

    from app import migrations

    name = f"restorecheck_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(database_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    db_url = urlparse(database_url)._replace(path=f"/{name}").geturl()
    with psycopg.connect(db_url, autocommit=True) as conn:
        migrations.apply_pending(conn, migrations.discover(ROOT / "db" / "migrations"))
    try:
        yield name, db_url
    finally:
        with psycopg.connect(database_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


def _run_facts(database_url: str, db_name: str, required: str, counted: str) -> dict[str, str]:
    """스크립트가 일회용 컨테이너 안에서 부르는 것과 같은 psql 옵션으로 질의를 돌립니다(접속만 이 시험의 DB로)."""
    url = urlparse(database_url)
    env = {**os.environ, "PGPASSWORD": url.password or "", "PGHOST": url.hostname or "localhost", "PGPORT": str(url.port or 5432)}
    result = subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", url.username or "macro", "-d", db_name,
                             "-At", "-v", f"required={required}", "-v", f"counted={counted}"],
                            input=_facts_sql(), env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    return dict(line.split("=", 1) for line in result.stdout.splitlines())


def test_restore_check의_판정_질의는_표와_스키마_번호와_행_수와_최근_자료_시각을_낸다(database_url, facts_db):
    import psycopg

    from app import migrations

    name, db_url = facts_db
    latest = max(m.version for m in migrations.discover(ROOT / "db" / "migrations"))
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute("INSERT INTO snapshots (name, payload, collected_at) VALUES ('a', '{}', to_timestamp(1700000000)), "
                     "('b', '{}', to_timestamp(1700000600.9))")
    facts = _run_facts(database_url, name, _script_list("required"), _script_list("main_tables"))
    assert facts["marker"] == "0", "끝 표시(restore_check.loaded)는 적재가 덧붙입니다 — 이 DB에는 없음"
    assert facts["missing"] == "" and int(facts["tables"]) >= len(_script_list("required").split())
    assert facts["schema"] == str(latest)
    assert facts["fresh"] == "1700000600"
    assert {k: v for k, v in facts.items() if k.startswith("rows.")} == \
        {f"rows.{t}": ("2" if t == "snapshots" else "0") for t in MAIN_TABLES}
    real = _run_facts(database_url, name, "", _script_list("real_tables"))
    assert real["missing"] == "" and {k for k in real if k.startswith("rows.")} == {f"rows.{t}" for t in REAL_TABLES}


def test_restore_check의_판정_질의는_표가_없어도_실패하지_않고_없는_표를_알린다(database_url, facts_db):
    import psycopg

    name, db_url = facts_db
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute("DROP TABLE snapshots, schema_migrations, manual_ledger CASCADE")
        conn.execute("CREATE SCHEMA restore_check")
        conn.execute("CREATE TABLE restore_check.loaded AS SELECT 1 AS ok")
    facts = _run_facts(database_url, name, _script_list("required"), _script_list("main_tables"))
    assert facts["marker"] == "1" and facts["missing"] == "schema_migrations,snapshots"
    assert "schema" not in facts and "fresh" not in facts and "rows.snapshots" not in facts and facts["rows.timeseries"] == "0"
    real = _run_facts(database_url, name, "", _script_list("real_tables"))
    assert "rows.manual_ledger" not in real and len([k for k in real if k.startswith("rows.")]) == 12
