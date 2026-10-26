# 로컬 설치·실행 가이드 (macOS)

이 문서는 맥에서 `~/Projects/My_macro_dashboard_v2`에 프로젝트를 두고 쓰는
것을 기준으로 씁니다. 다른 경로를 쓰면 아래 명령의 경로만 바꾸면 됩니다.

> 컨테이너 네 개(화면·API·수집기·DB)로 이뤄져 있어 **Docker로 묶어 한 줄로
> 띄우는 방식**이 기본이고, Docker 없이 쓰는 경로도 함께 둡니다.

---

## 0. 한눈에 보기

```bash
# 저장
git clone https://github.com/Jinyoung-Kang/My_macro_dashboard_v2.git \
  ~/Projects/My_macro_dashboard_v2
cd ~/Projects/My_macro_dashboard_v2

# 준비 (.env 생성 · 키/포트 확인)
make setup

# 실행
make up          # 최초 빌드 5~10분
make collect     # 첫 데이터 수집 (이걸 해야 화면에 숫자가 찹니다)
open http://localhost:3002
```

> **폴더 이름이 DB 볼륨 이름을 정합니다.** 로컬 폴더는 저장소 이름과 같은
> `My_macro_dashboard_v2`라, `git clone`에 경로를 주지 않아도 이 이름으로
> 만들어집니다. Docker는 폴더 이름으로 DB 볼륨을 구분하므로
> (`my_macro_dashboard_v2_postgres-data`), 폴더 이름을 바꾸거나 다른 이름의
> 폴더에 clone하면 **빈 DB로 시작**합니다. 쌓아 둔 이력은 옛 이름의 볼륨에 그대로
> 남아 있습니다. 반대로 위치만 다르고 이름이 같은 폴더는 같은 DB·컨테이너를 함께 씁니다.

> **`My_macro_dashboard_v1`에서 갈라내기(2026-10-26)** — 이 저장소는 v1을 전체 이력으로 clone해 `origin`만 새 저장소로 바꿔
> 만들었습니다(v1은 2026-10-25에 `Local_macro_dashboard_v3`에서 같은 식으로 갈라져 나옴). v1·v3 폴더·볼륨·스택은 **그대로 계속 돕니다** —
> 이 저장소는 `.env`의 포트를 3002/8082/8002/5434로 바꿔 v3(3000/…)·v1(3001/…)과 함께 띄웁니다(compose 프로젝트·볼륨·QA 스택·세션 쿠키
> 이름도 다름). 모의 매매 정기 작업은 AWS의 v1 한 곳에서만 돌므로 이 폴더의 `.env`는 `PAPER_ENABLED=false`입니다(ADR 0019).
> 데이터는 볼륨 복사가 아니라 백업·복원(ADR 0003)으로 이어받습니다. 한 줄씩 붙여 넣고, 오류 없이 끝났는지 본 뒤 다음 줄로 넘어가세요.
> ```bash
> git clone https://github.com/Jinyoung-Kang/My_macro_dashboard_v2.git ~/Projects/My_macro_dashboard_v2
> cp ~/Projects/My_macro_dashboard_v1/.env ~/Projects/My_macro_dashboard_v2/.env
> cd ~/Projects/My_macro_dashboard_v2 && sed -i -e 's/^DATABASE_PORT=.*/DATABASE_PORT=5434/' -e 's/^BACKEND_PORT=.*/BACKEND_PORT=8082/' \
>   -e 's/^COLLECTOR_PORT=.*/COLLECTOR_PORT=8002/' -e 's/^FRONTEND_PORT=.*/FRONTEND_PORT=3002/' -e 's/^PAPER_ENABLED=.*/PAPER_ENABLED=false/' .env
> grep -q '^PAPER_ENABLED=false$' .env || echo 'PAPER_ENABLED=false' >> .env
> make up && make doctor
> (cd ~/Projects/My_macro_dashboard_v1 && make backup)      # 마지막 줄의 파일 이름을 적어 둠
> make restore F=$HOME/Projects/My_macro_dashboard_v1/backups/<그 파일>.sql
> ```
> `.env` 내용은 화면에 출력하지 마세요. `.env.qa`는 복사하지 않습니다 — `bash scripts/qa/qa-stack.sh up`이 새 비밀값으로 만듭니다.
> v1 볼륨은 그대로라, 문제가 생기면 이 폴더에서 `make down` 하면 v1·v3는 영향 없이 계속 돕니다.

---

## 1. 사전 준비

