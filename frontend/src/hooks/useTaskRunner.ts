"use client";

import { useState } from "react";
import { errorMessage, useMountedRef } from "@/hooks/useAsyncAction";
import { apiGet, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { taskDoneMessage, waitForTaskRun, type TaskRunRow, type TaskTone } from "@/lib/taskRun";

/**
 * 수집 태스크 하나를 수동으로 실행하고 끝날 때까지 지켜봅니다.
 *
 * 시작(202)만 요청하고, 실행 이력에 새 기록이 생길 때까지 확인합니다(lib/taskRun). 예전에는
 * 요청 하나가 끝날 때까지 붙잡아, 90초보다 오래 걸리는 태스크(13F 등)는 실제로는 수집 중인데도
 * "수집기에 연결하지 못했습니다"가 떴습니다.
 *
 * @param onFinished 확인이 끝나면(끝났든 아직 진행 중이든) 부릅니다. 화면 전체 새로고침에 씁니다
 * @returns `{ running, message, messageTone, runTask }` — running은 실행 중인 태스크 이름(없으면 null),
 *          messageTone은 안내의 톤(끝난 실행의 결과 · 시작·진행 중은 neutral · 요청 실패는 danger) — 화면이 아이콘·색으로 그립니다
 */
export function useTaskRunner(onFinished: () => void) {
  const [running, setRunning] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<TaskTone>("neutral");
  const mounted = useMountedRef();

  const runTask = async (taskName: string) => {
    setRunning(taskName);
    setMessage(null);
    setMessageTone("neutral");
    try {
      const started = await apiPost<{ baselineStartedAt?: string | null }>(endpoints.status.runTask(taskName));
      setMessage(`${taskName} 실행을 시작했습니다. 끝나면 여기에 결과가 표시됩니다…`);
      const finished = await waitForTaskRun(started.baselineStartedAt ?? null, {
        fetchLatest: () =>
          apiGet<{ history?: TaskRunRow[] }>(endpoints.status.history(taskName, 1))
            .then((result) => result.history?.[0]),
        isCancelled: () => !mounted.current,
      });
      if (!mounted.current) return;
      if (finished) {
        const done = taskDoneMessage(taskName, finished);
        setMessage(done.text);
        setMessageTone(done.tone);
      } else {
        setMessage(`${taskName}이(가) 아직 진행 중입니다. 끝나면 아래 표에 결과가 나타납니다.`);
      }
      // 개별 태스크 실행도 화면 전체를 갱신합니다. 이 태스크가 바꾼 스냅샷을 다른 메뉴도 보고 있을 수 있습니다.
      onFinished();
    } catch (err) {
      if (mounted.current) {
        setMessage(errorMessage(err, "실행에 실패했습니다."));
        setMessageTone("danger");
      }
    } finally {
      if (mounted.current) setRunning(null);
    }
  };

  return { running, message, messageTone, runTask };
}
