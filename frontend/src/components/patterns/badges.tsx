import type { JSX } from "react";

import { PROVENANCE_UNKNOWN, estimateLabel, presentText, provenanceText } from "@/lib/patterns";

/*
 * 상태 표시 세 가지(설계서 §5) — 늘 글자 라벨이 있습니다(색만으로 뜻을 전하지 않음).
 * 추정·이전 값은 플래그라 작은 알약(배지)으로, 출처는 늘 붙는 설명이라 작은 캡션 줄로 그립니다.
 * 플래그가 있으면 반드시 보입니다. 숨기는 옵션은 두지 않습니다.
 * 바탕은 칠하지 않고 놓인 자리(surface·bg)를 그대로 씁니다 — 옅은 바탕을 깔면 경고색 글자 대비가 4.5:1 근처로 떨어집니다.
 */
const PILL = "inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full border px-2 py-0.5 text-xs leading-4";

/**
 * 출처 캡션 — "출처 · 실시간|N분 지연 · 시각"을 작은 글(12px, text-3)로. 모르는 부분은 빼고, 전부 모르면 "출처 —".
 *
 * 테두리·알약 없이 글만 둡니다 — 긴 출처("TradingView (TVC:DXY) · 개장 · 실시간 · …")가 알약 안에서 두 줄로 접혀 어색했습니다.
 * 길면 그대로 줄을 바꿉니다. 보이는 글에는 "출처"라는 말이 없으므로 낭독기에는 앞에 "출처:"를 읽힙니다(전부 모를 때는 이미 있음).
 *
 * @param asOf 표시용 시각(KST). ISO가 와도 `formatKst`로 같은 형식에 맞춥니다.
 * @param live 참이면 지연 분과 상관없이 "실시간"
 * @param title 마우스를 올리면 보이는 보조 설명(설계서 §1.5 계약에 더한 선택 prop) — 닫힌 장의 시세 지연처럼 글에는 적지 않는 것
 *              (ADR 0017 결정 6, /macro의 장 상태 배지와 같음). 뜻을 나르는 내용은 여기에만 두지 않습니다.
 */
export function ProvenanceBadge({
  source,
  asOf,
  delayMin,
  live,
  title,
}: {
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
  title?: string | null;
}): JSX.Element | null {
  const text = provenanceText({ source, asOf, delayMin, live });
  return (
    <span title={presentText(title) ?? undefined} className="min-w-0 max-w-full text-xs leading-4 tabular-nums text-text-3">
      {text === PROVENANCE_UNKNOWN ? null : <span className="sr-only">출처: </span>}
      {text}
    </span>
  );
}

/**
 * 추정·대리 지표 배지 — "추정" / "대리 지표"(+ 설명). 둘 다 아니면 그리지 않습니다.
 * 점선 테두리로 '실측이 아님'을 한 번 더 보입니다(글자가 본 뜻이고 테두리는 보조).
 */
export function EstimateBadge({
  estimated,
  proxy,
  note,
}: {
  estimated?: boolean;
  proxy?: boolean;
  note?: string | null;
}): JSX.Element | null {
  const label = estimateLabel(estimated, proxy);
  if (label === null) {
    return null;
  }
  const detail = presentText(note);
  return (
    <span className={`${PILL} border-dashed border-text-3 text-text-2`}>
      <span className="font-medium">{label}</span>
      {detail ? <span>· {detail}</span> : null}
    </span>
  );
}

/**
 * 오래된·이어받은 값 배지 — "⚠️ 이전 값"(경고색) + 사유. stale이 아니면 그리지 않습니다.
 * 수집에 실패해 직전 저장본의 값을 보일 때(isStale·이어받은 값) 씁니다.
 */
export function StaleBadge({ stale, reason }: { stale?: boolean; reason?: string | null }): JSX.Element | null {
  if (!stale) {
    return null;
  }
  const detail = presentText(reason);
  return (
    <span className={`${PILL} border-warn text-warn`}>
      <span aria-hidden="true">⚠️</span>
      <span className="sr-only">주의: </span>
      <span className="font-medium">이전 값</span>
      {detail ? <span>· {detail}</span> : null}
    </span>
  );
}
