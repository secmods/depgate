import { defineConfig } from 'vitest/config';
import angular from '@analogjs/vite-plugin-angular';

export default defineConfig({
  // Inline component styles are SCSS (angular.json inlineStyleLanguage); jsdom cannot parse raw nesting.
  plugins: [angular({ tsconfig: './tsconfig.spec.json', inlineStylesExtension: 'scss' })],
  resolve: {
    // Force Vite to deduplicate @angular/* packages — prevents two separate
    // module instances of @angular/core/testing which would break the TestBed
    // singleton pattern.
    dedupe: ['@angular/core', '@angular/common', '@angular/platform-browser'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Disable per-file module isolation so all test files share the same
    // module registry as the setup file. This is required to ensure there is
    // a single @angular/core/testing singleton across setupFiles and spec files.
    isolate: false,
    // The Angular plugin keeps component inline styles in memory while it compiles; a component
    // reused from Vitest's on-disk module cache then imports a style that was never registered.
    fsModuleCache: false,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      reportsDirectory: './coverage/ui',
    },
  },
});
