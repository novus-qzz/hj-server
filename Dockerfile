FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py proxy_pool.py self_resolver.py ./
ENV PYTHONUNBUFFERED=1
# Cloady 平台注入 PORT 环境变量；server.py 优先读 PORT
EXPOSE 18787
CMD ["python", "server.py"]
