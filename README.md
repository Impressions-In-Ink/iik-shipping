# iik-shipping

Shipping price computation: FedEx One Rate box planning and per-destination
order quotes.

**This package exists for one reason.** The shipping amount has to appear in two
places — the customer's card charge, and the invoice that becomes the accounting
system's revenue record. Those two figures are produced by two separately
deployed backends. If each had its own copy of the math they could drift, and
the failure mode is a silent mismatch between what was charged and what was
recorded, found weeks later at reconciliation across many orders.

One implementation, imported by both, makes that class of bug impossible rather
than merely detectable.

## Who uses it

| Consumer | What it does with this |
|---|---|
| Storefront backend | prices the delivery term folded into a card charge |
| Order-submission backend | prices the invoice's delivery line — which *is* the charged total for tax-nexus orders, and the revenue record for all orders |

A third mirror exists in Dart, because the buyer-facing checkout is Flutter and
can't consume npm. **That one is display-only** — if it drifts a buyer sees a
wrong preview, not a wrong charge — and it's guarded by the same fixtures.

## Install

Consumers depend on a **tag**, not a branch, so a deploy can never pick up
unreviewed changes:

```bash
npm install --save "git+https://github.com/Impressions-In-Ink/iik-shipping.git#v1.1.0"
```

```js
const {planBoxes, quoteShipping, priceTableFromConfig} = require("iik-shipping");
```

> Use the `git+https://` form, not the `github:` shorthand. npm resolves the
> shorthand to `git+ssh://`, which anonymous build environments (Cloud Build,
> CI) can't authenticate — the install fails there while working fine locally.

## The fixtures are the contract

`fixtures/box_plan_vectors.json` and `fixtures/shipping_quote_vectors.json` are
the behavioural spec. They're published with the package so consumers can assert
their own mirrors against them.

**Changing behaviour means changing a vector first.** That's not ceremony — a
vector is the only thing that will notice if a mirror and this implementation
stop agreeing.

## Making a change

1. Add or edit a vector in `fixtures/`.
2. Change `src/`, run `npm test` until it passes.
3. Update the Dart mirror and run its tests — its vector-equality test fails
   until the fixtures match.
4. Bump the version, commit, and tag:
   ```bash
   git tag v1.2.0 && git push --tags
   ```
5. Point **both** consumers at the new tag and redeploy each. Both must be
   updated together — that's the whole point. A logic fix reaching only one of
   them recreates the mismatch this package prevents.

## What's in here

- `src/boxPlanner.js` — turns a quantity plus a packaging preset into a concrete
  list of FedEx flat-rate boxes and a cost. Cheapest *cover* (one big box can
  beat several small ones), capacity capped by the 50 lb One Rate weight ceiling
  (FedEx re-rates an over-limit box at full list rates), integer cents
  throughout so no float can split the quote from the charge.
- `src/shippingQuote.js` — groups an order's lines by destination and prices each
  one. Destinations that can't be priced come back as explicit gaps with a
  reason, never as a silent fallback charge.

Design rationale lives in the file headers; worth reading before changing either
module.

## Testing

```bash
npm test     # node --test, no credentials, no network
npm run lint
```

Pure modules by design: no database, no network, no cloud SDK. Callers load
packaging presets and the price table and pass them in. That's what keeps this
testable in isolation and keeps the consumers' own fee functions pure.
