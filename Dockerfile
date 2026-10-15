FROM node:22-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 仕様ファイルを同梱する場合は spec/ に置き、JUGAAD_OPENAPI=/app/spec/<ファイル名> を指定する
COPY spec ./spec
EXPOSE 8787
CMD ["node", "dist/http.js"]
