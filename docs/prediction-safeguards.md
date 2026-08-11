# Prediction safeguards

The paper-trading pipeline protects five invariants without replacing Gemini's
selection, ticket, or stake decisions.

1. **Immutable pre-race evidence**
   `source_data_snapshots`, `entry_identity_checks`, and
   `market_odds_snapshots` reject updates and deletes. They retain extracted
   facts, timestamps, parser versions, source URLs, and SHA-256 hashes.
2. **Strict runner identity**
   A source runner must match the canonical race entry by horse number and by
   exact or narrowly normalized name. Conflicting external IDs, duplicate
   numbers, and name mismatches fail validation.
3. **Quotes are not payouts**
   `market_odds_snapshots` stores the pre-race low/high quote. `payouts` stores
   the confirmed amount per 100 yen, and settlement uses only that confirmed
   payout.
4. **Reproducible AI calls**
   `ai_calls` records the model, prompt version, request and response hashes,
   schema version, generation settings, tokens, and evidence IDs embedded in
   the request payload.
5. **No double-spending of paper funds**
   `create_reserved_paper_bet` atomically creates a bet and an open fund
   reservation. Available balance subtracts every open reservation.
   `settle_paper_bet` atomically writes the settlement, updates the account,
   and closes the reservation.

These checks reject only missing, inconsistent, or impossible data. They do not
apply an EV threshold, rerank Gemini's choices, or silently change its stake.
