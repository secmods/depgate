import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ToastService } from '../services/toast.service';

const ICONS: Record<string, string> = {
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
  info: 'info',
};

@Component({
  selector: 'app-toast-container',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-toast-stack" aria-live="polite">
      @for (t of toast.toasts; track t.id) {
        <div class="dg-toast" [class]="'dg-toast is-' + t.type" [attr.role]="t.type === 'error' ? 'alert' : 'status'">
          <span class="material-symbols-outlined icon-fill" aria-hidden="true">{{ icons[t.type] }}</span>
          <div class="dg-toast-message">{{ t.message }}</div>
          <button type="button" class="dg-icon-btn" style="width: 24px; height: 24px" (click)="toast.remove(t.id)" aria-label="Dismiss">
            <span class="material-symbols-outlined" style="font-size: 16px">close</span>
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastContainerComponent {
  toast = inject(ToastService);
  icons = ICONS;
}
