import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ChipInputComponent, splitList } from './chip-input.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('ChipInputComponent', () => {
  function create(values: string[] = []) {
    const fixture = TestBed.createComponent(ChipInputComponent);
    const chips = fixture.componentInstance;
    chips.values = values;
    const emitted: string[][] = [];
    const drafts: string[] = [];
    chips.valuesChange.subscribe((v) => emitted.push(v));
    chips.draftChange.subscribe((d) => drafts.push(d));
    fixture.detectChanges();
    return { fixture, chips, emitted, drafts };
  }

  it('splits on commas and spaces', () => {
    expect(splitList(' a, b  c,,d ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('adds what was typed once, skipping duplicates', () => {
    const { chips, emitted } = create(['lodash']);
    chips.draft = 'react lodash react';
    chips.add();
    expect(emitted.at(-1)).toEqual(['lodash', 'react']);
    expect(chips.draft).toBe('');
  });

  it('turns pasted text into chips at once and keeps the part still being typed', () => {
    const { chips, emitted, drafts } = create();
    chips.onDraft('CVE-2024-1, CVE-2024-2 CVE-20');
    expect(emitted.at(-1)).toEqual(['CVE-2024-1', 'CVE-2024-2']);
    expect(chips.draft).toBe('CVE-20');
    expect(drafts.at(-1)).toBe('CVE-20');

    chips.onDraft('CVE-2024-3,');
    expect(emitted.at(-1)).toEqual(['CVE-2024-1', 'CVE-2024-2', 'CVE-2024-3']);
    expect(chips.draft).toBe('');
  });

  it('reports a draft without separators as typed', () => {
    const { chips, emitted, drafts } = create();
    chips.onDraft('left-p');
    expect(emitted).toEqual([]);
    expect(drafts).toEqual(['left-p']);
    chips.add();
    expect(emitted.at(-1)).toEqual(['left-p']);
  });

  it('clears the text box once what was typed becomes chips', () => {
    const { fixture } = create();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input') as HTMLInputElement;
    input.value = 'CVE-2024-1 CVE-20';
    input.dispatchEvent(new Event('input'));
    expect(input.value).toBe('CVE-20');
    input.dispatchEvent(new Event('blur'));
    expect(input.value).toBe('');
  });

  it('marks invalid chips and says why', () => {
    const { fixture, chips } = create(['CVE-2024-1', 'oops']);
    chips.errorOf = (v) => (v === 'oops' ? 'Not an advisory ID' : '');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.dg-chip-danger').length).toBe(1);
    expect(el.querySelector('.text-danger')?.textContent).toContain('oops: Not an advisory ID');
  });

  it('removes a chip', () => {
    const { chips, emitted } = create(['a', 'b']);
    chips.remove('a');
    expect(emitted.at(-1)).toEqual(['b']);
  });
});
