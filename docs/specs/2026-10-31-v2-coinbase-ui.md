# 명세 — Coinbase식 화면 개편과 화면 문구의 이모지 정리

- 작성: 2026-10-31 · 상태: **확정(2026-10-31 밤, 사용자 "권장안대로 진행해")** — 브랜치 `claude/coinbase-ui-2026-10`(main `70a82179`에서 시작)
- 상위: [프로그램 계획서](2026-10-26-v2-program-plan.md) §4 · [UI/UX 설계](2026-10-26-v2-ui-design.md) §12 · [ADR 0020](../adr/0020-v2-program.md) · 숫자 원칙 [PRINCIPLES](../PRINCIPLES.md) ·
  화면 층 [ADR 0004](../adr/0004-frontend-layering.md)
- 함께 가는 명세: [장중 '지금 값'](2026-10-31-paper-live-overview.md)(L5~L7). 이 문서의 공용 조각 위에서 그 명세의 화면 단계를 한다(§0 D1).
- 사용자 원문(같은 메시지, 이모지 자리만 글로 바꿈): "그리고 COINBASE처럼 UI/UX를 작업해. 그리고 웬만하면 해당 프로젝트에 [시험관 이모지]와 같은 이모지 사용하지마.
  너의 권장안대로 작업을 진행해."
- 근거 표기: [확인]은 파일·명령으로 확인한 것, [추정]은 확인하지 못한 것. Coinbase 실물 화면은 이 작업에서 열어 보지 않았다 — Coinbase에 관한 서술은 모두 [추정]이다.
- 이 문서에서 이모지는 글자 대신 이름으로 적는다: [경고] U+26A0(+U+FE0F) · [확인] U+2705 · [가위표] U+274C · [흰원] U+26AA · [건너뜀] U+23ED · [자물쇠] U+1F512 ·
  [열린자물쇠] U+1F513 · [시계] U+1F552 · [시험관] U+1F9EA · [로켓] U+1F680 · [번개] U+26A1 · [서랍] U+1F5C4 · [위성] U+1F4E1 · [국기] 지역 표시 문자 쌍 ·
  [여신상] U+1F5FD · [초록원] U+1F7E2 · [빨강원] U+1F534 · [나침반] U+1F9ED · [금지] U+26D4 · [경광등] U+1F6A8 · [클립보드] U+1F4CB

## 0. 결정 — 이 문서의 다른 절보다 우선

원 설계(작업 기록의 설계 원자료)와 그 반박 검토가 있었고, 아래는 반박 검토를 반영한 권장안이다. 사용자가 '권장안대로'를 승인했다.

| 번호 | 결정 |
|---|---|
| D1 | 모의매매 개요를 포트폴리오식으로 바꾸는 일(히어로·문지르기 연결·계좌 행 아바타·기간 공유)은 **이 브랜치에서 하지 않는다.** 장중 값 화면 단계(다음 브랜치, [장중 명세](2026-10-31-paper-live-overview.md) §10 단계 2)가 이 개편 위에서 한다. 여기서는 공용 패턴(Hero 문지르기·Avatar·AssetRow·RangeTabs)을 만들고 홈 같은 다른 화면에 쓴다. 모의매매 화면(`OverviewSection`·`LiveValuationCard`·`AccountDetailPanel`)은 공용 요소의 겉모양 변화와 이모지 정리만 받는다. |
| D2 | 새로고침 1시간·3시간은 장중 값 화면 단계가 장중 카드(`LIVE_REFRESH_OPTIONS`)에 넣는다(장중 명세 L5). 이 브랜치에서 하지 않는다. 매크로 `AutoRefresh`의 선택지는 바꾸지 않는다(겉모양만). |
| D3 | Pretendard 자체 호스팅과 KRX 이중 축을 패널로 나누는 일은 하지 않는다 — §12 제안으로만 둔다. |
| D4 | 상승 빨강·하락 파랑(한국 관행, 승인된 토큰)을 유지한다. 강조 파랑은 **누를 수 있는 것에만** 쓴다(A1). §7-2의 감사 목록 전부를 고친다. |
| D5 | 1단계 결정 — 액센트 '잉크'(10-26 사용자 선택 A), 따뜻한 회색 표면, 라이트 페이지 바탕 #f7f7f5 — 을 이번 사용자 요청('COINBASE처럼')으로 바꾼다. 이 사실을 이 문서·[UI 설계](2026-10-26-v2-ui-design.md) §12·[ADR 0020](../adr/0020-v2-program.md)에 적는다. 되돌리기는 `globals.css`의 토큰 값뿐이다(A1 규칙은 잉크로 돌아가도 그대로 유효). |
| D6 | AWS 잠금화면(`deploy/aws/gate` — `gate.py`의 화면 문구·텔레그램 문구, `services.json`)의 이모지도 정리한다. 별도 커밋, `test_gate.py`를 함께 고친다. `deploy/aws/offline/index.html`은 이모지가 없다 [확인]. |
| D7 | 이모지 정리에서 빼는 것: Claude 프롬프트·패킷·AI 입력 원문(`ClaudePrompts`·`PacketBuilder`·`KrPacketBuilder`·`CheckpointPacket`·`SnapshotTextService` 등)과 그 고정본·DB에 저장된 값. 코드 **주석**의 이모지는 이 브랜치에서 일부러 손대지 않는다(다음 정리 단계) — 고치러 들어간 줄의 주석에 있으면 뺀다. ✓·✗·▲▼ 같은 기호 글자는 이모지가 아니다. |
| D8 | (a) 글자 단계 이름은 옛 색 별칭(`body`·`muted`·`bright`·`canvas`·`surface-hover`)과 겹치지 않게 한다 — 본문 단계는 `body-md`. (b) Banner는 아이콘을 넣을 때 글을 감싼 div에도 톤 글자색을 준다. (c) `LockIcon`은 `<title>` 없이 `aria-label`만, 마우스 설명은 감싼 span의 `title`. (d) 검색 결과의 고른 행 막대는 남긴다. (e) AI 리포트 판정은 '우호·비우호·중립·보류' 글 배지 — ▲▼와 up/down 색은 값 변화에만. (f) `withoutPictographs`를 새로 만들지 않고 `lib/format.ts`의 `withoutLeadingIcon`을 넓히는 쪽을 먼저 검토. (g) noEmoji 시험은 TypeScript AST(`createSourceFile`)로 문자열·템플릿·JSX 글자만 보고, `Extended_Pictographic`·지역 표시 문자·U+FE0F·U+200D를 찾되 허용 목록(▲▼↑↓↕→←↻✓✗⌘↔▪© 등)을 둔다. |
| D9 | 접근성 보강: 날 입력(36곳 [확인 grep])의 공용 `inputClasses`와 2px 포커스 링, `forced-colors`에서 고른 알약·현재 메뉴·상태 점이 색 말고도 구분되게(테두리·굵기), 히어로 차트 문지르기 값의 sr-only `aria-live="polite"`, 차트 SVG 글자도 12px 하한. 인쇄 규칙은 하지 않는다(§12 제안). |
| D10 | 커밋은 반박 검토의 '더 작게 나눌 커밋' 목록대로 나눈다(§10). |

## 1. 원칙

가져올 것 [추정 — Coinbase 기억]: 넉넉한 여백과 가운데 최대 폭 열 · 흰/거의 검은 바탕과 옅은 1px 구분선(카드에 그림자 없음) · 선명한 파랑 강조 하나 ·
크고 굵은 잔고 숫자와 회색 보조 글 · 알약형 단추·기간 단추 · 격자 없는 단일 선 히어로 차트(기간 알약은 차트 아래, 문지르면 머리 숫자·날짜가 그 시점 값) ·
자산 행(원형 아이콘, 이름·티커, 오른쪽 값·등락) · 절제된 모션(색만 150ms) · 단계가 분명한 타이포.

가져오지 않을 것: 로고·이름·전용 글꼴·이미지 자산·상표색 #0052FF·마케팅 문구 · 상승 초록/하락 빨강(D4) · 축을 완전히 없애기(PRINCIPLES '축부터 정직' —
Y 끝값 둘과 X 첫·마지막 날짜는 남긴다) · 매수·매도 단추·프로모션 카드·자산 로고 이미지 · 숫자가 굴러가는 애니메이션.

- **A1 강조 파랑은 누를 수 있는 것에만.** 쓰는 곳: 주 단추·링크·포커스 링·현재 메뉴(셸)·현재 하위 탭 밑줄·알림 수 배지. 쓰지 않는 곳(데이터 영역): 히어로 값·자산 행·
  표·차트·데이터 배지·선택된 기간 알약. 데이터 영역은 중립색과 `up`·`down`·`warn`·`ok`·`danger`만 쓴다. 근거: `accent`↔`down`이 정상 시각 ΔE 10.3(라이트)·8.4(다크),
  적록색약 7.5·4.7로 검증기 하한(정상 15)에 못 미친다 [확인 validate_palette.js] — 색으로는 구분되지 않으니 쓰임으로 가른다.
- **A2 등락은 색만으로 전하지 않는다.** ▲▼, 부호 −(U+2212), sr-only '상승/하락'을 함께(`ChangeChip` 그대로).
- **A3 숫자 원칙 그대로.** 값이 없으면 '—', 변화를 모르면 칩을 생략, 추정·대리·이전 값 배지는 늘 보임(문지르는 동안에도), 단위는 값이 있을 때만.
- **A4 차트.** 격자 없음(산점도는 예외 — 두 축이 다 데이터). 히어로 선은 하나, 중립 잉크(`var(--text)`) — 방향색을 입히지 않는다(`Sparkline` 회색 결정과 같은 이유).
  이중 축을 새로 쓰지 않는다(KRX 두 곳은 §12). 기간 탭은 저장 구간 안에서만 만든다.
- **A5 판정은 글로 전한다.** 색이나 선만으로 전하지 않는다.
- **A6 바꾸지 않는 것**: 정보 구조, 경로, API, 데이터의 뜻, 문구의 뜻. 문구에서는 이모지만 빼고 뜻은 그대로 둔다.
- **A7 이모지 대신** `components/ui/icons.tsx`의 인라인 SVG 아이콘(새 의존성 없음)과 글. 아이콘은 장식(`aria-hidden`)이고 뜻은 보이는 글이나 sr-only 글이 나른다.
  예외: 잠금 아이콘은 `role="img"`와 `aria-label`(D8 c).
- **A8 접근성.** 본문 글자 4.5:1, 큰 글자·아이콘·입력칸 테두리 3:1(WCAG 1.4.11), 포커스 링 2px, lg 미만 누르는 자리 44px, `prefers-reduced-motion`이면 모션 없음,
  `forced-colors`에서 선택·상태가 테두리·굵기로도 보임(D9).
- **A9 밀도.** 표 화면(13F·레이더·KRX·모의매매 표)은 밀도를 유지하되 글자 하한 12px. 히어로와 목록은 넉넉하게.
- **A10 화면은 그리기만**(ADR 0004). lib 순수 함수가 모노그램·문지르기 값·상태 아이콘 선택·서버 문구 정리를 정하고, 상태는 hooks, 패턴은 배럴, 차트는 `@/components/charts`에서만.

## 2. 토큰 — `frontend/src/app/globals.css` 한 파일

- 값은 원래 변수에만 둔다. 라이트는 `:root`, 다크는 `[data-theme="dark"]`와 `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` 두 곳에 같은 값.
  `dark:` 변형은 계속 쓰지 않는다. 옛 별칭 다섯(`canvas`·`surface-hover`·`muted`·`body`·`bright`)은 남긴다(4단계에 지움).
- 계산: WCAG 상대휘도 대비와 OKLab ΔE×100(python3, 이 작업에서 다시 계산 [확인]). 틴트 값은 OKLab 10% 섞기의 근사 — 브라우저 `color-mix` 결과와 마지막 자리가 다를 수 있다 [추정].

### 2-1. 색

| 토큰 | 라이트 | 대비 surface / surface-2 | 다크 | 대비 surface / surface-2 |
|---|---|---|---|---|
| `bg` | #ffffff | — | #0a0b0d | — |
| `surface` | #ffffff | — | #141619 | 대 bg 1.09 |
| `surface-2` | #f2f3f5 | 대 surface 1.11 | #1f2226 | 대 surface 1.14 |
| `border` | #e3e5e8 | 1.26 (장식 구분선) | #2c3036 | 1.37 |
| `border-strong` (새) | #868c96 | 3.38 / 3.05 (입력칸·셀렉트·체크박스 테두리) | #6b717b | 3.69 / 3.25 |
| `text` | #0a0b0d | 19.69 / 17.73 | #f2f3f5 | 16.33 / 14.38 |
| `text-2` | #555b66 | 6.83 / 6.15 | #b8bdc6 | 9.61 / 8.47 |
| `text-3` | #686e79 | 5.13 / 4.62 | #8f959f | 6.01 / 5.30 |
| `accent` | #3550dc | 6.30 / 5.68 | #7a90ff | 6.27 / 5.52 |
| `accent-fg` | #ffffff | accent 위 6.30 | #0a0b0d | accent 위 6.81 |
| `accent-hover` (새) | #2a43c2 | accent-fg 7.83 | #95a6ff | accent-fg 8.60 |
| `up` | #cc2f2f | 5.23 / 4.71 | #f4564f | 5.43 / 4.78 |
| `down` | #0a6fb5 | 5.31 / 4.78 | #3d9de0 | 6.13 / 5.40 |
| `warn` | #8a5a00 | 5.93 / 5.34 | #e3a535 | 8.37 / 7.38 |
| `neutral` | #686e79 (= text-3) | 5.13 / 4.62 | #8f959f | 6.01 / 5.30 |
| `ok` | #157a3e | 5.41 / 4.87 | #3fbf6e | 7.67 / 6.76 |
| `danger` | #a3172c | 7.73 / 6.96 | #ff8a80 | 7.94 / 7.00 |
| `danger-fg` (새) | #ffffff | danger 위 7.73 | #0a0b0d | danger 위 8.62 (흰 글자는 2.28이라 쓰지 않음) |
| `focus` | = accent | bg 대비 6.30 | = accent | bg 대비 6.81 |

