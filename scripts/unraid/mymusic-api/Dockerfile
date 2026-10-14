# The home API as an image: CI builds it on every push to main that touches this folder and publishes it to
# ghcr.io/lyvuong/mymusic-api; the Unraid server pulls it (see "Beets runs from the web app" in the README).
FROM python:3.12-alpine

# docker-cli: it runs `docker exec beets ...` through the mounted socket. inotify-tools: the inbox watcher (AUTO_IMPORT).
RUN apk add --no-cache docker-cli inotify-tools

WORKDIR /app
COPY server.py config.py util.py reporting.py locks.py edit.py http_handler.py watcher.py mixes.py albums.py ./
COPY jobs ./jobs

# Baked in by CI so /health can say which build is running.
ARG GIT_SHA=dev
ENV MYMUSIC_API_VERSION=$GIT_SHA

EXPOSE 8099
CMD ["python", "-u", "/app/server.py"]
