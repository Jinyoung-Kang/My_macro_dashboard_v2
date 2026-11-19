"use client";

import { useState } from "react";
import { DataTable } from "@/components/patterns";
import { Button, Callout, ErrorState, inputClasses, Loading, Panel, Select } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { errorMessage, useAsyncAction } from "@/hooks/useAsyncAction";
import { engineLabel } from "@/lib/aiEngines";
import { apiPost } from "@/lib/api";
import { withoutLeadingIcon } from "@/lib/format";
import type { AiEngine, AiResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

const SAMPLE_PROMPTS = [
  "한국어로 한 문장만 답하십시오: 지금 연결이 정상인지 알려 주세요.",
  "장단기 금리차 역전이 시장에 주는 의미를 3줄로 요약해 주세요.",
  "미결제약정이 늘면서 가격이 하락하는 국면을 한 문장으로 설명해 주세요.",
];

/** AI 엔진 — 엔진별 키 설정 여부, 호출 응답·지연시간·폴오버 경로. */
export function AiEngineSection() {
  const engines = useApi<{ engines: AiEngine[]; keys: Record<string, boolean>; enabled: boolean }>(
    endpoints.ai.engines,
  );
  const [engineId, setEngineId] = useState("auto");
  const [prompt, setPrompt] = useState(SAMPLE_PROMPTS[0]);
  // 실패도 결과 자리(빨간 안내)에 보여 줍니다 — 오류를 결과 모양으로 바꿔 돌려줍니다.
  const { run: call, busy, result } = useAsyncAction(
    (id: string, text: string): Promise<AiResponse> =>
      apiPost<AiResponse>(endpoints.ai.test(id, text))
        .catch((error: unknown) => ({ status: false, error: errorMessage(error, "호출에 실패했습니다.") })),
    "호출에 실패했습니다.",
  );
  const run = () => call(engineId, prompt);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-text">AI 엔진</h2>

      {engines.loading && !engines.data && <Loading />}
      {/* 엔진 목록을 받지 못하면 엔진 표가 없고 호출 버튼이 이유 없이 꺼져 있었습니다(QA-103, ai/report의 QA-050과 같음). */}
      {engines.error && <ErrorState message={engines.error} onRetry={engines.reload} />}

      {engines.data && (
        <Panel title="등록된 엔진" source={SOURCES.aiEngines} subtitle="엔진별 응답·지연시간·자동 번역 동작을 확인합니다">
          <DataTable
            dense
            count
            scrollHint="overflow"
            caption="등록된 엔진"
            rows={engines.data.engines}
            rowKey={(row) => row.id}
            columns={[
              // 열 폭(QA-875): 엔진 이름은 최소 10rem(눌려 3~5줄로 접히지 않게), 모델 이름(식별자)은 칸 안 아무 데서나 꺾일 수 있게 둡니다 — 줄바꿈 금지였을 때는
              // 가장 긴 모델 이름(368px)이 줄지 않아 1024(상자 706px)에서 표가 넘쳐 '키' 칸이 가로 스크롤 뒤로 밀렸습니다.
              { key: "label", header: "엔진", rowHeader: true, className: "min-w-[10rem] break-keep", cell: (row) => engineLabel(row) },
              // 모델 이름은 식별자 — 고정폭 글(예전 출처 배지 모양).
              { key: "model", header: "모델", className: "wrap-anywhere", cell: (row) => (row.model ? <span className="font-mono text-caption">{row.model}</span> : null) },
              { key: "description", header: "용도", className: "min-w-[14rem] break-keep", cell: (row) => row.description || null },
              {
                key: "available",
                header: "키",
                // 낱말 안에서 끊지 않습니다(break-keep) — 좁은 표에서 '없 / 음'으로 접혔습니다. 긴 사유는 띄어쓰기에서만 줄을 바꿉니다.
                className: "break-keep",
                // available은 "허용됐고 키도 있음"입니다(ADR 0014). 허용 목록 밖이면 키가 있어도 쓰지 않으므로 따로 적습니다. 아이콘 + 글(예전 정상색 글만).
                cell: (row) =>
                  row.available ? (
                    <StatusText tone="ok">설정됨</StatusText>
                  ) : (
                    <StatusText tone="neutral">{row.unavailableReason === "not_allowed" ? "이 배포에서 사용 안 함" : "없음"}</StatusText>
                  ),
              },
            ]}
          />
        </Panel>
      )}

      <Panel title="호출 테스트">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="엔진"
            value={engineId}
            onChange={setEngineId}
            options={(engines.data?.engines ?? []).map((engine) => ({
              value: engine.id,
              label: engineLabel(engine),
            }))}
          />
          <Select
            label="추천 프롬프트"
            value={prompt}
            onChange={setPrompt}
            options={SAMPLE_PROMPTS.map((value) => ({
              value,
              label: value.length > 30 ? `${value.slice(0, 30)}…` : value,
            }))}
          />
        </div>

        <textarea
          aria-label="호출 테스트에 보낼 프롬프트"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={3}
          maxLength={2000}
          className={`mt-3 w-full ${inputClasses()}`}
        />

        <div className="mt-3">
          <Button variant="primary" onClick={run} disabled={busy || !engines.data?.enabled}>
            {busy ? "호출 중…" : "선택 모델 호출"}
          </Button>
        </div>
      </Panel>

      {/* 응답은 결과 안내 상자 — 성공은 정상 톤(제목 '응답 — 제공자 · 지연 · 단계'), 실패는 위험 톤(제목 '호출 실패'). 응답 글은 긴 글(15/24)·보조 글자색. */}
      {result &&
        (result.status ? (
          <Callout tone="ok" title={`응답 — ${result.provider} · ${result.latencyMs}ms · ${result.pipelineStep}`}>
            <article className="mt-1 max-w-[72ch] whitespace-pre-wrap break-keep wrap-break-word text-running text-text-2">{result.response}</article>
            <ResultNotes result={result} />
          </Callout>
        ) : (
          // 실패 문구에는 엔진 라벨·'자동 탐색' 안내가 실려 예전 그림 문자가 섞여 옵니다 — 화면에서 뗍니다
          <Callout tone="danger" title="호출 실패">
            <p>{withoutLeadingIcon(result.error ?? "")}</p>
            {result.pipelineStep ? <p className="mt-1 text-xs">{result.pipelineStep}</p> : null}
            <ResultNotes result={result} />
          </Callout>
        ))}
    </section>
  );
}

/** 응답 아래 보조 줄 — 폴오버 경로(그림 문자 뗌)·자동 번역 안내. 보조 글자색(틴트 위 text-2). */
function ResultNotes({ result }: { result: AiResponse }) {
  return (
    <>
      {result.failoverPath && (
        <p className="mt-2 text-xs text-text-2">
          폴오버 경로: {result.failoverPath.map((step) => withoutLeadingIcon(step)).join(" → ")}
        </p>
      )}
      {result.translationInfo && <p className="mt-1 text-xs text-text-2">{result.translationInfo}</p>}
    </>
  );
}
