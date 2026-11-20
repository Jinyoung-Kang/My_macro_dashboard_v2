"use client";

import { DataTable } from "@/components/patterns";
import { Tag } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import { type GateConditionRow, type GateInputRow, gateView, toneClass } from "@/lib/paper";
import type { PaperGateIndicator } from "@/lib/types";
import { PaperBadge } from "./PaperBadge";

/**
 * OS 게이트 지표(참고)의 본문 — 단계 배지, 조건 표(참·거짓·연속 일수), 입력 표(값·시세 시각·지난 값).
 * 개요의 게이트 카드와 결정 상세의 "게이트(참고)"가 같은 모양을 씁니다. 두 표는 공용 조밀 표(세 칸 — 최소 폭·넘김 안내 없음)이고 모르는 칸은 공용 '—'
 * (낭독 '값 없음'), 이어 쓴 입력은 주의 태그 '지난 값'(아이콘 + 낭독 '주의: ' — 작업대 P6 통합에서 옛 ui Table·자체 배지를 옮김).
 *
 * "참고 — 구속하지 않음"을 늘 단계 배지 옆에 둡니다. 단계 이름(동결·해제)만 보이면 규칙 책이나 검증기가 그 단계를 따르는 것으로
 * 읽히는데, 실제로는 어느 책도 이 값을 읽지 않습니다(명세 D7·D19) — 기록·표시와 Claude 패킷의 참고 섹션뿐입니다.
 */
/** 이번 수집에 실패해 지난 값을 이어 쓴 입력의 표지(글·마우스 설명은 예전 그대로, 주의 톤). */
const STALE_INPUT = { label: "지난 값", className: toneClass("warn"), title: "이번 수집에 실패해 지난 값을 이어 썼습니다." };

export function GateIndicatorBody({ gate, compact = false }: { gate: PaperGateIndicator | null | undefined; compact?: boolean }) {
  const view = gateView(gate);
  if (!view) {
    return (
      <p className="text-sm text-text-3">
        아직 게이트 기록이 없습니다 — 결정 작업이 거래일마다 매크로 카드 값으로 한 번 남깁니다.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* 단계 배지·참고 표지는 공용 태그(20px — 작업대 P6). */}
        <PaperBadge badge={view.level} />
        <Tag>참고 — 구속하지 않음</Tag>
        <span className="text-xs text-text-3">거래일 {view.tradingDate}</span>
      </div>
      {view.levelNote && <p className="text-xs leading-relaxed text-text-2">{view.levelNote}</p>}
      <p className="text-xs leading-relaxed text-text-3">
        {view.note}. 규칙 계좌는 이 지표를 쓰지 않고(매크로 게이트 없음), Claude 계좌에는 참고 자료로만 들어갑니다.
      </p>
      <section aria-label="게이트 조건" className="flex flex-col gap-1">
        <DataTable<GateConditionRow>
          caption="게이트 조건"
          dense
          rows={view.conditions}
          rowKey={(row) => row.key}
          columns={[
            {
              key: "label",
              header: "조건",
              className: "break-keep",
              cell: (row) => <span className={row.reference ? "text-text-3" : "text-text-2"}>{row.label}</span>,
            },
            {
              key: "state",
              header: "그날",
              className: "whitespace-nowrap",
              cell: (row) => (row.state === EMPTY ? null : <span className={row.stateClass}>{row.state}</span>),
            },
            { key: "streak", header: "연속", align: "right", cell: (row) => row.streak },
          ]}
        />
      </section>
      {!compact && (
        <section aria-label="게이트 입력" className="flex flex-col gap-1">
          <DataTable<GateInputRow>
            caption="게이트 입력"
            dense
            rows={view.inputs}
            rowKey={(row) => row.key}
            columns={[
              { key: "label", header: "입력", className: "break-keep", cell: (row) => row.label },
              { key: "value", header: "값", align: "right", cell: (row) => row.value },
              {
                key: "lastTs",
                header: "시세 시각",
                cell: (row) =>
                  row.lastTs === EMPTY && !row.stale ? null : (
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="whitespace-nowrap">{row.lastTs}</span>
                      {row.stale && <PaperBadge badge={STALE_INPUT} />}
                    </span>
                  ),
              },
            ]}
          />
        </section>
      )}
    </div>
  );
}
