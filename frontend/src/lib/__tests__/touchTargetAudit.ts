/**
 * 좁은 화면(lg 미만) 누르는 자리 44px(원칙 A8 — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md, ADR 0041 결정 11 선례)을 클래스로 따지는
 * 시험 도우미. jsdom은 배치를 재지 않으므로 높이는 Tailwind 클래스로 읽습니다 — 시험 파일이 아니라 시험이 가져다 씁니다(homeFixtures와 같은 자리).
 *
 * - `belowLgTarget(classes)`: 변형 없는(모든 폭에 걸리는) 높이 클래스 가운데 44px 이상이 있고(`min-h-11`·`h-11`·`size-11`·`min-h-12`·
 *   `min-h-16`·`min-h-[44px]` 등), lg 미만에도 걸리는 sm:·md: 변형이 그보다 낮추지 않으면 통과(null). lg:·xl:·2xl: 변형은 더 작아도
 *   됩니다(넓은 화면은 30·32px 조밀 조작). 아니면 까닭 글을 돌려줍니다.
 * - `smallTargets(root)`: 그린 DOM에서 누를 수 있는 요소(링크·단추·입력·summary·역할이 단추·탭인 요소)마다 그 요소(체크 상자·라디오는 감싼
 *   label도)가 `belowLgTarget`을 통과하는지 봅니다. 문장 안의 링크·단추(같은 부모에 글이 함께 있는 요소 — WCAG 2.5.8의 글 안 예외)와
 *   화면에 보이지 않는 요소(sr-only·hidden)는 셈에서 뺍니다. 걸린 요소를 "태그「글」 — 까닭"으로 돌려줍니다.
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

const TARGET_PX = 44;
/** lg 미만에도 걸리는 폭 변형 — 이것들이 높이를 44px 아래로 낮추면 안 됩니다. */
const BELOW_LG = new Set(["sm", "md"]);

/** 클래스 문자열이 lg 미만에서 높이 44px 이상을 보장하면 null, 아니면 까닭. */
export function belowLgTarget(classes: string): string | null {
  let base = false;
  const shrinks: string[] = [];
  for (const token of classes.split(/\s+/).filter(Boolean)) {
    const { variants, utility } = splitVariants(token);
    const px = heightPx(utility);
    if (px === null) continue;
    if (variants.length === 0) {
      if (px >= TARGET_PX) base = true;
    } else if (variants.every((variant) => BELOW_LG.has(variant)) && px < TARGET_PX) {
      shrinks.push(token);
    }
  }
  if (shrinks.length > 0) return `lg 미만에서 ${shrinks.join(" ")}로 낮춤`;
  return base ? null : "lg 미만 44px 높이 클래스(min-h-11 등) 없음";
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

/**
 * 문장 안의 링크·단추 — 같은 부모 아래 비지 않은 글 마디가 함께 있다(WCAG 2.5.8 글 안 예외: 줄 높이에 묶인 링크). 입력·summary는 글과 함께
 * 있어도 예외가 아닙니다(체크 상자 옆의 '예'는 문장이 아님 — 감싼 label이 누름 자리를 맡아야 함).
 */
function inSentence(element: Element): boolean {
  const role = element.getAttribute("role");
  if (!(element.tagName === "A" || element.tagName === "BUTTON" || role === "link" || role === "button")) return false;
  const parent = element.parentElement;
  if (!parent) return false;
  return Array.from(parent.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim() !== "");
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
