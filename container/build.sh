#!/bin/bash
# Build the Astrobot agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="astrobot-agent"
TAG="${1:-latest}"

echo "Building Astrobot agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker
docker build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"Hello\",\"agentId\":\"test\",\"agentName\":\"test\",\"model\":\"openai/gpt-4o-mini\",\"systemPrompt\":\"You are a helpful assistant.\",\"isOrchestrator\":false,\"mcpServers\":[]}' | docker run -i --rm ${IMAGE_NAME}:${TAG}"
