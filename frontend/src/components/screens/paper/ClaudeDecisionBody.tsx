"use client";

import type { ReactNode } from "react";
import { Table } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import { type Badge, type ClaudeDecisionView, type ClaudeOrderRow, sideClass, type ValidationRow, type WatchRow } from "@/lib/paper";

/**
 * Claude 책 결정의 본문 — 판단(자세·목표 노출·확신도·요약·노출 근거), 모델이 제안한 주문(근거·라벨·무효화 조건), 검증 결과
 * (통과·거절·사유), 관찰 목록, 사용량(모델·토큰). 결정 로그의 상세와 개요의 미리보기가 같은 모양을 씁니다.
 *
 * 값은 claudeDecisionView가 고른 표시 문자열 그대로이고, 화면은 늘어놓기만 합니다(ADR 0004). 응답이 없으면(형식 오류·거절·API 오류,
 * Claude를 부르지 않은 기록) 판단 칸 대신 상태에 맞는 한 줄(건너뛴 기록은 서버가 남긴 사유)을 적습니다 — 빈 표를 그리면 "주문이 없다고
 * 판단했다"로 읽힙니다.
 */
export function ClaudeDecisionBody({ view }: { view: ClaudeDecisionView }) {
  return (
    <div className="flex flex-col gap-4">
      <Part title="판단" note="목표 주식 노출은 Claude가 정한 값이고 기록·표시용입니다 — 집행은 아래 주문(검증 통과분) 기준입니다.">
        {view.hasResponse ? (
          <>
            <dl className="flex flex-wrap items-end gap-x-5 gap-y-1 text-xs">
              <div>
                <dt className="text-muted">자세</dt>
                <dd>{view.stance ? <Badges badges={[view.stance]} /> : <span className="text-muted">{EMPTY}</span>}</dd>
              </div>
              <div>
                <dt className="text-muted">목표 주식 노출</dt>
                <dd className="flex items-center gap-1 tabular-nums font-semibold text-bright">
                  {view.targetExposure}
                  {view.mismatch && <Badges badges={[view.mismatch]} />}
                </dd>
              </div>
              <div>
                <dt className="text-muted">확신도</dt>
                <dd className="tabular-nums font-semibold text-bright">{view.confidence}</dd>
              </div>
            </dl>
            {view.mismatch && <p className="text-[11px] leading-relaxed text-warn">{view.mismatch.title}</p>}
            <Text label="요약" value={view.summary} />
            <Text label="노출 근거" value={view.exposureRationale} />
            {view.noTradeReason && <Text label="주문 없음 사유" value={view.noTradeReason} />}
            {view.skipped && <p className="text-[11px] leading-relaxed text-warn">{view.skipped}</p>}
          </>
        ) : (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{view.noResponse}</p>
        )}
      </Part>

      {view.hasResponse && (
        <Part title="제안 주문 (모델 응답)" note="모델이 낸 그대로입니다. 통과·거절은 아래 검증 결과에 있습니다.">
          <Table<ClaudeOrderRow>
            rows={view.orders}
            rowKey={(row) => row.key}
            emptyMessage="모델이 주문을 내지 않았습니다."
            columns={[
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.sideKey)}>{row.side}</span> },
              { key: "size", header: "크기", align: "right", render: (row) => <span className="whitespace-nowrap">{row.size}</span> },
              { key: "timing", header: "체결 시점", render: (row) => <span className="whitespace-nowrap">{row.timing}</span> },
              { key: "thesis", header: "근거", render: (row) => <span className="text-xs text-body">{row.thesis}</span> },
              {
                key: "labels",
                header: "라벨",
                render: (row) => (row.labels.length > 0 ? <Badges badges={row.labels} /> : <span className="text-muted">{EMPTY}</span>),
              },
              { key: "invalidation", header: "무효화 조건", render: (row) => <span className="text-xs text-body">{row.invalidation}</span> },
            ]}
          />
        </Part>
      )}

      {(view.hasResponse || view.validation.length > 0) && (
        <Part
          title="검증"
          note="검증기(하드 규칙)가 주문마다 통과·거절을 정했습니다 — 유니버스·비중 상한·최대 종목 수·배분 합·최소 금액·월 상한·최소 보유일·재진입 금지·자료 신선도. 현금 비중·매크로 조건은 검사하지 않습니다(명세 D7)."
        >
          <Table<ValidationRow>
            rows={view.validation}
            rowKey={(row) => row.key}
            emptyMessage="검증한 주문이 없습니다."
            columns={[
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.sideKey)}>{row.side}</span> },
              { key: "size", header: "크기", align: "right", render: (row) => <span className="whitespace-nowrap">{row.size}</span> },
              { key: "result", header: "결과", render: (row) => <Badges badges={[row.result]} /> },
              {
                key: "reason",
                header: "거절 사유",
                render: (row) => <span className="text-xs text-warn" title={row.reasonTitle}>{row.reason}</span>,
              },
              { key: "detail", header: "설명", render: (row) => <span className="text-xs text-body">{row.detail}</span> },
            ]}
          />
        </Part>
      )}

      {view.watchlist.length > 0 && (
        <Part title="관찰 목록" note="주문은 아니고, 모델이 다음 결정에서 볼 조건으로 남긴 것입니다.">
          <Table<WatchRow>
            rows={view.watchlist}
            rowKey={(row) => row.key}
            columns={[
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "condition", header: "조건", render: (row) => <span className="text-xs text-body">{row.condition}</span> },
            ]}
          />
        </Part>
      )}

      {view.usage.length > 0 && (
        <Part title="사용량" note="이 호출 한 번의 토큰입니다(시스템 프롬프트는 캐시 블록 — 다시 부르면 캐시 읽기로 셉니다).">
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {view.usage.map((cell) => (
              <div key={cell.key}>
                <dt className="text-muted">{cell.label}</dt>
                <dd className="tabular-nums font-semibold text-bright">{cell.value}</dd>
              </div>
            ))}
          </dl>
        </Part>
      )}
    </div>
  );
}

/** 이름 붙은 글 한 단락. 값이 없으면 "—". */
function Text({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="text-xs">
      <p className="text-muted">{label}</p>
      <p className="whitespace-pre-wrap leading-relaxed text-body">{value || EMPTY}</p>
    </div>
  );
}

/** 상세 안의 한 부분 — 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다(결정 로그 탭과 같은 모양). */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold text-bright">{title}</h4>
      {note && <p className="text-[11px] leading-relaxed text-muted">{note}</p>}
      {children}
    </section>
  );
}

function Badges({ badges }: { badges: Badge[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <span
          key={badge.key}
          title={badge.title}
          className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}
