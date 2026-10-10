# Contributing

Contributions are welcome. This checkout is browser-only: `raw` is the Chrome/Edge browser
plugin runtime. The former model CLI has been removed and must not be reintroduced.

## Development

Use Node 22.21 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/browser-cli.js --help
```

Run `npm run smoke:browser` when changing browser automation. It opens the dedicated local browser
profile, verifies same-origin iframe interaction, and verifies that a CPU loop is terminated.

Add focused `node:test` coverage for protocol serialization, context boundaries, permissions, and
filesystem behavior. Keep generated files out of commits; `dist/` is built during packaging.

## Pull requests

Explain the concrete behavior change and how you verified it. Keep unrelated changes separate.
Provider model lists are discovery fallbacks, so update them only from the provider's current public
documentation and include the source in the pull request.
