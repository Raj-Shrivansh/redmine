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

# Make script executable (important)
RUN chmod +x /usr/src/redmine/docker/start-redmine-mcp.sh

# Expose port (Render uses this)
EXPOSE 3000

# 🚀 Start BOTH Redmine + MCP
CMD ["/usr/src/redmine/docker/start-redmine-mcp.sh"]