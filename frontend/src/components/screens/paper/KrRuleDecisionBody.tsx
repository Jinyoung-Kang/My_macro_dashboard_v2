"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Table } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import type { Badge } from "@/lib/paper";
import {
  type KrCell,
  type KrDecisionExtras,
  type KrEventRow,
  krEventsView,
  type KrGateRow,
  type KrRuleDecisionView,
} from "@/lib/paperKr";
import { paperTabPath } from "@/lib/paperRoutes";

/**
 * 한국 규칙 계좌(kr_rules) 결정의 본문(2단계 명세 §4-6·§4-9·§4-16 F2) — 자료 게이트 ①~⑥·기한 지남·출발 칸({@link KrDecisionExtrasParts}),
 * 선정 요약(재선정일·주기·선정 기준일·따라잡기·주식/153130 비중·후보 수)과 목표·후보·제외 표, 보유 매도 판정, 고르지 못한 주문, 처리 메모('지금은
 * 체결할 수 없음' 등 서버 문장 그대로), 입력 요약. 값은 lib/paperKr krRuleDecisionView가 고른 글자 그대로입니다(ADR 0004).
 */
export function KrRuleDecisionBody({ view }: { view: KrRuleDecisionView }) {
  return (
    <div className="flex flex-col gap-4">
      <KrDecisionExtrasParts extras={view.extras} />

      {view.selection.length > 0 && (
        <Part title="선정" note={view.selectionNote ?? "재선정일·출발 때만 아래 목표대로 삽니다(점수 = 외국인·기관 20일 순매수 합 ÷ 상장주식수)."}>
          <Cells cells={view.selection} />
          {view.targets.length > 0 && (
            <Table
              label="목표"
              rows={view.targets}
              rowKey={(row) => row.key}
              columns={[
                { key: "rank", header: "순서", align: "right", render: (row) => row.rank },
                { key: "code", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.code}</span> },
                { key: "score", header: "점수", align: "right", render: (row) => row.score },
                { key: "weight", header: "목표 비중", align: "right", render: (row) => row.weight },
              ]}
            />
          )}
        </Part>
      )}

      {(view.candidates.length > 0 || view.exclusions.length > 0) && (
        <Part
          title="후보"
          note={`점수 순(매일 셈 — 재선정일이 아니면 참고)${view.candidatesMore > 0 ? ` · 앞 ${view.candidates.length}종목, ${view.candidatesMore}종목 더` : ""}`}
        >
          {view.exclusions.length > 0 && (
            <p className="text-xs text-body">제외 — {view.exclusions.map((row) => `${row.reason} ${row.count}`).join(" · ")}</p>
          )}
          <details className="rounded-md border border-border px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted">후보 표 보기</summary>
            <div className="mt-2">
              <Table
                label="후보"
                rows={view.candidates}
                rowKey={(row) => row.key}
                emptyMessage="후보가 없습니다 — 외국인·기관 20일 순매수가 둘 다 0보다 큰 U 종목이 없었습니다."
                columns={[
                  { key: "code", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.code}</span> },
                  { key: "rank", header: "U 순위", align: "right", render: (row) => row.rank },
                  { key: "score", header: "점수", align: "right", render: (row) => row.score },
                ]}
              />
            </div>
          </details>
        </Part>
      )}

      {view.holdings.length > 0 && (
        <Part title="보유 매도 판정" note="보유마다 그날 매도 판정 — 20일 누적이 둘 다 0보다 작거나 재선정일 후보 밖이면 팝니다(현금성 제외).">
          <Table
            label="보유 매도 판정"
            rows={view.holdings}
            rowKey={(row) => row.key}
            columns={[
              { key: "code", header: "종목", render: (row) => <span className="font-semibold text-bright">{row.code}</span> },
              { key: "qty", header: "수량(주)", align: "right", render: (row) => row.qty },
              { key: "weight", header: "비중", align: "right", render: (row) => row.weight },
              { key: "sell", header: "판정", render: (row) => <span className={row.sell === "매도" ? "text-down" : "text-body"}>{row.sell}</span> },
              { key: "reasons", header: "사유", render: (row) => <span className="text-xs text-body">{row.reasons}</span> },
            ]}
          />
        </Part>
      )}

      {view.skipped.length > 0 && (
        <Part title="고르지 못한 주문" note="계획했지만 주문을 내지 않은 종목과 서버가 남긴 사유입니다.">
          <Table
            label="고르지 못한 주문"
            rows={view.skipped}
            rowKey={(row) => row.key}
            columns={[
              { key: "ticker", header: "종목", render: (row) => row.ticker },
              { key: "reason", header: "사유", render: (row) => <span className="text-xs text-body">{row.reason}</span> },
            ]}
          />
        </Part>
      )}

      {view.notes.length > 0 && (
        <Part title="처리 메모" note="서버 문장 그대로 — '지금은 체결할 수 없음'은 정지·기업행위 보류 보유의 매도 주문이 남는 까닭(그동안 그 계좌 순자산 줄은 잠정)입니다.">
          <ul aria-label="결정 메모" className="list-disc space-y-0.5 pl-5 text-xs text-body">
            {view.notes.map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}
          </ul>
        </Part>
      )}

      {view.input.length > 0 && (
        <Part title="입력" note="결정이 읽은 자료 — 금융위원회(공공데이터포털) 유니버스·토스증권 수급·금융감독원 DART 재무.">
          <Cells cells={view.input} />
        </Part>
      )}
    </div>
  );
}

