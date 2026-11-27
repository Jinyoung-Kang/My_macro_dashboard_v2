import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * 화면 훅·컴포넌트 테스트 (npm test).
 *
 * 순수 함수 검사(src/lib/__checks__, npm run check)는 그대로 두고, 여기서는 React로
 * 실제 렌더링해야 확인되는 것(훅의 상태 변화 등)만 다룹니다. 테스트 파일은
 * `src/**\/__tests__/*.test.ts(x)`입니다.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig의 jsx: "preserve"는 Next.js용입니다. 테스트에서는 컴포넌트를 직접 렌더링하므로 JSX를 변환합니다.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    // jsdom에 없는 브라우저 API(matchMedia 등)의 최소 스텁 — Radix 조각을 그리는 테스트용입니다.
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    // 시험 하나의 한도 20초(기본 5초) — 고장 감시일 뿐입니다(QA-1037). 조건을 기다리는 시험은 조건이 맞으면 바로 끝나므로 통과 시간은
    // 그대로이고, 전체 시험을 여러 벌 함께 돌릴 때 5초에 걸려 흔들리던 것만 막습니다. 조건 대기(findBy·waitFor) 5초는 vitest.setup.ts.
    // 시험·묶음마다 따로 한도를 적지 않습니다(값은 이 두 곳에서만).
    testTimeout: 20_000,
  },
});