틴트(`@theme inline`의 `color-mix(in oklab, 톤 10%, var(--surface))`, 불투명):

| 틴트 | 라이트 ≈ | 톤 글자 / text / text-2 / text-3 | 다크 ≈ | 톤 글자 / text / text-2 / text-3 |
|---|---|---|---|---|
| `accent-tint` (새) | #e8eefe | 5.43 / 16.96 / 5.88 / **4.42** | #1d212c | 5.56 / 14.48 / 8.52 / 5.33 |
| `warn-tint` | #f3eee7 | 5.14 / 17.06 / 5.92 / **4.44** | #25231f | 7.24 / 14.13 / 8.31 / 5.20 |
| `ok-tint` | #e9f1eb | 4.70 / 17.11 / 5.93 / **4.46** | #1a2421 | 6.74 / 14.35 / 8.45 / 5.29 |
| `danger-tint` (새) | #f9e9e8 | 6.57 / 16.73 / 5.81 / **4.36** | #282122 | 6.91 / 14.21 / 8.36 / 5.24 |

- 라이트 틴트 위에서는 `text-3`가 4.5:1에 모자란다 — 틴트 위의 작은 글은 톤 색이나 `text-2` 이상으로 쓴다.
- 쌍 검증 [확인 validate_palette.js]: up↔down 라이트 정상 31.1 / 색약 20.5, 다크 31.2 / 21.6 PASS. accent↔down 라이트 10.3 / 7.5, 다크 8.4 / 4.7 FAIL → A1.
  up↔danger ΔE 9.7(라이트)·10.7(다크) — danger는 상태 전용이고 늘 아이콘·글과 함께. accent와 상표색 #0052FF는 ΔE 5.9로 같은 계열이지만 같은 값은 아니다(#0052FF는 기억 값 [추정]).
- 다크 up은 OKLCH L 0.665로 차트 밝기 띠(0.48~0.67) 안 — 막대(`HorizontalBars`·`SignedBars`)가 up·down 토큰을 쓰기 때문이다. 후보 #ff5c57은 L 0.69로 띠 밖이라 버렸다.
- 장 상태 점(그래픽, 3:1 기준): ok·warn·text-3이 surface 위 라이트 5.41·5.93·5.13, 다크 7.67·8.37·6.01.
- **hover 바탕 허용**: up·down·text-3·ok가 모두 surface-2 위 4.5:1 이상이 되어, `AssetRow`·`DataTable`·옛 `Table`의 'hover 바탕 금지' 주석을 푼다(패턴 커밋). 별칭 `surface-hover`가 surface-2를 가리키므로 새 토큰은 만들지 않는다.
- 입력칸 포커스: 테두리 색만 border-strong → accent로 바꾸는 표시는 1.86:1(라이트)·1.70:1(다크)뿐이라, 2px 링(outline)을 더한다 — 링 대 바탕 6.30·6.81.

### 2-2. 계열 색 — 바꾸지 않고 새 표면에서 다시 검증 [확인 validate_palette.js, 라이트 #ffffff · 다크 #141619]

| 팔레트 | 결과 |
|---|---|
| `SERIES_COLORS` #3987e5·#d95926·#199e70 | 두 모드 ALL PASS |
| 기관 비중 10색(`/institutions`) | 두 모드 ALL PASS |
| 환율 4색(`/macro`) #4798ee·#d47d0d·#1caa5e·#a371f7 | 두 모드 ALL PASS |
| 모의매매 남는 색 #a371f7·#22a2bd·#db6d28 | 두 모드 ALL PASS(§11-2에 #db6d28 기록이 없었으므로 이번 결과로 채움) |
| 계좌 5색 #3987e5·#d95926·#a438a0·#199e70·#6b727e | 회색 #6b727e의 채도만 FAIL — 범주 색이 아닌 회색에는 채도 검사를 적용하지 않는다는 기존 면제(UI 설계 §11-2). 이웃 쌍 색약 8.8·정상 15.1, 모든 쌍 색약 최소 6.5(자주↔회색, 글자 범례가 보조 부호) |
| 계좌 구성 도넛 #3987e5·#d95926·#199e70·#606870·#9ea7b3(모든 쌍) | 회색 둘의 채도·다크 현금 밝기 띠(0.725)만 FAIL — 같은 면제. 라이트 현금 대비 2.43(#ffffff — 예전 #f7f7f5 바탕 2.3), 범례·표가 같은 값을 나름 |

차트 색이나 표면 값을 바꾸면 다시 돌린다:

```
node <dataviz>/scripts/validate_palette.js "<hex,…>" --mode light --surface "#ffffff"
node <dataviz>/scripts/validate_palette.js "<hex,…>" --mode dark --surface "#141619"
```

### 2-3. 글자 단계 (`@theme`의 `--text-*`와 하위 키)

Tailwind 4.3.3은 `--text-*--line-height`·`--text-*--font-weight`·`--text-*--letter-spacing`을 지원한다 [확인 컴파일]. 굵기는 머리 단계에만 토큰에 넣는다 — 본문·라벨·캡션에 굵기를
넣으면 굵은 부모 안에서 굵기가 400으로 되돌아간다. 다른 굵기가 필요하면 `font-*` 클래스가 이긴다.

| 클래스 | 크기/줄 높이 | 굵기 | 쓰임 |
|---|---|---|---|
| `text-display` | 44/52, 자간 -0.02em | 700 | 히어로 숫자(sm 이상) |
| `text-display-sm` | 36/44 | 700 | 히어로 숫자(좁은 화면) |
| `text-title-1` | 28/36 | 700 | 페이지 h1(390px에서는 `text-2xl`) |
| `text-title-2` | 20/28 | 700 | 카드 밖 구역 제목, 대화상자 제목 |
| `text-title-3` | 17/24 | 600 | 카드·목록 제목 |
| `text-body-md` | 15/22 | — | 넉넉한 본문(히어로 판정 글·목록 행 이름) |
| `text-label` | 14/20 | — | 단추·탭·표 본문(= text-sm 크기) |
| `text-caption` | 13/18 | — | 보조 글·표 머리 |
| `text-micro` | 12/16 | — | 배지·축·출처. 최소 크기 — 10·11px은 없앤다(글자 하한 커밋) |

- `body`라는 이름은 옛 색 별칭 `--color-body`와 겹쳐 `text-body`가 색만 내고 크기가 붙지 않는다 [확인 — 반박 검토의 컴파일] → `body-md`(D8 a).
- 숫자는 `.tabular-nums` 그대로. 글꼴은 Pretendard 스택 그대로(설치된 기기에서만 적용 — 자체 호스팅은 §12).

### 2-4. 간격·모서리·그림자·모션

- 4pt 격자(Tailwind `--spacing` 0.25rem). 페이지 여백 `px-4 sm:px-6 lg:px-8`, 구역 사이 `gap-6 lg:gap-8`, 카드 안쪽 `p-5 lg:p-6`, 히어로 `p-6 lg:p-8`,
  자산 행 최소 높이 64·`px-4 lg:px-5 py-3`·아바타 40(좁은 화면 36), 표 칸 `px-4 py-3`(밀도 표는 `py-2` 유지 가능), 본문 최대 폭 `max-w-7xl`(새 토큰 없음).
- 모서리: `--radius-card` 1rem(카드·히어로·목록·대화상자), `--radius-control` 0.75rem(입력칸·셀렉트·통계 타일·배너·토스트·툴팁), `rounded-full`(단추·기간 알약·세그먼트·
  칩·배지·검색칸·아바타·메뉴 항목), `rounded-sm`은 kbd·막대 끝에만. `rounded-md`·`rounded-lg`·`rounded-[10px]`은 화면 다듬기에서 없앤다.
- 그림자: 카드에는 없다. 덮개(Dialog·Toast·검색)에만 `shadow-overlay` — `:root`의 `--elev-overlay`를 `@theme inline`의 `--shadow-overlay`로 잇는다.
  라이트 `0 12px 32px rgb(10 11 13 / 0.12), 0 2px 6px rgb(10 11 13 / 0.06)`, 다크 `0 12px 32px rgb(0 0 0 / 0.6)`. 덮개 뒤 막은 `bg-black/50`(다크도 그대로).
- 모션: 색·바탕만 150ms(`transition-colors`), `motion-reduce:transition-none`. 숫자·차트·히어로에는 애니메이션 없음(Recharts `isAnimationActive={false}` 유지).

## 3. 공용 조각 — `components/ui`

- **아이콘 `ui/icons.tsx`(새)**: `shell/icons.tsx`의 `Svg`를 옮긴다(24 뷰박스, `fill="none"`, `stroke="currentColor"`, 굵기 2, 둥근 끝). 기본 `aria-hidden`.
  `label`을 주면 `role="img"`와 `aria-label` — **`<title>`은 두지 않는다**(제목 글이 링크의 `textContent`에 섞여 `Shell.test`·`MoreMenu.test`의 글 비교가 깨짐, D8 c).
  아이콘: AlertTriangle · Info · CheckCircle · XCircle · CircleDashed(없음·키 없음) · Skip(건너뜀) · Minus · Check · X(닫기) · Lock · Clock · ChevronDown/Up/Right · Search · Bell ·
  Refresh · Plus · Spinner. 함께: `StatusDot`(8px 원 — 테두리로 칠해 `forced-colors`에서도 남음, `aria-hidden`), `StatusText`(아이콘·sr-only 머리말·글을 각각 span — `getByText`가 글 span을 찾음).
  `shell/icons.tsx`는 `TabIcon`·`TAB_PATHS`만 두고 나머지는 ui에서 다시 내보낸다. Dialog·Toast의 닫기 X는 `XIcon` 하나.
  시험 `ui/__tests__/icons.test.tsx`: 내보내는 이름 목록 고정, 모든 아이콘이 `aria-hidden` svg·`currentColor`, `label`이면 `role="img"`와 그 이름, `<title>` 없음.
- **Button**: 변형 넷 — `primary`(`bg-accent text-accent-fg hover:bg-accent-hover`), `secondary`(`bg-surface-2 text-text`, hover는 text 8% 섞기), `ghost`(`text-text-2 hover:bg-surface-2 hover:text-text`),
  `danger`(`bg-danger text-danger-fg`). 모두 `rounded-full font-semibold transition-colors`, 포커스 링 2px, 투명 1px 테두리(고대비 모드에서 단추 경계가 보임). 크기 `md`(기본, `min-h-11 lg:min-h-10 px-4 text-sm`)·`sm`(`min-h-11 lg:min-h-8 px-3 text-[13px]` — 원 설계의 `min-h-9`는 lg 미만 44px(A8)에 모자라 바꿈).
  옛 `variant="default"`는 secondary의 별칭(84곳 중 variant를 주지 않은 약 48곳을 한꺼번에 고치지 않으려고). 앞 아이콘 칸 `icon`.
  클래스는 `buttonClasses(variant, size)`로 내보내 `ConfirmDialog`(시험이 `bg-accent`·`bg-danger`를 단언 — 그대로 통과)·`RefreshButton`(primary sm, 폭 전체)·`AccountBox` 로그아웃(secondary sm)이 함께 쓴다.
  예전 primary(accent/15 바탕에 accent 글자)는 잉크에서 회색 상자로 보였다 → 실색.
- **Card**: `rounded-card border border-border bg-surface p-5 lg:p-6`, 제목 h2 `text-title-3 text-text`, 부제 `text-[13px] text-text-2`, 머리 아래 `mb-5`. `withoutLeadingIcon` 유지.
- **SourceLine**: 테두리 있는 '출처' 상자를 없애고 캡션 한 줄 `text-xs text-text-3`(ProvenanceBadge와 같은 모양). '출처'는 따로 span(`getByText('출처')` 유지) — 뒤에 ' · '.
- **Metric**: StatTile 모양 — `rounded-control border p-4`, 라벨 13px text-2, 값 `text-2xl font-semibold`, 변화 `deltaColor` 그대로. 옛 화면 16파일 68곳이 함께 바뀐다.
- **SourceBadge**: `rounded-full bg-surface-2 px-2 text-xs text-text-2`, 테두리 없음.
- **Freshness**: '새로 읽지 못함'·'오래된 저장본'은 `rounded-full warn-tint` 알약 + AlertTriangle 12(이모지 커밋), 평상시는 알약 없이 Clock 12 + '수집' + 시각(캡션 text-3).
  `role="status"`와 `title`은 유지.
