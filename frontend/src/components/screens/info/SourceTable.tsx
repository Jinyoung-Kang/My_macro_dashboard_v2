"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Pager } from "@/components/Pager";
import { type Column, DataTable, InspectorFrame, InspectorTrigger, type InspectorContext, PropertyList, type PropertyItem } from "@/components/patterns";
import { LINK_CLASSES, Tag } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { type CatalogSource, PAGE_SIZE, accessLabel, catalogStatusText, pageSlice, speedLabel } from "@/lib/info";

/** 모르는 실행 시각·받은 글의 사유 — catalog가 그 출처의 기록을 주지 않음(수집기 실행 기록·차단 통과 상태·글 표에 그 출처가 없음). */
const NO_RECORD = "기록 없음";

/** 사유·기록 — 끊김 사건의 사유, 없으면 수집기의 마지막 실행 기록. 자르지 않습니다(2026-11-12 사용자 결정). */
function reasonOf(source: CatalogSource): string | null {
  return source.incident?.reason ?? source.lastDetail ?? null;
}

/** 시각 칸 — 'YYYY-MM-DD HH:MM KST' 글 그대로(KST), 칸 안에서 꺾지 않음. 모르면 null(표가 '—'). */
function timeCell(value: string | null): ReactNode {
  return value ? <span className="whitespace-nowrap text-caption">{value}</span> : null;
}

/**
 * 출처 표(작업대 P7 — 정보 수집 출처 상태 탭과 분류 탭 다섯이 함께 씀). 출처 = 열 수 있는 대상: 이름(줄 단추)을 누르면 검사 칸(넓은 화면 옆 18rem,
 * 좁은 화면·좁은 틀은 위쪽 대화상자)에 상태·끊김·접근·기관·주기·수집 태스크·실행 시각 순서·받은 글·사유 전체·링크가 나옵니다. 검사 칸은 이미 읽은
 * catalog 응답의 값만 씁니다(새 요청 없음 — 출처별 실행 기록 여러 줄·데이터셋 목록은 catalog에 없어 그리지 않음).
 *
 * - 조밀 표(공용 DataTable dense — 넓은 화면 28px 행), 10줄씩 쪽(사용자 요청 2026-11-11), 쪽을 옮기면 고른 줄을 풂(보이지 않는 줄의 검사 칸을 남기지 않음).
 * - 출처 상태 탭(`variant="status"`)은 사유·기록 칸을 표에 둡니다(자르지 않음 — 칸 안에서 줄을 바꿈). 분류 탭(`variant="tab"`)은 대신 받은 글·기관 칸이고
 *   사유는 검사 칸에 있습니다.
 * - 짧은 칸(상태·접근·실행 시각)은 꺾지 않고, 주기는 낱말 사이에서만 꺾습니다(예전 표의 짧은 칸이 한 글자 폭으로 눌리던 것 — D1 info-status-table-narrow-columns).
 * - 데이터 영역이라 강조 파랑은 링크(누를 수 있는 것)에만 씁니다 — 줄 단추는 중립 잉크, 상태는 아이콘 + 글.
 */
