// Content Script unificado para Autoline.es + Europa-Camiones/Via-Mobilis
// - Autoline mantiene su flujo original (5 pasos)
// - Europa-Camiones tiene activados SOLO los 3 primeros pasos: publicar → categoría → datos
// - Router por dominio al final
// - Persistencia y mensajería compatibles con popup

// =========================
// Utilidades / helpers (globales)
// =========================

// Evita ejecutar en iframes (para que no haya doble instancia)
if (window.top !== window.self) {
  throw new Error("skip-iframe");
}

// Preparación del DOM (versión estable)
function _preparaWebLegacy() {
  // Quitar wrappers de Select2 para que los <select> reales queden accesibles
  document
    .querySelectorAll(".select2-hidden-accessible")
    ?.forEach((el) => el.classList.remove("select2-hidden-accessible"));
  // Mostrar todas las secciones del formulario
  document
    .querySelectorAll("div.section-content")
    ?.forEach((sec) => (sec.style.display = "block"));
}

// Detección de URL errónea (búsqueda)
function _isWrongSearchUrl() {
  try {
    return location.pathname.includes("/search_text.php");
  } catch {
    return false;
  }
}

// Conversores / mapeos (tomados de la versión que ya te funcionaba)
function ToneladasToKilos(t) {
  return t != null && !isNaN(parseFloat(t))
    ? String(parseFloat(t) * 1000)
    : undefined;
}
function getY(d) {
  if (!d || d === "0000-00-00") return;
  const x = new Date(d);
  return isNaN(x) ? undefined : String(x.getFullYear());
}
function getM(d) {
  if (!d || d === "0000-00-00") return;
  const x = new Date(d);
  return isNaN(x) ? undefined : String(x.getMonth() + 1).padStart(2, "0");
}
function getD(d) {
  if (!d || d === "0000-00-00") return;
  const x = new Date(d);
  return isNaN(x) ? undefined : String(x.getDate()).padStart(2, "0");
}

function mapConfiEjeSelect(v) {
  const m = {
    1: "4157",
    2: "4167",
    3: "4158",
    4: "4168",
    5: "4179",
    6: "4183",
    7: "4188",
    8: "4169",
  };
  return m[String(v)];
}
function mapSuspension(o) {
  if (o?.suspension_ne !== "0") return "4362"; // neumática/neumática
  if (o?.suspension_hi !== "0") return "4998"; // resorte/neumática
  if (o?.suspension_me !== "0") return "4363"; // resorte/resorte
  if (o?.suspension_rene !== "0") return "4361"; // resorte/neumática
}
function mapCajaCambio(o) {
  return o?.caja_cambio === "1" ? "4137" : "4136";
} // auto : manual
function mapFrigoMarca(o) {
  // Ejemplos (ajusta si hace falta)
  const m = { 124: "4064", 6973: "4054", 744: "4055" };
  return m[String(o?.carroceria_marca)];
}

// Búsqueda de botón por texto (fallback para Aplazar)
function _findButtonByText(...texts) {
  const btns = Array.from(
    document.querySelectorAll('button, input[type="submit"], a[role="button"]')
  );
  for (const t of texts) {
    const found = btns.find((b) => {
      const txt = (b.textContent || b.value || "").trim().toLowerCase();
      return txt.includes(t.toLowerCase());
    });
    if (found) return found;
  }
  return null;
}

// helper pequeñito para comparar texto visible
function _txt(el) {
  return (el?.textContent || el?.value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// =========================
// Núcleo AUTOLINE (se mantiene igual que tenías)
// =========================
(() => {
  const STEPS_AUTOLINE = [
  { name: "publicar",  desc: 'Click en "Publicar el anuncio"', waitNav: true },
  { name: "cabezas",   desc: 'Click en "Cabezas tractoras"',   waitNav: true },
  { name: "datos",     desc: "Insertar datos del vehículo",     waitNav: false },
  { name: "fotosAL",   desc: "Subir fotos (Autoline)",          waitNav: false }, // ← NUEVO
  { name: "siguiente", desc: 'Click en "Siguiente"',            waitNav: true },
  { name: "aplazar",   desc: 'Click en "Aplazar"',              waitNav: true },
];


class AutolineAutomation {
  // ===== Config =====
  LOCAL_PHOTOS_BASE = "http://127.0.0.1/photos"; // XAMPP
  MAX_PHOTOS = 30;

  constructor() {
    this.currentStep = 0;
    this.isRunning = false;
    this.vehicleData = null;

    this.isQueueProcessing = false;
    this.queueInfo = null;

    this.maxRetries = 3;
    this.retryDelay = 800;

    this._watcher = null;
    this._lastUrl = location.href;

    this._completedOnce = false;
    this.sessionId = null;

    // 🔑 carrocería elegida en el popup (persistimos entre navegaciones)
    this.carroceriaFromPopup = "";

    // Mensajería / estado
    this._setupMsgListener();
    this._startNavigationWatcher();
    this._loadStateAndMaybeResume();

    // Bloqueo de Enter para evitar envíos/búsquedas
    this._keydownBlocker = (e) => {
      if (!this.isRunning) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this._log("⛔ Enter bloqueado para evitar navegación/búsqueda", "info");
      }
    };
    window.addEventListener("keydown", this._keydownBlocker, true);
  }

  // ---------- Mensajería ----------
  _setupMsgListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      (async () => {
        try {
          switch (message.type) {
            case "PING":
              sendResponse({
                success: true,
                message: "content-script alive",
                status: {
                  isRunning: this.isRunning,
                  currentStep: this.currentStep,
                  url: window.location.href,
                },
              });
              break;

            case "START_AUTOMATION": {
              // Datos base
              if (message.vehicleData) this.vehicleData = message.vehicleData;
              this.isQueueProcessing = !!message.isQueueProcessing;
              this.queueInfo = message.queueInfo || null;

              // Carrocería llegada desde el popup (dos vías por compatibilidad)
              const fromMsg = (message.selectedCarroceria || "")
                .toString()
                .trim()
                .toUpperCase();
              const fromVD = (this.vehicleData?.__carroceriaPopup || "")
                .toString()
                .trim()
                .toUpperCase();

              this.carroceriaFromPopup = fromMsg || fromVD || this.carroceriaFromPopup || "";

              // Si sigue vacía, intenta recuperar la persistida previamente
              if (!this.carroceriaFromPopup) {
                try {
                  const { al_popup_carroceria } = await chrome.storage.local.get(["al_popup_carroceria"]);
                  this.carroceriaFromPopup = (al_popup_carroceria || "").toString().trim().toUpperCase();
                } catch {}
              }

              // Persistir para reanudaciones
              try {
                await chrome.storage.local.set({ al_popup_carroceria: this.carroceriaFromPopup });
              } catch {}

              // Logs/diagnóstico
              this._log(
                `🧭 [CS] selectedCarroceria="${fromMsg}" | __carroceriaPopup="${fromVD}" | efectiva="${this.carroceriaFromPopup}"`,
                "info"
              );
              console.log(
                "[CS] START_AUTOMATION carroceríaFromPopup =",
                this.carroceriaFromPopup,
                " vehicleData=",
                this.vehicleData
              );

              if (this.isQueueProcessing && this.queueInfo?.justStarted) {
                this._log("🔄 Nuevo vehículo en cola: reinicio completo del estado", "info");
                this.queueInfo.justStarted = false;
                this.isRunning = false;
                this.currentStep = 0;
                this._completedOnce = false;
                this.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                await chrome.storage.local.remove(["auto_running", "auto_step", "auto_data"]);
                await this._delay(300);
              }

              await this._start();
              sendResponse?.({ success: true });
              break;
            }

            case "STOP_AUTOMATION":
              await this._stop();
              sendResponse?.({ success: true });
              break;

            case "RESET_AUTOMATION":
              await this._reset();
              sendResponse?.({ success: true });
              break;

            default:
              break;
          }
        } catch (e) {
          sendResponse?.({ success: false, error: e?.message });
        }
      })();
      return true; // async
    });
  }

  _send(type, data) {
    try {
      chrome.runtime.sendMessage({ type, data });
    } catch {}
  }
  _status(text, type = "running") {
    this._send("STATUS_UPDATE", { text, type });
  }
  _progress(cur, total) {
    this._send("PROGRESS_UPDATE", { current: cur, total });
  }
  _log(message, type = "info") {
    this._send("LOG_UPDATE", { message, type });
  }

  // ---------- Persistencia ----------
  async _saveState() {
    await chrome.storage.local.set({
      auto_running: this.isRunning,
      auto_step: this.currentStep,
      auto_data: this.vehicleData,
    });
  }
  async _loadStateAndMaybeResume() {
    const st = await chrome.storage.local.get(["auto_running", "auto_step", "auto_data", "al_popup_carroceria"]);
    if (!this.carroceriaFromPopup && st.al_popup_carroceria) {
      this.carroceriaFromPopup = (st.al_popup_carroceria || "").toString().trim().toUpperCase();
    }
    if (st.auto_running && typeof st.auto_step === "number") {
      this.isRunning = true;
      this.currentStep = st.auto_step;
      this.vehicleData = st.auto_data || this.vehicleData;
      this._log("🔄 Reanudando automatización tras navegación…", "info");
      setTimeout(() => this._executeStep(), 1200);
    }
  }

  // ---------- Navigation Watcher ----------
  _startNavigationWatcher() {
    if (this._watcher) return;
    this._watcher = setInterval(async () => {
      if (location.href !== this._lastUrl) {
        const oldUrl = this._lastUrl;
        this._lastUrl = location.href;
        this._log(`📍 Navegación detectada:\n${oldUrl} → ${this._lastUrl}`, "info");

        if (this.isRunning && _isWrongSearchUrl()) {
          this._log("↩️ Corrigiendo desvío de búsqueda…", "warning");
          history.length > 1 ? history.back() : location.reload();
          return;
        }
        if (this.isRunning) await this._loadStateAndMaybeResume();
      }
    }, 1500);
  }

  // ---------- Ciclo principal ----------
  async _start() {
    if (!location.host.includes("autoline.es")) {
      this._status("Debes estar en autoline.es", "error");
      this._log("❌ No estás en autoline.es", "error");
      throw new Error("Not on autoline.es");
    }
    this.isRunning = true;
    if (this.currentStep < 0 || this.currentStep >= STEPS_AUTOLINE.length) this.currentStep = 0;
    await this._saveState();

    this._status("Iniciando automatización…", "running");
    this._log("🚀 Automatización iniciada", "info");
    this._executeStep();
  }

  async _stop() {
    this.isRunning = false;
    await chrome.storage.local.set({ auto_running: false });
    this._log("⏹️ Automatización detenida", "warning");
  }

  async _reset() {
    this.isRunning = false;
    this.currentStep = 0;
    this.vehicleData = null;
    await chrome.storage.local.remove(["auto_running", "auto_step", "auto_data"]);
    this._log("🔄 Sistema reiniciado", "info");
  }

  async _executeStep() {
    if (!this.isRunning) return;
    if (this.currentStep >= STEPS_AUTOLINE.length) return this._complete();

    const step = STEPS_AUTOLINE[this.currentStep];
    this._status(`Paso ${this.currentStep + 1}/${STEPS_AUTOLINE.length}: ${step.desc}`, "running");
    this._progress(this.currentStep, STEPS_AUTOLINE.length);
    this._log(`📍 Paso ${this.currentStep + 1}: ${step.desc}`, "info");

    try {
      let ok = false;
      switch (step.name) {
        case "publicar":
          ok = await this._clickPublicar();
          break;
        case "cabezas":
          // 🔁 Ahora este paso decide la categoría según la carrocería del popup
          ok = await this._seleccionarCategoriaAutoline();
          break;
        case "datos":
          ok = await this._insertarDatos();
          break;
        case "fotosAL":
          ok = await this._subirFotosAutolineFromLocal();
          break;
        case "siguiente":
          ok = await this._clickGuardar();
          break;
        case "aplazar":
          ok = await this._clickAplazar();
          break;
      }

      if (!this.isRunning) return;

      if (ok) {
        this._log(`✅ ${step.desc}`, "success");
        this.currentStep++;
        await this._saveState();
        setTimeout(() => this._executeStep(), step.waitNav ? 3000 : 600);
      } else {
        this._log(`❌ Error en: ${step.desc}`, "error");
        await this._stop();
      }
    } catch (e) {
      this._log(`❌ Excepción en paso: ${e?.message || e}`, "error");
      await this._stop();
    }
  }

  async _complete() {
    if (this._completedOnce) return;
    this._completedOnce = true;

    this.isRunning = false;
    await chrome.storage.local.set({ auto_running: false, auto_step: 0 });

    this._status("✅ Vehículo completado", "success");
    this._progress(5, 5);

    const sessionId = this.sessionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this._send("AUTOMATION_COMPLETE", { sessionId });

    await chrome.storage.local.remove(["auto_running", "auto_step", "auto_data"]);
    this.currentStep = 0;
    this.vehicleData = null;
    this._log("🔁 Listo para siguiente vehículo", "info");
    try {
      delete window.__autolineRunning;
    } catch {}
  }

  // ---------- Acciones (Autoline) ----------
  async _clickPublicar() {
    const sel = 'span.button.js-hrf[data-analytics-goal="button_place_ad"]';
    const el = await this._waitVisible(sel, this.maxRetries);
    if (!el) return false;
    this._smoothClick(el);
    return true;
  }

  // ===============================
  // PASO CATEGORÍA (Autoline, según popup)
  // ===============================
async _seleccionarCategoriaAutoline() {
  const popup = (this.carroceriaFromPopup || "").toString().trim().toUpperCase();
  this._log(`📦 [AL] Carrocería desde popup: "${popup}"`, "info");

  // --- Mapeo directo popup → clave interna ---
  const MAP = {
    TRACTO: "TRACTO",
    FURGON: "FURGON",
    FRIGO: "FRIGO",
    LONAS: "LONAS",
    VOLQUETE: "VOLQUETE",
    GANCHO: "GANCHO",
    GRUA: "GRUA",
    "SEMI-TAUTLINER": "SEMITAUT",
    PORTAMAQ: "PORTAMAQ",
    TAUTLIN: "TAUTLIN",
    GANADERO: "GANADERO",
    CHASIS: "CHASIS",
    HORMIGON: "HORMIGON",
    "GANCHO+GRUA": "GANCHO_GRUA",
    CISTERNA: "CISTERNA",
    "TWIST LOCK": "TWISTLOCK",
    CARRI: "CARRILLEROS",
  };
  let key = MAP[popup] || null;

  if (!key) key = "TRACTO";

  // --- Selectores HTML (Autoline) ---
  const CAMIONES = 'div.option[data-cat-id="2"][data-combination="0"]';
  const SUB = {
    FURGON:      'div.option[data-cat-id="12"][data-cat-style="autoline"]',
    FRIGO:       'div.option[data-cat-id="7"][data-cat-style="autoline"]',
    LONAS:       'div.option[data-cat-id="876"][data-cat-style="autoline"]',
    VOLQUETE:    'div.option[data-cat-id="36"][data-cat-style="autoline"]',
    GANCHO:      'div.option[data-cat-id="40"][data-cat-style="autoline"]',
    GRUA:        'div.option[data-cat-id="32"][data-cat-style="autoline"]',     // Camiones cajas abiertas
    SEMITAUT:    'div.option[data-cat-id="4"][data-cat-style="autoline"]',      // Camiones toldos
    PORTAMAQ:    'div.option[data-cat-id="14"][data-cat-style="autoline"]',     // Camiones portacoches
    TAUTLIN:     'div.option[data-cat-id="876"][data-cat-style="autoline"]',    // Camiones con lona corredera
    GANADERO:    'div.option[data-cat-id="16"][data-cat-style="autoline"]',     // Camiones transporte ganado
    CHASIS:      'div.option[data-cat-id="16"][data-cat-style="autoline"]',     // Igual que Ganadero
    HORMIGON:    'div.option[data-cat-id="26"][data-cat-style="autoline"]',     // Camiones cisternas de cemento
    GANCHO_GRUA: 'div.option[data-cat-id="40"][data-cat-style="autoline"]',     // Camiones con gancho
    CISTERNA:    'div.option[data-cat-id="29"][data-cat-style="autoline"]',     // Camiones cisterna
    TWISTLOCK:   'div.option[data-cat-id="34"][data-cat-style="autoline"]',     // Camiones contenedores
    CARRILLEROS: 'div.option[data-cat-id="2474"][data-cat-style="autoline"]',   // Camiones para caballos
  };
  const TRACTO_TRIES = [
    'div.option[data-cat-id="42"]',
    'div.option[data-cat-id="42"][data-combination="0"]',
    '.option[data-cat-id="42"] .text',
    '.option[data-cat-id="42"]'
  ];

  const LABELS = {
    TRACTO: "Cabezas tractoras",
    FURGON: "Camiones furgones",
    FRIGO: "Camiones frigoríficos",
    LONAS: "Camiones con lona corredera",
    VOLQUETE: "Volquetes",
    GANCHO: "Camiones con gancho",
    GRUA: "Camiones cajas abiertas (grúas)",
    SEMITAUT: "Camiones toldos (semi-tautliner)",
    PORTAMAQ: "Camiones portacoches / portamaquinaria",
    TAUTLIN: "Camiones con lona corredera (tautliner)",
    GANADERO: "Camiones transporte de ganado",
    CHASIS: "Camiones transporte de ganado / chasis",
    HORMIGON: "Camiones cisternas de cemento",
    GANCHO_GRUA: "Camiones con gancho y grúa",
    CISTERNA: "Camiones cisterna",
    TWISTLOCK: "Camiones de contenedores (twist lock)",
    CARRILLEROS: "Camiones para caballos",
  };

  this._log(`🎯 [AL] Categoría seleccionada: ${key} → ${LABELS[key] || "?"}`, "info");

  // --- Helpers ---
  const waitVisible = async (sel, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = Array.isArray(sel)
        ? sel.map(s => document.querySelector(s)).find(this._isVisible.bind(this))
        : document.querySelector(sel);
      if (this._isVisible(el)) return el;
      await this._delay(150);
    }
    return null;
  };

  // --- Lógica ---
  if (key === "TRACTO") {
    const el = await waitVisible(TRACTO_TRIES, 8000);
    if (!el) {
      this._log("❌ [AL] No encuentro 'Cabezas tractoras'", "error");
      return false;
    }
    this._smoothClick(el);
    return true;
  }

  const cam = await waitVisible(CAMIONES, 8000);
  if (!cam) {
    this._log("❌ [AL] No encuentro 'Camiones'", "error");
    return false;
  }
  this._smoothClick(cam);

  const subSel = SUB[key];
  const sub = await waitVisible(subSel, 9000);
  if (!sub) {
    this._log(`❌ [AL] No encuentro subcategoría: ${LABELS[key]}`, "error");
    return false;
  }

  this._smoothClick(sub);
  this._log(`✅ [AL] Seleccionada: ${LABELS[key]}`, "success");
  return true;
}

async _ensureModelUIReady() {
  // Si el modelo no está visible o no existe, intenta “abrir” el bloque
  const isModelVisible = () => {
    const row = document.querySelector(".block-row.model-row");
    return row && this._isVisible(row);
  };

  if (isModelVisible()) return true;

  const toggles = Array.from(document.querySelectorAll(".block-toggle-btn"));
  // clicka el toggle más cercano a la zona de params (normalmente solo hay 1)
  for (const t of toggles) {
    if (!this._isVisible(t)) continue;
    this._smoothClick(t);
    await this._delay(250);
    if (isModelVisible()) return true;
  }

  // aunque no se vea, puede estar en DOM; devolvemos true para intentar igualmente
  return true;
}

async _openModelSelect2(row) {
  // Intenta varios “openers” posibles
  const openers = [
    row.querySelector(".select2-selection"),
    row.querySelector(".select2-container .select2-selection"),
    row.querySelector(".select2"), // a veces el wrapper clicable es el span.select2
  ].filter(Boolean);

  for (const op of openers) {
    if (!this._isVisible(op)) continue;
    // mousedown suele abrir mejor que click en select2
    try {
      op.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    } catch {}
    this._smoothClick(op);
    await this._delay(200);

    const search = document.querySelector(".select2-container--open .select2-search__field");
    if (search) return search;
  }

  // fallback: click en la row para que inicialice
  this._smoothClick(row);
  await this._delay(200);
  return document.querySelector(".select2-container--open .select2-search__field");
}

