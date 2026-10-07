# ---- ขั้นตอน build ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npx tsc -p tsconfig.json

# ---- ขั้นตอนรันจริง ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY prisma ./prisma

# Prisma 7 ต่อฐานข้อมูลผ่าน driver adapter จึงไม่ต้องมี engine binary ในอิมเมจ
EXPOSE 4000
CMD ["node", "dist/server.js"]
