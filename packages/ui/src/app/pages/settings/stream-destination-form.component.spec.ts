import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { StreamDestinationFormComponent } from './stream-destination-form.component';
import { EventCatalog, EventsService, StreamDestination } from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const CATALOG: EventCatalog = {
  features: [
    {
      feature: 'decisions',
      label: 'Decisions',
      groups: [
        {
          events: [
            { key: 'decision.block', type: 'BLOCK', label: 'Block', category: 'decision', severity: 'warning', default: true },
            { key: 'decision.allow', type: 'ALLOW', label: 'Allow', category: 'decision', severity: 'info', default: false, highVolume: true },
          ],
        },
      ],
    },
    {
      feature: 'admin',
      label: 'Admin changes',
      groups: [{ events: [{ key: 'audit.policy', type: 'policy', label: 'Policy changed', category: 'audit', severity: 'notice', default: true }] }],
    },
  ],
  presets: {
    recommended: { features: ['admin'], events: ['decision.block'] },
    everything: { features: ['decisions', 'admin'], events: [] },
  },
  webhookEvents: [],
};

function destination(extra: Partial<StreamDestination> = {}): StreamDestination {
  return {
    id: 'd1',
    name: 'Splunk production',
    type: 'splunk',
    enabled: true,
    settings: { url: 'https://splunk.acme.test:8088' },
    secrets: { token: { set: true } },
    selection: { features: ['admin'], events: ['decision.block'] },
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

describe('StreamDestinationFormComponent', () => {
  let service: Record<string, ReturnType<typeof vi.fn>>;
  let confirm: { confirm: ReturnType<typeof vi.fn> };

  /** /settings/log-streaming/new when `id` is null, else /settings/log-streaming/:id/edit. */
  async function open(id: string | null, items: StreamDestination[] = []) {
    service = {
      destinations: vi.fn().mockReturnValue(of({ items, volume: { ALLOW: 120000 }, highVolume: { types: [], estimatePerDay: 0 } })),
      catalog: vi.fn().mockReturnValue(of(CATALOG)),
      createDestination: vi.fn().mockReturnValue(of(destination())),
      updateDestination: vi.fn().mockReturnValue(of(destination())),
      testUnsaved: vi.fn().mockReturnValue(of({ ok: true, status: 200, reply: '{"text":"Success"}', error: '' })),
    };
    confirm = { confirm: vi.fn().mockResolvedValue(true) };
    await TestBed.configureTestingModule({
      imports: [StreamDestinationFormComponent],
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } } },
        { provide: EventsService, useValue: service },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: ConfirmService, useValue: confirm },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(StreamDestinationFormComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('a new destination starts on the recommended events and says what is missing', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    expect(form.editing).toBe(false);
    expect([...form.selected].sort()).toEqual(['audit.policy', 'decision.block']);
    expect(form.saveBlocker()).toBe('Choose a type');

    form.pickType('splunk');
    expect(form.name).toBe('Splunk');
    expect(form.typeGridOpen).toBe(false);
    expect(form.saveBlocker()).toBe('Fill in URL');
    form.settings['url'] = 'https://splunk.acme.test:8088';
    expect(form.saveBlocker()).toBe('Fill in HEC token');
    form.secrets['token'] = 'hec-token';
    expect(form.canSave).toBe(true);
    expect(form.endpointSummary).toBe('splunk.acme.test:8088');
  });

  it('renames a type-named destination when the type changes, but keeps a typed name', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    form.pickType('splunk');
    form.pickType('datadog');
    expect(form.name).toBe('Datadog');
    form.name = 'SIEM prod';
    form.pickType('elastic');
    expect(form.name).toBe('SIEM prod');
  });

  it('creates the destination with whole features compacted and returns to Log streaming', async () => {
    const fixture = await open(null);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const form = fixture.componentInstance;
    form.pickType('splunk');
    form.settings['url'] = 'https://splunk.acme.test:8088';
    form.secrets['token'] = 'hec-token';
    form.save();
    expect(service['createDestination']).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'splunk',
        name: 'Splunk',
        secrets: { token: 'hec-token' },
        selection: { features: ['admin'], events: ['decision.block'] },
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/settings?tab=streaming');
    expect(form.dirty).toBe(false);
  });

  it('edits an existing destination: type fixed, stored secret counts as filled', async () => {
    const fixture = await open('d1', [destination()]);
    const form = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    expect(form.editing).toBe(true);
    expect(el.querySelector('[data-testid=dest-type-chosen]')).not.toBeNull();
    expect(el.querySelector('[data-testid=dest-type-change]')).toBeNull();
    expect(form.canSave).toBe(true);
    expect(form.dirty).toBe(false);
    form.toggle('decision.allow', true);
    expect(form.dirty).toBe(true);
    form.save();
    expect(service['updateDestination']).toHaveBeenCalledWith('d1', expect.objectContaining({ selection: { features: ['decisions', 'admin'], events: [] } }));
  });

  it('shows the test result and the high-volume note in the summary', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    form.pickType('jsonl');
    form.applyPreset('everything');
    form.test();
    fixture.detectChanges();
    const summary = el.querySelector('[data-testid=dest-summary-panel]')!;
    expect(summary.querySelector('[data-testid=dest-test-result]')?.textContent).toContain('Test event delivered');
    expect(summary.querySelector('[data-testid=dest-summary-volume]')?.textContent).toContain('120,000');
  });

  it('disables Container output when another destination already uses it', async () => {
    const fixture = await open(null, [destination({ id: 'j1', type: 'jsonl', name: 'stdout' })]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLButtonElement>('[data-testid=dest-type-jsonl]')?.disabled).toBe(true);
  });

  it('shows an empty state when the destination no longer exists', async () => {
    const fixture = await open('gone', [destination()]);
    expect(fixture.componentInstance.loadError).toContain('no longer exists');
  });

  it('HTTP: defaults, header rules, and secret header values sent only in secrets', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    form.pickType('http');
    expect(form.settings).toEqual({ method: 'POST', format: 'ndjson', gzip: 'on' });
    form.settings['url'] = 'https://cribl.acme.test/ingest';
    expect(form.endpointSummary).toBe('POST cribl.acme.test');
    expect(form.canSave).toBe(true);

    form.addHeader();
    expect(form.saveBlocker()).toBe('Enter a header name');
    form.headers[0] = { name: 'Content-Type', value: 'text/plain', secret: false };
    expect(form.saveBlocker()).toBe('DepGate sets Content-Type itself');
    form.headers[0] = { name: 'X-Tenant', value: 'acme', secret: false };
    form.addHeader();
    form.headers[1] = { name: 'x-tenant', value: 'b', secret: false };
    expect(form.saveBlocker()).toBe('Header x-tenant is listed twice');
    form.headers[1] = { name: 'Authorization', value: '', secret: true };
    expect(form.saveBlocker()).toBe('Enter the value of header Authorization');
    form.headers[1].value = 'Bearer abc';
    expect(form.canSave).toBe(true);

    form.save();
    const sent = service['createDestination'].mock.calls[0][0];
    expect(JSON.parse(sent.settings.headers)).toEqual([{ name: 'X-Tenant', value: 'acme' }, { name: 'Authorization', secret: true }]);
    expect(sent.secrets).toEqual({ 'header:authorization': 'Bearer abc' });
  });

  it('HTTP edit: a stored secret header may stay empty', async () => {
    const fixture = await open('h1', [
      destination({
        id: 'h1',
        type: 'http',
        name: 'Cribl',
        settings: { url: 'https://cribl.acme.test/ingest', method: 'PUT', format: 'array', gzip: 'off', headers: JSON.stringify([{ name: 'Authorization', secret: true }]) },
        secrets: { 'header:authorization': { set: true } },
      }),
    ]);
    const form = fixture.componentInstance;
    expect(form.headers).toEqual([{ name: 'Authorization', value: '', secret: true }]);
    expect(form.canSave).toBe(true);
    expect(form.dirty).toBe(false);
  });

  it('asks before leaving with unsaved changes', async () => {
    const fixture = await open(null);
    const form = fixture.componentInstance;
    expect(form.canLeave()).toBe(true);
    form.pickType('syslog');
    await form.canLeave();
    expect(confirm.confirm).toHaveBeenCalled();
  });
});
