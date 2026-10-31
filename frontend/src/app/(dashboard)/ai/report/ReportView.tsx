"use client";

import { type ReactNode, useMemo } from "react";
import { AlertTriangleIcon } from "@/components/ui/icons";
import {
  type Block,
  numericColumns,
  parseInline,
  parseMarkdown,
  sectionKind,
  type Section,
  splitSections,
} from "@/lib/markdown";

/**
 * AI 리포트 본문 — Markdown을 절 단위 카드로 그립니다.
 *
 * 예전에는 응답을 원문 그대로(whitespace-pre-wrap) 보여 줘 "###"·"|---|" 같은 기호가 화면에 찍혔습니다.
 * 해석은 lib/markdown(순수 함수)이 하고, 여기서는 React 요소만 만듭니다 — innerHTML을 쓰지 않으므로
 * 모델이 HTML을 출력해도 글자로 보일 뿐 실행되지 않습니다.
 *
 * - 맨 위: 절 목차(앵커)
 * - "핵심 요약" 절: 강조 패널
 * - "데이터 신뢰도" 절: 주의 패널
 * - 표: 앱의 다른 표와 같은 모양, 숫자 열은 오른쪽 정렬
 */
export function ReportView({ markdown }: { markdown: string }) {
  // 같은 본문을 렌더마다 다시 해석하지 않습니다 — 생성 중에는 경과 초 표시가 1초마다, '추가 지시' 입력은 글자마다
  // 페이지를 다시 그리는데, 그때마다 이전 리포트 전체를 다시 해석했습니다(QA-100).
  const sections = useMemo(() => splitSections(parseMarkdown(markdown)), [markdown]);
  const titled = sections.filter((section) => section.title);

  return (
    <div className="flex flex-col gap-4">
      {titled.length > 2 && (
        <nav aria-label="리포트 목차" className="flex flex-wrap gap-1.5">
          {titled.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted hover:border-accent/60 hover:text-bright"
            >
              {section.title}
            </a>
          ))}
        </nav>
      )}
      {sections.map((section) => (
        <ReportSection key={section.id} section={section} />
      ))}
    </div>
  );
}

function ReportSection({ section }: { section: Section }) {
  const kind = sectionKind(section.name);
  const frame =
    kind === "summary"
      ? "border-accent/50 bg-accent/5"
      : kind === "reliability"
        ? "border-warn/40 bg-warn/5"
        : "border-border bg-canvas/40";

  return (
    <section id={section.id} className={`scroll-mt-4 rounded-lg border p-4 ${frame}`}>
      {section.title && (
        <h3
          className={`mb-3 flex items-center gap-2 font-semibold ${
            kind === "summary" ? "text-base text-bright" : "text-sm text-bright"
          }`}
        >
          {kind === "reliability" && <AlertTriangleIcon size={16} className="text-warn" />}
          {section.title}
        </h3>
      )}
      <div className={`flex flex-col gap-3 ${kind === "summary" ? "text-[15px]" : "text-sm"} leading-relaxed text-body`}>
        {section.blocks.map((block, index) => (
          <BlockView key={index} block={block} emphasize={kind === "summary"} />
        ))}
      </div>
    </section>
  );
}

function BlockView({ block, emphasize }: { block: Block; emphasize: boolean }) {
  switch (block.type) {
    case "heading":
      return <h4 className="mt-1 text-[13px] font-semibold text-bright">{renderInline(block.text)}</h4>;
    case "paragraph":
      return <p>{renderInline(block.text)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`${block.ordered ? "list-decimal" : "list-disc"} flex flex-col ${emphasize ? "gap-2" : "gap-1"} pl-5 marker:text-muted`}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "table":
      return <ReportTable header={block.header} rows={block.rows} />;
    case "quote":
      return <blockquote className="border-l-2 border-border pl-3 text-muted">{renderInline(block.text)}</blockquote>;
    case "hr":
      return <hr className="border-border" />;
  }
}

function ReportTable({ header, rows }: { header: string[]; rows: string[][] }) {
  // 비어 있지 않은 칸이 모두 숫자인 열만 오른쪽 정렬합니다(첫 열은 항목 이름이라 제외).
  const numeric = numericColumns(header, rows);
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="리포트 표 (좌우 스크롤)">
      <table className="w-full min-w-[520px] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            {header.map((cell, index) => (
              <th key={index} className={`px-3 py-2 font-medium ${numeric[index] ? "text-right" : "text-left"}`}>
                {renderInline(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/50 align-top last:border-0">
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={`px-3 py-2 ${numeric[index] ? "whitespace-nowrap text-right tabular-nums" : "text-left"} ${
                    index === 0 ? "font-medium text-bright" : ""
                  }`}
                >
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(text: string): ReactNode {
  return parseInline(text).map((part, index) =>
    part.bold ? (
      <strong key={index} className="font-semibold text-bright">
        {part.text}
      </strong>
    ) : part.code ? (
      <code key={index} className="rounded-sm bg-canvas px-1 py-0.5 text-[12px]">
        {part.text}
      </code>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
