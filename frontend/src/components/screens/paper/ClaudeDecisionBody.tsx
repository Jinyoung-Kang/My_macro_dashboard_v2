"use client";

import type { ReactNode } from "react";
import { Table } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import { type Badge, type ClaudeDecisionView, type ClaudeOrderRow, sideClass, type ValidationRow, type WatchRow } from "@/lib/paper";
import type { KrDecisionExtras } from "@/lib/paperKr";
import { KrDecisionExtrasParts, KrEventsPart } from "./KrRuleDecisionBody";

/**
 * Claude 책 결정의 본문 — 판단(자세·목표 노출·확신도·요약·노출 근거), 모델이 제안한 주문(근거·라벨·무효화 조건), 검증 결과
 * (통과·거절·사유), 관찰 목록, 사용량(모델·토큰). 결정 로그의 상세와 개요의 미리보기가 같은 모양을 씁니다.
 *
 * 값은 claudeDecisionView가 고른 표시 문자열 그대로이고, 화면은 늘어놓기만 합니다(ADR 0004). 응답이 없으면(형식 오류·거절·API 오류,
 * Claude를 부르지 않은 기록) 판단 칸 대신 상태에 맞는 한 줄(건너뛴 기록은 서버가 남긴 사유)을 적습니다 — 빈 표를 그리면 "주문이 없다고
 * 판단했다"로 읽힙니다.
 *
 * 한국 Claude 계좌(kr_claude)는 `kr`를 넘깁니다 — 기한 지남(건너뜀)·출발(설정 출발일·미룸·출발 호출 수)·자료 게이트 표를 맨 위에, 패킷의 사건
 * 줄(11b_events)을 관찰 목록 뒤에 더하고, 검증 설명에 한국 사유를 적습니다.
 *
 * 🧪 미국 계좌2 장중 확인 결정(kind CHECKPOINT — 단계 2)은 맨 위에 '장중 확인'(요청·KEEP/REPLACE·적용·대신한 대기 주문·예상 상태·재시도 없음)을 두고
 * 판단 칸의 자세·목표 노출·확신도는 그리지 않습니다(확인 응답에 없는 칸). 아침 결정이 장중 확인을 요청했으면 판단 칸에 그 요청 한 줄.
 */
