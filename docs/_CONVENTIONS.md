# Authoring conventions (for contributors)

- All docs are Markdown in `docs/`, numbered `NN-slug.md`. Every chapter has:
  1. `# Chapter N — Title` + a one-paragraph "What you'll learn" + **Level** badge (Beginner / Intermediate / Advanced / Expert)
  2. Concept explanation first (the *why*), then code (the *how*), then "Common pitfalls", then "Exercises" (3–5, with a hidden-ish "Hints" list), then "Key takeaways", then `Next → [Chapter N+1](...)` link.
  3. ASCII / Mermaid diagrams (```mermaid) where a mechanism is involved (handshake, flows, architecture).
- Code: Node >= 20, **ESM** (`import`), `ws@8`, `express@5`, `socket.io@4`, `mediasoup@3`, `mediasoup-client@3`. No TypeScript. No build step for examples — browser clients are plain `<script type="module">` in `public/index.html`.
- **Docs first:** each chapter is self-contained — the complete code (server + client) appears inline as snippets and is explained step by step. The example folder is a copy of that code.
- Every chapter has a runnable example in `examples/NN-slug/` with `server.js` (+ `public/` if browser) and a short `README.md`. Shared deps are in root `package.json`; run with `npm run ex:NN`. Default port 3000 (read `process.env.PORT`).
- Message protocol used across the course (introduced in ch.4, reused in the capstone):
  `{ "type": "chat:message", "id": "<uuid>", "payload": {...} }`, replies may include `"replyTo": "<id>"` for request/response.
- Capstone project lives in `project/` (its own package.json; name: **"Huddle"** — Slack-lite chat + mediasoup video rooms).
