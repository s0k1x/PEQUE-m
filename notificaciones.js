// Este script lo ejecuta GitHub Actions cada pocos minutos (gratis, sin
// servidor propio). Hace dos cosas:
//  1. Revisa el estado real de la mascota (calculando el desgaste por el
//     tiempo transcurrido) y avisa si necesita algo.
//  2. Revisa si se añadió una carta, foto, video, cita o meta nueva desde
//     la última vez, y avisa de eso también.

const admin = require('firebase-admin');
const webpush = require('web-push');

const credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(credencial) });
const db = admin.firestore();

const claveVapidPublica = (process.env.VAPID_PUBLIC_KEY || '').trim();
const claveVapidPrivada = (process.env.VAPID_PRIVATE_KEY || '').trim();

console.log('Diagnóstico VAPID -> longitud clave pública:', claveVapidPublica.length, '(debería ser 87)');
console.log('Diagnóstico VAPID -> longitud clave privada:', claveVapidPrivada.length, '(debería ser 43)');

webpush.setVapidDetails(
  'mailto:pequee@example.com',
  claveVapidPublica,
  claveVapidPrivada
);

// ---------- Envío compartido ----------
// tipo es 'contenido' o 'mascota' — cada suscripción puede tener desactivado uno de los dos.
// autorExcluir (opcional): si se pasa un nombre, esa persona no recibe este aviso (para no
// notificarle de algo que ella misma acaba de añadir)
async function enviarATodos(tipo, titulo, cuerpo, url, autorExcluir) {
  const suscripciones = await db.collection('suscripciones').get();
  if (suscripciones.empty) return;

  const campoPreferencia = tipo === 'mascota' ? 'prefAvisosMascota' : 'prefAvisosContenido';
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url });

  await Promise.all(suscripciones.docs.map(async (doc) => {
    const datos = doc.data();
    // Si el campo no existe (suscripciones antiguas), se asume que sí quiere el aviso
    const quiereEsteAviso = datos[campoPreferencia] !== false;
    if (!quiereEsteAviso) return;

    // No avisar a quien acaba de hacer la acción
    if (autorExcluir && datos.nombre && datos.nombre.trim().toLowerCase() === autorExcluir.trim().toLowerCase()) {
      return;
    }

    try {
      await webpush.sendNotification(datos.suscripcion, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log('Suscripción caducada, se elimina:', doc.id);
        await doc.ref.delete();
      } else {
        console.error('Error enviando a', doc.id, err.message);
      }
    }
  }));
}

// ---------- 1. Mascota ----------
const TASAS_DECAIMIENTO = { hambre: 6, sueno: 3, felicidad: 3.75 };
const UMBRAL_AVISO = 20;
const HORAS_ENTRE_AVISOS_MASCOTA = 4;

const MENSAJES = {
  combinado: [
    '😩 Tu mascota está agotada y hambrienta. ¡Necesita que la cuides!',
    '😔 Hambre y sueño a la vez... tu mascota lo está pasando mal.',
    '🆘 Tu mascota necesita ayuda urgente: tiene hambre y está agotada.'
  ],
  hambre: [
    '🍽️ Tu mascota tiene mucha hambre...',
    '🥺 A tu mascota le suena la barriguita, ¿le das de comer?',
    '🍴 Hora de comer: tu mascota te está esperando.',
    '😋 Tu mascota sueña con su comida favorita ahora mismo.'
  ],
  sueno: [
    '🥱 Tu mascota está agotada, dale un descanso.',
    '😴 Tu mascota no puede más de sueño...',
    '💤 Es hora de una siesta larga para tu mascota.',
    '🌙 Tu mascota necesita dormir, se le cierran los ojitos.'
  ],
  felicidad: [
    '😢 Tu mascota te extraña, ¿jugamos un rato?',
    '🥺 Tu mascota se aburre sin ti...',
    '🎾 Hace tiempo que no juegan juntas, ¿le dedicas un ratito?',
    '💛 Un poco de cariño le vendría genial a tu mascota ahora mismo.',
    '🙁 Tu mascota está un poco triste, acércate a saludarla.'
  ]
};

