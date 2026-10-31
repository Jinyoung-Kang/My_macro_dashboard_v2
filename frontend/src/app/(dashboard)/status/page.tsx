"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  PageHeader,
  SourceBadge,
  Table,
} from "@/components/ui";
import { AlertTriangleIcon, CheckCircleIcon, SkipIcon, StatusIcon, StatusText, XCircleIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTaskRunner } from "@/hooks/useTaskRunner";
import { apiPost } from "@/lib/api";
import { EMPTY, formatAge, formatKst, formatNumber, formatWithUnit, withoutLeadingIcon } from "@/lib/format";
import type {
  PublicApiDiagnosticsResponse,
  StatusIssuesResponse,
  StatusResponse,
  VerificationResponse,
} from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { taskStatusView } from "@/lib/taskRun";
import { endpoints } from "@/lib/endpoints";

const RUN_STATUS_LABEL: Record<string, string> = {
  ok: "정상 종료",
  partial: "일부 실패",
  fail: "전부 실패",
  running: "진행 중",
  interrupted: "비정상 종료 (프로세스가 사라졌거나 신호가 끊겼습니다)",
  none: "기록 없음",
};

/**
 * 🗄️ 데이터 저장소 상태.
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
        <Metric
          label="최근 수집 상태"
          value={
            resolvedStatus === "interrupted" ? (
              <StatusText tone="warn" iconSize={20}>{RUN_STATUS_LABEL.interrupted}</StatusText>
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
                className={`rounded-sm border px-3 py-1 text-xs ${
                  present
                    ? "border-ok/40 bg-ok/10 text-ok"
                    : "border-border bg-surface-hover text-muted"
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
        {message && (
          <p className="mb-3 text-xs">
            <StatusText tone={messageTone} iconSize={12}>{message}</StatusText>
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
                  <span className="text-body">{row.task}</span>
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
                <span className={row.status === "ok" ? "text-muted" : "text-warn"}>
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
                <span className={row.stale ? "text-warn" : "text-muted"}>
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
          <p className="text-sm text-muted">누락 여부를 확인하지 못했습니다 — 수집기에 연결되지 않아 기대 목록을 받지 못했습니다.</p>
        ) : (data?.missingDatasets ?? []).length === 0 ? (
          <p className="text-sm text-ok">누락된 데이터셋이 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data?.missingDatasets?.map((entry) => (
              <span
                key={entry.name}
                className="rounded-sm border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn"
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

/**
 * 🔌 국내 공공 API 연결 진단.
 *
 * 공공데이터포털은 키 하나로 여러 서비스를 쓰지만 활용신청·승인은 서비스마다
 * 따로입니다. 키는 맞는데 한 서비스만 승인 전인 경우가 흔해서, 어느 것이 되는지
 * 한 번에 봅니다. 누를 때마다 실제로 API당 1회씩 호출하므로 자동으로 돌리지 않습니다.
 */
function PublicApiPanel() {
  const [runId, setRunId] = useState<number | null>(null);
  const { data, loading, error } = useApi<PublicApiDiagnosticsResponse>(
    runId === null ? null : endpoints.publicData.apiStatus(runId),
  );

  return (
    <Card
      title="국내 공공 API 연결 진단" source="공공데이터포털(천문연·금융위) · 금융감독원 Open DART — 실제 호출"
      subtitle="공공데이터포털(특일정보·주식시세) · Open DART — 누를 때마다 API당 1회 호출"
      actions={
        <Button onClick={() => setRunId(Date.now())} disabled={loading}>
          {loading ? "확인 중…" : "진단 실행"}
        </Button>
      }
    >
      {runId === null && (
        <p className="text-sm text-muted">
          .env에 키를 넣고 수집기를 다시 띄운 뒤 눌러 보세요. 결과에 키 값은 표시되지 않습니다.
        </p>
      )}
      {error && <ErrorState message={error} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}
      {data?.available && data.apis && (
        <Table
          rows={data.apis}
          rowKey={(row) => row.label}
          columns={[
            { key: "label", header: "API", render: (row) => row.label },
            {
              key: "state",
              header: "상태",
              render: (row) =>
                row.ok ? (
                  <StatusText tone="ok">정상</StatusText>
                ) : row.configured ? (
                  <StatusText tone="danger">실패</StatusText>
                ) : (
                  <StatusText tone="neutral">키 없음</StatusText>
                ),
            },
            { key: "detail", header: "내용", render: (row) => <span className="text-xs">{row.detail ?? EMPTY}</span> },
            {
              key: "ms",
              header: "응답",
              align: "right",
              render: (row) => (row.elapsedMs === null ? EMPTY : `${formatNumber(row.elapsedMs, 0)}ms`),
            },
          ]}
        />
      )}
    </Card>
  );
}

