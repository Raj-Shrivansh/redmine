# Use official Ruby image
FROM ruby:3.2

# Install system dependencies
RUN apt-get update -qq && apt-get install -y \
  build-essential \
  libpq-dev \
  imagemagick \
  git \
  curl

# Install Node.js (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs

# Set working directory
WORKDIR /usr/src/redmine

# Copy FULL project
COPY . .

# Install bundler
RUN gem install bundler:2.4.22
ENV BUNDLER_VERSION=2.4.22

# Install gems
RUN bundle config set without 'development test' \
  && bundle install

# Install MCP dependencies
WORKDIR /usr/src/redmine/plugins/redmineflux_mcp/mcp-server
RUN npm install

# Back to root
WORKDIR /usr/src/redmine

# Make script executable
RUN chmod +x /usr/src/redmine/docker/start-redmine-mcp.sh

# Expose port
EXPOSE 3000

# Runtime env vars — override these in your docker run / docker-compose / Render dashboard
# Redmine config
ENV RAILS_ENV=production
ENV PORT=3000
ENV RAILS_INTERNAL_PORT=3001

# MCP config
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PATH=/mcp

# OAuth 2.0 — set these at runtime, NOT here (they contain secrets)
# OAUTH_CLIENT_ID=       <-- set in Render / docker-compose env
# OAUTH_CLIENT_SECRET=   <-- set in Render / docker-compose env
# MCP_PUBLIC_URL=        <-- e.g. https://your-app.onrender.com

# Fallback (if not using OAuth)
# REDMINE_API_KEY=       <-- set at runtime if needed

CMD ["/usr/src/redmine/docker/start-redmine-mcp.sh"]