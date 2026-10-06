FROM node:22-slim
WORKDIR /app
COPY server.js orto.js demo.js ./
COPY web ./web
COPY scripts ./scripts
# Optional on-device tag suggestions (Gist by Desert Ant Labs, source-available licence): docker build --build-arg ORTO_GIST=1 .
# Installed in the image (/app/models), not in the data volume, so it also works with a volume that already has data.
ARG ORTO_GIST=0
RUN if [ "$ORTO_GIST" = "1" ]; then node scripts/install-gist.mjs --models /app/models; fi
ENV HOST=0.0.0.0 PORT=8787 ORTO_DATA=/data ORTO_MODELS=/app/models
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
