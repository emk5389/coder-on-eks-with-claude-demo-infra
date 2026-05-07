#!/bin/bash
set -e

# --- Git config ---
git config --global user.name "${git_user_name}"
git config --global user.email "${git_user_email}"
git config --global init.defaultBranch main

# --- Workspace secrets for interactive sessions ---
if [ -f "$HOME/.workspace-secrets" ]; then
  if ! grep -q "workspace-secrets" "$HOME/.bashrc" 2>/dev/null; then
    echo '[ -f ~/.workspace-secrets ] && source ~/.workspace-secrets' >> "$HOME/.bashrc"
  fi
fi

# --- Wait for Docker daemon ---
echo "Waiting for Docker daemon..."
timeout=60
while ! docker info >/dev/null 2>&1; do
  sleep 1
  timeout=$((timeout - 1))
  if [ $timeout -le 0 ]; then
    echo "WARNING: Docker daemon did not start within 60 seconds"
    break
  fi
done
if docker info >/dev/null 2>&1; then
  echo "Docker daemon ready."
fi

# --- Clone or update repo ---
REPO_DIR="/home/coder/workspace"

if [ -d "$REPO_DIR/.git" ]; then
  echo "Existing repo found, fetching latest..."
  cd "$REPO_DIR"
  git fetch origin || true
else
  echo "Cloning repo..."
  git clone "${repo_url}" "$REPO_DIR" || true
  cd "$REPO_DIR"
fi

# --- Install dependencies ---
if [ -f "$REPO_DIR/Makefile" ]; then
  echo "Running make install..."
  cd "$REPO_DIR"
  make install || echo "WARNING: make install failed, continuing..."
fi

echo "Workspace ready."
