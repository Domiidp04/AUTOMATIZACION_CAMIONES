// ===============================
// 🎛️ Config multi-marca centralizada (Autoline only)
// ===============================
const BRANDS = {
  SALGAR: {
    id: "300",
    label: "Salgartrucks",
    carrocerias: [
      "todos",
      "TRACTO",
      "FURGON",
      "GANCHO",
      "LONAS",
      "VOLQUETE",
      "FRIGO",
      "PORTAVE",
      "TURISMO",
      "FURGONET",
      "KARTS",
      "MOTO",
      "SEMI-REM",
      "REMOLQUE",
    ],
  },
  YOURTRUCK: {
    id: "200",
    label: "Yourtruck",
    carrocerias: [
      "todos",
      "TRACTO",
      "FURGON",
      "GANCHO",
      "LONAS",
      "VOLQUETE",
      "FRIGO",
      "PORTAVE",
      "TURISMO",
      "FURGONET",
      "KARTS",
      "MOTO",
      "SEMI-REM",
      "REMOLQUE",
    ],
  },
  LASCOLINAS: {
    id: "400",
    label: "Las Colinas",
    carrocerias: [
      "todos",
      "TRACTO",
      "TAUTLIN",
      "FURGONES",
      "GRUA",
      "GANCHO",
      "ISOTERMO",
      "FRIGO",
      "BASCUL",
      "PORTAMAQ",
      "GANYGRUA",
      "FURGONET",
      "SEMI-REM",
      "TURISMO",
      "MAQUINAR",
    ],
  },
  EUCARMO: {
  id: "100",
  label: "Eucarmo",
  carrocerias: [
    "todos",
    "FRIGO",
    "GRUA",
    "GANCHO",
    "SEMITAUT",
    "PORTAMAQ",
    "FURGON",
    "BASCUL",
    "TAUTLIN",
    "GANADERO",
    "CHASIS",
    "HORMIGON",
    "GANYGRUA",
    "TRACTO",
    "CAJA",
    "CARRI",
    "CISTERNA",
    "TWIST"
  ],
},

};
const BRAND_ORDER = ["SALGAR", "YOURTRUCK", "LASCOLINAS", "EUCARMO"];

// ===============================
// 🌐 Constantes/estado global
// ===============================
const ruta = "https://truckocasion.com"; // backend propio
let currentBrandKey = "SALGAR";
let codigocliente = BRANDS[currentBrandKey].id;

let currentVehicleData = null;
let selectedVehicles = [];
let vehicleQueue = [];
let currentProcessingIndex = 0;
let isProcessingQueue = false;
let startInFlight = false;

// ===============================
// 🚀 Inicialización popup
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  initializePopup();
  setupEventListeners();
});

function initializePopup() {
  populateClientesSelect();

  // Restaurar última marca usada (por clave)
  chrome.storage.sync.get(["selectedBrandKey"], (res) => {
    const key =
      res.selectedBrandKey && BRANDS[res.selectedBrandKey]
        ? res.selectedBrandKey
        : "SALGAR";
    document.getElementById("cliente").value = key;
    applyBrand(key);
  });

  setupRuntimeMessageListener();
}

