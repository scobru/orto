FROM node:22-slim
WORKDIR /app
COPY server.js ./
# web app from the zenos-web repo (override with --build-arg WEB_REF=main once merged)
ARG WEB_REF=claude/zenos-self-hosted-mysql-xuzi5p
ADD https://github.com/scobru/zenos-web.git#${WEB_REF}:app /web
ENV HOST=0.0.0.0 PORT=8787 ZENOS_DATA=/data ZENOS_WEB=/web
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