_setNativeValue(el, value) {
  const val = value == null ? "" : String(value);
  const proto =
    el instanceof HTMLInputElement
      ? window.HTMLInputElement.prototype
      : el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLElement.prototype;

  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, val);
  else el.value = val;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async _setModeloAutoline(valor) {
  const txt = (valor || "").toString().trim();
  if (!txt) return true;

  await this._ensureModelUIReady();

  const row = document.querySelector(".block-row.model-row");
  if (!row) {
    this._log("❌ MODELO: no encuentro .block-row.model-row (ni tras abrir bloque)", "error");
    return false;
  }

  // OJO: NO dependemos de select2-hidden-accessible
  const selReal =
    row.querySelector("select.field-id-model") ||
    row.querySelector("select[name='v--model']") ||
    row.querySelector("select");

  // Si hay select real con opciones, intenta match directo (sin abrir nada)
  if (selReal && selReal.options && selReal.options.length > 1) {
    const opts = Array.from(selReal.options);
    const exact = opts.find(o => (o.textContent || "").trim().toLowerCase() === txt.toLowerCase());
    if (exact) {
      selReal.value = exact.value;
      selReal.dispatchEvent(new Event("change", { bubbles: true }));
      await this._delay(150);
      this._log(`✅ MODELO: set directo <select> → "${exact.textContent.trim()}"`, "success");
      return true;
    }
  }

  // Abrir Select2 y escribir en el buscador
  const search = await this._openModelSelect2(row);
  if (!search) {
    // último fallback: cualquier input type=search visible (cuando se abre dropdown)
    const anySearch = Array.from(document.querySelectorAll("input[type='search']")).find(i => this._isVisible(i));
    if (!anySearch) {
      this._log("❌ MODELO: no aparece input de búsqueda (select2)", "error");
      return false;
    }
    this._setNativeValue(anySearch, txt);
    await this._delay(250);
  } else {
    this._setNativeValue(search, txt);
    await this._delay(250);
  }

  // Esperar resultados y seleccionar (exacto > contiene > primero)
  const getItems = () =>
    Array.from(document.querySelectorAll(".select2-container--open .select2-results__option[role='treeitem']"))
      .filter(li => (li.textContent || "").trim().length && !li.classList.contains("select2-results__option--disabled"));

  let items = getItems();
  for (let i = 0; i < 15 && items.length === 0; i++) {
    await this._delay(120);
    items = getItems();
  }

  if (!items.length) {
    this._log(`❌ MODELO: sin resultados para "${txt}"`, "error");
    // cierra dropdown si está abierto
    try { document.body.click(); } catch {}
    return false;
  }

  const exactLi = items.find(li => (li.textContent || "").trim().toLowerCase() === txt.toLowerCase());
  const containsLi = items.find(li => (li.textContent || "").trim().toLowerCase().includes(txt.toLowerCase()));
  const target = exactLi || containsLi || items[0];

  this._smoothClick(target);
  await this._delay(200);

  // Verificación ligera (si existe select real)
  if (selReal && selReal.selectedIndex >= 0) {
    const st = (selReal.options[selReal.selectedIndex]?.textContent || "").trim();
    if (st) {
      this._log(`✅ MODELO: seleccionado → "${st}"`, "success");
      return true;
    }
  }

  this._log("✅ MODELO: seleccionado (sin verificación en <select>, pero dropdown respondió)", "success");
  return true;
}

async _confirmSelect2() {
  const search = document.querySelector(".select2-container--open .select2-search__field");
  if (search) {
    // Enter para confirmar selección (Select2 suele seleccionar el highlighted)
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", which: 13, keyCode: 13, bubbles: true }));
    await this._delay(150);
  }

  const stillOpen = document.querySelector(".select2-container--open");
  if (stillOpen) {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.body.click();
    await this._delay(150);
  }
}



  async _insertarDatos() {
    if (!this.vehicleData) {
      this._log("⚠️ No hay datos del vehículo; abortando", "error");
      return false;
    }

    const okForm = await this._esperarFormulario();
    if (!okForm) return false;
    this._prepararFormulario();

    const v = this.vehicleData;

    // ===== Campos principales =====
await this._sel("select[name='v--trademark']", v.au_marca ?? v.marca);

// Importante: tras elegir marca, a veces el modelo se rellena/refresh por JS/AJAX
await this._delay(500);

// Modelo (Select2 + bloque colapsable)
const okModelo = await this._setModeloAutoline(v.modelo);
if (!okModelo) {
  this._log("❌ MODELO: no pude insertar el modelo, paro aquí", "error");
  return false;
}
await this._confirmSelect2();


await this._inp("input[name='v--kilometrag']", v.kilometros ?? v.km);


    // Fechas (fabricación / primer registro / ITV)
    await this._sel("select[name='v--yearmade']", getY(v.fecha_matriculacion));
    await this._sel("select[name='v--monthmade']", getM(v.fecha_matriculacion));

    await this._sel("select[name='v--yearreg']", getY(v.fecha_ul_in_te));
    await this._sel("select[name='v--monthreg']", getM(v.fecha_ul_in_te));
    await this._sel("select[name='v--dayreg']", getD(v.fecha_ul_in_te));

    await this._sel("select[name='v--to_year']", getY(v.vencimiento_in_te));
    await this._sel("select[name='v--to_month']", getM(v.vencimiento_in_te));
    await this._sel("select[name='v--to_day']", getD(v.vencimiento_in_te));

    await this._inp("input[name='v--price']", v.precio);
    await this._inp("input[name='v--regnomer']", v.codigo);

    // Dimensiones / pesos
    await this._inp("input[name='v--length']", v.longitud);
    await this._inp("input[name='v--width']", v.anchura);
    await this._inp("input[name='v--height']", v.altura);
    await this._inp("input[name='v--tonnage']", v.capacidad_cuba);
    await this._inp("input[name='v--weight']", ToneladasToKilos(v.peso_vacio));
    await this._inp("input[name='v--massa']", ToneladasToKilos(v.ptma));

    // Motor / cabina
    await this._inp("input[name='v--enginepower']", v.potencia);
    if (v.literas != null)
      await this._sel("select[name='v--sleeper']", String(parseInt(v.literas) + 1));
    await this._sel("select[name='v--euro']", v.normas);

    // Ejes / configuración
    await this._sel("select[name='v--axel_num']", v.numero_ejes);
    await this._sel("select[name='v--axel_formula']", mapConfiEjeSelect(v.ejes));
    await this._inp("input[name='v--baza_len']", v.distancia_ejes);
    await this._sel("select[name='v--suspension']", mapSuspension(v));

    // Combustible / comentarios
    await this._sel("select[name='v--fuel']", "4116"); // diésel
    await this._txt("textarea[name='text-field-description-es']", v.informacion_com);

    // Frenos / neumáticos
    await this._sel("select[name='v--torm_type']", v.tipo_frenos);
    await this._inp("input[name='v--rezina_ost']", v.deterioro_ne_de);
    await this._inp("input[name='v--rezina_razm']", v.dimension_ne_de);

    // Carrocería / especiales
    await this._sel("select[name='v--refrigerator']", mapFrigoMarca(v));
    await this._sel("select[name='v--kpp_type']", mapCajaCambio(v));
    await this._inp("input[name='v--narabotka']", v.numero_ho);
    await this._sel("select[name='v--pallet_capacity']", v.capacidad_palet);
    await this._sel("select[name='v--axel_mark']", v.marca_eje);
    await this._sel("select[name='v--kpp_num']", v.transmisiones);
    await this._inp("input[name='v--refr_from_t']", v.temperatura_mas);
    await this._inp("input[name='v--refr_till_t']", v.temperatura_menos);

    // Checkboxes (extenso)
    const setChk = async (sel, val) => {
      const el = document.querySelector(sel);
      if (!el || val == null) return;
      el.checked = val === "on" || val === "1" || val === 1 || val === true;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await this._delay(20);
    };
    await setChk("input[name='v--abs']", v.abs);
    await setChk("input[name='v--gidrousil']", v.direccion_asistida);
    await setChk("input[name='v--airbag']", v.airbag);
    await setChk("input[name='v--pnevmosid']", v.asiento_con_suspension);
    await setChk("input[name='v--klimat_kontrol']", v.climatizacion);
    await setChk("input[name='v--centralnyj_zamok']", v.cierre_centralizado);
    await setChk("input[name='v--comp']", v.ordenador_bordo);
    await setChk("input[name='v--farkop']", v.enganche_remolque);
    await setChk("input[name='v--speed_limit']", v.regulador_velocidad);
    await setChk("input[name='v--el_zerkala']", v.retrovisores_electricos || v.espejos_regulables);
    await setChk("input[name='v--podogrev_sidenij']", v.asiento_calefacion);
    await setChk("input[name='v--obogrevatel']", v.calefacion_estatica);
    await setChk("input[name='v--tahograf']", v.tacografo);
    await setChk("input[name='v--intarder']", v.retardador_integrado);
    await setChk("input[name='v--gidrobort']", v.trampilla_elevadora);
    await setChk("input[name='v--conditioner']", v.aire_acondicionado);
    await setChk("input[name='v--ebs']", v.ebs);
    await setChk("input[name='v--zadnie_dveri']", v.puertas_traseras);
    await setChk("input[name='v--side_door']", v.puerta_lateral);
    await setChk("input[name='v--kryuki_dlya_myasa']", v.ganchos_carne);
    await setChk("input[name='v--kozyrek']", v.visera_parasol);
    await setChk("input[name='v--tempomat']", v.control_crucero_tempomat);
    await setChk("input[name='v--motor_tormoz']", v.freno_motor);
    await setChk("input[name='v--spojler']", v.spoilers);
    await setChk("input[name='v--avtomagnitola']", v.radio_coche);
    await setChk("input[name='v--smazka']", v.lubricacion_central);
    await setChk("input[name='v--pallet_box']", v.caja_palets);
    await setChk("input[name='v--podjemnaja_osj']", v.eje_elevacion);
    await setChk("input[name='v--particle_filter']", v.filtro_antiparticulas);
    await setChk("input[name='v--eev']", v.eev);
    await setChk("input[name='v--e_adblue']", v.deposito_adblue);
    await setChk("input[name='v--holodilnik']", v.refrigerador);
    await setChk("input[name='v--luk']", v.techo_solar);
    await setChk("input[name='v--block_differ']", v.bloque_diferencial);
    await setChk("input[name='v--instrum_box']", v.caja_herramientas);
    await setChk("input[name='v--telma']", v.telma);

    this._log("📊 Datos insertados", "success");

    await this._delay(600);
    if (_isWrongSearchUrl()) {
      this._log("⚠️ Desvío a búsqueda detectado. Volviendo atrás…", "error");
      history.length > 1 ? history.back() : location.reload();
      return false;
    }

    const before = location.href;
    await this._delay(800);
    if (location.href !== before) {
      this._log("❌ Navegación inesperada tras insertar datos", "error");
      return false;
    }
    return true;
  }

  // ====== AUTOLINE: Subir fotos automáticas (XAMPP → multipart/form-data) ======
  _getAutolineCodeFromURL() {
    try {
      const u = new URL(location.href);
      const code = u.searchParams.get("code");
      return code ? code.trim() : "";
    } catch {
      return "";
    }
  }

  async _dataURLToBlob(dataURL) {
    const res = await fetch(dataURL);
    return await res.blob();
    }

  async _uploadOneAutoline(code, fileName, dataURL, { maxBytes = 350 * 1024 } = {}) {
    try {
      // Opcional: comprimir si excede
      let data = dataURL;
      const beforeKB = Math.round(this._dataURLBytes(data) / 1024);
      if (this._dataURLBytes(data) > maxBytes) {
        try {
          data = await this._shrinkToMaxBytes(data, {
            maxBytes,
            startQuality: 0.9,
            minQuality: 0.55,
            maxDim: 2000,
            minDim: 600,
            opTimeout: 7000,
          });
        } catch (e) {
          this._log(`⚠️ Compresión AL fallida: ${e?.message || e}. Subo original.`, "warning");
        }
      }
      const afterKB = Math.round(this._dataURLBytes(data) / 1024);
      this._log(`🗜️ (AL) ${fileName}: ${beforeKB}KB → ${afterKB}KB`, "info");

      const blob = await this._dataURLToBlob(data);
      const fd = new FormData();
      fd.append("photo", blob, fileName);

      const url = `https://autoline.es/add/media/photos/?code=${encodeURIComponent(code)}`;
      const resp = await fetch(url, {
        method: "POST",
        body: fd,
        headers: { "X-Requested-With": "XMLHttpRequest" },
        credentials: "include",
      });

      if (!resp.ok) {
        this._log(`❌ (AL) HTTP ${resp.status} subiendo ${fileName}`, "error");
        return false;
      }

      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await resp.json().catch(() => null);
        if (j && (j.success === true || j.ok === true || j.error === false)) return true;
        return true;
      } else {
        const text = await resp.text().catch(() => "");
        if (!/error/i.test(text)) return true;
        this._log(`⚠️ (AL) Respuesta indica posible error subiendo ${fileName}`, "warning");
        return false;
      }
    } catch (e) {
      this._log(`❌ (AL) Upload error: ${e?.message || e}`, "error");
      return false;
    }
  }

  _sendMessageWithTimeout(payload, { timeout = 2000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, timeout);
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(resp || null);
        });
      } catch {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null);
        }
      }
    });
  }

  async _buscarPrimeraQueExista(folder, idx, exts) {
    for (const ex of exts) {
      const url = `${this.LOCAL_PHOTOS_BASE}/${encodeURIComponent(folder)}/${idx}${ex}`;
      const probe = await this._sendMessageWithTimeout({ type: "FETCH_LOCAL_IMAGE", url }, { timeout: 2000 });
      if (probe && probe.ok) return url;
    }
    return null;
  }

  async _getDataURLFromLocal(url) {
    const r = await this._sendMessageWithTimeout({ type: "FETCH_LOCAL_IMAGE", url }, { timeout: 4000 });
    return r && r.ok && r.dataURL ? r.dataURL : null;
  }

  _dataURLBytes(dataURL) {
    const b64 = dataURL.split(",")[1] || "";
    const pad = (b64.match(/=+$/) || [""])[0].length;
    return Math.floor((b64.length * 3) / 4) - pad;
  }
  _blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error("FileReader error"));
      fr.readAsDataURL(blob);
    });
  }
  _timeout(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  }

  async _decodeImageSafe(dataURL, { timeout = 5000 } = {}) {
    try {
      const mimeMatch = /^data:(image\/[^;]+);base64,/i.exec(dataURL);
      const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const b64 = dataURL.split(",")[1] || "";
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bin], { type: mime });
      const bmp = await Promise.race([createImageBitmap(blob), this._timeout(timeout)]);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      return { canvas, width: canvas.width, height: canvas.height };
    } catch {}

    const img = new Image();
    img.decoding = "async";
    img.src = dataURL;
    await Promise.race([
      new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("img onerror"));
      }),
      this._timeout(timeout),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height };
  }

  async _shrinkToMaxBytes(
    dataURL,
    { maxBytes = 50 * 1024, startQuality = 0.82, minQuality = 0.5, maxDim = 1600, minDim = 480, stepDim = 0.88, opTimeout = 7000 } = {}
  ) {
    try {
      const tStart = Date.now();
      if (!/^data:image\/(jpeg|jpg|png|webp)/i.test(dataURL)) return dataURL;
      if (this._dataURLBytes(dataURL) <= maxBytes) return dataURL;

      const { canvas, width: W0, height: H0 } = await this._decodeImageSafe(dataURL, { timeout: 4000 });
      let w = W0,
        h = H0;
      const scale0 = Math.min(1, maxDim / Math.max(w, h));
      if (scale0 < 1) {
        w = Math.max(minDim, Math.round(w * scale0));
        h = Math.max(minDim, Math.round(h * scale0));
      }

      const work = document.createElement("canvas");
      const ctx = work.getContext("2d", { alpha: false });
      const draw = () => {
        work.width = w;
        work.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
      };
      draw();

      let best = dataURL;
      let quality = startQuality;

      const toDataURLQ = (q) =>
        new Promise((res, rej) => {
          work.toBlob(
            async (blob) => {
              if (!blob) return rej(new Error("toBlob null"));
              const out = await this._blobToDataURL(blob);
              res(out);
            },
            "image/jpeg",
            q
          );
        });

      for (; quality >= minQuality; quality -= 0.08) {
        if (Date.now() - tStart > opTimeout) break;
        const out = await toDataURLQ(quality);
        best = out;
        if (this._dataURLBytes(out) <= maxBytes) return out;
      }

      for (let tries = 0; tries < 10; tries++) {
        if (Date.now() - tStart > opTimeout) break;

        const nw = Math.max(minDim, Math.round(w * stepDim));
        const nh = Math.max(minDim, Math.round(h * stepDim));
        if (nw === w && nh === h) break;
        w = nw;
        h = nh;
        draw();

        let q = Math.max(minQuality, 0.6);
        for (; q >= minQuality; q -= 0.08) {
          if (Date.now() - tStart > opTimeout) break;
          const out = await toDataURLQ(q);
          best = out;
          if (this._dataURLBytes(out) <= maxBytes) return out;
        }
      }
      return best;
    } catch {
      return dataURL;
    }
  }

  async _subirFotosAutolineFromLocal() {
    const code = this._getAutolineCodeFromURL();
    if (!code) {
      this._log("❌ (AL) No encuentro 'code' en la URL del formulario. Sigo sin fotos.", "warning");
      return true;
    }

    const vd = this.vehicleData || {};
    const vehicleIdFromURL = (location.pathname.match(/\/(\d+)/) || [])[1];
    const folder =
      (vd.codigo && String(vd.codigo).trim()) ||
      (vd.vehicleId && String(vd.vehicleId).trim()) ||
      (vehicleIdFromURL && String(vehicleIdFromURL).trim());
    if (!folder) {
      this._log("ℹ️ (AL) Sin carpeta local (vd.codigo/vehicleId). Sigo sin fotos.", "info");
      return true;
    }

    try {
      const pingUrl = `${this.LOCAL_PHOTOS_BASE}/__ping__.txt?ts=${Date.now()}`;
      await fetch(pingUrl, { cache: "no-store", mode: "no-cors" });
      this._log(`🖥️ XAMPP OK en ${this.LOCAL_PHOTOS_BASE}`, "info");
    } catch {
      this._log(`⚠️ (AL) No contacto ${this.LOCAL_PHOTOS_BASE}. ¿XAMPP encendido/host_permissions?`, "warning");
    }

    const exts = [".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG", ".WEBP"];
    let uploaded = 0;

    const T0 = Date.now();
    const DEADLINE_MS = 25000;

    for (let i = 1; i <= this.MAX_PHOTOS; i++) {
      if (Date.now() - T0 > DEADLINE_MS) {
        this._log("⏱️ (AL) Timeout de fotos, sigo al siguiente paso.", "warning");
        break;
      }

      const found = await this._buscarPrimeraQueExista(folder, i, exts);
      if (!found) {
        if (i === 1) this._log(`ℹ️ (AL) Sin fotos en ${this.LOCAL_PHOTOS_BASE}/${folder}/`, "info");
        break;
      }

      const dataURL = await this._getDataURLFromLocal(found);
      if (!dataURL) {
        this._log(`⚠️ (AL) No pude leer: ${found}`, "warning");
        continue;
      }

      const fileName = `${i}${(found.match(/\.[a-zA-Z0-9]+$/) || [".jpg"])[0]}`;

      const ok = await this._uploadOneAutoline(code, fileName, dataURL, {
        maxBytes: 350 * 1024,
      });

      if (ok) {
        uploaded++;
        this._log(`📸 (AL) OK ${fileName}`, "success");
      } else {
        this._log(`❌ (AL) Fallo subiendo ${fileName}`, "error");
      }
    }

    if (uploaded === 0) {
      this._log("ℹ️ (AL) No se subió ninguna imagen. Sigo con el flujo.", "info");
      return true;
    }

    this._log(`✅ (AL) ${uploaded} foto(s) subidas.`, "success");
    return true;
  }

