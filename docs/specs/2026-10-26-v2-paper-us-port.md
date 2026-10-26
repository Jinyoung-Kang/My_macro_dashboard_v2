# v2 1단계 — 모의매매(미국) 이식 대조표

- 작성: 2026-10-26 · 상위 문서: [UI/UX 설계서](2026-10-26-v2-ui-design.md) §7 "모의매매(미국)"·§9 DoD, [프로그램 계획서](2026-10-26-v2-program-plan.md) §4 1단계
- 목적: DoD "기존 화면의 기능 목록을 전부 덮었다(표로 대조)"를 확인할 수 있게, 이식 전 7탭 화면(`/paper`)의 기능 74개가 새 화면(`/paper/us/*`)의
  어디에 있고 어떤 테스트가 지키는지 한 줄씩 적는다. 기능 목록은 이식 전 조사(main `c9ab96c` 기준)를 그대로 옮겼다.

## 1. 바뀐 것 요약

**경로.** 개요는 `/paper/us`, 나머지 여섯 탭은 `/paper/us/<탭 키>`(selection·holdings·decisions·framework·notes·settings — `lib/paperRoutes.ts`).
옛 `/paper`는 `next.config.mjs`가 `/paper/us`로 **임시(307)** 리디렉션한다 — 2단계에 `/paper/kr`이 생기면 `/paper`를 시장 고르는 화면으로 쓸 수 있게
영구(308)로 두지 않았고, `/paper/:path*`는 `/paper/us`까지 맞아 반복 리디렉션이 되므로 쓰지 않았다. 이 줄은 LT/nextConfig가 Next와 같은 경로 맞추기
(`getPathMatch`)로 지킨다(정확히 `/paper` 하나·임시·어떤 source도 `/paper/us` 아래에 맞지 않음). 모르는 탭 조각은 404(`dynamicParams = false` + `notFound()`).
셸의 모의매매 탭·하위 메뉴 "미국"은 `/paper/us`(`lib/nav.ts`), 회원 숨김은 `lib/access.ts`의 앞부분 일치(`/paper`)가 그대로 덮는다.
`/paper/us/<탭>`에서 하위 메뉴 "미국"(누르면 개요로 감)의 `aria-current`는 `"page"`가 아니라 `"true"`(이 화면 안 — 탭 링크의 `tabCurrent`와 같은 규칙,
`SubNavModel.currentAria`). 화면 안 시장 고르기의 "미국"은 링크가 아닌 표시라 `aria-current="true"`.

**탭과 주소.** 7탭은 예전 마크업 그대로(`role=tab` 단추·`paper-tab-*`·`aria-controls="paper-tabpanel"`·click). 라우트가 처음 탭을 넘기고(`initialTab`),
화면 안에서 탭을 바꾸면 `window.history.replaceState`로 주소만 바꾼다(라우터 이동이 아니라 섹션을 다시 읽지 않음, 뒤로 가기 기록 없음). 셸의 링크로 주소가
바뀌면(`usePathname`) 그 주소의 탭으로 맞춘다. 탭을 바꾸면 섹션이 언마운트되어 입력 초안이 사라지는 것은 예전과 같다.

**새 패턴.**
- 개요: 계좌 카드 네 장 → **계좌 행**(`AssetRow` + 새 선택 prop `disclosure` — 펼침 단추: `id`·`aria-expanded`·`aria-controls`, 단추 이름은
  계좌 이름 + "상세 보기"뿐(`aria-labelledby`)이고 소개·순자산·칩·배지는 설명(`aria-describedby`) — 옛 BookCard가 피하던 "카드 숫자 전부가 단추
  이름"을 행 단추에서도 피함) + **계좌 비교 표**(`DataTable`, 줄 = 항목·열 = 계좌, 항목 칸은 행 머리 `th scope="row"` — 새 선택 prop
  `Column.rowHeader`) + 표 아래 **표본 설명** 목록. 옛 카드의 "숫자를 끌어 고르는(복사하려는) 중이면 열지 않음" 예외는 없앴다 — 행 전체가 단추라
  행의 숫자는 끌어 고를 수 없고, 같은 값은 계좌 비교 표에서 복사한다. 순자산 곡선에 **기간 탭**(`RangeTabs` — 저장된 기록보다 긴 기간은 그리지 않음, 출발 직후처럼
  '전체'뿐이면 탭 없음). 탭 위에 **시장 고르기**(미국 = 지금 화면, 한국 · 준비 중 = 누를 수 없음 + "2단계").
