# Teemer Workflow Optimizer Scripts

An automation tool designed to optimize and accelerate the billing and laboratory ordering workflows within the **Teemer** cloud-based practice management software for dental clinics.

Current scripts include:

* **XML Versenden**: Automates an 11-step sequence for the creation of treatment plans, laboratory orders, extraction of order IDs, and emailing of XML numbers in a single click, whilst preserving data privacy and operating entirely within the local browser context.

---

## 🚀 Key Features

* **Native Injection**: Adds a clean, full-width **"XML versenden"** button directly inside the **Aktionen** fieldset in the patient treatment dashboard.
* **Settings Modal**: Opens a modern dialog to configure the plan type, choose the manufacturing lab, and write custom comments.
* **11-Step Automation**:
  1. Opens the plan commission modal.
  2. Selects the plan type and fills in description notes.
  3. Navigates to the planning list, matching the plan to the patient name and description.
  4. Initiates laboratory order creation.
  5. Selects the laboratory and creates the order.
  6. Opens the newly created lab order.
  7. Commissions the order (*Beauftragen*).
  8. Extracts the generated **XML Order Number** (*Auftragsnummer*) and returns to the treatment dashboard.
  9. Activates the PDF document filter.
  10. Triggers file email transfer for the primary document.
  11. Autoselects the lab in favorites, selects the `"XML"` text block, removes old PDF attachments, appends the order number inside the rich text editor, and sends the email.
* **Safe Mode Protection**: Includes a checkbox (enabled by default) that redirects final emails to the dev email instead of the laboratory during testing.
* **Sleek Progress Dashboard**: Renders a premium status overlay showing real-time automation progress (e.g. `Step 5 of 11: Labor auswählen...`) with a **Cancel** safety button.

---

## 📂 Repository Structure

* **`src/`**
  * **[create+send_xml.user.js](src/create+send_xml.user.js)**: The main Tampermonkey userscript deployment file.
* **`html/`**
  * Raw HTML snapshots of the Teemer workspace used for DOM element mapping (kept locally for privacy).

---

## 🛠️ Installation & Setup

### 1. Install userscript manager
Install **Tampermonkey** on your browser (Chrome, Firefox, or Edge).
Tampermonkey is a free browser extension that allows you to run custom userscripts.
You can download it from the official website: [https://www.tampermonkey.net/](https://www.tampermonkey.net/) or from your browser's extension store.

### 2. Install the script
Click on your repository's raw URL for the userscript:
```text
https://github.com/maseinphase/TeemerScripts/raw/main/src/create+send_xml.user.js
```
Tampermonkey will automatically detect the header metadata and prompt you to install or update the script.

---

## ⚖️ License

All Rights Reserved. Access and usage rights are private to the dental office of Knut Karst. The script is intended for internal use only. No unauthorized reproduction, modification, or distribution is permitted. If you want to use this script in your own practice, please contact the author for licensing and support: [m-seeland@gmx.net](mailto:m-seeland@gmx.net?subject=Teemer%20Workflow%20Optimizer%20License%20Request).
