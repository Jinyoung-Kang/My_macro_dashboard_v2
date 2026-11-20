import type { JSX, ReactNode } from "react";

import { SectionAnchor } from "@/components/patterns";
import type { FrameworkOutlineSection } from "@/lib/paperFrameworkOutline";

/** 머리 단계 → 제목 요소와 모양 — 패널 제목(h2) 아래라 `#`은 h3, `##`은 h4, `###`은 h5. */
const HEADING: Record<1 | 2 | 3, { tag: "h3" | "h4" | "h5"; className: string }> = {
  1: { tag: "h3", className: "text-heading-sm text-text" },
  2: { tag: "h4", className: "text-body font-semibold text-text" },
  3: { tag: "h5", className: "text-body font-semibold text-text-2" },
};

/** 절 글 — 앞뒤 빈 줄만 뺍니다(머리 사이 간격은 여백이 맡음). 줄 안의 글·공백·줄바꿈은 서버 글 그대로(whitespace-pre-wrap). */
function sectionText(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

function Section({ section }: { section: FrameworkOutlineSection }): JSX.Element {
  const text = sectionText(section.lines);
  const heading = section.level === 0 || section.title === null ? null : HEADING[section.level];
  const Tag = heading?.tag;
  return (
    <div className="min-w-0">
      {Tag && heading ? <Tag className={`break-keep wrap-anywhere ${heading.className}`}>{section.title}</Tag> : null}
      {text !== "" ? (
        <p className={`${heading ? "mt-1 " : ""}whitespace-pre-wrap break-keep wrap-anywhere text-running text-text-2`}>{text}</p>
      ) : null}
    </div>
  );
}

/**
 * 지금 판 렌더링 글(시스템 프롬프트)을 펼친 긴 글(작업대 P6 — 명세 §7-1 '프레임: 가운데 본문(running 글자)', U10). 글은 서버가 준 렌더링 그대로이고
 * (lib/paperFrameworkOutline frameworkOutline — 머리 줄마다 절, 글을 바꾸지 않음), 머리 줄의 `#` 표지만 제목 요소로 바꿔 보입니다(`#` h3 · `##` h4 · `###` h5).
 * 목차 하위 칸 단계(`tocLevel`)의 절은 그 아래 더 깊은 절까지 하나의 절 닻(SectionAnchor — 2xl 목차, id = 절 id)으로 묶습니다 — 목차의 지금 절이 읽는
 * 자리를 따라가게. 그보다 얕은 절(제목 `#`)과 머리 앞 글은 닻 밖입니다(부모 '지금 판' 닻 안). 한 줄 길이는 72ch(running 15/24).
 */
export function FrameworkOutline({
  sections,
  tocLevel,
  label,
}: {
  sections: readonly FrameworkOutlineSection[];
  tocLevel: 1 | 2 | 3 | null;
  /** 영역 이름 — 예 'v3 렌더링 본문'. */
  label: string;
}): JSX.Element {
  const blocks: { anchor: FrameworkOutlineSection | null; sections: FrameworkOutlineSection[] }[] = [];
  for (const section of sections) {
    const opensBlock = tocLevel !== null && section.level !== 0 && section.level <= tocLevel;
    const last = blocks[blocks.length - 1];
    if (opensBlock || last === undefined) blocks.push({ anchor: opensBlock && section.level === tocLevel ? section : null, sections: [section] });
    else last.sections.push(section);
  }
  return (
    <section aria-label={label} className="flex min-w-0 max-w-[72ch] flex-col gap-4">
      {blocks.map((block, index): ReactNode => {
        const body = block.sections.map((section) => <Section key={section.id} section={section} />);
        return block.anchor ? (
          <SectionAnchor key={block.anchor.id} id={block.anchor.id} columnFrom="2xl">
            <div className="flex min-w-0 flex-col gap-3">{body}</div>
          </SectionAnchor>
        ) : (
          <div key={`block-${index}`} className="flex min-w-0 flex-col gap-3">
            {body}
          </div>
        );
      })}
    </section>
  );
}
