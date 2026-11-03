# 개발 안내

코드를 고치려는 사람을 위한 문서입니다. **처음 띄우는 방법은
[README](../README.md)** 를 먼저 보세요.

---

## 1. 개발 환경

### Docker 없이 (권장 — 고치면서 바로 확인)

```bash
make setup            # .env가 없을 때 한 번 — 수집기 토큰을 만듭니다(비면 수집기가 기동하지 않음)
make infra            # PostgreSQL만 컨테이너로 띄웁니다

make dev-collector    # 터미널 1 — 자동 리로드 (collector/.venv 필요)
make dev-backend      # 터미널 2
make dev-frontend     # 터미널 3 — 핫 리로드
```

수집기 가상환경이 없으면 만듭니다.

```bash
cd collector
python3.11 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt -c constraints.txt   # 운영 의존성 + 테스트·린트 도구
```

`make`가 `collector/.venv`를 먼저 찾으므로, conda base 같은 다른 파이썬이 PATH
앞에 있어도 올바른 인터프리터를 씁니다.

### 전부 Docker로

```bash
make up          # 코드를 고치면 다시 빌드해야 반영됩니다
make logs S=backend
```

---

## 2. 테스트

```bash
make test              # 세 가지 전부
make test-collector    # ruff(린트) + pytest
make test-backend      # JUnit (실제 PostgreSQL 사용)
make test-frontend     # 자가검증 + 훅 테스트(vitest) + 린트 + 빌드(타입 검사)
```

### 테스트는 전용 DB에서 돕니다

백엔드 통합 테스트는 시작할 때마다 `snapshots` 테이블을 **비웁니다**. 그래서
`macrodash_test`를 씁니다. `make test-*`가 알아서 맞춰 주지만, 직접 실행할 때는
`TEST_DATABASE_URL`을 확인하세요.

```bash
# 직접 실행할 때
cd backend  && TEST_DATABASE_URL=jdbc:postgresql://localhost:5434/macrodash_test mvn test      # 5434 = 이 저장소 .env의 DATABASE_PORT
cd collector && TEST_DATABASE_URL=postgresql://macro:macro@localhost:5434/macrodash_test pytest
```

백엔드에는 `guardAgainstRealDatabase()`가 있어 DB 이름이 `_test`로 끝나지 않으면
테스트가 스스로 멈춥니다.

화면 테스트는 두 가지입니다. 순수 함수는 `src/lib/__checks__/*.check.mts`(`npm run check`,
추가 도구 없음)와 `src/lib/__tests__`, React로 렌더링해야 확인되는 훅·화면 동작은
`src/**/__tests__/*.test.ts(x)`(`npm test`, vitest + Testing Library + jsdom — 개발 의존성이라
운영 이미지에는 없습니다).

### 테스트가 고정하는 것

단순 커버리지가 아니라 **한 번씩 틀렸던 규칙**을 고정합니다.

