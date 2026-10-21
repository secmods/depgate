import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { everyLabel, JobsSettingsComponent, runSummary } from './jobs-settings.component';
import { JobRunRow, JobsService } from '../../services/jobs.service';
import { ToastService } from '../../services/toast.service';
import { provideRouter } from '@angular/router';
import { EpssService, EpssStatus } from '../../services/epss.service';

const EPSS_STATUS: EpssStatus = {
  state: 'completed',
  trigger: 'scheduled',
  startedAt: null,
  finishedAt: null,
  lastSuccessAt: '2026-10-13T01:00:00Z',
  scoreDate: '2026-10-12T12:00:26Z',
  modelVersion: 'v2026.06.15',
  rowCount: 385989,
  lastError: null,
  feedSource: 'https://raw.githubusercontent.com/empiricalsec/epss_scores/main/2026/epss_scores-2026-10-12.csv.gz',
  enabled: true,
  stale: false,
  staleAfterHours: 72,
};

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function run(extra: Partial<JobRunRow> = {}): JobRunRow {
  return { id: 'r1', trigger: 'scheduled', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null, ...extra };
}

describe('everyLabel and runSummary', () => {
  it('says intervals the way people do', () => {
    expect(everyLabel(null)).toBe('Off');
    expect(everyLabel(30 * 60_000)).toBe('Every 30 minutes');
    expect(everyLabel(3_600_000)).toBe('Every 1 hour');
    expect(everyLabel(24 * 3_600_000)).toBe('Every 24 hours');
    expect(everyLabel(72 * 3_600_000)).toBe('Every 3 days');
  });

  it('summarises a run in one line', () => {
    expect(runSummary(run({ result: { checked: 12, found: 1 } }))).toBe('checked 12, found 1');
    expect(runSummary(run({ result: { skipped: 'off' } }))).toBe('Skipped: the setting is off');
    expect(runSummary(run({ status: 'skipped', result: { skipped: 'Another run is in progress' } }))).toBe('Skipped: Another run is in progress');
    expect(runSummary(run({ status: 'failed', error: 'connect ECONNREFUSED' }))).toBe('connect ECONNREFUSED');
    expect(runSummary(run({ status: 'running' }))).toBe('Running…');
  });
});

