/**
 * 다시 읽기로 사라지는 조작의 포커스 지키기 — 작업대 P8 키보드 경로의 한 규칙(QA-901 '다시 시도'·QA-902 쪽 넘김).
 *
 * 공용 `useApi`는 오류 뒤 다시 읽거나(다시 시도) 경로를 바꿔 읽는 동안(쪽 넘김) 값이 없으므로, 화면은 오류 상자·목록·쪽 단추 자리를 '불러오는 중'으로
 * 바꿉니다. 그러면 키보드로 누른 조작이 문서에서 빠져 크롬이 포커스를 body로 보내고, 다음 Tab이 문서 처음(본문으로 건너뛰기)부터 시작했습니다.
 *
 * 규칙: 포커스를 가진 조작이 다시 읽기를 시작했고, 그린 뒤 그 조작이 문서에서 빠졌고 포커스가 body면(그 사이 다른 곳으로 옮긴 포커스는 건드리지 않음)
 * 다시 읽기를 시작한 자리의 제목으로 옮깁니다 — 조작의 조상 가운데 남아 있는 가장 가까운 것에서 위로 올라가며, 먼저 만나는 패널·영역(section·region·
 * dialog)의 머리 제목(머리 header 안이나 바로 아래 h1~h3), 본문(main)에 닿으면 그 화면 제목(h1), 화면 제목도 없으면 본문 자체(건너뛰기 링크의 목적지 —
 * tabIndex -1). 제목은 tabindex가 없으면 -1을 잠깐 붙였다가 포커스가 떠나면 뗍니다(제목 링은 globals.css가 그리지 않음 — 목차 이동과 같음).
 * 값이 오면 그 제목·영역은 그대로 남아 포커스가 이어지고, 다음 Tab은 새로 그린 내용으로 갑니다.
 *
 * 고른 안(진행 기록 D3b의 A 'blur'·B '제목에 포커스' 가운데 B): 쪽 넘김·다시 시도는 같은 자리의 내용을 새로 읽는 일이라 그 자리의 제목이 '어디에
 * 있는지'를 낭독하고 다음 Tab이 새 내용의 처음으로 가는 B가 맞습니다. A(포커스를 비움)는 크롬이 다음 Tab을 사라진 조작의 자리에서 잇기도 하지만
 * 낭독기는 아무것도 읽지 않고, 지금 body로 떨어지는 것과 사용자에게 구별되지 않습니다.
 *
 * 그리는 것은 같은 이벤트 안에서 끝나므로(React의 이산 이벤트 갱신) 한 번의 setTimeout(0) 뒤에 봅니다. 서버 렌더에서는 부르지 않습니다(누름 처리기 안에서만).
 */
export function keepFocusNearby(origin: HTMLElement): void {
  if (document.activeElement !== origin) return;
  const ancestors: HTMLElement[] = [];
  for (let node = origin.parentElement; node && node !== document.body; node = node.parentElement) ancestors.push(node);
  setTimeout(() => {
    if (origin.isConnected) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const start = ancestors.find((node) => node.isConnected);
    const target = start ? focusTarget(start) : null;
    if (target) focusQuietly(target);
  }, 0);
}

const HEADING = /^H[1-3]$/;

function focusTarget(start: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = start; node && node !== document.body; node = node.parentElement) {
    const role = node.getAttribute("role");
    if (node.tagName === "SECTION" || role === "region" || role === "dialog") {
      const heading = ownHeading(node);
      if (heading) return heading;
    }
    if (node.tagName === "MAIN") return node.querySelector<HTMLElement>("h1") ?? node;
  }
  return null;
}

/** 패널·영역의 머리 제목 — 바로 아래 header 안의 첫 h1~h3, 없으면 바로 아래 h1~h3(안쪽 다른 패널의 제목은 고르지 않음). */
function ownHeading(section: HTMLElement): HTMLElement | null {
  for (const child of Array.from(section.children)) {
    if (child.tagName === "HEADER") {
      const heading = child.querySelector<HTMLElement>("h1, h2, h3");
      if (heading) return heading;
    }
    if (HEADING.test(child.tagName)) return child as HTMLElement;
  }
  return null;
}

function focusQuietly(target: HTMLElement) {
  if (!target.hasAttribute("tabindex")) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus();
}
