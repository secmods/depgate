import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { MonitoringDetailComponent } from './monitoring-detail.component';
import { MonitorPackage, MonitorPolicy, MonitorService } from '../../services/monitor.service';
import { BreadcrumbService } from '../../services/breadcrumb.service';
import { ToastService } from '../../services/toast.service';
import { MonitorActionsService } from './monitor-actions.service';
import { ApproveDialogComponent } from './approve-dialog.component';
import { MODAL_DATA } from '../../tokens';
import { monitorPolicy } from './monitoring.testing';
import { RepositoryService } from '../../services/repository.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function pkg(name: string, extra: Partial<MonitorPackage> = {}): MonitorPackage {
  return {
    ecosystem: 'npm', packageName: name, versionCount: 2, versionRange: { min: '1.0.0', max: '2.0.0' }, reasonKey: 'GPL-3.0',
    reasonKeys: ['GPL-3.0'], reasons: ['License "GPL-3.0" is not in the approved list'], downloads: 30, firstSeenAt: null,
    lastSeenAt: new Date().toISOString(), status: 'will_block', approvedVersions: 0, totalVersions: 2, approvedUntil: null,
    alsoMatchedBy: [],
    versions: ['2.0.0', '1.0.0'].map((version) => ({
      version, reasonKey: 'GPL-3.0', reasons: ['GPL'], downloads: 15, firstSeenAt: null, lastSeenAt: null, approved: false, approvedUntil: null,
    })),
    ...extra,
  };
}