/**
 * 한국 결정의 공통 칸 — 기한 지남(기한·판정 근거·판정 시각·기다린 게이트·사유), 출발(설정 출발일·미룸·출발 호출 수), 자료 게이트 ①~⑥ 표.
 * ③의 창 구멍 문구(임시휴장이면 kr.calendar.extraClosures에 더함)가 있으면 설정 탭 링크를 붙입니다. 규칙·Claude 계좌가 함께 씁니다.
 */
export function KrDecisionExtrasParts({ extras }: { extras: KrDecisionExtras }) {
  const past = extras.pastDeadline;
  const start = extras.start;
  return (
    <>
      {past && (
        <Part title="기한 지남" note="결정 기한이 지나 그 세션은 결정하지 않았습니다 — 아래는 기한 전 마지막 판정(작업 기록에 남은 값)입니다.">
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Cell label="기한" value={past.deadline} />
            <Cell label="판정 근거" value={past.basis ?? EMPTY} />
            <Cell label="판정 시각" value={past.judgedAt ?? EMPTY} />
          </dl>
          {past.reason && <p className="text-xs text-warn">사유 — {past.reason}</p>}
          {past.waitedFor.length > 0 ? (
            <ul aria-label="기다린 게이트" className="list-disc space-y-0.5 pl-5 text-xs text-body">
              {past.waitedFor.map((gate) => <li key={gate}>{gate}</li>)}
            </ul>
          ) : (
            <p className="text-xs text-muted">기다린 게이트 — {EMPTY}(그 세션 판정 기록 없음 — 기한 뒤 첫 실행이었거나 일시정지)</p>
          )}
        </Part>
      )}

      {start && (
        <Part title="출발" note="한국 네 계좌는 출발일 밤 결정으로 함께 다음 KR 거래일 시가에 출발합니다 — 미뤄졌으면 실제 출발일은 이 결정의 기준 거래일입니다.">
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <Cell label="설정 출발일" value={start.configuredStartDate} />
            <Cell label="미룸" value={start.postponed === true ? "예(설정 출발일보다 늦게 출발)" : start.postponed === false ? "아니오" : EMPTY} />
            {start.startCalls !== null && <Cell label="출발 호출 수(Claude)" value={`${start.startCalls}회`} />}
          </dl>
        </Part>
      )}

      {extras.gates.length > 0 && (
        <Part title="자료 게이트" note="① 앞 주문 정리 · ② 관측치 · ③ U 수급 · ④ 금융위 기준일 · ⑤ 069500 D 봉 · ⑥ KRX 거래일 — 판정 문장은 서버 그대로입니다.">
          <KrGateTable rows={extras.gates} label="자료 게이트" />
        </Part>
      )}
    </>
  );
}

