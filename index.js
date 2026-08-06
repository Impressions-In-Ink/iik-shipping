/**
 * Public surface of the shipping package.
 *
 * Consumers should import from here rather than reaching into `src/`, so the
 * internal file layout can change without breaking either Cloud Functions
 * codebase:
 *
 *   const {planBoxes, quoteShipping} = require("iik-shipping");
 *
 * The fixtures under `fixtures/` are also published (see `files` in
 * package.json) so a consumer can assert its own mirror against them — the
 * storefront's Dart tests do exactly that.
 */

"use strict";

const boxPlanner = require("./src/boxPlanner");
const shippingQuote = require("./src/shippingQuote");

module.exports = {
  ...boxPlanner,
  ...shippingQuote,
};
