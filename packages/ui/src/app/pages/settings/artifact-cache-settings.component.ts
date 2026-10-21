import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ArtifactCacheLimitField,
  ArtifactCacheLimitsPatch,
  ArtifactCachePod,
  ArtifactCacheService,
  ArtifactCacheStatus,
} from '../../services/artifact-cache.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS, ecosystemLabel } from '../../shared/status';
import type { Tone } from '../../shared/status';

/** What an admin types to clear every pod's cache. */
export const CLEAR_PHRASE = 'clear artifact cache';

type LimitField = { key: ArtifactCacheLimitField; label: string; unit: string; min: number; max: number; integer: boolean; note?: string };

export const LIMIT_FIELDS: LimitField[] = [
  { key: 'maxSizeGb', label: 'Size per pod', unit: 'GB', min: 0, max: 1_000_000, integer: false },
  { key: 'maxFiles', label: 'Files per pod', unit: 'files', min: 1, max: 1_000_000_000, integer: true },
  { key: 'maxAgeDays', label: 'Expire after storing', unit: 'days', min: 0, max: 3650, integer: true, note: '0 = never' },
  { key: 'maxIdleDays', label: 'Expire when unused', unit: 'days', min: 0, max: 3650, integer: true, note: '0 = never' },
  { key: 'maxFileMb', label: 'Largest file stored', unit: 'MB', min: 1, max: 1_048_576, integer: true },
];

/** Text as typed, or a number or null from a number input. */
export type LimitsForm = Record<ArtifactCacheLimitField, string | number | null>;

/** 1536 → "1.5 KB". Powers of 1024, as the size limit is in GB of 1024³ bytes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Share of downloads in the last 24 hours that were served from the cache, or null before any download. */
export function hitRate(pod: Pick<ArtifactCachePod, 'hits24h' | 'misses24h'>): number | null {
  const total = pod.hits24h + pod.misses24h;
  return total === 0 ? null : Math.round((pod.hits24h / total) * 100);
}

export function percentOf(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
}

/** The form for saved limits: a saved value, or empty for the environment default. */
export function formFrom(saved: ArtifactCacheStatus['savedLimits']): LimitsForm {
  const form = {} as LimitsForm;
  for (const field of LIMIT_FIELDS) form[field.key] = saved[field.key] != null ? String(saved[field.key]) : '';
  return form;
}

/**
 * What changed between the form and the saved limits: a number sets a field, null (an emptied field) goes back to
 * the environment. An error names the first value out of range.
 */
export function limitsPatch(form: LimitsForm, saved: ArtifactCacheStatus['savedLimits']): { patch: ArtifactCacheLimitsPatch } | { error: string } {
  const patch: ArtifactCacheLimitsPatch = {};
  for (const field of LIMIT_FIELDS) {
    const text = String(form[field.key] ?? '').trim();
    const before = saved[field.key];
    if (text === '') {
      if (before != null) patch[field.key] = null;
      continue;
    }
    const value = Number(text);
    const valid =
      Number.isFinite(value) &&
      (field.integer ? Number.isInteger(value) : true) &&
      (field.key === 'maxSizeGb' ? value > 0 : value >= field.min) &&
      value <= field.max;
    if (!valid) {
      const range = field.key === 'maxSizeGb' ? 'a number above 0' : `a whole number from ${field.min}`;
      return { error: `${field.label}: enter ${range}` };
    }
    if (value !== before) patch[field.key] = value;
  }
  return { patch };
}

