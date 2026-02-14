.PHONY: build app install clean run help smoke rapid lint-doctrine reset-runtime

help: ## Show this help message
	@echo "VibeProxy - macOS Menu Bar App"
	@echo ""
	@echo "Available targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Build the Swift executable (debug)
	@echo "🔨 Building Swift executable..."
	@cd src && swift build
	@echo "✅ Build complete: src/.build/debug/CLIProxyMenuBar"

release: ## Build the Swift executable (release)
	@echo "🔨 Building Swift executable (release)..."
	@./build.sh
	@echo "✅ Build complete: src/.build/release/CLIProxyMenuBar"

app: ## Create the .app bundle
	@echo "📦 Creating .app bundle..."
	@./create-app-bundle.sh
	@echo "✅ App bundle created: VibeProxy.app"

install: app ## Build and install to /Applications
	@echo "📲 Installing to /Applications..."
	@rm -rf "/Applications/VibeProxy.app"
	@cp -r "VibeProxy.app" /Applications/
	@echo "✅ Installed to /Applications/VibeProxy.app"

run: app ## Build and run the app
	@echo "🚀 Launching app..."
	@if [ -d "VibeProxy-dev.app" ]; then open "VibeProxy-dev.app"; else open "VibeProxy.app"; fi

clean: ## Clean build artifacts
	@echo "🧹 Cleaning..."
	@rm -rf src/.build
	@rm -rf "VibeProxy.app"
	@rm -rf src/Sources/Resources/cli-proxy-api
	@rm -rf src/Sources/Resources/config.yaml
	@rm -rf src/Sources/Resources/static
	@echo "✅ Clean complete"

test: ## Run a quick test build
	@echo "🧪 Testing build..."
	@cd src && swift build
	@echo "✅ Test build successful"

smoke: ## Run local cursor-proxy smoke checks
	@echo "🧪 Running cursor-proxy smoke test..."
	@bash "./scripts/smoke-cursor-proxy.sh"

rapid: app smoke ## Fast iterate loop: build app + smoke test
	@echo "⚡ Rapid iteration cycle complete"

reset-runtime: ## Kill stale app/proxy and clear smoke temp state
	@bash "./scripts/reset-runtime.sh"

lint-doctrine: ## Verify global AI lint doctrine files exist
	@echo "🧭 Checking global AI lint doctrine..."
	@[ -f "$$HOME/.cursor/.ai-lint/INDEX.md" ] || (echo "❌ Missing $$HOME/.cursor/.ai-lint/INDEX.md" && exit 1)
	@[ -f "$$HOME/.cursor/.ai-lint/PHILOSOPHY.md" ] || (echo "❌ Missing $$HOME/.cursor/.ai-lint/PHILOSOPHY.md" && exit 1)
	@[ -f "$$HOME/.cursor/.ai-lint/doctrine/languages/javascript.md" ] || (echo "❌ Missing javascript doctrine" && exit 1)
	@[ -f "$$HOME/.cursor/.ai-lint/rejects/languages/javascript.md" ] || (echo "❌ Missing javascript rejects" && exit 1)
	@[ -f "$$HOME/.cursor/.ai-lint/doctrine/languages/nodejs.md" ] || (echo "❌ Missing nodejs doctrine" && exit 1)
	@echo "✅ Global AI lint doctrine files present"

info: ## Show project information
	@echo "Project: VibeProxy - macOS Menu Bar App"
	@echo "Language: Swift 5.9+"
	@echo "Platform: macOS 13.0+"
	@echo ""
	@echo "Files:"
	@find src/Sources -name "*.swift" -exec wc -l {} + | tail -1 | awk '{print "  Swift code: " $$1 " lines"}'
	@echo "  Documentation: 4 files"
	@echo ""
	@echo "Structure:"
	@tree -L 3 -I ".build" || echo "  (install 'tree' for better output)"

open: ## Open app bundle to inspect contents
	@if [ -d "VibeProxy.app" ]; then \
		open "VibeProxy.app"; \
	else \
		echo "❌ App bundle not found. Run 'make app' first."; \
	fi

edit-config: ## Edit the bundled config.yaml
	@if [ -d "VibeProxy.app" ]; then \
		open -e "VibeProxy.app/Contents/Resources/config.yaml"; \
	else \
		echo "❌ App bundle not found. Run 'make app' first."; \
	fi

# Shortcuts
all: app ## Same as 'app'
