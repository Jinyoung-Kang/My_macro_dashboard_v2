/**
 * 좁은 화면(lg 미만) 누르는 자리 44px(원칙 A8 — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md, ADR 0041 결정 11 선례)을 클래스로 따지는
 * 시험 도우미. jsdom은 배치를 재지 않으므로 높이는 Tailwind 클래스로 읽습니다 — 시험 파일이 아니라 시험이 가져다 씁니다(homeFixtures와 같은 자리).
 *
 * - `belowLgTarget(classes)`: 변형 없는(모든 폭에 걸리는) 높이 클래스 가운데 44px 이상이 있고(`min-h-11`·`h-11`·`size-11`·`min-h-12`·
 *   `min-h-16`·`min-h-[44px]` 등), lg 미만에도 걸리는 sm:·md: 변형이 그보다 낮추지 않으면 통과(null). lg:·xl:·2xl: 변형은 더 작아도
 *   됩니다(넓은 화면은 30·32px 조밀 조작). 변형 없는 음수 아래 바깥 여백(`-mb-px`·`-my-px` 등)은 그만큼 다음 줄과 겹쳐 다음 줄의 요소가 그 자리를
 *   덮으므로(줄을 바꾸는 탭 줄 — underlineTabClasses wrap) 높이에서 뺍니다. 위 여백(`-mt-`)은 빼지 않습니다 — 뒤에 오는 이 요소가 앞 줄을 덮는 쪽입니다.
 *   아니면 까닭 글을 돌려줍니다.
 * - `smallTargets(root)`: 그린 DOM에서 누를 수 있는 요소(링크·단추·입력·summary·역할이 단추·탭인 요소)마다 그 요소(체크 상자·라디오는 감싼
 *   label도)가 `belowLgTarget`을 통과하는지 봅니다. 문장 안의 링크·단추(같은 부모의 글 마디에 그 요소보다 글자가 많음 — WCAG 2.5.8의 글 안
 *   예외, `inSentence`)와 화면에 보이지 않는 요소(sr-only·hidden)는 셈에서 뺍니다. 걸린 요소를 "태그「글」 — 까닭"으로 돌려줍니다.
 */

/** 클래스 하나를 변형(lg:·hover:·has-[…]: 등)과 유틸리티로 나눕니다 — 대괄호 안의 콜론은 가르지 않습니다. */
function splitVariants(token: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of token) {
    if (char === "[") depth += 1;
    if (char === "]") depth = Math.max(0, depth - 1);
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return { variants: parts, utility: current.replace(/^!|!$/g, "") };
}

/** 높이 유틸리티(h-·min-h-·size-)의 px — 간격 단위는 4px, 임의 값은 px·rem만. 높이 유틸리티가 아니면 null. */
function heightPx(utility: string): number | null {
  const match = /^(?:min-h|h|size)-(?:(\d+(?:\.\d+)?)|\[(\d+(?:\.\d+)?)(px|rem)\])$/.exec(utility);
  if (!match) return null;
  if (match[1] !== undefined) return Number(match[1]) * 4;
  return Number(match[2]) * (match[3] === "rem" ? 16 : 1);
}

/**
 * 음수 아래 바깥 여백(-mb-·-my-)의 px — 그만큼 다음 줄과 겹쳐 다음 줄의 요소가 그 자리를 덮습니다. 아니면 null.
 * 간격 단위는 4px, `px`는 1px, 임의 값은 px만.
 */
function bottomOverlapPx(utility: string): number | null {
  const match = /^-m[by]-(?:(px)|(\d+(?:\.\d+)?)|\[(\d+(?:\.\d+)?)px\])$/.exec(utility);
  if (!match) return null;
  if (match[1] !== undefined) return 1;
  if (match[2] !== undefined) return Number(match[2]) * 4;
  return Number(match[3]);
}

const TARGET_PX = 44;
/** lg 미만에도 걸리는 폭 변형 — 이것들이 높이를 44px 아래로 낮추면 안 됩니다. */
const BELOW_LG = new Set(["sm", "md"]);