// ===============================
// 🔧 Utilidad robusta para enviar mensajes al content-script
// ===============================
async function safeSendMessage(tabId, message, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      // Comprobar que el content-script está operativo
      const ping = await chrome.tabs
        .sendMessage(tabId, { type: "PING" })
        .catch(() => null);
      if (!ping?.success) {
        // Reinyectar manualmente el content-script
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content-script.js"],
          });
          await new Promise((r) => setTimeout(r, 800));
        } catch (injErr) {
          console.warn("⚠️ Error al inyectar content-script:", injErr);
        }
      }
      // Enviar el mensaje real
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      if (i === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ===============================
// 🔔 Listener de mensajes (desde content-script)
// ===============================
function setupRuntimeMessageListener() {
  let lastComplete = { when: 0, sessionId: null };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case "STATUS_UPDATE":
        if (message.data?.text !== undefined)
          updateStatus(message.data.text, message.data.type || "info");
        sendResponse?.({ success: true });
        break;

      case "PROGRESS_UPDATE":
        if (
          message.data?.current !== undefined &&
          message.data?.total !== undefined
        ) {
          updateProgress(message.data.current, message.data.total);
        }
        sendResponse?.({ success: true });
        break;

      case "LOG_UPDATE":
        if (message.data?.message)
          addLog(message.data.message, message.data.type || "info");
        sendResponse?.({ success: true });
        break;

      case "AUTOMATION_COMPLETE":
        (async () => {
          const now = Date.now();
          const currentSession = message.data?.sessionId || null;

          // Evitar duplicados
          if (currentSession && currentSession === lastComplete.sessionId)
            return;
          if (now - lastComplete.when < 800) return;
          lastComplete = { when: now, sessionId: currentSession };

          if (isProcessingQueue) {
            const completedVehicle = vehicleQueue[currentProcessingIndex];
            addLog(
              `✅ Vehículo ${completedVehicle} completado (${
                currentProcessingIndex + 1
              }/${vehicleQueue.length})`,
              "success"
            );

            try {
              const [activeTab] = await chrome.tabs.query({
                active: true,
                currentWindow: true,
              });

              // RESET limpio antes del siguiente vehículo
              try {
                await safeSendMessage(activeTab.id, {
                  type: "RESET_AUTOMATION",
                });
                await new Promise((r) => setTimeout(r, 500));
              } catch (e) {
                console.warn("⚠️ RESET_AUTOMATION sin respuesta:", e);
              }
            } catch (err) {
              console.warn("⚠️ Error preparando siguiente vehículo:", err);
            }

            // Avanzar cola
            currentProcessingIndex++;
            setTimeout(processNextVehicle, 1200);
          } else {
            updateStatus("✅ Completado", "success");
            toggleButtons(false);
            addLog("🎉 ¡Automatización completada!", "success");
          }

          sendResponse?.({ success: true });
        })();
        break;

      case "AUTOMATION_STOPPED":
        addLog("⏹️ Automatización detenida", "warning");
        updateStatus("Detenido", "warning");
        sendResponse?.({ success: true });
        break;

      case "AUTOMATION_RESET":
        addLog("🔄 Automatización reiniciada", "info");
        sendResponse?.({ success: true });
        break;

      default:
        break;
    }
  });
}

// ===============================
// 🧭 Eventos UI
// ===============================
function setupEventListeners() {
  // Selects
  document.getElementById("cliente").addEventListener("change", function () {
    applyBrand(this.value); // value es la clave (SALGAR/YOURTRUCK/LASCOLINAS)
  });

  document.getElementById("carroceria").addEventListener("change", function () {
    showselect();
  });

  // Botones
  document.getElementById("add")?.addEventListener("click", function () {
    window.open(
      `${ruta}/truck/html/FormAddVehiculo.html?num=${codigocliente}`,
      "_blank"
    );
  });

  document.getElementById("delete")?.addEventListener("click", deleteVehicle);
  document
    .getElementById("loop")
    ?.addEventListener("click", toggleAutomationPanel);

  document.getElementById("milanuncios")?.addEventListener("click", function () {
    window.open(
      `${ruta}/truck/html/FormEdit.html`,
      "_blank"
    );
  });

  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "clear-selection") clearAllSelections();
  });

  document
    .getElementById("start-btn")
    ?.addEventListener("click", startAutomation);
  document
    .getElementById("stop-btn")
    ?.addEventListener("click", stopAutomation);
  document
    .getElementById("reset-btn")
    ?.addEventListener("click", resetAutomation);
}

// ===============================
// 🧩 Poblado dinámico de selects
// ===============================
function populateClientesSelect() {
  const sel = document.getElementById("cliente");
  if (!sel) return;
  sel.innerHTML = "";
  for (const key of BRAND_ORDER) {
    const b = BRANDS[key];
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = b.label;
    sel.appendChild(opt);
  }
}

function populateCarroceriasSelect(brandKey) {
  const sel = document.getElementById("carroceria");
  if (!sel) return;
  sel.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Selecciona carrocería --";
  sel.appendChild(placeholder);

  BRANDS[brandKey].carrocerias.forEach((cv) => {
    const opt = document.createElement("option");
    opt.value = cv;
    opt.textContent = cv;
    sel.appendChild(opt);
  });
}

