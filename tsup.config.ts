import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', adapters: 'src/adapters.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
})

