FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs studio-flow-ui.html ./
COPY team ./team
RUN mkdir -p /app/team-data
ENV NODE_ENV=production
EXPOSE 4180
CMD ["node", "team/central-server.mjs"]