describe('JobsSettingsComponent', () => {
  let fixture: ComponentFixture<JobsSettingsComponent>;
  let jobs: Record<string, ReturnType<typeof vi.fn>>;
  let toast: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let epss: { status: ReturnType<typeof vi.fn> };
  let epssStatus: EpssStatus;

  beforeEach(() => (epssStatus = EPSS_STATUS));

  async function setup(available = true) {
    jobs = {
      overview: vi.fn().mockReturnValue(of({
        available,
        queues: [
          { name: 'webhooks', available, waiting: 1, active: 0, delayed: 2, failed: 1 },
          { name: 'scheduled', available, waiting: 0, active: 0, delayed: 3, failed: 0 },
        ],
        schedules: [
          { job: 'namespace-collision-check', everyMs: 24 * 3_600_000, nextRunAt: new Date().toISOString(), runs: [run({ result: { checked: 4, found: 0 } })] },
          { job: 'malicious-feed-sync', everyMs: 6 * 3_600_000, nextRunAt: null, runs: [] },
          { job: 'monitor-retention-purge', everyMs: 24 * 3_600_000, nextRunAt: null, runs: [run({ status: 'failed', error: 'boom' })] },
          { job: 'epss-sync', everyMs: 24 * 3_600_000, nextRunAt: null, runs: [run({ result: { rows: 385989 } })] },
        ],
      })),
      failed: vi.fn().mockReturnValue(of({ items: [
        { queue: 'webhooks', id: 'wh-1', job: 'deliver', attempts: 8, maxAttempts: 8, error: 'HTTP 500', failedAt: new Date().toISOString(), ids: { deliveryId: '1' } },
      ] })),
      retry: vi.fn().mockReturnValue(of({ retried: true })),
      discard: vi.fn().mockReturnValue(of(undefined)),
      runNow: vi.fn().mockReturnValue(of({ queued: true, jobId: 'run-namespace-collision-check' })),
    };
    toast = { success: vi.fn(), error: vi.fn() };
    epss = { status: vi.fn().mockReturnValue(of(epssStatus)) };
    await TestBed.configureTestingModule({
      imports: [JobsSettingsComponent],
      providers: [
        { provide: JobsService, useValue: jobs },
        { provide: EpssService, useValue: epss },
        { provide: ToastService, useValue: toast },
        provideRouter([]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(JobsSettingsComponent);
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;

  it('shows the EPSS data under the EPSS scores sync row: date, rows, model and the GitHub backup source', async () => {
    await setup();
    const details = q('[data-testid="epss-details"]')!;
    expect(details.previousElementSibling!.getAttribute('data-testid')).toBe('schedule-epss-sync');
    expect(q('[data-testid="epss-rows"]')!.textContent).toContain('385,989');
    expect(q('[data-testid="epss-score-date"]')!.textContent).toContain('Oct 12, 2026');
    expect(details.textContent).toContain('v2026.06.15');
    expect(q('[data-testid="epss-source"]')!.textContent).toContain('GitHub backup');
    expect(q('[data-testid="epss-stale"]')).toBeNull();
    expect(q('[data-testid="epss-sync"]')).toBeNull();
  });

  it('warns under the EPSS row when the data was never synced, or EPSS is off', async () => {
    epssStatus = { ...EPSS_STATUS, scoreDate: null, rowCount: null, feedSource: null, stale: true, state: 'failed', lastError: 'No EPSS source could be read' };
    await setup();
    expect(q('[data-testid="epss-stale"]')!.textContent).toContain('never been synced');
    expect(q('[data-testid="epss-score-date"]')!.textContent).toContain('Never synced');

    epss.status.mockReturnValue(of({ ...EPSS_STATUS, enabled: false }));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(q('[data-testid="epss-disabled"]')).not.toBeNull();
    expect(q('[data-testid="epss-stale"]')).toBeNull();
  });

  it('shows no EPSS details when the status cannot be loaded', async () => {
    await setup();
    epss.status.mockReturnValue(throwError(() => ({ status: 500 })));
    fixture.componentInstance.load();
    fixture.detectChanges();
    expect(q('[data-testid="epss-details"]')).toBeNull();
  });

  it('lists the queues, the schedules with their last run, and failed jobs', async () => {
    await setup();
    expect(q('[data-testid="jobs-queues"]')!.textContent).toContain('Webhook deliveries');
    expect(q('[data-testid="schedule-namespace-collision-check"]')!.textContent).toContain('Every 24 hours');
    expect(q('[data-testid="schedule-namespace-collision-check"]')!.textContent).toContain('checked 4, found 0');
    expect(q('[data-testid="schedule-malicious-feed-sync"]')!.textContent).toContain('Never');
    expect(q('[data-testid="schedule-monitor-retention-purge"]')!.textContent).toContain('boom');
    expect(q('[data-testid="jobs-failed"]')!.textContent).toContain('HTTP 500');
    expect(q('[data-testid="jobs-unavailable"]')).toBeNull();
  });

  it('warns when the queue is unavailable and disables Run now', async () => {
    await setup(false);
    expect(q('[data-testid="jobs-unavailable"]')).not.toBeNull();
    expect((q('[data-testid="run-now-malicious-feed-sync"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs a job now and reports a run already in progress', async () => {
    await setup();
    (q('[data-testid="run-now-namespace-collision-check"]') as HTMLButtonElement).click();
    expect(jobs['runNow']).toHaveBeenCalledWith('namespace-collision-check');
    expect(toast.success).toHaveBeenCalledWith('Namespace collision check queued');

    jobs['runNow'].mockReturnValue(throwError(() => ({ status: 409, error: { error: 'Already running' } })));
    (q('[data-testid="run-now-namespace-collision-check"]') as HTMLButtonElement).click();
    expect(toast.error).toHaveBeenCalledWith('Namespace collision check is already running');
  });

  it('retries and discards a failed job', async () => {
    await setup();
    (q('[data-testid="failed-retry"]') as HTMLButtonElement).click();
    expect(jobs['retry']).toHaveBeenCalledWith('webhooks', 'wh-1');
    (q('[data-testid="failed-discard"]') as HTMLButtonElement).click();
    expect(jobs['discard']).toHaveBeenCalledWith('webhooks', 'wh-1');
    fixture.detectChanges();
    expect(q('[data-testid="jobs-no-failed"]')).not.toBeNull();
  });
});
