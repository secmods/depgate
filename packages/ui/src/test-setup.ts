import { vi } from 'vitest';

// Set up Angular test zone support for Vitest. zone.js/testing no longer loads zone.js itself.
import 'zone.js';
import 'zone.js/testing';

import { NgModule, provideZoneChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';

// TestBed is zoneless by default since Angular 21; the app runs on zone.js (app.config.ts), so the tests do too.
const ZoneChangeDetectionTestingModule = NgModule({ providers: [provideZoneChangeDetection()] })(class ZoneChangeDetectionTesting {});

// jsdom does not implement window.matchMedia; provide a minimal stub.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment([BrowserTestingModule, ZoneChangeDetectionTestingModule], platformBrowserTesting(), {
    teardown: { destroyAfterEach: true },
  });
}
