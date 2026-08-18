// Stage B tab controller — manages the [연구 대화][확장 대화] tablist and its
// two tabpanels. Health-gated: if the extended (확장 대화) service is not
// available the tab is disabled and the default 연구 대화 tab stays active.
// Keyboard roving (Arrow/Home/End) and focus restore are handled here.

const TAB_KEYS = ['3a', 'b'];

export function createTabController({ refs, defaultTab = '3a', onActivate }) {
  let activeTab = defaultTab;
  let bAvailable = false;

  function setPanel(tab) {
    const panel3a = refs.panels['3a'];
    const panelB = refs.panels.b;
    if (panel3a) panel3a.hidden = tab !== '3a';
    if (panelB) panelB.hidden = tab !== 'b';
  }

  function setAria(tab) {
    for (const key of TAB_KEYS) {
      const btn = refs.tabs[key];
      if (!btn) continue;
      const selected = key === tab;
      btn.setAttribute('aria-selected', String(selected));
      btn.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected) {
        btn.classList.add('stageb-tab--active');
      } else {
        btn.classList.remove('stageb-tab--active');
      }
    }
  }

  function focusInput(tab) {
    const input = tab === 'b' ? refs.inputs?.b : refs.inputs?.['3a'];
    if (input && typeof input.focus === 'function') {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
    }
  }

  function activate(tab, { focus = true } = {}) {
    const resolved = tab === 'b' && !bAvailable ? '3a' : tab;
    activeTab = resolved;
    setAria(resolved);
    setPanel(resolved);
    if (onActivate) onActivate(resolved);
    if (focus) focusInput(resolved);
    return resolved;
  }

  function setAvailability(ok) {
    bAvailable = Boolean(ok);
    const b = refs.tabs.b;
    if (b) {
      b.disabled = !ok;
      b.setAttribute('aria-disabled', String(!ok));
    }
    if (!ok && activeTab === 'b') activate('3a');
    return bAvailable;
  }

  function handleKeydown(event, key) {
    const idx = TAB_KEYS.indexOf(activeTab);
    if (idx < 0) return null;
    if (key === 'Home') return activate(TAB_KEYS[0]);
    if (key === 'End') return activate(TAB_KEYS[TAB_KEYS.length - 1]);
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const step = key === 'ArrowRight' ? 1 : -1;
      const next = (idx + step + TAB_KEYS.length) % TAB_KEYS.length;
      return activate(TAB_KEYS[next]);
    }
    return null;
  }

  return {
    activate,
    setAvailability,
    handleKeydown,
    get activeTab() {
      return activeTab;
    },
    TAB_KEYS,
  };
}