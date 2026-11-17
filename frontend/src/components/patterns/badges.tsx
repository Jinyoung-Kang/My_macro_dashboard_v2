import type { JSX } from "react";

import { AlertTriangleIcon } from "@/components/ui/icons";
import { PROVENANCE_UNKNOWN, dateTokenParts, estimateLabel, presentText, provenanceText } from "@/lib/patterns";

/*
 * 상태 표시 세 가지(설계서 §5) — 늘 글자 라벨이 있습니다(색만으로 뜻을 전하지 않음).
 * 추정·이전 값은 플래그라 작은 태그(배지)로, 출처는 늘 붙는 설명이라 작은 캡션 줄로 그립니다.
 * 플래그가 있으면 반드시 보입니다. 숨기는 옵션은 두지 않습니다.
 * 추정 배지·출처 캡션은 바탕을 칠하지 않고 놓인 자리(surface·bg)를 그대로 씁니다. 이전 값 배지만 경고 틴트(warn-tint) 바탕입니다 —
 * surface와 미리 섞은 불투명 색이라 어디에 놓여도 경고색 글자 대비가 같습니다(6.1:1, 작업대 실행 명세 §3-2). 투명 틴트(bg-warn/10)는 쓰지 않습니다.
 * 모양은 4px 태그(명세 §6 Tag — 정보 검색의 꼬리표와 같은 12px 글·좌우 6px 여백·위아래 1px, 한 줄이면 높이 20px — 표 칸 글줄과 같아 행이 32·28px 그대로,
 * 2026-11-16 결정, 글 흐름 안에서는 줄 위에 맞춤 — ui Tag와 같은 까닭)입니다. 알약(rounded-full)이 아닌 까닭은 처음부터 그대로입니다 —
 * 사유가 길어 좁은 화면에서 두세 줄로 접히면 rounded-full은 타원이 되어 글이 모서리에 걸렸습니다(홈 모의매매 히어로·계좌 행, 390px).
 * 안은 flex가 아니라 글 흐름(inline-block)입니다 — flex 줄바꿈은 사유를 통째로 다음 줄로 넘겨 둘째 줄이 '· 관측치 …'처럼 가운뎃점으로
 * 시작했습니다(홈 1280px 계좌 행). 글 흐름이면 첫 줄을 채운 뒤 사유 중간에서 줄을 바꿉니다.
 * 한글은 낱말 사이에서만 줄을 바꾸고(break-keep — 좁은 칸에서 '저장본이 늦|음'처럼 음절 사이가 갈렸음, QA-568), 공백 없는 긴 영문·날짜만 칸 안에서
 * 꺾습니다(wrap-break-word). wrap-anywhere가 아닌 까닭: 배지가 자동 배치 표 칸에도 들어가 anywhere는 칸의 최소 폭을 한 글자로 줄입니다(QA-526과 같음).
 */
const TAG = "inline-block max-w-full break-keep wrap-break-word rounded-control border px-1.5 py-px align-top text-xs leading-4";

/**
 * 출처 캡션 — "출처 · 실시간|N분 지연 · 시각"을 작은 글(12px, text-3)로. 모르는 부분은 빼고, 전부 모르면 "출처 —".
 *
 * 테두리·태그 없이 글만 둡니다 — 긴 출처("TradingView (TVC:DXY) · 개장 · 실시간 · …")가 알약 안에서 두 줄로 접혀 어색했습니다.
 * 길면 그대로 줄을 바꿉니다 — 한글은 낱말 사이에서만(break-keep), 공백 없는 긴 토큰만 칸 안에서(wrap-break-word — 이전 값 배지와 같은 까닭, QA-568).
 * 보이는 글에는 "출처"라는 말이 없으므로 낭독기에는 앞에 "출처:"를 읽힙니다(전부 모를 때는 이미 있음).
 *
 * @param asOf 표시용 시각(KST). ISO가 와도 `formatKst`로 같은 형식에 맞춥니다.
 * @param live 참이면 지연 분과 상관없이 "실시간"
 * @param title 마우스를 올리면 보이는 보조 설명(설계서 §1.5 계약에 더한 선택 prop) — 닫힌 장의 시세 지연처럼 글에는 적지 않는 것
 *              (ADR 0017 결정 6, /macro의 장 상태 배지와 같음). 뜻을 나르는 내용은 여기에만 두지 않습니다.
 * @param keepDates 참이면 날짜·시각 마디('2026-11-04 06:31')를 줄바꿈 없는 묶음으로 — 좁은 칸에서 '2026-11-' / '04'처럼 날짜 안에서 꺾이지 않고 마디
 *              사이에서만 꺾입니다(선택 prop, 기본 꺼짐 — 홈·상세의 배지 그대로. 시장 화면의 표 칸·대상 머리가 씀, P5a 검토).
 */
export function ProvenanceBadge({
  source,
  asOf,
  delayMin,
  live,
  title,
  keepDates = false,
}: {
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
  title?: string | null;
  keepDates?: boolean;
}): JSX.Element | null {
  const text = provenanceText({ source, asOf, delayMin, live });
  return (
    <span title={presentText(title) ?? undefined} className="min-w-0 max-w-full break-keep wrap-break-word text-xs leading-4 tabular-nums text-text-3">
      {text === PROVENANCE_UNKNOWN ? null : <span className="sr-only">출처: </span>}
      {keepDates
        ? dateTokenParts(text).map((part, index) =>
            part.date ? (
              <span key={index} className="whitespace-nowrap">
                {part.text}
              </span>
            ) : (
              part.text
            ),
          )
        : text}
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
    <span className={`${TAG} border-dashed border-text-3 text-text-2`}>
      <span className="font-medium">{label}</span>
      {detail ? <> <span>· {detail}</span></> : null}
    </span>
  );
}

/**
 * 오래된·이어받은 값 배지 — 경고 아이콘 + "이전 값"(경고색) + 사유. stale이 아니면 그리지 않습니다.
 * 수집에 실패해 직전 저장본의 값을 보일 때(isStale·이어받은 값) 씁니다.
 */
export function StaleBadge({ stale, reason }: { stale?: boolean; reason?: string | null }): JSX.Element | null {
  if (!stale) {
    return null;
  }
  const detail = presentText(reason);
  return (
    <span className={`${TAG} border-warn/30 bg-warn-tint text-warn`}>
      {/* 글 흐름 안의 아이콘 — 12px 글 가운데에 오게 조금 내립니다. */}
      <AlertTriangleIcon size={12} className="mr-1 inline align-[-2px]" />
      <span className="sr-only">주의: </span>
      <span className="font-medium">이전 값</span>
      {detail ? <> <span>· {detail}</span></> : null}
    </span>
  );
}
