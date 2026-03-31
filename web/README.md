# RouteForge Web

React + TypeScript + Vite frontend for browser-based terrain STL generation.

## Local development

```bash
npm install
npm run dev
```

Build production output:

```bash
npm run build
```

Preview production build locally:

```bash
npm run preview
```

## GitHub Pages deployment

This app is configured for GitHub Pages under the repository path `/routeForge/` via [vite.config.ts](vite.config.ts).

### One-time repository setup

1. Open repository Settings -> Pages.
2. In Build and deployment, set Source to `Deploy from a branch`.
3. Set Branch to `gh-pages` and Folder to `/(root)`.
4. Ensure your default branch is `main`.

### Publish to `gh-pages`

Build and publish with:

```bash
npm run deploy
```

This command builds the app and pushes `dist/` to the `gh-pages` branch.

## Notes

- If this repository name changes, update `base` in [vite.config.ts](vite.config.ts) to match the new repo path.
- Pages URL will be `https://<your-user>.github.io/routeForge/`.
