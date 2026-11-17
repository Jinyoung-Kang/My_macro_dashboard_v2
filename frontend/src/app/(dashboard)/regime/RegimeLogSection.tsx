"use client";

import { Fragment } from "react";
import { type PropertyItem, PropertyList, Timeline, type TimelineEntry, TimelineSkeleton } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, Panel } from "@/components/ui";
import { LineIcon, LockIcon } from "@/components/ui/icons";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { EMPTY } from "@/lib/format";
import { regimeInputCells, regimeLogSummaryParts } from "@/lib/regime";
import { SOURCES } from "@/lib/sources";
import type { RegimeLogEntry, RegimeLogResponse } from "@/lib/types";
import { regimeKind } from "./RegimeTag";

/** 검사 칸 — 근거 넷(값·기준일)·판정 불가 사유·규칙 판(고정폭). 모르는 값은 —(0으로 채우지 않음). */
function entryProperties(entry: RegimeLogEntry): PropertyItem[] {
  const inputs: PropertyItem[] = regimeInputCells(entry.inputs).map((cell) => ({
    key: cell.key,
    label: cell.label,
    value: cell.value,
    note: cell.asOfDate ? `기준일 ${cell.asOfDate}` : null,
  }));
  return [
    ...inputs,
    // 사유는 길고(입력 오래됨: 이름 (기준일, n일 전)) 여럿이라 이름 위·값 아래(block) 한 줄에 하나씩.
    {
      label: "판정 불가 사유",
      block: true,
      value:
        entry.missing.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {entry.missing.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          "없음"
        ),
    },
    { label: "규칙 판", value: entry.ruleVersion || null, mono: true },
  ];
}

/** 판정 기록 요청 한도 — 열 때 한 번 읽는 최근 기록 수(무료 등급은 서버가 30건으로 줄임). */
const LOG_LIMIT = 60;

/**
 * 판정 기록을 읽는 동안 잡아 두는 목록 자리 줄 수(QA-651) — 자리일 뿐 보이는 수가 아닙니다. 판정 기록은 하루 한 건씩 쌓여 요청 한도까지 차므로(열흘이
 * 지나면 실제 목록이 이보다 김), 이만큼 잡으면 lg(1024~1279 — 오른쪽 칸이 가운데 아래)의 '연결'·'출처' 패널이 처음부터 화면 아래에 있어 값이 와도
 * 화면 안에서 밀리지 않습니다(예전 막대 네 줄 88px — 1024 x 900에서 '연결' 위 끝 797 → 1,743px, 첫 적재 CLS 0.053). 기록이 이보다 적으면 목록이 줄어듭니다.
 */
const LOG_PENDING_ROWS = 10;

/**
 * 줄 요약 — 마디(이름 값)를 ' · '로 잇고 마디 안에서는 줄을 바꾸지 않습니다. 가운뎃점은 앞 마디에 붙여(줄 끝에 남고) 다음 줄이 '·'로 시작하지 않게 합니다.
 */
