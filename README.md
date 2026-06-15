# @akakenle/aihubmix-auth

OpenClaw provider-auth plugin for AIHubMix. Routes OpenAI, Anthropic, and
Gemini model calls through AIHubMix's unified endpoint.

## Requirements

- OpenClaw **2026.5.27 or newer** (the `openclaw.compat.pluginApi` floor for
  this plugin)
- Node.js 22.19+ (TypeScript ESM module support)

## Install

```bash
openclaw plugins install @akakenle/aihubmix-auth
openclaw gateway restart
```

The package ships prebuilt JavaScript at `dist/index.js` and a manifest at
`openclaw.plugin.json`, so OpenClaw does not need to compile TypeScript at
install time.

## Login and sync models

```bash
openclaw models auth login --provider aihubmix-openai --method api-key --set-default
```

The same one-shot key is shared across all four transports
(`aihubmix-openai`, `aihubmix-anthropic`, `aihubmix-google`, `aihubmix-other`)
because the SDK stores credentials against the alias root and resolves them
for the matching transport at request time. You can run the same command
against `--provider aihubmix-anthropic`, `--provider aihubmix-google`, or
`--provider aihubmix-other`; only one needs to be configured.

After login, the plugin pulls the latest model catalog from
`https://aihubmix.com/api/v1/models?sort_by=order&sort_order=desc` and maps
results into four provider buckets, then patches the active OpenClaw config:

- `openai` -> `https://aihubmix.com/v1` (`openai-completions`)
- `anthropic` -> `https://aihubmix.com` (`anthropic-messages`)
- `google` -> `https://aihubmix.com/gemini/v1beta` (`google-generative-ai`)
- `other` -> `https://aihubmix.com/v1` (`openai-completions`)

The static base URL + api route for each transport is always written to the
config (it is not gated on a key being present). The credential itself is
stored in the auth-profile by the SDK, so the inline `apiKey` field in
`models.providers.*` is only set when `AIHUBMIX_API_KEY` was already exported
in the environment that ran the plugin.

You can also pre-set the key without going through the wizard:

```bash
export AIHUBMIX_API_KEY=sk-...
openclaw plugins install @akakenle/aihubmix-auth
```

## Dynamic models

The plugin registers a `resolveDynamicModel` hook on every transport so
shorthand model ids resolve to the correct transport and base URL without
listing them in the static catalog first:

- `claude-...` -> `aihubmix-anthropic` (`anthropic-messages`,
  `https://aihubmix.com`)
- `gemini-...` -> `aihubmix-google` (`google-generative-ai`,
  `https://aihubmix.com/gemini/v1beta`)
- `gpt-...` / `o1-...` / `o3-...` / `o4-...` -> `aihubmix-openai`
  (`openai-completions`, `https://aihubmix.com/v1`)
- everything else -> `aihubmix-other` (`openai-completions`,
  `https://aihubmix.com/v1`)

The hook only routes a model id to the right transport and base URL; it does
not pre-populate token limits or cost data. Static catalog rows from the
auth-time fetch take precedence when both are available.

## Verifying the install

```bash
openclaw plugins inspect aihubmix-auth --runtime --json
```

The runtime entrypoint should resolve to the package's `dist/index.js`, and
the manifest shape should report the four provider buckets, the per-provider
`resolveDynamicModel` hook, and the `liveCatalog` hook.

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