async _clickGuardar() {
  // 1) Botón específico dentro de .next-button (por si reutilizas la misma clase contenedora)
  const specific = document.querySelector(".next-button button, .next-button > button");
  if (specific && this._isVisible(specific) && /guardar|save/i.test(_txt(specific))) {
    this._smoothClick(specific);
    return true;
  }

  // 2) Cualquier botón dentro de .next-button que tenga texto tipo Guardar / Save
  const wrapper = document.querySelector(".next-button");
  if (wrapper) {
    const btnInWrapper = wrapper.querySelector('button, [role="button"], input[type="button"], input[type="submit"]');
    if (btnInWrapper && this._isVisible(btnInWrapper) && /guardar|save/i.test(_txt(btnInWrapper))) {
      this._smoothClick(btnInWrapper);
      return true;
    }
  }

  // 3) Buscar en todos los botones visibles por texto Guardar / Save
  const candidates = Array.from(
    document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')
  );
  const byText = candidates.find(
    (b) => this._isVisible(b) && /guardar|save/i.test(_txt(b))
  );
  if (byText) {
    this._smoothClick(byText);
    return true;
  }

  // 4) Último recurso: click al wrapper si es clicable y visible
  if (wrapper && this._isVisible(wrapper)) {
    this._smoothClick(wrapper);
    return true;
  }

  this._log('❌ No se encontró el botón "Guardar"', "error");
  return false;
}

  async _clickAplazar() {
    const suspendLink = document.querySelector(".actions a.suspend");
    if (suspendLink && this._isVisible(suspendLink)) {
      this._smoothClick(suspendLink);
      return true;
    }
    const candidates = Array.from(document.querySelectorAll("a, button, input[type=submit]"));
    const byText = candidates.find(
      (el) =>
        this._isVisible(el) && /aplazar|suspender|guardar y salir|save for later/i.test((el.textContent || el.value || "").trim())
    );
    if (byText) {
      this._smoothClick(byText);
      return true;
    }
    this._log("ℹ️ No se encontró enlace/botón “Aplazar”, finalizando sin aplazar.", "warning");
    return true;
  }

  // ---------- Helpers DOM ----------
  _smoothClick(el) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.click();
    } catch {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(ev);
    }
  }
  async _waitVisible(selector, retries = 3) {
    for (let i = 0; i < retries; i++) {
      const el = document.querySelector(selector);
      if (this._isVisible(el)) return el;
      await this._delay(this.retryDelay);
    }
    return null;
  }
  _isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }
  async _findByText(txt) {
    const nodes = document.querySelectorAll("*");
    for (const el of nodes) {
      if (!el) continue;
      if (!this._isVisible(el)) continue;
      const t = (el.textContent || "").trim();
      if (t.includes(txt)) return el;
    }
    return null;
  }
  async _esperarFormulario() {
    for (let i = 1; i <= 10; i++) {
      const form = document.querySelector("form");
      const inputs = document.querySelectorAll("input,select,textarea");
      if (form && inputs.length > 10) {
        this._log(`✅ Formulario detectado (${inputs.length} campos)`, "success");
        return true;
      }
      this._log(`⏳ Esperando formulario… (${i}/10)`, "info");
      await this._delay(800);
    }
    return false;
  }
  _prepararFormulario() {
    document.querySelectorAll(".select2-hidden-accessible")?.forEach((el) => el.classList.remove("select2-hidden-accessible"));
    document
      .querySelectorAll(".select2-selection__rendered, .select2-selection, .select2-container")
      ?.forEach((el) => el.remove());
    document.querySelectorAll(".section-content")?.forEach((sec) => (sec.style.display = "block"));
    this._log("🔧 Formulario preparado", "info");
  }
  async _inp(sel, val) {
    if (!val && val !== 0) return;
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this._delay(50);
  }
  async _sel(sel, val) {
    if (!val && val !== 0) return;
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = String(val);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this._delay(50);
  }
  async _txt(sel, val) {
    if (!val) return;
    const el = document.querySelector(sel);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this._delay(50);
  }
  async _chk(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.checked = val === "on" || val === "1" || val === 1 || val === true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await this._delay(30);
  }
  _getY(any) {
    if (!any) return null;
    if (/^\d{4}$/.test(String(any))) return String(any);
    const d = new Date(any);
    return isNaN(d) ? null : String(d.getFullYear());
  }
  _getM(any) {
    if (!any) return null;
    const d = new Date(any);
    return isNaN(d) ? null : String(d.getMonth() + 1).padStart(2, "0");
  }
  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}


  // =========================
  // Base (opcional) y Europa-Camiones/Via-Mobilis (3 pasos)
  // =========================

  class BaseAutomation {}

class EuropacamionesAutomation extends BaseAutomation {
  // ===== Config =====
  LOCAL_PHOTOS_BASE = "http://127.0.0.1/photos"; // XAMPP
  MAX_PHOTOS = 30;

  constructor() {
    super();
    this.carroceriaFromPopup = null;
    this.currentStep = 0;
    this.isRunning = false;
    this.vehicleData = null;
    this.isQueueProcessing = false;
    this.queueInfo = null;
    this.maxRetries = 3;
    this.retryDelay = 800;
    this._watcher = null;
    this._lastUrl = location.href;
    this._completedOnce = false;
    this.sessionId = null;
    this._alreadyPublished = false;

    this._setupMsgListener();
    this._startNavigationWatcher();
    this._loadStateAndMaybeResume();

    this._keydownBlocker = (e) => {
      if (!this.isRunning) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", this._keydownBlocker, true);
  }

  // ========================
  // Mensajería / Estado
  // ========================
_setupMsgListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        // Si reanudamos sin START, intenta recuperar la última carrocería
        if (!this.carroceriaFromPopup) {
          try {
            const { eco_popup_carroceria } = await chrome.storage.local.get(["eco_popup_carroceria"]);
            if (eco_popup_carroceria) this.carroceriaFromPopup = eco_popup_carroceria;
          } catch {}
        }

        switch (message.type) {
          case "PING":
            sendResponse({
              success: true,
              message: "content-script alive",
              status: {
                isRunning: this.isRunning,
                currentStep: this.currentStep,
                url: window.location.href,
              },
            });
            break;

          case "START_AUTOMATION": {
            // 1) Datos del vehículo
            this.vehicleData = message.vehicleData || this.vehicleData;

            // 2) Carrocería del popup: guardar en memoria y PERSISTIR
            const popupCarr = (message.selectedCarroceria || this.vehicleData?.__carroceriaPopup || "")
              .toString().trim().toUpperCase();
            this.carroceriaFromPopup = popupCarr;
            try { await chrome.storage.local.set({ eco_popup_carroceria: popupCarr }); } catch {}

            // 3) Marca (opcional)
            this.brandKeyFromPopup = message.selectedBrandKey || this.brandKeyFromPopup || "";

            if (this.carroceriaFromPopup) this._log(`📦 Carrocería seleccionada en popup (persistida): "${this.carroceriaFromPopup}"`, "info");
            else this._log(`📦 Carrocería popup vacía`, "warning");

            // 4) Modo cola
            this.isQueueProcessing = !!message.isQueueProcessing;
            this.queueInfo = message.queueInfo || null;

            if (this.isQueueProcessing && this.queueInfo?.justStarted) {
              this._log("🔄 Nuevo vehículo en cola: reinicio completo del estado", "info");
              this.queueInfo.justStarted = false;
              this.isRunning = false;
              this.currentStep = 0;
              this._completedOnce = false;
              this._alreadyPublished = false;
              this.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

              // Limpia estado pero NO borres eco_popup_carroceria
              await chrome.storage.local.remove(["eco_running", "eco_step", "eco_data"]);
              await this._delay(300);
            }

            await this._start();
            sendResponse?.({ success: true });
            break;
          }

          case "STOP_AUTOMATION":
            await this._stop();
            sendResponse?.({ success: true });
            break;

          case "RESET_AUTOMATION":
            // No borres eco_popup_carroceria
            this.isRunning = false;
            this.currentStep = 0;
            this.vehicleData = null;
            this._completedOnce = false;
            this._alreadyPublished = false;
            try { await chrome.storage.local.set({ eco_running: false, eco_step: 0, eco_data: null }); } catch {}
            this._log("🔄 Reiniciada", "info");
            sendResponse?.({ success: true });
            break;

          default:
            break;
        }
      } catch (e) {
        sendResponse?.({ success: false, error: e?.message });
      }
    })();
    return true; // async
  });
}

  _send(type, data) {
    try {
      chrome.runtime.sendMessage({ type, data });
    } catch {}
  }
  _status(text, type = "running") {
    this._send("STATUS_UPDATE", { text, type });
  }
  _progress(cur, total) {
    this._send("PROGRESS_UPDATE", { current: cur, total });
  }
  _log(message, type = "info") {
    this._send("LOG_UPDATE", { message, type });
  }
async _saveState() {
  await chrome.storage.local.set({
    eco_running: this.isRunning,
    eco_step: this.currentStep,
    eco_data: this.vehicleData,
    eco_popup_carroceria: this.carroceriaFromPopup || ""
  });
}

async _loadStateAndMaybeResume() {
  const st = await chrome.storage.local.get([
    "eco_running",
    "eco_step",
    "eco_data",
    "eco_popup_carroceria"
  ]);

  if (st.eco_popup_carroceria) this.carroceriaFromPopup = st.eco_popup_carroceria;

  if (st.eco_running && typeof st.eco_step === "number") {
    this.isRunning = true;
    this.currentStep = st.eco_step;
    this.vehicleData = st.eco_data || this.vehicleData;
    this._log("🔄 Reanudando automatización tras navegación…", "info");
    setTimeout(() => this._executeStep(), 1200);
  }
}


  _startNavigationWatcher() {
    if (this._watcher) return;
    this._watcher = setInterval(async () => {
      if (location.href !== this._lastUrl) {
        const old = this._lastUrl;
        this._lastUrl = location.href;
        this._log(`📍 Navegación: ${old} → ${this._lastUrl}`, "info");
        if (this.isRunning) await this._loadStateAndMaybeResume();
      }
    }, 1500);
  }

  // ========================
  // Utilidades
  // ========================
  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  _wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async _waitFor(sel, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(sel);
      if (el) return el;
      await this._wait(150);
    }
    return null;
  }
  async _waitForUrl(regex, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (regex.test(location.pathname)) return true;
      await this._wait(150);
    }
    return false;
  }
  _hasUsableForm() {
    const form = document.querySelector("form");
    if (!form) return false;
    const fields = form.querySelectorAll("input, select, textarea");
    return fields.length >= 10;
  }
  async _waitForForm(timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this._hasUsableForm()) return document.querySelector("form");
      await this._wait(150);
    }
    return null;
  }

  _setValue(el, v) {
    if (!el) return false;
    const val = (v ?? "").toString().trim();
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  _setCheckedById(id, on) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.checked = !!on;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  _setRadioSufijo(baseId, code) {
    if (code == null || code === "") return false;
    const el = document.getElementById(`${baseId}-${code}`);
    if (!el) return false;
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  _toDMY(s) {
    if (!s || s === "0000-00-00") return "";
    const d = new Date(s);
    if (isNaN(d)) return "";
    const pad = (n) => (n < 10 ? "0" + n : n);
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  _isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      st.display !== "none" &&
      st.visibility !== "hidden" &&
      st.opacity !== "0"
    );
  }
  _isEnabled(el) {
    if (!el) return false;
    const dis =
      el.disabled ||
      el.getAttribute("disabled") !== null ||
      el.getAttribute("aria-disabled") === "true";
    const cl = (el.className || "").toString();
    return !dis && !/disabled|is\-disabled/i.test(cl);
  }
  _forceClick(el) {
    try {
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      el.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    } catch {}
  }

  // === Helpers robustos para paneles/scrolls/clicks ===

// espera a que un panel esté abierto y estable (sin .collapsing)
async _waitPanelOpen(panelEl, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const isOpen = panelEl.classList.contains('show') || panelEl.classList.contains('in');
    const isCollapsing = panelEl.classList.contains('collapsing');
    const ariaOk = (panelEl.getAttribute('aria-expanded') || '').toString() === 'true';
    if (isOpen && !isCollapsing || ariaOk) return true;
    await this._wait(120);
  }
  return false;
}

// intenta abrir un panel con su toggle [href="#id"] o data-target
async _ensurePanelOpen(panel) {
  const panelEl = document.querySelector(panel.id);
  if (!panelEl) return null;

  // si ya está abierto, sal
  if (panelEl.classList.contains('show') || panelEl.classList.contains('in')) return panelEl;

  let toggle = document.querySelector(`[href="${panel.id}"]`);
  if (!toggle) toggle = document.querySelector(`[data-target="${panel.id}"]`);
  if (!toggle) {
    // a veces llevan un botón con role o aria-controls
    toggle = document.querySelector(`[aria-controls="${panel.id.replace('#','')}"]`);
  }

  if (toggle) {
    toggle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this._wait(400);
    this._forceClick(toggle);
    await this._wait(1200);
    await this._waitPanelOpen(panelEl, 6000);
  }
  return panelEl;
}

// encuentra botón "Validar" aunque varíen atributos
_findValidarBtn(panelEl) {
  if (!panelEl) return null;

  // casos más frecuentes
  let btn = panelEl.querySelector('button[data-bt][data-target]');
  if (btn && this._isVisible(btn)) return btn;

  // variantes por texto
  const candidates = Array.from(panelEl.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
  const byText = candidates.find(b =>
    /validar/i.test((b.textContent || b.value || '').trim())
  );
  if (byText && this._isVisible(byText)) return byText;

  // variantes con clases del tema
  const byClass = candidates.find(b =>
    /btn|button/.test(b.className || '') && /(primary|success|green)/i.test(b.className || '')
  );
  if (byClass && this._isVisible(byClass)) return byClass;

  return null;
}

// hace scroll y click robusto con reintentos y verifica side-effect básico
async _scrollAndRobustClick(el, { retries = 3, postWait = 1200 } = {}) {
  if (!el) return false;
  for (let i = 0; i < retries; i++) {
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await this._wait(350);
      if (!this._isVisible(el) || !this._isEnabled(el)) {
        await this._wait(300);
      }
      this._forceClick(el);
      await this._wait(postWait);
      // comprobación mínima: si sigue focused/pressed, damos por válido; si no, reintento
      if (!el.disabled) {
        // algunos “validar” no se deshabilitan; si hay data-bt, disparamos oculto
        const bt = el.getAttribute('data-bt');
        if (bt) {
          const hidden = document.getElementById(bt);
          if (hidden) {
            this._forceClick(hidden);
            await this._wait(600);
          }
        }
      }
      return true;
    } catch {}
    await this._wait(400 + i * 250);
  }
  return false;
}

// espera a que las fotos estén listas y no haya subidas en curso
_countUploading() {
  return document.querySelectorAll(
    'li.thumbs.uploading, li.thumbs .progress, .uploading, .dz-processing'
  ).length;
}
async _waitPhotosIdle(timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const have = this._countUploadedPhotos();
    const up = this._countUploading();
    if (have > 0 && up === 0) return true;
    await this._wait(250);
  }
  return false;
}

// por si el layout está haciendo “saltos” (altura cambiante)
async _waitStableLayout(container = document.body, timeout = 4000) {
  const t0 = Date.now();
  let last = container.scrollHeight;
  let stableFor = 0;
  while (Date.now() - t0 < timeout) {
    const cur = container.scrollHeight;
    if (cur === last) {
      stableFor += 120;
      if (stableFor >= 600) return true; // ~0.6s estable
    } else {
      last = cur;
      stableFor = 0;
    }
    await this._wait(120);
  }
  return false;
}


  async _waitForPublishEnabled(timeout = 7000) {
    const t0 = Date.now();
    const sels = [
      "#submitDepot",
      "button#submitDepot",
      'button[name="submitDepot"][type="submit"]',
      'button.button.button-large.green[type="submit"]',
    ];
    while (Date.now() - t0 < timeout) {
      let btn = null;
      for (const s of sels) {
        const e = document.querySelector(s);
        if (e && this._isVisible(e) && this._isEnabled(e)) {
          btn = e;
          break;
        }
      }
      if (!btn) {
        const cands = Array.from(
          document.querySelectorAll(
            'button[type="submit"],button,input[type="submit"]'
          )
        );
        btn = cands.find(
          (b) =>
            /publicar\s*mi\s*anuncio/i.test(
              (b.textContent || b.value || "").trim()
            ) &&
            this._isVisible(b) &&
            this._isEnabled(b)
        );
      }
      if (btn) return btn;
      await this._wait(120);
    }
    return null;
  }

  // === Utilidades imagen (compresión < 50KB) ===
  _dataURLBytes(dataURL) {
    const b64 = dataURL.split(",")[1] || "";
    const pad = (b64.match(/=+$/) || [""])[0].length;
    return Math.floor((b64.length * 3) / 4) - pad;
  }
  _blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error("FileReader error"));
      fr.readAsDataURL(blob);
    });
  }
  _timeout(ms) {
    return new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timeout")), ms)
    );
  }

  async _decodeImageSafe(dataURL, { timeout = 5000 } = {}) {
    // 1) createImageBitmap
    try {
      const mimeMatch = /^data:(image\/[^;]+);base64,/i.exec(dataURL);
      const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const b64 = dataURL.split(",")[1] || "";
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bin], { type: mime });
      const bmp = await Promise.race([
        createImageBitmap(blob),
        this._timeout(timeout),
      ]);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      return { canvas, width: canvas.width, height: canvas.height };
    } catch {}

    // 2) fallback <img>
    const img = new Image();
    img.decoding = "async";
    img.src = dataURL;
    await Promise.race([
      new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("img onerror"));
      }),
      this._timeout(timeout),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height };
  }

  async _shrinkToMaxBytes(
    dataURL,
    {
      maxBytes = 50 * 1024,
      startQuality = 0.82,
      minQuality = 0.5,
      maxDim = 1600,
      minDim = 480,
      stepDim = 0.88,
      opTimeout = 7000,
    } = {}
  ) {
    try {
      const tStart = Date.now();

      // Si es un formato no soportado por canvas (HEIC), no tocar
      if (!/^data:image\/(jpeg|jpg|png|webp)/i.test(dataURL)) {
        return dataURL;
      }

      if (this._dataURLBytes(dataURL) <= maxBytes) return dataURL;

      const {
        canvas,
        width: W0,
        height: H0,
      } = await this._decodeImageSafe(dataURL, { timeout: 4000 });
      let w = W0,
        h = H0;
      const scale0 = Math.min(1, maxDim / Math.max(w, h));
      if (scale0 < 1) {
        w = Math.max(minDim, Math.round(w * scale0));
        h = Math.max(minDim, Math.round(h * scale0));
      }

      const work = document.createElement("canvas");
      const ctx = work.getContext("2d", { alpha: false });
      const draw = () => {
        work.width = w;
        work.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
      };
      draw();

      let best = dataURL;
      let quality = startQuality;

      const toDataURLQ = (q) =>
        new Promise((res, rej) => {
          work.toBlob(
            async (blob) => {
              if (!blob) return rej(new Error("toBlob null"));
              const out = await this._blobToDataURL(blob);
              res(out);
            },
            "image/jpeg",
            q
          );
        });

      // Bajar calidad primero
      for (; quality >= minQuality; quality -= 0.08) {
        if (Date.now() - tStart > opTimeout) break;
        const out = await toDataURLQ(quality);
        best = out;
        if (this._dataURLBytes(out) <= maxBytes) return out;
      }

      // Reducir dimensiones y ajustar calidad
      for (let tries = 0; tries < 10; tries++) {
        if (Date.now() - tStart > opTimeout) break;

        const nw = Math.max(minDim, Math.round(w * stepDim));
        const nh = Math.max(minDim, Math.round(h * stepDim));
        if (nw === w && nh === h) break;
        w = nw;
        h = nh;
        draw();

        let q = Math.max(minQuality, 0.6);
        for (; q >= minQuality; q -= 0.08) {
          if (Date.now() - tStart > opTimeout) break;
          const out = await toDataURLQ(q);
          best = out;
          if (this._dataURLBytes(out) <= maxBytes) return out;
        }
      }
      return best;
    } catch {
      return dataURL;
    }
  }

  // ========================
  // Arranque
  // ========================
  async _start() {
    const okHost =
      /europa-camiones\./i.test(location.host) ||
      /(^|\.)via-mobilis\.com$/i.test(location.host);
    if (!okHost) {
      this._status(
        "Debes estar en europa-camiones.com o my.via-mobilis.com",
        "error"
      );
      this._log("❌ Dominio no compatible para esta automatización", "error");
      throw new Error("Not on europa-camiones/via-mobilis");
    }

    this.isRunning = true;
    if (this.currentStep < 0) this.currentStep = 0;
    await this._saveState();

    this._status("Iniciando automatización (Europa-Camiones)…", "running");
    this._log("🚀 Automatización iniciada (Europa-Camiones)", "info");
    this._executeStep();
  }

  async _stop() {
    this.isRunning = false;
    await chrome.storage.local.set({ eco_running: false });
    this._log("⏹️ Automatización detenida", "warning");
  }
  async _reset() {
    this.isRunning = false;
    this.currentStep = 0;
    this.vehicleData = null;
    this._alreadyPublished = false;
    await chrome.storage.local.remove(["eco_running", "eco_step", "eco_data"]);
    this._log("🔄 Reiniciada (Europa-Camiones)", "info");
  }

  // ========================
  // Pasos
  // ========================
  async _executeStep() {
    if (!this.isRunning) return;

    const STEPS = [
      { name: "nueva", desc: "Abrir “Publicar un anuncio”", waitNav: true },
      {
        name: "categoria",
        desc: "Elegir “Cabeza tractora → Estándar”",
        waitNav: true,
      },
      { name: "datos", desc: "Rellenar formulario", waitNav: false },
      { name: "fotosAuto", desc: "Subir fotos (XAMPP)", waitNav: false },
      { name: "validar", desc: "Validar todas las secciones", waitNav: true },
    ];

    if (this.currentStep >= STEPS.length) return this._complete();

    const step = STEPS[this.currentStep];
    this._status(
      `Paso ${this.currentStep + 1}/${STEPS.length}: ${step.desc}`,
      "running"
    );
    this._progress(this.currentStep, STEPS.length);
    this._log(`📍 Paso ${this.currentStep + 1}: ${step.desc}`, "info");

    let ok = false;
    try {
      switch (step.name) {
        case "nueva":
          ok = await this._clickNuevaPublicacion();
          break;
        case "categoria":
          ok = await this._seleccionarCategoria();
          break;
        case "datos":
          ok = await this._insertarDatos();
          break;
        case "fotosAuto":
          ok = await this._subirFotosAutoFromLocal();
          break;
        case "validar":
          ok = await this._clickValidar();
          break;
      }
    } catch (e) {
      this._log(`❌ Excepción en paso: ${e?.message || e}`, "error");
      return this._stop();
    }

    if (!this.isRunning) return;
    if (ok) {
      this._log(`✅ ${step.desc}`, "success");
      this.currentStep++;
      await this._saveState();
      setTimeout(() => this._executeStep(), step.waitNav ? 3000 : 600);
    } else {
      this._log(`❌ Error en: ${step.desc}`, "error");
      await this._stop();
    }
  }

  async _complete() {
    if (this._completedOnce) return;
    this._completedOnce = true;
    this.isRunning = false;
    await chrome.storage.local.set({ eco_running: false, eco_step: 0 });
    this._status("✅ Datos introducidos (Europa-Camiones)", "success");
    this._progress(6, 6);
    const sessionId =
      this.sessionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this._send("AUTOMATION_COMPLETE", { sessionId });
    await chrome.storage.local.remove(["eco_running", "eco_step", "eco_data"]);
    this.currentStep = 0;
    this.vehicleData = null;
    this._alreadyPublished = false;
    this._log("🔁 Listo para siguiente vehículo (Europa-Camiones)", "info");
  }

  // ====== PASO 1: Publicar ======
  async _clickNuevaPublicacion() {
    const a = await this._waitFor(
      'a[href="/vehicle/new"][title*="Publicar"]',
      10000
    );
    if (!a) {
      this._log("No encuentro 'Publicar un anuncio'", "error");
      return false;
    }
    this._log("Click en 'Publicar un anuncio'", "info");
    this._forceClick(a);

    const moved = await Promise.race([
      this._waitFor('a[href*="/vehicle/new?"][href*="cat="]', 12000),
      this._waitFor(
        '#energie, #Km, #prix, form[action*="vehicle"], form input#Km',
        12000
      ),
    ]);
    return !!moved;
  }

