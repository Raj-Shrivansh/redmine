# Use official Ruby image (compatible with Redmine 5.x)
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

# Enable Yarn via Corepack (modern way)
RUN corepack enable && corepack prepare yarn@stable --activate

# Set working directory
WORKDIR /usr/src/redmine

# Copy Gemfile first (for caching)
COPY Gemfile Gemfile.lock ./

# Install bundler & gems
RUN gem install bundler -v 2.4.22
RUN bundle install --without development test

# Copy full Redmine code
COPY . .

WORKDIR /usr/src/redmine/plugins/redmineflux_mcp/mcp-server
RUN npm install

# Back to root
WORKDIR /usr/src/redmine
# Generate secret token (required)
RUN bundle exec rake generate_secret_token

# Precompile assets
RUN RAILS_ENV=production bundle exec rake assets:precompile

# Expose port
EXPOSE 3000

# Start command (with DB + plugin migrations)
CMD bash -c "\
  bundle exec rake db:migrate RAILS_ENV=production && \
  bundle exec rake redmine:plugins:migrate RAILS_ENV=production && \
  bundle exec rails server -b 0.0.0.0 -p 3000"
