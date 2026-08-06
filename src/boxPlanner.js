/**
 * Turns order quantities into a concrete list of FedEx flat-rate boxes and
 * their cost. SERVER-AUTHORITATIVE twin of `lib/core/utils/box_planner.dart`.
 *
 * ## The mirror contract
 *
 * The client shows the buyer a shipping figure; this side decides what is
 * actually charged. The two MUST agree, so both are driven by one shared
 * fixture — `test/fixtures/box_plan_vectors.json` at the repo root — read by
 * `test/box_planner_test.dart` and by `functions/test/boxPlanner.test.js`. A
 * behavioural drift between the two fails a vector on one side rather than
 * surfacing as a penny mismatch between quote and charge in production.
 *
 * Same arrangement as the consumers' other mirrored helpers, and
 * `delivery_fee.dart` ↔ `computeDeliveryCents`, but with the shared-vector
 * guard those two don't have.
 *
 * ## Rules baked in here (see the Dart twin for the long form)
 *
 *  - Money is integer CENTS. Float addition isn't associative, so doubles
 *    could put the quote and the charge a cent apart.
 *  - Capacity is capped by WEIGHT. FedEx weighs packages in its network and
 *    re-rates an over-limit box at full list Express rates, so a declared
 *    capacity is never trusted past the 50 lb ceiling.
 *  - Planning is ALL-OR-NOTHING per destination. A partially planned
 *    destination would be charged flat-rate shipping twice.
 *
 * Pure module: no Firestore, no network, no `admin` import — that's what makes
 * it runnable under `node --test` with no credentials.
 */

"use strict";

/** Per-box weight ceiling for One Rate boxes, in pounds. */
const FEDEX_BOX_WEIGHT_LIMIT_LBS = 50.0;

/** Most boxes one destination's plan may contain before we ask for a manual quote. */
const MAX_BOXES_PER_PLAN = 20;

/** Box sizes, smallest first. Order is load-bearing for the tie-break. */
const BOX_SIZES = ["small", "medium", "large"];

/** `packagingType` enum values the FedEx Rate/Ship APIs expect. */
const API_PACKAGING_TYPE = {
  small: "FEDEX_SMALL_BOX",
  medium: "FEDEX_MEDIUM_BOX",
  large: "FEDEX_LARGE_BOX",
};

/** Capacity field name on a preset doc, per size. */
const CAPACITY_FIELD = {
  small: "unitsPerSmallBox",
  medium: "unitsPerMediumBox",
  large: "unitsPerLargeBox",
};

/**
 * Blocker vocabulary. Must stay identical to Dart's `BoxPlanBlocker` names —
 * the shared vectors assert on these strings — and the array order defines the
 * deterministic sort used when several blockers apply.
 */
const BLOCKERS = [
  "missingPreset",
  "unknownPreset",
  "ownPackagingOnly",
  "incompletePreset",
  "unitTooHeavy",
  "noPricedBox",
  "exceedsBoxCap",
  "invalidQuantity",
];

/**
 * Declared capacity for one size, treating 0/negative/absent as unset.
 * A 0 is indistinguishable in meaning from a blank field and would divide by
 * zero downstream.
 * @param {object} preset packaging preset doc
 * @param {string} size one of BOX_SIZES
 * @return {?number} positive capacity or null
 */
function declaredCapacity(preset, size) {
  const raw = preset[CAPACITY_FIELD[size]];
  const n = typeof raw === "number" ? Math.trunc(raw) : null;
  return n !== null && n > 0 ? n : null;
}

/**
 * Weight of a single unit in pounds, from the per-thousand figure.
 * @param {object} preset packaging preset doc
 * @return {?number} positive per-unit weight or null
 */
function unitWeightLbs(preset) {
  const perThousand = preset && preset.weightLbsPerThousand;
  if (typeof perThousand !== "number" || perThousand <= 0) return null;
  return perThousand / 1000.0;
}

/**
 * Whether a preset carries enough data to plan flat-rate boxes. Mirrors
 * `PackagingPresetModel.canPlanOneRate`.
 * @param {object} preset packaging preset doc
 * @return {boolean} true when planable
 */
function canPlanOneRate(preset) {
  if (!preset || preset.ownPackagingOnly === true) return false;
  if (unitWeightLbs(preset) === null) return false;
  return BOX_SIZES.some((s) => declaredCapacity(preset, s) !== null);
}

