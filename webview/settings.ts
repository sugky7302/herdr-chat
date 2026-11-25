import { t } from '../src/l10n.ts';
import type { AgentPreset } from '../src/presets';
import type { FromWebview, ToWebview } from '../src/shared';
import type { CatalogAgent, SettingsScope, SettingsSnapshot } from '../src/settings/types';

type Child = Node | string | null | undefined | false;
interface SettingsHost {
  h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, any>, ...children: Child[]): HTMLElementTagNameMap[K];
  icon(name: string): HTMLElement;
  send(message: FromWebview): void;
  back(): void;
}
type Section = 'agents' | 'integrations' | 'skills' | 'connection';
interface DraftPreset { value: AgentPreset; advanced?: string; advancedError?: string }
const BASIC_KEYS = new Set(['id', 'label', 'enabled', 'kind', 'command', 'models', 'efforts', 'defaultModel', 'defaultEffort']);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Settings has its own draft and request lifecycle; native pane polling never remounts its inputs. */
export class SettingsView {
  private element?: HTMLElement;
  private snapshot?: SettingsSnapshot;
  private scope: SettingsScope = 'user';
  private section: Section = 'agents';
  private draft: DraftPreset[] = [];
  private baseline = '[]';
  private selected = 0;
  private modalOpen = false;
  private loadId?: string;
  private pending?: { id: string; kind: 'save' | 'reset' | 'integration' };
  private sequence = 0;
  private error = '';
  private notice = '';
  private output = '';
  private confirmation?: { text: string; action: () => void };
  private skillQuery = '';
  private skillAgent = '';

  constructor(private readonly host: SettingsHost) {}

  mount(): HTMLElement {
    if (!this.element) {
      this.element = this.host.h('main', { class: 'settings' });
      this.render();
      this.load();
    } else if (!this.element.isConnected && !this.pending) {
      this.load();
    }
    return this.element;
  }

  /** Navigation must not silently discard edits, including invalid advanced JSON. */
  leave(action: () => void): void {
    if (this.pending?.kind === 'save' || this.pending?.kind === 'reset') {
      this.notice = t('Wait for the settings operation to finish.'); this.renderFeedback(); return;
    }
    if (!this.dirty()) { action(); return; }
    this.confirm(t('Discard unsaved agent settings and leave this page?'), () => {
      this.restoreDraft(); this.render(); action();
    });
  }

  receive(message: Extract<ToWebview, { type: 'settingsState' | 'settingsOperation' }>): void {
    if (message.type === 'settingsState') {
      if (message.requestId !== this.loadId) return;
      this.loadId = undefined;
      if (message.error || !message.snapshot || message.snapshot.scope !== this.scope) {
        this.error = message.error || t('Settings could not be loaded.'); this.render(); return;
      }
      this.snapshot = message.snapshot;
      this.restoreDraft();
      this.error = ''; this.render(); return;
    }
    if (!this.pending || message.operationId !== this.pending.id) return;
    const kind = this.pending.kind;
    this.pending = undefined;
    this.output = message.output ?? '';
    if (message.error) {
      this.error = message.error; this.notice = '';
    } else if (!message.snapshot || message.snapshot.scope !== this.scope) {
      this.error = t('The operation returned no matching settings. Refresh to check its result.'); this.notice = '';
    } else {
      this.error = '';
      if (kind === 'integration' && this.snapshot) {
        // An integration changes hooks, not the editor's draft or optimistic configuration revision.
        const { presets, revision, projectDefaults, inherited } = this.snapshot;
        this.snapshot = { ...message.snapshot, presets, revision, projectDefaults, inherited };
        this.notice = t('Herdr integration status refreshed.');
      } else {
        this.snapshot = message.snapshot;
        this.restoreDraft();
        this.notice = kind === 'reset' ? t('Agent settings reset for this scope.') : t('Agent settings saved.');
      }
    }
    this.render();
  }

