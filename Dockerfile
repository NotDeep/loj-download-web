FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production

COPY . .

ENV PORT=3000
ENV STORAGE_DIR=/data

VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "bin/loj-download-web.js"]