/**
 * Reads the cents-per-size table from a `config/shipping` document.
 * @param {object} config shipping config doc (or null)
 * @return {object} size -> positive cents (missing sizes omitted)
 */
function priceTableFromConfig(config) {
  const raw = config && config.oneRateCents;
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const size of BOX_SIZES) {
    const v = raw[size];
    if (typeof v === "number" && v > 0) out[size] = Math.trunc(v);
  }
  return out;
}

/** @param {number} a numerator @param {number} b divisor @return {number} ceil */
function ceilDiv(a, b) {
  return Math.floor((a + b - 1) / b);
}

/** @param {number} v value @return {number} v rounded to one decimal */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Cheapest box mix covering `quantity`.
 *
 * Covering problem, not exact change: one bigger box may legitimately beat
 * several small ones. Exhaustive over a tiny space (≤3 sizes, ≤MAX boxes), so
 * it is optimal where a greedy cost-per-unit pass is not — greedy picks 2
 * medium over 1 large for 5,000 cards whenever the large box is the cheaper
 * cover. Ties: fewer boxes, then larger boxes, keeping the result deterministic
 * and matchable by the Dart twin.
 *
 * @param {number} quantity units to cover
 * @param {string[]} sizes candidate sizes, smallest first
 * @param {object} caps size -> effective capacity
 * @param {object} costs size -> cents
 * @param {number} maxBoxes ceiling on total boxes
 * @return {?object} size -> count, or null when uncoverable within maxBoxes
 */
function cheapestCombination(quantity, sizes, caps, costs, maxBoxes) {
  let best = null;
  let bestCost = 0;
  let bestBoxes = 0;
  let bestLargeWeight = 0;

  const descending = [...sizes].reverse();

  const consider = (counts) => {
    let capacity = 0;
    let cost = 0;
    let boxes = 0;
    let largeWeight = 0;
    for (const size of Object.keys(counts)) {
      const n = counts[size];
      capacity += caps[size] * n;
      cost += costs[size] * n;
      boxes += n;
      largeWeight += BOX_SIZES.indexOf(size) * n;
    }
    if (capacity < quantity || boxes === 0 || boxes > maxBoxes) return;

    const better = best === null ||
      cost < bestCost ||
      (cost === bestCost && boxes < bestBoxes) ||
      (cost === bestCost && boxes === bestBoxes &&
        largeWeight > bestLargeWeight);
    if (better) {
      best = {...counts};
      bestCost = cost;
      bestBoxes = boxes;
      bestLargeWeight = largeWeight;
    }
  };

  const recurse = (depth, counts, used) => {
    if (depth === descending.length - 1) {
      const size = descending[depth];
      let covered = 0;
      for (const s of Object.keys(counts)) covered += caps[s] * counts[s];
      const shortfall = quantity - covered;
      const n = shortfall <= 0 ? 0 : ceilDiv(shortfall, caps[size]);
      if (used + n > maxBoxes) return;
      consider({...counts, [size]: n});
      // One extra of the smallest size can win when it's unusually cheap
      // per unit relative to the bigger boxes.
      if (used + n + 1 <= maxBoxes) consider({...counts, [size]: n + 1});
      return;
    }
    const size = descending[depth];
    const maxOfThis = ceilDiv(quantity, caps[size]);
    for (let n = 0; n <= maxOfThis && used + n <= maxBoxes; n++) {
      recurse(depth + 1, {...counts, [size]: n}, used + n);
    }
  };

  if (descending.length === 1) {
    const size = descending[0];
    const n = ceilDiv(quantity, caps[size]);
    if (n > maxBoxes) return null;
    consider({[size]: n});
  } else {
    recurse(0, {}, 0);
  }
  return best;
}

/**
 * Plans one line's boxes.
 * @param {object} preset packaging preset doc
 * @param {number} quantity units on the line
 * @param {string} label product name for pack slips
 * @param {object} prices size -> cents
 * @param {number} maxBoxes ceiling on total boxes
 * @return {object} {boxes, blocker}
 */