  private dirty(): boolean {
    return JSON.stringify(this.values()) !== this.baseline || this.draft.some((item) => Boolean(item.advancedError));
  }
  private values(): AgentPreset[] { return this.draft.map((item) => item.value); }
  private restoreDraft(): void {
    this.draft = copy(this.snapshot?.presets ?? []).map((value) => ({ value }));
    this.baseline = JSON.stringify(this.values());
    this.selected = Math.max(0, Math.min(this.selected, this.draft.length - 1));
    this.modalOpen = false;
  }
  private changed(): void { this.notice = ''; this.renderSaveBar(); }
  private confirm(text: string, action: () => void): void {
    this.confirmation = { text, action }; this.renderFeedback();
    this.element?.querySelector<HTMLButtonElement>('.settings-confirm-keep')?.focus();
  }
  private load(): void {
    if (this.pending) return;
    this.loadId = `settings-load-${++this.sequence}`;
    this.error = ''; this.notice = ''; this.output = '';
    this.render();
    this.host.send({ type: 'loadSettings', requestId: this.loadId, scope: this.scope });
  }
  private refresh(): void {
    if (this.dirty()) this.confirm(t('Discard unsaved agent settings and reload from VS Code?'), () => { this.restoreDraft(); this.load(); });
    else this.load();
  }
  private changeScope(scope: SettingsScope): void {
    if (scope === this.scope || this.pending) return;
    const change = () => { this.scope = scope; this.snapshot = undefined; this.restoreDraft(); this.load(); };
    if (this.dirty()) this.confirm(t('Discard unsaved agent settings and switch scope?'), change);
    else change();
    const select = this.element?.querySelector<HTMLSelectElement>('#settings-scope');
    if (select) select.value = this.scope;
  }
  private operation(kind: 'save' | 'reset' | 'integration'): string {
    const id = `settings-${kind}-${++this.sequence}`;
    this.loadId = undefined; this.pending = { id, kind };
    this.error = ''; this.notice = ''; this.output = ''; this.confirmation = undefined;
    return id;
  }
  private save(): void {
    if (!this.snapshot || this.pending || this.loadId || !this.dirty()) return;
    if (this.draft.some((item) => item.advancedError)) {
      this.error = t('Correct the advanced JSON before saving.'); this.renderFeedback(); return;
    }
    const operationId = this.operation('save');
    this.host.send({ type: 'saveAgentSettings', operationId, scope: this.scope, revision: this.snapshot.revision, presets: copy(this.values()) });
    this.render();
  }
  private reset(): void {
    if (!this.snapshot || this.pending || this.loadId) return;
    this.confirm(this.scope === 'user'
      ? t('Remove your user agent preset override and use the extension defaults?')
      : t('Remove this workspace’s agent preset override and inherit its parent settings?'), () => {
      const operationId = this.operation('reset');
      this.host.send({ type: 'resetAgentSettings', operationId, scope: this.scope, revision: this.snapshot!.revision });
      this.render();
    });
  }

  private render(): void {
    if (!this.element) return;
    const h = this.host.h;
    const scrollTop = this.element.scrollTop;
    this.element.replaceChildren(
      h('div', { class: 'toolbar' },
        h('button', { class: 'icon-button', title: t('Back'), 'aria-label': t('Back'), onclick: () => this.host.back() }, this.host.icon('back')),
        h('h2', {}, t('Settings')), h('div', { class: 'spacer' }),
        h('button', { class: 'secondary small', disabled: Boolean(this.pending || this.loadId), onclick: () => this.refresh() }, t('Refresh'))),
      h('div', { class: 'settings-scope' },
        h('label', { htmlFor: 'settings-scope' }, t('Save agent menus in')),
        h('select', { id: 'settings-scope', disabled: Boolean(this.pending || this.loadId), onchange: (event: Event) => this.changeScope((event.target as HTMLSelectElement).value as SettingsScope) },
          h('option', { value: 'user', selected: this.scope === 'user' }, t('User settings')),
          h('option', { value: 'workspace', selected: this.scope === 'workspace', disabled: !this.snapshot?.workspaceAvailable }, t('Workspace settings'))),
        this.scope === 'workspace' && this.snapshot?.workspaceLabel ? h('span', { class: 'muted settings-path' }, this.snapshot.workspaceLabel) : null),
      h('nav', { class: 'settings-nav', 'aria-label': t('Settings sections') },
        ...([['agents', t('Agents & models')], ['integrations', t('Integrations')], ['skills', t('Skills')], ['connection', t('Connection')]] as [Section, string][]).map(([section, label]) =>
          h('button', { class: `settings-section ${this.section === section ? 'selected' : ''}`, 'data-settings-section': section, 'aria-current': this.section === section ? 'page' : undefined,
            onclick: () => { this.section = section; this.render(); } }, label))),
      h('div', { class: 'settings-feedback', 'aria-live': 'polite' }),
      h('div', { class: 'settings-body' }, this.snapshot ? this.renderSection() : h('p', { class: 'muted' }, this.loadId ? t('Loading settings…') : t('Settings could not be loaded.'))),
      h('div', { class: 'settings-save-bar' }),
    );
    this.renderFeedback(); this.renderSaveBar();
    this.element.scrollTop = scrollTop;
  }

