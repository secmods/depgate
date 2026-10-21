import { ChangeDetectionStrategy, Component, Input, OnInit, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { EventsService, EventsStatus } from '../services/events.service';

/**
 * The upgrade banners of the Decision Ledger and Audit Log (requirements_event_streaming.md §5.4, §5.5):
 * the background copy of older entries, and what the first retention purge will delete.
 */
@Component({
  selector: 'app-event-banners',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status(); as s) {
      @if (s.migration) {
        <div class="dg-callout mb-3" data-testid="events-copy-banner">
          <span class="material-symbols-outlined" aria-hidden="true">sync</span>
          <div>Copying older entries: {{ s.migration.percent }}%. Older periods fill in as it runs.</div>
        </div>
      }
      @if (purgeOf(s); as purge) {
        <div class="dg-callout is-warning mb-3" data-testid="events-purge-banner">
          <span class="material-symbols-outlined" aria-hidden="true">auto_delete</span>
          <div>
            On {{ purge.date | date: 'MMM d, y' }}, {{ purge.entries | number }} entries older than {{ purge.days }} days will be deleted.
            Set <code class="dg-inline-code">{{ purge.setting }}=0</code> to keep them.
          </div>
        </div>
      }
    }
  `,
})
export class EventBannersComponent implements OnInit {
  @Input({ required: true }) kind: 'ledger' | 'audit' = 'ledger';
  status = signal<EventsStatus | null>(null);
  private events = inject(EventsService);

  ngOnInit(): void {
    this.events.status().subscribe({ next: (s) => this.status.set(s), error: () => undefined });
  }

  purgeOf(s: EventsStatus): { date: string; entries: number; days: number; setting: string } | null {
    const part = this.kind === 'ledger' ? s.purge?.ledger : s.purge?.audit;
    if (!s.purge || !part?.entries) return null;
    return {
      date: s.purge.date,
      entries: part.entries,
      days: part.retentionDays,
      setting: this.kind === 'ledger' ? 'LEDGER_RETENTION_DAYS' : 'AUDIT_RETENTION_DAYS',
    };
  }
}
