import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { RegistryFormDialogComponent } from './registry-form-dialog.component';
import { UpstreamRegistryService } from '../../services/upstream-registry.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';

type RegistryServiceMock = {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
};

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('RegistryFormDialogComponent', () => {
  let fixture: ComponentFixture<RegistryFormDialogComponent>;
  let component: RegistryFormDialogComponent;
  let registryService: RegistryServiceMock;

  beforeEach(async () => {
    registryService = {
      create: vi.fn().mockReturnValue(of({})),
      update: vi.fn().mockReturnValue(of({ id: 'id-1' })),
      test: vi.fn().mockReturnValue(of({ ok: true, latencyMs: 12 })),
      testConnection: vi.fn().mockReturnValue(of({ ok: true, latencyMs: 14 })),
    };

    await TestBed.configureTestingModule({
      imports: [RegistryFormDialogComponent],
      providers: [
        { provide: UpstreamRegistryService, useValue: registryService },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: NgbActiveModal, useValue: { close: vi.fn(), dismiss: vi.fn() } },
        { provide: MODAL_DATA, useValue: { editing: false } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RegistryFormDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should include nuget in supported ecosystems', () => {
    expect(component.ecosystems).toContain('nuget');
  });

  it('should include cargo in supported ecosystems', () => {
    expect(component.ecosystems).toContain('cargo');
  });

  it('should include composer in supported ecosystems', () => {
    expect(component.ecosystems).toContain('composer');
  });

  it('should include rubygems in supported ecosystems', () => {
    expect(component.ecosystems).toContain('rubygems');
  });
});
