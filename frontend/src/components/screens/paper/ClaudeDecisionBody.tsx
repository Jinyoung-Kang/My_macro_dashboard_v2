"use client";

import type { ReactNode } from "react";
import { DataTable, InspectorSubheading } from "@/components/patterns";
import { EMPTY } from "@/lib/format";
import { type Badge, type ClaudeDecisionView, type ClaudeOrderRow, type ConditionRow, sideClass, type ValidationRow, type WatchRow } from "@/lib/paper";
import type { KrDecisionExtras } from "@/lib/paperKr";
import { PaperBadge } from "./PaperBadge";
import { TickerName } from "./TickerName";
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
 * 미국 계좌2 장중 확인 결정(kind CHECKPOINT — 단계 2)은 맨 위에 '장중 확인'(요청·KEEP/REPLACE·적용·대신한 대기 주문·예상 상태·재시도 없음)을 두고
 * 판단 칸의 자세·목표 노출·확신도는 그리지 않습니다(확인 응답에 없는 칸). 아침 결정이 장중 확인을 요청했으면 판단 칸에 그 요청 한 줄.
 * 자유 시점 판의 장중 판단 결정(kind INTRADAY_n)도 같은 응답 구조라 같은 묶음을 쓰고(제목 '장중 판단 n'·안내는 뷰가 고름), 사건이 부른 판단이면
 * '호출 이유', 응답이 다음 판단을 예약했으면 '다음 판단 예약' 줄이 더 있습니다(QA-364).
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
        <Part title={view.checkpoint.title} note={view.checkpoint.note}>
          <dl className="flex flex-col gap-1 text-xs">
            <MetaRow label="요청">{view.checkpoint.request}</MetaRow>
            {view.checkpoint.trigger && <MetaRow label="호출 이유">{view.checkpoint.trigger}</MetaRow>}
            <MetaRow label="응답">
              {view.checkpoint.action ? <Badges badges={[view.checkpoint.action]} /> : <span className="text-text-3">{EMPTY}</span>}
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
            {view.checkpoint.next.length > 0 && (
              <MetaRow label="다음 판단 예약">
                <ul className="flex flex-col gap-0.5">
                  {view.checkpoint.next.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </MetaRow>
            )}
          </dl>
          <p className="text-xs leading-relaxed text-text-3">{view.checkpoint.retry}</p>
        </Part>
      )}
      <Part
        title="판단"
        note={view.checkpoint
          ? view.checkpoint.judgeNote
          : "목표 주식 노출은 Claude가 정한 값이고 기록·표시용입니다 — 집행은 아래 주문(검증 통과분) 기준입니다."}
      >
        {view.hasResponse ? (
          <>
            {!view.checkpoint && <dl className="flex flex-wrap items-end gap-x-5 gap-y-1 text-xs">
              <div>
                <dt className="text-text-3">자세</dt>
                <dd>{view.stance ? <Badges badges={[view.stance]} /> : <span className="text-text-3">{EMPTY}</span>}</dd>
              </div>
              <div>
                <dt className="text-text-3">목표 주식 노출</dt>
                <dd className="flex items-center gap-1 tabular-nums font-semibold text-text">
                  {view.targetExposure}
                  {view.mismatch && <Badges badges={[view.mismatch]} />}
                </dd>
              </div>
              <div>
                <dt className="text-text-3">확신도</dt>
                <dd className="tabular-nums font-semibold text-text">{view.confidence}</dd>
              </div>
            </dl>}
            {view.mismatch && <p className="text-xs leading-relaxed text-warn">{view.mismatch.title}</p>}
            <Text label="요약" value={view.summary} />
            {!view.checkpoint && <Text label="노출 근거" value={view.exposureRationale} />}
            {view.desiredExposure && <Text label="바라는 노출" value={view.desiredExposure} />}
            {view.exposurePlan && <Text label="노출 계획" value={view.exposurePlan} />}
            {view.noTradeReason && <Text label="주문 없음 사유" value={view.noTradeReason} />}
            {view.checkpointPlan && <Text label="장중 확인 요청" value={view.checkpointPlan} />}
            {view.skipped && <p className="text-xs leading-relaxed text-warn">{view.skipped}</p>}
          </>
        ) : (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-text-3">{view.noResponse}</p>
        )}
      </Part>

      {view.hasResponse && (
        <Part title="제안 주문 (모델 응답)" note="모델이 낸 그대로입니다. 통과·거절은 아래 검증 결과에 있습니다.">
          <DataTable<ClaudeOrderRow>
            caption="제안 주문"
            dense
            scrollHint
            rows={view.orders}
            rowKey={(row) => row.key}
            emptyText="모델이 주문을 내지 않았습니다."
            columns={[
              { key: "ticker", header: "종목", className: "break-keep", cell: (row) => <span className="font-semibold text-text"><TickerName code={row.ticker} /></span> },
              { key: "side", header: "방향", className: "whitespace-nowrap", cell: (row) => <span className={sideClass(row.sideKey)}>{row.side}</span> },
              { key: "size", header: "크기", align: "right", cell: (row) => <span className="whitespace-nowrap">{row.size}</span> },
              {
                key: "timing",
                header: "체결 시점",
                className: "break-keep",
                // 미국 Claude 계좌2는 그 시점을 고른 이유(executionNote)를 아래 작은 글로 — 계좌1 주문은 시점만(예전 그대로).
                cell: (row) => (row.executionNote ? (
                  <span className="flex flex-col">
                    <span className="whitespace-nowrap">{row.timing}</span>
                    <span className="text-xs text-text-3" title="실행 메모(executionNote) — 이 시점을 고른 이유">{row.executionNote}</span>
                  </span>
                ) : <span className="whitespace-nowrap">{row.timing}</span>),
              },
              { key: "thesis", header: "근거", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.thesis}</span> },
              {
                key: "labels",
                header: "라벨",
                className: "break-keep",
                cell: (row) => (row.labels.length > 0 ? <Badges badges={row.labels} /> : <span className="text-text-3">{EMPTY}</span>),
              },
              { key: "invalidation", header: "무효화 조건", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.invalidation}</span> },
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
          <DataTable<ValidationRow>
            caption="검증"
            dense
            scrollHint
            rows={view.validation}
            rowKey={(row) => row.key}
            emptyText="검증한 주문이 없습니다."
            columns={[
              { key: "ticker", header: "종목", className: "break-keep", cell: (row) => <span className="font-semibold text-text"><TickerName code={row.ticker} /></span> },
              { key: "side", header: "방향", className: "whitespace-nowrap", cell: (row) => <span className={sideClass(row.sideKey)}>{row.side}</span> },
              { key: "size", header: "크기", align: "right", cell: (row) => <span className="whitespace-nowrap">{row.size}</span> },
              { key: "result", header: "결과", className: "break-keep", cell: (row) => <Badges badges={[row.result]} /> },
              {
                key: "reason",
                header: "거절 사유",
                className: "break-keep",
                // 사유가 없는 행(통과)의 '—'은 값이 없는 칸이라 다른 빈 칸처럼 보조 글 색 — 주의색은 거절 사유가 있을 때만(QA-506).
                cell: (row) => (row.reason === EMPTY
                  ? <span className="text-xs text-text-3">{EMPTY}</span>
                  : <span className="text-xs text-warn" title={row.reasonTitle}>{row.reason}</span>),
              },
              { key: "detail", header: "설명", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.detail}</span> },
            ]}
          />
        </Part>
      )}

      {view.watchlist.length > 0 && (
        <Part title="관찰 목록" note="주문은 아니고, 모델이 다음 결정에서 볼 조건으로 남긴 것입니다.">
          <DataTable<WatchRow>
            caption="관찰 목록"
            dense
            rows={view.watchlist}
            rowKey={(row) => row.key}
            columns={[
              { key: "ticker", header: "종목", className: "break-keep", cell: (row) => <span className="font-semibold text-text"><TickerName code={row.ticker} /></span> },
              { key: "condition", header: "조건", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.condition}</span> },
            ]}
          />
        </Part>
      )}

      {view.conditions.length > 0 && (
        <Part title="남긴 조건" note="다음 결정과 장중 판단의 패킷에 코드가 지금 값으로 충족 여부를 매겨 돌려주는 조건입니다. 종목이 붙은 조건은 그 종목을 보유하는 동안 계속 매겨집니다. 코드가 대신 집행하지는 않습니다.">
          <DataTable<ConditionRow>
            caption="남긴 조건"
            dense
            rows={view.conditions}
            rowKey={(row) => row.key}
            columns={[
              { key: "holding", header: "종목", className: "break-keep", cell: (row) => <span className="whitespace-nowrap text-xs text-text-2">{row.holding}</span> },
              { key: "rule", header: "조건", className: "break-keep", cell: (row) => <code className="whitespace-nowrap text-xs text-text">{row.rule}</code> },
              { key: "then", header: "충족되면", className: "break-keep", cell: (row) => <span className="text-xs text-text-2">{row.then}</span> },
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
                <dt className="text-text-3">{cell.label}</dt>
                <dd className="tabular-nums font-semibold text-text">{cell.value}</dd>
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
      <dt className="min-w-[7rem] text-text-3">{label}</dt>
      <dd className="min-w-0 flex-1 leading-relaxed text-text-2">{children}</dd>
    </div>
  );
}

/** 이름 붙은 글 한 단락. 값이 없으면 "—". */
function Text({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="text-xs">
      <p className="text-text-3">{label}</p>
      <p className="whitespace-pre-wrap leading-relaxed text-text-2">{value || EMPTY}</p>
    </div>
  );
}

/** 상세 안의 한 부분 — 제목이 영역 이름이 되어(aria-label) 표마다 따로 찾을 수 있습니다(결정 로그 탭과 같은 모양).
 * 제목은 검사 칸(결정 상세) 안이면 칸 제목 바로 아래 단계(옆 칸 h4·대화상자 h3), 밖(시작 카드 미리보기 — 패널 제목 h2 안)이면 h3(InspectorSubheading). */
function Part({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <InspectorSubheading fallback="h3" className="text-sm font-semibold text-text">{title}</InspectorSubheading>
      {note && <p className="text-xs leading-relaxed text-text-3">{note}</p>}
      {children}
    </section>
  );
}

/** lib 배지 목록 → 공용 태그(PaperBadge — 20px, 주의는 아이콘 + 낭독 '주의: '). 배지 글은 줄을 바꾸지 않고 배지 사이만 꺾습니다. */
function Badges({ badges }: { badges: Badge[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1 whitespace-nowrap">
      {badges.map((badge) => <PaperBadge key={badge.key} badge={badge} />)}
    </span>
  );
}
