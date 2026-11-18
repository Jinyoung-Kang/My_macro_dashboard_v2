"use client";

import type { JSX } from "react";

import { PropertyList } from "@/components/patterns";
import { buttonClasses } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { accountSummaryProperties, type AccountTableRow, type NavRangeKey, type OverviewHeroModel } from "@/lib/paperOverview";
import type { PaperBookSummary, PaperLiveSessionSummary, PaperOverviewBook } from "@/lib/types";
import { AccountCurvePanel } from "./AccountCurvePanel";
import { AccountDetailPanel } from "./AccountDetailPanel";
import { PaperBadge } from "./PaperBadge";

/**
 * 개요 계좌 표의 검사 칸(작업대 P6 — 실행 명세 §7-1 '개요: 계좌 비교 표 + 고른 계좌 검사 칸(속성·곡선 패널)'). 넓은 화면은 표 오른쪽 칸(InspectorFrame wide),
 * 좁은 화면·좁은 틀은 위쪽 대화상자입니다.
 *
 * - 요약(늘): 상태 배지·경고, 곡선 패널(그 계좌 한 줄·기간 탭·문지르기 — AccountCurvePanel), 장부 속성(한 줄 소개·종류·처음 현금·현금·보유·출발일·장부 마지막
 *   관측·비교 기준 — 맨 위 KPI 띠와 겹치지 않는 값). 새 요청이 없습니다(개요 응답 그대로).
 * - 상세(`detail` — 사용자가 그 계좌의 줄 단추나 '상세 보기'를 눌렀을 때만): 예전 계좌 상세 몸통(AccountDetailPanel — 정의·지금 설정·핵심 숫자·구성·최근 체결·
 *   다른 탭으로). 그때만 그 계좌의 보유·체결·설정을 읽습니다(예전 행 누르기와 같은 GET 셋). 아무것도 고르지 않은 처음 화면(기본 규칙 계좌)은 요약만이라
 *   개요를 열 때 요청 수가 늘지 않습니다.
 */
export function AccountInspector({
  book,
  books,
  row,
  model,
  range,
  ranges,
  onRange,
  detail,
  detailId,
  openId,
  onOpenDetail,
  onCloseDetail,
  onOpenTab,
  market = "US",
  session = null,
}: {
  book: PaperOverviewBook;
  books: readonly PaperBookSummary[];
  /** 그 계좌의 표 줄(상태 배지·경고). */
  row: AccountTableRow | null;
  /** 곡선 패널 모델 — 시작한 장부(초기화 뒤)에만(없으면 곡선 없이 속성만). */
  model: OverviewHeroModel | null;
  range: NavRangeKey;
  ranges: readonly NavRangeKey[];
  onRange: (range: NavRangeKey) => void;
  /** 상세를 보이는가(사용자가 이 계좌를 고름). */
  detail: boolean;
  /** 상세 영역의 id(열 때 제목으로 포커스·스크롤). */
  detailId: string;
  /** '상세 열기' 단추의 id — 상세를 닫으면 개요가 포커스를 이 단추로 옮깁니다. */
  openId: string;
  onOpenDetail: () => void;
  onCloseDetail: () => void;
  onOpenTab?: (tab: "holdings" | "decisions", code: string) => void;
  market?: PaperMarketCode;
  session?: PaperLiveSessionSummary | null;
}): JSX.Element {
  const properties = accountSummaryProperties(book, books, market);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {row ? (
        <div className="flex flex-wrap items-center gap-2">
          <PaperBadge badge={row.status} />
          {row.warning ? (
            <span className="text-xs text-warn">
              <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
                {row.warning}
              </StatusText>
            </span>
          ) : null}
        </div>
      ) : null}
      {model ? <AccountCurvePanel model={model} range={range} ranges={ranges} onRange={onRange} /> : null}
      <PropertyList
        dense
        items={properties.map((property) => ({ key: property.key, label: property.label, value: property.value, block: property.block }))}
      />
      {detail ? (
        <AccountDetailPanel
          key={book.code}
          id={detailId}
          book={book}
          books={books}
          onClose={onCloseDetail}
          onOpenTab={onOpenTab}
          market={market}
          session={session}
        />
      ) : (
        <div className="flex flex-col items-start gap-1">
          <p className="text-xs text-text-3">정의·지금 설정·핵심 숫자·구성·최근 체결은 상세에서 봅니다(열 때 이 계좌의 보유·체결·설정을 읽음).</p>
          <button type="button" id={openId} onClick={onOpenDetail} className={buttonClasses("default")}>
            {book.label} 상세 열기
          </button>
        </div>
      )}
    </div>
  );
}
