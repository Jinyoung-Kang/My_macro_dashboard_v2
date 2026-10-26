"use client";

import { Table } from "@/components/ui";
import { type GateConditionRow, type GateInputRow, gateView } from "@/lib/paper";
import type { PaperGateIndicator } from "@/lib/types";

/**
 * OS 게이트 지표(참고)의 본문 — 단계 배지, 조건 표(참·거짓·연속 일수), 입력 표(값·시세 시각·지난 값).
 * 개요의 게이트 카드와 결정 상세의 "게이트(참고)"가 같은 모양을 씁니다.
 *
 * "참고 — 구속하지 않음"을 늘 단계 배지 옆에 둡니다. 단계 이름(동결·해제)만 보이면 규칙 책이나 검증기가 그 단계를 따르는 것으로
 * 읽히는데, 실제로는 어느 책도 이 값을 읽지 않습니다(명세 D7·D19) — 기록·표시와 Claude 패킷의 참고 섹션뿐입니다.
 */
export function GateIndicatorBody({ gate, compact = false }: { gate: PaperGateIndicator | null | undefined; compact?: boolean }) {
  const view = gateView(gate);
  if (!view) {
    return (
      <p className="text-sm text-muted">
        아직 게이트 기록이 없습니다 — 결정 작업이 거래일마다 매크로 카드 값으로 한 번 남깁니다.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${view.level.className}`}>{view.level.label}</span>
        <span className="rounded-sm border border-border bg-surface-hover px-2 py-0.5 text-[11px] text-muted">참고 — 구속하지 않음</span>
        <span className="text-xs text-muted">거래일 {view.tradingDate}</span>
      </div>
      {view.levelNote && <p className="text-xs leading-relaxed text-body">{view.levelNote}</p>}
      <p className="text-[11px] leading-relaxed text-muted">
        {view.note}. 규칙 계좌는 이 지표를 쓰지 않고(매크로 게이트 없음), Claude 계좌에는 참고 자료로만 들어갑니다.
      </p>
      <section aria-label="게이트 조건" className="flex flex-col gap-1">
        <Table<GateConditionRow>
          rows={view.conditions}
          rowKey={(row) => row.key}
          columns={[
            {
              key: "label",
              header: "조건",
              render: (row) => <span className={row.reference ? "text-muted" : "text-body"}>{row.label}</span>,
            },
            { key: "state", header: "그날", render: (row) => <span className={row.stateClass}>{row.state}</span> },
            { key: "streak", header: "연속", align: "right", render: (row) => row.streak },
          ]}
        />
      </section>
      {!compact && (
        <section aria-label="게이트 입력" className="flex flex-col gap-1">
          <Table<GateInputRow>
            rows={view.inputs}
            rowKey={(row) => row.key}
            columns={[
              { key: "label", header: "입력", render: (row) => row.label },
              { key: "value", header: "값", align: "right", render: (row) => row.value },
              {
                key: "lastTs",
                header: "시세 시각",
                render: (row) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <span>{row.lastTs}</span>
                    {row.stale && (
                      <span
                        title="이번 수집에 실패해 지난 값을 이어 썼습니다."
                        className="whitespace-nowrap rounded-sm border border-warn/40 bg-warn/10 px-1.5 py-px text-[10px] text-warn"
                      >
                        지난 값
                      </span>
                    )}
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
