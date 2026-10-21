import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { NamespaceRuleComponent } from './namespace-rule.component';
import { NamespaceService, NamespaceRemote } from '../../services/namespace.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const remote = (key: string, source: 'public' | 'internal', looksPublic = false): NamespaceRemote => ({
  id: key,
  key,
  label: `npm/${key}`,
  url: `https://${key}.test`,
  source,
  isEnabled: true,
  looksPublic,
});

describe('NamespaceRuleComponent', () => {
  let fixture: ComponentFixture<NamespaceRuleComponent>;
  let component: NamespaceRuleComponent;
  let service: {
    remotes: ReturnType<typeof vi.fn>;
    validate: ReturnType<typeof vi.fn>;
    tryName: ReturnType<typeof vi.fn>;
  };

  async function setup(remotes: NamespaceRemote[], ecosystem = 'npm') {
    service = {
      remotes: vi.fn().mockReturnValue(of(remotes)),
      validate: vi.fn((_eco: string, patterns: string[]) =>
        of({
          results: patterns.map((pattern) => ({ pattern, error: pattern === '@acme-*' ? 'a scope is reserved whole' : null })),
          goNoSumDb: ecosystem === 'go' ? patterns.join(',') : null,
        })
      ),
      tryName: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NamespaceRuleComponent],
      providers: [{ provide: NamespaceService, useValue: service }],
    }).compileComponents();
    fixture = TestBed.createComponent(NamespaceRuleComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('ecosystem', ecosystem);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const q = (id: string) => (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

  it('ticks every internal remote by default and saves that as the default', async () => {
    await setup([remote('default', 'public'), remote('acme-artifactory', 'internal')]);
    const serving = vi.fn();
    component.internalRemotesChange.subscribe(serving);
    component['loadRemotes']();
    fixture.detectChanges();
    expect((q('ns-allowed-acme-artifactory') as HTMLInputElement).checked).toBe(true);
    expect((q('ns-allowed-default') as HTMLInputElement).checked).toBe(false);
    expect(q('ns-default-help')?.textContent).toContain('every internal remote');
    expect(q('ns-no-internal')).toBeNull();
    expect(serving).toHaveBeenCalledWith(['acme-artifactory']);
  });

  it('lists internal registries first and public ones in their own group', async () => {
    await setup([remote('default', 'public'), remote('acme-artifactory', 'internal'), remote('github-npm', 'public')]);
    const el = fixture.nativeElement as HTMLElement;
    const order = Array.from(el.querySelectorAll('[data-testid="ns-remotes"] .ns-group, [data-testid="ns-remotes"] .ns-remote')).map((row) =>
      row.classList.contains('ns-group') ? `# ${row.firstChild?.textContent?.trim()}` : row.textContent?.trim()
    );
    expect(order).toEqual(['# Internal registries', 'npm/acme-artifactory', '# Public registries', 'npm/default', 'npm/github-npm']);
    expect(q('ns-group-public')?.textContent).toContain('Only where you own this namespace');
  });

  it('warns that every name is blocked when there is no internal remote, but still lets it save', async () => {
    await setup([remote('default', 'public')]);
    const errors = vi.fn();
    component.errorsChange.subscribe(errors);
    component['loadRemotes']();
    fixture.detectChanges();
    expect(q('ns-no-internal')?.textContent).toContain('No internal npm registries: these names will be blocked.');
    expect(q('ns-group-internal')?.nextElementSibling?.textContent).toBe('None');
    expect(errors).toHaveBeenLastCalledWith([]);
  });

  it('flags a ticked internal remote whose URL is a public registry', async () => {
    await setup([remote('npmjs-mirror', 'internal', true)]);
    expect(q('ns-looks-public-npmjs-mirror')?.textContent).toContain('looks like a public registry');
  });

  it('shows nothing but the parent prompt until an ecosystem is chosen', async () => {
    await setup([remote('acme', 'internal')], '');
    expect(q('ns-reserved-input')).toBeNull();
    expect(q('ns-remotes')).toBeNull();
  });

  it('folds away the optional parts until asked for', async () => {
    await setup([remote('acme', 'internal')]);
    expect(q('ns-public')).toBeNull();
    expect(q('ns-try')).toBeNull();
    (q('ns-public-toggle') as HTMLButtonElement).click();
    (q('ns-try-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(q('ns-public')).not.toBeNull();
    expect(q('ns-try')).not.toBeNull();
    expect(q('ns-public-toggle')).toBeNull();
  });

  it('opens the public names field when the policy already has some', async () => {
    await setup([remote('acme', 'internal')]);
    fixture.componentRef.setInput('publicPackages', ['@acme/eslint-config']);
    fixture.detectChanges();
    expect(q('ns-public')?.textContent).toContain('@acme/eslint-config');
  });

  it('adds patterns as tags and reports invalid ones', async () => {
    await setup([remote('acme', 'internal')]);
    const reserved = vi.fn();
    const errors = vi.fn();
    component.reservedChange.subscribe(reserved);
    component.errorsChange.subscribe(errors);
    component.draft = '@acme, @acme-*';
    component.addReserved();
    fixture.detectChanges();
    expect(reserved).toHaveBeenLastCalledWith(['@acme', '@acme-*']);
    expect(service.validate).toHaveBeenLastCalledWith('npm', ['@acme', '@acme-*']);
    expect(errors).toHaveBeenLastCalledWith(['@acme-*: a scope is reserved whole']);
    expect(q('ns-pattern-error')?.textContent).toContain('a scope is reserved whole');
    component.removeReserved('@acme-*');
    expect(errors).toHaveBeenLastCalledWith([]);
  });

  it('shows the GONOSUMDB value for Go', async () => {
    await setup([remote('acme-goproxy', 'internal')], 'go');
    component.draft = 'github.com/acme';
    component.addReserved();
    fixture.detectChanges();
    expect(q('ns-gonosumdb')?.textContent).toContain('GONOSUMDB=github.com/acme');
    expect(q('ns-gonosumdb')?.querySelector('[aria-label="Why GONOSUMDB"]')).not.toBeNull();
  });

  it('Try a name checks the unsaved policy and shows the outcome', async () => {
    await setup([remote('acme', 'internal')]);
    component.reserved = ['@acme'];
    component.publicPackages = ['@acme/eslint-config'];
    service.tryName.mockReturnValue(
      of({
        ecosystem: 'npm',
        name: '@acme/billing',
        canonicalName: '@acme/billing',
        repository: 'all',
        reserved: true,
        outcome: 'internal',
        reason: 'Served only from internal remotes (npm/acme)',
        policy: { id: 'candidate', name: 'This policy', mode: 'enforce', pattern: '@acme' },
        servingRemotes: ['npm/acme'],
        internalRemotes: ['npm/acme'],
        publicRemotesSkipped: ['npm/default'],
      })
    );
    component.showTry = true;
    component.tryNameText = '@acme/billing';
    component.tryName();
    fixture.detectChanges();
    expect(service.tryName).toHaveBeenCalledWith(
      expect.objectContaining({ ecosystem: 'npm', name: '@acme/billing', repository: 'all', reservedNamespaces: ['@acme'], publicPackages: ['@acme/eslint-config'] })
    );
    expect(q('ns-try-result')?.textContent).toContain('Downloaded only from npm/acme');
    expect(q('ns-try-reason')?.textContent).toContain('Served only from internal remotes');
  });

  it('shows the error when the check is refused', async () => {
    await setup([remote('acme', 'internal')]);
    component.reserved = ['@acme'];
    service.tryName.mockReturnValue(throwError(() => ({ error: { error: 'Repository "x" does not exist' } })));
    component.showTry = true;
    component.tryNameText = 'x';
    component.tryName();
    fixture.detectChanges();
    expect(q('ns-try-error')?.textContent).toContain('does not exist');
  });
  it('binds the names to the ticked remotes (R6), emits them and tries them', async () => {
    await setup([remote('acme-artifactory', 'internal'), remote('default', 'public'), remote('github-npm', 'public')]);
    const allowed: string[][] = [];
    component.allowedRemotesChange.subscribe((ids) => allowed.push(ids));
    expect(component.servingRemotes.map((r) => r.key)).toEqual(['acme-artifactory']);
    (q('ns-allowed-github-npm') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(allowed.at(-1)).toEqual(['acme-artifactory', 'github-npm']);
    (q('ns-allowed-acme-artifactory') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(allowed.at(-1)).toEqual(['github-npm']);
    expect(component.servingRemotes.map((r) => r.key)).toEqual(['github-npm']);
    expect(component.skippedRemotes.map((r) => r.key)).toEqual(['acme-artifactory', 'default']);
    expect(q('ns-default-help')).toBeNull();

    service.tryName.mockReturnValue(of({ outcome: 'internal', internalRemotes: ['npm/github-npm'], reason: null }));
    component.reserved = ['@acme'];
    component.tryNameText = '@acme/billing';
    component.tryName();
    expect(service.tryName).toHaveBeenCalledWith(expect.objectContaining({ allowedRemotes: ['github-npm'], repository: 'all' }));

    // Back to exactly the internal remotes: saved as the default again.
    (q('ns-allowed-acme-artifactory') as HTMLInputElement).click();
    (q('ns-allowed-github-npm') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(allowed.at(-1)).toEqual([]);
    expect(component.servingRemotes.map((r) => r.key)).toEqual(['acme-artifactory']);
  });

  it('keeps the ticks of a saved policy', async () => {
    await setup([remote('acme-artifactory', 'internal'), remote('github-npm', 'public')]);
    fixture.componentRef.setInput('allowedRemotes', ['github-npm']);
    fixture.detectChanges();
    expect((q('ns-allowed-github-npm') as HTMLInputElement).checked).toBe(true);
    expect((q('ns-allowed-acme-artifactory') as HTMLInputElement).checked).toBe(false);
  });

  it('will not save with every remote unticked while an internal one exists', async () => {
    await setup([remote('acme-artifactory', 'internal'), remote('default', 'public')]);
    const errors = vi.fn();
    component.errorsChange.subscribe(errors);
    (q('ns-allowed-acme-artifactory') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(q('ns-no-internal')?.textContent).toContain('Select at least one remote');
    expect(errors).toHaveBeenLastCalledWith(['Select at least one remote to download these names from.']);
  });
});
