FROM python:3.12-slim

# psycopg2-binary ships its own libpq, so no build deps are needed.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

# Run as a non-root user.
RUN useradd --create-home --uid 10001 worker
USER worker

CMD ["python", "main.py"]
