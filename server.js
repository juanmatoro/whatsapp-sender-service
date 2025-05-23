// server.js
const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion, // Importar para la versión de WA
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");

const app = express();
const port = process.env.PORT || 4003; // Puerto 4003

// Middlewares
app.use(
  cors({
    origin: "http://localhost:3000", // Tu frontend
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(bodyParser.json());

// Estado de la conexión y datos del QR
let sock;
let qrDataURL = null;
let connectionStatus = "DISCONNECTED";

const AUTH_DIR = path.join(__dirname, "baileys_auth_info");

async function connectToWhatsApp() {
  qrDataURL = null; // Limpiar QR anterior
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let waSocketOptions = {
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "debug" }),
    browser: ["BodaApp", "Chrome", "10.0.0"],
  };

  try {
    // Intentar obtener y usar la última versión de WA
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(
      `Intentando usar Baileys con WA v${version.join(
        "."
      )}, ¿es la última?: ${isLatest}`
    );
    waSocketOptions.version = version; // Añadir la versión a las opciones
  } catch (e) {
    console.error(
      "No se pudo obtener la última versión de WA, usando la predeterminada de Baileys:",
      e
    );
    // Si falla, waSocketOptions simplemente no tendrá la propiedad 'version',
    // y Baileys usará su versión embebida por defecto.
  }

  sock = makeWASocket(waSocketOptions); // Crear el socket con las opciones construidas

  connectionStatus = "CONNECTING";
  console.log("Intentando conectar a WhatsApp...");

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("QR recibido, generando Data URL...");
      try {
        qrDataURL = await qrcode.toDataURL(qr);
        connectionStatus = "NEEDS_QR";
        console.log("QR Data URL generado. El frontend debe solicitarlo.");
      } catch (e) {
        console.error("Error generando QR Data URL:", e);
        qrDataURL = null;
        connectionStatus = "ERROR";
      }
    }

    if (connection === "close") {
      qrDataURL = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(
        `Conexión cerrada. Razón: ${statusCode} - ${
          DisconnectReason[statusCode] || "Desconocida"
        }.`
      );

      if (statusCode === DisconnectReason.loggedOut) {
        connectionStatus = "LOGGED_OUT";
        console.log(
          "Usuario desconectado (loggedOut). Se requiere nuevo inicio de sesión y QR."
        );
        if (fs.existsSync(AUTH_DIR)) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR);
            console.log("Directorio de autenticación limpiado.");
          } catch (e) {
            console.error("Error eliminando directorio de autenticación:", e);
          }
        }
      } else if (statusCode === DisconnectReason.restartRequired) {
        connectionStatus = "DISCONNECTED"; // Marcar como desconectado, frontend puede reintentar
        console.log(
          "WhatsApp solicitó un reinicio de la conexión. El usuario puede reintentar desde el frontend."
        );
      } else {
        connectionStatus = "DISCONNECTED";
        console.log(
          "La conexión se cerró por otra razón. El usuario puede reintentar desde el frontend."
        );
      }
    } else if (connection === "open") {
      connectionStatus = "CONNECTED";
      qrDataURL = null;
      console.log("WhatsApp conectado!");
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// --- Endpoints de la API ---

app.post("/start-session", async (req, res) => {
  if (connectionStatus === "CONNECTED") {
    return res.json({
      message: "Ya conectado a WhatsApp.",
      estado: connectionStatus,
    });
  }
  if (connectionStatus === "CONNECTING" || connectionStatus === "NEEDS_QR") {
    return res.json({
      message: "Proceso de conexión ya en curso.",
      estado: connectionStatus,
      qr: qrDataURL,
    });
  }
  console.log("Solicitud para iniciar nueva sesión de WhatsApp...");
  try {
    await connectToWhatsApp();
    // Dar un pequeño margen para que se genere el QR si es la primera vez o se limpiaron creds
    await new Promise((resolve) => setTimeout(resolve, 2500)); // Aumentado un poco por si fetchLatest... tarda
    res.json({
      message: "Inicio de sesión de WhatsApp iniciado.",
      estado: connectionStatus,
      qr: qrDataURL,
    });
  } catch (error) {
    console.error("Error al iniciar sesión en WhatsApp:", error);
    connectionStatus = "ERROR";
    res
      .status(500)
      .json({
        error: "No se pudo iniciar la sesión de WhatsApp.",
        detalle: error.message,
        estado: connectionStatus,
      });
  }
});

app.get("/status", (req, res) => {
  res.json({ estado: connectionStatus, qr: qrDataURL });
});

app.post("/logout", async (req, res) => {
  console.log("Solicitud de cierre de sesión...");
  if (sock && typeof sock.logout === "function") {
    try {
      await sock.logout();
      console.log("Sesión de Baileys cerrada correctamente vía API.");
    } catch (error) {
      console.error("Error durante el logout de Baileys vía API:", error);
    }
  } else {
    console.log("No había una sesión activa de Baileys para cerrar.");
  }

  if (fs.existsSync(AUTH_DIR)) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      if (!fs.existsSync(AUTH_DIR)) {
        // Asegurar que se recrea si se eliminó completamente
        fs.mkdirSync(AUTH_DIR);
      }
      console.log("Directorio de autenticación limpiado tras logout.");
    } catch (e) {
      console.error(
        "Error eliminando/recreando directorio de autenticación tras logout:",
        e
      );
    }
  }
  connectionStatus = "LOGGED_OUT"; // Estado final después de un logout exitoso
  qrDataURL = null;
  res.json({
    message: "Sesión cerrada y credenciales limpiadas. Se requerirá nuevo QR.",
    estado: connectionStatus,
  });
});