### 1-1. Docker Desktop (권장 경로)

```bash
brew install --cask docker
open -a Docker          # 처음 실행 시 권한을 한 번 물어봅니다
docker info             # 데몬이 떠 있으면 정보가 출력됩니다
```

Apple Silicon(M1~M4)에서 그대로 동작합니다. 이 프로젝트가 쓰는 이미지
(`postgres:16-alpine`, `eclipse-temurin:21`, `node:24-alpine`)는
모두 arm64 빌드를 제공합니다.

**Docker Desktop 설정 권장값** — 설정 → Resources
- 메모리 **4GB 이상** (백엔드 빌드에 JVM이 돌아갑니다)
- 디스크 10GB 이상

### 1-2. Docker를 쓰지 않는 경우

Homebrew로 직접 설치합니다.

```bash
brew install postgresql@16 maven node@22 python@3.11
brew install --cask temurin@21          # Java 21 (JDK)

brew services start postgresql@16
```

Python은 **3.11(3.11.5 이상) 또는 3.12**를 권합니다. 고정판 soupsieve 3.0.3이 3.11.5 이상을
요구해, 3.11.0~3.11.4에서는 `-c constraints.txt` 설치가 실패합니다. 3.13에서는 `pandas`/`pykrx` 계열
휠이 아직 준비되지 않아 소스 빌드로 넘어가는 경우가 있습니다.
(확인하지 못한 조합이라 단정하지는 않겠습니다 — 3.11에서 검증했습니다.)

---

## 2. 저장 (clone)

```bash
mkdir -p ~/Projects
git clone https://github.com/Jinyoung-Kang/My_macro_dashboard_v2.git \
  ~/Projects/My_macro_dashboard_v2

cd ~/Projects/My_macro_dashboard_v2
ls          # README.md · docker-compose.yml · Makefile · backend · collector · frontend
```

이미 받아 둔 폴더를 최신으로 맞출 때:

```bash
cd ~/Projects/My_macro_dashboard_v2
make update      # git pull 대신 — 아래 이유를 꼭 읽어 주세요
make up          # 받은 코드로 다시 빌드·기동
```

> **왜 `git pull`이 아닌가.** `git pull`은 *지금 체크아웃된 브랜치*만
> 당깁니다. 이 저장소는 새 작업을 작업용 브랜치(`claude/…`)에 먼저 올리고
> 확인이 끝나면 `main`에 합치므로, `main`에서 `git pull`을 하면 **아무것도
> 받지 않고 조용히 끝나는** 경우가 생깁니다. 그 뒤 `make up`을 해도 새 작업이
> 빠진 코드가 그대로 다시 뜨고, 화면은 멀쩡해 보이는데 고친 것이 하나도 없습니다.
>
> `make update`는 모든 브랜치 정보를 받아 온 뒤, 다른 브랜치에 더 새로운
> 작업이 있으면 이름과 커밋 수를 찍어 줍니다. 그 브랜치로 옮기려면
> `git checkout <브랜치 이름> && make up`입니다.

**지금 돌고 있는 코드가 무엇인지**는 `make version`으로 봅니다. 화면
**왼쪽 아래**에도 같은 값(`main@1e4d3be` 같은 브랜치@커밋)이
적혀 있으니, 고친 기능이 안 보이면 이 값부터 확인하세요.

---

## 3. 준비 (`make setup`)

```bash
make setup
```

이 스크립트가 하는 일:

1. `.env.example`을 복사해 `.env`를 만듭니다 (이미 있으면 건드리지 않습니다)
2. 처음 운영자 계정 값을 확인합니다(ADR 0010)
   - `OWNER_EMAIL`(로그인 아이디로 쓸 이메일)이 비어 있으면 알려 줍니다 — 기본값이 없어 직접 넣어야 합니다
   - `APP_PASSWORD`(처음 비밀번호)가 비었거나 공개된 기본값(`admin1234@`)이면 무작위
     값을 만들어 넣고 **터미널에 한 번 보여 줍니다.** 직접 정한 값은 건드리지 않습니다
   - 계정이 생긴 뒤에는 두 값을 읽지 않습니다. 비밀번호는 화면의 👤 내 계정에서 바꿉니다
3. `COLLECTOR_API_TOKEN`(백엔드→수집기 호출 토큰)이 비어 있으면 무작위 값으로
   채웁니다. 외부 API 키가 아니라 두 컨테이너끼리만 쓰는 값이라 따로 발급받을
   필요가 없습니다. 이미 값이 있으면 그대로 둡니다
