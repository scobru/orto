FROM node:22-slim
WORKDIR /app
COPY server.js orto.js demo.js ./
COPY web ./web
COPY scripts ./scripts
# Optional on-device tag and emoji suggestions (Gist and Emo by Desert Ant Labs, source-available licence). On by default, which also covers hosts that build
# this Dockerfile directly and ignore compose.yml; leave it out with: --build-arg ORTO_GIST=0 (about 130 MB smaller, no npm at build time).
# Installed in the image (/app/models), not in the data volume, so it also works with a volume that already has data.
ARG ORTO_GIST=1
RUN if [ "$ORTO_GIST" = "1" ]; then node scripts/install-gist.mjs --models /app/models || echo "Gist install failed: tag suggestions stay off"; fi
# Optional in-browser assistant (scripts/install-llm.mjs): only the ~40 MB runtime; the model weights are downloaded by each browser. Off by default;
# turn on with: --build-arg ORTO_LLM=1, and pick another ONNX model with --build-arg ORTO_LLM_MODEL=<hf repo>.
ARG ORTO_LLM=0
ARG ORTO_LLM_MODEL=
RUN if [ "$ORTO_LLM" = "1" ]; then node scripts/install-llm.mjs --models /app/models ${ORTO_LLM_MODEL:+--model "$ORTO_LLM_MODEL"} || echo "Assistant install failed: the Assistant entry stays hidden"; fi
ENV HOST=0.0.0.0 PORT=8787 ORTO_DATA=/data ORTO_MODELS=/app/models
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