- **Banner**: `rounded-control border px-4 py-3`. warn `warn-tint border-warn/30 text-warn`, danger `danger-tint`(불투명 — 예전 투명 `bg-danger/10`) `border-danger/30 text-danger`,
  info `accent-tint border-accent/25 text-text`(아이콘만 accent — A1: 글은 데이터가 아니라 안내라도 파랑 글자는 링크로 읽힘), ok(새) `ok-tint border-ok/30 text-ok`.
  톤 아이콘은 이모지 커밋에서 호출부의 [경고]를 걷어 내는 것과 **같은 커밋**에 넣는다(기호가 두 번 보이는 중간 상태 없음). 아이콘을 넣을 때 글은 `<div className="min-w-0 flex-1 {톤 글자색}">`로
  감싼다 — `findByText(…)`·`closest("div")`가 그 div를 찾고 `text-warn`을 단언하는 시험(`paperStateHandling.test.tsx`·`paperFramework.test.tsx`·`paperClaude.test.tsx`·`paperDecisions.test.tsx`)이
  그대로 통과한다(D8 b). warn·danger에는 sr-only '주의: '·'오류: '. `icon={false}`로 끌 수 있다.
- **Loading** `SpinnerIcon`(`motion-safe:animate-spin`) text-3 + 라벨(글 그대로). **EmptyState** 점선 없이 `rounded-control bg-surface-2 py-10` 가운데 text-2.
  **ErrorState** `danger-tint` + XCircle, 다시 시도는 Button secondary sm. live region은 범위 밖(UI 설계 §11-4).
- **Select**(공용): `appearance-none rounded-control border border-border-strong bg-surface min-h-11 lg:min-h-10 px-3 pr-9 text-sm text-text` + 오른쪽 ChevronDown 16(`pointer-events-none`),
  라벨 `text-[13px] text-text-2`, 폭 묶기 규칙 그대로.
- **날 입력 `inputClasses`(새, D9)**: 같은 칸 모양(`rounded-control border-border-strong bg-surface text-text`)과 포커스 링 `focus-visible:outline-2 outline-offset-2 outline-focus`.
  `outline-hidden focus:border-accent`(테두리 색만 바뀌어 1.86:1)를 쓰던 36곳(19파일 — alerts·account·admin/users·ai/report·AiEngineSection·style·Framework·Notes·Settings 섹션·
  LiveValuationCard·AutoRefresh·login·signup·AuthCard·ConfirmDialog·ui Select·SearchCommand와 라디오 sr-only 둘)을 바꾼다. 매크로·장중 카드의 날 `<select>` 둘(AutoRefresh·LiveValuationCard)도 같은 칸 모양.
- **Table**(옛): 머리 `text-[13px] font-medium text-text-2`(대문자·자간 없앰 — 한국어에서 뜻이 없다), 행 `border-b border-border hover:bg-surface-2`, 칸 `py-3`.
  `min-w-[640px]`과 좌우 스크롤 안내 유지.
- **Dialog**: `rounded-card p-6 shadow-overlay`, 제목 `text-title-2`, 닫기는 `XIcon` + `rounded-full` 44/32 단추. **Toast**: `rounded-control shadow-overlay`, warn은 AlertTriangle text-warn + sr '주의: '
  (이모지 커밋), info는 Info 아이콘(Banner info와 같은 accent — 안내 톤의 표지이고 글은 text), 닫기 `XIcon`, 자리 그대로. **ConfirmDialog**: `buttonClasses`(취소 secondary, 확인 primary 또는 danger), 입력칸은 `inputClasses`.

## 4. 패턴 — `components/patterns`

- **AssetRow**: `min-h-16 px-4 lg:px-5 py-3`, 상호작용 행 `hover:bg-surface-2 motion-safe:transition-colors`, 이름 밑줄(`group-hover:underline`) 없앰, 이름 15px semibold, 보조 글 `text-xs text-text-3` 유지.
  **고른 행의 왼쪽 3px 막대는 남기고 색만 `bg-accent` → `bg-text`(잉크)**, 바탕 `bg-surface-2`(A1). 시험 `AssetRow.test.tsx`·`paperAccountDetail.test.tsx`의 `.bg-accent` 막대 단언은
  막대를 찾는 뜻 그대로 `[aria-hidden].bg-text`로 바꾼다. 펼침 ▴▾는 ChevronUp/Down 14, 경고 줄은 AlertTriangle 14 + sr '주의: '. 왼쪽 칸 Avatar.
- **Avatar(새)**: 40px(좁은 화면 36) `rounded-full bg-surface-2 text-text-2 text-[13px] font-semibold`, `aria-hidden`. `avatarRing`이 있으면 `ring-2` 그 색(계좌 색 = 차트 선 색, 장식).
  `AssetRowData`에 `avatarText?`·`avatarRing?`. lib: `assetMonogram(row)`(영문 티커면 앞 2~3자, 아니면 이름 첫 글자), `bookMonogram(code)`(rules R, claude C1, claude2 C2, bench_spy SPY, bench_mix 60,
  kr_rules R, kr_claude C, kr_bench_k200 200, kr_bench_mix 60). `avatarText`가 없으면 칸을 그리지 않는다. 배럴·`index.test.ts` 목록에 추가.
- **AssetList**: `rounded-card`, 제목 `px-5 pt-5 pb-2 text-title-3 text-text`. 행 사이 `border-t`·`first:border-t-0` 유지.
- **ChangeChip**: 바탕 없음·▲▼·U+2212·sr 그대로. size md 15px semibold, sm 13px medium — `ChangeChip.test.tsx`의 크기 단언(sm `text-xs`, md `text-sm`)을 새 값으로.
- **Hero**: `rounded-card p-6 lg:p-8`, 라벨 15px medium text-2, 값 `text-display-sm sm:text-display`, 단위 `text-base text-text-3`, 칩은 값 바로 아래, 판정 글 `text-body-md text-text`.
  `tabsPlacement: 'above'|'below'`(기본 above — 홈 시장 고르기). `scrub?: { valueText, dateText, change?, changePct? } | null` — 값이 있으면 큰 숫자를 그 값으로, 칩을 '기간 시작 대비'로(모르면 생략),
  옆에 dateText 캡션, meta 배지는 그대로(A3). 큰 숫자에는 `aria-live`를 달지 않고 지금 값은 sr-only '지금 값 …'으로 늘 남긴다. **문지르기 값은 따로 sr-only `aria-live="polite"` 영역**에
  '{날짜} {값}'을 적는다(D9 — 화살표로 점을 옮기는 낭독기 사용자에게 읽힘).
- **StatTile** `rounded-control border p-4`, 라벨 13px text-2, 값 `text-2xl semibold`(시험 단언 유지). **badges**: ProvenanceBadge 캡션 그대로(시험이 rounded-full이 아님을 단언),
  EstimateBadge 점선 알약 그대로, StaleBadge `rounded-full warn-tint border-warn/30 text-warn` + AlertTriangle 12 + sr '주의: ' + '이전 값'.
- **DataTable**: 머리 `text-[13px] font-medium text-text-2`, 행 `hover:bg-surface-2`(허용), 칸 `py-3`, 첫 칸 밑줄 규칙 유지, ↑↓↕ 글자 유지.
- **RangeTabs(새)**: 단추 `rounded-full px-3.5 min-h-11 lg:min-h-8 text-[13px] font-semibold tabular-nums`, 고른 탭 `bg-surface-2 text-text`(시험 단언, A1 중립), 나머지 `text-text-2 hover:text-text`.
  **forced-colors**: 고른 탭에 `forced-colors:border` 테두리와 굵기 차이(D9). 옛 `components/RangeTabs.tsx`는 API 그대로 같은 클래스.
- **세그먼트**(ThemeSwitch·홈 시장 고르기): 트랙 `rounded-full bg-surface-2 p-1`, 고른 칸 `rounded-full bg-surface text-text font-semibold ring-1 ring-border`(forced-colors에서도 링이 보임), radiogroup 의미 그대로.
- **밑줄 탭**: SubNav와 PaperScreen 7탭이 `underlineTab(active)` 하나 — `h-12 text-[15px] border-b-2`, 현재 `border-accent font-semibold text-text`, 나머지 `border-transparent text-text-2`, 가로 스크롤.
  `/paper`에서 SubNav와 7탭이 같은 모양으로 두 줄 겹치면 위계가 흐려지므로 7탭은 `text-[14px] h-11`로 한 단계 작게 둔다.
- **Skeleton**: 글 줄 `rounded-full`, 덩어리 `rounded-control`, `bg-surface-2 motion-safe:animate-pulse`.

### 4-1. 구현 메모(패턴 단계, 2026-11-01) — 위 설계와 달리 한 것 [확인 코드·시험]

- 고르기 조각 클래스는 `components/ui/classes.ts`에 둔다: `pillTabClasses(active)`(기간 알약 — 새·옛 RangeTabs), `SEGMENT_TRACK`·`segmentClasses(checked)`
  (ThemeSwitch·홈 시장 고르기), `underlineTabClasses(active, "md"|"sm")`(밑줄 탭 — 모의매매 7탭은 sm, SubNav는 셸 단계에서 md로).
- forced-colors: 세그먼트의 고른 칸은 `ring-1`만으로는 그 모드에서 보이지 않는다 — ring은 box-shadow라 고대비 모드가 지운다. 고른 알약·세그먼트 칸에만
  `forced-colors:border`(1px 테두리)를 더하고, 나머지 칸에는 테두리를 두지 않는다(투명 테두리는 그 모드에서 시스템 색으로 보여 모든 칸이 고른 것처럼 보임).
  굵기 차이도 둔다 — 기간 알약·세그먼트는 고른 칸 semibold·나머지 medium, 밑줄 탭은 semibold·normal.
- AssetList 제목은 행 글과 같은 세로줄(`px-4 lg:px-5`)에 둔다(설계의 `px-5`는 좁은 화면에서 행보다 4px 안쪽). 목록 상자는 `overflow-hidden`(마지막 행 hover 바탕이 모서리 밖으로 나가지 않게).
- AssetRow에 아바타가 있으면 배지 줄을 이름과 같은 세로줄로 들여쓴다(`pl-12 sm:pl-[52px]`). `assetRowModel`이 `avatarText`의 빈 글·'N/A'를 null로 정리한다.
- 홈 PaperHero 계좌 줄의 바깥 여백을 새 히어로 안쪽 여백(`p-6 lg:p-8`)에 맞췄다(`-mx-6 lg:-mx-8`, 줄 `px-2 lg:px-3`).
- `assetMonogram({name, ticker})`: 영문으로 시작하는 티커의 앞 2~3자(영문 한 글자뿐이면 이름 첫 글자 — 예 `^N225`), `bookMonogram`은 모르는 코드면 null.
- 문지르기: 차트는 툴팁 내용 자리의 알림 컴포넌트 하나로 마우스·터치·키보드(차트 초점 + ←·→)의 활성 자리를 받는다(`scrubIndex`가 Number 변환·범위 검사).
  Recharts는 터치를 뗀 뒤에도 툴팁을 남기므로 손을 떼면 툴팁 `active={false}`로 커서를 감추고 null을 알린다. 탭 뒤 브라우저가 흉내 내는 mousemove는
  진짜 마우스(pointerType)가 아니라 감춤을 풀지 않는다. `useChartScrub`은 행 수가 바뀌면(기간 변경) 렌더 중에 순번을 지운다.
  headless 크롬(CDP)으로 임시 데모 화면에서 마우스·키보드·터치 끌기·떼기·탭을 확인했다(데모는 커밋하지 않음).
- `scrubModel`의 추정 점 자리: `{ estimate: { date, note } }` — 그 날짜를 문지르면 `isEstimated`·`estimateNote`, Hero가 추정 배지와 알림의 '추정'을 낸다.
  `LineSeriesSpec.legend: false`로 글자 범례에서 뺄 수 있다(장중 값 단계의 점선 꼬리 자리).

## 5. 차트 — `components/charts`

- **LineChart `variant="hero"`**: 선 `var(--text)` 2px monotone, 툴팁 상자 없이 세로 커서 1px `var(--border)`와 activeDot r=4(테두리 surface), Y 끝값 둘은 오른쪽 안쪽 micro text-3,
  X는 첫·마지막 날짜, 높이 260(lg)/200, `touch-action: pan-y`.
- **`onScrub?(index | null)`**: Recharts 3.10.1 `onMouseMove`의 `activeTooltipIndex`는 `number | string | null | undefined`다 [확인 types/synchronisation/types.d.ts·state/tooltipSlice.d.ts] —
  훅에서 `Number()`로 바꾸고 범위를 검사한다. `onTouchMove`·`onTouchEnd`도 같은 경로, `onMouseLeave`는 null. 키보드 접근성 층의 화살표 이동은 Tooltip content 안의 작은 효과 컴포넌트로 잡는다 [추정 — 구현 때 키보드로 확인].
  상태는 `hooks/useChartScrub.ts`, 표시 값은 `lib/lineChart.ts`의 `scrubModel(rows, key, index, valueFormat)` → `{valueText, dateText, change, changePct}`(기간의 첫 유효값 기준, 점이 null이면 '—'·칩 생략).
  장중 명세의 오늘 추정 점(`navEstimate`, 점선 꼬리)에 닿으면 '추정 HH:MM'을 함께 낸다 — 꼬리는 글자 범례에서 숨긴다(그 단계에서).
