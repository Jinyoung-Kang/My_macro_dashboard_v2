"use client";

import { CopyButton } from "@/components/CopyButton";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Metric } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { EMPTY, formatWithUnit } from "@/lib/format";
import type { StatusIssuesResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 수집 오류·경고 로그 — 문제만 모아 한 덩어리 텍스트로.
 *
 * 표는 태스크별 "최근 결과"만 보여 주고 긴 사유는 잘립니다. 문제를 누군가에게 보여
 * 주려면 스크린샷 여러 장이 필요했습니다. 여기서는 백엔드가 만든 텍스트를 그대로
 * 보여 주고 한 번에 복사합니다(비밀값은 백엔드에서 가려져 옵니다).
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
    <Card
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
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* 오류·경고 수는 글 색만으로 전하지 않고 아이콘을 붙입니다(위험색은 상승 빨강과 거의 같은 색 — W4, QA-505). 이름에 이미
                '오류'·'경고'가 있어 읽어 주는 머리말은 더하지 않습니다. 0건은 상태가 아니라 아이콘이 없습니다. align-top은 값 줄 안의
                inline-flex가 기준선에 앉아 줄이 2~3px 높아지지 않게 합니다. */}
            <Metric
              label="현재 오류"
              value={counts?.errors ? (
                <StatusText tone="danger" srPrefix="" iconSize={20} className="align-top">{`${counts.errors}건`}</StatusText>
              ) : `${counts?.errors ?? 0}건`}
              tone={counts?.errors ? "text-danger" : undefined}
            />
            <Metric
              label="현재 경고"
              value={counts?.warnings ? (
                <StatusText tone="warn" srPrefix="" iconSize={20} className="align-top">{`${counts.warnings}건`}</StatusText>
              ) : `${counts?.warnings ?? 0}건`}
              tone={counts?.warnings ? "text-warn" : undefined}
            />
            <Metric label="최근 실패 유형" value={`${counts?.recentGroups ?? 0}개`} />
            <Metric label="누락 데이터셋" value={missingUnknown ? EMPTY : formatWithUnit(counts?.missingDatasets, 0, "개")} />
          </div>
          {!data.collectorReachable && (
            <Banner tone="warn">수집기에 연결하지 못해 DB 기록만으로 만들었습니다(누락 데이터셋·없앤 태스크 거르기 제외).</Banner>
          )}
          {hasIssues ? (
            <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-bg p-3 text-xs leading-relaxed text-text-2">
              {data.text}
            </pre>
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
        </>
      )}
    </Card>
  );
}
