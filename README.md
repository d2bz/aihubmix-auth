# @akaknele/aihubmix-auth

OpenClaw provider-auth plugin for AIHubMix. Routes OpenAI, Anthropic, and
Gemini model calls through AIHubMix's unified endpoint.

## Requirements

- OpenClaw **2026.5.27 or newer** (the `openclaw.compat.pluginApi` floor for
  this plugin)
- Node.js 22.19+ (TypeScript ESM module support)

## Install

```bash
openclaw plugins install @akaknele/aihubmix-auth
openclaw gateway restart
```

The package ships prebuilt JavaScript at `dist/index.js` and a manifest at
`openclaw.plugin.json`, so OpenClaw does not need to compile TypeScript at
install time.

## Login and sync models

```bash
openclaw models auth login --provider aihubmix --method api-key --set-default
```

The plugin pulls the latest model catalog from
`https://aihubmix.com/api/v1/models?sort_by=order&sort_order=desc` and maps
results into four provider buckets, then patches the active OpenClaw config:

- `openai` -> `https://aihubmix.com/v1` (`openai-completions`)
- `anthropic` -> `https://aihubmix.com` (`anthropic-messages`)
- `google` -> `https://aihubmix.com/gemini/v1beta` (`google-generative-ai`)
- `other` -> `https://aihubmix.com/v1` (`openai-completions`)

## Dynamic models

The plugin registers a `resolveDynamicModel` hook so shorthand model ids like
`claude-sonnet-4-6`, `gemini-2-5-pro`, or `gpt-5-4` resolve to the correct
transport and base URL without listing them in the static catalog first.

## Verifying the install

```bash
openclaw plugins inspect aihubmix-auth --runtime --json
```

The runtime entrypoint should resolve to the package's `dist/index.js`, and
the manifest shape should report the four provider buckets and the text
`liveCatalog` hook.

## Local development

```bash
npm install
npm run build
npm test
```

`npm run build` compiles `index.ts` to `dist/index.js` + `dist/index.d.ts`.
`npm test` runs the Vitest suite. Run `npm run prepublishOnly` (or rely on
the `prepublishOnly` script) before publishing to make sure the published
tarball contains a fresh `dist/`.
