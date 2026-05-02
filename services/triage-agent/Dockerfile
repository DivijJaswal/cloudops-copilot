FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/triage-agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN useradd --create-home --uid 10001 appuser
COPY --chown=appuser:appuser services/triage-agent/app ./app
COPY --chown=appuser:appuser data/past_triage_cases.json ./data/past_triage_cases.json
WORKDIR /app/app
ENV CLOUDOPS_REPO_ROOT=/app
ENV TRIAGE_AGENT_HOST=0.0.0.0
ENV TRIAGE_AGENT_PORT=5001
EXPOSE 5001
USER appuser
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--workers", "1", "--threads", "4", "--timeout", "120", "server:app"]
