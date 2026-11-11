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

Yahoo(yfinance)를 늘 부르는 태스크는 `Task(..., yahoo=True)`로 표시합니다 — 따로 둔 작업 스레드에서 돌아, Yahoo가 응답하지 않을 때
다른 태스크의 작업 스레드를 차지하지 않습니다(QA-255). `yf.download`에는 `session=yahoo.session()`을 넘깁니다(넘기지 않으면 yfinance가
태스크 예산을 보는 세션을 새 기본 세션으로 바꿈). 두 규약은 `collector/tests/test_yahoo_budget.py`가 확인합니다.

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
다시 만들면 다른 간접 의존성도 그날 판으로 움직입니다. 이미 `constraints.txt`에 고정된 패키지를 같은 판으로 직접 의존성에 올리기만 할 때는 다시 만들지 않고,
`constraints.txt` 머리말에 그 사실을 한 줄 적습니다(2026-11-05 `curl_cffi` 선례).

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
| `git push`가 `Permission to … denied` (403) | 저장소 권한이 아니라 **이 PC의 gh CLI에 저장된 GitHub 토큰**(git은 `gh auth git-credential`로 받음)이 만료됐거나 쓰기 권한이 없습니다. 이 저장소는 공개라 받기(`make update`)는 토큰 없이도 되고 push만 이 토큰을 씁니다 — 토큰 만료이거나 쓰기 권한(Contents: Read and write) 문제입니다. 아래 순서로 해결 |
| `refusing to allow a Personal Access Token to … workflow` | `.github/workflows/`를 고친 경우입니다. `gh auth refresh -h github.com -s workflow`로 토큰에 `workflow` 권한만 더하면 됩니다 |
| `Permission denied (publickey)` | 원격이 SSH인데 키가 없습니다. `git remote -v` 확인 후 HTTPS로 변경 |
| `make update`가 `수정 중인 파일이 있어 당기지 않았습니다` | `git status` 확인 후 `git restore <파일>`(버리기) 또는 `git stash`(보관) |
| `make update`가 `받지 못했습니다` + `untracked working tree files would be overwritten` | 받는 코드가 새로 만드는 파일과 같은 이름의, git이 추적하지 않는 파일이 이 폴더에 있습니다. 출력에 나온 파일을 다른 곳으로 옮기거나 지운 뒤 다시 `make update` |
| push는 안 되는데 코드는 최신 | 정상입니다. 받기와 올리기는 별개입니다. 화면 왼쪽 아래 버전이 최신이면 돌고 있는 코드는 최신이 맞습니다 |

**403 해결 순서**

```bash
# 1. 로그인 상태와 토큰 권한(repo·workflow) 확인
gh auth status

# 2. 만료됐거나 권한이 모자라면 다시 로그인(브라우저 또는 코드 입력)
gh auth login -h github.com -p https -s repo,workflow

# 3. git이 gh의 토큰을 쓰게(처음 한 번 — ~/.gitconfig에 credential.https://github.com.helper가 생김)
gh auth setup-git

# 4. 다시 push
git push origin main
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

서버 `.env` = 로컬 `.env`에서 옮기는 줄 + 서버에만 있는 줄([.env.vultr.example](../.env.vultr.example)). 다시 전달할 때 서버에만 있는 줄은 PC를 거치지 않고
서버의 지금 `.env`에서 그대로 이어 붙입니다(OPS-1) — 토스 키(`TOSS_CLIENT_ID`·`TOSS_CLIENT_SECRET`)는 서버 밖에 두지 않고(아래 '실제 매매 켜기' 점검표),
텔레그램·Tailscale 신원·토스 스위치·실제 매매 여섯 줄·브라우저 비밀도 서버에서만 정한 값이기 때문입니다. 값은 화면·로그에 찍지 않습니다.

```bash
# PC(저장소 최상위) — 로컬에서 옮길 줄만 걸러(서버에 적지 않는 이름과 서버 전용 이름을 모두 뺌) Tailscale SSH의 stdin으로 보내고 지웁니다.
# 서버는 지금 .env를 .env.bak-<UTC 시각>(600)으로 떠 둔 뒤, 받은 줄 뒤에 지금 .env의 서버 전용 줄을 그대로 붙여 한 번에 바꿉니다(mv).
tmp="$(mktemp)" && grep -Ev '^[[:space:]]*(export[[:space:]]+)?(DATABASE_PORT|BACKEND_PORT|COLLECTOR_PORT|FRONTEND_PORT|LOCAL_NO_LOGIN|FRONTEND_ORIGIN|PUBLIC_URL|AWS_INSTANCE_ID|ORIGIN_SECRET|GATE_[A-Z0-9_]*|VULTR_[A-Z0-9_]*|TAILSCALE_[A-Z0-9_]*|TAILNET_DOMAIN|COMPOSE_FILE|AWS_BACKUP_BUCKET|PUBLIC_ORIGIN|PAPER_KR_START_DATE|PAPER_ENABLED|COOKIE_SECURE|TAILNET_OWNER_LOGIN|TELEGRAM_[A-Z0-9_]*|TOSS_CLIENT_ID|TOSS_CLIENT_SECRET|TOSS_ACCOUNT_ENABLED|TOSS_TRADING_[A-Z0-9_]*|REAL_TRADE_ENABLED|BROWSER_[A-Z0-9_]*|POLITE_FETCH_ENABLED)=' .env > "$tmp" \
  && ssh ubuntu@my-macro-app 'set -eu; cd ~/My_macro_dashboard_v2; [ -f .env ] || { echo "✗ 서버 .env가 없습니다 — 처음 한 번은 아래 뼈대부터 만듭니다" >&2; exit 1; }