function Summary({ parts }: { parts: readonly string[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? " " : null}
          <span className="whitespace-nowrap">{index < parts.length - 1 ? `${part} ·` : part}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * 판정 기록 — 그날 화면에 보인 판정을 하루 한 건씩 남긴 것(추가만, 고치지 않음).
 *
 * "국면 이력" 탭은 같은 규칙을 과거에 다시 적용한 재현이고, 이 목록은 **실제로 낸 판정**입니다.
 * 판정 성과를 말할 때 "나중에 맞춰 고친 것 아니냐"에 답하는 근거가 이 기록입니다.
 *
 * 시각순 목록(Timeline — 작업대 P5a, 처음 쓰는 곳): 줄마다 날짜·국면 태그(톤 + 아이콘 + 이름)·근거 넷 한 줄(판정하지 못한 날은 판정 불가 사유 수),
 * 고르면 검사 칸(넓은 화면 옆 — 처음엔 가장 최근 줄)이나 대화상자(좁은 화면)에 근거 넷의 값·기준일과 판정 불가 사유·규칙 판.
 * 목록은 열 때 한 번 읽은 응답만 씁니다 — 고르기는 요청을 더하지 않습니다.
 */
export function RegimeLogSection() {
  const log = useApi<RegimeLogResponse>(endpoints.insight.regimeLog(LOG_LIMIT), 600_000);
  const { data, error, reload, refreshError } = log;
  const rows = data?.available ? (data.entries ?? []) : [];
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const entries: TimelineEntry[] = rows.map((row) => ({
    key: row.date,
    at: row.date,
    dateTime: row.date,
    kind: regimeKind(row.code, row.label),
    summary: <Summary parts={regimeLogSummaryParts(row)} />,
    title: `${row.date} 판정 — ${row.label}`,
  }));
  // 기록 시각(KST 시) — 응답에 없으면 시각 마디를 뺍니다(18시처럼 지어내지 않음 — QA-647).
  const hour = typeof data?.recordHourKst === "number" && Number.isFinite(data.recordHourKst) ? data.recordHourKst : null;
  // 응답 전에는 목록 대신 자리표시 — 읽기가 실패했으면 오류 상자와 다시 시도, 처음 읽는 동안은 목록 꼴 자리 줄(빈 목록 글이 잠깐 비치지 않게, 목록 높이를
  // 잡음 — QA-651), 실패 뒤 다시 읽는 동안은 한 줄(오류 상자와 자리 줄 열 개가 갱신마다 번갈아 그려지지 않게 — QA-655).
  const placeholder = data ? null : error ? (
    <ErrorState message={error} onRetry={reload} />
  ) : firstLoadPending(log) ? (
    <TimelineSkeleton rows={LOG_PENDING_ROWS} label="판정 기록을 읽는 중" />
  ) : (
    <Loading label="판정 기록을 읽는 중…" />
  );

  return (
    <Panel
      title="판정 기록"
      source={SOURCES.regimeLog}
      subtitle={
        data?.available
          ? `${data.startedOn ?? EMPTY}부터 ${typeof data.count === "number" ? data.count.toLocaleString("ko-KR") : EMPTY}건 · 매일 ${hour === null ? "" : `KST ${hour}시 이후 `}한 건`
          : "그날 화면에 보인 판정을 하루 한 건씩 남깁니다"
      }
      // 자동 갱신이 실패하면 앞서 받은 값을 그대로 보이므로 '새로 읽지 못함'을 붙입니다(QA-104, QA-067과 같음).
      actions={<Freshness refreshError={refreshError} />}
    >
      {data && !data.available ? (
        <Callout tone="warn">{data.message}</Callout>
      ) : (
        <Timeline
          label="판정 기록"
          entries={entries}
          autoSelectFirst
          placeholder={placeholder}
          emptyText={hour === null ? "아직 기록이 없습니다. 기록은 하루 한 건씩 생깁니다." : `아직 기록이 없습니다. 첫 기록은 KST ${hour}시 이후에 생깁니다.`}
          inspectorHint="줄을 고르면 이 칸에 근거 넷의 값·기준일과 판정 불가 사유가 나옵니다(j/k·↑↓로 옮김)."
          renderDetail={(entry) => {
            const row = byDate.get(entry.key);
            return row ? <PropertyList items={entryProperties(row)} /> : null;
          }}
        />
      )}
      {data?.available && data.note && <p className="mt-2 break-keep text-xs text-text-3">{data.note}</p>}
      {data?.available && data.limitedTo ? (
        <p className="mt-1 flex items-start gap-1 text-xs text-text-3">
          {/* 장식 — 뜻은 옆의 글이 나릅니다. */}
          <LineIcon>
            <LockIcon size={12} />
          </LineIcon>
          <span className="break-keep">무료 등급은 최근 {data.limitedTo}건만 보입니다. 유료 등급은 기록 전체를 봅니다.</span>
        </p>
      ) : null}
    </Panel>
  );
}
