FROM node:24-alpine AS frontend-build
WORKDIR /frontend
ARG VITE_MAPBOX_TOKEN
ARG VITE_API_URL
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
ENV VITE_API_URL=$VITE_API_URL
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
COPY --from=frontend-build /frontend/dist ./public
ENV STATIC_DIR=/app/public
EXPOSE 3001
CMD ["npm", "start"]
