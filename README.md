# Nova Local

Nova is a local-first product search app with:

- A React + Vite frontend on `http://localhost:3000`
- A FastAPI + CLIP + FAISS backend on `http://localhost:5000`
- A prebuilt FashionIQ index and local product image serving

## Quick Run

Clone and run with this sequence in Windows PowerShell:

```powershell
git lfs install
git clone https://github.com/double-u9/Nova-Vision-Language-Product-Search-Engine.git
cd Nova-Vision-Language-Product-Search-Engine
npm.cmd install
npm.cmd run setup:python
npm.cmd run dev
```

Then open:

- Frontend UI: `http://127.0.0.1:3000`
- Backend health: `http://127.0.0.1:5000/health`
- Backend API docs: `http://127.0.0.1:5000/docs`

Why `npm.cmd` instead of `npm`:

- PowerShell may block `npm.ps1` because of execution policy.
- `npm.cmd` avoids that issue and works reliably on Windows.

## Step By Step

1. Install Node.js LTS.
2. Install Git and Git LFS.
3. Open PowerShell.
4. Clone the repository:

```powershell
git lfs install
git clone https://github.com/double-u9/Nova-Vision-Language-Product-Search-Engine.git
cd Nova-Vision-Language-Product-Search-Engine
```

5. Install frontend packages:

```powershell
npm.cmd install
```

6. Create the Python environment and install backend dependencies:

```powershell
npm.cmd run setup:python
```

7. Start the app:

```powershell
npm.cmd run dev
```

8. Wait for the first startup to finish, then open `http://127.0.0.1:3000`.

The first run can be slow because it may:

- Create `.venv`
- Install Python packages
- Download CLIP weights
- Load the FAISS index into memory

## Requirements

- Node.js 20+ or newer
- Python 3.11 or 3.12
- Git LFS
- Git on your PATH once, for the `clip` dependency

If Python auto-detection fails, set `NOVA_PYTHON` in `.env` to a specific `python.exe` or `python` path.

## Project Layout

```text
.
|- nova/             FastAPI backend, search pipeline, data, index
|- public/           Static frontend assets
|- scripts/          Local run/setup helpers
|- src/              React application
|- .env.example      Optional local overrides
|- index.html
|- package.json
|- requirements.txt
|- tsconfig.json
`- vite.config.ts
```

## Development

The standard development command is:

```powershell
npm.cmd run dev
```

This starts:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:5000`

Backend auto-reload is disabled by default for a more reliable Windows localhost workflow. If you want backend file watching, set `NOVA_BACKEND_RELOAD=true` in `.env`.

## Production Mode

For a production-style local run:

```powershell
npm.cmd start
```

This builds the frontend, then serves:

- Preview frontend on `http://localhost:3000`
- FastAPI backend on `http://localhost:5000`

## Environment Variables

See [.env.example](./.env.example) for supported overrides.

The defaults are already set for normal localhost use, so `.env` is optional.

## Notes

- The repository uses Git LFS for `nova/data/faiss.index`, so run `git lfs install` before cloning or pulling the full project.
- `http://127.0.0.1:5000/` returning `{"detail":"Not Found"}` is normal because the backend does not define a root `/` route.
- Use `/health` or `/docs` to verify the backend is running.
- Search results now return the requested `top_k` result count instead of being hard-capped to 5.
- Backend category labels are backfilled from the FashionIQ split files, so results no longer default to `"unknown"`.
- Frontend image, text, and hybrid search requests are aligned with the FastAPI API contract.
- Product images are served directly from the local dataset at `/images/<file>.jpg`.
