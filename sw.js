// Service worker: recibe las notificaciones push y las muestra en el teléfono

self.addEventListener('push', (event) => {
  let datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch (e) {
    datos = { title: 'Tu mascota', body: event.data ? event.data.text() : '¡Tiene algo que decirte!' };
  }

  const titulo = datos.title || 'Tu mascota 🦙';
  const opciones = {
    body: datos.body || '¡Necesita tu atención!',
    icon: 'MENU.PNG',
    badge: 'MENU.PNG',
    data: { url: datos.url || 'pou.html' }
  };

  event.waitUntil(self.registration.showNotification(titulo, opciones));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || 'pou.html';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((lista) => {
      for (const cliente of lista) {
        if (cliente.url.includes(url) && 'focus' in cliente) return cliente.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
