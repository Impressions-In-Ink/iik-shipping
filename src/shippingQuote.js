/**
 * Prices an order's shipping, per destination, from FedEx flat-rate box plans.
 * SERVER-AUTHORITATIVE twin of `lib/core/utils/shipping_quote.dart`.
 *
 * ## Why this is the single source
 *
 * The same shipping number has to appear on the card charge (cash collected)
 * and on the invoice delivery line that becomes the accounting system's revenue
 * record. Those two are reconciled against each other, so disagreeing is an
 * accounting defect. This function computes the number once, per destination,
 * and the result is recorded on the order for every downstream surface to read
 * rather than recomputed independently in each place.
 *
 * Per destination — not one order total — because the invoicing system models
 * exactly one ship-to per invoice, so a multi-destination order splits into one
 * invoice each and the delivery line is appended once per invoice. Destinations
 * can legitimately differ, so an order-level total cannot be distributed back
 * across them.
 *
 * ## The flat rate is a stopgap, not a fallback
 *
 * `company.flatDeliveryCharge` exists only because the app had no shipping
 * system, and it is being retired. A destination we cannot price is reported as
 * an explicit gap with a reason — a hole to close in product data, not a
 * supported pricing mode. Callers may apply the stopgap to keep checkout
 * working, but it stays a separate, auditable decision so a partly-priced order
 * can never be mistaken for a fully quoted one.
 *
 * Pure module — no Firestore, no network, no `admin` import. The caller loads
 * the presets and the price table and passes them in, which is what keeps this
 * unit-testable with no credentials and keeps `computeDeliveryCents` pure.
 *
 * Mirrored by the Dart twin above, with one shared fixture
 * (`test/fixtures/shipping_quote_vectors.json`) read by both test suites.
 */

"use strict";

const {planBoxes} = require("./boxPlanner");

/**
 * Group key for lines with no per-line destination. Mirrors
 * `kOrderDefaultDestinationKey` in `multi_ship.dart` and the admin submit
 * helper's grouping.
 */
const ORDER_DEFAULT_DESTINATION_KEY = "__order_default__";

/** Cap on distinct destinations, mirroring `kMaxShipDestinations`. */
const MAX_SHIP_DESTINATIONS = 12;

/**
 * Destination-level verdicts. Must stay identical to Dart's
 * `ShippingGapReason` names — the shared vectors assert on these strings, and
 * they are recorded on the order document.
 */
const GAP_REASONS = [
  "productNotConfigured",
  "presetIncomplete",
  "ownPackaging",
  "tooLargeForFlatRate",
  "ratesNotConfigured",
  "invalidLine",
];

/** Planner blocker -> destination-level reason. Mirrors the Dart mapping. */
const BLOCKER_TO_GAP = {
  missingPreset: "productNotConfigured",
  unknownPreset: "productNotConfigured",
  ownPackagingOnly: "ownPackaging",
  incompletePreset: "presetIncomplete",
  unitTooHeavy: "presetIncomplete",
  noPricedBox: "ratesNotConfigured",
  exceedsBoxCap: "tooLargeForFlatRate",
  invalidQuantity: "invalidLine",
};

/**
 * Groups order lines by destination using the same first-seen semantics as
 * `groupByDestination` (multi_ship.dart) and the admin submit helper: each
 * distinct trimmed `deliveryLocationId` is one shipment, and ALL id-less lines
 * collapse into a single order-default shipment.
 *
 * @param {Array<object>} items order.items
 * @return {Array<{key: string, items: Array<object>}>} groups, first-seen order
 */
function groupItemsByDestination(items) {
  const order = [];
  const byKey = new Map();
  for (const item of items) {
    const raw = item && typeof item.deliveryLocationId === "string" ?
      item.deliveryLocationId.trim() : "";
    const key = raw === "" ? ORDER_DEFAULT_DESTINATION_KEY : raw;
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key).push(item);
  }
  return order.map((key) => ({key, items: byKey.get(key)}));
}

/**
 * Best available display label for a destination, from the line's pinned
 * ship-to snapshot. Never throws on legacy shapes.
 *
 * @param {string} key destination key
 * @param {Array<object>} items lines in the group
 * @return {string} label
 */
