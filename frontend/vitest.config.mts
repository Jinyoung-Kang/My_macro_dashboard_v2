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
  },
});
