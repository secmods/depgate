import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import { Subject, Subscription, debounceTime, switchMap, of, catchError } from 'rxjs';
import { NamespaceCheck, NamespaceRemote, NamespaceService } from '../../services/namespace.service';
import { ecosystemLabel } from '../../shared/status';
import { NAMESPACE_EXAMPLES, NAMESPACE_HINTS, NAMESPACE_TIPS } from './policy-rules';

/** Shown, and blocks saving, when internal remotes exist but none is ticked. */
export const NO_REMOTE_TICKED = 'Select at least one remote to download these names from.';

/**
 * The Namespace protection rule's fields in the policy form. Two questions: which package names are
 * yours, and which remotes may serve them (by default every internal remote; a public registry only
 * where you own the namespace). Exceptions and "Test a name" are optional and folded away; Go also
 * gets the GONOSUMDB value.
 */
@Component({
  selector: 'app-namespace-rule',
  standalone: true,
  imports: [FormsModule, NgbTooltipModule],
  template: `
    @if (ecosystem) {
      <p class="ns-intro" data-testid="ns-intro">Only the selected remotes may serve these names, so look-alikes elsewhere can't be installed.</p>

      <div class="dg-field">
        <label class="form-label" for="ns-reserved-input">Your package names</label>
        <div class="tag-box" data-testid="ns-reserved">
          @for (tag of reserved; track tag) {
            <span class="dg-chip gap-1" [class.dg-chip-danger]="errorOf(tag)" [title]="errorOf(tag) || tag" [attr.data-testid]="'ns-reserved-tag-' + tag">
              {{ tag }}
              <button type="button" class="tag-remove" [attr.aria-label]="'Remove ' + tag" (click)="removeReserved(tag)">
                <span class="material-symbols-outlined">close</span>
              </button>
            </span>
          }
          <input id="ns-reserved-input" class="tag-input" [(ngModel)]="draft" (ngModelChange)="draftChanged($event)"
            (keydown.enter)="addReserved(); $event.preventDefault()" (keydown)="onSeparator($event, 'reserved')" (blur)="addReserved()"
            [placeholder]="placeholder" autocomplete="off" data-testid="ns-reserved-input" />
        </div>
        @if (draftError) {
          <span class="dg-form-help text-danger d-block" data-testid="ns-draft-error">{{ draftError }}</span>
        }
        @for (row of tagErrors; track row.pattern) {
          <span class="dg-form-help text-danger d-block" data-testid="ns-pattern-error">{{ row.pattern }}: {{ row.error }}</span>
        }
        <span class="dg-form-help d-block" data-testid="ns-hint">
          {{ hint }}
          @if (tip) {
            <span class="material-symbols-outlined ns-info" tabindex="0" role="img" [attr.aria-label]="tip" [ngbTooltip]="tip">info</span>
          }
        </span>
      </div>

      <div class="dg-field" data-testid="ns-remotes">
        <span class="form-label d-block" id="ns-remotes-label">Serve only from</span>
        @if (remotesLoading) {
          <span class="dg-form-help">Loading {{ ecoLabel }} remotes…</span>
        } @else {
          <div class="ns-remote-list" role="group" aria-labelledby="ns-remotes-label">
            <div class="ns-group" data-testid="ns-group-internal">Internal registries</div>
            @for (r of internalRemotes; track r.id) {
              <label class="ns-remote" [class.is-on]="ticked.includes(r.id)">
                <input class="form-check-input" type="checkbox" [checked]="ticked.includes(r.id)" (change)="toggleAllowed(r.id)"
                  [attr.data-testid]="'ns-allowed-' + r.key" />
                <span class="font-mono">{{ r.label }}</span>
                @if (ticked.includes(r.id) && r.looksPublic) {
                  <span class="dg-form-help text-danger" [attr.data-testid]="'ns-looks-public-' + r.key">looks like a public registry</span>
                }
              </label>
            } @empty {
              <span class="ns-none">None</span>
            }
            @if (publicRemotes.length) {
              <div class="ns-group" data-testid="ns-group-public">
                Public registries
                <span class="ns-group-note">Only where you own this namespace, e.g. an npm org scope, a NuGet reserved prefix or a verified Maven groupId.</span>
              </div>
              @for (r of publicRemotes; track r.id) {
                <label class="ns-remote" [class.is-on]="ticked.includes(r.id)">
                  <input class="form-check-input" type="checkbox" [checked]="ticked.includes(r.id)" (change)="toggleAllowed(r.id)"
                    [attr.data-testid]="'ns-allowed-' + r.key" />
                  <span class="font-mono">{{ r.label }}</span>
                </label>
              }
            }
          </div>
          @if (servingRemotes.length > 0 && allowedRemotes.length === 0) {
            <span class="dg-form-help d-block" data-testid="ns-default-help">Default: every internal remote, including ones added later.</span>
          }
          @if (servingRemotes.length === 0) {
            <div class="dg-callout is-warning mt-2" data-testid="ns-no-internal">
              <span class="material-symbols-outlined" aria-hidden="true">warning</span>
              <div>
                @if (internalIds.length) {
                  {{ noRemoteTicked }}
                } @else {
                  No internal {{ ecoLabel }} registries: these names will be blocked. Add one under Settings → Repositories, or select a
                  public registry where you own this namespace.
                }
              </div>
            </div>
          }
        }
      </div>

      @if (ecosystem === 'go' && goNoSumDb) {
        <div class="ns-go" data-testid="ns-gonosumdb">
          <span class="ns-go-label">Go clients:</span>
          <code class="dg-inline-code">GONOSUMDB={{ goNoSumDb }}</code>
          <span class="material-symbols-outlined ns-info" tabindex="0" role="img" aria-label="Why GONOSUMDB"
            ngbTooltip="Stops go from asking sum.golang.org about these paths, which leaks them and fails for internal modules. Not GOPRIVATE: it also sets GONOPROXY, which would make go skip DepGate.">info</span>
        </div>
      }

      @if (showPublic || publicPackages.length > 0) {
        <div class="dg-field" data-testid="ns-public">
          <label class="form-label" for="ns-public-input">Exceptions: allow from any remote</label>
          <div class="tag-box">
            @for (tag of publicPackages; track tag) {
              <span class="dg-chip gap-1">
                {{ tag }}
                <button type="button" class="tag-remove" [attr.aria-label]="'Remove ' + tag" (click)="removePublic(tag)">
                  <span class="material-symbols-outlined">close</span>
                </button>
              </span>
            }
            <input id="ns-public-input" class="tag-input" [(ngModel)]="publicDraft" (keydown.enter)="addPublic(); $event.preventDefault()"
              (keydown)="onSeparator($event, 'public')" (blur)="addPublic()" [placeholder]="publicPlaceholder" autocomplete="off" />
          </div>
          <span class="dg-form-help d-block">Names you publish publicly on purpose, e.g. a lint config.</span>
        </div>
      }

      <div class="ns-links">
        @if (!showPublic && publicPackages.length === 0) {
          <button type="button" class="ns-link" data-testid="ns-public-toggle" (click)="showPublic = true">
            <span class="material-symbols-outlined" aria-hidden="true">add</span>Add exceptions
          </button>
        }
        @if (!showTry) {
          <button type="button" class="ns-link" data-testid="ns-try-toggle" (click)="showTry = true">
            <span class="material-symbols-outlined" aria-hidden="true">science</span>Test a name
          </button>
        }
      </div>

      @if (showTry) {
        <div class="ns-panel" data-testid="ns-try">
          <label class="dg-section-label mb-1 d-block" for="ns-try-input">Test a name</label>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <input id="ns-try-input" class="form-control form-control-sm" style="max-width: 280px" [(ngModel)]="tryNameText" [placeholder]="tryPlaceholder"
              data-testid="ns-try-input" (keydown.enter)="tryName(); $event.preventDefault()" />
            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" data-testid="ns-try-button" (click)="tryName()"
              [disabled]="!tryNameText.trim() || reserved.length === 0 || trying">Check</button>
          </div>
          <span class="dg-form-help d-block mt-1">Uses your unsaved settings.</span>
          @if (tryError) {
            <span class="dg-form-help text-danger d-block mt-1" data-testid="ns-try-error">{{ tryError }}</span>
          }
          @if (tryResult; as r) {
            <div class="mt-2" data-testid="ns-try-result">
              <span class="dg-chip" [class.dg-chip-success]="r.outcome === 'internal'" [class.dg-chip-danger]="r.outcome === 'blocked'"
                [class.dg-chip-warning]="r.outcome === 'monitor'">{{ outcomeLabel(r) }}</span>
              @if (r.reason) { <span class="dg-form-help d-block mt-1" data-testid="ns-try-reason">{{ r.reason }}</span> }
            </div>
          }
        </div>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .ns-intro { margin: 0 0 12px; font-size: 0.8125rem; color: var(--color-on-surface-variant); }
    .tag-box {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      min-height: 40px; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius);
    }
    .tag-input { flex: 1 1 160px; min-width: 120px; border: 0; outline: none; background: transparent; font-size: 0.875rem; }
    .tag-remove { display: inline-grid; place-items: center; padding: 0; border: none; background: transparent; color: inherit; opacity: 0.6; cursor: pointer; }
    .tag-remove:hover { opacity: 1; }
    .tag-remove .material-symbols-outlined { font-size: 14px; }
    .ns-remote-list { display: grid; border: 1px solid var(--color-border); border-radius: var(--radius); overflow: hidden; }
    .ns-remote {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; padding: 8px 12px; cursor: pointer;
      font-size: 0.875rem; border-top: 1px solid var(--color-border);
    }
    .ns-remote:first-child { border-top: 0; }
    .ns-remote .form-check-input { margin: 0; }
    .ns-remote.is-on { background: var(--brand-soft, var(--color-surface-container-low)); }
    .ns-group {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; padding: 6px 12px; border-top: 1px solid var(--color-border);
      background: var(--color-surface-container-low); font-size: 0.75rem; font-weight: 600; color: var(--color-on-surface-variant);
    }
    .ns-group:first-child { border-top: 0; }
    .ns-group-note { font-weight: 400; color: var(--color-muted); }
    .ns-none { padding: 8px 12px; border-top: 1px solid var(--color-border); font-size: 0.8125rem; color: var(--color-muted); }
    .ns-info { font-size: 15px; vertical-align: -3px; color: var(--color-muted); cursor: help; }
    .ns-info:hover, .ns-info:focus-visible { color: var(--brand-text); outline: none; }
    .ns-go { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -4px 0 12px; font-size: 0.8125rem; }
    .ns-go-label { font-weight: 600; color: var(--color-on-surface); }
    .ns-links { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 4px; }
    .ns-link {
      display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none;
      color: var(--brand-text); font-size: 0.8125rem; cursor: pointer;
    }
    .ns-link:hover { text-decoration: underline; }
    .ns-link .material-symbols-outlined { font-size: 16px; }
    .ns-panel { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface-container-low); }
  `],
})
export class NamespaceRuleComponent implements OnChanges, OnDestroy {
  @Input() ecosystem = '';
  @Input() reserved: string[] = [];
  @Input() publicPackages: string[] = [];
  @Input() mode: 'enforce' | 'monitor' = 'enforce';
  @Input() repositoryIds: string[] = [];
  /** Remote IDs allowed to serve the names (R6); empty for every internal remote. */
  @Input() allowedRemotes: string[] = [];
  @Output() allowedRemotesChange = new EventEmitter<string[]>();
  @Output() reservedChange = new EventEmitter<string[]>();
  @Output() publicPackagesChange = new EventEmitter<string[]>();
  /** Why the rule cannot be saved (invalid names, no remote ticked); empty when it can. */
  @Output() errorsChange = new EventEmitter<string[]>();
  /** Keys of the remotes that would serve the names, for the review sentence. */
  @Output() internalRemotesChange = new EventEmitter<string[]>();