umask 077; b=".env.bak-$(date -u +%Y%m%d-%H%M%S)"; cp -p .env "$b"; cat > .env.new; printf "\n" >> .env.new
grep -E "^[[:space:]]*(export[[:space:]]+)?(COMPOSE_FILE|AWS_BACKUP_BUCKET|PUBLIC_ORIGIN|PAPER_KR_START_DATE|PAPER_ENABLED|COOKIE_SECURE|TAILNET_OWNER_LOGIN|TELEGRAM_[A-Z0-9_]*|TOSS_CLIENT_ID|TOSS_CLIENT_SECRET|TOSS_ACCOUNT_ENABLED|TOSS_TRADING_[A-Z0-9_]*|REAL_TRADE_ENABLED|BROWSER_[A-Z0-9_]*|POLITE_FETCH_ENABLED)=" .env >> .env.new || true
gone=; for n in $(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p" .env | sort -u); do grep -Eq "^[[:space:]]*(export[[:space:]]+)?$n=" .env.new || gone="$gone $n"; done
chmod 600 .env.new && mv .env.new .env && echo "✓ 서버 .env를 바꿨습니다(이전 판 $b — 배포를 확인한 뒤 지움)"
[ -z "$gone" ] || echo "경고: 새 .env에 없는 이름:$gone — 서버에만 둔 줄이면 $b에서 그 줄을 다시 붙입니다"' < "$tmp"; rm -f "$tmp"
```

```bash
# 처음 한 번(서버에 .env가 없을 때)만 — 서버 전용 줄의 뼈대를 만든 뒤 위 명령을 돌립니다. <버킷>은 백업 버킷 이름
printf 'COMPOSE_FILE=docker-compose.yml:compose.vultr.yml\nAWS_BACKUP_BUCKET=%s\nPUBLIC_ORIGIN=https://my-macro-app.%s\nPAPER_KR_START_DATE=2026-10-30\n' "<버킷>" "$(grep '^TAILNET_DOMAIN=' .env | cut -d= -f2-)" \
  | ssh ubuntu@my-macro-app 'set -eu; cd ~/My_macro_dashboard_v2; [ ! -e .env ]; umask 077; cat > .env'
```

- PC가 거르는 이름은 두 갈래입니다. **서버에 적지 않는 이름**(포트 네 줄·`LOCAL_NO_LOGIN`·`FRONTEND_ORIGIN`·`PUBLIC_URL`·옛 AWS 공개 주소용 값·PC 전용 `AWS_INSTANCE_ID`·`VULTR_*`·
  `TAILSCALE_*`·`TAILNET_DOMAIN` — `deploy.sh`가 막는 이름)과 **서버 전용 이름** — `COMPOSE_FILE`·`AWS_BACKUP_BUCKET`·`PUBLIC_ORIGIN`·`PAPER_KR_START_DATE`(한국 출발일),
  `PAPER_ENABLED`·`COOKIE_SECURE`(로컬의 `false`는 옮기지 않음 — 서버는 비우면 켜짐·Secure, 정비 때 서버에서 일부러 적은 값은 그대로 남음),
  `TAILNET_OWNER_LOGIN`·`TELEGRAM_*`, 토스 키 `TOSS_CLIENT_ID`·`TOSS_CLIENT_SECRET`, `TOSS_ACCOUNT_ENABLED`, 실제 매매 여섯 줄 `TOSS_TRADING_*`·`REAL_TRADE_ENABLED`, `BROWSER_*`, `POLITE_FETCH_ENABLED`(차단 통과 수집 멈춤 — ADR 0035).
  서버 전용 이름은 서버의 지금 값을 그대로 이어 붙이므로, 실제 매매를 켠 채 다시 전달해도 서버 스위치·한도·토스 키가 그대로입니다
  (예전 절차는 서버 `.env`를 통째로 덮어써, 로컬의 빈 줄 때문에 토스 키가 빈 값이 되면 수집기가 알림 없이 키 없음(`not-configured`)으로 주문 전에 막힐 수 있었음).
- 텔레그램 봇은 네 개입니다(2026-11-08) — 운영 `TELEGRAM_BOT_TOKEN`, 미국 모의 `TELEGRAM_US_BOT_TOKEN`, 한국 모의 `TELEGRAM_KR_BOT_TOKEN`, 실제 계좌·ISA `TELEGRAM_ACCOUNT_BOT_TOKEN`. 대화방은 `TELEGRAM_CHAT_ID` 하나를 함께 쓰고, 토큰이 빈 알림은 운영 봇으로 갑니다. 새 봇은 텔레그램에서 시작(Start)을 눌러 둬야 메시지를 받습니다.
- 서버 전용 이름을 새로 만들면 위 두 목록(PC의 `grep -Ev`, 서버의 `grep -E`)에 같이 더합니다. 지금 `.env`에 있던 이름이 새 `.env`에서 빠지면 이름만 '경고'로 찍습니다 —
  서버에만 둔 줄이면 백업에서 그 줄을 다시 붙입니다. 로컬 `.env` 끝 줄에 줄바꿈이 없어도 서버가 줄바꿈을 하나 넣고 이어 붙입니다.
- 바꾼 값은 다시 배포해야 컨테이너에 들어갑니다(`bash scripts/vultr/deploy.sh` — 실제 매매가 꺼져 있지 않으면 한국 거래 창 밖에서). 백업 `.env.bak-*`에는 비밀값이 있어
  배포를 확인한 뒤 지웁니다(`rm ~/My_macro_dashboard_v2/.env.bak-*`).
- `TAILNET_OWNER_LOGIN`은 운영자의 Tailscale 로그인 이름입니다(계정 고유 값 — 서버 `.env`에만). 값을 화면에 찍지 않고 서버에서 덧붙입니다:
  `v="$(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["User"][str(d["Self"]["UserID"])]["LoginName"])')" && printf '\nTAILNET_OWNER_LOGIN=%s\n' "$v" >> ~/My_macro_dashboard_v2/.env`
  (서버를 운영자 계정으로 tailnet에 넣었을 때 — 태그 기기면 PC에서 같은 명령으로 읽음) 뒤 `bash scripts/vultr/deploy.sh`. 로그에는 켜졌다는 경고 한 줄만 남습니다(값은 남기지 않음).

### 브라우저 컨테이너 켜기 (차단 통과 수집 계층의 계층 2 — ADR 0026)

브라우저 컨테이너(`browser`)는 배포하면 늘 뜨지만, 서버 `.env`에 주소와 공유 비밀이 둘 다 있을 때만 수집기가 부릅니다. 비밀은 서버에서만 만듭니다(값을 화면에 찍지 않음).

```bash
# 서버(ubuntu) — 처음 한 번. 그 뒤 다시 배포
printf '\nBROWSER_FETCH_URL=http://browser:8191\nBROWSER_FETCH_TOKEN=%s\n' "$(openssl rand -hex 24)" >> ~/My_macro_dashboard_v2/.env
bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh
```

- 확인: `docker compose exec -T browser python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8191/health').read().decode())"` —
  `tokenConfigured`가 `true`. 계층 2를 쓴 실행은 상태 화면의 그 태스크 기록에 `계층 browser`로 보입니다.
- 끄려면 서버 `.env`의 `BROWSER_FETCH_URL` 줄을 지우고 다시 배포합니다(컨테이너는 떠 있되 불리지 않음).
- Chrome이 뜨지 않으면(`docker compose logs browser`에 샌드박스 오류) 서버 `.env`에 `BROWSER_SANDBOX=false`를 적고 다시 배포한 뒤 ADR 0026에 기록합니다 —
  호스트가 컨테이너의 사용자 네임스페이스를 막는 경우입니다.
- 메모리: `docker stats --no-stream`으로 `browser`(상한 1g)와 `collector`를 함께 봅니다. 수집기·백엔드가 밀리면 끕니다.

### 배포

```bash
git clone git@github-v2:Jinyoung-Kang/My_macro_dashboard_v2.git ~/My_macro_dashboard_v2   # 서버(ubuntu), 처음 한 번 — 폴더 이름 고정
bash ~/My_macro_dashboard_v2/scripts/vultr/deploy.sh
```

- 순서: main fast-forward → 버전 → backend → frontend → collector → browser 하나씩 빌드(4 GB) → 배포 전 DB 덤프 → 기동 → 스키마 → caddy 다시 만들기 → 정리.
  기동 확인이 실패해도(5분 안에 건강해지지 않은 서비스가 있음) 스키마 적용과 caddy 다시 만들기는 마친 뒤 0이 아닌 값으로 끝나고, 건강하지 않은 서비스를 표로 알립니다(QA-369).
  서버 `.env`에 적지 않는 이름(옛 AWS 공개 주소용 값·PC 전용 `VULTR_*`·`TAILSCALE_*` 포함)이 있으면 멈추고,
  `PAPER_ENABLED=false`가 있으면 운영본의 정기 작업(리스크 점검·결정·체결)이 꺼진 채 뜬다고 '주의'를 찍고(끝 요약에도 다시) 계속합니다 —
  정비 때 일부러 끈 것이 아니면 그 줄을 지우고 다시 배포합니다. 없으면 '참고: 모의 매매 정기 작업 켜짐' 한 줄입니다(QA-194).
- 실제 매매([ADR 0028](adr/0028-real-trade-mirror.md))가 꺼져(OFF) 있지 않고 — 켜짐(LIVE)뿐 아니라 끄는 중(STOPPING)·이상 멈춤(HALTED)도 이 기능의 미체결 취소를
  보내므로 셈(OPS-5) — 지금이 한국 거래 창(평일 08:45~15:35 KST — 정규장 전체: 시가 맞추기·개장 10분 뒤 맞추기·장중 스탑 매도·종가, ADR 0033)이면 빌드 전에 멈추고(장 시간 변경일 — 모의 설정 `kr.calendar.openTimeOverrides`에 오늘이 있으면 개장 −15분 ~ 마감 +5분, 예 수능 10:00~16:30은
  09:45~16:35. 그 설정을 읽지 못했거나 모양이 틀리면 보수 창 평일 08:45~16:35), 빌드하는 동안 창에 들어왔으면
  기동 직전에 멈춥니다(돌던 컨테이너 그대로). 창이 지난 뒤 다시 돌리고, 알고 진행할 때만 `REALTRADE_DEPLOY_OK=1 bash scripts/vultr/deploy.sh`. 상태는 postgres의 `real_trade_config`를 읽기만 하고(표가 없으면 통과, 읽지 못하면 경고만), 꺼져 있지 않으면
  창 밖에서도 '참고' 한 줄을 찍습니다 — 장중 따라 하기 주문은 정규장 어느 시각에도 있을 수 있어 정규장 밖 배포가 낫습니다.
  다시 만들 때 백엔드는 150초·수집기는 30초까지 정상 종료를 기다립니다(`compose.vultr.yml`의 `stop_grace_period` — 웹 서버 종료 단계 30초, 백엔드 종료 훅이 진행 중인 주기를 60초까지,
  그 안의 주문 읽기 상한 25초, ISA 정기 작업 종료 대기 30초, 수집기 주문 한 건 예산 20초. 기본 10초면 보내던 주문이 SIGKILL로 잘려 결과 모름이 됨 — OPS-2·QA-257).
  열린 실시간 시세 연결(SSE)은 종료가 시작되면 바로 닫으므로 평소에는 종료 단계 30초를 다 쓰지 않습니다.
- 배포 전 DB 덤프(QA-200): 빌드가 끝나고 기동하기 전에 `backups/pre-deploy-YYYYmmdd-HHMMSS.sql`(서버에만, S3에 올리지 않음, 최근 `BACKUP_KEEP`개 — 기본 10, 하나 약 460 MB)을 뜹니다.
  뜨지 못하면 돌던 컨테이너 그대로 멈춥니다.
- 되돌리기: 코드는 `main`에 `git revert` 커밋을 push한 뒤 `deploy.sh`(다시 빌드). 배포가 데이터를 망가뜨린 것(잘못된 데이터 변경 마이그레이션 등)을 곧바로 알아챘으면
  코드를 먼저 되돌린 뒤(남은 코드가 복원한 DB에 그 마이그레이션을 다시 적용하지 않게) 문제 배포가 뜬 덤프로 `make restore F=backups/pre-deploy-<그 배포 시각>.sql`
  (이름 시각은 서버 UTC). 되돌리는 배포도 덤프를 하나 더 뜨므로 가장 최근 파일이 아닙니다(그 사이 다른 배포가 없으면 `ls -t backups/pre-deploy-*.sql`의 둘째).
  그 배포 뒤에 쌓인 장부(체결·결정·작업 기록)와 수집 저장본도 함께 그 시점으로 돌아가므로, 늦게 알아챘으면 통째 복원보다 SQL로 고쳐 앞으로 가는 쪽을 먼저 봅니다.
- 데이터 복원: `aws s3 ls s3://<버킷>/db/vultr/` → `aws s3 cp s3://<버킷>/db/vultr/<파일>.sql backups/` → `make restore F=backups/<파일>.sql`.
  복원은 같은 트랜잭션 안에서 **백업에 담긴** 실제 매매 설정(`real_trade_config`) 가운데 꺼져 있지 않은 것(LIVE·STOPPING·HALTED)을 이상 멈춤(`restored`)으로 바꿉니다
  (꺼진 행은 그대로) — 백업 뒤에 나간 실제 주문의 기록이 빠졌을 수 있어, 운영자가 토스 앱의 주문 내역과 화면을 맞춰 본 뒤 '멈춤 해제'(확인 글자 + 비밀번호) 또는 끄기를 합니다.
  **켜기 전(또는 V24 전) 백업을 복원하면** 실제 매매 기록(`real_trade_*`)이 없어져(또는 꺼진 행만 남아) 꺼짐(OFF)이 되고, 지금 DB가 추적하던 토스 미체결은 이 기능이
  더 취소하지 않습니다(백업이 켜진 뒤의 것이어도 백업 뒤에 나간 주문은 같음). 복원은 복원 전 DB의 상태와 견주어 그때 '경고: 복원 전 DB에서 실제 매매가 꺼져 있지
  않았는데(KR:LIVE) … 꺼짐(OFF)입니다' 또는 '경고: … 끝나지 않았던 실제 주문 가운데 복원한 DB에 없는 것이 있습니다'를 찍습니다(OPS-4 — 시장·상태만, 건수·종목 없음).
  그러면 **토스증권 앱에서 미체결 주문을 직접 확인·취소**하고, 꺼짐이 됐으면 다시 켤 때 화면의 켜기(확인 글자 + 비밀번호, 예상 목록)부터 합니다.
  복원은 백엔드·수집기를 멈췄다 켜므로, 실제 매매가 꺼져 있지 않으면 배포처럼 한국 거래 창 밖에서 합니다. QA 스택 복원은 `real_trade_*` 기록을 비우고 꺼짐으로 두며, ISA 계좌 표(`manual_*`)도 비웁니다.
  운영 복원 뒤에는 백업 뒤에 고친 ISA 장부가 빠지므로 운영자가 화면 `/paper/kr/isa`에서 그 증권사 체결 내역과 맞춥니다.
  AWS 운영본의 마지막 덤프(2026-11-03 02:28 KST)는 만료 없는 `archive/aws-final/`에 있습니다 — 서버의 IAM 사용자는 `db/`만 읽으므로 PC에서 받습니다.

### 토스 실제 계좌 조회 켜기 ([ADR 0025](adr/0025-toss-real-account-readonly.md))

모의매매(한국)·(미국) 화면의 '실제 계좌' 탭(토스증권 실제 계좌 읽기 전용 조회 — [명세](specs/2026-11-05-toss-account-readonly.md))은 서버 `.env`의 `TOSS_ACCOUNT_ENABLED=true`로만
켭니다. 로컬 compose는 `"false"` 고정이고(토큰은 키 하나에 1개, 토스 허용 IP는 서버 IP), 서비스 토큰(`COLLECTOR_API_TOKEN`) 없이 뜬 수집기에서도 꺼져 있습니다.

1. 플래그 없이 `bash scripts/vultr/deploy.sh`로 배포하고 정상인지 봅니다(두 탭 모두 꺼짐 안내, 수집기 로그에 계좌 호출 없음).
2. 서버에서 `printf '\nTOSS_ACCOUNT_ENABLED=true\n' >> ~/My_macro_dashboard_v2/.env` 뒤 다시 `bash scripts/vultr/deploy.sh`(환경이 바뀐 수집기가 새 값으로 다시 만들어짐).
3. 아래 한 줄로 확인하고, 같은 시간대 수집기 로그에서 한국 책 1분봉 태스크(`kr_paper_timed`·`paper_watch_kr`)의 401·토큰 재발급이 늘지 않았는지 개수만 봅니다.
   끌 때는 그 줄을 지우고 다시 배포합니다.

**검증 출력 규칙**(명세 §8): 에이전트(사람이 아닌 자동 작업)는 운영 응답의 금액·수량·개수·종목을 출력하거나 문서·커밋·QA 기록에 적지 않습니다. 서버 확인은
`~/My_macro_dashboard_v2`에서 아래 한 줄만 씁니다 — 수집기 이미지에는 curl이 없어 파이썬 표준 라이브러리로 부르고, 출력은 상태와 각 쪽의 **키 이름**뿐입니다.
화면 `/paper/kr/real`·`/paper/us/real`의 숫자 확인은 운영자가 직접 합니다.

```bash
docker compose exec -T collector python -c 'import json,os,urllib.request as u; d=json.load(u.urlopen(u.Request("http://localhost:8000/toss/account",headers={"X-Service-Token":os.environ["COLLECTOR_API_TOKEN"]}))); print({k:d.get(k) for k in ("ok","enabled","reason","isStale")}, {s:sorted(v) for s,v in (d.get("sides") or {}).items()})'
```

### 실제 매매 켜기 ([ADR 0028](adr/0028-real-trade-mirror.md))

토스 실제 계좌의 원화 자산 전부가 고른 한국 모의 책(켜기 창 기본은 규칙 계좌)을 따라 실제로 매매합니다 — 계약은 [명세](specs/2026-11-06-real-trade-mirror.md).
**세 스위치가 모두 켜져야** 주문이 나갑니다: 수집기 `TOSS_TRADING_ENABLED`(+ 한도 네 값, `TOSS_ACCOUNT_ENABLED=true`와 서비스 토큰이 있을 때만) · 백엔드
`REAL_TRADE_ENABLED` — 둘 다 로컬·QA compose는 `"false"` 고정, 서버 `.env`에서만 — 그리고 화면 스위치(`/paper/kr/real` 맨 위 '실제 매매' 칸의 켜기).
**에이전트(사람이 아닌 자동 작업)는 끄기 외의 켜기류 API(`enable`·`update`·`resume`)를 부르지 않습니다** — 화면 켜기는 운영자가 직접(확인 글자 + 운영자 비밀번호) 합니다.

켜기 전 점검(운영자가 토스 앱·이 PC에서 — 켜기 창의 점검표와 같음):

- 토스 앱의 투자자 지시 거래소가 **'통합'**(SOR)인지 — Open API 주문은 통합 모드를 요구합니다.
- **미수·신용 거래가 꺼져** 있는지 — 매수는 상한가 기준으로 매수 가능 금액 안에서만 보내지만, 켜져 있으면 미수가 생길 여지가 남습니다.
- 토스 앱의 Open API 주문 관련 **위험 고지·사전 요건**을 마쳤는지.
- **서버 밖에 같은 토스 키가 없는지** — 로컬 v1·v2·v3·QA의 `.env`에 `TOSS_CLIENT_ID`·`TOSS_CLIENT_SECRET`를 두지 않습니다(토큰이 키 하나에 1개라 다른 곳이 재발급하면
  주문 시각에 401, 거듭되면 이상 멈춤 `token-contention`).
- 켠 동안 **앱에서 국내 주식을 직접 사고팔지 않기** — 앱에서 산 국내 주식은 다음 시가 맞추기에서 팔리고, 반대 방향 미체결이 있는 종목은 그날 건너뜁니다.

켜는 순서:

1. 스위치 없이 `bash scripts/vultr/deploy.sh`로 배포하고 정상인지 봅니다(실제 계좌 탭이 읽히고, '실제 매매' 칸은 '서버에서 꺼짐').
2. 한도 네 값(`TOSS_TRADING_MAX_ORDER_KRW`·`TOSS_TRADING_MAX_ORDERS_PER_DAY`·`TOSS_TRADING_MAX_BUY_KRW_PER_DAY`·`TOSS_TRADING_MAX_EQUITY_KRW` — 뜻과 범위는
   [.env.vultr.example](../.env.vultr.example))을 **사용자에게 확인받아** 서버에서 두 스위치와 함께 덧붙입니다. 값은 저장소·문서·커밋에 적지 않습니다(운용 규모가 드러남).
   장중 스탑 매도([ADR 0033](adr/0033-real-isa-open-offset-and-stops.md))는 1건 상한까지만 팔고 뿌리당 2회까지라, 1건 상한은 가장 큰 단일 보유 평가액 이상, 하루 건수는 재선정일 주문 수에 스탑 여유를 더한 값 이상이 맞습니다
   (모자라면 남은 수량은 다음 날 맞추기가 '책에 없는 보유'로 팖). 설정 `kr.stopWatch.mode`·`kr.rules.timing`을 바꾸기 전에도 서버에서 읽기 전용으로 이 둘이 맞는지만 봅니다(값은 출력하지 않음).
   `printf '\nTOSS_TRADING_ENABLED=true\nREAL_TRADE_ENABLED=true\nTOSS_TRADING_MAX_ORDER_KRW=%s\nTOSS_TRADING_MAX_ORDERS_PER_DAY=%s\nTOSS_TRADING_MAX_BUY_KRW_PER_DAY=%s\nTOSS_TRADING_MAX_EQUITY_KRW=%s\n' <값 넷> >> ~/My_macro_dashboard_v2/.env`
3. 한국 거래 창 밖에서 다시 `bash scripts/vultr/deploy.sh`.
4. 아래 한 줄로 수집기 스위치를 봅니다 — 출력은 상태·사유와 한도가 있는지뿐입니다(위 '검증 출력 규칙' — 한도 값·금액·종목을 찍지 않음). `enabled`가 `false`면 `reason`
   (`disabled`·`account-disabled`·`no-service-token`·`limits-invalid`)을 보고 2로 돌아갑니다.

   ```bash
   docker compose exec -T collector python -c 'import json,os,urllib.request as u; d=json.load(u.urlopen(u.Request("http://localhost:8000/toss/trading/status",headers={"X-Service-Token":os.environ["COLLECTOR_API_TOKEN"]}))); print({k:d.get(k) for k in ("ok","enabled","reason","tokenContention")}, "limits" if d.get("limits") else "no-limits")'
   ```
5. 운영자가 화면에서 켭니다(방식·손실 한도·예상 목록 확인 → 확인 글자 `실제 매매 켜기` + 운영자 비밀번호). 다음 맞추기부터 주문이 나갑니다 — 시가 단일가 창의 시가 맞추기,
   따라 하는 책이 개장 10분 뒤 지정 시각인 날은 그 시각부터 3분의 시장가 맞추기(ADR 0033). 따라 하는 책의 장중 STOP은 그 기준 시각부터 3분 안에 따로 팝니다.

- **첫 실제 날**(권장, 필수 아님): 샌드박스가 없어 OPG 접수·거절 방식·잔량 처리, 시장가 매수 증거금 기준, 종가 단일가 구간 체결은 첫 주문에서 처음 드러납니다(명세 §10).
  운영자가 08:50~09:05 KST(시각 맞추기 날은 09:07~09:20)에 토스 앱의 주문·체결을 화면 '실제 매매' 칸과 함께 보고, 첫 종가 주문(15:20 전후)도 한 번 봅니다. 모르는 결과는 이상 멈춤이 되고, 해제는 사람이 합니다.
- 켠 뒤 서버 `.env`를 다시 전달해도 여섯 줄과 토스 키는 서버의 값 그대로 남습니다(위 '서버 .env 전달' — 서버 전용 줄은 서버에서 이어 붙임). 끝에 '경고: 새 .env에 없는 이름'이
  찍히면 백업 `.env.bak-*`에서 그 줄을 다시 붙입니다.

**비상 끄기** — **화면 끄기가 먼저**입니다. 위에서부터, 앞 단계가 안 될 때만 다음으로:

1. 화면 '실제 매매' 칸(또는 계좌 요약 '다시 읽기' 옆)의 **끄기** — 확인 글자·비밀번호 없이 바로 새 주문을 멈추고 이 기능의 미체결을 취소합니다(보유는 팔지 않음). 상태는 끄는 중(STOPPING — 미체결 취소) → 꺼짐(OFF).
2. 화면이 안 열리면 서버 셸에서 같은 끄기를 한 줄로 — Tailscale 신원 자동 로그인(`TAILNET_OWNER_LOGIN`, ADR 0023)과 허용 출처로 루프백의 caddy를 부릅니다.
   로그인 이름은 백엔드 컨테이너의 환경에서 읽어 stdin으로만 넘기고(인자·화면에 남기지 않음), 출력은 HTTP 상태 코드뿐입니다(200이면 끔 — 401이면 `TAILNET_OWNER_LOGIN`이 빈 것이라 3으로).

   ```bash
   cd ~/My_macro_dashboard_v2 && printf 'Tailscale-User-Login: %s\n' "$(docker compose exec -T backend printenv TAILNET_OWNER_LOGIN)" | curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8201/api/realtrade/disable -H @- -H 'Origin: http://localhost:8201' -H 'Content-Type: application/json' --data '{"market":"KR"}'
   ```
3. 그래도 안 되면 수집기 스위치를 끕니다 — 서버 `.env`의 `TOSS_TRADING_ENABLED`를 `false`로 바꾸고 수집기만 다시 만듭니다(빌드·코드 받기 없이 몇 초. `deploy.sh`는
   코드를 받고 다시 빌드해 느리고, 꺼지지 않은 채 거래 창이면 멈춤). 이때부터 수집기는 주문도 취소도 보내지 않습니다. 켜져(LIVE) 있던 백엔드는 다음 주기에 수집기
   스위치가 꺼진 것(`enabled: false`·`reason: disabled`)을 보고 **이상 멈춤(HALTED, 사유 `collector-disabled`)**으로 둡니다 — 상태는 꺼짐이 아니라 이상 멈춤입니다.
   아래 둘째 줄(위 '켜는 순서' 4와 같은 한 줄)로 `enabled`가 `False`이고 `reason`이 `'disabled'`인지 봅니다.

   ```bash
   cd ~/My_macro_dashboard_v2 && sed -i 's/^TOSS_TRADING_ENABLED=.*/TOSS_TRADING_ENABLED=false/' .env && docker compose up -d --no-deps --no-build collector
   docker compose exec -T collector python -c 'import json,os,urllib.request as u; d=json.load(u.urlopen(u.Request("http://localhost:8000/toss/trading/status",headers={"X-Service-Token":os.environ["COLLECTOR_API_TOKEN"]}))); print({k:d.get(k) for k in ("ok","enabled","reason","tokenContention")}, "limits" if d.get("limits") else "no-limits")'
   ```
4. **토스 앱에서 미체결 주문을 직접 취소**합니다(3 뒤에는 이 기능이 취소하지 못함).

**비상 끄기 뒤 다시 켜기** — 원인을 찾은 뒤, 한국 거래 창 밖에서:

- **1·2로 껐으면**(상태 꺼짐 OFF — 끄는 중이면 꺼짐이 될 때까지 기다림) 서버 스위치는 그대로입니다. 위 '켜는 순서' 4로 수집기 스위치를 보고 5(화면 켜기 —
  확인 글자 `실제 매매 켜기` + 운영자 비밀번호, 예상 목록 확인)로 켭니다.
- **3까지 갔으면** 상태는 이상 멈춤(`collector-disabled`)입니다. 스위치를 되돌리는 것만으로는 주문이 다시 나가지 않습니다 — 서버 `.env`의 `TOSS_TRADING_ENABLED`를
  `true`로 되돌리고 수집기만 다시 만든 뒤(`sed -i 's/^TOSS_TRADING_ENABLED=.*/TOSS_TRADING_ENABLED=true/' .env && docker compose up -d --no-deps --no-build collector`),
  '켜는 순서' 4로 `enabled`가 `True`인지 보고, 화면에서 **멈춤 해제**(확인 글자 + 운영자 비밀번호 — 다음 시가 맞추기부터, 회전율 예외)를 합니다.
  4에서 토스 앱으로 보유를 손댔거나 예상 목록을 다시 보고 싶으면 멈춤 해제 대신 **끄기** → 꺼짐이 된 뒤 화면 켜기(5)로 켭니다(시가 맞추기가 앱에서 산 국내 주식을
  책 비중으로 다시 맞춤). 계속 꺼 둘 때는 이상 멈춤 그대로 두어도 주문은 나가지 않습니다(수집기 스위치도 꺼져 있음).
- 1·2로 이미 꺼짐(OFF)이 된 뒤에 3을 했으면 이상 멈춤이 걸리지 않습니다 — 스위치를 되돌린 뒤 화면 켜기(5).

### ISA 계좌 시작 ([ADR 0029](adr/0029-isa-manual-account.md))

연결되지 않은 다른 증권사 계좌의 장부를 배포 뒤 **한 번** 시작합니다(계약은 [명세](specs/2026-11-06-isa-manual-account.md) — 본문 모양은 §5). 새 환경변수는 없고, 서버의 모의 매매 정기 작업과
텔레그램(`TELEGRAM_*`)을 그대로 씁니다. 시작 현금·시작 매수 목록은 실제 계좌 값이라 저장소·문서·커밋·QA 기록·로그에 적지 않습니다(위 '검증 출력 규칙'과 같음).
운영자는 화면 `/paper/kr/isa`의 '시작' 창으로 하고, 화면 없이 할 때는 서버(ubuntu)에서 아래 순서로 합니다(위 비상 끄기와 같은 Tailscale 신원 + 허용 출처).

1. `(umask 077 && cat > ~/isa-start.json)`을 따로 친 뒤 본문을 붙여 넣고 Ctrl-D(값이 셸 이력에 남지 않음 — 아래 줄과 함께 붙여 넣으면 그 줄이 파일로 들어감).
2. 아래 한 줄로 보냅니다. 파일은 결과와 상관없이 지우고, 출력은 `ok`·`error`뿐입니다(`already-started`면 이미 시작 — 다시 시작하지 않고 화면의 장부 고치기로 맞춤).

   ```bash
   cd ~/My_macro_dashboard_v2 && printf 'Tailscale-User-Login: %s\n' "$(docker compose exec -T backend printenv TAILNET_OWNER_LOGIN)" | curl -sS -X POST http://127.0.0.1:8201/api/manual/isa/start -H @- -H 'Origin: http://localhost:8201' -H 'Content-Type: application/json' --data-binary @"$HOME/isa-start.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ("ok","error")})'; rm -f ~/isa-start.json
   ```
3. 확인은 `available`·`started`만 찍습니다. 금액·종목·수량과 지시 내용은 운영자가 화면과 텔레그램에서 직접 봅니다.

   ```bash
   cd ~/My_macro_dashboard_v2 && printf 'Tailscale-User-Login: %s\n' "$(docker compose exec -T backend printenv TAILNET_OWNER_LOGIN)" | curl -sS http://127.0.0.1:8201/api/manual/isa -H @- | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k:d.get(k) for k in ("available","started")})'
   ```

### 백업 (cron)

```bash
# 서버(ubuntu) — 매일 23:00 UTC(08:00 KST — 미국 결정 뒤)와 일요일 14:00 UTC(23:00 KST). 서버 시간대는 UTC라 서머타임과 무관
# (2026-11-07 배포 전까지는 매일 21:45 UTC = 06:45 KST — 겨울(EST)에는 미국 결정이 07시대까지 밀릴 수 있어 옮김). 기존 줄을 지우고 다시 넣어 여러 번 돌려도 같음
(crontab -l 2>/dev/null | grep -v 'scripts/vultr/backup-s3.sh'; echo '0 23 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh'; echo '0 14 * * 0 /home/ubuntu/My_macro_dashboard_v2/scripts/vultr/backup-s3.sh') | crontab -
journalctl -t my-macro-backup --since yesterday       # 결과(실패는 err)
```

올라가는 곳은 백업 버킷의 `db/vultr/`(60일 만료는 `db/` 접두어의 수명주기 — 2026-11-03에 버킷 전체에서 좁힘, `archive/`는 만료 없음)입니다. 서버의 IAM 사용자는 `db/vultr/`에만 쓰고 `db/`는 읽기만 합니다.

- 실패하면(QA-199) syslog err와 함께 서버 `.env`의 텔레그램 봇(`TELEGRAM_BOT_TOKEN`·`TELEGRAM_CHAT_ID`, 운영 봇)으로 'my-macro 서버 — 백업 실패: …' 한 줄을 보냅니다.
  둘 중 하나라도 비면 보내지 않습니다. 토큰은 curl 인자가 아니라 stdin 설정으로 넘깁니다.
- 성공하면 `backups/.last-s3-ok`(유닉스 초 · UTC 시각 · 올린 키)를 남기고, 서버의 `make status`와 `deploy.sh` 끝 요약이 그 나이를 찍습니다 — 36시간이 넘으면 '경고'
  (cron이 빠진 경우는 텔레그램 알림도 없어 여기서만 보임). 기록이 없으면 `deploy.sh`만 '경고'하고 `make status`는 아무것도 찍지 않습니다(PC에는 S3 cron이 없음).
  판정은 둘이 같이 쓰는 `scripts/vultr/backup-age.sh` 한 곳입니다. 이 기록이 생기기 전 판에서 처음 배포했으면 `bash scripts/vultr/backup-s3.sh`를 한 번 돌립니다.
- `db/` 수명주기에는 '최근 N개 보존'이 없어, 실패를 60일 넘게 놓치면 `db/vultr/`의 서버 밖 사본이 모두 만료됩니다. 만료 없는 주간 사본은 `db/` 밖 접두어
  (예: `archive/vultr-weekly/`)여야 하고 IAM 사용자 권한을 넓혀야 해(저장소 밖 자원) 이번에는 두지 않았습니다.

### 날마다 볼 것

백엔드 ERROR(`make logs S=backend`), 수집 누락(`make status`), 메모리(`free -h`)·디스크(`deploy.sh` 끝, 128 GB), 백업(`journalctl -t my-macro-backup` — 실패는 텔레그램으로도 옴, 마지막 성공은 `make status`·`deploy.sh` 끝),
`tailscale status`에서 PC·휴대폰과 직접 연결인지(relay가 아님). AWS 예산 `my-macro-monthly-45usd`(계정 전체 — my-macro 자원으로 남은 것은 백업 버킷뿐).