4. API 키 보유 현황과 "없을 때 무엇이 꺼지는지"를 알려 줍니다
5. 실행 방법을 확인합니다 — **Docker가 떠 있으면 Java·Maven·Node·psql은
   검사하지 않습니다.** 전부 컨테이너 안에 있어서 맥에 설치할 필요가 없습니다
6. 포트 4개(3000·8080·8000·5432)를 확인합니다. 이미 `make up`으로 이
   프로젝트가 떠 있다면 "이 프로젝트의 컨테이너가 사용 중 (정상)"으로 표시되며,
   **포트를 바꿀 필요가 없습니다**

접속 비밀번호를 기억하기 쉬운 값으로 바꾸고 싶다면 `.env`를 여세요(바꾼 뒤 `make up`).
비밀번호를 바꾸면 그전에 로그인한 세션은 모두 풀립니다.

```bash
open -e .env            # 또는 code .env / vi .env
```

> **`.env` 첫 줄이 `# .env.example …`로 보여도 잘못 저장한 게 아닙니다.**
> `make setup`이 `.env.example`을 복사해 만들기 때문입니다(최신 버전은 복사할 때
> 머리말을 `.env`로 바꿔 줍니다). 실제로 쓰이는 건 주석이 아니라 `KEY=VALUE`
> 줄입니다.
>
> 형식 규칙은 세 가지뿐입니다.
>
> ```ini
> APP_PASSWORD=0000                  # ✅ 줄 맨 앞에서 KEY=VALUE
> APP_PASSWORD="0000"                # ❌ 따옴표까지 비밀번호가 됩니다
> export APP_PASSWORD=0000           # ❌ docker compose는 export를 모릅니다
>   APP_PASSWORD=0000                # ❌ 앞에 공백이 있으면 안 됩니다
> ```
>
> 값 뒤에 **공백 + `#`** 을 붙이면 그 뒤는 주석으로 처리됩니다
> (`APP_PASSWORD=0000 # 내 비번` → 값은 `0000`).
>
> `make setup`을 다시 돌리면 `export`나 들여쓰기가 섞인 줄을 찾아 알려 줍니다
> (기존 `.env`는 덮어쓰지 않습니다).

```ini
OWNER_EMAIL=로그인용_이메일
APP_PASSWORD=원하는_비밀번호
```

### API 키 (없어도 실행됩니다)

| 키 | 발급처 | 없으면 |
|---|---|---|
| `FRED_API_KEY` | <https://fred.stlouisfed.org/docs/api/api_key.html> | 웹 CSV로 폴백 (대부분 정상). 🧪 모의 매매 발표·실적 일정(`us_calendar`)의 FRED 발표일(CPI·PCE·고용·GDP)은 대체 경로가 없어 비고 "키 미설정"으로 표시(FOMC 상수·실적일은 그대로) |
| `KRX_API_KEY` | <http://data.krx.co.kr> | KRX 선물이 KODEX 200 기반 **추정치** |
| `KIS_APP_KEY` / `KIS_APP_SECRET` | <https://apiportal.koreainvestment.com> | 장중 수급 가집계·교차 검증 꺼짐 |
| `LS_APP_KEY` / `LS_APP_SECRET` | LS증권 홈 > 매매시스템 > API | 수급 레이더의 LS 단계만 건너뜀 |
| `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET` | 토스증권 Open API | 토스 테스트 메뉴 + 레이더·국내 파생의 투자자별 매매 카드 + 교차 검증의 토스 3항목이 꺼짐. 토스 개발자 콘솔의 허용 IP에 이 맥의 공인 IP 필요 |
| `ANTHROPIC_API_KEY` (Claude Haiku 5.5) | <https://platform.claude.com> | 자동 탐색이 Claude를 건너뛰고 무료 엔진만 씀. 유료 — 리포트 1건 약 1센트 미만 |
| `NVIDIA_API_KEY` 등 AI 키 | <https://build.nvidia.com> 등 | AI 메뉴만 꺼짐 (Claude 키까지 모두 없을 때) |
| `SEC_USER_AGENT` | 키가 아니라 **본인 이메일** | 13F 수집과 모의 매매 미국 종목 재무(`sec_fundamentals`)가 멈추고, 사건 뉴스의 SEC 보도자료 피드(`sec_press`)만 실패로 남음 (나머지는 정상) |