  private renderFeedback(): void {
    const h = this.host.h;
    const target = this.element?.querySelector('.settings-feedback');
    if (!target) return;
    target.replaceChildren();
    if (this.confirmation) {
      const confirmation = this.confirmation;
      target.append(h('div', { class: 'settings-confirm', role: 'alertdialog', 'aria-label': t('Confirm settings change') },
        h('p', {}, confirmation.text), h('div', { class: 'settings-actions' },
          h('button', { class: 'secondary settings-confirm-keep', onclick: () => { this.confirmation = undefined; this.renderFeedback(); } }, t('Cancel')),
          h('button', { class: 'settings-confirm-accept', onclick: () => { this.confirmation = undefined; confirmation.action(); this.renderFeedback(); } }, t('Confirm')))));
    }
    if (this.error) target.append(h('p', { class: 'settings-inline-error', role: 'alert' }, this.error));
    if (this.notice) target.append(h('p', { class: 'settings-notice', role: 'status' }, this.notice));
    if (this.pending) target.append(h('p', { class: 'settings-notice', role: 'status' }, h('span', { class: 'spinner' }), t('Applying settings…')));
    if (this.output) target.append(h('details', { class: 'settings-output' }, h('summary', {}, t('Operation output')), h('pre', {}, this.output)));
  }

  private renderSaveBar(): void {
    const h = this.host.h;
    const target = this.element?.querySelector('.settings-save-bar');
    if (!target) return;
    target.replaceChildren();
    if (!this.snapshot) return;
    const dirty = this.dirty();
    target.append(h('span', { class: 'muted', role: 'status' }, dirty ? t('Unsaved agent settings') : t('Agent settings up to date')),
      h('button', { class: 'settings-save', disabled: !dirty || Boolean(this.pending || this.loadId), onclick: () => this.save() }, t('Save agent settings')));
  }

  private renderSection(): HTMLElement {
    switch (this.section) {
      case 'agents': return this.renderAgents();
      case 'integrations': return this.renderIntegrations();
      case 'skills': return this.renderSkills();
      case 'connection': return this.renderConnection();
    }
  }

  private renderAgents(): HTMLElement {
    const h = this.host.h;
    const snapshot = this.snapshot!;
    const body = h('section', { class: 'settings-agents' },
      h('h3', {}, t('Agent menus and model IDs')),
      h('p', { class: 'muted' }, t('Choose which agents appear when adding a pane. Model IDs and effort values are sent to that agent; availability depends on its provider and account.')),
      h('p', { class: 'muted' }, t('Workspace agent menus override user menus in that workspace.')),
      snapshot.inherited ? h('p', { class: 'settings-note' }, t('This scope currently inherits its agent menu. Saving creates an override for this scope.')) : null,
      Object.keys(snapshot.projectDefaults).length ? h('details', { class: 'settings-note' }, h('summary', {}, t('Project defaults override preset defaults')),
        h('p', {}, t('Model and effort saved from the new-agent form take priority in this workspace. Edit herdr.agentDefaults in VS Code settings to change them.')),
        h('pre', {}, JSON.stringify(snapshot.projectDefaults, null, 2)),
        h('button', { class: 'link', onclick: () => this.host.send({ type: 'openVSCodeSettings' }) }, t('Open VS Code settings'))) : null,
      h('div', { class: 'settings-agent-list', role: 'group', 'aria-label': t('Configured agent presets') },
        ...this.draft.map((item, index) => h('div', { class: 'settings-agent-row' },
          h('input', { type: 'checkbox', checked: item.value.enabled !== false, disabled: Boolean(this.pending || this.loadId), 'aria-label': t('Enable {0} in agent menus', item.value.label),
            onchange: (event: Event) => { item.value.enabled = (event.target as HTMLInputElement).checked; this.changed(); } }),
          h('button', { class: `settings-agent-choice ${this.modalOpen && index === this.selected ? 'selected' : ''}`, 'data-preset-index': index, 'aria-pressed': String(this.modalOpen && index === this.selected),
            onclick: () => { this.selected = index; this.modalOpen = true; this.render(); this.element?.querySelector<HTMLInputElement>('#settings-agent-label')?.focus(); } },
            h('strong', {}, item.value.label || item.value.id),
            h('code', {}, item.value.id),
            h('span', { class: 'settings-agent-edit-hint', 'aria-hidden': 'true' }, this.host.icon('edit'))))),
      ),
      !this.draft.length ? h('p', { class: 'muted' }, t('No agent presets. Add one from the catalog below.')) : null,
      this.modalOpen && this.draft[this.selected] ? this.renderEditorModal(this.draft[this.selected]) : null,
      h('div', { class: 'settings-actions' },
        h('button', { class: 'secondary settings-add-custom', disabled: Boolean(this.pending || this.loadId), onclick: () => this.addPreset({ id: 'custom', label: t('Custom agent'), command: '', models: [], efforts: [] }) }, t('Add custom agent')),
        h('button', { class: 'link', disabled: Boolean(this.pending || this.loadId), onclick: () => this.reset() }, t('Reset this scope'))),
      h('h3', {}, t('Herdr agent catalog')),
      h('p', { class: 'muted' }, t('Herdr v0.9.5 catalog · {0} agents. Availability depends on your installed Herdr version.', snapshot.catalog.length)),
      h('p', { class: 'muted' }, t('Adding a preset changes your menu. Install the agent CLI using its official setup instructions before starting it.')),
      h('div', { class: 'settings-catalog' }, ...snapshot.catalog.map((agent) => this.catalogCard(agent))),
    );
    return body;
  }

