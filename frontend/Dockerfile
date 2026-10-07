FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html api.js charts.js app.js /usr/share/nginx/html/
EXPOSE 80
