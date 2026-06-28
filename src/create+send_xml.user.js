// ==UserScript==
// @name         Teemer Workflow Optimizer - XML Versenden
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Automates plan creation, laboratory orders, order ID extraction, and emailing XML numbers in Teemer.
// @author       Marco Seeland
// @match        http://localhost:9443/praxissteuerung/wicket/*
// @match        http://127.0.0.1:9443/praxissteuerung/wicket/*
// @match        http://localhost:*/praxissteuerung/wicket/*
// @match        http://127.0.0.1:*/praxissteuerung/wicket/*
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
    SAFE_MODE: 'tm_xml_safe_mode'
  };

  const STEP_TIMEOUT_MS = 15000; // 15 seconds safety timeout per step
  const MODAL_ID = 'tm-xml-modal';
  const STATUS_BAR_ID = 'tm-xml-status-bar';

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
      .tm-dialog {
        background: #ffffff;
        border-radius: 16px;
        width: 100%;
        max-width: 440px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        overflow: hidden;
        border: 1px solid rgba(226, 232, 240, 0.8);
        animation: tm-fadeIn 0.25s ease-out;
      }
      @keyframes tm-fadeIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      .tm-header {
        padding: 20px 24px;
        background: #0f172a;
        color: #ffffff;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .tm-header h3 {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 600;
      }
      .tm-close {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 1.5rem;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .tm-close:hover {
        color: #ffffff;
      }
      .tm-body {
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .tm-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .tm-field label {
        font-size: 0.875rem;
        font-weight: 600;
        color: #334155;
      }
      .tm-select, .tm-textarea {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 0.875rem;
        background-color: #ffffff;
        color: #0f172a;
        box-sizing: border-box;
      }
      .tm-select:focus, .tm-textarea:focus {
        border-color: #2563eb;
        outline: none;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }
      .tm-textarea {
        height: 80px;
        resize: vertical;
      }
      .tm-submit {
        width: 100%;
        padding: 12px;
        background: #2563eb;
        color: #ffffff;
        border: none;
        border-radius: 8px;
        font-weight: 700;
        font-size: 0.875rem;
        cursor: pointer;
        transition: background 0.2s;
        margin-top: 8px;
      }
      .tm-submit:hover {
        background: #1d4ed8;
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
      .tm-status-cancel {
        width: 100%;
        background: #dc2626;
        color: #ffffff;
        border: none;
        padding: 8px;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
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

  // --- STATE CONTROLLER / ENGINE ---

  function updateStatusBar(step, totalSteps, msg) {
    const statusBar = document.getElementById(STATUS_BAR_ID);
    if (!statusBar) return;
    statusBar.style.display = 'block';

    const progressBar = statusBar.querySelector('.tm-status-progress-bar');
    const msgEl = statusBar.querySelector('.tm-status-msg');

    if (progressBar) {
      const percentage = (step / totalSteps) * 100;
      progressBar.style.width = `${percentage}%`;
    }
    if (msgEl) {
      msgEl.textContent = msg;
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
    sessionStorage.removeItem(STATE_KEYS.SAFE_MODE);

    const statusBar = document.getElementById(STATUS_BAR_ID);
    if (statusBar) {
      if (success) {
        updateStatusBar(11, 11, 'Erfolgreich abgeschlossen!');
        setTimeout(() => { statusBar.style.display = 'none'; }, 3000);
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
    // Immediately execute the next step loop
    setTimeout(executeStep, 300);
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
    if (checkTimeout()) return;

    const step = parseInt(sessionStorage.getItem(STATE_KEYS.STEP) || '1', 10);
    const planType = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE);
    const planTypeText = sessionStorage.getItem(STATE_KEYS.PLAN_TYPE_TEXT);
    const labName = sessionStorage.getItem(STATE_KEYS.LAB_NAME);
    const labValue = sessionStorage.getItem(STATE_KEYS.LAB_VALUE);
    const description = sessionStorage.getItem(STATE_KEYS.DESCRIPTION);
    const patientName = sessionStorage.getItem(STATE_KEYS.PATIENT_NAME);
    const isSafeMode = sessionStorage.getItem(STATE_KEYS.SAFE_MODE) === 'true';

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
        const modalOpen = document.querySelector('.ui-dialog:has(.ui-dialog-title:contains("Plan beauftragen"))');
        if (!modalOpen || modalOpen.style.display === 'none') {
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
        // Wait for labor modal to close and find the created lab order link in the details widget.
        const labOrderLink = Array.from(document.querySelectorAll('a, .nubo-button, td, div.workflow-item, span')).find(el => {
          const text = el.textContent.trim();
          if (text.includes('Laborauftrag erstellen') || el.closest('.ui-dialog')) return false;
          return text.includes(labName) && (el.tagName === 'A' || el.closest('a'));
        });

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
        updateStatusBar(11, 11, 'Schritt 11: E-Mail konfigurieren und absenden...');
        const favoritesSelect = document.querySelector('select[name*="mailFavoritesChoice"]');
        const textElementSelect = document.querySelector('select[name="textElement"]');

        if (favoritesSelect && textElementSelect) {
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

          // Safe Mode / Test Recipient Override
          // Allow Wicket's AJAX handler to complete updating the receiver input, then overwrite it
          setTimeout(() => {
            if (isSafeMode) {
              const receiverInput = document.querySelector('input[name="receiver"]');
              if (receiverInput) {
                receiverInput.value = 'm-seeland@gmx.net';
                triggerEvents(receiverInput, ['input', 'change']);
                console.log('[Teemer Optimizer] Safe Mode Active: Recipient overrode to m-seeland@gmx.net');
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
            const $editor = window.jQuery('#id13ce');
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
            }
          }, 800); // 800ms delay to let Wicket process the favorites change AJAX before overriding receiver
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
      <div class="tm-dialog" role="dialog" aria-modal="true" aria-labelledby="tm-dialog-title">
        <div class="tm-header">
          <h3 id="tm-dialog-title">XML Daten eingeben</h3>
          <button type="button" class="tm-close" aria-label="Schließen">&times;</button>
        </div>
        <div class="tm-body">
          <div class="tm-field">
            <label for="tm-select-plan">Plan</label>
            <select id="tm-select-plan" class="tm-select">
              <option value="HKP">Heil- und Kostenplan</option>
              <option value="HKPR">Zahnersatz-Reparaturen</option>
              <option value="HKPBG">Zahnersatz-Plan / Berufsgenossenschaft</option>
              <option value="KBR">Kieferbruch-Plan</option>
              <option value="ACA">Mehrkostenvereinbarung</option>
            </select>
          </div>
          <div class="tm-field">
            <label for="tm-select-labor">Labor</label>
            <select id="tm-select-labor" class="tm-select">
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
          <div class="tm-field">
            <label for="tm-textarea-desc">Beschreibung</label>
            <textarea id="tm-textarea-desc" class="tm-textarea" placeholder="z.B. OK Proth. gebrochen"></textarea>
          </div>
          <div class="tm-field" style="display:flex; flex-direction:row; align-items:center; gap:8px;">
            <input type="checkbox" id="tm-checkbox-safe" checked style="width:auto; margin:0;" />
            <label for="tm-checkbox-safe" style="margin-bottom:0; cursor:pointer;">Safe Mode (Test-E-Mail an m-seeland@gmx.net)</label>
          </div>
          <button type="button" class="tm-submit">XML erstellen und versenden</button>
        </div>
      </div>
    `;

    // Modal Events
    const closeBtn = modal.querySelector('.tm-close');
    closeBtn.addEventListener('click', () => modal.classList.remove('is-open'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('is-open');
    });

    const submitBtn = modal.querySelector('.tm-submit');
    submitBtn.addEventListener('click', () => {
      const planSelect = modal.querySelector('#tm-select-plan');
      const laborSelect = modal.querySelector('#tm-select-labor');
      const descTextarea = modal.querySelector('#tm-textarea-desc');
      const safeCheckbox = modal.querySelector('#tm-checkbox-safe');

      const planVal = planSelect.value;
      const planText = planSelect.options[planSelect.selectedIndex].text;
      const labVal = laborSelect.value;
      const descVal = descTextarea.value.trim() || 'XML Plan';
      const isSafeChecked = safeCheckbox ? safeCheckbox.checked : false;
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
      sessionStorage.setItem(STATE_KEYS.SAFE_MODE, String(isSafeChecked));
      sessionStorage.setItem(STATE_KEYS.STEP_TIMESTAMP, String(Date.now()));

      modal.classList.remove('is-open');

      // Build and show the status bar
      createStatusBar();
      updateStatusBar(1, 11, 'Starte XML Workflow-Automatisierung...');

      // Trigger first execution
      setTimeout(executeStep, 500);
    });

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
      <button type="button" class="tm-status-cancel">Abbrechen</button>
    `;

    const cancelBtn = statusBar.querySelector('.tm-status-cancel');
    cancelBtn.addEventListener('click', () => {
      stopAutomation(false, 'Durch Benutzer abgebrochen.');
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
  }

  // --- INITIALIZATION ---

  function init() {
    injectStyles();
    createModal();

    if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
      createStatusBar();
      executeStep();
    }

    injectXmlButton();

    setInterval(() => {
      injectXmlButton();
      if (sessionStorage.getItem(STATE_KEYS.ACTIVE) === 'true') {
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
