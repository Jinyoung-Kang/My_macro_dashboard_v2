"use client";

import Link from "next/link";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { ChangeChip, type Column, DataTable, EstimateBadge, ProvenanceBadge, Skeleton, StaleBadge } from "@/components/patterns";
import { Freshness, LINK_CLASSES, Panel, SEGMENT_TRACK, segmentClasses } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, type PaperPnlRow, paperHomeModel } from "@/lib/home";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperOverviewResponse, PaperStatusResponse } from "@/lib/types";
import { bookColor } from "../paper/bookColors";
import { SectionError } from "./HomeCard";

// 불러오는 중·오류·읽은 뒤 모두 같은 구역 이름입니다(패널 제목 — 영역 이름).
const TITLE = "모의매매 계좌";

/**
 * 읽는 중 자리표시 높이(px) — 계좌 표 네~다섯 줄 + 출처·출발·비교 줄의 높이에 가깝게(QA-598). 홈 lg 이상에서 이 패널은 두 칸 폭이라(2026-11-16 결정 5)
 * 표가 넘치지 않고 행이 48px입니다 — 루프백 빌드에서 잰 읽은 뒤 패널 높이: 1280·1440 네 계좌(QA 데이터) 381px · 다섯 계좌(운영과 같은 수 — 합성 응답) 429px,
 * 1024 477~561px, 390 680~781px(표가 가로로 넘쳐 행 100px). 이 값(패널 422px)은 xl 이상의 다섯 계좌에 맞췄습니다 — 이 패널 아래(시장)는 어느 폭에서도
 * 첫 화면 밖이라(1440 위 끝 1178px) 높이가 달라도 보이는 화면이 움직이지 않습니다.
 */
const PAPER_PENDING_HEIGHT = 335;

/**
 * ② 계좌 손익 표 패널 — 운영자 전용(/api/paper/* 전부 OWNER). 운영자가 아니면 요청하지 않고(null 경로) 그리지 않습니다.
 *
 * 표 한 줄이 계좌 하나입니다(lib/home `paperHomeModel`의 rows = `paperPnlRows` — 모의매매 개요의 계좌 행과 같은 규칙): 계좌(이름은 모의매매 화면 링크 · 종류·상태 · 개요 곡선과 같은
 * 계좌 색 견본) · 순자산 · 출발 대비 · 최근 변화(서버 값 — '오늘'·'MM-DD 변화'와 그 기준) · 기준(단계 표기 · 추정·이전 값 배지 · 사후 체결 대기 경고).
 * 화면은 숫자를 계산하지 않고, 모르는 칸은 "—"입니다. 표 아래에 출처 · 출발 줄 · 정기 작업 쉼/꺼짐 · 상태를 못 읽음 · 두 책을 견주지 않는다는 문구를 둡니다.
 * 쓰기 버튼(초기화·리스크 실행 등)은 두지 않습니다 — 홈은 읽기만 하고, 조작은 모의매매 화면에서 합니다.
 *
 * 미국 | 한국(2단계 명세 §4-16): 미국이 기본이고, 한국을 처음 고를 때부터 `?market=KR` 개요·상태를 읽습니다(고르기 전에는 한국 요청 없음 —
 * 한 번 고른 뒤에는 미국으로 돌아가도 두 시장 값을 계속 읽어 두어, 어느 쪽으로 돌아와도 자리표시 없이 바로 보임). 고르기는 패널 머리의 같은 자리에
 * 늘 남아(읽는 중·실패에도 — 다시 마운트되지 않아 키보드 초점을 잃지 않음) 미국으로 돌아갈 수 있습니다. 미국을 처음 읽는 동안은 고를 것이 없어 두지 않습니다.
 * 미국 첫 읽기가 실패해도 남습니다(한국으로 갈 수 있게 — QA-608). 실패는 error가 아니라 failedAt으로 봅니다 — useApi는 다시 읽기를 시작할 때 error를
 * 비우지만 failedAt은 남겨 두어, 다시 시도·자동 갱신으로 다시 읽는 동안에도 고르기가 다시 마운트되지 않습니다.
 */