  readonly noRemoteTicked = NO_REMOTE_TICKED;
  draft = '';
  draftError = '';
  publicDraft = '';
  tagErrors: Array<{ pattern: string; error: string }> = [];
  remotes: NamespaceRemote[] = [];
  remotesLoading = false;
  goNoSumDb = '';
  /** IDs of the ticked remotes. Saved as `allowedRemotes`, or as [] when they are exactly the internal remotes. */
  ticked: string[] = [];
  showPublic = false;
  showTry = false;
  tryNameText = '';
  tryResult: NamespaceCheck | null = null;
  tryError = '';
  trying = false;

  private namespaces = inject(NamespaceService);
  private draftChecks = new Subject<string>();
  private subscription: Subscription;
  /** The array last emitted, so its echo through the parent's binding does not reset the ticks. */
  private emitted: string[] | null = null;

  constructor() {
    this.subscription = this.draftChecks
      .pipe(
        debounceTime(250),
        switchMap((value) =>
          value.trim() && this.ecosystem
            ? this.namespaces.validate(this.ecosystem, [value.trim()]).pipe(catchError(() => of(null)))
            : of(null)
        )
      )
      .subscribe((res) => (this.draftError = res?.results[0]?.error ?? ''));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['ecosystem']) {
      this.loadRemotes();
      this.tryResult = null;
    } else if (changes['allowedRemotes'] && this.allowedRemotes !== this.emitted) {
      this.resetTicks();
    }
    if (changes['ecosystem'] || changes['reserved']) this.validateTags();
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  get placeholder(): string {
    return `e.g. ${NAMESPACE_EXAMPLES[this.ecosystem] ?? ''}`;
  }

