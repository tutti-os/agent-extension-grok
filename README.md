# Grok Build Agent Extension for Tutti

This repository packages the declarative metadata that connects the official
xAI Grok Build CLI to Tutti over the Agent Client Protocol (ACP). It does not
fork, wrap, or redistribute the Grok executable.

Tutti first discovers a compatible `grok` already installed on `PATH`. When no
compatible local runtime exists, AgentGUI can explicitly install the official
Grok Build CLI 0.2.103 executable into Tutti's private managed-runtime
directory. The signed manifest pins the Apple Silicon artifact URL, exact byte
size and SHA-256. It does not overwrite or repoint an existing user `grok`
command.

Grok is launched with self-update disabled and with the permission tier chosen
when the conversation is created. Permission cannot change inside that
conversation. Plan mode remains an independent ACP workflow mode.

## Build

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm package:tutti-agent
```

The package is written to `build/tutti-agent/package`. It contains only JSON,
Markdown, and SVG data.

## Local Tutti development

Enable the generic `agent.extension.grok` developer flag and point the
development daemon at the packaged directory:

```sh
TUTTI_AGENT_EXTENSION_GROK_PACKAGE_DIR="$PWD/build/tutti-agent/package" make dev-gui
```

The development override is copied into a content-addressed daemon snapshot;
Tutti never executes package files in this repository.

## Release

The manual `Publish Agent Extension` GitHub workflow expects the standard Tutti
AWS OIDC repository variables and the Ed25519 private key in
`TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY`. It builds a reproducible data-only
ZIP, signs immutable `release.json`, publishes versioned objects without
overwriting them, and updates the mutable `versions.json` index.

## License and trademarks

The extension metadata is Apache-2.0 licensed. Grok and xAI are trademarks of
their respective owners. This project is maintained by Tutti OS and is not an
xAI product.