// ====== PASO 2: Selección de categoría según la CARROCERÍA del POPUP ======
async _seleccionarCategoria() {
  // Si ya estamos en el formulario, saltamos
  if (/\/vehicle\/(new|[^/]+\/edit)/i.test(location.pathname) && this._hasUsableForm()) {
    this._log("Ya estoy en el formulario, salto Paso 2.", "info");
    return true;
  }

  const popupRaw = (this.carroceriaFromPopup || "").toString().trim().toUpperCase();

  // --- Mapeo popup → clave interna ---
  const MAP = {
    TRACTO: "TRACTO",
    FURGON: "FURGON",
    FRIGO: "FRIGO",
    LONAS: "LONAS",
    VOLQUETE: "VOLQUETE",
    GANCHO: "GANCHO",
    TURISMO: "TURISMO",
    FURGONET: "FURGONET",
    GRUA: "GRUA",
    "SEMI-TAUTLINE": "SEMITAUT",
    PORTAMAQUINARIA: "PORTAMAQ",
    TAUTLINE: "TAUTLINE",
    GANADERO: "GANADERO",
    CHASIS: "CHASIS",
    HORMIGON: "HORMIGON",
    "GANCHO+GRUA": "GANCHO_GRUA",
    CISTERNA: "CISTERNA",
    TWISTLOCK: "TWISTLOCK",
    CARRILLEROS: "CARRILLEROS",
  };
  let key = MAP[popupRaw] || null;

  // --- fallback heurístico ---
  if (!key) {
    const raw = [
      this.vehicleData?.categoria,
      this.vehicleData?.carroceria,
      this.vehicleData?.tipo,
      this.vehicleData?.categoria_eu,
    ].find(Boolean) || "";
    const norm = (s) =>
      (s || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const c = norm(raw);
    if (/tractor|tracto/i.test(c)) key = "TRACTO";
    else if (/furgon(?!eta)/i.test(c)) key = "FURGON";
    else if (/frigo/i.test(c)) key = "FRIGO";
    else if (/lona|tautliner/i.test(c)) key = "LONAS";
    else if (/gancho|portacontenedor/i.test(c)) key = "GANCHO";
    else if (/volquete|bascul/i.test(c)) key = "VOLQUETE";
    else key = "TRACTO";
  }

  // --- Tabla de categorías (href params) ---
  const DEST = {
    // CABEZAS TRACTORAS
    TRACTO: { name: "Cabeza tractora → Estándar", parts: ["cat=31", "var=68"], text: /estandar|tractora/i },
    // SEMIRREMOLQUES CAT=32
    FURGON: { name: "Furgón", parts: ["cat=32", "var=76"], text: /furgon/i },
    FRIGO: { name: "Frigorífico", parts: ["cat=32", "var=78"], text: /frigo/i },
    LONAS: { name: "Tautliner (lonas correderas)", parts: ["cat=32", "var=160"], text: /tautliner|lona/i },
    VOLQUETE: { name: "Volquete", parts: ["cat=32", "var=74"], text: /volquete/i },
    GANCHO: { name: "Portacontenedor de gancho", parts: ["cat=32", "var=260"], text: /gancho/i },
    // TURISMOS
    TURISMO: { name: "Berlina (turismo)", parts: ["fml=3", "cat=37", "var=527"], text: /berlina|turismo/i },
    FURGONET: { name: "Furgoneta (turismo)", parts: ["fml=3", "cat=37", "var=281"], text: /furgoneta/i },
    // NUEVAS CARROCERÍAS
    GRUA: { name: "Plataforma (grúa)", parts: ["cat=32", "var=79"], text: /plataforma|grua/i },
    SEMITAUT: { name: "Lona (semi-tautliner)", parts: ["cat=32", "var=80"], text: /lona|semi/i },
    PORTAMAQ: { name: "Porta máquinas", parts: ["cat=32", "var=87"], text: /maquina|porta/i },
    TAUTLINE: { name: "Tautliner (lonas correderas)", parts: ["cat=32", "var=160"], text: /tautliner|lona/i },
    GANADERO: { name: "Para ganado", parts: ["cat=32", "var=72"], text: /ganado/i },
    CHASIS: { name: "Chasis", parts: ["cat=32", "var=83"], text: /chasis/i },
    HORMIGON: { name: "Hormigón", parts: ["cat=32", "var=132"], text: /hormigon/i },
    GANCHO_GRUA: { name: "Portacontenedor de gancho", parts: ["cat=32", "var=260"], text: /gancho/i },
    CISTERNA: { name: "Cisterna", parts: ["cat=32", "var=75"], text: /cisterna/i },
    TWISTLOCK: { name: "Portacontenedores", parts: ["cat=32", "var=98"], text: /contenedor|twist/i },
    CARRILLEROS: { name: "Transporte de caballos", parts: ["cat=32", "var=131"], text: /caballo|carrillero|transporte/i },
  };

  const target = DEST[key];
  this._log(`🎯 Categoría a abrir: ${key} → ${target?.name || "?"}`, "info");

  // --- Buscar enlace ---
  const matchesHref = (a, parts) => parts.every((p) => (a.getAttribute("href") || "").includes(p));
  const findLink = () => {
    const links = Array.from(document.querySelectorAll('a[href*="/vehicle/new?"]'));
    return (
      links.find((a) => matchesHref(a, target.parts)) ||
      links.find((a) => target.text.test((a.textContent || "").trim()))
    ) || null;
  };

  let link = null;
  const t0 = Date.now();
  while (!link && Date.now() - t0 < 9000) {
    link = findLink();
    if (!link) await this._wait(250);
  }

  if (!link) {
    this._log(`❌ No encuentro la tarjeta de categoría: ${target?.name || key}`, "error");
    return false;
  }

  // --- Navegar ---
  const href = link.getAttribute("href");
  const absolute = href?.startsWith("http") ? href : new URL(href, location.origin).href;
  this._log(`🧭 Navegando a ${target.name}…`, "info");
  location.assign(absolute);

  // --- Esperar formulario ---
  const urlOk = await this._waitForUrl(/\/vehicle\/(new|[^/]+\/edit)/i, 8000);
  if (!urlOk) {
    this._log("❌ No cambió la URL al formulario (timeout).", "error");
    return false;
  }
  const formOk = await this._waitForForm(9000);
  if (!formOk) {
    this._log("❌ No veo un formulario con campos (timeout).", "error");
    return false;
  }

  return true;
}



  // ====== PASO 3: Insertar datos ======
  async _insertarDatos() {
    const vd = this.vehicleData;
    if (!vd) {
      this._log("⚠️ Sin datos de vehículo", "error");
      return false;
    }

    const hasForm = document.querySelector(
      '#energie, #Km, #prix, form[action*="vehicle"]'
    );
    if (!hasForm) {
      this._log(
        "⚠️ No veo el formulario todavía. Reintentando breve…",
        "warning"
      );
      const again = await this._waitFor(
        '#energie, #Km, #prix, form[action*="vehicle"]',
        6000
      );
      if (!again) {
        this._log("❌ Formulario no disponible", "error");
        return false;
      }
    }

    // Wake-up
    const first =
      document.querySelector("#energie") ||
      document.querySelector("#Km") ||
      document.querySelector("form input, form select, form textarea");
    if (first) {
      try {
        first.scrollIntoView({ behavior: "smooth", block: "center" });
        first.focus();
      } catch {}
    }

    // Combustible
    this._setValue(document.querySelector("#energie"), vd.energie ?? "3");

    // Marca carrocería
    this._setValue(
      document.querySelector("#marqueVariante"),
      vd.carroceria_marca
    );

    // Básicos
    this._setValue(document.querySelector("#Km"), vd.kilometros);
    this._setValue(document.querySelector("#CV"), vd.potencia);
    this._setValue(document.querySelector("#cylindree"), vd.cilindrada);
    this._setValue(document.querySelector("#tank_capacity"), vd.capacidad_cuba);
    this._setValue(document.querySelector("#ref-park"), vd.codigo);

    // Dimensiones
    this._setValue(document.querySelector("#empat"), vd.distancia_ejes);
    this._setValue(document.querySelector("#haut"), vd.altura);
    this._setValue(document.querySelector("#larg"), vd.anchura);
    this._setValue(document.querySelector("#long"), vd.longitud);
    this._setValue(document.querySelector("#surface"), vd.superficie);

    // Neumáticos
    this._setValue(
      document.querySelector("#rear_tyre_condition"),
      vd.deterioro_ne_tra
    );
    this._setValue(
      document.querySelector("#front_tyre_condition"),
      vd.deterioro_ne_de
    );
    this._setValue(
      document.querySelector("#front_tyre_size"),
      vd.dimension_ne_de
    );
    this._setValue(
      document.querySelector("#rear_tyre_size"),
      vd.dimension_ne_tra
    );
    this._setValue(document.querySelector("#Rens_pneus"), vd.estado_di_ne);

    // Suspensiones
    this._setCheckedById(
      "susp_air",
      vd.suspension_ne && vd.suspension_ne !== "0"
    );
    this._setCheckedById(
      "susp_hydrau",
      vd.suspension_hi && vd.suspension_hi !== "0"
    );
    this._setCheckedById(
      "susp_meca",
      vd.suspension_me && vd.suspension_me !== "0"
    );

    // Pesos
    this._setValue(document.querySelector("#CU"), vd.carga_util);
    this._setValue(document.querySelector("#pav"), vd.peso_vacio);
    this._setValue(document.querySelector("#ptc"), vd.mma);
    this._setValue(document.querySelector("#ptra"), vd.ptma);

    // Caja cambios
    if (vd.caja_cambio !== undefined)
      this._setRadioSufijo("boite_vitesse_typ", vd.caja_cambio);
    this._setValue(
      document.querySelector("#boite_vitesse"),
      vd.precision_cambio
    );

    // Precio / Observaciones
    this._setValue(document.querySelector("#prix"), vd.precio);
    this._setValue(document.querySelector("#remarque"), vd.informacion_com);

    // Norma/Literas/Cabina
    if (vd.normas !== undefined) this._setRadioSufijo("norme_euro", vd.normas);
    if (vd.literas !== undefined) this._setRadioSufijo("couchette", vd.literas);
    if (vd.altura_cabina !== undefined)
      this._setRadioSufijo("hauteur_cab", vd.altura_cabina);
    if (vd.longitud_cabina !== undefined)
      this._setRadioSufijo("long_cabine", vd.longitud_cabina);
    if (vd.tipo_cabina !== undefined)
      this._setRadioSufijo("typ_cab", vd.tipo_cabina);

    // Grúa
    if (vd.grua_autocargante !== undefined)
      this._setCheckedById("grue", vd.grua_autocargante === "1");

    // Fechas / Ejes
    this._setValue(
      document.querySelector("#date"),
      this._toDMY(vd.fecha_matriculacion)
    );
    this._setValue(document.querySelector("#essieux"), vd.ejes);
    this._setValue(document.querySelector("#ess_semi"), vd.ejes_semiremolque);

    // Pasajeros / Horas
    this._setValue(document.querySelector("#nb_place_deb"), vd.numero_pla_pie);
    this._setValue(document.querySelector("#nb_place_ass"), vd.numero_pla_sen);
    this._setValue(document.querySelector("#Heures"), vd.numero_ho);

    // Tacógrafo
    this._setValue(
      document.querySelector("#dat_contro"),
      this._toDMY(vd.fecha_ul_vi_ta)
    );
    this._setValue(
      document.querySelector("#dat_min"),
      this._toDMY(vd.fecha_ul_in_te)
    );
    this._setValue(
      document.querySelector("#dat_min_val"),
      this._toDMY(vd.vencimiento_in_te)
    );
    this._setValue(document.querySelector("#typ_min"), vd.tipo_ins_te);

    // Equipamiento
    const cb = (prop, id) =>
      this._setCheckedById(id, vd[prop] && vd[prop] !== "0" && vd[prop] !== "");
    cb("abs", "abs");
    cb("adr", "adr");
    cb("bloque_diferencial", "bloc_diff");
    cb("control_estabilida", "esp");
    cb("deposito_suplementario", "reservoir");
    cb("direccion_asistida", "dir_ass");
    cb("enganche", "crochet");
    cb("airbag", "airbag");
    cb("alarma_marcha_atras", "Avertisseur_AR");
    cb("asiento_con_suspension", "siege_susp");
    cb("climatizacion", "Clim");
    cb("cierre_centralizado", "ferm_central");
    cb("ordenador_bordo", "ordi");
    cb("enganche_remolque", "att_rem");
    cb("regulador_velocidad", "regu_vitesse");
    cb("webasto", "webas");
    cb("retrovisores_electricos", "retro_elec");
    cb("ebs", "ebs");
    cb("gps", "gps");
    cb("ganchos_carne", "meat_holder");
    cb("eje_elevacion", "ess_relev");
    cb("telma", "telma");
    cb("asr", "asr");
    cb("dfr", "dfr");
    cb("retrovisores_electricos_ter", "retro_elec_chauf");
    cb("maletero", "coffre");
    cb("camara_vision_trasera", "cam_recul");
    cb("frigorifico", "frigo");
    cb("techo_practicable", "toit_ouv");

    // Marca / Gama / Modelo
    await this._setMarcaGamaModelo(vd);

    await this._wait(400);
    return true;
  }

  // ====== PASO 4: Subir fotos automáticas (XAMPP→base64→upload) ======
  async _subirFotosAutoFromLocal() {
    const vd = this.vehicleData || {};
    const vehicleIdFromURL = (location.pathname.match(/\/vehicle\/(\d+)/) ||
      [])[1];
    const folder =
      (vd.codigo && String(vd.codigo).trim()) ||
      (vd.vehicleId && String(vd.vehicleId).trim()) ||
      (vehicleIdFromURL && String(vehicleIdFromURL).trim());
    if (!folder) {
      this._log(
        "❌ Fotos: no tengo carpeta (usa vd.codigo o vehicleId). Sigo sin fotos.",
        "warning"
      );
      return true; // no bloquees todo por no tener fotos
    }

    // Diagnóstico rápido de localhost
    try {
      const pingUrl = `${this.LOCAL_PHOTOS_BASE}/__ping__.txt?ts=${Date.now()}`;
      await fetch(pingUrl, { cache: "no-store", mode: "no-cors" });
      this._log(`🖥️ XAMPP OK en ${this.LOCAL_PHOTOS_BASE}`, "info");
    } catch {
      this._log(
        `⚠️ No puedo contactar ${this.LOCAL_PHOTOS_BASE}. ¿XAMPP encendido / permisos en manifest?`,
        "warning"
      );
    }

    const vehicleId = vehicleIdFromURL || String(folder).replace(/\D/g, "");
    const cat = 31,
      isDepot = 1;
    let place = 1;

    // mayúsculas/minúsculas
    const exts = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".JPG",
      ".JPEG",
      ".PNG",
      ".WEBP",
    ];
    let uploaded = 0;

    const T0 = Date.now();
    const DEADLINE_MS = 25000; // 25s máx. en este paso para no quedarse colgado

    for (let i = 1; i <= this.MAX_PHOTOS; i++) {
      if (Date.now() - T0 > DEADLINE_MS) {
        this._log("⏱️ Timeout fotos: sigo al siguiente paso.", "warning");
        break;
      }

      const found = await this._buscarPrimeraQueExista(folder, i, exts);
      if (!found) {
        if (i === 1)
          this._log(
            `ℹ️ Sin fotos en ${this.LOCAL_PHOTOS_BASE}/${folder}/`,
            "info"
          );
        break;
      }

      let dataURL = await this._getDataURLFromLocal(found);
      if (!dataURL) {
        this._log(`⚠️ No pude leer: ${found}`, "warning");
        continue;
      }

      // Comprimir a <50KB (no bloqueante: con timeout interno)
      try {
        const beforeKB = Math.round(this._dataURLBytes(dataURL) / 1024);
        dataURL = await this._shrinkToMaxBytes(dataURL, {
          maxBytes: 50 * 1024,
          startQuality: 0.82,
          minQuality: 0.5,
          maxDim: 1600,
          minDim: 480,
          opTimeout: 7000,
        });
        const afterKB = Math.round(this._dataURLBytes(dataURL) / 1024);
        this._log(`🗜️ Foto: ${beforeKB}KB → ${afterKB}KB`, "info");
      } catch (e) {
        this._log(
          `⚠️ Compresión fallida: ${e?.message || e}. Subo original.`,
          "warning"
        );
      }

      const ok = await this._uploadOneViaMobilis(
        vehicleId,
        cat,
        isDepot,
        place,
        dataURL
      );
      if (ok) {
        uploaded++;
        this._log(`📸 place=${place}: OK (${found})`, "success");
        place++;
      } else {
        this._log(`❌ Fallo al subir (${found})`, "error");
      }
    }

    if (uploaded === 0) {
      this._log("ℹ️ No se subió ninguna imagen. Sigo con Validar.", "info");
      return true; // no paramos la automatización por falta de fotos
    }

    this._log(`✅ ${uploaded} foto(s) subidas desde localhost.`, "success");
    return true;
  }

  async _buscarPrimeraQueExista(folder, idx, exts) {
    for (const ex of exts) {
      const url = `${this.LOCAL_PHOTOS_BASE}/${encodeURIComponent(
        folder
      )}/${idx}${ex}`;
      const probe = await this._sendMessageWithTimeout(
        { type: "FETCH_LOCAL_IMAGE", url },
        { timeout: 2000 }
      );
      if (probe && probe.ok) return url;
    }
    return null;
  }

  async _getDataURLFromLocal(url) {
    const r = await this._sendMessageWithTimeout(
      { type: "FETCH_LOCAL_IMAGE", url },
      { timeout: 4000 }
    );
    return r && r.ok && r.dataURL ? r.dataURL : null;
  }

  async _uploadOneViaMobilis(vehicleId, cat, isDepot, place, dataUrl) {
    try {
      const u = new URL(
        `https://my.via-mobilis.com/vehicle/${vehicleId}/photos/upload`
      );
      u.searchParams.set("place", String(place));
      u.searchParams.set("cat", String(cat));
      u.searchParams.set("isDepot", String(isDepot));

      const body = new URLSearchParams({ urlImage: dataUrl });
      const resp = await fetch(u.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body,
      });

      if (!resp.ok) return false;
      const j = await resp.json().catch(() => null);
      return !!(j && j.files && j.files.length);
    } catch (e) {
      this._log(`❌ Upload error: ${e?.message || e}`, "error");
      return false;
    }
  }

  // ====== PASO 5: Validar (robusto, fotos + data-bt oculto) ======
  _clickValidarWithHidden(btn) {
    this._forceClick(btn); // visible
    const bt = btn.getAttribute("data-bt");
    if (bt) {
      const hidden = document.getElementById(bt);
      if (hidden) this._forceClick(hidden); // botón oculto #collapseXX
    }
  }
  _countUploadedPhotos() {
    const lis = document.querySelectorAll(
      "#images li.thumbs:not(.empty_slot), ul.thumbnails li.thumbs:not(.empty_slot)"
    );
    return lis ? lis.length : 0;
  }
  async _waitPhotosReady(timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this._countUploadedPhotos() > 0) return true;
      await this._wait(150);
    }
    return false;
  }

