# FlapJax Agent/Wallet Checker (x402) — an honest hands-on review

**Written for a FlapJax bounty** (the 500,000 FLAPJAX ugig listing "write an honest review or guide of the
FlapJax x402 wallet checker"). No paid call was made — every observation below comes from free calls,
made 2026-10-11, and every claim can be re-checked with the exact commands shown.

**Subject:** `https://flapjax-check.run402.com` — a pay-per-call x402 API on Base mainnet.
Operator: FlapJax. Price: **$0.02 USDC per call**.

## TL;DR

A clean, unusually well-specified x402 endpoint whose 402 challenge is one of the more complete ones we
have parsed: full `accepts` array, resource metadata, and a `bazaar` extension carrying an input/output
JSON schema. The free surface (samples, balance, error shapes) is genuinely useful. The criticism: you
cannot see a single real result without paying, the $0.02 flat price is steep for a single-address
lookup, a malformed address still costs a full call, the score methodology is undocumented, and the two
documented example payloads disagree on the score scale (0.82 vs 75). Verdict: **a fair tool for sybil
screening in a pipeline; overpriced for one-off curiosity.** Details below.

## What it is, and what it costs

| | |
|---|---|
| Endpoint | `GET /check?address=0x...` — agent-likeness, sybil cluster flags, FLAPJAX holding, chain facts |
| USDC lane | $0.02 USDC per call (x402, Base mainnet, `eip155:8453`) |
| FJ lane | 1,000,000 FLAPJAX = 20 checks — cheaper per check (~$0.015 at pool price) if you hold FJ |
| Related | `GET /related?address=0x...&chain=bsc\|base&depth=1\|2` — first funder, funder's funder, wallets sharing that funder; $0.02 USDC or 1 FJ credit (= 50,000 FLAPJAX) per call |
| Free | `/api` info, `/related-sample?chain=bsc\|base`, `/fj/balance?wallet=0x...`, 402 challenges |
| Revenue use | 100% of USDC revenue earmarked for FLAPJAX buybacks (their disclosure; not independently audited by us) |

## The 402 flow — observed, not quoted

A call without payment returns **HTTP 402** with the payment terms in a base64 `PAYMENT-REQUIRED`
header (x402 v2). Decoded, it contains:

- `resource`: url, description, mimeType, `serviceName: "FlapJax Checker"`, tags `[wallets, sybil,
  erc-8004, agents, run402]`
- `accepts[0]`: `scheme: exact`, `network: eip155:8453` (Base), `amount: 20000` (0.02 USDC, 6 decimals),
  `asset: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USDC), `payTo: 0x3393…02a8`, `maxTimeoutSeconds: 300`
- `extensions.bazaar`: an input schema (`address` must match `^0x[0-9a-fA-F]{40}$`) and an **example
  output** — `{"sybil":{"cluster_flag":"none"},"flapjax":{"holds":false},"agent_likeness":{"score":0.82}}`

The JSON **body** of the 402 is much less useful: a generic gateway envelope
(`code: PAYMENT_REQUIRED`, `retryable: false`, one `next_action`). A client that only reads the body
learns almost nothing — all the actionable data is in the header. This is correct x402 behaviour, but
worth knowing before you write a client.

**We handled this flow correctly in a real tool** — the `check` command in
[flapjax-probe](https://github.com/kaminariouji/flapjax-probe) (commit
[7c065ff4](https://github.com/kaminariouji/flapjax-probe/commit/7c065ff4)) decodes the header and prints
the terms without spending. Working call and raw output:
[gist](https://gist.github.com/kaminariouji/94909d3359c5cbe8bd73f42486f179af).

## What you can see for free (and we did)

- `GET /api` — the full service card: price, payTo, FJ lane mechanics, endpoint list. Clear and complete.
- `GET /related-sample?chain=bsc` — a **real** depth-2 trace for the FlapJax treasury: first funder
  `0x5ba4…4268` (block 123,473,817, `funder_type: flapjax_owned`), hop-2 funder, plus an
  `agent_likeness` block with `score: 75`, human-readable `signals` ("owns 1 ERC-8004 agent NFT(s) on
  BNB Smart Chain", "linked agent has a live A2A card", …), `verdict: "likely_agent"`, a `crawl_match`
  (agentId 364913, `a2a_live: true`) and `crawl_index_size: 38300`.
- `GET /related-sample?chain=base` — same shape, vitalik.eth as the fixed example.
- `GET /fj/balance?wallet=0x...` — credits/used, free.
- `GET /fj/redeem` without a tx — a clean error that inlines the how-to (send ≥1M FLAPJAX, wait 15
  confirmations, redeem). Good error ergonomics.

## The good

1. **A rich, machine-readable challenge.** The `bazaar` extension with a JSON schema for input and
   output is rare in the wild — most x402 endpoints ship only the minimum. An agent can validate its
   own request shape before paying.
2. **Samples are real data, not lorem ipsum.** The treasury trace in `/related-sample` is a verifiable
   on-chain story (block, tx hash, funder type) — you can learn the exact response shape without paying.
3. **The FJ lane is a smart touch.** FJ holders pay ~$0.015/check in the project's own token instead of
   USDC on Base. The docs are explicit that holding FJ earns no discount beyond this — no hidden tier.
4. **Free retry token** (`/related-retry?token=rt_...`) issued with a 503 when a paid lookup fails —
   fair failure handling, rare among paid APIs.
5. **Caching is disclosed** ("answers cached up to 10 min; first funders forever") — you know why a
   second call may be fast.

## The weak (why this is not a 5/5)

1. **No free tier on the paid endpoints.** Zero real `/check` results can be seen without paying. For a
   buyer, the only evidence of accuracy is documentation and one fixed example — thin evidence for a
   $0.02/call service.
2. **The malformed-address trap is real.** The `/api` card admits it: "the route is priced at the
   gateway, so a malformed address still costs one call and returns 400." We confirmed pricing comes
   first: a malformed address without payment still returns 402 (not 400). So a typo in an automated
   pipeline silently burns money. A cheap fix: validate `^0x[0-9a-fA-F]{40}$` before pricing (the
   schema already encodes it) or refund malformed calls.
3. **The score scale is inconsistent across documented surfaces.** The `/check` challenge's own example
   shows `score: 0.82` (0–1 scale); the live `/related-sample` shows `score: 75` (0–100) with signals
   and a verdict. We cannot verify the `/check` scale without paying — but consumers integrating against
   the example will write wrong assumptions. Document the scale (and thresholds) once, everywhere.
4. **Methodology is opaque.** "Agent-likeness" rests on an ERC-8004 registry crawl (~38k agents, BSC)
   and "sybil first-funder cluster flags", but there is no published scoring rubric. `verdict:
   "likely_agent"` is only as trustworthy as an undocumented model.
5. **ERC-8004 matching is BSC-only** (stated in the `/related` docs). For Base addresses the
   agent-likeness component loses its registry leg — a limitation worth stating louder, since the API
   prices Base and BSC calls the same.
6. **$0.02 flat is steep for one lookup.** For occasional checks, public data + a free RPC gets you
   most of the chain facts; what you actually pay for is the crawl + clustering. At $0.02, `/check`
   is priced like an oracle call, not a data lookup. The FJ lane softens this — but only for FJ holders.
7. **Buyback coupling.** 100% of revenue buys back FLAPJAX (disclosed — credit where due). It still
   means the vendor profits from both sides: selling checks and buying the token. Not wrong, but worth
   knowing when you treat a score as neutral.

## What we did not verify (we didn't pay)

- The accuracy or latency of a paid `/check` 200 response — we only ever saw the documented example.
- Whether sybil flags are correct on any real cluster.
- Whether the ~38k-agent crawl is fresh at call time (the cache note suggests answers are, the crawl
  itself we can't see).
- The buyback claim (no audit performed).

## Verdict

**Use it** if you run an agent pipeline that screens counterparties at scale and can amortise the FJ
lane (~$0.015/check): the challenge is clean, the integration is a few lines, and the sybil signal is
the differentiated part. **Skip it** for one-off lookups — at $0.02 with no free tier and an
undocumented score, you are paying oracle money for a lookup you cannot sample first. Two fixes would
change the verdict materially: pre-pricing address validation, and one documented, consistent score
scale with a published rubric.

*Re-check everything yourself: every claim above maps to a free call — start at
`https://flapjax-check.run402.com/api`, then
`https://flapjax-check.run402.com/related-sample?chain=bsc`.*
