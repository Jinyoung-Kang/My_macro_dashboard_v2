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

/**
 * 시각 칸 — 'YYYY-MM-DD HH:MM KST' 글 그대로(KST). 칸이 좁으면 날짜와 시각 사이에서만 줄을 바꿉니다(날짜 안의 '-'·시각 안의 ':'는 숫자 사이라
 * 줄바꿈 자리가 아니고, 'KST' 앞은 줄바꿈 없는 빈칸 — 'KST'만 홀로 다음 줄로 가지 않음). 모르면 null(표가 '—').
 */
function timeCell(value: string | null): ReactNode {
  return value ? <span className="text-caption">{value.replace(/ KST$/, "\u00a0KST")}</span> : null;
}

/**
 * 출처 표(작업대 P7 — 정보 수집 출처 상태 탭과 분류 탭 다섯이 함께 씀). 출처 = 열 수 있는 대상: 이름(줄 단추)을 누르면 검사 대화상자(공용 InspectorFrame
 * `layout="dialog"` — 위쪽 고정, 닫으면 그 이름 단추로 포커스)에 상태·끊김·접근·기관·주기·수집 태스크·실행 시각 차례·받은 글·사유 전체·링크가 나옵니다.
 * 검사 칸은 이미 읽은 catalog 응답의 값만 씁니다(새 요청 없음 — 출처별 실행 기록 여러 줄·데이터셋 목록은 catalog에 없어 그리지 않음).
 *
 * - 옆 검사 칸을 두지 않는 까닭: 이 표는 사유·기록(자르지 않는 긴 글 — 2026-11-12 사용자 결정)을 칸으로 두어, 1440 화면에서 옆 칸(18rem)을 두면 표 상자가
 *   822px로 줄어 표(1,043px)의 사유 칸이 가로 스크롤 뒤로 밀렸습니다(머리 없는 크롬으로 잼). 틀의 대화상자 배치(칸이 많아 옆 칸이 표를 누르는 표)를 씁니다.
 * - 조밀 표(공용 DataTable dense — 넓은 화면 28px 행), 10줄씩 쪽(사용자 요청 2026-11-11). 칸: 출처·상태(아이콘 + 글, '(연속 n회)')·접근(태그)·주기·
 *   마지막 실행·다음 실행·(분류 탭에 받은 글이 있는 출처가 있으면) 받은 글·사유·기록. 사유는 자르지 않고 칸 안에서 낱말 사이로 줄을 바꿉니다.
 * - 짧은 칸(상태·접근)은 꺾지 않고, 주기는 낱말 사이에서만, 실행 시각은 날짜와 시각 사이에서만 꺾습니다(예전 표의 짧은 칸이 한 글자 폭으로 눌리던 것 —
 *   D1 info-status-table-narrow-columns). 표가 상자보다 넓으면 넘김 안내(scrollHint="overflow").
 * - 데이터 영역이라 강조 파랑은 링크(누를 수 있는 것)에만 씁니다 — 줄 단추는 중립 잉크, 상태는 아이콘 + 글.
 */
export function SourceTable({
  sources,
  variant,
  caption,
  pagerLabel,
  emptyText,
  count = true,
}: {
  /** 보일 출처(이미 거르고 늘어놓은 것). */
  sources: readonly CatalogSource[];
  /** status — 출처 상태 탭(모든 분류), tab — 분류 탭(받은 글 칸을 둘 수 있음). */
  variant: "status" | "tab";
  /** 표 이름 — 스크롤 상자 이름 '{caption} (좌우 스크롤)'. */
  caption: string;
  /** 쪽 넘기기 이름 '{pagerLabel} 쪽'. */
  pagerLabel: string;
  emptyText: string;
  /** 표 위 개수 줄 '{n}곳' — 패널 머리가 이미 개수를 적으면 false. */
  count?: boolean;
}) {
  const [page, setPage] = useState(1);
  const slice = pageSlice(sources, page, PAGE_SIZE);
  const byTask = new Map(sources.map((source) => [source.task, source]));
  // 받은 글 칸은 분류 탭에 글 수를 아는 출처가 하나라도 있을 때만(뉴스·국내 — 데이터 출처뿐인 탭은 모두 '—'라 칸을 두지 않음).
  const withItems = variant === "tab" && sources.some((source) => source.items !== null);
  return (
    <>
      <InspectorFrame
        label="출처 상세"
        layout="dialog"
        titleOf={(key) => byTask.get(key)?.label ?? null}
        renderDetail={(key) => {
          const source = byTask.get(key);
          return source ? <SourceDetail source={source} /> : null;
        }}
      >
        {(inspector) => (
          <DataTable<CatalogSource>
            dense
            caption={caption}
            rows={slice.rows}
            rowKey={(row) => row.task}
            columns={columns(inspector, withItems)}
            emptyText={emptyText}
            count={count ? () => `${sources.length.toLocaleString("ko-KR")}곳` : undefined}
            scrollHint="overflow"
          />
        )}
      </InspectorFrame>
      <Pager page={slice.page} pages={slice.pages} onChange={setPage} label={pagerLabel} />
    </>
  );
}

function columns(inspector: InspectorContext, withItems: boolean): Column<CatalogSource>[] {
  return [
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
    { key: "last", header: "마지막 실행", cell: (row) => timeCell(row.lastRunAt) },
    { key: "next", header: "다음 실행", cell: (row) => timeCell(row.nextDueAt) },
    ...(withItems
      ? [{ key: "items", header: "받은 글", align: "right" as const, cell: (row: CatalogSource) => (row.items === null ? null : `${row.items.toLocaleString("ko-KR")}편`) }]
      : []),
    {
      key: "detail",
      header: "사유·기록",
      className: "min-w-[18rem]",
      // 자르지 않습니다(2026-11-12 사용자 지적 — 두 줄에서 '…'으로 잘려 사유·실행 기록의 뒤가 보이지 않았음). 긴 글은 칸 안에서 줄을 바꿉니다.
      cell: (row) => {
        const reason = reasonOf(row);
        return reason ? <span className="block break-keep wrap-anywhere text-caption leading-5 text-text-2">{reason}</span> : null;
      },
    },
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
