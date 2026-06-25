FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

ENV TRANSPORT=http
ENV PORT=3100

EXPOSE 3100

CMD ["node", "dist/index.js"]