- 표: 보유·재진입 금지·주문·체결(보유·체결 탭), 선정 이력·신호 풀·구간(기관 선정 탭)을 `DataTable`로. 모르는 칸은 Empty("—" + 읽어 주는 "값 없음").
  보유 표만 정렬 단추(종목·수량·평가액·비중·평가 손익). 옛 `Table`의 폰 안내 줄("← 표를 좌우로 넘겨 보세요", 640px 미만에서만)과 최소 폭 640px는
  새 선택 prop `DataTable.scrollHint`로 그대로 두었고(이 일곱 표와 계좌 비교 표), 모든 칸의 `tabular-nums`도 옛 표처럼 DataTable 전체에 둔다.
- 확인 창: 설정의 **규칙 계좌 영향 키** 저장과 **계좌 초기화**(계좌 코드를 그대로 쳐야 열림 — `requireText`)를 `ConfirmDialog`로. 초기화의
  `confirm`은 사람이 친 글자 그대로다(`onConfirm(typed)` — 새로 더한 인자, 인자를 쓰지 않는 쪽은 그대로) — 화면이 계좌 코드를 대신 채워 보내면
  서버의 "confirm == 계좌 코드" 재검사가 늘 통과해 두 번째 울타리가 되지 못한다. 두 창 모두 처리 중에는 닫히지 않고, 결과가 나온 뒤(성공·실패
  모두) 닫힌다 — 실패 사유(서버 400 문구)는 화면의 경고로 남고 초점은 연 단추로 돌아간다. 설정 저장이 성공하면 바꿀 값이 비어 "설정 저장"이 막히므로
  초점을 저장 결과로 옮긴다(연 단추로 돌아갈 수 없어 초점이 body로 떨어지던 것 — 옛 인라인 확인에도 있던 일).

**1단계에 그대로 둔 것(이유).**
- 인라인 확인: 규칙 계좌 시작, Claude 미리보기·시작, Claude 수동 결정, 주간 복기 수동 실행, 제안 요청·승인·거절, 프레임 직접 고치기 저장, 메모 보관 —
  확인 박스가 결과 배너 바로 옆에 있어야 읽히는 흐름이라 이번 범위(설정·초기화) 밖으로 두었다.
- 기관 선정의 후보 표(그룹 A·B): 행 아래에 구간 표를 펼치는 표라 `DataTable`(행 아래 펼침 없음)로 옮기지 않았다. 결정 로그·복기·프레임·메모의 표,
  개요의 신호 풀·작업 기록 표, OS 게이트 지표(`GateIndicatorBody`)·Claude 결정 본문(`ClaudeDecisionBody`)의 표, 계좌 상세의 구성·최근 체결 표,
  설정의 바꾼 기록 표도 옛 `Table` 그대로다(4단계 정리 대상).
- 하드코딩 색: 남은 16진 색은 전부 차트 계열색(계좌 선 색·구성 도넛 색, dataviz 검증기 통과값)이다. 바탕·글자색은 토큰.

## 2. 대조표

줄임말: **옛** 위치는 `c9ab96c`의 `frontend/src/app/(dashboard)/paper/`(P/)·`frontend/src/lib/`(L/) 줄 번호. **새** 위치의 S/ = `frontend/src/components/screens/paper/`.
테스트의 T/ = `frontend/src/app/(dashboard)/__tests__/`, LT/ = `frontend/src/lib/__tests__/`, PT/ = `frontend/src/components/patterns/__tests__/`,
UT/ = `frontend/src/components/ui/__tests__/`, SH/ = `frontend/src/components/shell/__tests__/` — 이름은 `it` 제목의 앞부분. 상태 처리 줄임말: L(로딩)·E(오류+다시 시도)·U(`available:false` 서버 문구)·
Rf(자동 갱신 실패 → "새로 읽지 못함"). "(없음)"은 이식 전에도 화면 테스트가 없던 곳 — §3. 상태 표기는 인용한 테스트가 실제로 지키는 것만이고,
지키는 테스트가 없는 상태는 "· L·E (없음)"처럼 따로 적는다.

