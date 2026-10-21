import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import {
  ArtifactCacheSettingsComponent,
  CLEAR_PHRASE,
  formFrom,
  formatBytes,
  hitRate,
  limitsPatch,
  percentOf,
} from './artifact-cache-settings.component';
import { ArtifactCacheService, ArtifactCacheStatus } from '../../services/artifact-cache.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const GB = 1024 ** 3;
const ENV = { maxSizeGb: 10, maxFiles: 200000, maxAgeDays: 30, maxIdleDays: 7, maxFileMb: 1024 };

function status(extra: Partial<ArtifactCacheStatus> = {}): ArtifactCacheStatus {
  return {
    enabled: true,
    available: true,
    environmentEnabled: true,
    setting: null,
    dir: '/var/lib/depgate/artifacts',
    limits: { ...ENV },
    environmentLimits: { ...ENV },
    savedLimits: {},
    pods: [
      {
        pod: 'depgate-7f9c-a',
        state: 'ok',
        lastError: null,
        sizeBytes: 9.6 * GB,
        maxSizeBytes: 10 * GB,
        limitedByDisk: false,
        files: 1200,
        maxFiles: 200000,
        hits24h: 900,
        misses24h: 100,
        updatedAt: new Date().toISOString(),
      },
      {
        pod: 'depgate-7f9c-b',
        state: 'error',
        lastError: 'ARTIFACT_CACHE_DIR /cache cannot be used: the directory does not exist',
        sizeBytes: 0,
        maxSizeBytes: 4 * GB,
        limitedByDisk: true,
        files: 0,
        maxFiles: 200000,
        hits24h: 0,
        misses24h: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
    redisAvailable: true,
    ...extra,
  };
}

describe('artifact cache helpers', () => {
  it('formats sizes in powers of 1024, rates and shares', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(150 * GB)).toBe('150 GB');
    expect(hitRate({ hits24h: 900, misses24h: 100 })).toBe(90);
    expect(hitRate({ hits24h: 0, misses24h: 0 })).toBeNull();
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });

  it('fills the form with saved values only; empty means the default', () => {
    expect(formFrom({ maxFiles: 5000 })).toEqual({ maxSizeGb: '', maxFiles: '5000', maxAgeDays: '', maxIdleDays: '', maxFileMb: '' });
  });

  it('sends only what changed: a number sets a field, an emptied field goes back to the default', () => {
    const saved = { maxFiles: 5000, maxAgeDays: 10 };
    const form = { maxSizeGb: '20', maxFiles: '5000', maxAgeDays: '', maxIdleDays: '0', maxFileMb: '' };
    expect(limitsPatch(form, saved)).toEqual({ patch: { maxSizeGb: 20, maxAgeDays: null, maxIdleDays: 0 } });
    expect(limitsPatch(formFrom(saved), saved)).toEqual({ patch: {} });
  });

  it.each([
    [{ maxSizeGb: '0' }, /Size per pod/],
    [{ maxFiles: '2.5' }, /Files per pod/],
    [{ maxAgeDays: '-1' }, /Expire after storing/],
    [{ maxFileMb: 'big' }, /Largest file stored/],
  ])('refuses %j', (bad, message) => {
    const result = limitsPatch({ ...formFrom({}), ...bad }, {});
    expect('error' in result && result.error).toMatch(message);
  });
});

