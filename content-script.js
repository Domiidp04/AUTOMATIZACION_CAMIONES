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
  document
    .querySelectorAll(
      ".select2-selection__rendered, .select2-selection, .select2-container"
    )
    ?.forEach((el) => el.remove());
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
    { name: "publicar", desc: 'Click en "Publicar el anuncio"', waitNav: true },
    { name: "cabezas", desc: 'Click en "Cabezas tractoras"', waitNav: true },
    { name: "datos", desc: "Insertar datos del vehículo", waitNav: false },
    { name: "siguiente", desc: 'Click en "Siguiente"', waitNav: true },
    { name: "aplazar", desc: 'Click en "Aplazar"', waitNav: true },
  ];

  class AutolineAutomation {
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
          this._log(
            "⛔ Enter bloqueado para evitar navegación/búsqueda",
            "info"
          );
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

              case "START_AUTOMATION":
                this.vehicleData = message.vehicleData || this.vehicleData;
                this.isQueueProcessing = !!message.isQueueProcessing;
                this.queueInfo = message.queueInfo || null;

                if (this.isQueueProcessing && this.queueInfo?.justStarted) {
                  this._log(
                    "🔄 Nuevo vehículo en cola: reinicio completo del estado",
                    "info"
                  );
                  this.queueInfo.justStarted = false;
                  this.isRunning = false;
                  this.currentStep = 0;
                  this.vehicleData = this.vehicleData || null;
                  this._completedOnce = false;
                  this.sessionId = `${Date.now()}-${Math.random()
                    .toString(16)
                    .slice(2)}`;
                  await chrome.storage.local.remove([
                    "auto_running",
                    "auto_step",
                    "auto_data",
                  ]);
                  await this._delay(300);
                }

                await this._start();
                sendResponse?.({ success: true });
                break;

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
      const st = await chrome.storage.local.get([
        "auto_running",
        "auto_step",
        "auto_data",
      ]);
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
          this._log(
            `📍 Navegación detectada:\n${oldUrl} → ${this._lastUrl}`,
            "info"
          );

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
      if (this.currentStep < 0 || this.currentStep >= STEPS_AUTOLINE.length)
        this.currentStep = 0;
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
      await chrome.storage.local.remove([
        "auto_running",
        "auto_step",
        "auto_data",
      ]);
      this._log("🔄 Sistema reiniciado", "info");
    }

    async _executeStep() {
      if (!this.isRunning) return;
      if (this.currentStep >= STEPS_AUTOLINE.length) return this._complete();

      const step = STEPS_AUTOLINE[this.currentStep];
      this._status(
        `Paso ${this.currentStep + 1}/${STEPS_AUTOLINE.length}: ${step.desc}`,
        "running"
      );
      this._progress(this.currentStep, STEPS_AUTOLINE.length);
      this._log(`📍 Paso ${this.currentStep + 1}: ${step.desc}`, "info");

      try {
        let ok = false;
        switch (step.name) {
          case "publicar":
            ok = await this._clickPublicar();
            break;
          case "cabezas":
            ok = await this._clickCabezas();
            break;
          case "datos":
            ok = await this._insertarDatos();
            break;
          case "siguiente":
            ok = await this._clickSiguiente();
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

      const sessionId =
        this.sessionId ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this._send("AUTOMATION_COMPLETE", { sessionId });

      await chrome.storage.local.remove([
        "auto_running",
        "auto_step",
        "auto_data",
      ]);
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
    async _clickCabezas() {
      const tries = [
        'div.option[data-cat-id="42"]',
        'div.option[data-cat-id="42"][data-combination="0"]',
        '.option[data-cat-id="42"] .text',
        '.option[data-cat-id="42"]',
      ];
      for (const sel of tries) {
        const el = await this._waitVisible(sel, 1);
        if (el) {
          this._smoothClick(el);
          return true;
        }
      }
      const elTxt = await this._findByText("Cabezas tractoras");
      if (elTxt) {
        this._smoothClick(elTxt);
        return true;
      }
      return false;
    }
    async _insertarDatos() {
      if (!this.vehicleData) {
        this._log("⚠️ No hay datos del vehículo; abortando", "error");
        return false;
      }
      _preparaWebLegacy();

      const okForm = await this._esperarFormulario();
      if (!okForm) return false;
      this._prepararFormulario();

      const v = this.vehicleData;

      // ===== Campos principales =====
      await this._sel("select[name='v--trademark']", v.au_marca ?? v.marca);
      await this._inp("input[name='v--model']", v.modelo);
      await this._inp("input[name='v--kilometrag']", v.kilometros ?? v.km);

      // Fechas (fabricación / primer registro / ITV)
      await this._sel(
        "select[name='v--yearmade']",
        getY(v.fecha_matriculacion)
      );
      await this._sel(
        "select[name='v--monthmade']",
        getM(v.fecha_matriculacion)
      );

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
      await this._inp(
        "input[name='v--weight']",
        ToneladasToKilos(v.peso_vacio)
      );
      await this._inp("input[name='v--massa']", ToneladasToKilos(v.ptma));

      // Motor / cabina
      await this._inp("input[name='v--enginepower']", v.potencia);
      if (v.literas != null)
        await this._sel(
          "select[name='v--sleeper']",
          String(parseInt(v.literas) + 1)
        );
      await this._sel("select[name='v--euro']", v.normas);

      // Ejes / configuración
      await this._sel("select[name='v--axel_num']", v.numero_ejes);
      await this._sel(
        "select[name='v--axel_formula']",
        mapConfiEjeSelect(v.ejes)
      );
      await this._inp("input[name='v--baza_len']", v.distancia_ejes);
      await this._sel("select[name='v--suspension']", mapSuspension(v));

      // Combustible / comentarios
      await this._sel("select[name='v--fuel']", "4116"); // diésel
      await this._txt("textarea[name='v--comment-es']", v.informacion_com);

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
      await setChk(
        "input[name='v--el_zerkala']",
        v.retrovisores_electricos || v.espejos_regulables
      );
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
    async _clickSiguiente() {
      const specific = document.querySelector(
        ".next-button button, .next-button > button"
      );
      if (
        specific &&
        this._isVisible(specific) &&
        _txt(specific).includes("siguiente")
      ) {
        this._smoothClick(specific);
        return true;
      }
      const wrapper = document.querySelector(".next-button");
      if (wrapper) {
        const btnInWrapper = wrapper.querySelector(
          'button, [role="button"], input[type="button"], input[type="submit"]'
        );
        if (
          btnInWrapper &&
          this._isVisible(btnInWrapper) &&
          /siguiente|continuar|next/i.test(_txt(btnInWrapper))
        ) {
          this._smoothClick(btnInWrapper);
          return true;
        }
      }
      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], input[type="button"], input[type="submit"]'
        )
      );
      const byText = candidates.find(
        (b) => this._isVisible(b) && /siguiente|continuar|next/i.test(_txt(b))
      );
      if (byText) {
        this._smoothClick(byText);
        return true;
      }

      if (wrapper && this._isVisible(wrapper)) {
        this._smoothClick(wrapper);
        return true;
      }
      this._log('❌ No se encontró el botón "Siguiente"', "error");
      return false;
    }
    async _clickAplazar() {
      const suspendLink = document.querySelector(".actions a.suspend");
      if (suspendLink && this._isVisible(suspendLink)) {
        this._smoothClick(suspendLink);
        return true;
      }
      const candidates = Array.from(
        document.querySelectorAll("a, button, input[type=submit]")
      );
      const byText = candidates.find(
        (el) =>
          this._isVisible(el) &&
          /aplazar|suspender|guardar y salir|save for later/i.test(
            (el.textContent || el.value || "").trim()
          )
      );
      if (byText) {
        this._smoothClick(byText);
        return true;
      }
      this._log(
        "ℹ️ No se encontró enlace/botón “Aplazar”, finalizando sin aplazar.",
        "warning"
      );
      return true;
    }

    // ---------- Helpers DOM ----------
    _smoothClick(el) {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.click();
      } catch {
        const ev = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        });
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
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none" &&
        st.opacity !== "0"
      );
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
          this._log(
            `✅ Formulario detectado (${inputs.length} campos)`,
            "success"
          );
          return true;
        }
        this._log(`⏳ Esperando formulario… (${i}/10)`, "info");
        await this._delay(800);
      }
      return false;
    }
    _prepararFormulario() {
      document
        .querySelectorAll(".select2-hidden-accessible")
        ?.forEach((el) => el.classList.remove("select2-hidden-accessible"));
      document
        .querySelectorAll(
          ".select2-selection__rendered, .select2-selection, .select2-container"
        )
        ?.forEach((el) => el.remove());
      document
        .querySelectorAll(".section-content")
        ?.forEach((sec) => (sec.style.display = "block"));
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
    constructor() {
      super();
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

    // ---- Mensajería (idéntica a Autoline, con claves eco_*) ----
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

              case "START_AUTOMATION":
                this.vehicleData = message.vehicleData || this.vehicleData;
                this.isQueueProcessing = !!message.isQueueProcessing;
                this.queueInfo = message.queueInfo || null;

                if (this.isQueueProcessing && this.queueInfo?.justStarted) {
                  this.queueInfo.justStarted = false;
                  this.isRunning = false;
                  this.currentStep = 0;
                  this._completedOnce = false;
                  this.sessionId = `${Date.now()}-${Math.random()
                    .toString(16)
                    .slice(2)}`;
                  await chrome.storage.local.remove([
                    "eco_running",
                    "eco_step",
                    "eco_data",
                  ]);
                  await this._delay(300);
                }

                await this._start();
                sendResponse?.({ success: true });
                break;

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
    async _saveState() {
      await chrome.storage.local.set({
        eco_running: this.isRunning,
        eco_step: this.currentStep,
        eco_data: this.vehicleData,
      });
    }
    async _loadStateAndMaybeResume() {
      const st = await chrome.storage.local.get([
        "eco_running",
        "eco_step",
        "eco_data",
      ]);
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
    _delay(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    // ---- Helpers DOM ----
    _wait(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }
    async _waitFor(sel, timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const el = document.querySelector(sel);
        if (el) return el;
        await this._wait(200);
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
    _click(el) {
      if (!el) return false;
      el.click();
      return true;
    }
    _toDMY(s) {
      if (!s || s === "0000-00-00") return "";
      const d = new Date(s);
      if (isNaN(d)) return "";
      const pad = (n) => (n < 10 ? "0" + n : n);
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
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
    // Espera a que la URL cumpla un patrón
    async _waitForUrl(regex, timeout = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (regex.test(location.pathname)) return true;
        await this._wait(200);
      }
      return false;
    }

    // Devuelve un elemento <form> con "suficientes" campos (no un form vacío)
    _hasUsableForm() {
      const form = document.querySelector("form");
      if (!form) return false;
      const fields = form.querySelectorAll("input, select, textarea");
      return fields.length >= 10; // umbral razonable para la página de anuncio
    }

    // Espera un formulario "usable" y te devuelve el form (o null)
    async _waitForForm(timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const ok = this._hasUsableForm();
        if (ok) return document.querySelector("form");
        await this._wait(200);
      }
      return null;
    }

    // Helpers locales recomendados dentro de la clase (si no los tienes ya)
_isEnabled(el){
  if (!el) return false;
  const st = getComputedStyle(el);
  return !el.disabled && !el.getAttribute("disabled") && st.pointerEvents !== "none" && !el.classList.contains("disabled") && !el.hasAttribute("aria-disabled");
}
_forceClick(el){
  try{
    el.scrollIntoView({behavior:"instant", block:"center"});
  }catch{}
  try{
    el.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,view:window}));
    el.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));
    el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));
    return true;
  }catch{
    try{ el.click(); return true; }catch{ return false; }
  }
}
_findPublishButton(){
  let btn = document.querySelector('#submitDepot, button[name="submitDepot"][type="submit"]');
  if (!btn){
    btn = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"], button'))
      .find(b => /publicar mi anuncio/i.test((b.textContent || b.value || "").trim()));
  }
  return btn || null;
}
async _waitForPublishEnabled(timeout=6000){
  const t0 = Date.now();
  while(Date.now()-t0 < timeout){
    const btn = this._findPublishButton();
    if (btn && this._isVisible(btn) && this._isEnabled(btn)) return btn;
    await this._wait(120);
  }
  return null;
}


    // ---- Ciclo principal (3 pasos) ----
    async _start() {
      // europa-camiones.com y subdominios via-mobilis (p. ej., my.via-mobilis.com)
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

    // Asegura que un <select> tenga la opción y la selecciona (dispara eventos)
_ensureOptionAndSelect(selectEl, value, label){
  if (!selectEl) return false;
  const v = (value ?? "").toString().trim();
  const txt = (label ?? v).toString().trim();
  if (!v && !txt) return false;

  const exists = Array.from(selectEl.options).some(o => String(o.value) === v || (o.textContent||"").trim() === txt);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = v || txt;
    opt.textContent = txt || v;
    selectEl.appendChild(opt);
  }
  selectEl.value = v || txt;
  selectEl.dispatchEvent(new Event("input", {bubbles:true}));
  selectEl.dispatchEvent(new Event("change", {bubbles:true}));
  return true;
}