/** 클래스 문자열이 lg 미만에서 높이 44px 이상을 보장하면 null, 아니면 까닭. */
export function belowLgTarget(classes: string): string | null {
  const tokens = classes.split(/\s+/).filter(Boolean).map((token) => ({ token, ...splitVariants(token) }));
  // 다음 줄이 덮는 아래 겹침(변형 없는 음수 아래 여백) — 높이에서 뺍니다.
  const overlaps = tokens.filter(({ variants, utility }) => variants.length === 0 && bottomOverlapPx(utility) !== null);
  const overlap = overlaps.reduce((sum, { utility }) => sum + (bottomOverlapPx(utility) ?? 0), 0);
  let base = 0;
  const shrinks: string[] = [];
  for (const { token, variants, utility } of tokens) {
    const px = heightPx(utility);
    if (px === null) continue;
    if (variants.length === 0) {
      base = Math.max(base, px);
    } else if (variants.every((variant) => BELOW_LG.has(variant)) && px - overlap < TARGET_PX) {
      shrinks.push(token);
    }
  }
  if (shrinks.length > 0) return `lg 미만에서 ${shrinks.join(" ")}로 낮춤`;
  if (base - overlap >= TARGET_PX) return null;
  if (base >= TARGET_PX) return `다음 줄과 겹치는 ${overlaps.map(({ token }) => token).join(" ")}을 빼면 ${base - overlap}px`;
  return "lg 미만 44px 높이 클래스(min-h-11 등) 없음";
}

const INTERACTIVE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
].join(", ");

/** 글자(\p{L} — 한글·라틴 등) 수 — 번호·괄호·문장부호·빈칸은 세지 않습니다. */
function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** 요소의 보이는 글 — 낭독기 전용 글(sr-only, 예: 링크 안의 '(새 창)')은 뺍니다. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

/**
 * 문장 안의 링크·단추 — 같은 부모 아래 요소 밖 글 마디의 글자가 있고, 그 수가 요소의 보이는 글자 수 이상이다(WCAG 2.5.8 글 안 예외: 문장의
 * 줄 높이에 묶인 링크). 번호·점만 앞에 붙은 목록 줄(`<li>[1] <a>…</a></li>`·`<li>· <a>…</a></li>`)이나 짧은 머리말 뒤의 긴 링크
 * (`<p>출처: <a>합성 출처 사이트</a></p>`)는 문장이 아니라 따로 선 링크로 셉니다. 입력·summary는 글과 함께 있어도 예외가 아닙니다(체크
 * 상자 옆의 '예'는 문장이 아님 — 감싼 label이 누름 자리를 맡아야 함).
 */
function inSentence(element: Element): boolean {
  const role = element.getAttribute("role");
  if (!(element.tagName === "A" || element.tagName === "BUTTON" || role === "link" || role === "button")) return false;
  const parent = element.parentElement;
  if (!parent) return false;
  const around = Array.from(parent.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join("");
  const letters = letterCount(around);
  return letters > 0 && letters >= letterCount(visibleText(element));
}

function hidden(element: Element): boolean {
  return element.closest(".sr-only, [hidden], [aria-hidden=true]") !== null;
}

/** 요소를 가를 글 — aria-label, 입력이면 for로 이어진 label, 아니면 글 내용. */
function nameText(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const id = element.getAttribute("id");
  if (element.tagName === "INPUT" && id) {
    const linked = Array.from(element.ownerDocument.querySelectorAll("label")).find((node) => node.htmlFor === id);
    if (linked) return linked.textContent ?? "";
  }
  return element.textContent ?? "";
}

function describe(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const type = tag === "input" ? `[${element.getAttribute("type") ?? "text"}]` : "";
  const text = nameText(element).replace(/\s+/g, " ").trim().slice(0, 30);
  return `${tag}${type}「${text}」`;
}

/** root 안에서 lg 미만 44px을 보장하지 않는 누름 자리 — "태그「글」 — 까닭". */
export function smallTargets(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll(INTERACTIVE)).flatMap((element) => {
    if (hidden(element) || inSentence(element)) return [];
    const own = belowLgTarget(element.getAttribute("class") ?? "");
    if (own === null) return [];
    const type = element.getAttribute("type");
    const label = element.tagName === "INPUT" && (type === "checkbox" || type === "radio") ? element.closest("label") : null;
    if (label && belowLgTarget(label.getAttribute("class") ?? "") === null) return [];
    return [`${describe(element)} — ${own}`];
  });
}