function elegirAlAzar(lista) {
  return lista[Math.floor(Math.random() * lista.length)];
}

function calcularDecaimiento(estado, ultimaFecha) {
  const horas = (Date.now() - ultimaFecha.getTime()) / (1000 * 60 * 60);
  if (horas <= 0) return estado;
  return {
    hambre: Math.max(0, estado.hambre - horas * TASAS_DECAIMIENTO.hambre),
    sueno: Math.max(0, estado.sueno - horas * TASAS_DECAIMIENTO.sueno),
    felicidad: Math.max(0, estado.felicidad - horas * TASAS_DECAIMIENTO.felicidad)
  };
}

function elegirMensajeMascota(estado) {
  if (estado.hambre < UMBRAL_AVISO && estado.sueno < UMBRAL_AVISO) return elegirAlAzar(MENSAJES.combinado);
  if (estado.hambre < UMBRAL_AVISO) return elegirAlAzar(MENSAJES.hambre);
  if (estado.sueno < UMBRAL_AVISO) return elegirAlAzar(MENSAJES.sueno);
  if (estado.felicidad < UMBRAL_AVISO) return elegirAlAzar(MENSAJES.felicidad);
  return null;
}

async function revisarMascota() {
  const refMascota = db.collection('mascota').doc('estado');
  const docMascota = await refMascota.get();
  if (!docMascota.exists) return;

  const datos = docMascota.data();
  const ultimaFecha = datos.actualizado ? datos.actualizado.toDate() : new Date();
  const estado = calcularDecaimiento(
    { hambre: datos.hambre, sueno: datos.sueno, felicidad: datos.felicidad },
    ultimaFecha
  );

  const mensaje = elegirMensajeMascota(estado);
  if (!mensaje) return;

  const ultimoAviso = datos.ultimoAviso ? datos.ultimoAviso.toDate() : null;
  if (ultimoAviso && (Date.now() - ultimoAviso.getTime()) / (1000 * 60 * 60) < HORAS_ENTRE_AVISOS_MASCOTA) {
    return;
  }

  await enviarATodos('mascota', 'Tu mascota 🦙', mensaje, 'pou.html');
  await refMascota.set({ ultimoAviso: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log('Aviso de mascota enviado:', mensaje);
}

// ---------- 2. Contenido nuevo (cartas, fotos, videos, citas, metas) ----------
const COLECCIONES_CONTENIDO = ['cartas', 'fotos', 'citas', 'metas'];

function construirMensajeContenido(coleccion, item) {
  const quien = item.autor ? `${item.autor} ha añadido` : 'Se añadió';

  if (coleccion === 'cartas') return { titulo: 'Nueva carta 💌', cuerpo: `${quien} una carta: "${item.titulo || 'Sin título'}"`, url: 'index.html' };
  if (coleccion === 'citas') return { titulo: 'Nueva cita 💕', cuerpo: `${quien} una cita: "${item.titulo || 'Sin título'}"`, url: 'index.html' };
  if (coleccion === 'metas') return { titulo: 'Nueva meta 💫', cuerpo: `${quien} una meta: ${item.texto || ''}`, url: 'index.html' };
  if (coleccion === 'fotos') {
    const esVideo = item.tipo === 'video';
    const categoria = item.categoria && item.categoria !== 'Sin categoría' ? ` en "${item.categoria}"` : '';
    return esVideo
      ? { titulo: 'Video nuevo 🎥', cuerpo: `${quien} un video${categoria}`, url: 'index.html' }
      : { titulo: 'Foto nueva 📷', cuerpo: `${quien} una foto${categoria}`, url: 'index.html' };
  }
  return null;
}

async function revisarContenido() {
  const refCursor = db.collection('notificaciones').doc('cursor');
  const docCursor = await refCursor.get();
  const cursores = docCursor.exists ? docCursor.data() : {};
  const nuevosCursores = {};

  for (const coleccion of COLECCIONES_CONTENIDO) {
    const ultimoCursor = cursores[coleccion] ? cursores[coleccion].toDate() : null;

    if (!ultimoCursor) {
      // Primera vez que se revisa esta colección: solo se marca el punto de
      // partida, sin avisar de todo lo que ya existía antes.
      const snapshotInicial = await db.collection(coleccion).orderBy('creado', 'desc').limit(1).get();
      if (!snapshotInicial.empty) {
        nuevosCursores[coleccion] = snapshotInicial.docs[0].data().creado;
      }
      continue;
    }

    const nuevos = await db.collection(coleccion)
      .where('creado', '>', ultimoCursor)
      .orderBy('creado', 'asc')
      .get();

    if (nuevos.empty) continue;

    for (const doc of nuevos.docs) {
      const item = doc.data();
      const mensaje = construirMensajeContenido(coleccion, item);
      if (mensaje) {
        await enviarATodos('contenido', mensaje.titulo, mensaje.cuerpo, mensaje.url, item.autor);
        console.log(`Aviso de ${coleccion} enviado:`, mensaje.cuerpo);
      }
      nuevosCursores[coleccion] = item.creado;
    }
  }

  if (Object.keys(nuevosCursores).length > 0) {
    await refCursor.set(nuevosCursores, { merge: true });
  }
}

// ---------- 3. Mensajes manuales (enviados desde el panel secreto) ----------
async function revisarMensajesManuales() {
  const pendientes = await db.collection('mensajesManual').where('enviado', '==', false).get();
  if (pendientes.empty) return;

  for (const doc of pendientes.docs) {
    const m = doc.data();
    const titulo = m.tipo === 'sorpresa' ? `Sorpresa de ${m.remitente} 🎁` : `Mensaje de ${m.remitente} 💌`;

    // Compatibilidad: acepta tanto el campo nuevo (destinatarios, array) como
    // el viejo (destinatario, un solo texto), por si quedó algo pendiente
    const listaDestinatarios = m.destinatarios || (m.destinatario ? [m.destinatario] : []);
    const destinos = listaDestinatarios.map(d => (d || '').trim().toLowerCase());

    if (destinos.includes('todos')) {
      await enviarATodos('contenido', titulo, m.texto, 'index.html');
    } else {
      // "yo" significa que se manda a la misma persona que lo escribió
      const nombresBuscados = destinos.map(d => d === 'yo' ? (m.remitente || '').trim().toLowerCase() : d);
      const suscripciones = await db.collection('suscripciones').get();
      const payload = JSON.stringify({ title: titulo, body: m.texto, url: 'index.html' });

      console.log('Buscando destinatarios:', nombresBuscados);
      console.log('Nombres en suscripciones existentes:', suscripciones.docs.map(s => s.data().nombre || '(sin nombre)'));

      let algunaCoincidencia = false;
      await Promise.all(suscripciones.docs.map(async (s) => {
        const datos = s.data();
        if (!datos.nombre) return;
        const nombreSuscripcion = datos.nombre.trim().toLowerCase();
        if (!nombresBuscados.includes(nombreSuscripcion)) return;
        algunaCoincidencia = true;
        try {
          await webpush.sendNotification(datos.suscripcion, payload);
          console.log('Push enviado correctamente a:', datos.nombre);
        } catch (err) {
          console.error('Fallo al enviar a', datos.nombre, '-', err.statusCode, err.message);
          if (err.statusCode === 404 || err.statusCode === 410) await s.ref.delete();
        }
      }));
      if (!algunaCoincidencia) {
        console.log('⚠️ Ningún nombre de suscripción coincidió con los destinatarios buscados.');
      }
    }

    await doc.ref.delete();
    console.log('Mensaje manual entregado a:', listaDestinatarios.join(', '));
  }
}

async function main() {
  await revisarMascota();
  await revisarContenido();
  await revisarMensajesManuales();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