function applyBrand(brandKey) {
  currentBrandKey = brandKey;
  codigocliente = BRANDS[brandKey].id;

  populateCarroceriasSelect(brandKey);

  // Limpiar listado y selección
  const vehicleList = document.getElementById("vehicle-list");
  const vehiclePlaceholder = document.getElementById("vehicle-placeholder");
  const selectionInfo = document.getElementById("selection-info");
  if (vehicleList) vehicleList.innerHTML = "";
  if (vehicleList) vehicleList.style.display = "none";
  if (vehiclePlaceholder) {
    vehiclePlaceholder.style.display = "block";
    vehiclePlaceholder.textContent = "-- Selecciona carrocería primero --";
  }
  if (selectionInfo) selectionInfo.style.display = "none";

  selectedVehicles = [];
  updateSelectionInfo();

  chrome.storage.sync.set({ selectedBrandKey: brandKey });
}

// ===============================
// 📥 Carga de vehículos por carrocería/cliente
// ===============================
function showselect() {
  const vehicleList = document.getElementById("vehicle-list");
  const vehiclePlaceholder = document.getElementById("vehicle-placeholder");
  const selectionInfo = document.getElementById("selection-info");

  selectedVehicles = [];
  updateSelectionInfo();

  const carroceria = document.getElementById("carroceria")?.value;
  const cliente = codigocliente;

  if (!carroceria) {
    if (vehicleList) vehicleList.style.display = "none";
    if (vehiclePlaceholder) {
      vehiclePlaceholder.style.display = "block";
      vehiclePlaceholder.textContent = "-- Selecciona carrocería primero --";
    }
    if (selectionInfo) selectionInfo.style.display = "none";
    return;
  }

  if (vehiclePlaceholder) vehiclePlaceholder.textContent = "-- Cargando... --";

  fetch(`${ruta}/truck/scr/base.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `carroceria=${encodeURIComponent(
      carroceria
    )}&cliente=${encodeURIComponent(cliente)}`,
  })
    .then((r) => r.text())
    .then((txt) => {
      let vehicles;
      try {
        vehicles = JSON.parse(txt);
      } catch (e) {
        console.error("Error parsing vehicles data:", e, txt);
        if (vehicleList) vehicleList.style.display = "none";
        if (vehiclePlaceholder) {
          vehiclePlaceholder.style.display = "block";
          vehiclePlaceholder.textContent = "-- Error cargando vehículos --";
        }
        if (selectionInfo) selectionInfo.style.display = "none";
        return;
      }

      if (!Array.isArray(vehicles) || vehicles.length === 0) {
        if (vehicleList) vehicleList.style.display = "none";
        if (vehiclePlaceholder) {
          vehiclePlaceholder.style.display = "block";
          vehiclePlaceholder.textContent = "-- No hay vehículos disponibles --";
        }
        if (selectionInfo) selectionInfo.style.display = "none";
        return;
      }

      if (!vehicleList) return;
      vehicleList.innerHTML = "";

      // ====== Fila "Seleccionar todos" ======
      const selectAllRow = document.createElement("label");
      selectAllRow.className = "select-all-container";

      const selectAllCheckbox = document.createElement("input");
      selectAllCheckbox.type = "checkbox";
      selectAllCheckbox.id = "select-all";
      selectAllCheckbox.className = "vehicle-checkbox";

      const selectAllText = document.createElement("span");
      selectAllText.textContent = "Seleccionar todos";

      selectAllRow.appendChild(selectAllCheckbox);
      selectAllRow.appendChild(selectAllText);
      vehicleList.appendChild(selectAllRow);

      selectAllCheckbox.addEventListener("change", function () {
        const checkboxes = vehicleList.querySelectorAll(
          ".vehicle-checkbox:not(#select-all)"
        );
        checkboxes.forEach((cb) => {
          cb.checked = this.checked;
          if (this.checked && !selectedVehicles.includes(cb.value))
            selectedVehicles.push(cb.value);
          if (!this.checked)
            selectedVehicles = selectedVehicles.filter((v) => v !== cb.value);
        });
        updateSelectionInfo();
      });

      // ====== Fila por cada vehículo ======
      vehicles.forEach((obj) => {
        const row = document.createElement("label");
        row.className = "vehicle-item";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "vehicle-checkbox";
        cb.value = obj.codigo;

        const codeSpan = document.createElement("span");
        codeSpan.className = "vehicle-code";
        codeSpan.textContent = obj.codigo;

        row.appendChild(cb);
        row.appendChild(codeSpan);
        vehicleList.appendChild(row);

        cb.addEventListener("change", function () {
          if (this.checked) {
            if (!selectedVehicles.includes(this.value))
              selectedVehicles.push(this.value);
          } else {
            selectedVehicles = selectedVehicles.filter((v) => v !== this.value);
            selectAllCheckbox.checked = false;
          }

          const allCb = vehicleList.querySelectorAll(
            ".vehicle-checkbox:not(#select-all)"
          );
          const checkedCb = vehicleList.querySelectorAll(
            ".vehicle-checkbox:not(#select-all):checked"
          );
          selectAllCheckbox.checked =
            allCb.length === checkedCb.length && checkedCb.length > 0;
          updateSelectionInfo();
        });
      });

      vehicleList.style.display = "block";
      if (vehiclePlaceholder) vehiclePlaceholder.style.display = "none";
      if (selectionInfo) selectionInfo.style.display = "block";
    })
    .catch((err) => {
      console.error("Error loading vehicles:", err);
      if (vehicleList) vehicleList.style.display = "none";
      if (vehiclePlaceholder) {
        vehiclePlaceholder.style.display = "block";
        vehiclePlaceholder.textContent = "-- Error de conexión --";
      }
      if (selectionInfo) selectionInfo.style.display = "none";
    });
}


// ===============================
// 🗑️ Borrado de vehículos
// ===============================
function deleteVehicle() {
  if (selectedVehicles.length === 0) {
    addLog("Selecciona al menos un vehículo primero", "error");
    return;
  }
  const n = selectedVehicles.length;
  if (!confirm(`¿Deseas borrar ${n} ${n === 1 ? "vehículo" : "vehículos"}?`))
    return;

  addLog(`🗑️ Eliminando ${n} ${n === 1 ? "vehículo" : "vehículos"}...`, "info");
  const toDelete = selectedVehicles.slice();
  const run = (idx) => {
    if (idx >= toDelete.length) {
      addLog("✅ Todos los vehículos eliminados", "success");
      showselect();
      return;
    }
    const codigo = toDelete[idx];
    fetch(`${ruta}/truck/scr/remove.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `codigo=${encodeURIComponent(codigo)}&cliente=${encodeURIComponent(
        codigocliente
      )}`,
    })
      .then((r) => r.text())
      .then(() => {
        addLog(`✅ Vehículo ${codigo} eliminado`, "success");
        setTimeout(() => run(idx + 1), 400);
      })
      .catch(() => {
        addLog(`❌ Error eliminando vehículo ${codigo}`, "error");
        setTimeout(() => run(idx + 1), 400);
      });
  };
  run(0);
}

