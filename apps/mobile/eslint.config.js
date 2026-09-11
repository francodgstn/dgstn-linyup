// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// Tripwire shared with the web app (apps/web/eslint.firestorePaths.mjs): a
// Firestore path segment typed as a string where @linyup/shared already owns
// the constant fails lint. The forbidden set is read from shared's build.
// The rule module is ESM; this config is CommonJS, hence the dynamic import.
module.exports = (async () => {
  const { firestorePathLiteralRule } = await import('../web/eslint.firestorePaths.mjs');
  return defineConfig([
    expoConfig,
    {
      ignores: ["dist/*"],
    },
    {
      files: ['src/**/*.{ts,tsx}'],
      rules: {
        'no-restricted-syntax': ['error', firestorePathLiteralRule(require)],
      },
    },
  ]);
})();
