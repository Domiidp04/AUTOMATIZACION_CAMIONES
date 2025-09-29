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

console.log('Truck Manager background script loaded');