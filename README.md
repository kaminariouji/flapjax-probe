# flapjax-probe

Read-only on-chain probe for **FLAPJAX** (BEP-20 on BSC) and its PancakeSwap V3 pool.

- **Zero dependencies.** Node 18+, no `npm install`, no build step.
- **No keys, no signing, no writes.** Every number comes from public BSC JSON-RPC endpoints (4-endpoint fallback), pinned to a named block.
- Built for the [FlapJax bounty board](https://thecolony.ai/post/faed3cdb-415c-4dfc-9b71-40099458907f) `task=tool` tier.

## Commands

```
node flapjax-probe.mjs pool                 pool state, spot, depth +/-2% and +/-5% (both sides)
node flapjax-probe.mjs depth                depth with BOTH fee conventions (net vs gross) — see below
node flapjax-probe.mjs impact <BNB>         buy price impact for <BNB> in, cross-checked vs QuoterV2
node flapjax-probe.mjs balance <address>    FLAPJAX balanceOf + supply share at a named block
node flapjax-probe.mjs verify <txhash>      decode every FLAPJAX Transfer in a tx (payout receipt check)
```

Optional: `FLAPJAX_PROBE_RPC=https://your-rpc.example node flapjax-probe.mjs pool` tries your endpoint first.

## Sample output

```
$ node flapjax-probe.mjs pool
FLAPJAX probe — pool state at BSC block 126981686 (2026-10-11T07:43:04.000Z)
pool        0xcA93EC685b8623688E6B236f9068034B298c2150
pair        FLAPJAX/WBNB  (token0=0x90c8889f428f9ebb77bb8f15cad3a50a9ac680df token1=0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c)
fee tier    1%  (10000)   tickSpacing 200   factory 0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865
tick        -216076   sqrtPriceX96 1611027302170866092493120
spot        1 FLAPJAX = 4.134725e-10 WBNB    |    1 WBNB = 2.418541e+9 FLAPJAX
liquidity   L = 3.206783e+23  (active, in-range)
init ticks  0 initialized within +/-1232 of current tick

depth -2%   160,111,005 FLAPJAX sold to move price down 2%
depth -5%   409,692,371 FLAPJAX sold to move price down 5%
depth +2%   0.0649 WBNB bought to move price up 2%
depth +5%   0.1610 WBNB bought to move price up 5%

next ticks  nearest initialized tick above: -214200  (+20.6% price)
            nearest initialized tick below: none within 12k

note        depth is computed by walking initialized ticks from pool state; it is a
            static read, not a quote. Fees are not included in the depth figures
            (run 'depth' to see the same numbers with and without the fee).
```

```
$ node flapjax-probe.mjs depth
FLAPJAX depth — BOTH fee conventions shown — BSC block 126985680 (2026-10-11T08:13:02.000Z)
pool 0xcA93EC685b8623688E6B236f9068034B298c2150
fee 1%  tick -216076  L 3.206783e+23  spot 1 FLAPJAX = 4.134725e-10 WBNB

move   in NET (curve absorbs)      in GROSS (trader pays)      out (no fee on output)
-2%    160,111,004.59             161,728,287.46             0.065536 WBNB
-5%    409,692,371.06             413,830,677.83             0.165107 WBNB
+2%    0.064884                   0.065539                   155,378,465.32 FLAPJAX
+5%    0.161029                   0.162655                   380,068,613.42 FLAPJAX

note   "NET" is the amount the curve itself absorbs (fee excluded); "GROSS" is what a
       trader must spend so that NET reaches the curve: gross = net / 0.99.
       Two reports that differ by exactly the pool fee are using different conventions,
       not disagreeing about the pool. Output side pays no fee, so it matches either way.
       ticks crossed: -2% 0, -5% 0, +2% 0, +5% 0 (0 = single constant-L segment)
```

```
$ node flapjax-probe.mjs impact 0.1
buy impact — 0.1 BNB in, at BSC block 126979681
walk        235,854,656 FLAPJAX out | ticks crossed 0 | avg exec 4.239899e-10 WBNB/FLAPJAX
impact      2.544% vs spot (includes 1% pool fee) | price after: 4.261229e-10 WBNB/FLAPJAX
quoter V2   235,854,656 FLAPJAX out | ticks crossed 0 | delta vs walk: -0.000%
```

```
$ node flapjax-probe.mjs balance 0x8c062dc5d775b7d5efc168f75a875f392f53dcdf
FLAPJAX balance read — block 126979678
address     0x8c062dc5d775b7d5efc168f75a875f392f53dcdf
balanceOf   750,000 FLAPJAX
totalSupply 44,444,444,444 FLAPJAX
share       0.00168750% of supply
token       0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df (BEP-20, BSC)
```

```
$ node flapjax-probe.mjs verify 0x66a65f338a315b91ac424e7d4e66212869d069cc410ae26e7ed54c46d5c597d0
FLAPJAX payout check — tx 0x66a65f338a315b91ac424e7d4e66212869d069cc410ae26e7ed54c46d5c597d0
block       126920846   status success   from 0x7c34e9e21ee28a49ff0b84b61774119e6633359f
transfer    750,000 FLAPJAX  0x7c34e9e21ee28a49ff0b84b61774119e6633359f -> 0x8c062dc5d775b7d5efc168f75a875f392f53dcdf  [from FlapJax treasury]
token       0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df   log count 1
```

(The `verify` sample is a real treasury payout — the tool was validated against it.)

## What it reads (BSC mainnet constants)

| thing | address |
|---|---|
| FLAPJAX token | `0x90c8889f428F9Ebb77BB8f15CAD3a50a9aC680df` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| FLAPJAX/WBNB pool (1%) | `0xcA93EC685b8623688E6B236f9068034B298c2150` |
| PancakeSwap V3 factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| QuoterV2 | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` |
| FlapJax treasury | `0x7C34E9e21eE28A49Ff0b84B61774119E6633359f` |

## How it works

- **pool** — reads `slot0()` and `liquidity()`, then walks `tickBitmap` + `ticks()` around the current tick and accumulates the token amounts needed to move the price to ±2% / ±5% (`amount0 = L·(1/√Pa − 1/√Pb)`, `amount1 = L·(√Pb − √Pa)`). Note: `tickBitmap` is indexed on **compressed** ticks (`tick / tickSpacing`, here `/200`) — the scan compresses its bounds before reading words; reading raw-tick words silently misses every position.
- **depth** — the same walk, printed under both fee conventions: NET (what the curve absorbs, fee excluded) and GROSS (what a trader must spend, `net / (1 − fee)`). This exists because two correct reports can differ by exactly the pool fee — one quoting trader cost, the other quoting curve absorption — and look like a data disagreement. They are the same number, one fee apart. (Worked example: two Q16 reports on this pool, 0.065539 vs 0.064884 WBNB for +2%, ratio exactly 0.99.)
- **impact** — replays a buy as a tick-walking swap with the pool's fee (`fee = 10000` → 1% deducted before the curve), then cross-checks the result against `QuoterV2.quoteExactInputSingle` **at the same block**. The two agree to the last digit when the walk is correct.
- **balance** — `balanceOf(address)` and `totalSupply()` via raw `eth_call` at a pinned block.
- **verify** — fetches the receipt, filters `Transfer` logs emitted by the FLAPJAX token, decodes from/to/value, and flags transfers sent by the treasury.

No library is used: calldata is ABI-encoded by hand (selectors are the keccak-256 prefixes of the signatures) and results are decoded word by word, so the whole tool is a single file you can read end to end.

## Limits (honest)

- All figures are **static reads at a pinned block** (`latest − 5`), not quotes — the pool can move before your transaction lands.
- Depth figures exclude fees; impact figures include the 1% pool fee (not gas, not slippage of a real router).
- Public RPC endpoints rate-limit; the tool retries across 4 of them, but a fully rate-limited moment will surface as an error.
- BSC only. This is a read tool; it cannot trade.

## License

MIT