| 테스트 | 무엇을 막는가 |
|---|---|
| `DatasetsParityTest` | 데이터셋 이름이 Python과 Java에서 갈라지는 것 ("수집은 되는데 화면에 안 보임") |
| `AnalyticsMathTest` | 상관·국면·백테스트 계산이 표본 부족에도 숫자를 만들어내는 것 |
| `GuruAndRiskTest` | 위험 기여의 합이 포트폴리오 변동성과 어긋나는 것 |
| `SectorSeriesAlignmentTest` | 날짜와 종가 배열이 한 칸씩 밀리는 것 |
| `KstTest` | 서버 시간대(UTC) 때문에 날짜가 하루 어긋나는 것 |
| `StoreReaderNonBlockingTest` | 화면이 수집을 기다리게 되는 것 |
| `RouteInventoryTest` | 컨트롤러를 옮기다 경로가 빠지는 것, API.md와 실제 경로가 어긋나는 것 |
| `test_equities.py` | 모르는 종목 이름에 엉뚱한 티커가 붙는 것 |
| `marketCalendar.check.mts` | 공휴일과 거래소 휴장일을 혼동하는 것 |
| `useVisibleWake.test.ts`·`useShownOnce.test.ts`·`paperLive.test.tsx` | 아무도 보지 않는 탭(숨긴 탭·백그라운드로 연 탭)이 장중 시세를 읽어 수집을 깨우는 것(QA-154·156), 장중 카드 시험이 돌린 시각에 따라 갈리는 것(QA-155), 탭 복귀 읽기가 요청한 새 수집을 카드가 다음 간격까지 읽지 않는 것(QA-157·159 — 간격이 있을 때와 끄기), 실패한 한 번 더 읽기가 다음 응답의 새 수집 요청을 소모하는 것(QA-162·163 — 같은 문구로 연달아 실패해도) |
| `paperOverview.test.ts` | 마감 값이 아닌 잠정 줄(마감 + 15분 전 관측을 옮긴 줄·지난 값 보유가 든 줄)이 이전 값 표시 없이 보이는 것(QA-158·160), 한국 관측치 늦음(수집을 놓침)이 순자산 줄 단계에서 사라지는 것(QA-161) |
| `useApi.test.ts` | 자동 갱신 한 번 실패로 화면이 비는 것, 수동 새로고침이 세션 확인까지 다시 돌려 화면 상태가 초기화되는 것, 늦게 온 이전 응답이 화면을 되돌리는 것, 같은 문구로 연달아 실패하면 실패를 한 번씩 받지 못하는 것(`failedAt`, QA-163) |
| `ArchitectureRulesTest` | 계산 패키지가 스프링·JSON을 알게 되는 것, 컨트롤러가 저장소·수집기를 직접 부르는 것, 패키지 사이 순환(기반 패키지 포함, [ADR 0001](adr/0001-feature-modules-and-dependency-rules.md)) |
| `test_db_scripts.py` | 백업·복원이 실패를 성공으로 알리는 것, 복원이 반만 되는 것([ADR 0003](adr/0003-backup-and-restore.md)) |
| `test_vultr_scripts.py` | 서버 배포가 한꺼번에 빌드하거나 실패를 성공으로 알리는 것, 서버 `.env`에 로컬 포트·PC 전용 값이 섞이는 것, 지난 백업을 다시 올리는 것, 방화벽 IP를 바꾸다 비상용 22 규칙이 사라지거나 API 키가 프로세스 인자에 남는 것([ADR 0023](adr/0023-vultr-deployment.md)) |
| `endpoints.test.ts` | 화면이 만든 API 주소가 깨지거나(인코딩) 문서에 없는 경로를 부르는 것 |
| `chartData.test.ts`·`SpreadSection.test.tsx` | 모르는 값을 0으로 채워 막대·변화량을 만드는 것 |

---

## 3. 기능을 하나 붙이기

데이터가 필요한 기능은 **네 계층을 순서대로** 지납니다.

### ① 무엇을 받을지 정의 — `collector/app/indicators.py`

티커·FRED 시리즈·COT 자산·기관 목록이 전부 여기 있습니다. 화면에만 추가하면
"왜 항상 비어 있지?"가 됩니다.

### ② 받아서 저장 — `collector/app/tasks/`(주제에 맞는 모듈) + `registry.py` + `catalog.py`

```python
# catalog.py — 저장본 이름 (백엔드와 같은 문자열이어야 합니다)
SNAP_MY_THING = "domain.my_thing"

# tasks/series.py 등 주제에 맞는 모듈
def task_my_thing() -> str:
    payload = my_service.collect(...)
    if not payload:
        raise EmptyResult("0건 — 기존 저장본 유지")   # 빈 결과로 덮지 않습니다
    store.put_snapshot(catalog.SNAP_MY_THING, payload)
    return "N건 수집"

# tasks/registry.py
ALL_TASKS = (..., Task("my_thing", "slow", task_my_thing, "설명"),)
```

`store.py`의 기대 목록(`expected`)에도 추가하면 `make status`에 나타납니다.

### ③ 계산 — `backend/.../analytics/`

**순수 함수로 작성하고 테스트를 여기에 붙입니다.** 저장소나 스프링에 의존하지
않게 두면 테스트가 빠르고 규칙이 분명해집니다.

```java
public final class MyMath {
    /** 설명. 표본이 부족하면 null (0으로 채우지 않습니다). */
    public static Double compute(List<Double> values) { ... }
}
```

### ④ 응답 조립 — `backend/.../feature/<기능>/` 서비스 + 컨트롤러

`Datasets.java`에 ②에서 정한 이름을 **똑같이** 적습니다.

