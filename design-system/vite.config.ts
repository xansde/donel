import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// Library build config — bundles src/index.ts into ESM + CJS output plus
// a single style.css, and emits rolled-up .d.ts declarations.
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src'],
      exclude: ['src/**/*.stories.tsx'],
      bundleTypes: true,
      insertTypesEntry: true,
    }),
  ],
  build: {
    // Fontes self-hosted (@fontsource) referenciam dezenas de arquivos
    // .woff/.woff2 por peso (um por unicode-range) — sem isso, o Vite
    // embute cada um como base64 dentro do style.css.
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'DonelDesignSystem',
      fileName: (format) =>
        format === 'es' ? 'donel-design-system.js' : 'donel-design-system.cjs',
      formats: ['es', 'cjs'],
    },
    cssCodeSplit: false,
    sourcemap: true,
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        },
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith('.css') ? 'style.css' : 'assets/[name][extname]',
      },
    },
  },
});
