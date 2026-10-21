import { Injectable, Injector, inject } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { firstValueFrom } from 'rxjs';
import { MonitorService } from '../../services/monitor.service';
import { PolicyConditions } from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { MODAL_DATA } from '../../tokens';
import { Router } from '@angular/router';
import { EnforceDialogComponent, EnforceDialogData } from './enforce-dialog.component';
import { RuleSuggestion } from './monitoring';

type PolicyRef = { id: string; name: string; conditions: PolicyConditions };

/** Enforce, Restart monitoring and Edit rule, from the Monitoring page and the policy view. */
@Injectable({ providedIn: 'root' })
export class MonitorActionsService {
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private confirm = inject(ConfirmService);
  private monitor = inject(MonitorService);
  private router = inject(Router);
  private toast = inject(ToastService);

  /** Resolves true once the policy is enforced. */
  async enforce(policy: PolicyRef): Promise<boolean> {
    const data: EnforceDialogData = { policyId: policy.id, policyName: policy.name, conditions: policy.conditions };
    const ref = this.modal.open(EnforceDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: data }], parent: this.injector }),
    });
    return ref.result.then((done) => done === true, () => false);
  }

  /** Resolves true once the rows were cleared. */
  async restart(policy: PolicyRef): Promise<boolean> {
    const ok = await this.confirm.confirm({
      title: 'Restart monitoring?',
      message:
        `Every package recorded for "${policy.name}" is cleared and "Monitoring since" becomes today. ` +
        'Approvals are kept.',
      confirmText: 'Restart monitoring',
    });
    if (!ok) return false;
    try {
      const res = await firstValueFrom(this.monitor.restart(policy.id));
      this.toast.success(`Monitoring restarted (${res.cleared.toLocaleString()} rows cleared)`);
      return true;
    } catch (err) {
      this.toast.error((err as { error?: { error?: string } }).error?.error ?? 'Restart failed');
      return false;
    }
  }

  /** Opens the policy form page, with a suggested change for a reason group; Save and Cancel come back here. */
  editRule(policyId: string, suggestion?: RuleSuggestion): void {
    void this.router.navigate(['/policies', policyId, 'edit'], {
      queryParams: { suggest: suggestion?.reasonKey ?? null, returnUrl: this.router.url },
    });
  }
}