export function PaperPnlPanel({ className }: { className?: string } = {}) {
  const owner = isOwner(useSessionUser());
  const [market, setMarket] = useState<PaperMarketCode>("US");
  // 한국을 한 번이라도 골랐나 — 그 뒤로는 한국 경로를 비우지 않습니다(비우면 useApi가 값을 지워 다시 고를 때마다 자리표시).
  const [krPicked, setKrPicked] = useState(false);
  const korea = market === "KR";
  const pick = (next: PaperMarketCode) => {
    setMarket(next);
    if (next === "KR") setKrPicked(true);
  };
  const usOverview = useApi<PaperOverviewResponse>(owner ? endpoints.paper.overview : null, HOME_REFRESH_MS.paper);
  const usStatus = useApi<PaperStatusResponse>(owner ? endpoints.paper.status : null, HOME_REFRESH_MS.paper);
  const krPaths = endpoints.paper.market("KR");
  const krOverview = useApi<PaperOverviewResponse>(owner && krPicked ? krPaths.overview : null, HOME_REFRESH_MS.paper);
  const krStatus = useApi<PaperStatusResponse>(owner && krPicked ? krPaths.status : null, HOME_REFRESH_MS.paper);
  const overview = korea ? krOverview : usOverview;
  const status = korea ? krStatus : usStatus;

  if (!owner) {
    return null;
  }
  // 패널 틀 — 읽는 중·오류·읽은 뒤 모두 같은 클래스(홈 배치가 주는 칸 폭 포함)라 값이 와도 틀이 바뀌지 않습니다.
  const frame = `min-w-0 ${className ?? ""}`.trim();

  const switchShown = korea || overview.data !== null || overview.failedAt !== null;
  // 머리 동작의 모양은 늘 같은 묶음(고르기 → 신선도)이라 읽는 중에서 값으로 바뀌어도 고르기가 다시 마운트되지 않습니다.
  const actions = switchShown ? (
    <>
      <MarketSwitch value={market} onChange={pick} />
      {overview.data ? <Freshness refreshError={overview.refreshError ?? status.refreshError} /> : null}
    </>
  ) : undefined;

  if (!overview.data) {
    return (
      <Panel region className={frame} title={TITLE} actions={actions}>
        {overview.error ? (
          <SectionError message={overview.error} onRetry={() => void overview.reload()} />
        ) : (
          <Skeleton height={PAPER_PENDING_HEIGHT} label={korea ? "한국 모의매매 계좌를 불러오는 중" : "모의매매 계좌를 불러오는 중"} />
        )}
      </Panel>
    );
  }

  const model = paperHomeModel(overview.data, status.data, { market });
  return (
    <Panel
      region
      className={frame}
      title={TITLE}
      count={model.rows.length > 0 ? `${model.rows.length.toLocaleString("ko-KR")}개` : undefined}
      actions={actions}
    >
      {/* 안내·각주 문장은 낱말 사이에서만 줄을 바꿉니다(break-keep — '출발 대|비'처럼 낱말 안에서 꺾이지 않게, 공용 키트와 같은 규칙). */}
      {model.message ? (
        <p className="break-keep text-sm text-text-2 wrap-break-word">{model.message}</p>
      ) : (
        <PnlTable rows={model.rows} korea={korea} />
      )}
      {model.available ? (
        <p className="mt-2 leading-4">
          <ProvenanceBadge source={model.source} />
        </p>
      ) : null}
      {model.available ? <p className="mt-1 break-keep text-xs leading-relaxed text-text-3 wrap-break-word">{model.startLine}</p> : null}
      {model.dormantNote ? (
        <p className="mt-1 break-keep text-xs leading-relaxed text-warn wrap-break-word">
          <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
            {model.dormantNote}
          </StatusText>
        </p>
      ) : null}
      {model.disabledNote ? (
        <p className="mt-1 break-keep text-xs leading-relaxed text-warn wrap-break-word">
          <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
            {model.disabledNote}
          </StatusText>
        </p>
      ) : null}
      {/* 정기 작업이 켜졌는지 모르면(상태 응답 실패) 모른다고 적습니다 — 꺼짐 안내가 없다고 켜진 것은 아닙니다. */}
      {!status.data && status.error ? (
        <p className="mt-1 break-keep text-xs text-text-3 wrap-break-word">정기 작업 상태를 확인하지 못했습니다 — {status.error}</p>
      ) : null}
      <p className="mt-1 break-keep text-xs leading-relaxed text-text-3 wrap-break-word">{model.compareNote}</p>
    </Panel>
  );
}

/**
 * 계좌 손익 표 — 열 다섯(계좌·순자산·출발 대비·최근 변화·기준). 모르는 칸은 null을 돌려 표가 "—"를 그립니다(0을 만들지 않음).
 * 칸 안의 변화 칩은 꺾지 않습니다(`nowrap` — 표 자동 배치가 칸에 숫자 하나 폭만 주면 '▼'가 숫자와 다른 줄에 홀로 남았음, QA-595).
 */
