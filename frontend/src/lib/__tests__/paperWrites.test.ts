/**
 * 모의매매 쓰기 지킴 — 작업대 개편 P6(부분 재배치)이 머리 '동작'·목록-검사로 단추를 옮겨도 쓰기(POST·DELETE)의 경로·본문과 확인 단계가 그대로인지
 * 소스(TypeScript AST)로 봅니다(계획 §4-1 P2). 개편 전 코드에서 통과시켜 두고, 개편 커밋들이 이 파일을 고치지 않고 통과해야 합니다.
 *
 * - 쓰기 22곳: `components/screens/paper/` 아래 .tsx(시험 제외)의 `apiPost(…)`·`apiDelete(…)` 호출 인자 글을 공백을 정규화해 고정 목록과 대조합니다
 *   (여러 벌 목록 — 파일이 바뀌어도 글이 같으면 통과). 지역 이름 `paths`는 그 파일의 `const paths = …` 글로 풀어 어느 시장 경로인지까지 봅니다.
 * - 확인 창(ConfirmDialog): 셋(계좌 초기화·한국 출발·규칙 계좌 영향 설정 저장)의 제목·설명·확인 단추 글·톤·입력 글자·확인 동작. 계좌 초기화는
 *   `requireText={code}`·`tone="danger"`이고 친 글자를 그대로 보냅니다(서버가 다시 봄). 설명 안 className은 겉모양이라 빼고 봅니다.
 * - 화면 안 확인 상자의 글: 확인 글 상수·함수(CLAUDE_COST_NOTE·REVIEW_COST_NOTE·APPROVE_COST_NOTE·settingsConfirmText·noteArchiveConfirm)를 쓰는 자리의 글.
 * - 실제 계좌·ISA·실제 매매 모듈(`screens/realtrade`·`screens/isa`·`screens/brokerage`)은 이 시험 밖입니다(그 모듈의 시험·경계 시험이 지킴).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PAPER = resolve(__dirname, "../../components/screens/paper");

/** 모의 화면 소스(.tsx, 시험 폴더 제외). */
function paperSources(dir = PAPER): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...paperSources(path));
    } else if (name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out.sort();
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** 공백 정규화 — 줄바꿈·들여쓰기를 한 칸으로, 괄호 안쪽·쉼표 앞 공백과 끝 쉼표를 뺍니다(포맷만 다른 글을 같게). */
function normalize(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([([{]) /g, "$1")
    .replace(/ ([)\]},])/g, "$1")
    .replace(/,([)\]}])/g, "$1")
    .trim();
}

/** 파일의 `const paths = …` 초기값 글(정규화) — 없으면 null, 서로 다른 둘 이상이면 시험 실패(어느 것인지 모름). */
function pathsInitializer(source: ts.SourceFile): string | null {
  const found = new Set<string>();
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "paths" && node.initializer) {
      found.add(normalize(node.initializer.getText(source)));
    }
  });
  expect(found.size, `${relative(PAPER, source.fileName)}의 paths 선언`).toBeLessThanOrEqual(1);
  return found.size === 1 ? [...found][0] : null;
}

/** 쓰기 호출 글 — `apiPost(인자…)`·`apiDelete(인자…)`(형 인자 없이, `paths.`는 그 파일의 선언으로 풀어 씀). */
function writeCalls(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const path of paperSources()) {
    const source = parse(path);
    const paths = pathsInitializer(source);
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const callee = node.expression.text;
      if (callee !== "apiPost" && callee !== "apiDelete") return;
      let args = node.arguments.map((argument) => normalize(argument.getText(source))).join(", ");
      if (paths !== null) args = args.replace(/\bpaths\./g, `${paths}.`);
      out.push({ file: relative(PAPER, path), text: `${callee}(${args})` });
    });
  }
  return out;
}

