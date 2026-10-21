import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RepositoryFormComponent } from './repository-form.component';
import { PackageRepositoryRow, RepositoryService } from '../../services/repository.service';
import { ConfigService } from '../../services/config.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function repo(extra: Partial<PackageRepositoryRow>): PackageRepositoryRow {
  return {
    id: 'r1',
    ecosystem: 'npm',
    key: 'acme',
    type: 'remote',
    upstreamUrl: 'https://artifactory.acme.test/npm',
    source: 'public',
    priority: 0,
    isEnabled: true,
    isReserved: false,
    timeoutMs: 30000,
    retryCount: 3,
    description: null,
    clientPath: '/npm/acme/',
    memberKeys: [],
    authConfigured: false,
    authType: null,
    createdAt: '',
    ...extra,
  };
}

describe('RepositoryFormComponent', () => {
  let service: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    policies: ReturnType<typeof vi.fn>;
  };
  let confirm: { confirm: ReturnType<typeof vi.fn> };

  /** /settings/repositories/new?eco=… when `id` is null, else /settings/repositories/:id/edit. */
  async function open(id: string | null, rows: PackageRepositoryRow[] = [], query: Record<string, string> = {}) {
    service = {
      list: vi.fn().mockReturnValue(of(rows)),
      create: vi.fn().mockReturnValue(of(repo({ id: 'new-id' }))),
      update: vi.fn().mockReturnValue(of(rows[0] ?? repo({}))),
      policies: vi.fn().mockReturnValue(of([])),
    };
    confirm = { confirm: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [RepositoryFormComponent],
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}), queryParamMap: convertToParamMap(query) } },
        },
        { provide: RepositoryService, useValue: service },
        { provide: ConfigService, useValue: { getGateway: () => of({ baseUrl: 'https://depgate.acme.test' }) } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmService, useValue: confirm },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(RepositoryFormComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('a new remote has no source until one is chosen, and sends the chosen source', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    expect(form.source).toBe('');
    form.key = 'acme';
    form.upstreamUrl = 'https://artifactory.acme.test/npm';
    fixture.detectChanges();
    expect(form.saveBlocker()).toBe('Choose a source');
    expect(el.querySelector('[data-testid=repo-source-required]')).not.toBeNull();
    form.save();
    expect(service.create).not.toHaveBeenCalled();

    form.source = 'internal';
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=repo-source-required]')).toBeNull();
    form.save();
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'internal', type: 'remote', key: 'acme', ecosystem: 'npm' }));
  });

  it('starts a new repository on the ecosystem from ?eco= and shows its client URL', async () => {
    const fixture = await open(null, [], { eco: 'pypi' });
    const form = fixture.componentInstance;
    expect(form.ecosystem).toBe('pypi');
    expect(form.clientUrl).toBe('');
    form.key = 'internal';
    expect(form.clientUrl).toBe('https://depgate.acme.test/pypi/internal/simple/');
    expect(form.returnUrl).toBe('/settings?tab=upstreams&eco=pypi');
  });

  it('after Create opens the edit page with the saved note', async () => {
    const fixture = await open(null);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const form = fixture.componentInstance;
    form.key = 'acme';
    form.upstreamUrl = 'https://artifactory.acme.test/npm';
    form.source = 'public';
    form.save();
    expect(navigate).toHaveBeenCalledWith(['/settings/repositories', 'new-id', 'edit'], { replaceUrl: true, state: { saved: 'created' } });
    expect(form.dirty).toBe(false);
  });

  it('a new virtual repository needs no source', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    form.type = 'virtual';
    form.key = 'frontend';
    expect(form.valid()).toBe(true);
  });

  it('an existing remote keeps its saved source and links to its client setup after Update', async () => {
    const fixture = await open('r1', [repo({ source: 'public' })]);
    const form = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    expect(form.editing).toBe(true);
    expect(form.source).toBe('public');
    expect(form.valid()).toBe(true);
    expect(el.querySelector('[data-testid=repo-saved]')).toBeNull();

    form.description = 'Acme mirror';
    expect(form.dirty).toBe(true);
    form.save();
    fixture.detectChanges();
    expect(service.update).toHaveBeenCalledWith('r1', expect.objectContaining({ description: 'Acme mirror' }));
    expect(form.dirty).toBe(false);
    const link = el.querySelector<HTMLAnchorElement>('[data-testid=repo-client-setup]');
    expect(link?.getAttribute('href')).toBe('/registry?eco=npm&key=acme');
  });

  it('shows an empty state when the repository no longer exists', async () => {
    const fixture = await open('gone', [repo({})]);
    expect(fixture.componentInstance.loadError).toContain('no longer exists');
  });

  it('warns when an internal remote points at a public registry', async () => {
    const fixture = await open('r1', [repo({ source: 'internal', upstreamUrl: 'https://registry.npmjs.org' })]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid=repo-source-public-warning]')?.textContent).toContain('This looks like a public registry');
    fixture.componentInstance.upstreamUrl = 'https://artifactory.acme.test/npm';
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=repo-source-public-warning]')).toBeNull();
  });

  it('shows the default remote as Public (fixed) and never sends a source for it', async () => {
    const fixture = await open('r1', [repo({ key: 'default', isReserved: true, upstreamUrl: 'https://registry.npmjs.org' })]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid=repo-source-fixed]')?.textContent).toContain('Public (fixed)');
    expect(el.querySelector('#repo-source-internal')).toBeNull();
    fixture.componentInstance.save();
    expect(service.update.mock.calls[0][1]).not.toHaveProperty('source');
  });

  it('asks before leaving with unsaved changes', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    expect(form.canLeave()).toBe(true);
    form.key = 'acme';
    await form.canLeave();
    expect(confirm.confirm).toHaveBeenCalled();
  });
});
