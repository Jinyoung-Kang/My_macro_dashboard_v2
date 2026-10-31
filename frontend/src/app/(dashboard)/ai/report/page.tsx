"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Banner, Button, Card, ErrorState, inputClasses, Loading, PageHeader, Select, SourceBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isDemo } from "@/lib/access";
import { defaultEngineId, demoQuotaNote, engineOptions, quotaLabel } from "@/lib/aiEngines";
import { apiPost } from "@/lib/api";
import { formatKst, formatLatency, withoutLeadingIcon } from "@/lib/format";
import type { AiEngines, AiResponse, SnapshotText } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { ReportView } from "./ReportView";

/**
 * 🤖 AI 종합 데이터 분석 &amp; 결론 리포트.
 *
 * 프롬프트에는 대시보드가 수집한 <b>원본 텍스트</b>가 그대로 들어갑니다.
 * 추정치·대용 지표에는 경고 문구가 함께 들어가므로, AI가 실제 지표의 임계치를
 * 추정치에 적용하는 것을 막습니다.
 *
 * 데모 열람(ADR 0013)도 리포트를 만들 수 있습니다 — 방문자 전체가 하루 한도를 함께 씁니다(ADR 0014). 다른 쓰기는
 * 그대로 막혀 있습니다. 배포가 엔진을 좁혔으면(AI_ENGINES) 못 쓰는 엔진은 이유를 붙여 막고, 쓸 수 있는 첫 엔진을 고릅니다.
 */