/** 자료 게이트 표 — 통과·미달 배지와 서버 문장. ③의 창 구멍 문구가 있으면 설정 탭(kr.calendar.extraClosures) 링크를 붙입니다. */
export function KrGateTable({ rows, label }: { rows: KrGateRow[]; label: string }) {
  return (
    <Table
      label={label}
      rows={rows}
      rowKey={(row) => row.key}
      columns={[
        { key: "gate", header: "게이트", className: "whitespace-nowrap", render: (row) => <span className="font-semibold text-bright">{row.gate}</span> },
        { key: "status", header: "판정", className: "whitespace-nowrap", render: (row) => <Badges badges={[row.badge]} /> },
        {
          key: "note",
          header: "판정 문장",
          render: (row) => (
            <span className="text-xs text-body">
              {row.note}
              {row.extraClosures && (
                <>
                  {" "}
                  <Link href={paperTabPath("settings", "KR")} className="text-accent underline underline-offset-2">
                    설정 탭에서 kr.calendar.extraClosures 보기
                  </Link>
                </>
              )}
            </span>
          ),
        },
      ]}
    />
  );
}

/**
 * 한국 Claude 결정 패킷의 사건 줄(11b_events) — 창·시각 문구와 줄(번호·출처·시각·걸린 이유). 시각이 창 시작보다 앞인 줄은 '창 앞 시각 — 결정 순간
 * 뒤(창 안)에 받은 제목'으로 표시합니다(블록 시각은 발행 시각). 제목은 패킷 글에만 있어 펼쳐 봅니다. 섹션이 없으면 그리지 않습니다.
 */
export function KrEventsPart({ packet }: { packet: unknown }) {
  const events = krEventsView(packet);
  if (!events) return null;
  return (
    <Part title="사건 줄(패킷 11b_events)" note={`창 ${events.window}${events.timeNote ? ` · ${events.timeNote}` : ""}`}>
      <Table<KrEventRow>
        label="사건 줄"
        rows={events.rows}
        rowKey={(row) => row.key}
        emptyMessage="걸린 사건이 없습니다(패킷 글 참고)."
        columns={[
          { key: "k", header: "번호", render: (row) => row.k },
          { key: "source", header: "출처", render: (row) => <span className="whitespace-nowrap text-xs">{row.source}</span> },
          {
            key: "when",
            header: "시각",
            render: (row) => (
              <span className="flex flex-col text-xs">
                <span className="whitespace-nowrap">{row.when}</span>
                {row.beforeWindow && <span className="text-[11px] text-warn">창 앞 시각 — 결정 순간 뒤(창 안)에 받은 제목</span>}
              </span>
            ),
          },
          { key: "matched", header: "걸린 이유", render: (row) => <span className="text-xs text-body">{row.matched}</span> },
        ]}
      />
      {events.text && (
        <details className="rounded-md border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted">사건 패킷 글(제목)</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{events.text}</pre>
        </details>
      )}
    </Part>
  );
}

function Cells({ cells }: { cells: KrCell[] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {cells.map((cell) => <Cell key={cell.key} label={cell.label} value={cell.value} />)}
    </dl>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums font-semibold text-bright">{value}</dd>
    </div>
  );
}

/** 상세 안의 한 부분 — 결정 로그 탭과 같은 모양(제목 h3이 영역 이름). */
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
        <span key={badge.key} title={badge.title} className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}>
          {badge.label}
        </span>
      ))}
    </span>
  );
}
