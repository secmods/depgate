import { Component, EventEmitter, Input, OnChanges, OnInit, Output, SimpleChanges, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PackageRepositoryRow, RepositoryService } from '../services/repository.service';
import { ecosystemLabel } from './status';
import { droppedByEcosystem, repositoryLabel, selectableRepositories } from './repository-scope';

/**
 * "Applies to": every repository, or the chosen ones. Used by the policy form and by the
 * exception and waiver dialogs. Emits the chosen IDs; an empty list means every repository.
 */
@Component({
  selector: 'app-repository-scope',
  standalone: true,
  imports: [FormsModule],
  template: `
    <fieldset class="dg-field scope-field" [attr.data-testid]="idPrefix + '-scope'">
      <legend class="form-label">Applies to</legend>
      <div class="scope-modes" role="radiogroup" aria-label="Applies to">
        <label class="form-check">
          <input class="form-check-input" type="radio" [name]="idPrefix + '-scope-mode'" value="all"
            [checked]="mode === 'all'" (change)="setMode('all')" [attr.data-testid]="idPrefix + '-scope-all'" />
          <span class="form-check-label">All repositories</span>
        </label>
        <label class="form-check">
          <input class="form-check-input" type="radio" [name]="idPrefix + '-scope-mode'" value="selected"
            [checked]="mode === 'selected'" (change)="setMode('selected')" [attr.data-testid]="idPrefix + '-scope-selected'" />
          <span class="form-check-label">Selected repositories</span>
        </label>
      </div>

      @if (mode === 'selected') {
        @if (loading) {
          <span class="dg-form-help">Loading repositories…</span>
        } @else if (options.length === 0) {
          <span class="dg-form-help text-danger">No repositories for {{ ecosystemsText }}.</span>
        } @else {
          <div class="scope-list" [attr.data-testid]="idPrefix + '-scope-list'">
            @for (group of groups; track group.ecosystem + group.kind) {
              <div class="scope-group">
                {{ groups.length > 2 ? ecoLabel(group.ecosystem) + ' · ' : '' }}{{ group.kind === 'remote' ? 'Sources (remotes)' : 'Team entry points (virtual)' }}
              </div>
              @for (row of group.rows; track row.id) {
                <label class="scope-option" [class.is-selected]="isSelected(row.id)">
                  <input type="checkbox" class="form-check-input" [checked]="isSelected(row.id)" (change)="toggle(row.id)"
                    [attr.data-testid]="idPrefix + '-scope-repo-' + row.ecosystem + '-' + row.key"
                    [attr.aria-label]="label(row)" />
                  <span class="scope-key">{{ label(row) }}</span>
                  @if (row.type === 'remote') {
                    <span class="dg-chip" [class.dg-chip-accent]="row.source === 'internal'">{{ row.source === 'internal' ? 'internal' : 'public' }}</span>
                  }
                  @if (row.description) {
                    <span class="scope-desc">{{ row.description }}</span>
                  }
                </label>
              }
            }
          </div>
          @if (selectedIds.length === 0) {
            <span class="dg-form-help text-danger" [attr.data-testid]="idPrefix + '-scope-empty'">Select at least one repository.</span>
          }
        }
        @if (missingCount > 0) {
          <span class="dg-form-help text-danger" [attr.data-testid]="idPrefix + '-scope-missing'">
            {{ missingCount === 1 ? 'A repository it was limited to was deleted.' : missingCount + ' repositories it was limited to were deleted.' }}
            Select the repositories again.
          </span>
        }
        @if (dropped.length) {
          <span class="dg-form-help" [attr.data-testid]="idPrefix + '-scope-dropped'">
            Removed {{ droppedText }}: not in {{ ecosystemsText }}.
          </span>
        }
      }
      @if (help) {
        <span class="dg-form-help d-block">{{ help }}</span>
      } @else if (mode === 'selected') {
        <span class="dg-form-help d-block" [attr.data-testid]="idPrefix + '-scope-help'">{{ defaultHelp }}</span>
      }
    </fieldset>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    /* The fieldset is the host's only child, so .dg-field:last-child would drop its spacing. */
    :host { display: block; margin-bottom: 16px; }
    .scope-modes { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 6px; }
    .scope-list { display: grid; gap: 4px; max-height: 220px; overflow-y: auto; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius); }
    .scope-group { font-size: 0.75rem; font-weight: 600; color: var(--color-text-muted, #6b7280); text-transform: uppercase; padding: 4px 4px 0; }
    .scope-option { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; min-width: 0; }
    .scope-option:hover { background: var(--color-surface-hover, rgba(99, 102, 241, 0.06)); }
    .scope-option.is-selected { background: rgba(99, 102, 241, 0.08); }
    .scope-key { font-family: var(--font-mono, monospace); font-size: 0.8125rem; }
    .scope-desc { color: var(--color-text-muted, #6b7280); font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class RepositoryScopeComponent implements OnInit, OnChanges {
  /** Ecosystems the repositories must belong to; empty for every ecosystem. */
  @Input() ecosystems: string[] = [];
  @Input() selectedIds: string[] = [];
  /** IDs the server kept for repositories that were deleted. */
  @Input() missingCount = 0;
  @Input() idPrefix = 'scope';
  /** Shown below the choice; without one, a short note on remotes and virtuals appears once Selected is chosen. */
  @Input() help = '';
  readonly defaultHelp = 'Remote: its packages through any URL. Virtual: everything downloaded through it.';
  /** Repository key to preselect when nothing is chosen yet, e.g. the one Package check used. */
  @Input() prefillKey = '';
  /** Start in "Selected repositories" even with nothing chosen yet. */
  @Input() startSelected = false;
  @Output() selectedIdsChange = new EventEmitter<string[]>();
  /** `all`, or `selected` (which needs at least one repository before saving). */
  @Output() modeChange = new EventEmitter<'all' | 'selected'>();
  /** `npm/prod` labels of the chosen repositories, for review sentences. */
  @Output() labelsChange = new EventEmitter<string[]>();

  private repositoryService = inject(RepositoryService);
  mode: 'all' | 'selected' = 'all';
  loading = true;
  repositories: PackageRepositoryRow[] = [];
  dropped: PackageRepositoryRow[] = [];

  ngOnInit(): void {
    this.mode = this.selectedIds.length > 0 || this.missingCount > 0 || this.startSelected ? 'selected' : 'all';
    this.repositoryService.list().subscribe({
      next: (rows) => {
        this.repositories = rows.filter((row) => row.isEnabled || this.selectedIds.includes(row.id));
        this.loading = false;
        this.dropUnselectable();
        this.applyPrefill();
        // Keep the caller's labels when the list does not hold every chosen repository.
        const labels = this.selectedLabels();
        if (labels.length === this.selectedIds.length) this.labelsChange.emit(labels);
      },
      error: () => (this.loading = false),
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['ecosystems'] && !changes['ecosystems'].firstChange) this.dropUnselectable();
  }

  get options(): PackageRepositoryRow[] {
    return selectableRepositories(this.repositories, this.ecosystems);
  }

  /** Sources (remotes) first, then team entry points (custom virtuals), per ecosystem. */
  get groups(): Array<{ ecosystem: string; kind: 'remote' | 'virtual'; rows: PackageRepositoryRow[] }> {
    const out: Array<{ ecosystem: string; kind: 'remote' | 'virtual'; rows: PackageRepositoryRow[] }> = [];
    const ordered = [...this.options].sort((a, b) => (a.type === b.type ? 0 : a.type === 'remote' ? -1 : 1));
    for (const row of ordered) {
      const kind = row.type === 'remote' ? 'remote' : 'virtual';
      const group = out.find((g) => g.ecosystem === row.ecosystem && g.kind === kind);
      if (group) group.rows.push(row);
      else out.push({ ecosystem: row.ecosystem, kind, rows: [row] });
    }
    return out.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || (a.kind === 'remote' ? -1 : 1));
  }

  get droppedText(): string {
    return this.dropped.map((row) => this.label(row)).join(', ');
  }

  get ecosystemsText(): string {
    return this.ecosystems.length ? this.ecosystems.map(ecosystemLabel).join(', ') : 'any ecosystem';
  }

  label(row: PackageRepositoryRow): string {
    return repositoryLabel(row);
  }

  ecoLabel(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  isSelected(id: string): boolean {
    return this.selectedIds.includes(id);
  }

  setMode(mode: 'all' | 'selected'): void {
    this.mode = mode;
    this.modeChange.emit(mode);
    if (mode === 'all') this.emit([]);
  }

  toggle(id: string): void {
    this.emit(this.isSelected(id) ? this.selectedIds.filter((x) => x !== id) : [...this.selectedIds, id]);
  }

  private dropUnselectable(): void {
    if (this.loading) return;
    const dropped = droppedByEcosystem(this.repositories, this.selectedIds, this.ecosystems);
    this.dropped = dropped;
    if (dropped.length) this.emit(this.selectedIds.filter((id) => !dropped.some((row) => row.id === id)));
  }

  private applyPrefill(): void {
    if (!this.prefillKey || this.selectedIds.length > 0) return;
    const row = this.options.find((option) => option.key === this.prefillKey);
    if (!row) return;
    this.mode = 'selected';
    this.modeChange.emit('selected');
    this.emit([row.id]);
  }

  private selectedLabels(): string[] {
    return this.repositories.filter((row) => this.selectedIds.includes(row.id)).map((row) => this.label(row));
  }

  private emit(ids: string[]): void {
    this.selectedIds = ids;
    this.selectedIdsChange.emit(ids);
    this.labelsChange.emit(this.selectedLabels());
  }
}
