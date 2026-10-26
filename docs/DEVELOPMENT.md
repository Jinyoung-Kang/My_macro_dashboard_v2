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

### ⚠️ 테스트는 전용 DB에서 돕니다

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
| `useApi.test.ts` | 자동 갱신 한 번 실패로 화면이 비는 것, 수동 새로고침이 세션 확인까지 다시 돌려 화면 상태가 초기화되는 것, 늦게 온 이전 응답이 화면을 되돌리는 것 |
| `ArchitectureRulesTest` | 계산 패키지가 스프링·JSON을 알게 되는 것, 컨트롤러가 저장소·수집기를 직접 부르는 것, 패키지 사이 순환(기반 패키지 포함, [ADR 0001](adr/0001-feature-modules-and-dependency-rules.md)) |
| `test_db_scripts.py` | 백업·복원이 실패를 성공으로 알리는 것, 복원이 반만 되는 것([ADR 0003](adr/0003-backup-and-restore.md)) |
| `test_aws_scripts.py` | AWS 서버 배포가 한꺼번에 빌드하거나 실패를 성공으로 알리는 것, 서버 `.env`에 로컬 포트가 섞이는 것, 지난 백업을 다시 올리는 것, 터널이 꺼진 서버에 끝없이 다시 붙는 것([ADR 0019](adr/0019-aws-personal-deployment.md)) |
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

## 7. AWS 개인용 서버

