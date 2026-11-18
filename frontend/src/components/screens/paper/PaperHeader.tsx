"use client";

import Link from "next/link";
import { useId, useState, type JSX, type ReactNode } from "react";

import { FOCUS_RING, Freshness, SEGMENT_TRACK, segmentClasses, Tag, TEXT_TARGET } from "@/components/ui";
import { ChevronDownIcon } from "@/components/ui/icons";
import { paperTabInMarket, type PaperTabKey } from "@/lib/paper";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { paperTabPath } from "@/lib/paperRoutes";
import { PaperLimitsDrawer } from "./PaperLimitsDrawer";

/** 시장 세그먼트의 두 칸(미국 → 한국 — 셸 하위 메뉴 줄과 같은 차례). */
const MARKETS: readonly { code: PaperMarketCode; label: string }[] = [
  { code: "US", label: "미국" },
  { code: "KR", label: "한국" },
];

/**
 * 모의매매 화면 머리(작업대 P6 — 실행 명세 §7-1 '머리 압축'): 넓은 화면(lg 이상)은 한 줄 — 제목(h1) · 시장 세그먼트(미국/한국) · 계좌 고르기 칸 ·
 * '이 장부의 한계 (n줄)' 서랍 단추 · '자세히' · 신선도 · 오른쪽 끝 동작 칸. 좁은 화면(lg 미만)은 제목 / 계좌 고르기 + 동작 / 한계 단추 · 자세히 세 줄이고
 * 조작은 모두 44px입니다(시장 세그먼트는 셸 하위 메뉴 줄이 같은 일을 해 그리지 않음 — 두 줄로 겹쳐 보였음).
 *
 * - 계좌 고르기·동작 칸은 탭의 섹션이 채웁니다(PaperTabHeader 계약 — 콜백 ref로 칸 요소를 넘기면 PaperScreen이 공급자에 넘김). 비어 있으면 칸을 숨깁니다
 *   (empty:hidden — 빈 칸의 간격이 남지 않게). 계좌 칸은 고른 계좌 이름 폭 아래로 줄어들지 않고(shrink-0 — 줄 폭까지만), 같은 줄에 동작이 들어가지 않으면
 *   동작이 다음 줄로 갑니다(QA-772 — 예전에는 계좌 칸이 동작에 밀려 390 보유 탭에서 'Claude 계좌1 · 운용 중'이 'Claude 계좌'까지만 보였음).
 * - DOM 차례는 제목 → 계좌 → 동작 → 한계·자세히·신선도로, 좁은 화면의 보이는 차례(계좌·동작 → 한계 줄)와 같습니다(QA-772 — Tab 차례). 넓은 화면은 동작 칸만
 *   맨 오른쪽 끝으로 옮깁니다(lg:order-last·ml-auto — 줄 끝이라 읽는 차례가 크게 어긋나지 않음).
 * - 시장 세그먼트는 같은 탭의 다른 시장 주소로 가는 링크 둘(지금 시장은 aria-current="page") — 그 시장에 없는 탭(미국의 'ISA 계좌')이면 그 시장의 개요.
 * - '자세히'는 예전 머리 설명 문단(글 그대로)을 펼치는 단추(aria-expanded·aria-controls)입니다. 접힌 동안에도 글은 DOM에 남습니다(hidden — `<details>`와 같음).
 * - 실제 계좌·ISA 탭이면 제목 옆에 주의 태그 '실제 계좌'(명세 §7-1 '실제 표지는 늘 보임' — 그 탭의 모듈은 건드리지 않음, 진행 기록 real-isa-banner-neutral-not-warn).
 * - 이 파일은 실제 매매·실제 계좌·ISA 모듈을 가져오지 않습니다(그 모듈을 부르는 곳은 PaperScreen 하나 — 경계 시험).
 */
export function PaperHeader({
  title,
  market,
  tab,
  description,
  limits,
  refreshError,
  realMarker = false,
  onAccountSlot,
  onActionsSlot,
}: {
  title: string;
  market: PaperMarketCode;
  /** 지금 탭 — 시장 세그먼트 링크가 같은 탭으로 갑니다. */
  tab: PaperTabKey;
  /** '자세히' 안의 설명(예전 머리 설명 그대로). */
  description: ReactNode;
  /** 한계 서랍 — 개요가 있고 한계 문구가 있을 때만(없으면 null). */
  limits: { lines: readonly string[]; source: string; book2Label: string | null } | null;
  refreshError: string | null;
  /** 실제 계좌·ISA 탭인가 — 제목 옆 주의 태그. */
  realMarker?: boolean;
  onAccountSlot: (element: HTMLElement | null) => void;
  onActionsSlot: (element: HTMLElement | null) => void;
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = `${useId()}-details`;
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 lg:basis-auto">
          <h1 className="text-heading text-text">{title}</h1>
          {realMarker ? <Tag tone="warn">실제 계좌</Tag> : null}
          <nav aria-label="모의 매매 시장" className={`hidden lg:inline-flex ${SEGMENT_TRACK}`}>
            {MARKETS.map((entry) => {
              const current = entry.code === market;
              return (
                <Link
                  key={entry.code}
                  href={paperTabPath(paperTabInMarket(tab, entry.code) ? tab : "overview", entry.code)}
                  aria-current={current ? "page" : undefined}
                  className={`${segmentClasses(current)} px-2.5 text-[13px] ${FOCUS_RING}`}
                >
                  {entry.label}
                </Link>
              );
            })}
          </nav>
        </div>
        {/* 계좌 고르기 칸(탭이 채움 — 비면 숨김) — 고른 이름 폭 아래로 줄어들지 않고 줄 폭까지만(QA-772). */}
        <div ref={onAccountSlot} data-paper-header-slot="account" className="flex max-w-full shrink-0 items-center empty:hidden" />
        {/* 동작 칸(탭이 채움 — 비면 숨김) — 좁은 화면은 계좌 칸 옆(들어가지 않으면 다음 줄), 넓은 화면은 오른쪽 끝(order·ml-auto). */}
        <div ref={onActionsSlot} data-paper-header-slot="actions" className="flex items-center empty:hidden lg:order-last lg:ml-auto" />
        <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 lg:basis-auto">
          {limits ? <PaperLimitsDrawer limits={limits.lines} source={limits.source} book2Label={limits.book2Label} /> : null}
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
            className={`${TEXT_TARGET} cursor-pointer gap-1 rounded-sm text-[13px] text-text-2 hover:text-text ${FOCUS_RING}`}
          >
            자세히
            <ChevronDownIcon size={14} className={`motion-safe:transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
          </button>
          {/* 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'(QA-104, QA-067과 같음). */}
          <Freshness refreshError={refreshError} />
        </div>
      </div>
      <div id={detailsId} hidden={!detailsOpen} className="max-w-[72ch] text-sm leading-relaxed text-text-2">
        {description}
      </div>
    </header>
  );
}
