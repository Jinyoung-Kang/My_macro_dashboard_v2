/**
 * 명령 팔레트에는 쓰기 동작이 없다(작업대 실행 명세 §5·§9-6, ADR 0042 결정 5) — 예외 없음. 데이터 새로고침(POST /api/status/refresh)도 넣지 않습니다
 * (넓은 화면 상단바의 운영자 아이콘 단추와 좁은 화면 더보기에만).
 *
 * 세 겹으로 봅니다.
 * 1. 목록: 명령 효과가 모두 셸 명령(type "shell")이고 그 명령이 닫힌 셸 명령 목록(lib/shellCommands) 안이다.
 * 2. 소스: 팔레트 모듈 일곱의 import가 허용 목록 안이다(@/lib/api·useRefreshSignal·useAsyncAction·useTaskRunner·RefreshButton 불가).
 *    endpoints 접근은 GET 넷(매크로 개요·기관 목록·종목 목록·종목 찾기)뿐이고, fetch·method·폼 action·쓰기 함수 이름이 없다(TypeScript AST —
 *    주석·문자열은 보지 않음).
 * 3. 실행: 운영자(로그인 없는 로컬)로 그려 쓰기 같은 검색어와 명령 검색어를 넣어도 '명령' 결과는 허용한 둘뿐이고 이름에 쓰기 낱말이 없으며, 모든 명령을
 *    실행해도 apiPost·apiPatch·apiDelete·로그아웃·requestRefresh·fetch가 불리지 않고, 팔레트 안에 '데이터 수동 새로고침' 단추가 없다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTE_COMMANDS } from "@/lib/palette";
import { SHELL_COMMANDS, SHELL_COMMAND_EVENT, WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return {
    apiGet: vi.fn(),
    apiGetShared: vi.fn(),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
    UnauthorizedError,
    auth: { logout: vi.fn(), logoutOthers: vi.fn(), changePassword: vi.fn(), deleteAccount: vi.fn() },
  };
});
vi.mock("@/lib/api", () => api);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/macro", useRouter: () => router }));

const signal = vi.hoisted(() => ({
  token: 0, reloadAll: vi.fn(), notifyUnauthorized: vi.fn(), requestRefresh: vi.fn(), collecting: false, message: null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { resetRecentEntitiesForTest } from "@/hooks/useRecentEntities";
import { SearchCommand } from "../SearchCommand";

const SRC = resolve(__dirname, "../../..");

/** 팔레트 모듈 일곱(src 기준) — 명령 팔레트·단축키·도움말 창·최근 연 대상·셸 명령 신호. */
const PALETTE_MODULES = [
  "components/shell/SearchCommand.tsx",
  "components/shell/ShortcutHelp.tsx",
  "lib/palette.ts",
  "lib/shortcuts.ts",
  "hooks/useShellShortcuts.ts",
  "hooks/useRecentEntities.ts",
  "lib/shellCommands.ts",
];

/**
 * 팔레트 모듈이 가져와도 되는 모듈 — 화면 틀(React·Next 링크·이동), 공용 키트 조각(대화상자·아이콘·클래스), 읽기 훅(useApi — GET만, 공유 GET
 * apiGetShared), 순수 모듈. 새로 가져오려면 이 목록을 고치며 쓰기 경로가 아닌지 따집니다.
 */
const ALLOWED_IMPORTS = new Set([
  "react",
  "next/link",
  "next/navigation",
  "@/components/ui/classes",
  "@/components/ui/Dialog",
  "@/components/ui/icons",
  "@/hooks/useApi",
  "@/hooks/useRecentEntities",
  "@/hooks/useShellShortcuts",
  "@/lib/endpoints",
  "@/lib/nav",
  "@/lib/palette",
  "@/lib/search",
  "@/lib/shellCommands",
  "@/lib/shortcuts",
  "@/lib/types",
  "./icons",
  "./ShortcutHelp",
  "./detail",
  "./patternRows",
  "./search",
  "./shellCommands",
]);

/** 쓰기 경로 — API 쓰기 함수·수집 요청 신호·쓰기 동작 훅·새로고침 단추. 허용 목록에도 들어가면 안 됩니다. */
const FORBIDDEN_IMPORT = /^@\/lib\/api$|useRefreshSignal|useAsyncAction|useTaskRunner|RefreshButton/;

/** 팔레트가 읽어도 되는 경로(모두 GET — 회원 경로, AccessPolicy). */
const ALLOWED_ENDPOINTS = ["endpoints.macro.overview", "endpoints.institution.institutions", "endpoints.insight.stockUniverse", "endpoints.detail.symbols"];

/** 쓰기를 부르는 이름 — 식별자로 나오면 안 됩니다(주석·문자열은 보지 않음). */
const FORBIDDEN_IDENTIFIERS = new Set(["fetch", "apiPost", "apiPatch", "apiDelete", "requestRefresh", "useAsyncAction", "useTaskRunner", "RefreshButton"]);

type SourceFacts = { imports: string[]; endpointAccess: string[]; violations: string[] };