### 개요(`/paper/us`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| O1 | 제목 "모의 알고리즘 매매(미국)", 네 계좌 설명 + 출발일, L·E·Rf | overview GET(60초) | P/page.tsx:37,54-67 | S/PaperScreen 머리 · 라우트 `app/(dashboard)/paper/us/page.tsx` | T/paperOverviewStates «미국은 지금 화면…제목은 그대로», T/paperRoutes «/paper/us: 개요를 처음 탭으로» · L·E·Rf (없음) |
| O2 | 장부 없음 → 서버 문구만, 탭·카드·버튼 없음 | overview | page.tsx:69,71 | S/PaperScreen | T/paperStateHandling «서버 문구를 그대로 보이고, 탭·계좌 행·버튼은…», T/paperOverviewStates «장부가 없으면(available:false)…» |
| O3 | '이 장부의 한계' 카드 | overview.limits | page.tsx:73-81 | S/PaperScreen | T/paperStateHandling «한계 문구와 '초기화' 버튼을…» |
| O4 | 7탭 바(+ opensIn 배너) | — | page.tsx:83-125; L/paper.ts:107-118 | S/PaperScreen(마크업 그대로 + replaceState) · 라우트 `paper/us/[tab]/page.tsx` · `lib/paperRoutes.ts` | T/paperStateHandling «보유·체결 탭은 책이 없다고 안내…»(7탭 순서), T/paperRoutes 전부, LT/paperRoutes, LT/nextConfig 전부(옛 `/paper` 리디렉션), LT/nav «모의매매: 운영자에게는…»·SH/Shell «모의매매 탭 주소(/paper/us/holdings)에서는…»(하위 메뉴 aria-current), LT/paperDecisions·LT/paperFramework(PAPER_TABS) |
| O5 | 정기 작업 꺼짐 배너(status 실패는 무시) | status GET(60초) | P/OverviewSection.tsx:94,184-189 | S/OverviewSection | T/paperStateHandling «정기 작업이 꺼져 있으면…», T/paperOverviewStates «상태 응답이 실패해도…»·«상태 응답이 오면 꺼짐 배너…» |
| O6 | 장부 초기화 카드 / '벤치마크 사후 체결 대기' 카드, 결과 유지 | init POST | Overview:96,121-123,191-205 | S/OverviewSection(그대로) + 계좌 행 경고 "출발일 종가 대기" | T/paperStateHandling «한계 문구와 '초기화'…»·«초기화가 실패하면…»·«종가가 없어 init이 200 + skipped…»·«처음 연 개요가 pendingBackfill…», T/paperOverviewStates «사후 체결을 기다리는 벤치마크 행에 경고…», LT/paper |
| O7 | 규칙 계좌 시작(인라인 확인), 결과 유지 | runInitialDecision POST `{book}` | Overview:101-106,127-132,207-231 | S/OverviewSection(그대로) | T/paperDecisions «시작 전이면 카드와 버튼…»·«수집 중이라 서버가 거절(400)…»·«규칙 책이 이미 시작했으면…», LT/paperDecisions |
| O8 | Claude 계좌 시작 카드(미리보기·시작, 인라인 확인) | framework GET; runInitialDecision POST | P/ClaudeStartSection.tsx:37-136 | S/ClaudeStartSection(그대로) | T/paperClaude «시작 전이면 카드…»·«미리보기 — 확인…»·«미리보기가 실패하면…»·«시작 — 확인…»·«이미 시작했으면 카드가 없다», LT/paperClaude |
| O9 | 계좌 카드 4개: 상태·종류·출발·처음 현금·소개·순자산·수익률·노출·현금·보유 수·마지막 관측·가격 없음 경고·통계 7칸·표본 설명, 부제에 설정 버전 | overview.books; status.settingsVersion | Overview:235-278,516-598; L/paper.ts:208-261 | S/OverviewSection — **계좌 행**(이름·종류·상태·소개·순자산·수익률 칩·이전 값 배지·사후 체결 경고), **계좌 비교 표**(상태·종류·출발·처음 현금·순자산·수익률(출발 이후)·주식 노출·현금·보유·마지막 관측·가격 없음·통계 7줄·비교 기준), **표본 설명** 목록, '계좌' 카드 부제의 설정 버전 · `lib/paperOverview.ts` | T/paperStateHandling «계좌 행·계좌 비교 표의 null은 '—'…», T/paperOverviewStates 전부(값 있음·없음·일부 실패·추정·오래됨 — «네 계좌 행…»이 항목 칸의 행 머리·폰 안내 줄도), PT/DataTable «rowHeader 열은 행 머리…»·«scrollHint —…», T/paperAccountDetail «계좌 행에는 계좌마다 한 줄 소개…», LT/paperOverview «계좌 행»·«계좌 비교 표», LT/paper «책 카드», PT/AssetRow «disclosure…» |
| O10 | 리스크 지금 실행(ok:false 경고·오류·메모 목록) | runRisk POST | Overview:97,124-126,241-250,441-465 | S/OverviewSection '계좌' 카드 동작 단추(그대로) | T/paperStateHandling «ok:false…»·«ok:true면 경고 없이…», LT/paper |
| O11 | 계좌 상세 열기·닫기(한 번에 하나, 초점·Esc·스크롤) | — | Overview:70-72,108-119,135-142,530-560 | S/OverviewSection 계좌 행(`AssetRow` disclosure: `paper-account-toggle-{code}`·`aria-expanded`·`aria-controls="paper-account-detail"`, 단추 이름 = 계좌 이름 + "상세 보기"·나머지는 `aria-describedby`) + S/AccountDetailPanel. **바뀜**: 끌어 고르기 예외 제거 — 숫자 복사는 계좌 비교 표에서(§1) | T/paperAccountDetail «계좌 행 단추는 진짜 button…»·«행 어디를 눌러도 열리고…»·«'닫기'와 Esc로…»·«A11Y-1…»·«A11Y-3…», T/paperOverviewStates «네 계좌 행…»(정확한 단추 이름), PT/AssetRow «disclosure — 펼침 단추…»(정확한 이름 + 설명)·«disclosure — 안내 글이 없거나…» |
| O12 | 상세: 정의 + 지금 설정 값 | settings GET(1회) | P/AccountDetailPanel.tsx:84-149 | S/AccountDetailPanel(그대로) | T/paperAccountDetail «정의·지금 설정·핵심 숫자…»·«설정을 읽지 못하면…», LT/paperAccount |
| O13 | 상세: 핵심 숫자 7타일(보유 응답의 책 우선) | positions GET(60초) | AccountDetailPanel:81-87,151-165 | S/AccountDetailPanel(그대로) | T/paperAccountDetail «정의·지금 설정·핵심 숫자…», T/paperOverviewStates «계좌 상세의 보유 응답이 실패하면…»(개요 값으로) |
| O14 | 상세: 구성(도넛 / 한 줄 막대 / 표), L·E·U | positions | AccountDetailPanel:90-92,168-180,227-328 | S/AccountDetailPanel(그대로, 도넛 틈 색 = 토큰 `--bg`) | T/paperAccountDetail «묶음이 셋 이상이면 도넛…»·«의미 있는 묶음이 둘 이하…», T/paperOverviewStates «계좌 상세의 보유 응답이 실패하면 구성 칸만 오류…»(E), LT/paperAccount · L·U (없음) |
| O15 | 상세: 최근 체결 5건 + '보유·체결 탭에서 전체 보기'·'결정 로그 보기' | fills(code,5) GET(60초) | AccountDetailPanel:82,182-220 | S/AccountDetailPanel → PaperScreen.openTab(주소도 그 탭으로) | T/paperAccountDetail «최근 체결은 다섯 건만…»·«'보유·체결 탭에서 전체 보기'…»·«규칙·Claude 계좌의 '결정 로그 보기'…», T/paperRoutes «계좌 상세의 '보유·체결 탭에서 전체 보기'도 주소를…» |
| O16 | 순자산 곡선 + 프레임 판 경계 | overview.navSeries·frameworkBoundaries | Overview:143-149,180,280-294 | S/OverviewSection '순자산 곡선' + 기간 탭(`RangeTabs`, 경계선은 고른 기간 안만·한 줄 글은 전체 기준) | T/paperStateHandling «계좌 행·계좌 비교 표의 null…»(계열 순서), T/paperFramework «순자산 곡선에 경계선…»·«경계가 없으면…», T/paperOverviewStates «출발 직후(며칠치)면 기간 탭이 없다…»·«기록이 길면 저장 구간 안의 기간만…», LT/paper, LT/paperFramework, LT/paperOverview «기간별 순자산 곡선» |
| O17 | Claude 노출 추이(목표 vs 실제) | overview.claudeExposureSeries | Overview:161-162,296-313 | S/OverviewSection(그대로) | T/paperClaude «목표 vs 실제 두 선…»·«기록이 없으면…», LT/paperClaude |
| O18 | Claude 호출 사용량 | status.apiUsage | Overview:163,315-331,468-479 | S/OverviewSection(그대로) | T/paperClaude «상태 응답의 오늘 호출/상한…»·«상태 응답에 사용량이 없으면…», LT/paperClaude |
| O19 | 신호 기관(그룹 A·B 목록, 신호 풀 표) | overview.selection | Overview:159,333-380,482-507 | S/OverviewSection(그대로) | T/paperDecisions «두 그룹(그룹 안 순위 순)…»·«게이트·선정 기록이 없으면…»·«그룹 B가 비면…»·«두 그룹이 모두 비면…», LT/paperDecisions, LT/paperBlend |
| O20 | OS 게이트 지표(참고) | overview.gate | Overview:382-384; P/GateIndicatorBody.tsx | S/GateIndicatorBody(그대로) | T/paperDecisions «두 그룹…»·«게이트·선정 기록이 없으면…», LT/paperDecisions |
| O21 | 장부 관측치 + 재무·일정·뉴스·어닝 한 줄씩 | overview.quotes; status.* | Overview:150-178,387-405 | S/OverviewSection(그대로) + 늦은 저장본이면 계좌 행 '이전 값' | T/paperStateHandling «계좌 행·계좌 비교 표의 null…»(관측치 줄), T/paperClaude «상태 응답의 fundamentals…» 외 7개, T/paperOverviewStates «관측치 저장본이 늦으면…», LT/paper |
| O22 | 작업 기록 표(최근 10) | overview.jobs | Overview:407-432 | S/OverviewSection(그대로, 옛 `Table`) | (없음) — LT/paper(jsonSummary)만 |

