import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { ApproveDialogComponent } from './approve-dialog.component';
import { MonitorPackage, MonitorPolicy, MonitorService } from '../../services/monitor.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function policy(conditions: MonitorPolicy['conditions']): MonitorPolicy {
  return {
    id: 'p1', name: 'Licenses', description: null, conditions, isEnabled: true, priority: 0, mode: 'monitor',
    modeChangedAt: '2026-10-01T00:00:00Z', packages: 1, versions: 1, downloads: 1, willBlock: 1, approved: 0,
    partlyApproved: 0, approvable: true, approvalScope: 'any', lastSeenAt: null, capped: false, rowLimit: 50000,
    rechecking: false, retentionDays: 90,
  };
}

function pkg(name: string, versions: string[], alsoMatchedBy: MonitorPackage['alsoMatchedBy'] = []): MonitorPackage {
  return {
    ecosystem: 'npm', packageName: name, versionCount: versions.length,
    versionRange: { min: versions[versions.length - 1], max: versions[0] }, reasonKey: 'GPL-3.0', reasonKeys: ['GPL-3.0'],
    reasons: [], downloads: 3, firstSeenAt: null, lastSeenAt: null, status: 'will_block', approvedVersions: 0,
    totalVersions: versions.length, approvedUntil: null, alsoMatchedBy,
    versions: versions.map((version) => ({
      version, reasonKey: 'GPL-3.0', reasons: [], downloads: 1, firstSeenAt: null, lastSeenAt: null, approved: false, approvedUntil: null,
    })),
  };
}

async function open(p: MonitorPolicy, packages: MonitorPackage[]) {
  const monitor = { approve: vi.fn().mockReturnValue(of({ items: packages.map((x) => ({ id: 'e', action: 'created', packageName: x.packageName, version: '*' })) })) };
  const activeModal = { close: vi.fn(), dismiss: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [ApproveDialogComponent],
    providers: [
      { provide: MonitorService, useValue: monitor },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: NgbActiveModal, useValue: activeModal },
      { provide: MODAL_DATA, useValue: { policy: p, packages } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(ApproveDialogComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, monitor, activeModal };
}

describe('ApproveDialogComponent', () => {
  it('License defaults to all versions and needs a reason', async () => {
    const { component } = await open(policy({ licenseAllowList: ['MIT'] }), [pkg('gpl-a', ['2.0.0', '1.0.0'])]);
    expect(component.choices).toEqual(['matched', 'range', 'all']);
    expect(component.choice).toBe('all');
    expect(component.canSubmit).toBe(false);
    component.reason = 'legal approved';
    expect(component.canSubmit).toBe(true);
  });

  it('Packages defaults to the versions downloaded; bulk approve sends one item per package', async () => {
    const { component, monitor, activeModal } = await open(policy({ packageBlockList: ['gpl-*'] }), [
      pkg('gpl-a', ['2.0.0', '1.0.0']),
      pkg('gpl-b', ['1.0.0']),
    ]);
    expect(component.choice).toBe('matched');
    component.reason = 'needed';
    component.submit();
    expect(monitor.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: 'p1',
        reason: 'needed',
        items: [
          { ecosystem: 'npm', packageName: 'gpl-a', versions: ['2.0.0', '1.0.0'] },
          { ecosystem: 'npm', packageName: 'gpl-b', versions: ['1.0.0'] },
        ],
      })
    );
    expect(activeModal.close).toHaveBeenCalledWith(true);
  });

  it('Vulnerability offers listed versions only', async () => {
    const { fixture, component } = await open(policy({ cvssMin: 7 }), [pkg('vuln', ['1.0.0'])]);
    expect(component.choices).toEqual(['matched']);
    expect(fixture.nativeElement.querySelector('[data-testid="approve-scope-all"]')).toBeNull();
  });

  it('too many versions to list switches to the range', async () => {
    const versions = Array.from({ length: 20 }, (_, i) => `1.${19 - i}.0`);
    const { component } = await open(policy({ packageBlockList: ['x'] }), [pkg('many', versions)]);
    expect(component.choice).toBe('range');
  });

  it('warns about other monitoring policies that match', async () => {
    const { fixture } = await open(policy({ licenseAllowList: ['MIT'] }), [
      pkg('gpl-a', ['1.0.0'], [{ policyId: 'p2', policyName: 'No AGPL' }]),
    ]);
    expect(fixture.nativeElement.querySelector('[data-testid="approve-also-matched"]').textContent).toContain('"No AGPL"');
  });
});
