// Content Script unificado para Autoline.es
// - Flujo de 5 pasos: publicar → cabezas → datos → siguiente → aplazar
// - Persistencia de paso en chrome.storage.local
// - Reanudación automática tras navegación (NavigationWatcher)
// - Cola multi-vehículo: reset entre vehículos con queueInfo.justStarted
// - Mensajería con popup: STATUS_UPDATE, PROGRESS_UPDATE, LOG_UPDATE, AUTOMATION_COMPLETE

// =========================
// Utilidades / helpers (globales)
// =========================

// Preparación del DOM (versión estable)
function _preparaWebLegacy() {
    // Quitar wrappers de Select2 para que los <select> reales queden accesibles
    document.querySelectorAll('.select2-hidden-accessible')?.forEach(el => el.classList.remove('select2-hidden-accessible'));
    document.querySelectorAll('.select2-selection__rendered, .select2-selection, .select2-container')?.forEach(el => el.remove());
    // Mostrar todas las secciones del formulario
    document.querySelectorAll('div.section-content')?.forEach(sec => (sec.style.display = 'block'));
}

// Detección de URL errónea (búsqueda)
function _isWrongSearchUrl() {
    try { return location.pathname.includes('/search_text.php'); } catch { return false; }
}

// Conversores / mapeos (tomados de la versión que ya te funcionaba)
function ToneladasToKilos(t) { return (t != null && !isNaN(parseFloat(t))) ? String(parseFloat(t) * 1000) : undefined; }
function getY(d) { if (!d || d === '0000-00-00') return; const x = new Date(d); return isNaN(x) ? undefined : String(x.getFullYear()); }
function getM(d) { if (!d || d === '0000-00-00') return; const x = new Date(d); return isNaN(x) ? undefined : String(x.getMonth() + 1).padStart(2, '0'); }
function getD(d) { if (!d || d === '0000-00-00') return; const x = new Date(d); return isNaN(x) ? undefined : String(x.getDate()).padStart(2, '0'); }

function mapConfiEjeSelect(v) {
    const m = { "1": "4157", "2": "4167", "3": "4158", "4": "4168", "5": "4179", "6": "4183", "7": "4188", "8": "4169" };
    return m[String(v)];
}
function mapSuspension(o) {
    if (o?.suspension_ne !== '0') return "4362"; // neumática/neumática
    if (o?.suspension_hi !== '0') return "4998"; // resorte/neumática
    if (o?.suspension_me !== '0') return "4363"; // resorte/resorte
    if (o?.suspension_rene !== '0') return "4361"; // resorte/neumática
}
function mapCajaCambio(o) { return (o?.caja_cambio === "1") ? "4137" : "4136"; } // auto : manual
function mapFrigoMarca(o) {
    // Ejemplos (ajusta si hace falta)
    const m = { "124": "4064", "6973": "4054", "744": "4055" };
    return m[String(o?.carroceria_marca)];
}

// Búsqueda de botón por texto (fallback para Aplazar)
function _findButtonByText(...texts) {
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]'));
    for (const t of texts) {
        const found = btns.find(b => {
            const txt = (b.textContent || b.value || '').trim().toLowerCase();
            return txt.includes(t.toLowerCase());
        });
        if (found) return found;
    }
    return null;
}