// ===============================
// 🤖 Panel de automatización (Autoline)
// ===============================
function toggleAutomationPanel() {
  const panel = document.getElementById("automation-panel");
  const button = document.getElementById("loop");
  const visible = panel.style.display !== "block";
  panel.style.display = visible ? "block" : "none";
  if (button) button.style.background = visible ? "#005a87" : "#007cba";

  if (visible) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || "";

const site =
  url.includes("autoline.es") ? "autoline.es" :
  /europa-camiones\./i.test(url) ? "europa-camiones.com" :
  /(^|\.)via-mobilis\.com/i.test(url) ? "my.via-mobilis.com" :
  /(^|\.)beta\.pro\.coches\.net/i.test(url) ? "beta.pro.coches.net" :
  /(^|\.)pro\.coches\.net/i.test(url) ? "pro.coches.net" :
  /(^|\.)coches\.net/i.test(url) ? "coches.net" :
  /(^|\.)es\.wallapop\.com/i.test(url) ? "es.wallapop.com" :
  /(^|\.)wallapop\.com/i.test(url) ? "wallapop.com" :
  null;

      if (site)
        addLog(`✅ Detectado ${site} - Listo para automatizar`, "success");
      else
        addLog(
          "⚠️ Debes estar en Autoline, Europa-Camiones, Coches.net o Wallapop para usar la automatización",
          "info"
        );
    });
  }
}

// ===============================
// ▶️ Arranque/cola
// ===============================
function startAutomation() {
  if (selectedVehicles.length === 0) {
    addLog("❌ Selecciona al menos un vehículo primero", "error");
    return;
  }
  if (isProcessingQueue) {
    addLog("⚠️ Ya hay una automatización en curso", "warning");
    return;
  }

  vehicleQueue = selectedVehicles.slice();
  currentProcessingIndex = 0;
  isProcessingQueue = true;

  addLog(
    `▶️ Iniciando automatización para ${vehicleQueue.length} ${
      vehicleQueue.length === 1 ? "vehículo" : "vehículos"
    }`,
    "info"
  );
  updateStatus(
    `Procesando ${vehicleQueue.length} ${
      vehicleQueue.length === 1 ? "vehículo" : "vehículos"
    }...`,
    "running"
  );
  showQueueStatus();
  updateQueueInfo();
  processNextVehicle();
}

