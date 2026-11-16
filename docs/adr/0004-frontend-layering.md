# 0004. 프런트엔드: 그리기 · 훅 · 순수 함수 · API 클라이언트 나누기

- 상태: 채택 (2026-09)
- 지키는 방법: `frontend/src/lib/__tests__/endpoints.test.ts`(경로 목록·docs/API.md 대조),
  `frontend/src/app/(dashboard)/__tests__/actions.test.tsx`(버튼 동작),
  `frontend/src/hooks/__tests__/*`, `frontend/src/lib/__tests__/*`
  - v2 1단계(아래 덧붙임): `components/patterns/__tests__/index.test.ts`(패턴 파일마다 배럴에 같은 이름, 배럴에 차트 없음),
    패턴의 네 상태 테스트(`components/patterns/__tests__/*` — 값 있음·값 없음·추정·오래됨), 화면의 네 상태 테스트
    (`components/screens/home/__tests__/HomeScreen.test.tsx`, `app/(dashboard)/__tests__/paperOverviewStates.test.tsx`·`paperStateHandling.test.tsx`),
    `lib/__tests__/nav.test.ts`(탭·하위 메뉴 표, 지금 탭, 탭 제목, 검색 메뉴 항목 — 셸은 그리기만)
  - v2 Coinbase식 개편(아래 두 번째 덧붙임): `components/ui/__tests__/icons.test.tsx`(아이콘 내보내기 목록·장식 aria-hidden·잠금만 이름),
    `lib/__tests__/noEmoji.test.ts`(화면 소스의 문자열·JSX 글자에 그림 문자 없음 — TypeScript AST), `components/ui/__tests__/formControls.test.tsx`(입력칸 모양·예전 포커스 표시 금지),
    `selectionClasses.test.ts`(고르기 조각 클래스), `pageHeader.test.tsx`(화면 머리 — 예전 h1 모양 금지), `lib/__tests__/lineChart.test.ts`·`hooks/__tests__/useChartScrub.test.ts`(문지르기),
    `components/charts/__tests__/frameBoundary.test.ts`(차트 틀 예외 — 차트 폴더 밖의 차트 하위 경로 가져오기는 계좌 색 표의 `frame` 하나, `frame.tsx`는 recharts 없음)
  - 작업대 화면 언어(아래 세 번째 덧붙임 — 공용 부품마다 한 줄): `components/ui/__tests__/DropdownMenu.test.tsx`(메뉴), `components/ui/__tests__/Tooltip.test.tsx`(툴팁),
    `components/patterns/__tests__/PropertyList.test.tsx`(속성 목록), `components/patterns/__tests__/KpiStrip.test.tsx`(KPI 띠),
    `components/patterns/__tests__/EntityHeader.test.tsx`(대상 머리), `components/patterns/__tests__/SplitPane.test.tsx`·`components/screens/search/__tests__/entityGridPin.test.ts`(칸 틀),
    `components/patterns/__tests__/MasterDetail.test.tsx`(목록-검사),
    `components/patterns/__tests__/SectionIndex.test.tsx`·`lib/__tests__/sectionIndex.test.ts`·`hooks/__tests__/useSectionSpy.test.tsx`(긴 화면 목차),
    `components/patterns/__tests__/InspectorFrame.test.tsx`(검사 칸 틀)

## 배경

- API 주소를 31개 파일이 제각각 만들었습니다. 같은 종류의 값을 어떤 곳은 인코딩하고 어떤 곳은
  그대로 붙여(`&`·공백이 들어가면 요청이 깨짐), 경로가 바뀌면 여러 파일을 찾아 고쳐야 했습니다.
- 버튼으로 서버를 부르는 화면 4곳이 같은 `busy`/`result`/`error`와 try/catch/finally를 반복했고,
  태스크 실행·완료 확인·경과 초 타이머가 화면 컴포넌트 안에 있었습니다.
- 날짜 합치기·순위·정렬 같은 데이터 가공이 컴포넌트 안에 있어 따로 테스트할 수 없었고, 같은
  날짜 합치기가 두 화면에 복사돼 있었습니다.

## 결정