// ======= VALIDACIÓN ROBUSTA Y SEGURA PARA PUBLICAR ======= //
// ======= NUEVO _clickValidar: toggle por anclas en orden + publicar ======= //
async _clickValidar() {
  this._log('🧭 Iniciando secuencia por secciones (anclas)…', 'info');

  // Secuencia exacta que pediste (en este orden)
  const steps = [
    { link: 'a[data-toggle="collapse"][href="#collapseGThree"]',      panel: '#collapseGThree',      label: 'Información principal' },
    { link: 'a[data-toggle="collapse"][href="#collapseGFour"]',       panel: '#collapseGFour',       label: 'Fotografías y vídeos' },
    { link: 'a[data-toggle="collapse"][href="#collapseGFive"]',       panel: '#collapseGFive',       label: 'Detalles técnicos' },
    { link: 'a[data-toggle="collapse"][href="#collapseGDimensions"]', panel: '#collapseGDimensions', label: 'Dimensiones' },
  ];

  // Helper: abre un panel clicando su <a href="#..."> y espera a que quede “abierto/estable”
  const openPanel = async ({ link, panel, label }, { retries = 3 } = {}) => {
    for (let i = 0; i < retries; i++) {
      const a = document.querySelector(link);
      const body = document.querySelector(panel);

      if (!a || !body) {
        this._log(`⚠️ No encuentro ${label} (selector link: ${link} / panel: ${panel}).`, 'warning');
        return false;
      }

      // si ya está abierto, ok
      const isOpen = body.classList.contains('in') || body.classList.contains('show') || a.classList.contains('active');
      if (isOpen) {
        await this._waitStableLayout(body, 800);
        return true;
      }

      // clic para abrir
      try {
        a.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await this._wait(200);
        this._forceClick(a);
        this._log(`🟢 Click en ancla: ${label}`, 'info');
      } catch {}

      // espera animación bootstrap
      await this._wait(1200);
      await this._waitStableLayout(body, 1200);

      // comprobar si se abrió
      const nowOpen = body.classList.contains('in') || body.classList.contains('show') || a.classList.contains('active');
      if (nowOpen) return true;

      // reintento suave
      await this._wait(500 + i * 250);
    }
    this._log(`❌ No pude abrir el panel: ${label}`, 'error');
    return false;
  };

  // Helper: ¿publicar habilitado?
  const tryPublish = async (waitMs = 2000) => {
    const btn = await this._waitForPublishEnabled(waitMs);
    if (btn && this._isVisible(btn) && this._isEnabled(btn)) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await this._wait(200);
      this._forceClick(btn);
      this._alreadyPublished = true;
      await this._wait(800);
      this._log('🚀 Publicado correctamente.', 'success');
      return true;
    }
    return false;
  };

  // Bucle de rondas: repetimos la secuencia si aún no aparece Publicar
  const MAX_RONDAS = 6;
  for (let ronda = 1; ronda <= MAX_RONDAS; ronda++) {
    this._log(`🔁 Ronda ${ronda}/${MAX_RONDAS}: abriendo secciones en orden…`, 'info');

    // 1) Información principal
    await openPanel(steps[0], { retries: 3 });
    await this._wait(700);

    // 2) Tipo de anuncio — en tu HTML original este es #collapseGSix,
    //    pero nos pediste saltarlo y abrir directamente Fotos (#collapseGFour).
    //    Si quieres reintroducir #collapseGSix, añade otra entrada en steps y abre aquí.

    // 3) Fotografías y vídeos
    const fotosOk = await openPanel(steps[1], { retries: 3 });
    if (fotosOk) {
      // si hay flujo de thumbs/subida, espera a que haya al menos alguna miniatura
      this._log('📸 Comprobando miniaturas de fotos…', 'info');
      let thumbs = await this._waitPhotosReady(6000);
      if (!thumbs) {
        this._log('⚠️ Miniaturas no detectadas; espero más…', 'warning');
        thumbs = await this._waitPhotosReady(6000);
      }
      await this._wait(400);
    }

    // 4) Detalles técnicos
    await openPanel(steps[2], { retries: 3 });
    await this._wait(700);

    // 5) Dimensiones
    await openPanel(steps[3], { retries: 3 });
    await this._wait(700);

    // Deja que el layout se estabilice antes de buscar “Publicar”
    await this._waitStableLayout(document.body, 1200);

    // Intentar publicar
    if (await tryPublish(2500)) return true;

    // Espera entre rondas y reintenta todo
    this._log('⏳ “Publicar mi anuncio” aún no está habilitado. Repito la secuencia…', 'warning');
    await this._wait(2500);
  }

  // Último intento extendido
  this._log('⚠️ Intento final: estabilizando y reintentando publicar…', 'warning');
  await this._waitStableLayout(document.body, 1500);
  if (await tryPublish(6000)) return true;

  this._log('❌ “Publicar mi anuncio” no se habilitó. No avanzo.', 'error');
  return false;
}


  // ====== PASO 6: Publicar ======
  async _clickPublicar() {
    if (this._alreadyPublished) {
      this._log("⏭️ Publicar omitido (ya se pulsó en Validar).", "info");
      return true;
    }
    const btn = await this._waitForPublishEnabled(4000);
    if (!btn) {
      this._log(
        "❌ No encuentro el botón 'Publicar mi anuncio' habilitado.",
        "error"
      );
      return false;
    }
    this._forceClick(btn);
    this._log("🚀 Click en 'Publicar mi anuncio'", "info");
    await this._wait(600);
    return true;
  }

  // ========================
  // Marca / Gama / Modelo
  // ========================
  async _setMarcaGamaModelo(vd) {
    const brand = (vd.eu_marca ?? vd.marca ?? "").toString().trim();
    const range = (vd.eu_gama ?? vd.gama ?? "").toString().trim();
    const modelV = (vd.eu_modelo ?? vd.modelo ?? "").toString().trim();

    const q = (s) => document.querySelector(s);
    const fire = (el, types = ["input", "change", "blur"]) => {
      if (!el) return;
      try {
        for (const t of types)
          el.dispatchEvent(new Event(t, { bubbles: true }));
      } catch {}
    };
    const norm = (s) =>
      (s || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const byValueOrText = (sel, wanted) => {
      if (!sel || !wanted) return null;
      const w = norm(wanted);
      const opts = Array.from(sel.options || []);
      let opt = opts.find((o) => norm(o.value) === w);
      if (!opt) opt = opts.find((o) => norm(o.textContent) === w);
      if (!opt) opt = opts.find((o) => norm(o.textContent).includes(w));
      return opt || null;
    };

    const ensureAndPick = (sel, wanted) => {
      if (!sel || !wanted) return false;
      const opt = byValueOrText(sel, wanted);
      if (opt) {
        sel.value = opt.value;
      } else {
        const v = wanted;
        const ghost = new Option(v, v, true, true);
        sel.add(ghost);
        sel.value = v;
      }
      fire(sel);
      return true;
    };

    const waitOptions = async (sel, { hasText, timeout = 5000 } = {}) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (sel && sel.options && sel.options.length > 0) {
          if (!hasText) return true;
          const ok = !!byValueOrText(sel, hasText);
          if (ok) return true;
        }
        await this._wait(120);
      }
      return false;
    };

    const showFreeModel = () => {
      const sel = q("#modele");
      const free1 = q("#modele_free");
      const free2 = q("#modele_libre");
      if (sel) sel.classList.add("hidden");
      if (free1) free1.classList.remove("hidden");
      if (free2) free2.classList.remove("hidden");
    };
    const hideFreeModel = () => {
      const sel = q("#modele");
      const free1 = q("#modele_free");
      const free2 = q("#modele_libre");
      if (sel) sel.classList.remove("hidden");
      if (free1) {
        free1.classList.add("hidden");
        free1.value = "";
        fire(free1);
      }
      if (free2) {
        free2.classList.add("hidden");
        free2.value = "";
        fire(free2);
      }
    };

    // 1) Marca
    const selBrand = q("#marque");
    if (brand && selBrand) {
      ensureAndPick(selBrand, brand);
    }

    // 2) Gama
    const selRange = q("#gamme");
    if (selRange) {
      await waitOptions(selRange, { timeout: 5000 });
      if (range) ensureAndPick(selRange, range);
    }

    // 3) Modelo
    const selModel = q("#modele");
    if (selModel) {
      await waitOptions(selModel, {
        hasText: modelV || undefined,
        timeout: 5000,
      });
    }

    let modelSet = false;
    if (modelV && selModel) {
      modelSet = ensureAndPick(selModel, modelV);

      if (modelSet) {
        await this._wait(150);
        const stillThere = byValueOrText(selModel, modelV);
        if (!stillThere) {
          await waitOptions(selModel, { hasText: modelV, timeout: 2000 });
          modelSet = ensureAndPick(selModel, modelV);
        }
      }
    }

    if (modelSet) {
      hideFreeModel();
    } else {
      showFreeModel();
      const val = modelV || (vd.modelo ?? "");
      const f1 = q("#modele_free");
      const f2 = q("#modele_libre");
      if (f1) {
        f1.value = val;
        fire(f1);
      }
      if (f2) {
        f2.value = val;
        fire(f2);
      }
    }

    const chosen = (() => {
      if (selModel && selModel.offsetParent !== null) {
        const opt = selModel.selectedOptions && selModel.selectedOptions[0];
        return (opt ? opt.textContent || opt.value : selModel.value) || "";
      }
      return q("#modele_free")?.value || q("#modele_libre")?.value || "";
    })();
    this._log(
      `🧩 Marca/Gama/Modelo → [${brand}] / [${range}] / [${chosen}]`,
      "info"
    );
  }

  // ==== Mensajería con timeout (evita quedarse colgado si el SW duerme) ====
  _sendMessageWithTimeout(payload, { timeout = 2000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, timeout);
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(resp || null);
        });
      } catch {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null);
        }
      }
    });
  }
}

