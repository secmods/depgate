import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { UiConfigService } from './ui-config.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('UiConfigService', () => {
  let meta: HTMLMetaElement | null = null;

  function docsUrlFrom(content: string | null): string {
    meta?.remove();
    meta = null;
    if (content !== null) {
      meta = document.createElement('meta');
      meta.name = 'depgate-docs-url';
      meta.content = content;
      document.head.appendChild(meta);
    }
    TestBed.resetTestingModule();
    return TestBed.inject(UiConfigService).docsUrl;
  }

  afterEach(() => meta?.remove());

  it('reads DOCS_URL from the meta tag the server writes', () => {
    expect(docsUrlFrom('https://docs.example.com/')).toBe('https://docs.example.com/');
  });

  it('is empty without the tag, as under ng serve', () => {
    expect(docsUrlFrom(null)).toBe('');
  });

  it('ignores anything but an http(s) address', () => {
    expect(docsUrlFrom('javascript:alert(1)')).toBe('');
  });
});
