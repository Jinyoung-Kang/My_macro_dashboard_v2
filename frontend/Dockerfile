# 프런트엔드 이미지 (Next.js)
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 실행에 필요한 의존성만(dependencies — next·react·recharts·Radix). 빌드 도구(typescript·eslint·tailwind 등)는 운영
# 이미지에 넣지 않습니다.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 백엔드 주소는 빌드 시점에 번들에 들어갑니다(NEXT_PUBLIC_ 접두사).
# 비워 두면 화면이 열린 호스트 + 백엔드 포트를 실행 시점에 씁니다(휴대폰도 같은 호스트의 백엔드를 찾음).
ARG NEXT_PUBLIC_API_BASE=
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ARG NEXT_PUBLIC_BACKEND_PORT=8080
ENV NEXT_PUBLIC_BACKEND_PORT=$NEXT_PUBLIC_BACKEND_PORT

# 이 이미지가 "어느 코드"로 빌드됐는지 화면에 새겨 둡니다(브랜치@커밋).
# git pull을 했는데 화면이 그대로일 때, 코드를 안 받은 것인지 화면이 안 바뀐
# 것인지 구분할 방법이 없었습니다. 값은 make가 넣어 줍니다(없으면 빈 값).
ARG NEXT_PUBLIC_APP_VERSION=
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
# 그 커밋의 날짜(KST). 화면 왼쪽 아래 '최종 수정'에 쓰입니다(없으면 빈 값 — 표시 안 함).
ARG NEXT_PUBLIC_APP_UPDATED=
ENV NEXT_PUBLIC_APP_UPDATED=$NEXT_PUBLIC_APP_UPDATED

RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Seoul

COPY --from=build /app/package.json ./
# next start는 실행 시점에 이 파일을 읽습니다. 빠지면 poweredByHeader: false 같은 실행 설정이 무시돼
# X-Powered-By: Next.js가 다시 붙습니다(QA-002). headers()는 빌드 산출물에 들어가 영향이 없었습니다.
COPY --from=build /app/next.config.mjs ./
COPY --from=prod-deps /app/node_modules ./node_modules
# next start가 .next/cache에 쓰므로 그 폴더만 실행 사용자에게 줍니다. 나머지는 읽기 전용.
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public

# root로 돌지 않습니다(node 이미지에 들어 있는 비루트 사용자).
USER node

EXPOSE 3000
# npm을 거치지 않습니다 — npm이 PID 1이면 docker stop의 SIGTERM이 한 단계 더 거쳐 느리게 전달됩니다.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
