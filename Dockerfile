FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json protocol.js server.js README.md ./
COPY --chown=node:node public ./public

RUN mkdir -p /data/backups \
    && chown -R node:node /data

ENV HOST=0.0.0.0
ENV PORT=4173
ENV BACKUP_DIR=/data/backups

VOLUME ["/data"]
EXPOSE 4173
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4173/health || exit 1

CMD ["node", "server.js"]