// Activa modo "modelo libre" si el select de modelo no sirve
_enableModeloLibre(modeloStr){
  const mFree  = document.querySelector("#modele_free");
  const mLibre = document.querySelector("#modele_libre");
  const mSel   = document.querySelector("#modele");

  if (mSel)  mSel.classList.add("hidden");
  if (mFree) mFree.classList.remove("hidden");
  if (mLibre) mLibre.classList.remove("hidden");

  if (mFree){
    mFree.value = modeloStr || "";
    mFree.dispatchEvent(new Event("input",{bubbles:true}));
    mFree.dispatchEvent(new Event("change",{bubbles:true}));
  }
  if (mLibre){
    mLibre.value = modeloStr || "";
    mLibre.dispatchEvent(new Event("input",{bubbles:true}));
    mLibre.dispatchEvent(new Event("change",{bubbles:true}));
  }
}

// Marca/Gama/Modelo con fallback (replica tu AddCombo de europa.js)
_setMarcaGamaModelo(vd){
  const marque = document.querySelector("#marque");
  const gamme  = document.querySelector("#gamme");
  const modele = document.querySelector("#modele");

  const marca  = vd.eu_marca ?? vd.marca ?? "";
  const gama   = vd.eu_gama  ?? vd.gama  ?? "";
  const modelo = vd.eu_modelo ?? vd.modelo ?? "";

  // 1) Marca
  if (marca) this._ensureOptionAndSelect(marque, marca, marca);

  // 2) Gama (si no existe la opción, la creo y selecciono)
  if (gama) this._ensureOptionAndSelect(gamme, gama, gama);

  // 3) Modelo: intento por select; si no está, activo "libre"
  let modeloSetPorSelect = false;
  if (modelo && modele){
    const has = Array.from(modele.options).some(o =>
      String(o.value) === String(modelo) ||
      (o.textContent||"").trim() === String(modelo)
    );
    if (has){
      this._ensureOptionAndSelect(modele, modelo, modelo);
      modeloSetPorSelect = true;
    }
  }

  if (!modeloSetPorSelect){
    // Modo libre (como en tu AddCombo: esconder select y usar *_free/_libre)
    this._enableModeloLibre(modelo);
  }
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
      await chrome.storage.local.remove([
        "eco_running",
        "eco_step",
        "eco_data",
      ]);
      this._log("🔄 Reiniciada (Europa-Camiones)", "info");
    }

    async _executeStep() {
      if (!this.isRunning) return;

      // SOLO 5 PASOS: publicar → categoría → datos → validar → publicar final
      const STEPS = [
  { name:"nueva",     desc:'Abrir “Publicar un anuncio”', waitNav:true },
  { name:"categoria", desc:'Elegir “Cabeza tractora → Estándar”', waitNav:true },
  { name:"datos",     desc:'Rellenar formulario', waitNav:false },
  { name:"validar",   desc:'Validar todas las secciones', waitNav:true }, // ← ahora true
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
          case "validar":
            ok = await this._clickValidar();
            break;
          case "publicar":
            ok = await this._clickPublicar();
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
      this._progress(3, 3);
      const sessionId =
        this.sessionId ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this._send("AUTOMATION_COMPLETE", { sessionId });
      await chrome.storage.local.remove([
        "eco_running",
        "eco_step",
        "eco_data",
      ]);
      this.currentStep = 0;
      this.vehicleData = null;
      this._log("🔁 Listo para siguiente vehículo (Europa-Camiones)", "info");
    }

    // ====== PASO 1: Publicar ======
    async _clickNuevaPublicacion() {
      // Botón: <a class="btn-flex btn-depot ..." href="/vehicle/new" title="Publicar un anuncio">
      const sel = 'a[href="/vehicle/new"][title*="Publicar"]';
      const a = await this._waitFor(sel, 10000);
      if (!a) {
        this._log("No encuentro 'Publicar un anuncio'", "error");
        return false;
      }
      this._log("Click en 'Publicar un anuncio'", "info");
      this._click(a);

      // Espera a EITHER: parrilla de categorías o directamente un form
      const moved = await Promise.race([
        this._waitFor('a[href*="/vehicle/new?"][href*="cat="]', 12000), // links de categorías
        this._waitFor(
          '#energie, #Km, #prix, form[action*="vehicle"], form input#Km',
          12000
        ), // formulario directo
      ]);

      return !!moved;
    }

    // ====== PASO 2: Categoría Estándar (Cabeza tractora) ======
async _seleccionarCategoria(){
  // 0) Si ya estamos en el formulario, salta YA
  if (/\/vehicle\/(new|[^/]+\/edit)/i.test(location.pathname) && this._hasUsableForm()){
    this._log("Ya estoy en el formulario, salto Paso 2.", "info");
    return true;
  }

  // 1) Busca el enlace "Estándar" (cat=31,var=68)
  const sel = 'a.background-color-1-with-transparency-light-hover[href*="/vehicle/new?"][href*="cat=31"][href*="var=68"]';
  let link = document.querySelector(sel);

  // Fallback por texto si cambia la clase
  if (!link) {
    link = Array.from(document.querySelectorAll('a[href*="/vehicle/new?"][href*="cat=31"][href*="var=68"]'))
      .find(a => /estándar/i.test((a.textContent||"").trim()));
  }
  if (!link){
    this._log("No encuentro el enlace de 'Estándar' (cat=31,var=68).", "error");
    return false;
  }

  // 2) Navega directo (sin esperar a que el click lo haga por SPA)
  const href = link.getAttribute("href");
  const absolute = href?.startsWith("http") ? href : new URL(href, location.origin).href;
  this._log("→ Navegando a Estándar…", "info");
  location.assign(absolute);

  // 3) Espera corta a la URL del form y al form “usable”
  const urlOk = await this._waitForUrl(/\/vehicle\/(new|[^/]+\/edit)/i, 4000);
  if (!urlOk){
    this._log("No cambió la URL a formulario tras 4s.", "error");
    return false;
  }
  const formOk = await this._waitForForm(6000); // ~6s máximo
  if (!formOk){
    this._log("No veo un formulario con campos tras 6s.", "error");
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

      // Asegurar que el form está montado (IDs pueden tardar)
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

      // Pequeño “wake up”: foco en primer campo
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

      // Combustible (energie): '3' suele ser gasoil
      this._setValue(document.querySelector("#energie"), vd.energie ?? "3");

      // Marca de la carrocería
      this._setValue(
        document.querySelector("#marqueVariante"),
        vd.carroceria_marca
      );

      // Equipamiento básico
      this._setValue(document.querySelector("#Km"), vd.kilometros);
      this._setValue(document.querySelector("#CV"), vd.potencia);
      this._setValue(document.querySelector("#cylindree"), vd.cilindrada);
      this._setValue(
        document.querySelector("#tank_capacity"),
        vd.capacidad_cuba
      );
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

      // Suspensiones (checkboxes)
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

      // Tonelaje / pesos
      this._setValue(document.querySelector("#CU"), vd.carga_util);
      this._setValue(document.querySelector("#pav"), vd.peso_vacio);
      this._setValue(document.querySelector("#ptc"), vd.mma);
      this._setValue(document.querySelector("#ptra"), vd.ptma);

      // Caja de cambios (radio + precisión)
      if (vd.caja_cambio !== undefined) {
        this._setRadioSufijo("boite_vitesse_typ", vd.caja_cambio);
      }
      this._setValue(
        document.querySelector("#boite_vitesse"),
        vd.precision_cambio
      );

      // Precio y observaciones
      this._setValue(document.querySelector("#prix"), vd.precio);
      this._setValue(document.querySelector("#remarque"), vd.informacion_com);

      // Norma Euro (0..6)
      if (vd.normas !== undefined) {
        this._setRadioSufijo("norme_euro", vd.normas);
      }

      // Literas (0/1)
      if (vd.literas !== undefined) {
        this._setRadioSufijo("couchette", vd.literas);
      }

      // Altura cabina (0..2)
      if (vd.altura_cabina !== undefined) {
        this._setRadioSufijo("hauteur_cab", vd.altura_cabina);
      }

      // Longitud cabina (0..3)
      if (vd.longitud_cabina !== undefined) {
        this._setRadioSufijo("long_cabine", vd.longitud_cabina);
      }

      // Tipo cabina (0..1)
      if (vd.tipo_cabina !== undefined) {
        this._setRadioSufijo("typ_cab", vd.tipo_cabina);
      }

      // Grúa autocargante
      if (vd.grua_autocargante !== undefined) {
        this._setCheckedById("grue", vd.grua_autocargante === "1");
      }

      // Fechas y ejes
      this._setValue(
        document.querySelector("#date"),
        this._toDMY(vd.fecha_matriculacion)
      );
      this._setValue(document.querySelector("#essieux"), vd.ejes);
      this._setValue(document.querySelector("#ess_semi"), vd.ejes_semiremolque);

      // Pasajeros y horas
      this._setValue(
        document.querySelector("#nb_place_deb"),
        vd.numero_pla_pie
      );
      this._setValue(
        document.querySelector("#nb_place_ass"),
        vd.numero_pla_sen
      );
      this._setValue(document.querySelector("#Heures"), vd.numero_ho);

      // Tacógrafo (fechas + tipo)
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

      // Checkboxes de equipamiento
      const cb = (prop, id) =>
        this._setCheckedById(
          id,
          vd[prop] && vd[prop] !== "0" && vd[prop] !== ""
        );
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

      // Marca / Gama / Modelo con fallback (AddCombo-like)
      this._setMarcaGamaModelo(vd);


      await this._wait(500);
      return true;
    }

    // Visibilidad simple (igual que en Autoline)
    _isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        st.visibility !== "hidden" &&
        st.display !== "none" &&
        st.opacity !== "0"
      );
    }

    // Paso 4: clicar TODAS las secciones "Validar"
