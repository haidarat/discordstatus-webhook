FROM node:22-alpine

WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=128
COPY package.json ./
COPY src ./src

USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
