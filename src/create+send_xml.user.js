// ==UserScript==
// @name         Teemer Workflow Optimizer - XML Versenden
// @namespace    http://tampermonkey.net/
// @version      1.1.2
// @description  Automates plan creation, laboratory orders, order ID extraction, and emailing XML numbers in Teemer.
// @author       Marco Seeland
// @match        https://*.teemer.de/*
// @match        http://localhost:9443/praxissteuerung/*
// @match        http://127.0.0.1:9443/praxissteuerung/*
// @match        http://localhost:*/praxissteuerung/*
// @match        http://127.0.0.1:*/praxissteuerung/*
// @updateURL    https://raw.githubusercontent.com/maseinphase/TeemerScripts/main/src/create+send_xml.user.js
// @downloadURL  https://raw.githubusercontent.com/maseinphase/TeemerScripts/main/src/create+send_xml.user.js
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // --- CONFIGURATION & CONSTANTS ---
  const STATE_KEY = 'tm_xml_state';
  const MODAL_ID = 'tm-xml-modal';
  const STATUS_BAR_ID = 'tm-xml-status-bar';

  const STEP_TIMEOUT_MS = 15000;
  const STEP_ADVANCE_DELAY_MS = 600;
  const RETRY_WAIT_DELAY_MS = 400;
  const DOM_SETTLE_DELAY_MS = 120;
  const NON_DEBUG_EXEC_THROTTLE_MS = 450;
  const MAX_STEP_RETRIES = 3;
  const TOTAL_STEPS = 16;

  let scheduledTickHandle = null;
  let domObserver = null;
  let cachedDebugMode = false;

  // --- STYLING ---
  function injectStyles() {
    if (document.getElementById('tm-xml-styles')) return;
    const style = document.createElement('style');
    style.id = 'tm-xml-styles';
    style.textContent = `
      #${MODAL_ID} {
        position: fixed; inset: 0; z-index: 99999; display: none;
        align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(8px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #${MODAL_ID}.is-open { display: flex; }
      #${MODAL_ID} .ui-dialog {
        position: relative; top: auto; left: auto; margin: 0 auto; width: 440px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
      }
      #${MODAL_ID} .pxs-formlayout__row { margin-bottom: 14px; }
      #${MODAL_ID} .pxs-formlayout__row__label {
        font-weight: 600; text-align: left !important; margin-bottom: 4px; display: block !important;
      }
      #${MODAL_ID} .pxs-formlayout__row__label label { text-align: left !important; display: inline-block !important; }
      #${MODAL_ID} .ui-dialog-content { padding: 20px 24px; }
      #${MODAL_ID} select, #${MODAL_ID} textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; }
      #${MODAL_ID} textarea { height: 70px; resize: vertical; }
      #${STATUS_BAR_ID} {
        position: fixed; bottom: 24px; right: 24px; z-index: 999999;
        background: #0f172a; color: #ffffff; padding: 16px 20px; border-radius: 12px;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        width: 320px; border: 1px solid rgba(255, 255, 255, 0.1); display: none;
      }
      .tm-status-header { font-size: 0.875rem; font-weight: 700; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
      .tm-status-progress { height: 6px; background: #334155; border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
      .tm-status-progress-bar { height: 100%; width: 0%; background: #3b82f6; transition: width 0.3s; }
      .tm-status-msg { font-size: 0.75rem; color: #94a3b8; margin-bottom: 12px; min-height: 32px; }
      .tm-status-next, .tm-status-cancel { border: none; padding: 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
      .tm-status-next { background: #2563eb; color: #ffffff; }
      .tm-status-next:hover { background: #1d4ed8; }
      .tm-status-cancel { width: 100%; background: #dc2626; color: #ffffff; }
      .tm-status-cancel:hover { background: #b91c1c; }
    `;
    document.head.appendChild(style);
  }

  // --- UNIFIED STATE MANAGER ---
  const State = {
    get: () => {
      try {
        return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
      } catch (e) {
        return {};
      }
    },
    update: (updates) => {
      const current = State.get();
      sessionStorage.setItem(STATE_KEY, JSON.stringify({ ...current, ...updates }));
    },
    clear: () => {
      sessionStorage.removeItem(STATE_KEY);
    }
  };

  // --- LOGGING ---
  function log(msg) {
    if (cachedDebugMode) {
      console.log(`[Teemer Optimizer] [DEBUG] ${msg}`);
    } else {
      console.log(`[Teemer Optimizer] ${msg}`);
    }
  }

  function logWarn(msg, err) {
    console.warn(`[Teemer Optimizer] ${msg}`, err || '');
  }

  // --- DOM & WIDGET UTILITIES ---
  function triggerEvents(element, eventTypes = ['input', 'change']) {
    if (!element) return;
    eventTypes.forEach(type => {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  // Extracts patient name dynamically from UI header or page title
  function getPatientName() {
    const link = document.querySelector('a.nav__item__trigger[title^="Beh:"]');
    if (link) return link.title.replace('Beh:', '').trim();
    const match = document.title.match(/Beh:\s*([^-]+)/);
    return match ? match[1].trim() : '';
  }

  function findElementByText(selector, text, contains = true) {
    const elements = document.querySelectorAll(selector);
    return Array.from(elements).find(el => {
      const elText = el.textContent.trim();
      return contains ? elText.includes(text) : elText === text;
    });
  }

  function findLabelByText(root, labelText) {
    const target = labelText.toLowerCase().trim();
    const labels = Array.from((root || document).querySelectorAll('label'));
    return labels.find(el => {
      const text = el.textContent.replace(':', '').trim().toLowerCase();
      return text === target || text.startsWith(target);
    });
  }

  function findDropdownByLabel(root, labelText) {
    const label = findLabelByText(root, labelText);
    if (!label) return null;
    const forId = label.getAttribute('for');
    if (forId) {
      const el = (root || document).querySelector(`#${CSS.escape(forId)}`);
      if (el && el.tagName === 'SELECT') return el;
    }
    const nearby = label.parentElement ? label.parentElement.querySelector('select') : null;
    if (nearby) return nearby;
    return label.nextElementSibling && label.nextElementSibling.tagName === 'SELECT' ? label.nextElementSibling : null;
  }

  function findLabSelect(dialog, labName) {
    if (!dialog) return null;
    let select = findDropdownByLabel(dialog, 'Labor');
    if (!select) {
      const fallback = Array.from(dialog.querySelectorAll('select'));
      select = fallback.find(el => Array.from(el.options || []).some(opt => isLabNameMatch(opt.text, labName)));
    }
    return select || null;
  }

  // Exact-case insensitive comparison helper
  function isLabNameMatch(a, b) {
    return String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();
  }

  function isDialogVisible(dialogTitle) {
    const dialog = findDialogByTitle(dialogTitle);
    return dialog ? dialog.style.display !== 'none' : false;
  }

  function findDialogByTitle(dialogTitle) {
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      const titleEl = dialog.querySelector('.ui-dialog-title');
      if (titleEl && titleEl.textContent.trim().includes(dialogTitle)) {
        return dialog;
      }
    }
    return null;
  }

  function clickDialogButton(dialogTitle, buttonText) {
    const dialog = findDialogByTitle(dialogTitle);
    if (dialog) {
      const button = Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button'))
        .find(btn => btn.textContent.trim() === buttonText);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }

  function getSelectedOptionText(selectEl) {
    if (!selectEl || selectEl.selectedIndex < 0 || !selectEl.options[selectEl.selectedIndex]) return '';
    return selectEl.options[selectEl.selectedIndex].text.trim();
  }

  function getSelectmenuVisibleText(selectEl) {
    if (!selectEl || !window.jQuery || typeof window.jQuery.fn.selectmenu !== 'function') return '';
    try {
      const $select = window.jQuery(selectEl);
      const instance = $select.selectmenu('instance');
      if (!instance) return '';
      const widget = $select.selectmenu('widget');
      if (!widget || widget.length === 0) return '';
      const textEl = widget.find('.ui-selectmenu-text').first();
      return textEl && textEl.length ? textEl.text().trim() : widget.text().trim();
    } catch (e) {
      return '';
    }
  }

  // Layer 3 Fallback: Click actual menu UI
  function forceSelectmenuItemClick($select, selectEl, targetText) {
    try {
      const instance = $select.selectmenu('instance');
      if (!instance) return false;
      $select.selectmenu('open');
      const menuWidget = $select.selectmenu('menuWidget');
      if (!menuWidget || menuWidget.length === 0) return false;

      const matchItem = menuWidget.find('.ui-menu-item-wrapper').filter((_, el) => {
        return isLabNameMatch(el.textContent, targetText);
      }).first();

      if (!matchItem || matchItem.length === 0) {
        $select.selectmenu('close');
        return false;
      }

      matchItem.trigger('mouseenter').trigger('mousedown').trigger('mouseup').trigger('click');
      return isLabNameMatch(getSelectedOptionText(selectEl), targetText);
    } catch (e) {
      logWarn('forceSelectmenuItemClick failed', e);
      return false;
    }
  }

  function selectDropdownOption(selectEl, textToMatch) {
    if (!selectEl) return false;

    const foundIndex = Array.from(selectEl.options || []).findIndex(opt => isLabNameMatch(opt.text, textToMatch));
    if (foundIndex === -1) {
      logWarn(`Option matching "${textToMatch}" not found.`);
      return false;
    }

    const optionVal = selectEl.options[foundIndex].value;
    selectEl.selectedIndex = foundIndex;

    if (window.jQuery && typeof window.jQuery.fn.selectmenu === 'function') {
      try {
        const $select = window.jQuery(selectEl);
        if (selectEl.classList.contains('pxs-dropdownchoice') && !$select.selectmenu('instance')) {
          log('Waiting for jQuery UI selectmenu init...');
          return false;
        }

        const widgetInstance = $select.selectmenu('instance');
        if (widgetInstance) {
          log(`Updating selectmenu widget to "${textToMatch}"`);
          $select.val(optionVal).selectmenu('refresh');

          const changeCallback = $select.selectmenu('option', 'change');
          if (typeof changeCallback === 'function') {
            const ui = {
              item: { value: optionVal, index: foundIndex, element: window.jQuery(selectEl.options[foundIndex]), label: selectEl.options[foundIndex].text }
            };
            changeCallback.call(selectEl, { target: selectEl, type: 'selectmenuchange' }, ui);
          }

          if (forceSelectmenuItemClick($select, selectEl, textToMatch)) return true;
          return isLabNameMatch(getSelectedOptionText(selectEl), textToMatch);
        }
      } catch (e) {
        logWarn('Selectmenu update failed, using native fallback.', e);
      }
    }

    triggerEvents(selectEl, ['change', 'input']);
    return true;
  }

  function clickMailSendFromFirstDocument() {
    const docsContainer = document.querySelector('.patient-docs');
    if (!docsContainer) return false;
    const docs = docsContainer.querySelectorAll('.workflow-item');
    const firstDoc = docs[0];
    if (!firstDoc) return false;

    const rawTarget = Array.from(firstDoc.querySelectorAll('[title="Datei per E-Mail versenden"], .imagefile-label')).find(el => {
      const title = (el.getAttribute('title') || '').trim();
      const text = (el.textContent || '').trim();
      return title === 'Datei per E-Mail versenden' || text.includes('E-Mail');
    });

    if (!rawTarget) return false;
    const clickTarget = rawTarget.closest('button, a, [role="button"], .ui-button') || rawTarget;
    clickTarget.click();
    return true;
  }

  // --- STEP HANDLERS (ACTION-VALIDATION CYCLE) ---
  // Steps are numbered sequentially 1–16 in execution order.
  const STEP_HANDLERS = {
    1: {
      desc: 'Schritt 1/16: "Plan beauftragen" klicken...',
      failMessage: 'Button "Plan beauftragen" wurde nicht gefunden.',
      run: () => {
        const btn = findElementByText('a.treatment-action', 'Plan beauftragen');
        if (btn) btn.click();
      },
      validate: () => isDialogVisible('Plan beauftragen'),
      next: 2
    },
    2: {
      desc: 'Schritt 2/16: Planungsdetails ausfüllen...',
      failMessage: 'Planungsformular wurde nicht gefunden.',
      run: (state) => {
        const form = document.querySelector('form.planDetails');
        if (!form) return;
        const radio = form.querySelector(`input[name="planTypeRadioButtonGroup"][value="${state.planType}"]`);
        if (radio) {
          radio.checked = true;
          triggerEvents(radio, ['click', 'change']);
        }
        const desc = form.querySelector('textarea[name="description"]');
        if (desc) {
          desc.value = state.description;
          triggerEvents(desc, ['input', 'change']);
        }
      },
      validate: (state) => {
        const form = document.querySelector('form.planDetails');
        if (!form) return false;
        const radio = form.querySelector(`input[name="planTypeRadioButtonGroup"][value="${state.planType}"]`);
        const desc = form.querySelector('textarea[name="description"]');
        return radio && radio.checked && desc && desc.value === state.description;
      },
      next: 3
    },
    3: {
      desc: 'Schritt 3/16: "Erstellen" im Plan-Modal klicken...',
      failMessage: 'Planungsmodal konnte nicht geschlossen werden.',
      run: () => {
        clickDialogButton('Plan beauftragen', 'Erstellen');
      },
      validate: () => !isDialogVisible('Plan beauftragen'),
      next: 4
    },
    4: {
      desc: 'Schritt 4/16: Navigiere zur Planung...',
      failMessage: 'Navigations-Button "Zur Planung" nicht gefunden.',
      run: () => {
        const btn = findElementByText('a.treatment-action', 'Zur Planung');
        if (btn) btn.click();
      },
      validate: () => !!findElementByText('.nubo-light-widget .title', 'Beauftragt / In Bearbeitung'),
      next: 5
    },
    5: {
      desc: 'Schritt 5/16: Plan in Bearbeitungsliste identifizieren...',
      failMessage: 'Erstellter Plan in Bearbeitungsliste nicht gefunden.',
      run: (state) => {
        const column = Array.from(document.querySelectorAll('.nubo-light-widget')).find(w => {
          const t = w.querySelector('.title');
          return t && t.textContent.trim() === 'Beauftragt / In Bearbeitung';
        });
        if (!column) return;
        const items = column.querySelectorAll('.workflow-item');
        const item = Array.from(items).find(i => i.textContent.includes(state.description) && i.textContent.includes(state.patientName));
        if (item) {
          const link = item.querySelector('.nubo-clickable-image-label-box');
          if (link) link.click();
        }
      },
      validate: () => !!findElementByText('.nubo-button', 'Laborauftrag erstellen'),
      next: 6
    },
    6: {
      desc: 'Schritt 6/16: Laborauftrag erstellen...',
      failMessage: 'Button "Laborauftrag erstellen" nicht gefunden.',
      run: () => {
        const btn = findElementByText('.nubo-button', 'Laborauftrag erstellen');
        if (btn) btn.click();
      },
      validate: () => isDialogVisible('Laborauftrag erstellen'),
      next: 7
    },
    7: {
      desc: 'Schritt 7/16: Labor auswählen...',
      failMessage: 'Labor konnte im Dropdown nicht ausgewählt werden.',
      run: (state) => {
        const dialog = findDialogByTitle('Laborauftrag erstellen');
        const select = findLabSelect(dialog, state.labName);
        if (select) selectDropdownOption(select, state.labName);
      },
      validate: (state) => {
        const dialog = findDialogByTitle('Laborauftrag erstellen');
        const select = findLabSelect(dialog, state.labName);
        if (!select) return false;
        const text = getSelectedOptionText(select);
        const visible = getSelectmenuVisibleText(select);
        return isLabNameMatch(text, state.labName) && (!visible || isLabNameMatch(visible, state.labName));
      },
      next: 8
    },
    8: {
      desc: 'Schritt 8/16: "Erstellen" im Laborauftrag-Modal klicken...',
      failMessage: 'Laborauftrags-Modal konnte nicht geschlossen werden.',
      run: () => {
        clickDialogButton('Laborauftrag erstellen', 'Erstellen');
      },
      validate: () => !isDialogVisible('Laborauftrag erstellen'),
      next: 9
    },
    9: {
      desc: 'Schritt 9/16: Erstellten Laborauftrag öffnen...',
      failMessage: 'Link zum erstellten Laborauftrag nicht gefunden.',
      run: (state) => {
        let link = null;
        const createBtn = findElementByText('.nubo-button', 'Laborauftrag erstellen');
        if (createBtn && createBtn.nextElementSibling) {
          link = Array.from(createBtn.nextElementSibling.querySelectorAll('a')).find(a => a.textContent.trim().length > 0);
        }
        if (!link) {
          link = Array.from(document.querySelectorAll('a')).find(a => {
            if (a.closest('.ui-dialog')) return false;
            return isLabNameMatch(a.textContent, state.labName);
          });
        }
        if (link) link.click();
      },
      validate: () => !!findElementByText('a', 'Beauftragen'),
      next: 10
    },
    10: {
      desc: 'Schritt 10/16: Laborauftrag beauftragen...',
      failMessage: 'Button "Beauftragen" nicht gefunden.',
      run: () => {
        const btn = findElementByText('a', 'Beauftragen');
        if (btn && btn.closest('.nubo-light-widget-content')) btn.click();
      },
      validate: () => {
        const th = findElementByText('th', 'Auftragsnummer');
        if (!th || !th.nextElementSibling) return false;
        const orderNum = th.nextElementSibling.textContent.trim();
        return /^[A-Za-z0-9\-/.]{4,}$/.test(orderNum);
      },
      next: 11
    },
    11: {
      desc: 'Schritt 11/16: Auftragsnummer extrahieren...',
      failMessage: 'Auftragsnummer fehlt oder Rücknavigation fehlgeschlagen.',
      run: () => {
        const th = findElementByText('th', 'Auftragsnummer');
        if (th && th.nextElementSibling) {
          const span = th.nextElementSibling.querySelector('span');
          const orderNum = (span ? span.textContent : th.nextElementSibling.textContent).trim();
          if (orderNum) {
            State.update({ orderNumber: orderNum });
            const breadcrumb = document.querySelector('a.nav__item__trigger[title^="Beh:"]');
            if (breadcrumb) breadcrumb.click();
          }
        }
      },
      validate: () => {
        const state = State.get();
        return !!state.orderNumber && !!document.querySelector('.patient-docs, input[name*="mediaRadio"]');
      },
      next: 12
    },
    12: {
      desc: 'Schritt 12/16: Dokumentenfilter "PDF" aktivieren...',
      failMessage: 'PDF Dokumentenfilter konnte nicht aktiviert werden.',
      run: () => {
        const input = document.querySelector('input[name*="mediaRadio"][value="DOCUMENTS"]');
        if (input) {
          input.checked = true;
          triggerEvents(input, ['click', 'change']);
        } else {
          const label = document.querySelector('label[title="PDF"], label[for*="DOCUMENTS"]');
          if (label) label.click();
        }
      },
      validate: () => {
        const input = document.querySelector('input[name*="mediaRadio"][value="DOCUMENTS"]');
        return input ? input.checked : true;
      },
      next: 13
    },
    13: {
      desc: 'Schritt 13/16: Datei per E-Mail versenden...',
      failMessage: 'E-Mail-Modal konnte nicht geöffnet werden.',
      run: () => {
        clickMailSendFromFirstDocument();
      },
      validate: () => document.querySelector('select[name*="mailFavoritesChoice"]') !== null,
      next: 14
    },
    14: {
      desc: 'Schritt 14/16: Favorit/Labor auswählen...',
      failMessage: 'E-Mail Favorit (Labor) konnte nicht ausgewählt werden.',
      run: (state) => {
        const select = document.querySelector('select[name*="mailFavoritesChoice"]');
        if (select) selectDropdownOption(select, state.labName);
      },
      validate: (state) => {
        const select = document.querySelector('select[name*="mailFavoritesChoice"]');
        if (!select) return false;
        return isLabNameMatch(getSelectedOptionText(select), state.labName);
      },
      next: 15
    },
    15: {
      desc: 'Schritt 15/16: E-Mail-Editor vorbereiten...',
      failMessage: 'Kendo E-Mail-Editor wurde nicht geladen.',
      run: () => {},
      validate: () => {
        const $editor = window.jQuery('textarea[name="wrapper:message"]');
        return !!$editor.data('kendoEditor');
      },
      next: 16
    },
    16: {
      desc: 'Schritt 16/16: Anhänge, Auftragsnummer, Versenden...',
      failMessage: 'Editor-Update oder Versand fehlgeschlagen.',
      terminal: true,
      run: (state) => {
        const subject = document.querySelector('input[name="subject"]');
        if (subject) {
          subject.value = 'XML';
          triggerEvents(subject, ['input', 'change']);
        }

        const $attachments = window.jQuery('select[name="attachments"]');
        const multiSelect = $attachments.data('kendoMultiSelect');
        if (multiSelect) {
          const items = multiSelect.dataItems();
          const keeps = Array.from(items).filter(i => i.externalFileName !== 'Anamnese.pdf').map(i => i.businessKey);
          multiSelect.value(keeps);
          multiSelect.trigger('change');
        }

        const $editor = window.jQuery('textarea[name="wrapper:message"]');
        const editor = $editor.data('kendoEditor');
        if (editor) {
          const safeName = String(state.patientName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const safeXml = String(state.orderNumber || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const text = `Hallo,<br/>anbei die XML unseres Patienten ${safeName}<br/><br/>${safeXml}<br/><br/>Mit freundlichen Grüßen<br/>Praxis Dr. Karst`;

          editor.value(text);
          editor.trigger('change');

          if (!state.manualEmailSend) {
            setTimeout(() => clickDialogButton('Neue Nachricht', 'Versenden'), 300);
          } else {
            log('Manual send enabled. Waiting for user click.');
          }
        }
      },
      validate: (state) => {
        const $editor = window.jQuery('textarea[name="wrapper:message"]');
        const editor = $editor.data('kendoEditor');
        return editor && editor.value().includes(state.orderNumber);
      }
    }
  };

  // --- AUTOMATION ENGINE CORE ---

  function updateStatusBar(step, totalSteps, msg) {
    let bar = document.getElementById(STATUS_BAR_ID);
    if (!bar) {
      createStatusBar();
      bar = document.getElementById(STATUS_BAR_ID);
    }
    if (!bar) return;
    bar.style.display = 'block';

    const progress = bar.querySelector('.tm-status-progress-bar');
    const msgEl = bar.querySelector('.tm-status-msg');
    const nextBtn = bar.querySelector('.tm-status-next');
    const cancelBtn = bar.querySelector('.tm-status-cancel');

    if (progress) progress.style.width = `${(step / totalSteps) * 100}%`;
    if (msgEl) msgEl.textContent = msg;

    const state = State.get();
    if (nextBtn) {
      if (state.paused && state.active) {
        nextBtn.style.display = 'block';
        if (cancelBtn) {
          cancelBtn.style.width = 'auto';
          cancelBtn.style.flex = '1';
        }
      } else {
        nextBtn.style.display = 'none';
        if (cancelBtn) {
          cancelBtn.style.width = '100%';
          cancelBtn.style.flex = 'none';
        }
      }
    }
  }

  function stopAutomation(success = false, errorMsg = '') {
    const isSuccess = success === true;
    cachedDebugMode = false;

    const bar = document.getElementById(STATUS_BAR_ID);
    if (bar) {
      if (isSuccess) {
        updateStatusBar(TOTAL_STEPS, TOTAL_STEPS, 'Erfolgreich abgeschlossen!');
        setTimeout(() => { bar.remove(); }, 3000);
      } else {
        updateStatusBar(0, TOTAL_STEPS, errorMsg || 'Abgebrochen.');
        const cancelBtn = bar.querySelector('.tm-status-cancel');
        if (cancelBtn) cancelBtn.textContent = 'Schließen';
      }
    }

    State.clear();
  }

  function advanceStep(nextStep) {
    State.update({
      step: nextStep,
      stepTimestamp: Date.now(),
      retryCount: 0
    });
    log(`Advancing to Step ${nextStep}`);

    const state = State.get();
    if (state.debugMode) {
      State.update({ paused: true });
      updateStatusBar(Math.max(0, nextStep - 1), TOTAL_STEPS, `Bereit für Schritt ${nextStep}.`);
    } else {
      State.update({ paused: false });
      setTimeout(executeStep, STEP_ADVANCE_DELAY_MS);
    }
  }

  function executeStep() {
    const state = State.get();
    if (!state.active || state.paused) return;

    const now = Date.now();

    if (!state.debugMode) {
      const last = state.lastExecTs || 0;
      if (now - last < NON_DEBUG_EXEC_THROTTLE_MS) return;
    }

    const wicketIndicator = document.getElementById('wicket-ajax-indicator');
    if (wicketIndicator && wicketIndicator.style.display !== 'none') {
      log('Wicket AJAX loading active. Waiting...');
      State.update({ lastExecTs: now, stepTimestamp: now });
      return;
    }

    if (state.stepTimestamp && (now - state.stepTimestamp) > STEP_TIMEOUT_MS) {
      logWarn('Step timeout exceeded.');
      stopAutomation(false, 'Fehler: Zeitüberschreitung bei diesem Schritt.');
      return;
    }

    const handler = STEP_HANDLERS[state.step];
    if (!handler) {
      stopAutomation(false, `Ungültiger Schritt: ${state.step}`);
      return;
    }

    // Single state write for this tick's bookkeeping
    State.update({ lastExecTs: now });

    updateStatusBar(state.step, TOTAL_STEPS, handler.desc);

    try {
      // 1. Run action (non-blocking)
      handler.run(state);

      // 2. Validate after DOM settles
      setTimeout(() => {
        const validatedState = State.get();
        if (!validatedState.active || validatedState.paused) return;

        if (handler.validate(validatedState)) {
          if (handler.terminal) {
            stopAutomation(true);
          } else if (handler.next) {
            advanceStep(handler.next);
          }
        } else {
          const retries = (validatedState.retryCount || 0) + 1;
          if (retries >= MAX_STEP_RETRIES) {
            stopAutomation(false, `Schritt ${validatedState.step} fehlgeschlagen: ${handler.failMessage}`);
          } else {
            State.update({ retryCount: retries, stepTimestamp: Date.now() });
            updateStatusBar(validatedState.step, TOTAL_STEPS, `Check fehlgeschlagen. Wiederhole... (${retries}/${MAX_STEP_RETRIES})`);
            
            if (validatedState.debugMode) {
              State.update({ paused: true });
            } else {
              setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            }
          }
        }
      }, DOM_SETTLE_DELAY_MS);
      
    } catch (e) {
      logWarn(`Exception in step ${state.step}`, e);
      stopAutomation(false, `Unerwarteter Fehler: ${e.message}`);
    }
  }

  // --- UI SETUP & INJECTION ---
  function createModal() {
    if (document.getElementById(MODAL_ID)) return;

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML = `
      <div class="ui-dialog ui-corner-all ui-widget ui-widget-content ui-front wicket-modal ui-dialog-buttons" role="dialog" aria-modal="true" aria-labelledby="tm-dialog-title">
        <div class="ui-dialog-titlebar ui-corner-all ui-widget-header ui-helper-clearfix">
          <span class="ui-dialog-title" id="tm-dialog-title">XML Daten eingeben</span>
          <button type="button" class="ui-button ui-corner-all ui-icon-only ui-dialog-titlebar-close" title="Schließen" aria-label="Schließen">
            <span class="ui-button-icon ui-icon ui-icon-closethick"></span>
          </button>
        </div>
        <div class="ui-dialog-content ui-widget-content">
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label"><label for="tm-select-plan">Plan</label></div>
            <select id="tm-select-plan" class="ui-corner-all ui-widget ui-widget-content">
              <option value="HKP">Heil- und Kostenplan</option>
              <option value="HKPR">Zahnersatz-Reparaturen</option>
              <option value="HKPBG">Zahnersatz-Plan / Berufsgenossenschaft</option>
              <option value="KBR">Kieferbruch-Plan</option>
              <option value="ACA">Mehrkostenvereinbarung</option>
            </select>
          </div>
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label"><label for="tm-select-labor">Labor</label></div>
            <select id="tm-select-labor" class="ui-corner-all ui-widget ui-widget-content">
              <option value="Herrmann">Herrmann</option>
              <option value="First">First</option>
              <option value="Estadent">Estadent</option>
              <option value="Lorenz Dental">Lorenz Dental</option>
              <option value="Das Dentallabor/Trautvetter">Das Dentallabor/Trautvetter</option>
              <option value="Saalezahn Dentaltechnik GmbH">Saalezahn Dentaltechnik GmbH</option>
              <option value="Dentallabor Schwinkowski">Dentallabor Schwinkowski</option>
              <option value="B & V Dentallabor GmbH">B & V Dentallabor GmbH</option>
            </select>
          </div>
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label"><label for="tm-textarea-desc">Beschreibung</label></div>
            <textarea id="tm-textarea-desc" class="ui-corner-all ui-widget ui-widget-content" placeholder="z.B. OK Proth. gebrochen"></textarea>
          </div>
          <div class="pxs-formlayout__row" style="display:flex; align-items:center; gap:8px; margin-top: 14px;">
            <input type="checkbox" id="tm-checkbox-debug" style="width:auto; margin:0;" />
            <label for="tm-checkbox-debug" style="cursor:pointer; margin:0;">Debug Mode (Schrittweise)</label>
          </div>
          <div class="pxs-formlayout__row" style="display:flex; align-items:center; gap:8px; margin-top: 10px;">
            <input type="checkbox" id="tm-checkbox-dev-email" checked style="width:auto; margin:0;" />
            <label for="tm-checkbox-dev-email" style="cursor:pointer; margin:0;">E-Mail manuell absenden</label>
          </div>
        </div>
        <div class="ui-dialog-buttonpane ui-widget-content ui-helper-clearfix">
          <div class="ui-dialog-buttonset">
            <button type="button" class="ui-button ui-corner-all ui-widget tm-submit-btn">XML erstellen und versenden</button>
            <button type="button" class="ui-button ui-corner-all ui-widget tm-cancel-btn">Abbrechen</button>
          </div>
        </div>
      </div>
    `;

    const close = () => modal.classList.remove('is-open');
    modal.querySelector('.ui-dialog-titlebar-close').addEventListener('click', close);
    modal.querySelector('.tm-cancel-btn').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    modal.querySelector('.tm-submit-btn').addEventListener('click', () => {
      const plan = modal.querySelector('#tm-select-plan').value;
      const lab = modal.querySelector('#tm-select-labor').value;
      const desc = modal.querySelector('#tm-textarea-desc').value.trim() || 'XML Plan';
      const debug = modal.querySelector('#tm-checkbox-debug').checked;
      const manual = modal.querySelector('#tm-checkbox-dev-email').checked;
      const patient = getPatientName();

      if (!patient) {
        alert('Fehler: Der Patientenname konnte nicht ermittelt werden.');
        return;
      }

      cachedDebugMode = debug;
      State.update({
        active: true,
        step: 1,
        planType: plan,
        labName: lab,
        description: desc,
        patientName: patient,
        debugMode: debug,
        manualEmailSend: manual,
        paused: false,
        stepTimestamp: Date.now(),
        retryCount: 0
      });

      close();
      createStatusBar();
      updateStatusBar(1, TOTAL_STEPS, 'Starte XML Workflow-Automatisierung...');
      setTimeout(executeStep, 500);
    });

    if (window.jQuery && typeof window.jQuery.fn.button === 'function') {
      window.jQuery(modal.querySelectorAll('.ui-button')).button();
    }
    document.body.appendChild(modal);
  }

  function createStatusBar() {
    if (document.getElementById(STATUS_BAR_ID)) return;

    const bar = document.createElement('div');
    bar.id = STATUS_BAR_ID;
    bar.innerHTML = `
      <div class="tm-status-header"><span>XML-Automatisierung läuft</span></div>
      <div class="tm-status-progress"><div class="tm-status-progress-bar"></div></div>
      <div class="tm-status-msg">Bereite vor...</div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="tm-status-next" style="display:none; flex:1;">nächster Schritt</button>
        <button type="button" class="tm-status-cancel" style="width:100%;">Abbrechen</button>
      </div>
    `;

    bar.querySelector('.tm-status-cancel').addEventListener('click', () => {
      if (bar.querySelector('.tm-status-cancel').textContent === 'Schließen') {
        bar.remove();
      } else {
        stopAutomation(false, 'Durch Benutzer abgebrochen.');
      }
    });

    bar.querySelector('.tm-status-next').addEventListener('click', () => {
      State.update({ paused: false, stepTimestamp: Date.now() });
      bar.querySelector('.tm-status-next').style.display = 'none';
      const cancel = bar.querySelector('.tm-status-cancel');
      if (cancel) { cancel.style.width = '100%'; cancel.style.flex = 'none'; }
      executeStep();
    });

    document.body.appendChild(bar);
  }

  function injectXmlButton() {
    if (document.getElementById('tm-xml-trigger')) return;
    if (!findElementByText('a', 'Plan beauftragen')) return;

    const legend = findElementByText('fieldset.nubo-frm__fieldset legend', 'Aktionen', false);
    if (!legend) return;
    const fieldset = legend.closest('fieldset');
    if (!fieldset) return;

    const container = Array.from(fieldset.querySelectorAll('.pxs-splitbutton')).find(el => el.textContent.includes('Schnellabrechnung'));
    const btn = document.createElement('a');
    btn.id = 'tm-xml-trigger';
    btn.className = 'treatment-action nubo-100';
    btn.style.cssText = 'margin-top: 0.5em; display: block; text-align: center; cursor: pointer;';
    btn.textContent = 'XML versenden';

    btn.addEventListener('click', () => {
      createModal();
      const modal = document.getElementById(MODAL_ID);
      if (modal) modal.classList.add('is-open');
    });

    if (container) {
      container.parentNode.insertBefore(btn, container);
    } else {
      fieldset.appendChild(btn);
    }

    if (window.jQuery && typeof window.jQuery.fn.button === 'function') {
      window.jQuery(btn).button({ icon: '', disabled: false, showLabel: true });
    }
  }

  function runAutomationTick() {
    injectXmlButton();
    const state = State.get();
    if (state.active) {
      let bar = document.getElementById(STATUS_BAR_ID);
      if (!bar) {
        createStatusBar();
        if (state.paused) {
          updateStatusBar(state.step - 1, TOTAL_STEPS, `Bereit für Schritt ${state.step}.`);
        } else {
          updateStatusBar(state.step - 1, TOTAL_STEPS, 'Warte auf nächsten Schritt...');
        }
      }
      executeStep();
    }
  }

  function scheduleAutomationTick(delay = DOM_SETTLE_DELAY_MS) {
    if (scheduledTickHandle) clearTimeout(scheduledTickHandle);
    scheduledTickHandle = setTimeout(() => {
      scheduledTickHandle = null;
      runAutomationTick();
    }, delay);
  }

  function startDomObserver() {
    if (domObserver || !document.body) return;
    domObserver = new MutationObserver((mutations) => {
      if (mutations && mutations.length) {
        for (const m of mutations) {
          if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
            scheduleAutomationTick();
            return;
          }
        }
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    injectStyles();
    createModal();
    startDomObserver();

    const state = State.get();
    if (state.active) {
      createStatusBar();
      executeStep();
    }
    runAutomationTick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
