import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RepositoryScopeComponent } from './repository-scope.component';
import { RepositoryService } from '../services/repository.service';
import { REPOSITORY_ROWS } from './repository-scope.testing';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('RepositoryScopeComponent', () => {
  let fixture: ComponentFixture<RepositoryScopeComponent>;
  let component: RepositoryScopeComponent;
  let emitted: string[][];

  async function render(inputs: Partial<RepositoryScopeComponent> = {}): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [RepositoryScopeComponent],
      providers: [{ provide: RepositoryService, useValue: { list: vi.fn().mockReturnValue(of(REPOSITORY_ROWS)) } }],
    }).compileComponents();
    fixture = TestBed.createComponent(RepositoryScopeComponent);
    component = fixture.componentInstance;
    Object.assign(component, { idPrefix: 'policy', ...inputs });
    emitted = [];
    component.selectedIdsChange.subscribe((ids) => emitted.push(ids));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;

  it('starts on All repositories and lists nothing until Selected is chosen', async () => {
    const el = await render({ ecosystems: ['npm'] });
    expect(q(el, 'policy-scope-all')!.checked).toBe(true);
    expect(q(el, 'policy-scope-list')).toBeNull();
    q(el, 'policy-scope-selected')!.click();
    fixture.detectChanges();
    expect(q(el, 'policy-scope-list')).not.toBeNull();
    expect(q(el, 'policy-scope-repo-pypi-default')).toBeNull();
    expect(q(el, 'policy-scope-empty')?.textContent).toContain('Select at least one repository');
  });

  it('emits the chosen IDs, groups sources and team entry points, and never offers all', async () => {
    const el = await render({ ecosystems: ['npm'] });
    q(el, 'policy-scope-selected')!.click();
    fixture.detectChanges();
    expect(q(el, 'policy-scope-repo-npm-all')).toBeNull();
    const groups = [...el.querySelectorAll('.scope-group')].map((g) => g.textContent?.trim());
    expect(groups).toEqual(['Sources (remotes)', 'Team entry points (virtual)']);
    q(el, 'policy-scope-repo-npm-prod')!.click();
    fixture.detectChanges();
    expect(emitted.at(-1)).toEqual(['p']);
    expect(el.textContent).not.toContain('not covered');
  });

  it('switching back to All repositories clears the selection', async () => {
    const el = await render({ ecosystems: ['npm'], selectedIds: ['p'] });
    expect(q(el, 'policy-scope-selected')!.checked).toBe(true);
    q(el, 'policy-scope-all')!.click();
    fixture.detectChanges();
    expect(emitted.at(-1)).toEqual([]);
  });

  it('drops repositories outside a changed ecosystem and says so', async () => {
    const el = await render({ ecosystems: [], selectedIds: ['p', 'y'] });
    component.ecosystems = ['npm'];
    component.ngOnChanges({ ecosystems: { firstChange: false } as never });
    fixture.detectChanges();
    expect(emitted.at(-1)).toEqual(['p']);
    expect(q(el, 'policy-scope-dropped')?.textContent).toContain('pypi/default');
  });

  it('preselects the repository a package was checked on', async () => {
    const el = await render({ ecosystems: ['npm'], prefillKey: 'prod' });
    expect(q(el, 'policy-scope-selected')!.checked).toBe(true);
    expect(emitted.at(-1)).toEqual(['p']);
  });

  it('says when a repository it was limited to was deleted', async () => {
    const el = await render({ ecosystems: ['npm'], missingCount: 1 });
    expect(q(el, 'policy-scope-selected')!.checked).toBe(true);
    expect(q(el, 'policy-scope-missing')?.textContent).toContain('was deleted');
  });
});