export default function AiReportPage() {
  const demo = isDemo(useSessionUser());
  const engines = useApi<AiEngines>(endpoints.ai.engines);
  const reportTypes = useApi<{ types: string[] }>(endpoints.ai.reportTypes);
  const snapshot = useApi<SnapshotText>(endpoints.snapshot.text);

  // 고르기 전에는 목록이 정한 기본값(자동 탐색, 못 쓰면 쓸 수 있는 첫 엔진)을 씁니다.
  const [pickedEngine, setPickedEngine] = useState<string | null>(null);
  const engineId = pickedEngine ?? defaultEngineId(engines.data?.engines);
  const [reportType, setReportType] = useState("");
  const [extra, setExtra] = useState("");
  const [showData, setShowData] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const report = useAsyncAction(
    (body: { engineId: string; reportType: string | undefined; extraInstruction: string }) =>
      apiPost<AiResponse>(endpoints.ai.report, body),
    "리포트 생성에 실패했습니다.",
  );
  const { busy, result, error } = report;
  const elapsed = useElapsedSeconds(busy);

  const selectedEngine = (engines.data?.engines ?? []).find(
    (engine) => engine.id === engineId,
  );
  const autoBudget = engines.data?.autoBudgetSeconds;
  const engineTimeout = engines.data?.timeoutSeconds;

  const generate = () =>
    report.run({ engineId, reportType: reportType || reportTypes.data?.types?.[0], extraInstruction: extra });

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="AI 종합 데이터 분석 & 결론 리포트"
        description="수집된 데이터만 근거로 삼습니다. 데이터에 없는 수치는 생성하지 않도록 지시합니다."
      />

      {/* 엔진 목록을 받지 못하면 생성 버튼이 이유 없이 꺼져 있었습니다(QA-050). */}
      {engines.error && <ErrorState message={engines.error} onRetry={engines.reload} />}
      {engines.data && !engines.data.enabled && (
        <Banner tone="warn">
          AI 키가 하나도 설정되지 않았습니다. Anthropic(Claude) / NVIDIA / Cerebras / Cloudflare 중 하나 이상을
          설정하면 이 메뉴가 활성화됩니다.
        </Banner>
      )}

      <Card title="리포트 설정">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="AI 엔진"
            value={engineId}
            onChange={setPickedEngine}
            // 고르기 전에 속도를 보여 줍니다. 추론형 모델이 느린 것은 고장이
            // 아니라 그 모델의 성질인데, 목록만 보면 알 수 없었습니다.
            options={engineOptions(engines.data?.engines ?? [])}
          />
          <Select
            label="리포트 종류"
            value={reportType || (reportTypes.data?.types?.[0] ?? "")}
            onChange={setReportType}
            options={(reportTypes.data?.types ?? []).map((type) => ({
              value: type,
              label: type,
            }))}
          />
        </div>

        <p className="mt-2 text-xs leading-relaxed text-muted">
          {engineId === "auto"
            ? `자동 탐색은 빠른 엔진부터 부릅니다${
                autoBudget ? ` (전체 ${autoBudget}초를 넘기면 중단하고 실패 경로를 보여 줍니다)` : ""
              }.`
            : `고른 엔진만 부릅니다${
                engineTimeout ? ` (최대 ${engineTimeout}초 대기)` : ""
              }.${selectedEngine?.description ? ` ${selectedEngine.description}.` : ""}`}
        </p>

        <label className="mt-4 block text-xs text-muted">
          추가 지시 (선택)
          <textarea
            value={extra}
            onChange={(event) => setExtra(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="예: 향후 2주 관점에서 코스피200 선물 포지션에 집중해 주세요."
            className={`mt-1 w-full ${inputClasses()}`}
          />
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={generate}
            disabled={busy || !engines.data?.enabled}
          >
            {busy ? `생성 중… ${elapsed}초 경과` : "리포트 생성"}
          </Button>
          {demo && (
            <span className="text-xs text-muted">{demoQuotaNote(result?.quota ?? engines.data?.quota)}</span>
          )}
          {!demo && engines.data && !engines.data.enabled && (
            <span className="text-xs text-muted">
              사용할 수 있는 AI 엔진이 없습니다 — .env에 ANTHROPIC·NVIDIA·Cloudflare·Cerebras 키 중 하나를 넣고 make up 하세요.
            </span>
          )}
          <Button onClick={() => setShowData((value) => !value)}>
            {showData ? "원본 데이터 닫기" : "AI에 전달되는 원본 데이터 보기"}
          </Button>
          <CopyButton
            text={snapshot.data?.text}
            label="원본 데이터 복사"
            disabled={!snapshot.data?.text}
          />
        </div>
      </Card>

      {showData && (
        <Card
          title="수집 데이터 원본 (AI 입력)" source={SOURCES.aiInput}
          subtitle={
            snapshot.data
              ? `${formatKst(snapshot.data.generatedAtKst)} · ${snapshot.data.chars.toLocaleString("ko-KR")}자`
              : undefined
          }
          actions={
            <CopyButton text={snapshot.data?.text} label="복사" disabled={!snapshot.data?.text} />
          }
        >
          {snapshot.loading && !snapshot.data && <Loading />}
          {/* 받지 못하면 이유 없이 빈 상자만 남았습니다(QA-132). */}
          {snapshot.error && <ErrorState message={snapshot.error} onRetry={snapshot.reload} />}
          {snapshot.data && (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-canvas p-3 text-xs leading-relaxed text-muted">
              {snapshot.data.text}
            </pre>
          )}
        </Card>
      )}

      {/* 실패 문구에는 엔진 라벨·'자동 탐색' 안내가 실려 예전 그림 문자가 섞여 옵니다 — 화면에서 뗍니다 */}
      {error && <Banner tone="danger">{withoutLeadingIcon(error)}</Banner>}

      {result && (
        <Card
          title={`${result.reportType ?? "AI 리포트"}`}
          source={`${result.provider ?? "AI"}가 대시보드 저장본을 읽고 쓴 해석 — 수치의 원래 출처는 입력 원본에 표기 · 투자 판단 근거 아님`}
          subtitle={
            result.status
              ? [
                  result.provider,
                  formatLatency(result.latencyMs),
                  result.usage
                    ? `토큰 입력 ${result.usage.inputTokens.toLocaleString("ko-KR")} · 출력 ${result.usage.outputTokens.toLocaleString("ko-KR")}`
                    : null,
                  result.translationInfo ?? null,
                  result.quota ? quotaLabel(result.quota) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
          actions={
            <span className="flex flex-wrap items-center gap-2">
              {result.model && <SourceBadge>{result.model}</SourceBadge>}
              {result.status && (
                <Button onClick={() => setShowRaw((value) => !value)}>
                  {showRaw ? "정리된 보기" : "원문(Markdown) 보기"}
                </Button>
              )}
              {result.status && (
                <CopyButton
                  text={result.response}
                  label="리포트 복사"
                  variant="primary"
                  disabled={!result.response}
                />
              )}
              {result.originalResponse && (
                <CopyButton text={result.originalResponse} label="번역 전 원문 복사" />
              )}
            </span>
          }
        >
          {!result.status ? (
            <Banner tone="danger">
              생성 실패: {withoutLeadingIcon(result.error ?? "")}
              {result.failoverPath && (
                <ul className="mt-2 list-disc pl-5 text-xs">
                  {result.failoverPath.map((step) => (
                    <li key={step}>{withoutLeadingIcon(step)}</li>
                  ))}
                </ul>
              )}
            </Banner>
          ) : (
            <>
              {result.failoverPath && result.failoverPath.length > 1 && (
                <p className="mb-3 text-xs text-muted">
                  폴오버 경로: {result.failoverPath.map((step) => withoutLeadingIcon(step)).join(" → ")}
                </p>
              )}
              {showRaw ? (
                <pre
                  tabIndex={0}
                  className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-canvas p-3 text-[12px] leading-relaxed text-body"
                >
                  {result.response}
                </pre>
              ) : (
                <ReportView markdown={result.response ?? ""} />
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}
