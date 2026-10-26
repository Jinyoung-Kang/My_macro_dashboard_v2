# 0004. 프런트엔드: 그리기 · 훅 · 순수 함수 · API 클라이언트 나누기

- 상태: 채택 (2026-09)
- 지키는 방법: `frontend/src/lib/__tests__/endpoints.test.ts`(경로 목록·docs/API.md 대조),
  `frontend/src/app/(dashboard)/__tests__/actions.test.tsx`(버튼 동작),
  `frontend/src/hooks/__tests__/*`, `frontend/src/lib/__tests__/*`
  - v2 1단계(아래 덧붙임): `components/patterns/__tests__/index.test.ts`(패턴 파일마다 배럴에 같은 이름, 배럴에 차트 없음),
    패턴의 네 상태 테스트(`components/patterns/__tests__/*` — 값 있음·값 없음·추정·오래됨), 화면의 네 상태 테스트
    (`components/screens/home/__tests__/HomeScreen.test.tsx`, `app/(dashboard)/__tests__/paperOverviewStates.test.tsx`·`paperStateHandling.test.tsx`),
    `lib/__tests__/nav.test.ts`(탭·하위 메뉴 표, 지금 탭, 탭 제목, 검색 메뉴 항목 — 셸은 그리기만)

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
