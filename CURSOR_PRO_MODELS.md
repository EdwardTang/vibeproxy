# Cursor Pro Model Mapping Reference

This document contains a comprehensive breakdown of Cursor's internal model slugs, server-side mappings, and architectural insights.

## Technical Research

The model list lives in Cursor's server-side API (`aiserver.v1.CppService.AvailableModels` protobuf RPC), and the client caches it in the local SQLite database:

**Path:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`  
**Key:** `src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser` → `availableDefaultModels2`

---

## Complete Model ID Mapping
*Cursor Website Name → Internal Model Slugs*

Each "website model" often maps to multiple internal slugs (thinking vs non-thinking variants, effort levels, fast modes).

### Anthropic Models

| Website Name | Internal Slug(s) | Server Model Name | Notes |
| :--- | :--- | :--- | :--- |
| **Claude 4.6 Opus** | `claude-4.6-opus-high` | `claude-4.6-opus-high` | Non-thinking, high effort |
| | `claude-4.6-opus-high-thinking` | `claude-4.6-opus-high-thinking` | **DEFAULT ON**, thinking, bg_recommended |
| | `claude-4.6-opus-max` | `claude-4.6-opus-max` | Max effort variant |
| | `claude-4.6-opus-max-thinking` | `claude-4.6-opus-max-thinking` | Max effort + thinking |
| **Claude 4.6 Opus (Fast mode)** | `claude-4.6-opus-high-thinking-fast` | same | Max Mode only |
| | `claude-4.6-opus-max-thinking-fast` | same | Max Mode only |
| **Claude 4.5 Opus** | `claude-4.5-opus-high` | `claude-4.5-opus-high` | |
| | `claude-4.5-opus-high-thinking` | `claude-4.5-opus-high-thinking` | |
| **Claude 4.5 Sonnet** | `claude-4.5-sonnet` | `claude-4.5-sonnet` | |
| | `claude-4.5-sonnet-thinking` | `claude-4.5-sonnet-thinking` | **DEFAULT ON**, bg_recommended |
| **Claude 4.5 Haiku** | `claude-4.5-haiku` | `claude-4.5-haiku` | |
| | `claude-4.5-haiku-thinking` | `claude-4.5-haiku-thinking` | |
| **Claude 4 Sonnet** | `claude-4-sonnet` | `claude-4-sonnet` | |
| | `claude-4-sonnet-thinking` | `claude-4-sonnet-thinking` | |
| **Claude 4 Sonnet 1M** | `claude-4-sonnet-1m` | `claude-4-sonnet-1m` | Max Mode only |
| | `claude-4-sonnet-1m-thinking` | `claude-4-sonnet-1m-thinking` | Max Mode only |

### OpenAI Models

| Website Name | Internal Slug(s) | Server Model Name | Notes |
| :--- | :--- | :--- | :--- |
| **GPT-5.3 Codex** | `gpt-5.3-codex` | same | **DEFAULT ON** |
| | `gpt-5.3-codex-low` / `-high` / `-xhigh` | same | Effort variants |
| | `gpt-5.3-codex-fast` / `-low-fast` / `-high-fast` / `-xhigh-fast` | same | Fast variants |
| **GPT-5.2** | `gpt-5.2` | same | **DEFAULT ON** |
| | `gpt-5.2-fast` / `-high` / `-high-fast` / `-xhigh` / `-xhigh-fast` / `-low` / `-low-fast` | same | Effort/speed variants |
| **GPT-5.2 Codex** | `gpt-5.2-codex` | same | |
| | `gpt-5.2-codex-high` / `-low` / `-xhigh` / `-fast` / `-high-fast` / `-low-fast` / `-xhigh-fast` | same | |
| **GPT-5.1 Codex Max** | `gpt-5.1-codex-max` | same | |
| | `gpt-5.1-codex-max-high` / `-low` / `-xhigh` / `-medium-fast` / `-high-fast` / `-low-fast` / `-xhigh-fast` | same | |
| **GPT-5.1 Codex Mini** | `gpt-5.1-codex-mini` | same | |
| | `gpt-5.1-codex-mini-high` / `-low` | same | |
| **GPT-5 Mini** | `gpt-5-mini` | same | |

### Google Models

| Website Name | Internal Slug(s) | Server Model Name | Notes |
| :--- | :--- | :--- | :--- |
| **Gemini 3 Pro** | `gemini-3-pro` | `gemini-3-pro-preview` | Different server name! |
| **Gemini 3 Flash** | `gemini-3-flash` | `gemini-3-flash-preview` | Different server name! |
| **Gemini 2.5 Flash** | `gemini-2.5-flash` | `gemini-2.5-flash` | |

### xAI Models

| Website Name | Internal Slug(s) | Server Model Name | Notes |
| :--- | :--- | :--- | :--- |
| **Grok Code** | `grok-code-fast-1` | `grok-code-fast-1` | |

### Cursor Models

| Website Name | Internal Slug(s) | Server Model Name | Notes |
| :--- | :--- | :--- | :--- |
| **Composer 1.5** | `composer-1.5` | `composer-1.5` | **DEFAULT ON**, bg_recommended |
| **Composer 1** | `composer-1` | `composer-1` | Upgrade to composer-1.5 |

### Other/Community Models

| Name | Slug | Server Model Name |
| :--- | :--- | :--- |
| **Kimi K2** | `kimi-k2-instruct` | `accounts/fireworks/models/kimi-k2-instruct-0905` |

---

## Key Architecture Insights for Factory Droid

1.  **Name (The Slug)**: This is the ID you pass in the API (the model picker ID in `config.json`).
2.  **Server Model Name**: What gets sent to the actual inference backend. Usually the same as `name`, but critical exceptions exist (e.g., `Gemini 3 Pro` → `gemini-3-pro-preview`).
3.  **Client Display Name**: What the user sees in the Cursor UI dropdown.
4.  **Thinking Variants**: Unlike standard APIs where thinking is a parameter, Cursor uses separate model slugs (e.g., `claude-4.5-sonnet` vs `claude-4.5-sonnet-thinking`). Both map to the same website line item.
5.  **Effort & Speed**: Effort levels (`-low`, `-high`, `-xhigh`, `-max`) and speed modes (`-fast`) are distinct slugs.
6.  **Feature Mapping**: Feature model configs show which model is the default for each Cursor feature (Composer, CmdK, Background Agent, etc.).
7.  **Default Active Models**: `defaultOn: true` models are shown in the picker by default:
    *   `Auto` (Default)
    *   `composer-1.5`
    *   `claude-4.6-opus-high-thinking`
    *   `claude-4.5-sonnet-thinking`
    *   `gpt-5.3-codex`
    *   `gpt-5.2`
