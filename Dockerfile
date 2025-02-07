FROM node:18-alpine

WORKDIR /app

COPY . .

RUN npm install

RUN chmod -R 755 /app

EXPOSE 7860

CMD ["node", "server.js"]

