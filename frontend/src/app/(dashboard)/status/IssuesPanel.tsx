"use client";

import { CopyButton } from "@/components/CopyButton";
import { KpiStrip, LogPanel, type KpiItem } from "@/components/patterns";
import { Button, Callout, ErrorState, Freshness, Loading, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import type { StatusIssuesResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 수집 오류·경고 로그 — 문제만 모아 한 덩어리 텍스트로.
 *
 * 표는 태스크별 "최근 결과"만 보여 주고 긴 사유는 잘립니다. 문제를 누군가에게 보여
 * 주려면 스크린샷 여러 장이 필요했습니다. 여기서는 백엔드가 만든 텍스트를 그대로
 * 보여 주고 한 번에 복사합니다(비밀값은 백엔드에서 가려져 옵니다).
 *
 * 작업대 P7: 위에 KPI 띠 '오류·경고'(현재 오류·현재 경고·최근 실패 유형·누락 데이터셋), 아래 공용 로그 상자(LogPanel — 고정폭 12/20, 30rem에서 상자 안 스크롤,
 * 이름 있는 영역 '수집 오류·경고 로그 (스크롤)'). 머리 동작(신선도·새로고침 GET·로그 복사)은 그대로입니다.
 */
export function IssuesPanel() {
  const { data, loading, error, reload, refreshError } = useApi<StatusIssuesResponse>(endpoints.status.issues, 60_000);
  const counts = data?.counts;
  const hasIssues =
    !!counts && counts.errors + counts.warnings + counts.recentGroups + (counts.missingDatasets ?? 0) > 0;
  // 수집기에 닿지 못하면 누락 데이터셋 수는 모릅니다(null). '0개'·초록 '오류·경고가 없습니다'로 보이면 모름이
  // 정상처럼 읽혔습니다(QA-102). 예전 백엔드는 이때도 0을 보냈으므로 연결 여부도 함께 봅니다.
  const missingUnknown = !!data && (!data.collectorReachable || counts?.missingDatasets == null);

  return (
    <Panel
      title="수집 오류·경고 로그" source={SOURCES.collectorRuns}
      subtitle={`지금 실패 중인 태스크 · 최근 ${data?.lookbackHours ?? 24}시간 실패 이력(같은 사유는 묶음) · 누락 데이터셋`}
      actions={
        <div className="flex items-center gap-2">
          <Freshness refreshError={refreshError} />
          <Button onClick={reload} disabled={loading}>
            새로고침
          </Button>
          <CopyButton text={data?.text} label="로그 복사" variant="primary" disabled={!data?.text} />
        </div>
      }
    >
      {loading && !data && <Loading label="실행 기록을 모으는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && (
        <div className="flex flex-col gap-3">
          <KpiStrip label="오류·경고" items={issueTiles(counts, missingUnknown)} />
          {!data.collectorReachable && (
            <Callout tone="warn">수집기에 연결하지 못해 DB 기록만으로 만들었습니다(누락 데이터셋·없앤 태스크 거르기 제외).</Callout>
          )}
          {hasIssues ? (
            <LogPanel label="수집 오류·경고 로그" text={data.text} maxHeight="md" />
          ) : missingUnknown ? (
            <p className="text-sm text-text-3">
              실행 기록에는 최근 {data.lookbackHours}시간 동안 오류·경고가 없지만, 수집기에 연결하지 못해 누락 데이터셋은
              확인하지 못했습니다.
            </p>
          ) : (
            <p className="text-sm">
              <StatusText tone="ok">최근 {data.lookbackHours}시간 동안 오류·경고가 없습니다.</StatusText>
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/** 건수 — 천 단위 쉼표. */
const count = (value: number) => value.toLocaleString("ko-KR", { maximumFractionDigits: 0 });

/**
 * KPI 띠 '오류·경고'의 타일 넷. 값은 본문 잉크 숫자(+ 단위)이고, 오류·경고가 0보다 크면 타일 아래 상태 줄(위험·주의 아이콘 + 글)로 뜻을 나릅니다
 * (색만으로 나르지 않음 — W4, QA-505). 이름에 이미 '오류'·'경고'가 있어 읽어 주는 머리말은 더하지 않습니다. 0건은 상태가 아니라 상태 줄이 없습니다.
 * 수집기에 닿지 못하면 누락 데이터셋 수는 모르므로 '—'(QA-102 — 0으로 채우지 않음).
 */
function issueTiles(counts: StatusIssuesResponse["counts"] | undefined, missingUnknown: boolean): KpiItem[] {
  const errors = counts?.errors ?? null;
  const warnings = counts?.warnings ?? null;
  return [
    {
      key: "errors",
      label: "현재 오류",
      value: errors,
      format: count,
      unit: "건",
      status: errors ? { tone: "danger", text: "지금 실패 중인 태스크", srPrefix: "" } : undefined,
    },
    {
      key: "warnings",
      label: "현재 경고",
      value: warnings,
      format: count,
      unit: "건",
      status: warnings ? { tone: "warn", text: "지금 경고인 태스크", srPrefix: "" } : undefined,
    },
    { key: "groups", label: "최근 실패 유형", value: counts?.recentGroups ?? null, format: count, unit: "개" },
    {
      key: "missing",
      label: "누락 데이터셋",
      value: missingUnknown ? null : (counts?.missingDatasets ?? null),
      format: count,
      unit: "개",
      emptyReason: missingUnknown ? "확인 못 함" : null,
    },
  ];
}