  private addPreset(preset: AgentPreset): void {
    let id = preset.id;
    for (let suffix = 2; this.draft.some((item) => item.value.id === id); suffix++) id = `${preset.id}-${suffix}`;
    this.draft.push({ value: { ...copy(preset), id, enabled: true } }); this.selected = this.draft.length - 1;
    this.modalOpen = true;
    this.notice = ''; this.render();
    this.element?.querySelector<HTMLInputElement>('#settings-agent-label')?.focus();
  }

  private closeModal(): void {
    if (!this.modalOpen) return;
    this.modalOpen = false;
    this.render();
  }

  private renderEditorModal(item: DraftPreset): HTMLElement {
    const h = this.host.h;
    const editor = this.renderEditor(item);
    return h(
      'div',
      {
        class: 'settings-modal-backdrop',
        onclick: (event: MouseEvent) => {
          if (event.target === event.currentTarget) this.closeModal();
        },
        onkeydown: (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            this.closeModal();
          }
        },
      },
      h(
        'div',
        { class: 'settings-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Edit agent preset') },
        h(
          'div',
          { class: 'settings-modal-header' },
          h('strong', {}, `${t('Edit agent preset')} · ${item.value.label || item.value.id}`),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button settings-modal-close',
              title: t('Close'),
              'aria-label': t('Close'),
              onclick: () => this.closeModal(),
            },
            this.host.icon('close'),
          ),
        ),
        h('div', { class: 'settings-modal-body' }, editor),
        h(
          'div',
          { class: 'settings-modal-footer' },
          h(
            'button',
            {
              type: 'button',
              class: 'secondary settings-modal-done',
              onclick: () => this.closeModal(),
            },
            t('Close'),
          ),
        ),
      ),
    );
  }

  private catalogCard(agent: CatalogAgent): HTMLElement {
    const h = this.host.h;
    return h('article', { class: 'settings-card' },
      h('strong', {}, agent.label), h('code', { class: 'settings-path' }, agent.command),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'secondary small', 'data-add-catalog': agent.id, disabled: Boolean(this.pending || this.loadId), onclick: () => this.addPreset(agent.preset) }, t('Add preset')),
        h('button', { class: 'link small', onclick: () => this.host.send({ type: 'openAgentDocs', catalogId: agent.id }) }, t('Setup instructions'))));
  }

  private renderEditor(item: DraftPreset): HTMLElement {
    const h = this.host.h;
    const value = item.value;
    const input = (key: 'id' | 'label' | 'kind' | 'command', label: string) => h('label', {}, label,
      h('input', { id: `settings-agent-${key}`, value: value[key] ?? '', spellcheck: false,
        oninput: (event: Event) => {
          value[key] = (event.target as HTMLInputElement).value;
          const choice = this.element?.querySelector(`[data-preset-index="${this.selected}"]`);
          if (choice) { choice.querySelector('strong')!.textContent = value.label || value.id; choice.querySelector('code')!.textContent = value.id; }
          this.changed();
        } }));
    const defaultSelect = (key: 'defaultModel' | 'defaultEffort', options: string[], label: string) => {
      const values = value[key] && !options.includes(value[key]!) ? [value[key]!, ...options] : options;
      return h('label', {}, label, h('select', { id: `settings-agent-${key}`, onchange: (event: Event) => {
        const selected = (event.target as HTMLSelectElement).value;
        if (selected) value[key] = selected; else delete value[key]; this.changed();
      } }, h('option', { value: '', selected: !value[key] }, t('Default (agent settings)')),
      ...values.map((option) => h('option', { value: option, selected: value[key] === option }, option))));
    };
    const list = (key: 'models' | 'efforts', label: string) => h('label', {}, label,
      h('textarea', { id: `settings-agent-${key}`, rows: key === 'models' ? 4 : 3, spellcheck: false, value: (value[key] ?? []).join('\n'),
        oninput: (event: Event) => {
          value[key] = Array.from(new Set((event.target as HTMLTextAreaElement).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
          const defaultKey = key === 'models' ? 'defaultModel' : 'defaultEffort';
          const selector = this.element?.querySelector<HTMLSelectElement>(`#settings-agent-${defaultKey}`);
          if (selector) {
            const values = value[defaultKey] && !value[key]!.includes(value[defaultKey]!) ? [value[defaultKey]!, ...value[key]!] : value[key]!;
            selector.replaceChildren(h('option', { value: '', selected: !value[defaultKey] }, t('Default (agent settings)')),
              ...values.map((option) => h('option', { value: option, selected: option === value[defaultKey] }, option)));
          }
          this.changed();
        } }));
    const mode = value.kind !== undefined ? 'native' : 'command';
    const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !BASIC_KEYS.has(key)));
    const advanced = h('textarea', { id: 'settings-agent-advanced', rows: 9, spellcheck: false, value: item.advanced ?? JSON.stringify(extra, null, 2),
      'aria-label': t('Advanced preset JSON'), oninput: (event: Event) => {
        item.advanced = (event.target as HTMLTextAreaElement).value;
        try {
          const parsed: unknown = JSON.parse(item.advanced);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('Advanced configuration must be a JSON object.'));
          if (Object.keys(parsed).some((key) => BASIC_KEYS.has(key))) throw new Error(t('Edit names, launch type, models, and defaults in the fields above.'));
          if (Object.keys(parsed).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error(t('Invalid advanced configuration key.'));
          for (const key of Object.keys(value)) if (!BASIC_KEYS.has(key)) delete (value as unknown as Record<string, unknown>)[key];
          Object.assign(value, parsed);
          item.advancedError = undefined;
        } catch (error) { item.advancedError = error instanceof Error ? error.message : t('Invalid JSON.'); }
        const feedback = this.element?.querySelector('.settings-advanced-error');
        if (feedback) feedback.textContent = item.advancedError ?? '';
        this.changed();
      } });
    return h('fieldset', { class: 'settings-editor', disabled: Boolean(this.pending || this.loadId) },
      h('legend', {}, t('Edit agent preset')), input('label', t('Display name')), input('id', t('Preset ID')),
      h('label', {}, t('Launch type'), h('select', { id: 'settings-launch-type', onchange: (event: Event) => {
        if ((event.target as HTMLSelectElement).value === 'native') { delete value.command; value.kind = this.snapshot!.catalog[0]?.kind ?? 'claude'; }
        else { delete value.kind; value.command = ''; }
        this.render();
      } }, h('option', { value: 'native', selected: mode === 'native' }, t('Native Herdr agent')), h('option', { value: 'command', selected: mode === 'command' }, t('Custom shell command')))),
      mode === 'native' ? input('kind', t('Herdr agent kind')) : input('command', t('Shell command')),
      mode === 'command' ? h('p', { class: 'muted' }, t('Custom commands run in the pane’s shell. Use advanced arguments and templates for model switching.')) : null,
      list('models', t('Model IDs · one per line')), defaultSelect('defaultModel', value.models ?? [], t('Default model')),
      h('p', { class: 'muted' }, t('To apply a model or effort at startup, configure modelArgs or effortArgs in Advanced. Use the flags supported by your agent CLI.')),
      list('efforts', t('Effort values · one per line')), defaultSelect('defaultEffort', value.efforts ?? [], t('Default effort')),
      h('details', { class: 'settings-advanced', open: Boolean(item.advancedError) }, h('summary', {}, t('Advanced arguments and switching')),
        h('p', { class: 'muted' }, t('Configure args, modelArgs, effortArgs, switchModel, switchEffort, switchStyle, and slashCommands as JSON. Templates use {model} and {effort}.')),
        advanced, h('p', { class: 'settings-advanced-error settings-inline-error', role: 'alert' }, item.advancedError ?? '')),
      h('button', { class: 'link settings-remove-preset', onclick: () => {
        this.draft.splice(this.selected, 1); this.selected = Math.max(0, this.selected - 1); this.modalOpen = false; this.notice = ''; this.render();
      } }, t('Remove this preset from the menu')),
    );
  }

  private renderIntegrations(): HTMLElement {
    const h = this.host.h;
    const snapshot = this.snapshot!;
    return h('section', {}, h('h3', {}, t('Herdr integrations')),
      h('p', { class: 'muted' }, t('Install or remove Herdr’s hooks for agent state and session restore. These actions do not install the agent CLI or download cloud models.')),
      !snapshot.diagnostics.connected ? h('p', { class: 'settings-note' }, t('Connect to Herdr to manage integrations.')) : null,
      !snapshot.diagnostics.trusted ? h('p', { class: 'settings-note' }, t('Trust this VS Code workspace before changing integrations.')) : null,
      snapshot.integrationError ? h('p', { class: 'settings-inline-error' }, snapshot.integrationError) : null,
      ...snapshot.catalog.map((agent) => {
        const integration = snapshot.integrations.find((item) => item.target === agent.integrationTarget);
        const supported = Boolean(integration?.supported && agent.integrationTarget);
        const canRun = supported && snapshot.diagnostics.connected && snapshot.diagnostics.trusted && !this.pending && !this.loadId;
        const installed = integration?.installed === true;
        const statuses: Record<string, string> = { current: t('Installed'), outdated: t('Update available'), not_installed: t('Not installed'), unavailable: t('Unavailable'), unknown: t('Status unavailable') };
        return h('article', { class: 'settings-card settings-integration', 'data-integration': agent.integrationTarget ?? agent.id },
          h('div', { class: 'settings-card-heading' }, h('strong', {}, agent.label),
            h('span', { class: 'settings-badge' }, agent.integrationTarget ? (integration ? statuses[integration.status] ?? integration.status : t('Status unavailable')) : t('No Herdr integration'))),
          integration?.version ? h('span', { class: 'muted' }, integration.version) : null,
          integration?.cliAvailable === false ? h('p', { class: 'muted' }, t('Agent CLI was not detected by Herdr. Check its setup instructions.')) : null,
          integration?.detail ? h('p', { class: 'muted' }, integration.detail) : null,
          h('div', { class: 'settings-actions' },
            agent.integrationTarget ? h('button', { class: 'secondary small', disabled: !canRun, 'data-integration-action': 'install',
              onclick: () => this.runIntegration(agent.integrationTarget!, 'install') }, installed ? t('Reinstall Herdr integration') : t('Install Herdr integration')) : null,
            installed ? h('button', { class: 'secondary small', disabled: !canRun, 'data-integration-action': 'uninstall',
              onclick: () => this.confirm(t('Remove the Herdr integration for {0}? This changes its Herdr hooks and session integration.', agent.label), () => this.runIntegration(agent.integrationTarget!, 'uninstall')) }, t('Uninstall Herdr integration')) : null,
            h('button', { class: 'link small', onclick: () => this.host.send({ type: 'openAgentDocs', catalogId: agent.id }) }, t('Setup instructions'))));
      }));
  }
  private runIntegration(target: string, action: 'install' | 'uninstall'): void {
    if (this.pending || this.loadId) return;
    const operationId = this.operation('integration');
    this.host.send({ type: 'runIntegration', operationId, scope: this.scope, target, action }); this.render();
  }

  private renderSkills(): HTMLElement {
    const h = this.host.h;
    const snapshot = this.snapshot!;
    const agents = Array.from(new Set(snapshot.skills.map((skill) => skill.agent))).sort();
    const list = h('div', { class: 'settings-skill-list' });
    const renderList = () => {
      const query = this.skillQuery.trim().toLowerCase();
      const skills = snapshot.skills.filter((skill) => (!this.skillAgent || skill.agent === this.skillAgent) &&
        (!query || [skill.name, skill.description, skill.path, skill.agent].some((value) => value.toLowerCase().includes(query))));
      list.replaceChildren(h('p', { class: 'muted' }, t('{0} local skills found', skills.length)),
        ...skills.map((skill) => h('article', { class: 'settings-card' },
          h('div', { class: 'settings-card-heading' }, h('strong', {}, skill.name), h('span', { class: 'settings-badge' }, skill.agent)),
          h('span', { class: 'muted' }, skill.scope === 'project' ? t('Project') : skill.scope === 'user' ? t('User') : t('System')),
          skill.disabled ? h('span', { class: 'muted' }, t('User invocation disabled in skill metadata')) : null,
          skill.description ? h('p', {}, skill.description) : null,
          h('code', { class: 'settings-path' }, skill.path),
          skill.invocation ? h('code', {}, skill.invocation) : null,
          h('button', { class: 'link', onclick: () => this.host.send({ type: 'openSkillFile', skillId: skill.id }) }, t('Open SKILL.md')))));
    };
    renderList();
    return h('section', {}, h('h3', {}, t('Local skills')),
      h('p', { class: 'muted' }, t('Skills found in standard local directories. Each agent decides which skills it loads; plugin, managed, and account skills may not appear here.')),
      snapshot.skillError ? h('p', { class: 'settings-inline-error' }, snapshot.skillError) : null,
      h('div', { class: 'settings-filters' }, h('input', { type: 'search', value: this.skillQuery, placeholder: t('Search skills'), 'aria-label': t('Search skills'),
        oninput: (event: Event) => { this.skillQuery = (event.target as HTMLInputElement).value; renderList(); } }),
        h('select', { 'aria-label': t('Filter by agent'), onchange: (event: Event) => { this.skillAgent = (event.target as HTMLSelectElement).value; renderList(); } },
          h('option', { value: '', selected: !this.skillAgent }, t('All agents')), ...agents.map((agent) => h('option', { value: agent, selected: this.skillAgent === agent }, agent)))), list,
      h('details', { class: 'settings-roots' }, h('summary', {}, t('Scanned skill directories')),
        ...snapshot.skillRoots.map((root) => h('div', { class: 'settings-root' }, h('span', {}, root.agent), h('code', { class: 'settings-path' }, root.path), h('span', { class: 'muted' }, root.exists ? t('Found') : t('Not present'))))),
      h('article', { class: 'settings-card settings-herdr-skill' }, h('h3', {}, t('Herdr operating skill')),
        h('p', {}, t('This skill teaches an agent how to inspect panes, delegate work, and wait using the Herdr CLI. The agent’s own skill system loads it.')),
        h('p', { class: 'muted' }, t('Print the skill bundled with your Herdr version:')), h('pre', {}, 'herdr --skill'),
        h('p', { class: 'muted' }, t('Official global installation command (omit -g for this project):')), h('pre', {}, 'npx skills add herdrdev/herdr --skill herdr -g'),
        h('button', { class: 'link', onclick: () => this.host.send({ type: 'openAgentDocs', catalogId: 'herdr-skill' }) }, t('Herdr skill documentation'))));
  }

  private renderConnection(): HTMLElement {
    const h = this.host.h;
    const snapshot = this.snapshot!;
    const diagnostics = snapshot.diagnostics;
    const rows: [string, string][] = [
      [t('Herdr connection'), diagnostics.connected ? t('Connected') : t('Disconnected')],
      [t('Socket path'), diagnostics.socketPath || t('Automatic detection')],
      [t('Collaboration Node.js'), diagnostics.nodePath],
      [t('Claude-mem URL'), diagnostics.claudeMemUrl || t('Automatic detection')],
      [t('Workspace trust'), diagnostics.trusted ? t('Trusted') : t('Restricted')],
    ];
    return h('section', {}, h('h3', {}, t('Connection and advanced settings')),
      h('dl', { class: 'settings-diagnostics' }, ...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)])),
      h('p', { class: 'muted' }, t('Configure paths, Claude-mem, transcript limits, and project defaults in VS Code’s settings editor.')),
      h('button', { class: 'secondary', onclick: () => this.host.send({ type: 'openVSCodeSettings' }) }, t('Open VS Code settings')));
  }
}