export function SourceTable({
  sources,
  variant,
  caption,
  pagerLabel,
  emptyText,
}: {
  /** 보일 출처(이미 거르고 늘어놓은 것). */
  sources: readonly CatalogSource[];
  variant: "status" | "tab";
  /** 표 이름 — 스크롤 상자 이름 '{caption} (좌우 스크롤)'. */
  caption: string;
  /** 쪽 넘기기 이름 '{pagerLabel} 쪽'. */
  pagerLabel: string;
  emptyText: string;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const slice = pageSlice(sources, page, PAGE_SIZE);
  const byTask = new Map(sources.map((source) => [source.task, source]));
  const turn = (next: number) => {
    setPage(next);
    setSelected(null);
  };
  return (
    <>
      <InspectorFrame
        label="출처 상세"
        layout="lg"
        titleOf={(key) => byTask.get(key)?.label ?? null}
        renderDetail={(key) => {
          const source = byTask.get(key);
          return source ? <SourceDetail source={source} /> : null;
        }}
        selectedKey={selected}
        onSelectedKeyChange={setSelected}
        inspectorHint="출처 이름을 고르면 이 칸에 상태·실행 시각·사유·링크가 나옵니다."
      >
        {(inspector) => (
          <DataTable<CatalogSource>
            dense
            caption={caption}
            rows={slice.rows}
            rowKey={(row) => row.task}
            columns={columns(inspector, variant)}
            selectedKey={inspector.shownKey}
            emptyText={emptyText}
            count={() => `${sources.length.toLocaleString("ko-KR")}곳`}
            scrollHint="overflow"
          />
        )}
      </InspectorFrame>
      <Pager page={slice.page} pages={slice.pages} onChange={turn} label={pagerLabel} />
    </>
  );
}

function columns(inspector: InspectorContext, variant: "status" | "tab"): Column<CatalogSource>[] {
  const head: Column<CatalogSource>[] = [
    {
      key: "label",
      header: "출처",
      rowHeader: true,
      className: "min-w-[8rem]",
      cell: (row) => (
        <InspectorTrigger inspector={inspector} itemKey={row.task}>
          {row.label}
        </InspectorTrigger>
      ),
    },
    {
      key: "status",
      header: "상태",
      className: "whitespace-nowrap",
      cell: (row) => <StatusText tone={row.tone}>{catalogStatusText(row)}</StatusText>,
    },
    { key: "access", header: "접근", className: "whitespace-nowrap", cell: (row) => <Tag>{accessLabel(row.access)}</Tag> },
    { key: "speed", header: "주기", className: "min-w-[6rem] break-keep", cell: (row) => (row.speed ? speedLabel(row.speed) : null) },
    { key: "last", header: "마지막 실행", className: "whitespace-nowrap", cell: (row) => timeCell(row.lastRunAt) },
    { key: "next", header: "다음 실행", className: "whitespace-nowrap", cell: (row) => timeCell(row.nextDueAt) },
  ];
  if (variant === "status") {
    return [
      ...head,
      {
        key: "detail",
        header: "사유·기록",
        className: "min-w-[20rem]",
        // 자르지 않습니다(2026-11-12 사용자 지적 — 두 줄에서 '…'으로 잘려 사유·실행 기록의 뒤가 보이지 않았음). 긴 글은 칸 안에서 줄을 바꿉니다.
        cell: (row) => {
          const reason = reasonOf(row);
          return reason ? <span className="block break-keep wrap-anywhere text-caption leading-5 text-text-2">{reason}</span> : null;
        },
      },
    ];
  }
  return [
    ...head,
    { key: "items", header: "받은 글", align: "right", cell: (row) => (row.items === null ? null : `${row.items.toLocaleString("ko-KR")}편`) },
    { key: "origin", header: "기관", className: "min-w-[8rem] break-keep", cell: (row) => <span className="text-caption text-text-2">{row.origin}</span> },
  ];
}

/** 검사 칸 — 출처 하나의 속성(catalog 값만). 실행 시각은 마지막 성공 → 끊김 시작 → 마지막 실행 → 다음 실행 차례, 모르면 '—'와 '기록 없음'. */
function SourceDetail({ source }: { source: CatalogSource }) {
  const items: PropertyItem[] = [
    { label: "상태", value: <StatusText tone={source.tone}>{catalogStatusText(source)}</StatusText> },
    ...(source.incident ? [{ label: "끊김", value: source.incident.kindLabel }] : []),
    { label: "접근", value: accessLabel(source.access) },
    { label: "기관", value: source.origin },
    { label: "주기", value: source.speed ? speedLabel(source.speed) : null, emptyReason: NO_RECORD },
    { label: "수집 태스크", value: source.task, mono: true },
    { label: "마지막 성공", value: source.lastOkAt, emptyReason: NO_RECORD },
    ...(source.incident ? [{ label: "끊김 시작", value: source.incident.since, emptyReason: NO_RECORD }] : []),
    { label: "마지막 실행", value: source.lastRunAt, emptyReason: NO_RECORD },
    { label: "다음 실행", value: source.nextDueAt, emptyReason: NO_RECORD },
    { label: "받은 글", value: source.items === null ? null : `${source.items.toLocaleString("ko-KR")}편`, emptyReason: NO_RECORD },
    { label: "사유·기록", value: reasonOf(source), emptyReason: NO_RECORD, block: true },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <PropertyList items={items} />
      {source.siteUrl || source.screen ? (
        <p className="flex flex-wrap gap-x-4 text-sm">
          {source.siteUrl ? (
            <a href={source.siteUrl} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
              출처 사이트
            </a>
          ) : null}
          {source.screen ? (
            <Link href={source.screen} className={LINK_CLASSES}>
              자료 보기
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
