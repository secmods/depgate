import { Component, HostListener, OnDestroy, inject, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  CatalogEvent,
  CatalogFeature,
  DestinationInput,
  DestinationType,
  EventCatalog,
  EventSelection,
  EventsService,
  StreamDestination,
  TestResult,
} from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { BreadcrumbService } from '../../services/breadcrumb.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';

type FieldDef = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  textarea?: boolean;
  /** Shown only when another field has this value. */
  when?: { field: string; value: string };
};

export const DESTINATION_TYPES: Array<{ type: DestinationType; label: string; mark: string; hint: string }> = [
  { type: 'splunk', label: 'Splunk', mark: 'Sp', hint: 'HTTP Event Collector' },
  { type: 'datadog', label: 'Datadog', mark: 'Dd', hint: 'Logs intake' },
  { type: 'elastic', label: 'Elastic / OpenSearch', mark: 'El', hint: '_bulk API, data stream' },
  { type: 'sumo', label: 'Sumo Logic', mark: 'Su', hint: 'HTTP Source' },
  { type: 'syslog', label: 'Syslog', mark: 'Sy', hint: 'TLS or TCP, JSON or CEF' },
  { type: 'http', label: 'HTTP', mark: 'Ht', hint: 'Any endpoint: Cribl, Vector, your API' },
  { type: 'jsonl', label: 'Container output', mark: '{}', hint: 'Standard output (stdout), for your collector' },
];

const CA_FIELD: FieldDef = {
  name: 'caCert',
  label: 'CA certificate (PEM)',
  textarea: true,
  placeholder: '-----BEGIN CERTIFICATE-----',
  help: 'Only for a SIEM whose certificate is signed by a private CA. TLS is always verified.',
};

const FIELDS: Record<DestinationType, FieldDef[]> = {
  splunk: [
    { name: 'url', label: 'URL', required: true, placeholder: 'https://splunk.example.com:8088', help: 'DepGate appends /services/collector/event.' },
    { name: 'token', label: 'HEC token', secret: true, required: true },
    { name: 'index', label: 'Index', placeholder: 'Token default' },
    { name: 'source', label: 'Source', placeholder: 'depgate' },
    { name: 'sourcetype', label: 'Sourcetype', placeholder: 'depgate:decision / depgate:audit / depgate:job', help: 'Leave empty for one sourcetype per category.' },
    CA_FIELD,
  ],
  datadog: [
    {
      name: 'site',
      label: 'Site',
      required: true,
      options: [
        { value: 'datadoghq.com', label: 'US1 (datadoghq.com)' },
        { value: 'us3.datadoghq.com', label: 'US3' },
        { value: 'us5.datadoghq.com', label: 'US5' },
        { value: 'datadoghq.eu', label: 'EU (datadoghq.eu)' },
        { value: 'ap1.datadoghq.com', label: 'AP1' },
        { value: 'ddog-gov.com', label: 'US1-FED (ddog-gov.com)' },
      ],
    },
    { name: 'apiKey', label: 'API key', secret: true, required: true },
    { name: 'service', label: 'Service', placeholder: 'depgate' },
    { name: 'tags', label: 'Tags', placeholder: 'env:prod,team:security' },
  ],
  elastic: [
    { name: 'url', label: 'URL', required: true, placeholder: 'https://elastic.example.com:9200', help: 'Cluster or Elastic Cloud endpoint. OpenSearch accepts the same requests.' },
    { name: 'authType', label: 'Authentication', required: true, options: [{ value: 'apikey', label: 'API key' }, { value: 'basic', label: 'Username and password' }] },
    { name: 'apiKey', label: 'API key', secret: true, when: { field: 'authType', value: 'apikey' } },
    { name: 'username', label: 'Username', when: { field: 'authType', value: 'basic' } },
    { name: 'password', label: 'Password', secret: true, when: { field: 'authType', value: 'basic' } },
    { name: 'index', label: 'Data stream or index', placeholder: 'logs-depgate.events-default' },
    CA_FIELD,
  ],
  sumo: [
    { name: 'url', label: 'HTTP Source URL', secret: true, required: true, help: 'The URL contains the token, so it is stored like a secret.' },
    { name: 'category', label: 'Source category', placeholder: 'depgate/{category}' },
  ],
  syslog: [
    { name: 'host', label: 'Host', required: true, placeholder: 'siem.example.com' },
    { name: 'port', label: 'Port', required: true, placeholder: '6514' },
    { name: 'transport', label: 'Transport', required: true, options: [{ value: 'tls', label: 'TLS (RFC 5425)' }, { value: 'tcp', label: 'TCP (RFC 6587 octet counting)' }] },
    { name: 'format', label: 'Format', required: true, options: [{ value: 'json', label: 'JSON (the full event)' }, { value: 'cef', label: 'CEF (QRadar, ArcSight)' }] },
    { name: 'facility', label: 'Facility', placeholder: 'local0' },
    { name: 'appName', label: 'App name', placeholder: 'depgate' },
    { ...CA_FIELD, when: { field: 'transport', value: 'tls' } },
  ],
  http: [
    { name: 'url', label: 'URL', required: true, placeholder: 'https://cribl.example.com:10080/ingest', help: 'Used exactly as entered.' },
    { name: 'method', label: 'Method', required: true, options: [{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }] },
    {
      name: 'format',
      label: 'Body format',
      required: true,
      options: [{ value: 'ndjson', label: 'NDJSON (one event per line)' }, { value: 'array', label: 'JSON array' }],
    },
    { name: 'gzip', label: 'Compression', required: true, options: [{ value: 'on', label: 'Gzip' }, { value: 'off', label: 'None' }] },
    CA_FIELD,
  ],
  jsonl: [],
};