- **LineSeries·MultiLineSeries**: `CartesianGrid`·면적 그라디언트 없앰, 축선 끄고 끝값 눈금(`lineYAxis`·`lineXTicks` 재사용), Recharts Legend 대신 글자 범례(색 짧은 선 + 이름),
  툴팁 `rounded-control shadow-overlay`. 이중 축(right) 기능은 남긴다(KRX 두 곳 — §12).
- **막대**(HorizontalBars·SignedBars): 격자 끄고 0 기준선과 막대 끝 모서리 4, 색 up/down 그대로. **산점도**: 격자 `border` 50%로 옅게. **WeightHeatmap·DonutChart**: 색 그대로, 틀만 토큰.
- **SVG 글자 12px 하한**(D9): `charts/index.tsx`의 축(AXIS)·범례·표시선 이름·도넛 이름의 10·11px도 12px로(글자 하한 커밋과 같은 커밋 묶음).

### 5-1. 차트 커밋 결과(패턴 단계, 2026-11-01) [확인 코드·시험·validate_palette.js]

- 차트 틀은 `components/charts/frame.tsx` 하나 — `AXIS_TEXT`·`AXIS_LINE`·`GUIDE`·`CHART_FONT`(12)·`SERIES_COLORS`·`TOOLTIP_BOX`(불투명 surface·1px border·12px 모서리·
  `var(--elev-overlay)`)·`EdgeDateTick`·`ChartLegend`. `index.tsx`와 `LineChart.tsx`가 함께 쓰고 서로 가져오지 않는다(예전 `SERIES_COLORS` 순환 가져오기를 없앰).
- `LineSeries`(옛 화면 7곳)는 새 `LineChart`에 맡긴다 — 격자·면적 그라디언트 없음, Y 끝값 둘(precision + 단위), X 첫·마지막 날짜, 툴팁은 한 자리 더(`tooltipFormat`).
  값이 모두 없으면 빈 상태 문구(예전에는 행이 있으면 빈 그림).
- `MultiLineSeries`: 격자·Recharts Legend 없음, 위에 글자 범례(두 계열 이상, 점선 계열은 점선 표지), Y 끝값은 `lineYAxis`(고정 `domain`이면 그 끝값), 오른쪽 축도 끝값,
  선 2px·활성 점 테두리 surface, 표시선 이름 12px. 오른쪽 축 계열 이름은 부르는 쪽이 적는다(KRX 두 곳은 이미 '(좌)'·'(오른쪽)').
- 막대는 격자를 지우고 0 기준선(text-3)만, 가로 막대의 수치 축선도 지움. 산점도만 옅은 격자(`strokeOpacity` 0.5). 도넛 직접 라벨·산점도 축 이름도 12px.
- 축선: Y 축선은 모든 선 차트에서 없음. X 축선은 기본 선 차트·래퍼에서 옅은 경계선(border)으로 남기고(바닥 기준), 히어로에서는 없앤다.
- 남은 점(제안): Y 끝값은 `lineYAxis`의 여백 포함 범위 끝(1단계 결정)이라, 0~100으로 묶인 지수(KRX 한국판 COT OI Index)는 위 끝값이 '108.00%'로 적힌다
  (예전 자동 눈금은 같은 범위 [0, 108]에 Recharts가 고른 눈금을 적었다 — 그 끝 글자가 무엇이었는지는 확인하지 못함 [추정]). 데이터 최고·최저를
  눈금으로 쓰거나 범위 상한을 받는 쪽을 §12에 둔다.
- 검증기 다시 돌림(라이트 `#ffffff` · 다크 `#141619`, 두 모드 같은 결과):

| 팔레트 | 결과 |
|---|---|
| `SERIES_COLORS` #3987e5·#d95926·#199e70 | ALL PASS — 이웃 쌍 색약 최소 9.4(deutan)·정상 26.5 |
| 기관 비중 10색 | ALL PASS — 이웃 쌍 색약 최소 8.2·정상 17.2 |
| 환율 4색 | ALL PASS — 이웃 쌍 색약 최소 8.1(protan)·정상 22.0 |
| 막대 up↔down 라이트 #cc2f2f·#0a6fb5 / 다크 #f4564f·#3d9de0 | ALL PASS — 색약 20.5 / 21.6, 정상 31.1 / 31.2 |

  히어로 선 `var(--text)`는 범주 색이 아니라 표면 대비로 본다 — 19.69(라이트)·16.33(다크). 문지르는 세로 커서 `var(--border)`(1.26·1.37)는 장식이고 위치는 활성 점(r 4, 테두리 surface)이 보인다.

## 6. 셸 — `components/shell` (그리기만, `lib/nav.ts`의 탭·경로·라벨·접근 판정 그대로)

- **Shell**: main 클래스(`min-w-0`·`overflow-x-hidden`·`pb-[calc(64px+1rem+env(safe-area-inset-bottom))]`·`lg:pb-6`)는 시험 단언이라 그대로. 안에 `<div className="mx-auto w-full max-w-7xl">`,
  여백 `px-4 sm:px-6 lg:px-8`, 위 `pt-6 lg:pt-8`. MarketClock 상자는 main 맨 위에서 TopBar로.
- **SideNav**(lg 이상): 폭 232 그대로. 항목 `h-12 rounded-full px-4 gap-3 text-[15px] font-medium` 아이콘 22, 현재 탭 `bg-accent-tint text-accent font-semibold`(셸 — A1 허용) +
  forced-colors 테두리, 나머지 `text-text-2 hover:bg-surface-2`. 아래 묶음 ReadModeNote · RefreshButton(primary sm 폭 전체) · AccountBox(아바타 원 + 역할 캡션, 로그아웃 secondary sm) · ThemeSwitch(세그먼트) · BuildInfo(micro).
- **TopBar**: lg 이상 64px 한 줄 — 검색 알약(`rounded-full bg-surface-2 h-10 px-4`, Search + '검색' + kbd, 최대 520px) · 빈칸 · 장 상태 칩 둘(`rounded-full border px-3 h-8 text-[13px]`,
  StatusDot — trading ok, pre·post warn, closed text-3; 시각은 xl 이상에서 tabular 캡션, 늘 `title`; 휴일 안내 'ⓘ'는 Info 12) · 벨(`rounded-full h-11 w-11`, 배지는 accent 그대로).
  lg 미만 두 줄 — 64px(짧은 상표·검색·벨)과 32px(같은 칩 둘, text-xs). **MarketClock은 인스턴스 하나**로 그리고 배치만 바꾼다(둘로 그리면 휴일 요청·1초 시계·글이 두 번).
  [국기]·[여신상]은 지운다 — 시장 이름은 코드에 있는 'KOSPI'·'NASDAQ'이 나른다. 장 판정·휴장 계산·1초 시계는 그대로. **새 MarketClock 시험**(칩 글·상태 점·title)을 이동 커밋과 함께.
- **SubNav**: 바깥 전폭 `border-b bg-surface`, 안 ul은 본문과 같은 `mx-auto max-w-7xl` 여백. 밑줄 탭, `font-semibold` 유지(시험). [자물쇠]는 `LockIcon`(D8 c).
- **TabBar**(lg 미만): 높이·grid-cols·`lg:hidden` 그대로(시험). 현재 `text-accent font-semibold` 아이콘 22, 나머지 text-3, 라벨 text-xs truncate.
- **MoreMenu**: h1은 PageHeader, 항목은 목록 행(40px 원 안 아이콘·15px semibold 라벨·ChevronRight·56~64px·hover surface-2), 잠금은 LockIcon.
- **SearchCommand**: Dialog lg, 입력칸 `h-12 rounded-control bg-surface-2 text-[17px]` + Search, 결과 행 왼쪽 32px 원(메뉴 TabIcon·지표/기관 아이콘·종목 모노그램), 오른쪽 '→ 화면' 캡션,
  고른 행 `bg-surface-2` **+ 왼쪽 막대 유지**(D8 d — 바탕 차이 1.11만으로는 모자란다는 기존 결정, `SearchCommand.test.tsx`의 막대 단언은 `bg-accent` → 잉크 `bg-text`로 뜻 그대로).
  `aria-activedescendant` 동작 그대로.
- 390px: 페이지 여백 16, TopBar 두 줄, 아래 탭 바, 표는 가로 스크롤과 '← 표를 좌우로 넘겨 보세요' 유지, 가로 페이지 스크롤 없음.

### 6-1. 구현 메모(셸 단계, 2026-11-01) — 위 설계와 달리 한 것 [확인 코드·시험·QA 스택 캡처]

- 커밋을 셋으로 나눴다: 장 시계 이동(+ MarketClock·Shell 시험) · 셸 겉모양 · 목록 행(더보기·검색 결과 — lib `nav`·`search`를 건드려 따로 뺌).
- 장 상태 칩은 높이 28px(lg 미만)·32px(lg), 좁은 화면 둘째 줄은 `h-10`(칩 + 아래 여백). 가장 좁은 화면(sm 미만)은 칩 둘이 한 줄에 들도록 가운뎃점과 초를 숨긴다
  (390px에서 '휴장 (주말)' 둘이 든다 — sm 미만 칩 안쪽 여백·칩 사이 6px, 검토 반영 §7-5. 처음 셸 단계에서는 4px 넘쳐 둘째 칩 끝이 잘렸다.
  '휴장 (공휴일)'이 끼거나 360px이면 그 줄만 가로로 넘기고 페이지 가로 스크롤은 없음 [추정 — 공휴일 글은 재지 않음]). title은 '한국 (KOSPI) 날짜 시각 — 상태 — 휴일 안내'.
  마운트 전에는 같은 높이의 빈 칩 둘(aria-hidden)로 자리를 잡는다.
- 상단바 lg: 검색 단추에 기준 폭 520px(`lg:basis-[520px]`)을 주고 칩 묶음은 줄지 않게 했다 — 검색과 빈칸이 둘 다 `flex-1`이면 남는 폭을 반씩 나눠 검색이 좁아지고,
  1024·1280px에서 칩이 벨 밑으로 밀렸다. 상단바 좌우 여백은 32px(1280px에서 검색 왼쪽 끝 = 본문 카드 왼쪽 끝). 벨 수 배지 글자는 11 → 12px.
- SubNav 목록 여백은 본문 여백에서 탭 안쪽 여백(12px)을 뺀 값(`px-1 sm:px-3 lg:px-5`)이라 첫 탭 글이 본문 글과 같은 세로줄이다. /paper의 위계는 크기 차이
  (SubNav md 15px·48px, 7탭 sm 14px·44px)와 자리(폭 전체 줄 · 본문 안)로 가르고 다른 장치는 두지 않았다.
- TabBar: 고대비(forced-colors)에서 지금 탭은 이름 밑줄(굵기 semibold ↔ normal 차이와 함께). SideNav 지금 탭은 `forced-colors:border`.
- 계정 행: 패턴 Avatar(36·40px) 대신 32px 원(테두리 + surface — 행 hover 바탕 surface-2 위에서도 보이게), 글자는 `lib/access`의 `accountInitial`(이메일 첫 글자).
  이름은 말줄임 + title(예전 `break-all` 여러 줄 대신).
- 더보기 행 아이콘은 `shell/icons`의 `MenuIcon(href)`(알림·AI 종합 분석·저장소 상태·연결 테스트·사용자 관리·내 계정 여섯, 없는 경로는 더보기 아이콘).
  더보기 h1은 화면 다듬기 단계의 PageHeader 커밋(h1 20곳)에서 바꾼다 — 이 단계는 목록 행만.
- 검색 결과 원은 `lib/search`의 `avatar`(`{tab}` 또는 `{text}` — 메뉴 항목에 `NavSearchItem.tab`을 더함), 고른 행에서는 원 바탕을 surface로(행 바탕 surface-2와 겹치지 않게).
  입력칸은 닫기 단추 앞에서 끝나게 `mr-10`(안쪽 여백으로 비키면 닫기 단추가 입력칸 테두리·포커스 링 위에 겹침). `SearchCommand.test`의 종목 결과 글 단언은
  장식 원(aria-hidden — 모노그램 'AAP')을 뺀 글로 비교하고 원 글자를 따로 본다.
- 이모지 단계로 남긴 셸 글자: 잠금(SubNav·MoreMenu·SearchCommand — 잠금 커밋), 새로고침 단추의 로켓(장식 커밋), 로그아웃 오류의 경고(공용 커밋),
  검색 결과 보조 글의 매크로 범주 제목 그림 문자(`indicatorEntries`의 `category.title` — 표시 정리 도우미 커밋에서 `withoutLeadingIcon`).

## 7. 화면

### 7-1. 공통

- 페이지 머리 `PageHeader`(새 ui 조각): h1 `text-2xl sm:text-title-1`, 설명 `text-[15px] text-text-2`, 오른쪽 actions. 직접 쓰던 `<h1 className="text-xl font-bold text-bright">` 20곳을 바꾼다
  (status·correlation·krx·sector·macro·admin/users·account·consensus·connections·institutions·regime·scorecard·liquidity·ai/report·style·cot·radar·alerts·MoreMenu·PaperScreen).
