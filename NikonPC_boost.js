// ==UserScript==
// @name         NikonPC Custom Picture Controls Panel
// @namespace    https://nikonpc.com/
// @version      1.4.0
// @description  分离自定义 Picture Controls 面板，提供独立的显示/隐藏、搜索、记忆、置顶排序功能，并默认关闭原 Picture Controls / Help / AdSense
// @match        *://nikonpc.com/*
// @match        *://www.nikonpc.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY_HIDDEN = 'nikonpc_hidden_picture_controls_v4';
  const STORAGE_KEY_SHOW_HIDDEN = 'nikonpc_show_hidden_items_v4';
  const STORAGE_KEY_CUSTOM_PANEL_VISIBLE = 'nikonpc_custom_panel_visible_v2';
  const STORAGE_KEY_PINNED = 'nikonpc_pinned_picture_controls_v1';

  const KLEIN_BLUE = '#002FA7';

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      function check() {
        const el = document.querySelector(selector);
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() - start > timeout) {
          reject(new Error('Element not found: ' + selector));
          return;
        }
        requestAnimationFrame(check);
      }

      check();
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function triggerNativeChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof el.onchange === 'function') {
      el.onchange();
    }
  }

  function optionToItem(option, index) {
    const fullTitle = (option.getAttribute('title') || option.textContent || '').trim();
    const value = option.value || '';
    let label = (option.textContent || '').trim();
    let path = value;

    if (fullTitle.includes(';')) {
      const parts = fullTitle.split(';');
      label = (parts[0] || label).trim();
      path = (parts.slice(1).join(';') || value).trim();
    }

    return {
      index,
      value,
      label,
      path,
      fullTitle,
      text: (option.textContent || '').trim()
    };
  }

  function compareByName(a, b) {
    const aName = (a.text || a.label || '').trim();
    const bName = (b.text || b.label || '').trim();
    return aName.localeCompare(bName, 'en', { sensitivity: 'base', numeric: true });
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = `
      .tm-custom-view-toggle {
        margin-left: 10px;
      }

      .tm-custom-view-toggle input {
        vertical-align: middle;
      }

      .tm-custom-pc-panel {
        width: 460px;
        float: left;
        margin-right: 12px;
        margin-top: 0;
      }

      .tm-pc-wrap {
        margin-top: 6px;
        border: 1px solid #cfcfcf;
        background: #fff;
        font-size: 12px;
        width: 100%;
        box-sizing: border-box;
      }

      .tm-pc-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border-bottom: 1px solid #e3e3e3;
        background: #f7f7f7;
      }

      .tm-pc-toolbar input[type="text"] {
        flex: 1 1 180px;
        min-width: 0;
        max-width: 220px;
        padding: 4px 6px;
        border: 1px solid #bbb;
        outline: none;
      }

      .tm-pc-toolbar button {
        padding: 4px 8px;
        cursor: pointer;
      }

      .tm-pc-toolbar label {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        user-select: none;
        cursor: pointer;
      }

      .tm-pc-stats {
        margin-left: auto;
        color: #666;
        font-size: 11px;
        white-space: nowrap;
      }

      .tm-pc-list {
        max-height: 550px;
        overflow: auto;
      }

      .tm-pc-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-bottom: 1px solid #f0f0f0;
      }

      .tm-pc-row:hover {
        background: #f8fbff;
      }

      .tm-pc-row.selected {
        background: #e8f2ff;
      }

      .tm-pc-row.is-hidden {
        opacity: 0.6;
        background: #fafafa;
      }

      .tm-pc-row.is-pinned .tm-pc-title,
      .tm-pc-row.is-pinned .tm-pc-path {
        color: ${KLEIN_BLUE};
      }

      .tm-pc-pin {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        line-height: 24px;
        padding: 0;
        border: 1px solid #bbb;
        background: #fff;
        cursor: pointer;
        font-size: 14px;
      }

      .tm-pc-pin.is-active {
        color: ${KLEIN_BLUE};
        border-color: ${KLEIN_BLUE};
        font-weight: 700;
      }

      .tm-pc-main {
        flex: 1;
        min-width: 0;
        cursor: pointer;
      }

      .tm-pc-title-line {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .tm-pc-title {
        display: inline-block;
        min-width: 0;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: 600;
      }

      .tm-pc-badge {
        flex: 0 0 auto;
        font-size: 10px;
        line-height: 1;
        padding: 2px 5px;
        border: 1px solid #bbb;
        border-radius: 10px;
        color: #666;
        background: #fff;
      }

      .tm-pc-badge.tm-pc-badge-pin {
        color: ${KLEIN_BLUE};
        border-color: ${KLEIN_BLUE};
      }

      .tm-pc-path {
        display: block;
        color: #777;
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tm-pc-actions {
        flex: 0 0 auto;
        display: flex;
        gap: 6px;
      }

      .tm-pc-actions button {
        padding: 3px 7px;
        cursor: pointer;
        font-size: 12px;
      }

      .tm-pc-empty {
        padding: 10px 8px;
        color: #666;
      }
    `;
    document.head.appendChild(style);
  }

  function setPanelClosed(panelName) {
    const checkbox = document.querySelector(`input.fn-view-panel[name="${panelName}"]`);
    const panel = document.getElementById(panelName);

    if (panel) {
      panel.style.display = 'none';
    }

    if (checkbox) {
      checkbox.checked = false;
      triggerNativeChange(checkbox);
    }
  }

  function applyDefaultClosedPanels() {
    setPanelClosed('viewPcList');
    setPanelClosed('viewHelp');
    setPanelClosed('viewAdSense');
  }

  function createCustomViewToggle(customPanel) {
    const panelView = document.querySelector('.setup .panel-view');
    if (!panelView) {
      throw new Error('Cannot find .setup .panel-view');
    }

    let panelVisible = !!loadJSON(STORAGE_KEY_CUSTOM_PANEL_VISIBLE, true);

    const label = document.createElement('label');
    label.className = 'tm-custom-view-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = panelVisible;

    const text = document.createTextNode(' Custom Picture Controls');

    label.appendChild(checkbox);
    label.appendChild(text);
    panelView.appendChild(label);

    function syncVisible() {
      customPanel.style.display = panelVisible ? '' : 'none';
      checkbox.checked = panelVisible;
      saveJSON(STORAGE_KEY_CUSTOM_PANEL_VISIBLE, panelVisible);
    }

    checkbox.addEventListener('change', () => {
      panelVisible = checkbox.checked;
      syncVisible();
    });

    syncVisible();
  }

  function createRow(item, state, handlers) {
    const isHidden = !!state.isHidden;
    const isPinned = !!state.isPinned;
    const isSelected = !!state.isSelected;

    const row = document.createElement('div');
    row.className =
      'tm-pc-row' +
      (isSelected ? ' selected' : '') +
      (isHidden ? ' is-hidden' : '') +
      (isPinned ? ' is-pinned' : '');

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'tm-pc-pin' + (isPinned ? ' is-active' : '');
    pinBtn.textContent = '↑';
    pinBtn.title = isPinned ? '取消置顶' : '置顶';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isPinned) {
        handlers.unpin(item);
      } else {
        handlers.pin(item);
      }
    });

    const main = document.createElement('div');
    main.className = 'tm-pc-main';
    main.title = item.fullTitle || item.label;

    main.innerHTML = `
      <div class="tm-pc-title-line">
        <span class="tm-pc-title">${escapeHtml(item.text || item.label)}</span>
        ${isPinned ? '<span class="tm-pc-badge tm-pc-badge-pin">已置顶</span>' : ''}
        ${isHidden ? '<span class="tm-pc-badge">已隐藏</span>' : ''}
      </div>
      <span class="tm-pc-path">${escapeHtml(item.path || '')}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'tm-pc-actions';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = isHidden ? '显示' : '隐藏';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isHidden) {
        handlers.show(item);
      } else {
        handlers.hide(item);
      }
    });

    main.addEventListener('click', () => {
      handlers.select(item);
    });

    actions.appendChild(toggleBtn);

    row.appendChild(pinBtn);
    row.appendChild(main);
    row.appendChild(actions);

    return row;
  }

  function buildCustomPanel(selectEl, originalPanel) {
    const hiddenMap = loadJSON(STORAGE_KEY_HIDDEN, {});
    const pinnedMap = loadJSON(STORAGE_KEY_PINNED, {});
    let showHidden = !!loadJSON(STORAGE_KEY_SHOW_HIDDEN, false);
    const items = Array.from(selectEl.options).map(optionToItem);

    const customPanel = document.createElement('div');
    customPanel.id = 'tmCustomPcPanel';
    customPanel.className = 'panel panel-1 tm-custom-pc-panel';
    customPanel.innerHTML = `
      <div class="header">Custom Picture Controls</div>
      <div class="content"></div>
    `;

    originalPanel.insertAdjacentElement('afterend', customPanel);

    const content = customPanel.querySelector('.content');

    const wrap = document.createElement('div');
    wrap.className = 'tm-pc-wrap';

    const toolbar = document.createElement('div');
    toolbar.className = 'tm-pc-toolbar';

    const keywordInput = document.createElement('input');
    keywordInput.type = 'text';
    keywordInput.placeholder = '筛选 Picture Controls...';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '清空';

    const showHiddenLabel = document.createElement('label');
    const showHiddenCheckbox = document.createElement('input');
    showHiddenCheckbox.type = 'checkbox';
    showHiddenCheckbox.checked = showHidden;
    showHiddenLabel.appendChild(showHiddenCheckbox);
    showHiddenLabel.appendChild(document.createTextNode('显示已隐藏项'));

    const restoreAllBtn = document.createElement('button');
    restoreAllBtn.type = 'button';
    restoreAllBtn.textContent = '全部显示';

    const resetOrderBtn = document.createElement('button');
    resetOrderBtn.type = 'button';
    resetOrderBtn.textContent = '恢复默认顺序';
    resetOrderBtn.title = '清空全部置顶，恢复原始顺序';

    const stats = document.createElement('span');
    stats.className = 'tm-pc-stats';

    toolbar.appendChild(keywordInput);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(showHiddenLabel);
    toolbar.appendChild(restoreAllBtn);
    toolbar.appendChild(resetOrderBtn);
    toolbar.appendChild(stats);

    const list = document.createElement('div');
    list.className = 'tm-pc-list';

    wrap.appendChild(toolbar);
    wrap.appendChild(list);
    content.appendChild(wrap);

    function getSelectedValue() {
      return selectEl.value;
    }

    function selectItem(item) {
      const option = Array.from(selectEl.options).find(o => o.value === item.value);
      if (!option) return;
      selectEl.value = item.value;
      triggerNativeChange(selectEl);
      render();
    }

    function hideItem(item) {
      hiddenMap[item.value] = true;
      saveJSON(STORAGE_KEY_HIDDEN, hiddenMap);

      const selectedValue = getSelectedValue();
      if (selectedValue === item.value) {
        const orderedVisible = getOrderedItems().filter(opt => !hiddenMap[opt.value] && opt.value !== item.value);
        if (orderedVisible.length > 0) {
          selectEl.value = orderedVisible[0].value;
          triggerNativeChange(selectEl);
        }
      }

      render();
    }

    function showItem(item) {
      delete hiddenMap[item.value];
      saveJSON(STORAGE_KEY_HIDDEN, hiddenMap);
      render();
    }

    function restoreAll() {
      Object.keys(hiddenMap).forEach(key => delete hiddenMap[key]);
      saveJSON(STORAGE_KEY_HIDDEN, hiddenMap);
      render();
    }

    function pinItem(item) {
      pinnedMap[item.value] = true;
      saveJSON(STORAGE_KEY_PINNED, pinnedMap);
      render();
    }

    function unpinItem(item) {
      delete pinnedMap[item.value];
      saveJSON(STORAGE_KEY_PINNED, pinnedMap);
      render();
    }

    function resetPinnedOrder() {
      Object.keys(pinnedMap).forEach(key => delete pinnedMap[key]);
      saveJSON(STORAGE_KEY_PINNED, pinnedMap);
      render();
    }

    function getOrderedItems() {
      const pinnedItems = [];
      const normalItems = [];

      for (const item of items) {
        if (pinnedMap[item.value]) {
          pinnedItems.push(item);
        } else {
          normalItems.push(item);
        }
      }

      pinnedItems.sort(compareByName);
      normalItems.sort((a, b) => a.index - b.index);

      return pinnedItems.concat(normalItems);
    }

    function render() {
      const keyword = keywordInput.value.trim().toLowerCase();
      const selectedValue = getSelectedValue();
      const hiddenCount = Object.keys(hiddenMap).length;
      const pinnedCount = Object.keys(pinnedMap).length;

      list.innerHTML = '';

      const orderedItems = getOrderedItems();

      const filtered = orderedItems.filter(item => {
        const isHidden = !!hiddenMap[item.value];
        if (isHidden && !showHidden) return false;

        const haystack = `${item.text} ${item.label} ${item.path} ${item.fullTitle}`.toLowerCase();
        return !keyword || haystack.includes(keyword);
      });

      stats.textContent = `总数 ${items.length} / 已置顶 ${pinnedCount} / 已隐藏 ${hiddenCount} / 当前显示 ${filtered.length}`;

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tm-pc-empty';
        empty.textContent = showHidden ? '没有匹配项目' : '没有可显示项目，可勾选“显示已隐藏项”查看';
        list.appendChild(empty);
        return;
      }

      filtered.forEach(item => {
        list.appendChild(
          createRow(item, {
            isHidden: !!hiddenMap[item.value],
            isPinned: !!pinnedMap[item.value],
            isSelected: item.value === selectedValue
          }, {
            select: selectItem,
            hide: hideItem,
            show: showItem,
            pin: pinItem,
            unpin: unpinItem
          })
        );
      });
    }

    clearBtn.addEventListener('click', () => {
      keywordInput.value = '';
      render();
    });

    keywordInput.addEventListener('input', render);

    showHiddenCheckbox.addEventListener('change', () => {
      showHidden = showHiddenCheckbox.checked;
      saveJSON(STORAGE_KEY_SHOW_HIDDEN, showHidden);
      render();
    });

    restoreAllBtn.addEventListener('click', restoreAll);
    resetOrderBtn.addEventListener('click', resetPinnedOrder);
    selectEl.addEventListener('change', render);

    render();
    return customPanel;
  }

  async function init() {
    injectStyle();

    const originalPanel = await waitForElement('#viewPcList');
    const selectEl = await waitForElement('#selFileList');

    if (document.body.dataset.tmCustomPcReady === '1') return;
    document.body.dataset.tmCustomPcReady = '1';

    applyDefaultClosedPanels();

    const customPanel = buildCustomPanel(selectEl, originalPanel);
    createCustomViewToggle(customPanel);

    console.log('[NikonPC Custom Picture Controls] 已加载');
  }

  init().catch(err => {
    console.error('[NikonPC Custom Picture Controls] 初始化失败:', err);
  });
})();