| 층 | 위치 | 하는 일 | React |
|---|---|---|---|
| 화면 | `app/(dashboard)/**`, `components/**` | 입력 상태와 그리기 | 씀 |
| 훅 | `hooks/` | 서버 읽기(`useApi`), 버튼 동작(`useAsyncAction`), 경과 초(`useElapsedSeconds`), 태스크 실행(`useTaskRunner`) | 씀 |
| 순수 함수 | `lib/chartData.ts`, `lib/transforms.ts`, `lib/format.ts`, `lib/marketCalendar.ts` … | 모르는 값 빼기, 날짜 합치기, 순위·정렬, 표기 | 모름 |
| API 경로 | `lib/endpoints.ts` | 경로·쿼리 조립(값은 모두 인코딩) | 모름 |
| API 클라이언트 | `lib/api.ts` | fetch·쿠키·시간 제한·오류 종류 | 모름 |

규칙
1. 화면은 주소 문자열을 직접 만들지 않고 `endpoints`를 씁니다. 새 경로 함수를 만들면 테스트의
   CASES에 한 줄 추가합니다(모든 경로가 docs/API.md 표에 있는지도 함께 확인됨).
2. 서버를 부르는 버튼은 `useAsyncAction`을 씁니다(실패해도 앞 결과 유지, 화면을 떠난 뒤 끝나면 무시).
3. 데이터 가공은 순수 함수로 두고 테스트합니다. **모르는 값은 0으로 채우지 않고** 빼거나 "—"로 둡니다.
4. 작은 중복까지 모두 추상화하지 않습니다. 두 곳 이상에서 같은 규칙을 반복할 때만 뺍니다.

## 이유

- 주소가 한 곳에 있으면 인코딩 규칙이 하나이고, 경로 변경이 한 파일로 끝납니다.
- 훅과 순수 함수는 화면을 띄우지 않고 테스트할 수 있습니다. 화면 테스트는 "누르면 무엇이 보이는가"만 봅니다.

## 대안과 버린 이유

- **데이터 페칭 라이브러리(SWR·React Query)**: 이미 `useApi`가 동시 요청 묶기·자동 갱신·늦은 응답 무시를
  테스트로 고정하고 있어, 새 의존성을 들일 근거가 없었습니다.
- **API 클라이언트 자동 생성(OpenAPI)**: 백엔드가 스키마를 내보내지 않고, 경로 66개에 생성기를 들이는 비용이 큽니다.

## 결과(검증)

- 경로: 예전 조립식을 테스트에 그대로 옮겨 적어 새 함수와 "서버가 받는 경로·파라미터"가 같은지 38건 비교.
- 훅: 옮기기 전에 화면 동작을 렌더링 테스트 10개로 고정하고, 옮긴 뒤 같은 테스트가 그대로 통과.
- 순수 함수: 바꾸기 전후로 /krx·/macro·/style·/sector를 실제로 띄워 본문 글자와 차트 SVG 경로의 해시가 같음.
- 번들: `endpoints` 객체가 공용 청크에 들어가 경로마다 First Load JS가 약 1kB 늘었습니다.

## 덧붙임 — v2 1단계(2026-10-26): 화면 층을 패턴·셸·화면 조립으로 나눔

위 결정은 그대로이고 "화면" 층만 폴더로 나눴습니다([UI 설계 §2·§11](../specs/2026-10-26-v2-ui-design.md)).

- `components/patterns/`: 화면 패턴(자산 행·히어로·통계 타일·표·출처/추정/이전 값 배지·Empty). 빈값 `—`와 배지를 여기서 강제하고,
  화면은 배럴 `@/components/patterns` 하나로 가져옵니다. 표시 규칙(빈값 판정·부호·출처 글)은 `lib/`의 순수 함수입니다(규칙 3).
- `components/shell/`: 왼쪽 내비·하단 탭·상단바·하위 메뉴 줄. 메뉴 표·지금 탭·탭 제목은 순수 모듈 `lib/nav.ts`가 정하고 셸은 그리기만 합니다.
- `components/screens/<탭>/`: 화면 조립. 라우트 `page.tsx`는 화면 컴포넌트를 그리기만 합니다. 옛 화면은 4단계에 옮길 때까지 `app/(dashboard)/**`에 그대로.
- `components/ui.tsx`·`charts.tsx`는 `ui/index.tsx`·`charts/index.tsx`로 옮겼습니다(가져오는 지정자 그대로 — 테스트 mock이 그 지정자에 걸림).
- 서버 읽기는 그대로 훅(`useApi`, 브라우저)입니다. 설계서의 서버 컴포넌트 fetch를 하지 않은 이유는 [ARCHITECTURE §4-3](../ARCHITECTURE.md).