/** 소스 하나의 import·endpoints 접근·어긴 자리(fetch·method·폼 action·쓰기 이름·endpoints를 값으로 넘김). */
function sourceFacts(fileName: string, text: string): SourceFacts {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const facts: SourceFacts = { imports: [], endpointAccess: [], violations: [] };
  const at = (node: ts.Node) => `${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      facts.imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      facts.violations.push(`${at(node)}: 동적 import`);
    } else if (ts.isPropertyAccessExpression(node) && !ts.isPropertyAccessExpression(node.parent) && node.getText(source).startsWith("endpoints.")) {
      facts.endpointAccess.push(node.getText(source).replace(/\s+/g, ""));
    } else if (ts.isIdentifier(node)) {
      if (FORBIDDEN_IDENTIFIERS.has(node.text)) facts.violations.push(`${at(node)}: ${node.text}`);
      // endpoints는 가져오기와 속성 접근의 뿌리로만 — 값으로 넘기거나 대괄호로 꺼내면 어느 경로를 부르는지 소스에서 보이지 않습니다.
      if (node.text === "endpoints" && !ts.isImportSpecifier(node.parent) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
        facts.violations.push(`${at(node)}: endpoints를 값으로 씀`);
      }
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(source) === "method") {
      facts.violations.push(`${at(node)}: method`);
    } else if (ts.isJsxAttribute(node) && ["method", "action", "formAction"].includes(node.name.getText(source))) {
      facts.violations.push(`${at(node)}: JSX ${node.name.getText(source)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

describe("1. 명령 목록 — 셸 명령뿐", () => {
  it("명령은 닫힌 둘이고 효과가 모두 셸 명령(type shell) — 그 명령은 닫힌 셸 명령 목록 안", () => {
    expect(PALETTE_COMMANDS.map((command) => command.id)).toEqual(["command:shortcut-help", "command:toggle-nav"]);
    for (const command of PALETTE_COMMANDS) {
      expect(Object.keys(command.effect).sort(), command.id).toEqual(["command", "type"]);
      expect(command.effect.type, command.id).toBe("shell");
      expect(SHELL_COMMANDS, command.id).toContain(command.effect.command);
    }
    expect([...SHELL_COMMANDS]).toEqual(["toggle-nav", "open-shortcut-help"]);
  });
});

describe("2. 소스 — 쓰기 경로를 가져오지 않는다", () => {
  const facts = PALETTE_MODULES.map((path) => ({ path, ...sourceFacts(path, readFileSync(resolve(SRC, path), "utf8")) }));

  it("허용 목록에 쓰기 경로가 없다", () => {
    expect([...ALLOWED_IMPORTS].filter((name) => FORBIDDEN_IMPORT.test(name))).toEqual([]);
  });

  it("팔레트 모듈 일곱의 import가 허용 목록 안 — @/lib/api·useRefreshSignal·useAsyncAction·useTaskRunner·RefreshButton 없음", () => {
    const outside = facts.flatMap(({ path, imports }) => imports.filter((name) => !ALLOWED_IMPORTS.has(name)).map((name) => `${path}: ${name}`));
    expect(outside).toEqual([]);
    const forbidden = facts.flatMap(({ path, imports }) => imports.filter((name) => FORBIDDEN_IMPORT.test(name)).map((name) => `${path}: ${name}`));
    expect(forbidden).toEqual([]);
  });

  it("endpoints 접근은 GET 넷뿐이고, fetch·method·폼 action·쓰기 함수 이름·동적 import가 없다", () => {
    const access = [...new Set(facts.flatMap(({ endpointAccess }) => endpointAccess))].sort();
    expect(access).toEqual([...ALLOWED_ENDPOINTS].sort());
    expect(facts.flatMap(({ path, violations }) => violations.map((hit) => `${path}:${hit}`))).toEqual([]);
  });

  it("검사기 자체 — 어긴 자리를 찾고 주석·문자열은 건너뛴다", () => {
    const bad = sourceFacts("bad.tsx", [
      'import { apiPost } from "@/lib/api";',
      'import { useRefreshSignal } from "@/hooks/useRefreshSignal";',
      'import { endpoints } from "@/lib/endpoints";',
      "const run = () => apiPost(endpoints.status.refresh);",
      "const load = () => fetch(endpoints.macro.overview(false), { method: \"POST\" });",
      "const dyn = () => import(\"@/lib/api\");",
      "const pass = (e: unknown) => e; pass(endpoints);",
      "const form = <form action=\"/x\" method=\"post\" />;",
    ].join("\n"));
    expect(bad.imports).toEqual(["@/lib/api", "@/hooks/useRefreshSignal", "@/lib/endpoints"]);
    expect(bad.endpointAccess).toEqual(["endpoints.status.refresh", "endpoints.macro.overview"]);
    expect(bad.violations.map((hit) => hit.replace(/^\d+: /, ""))).toEqual([
      "apiPost", "apiPost", "fetch", "method", "동적 import", "endpoints를 값으로 씀", "JSX action", "JSX method",
    ]);

    const clean = sourceFacts("clean.ts", [
      "// apiPost와 fetch, method: 는 주석이라 건너뜀",
      'const note = "requestRefresh·fetch( 는 글";',
      "const row = { action: \"단축키 도움말\" };",
    ].join("\n"));
    expect(clean.violations).toEqual([]);
  });
});

describe("3. 실행 — 운영자로 모든 명령을 돌려도 쓰기가 불리지 않는다", () => {
  const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO", local: true };
  /** 쓰기 같은 검색어 — 화면의 쓰기 동작 이름들. */
  const WRITE_WORDS = ["새로고침", "수동", "수집", "결정 실행", "실행", "초기화", "일시정지", "실제 매매", "켜기", "끄기", "저장", "삭제", "승인", "refresh"];
  const ALLOWED_LABELS = PALETTE_COMMANDS.map((command) => command.label);
  const READ_PATHS = /^\/api\/(macro\/overview|sec13f\/institutions|stock\/universe|detail\/symbols)(\?|$)/;
  const fetchSpy = vi.fn();
  let shellCommands: string[];
  const record = (event: Event) => shellCommands.push(String((event as CustomEvent).detail));

  beforeEach(() => {
    window.localStorage.clear();
    resetRecentEntitiesForTest();
    shellCommands = [];
    window.addEventListener(SHELL_COMMAND_EVENT, record);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === WIDE_SHELL_MEDIA, media: query }) as MediaQueryList);
    vi.stubGlobal("fetch", fetchSpy);
    api.apiGetShared.mockReset();
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(() => {
    window.removeEventListener(SHELL_COMMAND_EVENT, record);
    cleanup();
    vi.unstubAllGlobals();
  });

  const trigger = () => screen.getByRole("button", { name: "종목·기관·지표·메뉴 검색" });
  const input = () => screen.getByRole("combobox", { name: "검색어" });
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  /** 결과 줄이 읽어 주는 글 — 왼쪽 원판(장식, aria-hidden — 명령은 키 글자)을 뺀 글. */
  const spokenText = (element: HTMLElement) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());
    return copy.textContent ?? "";
  };
  const commandLabels = () => {
    const group = screen.queryByRole("group", { name: "명령" });
    return group ? within(group).getAllByRole("option").map(spokenText) : [];
  };

  it("쓰기 같은 검색어·명령 검색어를 넣어도 '명령' 결과는 허용한 둘뿐이고 이름에 쓰기 낱말이 없다 — 팔레트 안에 '데이터 수동 새로고침'이 없다", async () => {
    render(<SearchCommand user={OWNER} />);
    fireEvent.click(trigger());
    await act(async () => {});
    const dialog = screen.getByRole("dialog", { name: "통합 검색" });
    const queries = [...WRITE_WORDS, ...PALETTE_COMMANDS.flatMap((command) => [command.label, ...command.keywords])];
    const seen = new Set<string>();
    for (const query of queries) {
      type(query);
      for (const label of commandLabels()) {
        const name = ALLOWED_LABELS.find((allowed) => label.startsWith(allowed));
        expect(name, `${query} → ${label}`).toBeTruthy();
        expect(WRITE_WORDS.filter((word) => label.includes(word)), `${query} → ${label}`).toEqual([]);
        seen.add(name as string);
      }
      expect(within(dialog).queryByRole("button", { name: "데이터 수동 새로고침" })).toBeNull();
      expect(within(dialog).queryByText(/데이터 수동 새로고침/)).toBeNull();
    }
    // 명령 검색어로는 두 명령이 모두 나왔다(넓은 화면).
    expect([...seen].sort()).toEqual([...ALLOWED_LABELS].sort());
  });

  it("모든 명령을 실행해도 apiPost·apiPatch·apiDelete·로그아웃·requestRefresh·fetch가 불리지 않고 이동도 없다 — 읽기는 GET 경로뿐", async () => {
    render(<SearchCommand user={OWNER} />);
    for (const command of PALETTE_COMMANDS) {
      fireEvent.click(trigger());
      await act(async () => {});
      type(command.label);
      fireEvent.click(within(screen.getByRole("group", { name: "명령" })).getByRole("option", { name: new RegExp(command.label) }));
      expect(screen.queryByRole("dialog", { name: "통합 검색" })).toBeNull();
      if (command.effect.command === "open-shortcut-help") {
        const help = await screen.findByRole("dialog", { name: "단축키" });
        expect(within(help).queryByRole("button", { name: "데이터 수동 새로고침" })).toBeNull();
        fireEvent.keyDown(help, { key: "Escape" });
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } else {
        await waitFor(() => expect(shellCommands).toContain(command.effect.command));
      }
    }
    expect(shellCommands).toEqual(["toggle-nav"]);
    for (const write of [api.apiPost, api.apiPatch, api.apiDelete, api.auth.logout, api.auth.logoutOthers, signal.requestRefresh, fetchSpy]) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(router.push).not.toHaveBeenCalled();
    const paths = api.apiGetShared.mock.calls.map(([path]) => String(path));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !READ_PATHS.test(path))).toEqual([]);
  });
});
