import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { PolicyFormComponent, safeReturnUrl } from './policy-form.component';
import { PolicyService, Policy } from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';
import { LicenseService } from '../../services/license.service';
import { ExceptionService } from '../../services/exception.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { RepositoryService } from '../../services/repository.service';
import { NamespaceService } from '../../services/namespace.service';

type PolicyServiceMock = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
type ToastServiceMock = {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
type LicenseServiceMock = {
  loadLicenses: ReturnType<typeof vi.fn>;
  searchLicenses: ReturnType<typeof vi.fn>;
};

/** The route of /policies/new or /policies/:id/edit, with its query string. */
function routeStub(id: string | null, query: Record<string, string> = {}) {
  return {
    provide: ActivatedRoute,
    useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}), queryParamMap: convertToParamMap(query) } },
  };
}

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('PolicyFormComponent', () => {
  let component: PolicyFormComponent;
  let fixture: ComponentFixture<PolicyFormComponent>;
  let policyService: PolicyServiceMock;
  let toastService: ToastServiceMock;
  let licenseService: LicenseServiceMock;
  let confirm: { confirm: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    policyService = { create: vi.fn(), update: vi.fn() };
    toastService = { success: vi.fn(), error: vi.fn() };
    licenseService = {
      loadLicenses: vi.fn().mockResolvedValue([]),
      searchLicenses: vi.fn().mockResolvedValue([]),
    };
    confirm = { confirm: vi.fn().mockResolvedValue(true) };

    await TestBed.configureTestingModule({
      imports: [PolicyFormComponent],
      providers: [
        { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        {
          provide: NamespaceService,
          useValue: {
            remotes: vi.fn().mockReturnValue(of([])),
            validate: vi.fn((_eco: string, patterns: string[]) =>
              of({ results: patterns.map((pattern) => ({ pattern, error: null })), goNoSumDb: null })
            ),
            tryName: vi.fn(),
          },
        },
        { provide: PolicyService, useValue: policyService },
        { provide: ToastService, useValue: toastService },
        { provide: LicenseService, useValue: licenseService },
        { provide: ExceptionService, useValue: { list: vi.fn().mockReturnValue(of({ items: [], total: 0, active: 0, expired: 0 })), delete: vi.fn() } },
        provideRouter([{ path: '**', children: [] }]),
        routeStub(null),
        { provide: ConfirmService, useValue: confirm },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PolicyFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('offers every ecosystem', () => {
    expect(component.ecosystems).toEqual(['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems']);
  });

  it('offers the seven rules and starts with none chosen', () => {
    expect(component.rules.map((r) => r.id)).toEqual(['packages', 'releaseType', 'releaseAge', 'vulnerability', 'license', 'namespace', 'scorecard']);
    expect(component.rule).toBe('');
    expect(component.editing).toBe(false);
    expect(component.canSave()).toBe(false);
  });

  it('needs a name and a filled rule to save', () => {
    component.rule = 'license';
    component.selectedLicenses = ['GPL-3.0'];
    expect(component.canSave()).toBe(false);
    component.name = 'Deny GPL';
    expect(component.canSave()).toBe(true);
  });

  it('says why Create is unavailable next to the disabled button', () => {
    const blocker = () => {
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('[data-testid="policy-save-blocker"]') as HTMLElement | null;
      return el?.textContent?.trim() ?? '';
    };
    expect(blocker()).toBe('Enter a name.');
    component.name = 'qa';
    expect(blocker()).toBe('Select a rule.');
    component.selectRule('packages');
    expect(blocker()).toBe('Add at least one package name.');
    component.selectRule('vulnerability');
    expect(blocker()).toBe('Add a CVE ID, enter a CVSS score, or set an EPSS threshold.');
    component.selectRule('license');
    expect(blocker()).toBe('Add at least one license.');
    component.selectedLicenses = ['MIT'];
    expect(blocker()).toBe('');
    expect(component.canSave()).toBe(true);
  });

  describe('actions per rule', () => {
    it('offers Allow only for the Packages rule', () => {
      expect(component.decisionOptions).toEqual(['ALLOW', 'BLOCK']);
      component.selectRule('packages');
      expect(component.decisionOptions).toEqual(['ALLOW', 'BLOCK']);
      for (const rule of ['releaseType', 'releaseAge', 'vulnerability', 'license'] as const) {
        component.selectRule(rule);
        expect(component.decisionOptions, rule).toEqual(['BLOCK']);
      }
    });

    it('switches Allow to Block when the rule does not offer it', () => {
      component.selectRule('packages');
      component.decision = 'ALLOW';
      component.selectRule('vulnerability');
      expect(component.decision).toBe('BLOCK');
    });

    it('asks for the action inside the Packages rule only, and warns about Allow', () => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="policy-decision"]')).toBeNull();

      component.selectRule('packages');
      component.decision = 'ALLOW';
      fixture.detectChanges();
      const body = fixture.nativeElement.querySelector('[data-testid="policy-rule-body"]') as HTMLElement;
      const options = Array.from((body.querySelector('[data-testid="policy-decision"]') as HTMLSelectElement).options).map((o) => o.value);
      expect(options).toEqual(['ALLOW', 'BLOCK']);
      expect(body.querySelector('[data-testid="policy-allow-warning"]')!.textContent).toContain('skip every lower-priority policy');
    });

    it('shows no action dropdown for a rule that only blocks', () => {
      component.selectRule('license');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="policy-decision"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="policy-decision-invalid"]')).toBeNull();
    });
  });

  describe('packages rule', () => {
    beforeEach(() => {
      component.name = 'Packages';
      component.rule = 'packages';
    });

    it('needs package names; versions are optional', () => {
      expect(component.canSave()).toBe(false);
      component.packageBlockListStr = 'left-pad';
      expect(component.canSave()).toBe(true);
      expect(component.buildConditions()).toEqual({ packageBlockList: ['left-pad'] });
    });

    it('rejects an incomplete range or range syntax in a version box', () => {
      component.packageBlockListStr = 'rails';
      component.ecosystem = 'rubygems';
      component.addVersionRange();
      component.versionConstraints[0].from = '1.0.0';
      expect(component.canSave()).toBe(false);
      component.versionConstraints[0].to = '2.0.0';
      expect(component.canSave()).toBe(true);
      component.addExactVersion();
      component.versionConstraints[1].version = '~> 1.2';
      expect(component.canSave()).toBe(false);
      component.versionConstraints[1].version = '1.2.0.rc1';
      expect(component.canSave()).toBe(true);
    });

    it('saves exact versions with = and ranges as written', () => {
      policyService.create.mockReturnValue(of({} as Policy));
      component.ecosystem = 'maven';
      component.packageBlockListStr = 'com.acme:*';
      component.addExactVersion();
      component.versionConstraints[0].version = '1.0-SNAPSHOT';
      component.addVersionRange();
      component.versionConstraints[1].from = '1.0.0';
      component.versionConstraints[1].to = '2.0.0';
      component.save();

      expect(policyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conditions: {
            ecosystem: ['maven'],
            packageBlockList: ['com.acme:*'],
            versionRange: '=1.0-SNAPSHOT || 1.0.0 - 2.0.0',
          },
        })
      );
    });

    it('adds and removes version rows', () => {
      component.addExactVersion();
      component.addVersionRange();
      expect(component.versionConstraints).toEqual([
        { kind: 'exact', version: '', from: '', to: '' },
        { kind: 'range', version: '', from: '', to: '' },
      ]);
      component.removeVersionConstraint(0);
      expect(component.versionConstraints).toEqual([{ kind: 'range', version: '', from: '', to: '' }]);
    });

    it('describes the versions in the review summary', () => {
      component.packageBlockListStr = 'lodash';
      component.addExactVersion();
      component.versionConstraints[0].version = '1.2.3';
      component.addVersionRange();
      component.versionConstraints[1].from = '3.0.0';
      component.versionConstraints[1].to = '4.0.0';
      expect(component.versionSummary).toBe('1.2.3, 3.0.0 – 4.0.0');
      expect(component.summary).toEqual({ lead: 'Versions 1.2.3, 3.0.0 – 4.0.0 of:', items: ['lodash'], notes: [] });
    });
  });

  describe('release type rule', () => {
    beforeEach(() => {
      component.name = 'No pre-releases';
      component.rule = 'releaseType';
      fixture.detectChanges();
    });

    it('shows each type with its description, where it applies, and examples', () => {
      const text = (id: string) =>
        (fixture.nativeElement.querySelector(`[data-testid="release-type-${id}"]`) as HTMLElement).textContent ?? '';
      expect(text('prerelease')).toContain('Alpha, beta, RC, preview.');
      expect(text('prerelease')).toContain('All ecosystems');
      expect(text('prerelease')).toContain('2.0.0rc1');
      expect(text('dev')).toContain('PyPI, Composer');
      expect(text('snapshot')).toContain('1.0-SNAPSHOT');
      expect(text('pseudo')).toContain('v0.0.0-20240101120000-abcdef123456');
    });

    it('shows examples for the chosen ecosystem and disables types that cannot occur there', () => {
      component.ecosystem = 'maven';
      fixture.detectChanges();
      const row = (id: string) => fixture.nativeElement.querySelector(`[data-testid="release-type-${id}"]`) as HTMLElement;
      expect(row('prerelease').textContent).toContain('2.0.0-RC1');
      expect(row('prerelease').textContent).not.toContain('2.0.0rc1');
      expect((row('snapshot').querySelector('input') as HTMLInputElement).disabled).toBe(false);
      expect((row('pseudo').querySelector('input') as HTMLInputElement).disabled).toBe(true);
      expect(row('pseudo').textContent).toContain('Not in Maven');
      expect(fixture.nativeElement.textContent).toContain('31.1-jre');
    });

    it('needs at least one type that occurs in the ecosystem', () => {
      expect(component.canSave()).toBe(false);
      component.toggleReleaseType('pseudo');
      expect(component.canSave()).toBe(true);
      component.ecosystem = 'npm';
      expect(component.canSave()).toBe(false);
    });

    it('selects every non-stable type that applies', () => {
      component.ecosystem = 'pypi';
      component.selectAllReleaseTypes();
      expect(component.selectedReleaseTypes).toEqual(['prerelease', 'dev']);
      component.ecosystem = '';
      component.selectAllReleaseTypes();
      expect(component.selectedReleaseTypes).toEqual(['prerelease', 'dev', 'snapshot', 'pseudo']);
    });

    it('saves only the types that apply and explains the policy in review', () => {
      policyService.create.mockReturnValue(of({} as Policy));
      component.toggleReleaseType('prerelease');
      component.toggleReleaseType('snapshot');
      component.toggleReleaseType('pseudo');
      component.ecosystem = 'maven';

      expect(component.summary).toEqual({ lead: 'Versions that are:', items: ['Pre-release', 'Snapshot'], notes: [] });
      expect(component.matchedExamples).toEqual(['2.0.0-RC1', '1.0-M1', '1.0-SNAPSHOT', '1.0-20240101.123456-1']);
      component.save();
      expect(policyService.create).toHaveBeenCalledWith(
        expect.objectContaining({ conditions: { ecosystem: ['maven'], releaseTypes: ['prerelease', 'snapshot'] } })
      );
    });

  });

  describe('release age, vulnerability and license rules', () => {
    beforeEach(() => {
      component.name = 'Rule';
    });

    it('saves too new, unmaintained, or both, and needs a number for each ticked option', () => {
      component.rule = 'releaseAge';
      expect(component.canSave()).toBe(false);

      component.tooNewEnabled = true;
      expect(component.canSave()).toBe(false);
      component.tooNewHoursStr = '72';
      expect(component.buildConditions()).toEqual({ releaseAgeMaxHours: 72 });
      expect(component.summary.items).toEqual(['Published less than 72 hours ago']);

      component.unmaintainedEnabled = true;
      expect(component.canSave()).toBe(false);
      expect(component.releaseAgeIncomplete).toBe(true);
      component.unmaintainedDaysStr = '365';
      expect(component.canSave()).toBe(true);
      expect(component.buildConditions()).toEqual({ releaseAgeMaxHours: 72, releaseAgeMinDays: 365 });
      expect(component.summary).toEqual({
        lead: 'Versions matching:',
        items: ['Published less than 72 hours ago', 'from packages with no release in 365 days'],
        notes: [],
      });

      component.tooNewEnabled = false;
      expect(component.buildConditions()).toEqual({ releaseAgeMinDays: 365 });
      expect(component.summary.items).toEqual(['From packages with no release in 365 days']);
    });

    it('fills in the usual number when a release age option is selected', () => {
      component.rule = 'releaseAge';
      component.setTooNew(true);
      component.setUnmaintained(true);
      expect(component.tooNewHoursStr).toBe('72');
      expect(component.unmaintainedDaysStr).toBe('365');
      expect(component.canSave()).toBe(true);
      component.tooNewHoursStr = '12';
      component.setTooNew(false);
      component.setTooNew(true);
      expect(component.tooNewHoursStr).toBe('12');
    });

    it('matches a CVE list or a CVSS score, either one', () => {
      component.rule = 'vulnerability';
      expect(component.canSave()).toBe(false);
      component.cvssMinStr = '7';
      expect(component.canSave()).toBe(true);
      component.cveBlockListStr = 'CVE-2024-1234';
      component.ecosystem = 'npm';
      expect(component.buildConditions()).toEqual({
        ecosystem: ['npm'],
        cveBlockList: ['CVE-2024-1234'],
        cvssMin: 7,
      });
      expect(component.summary).toEqual({
        lead: 'Versions with:',
        items: ['CVSS ≥ 7.0', 'CVE-2024-1234'],
        notes: [{ label: 'Vulnerabilities without CVSS', value: 'ignored' }],
      });
    });

    it('takes CVE IDs as chips, counts typed text, and flags IDs that are not advisory IDs', () => {
      component.rule = 'vulnerability';
      component.cveIds = ['CVE-2024-1234'];
      component.cveDraft = 'GHSA-abcd-efgh-ijkl, CVE-2024-1234';
      expect(component.cveList).toEqual(['CVE-2024-1234', 'GHSA-abcd-efgh-ijkl']);
      expect(component.canSave()).toBe(true);
      component.cveIds = ['log4shell'];
      expect(component.cveError('log4shell')).toContain('Not an advisory ID');
      expect(component.saveBlocker()).toBe('Fix the CVE ID marked invalid.');
    });

    it('takes a CVSS score from 0.1 to 10 with one decimal, and can match unrated vulnerabilities', () => {
      component.rule = 'vulnerability';
      for (const bad of ['0', '10.5', '7.25', 'high']) {
        component.cvssMinStr = bad;
        expect(component.saveBlocker()).toBe('Enter a CVSS score from 0.1 to 10, with at most one decimal.');
      }
      component.cvssMinStr = '6.1';
      expect(component.buildConditions()).toEqual({ cvssMin: 6.1 });
      component.cvssUnknown = 'match';
      expect(component.buildConditions()).toEqual({ cvssMin: 6.1, cvssUnknown: 'match' });
      expect(component.summary.notes).toEqual([{ label: 'Vulnerabilities without CVSS', value: 'blocked' }]);
      component.mode = 'monitor';
      expect(component.summary.notes).toEqual([{ label: 'Vulnerabilities without CVSS', value: 'flagged' }]);
      expect(component.blockLabel).toBe('Flag');
    });

    it('adds and removes blocked licenses', () => {
      component.rule = 'license';
      component.licenseMode = 'deny';
      component.addLicense({ spdxId: 'MIT', name: 'MIT License', category: 'permissive' });
      component.addLicense({ spdxId: 'GPL-3.0', name: 'GPL', category: 'copyleft' });
      component.removeLicense('MIT');
      expect(component.buildConditions()).toEqual({ licenseDenyList: ['GPL-3.0'] });
    });

    it('defaults a new license policy to allowing only the listed licenses', () => {
      component.name = 'Approved licenses';
      component.rule = 'license';
      component.decision = 'BLOCK';
      component.addLicense({ spdxId: 'MIT', name: 'MIT License', category: 'permissive' });
      component.addLicense({ spdxId: 'Apache-2.0', name: 'Apache License 2.0', category: 'permissive' });
      expect(component.licenseMode).toBe('allow');
      expect(component.buildConditions()).toEqual({ licenseAllowList: ['MIT', 'Apache-2.0'] });
      expect(component.summary).toEqual({
        lead: 'Versions whose license is not:',
        items: ['MIT or Apache-2.0'],
        notes: [{ label: 'Packages without a license', value: 'blocked' }],
      });

      component.allowUnknownLicense = true;
      expect(component.buildConditions()).toEqual({ licenseAllowList: ['MIT', 'Apache-2.0'], allowUnknownLicense: true });
      expect(component.summary.notes).toEqual([{ label: 'Packages without a license', value: 'allowed' }]);
    });

    it('names the license options with the Block action', () => {
      component.rule = 'license';
      component.decision = 'BLOCK';
      fixture.detectChanges();
      const text = () => fixture.nativeElement.querySelector('[data-testid="license-mode-allow"]').textContent as string;
      expect(text()).toContain('Block every license except the approved ones');
      expect(fixture.nativeElement.querySelector('[data-testid="license-mode-deny"]').textContent).toContain(
        'Block only the listed licenses'
      );
    });

    it('adds a typed license ID the OSI list does not offer', () => {
      component.rule = 'license';
      component.licenseMode = 'deny';
      component.licenseSearchQuery = 'SSPL-1.0';
      expect(component.customLicense()).toBe('SSPL-1.0');
      component.addTypedLicense();
      expect(component.selectedLicenses).toEqual(['SSPL-1.0']);
      component.licenseSearchQuery = 'sspl-1.0';
      expect(component.customLicense()).toBeNull();
    });

    it('sends only the chosen rule even when other fields were filled in', () => {
      component.rule = 'license';
      component.licenseMode = 'deny';
      component.selectedLicenses = ['GPL-3.0'];
      component.cvssMinStr = '7';
      component.packageBlockListStr = 'lodash';
      expect(component.buildConditions()).toEqual({ licenseDenyList: ['GPL-3.0'] });
    });
  });

  it('shows the summary beside the form and saves without a review step', () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    policyService.create.mockReturnValue(of({} as Policy));
    const summary = () => fixture.nativeElement.querySelector('[data-testid="policy-summary"]') as HTMLElement | null;
    const title = () => fixture.nativeElement.querySelector('[data-testid="policy-summary-title"]') as HTMLElement | null;
    fixture.detectChanges();
    expect(summary()).toBeNull();
    component.name = 'New Policy';
    component.rule = 'packages';
    component.packageBlockListStr = 'test-pkg';
    fixture.detectChanges();
    expect(title()?.textContent).toBe('Block');
    expect(summary()?.textContent).toContain('Every version of:');
    expect(summary()?.querySelector('li')?.textContent).toBe('test-pkg');

    (fixture.nativeElement.querySelector('[data-testid="policy-save"]') as HTMLButtonElement).click();
    expect(policyService.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Policy' }));
    expect(navigate).toHaveBeenCalledWith('/policies');
  });

  it('asks before leaving with unsaved changes, and not after saving', async () => {
    expect(component.canLeave()).toBe(true);
    component.name = 'Half done';
    expect(component.dirty).toBe(true);
    confirm.confirm.mockResolvedValue(false);
    expect(await component.canLeave()).toBe(false);
    expect(confirm.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Discard changes?' }));

    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    policyService.create.mockReturnValue(of({} as Policy));
    component.rule = 'packages';
    component.packageBlockListStr = 'x';
    component.save();
    expect(component.dirty).toBe(false);
    expect(component.canLeave()).toBe(true);
  });

  it('returns only to a path inside the app', () => {
    expect(safeReturnUrl('/monitoring/p1?reason=x')).toBe('/monitoring/p1?reason=x');
    expect(safeReturnUrl('https://evil.test')).toBe('/policies');
    expect(safeReturnUrl('//evil.test')).toBe('/policies');
    expect(safeReturnUrl('/\\evil.test')).toBe('/policies');
    expect(safeReturnUrl(null)).toBe('/policies');
  });

  it('updates an edited policy', () => {
    policyService.update.mockReturnValue(of({} as Policy));
    component.editing = true;
    component.id = 'p1';
    component.name = 'Updated Policy';
    component.rule = 'packages';
    component.packageBlockListStr = 'updated-pkg';
    component.save();

    expect(policyService.update).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ name: 'Updated Policy', conditions: { packageBlockList: ['updated-pkg'] } })
    );
  });

  it('does not save an unfinished rule', () => {
    component.name = 'Bad Policy';
    component.rule = 'releaseType';
    component.save();

    expect(toastService.error).not.toHaveBeenCalled();
    expect(policyService.create).not.toHaveBeenCalled();
  });

  it('shows the summary as soon as the rule matches something, before the form can be saved', () => {
    component.selectRule('packages');
    component.packageDraft = 'left-pad';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="policy-summary"]')?.textContent).toContain('left-pad');
    component.name = '';
    component.decision = 'BLOCK';
    component.packageNames = [];
    component.packageDraft = '';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="policy-summary"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="policy-save-blocker"]')?.textContent).toBe('Enter a name.');
  });

  it('collapses the rule cards to the chosen one, with Change to pick again', () => {
    const el = () => fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    expect(el().querySelectorAll('.rule-grid .rule-option').length).toBe(7);
    (el().querySelector('[data-testid="policy-rule-license"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(component.rule).toBe('license');
    expect(el().querySelector('.rule-grid')).toBeNull();
    expect(el().querySelector('[data-testid="policy-rule-chosen"]')?.textContent).toContain('License');
    (el().querySelector('[data-testid="policy-rule-change"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelectorAll('.rule-grid .rule-option').length).toBe(7);
    // Clicking the chosen card again keeps it and folds the grid.
    (el().querySelector('[data-testid="policy-rule-license"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(component.rule).toBe('license');
    expect(el().querySelector('.rule-grid')).toBeNull();
  });

  it('suggests a name until the user types one', () => {
    component.selectRule('packages');
    component.packageBlockListStr = 'lodash';
    component.ecosystem = 'npm';
    fixture.detectChanges();
    expect(component.name).toBe('Block lodash (npm)');
    component.packageBlockListStr = 'lodash, left-pad';
    fixture.detectChanges();
    expect(component.name).toBe('Block lodash, left-pad (npm)');
    component.name = 'My own name';
    component.packageBlockListStr = 'react';
    fixture.detectChanges();
    expect(component.name).toBe('My own name');
  });

  it('suggests a name for each rule, kept short', () => {
    component.ecosystem = 'maven';
    component.selectRule('releaseType');
    component.toggleReleaseType('prerelease');
    expect(component.nameSuggestion).toBe('Block pre-release versions (Maven)');
    component.ecosystem = '';
    component.selectRule('vulnerability');
    component.cvssMinStr = '7';
    expect(component.nameSuggestion).toBe('Vulnerability: CVSS ≥ 7.0');
    component.cveBlockListStr = Array.from({ length: 12 }, (_, i) => `CVE-2024-100${i}`).join(', ');
    expect(component.nameSuggestion.length).toBeLessThanOrEqual(80);
    expect(component.nameSuggestion.endsWith('…')).toBe(true);
  });

  describe('Next: the step that still stops the save', () => {
    const next = () => fixture.nativeElement.querySelector('[data-testid="policy-save-blocker"]') as HTMLButtonElement | null;
    const tick = () => new Promise((resolve) => setTimeout(resolve));

    it('takes the user to the field and highlights it', async () => {
      fixture.detectChanges();
      next()!.click();
      await tick();
      const name = fixture.nativeElement.querySelector('#policy-name') as HTMLInputElement;
      expect(document.activeElement).toBe(name);
      expect(name.classList.contains('dg-attention')).toBe(true);
    });

    it('points at the chip box for a missing package name', async () => {
      component.name = 'qa';
      component.selectRule('packages');
      fixture.detectChanges();
      expect(next()!.textContent).toBe('Add at least one package name.');
      next()!.click();
      await tick();
      expect(document.activeElement?.id).toBe('policy-packages');
      expect(fixture.nativeElement.querySelector('[data-testid="policy-packages"]').classList.contains('dg-attention')).toBe(true);
    });

    it('opens Advanced for a Project health check that needs a minimum', async () => {
      component.name = 'qa';
      component.ecosystem = 'npm';
      component.selectRule('scorecard');
      component.scorecardChecks = [{ name: 'Maintained', minStr: '' }];
      fixture.detectChanges();
      expect(component.scorecardAdvancedOpen).toBe(false);
      next()!.click();
      expect(component.scorecardAdvancedOpen).toBe(true);
    });
  });

  it('switches the policy on and off from the summary panel', () => {
    fixture.detectChanges();
    const toggle = fixture.nativeElement.querySelector('[data-testid="policy-enabled"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    toggle.click();
    fixture.detectChanges();
    expect(component.isEnabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  describe('Namespace protection rule', () => {
    function chooseNamespace(ecosystem = 'npm') {
      component.name = 'acme-npm-namespace';
      component.ecosystem = ecosystem;
      component.selectRule('namespace');
      fixture.detectChanges();
    }

    it('offers Block only', () => {
      component.decision = 'ALLOW';
      chooseNamespace();
      expect(component.decisionOptions).toEqual(['BLOCK']);
      expect(component.decision).toBe('BLOCK');
    });

    it('needs exactly one ecosystem and at least one package name', () => {
      chooseNamespace('');
      component.reservedNamespaces = ['@acme'];
      expect(component.saveBlocker()).toBe('Select one ecosystem for a Namespace protection policy.');
      component.ecosystem = 'npm';
      component.reservedNamespaces = [];
      expect(component.saveBlocker()).toBe('Add at least one package name.');
      component.reservedNamespaces = ['@acme'];
      component.namespaceErrors = ['@acme-*: a scope is reserved whole'];
      expect(component.saveBlocker()).toBe('@acme-*: a scope is reserved whole');
      component.namespaceErrors = [];
      expect(component.canSave()).toBe(true);
    });

    it('builds the conditions and the review sentence', () => {
      chooseNamespace();
      component.reservedNamespaces = ['@acme', 'acme-*'];
      component.publicPackages = ['@acme/eslint-config'];
      component.namespaceInternalKeys = ['acme-artifactory'];
      expect(component.buildConditions()).toEqual({
        ecosystem: ['npm'],
        reservedNamespaces: ['@acme', 'acme-*'],
        publicPackages: ['@acme/eslint-config'],
      });
      expect(component.summary).toEqual({
        lead: 'Packages named:',
        items: ['@acme', 'acme-*'],
        notes: [
          { label: 'Served only from', value: 'internal remotes (acme-artifactory)' },
          { label: 'Other remotes', value: 'blocked' },
          { label: 'From any remote', value: '@acme/eslint-config' },
        ],
        text: '',
      });
      component.allowedRemotes = ['r-github'];
      component.namespaceInternalKeys = ['github-npm'];
      expect(component.summary.notes[0]).toEqual({ label: 'Served only from', value: 'github-npm' });
      component.allowedRemotes = [];
      component.namespaceInternalKeys = [];
      expect(component.summary.text).toBe('There is no internal remote yet, so every one of these names is blocked.');
      component.mode = 'monitor';
      expect(component.summary.text).toBe('');
      expect(component.summary.notes[1]).toEqual({ label: 'Other remotes', value: 'flagged' });
    });

    it('says to monitor first for the names it covers, not every package', () => {
      chooseNamespace();
      component.reservedNamespaces = ['@acme'];
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="policy-mode-hint"]').textContent.trim()).toBe(
        'Monitor first to see which downloads would be blocked.'
      );
      expect(component.nameSuggestion).toBe('Namespace protection: @acme (npm)');
    });

    it('loads a saved namespace policy into the form', () => {
      fixture = TestBed.createComponent(PolicyFormComponent);
      const form = fixture.componentInstance;
      form['load']({
        id: 'p1',
        name: 'ns',
        description: null,
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], reservedNamespaces: ['acme-*'], publicPackages: ['acme-docs'] },
        priority: 1,
        isEnabled: true,
        createdAt: '',
        updatedAt: '',
      } as Policy);
      expect(form.rule).toBe('namespace');
      expect(form.ecosystem).toBe('pypi');
      expect(form.reservedNamespaces).toEqual(['acme-*']);
      expect(form.publicPackages).toEqual(['acme-docs']);
    });

    it('recommends monitor mode first for a new namespace policy', () => {
      chooseNamespace();
      expect(component.recommendMonitor).toBe(true);
    });
  });

  describe('Vulnerability rule with EPSS', () => {
    function chooseVulnerability(): void {
      component.name = 'Likely exploits';
      component.ecosystem = 'npm';
      component.selectRule('vulnerability');
      component.cvssMinStr = '7';
    }

    it('adds a score threshold in percent, stores a fraction, and switches a new policy to monitor', () => {
      chooseVulnerability();
      expect(component.mode).toBe('enforce');
      component.toggleEpss(true);
      expect(component.mode).toBe('monitor');
      expect(component.autoMonitorNote).toBe(true);
      expect(component.buildConditions()).toEqual({ ecosystem: ['npm'], cvssMin: 7, epssMin: 0.1 });
      component.cveBlockListStr = 'CVE-2024-1234';
      expect(component.summaryTitle).toBe('Monitor only — would block');
      expect(component.summary).toEqual({
        lead: 'Versions with:',
        items: ['CVSS ≥ 7.0 and EPSS ≥ 10 %', 'CVE-2024-1234'],
        notes: [
          { label: 'Vulnerabilities without CVSS', value: 'ignored' },
          { label: 'Vulnerabilities without EPSS', value: 'flagged' },
        ],
      });
      component.setMode('enforce');
      expect(component.autoMonitorNote).toBe(false);
    });

    it('says under Enforcement when it switched to monitor, until the user picks a mode', () => {
      chooseVulnerability();
      component.toggleEpss(true);
      fixture.detectChanges();
      const note = () => fixture.nativeElement.querySelector('[data-testid="policy-mode-auto"]') as HTMLElement | null;
      expect(note()?.textContent).toContain('Switched to Monitor only');
      component.setMode('monitor');
      fixture.detectChanges();
      expect(note()).toBeNull();
    });

    it('offers a percentile threshold and "ignore" for unscored vulnerabilities, without a CVSS score', () => {
      chooseVulnerability();
      component.cvssMinStr = '';
      component.toggleEpss(true);
      component.mode = 'enforce';
      component.epssMode = 'percentile';
      component.epssPercentileStr = '95';
      component.epssUnknown = 'ignore';
      expect(component.buildConditions()).toEqual({ ecosystem: ['npm'], epssPercentileMin: 0.95, epssUnknown: 'ignore' });
      expect(component.summary).toEqual({
        lead: 'Versions with:',
        items: ['EPSS percentile ≥ 95th'],
        notes: [{ label: 'Vulnerabilities without EPSS', value: 'ignored' }],
      });
      expect(component.canSave()).toBe(true);
    });

    it('needs a threshold above 0 and at most 100', () => {
      chooseVulnerability();
      component.toggleEpss(true);
      component.epssScoreStr = '0';
      expect(component.saveBlocker()).toBe('Enter an EPSS score above 0 and at most 100 %.');
      component.epssScoreStr = '0.5';
      expect(component.buildConditions().epssMin).toBe(0.005);
    });

    it('restores an EPSS policy and keeps its mode', async () => {
      TestBed.resetTestingModule();
      const edit = await openForEdit({ ...policyWith({ cvssMin: 9, epssPercentileMin: 0.9, epssUnknown: 'ignore' }), mode: 'enforce' });
      expect(edit.cvssMinStr).toBe('9.0');
      expect(edit.cvssUnknown).toBe('ignore');
      expect(edit.epssEnabled).toBe(true);
      expect(edit.epssMode).toBe('percentile');
      expect(edit.epssPercentileStr).toBe('90');
      expect(edit.epssUnknown).toBe('ignore');
      expect(edit.mode).toBe('enforce');
      expect(edit.dirty).toBe(false);
    });
  });

  describe('Project health (Scorecard) rule', () => {
    function chooseScorecard(): void {
      component.name = 'Healthy projects';
      component.ecosystem = 'npm';
      component.selectRule('scorecard');
    }

    it('starts a new policy in monitor mode with an overall minimum of 5 and both options letting packages through', () => {
      chooseScorecard();
      expect(component.mode).toBe('monitor');
      expect(component.decisionOptions).toEqual(['BLOCK']);
      expect(component.canSave()).toBe(true);
      expect(component.buildConditions()).toEqual({ ecosystem: ['npm'], scorecardMinScore: 5 });
      expect(component.summary).toEqual({
        lead: 'Packages with:',
        items: ['OpenSSF Scorecard below 5.0'],
        notes: [
          { label: 'Packages without a Scorecard', value: 'allowed' },
          { label: 'Scorecard unreachable', value: 'allowed' },
        ],
      });
    });

    it('adds individual checks under Advanced and blocks on unknown or unreachable when asked', () => {
      chooseScorecard();
      component.mode = 'enforce';
      component.addScorecardCheck();
      expect(component.scorecardChecks).toEqual([{ name: 'Dangerous-Workflow', minStr: '10' }]);
      expect(component.scorecardAdvancedOpen).toBe(true);
      component.scorecardUnknown = 'block';
      component.scorecardUnavailable = 'block';
      expect(component.buildConditions()).toEqual({
        ecosystem: ['npm'],
        scorecardMinScore: 5,
        scorecardChecks: [{ name: 'Dangerous-Workflow', minScore: 10 }],
        scorecardUnknown: 'block',
        scorecardUnavailable: 'block',
      });
      expect(component.summary).toEqual({
        lead: 'Packages with:',
        items: ['OpenSSF Scorecard below 5.0', 'Dangerous-Workflow check below 10'],
        notes: [
          { label: 'Packages without a Scorecard', value: 'blocked' },
          { label: 'Scorecard unreachable', value: 'blocked' },
        ],
      });
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-testid="scorecard-unavailable-warning"]')?.textContent).toContain(
        'every package this policy covers is blocked'
      );
    });

    it('validates scores, duplicates, and needs an overall minimum or a check', () => {
      chooseScorecard();
      component.scorecardMinScoreStr = '11';
      expect(component.saveBlocker()).toBe('The overall score must be a number from 0 to 10.');
      component.scorecardMinScoreStr = '';
      expect(component.saveBlocker()).toBe('Set an overall score or add a check.');
      component.scorecardChecks = [{ name: 'Maintained', minStr: '' }];
      expect(component.saveBlocker()).toBe('Each check needs a minimum from 0 to 10.');
      component.scorecardChecks = [{ name: 'Maintained', minStr: '1' }, { name: 'Maintained', minStr: '2' }];
      expect(component.saveBlocker()).toBe('List each check once.');
      component.removeScorecardCheck(1);
      expect(component.saveBlocker()).toBe('');
      expect(component.buildConditions()).toEqual({ ecosystem: ['npm'], scorecardChecks: [{ name: 'Maintained', minScore: 1 }] });
    });

    it('warns when every selected repository has an internal remote', () => {
      const repositories = TestBed.inject(RepositoryService) as unknown as { list: ReturnType<typeof vi.fn> };
      repositories.list.mockReturnValue(
        of([
          { id: 'r-int', ecosystem: 'npm', key: 'corp', type: 'remote', source: 'internal', upstreamUrl: 'https://nexus.corp/npm', memberKeys: [] },
          { id: 'r-pub', ecosystem: 'npm', key: 'npmjs', type: 'remote', source: 'public', upstreamUrl: 'https://registry.npmjs.org', memberKeys: [] },
          { id: 'r-mix', ecosystem: 'npm', key: 'team', type: 'virtual', source: null, upstreamUrl: null, memberKeys: ['corp', 'npmjs'] },
        ])
      );
      chooseScorecard();
      component.repositoryIds = ['r-int', 'r-mix'];
      expect(component.scorecardScopeWarning).toContain('None of the selected repositories is public');
      component.repositoryIds = ['r-int', 'r-pub'];
      expect(component.scorecardScopeWarning).toBe('');
    });
  });

});

async function openForEdit(policy: Policy, extra: Record<string, unknown> = {}): Promise<PolicyFormComponent> {
  await TestBed.configureTestingModule({
    imports: [PolicyFormComponent],
    providers: [
      { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
      { provide: PolicyService, useValue: { create: vi.fn(), update: vi.fn(), get: vi.fn().mockReturnValue(of(policy)) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      {
        provide: LicenseService,
        useValue: { loadLicenses: vi.fn().mockResolvedValue([]), searchLicenses: vi.fn().mockResolvedValue([]) },
      },
      { provide: ExceptionService, useValue: { list: vi.fn().mockReturnValue(of({ items: [], total: 0, active: 0, expired: 0 })), delete: vi.fn() } },
      provideRouter([{ path: '**', children: [] }]),
      routeStub(policy.id, extra['suggestion'] ? { suggest: (extra['suggestion'] as { reasonKey: string }).reasonKey } : {}),
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PolicyFormComponent);
  fixture.detectChanges();
  return fixture.componentInstance;
}

function policyWith(conditions: Policy['conditions']): Policy {
  return {
    id: 'p1',
    name: 'Test Policy',
    description: 'Desc',
    decision: 'BLOCK',
    conditions,
    priority: 10,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  };
}

describe('PolicyFormComponent — editing mode', () => {
  it('loads the policy from the route; a suggestion from Monitoring counts as an unsaved change', async () => {
    const plain = await openForEdit(policyWith({ licenseAllowList: ['MIT'] }));
    expect(plain.editing).toBe(true);
    expect(TestBed.inject(PolicyService).get).toHaveBeenCalledWith('p1');
    expect(plain.dirty).toBe(false);
    TestBed.resetTestingModule();
    const suggested = await openForEdit(policyWith({ licenseAllowList: ['MIT'] }), { suggestion: { reasonKey: 'GPL-3.0' } });
    expect(suggested.dirty).toBe(true);
  });

  it('says the policy was not found when it cannot be loaded', async () => {
    await TestBed.configureTestingModule({
      imports: [PolicyFormComponent],
      providers: [
        { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        { provide: PolicyService, useValue: { get: vi.fn().mockReturnValue(throwError(() => ({ error: { error: 'Policy not found' } }))) } },
        { provide: LicenseService, useValue: { loadLicenses: vi.fn().mockResolvedValue([]) } },
        provideRouter([{ path: '**', children: [] }]),
        routeStub('gone'),
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PolicyFormComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.loadError).toBe('Policy not found');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Policy not found');
    expect(fixture.componentInstance.canLeave()).toBe(true);
  });

  it('restores a packages rule with named versions', async () => {
    const edit = await openForEdit(
      policyWith({ ecosystem: ['maven'], packageBlockList: ['bad-pkg'], versionRange: '=1.0-SNAPSHOT || 1.0.0 - 2.0.0 || >=3.0.0' })
    );
    expect(edit.rule).toBe('packages');
    expect(edit.ecosystem).toBe('maven');
    expect(edit.packageBlockListStr).toBe('bad-pkg');
    expect(edit.versionConstraints).toEqual([
      { kind: 'exact', version: '1.0-SNAPSHOT', from: '', to: '' },
      { kind: 'range', version: '', from: '1.0.0', to: '2.0.0' },
      { kind: 'range', version: '', from: '3.0.0', to: '' },
    ]);
    expect(edit.legacyRules).toEqual(['packages']);
  });

  it('restores a release type rule', async () => {
    const edit = await openForEdit(policyWith({ ecosystem: ['go'], releaseTypes: ['pseudo', 'prerelease'] }));
    expect(edit.rule).toBe('releaseType');
    expect(edit.selectedReleaseTypes).toEqual(['pseudo', 'prerelease']);
    expect(edit.buildConditions()).toEqual({ ecosystem: ['go'], releaseTypes: ['prerelease', 'pseudo'] });
  });

  it('refuses to save an older Allow policy on a rule that no longer offers Allow', async () => {
    const edit = await openForEdit({ ...policyWith({ releaseTypes: ['prerelease'] }), decision: 'ALLOW' });
    expect(edit.decision).toBe('ALLOW');
    expect(edit.decisionAllowed).toBe(false);
    expect(edit.canSave()).toBe(false);
    edit.decision = 'BLOCK';
    expect(edit.canSave()).toBe(true);
  });

  it('restores an allow-only license policy', async () => {
    const allow = await openForEdit(policyWith({ licenseAllowList: ['MIT', 'ISC'], allowUnknownLicense: true }));
    expect(allow.rule).toBe('license');
    expect(allow.licenseMode).toBe('allow');
    expect(allow.selectedLicenses).toEqual(['MIT', 'ISC']);
    expect(allow.allowUnknownLicense).toBe(true);
  });

  it('restores a block-list license policy', async () => {
    const deny = await openForEdit(policyWith({ licenseDenyList: ['AGPL-3.0'] }));
    expect(deny.licenseMode).toBe('deny');
    expect(deny.selectedLicenses).toEqual(['AGPL-3.0']);
  });

  it('restores a release age with both options', async () => {
    const edit = await openForEdit(policyWith({ releaseAgeMaxHours: 24, releaseAgeMinDays: 365 }));
    expect(edit.rule).toBe('releaseAge');
    expect(edit.tooNewEnabled).toBe(true);
    expect(edit.tooNewHoursStr).toBe('24');
    expect(edit.unmaintainedEnabled).toBe(true);
    expect(edit.unmaintainedDaysStr).toBe('365');
  });

  it('restores an unmaintained-only release age', async () => {
    const edit = await openForEdit(policyWith({ releaseAgeMinDays: 365 }));
    expect(edit.tooNewEnabled).toBe(false);
    expect(edit.unmaintainedEnabled).toBe(true);
  });

  it('flags a policy saved with several rules and keeps only the selected one', async () => {
    const edit = await openForEdit(
      policyWith({ packageBlockList: ['bad-pkg'], licenseDenyList: ['GPL-3.0'], cvssMin: 7 })
    );
    expect(edit.legacyRules).toEqual(['packages', 'vulnerability', 'license']);
    expect(edit.rule).toBe('packages');
    expect(edit.legacyRuleNames).toBe('packages, vulnerability, license');
    edit.rule = 'license';
    expect(edit.buildConditions()).toEqual({ licenseDenyList: ['GPL-3.0'] });
  });
});

describe('PolicyFormComponent — monitor mode', () => {
  async function openNew(data: Record<string, unknown> | undefined) {
    const policyService = { create: vi.fn().mockReturnValue(of({} as Policy)), update: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [PolicyFormComponent],
      providers: [
        { provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        { provide: PolicyService, useValue: policyService },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        {
          provide: LicenseService,
          useValue: { loadLicenses: vi.fn().mockResolvedValue([]), searchLicenses: vi.fn().mockResolvedValue([]) },
        },
        { provide: ExceptionService, useValue: { list: vi.fn().mockReturnValue(of({ items: [], total: 0, active: 0, expired: 0 })), delete: vi.fn() } },
        provideRouter([{ path: '**', children: [] }]),
        routeStub(null, (data?.['mode'] as string | undefined) ? { mode: data!['mode'] as string } : {}),
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(PolicyFormComponent);
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, policyService };
  }

  it('offers Enforce / Monitor only for Block policies, defaulting to Enforce', async () => {
    const { fixture, component } = await openNew(undefined);
    component.name = 'Licenses';
    component.selectRule('license');
    fixture.detectChanges();
    expect(component.mode).toBe('enforce');
    expect(fixture.nativeElement.querySelector('[data-testid="policy-mode"]')).not.toBeNull();
    // An ecosystem-wide rule recommends monitoring first.
    expect(fixture.nativeElement.querySelector('[data-testid="policy-mode-hint"]')).not.toBeNull();

    component.selectRule('packages');
    component.decision = 'ALLOW';
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="policy-mode"]')).toBeNull();
  });

  it('says "Would block" and saves mode monitor', async () => {
    const { component, policyService } = await openNew(undefined);
    component.name = 'Licenses';
    component.selectRule('license');
    component.selectedLicenses = ['MIT'];
    component.mode = 'monitor';
    expect(component.summaryTitle).toBe('Monitor only — would block');
    expect(component.bannerClass).toBe('dg-banner-pending');
    component.save();
    expect(policyService.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'monitor' }));
  });

  it('an Allow policy is always saved as enforce', async () => {
    const { component, policyService } = await openNew(undefined);
    component.name = 'Trusted';
    component.selectRule('packages');
    component.packageBlockListStr = 'lodash';
    component.mode = 'monitor';
    component.decision = 'ALLOW';
    component.save();
    expect(policyService.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'enforce' }));
  });

  it('New policy from the Monitoring page starts in monitor mode', async () => {
    const { component } = await openNew({ editing: false, mode: 'monitor' });
    expect(component.mode).toBe('monitor');
  });

  it('restores mode and lists the policy approvals when editing', async () => {
    const edit = await openForEdit({ ...policyWith({ licenseAllowList: ['MIT'] }), mode: 'monitor' });
    expect(edit.mode).toBe('monitor');
    expect(TestBed.inject(ExceptionService).list).toHaveBeenCalledWith(expect.objectContaining({ appliesTo: 'p1' }));
  });
});

describe('PolicyFormComponent — Edit rule suggestions', () => {
  it('License allow-only: approves the license of the group', async () => {
    const edit = await openForEdit(policyWith({ licenseAllowList: ['MIT'] }), { suggestion: { reasonKey: 'GPL-3.0' } });
    expect(edit.selectedLicenses).toEqual(['MIT', 'GPL-3.0']);
    expect(edit.suggestionNote).toBe('Approve GPL-3.0');
  });

  it('License allow-only: unknown licenses are let through', async () => {
    const edit = await openForEdit(policyWith({ licenseAllowList: ['MIT'] }), { suggestion: { reasonKey: 'UNKNOWN' } });
    expect(edit.allowUnknownLicense).toBe(true);
  });

  it('License block list: unbans the license', async () => {
    const edit = await openForEdit(policyWith({ licenseDenyList: ['GPL-3.0', 'AGPL-3.0'] }), { suggestion: { reasonKey: 'GPL-3.0' } });
    expect(edit.selectedLicenses).toEqual(['AGPL-3.0']);
  });

  it('Vulnerability: removes the CVE', async () => {
    const cve = await openForEdit(policyWith({ cveBlockList: ['CVE-1', 'CVE-2'] }), { suggestion: { reasonKey: 'cve:CVE-1' } });
    expect(cve.cveList).toEqual(['CVE-2']);
  });

  it('Vulnerability: raises the CVSS minimum to the next rating', async () => {
    const cvss = await openForEdit(policyWith({ cvssMin: 7 }), { suggestion: { reasonKey: 'cvss:CVE-2024-1' } });
    expect(cvss.cvssMinStr).toBe('9.0');
    expect(cvss.suggestionNote).toBe('Raise the CVSS minimum to 9.0');
  });

  it('Vulnerability: raises the CVSS minimum for a group recorded as severity', async () => {
    const legacy = await openForEdit(policyWith({ cvssMin: 5.5 }), { suggestion: { reasonKey: 'severity:MEDIUM' } });
    expect(legacy.cvssMinStr).toBe('7.0');
  });

  it('Vulnerability: ignores unrated vulnerabilities', async () => {
    const unrated = await openForEdit(policyWith({ cvssMin: 7, cvssUnknown: 'match' }), { suggestion: { reasonKey: 'cvss:unknown' } });
    expect(unrated.cvssUnknown).toBe('ignore');
  });

  it('Release type: unticks the type', async () => {
    const type = await openForEdit(policyWith({ releaseTypes: ['prerelease', 'dev'] }), { suggestion: { reasonKey: 'dev' } });
    expect(type.selectedReleaseTypes).toEqual(['prerelease']);
  });

  it('Release age: shortens the "too new" window', async () => {
    const age = await openForEdit(policyWith({ releaseAgeMaxHours: 72 }), { suggestion: { reasonKey: 'too_new' } });
    expect(age.tooNewHoursStr).toBe('36');
  });

  it('Project health: lowers the overall minimum, or drops the failing check', async () => {
    const overall = await openForEdit(policyWith({ scorecardMinScore: 5 }), { suggestion: { reasonKey: 'scorecard:overall' } });
    expect(overall.scorecardMinScoreStr).toBe('4');
    expect(overall.suggestionNote).toBe('Lower the overall minimum to 4');
    TestBed.resetTestingModule();
    const check = await openForEdit(
      policyWith({ scorecardMinScore: 5, scorecardChecks: [{ name: 'Fuzzing', minScore: 1 }] }),
      { suggestion: { reasonKey: 'scorecard:Fuzzing' } }
    );
    expect(check.scorecardChecks).toEqual([]);
  });

  it('Project health: an edited policy keeps its mode and restores every field', async () => {
    const edit = await openForEdit({
      ...policyWith({ ecosystem: ['pypi'], scorecardMinScore: 4.5, scorecardChecks: [{ name: 'Maintained', minScore: 1 }], scorecardUnavailable: 'block' }),
      mode: 'enforce',
    });
    expect(edit.rule).toBe('scorecard');
    expect(edit.mode).toBe('enforce');
    expect(edit.scorecardMinScoreStr).toBe('4.5');
    expect(edit.scorecardChecks).toEqual([{ name: 'Maintained', minStr: '1' }]);
    expect(edit.scorecardAdvancedOpen).toBe(true);
    expect(edit.scorecardUnknown).toBe('allow');
    expect(edit.scorecardUnavailable).toBe('block');
    expect(edit.dirty).toBe(false);
  });
});

describe('PolicyFormComponent — repository scope', () => {
  const SCOPED: Partial<Policy> = {
    repositoryIds: ['repo-prod'],
    repositories: [{ id: 'repo-prod', ecosystem: 'npm', key: 'prod', type: 'remote' }],
  };

  function blockLodash(extra: Partial<Policy> = {}): Policy {
    return {
      ...policyWith({ ecosystem: ['npm'], packageBlockList: ['lodash'] }),
      decision: 'BLOCK',
      ...extra,
    } as Policy;
  }

  it('loads the scope and lists it under the summary, not in it', async () => {
    const component = await openForEdit(blockLodash(SCOPED));
    expect(component.repositoryIds).toEqual(['repo-prod']);
    expect(component.scopeMode).toBe('selected');
    expect(component.scopeLabels).toEqual(['npm/prod']);
    expect(component.summary).toEqual({ lead: 'Every version of:', items: ['lodash'], notes: [] });
  });

  it('keeps the name of an edited policy and starts with its rule collapsed', async () => {
    const component = await openForEdit(blockLodash());
    expect(component.name).toBe('Test Policy');
    expect(component.ruleGridOpen).toBe(false);
  });

  it('cannot save Selected repositories with none chosen', async () => {
    const component = await openForEdit(blockLodash(SCOPED));
    component.repositoryIds = [];
    expect(component.saveBlocker()).toBe('Select at least one repository, or All repositories.');
    component.scopeMode = 'all';
    expect(component.saveBlocker()).toBe('');
  });

  it('asks to choose again when a scoped repository was deleted', async () => {
    const component = await openForEdit(blockLodash({ repositoryIds: ['gone'], repositories: [] }));
    expect(component.missingRepositoryCount).toBe(1);
    expect(component.scopeMode).toBe('selected');
    expect(component.canSave()).toBe(false);
  });

  it('sends the scope when saving', async () => {
    const component = await openForEdit(blockLodash(SCOPED));
    const service = TestBed.inject(PolicyService) as unknown as { update: ReturnType<typeof vi.fn> };
    service.update.mockReturnValue(of({}));
    component.save();
    expect(service.update).toHaveBeenCalledWith('p1', expect.objectContaining({ repositoryIds: ['repo-prod'] }));
  });
});