### 기관 선정(`/paper/us/selection`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| S1 | 읽기, L·E·U | trackRecord GET(300초) | P/SelectionSection.tsx:67,83-86 | S/SelectionSection | T/paperSelection «테이블이 없으면(available:false)…» · L·E (없음) |
| S2 | 계산 전 → 안내 + 수집 진행률 카드(재계산 단추) | trackRecord | Selection:102-116 | S/SelectionSection(그대로) | T/paperSelection «수집 진행률만 보이고…» |
| S3 | 지금 재계산(경과 초·오류·결과) | runRerank POST `{}` | Selection:69-78,89-100,329-332 | S/SelectionSection(그대로) | T/paperSelection «POST /api/paper/run/rerank…»·«실패하면 서버 문구를…» |
| S4 | 그룹 A 후보 표(커버리지가 수익률보다 앞) + 행 펼치기 | trackRecord | Selection:118-156,339-497 | S/SelectionSection CandidateTable(자체 표 그대로 — §1) | T/paperSelection «커버리지 칸이 수익률 칸보다 먼저…»·«자격 있는 기관은…»·«자격 없음·수집 중인 행은…»·«행을 펼치면 구간 표…» |
| S5 | 구간 표 | candidates[].periods | Selection:500-528 | S/SelectionSection PeriodTable → `DataTable` | T/paperSelection «행을 펼치면 구간 표…»(빈 칸은 Empty)·«그룹 B 행을 펼치면…» |
| S6 | 그룹 B 카드(출처 q30/q8) | groupB | Selection:158-166,211-253 | S/SelectionSection GroupBCard(그대로) | T/paperSelection «그룹 B 표…»·«그룹 B 행…»·«그룹 B 행을 펼치면…»·«그룹 B를 아직 보내지 않는 백엔드…» |
| S7 | 신호 풀 카드 | pool·groupWeightA | Selection:168-174,256-295 | S/SelectionSection PoolCard → `DataTable` | T/paperSelection «신호 풀 — 기관·그룹 배지…»(빈 칸은 Empty)·«그룹 B를 아직 보내지 않는…» |
| S8 | 트랙레코드의 한계 | limits | Selection:123,176-184 | S/SelectionSection(그대로) | T/paperSelection «한계 문구 세 개…»·«한계에 '그룹 B는 2년 창…'» |
| S9 | 선정 이력 | selectionHistory | Selection:122,186-200 | S/SelectionSection → `DataTable` | T/paperSelection «한계 문구 세 개, 선정 이력…»·«…선정 이력은 그룹 B 이름도 찾는다» |
| S10 | 수집 진행률 | collection | Selection:202,298-327 | S/SelectionSection(그대로) | T/paperSelection «한계 문구 세 개, … 수집 진행률»·«수집 진행률만 보이고…» |

