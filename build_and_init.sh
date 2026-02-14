#!/bin/bash
set -e

echo "📦 Cleaning previous build..."
xattr -rc src/.build 2>/dev/null || true
rm -rf src/.build/release 2>/dev/null
make clean || true

echo "🏗️  Building and Installing VibeProxy..."
# Ensure we're using the standard PATH
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin

# Build and install to /Applications
make install

echo "🚀 Launching VibeProxy..."
open -a /Applications/VibeProxy.app

echo "✅ App installed to /Applications/VibeProxy.app and launched!"
echo "👉 Check the menu bar icon -> Settings -> Cursor (Pro). If it's not connected, paste your 'auth-personal.json' content there."
