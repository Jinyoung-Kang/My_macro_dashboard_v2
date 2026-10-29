# 잠금화면(gate) — 표준 라이브러리만 쓰므로 설치할 패키지가 없다.
FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 GATE_LISTEN=0.0.0.0:8100
WORKDIR /app
COPY gate.py services.json ./
USER 65534:65534
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/__gate/healthz', timeout=2).status == 200 else 1)"]
ENTRYPOINT ["python", "-I", "gate.py"]
