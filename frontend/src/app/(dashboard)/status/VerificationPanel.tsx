"use client";

import { Banner, Button, Card, EmptyState, ErrorState } from "@/components/ui";
import { AlertTriangleIcon, CheckCircleIcon, SkipIcon, XCircleIcon } from "@/components/ui/icons";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { EMPTY, formatKst, formatNumber } from "@/lib/format";
import type { VerificationResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

const VERDICT_STYLE: Record<string, string> = {
  match: "text-ok",
  mismatch: "text-danger",
  skipped: "text-text-3",
  error: "text-warn",
};

/** 판정 아이콘 — 장식입니다. 뜻은 바로 옆에 보이는 판정 글(entry.label)이 나릅니다. */
const VERDICT_ICON: Record<string, typeof CheckCircleIcon> = {
  match: CheckCircleIcon,
  mismatch: XCircleIcon,
  skipped: SkipIcon,
  error: AlertTriangleIcon,
};

function VerdictIcon({ verdict }: { verdict: string }) {
  const Icon = VERDICT_ICON[verdict];
  return Icon ? <Icon size={14} className={VERDICT_STYLE[verdict]} /> : null;
}

export function VerificationPanel() {
  const verification = useAsyncAction(
    () => apiPost<VerificationResponse>(endpoints.status.verification),
    "검증에 실패했습니다.",
  );
  const { result, error, busy: running } = verification;
  const run = () => verification.run();

  return (
    <Card
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

      {result && !result.available && <Banner tone="warn">{result.message}</Banner>}

      {result?.available && (
        <>
          <p className="mb-3 text-sm text-text-2">
            {result.headline} · 검증 시각 {formatKst(result.checkedAt)}
          </p>
          <div className="flex flex-col gap-3">
            {result.results?.map((entry) => (
              <div key={entry.name} className="rounded-control border border-border bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm text-text">
                    <VerdictIcon verdict={entry.verdict} />
                    {entry.name}
                  </span>
                  <span className={`text-xs font-semibold ${VERDICT_STYLE[entry.verdict]}`}>
                    {entry.label}
                    {entry.diffPct !== null && ` · 차이 ${entry.diffPct.toFixed(3)}%`}
                  </span>
                </div>
                {entry.readings.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 text-xs text-text-3">
                    {entry.readings.map((reading) => (
                      <li key={reading.source} className="flex justify-between gap-3">
                        <span>{reading.source}</span>
                        <span className="tabular-nums">
                          {reading.ok
                            ? `${formatNumber(reading.value, 2)}${
                                reading.detail ? ` (${reading.detail})` : ""
                              }`
                            : `실패: ${reading.detail ?? EMPTY}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {entry.note && <p className="mt-2 text-xs text-text-3">{entry.note}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
