/* eslint-disable */
/**
 * Per-destination shipping quote, driven by the SHARED fixture at
 * `fixtures/shipping_quote_vectors.json`.
 *
 * The same file drives the storefront repo's `test/shipping_quote_test.dart`. This side produces the
 * number that lands on both the card charge and the invoice delivery line
 * (the accounting revenue record), so a drift between the two implementations is
 * an accounting defect, not a cosmetic one.
 *
 * Pure module under test — no emulator, no credentials, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  quoteShipping,
  totalCentsWithStopgap,
  groupItemsByDestination,
  presetIdForLine,
  GAP_REASONS,
  BLOCKER_TO_GAP,
  ORDER_DEFAULT_DESTINATION_KEY,
} = require("../src/shippingQuote");
const {priceTableFromConfig, BLOCKERS} = require("../src/boxPlanner");

const VECTOR_PATH = path.join(__dirname, "..", "fixtures", "shipping_quote_vectors.json");
const fixture = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
const defaultPrices = priceTableFromConfig(fixture.prices);

test("the shared fixture loaded", () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
  assert.equal(defaultPrices.small, 1955);
});

for (const vector of fixture.cases) {
  test(`vector: ${vector.name}`, () => {
    const prices = vector.prices ?
      priceTableFromConfig(vector.prices) : defaultPrices;

    const quote = quoteShipping({
      order: {items: vector.lines.map((l) => ({
        quantity: l.quantity,
        packagingPresetId: l.packagingPresetId,
        deliveryLocationId: l.deliveryLocationId,
        product: {name: "Line"},
      }))},
      presetsById: fixture.presets,
      prices,
    });

    assert.deepEqual(
        quote.destinations.map((d) => ({
          key: d.destinationKey, cents: d.cents, gap: d.gap,
        })),
        vector.expect.destinations,
        `destinations mismatch for "${vector.name}"`);
    assert.equal(quote.pricedCents, vector.expect.pricedCents,
        `pricedCents mismatch for "${vector.name}"`);
    assert.equal(quote.isComplete, vector.expect.isComplete,
        `isComplete mismatch for "${vector.name}"`);
    assert.equal(quote.boxCount, vector.expect.boxCount,
        `boxCount mismatch for "${vector.name}"`);

    // A gap must never carry money, or a partly-priced order could be mistaken
    // for a fully quoted one.
    for (const d of quote.destinations) {
      if (d.gap !== null) {
        assert.equal(d.cents, 0, "a gap must contribute no cost");
        assert.deepEqual(d.boxes, [], "a gap must carry no boxes");
        assert.ok(GAP_REASONS.includes(d.gap), `unknown gap ${d.gap}`);
      }
    }
  });
}

// ── Grouping parity ──────────────────────────────────────────────────────────
// Must match multi_ship.dart / the admin submit helper: distinct trimmed ids in
// first-seen order, all id-less lines collapsing into one default group. The invoice
// split relies on this, so a divergence would attach a delivery job to the wrong
// invoice.
test("grouping keeps first-seen order and collapses id-less lines", () => {
  const groups = groupItemsByDestination([
    {deliveryLocationId: "b"},
    {},
    {deliveryLocationId: "a"},
    {deliveryLocationId: "b"},
    {deliveryLocationId: "   "},
  ]);
  assert.deepEqual(groups.map((g) => g.key),
      ["b", ORDER_DEFAULT_DESTINATION_KEY, "a"]);
  assert.equal(groups[0].items.length, 2, "both 'b' lines in one group");
  assert.equal(groups[1].items.length, 2, "blank id joins the default group");
});

// ── Preset id resolution ─────────────────────────────────────────────────────
test("the PINNED line id wins over the product's current link", () => {
  // Re-reading the product would let a later re-link silently re-price a
  // historical order.
  assert.equal(
      presetIdForLine({
        packagingPresetId: "as-shipped",
        product: {packagingPresetId: "relinked-later"},
      }),
      "as-shipped");
});

test("falls back to the product link when the line has no pin", () => {
  assert.equal(
      presetIdForLine({product: {packagingPresetId: "from-product"}}),
      "from-product");
});

test("blank ids resolve to null rather than an unresolvable lookup", () => {
  assert.equal(presetIdForLine({packagingPresetId: "  ", product: {}}), null);
  assert.equal(presetIdForLine({}), null);
  assert.equal(presetIdForLine(null), null);
});

// ── Stopgap is always explicit ───────────────────────────────────────────────
test("the stopgap rate is added only when the caller asks for it", () => {
  const quote = quoteShipping({
    order: {items: [
      {quantity: 500, packagingPresetId: "bc14", deliveryLocationId: "a"},
      {quantity: 500, deliveryLocationId: "b"},
    ]},
    presetsById: fixture.presets,
    prices: defaultPrices,
  });

  assert.equal(quote.pricedCents, 1955, "the gap contributes nothing by itself");
  assert.equal(quote.gaps.length, 1);
  // The retiring flat rate, applied explicitly at the call site.
  assert.equal(totalCentsWithStopgap(quote, 2500), 1955 + 2500);
  // Charging nothing for gaps must also be expressible.
  assert.equal(totalCentsWithStopgap(quote, 0), 1955);
});

test("an unusable stopgap value contributes zero, never a negative charge",
    () => {
      const quote = quoteShipping({
        order: {items: [{quantity: 500}]},
        presetsById: fixture.presets,
        prices: defaultPrices,
      });
      // A negative would REFUND shipping on an un-priceable destination.
      for (const bad of [-100, NaN, undefined, null, {}]) {
        assert.equal(totalCentsWithStopgap(quote, bad), 0,
            `stopgap ${String(bad)} should contribute 0`);
      }
      // A numeric string IS accepted: Firestore config is hand-edited and can
      // hold "2500", and coercing it matches how amount.js already reads
      // flatDeliveryCharge / flatPerLocation (`Number(...) || 0`).
      assert.equal(totalCentsWithStopgap(quote, "2500"), 2500);
      // Fractional cents truncate rather than propagating a float.
      assert.equal(totalCentsWithStopgap(quote, 2500.9), 2500);
    });

// ── Contract constants shared with Dart ──────────────────────────────────────
test("gap vocabulary matches the Dart enum and covers every blocker", () => {
  assert.deepEqual(GAP_REASONS, [
    "productNotConfigured",
    "presetIncomplete",
    "ownPackaging",
    "tooLargeForFlatRate",
    "ratesNotConfigured",
    "invalidLine",
  ]);
  // Every planner blocker must map to a destination reason, or a new blocker
  // would silently fall through to the default and mislabel the fix.
  for (const blocker of BLOCKERS) {
    assert.ok(BLOCKER_TO_GAP[blocker],
        `blocker ${blocker} has no gap mapping`);
    assert.ok(GAP_REASONS.includes(BLOCKER_TO_GAP[blocker]));
  }
});

// ── Defensive input handling ─────────────────────────────────────────────────
// The callable passes whatever the order document holds, so this must not throw
// inside a Cloud Function.
test("malformed orders quote nothing instead of throwing", () => {
  for (const order of [undefined, null, {}, {items: null}, {items: "nope"}]) {
    const quote = quoteShipping({
      order, presetsById: fixture.presets, prices: defaultPrices,
    });
    assert.deepEqual(quote.destinations, []);
    assert.equal(quote.pricedCents, 0);
    assert.equal(quote.isComplete, false);
  }
});

test("a missing presets map reports gaps rather than crashing", () => {
  const quote = quoteShipping({
    order: {items: [{quantity: 500, packagingPresetId: "bc14"}]},
    presetsById: null,
    prices: defaultPrices,
  });
  assert.equal(quote.isComplete, false);
  assert.equal(quote.gaps[0].reason, "productNotConfigured");
});
