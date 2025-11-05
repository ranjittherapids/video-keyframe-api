FROM node:20-slim

# Install ffmpeg (required for video processing)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js ./

# Create directories for uploads and temp files
RUN mkdir -p uploads temp

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]

