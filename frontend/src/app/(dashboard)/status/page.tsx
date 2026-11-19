"use client";

import {
  Banner,
  Button,
  Card,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  SourceBadge,
  Table,
} from "@/components/ui";
import { ClockIcon, StatusIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { useTaskRunner } from "@/hooks/useTaskRunner";
import { EMPTY, formatAge, formatKst, formatNumber, withoutLeadingIcon } from "@/lib/format";
import type { StatusResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { taskStatusView } from "@/lib/taskRun";
import { endpoints } from "@/lib/endpoints";
import { IssuesPanel } from "./IssuesPanel";
import { PublicApiPanel } from "./PublicApiPanel";
import { VerificationPanel } from "./VerificationPanel";

const RUN_STATUS_LABEL: Record<string, string> = {
  ok: "정상 종료",
  partial: "일부 실패",
  fail: "전부 실패",
  running: "진행 중",
  interrupted: "비정상 종료 (프로세스가 사라졌거나 신호가 끊겼습니다)",
  none: "기록 없음",
};

/**
 * 데이터 저장소 상태.
 *
 * 구버전 `collector.py --status`가 터미널에 출력하던 내용을 화면으로 옮겼습니다.
 * 핵심은 "무엇이 왜 실패했는지"와 "있어야 하는데 없는 데이터셋"입니다.
 */
export default function StatusPage() {
  const { data, loading, error, reload, refreshError } = useApi<StatusResponse>(endpoints.status.overview, 60_000);
  const { reloadAll } = useRefreshSignal();
  // 개별 태스크 실행도 화면 전체를 갱신합니다(useTaskRunner 설명 참고).
  const { running, message, messageTone, runTask } = useTaskRunner(reloadAll);

  if (loading && !data) {
    return <Loading label="저장소 상태를 확인하는 중…" />;
  }
  if (error) {
    return <ErrorState message={error} onRetry={reload} />;
  }

  const lastRun = data?.lastRun;
  const resolvedStatus = data?.lastRunStatus ?? "none";

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="데이터 저장소 상태"
        description={<>수집 현황·신선도·실패 원인·누적 이력 · 읽기 모드 {data?.readMode}</>}
        actions={<Freshness refreshError={refreshError} />}
      />

      {data && !data.collectorReachable && (
        <Banner tone="warn">
          {data.message ?? "수집기에 연결하지 못했습니다. 아래 정보는 데이터베이스에서 직접 읽은 값입니다."}
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* align-top: 값 줄 안의 상태 글(inline-flex)이 기준선에 앉아 값 줄이 높아지지 않게 — 아래 수집 오류·경고 수(QA-505)와 같음. */}
        <Metric
          label="최근 수집 상태"
          value={
            resolvedStatus === "interrupted" ? (
              <StatusText tone="warn" iconSize={20} className="align-top">{RUN_STATUS_LABEL.interrupted}</StatusText>
            ) : (
              RUN_STATUS_LABEL[resolvedStatus] ?? resolvedStatus
            )
          }
          caption={
            lastRun?.startedAt
              ? `${formatKst(lastRun.startedAt)} 시작 · 대상 ${lastRun.groupName ?? EMPTY}`
              : undefined
          }
          tone={resolvedStatus === "interrupted" ? "text-warn" : undefined}
        />
        <Metric
          label="성공 / 실패"
          value={lastRun ? `${lastRun.okCount} / ${lastRun.failCount}` : "—"}
          caption={lastRun?.detail ? withoutLeadingIcon(lastRun.detail) : undefined}
        />
        <Metric
          label="누적 시계열"
          value={`${formatNumber(data?.timeseriesRows, 0)} 행`}
        />
        <Metric
          label="누적 수급 레코드"
          value={`${formatNumber(data?.observationRows, 0)} 행`}
          caption={`이력 거래일 ${data?.radarHistoryDates?.length ?? 0}일`}
        />
      </div>


      {/* 문제만 모은 로그를 위에 둡니다 — 이 화면을 여는 이유의 대부분이 "무엇이 안 되나"입니다. */}
      <IssuesPanel />

      {data?.keys && (
        <Card title="외부 API 키 보유 현황" source={SOURCES.collectorKeys} subtitle="키가 없는 소스는 해당 기능만 비활성화됩니다.">
          <div className="flex flex-wrap gap-2">
            {Object.entries(data.keys).map(([name, present]) => (
              <span
                key={name}
                className={`rounded-control border px-2 py-0.5 text-xs ${
                  present
                    ? "border-ok/40 bg-ok-tint text-ok"
                    : "border-border bg-surface-2 text-text-3"
                }`}
              >
                {name.toUpperCase()} {present ? "설정됨" : "없음"}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="태스크별 최근 결과" source={SOURCES.collectorRuns}
        subtitle={
          // 범례 — 표의 아이콘이 무엇인지. 범례라 낭독기 머리말('주의:')은 붙이지 않습니다.
          <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
            <StatusText tone="ok" srPrefix="">정상</StatusText>
            <StatusText tone="warn" srPrefix="">데이터 없음(기존 저장본 유지)</StatusText>
            <StatusText tone="danger" srPrefix="">오류</StatusText>
          </span>
        }
      >
        {/* 시작·진행 중 안내는 결과가 아니라 시계 아이콘(중립 색) — '알 수 없음'의 점선 원을 붙이지 않습니다. */}
        {message && (
          <p className="mb-3 text-xs">
            {messageTone === "progress" ? (
              <StatusText tone="neutral" icon={<ClockIcon size={12} />}>{message}</StatusText>
            ) : (
              <StatusText tone={messageTone} iconSize={12}>{message}</StatusText>
            )}
          </p>
        )}
        <Table
          rows={data?.taskSummary ?? []}
          rowKey={(row) => row.task}
          emptyMessage="수집 기록이 없습니다. 수집기를 한 번 실행하세요."
          columns={[
            {
              key: "task",
              header: "태스크",
              render: (row) => (
                <span className="flex items-center gap-2">
                  <TaskStatusIcon status={row.status} />
                  <span className="text-text-2">{row.task}</span>
                  {row.speed && <SourceBadge>{row.speed}</SourceBadge>}
                </span>
              ),
            },
            {
              key: "startedAt",
              header: "실행 시각",
              render: (row) => formatKst(row.startedAt),
            },
            {
              key: "duration",
              header: "소요",
              align: "right",
              render: (row) =>
                row.durationMs === null ? EMPTY : `${(row.durationMs / 1000).toFixed(1)}s`,
            },
            {
              key: "detail",
              header: "상세",
              render: (row) => (
                <span className={row.status === "ok" ? "text-text-3" : "text-warn"}>
                  {row.detail ? withoutLeadingIcon(row.detail) : EMPTY}
                </span>
              ),
            },
            {
              key: "action",
              header: "",
              align: "right",
              render: (row) => (
                <Button
                  onClick={() => runTask(row.task)}
                  disabled={running !== null}
                >
                  {running === row.task ? "실행 중…" : "다시 실행"}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="스냅샷 신선도" source={SOURCES.snapshots}
        subtitle="수집 시각이 오래된 저장본은 화면에서도 '오래됨'으로 표시됩니다."
      >
        <Table
          rows={data?.snapshots ?? []}
          rowKey={(row) => row.name}
          emptyMessage="저장된 스냅샷이 없습니다."
          columns={[
            { key: "name", header: "데이터셋", render: (row) => row.name },
            {
              key: "status",
              header: "상태",
              render: (row) => (
                <span
                  className={
                    row.status === "estimated"
                      ? "text-warn"
                      : row.status === "ok"
                        ? "text-ok"
                        : "text-danger"
                  }
                >
                  {row.status === "estimated" ? "추정치" : row.status}
                </span>
              ),
            },
            {
              key: "age",
              header: "수집",
              align: "right",
              render: (row) => (
                <span className={row.stale ? "text-warn" : "text-text-3"}>
                  {formatAge(row.ageSeconds ?? null)}
                </span>
              ),
            },
            {
              key: "collectedAt",
              header: "수집 시각",
              render: (row) => formatKst(row.collectedAt),
            },
          ]}
        />
      </Card>

      <Card
        title="있어야 하는데 없는 데이터셋" source={SOURCES.snapshots}
        subtitle="기대 목록과 대조해 누락을 찾습니다. 존재하는 것만 나열하면 누락을 알아챌 수 없습니다."
      >
        {/* 목록이 없으면(수집기에 닿지 못함 등) 누락이 없는 것이 아니라 모르는 것입니다(QA-045). */}
        {data && !data.missingDatasets ? (
          <p className="text-sm text-text-3">누락 여부를 확인하지 못했습니다 — 수집기에 연결되지 않아 기대 목록을 받지 못했습니다.</p>
        ) : (data?.missingDatasets ?? []).length === 0 ? (
          <p className="text-sm text-ok">누락된 데이터셋이 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data?.missingDatasets?.map((entry) => (
              <span
                key={entry.name}
                className="rounded-control border border-warn/40 bg-warn-tint px-2 py-0.5 text-xs text-warn"
                title={entry.name}
              >
                {entry.label}
              </span>
            ))}
          </div>
        )}
      </Card>

      <VerificationPanel />

      <PublicApiPanel />
    </div>
  );
}

/** 태스크 결과 아이콘(표 칸) — 모르는 상태는 '알 수 없음'(lib/taskRun.taskStatusView). */
function TaskStatusIcon({ status }: { status: string | null | undefined }) {
  const view = taskStatusView(status);
  return <StatusIcon tone={view.tone} label={view.label} />;
}
