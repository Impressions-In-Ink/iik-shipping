/* eslint-disable */
/**
 * Box planner tests, driven by the SHARED fixture at
 * `fixtures/box_plan_vectors.json`.
 *
 * The same file drives the storefront repo's `test/box_planner_test.dart`. The Dart planner produces
 * the figure the buyer is quoted; this one produces the figure the server
 * actually charges. Holding both to one fixture is what stops those two from
 * drifting into a quote-vs-charge mismatch.
 *
 * Pure module under test — no emulator, no credentials, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  planBoxes,
  priceTableFromConfig,
  canPlanOneRate,
  unitWeightLbs,
  BLOCKERS,
  BOX_SIZES,
  API_PACKAGING_TYPE,
  FEDEX_BOX_WEIGHT_LIMIT_LBS,
  MAX_BOXES_PER_PLAN,
} = require("../src/boxPlanner");

const VECTOR_PATH = path.join(__dirname, "..", "fixtures", "box_plan_vectors.json");

const fixture = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
const presets = fixture.presets;
const defaultPrices = priceTableFromConfig(fixture.prices);

// ── Fixture sanity ───────────────────────────────────────────────────────────
// Without this, a bad path or an empty fixture would make every vector below
// pass vacuously.
test("the shared fixture loaded", () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
  assert.ok(presets.bc14, "expected the bc14 preset");
  assert.equal(defaultPrices.small, 1955);
});

// ── The shared behavioural contract ──────────────────────────────────────────
for (const vector of fixture.cases) {
  test(`vector: ${vector.name}`, () => {
    const prices = vector.prices ?
      priceTableFromConfig(vector.prices) : defaultPrices;

    const plan = planBoxes({
      lines: vector.lines.map((l) => ({
        presetId: l.presetId,
        quantity: l.quantity,
        label: l.label || "",
      })),
      presetsById: presets,
      prices,
    });

    assert.deepEqual(plan.blockers, vector.expect.blockers,
        `blockers mismatch for "${vector.name}"`);
    assert.equal(plan.totalCents, vector.expect.totalCents,
        `totalCents mismatch for "${vector.name}"`);
    assert.deepEqual(
        plan.boxes.map((b) => [b.size, b.units]),
        vector.expect.boxes.map(([size, units]) => [size, units]),
        `box list mismatch for "${vector.name}"`);

    // Invariants every planned vector must satisfy, so a future case can't
    // encode an unshippable plan.
    if (plan.canShipFlatRate) {
      const packed = plan.boxes.reduce((s, b) => s + b.units, 0);
      const ordered = vector.lines
          .filter((l) => typeof l.quantity === "number" && l.quantity > 0)
          .reduce((s, l) => s + l.quantity, 0);
      assert.equal(packed, ordered,
          "every ordered unit must be packed exactly once");

      for (const box of plan.boxes) {
        assert.ok(box.weightLbs <= FEDEX_BOX_WEIGHT_LIMIT_LBS,
            `box at ${box.weightLbs}lb exceeds the flat-rate ceiling and ` +
            "would be re-rated by FedEx");
        assert.ok(box.units > 0);
        assert.ok(box.priceCents > 0);
        assert.equal(box.packagingType, API_PACKAGING_TYPE[box.size]);
      }
      assert.ok(plan.boxes.length <= MAX_BOXES_PER_PLAN);
    } else {
      assert.deepEqual(plan.boxes, [],
          "a blocked destination must not carry a partial plan");
      assert.equal(plan.totalCents, 0);
    }
  });
}

// ── priceTableFromConfig ─────────────────────────────────────────────────────
test("priceTableFromConfig reads a config/shipping style doc", () => {
  const t = priceTableFromConfig(
      {oneRateCents: {small: 1955, medium: 2435, large: 3000}});
  assert.deepEqual(t, {small: 1955, medium: 2435, large: 3000});
});

test("priceTableFromConfig drops zero/negative prices rather than treating " +
    "them as free", () => {
  const t = priceTableFromConfig({oneRateCents: {small: 0, medium: -5}});
  assert.deepEqual(t, {});
});

test("priceTableFromConfig tolerates a missing or malformed doc", () => {
  assert.deepEqual(priceTableFromConfig(null), {});
  assert.deepEqual(priceTableFromConfig({}), {});
  assert.deepEqual(priceTableFromConfig({oneRateCents: "nope"}), {});
});

// ── Preset helpers (mirrors of the Dart model's derived getters) ──────────────
test("unitWeightLbs divides the per-thousand figure", () => {
  assert.ok(Math.abs(unitWeightLbs({weightLbsPerThousand: 5.5}) - 0.0055) <
      1e-9);
});

test("unitWeightLbs rejects missing or non-positive weights", () => {
  assert.equal(unitWeightLbs({}), null);
  assert.equal(unitWeightLbs({weightLbsPerThousand: 0}), null);
  assert.equal(unitWeightLbs({weightLbsPerThousand: -1}), null);
});

test("canPlanOneRate requires a weight, a capacity, and FedEx packaging", () => {
  assert.equal(canPlanOneRate(presets.bc14), true);
  assert.equal(canPlanOneRate(presets.noWeight), false,
      "no weight means the 50 lb ceiling could not be enforced");
  assert.equal(canPlanOneRate(presets.banner), false, "own packaging");
  assert.equal(canPlanOneRate(
      {weightLbsPerThousand: 5, unitsPerSmallBox: 0}), false,
  "a zero capacity is not a usable box");
  assert.equal(canPlanOneRate(null), false);
});

// ── Contract constants shared with Dart ──────────────────────────────────────
test("blocker vocabulary and size list match the Dart enums", () => {
  // The fixture asserts on these strings; a rename on one side only would
  // silently stop matching.
  assert.deepEqual(BOX_SIZES, ["small", "medium", "large"]);
  assert.deepEqual(BLOCKERS, [
    "missingPreset",
    "unknownPreset",
    "ownPackagingOnly",
    "incompletePreset",
    "unitTooHeavy",
    "noPricedBox",
    "exceedsBoxCap",
    "invalidQuantity",
  ]);
  assert.deepEqual(API_PACKAGING_TYPE, {
    small: "FEDEX_SMALL_BOX",
    medium: "FEDEX_MEDIUM_BOX",
    large: "FEDEX_LARGE_BOX",
  });
});

// ── maxBoxes override ────────────────────────────────────────────────────────
test("a tighter maxBoxes blocks what the default allows", () => {
  const lines = [{presetId: "bc14", quantity: 16000}];
  assert.equal(
      planBoxes({lines, presetsById: presets, prices: defaultPrices})
          .canShipFlatRate,
      true);
  const tight = planBoxes(
      {lines, presetsById: presets, prices: defaultPrices, maxBoxes: 1});
  assert.deepEqual(tight.blockers, ["exceedsBoxCap"]);
});

// ── Defensive input handling ─────────────────────────────────────────────────
// The callable will pass whatever the order document holds, so the planner has
// to survive malformed input rather than throwing inside a Cloud Function.
test("missing or non-array lines plan nothing instead of throwing", () => {
  for (const lines of [undefined, null, "nope", {}]) {
    const plan = planBoxes(
        {lines, presetsById: presets, prices: defaultPrices});
    assert.deepEqual(plan.boxes, []);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.totalCents, 0);
  }
});

test("a missing presetsById map reports unknownPreset, not a crash", () => {
  const plan = planBoxes({
    lines: [{presetId: "bc14", quantity: 500}],
    presetsById: null,
    prices: defaultPrices,
  });
  assert.deepEqual(plan.blockers, ["unknownPreset"]);
});

test("a missing price table reports noPricedBox", () => {
  const plan = planBoxes({
    lines: [{presetId: "bc14", quantity: 500}],
    presetsById: presets,
    prices: undefined,
  });
  assert.deepEqual(plan.blockers, ["noPricedBox"]);
});

test("fractional quantities truncate rather than producing fractional boxes",
    () => {
      const plan = planBoxes({
        lines: [{presetId: "bc14", quantity: 500.7}],
        presetsById: presets,
        prices: defaultPrices,
      });
      assert.equal(plan.boxes.length, 1);
      assert.equal(plan.boxes[0].units, 500);
    });