app.post("/send", async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (connectionStatus !== "CONNECTED") {
    return res
      .status(400)
      .json({ error: "WhatsApp no está conectado.", estado: connectionStatus });
  }
  if (!telefono || !mensaje) {
    return res
      .status(400)
      .json({ error: "El número de teléfono y el mensaje son requeridos." });
  }
  try {
    const numeroLimpio = telefono.replace(/\D/g, "");
    if (!numeroLimpio) {
      return res.status(400).json({ error: "Número de teléfono inválido." });
    }
    const jid = `${numeroLimpio}@s.whatsapp.net`;
    console.log(`Enviando mensaje a ${jid}: "${mensaje.substring(0, 30)}..."`);
    await sock.sendMessage(jid, { text: mensaje });
    res.json({ success: true, message: "Mensaje enviado exitosamente." });
  } catch (error) {
    console.error("Error enviando mensaje:", error);
    res
      .status(500)
      .json({ error: "Fallo al enviar el mensaje.", detalle: error.message });
  }
});

app.post("/broadcast", async (req, res) => {
  const { telefonos, mensaje } = req.body;
  if (connectionStatus !== "CONNECTED") {
    return res
      .status(400)
      .json({ error: "WhatsApp no está conectado.", estado: connectionStatus });
  }
  if (
    !telefonos ||
    !Array.isArray(telefonos) ||
    telefonos.length === 0 ||
    !mensaje
  ) {
    return res
      .status(400)
      .json({ error: "Se requiere un array de teléfonos y un mensaje." });
  }
  let enviados = 0;
  let fallidos = 0;
  const resultados = [];
  console.log(
    `Iniciando broadcast de "${mensaje.substring(0, 30)}..." a ${
      telefonos.length
    } números.`
  );
  for (const telefono of telefonos) {
    try {
      const numeroLimpio = telefono.replace(/\D/g, "");
      if (!numeroLimpio) {
        console.warn(`Número inválido omitido: ${telefono}`);
        fallidos++;
        resultados.push({
          telefono,
          estado: "fallido",
          razon: "Número inválido",
        });
        continue;
      }
      const jid = `${numeroLimpio}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: mensaje });
      enviados++;
      resultados.push({ telefono, estado: "enviado" });
      console.log(`Mensaje enviado a ${jid}`);
      const delay = 1500 + Math.random() * 2000; // Delay aleatorio entre 1.5s y 3.5s
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      console.error(`Error enviando mensaje a ${telefono}:`, error.message);
      fallidos++;
      resultados.push({ telefono, estado: "fallido", razon: error.message });
    }
  }
  console.log(
    `Broadcast completado. Enviados: ${enviados}, Fallidos: ${fallidos}.`
  );
  res.json({
    success: true,
    message: `Broadcast intentado. Enviados: ${enviados}, Fallidos: ${fallidos}.`,
    resultados,
  });
});

// --- Iniciar el servidor ---
app.listen(port, () => {
  console.log(
    `Servicio de envío de WhatsApp escuchando en http://localhost:${port}`
  );
  // Se recomienda NO conectar automáticamente al iniciar.
  // Dejar que el frontend inicie la conexión con /start-session.
  // Esto da más control y evita que se conecte si no se va a usar la página de mensajes.
  // connectToWhatsApp().catch(err => {
  //     console.error("Fallo en la conexión inicial de WhatsApp al arrancar el servidor:", err.message);
  // });
});