- 구역 간격 `gap-6 lg:gap-8`. `text-[10px]`·`text-[11px]`(약 190곳)는 `text-xs`로 — 기계적 일괄 커밋 하나.
- 1280px: SideNav 232를 빼면 본문 1048px라 max-w-7xl에 닿지 않고 여백 32px. 1440px 이상에서 가운데 정렬.

### 7-2. 강조 파랑이 데이터를 나르던 곳 — 중립으로(A1, D4)

| 곳 | 지금 | 바꿈 |
|---|---|---|
| `lib/format.ts` `statusColor('blue')` | text-accent | 네 단계를 지키려고 `text-text`(굵기 없음)로 — 기본값 `text-body`(text-2)와 다른 단계. 뜻은 라벨 글 |
| `regime/page.tsx` RECOVERY 톤·타임라인 `bg-accent/70` | 파랑 | 글은 text-text, 띠는 `bg-text-2` — UNKNOWN(`bg-border`)과 회색 둘이 겹치지 않게 명도 차이를 둔다 |
| `style/page.tsx` 유사도 막대 `bg-accent/70` | 파랑 | `bg-text-3` |
| `lib/paper.ts` `TONE.info`(+ `lib/paperKr` 같은 팔레트) | accent 테두리·글 | 데이터 배지(대기·사후 체결·분할 조정·선정·L1·CLAIM 해석)라 중립 `border-border bg-surface-2 text-text-2` |
| `SettingsSection` `CHANGED_BADGE` | accent | 중립 배지(+ 글 '바뀜') |
| `FrameworkSection` 배지·표시 여러 곳 | accent | 중립(글이 뜻을 나름) |
| `ai/report/ReportView.tsx` 판정 표시 | accent | 중립 |
| `AccountDetailPanel` 파란 테두리 | accent | `border-text`(잉크) |
| `alerts/page.tsx` 안 읽음 점·강조 | accent | 안 읽음 점은 `bg-text`, 글은 굵기 |
| `AutoRefresh` '갱신 중…' | text-accent | text-text-3 |
| `status/page.tsx` 표시 | accent | 중립 |
| `home/AlertsSummary.tsx` 안 읽음 점 | bg-accent | `bg-text`(시험의 `.bg-accent` 단언은 같은 뜻의 클래스로) |
| 그대로 | — | `consensus/page.tsx`·`macro/FxCompareSection.tsx`의 고르기 토글(누르는 것), 링크·주 단추·포커스·현재 메뉴·알림 수 배지 |

### 7-3. 화면별

- **홈 `/`**: 운영자면 lg 두 칸(RegimeHero | PaperHero, items-stretch), 회원은 국면 히어로 한 줄. RegimeHero 판정 라벨 display-sm 굵게 + StatGrid 2×2(빠진 신호 '—'와 사유).
  PaperHero는 미국|한국 세그먼트(위), 값 display, 칩 '출발 대비', 마지막 관측 캡션·배지, 계좌 AssetRow에 아바타(`bookMonogram` + 계좌 색 고리) — **장부 값 그대로**(장중 값은 장중 명세 단계).
  시장은 카드 밖 h2 '시장'(title-2), 범주별 AssetList(h3 title-3) `xl:grid-cols-2`, 행에 아바타(`assetMonogram`)·스파크라인(sm 이상)·값·칩·배지. 390px 한 칸, 히어로 숫자 36, 아바타 36.
- **모의매매 `/paper/us`·`/paper/kr`**(D1): PageHeader·밑줄 7탭·Freshness 오른쪽·공용 조각 겉모양·이모지 정리만. 개요의 히어로·계좌 행 아바타·기간 공유는 장중 명세 단계가 이 패턴으로 한다.
  기관 이름의 [국기]는 화면에서 떼고(옛 DB 값 포함), 계좌2 설정 묶음 라벨의 [시험관]은 지운다.
- **시장 탭**(/macro·/liquidity·/sector·/correlation·/cot·/regime): 공용 조각의 바뀐 모양(Card 16·Metric은 StatTile 모양·Banner 아이콘·차트 문법)을 받는다. /macro 스프레드 '역전'은 warn 톤 +
  아이콘, /regime 국면 색 중립·LockIcon, /cot 안내의 [서랍] 지움. 4단계 이식은 하지 않는다.
- **기관 탭**: 표 머리·hover, 13F 액션 `SourceBadge`를 `holdingActionView(label)` 아이콘 배지(Plus·XCircle·ChevronUp·ChevronDown·Minus, 중립색 — up/down 토큰은 뜻 전용이라 쓰지 않음)로,
  기관 이름의 [국기] 뗌(스타일 화면 shortName은 결함 **QA-153** — test(QA-153) it.fails → fix(QA-153)).
- **한국 탭**: 레이더 경고 배너 아이콘·상태 칸 StatusText, KRX 추정 배너 아이콘·성향 칸은 기호를 떼고 글만(색 없음).
- **더보기**: /alerts 제목·본문 정리, /ai/report '리포트 생성' primary·엔진 라벨 정리·판정 글 배지(D8 e), /status StatusIcon·JSX 범례·완료 토스트 톤, /connections '선택 모델 호출'·토스 StatusText,
  /admin/users Check + sr '인증됨', /account StatusDot + '지금 이 기기'.
- **인증 화면**(/login·/signup·/reset·/verify·/privacy, `AuthCard`): 가운데 `max-w-sm rounded-card p-8`, 제목 24 bold(/login h1의 [자물쇠] 지움), 입력칸 `inputClasses` h-12, 주 단추 primary 폭 전체.
- **대시보드 레이아웃 오류 상태**(`(dashboard)/layout.tsx`): AlertTriangle(aria-hidden)과 h1 글. 문구 그대로.

### 7-4. 구현 메모(화면 다듬기 단계, 2026-11-01) — 위 설계와 달리 한 것 [확인 코드·시험·QA 스택 캡처]

- **PageHeader**(`c218438c`): ui의 새 조각 — h1 `text-2xl sm:text-title-1`, 설명 `text-body-md text-text-2`, 동작은 제목 묶음의 아래 끝에 맞춰 오른쪽(`items-end` —
  이름표가 위에 있는 고르기 상자의 상자가 설명 줄과 한 줄), 설명 아래 덧붙일 줄(매크로 자동 갱신 안내)은 children. 20곳을 바꾸며 저장소 상태의 신선도 배지를
  설명 줄 안에서 동작 칸으로 옮겼고, 순유동성의 배지는 고르기 상자와 같은 높이 칸의 가운데에 둔다(예전 5px 올림은 상자 높이가 바뀌어 맞지 않음).
  `pageHeader.test`가 화면 소스에 예전 h1 모양(`text-xl font-bold`)이 다시 들어오는 것을 막는다. 구역 간격 `gap-6 lg:gap-8`도 같은 커밋.
- **글자 하한**(`cb9b180b`): `text-[10px]`·`text-[11px]` 178곳(시험 제외 47파일) → `text-xs`. 차트 SVG 글자는 차트 커밋(`b92743f2`)에서 이미 12px.
- **배지 모서리**(`bc3d29ba`): 추정·이전 값 배지는 `rounded-full`이 아니라 `rounded-control`(12px) — 한 줄(22px)이면 알약과 같고, 사유가 긴 이전 값 배지가
  390px에서 두세 줄로 접히면 `rounded-full`은 타원이 되어 글이 모서리에 걸렸다.
- **홈**(`82baad6d`): 시장 행 아바타는 `macroCardRow`의 `assetMonogram`, 계좌 행 아바타는 `paperHomeModel`의 `bookMonogram`(개요와 공용인 `bookAssetRow`에는 넣지
  않음 — 개요 행 아바타는 D1). **계좌 색 고리는 달지 않았다** — 홈에는 그 색이 가리킬 순자산 곡선이 없고, 색 표(`BOOK_COLORS`)가 `OverviewSection` 안에 있어
  옮기면 D1에 어긋난다(§12). 국면 히어로는 `Hero valueKind="label"`(새 선택 prop — 판정 라벨은 28/36px, 숫자 자리 맞춤 없음; 44px 라벨이 반 폭에서 세 줄로 접혔음).
  시장 범주 목록은 `xl:grid-cols-2`, '시장' 제목 title-2. `AssetRow`의 값·칩 덩어리에 `ml-auto` — 좁은 화면에서 아바타·이름과 한 줄에 들지 않아 내려가도
  오른쪽 끝(설계 '값과 칩은 오른쪽 한 덩어리'). **홈 차트의 문지르기는 쓰지 않았다** — 홈에는 시계열 차트가 없고(매크로 개요에 이력 없음), 모의매매 `navSeries`로
  히어로 곡선을 더하는 것은 정보 구조를 바꾸는 일(A6)이라 §12. 문지르기를 처음 쓰는 화면은 장중 값 단계의 개요 히어로다.
- **A1 감사**(`cd98d91b`): §7-2 표대로. 다르게 한 것 — 매크로 '갱신 중…'은 text-2(설계 text-3: 바로 옆 글이 이미 text-3라 같은 색이면 상태가 바뀐 것이
  보이지 않음), 홈 안 읽음 점은 `bg-text` 대신 `border-4 border-text`(고대비 모드에서 바탕색이 지워져도 찬 점), 알림함 읽지 않은 알림은 `border-strong` 테두리·
  잉크 점·굵은 제목, AI 리포트 결론 칸은 `border-strong`, 프레임 판 비교의 강조한 줄은 `surface-2` 바탕 + 굵은 잉크 글(굵기가 고대비에서도 남음),
  복기에서 연 제안은 잉크 2px(`border-text ring-1 ring-text`). 국면의 다른 세 칸과 설정 '규칙 계좌 영향' 배지의 투명 틴트도 불투명 틴트로.
  새로 생긴 쌍의 대비(라이트 / 다크): 켠 거르기 칩 accent ÷ accent-tint 5.43 / 5.56 · 중립 배지 text-2 ÷ surface-2 6.15 / 8.47 · 읽은 알림 text-3 ÷ surface-2 50% 4.86 / 5.68 ·
  국면 띠 회복(text-2) ÷ 판정 불가(border) 5.41 / 7.03 · 결론 테두리 border-strong ÷ surface 3.38 / 3.69 · 스타일 막대 text-3 ÷ 트랙 surface-2 4.62 / 5.30 [확인 tools/contrast 계산].
- **옛 화면**(`503bba68`): `rounded-md·lg·xl` → `rounded-control`, 데이터 배지 `rounded-sm` → 알약(`px-2`), 투명 warn·ok 틴트 → 불투명. 거르기 칩 `filterChipClasses`
  (새, ui/classes — 교집합 분석 대상 기관·환율 겹쳐 보기): 켠 칩은 강조 파랑(누르는 것)에 굵은 글과 체크 아이콘(장식), 두 상태 모두 테두리. 결정 로그 보기·실행 감사
  계좌의 단추 묶음은 세그먼트(`SEGMENT_TRACK`·`segmentClasses` + `FOCUS_RING` — aria-pressed 단추라 포커스 링은 단추에). Metric 격자 간격은 `StatGrid`와 같은
  `gap-3`이라 그대로, 표 hover는 기반 단계에서 끝남. **D1 세 파일**(`OverviewSection`·`LiveValuationCard`·`AccountDetailPanel`)의 옛 모서리·투명 틴트는 그대로다
  (A1의 계좌 상세 테두리만 바꿈) — 장중 값 단계 몫.
- **인증 화면**(`e3590e66`): 클래스는 `components/auth/classes.ts`(새, React 없는 모듈 — 서버 컴포넌트 `/privacy`와 로그인 화면이 함께), 입력칸 `inputClasses("lg")`
  (새 크기 48px·15px), 주 단추는 `buttonClasses("primary")` 폭 전체(높이는 md — 44/40px). 대시보드 레이아웃 오류 화면 둘은 16px 모서리·주 단추 sm.
- **고대비(D9)**(`07e8240d`): headless 크롬에서 CDP `Emulation.setEmulatedMedia({forced-colors: active})`로 확인했다 — 투명 테두리는 시스템 글자색으로 칠해지고
  바탕색은 지워진다. 그래서 밑줄 탭의 나머지 탭은 그 모드에서 밑줄을 지우고(`forced-colors:border-b-0` — 예전에는 모든 탭에 밑줄), 고른 행 막대는 공용
  `SELECTED_BAR`(`bg-text` + `forced-colors:border-l-[3px]` — 자산 행·검색 결과)로 테두리로도 그린다. 고른 알약·세그먼트·SideNav·TabBar·상태 점·히어로 문지르기
  알림 영역·차트 SVG 12px는 앞 단계에서 끝났다.

### 7-5. 검토 반영(2026-11-01) — 화면 검토의 지적 [확인 코드·시험·QA 스택 측정·캡처 `shots/refix`]

- **본문이 sr-only 글의 위치 기준**(`db1786a4`): `main`에 `relative`. 본문 안 sr-only 글(absolute — 상태 아이콘 이름·상태 글·배너·신선도·출처 머리말)이
  위치 지정 조상 없이 문서를 기준으로 놓여, 390px /admin/users의 문서 폭이 544px(하단 탭 바가 화면 밖)이었고 1280px에서는 문서 높이가 본문 끝까지 늘어
  본문 끝에서 휠을 더 굴리면 셸이 밀려 비었다. 고친 뒤 390px 문서 폭 390, 1280px 홈·레이더·/paper/us 문서 높이 900(= 창). 데스크톱 쪽은 출처 머리말로
  `70a82179`에도 있었을 것이다 [추정 — 옛 빌드로 재현 안 함].