// helper pequeñito para comparar texto visible
function _txt(el) {
    return (el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Evitar ejecutar en iframes: solo top window
try {
    if (window.top !== window.self) {
      // Estamos en un iframe → no correr automatización aquí
      // (Opcional: puedes dejar un console.debug y salir)
      console.debug('[Autoline] Iframe detectado: content-script no se inicializa en iframes.');
      throw new Error('AUTOLINE_IFRAME_ABORT');
    }
  } catch (e) {
    // En algunos sandbox, acceder a window.top puede lanzar → abortamos
    return;
  }
  

// =========================
// Núcleo de la automatización
// =========================
(() => {
    const STEPS = [
        { name: 'publicar', desc: 'Click en "Publicar el anuncio"', waitNav: true },
        { name: 'cabezas', desc: 'Click en "Cabezas tractoras"', waitNav: true },
        { name: 'datos', desc: 'Insertar datos del vehículo', waitNav: false },
        { name: 'siguiente', desc: 'Click en "Siguiente"', waitNav: true },
        { name: 'aplazar', desc: 'Click en "Aplazar"', waitNav: true },
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

            // Concurrency/debounce guards
            this._startInFlight = false;
            this._resumeScheduled = false;
            this._executing = false;

            // Mensajería / estado
            this._setupMsgListener();
            this._startNavigationWatcher();
            this._loadStateAndMaybeResume();
            this._nextStepTimer = null;
            this._completed = false;

            // Bloqueo de Enter para evitar envíos/búsquedas
            this._keydownBlocker = (e) => {
                if (!this.isRunning) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._log('⛔ Enter bloqueado para evitar navegación/búsqueda', 'info');
                }
            };
            window.addEventListener('keydown', this._keydownBlocker, true);
        }

        // ---------- Mensajería ----------
        _setupMsgListener() {
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                try {
                    switch (message.type) {
                        case 'PING':
                            sendResponse({
                                success: true,
                                message: 'content-script alive',
                                status: {
                                    isRunning: this.isRunning,
                                    currentStep: this.currentStep,
                                    totalSteps: STEPS.length,
                                    currentUrl: window.location.href,
                                    timestamp: Date.now()
                                }
                            });
                            break;

                        case 'START_AUTOMATION':
                            this.vehicleData = message.vehicleData || this.vehicleData;
                            this.isQueueProcessing = !!message.isQueueProcessing;
                            this.queueInfo = message.queueInfo || null;

                            // Debounce: si ya estamos arrancando o corriendo, evitar duplicado
                            if (this._startInFlight || this.isRunning) {
                                this._log('⚠️ Inicio duplicado ignorado', 'warning');
                                sendResponse?.({ success: true, message: 'already-running' });
                                return true;
                            }

                            // Reset suave al inicio de cada vehículo en cola
                            if (this.isQueueProcessing && this.queueInfo?.justStarted) {
                                this._log('🔄 Nuevo vehículo en cola: reseteando estado…', 'info');
                                this.queueInfo.justStarted = false;
                                this._startInFlight = true;
                                chrome.storage.local.remove(['auto_running', 'auto_step', 'auto_data'])
                                    .then(() => this._start())
                                    .then(() => sendResponse?.({ success: true }))
                                    .catch(e => sendResponse?.({ success: false, error: e?.message }))
                                    .finally(() => { this._startInFlight = false; });
                                return true;
                            }

                            this._startInFlight = true;
                            this._start()
                                .then(() => sendResponse?.({ success: true }))
                                .catch(e => sendResponse?.({ success: false, error: e?.message }))
                                .finally(() => { this._startInFlight = false; });
                            return true;

                        case 'STOP_AUTOMATION':
                            this._stop().then(() => sendResponse?.({ success: true }));
                            return true;

                        case 'RESET_AUTOMATION':
                            this._reset().then(() => sendResponse?.({ success: true }));
                            return true;

                        default:
                            break;
                    }
                } catch (e) {
                    sendResponse?.({ success: false, error: e?.message });
                }
            });
        }

        _send(type, data) {
            try { chrome.runtime.sendMessage({ type, data }); } catch { }
        }
        _status(text, type = 'running') { this._send('STATUS_UPDATE', { text, type }); }
        _progress(cur, total) { this._send('PROGRESS_UPDATE', { current: cur, total }); }
        _log(message, type = 'info') { this._send('LOG_UPDATE', { message, type }); }

        // ---------- Persistencia ----------
        async _saveState() {
            await chrome.storage.local.set({
                auto_running: this.isRunning,
                auto_step: this.currentStep,
                auto_data: this.vehicleData
            });
        }
        async _loadStateAndMaybeResume() {
            const st = await chrome.storage.local.get(['auto_running', 'auto_step', 'auto_data']);
            if (st.auto_running && typeof st.auto_step === 'number') {
                this.isRunning = true;
                this.currentStep = st.auto_step;
                this.vehicleData = st.auto_data || this.vehicleData;
                this._log('🔄 Reanudando automatización tras navegación…', 'info');
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
                    this._log(`📍 Navegación detectada:\n${oldUrl} → ${this._lastUrl}`, 'info');

                    // Si caemos en search_text, corregir
                    if (this.isRunning && _isWrongSearchUrl()) {
                        this._log('↩️ Corrigiendo desvío de búsqueda…', 'warning');
                        history.length > 1 ? history.back() : location.reload();
                        return;
                    }
                    // Si llegamos a /my/sales/ (tras Aplazar), completar y notificar una sola vez
                    try {
                        if (this.isRunning && /\/my\/sales\/?$/.test(new URL(location.href).pathname)) {
                            await this._complete();
                            return;
                        }
                    } catch {}
                    if (this.isRunning) {
                        if (this._resumeScheduled) return;
                        this._resumeScheduled = true;
                        setTimeout(async () => {
                            try { await this._loadStateAndMaybeResume(); } finally { this._resumeScheduled = false; }
                        }, 1000);
                    }
                }
            }, 1500);
        }

        // ---------- Ciclo principal ----------
        async _start() {
            if (!location.host.includes('autoline.es')) {
                this._status('Debes estar en autoline.es', 'error');
                this._log('❌ No estás en autoline.es', 'error');
                throw new Error('Not on autoline.es');
            }
            this.isRunning = true;
            this._completed = false;
            if (this._nextStepTimer) { clearTimeout(this._nextStepTimer); this._nextStepTimer = null; }
            if (this.currentStep < 0 || this.currentStep >= STEPS.length) this.currentStep = 0;
            await this._saveState();

            this._status('Iniciando automatización…', 'running');
            this._log('🚀 Automatización iniciada', 'info');
            this._executeStep();
        }

        async _stop() {
            this.isRunning = false;
            await chrome.storage.local.set({ auto_running: false });
            this._log('⏹️ Automatización detenida', 'warning');
        }

        async _reset() {
            this.isRunning = false;
            this.currentStep = 0;
            this.vehicleData = null;
            await chrome.storage.local.remove(['auto_running', 'auto_step', 'auto_data']);
            this._log('🔄 Sistema reiniciado', 'info');
        }

        async _executeStep() {
            if (!this.isRunning) return;
            if (this.currentStep >= STEPS.length) return this._complete();
            if (this._executing) return; // evitar doble ejecución por watcher + timer
            this._executing = true;

            const step = STEPS[this.currentStep];
            this._status(`Paso ${this.currentStep + 1}/${STEPS.length}: ${step.desc}`, 'running');
            this._progress(this.currentStep, STEPS.length);
            this._log(`📍 Paso ${this.currentStep + 1}: ${step.desc}`, 'info');

            try {
                let ok = false;
                switch (step.name) {
                    case 'publicar': ok = await this._clickPublicar(); break;
                    case 'cabezas': ok = await this._clickCabezas(); break;
                    case 'datos': ok = await this._insertarDatos(); break;
                    case 'siguiente': ok = await this._clickSiguiente(); break;
                    case 'aplazar': ok = await this._clickAplazar(); break;
                }

                if (!this.isRunning) return;

                if (ok) {
                    this._log(`✅ ${step.desc}`, 'success');
                    this.currentStep++;
                    await this._saveState();

                    if (step.waitNav) {
                        this._log('⏳ Esperando navegación…', 'info');
                        if (this._nextStepTimer) { clearTimeout(this._nextStepTimer); }
                        this._nextStepTimer = setTimeout(() => { this._nextStepTimer = null; this._executeStep(); }, 3000);
                    } else {
                        if (this._nextStepTimer) { clearTimeout(this._nextStepTimer); }
                        this._nextStepTimer = setTimeout(() => { this._nextStepTimer = null; this._executeStep(); }, 600);
                    }
                } else {
                    this._log(`❌ Error en: ${step.desc}`, 'error');
                    await this._stop();
                }
            } catch (e) {
                this._log(`❌ Excepción en paso: ${e?.message || e}`, 'error');
                await this._stop();
            } finally {
                this._executing = false;
            }
        }

        async _complete() {
            if (this._completed) return;
            this._completed = true;
            this.isRunning = false;
            await chrome.storage.local.set({ auto_running: false, auto_step: STEPS.length });

            this._status('✅ Automatización completada', 'success');
            this._progress(STEPS.length, STEPS.length);
            this._send('AUTOMATION_COMPLETE', {});

            // Limpieza final (pausa corta para que el popup lea estado si quiere)
            setTimeout(() => { chrome.storage.local.remove(['auto_running', 'auto_step', 'auto_data']); }, 400);
        }

        // ---------- Acciones por paso ----------
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
                '.option[data-cat-id="42"]'
            ];
            for (const sel of tries) {
                const el = await this._waitVisible(sel, 1);
                if (el) { this._smoothClick(el); return true; }
            }
            // Fallback por texto
            const elTxt = await this._findByText('Cabezas tractoras');
            if (elTxt) { this._smoothClick(elTxt); return true; }
            return false;
        }

        async _insertarDatos() {
            if (!this.vehicleData) {
                this._log('⚠️ No hay datos del vehículo; abortando', 'error');
                return false;
            }

            // Preparación "legacy" (quita select2, muestra secciones)
            _preparaWebLegacy();

            // Asegurar que estamos en el formulario
            const okForm = await this._esperarFormulario();
            if (!okForm) return false;

            // Extra por si quedaron restos
            this._prepararFormulario();

            const v = this.vehicleData;

            // ===== Campos principales =====
            await this._sel("select[name='v--trademark']", v.au_marca ?? v.marca);
            await this._inp("input[name='v--model']", v.modelo);
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
            if (v.literas != null) await this._sel("select[name='v--sleeper']", String(parseInt(v.literas) + 1));
            await this._sel("select[name='v--euro']", v.normas);

            // Ejes / configuración
            await this._sel("select[name='v--axel_num']", v.numero_ejes);
            await this._sel("select[name='v--axel_formula']", mapConfiEjeSelect(v.ejes));
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
                el.checked = (val === "on" || val === "1" || val === 1 || val === true);
                el.dispatchEvent(new Event('change', { bubbles: true }));
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

            this._log('📊 Datos insertados', 'success');

            // Blindaje anti-desvío
            await this._delay(600);
            if (_isWrongSearchUrl()) {
                this._log('⚠️ Desvío a búsqueda detectado. Volviendo atrás…', 'error');
                history.length > 1 ? history.back() : location.reload();
                return false; // El watcher reanudará
            }

            // Verificación de no navegación inesperada
            const before = location.href;
            await this._delay(800);
            if (location.href !== before) {
                this._log('❌ Navegación inesperada tras insertar datos', 'error');
                return false;
            }
            return true;
        }

        async _clickSiguiente() {
            // 1) Selector específico del botón real
            const specific = document.querySelector('.next-button button, .next-button > button');
            if (specific && this._isVisible(specific) && _txt(specific).includes('siguiente')) {
                this._smoothClick(specific);
                return true;
            }

            // 2) Variante: el contenedor está pero con más capas
            const wrapper = document.querySelector('.next-button');
            if (wrapper) {
                const btnInWrapper = wrapper.querySelector('button, [role="button"], input[type="button"], input[type="submit"]');
                if (btnInWrapper && this._isVisible(btnInWrapper) && /siguiente|continuar|next/i.test(_txt(btnInWrapper))) {
                    this._smoothClick(btnInWrapper);
                    return true;
                }
            }

            // 3) Fallback: buscar por texto visible “Siguiente / Continuar” en toda la página
            const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
            const byText = candidates.find(b => this._isVisible(b) && /siguiente|continuar|next/i.test(_txt(b)));
            if (byText) {
                this._smoothClick(byText);
                return true;
            }

            // 4) Último intento: click en el contenedor si tiene listener delegado
            if (wrapper && this._isVisible(wrapper)) {
                this._smoothClick(wrapper);
                return true;
            }

            // no encontrado
            this._log('❌ No se encontró el botón "Siguiente"', 'error');
            return false;
        }


        async _clickAplazar() {
            // 1) Selector específico del enlace con clase suspend
            const suspendLink = document.querySelector('.actions a.suspend');
            if (suspendLink && this._isVisible(suspendLink)) {
                this._smoothClick(suspendLink);
                return true;
            }

            // 2) Fallback: buscar cualquier enlace/botón que contenga "Aplazar"
            const candidates = Array.from(document.querySelectorAll('a, button, input[type=submit]'));
            const byText = candidates.find(el =>
                this._isVisible(el) &&
                /aplazar|suspender|guardar y salir|save for later/i.test((el.textContent || el.value || '').trim())
            );
            if (byText) {
                this._smoothClick(byText);
                return true;
            }

            // 3) Si no existe “Aplazar”, no romper el flujo: finalizar igual
            this._log('ℹ️ No se encontró enlace/botón “Aplazar”, finalizando sin aplazar.', 'warning');
            return true;
        }


        // ---------- Helpers DOM ----------
        _smoothClick(el) {
            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.click();
            } catch {
                const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
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
            return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
        }

        async _findByText(txt) {
            const nodes = document.querySelectorAll('*');
            for (const el of nodes) {
                if (!el) continue;
                if (!this._isVisible(el)) continue;
                const t = (el.textContent || '').trim();
                if (t.includes(txt)) return el;
            }
            return null;
        }

        async _esperarFormulario() {
            for (let i = 1; i <= 10; i++) {
                const form = document.querySelector('form');
                const inputs = document.querySelectorAll('input,select,textarea');
                if (form && inputs.length > 10) {
                    this._log(`✅ Formulario detectado (${inputs.length} campos)`, 'success');
                    return true;
                }
                this._log(`⏳ Esperando formulario… (${i}/10)`, 'info');
                await this._delay(800);
            }
            return false;
        }

        _prepararFormulario() {
            // por si quedó algo de select2
            document.querySelectorAll('.select2-hidden-accessible')?.forEach(el => el.classList.remove('select2-hidden-accessible'));
            document.querySelectorAll('.select2-selection__rendered, .select2-selection, .select2-container')?.forEach(el => el.remove());
            document.querySelectorAll('.section-content')?.forEach(sec => (sec.style.display = 'block'));
            this._log('🔧 Formulario preparado', 'info');
        }

        // setters robustos
        async _inp(sel, val) { if (!val && val !== 0) return; const el = document.querySelector(sel); if (!el) return; el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await this._delay(50); }
        async _sel(sel, val) { if (!val && val !== 0) return; const el = document.querySelector(sel); if (!el) return; el.value = String(val); el.dispatchEvent(new Event('change', { bubbles: true })); await this._delay(50); }
        async _txt(sel, val) { if (!val) return; const el = document.querySelector(sel); if (!el) return; el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); await this._delay(50); }
        async _chk(sel, val) { const el = document.querySelector(sel); if (!el) return; el.checked = (val === "on" || val === "1" || val === 1 || val === true); el.dispatchEvent(new Event('change', { bubbles: true })); await this._delay(30); }

        _getY(any) { if (!any) return null; if (/^\d{4}$/.test(String(any))) return String(any); const d = new Date(any); return isNaN(d) ? null : String(d.getFullYear()); }
        _getM(any) { if (!any) return null; const d = new Date(any); return isNaN(d) ? null : String(d.getMonth() + 1).padStart(2, '0'); }

        _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    }

    // Inicialización única
    if (location.host.includes('autoline.es')) {
        if (!window.__autolineAutomation__) {
            window.__autolineAutomation__ = new AutolineAutomation();
        }
    }
})();
