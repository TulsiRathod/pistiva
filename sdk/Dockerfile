# Runs the end-to-end demo (two supplier gateways + buyer flow) against the platform.
FROM node:24-alpine
WORKDIR /sdk
COPY package.json package-lock.json ./
COPY packages/agent-sdk/package.json packages/agent-sdk/
COPY packages/gateway/package.json packages/gateway/
COPY examples/buyer-agent/package.json examples/buyer-agent/
COPY examples/supplier-agent/package.json examples/supplier-agent/
RUN npm ci --no-audit --no-fund
COPY . .
CMD ["npm", "run", "demo"]
