"use client";

import type { JSX } from "react";

import { PropertyList } from "@/components/patterns";
import { Button } from "@/components/ui";
import { positionProperties } from "@/lib/paperHoldingsView";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { LivePrice, PaperPosition } from "@/lib/types";

/**
 * 보유 표의 검사 칸(작업대 P6 — 실행 명세 §7-1 '보유: 목록-검사'): 고른 보유의 속성(수량·평단·가격·평가액·비중·평가 손익·최고가·스탑과 거리·보유 기간·표지·
 * 실시간 — lib/paperHoldingsView positionProperties)과, 진입 논거·조건 확인이 있는 곳으로 가는 '결정 로그에서 보기'.
 *
 * 진입 논거·조건(checks·holdingChecks)은 보유 응답에 없고 결정 상세에만 있어(데이터 공백 — 계획 §12-1, 사용자 결정 거리 U3 권장안), 고를 때마다 결정을 더 읽지
 * 않고 결정 로그 탭(이 계좌를 미리 고름)으로 가리킵니다 — 새 요청이 없습니다. 결정을 내지 않는 계좌(벤치마크)는 그 단추가 없습니다.
 */
export function HoldingInspector({
  position,
  market = "US",
  live = null,
  onOpenDecisions,
}: {
  position: PaperPosition;
  market?: PaperMarketCode;
  live?: LivePrice | null;
  /** 결정 로그 탭으로 — 결정을 내는 계좌(규칙·Claude)만. */
  onOpenDecisions?: () => void;
}): JSX.Element {
  const items = positionProperties(position, market, live).map((property) => ({
    key: property.key,
    label: property.label,
    value: property.tone && property.value !== "—" ? <span className={property.tone}>{property.value}</span> : property.value,
    note: property.note,
  }));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PropertyList items={items} dense />
      <p className="text-xs text-text-3">
        진입 논거·무효화 조건과 그 확인(조건 충족 여부)은 결정 로그의 결정 상세에 있습니다 — 보유 응답에는 없어 여기서 새로 읽지 않습니다.
      </p>
      {onOpenDecisions ? (
        <div>
          <Button onClick={onOpenDecisions}>결정 로그에서 보기</Button>
        </div>
      ) : null}
    </div>
  );
}
