import { EMPTY, formatKst, formatNumber } from "./format";
import { frameworkVersionLabel } from "./paper";
import type { PaperFrameworkVersionSummary } from "./types";

/**
 * 모의매매 프레임 탭의 순수 규칙(작업대 P6 — 명세 §7-1 '프레임': 왼쪽 목차·가운데 본문(running 글자)·판 이력 타임라인). React를 모릅니다(ADR 0004).
 *
 * - `frameworkOutline(rendered)`: 서버가 준 렌더링 글(시스템 프롬프트 — 마크다운)을 머리 줄(`#`·`##`·`###`)마다 절로 나눕니다. 글은 서버 글 그대로이고
 *   (줄을 바꾸거나 고치지 않음 — 머리 줄은 `heading`에 원문 그대로, 그 아래 줄은 `lines`), 머리 앞의 글은 머리 없는 절 하나(`level` 0)입니다. 코드 울타리
 *   (```) 안의 `#` 줄은 머리가 아닙니다. 네 단계 이상(`####`)은 머리로 보지 않고 글 줄로 둡니다.
 * - `frameworkOutlineTocLevel(sections)`: 목차의 하위 칸으로 쓸 머리 단계 — 두 번 이상 나오는 가장 높은(# 수가 적은) 단계, 없으면 있는 가장 높은 단계.
 *   제목 한 줄(`#`)과 그 아래 여러 절(`##`)인 판이면 `##`이 하위 칸입니다(QA v1 — `#` 1 · `##` 8 · `###` 8).
 * - `frameworkVersionEntries(versions, current)`: 판 목록(서버 순서 — 최근 순)을 판 이력 타임라인 줄로 — 종류(처음·제안 승인·수동 편집), 만든 시각,
 *   토큰 어림(계약 밖 `tokensEst` — 보내지 않으면 '—'), 지금 판 표시. 출처 글은 판 목록 표의 글(`frameworkVersionRows`)과 같습니다.
 */

/** 렌더링 글의 절 하나. */
export type FrameworkOutlineSection = {
  /** 절 닻 id — `{prefix}-{차례}`(같은 판이면 늘 같음). */
  id: string;
  /** 머리 단계 — 1(`#`)·2(`##`)·3(`###`), 머리 없는 앞글은 0. */
  level: 0 | 1 | 2 | 3;
  /** 머리 글(# 표지와 앞뒤 공백을 뺌). 앞글이면 null. */
  title: string | null;
  /** 머리 줄 원문(앞글이면 null) — 글을 되살릴 때 씁니다(화면은 `title`을 보임). */
  heading: string | null;
  /** 머리 아래 줄들(다음 머리 전까지) — 서버 글 그대로. */
  lines: string[];
};

const HEADING = /^(#{1,3})[ \t]+(\S.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * 렌더링 글을 절로 나눕니다(위 설명). 글이 없으면 빈 목록. 머리가 하나도 없으면 앞글 절 하나(글 전체).
 * 절을 차례대로 `heading`(있으면)·`lines`로 이으면 원래 글과 같습니다(줄바꿈 기준 — 시험이 지킴).
 */
export function frameworkOutline(rendered: string | null | undefined, idPrefix = "paper-frame-section"): FrameworkOutlineSection[] {
  if (typeof rendered !== "string" || rendered.length === 0) return [];
  const sections: FrameworkOutlineSection[] = [];
  let lead: string[] = [];
  let open: FrameworkOutlineSection | null = null;
  let fenced = false;
  for (const line of rendered.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match) {
      // 머리 앞에 글이 있었으면 그 글이 첫 절(앞글)입니다.
      if (sections.length === 0 && lead.length > 0) {
        sections.push({ id: `${idPrefix}-0`, level: 0, title: null, heading: null, lines: lead });
        lead = [];
      }
      open = { id: `${idPrefix}-${sections.length}`, level: match[1].length as 1 | 2 | 3, title: match[2].trim(), heading: line, lines: [] };
      sections.push(open);
      continue;
    }
    if (open) open.lines.push(line);
    else lead.push(line);
  }
  if (sections.length === 0) sections.push({ id: `${idPrefix}-0`, level: 0, title: null, heading: null, lines: lead });
  return sections;
}

