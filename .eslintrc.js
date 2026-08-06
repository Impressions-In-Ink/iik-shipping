module.exports = {
  root: true,
  env: {
    es2021: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
  },
  extends: ["eslint:recommended", "google"],
  rules: {
    // Pragmatic relaxations so `predeploy` lint never blocks a deploy on
    // pure style. Real correctness checks (no-undef, no-unused-vars) stay on.
    "quotes": ["error", "double", {allowTemplateLiterals: true}],
    "max-len": ["warn", {code: 100, ignoreUrls: true, ignoreStrings: true,
      ignoreTemplateLiterals: true, ignoreComments: true}],
    "require-jsdoc": "off",
    "valid-jsdoc": "off",
    "new-cap": "off",
    "camelcase": "off",
    "object-curly-spacing": "off",
    "indent": "off",
    "comma-dangle": "off",
    "operator-linebreak": "off",
    // This repo is developed on Windows with core.autocrlf, so the working
    // tree is CRLF while git stores LF. Enforcing unix linebreaks makes the
    // predeploy lint fail on every fresh checkout on the deploy machine.
    "linebreak-style": "off",
    "no-unused-vars": ["warn", {args: "none"}],
  },
};
