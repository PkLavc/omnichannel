# Public release audit

This repository contains application code and neutral examples only. A clean database starts with zero tenants; companies are created explicitly in the Admin. Provider templates contain no credentials and are disabled by default.

Company identity, Chatwoot credentials, RAG documents, business rules, conversations, contacts, attachments, datasets, database snapshots, and backups belong in the external `omnichannel-data` directory and are ignored by Git.

Release validation:

- `npm test`: 145 tests executed, 142 passed and 3 database integration tests skipped by their existing opt-in condition; zero failures.
- `npm run build`: TypeScript build completed successfully.
- Out-of-scope repair requests are answered locally without provider tokens or external referrals.
- Nearest-store requests use tenant-private official locations and geocoding; a live Chatwoot validation returned the official nearest unit and address without model completion.
- Appointment availability uses the configured HTTP Tool and was validated against the live scheduling source. Exact unavailable times are rejected instead of fabricated, while creation validates the slot again before writing and is idempotent per conversation.
- The configured customer and service-order read Tools returned authenticated, schema-valid responses for both active tenants during the live runtime check.
- `docker compose config --quiet`: configuration accepted.
- A disposable PostgreSQL/pgvector database received all 13 migrations. The real Gateway then started against it and reported `activeTenants: 0`.
- The clean Admin API returned zero tenants and four disabled provider templates, with zero configured keys.
- The complete Docker stack was rebuilt and reached healthy state for Gateway, Admin, Chatwoot, PostgreSQL, Redis, and n8n; one-shot migration containers exited with code 0.
- Current tracked-file scan found no company names, private domains, personal paths, business documents, dumps, spreadsheets, or recognized credential formats.
- The public branch history is replaced by one sanitized root commit before publication.

See the English and Brazilian Portuguese documentation for setup and security guidance.