> **`SEC_USER_AGENT`는 발급받는 키가 아닙니다.** SEC EDGAR는 연락처 없는
> 요청을 차단하므로(정책상 요구사항), 본인 이메일을 그대로 넣으면 됩니다.
> ```ini
> SEC_USER_AGENT=your-name@example.com
> ```
> 이메일만 넣으면 수집기가 `LocalMacroDashboard/2.0 (contact: your-name@example.com)`
> 형태로 감싸서 보냅니다.
>
> 코드에는 예시 이메일조차 두지 않습니다. 남의 주소가 기본값으로 박혀 있으면
> 본인 것을 넣을 이유가 사라지고, SEC 입장에서도 정체를 숨긴 요청이 됩니다.
> 비어 있으면 13F 수집이 `SEC_USER_AGENT가 설정되지 않았습니다`라고 말하며
> 멈춥니다 — 403을 받고 원인을 찾아 헤매는 것보다 낫습니다.

> 키는 모두 `.env` 한 곳에 둡니다. 서비스별 이름:
>
> | 서비스 | `.env` 키 |
> |---|---|
> | FRED | `FRED_API_KEY` |
> | KRX Open API | `KRX_API_KEY` |
> | 한국투자증권 | `KIS_APP_KEY` / `KIS_APP_SECRET` |
> | LS증권 | `LS_APP_KEY` / `LS_APP_SECRET` |
> | 토스증권 | `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET` |
> | SEC EDGAR | `SEC_USER_AGENT` (본인 이메일) |

---

## 4. 실행 (Docker)

```bash
make up
```

최초 실행은 이미지 빌드 때문에 **5~10분** 걸립니다(백엔드 Maven 의존성,
프런트 npm 설치). 이후에는 30초 내외입니다.

| 주소 | 용도 |
|---|---|
| <http://localhost:3002> | 화면 — 로그인 없이 운영자로 열림(이 맥에서만, ADR 0016). 운영자 계정은 `.env`의 `OWNER_EMAIL` + `APP_PASSWORD`로 처음 기동 때 만듦 |
| <http://localhost:8082/api/health> | 백엔드 상태 |
| <http://localhost:8002/docs> | 수집기 API 문서 (FastAPI 자동 생성) |

### 첫 데이터 수집

컨테이너가 떴다고 숫자가 바로 차지는 않습니다. 수집기가 한 번 돌아야 합니다.

```bash
make collect        # 시세·수급 (fast) — 약 1분
make collect-all    # 13F 포함 전체 — 10분 이상, 백그라운드 실행
make status         # 진행 상황
```

그 뒤로는 컨테이너 안의 스케줄러가 **5분 / 1시간 / 12시간** 주기로 알아서
수집합니다.

### 자주 쓰는 명령

```bash
make ps                 # 컨테이너 상태
make logs               # 전체 로그
make logs S=collector   # 수집기 로그만
make down               # 정지 (데이터 보존)
make up                 # 다시 시작
make update             # 최신 코드 받기 (git pull 대신 — §2 참고)
make version            # 지금 돌고 있는 코드의 브랜치·커밋
make backup             # DB 백업 → backups/
```

### 맥 재부팅 후

`restart: unless-stopped`가 걸려 있어 **Docker Desktop이 시작되면 컨테이너도
자동으로 올라옵니다.** Docker Desktop 자체를 로그인 시 자동 실행하려면
설정 → General → "Start Docker Desktop when you sign in"을 켜세요.

---

## 5. 실행 (Docker 없이 — 네이티브)

> ### ⚠️ Docker가 잘 돌고 있다면 이 절은 건너뛰세요.
>
> `make up`으로 컨테이너 네 개가 떠 있다면 **이 절의 작업은 전부 불필요**할
> 뿐 아니라, 같은 포트를 두 번 잡으려다 오히려 고장납니다. 실제로 겪는 오류들:
>
> - `Error: listen EADDRINUSE: address already in use :::3000`
>   → 이미 컨테이너가 3000을 쓰고 있습니다. 네이티브로 또 띄우지 마세요.
> - `zsh: command not found: psql` / `command not found: mvn`
>   → **설치하지 않아도 됩니다.** DB 셸은 `make db`, 백엔드 빌드는 컨테이너가 합니다.
> - `ModuleNotFoundError: No module named 'apscheduler'`
>   → conda base 같은 다른 파이썬으로 실행한 경우입니다. 아래 가상환경 절을 보세요.
>
> 이 절은 **코드를 고치면서 핫 리로드로 보고 싶을 때**만 쓰는 경로입니다.

