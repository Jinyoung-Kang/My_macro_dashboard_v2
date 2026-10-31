/**
 * src/lib/taskRun.ts
 * 수동으로 시작한 수집 태스크가 끝났는지 기다립니다.
 *
 * 왜 필요한가 — 예전에는 "다시 실행"이 태스크가 끝날 때까지 요청을 붙잡았습니다. 수집기
 * 대기 한도(90초)보다 오래 걸리는 태스크(13F 등)는 실제로는 수집 중인데도 "수집기에
 * 연결하지 못했습니다"가 떴습니다. 이제 백엔드는 시작만 하고(202) 기준 시각을 돌려주며,
 * 화면이 실행 이력을 보며 끝났는지 확인합니다.
 *
 * 판단 기준 — 수집기는 태스크가 **끝날 때** 실행 기록을 남깁니다. 그러니 기준 시각보다 늦게
 * 시작한 기록이 보이면 끝난 것입니다. (같은 태스크를 스케줄러가 이미 돌리고 있었다면 새로
 * 시작하지 않고 그 실행에 합류하므로, 그 실행의 기록이 곧 결과입니다.)
 */
import type { TaskSummary } from "./types.ts";

export type TaskRunRow = Pick<TaskSummary, "task" | "status" | "startedAt" | "durationMs" | "detail">;

/** 상태 톤 — 화면의 상태 글·아이콘(components/ui/icons의 StatusTone)과 같은 네 값. */
export type TaskTone = "ok" | "warn" | "danger" | "neutral";

/** 태스크 결과 표시 — 톤(아이콘·색)과 글. 화면은 이것으로 그리고 기호 글자는 쓰지 않습니다. */
export type TaskStatusView = { tone: TaskTone; label: string };

const TASK_STATUS = new Map<string, TaskStatusView>([
  ["ok", { tone: "ok", label: "정상" }],
  ["empty", { tone: "warn", label: "데이터 없음" }],
  ["error", { tone: "danger", label: "오류" }],
]);

/** 모르는 상태(수집기에 새로 생긴 상태 등) — 정상·오류로 지어내지 않고 '알 수 없음'(중립). */
const UNKNOWN_STATUS: TaskStatusView = { tone: "neutral", label: "알 수 없음" };

/**
 * 태스크 실행 결과(task_runs.status)의 표시: 정상(ok) · 데이터 없음 — 기존 저장본 유지(warn) · 오류(danger) · 그 밖은 알 수 없음(neutral).
 */
export function taskStatusView(status: string | null | undefined): TaskStatusView {
  return (status ? TASK_STATUS.get(status) : undefined) ?? UNKNOWN_STATUS;
}

/** 수동 실행이 끝났을 때의 안내 — '<태스크> 완료 — <결과 설명>'과 그 결과의 톤(기호 글자 없이). */
export function taskDoneMessage(taskName: string, run: Pick<TaskRunRow, "status" | "detail">): { text: string; tone: TaskTone } {
  return {
    text: `${taskName} 완료${run.detail ? ` — ${run.detail}` : ""}`,
    tone: taskStatusView(run.status).tone,
  };
}

/** 기준 시각 이후에 시작한 실행 기록인지. 기준이 없으면(처음 실행) 기록이 있기만 하면 됩니다. */
export function isNewerRun(row: TaskRunRow | null | undefined, baselineStartedAt: string | null): boolean {
  if (!row?.startedAt) return false;
  const started = Date.parse(row.startedAt);
  if (Number.isNaN(started)) return false;
  if (!baselineStartedAt) return true;
  const baseline = Date.parse(baselineStartedAt);
  return Number.isNaN(baseline) ? true : started > baseline;
}

export interface WaitOptions {
  /** 그 태스크의 가장 최근 실행 기록 1건을 읽습니다. */
  fetchLatest: () => Promise<TaskRunRow | null | undefined>;
  /** 이 시간이 지나면 포기하고 null을 돌려줍니다. 13F는 10분 넘게 걸리기도 합니다. */
  timeoutMs?: number;
  intervalMs?: number;
  /** 화면을 떠났으면 true — 더 묻지 않고 멈춥니다. */
  isCancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * 기준 시각 이후의 실행 기록이 생길 때까지 기다립니다.
 *
 * @returns 끝난 실행의 기록. 시간 초과·취소면 null
 */
export async function waitForTaskRun(
  baselineStartedAt: string | null,
  {
    fetchLatest,
    timeoutMs = 15 * 60_000,
    intervalMs = 3_000,
    isCancelled = () => false,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  }: WaitOptions,
): Promise<TaskRunRow | null> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    if (isCancelled()) return null;
    try {
      const latest = await fetchLatest();
      if (isNewerRun(latest, baselineStartedAt)) return latest ?? null;
    } catch {
      // 한 번 못 읽었다고 멈추지 않습니다(수집 중에는 백엔드가 잠깐 바쁠 수 있습니다).
    }
  }
  return null;
}
