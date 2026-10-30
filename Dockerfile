# TGP (Task Gate Protocol) server in a container.
# Build:  docker build -t tgp .
# Run:    docker run -d --name tgp -p 8787:8787 -v tgp-data:/data tgp
# Canvas: http://localhost:8787
FROM node:20-alpine

WORKDIR /app

# Dependencies first, so code changes do not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Runs, config.json and your own workflows live in /data (mount a volume to keep them).
# Windows toast notifications do not exist inside Linux, so they are off here.
ENV TGP_HOME=/data \
    TGP_PORT=8787 \
    TGP_NOTIFY=0 \
    NODE_ENV=production
RUN mkdir -p /data/workflows
VOLUME /data

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/ >/dev/null || exit 1

ENTRYPOINT ["node", "bin/tgp.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8787"]
