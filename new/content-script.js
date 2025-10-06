// Content Script para automatización de Autoline.es - VERSIÓN CORREGIDA
console.log('🚀 Content Script de Autoline cargado - VERSIÓN CORREGIDA');

// Evitar múltiples instancias
if (window.autolineAutomationInstance) {
    console.log('⚠️ AutolineAutomation ya existe, limpiando...');
    window.autolineAutomationInstance = null;
}

class AutolineAutomation {
    constructor() {
        console.log('🔧 Inicializando AutolineAutomation...');
        
        this.steps = [
            {
                name: 'clickPublicar',
                description: 'Click en "Publicar el anuncio"',
                selector: 'span.button.js-hrf[data-analytics-goal="button_place_ad"]',
                action: this.clickPublicarAnuncio.bind(this)
            },
            {
                name: 'clickCabezas',
                description: 'Click en "Cabezas tractoras"',
                selector: 'div.option[data-cat-id="42"]',
                action: this.clickCabezasTractoras.bind(this)
            },
            {
                name: 'insertarDatos',
                description: 'Insertar datos del camión',
                selector: 'form',
                action: this.insertarDatos.bind(this)
            }
        ];

        this.currentStep = 0;
        this.isRunning = false;
        this.vehicleData = null;
        this._lastUrl = null;
        this._navTimer = null;
        
        this.loadState().then(() => {
            this.setupMessageListener();
            this._lastUrl = window.location.href;
            this._startNavigationWatcher();
        });
    }

    _startNavigationWatcher() {
        if (this._navTimer) return;
        this._navTimer = setInterval(() => {
            try {
                if (window.location.href !== this._lastUrl) {
                    const prev = this._lastUrl;
                    this._lastUrl = window.location.href;
                    this._notifyLog(`📍 Navegación: ${prev || '-'} → ${this._lastUrl}`,'info');
                    // Si está corriendo, reintentar el paso actual tras breve espera
                    if (this.isRunning) {
                        setTimeout(() => this.executeCurrentStep(0), 1200);
                    }
                }
            } catch {}
        }, 1500);
    }