// Anti-duplicado: si el CS se inyecta dos veces, no re-creamos la clase
if (window.__cochesNetAuto) {
  console.warn("Duplicate CochesNetAutomation blocked");
} else {
class CochesNetAutomation {
  constructor() {
    // Estado básico
    this.LOCAL_PHOTOS_BASE = "http://127.0.0.1/photos";
    this.MAX_PHOTOS = 30;

    this.currentStep = 0;
    this.isRunning = false;
    this.vehicleData = null;

    // Control de reentradas / SPA
    this._runId = 0;          // cambia en cada START
    this.retryDelay = 400;

    this._setupMsgListener();
  }

  // ========== Utilidades básicas ==========

  _log(message, type = "info") {
    try {
      chrome.runtime.sendMessage({
        type: "LOG_UPDATE",
        data: { message, type }
      });
    } catch (e) {
      console.warn("[CochesNetAutomation LOG]", message, type, e);
    }
  }

  _status(text, type = "running") {
    try {
      chrome.runtime.sendMessage({
        type: "STATUS_UPDATE",
        data: { text, type }
      });
    } catch (e) {
      console.warn("[CochesNetAutomation STATUS]", text, type, e);
    }
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Espera a que exista un elemento con el selector, reintentando
  async _waitFor(selector, timeout = 10000, stepMs = 500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await this._wait(stepMs);
    }
    return null;
  }

  // Helper genérico de reintentos (para opciones de selects, etc.)
  async _retryUntil(fnCheck, timeout = 10000, stepMs = 500) {
    const start = Date.now();
    let result = null;

    while (Date.now() - start < timeout) {
      result = fnCheck();
      if (result) return result;
      await this._wait(stepMs);
    }
    return null;
  }

  _forceClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (_) {}
    try {
      el.click();
    } catch {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(ev);
    }
  }

  // ========= Mensajería con background/popup =========

  _setupMsgListener() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      (async () => {
        try {
          switch (msg.type) {
            case "PING": {
              sendResponse?.({
                success: true,
                message: "content-script alive (coches.net)",
                status: {
                  site: "coches",
                  isRunning: this.isRunning,
                  currentStep: this.currentStep,
                  url: window.location.href
                }
              });
              break;
            }

            case "START_AUTOMATION": {
              if (this.isRunning) {
                this._log("⛔ Deteniendo ejecución previa de Coches.net…", "warning");
                this._hardStop();
              }

              this.vehicleData = msg.vehicleData || null;
              await this._start();
              sendResponse?.({ success: true });
              break;
            }

            case "STOP_AUTOMATION": {
              this._log("⛔ STOP_AUTOMATION recibido (coches.net)", "warning");
              this._hardStop();
              sendResponse?.({ success: true });
              break;
            }

            case "RESET_AUTOMATION": {
              this._log("🔄 RESET_AUTOMATION (coches.net)", "info");
              this._hardStop();
              this.currentStep = 0;
              this.vehicleData = null;
              sendResponse?.({ success: true });
              break;
            }

            default:
              break;
          }
        } catch (e) {
          sendResponse?.({ success: false, error: e?.message || String(e) });
        }
      })();
      return true; // async
    });
  }

  _hardStop() {
    this.isRunning = false;
    this._runId++;
  }

  // ========== Inicio / ciclo principal ==========

  async _start() {
    const okHost = /(^|\.)pro\.coches\.net$/i.test(location.host);
  if (!okHost) {
    // Antes: this._log("❌ No estás en pro.coches.net", "error");
    // Ahora simplemente pasamos de largo:
    return;
  }
  
    if (!location.host.includes("coches.net")) {
      this._status("Debes estar en pro.coches.net", "error");
      this._log("❌ No estás en pro.coches.net", "error");
      return;
    }

    this._runId++;
    const runId = this._runId;

    this.isRunning = true;
    this.currentStep = 0;

    this._status("Iniciando Coches.net…", "running");
    this._log("🚀 Iniciando Coches.net…", "info");

    this._executeStep(runId);
  }

  async _executeStep(runId) {
    if (!this.isRunning || runId !== this._runId) return;

    const STEPS = [
      { name: "insertarBtn",       desc: "Click en 'Insertar vehículo'" },
      { name: "categoriaCamion",   desc: "Seleccionar categoría Camión" },
      { name: "insertarDatos",     desc: "Insertar datos del vehículo" },
      { name: "fotos",             desc: "Subir fotos" },
      { name: "confirmarInsertar", desc: "Confirmar Inserción" },
      { name: "publicarLuego",     desc: "Click en 'Publicar más tarde'" }
    ];

    if (this.currentStep >= STEPS.length) {
      await this._complete(runId);
      return;
    }

    const step = STEPS[this.currentStep];
    if (!step) {
      this._log("⚠️ Paso indefinido (currentStep=" + this.currentStep + ")", "warning");
      await this._complete(runId);
      return;
    }

    this._status(step.desc);
    this._log(`➡️ Paso ${this.currentStep + 1}: ${step.desc}`, "info");

    let ok = false;
    try {
      switch (step.name) {
        case "insertarBtn":
          ok = await this._clickInsertarVehiculo();
          break;
        case "categoriaCamion":
          ok = await this._seleccionarCategoriaCamion();
          break;
        case "insertarDatos":
          // 🕒 Espera global de 1.5s al llegar a este paso para que la SPA pinte el DOM
          this._log("⏳ Esperando 1.5s antes de rellenar datos…", "info");
          await this._wait(1500);
          ok = await this._rellenarDatos();
          break;
        case "fotos":
          ok = await this._fotos();
          break;
        case "confirmarInsertar":
          ok = await this._clickConfirmarInsertar();
          break;
        case "publicarLuego":
          ok = await this._clickPublicarMasTarde();
          break;
        default:
          ok = true;
      }
    } catch (e) {
      if (runId !== this._runId) return;
      const msg = e?.message || String(e);
      this._log(`❌ Error en paso "${step.desc}": ${msg}`, "error");
      this.isRunning = false;
      return;
    }

    if (!this.isRunning || runId !== this._runId) return;

    if (!ok) {
      this._log(`❌ Fallo en paso: ${step.desc}`, "error");
      this.isRunning = false;
      return;
    }

    this._log(`✔ OK: ${step.desc}`, "success");
    this.currentStep++;
    await this._wait(500);
    this._executeStep(runId);
  }

  async _complete(runId) {
    if (runId !== this._runId) return;

    this._log("🎉 Coches.net → Vehículo completado", "success");
    this._status("✅ Vehículo completado en Coches.net", "success");

    try {
      const sessionId = `coches-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;
      chrome.runtime.sendMessage({
        type: "AUTOMATION_COMPLETE",
        data: { sessionId, site: "coches.net" }
      });
    } catch (e) {
      console.warn("[CochesNetAutomation] Error enviando AUTOMATION_COMPLETE", e);
    }

    try {
      chrome.runtime.sendMessage({
        type: "COCHESNET_VEHICLE_DONE",
        data: { ok: true }
      });
    } catch (e) {
      console.warn("[CochesNetAutomation] Error enviando COCHESNET_VEHICLE_DONE", e);
    }

    setTimeout(() => {
      if (!location.href.includes("/stock")) {
        window.location.href = "https://beta.pro.coches.net/stock";
      }
    }, 800);

    this.isRunning = false;
    this.currentStep = 0;
  }

  // ========== PASO 1 – Click en "Insertar vehículo" ==========

  async _clickInsertarVehiculo() {
    const span = await this._retryUntil(() => {
      return (
        [...document.querySelectorAll("button span.sui-AtomButton-content")]
          .find(el => /Insertar vehículo/i.test(el.textContent || "")) || null
      );
    }, 10000, 500);

    if (!span) {
      this._log("❌ No encuentro el botón 'Insertar vehículo' tras 10s", "error");
      return false;
    }
    const btn = span.closest("button");
    if (!btn) {
      this._log("❌ Span sin <button> padre para 'Insertar vehículo'", "error");
      return false;
    }

    this._forceClick(btn);
    await this._wait(1200);
    return true;
  }

  // ========== PASO 2 – Seleccionar categoría Camión ==========

  async _seleccionarCategoriaCamion() {
    const target = await this._retryUntil(() => {
      const labels = [...document.querySelectorAll(".cf-FormBodyTypeCategory-categoryLabel")];
      if (!labels.length) return null;
      return labels.find(el => /camión/i.test((el.textContent || "").trim())) || null;
    }, 10000, 500);

    if (!target) {
      this._log("❌ No encuentro la categoría 'Camión' tras 10s", "error");
      return false;
    }

    const container = target.closest(".cf-FormBodyTypeCategory-category") || target;
    this._forceClick(container);
    await this._wait(1500);
    return true;
  }

  // ========== PASO 3 – Insertar datos vehículo ==========

  async _rellenarDatos() {
    const v = this.vehicleData || {};
    if (!v) {
      this._log("⚠️ Sin vehicleData en Coches.net", "error");
      return false;
    }

    // Subcategoría → Rígido 18T (2 ejes)  (aquí puedes activar martillo si quieres)
    await this._clickSelectAndChoose("#vehicleTypeId", "18T");

    // Carrocería → Caja abierta
    await this._clickSelectAndChoose("#bodyTypeIdDoors", "Caja abierta");

    // Marca (autocomplete)
    if (v.marca) {
      await this._inputAutocomplete("#makeId", v.marca);
    }

    // Modelo
    if (v.modelo) this._setValue("#modelVersion", v.modelo);

    // Año matriculación
    if (v.fecha_matriculacion) {
      const year = String(v.fecha_matriculacion).substring(0, 4);
      if (year) {
        await this._clickSelectAndChoose("#year", year);
      }
    }

    // Potencia
    if (v.potencia) this._setValue("#engine", v.potencia);

    // Peso Bruto
    if (v.potencia) this._setValue("#weight", v.peso_vacio);

    // Kilómetros
    if (v.kilometros) this._setValue("#kilometers", v.kilometros);

    // Carga útil
    if (v.carga_util) this._setValue("#loadCapacity", v.carga_util);

    // Referencia interna
    if (v.codigo) {
      this._setValue("#reference", v.codigo);
    }

    // Precio + quitar “impuestos incluidos”
    if (v.precio) {
      this._setValue("#cashPrice", v.precio);
      await this._unsetTaxesIncluded();
    }

    // Garantía → 6 meses
    await this._clickSelectAndChoose("#warrantyMonths", "Sin garantía");

    // Descripción
    if (v.informacion_com) {
      this._setValue("#additionalInformation", v.informacion_com);
    }

    // 🔗 Enlace externo (botón "Enlazar" + input #externalUrlId)
    await this._setExternalUrlFromVehicle(v);

    return true;
  }

    async _setExternalUrlFromVehicle(v) {
    const url = v && v.longitud;
    if (!url) {
      this._log("ℹ️ Sin v.longitud, no relleno el enlace externo", "info");
      return true; // no es un error, simplemente no hay dato
    }

    this._log("⏳ Preparando enlace externo (botón 'Enlazar' + URL)…", "info");

    // 1) Buscar el botón "Enlazar" con reintentos
    const span = await this._retryUntil(() => {
      return (
        [...document.querySelectorAll("button span.sui-AtomButton-content")]
          .find(el => /Enlazar/i.test(el.textContent || "")) || null
      );
    }, 10000, 500);

    if (!span) {
      this._log("❌ No encuentro el botón 'Enlazar' tras 10s", "error");
      return false;
    }

    const btn = span.closest("button");
    if (!btn) {
      this._log("❌ Span 'Enlazar' sin <button> padre", "error");
      return false;
    }

    // 2) Click en el botón Enlazar
    this._forceClick(btn);
    await this._wait(500);

    // 3) Esperar al input de URL y rellenarlo
    const input = await this._waitFor("#externalUrlId", 5000, 500);
    if (!input) {
      this._log("❌ No encuentro el input #externalUrlId tras 5s", "error");
      return false;
    }

    this._setValue("#externalUrlId", url);
    this._log(`🔗 Establecida URL externa en #externalUrlId: ${url}`, "success");

    return true;
  }



  // ===== Helpers XAMPP / fotos =====

  _sendMessageWithTimeoutCoches(payload, { timeout = 4000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, timeout);

      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(resp || null);
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null);
        }
      }
    });
  }

  async _buscarPrimeraQueExistaCoches(folder, idx) {
    const exts = [
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".JPG",
      ".JPEG",
      ".PNG",
      ".WEBP",
    ];

    for (const ex of exts) {
      const url = `${this.LOCAL_PHOTOS_BASE}/${encodeURIComponent(folder)}/${idx}${ex}`;

      const probe = await this._sendMessageWithTimeoutCoches(
        { type: "FETCH_LOCAL_IMAGE", url },
        { timeout: 2000 }
      );

      if (probe && probe.ok) return url;
    }
    return null;
  }

  async _getDataURLFromLocalCoches(url) {
    const r = await this._sendMessageWithTimeoutCoches(
      { type: "FETCH_LOCAL_IMAGE", url },
      { timeout: 4000 }
    );
    return r && r.ok && r.dataURL ? r.dataURL : null;
  }

  async _dataURLToFileCoches(dataURL, fileName) {
    const res = await fetch(dataURL);
    const blob = await res.blob();
    const type = blob.type || "image/jpeg";
    return new File([blob], fileName, { type });
  }

  async _unsetTaxesIncluded() {
    try {
      const field = document.querySelector("#field-taxesIncluded");
      if (!field) {
        this._log("⚠️ No encuentro el contenedor de 'Impuestos incluídos'", "warning");
        return;
      }

      const input  = field.querySelector("#taxesIncluded");
      const button = field.querySelector("button.sui-AtomCheckbox--Icon");

      if (!input || !button) {
        this._log("⚠️ No encuentro el checkbox/botón de 'Impuestos incluídos'", "warning");
        return;
      }

      const isChecked =
        input.checked === true ||
        input.getAttribute("aria-checked") === "true" ||
        button.classList.contains("is-checked");

      if (!isChecked) {
        this._log("ℹ️ 'Impuestos incluídos' ya está desmarcado", "info");
        return;
      }

      this._log("🔧 Desmarcando 'Impuestos incluídos'…", "info");
      this._forceClick(button);
      await this._wait(300);
    } catch (e) {
      this._log("⚠️ Error al desmarcar 'Impuestos incluídos': " + (e?.message || e), "warning");
    }
  }

  // ---------- helpers de inputs / selects ----------

  async _clickSelectAndChoose(selector, textToMatch) {
    // 🔧 MODO MARTILLO para selects "especiales":
    // - #vehicleTypeId  (subcategoría: 18T…)
    // - #bodyTypeIdDoors (carrocería: Caja abierta…)
    if (selector === "#vehicleTypeId" || selector === "#bodyTypeIdDoors") {
      const totalTimeout = 60000; // 1 minuto
      const stepMs = 500;         // click cada 0.5s
      const start = Date.now();

      // Esperamos a que aparezca el input
      const input = await this._waitFor(selector, totalTimeout, stepMs);
      if (!input) {
        this._log(`❌ No encuentro el selector ${selector} tras 60s`, "error");
        return false;
      }

      // Raíz del select y UL de opciones asociado
      const root =
        input.closest(".sui-MoleculeSelect") ||
        input.closest(".cf-FormManager-field") ||
        document;

      const ul =
        root.querySelector(".sui-MoleculeDropdownList") ||
        root.querySelector("ul.sui-MoleculeDropdownList");

      this._log(`⏳ Modo martillo para ${selector} (1 min, click cada 0.5s)…`, "info");

      while (Date.now() - start < totalTimeout) {
        // 1) Click en el input para despertar el desplegable
        this._forceClick(input);

        // 2) Si el UL está oculto (is-hidden / display:none), lo mostramos
        if (ul) {
          if (ul.classList.contains("is-hidden")) {
            ul.classList.remove("is-hidden");
          }
          if (ul.style.display === "none") {
            ul.style.display = "";
          }
        }

        // 3) Buscamos opciones visibles dentro del UL (si existe) o la raíz
        const optionsContainer = ul || root;
        const opts = [...optionsContainer.querySelectorAll(".sui-MoleculeDropdownOption")]
          .filter((el) => el.offsetParent !== null);

        if (opts.length) {
          const upper = (textToMatch || "").toUpperCase();
          const opt = opts.find((el) =>
            (el.textContent || "").toUpperCase().includes(upper)
          );
          if (opt) {
            this._log(`✅ Encontrada opción "${textToMatch}" para ${selector}`, "success");
            this._forceClick(opt);
            await this._wait(300);
            return true;
          }
        }

        // 4) Esperamos 0.5s y volvemos a intentar
        await this._wait(stepMs);
      }

      this._log(
        `❌ No encontré opción con texto "${textToMatch}" para ${selector} tras 60s (modo martillo)`,
        "error"
      );
      return false;
    }

    // 🔁 COMPORTAMIENTO GENÉRICO para el resto de selects
    const input = await this._waitFor(selector, 10000, 500);
    if (!input) {
      this._log(`❌ No encuentro el selector ${selector} tras 10s`, "error");
      return false;
    }

    this._forceClick(input);
    await this._wait(300);

    const opt = await this._retryUntil(() => {
      const opts = [...document.querySelectorAll(".sui-MoleculeDropdownOption")]
        .filter((el) => el.offsetParent !== null);

      if (!opts.length) return null;

      const upper = (textToMatch || "").toUpperCase();
      return (
        opts.find((el) =>
          (el.textContent || "").toUpperCase().includes(upper)
        ) || null
      );
    }, 10000, 500);

    if (!opt) {
      this._log(
        `❌ No encontré opción con texto "${textToMatch}" para ${selector} tras 10s`,
        "error"
      );
      return false;
    }

    this._forceClick(opt);
    await this._wait(300);
    return true;
  }


  async _inputAutocomplete(selector, text) {
    const input = await this._waitFor(selector, 10000, 500);
    if (!input) {
      this._log(`❌ No encuentro el input ${selector} tras 10s`, "error");
      return false;
    }

    input.focus();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await this._wait(600);

    const opt = await this._retryUntil(() => {
      const opts = [...document.querySelectorAll(".sui-MoleculeDropdownOption")]
        .filter(el => el.offsetParent !== null);

      if (!opts.length) return null;

      const upper = (text || "").toUpperCase();
      return opts.find(el =>
        (el.textContent || "").toUpperCase().includes(upper)
      ) || null;
    }, 10000, 500);

    if (!opt) {
      this._log(
        `❌ No encuentro en la lista el valor "${text}" para ${selector} tras 10s`,
        "error"
      );
      return false;
    }

    this._forceClick(opt);
    await this._wait(300);
    return true;
  }

  _setValue(selector, value) {
    if (value == null || value === "") return;
    const el = document.querySelector(selector);
    if (!el) {
      this._log(`⚠️ No encuentro el campo ${selector} para asignar valor`, "warning");
      return;
    }
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ========== PASO 4 – Fotos (Coches.net) ==========

  async _fotos() {
    const v = this.vehicleData || {};
    const folder =
      (v.codigo && String(v.codigo).trim()) ||
      (v.vehicleId && String(v.vehicleId).trim());

    if (!folder) {
      this._log("ℹ️ Coches.net: sin carpeta local (codigo / vehicleId)", "info");
      return true;
    }

    const input =
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"][multiple]') ||
      document.querySelector('input[type="file"]');

    if (!input) {
      this._log("❌ Coches.net: no encuentro el <input type='file'> de fotos", "error");
      return false;
    }

    const dt = new DataTransfer();
    let count = 0;

    for (let i = 1; i <= this.MAX_PHOTOS; i++) {
      const url = await this._buscarPrimeraQueExistaCoches(folder, i);
      if (!url) {
        if (i === 1) {
          this._log(
            `ℹ️ Coches.net: no hay fotos en ${this.LOCAL_PHOTOS_BASE}/${folder}/`,
            "info"
          );
        }
        break;
      }

      const dataURL = await this._getDataURLFromLocalCoches(url);
      if (!dataURL) {
        this._log(`⚠️ Coches.net: no pude leer ${url}`, "warning");
        continue;
      }

      const fileName = i + (url.match(/\.[a-zA-Z0-9]+$/)?.[0] || ".jpg");
      const file = await this._dataURLToFileCoches(dataURL, fileName);

      dt.items.add(file);
      count++;
    }

    if (count === 0) {
      this._log("ℹ️ Coches.net: sin fotos válidas, sigo al siguiente paso", "info");
      return true;
    }

    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const dz =
      input.closest("[data-testid='photos-dropzone'], .cf-VehiclePhotos-dropZone") ||
      input.parentElement;
    if (dz) {
      try {
        const dropEvent = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        });
        dz.dispatchEvent(dropEvent);
      } catch (_) {}
    }

    this._log(
      `📸 Coches.net: añadidas ${count} foto(s) al formulario`,
      "success"
    );

    return true;
  }


  // ========== PASO 5 – Confirmar "Insertar vehículo" ==========

  async _clickConfirmarInsertar() {
        // ⏱ Espera larga para que el portal suba/procese las fotos
    this._log("⏳ Esperando 5s para que Coches.net procese las fotos…", "info");
    await this._wait(5000);
    const span = await this._retryUntil(() => {
      return (
        [...document.querySelectorAll("button span.sui-AtomButton-content")]
          .find(el =>
            /Insertar vehículo/i.test(el.textContent || "") ||
            /Confirmar inserci[oó]n/i.test(el.textContent || "")
          ) || null
      );
    }, 10000, 500);

    if (!span) {
      this._log("❌ No encuentro el botón de confirmar inserción tras 10s", "error");
      return false;
    }

    const btn = span.closest("button");
    if (!btn) {
      this._log("❌ Span sin <button> padre en confirmar inserción", "error");
      return false;
    }

    this._forceClick(btn);
    await this._wait(1500);
    return true;
  }

  // ========== PASO 6 – "Publicar más tarde" ==========
  async _waitWhileInserting(timeout = 60000, stepMs = 500) {
    const start = Date.now();
    let hasSeenSpinner = false;

    this._log("⏳ Comprobando si aparece 'Insertando tu vehículo en tu stock'…", "info");

    while (Date.now() - start < timeout) {
      const container = document.querySelector(".cf-PageInfoWaiting-content");
      const textEl = container
        ? container.querySelector(".cf-PageInfoWaiting-text")
        : null;

      const text = (textEl && textEl.textContent) ? textEl.textContent.trim() : "";

      const isInserting =
        !!container &&
        !!text &&
        /Insertando tu veh[ií]culo en tu stock/i.test(text);

      if (isInserting) {
        if (!hasSeenSpinner) {
          hasSeenSpinner = true;
          this._log("⏳ Detectado overlay 'Insertando tu vehículo en tu stock'. Esperando a que termine…", "info");
        }
        await this._wait(stepMs);
        continue;
      }

      // Si ya lo vimos y ahora ha desaparecido, damos OK
      if (hasSeenSpinner) {
        this._log("✅ Overlay 'Insertando tu vehículo en tu stock' desaparecido. Continuamos.", "success");
      } else {
        this._log("ℹ️ No se ha mostrado overlay de 'Insertando tu vehículo en tu stock'", "info");
      }

      return true;
    }

    this._log(
      `⚠️ El mensaje 'Insertando tu vehículo en tu stock' sigue (o no ha desaparecido) tras ${timeout / 1000}s`,
      "warning"
    );
    return false;
  }

  async _clickPublicarMasTarde() {
    this._log("⏳ Buscando botón 'Publicar más tarde' con reintentos…", "info");

    // 1) Buscar el span del botón con reintentos
    const span = await this._retryUntil(() => {
      return (
        [...document.querySelectorAll("button span.sui-AtomButton-content")]
          .find(el => /Publicar m[aá]s tarde/i.test(el.textContent || "")) || null
      );
    }, 15000, 500);

    if (!span) {
      this._log("❌ No encuentro el botón 'Publicar más tarde' tras 15s", "error");
      return false;
    }

    const btn = span.closest("button");
    if (!btn) {
      this._log("❌ Span sin <button> padre en 'Publicar más tarde'", "error");
      return false;
    }

    // 2) Click "fuerte" sobre el botón
    this._log("🖱 Haciendo click en 'Publicar más tarde'…", "info");
    this._forceClick(btn);

    // Deja un pequeño margen para que empiece la petición
    await this._wait(1500);

    // 3) Si aparece el overlay de "Insertando tu vehículo en tu stock", esperar a que desaparezca
    await this._waitWhileInserting(60000, 500);

    return true;
  }

}
 window.__cochesNetAuto = new CochesNetAutomation();
}

// =========================
// Wallapop (es.wallapop.com)
// =========================

class WallapopAutomation {
  // ===== Config =====
  PHOTOS_API_BASE = "http://127.0.0.1/photos"; // XAMPP
  MAX_PHOTOS = 30; // como en tu bot

  // Timeouts "modo robusto"
  FORM_TIMEOUT_MS = 45000;              // esperar formulario hasta 45s
  ADD_BRAND_TIMEOUT_MS = 30000;         // activar marca manual hasta 30s
  URL_WAIT_DEFAULT_MS = 20000;          // espera genérica de URL
  OPEN_SELL_URL_TIMEOUT_MS = 25000;     // navegar a /upload/cars hasta 25s
  SELECT_VEHICLE_TIMEOUT_MS = 20000;    // "Un vehículo" hasta 20s
  SUBMIT_BUTTON_TIMEOUT_MS = 30000;     // buscar botón "Subir producto" hasta 30s
  SUBMIT_HAMMER_TIMEOUT_MS = 20000;     // martillear botón hasta 20s
  SUBMIT_HAMMER_INTERVAL_MS = 800;      // cada 800ms un click
  WAIT_FOR_ELEMENT_DEFAULT_MS = 20000;  // _waitForElement por defecto 20s
  WAIT_AFTER_PHOTOS_MS = 10000;         // esperar 10s tras subir fotos

  // ⚙️ AJUSTES SOLO PARA FOTOS Y REDIRECCIÓN TRAS PUBLICAR
  PHOTOS_TOTAL_TIMEOUT_MS = 0;          // 0 = sin límite global para subir todas las fotos
  PHOTO_FETCH_TIMEOUT_MS = 10000;       // timeout al probar si existe la foto (buscar 1.jpg, 2.jpg...)
  PHOTO_DATAURL_TIMEOUT_MS = 20000;     // timeout al obtener el dataURL desde el background
  PHOTO_COMPRESS_TIMEOUT_MS = 20000;    // timeout para la compresión de una foto
  SUBMIT_REDIRECT_TIMEOUT_MS = 6000000;   // esperar hasta 60s a que redirija a created=true;itemId=...

  // Singleton para evitar instancias duplicadas en el mismo tab
  static _instance = null;

  constructor() {
    if (WallapopAutomation._instance) {
      console.log("⚠️ WallapopAutomation ya estaba instanciada; reutilizando instancia existente.");
      return WallapopAutomation._instance;
    }
    WallapopAutomation._instance = this;

    this.currentStep = 0;
    this.isRunning = false;
    this._stepExecuting = false;

    // Datos del anuncio
    this.vehicleData = null;      // Truck
    this.brands = [];
    this.energies = [];
    this.gearboxes = [];
    this.location = null;         // { postalCode, latitude, longitude }
    this.locationName = "";       // "Madrid"
    this.referenceSuffix = "";    // sufijo del título

    // Cola / sesión
    this.isQueueProcessing = false;
    this.queueInfo = null;
    this._completedOnce = false;
    this.sessionId = null;

    // Navegación
    this._watcher = null;
    this._lastUrl = location.href;
    this._waitingSubmitNavigation = false; // esperando navegación tras publicar

    // Retries
    this.maxRetries = 3;
    this.retryDelay = 800;

    // Estado persistente
    this.storageKeyRunning = "walla_running";
    this.storageKeyStep = "walla_step";
    this.storageKeyData = "walla_data";
    this.storageKeyCfg  = "walla_cfg";

    // Base local de fotos (reutilizamos helpers de Autoline)
    this.LOCAL_PHOTOS_BASE = this.PHOTOS_API_BASE;

    // Bloquear Enter durante la automatización
    this._keydownBlocker = (e) => {
      if (!this.isRunning) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this._log("⛔ Enter bloqueado (Wallapop) para evitar navegar sin querer", "info");
      }
    };
    window.addEventListener("keydown", this._keydownBlocker, true);

