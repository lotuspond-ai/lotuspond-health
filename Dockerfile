# LotusPond Health: one image serving the API and the built frontend.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY server/drizzle ./server/drizzle
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
WORKDIR /app/server
CMD ["node", "dist/index.js"]
