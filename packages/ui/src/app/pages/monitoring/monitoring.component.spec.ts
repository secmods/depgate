import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { BehaviorSubject, of } from 'rxjs';
import { vi } from 'vitest';
import { MonitoringComponent, sortPolicies } from './monitoring.component';
import { MonitorPolicy, MonitorService } from '../../services/monitor.service';
import { ToastService } from '../../services/toast.service';
import { MonitorActionsService } from './monitor-actions.service';
import { monitorPolicy } from './monitoring.testing';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('sortPolicies', () => {
  const a = monitorPolicy({ id: 'a', name: 'Beta', willBlock: 1 });
  const b = monitorPolicy({ id: 'b', name: 'alpha', willBlock: 9 });
  it('sorts numbers and names', () => {
    expect(sortPolicies([a, b], 'willBlock', 'desc').map((p) => p.id)).toEqual(['b', 'a']);
    expect(sortPolicies([a, b], 'name', 'asc').map((p) => p.id)).toEqual(['b', 'a']);
  });
});

describe('MonitoringComponent (list)', () => {
  let fixture: ComponentFixture<MonitoringComponent>;
  let component: MonitoringComponent;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;
  let actions: Record<string, ReturnType<typeof vi.fn>>;
  let navigate: ReturnType<typeof vi.spyOn>;

  async function setup(policies: MonitorPolicy[], query: Record<string, string> = {}) {
    const params = new BehaviorSubject(convertToParamMap(query));
    monitor = {
      policies: vi.fn().mockImplementation((status: string) => of({ items: status === 'enforced' ? [] : policies })),
      refreshCount: vi.fn(),
    };
    actions = { enforce: vi.fn().mockResolvedValue(false) };
    await TestBed.configureTestingModule({
      imports: [MonitoringComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: params.asObservable() } },
        { provide: MonitorService, useValue: monitor },
        { provide: MonitorActionsService, useValue: actions },
        { provide: NgbModal, useValue: { open: vi.fn() } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(MonitoringComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('shows an empty state with New policy when nothing is monitoring', async () => {
    await setup([]);
    expect(el().textContent).toContain('No policies are monitoring');
    expect(el().textContent).toContain('New policy');
  });

  it('lists policies in a table, most "Will be blocked" first', async () => {
    await setup([monitorPolicy({ id: 'small', name: 'Small', willBlock: 1 }), monitorPolicy({ id: 'big', name: 'Big', willBlock: 30 })]);
    const rows = [...el().querySelectorAll('[data-testid^="policy-row-"]')].map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['policy-row-big', 'policy-row-small']);
    expect(el().querySelector('[data-testid="policy-row-big"]')!.textContent).toContain('12 days ago');
  });

  it('sorts by a column and filters by search', async () => {
    await setup([monitorPolicy({ id: 'x', name: 'Zeta' }), monitorPolicy({ id: 'y', name: 'Alpha' })]);
    (el().querySelector('[data-testid="sort-name"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.rows.map((p) => p.name)).toEqual(['Alpha', 'Zeta']);
    component.search = 'zet';
    component.applyView();
    expect(component.rows.map((p) => p.name)).toEqual(['Zeta']);
  });

  it('a row opens the details page; Enforce goes through the shared actions', async () => {
    await setup([monitorPolicy()]);
    (el().querySelector('[data-testid="policy-row-p1"]') as HTMLElement).click();
    expect(navigate).toHaveBeenCalledWith(['/monitoring', 'p1']);
    (el().querySelector('[data-testid="enforce-p1"]') as HTMLButtonElement).click();
    expect(actions['enforce']).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });

  it('redirects an old ?policy= link to the details page', async () => {
    await setup([monitorPolicy()], { policy: 'p1' });
    expect(navigate).toHaveBeenCalledWith(['/monitoring', 'p1'], { replaceUrl: true });
  });

  it('?tab=enforced shows the Recently enforced list', async () => {
    await setup([monitorPolicy()], { tab: 'enforced' });
    expect(monitor['policies']).toHaveBeenCalledWith('enforced');
    expect(el().textContent).toContain('Nothing enforced in the last 30 days');
  });
});
