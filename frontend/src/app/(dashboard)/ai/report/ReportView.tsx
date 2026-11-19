"use client";

import { type ReactNode, useMemo } from "react";
import { DataTable, SectionIndex, type Column, type SectionIndexItem } from "@/components/patterns";
import { AlertTriangleIcon, CheckCircleIcon, MinusIcon, XCircleIcon } from "@/components/ui/icons";
import {
  type Block,
  numericColumns,
  parseInline,
  parseMarkdown,
  sectionKind,
  type Section,
  splitSections,
  splitVerdicts,
  type Verdict,
  VERDICT_LABEL,
} from "@/lib/markdown";

/**
 * AI 리포트 본문 — Markdown을 절 단위 카드로 그립니다.
 *
 * 예전에는 응답을 원문 그대로(whitespace-pre-wrap) 보여 줘 "###"·"|---|" 같은 기호가 화면에 찍혔습니다.
 * 해석은 lib/markdown(순수 함수)이 하고, 여기서는 React 요소만 만듭니다 — innerHTML을 쓰지 않으므로
 * 모델이 HTML을 출력해도 글자로 보일 뿐 실행되지 않습니다.
 *
 * - 목차(작업대 P7 — 긴 글 문법): 제목 있는 절이 셋 이상이면 공용 긴 화면 목차(SectionIndex '리포트 목차' — xl 이상 왼쪽 13rem 세로 목록, 그 아래 본문 위에 붙는
 *   가로 줄, 지금 절 표시). 칸을 누르면 기본 해시 이동 대신 기록 하나(history.pushState)와 절 이동·절 제목(h3) 포커스(lib/hashLink — QA-680·688, 예전 버튼 줄과
 *   같은 기제), 뒤로·앞으로 가기(hashchange)도 그 절로 맞춥니다(D3b 넘김 '해시 기록 앞으로·뒤로 본문 스크롤' — SectionIndex의 hashchange 처리). 리포트는
 *   저장되지 않아 새로 고친 주소의 절 해시 맞춤(alignHashOnLoad)은 켜지 않습니다. 절은 목차의 절 닻과 같은 위쪽 여백(scroll-margin)을 둔 section입니다.
 * - 글: 문단·목록·인용은 긴 글 단계(15/24)·한 줄 72자 폭, 절 제목은 heading-sm(16/24). 칸 글은 낱말 사이 줄바꿈.
 * - "핵심 요약" 절: 강조 패널
 * - "데이터 신뢰도" 절: 주의 패널
 * - 표: 공용 표(DataTable — 앱의 다른 표와 같은 모양, 최소 640px·넘김 안내 scrollHint="overflow"), 첫 열은 행 머리, 숫자 열은 오른쪽 정렬, 빈 칸은 '—'.
 *   표 이름(caption·넘김 영역 이름)은 '{절 제목} 표'(한 절에 둘 이상이면 '표 n') — 예전 손으로 만든 표는 넘김 안내 없이 390에서 칸 대부분이 상자 밖에 숨었고
 *   모든 표가 같은 영역 이름 '리포트 표'였습니다(QA-869).
 */
export function ReportView({ markdown }: { markdown: string }) {
  // 같은 본문을 렌더마다 다시 해석하지 않습니다 — 생성 중에는 경과 초 표시가 1초마다, '추가 지시' 입력은 글자마다
  // 페이지를 다시 그리는데, 그때마다 이전 리포트 전체를 다시 해석했습니다(QA-100).
  const sections = useMemo(() => splitSections(parseMarkdown(markdown)), [markdown]);
  const titled = sections.filter((section) => section.title);
  // 제목 있는 절이 셋 이상일 때만 목차(예전 버튼 줄과 같은 조건).
  const index: SectionIndexItem[] = titled.length > 2 ? titled.map((section) => ({ id: section.id, label: section.title ?? "" })) : [];

  return (
    <SectionIndex label="리포트 목차" items={index} columnFrom="xl">
      {sections.map((section) => (
        <ReportSection key={section.id} section={section} />
      ))}
    </SectionIndex>
  );
}

function ReportSection({ section }: { section: Section }) {
  const kind = sectionKind(section.name);
  // 표 이름 — '{절 제목} 표', 한 절에 표가 둘 이상이면 '표 1'·'표 2'(QA-869). 블록 차례 → 이름.
  const tableIndexes = section.blocks.flatMap((block, index) => (block.type === "table" ? [index] : []));
  const tableNames = new Map(
    tableIndexes.map((blockIndex, order) => [
      blockIndex,
      `${section.title ?? "리포트"} 표${tableIndexes.length > 1 ? ` ${order + 1}` : ""}`,
    ]),
  );
  const frame =
    // 결론은 진한 테두리(중립 — 강조 파랑은 누를 수 있는 것에만, 명세 A1), 신뢰도 주의는 경고 틴트(주의 안내 상자 꼴 — 아이콘 + 제목), 나머지는 카드 바탕 그대로.
    kind === "summary"
      ? "border-border-strong bg-surface"
      : kind === "reliability"
        ? "border-warn/30 bg-warn-tint"
        : "border-border bg-surface";

  // 위쪽 여백(scroll-margin)은 목차의 절 닻(SectionAnchor — xl)과 같은 값: 가로 줄이 보이는 폭은 줄 높이(스크롤 상자 위쪽 여백) 위에 12px, 세로 목록 폭은 16px.
  return (
    <section id={section.id} className={`min-w-0 scroll-mt-3 rounded-control border p-3 outline-none lg:p-4 xl:scroll-mt-4 ${frame}`}>
      {section.title && (
        <h3 className="mb-3 flex items-center gap-2 break-keep text-heading-sm text-text">
          {kind === "reliability" && <AlertTriangleIcon size={16} className="text-warn" />}
          {section.title}
        </h3>
      )}
      <div className="flex min-w-0 flex-col gap-3 text-running text-text-2">
        {section.blocks.map((block, index) => (
          <BlockView key={index} block={block} emphasize={kind === "summary"} tableName={tableNames.get(index)} />
        ))}
      </div>
    </section>
  );
}

