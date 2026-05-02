FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY services/incident-api/package.json ./
RUN yarn install --production --ignore-scripts && yarn cache clean
COPY --chown=node:node services/incident-api/src ./src
COPY --chown=node:node services/incident-api/migrations ./migrations
COPY --chown=node:node data ./data
ENV INCIDENT_API_PORT=8080
ENV INCIDENT_API_HOST=0.0.0.0
ENV CLOUDOPS_REPO_ROOT=/app
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
