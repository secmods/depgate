import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Toast {
  id: number;
  message: string;
  action?: string;
  duration: number;
  type: 'success' | 'error' | 'info' | 'warning';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  toasts: Toast[] = [];
  private nextId = 0;
  private platformId = inject(PLATFORM_ID);

  show(message: string, action = 'Close', duration = 3000, type: 'success' | 'error' | 'info' | 'warning' = 'info'): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const id = this.nextId++;
    const toast: Toast = { id, message, action, duration, type };
    this.toasts.push(toast);
    if (duration > 0) {
      setTimeout(() => this.remove(id), duration);
    }
  }

  remove(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  success(message: string, action = 'Close', duration = 3000): void {
    this.show(message, action, duration, 'success');
  }

  error(message: string, action = 'Close', duration = 6000): void {
    this.show(message, action, duration, 'error');
  }

  info(message: string, duration = 4000): void {
    this.show(message, 'Close', duration, 'info');
  }

  warning(message: string, duration = 5000): void {
    this.show(message, 'Close', duration, 'warning');
  }
}