터미널 4개를 씁니다. 아래 명령은 모두 **저장소 최상위(`~/Projects/My_macro_dashboard_v2`)
에서 새 터미널을 연 상태**를 가정합니다. 이미 하위 폴더에 들어가 있다면
`cd ~/Projects/My_macro_dashboard_v2` 로 먼저 돌아가세요
(`cd frontend`를 프런트 폴더 안에서 또 치면 `no such file or directory`가 납니다).

먼저 DB만 컨테이너로 띄우면 `psql`·`brew services`가 필요 없습니다.

```bash
cd ~/Projects/My_macro_dashboard_v2
make infra      # postgres만 기동 (기본 스키마 자동 적용, 이후 버전은 수집기가 기동할 때 적용)
```

```bash
# --- 터미널 1: 수집기 ---
cd ~/Projects/My_macro_dashboard_v2

# 가상환경을 collector/.venv 에 만듭니다. Makefile도 이 경로를 먼저 찾습니다.
python3.11 -m venv collector/.venv
collector/.venv/bin/pip install -r collector/requirements-dev.txt -c collector/constraints.txt

make dev-collector      # 내부적으로 collector/.venv/bin/python -m uvicorn 실행
```

> `make dev-collector`·`make dev-backend`는 `.env`의 `COLLECTOR_API_TOKEN`(`make setup`이 만듦)을 둘 다에
> 넘기고, DB는 `.env`의 `DATABASE_PORT`로 붙습니다. 토큰이 비어 있으면 수집기는 기동하지 않습니다
> (`COLLECTOR_API_TOKEN이 비어 있습니다`) — `make setup`을 먼저 실행하세요.

> `source .venv/bin/activate` 후 `uvicorn ...`을 직접 치지 마세요. conda나
> pyenv가 PATH 앞에 있으면 **다른 파이썬의 uvicorn**이 잡혀
> `ModuleNotFoundError: No module named 'apscheduler'`가 납니다.
> `.venv/bin/python -m uvicorn` 형태는 PATH와 무관하게 항상 맞는 해석기를 씁니다.

```bash
# --- 터미널 2: 백엔드 (Java 21 필요) ---
cd ~/Projects/My_macro_dashboard_v2
java -version           # 21 이상인지 먼저 확인하세요

# DB 주소(.env의 DATABASE_PORT)와 수집기 토큰(.env의 COLLECTOR_API_TOKEN)은 make가 넘깁니다.
DATABASE_USER="macro" DATABASE_PASSWORD="macro" \
OWNER_EMAIL="로그인용_이메일" APP_PASSWORD="원하는_비밀번호" \
COLLECTOR_URL="http://localhost:8002" \
  make dev-backend
```

> **Java 17로는 빌드되지 않습니다.** `release version 21 not supported`가 나면:
> ```bash
> brew install --cask temurin@21
> export JAVA_HOME=$(/usr/libexec/java_home -v 21)
> java -version     # 21이 나와야 합니다
> ```
> 이 `export`는 터미널을 닫으면 사라집니다. 계속 쓰려면 `~/.zshrc`에 넣으세요.

```bash
# --- 터미널 3: 화면 ---
cd ~/Projects/My_macro_dashboard_v2
npm --prefix frontend install
make dev-frontend
```

> 3000번이 이미 차 있으면(`EADDRINUSE`) 컨테이너 프런트가 떠 있는 것입니다.
> `docker compose stop frontend` 로 그것만 내린 뒤 다시 실행하세요.

### 수집기를 백그라운드 상주로 (launchd)

Docker 없이 쓸 때, 맥이 켜져 있는 동안 수집기가 계속 돌게 하려면 아래 plist를
`~/Library/LaunchAgents/com.local.macro-dashboard.collector.plist`로 저장하고
등록하세요.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.macro-dashboard.collector</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/jinyoung/Projects/My_macro_dashboard_v2/collector/.venv/bin/uvicorn</string>
    <string>app.main:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8000</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/jinyoung/Projects/My_macro_dashboard_v2/collector</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>DATABASE_URL</key>
    <string>postgresql://jinyoung@localhost:5432/macrodash</string>
    <key>COLLECTOR_SCHEDULER</key>
    <string>true</string>
    <!-- 비어 있으면 수집기가 기동하지 않습니다. .env의 같은 값을 넣으세요(백엔드와 같아야 함) -->
    <key>COLLECTOR_API_TOKEN</key>
    <string>.env의_COLLECTOR_API_TOKEN_값</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>

  <key>StandardOutPath</key>
  <string>/Users/jinyoung/Projects/My_macro_dashboard_v2/collector.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/jinyoung/Projects/My_macro_dashboard_v2/collector.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.local.macro-dashboard.collector.plist
