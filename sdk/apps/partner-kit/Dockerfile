# Build from the sdk/ directory:  docker build -f apps/partner-kit/Dockerfile -t pistiva-node .
FROM node:24-alpine
WORKDIR /sdk
COPY package.json package-lock.json ./
COPY packages/agent-sdk/package.json packages/agent-sdk/
COPY packages/gateway/package.json packages/gateway/
COPY packages/procurement/package.json packages/procurement/
COPY apps/partner-kit/package.json apps/partner-kit/
COPY examples/buyer-agent/package.json examples/buyer-agent/
COPY examples/supplier-agent/package.json examples/supplier-agent/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/partner-kit apps/partner-kit
RUN npm run build:web -w @pistiva/partner-kit
WORKDIR /sdk/apps/partner-kit
ENV NODE_ENV=production PORT=9300
EXPOSE 9300
USER node
CMD ["npx", "tsx", "server/main.ts"]