  get publicPlaceholder(): string {
    const first = (NAMESPACE_EXAMPLES[this.ecosystem] ?? '').split(',')[0].trim().replace(/\*$/, 'eslint-config');
    return first ? `e.g. ${first.startsWith('@') ? `${first}/eslint-config` : first}` : '';
  }

  get tryPlaceholder(): string {
    const first = (NAMESPACE_EXAMPLES[this.ecosystem] ?? '').split(',')[0].trim().replace(/\*$/, 'billing');
    return first ? `e.g. ${first.startsWith('@') ? `${first}/billing` : first}` : 'Package name';
  }

  get hint(): string {
    return NAMESPACE_HINTS[this.ecosystem] ?? '';
  }

  get tip(): string {
    return NAMESPACE_TIPS[this.ecosystem] ?? '';
  }

  get ecoLabel(): string {
    return ecosystemLabel(this.ecosystem);
  }

  get enabledRemotes(): NamespaceRemote[] {
    return this.remotes.filter((r) => r.isEnabled);
  }

  get internalRemotes(): NamespaceRemote[] {
    return this.enabledRemotes.filter((r) => r.source === 'internal');
  }

  get publicRemotes(): NamespaceRemote[] {
    return this.enabledRemotes.filter((r) => r.source !== 'internal');
  }