tail -f ~/Projects/My_macro_dashboard_v2/collector.log

# 해제
launchctl unload -w ~/Library/LaunchAgents/com.local.macro-dashboard.collector.plist
```

> Docker로 실행 중이라면 이 설정은 필요 없습니다. 컨테이너가 같은 일을 합니다.

---

## 6. 확인 · 테스트

데이터가 안 보일 때는 테스트보다 **진단**이 먼저입니다.

```bash
make doctor     # 컨테이너 → 수집기 → DB → 백엔드 → 화면 순서로 점검
```

`make doctor`는 데이터가 흐르는 순서대로 검사하고, **가장 먼저 고쳐야 할 것
한 가지**를 알려 줍니다. 앞 단계가 막히면 뒤 단계는 반드시 비어 있으므로
여러 곳을 동시에 건드릴 필요가 없습니다. 수집이 실패했다면 그 사유
(예: `CSV HTTP 403 — FRED_API_KEY를 설정하면 …`)까지 함께 출력합니다.

테스트는 다음과 같습니다.

```bash
make test              # 세 언어 전부 (PostgreSQL 필요)
make test-collector    # pytest 129건
make test-backend      # JUnit 83건 (Java 21 · Maven 필요)
make test-frontend     # 자가검증 + 훅 테스트 + 린트 + 빌드 (Node 24 권장 — 이미지·CI와 같은 판, Next 16은 20.9 이상)
make db-test           # 테스트 전용 DB 준비 (위 명령들이 자동으로 부릅니다)
```

`make test`는 `.env`의 `DATABASE_PORT`(이 저장소 기본 5434) PostgreSQL을 씁니다. Docker로 띄운 상태라면
그대로 돌아가고, 아니면 `make infra`로 DB만 먼저 올리세요.

> ⚠️ **테스트는 평소 쓰는 DB(`macrodash`)를 건드리지 않습니다.**
> 백엔드 통합 테스트는 시작할 때마다 `snapshots`를 비웁니다. 그래서 테스트는
> 전용 DB(`macrodash_test`)에서만 돌고, DB 이름이 `_test`로 끝나지 않으면
> 지우기 전에 실행을 거부합니다. `TEST_DATABASE_URL`을 손으로 지정하실 때도
> `macrodash_test`를 쓰세요.

> **`No module named pytest`가 나면** conda base 같은 다른 파이썬이 잡힌
> 것입니다. `collector/.venv`를 만들어 두면 `make test-collector`가 그것을
> 먼저 씁니다.
> ```bash
> python3.11 -m venv collector/.venv
> collector/.venv/bin/pip install -r collector/requirements-dev.txt -c collector/constraints.txt
> ```
>
> **`mvn: command not found`가 나면** `make test-backend`는 로컬 Maven이
> 필요합니다(`brew install maven` + Java 21). 백엔드를 **실행**만 할 거라면
> 설치하지 않아도 됩니다 — 컨테이너가 알아서 빌드합니다.

---

## 7. 맥에서 자주 걸리는 문제

**무엇부터 볼지 모르겠으면 `make doctor` 한 줄이 먼저입니다.**

| 증상 | 원인 / 해결 |
|---|---|
| 폴더 이름을 바꾼 뒤 로그인은 되는데 데이터가 비어 있음 | DB 볼륨 이름이 폴더 이름을 따라가 빈 볼륨이 새로 생겼습니다. 옛 이력은 옛 이름의 볼륨에 그대로 있습니다(`docker volume ls \| grep postgres-data`). `make down` 후 폴더 이름을 되돌리면 예전 데이터로 돌아갑니다. 새 이름으로 옮기는 방법은 §0에 있습니다 |
| `Cannot connect to the Docker daemon` | Docker Desktop이 꺼져 있습니다. `open -a Docker` 후 30초 |
| 포트 5432 충돌 | 맥에 PostgreSQL이 이미 돌고 있습니다. `.env`의 `DATABASE_PORT=5434`(이 저장소 기본)인지 보고 `make up` |
| 포트 3000 충돌 | 다른 개발 서버가 씁니다. `.env`에서 `FRONTEND_PORT=3002`(이 저장소 기본). `FRONTEND_ORIGIN`을 `.env`에 직접 적어 두셨다면 `http://localhost:3001`로 함께 고치거나 그 줄을 지우세요(지우면 포트를 따라감) |
| `Bind for 127.0.0.1:8082 failed: port is already allocated` | 8082를 **다른 컨테이너**가 잡고 있습니다(다른 프로젝트, IDE에서 띄운 Spring Boot 등 — 같은 맥의 v3는 8080이라 겹치지 않음). 나머지는 다 떠서 화면은 "백엔드 API에 연결하지 못했습니다"만 보입니다. `bash scripts/ports.sh check`가 누가 잡았는지 보여 줍니다 → `docker stop <이름>`, 또는 `.env`에서 `BACKEND_PORT=18080` 후 `make up`. 잡은 컨테이너가 없는데도 이 오류가 나면 Docker Desktop을 재시작하세요 |
| 로그인은 되는데 화면이 계속 401 | `127.0.0.1`로 접속했는데 `FRONTEND_ORIGIN`은 `localhost`입니다(또는 반대). 브라우저는 둘을 **다른 오리진**으로 보고 쿠키를 막습니다. 주소를 하나로 통일하세요 |
| 화면은 뜨는데 전부 "데이터 없음" | 아직 수집을 하지 않았습니다. `make collect` |
| `make collect`가 "수집기에 연결하지 못했습니다" | `make logs S=collector`로 기동 여부 확인 |
| 백엔드 빌드가 메모리 부족으로 죽음 | Docker Desktop 메모리를 4GB 이상으로 올리세요 |
| 수집은 성공인데 숫자가 이상함 | `🗄️ 데이터 저장소 상태 → 교차 검증`을 돌려 보세요. 비공식 소스(Daum·Naver·TradingView)의 구조 변경을 먼저 의심합니다 |
| 포트를 바꿨는데 화면이 API를 못 찾음 | 화면은 "열린 호스트 + `BACKEND_PORT`"로 백엔드를 찾고, 포트는 **빌드 시점**에 번들에 들어갑니다. 바꾼 뒤 `make up`(재빌드)이 필요합니다. `.env`에 `NEXT_PUBLIC_API_BASE`(전체 주소 고정, 프록시용)를 적어 두었다면 지우거나 `BACKEND_PORT`와 맞추세요 — `make up`이 기동 전에 검사합니다 |
| `make setup`이 포트 4개를 전부 "사용 중"이라고 함 | **이미 `make up`으로 이 프로젝트가 떠 있는 상태입니다.** 정상입니다. 최신 버전은 "이 프로젝트의 컨테이너가 사용 중 (정상)"으로 구분해 표시합니다 |
| 휴대폰 등 다른 기기에서 화면이 안 열림 | 의도한 동작입니다 — 로컬은 로그인 없이 운영자로 열리므로 화면·API를 이 맥(127.0.0.1)에만 엽니다(ADR 0016). AWS 개인용 서버도 PC의 SSM 터널(`scripts/aws/tunnel.sh`)로만 열려 휴대폰에서는 볼 수 없습니다(ADR 0019) |
| '운영자 계정이 아직 없습니다' 화면 | `.env`의 `OWNER_EMAIL`·`APP_PASSWORD`를 넣고 `make up`. 그래도면 `make migrate`(스키마 미적용)·`make logs S=backend` |
| `make up`이 'LOCAL_NO_LOGIN … 웹 배포용 값' 오류로 멈춤 | 로그인 없는 로컬과 `COOKIE_SECURE=true`·외부 `FRONTEND_ORIGIN`은 함께 쓸 수 없습니다. 그 줄을 지우거나 `LOCAL_NO_LOGIN=false`(로그인 화면) |
| 다른 기기에서 DB(5432)·수집기(8000)에 붙지 못함 | 의도된 제한입니다. 이 둘은 로그인이 없어 `127.0.0.1`에만 열립니다 ([PRINCIPLES.md](PRINCIPLES.md)) |
| `command not found: psql` / `mvn` | Docker로 실행 중이라면 **설치할 필요가 없습니다.** DB 셸은 `make db`를 쓰세요 |
| `No module named pytest` / `apscheduler` | conda·pyenv의 다른 파이썬이 잡혔습니다. `collector/.venv`를 만들고 `make dev-collector` / `make test-collector`를 쓰세요 (§6) |
| `release version 21 not supported` | 로컬 Java가 17입니다. `brew install --cask temurin@21` 후 `export JAVA_HOME=$(/usr/libexec/java_home -v 21)` |
| `EADDRINUSE :::3000` | 컨테이너 프런트가 이미 3000을 쓰고 있습니다. 네이티브로 또 띄우려면 `docker compose stop frontend` 먼저 |
| `make collect`는 성공인데 `make status`가 `0/12 시리즈`처럼 비어 있음 | 수집기는 돌았지만 **외부 소스가 데이터를 주지 않은 것**입니다. 최신 버전은 `(사유: …)`를 함께 출력합니다. `make status` 또는 `make doctor`로 사유를 보세요 |
| 사유가 `CSV HTTP 403` | FRED 웹 CSV가 차단됐습니다. `.env`에 `FRED_API_KEY`를 넣으면 공식 API 경로로 우회합니다(무료 발급) |
| 사유가 `yfinance(…)가 빈 응답을 받았습니다` | yfinance가 오래된 버전이면 Yahoo 응답 변경에 대응하지 못합니다. `make update` 후 `make up`으로 **이미지를 다시 빌드**하세요 |
| **고쳤다는 기능이 화면에 없음** | 그 코드로 빌드되지 않았습니다. 화면 왼쪽 아래 버전과 `make version`을 확인하세요. 새 작업이 다른 브랜치에 있으면 `git pull`은 아무것도 받지 않습니다 — `make update`를 쓰세요 |
| `git push`가 `Permission to … denied to <본인 아이디>` (403) | 맥 키체인의 GitHub 토큰이 만료됐거나 쓰기 권한이 없습니다. 이 저장소는 공개라 **받기(`make update`)는 토큰 없이도 되고** push만 이 토큰을 씁니다 — 토큰 만료이거나 쓰기 권한 문제입니다. `gh auth login && gh auth setup-git`, 또는 `printf "protocol=https\nhost=github.com\n\n" \| git credential-osxkeychain erase` 후 `repo` 권한 토큰으로 다시 push ([DEVELOPMENT.md §5](DEVELOPMENT.md)에 자세히) |
| 13F만 비어 있음 | SEC가 연락처 없는 요청을 막습니다. `.env`에 `SEC_USER_AGENT=본인이메일`을 넣고 `make up` |
| Docker Desktop이 프록시(`http.docker.internal:3128`)를 쓰는 환경 | 회사망·보안 프로그램이 외부 금융 사이트를 막으면 수집이 전부 실패합니다. Docker Desktop → Settings → Resources → Proxies에서 확인하세요 |

