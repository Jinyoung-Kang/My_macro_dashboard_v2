"use client";

import { PropertyList } from "@/components/patterns";
import { Button, Callout, EmptyState, ErrorState, Panel } from "@/components/ui";
import { SkipIcon, StatusText, type StatusTone } from "@/components/ui/icons";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { EMPTY, formatKst, formatNumber } from "@/lib/format";
import type { VerificationResponse, VerificationResult } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 판정의 톤 — 일치 정상·불일치 위험·확인 못 함(건너뜀) 중립(건너뜀 아이콘)·오류 주의. 판정 글(entry.label)이 뜻을 나르고 아이콘·색은 보조입니다(색만 아님).
 * 모르는 판정은 중립(점선 원)입니다 — 일치로 지어내지 않습니다.
 */
const VERDICT_TONE: Record<VerificationResult["verdict"], StatusTone> = {
  match: "ok",
  mismatch: "danger",
  skipped: "neutral",
  error: "warn",
};

/** 판정 줄 — 아이콘 + 판정 글(+ 차이). 낭독 머리말은 상태 글 기본(위험 '오류: '·주의 '주의: '). */
function Verdict({ entry }: { entry: VerificationResult }) {
  const tone = VERDICT_TONE[entry.verdict] ?? "neutral";
  return (
    <StatusText tone={tone} icon={entry.verdict === "skipped" ? <SkipIcon size={14} /> : undefined} className="text-xs font-semibold">
      {entry.label}
      {entry.diffPct !== null && ` · 차이 ${entry.diffPct.toFixed(3)}%`}
    </StatusText>
  );
}

/**
 * 데이터 교차 검증(KRX · KIS · 토스) — 머리 '지금 교차 검증 실행'(POST /api/verification, 본문 없음 — 누를 때만)을 누르면 항목마다 판정(아이콘 + 글)과
 * 출처별 읽은 값(속성 목록)을 보입니다. '확인 못 함'과 '일치'는 섞지 않습니다.
 */
export function VerificationPanel() {
  const verification = useAsyncAction(
    () => apiPost<VerificationResponse>(endpoints.status.verification),
    "검증에 실패했습니다.",
  );
  const { result, error, busy: running } = verification;
  const run = () => verification.run();

  return (
    <Panel
      title="데이터 교차 검증 (KRX · KIS · 토스)" source="KRX Open API · 한국투자증권(KIS) Open API · 토스증권 Open API · Yahoo Finance (항목별 출처는 표 안에)"
      subtitle="같은 수치를 서로 다른 출처가 같게 말하는지 대조합니다. '확인 못 함'과 '일치'는 절대 섞지 않습니다."
      actions={
        <Button variant="primary" onClick={run} disabled={running}>
          {running ? "검증 중…" : "지금 교차 검증 실행"}
        </Button>
      }
    >
      {error && <ErrorState message={error} />}
      {!result && !error && (
        <EmptyState message="아직 실행하지 않았습니다. 시세 대조는 장 마감 후, 수급 대조는 정규장 중에만 가능합니다." />
      )}

      {result && !result.available && <Callout tone="warn">{result.message}</Callout>}

      {result?.available && (
        <>
          <p className="mb-3 text-sm text-text-2">
            {result.headline} · 검증 시각 {formatKst(result.checkedAt)}
          </p>
          <ul className="flex flex-col gap-3">
            {result.results?.map((entry) => (
              <li key={entry.name} className="rounded-control border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="break-keep text-sm font-medium text-text">{entry.name}</span>
                  <Verdict entry={entry} />
                </div>
                {entry.readings.length > 0 && (
                  <div className="mt-2">
                    <PropertyList
                      dense
                      items={entry.readings.map((reading) => ({
                        key: reading.source,
                        label: reading.source,
                        value: reading.ok
                          ? `${formatNumber(reading.value, 2)}${reading.detail ? ` (${reading.detail})` : ""}`
                          : `실패: ${reading.detail ?? EMPTY}`,
                      }))}
                    />
                  </div>
                )}
                {entry.note && <p className="mt-2 break-keep text-xs text-text-3">{entry.note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