describe('ArtifactCacheSettingsComponent', () => {
  let fixture: ComponentFixture<ArtifactCacheSettingsComponent>;
  let service: { status: ReturnType<typeof vi.fn>; purge: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let confirm: { confirm: ReturnType<typeof vi.fn> };

  async function setup(current: ArtifactCacheStatus | Error = status()) {
    service = {
      status: vi.fn().mockReturnValue(current instanceof Error ? throwError(() => ({ status: 500, error: { error: current.message } })) : of(current)),
      purge: vi.fn().mockReturnValue(of({ files: 3, bytes: 3 * 1024 * 1024, pods: 2 })),
      updateSettings: vi.fn((body: { enabled?: boolean | null; limits?: Record<string, number | null> }) => {
        const base = current instanceof Error ? status() : current;
        const savedLimits = { ...base.savedLimits } as Record<string, number>;
        for (const [key, value] of Object.entries(body.limits ?? {})) {
          if (value === null) delete savedLimits[key];
          else savedLimits[key] = value;
        }
        const enabled = body.enabled !== undefined ? body.enabled : base.setting;
        return of({ ...base, setting: enabled, enabled: enabled ?? base.environmentEnabled, savedLimits, limits: { ...ENV, ...savedLimits } });
      }),
    };
    toast = { success: vi.fn(), error: vi.fn() };
    confirm = { confirm: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [ArtifactCacheSettingsComponent],
      providers: [
        { provide: ArtifactCacheService, useValue: service },
        { provide: ToastService, useValue: toast },
        { provide: ConfirmService, useValue: confirm },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ArtifactCacheSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;
  const button = (id: string) => q(`[data-testid="${id}"]`) as HTMLButtonElement;
  const input = (id: string) => q(`[data-testid="${id}"]`) as HTMLInputElement;

  async function type(id: string, value: string): Promise<void> {
    const target = q(`[data-testid="${id}"]`) as HTMLInputElement | HTMLSelectElement;
    target.value = value;
    target.dispatchEvent(new Event(target.tagName === 'SELECT' ? 'change' : 'input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('shows every limit as an input with its default, and the directory read-only', async () => {
    await setup(status({ savedLimits: { maxFiles: 5000 }, limits: { ...ENV, maxFiles: 5000 } }));
    expect(input('acache-maxSizeGb').value).toBe('');
    expect(input('acache-maxSizeGb').placeholder).toBe('10');
    expect(input('acache-maxFiles').value).toBe('5000');
    expect(q('[data-testid="acache-limits"]')!.textContent).toContain('Default 200000');
    expect(q('[data-testid="acache-reset-maxFiles"]')).not.toBeNull();
    expect(q('[data-testid="acache-reset-maxSizeGb"]')).toBeNull();
    expect(q('[data-testid="acache-dir"]')!.textContent).toContain('/var/lib/depgate/artifacts');
    expect(q('input[data-testid="acache-dir"]')).toBeNull();
    expect(button('acache-save').disabled).toBe(true);
  });

  it('saves changed limits, and only the changed ones', async () => {
    await setup();
    await type('acache-maxSizeGb', '20');
    await type('acache-maxIdleDays', '14');
    expect(button('acache-save').disabled).toBe(false);
    button('acache-save').click();
    fixture.detectChanges();
    expect(service.updateSettings).toHaveBeenCalledWith({ limits: { maxSizeGb: 20, maxIdleDays: 14 } });
    expect(toast.success).toHaveBeenCalledWith('Artifact cache settings saved');
    expect(input('acache-maxSizeGb').value).toBe('20');
    expect(button('acache-save').disabled).toBe(true);
  });

  it('Reset empties a field, so saving goes back to the default; Undo restores the saved values', async () => {
    await setup(status({ savedLimits: { maxFiles: 5000 } }));
    button('acache-reset-maxFiles').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input('acache-maxFiles').value).toBe('');
    button('acache-undo').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(input('acache-maxFiles').value).toBe('5000');

    button('acache-reset-maxFiles').click();
    fixture.detectChanges();
    button('acache-save').click();
    expect(service.updateSettings).toHaveBeenCalledWith({ limits: { maxFiles: null } });
  });

  it('refuses an invalid value without calling the API', async () => {
    await setup();
    await type('acache-maxFiles', '0');
    button('acache-save').click();
    expect(service.updateSettings).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Files per pod/));
  });

  it('turns the cache on without asking, and asks before turning it off', async () => {
    await setup(status({ enabled: false, environmentEnabled: false }));
    expect(q('[data-testid="acache-source"]')!.textContent).toContain('Default (ARTIFACT_CACHE_ENABLED)');
    button('acache-switch').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(confirm.confirm).not.toHaveBeenCalled();
    expect(service.updateSettings).toHaveBeenCalledWith({ enabled: true });
    expect(button('acache-switch').getAttribute('aria-checked')).toBe('true');
    expect(q('[data-testid="acache-source"]')!.textContent).toContain('Set here');

    confirm.confirm.mockResolvedValueOnce(false);
    button('acache-switch').click();
    await fixture.whenStable();
    expect(service.updateSettings).toHaveBeenCalledTimes(1);
    button('acache-switch').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.updateSettings).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('Reset next to the switch follows the environment again', async () => {
    await setup(status({ enabled: false, setting: false }));
    button('acache-use-env').click();
    fixture.detectChanges();
    expect(service.updateSettings).toHaveBeenCalledWith({ enabled: null });
    expect(q('[data-testid="acache-source"]')!.textContent).toContain('Default');
  });

  it('cannot be turned on before a size per pod is set', async () => {
    await setup(status({ enabled: false, available: false, environmentEnabled: false, limits: { ...ENV, maxSizeGb: null }, environmentLimits: { ...ENV, maxSizeGb: null } }));
    expect(button('acache-switch').disabled).toBe(true);
    expect(q('[data-testid="acache-source"]')!.textContent).toContain('Set a size per pod');
    expect(input('acache-maxSizeGb').placeholder).toBe('not set');
  });

  it('lists each pod with its state, its error and a disk-limited size', async () => {
    await setup();
    const a = q('[data-testid="acache-pod-depgate-7f9c-a"]')!.textContent!;
    expect(a).toContain('On');
    expect(a).toContain('9.6 GB');
    expect(a).toContain('90 %');
    const b = q('[data-testid="acache-pod-depgate-7f9c-b"]')!;
    expect(b.textContent).toContain('directory does not exist');
    expect(b.querySelector('[data-testid="acache-disk-limited"]')).not.toBeNull();
    expect(q('[data-testid="acache-redis-down"]')).toBeNull();
  });

  it('warns when Redis is down', async () => {
    await setup(status({ redisAvailable: false }));
    expect(q('[data-testid="acache-redis-down"]')).not.toBeNull();
  });

  it('reports a status that cannot be loaded', async () => {
    await setup(new Error('Forbidden'));
    expect(toast.error).toHaveBeenCalledWith('Forbidden');
    expect(el().textContent).toContain('Status unavailable');
  });

  it('purges one version of a package after a confirmation', async () => {
    await setup();
    await type('acache-eco', 'maven');
    await type('acache-package', ' org.example:core ');
    await type('acache-version', '1.2.3');
    button('acache-purge').click();
    await fixture.whenStable();
    expect(service.purge).toHaveBeenCalledWith({ ecosystem: 'maven', package: 'org.example:core', version: '1.2.3' });
    expect(toast.success.mock.calls[0][0]).toContain('purge sent to 2 pods');
  });

  it('clears everything only after the phrase is typed', async () => {
    await setup();
    expect(button('acache-clear').disabled).toBe(true);
    await type('acache-clear-input', CLEAR_PHRASE.toUpperCase());
    expect(button('acache-clear').disabled).toBe(false);
    button('acache-clear').click();
    expect(service.purge).toHaveBeenCalledWith({ all: true });
  });
});