```java
// Datasets.java
public static final String SNAP_MY_THING = "domain.my_thing";
```

`DatasetsParityTest`가 실제로 `catalog.py`를 읽어 대조하므로, 한쪽만 고치면
빌드가 깨집니다.

응답에는 신선도를 반드시 넣습니다.

```java
snapshot.get().putFreshness(out);   // collectedAtKst · ageSeconds · stale
```

엔드포인트는 메뉴에 맞는 기능 패키지의 컨트롤러에 붙입니다(`feature/macro/MacroController`·
`feature/institution/InstitutionController`·`feature/positioning/PositioningController`·
`feature/insight/AnalyticsController`·`feature/status/StatusController`, 출처가 따로인 것은
`FlowsController`·`PublicDataController`·`feature/toss/TossController`). 경로를 추가하면
`RouteInventoryTest`의 목록과 [API.md](API.md) 표에도 적어야 빌드가 통과합니다.
컨트롤러 하나가 서비스를 5개보다 많이 받으면 같은 테스트가 실패하니, 그때는 나눕니다.

### ⑤ 화면 — `frontend/src/…`

주소는 `lib/endpoints.ts`에 함수로 추가하고(테스트 CASES에도 한 줄), `useApi` 훅으로 읽습니다(브라우저에서 —
서버 컴포넌트 fetch는 쓰지 않음, [ARCHITECTURE §4-3](ARCHITECTURE.md)).
버튼으로 서버를 부르면 `useAsyncAction`, 데이터 가공은 `lib/`의 순수 함수로 두고 테스트합니다
([ADR 0004](adr/0004-frontend-layering.md)). 값이 없으면 `EMPTY`(`—`)로 그립니다 — 0으로 채우지
않습니다. 빈값·추정·이전 값 배지·출처 줄은 `components/patterns`가 그리므로 새 화면은 패턴을 씁니다.

**메뉴 추가**는 `lib/nav.ts`의 `TABS`에 한 줄입니다 — 왼쪽 내비·하단 탭·하위 메뉴 줄·브라우저 탭 제목·통합 검색이 이 표 하나를
씁니다. 운영자 전용·유료 화면이면 `lib/access.ts`의 `OWNER_ONLY_MENUS`·`PRO_MENUS`에도 넣습니다(경로 앞부분 일치라 그 아래
주소까지 함께 걸림). `nav.test.ts`·`access.test.ts`가 탭 표와 보이는 범위를 고정합니다. 새 API 경로는 백엔드 `AccessPolicy` 표에도(ADR 0010).

```
frontend/src/
├── app/(dashboard)/<경로>/page.tsx  라우트 — 새 화면은 screens 컴포넌트를 그리기만. 옛 화면(4단계에 옮김)은 섹션 파일까지 여기
├── components/ui/                 기본 조각(index.tsx) + Radix 감싼 Dialog·ConfirmDialog·Toast(하위 경로로 가져옴, 배럴에 넣지 않음)
├── components/patterns/           화면 패턴(AssetRow·Hero·StatTile·DataTable·배지·Empty…) — `@/components/patterns` 배럴로만
├── components/charts/             Recharts 래퍼 — 화면은 `@/components/charts`(index.tsx)에서만 가져옴
├── components/shell/              셸(왼쪽 내비·상단바·하위 메뉴 줄·하단 탭·검색·계정·테마·빌드 정보)
├── components/screens/<탭>/       새 화면 조립(home·paper)
├── hooks/                         useApi·useAsyncAction·useTheme·새로고침 신호 …
└── lib/                           순수 함수 — 서식·거래소 달력, 메뉴 표(nav)·검색 색인(search)·테마(theme), 화면 모델(home·paperOverview·patterns…)
```

화면 테스트 규칙:
- 테스트 파일은 `src/**/__tests__/**/*.test.{ts,tsx}`에만 둡니다(밖에 두면 vitest가 조용히 건너뜀). 파일마다 `afterEach(() => cleanup())`.
- `vitest.setup.ts`(모든 테스트 앞)는 jsdom에 없는 `matchMedia`·`ResizeObserver`·`scrollIntoView`·포인터 캡처의 "아무 일도 안 함" 스텁만
  둡니다(Radix·테마 훅용, 이미 있으면 덮지 않음). 동작을 봐야 하는 테스트는 그 안에서 `vi.stubGlobal`·prototype 대입으로 덮어씁니다.