- **차트 축 폭**(`643891cd`): 가로 막대·세로 막대의 세로축과 `MultiLineSeries` 왼쪽 축은 Recharts `width="auto"`(3.10.1 — 그린 눈금을 재서 폭을 정하고 눈금 글을
  접지 않음). §5-1의 12px 글자에 고정 폭(150·64·64px)이 모자라 'KODEX 코스닥150선물인버…'·'-16,000계약'이 잘리고 '193,971 계약'이 두 줄로 접혔다.
  `CategoryTick`은 Recharts의 className을 넘긴다(자동 폭이 그 이름으로 눈금을 찾음). `axisWidth`를 주는 곳(한국 개요 84px)만 고정. 13화면 1280·390px에서
  SVG 밖으로 나간 글 0.
- **지표 칸**(`2882eb8e`): Metric 값 24px('+0.347%p' 약 137px)이 좁은 칸을 넘었다. 금리차 두 묶음은 `2xl`부터 옆으로·스크래핑 세 칸은 `md`부터, COT 네 칸은
  `xl`부터. 390~1920px 여덟 폭에서 넘침 0. Metric 글자 단계는 그대로.
- **단추**(`a9bc82d8`): `BUTTON_BASE`에 `whitespace-nowrap` — 표의 좁은 칸에서 알약 글이 접혀 세로로 긴 캡슐이 됐다('상세 펼치 / 기'·'다시 실행').
  30화면 390·1280px 첫 화면에서 본문 밖으로 나간 단추·높이 50px 넘는 알약 0.
- **배지**(`e08c0691`): `SourceBadge`도 `rounded-control`(§7-4 배지 모서리와 같은 까닭), '기준 분기' 칸은 `whitespace-nowrap`, 연결 표 '키' 칸은 `break-keep`.
  추정·이전 값 배지는 flex 줄바꿈 대신 글 흐름(`inline-block`) — flex는 사유를 통째로 넘겨 둘째 줄이 '· 관측치 …'처럼 가운뎃점으로 시작했다(홈 계좌 행).
- **상단바**(`19261a57`): 장 상태 칩 sm 미만 여백·사이 6px(§6-1), 검색 알약에 투명 1px 테두리(고대비에서 경계가 남음 — D9).
- **고르기 상자**(`aab0fdaf`): ui `NativeSelect`(새 — 날 select + `inputClasses(inputSize)` + 장식 화살표, 감싼 칸 배치는 `wrapperClassName`, 기본 `inline-block`).
  `Select`도 이것을 쓴다. 바꾼 곳은 설정 choice 칸·메모 '종류'·매크로 자동 갱신 간격(선택지 그대로 — D2). 장중 카드(`LiveValuationCard`)는 D1이라 남겼고,
  `formControls.test`의 소스 시험이 날 `<select>`가 있는 파일을 `ui/index.tsx`와 그 한 곳으로 고정한다(장중 값 단계가 바꾸며 목록에서 뺀다 —
  2026-11-01 바꿈 `3132e6a3`, 이제 목록은 `ui/index.tsx` 하나).
- **알림 규칙 '관심 기관'**(`4d20eb9a`): 선택지가 서버 기관 이름 그대로라 국기가 남았다 — `filerName`(비면 'CIK …'). 소스만 보는 noEmoji 시험이 못 잡는 자리.
- **'다시 실행' 안내**(`588941b5`): 시작·진행 중은 `useTaskRunner`의 새 톤 `progress` → 시계 아이콘(중립 색). 끝난 실행의 '알 수 없음'만 점선 원.
- **info·muted 배지는 글로만 갈린다**: A1로 `lib/paper` `TONE.info`를 중립으로 바꾼 결과 info(text-2)와 muted(text-3)는 바탕·테두리가 같고 글자색만 조금 다르다
  (예: 장중 확인 '대신함(REPLACE)' info·'그대로 둠(KEEP)' muted). 뜻은 글이 나르므로(색만으로 뜻을 전하지 않음) 바꾸지 않았다.
- **커밋 기록**: `b92743f2`(차트 틀을 `frame.tsx`로 옮기며 같은 커밋에서 글자 11 → 12px·툴팁 테두리를 바꿈)와 `a165ea94`(shell 아이콘을 `ui/icons`로 옮기며
  IconBase·focusable을 더함)는 옮기기와 고치기를 한 커밋에 담았고, `2ddc93d3`의 커밋 메시지 본문에 그림 문자 둘([나침반]·[경고])이 들어갔다. amend·rebase를
  하지 않기로 해 기록만 남긴다 — 다음 단계부터 이동 커밋(동작 그대로)과 값을 바꾸는 커밋을 나눈다.

## 8. 이모지 대응표

### 8-1. 프런트 화면 문구 — AST로 훑은 67개 문자열 노드 [확인 — §8-5와 같은 TypeScript AST 스캔, 주석·정규식 리터럴 제외]

| 묶음 | 곳(파일 — 찾을 글) | 바꾸는 방법 | 커밋 |
|---|---|---|---|
| 공용 [경고] | `ui/index.tsx` Freshness '새로 읽지 못함'·'오래된 저장본', [시계] '수집' · `ui/Toast.tsx` warn · `patterns/badges.tsx` StaleBadge · `patterns/AssetRow.tsx` 경고 줄 · `shell/AccountBox.tsx` 로그아웃 오류 · `home/PaperHero.tsx` 둘 · `home/RegimeHero.tsx` · `home/StoreStatusLine.tsx` · `ai/report/ReportView.tsx` 신뢰도 줄 | AlertTriangle·Clock 아이콘 + sr '주의: ' | 공용 이모지 |
| `lib/macroCards.ts` '[경고] 이전 값' | 글 '이전 값' + `tone: 'warn'`, 그리는 쪽이 아이콘 | 공용 이모지 |
| Banner 안의 [경고] **8곳** | `krx/page.tsx` · `macro/SingleChartSection.tsx` · `radar/page.tsx` 둘 · `krx/SpotFuturesCard.tsx` · `macro/FxCompareSection.tsx` · `liquidity/page.tsx` · `radar/FlowPanels.tsx` | 앞 기호만 지움 — Banner 톤 아이콘이 대신(반박 검토: 뒤 넷은 StatusText가 아니다 — 아이콘이 겹침) | 공용 이모지(Banner 아이콘과 같은 커밋) |
| [경고] 글 앞머리 | `correlation/page.tsx` · `sector/page.tsx` · `macro/RiskSection.tsx`('실제 지표가 아닙니다') · `macro/ScrapedSection.tsx` · `macro/SpreadSection.tsx` · `regime/page.tsx` · `style/page.tsx` · `status/page.tsx` interrupted 라벨 · `(dashboard)/layout.tsx` h1 둘 | `<StatusText tone="warn">`(h1은 아이콘 aria-hidden + 글) — 각 줄이 Banner 안이 아님을 커밋 때 다시 확인 | 화면 문구 |
| 문장 중간 [경고] | `macro/RiskSection.tsx` note · `macro/page.tsx` '역전 (Inversion) [경고]' | 기호만 지움 / '역전 (Inversion)' + tone warn(소비처 확인) | 화면 문구 |
| 상태 기호 | `lib/taskRun.ts` TASK_ICONS · `status/page.tsx` 부제 범례·키 상태·VERDICT_ICON·'최근' · `radar/page.tsx` 정상/실패 · `connections/TossSection.tsx` 연결 성공/실패 · `admin/users/page.tsx` 인증 | `taskStatusView(status)` 순수 함수 → `{tone: ok·warn·danger·neutral, label}` — **모르는 상태(예: interrupted)는 neutral·'알 수 없음' 기본값**. `useTaskRunner` 메시지는 기호 없이 '<태스크> 완료 — …' + `messageTone`. StatusText·CheckCircle·XCircle·Skip·CircleDashed | status·taskRun |
| [자물쇠] | `shell/SubNav.tsx` · `shell/MoreMenu.tsx` · `shell/SearchCommand.tsx` · `regime/TrackRecordSection.tsx`(info Banner의 icon을 Lock으로) · `regime/RegimeLogSection.tsx` · `login/page.tsx` h1 | `LockIcon label="유료 등급 기능"`(D8 c) / login은 지움 | 잠금 |
| 장식 | `connections/AiEngineSection.tsx` [시험관] · `lib/paper.ts` 계좌2 묶음 라벨 [시험관] · `paper/PaperScreen.tsx` 설명 [시험관] · `shell/RefreshButton.tsx` [로켓] · `ai/report/page.tsx` [번개]·[로켓] · `cot/page.tsx` [서랍] · `connections/TossSection.tsx` [위성][국기] · `account/page.tsx` [초록원] | 지우고 글만(account는 StatusDot ok) | 장식 |
| MarketClock [국기]·[여신상] | `components/MarketClock.tsx` | 지움(셸 이동 커밋) | 셸 |

- 남기는 글자 기호(이모지 아님): ChangeChip ▲▼, DataTable ↑↓↕(시험이 '↕'를 기대), →, ⌘, CopyButton '복사됨 ✓', AutoRefresh '↻'. ▴▾는 Chevron 아이콘으로 다듬는다.
- 정규식이라 남기는 것: `lib/markdown.ts`(AI 출력 판정), `lib/search.ts`(국기 떼기).

### 8-2. 서버·DB에서 와서 화면에 뜨는 글 — 표시 층에서 정리

- 예전 DB 행이 남으므로 코드를 고쳐도 표시 층 정리가 필요하다. `lib/format.ts`의 `withoutLeadingIcon`을 **문자열 어디에 있든** 그림 문자·U+FE0F·U+200D·지역 표시 문자를 지우고 공백을 정리하는
  쪽으로 넓히는 것을 먼저 검토한다(D8 f — 이미 Card·`lib/home`이 쓴다). 국기 쌍을 'US' 같은 ISO 코드로 바꾸는 `flagCountry(name)`은 보조 글이 필요할 때만.
- 적용: 알림 제목·본문(홈 `AlertsSummary` 포함 — `AlertService`의 '13F 신규 편입 — [국기]…'·`AlertEvaluator`의 기관 국기·[나침반]), `task_runs.detail`('[경고] 추정치'), 13F 액션 라벨,
  AI 엔진 라벨, 기관 이름(13F·스타일·교집합·스코어카드·모의매매 기관 선정·검색), 매크로 note(옛 저장본), KRX 성향(`krx.py`의 [초록원] 매수 우위(Long) 등 — 기호를 떼고 글만, 색 없음).
- AI 리포트 출력의 [초록원][빨강원][흰원]: 프롬프트가 시킨 '원본의 수급 판정 기호와 같은 뜻'(우호·비우호·중립·판단 보류) [확인 SnapshotTextService]. `ReportView` 렌더링에서만
  **'우호'·'비우호'·'중립'·'보류' 글 배지**(중립 바탕, 우호 ok·비우호 danger 아이콘 + 글)로 바꾼다(D8 e) — ▲▼·up/down 색은 값 변화 전용이라 쓰지 않는다('VIX 상승 → 비우호'가 ▼로 읽히는 오독 방지).
  복사·다운로드·`RawSnapshotCard` 원문은 그대로.

### 8-3. 서버 문구 — 화면 전용이라 바꾸는 것(AI 입력이 아님 [확인 grep])

| 묶음 | 곳 | 시험 | 커밋 |
|---|---|---|---|
| 저장소 안내 [서랍] 11곳 | VerificationService · KrFlowsService · CotService 둘 · GuruService · TrackRecordService 둘 · AnalyticsService · ScorecardService 둘 · FxService | 고정 시험 없음 [확인 grep] | 백엔드 1 |
| 알림 문구 | `AlertText`의 ' ([나침반] 시장 국면)' → ' (시장 국면)' | — | 백엔드 2 |
| AI 엔진 라벨 9개와 '[번개] 자동 탐색' | `AiService` ENGINES·안내 | `AiServiceAllowListTest`(라벨이 missingKey 문구에 실림) | 백엔드 3 |
| 13F 변화 상수 7개 | `HoldingsDiff`(예: '비교 데이터 없음', '신규 매수 (New)') — 쓰는 곳은 상수 비교·한글 contains라 동작 그대로(AlertRules·Sec13FService), 패킷은 `Signal13F` 코드 | `Sec13FServiceTest` | 백엔드 4 |
| 태스크 결과 문구 | `collector/app/tasks/series.py` 두 곳의 '([경고] … 추정치 — 누적 제외)' | 없음 | 수집기 |
| AWS 잠금화면 | `deploy/aws/gate/gate.py` '[자물쇠] 접근 코드가 필요합니다', 텔레그램 '[열린자물쇠] … 잠금 해제'·'[금지] … 실패'·'[경광등] … 전체 잠금', `services.json` 설명의 [시험관] | `test_gate.py` | 잠금화면(D6) |

### 8-4. 바꾸지 않는 것(D7)

