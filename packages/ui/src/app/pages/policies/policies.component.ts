import { Component, OnInit, inject, Injector, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { forkJoin } from 'rxjs';
import { PolicyService, Policy, PolicyConditions } from '../../services/policy.service';
import { MonitorService } from '../../services/monitor.service';
import { ecosystemLabel } from '../../shared/status';
import { ruleDetail, ruleInfo, rulesOf } from './policy-rules';
import { ToastService } from '../../services/toast.service';
import { PolicyViewDialogComponent } from './policy-view-dialog.component';
import { MODAL_DATA } from '../../tokens';
import { reorderPolicies } from './policies-reorder';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { FormsModule } from '@angular/forms';
import { PackageRepositoryRow, RepositoryService } from '../../services/repository.service';
import { EpssService } from '../../services/epss.service';
import { missingIds, repositoryLabel, scopesOverlap } from '../../shared/repository-scope';

@Component({
  selector: 'app-policies',
  standalone: true,
  imports: [DecimalPipe, FormsModule, RouterLink, EmptyStateComponent, PaginationComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Policies</h1>
          <p class="dg-page-subtitle">Rules that allow or block packages.</p>
        </div>
        <div class="dg-page-actions">
          <a routerLink="/package-check" class="dg-btn dg-btn-secondary">
            <span class="material-symbols-outlined">fact_check</span> Package check
          </a>
          <button type="button" class="dg-btn dg-btn-primary" (click)="openAdd()">
            <span class="material-symbols-outlined">add</span> New policy
          </button>
        </div>
      </header>

      @if (epssStale) {
        <div class="dg-callout is-warning" role="status" data-testid="epss-stale-banner">
          <span class="material-symbols-outlined" aria-hidden="true">warning</span>
          <div>
            {{ epssStale }} Policies that use EPSS keep using the last good data.
            <a routerLink="/settings" [queryParams]="{ tab: 'jobs' }">Open EPSS data</a>
          </div>
        </div>
      }

      <div class="dg-stats">
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Enforced</div>
            <div class="dg-stat-value">{{ enabledTotal - monitoringTotal | number }}</div>
            <div class="dg-stat-meta">Evaluated on every request</div>
          </div>
          <span class="dg-stat-icon tone-success"><span class="material-symbols-outlined">verified_user</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Monitoring</div>
            <div class="dg-stat-value" data-testid="stat-monitoring">{{ monitoringTotal | number }}</div>
            <div class="dg-stat-meta">Logging, not blocking</div>
          </div>
          <span class="dg-stat-icon tone-brand"><span class="material-symbols-outlined">visibility</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Disabled</div>
            <div class="dg-stat-value">{{ disabledTotal | number }}</div>
            <div class="dg-stat-meta">Kept but not evaluated</div>
          </div>
          <span class="dg-stat-icon tone-neutral"><span class="material-symbols-outlined">pause_circle</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Total policies</div>
            <div class="dg-stat-value">{{ total | number }}</div>
            <div class="dg-stat-meta">Across all decisions</div>
          </div>
          <span class="dg-stat-icon tone-brand"><span class="material-symbols-outlined">policy</span></span>
        </div>
      </div>

      <section class="dg-card">
        <div class="dg-card-header">
          <h2 class="dg-card-title">Evaluation order</h2>
          <span class="dg-card-hint">First match wins, top to bottom. Drag or use the arrows to reorder; changes save at once.</span>
        </div>
        <div class="dg-toolbar">
          <label class="visually-hidden" for="policy-repository-filter">Repository</label>
          <select id="policy-repository-filter" class="form-select form-select-sm" style="max-width: 280px"
            [(ngModel)]="repositoryFilter" (ngModelChange)="applyRepositoryFilter()" data-testid="policy-repository-filter">
            <option value="">All repositories</option>
            @for (repo of repositoryOptions; track repo.id) {
              <option [value]="repo.id">Applies to {{ label(repo) }}</option>
            }
          </select>
          @if (repositoryFilter) {
            <span class="dg-form-help">Policies limited to this repository, and those for every repository of its ecosystem.</span>
          }
        </div>

        @if (loading) {
          <div class="dg-loading"><span class="dg-spinner"></span></div>
        } @else if (policies.length === 0) {
          <app-empty-state icon="policy" title="No policies yet" description="Create a policy to allow or block package versions that match its rule.">
            <button type="button" class="dg-btn dg-btn-primary" (click)="openAdd()">
              <span class="material-symbols-outlined">add</span> New policy
            </button>
          </app-empty-state>
        } @else {
          <div class="dg-table-wrap">
            <table class="dg-table">
              <thead>
                <tr>
                  <th style="width: 1%"><span class="visually-hidden">Reorder</span></th>
                  <th style="width: 1%">Priority</th>
                  <th>Policy</th>
                  <th>Decision</th>
                  <th>Rule</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of policies; track row.id; let i = $index) {
                  <tr
                    [class.opacity-40]="dragFrom === i"
                    [style.box-shadow]="dragOver === i && dragFrom !== i ? 'inset 0 2px 0 var(--brand)' : null"
                    draggable="true"
                    (dragstart)="onDragStart($event, i)"
                    (dragend)="onDragEnd()"
                    (dragover)="onDragOver($event, i)"
                    (drop)="onDrop($event, i)">
                    <td>
                      <span class="material-symbols-outlined dg-text-muted" style="cursor: grab; font-size: 20px" title="Drag to reorder" aria-hidden="true">drag_indicator</span>
                    </td>
                    <td><span class="dg-tag">{{ row.priority }}</span></td>
                    <td>
                      <span class="dg-cell-primary">{{ row.name }}</span>
                      @if (row.description) {
                        <span class="dg-cell-sub dg-cell-truncate" [title]="row.description">{{ row.description }}</span>
                      }
                    </td>
                    <td><app-status-pill [value]="row.decision" /></td>
                    <td class="dg-text-variant">
                      <span class="dg-cell-primary">{{ ruleSummary(row.conditions).label }}</span>
                      <span class="dg-cell-sub dg-cell-truncate" [title]="ruleSummary(row.conditions).detail">{{ ruleSummary(row.conditions).detail }}</span>
                    </td>
                    <td [attr.data-testid]="'policy-scope-' + row.id">
                      @if (scopeLabels(row).length === 0 && !scopeMissing(row)) {
                        <span class="dg-text-muted text-xs">All repositories</span>
                      } @else {
                        @for (label of scopeLabels(row).slice(0, 2); track label) {
                          <span class="dg-chip dg-chip-accent">{{ label }}</span>
                        }
                        @if (scopeLabels(row).length > 2) {
                          <span class="dg-chip" [title]="scopeLabels(row).join(', ')">+{{ scopeLabels(row).length - 2 }}</span>
                        }
                        @if (scopeMissing(row)) {
                          <span class="dg-chip dg-chip-warning" title="A repository this policy was limited to was deleted">Deleted repository</span>
                        }
                      }
                    </td>
                    <td>
                      <div class="d-flex align-items-center gap-2">
                        <button type="button" class="dg-switch" [class.is-on]="row.isEnabled" role="switch"
                          [attr.aria-checked]="row.isEnabled" [attr.aria-label]="(row.isEnabled ? 'Disable ' : 'Enable ') + row.name"
                          (click)="toggleEnabled(row)"></button>
                        <span class="text-xs font-semibold" [class.dg-text-muted]="!row.isEnabled">{{ !row.isEnabled ? 'Disabled' : row.mode === 'monitor' ? 'On' : 'Enforced' }}</span>
                        @if (row.mode === 'monitor') {
                          <a class="text-decoration-none" [routerLink]="['/monitoring', row.id]" title="Open the monitoring report">
                            <app-status-pill value="monitoring" label="Monitoring" tone="info" />
                          </a>
                        }
                      </div>
                    </td>
                    <td class="col-actions">
                      <div class="dg-row-actions">
                        <button type="button" class="dg-icon-btn" [disabled]="isFirst(row)" (click)="moveUp(row)" title="Move up" aria-label="Move up">
                          <span class="material-symbols-outlined">arrow_upward</span>
                        </button>
                        <button type="button" class="dg-icon-btn" [disabled]="isLast(row)" (click)="moveDown(row)" title="Move down" aria-label="Move down">
                          <span class="material-symbols-outlined">arrow_downward</span>
                        </button>
                        <button type="button" class="dg-icon-btn" (click)="openView(row)" title="View details" aria-label="View details">
                          <span class="material-symbols-outlined">visibility</span>
                        </button>
                        <button type="button" class="dg-icon-btn" (click)="openEdit(row)" title="Edit" aria-label="Edit">
                          <span class="material-symbols-outlined">edit</span>
                        </button>
                        <button type="button" class="dg-icon-btn is-danger" (click)="confirmDelete(row)" title="Delete" aria-label="Delete">
                          <span class="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (!loading && total > 0) {
          <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="policies.length" storageKey="policies" (pageChange)="onPage($event)" />
        }
      </section>
    </div>
  `,
})
export class PoliciesComponent implements OnInit {
  policies: Policy[] = [];
  loading = false;
  limit = savedPageSize('policies', 20);
  offset = 0;
  total = 0;
  enabledTotal = 0;
  disabledTotal = 0;
  monitoringTotal = 0;
  /** Repository ID: show only policies that apply to it. */
  repositoryFilter = '';
  repositoryOptions: PackageRepositoryRow[] = [];
  dragFrom: number | null = null;
  dragOver: number | null = null;
  private reordering = false;

  get page(): number { return Math.floor(this.offset / this.limit) + 1; }

  /** The rule a policy uses and what it matches, e.g. "Release type" / "Maven · Pre-release, Snapshot". */
  ruleSummary(conditions: PolicyConditions | undefined): { label: string; detail: string } {
    const c = conditions ?? {};
    const rules = rulesOf(c);
    if (rules.length === 0) return { label: 'No rule', detail: '' };
    const label = rules.map((rule) => ruleInfo(rule).label).join(' + ');
    const eco = c.ecosystem?.length ? c.ecosystem.map(ecosystemLabel).join(', ') : 'All ecosystems';
    return { label, detail: [eco, ...rules.map((rule) => ruleDetail(rule, c))].join(' · ') };
  }

  private policyService = inject(PolicyService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private router = inject(Router);
  private injector = inject(Injector);
  private confirm = inject(ConfirmService);
  private monitor = inject(MonitorService);
  private repositories = inject(RepositoryService);
  private epss = inject(EpssService);
  private loadSeq = 0;
  /** Why EPSS data is not usable while an enabled policy on this page uses it; empty otherwise. */
  epssStale = '';
  private epssChecked = false;

  /** Asked once per visit, and only when an enabled policy uses an EPSS threshold. */
  private checkEpss(): void {
    if (this.epssChecked) return;
    const uses = this.policies.some((row) => row.isEnabled && (typeof row.conditions?.epssMin === 'number' || typeof row.conditions?.epssPercentileMin === 'number'));
    if (!uses) return;
    this.epssChecked = true;
    this.epss.status().subscribe({
      next: (status) => {
        if (!status.enabled) this.epssStale = 'EPSS is turned off (EPSS_ENABLED=false).';
        else if (!status.scoreDate) this.epssStale = 'EPSS data has never been synced.';
        else if (status.stale) this.epssStale = `EPSS data is older than ${status.staleAfterHours} hours.`;
      },
      error: () => undefined,
    });
  }

  ngOnInit(): void {
    this.load();
    this.repositories.list().subscribe({ next: (rows) => (this.repositoryOptions = rows), error: () => undefined });
  }

  label(repo: PackageRepositoryRow): string {
    return repositoryLabel(repo);
  }

  scopeLabels(row: Policy): string[] {
    return (row.repositories ?? []).map(repositoryLabel);
  }

  scopeMissing(row: Policy): boolean {
    return missingIds(row.repositoryIds, row.repositories).length > 0;
  }

  applyRepositoryFilter(): void {
    this.offset = 0;
    this.load();
  }

  private listParams(limit: number, offset: number) {
    return { limit, offset, ...(this.repositoryFilter ? { repositoryId: this.repositoryFilter } : {}) };
  }

  load(): void {
    this.loading = true;
    // A slower earlier request (e.g. before the repository filter changed) must not overwrite a newer one.
    const seq = ++this.loadSeq;
    this.policyService.list(this.listParams(this.limit, this.offset)).subscribe({
      next: page => {
        if (seq !== this.loadSeq) return;
        if (page.items.length === 0 && this.offset > 0 && page.total > 0) {
          this.offset = Math.max(0, Math.floor((page.total - 1) / this.limit) * this.limit);
          this.load();
          return;
        }
        this.policies = page.items;
        this.checkEpss();
        this.total = page.total;
        this.enabledTotal = page.enabled;
        this.disabledTotal = page.disabled;
        this.monitoringTotal = page.monitoring ?? 0;
        this.monitor.refreshCount();
        this.loading = false;
      },
      error: err => {
        if (seq !== this.loadSeq) return;
        this.toast.error(err.error?.error ?? 'Failed to load');
        this.loading = false;
      },
    });
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  openAdd(): void {
    void this.router.navigate(['/policies/new']);
  }

  openView(row: Policy): void {
    this.policyService.get(row.id).subscribe({
      next: policy => {
        const ref = this.modal.open(PolicyViewDialogComponent, {
          injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: { policy } }], parent: this.injector }),
        });
        ref.closed.subscribe((result) => { if (result === 'changed') this.load(); });
      },
      error: err => this.toast.error(err.error?.error ?? 'Failed to load policy'),
    });
  }

  openEdit(row: Policy): void {
    void this.router.navigate(['/policies', row.id, 'edit']);
  }

  toggleEnabled(row: Policy): void {
    const next = !row.isEnabled;
    this.policyService.update(row.id, { isEnabled: next }).subscribe({
      next: () => {
        row.isEnabled = next;
        const step = next ? 1 : -1;
        this.enabledTotal += step;
        this.disabledTotal -= step;
        if (row.mode === 'monitor') {
          this.monitoringTotal += step;
          this.monitor.refreshCount();
        }
        const on = row.mode === 'monitor' ? 'turned on (monitoring)' : 'enforced';
        this.toast.success(`"${row.name}" ${next ? on : 'disabled'}`);
      },
      error: err => this.toast.error(err.error?.error ?? 'Update failed'),
    });
  }

  onDragStart(event: DragEvent, index: number): void {
    const target = event.target as HTMLElement | null;
    if (this.reordering || target?.closest('button')) {
      event.preventDefault();
      return;
    }
    this.dragFrom = index;
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent, index: number): void {
    if (this.dragFrom == null || this.reordering) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragOver = index;
  }

  onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    const from = this.dragFrom;
    this.onDragEnd();
    if (from == null || from === index || this.reordering) return;
    this.persistOrder(from, index);
  }

  onDragEnd(): void {
    this.dragFrom = null;
    this.dragOver = null;
  }

  isFirst(row: Policy): boolean {
    return this.offset === 0 && this.policies[0]?.id === row.id;
  }

  isLast(row: Policy): boolean {
    const idx = this.policies.findIndex(p => p.id === row.id);
    return idx >= 0 && this.offset + idx >= this.total - 1;
  }

  /** Two policies can only decide the same download when both are enabled and share an ecosystem and a repository. */
  private competes(a: Policy, b: Policy): boolean {
    if (!a.isEnabled || !b.isEnabled) return false;
    if (!scopesOverlap(a.repositoryIds, b.repositoryIds)) return false;
    const ea = a.conditions?.ecosystem ?? [];
    const eb = b.conditions?.ecosystem ?? [];
    return ea.length === 0 || eb.length === 0 || ea.some((e) => eb.includes(e));
  }

  /** The nearest policy in that direction whose order matters for this one, so unrelated rows keep their priority. */
  private neighbour(row: Policy, direction: 'up' | 'down'): Policy | undefined {
    const idx = this.policies.findIndex((p) => p.id === row.id);
    const step = direction === 'up' ? -1 : 1;
    for (let i = idx + step; i >= 0 && i < this.policies.length; i += step) {
      if (this.competes(row, this.policies[i])) return this.policies[i];
    }
    return undefined;
  }

  moveUp(row: Policy): void {
    if (this.isFirst(row)) return;
    const near = this.neighbour(row, 'up');
    if (near) {
      this.swapWith(row, near, 'up');
      return;
    }
    const idx = this.policies.findIndex((p) => p.id === row.id);
    if (idx > 0) {
      this.swapWith(row, this.policies[idx - 1], 'up');
      return;
    }
    this.policyService.list(this.listParams(1, this.offset - 1)).subscribe({
      next: page => {
        const prev = page.items[0];
        if (prev) this.swapWith(row, prev, 'up');
      },
      error: err => this.toast.error(err.error?.error ?? 'Update failed'),
    });
  }

  moveDown(row: Policy): void {
    if (this.isLast(row)) return;
    const near = this.neighbour(row, 'down');
    if (near) {
      this.swapWith(row, near, 'down');
      return;
    }
    const idx = this.policies.findIndex((p) => p.id === row.id);
    if (idx >= 0 && idx < this.policies.length - 1) {
      this.swapWith(row, this.policies[idx + 1], 'down');
      return;
    }
    this.policyService.list(this.listParams(1, this.offset + idx + 1)).subscribe({
      next: page => {
        const next = page.items[0];
        if (next) this.swapWith(row, next, 'down');
      },
      error: err => this.toast.error(err.error?.error ?? 'Update failed'),
    });
  }

  private persistOrder(from: number, to: number): void {
    const previous = this.policies;
    const next = reorderPolicies(previous, from, to);
    const original = new Map(previous.map((policy) => [policy.id, policy.priority]));
    const updates = next
      .filter((policy) => policy.priority !== original.get(policy.id))
      .map((policy) => this.policyService.update(policy.id, { priority: policy.priority }));
    this.policies = next;
    if (updates.length === 0) return;
    this.reordering = true;
    forkJoin(updates).subscribe({
      next: () => {
        this.reordering = false;
        this.toast.success('Order updated');
      },
      error: (err) => {
        this.reordering = false;
        this.policies = previous;
        this.toast.error(err.error?.error ?? 'Update failed');
      },
    });
  }

  private swapWith(moving: Policy, other: Policy, direction: 'up' | 'down'): void {
    const same = moving.priority === other.priority;
    // Prefer changing only the moved policy: step just past the neighbour when that number is free.
    // Only when it is taken do the two policies trade priorities, so unrelated policies keep theirs.
    const step = direction === 'up' ? other.priority - 1 : other.priority + 1;
    const stepTaken = this.policies.some((p) => p.id !== moving.id && p.id !== other.id && p.priority === step);
    const onlyMoving = same || !stepTaken;
    const movingPriority = onlyMoving ? step : other.priority;
    const updates = [this.policyService.update(moving.id, { priority: movingPriority })];
    if (!onlyMoving) updates.push(this.policyService.update(other.id, { priority: moving.priority }));
    forkJoin(updates).subscribe({
      next: () => { this.load(); this.toast.success('Order updated'); },
      error: err => this.toast.error(err.error?.error ?? 'Update failed'),
    });
  }

  async confirmDelete(row: Policy): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete policy?',
      message: `"${row.name}" will stop applying immediately. This can't be undone.`,
      confirmText: 'Delete policy',
    });
    if (!ok) return;
    this.policyService.delete(row.id).subscribe({
      next: () => { this.toast.success(`Deleted "${row.name}"`); this.load(); },
      error: err => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
}
