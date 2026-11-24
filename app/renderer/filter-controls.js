(function (root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.WeiyueFilters = exported;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const CHINA_OFFSET = 8 * 60 * 60 * 1000;
  let pickerSequence = 0;

  function parseMinute(value, label) {
    if (value === '' || value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
      throw new Error(`${label}格式无效，请使用 YYYY-MM-DDTHH:mm（北京时间）。`);
    const [year, month, day, hour, minute] = value.match(/\d+/g).map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, 0, 0);
    if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute)
      throw new Error(`${label}不是有效的日期或分钟，请检查年月日和时分。`);
    return date.getTime() - CHINA_OFFSET;
  }

  function parseChinaMinuteRange(start, end) {
    const startMs = parseMinute(start, '开始时间');
    const endMinute = parseMinute(end, '结束时间');
    if (startMs !== undefined && endMinute !== undefined && startMs > endMinute)
      throw new Error('开始时间不能晚于结束时间，请调整北京时间范围。');
    const range = {};
    if (startMs !== undefined) range.start = startMs;
    if (endMinute !== undefined) range.end = endMinute + 60000;
    return range;
  }

  function memberId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '';
    return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : '';
  }
  function selectedSet(values) {
    const result = new Set();
    if (Array.isArray(values) || values instanceof Set)
      for (const value of values) { const id = memberId(value); if (id) result.add(id); }
    return result;
  }
  function normalizeMembers(values) {
    const result = new Map();
    if (Array.isArray(values)) for (const value of values) {
      const id = memberId(value?.id);
      if (!id || result.has(id)) continue;
      result.set(id, { id, name: typeof value.name === 'string' && value.name ? value.name : '未命名成员' });
    }
    return result;
  }

  function createMemberPicker({ container, members = [], selectedIds = [], onChange, onInteraction, emptyLabel = '全部成员', selectionLabel = '筛选成员' } = {}) {
    if (!container || typeof container.appendChild !== 'function' || !container.ownerDocument)
      throw new Error('成员筛选需要有效的容器。');
    const doc = container.ownerDocument;
    const prefix = 'weiyue-member-picker-' + (++pickerSequence);
    let selected = selectedSet(selectedIds), memberMap = normalizeMembers(members);
    let opened = false, composing = false, query = '', destroyed = false, lastInteraction = false;
    const rows = new Map(), cleanups = [];
    function element(tag, className, text) {
      const result = doc.createElement(tag);
      if (className) result.className = className;
      if (text !== undefined) result.textContent = text;
      return result;
    }
    function listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      cleanups.push(() => target.removeEventListener(type, callback, options));
    }
    const root = element('div', 'member-picker');
    const toggle = element('button', 'button member-picker-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', prefix + '-panel');
    toggle.setAttribute('aria-label', '筛选成员');
    const panel = element('div', 'member-picker-panel');
    panel.id = prefix + '-panel'; panel.hidden = true;
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '成员多选');
    const search = element('input', 'member-picker-search');
    search.type = 'search'; search.id = prefix + '-search';
    search.placeholder = '搜索成员昵称或 ID';
    search.autocomplete = 'off'; search.spellcheck = false;
    search.setAttribute('aria-label', '搜索成员昵称或 ID');
    search.setAttribute('aria-controls', prefix + '-list');
    const clear = element('button', 'button text small member-picker-clear', '清除全部');
    clear.type = 'button';
    const status = element('div', 'member-picker-status');
    status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
    const list = element('div', 'member-picker-list');
    list.id = prefix + '-list'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', '可选成员');
    const empty = element('p', 'member-picker-empty', '没有匹配的成员');
    panel.append(search, clear, status, list, empty);
    root.append(toggle, panel); container.appendChild(root);

    function isInteracting() {
      return !destroyed && (opened || composing || root.contains(doc.activeElement));
    }
    function notifyInteraction() {
      const current = isInteracting();
      if (current !== lastInteraction) {
        lastInteraction = current;
        if (typeof onInteraction === 'function') onInteraction(current);
      }
    }
    function updateSelection() {
      toggle.textContent = selected.size ? `已选 ${selected.size} 位成员` : emptyLabel;
      toggle.setAttribute('aria-label', selected.size ? `${selectionLabel}，已选 ${selected.size} 位` : `${selectionLabel}，${emptyLabel}`);
      clear.disabled = selected.size === 0;
      for (const [id, row] of rows) row.checkbox.checked = selected.has(id);
    }
    function visibleRows() { return [...rows.values()].filter(row => !row.label.hidden); }
    function renderList() {
      if (destroyed || composing) return;
      const displayed = new Map(memberMap);
      for (const id of selected) if (!displayed.has(id)) displayed.set(id, { id, name: '未载入成员' });
      const names = new Map();
      for (const member of displayed.values()) names.set(member.name, (names.get(member.name) || 0) + 1);
      for (const [id, row] of rows) if (!displayed.has(id)) {
        if (doc.activeElement === row.checkbox) search.focus();
        row.cleanup(); row.label.remove(); rows.delete(id);
      }
      const lowerQuery = query.trim().toLocaleLowerCase('zh-CN');
      for (const member of displayed.values()) {
        let row = rows.get(member.id);
        if (!row) {
          const label = element('label', 'member-picker-option');
          const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.value = member.id;
          checkbox.id = prefix + '-option-' + rows.size + '-' + (++pickerSequence);
          label.htmlFor = checkbox.id;
          const name = element('span', 'member-picker-name');
          const id = element('span', 'member-picker-id');
          label.append(checkbox, name, id); list.appendChild(label);
          const change = event => {
            event.stopPropagation();
            if (destroyed) return;
            checkbox.checked ? selected.add(member.id) : selected.delete(member.id);
            updateSelection(); renderList();
            if (typeof onChange === 'function') onChange([...selected]);
          };
          checkbox.addEventListener('change', change);
          row = { label, checkbox, name, id, cleanup: () => checkbox.removeEventListener('change', change) };
          rows.set(member.id, row);
        }
        row.name.textContent = member.name;
        row.id.textContent = 'ID：' + member.id;
        row.id.hidden = names.get(member.name) < 2 && memberMap.has(member.id);
        row.checkbox.setAttribute('aria-label', `${member.name}，ID：${member.id}`);
        row.checkbox.checked = selected.has(member.id);
        row.label.hidden = !!lowerQuery && !member.name.toLocaleLowerCase('zh-CN').includes(lowerQuery) &&
          !member.id.toLocaleLowerCase('zh-CN').includes(lowerQuery);
        if (row.label.hidden && doc.activeElement === row.checkbox) search.focus();
      }
      const visible = visibleRows().length;
      empty.hidden = visible !== 0;
      status.textContent = `已选 ${selected.size} 位 · 当前显示 ${visible} 位`;
    }
    function setOpened(value, focusSearch = false) {
      if (destroyed) return;
      opened = !!value; panel.hidden = !opened;
      toggle.setAttribute('aria-expanded', String(opened));
      if (opened && focusSearch) search.focus();
      notifyInteraction();
    }
    listen(toggle, 'click', event => { event.stopPropagation(); setOpened(!opened, !opened); });
    listen(toggle, 'keydown', event => {
      if (event.key === 'ArrowDown' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); setOpened(true, true);
      }
    });
    listen(search, 'compositionstart', () => { composing = true; notifyInteraction(); });
    listen(search, 'compositionend', () => {
      composing = false; query = search.value; renderList(); notifyInteraction();
    });
    listen(search, 'input', event => {
      if (composing || event.isComposing) return;
      query = search.value; renderList();
    });
    listen(clear, 'click', event => {
      event.stopPropagation();
      if (!selected.size || destroyed) return;
      selected.clear(); updateSelection(); renderList();
      if (typeof onChange === 'function') onChange([]);
    });
    listen(root, 'keydown', event => {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === 'Escape' && opened) {
        event.preventDefault(); event.stopPropagation(); setOpened(false); toggle.focus();
      } else if (event.target === search && event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
      } else if (opened && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const options = visibleRows().map(row => row.checkbox);
        const current = options.indexOf(event.target);
        if (event.target !== search && current < 0) return;
        if (event.target === search && event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'ArrowUp' && current === 0) search.focus();
        else {
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
            event.key === 'ArrowDown' ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0);
          options[next]?.focus();
        }
      }
    });
    listen(root, 'focusin', notifyInteraction);
    listen(root, 'focusout', event => {
      // Chromium may run a microtask while activeElement is briefly <body>
      // between focusout and focusin. An internal destination must not collapse
      // the popup before a checkbox receives its click.
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      queueMicrotask(() => {
        if (destroyed) return;
        if (!root.contains(doc.activeElement)) setOpened(false);
        notifyInteraction();
      });
    });
    listen(doc, 'pointerdown', event => {
      if (!root.contains(event.target)) setOpened(false);
    }, true);
    updateSelection(); renderList();
    return {
      setMembers(values) { if (destroyed) return; memberMap = normalizeMembers(values); renderList(); },
      setSelected(values) { if (destroyed) return; selected = selectedSet(values); updateSelection(); renderList(); },
      getSelected() { return [...selected]; },
      isInteracting,
      destroy() {
        if (destroyed) return;
        destroyed = true; composing = false; opened = false;
        for (const cleanup of cleanups) cleanup();
        for (const row of rows.values()) row.cleanup();
        root.remove(); rows.clear(); notifyInteraction();
      },
    };
  }
  return { parseChinaMinuteRange, createMemberPicker };
});
