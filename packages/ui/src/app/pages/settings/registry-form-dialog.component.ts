import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal, NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import {
  UpstreamRegistryService,
  UpstreamRegistry,
  RegistryCreatePayload,
  RegistryUpdatePayload,
} from '../../services/upstream-registry.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';

const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];
const AUTH_TYPES = [
  { value: '', label: 'None' },
  { value: 'basic', label: 'Basic (username/password)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
];

@Component({
  selector: 'app-registry-form-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, NgbTooltipModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <h5 class="modal-title">{{ editing ? 'Edit' : 'Add' }} Upstream Registry</h5>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="mb-3">
        <label class="form-label">Ecosystem</label>
        <select class="form-select" [(ngModel)]="ecosystem" disabled required>
          @for (e of ecosystems; track e) {
            <option [value]="e">{{ e }}</option>
          }
        </select>
      </div>
      <div class="mb-3">
        <label class="form-label">Registry URL</label>
        <input class="form-control" [(ngModel)]="url" placeholder="https://registry.example.com/" required />
      </div>
      <div class="row g-2 mb-3">
        <div class="col-6">
          <label class="form-label">Priority</label>
          <input type="number" class="form-control" [(ngModel)]="priority" />
        </div>
        <div class="col-6">
          <label class="form-label">Timeout (ms)</label>
          <input type="number" class="form-control" [(ngModel)]="timeoutMs" />
        </div>
      </div>
      <div class="mb-3">
        <label class="form-label">Authentication</label>
        <select class="form-select" [(ngModel)]="authType" (ngModelChange)="onAuthTypeChange()">
          @for (a of authTypes; track a.value) {
            <option [value]="a.value">{{ a.label }}</option>
          }
        </select>
      </div>
      @if (authType === 'basic') {
        <div class="mb-3 border rounded p-3 dg-subsection">
          <div class="mb-2">
            <label class="form-label">Username</label>
            <input
              type="text"
              class="form-control"
              [(ngModel)]="authUsername"
              [placeholder]="editing && usernameMasked ? usernameMasked : 'Username'"
              autocomplete="off"
            />
          </div>
          <div>
            <label class="form-label">Password</label>
            <input
              type="password"
              class="form-control"
              [(ngModel)]="authPassword"
              [placeholder]="editing && passwordMasked ? passwordMasked : 'Password'"
              autocomplete="new-password"
            />
          </div>
          @if (editing && (usernameMasked || passwordMasked)) {
            <small class="text-muted">Leave as {{ usernameMasked || passwordMasked }} to keep existing credentials.</small>
          }
        </div>
      }
      @if (authType === 'bearer') {
        <div class="mb-3 border rounded p-3 dg-subsection">
          <label class="form-label">Token</label>
          <input
            type="password"
            class="form-control"
            [(ngModel)]="authToken"
            [placeholder]="editing && tokenMasked ? tokenMasked : 'Bearer token'"
            autocomplete="off"
          />
          @if (editing && tokenMasked) {
            <small class="text-muted">Leave as {{ tokenMasked }} to keep existing token.</small>
          }
        </div>
      }
      @if (authType === 'header') {
        <div class="mb-3 border rounded p-3 dg-subsection">
          <div class="mb-2">
            <label class="form-label">Header name</label>
            <input class="form-control" [(ngModel)]="authHeaderName" placeholder="X-Api-Key" autocomplete="off" />
          </div>
          <div>
            <label class="form-label">Header value</label>
            <input
              type="password"
              class="form-control"
              [(ngModel)]="authHeaderValue"
              [placeholder]="editing && headerValueMasked ? headerValueMasked : 'Value'"
              autocomplete="off"
            />
          </div>
          @if (editing && headerValueMasked) {
            <small class="text-muted">Leave as {{ headerValueMasked }} to keep existing value.</small>
          }
        </div>
      }
      <div class="form-check">
        <input class="form-check-input" type="checkbox" [(ngModel)]="isEnabled" id="registryEnabled" />
        <label class="form-check-label" for="registryEnabled">Enabled</label>
      </div>
    </div>
    <div class="modal-footer">
      @if (!editing) {
        <small class="text-muted me-auto">Test connection before adding.</small>
      }
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()" ngbTooltip="Cancel" placement="top">Cancel</button>
      <button type="button" class="btn btn-outline-primary" (click)="testConnection()" [disabled]="!valid() || testing" ngbTooltip="Test connection to registry" placement="top">
        {{ testing ? 'Testing...' : 'Test connection' }}
      </button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="save()" [disabled]="!valid() || saving || (!editing && !connectionTested)" ngbTooltip="Save registry" placement="top">
        {{ saving ? 'Saving...' : (editing ? 'Update' : 'Add') }}
      </button>
    </div>
  `,
})
export class RegistryFormDialogComponent {
  editing = false;
  id = '';
  ecosystem = 'npm';
  url = '';
  priority = 0;
  timeoutMs = 30000;
  retryCount = 3;
  authType = '';
  authUsername = '';
  authPassword = '';
  authToken = '';
  authHeaderName = '';
  authHeaderValue = '';
  isEnabled = true;
  saving = false;
  testing = false;
  connectionTested = false;

  usernameMasked = '';
  passwordMasked = '';
  tokenMasked = '';
  headerValueMasked = '';

  ecosystems = ECOSYSTEMS;
  authTypes = AUTH_TYPES;

  activeModal = inject(NgbActiveModal);
  private registryService = inject(UpstreamRegistryService);
  private toast = inject(ToastService);
  private data = inject(MODAL_DATA, { optional: true }) as {
    editing: boolean;
    registry?: UpstreamRegistry;
    ecosystem?: string;
  } | undefined;

  constructor() {
    if (this.data) {
      this.editing = this.data.editing;
      if (this.data.ecosystem) this.ecosystem = this.data.ecosystem;
      if (this.data.registry) {
        const r = this.data.registry;
        this.id = r.id;
        this.ecosystem = r.ecosystem;
        this.url = r.url;
        this.priority = r.priority;
        this.timeoutMs = r.timeoutMs ?? 30000;
        this.retryCount = r.retryCount ?? 3;
        this.isEnabled = r.isEnabled;
        this.authType = r.authType ?? '';
        this.usernameMasked = r.usernameMasked ?? '';
        this.passwordMasked = r.passwordMasked ?? '';
        this.tokenMasked = r.tokenMasked ?? '';
        this.headerValueMasked = r.headerValueMasked ?? '';
        if (r.authType === 'basic' && (r.usernameMasked || r.passwordMasked)) {
          this.authUsername = r.usernameMasked ?? '';
          this.authPassword = r.passwordMasked ?? '';
        }
        if (r.authType === 'bearer' && r.tokenMasked) {
          this.authToken = r.tokenMasked;
        }
        if (r.authType === 'header' && r.headerValueMasked) {
          this.authHeaderValue = r.headerValueMasked;
        }
      }
    }
  }

  testConnection(): void {
    if (!this.valid() || this.testing) return;
    this.testing = true;
    if (this.editing && this.id) {
      this.registryService.test(this.id).subscribe({
        next: (res) => {
          this.connectionTested = true;
          this.toast.success(`Connection OK (${res.latencyMs}ms)`);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Connection failed'),
        complete: () => (this.testing = false),
      });
      return;
    }
    const payload: Parameters<UpstreamRegistryService['testConnection']>[0] = {
      ecosystem: this.ecosystem,
      url: this.url.trim(),
      timeoutMs: this.timeoutMs,
    };
    if (this.authType === 'basic') {
      payload.authType = 'basic';
      payload.authUsername = this.authUsername.trim();
      payload.authPassword = this.authPassword;
    } else if (this.authType === 'bearer') {
      payload.authType = 'bearer';
      payload.authToken = this.authToken;
    } else if (this.authType === 'header') {
      payload.authType = 'header';
      payload.authHeaderName = this.authHeaderName.trim();
      payload.authHeaderValue = this.authHeaderValue;
    }
    this.registryService.testConnection(payload).subscribe({
      next: (res) => {
        this.connectionTested = true;
        this.toast.success(`Connection OK (${res.latencyMs}ms)`);
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Connection failed'),
      complete: () => (this.testing = false),
    });
  }

  onAuthTypeChange(): void {
    if (!this.editing) {
      this.authUsername = '';
      this.authPassword = '';
      this.authToken = '';
      this.authHeaderName = '';
      this.authHeaderValue = '';
    }
  }

  valid(): boolean {
    if (!this.ecosystem || !this.url?.trim()) return false;
    if (this.authType === 'basic') return !!this.authUsername?.trim() && !!this.authPassword;
    if (this.authType === 'bearer') return !!this.authToken;
    if (this.authType === 'header') return !!this.authHeaderName?.trim() && !!this.authHeaderValue;
    return true;
  }

  save(): void {
    if (!this.valid() || this.saving) return;
    this.saving = true;
    if (this.editing) {
      const payload: RegistryUpdatePayload = {
        url: this.url.trim(),
        priority: this.priority,
        isEnabled: this.isEnabled,
        timeoutMs: this.timeoutMs,
        retryCount: this.retryCount,
        authType: (this.authType || null) as 'bearer' | 'basic' | 'header' | null,
      };
      if (this.authType === 'basic') {
        payload.authUsername = this.authUsername.trim();
        payload.authPassword = this.authPassword;
      } else if (this.authType === 'bearer') {
        payload.authToken = this.authToken;
      } else if (this.authType === 'header') {
        payload.authHeaderName = this.authHeaderName.trim();
        payload.authHeaderValue = this.authHeaderValue;
      }
      this.registryService.update(this.id, payload).subscribe({
        next: () => {
          this.toast.success('Registry updated');
          this.activeModal.close(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Update failed'),
        complete: () => (this.saving = false),
      });
    } else {
      const payload: RegistryCreatePayload = {
        ecosystem: this.ecosystem,
        url: this.url.trim(),
        priority: this.priority,
        timeoutMs: this.timeoutMs,
        retryCount: this.retryCount,
      };
      if (this.authType === 'basic') {
        payload.authType = 'basic';
        payload.authUsername = this.authUsername.trim();
        payload.authPassword = this.authPassword;
      } else if (this.authType === 'bearer') {
        payload.authType = 'bearer';
        payload.authToken = this.authToken;
      } else if (this.authType === 'header') {
        payload.authType = 'header';
        payload.authHeaderName = this.authHeaderName.trim();
        payload.authHeaderValue = this.authHeaderValue;
      }
      this.registryService.create(payload).subscribe({
        next: () => {
          this.toast.success('Registry added');
          this.activeModal.close(true);
        },
        error: (err) => this.toast.error(err.error?.error ?? 'Add failed'),
        complete: () => (this.saving = false),
      });
    }
  }
}
