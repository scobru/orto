FROM node:22-slim
WORKDIR /app
COPY server.js ./
# web app from the zenos-web repo (pin another branch/tag with --build-arg WEB_REF=...)
ARG WEB_REF=main
ADD https://github.com/scobru/zenos-web.git#${WEB_REF}:app /web
ENV HOST=0.0.0.0 PORT=8787 ZENOS_DATA=/data ZENOS_WEB=/web
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings", "server.js"]
