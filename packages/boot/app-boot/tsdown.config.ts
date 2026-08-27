import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: ['@deepseek-ai/cordis-plugin-include'],
  },
} as const

/**
 * Embed Include while keeping Loader external so the built include tree and
 * app host bind to one Loader peer.
 */
export default defineConfig([
  {
    ...shared,
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  },
  {
    ...shared,
    entry: ['lib/types/profile-runtime-bridge.js'],
    deps: {
      neverBundle: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/cordis-plugin-include',
        '@deepseek-ai/cordis-plugin-loader',
      ],
    },
    // The public bridge entry is release-inlined by the standalone Manager.
    // Keep its own source self-contained while preserving the host's single
    // Cordis/Loader/Include framework graph.
    outputOptions: { codeSplitting: false },
  },
])
