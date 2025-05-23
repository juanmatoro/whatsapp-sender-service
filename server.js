// server.js
const express = require("express");
const path = require("path"); // Necesario para path.join
const fs = require("fs"); // Necesario para verificar existencia de directorio (opcional, Baileys lo maneja)
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const cors = require("cors");
const bodyParser = require("body-parser");
const qrcode = require("qrcode");

const app = express();
const port = process.env.PORT || 4003;

// --- Configuración del Directorio de Autenticación (AUTH_DIR) ---
// Para Railway: Define la variable de entorno VOLUME_DIR en la configuración de tu servicio
//               con la ruta donde montaste tu volumen (ej: "/data").
// Para Local: Si VOLUME_DIR no está, usará un subdirectorio en la carpeta del proyecto.

const authDirParentPath = process.env.VOLUME_DIR || __dirname;
const AUTH_DIR = path.join(authDirParentPath, "baileys_auth_info");

console.log(
  `[Config] El directorio de autenticación (AUTH_DIR) se establecerá en: ${AUTH_DIR}`
);
if (process.env.VOLUME_DIR) {
  console.log(
    `[Config] Se utilizará el directorio de volumen para AUTH_DIR: ${process.env.VOLUME_DIR}`
  );
  // Opcional: Verificar si el directorio base del volumen existe y es escribible.
  // Normalmente, la plataforma PaaS se encarga de que el volumen montado sea accesible.
  // Baileys (useMultiFileAuthState) intentará crear AUTH_DIR.
  if (!fs.existsSync(authDirParentPath)) {
    try {
      fs.mkdirSync(authDirParentPath, { recursive: true });
      console.log(
        `[Config] Directorio base del volumen (${authDirParentPath}) creado o ya existente.`
      );
    } catch (e) {
      console.error(
        `[Error Critico] No se pudo crear el directorio base del volumen en ${authDirParentPath}. Verifica permisos y la configuración del volumen en Railway.`,
        e
      );
      // Podrías decidir salir si la persistencia es crítica y no se puede establecer.
      // process.exit(1);
    }
  }
} else {
  console.log(
    `[Config] La variable de entorno VOLUME_DIR no está establecida. Se usará el directorio local para AUTH_DIR: ${__dirname}`
  );
}
// --- Fin Configuración AUTH_DIR ---

// Middlewares
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000", // Configura tu URL de frontend permitida
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);
app.use(bodyParser.json());

let sock;
let qrDataURL = null;
let connectionStatus = "DISCONNECTED";

