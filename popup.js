// Variables globales
let codigocliente = "300";
let currentVehicleData = null;
let automationEnabled = false;
let selectedVehicles = []; // Array de códigos de vehículos seleccionados
let vehicleQueue = []; // Cola de vehículos para procesar
let currentProcessingIndex = 0; // Índice actual en la cola
let isProcessingQueue = false;

const ruta = "https://truckocasion.com";

// Inicialización cuando se carga el popup
document.addEventListener("DOMContentLoaded", function () {
  initializePopup();
  setupEventListeners();
  loadStoredData();
});

function initializePopup() {
  // Cargar datos iniciales
  showselect();

  // Configurar listener para mensajes del content script
  setupRuntimeMessageListener();
}

// ===============================
// 🔧 Utilidad robusta para enviar mensajes al content-script
// ===============================
async function safeSendMessage(tabId, message, maxRetries = 2) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const ping = await chrome.tabs
        .sendMessage(tabId, { type: "PING" })
        .catch(() => null);
      if (!ping?.success) {
        console.warn(
          `⚠️ No hay content-script, intento ${i + 1}/${maxRetries + 1}`
        );

        // Reinyectar manualmente el content-script
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content-script.js"],
          });
          await new Promise((r) => setTimeout(r, 800)); // pequeña pausa
        } catch (injErr) {
          console.error("⚠️ Error al inyectar content-script:", injErr);
        }
      }

      // Intentar enviar el mensaje real
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      console.warn(`❌ Error comunicación (intento ${i + 1}):`, err);
      if (i === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000)); // espera y reintenta
    }
  }
}

function setupRuntimeMessageListener() {
  let lastComplete = { when: 0, sessionId: null };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("🔔 Mensaje del content script:", message);

    switch (message.type) {
      case "STATUS_UPDATE":
        if (message.data && message.data.text !== undefined) {
          updateStatus(message.data.text, message.data.type || "info");
        }
        sendResponse && sendResponse({ success: true });
        break;
      case "PROGRESS_UPDATE":
        if (
          message.data &&
          message.data.current !== undefined &&
          message.data.total !== undefined
        ) {
          updateProgress(message.data.current, message.data.total);
        }
        sendResponse && sendResponse({ success: true });
        break;
      case "LOG_UPDATE":
        if (message.data && message.data.message) {
          addLog(message.data.message, message.data.type || "info");
        }
        sendResponse && sendResponse({ success: true });
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

              // 🔍 Verificar que el content-script existe
              const ping = await chrome.tabs
                .sendMessage(activeTab.id, { type: "PING" })
                .catch(() => null);
              if (!ping?.success) {
                addLog("⏳ Esperando que se reactive autoline.es...", "info");
                await new Promise((r) => setTimeout(r, 1500));

                // Reintentar ping una vez más
                const retryPing = await chrome.tabs
                  .sendMessage(activeTab.id, { type: "PING" })
                  .catch(() => null);
                if (!retryPing?.success) {
                  addLog(
                    "🔄 Recargando pestaña para reinyectar script...",
                    "warning"
                  );
                  await chrome.tabs.reload(activeTab.id);
                  await new Promise((r) => setTimeout(r, 3000));
                }
              }

              // 🔧 Reset limpio del estado del content-script
              await safeSendMessage(activeTab.id, {
                type: "RESET_AUTOMATION",
              }).catch(() => {});
              await new Promise((r) => setTimeout(r, 500));
            } catch (err) {
              console.warn(
                "⚠️ Error al intentar reiniciar el content-script:",
                err
              );
            }

            // 🟢 Avanzar al siguiente vehículo
            currentProcessingIndex++;
            setTimeout(() => {
              processNextVehicle();
            }, 1500);
          } else {
            updateStatus("✅ Completado", "success");
            toggleButtons(false);
            addLog("🎉 ¡Automatización completada!", "success");
          }

          sendResponse && sendResponse({ success: true });
        })();
        break;

      case "AUTOMATION_COMPLETED":
        addLog("🎉 Automatización completada exitosamente", "success");
        updateStatus("Vehículo completado", "success");

        // Pasar al siguiente vehículo después de una pausa
        setTimeout(() => {
          currentProcessingIndex++;
          processNextVehicle();
        }, 3000);

        sendResponse({ success: true });
        break;

      case "AUTOMATION_STOPPED":
        addLog("⏹️ Automatización detenida", "warning");
        updateStatus("Detenido", "warning");
        sendResponse({ success: true });
        break;

      case "AUTOMATION_RESET":
        addLog("🔄 Automatización reiniciada", "info");
        sendResponse({ success: true });
        break;

      default:
        console.log("❓ Mensaje desconocido:", message.type);
        break;
    }
  });
}