- **네 상태**: 새 패턴은 값 있음·값 없음·추정·오래됨 렌더링 테스트를, 새 화면은 데이터 없음·일부 실패·추정·오래됨을 고정 응답으로
  보는 테스트를 갖습니다(예: `HomeScreen.test.tsx`·`paperOverviewStates.test.tsx`). 패턴 파일을 더하면 배럴과
  `patterns/__tests__/index.test.ts`의 목록에 함께 넣습니다(빠지면 그 테스트가 막음).
- **차트 mock**: 화면 테스트의 `vi.mock("@/components/charts")`는 내보내는 이름의 부분집합입니다. 화면이 charts의 새 이름(예:
  `LineChart`)을 쓰기 시작하면 그 화면을 그리는 테스트들의 mock에 이름을 더합니다. 하위 경로(`@/components/charts/LineChart`)로
  가져오면 mock이 걸리지 않으므로 화면은 늘 `@/components/charts`에서 가져옵니다. `@/lib/api`·`next/navigation` mock도 부분집합이라 같습니다.

---

## 4. 코드 규약

### 주석

```java
/**
 * 무엇을 하는가 (한 줄).
 *
 * <p>왜 이렇게 했는가 — 코드만 봐서는 알 수 없는 배경. 특히 "직관적인 방법을
 * 쓰지 않은 이유"를 적습니다.
 *
 * @param x 의미와 단위
 * @return  값의 의미. 언제 null인지
 */
```

- 코드를 그대로 옮긴 주석(`// i를 1 증가`)은 쓰지 않습니다.
- **값이 없을 때의 동작**은 반드시 적습니다 (이 프로젝트에서 가장 자주 틀리는 곳).
- 단위(%, %p, 조 달러, 억 원)를 적습니다.

### 숫자를 다룰 때

- 표본이 부족하면 `null`을 돌려주고 화면은 `—`로 그립니다. **0으로 채우지
  않습니다.**
- 추정치·대용값은 `isEstimated` / `isProxy` 플래그를 함께 내려보냅니다.
- 금액은 조·억 단위로 통일합니다 (`lib/format.ts`, `SnapshotTextService`).

### 파일이 커질 때

- 한꺼번에 나누지 않고, **고치러 들어간 파일**에서 그 부분만 떼어 냅니다. 옮길 때는
  동작을 바꾸지 않습니다(옮기는 커밋과 고치는 커밋을 나눕니다).
- 화면: 메뉴 페이지의 섹션은 같은 폴더의 파일로 둡니다 — 예: `macro/SpreadSection.tsx`,
  `radar/FlowPanels.tsx`. `page.tsx`에는 데이터 조회와 배치만 남깁니다(옛 화면 기준 — 새 화면의 섹션은 `components/screens/<탭>/`).
- 수집기: 태스크가 부르는 가공 단계는 별도 모듈로 둡니다 — 예: `macro_cards.py`
  (매크로 카드 보정). `tasks/`에는 "받아서 저장"만 남깁니다. 태스크는 주제별 모듈(`markets`·`series`·`filings`·
  `korea_public`·`toss`·`maintenance`)에, 목록은 `registry.py`, 실행·합치기·시간 상한은 `runner.py`에 둡니다.
  테스트가 모듈 전역(`store`·상수)을 바꿔 끼울 때는 그 이름을 실제로 쓰는 모듈(`tasks.toss` 등)을 대상으로 합니다.
- 아직 큰 파일(600줄 이상): `lib/types.ts`, `services/radar.py`, `store.py`,
  `components/charts/index.tsx`, `radar/page.tsx`. 다음에 손댈 때 같은 방식으로 나눕니다.

자세한 규칙은 [PRINCIPLES.md](PRINCIPLES.md)에 있습니다.

---

## 4-1. 수집기 의존성 바꾸기

`requirements.txt`는 직접 의존성만 고정하고, 간접 의존성(starlette·pydantic·urllib3 …)은 `constraints.txt`가
고정합니다. 이미지·CI는 둘을 함께 써서(`-c constraints.txt`) 같은 커밋이면 언제 빌드해도 같은 판을 받습니다.
`requirements.txt`를 바꾸면 `make constraints`로 다시 만들고 함께 커밋합니다 — 그대로 두면 판이 어긋나 설치가 실패합니다.