## 덧붙임 — v2 Coinbase식 개편(2026-11-01): 아이콘·클래스 모듈·문지르기 훅

위 결정과 1단계 덧붙임은 그대로이고, 같은 층 나누기 안에서 셋을 더했습니다([명세](../specs/2026-10-31-v2-coinbase-ui.md)).

- `components/ui/icons.tsx`: 이모지 대신 쓰는 인라인 SVG 아이콘(새 의존성 없음)과 `StatusDot`·`StatusText`·`StatusIcon`·`LineIcon`. 아이콘은 장식(aria-hidden)이고
  뜻은 글·sr-only 글이 나릅니다(잠금 아이콘만 이름). 셸의 아이콘 모듈은 탭 아이콘만 두고 나머지는 여기서 다시 내보냅니다.
- `components/ui/classes.ts`(와 `components/auth/classes.ts`): 단추·입력칸·고르기 조각(기간 알약·세그먼트·밑줄 탭·거르기 칩)·고른 행 막대의 클래스 문자열을
  React 없는 순수 모듈로 둡니다 — `"use client"`인 `ui/index.tsx`의 함수는 서버 컴포넌트(`/privacy`)에서 부를 수 없어서입니다. `@/components/ui`가 다시 내보냅니다.
- 차트 문지르기: 상태는 훅 `hooks/useChartScrub.ts`, 표시 값은 순수 함수 `lib/lineChart.ts`의 `scrubIndex`·`scrubModel`, 그리기는 `LineChart variant="hero"`와
  `Hero scrub`(차트는 여전히 `@/components/charts`에서만 — 예외 하나: 차트가 없는 화면이 계열 색 상수만 쓸 때는 recharts를 가져오지 않는 차트 틀
  `@/components/charts/frame`에서 `SERIES_COLORS`를 가져와도 됩니다. 모의매매 계좌 색 표 `components/screens/paper/bookColors.ts`가 그렇습니다 — 배럴에서
  가져오면 홈 '/'가 계좌 행 색 고리 때문에 recharts 조각을 실었습니다, 장중 명세 2026-10-31 §4-1). 서버·DB 글의 그림 문자 정리(`withoutLeadingIcon`)와 표시 모델(`holdingActionView`·`taskStatusView` 등)도 `lib/`입니다.

## 덧붙임 — 작업대 화면 언어(ADR 0042, 2026-11-16~): 새 공용 부품

위 결정과 앞의 두 덧붙임은 그대로이고, 작업대 화면 언어 개편([ADR 0042](0042-workbench-ui.md), [실행 명세](../specs/2026-11-15-v2-workbench-ui.md) §6·§8-2)이
공용 부품을 더할 때마다 여기에 한 줄씩 적습니다(부품 · 층 · 처음 쓰는 곳 · 지키는 시험).

- 메뉴 `components/ui/DropdownMenu.tsx` — 화면 층의 공용 키트(Radix DropdownMenu 2.2.1을 감쌈 — 덮개 3층·`data-overlay`·항목 좁은 화면 44px·넓은 화면 32px).
  메뉴(role=menu) 안에서 역할을 갖는 것은 항목·구분선뿐이고, 항목이 아닌 글은 `description`(항목 아래, 메뉴의 `aria-describedby`)에 둡니다. 이름표(`DropdownMenuLabel`)와
  막힌 항목(`disabled`)은 P6 '동작' 메뉴(데모 열람의 막힌 동작)가 처음 씁니다. 처음 쓰는 곳은 넓은 화면 상단바의 계정 메뉴(P3),
  지키는 시험은 `components/ui/__tests__/DropdownMenu.test.tsx`.
- 툴팁 `components/ui/Tooltip.tsx` — 화면 층의 공용 키트(Radix Tooltip 1.4.1을 감쌈 — 덮개 3층, 이름을 대신하지 않는 보조 설명, 툴팁 글이 이름과 같으면 `labelOnly`로
  설명 연결을 뺌, 셸의 `TooltipProvider` 하나 — 밖에서는 스스로 감쌈). 처음 쓰는 곳은 넓은 화면 셸(P3 — 상단바 아이콘 단추·접힌 왼쪽 메뉴의 탭 이름·접기 단추),
  지키는 시험은 `components/ui/__tests__/Tooltip.test.tsx`.
