import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { DashboardService, DashboardCharts } from '../../services/dashboard.service';
import { ToastService } from '../../services/toast.service';
import { AuthService } from '../../services/auth.service';
import { WebhookService, WebhookTarget } from '../../services/webhook.service';
import { RouterLink } from '@angular/router';
import { TopPackagesChartComponent } from '../../components/top-packages-chart.component';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { ECOSYSTEMS } from '../../shared/status';

type Range = '24h' | '7d' | '30d';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DecimalPipe, PercentPipe, FormsModule, RouterLink, TopPackagesChartComponent, EcoTagComponent, EmptyStateComponent],
  styles: [`
    .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.75rem; color: var(--color-on-surface-variant); }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 10px; height: 10px; border-radius: 3px; }
    .eco-row { display: grid; grid-template-columns: 96px minmax(0, 1fr) 72px; gap: 12px; align-items: center; padding: 7px 0; }
    .eco-total { text-align: right; font-size: 0.8125rem; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--color-on-surface); }
    .stack { display: flex; gap: 2px; height: 10px; border-radius: 999px; overflow: hidden; background: var(--color-surface-container); }
    .stack > div { height: 100%; min-width: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Security analytics</h1>
          <p class="dg-page-subtitle">Gateway decisions by outcome, ecosystem and package.</p>
        </div>
        <div class="dg-page-actions">
          <label class="dg-filter">
            <span>Time range</span>
            <select class="dg-select" [(ngModel)]="range" (ngModelChange)="load()">
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </select>
          </label>
          <button type="button" class="dg-icon-btn" (click)="load()" [disabled]="loading" title="Refresh" aria-label="Refresh">
            <span class="material-symbols-outlined">refresh</span>
          </button>
        </div>
      </header>

      @if (disabledWebhooks.length) {
        <div class="dg-callout is-danger mb-4" role="status" data-testid="dashboard-webhooks-disabled">
          <span class="material-symbols-outlined" aria-hidden="true">webhook</span>
          <div>
            @if (disabledWebhooks.length === 1) {
              The webhook to <strong>{{ disabledWebhooks[0].url }}</strong> was turned off after repeated failed deliveries.
            } @else {
              {{ disabledWebhooks.length }} webhooks were turned off after repeated failed deliveries.
            }
            Events since then are not being sent.
            <a routerLink="/settings" [queryParams]="{ tab: 'webhooks' }">Review webhooks</a>
          </div>
        </div>
      }

      <div class="dg-stats">
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Requests</div>
            <div class="dg-stat-value">{{ stats.total | number }}</div>
            <div class="dg-stat-meta">Package requests evaluated</div>
          </div>
          <span class="dg-stat-icon tone-brand"><span class="material-symbols-outlined">dns</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Allowed</div>
            <div class="dg-stat-value">{{ stats.allow | number }}</div>
            <div class="dg-stat-meta">{{ share(stats.allow) | percent: '1.1-1' }} of requests</div>
          </div>
          <span class="dg-stat-icon tone-success"><span class="material-symbols-outlined">check_circle</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Blocked</div>
            <div class="dg-stat-value">{{ stats.block | number }}</div>
            <div class="dg-stat-meta">{{ share(stats.block) | percent: '1.1-1' }} of requests</div>
          </div>
          <span class="dg-stat-icon tone-danger"><span class="material-symbols-outlined">block</span></span>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-12 gap-5">
        <section class="dg-card xl:col-span-12">
          <div class="dg-card-header">
            <h2 class="dg-card-title">Decisions by ecosystem</h2>
            <div class="legend" aria-label="Legend">
              <span><i class="swatch" style="background: var(--success-solid)"></i>Allowed</span>
              <span><i class="swatch" style="background: var(--danger-solid)"></i>Blocked</span>
            </div>
          </div>
          <div class="dg-card-body">
            @if (loading) {
              <div class="dg-loading"><span class="dg-spinner"></span></div>
            } @else if (ecosystemRows.length === 0) {
              <app-empty-state icon="bar_chart" title="No traffic in this range" [compact]="true" />
            } @else {
              @for (e of ecosystemRows; track e.ecosystem) {
                <div class="eco-row">
                  <app-eco-tag [ecosystem]="e.ecosystem" />
                  <div class="stack" role="img"
                    [attr.aria-label]="e.ecosystem + ': ' + e.allow + ' allowed, ' + e.block + ' blocked'">
                    @if (e.allow) {
                      <div [style.width.%]="(e.allow / e.total) * 100" style="background: var(--success-solid)"
                        [title]="'Allowed: ' + (e.allow | number) + ' (' + (e.allow / e.total | percent: '1.0-1') + ')'"></div>
                    }
                    @if (e.block) {
                      <div [style.width.%]="(e.block / e.total) * 100" style="background: var(--danger-solid)"
                        [title]="'Blocked: ' + (e.block | number) + ' (' + (e.block / e.total | percent: '1.0-1') + ')'"></div>
                    }
                  </div>
                  <span class="eco-total">{{ e.total | number }}</span>
                </div>
              }
            }
          </div>
        </section>

        <section class="dg-card xl:col-span-6">
          <div class="dg-card-header">
            <h2 class="dg-card-title"><span class="swatch" style="background: var(--danger-solid)"></span>Top blocked</h2>
          </div>
          <div class="dg-card-body pt-2">
            @if (loading) {
              <div class="dg-loading"><span class="dg-spinner"></span></div>
            } @else if (charts.topPackagesBlocked.length === 0) {
              <app-empty-state icon="block" title="Nothing blocked in this range" [compact]="true" />
            } @else {
              <app-top-packages-chart [data]="charts.topPackagesBlocked" type="block" [maxCount]="max(charts.topPackagesBlocked)" />
            }
          </div>
        </section>

        <section class="dg-card xl:col-span-6">
          <div class="dg-card-header">
            <h2 class="dg-card-title"><span class="swatch" style="background: var(--success-solid)"></span>Top allowed</h2>
          </div>
          <div class="dg-card-body pt-2">
            @if (loading) {
              <div class="dg-loading"><span class="dg-spinner"></span></div>
            } @else if (charts.topPackagesAllowed.length === 0) {
              <app-empty-state icon="check_circle" title="Nothing allowed in this range" [compact]="true" />
            } @else {
              <app-top-packages-chart [data]="charts.topPackagesAllowed" type="allow" [maxCount]="max(charts.topPackagesAllowed)" />
            }
          </div>
        </section>
      </div>
    </div>
  `,
})
export class DashboardComponent implements OnInit {
  private readonly supported = new Set<string>(ECOSYSTEMS);
  private dashboard = inject(DashboardService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);
  private webhooks = inject(WebhookService);