### 보유·체결(`/paper/us/holdings`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| H1 | 계좌 없음 안내 | — | P/HoldingsSection.tsx:91-93 | S/HoldingsSection(그대로) | T/paperStateHandling «보유·체결 탭은 책이 없다고 안내…» |
| H2 | 계좌 고르기(미리 고른 → 첫 시작 → 첫 계좌), 바꾸면 옛 표·결과 숨김 | — | Holdings:66-67,100-101,122-130 | S/HoldingsSection(그대로) | T/paperAccountDetail «'보유·체결 탭에서 전체 보기'…», T/paperStateHandling «운용 중인 책은 '일시정지'…», T/paperRoutes «initialTab으로 그 탭이 열린다…», LT/paper |
| H3 | 계좌 요약(상태·순자산·수익률·현금·노출·출발) | positions.book 우선 | Holdings:95-97,131-143 | S/HoldingsSection(그대로) | (없음) |
| H4 | 일시정지·재개(확인 없음) | bookStatus POST `{status}` | Holdings:73-77,103-105,146-163 | S/HoldingsSection(그대로) | T/paperStateHandling «운용 중인 책은 '일시정지'…», LT/paper |
| H5 | 계좌 초기화(계좌 코드 타이핑 확인, 서버 재검사, skippedReason 경고) | bookReset POST `{confirm}` | Holdings:78-82,106-112,165-190 | S/HoldingsSection → **`ConfirmDialog`**(`requireText` = 계좌 코드, danger, `confirm` = 친 글자 그대로 → 서버 재검사가 실제로 남음) | T/paperStateHandling «책 초기화는 확인 창에서…»·«책 초기화가 실패하면(서버 400)…»·«벤치마크를 다시 사후 체결하지 못하면…», UT/ConfirmDialog «정확히 같은 글자를 쳐야 확인이 열린다…»(onConfirm에 친 글자), LT/paper |
| H6 | 보유 표(가격 없음·지난 값·사후 체결·분할·현금성 배지, 주당 가격 4자리) | positions GET(60초) | Holdings:69,194-248 | S/HoldingsSection → `DataTable`(정렬 5열, `scrollHint`) | T/paperStateHandling «보유 표 — 가격을 모르는 보유는…»·«평단·가격·최고가·스탑가…4자리…»·«정렬 단추는 종목·수량·평가액·비중·평가 손익…», PT/DataTable, LT/paper · L·E·U (없음) |
| H7 | 재진입 금지 표 | positions.lockouts | Holdings:250-263 | S/HoldingsSection → `DataTable` | T/paperStateHandling «재진입 금지 표 — 종목·이 날까지…»(행·빈 사유 '—')·«보유 표 — …»(빈 메시지) |
| H8 | 주문 표(50건, 거절 사유, 근거 문장 먼저) | orders GET(60초) | Holdings:70,265-308 | S/HoldingsSection → `DataTable`(근거가 없으면 Empty) | T/paperStateHandling «규칙 책 주문의 근거는…»(근거 없음 = '—' 포함)·«보유 표 —…»(빈 메시지), LT/paper · L·E·U (없음) |
| H9 | 체결 표(50건, 사후 체결 배지·슬리피지) | fills GET(60초) | Holdings:71,310-346 | S/HoldingsSection → `DataTable` | T/paperStateHandling «보유 표 —…»(사후 체결)·«평단·가격·…4자리…» · L·E·U (없음) |
| H10 | 세 응답의 Rf를 한 배지로 | — | Holdings:119 | S/HoldingsSection(그대로) | (없음) |