운영본(🧪 모의 매매가 도는 곳)은 AWS 서울의 EC2 `my-macro-app` 한 대이고, 매일 KST 21:55~08:00(토 ~10:00)만 켜집니다. 구성과 이유는
[ADR 0019](adr/0019-aws-personal-deployment.md), 그림은 [ARCHITECTURE §9](ARCHITECTURE.md#9-배포-aws-개인용-서버)에 있습니다.
서버에는 인바운드 포트가 없어 화면도 셸도 SSM으로만 엽니다. 아래 명령의 `<AWS_INSTANCE_ID>`·`<버킷>`은 PC `.env`의
`AWS_INSTANCE_ID`·서버 `.env`의 `AWS_BACKUP_BUCKET` 값입니다.

> **v2(이 저장소)는 아직 서버에 없습니다.** 교체 전까지 서버는 `~/My_macro_dashboard_v1`(v1)을 돌립니다. 아래 경로는 교체 뒤(서버의
> `~/My_macro_dashboard_v2`) 기준이고, 교체 절차는 [v2 프로그램 계획서 §5](specs/2026-10-26-v2-program-plan.md#5-aws-교체-절차-4단계)입니다.

### 서버 만들기 (처음 한 번)

자원은 ADR 0019 결정 1~5·13 그대로입니다(서울 리전, 태그 `Project=my-macro`). v3 데모 스택(portfolio-*)은 건드리지 않습니다.

1. IAM 역할·인스턴스 프로필 `my-macro-ec2`: `AmazonSSMManagedInstanceCore` + 인라인 정책 — 백업 버킷에 `s3:ListBucket`(버킷),
   `s3:GetObject`·`s3:PutObject`(`<버킷>/*`), `s3:DeleteObject`(`<버킷>/bootstrap/*`만 — 서버가 뚫려도 `db/` 백업을 지우지는 못하게. 같은 키로 덮어쓰는 것은 막지 못함, ADR 0019 남은 위험).
2. S3 `my-macro-backups-<임의 8자>`: 퍼블릭 액세스 차단 넷 모두, 기본 암호화 SSE-S3, 수명주기 60일 만료. 버전 관리는 켜지 않습니다
   (켜면 지운 `bootstrap/.env`가 이전 버전으로 남음).
3. 보안 그룹 `my-macro-ec2`: 인바운드 규칙 없음, 아웃바운드 전체. 예산 `my-macro-monthly-45usd`(COST, 80%·100% 알림).
4. EC2 `my-macro-app`: SSM 공개 파라미터의 최신 Ubuntu 24.04 arm64 AMI, t4g.medium, ap-northeast-2a 기본 서브넷(공인 IPv4 자동 할당),
   키페어 없음, 루트 gp3 30 GB 암호화, 메타데이터 `HttpTokens=required`·`HttpPutResponseHopLimit=1`(컨테이너가 인스턴스 역할의 자격 증명을
   꺼내지 못하게 — 호스트의 aws CLI는 그대로 됨), user-data는 `scripts/aws/bootstrap.sh`. 만든 뒤 인스턴스 ID를 PC `.env`의 `AWS_INSTANCE_ID`에 적습니다.
   탄력적 IP(태그 `Project=my-macro`·`Name=my-macro-app-eip`)를 할당해 붙이고, 그 주소를 토스 개발자 콘솔의 허용 IP에 넣습니다(ADR 0019 결정 15 —
   매일 바뀌는 자동 할당 주소로는 토스가 403). 주소와 할당 ID는 공개 저장소에 적지 않습니다.
5. 세션 설정(`SSM-SessionManagerRunShell`)의 유휴 제한을 60분(최대값)으로. 서버 셸(아래)에서 `tail /var/log/cloud-init-output.log`로
   bootstrap이 끝났는지(`== 끝: Docker … · 스왑 2G`) 봅니다.
6. 저장소 받기 — 이 저장소 하나만 읽는 **배포 키**(쓰기 권한 없음)를 씁니다. PC의 GitHub 토큰은 서버에 두지 않고, 원격 주소에 토큰을 넣지 않습니다.

   ```bash
   # 서버(ubuntu): 키를 만들고 GitHub의 호스트 키를 받아 둡니다(받지 않으면 첫 clone이 묻고 멈춤)
   ssh-keygen -t ed25519 -N '' -C my-macro-app -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
   ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts && ssh-keygen -lf ~/.ssh/known_hosts
   # PC: 위 지문이 GitHub가 공개한 값과 같은지 보고, 공개키(위 cat 출력)를 읽기 전용 배포 키로 등록합니다
   gh api meta --jq .ssh_key_fingerprints.SHA256_ED25519
   gh repo deploy-key add <공개키 파일> --repo Jinyoung-Kang/My_macro_dashboard_v2 --title my-macro-app
   # 서버(ubuntu): 폴더 이름 그대로 — compose 프로젝트·DB 볼륨 이름이 폴더 이름을 따릅니다
   git clone git@github.com:Jinyoung-Kang/My_macro_dashboard_v2.git ~/My_macro_dashboard_v2
   ```

   `gh`로 등록한 배포 키는 그때의 `gh` 인증 토큰에 묶여, 그 토큰을 끊으면 함께 지워집니다 — 서버의 `git fetch`가 `Permission denied`면 다시 등록합니다.
7. 켜기·끄기 일정(ADR 0019 결정 14): 실행 역할 `my-macro-scheduler`(신뢰 `scheduler.amazonaws.com` + 같은 계정 조건, 그 인스턴스 하나에만
   `ec2:StartInstances`·`ec2:StopInstances`)와 EventBridge Scheduler 세 개 — 시간대 `Asia/Seoul`, 범용 타깃 `arn:aws:scheduler:::aws-sdk:ec2:startInstances`
   (끄기는 `…:stopInstances`), 입력 `{"InstanceIds":["<AWS_INSTANCE_ID>"]}`, 재시도 1시간·3번.

   | 이름 | 식 | 하는 일 |
   |---|---|---|
   | `my-macro-start` | `cron(55 21 * * ? *)` | 매일 21:55 켬 |
   | `my-macro-stop` | `cron(0 8 ? * SUN-FRI *)` | 일~금 08:00 끔 |
   | `my-macro-stop-sat` | `cron(0 10 ? * SAT *)` | 토 10:00 끔(주간 복기 09:00 뒤) |

   데이터 전환을 마칠 때까지는 `DISABLED`로 만들어 두고(08:00 정지가 빌드·전환을 끊지 않게), 전환을 확인한 뒤 켭니다.
8. 아래 '서버 .env 전달' → '배포' → '화면 열기'로 확인 → '데이터 전환' → '백업(cron)' → 일정 켜기 순서로 이어 갑니다.

### 가동 시간 (켜기·끄기)

서버는 **매일 KST 21:55에 켜지고 08:00(토요일은 10:00)에 꺼집니다** — 미국 장·마지막 지연 봉·06:10 백업·07:30 결정·토요일 09:00 복기가 그 안에 있습니다.
**08:00 뒤에 보려면 손으로 켜고, 다음 정지 일정에 다시 꺼집니다**(낮에 켜 두면 그날 밤 창이 끝나는 08:00까지 켜져 있음).

```bash
bash scripts/aws/instance.sh status   # 지금 켜져 있나 — 한 줄
bash scripts/aws/instance.sh start    # 켜고 running까지 기다림(컨테이너는 그 뒤 1~2분)
bash scripts/aws/instance.sh stop     # 끔 — 정기 가동 시간 안에는 --force 없이는 끄지 않음(모의 매매가 빠짐)
```

`instance.sh` 없이 한 줄로 보려면: `aws ec2 describe-instances --region ap-northeast-2 --instance-ids <AWS_INSTANCE_ID> --query 'Reservations[0].Instances[0].State.Name' --output text`.
꺼져 있을 때 `tunnel.sh`를 치면 켜는 방법을 알리고 멈춥니다.

### 화면 열기 (PC)

```bash
bash scripts/aws/tunnel.sh
```

- 필요한 것: aws CLI v2 · session-manager-plugin · `aws login`으로 로그인한 세션 · PC `.env`의 `AWS_INSTANCE_ID`.
- 브라우저 <http://localhost:8201>에서 운영자 계정(`OWNER_EMAIL`)으로 로그인합니다. 비밀번호는 그 계정을 만들 때의 `APP_PASSWORD`입니다 — 로컬 DB를
  서버로 옮긴 뒤에는 로컬에서 계정을 만들 때의 값(화면에서 바꿨다면 그 값). 메일이 꺼져 있어 재설정 화면은 없습니다.
- 같은 PC에서 QA 스택(`localhost:13002`, 로그인 모드)도 쓰면 세션 쿠키 이름이 같아 서로 로그아웃시킵니다 — 그때는 <http://127.0.0.1:8201>로 엽니다.
- 세션이 끊기면(유휴 제한 60분·네트워크) 3초 뒤 다시 잇습니다. 5번 연달아 곧바로 끊기면(서버가 꺼짐·SSM 에이전트 끊김) 멈추고,
  로그인이 만료되면 `aws login`을 하라고 알리고 멈춥니다.
- 로그인해도 다시 로그인 화면이 나오면(브라우저가 `http://localhost`의 `Secure` 쿠키를 받지 않음 — Safari가 그렇고 Chrome·Firefox는 받음)
  서버 `.env`에 `COOKIE_SECURE=false`를 적고 `docker compose up -d backend`(서버 셸) 뒤 ADR 0019 결정 10에 기록합니다. 터널 안은 암호화돼 있습니다.

### 서버 셸 (SSM)

```bash
aws ssm start-session --region ap-northeast-2 --target <AWS_INSTANCE_ID>   # PC에서
sudo -iu ubuntu                    # SSM 셸은 ssm-user로 열립니다 — 저장소·docker는 ubuntu 사용자
cd ~/My_macro_dashboard_v2
docker compose ps                  # 서버 .env의 COMPOSE_FILE 덕분에 덧붙임(caddy 포함)까지 봅니다
make logs S=backend                # make status · make db · make backup도 그대로
```

### 배포

```bash
bash ~/My_macro_dashboard_v2/scripts/aws/deploy.sh
```

- 서버에서는 **`make up`을 쓰지 않습니다** — 이미지를 한꺼번에 빌드해 4 GiB에서 메모리가 모자랄 수 있습니다. `deploy.sh`가 main을
  fast-forward로 받고, backend → frontend → collector를 하나씩 빌드한 뒤 기동하고(건강해질 때까지 최대 5분), 스키마를 적용합니다(QA-016).
  서버에서 고친 파일이 있거나, 서버 `.env`에 적지 않는 이름이 있거나(`COOKIE_SECURE`·`PAPER_ENABLED`는 알리기만), 어느 단계든 실패하면 멈추고
  0이 아닌 값으로 끝납니다.
- 첫 빌드는 15~25분 걸립니다. 빌드 중 메모리 부족(종료 코드 137, `sudo dmesg | grep -i oom`)이 나면 인스턴스를 멈추고 유형을 t4g.large로 바꿔 빌드한 뒤
  t4g.medium으로 되돌립니다(디스크는 그대로).
- 코드를 바꾸지 않고 `.env`만 바꿨으면 `docker compose up -d`로 컨테이너만 다시 만들어도 됩니다(화면 빌드 인자는 `.env`와 무관).

### 서버 .env 전달 (처음 한 번, 바꿀 때)

서버 `.env` = 로컬 `.env` − 적지 않는 이름 + 서버 전용 두 줄([.env.aws.example](../.env.aws.example)). 값은 화면·로그 어디에도 찍지 않고
S3를 한 번만 거칩니다. 전환 뒤 로컬 `.env`의 `PAPER_ENABLED=false`도 거릅니다(서버는 비우면 켜짐).

```bash
# PC — 걸러 낸 사본을 S3에 한 번 올리고 지웁니다
tmp="$(mktemp)" && grep -Ev '^[[:space:]]*(DATABASE_PORT|BACKEND_PORT|COLLECTOR_PORT|FRONTEND_PORT|COOKIE_SECURE|LOCAL_NO_LOGIN|FRONTEND_ORIGIN|PUBLIC_URL|AWS_INSTANCE_ID|PAPER_ENABLED)=' .env > "$tmp" \
  && printf 'COMPOSE_FILE=docker-compose.yml:compose.aws.yml\nAWS_BACKUP_BUCKET=%s\n' "<버킷>" >> "$tmp" \
  && aws s3 cp --only-show-errors "$tmp" "s3://<버킷>/bootstrap/.env"; rm -f "$tmp"
# 서버(ubuntu) — 받아서 600으로 두고 S3 객체는 바로 지웁니다(umask는 괄호 안에서만 — 셸에 남으면 git이 0600 파일을 씀)
( umask 077 && aws s3 cp --only-show-errors "s3://<버킷>/bootstrap/.env" ~/My_macro_dashboard_v2/.env ) \
  && chmod 600 ~/My_macro_dashboard_v2/.env && aws s3 rm --only-show-errors "s3://<버킷>/bootstrap/.env"
```

다시 전달하면 서버 `.env`를 통째로 덮어씁니다. 서버에만 적은 줄(`COOKIE_SECURE=false`, 서버 정기 작업을 일부러 끈 `PAPER_ENABLED=false`,
`COMPUTE_MAX_CONCURRENT` 등)은 다시 덧붙입니다. `deploy.sh`는 `PAPER_ENABLED`가 꺼져 있으면 알립니다.

### 데이터 전환 (로컬 v1 → 서버, 한 번 — 2026-10-26에 v1에서 끝남)

> v1을 처음 서버로 옮긴 기록입니다. v2로 바꾸는 교체는 이 절차가 아니라 계획서 §5(서버의 v1 백업 → v2 복원)를 따릅니다.

낮에 하므로 서버는 손으로 켜 둡니다(`instance.sh start`). 일정은 아직 `DISABLED`입니다.

모의 매매 정기 작업이 **두 곳에서 동시에 돌면 안 됩니다**(같은 계좌를 두 장부가 따로 결정·체결). 07:30 KST 정기 결정이 끝난 뒤 그날 22:30 KST
전에 합니다(미국 장 밖 — 장중은 서머타임 22:30~05:00, 11월~3월 23:30~06:00 KST).

1. 로컬: `.env`에 `PAPER_ENABLED=false`를 넣고 `make up` → `curl -s http://localhost:8081/api/paper/status | jq .enabled`가 `false`인지 봅니다.
   (먼저 끄므로 백업 뒤에 로컬에서 결정·체결이 더 쌓이지 않습니다.)
2. 로컬: `make backup` → `aws s3 cp --only-show-errors backups/<파일>.sql s3://<버킷>/db/`
3. 서버: `aws s3 cp --only-show-errors s3://<버킷>/db/<파일>.sql backups/` → `make restore F=backups/<파일>.sql`(교체 전 자동 백업, ADR 0003)
   → `make migrate`(스키마 적용 한 번 더 — 덤프가 서버 이미지보다 오래된 스키마일 때)
4. 확인: 터널 화면 `/paper` 개요의 계좌 4개 순자산이 로컬과 같은지, `/api/paper/status`의 `enabled`가 `true`이고 `jobs`에 서버에서 돈
   5분 리스크 작업(`paper_job_runs`)이 쌓이는지.

되돌릴 때(서버 확인이 안 됨)는 **서버 정기 작업을 먼저 끕니다** — 서버 `.env`에 `PAPER_ENABLED=false`를 적고 `docker compose up -d backend`,
터널 화면의 `/api/paper/status`에서 `enabled`가 `false`인지 본 뒤에 로컬 `.env`의 `PAPER_ENABLED=false`를 지우고 `make up`. 로컬 DB는 백업 시점
그대로입니다. 컨테이너만 멈추면(`docker compose stop backend`) 다음 `deploy.sh`가 다시 켜므로 `.env`로 끕니다(`deploy.sh`도 그 줄을 보고 알림).
다시 전환할 때는 1단계부터 하고, 서버 `.env`의 그 줄은 3단계 복원 뒤에 지우고 `docker compose up -d backend`.

확인이 끝나면 서버를 끄고(`instance.sh stop` — 낮이라 창 밖) 일정 세 개를 `ENABLED`로 바꿉니다. **첫 사이클**(그날 21:55 → 다음 날 08:00)에서 차례로 봅니다 —
하나라도 빠지면 원인을 찾을 때까지 일정을 그대로 두고 보고합니다.

1. 21:55 자동 기동(인스턴스 running, EventBridge 일정 실행 기록)
2. 컨테이너 다섯 개 healthy(`docker compose ps`) — 정지 뒤 다시 뜬 것이므로 postgres 복구 로그가 없어야 함(30초 안에 깨끗이 꺼졌다는 뜻)
3. 미국 장 시작 뒤 리스크 작업 기록(`/api/paper/status`의 `jobs`에 새 `risk` 행)
4. 06:10 백업이 S3 `db/`에 도착(`journalctl -t my-macro-backup`)
5. 07:30 결정 기록(`jobs`의 `decision` 행)
6. 08:00 자동 정지(인스턴스 stopped)

### 백업 (cron)

```bash
# 서버(ubuntu) — 매일 21:10 UTC(06:10 KST). 서버 시간대는 UTC입니다
(crontab -l 2>/dev/null | grep -v 'scripts/aws/backup-s3.sh'; echo '10 21 * * * /home/ubuntu/My_macro_dashboard_v2/scripts/aws/backup-s3.sh') | crontab -
journalctl -t my-macro-backup --since yesterday       # 결과(실패는 err)
```

S3 백업으로 되돌리기: `aws s3 ls s3://<버킷>/db/` → 받을 파일을 `backups/`로 받은 뒤 `make restore F=backups/<파일>.sql`.

### 날마다·달마다 볼 것

- 예산 `my-macro-monthly-45usd`(80%·100% 알림, 계정 전체). 이 서버는 월 약 $17(하루 10시간)입니다.
- CloudWatch `CPUSurplusCreditsCharged`가 0인지 — t4g 무제한 크레딧은 기준선(vCPU당 20%)을 오래 넘기면 요금이 붙습니다.
- 디스크: `deploy.sh` 끝에 사용률을 찍습니다(30 GB, 오래된 이미지·빌드 캐시는 배포 때 정리).