    _notifyStatus(text, type='running') {
        try { chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', data: { text, type } }); } catch {}
    }
    _notifyProgress(current, total) {
        try { chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', data: { current, total } }); } catch {}
    }
    _notifyLog(message, ltype='info') {
        try { chrome.runtime.sendMessage({ type: 'LOG_UPDATE', data: { message, type: ltype } }); } catch {}
    }

    setupMessageListener() {
        // Remover listener anterior si existe
        if (this.messageListener) {
            chrome.runtime.onMessage.removeListener(this.messageListener);
        }

        this.messageListener = (message, sender, sendResponse) => {
            console.log('📩 Mensaje recibido:', message.type, message);
            
            if (message.type === 'START_AUTOMATION') {
                // Cargar datos del vehículo si vienen en el mensaje
                if (message.vehicleData) {
                    this.vehicleData = message.vehicleData;
                    console.log('📋 Datos de cola cargados:', message.vehicleData?.codigo || 'sin código');
                }
                if (message.queueInfo) {
                    console.log(`🔄 Procesando vehículo ${message.queueInfo.current}/${message.queueInfo.total}: ${message.queueInfo.vehicleCode}`);
                }
                // Responder inmediatamente para evitar timeout
                sendResponse({ success: true, message: 'Automatización iniciada' });
                // Ejecutar la automatización fuera del ciclo de respuesta
                setTimeout(() => { this.startAutomation(); }, 0);
                return true;
            }

            if (message.type === 'START_QUEUE') {
                // Recibe un array de vehículos para la cola
                this.startQueue(message.queueArr).then(() => {
                    sendResponse({ success: true, message: 'Cola iniciada' });
                });
                return true;
            }

            // Resto de mensajes asíncronos
            const handleAsync = async () => {
                try {
                    switch (message.type) {
                        case 'SET_VEHICLE_DATA':
                            this.vehicleData = message.data;
                            console.log('📋 Datos del vehículo cargados:', this.vehicleData?.codigo || 'sin código');
                            return { success: true, message: 'Datos cargados correctamente' };
                        case 'STOP_AUTOMATION':
                            await this.stopAutomation();
                            return { success: true, message: 'Automatización detenida' };
                        case 'RESET_AUTOMATION':
                            await this.resetAutomation();
                            return { success: true, message: 'Automatización reiniciada' };
                        case 'PING':
                            return { 
                                success: true, 
                                message: 'Content script activo',
                                status: this.getStatus(),
                                timestamp: Date.now()
                            };
                        default:
                            console.log('❓ Tipo de mensaje desconocido:', message.type);
                            return { success: false, error: 'Tipo de mensaje desconocido' };
                    }
                } catch (error) {
                    console.error('❌ Error manejando mensaje:', error);
                    return { success: false, error: error.message, stack: error.stack };
                }
            };
            handleAsync().then(response => {
                try {
                    sendResponse(response);
                } catch (responseError) {
                    console.error('❌ Error enviando respuesta:', responseError);
                }
            }).catch(error => {
                console.error('❌ Error en handler asíncrono:', error);
                try {
                    sendResponse({ success: false, error: error.message });
                } catch (responseError) {
                    console.error('❌ Error enviando respuesta de error:', responseError);
                }
            });
            return true;
        };
        chrome.runtime.onMessage.addListener(this.messageListener);
        console.log('✅ Message listener configurado');
    }

    async startAutomation() {
        console.log('🚀 Iniciando automatización...');
        
        if (this.isRunning) {
            console.log('⚠️ Automatización ya en ejecución');
            return;
        }
        
        this.isRunning = true;
        this.currentStep = 0;
        
        try {
            await this.executeCurrentStep();
        } catch (error) {
            console.error('❌ Error en automatización:', error);
            this.isRunning = false;
            throw error;
        }
    }

    async executeCurrentStep(retryCount = 0) {
        const MAX_RETRIES = 3;
        if (!this.isRunning || this.currentStep >= this.steps.length) {
            await this.completeAutomation();
            return;
        }

        const step = this.steps[this.currentStep];
        console.log(`🎯 Ejecutando paso ${this.currentStep + 1}/${this.steps.length}: ${step.name} (Intento ${retryCount + 1})`);
        
        try {
            this._notifyStatus(`Paso ${this.currentStep + 1}/${this.steps.length}: ${step.description}`, 'running');
            this._notifyProgress(this.currentStep, this.steps.length);
            this._notifyLog(`📍 Paso ${this.currentStep + 1}: ${step.description}`, 'info');

            const success = await step.action();
            if (success) {
                console.log(`✅ Paso ${this.currentStep + 1} completado exitosamente`);
                this._notifyLog(`✅ ${step.description}`, 'success');
                this.currentStep++;
                await this.delay(2000);
                await this.executeCurrentStep(0);
            } else {
                if (retryCount < MAX_RETRIES - 1) {
                    console.warn(`⚠️ Paso ${this.currentStep + 1} falló, reintentando (${retryCount + 2}/${MAX_RETRIES})...`);
                    this._notifyLog(`⚠️ Fallo en paso: ${step.description}. Reintento ${retryCount + 2}/${MAX_RETRIES}`, 'warning');
                    await this.delay(2000);
                    await this.executeCurrentStep(retryCount + 1);
                } else {
                    console.error(`❌ Paso ${this.currentStep + 1} falló tras ${MAX_RETRIES} intentos. Notificando al popup y avanzando.`);
                    this.notifyPopupStepFailure(step.name, this.currentStep + 1);
                    this._notifyLog(`❌ Fallo definitivo en paso: ${step.description}. Avanzando`, 'error');
                    this.currentStep++;
                    await this.delay(1000);
                    await this.executeCurrentStep(0);
                }
            }
        } catch (error) {
            console.error(`❌ Error crítico en paso ${this.currentStep + 1}:`, error);
            this.notifyPopupStepFailure(step.name, this.currentStep + 1, error.message);
            this._notifyLog(`❌ Excepción en paso ${this.currentStep + 1}: ${error.message}`, 'error');
            await this.delay(2000);
            this.currentStep++;
            await this.executeCurrentStep(0);
        }
    }

    notifyPopupStepFailure(stepName, stepNumber, errorMsg = '') {
        try {
            chrome.runtime.sendMessage({
                type: 'AUTOMATION_STEP_FAILURE',
                step: stepNumber,
                stepName,
                error: errorMsg,
                timestamp: Date.now()
            });
        } catch (e) {
            console.warn('No se pudo notificar al popup el fallo de paso:', e);
        }
    }

    async clickPublicarAnuncio() {
        console.log('🖱️ Buscando botón "Publicar el anuncio"...');
        
        // Verificar URL actual
        if (!window.location.href.includes('autoline.es')) {
            console.log('❌ No estamos en autoline.es');
            return false;
        }
        
        const element = document.querySelector(this.steps[0].selector);
        
        if (element && this.isElementVisible(element)) {
            console.log('✅ Botón encontrado, haciendo click...');
            try {
                element.click();
                await this.delay(3000);
                
                // Verificar que la navegación fue exitosa
                if (window.location.href.includes('/add/')) {
                    console.log('✅ Navegación exitosa a página de agregar');
                    return true;
                } else {
                    console.log('⚠️ Navegación no completada tras click, reintentando...');
                    return false;
                }
            } catch (error) {
                console.error('❌ Error haciendo click:', error);
                return false;
            }
        } else {
            console.warn('❌ Botón "Publicar el anuncio" no encontrado o no visible. Selector usado:', this.steps[0].selector);
            // Forzar avanzar para no bloquear la cola
            return false;
        }
    }

    async clickCabezasTractoras() {
        console.log('🖱️ Buscando opción "Cabezas tractoras"...');
        
        // Verificar que estamos en la página correcta
        if (!window.location.href.includes('/add/')) {
            console.log('❌ No estamos en página de agregar');
            return false;
        }
        
        await this.delay(2000); // Esperar que cargue la página
        
        const element = document.querySelector(this.steps[1].selector);
        
        if (element && this.isElementVisible(element)) {
            console.log('✅ Opción encontrada, haciendo click...');
            try {
                element.click();
                await this.delay(3000);
                
                // Verificar que llegamos al formulario
                if (window.location.href.includes('/add/params/form/')) {
                    console.log('✅ Navegación exitosa al formulario');
                    return true;
                } else {
                    console.log('⚠️ No se llegó al formulario, reintentando...');
                    return false;
                }
            } catch (error) {
                console.error('❌ Error haciendo click:', error);
                return false;
            }
        }
        
        console.log('❌ Opción "Cabezas tractoras" no encontrada o no visible');
        return false;
    }

    async insertarDatos() {
        if (!this.vehicleData) {
            console.log('❌ No hay datos de vehículo disponibles');
            return false;
        }
        
        console.log('🔧 Insertando datos del vehículo:', this.vehicleData);
        
        // Verificar que estamos en la página correcta
        if (!window.location.href.includes('/add/params/form/')) {
            console.log('❌ No estamos en la página de formulario');
            return false;
        }
        
        // Preparar el formulario web (remover select2 y otros elementos problemáticos)
        this.prepararFormulario();
        
        // Esperar carga completa del formulario
        await this.delay(3000);
        
        let fieldsSet = 0;
        
        try {
            console.log('🎯 Insertando datos con método robusto...');
            
            // **DATOS BÁSICOS PRINCIPALES** (usando métodos robustos del archivo de referencia)
            
            // 1. Marca (trademark) - SELECT - CRÍTICO
            if (this.vehicleData.marca || this.vehicleData.au_marca) {
                const marca = this.vehicleData.marca || this.vehicleData.au_marca;
                const success = await this.setSelectValueRobust('select[name="v--trademark"]', marca);
                if (success) {
                    fieldsSet++;
                    console.log('✅ Marca procesada:', marca);
                }
            }
            
            // 2. Modelo - INPUT
            if (this.vehicleData.modelo) {
                const success = await this.setInputValueRobust('input[name="v--model"]', this.vehicleData.modelo);
                if (success) {
                    fieldsSet++;
                    console.log('✅ Modelo procesado:', this.vehicleData.modelo);
                }
            }
            
            // 3. Kilómetros - INPUT - CRÍTICO
            if (this.vehicleData.km || this.vehicleData.kilometros) {
                const km = this.vehicleData.km || this.vehicleData.kilometros;
                const success = await this.setInputValueRobust('input[name="v--kilometrag"]', km);
                if (success) {
                    fieldsSet++;
                    console.log('✅ Kilómetros procesados:', km);
                }
            }
            
            // 4. Precio - INPUT
            if (this.vehicleData.precio) {
                const success = await this.setInputValueRobust('input[name="v--price"]', this.vehicleData.precio);
                if (success) {
                    fieldsSet++;
                    console.log('✅ Precio procesado:', this.vehicleData.precio);
                }
            }
            
            // **CAMPOS DE FECHA - AÑOS - CRÍTICOS**
            
            // 5. Año de fabricación - SELECT - CRÍTICO
            if (this.vehicleData.year || this.vehicleData.fecha_matriculacion) {
                let year;
                if (this.vehicleData.year) {
                    year = this.vehicleData.year;
                } else if (this.vehicleData.fecha_matriculacion) {
                    year = this.getYear(this.vehicleData.fecha_matriculacion);
                }
                if (year) {
                    const success = await this.setSelectValueRobust('select[name="v--yearmade"]', year.toString());
                    if (success) {
                        fieldsSet++;
                        console.log('✅ Año fabricación procesado:', year);
                    }
                }
            }
            
            // 6. Año de registro - SELECT
            if (this.vehicleData.year || this.vehicleData.fecha_matriculacion) {
                let year;
                if (this.vehicleData.year) {
                    year = this.vehicleData.year;
                } else if (this.vehicleData.fecha_matriculacion) {
                    year = this.getYear(this.vehicleData.fecha_matriculacion);
                }
                if (year) {
                    const success = await this.setSelectValueRobust('select[name="v--yearreg"]', year.toString());
                    if (success) {
                        fieldsSet++;
                        console.log('✅ Año registro procesado:', year);
                    }
                }
            }
            
            // 7. Mes de fabricación - SELECT
            if (this.vehicleData.fecha_matriculacion) {
                const month = this.getMonth(this.vehicleData.fecha_matriculacion);
                if (month) {
                    const success = await this.setSelectValueRobust('select[name="v--monthmade"]', month);
                    if (success) {
                        fieldsSet++;
                        console.log('✅ Mes fabricación procesado:', month);
                    }
                }
            }
            
            // **CAMPOS ADICIONALES ROBUSTOS**
            
            // 8. Código/Stock del proveedor - INPUT
            if (this.vehicleData.codigo) {
                const success = await this.setInputValueRobust('input[name="v--regnomer"]', this.vehicleData.codigo);
                if (success) {
                    fieldsSet++;
                    console.log('✅ Código procesado:', this.vehicleData.codigo);
                }
            }
            
            // 9. Dimensiones - INPUTS
            if (this.vehicleData.longitud) {
                await this.setInputValueRobust('input[name="v--length"]', this.vehicleData.longitud);
                fieldsSet++;
            }
            
            if (this.vehicleData.anchura) {
                await this.setInputValueRobust('input[name="v--width"]', this.vehicleData.anchura);
                fieldsSet++;
            }
            
            if (this.vehicleData.altura) {
                await this.setInputValueRobust('input[name="v--height"]', this.vehicleData.altura);
                fieldsSet++;
            }
            
            // 10. Potencia del motor - INPUT
            if (this.vehicleData.potencia) {
                await this.setInputValueRobust('input[name="v--enginepower"]', this.vehicleData.potencia);
                fieldsSet++;
            }
            
            // 11. Configuraciones técnicas - SELECTS
            if (this.vehicleData.literas) {
                const literasValue = (parseInt(this.vehicleData.literas) + 1).toString();
                await this.setSelectValueRobust('select[name="v--sleeper"]', literasValue);
                fieldsSet++;
            }
            
            if (this.vehicleData.normas) {
                await this.setSelectValueRobust('select[name="v--euro"]', this.vehicleData.normas);
                fieldsSet++;
            }
            
            if (this.vehicleData.numero_ejes) {
                await this.setSelectValueRobust('select[name="v--axel_num"]', this.vehicleData.numero_ejes);
                fieldsSet++;
            }
            
            // Combustible por defecto: Diésel
            await this.setSelectValueRobust('select[name="v--fuel"]', "4116");
            fieldsSet++;
            
            // 12. Comentarios - TEXTAREA
            if (this.vehicleData.informacion_com) {
                await this.setTextareaValueRobust('textarea[name="v--comment-es"]', this.vehicleData.informacion_com);
                fieldsSet++;
            }
            
            // 13. Checkboxes principales
            if (this.vehicleData.abs) {
                await this.setCheckboxRobust('input[name="v--abs"]', this.vehicleData.abs);
                fieldsSet++;
            }
            
            if (this.vehicleData.airbag) {
                await this.setCheckboxRobust('input[name="v--airbag"]', this.vehicleData.airbag);
                fieldsSet++;
            }
            
            if (this.vehicleData.climatizacion) {
                await this.setCheckboxRobust('input[name="v--klimat_kontrol"]', this.vehicleData.climatizacion);
                fieldsSet++;
            }
            
            if (this.vehicleData.tacografo) {
                await this.setCheckboxRobust('input[name="v--tahograf"]', this.vehicleData.tacografo);
                fieldsSet++;
            }
            
        } catch (error) {
            console.error('❌ Error insertando datos:', error);
            return false;
        }
        
        console.log(`✅ Inserción completada. Campos establecidos: ${fieldsSet}`);
        
        // VERIFICAR QUE NO HAYA NAVEGACIÓN INESPERADA
        const currentUrl = window.location.href;
        await this.delay(2000);
        
        if (window.location.href !== currentUrl) {
            console.log('❌ NAVEGACIÓN INESPERADA DETECTADA');
            return false;
        }
        
        console.log('🎉 Datos insertados exitosamente sin redirección');
        return true;
    }

    // **MÉTODOS AUXILIARES ROBUSTOS** (basados en autoline-automation.js)
    
    prepararFormulario() {
        // Remover elementos select2 si existen
        const select2Elements = document.querySelectorAll('.select2-hidden-accessible');
        select2Elements.forEach(el => el.classList.remove('select2-hidden-accessible'));

        const select2Rendered = document.querySelectorAll('.select2-selection__rendered');
        select2Rendered.forEach(el => el.remove());

        const select2Selection = document.querySelectorAll('.select2-selection');
        select2Selection.forEach(el => el.remove());

        const select2Container = document.querySelectorAll('.select2-container');
        select2Container.forEach(el => el.remove());

        const sections = document.querySelectorAll('.section-content');
        sections.forEach(section => section.style.display = 'block');

        console.log('🔧 Formulario preparado para inserción robusta');
    }
    
    async setInputValueRobust(selector, value) {
        if (!value || value === '0' || value === '') return false;
        
        const element = document.querySelector(selector);
        if (element) {
            element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            await this.delay(50);
            console.log(`✅ Input ${selector} = ${value}`);
            return true;
        }
        console.log(`⚠️ No encontrado: ${selector}`);
        return false;
    }

    async setSelectValueRobust(selector, value) {
        if (!value || value === '0' || value === '') return false;
        
        const element = document.querySelector(selector);
        if (element) {
            element.value = value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
            await this.delay(50);
            console.log(`✅ Select ${selector} = ${value}`);
            return true;
        }
        console.log(`⚠️ No encontrado: ${selector}`);
        return false;
    }

    async setTextareaValueRobust(selector, value) {
        if (!value || value === '') return false;
        
        const element = document.querySelector(selector);
        if (element) {
            element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            await this.delay(50);
            console.log(`✅ Textarea ${selector} = ${value}`);
            return true;
        }
        console.log(`⚠️ No encontrado: ${selector}`);
        return false;
    }

    async setCheckboxRobust(selector, value) {
        const element = document.querySelector(selector);
        if (element) {
            element.checked = (value === "on" || value === "1" || value === true);
            element.dispatchEvent(new Event('change', { bubbles: true }));
            await this.delay(50);
            console.log(`✅ Checkbox ${selector} = ${value}`);
            return true;
        }
        console.log(`⚠️ No encontrado: ${selector}`);
        return false;
    }

    getYear(inputFormat) {
        if (inputFormat === '0000-00-00' || !inputFormat) return null;
        const d = new Date(inputFormat);
        return d.getFullYear();
    }

    getMonth(inputFormat) {
        if (inputFormat === '0000-00-00' || !inputFormat) return null;
        const d = new Date(inputFormat);
        return String(d.getMonth() + 1).padStart(2, '0');
    }

    // --- COLA DE VEHÍCULOS ---
    async saveQueueState() {
        await chrome.storage.local.set({
            autolineQueue: this.queue || [],
            autolineQueueIndex: this.queueIndex || 0,
            autolineQueueActive: this.queueActive || false
        });
    }
    async loadQueueState() {
        const result = await chrome.storage.local.get([
            'autolineQueue', 'autolineQueueIndex', 'autolineQueueActive'
        ]);
        this.queue = result.autolineQueue || [];
        this.queueIndex = typeof result.autolineQueueIndex === 'number' ? result.autolineQueueIndex : 0;
        this.queueActive = !!result.autolineQueueActive;
    }
    async startQueue(queueArr) {
        this.queue = queueArr;
        this.queueIndex = 0;
        this.queueActive = true;
        await this.saveQueueState();
        await this.startVehicleAutomationFromQueue();
    }
    async startVehicleAutomationFromQueue() {
        if (!this.queueActive || !this.queue || this.queueIndex >= this.queue.length) {
            this.queueActive = false;
            await this.saveQueueState();
            this.stopAutomation();
            chrome.runtime.sendMessage({ type: 'AUTOLINE_QUEUE_FINISHED', timestamp: Date.now() });
            return;
        }
        const vehicleData = this.queue[this.queueIndex];
        this.vehicleData = vehicleData;
        this.currentStep = 0;
        this.isRunning = true;
        await this.saveState();
        await this.saveQueueState();
        await this.executeCurrentStep(0);
    }
    async completeAutomation() {
        console.log('🎉 Vehículo completado, avanzando en la cola...');
        this._notifyProgress(this.steps?.length || 3, this.steps?.length || 3);
        this._notifyStatus('✅ Automatización completada', 'success');
        this._notifyLog('🎉 Vehículo completado', 'success');
        this.isRunning = false;
        this.currentStep = 0;
        await this.saveState();
        if (this.queueActive) {
            this.queueIndex++;
            await this.saveQueueState();
            setTimeout(() => { this.startVehicleAutomationFromQueue(); }, 1000);
        } else {
            // Notificar al popup que la automatización se completó
            try {
                chrome.runtime.sendMessage({ type: 'AUTOMATION_COMPLETE' });
            } catch (error) {
                console.log('⚠️ No se pudo notificar al popup:', error);
            }
        }
    }
    async stopAutomation() {
        console.log('⏹️ Deteniendo automatización...');
        this.isRunning = false;
        this.currentStep = 0;
        this.vehicleData = null;
        this.queue = [];
        this.queueIndex = 0;
        this.queueActive = false;
        await chrome.storage.local.remove([
            'autolineCurrentStep', 'autolineIsRunning', 'autolineVehicleData',
            'autolineQueue', 'autolineQueueIndex', 'autolineQueueActive'
        ]);
        try {
            chrome.runtime.sendMessage({
                type: 'AUTOMATION_STOPPED',
                timestamp: Date.now()
            });
        } catch (error) {
            console.log('⚠️ No se pudo notificar al popup:', error);
        }
    }
    async resetAutomation() {
        console.log('🔄 Reiniciando automatización...');
        this.isRunning = false;
        this.currentStep = 0;
        this.vehicleData = null;
        this.queue = [];
        this.queueIndex = 0;
        this.queueActive = false;
        await chrome.storage.local.remove([
            'autolineCurrentStep', 'autolineIsRunning', 'autolineVehicleData',
            'autolineQueue', 'autolineQueueIndex', 'autolineQueueActive'
        ]);
        try {
            chrome.runtime.sendMessage({
                type: 'AUTOMATION_RESET',
                timestamp: Date.now()
            });
        } catch (error) {
            console.log('⚠️ No se pudo notificar al popup:', error);
        }
    }
    async loadState() {
        try {
            const result = await chrome.storage.local.get([
                'autolineCurrentStep',
                'autolineIsRunning',
                'autolineVehicleData',
                'autolineQueue',
                'autolineQueueIndex',
                'autolineQueueActive'
            ]);
            let shouldResume = false;
            if (typeof result.autolineCurrentStep === 'number') {
                this._currentStep = result.autolineCurrentStep;
            }
            if (typeof result.autolineIsRunning === 'boolean') {
                this._isRunning = result.autolineIsRunning;
                if (result.autolineIsRunning) shouldResume = true;
            }
            if (result.autolineVehicleData) {
                this._vehicleData = result.autolineVehicleData;
                if (result.autolineIsRunning) shouldResume = true;
            }
            // Cola
            this.queue = result.autolineQueue || [];
            this.queueIndex = typeof result.autolineQueueIndex === 'number' ? result.autolineQueueIndex : 0;
            this.queueActive = !!result.autolineQueueActive;
            if (this.queueActive && this.queue.length > 0) shouldResume = true;
            console.log('🔄 Estado restaurado:', {
                currentStep: this._currentStep,
                isRunning: this._isRunning,
                vehicleData: this._vehicleData?.codigo || null,
                queue: this.queue,
                queueIndex: this.queueIndex,
                queueActive: this.queueActive
            });
            // Si hay automatización pendiente, reanudar
            if (shouldResume && this._vehicleData) {
                if (this.queueActive && this.queue.length > 0) {
                    console.log('⏩ Reanudando cola tras recarga...');
                    setTimeout(() => { this.startVehicleAutomationFromQueue(); }, 500);
                } else {
                    console.log('⏩ Reanudando automatización tras recarga...');
                    setTimeout(() => { this.startAutomation(); }, 500);
                }
            }
        } catch (e) {
            console.warn('No se pudo restaurar el estado:', e);
        }
    }

    isElementVisible(element) {
        return element && element.offsetParent !== null && element.offsetWidth > 0 && element.offsetHeight > 0;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // Método para verificar el estado del content script
    getStatus() {
        return {
            isRunning: this.isRunning,
            currentStep: this.currentStep,
            totalSteps: this.steps.length,
            hasVehicleData: !!this.vehicleData,
            currentUrl: window.location.href,
            timestamp: Date.now()
        };
    }

    async saveState() {
        try {
            await chrome.storage.local.set({
                autolineCurrentStep: this.currentStep,
                autolineIsRunning: this.isRunning,
                autolineVehicleData: this.vehicleData
            });
            console.log('💾 Estado guardado:', {
                currentStep: this.currentStep,
                isRunning: this.isRunning,
                vehicleData: this.vehicleData?.codigo || null
            });
        } catch (e) {
            console.warn('No se pudo guardar el estado:', e);
        }
    }

    async loadState() {
        try {
            const result = await chrome.storage.local.get([
                'autolineCurrentStep',
                'autolineIsRunning',
                'autolineVehicleData',
                'autolineQueue',
                'autolineQueueIndex',
                'autolineQueueActive'
            ]);
            let shouldResume = false;
            if (typeof result.autolineCurrentStep === 'number') {
                this._currentStep = result.autolineCurrentStep;
            }
            if (typeof result.autolineIsRunning === 'boolean') {
                this._isRunning = result.autolineIsRunning;
                if (result.autolineIsRunning) shouldResume = true;
            }
            if (result.autolineVehicleData) {
                this._vehicleData = result.autolineVehicleData;
                if (result.autolineIsRunning) shouldResume = true;
            }
            // Cola
            this.queue = result.autolineQueue || [];
            this.queueIndex = typeof result.autolineQueueIndex === 'number' ? result.autolineQueueIndex : 0;
            this.queueActive = !!result.autolineQueueActive;
            if (this.queueActive && this.queue.length > 0) shouldResume = true;
            console.log('🔄 Estado restaurado:', {
                currentStep: this._currentStep,
                isRunning: this._isRunning,
                vehicleData: this._vehicleData?.codigo || null,
                queue: this.queue,
                queueIndex: this.queueIndex,
                queueActive: this.queueActive
            });
            // Si hay automatización pendiente, reanudar
            if (shouldResume && this._vehicleData) {
                if (this.queueActive && this.queue.length > 0) {
                    console.log('⏩ Reanudando cola tras recarga...');
                    setTimeout(() => { this.startVehicleAutomationFromQueue(); }, 500);
                } else {
                    console.log('⏩ Reanudando automatización tras recarga...');
                    setTimeout(() => { this.startAutomation(); }, 500);
                }
            }
        } catch (e) {
            console.warn('No se pudo restaurar el estado:', e);
        }
    }

    // Guardar estado después de cada cambio relevante
    set currentStep(val) {
        this._currentStep = val;
        this.saveState();
    }
    get currentStep() {
        return this._currentStep || 0;
    }
    set isRunning(val) {
        this._isRunning = val;
        this.saveState();
    }
    get isRunning() {
        return this._isRunning || false;
    }
    set vehicleData(val) {
        this._vehicleData = val;
        this.saveState();
    }
    get vehicleData() {
        return this._vehicleData || null;
    }
}

// Inicializar solo si estamos en autoline.es
if (window.location.href.includes('autoline.es')) {
    // Crear instancia global para evitar duplicados
    window.autolineAutomationInstance = new AutolineAutomation();
    console.log('✅ AutolineAutomation inicializado correctamente');
}