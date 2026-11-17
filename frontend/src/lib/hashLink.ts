/**
 * 같은 화면 안 닻으로 가는 링크(`<a href="#id">`)의 누름 — 브라우저 기본 해시 이동 대신 기록 하나(history.pushState)와 닻 이동으로 바꿉니다(QA-680).
 * React를 모르는 모듈입니다(누름 사건에서 단추·수식키·막힘만 읽음 — ADR 0004). 화면은 링크의 onClick에서 부릅니다.
 *
 * 브라우저 기본 해시 이동은 상태(history.state)가 null인 기록을 쌓는데, Next 앱 라우터(16.4)는 뒤로·앞으로 가기의 popstate에서 상태 없는 기록을
 * 무시합니다(next/dist/client/components/app-router.js handlePopState). 그래서 목차로 절을 옮긴 뒤 다른 화면으로 갔다가 뒤로 가면 주소만 그 해시 기록이
 * 되고 화면은 다른 화면에 남았습니다(한 번 더 뒤로 가야 돌아옴 — D3 전 QA 스택 /macro → /sector). Next가 고쳐 둔 history.pushState는 지금 기록의 라우터
 * 상태(__NA·트리)를 새 기록에 옮겨 실으므로, 그 기록으로 돌아오면 라우터가 이 화면을 그립니다. 같은 화면 안의 뒤로·앞으로 가기에는 전처럼 hashchange가
 * 옵니다(긴 화면 목차의 QA-659 처리 — components/patterns SectionIndex).
 *
 * - 왼쪽 단추의 수식키 없는 누름(키보드 Enter가 만드는 누름 포함)만 맡고 true를 돌려줍니다. 가운데 단추·Ctrl·Meta·Shift·Alt(새 탭·새 창·내려받기)와
 *   이미 막힌 누름은 브라우저에 맡깁니다(false).
 * - 옮기기는 기본 해시 이동과 같은 scrollIntoView()(위 끝 맞춤 — 닻의 scroll-margin과 스크롤 상자의 scroll-padding을 따름, 즉시)입니다. 기본 해시 이동이
 *   순차 탐색 시작점을 닻으로 옮기듯 키보드의 다음 Tab이 그 절에서 이어지게 포커스를 둡니다(preventScroll — 옮긴 자리를 흔들지 않게).
 * - 포커스는 닻 안 첫 제목(h1~h6 — 닻이 제목이면 닻)에 둡니다. 크롬은 포커스 받는 이름·역할 없는 요소(div·이름 없는 section)의 접근 이름을 내용 전체로
 *   계산해, 닻에 두면 낭독기가 목차를 누를 때마다 절 전체(매크로 지표 표 전부)를 이름으로 읽었습니다(QA-680 보강 — 제목이면 제목 글만). 제목에는 그때만
 *   tabindex -1을 붙였다가 포커스가 떠나면 뗍니다(원래 tabindex가 있던 제목은 그대로). 바깥선은 전역 규칙이 그리지 않습니다(globals.css — 누를 수 있는
 *   것이 아님). 제목이 없거나 포커스를 받지 못하면(숨은 제목) 닻에 둡니다 — 닻에도 같은 식으로 그때만 tabindex -1을 붙였다가 떠나면 뗍니다(원래
 *   tabindex가 있던 닻 — 본문 main#main — 은 그대로, 닻의 바깥선은 닻이 지움 — 긴 화면 목차의 절 닻 SectionAnchor·AI 리포트 절의 outline-none).
 *   닻에 tabindex를 늘 두면 크롬이 뒤로·앞으로 가기(기록 이동)의 조각 처리에서 그 닻에 포커스를 두어 낭독기가 절 전체를 이름으로 읽었습니다(QA-688 —
 *   tabindex가 없으면 포커스는 body, 순차 탐색 시작점만 닻으로 옮겨 다음 Tab이 그 절에서 이어짐).
 * - `heading: false`면 제목을 찾지 않고 닻에 포커스합니다(본문으로 건너뛰기 — 본문 main은 역할 main이라 이름이 내용이 아님, 기본 해시 이동과 같은 자리).
 * - 주소의 해시가 이미 그 닻이면 기록을 더 쌓지 않고 옮기기만 합니다(같은 주소로의 이동 — 브라우저도 기록을 바꿔 씀).
 * - `record: false`면 기록·주소를 건드리지 않고 옮기기만 합니다(본문으로 건너뛰기 — 뒤로 가기에 남길 까닭이 없음).
 * - 닻이 아직 없으면 기록만 쌓고 옮기지 않습니다(기본 해시 이동도 주소만 바뀜).
 */
export type HashLinkClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

/** 주소 해시('#…' 또는 '')가 가리키는 id — 잘못된 % 꼴이면 null. */
function locationHashId(): string | null {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return null;
  }
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";

/** 요소에 포커스합니다 — 받았으면 true. tabindex가 없던 요소에는 -1을 붙였다가 포커스가 떠나면 뗍니다(원래 tabindex가 있던 요소는 그대로). */
function focusBriefly(element: HTMLElement): boolean {
  const added = !element.hasAttribute("tabindex");
  if (added) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  if (document.activeElement !== element) {
    if (added) element.removeAttribute("tabindex");
    return false;
  }
  if (added) {
    // 포커스가 다른 곳으로 떠나면 뗍니다. 창이 포커스를 잃은 것(다른 창·탭 — activeElement는 그대로)이면 돌아왔을 때 그 자리에서 이어지게 남겨 둡니다.
    const release = () => {
      if (document.activeElement === element) element.addEventListener("blur", release, { once: true });
      else element.removeAttribute("tabindex");
    };
    element.addEventListener("blur", release, { once: true });
  }
  return true;
}

/** 닻 안 첫 제목에 포커스합니다 — 받았으면 true(제목이 없거나 받지 못하면 false). */
function focusHeading(target: HTMLElement): boolean {
  const heading = target.matches(HEADINGS) ? target : target.querySelector<HTMLElement>(HEADINGS);
  return heading !== null && focusBriefly(heading);
}

/** 같은 화면 닻 링크의 누름을 맡습니다 — 맡았으면 true(기본 동작을 막음), 브라우저에 맡기면 false. 규칙은 모듈 설명. */
export function followHashLink(
  event: HashLinkClick,
  id: string,
  { record = true, heading = true }: { record?: boolean; heading?: boolean } = {},
): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  event.preventDefault();
  if (record && locationHashId() !== id) window.history.pushState(null, "", `#${id}`);
  const target = document.getElementById(id);
  if (target !== null) {
    target.scrollIntoView();
    if (!heading || !focusHeading(target)) focusBriefly(target);
  }
  return true;
}