function PnlTable({ rows, korea }: { rows: readonly PaperPnlRow[]; korea: boolean }) {
  // 계좌 색은 모의매매 개요의 순자산 곡선과 같은 표(코드 → 색, 모르는 계좌는 자리대로 남는 색).
  const colors = new Map(rows.map((row, index) => [row.id, bookColor(row.id, index)] as const));
  const columns: Column<PaperPnlRow>[] = [
    {
      key: "book",
      header: "계좌",
      rowHeader: true,
      cell: (row) => (
        <span className="flex min-w-0 items-start gap-2">
          {/* 계좌 색 견본 — 장식(뜻은 계좌 이름). 고대비 모드에서도 곡선과 같은 색으로 남깁니다(차트 범례 견본과 같은 규칙, QA-497). */}
          <span
            aria-hidden="true"
            className="mt-1.5 size-2.5 shrink-0 rounded-sm bg-(--book-color) forced-color-adjust-none"
            style={{ "--book-color": colors.get(row.id) } as CSSProperties}
          />
          <span className="flex min-w-0 flex-col">
            {/* self-start — flex 열의 항목이라 늘어나면 누르는 자리·포커스 고리가 보조 줄 폭까지 넓어집니다(QA-607, QA-582와 같은 방법). */}
            <Link href={row.href} className={`${LINK_CLASSES} self-start break-keep`}>
              {row.name}
            </Link>
            {row.sub ? <span className="break-keep text-xs leading-4 text-text-3">{row.sub}</span> : null}
          </span>
        </span>
      ),
    },
    {
      key: "nav",
      header: "순자산",
      align: "right",
      cell: (row) =>
        row.valueText === null ? null : (
          <>
            {row.valueText}
            <span className="ml-1 text-xs text-text-3">{row.unit}</span>
          </>
        ),
    },
    {
      key: "return",
      header: "출발 대비",
      align: "right",
      cell: (row) => (row.returnPct === null ? null : <ChangeChip changePct={row.returnPct} size="sm" nowrap />),
    },
    {
      key: "day",
      header: "최근 변화",
      align: "right",
      cell: (row) =>
        row.day === null ? null : (
          <>
            <span className="inline-flex items-baseline gap-x-1.5">
              <span className="text-xs text-text-2">{row.day.label}</span>
              <ChangeChip changePct={row.day.pct} size="sm" nowrap />
            </span>
            {row.day.base ? <span className="block text-xs leading-4 text-text-3">{row.day.base}</span> : null}
          </>
        ),
    },
    {
      key: "basis",
      header: "기준",
      cell: (row) => {
        if (!row.basis && !row.isEstimated && !row.isStale && !row.warning) return null;
        return (
          // 값의 기준 글은 배지보다 앞 — '추정' 배지 바로 뒤에 '장중 추정 …'이 오면 눈에도 낭독에도 '추정 장중 추정'으로 겹칩니다(자산 행과 같은 순서).
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {row.basis ? <span className="break-keep text-xs text-text-2">{row.basis}</span> : null}
            <EstimateBadge estimated={row.isEstimated} />
            <StaleBadge stale={row.isStale} reason={row.staleReason} />
            {row.warning ? (
              <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />} className="text-xs">
                {row.warning}
              </StatusText>
            ) : null}
          </span>
        );
      },
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      caption={korea ? "모의매매 한국 계좌 손익" : "모의매매 미국 계좌 손익"}
      scrollHint="overflow"
    />
  );
}

/**
 * 미국 | 한국 — 브라우저 기본 라디오 묶음이고 모양은 공용 세그먼트(segmentClasses)입니다(고른 시장이 "선택됨"으로 읽힘).
 * 고르면 그 시장의 계좌를 표에 그립니다(한국 2단계 명세 §4-16).
 */
function MarketSwitch({ value, onChange }: { value: PaperMarketCode; onChange: (market: PaperMarketCode) => void }): ReactNode {
  const name = useId();
  const options: { market: PaperMarketCode; label: string }[] = [
    { market: "US", label: "미국" },
    { market: "KR", label: "한국" },
  ];
  return (
    <div role="radiogroup" aria-label="모의매매 시장" className={`inline-flex text-sm ${SEGMENT_TRACK}`}>
      {options.map((option) => {
        const checked = option.market === value;
        return (
          <label key={option.market} className={`px-3 lg:px-2.5 ${segmentClasses(checked)}`}>
            <input
              type="radio"
              name={name}
              value={option.market.toLowerCase()}
              checked={checked}
              onChange={() => onChange(option.market)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