function planLine(preset, quantity, label, prices, maxBoxes) {
  const unitWeight = unitWeightLbs(preset);
  if (unitWeight === null) return {boxes: [], blocker: "incompletePreset"};

  const byWeight = Math.floor(FEDEX_BOX_WEIGHT_LIMIT_LBS / unitWeight);
  if (byWeight < 1) return {boxes: [], blocker: "unitTooHeavy"};

  const caps = {};
  const costs = {};
  for (const size of BOX_SIZES) {
    const declared = declaredCapacity(preset, size);
    const price = prices[size];
    if (declared === null || !price || price <= 0) continue;
    const effective = Math.min(declared, byWeight);
    if (effective < 1) continue;
    caps[size] = effective;
    costs[size] = Math.trunc(price);
  }
  const sizes = BOX_SIZES.filter((s) => caps[s] !== undefined);
  if (sizes.length === 0) return {boxes: [], blocker: "noPricedBox"};

  const maxCap = Math.max(...sizes.map((s) => caps[s]));
  if (ceilDiv(quantity, maxCap) > maxBoxes) {
    return {boxes: [], blocker: "exceedsBoxCap"};
  }

  const best = cheapestCombination(quantity, sizes, caps, costs, maxBoxes);
  if (best === null) return {boxes: [], blocker: "exceedsBoxCap"};

  const boxes = [];
  let remaining = quantity;
  for (const size of [...sizes].reverse()) {
    const n = best[size] || 0;
    for (let i = 0; i < n; i++) {
      if (remaining <= 0) break;
      const units = Math.min(remaining, caps[size]);
      remaining -= units;
      boxes.push({
        size,
        packagingType: API_PACKAGING_TYPE[size],
        units,
        weightLbs: round1(units * unitWeight),
        priceCents: costs[size],
        lineLabel: label || "",
      });
    }
  }
  // Defensive: search says it covers, so leftovers mean the two disagree.
  if (remaining > 0) return {boxes: [], blocker: "exceedsBoxCap"};
  return {boxes, blocker: null};
}

/**
 * Plans the boxes for ONE destination.
 *
 * @param {object} args planner input
 * @param {Array<{presetId: ?string, quantity: number, label: ?string}>}
 *   args.lines lines to pack
 * @param {object} args.presetsById presetId -> packaging preset doc
 * @param {object} args.prices size -> cents
 * @param {number} [args.maxBoxes] ceiling on total boxes
 * @return {object} {boxes, blockers, totalCents, boxCount, canShipFlatRate}
 */
function planBoxes({lines, presetsById, prices, maxBoxes}) {
  const cap = typeof maxBoxes === "number" ? maxBoxes : MAX_BOXES_PER_PLAN;
  const result = (boxes, blockerSet) => {
    const blockers = BLOCKERS.filter((b) => blockerSet.has(b));
    const finalBoxes = blockers.length > 0 ? [] : boxes;
    return {
      boxes: finalBoxes,
      blockers,
      totalCents: finalBoxes.reduce((s, b) => s + b.priceCents, 0),
      boxCount: finalBoxes.length,
      canShipFlatRate: blockers.length === 0 && finalBoxes.length > 0,
    };
  };

  if (!Array.isArray(lines) || lines.length === 0) {
    return result([], new Set());
  }

  const boxes = [];
  const blockers = new Set();

  for (const line of lines) {
    const quantity = typeof line.quantity === "number" ?
      Math.trunc(line.quantity) : 0;
    if (quantity <= 0) {
      blockers.add("invalidQuantity");
      continue;
    }
    const presetId = typeof line.presetId === "string" ?
      line.presetId.trim() : "";
    if (presetId === "") {
      blockers.add("missingPreset");
      continue;
    }
    const preset = presetsById ? presetsById[presetId] : null;
    if (!preset) {
      blockers.add("unknownPreset");
      continue;
    }
    if (preset.ownPackagingOnly === true) {
      blockers.add("ownPackagingOnly");
      continue;
    }
    if (!canPlanOneRate(preset)) {
      blockers.add("incompletePreset");
      continue;
    }

    const planned = planLine(preset, quantity, line.label, prices || {}, cap);
    if (planned.blocker !== null) {
      blockers.add(planned.blocker);
      continue;
    }
    boxes.push(...planned.boxes);
  }

  if (blockers.size === 0 && boxes.length > cap) {
    blockers.add("exceedsBoxCap");
  }
  return result(boxes, blockers);
}

module.exports = {
  planBoxes,
  priceTableFromConfig,
  canPlanOneRate,
  unitWeightLbs,
  BOX_SIZES,
  BLOCKERS,
  API_PACKAGING_TYPE,
  FEDEX_BOX_WEIGHT_LIMIT_LBS,
  MAX_BOXES_PER_PLAN,
};
