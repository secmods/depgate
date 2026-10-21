import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { vi } from 'vitest';
import { PackageCheckComponent } from './package-check.component';
import { PackageCheckResult, PackageCheckService, CheckedVersion } from '../../services/package-check.service';
import { RepositoryService } from '../../services/repository.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';
import { RequestWaiverDialogComponent } from '../waivers/request-waiver-dialog.component';
import { AddExceptionDialogComponent } from '../exceptions/add-exception-dialog.component';
import {
  epssLabel,
  installCommand,
  mergeRows,
  projectHealthMessage,
  recheckAfterLabel,
  rememberCheck,
  readRecentChecks,
  scoreTone,
  statusView,
  visibleRows,
} from './package-check';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function row(version: string, extra: Partial<CheckedVersion> = {}): CheckedVersion {
  return { version, position: 0, status: 'allowed', reasons: [], releaseType: 'stable', ...extra };
}

/** Rows in registry order: each gets its index as its position unless it sets one. */
function list(...rows: CheckedVersion[]): CheckedVersion[] {
  return rows.map((item, index) => ({ ...item, position: item.position || index }));
}

function result(versions: CheckedVersion[], extra: Partial<PackageCheckResult> = {}): PackageCheckResult {
  return {
    ecosystem: 'npm',
    package: 'lodash',
    repository: 'default',
    checkedAt: new Date().toISOString(),
    checkedAgainst: ['registry.npmjs.org'],
    totalVersions: versions.length,
    evaluated: versions.length,
    offset: 0,
    limit: 10,
    hasMore: false,
    recommended: null,
    packageNotice: null,
    missingVersions: [],
    versions,
    ...extra,
  };
}