- 속성 목록 `components/patterns/PropertyList.tsx` — 화면 패턴(이름-값 두 칸 줄 — 값 없음 '—'와 사유·단위는 값이 있을 때만·추정/대리/이전 값 배지 늘 보임·
  고정폭 식별자·줄 출처, 값은 말줄임 없이 낱말 사이 줄바꿈, 넓은 화면 줄 32·28px — 데이터 칸 강조색 금지 목록 `lib/__tests__/accentInData.test.ts`).
  처음 쓰는 곳은 상세 3종의 왼쪽 칸·목록-검사 패턴의 검사 칸·홈 국면 패널의 신호 넷(P4), 지키는 시험은 `components/patterns/__tests__/PropertyList.test.tsx`.
- KPI 띠 `components/patterns/KpiStrip.tsx` — 화면 패턴(홈·모의 개요 44px 히어로 대신 — W7: 값 20·24px tabular-nums, 판정 라벨은 tabular 없이, '—'와 사유·배지 늘 보임,
  변화는 공용 변화 칩·상태는 공용 상태 글(아이콘 + 글), 바깥에서 온 숫자는 타일 아래 출처 줄(공용 출처 배지 — 출처·지연·시각·툴팁, 참고 시세 표기),
  `href`면 타일 전체가 중립 잉크 링크(좁은 화면 44px 하한 클래스) — 데이터 칸 강조색 금지 목록). 처음 쓰는 곳은 홈 맨 위 요약(P4),
  지키는 시험은 `components/patterns/__tests__/KpiStrip.test.tsx`.
- 대상 머리 `components/patterns/EntityHeader.tsx` — 화면 패턴(종류 아이콘 칸(장식) + 종류 글 태그·이름 h1(말줄임 없음)·고정폭 식별자 태그·주 값 하나 28px·
  변화(KPI 띠와 같은 구조화된 꼴 — 변화 칩 + 캡션, 또는 그린 요소)·배지 줄(비면 접힘)·동작 영역, `placeholder`는 값·배지 자리만 바꿈 — 데이터 칸 강조색 금지 목록).
  공용 `Tag`(`@/components/ui`)와 대상 종류 아이콘(`ChartLineIcon`·`CandlestickIcon`·`LandmarkIcon` — 상세 셋의 종류)을 씁니다. 상세 셋 밖의 종류(정보 검색의 회사·인물·주제,
  모의 계좌 등)는 부르는 쪽이 종류 글과 아이콘(`EntityKindSpec`)을 넘깁니다. 처음 쓰는 곳은 상세 3종의 맨 위(P4 — 지금 화면 머리 자리), 정보 검색 대상 화면은 겉모습이 달라 P7,
  지키는 시험은 `components/patterns/__tests__/EntityHeader.test.tsx`.
- 칸 틀 `components/patterns/SplitPane.tsx` — 화면 패턴(틀 — 왼쪽 속성 · 가운데 탭 · 오른쪽 연결·출처, lg 두 칸·xl 세 칸·lg 미만 한 칸, 읽는 차례는 늘 왼쪽 → 가운데 → 오른쪽,
  새 랜드마크 없음, 선택 `collapseLeft`는 lg 미만에서 왼쪽 칸을 처음에 접고 44px 펼치기 단추 하나 — 2026-11-16 결정 2, 상세 3종만). 넓은 화면 칸 틀 클래스 `ENTITY_FRAME`·`ENTITY_FRAME_LEFT`는 정보 검색 `search/entityGrid.ts`에서 글자 그대로 순수 모듈 `components/ui/classes.ts`로
  옮겼고 칸 틀 패턴과 정보 검색 entityGrid가 함께 가져갑니다(entityGridPin.test — 정보 검색 겉모습 고정, 정보 검색이 패턴 배럴을 싣지 않게 배럴 밖에 둠). 색 클래스가 없는 틀이라 데이터 칸 강조색 금지 목록에는 넣지 않습니다. 처음 쓰는 곳은 상세 3종(P4),
  지키는 시험은 `components/patterns/__tests__/SplitPane.test.tsx`·`components/screens/search/__tests__/entityGridPin.test.ts`.
