"use client";

import { DataTable, KpiStrip, SectionAnchor, SectionIndex, type Column, type KpiItem, type SectionIndexItem } from "@/components/patterns";
import { Button, Callout, ErrorState, Freshness, Loading, PageHeader, Panel, Tag } from "@/components/ui";
import { ClockIcon, StatusIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { useTaskRunner } from "@/hooks/useTaskRunner";
import { EMPTY, formatAge, formatKst, withoutLeadingIcon } from "@/lib/format";
import type { StatusResponse, TaskSummary } from "@/lib/types";
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
  interrupted: "비정상 종료",
  none: "기록 없음",
};

/** 중단(interrupted)의 까닭 — KPI 타일의 상태 줄(주의 아이콘 + 글)로 둡니다. */
const INTERRUPTED_REASON = "프로세스가 사라졌거나 신호가 끊겼습니다";

/** 절 닻 id — 목차(SectionIndex)와 같은 값. */
const IDS = {
  issues: "status-issues",
  tasks: "status-tasks",
  snapshots: "status-snapshots",
  missing: "status-missing",
  keys: "status-keys",
  verification: "status-verification",
  publicApis: "status-public-apis",
} as const;

type SnapshotRow = NonNullable<StatusResponse["snapshots"]>[number];

/**
 * 데이터 저장소 상태 — 운영 콘솔(작업대 실행 명세 §7 7행 '저장소 상태: 운영 콘솔(KPI 띠·표·로그 패널·목차)').
 *
 * 구버전 `collector.py --status`가 터미널에 출력하던 내용을 화면으로 옮겼습니다. 핵심은 "무엇이 왜 실패했는지"와 "있어야 하는데 없는 데이터셋"입니다.
 *
 * - 머리: 제목·한 줄 설명, 오른쪽 읽기 모드 태그와 신선도(새로 읽지 못함). 수집기에 닿지 못하면 주의 안내 상자.
 * - KPI 띠 '저장소 요약': 최근 수집 상태(판정 라벨 — 중단이면 주의 아이콘 + 까닭)·성공/실패·누적 시계열·누적 수급 레코드. 모르는 값은 '—'.
 * - 긴 화면 목차(SectionIndex — 2xl 이상 왼쪽 세로 목록, 그 아래 본문 위 가로 줄): 오류·경고 로그 / 태스크 / 스냅샷 / 누락 / API 키 / 교차 검증 / 공공 API.
 *   새로 고침·바로 연 주소의 #절로 맞춥니다(alignHashOnLoad — 자료가 위 절을 키우는 화면이라 프레임·설정과 같은 판단, 진행 기록 P5a 'P7 저장소 상태에서 정함').
 * - 표는 공용 조밀 표(28px 행·개수 줄·넘치면 상자 안 가로 스크롤과 안내). 표 안 '다시 실행'은 작은 단추(넓은 화면 24px — 명세 §3-7 '표 안').
 * - 요청·쓰기는 그대로: 개요·오류 로그 60초, 다시 실행 POST(+ 3초 간격 확인)·교차 검증 POST·공공 API 진단 GET(누를 때만).
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
  const tasks = data?.taskSummary ?? [];
  const snapshots = data?.snapshots ?? [];
  const missing = data?.missingDatasets;

  const summary: KpiItem[] = [
    {
      key: "last",
      label: "최근 수집 상태",
      value: RUN_STATUS_LABEL[resolvedStatus] ?? resolvedStatus,
      valueKind: "label",
      status: resolvedStatus === "interrupted" ? { tone: "warn", text: INTERRUPTED_REASON } : undefined,
      note: lastRun?.startedAt ? `${formatKst(lastRun.startedAt)} 시작 · 대상 ${lastRun.groupName ?? EMPTY}` : null,
    },
    {
      key: "okFail",
      label: "성공 / 실패",
      value: lastRun ? `${lastRun.okCount ?? EMPTY} / ${lastRun.failCount ?? EMPTY}` : null,
      note: lastRun?.detail ? withoutLeadingIcon(lastRun.detail) : null,
    },
    { key: "series", label: "누적 시계열", value: data?.timeseriesRows ?? null, format: rows, unit: "행" },
    {
      key: "observations",
      label: "누적 수급 레코드",
      value: data?.observationRows ?? null,
      format: rows,
      unit: "행",
      note: data?.radarHistoryDates ? `이력 거래일 ${data.radarHistoryDates.length}일` : null,
    },
  ];

  const index: SectionIndexItem[] = [
    { id: IDS.issues, label: "오류·경고 로그" },
    { id: IDS.tasks, label: "태스크", count: tasks.length },
    { id: IDS.snapshots, label: "스냅샷", count: snapshots.length },
    { id: IDS.missing, label: "누락", count: missing ? missing.length : null },
    { id: IDS.keys, label: "API 키" },
    { id: IDS.verification, label: "교차 검증" },
    { id: IDS.publicApis, label: "공공 API" },
  ];

  const taskColumns: Column<TaskSummary>[] = [
    {
      key: "task",
      header: "태스크",
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className="flex items-center gap-2">
          <TaskStatusIcon status={row.status} />
          <span className="font-mono text-caption text-text-2">{row.task}</span>
          {row.speed && <Tag>{row.speed}</Tag>}
        </span>
      ),
    },
    { key: "startedAt", header: "실행 시각", className: "whitespace-nowrap", cell: (row) => formatKst(row.startedAt) },
    {
      key: "duration",
      header: "소요",
      align: "right",
      cell: (row) => (row.durationMs === null ? null : `${(row.durationMs / 1000).toFixed(1)}s`),
    },
    {
      key: "detail",
      header: "상세",
      className: "min-w-[18rem] break-keep wrap-anywhere",
      cell: (row) => {
        const detail = row.detail ? withoutLeadingIcon(row.detail) : null;
        if (detail === null) return null;
        if (row.status === "ok") return <span className="text-text-3">{detail}</span>;
        // 정상이 아닌 줄의 상세는 아이콘 + 글(색만으로 나르지 않음). 낭독 머리말은 첫 칸 상태 아이콘이 이미 읽어 붙이지 않습니다.
        return (
          <StatusText tone={taskStatusView(row.status).tone} srPrefix="">
            {detail}
          </StatusText>
        );
      },
    },
    {
      key: "action",
      header: <span className="sr-only">동작</span>,
      align: "right",
      cell: (row) => (
        <Button size="sm" onClick={() => runTask(row.task)} disabled={running !== null}>
          {running === row.task ? "실행 중…" : "다시 실행"}
        </Button>
      ),
    },
  ];

  const snapshotColumns: Column<SnapshotRow>[] = [
    { key: "name", header: "데이터셋", className: "whitespace-nowrap", cell: (row) => <span className="font-mono text-caption">{row.name}</span> },
    {
      key: "status",
      header: "상태",
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className={row.status === "estimated" ? "text-warn" : row.status === "ok" ? "text-ok" : "text-danger"}>
          {row.status === "estimated" ? "추정치" : row.status}
        </span>
      ),
    },
    {
      key: "age",
      header: "수집",
      align: "right",
      cell: (row) => <span className={row.stale ? "text-warn" : "text-text-3"}>{formatAge(row.ageSeconds ?? null)}</span>,
    },
    { key: "collectedAt", header: "수집 시각", className: "whitespace-nowrap", cell: (row) => formatKst(row.collectedAt) },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="데이터 저장소 상태"
        description="수집 현황·신선도·실패 원인·누적 이력"
        actions={
          <>
            {data ? <Tag>읽기 모드 {data.readMode ?? EMPTY}</Tag> : null}
            <Freshness refreshError={refreshError} />
          </>
        }
      />

      {data && !data.collectorReachable && (
        <Callout tone="warn" title="수집기에 닿지 못함">
          {data.message ?? "수집기에 연결하지 못했습니다. 아래 정보는 데이터베이스에서 직접 읽은 값입니다."}
        </Callout>
      )}

      <KpiStrip label="저장소 요약" items={summary} />

      <SectionIndex label="저장소 상태 목차" items={index} columnFrom="2xl" alignHashOnLoad>
        {/* 문제만 모은 로그를 위에 둡니다 — 이 화면을 여는 이유의 대부분이 "무엇이 안 되나"입니다. */}
        <SectionAnchor id={IDS.issues} columnFrom="2xl">
          <IssuesPanel />
        </SectionAnchor>

        <SectionAnchor id={IDS.tasks} columnFrom="2xl">
          <Panel
            title="태스크별 최근 결과"
            source={SOURCES.collectorRuns}
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
            <DataTable
              dense
              count
              scrollHint="overflow"
              caption="태스크별 최근 결과"
              rows={tasks}
              rowKey={(row) => row.task}
              emptyText="수집 기록이 없습니다. 수집기를 한 번 실행하세요."
              columns={taskColumns}
            />
          </Panel>
        </SectionAnchor>

        <SectionAnchor id={IDS.snapshots} columnFrom="2xl">
          <Panel
            title="스냅샷 신선도"
            source={SOURCES.snapshots}
            subtitle="수집 시각이 오래된 저장본은 화면에서도 '오래됨'으로 표시됩니다."
          >
            <DataTable
              dense
              count
              caption="스냅샷 신선도"
              rows={snapshots}
              rowKey={(row) => row.name}
              emptyText="저장된 스냅샷이 없습니다."
              columns={snapshotColumns}
            />
          </Panel>
        </SectionAnchor>

        <SectionAnchor id={IDS.missing} columnFrom="2xl">
          <Panel
            title="있어야 하는데 없는 데이터셋"
            source={SOURCES.snapshots}
            subtitle="기대 목록과 대조해 누락을 찾습니다. 존재하는 것만 나열하면 누락을 알아챌 수 없습니다."
          >
            {/* 목록이 없으면(수집기에 닿지 못함 등) 누락이 없는 것이 아니라 모르는 것입니다(QA-045). */}
            {data && !missing ? (
              <p className="text-sm text-text-3">누락 여부를 확인하지 못했습니다 — 수집기에 연결되지 않아 기대 목록을 받지 못했습니다.</p>
            ) : (missing ?? []).length === 0 ? (
              <p className="text-sm">
                <StatusText tone="ok">누락된 데이터셋이 없습니다.</StatusText>
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {missing?.map((entry) => (
                  <li key={entry.name} title={entry.name}>
                    <Tag tone="warn">{entry.label}</Tag>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </SectionAnchor>

        <SectionAnchor id={IDS.keys} columnFrom="2xl">
          <Panel title="외부 API 키 보유 현황" source={SOURCES.collectorKeys} subtitle="키가 없는 소스는 해당 기능만 비활성화됩니다.">
            {data?.keys ? (
              <ul className="flex flex-wrap gap-2">
                {Object.entries(data.keys).map(([name, present]) => (
                  <li key={name}>
                    <Tag tone={present ? "ok" : "neutral"}>
                      {name.toUpperCase()} {present ? "설정됨" : "없음"}
                    </Tag>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-3">키 보유 현황을 받지 못했습니다.</p>
            )}
          </Panel>
        </SectionAnchor>

        <SectionAnchor id={IDS.verification} columnFrom="2xl">
          <VerificationPanel />
        </SectionAnchor>

        <SectionAnchor id={IDS.publicApis} columnFrom="2xl">
          <PublicApiPanel />
        </SectionAnchor>
      </SectionIndex>
    </div>
  );
}

/** 행 수 — 천 단위 쉼표, 소수 없음. */
function rows(value: number): string {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

/** 태스크 결과 아이콘(표 칸) — 모르는 상태는 '알 수 없음'(lib/taskRun.taskStatusView). */
function TaskStatusIcon({ status }: { status: string | null | undefined }) {
  const view = taskStatusView(status);
  return <StatusIcon tone={view.tone} label={view.label} />;
}
