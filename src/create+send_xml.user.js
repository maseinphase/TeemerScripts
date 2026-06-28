// ==UserScript==
// @name         Teemer Workflow Optimizer - XML Versenden
// @namespace    http://tampermonkey.net/
// @version      1.0.14
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

  // --- CONFIGURATION & STATE KEYS ---
  const STATE_KEYS = {
    ACTIVE: 'tm_xml_active',
    STEP: 'tm_xml_step',
    PLAN_TYPE: 'tm_xml_plan_type',
    PLAN_TYPE_TEXT: 'tm_xml_plan_type_text',
    LAB_NAME: 'tm_xml_lab_name',
    LAB_VALUE: 'tm_xml_lab_value',
    DESCRIPTION: 'tm_xml_description',
    ORDER_NUMBER: 'tm_xml_order_number',
    PATIENT_NAME: 'tm_xml_patient_name',
    STEP_TIMESTAMP: 'tm_xml_step_timestamp',
    LAST_EXEC_TS: 'tm_xml_last_exec_ts',
    DEBUG_MODE: 'tm_xml_debug_mode',
    PAUSED: 'tm_xml_paused',
    MANUAL_EMAIL_SEND: 'tm_xml_manual_email_send',
    MAIL_MODAL_WAIT_ATTEMPTS: 'tm_xml_mail_modal_wait_attempts',
    LAST_CHECK: 'tm_xml_last_check',
    LAST_ERROR: 'tm_xml_last_error'
  };

  const STEP_TIMEOUT_MS = 15000; // 15 seconds safety timeout per step
  const STEP_ADVANCE_DELAY_MS = 600;
  const RETRY_WAIT_DELAY_MS = 400;
  const NON_DEBUG_EXEC_THROTTLE_MS = 450;
  const MAX_STEP_RETRIES = 3;
  const MODAL_ID = 'tm-xml-modal';
  const STATUS_BAR_ID = 'tm-xml-status-bar';
  const DOM_SETTLE_DELAY_MS = 120;
  let emailStarted = false;
  let scheduledTickHandle = null;
  let domObserver = null;

  // --- STYLING ---
  function injectStyles() {
    if (document.getElementById('tm-xml-styles')) return;

    const style = document.createElement('style');
    style.id = 'tm-xml-styles';
    style.textContent = `
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(15, 23, 42, 0.4);
        backdrop-filter: blur(8px);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #${MODAL_ID}.is-open {
        display: flex;
      }
      #${MODAL_ID} .ui-dialog {
        position: relative;
        top: auto;
        left: auto;
        margin: 0 auto;
        width: 440px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
      }
      #${MODAL_ID} .pxs-formlayout__row {
        margin-bottom: 14px;
      }
      #${MODAL_ID} .pxs-formlayout__row__label {
        font-weight: 600;
        text-align: left !important;
        margin-bottom: 4px;
        display: block !important;
      }
      #${MODAL_ID} .pxs-formlayout__row__label label {
        text-align: left !important;
        display: inline-block !important;
      }
      #${MODAL_ID} .ui-dialog-content {
        padding: 20px 24px;
      }
      #${MODAL_ID} select, #${MODAL_ID} textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
      }
      #${MODAL_ID} textarea {
        height: 70px;
        resize: vertical;
      }

      /* Floating status dashboard */
      #${STATUS_BAR_ID} {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        background: #0f172a;
        color: #ffffff;
        padding: 16px 20px;
        border-radius: 12px;
        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        width: 320px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: none;
      }
      .tm-status-header {
        font-size: 0.875rem;
        font-weight: 700;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .tm-status-progress {
        height: 6px;
        background: #334155;
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .tm-status-progress-bar {
        height: 100%;
        width: 0%;
        background: #3b82f6;
        transition: width 0.3s;
      }
      .tm-status-msg {
        font-size: 0.75rem;
        color: #94a3b8;
        margin-bottom: 12px;
        min-height: 32px;
      }
      .tm-status-next, .tm-status-cancel {
        border: none;
        padding: 8px;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }
      .tm-status-next {
        background: #2563eb;
        color: #ffffff;
      }
      .tm-status-next:hover {
        background: #1d4ed8;
      }
      .tm-status-cancel {
        width: 100%;
        background: #dc2626;
        color: #ffffff;
      }
      .tm-status-cancel:hover {
        background: #b91c1c;
      }
    `;
    document.head.appendChild(style);
  }

  // --- HELPER FUNCTIONS ---

  function triggerEvents(element, eventTypes = ['input', 'change']) {
    if (!element) return;
    eventTypes.forEach(type => {
      element.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  function getPatientName() {
    const link = document.querySelector('a.nav__item__trigger[title^="Beh:"]');
    if (link) {
      return link.title.replace('Beh:', '').trim();
    }
    const match = document.title.match(/Beh:\s*([^-]+)/);
    if (match) {
      return match[1].trim();
    }
    return '';
  }

  function findElementByText(selector, text, contains = true) {
    const elements = document.querySelectorAll(selector);
    return Array.from(elements).find(el => {
      const elText = el.textContent.trim();
      return contains ? elText.includes(text) : elText === text;
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clickMailSendFromFirstDocument() {
    const docsContainer = document.querySelector('.patient-docs');
    console.log('[Teemer Optimizer] Step 10: docsContainer found:', !!docsContainer);
    if (!docsContainer) return false;

    const docs = Array.from(docsContainer.querySelectorAll('.workflow-item'));
    console.log(`[Teemer Optimizer] Step 10: Found ${docs.length} documents in container.`);
    const firstDoc = docs[0];
    if (!firstDoc) return false;

    const rawTarget = Array.from(firstDoc.querySelectorAll('[title="Datei per E-Mail versenden"], .imagefile-label')).find((el) => {
      const title = (el.getAttribute('title') || '').trim();
      const text = (el.textContent || '').trim();
      return title === 'Datei per E-Mail versenden' || text.includes('E-Mail');
    });

    console.log('[Teemer Optimizer] Step 10: mailBtn found:', !!rawTarget);
    if (!rawTarget) return false;

    const clickTarget = rawTarget.closest('button, a, [role="button"], .ui-button') || rawTarget;
    console.log('[Teemer Optimizer] Step 10: Clicking E-Mail button target:', clickTarget.tagName, clickTarget.id || '(no id)');
    clickTarget.click();
    return true;
  }

  // Safe programmatic interaction with Wicket / JQuery dialog buttons
  function clickDialogButton(dialogTitle, buttonText) {
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      const titleEl = dialog.querySelector('.ui-dialog-title');
      if (titleEl && titleEl.textContent.trim().includes(dialogTitle)) {
        const button = Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button'))
          .find(btn => btn.textContent.trim() === buttonText);
        if (button) {
          button.click();
          return true;
        }
      }
    }
    return false;
  }

  function isLabNameMatch(elText, selectedLabName) {
    if (!elText || !selectedLabName) return false;
    return elText.toLowerCase().trim() === selectedLabName.toLowerCase().trim();
  }

  function isDialogVisible(dialogTitle) {
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      const titleEl = dialog.querySelector('.ui-dialog-title');
      if (titleEl && titleEl.textContent.trim().includes(dialogTitle)) {
        return dialog.style.display !== 'none';
      }
    }
    return false;
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

  function summarizeSelectCandidate(selectEl) {
    if (!selectEl) return '(missing select)';
    const optionTexts = Array.from(selectEl.options || []).map((option) => option.text.trim());
    return `${selectEl.id || selectEl.name || 'unknown'} => ${optionTexts.join(' | ')}`;
  }

  function findSelectByExactLabel(rootElement, labelText) {
    if (!rootElement) return null;

    const labels = Array.from(rootElement.querySelectorAll('label'));
    const label = labels.find((labelEl) => {
      return labelEl.textContent.replace(':', '').trim().toLowerCase() === labelText.toLowerCase().trim();
    });

    if (!label) return null;

    const forId = label.getAttribute('for');
    if (forId) {
      const directSelect = rootElement.querySelector(`#${CSS.escape(forId)}`);
      if (directSelect && directSelect.tagName === 'SELECT') {
        return directSelect;
      }
    }

    const nearbySelect = label.parentElement ? label.parentElement.querySelector('select') : null;
    if (nearbySelect) {
      return nearbySelect;
    }

    const nextSelect = label.nextElementSibling && label.nextElementSibling.tagName === 'SELECT'
      ? label.nextElementSibling
      : null;
    return nextSelect;
  }

  function findSelectByOptionText(rootElement, targetText) {
    if (!rootElement) return null;
    const selects = Array.from(rootElement.querySelectorAll('select'));
    console.log(`[Teemer Optimizer] Select debug -> scanning ${selects.length} selects inside dialog for target "${targetText}".`);

    const matchingCandidates = selects.filter((selectEl) => {
      return Array.from(selectEl.options || []).some((option) => isLabNameMatch(option.text, targetText));
    });

    if (matchingCandidates.length > 0) {
      console.log('[Teemer Optimizer] Select debug -> matching candidates:', matchingCandidates.map(summarizeSelectCandidate));
      return matchingCandidates[0];
    }

    console.log('[Teemer Optimizer] Select debug -> no candidate in dialog matched target text. Available candidates:', selects.map(summarizeSelectCandidate));
    return null;
  }

  function getRetryStorageKey(step) {
    return `tm_xml_retry_${step}`;
  }

  function getStepRetryCount(step) {
    return parseInt(sessionStorage.getItem(getRetryStorageKey(step)) || '0', 10);
  }

  function incrementStepRetryCount(step) {
    const nextCount = getStepRetryCount(step) + 1;
    sessionStorage.setItem(getRetryStorageKey(step), String(nextCount));
    return nextCount;
  }

  function resetStepRetryCount(step) {
    sessionStorage.removeItem(getRetryStorageKey(step));
  }

  function clearRetryState() {
    const keysToDelete = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith('tm_xml_retry_')) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => sessionStorage.removeItem(key));
  }

  function getSelectedOptionText(selectEl) {
    if (!selectEl || selectEl.selectedIndex < 0 || !selectEl.options[selectEl.selectedIndex]) {
      return '';
    }
    return selectEl.options[selectEl.selectedIndex].text.trim();
  }

  function getSelectmenuVisibleText(selectEl) {
    if (!selectEl || !window.jQuery || typeof window.jQuery.fn.selectmenu !== 'function') {
      return '';
    }

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

  function selectDropdownOption(selectEl, textToMatch) {
    if (!selectEl) return false;

    const optionsSnapshot = Array.from(selectEl.options || []).map((opt, idx) => {
      return `${idx}:${opt.text}`;
    });
    const beforeIndex = selectEl.selectedIndex;
    const beforeText = beforeIndex >= 0 && selectEl.options[beforeIndex]
      ? selectEl.options[beforeIndex].text
      : '(none)';
    console.log(`[Teemer Optimizer] Select debug -> target: "${textToMatch}", before selected: "${beforeText}"`);
    console.log('[Teemer Optimizer] Select debug -> available options:', optionsSnapshot);
    
    // Find option index using exact name matching
    let foundIndex = -1;
    for (let i = 0; i < selectEl.options.length; i++) {
      if (isLabNameMatch(selectEl.options[i].text, textToMatch)) {
        foundIndex = i;
        break;
      }
    }
    if (foundIndex === -1) {
      console.warn(`[Teemer Optimizer] Option matching "${textToMatch}" not found.`);
      return false;
    }

    const optionVal = selectEl.options[foundIndex].value;
    selectEl.selectedIndex = foundIndex;
    const selectId = selectEl.id;
    const selectDebugId = selectId || selectEl.name || 'unknown';
    console.log(`[Teemer Optimizer] Select debug -> matched option index: ${foundIndex}, text: "${selectEl.options[foundIndex].text}", value: "${optionVal}"`);

    function forceSelectmenuItemClick($select, targetText) {
      try {
        const instance = $select.selectmenu('instance');
        if (!instance) return false;

        $select.selectmenu('open');
        const menuWidget = $select.selectmenu('menuWidget');
        if (!menuWidget || menuWidget.length === 0) {
          console.warn('[Teemer Optimizer] Select debug -> menuWidget missing after open.');
          return false;
        }

        const matchItem = menuWidget.find('.ui-menu-item-wrapper').filter((_, el) => {
          return isLabNameMatch(el.textContent, targetText);
        }).first();

        if (!matchItem || matchItem.length === 0) {
          console.warn(`[Teemer Optimizer] Select debug -> no menu item found for "${targetText}".`);
          $select.selectmenu('close');
          return false;
        }

        const itemText = matchItem.text().trim();
        console.log(`[Teemer Optimizer] Select debug -> clicking visible menu item: "${itemText}"`);
        matchItem.trigger('mouseenter');
        matchItem.trigger('mousedown');
        matchItem.trigger('mouseup');
        matchItem.trigger('click');

        const afterClickIndex = selectEl.selectedIndex;
        const afterClickText = afterClickIndex >= 0 && selectEl.options[afterClickIndex]
          ? selectEl.options[afterClickIndex].text
          : '(none)';
        console.log(`[Teemer Optimizer] Select debug -> after visible click selected: "${afterClickText}"`);
        return isLabNameMatch(afterClickText, targetText);
      } catch (e) {
        console.warn('[Teemer Optimizer] Select debug -> forceSelectmenuItemClick failed.', e);
        return false;
      }
    }

    // If selectmenu is expected (class pxs-dropdownchoice) but JQuery UI selectmenu is not yet initialized on this element,
    // return false to wait for Wicket to initialize it.
    if (window.jQuery && selectEl.classList.contains('pxs-dropdownchoice')) {
      try {
        const $select = window.jQuery(selectEl);
        if (!$select.selectmenu('instance')) {
          console.log(`[Teemer Optimizer] Waiting for JQuery UI selectmenu initialization on ${selectDebugId}...`);
          return false;
        }
      } catch (e) {
        // Ignore and proceed
      }
    }

    // Try jQuery UI selectmenu widget direct update and callback execution
    if (window.jQuery && typeof window.jQuery.fn.selectmenu === 'function') {
      try {
        const $select = window.jQuery(selectEl);
        const widgetInstance = $select.selectmenu('instance');
        if (widgetInstance) {
          console.log(`[Teemer Optimizer] Updating JQuery UI selectmenu ${selectDebugId} programmatically to: ${textToMatch}`);
          $select.val(optionVal);
          $select.selectmenu('refresh');
          
          // Retrieve and execute the change callback registered by Wicket
          const changeCallback = $select.selectmenu('option', 'change');
          if (typeof changeCallback === 'function') {
            const ui = {
              item: {
                value: optionVal,
                index: foundIndex,
                element: window.jQuery(selectEl.options[foundIndex]),
                label: selectEl.options[foundIndex].text
              }
            };
            changeCallback.call(selectEl, { target: selectEl, type: 'selectmenuchange' }, ui);
            console.log(`[Teemer Optimizer] Executed Wicket selectmenu change callback for ${selectDebugId}`);
            const afterIndex = selectEl.selectedIndex;
            const afterText = afterIndex >= 0 && selectEl.options[afterIndex]
              ? selectEl.options[afterIndex].text
              : '(none)';
            console.log(`[Teemer Optimizer] Select debug -> after selected (selectmenu path): "${afterText}"`);

            // Some Teemer flows only persist when the visible selectmenu item is clicked.
            const forceClicked = forceSelectmenuItemClick($select, textToMatch);
            if (forceClicked) {
              console.log('[Teemer Optimizer] Select debug -> active menu click confirmed selection.');
              return true;
            }

            return isLabNameMatch(afterText, textToMatch);
          }

          // No change callback present: still try active menu click to mimic user behavior.
          const forceClicked = forceSelectmenuItemClick($select, textToMatch);
          if (forceClicked) {
            return true;
          }
        }
      } catch (e) {
        console.warn(`[Teemer Optimizer] Direct selectmenu update failed for ${selectDebugId}, falling back to native event.`, e);
      }
    }

    // Fallback: update natively if selectmenu is not present or direct execution failed
    console.log(`[Teemer Optimizer] Falling back to native event trigger for ${selectDebugId}`);
    triggerEvents(selectEl, ['change', 'input']);
    const afterIndex = selectEl.selectedIndex;
    const afterText = afterIndex >= 0 && selectEl.options[afterIndex]
      ? selectEl.options[afterIndex].text
      : '(none)';
    console.log(`[Teemer Optimizer] Select debug -> after selected (native path): "${afterText}"`);
    return true;
  }

  function writeEmailBodyToEditor(editor, patientName, xmlCode, manualSend = true) {
    function finalizeEmailSend() {
      if (manualSend) {
        console.log('[Teemer Optimizer] Manual send is enabled. Please click "Versenden" manually.');
        stopAutomation(true);
        return;
      }

      const sent = clickDialogButton('Neue Nachricht', 'Versenden');
      if (sent) {
        stopAutomation(true);
      }
    }

    const safeName = escapeHtml(patientName || '');
    const safeXml = escapeHtml(xmlCode || '');
    const mailHtml = `Hallo,<br/>anbei die XML unseres Patienten ${safeName}<br/><br/>${safeXml}<br/><br/>Mit freundlichen Gr\u00fc\u00dfen<br/>Praxis Dr. Karst`;

    editor.value(mailHtml);
    editor.trigger('change');
    console.log('[Teemer Optimizer] Custom XML email text written directly to editor.');

    finalizeEmailSend();
  }

  // --- STATE CONTROLLER / ENGINE ---

  function updateStatusBar(step, totalSteps, msg) {
    let statusBar = document.getElementById(STATUS_BAR_ID);
    if (!statusBar) {
      createStatusBar();
      statusBar = document.getElementById(STATUS_BAR_ID);
    }
    if (!statusBar) return;
    statusBar.style.display = 'block';

    const progressBar = statusBar.querySelector('.tm-status-progress-bar');
    const msgEl = statusBar.querySelector('.tm-status-msg');
    const nextBtn = statusBar.querySelector('.tm-status-next');
    const cancelBtn = statusBar.querySelector('.tm-status-cancel');

    if (progressBar) {
      const percentage = (step / totalSteps) * 100;
      progressBar.style.width = `${percentage}%`;
    }
    if (msgEl) {
      msgEl.textContent = msg;
    }

    const isPaused = sessionStorage.getItem(STATE_KEYS.PAUSED) === 'true';
    const isActive = sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true';
    if (nextBtn) {
      if (isPaused && isActive) {
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

  function runStepCheck(step, checkName, predicate, failMessage, options = {}) {
    let passed = false;
    try {
      passed = Boolean(predicate());
    } catch (error) {
      console.warn(`[Teemer Optimizer] Check "${checkName}" threw an error:`, error);
      passed = false;
    }

    if (passed) {
      sessionStorage.setItem(STATE_KEYS.LAST_CHECK, `${step}:${checkName}:ok`);
      sessionStorage.removeItem(STATE_KEYS.LAST_ERROR);
      resetStepRetryCount(step);
      console.log(`[Teemer Optimizer] Check OK (${checkName}) on step ${step}.`);
      return true;
    }

    const retryCount = incrementStepRetryCount(step);
    const displayStep = getDisplayStep(step);
    const stepLabel = getDebugStepLabel(step);
    sessionStorage.setItem(STATE_KEYS.LAST_CHECK, `${step}:${checkName}:fail`);
    sessionStorage.setItem(STATE_KEYS.LAST_ERROR, failMessage);

    console.warn(`[Teemer Optimizer] Check FAILED (${checkName}) on step ${stepLabel}: ${failMessage}. Retry ${retryCount}/${MAX_STEP_RETRIES}`);

    if (retryCount >= MAX_STEP_RETRIES) {
      stopAutomation(false, `Schritt ${stepLabel} fehlgeschlagen: ${failMessage}`);
      return false;
    }

    const isDebugMode = sessionStorage.getItem(STATE_KEYS.DEBUG_MODE) === 'true';
    if (isDebugMode) {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'true');
      updateStatusBar(displayStep, 11, `Check fehlgeschlagen (${checkName}) ${retryCount}/${MAX_STEP_RETRIES}. Bitte prüfen.`);
    } else {
      updateStatusBar(displayStep, 11, `Check fehlgeschlagen (${checkName}) ${retryCount}/${MAX_STEP_RETRIES}. Wiederhole...`);
    }

    sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));

    if (typeof options.onFailStep === 'number' && options.onFailStep !== step) {
      advanceStep(options.onFailStep);
    }

    return false;
  }

  function getDisplayStep(step) {
    if (step === 20 || step === 21) return 2;
    if (step === 50 || step === 51) return 5;
    if (step >= 110 && step <= 112) return 11;
    return step;
  }

  function getDebugStepLabel(step) {
    const stepLabels = {
      20: '2d',
      21: '2c',
      50: '5a',
      51: '5b',
      110: '11a',
      111: '11b',
      112: '11c-11e'
    };
    return stepLabels[step] || String(step);
  }

  function stopAutomation(success = false, errorMsg = '') {
    sessionStorage.removeItem(STATE_KEYS.ACTIVE);
    sessionStorage.removeItem(STATE_KEYS.STEP);
    sessionStorage.removeItem(STATE_KEYS.PLAN_TYPE);
    sessionStorage.removeItem(STATE_KEYS.PLAN_TYPE_TEXT);
    sessionStorage.removeItem(STATE_KEYS.LAB_NAME);
    sessionStorage.removeItem(STATE_KEYS.LAB_VALUE);
    sessionStorage.removeItem(STATE_KEYS.DESCRIPTION);
    sessionStorage.removeItem(STATE_KEYS.ORDER_NUMBER);
    sessionStorage.removeItem(STATE_KEYS.PATIENT_NAME);
    sessionStorage.removeItem(STATE_KEYS.STEP_TIMESTAMP);
    sessionStorage.removeItem(STATE_KEYS.LAST_EXEC_TS);
    sessionStorage.removeItem(STATE_KEYS.DEBUG_MODE);
    sessionStorage.removeItem(STATE_KEYS.PAUSED);
    sessionStorage.removeItem(STATE_KEYS.MANUAL_EMAIL_SEND);
    sessionStorage.removeItem(STATE_KEYS.MAIL_MODAL_WAIT_ATTEMPTS);
    sessionStorage.removeItem(STATE_KEYS.LAST_CHECK);
    sessionStorage.removeItem(STATE_KEYS.LAST_ERROR);
    clearRetryState();
    emailStarted = false;

    const statusBar = document.getElementById(STATUS_BAR_ID);
    if (statusBar) {
      if (success) {
        updateStatusBar(11, 11, 'Erfolgreich abgeschlossen!');
        setTimeout(() => { statusBar.remove(); }, 3000);
      } else {
        updateStatusBar(0, 11, errorMsg || 'Abgebrochen.');
        const cancelBtn = statusBar.querySelector('.tm-status-cancel');
        if (cancelBtn) cancelBtn.textContent = 'Schließen';
      }
    }
  }

  function advanceStep(nextStep) {
    sessionStorage.setItem(STATE_KEYS.STEP, String(nextStep));
    sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
    resetStepRetryCount(nextStep);
    console.log(`[Teemer Optimizer] Advancing to Step ${nextStep}`);

    const isDebugMode = sessionStorage.getItem(STATE_KEYS.DEBUG_MODE) === 'true';
    if (isDebugMode) {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'true');
      const displayStep = getDisplayStep(nextStep);
      updateStatusBar(Math.max(0, displayStep - 1), 11, `Bereit für Schritt ${getDebugStepLabel(nextStep)}.`);
    } else {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'false');
      setTimeout(executeStep, STEP_ADVANCE_DELAY_MS);
    }
  }

  function checkTimeout() {
    const timestamp = sessionStorage.getItem(STATE_KEYS.STEP_TIMESTAMP);
    if (timestamp && (Date.now() - parseInt(timestamp, 10)) > STEP_TIMEOUT_MS) {
      console.error('[Teemer Optimizer] Step timeout exceeded.');
      stopAutomation(false, 'Fehler: Zeitüberschreitung bei diesem Schritt.');
      return true;
    }
    return false;
  }

  function executeStep() {
    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) !== 'true') return;
    if (sessionStorage.getItem(STATE_KEYS.PAUSED) === 'true') return; // Do nothing if paused
    const isDebugMode = sessionStorage.getItem(STATE_KEYS.DEBUG_MODE) === 'true';

    // In non-debug mode, throttle execution to avoid mutation-trigger storms.
    if (!isDebugMode) {
      const now = Date.now();
      const lastExecTs = parseInt(sessionStorage.getItem(STATE_KEYS.LAST_EXEC_TS) || '0', 10);
      if (lastExecTs > 0 && (now - lastExecTs) < NON_DEBUG_EXEC_THROTTLE_MS) {
        return;
      }
      sessionStorage.setItem(STATE_KEYS.LAST_EXEC_TS, String(now));
    }
    
    // If Wicket's AJAX indicator is active/visible, wait for the request to complete
    const wicketIndicator = document.getElementById('wicket-ajax-indicator');
    if (wicketIndicator && wicketIndicator.style.display !== 'none') {
      console.log('[Teemer Optimizer] Wicket AJAX indicator is active. Waiting...');
      // Reset the safety timeout timestamp so we don't timeout while Wicket is busy loading
      sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
      return;
    }

    if (checkTimeout()) return;

    const step = parseInt(sessionStorage.getItem(STATE_KEYS.STEP) || '1', 10);
    const planType = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE);
    const planTypeText = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE_TEXT);
    const labName = sessionStorage.getItem(STATE_KEYS.LAB_NAME);
    const labValue = sessionStorage.getItem(STATE_KEYS.LAB_VALUE);
    const description = sessionStorage.getItem(STATE_KEYS.DESCRIPTION);
    const patientName = sessionStorage.getItem(STATE_KEYS.PATIENT_NAME);

    console.log(`[Teemer Optimizer] Executing Step ${step}...`);

    switch (step) {
      case 1:
        updateStatusBar(1, 11, 'Schritt 1: "Plan beauftragen" wird geklickt...');
        const planBeauftragenBtn = findElementByText('a.treatment-action', 'Plan beauftragen');
        if (planBeauftragenBtn) {
          planBeauftragenBtn.click();
          advanceStep(2);
        }
        break;

      case 2:
        updateStatusBar(2, 11, 'Schritt 2: Planungsdetails ausfüllen...');
        const planForm = document.querySelector('form.planDetails');
        if (planForm) {
          // 2a. Select plan type radio
          const planRadio = planForm.querySelector(`input[name="planTypeRadioButtonGroup"][value="${planType}"]`);
          if (planRadio) {
            planRadio.checked = true;
            triggerEvents(planRadio, ['click', 'change']);
          }

          // 2b. Fill description textarea
          const descTextarea = planForm.querySelector('textarea[name="description"]');
          if (descTextarea) {
            descTextarea.value = description;
            triggerEvents(descTextarea, ['input', 'change']);
          }

          advanceStep(21);
        }
        break;

      case 21:
        updateStatusBar(2, 11, 'Schritt 2c: "Erstellen" im Plan-Modal klicken...');
        if (isDialogVisible('Plan beauftragen')) {
          const created = clickDialogButton('Plan beauftragen', 'Erstellen');
          if (created) {
            advanceStep(20); // Intermediate step: wait for modal to close and click "Zur Planung"
          }
        }
        break;

      case 20: // Wait for Modal Close & Click "Zur Planung"
        updateStatusBar(2, 11, 'Schritt 2d: Navigiere zur Planung...');
        if (!isDialogVisible('Plan beauftragen')) {
          const zurPlanungBtn = findElementByText('a.treatment-action', 'Zur Planung');
          if (!runStepCheck(20, 'Zur Planung sichtbar', () => !!zurPlanungBtn, 'Button "Zur Planung" wurde nach Plan-Erstellung nicht gefunden.')) {
            break;
          }
          if (zurPlanungBtn) {
            zurPlanungBtn.click();
            advanceStep(3);
          }
        }
        break;

      case 3:
        updateStatusBar(3, 11, 'Schritt 3: Plan in Bearbeitungsliste identifizieren...');
        // Find column widget "Beauftragt / In Bearbeitung"
        const planColumn = Array.from(document.querySelectorAll('.nubo-light-widget')).find(widget => {
          const title = widget.querySelector('.title');
          return title && title.textContent.trim() === 'Beauftragt / In Bearbeitung';
        });

        if (planColumn) {
          const items = planColumn.querySelectorAll('.workflow-item');
          const matchingItem = Array.from(items).find(item => {
            const text = item.textContent.trim();
            // Match description & patient name (which is why we captured it at start)
            return text.includes(description) && text.includes(patientName);
          });

          if (matchingItem) {
            const link = matchingItem.querySelector('.nubo-clickable-image-label-box');
            if (link) {
              link.click();
              advanceStep(4);
            }
          }
        }
        break;

      case 4:
        updateStatusBar(4, 11, 'Schritt 4: Laborauftrag erstellen...');
        const createLabBtn = findElementByText('.nubo-button', 'Laborauftrag erstellen');
        if (createLabBtn) {
          createLabBtn.click();
          advanceStep(50);
        }
        break;

      case 50:
        updateStatusBar(5, 11, 'Schritt 5a: Labor auswählen...');
        
        // Find and highlight strictly "Labor" label in the dialog (ignoring Laborauftragsart)
        const laborDialog = findDialogByTitle('Laborauftrag erstellen');
        const modalLabels = Array.from((laborDialog || document).querySelectorAll('label'));
        const labLabel = modalLabels.find(el => {
          const text = el.textContent.replace(':', '').trim().toLowerCase();
          return text === 'labor';
        });
        // Highlighting disabled on request.
        // if (labLabel) {
        //   labLabel.style.backgroundColor = 'yellow';
        //   labLabel.style.color = 'black';
        //   labLabel.style.border = '2px solid red';
        //   labLabel.style.padding = '2px';
        //   console.log('[Teemer Optimizer] Highlighted the correct "Labor" label in the modal.');
        // }

        console.log(`[Teemer Optimizer] Step 5 - target lab name to select: "${labName}"`);

        // Find the actual labor field inside the modal first. Some plan types also expose a global labChoice
        // outside the dialog, but that field is not the one that drives the modal submission.
        let labSelect = laborDialog ? findSelectByExactLabel(laborDialog, 'Labor') : null;
        if (!labSelect && laborDialog) {
          labSelect = findSelectByOptionText(laborDialog, labName);
        }
        if (!labSelect && labLabel) {
          const parentRow = labLabel.closest('.pxs-formlayout__row, .nubo-form-input-container, div');
          if (parentRow) {
            labSelect = parentRow.querySelector('select');
          }
        }

        if (!labSelect && laborDialog) {
          labSelect = laborDialog.querySelector('select[name*="labChoice"]');
        }

        if (!labSelect) {
          labSelect = document.querySelector('select[name*="labChoice"]');
        }

        if (!labSelect) {
          const fallbackSelects = Array.from(document.querySelectorAll('select.pxs-dropdownchoice, select'));
          console.log('[Teemer Optimizer] Step 5 fallback select scan:', fallbackSelects.map(summarizeSelectCandidate));
          labSelect = fallbackSelects.find((selectEl) => {
            return Array.from(selectEl.options || []).some((option) => isLabNameMatch(option.text, labName));
          }) || null;
        }

        console.log('[Teemer Optimizer] labSelect element located:', !!labSelect);

        if (labSelect) {
          const selected = selectDropdownOption(labSelect, labName);
          if (selected) {
            sessionStorage.setItem(STATE_KEYS.LAB_VALUE, String(labSelect.value || ''));
            const selectedText = getSelectedOptionText(labSelect);
            const visibleText = getSelectmenuVisibleText(labSelect);
            const isConfirmed = runStepCheck(
              50,
              'Laborauswahl bestätigt',
              () => {
                const hiddenMatches = isLabNameMatch(selectedText, labName);
                const visibleMatches = !visibleText || isLabNameMatch(visibleText, labName);
                return hiddenMatches && visibleMatches;
              },
              `Labor nicht gesetzt. Hidden: "${selectedText || '-'}", Visible: "${visibleText || '-'}", erwartet: "${labName}".`
            );
            if (!isConfirmed) {
              break;
            }
            setTimeout(() => advanceStep(51), 400);
          }
        }
        break;

      case 51:
        updateStatusBar(5, 11, 'Schritt 5b: "Erstellen" im Laborauftrag-Modal klicken...');
        if (isDialogVisible('Laborauftrag erstellen')) {
          const laborDialog = findDialogByTitle('Laborauftrag erstellen');
          let selectedLabEl = laborDialog ? findSelectByExactLabel(laborDialog, 'Labor') : null;
          if (!selectedLabEl && laborDialog) {
            selectedLabEl = findSelectByOptionText(laborDialog, labName);
          }
          if (!selectedLabEl && laborDialog) {
            selectedLabEl = laborDialog.querySelector('select[name*="labChoice"]');
          }
          if (!selectedLabEl) {
            console.log('[Teemer Optimizer] Step 5b: no lab select found yet, waiting for dialog to settle...');
            setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            break;
          }

          const selectedText = getSelectedOptionText(selectedLabEl);
          const visibleText = getSelectmenuVisibleText(selectedLabEl);
          if (!isLabNameMatch(selectedText, labName) || (visibleText && !isLabNameMatch(visibleText, labName))) {
            console.log(`[Teemer Optimizer] Step 5b: labor not settled yet. Hidden: "${selectedText || '-'}", Visible: "${visibleText || '-'}", expected: "${labName}". Retrying...`);
            sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
            setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            break;
          }

          if (!runStepCheck(
            51,
            'Labor vor Erstellen korrekt',
            () => isLabNameMatch(getSelectedOptionText(selectedLabEl), labName) && (!getSelectmenuVisibleText(selectedLabEl) || isLabNameMatch(getSelectmenuVisibleText(selectedLabEl), labName)),
            `Labor ist vor Erstellen nicht korrekt gesetzt (erwartet "${labName}").`
          )) {
            break;
          }

          const created = clickDialogButton('Laborauftrag erstellen', 'Erstellen');
          if (created) {
            advanceStep(6);
          }
        }
        break;

      case 6:
        updateStatusBar(6, 11, 'Schritt 6: Erstellten Laborauftrag öffnen...');
        
        let labOrderLink = null;
        
        // 1. Try to find the link in the sibling container of the "Laborauftrag erstellen" button
        const createBtn = findElementByText('.nubo-button', 'Laborauftrag erstellen');
        if (createBtn) {
          const sibling = createBtn.nextElementSibling;
          if (sibling) {
            // Find any anchor tag that has text (represents the created lab order)
            labOrderLink = Array.from(sibling.querySelectorAll('a')).find(a => {
              return a.textContent.trim().length > 0;
            });
          }
        }
        
        // 2. Fallback to fuzzy lab name matching in the whole document
        if (!labOrderLink) {
          labOrderLink = Array.from(document.querySelectorAll('a, .nubo-button, td, div.workflow-item, span')).find(el => {
            const text = el.textContent.trim();
            if (text.includes('Laborauftrag erstellen') || el.closest('.ui-dialog')) return false;
            return isLabNameMatch(text, labName) && (el.tagName === 'A' || el.closest('a'));
          });
        }

        if (labOrderLink) {
          const clickTarget = labOrderLink.tagName === 'A' ? labOrderLink : labOrderLink.closest('a');
          if (clickTarget) {
            clickTarget.click();
            advanceStep(7);
          }
        }
        break;

      case 7:
        updateStatusBar(7, 11, 'Schritt 7: Laborauftrag beauftragen...');
        const beauftragenBtn = findElementByText('a', 'Beauftragen');
        if (beauftragenBtn && beauftragenBtn.closest('.nubo-light-widget-content')) {
          beauftragenBtn.click();
          advanceStep(8);
        }
        break;

      case 8:
        updateStatusBar(8, 11, 'Schritt 8: Auftragsnummer extrahieren...');
        const auftragsTh = findElementByText('th', 'Auftragsnummer');
        if (auftragsTh) {
          const siblingTd = auftragsTh.nextElementSibling;
          if (siblingTd) {
            const numSpan = siblingTd.querySelector('span');
            const orderNum = (numSpan ? numSpan.textContent : siblingTd.textContent).trim();
            if (orderNum) {
              if (!runStepCheck(
                8,
                'Auftragsnummer plausibel',
                () => /^[A-Za-z0-9\-/.]{4,}$/.test(orderNum),
                `Auftragsnummer ist unplausibel: "${orderNum}".`
              )) {
                break;
              }

              sessionStorage.setItem(STATE_KEYS.ORDER_NUMBER, orderNum);
              console.log(`[Teemer Optimizer] Extracted Order Number: ${orderNum}`);

              // Navigate back to "Behandlung" via subheader breadcrumbs
              const behBreadcrumb = document.querySelector('a.nav__item__trigger[title^="Beh:"]');
              if (!runStepCheck(8, 'Breadcrumb Behandlung vorhanden', () => !!behBreadcrumb, 'Rücknavigation zur Behandlung nicht möglich (Breadcrumb fehlt).')) {
                break;
              }
              if (behBreadcrumb) {
                behBreadcrumb.click();
                advanceStep(9);
              }
            }
          }
        }
        break;

      case 9:
        updateStatusBar(9, 11, 'Schritt 9: Dokumentenfilter "PDF" aktivieren...');
        const documentsInput = document.querySelector('input[name*="mediaRadio"][value="DOCUMENTS"]');
        if (documentsInput) {
          console.log('[Teemer Optimizer] Step 9: Found documents radio input, checking it.');
          documentsInput.checked = true;
          triggerEvents(documentsInput, ['click', 'change']);
          advanceStep(10);
        } else {
          const pdfLabel = document.querySelector('label[title="PDF"], label[for*="DOCUMENTS"]');
          if (pdfLabel) {
            console.log('[Teemer Optimizer] Step 9: Found PDF filter label, clicking it.');
            pdfLabel.click();
            advanceStep(10);
          } else {
            console.log('[Teemer Optimizer] Step 9: PDF filter elements not found.');
          }
        }
        break;

      case 10:
        updateStatusBar(10, 11, 'Schritt 10: Datei per E-Mail versenden...');
        if (clickMailSendFromFirstDocument()) {
          sessionStorage.setItem(STATE_KEYS.MAIL_MODAL_WAIT_ATTEMPTS, '0');
          setTimeout(() => advanceStep(110), STEP_ADVANCE_DELAY_MS);
        }
        break;

      case 110:
        {
          const favoritesSelect = document.querySelector('select[name*="mailFavoritesChoice"]');

          if (!favoritesSelect) {
            const waitAttempts = parseInt(sessionStorage.getItem(STATE_KEYS.MAIL_MODAL_WAIT_ATTEMPTS) || '0', 10) + 1;
            sessionStorage.setItem(STATE_KEYS.MAIL_MODAL_WAIT_ATTEMPTS, String(waitAttempts));

            updateStatusBar(11, 11, `Schritt 11a: Warte auf E-Mail-Modal... (${waitAttempts})`);

            // Re-trigger opening occasionally in case the first click hit a non-actionable child element.
            if (waitAttempts % 8 === 0) {
              console.log('[Teemer Optimizer] Step 11a: Modal not visible yet, re-triggering E-Mail modal open...');
              clickMailSendFromFirstDocument();
            }

            // Fail safely instead of endless looping if the modal cannot be opened.
            if (waitAttempts >= 80) {
              stopAutomation(false, 'E-Mail-Modal konnte nicht geöffnet werden. Bitte manuell prüfen.');
              break;
            }

            // Keep the timeout watchdog alive while Wicket finishes opening/rendering the dialog.
            sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
            setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            break;
          }

          sessionStorage.setItem(STATE_KEYS.MAIL_MODAL_WAIT_ATTEMPTS, '0');

          updateStatusBar(11, 11, 'Schritt 11a: Favorit/Labor auswählen...');

          // 11a. Check if favorites choice has the lab selected.
          const favText = favoritesSelect.options[favoritesSelect.selectedIndex].text;
          if (!favText.includes(labName)) {
            console.log(`[Teemer Optimizer] Step 11: Selecting favorite: ${labName}`);
            const selected = selectDropdownOption(favoritesSelect, labName);
            if (!selected) break;
            break;
          }

          if (!runStepCheck(
            110,
            'Favorit/Labor gesetzt',
            () => isLabNameMatch(getSelectedOptionText(favoritesSelect), labName),
            `Favoriten-Dropdown steht nicht auf "${labName}".`
          )) {
            break;
          }

          advanceStep(111);
        }
        break;

      case 111:
        {
          updateStatusBar(11, 11, 'Schritt 11b: E-Mail-Editor vorbereiten...');
          const $editor = window.jQuery('textarea[name="wrapper:message"]');
          const editor = $editor.data('kendoEditor');

          if (!runStepCheck(
            111,
            'E-Mail-Editor verf\u00fcgbar',
            () => !!editor,
            'E-Mail-Editor wurde noch nicht initialisiert.'
          )) {
            sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
            setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            break;
          }

          advanceStep(112);
        }
        break;

      case 112:
        {
          if (emailStarted) break;
          updateStatusBar(11, 11, 'Schritt 11c-11e: Anhänge, Auftragsnummer, Versenden...');

          const orderNum = sessionStorage.getItem(STATE_KEYS.ORDER_NUMBER);
          if (!runStepCheck(
            112,
            'Auftragsnummer vorhanden',
            () => !!orderNum && orderNum.trim().length > 0,
            'Keine Auftragsnummer vorhanden. E-Mail wird nicht versendet.'
          )) {
            break;
          }

          // Mark email processing as started so we don't repeat the configuration logic
          emailStarted = true;

          const isManualEmailSend = sessionStorage.getItem(STATE_KEYS.MANUAL_EMAIL_SEND) !== 'false';
          setTimeout(() => {
            // Set email subject to "XML"
            const subjectInput = document.querySelector('input[name="subject"]');
            if (subjectInput) {
              subjectInput.value = 'XML';
              triggerEvents(subjectInput, ['input', 'change']);
              console.log('[Teemer Optimizer] Email subject set to: XML');
            }

            // 11c. Programmatically clear "Anamnese.pdf" from Kendo MultiSelect
            const $attachments = window.jQuery('select[name="attachments"]');
            const multiSelect = $attachments.data('kendoMultiSelect');
            if (multiSelect) {
              const dataItems = multiSelect.dataItems();
              const valuesToKeep = [];
              for (let i = 0; i < dataItems.length; i++) {
                if (dataItems[i].externalFileName !== 'Anamnese.pdf') {
                  valuesToKeep.push(dataItems[i].businessKey);
                }
              }
              multiSelect.value(valuesToKeep);
              multiSelect.trigger('change');
            }

            // 11d. Insert order number in Kendo Editor after template text loads
            const $editor = window.jQuery('textarea[name="wrapper:message"]');
            const editor = $editor.data('kendoEditor');
            if (editor) {
              writeEmailBodyToEditor(editor, patientName, orderNum, isManualEmailSend);
            } else {
              console.log('[Teemer Optimizer] Kendo Editor not found on textarea[name="wrapper:message"]');
              emailStarted = false;
              sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
              setTimeout(executeStep, RETRY_WAIT_DELAY_MS);
            }
          }, 1000); // 1000ms delay to let Wicket process favorites/text block AJAX updates
        }
        break;
    }
  }

  // --- UI INJECTION ---

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
            <span class="ui-button-icon-space"> </span>
          </button>
        </div>
        <div class="ui-dialog-content ui-widget-content">
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label">
              <label for="tm-select-plan">Plan</label>
            </div>
            <div class="pxs-formlayout__row__field">
              <select id="tm-select-plan" class="ui-corner-all ui-widget ui-widget-content">
                <option value="HKP">Heil- und Kostenplan</option>
                <option value="HKPR">Zahnersatz-Reparaturen</option>
                <option value="HKPBG">Zahnersatz-Plan / Berufsgenossenschaft</option>
                <option value="KBR">Kieferbruch-Plan</option>
                <option value="ACA">Mehrkostenvereinbarung</option>
              </select>
            </div>
          </div>
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label">
              <label for="tm-select-labor">Labor</label>
            </div>
            <div class="pxs-formlayout__row__field">
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
          </div>
          <div class="pxs-formlayout__row">
            <div class="pxs-formlayout__row__label">
              <label for="tm-textarea-desc">Beschreibung</label>
            </div>
            <div class="pxs-formlayout__row__field">
              <textarea id="tm-textarea-desc" class="ui-corner-all ui-widget ui-widget-content" placeholder="Notizen für Planungsauftrag (z.B. OK Proth. gebrochen)"></textarea>
            </div>
          </div>
          <div class="pxs-formlayout__row" style="display:flex; flex-direction:row; align-items:center; gap:8px; margin-top: 14px;">
            <input type="checkbox" id="tm-checkbox-debug" style="width:auto; margin:0;" />
            <label for="tm-checkbox-debug" style="margin-bottom:0; cursor:pointer;">Debug Mode (Schrittweise)</label>
          </div>
          <div class="pxs-formlayout__row" style="display:flex; flex-direction:row; align-items:center; gap:8px; margin-top: 10px;">
            <input type="checkbox" id="tm-checkbox-dev-email" checked style="width:auto; margin:0;" />
            <label for="tm-checkbox-dev-email" style="margin-bottom:0; cursor:pointer;">E-Mail manuell absenden</label>
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

    // Modal Events
    const closeBtn = modal.querySelector('.ui-dialog-titlebar-close');
    closeBtn.addEventListener('click', () => modal.classList.remove('is-open'));
    
    const cancelBtn = modal.querySelector('.tm-cancel-btn');
    cancelBtn.addEventListener('click', () => modal.classList.remove('is-open'));

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('is-open');
    });

    const submitBtn = modal.querySelector('.tm-submit-btn');
    submitBtn.addEventListener('click', () => {
      const planSelect = modal.querySelector('#tm-select-plan');
      const laborSelect = modal.querySelector('#tm-select-labor');
      const descTextarea = modal.querySelector('#tm-textarea-desc');
      const debugCheckbox = modal.querySelector('#tm-checkbox-debug');
      const devEmailCheckbox = modal.querySelector('#tm-checkbox-dev-email');

      const planVal = planSelect.value;
      const planText = planSelect.options[planSelect.selectedIndex].text;
      const labVal = laborSelect.value;
      const descVal = descTextarea.value.trim() || 'XML Plan';
      const isDebugChecked = debugCheckbox ? debugCheckbox.checked : false;
      const isManualEmailChecked = devEmailCheckbox ? devEmailCheckbox.checked : true;
      const patient = getPatientName();

      if (!patient) {
        alert('Fehler: Der Patientenname konnte nicht ermittelt werden.');
        return;
      }

      // Initialize state storage for engine run
      sessionStorage.setItem(STATE_KEYS.ACTIVE, 'true');
      sessionStorage.setItem(STATE_KEYS.STEP, '1');
      sessionStorage.setItem(STATE_KEYS.PLAN_TYPE, planVal);
      sessionStorage.setItem(STATE_KEYS.PLAN_TYPE_TEXT, planText);
      sessionStorage.setItem(STATE_KEYS.LAB_NAME, labVal);
      sessionStorage.setItem(STATE_KEYS.DESCRIPTION, descVal);
      sessionStorage.setItem(STATE_KEYS.PATIENT_NAME, patient);
      sessionStorage.setItem(STATE_KEYS.DEBUG_MODE, String(isDebugChecked));
      sessionStorage.setItem(STATE_KEYS.MANUAL_EMAIL_SEND, String(isManualEmailChecked));
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'false');
      sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));

      modal.classList.remove('is-open');

      // Build and show the status bar
      createStatusBar();
      updateStatusBar(1, 11, 'Starte XML Workflow-Automatisierung...');

      // Trigger first execution
      setTimeout(executeStep, 500);
    });

    // Initialize jQuery UI button widgets for native skins
    if (window.jQuery && typeof window.jQuery.fn.button === 'function') {
      window.jQuery(modal.querySelectorAll('.ui-button')).button();
    }

    document.body.appendChild(modal);
  }

  function createStatusBar() {
    if (document.getElementById(STATUS_BAR_ID)) return;

    const statusBar = document.createElement('div');
    statusBar.id = STATUS_BAR_ID;
    statusBar.innerHTML = `
      <div class="tm-status-header">
        <span>XML-Automatisierung läuft</span>
      </div>
      <div class="tm-status-progress">
        <div class="tm-status-progress-bar"></div>
      </div>
      <div class="tm-status-msg">Bereite vor...</div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="tm-status-next" style="display:none; flex:1;">nächster Schritt</button>
        <button type="button" class="tm-status-cancel" style="width:100%;">Abbrechen</button>
      </div>
    `;

    const cancelBtn = statusBar.querySelector('.tm-status-cancel');
    cancelBtn.addEventListener('click', () => {
      if (cancelBtn.textContent === 'Schließen') {
        statusBar.remove();
      } else {
        stopAutomation(false, 'Durch Benutzer abgebrochen.');
      }
    });

    const nextBtn = statusBar.querySelector('.tm-status-next');
    nextBtn.addEventListener('click', () => {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'false');
      sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));
      nextBtn.style.display = 'none';
      if (cancelBtn) {
        cancelBtn.style.width = '100%';
        cancelBtn.style.flex = 'none';
      }
      executeStep();
    });

    document.body.appendChild(statusBar);
  }

  function injectXmlButton() {
    // Only inject on the treatment dashboard page where "Plan beauftragen" is present
    const planBeauftragenBtn = findElementByText('a', 'Plan beauftragen');
    if (!planBeauftragenBtn) return;

    const aktionenLegend = findElementByText('fieldset.nubo-frm__fieldset legend', 'Aktionen', false);
    if (!aktionenLegend) return;

    const fieldset = aktionenLegend.closest('fieldset');
    if (!fieldset) return;

    if (document.getElementById('tm-xml-trigger')) return;

    const schnellContainer = Array.from(fieldset.querySelectorAll('.pxs-splitbutton')).find(el => {
      return el.textContent.includes('Schnellabrechnung');
    });

    const button = document.createElement('a');
    button.id = 'tm-xml-trigger';
    button.className = 'treatment-action nubo-100';
    button.style.marginTop = '0.5em';
    button.style.display = 'block';
    button.style.textAlign = 'center';
    button.style.cursor = 'pointer';
    button.textContent = 'XML versenden';

    button.addEventListener('click', () => {
      createModal();
      const modal = document.getElementById(MODAL_ID);
      if (modal) {
        modal.classList.add('is-open');
      }
    });

    if (schnellContainer) {
      schnellContainer.parentNode.insertBefore(button, schnellContainer);
    } else {
      fieldset.appendChild(button);
    }

    // Apply native jQuery UI button styling to match other buttons (gray bg, outline, etc.)
    if (window.jQuery && typeof window.jQuery.fn.button === 'function') {
      window.jQuery(button).button({ "icon": "", "disabled": false, "showLabel": true });
    }
  }

  function ensureStatusBarIsRestored() {
    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) !== 'true') return;
    
    let statusBar = document.getElementById(STATUS_BAR_ID);
    if (!statusBar) {
      console.log('[Teemer Optimizer] Status bar element missing. Recreating...');
      createStatusBar();
      statusBar = document.getElementById(STATUS_BAR_ID);
      if (statusBar) {
        const step = parseInt(sessionStorage.getItem(STATE_KEYS.STEP) || '1', 10);
        const isPaused = sessionStorage.getItem(STATE_KEYS.PAUSED) === 'true';
        console.log(`[Teemer Optimizer] Restored status bar. Step: ${step}, Paused: ${isPaused}`);
        if (isPaused) {
          updateStatusBar(step - 1, 11, `Bereit für Schritt ${step}.`);
        } else {
          updateStatusBar(step - 1, 11, 'Warte auf nächsten Schritt...');
        }
      }
    }
  }

  function runAutomationTick() {
    injectXmlButton();
    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
      ensureStatusBarIsRestored();
      executeStep();
    }
  }

  function scheduleAutomationTick(delay = DOM_SETTLE_DELAY_MS) {
    if (scheduledTickHandle) {
      clearTimeout(scheduledTickHandle);
    }
    scheduledTickHandle = setTimeout(() => {
      scheduledTickHandle = null;
      runAutomationTick();
    }, delay);
  }

  function startDomObserver() {
    if (domObserver || !document.body) return;

    domObserver = new MutationObserver((mutationList) => {
      if (!mutationList || mutationList.length === 0) return;

      for (const mutation of mutationList) {
        if (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          scheduleAutomationTick();
          return;
        }
      }
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // --- INITIALIZATION ---

  function init() {
    console.log('[Teemer Optimizer] Page initialized. URL:', window.location.href);
    injectStyles();
    createModal();
    startDomObserver();

    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
      console.log('[Teemer Optimizer] Active automation session detected during init.');
      ensureStatusBarIsRestored();
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
