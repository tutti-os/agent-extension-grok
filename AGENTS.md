# Contributor Instructions

This repository publishes the declarative Tutti Agent Extension for the
official xAI Grok Build CLI.

- Do not add Grok CLI binaries, installer scripts, executable wrappers,
  JavaScript normalizers, WASM, credentials, or renderer code to `extension/`.
- Keep the official binary URL, exact version, byte size, SHA-256, and
  provenance URL pinned together in the signed manifest.
- Keep release implementation self-contained under `scripts/`.
- User-visible copy belongs in every locale under `extension/locales/`.
- Run `pnpm check` before committing.
- Use Conventional Commits and DCO sign-off.