describe('package check helpers', () => {
  it('builds the install command for every ecosystem', () => {
    expect(installCommand('npm', 'lodash', '4.17.21')).toBe('npm install lodash@4.17.21');
    expect(installCommand('pypi', 'requests', '2.31.0')).toBe('pip install requests==2.31.0');
    expect(installCommand('go', 'github.com/!burnt!sushi/toml', 'v1.3.2')).toBe('go get github.com/BurntSushi/toml@v1.3.2');
    expect(installCommand('maven', 'org.slf4j:slf4j-api', '2.0.13')).toContain('<artifactId>slf4j-api</artifactId>');
    expect(installCommand('nuget', 'newtonsoft.json', '13.0.3')).toBe('dotnet add package newtonsoft.json --version 13.0.3');
    expect(installCommand('cargo', 'serde', '1.0.200')).toBe('cargo add serde@1.0.200');
    expect(installCommand('composer', 'monolog/monolog', '3.5.0')).toBe('composer require monolog/monolog:3.5.0');
    expect(installCommand('rubygems', 'rake', '13.2.1')).toBe('gem install rake -v 13.2.1');
  });

  it('shows EPSS as a percentage and percentile, or — when unknown', () => {
    expect(epssLabel({ score: 0.421, percentile: 0.971 })).toBe('42.1 % · 97th');
    expect(epssLabel({ score: 0.0042, percentile: 0.21 })).toBe('0.42 % · 21st');
    expect(epssLabel({ score: 0.9, percentile: 0.12 })).toBe('90 % · 12th');
    expect(epssLabel(null)).toBe('—');
  });

  it('explains a Project health panel without a score, and colours scores', () => {
    expect(projectHealthMessage({ status: 'unknown', reason: 'not-scanned' })).toBe('No Scorecard result: Scorecard has not scanned the repository.');
    expect(projectHealthMessage({ status: 'not-applicable', reason: 'private-name' })).toBe('Not checked: the name is in an internal namespace.');
    expect(projectHealthMessage({ status: 'unavailable' })).toBe('Scorecard could not be reached.');
    expect([scoreTone(-1), scoreTone(2), scoreTone(5), scoreTone(8.9)]).toEqual(['neutral', 'danger', 'warning', 'success']);
    expect(statusView(row('1.0.0', { incomplete: ['scorecard'] })).label).toBe('Allowed · Scorecard unavailable');
  });

  it('never shows a plain Allowed when data was missing', () => {
    expect(statusView(row('1.0.0', { incomplete: ['cve'] }))).toEqual({
      label: 'Allowed · vulnerability data unavailable',
      tone: 'warning',
    });
    expect(statusView(row('1.0.0')).label).toBe('Allowed');
  });

  it('says when a monitoring policy would block an allowed version', () => {
    const monitoring = [{ policyId: 'p1', policyName: 'Approved licenses', reasons: ['License "GPL-3.0" is not in the approved list'] }];
    expect(statusView(row('1.0.0', { monitoring }))).toEqual({
      label: 'Allowed · would be blocked by "Approved licenses" (monitoring)',
      tone: 'info',
    });
    expect(statusView(row('1.0.0', { monitoring: [...monitoring, { ...monitoring[0], policyId: 'p2', policyName: 'B' }] })).label).toBe(
      'Allowed · would be blocked by "Approved licenses" and 1 more (monitoring)'
    );
  });

  it('hides a Composer dev branch when Hide pre-releases is on', () => {
    const rows = list(row('3.5.0'), row('dev-main', { releaseType: 'dev' }));
    expect(visibleRows(rows, { allowedOnly: false, hidePrerelease: true, search: '' }, 10).map((row) => row.version)).toEqual(['3.5.0']);
  });

  it('keeps the table in registry order and leaves out an asked-for version outside the window', () => {
    const rows = list(
      row('2.0.0-rc.1', { releaseType: 'prerelease' }),
      row('1.9.0', { status: 'blocked' }),
      row('1.8.0', { requested: true }),
      row('1.7.0'),
      row('1.0.0', { requested: true, status: 'blocked', position: 40 })
    );
    const none = { allowedOnly: false, hidePrerelease: false, search: '' };
    expect(visibleRows(rows, none, 4).map((r) => r.version)).toEqual(['2.0.0-rc.1', '1.9.0', '1.8.0', '1.7.0']);
    expect(visibleRows(rows, { ...none, allowedOnly: true }, 4).map((r) => r.version)).toEqual(['2.0.0-rc.1', '1.8.0', '1.7.0']);
    expect(visibleRows(rows, { ...none, hidePrerelease: true }, 4).map((r) => r.version)).toEqual(['1.9.0', '1.8.0', '1.7.0']);
    expect(visibleRows(rows, { ...none, search: '1.7' }, 4).map((r) => r.version)).toEqual(['1.7.0']);
  });

  it('merges a Load more page in registry order, keeping what the first page knew', () => {
    const first = [row('2.0.0', { position: 0 }), row('1.0.0', { position: 15, requested: true, waiverPending: true, status: 'blocked' })];
    const page = [row('1.5.0', { position: 10 }), row('1.0.0', { position: 15, status: 'blocked' })];
    const merged = mergeRows(first, page);
    expect(merged.map((r) => r.version)).toEqual(['2.0.0', '1.5.0', '1.0.0']);
    expect(merged[2]).toMatchObject({ requested: true, waiverPending: true });
  });

  it('keeps the last five checks, newest first, without duplicates', () => {
    localStorage.clear();
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) {
      rememberCheck({ ecosystem: 'npm', package: name, repository: 'default' });
    }
    expect(readRecentChecks().map((item) => item.package)).toEqual(['b', 'f', 'e', 'd', 'c']);
  });
});

