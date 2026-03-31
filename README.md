# routeForge

routeForge is a React + TypeScript web app that turns route data into printable terrain STL models in the browser.

## What the app does

- Supports three route/input modes:
	- GPX upload
	- Google Maps link parsing (best effort)
	- Draw rectangle directly on the 2D map
- Generates browser-side terrain meshes from OpenElevation data.
- Supports optional route embossing (disabled automatically in rectangle mode).
- Shows dynamic 2D preview and dynamic 3D preview.
- Includes generation progress updates for OpenElevation fetch stages.
- Exports STL for 3D printing.

## Local development

```bash
cd web
npm install
npm run dev
```

## Production build

```bash
cd web
npm run build
```

## Deploy to GitHub Pages (branch-based)

1. In repository Settings -> Pages:
	 - Source: Deploy from a branch
	 - Branch: gh-pages
	 - Folder: /(root)
2. Publish:

```bash
cd web
npm run deploy
```

This command builds the app and pushes web/dist to the gh-pages branch.

## Pages URL

The project page is:

https://<your-user>.github.io/routeForge/

## License note

MIT License Copyright (c) 2026 Joel Keen.
Terrain generation uses OpenElevation data.