### 결정 로그(`/paper/us/decisions`) — 결정 기록 보기

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| D1 | 결정을 내는 계좌가 없음 → 안내 | — | P/DecisionsSection.tsx:92,106-108 | S/DecisionsSection(그대로) | (없음) |
| D2 | 보기 전환(결정 기록 / 주간 복기, aria-pressed) | — | Decisions:90,110-137 | S/DecisionsSection(구조 그대로, 고른 쪽 모양만 토큰 — 7탭 바와 같음) | T/paperReviews 전부(이 전환으로 들어감) |
| D3 | 계좌 고르기(규칙·Claude만) | — | Decisions:91-92,163-171 | S/DecisionsSection(그대로) | T/paperDecisions «규칙 책이 기본이고…», T/paperAccountDetail «규칙·Claude 계좌의 '결정 로그 보기'…» |
| D4 | 지금 결정 실행(규칙 확인 없음 / Claude 인라인 확인) | runDecision POST `{book}` | Decisions:95-104,139-194 | S/DecisionsSection(그대로) | T/paperDecisions «Claude 책은 결정 안내…»·«지금 결정 실행 — POST…»·«수동 결정이 실패하면…», T/paperClaude «다른 결정이 돌고 있어…»·«지금 결정 실행은 비용 안내와 확인을…»·«'지금 결정 실행'을 막고…» |
| D5 | 결정 기록 표(50건, Claude면 목표 노출 칸) | decisions GET(60초) | Decisions:93,196-207,220-326 | S/DecisionsSection(그대로, 옛 `Table`) | T/paperDecisions «규칙 책이 기본이고…»·«기록이 없으면 안내…», T/paperClaude «목록에 목표 노출 칸…» |
| D6 | 행 펼치기 → 상세 읽기 | decision(id) GET | Decisions:333-341 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면 상세…» |
| D7 | 상세 머리 메타·오류 | — | Decisions:363-371 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면 상세…» |
| D8 | Claude 본문(판단·제안 주문·검증·관찰·사용량) | — | Decisions:343-350,373; P/ClaudeDecisionBody.tsx | S/ClaudeDecisionBody(그대로) | T/paperClaude «목록에 목표 노출 칸…»·«응답이 없으면…»·«건너뛴 기록…»·«결정 중 일시정지된 기록…», LT/paperClaude |
| D9 | 처리 메모 | — | Decisions:375-381 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면 상세…» |
| D10 | 선정(신호 풀·그룹 A/B 순위표·섞기 전 순위표) | — | Decisions:383-429,592-615 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면 상세…»·«두 그룹을 섞은 뒤 기록…»·«섞기 전 기록에는…», LT/paperBlend |
| D11 | 규칙 표(13F 이벤트·매수 후보·점수 기여·전량 매도) | — | Decisions:431-510 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면…»·«두 그룹을 섞은 뒤…»·«섞기 전…»·«규칙 책 모양이 아닌 기록은…», LT/paperDecisions, LT/paperBlend |
| D12 | 주문 표 / 고르지 못한 후보 / 게이트(축약판) | data.orders | Decisions:512-567 | S/DecisionsSection(그대로) | T/paperDecisions «행을 펼치면 상세…», T/paperClaude «결정 중 일시정지된 기록…» |
| D13 | 원본 JSON·모델 응답 원문·입력 패킷(접힘, details) | — | Decisions:357-359,569-586 | S/DecisionsSection(그대로) | T/paperDecisions «규칙 책 모양이 아닌 기록은…», T/paperClaude «응답이 없으면…»·«결정 중 일시정지된…» |