  range: Range = '30d';
  loading = false;
  stats = { total: 0, allow: 0, block: 0 };
  charts: DashboardCharts = { topPackagesAllowed: [], topPackagesBlocked: [], byEcosystem: [] };
  disabledWebhooks: WebhookTarget[] = [];

  get ecosystemRows() {
    return this.charts.byEcosystem
      .filter((e) => this.supported.has(e.ecosystem) && e.total > 0)
      .sort((a, b) => b.total - a.total);
  }

  ngOnInit(): void {
    this.load();
    if (this.auth.isSecurity()) {
      this.webhooks.list().subscribe({
        next: (rows) => (this.disabledWebhooks = rows.filter((row) => row.disabledAutomatically)),
        error: () => (this.disabledWebhooks = []),
      });
    }
  }

  share(value: number): number {
    return this.stats.total > 0 ? value / this.stats.total : 0;
  }

  max(rows: { count: number }[]): number {
    return Math.max(1, ...rows.map((r) => r.count));
  }

  load(): void {
    this.loading = true;
    forkJoin({
      stats: this.dashboard.getStats(this.range),
      charts: this.dashboard.getCharts(this.range),
    }).subscribe({
      next: ({ stats, charts }) => {
        this.stats = stats;
        this.charts = charts;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load analytics');
      },
    });
  }
}
