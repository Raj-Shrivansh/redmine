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

# Copy full project
COPY . .

# Install bundler
RUN gem install bundler:2.4.22
ENV BUNDLER_VERSION=2.4.22

# Install Redmine gems
RUN bundle config set without 'development test' \
  && bundle install

# Build MCP server (TypeScript -> dist)
WORKDIR /usr/src/redmine/mcp-redmine-oauth-js
RUN npm ci \
  && npm run build \
  && npm prune --omit=dev

# Back to root
WORKDIR /usr/src/redmine

# Make start script executable
RUN chmod +x /usr/src/redmine/docker/start-redmine-mcp.sh

# Railway public port
EXPOSE 3000

# Start both Redmine + MCP
CMD ["/usr/src/redmine/docker/start-redmine-mcp.sh"]