## 5. Git

### 최신 코드 받기

```bash
make update && make up
```

`git pull`을 쓰지 마세요. 새 작업이 다른 브랜치에 있으면 아무것도 받지 않고
조용히 끝납니다. `make update`는 그 경우를 알려 줍니다.

### 브랜치 정리

```bash
git checkout main
git merge --ff-only origin/claude/<브랜치>
git push origin main
git push origin --delete claude/<브랜치>
git remote prune origin
```

### Git 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `git push`가 `Permission to … denied` (403) | 저장소 권한이 아니라 **맥에 저장된 GitHub 토큰**이 만료됐거나 쓰기 권한이 없습니다. 이 저장소는 공개라 받기(`make update`)는 토큰 없이도 되고 push만 이 토큰을 씁니다 — 토큰 만료이거나 쓰기 권한(Contents: Read and write) 문제입니다. 아래 순서로 해결 |
| `refusing to allow a Personal Access Token to … workflow` | `.github/workflows/`를 고친 경우입니다. 토큰 설정에서 `workflow` 권한만 체크하면 됩니다 |
| `Permission denied (publickey)` | 원격이 SSH인데 키가 없습니다. `git remote -v` 확인 후 HTTPS로 변경 |
| `make update`가 `수정 중인 파일이 있어 당기지 않았습니다` | `git status` 확인 후 `git restore <파일>`(버리기) 또는 `git stash`(보관) |
| `make update`가 `받지 못했습니다` + `untracked working tree files would be overwritten` | 받는 코드가 새로 만드는 파일과 같은 이름의, git이 추적하지 않는 파일이 이 폴더에 있습니다. 출력에 나온 파일을 다른 곳으로 옮기거나 지운 뒤 다시 `make update` |
| push는 안 되는데 코드는 최신 | 정상입니다. 받기와 올리기는 별개입니다. 화면 왼쪽 아래 버전이 최신이면 돌고 있는 코드는 최신이 맞습니다 |

**403 해결 순서**

```bash
# 1. 키체인의 낡은 값 삭제
printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain erase

# 2. GitHub Settings → Developer settings → Personal access tokens
#    classic + repo 권한  (또는 fine-grained + 이 저장소의 Contents: Read and write)

# 3. 다시 push — 비밀번호 칸에 토큰을 붙여넣습니다
git push origin main

# 4. 사용자 이름을 매번 치지 않으려면
git config credential.https://github.com.username <아이디>
```

---

## 6. 자주 하는 실수

| 실수 | 증상 | 막는 장치 |
|---|---|---|
| `catalog.py`만 고치고 `Datasets.java`를 안 고침 | 수집은 되는데 화면에 안 보임 | `DatasetsParityTest` |
| 표본이 부족한데 0을 돌려줌 | 화면에 "0.00%"가 보합으로 읽힘 | 계산 테스트 |
| 운영 DB로 테스트 실행 | 수집한 데이터가 전부 사라짐 | `guardAgainstRealDatabase()` |
| `LocalDate.now()` 사용 | KST 00~09시에 날짜가 하루 어긋남 | `Kst.today()`를 쓰세요 |
| 화면에서 직접 외부 API 호출 | 오프라인에서 깨지고 출처 추적 불가 | 백엔드를 거치세요 |
| 값 배열과 날짜 배열을 따로 필터링 | 인덱스가 밀려 조용히 틀린 수익률 | `SectorSeriesAlignmentTest` |

---

## 7. Vultr 서버

운영본입니다(2026-11-03 02:30 KST에 AWS EC2([ADR 0019](adr/0019-aws-personal-deployment.md))에서 옮김, AWS 자원은 같은 날 삭제) — Vultr 서울 `my-macro-app`(vhf-2c-4gb, 24시간). 구성과 이유는 [ADR 0023](adr/0023-vultr-deployment.md), 작업 목록과 사용자 결정은
[Vultr 이전 명세](specs/2026-11-02-vultr-migration.md)에 있습니다. 모의 매매 정기 작업은 이 서버 한 곳에서만 돕니다(로컬 `.env`는 `PAPER_ENABLED=false`).
아래의 `<tailnet>`·`<서버 IP>`·`<버킷>`은 계정 고유 값입니다 — PC `.env`의 `TAILNET_DOMAIN`·`VULTR_SERVER_IP`, 서버 `.env`의 `AWS_BACKUP_BUCKET`.

