# Privacy

This service publishes data about **legal entities**. It does not publish data
about people, and it is built so that it cannot be turned into a people-search
service by configuration or by feeding it different input.

## Rules

1. **Natural persons are never stored.** A record is written only if it
   classifies as a legal entity (`packages/core/src/privacy.ts`, mirrored in
   `rust/opendata-geo/src/privacy.rs`, same test vectors):
   - its identity is a valid organisationsnummer: 10 digits, Luhn check digit,
     third digit ≥ 2 (a personnummer's third digit is a month digit, 0 or 1);
   - no source marks it as a person: SCB juridisk form 10 (fysiska personer)
     or 91 (oskiftade dödsbon), Bolagsverket identity type `PERSON-IDORG`, or
     Bolagsverket form `E` (enskild näringsidkare);
   - anything that cannot be classified is dropped (fail closed).
2. **One write path.** `Repository` (TS) and `db.rs` (Rust) are the only
   writers; both run the classification first. Natural persons are counted
   (`skipped_natural_persons` in `source_run`) and nothing else about them is
   kept, logged or returned.
3. **Imports are re-checked.** Snapshots can come from rbq peers, so the
   importer applies the same guard and a table/column allow-list
   (`packages/core/src/snapshot.ts`).
4. **No person lookup.** There is no SPAR, folkbokföring or resident data, and
   no query joins addresses to people. Lantmäteriet addresses are used as
   places only.
5. **No network calls for people.** The Bolagsverket ingest classifies a
   number before requesting it, so nothing is fetched for a personnummer.
6. **Direct-marketing opt-outs are shown.** SCB's reklamspärr is exposed as
   `adBlock` in every API so downstream users can respect it.
7. **Watch subscribers.** Their e-mail addresses are personal data. Watches
   use double opt-in, every alert carries an unsubscribe link, and delivered
   messages are pruned (`opendata mail prune --days 30`). Messages are rbq
   objects; deletion is local and never propagated, so do not push the
   `messages/` namespace to peers you do not control.

## Why so strict

About a third of workplaces in a sample municipality belonged to natural
persons, identified by personnummer. Hiding them only at query time would
leave personal data in the database, in snapshots and in backups. Dropping
them at ingest keeps them out of all three.

## What remains your responsibility

- Lantmäteriet's HVD terms for datasets containing personal data, and the
  purpose you stated in your application.
- SCB's and Bolagsverket's terms of use for their APIs.
- Attribution: every API and MCP result carries the attribution strings, and
  the PWA shows them.