---

## 8. 백업

누적 수급 이력(`observations`)은 **외부에서 다시 받을 수 없는 데이터**입니다.
Naver·Daum·KRX가 과거 날짜 조회를 지원하지 않기 때문입니다.

```bash
make backup                              # backups/macrodash-YYYYmmdd-HHMMSS.sql
make restore F=backups/macrodash-….sql   # 복원 (DB 전체를 백업 시점으로 교체)
```

- **백업**은 pg_dump가 끝까지 성공했을 때만 파일을 남깁니다. 실패하면 파일 없이 오류로 끝납니다.
  파일은 소유자만 읽을 수 있고(600 — 개인 데이터), 접두어별로 최근 `BACKUP_KEEP`개(기본 10)만
  남기고 오래된 것은 지웁니다. 더 오래 두려면 `.env`의 `BACKUP_KEEP`을 늘리거나 0으로 두세요.
- **복원**은 지금 DB를 **통째로 백업 시점으로 바꿉니다.** 순서:
  1. 백업 파일이 끝까지 기록된 것인지 확인합니다.
  2. 확인(y)을 받습니다.
  3. 지금 상태를 `backups/pre-restore-….sql`로 먼저 백업합니다.
  4. 수집기·백엔드를 잠시 멈추고 **한 트랜잭션**으로 교체합니다.
  5. 멈췄던 서비스를 다시 켭니다.

  도중에 실패하거나 입력이 끊겨도(창을 닫음·Ctrl-C) 전부 되돌려 DB는 복원 전과 같습니다. 잘못 복원했다면
  `make restore F=backups/pre-restore-….sql`로 되돌리면 됩니다.

Time Machine을 쓴다면 `~/Projects/My_macro_dashboard_v2/backups`가 백업
대상에 포함되는지 확인해 두세요. Docker 볼륨 자체(`postgres-data`)는 Time
Machine이 온전히 담지 못할 수 있어, SQL 덤프를 남기는 편이 안전합니다.
