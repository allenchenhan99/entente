# RelayGraph Demo App

A small Node.js and TypeScript web application used as the starting repository for the RelayGraph demo. It includes a seeded in-memory user repository, an expiring in-memory session store, and a memory-backed email sender.

There is no login or auth of any kind.

## Requirements

- Node.js 22 or newer
- npm

## Install

```sh
npm install
```

## Run

```sh
npm start
```

The server listens on `PORT` when set and otherwise uses port 3000.

## Test

```sh
npm test
npm run typecheck
```

## HTTP endpoints

- `GET /health` reports service health.
- `GET /users/:id` returns a seeded user or a 404 response.
- `GET /me` always returns a 401 response.