function setupEventListeners() {
  // Eventos de selects
  document.getElementById("cliente").addEventListener("change", function () {
    codigocliente = this.value;
    chrome.storage.sync.set({ selectedClient: codigocliente });
    showselect();
  });

  document.getElementById("carroceria").addEventListener("change", function () {
    showselect();
  });

  // Eventos de botones
  document.getElementById("add").addEventListener("click", function () {
    window.open(
      ruta + "/truck/html/FormAddVehiculo.html?num=" + codigocliente,
      "_blank"
    );
  });

  document.getElementById("delete").addEventListener("click", deleteVehicle);
  document
    .getElementById("loop")
    .addEventListener("click", toggleAutomationPanel);

  // Botón para limpiar selección (se agregará dinámicamente)
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "clear-selection") {
      clearAllSelections();
    }
  });

  // Botones de automatización
  document
    .getElementById("start-btn")
    .addEventListener("click", startAutomation);
  document.getElementById("stop-btn").addEventListener("click", stopAutomation);
  document
    .getElementById("reset-btn")
    .addEventListener("click", resetAutomation);
}

function loadStoredData() {
  chrome.storage.sync.get(["selectedClient"], function (result) {
    if (result.selectedClient) {
      codigocliente = result.selectedClient;
      document.getElementById("cliente").value = codigocliente;
    }
  });
}

