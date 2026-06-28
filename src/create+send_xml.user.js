// ==UserScript==
// @name         Teemer Workflow Optimizer - XML Versenden
// @namespace    http://tampermonkey.net/
// @version      1.0.7
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
    DEBUG_MODE: 'tm_xml_debug_mode',
    PAUSED: 'tm_xml_paused'
  };

  const STEP_TIMEOUT_MS = 15000; // 15 seconds safety timeout per step
  const MODAL_ID = 'tm-xml-modal';
  const STATUS_BAR_ID = 'tm-xml-status-bar';
  let emailStarted = false;

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
    const cleanEl = elText.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanSelected = selectedLabName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanEl.length < 3) return false;
    
    // Check if one contains the other, or if they share a significant unique word
    if (cleanSelected.includes(cleanEl) || cleanEl.includes(cleanSelected)) {
      return true;
    }
    
    // Also check if any word from selectedLabName (longer than 3 chars) is in elText
    const words = selectedLabName.split(/[\s/]+/);
    for (const word of words) {
      const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanWord.length >= 4 && elText.toLowerCase().includes(cleanWord)) {
        return true;
      }
    }
    return false;
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
    if (nextBtn) {
      if (isPaused && step < 11) {
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
    sessionStorage.removeItem(STATE_KEYS.DEBUG_MODE);
    sessionStorage.removeItem(STATE_KEYS.PAUSED);
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
    console.log(`[Teemer Optimizer] Advancing to Step ${nextStep}`);

    const isDebugMode = sessionStorage.getItem(STATE_KEYS.DEBUG_MODE) === 'true';
    const majorSteps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    if (isDebugMode && majorSteps.includes(nextStep)) {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'true');
      updateStatusBar(nextStep - 1, 11, `Bereit für Schritt ${nextStep}.`);
    } else {
      sessionStorage.setItem(STATE_KEYS.PAUSED, 'false');
      setTimeout(executeStep, 300);
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
    if (checkTimeout()) return;

    const step = parseInt(sessionStorage.getItem(STATE_KEYS.STEP) || '1', 10);
    const planType = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE);
    const planTypeText = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE_TEXT);
    const labName = sessionStorage.getItem(STATE_KEYS.LAB_NAME);
    const labValue = sessionStorage.getItem(STATE_KEYS.LAB_VALUE);
    const description = sessionStorage.getItem(STATE_KEYS.DESCRIPTION);
    const patientName = sessionStorage.getItem(STATE_KEYS.PATIENT_NAME);
    const isDebugMode = sessionStorage.getItem(STATE_KEYS.DEBUG_MODE) === 'true';

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

          // 2c. Click "Erstellen" button in modal
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
          advanceStep(5);
        }
        break;

      case 5:
        updateStatusBar(5, 11, 'Schritt 5: Labor auswählen...');
        const labSelect = document.querySelector('select[name*="labChoice"]');
        if (labSelect) {
          // Select manufacturing lab option
          let optionSelected = false;
          for (let i = 0; i < labSelect.options.length; i++) {
            if (labSelect.options[i].text.includes(labName)) {
              labSelect.selectedIndex = i;
              optionSelected = true;
              break;
            }
          }
          if (optionSelected) {
            triggerEvents(labSelect, ['change']);
            // Click "Erstellen" button in modal
            const created = clickDialogButton('Laborauftrag erstellen', 'Erstellen');
            if (created) {
              advanceStep(6);
            }
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
              sessionStorage.setItem(STATE_KEYS.ORDER_NUMBER, orderNum);
              console.log(`[Teemer Optimizer] Extracted Order Number: ${orderNum}`);

              // Navigate back to "Behandlung" via subheader breadcrumbs
              const behBreadcrumb = document.querySelector('a.nav__item__trigger[title^="Beh:"]');
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
          documentsInput.checked = true;
          triggerEvents(documentsInput, ['click', 'change']);
          advanceStep(10);
        } else {
          const pdfLabel = document.querySelector('label[title="PDF"], label[for*="DOCUMENTS"]');
          if (pdfLabel) {
            pdfLabel.click();
            advanceStep(10);
          }
        }
        break;

      case 10:
        updateStatusBar(10, 11, 'Schritt 10: Datei per E-Mail versenden...');
        const docsContainer = document.querySelector('.patient-docs');
        if (docsContainer) {
          const firstDoc = docsContainer.querySelector('.workflow-item');
          if (firstDoc) {
            const mailBtn = Array.from(firstDoc.querySelectorAll('.imagefile-label, [title="Datei per E-Mail versenden"]')).find(el => {
              return el.title === 'Datei per E-Mail versenden' || el.textContent.includes('E-Mail');
            });
            if (mailBtn) {
              mailBtn.click();
              advanceStep(11);
            }
          }
        }
        break;

      case 11:
        const favoritesSelect = document.querySelector('select[name*="mailFavoritesChoice"]');
        const textElementSelect = document.querySelector('select[name="textElement"]');

        if (favoritesSelect && textElementSelect) {
          if (emailStarted) break;
          emailStarted = true;
          updateStatusBar(11, 11, 'Schritt 11: E-Mail konfigurieren und absenden...');

          // 11a. Select lab in favorites dropdown
          let favoriteFound = false;
          for (let i = 0; i < favoritesSelect.options.length; i++) {
            if (favoritesSelect.options[i].text.includes(labName)) {
              favoritesSelect.selectedIndex = i;
              favoriteFound = true;
              break;
            }
          }
          if (favoriteFound) {
            triggerEvents(favoritesSelect, ['change']);
          }

          // 11b. Select XML text block
          let textBlockFound = false;
          for (let i = 0; i < textElementSelect.options.length; i++) {
            if (textElementSelect.options[i].text.includes('XML')) {
              textElementSelect.selectedIndex = i;
              textBlockFound = true;
              break;
            }
          }
          if (textBlockFound) {
            triggerEvents(textElementSelect, ['change']);
          }

          // Debug Mode / Test Recipient Override
          // Allow Wicket's AJAX handler to complete updating the receiver input, then overwrite it
          setTimeout(() => {
            if (isDebugMode) {
              const receiverInput = document.querySelector('input[name="receiver"]');
              if (receiverInput) {
                receiverInput.value = 'm-seeland@gmx.net';
                triggerEvents(receiverInput, ['input', 'change']);
                console.log('[Teemer Optimizer] Debug Mode Active: Recipient overrode to m-seeland@gmx.net');
              }
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

            // 11d. Insert order number in Kendo Editor
            const orderNum = sessionStorage.getItem(STATE_KEYS.ORDER_NUMBER);
            const $editor = window.jQuery('textarea[name="wrapper:message"]');
            const editor = $editor.data('kendoEditor');
            if (editor) {
              let currentText = editor.value();
              editor.value(currentText + `<br/><br/>Auftragsnummer: ${orderNum}`);
              editor.trigger('change');

              // 11e. Click "Versenden" dialog button
              const sent = clickDialogButton('Neue Nachricht', 'Versenden');
              if (sent) {
                stopAutomation(true);
              }
            } else {
              console.log('[Teemer Optimizer] Kendo Editor not found on textarea[name="wrapper:message"]');
            }
          }, 1000); // 1000ms delay to let Wicket process the favorites change AJAX before overriding receiver
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
            <input type="checkbox" id="tm-checkbox-debug" checked style="width:auto; margin:0;" />
            <label for="tm-checkbox-debug" style="margin-bottom:0; cursor:pointer;">Debug Mode (Schrittweise)</label>
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

      const planVal = planSelect.value;
      const planText = planSelect.options[planSelect.selectedIndex].text;
      const labVal = laborSelect.value;
      const descVal = descTextarea.value.trim() || 'XML Plan';
      const isDebugChecked = debugCheckbox ? debugCheckbox.checked : false;
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

  // --- INITIALIZATION ---

  function init() {
    console.log('[Teemer Optimizer] Page initialized. URL:', window.location.href);
    injectStyles();
    createModal();

    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
      console.log('[Teemer Optimizer] Active automation session detected during init.');
      ensureStatusBarIsRestored();
      executeStep();
    }

    injectXmlButton();

    setInterval(() => {
      injectXmlButton();
      if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
        ensureStatusBarIsRestored();
        executeStep();
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
