// Service Worker mínimo para manejar mensajes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Reenviar mensajes entre content script y popup
    if (message.type === 'STATUS_UPDATE' || 
        message.type === 'PROGRESS_UPDATE' || 
        message.type === 'LOG_UPDATE' ||
        message.type === 'AUTOMATION_COMPLETE') {
        
        // Broadcast a todos los listeners
        chrome.runtime.sendMessage(message).catch(() => {
            // Ignorar errores si no hay listeners
        });
    }
    
    return true;
});

// === Lee un recurso local (XAMPP) y lo devuelve como DataURL (base64) ===
async function fetchLocalAsDataURL(fileUrl) {
  // Intento directo
  let resp = await fetch(fileUrl, { cache: "no-store" }).catch(()=>null);
  if (!resp || !resp.ok) return { ok:false, status: resp?.status||0 };

  const blob = await resp.blob();
  const data = await blob.arrayBuffer();
  const b64  = btoa(String.fromCharCode(...new Uint8Array(data)));
  const mime = blob.type || guessMimeFromName(fileUrl);
  return { ok:true, dataURL: `data:${mime};base64,${b64}`, length: data.byteLength };

  function guessMimeFromName(u){
    const n = (u.split('?')[0]||'').toLowerCase();
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.png'))  return 'image/png';
    if (n.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
  }
}

// === Mensajería: content-script pide una imagen local ===
// Devuelve existencia y DataURL de un recurso http://127.0.0.1/...
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type !== "FETCH_LOCAL_IMAGE" || !msg.url) return;
    try {
      const res = await fetch(msg.url, { cache: "no-store" });
      if (!res.ok) return sendResponse({ ok:false, status: res.status });

      const blob = await res.blob();
      let mime = blob.type || "";
      if (!mime || mime === "application/octet-stream") {
        const u = msg.url.toLowerCase();
        if (u.endsWith(".jpg") || u.endsWith(".jpeg")) mime = "image/jpeg";
        else if (u.endsWith(".png")) mime = "image/png";
        else if (u.endsWith(".webp")) mime = "image/webp";
        else if (u.endsWith(".heic")) mime = "image/heic";
      }
      const fr = new FileReader();
      fr.onload = () => sendResponse({ ok:true, dataURL: fr.result });
      fr.onerror = () => sendResponse({ ok:false });
      fr.readAsDataURL(mime && blob.type !== mime ? blob.slice(0, blob.size, mime) : blob);
    } catch (e) {
      sendResponse({ ok:false, error: e?.message || String(e) });
    }
  })();
  return true; // async
});


console.log('Truck Manager background script loaded');