`SnapshotTextService` 전체(AI 입력 원문 — [클립보드]·'[경고] 이전 값'·방향 기호 규칙, 고정 시험 SnapshotText*Test) · 기관 국기(`Institutions.java`, 수집기 `indicators.py` — Claude 패킷
`PacketBuilder` Names·골든 `packet-us-*.json` 7개·`PaperSelectionServiceTest`·알림 제목에 걸림) · 수집기 `indicators.py` 매크로 범주 제목(AI의 '###' 제목, DB 저장) · `krx.py` 성향(AI 입력,
`KrPacketBuilderTest`·`test_krx_investor_trend.py`) · `tasks/markets.py` STALE_NOTE·`macro_cards.py`(스냅샷 payload, `test_bond_override.py`) · `tasks/registry.py`의 [시험관](프런트가
`/api/status/tasks`를 부르지 않음) · `runner.py` 로그 아이콘 · 코드 주석 · 문서·README·CLAUDE.md·Makefile·scripts 콘솔 출력(§12 제안).

### 8-5. 지키는 장치

`frontend/src/lib/__tests__/noEmoji.test.ts`(새): `typescript`(이미 devDependency)의 `createSourceFile` AST로 `__tests__`·`__checks__`를 뺀 src의 .ts·.tsx에서 문자열 리터럴·템플릿 조각·JsxText만 본다
(주석·정규식 리터럴은 건너뜀 — 날 `createScanner`는 정규식과 나눗셈을 구별하지 못함). 찾는 글자: `\p{Extended_Pictographic}`·`\p{Regional_Indicator}`·U+FE0F·U+200D(FE0F 없는 [경고] U+26A0도 잡힘).
허용 목록: ▲▼↑↓↕→←↻✓✗⌘↔▪© 등 기호 글자.

### 8-6. 구현 메모(이모지 단계 — 프런트, 2026-11-01) — 위 설계와 달리 한 것 [확인 코드·시험]

- **Banner**: 톤 아이콘은 warn·danger 모두 AlertTriangle, 낭독기 머리말도 둘 다 '주의: '(설계는 danger '오류: '). danger 배너가 실패만이 아니라
  추정치 모드(유동성·KRX)·금리 역전 같은 심각한 주의에도 쓰여 '오류'로 읽히면 틀린다. info는 Info(아이콘만 accent), ok는 CheckCircle.
  `icon` prop(false면 없음 — 판정 성과 잠금은 이름 있는 LockIcon). ErrorState·StatusText danger는 XCircle·'오류: ' 그대로.
- **첫 줄 아이콘 칸 `LineIcon`**(ui/icons): 한 줄 높이(`h-[1lh]`) 칸 가운데에 아이콘 — 여러 줄 글에서도 첫 줄 옆에 남는다. StatusText·Banner·Toast가 쓴다.
- **StatusText**에 `iconSize`(12px 글 옆 12)·`colorText`(false면 글은 놓인 자리 색, 아이콘만 톤 색)를 더했다. 상관·국면·스타일 화면의 해석 주의(note)는
  `colorText={false}` — 설계대로 warn 글색을 입히면 긴 해석 문단 전체가 경고색이 된다. **StatusIcon**(새): 아이콘만 둘 표 칸 — 뜻은 sr-only 글과 `title`.
- **Freshness**: 경고 두 가지는 알약 안의 글자를 그 span의 글자 그대로 둔다(아이콘·'주의: '는 따로) — '새로 읽지 못함'으로 찾은 요소가 `title`·`role="status"`를 가진다.
- **저장소 상태**: 교차 검증 판정 아이콘은 장식(aria-hidden) — 바로 옆 판정 글(`entry.label`)이 같은 뜻을 읽혀 sr 라벨을 두지 않았다(설계는 sr 라벨). 표 범례는
  머리말 없이(`srPrefix=""`). 다시 실행 안내는 `messageTone`의 상태 글(강조 파랑 글자였던 status:134도 여기서 함께 바뀜).
- **표시 정리 도우미**: `withoutLeadingIcon`을 넓혔다 — 기호와 그 뒤 공백을 함께 지움('(시장 국면)' 괄호가 그대로 붙음), 줄바꿈 유지, ↔·↕·▪·©·®·™ 유지,
  뒤 보기(lookbehind) 정규식은 쓰지 않음(옛 Safari). 같은 일을 하던 `lib/search`의 `stripLeadingEmoji`는 지웠다. `flagCountry`(국기 → ISO 코드)는 만들지 않았다(보조 글이 필요한 곳 없음).
- **도메인 도우미**: `lib/holdings`(새) — `holdingActionView`(비교 데이터 없음·비교 불가는 CircleDashed — 설계의 다섯 아이콘 + 하나), `filerName`·`filerShortName`;
  `lib/aiEngines.engineLabel`; `lib/flows.stanceText`; `lib/taskRun.taskStatusView`·`taskDoneMessage`; `lib/markdown.splitVerdicts`·`VERDICT_LABEL`.
- **AI 리포트 판정**: 흰 원은 '중립·보류' 배지 하나(프롬프트의 뜻이 '중립·판단 보류' 한 기호). 굵은 글 안의 기호도 배지, 숫자 열 판정은 원문 기준.
- **기관 이름**: 교집합의 보유 기관·공통 신규 매수 기관 배지는 이름의 첫 낱말이라 예전에는 국기만 보였다 — 국기를 뗀 첫 낱말('국민연금') + 전체 이름 마우스 설명.
  스코어카드(`/scorecard`)는 종목 스코어카드라 기관 이름이 없다 [확인]. 스타일 유사도 행렬의 짧은 이름은 결함 QA-153으로 따로(재현 → 수정).
- **AI 엔진**: 라벨뿐 아니라 실패 문구(키 누락에 라벨이 실림)·'자동 탐색' 안내·폴오버 경로도 화면에서 정리.
- **noEmoji 시험**(`lib/__tests__/noEmoji.test.ts`): 지금 0건. 시험 자신이 검사기 표본(이스케이프한 U+26A0·템플릿 안 국기·JSX 속성·JSX 글은 잡고, 주석·정규식·
  나눗셈·허용 기호는 건너뜀)을 함께 확인한다. 시험 파일(`*.test.*`)·`__checks__`의 콘솔 출력 기호는 범위 밖(§12).

### 8-7. 구현 메모(이모지 단계 — 서버, 2026-11-01) [확인 코드·grep·시험]

- **바꾼 곳**(§8-3 표 그대로, 커밋 여섯): 저장소 안내 11곳 · `AlertText` 국면 알림 끝줄 · `AiService` 엔진 라벨 9개와 시간 초과 안내의 '자동 탐색' ·
  `HoldingsDiff` 상수 7개 · 수집기 `series.py` 두 곳 · 잠금화면(`gate.py` 안내 줄·텔레그램 세 문구, `services.json` 설명). 기호와 그 뒤 공백만 지웠다.
- **AI 입력에 들어가지 않는 근거**(D7): `SnapshotTextService`는 저장소 안내(`message`)를 읽지 않는다 — 없으면 '데이터 없음'·'COT 데이터 수집 실패'를 직접 적고,
  `CotService`의 두 안내는 `extremes()`(스냅샷이 부르지 않음) 안이다. 13F 변화 글은 스냅샷이 `consensus()`의 개수(`buyCount`·`sellCount` — 한글 `contains`)로만
  쓰고, 패킷은 `Signal13F` 코드(NEW·ADDED·CLOSED)를 쓴다. 엔진 라벨은 `engines()` 목록·실패 문구(`provider`·`error`)에만 실리고, 모의매매는 `structured()`(라벨 없음)를
  부른다. 시간 초과 안내는 모의매매 기록의 오류 칸에 남을 수 있지만 패킷(`PacketBuilder`·`KrPacketBuilder`·`CheckpointPacket`)과 복기 입력(`ReviewFacts`)은 오류 칸을 읽지 않는다. 수집기 결과 문구는 `collector_task_runs.detail`(상태 화면)이다.
  `AlertText`는 알림함·홈 요약에만 쓰인다.
- **시험**: 고친 고정 시험은 `AiServiceAllowListTest`·`Sec13FServiceTest`·`test_gate.py`. 바꾼 문구를 붙잡는 단언을 더했다 — `AlertServiceTest`(국면 알림 끝줄이
  '(시장 국면)'), `test_tasks.py`(추정치 KRX 선물 결과 문구 전체), `test_gate.py`(잠금 화면·기본 `services.json`·텔레그램 문구에 그림 문자 없음 — 표준 `re`에
  `\p{Extended_Pictographic}`이 없어 블록 범위로).
- **잠금화면**: 안내 줄은 로그인 화면 제목처럼 기호만 지웠다(아이콘 없음). `deploy/aws/offline/index.html`은 다시 확인해도 그림 문자가 없다(D6).
- **그대로 둔 것**: §8-4 목록, 고친 줄 밖의 주석 이모지(예: `series.py` 추정치 줄 위 주석, `application.yml`의 '자동 탐색' 주석), 프런트 시험의 옛 문구 표본(옛 DB 행 정리를
  시험하는 입력이라 남김). 화면의 표시 정리(`withoutLeadingIcon`·`holdingActionView`·`engineLabel`)는 옛 DB 행 때문에 그대로 둔다.
- 이 작업 환경에는 JDK 21이 없어(25뿐) 백엔드는 JDK 25로만 쟀다 — 바꾼 것은 문자열 리터럴뿐이라 판에 따른 차이는 없다 [추정].

### 8-8. 구현 메모(이모지 단계 — 주석·문서·스크립트, 2026-11-01) [확인 grep·시험]

- **바꾼 곳**(브랜치 `claude/emoji-sweep-2026-11`, §12 '이모지 나머지'): 코드 주석·독스트링·시험 이름(백엔드·수집기·프런트), 문서(README·CLAUDE.md·docs 최상위·ADR·명세),
  Makefile·scripts 출력, compose·env 예시 주석, 수집기 실행 로그 아이콘과 태스크 설명. 표식이던 그림 문자는 지우고, 뜻이 있던 것은 글자로 —
  [확인]→✓, [가위표]→✗, 줄 머리 [경고]→'주의:'(스크립트 출력은 '경고:'), [정보] U+2139→'참고:', [느낌표] U+2757→'주의:', 그림 화살표 U+25B6·U+25C0→►·◄,
  수집기 로그의 ok·empty·error·늦은 끝(U+23F1)→✓·!·✗·!.
  범례 표식은 꼬리표로 — DATA_SOURCES `[키]`·`[토스]`·`[정리]`·`[모의]`, ARCHITECTURE 분석 표 `[모의]`, API 수집기 표 `[토큰]`. 주석의 상태 기호는 상태 이름(`empty`·`error`)으로.
- **그대로 둔 것**: D7 목록과 그 고정본, 스냅숏으로 AI 입력이 되는 수집·서버 데이터의 글(기관 이름 국기·매크로 카드 제목·'이전 값' 꼬리·수급 판정 — `indicators.py`·
  `Institutions.java`·`markets.py`·`macro_cards.py`·`krx.py`)과 그것을 흉내 내는 시험 고정본, 그 글을 인용한 주석(`format.ts`·`holdings.ts`·`taskRun.ts`·`types/macro.ts`·
  `markdown.ts`), 체크섬이 걸린 `db/migrations`, 지난 기록(docs/qa·reviews·improve), 퍼저 입력(`scripts/qa/fuzz-api.py`).
- **맞물린 곳**: `backup-s3.sh`는 make 출력의 일반 실패 줄을 `^✗`로 거른다 — `db-common.sh`의 '✗ 백업 실패'와 짝이고 `test_aws_scripts.py`의 가짜 make 출력도 같이 바꿨다.
- **시험**: `noEmoji.test.ts` 둘째 시험 — Makefile·scripts(.sh·.yml)·compose 둘·env 예시 둘·README·CLAUDE.md·docs(.md, 지난 기록 셋 제외) 75개 파일의 줄에 그림 문자 0
  (허용: 화면 시험의 글자 기호 + ®·™). 코드 주석은 위 인용 때문에 넣지 않았다.

## 9. 시험 영향

- 시험은 바뀐 코드와 같은 커밋에서 고친다. 뜻을 보는 단언(role·aria-label·aria-current·aria-sort·aria-expanded·sr-only 글·`text-warn`/`text-up`/`text-down`/`tabular-nums`/`sr-only`)은 지키고,
  겉모양을 고정한 단언만 새 클래스로 바꾼다. 시간에 기대지 않는다(목 응답은 `settled()` = act 뒤 `getBy`, QA-147·148).
- 이모지 글을 기대하는 프런트 시험 — 기호만 뺀다: '새로 읽지 못함'(refreshErrors·honestStates·paperClaude2·HomeScreen), '오래된 저장본'(paperOverviewStates), '운영자 계정이 아직 없습니다'
  (layoutSession — `getByRole('heading', {name})` 권장), '지금 이 기기'(accountLocal), '리포트 생성'(demoViewer·actions), '선택 모델 호출'(actions), 'macro_collected 완료 — 12건 저장'(actions — 톤 단언 추가),
  '데이터 수동 새로고침'(MoreMenu·Shell), `macroCards.test.ts` '이전 값' + tone warn, `paperClaude2.test.ts` 계좌2 라벨, badges·AssetRow의 경고 글리프(`svg[aria-hidden]`, textContent '주의: 이전 값'),
  국기가 든 기관 이름의 기대값(paperSelection·paperBlend — 픽스처 입력은 국기 그대로, 기대값에서만 뗌).