/** 절들을 다시 이은 글 — 원래 렌더링 글과 같아야 합니다(시험용·확인용). */
export function frameworkOutlineText(sections: readonly FrameworkOutlineSection[]): string {
  return sections.flatMap((section) => (section.heading === null ? section.lines : [section.heading, ...section.lines])).join("\n");
}

/** 목차 하위 칸으로 쓸 머리 단계(위 설명). 머리가 없으면 null. */
export function frameworkOutlineTocLevel(sections: readonly FrameworkOutlineSection[]): 1 | 2 | 3 | null {
  const counts = new Map<number, number>();
  for (const section of sections) {
    if (section.level > 0) counts.set(section.level, (counts.get(section.level) ?? 0) + 1);
  }
  const levels = [1, 2, 3] as const;
  return levels.find((level) => (counts.get(level) ?? 0) >= 2) ?? levels.find((level) => counts.has(level)) ?? null;
}

/** 판 이력의 종류 — 처음(서버가 시드한 v0)·제안 승인·수동 편집. */
export type FrameworkVersionKind = "처음" | "제안 승인" | "수동 편집";

/** 판 이력 줄 하나. */
export type FrameworkVersionEntry = {
  key: string;
  version: number;
  /** "v1"·"임시 v0" — 상태를 모르면 "v1". */
  label: string;
  title: string;
  changelog: string;
  kind: FrameworkVersionKind;
  /** 출처 글 — "제안 #3 승인" · "처음 시드(임시)" · "수동 편집"(판 목록 표와 같음). */
  source: string;
  /** 만든 시각(KST 표기). 모르면 "—". */
  createdAt: string;
  /** 기계가 읽는 날짜(YYYY-MM-DD) — 모르면 null. */
  createdDate: string | null;
  /** "추정 3,552토큰" — 모르면 null. */
  tokens: string | null;
  current: boolean;
};

const DATE = /^(\d{4}-\d{2}-\d{2})/;

/** 판 목록(서버 순서 그대로)을 판 이력 줄로. 번호가 없는 줄은 뺍니다. */
export function frameworkVersionEntries(
  versions: readonly PaperFrameworkVersionSummary[] | null | undefined,
  currentVersion: number | null | undefined,
): FrameworkVersionEntry[] {
  return (versions ?? []).flatMap((entry, index) => {
    if (typeof entry?.version !== "number" || !Number.isFinite(entry.version)) return [];
    const version = entry.version;
    const proposal = typeof entry.sourceProposalId === "number" && Number.isFinite(entry.sourceProposalId) ? entry.sourceProposalId : null;
    const status = typeof entry.status === "string" && entry.status ? entry.status : null;
    const kind: FrameworkVersionKind = proposal !== null ? "제안 승인" : version === 0 ? "처음" : "수동 편집";
    const created = typeof entry.createdAtKst === "string" ? entry.createdAtKst : null;
    const tokens = typeof entry.tokensEst === "number" && Number.isFinite(entry.tokensEst) ? `추정 ${formatNumber(entry.tokensEst, 0)}토큰` : null;
    return [{
      key: `${index}-${version}`,
      version,
      label: status ? frameworkVersionLabel(version, status) : `v${version}`,
      title: typeof entry.title === "string" && entry.title ? entry.title : EMPTY,
      changelog: typeof entry.changelog === "string" && entry.changelog ? entry.changelog : EMPTY,
      kind,
      source: proposal !== null ? `제안 #${proposal} 승인` : version === 0 ? "처음 시드(임시)" : "수동 편집",
      createdAt: formatKst(created),
      createdDate: created ? DATE.exec(created)?.[1] ?? null : null,
      tokens,
      current: typeof currentVersion === "number" && version === currentVersion,
    }];
  });
}