  get internalIds(): string[] {
    return this.internalRemotes.map((r) => r.id);
  }

  /** The remotes that will serve the names. */
  get servingRemotes(): NamespaceRemote[] {
    return this.enabledRemotes.filter((r) => this.ticked.includes(r.id));
  }

  /** The remotes never asked for the names. */
  get skippedRemotes(): NamespaceRemote[] {
    return this.enabledRemotes.filter((r) => !this.ticked.includes(r.id));
  }

  toggleAllowed(id: string): void {
    this.ticked = this.ticked.includes(id) ? this.ticked.filter((x) => x !== id) : [...this.ticked, id];
    const internal = this.internalIds;
    // Exactly the internal remotes is saved as the default, so internal remotes added later serve the names too.
    const sameAsDefault = internal.length > 0 && internal.length === this.ticked.length && internal.every((x) => this.ticked.includes(x));
    this.emitted = sameAsDefault ? [] : [...this.ticked];
    this.allowedRemotes = this.emitted;
    this.allowedRemotesChange.emit(this.emitted);
    this.emitRemotes();
    this.tryResult = null;
  }

  errorOf(tag: string): string {
    return this.tagErrors.find((row) => row.pattern === tag)?.error ?? '';
  }

  draftChanged(value: string): void {
    this.draftError = '';
    this.draftChecks.next(value);
  }

  onSeparator(event: KeyboardEvent, which: 'reserved' | 'public'): void {
    if (event.key !== ',' && event.key !== ' ') return;
    event.preventDefault();
    if (which === 'reserved') this.addReserved();
    else this.addPublic();
  }