async _clickValidar(){
  // 0) Si ya está el botón “Publicar” habilitado: ¡dale ya!
  const readyNow = await this._waitForPublishEnabled(300);
  if (readyNow){
    this._forceClick(readyNow);
    this._log("🚀 Publicado (detectado listo antes de validar).","info");
    this._alreadyPublished = true;
    return true;
  }

  // 1) Clicar TODOS los “Validar” visibles (texto EXACTO/insensible a mayúsculas)
  const getValidar = () => Array.from(document.querySelectorAll('button'))
    .filter(b => this._isVisible(b) && this._isEnabled(b) && /^validar$/i.test((b.textContent||b.value||"").trim()));

  let totalClicks = 0;
  // hacemos varias rondas rápidas por si aparecen nuevos al validar
  for (let ronda = 0; ronda < 5; ronda++){
    const btns = getValidar();
    if (!btns.length) break;
    for (const b of btns){
      this._forceClick(b);
      totalClicks++;
      await this._wait(120); // latiguillo mínimo para que el DOM reaccione
    }
    await this._wait(180); // deja que aparezcan los siguientes “Validar”
  }

  if (totalClicks === 0){
    this._log("ℹ️ No había botones 'Validar' (posible ya validado).","info");
  } else {
    this._log(`✅ Pulsados ${totalClicks} botón(es) 'Validar'.`,"success");
  }

  // 2) En cuanto el botón “Publicar mi anuncio” esté habilitado, clicarlo YA
  const publish = await this._waitForPublishEnabled(5000);
  if (publish){
    this._forceClick(publish);
    this._log("🚀 Click en 'Publicar mi anuncio' (tras validar).","info");
    this._alreadyPublished = true;
    // opcional: esperar un pelín por navegación
    await this._wait(400);
    return true;
  }

  // 3) Si aún no está habilitado, deja que el paso 5 remate
  this._log("⏳ 'Publicar mi anuncio' no está listo aún; lo intento en el paso siguiente.","warning");
  return true;
}



    // Paso 5: Publicar mi anuncio
// async _clickPublicar(){
//   if (this._alreadyPublished){
//     this._log("⏭️ Publicar omitido (ya se pulsó antes).","info");
//     return true;
//   }

//   // Espera corta a que el botón aparezca/habilite
//   const btn = await this._waitForPublishEnabled(6000);
//   if (!btn){
//     this._log("❌ No localizo el botón 'Publicar mi anuncio' habilitado.","error");
//     return false;
//   }

//   this._forceClick(btn);
//   this._log("🚀 Click en 'Publicar mi anuncio' (paso final).","info");

//   // Si quieres, aquí puedes esperar una URL de éxito concreta:
//   // await this._waitForUrl(/\/vehicle\/\d+\/(view|detail|success|confirmation)/i, 4000);

//   this._alreadyPublished = true;
//   return true;
// }


  }

  // =========================
  // Router multi-sitio (Autoline / Europa-Camiones / Via-Mobilis)
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
    ];

    if (!window.__siteAutomation__) {
      const site = SITE_MAP.find((s) => s.test(host));
      if (site) window.__siteAutomation__ = site.init();
    }
  })();
})(); // cierre IIFE raíz