function showselect() {
  const vehicleList = document.getElementById("vehicle-list");
  const vehiclePlaceholder = document.getElementById("vehicle-placeholder");
  const selectionInfo = document.getElementById("selection-info");

  // Limpiar selecciones anteriores
  selectedVehicles = [];
  updateSelectionInfo();

  const carroceria = document.getElementById("carroceria").value;
  const cliente = codigocliente;

  if (!carroceria) {
    vehicleList.style.display = "none";
    vehiclePlaceholder.style.display = "block";
    selectionInfo.style.display = "none";
    vehiclePlaceholder.textContent = "-- Selecciona carrocería primero --";
    return;
  }

  vehiclePlaceholder.textContent = "-- Cargando... --";

  // Hacer petición AJAX con fetch
  fetch(ruta + "/truck/scr/base.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `carroceria=${encodeURIComponent(
      carroceria
    )}&cliente=${encodeURIComponent(cliente)}`,
  })
    .then((response) => response.text())
    .then((data) => {
      try {
        const vehicles = JSON.parse(data);

        if (vehicles.length === 0) {
          vehicleList.style.display = "none";
          vehiclePlaceholder.style.display = "block";
          vehiclePlaceholder.textContent = "-- No hay vehículos disponibles --";
          selectionInfo.style.display = "none";
          return;
        }

        // Mostrar lista de vehículos con checkboxes
        vehicleList.innerHTML = "";

        // Agregar opción "Seleccionar todos"
        const selectAllContainer = document.createElement("div");
        selectAllContainer.className = "select-all-container";

        const selectAllCheckbox = document.createElement("input");
        selectAllCheckbox.type = "checkbox";
        selectAllCheckbox.id = "select-all";
        selectAllCheckbox.className = "vehicle-checkbox";

        const selectAllLabel = document.createElement("label");
        selectAllLabel.textContent = "Seleccionar todos";
        selectAllLabel.style.marginLeft = "5px";
        selectAllLabel.style.cursor = "pointer";

        selectAllContainer.appendChild(selectAllCheckbox);
        selectAllContainer.appendChild(selectAllLabel);
        vehicleList.appendChild(selectAllContainer);

        // Event listener para "Seleccionar todos"
        selectAllCheckbox.addEventListener("change", function () {
          const checkboxes = vehicleList.querySelectorAll(
            ".vehicle-checkbox:not(#select-all)"
          );
          checkboxes.forEach((checkbox) => {
            checkbox.checked = this.checked;
            if (this.checked && !selectedVehicles.includes(checkbox.value)) {
              selectedVehicles.push(checkbox.value);
            } else if (
              !this.checked &&
              selectedVehicles.includes(checkbox.value)
            ) {
              selectedVehicles = selectedVehicles.filter(
                (v) => v !== checkbox.value
              );
            }
          });
          updateSelectionInfo();
        });

        // Agregar vehículos individuales
        vehicles.forEach(function (obj) {
          const vehicleItem = document.createElement("div");
          vehicleItem.className = "vehicle-item";

          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "vehicle-checkbox";
          checkbox.value = obj.codigo;
          checkbox.id = "vehicle-" + obj.codigo;

          const label = document.createElement("label");
          label.textContent = obj.codigo;
          label.className = "vehicle-code";
          label.htmlFor = checkbox.id;
          label.style.cursor = "pointer";

          vehicleItem.appendChild(checkbox);
          vehicleItem.appendChild(label);
          vehicleList.appendChild(vehicleItem);

          // Event listener para checkbox individual
          checkbox.addEventListener("change", function () {
            if (this.checked) {
              if (!selectedVehicles.includes(this.value)) {
                selectedVehicles.push(this.value);
              }
            } else {
              selectedVehicles = selectedVehicles.filter(
                (v) => v !== this.value
              );
              // Desmarcar "Seleccionar todos" si no están todos seleccionados
              selectAllCheckbox.checked = false;
            }

            // Verificar si todos están seleccionados para marcar "Seleccionar todos"
            const allCheckboxes = vehicleList.querySelectorAll(
              ".vehicle-checkbox:not(#select-all)"
            );
            const checkedBoxes = vehicleList.querySelectorAll(
              ".vehicle-checkbox:not(#select-all):checked"
            );
            selectAllCheckbox.checked =
              allCheckboxes.length === checkedBoxes.length &&
              checkedBoxes.length > 0;

            updateSelectionInfo();
          });

          // Permitir hacer click en el contenedor para marcar/desmarcar
          vehicleItem.addEventListener("click", function (e) {
            if (e.target !== checkbox) {
              checkbox.click();
            }
          });
        });

        vehicleList.style.display = "block";
        vehiclePlaceholder.style.display = "none";
        selectionInfo.style.display = "block";
      } catch (e) {
        console.error("Error parsing vehicles data:", e);
        vehicleList.style.display = "none";
        vehiclePlaceholder.style.display = "block";
        vehiclePlaceholder.textContent = "-- Error cargando vehículos --";
        selectionInfo.style.display = "none";
      }
    })
    .catch((error) => {
      console.error("Error loading vehicles:", error);
      vehicleList.style.display = "none";
      vehiclePlaceholder.style.display = "block";
      vehiclePlaceholder.textContent = "-- Error de conexión --";
      selectionInfo.style.display = "none";
    });
}

function updateSelectionInfo() {
  const selectedCountElement = document.getElementById("selected-count");
  selectedCountElement.textContent = selectedVehicles.length;
}

function clearAllSelections() {
  selectedVehicles = [];

  // Desmarcar todos los checkboxes
  const checkboxes = document.querySelectorAll(".vehicle-checkbox");
  checkboxes.forEach((checkbox) => {
    checkbox.checked = false;
  });

  updateSelectionInfo();
  addLog("🧹 Selecciones limpiadas", "info");
}

function deleteVehicle() {
  if (selectedVehicles.length === 0) {
    addLog("Selecciona al menos un vehículo primero", "error");
    return;
  }

  const vehicleCount = selectedVehicles.length;
  const vehicleText = vehicleCount === 1 ? "vehículo" : "vehículos";

  if (
    !confirm(`¿Deseas borrar ${vehicleCount} ${vehicleText} seleccionado(s)?`)
  ) {
    return;
  }

  addLog(`🗑️ Eliminando ${vehicleCount} ${vehicleText}...`, "info");

  // Procesar eliminaciones de forma secuencial
  processVehicleDeletions(selectedVehicles.slice(), 0);
}

function processVehicleDeletions(vehiclesToDelete, index) {
  if (index >= vehiclesToDelete.length) {
    addLog("✅ Todos los vehículos eliminados", "success");
    showselect(); // Recargar la lista
    return;
  }

  const codigo = vehiclesToDelete[index];

  fetch(ruta + "/truck/scr/remove.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `codigo=${encodeURIComponent(codigo)}&cliente=${encodeURIComponent(
      codigocliente
    )}`,
  })
    .then((response) => response.text())
    .then((data) => {
      addLog(`✅ Vehículo ${codigo} eliminado`, "success");

      // Procesar siguiente vehículo
      setTimeout(() => {
        processVehicleDeletions(vehiclesToDelete, index + 1);
      }, 500);
    })
    .catch((error) => {
      console.error("Error deleting vehicle:", error);
      addLog(`❌ Error eliminando vehículo ${codigo}`, "error");

      // Continuar con el siguiente a pesar del error
      setTimeout(() => {
        processVehicleDeletions(vehiclesToDelete, index + 1);
      }, 500);
    });
}

function toggleAutomationPanel() {
  const panel = document.getElementById("automation-panel");
  const button = document.getElementById("loop");

  if (panel.style.display === "none" || panel.style.display === "") {
    panel.style.display = "block";
    button.style.background = "#005a87";
    automationEnabled = true;

    // Verificar si estamos en autoline.es
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentUrl = tabs[0].url;
      if (currentUrl && currentUrl.includes("autoline.es")) {
        addLog("✅ Detectado autoline.es - Listo para automatizar", "success");
      } else {
        addLog("⚠️ Ve a autoline.es para usar la automatización", "info");
      }
    });
  } else {
    panel.style.display = "none";
    button.style.background = "#007cba";
    automationEnabled = false;
  }
}

function startAutomation() {
  if (selectedVehicles.length === 0) {
    addLog("❌ Selecciona al menos un vehículo primero", "error");
    return;
  }

  if (isProcessingQueue) {
    addLog("⚠️ Ya hay una automatización en curso", "warning");
    return;
  }

  // Inicializar cola de procesamiento
  vehicleQueue = selectedVehicles.slice(); // Crear copia del array
  currentProcessingIndex = 0;
  isProcessingQueue = true;

  const vehicleCount = vehicleQueue.length;
  const vehicleText = vehicleCount === 1 ? "vehículo" : "vehículos";

  addLog(
    `� Iniciando automatización para ${vehicleCount} ${vehicleText}`,
    "info"
  );
  updateStatus(`Procesando ${vehicleCount} ${vehicleText}...`, "running");

  // Mostrar información de la cola
  showQueueStatus();
  updateQueueInfo();

  // Comenzar con el primer vehículo
  processNextVehicle();
}

function processNextVehicle() {
  if (!isProcessingQueue || currentProcessingIndex >= vehicleQueue.length) {
    // Completar toda la automatización
    completeAllAutomation();
    return;
  }

  const codigo = vehicleQueue[currentProcessingIndex];
  const remaining = vehicleQueue.length - currentProcessingIndex;

  addLog(
    `🔍 Procesando vehículo ${currentProcessingIndex + 1}/${
      vehicleQueue.length
    }: ${codigo}`,
    "info"
  );
  updateQueueInfo();

  // Obtener datos del vehículo actual
  fetch(ruta + "/truck/scr/buscarvehiculo.php", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `codigo=${encodeURIComponent(codigo)}&cliente=${encodeURIComponent(
      codigocliente
    )}`,
  })
    .then((response) => response.text())
    .then((data) => {
      try {
        const vehicleData = JSON.parse(data);
        currentVehicleData = vehicleData;

        // Verificar que estamos en autoline.es y enviar datos
        chrome.tabs.query(
          { active: true, currentWindow: true },
          function (tabs) {
            if (!tabs[0].url.includes("autoline.es")) {
              addLog("❌ Debes estar en autoline.es", "error");
              updateStatus("Error: No estás en autoline.es", "error");
              stopQueueProcessing();
              return;
            }

            // Inyectar content script si no existe
            const tabId = tabs[0].id;
            if (!tabId) {
              addLog("❌ No se encontró la pestaña activa", "error");
              return;
            }

            chrome.scripting.executeScript(
              {
                target: { tabId: tabId },
                files: ["content-script.js"],
              },
              async (injectionResults) => {
                // Verificar errores de ejecución/inyección
                if (chrome.runtime.lastError) {
                  console.error(
                    "❌ Error inyectando content script:",
                    chrome.runtime.lastError.message
                  );
                  addLog(
                    `❌ Error inyectando content script en ${codigo}: ${chrome.runtime.lastError.message}`,
                    "error"
                  );
                  // Pasar al siguiente vehículo para no bloquear la cola
                  setTimeout(() => {
                    currentProcessingIndex++;
                    processNextVehicle();
                  }, 1000);
                  return;
                }

                // Limpiar estado persistente antes de comenzar nuevo vehículo
                const [activeTab] = await chrome.tabs.query({
                  active: true,
                  currentWindow: true,
                });
                try {
                  await safeSendMessage(activeTab.id, {
                    type: "RESET_AUTOMATION",
                  });
                } catch (e) {
                  console.warn(
                    "⚠️ RESET_AUTOMATION sin respuesta, continúo igualmente:",
                    e
                  );
                }
                // Pequeña pausa para asegurar limpieza completa
                await new Promise((r) => setTimeout(r, 500));

                // **Ahora sí** lanzar el START del vehículo
                sendAutomationMessage(tabId, vehicleData, codigo);
              }
            );
          }
        );
      } catch (error) {
        addLog(
          `❌ Error procesando datos del vehículo ${codigo}: ${error.message}`,
          "error"
        );
        // Pasar al siguiente vehículo
        setTimeout(() => {
          currentProcessingIndex++;
          processNextVehicle();
        }, 2000);
      }
    })
    .catch((error) => {
      addLog(`❌ Error cargando datos del vehículo ${codigo}`, "error");
      // Pasar al siguiente vehículo
      setTimeout(() => {
        currentProcessingIndex++;
        processNextVehicle();
      }, 2000);
    });
}

function sendAutomationMessage(tabId, vehicleData, codigo) {
  // Primero hacer ping para verificar que el content script está activo
  if (!tabId) {
    addLog("❌ sendAutomationMessage: tabId inválido", "error");
    return;
  }

  chrome.tabs.sendMessage(tabId, { type: "PING" }, function (pingResponse) {
    if (chrome.runtime.lastError) {
      console.log("⚠️ Content script no responde, reinyectando...");

      // Reinyectar content script
      chrome.scripting.executeScript(
        { target: { tabId: tabId }, files: ["content-script.js"] },
        (injectionResults) => {
          if (chrome.runtime.lastError) {
            console.error(
              "❌ Error inyectando content script (sendAutomationMessage):",
              chrome.runtime.lastError.message
            );
            addLog(
              `❌ Error inyectando content script en ${codigo}: ${chrome.runtime.lastError.message}`,
              "error"
            );
            // Avanzar para no bloquear la cola
            setTimeout(() => {
              currentProcessingIndex++;
              processNextVehicle();
            }, 1000);
            return;
          }

          // Esperar un momento y luego enviar mensaje
          setTimeout(() => {
            sendAutomationMessageDirect(tabId, vehicleData, codigo);
          }, 1000);
        }
      );
    } else {
      console.log("✅ Content script activo, enviando mensaje...");
      sendAutomationMessageDirect(tabId, vehicleData, codigo);
    }
  });
}

function sendAutomationMessageDirect(tabId, vehicleData, codigo) {
  const messageData = {
    type: "START_AUTOMATION",
    vehicleData: vehicleData,
    isQueueProcessing: true,
    queueInfo: {
      current: currentProcessingIndex + 1,
      total: vehicleQueue.length,
      vehicleCode: codigo,
      justStarted: true,
    },
  };

  console.log("📤 Enviando mensaje de automatización:", messageData);

  chrome.tabs.sendMessage(tabId, messageData, async function (response) {
    const lastError = chrome.runtime.lastError;

    if (lastError) {
      console.error("❌ Error de comunicación detallado:", {
        error: lastError,
        message: lastError.message,
        codigo: codigo,
        tabId: tabId,
      });

      addLog(
        `❌ Error comunicación con ${codigo}: ${lastError.message}`,
        "error"
      );

      // Reintentar una vez más con más información
      setTimeout(() => {
        addLog(`🔄 Reintentando comunicación con ${codigo}...`, "info");

        chrome.tabs.sendMessage(
          tabId,
          {
            ...messageData,
            queueInfo: {
              ...messageData.queueInfo,
              retry: true,
              retryReason: lastError.message,
            },
          },
          function (retryResponse) {
            const retryError = chrome.runtime.lastError;

            if (retryError) {
              console.error("❌ Error en reintento:", retryError);
              addLog(
                `❌ Fallo definitivo ${codigo}: ${retryError.message}`,
                "error"
              );
              updateStatus("Error de comunicación persistente", "error");

              // Pasar al siguiente vehículo
              setTimeout(() => {
                currentProcessingIndex++;
                processNextVehicle();
              }, 2000);
            } else if (retryResponse) {
              console.log("✅ Respuesta del reintento:", retryResponse);
              if (retryResponse.success) {
                addLog(
                  `✅ Comunicación establecida con ${codigo} (reintento)`,
                  "success"
                );
                updateStatus(`Procesando ${codigo}`, "info");
                toggleButtons(true);
                showProgress();
                // Ping adicional para confirmar paso
                chrome.tabs.sendMessage(tabId, { type: "PING" }, () => {});
              } else {
                addLog(
                  `❌ Error en reintento ${codigo}: ${retryResponse.error}`,
                  "error"
                );
                setTimeout(() => {
                  currentProcessingIndex++;
                  processNextVehicle();
                }, 2000);
              }
            } else {
              addLog(`⚠️ Sin respuesta en reintento de ${codigo}`, "warning");
              setTimeout(() => {
                currentProcessingIndex++;
                processNextVehicle();
              }, 2000);
            }
          }
        );
      }, 2000);
    } else if (response) {
      console.log("✅ Respuesta recibida:", response);
      if (response.success) {
        addLog(`✅ Automatización iniciada para ${codigo}`, "success");
        updateStatus(`Procesando ${codigo}`, "info");
        toggleButtons(true);
        showProgress();
        // Espacio de seguridad: espera a que content-script quede realmente en running
        try {
          const ping = await chrome.tabs
            .sendMessage(tabId, { type: "PING" })
            .catch(() => null);
          if (!ping?.success) {
            addLog(
              "⚠️ Content-script no confirmó estado tras START",
              "warning"
            );
          } else {
            addLog(
              `ℹ️ Estado tras START: paso ${ping.status?.currentStep}/${ping.status?.totalSteps}`,
              "info"
            );
          }
        } catch {}
      } else {
        addLog(
          `❌ Error del content script ${codigo}: ${response.error}`,
          "error"
        );
        console.error("Error details:", response);
        setTimeout(() => {
          currentProcessingIndex++;
          processNextVehicle();
        }, 2000);
      }
    } else {
      addLog(`⚠️ Sin respuesta de ${codigo}`, "warning");
      console.log("No response received");
      updateStatus(`Problema con ${codigo}`, "warning");
      setTimeout(() => {
        currentProcessingIndex++;
        processNextVehicle();
      }, 2000);
    }
  });
}

function completeAllAutomation() {
  isProcessingQueue = false;
  hideQueueStatus();

  const processedCount = currentProcessingIndex;
  const totalCount = vehicleQueue.length;

  updateStatus(`✅ Procesamiento completado`, "success");
  addLog(
    `🎉 ¡Automatización completada! ${processedCount}/${totalCount} vehículos procesados`,
    "success"
  );

  toggleButtons(false);
  hideProgress();

  // Limpiar variables
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

function showQueueStatus() {
  document.getElementById("queue-status").classList.add("active");
}

function hideQueueStatus() {
  document.getElementById("queue-status").classList.remove("active");
}

function updateQueueInfo() {
  if (isProcessingQueue) {
    document.getElementById("current-vehicle").textContent =
      vehicleQueue[currentProcessingIndex] || "-";
    document.getElementById("remaining-count").textContent =
      vehicleQueue.length - currentProcessingIndex - 1;
  }
}

function stopAutomation() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    chrome.tabs.sendMessage(
      tabs[0].id,
      {
        type: "STOP_AUTOMATION",
      },
      function (response) {
        if (isProcessingQueue) {
          stopQueueProcessing();
        } else {
          addLog("⏹️ Automatización detenida", "info");
          updateStatus("Detenido", "error");
          toggleButtons(false);
        }
      }
    );
  });
}

function resetAutomation() {
  chrome.tabs.query(
    { active: true, currentWindow: true },
    async function (tabs) {
      await safeSendMessage(
        tabs[0].id,
        {
          type: "RESET_AUTOMATION",
        },
        function (response) {
          // Resetear variables de cola
          isProcessingQueue = false;
          vehicleQueue = [];
          currentProcessingIndex = 0;

          addLog("🔄 Automatización reiniciada", "info");
          updateStatus("Listo para comenzar", "");
          hideProgress();
          hideQueueStatus();
          toggleButtons(false);

          // Limpiar log
          document.getElementById("log").innerHTML = "";
        }
      );
    }
  );
}

function toggleButtons(isRunning) {
  document.getElementById("start-btn").style.display = isRunning
    ? "none"
    : "block";
  document.getElementById("stop-btn").style.display = isRunning
    ? "block"
    : "none";
}

function showProgress() {
  document.getElementById("progress").style.display = "block";
}

function hideProgress() {
  document.getElementById("progress").style.display = "none";
  document.getElementById("progress-bar").style.width = "0%";
}

function updateStatus(text, type) {
  const status = document.getElementById("status");
  status.className = "status " + type;
  status.querySelector("span").textContent = text;
}

function updateProgress(current, total) {
  if (isProcessingQueue) {
    // Progreso global de la cola: combinar progreso del vehículo actual + vehículos completados
    const vehiclesCompleted = currentProcessingIndex;
    const totalVehicles = vehicleQueue.length;
    const currentVehicleProgress = current / total; // Progreso del vehículo actual (0-1)

    const globalProgress =
      (vehiclesCompleted + currentVehicleProgress) / totalVehicles;
    const percentage = globalProgress * 100;

    document.getElementById("progress-bar").style.width = percentage + "%";

    // Actualizar status con información más detallada
    if (current < total) {
      updateStatus(
        `Vehículo ${
          currentProcessingIndex + 1
        }/${totalVehicles} - Paso ${current}/${total}`,
        "running"
      );
    }
  } else {
    // Progreso individual normal
    const percentage = (current / total) * 100;
    document.getElementById("progress-bar").style.width = percentage + "%";
  }
}

function addLog(message, type) {
  const log = document.getElementById("log");
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.textContent = new Date().toLocaleTimeString() + " - " + message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}