### 접속 (Tailscale)

- 서버·PC·휴대폰이 같은 tailnet에 있습니다. 화면은 `https://my-macro-app.<tailnet>.ts.net` — 서버 `.env`의 `TAILNET_OWNER_LOGIN`과 같은 Tailscale 사용자면 로그인 없이
  운영자로 열리고(ADR 0023 결정 10), 비었거나 다른 사용자·비상용 포워딩이면 운영자 계정 `OWNER_EMAIL`로 로그인합니다. 서버의 `tailscale serve`가
  HTTPS(Tailscale이 받는 인증서)를 끝내고 `127.0.0.1:8201`의 caddy로 넘깁니다. 공개 인터넷에 열린 TCP 포트는 없습니다(잠금화면도 없음).
- 셸: `ssh ubuntu@my-macro-app`(Tailscale SSH). WSL처럼 MagicDNS 이름에 저장된 호스트 키가 없으면 tailnet 주소(`getent hosts my-macro-app`)로 붙습니다.
- 비상용(Tailscale이 막혔을 때): `ssh -i ~/.ssh/id_ed25519_vultr ubuntu@<서버 IP>` — 방화벽 22는 PC 공인 IP/32만. 화면은 같은 명령에
  `-L 8201:127.0.0.1:8201`을 붙여 <http://localhost:8201>. 둘 다 막히면 Vultr 콘솔의 웹 콘솔.
- PC 공인 IP가 바뀌면: Vultr 콘솔(Account → API → Access Control)에서 API 키의 허용 IP를 먼저 고친 뒤 `bash scripts/vultr/firewall-pc-ip.sh`
  (22 규칙을 지금 IP/32로 — 새 규칙을 넣은 뒤 옛 규칙을 지움). 상태·주소는 `bash scripts/vultr/instance.sh status`.

### 서버 만들기 (처음 한 번 — 2026-11-02·03에 끝남)

명세 §0에 적은 순서입니다. 인스턴스(cloud-init = `scripts/vultr/bootstrap.sh`) → 방화벽 그룹(22/tcp PC IP/32, 41641/udp v4·v6) → Tailscale
(`scp scripts/vultr/tailscale-up.sh root@<서버 IP>:/root/` 뒤 `printf '%s\n' "$TAILSCALE_AUTH_KEY" | ssh root@<서버 IP> bash /root/tailscale-up.sh` — 키는 stdin) →
GitHub 읽기 전용 배포 키(서버 ubuntu `~/.ssh/id_ed25519_github`, `~/.ssh/config` Host `github-v2`) → 백업용 IAM 사용자 키(서버 ubuntu `~/.aws/credentials`, 600).
토스 허용 IP에 서버 IP를 등록합니다.

### 서버 .env 전달

서버 `.env` = 로컬 `.env` − 적지 않는 이름 + 서버 전용 줄([.env.vultr.example](../.env.vultr.example)). 값은 화면·로그에 찍지 않습니다.

```bash
# PC — 걸러 낸 사본을 만들어 Tailscale SSH의 stdin으로 보내고(처음부터 600 — 서버에서 파일이 잠깐이라도 남에게 읽히지 않게) 지웁니다. <버킷>은 백업 버킷 이름
tmp="$(mktemp)" && grep -Ev '^[[:space:]]*(export[[:space:]]+)?(DATABASE_PORT|BACKEND_PORT|COLLECTOR_PORT|FRONTEND_PORT|COOKIE_SECURE|LOCAL_NO_LOGIN|FRONTEND_ORIGIN|PUBLIC_URL|AWS_INSTANCE_ID|PAPER_ENABLED|ORIGIN_SECRET|GATE_[A-Z_]*|VULTR_[A-Z_]*|TAILSCALE_[A-Z_]*|TAILNET_DOMAIN)=' .env > "$tmp" \
  && printf '\nCOMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=%s\nPUBLIC_ORIGIN=https://my-macro-app.%s\nPAPER_KR_START_DATE=2026-10-30\n' "<버킷>" "$(grep '^TAILNET_DOMAIN=' .env | cut -d= -f2-)" >> "$tmp" \
  && ssh ubuntu@my-macro-app 'umask 077 && cat > My_macro_dashboard_v2/.env && chmod 600 My_macro_dashboard_v2/.env' < "$tmp"; rm -f "$tmp"
```

