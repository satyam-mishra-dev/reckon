# Demo video — shooting script (placeholder)

Not recorded yet. 90 seconds, screen capture only, no narration needed if the
captions land. Record against a freshly booted stack (`docker compose down -v
&& docker compose up -d --wait`).

1. **(0:00)** Terminal: `docker compose up -d --wait` finishing, then
   `docker compose ps` — six services, all healthy.
2. **(0:10)** Playground (http://localhost:4801/play): hit **Pay**
   once, point at the 200 and the provider ref.
3. **(0:20)** Hit **Double-submit ×5** — five byte-identical responses, one
   intent, one provider charge. This is the thesis of the project; linger.
4. **(0:35)** Flip provider chaos to **timeout after charge 40%**, hit Pay a
   few times. Cut to the live feed: `requires_retry` appearing.
5. **(0:50)** Intents page, open a stuck intent: recovery-point trail at
   `intent_created`, then (auto-refresh) watch the completer drive it to
   `finished` and the ledger postings appear.
6. **(1:05)** Overview: intents by status, deliveries delivered, ledger sums
   to 0 chip, last reconciliation drift 0.
7. **(1:15)** Terminal: `npm run chaos -- --intents 500` scoreboard scrolling,
   ending in `ALL ASSERTIONS PASSED`.
8. **(1:25)** Close on the README Guarantees table.