// === popup.js ===
// Reemplaza COMPLETO processNextVehicle por esta versión
function processNextVehicle() {
  if (!isProcessingQueue || currentProcessingIndex >= vehicleQueue.length) {
    completeAllAutomation();
    return;
  }

  const codigo = vehicleQueue[currentProcessingIndex];
  updateQueueInfo();
  addLog(`🔍 Procesando vehículo ${currentProcessingIndex + 1}/${vehicleQueue.length}: ${codigo}`, "info");

  // Lee la carrocería elegida en el popup y la marca
  const popupCarroceria = (document.getElementById("carroceria")?.value || "").toString().trim().toUpperCase();
  const popupBrandKey   = currentBrandKey || (document.getElementById("cliente")?.value || "");
  addLog(`🧭 Popup -> carrocería="${popupCarroceria}" (brand=${popupBrandKey})`, "info");

  // Traer datos del backend
  fetch(`${ruta}/truck/scr/buscarvehiculo.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `codigo=${encodeURIComponent(codigo)}&cliente=${encodeURIComponent(codigocliente)}`
  })
  .then(r => r.text())
  .then(async (txt) => {
    let vehicleData;
    try {
      vehicleData = JSON.parse(txt);
    } catch (e) {
      addLog(`❌ Error procesando datos del vehículo ${codigo}: ${e.message}`, "error");
      setTimeout(() => { currentProcessingIndex++; processNextVehicle(); }, 1200);
      return;
    }

    currentVehicleData = vehicleData;

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = activeTab?.url || "";
const allowed =
  url.includes("autoline.es") ||
  /europa-camiones\./i.test(url) ||
  /via-mobilis\.com/i.test(url) ||
  /pro\.coches\.net/i.test(url) ||   // beta.pro.coches.net y pro.coches.net
  /wallapop\.com/i.test(url);        // wallapop.com y es.wallapop.com
    if (!allowed) {
      addLog("❌ Debes estar en autoline.es, europacamiones, Coches.net o Wallapop", "error");
      updateStatus("Error: No estás en un sitio compatible", "error");
      stopQueueProcessing();
      return;
    }

    try {
      if (!startInFlight) {
        startInFlight = true;

        // Reset tolerante
        await safeSendMessage(activeTab.id, { type: "RESET_AUTOMATION" }).catch(()=>{});
        await new Promise(r => setTimeout(r, 300));

        // Lanzar START con la carrocería del popup embebida y también fuera
        const resp = await safeSendMessage(activeTab.id, {
          type: "START_AUTOMATION",
          vehicleData: {
            ...vehicleData,
            __carroceriaPopup: popupCarroceria
          },
          selectedCarroceria: popupCarroceria,
          selectedBrandKey: popupBrandKey,
          isQueueProcessing: true,
          queueInfo: {
            current: currentProcessingIndex + 1,
            total: vehicleQueue.length,
            vehicleCode: codigo,
            justStarted: true
          }
        });

        if (resp?.success) {
          addLog(`✅ Automatización iniciada para ${codigo}`, "success");
          updateStatus(`Procesando ${codigo}`, "info");
          toggleButtons(true);
          showProgress();
        } else {
          addLog(`❌ Error del content-script ${codigo}: ${resp?.error || "desconocido"}`, "error");
          setTimeout(() => { currentProcessingIndex++; processNextVehicle(); }, 1200);
        }
      } else {
        addLog("⏳ Arranque en curso, evitando duplicado…", "info");
      }
    } catch (err) {
      addLog(`❌ Error comunicación con ${codigo}: ${err?.message || err}`, "error");
      setTimeout(() => { currentProcessingIndex++; processNextVehicle(); }, 1200);
    } finally {
      setTimeout(() => { startInFlight = false; }, 600);
    }
  })
  .catch(() => {
    addLog(`❌ Error cargando datos del vehículo ${codigo}`, "error");
    setTimeout(() => { currentProcessingIndex++; processNextVehicle(); }, 1200);
  });
}

// ===============================
// 🧼 Reset/Stop/Complete
// ===============================
function completeAllAutomation() {
  isProcessingQueue = false;
  hideQueueStatus();
  toggleButtons(false);
  hideProgress();
  updateStatus("✅ Procesamiento completado", "success");
  addLog(
    `🎉 ¡Automatización completada! ${currentProcessingIndex}/${vehicleQueue.length} vehículos procesados`,
    "success"
  );
  vehicleQueue = [];
  currentProcessingIndex = 0;
}

function stopQueueProcessing() {
  isProcessingQueue = false;
  hideQueueStatus();
  toggleButtons(false);
  hideProgress();
  addLog("⏹️ Procesamiento de cola detenido", "info");
  updateStatus("Detenido", "error");
}

function stopAutomation() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    try {
      await safeSendMessage(tabs[0].id, { type: "STOP_AUTOMATION" });
    } catch {}
    if (isProcessingQueue) stopQueueProcessing();
    else {
      addLog("⏹️ Automatización detenida", "info");
      updateStatus("Detenido", "error");
      toggleButtons(false);
    }
  });
}

function resetAutomation() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    try {
      await safeSendMessage(tabs[0].id, { type: "RESET_AUTOMATION" });
    } catch {}
    // Resetear UI/cola
    isProcessingQueue = false;
    vehicleQueue = [];
    currentProcessingIndex = 0;
    addLog("🔄 Automatización reiniciada", "info");
    updateStatus("Listo para comenzar", "");
    hideProgress();
    hideQueueStatus();
    toggleButtons(false);
    const logContent =
      document.getElementById("log-content") || document.getElementById("log");
    if (logContent) logContent.innerHTML = "";
  });
}

// ===============================
// 🧰 UI helpers
// ===============================
function updateQueueInfo() {
  if (!isProcessingQueue) return;
  const cur = vehicleQueue[currentProcessingIndex] || "-";
  const rem = Math.max(0, vehicleQueue.length - currentProcessingIndex - 1);
  const cv = document.getElementById("current-vehicle");
  const rc = document.getElementById("remaining-count");
  if (cv) cv.textContent = cur;
  if (rc) rc.textContent = rem;
}

function showQueueStatus() {
  const el = document.getElementById("queue-status");
  if (el) el.classList.add("active");
}
function hideQueueStatus() {
  const el = document.getElementById("queue-status");
  if (el) el.classList.remove("active");
}

function toggleButtons(isRunning) {
  const start = document.getElementById("start-btn");
  const stop  = document.getElementById("stop-btn");
  if (!start || !stop) return;

  if (isRunning) {
    start.classList.add("hidden");
    stop.classList.remove("hidden");
  } else {
    start.classList.remove("hidden");
    stop.classList.add("hidden");
  }
}

function showProgress() {
  const p = document.getElementById("progress");
  if (p) p.style.display = "block";
}
function hideProgress() {
  const p = document.getElementById("progress");
  if (p) p.style.display = "none";
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = "0%";
}

function updateStatus(text, type) {
  const st = document.getElementById("status");
  if (!st) return;
  st.className = "status " + (type || "");
  const span = st.querySelector("span") || st;
  span.textContent = text;
}

function updateProgress(current, total) {
  const bar = document.getElementById("progress-bar");
  if (!bar) return;

  if (isProcessingQueue && vehicleQueue.length > 0) {
    const completed = currentProcessingIndex;
    const totalVehicles = vehicleQueue.length;
    const curVehicle = Math.max(0, Math.min(1, current / total));
    const globalProgress = (completed + curVehicle) / totalVehicles;
    bar.style.width = globalProgress * 100 + "%";

    if (current < total) {
      updateStatus(
        `Vehículo ${
          currentProcessingIndex + 1
        }/${totalVehicles} - Paso ${current}/${total}`,
        "running"
      );
    }
  } else {
    bar.style.width = (current / total) * 100 + "%";
  }
}

function addLog(message, type) {
  const container =
    document.getElementById("log-content") || document.getElementById("log");
  if (!container) return;
  const entry = document.createElement("div");
  entry.className = "log-entry " + (type || "info");
  entry.textContent = new Date().toLocaleTimeString() + " - " + message;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

function updateSelectionInfo() {
  const el = document.getElementById("selected-count");
  if (el) el.textContent = selectedVehicles.length;
}

function clearAllSelections() {
  selectedVehicles = [];
  document
    .querySelectorAll(".vehicle-checkbox")
    .forEach((cb) => (cb.checked = false));
  updateSelectionInfo();
  addLog("🧹 Selecciones limpiadas", "info");
}
