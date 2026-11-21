FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=3000 DB_PATH=/data/fanara.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "server/server.js"]
