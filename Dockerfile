FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "src/cli.mjs", "serve", "--host", "0.0.0.0", "--db", "/app/data/shared.sqlite"]