describe('PackageCheckComponent', () => {
  let fixture: ComponentFixture<PackageCheckComponent>;
  let check: ReturnType<typeof vi.fn>;
  let isUser: ReturnType<typeof vi.fn>;
  let isSecurity: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let closed: Subject<unknown>;

  beforeEach(async () => {
    localStorage.clear();
    check = vi.fn();
    isUser = vi.fn().mockReturnValue(true);
    isSecurity = vi.fn().mockReturnValue(false);
    closed = new Subject();
    open = vi.fn().mockReturnValue({ closed });
    params = new BehaviorSubject(convertToParamMap({}));
    await TestBed.configureTestingModule({
      imports: [PackageCheckComponent],
      providers: [
        provideRouter([]),
        { provide: PackageCheckService, useValue: { check } },
        { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        { provide: AuthService, useValue: { isUser, isSecurity, getToken: () => 't' } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: NgbModal, useValue: { open } },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: params,
            get snapshot() {
              return { queryParamMap: params.value };
            },
          },
        },
      ],
    }).compileComponents();
  });

  function render(): HTMLElement {
    fixture = TestBed.createComponent(PackageCheckComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function submitForm(el: HTMLElement): void {
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
  }

  it('lists Composer branches without a checkbox, so Hide pre-releases can filter them', () => {
    check.mockReturnValue(of(result([])));
    const el = render();
    expect(el.textContent).not.toContain('Show dev branches');
    params.next(convertToParamMap({ ecosystem: 'composer', package: 'monolog/monolog' }));
    fixture.detectChanges();
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ ecosystem: 'composer', package: 'monolog/monolog', showDev: true }));
  });

  it('asks for a package name before checking', () => {
    const el = render();
    submitForm(el);
    expect(el.textContent).toContain('Enter a package name.');
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects a range in the version box', () => {
    const el = render();
    fixture.componentInstance.packageName = 'lodash';
    fixture.componentInstance.version = '^4.0.0';
    submitForm(el);
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Enter a single version');
    expect(check).not.toHaveBeenCalled();
  });

  it('fills the form from the URL and shows the asked-for version next to the recommendation', () => {
    check.mockReturnValue(
      of(
        result(
          list(
            row('4.17.21', { isDefault: true }),
            row('4.17.20', { status: 'blocked', policyName: 'Block old', reasons: ['Version 4.17.20 matches range "=4.17.20"'], requested: true })
          ),
          { recommended: { version: '4.17.21', releaseType: 'stable' } }
        )
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }));
    const el = render();
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ ecosystem: 'npm', package: 'lodash', versions: ['4.17.20'] }));
    expect(el.textContent).toContain('npm install lodash@4.17.21');
    const panel = el.querySelector('[data-testid=requested-version]')!;
    expect(panel.className).toContain('is-danger');
    expect(panel.textContent).toContain('4.17.20');
    expect(panel.textContent).toContain('Block old');
    expect(panel.textContent).toContain('Request waiver');
    expect(el.querySelector('tbody tr')!.textContent).toContain('4.17.21');
    expect(el.textContent).not.toContain('requested');
  });

  it('shows the internal namespace panel: served only from internal remotes, public ones not consulted', () => {
    check.mockReturnValue(
      of(
        result(list(row('1.0.0')), {
          package: '@acme/billing',
          repository: 'all',
          namespace: {
            reserved: true,
            mode: 'enforce',
            policyId: 'p1',
            policy: 'acme-npm',
            pattern: '@acme',
            internalRemotes: ['npm/acme-artifactory'],
            publicRemotesSkipped: ['npm/default'],
            outcome: 'internal',
          },
        })
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: '@acme/billing', repository: 'all' }));
    const el = render();
    const panel = el.querySelector('[data-testid=namespace-panel]')!;
    expect(panel.textContent).toContain('Reserved internal namespace @acme');
    expect(panel.textContent).toContain('acme-npm');
    expect(el.querySelector('[data-testid=namespace-internal]')!.textContent).toContain('npm/acme-artifactory');
    expect(el.querySelector('[data-testid=namespace-skipped]')!.textContent).toContain('npm/default');
    expect(el.querySelector('[data-testid=namespace-notice]')).toBeNull();
  });

  it('shows the Project health panel with the score, repository source and checks', () => {
    check.mockReturnValue(
      of(
        result(list(row('4.21.2', { requested: true })), {
          package: 'express',
          projectHealth: {
            version: '4.21.2',
            status: 'found',
            project: 'github.com/expressjs/express',
            via: 'registry',
            scoreVia: 'deps.dev',
            date: '2026-08-24T00:00:00.000Z',
            overall: 8.5,
            checks: [
              { name: 'Fuzzing', score: 0 },
              { name: 'Signed-Releases', score: -1 },
            ],
          },
        })
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'express', version: '4.21.2' }));
    const el = render();
    expect(el.querySelector('[data-testid=project-health-score]')!.textContent).toContain('8.5 / 10');
    expect(el.querySelector('[data-testid=project-health-repo]')!.getAttribute('href')).toBe('https://github.com/expressjs/express');
    expect(el.querySelector('[data-testid=project-health-source]')!.textContent).toContain('Declared by the package');
    expect(el.querySelector('[data-testid=project-health-backup]')!.textContent).toContain('Score from deps.dev');
    const details = el.querySelector('[data-testid=project-health-details]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('Details');
    expect(details.textContent).toContain('Fuzzing');
    expect(details.textContent).toContain('Inconclusive');
  });

  it('says why the Project health panel has no score', () => {
    check.mockReturnValue(
      of(result(list(row('1.0.0')), { projectHealth: { version: '1.0.0', status: 'not-applicable', reason: 'internal-remote' } }))
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    expect(el.querySelector('[data-testid=project-health-message]')!.textContent).toContain('Not checked: this repository has an internal remote.');
  });

  it('shows the namespace block when the repository has no internal remote', () => {
    check.mockReturnValue(
      of(
        result([], {
          package: '@acme/billing',
          packageNotice: {
            kind: 'namespace',
            policyName: 'acme-npm',
            message: 'Package "@acme/billing" is in reserved namespace "@acme" and repository "npm/default" has no internal remote',
          },
          missingVersions: ['1.0.0'],
          namespace: {
            reserved: true,
            mode: 'enforce',
            policyId: 'p1',
            policy: 'acme-npm',
            pattern: '@acme',
            internalRemotes: [],
            publicRemotesSkipped: ['npm/default'],
            outcome: 'blocked',
          },
        })
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: '@acme/billing', version: '1.0.0' }));
    const el = render();
    const notice = el.querySelector('[data-testid=namespace-notice]')!;
    expect(notice.textContent).toContain('Blocked: internal namespace');
    expect(notice.textContent).toContain('has no internal remote');
    expect(el.querySelector('[data-testid=namespace-internal]')!.textContent).toContain('no internal remote');
    expect(el.textContent).not.toContain('Version 1.0.0 not found');
  });

  it("shows the asked-for version's license, or that none is declared", () => {
    check.mockReturnValue(of(result(list(row('2.0.0'), row('1.0.0', { requested: true, license: 'MIT OR Apache-2.0' })))));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '1.0.0' }));
    const el = render();
    expect(el.querySelector('[data-testid=requested-license]')!.textContent).toContain('MIT OR Apache-2.0');

    check.mockReturnValue(of(result(list(row('1.0.0', { requested: true, license: null })))));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '1.0.0', repository: 'default' }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=requested-license]')!.textContent).toContain('Not declared');
  });

  it("shows the recommended version's license, and nothing when it could not be loaded", () => {
    check.mockReturnValue(
      of(
        result(list(row('2.0.0'), row('1.0.0', { requested: true, license: 'MIT' })), {
          recommended: { version: '2.0.0', releaseType: 'stable', license: 'BUSL-1.1' },
        })
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '1.0.0' }));
    const el = render();
    expect(el.querySelector('[data-testid=requested-license]')!.textContent).toContain('MIT');
    expect(el.querySelector('[data-testid=recommended-license]')!.textContent).toContain('BUSL-1.1');

    check.mockReturnValue(of(result(list(row('2.0.0')), { recommended: { version: '2.0.0', releaseType: 'stable', license: null } })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', repository: 'default' }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=recommended-license]')!.textContent).toContain('Not declared');

    check.mockReturnValue(of(result(list(row('2.0.0')), { recommended: { version: '2.0.0', releaseType: 'stable' } })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=recommended-license]')).toBeNull();
  });

  it("shows the recommended version's status and reasons like the asked-for panel", () => {
    const rec = { version: '2.0.0', releaseType: 'stable' as const };
    check.mockReturnValue(of(result(list(row('2.0.0'), row('1.0.0')), { recommended: rec })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    expect(el.querySelector('[data-testid=recommended-status]')!.textContent).toContain('Allowed');
    expect(el.querySelector('[data-testid=recommended-reason]')!.textContent).toContain('No policy blocks this version.');

    const expiresAt = '2027-01-31T00:00:00.000Z';
    check.mockReturnValue(
      of(result(list(row('2.0.0', { policyName: 'Exception', exception: { expiresAt } })), { recommended: rec }))
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', repository: 'default' }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=recommended-status]')!.textContent).toContain('Allowed · exception');
    expect(el.querySelector('[data-testid=recommended-reason]')!.textContent).toContain('Exception until Jan 31, 2027');
    expect(el.querySelector('[data-testid=recommended-reason]')!.textContent).not.toContain('No policy blocks');

    const monitoring = [{ policyId: 'p1', policyName: 'No GPL', reasons: ['License GPL-3.0 is not allowed'] }];
    check.mockReturnValue(of(result(list(row('2.0.0', { monitoring })), { recommended: rec })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=recommended-status]')!.textContent).toContain('Allowed ·');
    expect(el.querySelector('[data-testid=recommended-reason] [data-testid=monitoring-reason]')!.textContent).toContain(
      'Would be blocked by "No GPL" (monitoring)'
    );
  });

  it('shows an old asked-for version only in its panel, not in the table', () => {
    check.mockReturnValue(
      of(result(list(row('2.0.0'), row('1.0.0', { requested: true, position: 50 })), { totalVersions: 60, hasMore: true }))
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '1.0.0' }));
    const el = render();
    expect(el.querySelector('[data-testid=requested-version]')!.textContent).toContain('1.0.0');
    expect(el.querySelector('[data-testid=requested-version]')!.className).toContain('is-success');
    expect(Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.textContent)).toEqual([expect.stringContaining('2.0.0')]);
  });

  it('warns above the summary when the asked-for version does not exist', () => {
    check.mockReturnValue(of(result(list(row('2.0.0')), { missingVersions: ['9.9.9'] })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash', version: '9.9.9' }));
    const el = render();
    const warning = el.querySelector('.dg-callout.is-warning')!;
    expect(warning.textContent).toContain('Version 9.9.9 not found');
    const summary = el.querySelector('.pc-package')!.closest('section')!;
    expect(warning.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelector('[data-testid=requested-version]')).toBeNull();
  });

  it('opens the waiver dialog filled in, then shows Waiver pending', () => {
    check.mockReturnValue(of(result([row('4.17.20', { status: 'blocked', policyName: 'Block old' })])));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Request waiver')) as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(RequestWaiverDialogComponent, expect.anything());
    const injector = open.mock.calls[0][1].injector;
    // The checked repository is preselected as the waiver's scope.
    expect(injector.get(MODAL_DATA).prefill).toEqual({
      ecosystem: 'npm',
      packageName: 'lodash',
      version: '4.17.20',
      repository: 'default',
    });
    closed.next(true);
    fixture.detectChanges();
    expect(el.textContent).toContain('Waiver pending');
  });

  it('gives Security Add exception instead of Request waiver', () => {
    isUser.mockReturnValue(false);
    isSecurity.mockReturnValue(true);
    check.mockReturnValue(of(result([row('4.17.20', { status: 'blocked', policyName: 'Block old' })])));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    expect(el.textContent).not.toContain('Request waiver');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Add exception')) as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(AddExceptionDialogComponent, expect.anything());
  });

  it('shows no waiver action on a malware package', () => {
    check.mockReturnValue(
      of(
        result([row('1.0.0', { status: 'blocked', malicious: true, policyName: 'Malicious packages list' })], {
          packageNotice: { kind: 'malware', message: 'This package is on the malicious packages list' },
        })
      )
    );
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'evil' }));
    const el = render();
    expect(el.textContent).toContain('This package is on the malicious packages list');
    expect(el.textContent).not.toContain('Request waiver');
  });

  it('warns when vulnerability data was unavailable and recommends nothing', () => {
    check.mockReturnValue(of(result([row('1.0.0', { incomplete: ['cve'] })])));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    expect(el.textContent).toContain('Allowed · vulnerability data unavailable');
    expect(el.textContent).toContain("Vulnerability data could not be loaded");
    expect(el.textContent).toContain('No version of lodash is currently allowed');
  });

  it('applies the Allowed only filter', () => {
    check.mockReturnValue(of(result(list(row('2.0.0', { status: 'blocked' }), row('1.0.0')))));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'lodash' }));
    const el = render();
    expect(el.querySelectorAll('tbody tr').length).toBe(2);
    fixture.componentInstance.allowedOnly = true;
    fixture.detectChanges();
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('shows not found and upstream errors', () => {
    check.mockReturnValueOnce(throwError(() => ({ status: 404, error: { error: 'Package not found in default' } })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'nope' }));
    const el = render();
    expect(el.textContent).toContain('No package named "nope" in default.');

    check.mockReturnValueOnce(throwError(() => ({ status: 502, error: { error: 'x', registry: 'registry.npmjs.org' } })));
    params.next(convertToParamMap({ ecosystem: 'npm', package: 'down' }));
    fixture.detectChanges();
    expect(el.textContent).toContain("Couldn't reach registry.npmjs.org.");
    expect(el.textContent).toContain('Retry');
  });

  it('updates the URL on submit so the result is bookmarkable', () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const el = render();
    fixture.componentInstance.packageName = 'requests';
    fixture.componentInstance.ecosystem = 'pypi';
    submitForm(el);
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({
      queryParams: { ecosystem: 'pypi', package: 'requests', version: null, repository: null },
    }));
  });
});

describe('recheckAfterLabel', () => {
  it('includes the year when the date is not this year', () => {
    const now = new Date(2026, 9, 10, 12, 0);
    const later = new Date(2028, 8, 29, 0, 51);
    const sameYear = new Date(2026, 9, 12, 0, 16);
    expect(recheckAfterLabel(later.toISOString(), now)).toContain('2028');
    expect(recheckAfterLabel(sameYear.toISOString(), now)).not.toContain('2026');
  });
});
