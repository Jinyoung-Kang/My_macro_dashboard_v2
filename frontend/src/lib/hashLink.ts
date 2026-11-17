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
 *   순차 탐색 시작점을 닻으로 옮기듯 키보드의 다음 Tab이 그 절에서 이어지게 닻에 포커스를 둡니다(preventScroll — 옮긴 자리를 흔들지 않게). 닻이 포커스를
 *   받으려면 tabIndex -1(바깥선 없음)이어야 합니다 — 긴 화면 목차의 절 닻(SectionAnchor)·AI 리포트 절·본문(main#main).
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

/** 같은 화면 닻 링크의 누름을 맡습니다 — 맡았으면 true(기본 동작을 막음), 브라우저에 맡기면 false. 규칙은 모듈 설명. */
export function followHashLink(event: HashLinkClick, id: string, { record = true }: { record?: boolean } = {}): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  event.preventDefault();
  if (record && locationHashId() !== id) window.history.pushState(null, "", `#${id}`);
  const target = document.getElementById(id);
  if (target !== null) {
    target.scrollIntoView();
    target.focus({ preventScroll: true });
  }
  return true;
}
