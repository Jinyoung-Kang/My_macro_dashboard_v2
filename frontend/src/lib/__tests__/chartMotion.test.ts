/**
 * 차트 움직임 — 소스 검사(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-8 '숫자·차트 애니메이션 없음').
 *
 * Recharts 3.10.1의 isAnimationActive 기본값은 'auto'(움직임 줄이기를 켜지 않은 화면에서는 움직임)라, 넘기지 않은 자리는 툴팁이 0.4초 미끄러지고
 * (transform 400ms ease) 산점 기호가 0에서 자라며 등장합니다(QA-500 — 래퍼 차트 넷·도넛 툴팁·산점도). 차트 두 파일(charts/index.tsx·LineChart.tsx)의
 * Recharts 요소(Tooltip·Scatter·Line·Bar·Pie·Area)가 모두 isAnimationActive={false}를 갖거나, 그것을 담은 tooltipStyle()을 펼치는지 봅니다 —
 * 새 차트가 들어와도 같은 규칙이 지켜지게. 실제 툴팁의 transition은 wrappers.test·DonutChart.test가 그려서 봅니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
const CHART_FILES = ["components/charts/index.tsx", "components/charts/LineChart.tsx"];
const ANIMATED_TAGS = new Set(["Tooltip", "Scatter", "Line", "Bar", "Pie", "Area"]);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(resolve(SRC, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const isFalse = (node: ts.Node | undefined) => node?.kind === ts.SyntaxKind.FalseKeyword;

/** JSX 속성 묶음이 isAnimationActive={false}를 갖거나 tooltipStyle()을 펼치는가. */
function staysStill(attributes: ts.JsxAttributes): boolean {
  return attributes.properties.some((entry) => {
    if (ts.isJsxAttribute(entry) && entry.name.getText() === "isAnimationActive") {
      return !!entry.initializer && ts.isJsxExpression(entry.initializer) && isFalse(entry.initializer.expression);
    }
    if (ts.isJsxSpreadAttribute(entry)) {
      const call = entry.expression;
      return ts.isCallExpression(call) && call.expression.getText() === "tooltipStyle";
    }
    return false;
  });
}

/** 파일 안 Recharts 움직임 요소(여는 꼬리표)마다 "줄: 이름 · 멈춤 여부". */
function animatedElements(file: string): { where: string; still: boolean }[] {
  const source = parse(file);
  const found: { where: string; still: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (ANIMATED_TAGS.has(tag)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push({ where: `${file}:${line} <${tag}>`, still: staysStill(node.attributes) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** charts/index.tsx tooltipStyle()이 돌려주는 객체 리터럴의 isAnimationActive 값이 false인가. */
function tooltipStyleStill(): boolean {
  const source = parse("components/charts/index.tsx");
  let still = false;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "tooltipStyle") {
      const ret = node.body?.statements.find(ts.isReturnStatement);
      const value = ret?.expression;
      if (value && ts.isObjectLiteralExpression(value)) {
        still = value.properties.some(
          (entry) => ts.isPropertyAssignment(entry) && entry.name.getText(source) === "isAnimationActive" && isFalse(entry.initializer),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return still;
}

describe("차트 움직임 없음(명세 §3-8)", () => {
  // QA-500: tooltipStyle()이 isAnimationActive를 넘기지 않아 그것을 펼치는 <Tooltip> 넷(여러 선·가로 막대·세로 막대·산점도)과 도넛의 <Tooltip>,
  // <Scatter>가 Recharts 기본값 'auto'를 따랐습니다(QA 스택 1440 — 툴팁 'transform 0.4s', 산점 기호 폭 0 → 9.0이 약 490ms). 재현 커밋에서는 it.fails입니다.
  it.fails("QA-500: 차트 두 파일의 Tooltip·Scatter·Line·Bar·Pie·Area는 모두 isAnimationActive={false}(또는 그것을 담은 tooltipStyle() 펼침)", () => {
    const elements = CHART_FILES.flatMap(animatedElements);
    // 검사기가 요소를 찾는지 — 선·막대·도넛·산점도·툴팁이 모두 있어야 합니다.
    for (const tag of ["Tooltip", "Scatter", "Line", "Bar", "Pie"]) {
      expect(elements.some((entry) => entry.where.endsWith(`<${tag}>`)), tag).toBe(true);
    }
    expect(elements.filter((entry) => !entry.still).map((entry) => entry.where)).toEqual([]);
    expect(tooltipStyleStill(), "tooltipStyle()의 isAnimationActive: false").toBe(true);
  });
});
