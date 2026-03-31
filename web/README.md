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
2. In Build and deployment, set Source to GitHub Actions.
3. Ensure your default branch is `main`.

### Automatic deployment

A workflow is included at [.github/workflows/deploy-pages.yml](../.github/workflows/deploy-pages.yml).

- It builds and deploys when `main` receives changes under `web/**`.
- It can also be run manually from the Actions tab.

### Manual deployment (alternative)

You can also publish manually to the `gh-pages` branch:

```bash
npm run deploy
```

## Notes

- If this repository name changes, update `base` in [vite.config.ts](vite.config.ts) to match the new repo path.
- Pages URL will be `https://<your-user>.github.io/routeForge/`.
