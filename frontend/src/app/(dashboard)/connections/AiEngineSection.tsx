"use client";

import { useState } from "react";
import { Banner, Button, Card, ErrorState, inputClasses, Loading, Select, SourceBadge, Table } from "@/components/ui";
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

/** 🤖 AI 엔진 — 엔진별 키 설정 여부, 호출 응답·지연시간·폴오버 경로. */
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
      <h2 className="text-base font-semibold text-bright">AI 엔진</h2>

      {engines.loading && !engines.data && <Loading />}
      {/* 엔진 목록을 받지 못하면 엔진 표가 없고 호출 버튼이 이유 없이 꺼져 있었습니다(QA-103, ai/report의 QA-050과 같음). */}
      {engines.error && <ErrorState message={engines.error} onRetry={engines.reload} />}

      {engines.data && (
        <Card title="등록된 엔진" source={SOURCES.aiEngines} subtitle="엔진별 응답·지연시간·자동 번역 동작을 확인합니다">
          <Table
            rows={engines.data.engines}
            rowKey={(row) => row.id}
            columns={[
              { key: "label", header: "엔진", render: (row) => engineLabel(row) },
              {
                key: "model",
                header: "모델",
                render: (row) => (row.model ? <SourceBadge>{row.model}</SourceBadge> : "—"),
              },
              { key: "description", header: "용도", render: (row) => row.description },
              {
                key: "available",
                header: "키",
                // available은 "허용됐고 키도 있음"입니다(ADR 0014). 허용 목록 밖이면 키가 있어도 쓰지 않으므로 따로 적습니다.
                render: (row) => (
                  <span className={row.available ? "text-ok" : "text-muted"}>
                    {row.available ? "설정됨" : row.unavailableReason === "not_allowed" ? "이 배포에서 사용 안 함" : "없음"}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Card title="호출 테스트">
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
      </Card>

      {result && (
        <Card
          title="응답" source={SOURCES.aiEngines}
          subtitle={
            result.status
              ? `${result.provider} · ${result.latencyMs}ms · ${result.pipelineStep}`
              : result.pipelineStep
          }
        >
          {result.status ? (
            <article className="whitespace-pre-wrap text-sm leading-relaxed text-body">
              {result.response}
            </article>
          ) : (
            // 실패 문구에는 엔진 라벨·'자동 탐색' 안내가 실려 예전 그림 문자가 섞여 옵니다 — 화면에서 뗍니다
            <Banner tone="danger">{withoutLeadingIcon(result.error ?? "")}</Banner>
          )}
          {result.failoverPath && (
            <p className="mt-3 text-[11px] text-muted">
              폴오버 경로: {result.failoverPath.map((step) => withoutLeadingIcon(step)).join(" → ")}
            </p>
          )}
          {result.translationInfo && (
            <p className="mt-1 text-[11px] text-muted">{result.translationInfo}</p>
          )}
        </Card>
      )}
    </section>
  );
}