const VERDICT_STYLE: Record<string, string> = {
  match: "text-ok",
  mismatch: "text-danger",
  skipped: "text-muted",
  error: "text-warn",
};

/** 판정 아이콘 — 장식입니다. 뜻은 바로 옆에 보이는 판정 글(entry.label)이 나릅니다. */
const VERDICT_ICON: Record<string, typeof CheckCircleIcon> = {
  match: CheckCircleIcon,
  mismatch: XCircleIcon,
  skipped: SkipIcon,
  error: AlertTriangleIcon,
};

/** 태스크 결과 아이콘(표 칸) — 모르는 상태는 '알 수 없음'(lib/taskRun.taskStatusView). */
function TaskStatusIcon({ status }: { status: string | null | undefined }) {
  const view = taskStatusView(status);
  return <StatusIcon tone={view.tone} label={view.label} />;
}

function VerdictIcon({ verdict }: { verdict: string }) {
  const Icon = VERDICT_ICON[verdict];
  return Icon ? <Icon size={14} className={VERDICT_STYLE[verdict]} /> : null;
}

function VerificationPanel() {
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
          <p className="mb-3 text-sm text-body">
            {result.headline} · 검증 시각 {formatKst(result.checkedAt)}
          </p>
          <div className="flex flex-col gap-3">
            {result.results?.map((entry) => (
              <div key={entry.name} className="rounded-lg border border-border bg-canvas p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm text-bright">
                    <VerdictIcon verdict={entry.verdict} />
                    {entry.name}
                  </span>
                  <span className={`text-xs font-semibold ${VERDICT_STYLE[entry.verdict]}`}>
                    {entry.label}
                    {entry.diffPct !== null && ` · 차이 ${entry.diffPct.toFixed(3)}%`}
                  </span>
                </div>
                {entry.readings.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
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
                {entry.note && <p className="mt-2 text-xs text-muted">{entry.note}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * ⚠️ 수집 오류·경고 로그 — 문제만 모아 한 덩어리 텍스트로.
 *
 * 표는 태스크별 "최근 결과"만 보여 주고 긴 사유는 잘립니다. 문제를 누군가에게 보여
 * 주려면 스크린샷 여러 장이 필요했습니다. 여기서는 백엔드가 만든 텍스트를 그대로
 * 보여 주고 한 번에 복사합니다(비밀값은 백엔드에서 가려져 옵니다).
 */
function IssuesPanel() {
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
            <Metric label="현재 오류" value={`${counts?.errors ?? 0}건`} tone={counts?.errors ? "text-danger" : undefined} />
            <Metric label="현재 경고" value={`${counts?.warnings ?? 0}건`} tone={counts?.warnings ? "text-warn" : undefined} />
            <Metric label="최근 실패 유형" value={`${counts?.recentGroups ?? 0}개`} />
            <Metric label="누락 데이터셋" value={missingUnknown ? EMPTY : formatWithUnit(counts?.missingDatasets, 0, "개")} />
          </div>
          {!data.collectorReachable && (
            <Banner tone="warn">수집기에 연결하지 못해 DB 기록만으로 만들었습니다(누락 데이터셋·없앤 태스크 거르기 제외).</Banner>
          )}
          {hasIssues ? (
            <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-canvas p-3 text-xs leading-relaxed text-body">
              {data.text}
            </pre>
          ) : missingUnknown ? (
            <p className="text-sm text-muted">
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
