# ---- Build stage ----
FROM node:20 AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# ---- Config (injected at runtime as env vars) ----
# In production, secrets come from AWS Secrets Manager (getAppSecrets /
# getDBSecrets); only the ARNs, region and port are needed here. Set
# IS_LOCAL=true to source all config from env instead (no AWS calls) — §10.
ARG AWS_REGION
ARG AWS_SECRET_ARN
ARG AWS_DB_SECRET_ARN
ARG NODE_ENV
ARG PORT=3002

ENV AWS_REGION=$AWS_REGION
ENV AWS_SECRET_ARN=$AWS_SECRET_ARN
ENV AWS_DB_SECRET_ARN=$AWS_DB_SECRET_ARN
ENV NODE_ENV=$NODE_ENV
ENV PORT=$PORT

EXPOSE $PORT

CMD ["node", "dist/index.js"]