- 목록-검사 `components/patterns/MasterDetail.tsx` — 화면 패턴(목록 `ul[data-shell-list]` + 넓은 화면 검사 칸(크기 질의 — 칸 폭 32rem 이상이면 옆 15rem, 스크롤 영역 위쪽에 붙음) /
  좁은 화면과 넓은 화면의 좁은 틀(32rem 미만 — ResizeObserver로 잼) 공용 `Dialog`(위쪽 고정) — Drawer는 만들지 않음, 고름이 포커스를 따라감(옆 검사 칸일 때), 목록 키는 `lib/shortcuts` `listKeyAction`(목록에 포커스가 있을 때만 —
  단축키 도움말 '목록' 묶음), roving tabindex, 고른 줄은 잉크 막대 `SELECTED_BAR` — 데이터 칸 강조색 금지 목록). 화면 층의 `hooks/useWideShell`·`ui/Dialog`를 씁니다.
  처음 쓰는 곳은 상세 화면의 보유 탭(P4), 모의매매 목록 + 검사 칸(P6)도 이것을 씁니다(모의매매 전용으로 만들지 않음 — 명세 §6). 지키는 시험은
  `components/patterns/__tests__/MasterDetail.test.tsx`·`lib/__tests__/shortcuts.test.ts`·`components/shell/__tests__/ShortcutHelp.test.tsx`.
- 목차 `components/patterns/SectionIndex.tsx` — 화면 패턴(긴 화면 목차 `SectionIndex`와 절 닻 `SectionAnchor` — `columnFrom`(lg·xl) 이상은 왼쪽 13rem 세로 목록(하위 칸
  들여씀, 스크롤 영역 위쪽에 붙음), 그 아래는 본문 위에 붙는 가로 줄(첫 단계 칸만, 밑줄 탭 모양 — 좁은 화면 44px), 이름 있는 내비 하나·칸은 같은 화면 절 링크·
  지금 칸 aria-current="location", 개수는 숫자일 때만). 지금 절은 화면 층 훅 `hooks/useSectionSpy`(IntersectionObserver — 뷰포트 위 34% 띠)와 순수 규칙
  `lib/sectionIndex`(하위 칸이 부모보다 앞인 고르는 차례)가 정합니다. 내비라 지금 칸 막대·밑줄에 강조 파랑을 써서 데이터 칸 강조색 금지 목록에는 넣지 않습니다.
  처음 쓰는 곳은 매크로(P5a — 절 주소의 정본은 `lib/marketSections`), P6 프레임·설정, P7 저장소 상태. 지키는 시험은
  `components/patterns/__tests__/SectionIndex.test.tsx`·`lib/__tests__/sectionIndex.test.ts`·`hooks/__tests__/useSectionSpy.test.tsx`.
- 검사 칸 틀 `components/patterns/InspectorFrame.tsx` — 화면 패턴(줄 안에 조작이 있는 표·목록 + 고른 줄의 옆 검사 칸 또는 공용 `Dialog`(위쪽 고정) — 배치 md(틀 32rem부터 옆 15rem)·
  lg(52rem부터 옆 18rem)·dialog(늘 대화상자), 줄 단추 `InspectorTrigger`(중립 잉크·좁은 화면 44px), 표에는 `shownKey`를 고른 행으로 넘김, 기본 키(`defaultKey` — 콜백 없음)·
  자료에서 사라진 키 안내·Esc(사용자가 고른 것만 풂)·대화상자 배치에서 옆 칸 배치로 바뀌면 열린 키를 고름 — 목록-검사의 QA-590과 같은 규칙). 틀 폭 재기는 화면 층 훅
  `hooks/useSideBySide`를 목록-검사(`MasterDetail`)와 함께 씁니다(기준 폭 인자). 줄 전체가 단추인 목록은 `MasterDetail`, 줄 안에 링크·단추가 있는 표는 이 틀입니다.
  데이터 칸 강조색 금지 목록에 넣습니다. 처음 쓰는 곳은 매크로 지표 표(lg)·섹터 표(dialog)(P5a), P5b 보유 표·P6 계좌 비교 표가 같은 틀을 씁니다.
  지키는 시험은 `components/patterns/__tests__/InspectorFrame.test.tsx`.
