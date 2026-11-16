/**
 * 매크로 화면(/macro)의 절 주소 — 정본 하나(P5a). 매크로 화면의 절 닻(SectionAnchor id)과 다른 화면이 매크로 절로 잇는 링크(국면 화면의 '연결' —
 * 장단기 금리차·NFCI는 심화 지표 절, 하이일드 스프레드는 신용·변동성 절)가 같은 id를 씁니다. React를 모르는 순수 모듈(ADR 0004).
 *
 * id는 소문자·하이픈만(주소 조각 그대로 — 인코딩 없음)이고 'macro-'로 시작해 다른 화면의 id와 겹치지 않습니다. 절을 더하거나 이름을 바꾸면 여기와 매크로
 * 화면의 목차를 함께 고칩니다(옛 주소의 조각은 브라우저가 무시할 뿐 화면은 열림 — 맨 위).
 */
import { TABS } from "./nav";

export const MACRO_SECTIONS = {
  indicators: "macro-indicators",
  fx: "macro-fx",
  spreads: "macro-spreads",
  risk: "macro-risk",
  advanced: "macro-advanced",
  single: "macro-single",
  scraped: "macro-scraped",
  calendar: "macro-calendar",
} as const;

export type MacroSection = keyof typeof MACRO_SECTIONS;

/** 매크로 화면 경로 — 메뉴 표(lib/nav TABS)의 시장 탭 '매크로 지표' 항목. 메뉴 표가 경로의 정본이라 여기서 다시 적지 않습니다. */
function macroPath(): string {
  const item = TABS.find((tab) => tab.key === "markets")?.items.find((entry) => entry.label === "매크로 지표");
  return item?.href ?? "/macro";
}

/** 매크로 화면의 한 절로 가는 주소 — 예 '/macro#macro-risk'. */
export function macroSectionHref(section: MacroSection): string {
  return `${macroPath()}#${MACRO_SECTIONS[section]}`;
}
