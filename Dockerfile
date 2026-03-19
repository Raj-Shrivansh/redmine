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

# Copy FULL project first (important)
COPY . .

# Install correct bundler version
RUN gem install bundler:2.4.22
ENV BUNDLER_VERSION=2.4.22

# Install gems (after full code)
RUN bundle config set without 'development test' \
  && bundle install

# Install MCP server dependencies
WORKDIR /usr/src/redmine/plugins/redmineflux_mcp/mcp-server
RUN npm install

# Back to Redmine root
WORKDIR /usr/src/redmine

# Expose port
EXPOSE 3000

# Start app (ALL runtime tasks here)
CMD bash -c "\
  bundle exec rake generate_secret_token && \
  bundle exec rake db:migrate RAILS_ENV=production && \
  bundle exec rake redmine:plugins:migrate RAILS_ENV=production && \
  bundle exec rake assets:precompile RAILS_ENV=production && \
  bundle exec rails server -b 0.0.0.0 -p 3000"
