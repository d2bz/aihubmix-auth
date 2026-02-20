# @akaknele/aihubmix-auth

OpenClaw provider-auth plugin for AIHubMix.

## Install

```bash
openclaw plugins install @akaknele/aihubmix-auth
openclaw gateway restart
```

## Login and sync models

```bash
openclaw models auth login --provider aihubmix --method api-key --set-default
```

This plugin configures four model buckets from AIHubMix:

- `openai`
- `anthropic`
- `google`
- `other`
