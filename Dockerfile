FROM node:24.18.0-bookworm-slim

LABEL org.opencontainers.image.title="DaoCanon API" \
      org.opencontainers.image.description="Read-only DaoCanon corpus search and reader"

ENV HOST=0.0.0.0 PORT=3040 DAO_CANON_ROOT=/corpus
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3040

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3040/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
