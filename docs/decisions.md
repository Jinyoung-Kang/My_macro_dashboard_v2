# 작은 결정 기록

[ADR](adr/README.md)로 한 장을 쓸 만큼 크지는 않지만 나중에 "왜 이렇게 뒀지?"가 나올 결정을 남깁니다.
항목마다 문제·원인·선택·이유를 5줄 이내로 적습니다.

## 2026-10-08 · postcss-selector-parser 취약점 알림을 고치지 않고 닫음

- 문제: Dependabot이 frontend의 postcss-selector-parser 6.1.4(dev)에 GHSA-rj75-hqrm-r3gf(셀렉터 파싱 2차 복잡도)를 알림. 수정판은 7.1.6뿐.
- 원인: tailwindcss 3.4.19(v3 LTS 최신)와 postcss-nested 6.2.0이 `^6`을 요구하는데 6.x 수정판이 없음. 부모로 푸는 길은 Tailwind 4 메이저 이전뿐(Dependabot PR #3 — 빌드 실패로 닫음).
- 선택: `overrides`로 7.1.6을 강제하지 않고 알림을 `tolerable_risk`로 dismiss. 나머지 알림 4건은 버전을 올려 해결(`6a1f7e6`).
- 이유: 빌드 때 우리 소스 CSS만 파싱하는 개발 의존성이고 운영 이미지(`npm ci --omit=dev`)에는 없음. 7.1.6을 강제해도 Tailwind 출력 CSS는 같았지만, 부모가 선언한 메이저 범위 밖 조합을 떠안을 이득이 없음. Tailwind 4로 옮길 때 이 의존성째 사라짐.

## 2026-10-08 · braces 취약점(GHSA-vfj7-8cjw-p6xm)은 고칠 판이 없어 그대로 둠

- 문제: frontend의 braces 3.0.3(dev)에 깊게 중첩된 중괄호 패턴으로 스택을 넘기는 DoS(high). 취약 범위가 `<= 3.0.3`이고 최신판이 3.0.3이라 수정판이 없음.
- 원인: tailwindcss 3(chokidar·micromatch)과 eslint-config-next(`@next/eslint-plugin-next` → fast-glob 3.3.1 → micromatch)가 끌어옴. eslint-config-next는 15.5.27·16.4.0 모두 fast-glob 3.3.1 고정이라 Tailwind 4로 가도 남음.
- 선택: 손대지 않음. Dependabot 알림 #1은 GitHub가 이미 `auto_dismissed`. CI의 `npm audit --omit=dev --audit-level=high`는 운영 의존성만 봐서 통과.
- 이유: 운영 이미지(`npm ci --omit=dev`)에 없고, braces가 펼치는 패턴은 우리 설정의 glob(`./src/**/*.{ts,tsx}` 등)뿐이라 외부 입력이 닿지 않음. braces 수정판이 나오면 lockfile만 갱신(micromatch `^3.0.3`·chokidar `~3.0.2` 범위 안이면).

## 2026-10-10 · braces 알림(GHSA-vfj7-8cjw-p6xm)이 다시 열려 직접 닫음

- 문제: 2026-10-08에 GitHub가 자동으로 닫았던(`auto_dismissed`) Dependabot 알림 #1이 2026-10-09 15:36 UTC에 다시 열림.
- 원인: 같은 시각 세 저장소가 함께 다시 열림 — 저장소를 비공개로 돌리면서 자동 분류 규칙이 더는 닫아 두지 않는 것으로 봄(시각으로 한 추정, 문서로는 확인 못함).
- 선택: `tolerable_risk`로 직접 dismiss(댓글에 이 항목). 근거는 위 2026-10-08 항목 그대로 — 수정판 없음, 상류는 고칠 계획이 없다고 답함(micromatch/braces#70, 잠김).
- 이유: dev 의존성(tailwindcss 3 → chokidar · micromatch)이고 `npm ls braces --omit=dev` 0건, 펼치는 패턴은 우리 설정의 glob뿐. 닫은 알림은 수정판이 나와도 다시 열리지 않을 수 있어 Tailwind 4 이전 때 함께 확인.


## 2026-10-11 · Next 15 → 16 이전에서 React Compiler 린트 규칙 하나를 끔

- 문제: Next 15.x 지원이 2026-10-21에 끝나(메이저는 출시 후 2년) 16.4.0으로 옮겼고, eslint-config-next 16이 함께 켜는 `react-hooks/set-state-in-effect`가 7곳을 오류로 막음.
- 원인: React Compiler용 새 규칙. 걸린 곳은 마운트 뒤에 시계·세션·주소를 읽는 자리로, 서버 렌더와 첫 화면이 같아야 하는(하이드레이션) 의도된 패턴.
- 선택: 이 규칙만 `off`(eslint.config.mjs에 이유). React는 19로 올려 테스트 런타임을 운영(Next 내장 React 19)과 맞춤.
- 이유: React Compiler를 켜지 않으므로 규칙이 막는 위험(자동 메모이제이션과의 충돌)이 없음. 따를지는 React Compiler 도입과 함께 정함.

## 2026-10-18 · ESLint 10으로 올리고 플러그인 피어 경고 3건을 받아들임

- 문제: ESLint 9는 2026-08-06에 지원이 끝남. 10.13.0으로 올리면 npm 설치 때 eslint-plugin-react 7.37.5·import 2.32.0·jsx-a11y 6.10.2가 ESLint 10을 피어로 선언하지 않아 ERESOLVE 경고 3건이 남음.
- 원인: 세 플러그인의 최신판이 아직 `^9`까지만 선언. eslint-config-next 16.4부터 react·import를 ESLint 10 호환 shim(fixupPluginRules)으로 감싸 쓰고(Next 문서: ESLint 9·10 지원), jsx-a11y는 ESLint 10에서 없어진 context API를 쓰지 않음.
- 선택: 경고를 받아들이고 strict-peer-deps는 쓰지 않음. 이유는 eslint.config.mjs 주석에도 적음(`2d3698a`).
- 이유: 켜진 규칙 67개와 lint 결과(오류 0·경고 0·억제 1)가 ESLint 9와 같음. 플러그인이 10을 선언하면 경고는 lockfile 갱신만으로 사라짐.

## 2026-10-18 · TypeScript는 6.0.3까지만 올리고 7은 보류

- 문제: TypeScript 최신은 7.0.2지만 7.0에는 컴파일러 API가 없고(exports가 version.cjs만 가리킴), typescript-eslint 8.71의 피어가 `typescript <6.1.0`이라 ESLint의 TS 파싱이 막힘.
- 원인: 7.x는 Go 네이티브 컴파일러로 바뀌는 중이고 API는 7.1 이후 예정. 공식 우회(typescript6 별칭 + @typescript/native 이중 설치)는 tsc bin이 겹치고 next build 타입 검사가 결국 TS 6으로 돎.
- 선택: 6.0.3으로 올림(`ac8e42c`, tsconfig 변경 없음). 7은 하지 않음.
- 다시 볼 조건: TS 7.1에 API가 들어오고 typescript-eslint가 7을 피어 범위에 넣을 때. 132개 파일 규모라 7의 속도 이득은 작음.

## 2026-10-18 · Tailwind 4로 옮김 — 받아들인 화면 차이

- 문제: Tailwind 3.4는 LTS 유지만 되고, postcss-selector-parser 6(위 2026-10-08 항목)이 Tailwind 3에 묶여 있었음.
- 선택: 4.3.3 + @tailwindcss/postcss, 설정은 globals.css의 `@theme`, autoprefixer 제거(`cf2c67a`). 이름이 바뀐 클래스 42곳 수정(`0bec4cc`). 버튼 커서(pointer)·입력칸 안내 문구 색은 v3대로 되돌림.
- 받아들인 v4 기본값: hover는 `(hover:hover)` 기기에서만(휴대폰에서 탭 뒤 hover 모양이 남지 않음 — v3 쪽이 오히려 결함에 가까움), space-y 셀렉터 변경, 기본 팔레트(애프터마켓 보라 배지)의 oklch 미세 차이, 브라우저 하한 Safari 16.4·Chrome 111·Firefox 128(Next 16 빌드 대상과 같음). v3처럼 hover를 되돌리려면 globals.css에 `@custom-variant hover (&:hover);` 한 줄.
- 확인: QA 스택에서 v3·v4 화면의 계산 스타일을 요소마다 비교해, v4 기본 줄 높이(비율)가 작은 글씨에 물려 표 행이 4~9px 낮아지는 것을 찾아 `@theme`의 줄 높이를 v3 값(rem)으로 둠(`3854f1e`). 그 뒤 남은 차이는 보이지 않는 것뿐([비교](qa/evidence/2026-10-18/tailwind4-compare.md)).
- 결과: postcss-selector-parser·postcss-nested·chokidar 경로가 사라져 npm audit(dev) 9건 → 5건. braces는 예상대로 eslint-config-next의 fast-glob 3.3.1로 남음.

## 2026-10-18 · 수집기 pandas 3·numpy 2.5는 올리지 않음(막힘)

- 문제: pandas 3과 numpy 2.5가 나왔지만 수집기는 pandas 2.3.3·numpy 2.4.6까지만 올림(`f875263`).
- 원인: pykrx 1.2.9(최신)와 upstream이 `pandas<3.0`을 요구해 설치가 풀리지 않음. numpy 2.5.x는 `requires_python>=3.12`인데 이미지(python:3.11-slim)와 CI는 3.11.
- 선택: Python 3.11에서 쓸 수 있는 최신까지만 올림. pykrx는 빼지 않음 — 과거 날짜 수급 레이더 조회는 PyKrx 단계만 지원.
- 다시 볼 조건: pandas 3은 pykrx가 상한을 풀 때(yfinance의 pandas 3 지원도 그때 확인), numpy 2.5는 Python 3.12 전환과 함께. pandas 2.3에서 FutureWarning을 오류로 바꾸고 `future.infer_string=True`를 켜도 수집기 테스트가 통과함.

## 2026-10-18 · Spring Boot 4.1.2 전까지 BOM의 Jackson·Tomcat 판을 덮어씀

- 문제: Spring Boot 4.1.1 BOM의 Jackson 3.1.5·2.21.5와 Tomcat 11.0.24에 공개 보안 권고가 있음(OSV.dev·tomcat.apache.org). CI에 Maven 취약점 점검이 없어 드러나지 않았음.
- 원인: 이 판들을 고친 4.1.2(마일스톤 due 2026-10-22)가 아직 Maven Central에 없음(2026-10-18 기준).
- 선택: parent는 그대로 두고 `backend/pom.xml`의 `jackson-bom.version` 3.1.7, `jackson-2-bom.version` 2.21.7, `tomcat.version` 11.0.27만 덮어씀(`068c7e3`). 4.1.2 마일스톤이 채택한 판과 같게 맞춤.
- 해제 조건: 4.1.2로 올릴 때 세 속성을 지움(pom 주석에도 적음). 지우지 않으면 낮은 판에 묶임.

## 2026-10-18 · 계산 상한 초과는 503이 아니라 429

- 문제: 캐시에 없는 비싼 계산이 요청 스레드에서 상한 없이 돌아, 서로 다른 조합을 초당 50건 부르면 `/api/health`도 답하지 못함(QA-131). 상한을 넘긴 요청에 줄 상태를 정해야 했고, REPORT.md는 503을 제안했음.
- 원인: 이 API에서 503은 'DB 연결 불가'(QA-009) 전용. 같은 '잠시 몰림'인 비밀번호 해시 상한(QA-019)은 이미 429 + `Retry-After`.
- 선택: `ComputedCache`가 공정 세마포어(자동 = 코어 절반·최소 1, 대기 2초, 대기열 32)로 묶고, 넘치면 `read.ComputeBusyException` → `ApiExceptionHandler`가 429 + `Retry-After: 2` + 표준 `{error, message}`. 캐시 적중·버전 없는 경로(DB 장애)는 상한 밖.
- 이유: 503이면 화면·운영자가 몰림을 DB 장애로 읽음. 429는 기존 처리기와 화면 경로(`message` 표시, 값이 있으면 유지)를 그대로 씀. read→support 의존을 열지 않으려고(ADR 0001) 예외 타입만 read에 둠.

## 2026-10-19 · 계산 상한에 같은 키 묶기를 더하고, 바쁠 때 직전 값 돌려주기는 보류

- 문제: QA-131 첫 수정(벌크헤드만) 뒤 QA 스택 측정에서, 재시작 직후 5명이 무거운 화면을 함께 열면(요청 45건·키 9개) 같은 키 요청이 각자 대기열에 서서 429가 14–37건 났음.
- 선택: 같은 키·같은 저장본 버전을 놓친 요청은 계산 하나만 돌리고 나머지는 자리 없이 그 결과를 기다림(최대 30초, 모든 키 합쳐 64건까지, 앞선 계산이 자리를 못 얻으면 자기 2초 한도 안에서 다시 시도). 측정에서 몰림 429가 9회 중 1회 5건으로 줄었음([측정](qa/evidence/2026-10-18/compute-limit.md)).
- 보류: 자리가 없을 때 만료된 직전 값을 돌려주기. 공격 중 자주 읽는 키의 429(4–8%)는 없앨 수 있지만, 응답의 `ageSeconds`·'60초마다 다시 계산' 약속이 흐려지고 버전이 바뀌는 순간에는 쓸 수 없음.
- 다시 볼 조건: 운영 로그의 거절 WARN이 평소(공격이 아닌 때)에도 이어지거나, 화면의 '새로 읽지 못함'이 사용자에게 문제가 될 때.

## 2026-10-19 · 캐시 밖 경로는 응답 캐시로 감싸지 않고 요청 하나의 크기를 묶음(QA-133)

- 문제: 응답 캐시·계산 상한(QA-131) 밖의 경로(상관 분석, 수급 이력 전 기간, 보유 기관 검색, AI 리포트의 원본 텍스트)에 파라미터 상한이 없었음.
- 측정: QA 스택에서 경로마다 동시 50명(AWS 근사 포함)으로 몰아도 health 100%·5xx 0. 무거운 것은 보유 검색 한 글자(응답 3MB, 메모리 880MiB/1GiB)와 못 쓰는 엔진으로 한도를 되돌려받는 AI 리포트 반복([측정](qa/evidence/2026-10-19/uncached-load.md)).
- 선택: 상관은 창 5~250·기간 1~10년으로 접음(화면 최대, 400 아님), 수급 이력 전 기간은 최신 5,000행 + `truncated`, 보유 검색은 비중 상위 200행 + `totalMatches`·`truncated`이고 검색어와 상관없는 보유 목록만 응답 캐시(재기동 직후 13F 파싱을 한 번으로), AI 리포트는 못 쓰는 엔진이면 한도·원본 텍스트 전에 끝.
- 이유: 상관·수급 이력은 한 번에 수십 ms라 캐시 키를 늘려 LRU를 흔들 이득이 없음. 보유 검색은 응답이 검색어마다 달라 응답 대신 색인을 캐시. AI 정상 리포트는 하루 한도가 이미 호출 수를 묶음 — 원본 텍스트를 GET 캐시와 같이 쓰는 것은 보류.

## 2026-10-20 · 13F 기관 공시 변화: 뱅가드는 자회사 둘 합산, 노르웨이 1·3분기와 사이언은 그대로(QA-085·QA-140)

- 문제: 뱅가드가 2025-12-31에 멈춰 있었고(그룹이 13F-NT로 바꿈), 노르웨이 1·3분기가 빠졌고(기밀 처리 — 원본 보유표가 비고 1년 뒤 정정 공시로 공개), 사이언은 2025-11 뒤로 공시가 없음. EDGAR 목록·표지로 확인.
- 선택: 뱅가드는 그룹 이후 분기를 Capital·Portfolio Management 두 자회사 합산(둘 다 낸 분기만, 실패하면 저장본 유지). 노르웨이·사이언은 그대로.
- 이유: 두 자회사 합이 그룹 공시와 같은 규모라 같은 기관으로 이어 볼 수 있음. 노르웨이의 늦은 공개는 최신 비교에 쓸 수 없고(1년 뒤), 사이언은 지금 운용 보유가 아님을 기준 분기로 이미 보임.
- 다시 볼 조건: 뱅가드 자회사 구성이 바뀌어 13F-NT의 보고 주체 목록이 달라질 때, 1년 늦은 1·3분기도 추세에 필요해질 때.


## 2026-10-26 · v2는 v1을 갈라내 만들고, 교체 전까지 v1은 운영본으로 둔다

- 문제: 화면 전면 개편(Coinbase식 패턴)·한국 증시 모의매매·외부 OSS 정의 채택을 한꺼번에 하면서, AWS에서 도는 미국 모의매매 책을 멈추지 않아야 한다.
- 원인: 모의매매 상태는 한 곳에만 있어야 하고(ADR 0019), 백엔드·수집기의 정확성 규칙은 다시 쓸 이유가 없다.
- 선택: 별도 private 저장소 `My_macro_dashboard_v2`(v1 전체 이력 fork, 3002/8082/8002/5434, 쿠키 `my_macro_v2_session`, 로컬 `PAPER_ENABLED=false`)에서 프런트만 새로 쓰고 백엔드·수집기·스키마(V13부터)는 이어받는다. 끝나면 같은 EC2에서 토요일 창에 백업→복원으로 교체한다.
- 이유: 상태를 한 번만 옮기고 v1을 바로 멈출 수 있고, v3→v1 때 검증된 절차다. 계획은 [specs/2026-10-26-v2-program-plan.md](specs/2026-10-26-v2-program-plan.md), 되돌리기 어려운 결정은 v2의 ADR 0020에.

## 2026-10-26 · D29 개정 — 봇 차단 우회를 허용하되 쓸 곳을 가림

- 문제: 2단계 명세 D29는 "봇 차단을 우회하지 않는다"였는데, 국내 컨센서스·KRX 전 종목 투자자별 자료는 우회 없이 받을 길이 없음.
- 선택: 우회 허용(사용자 결정 V5, [ADR 0020](adr/0020-v2-program.md)). 단 ① 브라우저 없이 되는 출처를 먼저 쓴다 ② 우회로 받은 자료도 출처·수집 시각을 적고 화면에 배지
  ③ 상주 우회 서버(헤드리스 REST)는 올리지 않고 필요할 때만 뜨는 one-shot ④ 서버 크기 결정(V2) 뒤 5단계에서.
- 이유: 서버 4 GiB에 상주 브라우저는 메모리를 넘기고, 상주 우회 서버는 인증·SSRF 보호가 없음([OSS 목록](specs/2026-10-26-v2-oss-adoption.md) §2). 출처를 적지 않으면 우회 값과 공식 값을 화면에서 구분할 수 없음.

## 2026-10-26 · Stooq를 가격 폴백으로 쓰지 않음

- 문제: 미국 가격 폴백 후보로 Stooq CSV(Vibe-Trading이 쓰는 출처)를 검토.
- 원인: 2026-10-26 확인 — 자동 요청에 CSV가 아니라 JS 챌린지 페이지를 돌려줌.
- 선택: 채택하지 않음. 폴백은 지금 경로(yfinance 등) 그대로.
- 이유: 넘으려면 우회(헤드리스)가 필요한데, 가격은 브라우저 없이 되는 출처가 있어 D29 개정의 '먼저 쓸 것'이 아님. 이런 응답은 1단계의 거부 래치가 '데이터 없음'이 아니라 '출처 거부'로 분류.

## 2026-10-26 · Radix는 쓰는 세 패키지만 설치(dialog·toast·visually-hidden)

- 문제: v2 UI 설계 §1은 Radix primitives 여섯 개(Tabs·Dialog·DropdownMenu·Tooltip·Toast·VisuallyHidden)를 들이자고 했다(계획서 V4가 허용).
- 원인: 1단계에서 실제로 쓰는 곳은 확인 창·검색 대화상자·토스트·낭독기 전용 제목뿐. 모의매매 7탭은 기존 마크업과 테스트를 그대로 두기로 했고, 계정 영역은 로그아웃·내 계정이 첫 렌더부터 DOM에 있어야 해서(레이아웃 계약) 드롭다운을 쓰지 않는다.
- 선택: `@radix-ui/react-dialog` 1.3.1·`react-toast` 1.3.1·`react-visually-hidden` 1.2.13만 정확한 판으로(`be3ff6d`). 나머지는 쓰는 화면이 생길 때 같은 묶음 판으로.
- 이유: 쓰지 않는 의존성은 잠금 파일·감사 범위·이미지만 키운다. 세 판은 npm GA(latest)·deprecated 없음·peer react 19 충족을 확인.

## 2026-10-26 · 홈 국면 히어로에 '3일 확정' 배지를 두지 않음(API가 내보낼 때까지)

- 문제: UI 설계 §7의 홈 히어로에는 "3일 확정" 배지가 있다.
- 원인: `/api/analytics/regime` 응답에 확정 여부·연속 일수가 없다. 화면이 판정 기록을 세어 만들면 알림 규칙(`AlertRules`의 3일 확정, QA-054)을 화면에 다시 구현하게 되고(ADR 0004) 둘이 갈라질 수 있다.
- 선택: 배지 없이 판정 글·신호 네 타일·기준일만(`183fc20`, 테스트가 '3일 확정' 없음을 고정). 백엔드가 확정 필드를 보내면 히어로에 붙인다.
- 이유: 없는 값을 화면이 짓지 않는다. 필드 추가는 응답 모양(API.md)을 바꾸는 사용자 결정이라 1단계(백엔드 변경은 기동 로그 하나) 밖이다.

## 2026-10-26 · 테마는 CSS 변수 토큰 + `data-theme`, 기본은 시스템 따름(`dark:` 변형 안 씀)

- 문제: 라이트·다크 두 벌이 필요하고(UI 설계 §3), 4단계까지 남는 옛 화면도 함께 바뀌어야 한다.
- 원인: Tailwind `dark:` 변형으로 하면 옛 화면의 클래스마다 고쳐야 하고, 고른 테마를 React 상태로만 붙이면 첫 페인트에 반대 테마가 잠깐 보인다.
- 선택: `globals.css`의 `:root`에 라이트, `[data-theme="dark"]`와 속성이 없을 때의 `prefers-color-scheme: dark`에 다크 값을 두고 Tailwind `@theme inline`으로 이름을 잇는다. 고른 값은 `localStorage`와 `<html data-theme>`, 첫 페인트 전 인라인 스크립트(`lib/theme.ts`). 옛 색 이름(`canvas`·`muted` 등)은 별칭(4단계에 지움).
- 이유: 토큰만 바꾸면 모든 화면이 함께 바뀐다. `inline`이어야 하위 요소에서 바꾼 값과 `bg-accent/15` 같은 투명도가 먹는다. 기본을 시스템으로 둔 것은 사용자 결정(UI 설계 §10).

## 2026-10-27 · 캘린더 컨센서스는 한국 책 출발일에 두 책 함께 켬(D33 개정 준비)

- 문제: 미국 `1b_calendar`에 컨센서스(`forecast`·`previous`)를 더하면 미국 책의 실험 조건(패킷)이 바뀐다. 3단계(스키마 v3 `bearCase`·숫자 근거 검사)도 같다.
- 원인: 코드 배포와 함께 켜지면 `settings_version`·`changed_keys`에 남지 않고, 두 책이 다른 날 다른 판이 된다(ADR 0018 실험 조건).
- 선택: 수집(`calendar.us_consensus`)은 먼저 넣어 저장만 하고, 설정 `calendar.consensus`·`claude.schemaV3`·`claude.figureCheck`(기본 false)를 한국 출발일 S 21:55~22:30에 한 번에 저장해 켠다 — 미국 `packetVersion` 5→6(S+1 07:30 결정부터), 한국은 처음부터 6, 프레임 판은 그대로.
- 이유: 실험 조건을 한 날 한 번만 바꾸고 결정마다 판이 남는다. 근거는 [한국 책 명세](specs/2026-10-26-v2-kr-paper-spec.md) §4-12·K22·K37. 출발일에 실제 적용 날짜를 이 항목에 덧붙인다.

## 2026-10-27 · 투자 OS 프레임 v2는 수동 편집(F3) 한 번으로, 규칙 번호는 저장 형식으로 바꿔 넣음

- 문제: 사용자 원문은 규칙 번호가 `E1-4`·`E8-0` 꼴이고(저장 형식은 `E{n}-R{m}`, m ≥ 1), E8-1·E8-4 문장이 v1과 조금 다르며, 결합 자료 4편은 요약만 있음.
- 선택: Claude 제안 호출 없이 수동 편집으로 v2를 만듦. 번호는 `E{n}-R{m}`, E8-0은 다음 번호 E8-R10으로 엔진 8 맨 앞에, 본문 안 참조도 같은 꼴로. v1의 29개 규칙은 v1 문장 그대로(E8-1·E8-4 포함), 새 23개만 `addedIn` 2. 원문의 변경 요약은 changelog에만, 자료 요약·원문은 INSIGHT 메모.
- 이유: 번호 형식과 번호 재사용 금지(설계 §5-7 ②)를 지키면서 원문 순서를 살리고, 판 경계 앞뒤로 기존 규칙의 뜻이 바뀌지 않게. 원칙에는 `addedIn` 칸이 없어 P6·P7이 v2에서 생긴 것은 changelog로만 남음.
- 확인: QA 스택에서 같은 묶음을 먼저 적용해 렌더링이 서버와 같았음(어림 6,228토큰), 첫 정기 결정(거래일 10-26)의 `framework_version` 2, 개요의 판 경계 10-26.

## 2026-10-27 · 연합뉴스 마켓+ RSS를 한국 책 패킷에 남김(G12, 권장을 뒤집은 사용자 결정)

- 문제: 한국 사건 피드 4개 중 연합뉴스 마켓+(`yna_market`)의 채널 `<copyright>`가 "무단 전재-재배포, AI 학습 및 활용 금지"라, 제목을 Claude 패킷(`11b_events`)에 싣는 것이 'AI 활용'일 수 있다[추정].
- 원인: 연합뉴스는 시장 기사 피드라 공식 3곳(보도자료)보다 종목 사건이 많고, 120건이 약 41시간을 덮어 서버가 꺼진 낮(08:00~21:55)을 메운다(하루 표본). 명세(B9)는 E1에서 기본 피드에서 빼자고 권장했다.
- 선택: 사용자가 권장을 뒤집어 남긴다 — `kr.news.feeds` 기본값에 `yna_market` 포함, 저장은 제목·링크·시각만(로컬 7일), 공개 저장소 고정본은 합성 자료 그대로.
- 이유: 사용자 결정(2026-10-27). 빼면 종목 사건이 공식 보도자료로만 얇아지고(G12 대안의 한계), 남기는 쪽은 설정 저장 한 번(판이 `settings_version`에 남음)으로 되돌릴 수 있다. 위험 문장은 [한국 책 명세](specs/2026-10-26-v2-kr-paper-spec.md) §7 G12·§4-12에 그대로 둔다.