async function connectToWhatsApp() {
  qrDataURL = null;
  // `useMultiFileAuthState` creará AUTH_DIR si no existe y el directorio padre es escribible.
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let waSocketOptions = {
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "debug" }),
    browser: ["BodaApp", "Chrome", "10.0.0"],
  };

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(
      `[Baileys] Intentando usar Baileys con WA v${version.join(
        "."
      )}, ¿es la última?: ${isLatest}`
    );
    waSocketOptions.version = version;
  } catch (e) {
    console.warn(
      "[Baileys] No se pudo obtener la última versión de WA, usando la predeterminada de Baileys:",
      e.message
    );
  }

  sock = makeWASocket(waSocketOptions);
  connectionStatus = "CONNECTING";
  console.log("[Baileys] Intentando conectar a WhatsApp...");

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log("[Baileys] QR recibido, generando Data URL...");
      try {
        qrDataURL = await qrcode.toDataURL(qr);
        connectionStatus = "NEEDS_QR";
        console.log(
          "[Baileys] QR Data URL generado. El frontend debe solicitarlo."
        );
      } catch (e) {
        console.error("[Baileys] Error generando QR Data URL:", e);
        qrDataURL = null;
        connectionStatus = "ERROR";
      }
    }

    if (connection === "close") {
      qrDataURL = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(
        `[Baileys] Conexión cerrada. Razón: ${statusCode} - ${
          DisconnectReason[statusCode] || "Desconocida"
        }.`
      );
      if (statusCode === DisconnectReason.loggedOut) {
        connectionStatus = "LOGGED_OUT";
        console.log(
          "[Baileys] Usuario desconectado (loggedOut). Se requiere nuevo QR."
        );
        if (fs.existsSync(AUTH_DIR)) {
          try {
            console.log(
              `[Baileys] Limpiando directorio de autenticación: ${AUTH_DIR}`
            );
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            // Recrear para asegurar que el path base es válido para la próxima sesión
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch (e) {
            console.error("[Baileys] Error limpiando directorio de auth:", e);
          }
        }
      } else if (statusCode === DisconnectReason.restartRequired) {
        connectionStatus = "DISCONNECTED";
        console.log(
          "[Baileys] WhatsApp solicitó reinicio. Frontend puede reintentar."
        );
      } else {
        connectionStatus = "DISCONNECTED";
        console.log(
          "[Baileys] Conexión cerrada por otra razón. Frontend puede reintentar."
        );
      }
    } else if (connection === "open") {
      connectionStatus = "CONNECTED";
      qrDataURL = null;
      console.log("[Baileys] WhatsApp conectado!");
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
}

// --- Endpoints de la API ---
app.post("/start-session", async (req, res) => {
  if (connectionStatus === "CONNECTED")
    return res.json({ message: "Ya conectado.", estado: connectionStatus });
  if (connectionStatus === "CONNECTING" || connectionStatus === "NEEDS_QR")
    return res.json({
      message: "Conexión en curso.",
      estado: connectionStatus,
      qr: qrDataURL,
    });
  console.log("[API] Solicitud /start-session");
  try {
    await connectToWhatsApp();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    res.json({
      message: "Inicio de sesión iniciado.",
      estado: connectionStatus,
      qr: qrDataURL,
    });
  } catch (error) {
    console.error("[API] Error en /start-session:", error);
    connectionStatus = "ERROR";
    res.status(500).json({
      error: "No se pudo iniciar sesión.",
      detalle: error.message,
      estado: connectionStatus,
    });
  }
});

app.get("/status", (req, res) => {
  res.json({ estado: connectionStatus, qr: qrDataURL });
});

app.post("/logout", async (req, res) => {
  console.log("[API] Solicitud /logout");
  if (sock && typeof sock.logout === "function") {
    try {
      await sock.logout();
      console.log("[Baileys] Sesión cerrada vía API.");
    } catch (error) {
      console.error("[Baileys] Error en logout vía API:", error);
    }
  }
  if (fs.existsSync(AUTH_DIR)) {
    try {
      console.log(
        `[Baileys] Limpiando directorio de autenticación en logout: ${AUTH_DIR}`
      );
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch (e) {
      console.error("[Baileys] Error limpiando directorio auth en logout:", e);
    }
  }
  connectionStatus = "LOGGED_OUT";
  qrDataURL = null;
  res.json({
    message: "Sesión cerrada y credenciales limpiadas.",
    estado: connectionStatus,
  });
});

app.post("/send", async (req, res) => {
  const { telefono, mensaje } = req.body;
  console.log(`[API] Solicitud /send a ${telefono}`);
  if (connectionStatus !== "CONNECTED")
    return res
      .status(400)
      .json({ error: "WhatsApp no conectado.", estado: connectionStatus });
  if (!telefono || !mensaje)
    return res.status(400).json({ error: "Teléfono y mensaje requeridos." });
  try {
    const numeroLimpio = telefono.replace(/\D/g, "");
    if (!numeroLimpio)
      return res.status(400).json({ error: "Número inválido." });
    const jid = `${numeroLimpio}@s.whatsapp.net`;
    console.log(
      `[Baileys] Enviando mensaje a ${jid}: "${mensaje.substring(0, 30)}..."`
    );
    await sock.sendMessage(jid, { text: mensaje });
    res.json({ success: true, message: "Mensaje enviado." });
  } catch (error) {
    console.error("[Baileys] Error enviando mensaje:", error);
    res
      .status(500)
      .json({ error: "Fallo al enviar mensaje.", detalle: error.message });
  }
});

app.post("/broadcast", async (req, res) => {
  const { telefonos, mensaje } = req.body;
  console.log(
    `[API] Solicitud /broadcast para ${telefonos?.length || 0} números.`
  );
  if (connectionStatus !== "CONNECTED")
    return res
      .status(400)
      .json({ error: "WhatsApp no conectado.", estado: connectionStatus });
  if (
    !telefonos ||
    !Array.isArray(telefonos) ||
    telefonos.length === 0 ||
    !mensaje
  )
    return res
      .status(400)
      .json({ error: "Array de teléfonos y mensaje requeridos." });

  let enviados = 0;
  let fallidos = 0;
  const resultados = [];
  console.log(
    `[Baileys] Iniciando broadcast de "${mensaje.substring(0, 30)}..." a ${
      telefonos.length
    } números.`
  );
  for (const telefono of telefonos) {
    try {
      const numeroLimpio = telefono.replace(/\D/g, "");
      if (!numeroLimpio) {
        console.warn(
          `[Baileys] Broadcast: Número inválido omitido: ${telefono}`
        );
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
      console.log(`[Baileys] Broadcast: Mensaje enviado a ${jid}`);
      const delay = 1500 + Math.random() * 2000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      console.error(
        `[Baileys] Broadcast: Error enviando a ${telefono}:`,
        error.message
      );
      fallidos++;
      resultados.push({ telefono, estado: "fallido", razon: error.message });
    }
  }
  console.log(
    `[Baileys] Broadcast completado. Enviados: ${enviados}, Fallidos: ${fallidos}.`
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
    `Servicio WhatsApp escuchando en http://localhost:${port} (interno)`
  );
  // No conectar automáticamente al iniciar. Dejar que /start-session lo haga.
});