/** 긴 글 한 덩어리 — 한 줄 72자 폭, 한국어는 낱말 사이에서만 줄바꿈(공백 없는 긴 토큰만 꺾음). 글자 단계(15/24)는 절 본문이 줍니다. */
const PROSE = "max-w-[72ch] break-keep wrap-break-word";

function BlockView({ block, emphasize, tableName }: { block: Block; emphasize: boolean; tableName?: string }) {
  switch (block.type) {
    case "heading":
      return <h4 className="mt-1 max-w-[72ch] break-keep text-body font-semibold text-text">{renderInline(block.text)}</h4>;
    case "paragraph":
      return <p className={PROSE}>{renderInline(block.text)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag className={`${PROSE} ${block.ordered ? "list-decimal" : "list-disc"} flex flex-col ${emphasize ? "gap-2" : "gap-1"} pl-5 marker:text-text-3`}>
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "table":
      return <ReportTable header={block.header} rows={block.rows} name={tableName ?? "리포트 표"} />;
    case "quote":
      return <blockquote className={`${PROSE} border-l-2 border-border pl-3 text-text-3`}>{renderInline(block.text)}</blockquote>;
    case "hr":
      return <hr className="border-border" />;
  }
}

/** 표 줄 — 차례(rowKey)와 칸 글. */
type ReportRow = { key: string; cells: string[] };

function ReportTable({ header, rows, name }: { header: string[]; rows: string[][]; name: string }) {
  // 비어 있지 않은 칸이 모두 숫자인 열만 오른쪽 정렬합니다(첫 열은 항목 이름이라 제외).
  const numeric = numericColumns(header, rows);
  const columns: Column<ReportRow>[] = header.map((cell, index) => ({
    key: String(index),
    header: renderInline(cell),
    align: numeric[index] ? "right" : "left",
    // 첫 열은 그 줄의 항목 이름(행 머리) — 낭독기가 칸을 옮길 때 항목 이름도 읽습니다. 글 칸은 낱말 사이에서만 줄을 바꿉니다.
    rowHeader: index === 0,
    className: numeric[index] ? undefined : "break-keep",
    // 빈 칸은 null — 공용 표가 '—'(값 없음)로 그립니다(0·빈칸으로 채우지 않음).
    cell: (row) => (row.cells[index]?.trim() ? renderInline(row.cells[index]) : null),
  }));
  return (
    <div className="min-w-0">
      <DataTable<ReportRow>
        caption={name}
        scrollHint="overflow"
        rows={rows.map((cells, index) => ({ key: String(index), cells }))}
        rowKey={(row) => row.key}
        columns={columns}
      />
    </div>
  );
}

function renderInline(text: string): ReactNode {
  return parseInline(text).map((part, index) =>
    part.bold ? (
      <strong key={index} className="font-semibold text-text">
        {withVerdicts(part.text)}
      </strong>
    ) : part.code ? (
      <code key={index} className="rounded-sm bg-bg px-1 py-0.5 text-[12px]">
        {part.text}
      </code>
    ) : (
      <span key={index}>{withVerdicts(part.text)}</span>
    ),
  );
}

/** 판정 기호를 글 배지로(lib/markdown.splitVerdicts) — 기호가 없으면 글 그대로. */
function withVerdicts(text: string): ReactNode {
  const parts = splitVerdicts(text);
  if (parts.length === 1 && "text" in parts[0]) return parts[0].text;
  return parts.map((part, index) =>
    "verdict" in part ? <VerdictBadge key={index} verdict={part.verdict} /> : <span key={index}>{part.text}</span>,
  );
}

const VERDICT_ICON: Record<Verdict, ReactNode> = {
  favorable: <CheckCircleIcon size={12} className="text-ok" />,
  unfavorable: <XCircleIcon size={12} className="text-danger" />,
  neutral: <MinusIcon size={12} className="text-text-3" />,
};

/**
 * 판정 배지 — 중립 바탕에 글('우호'·'비우호'·'중립·보류')과 장식 아이콘. 뜻은 글이 나르고 아이콘 색은 보조입니다.
 * ▲▼와 상승·하락 색은 값 변화에만 씁니다(판정을 방향으로 읽지 않게).
 */
function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className="mr-1 inline-flex items-center gap-1 rounded-control bg-surface-2 px-1.5 py-px align-[1px] text-xs font-medium leading-4 text-text-2">
      {VERDICT_ICON[verdict]}
      {VERDICT_LABEL[verdict]}
    </span>
  );
}