export function ClaudeDecisionBody({
  view,
  kr,
}: {
  view: ClaudeDecisionView;
  /** 한국 Claude 계좌 결정의 공통 칸(lib/paperKr krDecisionExtras)과 입력 패킷 — 미국 결정은 없음. */
  kr?: { extras: KrDecisionExtras; packet: unknown };
}) {
  return (
    <div className="flex flex-col gap-4">
      {kr && <KrDecisionExtrasParts extras={kr.extras} />}
      {view.checkpoint && (
        <Part
          title="장중 확인"
          note="세션당 한 번 부른 장중 확인입니다. REPLACE는 기준 시각이 아직 오지 않은 대기 주문만 대신하고, 기준 시각이 지난 주문은 자료로 체결합니다. 예상 상태는 그 주문들을 체결로 본 추정입니다."
        >
          <dl className="flex flex-col gap-1 text-xs">
            <MetaRow label="요청">{view.checkpoint.request}</MetaRow>
            <MetaRow label="응답">
              {view.checkpoint.action ? <Badges badges={[view.checkpoint.action]} /> : <span className="text-muted">{EMPTY}</span>}
            </MetaRow>
            <MetaRow label="적용">{view.checkpoint.applied}</MetaRow>
            <MetaRow label="대신한 대기 주문">{view.checkpoint.superseded}</MetaRow>
            <MetaRow label="예상 상태(추정)">
              {view.checkpoint.expected.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {view.checkpoint.expected.map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : EMPTY}
            </MetaRow>
          </dl>
          <p className="text-[11px] leading-relaxed text-muted">{view.checkpoint.retry}</p>
        </Part>
      )}
      <Part
        title="판단"
        note={view.checkpoint
          ? "장중 확인은 자세·목표 노출 없이 그대로 둠(KEEP)·대신함(REPLACE)과 주문만 냅니다 — 요약은 Claude가 쓴 장중 판단이고, 집행은 아래 주문(검증 통과분) 기준입니다."
          : "목표 주식 노출은 Claude가 정한 값이고 기록·표시용입니다 — 집행은 아래 주문(검증 통과분) 기준입니다."}
      >
        {view.hasResponse ? (
          <>
            {!view.checkpoint && <dl className="flex flex-wrap items-end gap-x-5 gap-y-1 text-xs">
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
            </dl>}
            {view.mismatch && <p className="text-[11px] leading-relaxed text-warn">{view.mismatch.title}</p>}
            <Text label="요약" value={view.summary} />
            {!view.checkpoint && <Text label="노출 근거" value={view.exposureRationale} />}
            {view.noTradeReason && <Text label="주문 없음 사유" value={view.noTradeReason} />}
            {view.checkpointPlan && <Text label="장중 확인 요청" value={view.checkpointPlan} />}
            {view.skipped && <p className="text-[11px] leading-relaxed text-warn">{view.skipped}</p>}
          </>
        ) : (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{view.noResponse}</p>
        )}
      </Part>

      {view.hasResponse && (
        <Part title="제안 주문 (모델 응답)" note="모델이 낸 그대로입니다. 통과·거절은 아래 검증 결과에 있습니다.">
          <Table<ClaudeOrderRow>
            label="제안 주문"
            rows={view.orders}
            rowKey={(row) => row.key}
            emptyMessage="모델이 주문을 내지 않았습니다."
            columns={[
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.sideKey)}>{row.side}</span> },
              { key: "size", header: "크기", align: "right", render: (row) => <span className="whitespace-nowrap">{row.size}</span> },
              {
                key: "timing",
                header: "체결 시점",
                // 미국 Claude 계좌2는 그 시점을 고른 이유(executionNote)를 아래 작은 글로 — 계좌1 주문은 시점만(예전 그대로).
                render: (row) => (row.executionNote ? (
                  <span className="flex flex-col">
                    <span className="whitespace-nowrap">{row.timing}</span>
                    <span className="text-[11px] text-text-3" title="실행 메모(executionNote) — 이 시점을 고른 이유">{row.executionNote}</span>
                  </span>
                ) : <span className="whitespace-nowrap">{row.timing}</span>),
              },
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
          note={kr
            ? "검증기(한국 하드 규칙)가 주문마다 통과·거절을 정했습니다 — 유니버스·비중 상한·최대 종목 수·배분 합·최소 금액·월 상한·최소 보유일·"
              + "재진입 금지·체결할 수 없는 종목 매수(UNFILLABLE — 봉 없음·거래정지·기업행위 보류)·증가분 1주 미만(BUY_BELOW_ONE_SHARE). 현금 비중·"
              + "매크로 조건은 검사하지 않습니다."
            : "검증기(하드 규칙)가 주문마다 통과·거절을 정했습니다 — 유니버스·비중 상한·최대 종목 수·배분 합·최소 금액·월 상한·최소 보유일·재진입 금지·자료 신선도. 현금 비중·매크로 조건은 검사하지 않습니다(명세 D7)."}
        >
          <Table<ValidationRow>
            label="검증"
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
            label="관찰 목록"
            rows={view.watchlist}
            rowKey={(row) => row.key}
            columns={[
              { key: "ticker", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.ticker}</span> },
              { key: "condition", header: "조건", render: (row) => <span className="text-xs text-body">{row.condition}</span> },
            ]}
          />
        </Part>
      )}

      {kr && <KrEventsPart packet={kr.packet} />}

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

/** 이름 붙은 한 줄(장중 확인 칸). */
function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="min-w-[7rem] text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 leading-relaxed text-body">{children}</dd>
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

/** 상세 안의 한 부분 — 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다(결정 로그 탭과 같은 모양).
 * 제목은 h3 — 이 상세는 카드(제목 h2) 바로 안에 그려지므로 h4로 건너뛰지 않습니다. */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold text-bright">{title}</h3>
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
