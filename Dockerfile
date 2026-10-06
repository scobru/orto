FROM node:22-slim
WORKDIR /app
COPY server.js orto.js ./
COPY web ./web
ENV HOST=0.0.0.0 PORT=8787 ORTO_DATA=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