    this._setupMsgListener();
    this._startNavigationWatcher();
    this._loadStateAndMaybeResume();
  }

  // ========================
  // Mensajería con background/popup
  // ========================
  _setupMsgListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      (async () => {
        try {
          switch (message.type) {
            case "PING": {
              sendResponse({
                success: true,
                message: "content-script Wallapop alive",
                status: {
                  isRunning: this.isRunning,
                  currentStep: this.currentStep,
                  url: window.location.href,
                },
              });
              break;
            }

            case "START_AUTOMATION": {
              // 1) Datos del vehículo (Truck)
              if (message.vehicleData) {
                this.vehicleData = message.vehicleData;
              }

              // 2) Config extra (marcas, energía, cambios, ubicación, sufijo título)
              if (Array.isArray(message.brands))   this.brands   = message.brands;
              if (Array.isArray(message.energies)) this.energies = message.energies;
              if (Array.isArray(message.gearboxes)) this.gearboxes = message.gearboxes;

              if (message.location) this.location = message.location;
              if (typeof message.locationName === "string") {
                this.locationName = message.locationName;
              }
              if (typeof message.referenceSuffix === "string") {
                this.referenceSuffix = message.referenceSuffix.trim();
              }

              // 3) Modo cola
              this.isQueueProcessing = !!message.isQueueProcessing;
              this.queueInfo = message.queueInfo || null;

              if (this.isQueueProcessing && this.queueInfo?.justStarted) {
                this._log("🔄 Nuevo vehículo en cola (Wallapop): reinicio completo de estado", "info");
                this.queueInfo.justStarted = false;
                this.isRunning = false;
                this.currentStep = 0;
                this._completedOnce = false;
                this.sessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

                await chrome.storage.local.remove([
                  this.storageKeyRunning,
                  this.storageKeyStep,
                  this.storageKeyData,
                  this.storageKeyCfg,
                ]);
                await this._delay(300);
              }

              await this._start();
              sendResponse?.({ success: true });
              break;
            }

            case "STOP_AUTOMATION": {
              await this._stop();
              sendResponse?.({ success: true });
              break;
            }

            case "RESET_AUTOMATION": {
              await this._reset();
              sendResponse?.({ success: true });
              break;
            }

            default:
              break;
          }
        } catch (e) {
          sendResponse?.({ success: false, error: e?.message });
        }
      })();
      return true; // async
    });
  }

  _send(type, data) {
    try {
      chrome.runtime.sendMessage({ type, data });
    } catch {}
  }
  _status(text, type = "running") {
    this._send("STATUS_UPDATE", { text, type });
  }
  _progress(cur, total) {
    this._send("PROGRESS_UPDATE", { current: cur, total });
  }
  _log(message, type = "info") {
    this._send("LOG_UPDATE", { message, type });
  }

  // ========================
  // Persistencia
  // ========================
  async _saveState() {
    const cfg = {
      location: this.location,
      locationName: this.locationName,
      referenceSuffix: this.referenceSuffix,
    };
    await chrome.storage.local.set({
      [this.storageKeyRunning]: this.isRunning,
      [this.storageKeyStep]: this.currentStep,
      [this.storageKeyData]: this.vehicleData,
      [this.storageKeyCfg]: cfg,
    });
  }

  async _loadStateAndMaybeResume() {
    const st = await chrome.storage.local.get([
      this.storageKeyRunning,
      this.storageKeyStep,
      this.storageKeyData,
      this.storageKeyCfg,
    ]);

    if (st[this.storageKeyCfg]) {
      const cfg = st[this.storageKeyCfg];
      this.location = cfg.location ?? this.location;
      this.locationName = cfg.locationName ?? this.locationName;
      this.referenceSuffix = cfg.referenceSuffix ?? this.referenceSuffix;
    }

    if (st[this.storageKeyRunning] && typeof st[this.storageKeyStep] === "number") {
      this.isRunning = true;
      this.currentStep = st[this.storageKeyStep];
      this.vehicleData = st[this.storageKeyData] || this.vehicleData;
      this._log("🔄 Reanudando automatización Wallapop tras navegación…", "info");
      // Espera corta para que el DOM se estabilice tras la navegación
      setTimeout(() => this._executeStep(), 1200);
    }
  }

  // ========================
  // Navegación
  // ========================
  _startNavigationWatcher() {
    if (this._watcher) return;
    this._watcher = setInterval(() => {
      if (location.href !== this._lastUrl) {
        const old = this._lastUrl;
        this._lastUrl = location.href;
        this._onNavigationChange(old, this._lastUrl);
      }
    }, 1500);
  }

async _onNavigationChange(oldUrl, newUrl) {
  this._log(`📍 [Wallapop] Navegación: ${oldUrl} → ${newUrl}`, "info");

  if (!this.isRunning) return;

  // 🔹 Caso especial: tras publicar, Wallapop redirige a /app/pro/catalog/list;created=true;itemId=...
  const isCreated =
    newUrl.includes("/app/pro/catalog/list") &&
    newUrl.includes("itemId=");

  if (isCreated) {
    this._log("✅ Anuncio creado correctamente en Wallapop (detectado por URL)", "success");
    this._waitingSubmitNavigation = false;
    await this._complete(); // Fin de vehículo → AUTOMATION_COMPLETE + listo para siguiente
    return;
  }

  // ❌ IMPORTANTE: para cualquier otra navegación NO re-lanzamos pasos
  // porque ya hay lógica de espera en cada paso (_esperarFormularioWallapop, etc.)
  // y, sobre todo, para no disparar _executeStep() de nuevo mientras otro está en marcha.
}


  // ========================
  // Ciclo principal
  // ========================
  async _start() {
    const okHost = /(^|\.)wallapop\.com$/i.test(location.host);
    if (!okHost) {
      this._status("Debes estar en es.wallapop.com", "error");
      this._log("❌ Dominio no es Wallapop", "error");
      throw new Error("Not on wallapop.com");
    }

    this.isRunning = true;
    this._stepExecuting = false;
    this._waitingSubmitNavigation = false;
    if (this.currentStep < 0) this.currentStep = 0;
    await this._saveState();

    this._status("Iniciando automatización (Wallapop)…", "running");
    this._log("🚀 Automatización iniciada (Wallapop)", "info");
    this._executeStep();
  }

  async _stop() {
    this.isRunning = false;
    this._stepExecuting = false;
    await chrome.storage.local.set({ [this.storageKeyRunning]: false });
    this._log("⛹️‍♂️ Automatización detenida (Wallapop)", "warning");
  }

  async _reset() {
    this.isRunning = false;
    this._stepExecuting = false;
    this.currentStep = 0;
    this.vehicleData = null;
    this._completedOnce = false;
    this._waitingSubmitNavigation = false;
    await chrome.storage.local.remove([
      this.storageKeyRunning,
      this.storageKeyStep,
      this.storageKeyData,
      this.storageKeyCfg,
    ]);
    this._log("🔄 Sistema reiniciado (Wallapop)", "info");
  }