/** One row of the HTTP destination's header list. A secret value is sent in `secrets` and never loaded back. */
type HeaderRow = { name: string; value: string; secret: boolean };

const MAX_HEADERS = 20;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
/** Set by DepGate itself (requirements_event_streaming.md §9.7 H2). */
const RESERVED_HEADERS = ['host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'user-agent'];

const DEFAULTS: Partial<Record<DestinationType, Record<string, string>>> = {
  datadog: { site: 'datadoghq.com' },
  elastic: { authType: 'apikey' },
  syslog: { transport: 'tls', format: 'json', port: '6514' },
  http: { method: 'POST', format: 'ndjson', gzip: 'on' },
};

type Preset = 'recommended' | 'everything' | 'clear' | 'custom';

const PRESET_LABELS: Record<Preset, string> = { recommended: 'Recommended', everything: 'Everything', clear: 'None', custom: 'Custom' };

/**
 * Settings → Log streaming → Add destination (`/settings/log-streaming/new`) and Edit
 * (`/settings/log-streaming/:id/edit`), requirements_event_streaming.md §10.4: the form on the left and,
 * always in view, a summary with the event count, Send test event and Create/Update on the right.
 * Cancel and Save return to the Log streaming tab.
 */
@Component({
  selector: 'app-stream-destination-form',
  standalone: true,
  imports: [FormsModule, DecimalPipe, EmptyStateComponent],
  styles: [`
    .sd-back {
      display: inline-flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 0.8125rem; font-weight: 600;
      color: var(--color-on-surface-variant); text-decoration: none; align-self: flex-start;
    }
    .sd-back .material-symbols-outlined { font-size: 18px; }
    .sd-back:hover { color: var(--brand-text); }
    .sd-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
    .sd-main { padding: 20px 24px; min-width: 0; }
    /* Below the app header (h-16, sticky). */
    .sd-aside { position: sticky; top: 80px; min-width: 0; }
    .sd-summary { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .sd-facts { margin: 0; }
    .sd-wrap { overflow-wrap: anywhere; }
    .sd-enabled-row label { margin: 0; cursor: pointer; }
    .sd-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .sd-test { width: 100%; justify-content: center; }
    .sd-test-result { margin: 0; }
    .sd-test-result pre { margin: 6px 0 0; max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; }
    .sd-next {
      display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--info-border); border-radius: var(--radius);
      background: var(--info-bg); font-size: 0.8125rem; line-height: 1.4; color: var(--color-on-surface);
    }
    .sd-next > .material-symbols-outlined { font-size: 16px; margin-top: 1px; color: var(--info-fg); }
    .sd-next-label { font-weight: 600; }
    .sd-next-link {
      padding: 0; border: 0; background: none; font: inherit; text-align: left; color: var(--brand-text);
      text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
    }
    .sd-link { padding: 0; border: 0; background: none; color: var(--brand-text); font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
    .sd-link:hover { text-decoration: underline; }
    .types { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
    .type-card {
      display: flex; gap: 10px; align-items: center; padding: 10px 12px; text-align: left;
      border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface);
      cursor: pointer; transition: border-color 0.12s, background 0.12s;
    }
    .type-card:hover:not(:disabled) { border-color: var(--brand); }
    .type-card.is-selected { border-color: var(--brand); background: var(--brand-soft); box-shadow: 0 0 0 1px var(--brand) inset; }
    .type-card:disabled { opacity: 0.5; cursor: not-allowed; }
    .type-chosen { cursor: default; width: 100%; }
    .type-chosen .type-text { flex: 1; min-width: 0; }
    .type-mark { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; flex-shrink: 0;
      background: var(--brand-soft-strong); color: var(--brand-text); font-weight: 700; font-size: 0.75rem; font-family: var(--font-mono); }
    .type-mark.is-sm { width: 24px; height: 24px; border-radius: 6px; font-size: 0.6875rem; }
    .type-name { font-size: 0.8125rem; font-weight: 600; line-height: 1.2; }
    .type-hint { font-size: 0.6875rem; color: var(--color-muted); line-height: 1.3; }
    .section-title { font-size: 0.8125rem; font-weight: 700; margin: 24px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-muted); }
    .section-title:first-child { margin-top: 0; }
    .hdr-row {
      display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto auto; grid-template-areas: 'name value secret remove';
      gap: 8px; align-items: center; margin-bottom: 6px;
    }
    .hdr-row > :nth-child(1) { grid-area: name; }
    .hdr-row > :nth-child(2) { grid-area: value; }
    .hdr-row > :nth-child(3) { grid-area: secret; }
    .hdr-row > :nth-child(4) { grid-area: remove; }
    /* Narrow screens: name and remove on the first line, value and Secret on the second. */
    @media (max-width: 575.98px) {
      .hdr-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'name remove' 'value secret'; padding-bottom: 6px; border-bottom: 1px solid var(--color-border); }
    }
    .hdr-secret { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 0.8125rem; cursor: pointer; white-space: nowrap; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0 16px; }
    .events-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
    .events-count { font-size: 0.75rem; color: var(--color-muted); margin-bottom: 8px; }
    .tree { border: 1px solid var(--color-border); border-radius: var(--radius); }
    .feature { border-bottom: 1px solid var(--color-border); }
    .feature:last-child { border-bottom: none; }
    .feature-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
    .feature-row .chev { border: none; background: none; padding: 0; color: var(--color-muted); display: inline-flex; cursor: pointer; }
    .feature-row .chev .material-symbols-outlined { transition: transform 0.15s; font-size: 18px; }
    .feature-row .chev.open .material-symbols-outlined { transform: rotate(90deg); }
    .feature-label { font-size: 0.8125rem; font-weight: 600; flex: 1; cursor: pointer; margin: 0; }
    .feature-tabs { font-weight: 400; color: var(--color-muted); }
    .feature-count { font-size: 0.75rem; color: var(--color-muted); font-variant-numeric: tabular-nums; }
    .group-label { display: flex; align-items: center; gap: 8px; padding: 6px 12px 2px 40px; font-size: 0.75rem; font-weight: 600; color: var(--color-on-surface-variant); }
    .event-row { display: flex; align-items: center; gap: 8px; padding: 4px 12px 4px 40px; font-size: 0.8125rem; }
    .event-row.in-group { padding-left: 62px; }
    .event-row label { margin: 0; cursor: pointer; display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
    .event-type { font-family: var(--font-mono); font-size: 0.6875rem; color: var(--color-muted); }
    .volume { font-size: 0.625rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 6px; border-radius: 4px;
      background: var(--warning-bg); color: var(--warning-fg); white-space: nowrap; }
    @media (max-width: 991.98px) {
      .sd-layout { grid-template-columns: minmax(0, 1fr); }
      .sd-main { padding: 16px; }
      /* On narrow screens the summary follows the form: the test result, Enabled and the buttons stay at the bottom. */
      .sd-aside { position: sticky; top: auto; bottom: 0; z-index: 5; }
      .sd-summary { border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: var(--shadow-md); }
      .sd-facts .dg-detail-row:not(.sd-enabled-row), .sd-summary > .dg-section-label { display: none; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page sd-page">
      <a class="sd-back" href="#" (click)="cancel(); $event.preventDefault()" data-testid="dest-back">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>Log streaming
      </a>
      <header class="dg-page-header">
        <div class="min-w-0">
          <h1 class="dg-page-title">{{ editing ? 'Edit destination' : 'Add destination' }}</h1>
          <p class="dg-page-subtitle">Send DepGate events to your SIEM. Delivery is batched and retried, and never slows downloads.</p>
        </div>
      </header>
      @if (loadError) {
        <section class="dg-card">
          <app-empty-state icon="search_off" title="Destination not found" [description]="loadError">
            <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()">Back to Log streaming</button>
          </app-empty-state>
        </section>
      } @else if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="sd-layout">
          <section class="dg-card sd-main" aria-label="Destination">
            <p class="section-title">1 · Type</p>
            @if (type && !typeGridOpen) {
              <div class="type-card is-selected type-chosen" data-testid="dest-type-chosen">
                <span class="type-mark">{{ typeInfo?.mark }}</span>
                <span class="type-text"><span class="type-name d-block">{{ typeInfo?.label }}</span><span class="type-hint">{{ typeInfo?.hint }}</span></span>
                @if (!editing) {
                  <button type="button" class="sd-link" (click)="typeGridOpen = true" aria-label="Change type" data-testid="dest-type-change">Change</button>
                }
              </div>
            } @else {
              <div class="types" role="radiogroup" aria-label="Destination type">
                @for (t of types; track t.type) {
                  <button type="button" class="type-card" role="radio" [class.is-selected]="type === t.type" [attr.aria-checked]="type === t.type"
                    [disabled]="t.type === 'jsonl' && hasJsonLines" (click)="pickType(t.type)" [attr.data-testid]="'dest-type-' + t.type"
                    [title]="t.type === 'jsonl' && hasJsonLines ? 'There is already a container output destination' : ''">
                    <span class="type-mark">{{ t.mark }}</span>
                    <span><span class="type-name d-block">{{ t.label }}</span><span class="type-hint">{{ t.hint }}</span></span>
                  </button>
                }
              </div>
            }

            <p class="section-title">2 · Connection</p>
            <div class="dg-field">
              <label class="form-label" for="dest-name">Name</label>
              <input id="dest-name" class="form-control" [(ngModel)]="name" maxlength="128" placeholder="Splunk production" autocomplete="off" data-testid="dest-name" />
            </div>
            @if (!type) {
              <span class="dg-form-help mt-0">Choose a type to see its connection settings.</span>
            }
            @if (type === 'jsonl') {
              <div class="dg-callout mb-2">
                <span class="material-symbols-outlined" aria-hidden="true">info</span>
                <div>Each replica writes events to standard output as JSON lines tagged <code class="dg-inline-code">"log": "depgate.event"</code>. Your collector (Fluent Bit, Vector, Splunk Universal Forwarder, Elastic Agent, Datadog Agent) must read <strong>every</strong> DepGate container. Works without Redis.</div>
              </div>
            }
            <div class="fields">
              @for (field of visibleFields; track field.name) {
                <div class="dg-field" [style.grid-column]="field.textarea ? '1 / -1' : null">
                  <label class="form-label" [for]="'dest-' + field.name">
                    {{ field.label }} @if (!field.required) { <span class="dg-optional">(optional)</span> }
                  </label>
                  @if (field.options) {
                    <select class="form-select" [id]="'dest-' + field.name" [(ngModel)]="settings[field.name]" [attr.data-testid]="'dest-' + field.name">
                      @for (o of field.options; track o.value) { <option [value]="o.value">{{ o.label }}</option> }
                    </select>
                  } @else if (field.secret) {
                    <input type="password" class="form-control" [id]="'dest-' + field.name" [(ngModel)]="secrets[field.name]" autocomplete="new-password"
                      [placeholder]="secretSet(field.name) ? 'Stored · leave empty to keep' : ''" [attr.data-testid]="'dest-' + field.name" />
                  } @else if (field.textarea) {
                    <textarea class="form-control font-mono text-xs" rows="3" [id]="'dest-' + field.name" [(ngModel)]="settings[field.name]" [placeholder]="field.placeholder ?? ''"></textarea>
                  } @else {
                    <input class="form-control" [id]="'dest-' + field.name" [(ngModel)]="settings[field.name]" [placeholder]="field.placeholder ?? ''" autocomplete="off" [attr.data-testid]="'dest-' + field.name" />
                  }
                  @if (field.help) { <span class="dg-form-help">{{ field.help }}</span> }
                </div>
              }
            </div>
            @if (type === 'http') {
              <div class="dg-field mt-2" data-testid="dest-headers">
                <span class="form-label d-block">Headers <span class="dg-optional">(optional)</span></span>
                @for (h of headers; track $index; let i = $index) {
                  <div class="hdr-row" [attr.data-testid]="'dest-header-' + i">
                    <input class="form-control font-mono" [id]="'dest-header-name-' + i" [(ngModel)]="h.name" placeholder="X-Api-Key" aria-label="Header name" autocomplete="off" />
                    <input class="form-control" [id]="'dest-header-value-' + i" [type]="h.secret ? 'password' : 'text'" [(ngModel)]="h.value" aria-label="Header value"
                      [placeholder]="h.secret && secretSet(headerKey(h.name)) ? 'Stored · leave empty to keep' : 'Value'" autocomplete="new-password" />
                    <label class="hdr-secret"><input type="checkbox" class="form-check-input m-0" [(ngModel)]="h.secret" [attr.aria-label]="'Secret value for header ' + (h.name || i + 1)" /> Secret</label>
                    <button type="button" class="dg-icon-btn" (click)="removeHeader(i)" [attr.aria-label]="'Remove header ' + (h.name || i + 1)" title="Remove header">
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  </div>
                  @if ((h.name || h.value) && headerError(h, i); as error) {
                    <span class="dg-form-help text-danger d-block mb-1">{{ error }}</span>
                  }
                }
                <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addHeader()" [disabled]="headers.length >= maxHeaders" data-testid="dest-header-add">
                  <span class="material-symbols-outlined">add</span> Add header
                </button>
                <span class="dg-form-help d-block">For example <code class="dg-inline-code">Authorization</code> or <code class="dg-inline-code">X-Api-Key</code>. Secret values are stored encrypted and never shown again.</span>
              </div>
              <div class="dg-callout mb-2">
                <span class="material-symbols-outlined" aria-hidden="true">info</span>
                <div>Sends batches of up to 500 events. For one alert per event (Slack, PagerDuty), use Webhooks.</div>
              </div>
            }
            @if (plainHttp) {
              <span class="dg-form-help text-warning d-block mb-2"><span class="material-symbols-outlined align-middle" style="font-size: 14px">warning</span> Events are sent unencrypted. Use https:// unless the network is private.</span>
            }

            <p class="section-title">3 · Events to send</p>
            <div class="events-bar">
              <select class="dg-select" [ngModel]="preset" (ngModelChange)="applyPreset($event)" aria-label="Preset" data-testid="dest-preset">
                <option value="recommended">Recommended</option>
                <option value="everything">Everything</option>
                <option value="clear">Clear</option>
                @if (preset === 'custom') { <option value="custom">Custom</option> }
              </select>
              <input class="dg-input" style="flex: 1; min-width: 180px" type="search" placeholder="Search events…" [(ngModel)]="search" aria-label="Search events" data-testid="dest-event-search" />
            </div>
            <div class="events-count" data-testid="dest-event-count">{{ selected.size }} of {{ allKeys.length }} events selected · {{ featuresTouched }} features</div>
            @if (catalog) {
              <div class="tree" data-testid="dest-event-tree">
                @for (f of visibleFeatures; track f.feature) {
                  <div class="feature">
                    <div class="feature-row">
                      <button type="button" class="chev" [class.open]="isOpen(f)" (click)="toggleOpen(f)" [attr.aria-label]="(isOpen(f) ? 'Collapse ' : 'Expand ') + f.label"><span class="material-symbols-outlined">chevron_right</span></button>
                      <input type="checkbox" class="form-check-input m-0" [id]="'feat-' + f.feature" [checked]="state(keysOf(f)) === 'all'" [indeterminate]="state(keysOf(f)) === 'some'"
                        (change)="setAll(keysOf(f), $any($event.target).checked)" [attr.data-testid]="'feature-' + f.feature" />
                      <label class="feature-label" [for]="'feat-' + f.feature">
                        {{ f.label }} @if (tabNames(f); as tabs) { <span class="feature-tabs">({{ tabs }})</span> }
                      </label>
                      <span class="feature-count">{{ countIn(keysOf(f)) }} of {{ keysOf(f).length }}</span>
                    </div>
                    @if (isOpen(f)) {
                      @for (g of f.groups; track $index) {
                        @if (g.tab && matching(g.events).length > 0) {
                          <div class="group-label">
                            <input type="checkbox" class="form-check-input m-0" [checked]="state(keysOfGroup(g.events)) === 'all'" [indeterminate]="state(keysOfGroup(g.events)) === 'some'"
                              (change)="setAll(keysOfGroup(g.events), $any($event.target).checked)" [attr.aria-label]="g.tab" />
                            {{ g.tab }}
                          </div>
                        }
                        @for (e of matching(g.events); track e.key) {
                          <div class="event-row" [class.in-group]="!!g.tab">
                            <label>
                              <input type="checkbox" class="form-check-input m-0" [checked]="selected.has(e.key)" (change)="toggle(e.key, $any($event.target).checked)" [attr.data-testid]="'event-' + e.key" />
                              <span>{{ e.label }}</span>
                              <span class="event-type">{{ e.key }}</span>
                            </label>
                            @if (e.highVolume) {
                              <span class="volume" [title]="'About ' + (volumeOf(e.type) | number) + ' events a day over the last 7 days'">High volume · ~{{ volumeOf(e.type) | number }}/day</span>
                            }
                          </div>
                        }
                      }
                    }
                  </div>
                } @empty {
                  <div class="p-3 dg-text-muted text-sm">No event matches “{{ search }}”.</div>
                }
              </div>
            } @else {
              <div class="dg-loading"><span class="dg-spinner"></span></div>
            }
          </section>

          <aside class="sd-aside" aria-label="Summary">
            <div class="dg-card sd-summary" data-testid="dest-summary-panel">
              <p class="dg-section-label mb-0">Summary</p>
              <div class="dg-detail-list sd-facts">
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Type</div>
                  <div class="dg-detail-value">
                    @if (typeInfo; as t) {
                      <span class="type-mark is-sm" aria-hidden="true">{{ t.mark }}</span> <span class="dg-detail-text">{{ t.label }}</span>
                    } @else {
                      <span class="dg-detail-text">Not chosen</span>
                    }
                  </div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Name</div>
                  <div class="dg-detail-value"><span class="dg-detail-text sd-wrap">{{ name.trim() || 'Not set' }}</span></div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Sends to</div>
                  <div class="dg-detail-value" data-testid="dest-summary-endpoint"><span class="dg-detail-text sd-wrap">{{ endpointSummary }}</span></div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Events</div>
                  <div class="dg-detail-value" data-testid="dest-summary-events">
                    <span class="dg-detail-text">{{ selected.size }} of {{ allKeys.length }} · {{ featuresTouched }} features</span>
                    <span class="dg-chip">{{ presetLabel }}</span>
                  </div>
                </div>
                <div class="dg-detail-row sd-enabled-row">
                  <div class="dg-detail-label"><label for="dest-enabled">Send events now</label></div>
                  <div class="dg-detail-value">
                    <button id="dest-enabled" type="button" class="dg-switch" role="switch" [class.is-on]="enabled" [attr.aria-checked]="enabled"
                      (click)="enabled = !enabled" data-testid="dest-enabled"></button>
                  </div>
                </div>
              </div>
              @if (plainHttp) {
                <div class="dg-callout is-warning m-0">
                  <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                  <div>Plain HTTP: events are sent unencrypted.</div>
                </div>
              }
              @if (highVolumeSelected !== null) {
                <div class="dg-callout is-warning m-0" data-testid="dest-summary-volume">
                  <span class="material-symbols-outlined" aria-hidden="true">speed</span>
                  <div>Includes high-volume events@if (highVolumeSelected > 0) {: about <strong>{{ highVolumeSelected | number }}</strong> a day at current traffic}.</div>
                </div>
              }

              <button type="button" class="dg-btn dg-btn-secondary sd-test" (click)="test()" [disabled]="!type || testing" data-testid="dest-test">
                @if (testing) { <span class="dg-spinner is-sm"></span> } @else { <span class="material-symbols-outlined">send</span> } Send test event
              </button>
              @if (testResult; as r) {
                <div class="dg-callout sd-test-result" [class.is-success]="r.ok" [class.is-danger]="!r.ok" role="status" data-testid="dest-test-result">
                  <span class="material-symbols-outlined" aria-hidden="true">{{ r.ok ? 'check_circle' : 'error' }}</span>
                  <div class="min-w-0">
                    <strong>{{ r.ok ? 'Test event delivered' : 'Test event not delivered' }}</strong>
                    @if (r.status) { · HTTP {{ r.status }} }
                    @if (r.reply || r.error) { <pre class="dg-code">{{ r.reply || r.error }}</pre> }
                  </div>
                </div>
              }

              @if (saveBlocker(); as blocker) {
                <div class="sd-next" role="status">
                  <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  <span><span class="sd-next-label">Next: </span><button type="button" class="sd-next-link" (click)="goToBlocker()"
                    data-testid="dest-save-blocker">{{ blocker }}</button></span>
                </div>
              }
              <div class="sd-actions">
                <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()" data-testid="dest-cancel">Cancel</button>
                <button type="button" class="dg-btn dg-btn-primary" (click)="save()" [disabled]="!canSave || saving" data-testid="dest-save">
                  {{ saving ? 'Saving…' : editing ? 'Update destination' : 'Create destination' }}
                </button>
              </div>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
})
export class StreamDestinationFormComponent implements OnDestroy {
  readonly types = DESTINATION_TYPES;
  readonly returnUrl = '/settings?tab=streaming';
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private events = inject(EventsService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private crumbs = inject(BreadcrumbService);

  /** The destination being edited; null for a new one. */
  destination: StreamDestination | null = null;
  /** Average events a day over the last 7 days, by decision type. */
  volume: Record<string, number> = {};
  /** Only one JSON lines destination is allowed. */
  hasJsonLines = false;
  type: DestinationType | null = null;
  /** Every type card is shown until one is picked; afterwards only the chosen one, with Change. */
  typeGridOpen = true;
  name = '';
  enabled = true;
  settings: Record<string, string> = {};
  secrets: Record<string, string> = {};
  /** HTTP destinations only (§9.7). */
  headers: HeaderRow[] = [];
  readonly maxHeaders = MAX_HEADERS;
  catalog: EventCatalog | null = null;
  selected = new Set<string>();
  preset: Preset = 'recommended';
  search = '';
  open = new Set<string>();
  saving = false;
  testing = false;
  testResult: TestResult | null = null;
  loading = true;
  loadError = '';
  private saved = false;
  private cleanState = '';

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    this.crumbs.detail.set(id ? 'Edit destination' : 'Add destination');
    this.events.destinations().subscribe({
      next: (list) => {
        this.volume = list.volume ?? {};
        const dest = id ? list.items.find((row) => row.id === id) ?? null : null;
        if (id && !dest) {
          this.loading = false;
          this.loadError = 'This destination no longer exists. It may have been deleted.';
          return;
        }
        this.hasJsonLines = list.items.some((row) => row.type === 'jsonl' && row.id !== dest?.id);
        if (dest) {
          this.destination = dest;
          this.type = dest.type;
          this.typeGridOpen = false;
          this.name = dest.name;
          this.enabled = dest.enabled;
          this.settings = { ...(DEFAULTS[dest.type] ?? {}), ...dest.settings };
          this.headers = parseHeaders(dest.settings['headers']);
        }
        this.loadCatalog();
      },
      error: (err) => {
        this.loading = false;
        this.loadError = err.error?.error ?? 'Could not load the destinations.';
      },
    });
  }

  ngOnDestroy(): void {
    this.crumbs.detail.set(null);
  }

  private loadCatalog(): void {
    this.events.catalog().subscribe({
      next: (catalog) => {
        this.catalog = catalog;
        if (this.destination) {
          this.selected = this.expand(this.destination.selection);
          this.preset = this.matchesPreset();
        } else {
          this.selected = this.expand(catalog.presets.recommended);
        }
        this.loading = false;
        this.markClean();
      },
      error: () => {
        this.loading = false;
        this.markClean();
        this.toast.error('Could not load the event catalog');
      },
    });
  }

  get editing(): boolean {
    return !!this.destination;
  }

  get typeInfo() {
    return DESTINATION_TYPES.find((t) => t.type === this.type) ?? null;
  }

  pickType(type: DestinationType): void {
    if (this.editing) return;
    const previous = this.typeInfo?.label;
    this.type = type;
    this.typeGridOpen = false;
    this.settings = { ...(DEFAULTS[type] ?? {}) };
    this.secrets = {};
    this.headers = [];
    this.testResult = null;
    // Name it after the type until the admin types their own.
    if (!this.name.trim() || this.name === previous) this.name = this.typeInfo?.label ?? '';
  }

  get visibleFields(): FieldDef[] {
    if (!this.type) return [];
    return FIELDS[this.type].filter((field) => !field.when || this.settings[field.when.field] === field.when.value);
  }

  headerKey(name: string): string {
    return `header:${name.trim().toLowerCase()}`;
  }

  addHeader(): void {
    if (this.headers.length < MAX_HEADERS) this.headers = [...this.headers, { name: '', value: '', secret: false }];
    setTimeout(() => document.getElementById(`dest-header-name-${this.headers.length - 1}`)?.focus());
  }

  removeHeader(index: number): void {
    this.headers = this.headers.filter((_, i) => i !== index);
  }

  /** The same rules as the server (§9.7 H2): a valid unique name DepGate does not set, and a value. */
  headerError(header: HeaderRow, index: number): string | null {
    const name = header.name.trim();
    if (!name) return 'Enter a header name';
    if (!HEADER_NAME.test(name)) return `${name} is not a valid header name`;
    if (RESERVED_HEADERS.includes(name.toLowerCase())) return `DepGate sets ${name} itself`;
    if (this.headers.some((other, i) => i < index && other.name.trim().toLowerCase() === name.toLowerCase())) return `Header ${name} is listed twice`;
    if (!header.value.trim() && !(header.secret && this.secretSet(this.headerKey(name)))) return `Enter the value of header ${name}`;
    if (/[\r\n]/.test(header.value)) return `The value of header ${name} cannot contain line breaks`;
    return null;
  }

  private firstHeaderError(): { index: number; error: string } | null {
    if (this.type !== 'http') return null;
    for (let i = 0; i < this.headers.length; i += 1) {
      const error = this.headerError(this.headers[i], i);
      if (error) return { index: i, error };
    }
    return null;
  }

  secretSet(name: string): boolean {
    return !!this.destination?.secrets?.[name]?.set;
  }

  get plainHttp(): boolean {
    return /^http:\/\//i.test(this.settings['url'] ?? '');
  }

  /** Where events go, in a few words, for the summary. */
  get endpointSummary(): string {
    const s = this.settings;
    switch (this.type) {
      case null:
        return 'Not set';
      case 'jsonl':
        return 'Standard output of every replica';
      case 'http': {
        const url = s['url']?.trim();
        if (!url) return 'Not set';
        let host = url;
        try {
          host = new URL(url).host;
        } catch {
          /* shown as typed */
        }
        return `${s['method'] || 'POST'} ${host}`;
      }
      case 'datadog':
        return s['site'] ? `Datadog ${s['site']}` : 'Not set';
      case 'sumo':
        return this.secrets['url']?.trim() || this.secretSet('url') ? 'HTTP Source URL (stored as a secret)' : 'Not set';
      case 'syslog':
        return s['host']?.trim() ? `${s['host'].trim()}:${s['port'] || '6514'} · ${(s['transport'] ?? 'tls').toUpperCase()} · ${(s['format'] ?? 'json').toUpperCase()}` : 'Not set';
      default: {
        const url = s['url']?.trim();
        if (!url) return 'Not set';
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      }
    }
  }

  /** What still stops Create/Update, in words; null when the form can be saved. */
  saveBlocker(): string | null {
    if (!this.type) return 'Choose a type';
    if (!this.name.trim()) return 'Enter a name';
    const missing = this.visibleFields.find((field) =>
      field.required && (field.secret ? !(this.secrets[field.name]?.trim() || this.secretSet(field.name)) : !this.settings[field.name]?.trim()),
    );
    if (missing) return `Fill in ${missing.label}`;
    return this.firstHeaderError()?.error ?? null;
  }

  goToBlocker(): void {
    if (!this.type) {
      this.typeGridOpen = true;
      setTimeout(() => document.querySelector<HTMLElement>('[data-testid^="dest-type-"]')?.focus());
      return;
    }
    if (!this.name.trim()) {
      document.getElementById('dest-name')?.focus();
      return;
    }
    const missing = this.visibleFields.find((field) =>
      field.required && (field.secret ? !(this.secrets[field.name]?.trim() || this.secretSet(field.name)) : !this.settings[field.name]?.trim()),
    );
    if (missing) {
      document.getElementById('dest-' + missing.name)?.focus();
      return;
    }
    const header = this.firstHeaderError();
    if (header) document.getElementById(`dest-header-${header.error.startsWith('Enter the value') ? 'value' : 'name'}-${header.index}`)?.focus();
  }

  get canSave(): boolean {
    return this.saveBlocker() === null;
  }

  /* ----- event selection ----- */

  get allKeys(): string[] {
    return (this.catalog?.features ?? []).flatMap((f) => this.keysOf(f));
  }

  keysOf(feature: CatalogFeature): string[] {
    return feature.groups.flatMap((g) => g.events.map((e) => e.key));
  }

  keysOfGroup(events: CatalogEvent[]): string[] {
    return events.map((e) => e.key);
  }

  tabNames(feature: CatalogFeature): string {
    const tabs = feature.groups.map((g) => g.tab).filter(Boolean);
    return tabs.length > 1 ? tabs.join(' · ') : '';
  }

  private expand(selection: EventSelection): Set<string> {
    const keys = new Set(selection.events);
    for (const f of this.catalog?.features ?? []) if (selection.features.includes(f.feature)) for (const key of this.keysOf(f)) keys.add(key);
    return keys;
  }

  /** Whole features are saved as features, so event types added to them later are included (§10.4). */
  private compact(): EventSelection {
    const features: string[] = [];
    const events: string[] = [];
    for (const f of this.catalog?.features ?? []) {
      const keys = this.keysOf(f);
      if (keys.every((key) => this.selected.has(key))) features.push(f.feature);
      else events.push(...keys.filter((key) => this.selected.has(key)));
    }
    return { features, events };
  }

  private matchesPreset(): Preset {
    if (!this.catalog) return 'custom';
    const same = (set: Set<string>) => set.size === this.selected.size && [...set].every((key) => this.selected.has(key));
    if (same(this.expand(this.catalog.presets.recommended))) return 'recommended';
    if (same(this.expand(this.catalog.presets.everything))) return 'everything';
    if (this.selected.size === 0) return 'clear';
    return 'custom';
  }

  get presetLabel(): string {
    return PRESET_LABELS[this.preset];
  }

  applyPreset(preset: Preset): void {
    if (!this.catalog || preset === 'custom') return;
    this.preset = preset;
    this.selected =
      preset === 'recommended' ? this.expand(this.catalog.presets.recommended) : preset === 'everything' ? this.expand(this.catalog.presets.everything) : new Set();
  }

  state(keys: string[]): 'all' | 'some' | 'none' {
    const n = this.countIn(keys);
    return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
  }

  countIn(keys: string[]): number {
    return keys.filter((key) => this.selected.has(key)).length;
  }

  get featuresTouched(): number {
    return (this.catalog?.features ?? []).filter((f) => this.countIn(this.keysOf(f)) > 0).length;
  }

  /** Events a day from the selected high-volume event types; null when none is selected. */
  get highVolumeSelected(): number | null {
    const types = new Set<string>();
    for (const f of this.catalog?.features ?? []) for (const g of f.groups) for (const e of g.events) if (e.highVolume && this.selected.has(e.key)) types.add(e.type);
    return types.size ? [...types].reduce((n, type) => n + this.volumeOf(type), 0) : null;
  }

  setAll(keys: string[], on: boolean): void {
    for (const key of keys) {
      if (on) this.selected.add(key);
      else this.selected.delete(key);
    }
    this.preset = this.matchesPreset();
  }

  toggle(key: string, on: boolean): void {
    this.setAll([key], on);
  }

  private matches(event: CatalogEvent, feature: CatalogFeature): boolean {
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    return event.label.toLowerCase().includes(q) || event.key.toLowerCase().includes(q) || feature.label.toLowerCase().includes(q);
  }

  matching(events: CatalogEvent[]): CatalogEvent[] {
    const q = this.search.trim().toLowerCase();
    if (!q) return events;
    const feature = this.catalog?.features.find((f) => f.groups.some((g) => g.events === events));
    return events.filter((e) => (feature ? this.matches(e, feature) : true));
  }

  get visibleFeatures(): CatalogFeature[] {
    const features = this.catalog?.features ?? [];
    if (!this.search.trim()) return features;
    return features.filter((f) => f.groups.some((g) => g.events.some((e) => this.matches(e, f))));
  }

  /** Search opens the groups that match. */
  isOpen(feature: CatalogFeature): boolean {
    return this.open.has(feature.feature) || !!this.search.trim();
  }

  toggleOpen(feature: CatalogFeature): void {
    if (this.open.has(feature.feature)) this.open.delete(feature.feature);
    else this.open.add(feature.feature);
  }

  volumeOf(type: string): number {
    return this.volume[type] ?? 0;
  }

  /* ----- leaving ----- */

  /** Whether the form differs from what was loaded (or from a blank form). */
  get dirty(): boolean {
    return !this.saved && !this.loading && !this.loadError && this.formState() !== this.cleanState;
  }

  /** For the route guard: true to leave, after asking when there are unsaved changes. */
  canLeave(): boolean | Promise<boolean> {
    if (!this.dirty) return true;
    return this.confirm.confirm({
      title: 'Discard changes?',
      message: this.editing ? 'Your changes to this destination have not been saved.' : 'This destination has not been added yet.',
      confirmText: 'Discard changes',
      tone: 'danger',
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty) event.preventDefault();
  }

  cancel(): void {
    void this.router.navigateByUrl(this.returnUrl);
  }

  private markClean(): void {
    this.cleanState = this.formState();
  }

  private formState(): string {
    return JSON.stringify([this.type, this.name, this.enabled, this.settings, this.secrets, this.headers, [...this.selected].sort()]);
  }

  /* ----- save and test ----- */

  private input(): DestinationInput {
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.secrets)) if (value?.trim()) secrets[key] = value.trim();
    const fieldNames = new Set(this.visibleFields.filter((f) => !f.secret).map((f) => f.name));
    const settings: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.settings)) if (fieldNames.has(key) && value?.trim()) settings[key] = value.trim();
    if (this.type === 'http') {
      // Secret values travel in `secrets` under `header:{name}`; left empty, the stored value is kept (§9.7 H3).
      settings['headers'] = JSON.stringify(
        this.headers.map((h) => (h.secret ? { name: h.name.trim(), secret: true } : { name: h.name.trim(), value: h.value.trim() })),
      );
      for (const h of this.headers) if (h.secret && h.value.trim()) secrets[this.headerKey(h.name)] = h.value.trim();
    }
    return {
      ...(this.destination ? { id: this.destination.id } : {}),
      name: this.name.trim(),
      type: this.type!,
      enabled: this.enabled,
      settings,
      secrets,
      selection: this.compact(),
    };
  }

  test(): void {
    if (!this.type) return;
    this.testing = true;
    this.testResult = null;
    const request = this.input();
    this.events.testUnsaved({ ...request, name: request.name || 'Test' }).subscribe({
      next: (result) => {
        this.testing = false;
        this.testResult = result;
      },
      error: (err) => {
        this.testing = false;
        this.testResult = { ok: false, status: null, reply: '', error: err.error?.error ?? 'The test could not be sent' };
      },
    });
  }

  save(): void {
    if (!this.canSave || this.saving) return;
    this.saving = true;
    const input = this.input();
    const request = this.destination ? this.events.updateDestination(this.destination.id, input) : this.events.createDestination(input);
    request.subscribe({
      next: () => {
        this.toast.success(this.editing ? 'Destination saved' : 'Destination added');
        this.saved = true;
        void this.router.navigateByUrl(this.returnUrl);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Could not save the destination');
      },
    });
  }
}

/** The stored header list of an HTTP destination; secret values are never loaded. */
function parseHeaders(raw: string | undefined): HeaderRow[] {
  try {
    const list = JSON.parse(raw || '[]') as Array<{ name?: string; value?: string; secret?: boolean }>;
    return Array.isArray(list) ? list.map((h) => ({ name: h.name ?? '', value: h.secret ? '' : (h.value ?? ''), secret: h.secret === true })) : [];
  } catch {
    return [];
  }
}
