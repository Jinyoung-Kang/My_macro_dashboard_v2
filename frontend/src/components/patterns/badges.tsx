import type { JSX } from "react";

import { estimateLabel, presentText, provenanceText } from "@/lib/patterns";

/*
 * 상태 배지 세 가지(설계서 §5) — 작은 알약 모양에 늘 글자 라벨이 있습니다(색만으로 뜻을 전하지 않음).
 * 플래그가 있으면 반드시 보입니다. 숨기는 옵션은 두지 않습니다.
 * 바탕은 칠하지 않고 놓인 자리(surface·bg)를 그대로 씁니다 — 옅은 바탕을 깔면 경고색 글자 대비가 4.5:1 근처로 떨어집니다.
 */
const PILL = "inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-full border px-2 py-0.5 text-xs leading-4";

/**
 * 출처 배지 — "출처 · 실시간|N분 지연 · 시각". 모르는 부분은 빼고, 전부 모르면 "출처 —".
 *
 * @param asOf 표시용 시각(KST). ISO가 와도 `formatKst`로 같은 형식에 맞춥니다.
 * @param live 참이면 지연 분과 상관없이 "실시간"
 */
export function ProvenanceBadge({
  source,
  asOf,
  delayMin,
  live,
}: {
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
}): JSX.Element | null {
  return (
    <span className={`${PILL} border-border tabular-nums text-text-3`}>
      {provenanceText({ source, asOf, delayMin, live })}
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
