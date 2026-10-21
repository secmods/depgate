import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { WebhookDeliveriesDialogComponent } from './webhook-deliveries-dialog.component';
import { WebhookDelivery, WebhookService, WebhookTarget } from '../../services/webhook.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function delivery(extra: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'd1', eventId: '0190f0aa-1111-7000-8000-000000000001', event: 'package_blocked', status: 'delivered', attempts: 1,
    lastStatusCode: 200, lastError: null, createdAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), nextAttemptAt: null,
    payload: { id: '0190f0aa-1111-7000-8000-000000000001', event: 'package_blocked' }, ...extra,
  };
}

const target = (extra: Partial<WebhookTarget> = {}): WebhookTarget => ({
  id: 'w1', url: 'https://hooks.example.com/x', secretConfigured: false, events: ['package_blocked'], isEnabled: true, createdAt: '', ...extra,
});

describe('WebhookDeliveriesDialogComponent', () => {
  let fixture: ComponentFixture<WebhookDeliveriesDialogComponent>;
  let service: Record<string, ReturnType<typeof vi.fn>>;

  async function setup(webhook: WebhookTarget, items: WebhookDelivery[]) {
    service = {
      deliveries: vi.fn().mockReturnValue(of({ items, total: items.length })),
      redeliver: vi.fn().mockReturnValue(of({ queued: true, deliveryId: 'd2', eventId: items[0]?.eventId })),
    };
    await TestBed.configureTestingModule({
      imports: [WebhookDeliveriesDialogComponent],
      providers: [
        { provide: WebhookService, useValue: service },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: NgbActiveModal, useValue: { close: vi.fn(), dismiss: vi.fn() } },
        { provide: MODAL_DATA, useValue: { webhook } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WebhookDeliveriesDialogComponent);
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;

  it('shows each delivery with its status, the retry time and the error', async () => {
    await setup(target(), [
      delivery(),
      delivery({ id: 'd2', status: 'pending', attempts: 2, lastError: 'HTTP 503', nextAttemptAt: new Date().toISOString() }),
    ]);
    expect(q('[data-testid="delivery-delivered"]')!.textContent).toContain('Delivered');
    const pending = q('[data-testid="delivery-pending"]')!.textContent!;
    expect(pending).toContain('Retrying');
    expect(pending).toContain('HTTP 503');
    expect(pending).toContain('Next try');
  });

  it('filters by status and redelivers with the same event', async () => {
    await setup(target(), [delivery({ status: 'failed', lastError: 'HTTP 404' })]);
    fixture.componentInstance.status = 'failed';
    fixture.componentInstance.load();
    expect(service['deliveries']).toHaveBeenLastCalledWith('w1', { status: 'failed', limit: 100 });
    fixture.detectChanges();
    (q('[data-testid="delivery-redeliver"]') as HTMLButtonElement).click();
    expect(service['redeliver']).toHaveBeenCalledWith('w1', 'd1');
  });

  it('cannot redeliver while the webhook is off', async () => {
    await setup(target({ isEnabled: false }), [delivery()]);
    expect((q('[data-testid="delivery-redeliver"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when nothing was sent yet', async () => {
    await setup(target(), []);
    expect(q('[data-testid="deliveries-empty"]')).not.toBeNull();
  });
});