  addReserved(): void {
    const values = splitTags(this.draft).filter((value) => !this.reserved.includes(value));
    this.draft = '';
    this.draftError = '';
    if (values.length === 0) return;
    this.reserved = [...this.reserved, ...values];
    this.reservedChange.emit(this.reserved);
    this.validateTags();
  }

  removeReserved(tag: string): void {
    this.reserved = this.reserved.filter((item) => item !== tag);
    this.reservedChange.emit(this.reserved);
    this.validateTags();
  }

  addPublic(): void {
    const values = splitTags(this.publicDraft).filter((value) => !this.publicPackages.includes(value));
    this.publicDraft = '';
    if (values.length === 0) return;
    this.publicPackages = [...this.publicPackages, ...values];
    this.publicPackagesChange.emit(this.publicPackages);
  }

  removePublic(tag: string): void {
    this.publicPackages = this.publicPackages.filter((item) => item !== tag);
    this.publicPackagesChange.emit(this.publicPackages);
  }

  outcomeLabel(result: NamespaceCheck): string {
    switch (result.outcome) {
      case 'internal':
        return `Downloaded only from ${(result.servingRemotes ?? result.internalRemotes).join(', ')}`;
      case 'blocked':
        return 'Blocked: no remote may serve it';
      case 'monitor':
        return 'Would be blocked from other remotes (monitor only)';
      default:
        return 'Allowed: not one of your names';
    }
  }

  tryName(): void {
    const name = this.tryNameText.trim();
    if (!this.ecosystem || !name || this.reserved.length === 0) return;
    this.trying = true;
    this.tryError = '';
    this.namespaces
      .tryName({
        ecosystem: this.ecosystem,
        name,
        repository: 'all',
        reservedNamespaces: this.reserved,
        publicPackages: this.publicPackages,
        allowedRemotes: this.allowedRemotes,
        mode: this.mode,
        repositoryIds: this.repositoryIds,
      })
      .subscribe({
        next: (result) => {
          this.tryResult = result;
          this.trying = false;
        },
        error: (err) => {
          this.tryResult = null;
          this.tryError = err.error?.error ?? 'Check failed';
          this.trying = false;
        },
      });
  }

  /** Ticks from the saved value: the chosen remotes, or every internal remote. */
  private resetTicks(): void {
    const enabled = new Set(this.enabledRemotes.map((r) => r.id));
    this.ticked = this.allowedRemotes.length ? this.allowedRemotes.filter((id) => enabled.has(id)) : this.internalIds;
    this.emitRemotes();
  }

  private emitRemotes(): void {
    this.internalRemotesChange.emit(this.servingRemotes.map((r) => r.key));
    this.emitErrors();
  }

  private emitErrors(): void {
    const errors = this.tagErrors.map((row) => `${row.pattern}: ${row.error}`);
    if (this.ecosystem && !this.remotesLoading && this.ticked.length === 0 && this.internalIds.length > 0) errors.push(NO_REMOTE_TICKED);
    this.errorsChange.emit(errors);
  }

  private loadRemotes(): void {
    this.remotes = [];
    this.ticked = [];
    if (!this.ecosystem) {
      this.internalRemotesChange.emit([]);
      return;
    }
    this.remotesLoading = true;
    this.namespaces.remotes(this.ecosystem).subscribe({
      next: (rows) => {
        this.remotes = rows;
        this.remotesLoading = false;
        this.resetTicks();
      },
      error: () => {
        this.remotesLoading = false;
        this.internalRemotesChange.emit([]);
      },
    });
  }

  private validateTags(): void {
    if (!this.ecosystem || this.reserved.length === 0) {
      this.tagErrors = [];
      this.goNoSumDb = '';
      this.emitErrors();
      return;
    }
    this.namespaces.validate(this.ecosystem, this.reserved).subscribe({
      next: (res) => {
        this.tagErrors = res.results.filter((row): row is { pattern: string; error: string } => !!row.error);
        this.goNoSumDb = res.goNoSumDb ?? '';
        this.emitErrors();
      },
      error: () => this.emitErrors(),
    });
  }
}

function splitTags(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
