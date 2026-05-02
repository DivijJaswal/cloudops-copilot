FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN corepack enable && yarn install --ignore-scripts
COPY index.html ./
COPY src ./src
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN yarn build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
EXPOSE 8080
