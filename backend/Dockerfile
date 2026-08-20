FROM node:22-alpine

WORKDIR /app

# Dependencies install as their own layer so a source-only change does not
# refetch them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The route-sequence and stop-point caches live here. Attach a persistent volume
# at this path, or every restart spends ~7 minutes rebuilding route geometry from
# the TfL API.
#
# Deliberately no `VOLUME` instruction: Railway rejects the whole Dockerfile with
# "docker VOLUME at Line 15 is not supported, use Railway Volumes" rather than
# ignoring it, so the build never even starts. The mount is declared in the
# Railway dashboard instead (see railway.toml). Running this image under plain
# Docker, pass `-v wlm-cache:/app/.cache` yourself.
RUN mkdir -p /app/.cache

ENV NODE_ENV=production
ENV PORT=4010
EXPOSE 4010

# Init reaps the process properly so SIGTERM reaches Node and the server gets to
# run its graceful shutdown.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