async _executeStep() {
  if (!this.isRunning) return;

  // 🔐 Anti-reentrada
  if (this._stepExecuting) {
    this._log("ℹ️ _executeStep ya está en curso, ignoro llamada reentrante.", "info");
    return;
  }

  this._stepExecuting = true;

  const STEPS = [
    { name: "openSell",      desc: "Ir a /app/catalog/upload/cars", waitNav: true },
    { name: "fillData",      desc: "Rellenar datos del vehículo",   waitNav: false },
    { name: "uploadPhotos",  desc: "Subir fotos del vehículo",      waitNav: false },
    { name: "submit",        desc: 'Click en "Subir producto"',     waitNav: true },
  ];

  let scheduleNext = false;
  let nextDelay = 0;

  try {
    // Ya hemos acabado todos los pasos
    if (this.currentStep >= STEPS.length) {
      if (this._waitingSubmitNavigation) {
        this._log("⏳ Todos los pasos ejecutados, esperando confirmación de publicación…", "info");
      } else {
        await this._complete();
      }
      return;
    }

    const step = STEPS[this.currentStep];

    this._status(
      `Paso ${this.currentStep + 1}/${STEPS.length}: ${step.desc}`,
      "running"
    );
    this._progress(this.currentStep, STEPS.length);
    this._log(`📍 Paso ${this.currentStep + 1} (Wallapop): ${step.desc}`, "info");

    let ok = false;

    try {
      switch (step.name) {
        case "openSell":
          ok = await this._openSellFlow();
          break;
        case "fillData":
          ok = await this._insertarDatos();
          break;
        case "uploadPhotos":
          ok = await this._subirFotosWallapopFromLocal();
          break;
        case "submit":
          ok = await this._clickSubmit();
          break;
      }
    } catch (e) {
      this._log(`❌ Excepción en paso Wallapop: ${e?.message || e}`, "error");
      await this._stop();
      return;
    }

    if (!this.isRunning) return;

    if (ok) {
      this._log(`✅ ${step.desc}`, "success");
      this.currentStep++;
      await this._saveState();

      // Decidir cuándo lanzar el siguiente paso
      if (this.currentStep < STEPS.length) {
        if (step.name === "uploadPhotos") {
          // ⏳ Espera especial tras fotos
          nextDelay = this.WAIT_AFTER_PHOTOS_MS;
          this._log(
            `⏳ Esperando ${Math.round(this.WAIT_AFTER_PHOTOS_MS / 1000)}s tras subir fotos antes de ir a "Subir producto"...`,
            "info"
          );
        } else if (step.waitNav) {
          // Pasos con navegación (openSell / submit)
          nextDelay = 3000;
        } else {
          nextDelay = 0;
        }
        scheduleNext = true;
      } else {
        // No hay más pasos, el cierre real vendrá por _onNavigationChange (created=true)
        if (this._waitingSubmitNavigation) {
          this._log("⏳ Todos los pasos ejecutados, esperando redirección de publicación…", "info");
        } else {
          await this._complete();
        }
      }
    } else {
      this._log(`❌ Error en: ${step.desc}`, "error");
      await this._stop();
    }
  } finally {
    this._stepExecuting = false;
  }

  // Programar el siguiente paso solo una vez, y solo después de liberar el flag
  if (scheduleNext && this.isRunning) {
    setTimeout(() => {
      if (this.isRunning) {
        this._executeStep();
      }
    }, nextDelay);
  }
}


  async _complete() {
    if (this._completedOnce) return;
    this._completedOnce = true;
    this.isRunning = false;
    this._waitingSubmitNavigation = false;

    await chrome.storage.local.set({
      [this.storageKeyRunning]: false,
      [this.storageKeyStep]: 0,
    });

    this._status("✅ Vehículo completado (Wallapop)", "success");
    this._progress(5, 5);

    const sessionId =
      this.sessionId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this._send("AUTOMATION_COMPLETE", { sessionId });

    await chrome.storage.local.remove([
      this.storageKeyRunning,
      this.storageKeyStep,
      this.storageKeyData,
      this.storageKeyCfg,
    ]);

    this.currentStep = 0;
    this.vehicleData = null;
    this._log("🔁 Listo para siguiente vehículo (Wallapop)", "info");
  }

  // ========================
  // PASO 1: ir directo a /app/catalog/upload/cars
  // ========================
  async _openSellFlow() {
    if (/\/app\/catalog\/upload\/cars/i.test(location.pathname)) {
      this._log("ℹ️ Ya estoy en /app/catalog/upload/cars", "info");
      return true;
    }

    this._log("➡️ Navegando directamente a /app/catalog/upload/cars", "info");

    const targetUrl = "https://es.wallapop.com/app/catalog/upload/cars";
    try {
      location.assign(targetUrl);
    } catch {
      location.href = targetUrl;
    }

    const moved = await this._waitForUrl(
      /\/app\/catalog\/upload\/cars/i,
      this.OPEN_SELL_URL_TIMEOUT_MS
    );
    if (!moved) {
      this._log("❌ No he llegado a /app/catalog\/upload\/cars", "error");
      return false;
    }

    this._log("✅ Estoy en /app/catalog/upload/cars", "success");
    return true;
  }

  // ========================
  // PASO 2 opcional: click en "Un vehículo"
  // ========================
  async _selectVehicleStep() {
    if (/\/app\/catalog\/upload\/cars/i.test(location.pathname)) {
      this._log("ℹ️ Ya estoy en /app/catalog/upload/cars, salto 'Un vehículo'", "info");
      return true;
    }

    const findVehicleBtn = () => {
      const spans = Array.from(
        document.querySelectorAll(".UploadStepVertical__title, .UploadStepVertical__singleIcon span")
      );
      for (const sp of spans) {
        const txt = (sp.textContent || "").trim().toLowerCase();
        if (txt.includes("un vehículo") || txt.includes("un vehiculo")) {
          const btn = sp.closest("button");
          if (btn) return btn;
        }
      }
      return null;
    };

    const btn = await this._waitForElement(
      findVehicleBtn,
      this.SELECT_VEHICLE_TIMEOUT_MS,
      250
    );
    if (!btn) {
      this._log("❌ No encuentro el botón 'Un vehículo'", "error");
      return false;
    }

    this._log("🟢 Click en 'Un vehículo'", "info");
    this._forceClick(btn);

    const okUrl = await this._waitForUrl(
      /\/app\/catalog\/upload\/cars/i,
      this.URL_WAIT_DEFAULT_MS
    );
    if (!okUrl) {
      const formReady = await this._waitForElement(
        () =>
          document.querySelector(
            'input[name="brand"], input[name="model"], input[name="title"]'
          ),
        this.FORM_TIMEOUT_MS,
        300
      );
      if (!formReady) {
        this._log("❌ Tras 'Un vehículo' no aparece el formulario de coches", "error");
        return false;
      }
    }
    return true;
  }

  // ========================
  // PASO 3: esperar formulario
  // ========================
  async _esperarFormularioWallapop(timeoutMs = this.FORM_TIMEOUT_MS) {
    try {
      this._log(
        `⏳ Esperando a que cargue el formulario de Wallapop (coches) hasta ${Math.round(
          timeoutMs / 1000
        )}s...`,
        "info"
      );

      if (!location.href.includes("/app/catalog/upload/cars")) {
        this._log("⚠️ La URL actual no es la de creación de coche en Wallapop.", "warning");
      }

      const start = performance.now();

      while (performance.now() - start < timeoutMs) {
        const form       = document.querySelector("form");
        const brandInput = document.querySelector("input#brand, input[name='brand']");
        const titleInput = document.querySelector("input#title, input[name='title']");
        const kmInput    = document.querySelector("input#km, input[name='km']");

        if (form && brandInput && titleInput && kmInput) {
          this._log("✅ Formulario de Wallapop localizado correctamente.", "success");
          return true;
        }

        await this._wait(300); // espera para carga de formulario
      }

      this._log(
        "❌ No se ha podido localizar el formulario de Wallapop dentro del tiempo límite.",
        "error"
      );
      return false;
    } catch (error) {
      console.error(error);
      this._log("❌ Error inesperado esperando el formulario de Wallapop.", "error");
      return false;
    }
  }

  // Click al walla-button que abre el formulario de coche (el del flujo)
  async _prepararFormularioWallapop() {
    const okUrl = await this._waitForUrl(
      /\/app\/catalog\/upload\/cars/i,
      this.URL_WAIT_DEFAULT_MS
    );
    if (!okUrl) {
      this._log("❌ No estoy en /app/catalog/upload/cars para preparar formulario", "error");
      return false;
    }

    const wallaButton = document.querySelectorAll("walla-button")[1];
    if (!wallaButton) {
      this._log("ℹ️ No encuentro walla-button principal, quizá el formulario ya está abierto", "info");
      return true;
    }

    this._log("🟢 Click en botón interno de Wallapop (nuevo anuncio)", "info");
    await this._clickShadowButton(wallaButton);
    await this._delay(1500);
    return true;
  }

  // ========================
  // Helpers inputs
  // ========================
  async _inp(selector, value) {
    if (value === undefined || value === null) return;
    const el = document.querySelector(selector);
    if (!el) return;
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async _txt(selector, value) {
    if (value === undefined || value === null) return;
    const el = document.querySelector(selector);
    if (!el) return;
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async _selectDropdownItem(dropdownIndex, itemIndex) {
    try {
      const dropdowns = document.querySelectorAll("walla-dropdown");
      const dd = dropdowns[dropdownIndex];
      if (!dd) return;
      const items = dd.querySelectorAll("walla-list-item");
      const it = items[itemIndex];
      if (!it) return;
      it.dispatchEvent(new Event("wallaClick"));
    } catch (e) {
      this._log(
        `⚠️ Error seleccionando dropdown[${dropdownIndex}] item[${itemIndex}]: ${e?.message || e}`,
        "warning"
      );
    }
  }

  // ========================
  // Click "Añadir marca manualmente"
  // ========================
  async _clickAddBrandManual() {
    const timeoutMs = this.ADD_BRAND_TIMEOUT_MS;
    const pollMs = 300;
    const inicio = Date.now();

    while (Date.now() - inicio < timeoutMs) {
      const secciones = Array.prototype.slice.call(
        document.querySelectorAll("section.box")
      );
      let infoBasica = null;

      for (let i = 0; i < secciones.length; i++) {
        const h2 = secciones[i].querySelector("h2");
        if (h2 && /información básica/i.test((h2.textContent || "").toLowerCase())) {
          infoBasica = secciones[i];
          break;
        }
      }

      if (!infoBasica) {
        this._log("🔄 No encuentro aún la sección 'Información básica'", "info");
        await this._wait(pollMs);
        continue;
      }

      const manualBrandInput = infoBasica.querySelector('input#brand[tabindex="0"]');
      if (manualBrandInput) {
        this._log("🟢 Marca manual YA está activada.", "info");
        await this._wait(500);
        return true;
      }

      const toggle = infoBasica.querySelector("walla-button");
      if (!toggle) {
        this._log(
          "🔄 No encuentro el <walla-button> para cambiar a marca manual.",
          "info"
        );
        await this._wait(pollMs);
        continue;
      }

      let innerBtn = null;
      if (toggle.shadowRoot) {
        innerBtn = toggle.shadowRoot.querySelector("button");
      }

      try {
        if (innerBtn && typeof innerBtn.scrollIntoView === "function") {
          innerBtn.scrollIntoView({ block: "center", behavior: "auto" });
        } else if (typeof toggle.scrollIntoView === "function") {
          toggle.scrollIntoView({ block: "center", behavior: "auto" });
        }
      } catch (e) {}

      this._log("🖱️ Haciendo click REAL en 'Añadir marca manualmente'…", "info");

      try {
        if (innerBtn) {
          innerBtn.click();
        } else {
          toggle.click();
        }
      } catch (e) {
        this._log("⚠️ Error al hacer click en walla-button: " + e, "warn");
      }

      await this._wait(500);
    }

    this._log("❌ No he podido activar la marca manual antes del timeout.", "error");
    return false;
  }

  // ========================
  // PASO 2: insertar datos del vehículo en Wallapop
  // ========================
  async _insertarDatos() {
    if (!this.vehicleData) {
      this._log("⚠️ No hay datos del vehículo; abortando", "error");
      return false;
    }

    this._log("🧾 Insertando datos del vehículo en Wallapop…", "info");

    const v = this.vehicleData;

    const okForm = await this._esperarFormularioWallapop();
    if (!okForm) return false;

    await this._clickAddBrandManual();

    const brandName = v.marca || "";
    await this._inp('input[name="brand"]', brandName);
    this._log(`📝 Marca establecida: ${brandName}`, "info");

    const modelName = v.modelo || "";
    await this._inp('input[name="model"]', modelName);
    this._log(`📝 Modelo establecido: ${modelName}`, "info");

    let yearVal = null;
    if (v.fecha_matriculacion) {
      const m = /^(\d{4})/.exec(String(v.fecha_matriculacion));
      if (m) yearVal = m[1];
    }
    if (yearVal) {
      await this._inp('input[name="year"]', yearVal);
      this._log(`📝 Año establecido: ${yearVal}`, "info");
    } else {
      this._log(
        "⚠️ No se ha podido determinar el año a partir de fecha_matriculacion",
        "warning"
      );
    }

    const title = `${brandName} ${modelName} ${this.referenceSuffix || ""}`
      .replace(/\s+/g, " ")
      .trim();
    await this._inp('input[name="title"]', title);
    this._log(`📝 Título establecido: ${title}`, "info");

    const versionVal = v.version || "1";
    await this._inp('input[name="version"]', versionVal);

    await this._inp('input[name="num_seats"]', v.numero_pla_sen);
    await this._inp('input[name="num_doors"]', v.numero_pla_pie);

    const potencia = v.potencia ?? v.potency ?? null;
    if (potencia != null && potencia !== "") {
      await this._inp('input[name="horsepower"]', String(potencia).trim());
    }

    const kms = v.kilometros ?? v.km ?? null;
    if (kms != null && kms !== "") {
      await this._inp('input[name="km"]', String(kms).trim());
    }

    // Motor siempre Diésel
    await this._selectDropdownByAria("Motor", "Diésel");

    // Cambio según v.CAJA_CAMBIO
    const cambioOpcion = v.caja_cambio == "1" ? "Automático" : "Manual";
    await this._selectDropdownByAria("Cambio", cambioOpcion);

    // Tipo de coche
    await this._selectDropdownByAria("Tipo de coche", "Otros");

    // Distintivo ambiental
    await this._selectDropdownByAria("Distintivo ambiental", "Sin etiqueta");

    const desc = v.informacion_com || v.description || "";
    if (desc) {
      await this._txt('textarea[name="description"]', desc);
    }

    const priceVal = (v.precio ?? v.price ?? "1").toString().trim();
    await this._inp('input[name="sale_price"]', priceVal);

    const locText = `${this.location?.postalCode || ""}, ${this.locationName || ""}`
      .replace(/^,\s*/, "")
      .trim();
    if (locText) {
      await this._inp('input[name="location"]', locText);
    }

    this._log("📊 Datos insertados en formulario Wallapop", "success");
    return true;
  }

  // ========================
  // PASO 3: subir fotos desde XAMPP (LOCAL_PHOTOS_BASE)
  // ========================
  async _subirFotosWallapopFromLocal() {
    const vd = this.vehicleData || {};
    const vehicleIdFromURL = (location.pathname.match(/\/(\d+)/) || [])[1];

    const folder =
      (vd.codigo && String(vd.codigo).trim()) ||
      (vd.vehicleId && String(vd.vehicleId).trim()) ||
      (vehicleIdFromURL && String(vehicleIdFromURL).trim());

    if (!folder) {
      this._log(
        "ℹ️ [WPOP] Sin carpeta local para fotos (vd.codigo/vehicleId). Sigo sin fotos.",
        "info"
      );
      return true;
    }

    const input = document.querySelector("input[type='file']");
    if (!input) {
      this._log(
        "❌ [WPOP] No encuentro input[type=file] en el formulario.",
        "error"
      );
      return true;
    }

    const exts = [".jpg", ".jpeg", ".png", ".webp", ".JPG", ".JPEG", ".PNG", ".WEBP"];
    const dt = new DataTransfer();
    let uploaded = 0;

    const T0 = Date.now();
    const DEADLINE_MS = this.PHOTOS_TOTAL_TIMEOUT_MS; // 0 => sin límite global

    for (let i = 1; i <= this.MAX_PHOTOS; i++) {
      if (DEADLINE_MS > 0 && Date.now() - T0 > DEADLINE_MS) {
        this._log("⏱️ [WPOP] Timeout global de fotos, sigo al siguiente paso.", "warning");
        break;
      }

      const found = await this._buscarPrimeraQueExista(folder, i, exts);
      if (!found) {
        if (i === 1) {
          this._log(
            `ℹ️ [WPOP] Sin fotos en ${this.LOCAL_PHOTOS_BASE}/${folder}/`,
            "info"
          );
        }
        break;
      }

      let dataURL = await this._getDataURLFromLocal(found);
      if (!dataURL) {
        this._log(`⚠️ [WPOP] No pude leer: ${found}`, "warning");
        continue;
      }

      const beforeKB = Math.round(this._dataURLBytes(dataURL) / 1024);
      const MAX_BYTES = 600 * 1024;

      if (this._dataURLBytes(dataURL) > MAX_BYTES) {
        try {
          dataURL = await this._shrinkToMaxBytes(dataURL, {
            maxBytes: MAX_BYTES,
            startQuality: 0.9,
            minQuality: 0.55,
            maxDim: 2000,
            minDim: 600,
            opTimeout: this.PHOTO_COMPRESS_TIMEOUT_MS,
          });
        } catch (e) {
          this._log(
            `⚠️ [WPOP] Compresión fallida para ${found}: ${e?.message || e}. Subo original.`,
            "warning"
          );
        }
      }

      const afterKB = Math.round(this._dataURLBytes(dataURL) / 1024);
      this._log(`🗜️ [WPOP] Foto ${i}: ${beforeKB}KB → ${afterKB}KB`, "info");

      const blob = await this._dataURLToBlob(dataURL);
      const extMatch = found.match(/\.[a-zA-Z0-9]+$/);
      const ext = extMatch ? extMatch[0] : ".jpg";
      const fileName = `${folder}_${i}${ext}`;

      const file = new File([blob], fileName, {
        type: blob.type || "image/jpeg",
      });

      dt.items.add(file);
      uploaded++;
      this._log(`📸 [WPOP] Preparada foto ${i}: ${fileName}`, "success");
    }

    if (uploaded === 0) {
      this._log("ℹ️ [WPOP] No se añadió ninguna foto al input. Sigo flujo.", "info");
      return true;
    }

    input.files = dt.files;
    const ev = new Event("change", { bubbles: true, cancelable: true });
    input.dispatchEvent(ev);

    this._log(`✅ [WPOP] ${uploaded} foto(s) añadidas al formulario.`, "success");
    return true;
  }

  // ========================
  // PASO 4: click en "Subir producto" (MARTILLO + ESPERA REDIRECCIÓN)
  // ========================
  async _clickSubmit() {
    // Si ya hemos hecho click y solo estamos esperando redirección, no reintentar lógica completa
    if (this._waitingSubmitNavigation) {
      this._log(
        "⏳ Ya hice click en 'Subir producto'; esperando redirección / confirmación…",
        "info"
      );
      return true;
    }

    this._log(
      `⏳ Buscando botón "Subir producto" / "Publicar" (timeout ${Math.round(
        this.SUBMIT_BUTTON_TIMEOUT_MS / 1000
      )}s)…`,
      "info"
    );

    const findSubmitButton = () => {
      // 1) Preferimos el walla-button con data-testid="continue-action-button"
      const hosts = Array.from(
        document.querySelectorAll('walla-button[data-testid="continue-action-button"]')
      );
      for (const h of hosts) {
        const btn = h.shadowRoot?.querySelector("button");
        if (!btn) continue;
        const txt = (btn.textContent || "").trim().toLowerCase();
        if (
          txt.includes("subir producto") ||
          txt.includes("publicar") ||
          txt.includes("continuar") ||
          txt.includes("siguiente")
        ) {
          return btn;
        }
      }

      // 2) Fallback: cualquier walla-button cuyo texto encaje
      const allHosts = Array.from(document.querySelectorAll("walla-button"));
      for (const h of allHosts) {
        const btn = h.shadowRoot?.querySelector("button");
        if (!btn) continue;
        const txt = (btn.textContent || "").trim().toLowerCase();
        if (
          txt.includes("subir producto") ||
          txt.includes("publicar") ||
          txt.includes("continuar") ||
          txt.includes("siguiente")
        ) {
          return btn;
        }
      }

      return null;
    };

    // Espera activa al botón hasta SUBMIT_BUTTON_TIMEOUT_MS
    const t0 = Date.now();
    let btn = null;

    while (Date.now() - t0 < this.SUBMIT_BUTTON_TIMEOUT_MS) {
      btn = findSubmitButton();
      if (btn && this._isVisible(btn) && this._isEnabled(btn)) break;
      await this._wait(300);
    }

    if (!btn) {
      this._log(
        `❌ No encuentro ningún botón de "Subir producto" / "Publicar" tras ${Math.round(
          this.SUBMIT_BUTTON_TIMEOUT_MS / 1000
        )}s`,
        "error"
      );
      return false;
    }

    try {
      btn.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (_) {}

    this._log(
      `🔨 Empezando martilleo en botón "Subir producto" durante ${Math.round(
        this.SUBMIT_HAMMER_TIMEOUT_MS / 1000
      )}s…`,
      "info"
    );

    this._waitingSubmitNavigation = true;

    const hammerStart = Date.now();
    while (Date.now() - hammerStart < this.SUBMIT_HAMMER_TIMEOUT_MS) {
      // Si ya hemos salido de la página de edición, paramos martillo
      if (!location.href.includes("/app/catalog/upload/cars")) {
        this._log(
          "➡️ Detectada navegación fuera de /app/catalog/upload/cars tras clicks en 'Subir producto'.",
          "info"
        );
        break;
      }

      try {
        if (!this._isVisible(btn) || !this._isEnabled(btn)) {
          this._log(
            "ℹ️ Botón 'Subir producto' ya no está visible/habilitado, detengo martilleo.",
            "info"
          );
          break;
        }
        this._forceClick(btn);
      } catch (e) {
        this._log(
          `⚠️ Error al martillear botón 'Subir producto': ${e?.message || e}`,
          "warning"
        );
      }

      await this._wait(this.SUBMIT_HAMMER_INTERVAL_MS);
    }

    if (location.href.includes("/app/catalog/upload/cars")) {
      this._log(
        "⚠️ Tras martilleo de 'Subir producto' sigo en la página de edición; puede haber validaciones/errores en el formulario.",
        "warning"
      );
    }

    // ⏳ A partir de aquí: esperamos la redirección BUENA antes de seguir
    this._log(
      `⏳ Esperando redirección a /app/pro/catalog/list;created=true;itemId=... (hasta ${Math.round(
        this.SUBMIT_REDIRECT_TIMEOUT_MS / 1000
      )}s)…`,
      "info"
    );

    const redirected = await this._waitForUrl(
      /\/app\/pro\/catalog\/list.*.*itemId=/,
      this.SUBMIT_REDIRECT_TIMEOUT_MS
    );

    if (redirected) {
      this._log(
        "✅ Detectada redirección de confirmación (created=true;itemId=...). Publicación completada.",
        "success"
      );
      // _onNavigationChange también lo verá y llamará a _complete(), pero está protegido con _completedOnce
      return true;
    }

    this._log(
      "❌ No se produjo la redirección de confirmación tras publicar dentro del tiempo límite.",
      "error"
    );
    this._waitingSubmitNavigation = false;
    return false;
  }

  // ========================
  // Helpers DOM / dropdown ARIA
  // ========================
  async _selectDropdownByAria(dropdownLabel, optionLabel) {
    const trigger = document.querySelector(
      `.walla-dropdown__inner-input[role="button"][aria-label="${dropdownLabel}"]`
    );

    if (!trigger) {
      this._log(`❌ No encuentro el dropdown "${dropdownLabel}"`, "error");
      return false;
    }

    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    trigger.click();

    await new Promise((res) => setTimeout(res, 150)); // mínima espera para que abra

    const options = Array.from(
      document.querySelectorAll("walla-dropdown-item[aria-label]")
    );
    const option = options.find(
      (el) => el.getAttribute("aria-label") === optionLabel
    );

    if (!option) {
      this._log(
        `❌ No encuentro la opción "${optionLabel}" dentro de "${dropdownLabel}"`,
        "error"
      );
      return false;
    }

    option.scrollIntoView({ block: "center", behavior: "instant" });
    option.click();

    await new Promise((res) => setTimeout(res, 100)); // mínima espera para que se cierre/aplique

    this._log(`✅ ${dropdownLabel}: seleccionado "${optionLabel}"`, "info");
    return true;
  }

  // ========================
  // Helpers genéricos (tiempo, visibilidad, etc.)
  // ========================
  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  _wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async _waitForUrl(regex, timeout = this.URL_WAIT_DEFAULT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (regex.test(location.pathname + location.search + location.hash)) return true;
      await this._wait(150);
    }
    return false;
  }

  _isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      st.display !== "none" &&
      st.visibility !== "hidden" &&
      st.opacity !== "0"
    );
  }
  _isEnabled(el) {
    if (!el) return false;
    const dis =
      el.disabled ||
      el.getAttribute("disabled") !== null ||
      el.getAttribute("aria-disabled") === "true";
    const cl = (el.className || "").toString();
    return !dis && !/disabled|is\-disabled/i.test(cl);
  }
  _forceClick(el) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.click();
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
      );
    } catch {}
  }

  async _clickShadowButton(wallaButtonEl) {
    const tryOnce = () => {
      const btn = wallaButtonEl.shadowRoot?.querySelector("button");
      if (!btn) return false;
      if (!this._isVisible(btn) || !this._isEnabled(btn)) return false;
      this._forceClick(btn);
      return true;
    };

    if (tryOnce()) return true;
    if (!wallaButtonEl.shadowRoot) return false;

    return await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (tryOnce()) {
          obs.disconnect();
          resolve(true);
        }
      });
      obs.observe(wallaButtonEl.shadowRoot, {
        childList: true,
        subtree: true,
      });
      setTimeout(() => {
        obs.disconnect();
        resolve(false);
      }, 8000);
    });
  }

  async _waitForElement(getterFn, timeout = this.WAIT_FOR_ELEMENT_DEFAULT_MS, pollInterval = 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = getterFn();
      if (el && this._isVisible(el)) return el;
      await this._wait(pollInterval);
    }
    return null;
  }

  // ========================
  // Helpers de imágenes (reusando patrón de Autoline)
  // ========================
  _sendMessageWithTimeout(payload, { timeout = this.PHOTO_FETCH_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, timeout);
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(resp || null);
        });
      } catch {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(null);
        }
      }
    });
  }

  async _buscarPrimeraQueExista(folder, idx, exts) {
    for (const ex of exts) {
      const url = `${this.LOCAL_PHOTOS_BASE}/${encodeURIComponent(folder)}/${idx}${ex}`;
      const probe = await this._sendMessageWithTimeout(
        { type: "FETCH_LOCAL_IMAGE", url },
        { timeout: this.PHOTO_FETCH_TIMEOUT_MS }
      );
      if (probe && probe.ok) return url;
    }
    return null;
  }

  async _getDataURLFromLocal(url) {
    const r = await this._sendMessageWithTimeout(
      { type: "FETCH_LOCAL_IMAGE", url },
      { timeout: this.PHOTO_DATAURL_TIMEOUT_MS }
    );
    return r && r.ok && r.dataURL ? r.dataURL : null;
  }

  _dataURLBytes(dataURL) {
    const b64 = dataURL.split(",")[1] || "";
    const pad = (b64.match(/=+$/) || [""])[0].length;
    return Math.floor((b64.length * 3) / 4) - pad;
  }

  async _dataURLToBlob(dataURL) {
    const res = await fetch(dataURL);
    return await res.blob();
  }

  _timeout(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  }

  _blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error("FileReader error"));
      fr.readAsDataURL(blob);
    });
  }

  async _decodeImageSafe(dataURL, { timeout = 5000 } = {}) {
    try {
      const mimeMatch = /^data:(image\/[^;]+);base64,/i.exec(dataURL);
      const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const b64 = dataURL.split(",")[1] || "";
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bin], { type: mime });
      const bmp = await Promise.race([createImageBitmap(blob), this._timeout(timeout)]);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
      return { canvas, width: canvas.width, height: canvas.height };
    } catch {}

    const img = new Image();
    img.decoding = "async";
    img.src = dataURL;
    await Promise.race([
      new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("img onerror"));
      }),
      this._timeout(timeout),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(img, 0, 0);
    return { canvas, width: canvas.width, height: canvas.height };
  }

  async _shrinkToMaxBytes(
    dataURL,
    {
      maxBytes = 50 * 1024,
      startQuality = 0.82,
      minQuality = 0.5,
      maxDim = 1600,
      minDim = 480,
      stepDim = 0.88,
      opTimeout = 7000,
    } = {}
  ) {
    try {
      const tStart = Date.now();
      if (!/^data:image\/(jpeg|jpg|png|webp)/i.test(dataURL)) return dataURL;
      if (this._dataURLBytes(dataURL) <= maxBytes) return dataURL;

      const { canvas, width: W0, height: H0 } = await this._decodeImageSafe(dataURL, {
        timeout: 4000,
      });
      let w = W0,
        h = H0;
      const scale0 = Math.min(1, maxDim / Math.max(w, h));
      if (scale0 < 1) {
        w = Math.max(minDim, Math.round(w * scale0));
        h = Math.max(minDim, Math.round(h * scale0));
      }

      const work = document.createElement("canvas");
      const ctx = work.getContext("2d", { alpha: false });
      const draw = () => {
        work.width = w;
        work.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(canvas, 0, 0, w, h);
      };
      draw();

      let best = dataURL;
      let quality = startQuality;

      const toDataURLQ = (q) =>
        new Promise((res, rej) => {
          work.toBlob(
            async (blob) => {
              if (!blob) return rej(new Error("toBlob null"));
              const out = await this._blobToDataURL(blob);
              res(out);
            },
            "image/jpeg",
            q
          );
        });

      for (; quality >= minQuality; quality -= 0.08) {
        if (Date.now() - tStart > opTimeout) break;
        const out = await toDataURLQ(quality);
        best = out;
        if (this._dataURLBytes(out) <= maxBytes) return out;
      }

      for (let tries = 0; tries < 10; tries++) {
        if (Date.now() - tStart > opTimeout) break;

        const nw = Math.max(minDim, Math.round(w * stepDim));
        const nh = Math.max(minDim, Math.round(h * stepDim));
        if (nw === w && nh === h) break;
        w = nw;
        h = nh;
        draw();

        let q = Math.max(minQuality, 0.6);
        for (; q >= minQuality; q -= 0.08) {
          if (Date.now() - tStart > opTimeout) break;
          const out = await toDataURLQ(q);
          best = out;
          if (this._dataURLBytes(out) <= maxBytes) return out;
        }
      }
      return best;
    } catch {
      return dataURL;
    }
  }
}



  // =========================
  // Router multi-sitio (Autoline / Europa-Camiones / Via-Mobilis / Coches.net / Wallapop)
  // =========================
  (() => {
    const host = location.host;

    const SITE_MAP = [
      {
        test: (h) => /autoline\.es$/i.test(h),
        key: "autoline",
        init: () => new AutolineAutomation(),
      },
      {
        test: (h) =>
          /europa-camiones\.com$/i.test(h) ||
          /(^|\.)via-mobilis\.com$/i.test(h),
        key: "europacamiones",
        init: () => new EuropacamionesAutomation(),
      },
      {
        key: "cochesnet",
        test: (h) => /(^|\.)pro\.coches\.net$/i.test(h) || /(^|\.)coches\.net$/i.test(h),
        init: () => {
          if (typeof CochesNetAutomation === "function") {
            return new CochesNetAutomation();
          }

          console.warn(
            "[TruckExtension] CochesNetAutomation no definido en esta página, se desactiva coches.net aquí."
          );
          return null;
        },
      },
      {
        key: "wallapop",
        test: (h) => /(^|\.)wallapop\.com$/i.test(h),
        init: () => {
          if (typeof WallapopAutomation === "function") {
            return new WallapopAutomation();
          }

          console.warn(
            "[TruckExtension] WallapopAutomation no definido en esta página, se desactiva wallapop.com aquí."
          );
          return null;
        },
      },
    ];

    if (!window.__siteAutomation__) {
      const site = SITE_MAP.find((s) => s.test(host));
      if (site) window.__siteAutomation__ = site.init();
    }
  })();
})(); // cierre IIFE raíz