/** 쓰기 22곳의 글 — 정렬한 여러 벌 목록(같은 글이 여러 곳이면 그 수만큼). */
const WRITES = [
  // 시작 카드 다섯 — Claude 계좌1 미리보기·시작, 계좌2 출발, 한국 초기화·출발
  'apiPost(endpoints.paper.runInitialDecision, {book, preview: true})',
  'apiPost(endpoints.paper.runInitialDecision, {book})',
  'apiPost(endpoints.paper.runInitialDecision, {book})',
  'apiPost(endpoints.paper.market("KR").init)',
  'apiPost(endpoints.paper.market("KR").runInitialDecision)',
  // 개요 셋 — 초기화·리스크 지금 실행·규칙 계좌 시작
  'apiPost(endpoints.paper.market(market).init)',
  'apiPost(endpoints.paper.market(market).runRisk)',
  'apiPost(endpoints.paper.runInitialDecision, {book})',
  // 보유·체결 둘 — 일시정지/재개·계좌 초기화(친 글자 그대로)
  'apiPost(endpoints.paper.bookStatus(bookCode), {status})',
  'apiPost(endpoints.paper.bookReset(bookCode), {confirm})',
  // 결정 로그 — 지금 결정 실행(한국은 ?market=KR)
  'apiPost(korea ? endpoints.paper.market("KR").runDecision : endpoints.paper.runDecision, {book})',
  // 장중 판단 요청
  'apiPost(korea ? endpoints.paper.market("KR").runIntraday : endpoints.paper.market("US").runIntraday, {book: code})',
  // 주간 복기 실행
  'apiPost(endpoints.paper.market(market).runReview)',
  // 기관 선정 — 재계산
  'apiPost(endpoints.paper.runRerank, {})',
  // 메모 둘 — 저장·보관
  'apiPost(endpoints.paper.createNote, payload)',
  'apiDelete(endpoints.paper.archiveNote(id))',
  // 프레임 다섯 — 방법론 메모 저장·제안 요청·승인·거절·직접 고치기
  'apiPost(endpoints.paper.createNote, payload)',
  'apiPost(endpoints.paper.propose, {noteId})',
  'apiPost(endpoints.paper.approveProposal(id))',
  'apiPost(endpoints.paper.rejectProposal(id))',
  'apiPost(endpoints.paper.saveFramework, payload)',
  // 설정 저장
  'apiPost(endpoints.paper.saveSettings, patch)',
].sort();

/** JSX 속성 하나의 글(정규화, className 속성은 겉모양이라 뺌) — 없으면 null. */
function attribute(element: ts.JsxOpeningLikeElement, name: string, source: ts.SourceFile): string | null {
  const found = element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(source) === name,
  );
  if (!found) return null;
  if (!found.initializer) return "true";
  return normalize(found.initializer.getText(source).replace(/\s*className=(?:"[^"]*"|\{[^}]*\})/g, ""));
}

/** 확인 창(ConfirmDialog)마다 뜻을 정하는 속성 — 여닫힘·처리 중 표시(open·onOpenChange·busy)는 상태 배선이라 보지 않습니다. */
const DIALOG_PROPS = ["title", "description", "confirmLabel", "tone", "requireText", "onConfirm"] as const;

function confirmDialogs(): { file: string; props: Record<string, string | null> }[] {
  const out: { file: string; props: Record<string, string | null> }[] = [];
  for (const path of paperSources()) {
    const source = parse(path);
    walk(source, (node) => {
      if (!(ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))) return;
      if (node.tagName.getText(source) !== "ConfirmDialog") return;
      out.push({ file: relative(PAPER, path), props: Object.fromEntries(DIALOG_PROPS.map((name) => [name, attribute(node, name, source)])) });
    });
  }
  return out;
}

/** 확인 글 상수·함수 — 쓰는 자리의 글을 봅니다. */
const CONFIRM_NAMES = ["CLAUDE_COST_NOTE", "REVIEW_COST_NOTE", "APPROVE_COST_NOTE", "settingsConfirmText", "noteArchiveConfirm"] as const;

/** JSX 요소의 자식 글 — 글은 그대로(정규화), 식은 `{식}`, 요소는 `<태그>`. */
function childText(element: ts.JsxElement, source: ts.SourceFile): string {
  return normalize(
    element.children
      .map((child) => {
        if (ts.isJsxText(child)) return child.text;
        if (ts.isJsxExpression(child)) return child.expression ? `{${child.expression.getText(source)}}` : "";
        if (ts.isJsxElement(child)) return `<${child.openingElement.tagName.getText(source)}>`;
        if (ts.isJsxSelfClosingElement(child)) return `<${child.tagName.getText(source)} />`;
        return "";
      })
      .join(""),
  );
}

