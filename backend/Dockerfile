# 백엔드 이미지 (Java 21 + Spring Boot)
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

# 의존성 레이어를 먼저 캐시합니다(소스만 바뀌면 재다운로드하지 않습니다).
COPY pom.xml ./
RUN mvn -B -q dependency:go-offline

COPY src ./src
RUN mvn -B -q clean package -DskipTests

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

# wget은 헬스체크에 씁니다.
# apk upgrade: 베이스 이미지가 만들어진 뒤 alpine 저장소에 나온 수정판까지 올립니다(QA-263 — libexpat 2.9.0 HIGH가 남았음). 이 층을 새로
# 빌드할 때까지의 수정판입니다 — 베이스 digest와 이 줄이 같으면 build --pull도 캐시된 층을 다시 씁니다(정기 갱신은 QA-263 기록의 제안).
# root로 돌지 않습니다. 쓰는 곳은 /tmp(내장 톰캣 작업 폴더)뿐이고 app.jar는 읽기만 합니다.
RUN apk upgrade --no-cache \
    && apk add --no-cache wget tzdata \
    && addgroup -S app && adduser -S -G app -u 10001 app
ENV TZ=Asia/Seoul

COPY --from=build /build/target/*.jar app.jar

USER app

EXPOSE 8080

# 힙이 모자라면(OutOfMemoryError) 프로세스를 끝냅니다. 플래그가 없으면 OOM을 낸 스레드(톰캣 작업자·스케줄러)만 죽고
# JVM은 반쯤 망가진 채 남는데, /api/health가 계속 200이라 Docker가 다시 띄우지 않습니다. 끝나면(종료 코드 3)
# restart: unless-stopped가 새로 띄웁니다. 대가로 메모리 상태(데모 AI 공용 한도·로그인 제한·응답 캐시)가 비워집니다(ADR 0014).
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-XX:+ExitOnOutOfMemoryError", "-jar", "app.jar"]