- 잠금 시험은 그대로 통과해야 한다: `getByRole('img', {name:'유료 등급 기능'})`(MoreMenu·Shell·SearchCommand). `<title>`이 없으므로 `linkLabels`·`rows()`의 textContent 비교도 그대로(D8 c).
- 겉모양 단언 — 새 값으로: Hero 값 `text-display-sm`·`sm:text-display`, Hero `rounded-card`, AssetRow `min-h-16`, ChangeChip sm/md 크기, 고른 행·검색 결과 막대 `.bg-accent` → `.bg-text`
  (AssetRow·paperAccountDetail·SearchCommand), StatTile `rounded-xl` → `rounded-control`. 그대로 통과: DataTable 첫 칸 `group-hover:underline`, RangeTabs `bg-surface-2`, ConfirmDialog `bg-accent`·`bg-danger`,
  badges(rounded-full 아님·border-dashed·rounded-full), StatTile `text-2xl`, Shell(grid-cols·lg:hidden·main), Toast `border-warn`.
- 백엔드·수집기: `AiServiceAllowListTest`·`Sec13FServiceTest`를 고치고 나머지(SnapshotText*·KrPacketBuilder·PaperSelectionService·골든 패킷·ApiIntegrationTest·StillRunningNoticeParity·
  test_krx_investor_trend·test_bond_override)는 그대로.
- 새 시험: icons, noEmoji, lib(`taskStatusView` 기본값 포함·`holdingActionView`·넓힌 `withoutLeadingIcon`(옛 DB 표본 '([나침반] 시장 국면)'·'([경고] 추정치)'·엔진 라벨·국기 이름)·
  `assetMonogram`·`bookMonogram`·`scrubModel`(null 점·첫 유효값)), 패턴 네 상태(Avatar·AssetRow avatarText·Hero scrub·tabsPlacement·문지르는 동안 배지·sr-only 문지르기 값·Banner 톤 아이콘과 감쌈),
  MarketClock(칩 글·상태 점·title). jsdom은 Recharts 좌표가 없어 `onScrub` 통합 시험이 어렵다 — 순수 함수와 prop을 따로 시험한다 [추정].
- 커밋마다 네 영역(수집기·백엔드·gate·화면 check/test/lint/build) 모두 0. 백엔드 커밋은 JDK 21로도 잰다(CLAUDE.md 함정).

## 10. 커밋 순서(D10) — 토큰 → 기본 요소 → 패턴 → 차트 → 셸 → 이모지 → 화면 다듬기

| 단계 | 커밋 |
|---|---|
| 기반(foundation) | 0 docs 이 명세 · 1 토큰 · 2 ui 아이콘·StatusDot/StatusText·닫기 X 하나로 · 3 Button·`buttonClasses` · 4 Card·SourceLine·Metric·SourceBadge · 5 폼 컨트롤(Select·`inputClasses`·포커스 링, 날 입력 36곳) · 6 Table·Dialog·Toast · 7 Banner 틴트·ok 톤과 Loading·Empty·Error |
| 패턴 | AssetRow·AssetList·Hero 숫자·StatTile·배지·DataTable·RangeTabs·옛 RangeTabs·세그먼트·밑줄 탭(forced-colors 포함) · Avatar(+ lib 모노그램) · Hero 문지르기(+ LineChart hero·onScrub·useChartScrub·scrubModel·sr-only live) |
| 차트 | 격자 없는 단일 선 문법·글자 범례·툴팁 겉모양 · SVG 글자 12px |
| 셸 | MarketClock을 TopBar로 옮김 + 새 MarketClock 시험 · 셸 스타일(본문 폭·SideNav·검색·벨·SubNav·TabBar·MoreMenu·검색 결과 행) |
| 이모지(프런트) | 공용 조각 + Banner 톤 아이콘 + Banner 안 [경고] 8곳 · status·taskRun · 잠금 · 장식 · AI 리포트 판정 글 배지 · 표시 정리 도우미·시험 · 13F 액션 · 기관 이름(paperSelection·paperBlend) · 알림(홈 요약 포함) · 엔진 라벨 · KRX 성향 · test(QA-153) · fix(QA-153) · noEmoji 시험 |
| 이모지(서버) | 백엔드 저장소 안내 · AlertText · AiService(+ AllowListTest) · HoldingsDiff(+ Sec13FServiceTest) · 수집기 series.py · AWS 잠금화면(+ test_gate.py) |
| 화면 다듬기 | PageHeader(h1 20곳) · 글자 하한 12px(일괄) · 홈 · 옛 화면(A1 감사 §7-2·간격·표 hover) · docs(UI 설계 §12 결과·PRINCIPLES 인용 문구·API.md·DATA_SOURCES '이전 값' 인용·ADR 0004 덧붙임·README) |

- 모의매매 개요 포트폴리오식(원 명세 커밋 21)·새로고침 1시간·3시간은 장중 명세 단계(D1·D2). Pretendard(원 명세 커밋 2)·KRX 이중 축(23)은 하지 않음(D3).

## 11. 위험과 사용자에게 알릴 것

1. 강조색이 잉크 → 파랑(#3550dc / 다크 #7a90ff), 표면이 따뜻한 회색 → 차가운 회색, 라이트 바탕 #f7f7f5 → #ffffff(D5). 되돌리기는 토큰 값뿐.
2. 상승 빨강·하락 파랑 유지(D4). Coinbase처럼 초록/빨강을 원했다면 대안이 있다(라이트 up #0f7a48·down #cc2f2f, 다크 #36c37a·#ff5c57) — up이 ok와 ΔE 1.3~1.5로 사실상 같아 ok도 바꿔야 하고 KRX 습관과 충돌해 권하지 않는다.
3. 강조 파랑과 하락 파랑은 색으로 구분되지 않는다(검증기 FAIL) — A1이 깨지면(데이터 칸에 text-accent) 하락으로 오독된다. §7-2 감사로 막고, accent 위치를 고정하는 시험은 §12 제안.
4. 시험 변동(이모지 글 약 45줄·겉모양 단언 10여 개·국기 기대값 12줄). DOM 순서·영역 이름에 기대는 숨은 결합이 있을 수 있다 — 커밋마다 네 영역 시험.
5. 문지르기: 마우스 경로는 타입으로 확인, 키보드·터치(세로 스크롤과의 충돌)는 실제 브라우저로 확인해야 한다 [추정].
6. Safari·Firefox에서 SVG 속성 안의 `var()`가 풀리는지는 여전히 확인하지 않았다(UI 설계 §11-4).
7. DB에 남은 옛 문자열은 표시 정리 함수가 덮는 칸에서만 정리된다. noEmoji 시험은 프런트 소스만 지킨다. 덮지 않는 칸: 모의매매 결정·복기·프레임 제안의
   오류 칸(`lib/paper`의 결정 요약·결정 행·복기 오류, `ReviewsSection`의 실행 오류, 제안 실패 문구) — 예전 시간 초과 안내의 '[번개] 자동 탐색'이 남은 행이면
   그대로 보인다(QA DB 0건, 운영 DB는 확인하지 않음). §12.
8. MarketClock을 TopBar로 옮기면 좁은 화면 TopBar가 32px 늘어난다(정보는 그대로).
9. 배포: `deploy.sh`는 backend·frontend·collector·gate를 모두 다시 빌드한다(정기 작업이 다시 시작됨 — 장중 명세 위험 9). 시각 창은 두지 않고 화면 확인이 끝나 준비되면 바로 한다(사용자 지시 2026-10-31 밤, 서버가 꺼져 있으면 켜서).
10. 4단계(옛 화면 18개의 경로 이식·상세 페이지)는 이번에도 하지 않는다 — 옛 화면은 공용 조각 덕에 겉모양만 바뀌고 구조(Metric 격자·옛 Table)는 남는다.
11. 이모지 범위: 화면과 서버의 화면 문구만. 주석·문서·CLAUDE.md·Makefile 출력(약 900줄)은 별도 정리(§12).

## 12. 제안 — 이 브랜치에서 하지 않음

- **Pretendard 자체 호스팅**(D3): `next/font/local`(Next 내장 — 새 npm 의존성 아님)·`PretendardVariable.woff2`·OFL-1.1. 공개 저장소에 약 2MB [추정] 바이너리와 라이선스가 들어가고, 공식 배포본의
  버전·체크섬 확인이 필요하다. 하지 않으면 Windows는 맑은 고딕으로 보인다. 대체 스택 `Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif`도 그때 함께.
- **KRX 이중 축을 패널 둘로**(D3, PRINCIPLES '이중 축 금지'): `krx/page.tsx`의 두 차트. 화면 배치가 바뀌는 선택이라 사용자 확인 뒤.
- **인쇄 규칙**(D9): 지금 없음.
- **이모지 나머지**: 코드 주석(프런트 약 120줄·백엔드 217·수집기 100)·문서 약 422줄·README 48·CLAUDE.md 2·Makefile·scripts 콘솔 출력 — 별도 chore 커밋 묶음, 사용자 확인 뒤.
  — 2026-11-01 정리함(§8-8).
- **지킴 시험 더**: 백엔드 화면 문구의 noEmoji 시험(스크립트·문서는 §8-8에서 더함), 데이터 영역의 `text-accent`·`bg-accent` 위치를 고정하는 시험(A1).
- **Y 끝값 눈금**(§5-1): 여백 포함 범위 끝 대신 데이터 최고·최저를 적거나, 묶인 지수(0~100)는 범위 상한을 받게 — 1단계 결정(`lineYAxis` 눈금 = 범위 끝)을 바꾸는 일이라 사용자 확인 뒤.
  — **히어로만** 2026-11-01 장중 화면 검토 반영에서 바꿈(`03526dc3`·`d17a2485`): 히어로(`LineChart variant="hero"`)는 축 눈금 글 없이 본 계열의 실제 최고·최저를 그 점
  위·아래에 적는다(`lib/lineChart` `heroExtremes` — 꼬리 계열 제외). 히어로에서는 범위 끝 글(예: 최댓값 100,556.89에 위 끝값 100,604.06)이 큰 숫자 옆의
  데이터처럼 읽히고 선·꼬리와 겹쳤다. 기본 선 차트·래퍼의 끝값은 그대로(사용자 확인 대상으로 남음).
- **차트 키보드 초점 링**: Recharts 그림(svg, tabindex 0)은 브라우저 기본 초점선을 쓴다 — `outline-focus` 2px로 맞추기.
- **홈 계좌 행 색 고리**(§7-4): 장중 값 단계가 개요 계좌 행에 아바타를 달 때 `BOOK_COLORS`를 `OverviewSection` 밖(예: `components/screens/paper/bookColors.ts`)으로
  옮기며 홈에도 함께. — 색 표는 옮김(2026-11-01 `e0e6f442`, 그 파일), 고리는 개요·홈 함께 닮(`7d12614b` — 홈 '/'가 recharts를 싣지 않게 색 출처는
  차트 틀 `frame`). 홈에는 그 색이 가리킬 곡선이 없어 원하지 않으면 홈만 뺄 수 있다(사용자 확인 대상).
- **홈 모의매매 히어로 곡선**(§7-4): 개요 응답의 `navSeries`로 Claude 계좌 곡선 + 문지르기를 홈에 더할 수 있다 — 홈의 정보 구조를 바꾸는 일이라 사용자 확인 뒤.
- **고대비 모드의 바탕색 그림**: 국면 이력 띠·스타일 유사도 막대·막대·도넛 차트처럼 바탕·채움색만으로 그린 것은 그 모드에서 지워진다(옆 표·숫자가 같은 값을 나름).
  `forced-color-adjust: none` + 시스템 색을 쓸지 정하기.
- **D1 세 파일의 겉모양**: `OverviewSection`·`LiveValuationCard`·`AccountDetailPanel`의 `rounded-md·lg·xl`·투명 경고 틴트·`rounded-sm` 배지, 장중 카드의 날
  select(→ `NativeSelect`, §7-5) — 장중 값 단계에서. — 장중 카드는 고르기 상자만 바꿀 것이었고 바꿈(`3132e6a3`), 나머지 둘(과 떼어 낸 계좌 비교 카드)도
  바꿈(`8aa35fc9`).
- **모의매매 오류 칸의 그림 문자 정리**(§11-7): 결정·복기·제안 오류를 그릴 때 `withoutLeadingIcon`을 거치게 — 장중 값 단계나 다음 정리 단계에서.
  — 2026-11-01 처리(`447c45ef` — `lib/paper` `storedText`, 자리는 장중 명세 §4-1 구현 메모).
- **매크로 자동 갱신 1시간·3시간**(D2): 사용자가 그쪽도 뜻했는지 장중 명세 단계 보고에서 묻는다. 넣는다면 다음 읽기 전까지 서버 stale 플래그가 갱신되지 않아 '오래된 저장본'(PRINCIPLES)을 최대 3시간 못 띄우는
  한계가 있다 — 화면에서 경과 시간을 다시 판정하거나 그 한계를 적는다. — 2026-11-01 사용자가 넣으라 해서 처리(`bd322989`). 화면에서 다시
  판정하지 않고(배지가 화면 설정을 말하지 않게) 한계를 PRINCIPLES '자동 갱신'에 적었다.