### 결정 로그 › 주간 복기(같은 주소 `/paper/us/decisions`, 보기 전환)

설계서 §7은 '복기'를 따로 적지만 1단계는 결정 로그 안의 보기 전환을 그대로 둔다(결정을 내는 계좌가 없으면 복기로 갈 수 없는 D1 동작과 T/paperReviews의 들어가는 길을 지킴).

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| R1 | 읽기, L·E·U·Rf | reviews GET(60초) | P/ReviewsSection.tsx:38,73-77 | S/ReviewsSection(그대로) | T/paperReviews «복기 테이블이 아직 없으면…»(U) · L·E·Rf (없음) |
| R2 | 일정 안내 + 가장 최근 주 안내 | latestWeekEnding·latestOpensAtKst | Reviews:62,82-83 | S/ReviewsSection(그대로) | T/paperReviews «목록(서버 값 그대로…» |
| R3 | 지금 복기 실행(인라인 확인, 400·429 문구) | runReview POST | Reviews:41-47,64-71,84-102 | S/ReviewsSection(그대로) | T/paperReviews «수동 실행은 확인(비용·하루 상한) 뒤…» |
| R4 | 복기 기록 표(52주): 보기·상태·창·판정 수·제안 링크 | reviews | Reviews:105-156 | S/ReviewsSection(그대로) | T/paperReviews «목록(서버 값 그대로…»·«목록의 제안 칸도 같은 링크…» |
| R5 | 고른 주 상세(판정 표·누락·반복 오류·지킬 것·제안·사용량·입력·응답) | review(week) GET | Reviews:49-59,158-169,174-261 | S/ReviewsSection(그대로) | T/paperReviews «목록(서버 값 그대로…»·«목록이 갱신돼…»·«다른 주를 고르면…»·«제안 링크를 누르면 프레임 탭으로…»(주소도 /paper/us/framework) |

### 프레임(`/paper/us/framework`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| FW1 | 읽기, L·E·U | framework·proposals·settings GET | P/FrameworkSection.tsx:83-86,96-99 | S/FrameworkSection(그대로) | T/paperFramework «판 표가 아직 없으면…»(U) · L·E (없음) |
| FW2 | 지금 프레임 카드(배지·임시 안내·토큰 어림/예산·바꾼 내용·렌더링 접힘) | framework | Framework:101-102,152-188 | S/FrameworkSection(그대로) | T/paperFramework «임시 v0 — 배지·안내…»·«사용자 판 — 예산 초과…», LT/paperFramework |
| FW3 | OS 원문(임시 판) / 방법론 글(사용자 판)로 제안 요청(인라인 확인) | notes GET; createNote POST; propose POST | Framework:197-343 | S/FrameworkSection(그대로) | T/paperFramework «원문 → 메모 저장 → 확인(비용)…»·«제안 요청이 실패하면…»·«F1 사용자 판이면…», LT/paperFramework |
| FW4 | 제안 목록 + 복기에서 온 제안 강조(`paper-proposal-{id}`·aria-current·스크롤) | proposals | Framework:87-94,115-142 | S/FrameworkSection(그대로) ← PaperScreen.openProposal(주소도 이 탭으로) | T/paperReviews «제안 링크를 누르면 프레임 탭으로…»·«목록의 제안 칸도 같은 링크…» |
| FW5 | 제안 한 건: 승인·거절(인라인 확인), 기준 판 경고 | approve·reject POST; frameworkVersion GET | Framework:353-489 | S/FrameworkSection(그대로) | T/paperFramework «원문 → …승인…»·«기준 판이 지금 판과 다르면…»·«FW-3·F2…»·«FW-4…», LT/paperFramework |
| FW6 | 판 목록·두 판 비교 | frameworkVersion GET ×2 | Framework:495-621 | S/FrameworkSection(그대로) | T/paperFramework «임시 v0…»·«사용자 판…», LT/paperFramework |
| FW7 | 직접 고치기(글자 수·판 바뀜 경고, 인라인 확인) | saveFramework POST | Framework:630-843 | S/FrameworkSection(그대로) | T/paperFramework «규칙 글자 수(300자)…»·«FW-1 다른 창에서 판이 생겨…», LT/paperFramework |

### 메모(`/paper/us/notes`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| N1 | 목록 + '만료한 메모도 보기' + 출발일 안내 | notes GET | P/NotesSection.tsx:39-40,76-143 | S/NotesSection(그대로) | T/paperFramework «목록은 서버 상태 그대로…» |
| N2 | 보관(행마다 인라인 확인, ok:false 경고) | archiveNote DELETE | Notes:48-51,67-71,127-158 | S/NotesSection(그대로) | T/paperFramework «보관 — 확인 뒤 DELETE…» |
| N3 | 메모 쓰기(성공했을 때만 입력 비움) | createNote POST; settings GET | Notes:41-66,161-246 | S/NotesSection(그대로) | T/paperFramework «쓰기 — 만료 기본 안내는 설정값…»·«F4 기준일 칸에…», LT/paperFramework |

### 설정(`/paper/us/settings`)

| # | 기능 | 엔드포인트 | 옛 위치 | 새 위치 | 지키는 테스트 |
|---|---|---|---|---|---|
| ST1 | 읽기·버전 부제, L·E·U | settings·settingsHistory GET | P/SettingsSection.tsx:38-53,86-92 | S/SettingsSection(그대로) | T/paperSettings «테이블이 없으면…»(U)·«키마다 지금 값…» · L·E (없음) |
| ST2 | 바꿀 값·형 오류 수·저장·되돌리기, 규칙 계좌 영향 키 확인, 서버 400·warning | saveSettings POST | Settings:41-83,99-143 | S/SettingsSection — 규칙 계좌 영향 키 확인 → **`ConfirmDialog`**(처리 중 닫히지 않음, 끝나면 닫힘), 저장에 성공하면 초점 → 저장 결과 | T/paperSettings «규칙 책에 영향 없는 키는 바로 저장…»·«규칙 책 영향 키는 저장 전에…»·«확인 창에서 저장에 성공하면 초점은 저장 결과로…»·«규칙 책 영향 키 저장이 실패하면(서버 400)…»(초점은 연 단추로)·«확인을 연 뒤 값을 또 바꾸면…»·«숫자가 아니면…»·«되돌리기는…», UT/ConfirmDialog, LT/paperSettings |
| ST3 | 키별 입력(체크·선택·목록·json 읽기 전용·숫자), 배지 | settings | Settings:146-165,198-332 | S/SettingsSection(그대로) | T/paperSettings «회귀(B-SET-UI-1)…»·«키마다 지금 값…», LT/paperSettings |
| ST4 | 바꾼 기록 표 | settingsHistory | Settings:167-192 | S/SettingsSection(그대로, 옛 `Table`) | T/paperSettings «키마다 지금 값·…바꾼 기록 표…», LT/paperSettings |

## 3. 남은 공백(이식 전에도 화면 테스트가 없던 곳)

- 읽기 상태: O1의 L·E·Rf, O14 구성 칸의 L·U, S1의 L·E, R1의 L·E·Rf, FW1·ST1의 L·E, H6·H8·H9 보유·주문·체결 표의 L·E·U
  (화면 테스트 가운데 '다시 시도'를 단언하는 것은 O14의 E 하나뿐), H10 세 응답의 Rf 배지.
- 그 밖: O22 작업 기록 표(픽스처가 모두 `jobs: []`), H3 계좌 요약, D1 결정 계좌 없음 안내.

모두 이번 이식에서 동작을 바꾸지 않은 곳이고, 4단계의 e2e 또는 다음 모의매매 작업에서 메운다. 이식 리뷰에서 나온 H7 재진입 금지 표의 행 렌더링과
보유 표 정렬은 이번에 테스트를 더해 메웠다(H6·H7).
