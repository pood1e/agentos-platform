FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
RUN rm /etc/nginx/conf.d/default.conf
COPY web/templates/ /etc/nginx/templates/
COPY web/mcp-app-sandbox.html /usr/share/nginx/sandbox/
COPY dist/ /usr/share/nginx/html/
EXPOSE 8080 8081