function destinationLabel(key, items) {
  for (const item of items) {
    const addr = item && item.shipToAddress;
    if (addr && typeof addr === "object") {
      const parts = [];
      if (typeof addr.label === "string" && addr.label.trim()) {
        parts.push(addr.label.trim());
      } else if (typeof addr.recipientName === "string" &&
          addr.recipientName.trim()) {
        parts.push(addr.recipientName.trim());
      }
      if (typeof addr.city === "string" && addr.city.trim()) {
        parts.push(addr.city.trim());
      }
      if (parts.length) return parts.join(" · ");
    }
  }
  return key === ORDER_DEFAULT_DESTINATION_KEY ? "Order address" : key;
}

/**
 * Resolves a line's packaging preset id.
 *
 * Prefers the id PINNED on the order line at submit over the product stub's
 * current link: re-reading the product would let an admin re-linking it later
 * silently re-price a historical order.
 *
 * @param {object} item order line
 * @return {?string} preset id or null
 */
function presetIdForLine(item) {
  const pinned = item && typeof item.packagingPresetId === "string" ?
    item.packagingPresetId.trim() : "";
  if (pinned) return pinned;
  const product = (item && item.product) || {};
  const fromProduct = typeof product.packagingPresetId === "string" ?
    product.packagingPresetId.trim() : "";
  return fromProduct || null;
}

/**
 * Quotes shipping for an order, destination by destination.
 *
 * @param {object} args input
 * @param {object} args.order the orders/{id} document body
 * @param {object} args.presetsById presetId -> packaging preset doc
 * @param {object} args.prices size -> cents (from `priceTableFromConfig`)
 * @return {object} {destinations, pricedCents, isComplete, gaps, boxCount}
 */
function quoteShipping({order, presetsById, prices}) {
  const items = order && Array.isArray(order.items) ? order.items : [];
  if (items.length === 0) {
    return {
      destinations: [], pricedCents: 0, isComplete: false, gaps: [],
      boxCount: 0,
    };
  }

  const groups = groupItemsByDestination(items);
  const destinations = [];

  for (const group of groups) {
    const plan = planBoxes({
      lines: group.items.map((i) => ({
        presetId: presetIdForLine(i),
        quantity: i && typeof i.quantity === "number" ? i.quantity : 0,
        label: (i && i.product && i.product.name) || "",
      })),
      presetsById,
      prices,
    });

    const label = destinationLabel(group.key, group.items);

    if (plan.canShipFlatRate) {
      destinations.push({
        destinationKey: group.key,
        label,
        boxes: plan.boxes,
        cents: plan.totalCents,
        gap: null,
      });
    } else {
      // Blockers arrive in a deterministic order; the first is the one closest
      // to "fix the product data".
      const blocker = plan.blockers.length ? plan.blockers[0] : "missingPreset";
      destinations.push({
        destinationKey: group.key,
        label,
        boxes: [],
        cents: 0,
        gap: BLOCKER_TO_GAP[blocker] || "productNotConfigured",
      });
    }
  }

  const priced = destinations.filter((d) => d.gap === null);
  const gaps = destinations
      .filter((d) => d.gap !== null)
      .map((d) => ({destinationKey: d.destinationKey, reason: d.gap}));

  return {
    destinations,
    priced,
    gaps,
    pricedCents: priced.reduce((s, d) => s + d.cents, 0),
    boxCount: priced.reduce((s, d) => s + d.boxes.length, 0),
    isComplete: destinations.length > 0 && gaps.length === 0,
  };
}

/**
 * Total including a stopgap rate for each un-priceable destination.
 *
 * Kept separate from `pricedCents` so applying the retiring flat rate is always
 * an explicit decision at the call site, never folded silently into a quote.
 *
 * @param {object} quote result of `quoteShipping`
 * @param {number} stopgapCentsPerDestination cents per gap (0 to charge nothing)
 * @return {number} total cents
 */
function totalCentsWithStopgap(quote, stopgapCentsPerDestination) {
  const stopgap = Number(stopgapCentsPerDestination);
  const perGap = Number.isFinite(stopgap) && stopgap > 0 ?
    Math.trunc(stopgap) : 0;
  return quote.pricedCents + quote.gaps.length * perGap;
}

module.exports = {
  quoteShipping,
  totalCentsWithStopgap,
  groupItemsByDestination,
  presetIdForLine,
  destinationLabel,
  GAP_REASONS,
  BLOCKER_TO_GAP,
  ORDER_DEFAULT_DESTINATION_KEY,
  MAX_SHIP_DESTINATIONS,
};
