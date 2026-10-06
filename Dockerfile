FROM node:22-slim
WORKDIR /app
COPY server.js ./
ENV HOST=0.0.0.0 PORT=8787 ZENOS_DATA=/data ZENOS_WEB=/web
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