/** 이름마다 쓰는 자리의 글 — JSX 자식이면 그 요소의 자식 글, 함수 호출이면 그 호출 글. 가져오기(import)는 세지 않습니다. */
function confirmUses(): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(CONFIRM_NAMES.map((name) => [name, [] as string[]]));
  for (const path of paperSources()) {
    const source = parse(path);
    walk(source, (node) => {
      if (!ts.isIdentifier(node) || !(CONFIRM_NAMES as readonly string[]).includes(node.text)) return;
      // 가져오기 목록의 이름은 쓰는 자리가 아닙니다.
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) if (ts.isImportDeclaration(up)) return;
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
      const used: ts.Node = call ?? node;
      const expression = used.parent;
      if (expression && ts.isJsxExpression(expression) && expression.parent && ts.isJsxElement(expression.parent)) {
        out[node.text].push(childText(expression.parent, source));
      } else {
        out[node.text].push(normalize(used.getText(source)));
      }
    });
  }
  for (const name of CONFIRM_NAMES) out[name].sort();
  return out;
}

describe("모의매매 쓰기 지킴", () => {
  it("쓰기 22곳 — apiPost·apiDelete의 경로·본문 글이 고정 목록과 같다(파일과 상관없이)", () => {
    const calls = writeCalls();
    expect(calls).toHaveLength(22);
    expect(calls.map((call) => call.text).sort()).toEqual(WRITES);
  });

  it("확인 창 셋 — 계좌 초기화는 계좌 코드를 그대로 쳐야 하고(requireText={code}) 위험 톤, 친 글자를 그대로 보냄", () => {
    const dialogs = confirmDialogs();
    expect(dialogs).toHaveLength(3);
    const reset = dialogs.filter((dialog) => dialog.props.requireText !== null);
    expect(reset).toHaveLength(1);
    expect(reset[0].props.requireText).toBe("{code}");
    expect(reset[0].props.tone).toBe('"danger"');
    expect(reset[0].props.onConfirm).toBe("{(typed) => void runReset(typed)}");
    expect(reset[0].props.title).toBe("{`${book?.label ?? code} 초기화`}");
    expect(reset[0].props.confirmLabel).toBe('{reset.busy ? "초기화 중…" : "초기화 확인"}');

    const others = dialogs.filter((dialog) => dialog.props.requireText === null).map((dialog) => dialog.props);
    expect(others).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: '"한국 출발을 지금 실행할까요?"',
          confirmLabel: '"출발 실행"',
          tone: null,
          onConfirm: "{() => void runStart()}",
        }),
        expect.objectContaining({
          title: '"규칙 계좌 영향 설정 저장"',
          description: "{<p>{confirmText}</p>}",
          confirmLabel: '{save.busy ? "저장 중…" : "저장 확인"}',
          tone: null,
          onConfirm: "{() => void submit()}",
        }),
      ]),
    );
    // 한국 출발 설명 — 수동 호출 문턱과 오늘 쓴 횟수를 그대로 적습니다(글 고정).
    const krStart = others.find((props) => props.title === '"한국 출발을 지금 실행할까요?"');
    expect(krStart?.description).toContain("정기 출발과 같은 창·같은 자료 게이트로 네 계좌를 한 번에 출발시킵니다.");
    expect(krStart?.description).toContain("실패하면 그 세션은 다음 KR 거래일로 미뤄지고 같은 창에서 다시 부르지 않습니다.");
  });

  it("규칙 계좌 영향 확인 글은 settingsConfirmText(바꾼 값)에서 — 화면 안 확인 상자의 비용·보관 글은 상수·함수 그대로", () => {
    expect(confirmUses()).toEqual({
      CLAUDE_COST_NOTE: [
        "{bookLabel || book} 계좌의 장중 판단을 지금으로 당길까요? 가장 이른 남은 예약을 1분 뒤로 옮기거나(없으면 새로 넣고), 서버가 그 시각 + 2분 뒤 창에서 Claude를 한 번 부릅니다. {CLAUDE_COST_NOTE}",
        "Claude를 지금 부를까요? {CLAUDE_COST_NOTE}",
      ].sort(),
      REVIEW_COST_NOTE: ["Claude를 지금 부를까요? {REVIEW_COST_NOTE}"],
      APPROVE_COST_NOTE: ["{APPROVE_COST_NOTE}"],
      settingsConfirmText: ["settingsConfirmText(changes)"],
      noteArchiveConfirm: ["{noteArchiveConfirm(confirmingRow)}"],
    });
  });
});