const STATE: Record<string, { label: string; tone: Tone }> = {
  ok: { label: 'On', tone: 'success' },
  off: { label: 'Off', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
};

@Component({
  selector: 'app-artifact-cache-settings',
  standalone: true,
  imports: [FormsModule, EmptyStateComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .head-note { font-size: 0.75rem; color: var(--color-on-surface-variant); margin: 2px 0 0; }
    .limits { display: grid; gap: 16px; padding: 16px 20px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
    .unit { position: relative; }
    .unit input { padding-right: 52px; }
    .unit span { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75rem; color: var(--color-on-surface-variant); pointer-events: none; }
    .field-note { font-size: 0.75rem; color: var(--color-on-surface-variant); margin-top: 4px; }
    .footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px 16px; border-top: 1px solid var(--color-border); }
    .meter { height: 6px; border-radius: 999px; background: var(--color-border); overflow: hidden; margin-top: 4px; width: 120px; }
    .meter > span { display: block; height: 100%; background: var(--brand-text); }
    .meter.is-high > span { background: var(--bs-warning, #d97706); }
    .row { display: grid; gap: 12px; padding: 16px 20px; grid-template-columns: 1fr; }
    @media (min-width: 768px) { .row { grid-template-columns: 160px minmax(0, 1fr) 180px auto; align-items: end; } }
    .clear { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; padding: 16px 20px; border-top: 1px solid var(--color-border); }
  `],
  template: `
    <div class="d-flex flex-column gap-4">
      <section class="dg-card">
        <div class="dg-card-header head">
          <div>
            <h2 class="dg-card-title">Artifact cache</h2>
            @if (status) {
              <p class="head-note" data-testid="acache-source">
                @if (!status.available && !status.enabled) {
                  Set a size per pod to turn it on.
                } @else if (status.setting === null) {
                  Default (ARTIFACT_CACHE_ENABLED)
                } @else {
                  Set here ·
                  <button type="button" class="btn btn-link btn-sm p-0 align-baseline" (click)="useEnvironment()" [disabled]="saving" data-testid="acache-use-env">Reset</button>
                }
              </p>
            }
          </div>
          @if (status) {
            <button type="button" class="dg-switch" role="switch" [class.is-on]="status.enabled" [attr.aria-checked]="status.enabled"
              aria-label="Artifact cache" data-testid="acache-switch" [disabled]="saving || (!status.available && !status.enabled)" (click)="toggle()"></button>
          }
        </div>

        @if (loading && !status) {
          <div class="dg-loading"><span class="dg-spinner"></span></div>
        } @else if (!status) {
          <app-empty-state icon="cloud_off" title="Status unavailable" [compact]="true" />
        } @else {
          <div class="limits" data-testid="acache-limits">
            @for (field of fields; track field.key) {
              <div class="dg-field mb-0">
                <label class="form-label" [for]="'acache-' + field.key">{{ field.label }}</label>
                <div class="unit">
                  <input [id]="'acache-' + field.key" class="form-control" type="number" inputmode="decimal" [min]="field.min" [max]="field.max"
                    [step]="field.integer ? 1 : 'any'" [(ngModel)]="form[field.key]" [placeholder]="defaultOf(field.key)" [attr.data-testid]="'acache-' + field.key" />
                  <span>{{ field.unit }}</span>
                </div>
                <div class="field-note">
                  Default {{ defaultOf(field.key) }}{{ field.note ? ' · ' + field.note : '' }}
                  @if (hasValue(field.key)) {
                    · <button type="button" class="btn btn-link btn-sm p-0 align-baseline" (click)="form[field.key] = ''" [attr.data-testid]="'acache-reset-' + field.key">Reset</button>
                  }
                </div>
              </div>
            }
          </div>
          <div class="footer">
            <span class="field-note mt-0" data-testid="acache-dir">Directory <code class="dg-inline-code">{{ status.dir }}</code> (ARTIFACT_CACHE_DIR)</span>
            <div class="d-flex gap-2">
              <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="undo()" [disabled]="saving || !dirty()" data-testid="acache-undo">Undo</button>
              <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="saveLimits()" [disabled]="saving || !dirty()" data-testid="acache-save">
                {{ saving ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        }
      </section>

      @if (status) {
        <section class="dg-card">
          <div class="dg-card-header">
            <h2 class="dg-card-title">Pods</h2>
            <button type="button" class="dg-icon-btn" (click)="load()" [disabled]="loading" title="Refresh" aria-label="Refresh" data-testid="acache-refresh">
              <span class="material-symbols-outlined">refresh</span>
            </button>
          </div>
          @if (!status.redisAvailable) {
            <div class="dg-callout is-warning mx-3 mb-3" data-testid="acache-redis-down">
              <span class="material-symbols-outlined">warning</span>
              <span>Redis is down: only this pod is listed, and purges wait.</span>
            </div>
          }
          <div class="dg-table-wrap">
            <table class="dg-table">
              <thead>
                <tr><th>Pod</th><th>State</th><th>Size</th><th>Files</th><th>From cache (24 h)</th></tr>
              </thead>
              <tbody>
                @for (pod of status.pods; track pod.pod) {
                  <tr [attr.data-testid]="'acache-pod-' + pod.pod">
                    <td><span class="dg-cell-primary font-mono">{{ pod.pod }}</span></td>
                    <td>
                      <app-status-pill [value]="pod.state" [label]="stateLabel(pod.state)" [tone]="stateTone(pod.state)" />
                      @if (pod.lastError) { <span class="dg-cell-sub text-danger">{{ pod.lastError }}</span> }
                    </td>
                    <td>
                      {{ bytes(pod.sizeBytes) }} <span class="dg-text-muted">of {{ bytes(pod.maxSizeBytes) }}</span>
                      @if (pod.limitedByDisk) { <span class="dg-tag ms-1" title="Less free disk space than the size per pod" data-testid="acache-disk-limited">disk</span> }
                      <div class="meter" [class.is-high]="percent(pod.sizeBytes, pod.maxSizeBytes) >= 95"><span [style.width.%]="percent(pod.sizeBytes, pod.maxSizeBytes)"></span></div>
                    </td>
                    <td>
                      {{ pod.files.toLocaleString() }} <span class="dg-text-muted">of {{ pod.maxFiles.toLocaleString() }}</span>
                      <div class="meter" [class.is-high]="percent(pod.files, pod.maxFiles) >= 95"><span [style.width.%]="percent(pod.files, pod.maxFiles)"></span></div>
                    </td>
                    <td>{{ rateLabel(pod) }} <span class="dg-cell-sub">{{ pod.hits24h.toLocaleString() }} of {{ (pod.hits24h + pod.misses24h).toLocaleString() }}</span></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="dg-text-muted">No pod has reported in the last minute.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="dg-card">
          <div class="dg-card-header"><h2 class="dg-card-title">Purge</h2></div>
          <div class="row">
            <div class="dg-field mb-0">
              <label class="form-label" for="acache-eco">Ecosystem</label>
              <select id="acache-eco" class="form-select" [(ngModel)]="ecosystem" data-testid="acache-eco">
                @for (e of ecosystems; track e) { <option [value]="e">{{ label(e) }}</option> }
              </select>
            </div>
            <div class="dg-field mb-0">
              <label class="form-label" for="acache-package">Package</label>
              <input id="acache-package" class="form-control font-mono" [(ngModel)]="packageName" [placeholder]="placeholder()" autocomplete="off" data-testid="acache-package" />
            </div>
            <div class="dg-field mb-0">
              <label class="form-label" for="acache-version">Version</label>
              <input id="acache-version" class="form-control font-mono" [(ngModel)]="version" placeholder="All versions" autocomplete="off" data-testid="acache-version" />
            </div>
            <button type="button" class="dg-btn dg-btn-secondary" (click)="purgePackage()" [disabled]="purging || !packageName.trim()" data-testid="acache-purge">
              {{ purging ? 'Purging…' : 'Purge' }}
            </button>
          </div>
          <div class="clear">
            <div class="dg-field mb-0 flex-grow-1">
              <label class="form-label" for="acache-clear">Clear everything: type <code class="dg-inline-code">{{ clearPhrase }}</code></label>
              <input id="acache-clear" class="form-control" [(ngModel)]="clearConfirmation" autocomplete="off" data-testid="acache-clear-input" />
            </div>
            <button type="button" class="dg-btn dg-btn-danger" (click)="clearAll()" [disabled]="purging || !canClear()" data-testid="acache-clear">Clear</button>
          </div>
        </section>
      }
    </div>
  `,
})
export class ArtifactCacheSettingsComponent implements OnInit {
  readonly ecosystems = ECOSYSTEMS;
  readonly fields = LIMIT_FIELDS;
  readonly clearPhrase = CLEAR_PHRASE;
  status: ArtifactCacheStatus | null = null;
  form: LimitsForm = formFrom({});
  loading = false;
  saving = false;
  purging = false;
  ecosystem: string = 'npm';
  packageName = '';
  version = '';
  clearConfirmation = '';

  private service = inject(ArtifactCacheService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading = true;
    this.service.status().subscribe({
      next: (status) => {
        this.apply(status);
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load the artifact cache status');
      },
    });
  }

  /** A refresh keeps edits that were not saved yet. */
  private apply(status: ArtifactCacheStatus): void {
    const keepEdits = this.status !== null && this.dirty();
    this.status = status;
    if (!keepEdits) this.form = formFrom(status.savedLimits);
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  bytes(value: number): string {
    return formatBytes(value);
  }

  percent(used: number, limit: number): number {
    return percentOf(used, limit);
  }

  rateLabel(pod: ArtifactCachePod): string {
    const rate = hitRate(pod);
    return rate === null ? '—' : `${rate} %`;
  }

  stateLabel(state: string): string {
    return STATE[state]?.label ?? state;
  }

  stateTone(state: string): Tone {
    return STATE[state]?.tone ?? 'neutral';
  }

  defaultOf(field: ArtifactCacheLimitField): string {
    const value = this.status?.environmentLimits[field];
    return value === null || value === undefined ? 'not set' : String(value);
  }

  placeholder(): string {
    const examples: Record<string, string> = {
      npm: 'lodash or @scope/name',
      pypi: 'requests',
      go: 'github.com/org/module',
      maven: 'org.example:artifact',
      nuget: 'Newtonsoft.Json',
      cargo: 'serde',
      composer: 'vendor/name',
      rubygems: 'rails',
    };
    return examples[this.ecosystem] ?? '';
  }

  dirty(): boolean {
    if (!this.status) return false;
    const result = limitsPatch(this.form, this.status.savedLimits);
    return 'error' in result || Object.keys(result.patch).length > 0;
  }

  hasValue(field: ArtifactCacheLimitField): boolean {
    return String(this.form[field] ?? '').trim() !== '';
  }

  undo(): void {
    if (this.status) this.form = formFrom(this.status.savedLimits);
  }

  saveLimits(): void {
    if (!this.status) return;
    const result = limitsPatch(this.form, this.status.savedLimits);
    if ('error' in result) {
      this.toast.error(result.error);
      return;
    }
    this.save({ limits: result.patch }, 'Artifact cache settings saved', true);
  }

  async toggle(): Promise<void> {
    if (!this.status) return;
    const on = !this.status.enabled;
    if (!on) {
      const ok = await this.confirm.confirm({
        title: 'Turn off the artifact cache?',
        message: 'Downloads stream from the registries again. Stored files stay until they expire or you clear them.',
        confirmText: 'Turn off',
      });
      if (!ok) return;
    }
    this.save({ enabled: on }, on ? 'Artifact cache on' : 'Artifact cache off');
  }

  useEnvironment(): void {
    this.save({ enabled: null }, 'Artifact cache follows ARTIFACT_CACHE_ENABLED');
  }

  private save(body: Parameters<ArtifactCacheService['updateSettings']>[0], done: string, resetForm = false): void {
    this.saving = true;
    this.service.updateSettings(body).subscribe({
      next: (status) => {
        this.status = status;
        if (resetForm) this.form = formFrom(status.savedLimits);
        this.saving = false;
        this.toast.success(done);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Could not save the artifact cache settings');
      },
    });
  }

  canClear(): boolean {
    return this.clearConfirmation.trim().toLowerCase() === CLEAR_PHRASE;
  }

  async purgePackage(): Promise<void> {
    const pkg = this.packageName.trim();
    if (!pkg) return;
    const version = this.version.trim();
    const what = `${this.label(this.ecosystem)} ${pkg}${version ? ` ${version}` : ''}`;
    const ok = await this.confirm.confirm({
      title: 'Purge from the artifact cache?',
      message: `${what}${version ? '' : ' (all versions)'} is removed from every pod.`,
      confirmText: 'Purge',
    });
    if (!ok) return;
    this.run({ ecosystem: this.ecosystem, package: pkg, ...(version ? { version } : {}) }, what, () => {
      this.packageName = '';
      this.version = '';
    });
  }

  clearAll(): void {
    if (!this.canClear()) return;
    this.run({ all: true }, 'Every cached file', () => (this.clearConfirmation = ''));
  }

  private run(body: Parameters<ArtifactCacheService['purge']>[0], what: string, done: () => void): void {
    this.purging = true;
    this.service.purge(body).subscribe({
      next: (res) => {
        this.purging = false;
        done();
        const pods = res.pods === 1 ? '1 pod' : `${res.pods} pods`;
        this.toast.success(`${what}: purge sent to ${pods}. This pod removed ${res.files.toLocaleString()} files (${formatBytes(res.bytes)}).`);
        this.load();
      },
      error: (err) => {
        this.purging = false;
        this.toast.error(err.error?.error ?? 'Purge failed');
        this.load();
      },
    });
  }
}