describe('MonitoringDetailComponent', () => {
  let fixture: ComponentFixture<MonitoringDetailComponent>;
  let component: MonitoringDetailComponent;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;
  let actions: Record<string, ReturnType<typeof vi.fn>>;
  let modal: { open: ReturnType<typeof vi.fn> };

  async function setup(policy: MonitorPolicy | null, packages: MonitorPackage[] = []) {
    monitor = {
      policy: vi.fn().mockReturnValue(policy ? of(policy) : throwError(() => ({ status: 404 }))),
      reasons: vi.fn().mockReturnValue(
        of({ items: [
          { reasonKey: 'GPL-3.0', packages: 2, versions: 3, downloads: 40, share: 1, lastSeenAt: null, reasons: [] },
          { reasonKey: 'UNKNOWN', packages: 1, versions: 1, downloads: 2, share: 0.5, lastSeenAt: null, reasons: [] },
        ] })
      ),
      packages: vi.fn().mockReturnValue(of({ items: packages, total: packages.length, limit: 50, offset: 0 })),
      exportCsv: vi.fn().mockReturnValue(of(new Blob(['a']))),
      refreshCount: vi.fn(),
    };
    actions = { enforce: vi.fn().mockResolvedValue(false), restart: vi.fn().mockResolvedValue(false), editRule: vi.fn().mockResolvedValue(false) };
    modal = { open: vi.fn().mockReturnValue({ closed: of(false) }) };
    await TestBed.configureTestingModule({
      imports: [MonitoringDetailComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id: 'p1' })).asObservable() } },
        { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        { provide: MonitorService, useValue: monitor },
        { provide: MonitorActionsService, useValue: actions },
        { provide: NgbModal, useValue: modal },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MonitoringDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;

  it('shows the policy header with Export, Enforce and the breadcrumb name', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    expect(q('[data-testid="detail-title"]')!.textContent).toContain('Approved licenses');
    expect(el().textContent).toMatch(/Monitoring since .* \(12 days\)/);
    expect(q('[data-testid="detail-export"]')).not.toBeNull();
    expect(q('[data-testid="detail-enforce"]')).not.toBeNull();
    expect(TestBed.inject(BreadcrumbService).detail()).toBe('Approved licenses');
  });

  it('clears the breadcrumb name when leaving', async () => {
    await setup(monitorPolicy(), []);
    fixture.destroy();
    expect(TestBed.inject(BreadcrumbService).detail()).toBeNull();
  });

  it('loads the report with the default filters', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    expect(monitor['reasons']).toHaveBeenCalledWith('p1', 'all');
    expect(monitor['packages']).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: 'p1', status: 'will_block', lastSeenWithin: 'all', sort: 'downloads', limit: 50, offset: 0 })
    );
    expect(q('[data-testid="pkg-gpl-a"]')!.textContent).toContain('Will be blocked');
    expect(el().textContent).toContain('Packages nobody approves are blocked on Enforce');
  });

  it('a reason group filters the package list', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    q('[data-testid="reason-UNKNOWN"]')!.click();
    expect(monitor['packages']).toHaveBeenLastCalledWith(expect.objectContaining({ reasonKey: 'UNKNOWN', offset: 0 }));
    fixture.detectChanges();
    expect(q('[data-testid="reason-UNKNOWN"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('filters by status and last downloaded', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    component.status = 'approved';
    component.reloadPackages();
    component.lastSeenWithin = '30d';
    component.onLastSeen();
    expect(monitor['reasons']).toHaveBeenLastCalledWith('p1', '30d');
    expect(monitor['packages']).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved', lastSeenWithin: '30d' }));
  });

  it('expands a package to its versions', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    (q('[data-testid="pkg-gpl-a"] button[aria-expanded]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelector('.mon-versions')!.textContent).toContain('2.0.0');
  });

  it('bulk approve opens the dialog with the checked packages', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a'), pkg('gpl-b')]);
    (q('[data-testid="pkg-gpl-a"] input[type="checkbox"]') as HTMLInputElement).click();
    (q('[data-testid="pkg-gpl-b"] input[type="checkbox"]') as HTMLInputElement).click();
    fixture.detectChanges();
    q('[data-testid="bulk-approve"]')!.click();
    expect(modal.open).toHaveBeenCalledWith(ApproveDialogComponent, expect.anything());
    const data = modal.open.mock.calls[0][1].injector.get(MODAL_DATA);
    expect(data.packages.map((p: MonitorPackage) => p.packageName)).toEqual(['gpl-a', 'gpl-b']);
  });

  it('hides Approve for release age and release type policies', async () => {
    await setup(monitorPolicy({ conditions: { releaseAgeMaxHours: 72 } }), [pkg('fresh', { reasonKey: 'too_new' })]);
    expect(q('[data-testid="approve-fresh"]')).toBeNull();
    expect(q('[data-testid="pkg-fresh"] input[type="checkbox"]')).toBeNull();
    expect(component.canApprove).toBe(false);
  });

  it('links Also matched by to the other policy page', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a', { alsoMatchedBy: [{ policyId: 'p2', policyName: 'No AGPL' }] })]);
    const link = q('[data-testid="pkg-gpl-a"] a.mon-link') as HTMLAnchorElement;
    expect(link.textContent).toContain('No AGPL');
    expect(link.getAttribute('href')).toBe('/monitoring/p2');
  });

  it('exports what is shown', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    component.setReason('GPL-3.0');
    URL.createObjectURL = vi.fn().mockReturnValue('blob:x');
    URL.revokeObjectURL = vi.fn();
    component.exportShown('version');
    expect(monitor['exportCsv']).toHaveBeenCalledWith(expect.objectContaining({ policyId: 'p1', reasonKey: 'GPL-3.0', status: 'will_block' }), 'version');
  });

  it('Enforce and Restart go through the shared actions', async () => {
    await setup(monitorPolicy(), [pkg('gpl-a')]);
    q('[data-testid="detail-enforce"]')!.click();
    expect(actions['enforce']).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    await component.restart();
    expect(actions['restart']).toHaveBeenCalled();
  });

  it('an enforced policy is read-only: Export only', async () => {
    await setup(monitorPolicy({ mode: 'enforce' }), [pkg('gpl-a')]);
    expect(q('[data-testid="detail-export"]')).not.toBeNull();
    expect(q('[data-testid="detail-enforce"]')).toBeNull();
    expect(q('[data-testid="detail-more"]')).toBeNull();
    expect(q('[data-testid="approve-gpl-a"]')).toBeNull();
  });

  it('says nothing has matched yet for a policy without rows', async () => {
    await setup(monitorPolicy({ versions: 0, packages: 0, willBlock: 0 }), []);
    expect(q('[data-testid="monitor-report"]')!.textContent).toContain('Nothing downloaded has matched this policy since');
  });

  it('shows how far a recheck has got', async () => {
    await setup(monitorPolicy({ rechecking: true, recheckProgress: { done: 40, total: 120 } }), [pkg('gpl-a')]);
    expect(q('[data-testid="report-recheck-progress"]')!.textContent).toContain('40 of 120 packages');
    expect(q('[data-testid="report-recheck-failed"]')).toBeNull();
  });

  it('offers Retry after a recheck failed, and starts it again', async () => {
    await setup(monitorPolicy({ recheckFailed: true }), [pkg('gpl-a')]);
    monitor['recheck'] = vi.fn().mockReturnValue(of({ recheck: true }));
    expect(q('[data-testid="report-recheck-failed"]')!.textContent).toContain('Recheck failed');
    q('[data-testid="report-recheck-retry"]')!.click();
    expect(monitor['recheck']).toHaveBeenCalledWith('p1');
    fixture.detectChanges();
    expect(q('[data-testid="report-recheck-failed"]')).toBeNull();
    expect(q('[data-testid="report-rechecking"]')).not.toBeNull();
  });

  it('an enforced policy shows a failed recheck without Retry', async () => {
    await setup(monitorPolicy({ mode: 'enforce', recheckFailed: true }), [pkg('gpl-a')]);
    expect(q('[data-testid="report-recheck-failed"]')).not.toBeNull();
    expect(q('[data-testid="report-recheck-retry"]')).toBeNull();
  });

  it('shows Policy not found for an unknown id', async () => {
    await setup(null);
    expect(el().textContent).toContain('Policy not found');
  });
});