- 로컬 `.env` 끝 줄에 줄바꿈이 없을 수 있어 덧붙이는 줄은 `\n`으로 시작합니다.
- 로컬 `.env`의 `PAPER_ENABLED=false`는 거르고 다시 넣지 않습니다(서버는 비우면 켜짐). `PAPER_KR_START_DATE`는 로컬 `.env`에 없어 덧붙입니다(한국 출발일 —
  빠지면 한국 초기화·출발이 막힘).
- 다시 전달하면 서버 `.env`를 통째로 덮어씁니다. 서버에만 적은 줄(`TAILNET_OWNER_LOGIN`·`COOKIE_SECURE=false` 등)은 다시 덧붙입니다.
- `TAILNET_OWNER_LOGIN`은 운영자의 Tailscale 로그인 이름입니다(계정 고유 값 — 서버 `.env`에만). 값을 화면에 찍지 않고 서버에서 덧붙입니다:
  `v="$(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])')" && printf '\nTAILNET_OWNER_LOGIN=%s\n' "$v" >> ~/My_macro_dashboard_v2/.env`
  (서버를 운영자 계정으로 tailnet에 넣었을 때 — 태그 기기면 PC에서 같은 명령으로 읽음) 뒤 `bash scripts/vultr/deploy.sh`. 로그에는 켜졌다는 경고 한 줄만 남습니다(값은 남기지 않음).

### 배포

```bash
git clone git@github-v2:Jinyoung-Kang/My_macro_dashboard_v2.git ~/My_macro_dashboard_v2   # 서버(ubuntu), 처음 한 번 — 폴더 이름 고정
bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh
```

- 순서: main fast-forward → 버전 → backend → frontend → collector 하나씩 빌드(4 GB) → 기동 → 스키마 → caddy 다시 만들기 → 정리.
  서버 `.env`에 적지 않는 이름(옛 AWS 공개 주소용 값·PC 전용 `VULTR_*`·`TAILSCALE_*` 포함)이 있으면 멈추고,
  `PAPER_ENABLED=false`가 없으면 '주의'를 찍고 계속합니다(컷오버 뒤에는 그것이 맞음).
- 데이터 복원: `aws s3 ls s3://<버킷>/db/vultr/` → `aws s3 cp s3://<버킷>/db/vultr/<파일>.sql backups/` → `make restore F=backups/<파일>.sql`.
  AWS 운영본의 마지막 덤프(2026-11-03 02:28 KST)는 만료 없는 `archive/aws-final/`에 있습니다 — 서버의 IAM 사용자는 `db/`만 읽으므로 PC에서 받습니다.

### 백업 (cron)

```bash
# 서버(ubuntu) — AWS와 같은 시각: 매일 21:45 UTC(06:45 KST)와 일요일 14:00 UTC(23:00 KST). 서버 시간대는 UTC
(crontab -l 2>/dev/null | grep -v 'scripts/vultr/backup-s3.sh'; echo '45 21 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh'; echo '0 14 * * 0 /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh') | crontab -
journalctl -t my-macro-backup --since yesterday       # 결과(실패는 err)
```

올라가는 곳은 백업 버킷의 `db/vultr/`(60일 만료는 `db/` 접두어의 수명주기 — 2026-11-03에 버킷 전체에서 좁힘, `archive/`는 만료 없음)입니다. 서버의 IAM 사용자는 `db/vultr/`에만 쓰고 `db/`는 읽기만 합니다.

### 날마다 볼 것

백엔드 ERROR(`make logs S=backend`), 수집 누락(`make status`), 메모리(`free -h`)·디스크(`deploy.sh` 끝, 128 GB), 백업(`journalctl -t my-macro-backup`),
`tailscale status`에서 PC·휴대폰과 직접 연결인지(relay가 아님). AWS 예산 `my-macro-monthly-45usd`(계정 전체 — my-macro 자원으로 남은 것은 백업 버킷뿐).
